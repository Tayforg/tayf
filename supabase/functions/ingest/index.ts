// supabase/functions/ingest/index.ts
//
// Tayf RSS ingest Edge Function. Replaces the long-running `scripts/rss-worker.mjs`
// tmux pattern with a per-cycle invocation pokeable from Vercel cron
// (`/api/cron/ingest`) on a 3-minute schedule. Per cycle this function:
//
//   1. Pulls every active row from `sources`.
//   2. Fans out concurrent fetches (pool of 16) using `fetchFeed`.
//      Each fetch is charset-aware (HTTP header → XML prolog → UTF-8 default),
//      honours conditional GET (ETag + Last-Modified, hydrated from
//      `sources` at cycle start so a cold start still sends validators —
//      migration 041) plus a body-hash fallback for feeds that reissue
//      identical XML without changing those headers, and aborts on a 10 s
//      timeout.
//   3. Normalises each item via `normalizeItem`, which produces the canonical
//      sha1-of-shingles `content_hash` (audit T7 P1-21 fix).
//   4. Upserts every produced row in batches of 500 with
//      `on_conflict=url&ignore_duplicates=true`, after dropping rows that
//      repeat a (source_id, content_hash) pair already seen this chunk or
//      already stored under a different url (migration 041 — the second
//      check is a DB round trip per chunk since `onConflict: "url"` alone
//      can't see that constraint). The `AFTER INSERT ON articles` trigger
//      (migration 025) takes over from here to enqueue `cluster_work` and
//      `image_backfill` messages.
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
// (audit S13). pg_cron invokes this function through net.http_post with a
// 60 s timeout (migration 038); returning at 50 s keeps the response and
// the cycle summary inside that window instead of racing it.
const CYCLE_DEADLINE_MS = 50_000;
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

// A `sources` row plus the five fetch-state columns (migration 041) used to
// hydrate `conditionalCache` at cycle start and to fall back to a body-hash
// comparison when an outlet reissues byte-identical XML without changing
// its validators.
interface SourceRow extends RssSource {
  fetch_etag: string | null;
  fetch_last_modified: string | null;
  fetch_body_hash: string | null;
  fetch_last_status: number | null;
  fetch_last_at: string | null;
}

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
  // Rows dropped before an upsert chunk, either as an intra-cycle repeat
  // (`dedupeBySourceContentHash`) or because the pair already exists in
  // `articles` under a different url (`dropExistingSourceContentHashRows`,
  // migration 041 F2). Not a column on `ingest_cycles` (039 shipped before
  // this existed) -- logged in the per-cycle summary line instead.
  dedupedInBatch: number;
  durationMs: number;
}

// The normaliser computes a canonical form of `url` internally (for
// category classification) but the `NormalizedArticle` it returns only
// carries the raw absolute `url`. We recompute the canonical form here
// (same pure `canonicalizeUrl` the normaliser uses) so it can ride along
// in the same upsert as an additive `canonical_url` column (migration 039)
// without changing the normaliser's public shape.
type IngestArticleRow = NormalizedArticle & { canonical_url: string | null };

// ---------------------------------------------------------------------------
// Batch de-dup (migration 041)
// ---------------------------------------------------------------------------

// `seenIntraCycle` in `runCycleBody` already keys on this same
// `(source_id, content_hash)` pair before a row is pushed onto `allRows`,
// so under normal operation this drops nothing -- it is the last line of
// defense right before a chunk can hit `articles_source_content_hash_key`
// (migration 013), which batched upserts were otherwise failing wholesale
// on and falling back to the (slow) per-row path for every row in the
// chunk instead of just the offending pair. Exported so the test suite can
// exercise it directly with a crafted duplicate pair.
export function dedupeBySourceContentHash<
  T extends { source_id: string; content_hash: string },
>(rows: readonly T[]): { rows: T[]; deduped: number } {
  const seen = new Set<string>();
  const out: T[] = [];
  let deduped = 0;
  for (const row of rows) {
    const key = `${row.source_id}\x1f${row.content_hash}`;
    if (seen.has(key)) {
      deduped++;
      continue;
    }
    seen.add(key);
    out.push(row);
  }
  return { rows: out, deduped };
}

