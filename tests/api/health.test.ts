import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// next/server mock.
//
// The health route awaits `connection()` (directly or via shared helpers) so
// Next.js 16's cache-components prerender doesn't choke on `request.headers`.
// Outside a Next.js request scope (i.e. here in vitest) the real
// `connection()` throws "called outside a request scope" — resolve it to a
// no-op so the handler can run end-to-end and we exercise the real status
// envelope instead of a 500-for-wrong-reason. Everything else from
// `next/server` (NextResponse, etc.) passes through untouched via
// `importOriginal`.
// ---------------------------------------------------------------------------
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

// ---------------------------------------------------------------------------
// Supabase mock plumbing.
//
// The health route calls:
//   supabase.from("sources").select("id").limit(1)
//   supabase.from("articles").select("created_at").order(...).limit(1).maybeSingle()
//
// We replace `@supabase/supabase-js` at the module boundary with a factory
// that returns a chainable client whose terminal methods are driven by the
// `responders` map below. Each test sets the responders it needs before
// importing the route.
// ---------------------------------------------------------------------------

type TableName = "sources" | "articles" | "clusters" | "worker_metrics";

// ingest-health: incremented every time the sources-status `select(...)`
// branch above is entered -- lets a test prove the anonymous path never
// even builds this query.
let sourcesStatusCallCount = 0;

interface SelectResponse {
  data?: unknown;
  error?: { message: string } | null;
}

const responders: {
  sourcesSelect: () => Promise<SelectResponse>;
  sourcesStatus: () => Promise<SelectResponse>;
  articlesMaybeSingle: () => Promise<SelectResponse>;
  clustersMaybeSingle: () => Promise<SelectResponse>;
  workerMetricsSelect: () => Promise<SelectResponse>;
  /** cold-read resilience: the `clusters` + `cluster_articles(...)` read-path probe. */
  readPathSelect: () => Promise<SelectResponse>;
} = {
  sourcesSelect: async () => ({ data: [{ id: "s1" }], error: null }),
  // ingest-health: `.from("sources").select("...latest:articles...")...` --
  // the authed-only sources-status check. Empty by default (no active
  // sources) so a test must opt in to whatever shape it needs.
  sourcesStatus: async () => ({ data: [], error: null }),
  articlesMaybeSingle: async () => ({
    data: { created_at: new Date().toISOString() },
    error: null,
  }),
  clustersMaybeSingle: async () => ({
    data: { updated_at: new Date().toISOString() },
    error: null,
  }),
  workerMetricsSelect: async () => ({
    data: [
      {
        queue_name: "cluster_work",
        queue_length: 0,
        oldest_msg_age_sec: null,
      },
      {
        queue_name: "image_backfill",
        queue_length: 0,
        oldest_msg_age_sec: null,
      },
    ],
    error: null,
  }),
  readPathSelect: async () => ({ data: [], error: null }),
};

// cold-read resilience: what the read-path probe actually sent to PostgREST,
// so a test can pin the query shape (and that it is bounded by an abort
// signal) instead of only its verdict.
const readPathCalls: {
  count: number;
  select?: string;
  eq: Array<[string, unknown]>;
  gte: Array<[string, unknown]>;
  limit?: number;
  signal?: unknown;
} = { count: 0, eq: [], gte: [] };

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => {
    // ingest-health: `.from("sources")` is now called from TWO different
    // probes with two different select shapes -- the pre-existing cheap DB
    // probe (`select("id").limit(1)`) and the new authed-only sources-status
    // check (`select("...latest:articles...")...`). Told apart by whether
    // the `select(...)` argument contains "latest:", not by call order, so
    // both probes can run in the same request without one confusing the
    // other's fixture.
    function sourcesChain() {
      return {
        select: (arg?: string) => {
          if (typeof arg === "string" && arg.includes("latest:")) {
            sourcesStatusCallCount++;
            const statusChain = {
              eq: () => statusChain,
              lte: () => statusChain,
              order: () => statusChain,
              limit: () => responders.sourcesStatus(),
            };
            return statusChain;
          }
          const dbChain = {
            limit: () => responders.sourcesSelect(),
          };
          return dbChain;
        },
      };
    }
    function articlesChain() {
      const chain = {
        select: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => responders.articlesMaybeSingle(),
      };
      return chain;
    }
    // cold-read resilience: the read-path probe selects the embedded
    // `cluster_articles(...)` graph the homepage reads, then filters/orders/
    // limits and awaits the chain WITHOUT a terminal method, so its chain is
    // thenable. Told apart from the clustering-staleness probe by whether the
    // `select(...)` argument contains "cluster_articles".
    function readPathChain() {
      const chain: Record<string, unknown> = {};
      Object.assign(chain, {
        eq: (col: string, val: unknown) => {
          readPathCalls.eq.push([col, val]);
          return chain;
        },
        gte: (col: string, val: unknown) => {
          readPathCalls.gte.push([col, val]);
          return chain;
        },
        order: () => chain,
        limit: (n: number) => {
          readPathCalls.limit = n;
          return chain;
        },
        abortSignal: (signal: unknown) => {
          readPathCalls.signal = signal;
          return chain;
        },
        then: (
          onFul?: (v: SelectResponse) => unknown,
          onRej?: (e: unknown) => unknown,
        ) => responders.readPathSelect().then(onFul, onRej),
      });
      return chain;
    }
    // The clustering probe mirrors the articles probe one-for-one
    // (`.select(...).order(...).limit(1).maybeSingle()`).
    function clustersChain() {
      const chain = {
        select: (arg?: string) => {
          if (typeof arg === "string" && arg.includes("cluster_articles")) {
            readPathCalls.count++;
            readPathCalls.select = arg;
            return readPathChain();
          }
          return chain;
        },
        order: () => chain,
        limit: () => chain,
        maybeSingle: () => responders.clustersMaybeSingle(),
      };
      return chain;
    }
    // The queues probe awaits the chain directly without a terminal
    // method, so the chain itself must be thenable.
    function workerMetricsChain() {
      const chain: Record<string, unknown> = {};
      const terminal = (
        onFul?: (v: SelectResponse) => unknown,
        onRej?: (e: unknown) => unknown,
      ) => responders.workerMetricsSelect().then(onFul, onRej);
      Object.assign(chain, {
        select: () => chain,
        then: terminal,
      });
      return chain;
    }
    return {
      from: (table: TableName) => {
        if (table === "sources") return sourcesChain();
        if (table === "articles") return articlesChain();
        if (table === "clusters") return clustersChain();
        if (table === "worker_metrics") return workerMetricsChain();
        throw new Error(`Unexpected table: ${table}`);
      },
    };
  },
}));

