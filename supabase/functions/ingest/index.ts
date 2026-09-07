// supabase/functions/ingest/index.ts
//
// Tayf RSS ingest Edge Function. Replaces the long-running `scripts/rss-worker.mjs`
// tmux pattern with a per-cycle invocation pokeable from Vercel cron
// (`/api/cron/ingest`) on a 3-minute schedule. Per cycle this function:
//
//   1. Pulls every active row from `sources`.
//   2. Fans out concurrent fetches (pool of 16) using `fetchFeed`.
//      Each fetch is charset-aware (HTTP header → XML prolog → UTF-8 default),
//      honours conditional GET (ETag + Last-Modified) within a single
//      Edge Function instance, and aborts on a 10 s timeout.
//   3. Normalises each item via `normalizeItem`, which produces the canonical
//      sha1-of-shingles `content_hash` (audit T7 P1-21 fix).
//   4. Upserts every produced row in batches of 500 with
//      `on_conflict=url&ignore_duplicates=true`. The `AFTER INSERT ON articles`
//      trigger (migration 025) takes over from here to enqueue `cluster_work`
//      and `image_backfill` messages.
//
// Wall-clock budget: 60 s (the Edge Functions hard ceiling is 400 s). We
// stay well under because the 16-way pool keeps the slowest tail fetch
// from blocking the cycle, and the fetch pool stops 10 s early so rows
// that were fetched and normalized always get a write window. On
// per-source failure we just log and move on; transient outlet outages
// must not poison the cycle.

import { fetchFeed } from "../_shared/rss/fetcher.ts";
import type { RssSource } from "../_shared/rss/fetcher.ts";
import type { NormalizedArticle } from "../_shared/rss/normalize.ts";
import { canonicalizeUrl, normalizeArticles } from "../_shared/rss/normalize.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";

await initSentry("ingest");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 10_000;
const FETCH_CONCURRENCY = 16;
const UPSERT_BATCH = 500;
// Wall-clock safety. Edge Functions allow ≤400 s; we cap well below so a
// pathological tail can't push us past the slot. The Vercel cron retries
// every 3 min so partial progress is harmless. The fetch pool gets the
// tighter FETCH_DEADLINE_MS so rows that were fetched and normalized
// always have at least a 10 s write window — without the reserve, a
// deadline elapsing mid-fetch dropped every assembled row on the floor
// (audit S13).
const CYCLE_DEADLINE_MS = 60_000;
const FETCH_DEADLINE_MS = CYCLE_DEADLINE_MS - 10_000;

// ---------------------------------------------------------------------------
// In-instance caches
// ---------------------------------------------------------------------------
//
// Edge Function instances pool requests for a few minutes between cold
// starts, so a `Map` declared at module scope survives across invocations.
// We use that to keep ETag / Last-Modified validators warm — the second
// poll against a healthy outlet should land on `304 Not Modified` and
// skip XML parsing entirely.
const conditionalCache = new Map<
  string,
  { etag?: string; lastModified?: string }
>();

// ---------------------------------------------------------------------------
// Concurrency-bounded pool
// ---------------------------------------------------------------------------

async function runPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
  deadline?: number,
): Promise<void> {
  if (items.length === 0) return;
  let cursor = 0;
  const workerCount = Math.min(concurrency, items.length);
  const runners: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) {
    runners.push(
      (async () => {
        while (true) {
          if (deadline && Date.now() > deadline) return;
          const i = cursor++;
          if (i >= items.length) return;
          try {
            await worker(items[i] as T, i);
          } catch {
            // Worker is expected to absorb its own errors; this is the
            // safety net so one pathological row cannot kill the pool.
          }
        }
      })(),
    );
  }
  await Promise.all(runners);
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

interface CycleStats {
  sources: number;
  fetched: number;
  failed: number;
  notModified: number;
  itemsNormalized: number;
  inserted: number;
  rowErrors: number;
  durationMs: number;
}