// `dedupeBySourceContentHash` above only catches a repeat WITHIN the rows
// this cycle assembled. The 23505 the task describes (`articles_source_
// content_hash_key`) is a row colliding with an ALREADY-STORED article —
// same outlet republishing identical content under a new URL — which the
// `.upsert(chunk, { onConflict: "url" })` below can't see because it only
// targets the `url` UNIQUE constraint, not `(source_id, content_hash)`
// (migration 041 F2). We look the pairs up first and drop any chunk row
// that already exists so the batched insert never hits that constraint.
// `.in()` on both columns independently isn't a pairwise match (it's a
// cross product), so the exact-pair check happens client-side against the
// returned rows; a lookup failure degrades to "don't drop anything" and
// lets the pre-existing per-row fallback catch the 23505 as before.
async function dropExistingSourceContentHashRows(
  supabase: ReturnType<typeof createServiceClient>,
  rows: readonly IngestArticleRow[],
): Promise<{ rows: IngestArticleRow[]; dropped: number }> {
  if (rows.length === 0) return { rows: [], dropped: 0 };
  const sourceIds = [...new Set(rows.map((r) => r.source_id))];
  const hashes = [...new Set(rows.map((r) => r.content_hash))];

  let existingPairs: Array<{ source_id: string; content_hash: string }> = [];
  try {
    const { data, error } = await supabase
      .from("articles")
      .select("source_id, content_hash")
      .in("source_id", sourceIds)
      .in("content_hash", hashes);
    if (error) {
      console.error(`[ingest] existing (source_id, content_hash) lookup failed: ${error.message}`);
      return { rows: [...rows], dropped: 0 };
    }
    existingPairs = (data ?? []) as Array<{ source_id: string; content_hash: string }>;
  } catch (err) {
    console.error("[ingest] existing (source_id, content_hash) lookup threw", err);
    return { rows: [...rows], dropped: 0 };
  }
  if (existingPairs.length === 0) return { rows: [...rows], dropped: 0 };

  const existingKeys = new Set(
    existingPairs.map((r) => `${r.source_id}\x1f${r.content_hash}`),
  );
  const out: IngestArticleRow[] = [];
  let dropped = 0;
  for (const row of rows) {
    if (existingKeys.has(`${row.source_id}\x1f${row.content_hash}`)) {
      dropped++;
      continue;
    }
    out.push(row);
  }
  return { rows: out, dropped };
}

// ---------------------------------------------------------------------------
// Source fetch-state tracking (migration 041)
// ---------------------------------------------------------------------------

interface SourceFetchState {
  fetch_etag: string | null;
  fetch_last_modified: string | null;
  fetch_body_hash: string | null;
  fetch_last_status: number;
  fetch_last_at: string;
}

// Builds the row to persist for one attempted source this cycle. `fresh`
// carries new validators off a 2xx response; every other outcome (network
// error, non-2xx, 304) keeps the source's existing etag/lastModified/
// bodyHash untouched and only bumps status + timestamp -- there is nothing
// new to remember when the wire didn't hand us a body.
function buildFetchStateUpdate(
  source: SourceRow,
  status: number,
  fresh?: { etag: string | null; lastModified: string | null; bodyHash: string | null },
): SourceFetchState {
  return {
    fetch_etag: fresh ? fresh.etag : source.fetch_etag,
    fetch_last_modified: fresh ? fresh.lastModified : source.fetch_last_modified,
    fetch_body_hash: fresh ? fresh.bodyHash : source.fetch_body_hash,
    fetch_last_status: status,
    fetch_last_at: new Date().toISOString(),
  };
}

// Best-effort persistence of updated fetch validators back onto `sources`
// so the NEXT cycle -- even one starting from a fresh cold start that wiped
// `conditionalCache` -- can hydrate straight from the database and send
// If-None-Match / If-Modified-Since on its very first fetch instead of
// re-fetching every feed cold. One batched write (the
// `ingest_set_source_fetch_state` RPC from migration 041 -- a plain
// UPDATE ... FROM jsonb_to_recordset) covers every source actually
// attempted this cycle. Deliberately NOT a PostgREST upsert: that is
// INSERT ... ON CONFLICT (id) DO UPDATE, and Postgres checks `sources`'
// NOT NULL columns (name, slug, url, rss_url, bias) on the proposed row
// BEFORE the conflict arbiter, so an id + five-column payload fails with
// 23502 every time. Errors are logged and swallowed, same discipline as
// `recordIngestCycle` below -- a fetch-state write failure must never fail
// (or re-fail) the cycle.
async function persistSourceFetchState(
  supabase: ReturnType<typeof createServiceClient>,
  updates: Map<string, SourceFetchState>,
): Promise<void> {
  if (updates.size === 0) return;
  const rows = [...updates.entries()].map(([id, state]) => ({ id, ...state }));
  try {
    const { error } = await supabase.rpc("ingest_set_source_fetch_state", {
      p_rows: rows,
    });
    if (error) {
      console.error(`[ingest] source fetch-state write failed: ${error.message}`);
    }
  } catch (err) {
    console.error("[ingest] source fetch-state write threw", err);
  }
}

