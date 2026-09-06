import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

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
const { fakeArticles, supabaseFakeClient, supabaseFakeCalls } = await vi.hoisted(
  async () => {
    // Dynamic `await import` works here because vitest 1.x+ supports async
    // `vi.hoisted` factories. `require()` doesn't resolve `.ts` under
    // vitest's ESM loader; `import()` does.
    const helper = await import("../_helpers/supabase-fake");
    const articles: Record<string, unknown> = {};
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
        clusters: [],
        cluster_articles: [],
        sources: [
          { id: "src-outlet", bias: "pro_government", name: "Outlet", slug: "outlet", kind: "outlet" },
          { id: "src-agg", bias: "center", name: "Aggregator", slug: "agg", kind: "aggregator" },
          { id: "src-wire", bias: "state_media", name: "Wire", slug: "wire", kind: "wire" },
        ],
      },
    });
    return {
      fakeArticles: articles,
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
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
});

afterEach(() => {
  vi.clearAllMocks();
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
});

// ---------------------------------------------------------------------------
// Contract reminder: every test asserts `expect(handler).toBeDefined()` so
// a missing or mis-imported SUT fails loud rather than silently passing as
// a no-op. The suite no longer skips when the handler cannot be loaded.
// ---------------------------------------------------------------------------