// The normaliser computes a canonical form of `url` internally (for
// category classification) but the `NormalizedArticle` it returns only
// carries the raw absolute `url`. We recompute the canonical form here
// (same pure `canonicalizeUrl` the normaliser uses) so it can ride along
// in the same upsert as an additive `canonical_url` column (migration 039)
// without changing the normaliser's public shape.
type IngestArticleRow = NormalizedArticle & { canonical_url: string | null };

// Best-effort telemetry write: one row per cycle in `ingest_cycles`
// (migration 039), regardless of whether the cycle finished cleanly or
// `runCycle` is unwinding through a thrown error. Errors here are logged
// and swallowed — a telemetry outage must never fail (or re-fail) a cycle.
async function recordIngestCycle(
  supabase: ReturnType<typeof createServiceClient>,
  startedAt: number,
  stats: CycleStats,
): Promise<void> {
  try {
    const { error } = await supabase.from("ingest_cycles").insert({
      started_at: new Date(startedAt).toISOString(),
      fetched: stats.fetched,
      inserted: stats.inserted,
      row_errors: stats.rowErrors,
      failed: stats.failed,
      // Fall back to an on-the-spot measurement for the (should-not-happen)
      // case where an unguarded throw unwinds before stats.durationMs was
      // ever assigned.
      duration_ms: stats.durationMs || Date.now() - startedAt,
    });
    if (error) {
      console.error(`[ingest] ingest_cycles insert failed: ${error.message}`);
    }
  } catch (err) {
    console.error("[ingest] ingest_cycles insert threw", err);
  }
}

async function runCycle(): Promise<CycleStats> {
  const startedAt = Date.now();
  const deadline = startedAt + CYCLE_DEADLINE_MS;
  // The fetch pool stops FETCH_DEADLINE_MS in so the upsert loop below
  // always has at least a 10 s write window against the full deadline.
  const fetchDeadline = startedAt + FETCH_DEADLINE_MS;
  const supabase = createServiceClient();

  const stats: CycleStats = {
    sources: 0,
    fetched: 0,
    failed: 0,
    notModified: 0,
    itemsNormalized: 0,
    inserted: 0,
    rowErrors: 0,
    durationMs: 0,
  };

  // The `finally` below fires on every exit from this point on — the two
  // early returns, the final return, and any throw (including the
  // `sourcesError` throw right after this block) — so `ingest_cycles` gets
  // exactly one best-effort row per invocation on both the success and the
  // failure path (product decision for migration 039).
  try {
    return await runCycleBody(supabase, startedAt, deadline, fetchDeadline, stats);
  } finally {
    await recordIngestCycle(supabase, startedAt, stats);
  }
}

