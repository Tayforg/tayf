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
//      can't see that constraint). A third check drops "twins": a re-polled
//      item whose `source_article_key` (the numeric id in its url, migration
//      113) is already stored for the same source under a DIFFERENT url -- an
//      outlet that edits a headline publishes the same article under a new
//      slug, and that used to become a second row. The twin is not inserted;
//      its new headline goes through the title-version path instead. The
//      cycle reports two counters for it: `twinsDroppedStored` (the real twin
//      prevention) and `twinsDroppedIntraFeed` (the same key twice in one feed,
//      re-counted on every re-parse of a long feed). The
//      `AFTER INSERT ON articles` trigger (migration 025) takes over from here
//      to enqueue `cluster_work` and `image_backfill` messages.
//   5. Persists per-source fetch state. The fresh validators (ETag,
//      Last-Modified, body hash) of a source that produced rows are committed
//      only after all its rows were upserted, deduped or skipped as already
//      stored (silent-feeds): a feed whose rows were starved by the deadline
//      or failed must be re-offered next cycle, not answered with a 304.
//      Feed freshness (migration 119) rides along: the newest item date the feed
//      itself reports and its item count, read from the raw parsed items (see
//      _shared/rss/feed-freshness.ts). It describes the feed, not row
//      durability, so it is written even when the validators are withheld, and
//      never on a 304, a body-hash hit, a failure or a deferred parse (the
//      stored values stay). A source whose count is still NULL is bootstrapped
//      once: no conditional request, no body-hash short-circuit, one parse (a
//      frozen feed with a byte-identical body is otherwise never parsed again).
//
// CPU budget: the platform kills an invocation that burns too much CPU (HTTP
// 546, reason CPUTime) and a killed cycle loses everything it fetched. The CPU
// of a cycle is the decode + XML parse + normalise of the feeds that CHANGED,
// so a cycle parses at most MAX_PARSES_PER_CYCLE of them and
// PARSE_BUDGET_BYTES of body (see the constants below); the rest are
// deferred -- no rows, no fetch-state write -- and go first in the next cycle.
//
// Wall-clock budget: 60 s (the Edge Functions hard ceiling is 400 s). We
// stay well under because the 16-way pool keeps the slowest tail fetch
// from blocking the cycle, and the fetch pool stops 10 s early so rows
// that were fetched and normalized always get a write window. On
// per-source failure we just log and move on; transient outlet outages
// must not poison the cycle.

import { fetchFeed } from "../_shared/rss/fetcher.ts";
import type { RssSource } from "../_shared/rss/fetcher.ts";
import { computeFeedFreshness, storableItemDate } from "../_shared/rss/feed-freshness.ts";
import type { FeedFreshness } from "../_shared/rss/feed-freshness.ts";
import type { NormalizedArticle } from "../_shared/rss/normalize.ts";
import { canonicalizeUrl, normalizeArticles } from "../_shared/rss/normalize.ts";
import { sourceArticleKeyFor } from "../_shared/rss/article-key.ts";
import {
  isQuarantined,
  nextQuarantineState,
  QUARANTINE_AFTER_FAILURES,
} from "../_shared/rss/quarantine.ts";
import {
  createParseBudget,
  groupChunkBySource,
  interleaveBySource,
  prioritizeIds,
  rotateForCycle,
  upsertWithBisect,
} from "./order.ts";
import type { BisectUpsertResult } from "./order.ts";
import { FETCH_STATE_WRITE_MAX_CALLS, isRowScopedPgError } from "./fetch-state.ts";
import { collectSourceIds, partitionWithRowErrorGrace } from "./settle.ts";
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
// Rows-per-chunk cap for `dropExistingSourceContentHashRows`'s
// (source_id, content_hash) lookup -- same bound as `TITLE_LOOKUP_BATCH`
// below, for the same reason: a single `.in(...)` over hundreds of hashes
// x source ids produces a query string that silently degrades ("drop
// nothing") once it's long enough to trip a proxy's request-line limit
// (ingest-fixes / migration 074 evidence: ~25 KB for 500 hashes x 118
// source ids observed in production).
const PREFILTER_CHUNK = 100;
// How far back a stored row can make a re-polled item a "twin" (same source,
// same `source_article_key`, different url). A headline edit shows up in the
// feed within hours; a week keeps the lookup on recent index pages only and
// bounds the cost (the lookup rides the partial index of migration 113).
const TWIN_WINDOW_MS = 7 * 24 * 3_600_000;
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
// Parse budget (CPUTime kills)
// ---------------------------------------------------------------------------
//
// Measured with a scratch Deno script (not committed) on a synthetic
// 300-item feed of about 2.6 to 2.8 MB, median of 8 warm runs on the dev
// machine; the per-MB cost depends on the feed's shape:
//
//   stage                      CDATA-heavy   entity-escaped   many small elements
//   decodeRssBody                1.3 ms/MB       1.3 ms/MB          1.0 ms/MB
//   fast-xml-parser (fetcher)    1.9 ms/MB      11.1 ms/MB         36.4 ms/MB
//   item mapping + cleanFeedDate 0.3 ms/MB       0.2 ms/MB          0.3 ms/MB
//   normalizeArticles (300)     13.8 ms/MB      13.0 ms/MB         10.5 ms/MB
//   total per feed              17.3 ms/MB      25.7 ms/MB         48.1 ms/MB
//
// interleaveBySource over 5,000 rows takes 1.4 to 1.8 ms once per cycle, so it
// is not a hot loop. Parse + normalise is where the CPU goes. The worst shape
// (48 ms/MB) puts about 800 ms of CPU at 16.6 MB; the byte budget is the
// smaller of that, rounded down to 0.5 MB, and the 8 MB feed-size cap
// (DEFAULT_MAX_BYTES in the fetcher), i.e. 8_000_000. The Edge runtime is
// slower than the dev machine; the parse-count cap below is the tighter bound
// for the many-small-feeds case that dominates in production.
//
// Why 55 parses (a data-derived number, not a round one). `ingest_cycles`, the
// 3 days to 2026-10-23, 1,328 finished cycles; `fetched` there is the number
// of changed feeds a cycle parsed (a 304 or a body-hash hit is `notModified`):
//   p50 45, p90 55, p99 71, max 78; hours 06-08 UTC: p50 52, p90 68.
// Cycles that were killed (546) write no row, so their load is not in that
// data. Counting the missing ones against the 60 expected per hour, the share
// is highest where the tail is longest (hours 07-09 and 13 UTC: p90 62 to 69,
// 15 to 33% missing) and under 9% wherever p90 is 58 or less. A cap of 40
// would sit BELOW the median load: it would have deferred 74% of the cycles
// (6.8 feeds on average, 14.4 at 06-08 UTC, where every cycle exceeds 40), so
// deferral would be the steady state and every deferred feed would wait at
// least one 3-minute cycle at peak news hours.
// Replaying the same cycles against a cap of 55 defers about 10% of them (0.8
// feeds on average, 2.6 at 06-08 UTC, 30% of the cycles there): only the tail
// above p90 is trimmed. Expect that, not 0: `parseDeferred` is non-zero in a
// few cycles an hour and usually drains next cycle because deferred feeds go
// first (`parseDeferredMaxStreak` shows a feed that waits longer). Tune without a
// deploy with INGEST_MAX_PARSES_PER_CYCLE: lower it if 546s persist, raise it
// if deferral stays high while 546s are gone.
// Both limits can be overridden per deployment without a code change.
export const MAX_PARSES_PER_CYCLE = 55;
export const PARSE_BUDGET_BYTES = 8_000_000;