// Copies the current fetch-state updates and clears the map in the same
// tick, so a flush can hand off a stable snapshot to `persistSourceFetchState`
// while other fetch-pool workers keep calling `updates.set(...)` on the
// original map without racing the copy (migration 041 F3).
function drainFetchState(
  updates: Map<string, SourceFetchState>,
): Map<string, SourceFetchState> {
  const snapshot = new Map(updates);
  updates.clear();
  return snapshot;
}

// Flushes fetch-state validators mid-cycle once enough have piled up, so a
// cycle killed by 546 WORKER_RESOURCE_LIMIT (which skips the cycle-end
// `finally` entirely) still leaves the sources fetched so far bootstrapped
// for the next cycle instead of discarding all of them (migration 041 F3 —
// the task's own production fact is that most cycles never reach
// `finally`). Called from inside the fetch pool after every
// `fetchStateUpdates.set(...)`, so in steady state (few sources changed)
// this never fires and the cycle-end flush after `runPool` does the one
// real write, matching the "exactly one write" cycle contract.
async function maybeFlushFetchState(
  supabase: ReturnType<typeof createServiceClient>,
  updates: Map<string, SourceFetchState>,
  threshold = FETCH_CONCURRENCY,
): Promise<void> {
  if (updates.size < threshold) return;
  await persistSourceFetchState(supabase, drainFetchState(updates));
}

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
    dedupedInBatch: 0,
    durationMs: 0,
  };
  // Populated per attempted source during the fetch pool below; persisted
  // in the `finally` regardless of how `runCycleBody` exits (migration 041).
  const fetchStateUpdates = new Map<string, SourceFetchState>();

  // The `finally` below fires on every exit from this point on — the two
  // early returns, the final return, and any throw (including the
  // `sourcesError` throw right after this block) — so `sources` and
  // `ingest_cycles` each get exactly one best-effort write per invocation
  // on both the success and the failure path (product decision for
  // migration 039, extended to fetch-state persistence in 041).
  try {
    return await runCycleBody(
      supabase,
      startedAt,
      deadline,
      fetchDeadline,
      stats,
      fetchStateUpdates,
    );
  } finally {
    await persistSourceFetchState(supabase, fetchStateUpdates);
    await recordIngestCycle(supabase, startedAt, stats);
  }
}

