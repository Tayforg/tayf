// ---------------------------------------------------------------------------
// Shared chainable Supabase fake — proxy-based, one source of truth.
//
// PostgREST builders chain freely (`from().select().eq().gte().order().limit()`
// then `await`) and the supabase-js client surfaces a *long* list of method
// names: select / insert / update / delete / upsert / eq / neq / gt / gte / lt /
// lte / in / is / not / contains / containedBy / range / order / limit / single /
// maybeSingle / then / catch / finally. Every site-local fake we have ever
// written enumerates a subset of these; the moment the SUT chains a method the
// fake didn't list, the test either throws `xxx is not a function` (loud red)
// or — worse — green-passes because the chain falls into a sibling branch.
//
// This helper replaces every site-local fake with one factory. The returned
// `from(table)` builder is a Proxy whose `get` trap:
//
//   * Returns the proxy itself for every chainable method (so any future
//     PostgREST method automatically Just Works).
//   * Records calls into per-table call logs the test can introspect
//     (`update / insert / upsert / delete` are the interesting ones).
//   * For the terminal-tracking methods (`single`, `maybeSingle`) and the
//     thenable `then` / `catch` / `finally`, resolves to a `{ data, error }`
//     pair drawn from the fixture supplied at factory time.
//   * For `update / insert / upsert / delete` it stays chainable but ALSO
//     thenable — so callers that `await supabase.from('x').update(...).eq(...)`
//     still resolve, and the test can assert on the recorded patch.
//
// Usage shape:
//
//   const { client, calls } = createSupabaseFake({
//     tables: {
//       clusters: [{ id: "c1", title_tr_neutral: null, ... }],
//       cluster_articles: [{ cluster_id: "c1", article_id: "a1" }],
//     },
//     rpc: {
//       cluster_append_member: () => ({ data: { ok: true }, error: null }),
//     },
//   });
//
//   vi.mock("@supabase/supabase-js", () => ({ createClient: () => client }));
//   // ...
//   expect(calls.update("clusters").some((c) => c.patch.title_tr_neutral !== null))
//     .toBe(true);
//
// All identifiers are intentionally framework-agnostic — no vitest types
// leak out — so the helper is reusable from any test runner.
// ---------------------------------------------------------------------------

/** PostgREST-shaped success/error envelope. */
export interface PgResult<T = unknown> {
  data: T;
  error: { message: string } | null;
  count?: number | null;
  status?: number;
  statusText?: string;
}

export type TableFixture = unknown[] | ((args: BuilderState) => PgResult);

export interface SupabaseFakeOptions {
  /**
   * Per-table fixture data. Either a fixed array of rows (returned as
   * `{ data: rows, error: null }` from the terminal await / single /
   * maybeSingle), or a function that gets the builder's accumulated state
   * (the recorded `.eq()` / `.in()` / `.is()` predicates, `.range()` /
   * `.limit()` / `.order()` args) and returns a custom `{ data, error }`.
   *
   * Tests that don't care about predicate filtering can pass an array;
   * tests that need to assert "the row matching id=c1 was returned" can
   * pass a function.
   */
  tables?: Record<string, TableFixture>;

  /**
   * Optional per-rpc fixture. Maps rpc name -> a `{ data, error }`
   * resolver. Unknown rpcs resolve to `{ data: null, error: null }`.
   */
  rpc?: Record<string, (args: unknown) => PgResult | Promise<PgResult>>;
}

export interface MutationCall {
  table: string;
  /** `update` | `insert` | `upsert` | `delete` */
  op: "update" | "insert" | "upsert" | "delete";
  /** Patch object for update/upsert/insert; null for delete. */
  patch: unknown;
  /** Accumulated chain state at the moment the mutation was issued. */
  state: BuilderState;
}

export interface RpcCall {
  name: string;
  args: unknown;
}