// Save + restore env so one test can't poison another.
const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  // Bearer-gated detailed envelope: every test that asserts on body.checks
  // needs the route to consider it authenticated. The default callGet
  // builds a Bearer header with this same secret.
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  // Reset responders to "healthy" defaults.
  responders.sourcesSelect = async () => ({
    data: [{ id: "s1" }],
    error: null,
  });
  responders.sourcesStatus = async () => ({ data: [], error: null });
  sourcesStatusCallCount = 0;
  responders.readPathSelect = async () => ({ data: [], error: null });
  readPathCalls.count = 0;
  readPathCalls.select = undefined;
  readPathCalls.eq = [];
  readPathCalls.gte = [];
  readPathCalls.limit = undefined;
  readPathCalls.signal = undefined;
  responders.articlesMaybeSingle = async () => ({
    data: { created_at: new Date().toISOString() },
    error: null,
  });
  responders.clustersMaybeSingle = async () => ({
    data: { updated_at: new Date().toISOString() },
    error: null,
  });
  responders.workerMetricsSelect = async () => ({
    data: [
      {
        queue_name: "cluster_work",
        queue_length: 0,
        oldest_msg_age_sec: null,
      },
      {
        queue_name: "image_backfill",
        queue_length: 0,
        oldest_msg_age_sec: null,
      },
    ],
    error: null,
  });
});

afterEach(() => {
  vi.useRealTimers();
  // Restore env keys we touched to their original values (or delete if they
  // weren't there before).
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
  ]) {
    if (k in ORIGINAL_ENV) {
      process.env[k] = ORIGINAL_ENV[k] as string;
    } else {
      delete process.env[k];
    }
  }
  vi.resetModules();
});

const TEST_CRON_SECRET = "test-cron-secret-for-health-route";

