import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Static import of the mocked `score` export (see the vi.mock factory
// below) so the A3 live-path tests can override its return value per test
// via `vi.mocked(scoreMock).mockImplementation(...)` -- band-low/band-high
// classification depends on the ensemble score, and the real ensemble
// scorer is not exercised at all under this file's mocks.
import { score as scoreMock } from "../../supabase/functions/_shared/cluster/ensemble.ts";
import {
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_MEMBER_SCAN_MAX,
  HEADLINE_TITLE_MAX_CHARS,
} from "../../supabase/functions/_shared/cluster/constants.ts";
import { headlineTokens, strictFingerprint } from "../../supabase/functions/_shared/cluster/fingerprint.ts";

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

const pgmqState: {
  pending: PgmqMessage[];
  archived: number[];
  deleted: number[];
} = { pending: [], archived: [], deleted: [] };

function resetPgmqState() {
  pgmqState.pending = [];
  pgmqState.archived = [];
  pgmqState.deleted = [];
}

// Mock the shared pgmq wrapper. The exported names here MUST match the
// real module's named exports (`readBatch`, `archive`, `deleteMessage`,
// `send`, `queueDepth`) — otherwise vitest hoists a vi.mock with stale
// identifiers and the SUT silently sees `undefined` for its imported
// helpers.
//
// The real signatures all take the Supabase client as the FIRST positional
// arg (e.g. `readBatch(client, queue, vt, qty)`); the mock signatures
// mirror that so caller-side drift surfaces as a clear arity mismatch
// instead of being absorbed by JS's lenient positional binding.
vi.mock("../../supabase/functions/_shared/pgmq.ts", () => ({
  readBatch: vi.fn(
    async (_client: unknown, _queue: string, _vt: number, qty: number) => {
      const batch = pgmqState.pending.slice(0, qty);
      pgmqState.pending = pgmqState.pending.slice(qty);
      return batch;
    },
  ),
  archive: vi.fn(
    async (_client: unknown, _queue: string, msgId: number) => {
      pgmqState.archived.push(msgId);
      return true;
    },
  ),
  deleteMessage: vi.fn(
    async (_client: unknown, _queue: string, msgId: number) => {
      pgmqState.deleted.push(msgId);
      return true;
    },
  ),
  send: vi.fn(
    async (_client: unknown, _queue: string, _payload: unknown) => 1,
  ),
  queueDepth: vi.fn(
    async (_client: unknown, _queue: string) => ({
      depth: pgmqState.pending.length,
      oldest_msg_age_sec: null,
    }),
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
    } = {
      cluster_link_atomic: null,
      jev_politics_admission_claim: null,
      jev_politics_admission_record: null,
      cluster_title_probe: null,
    };
    // h12-cluster-1: makes the per-cluster member read (the probe's
    // loadProbeCluster) fail for one cluster id.
    const clusterArticlesFailureState: { clusterId: string | null } = { clusterId: null };
    const admissionRows: Array<Record<string, unknown>> = [];
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
      supabaseFakeClient: fake.client,
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
  clusterArticlesFailure.clusterId = null;
  admissionRows.length = 0;
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
  // Unset by default so tests that don't opt in never trigger a real fetch.
  delete process.env.REVALIDATE_URL;
  delete process.env.CRON_SECRET;
  // Migration 089 ("ADMIT"): off unless a test opts in.
  delete process.env.JEV_POLITICS_ADMISSION;
  // Opt-in flags other describes set; never inherited from a previous test.
  delete process.env.JEV_LIVE_PAIRS;
  delete process.env.AI_GATEWAY_API_KEY;
  delete process.env.REVALIDATE_FEED_TAGS;
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
      return (await res.json()) as { matched: number; created: number; skipped: number };
    }

    const linkedClusters = () =>
      supabaseFakeCalls.rpc
        .filter((r) => r.name === "cluster_link_atomic")
        .map((r) => (r.args as { p_cluster_id: string }).p_cluster_id);

    it("primary skipped as duplicate-source + entity-only secondary at 0.39 -> no join (h12-cluster-1: the same-source duplicate is skipped, no twin is opened)", async () => {
      seedClusters();
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
      // Member k (1 = newest) and its disjoint five-word headline.
      const WORDS = ["kalem", "sepet", "ceylan", "tavan", "bozkurt"];
      const LETTERS = "bcdfghjklmnprst";
      const titleOf = (k: number) => WORDS.map((w) => `${LETTERS[k - 1]}${w}`).join(" ");
      const hoursAgoOf = (k: number) => 0.5 + 0.2 * (k - 1); // 0.5 h .. 3.3 h, all inside the 6 h lane

      function seedFifteenMembers() {
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
        { label: "the 12th newest member (the last one kept)", k: HEADLINE_MEMBER_SCAN_MAX, matched: 1 },
        { label: "the 13th newest member (the first one evicted)", k: HEADLINE_MEMBER_SCAN_MAX + 1, matched: 0 },
        { label: "the 14th newest member", k: HEADLINE_MEMBER_SCAN_MAX + 2, matched: 0 },
      ])("an article repeating the headline of $label -> matched=$matched", async ({ k, matched }) => {
        seedFifteenMembers();
        queueIncoming(2100 + k, "art-hl", titleOf(k));
        scoreOnly();

        const body = await drain();

        expect(body.matched).toBe(matched);
        expect(body.created).toBe(1 - matched);
        expect(linkedClusters()).toEqual(matched ? [CL] : []);
      });

      it("the seed (oldest, outside the cap) and the latest (newest) are still compared through score()", async () => {
        seedFifteenMembers();
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
      admission: { would_create: number; would_match: number };
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
  });
});

// ---------------------------------------------------------------------------
// Contract reminder: every test asserts `expect(handler).toBeDefined()` so
// a missing or mis-imported SUT fails loud rather than silently passing as
// a no-op. The suite no longer skips when the handler cannot be loaded.
// ---------------------------------------------------------------------------