async function runCycleBody(
  supabase: ReturnType<typeof createServiceClient>,
  startedAt: number,
  deadline: number,
  fetchDeadline: number,
  stats: CycleStats,
): Promise<CycleStats> {
  const { data: sources, error: sourcesError } = await supabase
    .from("sources")
    .select("id, name, slug, url, rss_url")
    .eq("active", true)
    .order("slug");

  if (sourcesError) {
    stats.durationMs = Date.now() - startedAt;
    throw new Error(`fetch sources failed: ${sourcesError.message}`);
  }
  const liveSources = (sources ?? []) as RssSource[];
  stats.sources = liveSources.length;
  if (liveSources.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    console.log("[ingest] cycle", JSON.stringify({ ...stats }));
    return stats;
  }

  const allRows: IngestArticleRow[] = [];
  // Per-source intra-cycle de-dup so two section-slug variants of the same
  // article inside one feed collapse before the upsert. Keyed by
  // `${source_id}\x1f${content_hash}`.
  const seenIntraCycle = new Set<string>();

  await runPool(
    liveSources,
    FETCH_CONCURRENCY,
    async (source) => {
      const result = await fetchFeed(source, {
        conditionalCache,
        timeoutMs: FETCH_TIMEOUT_MS,
      });

      if (result.error) {
        stats.failed++;
        console.error(`[ingest] ${source.slug} fetch failed: ${result.error}`);
        return;
      }
      if (result.notModified) {
        stats.notModified++;
        return;
      }

      stats.fetched++;
      const normalized = normalizeArticles(source, result.items);
      stats.itemsNormalized += normalized.length;

      for (const row of normalized) {
        const key = `${row.source_id}\x1f${row.content_hash}`;
        if (seenIntraCycle.has(key)) continue;
        seenIntraCycle.add(key);
        // Additive: canonicalizeUrl never throws (it catches internally and
        // falls back to the raw URL), so this is always a string in
        // practice — the column stays nullable for any future producer
        // that can't compute one.
        allRows.push({ ...row, canonical_url: canonicalizeUrl(row.url, source.slug) });
      }
    },
    fetchDeadline,
  );

  // Single batched upsert at cycle end. `ignoreDuplicates: true` against the
  // `url` UNIQUE constraint preserves the legacy "first insert wins" semantic
  // while the `(source_id, content_hash)` UNIQUE constraint (migration 013)
  // is the backstop for any seen-set miss. The AFTER INSERT trigger from
  // migration 025 fans queue work for every truly inserted row.
  if (allRows.length > 0 && Date.now() <= deadline) {
    for (let i = 0; i < allRows.length; i += UPSERT_BATCH) {
      if (Date.now() > deadline) break;
      const chunk = allRows.slice(i, i + UPSERT_BATCH);
      const { data: upserted, error: upsertError } = await supabase
        .from("articles")
        .upsert(chunk, { onConflict: "url", ignoreDuplicates: true })
        .select("id");
      if (upsertError) {
        console.error(
          `[ingest] batched upsert (chunk ${i}-${i + chunk.length}) failed: ${upsertError.message}`,
        );
        // Per-row fallback so one bad row can't poison the rest of the chunk.
        for (const row of chunk) {
          if (Date.now() > deadline) break;
          const { data: one, error: oneErr } = await supabase
            .from("articles")
            .upsert([row], { onConflict: "url", ignoreDuplicates: true })
            .select("id");
          if (oneErr) {
            // Surface the real per-row failure (schema drift, constraint
            // violations) instead of swallowing it — and count it so the
            // cycle response reports the loss (audit P3-9).
            stats.rowErrors++;
            console.error(
              `[ingest] row upsert failed: ${JSON.stringify({
                url: row.url,
                source_id: row.source_id,
                error: oneErr.message,
              })}`,
            );
            continue;
          }
          stats.inserted += one?.length ?? 0;
        }
      } else {
        stats.inserted += upserted?.length ?? 0;
      }
    }
  }

  stats.durationMs = Date.now() - startedAt;
  // One JSON-shaped summary line per cycle so cron runs are diagnosable from
  // the Edge Function logs alone (audit O13).
  console.log("[ingest] cycle", JSON.stringify({ ...stats }));
  return stats;
}

// ---------------------------------------------------------------------------
// HTTP entrypoint
// ---------------------------------------------------------------------------

Deno.serve(withSentry("ingest", async (req: Request) => {
  // Only the Vercel cron endpoint (or `supabase functions invoke`) should
  // reach this — Supabase Edge Functions sit behind a service-role bearer
  // gate by default, so an explicit allowlist here is a defence-in-depth
  // step rather than the primary access control.
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;

  // GET is a cheap liveness probe (no feed fetches, no DB writes). The
  // Vercel cron poke and operator-driven runs both come in as POST.
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  try {
    const stats = await runCycle();
    return new Response(JSON.stringify({ ok: true, ...stats }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const request_id = crypto.randomUUID();
    // Round-6 P1: forward to Sentry explicitly. The withSentry wrapper
    // only sees thrown errors; this catch builds a 500 response so the
    // throw never reaches the wrapper. Without this call the error
    // would only ever land in the Edge Function logs (not paged).
    captureException("ingest", err);
    // Log the full error (stack + message) to Edge Function logs as well
    // so the request_id can be correlated with the per-line context.
    console.error(`[ingest] ${request_id}`, err);
    return new Response(
      JSON.stringify({ ok: false, error: "internal-error", request_id }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}));
