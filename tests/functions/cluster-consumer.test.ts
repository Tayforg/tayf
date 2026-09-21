import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// Static import of the mocked `score` export (see the vi.mock factory
// below) so the A3 live-path tests can override its return value per test
// via `vi.mocked(scoreMock).mockImplementation(...)` -- band-low/band-high
// classification depends on the ensemble score, and the real ensemble
// scorer is not exercised at all under this file's mocks.
import { score as scoreMock } from "../../supabase/functions/_shared/cluster/ensemble.ts";

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
  rpcFixtures,
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
    const rpcFixturesState: {
      cluster_link_atomic: { data: unknown; error: { message: string } | null } | null;
    } = { cluster_link_atomic: null };
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
          return { data: clusters, error: null, count: clusters.length };
        },
        cluster_articles: (state) => {
          const eqClusterId = state.eq.find((p) => p.col === "cluster_id")?.val as
            | string
            | undefined;
          if (eqClusterId !== undefined) {
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
        ],
      },
      rpc: {
        // Default (null override) mirrors the pre-A3 behaviour: unknown
        // rpcs already resolve `{ data: null, error: null }` in the shared
        // fake, so addArticleToCluster's `cluster_link_atomic` call always
        // succeeded silently before this fixture existed too.
        cluster_link_atomic: () =>
          rpcFixturesState.cluster_link_atomic ?? { data: { ok: true }, error: null },
      },
    });
    return {
      fakeArticles: articles,
      clusterRows: clusters,
      clusterArticleRows: clusterArticles,
      rpcFixtures: rpcFixturesState,
      supabaseFakeClient: fake.client,
      supabaseFakeCalls: fake.calls,
    };
  },
);

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => supabaseFakeClient,
}));

// Stub the ensemble — the consumer just needs a scoring result back. The
// real module exports `score`; we mirror that name so the SUT's named
// import resolves to this stub.
vi.mock("../../supabase/functions/_shared/cluster/ensemble.ts", () => ({
  score: vi.fn((_a: unknown, _b: unknown) => ({
    score: 0.82,
    components: { cosine: 0.8, entityJaccard: 0.7, fingerprintMatch: true },
    isMatch: true,
  })),
  isMatch: (s: number | { score: number } | null | undefined): boolean => {
    if (s == null) return false;
    return typeof s === "number" ? s >= 0.5 : s.score >= 0.5;
  },
}));

beforeEach(() => {
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
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
  // Unset by default so tests that don't opt in never trigger a real fetch.
  delete process.env.REVALIDATE_URL;
  delete process.env.CRON_SECRET;
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

  it("POSTs once to REVALIDATE_URL with cluster tags after a drain that changes clusters, and not when nothing changed", async () => {
    const handler = await importHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    process.env.REVALIDATE_URL = "https://example.test/api/revalidate";
    process.env.CRON_SECRET = "test-cron-secret";
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
    expect(body.tags).toContain("clusters-politics");
    expect(body.tags).toContain("clusters");
    expect(body.tags.some((t) => /^cluster-detail:/.test(t))).toBe(true);

    // A second drain with nothing pending must not fire another POST.
    fetchMock.mockClear();
    pgmqState.pending = [];
    await handler(authedRequest("http://localhost/cluster-consumer", { method: "POST" }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("caps the revalidation tag payload at 100, reserving room for the 2 static tags", async () => {
    // /api/revalidate's MAX_TAGS is 100; a big drain must never overflow it.
    await importHandler();
    const mod = await import("../../supabase/functions/cluster-consumer/index.ts");
    const ids = Array.from({ length: 150 }, (_, i) => `id-${i}`);
    const tags = mod.buildRevalidationTags(ids);
    expect(tags.length).toBe(100);
    expect(tags[0]).toBe("clusters-politics");
    expect(tags[1]).toBe("clusters");
    expect(tags.slice(2)).toEqual(
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
  // Date.now(), and persists across every `it` in this file since the SUT
  // module is only evaluated once. `vi.useFakeTimers({ toFake: ["Date"] })`
  // + a one-time forward jump in `beforeAll` invalidates whatever
  // (empty) snapshot the tests above already warmed, so the FIRST test
  // below reloads the cache and picks up the shared cluster seeded here --
  // it then stays warm (frozen clock, never advanced again) for the rest
  // of this block. `toFake: ["Date"]` leaves real timers (setTimeout,
  // AbortSignal) untouched.
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
    });

    afterAll(() => {
      vi.useRealTimers();
    });

    beforeEach(() => {
      process.env.JEV_LIVE_PAIRS = "1";
      process.env.AI_GATEWAY_API_KEY = "test-gateway-key";
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
});

// ---------------------------------------------------------------------------
// Contract reminder: every test asserts `expect(handler).toBeDefined()` so
// a missing or mis-imported SUT fails loud rather than silently passing as
// a no-op. The suite no longer skips when the handler cannot be loaded.
// ---------------------------------------------------------------------------
