import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

/**
 * Lightweight health check endpoint (E1 / Observability + B8 worker-stream
 * additions).
 *
 * Returns 200 + JSON when every critical subsystem is reachable, or 503 +
 * JSON with per-check details when something critical is wrong. The
 * `ingestion`, `clustering`, and `queues` checks are best-effort: stale data
 * (or a malformed `worker_metrics` view) downgrades the affected probe to a
 * non-critical "degraded" signal but never flips the whole endpoint to 503,
 * since these are operational concerns rather than user-facing outages.
 *
 * RESPONSE SHAPES
 * ---------------
 *   - Anonymous callers receive only `{ status, timestamp }`. We do not
 *     expose internal probe data to the open internet because that data
 *     (queue depths, article-age, missing env-var names) is operational
 *     reconnaissance an attacker can use to time pressure on the pipeline.
 *   - Callers presenting an Authorization header are asking for the full
 *     per-check breakdown and go through the shared `requireCronBearer`
 *     gate (`src/lib/api/bearer.ts`): FAIL-CLOSED 503 when `CRON_SECRET`
 *     is unset/empty, 401 on a mismatched token — the same posture as
 *     `/api/cron/headline`.
 *
 * Constraints:
 *   - Must never block the caller for more than ~2s per check. Each
 *     subsystem call is wrapped in `withTimeout` so a hung Postgres
 *     connection can't pin the request open forever.
 *   - Must stay GET-only and dynamic so platform caches (Vercel CDN,
 *     browser) can't serve stale "healthy" responses while the underlying
 *     service melts down.
 *   - Wrapped in `withApiErrors` so unexpected throws land in Sentry and
 *     return the canonical JSON-500 envelope instead of Next's default
 *     HTML error page.
 */

interface QueueMetric {
  queue: string;
  queueLength: number;
  oldestMsgAgeSec: number | null;
}

type HealthVerdict = "healthy" | "degraded" | "unhealthy";

interface HealthChecks {
  database: { ok: boolean; latencyMs?: number; error?: string };
  env: { ok: boolean; missing: string[] };
  ingestion: { ok: boolean; lastArticleAgeSec?: number; error?: string };
  clustering: {
    ok: boolean;
    lastClusterAgeSec?: number;
    error?: string;
  };
  queues: { ok: boolean; metrics?: QueueMetric[]; error?: string };
}

interface DetailedHealthBody {
  status: HealthVerdict;
  timestamp: string;
  checks: HealthChecks;
}

interface AnonymousHealthBody {
  status: HealthVerdict;
  timestamp: string;
}

const PER_CHECK_TIMEOUT_MS = 2000;
const STALE_INGESTION_THRESHOLD_SEC = 600; // 10 minutes — see AGENTS.md
// B8: clustering must move within 15 minutes; the consumer drains every
// minute via pg_cron so a 15-minute gap means the consumer (or pgmq) is
// stuck. This matches the threshold the ADR-001 audit row called out.
// We track `updated_at` rather than `created_at` so the probe reflects
// active processing (clusters being re-scored as new articles arrive) and
// not just the first time each cluster was inserted; under steady-state
// traffic many minutes can pass with no NEW clusters formed even while
// the consumer is happily ack-ing messages.
const STALE_CLUSTERING_THRESHOLD_SEC = 15 * 60;
// B8: queue-depth alarms, sized per queue because consumer throughputs
// differ by an order of magnitude. The cluster_work consumer batches 50
// messages per invocation and runs every minute, so 500 in-flight is ~10
// minutes of throughput — a stuck consumer rather than a normal backlog.
// The image_backfill consumer batches only 20 every 5 minutes (~4 msgs/min);
// the same 500 would take two hours to drain, so 100 (~25 minutes of
// throughput) is the equivalent stuck-consumer signal for that queue.
// Oldest-message-age over 30 min is a stronger signal — a single message
// that's been visible for 30+ min almost certainly means the consumer is
// failing to archive it.
const QUEUE_DEPTH_THRESHOLDS: Record<string, { depth: number }> = {
  cluster_work: { depth: 500 },
  image_backfill: { depth: 100 },
};
// A queue added by a future migration but not yet tuned above alarms on the
// strictest configured bound rather than growing unwatched.
const FALLBACK_QUEUE_DEPTH_THRESHOLD = 100;
const QUEUE_OLDEST_AGE_THRESHOLD_SEC = 30 * 60;