/**
 * Reads a positive-integer environment override. Anything else (unset, empty,
 * zero, negative, fractional, a suffix, an exponent, hex, a number beyond the
 * safe-integer range) falls back to `fallback`, so a typo in a deployment
 * secret can never disable or zero the budget.
 */
export function positiveIntEnv(raw: string | undefined, fallback: number): number {
  if (raw === undefined || !/^[1-9][0-9]*$/.test(raw)) return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : fallback;
}

// ---------------------------------------------------------------------------
// In-instance caches
// ---------------------------------------------------------------------------
//
// Edge Function instances pool requests for a few minutes between cold
// starts, so a `Map` declared at module scope survives across invocations.
// We use that to keep ETag / Last-Modified validators warm — the second
// poll against a healthy outlet should land on `304 Not Modified` and
// skip XML parsing entirely.
// silent-feeds: consecutive cycles a source was withheld for row errors only
// (module-level, best-effort across warm invocations; resets on cold start).
const rowErrorWithholds = new Map<string, number>();

const conditionalCache = new Map<
  string,
  { etag?: string; lastModified?: string }
>();

// Parse budget: the sources whose parse the previous cycle deferred, mapped to
// the number of consecutive cycles each has now been deferred (1 = deferred
// once). Module-level, so best-effort across warm invocations (a cold start
// simply loses the priority and the streak, and the rotation reaches the feed
// again). Copied and cleared at the start of every cycle: it only ever holds
// the NEXT cycle's priorities.
const parseDeferredIds = new Map<string, number>();

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
  fetch_fail_streak: number | null;
  fetch_quarantined_until: string | null;
  // Feed freshness (migration 119). Optional on purpose: a row read with the
  // legacy select (119 not applied yet) has neither key. `fetch_items_count ===
  // null` (strictly) means "never measured" and bootstraps the source; an
  // `undefined` one is a legacy row and never does.
  fetch_newest_item_at?: string | null;
  fetch_items_count?: number | null;
}

// The sources select. The legacy string is what ran before migration 119; the
// current one adds the two freshness columns. A database without 119 answers
// the current one with Postgres error 42703 (undefined column), and the cycle
// retries ONCE with the legacy string: a missing column must never take ingest
// down.
const SOURCES_SELECT_LEGACY =
  "id, name, slug, url, rss_url, fetch_etag, fetch_last_modified, fetch_body_hash, fetch_last_status, fetch_last_at, fetch_fail_streak, fetch_quarantined_until";
const SOURCES_SELECT = `${SOURCES_SELECT_LEGACY}, fetch_newest_item_at, fetch_items_count`;

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
          } catch (err) {
            // Safety net so one pathological row cannot kill the pool; log +
            // capture so a throwing worker is not swallowed (see _shared/sentry.ts).
            console.error(
              "[ingest] worker threw",
              (items[i] as { slug?: string }).slug ?? i,
              err,
            );
            captureException("ingest", err);
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
  // Headline changes detected on re-polled items this cycle
  // (`recordTitleVersions`, migration 056 / U-07 collection half). Same
  // "not a column on `ingest_cycles`, logged in the summary line instead"
  // discipline as `dedupedInBatch` above -- this is collection-only
  // telemetry, nothing here is published anywhere.
  titleVersions: number;
  // Sources skipped this cycle because they're still inside their
  // quarantine backoff window (migration 074) -- never reached the fetch
  // pool at all.
  quarantined: number;
  // Chunk failures from the (source_id, content_hash) pre-filter lookup
  // (`dropExistingSourceContentHashRows`) -- a failing chunk degrades only
  // itself (its rows are kept, not dropped) and increments this counter.
  // Persisted on `ingest_cycles.prefilter_errors` (migration 074).
  prefilterErrors: number;
  // Outlet headline write-backs applied via the `apply_article_title_edits`
  // RPC this cycle (migration 074, decision (b): write-back at ingest).
  titleWriteBacks: number;
  // ingest-health: fetches whose 2xx body had none of the recognised feed
  // roots (an HTML/plain-text/404 body). Already counted in `failed` too --
  // this breaks that failure reason out so it's visible without grepping logs.
  notAFeed: number;
  // ingest-health: items whose (isoDate ?? pubDate) was absent or still
  // unparseable after `cleanFeedDate` -- fetch time was used instead, but
  // flagged here (and in the per-source log line) rather than silently.
  dateFallbacks: number;
  // ingest-health: rows never attempted this cycle because
  // `upsertWithBisect` hit the deadline mid-chunk, PLUS every row of a
  // whole upsert chunk never reached at all because the outer loop itself
  // hit the deadline first. The direct starvation signal -- distinct from
  // `rowErrors`, which only counts rows that were attempted and individually
  // failed.
  upsertSkipped: number;
  // silent-feeds: sources whose fresh etag/last-modified/body-hash were NOT
  // saved this cycle because at least one of their rows was skipped or
  // errored (the old validators are kept so the feed is re-offered). Summary
  // line and HTTP JSON only: there is no `ingest_cycles` column for it.
  validatorsWithheld: number;
  // Twin-articles (migration 113). Summary line and HTTP JSON only: there is
  // no `ingest_cycles` column for any of the three counters below.
  //
  // `twinsDroppedStored`: the key is already stored for the source under
  // another url within the 7-day window (a headline edit). This is the real
  // twin prevention of #128.
  twinsDroppedStored: number;
  // `twinsDroppedIntraFeed`: a later item of the same feed with the same key;
  // the first one stands. This check runs before any stored lookup, so a long
  // feed that is parsed again re-counts pairs that are already stored. That is
  // why it is high at night and is not a #128 signal.
  twinsDroppedIntraFeed: number;
  // `twinsDropped`: the sum of the two above. It stays for one release for
  // dashboards and log queries and goes in the next ingest release.
  twinsDropped: number;
  // Parse budget: changed feeds this cycle refused a parse because the cycle
  // already used its MAX_PARSES_PER_CYCLE / PARSE_BUDGET_BYTES. Not failures:
  // they are retried first next cycle. Summary line and HTTP JSON only.
  parseDeferred: number;
  // The longest run of consecutive cycles any feed has been deferred, counting
  // this one (0 when nothing was deferred): starvation made visible. Best
  // effort across warm invocations, like the priority set. Summary line and
  // HTTP JSON only.
  parseDeferredMaxStreak: number;
  // Body bytes of the feeds this cycle admitted to a parse. Summary and HTTP
  // JSON only: there is no `ingest_cycles` column for it.
  parsedBytes: number;
  // Feed freshness (migration 119): sources parsed this cycle because their
  // fetch_items_count was still NULL (the one-time bootstrap). Summary line and
  // HTTP JSON only: there is no `ingest_cycles` column for it.
  freshnessBootstraps: number;
  durationMs: number;
}

