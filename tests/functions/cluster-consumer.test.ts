import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Static import of the mocked `score` export (see the vi.mock factory
// below) so the A3 live-path tests can override its return value per test
// via `vi.mocked(scoreMock).mockImplementation(...)` -- band-low/band-high
// classification depends on the ensemble score, and the real ensemble
// scorer is not exercised at all under this file's mocks.
import {
  headlineLane,
  headlineOnlyScore as headlineOnlyScoreMock,
  score as scoreMock,
} from "../../supabase/functions/_shared/cluster/ensemble.ts";
import {
  HEADLINE_CENTROID_FLOOR,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_MEMBER_SCAN_MAX,
  HEADLINE_TITLE_MAX_CHARS,
} from "../../supabase/functions/_shared/cluster/constants.ts";
import {
  headlineTokens,
  normalizeTurkish,
  strictFingerprint,
} from "../../supabase/functions/_shared/cluster/fingerprint.ts";
import { cleanDescription } from "../../supabase/functions/_shared/cluster/description-clean.ts";
import { extractEntities } from "../../supabase/functions/_shared/cluster/entities.ts";
import { actorMismatchFires, incidentVetoFires, subjectVetoFires } from "../../supabase/functions/_shared/cluster/ensemble.ts";

// h45-clusters-1: SAME_SOURCE_UPDATE_ENFORCE is a code constant (a PR turns it on,
// no dashboard switch), so the tests flip it through a mock of the constants module.
// Everything else in that module stays real. A test sets `updateFlag.override` to
// true / false before its drain; `beforeEach` resets it to null, which means "the
// shipped value", so every other test of this file runs the shipped configuration.
// The getter is read at the call site, no module reset needed.
const updateFlag = vi.hoisted(() => ({ override: null as boolean | null, shipped: false }));
vi.mock("../../supabase/functions/_shared/cluster/constants.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../supabase/functions/_shared/cluster/constants.ts")>();
  updateFlag.shipped = actual.SAME_SOURCE_UPDATE_ENFORCE;
  return {
    ...actual,
    get SAME_SOURCE_UPDATE_ENFORCE(): boolean {
      return updateFlag.override ?? updateFlag.shipped;
    },
  };
});

// ---------------------------------------------------------------------------
// Contract tests for the cluster-consumer Edge Function.
//
// This file does NOT execute Deno-native code. The cluster-consumer module
// is authored against Deno (Deno.serve, node: specifiers, etc.); vitest runs
// in Node. We therefore test the *contract* of the handler by:
//
//   1. Polyfilling the minimum Deno surface the function reaches for
//      (`Deno.env.get`, `Deno.serve`) before importing the module.
//   2. Mocking the function's collaborators (`pgmq.read`, `pgmq.archive`,
//      `pgmq.delete`, Supabase client) at the import boundary so the unit
//      under test exercises real control flow without any I/O.
//   3. Asserting observable post-conditions: dequeued message count,
//      archive-on-success / archive-on-permanent-failure (poison messages
//      are archived, never deleted, so the payload survives in
//      pgmq.a_cluster_work), idempotent re-runs, and the 30 s
//      per-invocation cap.
//
// The sister builder (B3) owns the module under test. If B3 changes the
// import path or the named exports, the `vi.mock` targets here need to be
// updated to match — that's the contract handshake. The orchestrator's
// Phase 3 QA agents will fix these together if the wiring drifts.
// ---------------------------------------------------------------------------

// Polyfill the Deno globals the handler reaches for. Done in module scope
// (before any import of the SUT) so the side-effecting top-level code in the
// handler doesn't blow up on `Deno is not defined`.
(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: {
    get: (k: string) => process.env[k],
  },
  // Capture the handler the SUT registers; tests will invoke it directly.
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __registeredHandler?: unknown }).__registeredHandler = handler;
    return { finished: Promise.resolve() };
  },
};

// The service-role bearer the handler's `requireServiceRoleBearer` gate
// expects. `beforeEach` mirrors this into `SUPABASE_SERVICE_ROLE_KEY`, which
// the Deno-env polyfill above reads via `process.env`. Every authorised
// `new Request(...)` carries `Authorization: Bearer ${TEST_SERVICE_ROLE_KEY}`
// through `authedRequest(...)`.
const TEST_SERVICE_ROLE_KEY = "test-service-role-key";

function authedRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`,
    },
  });
}

interface PgmqMessage {
  msg_id: number;
  read_ct: number;
  message: { article_id: string };
}

interface AttachPgmqMessage {
  msg_id: number;
  read_ct: number;
  message: { article_id?: unknown; admit?: unknown };
}

const pgmqState: {
  pending: PgmqMessage[];
  archived: number[];
  deleted: number[];
  // hunt-25 W3: the cluster_attach queue (migration 151). The mock is queue-aware:
  // reads of 'cluster_attach' draw from attachPending, everything else from
  // pending, exactly as before. `reads` records every readBatch (queue + qty),
  // `attachArchived` / `attachDeleted` the acknowledgements of that queue only.
  attachPending: AttachPgmqMessage[];
  attachArchived: number[];
  attachDeleted: number[];
  reads: Array<{ queue: string; qty: number }>;
  attachReadError: string | null;
  attachDeleteError: string | null;
  // Called after each cluster_work read, so a test can move the clock mid-drain.
  afterWorkRead: (() => void) | null;
  // h101-e2elatency-1 (migration 188): the long-poll twin of readBatch. `polls`
  // keeps every readBatchPoll call with its arguments; `plainReads` every readBatch
  // call (`reads` holds both kinds, in call order). `pollScript` answers the next
  // polls in order ({ msgs } is the batch, { error } makes the call throw,
  // { advanceMs } moves the fake clock first, as a poll that waited would); once it
  // is empty a poll behaves exactly like readBatch, so every test of this file gives
  // the same result in an ingest minute (minute % 3 === 0) and in any other minute.
  polls: Array<{ queue: string; vt: number; qty: number; maxPollSeconds: number; pollIntervalMs: number }>;
  plainReads: Array<{ queue: string; qty: number }>;
  pollScript: Array<{ msgs?: PgmqMessage[]; error?: Error; advanceMs?: number }>;
  // h102-pollregression-1: every pgmq call of a drain in call order, one string each
  // ("queueDepth(q)", "readBatch(q,vt=60,qty=2)", "readBatchPoll(q,...)", "archive(q,id)",
  // "deleteMessage(q,id)", "send(q)"). The poll is switched off, so a drain has to
  // produce the sequence the pre-#252 consumer produced: the tests compare it literally.
  calls: string[];
  // Makes the next cluster_work readBatch throw this message (the attach queue has its own).
  workReadError: string | null;
} = {
  pending: [],
  archived: [],
  deleted: [],
  attachPending: [],
  attachArchived: [],
  attachDeleted: [],
  reads: [],
  attachReadError: null,
  attachDeleteError: null,
  afterWorkRead: null,
  polls: [],
  plainReads: [],
  pollScript: [],
  calls: [],
  workReadError: null,
};

function resetPgmqState() {
  pgmqState.pending = [];
  pgmqState.archived = [];
  pgmqState.deleted = [];
  pgmqState.attachPending = [];
  pgmqState.attachArchived = [];
  pgmqState.attachDeleted = [];
  pgmqState.reads = [];
  pgmqState.attachReadError = null;
  pgmqState.attachDeleteError = null;
  pgmqState.afterWorkRead = null;
  pgmqState.polls = [];
  pgmqState.plainReads = [];
  pgmqState.pollScript = [];
  pgmqState.calls = [];
  pgmqState.workReadError = null;
}

// Mock the shared pgmq wrapper. The exported names here MUST match the
// real module's named exports (`readBatch`, `readBatchPoll`, `isPollRpcMissing`,
// `archive`, `deleteMessage`, `send`, `queueDepth`) — otherwise vitest hoists a vi.mock with stale
// identifiers and the SUT silently sees `undefined` for its imported
// helpers.
//
// The real signatures all take the Supabase client as the FIRST positional
// arg (e.g. `readBatch(client, queue, vt, qty)`); the mock signatures
// mirror that so caller-side drift surfaces as a clear arity mismatch
// instead of being absorbed by JS's lenient positional binding.
vi.mock("../../supabase/functions/_shared/pgmq.ts", async (importOriginal) => ({
  // The pure error classifier is the real one; everything that touches the queue is faked.
  isPollRpcMissing: (await importOriginal<typeof import("../../supabase/functions/_shared/pgmq.ts")>()).isPollRpcMissing,
  readBatch: vi.fn(
    async (_client: unknown, queue: string, vt: number, qty: number) => {
      pgmqState.calls.push(`readBatch(${queue},vt=${vt},qty=${qty})`);
      pgmqState.reads.push({ queue, qty });
      pgmqState.plainReads.push({ queue, qty });
      if (queue !== "cluster_attach" && pgmqState.workReadError) throw new Error(pgmqState.workReadError);
      if (queue === "cluster_attach") {
        if (pgmqState.attachReadError) throw new Error(pgmqState.attachReadError);
        const attachBatch = pgmqState.attachPending.slice(0, qty);
        pgmqState.attachPending = pgmqState.attachPending.slice(qty);
        return attachBatch;
      }
      const batch = pgmqState.pending.slice(0, qty);
      pgmqState.pending = pgmqState.pending.slice(qty);
      pgmqState.afterWorkRead?.();
      return batch;
    },
  ),
  readBatchPoll: vi.fn(
    async (
      _client: unknown,
      queue: string,
      vt: number,
      qty: number,
      maxPollSeconds: number,
      pollIntervalMs: number,
    ) => {
      pgmqState.calls.push(`readBatchPoll(${queue},vt=${vt},qty=${qty},wait=${maxPollSeconds}s,step=${pollIntervalMs}ms)`);
      pgmqState.polls.push({ queue, vt, qty, maxPollSeconds, pollIntervalMs });
      pgmqState.reads.push({ queue, qty });
      const step = pgmqState.pollScript.shift();
      if (step) {
        if (step.advanceMs) vi.setSystemTime(new Date(Date.now() + step.advanceMs));
        if (step.error) throw step.error;
        return step.msgs ?? [];
      }
      const batch = pgmqState.pending.slice(0, qty);
      pgmqState.pending = pgmqState.pending.slice(qty);
      pgmqState.afterWorkRead?.();
      return batch;
    },
  ),
  archive: vi.fn(
    async (_client: unknown, queue: string, msgId: number) => {
      pgmqState.calls.push(`archive(${queue},${msgId})`);
      if (queue === "cluster_attach") pgmqState.attachArchived.push(msgId);
      else pgmqState.archived.push(msgId);
      return true;
    },
  ),
  deleteMessage: vi.fn(
    async (_client: unknown, queue: string, msgId: number) => {
      pgmqState.calls.push(`deleteMessage(${queue},${msgId})`);
      if (queue === "cluster_attach") {
        if (pgmqState.attachDeleteError) throw new Error(pgmqState.attachDeleteError);
        pgmqState.attachDeleted.push(msgId);
      } else {
        pgmqState.deleted.push(msgId);
      }
      return true;
    },
  ),
  send: vi.fn(
    async (_client: unknown, queue: string, _payload: unknown) => {
      pgmqState.calls.push(`send(${queue})`);
      return 1;
    },
  ),
  queueDepth: vi.fn(
    async (_client: unknown, queue: string) => {
      pgmqState.calls.push(`queueDepth(${queue})`);
      return {
        depth: pgmqState.pending.length,
        oldest_msg_age_sec: null,
      };
    },
  ),
}));

// Mock the Supabase factory the consumer uses to read articles + upsert
// clusters. The shared proxy-based fake (see `tests/_helpers/supabase-fake.ts`)
// auto-handles every PostgREST chain method — `.gte()`, `.range()`,
// `.update().eq()`, `.is()`, etc. — so the SUT can chain freely without the
// test enumerating each method. The fixtures below resolve per-table:
//   * `articles` -> the first pending fake article (the consumer fetches the
//     candidate by id; this mirrors the single-row read path).
//   * `clusters` -> empty page so the loadClusterContext gte/range query
//     returns an empty candidate set and the SUT falls through to the
//     no-match branch (creating a new cluster).
//   * `cluster_articles` -> tracked via the mutation log; the happy-path
//     tripwire asserts at least one insert landed.
//
// The `vi.hoisted` block lifts the fixtures and the shared fake to the same
// pre-import phase the `vi.mock` factory runs in. Without it the mock factory
// would reference an uninitialised `supabaseFakeClient` because vitest hoists
// `vi.mock` above the regular `import` statement that pulls in the helper.
const {
  fakeArticles,
  clusterRows,
  clusterArticleRows,
  stickyClusterRows,
  clusterQueries,
  stickyQuery,
  admissionRows,
  rpcFixtures,
  clusterArticlesFailure,
  clusterArticleEqReads,
  skipLogFake,
  twinBridgeFake,
  attachShadowFake,
  leaseFake,
  fromTables,
  supabaseFakeClient,
  supabaseFakeCalls,
} = await vi.hoisted(
  async () => {
    // Dynamic `await import` works here because vitest 1.x+ supports async
    // `vi.hoisted` factories. `require()` doesn't resolve `.ts` under
    // vitest's ESM loader; `import()` does.
    const helper = await import("../_helpers/supabase-fake");
    const articles: Record<string, unknown> = {};
    // `clusters` / `cluster_articles` default to `[]` for every EXISTING
    // test in this file (nothing pushes into these two arrays until the
    // A3 live-path describe block below), so this is behaviourally
    // identical to the old static `[]` fixtures for the whole suite except
    // that block. `.eq("id"/"cluster_id", ...)` / `.in("cluster_id", ...)`
    // narrow the result the same way the `articles` fixture above already
    // does; an unfiltered select (loadClusterContext's `.gte().order()`)
    // returns the full current array.
    const clusters: Array<Record<string, unknown>> = [];
    const clusterArticles: Array<{ cluster_id: string; article_id: string }> = [];
    // 2026-11-01 sticky context: loadClusterContext's second `clusters` query
    // (the one bounded by `.lt("updated_at", ...)`) is answered from
    // `stickyClusterRows`, or fails when `stickyQuery.error` is set. Every
    // unfiltered `clusters` list query is recorded in `clusterQueries`.
    const stickyClusters: Array<Record<string, unknown>> = [];
    const clusterQueryLog: Array<Record<string, unknown>> = [];
    const stickyQueryState: { error: { message: string } | null } = { error: null };
    const rpcFixturesState: {
      cluster_link_atomic: { data: unknown; error: { message: string } | null } | null;
      jev_politics_admission_claim:
        | { data: unknown; error: { message: string; code?: string } | null }
        | null;
      jev_politics_admission_record:
        | { data: unknown; error: { message: string; code?: string } | null }
        | null;
      // h12-cluster-1: the exact-title probe. A function so a test can also
      // make the call throw; null = no cluster has that title (empty rows).
      cluster_title_probe:
        | (() => { data: unknown; error: { message: string } | null })
        | null;
      // h19-recall-2: the stem-overlap probe (migration 146). Same shape as
      // cluster_title_probe: a function so a test can make the call throw.
      cluster_stem_probe:
        | (() => { data: unknown; error: { message: string } | null })
        | null;
    } = {
      cluster_link_atomic: null,
      jev_politics_admission_claim: null,
      jev_politics_admission_record: null,
      cluster_title_probe: null,
      cluster_stem_probe: null,
    };
    // h12-cluster-1: makes the per-cluster member read (the probe's
    // loadProbeCluster) fail for one cluster id.
    const clusterArticlesFailureState: { clusterId: string | null } = { clusterId: null };
    const admissionRows: Array<Record<string, unknown>> = [];
    // h14-cluster-1: the cluster_skip_log audit table. Its writes land in the
    // fake's mutation log like every other table; `mode` makes the write fail
    // with an error envelope or a throw, and `upsertOptions` keeps the second
    // argument of each upsert (the shared fake only records the patch).
    const skipLogFakeState: {
      mode: "ok" | "error" | "throw";
      upsertOptions: unknown[];
    } = { mode: "ok", upsertOptions: [] };
    // h19-recall-3: the cluster_twin_bridges evidence table (migration 147),
    // same recording as the skip log: writes land in the mutation log, `mode`
    // makes the write fail with an error envelope or a throw, `upsertOptions`
    // keeps the second argument of each upsert.
    const twinBridgeFakeState: {
      mode: "ok" | "error" | "throw";
      upsertOptions: unknown[];
    } = { mode: "ok", upsertOptions: [] };
    // hunt-25 W3: the cluster_attach_shadow record table (migration 151), same
    // recording as the skip log and the twin bridges.
    const attachShadowFakeState: {
      mode: "ok" | "error" | "throw";
      upsertOptions: unknown[];
    } = { mode: "ok", upsertOptions: [] };
    // h19-recall-2: every `cluster_articles ... .eq("cluster_id", X)` member
    // read, in order. loadProbeCluster is the only reader of that shape before a
    // join (the context loader uses .in()), so a cluster that was not reloaded
    // leaves no entry here.
    const clusterArticleEqReadsState: string[] = [];
    // h106-attachdesign-1 (migration 190): the consumer lease. An in-memory twin of the SQL of
    // consumer_lease_acquire / consumer_lease_release, on the clock the tests move (Date.now): a row is taken
    // over only once expired or by the same holder, a renewal is an acquire by the holder, a release deletes
    // only for the holder. `error` makes every lease RPC answer that error; `acquireScript` answers the next
    // acquires in order before the table logic (true, false, or {error}), so a test can lose the lease at a
    // chosen turn. Every call is recorded with `at`, the number of pgmq calls made before it, and `t`, the
    // clock, so a test can prove where in a drain's call sequence the lease sat and how long a wait took.
    // Untouched, the lease is free and every drain of this file takes and gives it back unseen.
    interface LeaseCall {
      fn: "acquire" | "release";
      name: string;
      holder: string;
      ttl: number | null;
      result: boolean | string;
      at: number;
      t: number;
    }
    const leaseFakeState: {
      row: { holder: string; expiresAt: number } | null;
      error: { code?: string; message: string } | null;
      acquireScript: Array<boolean | { error: { code?: string; message: string } }>;
      calls: LeaseCall[];
    } = { row: null, error: null, acquireScript: [], calls: [] };
    // `pgmqState` is declared above in the file and read only when an RPC runs, long after it exists.
    const pgmqCallsSoFar = (): number => pgmqState.calls.length;
    const leaseRpcs = {
      consumer_lease_acquire: (args: unknown) => {
        const a = args as { p_name: string; p_holder: string; p_ttl_seconds: number | null };
        const rec = { fn: "acquire" as const, name: a.p_name, holder: a.p_holder, ttl: a.p_ttl_seconds ?? null, at: pgmqCallsSoFar(), t: Date.now() };
        if (leaseFakeState.error) {
          leaseFakeState.calls.push({ ...rec, result: leaseFakeState.error.code ?? leaseFakeState.error.message });
          return { data: null, error: leaseFakeState.error };
        }
        const scripted = leaseFakeState.acquireScript.shift();
        if (scripted !== undefined && typeof scripted === "object") {
          leaseFakeState.calls.push({ ...rec, result: scripted.error.code ?? scripted.error.message });
          return { data: null, error: scripted.error };
        }
        let got: boolean;
        if (scripted !== undefined) {
          got = scripted;
        } else {
          const now = Date.now();
          const row = leaseFakeState.row;
          got = row === null || row.expiresAt <= now || row.holder === a.p_holder;
          if (got) {
            const ttl = Math.min(Math.max(a.p_ttl_seconds ?? 5, 5), 120);
            leaseFakeState.row = { holder: a.p_holder, expiresAt: now + ttl * 1000 };
          }
        }
        leaseFakeState.calls.push({ ...rec, result: got });
        return { data: got, error: null };
      },
      consumer_lease_release: (args: unknown) => {
        const a = args as { p_name: string; p_holder: string };
        const rec = { fn: "release" as const, name: a.p_name, holder: a.p_holder, ttl: null, at: pgmqCallsSoFar(), t: Date.now() };
        if (leaseFakeState.error) {
          leaseFakeState.calls.push({ ...rec, result: leaseFakeState.error.code ?? leaseFakeState.error.message });
          return { data: null, error: leaseFakeState.error };
        }
        const mine = leaseFakeState.row?.holder === a.p_holder;
        if (mine) leaseFakeState.row = null;
        leaseFakeState.calls.push({ ...rec, result: mine });
        return { data: mine, error: null };
      },
    };
    // Every table the SUT reads or writes, in call order (the shared fake logs only mutations and rpcs): lets a test
    // see whether a cache was rebuilt (the `sources` lookup, the `clusters` context).
    const fromTablesLog: string[] = [];
    const fake = helper.createSupabaseFake({
      tables: {
        articles: (state) => {
          // Single-row reads in cluster-consumer resolve via `.maybeSingle()`
          // / `.single()`. The fixture returns the row matching `.eq("id",
          // ...)`, the batched in-list when `.in("id", [...])` is used, or
          // the full fixture set for unfiltered selects.
          const eqId = state.eq.find((p) => p.col === "id")?.val as
            | string
            | undefined;
          if (eqId !== undefined) {
            const row = articles[eqId] ?? null;
            return { data: row, error: null, count: row ? 1 : 0 };
          }
          const inIds = state.in.find((p) => p.col === "id")?.vals as
            | string[]
            | undefined;
          if (inIds && inIds.length > 0) {
            const rows = inIds
              .map((id) => articles[id])
              .filter((r): r is unknown => r !== undefined);
            return { data: rows, error: null, count: rows.length };
          }
          return {
            data: Object.values(articles),
            error: null,
            count: Object.keys(articles).length,
          };
        },
        clusters: (state) => {
          const eqId = state.eq.find((p) => p.col === "id")?.val as string | undefined;
          if (eqId !== undefined) {
            const row = clusters.find((c) => c.id === eqId) ?? null;
            return { data: row, error: null, count: row ? 1 : 0 };
          }
          clusterQueryLog.push(state as unknown as Record<string, unknown>);
          if (state.lt.some((p) => p.col === "updated_at")) {
            if (stickyQueryState.error) {
              return { data: null, error: stickyQueryState.error };
            }
            return { data: stickyClusters, error: null, count: stickyClusters.length };
          }
          return { data: clusters, error: null, count: clusters.length };
        },
        cluster_articles: (state) => {
          const eqClusterId = state.eq.find((p) => p.col === "cluster_id")?.val as
            | string
            | undefined;
          if (eqClusterId !== undefined) {
            clusterArticleEqReadsState.push(eqClusterId);
            if (clusterArticlesFailureState.clusterId === eqClusterId) {
              return { data: null, error: { message: "cluster_articles read failed" } };
            }
            const rows = clusterArticles.filter((r) => r.cluster_id === eqClusterId);
            return { data: rows, error: null, count: rows.length };
          }
          const inClusterIds = state.in.find((p) => p.col === "cluster_id")?.vals as
            | string[]
            | undefined;
          if (inClusterIds) {
            const rows = clusterArticles.filter((r) => inClusterIds.includes(r.cluster_id));
            return { data: rows, error: null, count: rows.length };
          }
          return { data: clusterArticles, error: null, count: clusterArticles.length };
        },
        sources: [
          { id: "src-outlet", bias: "pro_government", name: "Outlet", slug: "outlet", kind: "outlet" },
          { id: "src-agg", bias: "center", name: "Aggregator", slug: "agg", kind: "aggregator" },
          { id: "src-wire", bias: "state_media", name: "Wire", slug: "wire", kind: "wire" },
          { id: "src-posta", bias: "pro_government", name: "Posta", slug: "posta", kind: "outlet" },
          { id: "src-cnn-turk", bias: "center", name: "CNN Turk", slug: "cnn-turk", kind: "outlet" },
        ],
        cluster_skip_log: () => {
          if (skipLogFakeState.mode === "throw") throw new Error("skip log unreachable");
          if (skipLogFakeState.mode === "error") {
            return { data: null, error: { message: "skip log down" } };
          }
          return { data: [], error: null };
        },
        cluster_attach_shadow: () => {
          if (attachShadowFakeState.mode === "throw") throw new Error("attach shadow unreachable");
          if (attachShadowFakeState.mode === "error") {
            return { data: null, error: { message: "attach shadow down" } };
          }
          return { data: [], error: null };
        },
        cluster_twin_bridges: () => {
          if (twinBridgeFakeState.mode === "throw") throw new Error("twin bridges unreachable");
          if (twinBridgeFakeState.mode === "error") {
            return { data: null, error: { message: "twin bridges down" } };
          }
          return { data: [], error: null };
        },
        jev_politics_admissions: (state) => {
          const eqCluster = state.eq.find((p) => p.col === "cluster_id")?.val as
            | string
            | undefined;
          if (eqCluster !== undefined) {
            const rows = admissionRows.filter((r) => r.cluster_id === eqCluster);
            return { data: rows, error: null, count: rows.length };
          }
          return { data: admissionRows, error: null, count: admissionRows.length };
        },
      },
      rpc: {
        // Default (null override) mirrors the pre-A3 behaviour: unknown
        // rpcs already resolve `{ data: null, error: null }` in the shared
        // fake, so addArticleToCluster's `cluster_link_atomic` call always
        // succeeded silently before this fixture existed too.
        cluster_link_atomic: () =>
          rpcFixturesState.cluster_link_atomic ?? { data: { ok: true }, error: null },
        // Migration 089 ("ADMIT"). Default: nothing claimed (empty queue of
        // candidates) -- tests that need a real claim override this.
        jev_politics_admission_claim: () =>
          rpcFixturesState.jev_politics_admission_claim ??
          ({ data: [{ claimed: 0, enqueued: 0, live: 0 }], error: null } as {
            data: unknown;
            error: null;
          }),
        jev_politics_admission_record: () =>
          rpcFixturesState.jev_politics_admission_record ?? { data: true, error: null },
        // h12-cluster-1: default = no live cluster carries the article's title.
        cluster_title_probe: () =>
          rpcFixturesState.cluster_title_probe
            ? rpcFixturesState.cluster_title_probe()
            : { data: [], error: null },
        // h19-recall-2: default = no live cluster shares enough stems.
        cluster_stem_probe: () =>
          rpcFixturesState.cluster_stem_probe
            ? rpcFixturesState.cluster_stem_probe()
            : { data: [], error: null },
        // h106-attachdesign-1 (migration 190): the consumer lease.
        ...leaseRpcs,
      },
    });
    return {
      fakeArticles: articles,
      clusterRows: clusters,
      clusterArticleRows: clusterArticles,
      stickyClusterRows: stickyClusters,
      clusterQueries: clusterQueryLog,
      stickyQuery: stickyQueryState,
      admissionRows,
      rpcFixtures: rpcFixturesState,
      clusterArticlesFailure: clusterArticlesFailureState,
      clusterArticleEqReads: clusterArticleEqReadsState,
      skipLogFake: skipLogFakeState,
      twinBridgeFake: twinBridgeFakeState,
      attachShadowFake: attachShadowFakeState,
      leaseFake: leaseFakeState,
      fromTables: fromTablesLog,
      supabaseFakeClient: {
        ...fake.client,
        from: (table: string) => {
          fromTablesLog.push(table);
          const builder = fake.client.from(table) as Record<string, unknown>;
          // The shared fake records only the patch of an upsert; these two audit
          // tables also keep its options (onConflict / ignoreDuplicates).
          const optionsLog =
            table === "cluster_skip_log"
              ? skipLogFakeState.upsertOptions
              : table === "cluster_twin_bridges"
                ? twinBridgeFakeState.upsertOptions
                : table === "cluster_attach_shadow"
                  ? attachShadowFakeState.upsertOptions
                  : null;
          if (optionsLog === null) return builder;
          return new Proxy(builder, {
            get(target, prop, receiver) {
              if (prop === "upsert") {
                return (patch: unknown, options?: unknown) => {
                  optionsLog.push(options);
                  return (target.upsert as (p: unknown) => unknown)(patch);
                };
              }
              return Reflect.get(target, prop, receiver);
            },
          });
        },
      },
      supabaseFakeCalls: fake.calls,
    };
  },
);

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => supabaseFakeClient,
}));

// Stub the ensemble -- the consumer just needs a scoring result back. The
// real module exports `score`; we mirror that name so the SUT's named
// import resolves to this stub. Everything else stays real: the member-
// headline scan (wave AB follow-up) calls the pure `headlineOnlyScore`, which
// must run against real headline tokens or the V2 tests below would prove
// nothing.
vi.mock("../../supabase/functions/_shared/cluster/ensemble.ts", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../supabase/functions/_shared/cluster/ensemble.ts")
  >();
  return {
    ...actual,
    // Pass-through spy (h40-clusters-1): the real headline lane still decides,
    // the tests only count how many member headlines the scan evaluates.
    headlineOnlyScore: vi.fn(actual.headlineOnlyScore),
    score: vi.fn((_a: unknown, _b: unknown) => ({
      score: 0.82,
      components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
      isMatch: true,
    })),
    isMatch: (s: number | { score: number } | null | undefined): boolean => {
      if (s == null) return false;
      return typeof s === "number" ? s >= 0.5 : s.score >= 0.5;
    },
  };
});

beforeEach(() => {
  // Order independence (vitest --sequence.shuffle): the SUT keeps module-level
  // state (clusterContextCache, sourceLookupCache, the Jev live counters,
  // drainInFlight) that survives between tests, and a few tests grow the
  // hoisted cluster fixtures. Each test therefore gets a freshly evaluated
  // SUT (importHandler() below re-imports it after this reset) and an empty
  // cluster fixture; the live-path describe re-seeds its own shared cluster in
  // its beforeEach. Without this, a test saw whatever cache or cluster rows
  // the previous test in the random order had left behind.
  vi.resetModules();
  clusterRows.length = 0;
  clusterArticleRows.length = 0;
  stickyClusterRows.length = 0;
  clusterQueries.length = 0;
  stickyQuery.error = null;
  resetPgmqState();
  // h45-clusters-1: back to the shipped SAME_SOURCE_UPDATE_ENFORCE.
  updateFlag.override = null;
  for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
  // Reset the shared Supabase fake's mutation + rpc log so each test
  // observes only its own writes.
  supabaseFakeCalls.mutations.length = 0;
  supabaseFakeCalls.rpc.length = 0;
  // Only the A3 live-path describe block below ever sets this override;
  // reset it every test so a DB-error scenario there never bleeds into an
  // unrelated test.
  rpcFixtures.cluster_link_atomic = null;
  rpcFixtures.jev_politics_admission_claim = null;
  rpcFixtures.jev_politics_admission_record = null;
  rpcFixtures.cluster_title_probe = null;
  rpcFixtures.cluster_stem_probe = null;
  clusterArticlesFailure.clusterId = null;
  clusterArticleEqReads.length = 0;
  skipLogFake.mode = "ok";
  skipLogFake.upsertOptions.length = 0;
  twinBridgeFake.mode = "ok";
  twinBridgeFake.upsertOptions.length = 0;
  attachShadowFake.mode = "ok";
  attachShadowFake.upsertOptions.length = 0;
  admissionRows.length = 0;
  // h106-attachdesign-1: a free lease, no scripted answers, no error, no recorded calls, no table log.
  leaseFake.row = null;
  leaseFake.error = null;
  leaseFake.acquireScript.length = 0;
  leaseFake.calls.length = 0;
  fromTables.length = 0;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
  // Unset by default so tests that don't opt in never trigger a real fetch.
  delete process.env.REVALIDATE_URL;
  delete process.env.CRON_SECRET;
  // Migration 089 ("ADMIT"): off unless a test opts in.
  delete process.env.JEV_POLITICS_ADMISSION;
  // Hunt-25 W3: unset means shadow; a test opts into off / live.
  delete process.env.CLUSTER_ATTACH_MODE;
  // Opt-in flags other describes set; never inherited from a previous test.
  delete process.env.JEV_LIVE_PAIRS;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.REVALIDATE_FEED_TAGS;
  // h106-attachdesign-1: the lease and the kick are unset unless a test opts in.
  delete process.env.CLUSTER_LEASE;
  delete process.env.CLUSTER_KICK;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The tests below import the SUT lazily inside each `it` so that vi.mock
// boundaries resolve to the stubs above. If the module fails to import
// (sister builder hasn't shipped yet) the suite skips rather than crashes —
// this lets B10's tests land first without blocking CI on B3's timing.
// ---------------------------------------------------------------------------

async function importHandler(): Promise<((req: Request) => Promise<Response>) | null> {
  // No try/catch: if the SUT fails to import, the test must surface that
  // error directly rather than masquerade as a silent skip.
  await import("../../supabase/functions/cluster-consumer/index.ts");
  const reg = (globalThis as unknown as {
    __registeredHandler?: (req: Request) => Promise<Response>;
  }).__registeredHandler;
  return reg ?? null;
}

// ---------------------------------------------------------------------------
// Reads back the bias_distribution the SUT actually wrote for whichever
// message was just drained. A brand-new cluster writes it via the
// `clusters` insert patch (createCluster); an existing cluster writes it via
// the `cluster_link_atomic` RPC's `p_bias_distribution` arg
// (addArticleToCluster). Both paths apply the same voting rule
// (source-kind.ts), so preferring the rpc value whenever one was recorded
// keeps the assertions correct even if an LSH band collision against a
// cluster left in the module-level cache by an earlier test routes the
// article to the match path instead of the create path.
// ---------------------------------------------------------------------------
function lastWrittenDistribution(): Record<string, number> | undefined {
  const linkCalls = supabaseFakeCalls.rpc.filter(
    (r) => r.name === "cluster_link_atomic",
  );
  if (linkCalls.length > 0) {
    const last = linkCalls[linkCalls.length - 1];
    return (
      last.args as { p_bias_distribution?: Record<string, number> } | undefined
    )?.p_bias_distribution;
  }
  const clusterInserts = supabaseFakeCalls.insert("clusters");
  const last = clusterInserts[clusterInserts.length - 1];
  return (
    last?.patch as { bias_distribution?: Record<string, number> } | undefined
  )?.bias_distribution;
}

describe("cluster-consumer Edge Function", () => {
  it("dequeues messages from the cluster_work queue (up to batch size)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = Array.from({ length: 75 }, (_, i) => ({
      msg_id: i + 1,
      read_ct: 1,
      message: { article_id: `art-${i + 1}` },
    }));
    fakeArticles["art-1"] = {
      id: "art-1",
      title: "Test",
      description: "Body",
      url: "https://example.com/1",
      category: "politika",
      created_at: new Date().toISOString(),
    };

    const res = await handler(
      authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
    );
    expect([200, 207]).toContain(res.status);
    // The handler reads in batches of BATCH_SIZE (50) and continues looping
    // until the queue is drained or the invocation budget elapses. With 75
    // synthetic messages and a mocked, near-instant pgmq, the queue ends up
    // fully drained within the single invocation. The contract being
    // exercised here is "the handler PULLS messages off the queue" — the
    // pre-Round-4 fake silently green-passed this by drifting on `.gte()`
    // / `.range()` and never actually invoking the read loop. The shared
    // fake now runs the chain end-to-end, so the assertion becomes "queue
    // was drained" (length 0) rather than "exactly one batch remaining".
    expect(pgmqState.pending.length).toBeLessThanOrEqual(50);
  });

  it("archives messages that processed successfully", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 10, read_ct: 1, message: { article_id: "art-10" } },
    ];
    fakeArticles["art-10"] = {
      id: "art-10",
      title: "Headline",
      description: "Body",
      url: "https://example.com/10",
      category: "politika",
      created_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    // Archived on success (and poison messages archive too) — the contract
    // is that the message is REMOVED from the live queue, never left to
    // re-deliver.
    const removed = [...pgmqState.archived, ...pgmqState.deleted];
    expect(removed).toContain(10);
    // Tripwire (R4-P3): the shared chainable Supabase fake observed at least
    // one write into the cluster bookkeeping. Either a brand-new cluster
    // was inserted, or an existing one received a link via cluster_articles.
    // If the proxy fake silently green-passes by no-op-ing the chain (the
    // exact failure mode that hid the .gte/.range/.update().eq drifts for
    // two rounds), this assertion catches it.
    const clusterWrites =
      supabaseFakeCalls.insert("clusters").length +
      supabaseFakeCalls.insert("cluster_articles").length +
      supabaseFakeCalls.upsert("clusters").length +
      supabaseFakeCalls.upsert("cluster_articles").length;
    expect(clusterWrites).toBeGreaterThan(0);
  });

  it("archives (never deletes) messages with read_ct > 3 (poison handling)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 99, read_ct: 5, message: { article_id: "ghost" } },
    ];
    // No fakeArticles["ghost"] → article fetch returns null → processArticle
    // returns "not-found" gracefully, the outer loop archives the message
    // (no exception → no permanent-failure branch). The contract being
    // verified here is that the message is moved out of the live queue via
    // pgmq.archive — never deleted (the archive table is the audit trail)
    // and never left to re-deliver — regardless of which branch handled it.
    // A poison-classification subtest is owned by the integration-side
    // pgmq harness (B10), not by this contract suite.
    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(pgmqState.archived).toContain(99);
    expect(pgmqState.deleted).not.toContain(99);
  });

  it("returns within the per-invocation 30 s cap (smoke)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Empty queue → handler should return promptly.
    const start = Date.now();
    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(Date.now() - start).toBeLessThan(30_000);
  });

  it("is idempotent — re-processing the same article produces the same upsert", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 1, read_ct: 1, message: { article_id: "art-idem" } },
    ];
    fakeArticles["art-idem"] = {
      id: "art-idem",
      title: "Same",
      description: "Same",
      url: "https://example.com/idem",
      category: "politika",
      created_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    const archivedOnce = [...pgmqState.archived];

    // Replay with the same payload.
    pgmqState.pending = [
      { msg_id: 2, read_ct: 1, message: { article_id: "art-idem" } },
    ];
    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    // Both runs must have removed their message from the queue.
    expect(pgmqState.archived.length + pgmqState.deleted.length).toBeGreaterThan(
      archivedOnce.length,
    );
  });

  it("returns 200 with an empty queue (no work is not an error)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [];
    const res = await handler(
      authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(200);
  });

  it("returns 401 without a service-role bearer", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Deliberately unauthenticated — no Authorization header.
    const res = await handler(
      new Request("http://localhost/cluster-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    // Queue must be untouched when auth fails.
    expect(pgmqState.archived.length + pgmqState.deleted.length).toBe(0);
  });

  it("an aggregator-kind source never votes in bias_distribution", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 201, read_ct: 1, message: { article_id: "art-agg" } },
    ];
    fakeArticles["art-agg"] = {
      id: "art-agg",
      source_id: "src-agg",
      title: "Zeytinyağı ihracatında rekor bekleniyor",
      description: "Body",
      url: "https://example.com/agg",
      category: "politika",
      published_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const dist = lastWrittenDistribution();
    expect(dist).toBeDefined();
    for (const value of Object.values(dist ?? {})) {
      expect(value).toBe(0);
    }

    const clusterInserts = supabaseFakeCalls.insert("clusters");
    if (clusterInserts.length > 0) {
      const patch = clusterInserts[clusterInserts.length - 1].patch as {
        is_blindspot?: boolean;
        blindspot_side?: string | null;
      };
      expect(patch.is_blindspot).toBe(false);
      expect(patch.blindspot_side).toBeNull();
    }

    expect([...pgmqState.archived, ...pgmqState.deleted]).toContain(201);
    expect(
      supabaseFakeCalls.insert("cluster_articles").length +
        supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic")
          .length,
    ).toBeGreaterThan(0);
  });

  it("an outlet-kind source votes with its bias", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 202, read_ct: 1, message: { article_id: "art-outlet" } },
    ];
    fakeArticles["art-outlet"] = {
      id: "art-outlet",
      source_id: "src-outlet",
      title: "Kuraklık barajları vurdu",
      description: "Body",
      url: "https://example.com/outlet",
      category: "politika",
      published_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const dist = lastWrittenDistribution();
    expect(dist).toBeDefined();
    expect(dist?.pro_government).toBe(1);
    for (const [key, value] of Object.entries(dist ?? {})) {
      if (key === "pro_government") continue;
      expect(value).toBe(0);
    }
  });

  it("a wire-kind source votes", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [
      { msg_id: 203, read_ct: 1, message: { article_id: "art-wire" } },
    ];
    fakeArticles["art-wire"] = {
      id: "art-wire",
      source_id: "src-wire",
      title: "Limanda yangın söndürüldü",
      description: "Body",
      url: "https://example.com/wire",
      category: "politika",
      published_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const dist = lastWrittenDistribution();
    expect(dist).toBeDefined();
    expect(dist?.state_media).toBe(1);
    for (const [key, value] of Object.entries(dist ?? {})) {
      if (key === "state_media") continue;
      expect(value).toBe(0);
    }
  });

  it("the sources lookup selects the kind column", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    pgmqState.pending = [];
    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    const src = readFileSync(
      resolve(__dirname, "../../supabase/functions/cluster-consumer/index.ts"),
      "utf8",
    );
    expect(src).toMatch(/from\("sources"\)\.select\("id, bias, name, slug, kind"\)/);
  });

  it("POSTs once to REVALIDATE_URL with ONLY cluster-detail tags by default (reader-queries E4), and not when nothing changed", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    process.env.REVALIDATE_URL = "https://example.test/api/revalidate";
    process.env.CRON_SECRET = "test-cron-secret";
    delete process.env.REVALIDATE_FEED_TAGS;
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    pgmqState.pending = [
      { msg_id: 301, read_ct: 1, message: { article_id: "art-revalidate" } },
    ];
    fakeArticles["art-revalidate"] = {
      id: "art-revalidate",
      title: "Yeni haber",
      description: "Body",
      url: "https://example.com/revalidate",
      category: "politika",
      published_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    // Exactly one revalidation POST for the whole drain, not one per article.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://example.test/api/revalidate");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer test-cron-secret",
    );
    const body = JSON.parse(init.body as string) as { tags: string[] };
    // reader-queries E4: feed tags are opt-in now — the 300s cluster-feed
    // cache window (E1) never held while every drain re-marked the whole
    // feed stale. Only cluster-detail:<id> tags fire by default.
    expect(body.tags).not.toContain("clusters-politics");
    expect(body.tags).not.toContain("clusters");
    for (const tag of body.tags) {
      expect(tag).toMatch(/^cluster-detail:/);
    }
    expect(body.tags.length).toBeGreaterThan(0);

    // A second drain with nothing pending must not fire another POST.
    fetchMock.mockClear();
    pgmqState.pending = [];
    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("POSTs both feed tags when REVALIDATE_FEED_TAGS=1 (opt-in escape hatch)", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    process.env.REVALIDATE_URL = "https://example.test/api/revalidate";
    process.env.CRON_SECRET = "test-cron-secret";
    process.env.REVALIDATE_FEED_TAGS = "1";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      pgmqState.pending = [
        { msg_id: 302, read_ct: 1, message: { article_id: "art-revalidate-2" } },
      ];
      fakeArticles["art-revalidate-2"] = {
        id: "art-revalidate-2",
        title: "Yeni haber 2",
        description: "Body",
        url: "https://example.com/revalidate-2",
        category: "politika",
        published_at: new Date().toISOString(),
      };

      await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { tags: string[] };
      expect(body.tags).toContain("clusters-politics");
      expect(body.tags).toContain("clusters");
      expect(body.tags.some((t) => /^cluster-detail:/.test(t))).toBe(true);
    } finally {
      delete process.env.REVALIDATE_FEED_TAGS;
    }
  });

  it("caps the revalidation tag payload at 100: default gives 100 detail tags; includeFeedTags gives 2 feed tags + 98 detail tags", async () => {
    // /api/revalidate's MAX_TAGS is 100; a big drain must never overflow it.
    await importHandler();
    const mod = await import("../../supabase/functions/cluster-consumer/index.ts");
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);

    const defaultTags = mod.buildRevalidationTags(ids);
    expect(defaultTags.length).toBe(100);
    expect(defaultTags).toEqual(ids.slice(0, 100).map((id) => `cluster-detail:${id}`));

    const withFeedTags = mod.buildRevalidationTags(ids, true);
    expect(withFeedTags.length).toBe(100);
    expect(withFeedTags[0]).toBe("clusters-politics");
    expect(withFeedTags[1]).toBe("clusters");
    expect(withFeedTags.slice(2)).toEqual(
      ids.slice(0, 98).map((id) => `cluster-detail:${id}`),
    );
  });

  // -------------------------------------------------------------------
  // P3 live marginal verification (migration 064) -- flag-off invariants.
  // The `clusters` fixture above is always empty, so `scored` never gets a
  // `primary` candidate and the live-verification block is always a no-op
  // regardless of the flag; these two tests instead guard the response
  // shape and the "never touches the gateway" contract that must hold no
  // matter what candidates exist.
  // -------------------------------------------------------------------

  it("drain response carries jev_live with enabled false when JEV_LIVE_PAIRS is unset", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    delete process.env.JEV_LIVE_PAIRS;
    delete process.env.AI_GATEWAY_API_KEY;
    pgmqState.pending = [];

    const res = await handler(
      authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { jev_live?: Record<string, unknown> };
    expect(body.jev_live).toEqual({
      enabled: false,
      calls: 0,
      joined_by_jev: 0,
      rejected_by_jev: 0,
      errors: 0,
      timeouts: 0,
      budget_skipped: 0,
    });
  });

  it("with JEV_LIVE_PAIRS unset the drain makes zero fetches to the Jev gateway", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    delete process.env.JEV_LIVE_PAIRS;
    delete process.env.AI_GATEWAY_API_KEY;
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    pgmqState.pending = [
      { msg_id: 401, read_ct: 1, message: { article_id: "art-jevflagoff" } },
    ];
    fakeArticles["art-jevflagoff"] = {
      id: "art-jevflagoff",
      title: "Bayrak kapalıyken canlı doğrulama yok",
      description: "Body",
      url: "https://example.com/jevflagoff",
      category: "politika",
      published_at: new Date().toISOString(),
    };

    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

    // No REVALIDATE_URL/CRON_SECRET is set in beforeEach either, so this
    // also holds fetch to zero calls overall -- the point being asserted
    // is that the flag-off live-verification path never reaches for
    // `fetch` at all, not merely that it targets a different URL.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------------------
  // P3 live marginal verification -- LIVE path (A2 budget-on-attempts fix
  // + A3 join/reject/timeout/db-error coverage). Every test above this
  // point runs with the `clusters` fixture empty, so `scored` never gets a
  // `primary` candidate and this whole block was previously a structural
  // no-op no matter what JEV_LIVE_PAIRS/AI_GATEWAY_API_KEY were set to --
  // exactly how A1's try/catch-swallows-the-DB-throw bug survived review
  // with a fully green suite. The tests below give clusterArticle a real
  // candidate cluster to score against so the jev-live block actually runs.
  //
  // clusterContextCache (module-level in the SUT) has a 60s TTL keyed off
  // Date.now(). The file-level beforeEach evaluates the SUT fresh for every
  // test (vi.resetModules), so no cache survives from a previous test and the
  // shared cluster seeded in this block's beforeEach is always what the first
  // read loads, whatever order the tests run in. The Date fake below only
  // freezes the clock for the block (a one-time forward jump in `beforeAll`,
  // kept from the era when the module was evaluated once and the jump was
  // what invalidated a warm cache); `toFake: ["Date"]` leaves real timers
  // (setTimeout, AbortSignal) untouched.
  describe("P3 live marginal verification -- live path (A2 budget + A3 join/reject/timeout/db-error)", () => {
    const SHARED_CLUSTER_ID = "cluster-live-shared";
    const SHARED_MEMBER_ID = "member-live-shared";
    // Every incoming test article below is titled "Ankara depremi ..." so
    // it shares >= TOKEN_CANDIDATE_MIN_SHARED (2) tokens ("ankara",
    // "depremi") with this seed via the title-token candidate route --
    // each test's own tail text differs (and differs from this seed's)
    // so the strict-fingerprint fast path (an exact shingle-set match)
    // never fires and short-circuits past the ensemble/jev-live code the
    // fast path predates.
    const SEED_TITLE = "Ankara depremi sonrasi kurtarma ekipleri bolgeye ulasti";
    const SEED_DESCRIPTION = "Bolgede arama calismalari suruyor";

    // The mock factory's own default (0.82, always). Every "created" outcome
    // in this block (band-low with no Jev override, or a Jev reject) grows
    // the candidate pool with a new auto-created cluster that ALSO shares
    // the "ankara"+"depremi" tokens with every later test's title -- so by
    // the second test in this block, `score()` is called more than once per
    // article (once per candidate cluster). A `mockReturnValueOnce` only
    // covers the first of those calls, and any later call silently falls
    // back to this same default, which then wins `primary` on ensemble
    // score alone (0.82 sorts above the band the test intended to control).
    // `mockImplementation` below controls EVERY call for the duration of a
    // test instead, and `afterEach` restores this default so the next test
    // (in or outside this block) is unaffected.
    const defaultScoreImpl = () => ({
      score: 0.82,
      components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
      isMatch: true,
    });

    function mockBandScore(score: number): void {
      vi.mocked(scoreMock).mockImplementation(() => ({
        score,
        components: { cosine: 0.3, entityJaccard: 0, fingerprintMatch: false },
        isMatch: false,
      }));
    }

    beforeAll(() => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date(Date.now() + 61_000));
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    beforeEach(() => {
      process.env.JEV_LIVE_PAIRS = "1";
      process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
      // The shared candidate cluster is re-seeded for every test: the file-level
      // beforeEach empties the hoisted cluster fixtures (so rows pushed by one
      // test, e.g. [A-ADV-02]'s two Izmir clusters, never reach another) and
      // the SUT is evaluated fresh, so it loads this row on its first read.
      const now = new Date().toISOString();
      clusterRows.push({
        id: SHARED_CLUSTER_ID,
        title_tr: SEED_TITLE,
        title_tr_neutral: SEED_TITLE,
        first_published: now,
        updated_at: now,
        article_count: 1,
      });
      clusterArticleRows.push({ cluster_id: SHARED_CLUSTER_ID, article_id: SHARED_MEMBER_ID });
      // addArticleToCluster reads `cluster_articles`/`articles` fresh on
      // every call (never cached) and the outer beforeEach above wipes
      // `fakeArticles` before each test -- restore the shared seed member
      // here (inner beforeEach hooks run after outer ones) so the live
      // join queries keep resolving for every test in this block, not just
      // the first one that happened to warm the cache.
      fakeArticles[SHARED_MEMBER_ID] = {
        id: SHARED_MEMBER_ID,
        source_id: null,
        title: SEED_TITLE,
        description: SEED_DESCRIPTION,
        published_at: new Date().toISOString(),
        fingerprint: null,
        entities: [],
        category: "politika",
        minhash_sig: null,
        minhash_version: null,
      };
    });

    afterEach(() => {
      vi.mocked(scoreMock).mockImplementation(defaultScoreImpl);
    });

    function jevResponse(probability: number, inputTokens = 12): Response {
      return new Response(
        JSON.stringify({
          answers: { p1: { type: "boolean", probability } },
          usage: { inputTokens, outputTokens: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    function abortErrorFetch(): ReturnType<typeof vi.fn> {
      return vi.fn(async () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      });
    }

    it("(a) band-low join (p>=0.7): exactly one fetch, matches the primary cluster, upserts one 'joined' pair_marginal row", async () => {
      const title = "Ankara depremi sonrasi kurtarma calismalari hiz kazandi";
      pgmqState.pending = [
        { msg_id: 501, read_ct: 1, message: { article_id: "art-live-a" } },
      ];
      fakeArticles["art-live-a"] = {
        id: "art-live-a",
        source_id: null,
        title,
        description: "Detay A",
        url: "https://example.com/live-a",
        category: "politika",
        published_at: new Date().toISOString(),
      };
      mockBandScore(0.38);
      const fetchMock = vi.fn(async () => jevResponse(0.9));
      vi.stubGlobal("fetch", fetchMock);

      const handler = await importHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        failedTransient: number;
        jev_live: { calls: number; joined_by_jev: number; errors: number };
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body.matched).toBe(1);
      expect(body.created).toBe(0);
      expect(body.failedTransient).toBe(0);
      expect(body.jev_live.calls).toBe(1);
      expect(body.jev_live.joined_by_jev).toBe(1);
      expect(body.jev_live.errors).toBe(0);

      const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
      expect(linkCalls.length).toBe(1);
      expect((linkCalls[0]?.args as { p_cluster_id: string }).p_cluster_id).toBe(SHARED_CLUSTER_ID);

      const marginalUpserts = supabaseFakeCalls.upsert("jev_shadow_predictions");
      expect(marginalUpserts.length).toBe(1);
      const rows = marginalUpserts[0]?.patch as Array<{ jev_answer: { decision: string } }>;
      expect(rows[0]?.jev_answer.decision).toBe("joined");

      expect([...pgmqState.archived, ...pgmqState.deleted]).toContain(501);
    });

    it("(b) band-high reject (p<0.3): primary is blocked, the article falls through to createCluster (not matched)", async () => {
      const title = "Ankara depremi nedeniyle okullar tatil edildi";
      pgmqState.pending = [
        { msg_id: 502, read_ct: 1, message: { article_id: "art-live-b" } },
      ];
      fakeArticles["art-live-b"] = {
        id: "art-live-b",
        source_id: null,
        title,
        description: "Detay B",
        url: "https://example.com/live-b",
        category: "politika",
        published_at: new Date().toISOString(),
      };
      mockBandScore(0.41);
      const fetchMock = vi.fn(async () => jevResponse(0.1));
      vi.stubGlobal("fetch", fetchMock);

      const handler = await importHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        jev_live: { calls: number; rejected_by_jev: number };
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body.matched).toBe(0);
      expect(body.created).toBe(1);
      expect(body.jev_live.calls).toBe(1);
      expect(body.jev_live.rejected_by_jev).toBe(1);

      const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
      expect(linkCalls.length).toBe(0);

      const marginalUpserts = supabaseFakeCalls.upsert("jev_shadow_predictions");
      expect(marginalUpserts.length).toBe(1);
      const rows = marginalUpserts[0]?.patch as Array<{ jev_answer: { decision: string } }>;
      expect(rows[0]?.jev_answer.decision).toBe("rejected");
    });

    it("(c) AbortError from fetch: jev_live.timeouts===1, errors===0, and the ensemble's own decision (band-low -> create) is untouched", async () => {
      const title = "Ankara depremi sonrasi enkaz altinda arama suruyor";
      pgmqState.pending = [
        { msg_id: 503, read_ct: 1, message: { article_id: "art-live-c" } },
      ];
      fakeArticles["art-live-c"] = {
        id: "art-live-c",
        source_id: null,
        title,
        description: "Detay C",
        url: "https://example.com/live-c",
        category: "politika",
        published_at: new Date().toISOString(),
      };
      mockBandScore(0.38);
      const fetchMock = abortErrorFetch();
      vi.stubGlobal("fetch", fetchMock);

      const handler = await importHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        jev_live: { calls: number; timeouts: number; errors: number };
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body.jev_live.timeouts).toBe(1);
      expect(body.jev_live.errors).toBe(0);
      expect(body.jev_live.calls).toBe(0);
      // Band-low: absent a Jev override the ensemble alone never joins an
      // existing cluster (score < MATCH_THRESHOLD) -- "untouched" means
      // the article still falls through to createCluster, exactly as it
      // would with the flag off.
      expect(body.matched).toBe(0);
      expect(body.created).toBe(1);
    });

    it("(d) [A1] addArticleToCluster's RPC erroring on a Jev-directed join reports failedTransient (not created), and jev_live.errors is NOT incremented", async () => {
      const title = "Ankara depremi sonrasi yardim kampanyasi baslatildi";
      pgmqState.pending = [
        { msg_id: 504, read_ct: 1, message: { article_id: "art-live-d" } },
      ];
      fakeArticles["art-live-d"] = {
        id: "art-live-d",
        source_id: null,
        title,
        description: "Detay D",
        url: "https://example.com/live-d",
        category: "politika",
        published_at: new Date().toISOString(),
      };
      mockBandScore(0.38);
      const fetchMock = vi.fn(async () => jevResponse(0.9));
      vi.stubGlobal("fetch", fetchMock);
      rpcFixtures.cluster_link_atomic = { data: null, error: { message: "boom" } };

      const handler = await importHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        failedTransient: number;
        jev_live: { calls: number; joined_by_jev: number; errors: number };
      };

      expect(body.matched).toBe(0);
      expect(body.created).toBe(0);
      expect(body.failedTransient).toBe(1);
      expect(body.jev_live.calls).toBe(1);
      expect(body.jev_live.joined_by_jev).toBe(0);
      // The RPC throw happens OUTSIDE the try/catch that increments
      // jev_live.errors (A1 fix) -- it must propagate to drainQueue's own
      // failedTransient accounting instead of being swallowed here.
      expect(body.jev_live.errors).toBe(0);

      expect(pgmqState.archived).not.toContain(504);
      expect(pgmqState.deleted).not.toContain(504);
    });

    it("[A2] 40 consecutive failing/timing-out attempts stop the 41st: fetch is called exactly 40 times, and budget_skipped is 1", async () => {
      const N = 41;
      pgmqState.pending = Array.from({ length: N }, (_, i) => ({
        msg_id: 600 + i,
        read_ct: 1,
        message: { article_id: `art-live-budget-${i}` },
      }));
      const now = new Date().toISOString();
      for (let i = 0; i < N; i++) {
        fakeArticles[`art-live-budget-${i}`] = {
          id: `art-live-budget-${i}`,
          source_id: null,
          title: `Ankara depremi haberi guncelleme ${i}`,
          description: `Detay budget ${i}`,
          url: `https://example.com/live-budget-${i}`,
          category: "politika",
          published_at: now,
        };
      }
      // Every candidate scores band-low regardless of which cluster it is
      // scored against -- the budget test only needs `primary` to exist on
      // every one of the 41 messages, not a specific winning cluster.
      // `afterEach` above restores the default implementation.
      mockBandScore(0.38);
      const fetchMock = abortErrorFetch();
      vi.stubGlobal("fetch", fetchMock);

      const handler = await importHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        created: number;
        jev_live: {
          calls: number;
          timeouts: number;
          errors: number;
          budget_skipped: number;
        };
      };

      expect(fetchMock).toHaveBeenCalledTimes(40);
      expect(body.jev_live.timeouts).toBe(40);
      expect(body.jev_live.calls).toBe(0);
      expect(body.jev_live.errors).toBe(0);
      expect(body.jev_live.budget_skipped).toBe(1);
      expect(body.created).toBe(N);
    });

    it("[A-ADV-02] a band-high reject may only fall back to a candidate the ensemble would have joined on its own (>= MATCH_THRESHOLD), never a sub-threshold one", async () => {
      // Dedicated two-candidate scenario (test (b) above only ever exercises
      // a single candidate cluster, so it can never reach the fallback
      // loop's bar at all). Force a fresh loadClusterContext fetch so these
      // two clusters -- and *only* these two, via non-overlapping title
      // tokens -- are the candidates scored for the incoming article.
      vi.setSystemTime(new Date(Date.now() + 61_000));

      const now = new Date().toISOString();
      const CLUSTER_A_ID = "cluster-live-b41-primary";
      const CLUSTER_B_ID = "cluster-live-b41-second";
      const MEMBER_A_ID = "member-live-b41-primary";
      const MEMBER_B_ID = "member-live-b41-second";
      const FP_A = "fp-b41-primary";
      const FP_B = "fp-b41-second";
      const TITLE_A = "Izmir liman genisletme projesi onaylandi";
      const TITLE_B = "Izmir liman genisletme ihalesi iptal edildi";

      clusterRows.push(
        {
          id: CLUSTER_A_ID,
          title_tr: TITLE_A,
          title_tr_neutral: TITLE_A,
          first_published: now,
          updated_at: now,
          article_count: 1,
        },
        {
          id: CLUSTER_B_ID,
          title_tr: TITLE_B,
          title_tr_neutral: TITLE_B,
          first_published: now,
          updated_at: now,
          article_count: 1,
        },
      );
      clusterArticleRows.push(
        { cluster_id: CLUSTER_A_ID, article_id: MEMBER_A_ID },
        { cluster_id: CLUSTER_B_ID, article_id: MEMBER_B_ID },
      );
      fakeArticles[MEMBER_A_ID] = {
        id: MEMBER_A_ID,
        source_id: null,
        title: TITLE_A,
        description: "Detay A",
        published_at: now,
        fingerprint: FP_A,
        entities: [],
        category: "politika",
        minhash_sig: null,
        minhash_version: null,
      };
      fakeArticles[MEMBER_B_ID] = {
        id: MEMBER_B_ID,
        source_id: null,
        title: TITLE_B,
        description: "Detay B",
        published_at: now,
        fingerprint: FP_B,
        entities: [],
        category: "politika",
        minhash_sig: null,
        minhash_version: null,
      };

      const title = "Izmir liman genisletme calismasi durduruldu";
      pgmqState.pending = [
        { msg_id: 700, read_ct: 1, message: { article_id: "art-live-b41" } },
      ];
      fakeArticles["art-live-b41"] = {
        id: "art-live-b41",
        source_id: null,
        title,
        description: "Detay çalışma",
        url: "https://example.com/live-b41",
        category: "politika",
        published_at: now,
      };

      // Primary (cluster A) scores 0.41 -- band-high. Second candidate
      // (cluster B) scores 0.37: below MATCH_THRESHOLD (0.40) but above the
      // old bar, FALLBACK_FLOOR (0.36) -- exactly the gap this fix closes.
      vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown) => {
        const strict = (b as { strict?: string | null } | null | undefined)?.strict ?? null;
        const s = strict === FP_A ? 0.41 : strict === FP_B ? 0.37 : 0;
        return {
          score: s,
          components: { cosine: 0.3, entityJaccard: 0, fingerprintMatch: false },
          isMatch: false,
        };
      });
      const fetchMock = vi.fn(async () => jevResponse(0.1)); // p<0.3 -> reject
      vi.stubGlobal("fetch", fetchMock);

      const handler = await importHandler();
      expect(handler).toBeDefined();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        jev_live: { calls: number; rejected_by_jev: number };
      };

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(body.jev_live.rejected_by_jev).toBe(1);
      expect(body.matched).toBe(0);
      expect(body.created).toBe(1);

      // Neither candidate was ever joined: A is blocked by the reject, and B
      // (0.37) never clears the MATCH_THRESHOLD bar the reject imposes --
      // addArticleToCluster (cluster_link_atomic) must not have been called.
      const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
      expect(linkCalls.length).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2026-11-01 recall wave: sticky context + headline titles. At peak the
  // newest-200 window spans ~2 h, so a busy story that went quiet for 3 h used
  // to drop out of the context. loadClusterContext now runs a second, bounded
  // query for recent multi-article clusters and passes the titles to score().
  // -------------------------------------------------------------------------
  describe("sticky context + headline titles (2026-11-01)", () => {
    const CAP = 200;
    const BUSY_ID = "cluster-busy-3h";
    const BUSY_MEMBER = "member-busy-3h";
    const FP_BUSY = "fp-busy-3h";
    const BUSY_TITLE = "Izmir liman genisletme projesi onaylandi";
    const NEW_TITLE = "Izmir liman genisletme calismasi durduruldu";

    function seedWindow(n: number) {
      const t0 = Date.now();
      for (let i = 0; i < n; i++) {
        clusterRows.push({
          id: `win-${i}`,
          title_tr: `Pencere ${i}`,
          title_tr_neutral: `Pencere ${i}`,
          first_published: new Date(t0 - i * 10_000).toISOString(),
          updated_at: new Date(t0 - i * 10_000).toISOString(),
          article_count: 1,
        });
      }
    }

    function seedBusyCluster() {
      const updated = new Date(Date.now() - 3 * 3_600_000).toISOString();
      stickyClusterRows.push({
        id: BUSY_ID,
        title_tr: BUSY_TITLE,
        title_tr_neutral: BUSY_TITLE,
        first_published: updated,
        updated_at: updated,
        article_count: 20,
        is_archived: false,
        merged_into: null,
      });
      clusterArticleRows.push({ cluster_id: BUSY_ID, article_id: BUSY_MEMBER });
      fakeArticles[BUSY_MEMBER] = {
        id: BUSY_MEMBER,
        source_id: null,
        title: BUSY_TITLE,
        description: "Detay",
        published_at: updated,
        fingerprint: FP_BUSY,
        entities: [],
        category: "politika",
        minhash_sig: null,
        minhash_version: null,
      };
    }

    function seedIncoming() {
      pgmqState.pending = [
        { msg_id: 1100, read_ct: 1, message: { article_id: "art-sticky" } },
      ];
      fakeArticles["art-sticky"] = {
        id: "art-sticky",
        source_id: null,
        title: NEW_TITLE,
        description: "Detay çalışma",
        url: "https://example.com/art-sticky",
        category: "politika",
        published_at: new Date().toISOString(),
      };
    }

    async function drain() {
      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      return res;
    }

    it("full window: runs the bounded sticky query and scores the busy cluster, passing both titles", async () => {
      seedWindow(CAP);
      seedBusyCluster();
      seedIncoming();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await drain();

      const stickyQ = clusterQueries.find((q) =>
        (q as unknown as { lt: Array<{ col: string }> }).lt.some((p) => p.col === "updated_at")
      ) as unknown as {
        gte: Array<{ col: string; val: unknown }>;
        lt: Array<{ col: string; val: unknown }>;
        eq: Array<{ col: string; val: unknown }>;
        is: Array<{ col: string; val: unknown }>;
        order: Array<{ col: string; opts: { ascending?: boolean } }>;
        limit: number | null;
      };
      expect(stickyQ).toBeDefined();
      // Exclusive upper bound = updated_at of the 200th newest window cluster.
      expect(stickyQ.lt).toEqual([{ col: "updated_at", val: clusterRows[CAP - 1]!.updated_at }]);
      const gteCols = stickyQ.gte.map((p) => p.col).sort();
      expect(gteCols).toEqual(["article_count", "updated_at"]);
      expect(stickyQ.gte.find((p) => p.col === "article_count")!.val).toBe(5);
      const horizon = Date.parse(stickyQ.gte.find((p) => p.col === "updated_at")!.val as string);
      expect(Math.abs(Date.now() - 12 * 3_600_000 - horizon)).toBeLessThan(60_000);
      expect(stickyQ.eq).toEqual([{ col: "is_archived", val: false }]);
      expect(stickyQ.is).toEqual([{ col: "merged_into", val: null }]);
      expect(stickyQ.order[0]).toMatchObject({ col: "article_count", opts: { ascending: false } });
      expect(stickyQ.limit).toBe(60);

      // The busy cluster's seed was a scored candidate, and score() got titles.
      const calls = vi.mocked(scoreMock).mock.calls;
      const busyCall = calls.find(
        (c) => (c[1] as { strict?: string | null } | null)?.strict === FP_BUSY,
      );
      expect(busyCall).toBeDefined();
      expect(busyCall![6]).toMatchObject({ aTitle: NEW_TITLE, bTitle: BUSY_TITLE });

      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^\[cluster-consumer\] context clusters=201 sticky=1 loadMs=\d+$/),
      );
      log.mockRestore();
    });

    it("window not full: no sticky query is issued", async () => {
      seedWindow(CAP - 1);
      seedBusyCluster();
      seedIncoming();
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      await drain();

      const withLt = clusterQueries.filter((q) =>
        (q as unknown as { lt: Array<{ col: string }> }).lt.some((p) => p.col === "updated_at")
      );
      expect(withLt).toHaveLength(0);
      const busyCall = vi.mocked(scoreMock).mock.calls.find(
        (c) => (c[1] as { strict?: string | null } | null)?.strict === FP_BUSY,
      );
      expect(busyCall).toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^\[cluster-consumer\] context clusters=199 sticky=0 loadMs=\d+$/),
      );
      log.mockRestore();
    });

    it("sticky query error: warns and still drains without sticky rows", async () => {
      seedWindow(CAP);
      seedBusyCluster();
      seedIncoming();
      stickyQuery.error = { message: "statement timeout" };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const res = await drain();
      const body = (await res.json()) as { created: number; matched: number };
      expect(body.created + body.matched).toBe(1);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining("statement timeout"));
      const busyCall = vi.mocked(scoreMock).mock.calls.find(
        (c) => (c[1] as { strict?: string | null } | null)?.strict === FP_BUSY,
      );
      expect(busyCall).toBeUndefined();
      expect(log).toHaveBeenCalledWith(
        expect.stringMatching(/^\[cluster-consumer\] context clusters=200 sticky=0 loadMs=\d+$/),
      );
      warn.mockRestore();
      log.mockRestore();
    });
  });

  // -------------------------------------------------------------------------
  // Text floor vs the fallback join window. ENTITY_TEXT_FLOOR caps the
  // entity/tfidf lane at MATCH_THRESHOLD - 0.01 (0.39), which sits inside the
  // fallback window [FALLBACK_FLOOR 0.36, 0.40). When the primary candidate
  // already holds the incoming article's source (duplicate-source skip), the
  // fallback loop used to join the next candidate scoring >= 0.36, so a pair
  // carried by entities alone (tfidf < 0.20) still joined. Such a result must
  // stay reviewable by Jev's low band but never join as a fallback.
  // -------------------------------------------------------------------------
  describe("text-floor-capped candidates never join as a fallback (2026-11-01 review)", () => {
    const A = {
      cluster: "cluster-floor-a",
      member: "member-floor-a",
      fp: "fp-floor-a",
      title: "Izmir liman genisletme projesi onaylandi",
    };
    const B = {
      cluster: "cluster-floor-b",
      seed: "member-floor-b-seed",
      latest: "member-floor-b-latest",
      fpSeed: "fp-floor-b-seed",
      fpLatest: "fp-floor-b-latest",
      title: "Izmir liman genisletme ihalesi iptal edildi",
    };

    type Fake = { score: number; components: Record<string, unknown>; isMatch: boolean };
    const result = (s: number, components: Record<string, unknown> = {}): Fake => ({
      score: s,
      components: { cosine: 0.1, entityJaccard: 0, fingerprintMatch: false, ...components },
      isMatch: s >= 0.4,
    });
    // What the real scorer reports for a pair the text floor bound: entities
    // carried the primary lane, MinHash contributed nothing.
    const CAPPED = { textFloorCapped: true, raw: 0.39, jaccardScore: 0, primary: 0.45 };

    // These tests replace the stubbed scorer and nothing put it back, so under a shuffled order the
    // next test of another describe ran against this one's stub (the h40 "an article that joins its
    // candidate does not count" test failed on `--sequence.shuffle --sequence.seed=2`). Same default
    // as the vi.mock factory above.
    afterEach(() => {
      vi.mocked(scoreMock).mockImplementation(() => ({
        score: 0.82,
        components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
        isMatch: true,
      }));
    });

    function seedClusters(opts: { bHasLatest?: boolean } = {}) {
      const now = new Date().toISOString();
      const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
      clusterRows.push(
        { id: A.cluster, title_tr: A.title, title_tr_neutral: A.title, first_published: now, updated_at: now, article_count: 1 },
        { id: B.cluster, title_tr: B.title, title_tr_neutral: B.title, first_published: now, updated_at: now, article_count: 1 },
      );
      clusterArticleRows.push(
        { cluster_id: A.cluster, article_id: A.member },
        { cluster_id: B.cluster, article_id: B.seed },
      );
      // Cluster A already holds src-outlet, the incoming article's source.
      fakeArticles[A.member] = {
        id: A.member, source_id: "src-outlet", title: A.title, description: "Detay A",
        published_at: now, fingerprint: A.fp, entities: [], category: "politika",
        minhash_sig: null, minhash_version: null,
      };
      fakeArticles[B.seed] = {
        id: B.seed, source_id: "src-wire", title: B.title, description: "Detay B",
        published_at: opts.bHasLatest ? hourAgo : now, fingerprint: B.fpSeed, entities: [],
        category: "politika", minhash_sig: null, minhash_version: null,
      };
      if (opts.bHasLatest) {
        clusterArticleRows.push({ cluster_id: B.cluster, article_id: B.latest });
        fakeArticles[B.latest] = {
          id: B.latest, source_id: "src-agg", title: B.title, description: "Detay B2",
          published_at: now, fingerprint: B.fpLatest, entities: [], category: "politika",
          minhash_sig: null, minhash_version: null,
        };
      }
      pgmqState.pending = [{ msg_id: 1300, read_ct: 1, message: { article_id: "art-floor" } }];
      fakeArticles["art-floor"] = {
        id: "art-floor", source_id: "src-outlet",
        title: "Izmir liman genisletme calismasi durduruldu",
        description: "Detay çalışma", url: "https://example.com/art-floor",
        category: "politika", published_at: now,
      };
    }

    function scoreBy(byFp: Record<string, Fake>) {
      vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown) => {
        const strict = (b as { strict?: string | null } | null | undefined)?.strict ?? null;
        return (strict && byFp[strict]) || result(0);
      });
    }

    async function drain() {
      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as {
        matched: number;
        created: number;
        skipped: number;
        sameSourceUpdateShadow: number;
      };
    }

    const linkedClusters = () =>
      supabaseFakeCalls.rpc
        .filter((r) => r.name === "cluster_link_atomic")
        .map((r) => (r.args as { p_cluster_id: string }).p_cluster_id);

    it("primary skipped as duplicate-source + entity-only secondary at 0.39 -> no join (h12-cluster-1: the same-source duplicate is skipped, no twin is opened)", async () => {
      seedClusters();
      // h14-cluster-1: the skip needs strong evidence, so the incoming article is
      // src-outlet's re-publication of A's headline (an exact folded-title match),
      // not just a similar one.
      (fakeArticles["art-floor"] as { title: string }).title = A.title;
      scoreBy({ [A.fp]: result(0.6), [B.fpSeed]: result(0.39, CAPPED) });

      const body = await drain();

      expect(body.matched).toBe(0);
      // Before hunt 12 this opened a new cluster; A matched at 0.6 and already
      // holds the article's source, so that cluster would be A's twin.
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(1);
      expect(linkedClusters()).toEqual([]);
      expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
    });

    it("h14-cluster-1: the same match without evidence (a different headline, 3 shared stems) is not a duplicate: no join, the article opens its own cluster", async () => {
      // h45-clusters-1: with the same-source-update evidence OFF (the shadow setting this
      // pair was written for). The pair shares the named subject Izmir and 3 stems, so
      // the 4th kind of evidence does tie it ('proje onaylandi' / 'calisma durduruldu',
      // two developments of one port story): the shadow counter sees it, see the next test.
      updateFlag.override = false;
      seedClusters();
      scoreBy({ [A.fp]: result(0.6), [B.fpSeed]: result(0.39, CAPPED) });

      const body = await drain();

      expect(body.matched).toBe(0);
      expect(body.skipped).toBe(0);
      expect(body.created).toBe(1);
      expect(body.sameSourceUpdateShadow).toBe(1);
      expect(linkedClusters()).toEqual([]);
      expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
    });

    it("h45-clusters-1: the same pair with SAME_SOURCE_UPDATE_ENFORCE on is skipped as a follow-up of the source's own member (documented borderline: a second development of one story)", async () => {
      updateFlag.override = true;
      seedClusters();
      scoreBy({ [A.fp]: result(0.6), [B.fpSeed]: result(0.39, CAPPED) });

      const body = await drain();

      expect(body.matched).toBe(0);
      expect(body.created).toBe(0);
      expect(body.skipped).toBe(1);
      expect(body.sameSourceUpdateShadow).toBe(0);
      expect(linkedClusters()).toEqual([]);
      expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
    });

    it("control: the same secondary without the cap is the ordinary fallback join and still joins", async () => {
      seedClusters();
      scoreBy({ [A.fp]: result(0.6), [B.fpSeed]: result(0.39, { textFloorCapped: false }) });

      const body = await drain();

      expect(body.matched).toBe(1);
      expect(body.created).toBe(0);
      expect(linkedClusters()).toEqual([B.cluster]);
    });

    it("a MinHash-carried score keeps joining even though tfidf is below the floor (the cap did not decide it)", async () => {
      seedClusters();
      // raw == jaccardScore: the MinHash lane carried the pair (time-decayed to 0.38).
      scoreBy({
        [A.fp]: result(0.6),
        [B.fpSeed]: result(0.38, { textFloorCapped: true, raw: 0.8, jaccardScore: 0.8, primary: 0.2 }),
      });

      const body = await drain();

      expect(body.matched).toBe(1);
      expect(linkedClusters()).toEqual([B.cluster]);
    });

    it("a MinHash lane the sole-carrier guard capped does not carry the join: the reported jaccardScore is the uncapped one, jaccardForRaw is what reached raw", async () => {
      seedClusters();
      // Review of h173: J 0.55 (jaccardScore 0.82) was capped at SUBJECT_VETO_CAP 0.35 by the
      // sole-carrier guard, so raw (0.39) rests on the text-floor-capped lane only. raw > jaccardScore
      // is false here, but raw > jaccardForRaw is true: the capped lane carried it, it never joins.
      scoreBy({
        [A.fp]: result(0.6),
        [B.fpSeed]: result(0.37, {
          textFloorCapped: true,
          raw: 0.39,
          jaccardScore: 0.82,
          jaccardForRaw: 0.35,
          minhashSoleCarrierCapped: true,
        }),
      });

      const body = await drain();

      expect(body.matched).toBe(0);
      expect(linkedClusters()).toEqual([]);
    });

    it("jaccardForRaw equal to raw means the MinHash lane carried the pair: it still joins", async () => {
      seedClusters();
      scoreBy({
        [A.fp]: result(0.6),
        [B.fpSeed]: result(0.38, { textFloorCapped: true, raw: 0.8, jaccardScore: 0.8, jaccardForRaw: 0.8, primary: 0.2 }),
      });

      const body = await drain();

      expect(body.matched).toBe(1);
      expect(linkedClusters()).toEqual([B.cluster]);
    });

    it("a capped seed result does not hide an ordinary sub-threshold latest result of the same cluster", async () => {
      seedClusters({ bHasLatest: true });
      scoreBy({
        [A.fp]: result(0.6),
        [B.fpSeed]: result(0.39, CAPPED), // wins on score, but cannot join as a fallback
        [B.fpLatest]: result(0.37, { textFloorCapped: false }), // ordinary fallback candidate
      });

      const body = await drain();

      expect(body.matched).toBe(1);
      expect(linkedClusters()).toEqual([B.cluster]);
    });

    it("a capped secondary is skipped but a later ordinary candidate is still reached", async () => {
      seedClusters();
      // A third cluster C, ordinary 0.37, ranked below the capped 0.39 one.
      const now = new Date().toISOString();
      const C = { cluster: "cluster-floor-c", member: "member-floor-c", fp: "fp-floor-c", title: "Izmir liman genisletme ihale sonucu" };
      clusterRows.push({ id: C.cluster, title_tr: C.title, title_tr_neutral: C.title, first_published: now, updated_at: now, article_count: 1 });
      clusterArticleRows.push({ cluster_id: C.cluster, article_id: C.member });
      fakeArticles[C.member] = {
        id: C.member, source_id: "src-agg", title: C.title, description: "Detay C",
        published_at: now, fingerprint: C.fp, entities: [], category: "politika",
        minhash_sig: null, minhash_version: null,
      };
      scoreBy({
        [A.fp]: result(0.6),
        [B.fpSeed]: result(0.39, CAPPED),
        [C.fp]: result(0.37, { textFloorCapped: false }),
      });

      const body = await drain();

      expect(body.matched).toBe(1);
      expect(linkedClusters()).toEqual([C.cluster]);
    });
  });

  // -------------------------------------------------------------------------
  // Wave AB follow-up (V2): an incoming article is also compared with the
  // headlines of a candidate cluster's recent members, not only with its seed
  // and latest. The member headlines are held in ClusterContext.headlinesByCluster
  // (newest first, capped at HEADLINE_MEMBER_SCAN_MAX), built from the member
  // rows loadClusterContext already fetched -- the scan must add no DB reads.
  // `score` is stubbed to 0 for every seed/latest pair here so that only the
  // member scan (real headlineOnlyScore) can carry a join.
  // -------------------------------------------------------------------------
  describe("member-headline scan (wave AB follow-up)", () => {
    const H = 3_600_000;
    const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * H).toISOString();
    const CL = "cluster-hl";

    type Fake = { score: number; components: Record<string, unknown>; isMatch: boolean };
    const result = (s: number): Fake => ({
      score: s,
      components: { cosine: 0.1, entityJaccard: 0, fingerprintMatch: false },
      isMatch: s >= 0.4,
    });
    const defaultScoreImpl = () => ({
      score: 0.82,
      components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
      isMatch: true,
    });

    afterEach(() => {
      vi.mocked(scoreMock).mockImplementation(defaultScoreImpl);
    });

    // Scores a pair 0 unless the (incoming title, member title) pair is listed.
    function scoreOnly(pairs: Array<{ a: string; b: string; s: number }> = []) {
      vi.mocked(scoreMock).mockImplementation(
        (_a: unknown, _b: unknown, _ae: unknown, _be: unknown, _c: unknown, _h: unknown, opts?: unknown) => {
          const o = (opts ?? {}) as { aTitle?: string; bTitle?: string };
          const hit = pairs.find((p) => p.a === o.aTitle && p.b === o.bTitle);
          return result(hit ? hit.s : 0);
        },
      );
    }

    function addMember(
      clusterId: string,
      id: string,
      title: string,
      hoursAgo: number,
      sourceId: string | null = null,
    ) {
      clusterArticleRows.push({ cluster_id: clusterId, article_id: id });
      fakeArticles[id] = {
        id,
        source_id: sourceId,
        title,
        description: "Detay",
        published_at: iso(hoursAgo),
        fingerprint: `fp-${id}`,
        entities: [],
        category: "politika",
        minhash_sig: null,
        minhash_version: null,
      };
    }

    function addCluster(id: string, articleCount: number) {
      const now = new Date().toISOString();
      clusterRows.push({
        id,
        title_tr: "Küme",
        title_tr_neutral: "Küme",
        first_published: now,
        updated_at: now,
        article_count: articleCount,
      });
    }

    function queueIncoming(
      msgId: number,
      id: string,
      title: string,
      hoursAgo = 0,
      sourceId: string | null = "src-agg",
    ) {
      pgmqState.pending.push({ msg_id: msgId, read_ct: 1, message: { article_id: id } });
      fakeArticles[id] = {
        id,
        source_id: sourceId,
        title,
        description: "Detay haber",
        url: `https://example.com/${id}`,
        category: "politika",
        published_at: iso(hoursAgo),
      };
    }

    async function drain() {
      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(
        authedRequest("http://localhost/cluster-consumer", { method: "POST" }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as { matched: number; created: number; failedTransient: number };
    }

    const linkedClusters = () =>
      supabaseFakeCalls.rpc
        .filter((r) => r.name === "cluster_link_atomic")
        .map((r) => (r.args as { p_cluster_id: string }).p_cluster_id);

    // seed (oldest) / middle / latest (newest). Only the middle headline is
    // about the incoming story.
    const SEED_TITLE = "Sarıgül ailesine kara para soruşturmasında yeni operasyon";
    const MID_TITLE = "Mustafa Sarıgül Yeni Parti'den istifa etti";
    const LATEST_TITLE = "Meclis tatile girdi, yeni dönem ekimde başlayacak";
    const LONG_TITLE =
      "Mustafa Sarıgül Yeni Parti'den istifa etti: Adalet tecelli edecek, partime döneceğim";

    function seedThreeMembers(midHoursAgo: number) {
      addCluster(CL, 3);
      addMember(CL, "hl-seed", SEED_TITLE, midHoursAgo + 2);
      addMember(CL, "hl-mid", MID_TITLE, midHoursAgo);
      addMember(CL, "hl-latest", LATEST_TITLE, Math.max(0.1, midHoursAgo - 0.5));
    }

    it("an article whose headline matches only a middle member (not seed, not latest) within 6 h joins that cluster", async () => {
      seedThreeMembers(1);
      queueIncoming(2001, "art-hl", LONG_TITLE);
      scoreOnly();

      const body = await drain();

      expect(body.matched).toBe(1);
      expect(body.created).toBe(0);
      expect(linkedClusters()).toEqual([CL]);
      // Seed and latest were scored (and scored 0); the middle member was not
      // sent through score() at all -- it joined on the headline scan alone.
      const comparedWith = vi.mocked(scoreMock).mock.calls.map(
        (c) => (c[6] as { bTitle?: string }).bTitle,
      );
      expect(comparedWith).toContain(SEED_TITLE);
      expect(comparedWith).toContain(LATEST_TITLE);
      expect(comparedWith).not.toContain(MID_TITLE);
    });

    it("the same article with the middle member 7 h away creates a new cluster", async () => {
      expect(HEADLINE_LANE_MAX_HOURS).toBe(6);
      seedThreeMembers(7);
      queueIncoming(2002, "art-hl", LONG_TITLE);
      scoreOnly();

      const body = await drain();

      expect(body.matched).toBe(0);
      expect(body.created).toBe(1);
      expect(linkedClusters()).toEqual([]);
      expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
    });

    it("a member exactly at the lane limit still joins, one past it does not", async () => {
      seedThreeMembers(HEADLINE_LANE_MAX_HOURS - 0.05);
      queueIncoming(2003, "art-hl", LONG_TITLE);
      scoreOnly();
      const inside = await drain();
      expect(inside.matched).toBe(1);

      // Fresh world for the second half (module state, fixtures, logs).
      vi.resetModules();
      clusterRows.length = 0;
      clusterArticleRows.length = 0;
      for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
      supabaseFakeCalls.mutations.length = 0;
      supabaseFakeCalls.rpc.length = 0;
      resetPgmqState();
      seedThreeMembers(HEADLINE_LANE_MAX_HOURS + 0.05);
      queueIncoming(2004, "art-hl", LONG_TITLE);
      const outside = await drain();
      expect(outside.matched).toBe(0);
      expect(outside.created).toBe(1);
    });

    it("a member headline that is unrelated never joins (control: no false positive from the scan)", async () => {
      seedThreeMembers(1);
      queueIncoming(2005, "art-hl", "Mustafa Sarıgül Yeni Parti'den istifa edecek mi? Kulis iddiaları");
      scoreOnly();

      const body = await drain();

      expect(body.matched).toBe(0);
      expect(body.created).toBe(1);
    });

    // Size guard (review of wave AB). Every title is source-controlled and
    // stored unshortened, so ONE roundup / keyword-stuffed member headline of a
    // cluster must not attract the unrelated short headlines it happens to
    // contain: before the guard each of them was "contained" in it, scored
    // 0.5-0.7 on the headline lane alone and joined the cluster through this
    // scan, skewing the cluster's bias distribution and 'Kör nokta' flags.
    describe("size guard: a stuffed member headline does not attract unrelated short headlines", () => {
      const BANK = "Merkez Bankası faiz kararını açıkladı";
      const DERBY = "Galatasaray derbide Fenerbahçe'yi üç golle yendi";
      const RAIN = "İstanbul'da sağanak nedeniyle seferler iptal edildi";
      const ROUNDUP = `${BANK}; ${DERBY}; ${RAIN}`;
      // seed and latest share >= 2 title tokens with the incoming headline so
      // the cluster IS a candidate; their score() is stubbed to 0.
      const CASES = [
        {
          name: "central bank rate decision",
          incoming: BANK,
          seed: "Merkez Bankası faiz toplantısı yarın başlıyor",
          latest: "Merkez Bankası başkanı soruları yanıtladı",
          control: `${BANK}: Politika faizi sabit tutuldu`,
        },
        {
          name: "derby result",
          incoming: DERBY,
          seed: "Galatasaray Fenerbahçe maçı öncesi son durum",
          latest: "Galatasaray Fenerbahçe karşılaşması sonrası açıklamalar",
          control: `${DERBY}: Sarı kırmızılılar liderliğe yükseldi`,
        },
        {
          name: "Istanbul rain cancellations",
          incoming: RAIN,
          seed: "İstanbul'da sağanak uyarısı: valilikten açıklama geldi",
          latest: "İstanbul sağanak sonrası hayat normale döndü",
          control: `${RAIN}: Vapur seferleri aksadı`,
        },
      ];

      function seedClusterWith(midTitle: string, seed: string, latest: string) {
        addCluster(CL, 3);
        addMember(CL, "hl-seed", seed, 3);
        addMember(CL, "hl-mid", midTitle, 1);
        addMember(CL, "hl-latest", latest, 0.5);
      }

      it.each(CASES)("$name: the roundup member does not pull the short headline in (created, not matched)", async ({ incoming, seed, latest }) => {
        seedClusterWith(ROUNDUP, seed, latest);
        queueIncoming(2401, "art-short", incoming);
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
        // The roundup was not sent through score() (it is neither seed nor
        // latest): it was reachable only through the scan, which now rejects it.
        const comparedWith = vi.mocked(scoreMock).mock.calls.map(
          (c) => (c[6] as { bTitle?: string }).bTitle,
        );
        expect(comparedWith).toContain(seed);
        expect(comparedWith).toContain(latest);
        expect(comparedWith).not.toContain(ROUNDUP);
      });

      it.each(CASES)("$name: control -- the same cluster with a proportionate long headline as the middle member does join", async ({ incoming, seed, latest, control }) => {
        seedClusterWith(control, seed, latest);
        queueIncoming(2402, "art-short", incoming);
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual([CL]);
      });

      it("a keyword-stuffed member headline (dozens of extra words) attracts nothing", async () => {
        const alphaAt = (i: number) =>
          "w" + [Math.floor(i / 676) % 26, Math.floor(i / 26) % 26, i % 26]
            .map((c) => String.fromCharCode(97 + c))
            .join("");
        const stuffed = `${BANK} ${Array.from({ length: 80 }, (_, i) => alphaAt(i)).join(" ")}`;
        seedClusterWith(stuffed, CASES[0]!.seed, CASES[0]!.latest);
        queueIncoming(2403, "art-short", BANK);
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
      });

      it("a member headline longer than the title cap is clipped, not matched on its tail", async () => {
        // The short headline sits AFTER the 300-character cap, so the member's
        // tokens cannot contain it at all.
        const pad = "x".repeat(HEADLINE_TITLE_MAX_CHARS);
        seedClusterWith(`${pad} ${BANK}`, CASES[0]!.seed, CASES[0]!.latest);
        queueIncoming(2404, "art-short", BANK);
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
      });
    });

    it("joining via a member issues the same number and kind of DB calls as joining via the seed (no new reads)", async () => {
      type Profile = {
        reads: string[];
        mutations: string[];
        rpcs: string[];
        linked: string[];
      };
      async function profileOf(title: string, pairs: Array<{ a: string; b: string; s: number }>): Promise<Profile> {
        vi.resetModules();
        clusterRows.length = 0;
        clusterArticleRows.length = 0;
        stickyClusterRows.length = 0;
        for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
        supabaseFakeCalls.mutations.length = 0;
        supabaseFakeCalls.rpc.length = 0;
        resetPgmqState();
        seedThreeMembers(1);
        queueIncoming(2006, "art-hl", title);
        scoreOnly(pairs);
        const client = supabaseFakeClient as unknown as { from: (t: string) => unknown };
        const spy = vi.spyOn(client, "from");
        try {
          const body = await drain();
          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          return {
            reads: spy.mock.calls.map((c) => String(c[0])),
            mutations: supabaseFakeCalls.mutations.map((m) => `${m.table}:${m.op}`),
            rpcs: supabaseFakeCalls.rpc.map((r) => r.name),
            linked: linkedClusters(),
          };
        } finally {
          spy.mockRestore();
        }
      }

      // Seed join: the (stubbed) scorer prefers the seed, the headline is the seed's.
      const seedTitleLong = `${SEED_TITLE}: gözaltı sayısı yükseldi`;
      const viaSeed = await profileOf(seedTitleLong, [{ a: seedTitleLong, b: SEED_TITLE, s: 0.82 }]);
      // Member join: only the middle headline matches.
      const viaMember = await profileOf(LONG_TITLE, []);

      expect(viaSeed.linked).toEqual([CL]);
      expect(viaMember.linked).toEqual([CL]);
      // Guard against a vacuous comparison.
      expect(viaSeed.reads.length).toBeGreaterThan(3);
      expect(viaSeed.mutations.length).toBeGreaterThan(0);
      expect(viaMember.reads).toEqual(viaSeed.reads);
      expect(viaMember.mutations).toEqual(viaSeed.mutations);
      expect(viaMember.rpcs).toEqual(viaSeed.rpcs);
    });

    describe("headlinesByCluster cap and order", () => {
      const N = HEADLINE_MEMBER_SCAN_MAX + 3;
      // Member k (1 = newest) and its disjoint five-word headline. Two-letter
      // prefixes keep the headlines disjoint beyond the 15 one-letter ones.
      const WORDS = ["kalem", "sepet", "ceylan", "tavan", "bozkurt"];
      const LETTERS = "bcdfghjklmnprst";
      const prefixOf = (k: number) =>
        `${LETTERS[Math.floor((k - 1) / LETTERS.length)]}${LETTERS[(k - 1) % LETTERS.length]}`;
      const titleOf = (k: number) => WORDS.map((w) => `${prefixOf(k)}${w}`).join(" ");
      // 0.5 h .. 5.5 h for 51 members, all inside the 6 h lane window.
      const hoursAgoOf = (k: number) => 0.5 + 0.1 * (k - 1);

      function seedBeyondCapMembers() {
        addCluster(CL, N);
        // Insert in a scrambled order: the cap must follow publication time,
        // not row order.
        const order = [
          ...Array.from({ length: N }, (_, i) => i + 1).filter((k) => k % 2 === 0),
          ...Array.from({ length: N }, (_, i) => i + 1).filter((k) => k % 2 === 1),
        ];
        for (const k of order) addMember(CL, `hl-m${k}`, titleOf(k), hoursAgoOf(k));
      }

      it("fixtures are disjoint five-word headlines", () => {
        // h40-clusters-1: the cap is 48, so the fixtures reach 51 members.
        expect(HEADLINE_MEMBER_SCAN_MAX).toBe(48);
        expect(N).toBe(51);
        const seen = new Set<string>();
        for (let k = 1; k <= N; k++) {
          const t = headlineTokens(titleOf(k)).tokens;
          expect(t.size).toBe(5);
          for (const tok of t) {
            expect(seen.has(tok)).toBe(false);
            seen.add(tok);
          }
        }
      });

      it.each([
        { label: "the second newest member", k: 2, matched: 1 },
        { label: "the 13th newest member (evicted by the old cap of 12)", k: 13, matched: 1 },
        { label: "the 34th newest member", k: 34, matched: 1 },
        { label: "the 48th newest member (the last one kept)", k: HEADLINE_MEMBER_SCAN_MAX, matched: 1 },
        { label: "the 49th newest member (the first one evicted)", k: HEADLINE_MEMBER_SCAN_MAX + 1, matched: 0 },
        { label: "the 50th newest member", k: HEADLINE_MEMBER_SCAN_MAX + 2, matched: 0 },
      ])("an article repeating the headline of $label -> matched=$matched", async ({ k, matched }) => {
        seedBeyondCapMembers();
        queueIncoming(2100 + k, "art-hl", titleOf(k));
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(matched);
        expect(body.created).toBe(1 - matched);
        expect(linkedClusters()).toEqual(matched ? [CL] : []);
      });

      it("the seed (oldest, outside the cap) and the latest (newest) are still compared through score()", async () => {
        seedBeyondCapMembers();
        queueIncoming(2200, "art-hl", titleOf(N));
        scoreOnly([{ a: titleOf(N), b: titleOf(N), s: 0.82 }]);

        const body = await drain();

        // The seed is member N (oldest); it is not in the scan list but score() sees it.
        expect(body.matched).toBe(1);
        expect(linkedClusters()).toEqual([CL]);
        const comparedWith = vi.mocked(scoreMock).mock.calls.map(
          (c) => (c[6] as { bTitle?: string }).bTitle,
        );
        expect(comparedWith).toContain(titleOf(N));
        expect(comparedWith).toContain(titleOf(1));
      });
    });

    // -----------------------------------------------------------------------
    // h40-clusters-1. HEADLINE_MEMBER_SCAN_MAX = 12 dropped the matching member
    // of busy clusters, so a phrase-identical follow-up opened a twin of a top
    // story: cnn-turk 'SON DAKIKA... MHP lideri Bahceli: Teror bitecek ...' was
    // rank 13 of 17 (twin d58cf466, now 8 articles), sozcu rank 17 of 26 (twin
    // 2cce15f0) and 'Emir Sarigul hakkinda yeni karar...' rank 13 of 34 (twin
    // 3a81b524). The 6 h lane window, not the count, bounds the scan; the cap is
    // a memory ceiling (48).
    // -----------------------------------------------------------------------
    describe("h40-clusters-1: the scan reaches the matching member of a busy cluster at any rank inside the 6 h window", () => {
      const GURLEK_MEMBER = "Bakan Gürlek'ten 'fon soruşturması' için çarpıcı açıklama";
      const GURLEK_INCOMING = "Bakan Gürlek'ten fon soruşturması açıklaması";
      const BAHCELI_MEMBER = "SON DAKİKA... MHP lideri Bahçeli: Terör bitecek kardeşlik yükselecek";
      const BAHCELI_INCOMING = "Bahçeli: Terör bitecek, kardeşlik yükselecek";
      const FIRST_H = 0.2; // the newest member is 12 min old
      const STEP_H = 5 / 60; // members arrive 5 minutes apart
      // Unrelated filler headlines: disjoint from both stories and from each other.
      const LETTERS = "bcdfghjklmnprst";
      const fillerTitle = (r: number) => {
        const p = `${LETTERS[Math.floor((r - 1) / LETTERS.length)]}${LETTERS[(r - 1) % LETTERS.length]}`;
        return `${p}kalem ${p}sepet ${p}ceylan`;
      };
      const rankHoursAgo = (r: number) => FIRST_H + (r - 1) * STEP_H;

      type DrainSummary = {
        matched: number;
        created: number;
        failedTransient: number;
        ctx_window_min: number | null;
        created_with_floor_candidate: number;
        created_with_floor_candidate_samples: Array<Record<string, unknown>>;
      };
      const drainSummary = async () => (await drain()) as unknown as DrainSummary;

      // `size` members, newest first, 5 minutes apart. Rank `matchRank`
      // carries `matchTitle`; with `matchHoursAgo` it (and every older member)
      // is moved to that age. Every other member is an unrelated filler.
      function seedBusyCluster(
        clusterId: string,
        size: number,
        matchRank: number,
        matchTitle: string,
        matchSourceId: string,
        matchHoursAgo = rankHoursAgo(matchRank),
      ) {
        addCluster(clusterId, size);
        for (let r = 1; r <= size; r++) {
          const at = r < matchRank ? rankHoursAgo(r) : matchHoursAgo + (r - matchRank) * STEP_H;
          if (r === matchRank) addMember(clusterId, `${clusterId}-m${r}`, matchTitle, at, matchSourceId);
          else addMember(clusterId, `${clusterId}-m${r}`, fillerTitle(r), at, null);
        }
      }

      // How many members of `clusterId` are newer than the one titled `title`.
      function rankOf(clusterId: string, title: string): number {
        const members = Object.values(fakeArticles) as Array<{ id: string; title: string; published_at: string }>;
        const inCluster = members.filter((a) =>
          clusterArticleRows.some((r) => r.cluster_id === clusterId && r.article_id === a.id),
        );
        const target = inCluster.find((a) => a.title === title);
        if (!target) throw new Error(`no member titled ${title}`);
        return 1 + inCluster.filter((a) => Date.parse(a.published_at) > Date.parse(target.published_at)).length;
      }

      it("fixtures: the real headline lane fires for both phrase-identical pairs, and neither filler shares a token with them", () => {
        for (const [incoming, member] of [
          [GURLEK_INCOMING, GURLEK_MEMBER],
          [BAHCELI_INCOMING, BAHCELI_MEMBER],
        ] as const) {
          const lane = headlineLane(headlineTokens(incoming), headlineTokens(member), 1.5);
          expect(lane.fired).toBe(true);
        }
        const story = new Set([
          ...headlineTokens(GURLEK_MEMBER).tokens,
          ...headlineTokens(BAHCELI_MEMBER).tokens,
        ]);
        for (let r = 1; r <= 49; r++) {
          const tokens = headlineTokens(fillerTitle(r)).tokens;
          expect(tokens.size).toBe(3);
          for (const t of tokens) expect(story.has(t)).toBe(false);
        }
        // An identical filler headline is a lane hit (the truncation test relies on it).
        expect(headlineLane(headlineTokens(fillerTitle(47)), headlineTokens(fillerTitle(47)), 0.5).fired).toBe(true);
      });

      it("Gürlek: a 30-member cluster whose 18th-newest member is the phrase-identical headline -> the follow-up joins it", async () => {
        seedBusyCluster(CL, 30, 18, GURLEK_MEMBER, "src-posta");
        expect(rankOf(CL, GURLEK_MEMBER)).toBe(18);
        expect(rankOf(CL, GURLEK_MEMBER)).toBeGreaterThan(12);
        queueIncoming(3101, "art-gurlek", GURLEK_INCOMING, 0, "src-outlet");
        scoreOnly();

        const body = await drainSummary();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual([CL]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
      });

      it("Bahçeli: a 17-member cluster whose 13th-newest member is the cnn-turk 'SON DAKİKA...' headline -> the haber-com follow-up joins it", async () => {
        seedBusyCluster(CL, 17, 13, BAHCELI_MEMBER, "src-cnn-turk");
        expect(rankOf(CL, BAHCELI_MEMBER)).toBe(13);
        queueIncoming(3102, "art-bahceli", BAHCELI_INCOMING, 0, "src-agg");
        scoreOnly();

        const body = await drainSummary();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual([CL]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
      });

      it("the same member just inside the 6 h lane window (5.9 h before the article) still joins", async () => {
        seedBusyCluster(CL, 30, 18, GURLEK_MEMBER, "src-posta", HEADLINE_LANE_MAX_HOURS - 0.1);
        queueIncoming(3103, "art-gurlek", GURLEK_INCOMING, 0, "src-outlet");
        scoreOnly();

        const body = await drainSummary();

        expect(body.matched).toBe(1);
        expect(linkedClusters()).toEqual([CL]);
      });

      it("negative control: the same member published 7 h before the article gives no join (the 6 h window still bounds the scan)", async () => {
        expect(HEADLINE_LANE_MAX_HOURS).toBe(6);
        seedBusyCluster(CL, 30, 18, GURLEK_MEMBER, "src-posta", 7);
        expect(rankOf(CL, GURLEK_MEMBER)).toBe(18);
        queueIncoming(3104, "art-gurlek", GURLEK_INCOMING, 0, "src-outlet");
        scoreOnly();

        const body = await drainSummary();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
      });

      it("the window bounds the work, not only the result: a 30-member cluster with 13 members older than 6 h costs 16 lane evaluations (ranks 2..17), not 28", async () => {
        // Rank 1 is the latest and rank 30 the seed: both go through score(),
        // not the scan. Ranks 18..30 are 7-8 h old and must never be evaluated.
        seedBusyCluster(CL, 30, 18, GURLEK_MEMBER, "src-posta", 7);
        queueIncoming(3109, "art-gurlek", GURLEK_INCOMING, 0, "src-outlet");
        scoreOnly();

        await drainSummary();

        expect(vi.mocked(headlineOnlyScoreMock)).toHaveBeenCalledTimes(16);
      });

      it("the count caps the work: a 51-member cluster, all inside the window, costs HEADLINE_MEMBER_SCAN_MAX - 1 evaluations (the latest is skipped, the seed is past the cap)", async () => {
        // The seed (rank 51, the Gürlek headline) is outside the 48 newest: only
        // score() compares with it, so this article cannot join.
        seedBusyCluster(CL, 51, 51, GURLEK_MEMBER, "src-posta");
        expect(rankHoursAgo(51)).toBeLessThan(HEADLINE_LANE_MAX_HOURS);
        queueIncoming(3110, "art-gurlek", GURLEK_INCOMING, 0, "src-outlet");
        scoreOnly();

        const body = await drainSummary();

        expect(vi.mocked(headlineOnlyScoreMock)).toHaveBeenCalledTimes(HEADLINE_MEMBER_SCAN_MAX - 1);
        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
      });

      it("a cluster loaded by the stem probe keeps the same reach (loadProbeCluster reads the same cap): rank 18 of 30 joins", async () => {
        const PROBE = "cl-probe";
        // Not among the context fixtures; only the probe rpc knows it.
        for (let r = 1; r <= 30; r++) {
          const at = rankHoursAgo(r);
          if (r === 18) addMember(PROBE, `${PROBE}-m${r}`, GURLEK_MEMBER, at, "src-posta");
          else addMember(PROBE, `${PROBE}-m${r}`, fillerTitle(r), at, null);
        }
        expect(rankOf(PROBE, GURLEK_MEMBER)).toBe(18);
        rpcFixtures.cluster_stem_probe = () => ({
          data: [
            {
              id: PROBE,
              title_tr: "Küme",
              title_tr_neutral: null,
              first_published: iso(rankHoursAgo(30)),
              updated_at: iso(rankHoursAgo(1)),
              article_count: 30,
            },
          ],
          error: null,
        });
        queueIncoming(3106, "art-gurlek", GURLEK_INCOMING, 0, "src-outlet");
        scoreOnly();

        const body = await drainSummary();

        // Premise: nothing in the context, so the probe path produced the join.
        expect(supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_stem_probe")).toHaveLength(1);
        expect(clusterArticleEqReads).toContain(PROBE);
        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual([PROBE]);
      });

      it("insertHeadlineMember truncates at the constant: after a join the 47th-newest old member is still scanned, the 48th-newest is dropped", async () => {
        // 49 members (the seed is the oldest). The context keeps the newest 48.
        // Article X joins through the stubbed full scorer and becomes the newest
        // entry, so the list is cut back to 48 by dropping the OLDEST kept one
        // (old rank 48). Z, next, repeats old rank 48's headline: gone, so Z
        // opens its own cluster. Y repeats old rank 47's headline: still scanned,
        // joins. (Z goes before Y: Y's own insertion would cut the list again.)
        addCluster(CL, 49);
        // 3 minutes apart: rank 49 (the seed) is 3.0 h old, every rank inside the 6 h window.
        for (let r = 1; r <= 49; r++) addMember(CL, `ins-${r}`, fillerTitle(r), 0.6 + (r - 1) * 0.05, null);
        // X shares its tokens with the latest member, which makes the cluster a candidate.
        const X = `${fillerTitle(1)} detayları`;
        queueIncoming(3107, "art-x", X, 0.5, "src-outlet");
        queueIncoming(3108, "art-z", fillerTitle(48), 0.1, "src-wire");
        queueIncoming(3109, "art-y", fillerTitle(47), 0.05, "src-agg");
        // X joins on the latest (old rank 1) by the stubbed score; every other pair scores 0.
        scoreOnly([{ a: X, b: fillerTitle(1), s: 0.82 }]);

        const body = await drainSummary();

        expect(body.matched).toBe(2);
        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([CL, CL]);
      });

      describe("drain summary diagnostics", () => {
        const SEED = "Sarıgül ailesine kara para soruşturmasında yeni operasyon";
        const LATEST = "Meclis tatile girdi, yeni dönem ekimde başlayacak";

        function seedFloorCandidateCluster() {
          addCluster(CL, 2);
          addMember(CL, "dg-seed", SEED, 3);
          addMember(CL, "dg-latest", LATEST, 2);
        }
        // Every full-scorer pair scores 0.38: inside [FALLBACK_FLOOR 0.36, MATCH_THRESHOLD 0.40).
        const scoreEverythingAt = (s: number) =>
          vi.mocked(scoreMock).mockImplementation(() => result(s));

        it("an article created although its best candidate scored >= FALLBACK_FLOOR counts once and leaves one id-and-number sample", async () => {
          seedFloorCandidateCluster();
          const incoming = `${SEED} haberi`;
          queueIncoming(3201, "art-floor", incoming, 0, "src-outlet");
          scoreEverythingAt(0.38);

          const body = await drainSummary();

          expect(body.matched).toBe(0);
          expect(body.created).toBe(1);
          expect(body.created_with_floor_candidate).toBe(1);
          expect(body.created_with_floor_candidate_samples).toEqual([
            { article_id: "art-floor", top_cluster_id: CL, top_score: 0.38 },
          ]);
        });

        it("samples carry ids and numbers only: no title and no url anywhere in the summary body", async () => {
          seedFloorCandidateCluster();
          const incoming = `${SEED} haberi`;
          queueIncoming(3202, "art-floor", incoming, 0, "src-outlet");
          scoreEverythingAt(0.38);

          const body = await drainSummary();

          const [sample] = body.created_with_floor_candidate_samples;
          expect(Object.keys(sample ?? {}).sort()).toEqual(["article_id", "top_cluster_id", "top_score"]);
          expect(typeof sample?.article_id).toBe("string");
          expect(typeof sample?.top_cluster_id).toBe("string");
          expect(typeof sample?.top_score).toBe("number");
          const raw = JSON.stringify(body);
          expect(raw).not.toContain(incoming);
          expect(raw).not.toContain(SEED);
          expect(raw).not.toContain("example.com");
        });

        it("an article that opens a cluster with no candidate at all does not count", async () => {
          queueIncoming(3203, "art-lonely", "Tamamen alakasız bir başlık: sepet kalem ceylan", 0, "src-outlet");

          const body = await drainSummary();

          expect(body.created).toBe(1);
          expect(body.created_with_floor_candidate).toBe(0);
          expect(body.created_with_floor_candidate_samples).toEqual([]);
        });

        it("an article that joins its candidate does not count", async () => {
          seedFloorCandidateCluster();
          queueIncoming(3204, "art-joins", `${SEED} haberi`, 0, "src-outlet");
          // default score 0.82 (a match)

          const body = await drainSummary();

          expect(body.matched).toBe(1);
          expect(body.created_with_floor_candidate).toBe(0);
          expect(body.created_with_floor_candidate_samples).toEqual([]);
        });

        it("a candidate just below FALLBACK_FLOOR (0.35) does not count", async () => {
          seedFloorCandidateCluster();
          queueIncoming(3205, "art-below", `${SEED} haberi`, 0, "src-outlet");
          scoreEverythingAt(0.35);

          const body = await drainSummary();

          expect(body.created).toBe(1);
          expect(body.created_with_floor_candidate).toBe(0);
          expect(body.created_with_floor_candidate_samples).toEqual([]);
        });

        it("a candidate at FALLBACK_FLOOR (0.36) counts", async () => {
          seedFloorCandidateCluster();
          queueIncoming(3206, "art-at", `${SEED} haberi`, 0, "src-outlet");
          scoreEverythingAt(0.4 * 0.9 + 0.001);

          const body = await drainSummary();

          expect(body.created).toBe(1);
          expect(body.created_with_floor_candidate).toBe(1);
        });

        it("the counter is exact but the samples stop at three", async () => {
          seedFloorCandidateCluster();
          // Distinct tails and sources: the strict-fingerprint fast path and the
          // same-source duplicate skip must not swallow any of them.
          const tails = ["ankara", "izmir", "bursa", "adana", "konya"];
          const sources = ["src-outlet", "src-agg", "src-wire", "src-posta", "src-cnn-turk"];
          for (let i = 1; i <= 5; i++) {
            queueIncoming(3210 + i, `art-many-${i}`, `${SEED} haberi ${tails[i - 1]}`, 0, sources[i - 1]);
          }
          scoreEverythingAt(0.38);

          const body = await drainSummary();

          expect(body.created).toBe(5);
          expect(body.created_with_floor_candidate).toBe(5);
          expect(body.created_with_floor_candidate_samples).toHaveLength(3);
          expect(body.created_with_floor_candidate_samples.map((s) => s.article_id)).toEqual([
            "art-many-1",
            "art-many-2",
            "art-many-3",
          ]);
        });

        it("ctx_window_min is the age of the oldest updated_at among the newest-rows window, as a finite number of minutes", async () => {
          seedFloorCandidateCluster();
          // Two more rows; the oldest of the three is 90 minutes old.
          const row = (id: string, minutesAgo: number) => ({
            id,
            title_tr: "Küme",
            title_tr_neutral: "Küme",
            first_published: iso(minutesAgo / 60),
            updated_at: iso(minutesAgo / 60),
            article_count: 1,
          });
          clusterRows.push(row("cl-recent", 10), row("cl-oldest", 90));
          addMember("cl-recent", "wm-1", "Maliye bakanı bütçe sunumu yaptı", 0.2);
          addMember("cl-oldest", "wm-2", "Dışişleri bakanlığı basın toplantısı düzenledi", 1.5);

          const body = await drainSummary();

          expect(typeof body.ctx_window_min).toBe("number");
          expect(Number.isFinite(body.ctx_window_min)).toBe(true);
          expect(body.ctx_window_min).toBeGreaterThanOrEqual(89);
          expect(body.ctx_window_min).toBeLessThanOrEqual(91);
        });

        it("sticky-tail clusters are not part of the window: 200 newest rows ~90 min old plus an 8 h sticky row -> about 90, not 480", async () => {
          for (let i = 0; i < 200; i++) {
            const minutesAgo = 5 + (i * 85) / 199; // 5 .. 90 minutes
            clusterRows.push({
              id: `cl-w${i}`,
              title_tr: "Küme",
              title_tr_neutral: "Küme",
              first_published: iso(minutesAgo / 60),
              updated_at: iso(minutesAgo / 60),
              article_count: 1,
            });
          }
          stickyClusterRows.push({
            id: "cl-sticky",
            title_tr: "Eski büyük hikaye",
            title_tr_neutral: "Eski büyük hikaye",
            first_published: iso(9),
            updated_at: iso(8),
            article_count: 6,
            is_archived: false,
            merged_into: null,
          });

          const body = await drainSummary();

          // Premise: the sticky query really ran.
          expect(clusterQueries.some((q) => (q as { lt?: Array<{ col: string }> }).lt?.some((p) => p.col === "updated_at"))).toBe(true);
          expect(body.ctx_window_min).toBeGreaterThanOrEqual(89);
          expect(body.ctx_window_min).toBeLessThanOrEqual(91);
        });

        it("an empty context has no window: ctx_window_min is null, not 0 and not NaN", async () => {
          const body = await drainSummary();

          expect(body.ctx_window_min).toBeNull();
          expect(body.created_with_floor_candidate).toBe(0);
          expect(body.created_with_floor_candidate_samples).toEqual([]);
        });
      });
    });

    it("a member that joined earlier in the same drain is scanned by the next article (addMemberToIndices)", async () => {
      addCluster(CL, 2);
      addMember(CL, "hl-seed", SEED_TITLE, 5);
      addMember(CL, "hl-latest", LATEST_TITLE, 4);
      const FIRST = "Mustafa Sarıgül Yeni Parti'den istifa etti";
      // First article joins on the stubbed seed score; the second one matches
      // only the first article's headline, which is neither the cached seed
      // nor the cached latest.
      queueIncoming(2301, "art-first", FIRST, 0.5, "src-outlet");
      queueIncoming(2302, "art-second", LONG_TITLE, 0.1, "src-agg");
      scoreOnly([{ a: FIRST, b: SEED_TITLE, s: 0.82 }]);

      const body = await drain();

      expect(body.matched).toBe(2);
      expect(body.created).toBe(0);
      expect(linkedClusters()).toEqual([CL, CL]);
    });

    it("a cluster created earlier in the same drain accepts a later member, and that member is then scanned (registerNewClusterInCache + addMemberToIndices)", async () => {
      const A1 = "Mustafa Sarıgül'ün eski eşi ve oğulları tutuklandı";
      const A2 = "Mustafa Sarıgül Yeni Parti'den istifa etti";
      const A3 = LONG_TITLE;
      queueIncoming(2401, "art-a1", A1, 0.6, "src-outlet");
      queueIncoming(2402, "art-a2", A2, 0.3, "src-agg");
      queueIncoming(2403, "art-a3", A3, 0.0, "src-wire");
      // A2 joins A1's fresh cluster via the stubbed scorer; A3 matches only A2.
      scoreOnly([{ a: A2, b: A1, s: 0.82 }]);

      const body = await drain();

      expect(body.created).toBe(1);
      expect(body.matched).toBe(2);
      const linked = linkedClusters();
      expect(linked).toHaveLength(2);
      expect(linked[0]).toBeTruthy();
      expect(linked[1]).toBe(linked[0]);
    });

    // h70-mergequality-3: cluster 6e585787 (AK Parti Sozcusu Celik) took
    // anadolu-ajansi "Cumhurbaskani Erdogan, Karabag Zaferi'nin 6. yilini kutladi"
    // through the headline lane of the member scan: aksam's comma-less member title
    // is neither seed nor latest, so only the scan saw it, and the subject veto
    // (comma on both sides) cannot see it. The scan now passes both titles.
    describe("actor mismatch: a member headline naming another actor does not attract the article (h70-mergequality-3)", () => {
      const AA_TITLE = "Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";
      const AKSAM_TITLE = "AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı";
      const KARABAG_SEED = "Karabağ Zaferi'nin yıl dönümünde Bakü'de tören düzenlendi";
      const KARABAG_LATEST = "Azerbaycan'da Karabağ Zaferi kutlamaları sürüyor";

      function seedKarabag(midTitle: string) {
        addCluster(CL, 3);
        addMember(CL, "hl-seed", KARABAG_SEED, 3);
        addMember(CL, "hl-mid", midTitle, 2);
        addMember(CL, "hl-latest", KARABAG_LATEST, 1);
      }

      it("premise: the aksam-like headline matches the article on the headline lane alone", () => {
        const lane = headlineLane(headlineTokens(AA_TITLE), headlineTokens(AKSAM_TITLE), 2);
        expect(lane.fired).toBe(true);
      });

      it("a cluster whose scan list holds the aksam headline (not seed, not latest) gets no score from it: the article opens its own cluster", async () => {
        seedKarabag(AKSAM_TITLE);
        queueIncoming(2901, "art-aa", AA_TITLE, 0, "src-wire");
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
        // The aksam headline was reached only by the scan (it is neither seed nor latest) ...
        const comparedWith = vi.mocked(scoreMock).mock.calls.map(
          (c) => (c[6] as { bTitle?: string }).bTitle,
        );
        expect(comparedWith).not.toContain(AKSAM_TITLE);
        // ... which handed both titles to headlineOnlyScore, and got 0 back.
        const calls = vi.mocked(headlineOnlyScoreMock).mock.calls;
        const at = calls.findIndex((c) => (c[3] as { bTitle?: string } | undefined)?.bTitle === AKSAM_TITLE);
        expect(at).toBeGreaterThanOrEqual(0);
        expect(calls[at]![3]).toMatchObject({ aTitle: AA_TITLE, bTitle: AKSAM_TITLE });
        expect(vi.mocked(headlineOnlyScoreMock).mock.results[at]!.value).toBe(0);
      });

      it("control: the same cluster with a same-actor member headline in the middle does take the article", async () => {
        seedKarabag("Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı");
        queueIncoming(2902, "art-aa", AA_TITLE, 0, "src-wire");
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual([CL]);
      });

      it("an actor-mismatched member does not hide a same-actor one in the same cluster", async () => {
        addCluster(CL, 4);
        addMember(CL, "hl-seed", KARABAG_SEED, 3.5);
        addMember(CL, "hl-mid1", AKSAM_TITLE, 2.5);
        addMember(CL, "hl-mid2", "Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı", 2);
        addMember(CL, "hl-latest", KARABAG_LATEST, 1);
        queueIncoming(2903, "art-aa", AA_TITLE, 0, "src-wire");
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(linkedClusters()).toEqual([CL]);
      });
    });
  });

  // -------------------------------------------------------------------------
  // Migration 089 ("ADMIT"): politics admission for the clusterer. Ships
  // with the flag off, so most of this describe block asserts the OFF case
  // changes nothing, then exercises shadow (dry-run, write-free) and live
  // (stamped vs. unstamped) routing.
  // -------------------------------------------------------------------------
  describe("politics admission (migration 089)", () => {
    const now = new Date().toISOString();

    function seedAdmitMessage(articleId: string, admit: "shadow" | "live") {
      pgmqState.pending = [
        { msg_id: 900, read_ct: 1, message: { article_id: articleId, admit } },
      ];
    }

    it("flag unset: zero claim RPCs, and an admit-tagged non-politika message is archived+recorded 'disabled' with no cluster writes", async () => {
      fakeArticles["art-admit-off"] = {
        id: "art-admit-off",
        source_id: "src-outlet",
        title: "Ekonomi haberi",
        description: "Detay",
        url: "https://example.com/admit-off",
        category: "ekonomi",
        published_at: now,
      };
      seedAdmitMessage("art-admit-off", "shadow");

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { admission: { mode: string; claim: string; disabled: number } };
      expect(body.admission.mode).toBe("off");
      expect(body.admission.claim).toBe("skipped");
      expect(body.admission.disabled).toBe(1);

      const claimCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_claim");
      expect(claimCalls.length).toBe(0);
      const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
      expect(linkCalls.length).toBe(0);
      expect(supabaseFakeCalls.insert("clusters").length).toBe(0);
      const recordCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_record");
      expect(recordCalls.length).toBe(1);
      expect((recordCalls[0].args as { p_outcome?: string }).p_outcome).toBe("disabled");
      expect(pgmqState.archived).toContain(900);
    });

    it("shadow: claims once per drain before the first readBatch, dry-runs write-free, and records would_match/would_create", async () => {
      process.env.JEV_POLITICS_ADMISSION = "shadow";
      fakeArticles["art-admit-shadow"] = {
        id: "art-admit-shadow",
        source_id: "src-outlet",
        title: "Ekonomi haberi 2",
        description: "Detay",
        url: "https://example.com/admit-shadow",
        category: "ekonomi",
        published_at: now,
      };
      seedAdmitMessage("art-admit-shadow", "shadow");

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        admission: { mode: string; claim: string; would_match: number; would_create: number };
      };
      expect(body.admission.mode).toBe("shadow");
      expect(body.admission.claim).toBe("ok");
      expect(body.admission.would_match + body.admission.would_create).toBe(1);
      // Dry-run outcomes never touch the classic matched/created counters.
      expect(body.matched).toBe(0);
      expect(body.created).toBe(0);

      const claimCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_claim");
      expect(claimCalls.length).toBe(1);
      const linkCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
      expect(linkCalls.length).toBe(0);
      expect(supabaseFakeCalls.insert("clusters").length).toBe(0);
      expect(supabaseFakeCalls.insert("cluster_articles").length).toBe(0);

      const recordCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_record");
      expect(recordCalls.length).toBe(1);
      const recordArgs = recordCalls[0].args as {
        p_outcome?: string;
        p_cluster_seeded_by_admission?: boolean;
      };
      expect(["would_match", "would_create"]).toContain(recordArgs.p_outcome);
      expect(recordArgs.p_cluster_seeded_by_admission).toBe(false);
    });

    it("shadow: JEV_LIVE_PAIRS=1 never triggers a Jev gateway fetch on a dry-run", async () => {
      process.env.JEV_POLITICS_ADMISSION = "shadow";
      process.env.JEV_LIVE_PAIRS = "1";
      process.env.AI_GATEWAY_API_KEY = "test-key";
      fakeArticles["art-admit-shadow-live"] = {
        id: "art-admit-shadow-live",
        source_id: "src-outlet",
        title: "Ekonomi haberi 3",
        description: "Detay",
        url: "https://example.com/admit-shadow-live",
        category: "ekonomi",
        published_at: now,
      };
      seedAdmitMessage("art-admit-shadow-live", "shadow");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      expect(res.status).toBe(200);
      expect(fetchMock).not.toHaveBeenCalled();

      delete process.env.JEV_LIVE_PAIRS;
      delete process.env.AI_GATEWAY_API_KEY;
    });

    it("live: a stamped article is clustered and recorded; an unstamped one is recorded 'rejected'", async () => {
      process.env.JEV_POLITICS_ADMISSION = "live";
      fakeArticles["art-admit-live-stamped"] = {
        id: "art-admit-live-stamped",
        source_id: "src-outlet",
        title: "Ekonomi haberi 4",
        description: "Detay",
        url: "https://example.com/admit-live-stamped",
        category: "ekonomi",
        politics_admitted_at: now,
        published_at: now,
      };
      seedAdmitMessage("art-admit-live-stamped", "live");

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        matched: number;
        created: number;
        admission: { rejected: number; matched: number; created: number };
      };
      expect(body.matched + body.created).toBe(1);
      expect(body.admission.matched + body.admission.created).toBe(1);

      const recordCalls = supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_record");
      expect(recordCalls.length).toBe(1);
      expect(["matched", "created"]).toContain(
        (recordCalls[0].args as { p_outcome?: string }).p_outcome,
      );

      // Second drain: an unstamped article claims the "live" tag but never
      // got politics_admitted_at set -- rejected, not clustered.
      supabaseFakeCalls.rpc.length = 0;
      fakeArticles["art-admit-live-unstamped"] = {
        id: "art-admit-live-unstamped",
        source_id: "src-outlet",
        title: "Ekonomi haberi 5",
        description: "Detay",
        url: "https://example.com/admit-live-unstamped",
        category: "ekonomi",
        politics_admitted_at: null,
        published_at: now,
      };
      seedAdmitMessage("art-admit-live-unstamped", "live");

      const res2 = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      const body2 = (await res2.json()) as { admission: { rejected: number } };
      expect(body2.admission.rejected).toBe(1);
      const recordCalls2 = supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_record");
      expect(recordCalls2.length).toBe(1);
      expect((recordCalls2[0].args as { p_outcome?: string }).p_outcome).toBe("rejected");
    });

    it("a claim error is non-fatal (logs only the code) and the drain proceeds", async () => {
      process.env.JEV_POLITICS_ADMISSION = "shadow";
      rpcFixtures.jev_politics_admission_claim = { data: null, error: { message: "boom", code: "42P01" } };
      const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { admission: { claim: string } };
      expect(body.admission.claim).toBe("error");

      const warnedAdmission = warnSpy.mock.calls.some(
        (c) => c[0] === "[cluster-consumer] admission claim failed",
      );
      expect(warnedAdmission).toBe(true);
      warnSpy.mockRestore();
    });

    it("a record error still archives the message and counts record_errors, not failedTransient", async () => {
      process.env.JEV_POLITICS_ADMISSION = "shadow";
      rpcFixtures.jev_politics_admission_record = {
        data: null,
        error: { message: "boom", code: "23503" },
      };
      fakeArticles["art-admit-recerr"] = {
        id: "art-admit-recerr",
        source_id: "src-outlet",
        title: "Ekonomi haberi 6",
        description: "Detay",
        url: "https://example.com/admit-recerr",
        category: "ekonomi",
        published_at: now,
      };
      seedAdmitMessage("art-admit-recerr", "shadow");

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      const body = (await res.json()) as {
        failedTransient: number;
        admission: { record_errors: number };
      };
      expect(body.admission.record_errors).toBe(1);
      expect(body.failedTransient).toBe(0);
      expect(pgmqState.archived).toContain(900);
    });

    it("loader select includes politics_admitted_at, and a cluster seeded only by an admitted member loads as a seed", async () => {
      clusterRows.push({
        id: "cluster-admitted-seed",
        title_tr: "Admitted seed",
        title_tr_neutral: null,
        first_published: now,
        updated_at: now,
        article_count: 1,
      });
      clusterArticleRows.push({ cluster_id: "cluster-admitted-seed", article_id: "art-admitted-member" });
      fakeArticles["art-admitted-member"] = {
        id: "art-admitted-member",
        source_id: "src-outlet",
        title: "Admitted member headline",
        description: null,
        published_at: now,
        category: "ekonomi",
        politics_admitted_at: now,
      };
      fakeArticles["art-non-admitted-member"] = {
        id: "art-non-admitted-member",
        source_id: "src-wire",
        title: "Never admitted",
        description: null,
        published_at: now,
        category: "ekonomi",
        politics_admitted_at: null,
      };

      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      await handler(authedRequest("http://localhost/cluster-consumer", { method: "GET" }));
      // GET is a liveness probe only -- exercise a POST with an empty queue
      // so loadClusterContext actually runs and we can assert on its
      // selectArgs without needing a full cluster match.
      pgmqState.pending = [];
      await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));

      const articleSelects = supabaseFakeCalls.mutations; // not used, kept for symmetry
      void articleSelects;
      const src = readFileSync(
        resolve(__dirname, "../../supabase/functions/cluster-consumer/index.ts"),
        "utf8",
      );
      expect(src).toMatch(/politics_admitted_at/);
    });

    it("regression: a plain politika message is byte-identical (mutations + rpc log) across off/shadow/live", async () => {
      const runOnce = async (mode: string | undefined) => {
        // Each run is a cold start of its own: a warm isolate would still hold
        // the cluster the previous run created, and since hunt 12 the same
        // article re-delivered to its own source's cluster is skipped (it used
        // to open a twin), which would make the runs differ for a reason that
        // has nothing to do with the admission mode.
        vi.resetModules();
        clusterRows.length = 0;
        clusterArticleRows.length = 0;
        resetPgmqState();
        for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
        supabaseFakeCalls.mutations.length = 0;
        supabaseFakeCalls.rpc.length = 0;
        if (mode) process.env.JEV_POLITICS_ADMISSION = mode;
        else delete process.env.JEV_POLITICS_ADMISSION;

        fakeArticles["art-plain-politika"] = {
          id: "art-plain-politika",
          source_id: "src-outlet",
          title: "Siyaset haberi",
          description: "Detay",
          url: "https://example.com/plain-politika",
          category: "politika",
          published_at: now,
        };
        pgmqState.pending = [{ msg_id: 901, read_ct: 1, message: { article_id: "art-plain-politika" } }];

        const handler = await importHandler();
        if (!handler) throw new Error("unreachable");
        const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
        const body = (await res.json()) as { matched: number; created: number };
        return {
          status: res.status,
          matched: body.matched,
          created: body.created,
          mutationCount: supabaseFakeCalls.mutations.length,
          linkCalls: supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic").length,
          recordCalls: supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_record").length,
        };
      };

      const off = await runOnce(undefined);
      const shadow = await runOnce("shadow");
      const live = await runOnce("live");

      expect(shadow).toEqual(off);
      expect(live).toEqual(off);
      expect(off.recordCalls).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Hunt 12 (2026-11-01).
  //
  // h12-cluster-1: twin clusters. (a) The best match is a cluster that already
  // holds the incoming article's source (duplicate-source): the fallback loop
  // used to run dry and createCluster opened a twin -- Antalya-Alanya otoyolu,
  // 8ab93bbd (18 articles) next to 2c9941bd (7). (b) The best match is a
  // singleton outside the 200-cluster context -- Yusra Geyik, posta 53d92ca1 at
  // 06:00 and cnn-turk 217069e3 at 09:42, 269 clusters updated in between. The
  // consumer now skips a same-source duplicate instead of opening a twin,
  // prefers the larger of two near-equal matches, and asks the database for the
  // live clusters whose folded seed title equals the incoming title
  // (rpc cluster_title_probe, migration 135).
  //
  // h12-cluster-5: milliyet descriptions end with a "Son dakika..." ticker of
  // an unrelated story; entities, fingerprint and tf-idf are now built from the
  // cleaned description (the stored description and rss/normalize.ts are not
  // touched).
  // -------------------------------------------------------------------------
  describe("twin clusters + Son dakika ticker (hunt 12: h12-cluster-1, h12-cluster-5)", () => {
    const H = 3_600_000;
    const HEADLINE = "Antalya'dan Alanya'ya ulaşım 36 dakikaya inecek, yıllık tasarruf 23,9 milyar lira";
    const YUSRA = "Yüsra Geyik takside beklerken, Nehir Erdoğan arka kapıdan kaçtı";
    const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

    const defaultScoreImpl = () => ({
      score: 0.82,
      components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
      isMatch: true,
    });

    type Fake = { score: number; components: Record<string, unknown>; isMatch: boolean };
    const result = (s: number): Fake => ({
      score: s,
      components: { cosine: 0.1, entityJaccard: 0, fingerprintMatch: false },
      isMatch: s >= 0.4,
    });
    /** Score by the fingerprint of the cluster side of the pair; everything else scores 0. */
    function scoreBy(byFp: Record<string, number>) {
      vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown) => {
        const strict = (b as { strict?: string | null } | null | undefined)?.strict ?? null;
        const s = strict !== null ? byFp[strict] : undefined;
        return result(s ?? 0);
      });
    }

    let logSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });
    afterEach(() => {
      logSpy.mockRestore();
      warnSpy.mockRestore();
      vi.mocked(scoreMock).mockImplementation(defaultScoreImpl);
    });

    interface SeedMember {
      id: string;
      sourceId: string;
      fp: string;
      ageMs?: number;
      title?: string;
      description?: string;
      category?: string;
    }
    /** A cluster row plus its members, in the context fixtures (clusters, cluster_articles, articles). */
    function seedCluster(
      id: string,
      articleCount: number,
      members: SeedMember[],
      opts: { title?: string; updatedAgoMs?: number; inContext?: boolean } = {},
    ) {
      const updated = ago(opts.updatedAgoMs ?? 60_000);
      const title = opts.title ?? HEADLINE;
      if (opts.inContext !== false) {
        clusterRows.push({
          id,
          title_tr: title,
          title_tr_neutral: title,
          first_published: updated,
          updated_at: updated,
          article_count: articleCount,
        });
      }
      for (const m of members) {
        clusterArticleRows.push({ cluster_id: id, article_id: m.id });
        fakeArticles[m.id] = {
          id: m.id,
          source_id: m.sourceId,
          title: m.title ?? title,
          description: m.description ?? "Detay",
          published_at: ago(m.ageMs ?? 30 * 60_000),
          fingerprint: m.fp,
          entities: [],
          category: m.category ?? "politika",
          minhash_sig: null,
          minhash_version: null,
        };
      }
    }

    function queueIncoming(opts: {
      id?: string;
      msgId?: number;
      sourceId: string;
      title?: string;
      description?: string;
      category?: string;
      admit?: "shadow" | "live";
    }) {
      const id = opts.id ?? "art-twin";
      const message: { article_id: string; admit?: string } = { article_id: id };
      if (opts.admit) message.admit = opts.admit;
      (pgmqState.pending as unknown as Array<{ msg_id: number; read_ct: number; message: unknown }>).push({
        msg_id: opts.msgId ?? 4000 + pgmqState.pending.length,
        read_ct: 1,
        message,
      });
      fakeArticles[id] = {
        id,
        source_id: opts.sourceId,
        title: opts.title ?? HEADLINE,
        description: opts.description ?? "Detay",
        url: `https://example.com/${id}`,
        category: opts.category ?? "politika",
        published_at: new Date().toISOString(),
      };
      return id;
    }

    interface DrainBody {
      matched: number;
      created: number;
      skipped: number;
      failedTransient: number;
      descriptionSwapSuspects: number;
      descriptionSwapSamples: string[];
      // h45-clusters-1: articles whose same-source follow-up evidence was only logged (shadow).
      sameSourceUpdateShadow: number;
      admission: { would_create: number; would_match: number };
      // h70-mergequality-2: candidates the centroid guard passed over in live drains.
      centroidSkips: { count: number; samples: Array<{ clusterId: string; cos: number }> };
    }
    async function drain(): Promise<DrainBody> {
      const handler = await importHandler();
      if (!handler) throw new Error("unreachable");
      const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
      expect(res.status).toBe(200);
      return (await res.json()) as DrainBody;
    }

    const linkedClusters = () =>
      supabaseFakeCalls.rpc
        .filter((r) => r.name === "cluster_link_atomic")
        .map((r) => (r.args as { p_cluster_id: string }).p_cluster_id);
    const probeCalls = () => supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_title_probe");
    const probeWarnings = () =>
      warnSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("cluster_title_probe"));
    const skipLogs = () =>
      logSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("same-source-duplicate"));

    // ---- T1: same-source duplicate is a skip, not a twin ---------------------

    describe("T1 same-source duplicate: skip instead of opening a twin", () => {
      it("the only candidate (18 articles, 0.87) already holds the article's source -> skipped, no cluster, no link, message archived", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        queueIncoming({ sourceId: "src-outlet", msgId: 4101 });
        scoreBy({ "fp-c1": 0.87 });

        const body = await drain();

        expect(body.skipped).toBe(1);
        expect(body.created).toBe(0);
        expect(body.matched).toBe(0);
        expect(body.failedTransient).toBe(0);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
        expect(supabaseFakeCalls.insert("cluster_articles")).toHaveLength(0);
        expect(linkedClusters()).toEqual([]);
        expect(pgmqState.archived).toContain(4101);
        // outcome {result: "skipped", reason: "same-source-duplicate"}, logged with the article and the cluster id
        const logs = skipLogs();
        expect(logs).toHaveLength(1);
        expect(String(logs[0]?.[0])).toContain("art-twin");
        expect(String(logs[0]?.[0])).toContain("c1");
      });

      it("T1b: with a second candidate from other sources at 0.83 the article joins that one", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.87, "fp-c2": 0.83 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.skipped).toBe(0);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual(["c2"]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
        expect(skipLogs()).toHaveLength(0);
      });

      it("strict-fingerprint fast path: an identical item from the same source in a cluster, nothing else to join -> skipped", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: strictFingerprint(HEADLINE, "Detay") }]);
        queueIncoming({ sourceId: "src-outlet", msgId: 4102 });
        scoreBy({});

        const body = await drain();

        expect(body.skipped).toBe(1);
        expect(body.created).toBe(0);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
        expect(linkedClusters()).toEqual([]);
        expect(pgmqState.archived).toContain(4102);
      });

      it("dry-run (admission shadow): a duplicate-source match at 0.87 is skipped, not reported as would_create", async () => {
        process.env.JEV_POLITICS_ADMISSION = "shadow";
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        queueIncoming({ sourceId: "src-outlet", category: "ekonomi", admit: "shadow", msgId: 4103 });
        scoreBy({ "fp-c1": 0.87 });

        const body = await drain();

        expect(body.skipped).toBe(1);
        expect(body.admission.would_create).toBe(0);
        expect(body.admission.would_match).toBe(0);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
        expect(linkedClusters()).toEqual([]);
        expect(pgmqState.archived).toContain(4103);
      });

      it("dry-run control: the same match from a source the cluster does not hold is would_match", async () => {
        process.env.JEV_POLITICS_ADMISSION = "shadow";
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-wire", fp: "fp-c1" }]);
        queueIncoming({ sourceId: "src-outlet", category: "ekonomi", admit: "shadow" });
        scoreBy({ "fp-c1": 0.87 });

        const body = await drain();

        expect(body.admission.would_match).toBe(1);
        expect(body.skipped).toBe(0);
      });
    });

    // ---- T2: larger cluster wins inside the margin ---------------------------

    describe("T2 tie-break: the larger cluster wins inside the 0.10 margin", () => {
      const CASES = [
        { name: "C1 (18 articles, 0.83) vs C2 (7, 0.87): inside the margin -> C1", s1: 0.83, s2: 0.87, winner: "c1" },
        { name: "C1 (18, 0.76) vs C2 (7, 0.87): outside the margin -> C2", s1: 0.76, s2: 0.87, winner: "c2" },
        { name: "C1 (18, 0.38, below the threshold) vs C2 (7, 0.41) -> C2", s1: 0.38, s2: 0.41, winner: "c2" },
      ];
      for (const c of CASES) {
        it(c.name, async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-agg", fp: "fp-c1" }]);
          seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
          queueIncoming({ sourceId: "src-outlet" });
          scoreBy({ "fp-c1": c.s1, "fp-c2": c.s2 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          expect(linkedClusters()).toEqual([c.winner]);
        });
      }

      it("the exact boundary (0.77 vs 0.87) still prefers the larger cluster", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-agg", fp: "fp-c1" }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.77, "fp-c2": 0.87 });

        await drain();

        expect(linkedClusters()).toEqual(["c1"]);
      });

      it("size is the larger of article_count and the sources loaded for the cluster (a stale row count does not hide a big cluster)", async () => {
        seedCluster("c1", 1, [
          { id: "c1-a", sourceId: "src-agg", fp: "fp-c1", ageMs: 50 * 60_000 },
          // The middle member is only reached by the headline scan: keep its title unrelated.
          { id: "c1-b", sourceId: "src-wire", fp: "fp-c1b", ageMs: 40 * 60_000, title: "Alakasız bir başka konu" },
          { id: "c1-c", sourceId: "src-posta", fp: "fp-c1c", ageMs: 30 * 60_000 },
        ]);
        seedCluster("c2", 2, [{ id: "c2-m", sourceId: "src-cnn-turk", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.8, "fp-c1c": 0.8, "fp-c2": 0.85 });

        await drain();

        expect(linkedClusters()).toEqual(["c1"]);
      });
    });

    // ---- T3: negative control ------------------------------------------------

    describe("T3 negative control: a weak same-source match still creates a cluster", () => {
      for (const s of [0.3, 0.38]) {
        it(`the only candidate holds the source but scores ${s} (< MATCH_THRESHOLD) -> createCluster runs`, async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-outlet" });
          scoreBy({ "fp-c1": s });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(body.skipped).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
          expect(skipLogs()).toHaveLength(0);
        });
      }

      it("a source-blocked 0.87 cluster does not stop a lower fallback candidate in [0.36, 0.40) from taking the article (existing fallback bar unchanged)", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        seedCluster("c2", 3, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.87, "fp-c2": 0.38 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(linkedClusters()).toEqual(["c2"]);
      });
    });

    // ---- T4: exact-title probe (Yusra) ---------------------------------------

    describe("T4 Yusra: a singleton outside the 200-cluster context is found by the exact-title probe", () => {
      const SINGLETON = "cl-yusra-posta";

      function seedBusyContext(n = 250) {
        const t0 = Date.now();
        for (let i = 0; i < n; i++) {
          const id = `ctx-${i}`;
          const at = new Date(t0 - i * 10_000).toISOString();
          clusterRows.push({
            id,
            title_tr: `Bağlam kümesi ${i} alakasız konu`,
            title_tr_neutral: `Bağlam kümesi ${i} alakasız konu`,
            first_published: at,
            updated_at: at,
            article_count: 1,
          });
          clusterArticleRows.push({ cluster_id: id, article_id: `ctx-m-${i}` });
          fakeArticles[`ctx-m-${i}`] = {
            id: `ctx-m-${i}`,
            source_id: "src-agg",
            title: `Bağlam kümesi ${i} alakasız konu`,
            description: "Alakasız",
            published_at: at,
            fingerprint: `fp-ctx-${i}`,
            entities: [],
            category: "politika",
            minhash_sig: null,
            minhash_version: null,
          };
        }
      }

      /** The posta singleton: NOT among the context fixtures, only reachable through the probe. */
      function seedSingleton(sourceId = "src-posta") {
        seedCluster(SINGLETON, 1, [{ id: "yusra-posta", sourceId, fp: "fp-yusra-posta", ageMs: 3.7 * H, title: YUSRA }], {
          title: YUSRA,
          updatedAgoMs: 3.7 * H,
          inContext: false,
        });
        rpcFixtures.cluster_title_probe = () => ({
          data: [
            {
              id: SINGLETON,
              title_tr: YUSRA,
              title_tr_neutral: null,
              first_published: ago(3.7 * H),
              updated_at: ago(3.7 * H),
              article_count: 1,
            },
          ],
          error: null,
        });
      }

      it("control (before the fix): without the probe the cnn-turk article opens a twin", async () => {
        seedBusyContext();
        seedSingleton();
        rpcFixtures.cluster_title_probe = () => ({ data: [], error: null });
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
      });

      it("the identical cnn-turk title joins the out-of-context singleton, and the probe args are (title, ~24 h ago, 3)", async () => {
        seedBusyContext();
        seedSingleton();
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual([SINGLETON]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);

        const calls = probeCalls();
        expect(calls).toHaveLength(1);
        const args = calls[0]?.args as { p_title: string; p_since: string; p_limit: number };
        expect(args.p_title).toBe(YUSRA);
        expect(args.p_limit).toBe(3);
        expect(Math.abs(Date.parse(args.p_since) - (Date.now() - 24 * H))).toBeLessThan(5 * 60_000);
      });

      it("the loaded cluster stays in the context: a second identical headline in the same drain joins it too", async () => {
        seedBusyContext();
        seedSingleton();
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        queueIncoming({ id: "yusra-wire", sourceId: "src-wire", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(body.matched).toBe(2);
        expect(linkedClusters()).toEqual([SINGLETON, SINGLETON]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
      });

      it("a probe hit that is already in the context is scored as usual (no duplicate cluster entry, still joins)", async () => {
        seedBusyContext(10);
        seedCluster(SINGLETON, 1, [{ id: "yusra-posta", sourceId: "src-posta", fp: "fp-yusra-posta", title: YUSRA }], {
          title: YUSRA,
        });
        rpcFixtures.cluster_title_probe = () => ({
          data: [
            { id: SINGLETON, title_tr: YUSRA, title_tr_neutral: null, first_published: ago(H), updated_at: ago(H), article_count: 1 },
          ],
          error: null,
        });
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        await drain();

        expect(linkedClusters()).toEqual([SINGLETON]);
      });

      it("no probe in a dry-run (admission shadow)", async () => {
        process.env.JEV_POLITICS_ADMISSION = "shadow";
        seedBusyContext(10);
        seedSingleton();
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA, category: "ekonomi", admit: "shadow" });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(probeCalls()).toHaveLength(0);
        expect(body.admission.would_create).toBe(1);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
      });

      it("no probe when the headline has fewer than 3 tokens (a CANLI title)", async () => {
        const title = "CANLI";
        expect(headlineTokens(title).tokens.size).toBeLessThan(3);
        expect(headlineTokens(YUSRA).tokens.size).toBeGreaterThanOrEqual(3);
        seedBusyContext(10);
        queueIncoming({ id: "canli", sourceId: "src-cnn-turk", title });
        scoreBy({});

        const body = await drain();

        expect(probeCalls()).toHaveLength(0);
        expect(body.created).toBe(1);
      });

      it("a probe rpc error warns once and the article is still processed", async () => {
        seedBusyContext(10);
        rpcFixtures.cluster_title_probe = () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
        queueIncoming({ id: "yusra-a", sourceId: "src-cnn-turk", title: YUSRA });
        queueIncoming({ id: "other-b", sourceId: "src-posta", title: "Bakanlar Kurulu toplantısı sona erdi, kararlar açıklandı" });
        scoreBy({});

        const body = await drain();

        expect(probeCalls()).toHaveLength(2);
        expect(probeWarnings()).toHaveLength(1);
        expect(body.created).toBe(2);
        expect(body.failedTransient).toBe(0);
      });

      it("a probe rpc that throws warns once and the article is still processed", async () => {
        seedBusyContext(10);
        rpcFixtures.cluster_title_probe = () => {
          throw new Error("network down");
        };
        queueIncoming({ id: "yusra-a", sourceId: "src-cnn-turk", title: YUSRA });
        queueIncoming({ id: "other-b", sourceId: "src-posta", title: "Bakanlar Kurulu toplantısı sona erdi, kararlar açıklandı" });
        scoreBy({});

        const body = await drain();

        expect(probeCalls()).toHaveLength(2);
        expect(probeWarnings()).toHaveLength(1);
        expect(body.created).toBe(2);
        expect(body.failedTransient).toBe(0);
      });

      it("a probe hit whose members cannot be read warns and is skipped; the article still gets a cluster", async () => {
        seedBusyContext(10);
        seedSingleton();
        clusterArticlesFailure.clusterId = SINGLETON;
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(body.created).toBe(1);
        expect(body.failedTransient).toBe(0);
        expect(linkedClusters()).toEqual([]);
        expect(
          warnSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes(SINGLETON)),
        ).toHaveLength(1);
      });

      it("a probe hit with no politics members is ignored (nothing to score)", async () => {
        seedBusyContext(10);
        seedCluster(SINGLETON, 1, [{ id: "yusra-posta", sourceId: "src-posta", fp: "fp-yusra-posta", title: YUSRA, category: "ekonomi" }], {
          title: YUSRA,
          inContext: false,
        });
        rpcFixtures.cluster_title_probe = () => ({
          data: [
            { id: SINGLETON, title_tr: YUSRA, title_tr_neutral: null, first_published: ago(H), updated_at: ago(H), article_count: 1 },
          ],
          error: null,
        });
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
      });

      it("a same-source probe hit is skipped, not twinned (the posta re-delivery case)", async () => {
        seedBusyContext(10);
        seedSingleton("src-posta");
        queueIncoming({ id: "yusra-posta-2", sourceId: "src-posta", title: YUSRA });
        scoreBy({ "fp-yusra-posta": 0.9 });

        const body = await drain();

        expect(body.skipped).toBe(1);
        expect(body.created).toBe(0);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
      });

      it("a null / non-array probe payload is treated as no hit", async () => {
        seedBusyContext(10);
        rpcFixtures.cluster_title_probe = () => ({ data: null, error: null });
        queueIncoming({ id: "yusra-cnn", sourceId: "src-cnn-turk", title: YUSRA });
        scoreBy({});

        const body = await drain();

        expect(body.created).toBe(1);
        expect(probeWarnings()).toHaveLength(0);
      });
    });

    // ---- T5: the milliyet ticker ---------------------------------------------

    describe("T5 milliyet 'Son dakika' ticker is cleaned before entities / fingerprint", () => {
      // Real row 942d7061 (milliyet, 2026-11-01 09:47).
      const TITLE = "Sosyal medyada yaş doğrulama tuzağı! Tek bir kodla hesaplarınızı ele geçirebilirler";
      const CLEAN =
        "Türkiye'de 15 yaşını doldurmamış çocuklara yönelik sosyal medya düzenlemesinin yürürlüğe girmesiyle birlikte gözler yaş doğrulama sürecine çevrildi. Ancak kullanıcıları bekleyen tehlike yalnızca yeni kurallar değil. Dolandırıcılar, \"Hesabınız kapatılacak\" ve \"Yaşınızı doğrulayın\" mesajlarıyla vatandaşların dijital bilgilerini ele geçirmek için harekete geçebilir.";
      const RAW = `${CLEAN}\nSon dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! Türkiye'de 19 yeni il, 78 yeni ilçe önerisi\nE-Devlet veya sosyal ...`;

      const persisted = () =>
        supabaseFakeCalls.update("articles").map(
          (c) => c.patch as { fingerprint: string; entities: string[] },
        );

      it("persisted entities hold no mhp / bahceli and the fingerprint equals strictFingerprint(title, cleaned)", async () => {
        queueIncoming({ id: "mil-942d7061", sourceId: "src-outlet", title: TITLE, description: RAW });
        scoreBy({});

        const body = await drain();

        expect(body.created).toBe(1);
        const patches = persisted();
        expect(patches).toHaveLength(1);
        expect(patches[0]?.entities).not.toContain("mhp");
        expect(patches[0]?.entities).not.toContain("bahceli");
        expect(patches[0]?.fingerprint).toBe(strictFingerprint(TITLE, CLEAN));
        expect(patches[0]?.fingerprint).not.toBe(strictFingerprint(TITLE, RAW));
      });

      it("the cluster summary keeps the stored description, ticker included (only clustering inputs are cleaned)", async () => {
        queueIncoming({ id: "mil-942d7061", sourceId: "src-outlet", title: TITLE, description: RAW });
        scoreBy({});

        await drain();

        const inserts = supabaseFakeCalls.insert("clusters");
        expect(inserts).toHaveLength(1);
        const patch = inserts[0]?.patch as { summary_tr: string; summary_en: string; title_tr: string };
        expect(patch.summary_tr).toBe(RAW);
        expect(patch.summary_en).toBe(RAW);
        expect(patch.title_tr).toBe(TITLE);
      });

      it("control: a description without a ticker is fingerprinted as is", async () => {
        queueIncoming({ id: "plain-1", sourceId: "src-outlet", title: TITLE, description: CLEAN });
        scoreBy({});

        await drain();

        expect(persisted()[0]?.fingerprint).toBe(strictFingerprint(TITLE, CLEAN));
      });

      it("control: the ticker really feeds the entities when it is not cleaned (the stored row had [turkiye, mhp, bahceli])", async () => {
        // A first-line 'Son dakika...' is not a ticker block and stays: entities see it.
        queueIncoming({
          id: "mil-first-line",
          sourceId: "src-outlet",
          title: TITLE,
          description: "Son dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması!",
        });
        scoreBy({});

        await drain();

        expect(persisted()[0]?.entities).toEqual(expect.arrayContaining(["mhp", "bahceli"]));
      });

      it("a stored cluster member with the ticker and no stored signature is re-fingerprinted from the cleaned description", async () => {
        seedCluster(
          "mil-cluster",
          1,
          [{ id: "mil-seed", sourceId: "src-wire", fp: "", title: TITLE, description: RAW }],
          { title: TITLE },
        );
        // fp "" -> falsy -> attachSignature recomputes both the signature and the strict fingerprint.
        (fakeArticles["mil-seed"] as { fingerprint: string | null }).fingerprint = null;
        // A different description: an identical cleaned text would be a strict-fingerprint
        // fast-path join and never reach the scorer.
        queueIncoming({ id: "mil-follow", sourceId: "src-outlet", title: TITLE, description: "Farklı bir açıklama metni." });
        const seen: Array<string | null | undefined> = [];
        vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown) => {
          seen.push((b as { strict?: string | null } | null | undefined)?.strict);
          return result(0.2);
        });

        await drain();

        expect(seen).toContain(strictFingerprint(TITLE, CLEAN));
        expect(seen).not.toContain(strictFingerprint(TITLE, RAW));
      });
    });

    // ---- h16-precision-2: log-only description-swap counter --------------------
    //
    // sabah 1bf7ab12 ("Erdogan, KKTC Cumhurbaskani Erhurman ile gorustu") carries
    // the Berdimuhammedov RSS description. The consumer counts such title/
    // description name swaps per drain and logs them (DESCRIPTION_SWAP_GUARD =
    // 'log'); the clustering inputs, the persisted enrichment and every cluster
    // write stay exactly as they were. Real public text, read-only SELECT on
    // 2026-11-02.
    describe("h16-precision-2: description-swap counter is log-only", () => {
      const SWAP_ID = "sabah-1bf7ab12";
      const TITLE =
        "Son dakika | Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü: Türkiye, her zaman Kıbrıs'ın yanında olacak";
      const DESC =
        "Son dakika haberi: Başkan Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Liderler Zirvesi için Ankara’da bulunan Türkmenistan Devlet Başkanı Serdar Berdimuhammedov’la Cumhurbaşkanlığı Külliyesi’nde...Devamı için tıklayınız";
      // yeni-safak da284792, same cluster 575fc5eb: its own title and its own description.
      const MATCH_TITLE = "Külliye'de kritik kabul: Erdoğan, Berdimuhammedov'la görüştü";
      const MATCH_DESC =
        "Cumhurbaşkanı Recep Tayyip Erdoğan, Türk Devletleri Teşkilatı 13. Zirvesi Devlet Başkanları Konseyi Toplantısı için Ankara'ya gelen Türkmenistan Devlet Başkanı Serdar Berdimuhammedov ile Cumhurbaşkanlığı Külliyesi'nde bir araya geldi.";

      const persisted = () =>
        supabaseFakeCalls.update("articles").map(
          (c) => c.patch as { fingerprint: string; entities: string[] },
        );
      const drainLog = () => {
        const call = logSpy.mock.calls.find((c) => c[0] === "[cluster-consumer] drain");
        expect(call, "the '[cluster-consumer] drain' line").toBeDefined();
        return JSON.parse(String(call![1])) as { descriptionSwapSuspects: number; descriptionSwapSamples: string[] };
      };

      it("the 1bf7ab12 fixture is counted once and its sample id is reported; enrichment is unchanged", async () => {
        queueIncoming({ id: SWAP_ID, sourceId: "src-outlet", title: TITLE, description: DESC });
        scoreBy({});

        const body = await drain();

        expect(body.created).toBe(1);
        expect(body.descriptionSwapSuspects).toBe(1);
        expect(body.descriptionSwapSamples).toEqual([SWAP_ID]);
        const patches = persisted();
        expect(patches).toHaveLength(1);
        // Log-only: the clustering inputs are what they were before the counter existed.
        expect(patches[0]?.fingerprint).toBe(strictFingerprint(TITLE, cleanDescription(DESC)));
        expect(patches[0]?.entities).toEqual(extractEntities(`${TITLE} ${cleanDescription(DESC)}`));
        // The swapped description still feeds the entities (that is the measured problem, not fixed here).
        expect(patches[0]?.entities).toContain("cumhurbaskanligi");
      });

      it("the same counters land in the '[cluster-consumer] drain' JSON log line", async () => {
        queueIncoming({ id: SWAP_ID, sourceId: "src-outlet", title: TITLE, description: DESC });
        scoreBy({});

        await drain();

        const line = drainLog();
        expect(line.descriptionSwapSuspects).toBe(1);
        expect(line.descriptionSwapSamples).toEqual([SWAP_ID]);
      });

      it("a swap changes no cluster write: one cluster insert, summary and title from the stored text", async () => {
        queueIncoming({ id: SWAP_ID, sourceId: "src-outlet", title: TITLE, description: DESC });
        scoreBy({});

        await drain();

        const inserts = supabaseFakeCalls.insert("clusters");
        expect(inserts).toHaveLength(1);
        const patch = inserts[0]?.patch as { summary_tr: string; title_tr: string };
        expect(patch.title_tr).toBe(TITLE);
        expect(patch.summary_tr).toBe(DESC);
        // Counting never writes to an existing cluster.
        expect(supabaseFakeCalls.update("clusters")).toHaveLength(0);
      });

      it("a matching title/description pair gives 0 and []", async () => {
        queueIncoming({ id: "yeni-safak-da284792", sourceId: "src-outlet", title: MATCH_TITLE, description: MATCH_DESC });
        scoreBy({});

        const body = await drain();

        expect(body.created).toBe(1);
        expect(body.descriptionSwapSuspects).toBe(0);
        expect(body.descriptionSwapSamples).toEqual([]);
        expect(drainLog().descriptionSwapSuspects).toBe(0);
      });

      it("4 suspects in one drain: counter 4, only the first 3 ids sampled", async () => {
        const titles = [
          "Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile görüştü",
          "Cumhurbaşkanı Erdoğan, Kırgızistan Cumhurbaşkanı Caparov ile görüştü",
          "Erdoğan Macron ile telefonda görüştü",
          "Başkan Erdoğan, Rusya Devlet Başkanı Putin ile görüştü",
        ];
        titles.forEach((title, i) => {
          queueIncoming({ id: `swap-${i + 1}`, sourceId: "src-outlet", title, description: DESC });
        });
        scoreBy({});

        const body = await drain();

        expect(body.descriptionSwapSuspects).toBe(4);
        expect(body.descriptionSwapSamples).toHaveLength(3);
        expect(body.descriptionSwapSamples).toEqual(["swap-1", "swap-2", "swap-3"]);
        expect(body.failedTransient).toBe(0);
      });

      it("the next drain starts from 0 and []", async () => {
        queueIncoming({ id: SWAP_ID, sourceId: "src-outlet", title: TITLE, description: DESC });
        scoreBy({});
        const first = await drain();
        expect(first.descriptionSwapSuspects).toBe(1);
        expect(first.descriptionSwapSamples).toEqual([SWAP_ID]);

        queueIncoming({ id: "yeni-safak-da284792", sourceId: "src-outlet", title: MATCH_TITLE, description: MATCH_DESC });
        const second = await drain();

        expect(second.descriptionSwapSuspects).toBe(0);
        expect(second.descriptionSwapSamples).toEqual([]);
        // The first body still holds the first drain's numbers (no shared references).
        expect(first.descriptionSwapSuspects).toBe(1);
        expect(first.descriptionSwapSamples).toEqual([SWAP_ID]);
      });

      it("a drain with a swap suspect followed by another swap suspect counts 1, not 2", async () => {
        queueIncoming({ id: SWAP_ID, sourceId: "src-outlet", title: TITLE, description: DESC });
        scoreBy({});
        await drain();

        queueIncoming({ id: "swap-again", sourceId: "src-outlet", title: "Cumhurbaşkanı Erdoğan, Kırgızistan Cumhurbaşkanı Caparov ile görüştü", description: DESC });
        const second = await drain();

        expect(second.descriptionSwapSuspects).toBe(1);
        expect(second.descriptionSwapSamples).toEqual(["swap-again"]);
      });

      it("null and empty descriptions are not suspects and do not fail the message", async () => {
        queueIncoming({ id: "no-desc-1", sourceId: "src-outlet", title: TITLE, description: "" });
        queueIncoming({ id: "no-desc-2", sourceId: "src-wire", title: "Başkan Erdoğan, Rusya Devlet Başkanı Putin ile görüştü" });
        (fakeArticles["no-desc-2"] as { description: string | null }).description = null;
        scoreBy({});

        const body = await drain();

        expect(body.failedTransient).toBe(0);
        expect(body.created).toBe(2);
        expect(body.descriptionSwapSuspects).toBe(0);
        expect(body.descriptionSwapSamples).toEqual([]);
      });

      it("if the detector throws, nothing is counted and the message still clusters", async () => {
        vi.doMock("../../supabase/functions/_shared/cluster/description-clean.ts", async (importOriginal) => {
          const actual = await importOriginal<typeof import("../../supabase/functions/_shared/cluster/description-clean.ts")>();
          return {
            ...actual,
            descriptionNamesSwap: () => {
              throw new Error("detector exploded");
            },
          };
        });
        try {
          queueIncoming({ id: SWAP_ID, sourceId: "src-outlet", title: TITLE, description: DESC });
          scoreBy({});

          const body = await drain();

          expect(body.created).toBe(1);
          expect(body.failedTransient).toBe(0);
          expect(body.descriptionSwapSuspects).toBe(0);
          expect(body.descriptionSwapSamples).toEqual([]);
        } finally {
          vi.doUnmock("../../supabase/functions/_shared/cluster/description-clean.ts");
        }
      });
    });

    // ---- h14-cluster-1: the same-source skip needs strong evidence -------------
    //
    // #152 skipped ANY article that matched a cluster at MATCH_THRESHOLD or better
    // when that cluster already held the article's source. A templated MinHash
    // false match (cumhuriyet's "<film> filmi televizyon ekranlarında ..." blurb)
    // therefore dropped "Muhbir" and "Eller Yukarı" as duplicates of the "Suikast
    // Treni" cluster (2026-11-01 17:46 and 18:22, scores 0.849 / 0.833). The skip
    // is now taken only on strong evidence: an equal strict fingerprint, an
    // identical folded headline, or the headline lane firing against the SAME
    // source's member. Everything else falls through to createCluster, exactly as
    // before #152. The titles and descriptions below are the public article text
    // read from production on 2026-11-01.
    describe("h14-cluster-1: same-source skip needs strong evidence", () => {
      const MIN = 60_000;
      // cnn-turk member of the Suikast Treni cluster 609bdf18 (published 15:52).
      const SUIKAST_CNN_TITLE = "Suikast Treni filminin konusu nedir? Suikast Treni filminin oyuncuları kimler?";
      const SUIKAST_CNN_DESC =
        "Aksiyon ve komedi türündeki Suikast Treni filminin başrolünde dünyaca ünlü oyuncu Brad Pitt yer alıyor. 2022 yapımı aksiyon filmi olan Suikast Treni'nin yönetmenliğini David Leitch üstlendi. Çekimler Kasım 2020'de Los Angeles'ta başladı ve Mart 2021'de tamamlandı. 90 milyon dolarlık bütçe ile çekilen film 239,3 milyon dolar hasılat elde etti. Peki Suikast Treni filminin konusu nedir? Suikast Treni filminin oyuncuları kimler? İşte detaylar...";
      // cumhuriyet member of the same cluster (published 17:19).
      const SUIKAST_CUM_TITLE = "Suikast Treni filminin konusu ne? Suikast Treni filminin oyuncuları kim?";
      const SUIKAST_CUM_DESC =
        "Suikast Treni (Bullet Train) filmi televizyon ekranlarında izleyicisiyle buluşmaya hazırlanıyor. Suikast Treni filminin konusu ve oyuncularının kimler olduğu merak ediliyor. Peki, Suikast Treni filminin konusu ne? Suikast Treni filminin oyuncuları kim? İşte ayrıntılar...";
      // The two cumhuriyet articles #152 dropped (312bce42, f4b82ef9).
      const MUHBIR_TITLE = "Muhbir filminin konusu ne? Muhbir filminin oyuncuları kim?";
      const MUHBIR_DESC =
        "Muhbir (The Informer) filmi televizyon ekranlarında izleyicisiyle buluşmaya hazırlanıyor. Muhbir filminin konusu ve oyuncularının kimler olduğu merak ediliyor. Peki, Muhbir filminin konusu ne? Muhbir filminin oyuncuları kim? İşte ayrıntılar...";
      const ELLER_TITLE = "Eller Yukarı filminin konusu ne? Eller Yukarı filminin oyuncuları kim?";
      const ELLER_DESC =
        "Eller Yukarı (Guns Up) filmi televizyon ekranlarında izleyicisiyle buluşmaya hazırlanıyor. Eller Yukarı filminin konusu ve oyuncularının kimler olduğu merak ediliyor. Peki, Eller Yukarı filminin konusu ne? Eller Yukarı filminin oyuncuları kim? İşte ayrıntılar...";
      // The third logged skip: aksam 11862382 (18:15) against the 38-article Seul cluster e952ca96.
      const SEUL_NEW_TITLE = "Güney Kore'de dostluk diplomasisi: Başkan Erdoğan Seul'e doğru yola çıktı";
      const SEUL_NEW_DESC =
        "Başkan Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae Myung'un davetine icabetle Seul'e doğru yola çıktı.";
      const SEUL_AKSAM_TITLE = "Seul'den davet: Başkan Erdoğan, Güney Kore'ye gidecek";
      // Same story as HEADLINE in different words: 11 shared stems, Jaccard 0.73 (the lane fires), not an equal title.
      const HEADLINE_VARIANT =
        "Antalya Alanya ulaşımı 36 dakikaya inecek, yıllık 23,9 milyar lira tasarruf sağlanacak";

      /** c-suikast: cnn-turk seed (100 min ago) and the cumhuriyet member (22 min ago) the new article collides with. */
      function seedSuikast() {
        seedCluster(
          "c-suikast",
          2,
          [
            { id: "m-cnn", sourceId: "src-cnn-turk", fp: "fp-cnn", ageMs: 100 * MIN, title: SUIKAST_CNN_TITLE, description: SUIKAST_CNN_DESC },
            { id: "m-cum", sourceId: "src-outlet", fp: "fp-cum", ageMs: 22 * MIN, title: SUIKAST_CUM_TITLE, description: SUIKAST_CUM_DESC },
          ],
          { title: SUIKAST_CNN_TITLE },
        );
      }

      const skipLogWrites = () => supabaseFakeCalls.forTable("cluster_skip_log");
      const skipLogRows = () =>
        supabaseFakeCalls
          .upsert("cluster_skip_log")
          .flatMap((m) => m.patch as Array<Record<string, unknown>>);
      const skipLogWarnings = () =>
        warnSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("cluster_skip_log"));
      const scoredAgainst = () =>
        vi.mocked(scoreMock).mock.calls.map((c) => (c[1] as { strict?: string | null } | null | undefined)?.strict);

      describe("(1) templated pair: a MinHash-only match is no duplicate", () => {
        for (const c of [
          { name: "Muhbir", title: MUHBIR_TITLE, desc: MUHBIR_DESC, id: "312bce42", score: 0.856 },
          { name: "Eller Yukarı", title: ELLER_TITLE, desc: ELLER_DESC, id: "f4b82ef9", score: 0.85 },
        ]) {
          it(`${c.name} (cumhuriyet, ${c.score}) against the Suikast Treni cluster that holds a cumhuriyet member -> created, not skipped`, async () => {
            // Premise: the headline lane does NOT fire for this pair, so nothing but the MinHash score links them.
            const hoursApart = 22 / 60;
            expect(headlineLane(headlineTokens(c.title), headlineTokens(SUIKAST_CUM_TITLE), hoursApart).fired).toBe(false);
            expect(normalizeTurkish(c.title)).not.toBe(normalizeTurkish(SUIKAST_CUM_TITLE));

            seedSuikast();
            queueIncoming({ id: c.id, sourceId: "src-outlet", title: c.title, description: c.desc, msgId: 4301 });
            scoreBy({ "fp-cum": c.score, "fp-cnn": 0.3 });

            const body = await drain();

            // Non-vacuous: the cluster really was a scored, source-blocked candidate at >= MATCH_THRESHOLD.
            expect(scoredAgainst()).toContain("fp-cum");
            expect(body.created).toBe(1);
            expect(body.skipped).toBe(0);
            expect(body.matched).toBe(0);
            expect(body.failedTransient).toBe(0);
            expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
            expect(linkedClusters()).toEqual([]);
            expect(pgmqState.archived).toContain(4301);
            expect(skipLogs()).toHaveLength(0);
            expect(skipLogWrites()).toHaveLength(0);
          });
        }
      });

      describe("(2) genuine same-source duplicates are still skipped, with the reason recorded", () => {
        it("(a) strict-fingerprint fast path -> same-source-duplicate/fingerprint", async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: strictFingerprint(HEADLINE, "Detay") }]);
          queueIncoming({ sourceId: "src-outlet", msgId: 4311 });
          scoreBy({});

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(linkedClusters()).toEqual([]);
          expect(pgmqState.archived).toContain(4311);
          expect(skipLogs()).toHaveLength(1);
          expect(String(skipLogs()[0]?.[0])).toContain("evidence=fingerprint");
          expect(skipLogRows()).toEqual([
            { article_id: "art-twin", cluster_id: "c1", score: 1, reason: "same-source-duplicate/fingerprint" },
          ]);
        });

        it("(b) different wording from the same source that fires the headline lane against that source's member (0.87) -> same-source-duplicate/headline-lane", async () => {
          // Premise: the lane fires, the folded titles differ, the strict fingerprints differ.
          expect(headlineLane(headlineTokens(HEADLINE_VARIANT), headlineTokens(HEADLINE), 0.5).fired).toBe(true);
          expect(normalizeTurkish(HEADLINE_VARIANT)).not.toBe(normalizeTurkish(HEADLINE));
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-outlet", title: HEADLINE_VARIANT, msgId: 4312 });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(linkedClusters()).toEqual([]);
          expect(pgmqState.archived).toContain(4312);
          expect(String(skipLogs()[0]?.[0])).toContain("evidence=headline-lane");
          const rows = skipLogRows();
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({ article_id: "art-twin", cluster_id: "c1", reason: "same-source-duplicate/headline-lane" });
          expect(rows[0]?.score as number).toBeCloseTo(0.87, 5);
        });

        it("(b2) the same-source member that fires the lane may be a middle member, neither seed nor latest", async () => {
          seedCluster("c1", 3, [
            { id: "c1-seed", sourceId: "src-wire", fp: "fp-c1s", ageMs: 90 * MIN, title: "Alakasız bir başka konu" },
            { id: "c1-mid", sourceId: "src-outlet", fp: "fp-c1m", ageMs: 60 * MIN },
            { id: "c1-late", sourceId: "src-posta", fp: "fp-c1l", ageMs: 30 * MIN, title: "Alakasız bir başka konu daha" },
          ]);
          queueIncoming({ sourceId: "src-outlet", title: HEADLINE_VARIANT, msgId: 4313 });
          scoreBy({ "fp-c1s": 0.5, "fp-c1l": 0.87 });

          const body = await drain();

          expect(scoredAgainst()).toContain("fp-c1l");
          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(skipLogRows()[0]).toMatchObject({ cluster_id: "c1", reason: "same-source-duplicate/headline-lane" });
        });

        it("(c) identical headline from the same source (0.87) -> same-source-duplicate/exact-title", async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-outlet", msgId: 4314 });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(String(skipLogs()[0]?.[0])).toContain("evidence=exact-title");
          expect(skipLogRows()).toMatchObject([
            { article_id: "art-twin", cluster_id: "c1", reason: "same-source-duplicate/exact-title" },
          ]);
        });

        it("(d) exact-title probe hit: the cluster holds the source through a member with another headline -> exact-title", async () => {
          const SINGLETON = "cl-yusra-probe";
          const YUSRA_TITLE = "Yüsra Geyik takside beklerken, Nehir Erdoğan arka kapıdan kaçtı";
          seedCluster(
            SINGLETON,
            2,
            [
              { id: "yusra-posta", sourceId: "src-posta", fp: "fp-yusra-posta", ageMs: 200 * MIN, title: YUSRA_TITLE },
              // The cnn-turk member's own headline is unrelated: only the probe ties this cluster to the incoming title.
              { id: "yusra-cnn-old", sourceId: "src-cnn-turk", fp: "fp-yusra-cnn", ageMs: 150 * MIN, title: "Alakasız bir başka konu" },
            ],
            { title: YUSRA_TITLE, inContext: false },
          );
          rpcFixtures.cluster_title_probe = () => ({
            data: [
              {
                id: SINGLETON,
                title_tr: YUSRA_TITLE,
                title_tr_neutral: null,
                first_published: ago(200 * MIN),
                updated_at: ago(150 * MIN),
                article_count: 2,
              },
            ],
            error: null,
          });
          queueIncoming({ id: "yusra-cnn-new", sourceId: "src-cnn-turk", title: YUSRA_TITLE, msgId: 4315 });
          scoreBy({ "fp-yusra-posta": 0.9, "fp-yusra-cnn": 0.5 });

          const body = await drain();

          expect(probeCalls()).toHaveLength(1);
          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(skipLogRows()).toMatchObject([
            { article_id: "yusra-cnn-new", cluster_id: SINGLETON, reason: "same-source-duplicate/exact-title" },
          ]);
        });
      });

      describe("(3) a low score (0.41, just over MATCH_THRESHOLD) needs the same evidence", () => {
        // Both tests share one shape: a wire seed whose headline makes c1 a candidate and carries the 0.41,
        // plus a src-outlet member (the one that blocks the join). Only that member's headline differs.
        it("lane fired against the same source's member -> skipped", async () => {
          seedCluster("c1", 2, [
            { id: "c1-seed", sourceId: "src-wire", fp: "fp-c1s", ageMs: 90 * MIN },
            { id: "c1-outlet", sourceId: "src-outlet", fp: "fp-c1o", ageMs: 60 * MIN },
          ]);
          queueIncoming({ sourceId: "src-outlet", title: HEADLINE_VARIANT });
          scoreBy({ "fp-c1s": 0.41, "fp-c1o": 0.1 });

          const body = await drain();

          expect(scoredAgainst()).toContain("fp-c1s");
          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(skipLogRows()).toMatchObject([{ cluster_id: "c1", reason: "same-source-duplicate/headline-lane" }]);
          expect(skipLogRows()[0]?.score as number).toBeCloseTo(0.41, 5);
        });

        it("the same 0.41 with an unrelated same-source member headline -> created", async () => {
          seedCluster("c1", 2, [
            { id: "c1-seed", sourceId: "src-wire", fp: "fp-c1s", ageMs: 90 * MIN },
            { id: "c1-outlet", sourceId: "src-outlet", fp: "fp-c1o", ageMs: 60 * MIN, title: "Alakasız bir başka konu" },
          ]);
          queueIncoming({ sourceId: "src-outlet", title: HEADLINE_VARIANT });
          scoreBy({ "fp-c1s": 0.41, "fp-c1o": 0.1 });

          const body = await drain();

          expect(scoredAgainst()).toContain("fp-c1s");
          expect(body.created).toBe(1);
          expect(body.skipped).toBe(0);
          expect(skipLogWrites()).toHaveLength(0);
        });

        it("the real aksam Seul pair (0.406) does not fire the lane (Jaccard 0.33, 7.25 h apart, lane window 6 h) -> created, as before #152", async () => {
          // What production did on 2026-11-01 18:19: the pair scored 0.406 and the article was skipped. The
          // headlines share 4 stems of 12 and sit 7.25 h apart, so neither the lane nor an equal title ties them:
          // the article now opens its own cluster again. Skipping it would have needed a weaker rule than the
          // evidence gate (which is what dropped Muhbir and Eller Yukarı).
          expect(headlineLane(headlineTokens(SEUL_NEW_TITLE), headlineTokens(SEUL_AKSAM_TITLE), 7.25).fired).toBe(false);
          seedCluster(
            "c-seul",
            2,
            [
              { id: "seul-ekonomim", sourceId: "src-wire", fp: "fp-seul-a", ageMs: 8 * 60 * MIN, title: "Cumhurbaşkanı Erdoğan, 8 yıl aranın ardından Güney Kore'ye gidecek" },
              { id: "seul-aksam", sourceId: "src-outlet", fp: "fp-seul-b", ageMs: 7.25 * 60 * MIN, title: SEUL_AKSAM_TITLE },
            ],
            { title: SEUL_AKSAM_TITLE },
          );
          queueIncoming({ id: "seul-aksam-2", sourceId: "src-outlet", title: SEUL_NEW_TITLE, description: SEUL_NEW_DESC });
          scoreBy({ "fp-seul-a": 0.3, "fp-seul-b": 0.406 });

          const body = await drain();

          expect(scoredAgainst()).toContain("fp-seul-b");
          expect(body.created).toBe(1);
          expect(body.skipped).toBe(0);
          expect(skipLogWrites()).toHaveLength(0);
        });
      });

      describe("(4) dry-run parity (admission shadow)", () => {
        it("templated pair -> would_create, not skipped, nothing written", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          seedSuikast();
          queueIncoming({ sourceId: "src-outlet", title: MUHBIR_TITLE, description: MUHBIR_DESC, category: "ekonomi", admit: "shadow" });
          scoreBy({ "fp-cum": 0.856, "fp-cnn": 0.3 });

          const body = await drain();

          expect(scoredAgainst()).toContain("fp-cum");
          expect(body.admission.would_create).toBe(1);
          expect(body.skipped).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(linkedClusters()).toEqual([]);
          expect(skipLogWrites()).toHaveLength(0);
        });

        it("headline-lane pair -> skipped, not would_create, and no skip-log write", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-outlet", title: HEADLINE_VARIANT, category: "ekonomi", admit: "shadow" });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.admission.would_create).toBe(0);
          expect(body.admission.would_match).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(skipLogs()).toHaveLength(1);
          expect(String(skipLogs()[0]?.[0])).toContain("dry-run");
          expect(skipLogWrites()).toHaveLength(0);
        });

        it("identical headline in a dry run -> skipped, and no skip-log write", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: strictFingerprint(HEADLINE, "Detay") }]);
          queueIncoming({ sourceId: "src-outlet", category: "ekonomi", admit: "shadow" });
          scoreBy({});

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.admission.would_create).toBe(0);
          expect(skipLogWrites()).toHaveLength(0);
        });
      });

      describe("(5) the skip log", () => {
        it("each live skip writes exactly one cluster_skip_log row, via upsert onConflict article_id / ignoreDuplicates", async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ id: "art-twin-1", msgId: 4331, sourceId: "src-outlet" });
          queueIncoming({ id: "art-twin-2", msgId: 4332, sourceId: "src-outlet" });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(2);
          const writes = skipLogWrites();
          expect(writes).toHaveLength(2);
          expect(writes.every((w) => w.op === "upsert")).toBe(true);
          const rows = skipLogRows();
          expect(rows.map((r) => r.article_id)).toEqual(["art-twin-1", "art-twin-2"]);
          for (const r of rows) {
            expect(Object.keys(r).sort()).toEqual(["article_id", "cluster_id", "reason", "score"]);
            expect(r.cluster_id).toBe("c1");
            expect(r.reason).toBe("same-source-duplicate/exact-title");
            expect(r.score as number).toBeCloseTo(0.87, 5);
          }
          expect(skipLogFake.upsertOptions).toEqual([
            { onConflict: "article_id", ignoreDuplicates: true },
            { onConflict: "article_id", ignoreDuplicates: true },
          ]);
          expect(skipLogWarnings()).toHaveLength(0);
        });

        it("a failing log table: both messages are still skipped and archived, nothing fails, exactly one warning", async () => {
          skipLogFake.mode = "error";
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ id: "art-twin-1", msgId: 4341, sourceId: "src-outlet" });
          queueIncoming({ id: "art-twin-2", msgId: 4342, sourceId: "src-outlet" });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(2);
          expect(body.failedTransient).toBe(0);
          expect(body.created).toBe(0);
          expect(pgmqState.archived).toEqual(expect.arrayContaining([4341, 4342]));
          expect(skipLogWrites()).toHaveLength(2);
          const warnings = skipLogWarnings();
          expect(warnings).toHaveLength(1);
          expect(String(warnings[0]?.[0])).toContain("skip log down");
        });

        it("a log table that throws behaves the same: skipped, archived, one warning", async () => {
          skipLogFake.mode = "throw";
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ id: "art-twin-1", msgId: 4351, sourceId: "src-outlet" });
          queueIncoming({ id: "art-twin-2", msgId: 4352, sourceId: "src-outlet" });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(2);
          expect(body.failedTransient).toBe(0);
          expect(pgmqState.archived).toEqual(expect.arrayContaining([4351, 4352]));
          expect(skipLogWarnings()).toHaveLength(1);
          expect(String(skipLogWarnings()[0]?.[0])).toContain("skip log unreachable");
        });

        it("a created article writes nothing to the log", async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-wire" });
          scoreBy({ "fp-c1": 0.2 });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(skipLogWrites()).toHaveLength(0);
        });
      });
    });

    // ---- h45-clusters-1: a source's own follow-up on a story it already has in a cluster ----
    //
    // wouldDuplicate() blocks the join whenever the article's source is already a
    // member of the cluster, and the same-source skip (h12/h14) is taken only on a
    // fingerprint, an exact-title or a headline-lane tie. A follow-up in other words
    // has none of them, so it opened a twin and the other outlets then joined the
    // twin: Spain 34/6 (haberler-com aec9f530 then 870aeeb7, 9 min apart), Vance
    // 19/9, Israel 19/12, Bayraktar 16/7. A 4th kind of evidence, 'same-source-update',
    // is computed from the same pure member scan: a same-source member within
    // SAME_SOURCE_UPDATE_MAX_HOURS, >= 2 shared non-numeral headline stems, a shared
    // named subject, no subject / incident veto. SAME_SOURCE_UPDATE_ENFORCE (a code
    // constant) decides between a skip and a shadow log line.
    describe("h45-clusters-1: a source's follow-up on its own story does not open a twin", () => {
      const MIN = 60_000;
      const UPDATE_REASON = "same-source-duplicate/same-source-update";

      // Live titles (prod, 2026-11-04/05). `member` sits in the large cluster, `incoming` seeded the twin.
      const SPAIN_MEMBER = "İspanya Ulaştırma Bakanı Puente, 69 kişinin öldüğü kazanın ardından istifa etti";
      const SPAIN_NEW = "İspanya'da 69 kişinin öldüğü tren kazası sonrası bakan istifa etti";
      const VANCE_MEMBER = "Vance, Cumhuriyetçilerin ara seçim yenilgisinin nedenini İran savaşı olarak açıkladı";
      const VANCE_NEW = "JD Vance, Kongre ara seçim yenilgisini İran savaşı ve İsrail ilişkilerine bağladı";
      const ISRAEL_MEMBER = "İsrail Merkez Seçim Komitesi şeffaflığa aykırı bulguya rastlanmadığını açıkladı";
      const ISRAEL_NEW = "İsrail Merkez Seçim Komitesi 27 Ekim seçim sonuçlarını 15 lehte oyla onayladı";
      const BAYRAKTAR_MEMBER =
        'Enerji Bakanı Alparslan Bayraktar: "Türkiye 2040 itibarıyla 175 bin megavatlık rüzgar ve güneş kurulu gücüne ulaşacak. Yatırım tutarı yaklaşık 100 milyar dolar"';
      const BAYRAKTAR_NEW = 'Bakan Bayraktar "Enerjide bağımsız olacağız" deyip duyurdu! İşte 5 maddelik yol haritası';
      // Negative controls
      const HR_MEMBER = "Bakan Güler, Hırvatistan Parlamento Başkanı Jandroković ile görüştü";
      const HR_NEW = "Bakan Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü";
      const KOREA_MEMBER = "Cumhurbaşkanı Erdoğan Güney Kore'den ayrıldı";
      const KOREA_NEW = "Cumhurbaşkanı Erdoğan Güney Kore'deki temaslarının ardından yurda döndü";
      const BURSA = "Bursa'da Anadolu Otoyolu'nda zincirleme kaza, 5 yaralı";
      const KONYA = "Konya'da Anadolu Otoyolu'nda zincirleme kaza, 5 yaralı";

      interface Hit {
        name: string;
        member: string;
        incoming: string;
        memberAgeMs: number;
        seedTitle: string;
        score: number;
      }
      const HITS: Hit[] = [
        {
          name: "Spain",
          member: SPAIN_MEMBER,
          incoming: SPAIN_NEW,
          memberAgeMs: 9 * MIN,
          seedTitle: "İspanya'da tren kazası: Ulaştırma Bakanı Puente istifasını açıkladı",
          score: 0.62,
        },
        {
          name: "Vance",
          member: VANCE_MEMBER,
          incoming: VANCE_NEW,
          memberAgeMs: 0,
          seedTitle: "İşte ABD'deki seçim hezimetinin nedeni! Trump'ın en yakın adamı açıkladı",
          score: 0.55,
        },
        {
          name: "Israel",
          member: ISRAEL_MEMBER,
          incoming: ISRAEL_NEW,
          memberAgeMs: 3 * 60 * MIN,
          seedTitle: "İsrail seçimlerinde sayım sürüyor, sonuçlar bekleniyor",
          score: 0.5,
        },
      ];

      const skipLogRows = () =>
        supabaseFakeCalls
          .upsert("cluster_skip_log")
          .flatMap((m) => m.patch as Array<Record<string, unknown>>);
      const skipLogWrites = () => supabaseFakeCalls.forTable("cluster_skip_log");
      const shadowLogs = () =>
        logSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("same-source-update shadow"));
      const scoredAgainst = () =>
        vi.mocked(scoreMock).mock.calls.map((c) => (c[1] as { strict?: string | null } | null | undefined)?.strict);

      async function updatePair() {
        await importHandler();
        const mod = await import("../../supabase/functions/cluster-consumer/index.ts");
        return mod.isSameSourceUpdate;
      }

      /** The big cluster c1: another outlet seeded it (wire), the source's own member is the newer row. */
      function seedHit(h: Hit, opts: { incomingSourceId?: string; msgId?: number } = {}) {
        seedCluster(
          "c1",
          34,
          [
            { id: "c1-seed", sourceId: "src-wire", fp: "fp-c1s", ageMs: h.memberAgeMs + 90 * MIN, title: h.seedTitle },
            { id: "c1-mem", sourceId: "src-outlet", fp: "fp-c1m", ageMs: h.memberAgeMs, title: h.member },
          ],
          { title: h.member },
        );
        queueIncoming({ sourceId: opts.incomingSourceId ?? "src-outlet", title: h.incoming, msgId: opts.msgId ?? 4501 });
        scoreBy({ "fp-c1s": h.score, "fp-c1m": 0.1 });
      }

      describe("the predicate (pure title pair)", () => {
        it("fixture premises: for the live pairs the headline lane, an equal title and both vetoes are all silent, so only the new kind can tie them", () => {
          for (const h of [...HITS, { name: "Bayraktar", member: BAYRAKTAR_MEMBER, incoming: BAYRAKTAR_NEW, memberAgeMs: 6 * MIN }]) {
            const hours = h.memberAgeMs / 3_600_000;
            expect(headlineLane(headlineTokens(h.incoming), headlineTokens(h.member), hours).fired, h.name).toBe(false);
            expect(normalizeTurkish(h.incoming), h.name).not.toBe(normalizeTurkish(h.member));
            expect(subjectVetoFires(h.incoming, h.member), h.name).toBe(false);
            expect(incidentVetoFires(h.incoming, h.member), h.name).toBe(false);
          }
        });

        it("fires for the Spain, Vance, Israel and Bayraktar pairs, in either direction", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          for (const [a, b, gapMs] of [
            [SPAIN_NEW, SPAIN_MEMBER, 9 * MIN],
            [VANCE_NEW, VANCE_MEMBER, 0],
            [ISRAEL_NEW, ISRAEL_MEMBER, 3 * 60 * MIN],
            [BAYRAKTAR_NEW, BAYRAKTAR_MEMBER, 6 * MIN],
          ] as const) {
            expect(pair({ title: a, ms: t }, { title: b, ms: t - gapMs }), a).toBe(true);
            expect(pair({ title: b, ms: t - gapMs }, { title: a, ms: t }), b).toBe(true);
            // a member that is NEWER than the article counts the same
            expect(pair({ title: a, ms: t - gapMs }, { title: b, ms: t }), a).toBe(true);
          }
        });

        it("the 6 h window: 6 h exactly still fires, one second more does not (the Erdogan Korea pair is 11 h apart)", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          const SIX_H = 6 * 60 * MIN;
          expect(pair({ title: SPAIN_NEW, ms: t }, { title: SPAIN_MEMBER, ms: t - SIX_H })).toBe(true);
          expect(pair({ title: SPAIN_NEW, ms: t }, { title: SPAIN_MEMBER, ms: t - SIX_H - 1000 })).toBe(false);
          expect(pair({ title: SPAIN_NEW, ms: t - SIX_H - 1000 }, { title: SPAIN_MEMBER, ms: t })).toBe(false);
          // Korea: inside 6 h the pair would fire (two shared stems, the named subject Guney Kore), at 11 h it does not.
          expect(pair({ title: KOREA_NEW, ms: t }, { title: KOREA_MEMBER, ms: t - 5 * 60 * MIN })).toBe(true);
          expect(pair({ title: KOREA_NEW, ms: t }, { title: KOREA_MEMBER, ms: t - 11 * 60 * MIN })).toBe(false);
        });

        it("a different leading actor is vetoed: Guler vs Fidan with the same Hirvatistan template, 30 min apart", async () => {
          const pair = await updatePair();
          // Premise: the existing subject veto already fires for this pair.
          expect(subjectVetoFires(HR_NEW, HR_MEMBER)).toBe(true);
          const t = Date.parse("2026-11-04T12:00:00Z");
          expect(pair({ title: HR_NEW, ms: t }, { title: HR_MEMBER, ms: t - 30 * MIN })).toBe(false);
        });

        it("different provinces for the same incident template are vetoed (incident veto)", async () => {
          const pair = await updatePair();
          expect(incidentVetoFires(BURSA, KONYA)).toBe(true);
          const t = Date.parse("2026-11-04T12:00:00Z");
          expect(pair({ title: BURSA, ms: t }, { title: KONYA, ms: t - 10 * MIN })).toBe(false);
          // Control: the same province twice is the same incident.
          expect(pair({ title: BURSA, ms: t }, { title: "Bursa'da Anadolu Otoyolu'nda zincirleme kaza: 5 kişi yaralandı", ms: t - 10 * MIN })).toBe(true);
        });

        it("shared stems without a shared named subject do not fire (the h14 Muhbir / Eller Yukarı / Suikast Treni film template)", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          const SUIKAST = "Suikast Treni filminin konusu ne? Suikast Treni filminin oyuncuları kim?";
          const MUHBIR = "Muhbir filminin konusu ne? Muhbir filminin oyuncuları kim?";
          const ELLER = "Eller Yukarı filminin konusu ne? Eller Yukarı filminin oyuncuları kim?";
          // Premise: the pairs do share >= 2 non-generic stems.
          const shared = [...headlineTokens(MUHBIR).tokens].filter((x) => headlineTokens(SUIKAST).tokens.has(x));
          expect(shared.length).toBeGreaterThanOrEqual(2);
          expect(pair({ title: MUHBIR, ms: t }, { title: SUIKAST, ms: t - 22 * MIN })).toBe(false);
          expect(pair({ title: ELLER, ms: t }, { title: SUIKAST, ms: t - 22 * MIN })).toBe(false);
          // Lower-case in one headline: 'Dolar' vs 'dolar' is not a named subject there.
          expect(pair({ title: "Dolar güne yükselişle başladı, altın geriledi", ms: t }, { title: "Altın güne yükselişle başladı, dolar geriledi", ms: t - 5 * MIN })).toBe(false);
        });

        it("generic names do not count as a named subject (Erdogan, Cumhurbaskani, Bakan, Turkiye)", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          expect(
            pair(
              { title: "Erdoğan faiz kararı için yeni açıklama yaptı", ms: t },
              { title: "Erdoğan yeni faiz kararı açıkladı", ms: t - 5 * MIN },
            ),
          ).toBe(false);
        });

        it("fewer than two shared non-numeral stems do not fire (a shared numeral is no stem)", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          const a = "Ankara'da 69 yeni vaka";
          const b = "Ankara'dan 69 ilk haber";
          // Premise: exactly the place name and the numeral are shared.
          const shared = [...headlineTokens(a).tokens].filter((x) => headlineTokens(b).tokens.has(x));
          expect(shared).toHaveLength(2);
          expect(shared).toContain("69");
          expect(pair({ title: a, ms: t }, { title: b, ms: t - 5 * MIN })).toBe(false);
        });

        it("an all-caps headline names nothing: every word is capitalised", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          expect(pair({ title: ISRAEL_NEW, ms: t }, { title: ISRAEL_MEMBER.toLocaleUpperCase("tr"), ms: t - 5 * MIN })).toBe(false);
        });

        it("empty or missing titles, non-finite times: false, never a throw", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          expect(pair({ title: "", ms: t }, { title: SPAIN_MEMBER, ms: t })).toBe(false);
          expect(pair({ title: SPAIN_NEW, ms: t }, { title: "", ms: t })).toBe(false);
          expect(pair({ title: undefined as unknown as string, ms: t }, { title: null as unknown as string, ms: t })).toBe(false);
          expect(pair({ title: SPAIN_NEW, ms: Number.NaN }, { title: SPAIN_MEMBER, ms: t })).toBe(false);
          expect(pair({ title: SPAIN_NEW, ms: t }, { title: SPAIN_MEMBER, ms: Number.POSITIVE_INFINITY })).toBe(false);
        });

        it("a huge title is clipped to HEADLINE_TITLE_MAX_CHARS: a named subject past the clip does not count", async () => {
          const pair = await updatePair();
          const t = Date.parse("2026-11-04T12:00:00Z");
          // Three shared stems up front, the only capitalised shared word past character 300.
          const head = "kaza istifa etti ";
          const pad = "dolgu ".repeat(Math.ceil(HEADLINE_TITLE_MAX_CHARS / 6) + 5);
          const clipped = `${head}${pad}Puente`;
          expect(clipped.indexOf("Puente")).toBeGreaterThan(HEADLINE_TITLE_MAX_CHARS);
          expect(pair({ title: clipped, ms: t }, { title: clipped, ms: t - 5 * MIN })).toBe(false);
          // Control: the same word inside the first 300 characters does fire.
          const early = `Puente ${head}${pad}`;
          expect(pair({ title: early, ms: t }, { title: early, ms: t - 5 * MIN })).toBe(true);
          // A 200k-character title is cheap and still a boolean.
          const started = Date.now();
          expect(typeof pair({ title: "Kelime ".repeat(30_000), ms: t }, { title: SPAIN_MEMBER, ms: t })).toBe("boolean");
          expect(Date.now() - started).toBeLessThan(1000);
        });
      });

      describe("hits: the live twins", () => {
        for (const h of HITS) {
          it(`${h.name}, ENFORCE=true -> skipped, no cluster, one cluster_skip_log row with reason ${UPDATE_REASON}`, async () => {
            updateFlag.override = true;
            seedHit(h);

            const body = await drain();

            // Non-vacuous: the big cluster really was scored and source-blocked.
            expect(scoredAgainst()).toContain("fp-c1s");
            expect(body.skipped).toBe(1);
            expect(body.created).toBe(0);
            expect(body.matched).toBe(0);
            expect(body.failedTransient).toBe(0);
            expect(body.sameSourceUpdateShadow).toBe(0);
            expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
            expect(supabaseFakeCalls.insert("cluster_articles")).toHaveLength(0);
            expect(linkedClusters()).toEqual([]);
            expect(pgmqState.archived).toContain(4501);
            const rows = skipLogRows();
            expect(rows).toHaveLength(1);
            expect(rows[0]).toMatchObject({ article_id: "art-twin", cluster_id: "c1", reason: UPDATE_REASON });
            expect(rows[0]?.score as number).toBeCloseTo(h.score, 5);
            expect(skipLogs()).toHaveLength(1);
            expect(String(skipLogs()[0]?.[0])).toContain("evidence=same-source-update");
            expect(shadowLogs()).toHaveLength(0);
          });

          it(`${h.name}, ENFORCE=false (shadow) -> a cluster is still created, sameSourceUpdateShadow=1, the log line names article / cluster / member / score`, async () => {
            updateFlag.override = false;
            seedHit(h);

            const body = await drain();

            expect(scoredAgainst()).toContain("fp-c1s");
            expect(body.created).toBe(1);
            expect(body.skipped).toBe(0);
            expect(body.matched).toBe(0);
            expect(body.sameSourceUpdateShadow).toBe(1);
            expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
            expect(linkedClusters()).toEqual([]);
            expect(skipLogs()).toHaveLength(0);
            expect(skipLogWrites()).toHaveLength(0);
            expect(shadowLogs()).toHaveLength(1);
            expect(String(shadowLogs()[0]?.[0])).toBe(
              `[cluster-consumer] same-source-update shadow article=art-twin cluster=c1 member=c1-mem score=${h.score.toFixed(3)}`,
            );
          });
        }

        it("the member may be the SEED row alone: a 52-member cluster whose oldest member (outside the newest-48 scan list) is the source's own", async () => {
          updateFlag.override = true;
          const members = [
            { id: "c1-seed", sourceId: "src-outlet", fp: "fp-c1s", ageMs: 5 * 60 * MIN, title: SPAIN_MEMBER },
            ...Array.from({ length: 51 }, (_, i) => ({
              id: `c1-f${i}`,
              sourceId: "src-wire",
              fp: `fp-c1f${i}`,
              ageMs: (4 * 60 - i * 3) * MIN,
              title: `Dolgu${String.fromCharCode(97 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))} haberi sürüyor`,
              // The headlines stay unrelated (only the seed row may carry the evidence), but the cluster is one
              // story: the centroid guard (h70-mergequality-2) reads the newest members' text, and a
              // 52-member cluster whose members share nothing with the article would be passed over by it.
              description: "İspanya'da 69 kişinin öldüğü tren kazası sonrası Ulaştırma Bakanı Puente istifa etti.",
            })),
          ];
          seedCluster("c1", 52, members, { title: SPAIN_MEMBER });
          queueIncoming({ sourceId: "src-outlet", title: SPAIN_NEW, msgId: 4502 });
          scoreBy({ "fp-c1s": 0.62 });

          const body = await drain();

          expect(HEADLINE_MEMBER_SCAN_MAX).toBeLessThan(members.length);
          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(skipLogRows()).toMatchObject([{ cluster_id: "c1", reason: UPDATE_REASON }]);
        });
      });

      describe("negative controls: no skip, no shadow hit, a cluster is created (both ENFORCE settings)", () => {
        const CONTROLS: Array<{ name: string; hit: Hit }> = [
          {
            name: "Guler vs Fidan: the subject veto fires (30 min apart, same Hirvatistan template)",
            hit: { name: "hr", member: HR_MEMBER, incoming: HR_NEW, memberAgeMs: 30 * MIN, seedTitle: "Hırvatistan Meclis Başkanı Ankara'da ağırlandı", score: 0.62 },
          },
          {
            name: "Erdogan Korea, the member is 11 h older (outside the 6 h window)",
            hit: { name: "korea", member: KOREA_MEMBER, incoming: KOREA_NEW, memberAgeMs: 11 * 60 * MIN, seedTitle: "Güney Kore ziyareti sürüyor", score: 0.62 },
          },
          {
            name: "Spain pair, but the cluster scores 0.39 (below MATCH_THRESHOLD)",
            hit: { ...HITS[0]!, score: 0.39 },
          },
          {
            name: "Spain pair, 0.30",
            hit: { ...HITS[0]!, score: 0.3 },
          },
        ];
        for (const enforce of [true, false]) {
          for (const c of CONTROLS) {
            it(`ENFORCE=${enforce}: ${c.name}`, async () => {
              updateFlag.override = enforce;
              seedHit(c.hit);

              const body = await drain();

              expect(scoredAgainst()).toContain("fp-c1s");
              expect(body.created).toBe(1);
              expect(body.skipped).toBe(0);
              expect(body.sameSourceUpdateShadow).toBe(0);
              expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
              expect(skipLogs()).toHaveLength(0);
              expect(skipLogWrites()).toHaveLength(0);
              expect(shadowLogs()).toHaveLength(0);
            });
          }
        }

        it("a source the cluster does not hold simply joins it: the new evidence only ever speaks for a blocked source", async () => {
          updateFlag.override = true;
          seedHit(HITS[0]!, { incomingSourceId: "src-posta" });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          expect(body.skipped).toBe(0);
          expect(linkedClusters()).toEqual(["c1"]);
          expect(skipLogWrites()).toHaveLength(0);
        });

        it("another cluster that takes the article ends the story: no skip, and a shadow hit is not counted", async () => {
          updateFlag.override = false;
          seedHit(HITS[0]!);
          seedCluster("c2", 3, [{ id: "c2-m", sourceId: "src-posta", fp: "fp-c2", ageMs: 20 * MIN, title: SPAIN_NEW }], { title: SPAIN_NEW });
          scoreBy({ "fp-c1s": 0.62, "fp-c1m": 0.1, "fp-c2": 0.5 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          expect(linkedClusters()).toEqual(["c2"]);
          expect(body.sameSourceUpdateShadow).toBe(0);
          expect(shadowLogs()).toHaveLength(0);
        });
      });

      describe("priority: the existing kinds keep it", () => {
        const LANE_VARIANT = "İsrail Merkez Seçim Komitesi 27 Ekim seçim sonuçlarını 15 lehte oyla resmen onayladı";

        /** c1: update evidence (3 h older member); c2: a member that fires the headline lane against the incoming title. */
        function seedTwoClusters(first: "update" | "lane") {
          expect(headlineLane(headlineTokens(ISRAEL_NEW), headlineTokens(LANE_VARIANT), 0.3).fired).toBe(true);
          expect(normalizeTurkish(ISRAEL_NEW)).not.toBe(normalizeTurkish(LANE_VARIANT));
          const updateCluster = first === "update" ? "c1" : "c2";
          const laneCluster = first === "update" ? "c2" : "c1";
          const sizes = first === "update" ? [18, 7] : [7, 18];
          // The bigger cluster is tried first when both score inside the 0.10 margin.
          seedCluster(updateCluster, sizes[0]!, [
            { id: `${updateCluster}-s`, sourceId: "src-wire", fp: `fp-${updateCluster}s`, ageMs: 5 * 60 * MIN, title: "İsrail seçimlerinde sayım sürüyor" },
            { id: `${updateCluster}-m`, sourceId: "src-outlet", fp: `fp-${updateCluster}m`, ageMs: 3 * 60 * MIN, title: ISRAEL_MEMBER },
          ], { title: ISRAEL_MEMBER });
          seedCluster(laneCluster, sizes[1]!, [
            { id: `${laneCluster}-s`, sourceId: "src-wire", fp: `fp-${laneCluster}s`, ageMs: 2 * 60 * MIN, title: "İsrail seçimlerinde sayım sürüyor" },
            { id: `${laneCluster}-m`, sourceId: "src-outlet", fp: `fp-${laneCluster}m`, ageMs: 20 * MIN, title: LANE_VARIANT },
          ], { title: LANE_VARIANT });
          queueIncoming({ sourceId: "src-outlet", title: ISRAEL_NEW, msgId: 4511 });
          scoreBy({
            [`fp-${updateCluster}s`]: 0.87,
            [`fp-${updateCluster}m`]: 0.1,
            [`fp-${laneCluster}s`]: 0.8,
            [`fp-${laneCluster}m`]: 0.1,
          });
          return { updateCluster, laneCluster };
        }

        for (const first of ["update", "lane"] as const) {
          for (const enforce of [true, false]) {
            it(`ENFORCE=${enforce}: update evidence on the ${first === "update" ? "first" : "second"} cluster, headline-lane evidence on the ${first === "update" ? "second" : "first"} -> the skip records the lane`, async () => {
              updateFlag.override = enforce;
              const { laneCluster } = seedTwoClusters(first);

              const body = await drain();

              expect(body.skipped).toBe(1);
              expect(body.created).toBe(0);
              expect(body.sameSourceUpdateShadow).toBe(0);
              expect(skipLogRows()).toMatchObject([{ cluster_id: laneCluster, reason: "same-source-duplicate/headline-lane" }]);
              expect(shadowLogs()).toHaveLength(0);
            });
          }
        }

        it("ENFORCE=false: two clusters with update evidence count ONE shadow hit and log the first", async () => {
          updateFlag.override = false;
          seedCluster("c1", 18, [
            { id: "c1-s", sourceId: "src-wire", fp: "fp-c1s", ageMs: 5 * 60 * MIN, title: "İsrail seçimlerinde sayım sürüyor" },
            { id: "c1-m", sourceId: "src-outlet", fp: "fp-c1m", ageMs: 3 * 60 * MIN, title: ISRAEL_MEMBER },
          ], { title: ISRAEL_MEMBER });
          seedCluster("c2", 7, [
            { id: "c2-s", sourceId: "src-wire", fp: "fp-c2s", ageMs: 5 * 60 * MIN, title: "İsrail seçimlerinde sayım sürüyor" },
            { id: "c2-m", sourceId: "src-outlet", fp: "fp-c2m", ageMs: 2 * 60 * MIN, title: ISRAEL_MEMBER },
          ], { title: ISRAEL_MEMBER });
          queueIncoming({ sourceId: "src-outlet", title: ISRAEL_NEW, msgId: 4512 });
          scoreBy({ "fp-c1s": 0.87, "fp-c1m": 0.1, "fp-c2s": 0.8, "fp-c2m": 0.1 });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(body.sameSourceUpdateShadow).toBe(1);
          expect(shadowLogs()).toHaveLength(1);
          expect(String(shadowLogs()[0]?.[0])).toContain("cluster=c1 member=c1-m");
        });
      });

      describe("dry run (admission shadow)", () => {
        it("ENFORCE=true: the follow-up is skipped like any other same-source duplicate, no skip-log write", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          updateFlag.override = true;
          seedCluster("c1", 34, [
            { id: "c1-s", sourceId: "src-wire", fp: "fp-c1s", ageMs: 100 * MIN, title: "İspanya'da tren kazası: Ulaştırma Bakanı Puente istifasını açıkladı" },
            { id: "c1-m", sourceId: "src-outlet", fp: "fp-c1m", ageMs: 9 * MIN, title: SPAIN_MEMBER },
          ], { title: SPAIN_MEMBER });
          queueIncoming({ sourceId: "src-outlet", title: SPAIN_NEW, category: "ekonomi", admit: "shadow", msgId: 4521 });
          scoreBy({ "fp-c1s": 0.62, "fp-c1m": 0.1 });

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.admission.would_create).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(skipLogWrites()).toHaveLength(0);
          expect(skipLogs()).toHaveLength(1);
          expect(String(skipLogs()[0]?.[0])).toContain("evidence=same-source-update");
          expect(String(skipLogs()[0]?.[0])).toContain("dry-run");
        });

        it("ENFORCE=false: would_create as before, the shadow line carries `dry-run` and the live counter stays 0", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          updateFlag.override = false;
          seedCluster("c1", 34, [
            { id: "c1-s", sourceId: "src-wire", fp: "fp-c1s", ageMs: 100 * MIN, title: "İspanya'da tren kazası: Ulaştırma Bakanı Puente istifasını açıkladı" },
            { id: "c1-m", sourceId: "src-outlet", fp: "fp-c1m", ageMs: 9 * MIN, title: SPAIN_MEMBER },
          ], { title: SPAIN_MEMBER });
          queueIncoming({ sourceId: "src-outlet", title: SPAIN_NEW, category: "ekonomi", admit: "shadow", msgId: 4522 });
          scoreBy({ "fp-c1s": 0.62, "fp-c1m": 0.1 });

          const body = await drain();

          expect(body.skipped).toBe(0);
          expect(body.admission.would_create).toBe(1);
          expect(body.sameSourceUpdateShadow).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(skipLogWrites()).toHaveLength(0);
          expect(shadowLogs()).toHaveLength(1);
          expect(String(shadowLogs()[0]?.[0])).toContain("dry-run");
        });
      });

      it("the drain summary always carries sameSourceUpdateShadow (0 when nothing was shadowed)", async () => {
        queueIncoming({ sourceId: "src-wire" });
        scoreBy({});

        const body = await drain();

        expect(body.sameSourceUpdateShadow).toBe(0);
      });
    });

    // ---- h19-recall-2: stem-overlap probe (migration 146) ----------------------
    //
    // The exact-title probe (T4) keys on md5(tayf_search_fold(title)), which keeps
    // punctuation: 'İsrail’de Arap partilerinden Netanyahu karşıtı bloğa destek
    // mesajı' and the same title with a trailing '!' (singletons 8947d162 and
    // bb7517ca, 4.4 h apart) never met, nor did 'Mutlu bir yuva önceliğimdi' and
    // its quoted twin (f3f6c1c4 / 69df216b). Once per article, and only when no
    // candidate reached FALLBACK_FLOOR, the consumer now sends the headline stems
    // to public.cluster_stem_probe (migration 146), loads what it returns into the
    // context and scores it normally: the 0.40 bar is unchanged.
    describe("h19-recall-2: stem-overlap probe reaches older clusters past punctuation differences", () => {
      const ISRAIL = "İsrail’de Arap partilerinden Netanyahu karşıtı bloğa destek mesajı";
      const MUTLU = "Mutlu bir yuva önceliğimdi";
      const OTHER_TITLE = "Bakanlar Kurulu toplantısı sona erdi, kararlar açıklandı";

      const stemCalls = () => supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_stem_probe");
      const stemWarnings = () =>
        warnSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("cluster_stem_probe"));
      const stemJoinLogs = () =>
        logSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("stem-probe join"));
      const scoredAgainst = () =>
        vi.mocked(scoreMock).mock.calls.map((c) => (c[1] as { strict?: string | null } | null | undefined)?.strict);
      const skipLogRows = () =>
        supabaseFakeCalls
          .upsert("cluster_skip_log")
          .flatMap((m) => m.patch as Array<Record<string, unknown>>);

      type StemRow = {
        id: string;
        title_tr: string;
        title_tr_neutral: null;
        first_published: string;
        updated_at: string;
        article_count: number;
      };
      function stemRow(id: string, title: string, ageMs: number, articleCount = 1): StemRow {
        return {
          id,
          title_tr: title,
          title_tr_neutral: null,
          first_published: ago(ageMs),
          updated_at: ago(ageMs),
          article_count: articleCount,
        };
      }
      /** An out-of-context singleton (not among the context fixtures) and the row the rpc would return for it. */
      function seedStemHit(id: string, title: string, fp: string, sourceId = "src-wire", ageMs = 4.4 * H): StemRow {
        seedCluster(id, 1, [{ id: `${id}-m`, sourceId, fp, ageMs, title }], {
          title,
          updatedAgoMs: ageMs,
          inContext: false,
        });
        return stemRow(id, title, ageMs);
      }
      function stemProbeReturns(...rows: unknown[]) {
        rpcFixtures.cluster_stem_probe = () => ({ data: rows, error: null });
      }

      describe("joins", () => {
        it("Israel: the '!' title joins the out-of-context singleton titled without it (0.82); rpc args are (stems, ~24 h ago, 3)", async () => {
          const title = `${ISRAIL}!`;
          stemProbeReturns(seedStemHit("cl-israil", ISRAIL, "fp-israil"));
          queueIncoming({ id: "israil-new", sourceId: "src-outlet", title });
          scoreBy({ "fp-israil": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          expect(body.failedTransient).toBe(0);
          expect(linkedClusters()).toEqual(["cl-israil"]);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          // Premise: the exact-title probe asked first and found nothing (the '!' changes its key).
          expect(probeCalls()).toHaveLength(1);

          const calls = stemCalls();
          expect(calls).toHaveLength(1);
          const args = calls[0]?.args as { p_stems: string[]; p_since: string; p_limit: number };
          expect(args.p_stems).toEqual([...headlineTokens(title).tokens]);
          expect(args.p_stems.length).toBeGreaterThanOrEqual(3);
          expect(args.p_limit).toBe(3);
          expect(Math.abs(Date.parse(args.p_since) - (Date.now() - 24 * H))).toBeLessThan(5 * 60_000);

          const logs = stemJoinLogs();
          expect(logs).toHaveLength(1);
          const line = String(logs[0]?.[0]);
          expect(line).toContain("[cluster-consumer] stem-probe join");
          expect(line).toContain("article=israil-new");
          expect(line).toContain("cluster=cl-israil");
          expect(line).toContain("score=0.820");
        });

        it("the loaded cluster is scored against the corpus that now holds it (tf-idf cosine > 0 for an identical text)", async () => {
          stemProbeReturns(seedStemHit("cl-israil", ISRAIL, "fp-israil"));
          queueIncoming({ id: "israil-new", sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({ "fp-israil": 0.82 });

          await drain();

          const call = vi.mocked(scoreMock).mock.calls.find(
            (c) => (c[1] as { strict?: string | null } | null | undefined)?.strict === "fp-israil",
          );
          expect(call, "the stem hit was scored").toBeDefined();
          // 5th argument of score(): the tf-idf cosine of the incoming text against the cluster's seed.
          expect(call?.[4] as number).toBeGreaterThan(0.5);
        });

        it("'Mutlu bir yuva' (quoted against unquoted) joins in the same way", async () => {
          const title = `"${MUTLU}"`;
          expect(headlineTokens(title).tokens.size).toBe(3);
          stemProbeReturns(seedStemHit("cl-mutlu", MUTLU, "fp-mutlu", "src-posta", 21 * H));
          queueIncoming({ id: "mutlu-new", sourceId: "src-cnn-turk", title });
          scoreBy({ "fp-mutlu": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          expect(linkedClusters()).toEqual(["cl-mutlu"]);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(stemCalls()).toHaveLength(1);
          expect((stemCalls()[0]?.args as { p_stems: string[] }).p_stems).toEqual(["mutlu", "yuva", "onceligim"]);
        });

        it("the loaded cluster stays in the context: a second article of the same drain joins it without another probe", async () => {
          stemProbeReturns(seedStemHit("cl-israil", ISRAIL, "fp-israil"));
          queueIncoming({ id: "israil-a", sourceId: "src-outlet", title: `${ISRAIL}!` });
          queueIncoming({ id: "israil-b", sourceId: "src-cnn-turk", title: `${ISRAIL}?` });
          scoreBy({ "fp-israil": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(2);
          expect(body.created).toBe(0);
          expect(linkedClusters()).toEqual(["cl-israil", "cl-israil"]);
          expect(stemCalls()).toHaveLength(1);
        });

        for (const s of [0.4, 0.41]) {
          it(`a stem hit at ${s} (MATCH_THRESHOLD or better) joins`, async () => {
            stemProbeReturns(seedStemHit("cl-x", ISRAIL, "fp-x"));
            queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
            scoreBy({ "fp-x": s });

            const body = await drain();

            expect(body.matched).toBe(1);
            expect(linkedClusters()).toEqual(["cl-x"]);
          });
        }

        it("only the first 3 rows of the rpc are considered, in the order the database ranked them", async () => {
          const rows = ["cl-1", "cl-2", "cl-3", "cl-4", "cl-5"].map((id, i) =>
            seedStemHit(id, ISRAIL, `fp-${id}`, "src-wire", (3 + i) * H),
          );
          stemProbeReturns(...rows);
          queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({});

          const body = await drain();

          expect(body.created).toBe(1);
          expect(clusterArticleEqReads).toEqual(["cl-1", "cl-2", "cl-3"]);
        });

        it("the larger of two near-equal hits wins (sizes of clusters loaded by the probe count)", async () => {
          const small = seedStemHit("cl-small", ISRAIL, "fp-small", "src-wire", 4 * H);
          const big = { ...seedStemHit("cl-big", ISRAIL, "fp-big", "src-agg", 5 * H), article_count: 18 };
          stemProbeReturns(small, big);
          queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({ "fp-small": 0.85, "fp-big": 0.8 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cl-big"]);
        });
      });

      describe("no join: the 0.40 bar is unchanged", () => {
        for (const s of [0.3, 0.38, 0.399]) {
          it(`a stem hit scoring ${s} is loaded and scored but not joined: the article opens a cluster`, async () => {
            stemProbeReturns(seedStemHit("cl-x", ISRAIL, "fp-x"));
            queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
            scoreBy({ "fp-x": s });

            const body = await drain();

            expect(clusterArticleEqReads).toContain("cl-x"); // loaded
            expect(scoredAgainst()).toContain("fp-x"); // scored
            expect(body.created).toBe(1);
            expect(body.matched).toBe(0);
            expect(body.skipped).toBe(0);
            expect(linkedClusters()).toEqual([]);
            expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
            expect(stemJoinLogs()).toHaveLength(0);
          });
        }

        it("an empty rpc result changes nothing: the article opens a cluster", async () => {
          queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({});

          const body = await drain();

          expect(stemCalls()).toHaveLength(1);
          expect(body.created).toBe(1);
          expect(stemWarnings()).toHaveLength(0);
        });

        it("a null / non-array payload and malformed rows are treated as no hit, without a warning", async () => {
          rpcFixtures.cluster_stem_probe = () => ({ data: null, error: null });
          queueIncoming({ id: "a", sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({});
          let body = await drain();
          expect(body.created).toBe(1);

          rpcFixtures.cluster_stem_probe = () => ({ data: [null, {}, { id: 7 }, "x"], error: null });
          queueIncoming({ id: "b", sourceId: "src-outlet", title: OTHER_TITLE, msgId: 4999 });
          body = await drain();

          expect(body.created).toBe(1);
          expect(stemWarnings()).toHaveLength(0);
          expect(clusterArticleEqReads).toEqual([]);
        });

        it("a hit whose members cannot be read warns and is skipped; the article still gets a cluster", async () => {
          stemProbeReturns(seedStemHit("cl-broken", ISRAIL, "fp-broken"));
          clusterArticlesFailure.clusterId = "cl-broken";
          queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({ "fp-broken": 0.9 });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(body.failedTransient).toBe(0);
          expect(linkedClusters()).toEqual([]);
          expect(
            warnSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("cl-broken")),
          ).toHaveLength(1);
        });

        it("a hit with no politics members is ignored (nothing to score)", async () => {
          seedCluster("cl-eko", 1, [{ id: "eko-m", sourceId: "src-wire", fp: "fp-eko", title: ISRAIL, category: "ekonomi" }], {
            title: ISRAIL,
            inContext: false,
          });
          stemProbeReturns(stemRow("cl-eko", ISRAIL, H));
          queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({ "fp-eko": 0.9 });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(linkedClusters()).toEqual([]);
        });
      });

      describe("rpc failures degrade silently", () => {
        for (const mode of ["error envelope", "throw"] as const) {
          it(`an rpc ${mode}: one warning per isolate naming cluster_stem_probe, both articles are created, none fails`, async () => {
            rpcFixtures.cluster_stem_probe =
              mode === "throw"
                ? () => {
                    throw new Error("network down");
                  }
                : () => ({ data: null, error: { message: "canceling statement due to statement timeout" } });
            queueIncoming({ id: "isr-a", sourceId: "src-cnn-turk", title: `${ISRAIL}!` });
            queueIncoming({ id: "other-b", sourceId: "src-posta", title: OTHER_TITLE });
            scoreBy({});

            const body = await drain();

            expect(stemCalls()).toHaveLength(2);
            expect(stemWarnings()).toHaveLength(1);
            expect(String(stemWarnings()[0]?.[0])).toContain("continuing without it");
            expect(body.created).toBe(2);
            expect(body.failedTransient).toBe(0);
          });
        }

        it("the warning names the failure", async () => {
          rpcFixtures.cluster_stem_probe = () => ({ data: null, error: { message: "function public.cluster_stem_probe does not exist" } });
          queueIncoming({ sourceId: "src-cnn-turk", title: `${ISRAIL}!` });
          scoreBy({});

          await drain();

          expect(String(stemWarnings()[0]?.[0])).toContain("does not exist");
        });
      });

      describe("when the probe is NOT called", () => {
        for (const [s, field] of [
          [0.37, "created"],
          [0.85, "matched"],
        ] as const) {
          it(`a candidate at ${s} reached FALLBACK_FLOOR (0.36): the article ${field === "created" ? "opens a cluster" : "joins"} and the stem probe is not asked`, async () => {
            seedCluster("c1", 3, [{ id: "c1-m", sourceId: "src-wire", fp: "fp-c1" }]);
            queueIncoming({ sourceId: "src-outlet" });
            scoreBy({ "fp-c1": s });

            const body = await drain();

            expect(body[field]).toBe(1);
            expect(stemCalls()).toHaveLength(0);
          });
        }

        it("boundary: a candidate at 0.35 is below FALLBACK_FLOOR, so the probe is asked once", async () => {
          seedCluster("c1", 3, [{ id: "c1-m", sourceId: "src-wire", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-outlet" });
          scoreBy({ "fp-c1": 0.35 });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(stemCalls()).toHaveLength(1);
        });

        it("a dry run (admission shadow) never asks, and still reports would_create", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          stemProbeReturns(seedStemHit("cl-israil", ISRAIL, "fp-israil"));
          queueIncoming({ id: "isr-dry", sourceId: "src-outlet", title: `${ISRAIL}!`, category: "ekonomi", admit: "shadow" });
          scoreBy({ "fp-israil": 0.9 });

          const body = await drain();

          expect(stemCalls()).toHaveLength(0);
          expect(body.admission.would_create).toBe(1);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(clusterArticleEqReads).toEqual([]);
        });

        for (const title of ["CANLI", "Meclis tatilde", "Mutlu yuva"]) {
          it(`a headline with fewer than ${3} tokens ("${title}") never asks`, async () => {
            expect(headlineTokens(title).tokens.size).toBeLessThan(3);
            queueIncoming({ sourceId: "src-outlet", title });
            scoreBy({});

            const body = await drain();

            expect(stemCalls()).toHaveLength(0);
            expect(body.created).toBe(1);
          });
        }

        it("the strict-fingerprint fast path joined the article: neither probe is asked", async () => {
          seedCluster("c1", 3, [{ id: "c1-m", sourceId: "src-wire", fp: strictFingerprint(HEADLINE, "Detay") }]);
          queueIncoming({ sourceId: "src-outlet" });
          scoreBy({});

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["c1"]);
          expect(stemCalls()).toHaveLength(0);
          expect(probeCalls()).toHaveLength(0);
        });

        it("a same-source duplicate skip (fast path, nothing else to join) decided the article: the stem probe is not asked", async () => {
          stemProbeReturns(seedStemHit("cl-other", HEADLINE, "fp-other"));
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: strictFingerprint(HEADLINE, "Detay") }]);
          queueIncoming({ sourceId: "src-outlet", msgId: 4401 });
          scoreBy({});

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(stemCalls()).toHaveLength(0);
          expect(clusterArticleEqReads).toEqual([]);
        });

        it("a same-source duplicate skip by score (0.87 against a cluster holding the source): not asked", async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          queueIncoming({ sourceId: "src-outlet", msgId: 4402 });
          scoreBy({ "fp-c1": 0.87 });

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(stemCalls()).toHaveLength(0);
        });

        it("a stem hit that is already in ctx.clusters is not reloaded or scored a second time", async () => {
          // In the context, but its score (0.30) is below FALLBACK_FLOOR, so the probe runs and returns it again.
          seedCluster("c-ctx", 1, [{ id: "ctx-m", sourceId: "src-wire", fp: "fp-ctx", title: ISRAIL }], { title: ISRAIL });
          stemProbeReturns(stemRow("c-ctx", ISRAIL, H));
          queueIncoming({ sourceId: "src-outlet", title: `${ISRAIL}!` });
          scoreBy({ "fp-ctx": 0.3 });

          const body = await drain();

          expect(stemCalls()).toHaveLength(1);
          expect(clusterArticleEqReads).not.toContain("c-ctx");
          expect(scoredAgainst().filter((fp) => fp === "fp-ctx")).toHaveLength(1);
          expect(body.created).toBe(1);
        });
      });

      describe("same-source duplicates found by the probe are skipped, not twinned", () => {
        it("the hit already holds the article's source: skipped, logged with exact-title evidence, nothing created", async () => {
          stemProbeReturns(seedStemHit("cl-israil", ISRAIL, "fp-israil", "src-posta"));
          queueIncoming({ id: "isr-posta-2", sourceId: "src-posta", title: `${ISRAIL}!`, msgId: 4411 });
          scoreBy({ "fp-israil": 0.82 });

          const body = await drain();

          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
          expect(body.matched).toBe(0);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(linkedClusters()).toEqual([]);
          expect(pgmqState.archived).toContain(4411);
          expect(skipLogs()).toHaveLength(1);
          expect(String(skipLogs()[0]?.[0])).toContain("evidence=exact-title");
          expect(skipLogRows()).toMatchObject([
            { article_id: "isr-posta-2", cluster_id: "cl-israil", reason: "same-source-duplicate/exact-title" },
          ]);
          expect(stemJoinLogs()).toHaveLength(0);
        });

        it("a blocked first hit does not stop the second: it joins the hit that does not hold the source", async () => {
          const blocked = seedStemHit("cl-posta", ISRAIL, "fp-posta", "src-posta", 4 * H);
          const free = seedStemHit("cl-wire", ISRAIL, "fp-wire", "src-wire", 5 * H);
          stemProbeReturns(blocked, free);
          queueIncoming({ sourceId: "src-posta", title: `${ISRAIL}!` });
          scoreBy({ "fp-posta": 0.9, "fp-wire": 0.8 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.skipped).toBe(0);
          expect(linkedClusters()).toEqual(["cl-wire"]);
          expect(skipLogs()).toHaveLength(0);
        });
      });
    });

    // ---- h19-recall-3: twin-bridge evidence (migration 147) --------------------
    //
    // rankCandidates already sees a twin pair as a multi-candidate decision and
    // used to throw that information away. When two or more candidates score at
    // least TWIN_BRIDGE_MIN_SCORE (0.55) for one article, the consumer records the
    // pairs in cluster_twin_bridges (best-effort, awaited, shadow evidence only: no
    // merge). It never changes the join / skip / create decision.
    describe("h19-recall-3: twin bridges are recorded for multi-candidate articles", () => {
      const bridgeWrites = () => supabaseFakeCalls.forTable("cluster_twin_bridges");
      const bridgeRows = () =>
        supabaseFakeCalls
          .upsert("cluster_twin_bridges")
          .flatMap((m) => m.patch as Array<Record<string, unknown>>);
      const bridgeWarnings = () =>
        warnSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("cluster_twin_bridges"));
      const BRIDGE_OPTIONS = { onConflict: "article_id,cluster_a,cluster_b", ignoreDuplicates: true };
      const byPair = (rows: Array<Record<string, unknown>>) =>
        [...rows].sort((x, y) =>
          `${x.cluster_a}|${x.cluster_b}` < `${y.cluster_a}|${y.cluster_b}` ? -1 : 1,
        );

      it("TWIN_BRIDGE_MIN_SCORE equals TWIN_MERGE_MIN_BRIDGE_SCORE of _shared/cluster/twin-merge.ts (that decision reads these rows)", () => {
        const read = (rel: string) => readFileSync(resolve(__dirname, "..", "..", rel), "utf8");
        const consumer = /const\s+TWIN_BRIDGE_MIN_SCORE\s*=\s*([0-9.]+)\s*;/.exec(
          read("supabase/functions/cluster-consumer/index.ts"),
        );
        const merge = /export\s+const\s+TWIN_MERGE_MIN_BRIDGE_SCORE\s*=\s*([0-9.]+)\s*;/.exec(
          read("supabase/functions/_shared/cluster/twin-merge.ts"),
        );
        expect(consumer, "TWIN_BRIDGE_MIN_SCORE not found in the consumer").not.toBeNull();
        expect(merge, "TWIN_MERGE_MIN_BRIDGE_SCORE not found in twin-merge.ts").not.toBeNull();
        expect(Number((consumer as RegExpExecArray)[1])).toBe(0.55);
        expect(Number((consumer as RegExpExecArray)[1])).toBe(Number((merge as RegExpExecArray)[1]));
      });

      it("0.87 and 0.83: exactly one upsert with the ordered pair and the lower score; the join outcome is T1b's", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.87, "fp-c2": 0.83 });

        const body = await drain();

        // unchanged outcome (T1b)
        expect(body.matched).toBe(1);
        expect(body.skipped).toBe(0);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual(["c2"]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
        expect(skipLogs()).toHaveLength(0);
        // the evidence
        expect(bridgeWrites()).toHaveLength(1);
        expect(bridgeWrites()[0]?.op).toBe("upsert");
        expect(bridgeRows()).toEqual([{ article_id: "art-twin", cluster_a: "c1", cluster_b: "c2", score: 0.83 }]);
        expect(twinBridgeFake.upsertOptions).toEqual([BRIDGE_OPTIONS]);
        expect(bridgeWarnings()).toHaveLength(0);
      });

      it("cluster_a is the smaller id whichever cluster scored higher", async () => {
        seedCluster("c9", 18, [{ id: "c9-m", sourceId: "src-outlet", fp: "fp-c9" }]);
        seedCluster("c3", 7, [{ id: "c3-m", sourceId: "src-wire", fp: "fp-c3" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c9": 0.87, "fp-c3": 0.83 });

        await drain();

        expect(bridgeRows()).toEqual([{ article_id: "art-twin", cluster_a: "c3", cluster_b: "c9", score: 0.83 }]);
      });

      it("ids are lower-cased before they are ordered (the join keeps the id it was given)", async () => {
        seedCluster("CL-B", 18, [{ id: "clb-m", sourceId: "src-outlet", fp: "fp-clb" }]);
        seedCluster("cl-a", 7, [{ id: "cla-m", sourceId: "src-wire", fp: "fp-cla" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-clb": 0.87, "fp-cla": 0.83 });

        await drain();

        expect(bridgeRows()).toEqual([{ article_id: "art-twin", cluster_a: "cl-a", cluster_b: "cl-b", score: 0.83 }]);
        expect(linkedClusters()).toEqual(["cl-a"]);
      });

      it("three candidates at or above 0.55: three pair rows, each carrying the lower score of its pair", async () => {
        seedCluster("c1", 5, [{ id: "c1-m", sourceId: "src-agg", fp: "fp-c1" }]);
        seedCluster("c2", 5, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        seedCluster("c3", 5, [{ id: "c3-m", sourceId: "src-posta", fp: "fp-c3" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.9, "fp-c2": 0.8, "fp-c3": 0.7 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(linkedClusters()).toEqual(["c1"]);
        expect(bridgeWrites()).toHaveLength(1);
        expect(byPair(bridgeRows())).toEqual([
          { article_id: "art-twin", cluster_a: "c1", cluster_b: "c2", score: 0.8 },
          { article_id: "art-twin", cluster_a: "c1", cluster_b: "c3", score: 0.7 },
          { article_id: "art-twin", cluster_a: "c2", cluster_b: "c3", score: 0.7 },
        ]);
        expect(twinBridgeFake.upsertOptions).toEqual([BRIDGE_OPTIONS]);
      });

      it("only the top 3 candidates by score are paired (a fourth at 0.6 is left out)", async () => {
        seedCluster("c1", 5, [{ id: "c1-m", sourceId: "src-agg", fp: "fp-c1" }]);
        seedCluster("c2", 5, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        seedCluster("c3", 5, [{ id: "c3-m", sourceId: "src-posta", fp: "fp-c3" }]);
        seedCluster("c4", 5, [{ id: "c4-m", sourceId: "src-cnn-turk", fp: "fp-c4" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.9, "fp-c2": 0.8, "fp-c3": 0.7, "fp-c4": 0.6 });

        await drain();

        const rows = bridgeRows();
        expect(rows).toHaveLength(3);
        expect(rows.some((r) => r.cluster_a === "c4" || r.cluster_b === "c4")).toBe(false);
      });

      it("0.87 and exactly 0.55: the boundary is inclusive", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-wire" });
        scoreBy({ "fp-c1": 0.87, "fp-c2": 0.55 });

        await drain();

        expect(bridgeRows()).toEqual([{ article_id: "art-twin", cluster_a: "c1", cluster_b: "c2", score: 0.55 }]);
      });

      for (const [name, scores] of [
        ["0.87 and 0.549 (second just under the bar)", { "fp-c1": 0.87, "fp-c2": 0.549 }],
        ["a single candidate at 0.87", { "fp-c1": 0.87 }],
        ["two candidates below the bar (0.54, 0.50)", { "fp-c1": 0.54, "fp-c2": 0.5 }],
      ] as const) {
        it(`${name}: no write`, async () => {
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-wire", fp: "fp-c1" }]);
          seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-agg", fp: "fp-c2" }]);
          queueIncoming({ sourceId: "src-outlet" });
          scoreBy(scores);

          await drain();

          expect(bridgeWrites()).toHaveLength(0);
        });
      }

      it("an article that opens a cluster (nothing reached the join bar) writes no bridge for a single weak candidate", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-wire", fp: "fp-c1" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c1": 0.2 });

        const body = await drain();

        expect(body.created).toBe(1);
        expect(bridgeWrites()).toHaveLength(0);
      });

      it("evidence is recorded even when the article is then skipped as a same-source duplicate", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-outlet", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet", msgId: 4421 });
        scoreBy({ "fp-c1": 0.87, "fp-c2": 0.83 });

        const body = await drain();

        expect(body.skipped).toBe(1);
        expect(body.created).toBe(0);
        expect(pgmqState.archived).toContain(4421);
        expect(bridgeRows()).toEqual([{ article_id: "art-twin", cluster_a: "c1", cluster_b: "c2", score: 0.83 }]);
      });

      it("dry run (admission shadow): no write, the would_match outcome is unchanged", async () => {
        process.env.JEV_POLITICS_ADMISSION = "shadow";
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-wire", fp: "fp-c1" }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-agg", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet", category: "ekonomi", admit: "shadow" });
        scoreBy({ "fp-c1": 0.87, "fp-c2": 0.83 });

        const body = await drain();

        expect(body.admission.would_match).toBe(1);
        expect(bridgeWrites()).toHaveLength(0);
        expect(twinBridgeFake.upsertOptions).toEqual([]);
      });

      it("the strict-fingerprint fast path returns before ranking: no write", async () => {
        seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-wire", fp: strictFingerprint(HEADLINE, "Detay") }]);
        seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-agg", fp: "fp-c2" }]);
        queueIncoming({ sourceId: "src-outlet" });
        scoreBy({ "fp-c2": 0.83 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(bridgeWrites()).toHaveLength(0);
      });

      for (const mode of ["error", "throw"] as const) {
        it(`a write ${mode}: one warning per isolate, the outcome is unchanged, nothing fails`, async () => {
          twinBridgeFake.mode = mode;
          seedCluster("c1", 18, [{ id: "c1-m", sourceId: "src-outlet", fp: "fp-c1" }]);
          seedCluster("c2", 7, [{ id: "c2-m", sourceId: "src-wire", fp: "fp-c2" }]);
          queueIncoming({ id: "art-a", sourceId: "src-outlet", msgId: 4431 });
          // A different description: an identical title + description would hit the strict-fingerprint fast path of art-a's join.
          queueIncoming({ id: "art-b", sourceId: "src-posta", msgId: 4432, description: "Farklı bir ayrıntı metni" });
          scoreBy({ "fp-c1": 0.87, "fp-c2": 0.83 });

          const body = await drain();

          expect(bridgeWrites()).toHaveLength(2); // both articles tried
          expect(bridgeWarnings()).toHaveLength(1);
          expect(String(bridgeWarnings()[0]?.[0])).toContain(mode === "error" ? "twin bridges down" : "twin bridges unreachable");
          expect(body.failedTransient).toBe(0);
          expect(body.matched).toBe(2);
          expect(body.created).toBe(0);
          expect(pgmqState.archived).toEqual(expect.arrayContaining([4431, 4432]));
          // art-a: c1 holds src-outlet, so it joins c2 (T1b), exactly as with a healthy table
          expect(linkedClusters()).toHaveLength(2);
          expect(linkedClusters()[0]).toBe("c2");
        });
      }
    });

    // ---- h70-mergequality-3: a lane match across actors is no duplicate evidence ----
    //
    // sameSourceDupEvidence took a raw headline-lane hit against a same-source member as
    // proof that the article is that source's own duplicate. The lane does not cross
    // actors anywhere else (score(), the member scan, the attach probe), so a
    // template-sharing article about another actor must not be skipped as a duplicate
    // either: it opens its own cluster. A 2-member cluster, so the centroid guard (3+
    // members) does not apply.
    describe("h70-mergequality-3: a headline-lane match across actors is no same-source duplicate evidence", () => {
      const WIRE_TITLE = "Cumhurbaşkanı Erdoğan, Karabağ Zaferi'nin 6. yılını kutladı";
      const CELIK_TITLE = "AK Parti Sözcüsü Çelik Karabağ Zaferi'nin 6. yılını kutladı";
      const ERDOGAN_TITLE = "Erdoğan Karabağ Zaferi'nin 6. yılını kutladı";
      const MINUTE = 60_000;

      // src-wire plays the wire member, src-outlet the same-source member the lane fires on.
      function seedKarabag() {
        seedCluster(
          "c-karabag",
          2,
          [
            { id: "ck-wire", sourceId: "src-wire", fp: "fp-ck-seed", ageMs: 50 * MINUTE, title: WIRE_TITLE, description: "Anadolu metni: tören ve konuşma." },
            { id: "ck-outlet", sourceId: "src-outlet", fp: "fp-ck-latest", ageMs: 40 * MINUTE, title: WIRE_TITLE, description: "Akşam metni: tören ve konuşma." },
          ],
          { title: WIRE_TITLE },
        );
      }
      const skipLogWrites = () => supabaseFakeCalls.forTable("cluster_skip_log");
      const skipLogRows = () =>
        supabaseFakeCalls
          .upsert("cluster_skip_log")
          .flatMap((m) => m.patch as Array<Record<string, unknown>>);

      it("premise: the lane fires for both pairs, and only the Çelik title crosses actors", () => {
        expect(headlineLane(headlineTokens(CELIK_TITLE), headlineTokens(WIRE_TITLE), 0.2).fired).toBe(true);
        expect(headlineLane(headlineTokens(ERDOGAN_TITLE), headlineTokens(WIRE_TITLE), 0.2).fired).toBe(true);
        expect(normalizeTurkish(CELIK_TITLE)).not.toBe(normalizeTurkish(WIRE_TITLE));
        expect(actorMismatchFires(CELIK_TITLE, WIRE_TITLE)).toBe(true);
        expect(actorMismatchFires(ERDOGAN_TITLE, WIRE_TITLE)).toBe(false);
      });

      it("the template-sharing article about another actor opens its own cluster: not skipped, nothing logged", async () => {
        seedKarabag();
        queueIncoming({ id: "art-celik", sourceId: "src-outlet", title: CELIK_TITLE, description: "Farklı bir açıklama: Çelik'in basın toplantısı.", msgId: 4901 });
        scoreBy({ "fp-ck-seed": 0.82, "fp-ck-latest": 0.82 });

        const body = await drain();

        expect(body.created).toBe(1);
        expect(body.skipped).toBe(0);
        expect(body.matched).toBe(0);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
        expect(linkedClusters()).toEqual([]);
        expect(skipLogWrites()).toHaveLength(0);
        expect(pgmqState.archived).toContain(4901);
      });

      it("control: the same actor's re-wording is still skipped as same-source-duplicate with headline-lane evidence", async () => {
        seedKarabag();
        queueIncoming({ id: "art-erdogan", sourceId: "src-outlet", title: ERDOGAN_TITLE, description: "Farklı bir açıklama: Erdoğan'ın mesajı.", msgId: 4902 });
        scoreBy({ "fp-ck-seed": 0.82, "fp-ck-latest": 0.82 });

        const body = await drain();

        expect(body.skipped).toBe(1);
        expect(body.created).toBe(0);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
        expect(linkedClusters()).toEqual([]);
        expect(pgmqState.archived).toContain(4902);
        const rows = skipLogRows();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          article_id: "art-erdogan",
          cluster_id: "c-karabag",
          reason: "same-source-duplicate/headline-lane",
        });
      });
    });

    // ---- h114-clusterpurity-4: a generic headline names nobody -----------------
    //
    // 9cb0f088 (the Enver Cevik detention) held cumhuriyet 'Fon sorusturmasinda yeni gozalti',
    // whose description names Omer Murat Gulkan: the headline lane fires on four shared stems
    // for a headline that names nobody, and the member scan saw titles only. The scan now
    // hands both CLEANED descriptions to headlineOnlyScore for a pair the lane fired for.
    describe("h114-clusterpurity-4: generic headline, different people", () => {
      const GENERIC = "Fon soruşturmasında yeni gözaltı";
      const CEVIK_DESC = 'Sermaye piyasası işlemlerine ilişkin "fon" soruşturmasında Enver Çevik gözaltına alındı.';
      const GULKAN_DESC =
        "Fon soruşturması kapsamında OMG Capital Advisors Yönetim Kurulu Başkanı Ömer Murat Gülkan gözaltına alındı.";
      // The stored diken description with its feed wrapper: the guard must read the cleaned text.
      const GULKAN_DIKEN_RAW =
        "Fon soruşturmasında yeni gözaltı 09.11.2026 DikenFon soruşturmasında OMG Capital Advisors Yönetim Kurulu Başkanı Ömer Murat Gülkan gözaltına alındı.\nThe post Fon soruşturmasında yeni gözaltı appeared first on #site_linkat 09.11.2026 .";
      const SEED = "Fon soruşturmasında yeni gelişme: Lydia Holding Yönetim Kurulu Başkanı Enver Çevik gözaltına alındı";
      const LATEST = "Fon soruşturması kapsamında Enver Çevik yeniden gözaltına alındı";
      const SEED_DESC = "Lydia Holding Yönetim Kurulu Başkanı Enver Çevik fon soruşturması kapsamında gözaltına alındı.";

      /** The Cevik cluster: the generic headline is the MIDDLE member (neither seed nor latest). */
      function seedCevik(id = "gn1") {
        seedCluster(
          id,
          3,
          [
            { id: `${id}-seed`, sourceId: "src-agg", fp: `fp-${id}-seed`, ageMs: 50 * 60_000, title: SEED, description: SEED_DESC },
            { id: `${id}-mid`, sourceId: "src-wire", fp: `fp-${id}-mid`, ageMs: 40 * 60_000, title: GENERIC, description: CEVIK_DESC },
            { id: `${id}-latest`, sourceId: "src-posta", fp: `fp-${id}-latest`, ageMs: 30 * 60_000, title: LATEST, description: SEED_DESC },
          ],
          { title: SEED },
        );
      }
      const scanCalls = () =>
        vi.mocked(headlineOnlyScoreMock).mock.calls.map((c) => c[3] as {
          aTitle?: string;
          bTitle?: string;
          aDescription?: string | null;
          bDescription?: string | null;
        });
      const withDescriptions = () => scanCalls().filter((o) => o.aDescription !== undefined || o.bDescription !== undefined);

      beforeEach(() => {
        vi.mocked(headlineOnlyScoreMock).mockClear();
      });

      it("the same generic headline with another person's description opens its own cluster (not joined through the scan)", async () => {
        seedCevik();
        queueIncoming({ id: "art-gulkan", sourceId: "src-outlet", title: GENERIC, description: GULKAN_DESC });
        scoreBy({});

        const body = await drain();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
      });

      it("control: the same headline with the same person's description joins the cluster through the scan", async () => {
        seedCevik();
        queueIncoming({ id: "art-cevik", sourceId: "src-outlet", title: GENERIC, description: CEVIK_DESC });
        scoreBy({});

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual(["gn1"]);
      });

      it("the descriptions are handed over cleaned, and only for the member the lane fired for", async () => {
        seedCevik();
        queueIncoming({ id: "art-gulkan", sourceId: "src-outlet", title: GENERIC, description: GULKAN_DIKEN_RAW });
        scoreBy({});

        await drain();

        const given = withDescriptions();
        // One member of the scan matched the headline (the middle one); the other scan members are not seen with descriptions.
        expect(given).toHaveLength(1);
        expect(given[0]).toMatchObject({ aTitle: GENERIC, bTitle: GENERIC });
        expect(given[0]!.aDescription).toBe(cleanDescription(GULKAN_DIKEN_RAW));
        expect(given[0]!.aDescription).not.toContain("The post");
        expect(given[0]!.bDescription).toBe(CEVIK_DESC);
      });

      it("an unrelated scan never reads a description: no pair, no cleaning", async () => {
        seedCevik();
        queueIncoming({ id: "art-other", sourceId: "src-outlet", title: "Hava bugün parçalı bulutlu geçecek", description: "Meteoroloji yağış beklemiyor." });
        scoreBy({});

        await drain();

        expect(withDescriptions()).toEqual([]);
      });

      it("the full scorer gets both cleaned descriptions only for a seed or latest pair its headline lane fired for", async () => {
        seedCevik();
        queueIncoming({ id: "art-gulkan", sourceId: "src-outlet", title: GENERIC, description: GULKAN_DIKEN_RAW });
        const lane = { score: 0.82, components: { headlineLane: true }, isMatch: true };
        const quiet = { score: 0, components: { headlineLane: false }, isMatch: false };
        // The lane fires against the seed only, and is withdrawn when both descriptions are given (what the real scorer does).
        vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown, _ae: unknown, _be: unknown, _c: unknown, _h: unknown, opts?: unknown) => {
          const o = (opts ?? {}) as { aDescription?: string | null; bDescription?: string | null };
          const strict = (b as { strict?: string | null } | null | undefined)?.strict ?? null;
          if (strict !== "fp-gn1-seed") return quiet;
          return o.aDescription != null && o.bDescription != null ? quiet : lane;
        });

        const body = await drain();

        const calls = vi.mocked(scoreMock).mock.calls
          .map((c) => ({ strict: (c[1] as { strict?: string | null } | null)?.strict ?? null, opts: (c[6] ?? {}) as { aDescription?: string | null; bDescription?: string | null; bTitle?: string } }));
        const seedCalls = calls.filter((c) => c.strict === "fp-gn1-seed");
        const latestCalls = calls.filter((c) => c.strict === "fp-gn1-latest");
        // Seed: scored once on titles, then again with the two descriptions because the lane fired.
        expect(seedCalls).toHaveLength(2);
        expect(seedCalls[0]!.opts.aDescription).toBeUndefined();
        expect(seedCalls[1]!.opts.aDescription).toBe(cleanDescription(GULKAN_DIKEN_RAW));
        expect(seedCalls[1]!.opts.bDescription).toBe(SEED_DESC);
        // Latest: the lane did not fire, so one call and no description.
        expect(latestCalls).toHaveLength(1);
        expect(latestCalls[0]!.opts.aDescription).toBeUndefined();
        // The re-scored pair (lane withdrawn) is what ranks: no join through the seed.
        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
      });
    });

    // ---- h70-mergequality-2: the centroid guard -------------------------------
    //
    // A candidate of 3 or more members was scored against its seed and latest only, so
    // one off-topic article sharing a person's name joined it (Kilicdaroglu's CHP group
    // speech in the 17-member Bahceli condolence cluster 412f60a9, a TRT forum remark in
    // the Friday prayer cluster cab3575f). Before such a join on non-headline evidence
    // the article's tf-idf vector must reach cosine 0.25 with the centroid of the
    // cluster's members. The stubbed scorer plays the shared-name match: it scores the
    // seed and the latest 0.82 whatever the text says.
    describe("h70-mergequality-2: the centroid guard", () => {
      const KARAHAN_SEED = "Merkez Bankası Başkanı Fatih Karahan faiz kararını açıkladı";
      const KARAHAN_MID = "Faiz kararı sonrası dolar ve borsa güne karışık başladı";
      const KARAHAN_LATEST = "Politika faizi sabit: Merkez Bankası enflasyon uyarısı yaptı";
      const FAIZ_DESC_SEED =
        "Merkez Bankası Para Politikası Kurulu politika faizini yüzde 40 seviyesinde sabit tuttu. Karar metninde enflasyon görünümüne ve sıkı para politikasına vurgu yapıldı.";
      const FAIZ_DESC_MID =
        "Politika faizinin sabit tutulmasının ardından dolar kuru ve Borsa İstanbul endeksi güne karışık bir seyirle başladı.";
      const FAIZ_DESC_LATEST =
        "Para Politikası Kurulu kararında enflasyonla mücadele vurgusu öne çıktı. Politika faizi yüzde 40 olarak korundu.";

      // Off topic, shares only the person's name (Fatih Karahan) with the faiz cluster's seed.
      const WEDDING_TITLE = "Fatih Karahan'ın kızı evlendi: düğün İstanbul'da yapıldı";
      const WEDDING_DESC = "Düğüne ailelerin yakınları ve dostları katıldı. Çift nikâhın ardından misafirleri ağırladı.";
      // On topic for the faiz cluster.
      const FAIZ_TITLE = "Fatih Karahan'dan faiz açıklaması: Merkez Bankası enflasyonla mücadele edecek";
      const FAIZ_DESC = "Merkez Bankası Başkanı Fatih Karahan, politika faizini sabit tutan Para Politikası Kurulu kararını değerlendirdi.";

      /** A 3-member faiz cluster; seed and latest are scored through their fingerprints. */
      function seedFaiz(id = "cg1", articleCount = 3, sources = ["src-agg", "src-wire", "src-posta"]) {
        seedCluster(
          id,
          articleCount,
          [
            { id: `${id}-seed`, sourceId: sources[0]!, fp: `fp-${id}-seed`, ageMs: 50 * 60_000, title: KARAHAN_SEED, description: FAIZ_DESC_SEED },
            { id: `${id}-mid`, sourceId: sources[1]!, fp: `fp-${id}-mid`, ageMs: 40 * 60_000, title: KARAHAN_MID, description: FAIZ_DESC_MID },
            { id: `${id}-latest`, sourceId: sources[2]!, fp: `fp-${id}-latest`, ageMs: 30 * 60_000, title: KARAHAN_LATEST, description: FAIZ_DESC_LATEST },
          ].slice(0, sources.length),
          { title: KARAHAN_SEED },
        );
      }
      const wedding = (over: Partial<Parameters<typeof queueIncoming>[0]> = {}) =>
        queueIncoming({ id: "art-wedding", sourceId: "src-outlet", title: WEDDING_TITLE, description: WEDDING_DESC, ...over });
      const guardLogs = () =>
        logSpy.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("centroid-guard skip"));

      beforeEach(() => {
        delete process.env.CLUSTER_CENTROID_GUARD;
      });
      afterEach(() => {
        delete process.env.CLUSTER_CENTROID_GUARD;
      });

      it("a guard-failing primary candidate is skipped; with no other candidate the article opens its own cluster", async () => {
        seedFaiz();
        wedding();
        scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

        const body = await drain();

        expect(body.matched).toBe(0);
        expect(body.created).toBe(1);
        expect(linkedClusters()).toEqual([]);
        expect(supabaseFakeCalls.insert("clusters")).toHaveLength(1);
        expect(body.centroidSkips.count).toBe(1);
        expect(body.centroidSkips.samples).toHaveLength(1);
        expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg1");
        expect(body.centroidSkips.samples[0]!.cos).toBeLessThan(0.25);
        expect(body.centroidSkips.samples[0]!.cos).toBeGreaterThanOrEqual(0);
        // Logged with the article and the cluster, never a title.
        const logs = guardLogs();
        expect(logs).toHaveLength(1);
        expect(String(logs[0]?.[0])).toContain("art-wedding");
        expect(String(logs[0]?.[0])).toContain("cg1");
        expect(String(logs[0]?.[0])).not.toContain("Karahan");
      });

      it("control: an on-topic article joins the same cluster on the same stubbed score", async () => {
        seedFaiz();
        queueIncoming({ id: "art-faiz", sourceId: "src-outlet", title: FAIZ_TITLE, description: FAIZ_DESC });
        scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual(["cg1"]);
        expect(body.centroidSkips.count).toBe(0);
        expect(body.centroidSkips.samples).toEqual([]);
      });

      it("the article joins the next ranked candidate when the primary one fails the guard", async () => {
        seedFaiz("cg1");
        // A wedding cluster the article does belong to: it shares title tokens (düğün, İstanbul, yapıldı).
        seedCluster(
          "cg2",
          3,
          [
            { id: "cg2-seed", sourceId: "src-cnn-turk", fp: "fp-cg2-seed", ageMs: 60 * 60_000, title: "Ünlü isimlerin katıldığı düğün İstanbul'da yapıldı", description: "İstanbul'da düzenlenen düğüne ünlü isimler katıldı. Gelin ve damat misafirleri ağırladı." },
            { id: "cg2-mid", sourceId: "src-wire", fp: "fp-cg2-mid", ageMs: 55 * 60_000, title: "Düğün töreninde gelin ve damat misafirleri ağırladı", description: "Nikâhın ardından düzenlenen düğünde aileler ve dostlar bir araya geldi." },
            { id: "cg2-latest", sourceId: "src-agg", fp: "fp-cg2-latest", ageMs: 45 * 60_000, title: "Nikâh ve düğün sonrası çift ilk kez konuştu", description: "Evlenen çift düğünün ardından misafirlere teşekkür etti. Aileler düğünden memnun kaldı." },
          ],
          { title: "Ünlü isimlerin katıldığı düğün İstanbul'da yapıldı" },
        );
        wedding();
        // cg1 ranks first (0.9 against 0.7 -- 0.2 apart, outside the size tie-break margin).
        scoreBy({ "fp-cg1-seed": 0.9, "fp-cg1-latest": 0.9, "fp-cg2-seed": 0.7, "fp-cg2-latest": 0.7 });

        const body = await drain();

        expect(body.matched).toBe(1);
        expect(body.created).toBe(0);
        expect(linkedClusters()).toEqual(["cg2"]);
        expect(body.centroidSkips.count).toBe(1);
        expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg1");
      });

      it("a skipped candidate is not blocked: the same article's later candidate is still tried, and a clean article is unaffected", async () => {
        seedFaiz("cg1");
        wedding();
        queueIncoming({ id: "art-faiz", sourceId: "src-cnn-turk", title: FAIZ_TITLE, description: FAIZ_DESC });
        scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

        const body = await drain();

        // The wedding article was passed over (a new cluster); the faiz article of the same drain joined.
        expect(body.created).toBe(1);
        expect(body.matched).toBe(1);
        expect(linkedClusters()).toEqual(["cg1"]);
        expect(body.centroidSkips.count).toBe(1);
      });

      describe("exemptions", () => {
        it("a headline-lane hit against a member of the scan list exempts the candidate (the lane carries the join)", async () => {
          seedFaiz("cg1");
          // The middle member's headline IS the incoming headline: the member scan fires the lane on it.
          fakeArticles["cg1-mid"] = { ...(fakeArticles["cg1-mid"] as object), title: WEDDING_TITLE };
          wedding();
          scoreBy({});

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(body.created).toBe(0);
          expect(linkedClusters()).toEqual(["cg1"]);
          expect(body.centroidSkips.count).toBe(0);
        });

        it("a headline-lane result of the full scorer against the seed or the latest clears the lower floor: an on-topic article joins", async () => {
          seedFaiz("cg1");
          queueIncoming({ id: "art-faiz", sourceId: "src-outlet", title: FAIZ_TITLE, description: FAIZ_DESC });
          vi.mocked(scoreMock).mockImplementation(() => ({
            score: 0.82,
            components: { headlineLane: true },
            isMatch: true,
          }));

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cg1"]);
          expect(body.centroidSkips.count).toBe(0);
        });

        // h114-clusterpurity-3: the headline lane is no longer an exemption. Cluster 9a24657e (the Izmir
        // explosion, 18 members) took three oil headlines through the lane (AA at centroid cosine 0.123):
        // a lane hit now clears HEADLINE_CENTROID_FLOOR, and a candidate under it is skipped like any other.
        describe("h114-clusterpurity-3: the headline lane clears a lower floor, not none", () => {
          const laneStub = (clusters: string[]) =>
            vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown) => {
              const strict = (b as { strict?: string | null } | null | undefined)?.strict ?? "";
              const hit = clusters.some((c) => strict.startsWith(`fp-${c}-`));
              return { score: hit ? 0.82 : 0, components: { headlineLane: hit }, isMatch: hit };
            });

          it("a scan-list headline hit under the floor is skipped: the off-topic article opens its own cluster", async () => {
            // Nine faiz members; one middle member (neither seed nor latest) carries the incoming HEADLINE with a faiz text, as a
            // bridge member does. The lane fires on the scan alone (the stubbed full scorer scores seed and latest 0), and the
            // centroid of the nine is still the faiz story: the wedding article's cosine is far under the floor.
            const faizTexts = [
              [KARAHAN_MID, FAIZ_DESC_MID],
              [KARAHAN_LATEST, FAIZ_DESC_LATEST],
              ["Merkez Bankası faiz kararı sonrası piyasalar", FAIZ_DESC_SEED],
              ["Politika faizi yüzde 40'ta sabit: Merkez Bankası açıklaması", FAIZ_DESC_LATEST],
              ["Para Politikası Kurulu faiz kararını duyurdu", FAIZ_DESC_SEED],
              ["Faiz kararı sonrası dolar ve borsa", FAIZ_DESC_MID],
              ["Merkez Bankası enflasyon vurgusunu sürdürdü", FAIZ_DESC_LATEST],
              // More faiz members dilute the bridge's share of the centroid, so the wedding article sits under the 0.10 floor.
              ["Faiz kararı: Merkez Bankası politika faizini sabit tuttu", FAIZ_DESC_MID],
              ["Merkez Bankası faiz kararını açıkladı, piyasalar yükseldi", FAIZ_DESC_SEED],
              ["PPK toplantısı sonrası faiz ve enflasyon beklentisi", FAIZ_DESC_LATEST],
              ["Merkez Bankası Başkanı faiz kararını değerlendirdi", FAIZ_DESC_MID],
            ];
            const members = [
              { id: "cg1-seed", sourceId: "src-agg", fp: "fp-cg1-seed", ageMs: 120 * 60_000, title: KARAHAN_SEED, description: FAIZ_DESC_SEED },
              ...faizTexts.slice(0, 3).map(([title, description], i) => ({ id: `cg1-a${i}`, sourceId: `src-a${i}`, fp: `fp-cg1-a${i}`, ageMs: (110 - 10 * i) * 60_000, title: title!, description: description! })),
              { id: "cg1-bridge", sourceId: "src-posta", fp: "fp-cg1-bridge", ageMs: 75 * 60_000, title: WEDDING_TITLE, description: FAIZ_DESC_SEED },
              ...faizTexts.slice(3).map(([title, description], i) => ({ id: `cg1-b${i}`, sourceId: `src-b${i}`, fp: `fp-cg1-b${i}`, ageMs: (70 - 10 * i) * 60_000, title: title!, description: description! })),
              { id: "cg1-latest", sourceId: "src-haber7", fp: "fp-cg1-latest", ageMs: 20 * 60_000, title: KARAHAN_LATEST, description: FAIZ_DESC_LATEST },
            ];
            seedCluster("cg1", members.length, members, { title: KARAHAN_SEED });
            wedding();
            scoreBy({});

            const body = await drain();

            // Premise: the lane fired on the scan (the bridge member), so the candidate is a headline-lane candidate.
            const bridgeCalls = vi.mocked(headlineOnlyScoreMock).mock.calls.filter((c) => (c[3] as { bTitle?: string }).bTitle === WEDDING_TITLE);
            expect(bridgeCalls.length).toBeGreaterThan(0);
            expect(body.centroidSkips.count).toBe(1);
            expect(body.centroidSkips.samples[0]!.cos).toBeLessThan(HEADLINE_CENTROID_FLOOR);
            expect(body.matched).toBe(0);
            expect(body.created).toBe(1);
            expect(linkedClusters()).toEqual([]);
            expect(String(guardLogs()[0]?.[0])).toContain("lane=headline");
          });

          it("a full-scorer lane hit under the floor is skipped, logged with lane=headline and counted once", async () => {
            seedFaiz("cg1");
            wedding();
            laneStub(["cg1"]);

            const body = await drain();

            expect(body.matched).toBe(0);
            expect(body.created).toBe(1);
            expect(linkedClusters()).toEqual([]);
            expect(body.centroidSkips.count).toBe(1);
            expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg1");
            expect(body.centroidSkips.samples[0]!.cos).toBeLessThan(HEADLINE_CENTROID_FLOOR);
            const logs = guardLogs();
            expect(logs).toHaveLength(1);
            expect(String(logs[0]?.[0])).toContain("lane=headline");
            expect(String(logs[0]?.[0])).toContain("art-wedding");
            expect(String(logs[0]?.[0])).not.toContain("Karahan");
          });

          it("the next candidate is tried: the article joins the wedding cluster it belongs to when the lane-carried primary fails the guard", async () => {
            seedFaiz("cg1");
            seedCluster(
              "cg2",
              3,
              [
                { id: "cg2-seed", sourceId: "src-cnn-turk", fp: "fp-cg2-seed", ageMs: 60 * 60_000, title: "Ünlü isimlerin katıldığı düğün İstanbul'da yapıldı", description: "İstanbul'da düzenlenen düğüne ünlü isimler katıldı. Gelin ve damat misafirleri ağırladı." },
                { id: "cg2-mid", sourceId: "src-wire", fp: "fp-cg2-mid", ageMs: 55 * 60_000, title: "Düğün töreninde gelin ve damat misafirleri ağırladı", description: "Nikâhın ardından düzenlenen düğünde aileler ve dostlar bir araya geldi." },
                { id: "cg2-latest", sourceId: "src-agg", fp: "fp-cg2-latest", ageMs: 45 * 60_000, title: "Nikâh ve düğün sonrası çift ilk kez konuştu", description: "Evlenen çift düğünün ardından misafirlere teşekkür etti. Aileler düğünden memnun kaldı." },
              ],
              { title: "Ünlü isimlerin katıldığı düğün İstanbul'da yapıldı" },
            );
            wedding();
            // cg1 ranks first and carries a lane hit; cg2 follows on the plain score.
            vi.mocked(scoreMock).mockImplementation((_a: unknown, b: unknown) => {
              const strict = (b as { strict?: string | null } | null | undefined)?.strict ?? "";
              if (strict.startsWith("fp-cg1-")) return { score: 0.9, components: { headlineLane: true }, isMatch: true };
              if (strict.startsWith("fp-cg2-")) return { score: 0.7, components: { headlineLane: false }, isMatch: true };
              return { score: 0, components: { headlineLane: false }, isMatch: false };
            });

            const body = await drain();

            expect(body.matched).toBe(1);
            expect(body.created).toBe(0);
            expect(linkedClusters()).toEqual(["cg2"]);
            expect(body.centroidSkips.count).toBe(1);
            expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg1");
          });

          it("the same lane-carried candidate on-topic joins, and a skip without the lane carries no lane tag", async () => {
            seedFaiz("cg1");
            queueIncoming({ id: "art-faiz", sourceId: "src-outlet", title: FAIZ_TITLE, description: FAIZ_DESC });
            laneStub(["cg1"]);
            const joined = await drain();
            expect(joined.matched).toBe(1);
            expect(joined.centroidSkips.count).toBe(0);
            expect(guardLogs()).toHaveLength(0);
          });

          it("without the lane the skip log carries no lane tag", async () => {
            seedFaiz("cg1");
            wedding();
            scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

            const body = await drain();

            expect(body.centroidSkips.count).toBe(1);
            const logs = guardLogs();
            expect(logs).toHaveLength(1);
            expect(String(logs[0]?.[0])).not.toContain("lane=headline");
          });

          it("a lane-carried candidate of fewer than 3 members is still exempt", async () => {
            seedFaiz("cg1", 2, ["src-agg", "src-wire"]);
            wedding();
            laneStub(["cg1"]);

            const body = await drain();

            expect(body.matched).toBe(1);
            expect(linkedClusters()).toEqual(["cg1"]);
            expect(body.centroidSkips.count).toBe(0);
          });

          it("CLUSTER_CENTROID_GUARD=off turns the lane check off too", async () => {
            process.env.CLUSTER_CENTROID_GUARD = "off";
            seedFaiz("cg1");
            wedding();
            laneStub(["cg1"]);

            const body = await drain();

            expect(body.matched).toBe(1);
            expect(body.centroidSkips.count).toBe(0);
          });
        });

        it("control for the two above: without the lane hit the same article is skipped", async () => {
          seedFaiz("cg1");
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(0);
          expect(body.centroidSkips.count).toBe(1);
        });

        it("a cluster of fewer than 3 members is exempt (two prior members are no centroid)", async () => {
          seedFaiz("cg1", 2, ["src-agg", "src-wire"]);
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cg1"]);
          expect(body.centroidSkips.count).toBe(0);
        });

        it("exactly 3 members is guarded", async () => {
          seedFaiz("cg1", 3);
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(0);
          expect(body.centroidSkips.count).toBe(1);
        });

        it("the member count is the larger of article_count and the sources loaded (a stale row count does not exempt a 3-source cluster)", async () => {
          seedFaiz("cg1", 1, ["src-agg", "src-wire", "src-posta"]);
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(0);
          expect(body.centroidSkips.count).toBe(1);
        });

        it("a stale small source list does not exempt a big cluster either (article_count 18, one member loaded)", async () => {
          seedCluster("cg1", 18, [{ id: "cg1-seed", sourceId: "src-agg", fp: "fp-cg1-seed", title: KARAHAN_SEED, description: FAIZ_DESC_SEED }], { title: KARAHAN_SEED });
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(0);
          expect(body.created).toBe(1);
          expect(body.centroidSkips.count).toBe(1);
        });

        describe("an exact-title probe hit", () => {
          // The probed cluster's seed carries the article's headline, so the exact-title probe returns it.
          const PROBED_TITLE = "Karahan'dan flaş açıklama geldi";
          function seedProbed(inContext: boolean) {
            seedCluster(
              "cg-probe",
              3,
              [
                { id: "cg-probe-seed", sourceId: "src-agg", fp: "fp-cg-probe-seed", ageMs: 50 * 60_000, title: PROBED_TITLE, description: FAIZ_DESC_SEED },
                { id: "cg-probe-mid", sourceId: "src-wire", fp: "fp-cg-probe-mid", ageMs: 40 * 60_000, title: KARAHAN_MID, description: FAIZ_DESC_MID },
                { id: "cg-probe-latest", sourceId: "src-posta", fp: "fp-cg-probe-latest", ageMs: 30 * 60_000, title: KARAHAN_LATEST, description: FAIZ_DESC_LATEST },
              ],
              { title: PROBED_TITLE, updatedAgoMs: 30 * 60_000, inContext },
            );
          }
          const probeRow = () => ({
            id: "cg-probe",
            title_tr: PROBED_TITLE,
            title_tr_neutral: null,
            first_published: ago(50 * 60_000),
            updated_at: ago(30 * 60_000),
            article_count: 3,
          });

          it("is exempt: the identical headline joins although the text is off topic", async () => {
            seedProbed(false);
            rpcFixtures.cluster_title_probe = () => ({ data: [probeRow()], error: null });
            queueIncoming({ id: "art-probed", sourceId: "src-outlet", title: PROBED_TITLE, description: WEDDING_DESC });
            scoreBy({ "fp-cg-probe-seed": 0.9, "fp-cg-probe-latest": 0.9 });

            const body = await drain();

            expect(probeCalls()).toHaveLength(1);
            expect(body.matched).toBe(1);
            expect(linkedClusters()).toEqual(["cg-probe"]);
            expect(body.centroidSkips.count).toBe(0);
          });

          it("control: the same cluster reached through the context, not the probe, is guarded", async () => {
            seedProbed(true);
            queueIncoming({ id: "art-probed", sourceId: "src-outlet", title: PROBED_TITLE, description: WEDDING_DESC });
            scoreBy({ "fp-cg-probe-seed": 0.9, "fp-cg-probe-latest": 0.9 });

            const body = await drain();

            expect(body.matched).toBe(0);
            expect(body.created).toBe(1);
            expect(body.centroidSkips.count).toBe(1);
          });
        });

        it("a strict-fingerprint equality with a scan member exempts the candidate", async () => {
          // The article's source already sits in the cluster, so the fast path (which also sees the equal
          // fingerprint) is blocked as a duplicate source and the ensemble path runs: with the equality the
          // guard stays out of the way (the join is tried and refused by the source rule); without it the
          // guard passes the cluster over.
          const article = { title: WEDDING_TITLE, description: WEDDING_DESC };
          seedFaiz("cg1");
          fakeArticles["cg1-mid"] = {
            ...(fakeArticles["cg1-mid"] as object),
            fingerprint: strictFingerprint(article.title, cleanDescription(article.description) || ""),
          };
          wedding({ sourceId: "src-agg" }); // src-agg is the seed's source
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.centroidSkips.count).toBe(0);
          expect(body.matched).toBe(0);
          expect(linkedClusters()).toEqual([]);
          // The same-source skip is the outcome it always was, not a twin cluster.
          expect(body.skipped).toBe(1);
          expect(body.created).toBe(0);
        });

        it("control for the fingerprint exemption: with a different member fingerprint the guard skips that cluster", async () => {
          seedFaiz("cg1");
          wedding({ sourceId: "src-agg" });
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.centroidSkips.count).toBe(1);
          expect(body.matched).toBe(0);
          expect(body.skipped).toBe(0);
          expect(body.created).toBe(1);
        });

        it("an article that is already a member of the candidate (a re-delivered message) is exempt", async () => {
          seedFaiz("cg1");
          // The wedding article is already in the cluster (cluster_articles row + article row, stored fingerprint missing).
          clusterArticleRows.push({ cluster_id: "cg1", article_id: "art-wedding" });
          queueIncoming({ id: "art-wedding", sourceId: "src-outlet", title: WEDDING_TITLE, description: WEDDING_DESC });
          fakeArticles["art-wedding"] = {
            ...(fakeArticles["art-wedding"] as object),
            fingerprint: null,
            entities: [],
            minhash_sig: null,
            minhash_version: null,
          };
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          // Not passed over by the guard, so the old same-source handling decides (the cluster already holds
          // this very article's source): a skip, as before, and not a twin cluster of itself.
          expect(body.centroidSkips.count).toBe(0);
          expect(body.created).toBe(0);
          expect(body.skipped).toBe(1);
        });
      });

      describe("CLUSTER_CENTROID_GUARD", () => {
        it("off disables the guard: the off-topic article joins on the stubbed score", async () => {
          process.env.CLUSTER_CENTROID_GUARD = "off";
          seedFaiz("cg1");
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cg1"]);
          expect(body.centroidSkips.count).toBe(0);
          expect(guardLogs()).toHaveLength(0);
        });

        it("any other value keeps it on", async () => {
          process.env.CLUSTER_CENTROID_GUARD = "on";
          seedFaiz("cg1");
          wedding();
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(0);
          expect(body.centroidSkips.count).toBe(1);
        });
      });

      describe("dry run (admission shadow)", () => {
        it("reports the same outcome: no would_match for a skipped candidate", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          seedFaiz("cg1");
          wedding({ category: "ekonomi", admit: "shadow" });
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.admission.would_match).toBe(0);
          expect(body.admission.would_create).toBe(1);
          expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
          expect(linkedClusters()).toEqual([]);
          // A dry run writes nothing and is not counted.
          expect(body.centroidSkips.count).toBe(0);
        });

        it("control: the on-topic article is would_match", async () => {
          process.env.JEV_POLITICS_ADMISSION = "shadow";
          seedFaiz("cg1");
          queueIncoming({ id: "art-faiz", sourceId: "src-outlet", title: FAIZ_TITLE, description: FAIZ_DESC, category: "ekonomi", admit: "shadow" });
          scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });

          const body = await drain();

          expect(body.admission.would_match).toBe(1);
          expect(body.admission.would_create).toBe(0);
        });
      });

      describe("stem probe", () => {
        const STEM_TITLE = "Mutlu bir yuva önceliğimdi";
        it("a stem-probe hit that fails the guard is not joined: the article opens its own cluster", async () => {
          seedCluster(
            "cg-stem",
            3,
            [
              { id: "cg-stem-seed", sourceId: "src-agg", fp: "fp-cg-stem-seed", ageMs: 4 * H, title: STEM_TITLE, description: FAIZ_DESC_SEED },
              { id: "cg-stem-mid", sourceId: "src-wire", fp: "fp-cg-stem-mid", ageMs: 3.9 * H, title: KARAHAN_MID, description: FAIZ_DESC_MID },
              { id: "cg-stem-latest", sourceId: "src-posta", fp: "fp-cg-stem-latest", ageMs: 3.8 * H, title: KARAHAN_LATEST, description: FAIZ_DESC_LATEST },
            ],
            { title: STEM_TITLE, updatedAgoMs: 3.8 * H, inContext: false },
          );
          rpcFixtures.cluster_stem_probe = () => ({
            data: [{ id: "cg-stem", title_tr: STEM_TITLE, title_tr_neutral: null, first_published: ago(4 * H), updated_at: ago(3.8 * H), article_count: 3 }],
            error: null,
          });
          // The '"' changes the exact-title key, so only the stem probe finds the cluster.
          queueIncoming({ id: "art-stem", sourceId: "src-outlet", title: `"${STEM_TITLE}"`, description: WEDDING_DESC });
          scoreBy({ "fp-cg-stem-seed": 0.82, "fp-cg-stem-latest": 0.82 });

          const body = await drain();

          expect(supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_stem_probe")).toHaveLength(1);
          expect(body.matched).toBe(0);
          expect(body.created).toBe(1);
          expect(linkedClusters()).toEqual([]);
          expect(body.centroidSkips.count).toBe(1);
          expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg-stem");
        });

        it("control: the same hit with an on-topic description joins (stem-probe join unchanged)", async () => {
          seedCluster(
            "cg-stem",
            3,
            [
              { id: "cg-stem-seed", sourceId: "src-agg", fp: "fp-cg-stem-seed", ageMs: 4 * H, title: STEM_TITLE, description: FAIZ_DESC_SEED },
              { id: "cg-stem-mid", sourceId: "src-wire", fp: "fp-cg-stem-mid", ageMs: 3.9 * H, title: KARAHAN_MID, description: FAIZ_DESC_MID },
              { id: "cg-stem-latest", sourceId: "src-posta", fp: "fp-cg-stem-latest", ageMs: 3.8 * H, title: KARAHAN_LATEST, description: FAIZ_DESC_LATEST },
            ],
            { title: STEM_TITLE, updatedAgoMs: 3.8 * H, inContext: false },
          );
          rpcFixtures.cluster_stem_probe = () => ({
            data: [{ id: "cg-stem", title_tr: STEM_TITLE, title_tr_neutral: null, first_published: ago(4 * H), updated_at: ago(3.8 * H), article_count: 3 }],
            error: null,
          });
          queueIncoming({ id: "art-stem", sourceId: "src-outlet", title: `"${STEM_TITLE}"`, description: FAIZ_DESC });
          scoreBy({ "fp-cg-stem-seed": 0.82, "fp-cg-stem-latest": 0.82 });

          const body = await drain();

          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cg-stem"]);
          expect(body.centroidSkips.count).toBe(0);
        });
      });

      it("the drain summary reports at most 5 samples while counting every skip", async () => {
        for (let i = 0; i < 7; i++) {
          seedFaiz(`cgm${i}`);
          queueIncoming({ id: `art-w${i}`, sourceId: "src-outlet", title: `${WEDDING_TITLE} ${i}`, description: WEDDING_DESC });
        }
        const byFp: Record<string, number> = {};
        for (let i = 0; i < 7; i++) {
          byFp[`fp-cgm${i}-seed`] = 0.82;
          byFp[`fp-cgm${i}-latest`] = 0.82;
        }
        scoreBy(byFp);

        const body = await drain();

        expect(body.centroidSkips.count).toBeGreaterThanOrEqual(7);
        expect(body.centroidSkips.samples).toHaveLength(5);
        for (const s of body.centroidSkips.samples) {
          expect(typeof s.clusterId).toBe("string");
          expect(Number.isFinite(s.cos)).toBe(true);
        }
      });

      it("the counters are per drain: a second drain starts from zero", async () => {
        seedFaiz("cg1");
        wedding();
        scoreBy({ "fp-cg1-seed": 0.82, "fp-cg1-latest": 0.82 });
        const first = await drain();
        expect(first.centroidSkips.count).toBe(1);

        const second = await drain();
        expect(second.centroidSkips).toEqual({ count: 0, samples: [] });
      });

      // The Jev live band (JEV_LIVE_PAIRS) joins a sub-threshold or marginal primary on its own
      // path, before the join loop. Jev sees only the seed headline and the latest headline, the
      // same blind spot the guard was written for, so the guard runs before the gateway call: a
      // guard-failing primary costs no call and never reaches the Jev join.
      describe("the Jev live band is guarded too (JEV_LIVE_PAIRS=1)", () => {
        type JevDrainBody = DrainBody & { jev_live: { calls: number; joined_by_jev: number } };
        const jevJoin = () =>
          new Response(
            JSON.stringify({ answers: { p1: { type: "boolean", probability: 0.9 } }, usage: { inputTokens: 12, outputTokens: 3 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        const drainJev = async () => (await drain()) as JevDrainBody;

        beforeEach(() => {
          process.env.JEV_LIVE_PAIRS = "1";
          process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
        });
        afterEach(() => {
          delete process.env.JEV_LIVE_PAIRS;
          delete process.env.AI_GATEWAY_API_KEY;
        });

        it("a low-band (0.38) guard-failing primary makes no gateway call and is not joined by Jev: the article opens its own cluster", async () => {
          seedFaiz("cg1");
          wedding();
          scoreBy({ "fp-cg1-seed": 0.38, "fp-cg1-latest": 0.38 });
          const fetchMock = vi.fn(async () => jevJoin());
          vi.stubGlobal("fetch", fetchMock);

          const body = await drainJev();

          expect(fetchMock).not.toHaveBeenCalled();
          expect(body.jev_live.calls).toBe(0);
          expect(body.jev_live.joined_by_jev).toBe(0);
          expect(body.created).toBe(1);
          expect(body.matched).toBe(0);
          expect(linkedClusters()).toEqual([]);
          expect(body.centroidSkips.count).toBe(1);
        });

        it("control: the on-topic article at the same 0.38 still calls the gateway once and joins through Jev", async () => {
          seedFaiz("cg1");
          queueIncoming({ id: "art-faiz", sourceId: "src-outlet", title: FAIZ_TITLE, description: FAIZ_DESC });
          scoreBy({ "fp-cg1-seed": 0.38, "fp-cg1-latest": 0.38 });
          const fetchMock = vi.fn(async () => jevJoin());
          vi.stubGlobal("fetch", fetchMock);

          const body = await drainJev();

          expect(fetchMock).toHaveBeenCalledTimes(1);
          expect(body.jev_live.calls).toBe(1);
          expect(body.jev_live.joined_by_jev).toBe(1);
          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cg1"]);
          expect(body.centroidSkips.count).toBe(0);
        });

        it("a high-band (0.42) guard-failing primary is skipped without a gateway call and counted in centroidSkips exactly once", async () => {
          seedFaiz("cg1");
          wedding();
          scoreBy({ "fp-cg1-seed": 0.42, "fp-cg1-latest": 0.42 });
          const fetchMock = vi.fn(async () => jevJoin());
          vi.stubGlobal("fetch", fetchMock);

          const body = await drainJev();

          expect(fetchMock).not.toHaveBeenCalled();
          expect(body.jev_live.calls).toBe(0);
          expect(body.created).toBe(1);
          expect(body.matched).toBe(0);
          expect(linkedClusters()).toEqual([]);
          // Evaluated before Jev and again by the join loop, logged and counted once.
          expect(body.centroidSkips.count).toBe(1);
          expect(body.centroidSkips.samples).toHaveLength(1);
          expect(guardLogs()).toHaveLength(1);
        });
      });

      // A guard skip of a candidate at or above MATCH_THRESHOLD withdraws the "primary is a match"
      // premise, as a Jev reject does: the join loop may then reach only a candidate the ensemble
      // would have joined on its own, never a sub-threshold one behind it -- unless an
      // above-threshold candidate was skipped as a duplicate-source, whose premise is intact.
      describe("a guard skip raises the fallback bar like a Jev reject (product-1)", () => {
        const SMALL_WEDDING_TITLE = "Ünlü isimlerin katıldığı düğün İstanbul'da yapıldı";
        const SMALL_WEDDING_DESC = "İstanbul'da düzenlenen düğüne ünlü isimler katıldı. Gelin ve damat misafirleri ağırladı.";
        /** A 2-member wedding cluster (exempt from the guard) that shares title tokens with the wedding article. */
        function seedSmallWedding(id: string, sources: [string, string]) {
          seedCluster(
            id,
            2,
            [
              { id: `${id}-seed`, sourceId: sources[0], fp: `fp-${id}-seed`, ageMs: 60 * 60_000, title: SMALL_WEDDING_TITLE, description: SMALL_WEDDING_DESC },
              { id: `${id}-latest`, sourceId: sources[1], fp: `fp-${id}-latest`, ageMs: 45 * 60_000, title: "Düğün töreninde gelin ve damat misafirleri ağırladı", description: "Nikâhın ardından düzenlenen düğünde aileler ve dostlar bir araya geldi." },
            ],
            { title: SMALL_WEDDING_TITLE },
          );
        }

        it("a guard-failing 0.9 primary followed by a sub-threshold 0.37 candidate: the article opens its own cluster, not cg2", async () => {
          seedFaiz("cg1");
          seedSmallWedding("cg2", ["src-cnn-turk", "src-agg"]);
          wedding();
          scoreBy({ "fp-cg1-seed": 0.9, "fp-cg1-latest": 0.9, "fp-cg2-seed": 0.37, "fp-cg2-latest": 0.37 });

          const body = await drain();

          expect(body.created).toBe(1);
          expect(body.matched).toBe(0);
          expect(linkedClusters()).toEqual([]);
          expect(body.centroidSkips.count).toBe(1);
          expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg1");
        });

        it("control: the same cg2 at 0.37 is a normal sub-threshold fallback when the primary is skipped as a duplicate-source (no guard involved)", async () => {
          // cg1 is on topic for the article (the guard passes it) but holds the article's own source.
          seedFaiz("cg1", 3, ["src-outlet", "src-wire", "src-posta"]);
          seedCluster(
            "cg2",
            2,
            [
              { id: "cg2-seed", sourceId: "src-cnn-turk", fp: "fp-cg2-seed", ageMs: 60 * 60_000, title: "Merkez Bankası faiz açıklaması sonrası piyasalarda hareketlilik", description: "Faiz açıklaması sonrası piyasalar karışık seyretti." },
              { id: "cg2-latest", sourceId: "src-agg", fp: "fp-cg2-latest", ageMs: 45 * 60_000, title: "Merkez Bankası faiz kararı ve enflasyon değerlendirmesi", description: "Faiz kararı ve enflasyon değerlendirmesi öne çıktı." },
            ],
            { title: "Merkez Bankası faiz açıklaması sonrası piyasalarda hareketlilik" },
          );
          queueIncoming({ id: "art-faiz", sourceId: "src-outlet", title: FAIZ_TITLE, description: FAIZ_DESC });
          scoreBy({ "fp-cg1-seed": 0.9, "fp-cg1-latest": 0.9, "fp-cg2-seed": 0.37, "fp-cg2-latest": 0.37 });

          const body = await drain();

          expect(body.centroidSkips.count).toBe(0);
          expect(body.created).toBe(0);
          expect(body.matched).toBe(1);
          expect(linkedClusters()).toEqual(["cg2"]);
        });

        it("a duplicate-source skip of an above-threshold candidate keeps the old bar even after a guard skip", async () => {
          seedFaiz("cg1");
          // cg0 holds the article's own source (src-outlet), is small (exempt from the guard) and is skipped as a duplicate-source.
          seedSmallWedding("cg0", ["src-outlet", "src-wire"]);
          seedSmallWedding("cg2", ["src-cnn-turk", "src-agg"]);
          wedding();
          scoreBy({
            "fp-cg1-seed": 0.9, "fp-cg1-latest": 0.9,
            "fp-cg0-seed": 0.95, "fp-cg0-latest": 0.95,
            "fp-cg2-seed": 0.37, "fp-cg2-latest": 0.37,
          });

          const body = await drain();

          expect(body.centroidSkips.count).toBe(1);
          expect(body.centroidSkips.samples[0]!.clusterId).toBe("cg1");
          expect(linkedClusters()).toEqual(["cg2"]);
          expect(body.matched).toBe(1);
        });
      });
    });
  });
});

// ---------------------------------------------------------------------------
// hunt-25 W3 (h25-clusters-3, migration 151): the deterministic, attach-only probe.
//
// After cluster_work ran dry the consumer reads at most ATTACH_MAX_PER_DRAIN messages
// of the cluster_attach queue. For each article it asks attachDecision() (headline
// evidence only) against the clusters already in the in-memory context; SHADOW (the
// default) records the decision in cluster_attach_shadow, LIVE stamps
// articles.politics_admitted_at and links through cluster_link_atomic. It never
// creates a cluster, never scores with the ensemble, never calls Jev.
// ---------------------------------------------------------------------------
describe("cluster_attach: the attach-only probe (hunt-25 W3, migration 151)", () => {
  const TITLE = "32 ilde FETÖ operasyonu: 41 şüpheli tutuklandı";
  const ATTACH_ID = "art-attach-hurriyet";
  const CLUSTER = "cluster-feto-attach";
  const SRC_HURRIYET = "src-hurriyet";
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

  interface SeedMember {
    id: string;
    source: string;
    title: string;
    category?: string;
    admitted?: boolean;
    minutes?: number;
    description?: string;
  }

  function seedCluster(id: string, members: SeedMember[]) {
    clusterRows.push({
      id,
      title_tr: members[0]?.title ?? "",
      title_tr_neutral: members[0]?.title ?? "",
      first_published: minutesAgo(40),
      updated_at: minutesAgo(5),
      article_count: members.length,
    });
    for (const m of members) {
      clusterArticleRows.push({ cluster_id: id, article_id: m.id });
      fakeArticles[m.id] = {
        id: m.id,
        source_id: m.source,
        title: m.title,
        description: m.description ?? `Ayrıntı ${m.id}`,
        published_at: minutesAgo(m.minutes ?? 12),
        fingerprint: `fp-${m.id}`,
        entities: [],
        category: m.category ?? "politika",
        politics_admitted_at: m.admitted ? minutesAgo(10) : null,
        minhash_sig: null,
        minhash_version: null,
      };
    }
  }

  const politicsMembers = (prefix: string): SeedMember[] => [
    { id: `${prefix}-aksam`, source: "src-aksam", title: TITLE },
    { id: `${prefix}-star`, source: "src-star", title: "32 ilde FETÖ operasyonu! 72 şüpheli yakalandı", minutes: 14 },
    { id: `${prefix}-haber7`, source: "src-haber7", title: "32 ilde FETÖ operasyonu: 72 şüpheli yakalandı, 41’i tutuklandı", minutes: 16 },
  ];

  function seedIncoming(over: Record<string, unknown> = {}) {
    fakeArticles[ATTACH_ID] = {
      id: ATTACH_ID,
      source_id: SRC_HURRIYET,
      title: TITLE,
      description: "İçişleri Bakanlığı duyurdu",
      url: "https://example.com/attach-hurriyet",
      content_hash: "h-attach",
      category: "genel",
      politics_admitted_at: null,
      published_at: minutesAgo(3),
      ...over,
    };
  }

  function queueAttach(msgId = 7001, over: Partial<AttachPgmqMessage> = {}) {
    pgmqState.attachPending.push({
      msg_id: msgId,
      read_ct: 1,
      message: { article_id: ATTACH_ID, admit: "attach" },
      ...over,
    });
  }

  interface AttachBody {
    drained: number;
    matched: number;
    created: number;
    failedTransient: number;
    failedPermanent: number;
    budgeted_out: boolean;
    attach: {
      mode: string;
      read: number;
      would_attach: number;
      attached: number;
      failed: number;
      delete_errors: number;
      by_reason: Record<string, number>;
    };
  }

  async function drain(): Promise<AttachBody> {
    const handler = await importHandler();
    if (!handler) throw new Error("unreachable");
    const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as AttachBody;
  }

  const shadowWrites = () => supabaseFakeCalls.upsert("cluster_attach_shadow");
  const attachReads = () => pgmqState.reads.filter((r) => r.queue === "cluster_attach");

  // The probe's invariants, asserted by every test that drains attach messages.
  function expectNoClusterMachinery() {
    expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
    expect(supabaseFakeCalls.insert("cluster_articles")).toHaveLength(0);
    expect(vi.mocked(scoreMock)).not.toHaveBeenCalled();
    // (The consumer lease RPCs of migration 190 belong to the lease, not to the probe: every drain makes them.)
    for (const call of supabaseFakeCalls.rpc.filter((r) => !r.name.startsWith("consumer_lease_"))) {
      expect(["cluster_link_atomic"]).toContain(call.name); // no probe, no claim, no admission record, no Jev
    }
  }

  it("SHADOW (the default, CLUSTER_ATTACH_MODE unset): records the decision, deletes the message, writes nothing else", async () => {
    seedCluster(CLUSTER, politicsMembers("s"));
    seedIncoming();
    queueAttach();

    const body = await drain();

    expect(attachReads()).toEqual([{ queue: "cluster_attach", qty: 25 }]);
    expect(body.attach).toMatchObject({ mode: "shadow", read: 1, would_attach: 1, attached: 0, by_reason: {} });
    // A successful attach message is DELETED, not archived (037's retention covers only the two old queues).
    expect(pgmqState.attachDeleted).toEqual([7001]);
    expect(pgmqState.attachArchived).toEqual([]);
    expect(shadowWrites()).toHaveLength(1);
    expect(shadowWrites()[0]!.patch).toEqual([
      { article_id: ATTACH_ID, cluster_id: CLUSTER, score: 1, lane: "exact-title", mode: "shadow" },
    ]);
    expect(attachShadowFake.upsertOptions).toEqual([{ onConflict: "article_id", ignoreDuplicates: true }]);
    // Shadow never touches the article or the cluster.
    expect(supabaseFakeCalls.update("articles")).toHaveLength(0);
    expect(supabaseFakeCalls.rpc.filter((r) => !r.name.startsWith("consumer_lease_"))).toHaveLength(0);
    expectNoClusterMachinery();
    expect(body.matched + body.created).toBe(0);
  });

  // h114-clusterpurity-4: the probe's headline lane is the same lane, so a generic headline of one
  // detainee must not attach to another's cluster. The members' cleaned descriptions come from the
  // rows the context already loaded (read lazily), the article's from its own row.
  describe("h114-clusterpurity-4: generic headlines of different people", () => {
    const FON_CLUSTER = "cluster-fon-attach";
    const MEMBER_TITLE = "Fon soruşturmasında yeni gözaltı kararı";
    const ARTICLE_TITLE = "Fon soruşturmasında yeni gözaltı";
    const CEVIK_DESC = 'Sermaye piyasası işlemlerine ilişkin "fon" soruşturmasında Enver Çevik gözaltına alındı.';
    const GULKAN_RAW =
      "Fon soruşturmasında yeni gözaltı 09.11.2026 DikenFon soruşturmasında OMG Capital Advisors Yönetim Kurulu Başkanı Ömer Murat Gülkan gözaltına alındı.\nThe post Fon soruşturmasında yeni gözaltı appeared first on #site_linkat 09.11.2026 .";
    const fonMembers = (): SeedMember[] => [
      { id: "fon-a", source: "src-aksam", title: MEMBER_TITLE, description: CEVIK_DESC, minutes: 20 },
      { id: "fon-b", source: "src-star", title: "Lydia Holding Yönetim Kurulu Başkanı Enver Çevik gözaltına alındı", description: CEVIK_DESC, minutes: 25 },
      { id: "fon-c", source: "src-haber7", title: "Fon soruşturmasında yeni dalga: operasyon sürüyor", description: CEVIK_DESC, minutes: 30 },
    ];

    it("premise: the lane fires for the pair and no exact title or fingerprint is shared", () => {
      const hours = 17 / 60;
      expect(headlineLane(headlineTokens(ARTICLE_TITLE), headlineTokens(MEMBER_TITLE), hours).fired).toBe(true);
      expect(normalizeTurkish(ARTICLE_TITLE)).not.toBe(normalizeTurkish(MEMBER_TITLE));
    });

    it("another person's description (raw, with the feed wrapper) records no-match", async () => {
      seedCluster(FON_CLUSTER, fonMembers());
      seedIncoming({ title: ARTICLE_TITLE, description: GULKAN_RAW });
      queueAttach();

      const body = await drain();

      expect(body.attach).toMatchObject({ mode: "shadow", read: 1, would_attach: 0, by_reason: { "no-match": 1 } });
      expect(shadowWrites()).toHaveLength(0);
      expectNoClusterMachinery();
    });

    it("control: the same person's description attaches on the headline lane", async () => {
      seedCluster(FON_CLUSTER, fonMembers());
      seedIncoming({ title: ARTICLE_TITLE, description: CEVIK_DESC });
      queueAttach();

      const body = await drain();

      expect(body.attach).toMatchObject({ would_attach: 1, by_reason: {} });
      expect(shadowWrites()).toHaveLength(1);
      expect((shadowWrites()[0]!.patch as Array<{ lane: string; cluster_id: string }>)[0]).toMatchObject({ cluster_id: FON_CLUSTER, lane: "headline" });
    });
  });

  it("explicit shadow behaves like the default", async () => {
    process.env.CLUSTER_ATTACH_MODE = "shadow";
    seedCluster(CLUSTER, politicsMembers("s2"));
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach.mode).toBe("shadow");
    expect(body.attach.would_attach).toBe(1);
  });

  for (const junk of ["LIVE", " live", "on", "1", "yes", ""]) {
    it(`CLUSTER_ATTACH_MODE=${JSON.stringify(junk)} is shadow: garbage never means live`, async () => {
      process.env.CLUSTER_ATTACH_MODE = junk;
      seedCluster(CLUSTER, politicsMembers("g"));
      seedIncoming();
      queueAttach();
      const body = await drain();
      expect(body.attach.mode).toBe("shadow");
      expect(body.attach.attached).toBe(0);
      expect(supabaseFakeCalls.update("articles")).toHaveLength(0);
      expect(supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic")).toHaveLength(0);
    });
  }

  it("OFF: the cluster_attach queue is not read at all", async () => {
    process.env.CLUSTER_ATTACH_MODE = "off";
    seedCluster(CLUSTER, politicsMembers("o"));
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(attachReads()).toHaveLength(0);
    expect(pgmqState.attachPending).toHaveLength(1);
    expect(body.attach).toMatchObject({ mode: "off", read: 0, would_attach: 0, attached: 0 });
    expect(shadowWrites()).toHaveLength(0);
  });

  it("LIVE: stamps politics_admitted_at (only where it is null), links through cluster_link_atomic, records a live row", async () => {
    process.env.CLUSTER_ATTACH_MODE = "live";
    seedCluster(CLUSTER, politicsMembers("l"));
    seedIncoming();
    queueAttach();

    const body = await drain();

    expect(body.attach).toMatchObject({ mode: "live", read: 1, would_attach: 0, attached: 1, by_reason: {} });
    const stamps = supabaseFakeCalls.update("articles");
    expect(stamps).toHaveLength(1);
    expect(stamps[0]!.patch).toEqual({ politics_admitted_at: expect.any(String) });
    expect(Number.isNaN(Date.parse((stamps[0]!.patch as { politics_admitted_at: string }).politics_admitted_at))).toBe(false);
    expect(stamps[0]!.state.eq).toEqual([{ col: "id", val: ATTACH_ID }]);
    expect(stamps[0]!.state.is).toEqual([{ col: "politics_admitted_at", val: null }]);
    const links = supabaseFakeCalls.rpc.filter((r) => r.name === "cluster_link_atomic");
    expect(links).toHaveLength(1);
    expect(links[0]!.args).toMatchObject({ p_cluster_id: CLUSTER, p_article_id: ATTACH_ID });
    expect(shadowWrites()[0]!.patch).toEqual([
      { article_id: ATTACH_ID, cluster_id: CLUSTER, score: 1, lane: "exact-title", mode: "live" },
    ]);
    expect(pgmqState.attachDeleted).toEqual([7001]);
    expectNoClusterMachinery();
    // The attach is not a politika "match": the classic counters stay at zero.
    expect(body.matched + body.created).toBe(0);
  });

  it("LIVE: the touched cluster is revalidated once", async () => {
    process.env.CLUSTER_ATTACH_MODE = "live";
    process.env.REVALIDATE_URL = "https://example.test/api/revalidate";
    process.env.CRON_SECRET = "test-cron-secret";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    seedCluster(CLUSTER, politicsMembers("r"));
    seedIncoming();
    queueAttach();

    await drain();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((JSON.parse(init.body as string) as { tags: string[] }).tags).toContain(`cluster-detail:${CLUSTER}`);
  });

  it("SHADOW: nothing is revalidated", async () => {
    process.env.REVALIDATE_URL = "https://example.test/api/revalidate";
    process.env.CRON_SECRET = "test-cron-secret";
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    seedCluster(CLUSTER, politicsMembers("r2"));
    seedIncoming();
    queueAttach();
    await drain();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("LIVE link error: the stamp this attempt set is cleared, the message stays for a retry, no shadow row", async () => {
    process.env.CLUSTER_ATTACH_MODE = "live";
    rpcFixtures.cluster_link_atomic = { data: null, error: { message: "link boom" } };
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    seedCluster(CLUSTER, politicsMembers("e"));
    seedIncoming();
    queueAttach(7002, { read_ct: 1 });

    const body = await drain();

    expect(body.attach).toMatchObject({ read: 1, attached: 0, failed: 1 });
    const updates = supabaseFakeCalls.update("articles");
    expect(updates.map((u) => u.patch)).toEqual([
      { politics_admitted_at: expect.any(String) },
      { politics_admitted_at: null },
    ]);
    // The clear only removes the stamp it set.
    const stamp = (updates[0]!.patch as { politics_admitted_at: string }).politics_admitted_at;
    expect(updates[1]!.state.eq).toEqual([
      { col: "id", val: ATTACH_ID },
      { col: "politics_admitted_at", val: stamp },
    ]);
    expect(pgmqState.attachDeleted).toEqual([]);
    expect(pgmqState.attachArchived).toEqual([]);
    expect(shadowWrites()).toHaveLength(0);
    expect(errLog).toHaveBeenCalledWith("[cluster-consumer] attach msg-error", expect.stringContaining("link boom"));
    errLog.mockRestore();
  });

  it("LIVE link error on a message past MAX_READS: archived (poison), never deleted", async () => {
    process.env.CLUSTER_ATTACH_MODE = "live";
    rpcFixtures.cluster_link_atomic = { data: null, error: { message: "link boom" } };
    const errLog = vi.spyOn(console, "error").mockImplementation(() => {});
    seedCluster(CLUSTER, politicsMembers("p"));
    seedIncoming();
    queueAttach(7003, { read_ct: 4 });
    const body = await drain();
    expect(pgmqState.attachArchived).toEqual([7003]);
    expect(pgmqState.attachDeleted).toEqual([]);
    expect(body.attach.failed).toBe(1);
    errLog.mockRestore();
  });

  it("a politika article already inside the gate is skipped 'in-gate' and the message is deleted", async () => {
    seedCluster(CLUSTER, politicsMembers("ig"));
    seedIncoming({ category: "politika" });
    queueAttach();
    const body = await drain();
    expect(body.attach).toMatchObject({ would_attach: 0, attached: 0, by_reason: { "in-gate": 1 } });
    expect(pgmqState.attachDeleted).toEqual([7001]);
    expect(shadowWrites()).toHaveLength(0);
  });

  it("an article that already carries politics_admitted_at is 'in-gate' too (a redelivery after a live attach)", async () => {
    process.env.CLUSTER_ATTACH_MODE = "live";
    seedCluster(CLUSTER, politicsMembers("ig2"));
    seedIncoming({ politics_admitted_at: minutesAgo(1) });
    queueAttach();
    const body = await drain();
    expect(body.attach).toMatchObject({ attached: 0, by_reason: { "in-gate": 1 } });
    expect(supabaseFakeCalls.update("articles")).toHaveLength(0);
    expect(supabaseFakeCalls.rpc.filter((r) => !r.name.startsWith("consumer_lease_"))).toHaveLength(0);
    expect(pgmqState.attachDeleted).toEqual([7001]);
  });

  it("an article older than HEADLINE_LANE_MAX_HOURS is 'stale': nothing is written, the message is deleted", async () => {
    seedCluster(CLUSTER, politicsMembers("st"));
    seedIncoming({ published_at: minutesAgo((HEADLINE_LANE_MAX_HOURS + 1) * 60) });
    queueAttach();
    const body = await drain();
    expect(body.attach.by_reason).toEqual({ stale: 1 });
    expect(shadowWrites()).toHaveLength(0);
    expect(pgmqState.attachDeleted).toEqual([7001]);
  });

  it("an unrelated headline is 'no-match'", async () => {
    seedCluster(CLUSTER, politicsMembers("nm"));
    seedIncoming({ title: "Merkez Bankası faiz kararını açıkladı", description: "Faiz sabit" });
    queueAttach();
    const body = await drain();
    expect(body.attach.by_reason).toEqual({ "no-match": 1 });
    expect(shadowWrites()).toHaveLength(0);
    expect(pgmqState.attachDeleted).toEqual([7001]);
  });

  it("a vanished article is 'not-found' and its message is deleted", async () => {
    seedCluster(CLUSTER, politicsMembers("nf"));
    queueAttach(); // no article row
    const body = await drain();
    expect(body.attach.by_reason).toEqual({ "not-found": 1 });
    expect(pgmqState.attachDeleted).toEqual([7001]);
  });

  it("a target cluster below 60% politics members is refused 'below-share' (the share is computed from ALL members, no extra query)", async () => {
    seedCluster(CLUSTER, [
      { id: "bs-aksam", source: "src-aksam", title: TITLE },
      { id: "bs-star", source: "src-star", title: "32 ilde FETÖ operasyonu! 72 şüpheli yakalandı", minutes: 14 },
      { id: "bs-g1", source: "src-g1", title: "Başka bir genel haber", category: "genel" },
      { id: "bs-g2", source: "src-g2", title: "Bir diğer genel haber", category: "genel" },
    ]);
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach.by_reason).toEqual({ "below-share": 1 });
    expect(shadowWrites()).toHaveLength(0);
  });

  it("admitted (stamped) members count as politics: 3 of 4 members is 75% and the article attaches", async () => {
    seedCluster(CLUSTER, [
      { id: "ad-aksam", source: "src-aksam", title: TITLE },
      { id: "ad-g1", source: "src-g1", title: "Başka bir genel haber", category: "genel", admitted: true },
      { id: "ad-g2", source: "src-g2", title: "Bir diğer genel haber", category: "genel", admitted: true },
      { id: "ad-g3", source: "src-g3", title: "Üçüncü genel haber", category: "genel" },
    ]);
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach).toMatchObject({ would_attach: 1, by_reason: {} });
  });

  it("a source already in the cluster is refused 'same-source', even through a non-politics member", async () => {
    seedCluster(CLUSTER, [
      ...politicsMembers("ss"),
      { id: "ss-hurriyet-old", source: SRC_HURRIYET, title: "Hürriyet'ten eski bir genel haber", category: "genel" },
    ]);
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach.by_reason).toEqual({ "same-source": 1 });
    expect(shadowWrites()).toHaveLength(0);
  });

  it("two clusters holding the same headline are 'ambiguous'", async () => {
    seedCluster(CLUSTER, politicsMembers("a1"));
    seedCluster("cluster-feto-twin", [{ id: "a2-milliyet", source: "src-milliyet", title: TITLE, minutes: 20 }]);
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach.by_reason).toEqual({ ambiguous: 1 });
  });

  it("the headline lane attaches a near-identical headline (not only the exact title)", async () => {
    seedCluster(CLUSTER, politicsMembers("hl"));
    seedIncoming({ title: "32 ilde FETÖ operasyonu: 72 şüpheli yakalandı, 41 kişi tutuklandı" });
    queueAttach();
    const body = await drain();
    expect(body.attach.would_attach).toBe(1);
    expect(shadowWrites()[0]!.patch).toEqual([
      expect.objectContaining({ article_id: ATTACH_ID, cluster_id: CLUSTER, lane: "headline", mode: "shadow" }),
    ]);
  });

  it("a malformed payload (no article id) and an untagged one are archived, not deleted", async () => {
    seedCluster(CLUSTER, politicsMembers("m"));
    pgmqState.attachPending.push(
      { msg_id: 7101, read_ct: 1, message: { admit: "attach" } },
      { msg_id: 7102, read_ct: 1, message: { article_id: ATTACH_ID } },
      { msg_id: 7103, read_ct: 1, message: { article_id: ATTACH_ID, admit: "live" } },
    );
    seedIncoming();
    const body = await drain();
    expect(pgmqState.attachArchived).toEqual([7101, 7102, 7103]);
    expect(pgmqState.attachDeleted).toEqual([]);
    expect(body.attach.by_reason).toEqual({ malformed: 1, "bad-tag": 2 });
    expect(shadowWrites()).toHaveLength(0);
  });

  it("a pgmq read error on the attach queue never fails the drain: politika work is done, one warning", async () => {
    pgmqState.attachReadError = "relation pgmq.q_cluster_attach does not exist";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fakeArticles["art-work"] = {
      id: "art-work",
      source_id: "src-outlet",
      title: "Politika haberi",
      description: "Detay",
      url: "https://example.com/work",
      category: "politika",
      published_at: minutesAgo(1),
    };
    pgmqState.pending = [{ msg_id: 1, read_ct: 1, message: { article_id: "art-work" } }];

    const body = await drain();
    await drain(); // a second drain: the warning is once per isolate

    expect(body.created + body.matched).toBe(1);
    expect(body.attach.read).toBe(0);
    const warnings = warn.mock.calls.filter((c) => String(c[0]).includes("cluster_attach read failed"));
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]![0])).toContain("does not exist");
    warn.mockRestore();
  });

  it("a failing shadow write warns once, never fails the message, and the decision still counts", async () => {
    attachShadowFake.mode = "error";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedCluster(CLUSTER, politicsMembers("w"));
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach.would_attach).toBe(1);
    expect(body.attach.failed).toBe(0);
    expect(pgmqState.attachDeleted).toEqual([7001]);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes("cluster_attach_shadow insert failed"))).toHaveLength(1);
    expect(String(warn.mock.calls.find((c) => String(c[0]).includes("cluster_attach_shadow insert failed"))![0])).toContain("attach shadow down");
    warn.mockRestore();
  });

  it("a throwing shadow write is swallowed the same way", async () => {
    attachShadowFake.mode = "throw";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedCluster(CLUSTER, politicsMembers("wt"));
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach.would_attach).toBe(1);
    expect(pgmqState.attachDeleted).toEqual([7001]);
    warn.mockRestore();
  });

  it("a failing delete is a warning: the work is done and the redelivery is idempotent", async () => {
    pgmqState.attachDeleteError = "delete failed";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    seedCluster(CLUSTER, politicsMembers("d"));
    seedIncoming();
    queueAttach();
    const body = await drain();
    expect(body.attach).toMatchObject({ would_attach: 1, failed: 0, delete_errors: 1 });
    expect(warn.mock.calls.some((c) => String(c[0]).includes("delete of attach msg 7001 failed"))).toBe(true);
    warn.mockRestore();
  });

  it("reads at most ATTACH_MAX_PER_DRAIN (25) per drain, in ONE read", async () => {
    seedCluster(CLUSTER, politicsMembers("c"));
    for (let i = 0; i < 40; i++) {
      const id = `art-cap-${i}`;
      fakeArticles[id] = {
        id,
        source_id: `src-cap-${i}`,
        title: `Bambaşka bir konu ${i} hakkında uzun bir başlık`,
        description: "Detay",
        url: `https://example.com/${id}`,
        category: "genel",
        published_at: minutesAgo(2),
      };
      pgmqState.attachPending.push({ msg_id: 8000 + i, read_ct: 1, message: { article_id: id, admit: "attach" } });
    }
    const body = await drain();
    expect(attachReads()).toEqual([{ queue: "cluster_attach", qty: 25 }]);
    expect(body.attach.read).toBe(25);
    expect(pgmqState.attachDeleted).toHaveLength(25);
    expect(pgmqState.attachPending).toHaveLength(15);
  });

  describe("starvation: the attach queue never takes the time politika work needs", () => {
    let nowSpy: ReturnType<typeof vi.spyOn> | null = null;
    let offsetMs = 0;
    afterEach(() => {
      nowSpy?.mockRestore();
      nowSpy = null;
      offsetMs = 0;
    });
    function moveClockAfterWorkRead(ms: number) {
      const realNow = Date.now.bind(Date);
      nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + offsetMs);
      pgmqState.afterWorkRead = () => {
        offsetMs = ms;
      };
    }
    function seedWork(n: number) {
      for (let i = 0; i < n; i++) {
        fakeArticles[`art-w-${i}`] = {
          id: `art-w-${i}`,
          source_id: "src-outlet",
          title: `Politika haberi sayı ${i} farklı konu`,
          description: "Detay",
          url: `https://example.com/w${i}`,
          category: "politika",
          published_at: minutesAgo(1),
        };
        pgmqState.pending.push({ msg_id: 100 + i, read_ct: 1, message: { article_id: `art-w-${i}` } });
      }
    }

    it("control: cluster_work empty and the whole budget left reads the attach queue", async () => {
      seedCluster(CLUSTER, politicsMembers("sv"));
      seedIncoming();
      queueAttach();
      seedWork(1);
      const body = await drain();
      expect(attachReads()).toHaveLength(1);
      expect(body.attach.read).toBe(1);
      // cluster_work was read first, the attach queue after it.
      expect(pgmqState.reads.map((r) => r.queue)).toEqual(["cluster_work", "cluster_attach"]);
    });

    it("cluster_work came back empty but less than the read-budget floor remains: no attach read", async () => {
      seedCluster(CLUSTER, politicsMembers("sv2"));
      seedIncoming();
      queueAttach();
      seedWork(1);
      moveClockAfterWorkRead(26_000); // 4 s of the 30 s budget are left, the floor is 5 s
      const body = await drain();
      expect(attachReads()).toHaveLength(0);
      expect(pgmqState.attachPending).toHaveLength(1);
      expect(body.attach.read).toBe(0);
      expect(body.created + body.matched).toBe(1); // the politika message was still processed
    });

    it("cluster_work still holds messages when the budget runs out: no attach read, the rest stays queued", async () => {
      seedCluster(CLUSTER, politicsMembers("sv3"));
      seedIncoming();
      queueAttach();
      seedWork(3);
      moveClockAfterWorkRead(26_000);
      const body = await drain();
      expect(body.budgeted_out).toBe(true);
      expect(attachReads()).toHaveLength(0);
      expect(pgmqState.attachPending).toHaveLength(1);
      expect(pgmqState.pending).toHaveLength(1); // the third politika message was never leased by the attach queue
    });

    it("a cluster_work read error means the queue is not known to be empty: no attach read", async () => {
      seedCluster(CLUSTER, politicsMembers("sv4"));
      seedIncoming();
      queueAttach();
      const readBatchMock = (await import("../../supabase/functions/_shared/pgmq.ts")).readBatch as unknown as ReturnType<typeof vi.fn>;
      readBatchMock.mockImplementationOnce(async () => {
        throw new Error("pgmq.read(cluster_work): boom");
      });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const body = await drain();
      err.mockRestore();
      expect(body.failedTransient).toBe(1);
      expect(attachReads()).toHaveLength(0);
    });
  });

  it("a stray admit:'attach' on cluster_work is not a Jev claim: the politika article clusters as usual", async () => {
    fakeArticles["art-stray"] = {
      id: "art-stray",
      source_id: "src-outlet",
      title: "Politika haberi stray",
      description: "Detay",
      url: "https://example.com/stray",
      category: "politika",
      published_at: minutesAgo(1),
    };
    pgmqState.pending = [{ msg_id: 55, read_ct: 1, message: { article_id: "art-stray", admit: "attach" } } as unknown as PgmqMessage];
    const body = await drain();
    expect(body.created + body.matched).toBe(1);
    expect(pgmqState.archived).toContain(55);
  });

  it("the attach path is wired to the cluster_attach queue and nothing else in the source (static)", () => {
    const src = readFileSync(resolve(__dirname, "../../supabase/functions/cluster-consumer/index.ts"), "utf8");
    expect(src).toContain('const ATTACH_QUEUE_NAME = "cluster_attach";');
    expect(src).toContain("attachMode(Deno.env.get(ATTACH_MODE_ENV)");
    expect(src).toContain("planAttachRead(");
    expect(src).toContain("deleteMessage(");
    // processAttach is the only consumer of attachDecision, and createCluster is still only called from clusterArticle.
    expect([...src.matchAll(/\bcreateCluster\(/g)]).toHaveLength(2); // the definition and its single call
    const attachFn = src.slice(src.indexOf("async function processAttach("), src.indexOf("async function drainAttach("));
    expect(attachFn).not.toMatch(/createCluster|\.query\(|cosineQuery|clusterArticle\(|recordAdmission|evaluateJev|enrichArticleInMemory|persistEnrichment/);
  });
});

// ---------------------------------------------------------------------------
// Wave BF / W3 (2026-11-02): daily Resmi Gazete roundups are never clustered.
//
// bha's "Resmi Gazete'de bugun: 1 Kasim 2026 Resmi Gazete kararlari" sat inside the
// 16-article appointments cluster 85700dfa and the 2 Kasim one inside the 15-article
// Cevdet Yilmaz vekalet cluster 8f0bb5b8: a roundup lists every decision of the day,
// so its title is similar to whichever single story the day's headlines share.
// isRoundupTitle() (supabase/functions/_shared/cluster/roundup-title.ts) recognises
// those whole-title shapes; clusterArticle and processAttach skip them, AFTER the
// enrichment is stored and BEFORE any cluster context or scoring. No cluster_skip_log
// row is written (its cluster_id is NOT NULL and there is no cluster).
// ---------------------------------------------------------------------------
describe("roundup titles are never clustered (Resmi Gazete roundups, wave BF W3)", () => {
  const ROUNDUP = "Resmi Gazete'de bugün: 2 Kasım 2026 Resmi Gazete kararları";
  const STORY = "Resmi Gazete'de yayımlandı: Cumhurbaşkanlığına Cevdet Yılmaz vekalet edecek";
  const SEEDED = "c-roundup-target";
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    vi.restoreAllMocks();
  });

  /** An existing cluster whose seed carries `title` and a src-outlet member: an
   * incoming src-wire article with the same title joins it unless it is skipped. */
  function seedTarget(title: string) {
    clusterRows.push({
      id: SEEDED,
      title_tr: title,
      title_tr_neutral: title,
      first_published: ago(40 * 60_000),
      updated_at: ago(60_000),
      article_count: 1,
    });
    clusterArticleRows.push({ cluster_id: SEEDED, article_id: "seed-member" });
    fakeArticles["seed-member"] = {
      id: "seed-member",
      source_id: "src-outlet",
      title,
      description: "Detay",
      published_at: ago(30 * 60_000),
      fingerprint: "fp-seed-member",
      entities: [],
      category: "politika",
      minhash_sig: null,
      minhash_version: null,
    };
  }

  function queueWork(opts: { id: string; msgId: number; title: string; category?: string; admit?: "shadow" | "live" }) {
    const message: { article_id: string; admit?: string } = { article_id: opts.id };
    if (opts.admit) message.admit = opts.admit;
    (pgmqState.pending as unknown as Array<{ msg_id: number; read_ct: number; message: unknown }>).push({
      msg_id: opts.msgId,
      read_ct: 1,
      message,
    });
    fakeArticles[opts.id] = {
      id: opts.id,
      source_id: "src-wire",
      title: opts.title,
      description: "Detay",
      url: `https://example.com/${opts.id}`,
      category: opts.category ?? "politika",
      published_at: new Date().toISOString(),
    };
  }

  interface RoundupBody {
    drained: number;
    matched: number;
    created: number;
    skipped: number;
    roundupSkipped: number;
    failedTransient: number;
    failedPermanent: number;
    admission: { would_match: number; would_create: number; disabled: number; rejected: number };
    attach: {
      mode: string;
      read: number;
      would_attach: number;
      attached: number;
      failed: number;
      by_reason: Record<string, number>;
    };
  }

  async function drain(): Promise<RoundupBody> {
    const handler = await importHandler();
    if (!handler) throw new Error("unreachable");
    const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as RoundupBody;
  }

  const linkedClusters = () =>
    supabaseFakeCalls.rpc
      .filter((r) => r.name === "cluster_link_atomic")
      .map((r) => (r.args as { p_cluster_id: string }).p_cluster_id);
  const skipLogWrites = () => supabaseFakeCalls.forTable("cluster_skip_log");
  const roundupLogs = () =>
    (logSpy.mock.calls as unknown[][])
      .map((c) => c[0])
      .filter((m): m is string => typeof m === "string" && m.includes("roundup-title skip"));
  const enrichmentWrites = () =>
    supabaseFakeCalls
      .update("articles")
      .filter((m) => m.patch !== null && typeof m.patch === "object" && "fingerprint" in (m.patch as object));

  /** No cluster was created, no article was linked, nothing was scored, no skip row. */
  function expectNothingClustered() {
    expect(linkedClusters()).toEqual([]);
    expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
    expect(supabaseFakeCalls.insert("cluster_articles")).toHaveLength(0);
    expect(supabaseFakeCalls.upsert("cluster_articles")).toHaveLength(0);
    expect(skipLogWrites()).toHaveLength(0);
    expect(vi.mocked(scoreMock)).not.toHaveBeenCalled();
  }

  describe("cluster_work, live (politika)", () => {
    it("a politika article titled as a roundup is skipped 'roundup-title': no link, no cluster, no skip-log row, message archived", async () => {
      seedTarget(ROUNDUP);
      queueWork({ id: "art-rg-live", msgId: 8101, title: ROUNDUP });

      const body = await drain();

      expect(body.skipped).toBe(1);
      expect(body.roundupSkipped).toBe(1);
      expect(body.matched).toBe(0);
      expect(body.created).toBe(0);
      expect(body.failedTransient).toBe(0);
      expect(body.failedPermanent).toBe(0);
      expect(body.drained).toBe(1);
      expectNothingClustered();
      expect(pgmqState.archived).toContain(8101);
      expect(roundupLogs()).toEqual(["[cluster-consumer] roundup-title skip article=art-rg-live"]);
    });

    it("the enrichment is still stored (the skip comes AFTER persistEnrichment)", async () => {
      seedTarget(ROUNDUP);
      queueWork({ id: "art-rg-enrich", msgId: 8102, title: ROUNDUP });

      await drain();

      const writes = enrichmentWrites();
      expect(writes).toHaveLength(1);
      expect(Object.keys(writes[0]!.patch as object).sort()).toEqual([
        "entities",
        "fingerprint",
        "minhash_sig",
        "minhash_version",
      ]);
    });

    it("control: the same article with a single-story Resmi Gazete headline joins the cluster (the skip is the only reason the roundup did not)", async () => {
      seedTarget(STORY);
      queueWork({ id: "art-rg-story", msgId: 8103, title: STORY });

      const body = await drain();

      expect(body.roundupSkipped).toBe(0);
      expect(body.skipped).toBe(0);
      expect(body.matched).toBe(1);
      expect(linkedClusters()).toEqual([SEEDED]);
      expect(roundupLogs()).toEqual([]);
      expect(pgmqState.archived).toContain(8103);
    });

    it.each([
      "Resmi Gazete'de yayımlandı: Asgari ücret desteği uzatıldı",
      "Atama kararları Resmi Gazete'de: Ankara Valiliğine Vasip Şahin atandı",
      "Merkez Bankası Başkan Yardımcısı atandı: Resmi Gazete'de yayımlandı",
      "Resmi Gazete'de bugün yayımlanan kararla emekli ikramiyesi yükseldi",
      "Erdoğan imzaladı, Resmi Gazete'de yayımlandı: 3 üniversiteye rektör",
      "Gündem özeti: Erdoğan ile Bahçeli görüştü",
    ])("a must-keep headline still clusters: %s", async (title) => {
      queueWork({ id: "art-rg-keep", msgId: 8104, title });

      const body = await drain();

      expect(body.roundupSkipped).toBe(0);
      expect(body.skipped).toBe(0);
      expect(body.created + body.matched).toBe(1);
      expect(roundupLogs()).toEqual([]);
    });

    it("a mixed batch: only the roundups are skipped, in order, and the summary counts them", async () => {
      queueWork({ id: "art-mix-1", msgId: 8111, title: ROUNDUP });
      queueWork({ id: "art-mix-2", msgId: 8112, title: STORY });
      queueWork({ id: "art-mix-3", msgId: 8113, title: "Resmi Gazete'de bugün (02.11.2026)" });
      queueWork({ id: "art-mix-4", msgId: 8114, title: "Günün önemli gelişmeleri" });

      const body = await drain();

      expect(body.drained).toBe(4);
      expect(body.roundupSkipped).toBe(3);
      expect(body.skipped).toBe(3);
      expect(body.created + body.matched).toBe(1);
      expect(roundupLogs()).toEqual([
        "[cluster-consumer] roundup-title skip article=art-mix-1",
        "[cluster-consumer] roundup-title skip article=art-mix-3",
        "[cluster-consumer] roundup-title skip article=art-mix-4",
      ]);
      expect(pgmqState.archived).toEqual(expect.arrayContaining([8111, 8112, 8113, 8114]));
    });

    it("roundupSkipped is part of every summary and starts at 0 (an empty drain, a drain with no roundup)", async () => {
      const empty = await drain();
      expect(empty.roundupSkipped).toBe(0);
      expect(empty.skipped).toBe(0);
    });

    it("other skip reasons do not count as roundup skips", async () => {
      // h12-cluster-1: a same-source twin is skipped with reason same-source-duplicate.
      clusterRows.push({
        id: "c-twin",
        title_tr: STORY,
        title_tr_neutral: STORY,
        first_published: ago(40 * 60_000),
        updated_at: ago(60_000),
        article_count: 18,
      });
      clusterArticleRows.push({ cluster_id: "c-twin", article_id: "twin-member" });
      fakeArticles["twin-member"] = {
        id: "twin-member",
        source_id: "src-wire",
        title: STORY,
        description: "Detay",
        published_at: ago(30 * 60_000),
        fingerprint: "fp-twin-member",
        entities: [],
        category: "politika",
        minhash_sig: null,
        minhash_version: null,
      };
      queueWork({ id: "art-twin-skip", msgId: 8121, title: STORY });

      const body = await drain();

      expect(body.skipped).toBe(1);
      expect(body.roundupSkipped).toBe(0);
      expect(roundupLogs()).toEqual([]);
    });
  });

  describe("cluster_work, dry-run (admit 'shadow')", () => {
    beforeEach(() => {
      process.env.JEV_POLITICS_ADMISSION = "shadow";
    });

    it("an admitted roundup is skipped in the dry-run too: nothing recorded, nothing written, no would_match / would_create", async () => {
      seedTarget(ROUNDUP);
      queueWork({ id: "art-rg-shadow", msgId: 8201, title: ROUNDUP, category: "ekonomi", admit: "shadow" });

      const body = await drain();

      expect(body.skipped).toBe(1);
      expect(body.roundupSkipped).toBe(1);
      expect(body.admission.would_match).toBe(0);
      expect(body.admission.would_create).toBe(0);
      expect(body.matched).toBe(0);
      expect(body.created).toBe(0);
      expectNothingClustered();
      // A dry-run never persists enrichment, and a skipped outcome is not an admission outcome.
      expect(supabaseFakeCalls.update("articles")).toHaveLength(0);
      expect(supabaseFakeCalls.rpc.filter((r) => r.name === "jev_politics_admission_record")).toHaveLength(0);
      expect(pgmqState.archived).toContain(8201);
      expect(roundupLogs()).toEqual(["[cluster-consumer] roundup-title skip article=art-rg-shadow dry-run"]);
    });

    it("control: the same admitted article with a story headline is a would_match", async () => {
      seedTarget(STORY);
      queueWork({ id: "art-rg-shadow-story", msgId: 8202, title: STORY, category: "ekonomi", admit: "shadow" });

      const body = await drain();

      expect(body.roundupSkipped).toBe(0);
      expect(body.skipped).toBe(0);
      expect(body.admission.would_match).toBe(1);
      expect(linkedClusters()).toEqual([]); // a dry-run never links
      expect(roundupLogs()).toEqual([]);
    });
  });

  describe("cluster_attach (processAttach)", () => {
    const ATTACH_ID = "art-rg-attach";
    const CLUSTER = "c-attach-target";

    /** A 3-member politics cluster whose headline is `title`: an incoming genel article
     * with the same title attaches by the exact-title lane. */
    function seedAttachTarget(title: string) {
      clusterRows.push({
        id: CLUSTER,
        title_tr: title,
        title_tr_neutral: title,
        first_published: ago(40 * 60_000),
        updated_at: ago(5 * 60_000),
        article_count: 3,
      });
      for (const [i, src] of ["src-aksam", "src-star", "src-haber7"].entries()) {
        const id = `att-m${i}`;
        clusterArticleRows.push({ cluster_id: CLUSTER, article_id: id });
        fakeArticles[id] = {
          id,
          source_id: src,
          title,
          description: `Ayrıntı ${id}`,
          published_at: ago((12 + 2 * i) * 60_000),
          fingerprint: `fp-${id}`,
          entities: [],
          category: "politika",
          politics_admitted_at: null,
          minhash_sig: null,
          minhash_version: null,
        };
      }
    }

    function seedIncoming(title: string) {
      fakeArticles[ATTACH_ID] = {
        id: ATTACH_ID,
        source_id: "src-hurriyet",
        title,
        description: "Detay",
        url: "https://example.com/attach-rg",
        content_hash: "h-attach-rg",
        category: "genel",
        politics_admitted_at: null,
        published_at: ago(3 * 60_000),
      };
      pgmqState.attachPending.push({
        msg_id: 8301,
        read_ct: 1,
        message: { article_id: ATTACH_ID, admit: "attach" },
      });
    }

    it("SHADOW: a roundup is skipped 'roundup-title': by_reason counts it, no shadow row, message deleted", async () => {
      seedAttachTarget(ROUNDUP);
      seedIncoming(ROUNDUP);

      const body = await drain();

      expect(body.attach).toMatchObject({ mode: "shadow", read: 1, would_attach: 0, attached: 0, failed: 0 });
      expect(body.attach.by_reason).toEqual({ "roundup-title": 1 });
      expect(supabaseFakeCalls.upsert("cluster_attach_shadow")).toHaveLength(0);
      expect(supabaseFakeCalls.update("articles")).toHaveLength(0);
      expectNothingClustered();
      expect(pgmqState.attachDeleted).toEqual([8301]);
      // The cluster_work counters are not touched by an attach message.
      expect(body.skipped).toBe(0);
      expect(body.roundupSkipped).toBe(0);
    });

    it("LIVE: a roundup is skipped before the stamp: no politics_admitted_at, no link, no shadow row", async () => {
      process.env.CLUSTER_ATTACH_MODE = "live";
      seedAttachTarget(ROUNDUP);
      seedIncoming(ROUNDUP);

      const body = await drain();

      expect(body.attach).toMatchObject({ mode: "live", read: 1, would_attach: 0, attached: 0, failed: 0 });
      expect(body.attach.by_reason).toEqual({ "roundup-title": 1 });
      expect(supabaseFakeCalls.update("articles")).toHaveLength(0);
      expect(supabaseFakeCalls.upsert("cluster_attach_shadow")).toHaveLength(0);
      expectNothingClustered();
      expect(pgmqState.attachDeleted).toEqual([8301]);
    });

    it("control: the same article with a story headline attaches (SHADOW would_attach, LIVE attached)", async () => {
      seedAttachTarget(STORY);
      seedIncoming(STORY);
      const shadow = await drain();
      expect(shadow.attach).toMatchObject({ mode: "shadow", would_attach: 1, by_reason: {} });
      expect(supabaseFakeCalls.upsert("cluster_attach_shadow")).toHaveLength(1);
    });

    it("control: LIVE attaches the story headline through cluster_link_atomic", async () => {
      process.env.CLUSTER_ATTACH_MODE = "live";
      seedAttachTarget(STORY);
      seedIncoming(STORY);
      const live = await drain();
      expect(live.attach).toMatchObject({ mode: "live", attached: 1, by_reason: {} });
      expect(linkedClusters()).toEqual([CLUSTER]);
    });

    it("an attach roundup is checked after the route (an article already in the gate is 'in-gate', not 'roundup-title')", async () => {
      seedAttachTarget(ROUNDUP);
      seedIncoming(ROUNDUP);
      (fakeArticles[ATTACH_ID] as Record<string, unknown>).category = "politika";

      const body = await drain();

      expect(body.attach.by_reason).toEqual({ "in-gate": 1 });
    });
  });

  describe("wiring (static)", () => {
    const src = readFileSync(resolve(__dirname, "../../supabase/functions/cluster-consumer/index.ts"), "utf8");

    it("imports isRoundupTitle and ROUNDUP_SKIP_REASON from the shared module, with the .ts relative import the other cluster helpers use", () => {
      expect(src).toContain('from "../_shared/cluster/roundup-title.ts"');
      expect(src).toContain("isRoundupTitle");
      expect(src).toContain("ROUNDUP_SKIP_REASON");
    });

    it("clusterArticle skips right after persistEnrichment and before getClusterContext", () => {
      const fn = src.slice(src.indexOf("async function clusterArticle("), src.indexOf("async function clusterArticle(") + 4000);
      const persisted = fn.indexOf("await persistEnrichment(article)");
      const check = fn.indexOf("isRoundupTitle(raw.title)");
      const context = fn.indexOf("await getClusterContext()");
      expect(persisted).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(persisted);
      expect(context).toBeGreaterThan(check);
      expect(fn).toContain("reason: ROUNDUP_SKIP_REASON");
    });

    it("processAttach skips after the route checks and before fingerprinting", () => {
      const start = src.indexOf("async function processAttach(");
      const fn = src.slice(start, src.indexOf("async function drainAttach(", start));
      const route = fn.indexOf('if (route !== "attach")');
      const check = fn.indexOf("isRoundupTitle(raw.title)");
      const fingerprint = fn.indexOf("strictFingerprint(");
      expect(route).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(route);
      expect(fingerprint).toBeGreaterThan(check);
      expect(fn).toContain("reason: ROUNDUP_SKIP_REASON");
    });

    it("never writes cluster_skip_log for a roundup (its cluster_id is NOT NULL and there is no cluster)", () => {
      const start = src.indexOf("isRoundupTitle(raw.title)");
      const around = src.slice(start, start + 600);
      expect(around).not.toContain("cluster_skip_log");
      expect(around).not.toContain("recordSkip");
    });
  });
});

// ---------------------------------------------------------------------------
// Contract reminder: every test asserts `expect(handler).toBeDefined()` so
// a missing or mis-imported SUT fails loud rather than silently passing as
// a no-op. The suite no longer skips when the handler cannot be loaded.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// h40-clusters-2 (2026-11-05): IndyTurk's nightly "Kısa haberler" digest is never
// clustered. Its title carries nothing; its description is the first item of the
// digest, and that is what matched: 7 of 14 digests joined unrelated politics
// clusters (b59f3bb6 with 43 articles, e7cde92e with 18, ...) and one seeded the
// 1-article cluster a520b58a titled "Kısa haberler". isRoundupTitle() now knows
// the title (shape I); the two existing skip sites in cluster-consumer handle it
// with no change of their own. The fake source list has no indyturk row, so the
// incoming article uses src-wire: the skip looks at the title only.
// ---------------------------------------------------------------------------
describe("the 'Kısa haberler' digest is never clustered (h40-clusters-2)", () => {
  const LEAD = "Erdoğan Bakü'ye gitti ve Aliyev ile görüştü";
  const DESCRIPTION = `${LEAD}. Bahçeli'den yeni açıklama geldi.`;
  const SEEDED = "c-kisa-target";
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  /** An existing politics cluster seeded by the digest's first item. */
  function seedCluster() {
    clusterRows.push({
      id: SEEDED,
      title_tr: LEAD,
      title_tr_neutral: LEAD,
      first_published: ago(40 * 60_000),
      updated_at: ago(60_000),
      article_count: 1,
    });
    clusterArticleRows.push({ cluster_id: SEEDED, article_id: "seed-member" });
    fakeArticles["seed-member"] = {
      id: "seed-member",
      source_id: "src-outlet",
      title: LEAD,
      description: DESCRIPTION,
      published_at: ago(30 * 60_000),
      fingerprint: "fp-seed-member",
      entities: [],
      category: "politika",
      minhash_sig: null,
      minhash_version: null,
    };
  }

  /** The digest: the same description as the seed, only the title differs. */
  function queueDigest(id: string, msgId: number, title: string) {
    (pgmqState.pending as unknown as Array<{ msg_id: number; read_ct: number; message: unknown }>).push({
      msg_id: msgId,
      read_ct: 1,
      message: { article_id: id },
    });
    fakeArticles[id] = {
      id,
      source_id: "src-wire",
      title,
      description: DESCRIPTION,
      url: `https://example.com/${id}`,
      category: "politika",
      published_at: new Date().toISOString(),
    };
  }

  async function drain(): Promise<{ drained: number; matched: number; created: number; skipped: number; roundupSkipped: number }> {
    const handler = await importHandler();
    if (!handler) throw new Error("unreachable");
    const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as Awaited<ReturnType<typeof drain>>;
  }

  const linkedClusters = () =>
    supabaseFakeCalls.rpc
      .filter((r) => r.name === "cluster_link_atomic")
      .map((r) => (r.args as { p_cluster_id: string }).p_cluster_id);

  it("an article titled 'Kısa haberler' whose description matches an existing cluster's seed is skipped 'roundup-title' and joins nothing", async () => {
    seedCluster();
    queueDigest("art-kisa", 9101, "Kısa haberler");

    const body = await drain();

    expect(body.drained).toBe(1);
    expect(body.skipped).toBe(1);
    expect(body.roundupSkipped).toBe(1);
    expect(body.matched).toBe(0);
    expect(body.created).toBe(0);
    expect(linkedClusters()).toEqual([]);
    expect(supabaseFakeCalls.insert("clusters")).toHaveLength(0);
    expect(supabaseFakeCalls.insert("cluster_articles")).toHaveLength(0);
    expect(supabaseFakeCalls.upsert("cluster_articles")).toHaveLength(0);
    expect(supabaseFakeCalls.forTable("cluster_skip_log")).toHaveLength(0);
    expect(vi.mocked(scoreMock)).not.toHaveBeenCalled();
    expect(pgmqState.archived).toContain(9101);
    expect(logSpy.mock.calls.map((c) => c[0])).toContain("[cluster-consumer] roundup-title skip article=art-kisa");
  });

  it("control: the same article and description under a story headline joins the cluster (the title is the only reason the digest did not)", async () => {
    seedCluster();
    queueDigest("art-kisa-story", 9102, "Kısa haberler: Erdoğan Bakü'ye gitti");

    const body = await drain();

    expect(body.roundupSkipped).toBe(0);
    expect(body.skipped).toBe(0);
    expect(body.matched).toBe(1);
    expect(linkedClusters()).toEqual([SEEDED]);
  });

  it.each(["KISA HABERLER", "Kısa Haberler", "Kısa haberler:", "Kısa haberler (4 Kasım 2026)", "Günün kısa haberleri"])(
    "the variant %j is skipped as well",
    async (title) => {
      seedCluster();
      queueDigest("art-kisa-variant", 9103, title);

      const body = await drain();

      expect(body.roundupSkipped).toBe(1);
      expect(body.matched).toBe(0);
      expect(linkedClusters()).toEqual([]);
    },
  );
});

// ---------------------------------------------------------------------------
// h101-e2elatency-1 (migration 188, PR #252) long-polled the first cluster_work read in the
// UTC minutes where ingest-drain runs (minute % 3 === 0). h102-pollregression-1 switched it
// OFF again (`POLL_ENABLED = false` in cluster-consumer/index.ts): the held-open request made
// pg_net send ingest-drain later (ingest_cycles.started_at moved from :00-:09 to :13-:19 of its
// minute after cluster-consumer v51, 2026-11-09 09:50Z) and the attach time did not shrink. The
// deployed drain must therefore behave, call for call, as the pre-#252 consumer (866a1d6) does
// in EVERY minute: one plain readBatch per loop turn, no readBatchPoll, `polls` 0.
// planClusterWorkPoll (here) and readBatchPoll / isPollRpcMissing (_shared/pgmq.ts, own tests)
// stay exported and tested for the later hunt that redesigns the wait. The clock is the fake
// Date, set per test.
//
// The call-sequence expectations below were taken from the pre-#252 consumer: the same
// assertions pass against `git show 866a1d6:supabase/functions/cluster-consumer/index.ts`
// (see the h102 report), so they pin "as before #252", not merely "as it is today".
// ---------------------------------------------------------------------------
describe("cluster_work long poll is switched off (h102-pollregression-1; was h101-e2elatency-1, migration 188)", () => {
  // minute % 3 === 0 (ingest-drain's minutes, formerly polled): 08:03, 08:00, 08:57. Any other minute never polled.
  const INGEST_MINUTE = "2026-11-09T08:03:02Z";
  const PLAIN_MINUTE = "2026-11-09T08:04:02Z";
  const INGEST_MINUTES = [INGEST_MINUTE, "2026-11-09T08:00:02Z", "2026-11-09T08:57:02Z", "2026-11-09T13:30:02Z"];
  const PLAIN_MINUTES = [PLAIN_MINUTE, "2026-11-09T08:01:02Z", "2026-11-09T08:02:59Z", "2026-11-09T08:05:30Z", "2026-11-09T08:59:59Z"];
  const IMPORT = "../../supabase/functions/cluster-consumer/index.ts";
  const PGMQ = "../../supabase/functions/_shared/pgmq.ts";
  const CONSUMER_SRC = () => readFileSync(resolve(__dirname, IMPORT), "utf8");

  interface PollBody {
    drained: number;
    matched: number;
    created: number;
    failedTransient: number;
    failedPermanent: number;
    budgeted_out: boolean;
    polls: number;
    attach: { read: number };
  }

  const msgOf = (n: number): PgmqMessage => ({ msg_id: 900 + n, read_ct: 1, message: { article_id: `art-lp-${n}` } });

  function seedArticle(n: number) {
    fakeArticles[`art-lp-${n}`] = {
      id: `art-lp-${n}`,
      source_id: "src-outlet",
      title: `Uzun bekleme politika haberi ${n} bambaşka konu`,
      description: "Detay",
      url: `https://example.com/lp${n}`,
      category: "politika",
      published_at: new Date(Date.now() - 60_000).toISOString(),
    };
  }

  /** Sets the fake clock and runs one drain. The clock stays where the drain left it (afterEach restores the real one). */
  async function drainAt(iso: string): Promise<PollBody> {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    const handler = await importHandler();
    if (!handler) throw new Error("unreachable");
    const res = await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(res.status).toBe(200);
    return (await res.json()) as PollBody;
  }

  // The pgmq call sequences of the pre-#252 consumer, one string per call (see pgmqState.calls).
  const DEPTH = "queueDepth(cluster_work)";
  const WORK_READ = "readBatch(cluster_work,vt=60,qty=2)";
  const ATTACH_READ = "readBatch(cluster_attach,vt=60,qty=25)";
  const ATTACH_DEPTH = "queueDepth(cluster_attach)"; // drainAttach ends with its own depth probe
  const ARCHIVE = (n: number) => `archive(cluster_work,${900 + n})`;

  interface Scenario {
    name: string;
    messages: number;
    readError?: string;
    expected: string[];
    drained: number;
    failedTransient: number;
  }
  const SCENARIOS: Scenario[] = [
    { name: "an empty queue", messages: 0, expected: [DEPTH, WORK_READ, ATTACH_READ, ATTACH_DEPTH, DEPTH], drained: 0, failedTransient: 0 },
    { name: "one message (a short batch ends the loop)", messages: 1, expected: [DEPTH, WORK_READ, ARCHIVE(1), ATTACH_READ, ATTACH_DEPTH, DEPTH], drained: 1, failedTransient: 0 },
    {
      name: "two messages (a full batch, then one empty read)",
      messages: 2,
      expected: [DEPTH, WORK_READ, ARCHIVE(1), ARCHIVE(2), WORK_READ, ATTACH_READ, ATTACH_DEPTH, DEPTH],
      drained: 2,
      failedTransient: 0,
    },
    {
      name: "three messages (a full batch, then a short one)",
      messages: 3,
      expected: [DEPTH, WORK_READ, ARCHIVE(1), ARCHIVE(2), WORK_READ, ARCHIVE(3), ATTACH_READ, ATTACH_DEPTH, DEPTH],
      drained: 3,
      failedTransient: 0,
    },
    {
      name: "a failing first read (the drain stops, no attach read, no fallback read)",
      messages: 0,
      readError: "pgmq.read(cluster_work): canceling statement due to statement timeout",
      expected: [DEPTH, WORK_READ, DEPTH],
      drained: 0,
      failedTransient: 1,
    },
  ];

  /** One drain of `sc` from a clean slate (fresh SUT, empty queue state), at the fake clock `iso`. */
  async function runScenario(iso: string, sc: Scenario) {
    vi.resetModules();
    resetPgmqState();
    clusterRows.length = 0;
    clusterArticleRows.length = 0;
    for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
    for (let n = 1; n <= sc.messages; n++) seedArticle(n);
    pgmqState.pending = Array.from({ length: sc.messages }, (_, i) => msgOf(i + 1));
    if (sc.readError) pgmqState.workReadError = sc.readError;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const body = await drainAt(iso);
      return { body, calls: [...pgmqState.calls] };
    } finally {
      err.mockRestore();
    }
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("guard: POLL_ENABLED is false, and it stays false until the consumer stops holding the pg_net request while it waits", () => {
    const match = /^const POLL_ENABLED = (true|false);/m.exec(CONSUMER_SRC());
    expect(match, "cluster-consumer/index.ts must declare `const POLL_ENABLED = false;` next to the POLL_* constants").not.toBeNull();
    expect(
      match?.[1],
      "POLL_ENABLED must stay false (h102-pollregression-1): the cluster-drain long poll held its pg_net request open ~13 s and " +
        "pg_net sent the queued ingest-drain request behind it (ingest_cycles.started_at seconds-of-minute moved from :00-:09 to " +
        ":13-:19 after cluster-consumer v51, 2026-11-09 09:50Z) without shortening the attach time. Turning it on needs a design " +
        "where the invocation answers first and polls inside EdgeRuntime.waitUntil, or a separate trigger; see docs/migration-guide.md, section 188, Status.",
    ).toBe("false");
  });

  describe("the plan (pure, clock injected)", () => {
    const START = Date.parse("2026-11-09T08:03:02Z");
    async function plan() {
      await importHandler();
      const mod = await import(IMPORT);
      return mod.planClusterWorkPoll as (i: { startedAtMs: number; nowMs: number; pollsMade: number }) => number;
    }

    it.each([
      ["2026-11-09T08:03:00.000Z", 6],
      ["2026-11-09T08:03:59.999Z", 6],
      ["2026-11-09T08:00:30.000Z", 6],
      ["2026-11-09T08:57:02.000Z", 6],
      ["2026-11-09T23:57:02.000Z", 6],
      ["2026-11-09T08:02:59.999Z", 0],
      ["2026-11-09T08:04:00.000Z", 0],
      ["2026-11-09T08:05:59.999Z", 0],
      ["2026-11-09T08:58:02.000Z", 0],
      ["2026-11-09T08:59:59.999Z", 0],
    ])("the first poll of an invocation that starts at %s waits %s s", async (iso, seconds) => {
      const planPoll = await plan();
      const t = Date.parse(iso);
      expect(planPoll({ startedAtMs: t, nowMs: t, pollsMade: 0 })).toBe(seconds);
    });

    it("decides the minute from when the invocation STARTED, not from the clock at the read", async () => {
      const planPoll = await plan();
      // started 08:02:59.5 (no poll), now 08:03:01 (poll minute): still no poll; and the reverse.
      const early = Date.parse("2026-11-09T08:02:59.500Z");
      expect(planPoll({ startedAtMs: early, nowMs: early + 1_500, pollsMade: 0 })).toBe(0);
      const late = Date.parse("2026-11-09T08:03:59.500Z");
      expect(planPoll({ startedAtMs: late, nowMs: late + 1_500, pollsMade: 0 })).toBe(6);
    });

    it("allows the second poll only while less than 14 s have passed since the start", async () => {
      const planPoll = await plan();
      expect(planPoll({ startedAtMs: START, nowMs: START + 13_999, pollsMade: 1 })).toBeGreaterThan(0);
      expect(planPoll({ startedAtMs: START, nowMs: START + 14_000, pollsMade: 1 })).toBe(0);
      expect(planPoll({ startedAtMs: START, nowMs: START + 20_000, pollsMade: 1 })).toBe(0);
    });

    it("never plans a third poll, however early it is", async () => {
      const planPoll = await plan();
      expect(planPoll({ startedAtMs: START, nowMs: START, pollsMade: 2 })).toBe(0);
      expect(planPoll({ startedAtMs: START, nowMs: START, pollsMade: 3 })).toBe(0);
    });

    it("shortens the wait so a poll ends no later than the read-budget floor (25 s of 30)", async () => {
      const planPoll = await plan();
      expect(planPoll({ startedAtMs: START, nowMs: START + 19_000, pollsMade: 0 })).toBe(6);
      expect(planPoll({ startedAtMs: START, nowMs: START + 19_001, pollsMade: 0 })).toBe(5);
      expect(planPoll({ startedAtMs: START, nowMs: START + 22_000, pollsMade: 0 })).toBe(3);
      expect(planPoll({ startedAtMs: START, nowMs: START + 24_000, pollsMade: 0 })).toBe(1);
      expect(planPoll({ startedAtMs: START, nowMs: START + 24_001, pollsMade: 0 })).toBe(0);
      expect(planPoll({ startedAtMs: START, nowMs: START + 25_000, pollsMade: 0 })).toBe(0);
      expect(planPoll({ startedAtMs: START, nowMs: START + 40_000, pollsMade: 0 })).toBe(0);
    });

    it("invariant: whatever the elapsed time, the poll window never ends after the 25 s floor and is 0 or 1..6 s", async () => {
      const planPoll = await plan();
      for (let elapsed = -2_000; elapsed <= 40_000; elapsed += 250) {
        for (const pollsMade of [0, 1]) {
          const secs = planPoll({ startedAtMs: START, nowMs: START + elapsed, pollsMade });
          expect(Number.isInteger(secs)).toBe(true);
          expect(secs).toBeGreaterThanOrEqual(0);
          expect(secs).toBeLessThanOrEqual(6);
          if (secs > 0) expect(Math.max(elapsed, 0) + secs * 1000).toBeLessThanOrEqual(25_000);
        }
      }
    });

    it("answers 0 for a clock that is not a number", async () => {
      const planPoll = await plan();
      expect(planPoll({ startedAtMs: Number.NaN, nowMs: START, pollsMade: 0 })).toBe(0);
      expect(planPoll({ startedAtMs: START, nowMs: Number.NaN, pollsMade: 0 })).toBe(0);
      expect(planPoll({ startedAtMs: START, nowMs: Number.POSITIVE_INFINITY, pollsMade: 0 })).toBe(0);
    });
  });

  describe("an ingest minute (minute % 3 === 0) drains exactly like before #252", () => {
    it.each(INGEST_MINUTES)("%s, empty queue: one readBatch(cluster_work, vt 60, qty 2), then the attach read; no poll", async (iso) => {
      const sc = SCENARIOS[0]!;
      const { body, calls } = await runScenario(iso, sc);
      const pgmq = await import(PGMQ);
      expect(calls).toEqual(sc.expected);
      expect(pgmqState.polls).toEqual([]);
      expect(vi.mocked(pgmq.readBatchPoll)).not.toHaveBeenCalled();
      // The arguments, not only the names: the client, queue, visibility timeout and batch size of the pre-#252 reads.
      const readArgs = vi.mocked(pgmq.readBatch).mock.calls.map(([client, ...rest]) => [client === supabaseFakeClient, ...rest]);
      expect(readArgs).toEqual([
        [true, "cluster_work", 60, 2],
        [true, "cluster_attach", 60, 25],
      ]);
      expect(supabaseFakeCalls.rpc.map((r) => r.name)).not.toContain("pgmq_read_msgs_poll");
      expect(body.polls).toBe(0);
      expect(body.failedTransient).toBe(0);
      expect(body.budgeted_out).toBe(false);
    });

    it.each(SCENARIOS)("$name: the pgmq call sequence is the pre-#252 one, no poll, summary.polls is 0", async (sc) => {
      const { body, calls } = await runScenario(INGEST_MINUTE, sc);
      const pgmq = await import(PGMQ);
      expect(calls).toEqual(sc.expected);
      expect(pgmqState.polls).toEqual([]);
      expect(vi.mocked(pgmq.readBatchPoll)).not.toHaveBeenCalled();
      expect(calls.some((c) => c.startsWith("readBatchPoll("))).toBe(false);
      expect(supabaseFakeCalls.rpc.map((r) => r.name)).not.toContain("pgmq_read_msgs_poll");
      expect(body.polls).toBe(0);
      expect(body.drained).toBe(sc.drained);
      expect(body.failedTransient).toBe(sc.failedTransient);
      expect(body.budgeted_out).toBe(false);
      if (sc.messages > 0) expect(pgmqState.archived).toEqual(Array.from({ length: sc.messages }, (_, i) => 901 + i));
    });

    it.each(SCENARIOS)("$name: an ingest minute and a plain minute make the same pgmq calls and report the same counters", async (sc) => {
      const ingest = await runScenario(INGEST_MINUTE, sc);
      const plain = await runScenario(PLAIN_MINUTE, sc);
      expect(ingest.calls).toEqual(plain.calls);
      const counters = (b: PollBody) => ({
        drained: b.drained,
        matched: b.matched,
        created: b.created,
        failedTransient: b.failedTransient,
        failedPermanent: b.failedPermanent,
        budgeted_out: b.budgeted_out,
        polls: b.polls,
        attachRead: b.attach.read,
      });
      expect(counters(ingest.body)).toEqual(counters(plain.body));
    });

    it("a slow first read does not change the sequence either: the clock moving mid-drain never adds a read or a poll", async () => {
      seedArticle(1);
      pgmqState.pending = [msgOf(1)];
      // The first cluster_work read "takes" 7 s, as a poll would have; nothing in the drain may react to that.
      pgmqState.afterWorkRead = () => vi.setSystemTime(new Date(Date.now() + 7_000));
      const body = await drainAt(INGEST_MINUTE);
      expect(pgmqState.calls).toEqual([DEPTH, WORK_READ, ARCHIVE(1), ATTACH_READ, ATTACH_DEPTH, DEPTH]);
      expect(pgmqState.polls).toEqual([]);
      expect(body.polls).toBe(0);
      expect(body.drained).toBe(1);
    });
  });

  describe("any other minute is unchanged", () => {
    it.each(PLAIN_MINUTES)("%s reads with the plain readBatch only: no poll call, one empty read, then the attach queue", async (iso) => {
      const { body, calls } = await runScenario(iso, SCENARIOS[0]!);
      expect(calls).toEqual(SCENARIOS[0]!.expected);
      expect(pgmqState.polls).toEqual([]);
      expect(pgmqState.reads).toEqual([
        { queue: "cluster_work", qty: 2 },
        { queue: "cluster_attach", qty: 25 },
      ]);
      expect(body.polls).toBe(0);
      expect(body.failedTransient).toBe(0);
    });

    it.each(PLAIN_MINUTES)("%s: a queued message is read and archived as before", async (iso) => {
      const { body, calls } = await runScenario(iso, SCENARIOS[1]!);
      expect(calls).toEqual(SCENARIOS[1]!.expected);
      expect(pgmqState.polls).toEqual([]);
      expect(pgmqState.archived).toEqual([901]);
      expect(body.drained).toBe(1);
      expect(body.polls).toBe(0);
    });
  });

  it("wiring (static): POLL_ENABLED gates the one readBatchPoll call, the helpers stay exported, the consumer never sleeps itself", () => {
    const src = CONSUMER_SRC();
    // The ternary of the fix spec: the plan is not even consulted while the flag is off.
    expect(src).toContain("const pollSeconds = POLL_ENABLED && polling");
    expect(src).toContain("readBatchPoll,");
    expect(src).toContain("isPollRpcMissing,");
    expect(src.split("await readBatchPoll").length - 1).toBe(1);
    expect(src.includes("setTimeout(")).toBe(false);
    expect(src).toContain("export function planClusterWorkPoll(");
    // The pure helper of the shared module and its error classifier are kept for the later hunt.
    const shared = readFileSync(resolve(__dirname, PGMQ), "utf8");
    expect(shared).toContain("export async function readBatchPoll<");
    expect(shared).toContain("export function isPollRpcMissing(");
  });
});

// ---------------------------------------------------------------------------
// h106-attachdesign-1 (migration 190): the consumer lease and the ingest kick.
//
// Attach still waited p50 55 s after #253 switched the long poll off: cluster-drain reads at about :02 of
// every minute and ingest inserts at :04-:12 of its minute. The design: ingest POSTs {"trigger":"ingest"}
// to this function from EdgeRuntime.waitUntil once its enqueue is done (CLUSTER_KICK=on), and a TTL lease
// row (public.consumer_leases, two RPCs) keeps the cron-triggered consumer and the kicked one, in different
// isolates, from reading cluster_work at the same time (two readers would score one story's messages in
// parallel and open twins).
//
//   cron   (no body, or any body that is not {trigger:'ingest'}): acquire once; busy answers
//          {ok:true,busy:true,reason:'lease'} before any read; an RPC that is missing or errors FAILS OPEN
//          (today's drain);
//   kick   ({trigger:'ingest'}): queue depth first (0: leave without touching the lease), then wait up to
//          10 s in steps of 400 ms for the lease, re-checking the depth on every failed try; an RPC error
//          FAILS CLOSED;
//   both   after acquiring, renew at every read-loop turn (a false answer sets lease_lost and stops the
//          reads), release in the handler's finally before drainInFlight is cleared;
//   CLUSTER_LEASE=off  skips every lease call: the cron drain is call for call the pre-190 drain.
//
// Everything here runs on the lease fake of the harness (an in-memory twin of the SQL) and on pgmqState,
// whose `calls` is the call sequence the h102 block already compares literally.
// ---------------------------------------------------------------------------
describe("cluster consumer lease and ingest kick (h106-attachdesign-1, migration 190)", () => {
  const IMPORT = "../../supabase/functions/cluster-consumer/index.ts";
  const PGMQ = "../../supabase/functions/_shared/pgmq.ts";
  const CONSUMER_SRC = () => readFileSync(resolve(__dirname, IMPORT), "utf8");
  const URL = "http://localhost/cluster-consumer";
  const AT = "2026-11-10T12:00:02Z";
  const KICK = { trigger: "ingest" } as const;

  const DEPTH = "queueDepth(cluster_work)";
  const WORK_READ = "readBatch(cluster_work,vt=60,qty=2)";
  const ATTACH_READ = "readBatch(cluster_attach,vt=60,qty=25)";
  const ATTACH_DEPTH = "queueDepth(cluster_attach)";
  const ARCHIVE = (n: number) => `archive(cluster_work,${800 + n})`;

  type Json = Record<string, unknown>;

  const msgOf = (n: number): PgmqMessage => ({ msg_id: 800 + n, read_ct: 1, message: { article_id: `art-ls-${n}` } });
  function seedArticle(n: number) {
    fakeArticles[`art-ls-${n}`] = {
      id: `art-ls-${n}`,
      source_id: "src-outlet",
      title: `Kira artışı sonrası yeni düzenleme ${n} bambaşka konu`,
      description: "Detay",
      url: `https://example.com/ls${n}`,
      category: "politika",
      published_at: new Date(Date.now() - 60_000).toISOString(),
    };
  }
  function seedQueue(n: number) {
    for (let i = 1; i <= n; i++) seedArticle(i);
    pgmqState.pending = Array.from({ length: n }, (_, i) => msgOf(i + 1));
  }

  /** One POST to the handler of the SUT already imported in this test. */
  async function post(body?: unknown, handler?: (req: Request) => Promise<Response>): Promise<{ status: number; json: Json }> {
    const h = handler ?? (await importHandler());
    if (!h) throw new Error("unreachable");
    const init: RequestInit = { method: "POST" };
    if (body !== undefined) {
      init.body = typeof body === "string" ? body : JSON.stringify(body);
      init.headers = { "content-type": "application/json" };
    }
    const res = await h(authedRequest(URL, init));
    return { status: res.status, json: (await res.json()) as Json };
  }

  function clockAt(iso: string, toFake: Array<"Date" | "setTimeout"> = ["Date"]) {
    vi.useFakeTimers({ toFake });
    vi.setSystemTime(new Date(iso));
  }

  /** A drain from a clean slate: fresh SUT, empty queue state, `messages` queued, env set, clock fixed. */
  async function runDrain(opts: { messages?: number; env?: Record<string, string>; body?: unknown; prepare?: () => void; iso?: string } = {}) {
    vi.resetModules();
    resetPgmqState();
    clusterRows.length = 0;
    clusterArticleRows.length = 0;
    for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
    leaseFake.row = null;
    leaseFake.error = null;
    leaseFake.acquireScript.length = 0;
    leaseFake.calls.length = 0;
    supabaseFakeCalls.rpc.length = 0;
    supabaseFakeCalls.mutations.length = 0;
    fromTables.length = 0;
    delete process.env.CLUSTER_LEASE;
    delete process.env.CLUSTER_KICK;
    Object.assign(process.env, opts.env ?? {});
    clockAt(opts.iso ?? AT);
    seedQueue(opts.messages ?? 0);
    opts.prepare?.();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const out = await post(opts.body);
      return {
        ...out,
        pgmq: [...pgmqState.calls],
        lease: leaseFake.calls.map((c) => ({ ...c })),
        rpcNames: supabaseFakeCalls.rpc.map((r) => r.name),
        mutations: supabaseFakeCalls.mutations.map((m) => `${m.table}:${m.op}`),
        warns: warn.mock.calls.map((c) => c.map(String).join(" ")),
      };
    } finally {
      err.mockRestore();
      warn.mockRestore();
    }
  }

  const leaseRpcNames = (names: string[]) => names.filter((n) => n.startsWith("consumer_lease_"));
  const otherRpcNames = (names: string[]) => names.filter((n) => !n.startsWith("consumer_lease_"));

  /** Every cluster_work / cluster_attach message read of `calls` sits after a lease acquire that answered true. */
  function readsAreLeased(calls: string[], lease: Array<{ fn: string; result: boolean | string; at: number }>): boolean {
    const grants = lease.filter((c) => c.fn === "acquire" && c.result === true).map((c) => c.at);
    return calls.every((c, i) => !c.startsWith("readBatch(") || grants.some((at) => at <= i));
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  // The pre-190 pgmq call sequences (the same ones the h102 block pins against 866a1d6), and where the lease
  // calls sit in them: acquire before the first pgmq call, one renewal per loop turn (the turn's read has not
  // happened yet), the release after the last one.
  interface Scenario {
    name: string;
    messages: number;
    readError?: string;
    pgmq: string[];
    renewAts: number[];
    releaseAt: number;
    drained: number;
    failedTransient: number;
  }
  const SCENARIOS: Scenario[] = [
    { name: "an empty queue", messages: 0, pgmq: [DEPTH, WORK_READ, ATTACH_READ, ATTACH_DEPTH, DEPTH], renewAts: [1], releaseAt: 5, drained: 0, failedTransient: 0 },
    { name: "one message", messages: 1, pgmq: [DEPTH, WORK_READ, ARCHIVE(1), ATTACH_READ, ATTACH_DEPTH, DEPTH], renewAts: [1], releaseAt: 6, drained: 1, failedTransient: 0 },
    {
      name: "two messages (a full batch, then an empty read)",
      messages: 2,
      pgmq: [DEPTH, WORK_READ, ARCHIVE(1), ARCHIVE(2), WORK_READ, ATTACH_READ, ATTACH_DEPTH, DEPTH],
      renewAts: [1, 4],
      releaseAt: 8,
      drained: 2,
      failedTransient: 0,
    },
    {
      name: "three messages (a full batch, then a short one)",
      messages: 3,
      pgmq: [DEPTH, WORK_READ, ARCHIVE(1), ARCHIVE(2), WORK_READ, ARCHIVE(3), ATTACH_READ, ATTACH_DEPTH, DEPTH],
      renewAts: [1, 4],
      releaseAt: 9,
      drained: 3,
      failedTransient: 0,
    },
    {
      name: "a failing first read",
      messages: 0,
      readError: "pgmq.read(cluster_work): canceling statement due to statement timeout",
      pgmq: [DEPTH, WORK_READ, DEPTH],
      renewAts: [1],
      releaseAt: 3,
      drained: 0,
      failedTransient: 1,
    },
  ];

  describe("cron trigger, lease free (the default: CLUSTER_KICK and CLUSTER_LEASE unset)", () => {
    it.each(SCENARIOS)("$name: today's pgmq call sequence, with one acquire first, one renewal per turn and one release last", async (sc) => {
      const out = await runDrain({
        messages: sc.messages,
        prepare: () => {
          if (sc.readError) pgmqState.workReadError = sc.readError;
        },
      });
      expect(out.status).toBe(200);
      expect(out.pgmq).toEqual(sc.pgmq);
      expect(out.lease.map((c) => c.fn)).toEqual(["acquire", ...sc.renewAts.map(() => "acquire"), "release"]);
      expect(out.lease.map((c) => c.at)).toEqual([0, ...sc.renewAts, sc.releaseAt]);
      expect(out.lease.every((c) => c.result === true)).toBe(true);
      expect(out.json.drained).toBe(sc.drained);
      expect(out.json.failedTransient).toBe(sc.failedTransient);
      expect(readsAreLeased(out.pgmq, out.lease)).toBe(true);
      expect(leaseFake.row).toBeNull(); // given back
    });

    it("takes the lease 'cluster-consumer' for 45 s, under one fresh holder per invocation, renewed and released as that holder", async () => {
      const a = await runDrain({ messages: 3 });
      expect(new Set(a.lease.map((c) => c.name))).toEqual(new Set(["cluster-consumer"]));
      expect(a.lease.filter((c) => c.fn === "acquire").map((c) => c.ttl)).toEqual([45, 45, 45]);
      expect(a.lease.filter((c) => c.fn === "release").map((c) => c.ttl)).toEqual([null]);
      const holders = new Set(a.lease.map((c) => c.holder));
      expect(holders.size).toBe(1);
      const [holderA] = [...holders] as [string];
      expect(holderA).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      const b = await runDrain({ messages: 1 });
      const [holderB] = [...new Set(b.lease.map((c) => c.holder))] as [string];
      expect(holderB).not.toBe(holderA);
    });

    it("adds nothing to the drain's JSON body: the same keys as with CLUSTER_LEASE=off (no lease_lost, no trigger)", async () => {
      const on = await runDrain({ messages: 2 });
      const off = await runDrain({ messages: 2, env: { CLUSTER_LEASE: "off" } });
      expect(Object.keys(on.json).sort()).toEqual(Object.keys(off.json).sort());
      expect("lease_lost" in on.json).toBe(false);
      expect("trigger" in on.json).toBe(false);
      expect("lease_wait_ms" in on.json).toBe(false);
    });

    it.each([undefined, "", "on", "ON", "Off", "0", "false", "off ", " off"])(
      "CLUSTER_LEASE=%j keeps the lease on: only the exact string 'off' switches it off",
      async (flag) => {
        const out = await runDrain({ messages: 1, env: flag === undefined ? {} : { CLUSTER_LEASE: flag } });
        expect(leaseRpcNames(out.rpcNames).length).toBeGreaterThan(0);
      },
    );

    it("a GET liveness probe, a 405 and a 401 never touch the lease", async () => {
      vi.resetModules();
      const handler = await importHandler();
      const get = await handler!(authedRequest(URL, { method: "GET" }));
      expect(get.status).toBe(200);
      expect((await handler!(authedRequest(URL, { method: "PUT" }))).status).toBe(405);
      expect((await handler!(new Request(URL, { method: "POST" }))).status).toBe(401);
      expect(leaseFake.calls).toEqual([]);
      expect(pgmqState.calls).toEqual([]);
    });
  });

  describe("cron trigger, lease busy: no read at all", () => {
    const heldByOther = () => {
      leaseFake.row = { holder: "another-isolate", expiresAt: Date.now() + 30_000 };
    };

    it.each([
      ["no body", undefined],
      ["an empty JSON object", {}],
      ["trigger 'cron'", { trigger: "cron" }],
      ["a body that is not JSON", "not json {"],
      ["an unknown trigger value", { trigger: "INGEST" }],
      ["a trigger of the wrong type", { trigger: ["ingest"] }],
      ["a JSON null", "null"],
      ["a JSON array", "[]"],
      ["a JSON number", "7"],
    ])("%s: answers 200 {ok:true,busy:true,reason:'lease'} and makes no pgmq call and no other RPC", async (_name, body) => {
      const out = await runDrain({ messages: 4, body, prepare: heldByOther });
      expect(out.status).toBe(200);
      expect(out.json).toEqual({ ok: true, busy: true, reason: "lease" });
      expect(out.pgmq).toEqual([]); // not even a queue-depth probe
      expect(out.rpcNames).toEqual(["consumer_lease_acquire"]);
      expect(out.lease.map((c) => [c.fn, c.result])).toEqual([["acquire", false]]);
      expect(pgmqState.pending).toHaveLength(4); // nothing was leased from the queue
      expect(fromTables).toEqual([]); // no cache load, no article read
    });

    it("an oversized body is no trigger either (it counts as cron)", async () => {
      const out = await runDrain({ messages: 1, body: JSON.stringify({ trigger: "ingest", pad: "x".repeat(5_000) }), prepare: heldByOther });
      expect(out.json).toEqual({ ok: true, busy: true, reason: "lease" });
    });

    it("the lease of a holder that has expired is taken over by the cron drain", async () => {
      const out = await runDrain({
        messages: 1,
        prepare: () => {
          leaseFake.row = { holder: "dead-isolate", expiresAt: Date.now() - 1 };
        },
      });
      expect(out.json.drained).toBe(1);
      expect(out.lease[0]).toMatchObject({ fn: "acquire", result: true });
    });
  });

  describe("cron trigger, lease RPC missing or failing: fails open, exactly today's drain (unless CLUSTER_KICK=on and the RPC exists)", () => {
    const missing: Array<[string, { code?: string; message: string }]> = [
      ["migration 190 not applied (PGRST202)", { code: "PGRST202", message: "Could not find the function public.consumer_lease_acquire" }],
      ["the function dropped while PostgREST still had it cached (42883)", { code: "42883", message: "function does not exist" }],
    ];
    const failing: Array<[string, { code?: string; message: string }]> = [
      ["a statement timeout (57014)", { code: "57014", message: "canceling statement due to statement timeout" }],
      ["an error without a code", { message: "connection reset" }],
    ];
    const errors = [...missing, ...failing];

    // With kicks on, a kicked drain (another isolate) can read cluster_work while a lease-less cron drain does:
    // the two-reader case migration 190 exists to prevent. A failing RPC therefore fails CLOSED for the cron
    // drain too; only a missing RPC (kicks fail closed on it as well, so nobody else reads) stays fail-open.
    it.each(failing)("%s, CLUSTER_KICK=on: fails closed, 503 lease-unavailable, one acquire, nothing is read", async (_name, error) => {
      const out = await runDrain({
        messages: 3,
        env: { CLUSTER_KICK: "on" },
        prepare: () => {
          leaseFake.error = error;
        },
      });
      expect(out.status).toBe(503);
      expect(out.json).toEqual({ ok: false, error: "lease-unavailable", reason: "lease-error" });
      expect(out.pgmq).toEqual([]);
      expect(out.lease).toHaveLength(1);
      expect(out.lease[0]).toMatchObject({ fn: "acquire" });
      expect(pgmqState.pending).toHaveLength(3);
      expect(out.warns.filter((w) => w.includes("lease"))).toHaveLength(1);
    });

    it.each(missing)("%s, CLUSTER_KICK=on: still fails open (the kicks fail closed on it, so no second reader exists)", async (_name, error) => {
      const out = await runDrain({
        messages: 3,
        env: { CLUSTER_KICK: "on" },
        prepare: () => {
          leaseFake.error = error;
        },
      });
      expect(out.status).toBe(200);
      expect(out.pgmq).toEqual(SCENARIOS[3]!.pgmq);
      expect(out.json.drained).toBe(3);
      expect(out.lease).toHaveLength(1);
      expect(out.warns.filter((w) => w.includes("lease"))).toHaveLength(1);
    });

    it.each(["", "off", "ON", "true"])("CLUSTER_KICK=%j (not exactly 'on'): a failing RPC still fails open", async (kick) => {
      const out = await runDrain({
        messages: 3,
        env: { CLUSTER_KICK: kick },
        prepare: () => {
          leaseFake.error = { code: "57014", message: "canceling statement due to statement timeout" };
        },
      });
      expect(out.status).toBe(200);
      expect(out.json.drained).toBe(3);
    });

    it.each(errors)("%s: drains as today, tries the lease once, then never renews or releases", async (_name, error) => {
      const out = await runDrain({
        messages: 3,
        prepare: () => {
          leaseFake.error = error;
        },
      });
      expect(out.status).toBe(200);
      expect(out.pgmq).toEqual(SCENARIOS[3]!.pgmq);
      expect(out.json.drained).toBe(3);
      expect("lease_lost" in out.json).toBe(false);
      expect(out.lease).toHaveLength(1); // one acquire, nothing after it
      expect(out.lease[0]).toMatchObject({ fn: "acquire" });
      expect(out.warns.filter((w) => w.includes("lease"))).toHaveLength(1);
    });

    it("a lease answer that is not a boolean (null, no error) is an error too: the cron drain fails open", async () => {
      vi.resetModules();
      clockAt(AT);
      seedQueue(1);
      const handler = await importHandler();
      const original = supabaseFakeClient.rpc;
      const rpc = vi.spyOn(supabaseFakeClient, "rpc");
      rpc.mockImplementation(((name: string, args: unknown) => {
        // The shared fake answers { data: null } for an RPC it does not know; make the lease RPCs do the same.
        if (name.startsWith("consumer_lease_")) return Promise.resolve({ data: null, error: null });
        return (original as (n: string, a: unknown) => unknown)(name, args);
      }) as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await post(undefined, handler!);
        expect(out.status).toBe(200);
        expect(out.json.drained).toBe(1);
        expect("lease_lost" in out.json).toBe(false);
        expect(rpc.mock.calls.filter(([n]) => String(n).startsWith("consumer_lease_")).map(([n]) => n)).toEqual(["consumer_lease_acquire"]);
      } finally {
        warn.mockRestore();
        rpc.mockRestore();
      }
    });
  });

  describe("CLUSTER_LEASE=off: no lease call of any kind, call for call the pre-190 drain", () => {
    it.each(SCENARIOS)("$name: the pre-190 pgmq call sequence and not one lease RPC", async (sc) => {
      const out = await runDrain({
        messages: sc.messages,
        env: { CLUSTER_LEASE: "off" },
        prepare: () => {
          if (sc.readError) pgmqState.workReadError = sc.readError;
        },
      });
      expect(out.status).toBe(200);
      expect(out.pgmq).toEqual(sc.pgmq);
      expect(out.lease).toEqual([]);
      expect(leaseRpcNames(out.rpcNames)).toEqual([]);
      expect(out.json.drained).toBe(sc.drained);
      expect(out.json.failedTransient).toBe(sc.failedTransient);
    });

    it.each(SCENARIOS)(
      "$name: the default drain and the CLUSTER_LEASE=off drain differ in the lease calls ONLY (pgmq calls, other RPCs, writes and counters equal)",
      async (sc) => {
        const prep = () => {
          if (sc.readError) pgmqState.workReadError = sc.readError;
        };
        const on = await runDrain({ messages: sc.messages, prepare: prep });
        const off = await runDrain({ messages: sc.messages, env: { CLUSTER_LEASE: "off" }, prepare: prep });
        expect(on.pgmq).toEqual(off.pgmq);
        expect(otherRpcNames(on.rpcNames)).toEqual(otherRpcNames(off.rpcNames));
        expect(on.mutations).toEqual(off.mutations);
        expect(fromTables.length).toBeGreaterThanOrEqual(0);
        for (const k of ["drained", "matched", "created", "skipped", "failedTransient", "failedPermanent", "budgeted_out", "polls"]) {
          expect(on.json[k], k).toEqual(off.json[k]);
        }
        expect(leaseRpcNames(on.rpcNames).length).toBe(2 + sc.renewAts.length);
        expect(leaseRpcNames(off.rpcNames)).toEqual([]);
      },
    );

    it("a busy lease cannot stop a drain that has the lease switched off", async () => {
      const out = await runDrain({
        messages: 2,
        env: { CLUSTER_LEASE: "off" },
        prepare: () => {
          leaseFake.row = { holder: "another-isolate", expiresAt: Date.now() + 30_000 };
        },
      });
      expect(out.json.drained).toBe(2);
      expect(out.lease).toEqual([]);
    });

    it("the lease RPCs are never even reached for: the fake saw no call", async () => {
      await runDrain({ messages: 1, env: { CLUSTER_LEASE: "off" } });
      expect(supabaseFakeCalls.rpc.some((r) => r.name.startsWith("consumer_lease_"))).toBe(false);
    });

    it("a kick under CLUSTER_LEASE=off drains nothing and touches nothing: without the lease nothing serialises two readers", async () => {
      const out = await runDrain({ messages: 4, env: { CLUSTER_LEASE: "off" }, body: KICK });
      expect(out.status).toBe(200);
      expect(out.json).toEqual({ ok: true, skipped: true, reason: "lease-off" });
      expect(out.pgmq).toEqual([]);
      expect(out.rpcNames).toEqual([]);
      expect(pgmqState.pending).toHaveLength(4);
    });
  });

  describe("kick trigger", () => {
    it("depth 0: returns at once WITHOUT the lease: one queue-depth probe, no lease RPC, no read", async () => {
      const out = await runDrain({ messages: 0, body: KICK });
      expect(out.status).toBe(200);
      expect(out.json).toEqual({ ok: true, empty: true, reason: "depth" });
      expect(out.pgmq).toEqual([DEPTH]);
      expect(out.lease).toEqual([]);
      expect(out.rpcNames).toEqual([]);
    });

    it("a free lease: depth first, then acquire, the caches nulled, the drain, the release; the drain body names the trigger", async () => {
      const out = await runDrain({ messages: 3, body: KICK });
      expect(out.status).toBe(200);
      expect(out.pgmq).toEqual([DEPTH, ...SCENARIOS[3]!.pgmq]);
      expect(out.lease.map((c) => [c.fn, c.at])).toEqual([
        ["acquire", 1], // after the depth probe, before every other pgmq call
        ["acquire", 2], // renewal of turn 1
        ["acquire", 5], // renewal of turn 2
        ["release", 10],
      ]);
      expect(out.json).toMatchObject({ ok: true, drained: 3, trigger: "ingest", lease_wait_ms: 0 });
      expect(readsAreLeased(out.pgmq, out.lease)).toBe(true);
      expect(leaseFake.row).toBeNull();
    });

    it("nulls the context and the source lookup after acquiring: warm caches are rebuilt for a kick, reused by a plain cron drain", async () => {
      vi.resetModules();
      clockAt(AT);
      const handler = await importHandler();
      const sourceLoads = () => fromTables.filter((t) => t === "sources").length;
      // 1. a cron drain on an empty queue warms both caches
      await post(undefined, handler!);
      const warmCtx = clusterQueries.length;
      const warmSrc = sourceLoads();
      expect(warmCtx).toBeGreaterThan(0);
      expect(warmSrc).toBeGreaterThan(0);
      // 2. one second later another cron drain finds them warm (today's behaviour in the dark state): no rebuild
      vi.setSystemTime(Date.now() + 1_000);
      await post(undefined, handler!);
      expect(clusterQueries.length).toBe(warmCtx);
      expect(sourceLoads()).toBe(warmSrc);
      // 3. a kick one second after that acquires the lease and starts from DB truth
      vi.setSystemTime(Date.now() + 1_000);
      seedQueue(1);
      const kicked = await post(KICK, handler!);
      expect(kicked.json.drained).toBe(1);
      expect(clusterQueries.length).toBeGreaterThan(warmCtx);
      expect(sourceLoads()).toBe(warmSrc + 1);
    });

    it("under CLUSTER_KICK=on a cron drain also starts from DB truth (a kicked drain may have run in another isolate since)", async () => {
      vi.resetModules();
      clockAt(AT);
      process.env.CLUSTER_KICK = "on";
      const handler = await importHandler();
      const sourceLoads = () => fromTables.filter((t) => t === "sources").length;
      await post(undefined, handler!);
      const warmCtx = clusterQueries.length;
      const warmSrc = sourceLoads();
      vi.setSystemTime(Date.now() + 1_000);
      await post(undefined, handler!);
      expect(clusterQueries.length).toBeGreaterThan(warmCtx);
      expect(sourceLoads()).toBe(warmSrc + 1);
    });

    it("under CLUSTER_KICK=on a cron drain that fails open (lease RPC missing) also starts from DB truth", async () => {
      vi.resetModules();
      clockAt(AT);
      process.env.CLUSTER_KICK = "on";
      // PGRST202 (not 57014): a missing RPC stays fail-open under CLUSTER_KICK=on, so the drain runs without a lease.
      leaseFake.error = { code: "PGRST202", message: "Could not find the function public.consumer_lease_acquire" };
      const handler = await importHandler();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const sourceLoads = () => fromTables.filter((t) => t === "sources").length;
      try {
        const first = await post(undefined, handler!);
        expect(first.status).toBe(200);
        const warmCtx = clusterQueries.length;
        const warmSrc = sourceLoads();
        expect(warmCtx).toBeGreaterThan(0);
        expect(warmSrc).toBeGreaterThan(0);
        vi.setSystemTime(Date.now() + 1_000);
        const second = await post(undefined, handler!);
        expect(second.status).toBe(200);
        // No lease was held, yet a kicked drain may have run in another isolate since: DB truth again.
        expect(clusterQueries.length).toBeGreaterThan(warmCtx);
        expect(sourceLoads()).toBe(warmSrc + 1);
      } finally {
        warn.mockRestore();
        leaseFake.error = null;
      }
    });

    it("under CLUSTER_LEASE=off with CLUSTER_KICK=on a cron drain keeps its warm caches: the pre-190 drain, nothing to rebuild for", async () => {
      vi.resetModules();
      clockAt(AT);
      process.env.CLUSTER_LEASE = "off";
      process.env.CLUSTER_KICK = "on";
      const handler = await importHandler();
      const sourceLoads = () => fromTables.filter((t) => t === "sources").length;
      await post(undefined, handler!);
      const warmCtx = clusterQueries.length;
      const warmSrc = sourceLoads();
      expect(warmCtx).toBeGreaterThan(0);
      expect(warmSrc).toBeGreaterThan(0);
      vi.setSystemTime(Date.now() + 1_000);
      await post(undefined, handler!);
      expect(clusterQueries.length).toBe(warmCtx);
      expect(sourceLoads()).toBe(warmSrc);
      expect(leaseFake.calls).toEqual([]);
    });

    it("releases the lease even when the drain throws (the drain's first statement past the lease)", async () => {
      vi.resetModules();
      clockAt(AT);
      seedQueue(3);
      const handler = await importHandler();
      const pgmq = await import(PGMQ);
      vi.mocked(pgmq.queueDepth)
        .mockImplementationOnce(async () => ({ depth: 3, oldest_msg_age_sec: null })) // the kick's own probe
        .mockImplementationOnce(async () => {
          throw new Error("metrics exploded");
        }); // drainQueue's `before` sample
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const out = await post(KICK, handler!);
        expect(out.status).toBe(500);
        expect(out.json.ok).toBe(false);
      } finally {
        err.mockRestore();
      }
      expect(leaseFake.calls.map((c) => [c.fn, c.result])).toEqual([
        ["acquire", true],
        ["release", true],
      ]);
      expect(leaseFake.row).toBeNull();
      expect(pgmqState.reads).toEqual([]);
    });

    it("the cron drain releases the lease when its drain throws as well, and a LATER drain can take it", async () => {
      vi.resetModules();
      clockAt(AT);
      const handler = await importHandler();
      const pgmq = await import(PGMQ);
      vi.mocked(pgmq.queueDepth).mockImplementationOnce(async () => {
        throw new Error("metrics exploded");
      });
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        expect((await post(undefined, handler!)).status).toBe(500);
      } finally {
        err.mockRestore();
      }
      expect(leaseFake.calls.map((c) => c.fn)).toEqual(["acquire", "release"]);
      expect(leaseFake.row).toBeNull();
      seedQueue(1);
      expect((await post(undefined, handler!)).json.drained).toBe(1); // drainInFlight was cleared too
    });

    it("a kick that arrives while this isolate is draining answers {ok:true,busy:true} without any lease call", async () => {
      vi.resetModules();
      clockAt(AT);
      const handler = await importHandler();
      const pgmq = await import(PGMQ);
      let open: () => void = () => {};
      const gate = new Promise<void>((r) => (open = r));
      vi.mocked(pgmq.queueDepth).mockImplementationOnce(async () => {
        await gate;
        return { depth: 0, oldest_msg_age_sec: null };
      });
      const first = post(undefined, handler!); // takes the lease, then waits in drainQueue's depth sample
      await vi.waitFor(() => expect(vi.mocked(pgmq.queueDepth)).toHaveBeenCalledTimes(1));
      expect(leaseFake.calls.map((c) => c.fn)).toEqual(["acquire"]);
      const second = await post(KICK, handler!);
      expect(second.json).toEqual({ ok: true, busy: true });
      expect(leaseFake.calls.map((c) => c.fn)).toEqual(["acquire"]); // the second made no lease call
      open();
      expect((await first).status).toBe(200);
      expect(leaseFake.calls.map((c) => c.fn)).toEqual(["acquire", "acquire", "release"]);
    });
  });

  describe("kick trigger, lease busy: waits at most 10 s on an injected clock, never reads without the lease", () => {
    const heldFor = (ms: number) => () => {
      leaseFake.row = { holder: "another-isolate", expiresAt: Date.now() + ms };
    };

    /** Runs a kick against a handler on fake Date + setTimeout; advances the clock in 100 ms steps until the response is in. */
    async function kickWithClock(setup: () => void): Promise<{ status: number; json: Json; startedAt: number }> {
      vi.resetModules();
      resetPgmqState();
      for (const k of Object.keys(fakeArticles)) delete fakeArticles[k];
      leaseFake.row = null;
      leaseFake.calls.length = 0;
      supabaseFakeCalls.rpc.length = 0;
      clockAt(AT, ["Date", "setTimeout"]);
      const handler = await importHandler();
      setup();
      const startedAt = Date.now();
      let answer: { status: number; json: Json } | null = null;
      const pending = post(KICK, handler!).then((a) => (answer = a));
      for (let i = 0; i < 400 && answer === null; i++) await vi.advanceTimersByTimeAsync(100);
      await pending;
      return { ...(answer as unknown as { status: number; json: Json }), startedAt };
    }

    it("held for the whole wait: 26 tries 400 ms apart over exactly 10 s, then {ok:true,busy:true,reason:'lease'}, no read, no release", async () => {
      const out = await kickWithClock(() => {
        seedQueue(2);
        heldFor(60_000)();
      });
      expect(out.status).toBe(200);
      expect(out.json).toEqual({ ok: true, busy: true, reason: "lease" });
      const tries = leaseFake.calls;
      expect(tries).toHaveLength(26);
      expect(tries.every((c) => c.fn === "acquire" && c.result === false)).toBe(true);
      expect(tries.map((c) => c.t - out.startedAt)).toEqual(Array.from({ length: 26 }, (_, i) => i * 400));
      expect(tries[25]!.t - tries[0]!.t).toBe(10_000);
      expect(pgmqState.reads).toEqual([]); // never a read without the lease
      expect(pgmqState.archived).toEqual([]);
      expect(pgmqState.calls.every((c) => c === DEPTH)).toBe(true); // the depth probes only (1 + one per failed try but the last)
      expect(pgmqState.calls).toHaveLength(26);
      expect(leaseFake.row?.holder).toBe("another-isolate"); // untouched
      expect(pgmqState.pending).toHaveLength(2);
    });

    it("freed at +3 s: the first try after the expiry takes it (3200 ms), then it drains and releases", async () => {
      const out = await kickWithClock(() => {
        seedQueue(2);
        heldFor(3_000)();
      });
      expect(out.json).toMatchObject({ ok: true, drained: 2, trigger: "ingest", lease_wait_ms: 3_200 });
      const acquires = leaseFake.calls.filter((c) => c.fn === "acquire");
      expect(acquires.slice(0, 9).map((c) => [c.t - out.startedAt, c.result])).toEqual([
        ...Array.from({ length: 8 }, (_, i) => [i * 400, false]),
        [3_200, true],
      ]);
      expect(leaseFake.calls[leaseFake.calls.length - 1]).toMatchObject({ fn: "release", result: true });
      expect(readsAreLeased([...pgmqState.calls], leaseFake.calls)).toBe(true);
      expect(pgmqState.archived).toEqual([801, 802]);
    });

    it("the queue empties while it waits (another consumer drained it): leaves with {ok:true,empty:true,reason:'depth'} at the next failed try, no read, no release", async () => {
      const out = await kickWithClock(() => {
        seedQueue(2);
        heldFor(60_000)();
        setTimeout(() => {
          pgmqState.pending = [];
        }, 1_500);
      });
      expect(out.json).toEqual({ ok: true, empty: true, reason: "depth" });
      expect(leaseFake.calls.map((c) => [c.t - out.startedAt, c.result])).toEqual([
        [0, false],
        [400, false],
        [800, false],
        [1_200, false],
        [1_600, false], // depth read 0 after this try (the queue was emptied at 1500)
      ]);
      expect(pgmqState.reads).toEqual([]);
      expect(leaseFake.calls.some((c) => c.fn === "release")).toBe(false);
    });
  });

  describe("kick trigger, lease RPC missing or failing: fails closed", () => {
    it.each([
      ["PGRST202", "lease-rpc-missing", "Could not find the function public.consumer_lease_acquire"],
      ["42883", "lease-rpc-missing", "function public.consumer_lease_acquire does not exist"],
      ["57014", "lease-error", "canceling statement due to statement timeout"],
    ])("%s: 503 {ok:false,error:'lease-unavailable',reason:'%s'}, one lease try, no drain, no read", async (code, reason, message) => {
      const out = await runDrain({
        messages: 3,
        body: KICK,
        prepare: () => {
          leaseFake.error = { code, message };
        },
      });
      expect(out.status).toBe(503);
      expect(out.json).toEqual({ ok: false, error: "lease-unavailable", reason });
      expect(out.pgmq).toEqual([DEPTH]); // the depth probe only
      expect(out.lease).toHaveLength(1);
      expect(pgmqState.reads).toEqual([]);
      expect(pgmqState.pending).toHaveLength(3);
      const warned = out.warns.filter((w) => w.includes("lease"));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(code);
    });

    it("an acquire that answers null (not a boolean) is an error: closed, not 'free'", async () => {
      vi.resetModules();
      clockAt(AT);
      seedQueue(2);
      const handler = await importHandler();
      const rpc = vi.spyOn(supabaseFakeClient, "rpc");
      rpc.mockImplementation((async (name: string) => {
        if (name === "consumer_lease_acquire") return { data: null, error: null };
        return { data: null, error: null };
      }) as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await post(KICK, handler!);
        expect(out.status).toBe(503);
        expect(out.json).toMatchObject({ ok: false, error: "lease-unavailable", reason: "lease-error" });
        expect(pgmqState.reads).toEqual([]);
      } finally {
        warn.mockRestore();
        rpc.mockRestore();
      }
    });
  });

  describe("renewal at every read-loop turn, and a lost lease stops the reads", () => {
    it("renews once per turn: 4 messages take three turns (2, 2, empty) and three renewals", async () => {
      const out = await runDrain({ messages: 4 });
      expect(out.lease.filter((c) => c.fn === "acquire")).toHaveLength(1 + 3);
      expect(out.json.drained).toBe(4);
    });

    it("a renewal that answers false (the lease expired and another holder took it) sets lease_lost and stops: the next read never happens, no attach read, the release still runs", async () => {
      const out = await runDrain({
        messages: 4,
        prepare: () => {
          leaseFake.acquireScript = [true, true, false]; // acquire, renewal of turn 1, renewal of turn 2 -> lost
        },
      });
      expect(out.status).toBe(200);
      expect(out.json.lease_lost).toBe(true);
      expect(out.json.drained).toBe(2);
      expect(out.pgmq).toEqual([DEPTH, WORK_READ, ARCHIVE(1), ARCHIVE(2), DEPTH]); // one read; no second, no attach read
      expect(pgmqState.pending.map((m) => m.msg_id)).toEqual([803, 804]); // left untouched on the queue
      expect(out.lease.map((c) => c.fn)).toEqual(["acquire", "acquire", "acquire", "release"]);
      expect(out.json.budgeted_out).toBe(false);
    });

    it("a lease lost at the very first renewal means no read at all", async () => {
      const out = await runDrain({
        messages: 3,
        prepare: () => {
          leaseFake.acquireScript = [true, false];
        },
      });
      expect(out.json.lease_lost).toBe(true);
      expect(out.json.drained).toBe(0);
      expect(pgmqState.reads).toEqual([]);
      expect(out.pgmq).toEqual([DEPTH, DEPTH]);
    });

    it("a lost lease stops a kicked drain too", async () => {
      const out = await runDrain({
        messages: 4,
        body: KICK,
        prepare: () => {
          leaseFake.acquireScript = [true, true, false];
        },
      });
      expect(out.json).toMatchObject({ lease_lost: true, drained: 2, trigger: "ingest" });
      expect(out.pgmq).toEqual([DEPTH, DEPTH, WORK_READ, ARCHIVE(1), ARCHIVE(2), DEPTH]);
    });

    it("a renewal that ERRORS does not stop the drain (the lease is still ours for its 45 s; only a false answer is a loss)", async () => {
      const out = await runDrain({
        messages: 3,
        prepare: () => {
          leaseFake.acquireScript = [true, { error: { code: "57014", message: "canceling statement due to statement timeout" } }];
        },
      });
      expect(out.json.drained).toBe(3);
      expect("lease_lost" in out.json).toBe(false);
      expect(out.pgmq).toEqual(SCENARIOS[3]!.pgmq);
    });

    // A killed isolate (546 CPU / memory limit) never reaches the handler's finally, so its row lives until its
    // expires_at. The first acquire is 45 s; a renewal at +25 s with a flat 45 s would leave a row until +70 s,
    // past the next minute's cron drain (+60 s), which would answer 'busy' for a whole minute. Every renewal is
    // therefore capped at drain start + 55 s (LEASE_HORIZON_MS).
    describe("a renewal never pushes the lease past drain start + 55 s (a killed drain's row has expired by the next cron minute)", () => {
      const HORIZON_MS = 55_000;
      /** 8 messages (four full batches) with every cluster_work read taking 8 s of the (fake) clock: renewals at +0, +8, +16 and +24 s. */
      const slowDrain = () =>
        runDrain({
          messages: 8,
          prepare: () => {
            pgmqState.afterWorkRead = () => vi.setSystemTime(Date.now() + 8_000);
          },
        });

      it("renews with the time left to the horizon: every grant ends at or before +55 s, and some grant happens late enough to matter", async () => {
        const out = await slowDrain();
        const start = Date.parse(AT);
        const grants = out.lease.filter((c) => c.fn === "acquire" && c.result === true);
        expect(grants.length).toBeGreaterThanOrEqual(4);
        expect(grants.some((c) => c.t - start >= 16_000)).toBe(true);
        for (const c of grants) expect(c.t - start + c.ttl! * 1000).toBeLessThanOrEqual(HORIZON_MS);
        // The renewals' TTLs shrink as the drain ages (the first acquire and the early renewals keep 45 s).
        expect(grants.map((c) => [c.t - start, c.ttl])).toEqual([
          [0, 45],
          [0, 45],
          [8_000, 45],
          [16_000, 39],
          [24_000, 31],
        ]);
      });

      it("a drain killed after its last renewal leaves a row that has expired when the next minute's cron drain starts: it drains, it is not 'busy'", async () => {
        const out = await slowDrain();
        const start = Date.parse(AT);
        const grants = out.lease.filter((c) => c.fn === "acquire" && c.result === true);
        const last = grants[grants.length - 1]!;
        // The kill: no finally, no release. The row the last grant wrote is what stays behind.
        leaseFake.row = { holder: "killed-isolate", expiresAt: last.t + last.ttl! * 1000 };
        pgmqState.afterWorkRead = null;
        vi.setSystemTime(new Date(start + 60_000));
        seedQueue(1);
        const next = await post(undefined);
        expect(next.status).toBe(200);
        expect(next.json.busy).toBeUndefined();
        expect(next.json.drained).toBe(1);
      });
    });

    it("the release answers false when the lease was taken over meanwhile, and that is not an error", async () => {
      vi.resetModules();
      clockAt(AT);
      seedQueue(1);
      const handler = await importHandler();
      const original = supabaseFakeClient.rpc;
      const rpc = vi.spyOn(supabaseFakeClient, "rpc");
      rpc.mockImplementation(((name: string, args: unknown) => {
        // Another isolate takes the row over (our TTL ran out) just before our release arrives.
        if (name === "consumer_lease_release") leaseFake.row = { holder: "successor", expiresAt: Date.now() + 40_000 };
        return (original as (n: string, a: unknown) => unknown)(name, args);
      }) as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await post(undefined, handler!);
        expect(out.status).toBe(200);
        expect(out.json.drained).toBe(1);
        expect(leaseFake.calls[leaseFake.calls.length - 1]).toMatchObject({ fn: "release", result: false });
        expect(leaseFake.row?.holder).toBe("successor"); // the successor's lease is untouched
        expect(warn.mock.calls.map((c) => c.map(String).join(" ")).filter((w) => w.includes("lease"))).toEqual([]);
      } finally {
        warn.mockRestore();
        rpc.mockRestore();
      }
    });

    it("a failing release is warned about and never changes the answer", async () => {
      vi.resetModules();
      clockAt(AT);
      seedQueue(1);
      const handler = await importHandler();
      const original = supabaseFakeClient.rpc;
      const rpc = vi.spyOn(supabaseFakeClient, "rpc");
      rpc.mockImplementation(((name: string, args: unknown) => {
        if (name === "consumer_lease_release") return Promise.resolve({ data: null, error: { code: "57014", message: "canceling statement" } });
        return (original as (n: string, a: unknown) => unknown)(name, args);
      }) as never);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const out = await post(undefined, handler!);
        expect(out.status).toBe(200);
        expect(out.json.drained).toBe(1);
        expect(warn.mock.calls.map((c) => c.map(String).join(" ")).filter((w) => w.includes("release"))).toHaveLength(1);
      } finally {
        warn.mockRestore();
        rpc.mockRestore();
      }
      // The release failed, so the row stays until its 45 s TTL runs out: the next cron drain is told 'lease busy'
      // (not the isolate's own busy answer: drainInFlight was cleared) ...
      const next = await post(undefined, handler!);
      expect(next.json).toEqual({ ok: true, busy: true, reason: "lease" });
      // ... and 46 s later the TTL has freed it.
      vi.setSystemTime(Date.now() + 46_000);
      seedQueue(1);
      const later = await post(undefined, handler!);
      expect(later.json.drained).toBe(1);
    });
  });

  describe("the trigger is read from the body, and only the exact value 'ingest' is a kick", () => {
    it.each([
      [{ trigger: "ingest" }, "kick"],
      [{ trigger: "ingest", extra: 1 }, "kick"],
      [{ trigger: "cron" }, "cron"],
      [{}, "cron"],
      ["", "cron"],
      ["{", "cron"],
      [{ trigger: "Ingest" }, "cron"],
      [{ trigger: 1 }, "cron"],
      [{ trigger: null }, "cron"],
    ])("%j is a %s", async (body, kind) => {
      const out = await runDrain({ messages: 0, body });
      if (kind === "kick") expect(out.json).toEqual({ ok: true, empty: true, reason: "depth" }); // the kick leaves on depth 0
      else expect(out.json).toMatchObject({ ok: true, drained: 0 }); // the cron drain runs its empty read
    });
  });

  describe("parseTrigger and leaseEnabled (pure)", () => {
    async function pure() {
      await importHandler();
      return (await import(IMPORT)) as {
        parseTrigger: (text: string) => "ingest" | "cron";
        leaseEnabled: (value: string | undefined) => boolean;
      };
    }

    it.each([
      ['{"trigger":"ingest"}', "ingest"],
      ['  {"trigger":"ingest"}\n', "ingest"],
      ['{"trigger":"ingest","enqueued_at":"2026-11-10T12:00:00Z"}', "ingest"],
      ['{"trigger":"cron"}', "cron"],
      ["{}", "cron"],
      ["", "cron"],
      ["null", "cron"],
      ["[]", "cron"],
      ['["ingest"]', "cron"],
      ['"ingest"', "cron"],
      ["ingest", "cron"],
      ["{", "cron"],
      ['{"trigger":"ingest"', "cron"],
      ['{"trigger":" ingest"}', "cron"],
      ['{"Trigger":"ingest"}', "cron"],
      ['{"trigger":{"name":"ingest"}}', "cron"],
      [`{"trigger":"ingest","pad":"${"x".repeat(1_100)}"}`, "cron"],
      ["{\"trigger\":\"ingest\"}\u0000", "cron"],
      ["{\"trigger\":\"in\\u0067est\"}", "ingest"], // the JSON escape for 'g' is the same string once parsed
    ])("parseTrigger(%j) is %s", async (text, expected) => {
      const { parseTrigger } = await pure();
      expect(parseTrigger(text)).toBe(expected);
    });

    it.each([
      [undefined, true],
      ["", true],
      ["on", true],
      ["off", false],
      ["OFF", true],
      ["Off", true],
      [" off", true],
      ["false", true],
      ["0", true],
    ])("leaseEnabled(%j) is %s: only the exact string 'off' switches the lease off", async (value, expected) => {
      const { leaseEnabled } = await pure();
      expect(leaseEnabled(value)).toBe(expected);
    });

    // The TTL of a renewal: the full 45 s while that ends before drain start + 55 s, then what is left to that
    // horizon, never below the 5 s the database clamps to. A clock that is not a number, or went backwards, is 45.
    it.each([
      [0, 45],
      [10_000, 45],
      [15_000, 40],
      [25_000, 30],
      [60_000, 5],
      [Number.NaN, 45],
      [Number.POSITIVE_INFINITY, 45],
      [-1, 45],
      [10_999, 44],
      [50_000, 5],
      [51_000, 5],
    ])("leaseRenewTtlSeconds(%j) is %j", async (elapsedMs, expected) => {
      const mod = (await pure()) as unknown as { leaseRenewTtlSeconds: (elapsedMs: number) => number };
      expect(mod.leaseRenewTtlSeconds(elapsedMs)).toBe(expected);
    });
  });

  describe("wiring (static)", () => {
    const src = CONSUMER_SRC();

    it("declares the constants of the design", () => {
      expect(src).toContain('const LEASE_NAME = "cluster-consumer";');
      expect(src).toContain("const LEASE_TTL_S = 45;");
      expect(src).toContain("const KICK_LEASE_WAIT_MS = 10_000;");
      expect(src).toContain("const KICK_LEASE_STEP_MS = 400;");
    });

    it("keeps POLL_ENABLED false (h102-pollregression-1): the kick is the answer, not the long poll", () => {
      expect(/^const POLL_ENABLED = false;/m.test(src)).toBe(true);
    });

    it("releases the lease in the handler's finally, BEFORE drainInFlight is cleared", () => {
      const fin = src.lastIndexOf("} finally {");
      expect(fin).toBeGreaterThan(src.indexOf("Deno.serve("));
      const tail = src.slice(fin);
      expect(tail.indexOf("releaseQuietly(")).toBeGreaterThan(-1);
      expect(tail.indexOf("releaseQuietly(")).toBeLessThan(tail.indexOf("drainInFlight = false"));
      expect(src).toContain("await releaseLease(supabase, LEASE_NAME, lease.holder);"); // the one release call, inside releaseQuietly
    });

    it("holds no timer of its own: the 400 ms wait lives in _shared/lease.ts, where its clock can be injected", () => {
      expect(src.includes("setTimeout(")).toBe(false);
      expect(src).toContain("waitForLease(");
    });

    it("imports the lease helpers from the shared module and calls the RPC through no other path", () => {
      expect(src).toContain('from "../_shared/lease.ts"');
      expect(src.includes("consumer_lease_acquire")).toBe(false);
      expect(src.includes("consumer_lease_release")).toBe(false);
    });

    it("renews inside the read loop, after the budget check and before the read", () => {
      const loop = src.indexOf("while (true) {", src.indexOf("let polling = true;"));
      const budget = src.indexOf("summary.budgeted_out = true;", loop);
      const renew = src.indexOf("renewLease(", loop);
      const read = src.indexOf("readBatch<QueueMessage>(", loop);
      expect(loop).toBeGreaterThan(0);
      expect(renew).toBeGreaterThan(budget);
      expect(renew).toBeLessThan(read);
      expect(src.slice(renew, read)).toContain("lease_lost = true");
    });

    it("never logs a key or a header", () => {
      for (const line of src.split("\n")) {
        if (/console\.(log|warn|error)\(/.test(line) && /lease|kick/i.test(line)) {
          expect(/authorization|SERVICE_ROLE|secret/i.test(line), line).toBe(false);
        }
      }
    });
  });
});