// Anonymous callers are rate-limited per client key so the public `{status}`
// envelope path can't be used to hammer Supabase for free. The limiter is
// process-local (`src/lib/rate-limit.ts`): on a multi-instance deploy each
// instance keeps its own buckets, so this bounds probe cost PER INSTANCE —
// it is not a global flood defense. Capacity stays small so N instances ×
// capacity remains cheap against Supabase. The bearer path (authenticated
// via CRON_SECRET) bypasses this limiter — the monitoring / cron system has
// a legitimate need to probe at high cadence, and the bearer check is
// already constant-time-safe + secret-gated.
//
// Token-bucket sizing: capacity 5 / refill 1 token per second absorbs a
// small first-paint burst (e.g. a status-page dashboard fanning out) then
// settles to a steady 1/sec per client per instance.
const anonHealthLimit = createRateLimiter("health-anon", {
  capacity: 5,
  refillPerSecond: 1,
});

/**
 * Race a promise against a timer so a single hung subsystem can't blow our
 * 2s SLA. Resolves to a tagged union so callers can render a clean error
 * message instead of a generic "timed out".
 */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false; error: string }>((resolve) => {
    timer = setTimeout(
      () => resolve({ ok: false, error: `${label} timed out after ${ms}ms` }),
      ms
    );
  });
  try {
    const value = await Promise.race([
      promise.then((v) => ({ ok: true as const, value: v })),
      timeout,
    ]);
    return value;
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Run a probe function inside an outer try/catch so an unexpected throw
 * (malformed view, missing column, etc.) degrades the single affected
 * probe rather than 500-ing the whole endpoint. Returns the same tagged
 * shape `withTimeout` produces so call-sites stay uniform.
 */
async function safeProbe<T>(
  fn: () => Promise<T>,
  label: string
): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return await withTimeout(fn(), PER_CHECK_TIMEOUT_MS, label);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `${label} threw: ${message}` };
  }
}