// The normaliser computes a canonical form of `url` internally (for
// category classification) but the `NormalizedArticle` it returns only
// carries the raw absolute `url`. We recompute the canonical form here
// (same pure `canonicalizeUrl` the normaliser uses) so it can ride along
// in the same upsert as an additive `canonical_url` column (migration 039)
// without changing the normaliser's public shape.
//
// `source_article_key` (migration 113) rides in the same upsert: the numeric
// article id the outlet put in the url (null when the url has none, or for the
// sources in ARTICLE_KEY_EXCLUDED_SLUGS), computed by the same pure
// `sourceArticleKeyFor` the SQL twin `public.source_article_key` mirrors.
type IngestArticleRow = NormalizedArticle & {
  canonical_url: string | null;
  source_article_key: string | null;
};

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
// Looks up one PREFILTER_CHUNK-sized slice of `rows`' (source_id,
// content_hash) pairs against `articles`. A failing lookup degrades ONLY
// this slice -- its rows are kept (not dropped) and the caller's
// `lookupErrors` counter is incremented -- so one bad chunk can never mask
// or block the rest of the pre-filter (migration 074 §4).
async function dropExistingSourceContentHashRowsChunk(
  supabase: ReturnType<typeof createServiceClient>,
  rows: readonly IngestArticleRow[],
): Promise<{ rows: IngestArticleRow[]; dropped: number; lookupErrors: number }> {
  if (rows.length === 0) return { rows: [], dropped: 0, lookupErrors: 0 };
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
      return { rows: [...rows], dropped: 0, lookupErrors: 1 };
    }
    existingPairs = (data ?? []) as Array<{ source_id: string; content_hash: string }>;
  } catch (err) {
    console.error("[ingest] existing (source_id, content_hash) lookup threw", err);
    return { rows: [...rows], dropped: 0, lookupErrors: 1 };
  }
  if (existingPairs.length === 0) return { rows: [...rows], dropped: 0, lookupErrors: 0 };

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
  return { rows: out, dropped, lookupErrors: 0 };
}

// Chunks `rows` by `PREFILTER_CHUNK` (migration 074 §4 -- was previously ONE
// `.in()` call over the whole batch, up to 500 rows x 118 source ids
// (~25 KB of query string), which silently degraded to "drop nothing" once
// a proxy's request-line limit was tripped). Each chunk queries only its own
// distinct source ids / hashes; a failing chunk degrades only itself.
async function dropExistingSourceContentHashRows(
  supabase: ReturnType<typeof createServiceClient>,
  rows: readonly IngestArticleRow[],
): Promise<{ rows: IngestArticleRow[]; dropped: number; lookupErrors: number }> {
  if (rows.length === 0) return { rows: [], dropped: 0, lookupErrors: 0 };
  const out: IngestArticleRow[] = [];
  let dropped = 0;
  let lookupErrors = 0;
  for (let i = 0; i < rows.length; i += PREFILTER_CHUNK) {
    const slice = rows.slice(i, i + PREFILTER_CHUNK);
    const result = await dropExistingSourceContentHashRowsChunk(supabase, slice);
    out.push(...result.rows);
    dropped += result.dropped;
    lookupErrors += result.lookupErrors;
  }
  return { rows: out, dropped, lookupErrors };
}

// ---------------------------------------------------------------------------
// Twin drop (migration 113)
// ---------------------------------------------------------------------------
//
// An outlet that edits a headline publishes the same article under a new url
// slug and keeps the numeric id its CMS put in the url. Both existing checks
// miss that: the upsert conflicts on `url` (new) and `content_hash` changes
// with the title. `source_article_key` is that id; a re-polled item whose
// (source_id, key) is already stored under a DIFFERENT url is a twin of the
// stored article.
//
// Only keyed rows are looked up (a null key has nothing to match), in slices
// of PREFILTER_CHUNK like the content-hash pre-filter, against the partial
// index of migration 113. As there, `.in()` on both columns is a cross
// product, so the exact (source_id, key) pair is matched client-side. A row is
// kept when no stored row has its pair, or when ANY stored row with that pair
// has its own url (the normal re-poll: the url upsert ignores the duplicate).
// Otherwise it is a twin, and the stored article it duplicates is the match
// with the earliest created_at. A failing lookup degrades only its own slice
// (those rows are kept, fail-open) and is counted in `lookupErrors`, which
// the caller adds to `stats.prefilterErrors`.

export interface ExistingKeyedArticle {
  id: string;
  url: string;
  title: string;
  source_id: string;
  source_article_key: string;
  created_at: string;
}

export async function dropExistingSourceArticleKeyRows<
  T extends { source_id: string; url: string; source_article_key: string | null },
>(
  supabase: ReturnType<typeof createServiceClient>,
  rows: readonly T[],
  sinceIso: string,
): Promise<{
  rows: T[];
  twins: Array<{ row: T; existing: ExistingKeyedArticle }>;
  lookupErrors: number;
}> {
  const keyed = rows.filter((r) => r.source_article_key !== null);
  if (keyed.length === 0) return { rows: [...rows], twins: [], lookupErrors: 0 };

  const twinOf = new Map<T, ExistingKeyedArticle>();
  let lookupErrors = 0;
  for (let i = 0; i < keyed.length; i += PREFILTER_CHUNK) {
    const slice = keyed.slice(i, i + PREFILTER_CHUNK);
    const sourceIds = [...new Set(slice.map((r) => r.source_id))];
    const keys = [...new Set(slice.map((r) => r.source_article_key as string))];

    let found: ExistingKeyedArticle[];
    try {
      const { data, error } = await supabase
        .from("articles")
        .select("id, url, title, source_id, source_article_key, created_at")
        .in("source_id", sourceIds)
        .in("source_article_key", keys)
        .gte("created_at", sinceIso);
      if (error) {
        console.error(`[ingest] existing (source_id, source_article_key) lookup failed: ${error.message}`);
        lookupErrors++;
        continue;
      }
      found = (data ?? []) as ExistingKeyedArticle[];
    } catch (err) {
      console.error("[ingest] existing (source_id, source_article_key) lookup threw", err);
      lookupErrors++;
      continue;
    }
    if (found.length === 0) continue;

    const byPair = new Map<string, ExistingKeyedArticle[]>();
    for (const e of found) {
      const pair = `${e.source_id}\x1f${e.source_article_key}`;
      const list = byPair.get(pair);
      if (list) list.push(e);
      else byPair.set(pair, [e]);
    }
    for (const row of slice) {
      const matches = byPair.get(`${row.source_id}\x1f${row.source_article_key}`);
      if (!matches || matches.length === 0) continue;
      if (matches.some((m) => m.url === row.url)) continue;
      let earliest = matches[0] as ExistingKeyedArticle;
      for (const m of matches) {
        if (Date.parse(m.created_at) < Date.parse(earliest.created_at)) earliest = m;
      }
      twinOf.set(row, earliest);
    }
  }

  const kept: T[] = [];
  const twins: Array<{ row: T; existing: ExistingKeyedArticle }> = [];
  for (const row of rows) {
    const existing = twinOf.get(row);
    if (existing) twins.push({ row, existing });
    else kept.push(row);
  }
  return { rows: kept, twins, lookupErrors };
}