export interface SupabaseFakeCalls {
  /** All mutating calls in order. */
  mutations: MutationCall[];
  /** All `.rpc()` invocations in order. */
  rpc: RpcCall[];
  /** Filter helper: mutations for a specific table (and optional op). */
  forTable: (
    table: string,
    op?: MutationCall["op"],
  ) => MutationCall[];
  /** Filter helper: update calls for a table. */
  update: (table: string) => MutationCall[];
  /** Filter helper: insert calls for a table. */
  insert: (table: string) => MutationCall[];
  /** Filter helper: upsert calls for a table. */
  upsert: (table: string) => MutationCall[];
  /** Filter helper: delete calls for a table. */
  delete: (table: string) => MutationCall[];
}

export interface BuilderState {
  table: string;
  selectArgs: unknown[];
  eq: Array<{ col: string; val: unknown }>;
  neq: Array<{ col: string; val: unknown }>;
  in: Array<{ col: string; vals: unknown[] }>;
  is: Array<{ col: string; val: unknown }>;
  not: Array<{ col: string; op: string; val: unknown }>;
  gt: Array<{ col: string; val: unknown }>;
  gte: Array<{ col: string; val: unknown }>;
  lt: Array<{ col: string; val: unknown }>;
  lte: Array<{ col: string; val: unknown }>;
  contains: Array<{ col: string; val: unknown }>;
  containedBy: Array<{ col: string; val: unknown }>;
  textSearch: Array<{ col: string; query: string; opts: unknown }>;
  order: Array<{ col: string; opts: unknown }>;
  limit: number | null;
  range: { from: number; to: number } | null;
  /** The mutating op currently parked on the builder, if any. */
  mutation:
    | { op: "update" | "insert" | "upsert" | "delete"; patch: unknown }
    | null;
}

function freshState(table: string): BuilderState {
  return {
    table,
    selectArgs: [],
    eq: [],
    neq: [],
    in: [],
    is: [],
    not: [],
    gt: [],
    gte: [],
    lt: [],
    lte: [],
    contains: [],
    containedBy: [],
    textSearch: [],
    order: [],
    limit: null,
    range: null,
    mutation: null,
  };
}

/**
 * Resolve a fixture into a `{ data, error }` envelope.
 *
 * If the fixture is a function, it gets the live builder state so callers
 * can branch on predicates. If it is an array, it is returned verbatim.
 * If the fixture is missing the result is `{ data: [], error: null }` —
 * the empty-but-not-erroring case that PostgREST returns for a query that
 * matched zero rows. (Tests that need `error` set should pass a function.)
 */
function resolveFixture(
  fixtures: Record<string, TableFixture> | undefined,
  state: BuilderState,
): PgResult {
  const fixture = fixtures?.[state.table];
  if (typeof fixture === "function") {
    return fixture(state);
  }
  if (Array.isArray(fixture)) {
    return { data: fixture, error: null, count: fixture.length };
  }
  return { data: [], error: null, count: 0 };
}

/**
 * Convert an array-shaped result to a single-row result. PostgREST's
 * `.single()` returns the first row (and errors if there are 0 or >1);
 * `.maybeSingle()` returns the first row or null without erroring.
 */
function toSingle(result: PgResult, allowZero: boolean): PgResult {
  if (result.error) return result;
  const rows = Array.isArray(result.data) ? result.data : [result.data];
  if (rows.length === 0) {
    return allowZero
      ? { data: null, error: null }
      : { data: null, error: { message: "no rows" } };
  }
  return { data: rows[0], error: null };
}

/** Chainable method names that always return `this`. */
const CHAINABLE = new Set([
  "select",
  "eq",
  "neq",
  "in",
  "is",
  "not",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "containedBy",
  "textSearch",
  "match",
  "filter",
  "or",
  "order",
  "limit",
  "range",
  "abortSignal",
  "csv",
  "geojson",
  "explain",
  "rollback",
  "returns",
  "overrideTypes",
]);

const MUTATIONS = new Set(["insert", "update", "upsert", "delete"]);