// Next's route validator rejects optional params; guards below still allow GET().
export const GET = withApiErrors(async (request: Request) => {
  // Next.js 16 with cacheComponents prerenders GET handlers at build time.
  // Touching `request.headers` during prerender raises
  // `NEXT_PRERENDER_INTERRUPTED`, which `withApiErrors` re-throws through
  // `unstable_rethrow`. `await connection()` is the documented escape
  // hatch — it hangs forever during prerender and resolves only on a real
  // request, so the handler stays fully dynamic.
  await connection();

  // Two-tier auth, decided once up front. A request WITHOUT an
  // Authorization header takes the anonymous path: rate-limited, summary
  // `{ status, timestamp }` envelope, CRON_SECRET never read. A request
  // that presents an Authorization header is asking for the detailed
  // envelope and goes through the shared FAIL-CLOSED bearer gate (503 when
  // CRON_SECRET is unset/empty, 401 on a mismatched token), which reads
  // CRON_SECRET exactly once. `respond` receives the verdict instead of
  // re-deriving it, so no second env read happens per request.
  let authed = false;
  if (request !== undefined && request.headers.get("authorization") !== null) {
    const auth = requireCronBearer(request);
    if (!auth.ok) {
      return auth.response;
    }
    authed = true;
  }

  // Anonymous callers hit the rate-limit gate BEFORE any probes run. An
  // over-limit caller short-circuits with 429 and never touches Supabase.
  if (!authed && request !== undefined) {
    const rl = anonHealthLimit(clientKey(request));
    if (!rl.allowed) {
      return NextResponse.json(
        { status: "rate_limited", retryAfterMs: rl.retryAfterMs },
        {
          status: 429,
          headers: {
            "Cache-Control": "no-store",
            "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)),
          },
        },
      );
    }
  }

  const checks: HealthChecks = {
    database: { ok: false },
    env: { ok: false, missing: [] },
    ingestion: { ok: false },
    clustering: { ok: false },
    queues: { ok: false },
  };

  // 1. Env check — cheap, synchronous, runs first so a misconfigured deploy
  //    can't even reach the DB layer with a bogus client.
  const required = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
  const missing = required.filter((k) => !process.env[k]);
  checks.env = { ok: missing.length === 0, missing };

  // If env is broken there's no point hitting Supabase — the service-role
  // client will throw on construction. Short-circuit to a 503 with a useful
  // payload so on-call sees exactly what's missing.
  if (!checks.env.ok) {
    return respond("unhealthy", checks, 503, authed);
  }

  // 2. DB check — `select 1`-equivalent against a tiny, always-present table.
  //    We use `sources` because it's small and read-only in normal traffic,
  //    so the query is effectively free even on a busy primary.
  const dbResult = await safeProbe(async () => {
    const supabase = createServerClient();
    const t0 = performance.now();
    const { error } = await supabase.from("sources").select("id").limit(1);
    const latencyMs = Math.round(performance.now() - t0);
    if (error) {
      return { ok: false as const, latencyMs, error: error.message };
    }
    return { ok: true as const, latencyMs };
  }, "database");
  if (dbResult.ok) {
    checks.database = dbResult.value;
  } else {
    checks.database = { ok: false, error: dbResult.error };
  }

  // 3. Ingestion check — newest article's age. We treat "no rows" as a soft
  //    failure (degraded, not unhealthy) because a fresh deploy / cold DB
  //    legitimately has zero articles until the first cron tick.
  const ingestionResult = await safeProbe(async () => {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("articles")
      .select("created_at")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { ok: false as const, error: error.message };
    }
    if (!data) {
      return { ok: false as const, error: "no articles" };
    }
    const ageSec =
      (Date.now() - new Date(data.created_at).getTime()) / 1000;
    return {
      ok: ageSec < STALE_INGESTION_THRESHOLD_SEC,
      lastArticleAgeSec: Math.round(ageSec),
    };
  }, "ingestion");
  if (ingestionResult.ok) {
    checks.ingestion = ingestionResult.value;
  } else {
    checks.ingestion = { ok: false, error: ingestionResult.error };
  }

  // 4. Clustering check (B8) — most recently TOUCHED cluster. We look at
  //    `updated_at` (not `created_at`) so the probe reflects active
  //    processing: every cluster-consumer pass updates a cluster row even
  //    when no new cluster is formed. Under normal load the freshest
  //    `updated_at` should be within the last 15 minutes. A gap larger
  //    than that means either (a) the consumer is stuck (pgmq
  //    visibility-timeout exhaustion, Deno panic, etc.) or (b) no
  //    articles are being ingested — and (b) is already reflected in the
  //    ingestion check above. We keep the two signals separate so an
  //    alert can tell us WHICH side of the pipeline is broken.
  const clusteringResult = await safeProbe(async () => {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("clusters")
      .select("updated_at")
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) {
      return { ok: false as const, error: error.message };
    }
    if (!data) {
      // No clusters at all is degraded (fresh deploy), not unhealthy.
      return { ok: false as const, error: "no clusters" };
    }
    const ageSec =
      (Date.now() - new Date(data.updated_at).getTime()) / 1000;
    return {
      ok: ageSec < STALE_CLUSTERING_THRESHOLD_SEC,
      lastClusterAgeSec: Math.round(ageSec),
    };
  }, "clustering");
  if (clusteringResult.ok) {
    checks.clustering = clusteringResult.value;
  } else {
    checks.clustering = { ok: false, error: clusteringResult.error };
  }

  // 5. Queues check (B8) — read the `worker_metrics` view that B1's
  //    migration exposes (filtered pgmq.metrics_all). A deep queue or an
  //    old oldest-message age means the consumer isn't keeping up. This
  //    is downgraded to "degraded" rather than "unhealthy" because a
  //    transient backlog doesn't warrant paging on-call; the clustering
  //    check above is the canonical "workers are dead" signal.
  //
  //    `oldest_msg_age_sec` is coerced through `Number()` and gated by
  //    `Number.isFinite` so a string / NaN coming back from the view
  //    (driver quirks, BIGINT serialisation, etc.) can't accidentally
  //    pass a numeric comparison against the threshold. A null age is a
  //    legitimate state (empty queue), so non-finite ages coerce to null.
  //    `queue_length` is held to a harder line: an empty queue reports 0,
  //    so a NULL / non-numeric length has no legitimate meaning and fails
  //    the probe outright instead of masquerading as a healthy zero.
  const queuesResult = await safeProbe(async () => {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("worker_metrics")
      .select("queue_name, queue_length, oldest_msg_age_sec");
    if (error) {
      return { ok: false as const, error: error.message };
    }
    if (!data || data.length === 0) {
      // Empty result means the view exists but pgmq.metrics_all() returned
      // nothing for our queues — typically because the queues haven't been
      // created yet (migration 024 didn't run). Surface as a soft failure.
      return { ok: false as const, error: "no queue metrics" };
    }
    type Row = {
      queue_name: string;
      queue_length: number | string | null;
      oldest_msg_age_sec: number | string | null;
    };
    const rows = data as Row[];
    const metrics: QueueMetric[] = [];
    for (const r of rows) {
      // `Number(null)` is 0, so route null/undefined through NaN to keep
      // them on the failure path with every other non-finite value.
      const lengthNum = Number(r.queue_length ?? NaN);
      if (!Number.isFinite(lengthNum)) {
        return {
          ok: false as const,
          error: `malformed worker_metrics row: queue ${r.queue_name} queue_length is not a finite number`,
        };
      }
      const ageRaw = r.oldest_msg_age_sec;
      const ageNum = ageRaw === null ? null : Number(ageRaw);
      const oldestMsgAgeSec =
        ageNum !== null && Number.isFinite(ageNum) ? ageNum : null;
      metrics.push({
        queue: r.queue_name,
        queueLength: lengthNum,
        oldestMsgAgeSec,
      });
    }
    // Depth bounds are per-queue (consumer throughputs differ by an order
    // of magnitude); the error names the tripping queue, dimension, and
    // the bound that applied so on-call doesn't have to guess which limit
    // fired.
    for (const m of metrics) {
      const depthLimit =
        QUEUE_DEPTH_THRESHOLDS[m.queue]?.depth ??
        FALLBACK_QUEUE_DEPTH_THRESHOLD;
      if (m.queueLength > depthLimit) {
        return {
          ok: false as const,
          metrics,
          error: `queue ${m.queue} depth ${m.queueLength} exceeds ${depthLimit}`,
        };
      }
    }
    const overAge = metrics.find(
      (m) =>
        m.oldestMsgAgeSec !== null &&
        m.oldestMsgAgeSec > QUEUE_OLDEST_AGE_THRESHOLD_SEC
    );
    if (overAge) {
      return {
        ok: false as const,
        metrics,
        error: `queue ${overAge.queue} oldest message age ${overAge.oldestMsgAgeSec}s exceeds ${QUEUE_OLDEST_AGE_THRESHOLD_SEC}s`,
      };
    }
    return { ok: true as const, metrics };
  }, "queues");
  if (queuesResult.ok) {
    checks.queues = queuesResult.value;
  } else {
    checks.queues = { ok: false, error: queuesResult.error };
  }

  // Status rollup:
  //   - DB or env failure                  -> unhealthy / 503 (page someone)
  //   - ingestion / clustering / queues    -> degraded / 200 (warn, no page)
  //   - everything green                   -> healthy / 200
  //
  // Clustering and queues are intentionally NOT critical: a stuck consumer
  // is bad but not a user-facing outage (the homepage keeps serving the
  // last good cluster set). DB / env failures break every page render and
  // SHOULD page.
  const anyCritical = !checks.database.ok || !checks.env.ok;
  const allOk =
    checks.database.ok &&
    checks.env.ok &&
    checks.ingestion.ok &&
    checks.clustering.ok &&
    checks.queues.ok;
  const verdict: HealthVerdict = allOk
    ? "healthy"
    : anyCritical
      ? "unhealthy"
      : "degraded";

  return respond(verdict, checks, anyCritical ? 503 : 200, authed);
});

/**
 * Build the JSON response. Authenticated callers (CRON_SECRET bearer) get
 * the full probe breakdown; anonymous callers get only the rollup verdict
 * + timestamp. The `authed` flag is the bearer-gate verdict computed once
 * at the top of GET — re-checking here would mean a second CRON_SECRET
 * read per request. Cache-Control is `no-store` so neither the CDN nor
 * the browser can serve a stale "healthy" snapshot while the pipeline is
 * actually on fire.
 */
function respond(
  verdict: HealthVerdict,
  checks: HealthChecks,
  status: number,
  authed: boolean
): Response {
  const timestamp = new Date().toISOString();

  const headers = { "Cache-Control": "no-store" };

  if (authed) {
    const body: DetailedHealthBody = { status: verdict, timestamp, checks };
    return NextResponse.json(body, { status, headers });
  }

  const body: AnonymousHealthBody = { status: verdict, timestamp };
  return NextResponse.json(body, { status, headers });
}