// ---------------------------------------------------------------------------
// Headline-version collection (migration 056, U-07 collection half)
// ---------------------------------------------------------------------------
//
// `content_hash = strictFingerprint(title, description)` (normalize.ts
// ~337), so a re-polled item whose TITLE changed produces a DIFFERENT
// content_hash. It therefore survives both `dedupeBySourceContentHash` and
// `dropExistingSourceContentHashRows` above, reaches the batched upsert
// below, and is dropped silently by
// `.upsert(chunk, { onConflict: "url", ignoreDuplicates: true })` -- the old
// title is lost with no trace. That drop stays (we are not changing upsert
// semantics) -- this helper only records the delta BEFORE the upsert runs,
// so the row it reads back still carries the pre-cycle title.
//
// Collection only: `article_title_versions` (migration 056) has RLS
// enabled with NO select policy -- nothing recorded here is published
// anywhere in this PR (U-07's own risk note: republishing a headline an
// outlet removed under a court order or a KVKK request invites the same
// order against Tayf's URL -- Law 5651 Art. 9).
//
// Bounded to the chunk: one `select` restricted to this chunk's urls, one
// `insert` of whatever changed -- never a full-table scan, never a
// per-row query. Mirrors `dropExistingSourceContentHashRows`'s
// degrade-to-no-op discipline: any error here is logged and swallowed, and
// this function NEVER throws, so a lookup failure, an insert failure or
// any other exception costs zero articles -- it must never block, delay or
// reduce the upsert that follows it.
// Bounded to LOOKUP_BATCH urls per `.in(...)` select -- 500 full news URLs
// in one PostgREST GET query string (heavily percent-escaped) can push the
// request URI past typical proxy request-line limits, which fails the
// lookup silently (degrades to 0, per the discipline below). 100/select
// keeps every request well under that ceiling; the single insert/upsert at
// the end stays bounded to this chunk's urls either way.
const TITLE_LOOKUP_BATCH = 100;

export interface RecordTitleVersionsResult {
  titleVersions: number;
  // Outlet headline write-backs applied this chunk via the
  // `apply_article_title_edits` RPC (migration 074, decision (b)). Runs
  // INDEPENDENTLY of whether the version upsert above inserted anything --
  // it covers the A->B->A oscillation case too, since the ledger dedupes on
  // (article_id, new_title_hash) but the outlet's CURRENT headline still
  // needs writing back every time it changes.
  titleWriteBacks: number;
}