/**
 * Build the chainable proxy for `client.from(table)`.
 *
 * The proxy is also a thenable: `await supabase.from(...)...` resolves to
 * the fixture envelope. Mutating ops park a mutation record on the state;
 * when the chain is awaited, the mutation is committed to the call log
 * (so tests can assert what was written and against which predicate).
 */
function makeBuilder(
  table: string,
  options: SupabaseFakeOptions,
  callLog: MutationCall[],
): unknown {
  const state = freshState(table);

  const commitMutationIfAny = () => {
    if (state.mutation) {
      callLog.push({
        table,
        op: state.mutation.op,
        patch: state.mutation.patch,
        state: { ...state, mutation: null },
      });
      state.mutation = null;
    }
  };

  const resolve = (): PgResult => {
    // Snapshot the pending mutation BEFORE committing it (commit nulls the
    // field) so the insert-with-returning branch below can read the patch.
    const pendingMutation = state.mutation;
    // Capture the table's pre-commit row count so the synthetic id is
    // unique per insert across the whole suite.
    const preCommitIdx = callLog.filter((m) => m.table === state.table).length;
    commitMutationIfAny();
    // PostgREST `insert(...).select(...)` and `upsert(...).select(...)`
    // return the newly-written row(s). If the SUT chained `.select(...)`
    // after a mutation, surface the patch (with a fabricated `id` if not
    // present) as the data row so `.single()` / `.maybeSingle()` resolve
    // to something useful instead of "no rows".
    if (
      pendingMutation &&
      (pendingMutation.op === "insert" || pendingMutation.op === "upsert") &&
      state.selectArgs.length > 0
    ) {
      const patch = pendingMutation.patch;
      const rows = Array.isArray(patch) ? patch : [patch];
      const enriched = rows.map((r, j) => {
        const row = (r ?? {}) as Record<string, unknown>;
        if (!("id" in row)) {
          return { ...row, id: `${state.table}-${preCommitIdx + j}` };
        }
        return row;
      });
      return { data: enriched, error: null, count: enriched.length };
    }
    return resolveFixture(options.tables, state);
  };

  const target = {};
  return new Proxy(target, {
    get(_t, prop: string | symbol) {
      if (typeof prop === "symbol") {
        // Symbol.toPrimitive / Symbol.iterator etc — return undefined so
        // the JS runtime falls back to its default coercion (avoids
        // proxies pretending to be iterable).
        return undefined;
      }

      // Predicate / chainable methods: record args on state and return
      // the same proxy so chaining continues.
      if (CHAINABLE.has(prop)) {
        return (...args: unknown[]) => {
          switch (prop) {
            case "select":
              state.selectArgs = args;
              break;
            case "eq":
              state.eq.push({ col: String(args[0]), val: args[1] });
              break;
            case "neq":
              state.neq.push({ col: String(args[0]), val: args[1] });
              break;
            case "in":
              state.in.push({
                col: String(args[0]),
                vals: (args[1] as unknown[]) ?? [],
              });
              break;
            case "is":
              state.is.push({ col: String(args[0]), val: args[1] });
              break;
            case "not":
              state.not.push({
                col: String(args[0]),
                op: String(args[1]),
                val: args[2],
              });
              break;
            case "gt":
              state.gt.push({ col: String(args[0]), val: args[1] });
              break;
            case "gte":
              state.gte.push({ col: String(args[0]), val: args[1] });
              break;
            case "lt":
              state.lt.push({ col: String(args[0]), val: args[1] });
              break;
            case "lte":
              state.lte.push({ col: String(args[0]), val: args[1] });
              break;
            case "contains":
              state.contains.push({ col: String(args[0]), val: args[1] });
              break;
            case "containedBy":
              state.containedBy.push({ col: String(args[0]), val: args[1] });
              break;
            case "textSearch":
              state.textSearch.push({
                col: String(args[0]),
                query: String(args[1]),
                opts: args[2],
              });
              break;
            case "order":
              state.order.push({ col: String(args[0]), opts: args[1] });
              break;
            case "limit":
              state.limit = Number(args[0]);
              break;
            case "range":
              state.range = { from: Number(args[0]), to: Number(args[1]) };
              break;
            default:
              // Catch-all for `match / filter / or / abortSignal / ...`:
              // we don't record them but we MUST return the proxy so the
              // chain continues. Future query shapes Just Work.
              break;
          }
          // Returning the proxy itself is the whole point.
          return new Proxy(target, this!);
        };
      }

      // Mutating ops: park the mutation, stay chainable so callers can
      // tack a `.eq()` / `.match()` on after.
      if (MUTATIONS.has(prop)) {
        return (patch?: unknown) => {
          state.mutation = {
            op: prop as MutationCall["op"],
            patch: prop === "delete" ? null : patch,
          };
          return new Proxy(target, this!);
        };
      }

      // Terminal-but-still-thenable single-row reads.
      if (prop === "single" || prop === "maybeSingle") {
        return async () => toSingle(resolve(), prop === "maybeSingle");
      }

      // Thenable surface — this is what makes `await supabase.from(...)`
      // resolve. We also expose `catch` / `finally` so the awaited chain
      // behaves like a real Promise.
      if (prop === "then") {
        return (
          onFul?: (v: PgResult) => unknown,
          onRej?: (e: unknown) => unknown,
        ) => Promise.resolve(resolve()).then(onFul, onRej);
      }
      if (prop === "catch") {
        return (onRej?: (e: unknown) => unknown) =>
          Promise.resolve(resolve()).catch(onRej);
      }
      if (prop === "finally") {
        return (onFinally?: () => void) =>
          Promise.resolve(resolve()).finally(onFinally);
      }

      // Anything else: return a chainable no-op so unforeseen methods
      // don't blow up. This is the footgun-prevention escape hatch — if
      // the SUT calls `.something_we_didnt_anticipate()`, the chain
      // continues instead of throwing `is not a function`.
      return (..._args: unknown[]) => new Proxy(target, this!);
    },
  });
}