async function runCycleBody(
  supabase: ReturnType<typeof createServiceClient>,
  startedAt: number,
  deadline: number,
  fetchDeadline: number,
  stats: CycleStats,
  fetchStateUpdates: Map<string, SourceFetchState>,
): Promise<CycleStats> {
  const { data: sources, error: sourcesError } = await supabase
    .from("sources")
    .select(
      "id, name, slug, url, rss_url, fetch_etag, fetch_last_modified, fetch_body_hash, fetch_last_status, fetch_last_at",
    )
    .eq("active", true)
    .order("slug");

  if (sourcesError) {
    stats.durationMs = Date.now() - startedAt;
    throw new Error(`fetch sources failed: ${sourcesError.message}`);
  }
  const liveSources = (sources ?? []) as SourceRow[];
  stats.sources = liveSources.length;
  if (liveSources.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    console.log("[ingest] cycle", JSON.stringify({ ...stats }));
    return stats;
  }

  // Hydrate the module-scope conditionalCache from what we persisted last
  // cycle so the first fetch after a cold start (empty Map) still sends
  // If-None-Match / If-Modified-Since instead of re-fetching every feed
  // from scratch (migration 041). Skip sources the cache already knows —
  // a warm instance's in-memory state is always at least as fresh as the
  // database, since we write the database from that same state.
  for (const source of liveSources) {
    if (conditionalCache.has(source.id)) continue;
    if (source.fetch_etag || source.fetch_last_modified) {
      conditionalCache.set(source.id, {
        etag: source.fetch_etag ?? undefined,
        lastModified: source.fetch_last_modified ?? undefined,
      });
    }
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
        knownBodyHash: source.fetch_body_hash ?? undefined,
      });

      if (result.error) {
        // A parse error can still land on a 2xx response (fetcher.ts
        // returns etag/lastModified/bodyHash alongside `error` in that
        // case) — pass `fresh` then so a warm instance's memory and the
        // DB agree on the validators that produced this unparseable body,
        // instead of the DB replaying a stale ETag that gets a 200 (and
        // another parse failure) every cycle while memory already moved on.
        stats.failed++;
        console.error(`[ingest] ${source.slug} fetch failed: ${result.error}`);
        const isParseError2xx = result.status >= 200 && result.status < 300;
        fetchStateUpdates.set(
          source.id,
          buildFetchStateUpdate(
            source,
            result.status,
            isParseError2xx
              ? {
                  etag: result.etag ?? source.fetch_etag,
                  lastModified: result.lastModified ?? source.fetch_last_modified,
                  bodyHash: result.bodyHash ?? source.fetch_body_hash,
                }
              : undefined,
          ),
        );
        return;
      }
      if (result.notModified) {
        // Covers both an actual 304 and the fetcher's pre-parse body-hash
        // short-circuit (migration 041) — either way nothing was parsed,
        // but the fetcher may still have fresh validators worth keeping.
        stats.notModified++;
        fetchStateUpdates.set(
          source.id,
          buildFetchStateUpdate(source, result.status, {
            etag: result.etag ?? source.fetch_etag,
            lastModified: result.lastModified ?? source.fetch_last_modified,
            bodyHash: result.bodyHash ?? source.fetch_body_hash,
          }),
        );
        await maybeFlushFetchState(supabase, fetchStateUpdates);
        return;
      }

      // 2xx with a body the fetcher actually parsed. Set-only-when-present:
      // a response that omits ETag/Last-Modified this time must not blank
      // out a validator we already had (migration 041 F4) — mirrors the
      // fetcher's own cache.set, which only ever writes headers that were
      // actually present.
      fetchStateUpdates.set(
        source.id,
        buildFetchStateUpdate(source, result.status, {
          etag: result.etag ?? source.fetch_etag,
          lastModified: result.lastModified ?? source.fetch_last_modified,
          bodyHash: result.bodyHash ?? source.fetch_body_hash,
        }),
      );
      await maybeFlushFetchState(supabase, fetchStateUpdates);

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

  // Flush whatever fetch-state accumulated during the pool right away
  // (migration 041 F3) rather than waiting for the cycle-end `finally` —
  // the finally never runs on a 546 WORKER_RESOURCE_LIMIT kill, which the
  // task's own production data says is most cycles. This is normally the
  // ONE write for the whole cycle; the `finally`'s own
  // `persistSourceFetchState` call sees an already-drained (empty) map and
  // no-ops, so the "exactly one write" cycle contract still holds in the
  // steady-state / test-fixture case (a handful of sources, well under
  // `maybeFlushFetchState`'s in-pool threshold).
  await persistSourceFetchState(supabase, drainFetchState(fetchStateUpdates));

  // Single batched upsert at cycle end. `ignoreDuplicates: true` against the
  // `url` UNIQUE constraint preserves the legacy "first insert wins" semantic
  // while the `(source_id, content_hash)` UNIQUE constraint (migration 013)
  // is the backstop for any seen-set miss. The AFTER INSERT trigger from
  // migration 025 fans queue work for every truly inserted row.
  if (allRows.length > 0 && Date.now() <= deadline) {
    for (let i = 0; i < allRows.length; i += UPSERT_BATCH) {
      if (Date.now() > deadline) break;
      const rawChunk = allRows.slice(i, i + UPSERT_BATCH);
      // Drop same-(source_id, content_hash) repeats before they can hit
      // `articles_source_content_hash_key` — covers both the batched
      // upsert below and its per-row fallback in one pass (migration 041).
      const { rows: intraDeduped, deduped: intraDeduplicated } =
        dedupeBySourceContentHash(rawChunk);
      // Then drop rows whose (source_id, content_hash) pair is already
      // sitting in `articles` under a different `url` (migration 041 F2) —
      // the actual production 23505, which the intra-cycle check above
      // cannot see.
      const { rows: chunk, dropped: crossDeduplicated } =
        await dropExistingSourceContentHashRows(supabase, intraDeduped);
      const deduped = intraDeduplicated + crossDeduplicated;
      if (deduped > 0) {
        stats.dedupedInBatch += deduped;
        console.log(
          `[ingest] deduped ${deduped} row(s) sharing (source_id, content_hash) in chunk ${i}-${i + rawChunk.length}`,
        );
      }
      // Both dedupe passes together removed everything in this chunk —
      // skip the upsert call entirely rather than sending an empty batch.
      if (chunk.length === 0) continue;
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