// Applies the write-back RPC for one chunk's full-title edits. FULL,
// unclamped titles, same-source only -- the word-Jaccard >= 0.2 eligibility
// gate lives ONLY in SQL (`apply_article_title_edits`), so every same-source
// title change is sent here; the DB decides whether it's a real edit or
// URL-reuse-onto-a-different-story. Never throws: any RPC failure is logged
// and swallowed, exactly like every other helper in this file.
async function applyHeadlineWriteBack(
  supabase: ReturnType<typeof createServiceClient>,
  edits: ReadonlyArray<{ article_id: string; old_title: string; new_title: string }>,
): Promise<number> {
  if (edits.length === 0) return 0;
  try {
    const { data, error } = await supabase.rpc("apply_article_title_edits", {
      p_rows: edits,
    });
    if (error) {
      console.error(`[ingest] headline write-back failed: ${error.message}`);
      return 0;
    }
    return typeof data === "number" ? data : 0;
  } catch (err) {
    console.error(
      `[ingest] headline write-back failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 0;
  }
}

// `preResolved` (migration 113): rows already matched to their stored article
// without a url lookup -- the twins `dropExistingSourceArticleKeyRows` found,
// keyed by the twin's NEW url. They seed `stored`, and only the urls not in it
// are selected, so a twin-only chunk makes no url query at all. Called with
// two arguments the behaviour is unchanged.
export async function recordTitleVersions(
  supabase: ReturnType<typeof createServiceClient>,
  chunk: readonly Pick<IngestArticleRow, "url" | "title" | "source_id">[],
  preResolved?: ReadonlyMap<string, { id: string; title: string; source_id: string }>,
): Promise<RecordTitleVersionsResult> {
  const empty: RecordTitleVersionsResult = { titleVersions: 0, titleWriteBacks: 0 };
  try {
    if (chunk.length === 0) return empty;

    const stored = new Map<
      string,
      { id: string; title: string; source_id: string }
    >(preResolved ?? []);
    const urls = chunk.map((row) => row.url).filter((url) => !stored.has(url));
    for (let j = 0; j < urls.length; j += TITLE_LOOKUP_BATCH) {
      const { data, error } = await supabase
        .from("articles")
        .select("id, url, title, source_id")
        .in("url", urls.slice(j, j + TITLE_LOOKUP_BATCH));
      if (error) {
        console.error(`[ingest] title-version lookup failed: ${error.message}`);
        return empty;
      }
      for (const row of (data ?? []) as Array<{
        id: string;
        url: string;
        title: string;
        source_id: string;
      }>) {
        stored.set(row.url, {
          id: row.id,
          title: row.title,
          source_id: row.source_id,
        });
      }
    }

    // Exact string compare after `.trim()` only -- no case/punctuation
    // normalization. A case change IS a headline change. Comparison runs
    // on the full untruncated titles; only the stored row is clamped below.
    let crossSourceCollisions = 0;
    const versions: Array<{
      article_id: string;
      source_id: string;
      old_title: string;
      new_title: string;
    }> = [];
    // FULL, unclamped titles -- fed to `applyHeadlineWriteBack` below.
    // Same detection loop as `versions` (same rows qualify: same-source,
    // trim-only-differs-doesn't-count), just without the 500-char clamp
    // `article_title_versions.old_title`/`new_title` apply.
    const edits: Array<{ article_id: string; old_title: string; new_title: string }> = [];
    for (const row of chunk) {
      const existing = stored.get(row.url);
      if (!existing) continue;
      // A feed that syndicates/links another outlet's url must never have
      // its title change attributed to that other outlet's article.
      if (existing.source_id !== row.source_id) {
        crossSourceCollisions += 1;
        continue;
      }
      if (row.title.trim() === existing.title.trim()) continue;
      versions.push({
        article_id: existing.id,
        source_id: existing.source_id,
        old_title: existing.title.slice(0, 500),
        new_title: row.title.slice(0, 500),
      });
      edits.push({
        article_id: existing.id,
        old_title: existing.title,
        new_title: row.title,
      });
    }
    if (crossSourceCollisions > 0) {
      console.warn(
        `[ingest] skipped ${crossSourceCollisions} title-version row(s) whose url matched a different source_id`,
      );
    }

    if (versions.length === 0) return empty;

    // `ignoreDuplicates: true` against the (article_id, new_title_hash)
    // unique index (migration 056) means a headline that stays changed
    // across multiple 3-minute cycles is recorded once, not every cycle.
    // Run in parallel with the write-back RPC below -- the two are
    // independent (one is a ledger insert, the other mutates `articles`/
    // `clusters`), and running them serially would only cost wall clock.
    const [{ data: insertedRows, error: insertError }, titleWriteBacks] = await Promise.all([
      supabase
        .from("article_title_versions")
        .upsert(versions, {
          onConflict: "article_id,new_title_hash",
          ignoreDuplicates: true,
        })
        .select("id"),
      applyHeadlineWriteBack(supabase, edits),
    ]);
    if (insertError) {
      console.error(`[ingest] title-version insert failed: ${insertError.message}`);
      return { titleVersions: 0, titleWriteBacks };
    }
    return { titleVersions: insertedRows?.length ?? 0, titleWriteBacks };
  } catch (err) {
    console.error("[ingest] title-version recording threw", err);
    return empty;
  }
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
  fetch_fail_streak: number;
  fetch_quarantined_until: string | null;
  // Feed freshness (migration 119). PRESENT only when this cycle parsed the
  // feed; every other outcome omits both keys so the writer keeps the stored
  // pair (a key that is merely undefined would still be a key in a test double).
  fetch_newest_item_at?: string | null;
  fetch_items_count?: number | null;
}

// Builds the row to persist for one attempted source this cycle. `fresh`
// carries new validators off a 2xx response; every other outcome (network
// error, non-2xx, 304) keeps the source's existing etag/lastModified/
// bodyHash untouched and only bumps status + timestamp -- there is nothing
// new to remember when the wire didn't hand us a body.
// `ok` drives `nextQuarantineState` (migration 074): a parsed 2xx or a
// 304/body-hash "not modified" resets the streak; any `result.error`
// (including a 2xx that failed to parse) advances it and, past
// `QUARANTINE_AFTER_FAILURES`, sets an escalating `fetch_quarantined_until`.
// `freshness` (migration 119) is passed only by a cycle that parsed the feed;
// when it is absent the two freshness keys are OMITTED, not nulled.
function buildFetchStateUpdate(
  source: SourceRow,
  status: number,
  ok: boolean,
  fresh?: { etag: string | null; lastModified: string | null; bodyHash: string | null },
  freshness?: FeedFreshness,
): SourceFetchState {
  const quarantine = nextQuarantineState(source.fetch_fail_streak, ok, Date.now());
  const state: SourceFetchState = {
    fetch_etag: fresh ? fresh.etag : source.fetch_etag,
    fetch_last_modified: fresh ? fresh.lastModified : source.fetch_last_modified,
    fetch_body_hash: fresh ? fresh.bodyHash : source.fetch_body_hash,
    fetch_last_status: status,
    fetch_last_at: new Date().toISOString(),
    ...quarantine,
  };
  if (freshness) {
    // `computeFeedFreshness` already ignores implausible dates; the storable
    // bound is checked once more on the way out because Postgres refuses a
    // year-0 or negative-year timestamp for the WHOLE batch (see
    // persistSourceFetchState), and this is third-party input.
    state.fetch_newest_item_at = storableItemDate(freshness.newestItemAt);
    state.fetch_items_count = freshness.itemsCount;
  }
  return state;
}

// Best-effort persistence of updated fetch validators back onto `sources`
// so the NEXT cycle -- even one starting from a fresh cold start that wiped
// `conditionalCache` -- can hydrate straight from the database and send
// If-None-Match / If-Modified-Since on its very first fetch instead of
// re-fetching every feed cold. One batched write (the
// `ingest_set_source_fetch_state` RPC from migration 041 -- a plain
// UPDATE ... FROM jsonb_to_recordset) covers every source actually
// attempted this cycle. A batch Postgres refuses for a reason that belongs to
// one row's data (SQLSTATE class 22/23, e.g. a year-0 timestamp) is retried in
// halves, so the bad row is dropped alone instead of erasing every other
// source's validators, fail streak and freshness (migration 119); any other
// failure (timeout, connection, permission) is NOT split, and the retries are
// capped at FETCH_STATE_WRITE_MAX_CALLS. Deliberately NOT a PostgREST upsert: that is
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
  let calls = 0;
  // Set when a failure is not about a row's data: splitting would only repeat it.
  let stop = false;
  try {
    const result = await upsertWithBisect(
      rows,
      async (batch) => {
        calls++;
        try {
          const { error } = await supabase.rpc("ingest_set_source_fetch_state", {
            p_rows: batch,
          });
          if (!error) return { inserted: batch.length, error: null };
          if (!isRowScopedPgError(error.code)) stop = true;
          return { inserted: 0, error: error.message };
        } catch (err) {
          stop = true;
          return { inserted: 0, error: err instanceof Error ? err.message : String(err) };
        }
      },
      {
        isPastDeadline: () => stop || calls >= FETCH_STATE_WRITE_MAX_CALLS,
        onRowError: (row, message) =>
          console.error(`[ingest] source fetch-state write dropped source ${row.id}: ${message}`),
      },
    );
    if (result.firstError !== null) {
      console.error(
        `[ingest] source fetch-state write failed: ${result.firstError} (${calls} call(s), ${result.rowErrors + result.skipped} of ${rows.length} row(s) not written)`,
      );
    }
    if (result.skipped > 0 && !stop) {
      console.error(
        `[ingest] source fetch-state write: call cap (${FETCH_STATE_WRITE_MAX_CALLS}) reached, ${result.skipped} row(s) not written`,
      );
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
      // Migration 074: pre-filter chunk-lookup failures this cycle -- see
      // `dropExistingSourceContentHashRows`. A non-zero, non-decreasing
      // trend here (against a flat row_errors) is the acceptance signal
      // that the chunked pre-filter, not something else, drove the
      // 23505-retry rate down.
      prefilter_errors: stats.prefilterErrors,
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
    titleVersions: 0,
    quarantined: 0,
    prefilterErrors: 0,
    titleWriteBacks: 0,
    notAFeed: 0,
    dateFallbacks: 0,
    upsertSkipped: 0,
    validatorsWithheld: 0,
    twinsDroppedStored: 0,
    twinsDroppedIntraFeed: 0,
    twinsDropped: 0,
    parseDeferred: 0,
    parseDeferredMaxStreak: 0,
    parsedBytes: 0,
    freshnessBootstraps: 0,
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
  const selectActiveSources = (columns: string) =>
    supabase.from("sources").select(columns).eq("active", true).order("slug");
  let { data: sources, error: sourcesError } = await selectActiveSources(SOURCES_SELECT);
  if (sourcesError?.code === "42703") {
    // Migration 119 is not applied yet: carry on with the select that ran
    // before it (no freshness, no bootstrap). Once, never a loop.
    console.warn(
      "[ingest] sources.fetch_newest_item_at / fetch_items_count missing (migration 119 not applied?): legacy select",
    );
    ({ data: sources, error: sourcesError } = await selectActiveSources(SOURCES_SELECT_LEGACY));
  }

  if (sourcesError) {
    stats.durationMs = Date.now() - startedAt;
    throw new Error(`fetch sources failed: ${sourcesError.message}`);
  }
  const liveSources = (sources ?? []) as unknown as SourceRow[];
  stats.sources = liveSources.length;
  if (liveSources.length === 0) {
    stats.durationMs = Date.now() - startedAt;
    console.log("[ingest] cycle", JSON.stringify({ ...stats }));
    return stats;
  }

  // Skip sources still inside their quarantine backoff window (migration
  // 074, §4) -- 23 dead feeds cost ~11,000 failed fetches/day; a
  // quarantined feed spends no pool slot until `fetch_quarantined_until`
  // elapses, at which point the NEXT attempt is a "probe" that can either
  // reset the streak (a success) or re-escalate the backoff (another
  // failure).
  // ingest-health: rotate the fetch order by a startedAt-derived offset so a
  // fixed `.order("slug")` base order doesn't always place the same
  // early-alphabet sources first every cycle -- over enough 3-minute cycles
  // the rotation walks all the way around the roster.
  //
  // Parse budget: the sources the previous cycle deferred go FIRST (a stable
  // reorder of the rotated list), so a deferred feed is not starved by the
  // rotation. The module-level set is copied and cleared here; this cycle
  // refills it with its own deferrals.
  const deferredBefore = new Map(parseDeferredIds);
  const priorityIds = new Set(deferredBefore.keys());
  parseDeferredIds.clear();
  const toFetch = prioritizeIds(
    rotateForCycle(
      liveSources.filter((s) => !isQuarantined(s, startedAt)),
      startedAt,
    ),
    priorityIds,
  );
  stats.quarantined = liveSources.length - toFetch.length;
  // Read once per cycle; anything but a positive integer means the default.
  const budget = createParseBudget(
    positiveIntEnv(Deno.env.get("INGEST_MAX_PARSES_PER_CYCLE"), MAX_PARSES_PER_CYCLE),
    positiveIntEnv(Deno.env.get("INGEST_PARSE_BUDGET_BYTES"), PARSE_BUDGET_BYTES),
  );

  // Hydrate the module-scope conditionalCache from what we persisted last
  // cycle so the first fetch after a cold start (empty Map) still sends
  // If-None-Match / If-Modified-Since instead of re-fetching every feed
  // from scratch (migration 041). Skip sources the cache already knows —
  // a warm instance's in-memory state is always at least as fresh as the
  // database, since we write the database from that same state.
  for (const source of toFetch) {
    if (conditionalCache.has(source.id)) continue;
    // Feed freshness bootstrap (migration 119): a source never measured must be
    // fetched without validators once, so it is not hydrated.
    if (source.fetch_items_count === null) continue;
    if (source.fetch_etag || source.fetch_last_modified) {
      conditionalCache.set(source.id, {
        etag: source.fetch_etag ?? undefined,
        lastModified: source.fetch_last_modified ?? undefined,
      });
    }
  }

  // Twin-articles (migration 113): stored rows created before this instant
  // are not looked up. Fixed per cycle.
  const twinSinceIso = new Date(startedAt - TWIN_WINDOW_MS).toISOString();

  const allRows: IngestArticleRow[] = [];
  // Per-source intra-cycle de-dup so two section-slug variants of the same
  // article inside one feed collapse before the upsert. Keyed by
  // `${source_id}\x1f${content_hash}`.
  const seenIntraCycle = new Set<string>();
  // silent-feeds: sources that produced rows this cycle. Their fresh
  // validators are parked here (never in `fetchStateUpdates`) until the upsert
  // phase shows whether every row landed.
  const deferred = new Map<
    string,
    {
      source: SourceRow;
      status: number;
      fresh: { etag: string | null; lastModified: string | null; bodyHash: string | null };
      freshness: FeedFreshness;
    }
  >();
  // Sources with at least one row that was skipped, never attempted or failed.
  const unsettled = new Set<string>();
  // Sources with a row that failed in isolation (possibly poison): withheld
  // only for a bounded number of consecutive cycles.
  const rowFailed = new Set<string>();

  await runPool(
    toFetch,
    FETCH_CONCURRENCY,
    async (source) => {
      // Feed freshness bootstrap (migration 119): `=== null` strictly, so a
      // legacy row (the key is undefined) never bootstraps. A warm instance may
      // still hold validators for it, so they go BEFORE the snapshot below: the
      // request is unconditional and, if the parse is deferred, the next cycle
      // starts from an empty entry too.
      const bootstrap = source.fetch_items_count === null;
      if (bootstrap) conditionalCache.delete(source.id);
      // Snapshot BEFORE the call: `fetchFeed` overwrites the entry on a 2xx,
      // and a deferred source must get its previous validators back.
      const cacheBefore = conditionalCache.get(source.id);
      const cacheBeforeCopy = cacheBefore ? { ...cacheBefore } : undefined;
      const result = await fetchFeed(source, {
        conditionalCache,
        timeoutMs: FETCH_TIMEOUT_MS,
        knownBodyHash: bootstrap ? undefined : (source.fetch_body_hash ?? undefined),
        // Asked only when a changed body is about to be decoded and parsed.
        admitParse: (bodyBytes) => budget.admit(bodyBytes, priorityIds.has(source.id)),
      });

      // Parse budget: checked FIRST. The fetcher refused to decode and parse
      // this feed's changed body, so there is nothing to record about it: no
      // fetch-state entry (its stored validators, status and fail streak stay
      // as they were, and it is neither a failure nor a not-modified), the
      // conditional cache back to its pre-request value (the fetcher stamped
      // this response's validators on it; keeping them would answer the next
      // poll with a 304 for a body that was never read), and a place at the
      // front of the next cycle.
      if (result.parseDeferred) {
        stats.parseDeferred++;
        const streak = (deferredBefore.get(source.id) ?? 0) + 1;
        parseDeferredIds.set(source.id, streak);
        if (streak > stats.parseDeferredMaxStreak) stats.parseDeferredMaxStreak = streak;
        if (cacheBeforeCopy) conditionalCache.set(source.id, cacheBeforeCopy);
        else conditionalCache.delete(source.id);
        return;
      }

      if (result.error) {
        // A parse error can still land on a 2xx response (fetcher.ts
        // returns etag/lastModified/bodyHash alongside `error` in that
        // case) — pass `fresh` then so a warm instance's memory and the
        // DB agree on the validators that produced this unparseable body,
        // instead of the DB replaying a stale ETag that gets a 200 (and
        // another parse failure) every cycle while memory already moved on.
        stats.failed++;
        // ingest-health: an HTML/plain-text/404 body -- already counted in
        // `failed` above; broken out separately so this failure reason is
        // visible without grepping logs (and reaches quarantine the same
        // way any other fetch failure does).
        if (result.notAFeed) stats.notAFeed++;
        console.error(`[ingest] ${source.slug} fetch failed: ${result.error}`);
        const isParseError2xx = result.status >= 200 && result.status < 300;
        const failState = buildFetchStateUpdate(
          source,
          result.status,
          false,
          isParseError2xx
            ? {
                etag: result.etag ?? source.fetch_etag,
                lastModified: result.lastModified ?? source.fetch_last_modified,
                bodyHash: result.bodyHash ?? source.fetch_body_hash,
              }
            : undefined,
        );
        fetchStateUpdates.set(source.id, failState);
        if (
          failState.fetch_quarantined_until &&
          failState.fetch_fail_streak === QUARANTINE_AFTER_FAILURES
        ) {
          // Log once, right when a source crosses into quarantine -- never
          // the url/title, just the slug/streak/until (migration 074 §4).
          console.log(
            `[ingest] quarantined ${source.slug} after ${failState.fetch_fail_streak} consecutive failures until ${failState.fetch_quarantined_until}`,
          );
        }
        return;
      }
      if (result.notModified) {
        // Covers both an actual 304 and the fetcher's pre-parse body-hash
        // short-circuit (migration 041) — either way nothing was parsed,
        // but the fetcher may still have fresh validators worth keeping.
        stats.notModified++;
        fetchStateUpdates.set(
          source.id,
          buildFetchStateUpdate(source, result.status, true, {
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
      const fresh = {
        etag: result.etag ?? source.fetch_etag,
        lastModified: result.lastModified ?? source.fetch_last_modified,
        bodyHash: result.bodyHash ?? source.fetch_body_hash,
      };

      stats.fetched++;
      // ingest-health: items whose date fetcher.ts couldn't clean into
      // something parseable -- fetch time is still used as the fallback
      // (unchanged), but flagged here once per source per cycle rather than
      // silently, so a source that quietly stopped emitting parseable dates
      // shows up in the logs and the cycle JSON instead of only in a
      // clustered-by-fetch-time symptom days later.
      if (result.dateFallbacks) {
        stats.dateFallbacks += result.dateFallbacks;
        console.log(
          `[ingest] ${source.slug}: ${result.dateFallbacks} item(s) without a parseable date — fetch time used (sample: ${JSON.stringify(result.dateFallbackSample)})`,
        );
      }
      // One nowMs per fetched source -- every item off THIS feed clamps and
      // (for cnn-turk) corrects against the same instant (migration 074).
      const sourceNowMs = Date.now();
      // Feed freshness (migration 119): the newest item date the feed reports
      // and its raw item count, off the parsed items (never the normalised
      // published_at, which falls back to "now" for an unparseable date).
      const freshness = computeFeedFreshness(result.items, sourceNowMs, source.slug);
      if (bootstrap) stats.freshnessBootstraps++;
      // A bootstrap whose body is the one already stored: its rows are durable
      // (the silent-feeds contract saved this hash only after they landed), so
      // push none. Only the freshness is new.
      const bootstrapUnchanged =
        bootstrap && !!result.bodyHash && result.bodyHash === source.fetch_body_hash;
      const normalized = bootstrapUnchanged
        ? []
        : normalizeArticles(source, result.items, sourceNowMs);
      stats.itemsNormalized += normalized.length;

      let pushed = 0;
      let intraFeedTwins = 0;
      for (const row of normalized) {
        const key = `${row.source_id}\x1f${row.content_hash}`;
        if (seenIntraCycle.has(key)) continue;
        seenIntraCycle.add(key);
        // Twin-articles (migration 113): the outlet's numeric article id from
        // the url. A second row of this feed with the same key is the same
        // article under an edited headline (new slug): skip it, the first one
        // stands. Null (no id in the url, or an excluded slug) is never
        // tracked, so it can never merge two rows.
        const articleKey = sourceArticleKeyFor(source.slug, row.url);
        if (articleKey !== null) {
          const twinKey = `${row.source_id}\x1fk\x1f${articleKey}`;
          if (seenIntraCycle.has(twinKey)) {
            stats.twinsDroppedIntraFeed++;
            stats.twinsDropped++;
            intraFeedTwins++;
            continue;
          }
          seenIntraCycle.add(twinKey);
        }
        // Additive: canonicalizeUrl never throws (it catches internally and
        // falls back to the raw URL), so this is always a string in
        // practice — the column stays nullable for any future producer
        // that can't compute one.
        allRows.push({
          ...row,
          canonical_url: canonicalizeUrl(row.url, source.slug),
          source_article_key: articleKey,
        });
        pushed++;
      }
      if (intraFeedTwins > 0) {
        // Slug and count only: never a url or a headline.
        console.log(`[ingest] ${source.slug}: ${intraFeedTwins} intra-feed twin(s)`);
      }

      if (pushed === 0) {
        // Nothing to lose: no row of this feed can be starved, so the fresh
        // validators are safe to save right away.
        fetchStateUpdates.set(
          source.id,
          buildFetchStateUpdate(source, result.status, true, fresh, freshness),
        );
        await maybeFlushFetchState(supabase, fetchStateUpdates);
      } else {
        // silent-feeds: saving these validators now (the old behaviour) means
        // a starved or failed upsert leaves the feed answered with a 304 /
        // body-hash hit forever while its rows never landed. Park them, and
        // put the module cache back as it was before `fetchFeed` stamped the
        // fresh values on it; both are committed once the rows are durable.
        deferred.set(source.id, { source, status: result.status, fresh, freshness });
        if (cacheBeforeCopy) conditionalCache.set(source.id, cacheBeforeCopy);
        else conditionalCache.delete(source.id);
      }
    },
    fetchDeadline,
  );
  stats.parsedBytes = budget.bytes;
  if (stats.parseDeferred > 0) {
    // Count only: never a url or a headline.
    console.log(
      `[ingest] parse budget: deferred ${stats.parseDeferred} changed feed(s) to the next cycle (parsed ${budget.parses}, ${budget.bytes} bytes, longest deferral streak ${stats.parseDeferredMaxStreak})`,
    );
  }

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

  // Upsert at cycle end, chunked to UPSERT_BATCH. `ignoreDuplicates: true`
  // against the `url` UNIQUE constraint preserves the legacy "first insert
  // wins" semantic while the `(source_id, content_hash)` UNIQUE constraint
  // (migration 013) is the backstop for any seen-set miss. The AFTER INSERT
  // trigger from migration 025 fans queue work for every truly inserted row.
  //
  // ingest-health: chunks are cut from `interleaveBySource(allRows)`, not
  // `allRows` itself -- the fetch pool appends rows in fetch-completion
  // order, so a fixed slug-ordered fetch would otherwise put every
  // early-alphabet source's rows in the first chunk and every late-alphabet
  // source's rows in the last, meaning a deadline cut starves whole
  // late-alphabet sources instead of trimming everyone's oldest items
  // evenly. Interleaved, the first chunk holds every source's NEWEST items.
  if (allRows.length > 0 && Date.now() > deadline) {
    // The fetch pool overran: the whole upsert loop is skipped. Count it (it
    // used to be silent) and mark every source involved as unsettled.
    stats.upsertSkipped += allRows.length;
    collectSourceIds(allRows, unsettled);
  } else if (allRows.length > 0) {
    const interleaved = interleaveBySource(allRows);
    for (let i = 0; i < interleaved.length; i += UPSERT_BATCH) {
      if (Date.now() > deadline) {
        // The deadline hit before this (and every later) chunk was even
        // attempted -- direct starvation signal, distinct from a
        // bisect-level `skipped` count below.
        stats.upsertSkipped += interleaved.length - i;
        collectSourceIds(interleaved.slice(i), unsettled);
        break;
      }
      const slice = interleaved.slice(i, i + UPSERT_BATCH);
      // Re-group this interleaved slice by source_id BEFORE the pre-filter
      // below: an interleaved chunk can carry up to `slice.length` distinct
      // source ids (one per row in the worst case), which would otherwise
      // blow up `dropExistingSourceContentHashRows`'s `.in("source_id", ids)`
      // query string (the same migration 074 proxy-limit failure mode);
      // grouped, each PREFILTER_CHUNK-sized slice spans far fewer sources.
      const rawChunk = groupChunkBySource(slice);
      // Drop same-(source_id, content_hash) repeats before they can hit
      // `articles_source_content_hash_key` — covers both the upsert below
      // and its bisect fallback in one pass (migration 041).
      const { rows: intraDeduped, deduped: intraDeduplicated } =
        dedupeBySourceContentHash(rawChunk);
      // Then drop rows whose (source_id, content_hash) pair is already
      // sitting in `articles` under a different `url` (migration 041 F2) —
      // the actual production 23505, which the intra-cycle check above
      // cannot see.
      const {
        rows: afterContentHash,
        dropped: crossDeduplicated,
        lookupErrors,
      } = await dropExistingSourceContentHashRows(supabase, intraDeduped);
      // Then the twins (migration 113): a row whose (source_id,
      // source_article_key) is already stored under a different url is the
      // same article under an edited headline -- it is not inserted.
      const {
        rows: chunk,
        twins,
        lookupErrors: twinLookupErrors,
      } = await dropExistingSourceArticleKeyRows(supabase, afterContentHash, twinSinceIso);
      const deduped = intraDeduplicated + crossDeduplicated;
      if (deduped > 0) {
        stats.dedupedInBatch += deduped;
        console.log(
          `[ingest] deduped ${deduped} row(s) sharing (source_id, content_hash) in chunk ${i}-${i + rawChunk.length}`,
        );
      }
      if (lookupErrors + twinLookupErrors > 0) {
        stats.prefilterErrors += lookupErrors + twinLookupErrors;
      }
      if (twins.length > 0) {
        stats.twinsDroppedStored += twins.length;
        stats.twinsDropped += twins.length;
        // Count only: never the url or the headline.
        console.log(
          `[ingest] dropped ${twins.length} twin row(s) sharing (source_id, source_article_key) with a stored article in chunk ${i}-${i + rawChunk.length}`,
        );
      }
      // The dedupe passes and the twin drop together removed everything in
      // this chunk -- skip the upsert call entirely rather than sending an
      // empty batch. A chunk of twins only still goes on: their new headlines
      // are recorded below.
      if (chunk.length === 0 && twins.length === 0) continue;
      // Twins count as stored: they never reach the upsert, so their source
      // settles and its validators commit. Their stored articles were already
      // resolved by the key lookup; hand them to `recordTitleVersions` so the
      // edited headline is recorded without another url select.
      const twinRows = twins.map((t) => t.row);
      const preResolved = new Map(
        twins.map((t) => [
          t.row.url,
          { id: t.existing.id, title: t.existing.title, source_id: t.existing.source_id },
        ]),
      );
      // ingest-health: bisecting fallback replaces the old
      // batched-upsert-then-per-row-retry -- a single poisoned row now costs
      // at most `1 + 2*ceil(log2(chunk.length))` upsert calls instead of up to
      // `chunk.length + 1`. `isPastDeadline` is checked per popped batch, so a
      // chunk still mid-bisect when the deadline hits contributes to
      // `skipped`, not `rowErrors`. A chunk of twins only has nothing to upsert.
      const upsertChunk = (): Promise<BisectUpsertResult> =>
        chunk.length === 0
          ? Promise.resolve({ inserted: 0, rowErrors: 0, skipped: 0, calls: 0, firstError: null })
          : upsertWithBisect(
              chunk,
              async (batch) => {
                const { data, error } = await supabase
                  .from("articles")
                  .upsert(batch, { onConflict: "url", ignoreDuplicates: true })
                  .select("id");
                return { inserted: data?.length ?? 0, error: error?.message ?? null };
              },
              {
                isPastDeadline: () => Date.now() > deadline,
                onSkipped: (b) => collectSourceIds(b, unsettled),
                onRowError: (row, error) => {
                  rowFailed.add(row.source_id);
                  // Surface the real per-row failure (schema drift, constraint
                  // violations) instead of swallowing it — and count it so the
                  // cycle response reports the loss (audit P3-9).
                  console.error(
                    `[ingest] row upsert failed: ${JSON.stringify({
                      url: row.url,
                      source_id: row.source_id,
                      error,
                    })}`,
                  );
                },
              },
            );
      // Record any headline change (migration 056 / U-07) IN PARALLEL with
      // the article upsert below, not before it: `recordTitleVersions`
      // never rejects (its own try/catch returns 0) and the upsert never
      // mutates `title` (`ignoreDuplicates: true` on the `url` conflict
      // leaves the old title in place -- migration 056's own header), so
      // the two are independent and running them serially only cost wall
      // clock against the cycle deadline. Articles always win the deadline
      // race: a miss on the title-version side just means this chunk's
      // changes go uncollected.
      const [{ titleVersions, titleWriteBacks }, bisectResult] = await Promise.all([
        Date.now() <= deadline
          ? recordTitleVersions(supabase, [...chunk, ...twinRows], preResolved)
          : Promise.resolve({ titleVersions: 0, titleWriteBacks: 0 }),
        upsertChunk(),
      ]);
      if (titleVersions > 0) {
        stats.titleVersions += titleVersions;
        console.log(
          `[ingest] recorded ${titleVersions} headline version(s) in chunk ${i}-${i + chunk.length}`,
        );
      }
      if (titleWriteBacks > 0) {
        stats.titleWriteBacks += titleWriteBacks;
        console.log(
          `[ingest] wrote back ${titleWriteBacks} headline(s) in chunk ${i}-${i + chunk.length}`,
        );
      }
      stats.inserted += bisectResult.inserted;
      stats.rowErrors += bisectResult.rowErrors;
      stats.upsertSkipped += bisectResult.skipped;
      if (bisectResult.firstError) {
        // ONE log line per failing chunk, same discipline as before —
        // `upsertWithBisect` retries internally, this just reports that the
        // chunk needed to.
        console.error(
          `[ingest] batched upsert (chunk ${i}-${i + chunk.length}) failed: ${bisectResult.firstError}`,
        );
      }
    }
  }

  // silent-feeds: commit the deferred validators of sources whose rows all
  // landed (or were already stored); keep the OLD validators for the rest so
  // the next cycle re-offers their feed. Either way the source is healthy, so
  // the fail streak resets (`ok = true`). The `finally` in `runCycle`
  // persists these in one RPC (never more than two writes per cycle).
  const { settled, withheld, gaveUp, streakOf } = partitionWithRowErrorGrace(
    deferred.keys(),
    unsettled,
    rowFailed,
    rowErrorWithholds,
  );
  for (const id of settled) {
    const d = deferred.get(id);
    if (!d) continue;
    fetchStateUpdates.set(
      id,
      buildFetchStateUpdate(d.source, d.status, true, d.fresh, d.freshness),
    );
    // Memory now equals what the DB will hold.
    if (d.fresh.etag || d.fresh.lastModified) {
      conditionalCache.set(id, {
        etag: d.fresh.etag ?? undefined,
        lastModified: d.fresh.lastModified ?? undefined,
      });
    }
  }
  for (const id of withheld) {
    const d = deferred.get(id);
    if (!d) continue;
    // The validators stay old (the feed is re-offered), but the freshness is a
    // fact about the feed, not about row durability: it is saved either way.
    fetchStateUpdates.set(
      id,
      buildFetchStateUpdate(d.source, d.status, true, undefined, d.freshness),
    );
  }
  stats.validatorsWithheld = withheld.length;
  if (withheld.length > 0) {
    const list = withheld
      .map((id) => {
        const streak = streakOf.get(id);
        return `${deferred.get(id)?.source.slug ?? id}${streak ? `(row-error streak ${streak})` : ""}`;
      })
      .join(", ");
    console.log(
      `[ingest] withheld fresh validators for ${withheld.length} source(s) whose rows did not all land this cycle: ${list}`,
    );
  }
  if (gaveUp.length > 0) {
    const list = gaveUp.map((id) => deferred.get(id)?.source.slug ?? id).join(", ");
    console.warn(
      `[ingest] committed validators despite persistent row errors (poison rows) for ${gaveUp.length} source(s): ${list}`,
    );
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