/**
 * Build the Supabase client fake.
 *
 * The returned object exposes the subset of the supabase-js client API
 * the worker-stream code reaches for: `from(table)` (chainable builder),
 * `rpc(name, args)` (returns the configured rpc fixture, or a no-op
 * `{data: null, error: null}` envelope), and `auth` (a thin stub that
 * yields `null` for everything — the routes that need an auth client
 * use the dedicated `createServerClient` path, not this fake).
 */
export function createSupabaseFake(options: SupabaseFakeOptions = {}): {
  client: {
    from: (table: string) => unknown;
    rpc: (name: string, args?: unknown) => Promise<PgResult>;
    auth: {
      getUser: () => Promise<{
        data: { user: null };
        error: null;
      }>;
    };
  };
  calls: SupabaseFakeCalls;
} {
  const mutations: MutationCall[] = [];
  const rpcCalls: RpcCall[] = [];

  const calls: SupabaseFakeCalls = {
    mutations,
    rpc: rpcCalls,
    forTable: (table, op) =>
      mutations.filter((m) => m.table === table && (op ? m.op === op : true)),
    update: (table) =>
      mutations.filter((m) => m.table === table && m.op === "update"),
    insert: (table) =>
      mutations.filter((m) => m.table === table && m.op === "insert"),
    upsert: (table) =>
      mutations.filter((m) => m.table === table && m.op === "upsert"),
    delete: (table) =>
      mutations.filter((m) => m.table === table && m.op === "delete"),
  };

  const client = {
    from: (table: string) => makeBuilder(table, options, mutations),
    rpc: async (name: string, args?: unknown): Promise<PgResult> => {
      rpcCalls.push({ name, args });
      const fn = options.rpc?.[name];
      if (fn) {
        return await fn(args);
      }
      return { data: null, error: null };
    },
    auth: {
      getUser: async () => ({ data: { user: null }, error: null }),
    },
  };

  return { client, calls };
}