async function callGet(request?: Request) {
  const mod = await import("@/app/api/health/route");
  // The route gates the detailed `body.checks.*` envelope behind a
  // constant-time bearer check against CRON_SECRET. Tests default to
  // sending the bearer so they exercise the detailed branch every assertion
  // here depends on. Tests that explicitly want to verify anonymous-rate-
  // limit / `{status, timestamp}` behaviour can pass their own bare
  // `new Request(...)` without an Authorization header.
  const authedRequest =
    request ??
    new Request("http://localhost/api/health", {
      headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
  const res = await mod.GET(authedRequest);
  const body = await res.json();
  return { status: res.status, body, headers: res.headers };
}

describe("GET /api/health", () => {
  it("returns 200 healthy when every check passes", async () => {
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.checks.env.ok).toBe(true);
    expect(body.checks.env.missing).toEqual([]);
    expect(body.checks.database.ok).toBe(true);
    expect(typeof body.checks.database.latencyMs).toBe("number");
    expect(body.checks.ingestion.ok).toBe(true);
    expect(typeof body.checks.ingestion.lastArticleAgeSec).toBe("number");
    // Tripwire: the clustering probe reads `clusters.updated_at`. If the mock
    // fixture or the route's selected column drifts back to `created_at`,
    // `new Date(undefined)` is NaN and this flips false — catching a
    // pass-for-wrong-reason regression instead of letting it slip through.
    expect(body.checks.clustering.ok).toBe(true);
  });

  it("returns 503 unhealthy when required env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    const { status, body } = await callGet();
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.env.ok).toBe(false);
    expect(body.checks.env.missing).toEqual(
      expect.arrayContaining([
        "NEXT_PUBLIC_SUPABASE_URL",
        "SUPABASE_SERVICE_ROLE_KEY",
      ])
    );
    // When env is broken the route should short-circuit without running
    // the other probes; their `ok` remains false from the initial state.
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.ingestion.ok).toBe(false);
  });

  it("returns 503 unhealthy when the database probe errors", async () => {
    responders.sourcesSelect = async () => ({
      data: null,
      error: { message: "connection refused" },
    });
    const { status, body } = await callGet();
    expect(status).toBe(503);
    expect(body.status).toBe("unhealthy");
    expect(body.checks.database.ok).toBe(false);
    expect(body.checks.database.error).toMatch(/connection refused/);
  });

  it("returns 200 degraded when ingestion is stale but DB is fine", async () => {
    // 2 hours ago is well past the 10-minute threshold.
    const staleIso = new Date(
      Date.now() - 2 * 60 * 60 * 1000
    ).toISOString();
    responders.articlesMaybeSingle = async () => ({
      data: { created_at: staleIso },
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.ingestion.ok).toBe(false);
    expect(body.checks.ingestion.lastArticleAgeSec).toBeGreaterThan(600);
    expect(body.checks.database.ok).toBe(true);
  });

  it("treats no articles as degraded, not unhealthy", async () => {
    responders.articlesMaybeSingle = async () => ({
      data: null,
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.ingestion.ok).toBe(false);
    expect(body.checks.ingestion.error).toBe("no articles");
  });

  it("surfaces an ingestion query error in the payload", async () => {
    responders.articlesMaybeSingle = async () => ({
      data: null,
      error: { message: "boom" },
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.ingestion.ok).toBe(false);
    expect(body.checks.ingestion.error).toBe("boom");
  });

  // ---------------------------------------------------------------------------
  // B8 worker-stream probes: clustering staleness + queue health.
  //
  // The route adds two new checks beyond the original DB / ingestion pair:
  //
  //   - clustering: newest cluster's age compared against a 15-minute
  //     threshold. The cluster-consumer Edge Function dequeues every minute,
  //     so a gap larger than 15 min means the consumer is stuck.
  //   - queues:     reads the `worker_metrics` view (filtered pgmq.metrics_all)
  //     and downgrades to "degraded" when queue depth crosses its per-queue
  //     bound (cluster_work 500 / image_backfill 100), the oldest visible
  //     message has been waiting more than 30 min, OR a row comes back with
  //     a NULL / non-numeric queue_length (malformed view output).
  //
  // Both probes are intentionally NON-critical: they downgrade status to
  // "degraded" with HTTP 200, never to "unhealthy" / 503. The DB + env
  // checks remain the only flippers of the 503 boundary.
  // ---------------------------------------------------------------------------

  it("returns 200 healthy when clustering + queues are both fresh and within thresholds", async () => {
    // Defaults set in beforeEach already paint the happy picture; this test
    // pins the contract by exercising the new sub-payload shape explicitly.
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    expect(body.checks.clustering.ok).toBe(true);
    expect(typeof body.checks.clustering.lastClusterAgeSec).toBe("number");
    expect(body.checks.queues.ok).toBe(true);
    expect(Array.isArray(body.checks.queues.metrics)).toBe(true);
    const queueNames = (body.checks.queues.metrics as Array<{ queue: string }>)
      .map((m) => m.queue);
    expect(queueNames).toEqual(
      expect.arrayContaining(["cluster_work", "image_backfill"]),
    );
  });

  it("returns 200 degraded when clustering is stale beyond the 15-minute threshold", async () => {
    // 20 minutes ago is clearly past 15-min staleness.
    const staleIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    responders.clustersMaybeSingle = async () => ({
      data: { updated_at: staleIso },
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.clustering.ok).toBe(false);
    expect(body.checks.clustering.lastClusterAgeSec).toBeGreaterThan(15 * 60);
    // DB + ingestion remain green: this is a clustering-only degradation.
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.ingestion.ok).toBe(true);
  });

  it("returns 200 degraded when a queue exceeds the depth threshold", async () => {
    responders.workerMetricsSelect = async () => ({
      data: [
        {
          queue_name: "cluster_work",
          queue_length: 750, // > 500 depth alarm
          oldest_msg_age_sec: 30,
        },
        {
          queue_name: "image_backfill",
          queue_length: 5,
          oldest_msg_age_sec: 10,
        },
      ],
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.queues.ok).toBe(false);
    expect(body.checks.queues.error).toMatch(/cluster_work/);
    expect(body.checks.queues.error).toMatch(/depth/i);
    // Other checks still green: this is a queues-only degradation.
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.clustering.ok).toBe(true);
  });

  it("returns 200 degraded when the oldest message age exceeds the 30-minute threshold", async () => {
    responders.workerMetricsSelect = async () => ({
      data: [
        {
          queue_name: "cluster_work",
          queue_length: 12,
          oldest_msg_age_sec: 45 * 60, // 45 min > 30 min alarm
        },
        {
          queue_name: "image_backfill",
          queue_length: 0,
          oldest_msg_age_sec: null,
        },
      ],
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.queues.ok).toBe(false);
    expect(body.checks.queues.error).toMatch(/oldest message age/i);
    expect(body.checks.queues.error).toMatch(/cluster_work/);
    expect(body.checks.database.ok).toBe(true);
    expect(body.checks.clustering.ok).toBe(true);
  });

  it("returns 200 degraded when image_backfill exceeds its lower per-queue depth bound", async () => {
    // 150 sits BETWEEN the two bounds: fine for cluster_work (500), over
    // the line for image_backfill (100). If the route regressed to a single
    // shared threshold this would pass as healthy — both error-string
    // assertions below would then fail loudly.
    responders.workerMetricsSelect = async () => ({
      data: [
        {
          queue_name: "cluster_work",
          queue_length: 150,
          oldest_msg_age_sec: 30,
        },
        {
          queue_name: "image_backfill",
          queue_length: 150,
          oldest_msg_age_sec: 10,
        },
      ],
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.queues.ok).toBe(false);
    // The error must name the tripping queue + dimension + the bound that
    // applied to it, not the cluster_work bound.
    expect(body.checks.queues.error).toMatch(/image_backfill/);
    expect(body.checks.queues.error).toMatch(/depth/i);
    expect(body.checks.queues.error).toMatch(/100/);
    expect(body.checks.queues.error).not.toMatch(/cluster_work/);
  });

  it("treats a NULL queue_length as a malformed row (degraded), not a healthy zero", async () => {
    responders.workerMetricsSelect = async () => ({
      data: [
        {
          queue_name: "cluster_work",
          queue_length: null,
          oldest_msg_age_sec: null,
        },
        {
          queue_name: "image_backfill",
          queue_length: 0,
          oldest_msg_age_sec: null,
        },
      ],
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.queues.ok).toBe(false);
    expect(body.checks.queues.error).toMatch(/malformed worker_metrics row/);
    expect(body.checks.queues.error).toMatch(/cluster_work/);
  });

  it("treats a non-numeric queue_length as a malformed row", async () => {
    responders.workerMetricsSelect = async () => ({
      data: [
        {
          queue_name: "cluster_work",
          queue_length: 3,
          oldest_msg_age_sec: null,
        },
        {
          queue_name: "image_backfill",
          queue_length: "not-a-number",
          oldest_msg_age_sec: null,
        },
      ],
      error: null,
    });
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.checks.queues.ok).toBe(false);
    expect(body.checks.queues.error).toMatch(/malformed worker_metrics row/);
    expect(body.checks.queues.error).toMatch(/image_backfill/);
  });

  // ---------------------------------------------------------------------------
  // R4-P5: anonymous rate limit on the public `{status}` envelope path.
  //
  // The route wraps the anonymous branch with a token-bucket limiter of
  // capacity 5 / refill 1 per second. The limiter is process-local, so the
  // cap applies per instance, not globally — capacity is kept low so N
  // instances × 5 bursts stays cheap against Supabase. A flood from a
  // single client IP gets the first 5 probes through (capacity drain) and
  // then 429s the 6th within the same 1-second window. The authenticated
  // bearer path is exempt — monitoring infra has a legitimate need to
  // probe at high cadence with the right secret.
  // ---------------------------------------------------------------------------

  it("rate-limits anonymous callers: the 6th burst request in a 1s window returns 429", async () => {
    // A unique client key isolates this bucket from any cross-test bleed
    // inside the shared rate-limiter module map.
    const clientIp = "203.0.113.77";
    const buildReq = () =>
      new Request("https://example.com/api/health", {
        method: "GET",
        headers: { "x-forwarded-for": clientIp },
      });

    // 6 concurrent requests in the same event-loop tick — the bucket
    // refills by `elapsedSec * 1` between calls, which over a fraction of
    // a millisecond is effectively zero. Capacity 5 means the first 5
    // each consume a token and the 6th sees `tokens < 1`.
    const results = await Promise.all(
      Array.from({ length: 6 }, () => callGet(buildReq())),
    );

    const allowed = results.filter((r) => r.status !== 429);
    const denied = results.filter((r) => r.status === 429);

    expect(allowed.length).toBe(5);
    expect(denied.length).toBe(1);

    // Canonical `apiError` envelope (not the legacy `{status: "rate_limited"}`
    // shape), with the retry hint in the body AND the standard header.
    const limited = denied[0]!;
    const limitedBody = limited.body as {
      error: string;
      details: { retryAfterMs: number };
    };
    expect(limitedBody.error).toBe("Too many requests");
    expect(typeof limitedBody.details.retryAfterMs).toBe("number");
    expect(limitedBody.details.retryAfterMs).toBeGreaterThan(0);
    expect(Number(limited.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(limited.headers.get("Retry-After")).toBe(
      String(Math.ceil(limitedBody.details.retryAfterMs / 1000)),
    );
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
  });

  it("authenticated bearer callers bypass the anonymous rate limit", async () => {
    process.env.CRON_SECRET = "test-cron-secret";
    const clientIp = "203.0.113.99";
    const buildAuthedReq = () =>
      new Request("https://example.com/api/health", {
        method: "GET",
        headers: {
          "x-forwarded-for": clientIp,
          authorization: "Bearer test-cron-secret",
        },
      });

    // 35 > capacity 5. If the bearer path were subject to the limiter,
    // at least 30 of these would 429. We expect zero.
    const results = await Promise.all(
      Array.from({ length: 35 }, () => callGet(buildAuthedReq())),
    );
    const denied = results.filter((r) => r.status === 429);
    expect(denied.length).toBe(0);

    delete process.env.CRON_SECRET;
  });

  // ---------------------------------------------------------------------------
  // Shared bearer gate (`requireCronBearer` in src/lib/api/bearer.ts).
  //
  // The detailed envelope is gated by the same helper as /api/cron/headline
  // and /api/metrics: case-insensitive scheme, constant-time token compare,
  // FAIL-CLOSED 503 when CRON_SECRET is unset, 401 on a mismatched token.
  // The legacy health-only posture (treat every caller as anonymous when
  // the secret is missing or the token is wrong) is gone — these tests pin
  // the migrated behaviour.
  // ---------------------------------------------------------------------------

  it("accepts a lowercase 'bearer' scheme (auth schemes are case-insensitive)", async () => {
    const { status, body } = await callGet(
      new Request("http://localhost/api/health", {
        headers: { Authorization: `bearer ${TEST_CRON_SECRET}` },
      }),
    );
    expect(status).toBe(200);
    expect(body.status).toBe("healthy");
    // Detailed envelope, not the anonymous summary — the lowercase scheme
    // must authenticate, not silently downgrade.
    expect(body.checks.database.ok).toBe(true);
  });

  it("returns 401 when the Authorization header carries the wrong token", async () => {
    const { status, body } = await callGet(
      new Request("http://localhost/api/health", {
        headers: { Authorization: "Bearer not-the-right-token" },
      }),
    );
    expect(status).toBe(401);
    expect(body.checks).toBeUndefined();
  });

  it("FAIL-CLOSED: returns 503 when a bearer is presented but CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const { status, body } = await callGet(
      new Request("http://localhost/api/health", {
        headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
      }),
    );
    expect(status).toBe(503);
    expect(body.checks).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // ingest-health: authed-only `checks.sources` -- silent/never-delivered
  // active sources, purely informational (never flips the verdict).
  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // cold-read resilience: `checks.readPath`.
  //
  // On the Micro compute (256 MB shared_buffers vs a 5.2 GB DB) the cheap
  // `select id from sources limit 1` probe stays green while the real homepage
  // read -- clusters + the embedded cluster_articles/articles/sources graph --
  // blows through PostgREST's 8 s statement_timeout. The probe therefore runs
  // that same shape, for anonymous AND authed callers (so an external uptime
  // monitor sees it), bounded by the per-check 2 s budget:
  //   - errored / aborted / timed out        -> critical -> unhealthy / 503
  //   - succeeded but slower than 1500 ms    -> degraded  / 200
  //   - succeeded fast                       -> contributes nothing
  // ---------------------------------------------------------------------------

  describe("checks.readPath [cold-read resilience]", () => {
    /**
     * Drive a GET under fake timers. Only setTimeout/clearTimeout/performance
     * are faked (Date stays real so the staleness fixtures keep their meaning);
     * the clock is advanced in 100 ms steps until the handler settles.
     */
    async function callGetFake(request?: Request) {
      const mod = await import("@/app/api/health/route");
      vi.useFakeTimers({
        toFake: ["setTimeout", "clearTimeout", "performance"],
      });
      const authedRequest =
        request ??
        new Request("http://localhost/api/health", {
          headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
        });
      let settled = false;
      const pending = mod.GET(authedRequest).then(
        (r) => {
          settled = true;
          return r;
        },
        (e) => {
          settled = true;
          throw e;
        },
      );
      for (let i = 0; i < 100 && !settled; i++) {
        await vi.advanceTimersByTimeAsync(100);
      }
      const res = await pending;
      const body = await res.json();
      return { status: res.status, body, headers: res.headers };
    }

    function anonRequest(ip: string): Request {
      return new Request("http://localhost/api/health", {
        headers: { "x-forwarded-for": ip },
      });
    }

    it("is ok with a numeric latencyMs when the read path answers quickly", async () => {
      const { status, body } = await callGet();
      expect(status).toBe(200);
      expect(body.status).toBe("healthy");
      expect(body.checks.readPath.ok).toBe(true);
      expect(typeof body.checks.readPath.latencyMs).toBe("number");
      expect(body.checks.readPath.error).toBeUndefined();
    });

    it("sends the homepage-shaped read: embedded cluster_articles graph, live clusters, 20 rows, bounded by an AbortSignal", async () => {
      await callGet();
      expect(readPathCalls.count).toBe(1);
      expect(readPathCalls.select).toContain("cluster_articles");
      expect(readPathCalls.select).toContain("articles");
      expect(readPathCalls.select).toContain("sources");
      expect(readPathCalls.eq).toContainEqual(["is_archived", false]);
      expect(readPathCalls.gte).toContainEqual(["article_count", 2]);
      expect(readPathCalls.limit).toBe(20);
      expect(readPathCalls.signal).toBeInstanceOf(AbortSignal);
    });

    it("runs for an anonymous caller too, without leaking it into the body", async () => {
      const { status, body } = await callGet(anonRequest("203.0.113.150"));
      expect(status).toBe(200);
      expect(readPathCalls.count).toBe(1);
      expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    });

    it("runs in parallel with the database probe (neither waits for the other)", async () => {
      let release!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        release = resolve;
      });
      // If the DB probe ran first and to completion, it would block on a
      // read-path call that has not started yet and time out after 2 s.
      responders.sourcesSelect = async () => {
        await readStarted;
        return { data: [{ id: "s1" }], error: null };
      };
      responders.readPathSelect = async () => {
        release();
        return { data: [], error: null };
      };
      const { status, body } = await callGetFake();
      expect(status).toBe(200);
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.readPath.ok).toBe(true);
    });

    it("is degraded (200), not unhealthy, when the read succeeds but takes 1600 ms", async () => {
      responders.readPathSelect = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ data: [], error: null }), 1600);
        });
      const { status, body } = await callGetFake();
      expect(status).toBe(200);
      expect(body.status).toBe("degraded");
      expect(body.checks.readPath.ok).toBe(false);
      expect(body.checks.readPath.latencyMs).toBeGreaterThanOrEqual(1500);
      expect(body.checks.readPath.error).toBeUndefined();
      // Everything else stays green: this is a read-path-only degradation.
      expect(body.checks.database.ok).toBe(true);
      expect(body.checks.ingestion.ok).toBe(true);
    });

    it("treats exactly 1500 ms as still ok (the bound is inclusive)", async () => {
      responders.readPathSelect = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ data: [], error: null }), 1500);
        });
      const { status, body } = await callGetFake();
      expect(status).toBe(200);
      expect(body.status).toBe("healthy");
      expect(body.checks.readPath.ok).toBe(true);
      expect(body.checks.readPath.latencyMs).toBe(1500);
    });

    it("is unhealthy (503) when the read never resolves, and names the timeout", async () => {
      responders.readPathSelect = () => new Promise(() => {});
      const { status, body } = await callGetFake();
      expect(status).toBe(503);
      expect(body.status).toBe("unhealthy");
      expect(body.checks.readPath.ok).toBe(false);
      expect(body.checks.readPath.error).toMatch(/timed out/);
      // The cheap DB probe is still green: the whole point of the new probe.
      expect(body.checks.database.ok).toBe(true);
    });

    it("an anonymous caller of a hung read path gets 503 and ONLY {status, timestamp}", async () => {
      responders.readPathSelect = () => new Promise(() => {});
      const { status, body } = await callGetFake(anonRequest("203.0.113.151"));
      expect(status).toBe(503);
      expect(body).toEqual({
        status: "unhealthy",
        timestamp: expect.any(String),
      });
      expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    });

    it("is unhealthy (503) when the read comes back with an AbortError", async () => {
      responders.readPathSelect = async () => ({
        data: null,
        error: { message: "AbortError: x" },
      });
      const { status, body } = await callGet();
      expect(status).toBe(503);
      expect(body.status).toBe("unhealthy");
      expect(body.checks.readPath.ok).toBe(false);
      expect(body.checks.readPath.error).toBe("AbortError: x");
      expect(typeof body.checks.readPath.latencyMs).toBe("number");
    });

    it("is unhealthy (503) on a plain query error such as a statement timeout", async () => {
      responders.readPathSelect = async () => ({
        data: null,
        error: { message: "canceling statement due to statement timeout" },
      });
      const { status, body } = await callGet();
      expect(status).toBe(503);
      expect(body.checks.readPath.error).toMatch(/statement timeout/);
    });

    it("is unhealthy (503) when the read path throws outright", async () => {
      responders.readPathSelect = async () => {
        throw new Error("socket hang up");
      };
      const { status, body } = await callGet();
      expect(status).toBe(503);
      expect(body.checks.readPath.ok).toBe(false);
      expect(body.checks.readPath.error).toMatch(/socket hang up/);
    });

    it("an anonymous caller of a failing read path gets 503 and ONLY {status, timestamp}", async () => {
      responders.readPathSelect = async () => ({
        data: null,
        error: { message: "boom" },
      });
      const { status, body } = await callGet(anonRequest("203.0.113.152"));
      expect(status).toBe(503);
      expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    });

    it("an anonymous caller of a slow (1600 ms) read path gets 200 degraded and no latency", async () => {
      responders.readPathSelect = () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ data: [], error: null }), 1600);
        });
      const { status, body } = await callGetFake(anonRequest("203.0.113.153"));
      expect(status).toBe(200);
      expect(body.status).toBe("degraded");
      expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    });

    // -----------------------------------------------------------------------
    // Cost bound for the PUBLIC endpoint. The probe is a heavy embedded read
    // and an aborted client request keeps running in Postgres until
    // statement_timeout, so an anonymous flood must not turn into a flood of
    // heavy statements. Anonymous callers share ONE in-flight probe and a
    // short-TTL memo of its verdict; authed (CRON_SECRET) callers bypass it.
    // -----------------------------------------------------------------------
    describe("anonymous coalescing [cost bound]", () => {
      /**
       * Several sequential calls against ONE module instance under fake
       * timers (callGetFake re-imports and re-installs the clock, which would
       * reset the memo's clock between calls). performance is faked so the
       * memo's TTL clock advances with `advance`.
       */
      async function fakeCaller() {
        const mod = await import("@/app/api/health/route");
        vi.useFakeTimers({
          toFake: ["setTimeout", "clearTimeout", "performance"],
        });
        async function call(request: Request) {
          let settled = false;
          const pending = mod.GET(request).then(
            (r) => {
              settled = true;
              return r;
            },
            (e) => {
              settled = true;
              throw e;
            },
          );
          for (let i = 0; i < 100 && !settled; i++) {
            await vi.advanceTimersByTimeAsync(100);
          }
          const res = await pending;
          return { status: res.status, body: await res.json() };
        }
        return { call, advance: (ms: number) => vi.advanceTimersByTimeAsync(ms) };
      }

      function authedRequest(): Request {
        return new Request("http://localhost/api/health", {
          headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
        });
      }

      it("N sequential anonymous requests inside the TTL trigger ONE read-path query", async () => {
        for (let i = 0; i < 8; i++) {
          const { status } = await callGet(anonRequest(`198.51.100.${10 + i}`));
          expect(status).toBe(200);
        }
        expect(readPathCalls.count).toBe(1);
      });

      it("concurrent anonymous requests share one in-flight probe (single-flight)", async () => {
        responders.readPathSelect = () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: [], error: null }), 25);
          });
        const results = await Promise.all(
          Array.from({ length: 10 }, (_, i) =>
            callGet(anonRequest(`198.51.100.${40 + i}`)),
          ),
        );
        expect(results.every((r) => r.status === 200)).toBe(true);
        expect(readPathCalls.count).toBe(1);
      });

      it("re-probes once a successful verdict is older than 15 s, and not before", async () => {
        const { call, advance } = await fakeCaller();
        await call(anonRequest("198.51.100.60"));
        expect(readPathCalls.count).toBe(1);

        await advance(14_000);
        await call(anonRequest("198.51.100.61"));
        expect(readPathCalls.count).toBe(1);

        await advance(1_500); // 15.5 s after the probe settled
        await call(anonRequest("198.51.100.62"));
        expect(readPathCalls.count).toBe(2);
      });

      it("a failed verdict is memoised for only 5 s: anonymous callers keep seeing 503, then it re-probes", async () => {
        responders.readPathSelect = async () => ({
          data: null,
          error: { message: "canceling statement due to statement timeout" },
        });
        const { call, advance } = await fakeCaller();

        const first = await call(anonRequest("198.51.100.70"));
        expect(first.status).toBe(503);
        expect(readPathCalls.count).toBe(1);

        await advance(3_000);
        const second = await call(anonRequest("198.51.100.71"));
        expect(second.status).toBe(503);
        expect(readPathCalls.count).toBe(1);

        // Recovered upstream: the next probe after the 5 s failure TTL heals.
        responders.readPathSelect = async () => ({ data: [], error: null });
        await advance(2_500); // 5.5 s after the failed probe
        const third = await call(anonRequest("198.51.100.72"));
        expect(third.status).toBe(200);
        expect(readPathCalls.count).toBe(2);
      });

      it("a slow-but-successful (degraded) verdict is not memoised as long as a clean one", async () => {
        responders.readPathSelect = () =>
          new Promise((resolve) => {
            setTimeout(() => resolve({ data: [], error: null }), 1600);
          });
        const { call, advance } = await fakeCaller();

        const first = await call(anonRequest("198.51.100.80"));
        expect(first.body.status).toBe("degraded");
        expect(readPathCalls.count).toBe(1);

        await advance(5_500);
        await call(anonRequest("198.51.100.81"));
        expect(readPathCalls.count).toBe(2);
      });

      it("authed callers bypass the memo and always get a fresh reading", async () => {
        const { call } = await fakeCaller();

        await call(anonRequest("198.51.100.90"));
        expect(readPathCalls.count).toBe(1);

        // The database went bad AFTER the anonymous verdict was memoised.
        responders.readPathSelect = async () => ({
          data: null,
          error: { message: "boom" },
        });
        const authed = await call(authedRequest());
        expect(authed.status).toBe(503);
        expect(authed.body.checks.readPath.error).toBe("boom");
        expect(readPathCalls.count).toBe(2);

        await call(authedRequest());
        expect(readPathCalls.count).toBe(3);
      });

      it("a memoised failure never leaks detail into the anonymous body", async () => {
        responders.readPathSelect = async () => ({
          data: null,
          error: { message: "secret internal detail" },
        });
        const { call } = await fakeCaller();
        await call(anonRequest("198.51.100.95"));
        const again = await call(anonRequest("198.51.100.96"));
        expect(again.status).toBe(503);
        expect(Object.keys(again.body).sort()).toEqual(["status", "timestamp"]);
      });
    });

    it("skips the read-path probe when env is broken (short-circuit), still 503", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      const { status, body } = await callGet();
      expect(status).toBe(503);
      expect(readPathCalls.count).toBe(0);
      expect(body.checks.readPath.ok).toBe(false);
      expect(body.checks.readPath.error).toBeUndefined();
    });
  });

  describe("checks.sources [ingest-health]", () => {
    it("lists a never-delivered source and a 4-day-stale one with failStreak and quarantined", async () => {
      const staleIso = new Date(
        Date.now() - 4 * 24 * 60 * 60 * 1000,
      ).toISOString();
      responders.sourcesStatus = async () => ({
        data: [
          {
            slug: "never-delivered",
            name: "Never Delivered",
            bias: "center",
            kind: "outlet",
            fetch_last_status: 200,
            fetch_last_at: new Date().toISOString(),
            fetch_fail_streak: 0,
            fetch_quarantined_until: null,
            latest: [],
          },
          {
            slug: "stale-4d",
            name: "Stale Four Days",
            bias: "center",
            kind: "outlet",
            fetch_last_status: 403,
            fetch_last_at: new Date().toISOString(),
            fetch_fail_streak: 12,
            fetch_quarantined_until: new Date(
              Date.now() + 60 * 60 * 1000,
            ).toISOString(),
            latest: [{ published_at: staleIso }],
          },
          {
            slug: "healthy-outlet",
            name: "Healthy Outlet",
            bias: "center",
            kind: "outlet",
            fetch_last_status: 200,
            fetch_last_at: new Date().toISOString(),
            fetch_fail_streak: 0,
            fetch_quarantined_until: null,
            latest: [{ published_at: new Date().toISOString() }],
          },
        ],
        error: null,
      });

      const { status, body } = await callGet();
      expect(status).toBe(200);
      expect(sourcesStatusCallCount).toBe(1);

      const sources = body.checks.sources as {
        ok: boolean;
        active: number;
        silent: number;
        votingActive: number;
        votingSilent: number;
        silentSources: Array<{
          slug: string;
          never: boolean;
          lastItemAt: string | null;
          lastHttpStatus: number | null;
          failStreak: number;
          quarantined: boolean;
        }>;
      };
      expect(sources.active).toBe(3);
      expect(sources.silent).toBe(2);
      // Never-delivered sorts first.
      expect(sources.silentSources[0]?.slug).toBe("never-delivered");
      expect(sources.silentSources[0]?.never).toBe(true);
      expect(sources.silentSources[0]?.lastItemAt).toBeNull();
      const stale = sources.silentSources.find((s) => s.slug === "stale-4d");
      expect(stale).toBeDefined();
      expect(stale?.never).toBe(false);
      expect(stale?.lastHttpStatus).toBe(403);
      expect(stale?.failStreak).toBe(12);
      expect(stale?.quarantined).toBe(true);
    });

    it("flips sources.ok false when 3 of 4 voting sources are silent, without touching the overall verdict", async () => {
      const now = new Date().toISOString();
      const freshRow = (slug: string) => ({
        slug,
        name: slug,
        bias: "center",
        kind: "outlet",
        fetch_last_status: 200,
        fetch_last_at: now,
        fetch_fail_streak: 0,
        fetch_quarantined_until: null,
        latest: [{ published_at: now }],
      });
      const silentRow = (slug: string) => ({
        slug,
        name: slug,
        bias: "center",
        kind: "outlet",
        fetch_last_status: 200,
        fetch_last_at: now,
        fetch_fail_streak: 3,
        fetch_quarantined_until: null,
        latest: [],
      });
      responders.sourcesStatus = async () => ({
        data: [
          silentRow("s1"),
          silentRow("s2"),
          silentRow("s3"),
          freshRow("s4"),
        ],
        error: null,
      });

      const { status, body } = await callGet();
      expect(status).toBe(200);
      expect(body.status).toBe("healthy");
      const sources = body.checks.sources as { ok: boolean; votingActive: number; votingSilent: number };
      expect(sources.votingActive).toBe(4);
      expect(sources.votingSilent).toBe(3);
      expect(sources.ok).toBe(false);
    });

    it("never queries sources-status for an anonymous caller", async () => {
      responders.sourcesStatus = async () => ({
        data: [
          {
            slug: "should-not-be-queried",
            name: "x",
            bias: "center",
            kind: "outlet",
            fetch_last_status: 200,
            fetch_last_at: new Date().toISOString(),
            fetch_fail_streak: 0,
            fetch_quarantined_until: null,
            latest: [],
          },
        ],
        error: null,
      });

      const { status, body } = await callGet(
        new Request("http://localhost/api/health"),
      );
      expect(status).toBe(200);
      expect(sourcesStatusCallCount).toBe(0);
      expect((body as { checks?: unknown }).checks).toBeUndefined();
    });

    it("surfaces a sources-status query error without changing the verdict", async () => {
      responders.sourcesStatus = async () => ({
        data: null,
        error: { message: "sources status query boom" },
      });

      const { status, body } = await callGet();
      expect(status).toBe(200);
      expect(body.status).toBe("healthy");
      const sources = body.checks.sources as { ok: boolean; error?: string };
      expect(sources.ok).toBe(false);
      expect(sources.error).toMatch(/sources status query boom/);
      expect(body.checks.database.ok).toBe(true);
    });
  });
});
