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
//   3. Normalises each item in two phases (`prepareArticles`, then
//      `completeArticles` for the items whose url is not already stored under
//      the same headline), which produce the canonical sha1-of-shingles
//      `content_hash` (audit T7 P1-21 fix). An item whose link host is the host
//      of a DIFFERENT active source is left to that source before either phase
//      continues (h63-clusterintegrity-2, `foreignHostSkipped`): the url upsert
//      gives a url to whichever source polls first, so a feed that carries
//      another outlet's stream would otherwise take its rows and starve it.
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
//      its new headline goes through the title-version path instead. A shared
//      id alone is not enough: some CMSs reuse an id for a different story, so
//      the headlines must also share words (word-Jaccard >= 0.2, the gate of
//      the SQL write-back; see _shared/rss/title-jaccard.ts) or the row is a
//      distinct story and is kept. The cycle reports four counters for it:
//      `twinsDroppedStored` (the real twin prevention), `twinsDroppedIntraFeed`
//      (the same key twice in one feed, re-counted on every re-parse of a long
//      feed), `twinsKeptDistinct` (same key, unrelated headline, stored) and
//      `twinsKeyCapped` (an id repeated past MAX_KEPT_TITLES_PER_KEY in one
//      feed: kept, no longer compared, so the gate's CPU stays bounded). A kept
//      reused-id row whose feed pubDate is not later than the first time that id
//      was seen carries the OLD item's pubDate: it is stamped with the poll
//      clock instead (`keyReuseRestamped`, h132-purity-1). The
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
//      Feed window overflow (migration 212) rides along too: a poll of a
//      full-sized window (10 items or more) none of whose urls is stored yet
//      means the feed moved past the previous poll and items were never offered
//      (haberport holds its 50 newest and is replaced hourly). That poll's state
//      row carries `fetch_window_overflow_at`; every other outcome OMITS the key
//      (see _shared/rss/feed-window.ts). Detection only: nothing is recovered.
//
// CPU budget: the platform kills an isolate that burns more than 2 s of CPU IN
// TOTAL (HTTP 546, reason CPUTime) -- the allowance is spent across the cycles a
// reused isolate serves -- and a killed cycle loses everything it fetched. The
// CPU of a cycle is the decode + XML parse + normalise of the feeds that
// CHANGED, so a cycle parses at most MAX_PARSES_PER_CYCLE of them and
// PARSE_BUDGET_BYTES of body, and an isolate parses at most
// ISOLATE_ITEM_BUDGET items over its life (see the cost model below); the
// rest are deferred -- no rows, no fetch-state write -- and go first in the
// next cycle. Per-item work is also cut at the source: the items of a feed
// whose url is already stored for the source under the same headline (99% of
// them) skip the full normalisation (`lookupStoredByUrl`).
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
import { isWindowOverflow } from "../_shared/rss/feed-window.ts";
import type { NormalizedArticle, PreparedItem } from "../_shared/rss/normalize.ts";
import {
  canonicalizeUrl,
  completeArticles,
  prepareArticles,
  STABLE_ARTICLE_ID_SOURCES,
  stableArticleId,
} from "../_shared/rss/normalize.ts";
import { sourceArticleKeyFor } from "../_shared/rss/article-key.ts";
import { buildHostOwners, foreignHostOwner, hostKey } from "../_shared/rss/host-owner.ts";
import { isOffHostItem } from "../_shared/rss/ad-link.ts";
import {
  TITLE_TWIN_MIN_JACCARD,
  jaccardOfSets,
  titleTokens,
} from "../_shared/rss/title-jaccard.ts";
import {
  isQuarantined,
  nextQuarantineState,
  QUARANTINE_AFTER_FAILURES,
} from "../_shared/rss/quarantine.ts";
import {
  ISOLATE_ITEM_BUDGET,
  createItemBudget,
  createParseBudget,
  estimateItems,
  groupChunkBySource,
  interleaveBySource,
  isolateItems,
  pickStaleReservation,
  prioritizeIds,
  prioritizeStale,
  reserveItemsFor,
  rotateForCycle,
  summarizeStale,
  upsertWithBisect,
} from "./order.ts";
import type { BisectUpsertResult } from "./order.ts";
import { FETCH_STATE_WRITE_MAX_CALLS, isRowScopedPgError } from "./fetch-state.ts";
import { collectSourceIds, partitionWithRowErrorGrace } from "./settle.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { KICK_ENV, scheduleClusterKick, shouldKick } from "../_shared/kick.ts";
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
// below. It started as a request-line bound (a single `.in(...)` over
// hundreds of hashes x source ids silently degraded to "drop nothing" once
// the query string tripped a proxy limit: ~25 KB for 500 hashes x 118 source
// ids in production, migration 074 evidence). Since migration 130 the lookup
// is the pairwise `existing_source_content_hash_pairs` RPC, whose arrays are
// the chunk's own pairs, so the cap now also bounds the RPC payload (the
// function itself accepts at most 500 pairs per call).
const PREFILTER_CHUNK = 100;
// How far back a stored row can make a re-polled item a "twin" (same source,
// same `source_article_key`, different url). A headline edit shows up in the
// feed within hours; a week keeps the lookup on recent index pages only and
// bounds the cost (the lookup rides the partial index of migration 113).
const TWIN_WINDOW_MS = 7 * 24 * 3_600_000;
// CPU bound of the twin title gate. The source article key is the last digit
// run of the last path segment of an item url, so it is chosen by the feed
// (a CMS bug, or a hostile or tampered feed, can repeat one id on thousands of
// items with unrelated headlines). Comparing every such item with every kept
// one is quadratic and a CPU-killed cycle (546) writes nothing, for every
// source. So per (source, key) at most this many headlines are tracked and
// compared: in the feed loop (the first ones kept) and against the stored
// matches (the earliest by created_at). An id repeated more often than this is
// not a usable twin signal; the extra items are kept as distinct stories
// (`twinsKeyCapped`), which is what a url with no key gets.
export const MAX_KEPT_TITLES_PER_KEY = 8;
// Row cap of the stored (source_id, source_article_key) lookup: a slice is
// PREFILTER_CHUNK keys, each with at most MAX_KEPT_TITLES_PER_KEY matches that
// are ever compared. The lookup is ordered by created_at ascending, so what
// the limit cuts is the newest of a pathological pile-up.
export const KEY_LOOKUP_LIMIT = PREFILTER_CHUNK * MAX_KEPT_TITLES_PER_KEY;
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
// CPU cost model (CPUTime kills, HTTP 546)
// ---------------------------------------------------------------------------
//
// The 2 s CPU allowance is CUMULATIVE PER ISOLATE, not per invocation, and an
// isolate serves several cycles. Evidence, function logs of 2026-11-01 (10:00
// to 14:00 UTC): 56 isolates served one request and none was killed; 12 served
// two and 7 of those answered 546 on the LATER request (one isolate: 200 at
// 10:03:16, 546 at 10:06:03); all 7 shutdowns of that window with reason
// CPUTime had used 2000 to 2176 ms (60 more were EarlyDrop at 792 to 1970 ms,
// which is not a CPU kill). Lost 3-minute ticks per day since 10-26: 30, 34,
// 11, 35, 24, 19, 18. A cycle that fits its own budget therefore still dies on
// the CPU an earlier cycle of the same isolate spent, and a killed invocation
// writes nothing.
//
// What the CPU is spent on: items, not feeds or bytes. The same window shows
// 252,949 items normalised in 73 cycles (up to 4,464 in one) against 1,860
// inserted (0.74%): the rest were already stored and were normalised and
// fingerprinted in full just to be dropped by the upsert. Per-item costs,
// measured with a scratch Deno bench (not committed) over the 522-item corpus
// of tests/fixtures/ingest-corpus.json (460 real headlines, 62 synthetic
// variants), Apple M5 Pro, Deno 2.9.2, microseconds per item, mean of two runs:
//
//   stage                                      before    after
//   normalizeTurkish                              7.8      5.5
//   strictFingerprint                            45.9     35.3
//   isLegalNotice                                 6.8      0.5
//   normalizeItem (everything)                   64.9     46.7
//   one poll, 90% of its urls already stored     64.0      6.3
//
// The last row is what matters: `normalizeArticles` over every item versus the
// two-phase loop (prepare every item, look the urls up, complete the 10% that
// are not stored). The first four rows are the same code made cheaper (one
// normalisation per fingerprint, one regex replace for the diacritic fold, the
// anchored regexes before the per-letter uppercase scan); outputs are
// byte-identical, pinned by tests/functions/_shared/ingest-corpus-equality.test.ts.
//
// Parse costs, measured earlier with a scratch Deno script on a synthetic
// 300-item feed of about 2.6 to 2.8 MB, median of 8 warm runs on the dev
// machine of the time (a slower one than the bench above); they depend on the
// feed's shape:
//
//   stage                      CDATA-heavy   entity-escaped   many small elements
//   decodeRssBody                1.3 ms/MB       1.3 ms/MB          1.0 ms/MB
//   fast-xml-parser (fetcher)    1.9 ms/MB      11.1 ms/MB         36.4 ms/MB
//   item mapping + cleanFeedDate 0.3 ms/MB       0.2 ms/MB          0.3 ms/MB
//
// interleaveBySource over 5,000 rows takes 1.4 to 1.8 ms once per cycle, so it
// is not a hot loop. The worst shape (48 ms/MB in all, with the old
// normalisation) put about 800 ms of CPU at 16.6 MB; the byte budget is the
// smaller of that, rounded down to 0.5 MB, and the 8 MB feed-size cap
// (DEFAULT_MAX_BYTES in the fetcher), i.e. 8_000_000.
//
// Three caps, from the finest to the coarsest:
//
//  1. ISOLATE_ITEM_BUDGET (5,000 items, INGEST_ISOLATE_ITEM_BUDGET): items
//     parsed over the life of one isolate, carried in module state. A changed
//     feed is admitted when nothing was booked yet on the isolate (any one feed
//     fits a fresh one) or when its estimated items (body bytes / 1500) fit
//     what is left; there is no priority exemption. The estimate is replaced by
//     the real item count after the parse. One feed does get its room ahead of the
//     others (h39-pipeline2-1): before the fetch pool starts, the stalest source
//     with a known item count has ceil(1.25 x fetch_items_count) items booked with
//     `ItemBudget.reserve`, which stays under the limit (no fresh-isolate
//     exception), so admission in body-ARRIVAL order cannot starve a big feed that
//     arrives last (BHA, 4.25 MB). The booking becomes the feed's own when it is
//     parsed and goes back on any other outcome; the limit is the same number. The
//     h11 analysis fitted the cost of the old pipeline at about 280 ms fixed plus 0.256 ms per item on the
//     Edge runtime; 280 + 0.256 x 5,000 is about 1.56 s, which leaves 0.4 s of
//     the 2 s. The known-url skip makes a poll about 90% cheaper per item
//     (64.0 to 6.3 us above), so the number now has more margin than it was
//     chosen with: watch `isolateBudgetDeferred` and the CPUTime shutdowns,
//     and raise INGEST_ISOLATE_ITEM_BUDGET (no deploy) while the shutdowns
//     stay at zero and feeds are still being deferred. Note the consequence of
//     a cumulative count: once an isolate has used its items, every later
//     cycle on it defers its changed feeds until the platform recycles it
//     (such a cycle costs almost nothing, which is the point), so a limit far
//     below what a normal isolate parses in two cycles trades 546s for
//     deferral.
//  2. MAX_PARSES_PER_CYCLE (55) and PARSE_BUDGET_BYTES: changed feeds and body
//     bytes parsed in one cycle; the coarse per-cycle cap below. The feed that has
//     isolate items reserved (above) is held to the parse count but not to the
//     byte budget, so a cycle's bytes can exceed PARSE_BUDGET_BYTES by that one
//     body (BHA: 4.25 MB) and by no more: every other feed is still held to it.
//     One parse slot is also kept for that feed while its reservation is held:
//     the other feeds may take at most MAX_PARSES_PER_CYCLE - 1, so 55 small
//     feeds that arrive first cannot leave it at the cap. The slot is freed with
//     the reservation, and the total never passes MAX_PARSES_PER_CYCLE.
//  3. The cycle deadline (CYCLE_DEADLINE_MS), for wall clock.
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
// The item, parse-count and byte limits can all be overridden per deployment
// without a code change.
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
  // no `ingest_cycles` column for any of the counters below.
  //
  // `twinsDroppedStored`: the key is already stored for the source under
  // another url within the 7-day window, with a headline that shares words
  // with the new one (a headline edit). This is the real twin prevention of
  // #128.
  twinsDroppedStored: number;
  // `twinsDroppedIntraFeed`: a later item of the same feed with the same key
  // and a headline that shares words with an earlier kept one of this cycle;
  // the first one stands. This check runs before any stored lookup, so a long
  // feed that is parsed again re-counts pairs that are already stored. That is
  // why it is high at night and is not a #128 signal.
  twinsDroppedIntraFeed: number;
  // `twinsDropped`: the sum of the two above. It stays for one release for
  // dashboards and log queries and goes in the next ingest release.
  twinsDropped: number;
  // `twinsKeptDistinct`: rows that share a key with another row (a stored one,
  // or an earlier item of this cycle) but whose headline shares no words with
  // it: the CMS reused the id for a different story, so the row is stored
  // instead of being dropped as a twin. Counted per row and per path, so one
  // item can add to it in the feed check and again in the stored check.
  // Summary line and HTTP JSON only: no `ingest_cycles` column.
  twinsKeptDistinct: number;
  // `twinsKeyCapped`: items of one feed whose (source, key) already tracks
  // MAX_KEPT_TITLES_PER_KEY headlines this cycle and which matched none of
  // them: kept (stored) without being tracked, so the id repeated that often
  // costs a bounded amount of CPU (see MAX_KEPT_TITLES_PER_KEY). Not counted in
  // `twinsKeptDistinct`. Normally 0. Summary line and HTTP JSON only.
  twinsKeyCapped: number;
  // `contentlessTitlesDropped`: items without headline text after decoding
  // ('&nbsp', '&amp;nbsp', '-', '…', a blank title) that normalizeItem threw
  // away instead of storing them as stories. Summary line and HTTP JSON only,
  // no `ingest_cycles` column, like the twins counters. Normally 0.
  contentlessTitlesDropped: number;
  // `adLinksDropped` (h130-feeds-2): items whose link is an ad click-tracker
  // (a DoubleClick `gampad/clk` url, `isAdClickLink`) that normalizeItem threw
  // away instead of storing them as stories: every reader click on such a card
  // registered a paid ad click. Summary line and HTTP JSON only, no
  // `ingest_cycles` column. Normally 0.
  adLinksDropped: number;
  // `paidContentDropped` (h148-sources-1): items whose url opens with a paid
  // content section (`/advertorial/` or `/tanitim-bulteni/` as the first or second
  // path segment, `isPaidContentUrl`) that normalizeItem threw away instead of
  // storing them as news (Posta and CNN Türk publish them almost daily). Summary
  // line and HTTP JSON only, no `ingest_cycles` column.
  paidContentDropped: number;
  // `foreignHostSkipped` (h63-clusterintegrity-2): items left to another source
  // because their link host is the host of a different active source (an
  // aggregator feed carrying a registered outlet's stream: haberler.com's feed
  // with sondakika.com links, from 2026-11-06). They are not stored for this
  // source and register no twin key; the owning source claims the url on its own
  // poll. Normally 0. Summary line and HTTP JSON only, no `ingest_cycles` column.
  foreignHostSkipped: number;
  // `offHostItems` (h130-feeds-2, LOG ONLY): items of a polled feed whose link
  // host is neither the source's own host (subdomains allowed) nor the host of
  // any active source (staging hosts such as bbstagedesktop.ciner.com.tr, video
  // hosts such as youtu.be). Counted per cycle over the feed's current items,
  // known ones included, and NEVER dropped: it only makes those hosts visible
  // before any rule is set. Summary line and HTTP JSON only. Normally small.
  offHostItems: number;
  // Parse budget: changed feeds this cycle refused a parse because the cycle
  // already used its MAX_PARSES_PER_CYCLE / PARSE_BUDGET_BYTES. Not failures:
  // they are retried first next cycle. Summary line, HTTP JSON and, since
  // migration 157, `ingest_cycles.parse_deferred`.
  parseDeferred: number;
  // The longest run of consecutive cycles any feed has been deferred, counting
  // this one (0 when nothing was deferred): starvation made visible. Best
  // effort across warm invocations, like the priority set. Summary line, HTTP
  // JSON and, since migration 157, `ingest_cycles.parse_deferred_max_streak`.
  parseDeferredMaxStreak: number;
  // Body bytes of the feeds this cycle admitted to a parse. Summary and HTTP
  // JSON only: there is no `ingest_cycles` column for it.
  parsedBytes: number;
  // Feed freshness (migration 119): sources parsed this cycle because their
  // fetch_items_count was still NULL (the one-time bootstrap). Summary line and
  // HTTP JSON only: there is no `ingest_cycles` column for it.
  freshnessBootstraps: number;
  // Feed window overflow (migration 212): polls of a full-sized feed window none
  // of whose urls was stored yet, i.e. feeds that moved past the previous poll
  // and lost items. One per feed per cycle, never per item. Summary line, HTTP
  // JSON and `ingest_cycles.window_overflows`.
  windowOverflows: number;
  // Per-item work spent on items that are never inserted (hunt-11,
  // A-ingest-cpu). Ingest looks up which of a feed's urls are already stored
  // BEFORE the full normalisation; `itemsNormalized` counts the rows that got
  // it, `itemsKnownSkipped` the items it was skipped for (stored for this
  // source under the same headline). Summary line and HTTP JSON only: there is
  // no `ingest_cycles` column for the counters below, except the one named
  // `isolateBudgetDeferred` (migration 157).
  itemsKnownSkipped: number;
  // Feeds whose stored-url lookup failed (any batch): every item of such a feed
  // takes the full path, exactly as before the lookup existed (fail-open).
  knownUrlLookupErrors: number;
  // Re-slugged items (hunt-114, STABLE_ARTICLE_ID_SOURCES): new rows of a source
  // whose feed keeps the first url's pubDate on a retitled article (Anadolu
  // Ajansı live pages) and whose trailing numeric id is already stored for that
  // source under a different url within 7 days. `reslugRestamped` counts the rows
  // stamped with the poll's clock instead of the feed's pubDate that survive the
  // twin drop of the upsert phase (a restamped row dropped as a stored twin never
  // reaches the database and is not counted); `reslugLookupErrors` the lookup
  // batches that failed (fail-open: those rows keep the parsed pubDate). Summary
  // line and HTTP JSON only: no `ingest_cycles` column. Normally 0 and 0 for every
  // other source.
  reslugRestamped: number;
  reslugLookupErrors: number;
  // Reused ids (h132-purity-1): rows kept by the stored (source_id,
  // source_article_key) check although another url is stored under their id (the
  // headline shares no words: a different story under a reused id) and whose feed
  // pubDate is not later than the first time that id was seen. That pubDate belongs
  // to the earlier item, so the row is stamped with the poll's clock instead.
  // Counted per chunk from the rows that go on to the upsert (a twin is dropped and
  // never stamped). The sources of STABLE_ARTICLE_ID_SOURCES (AA) are left to the
  // re-slug check above and never counted here. Summary line and HTTP JSON only: no
  // `ingest_cycles` column. About 28 a day across sources other than AA (7-day
  // prod replay of this rule, 2026-11-11: 198 rows, about 12 a day more than 60
  // minutes stale; haber7, yenicag and birgun the most). haber7's share is mostly
  // same-story live-update retitles (same id and pubDate, new slug and headline),
  // which are stamped too.
  keyReuseRestamped: number;
  // Isolate item budget (hunt-11, A-ingest-cpu): items booked on this isolate
  // so far, cycles it has served, and changed feeds this cycle refused because
  // they did not fit what is left of the isolate's allowance (each also counts
  // in `parseDeferred`). `isolateBudgetDeferred` is also written to
  // `ingest_cycles.isolate_budget_deferred` since migration 157.
  isolateItemsUsed: number;
  isolateCycles: number;
  isolateBudgetDeferred: number;
  // Stale-feed admission (h39-pipeline2-1): sources with no quarantine marker
  // (`fetch_quarantined_until` null, ops_health_report() row 20's population)
  // whose `fetch_last_at` was null or older than three cycle periods when the
  // cycle started are the "stale" ones (`prioritizeStale`'s rule; a probe of an
  // expired quarantine is not one). `staleDeferred` counts how many of them this
  // cycle still deferred (it should be 0: the stalest one with a known item count
  // gets isolate items reserved before the pool starts); `oldestStaleMin` is the
  // age of the oldest one in whole minutes (0 when none has a timestamp). Summary
  // line, HTTP JSON and, since migration 159, `ingest_cycles.stale_deferred` and
  // `ingest_cycles.oldest_stale_min`.
  staleDeferred: number;
  oldestStaleMin: number;
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

type ExistingPair = { source_id: string; content_hash: string };

// Warn once per isolate when migration 130 is missing: every chunk of every
// cycle would otherwise log the same line.
let warnedPairsRpcMissing = false;

// The pre-130 probe, verbatim: a source x hash CROSS PRODUCT (every stored
// pair whose source is in one list AND whose hash is in the other), so the
// caller still checks exact pairs client-side. Only reached when PostgREST
// answers PGRST202 (function not found in the schema cache), i.e. between
// deploying this function and applying migration 130.
async function legacyExistingPairsProbe(
  supabase: ReturnType<typeof createServiceClient>,
  rows: readonly IngestArticleRow[],
) {
  const sourceIds = [...new Set(rows.map((r) => r.source_id))];
  const hashes = [...new Set(rows.map((r) => r.content_hash))];
  return await supabase
    .from("articles")
    .select("source_id, content_hash")
    .in("source_id", sourceIds)
    .in("content_hash", hashes);
}

// `dedupeBySourceContentHash` above only catches a repeat WITHIN the rows
// this cycle assembled. The 23505 the task describes (`articles_source_
// content_hash_key`) is a row colliding with an ALREADY-STORED article —
// same outlet republishing identical content under a new URL — which the
// `.upsert(chunk, { onConflict: "url" })` below can't see because it only
// targets the `url` UNIQUE constraint, not `(source_id, content_hash)`
// (migration 041 F2). We look the pairs up first and drop any chunk row
// that already exists so the batched insert never hits that constraint.
// The lookup is `existing_source_content_hash_pairs` (migration 130): it
// takes the chunk's (source_id, content_hash) pairs as two index-aligned
// arrays and probes the unique index once per PAIR (about 500 buffers for a
// 100-row chunk). The `.in("source_id").in("content_hash")` query it
// replaced is a source x hash cross product (7-12k buffers and a mean of
// 165 ms for the same chunk, with 8 s timeouts), so it survives only as
// `legacyExistingPairsProbe`, used while migration 130 is not applied. The
// exact-pair check still runs client-side against the returned rows; a
// lookup failure degrades to "don't drop anything" and lets the pre-existing
// per-row fallback catch the 23505 as before.
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

  let existingPairs: ExistingPair[] = [];
  try {
    // Per-row, index-aligned arrays: NOT deduped sets (the SQL zips them).
    let { data, error } = await supabase.rpc("existing_source_content_hash_pairs", {
      p_source_ids: rows.map((r) => r.source_id),
      p_hashes: rows.map((r) => r.content_hash),
    });
    if (error?.code === "PGRST202") {
      if (!warnedPairsRpcMissing) {
        warnedPairsRpcMissing = true;
        console.warn(
          "[ingest] existing_source_content_hash_pairs missing (apply migration 130); using legacy probe",
        );
      }
      ({ data, error } = await legacyExistingPairsProbe(supabase, rows));
    }
    if (error) {
      console.error(`[ingest] existing (source_id, content_hash) lookup failed: ${error.message}`);
      return { rows: [...rows], dropped: 0, lookupErrors: 1 };
    }
    existingPairs = (data ?? []) as ExistingPair[];
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
// a proxy's request-line limit was tripped). Each chunk looks up only its own
// (source_id, content_hash) pairs; a failing chunk degrades only itself.
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
// stored article -- provided the headlines share words (see the title gate
// below).
//
// Only keyed rows are looked up (a null key has nothing to match), in slices
// of PREFILTER_CHUNK like the content-hash pre-filter, against the partial
// index of migration 113. As there, `.in()` on both columns is a cross
// product, so the exact (source_id, key) pair is matched client-side. A row is
// kept when no stored row has its pair, or when ANY stored row with that pair
// has its own url (the normal re-poll: the url upsert ignores the duplicate).
//
// Title gate (ingest-gates). A shared id is not proof of a shared article:
// some CMSs reuse a numeric id for a different story (aksam 1708103, odatv
// 120168027 and yenicag 1084546 on 2026-10-24: the row and the stored article
// shared no word at all), and dropping those rows ate real stories. So of the
// matches with another url only those whose headline shares words with the
// row's count (word-Jaccard >= TITLE_TWIN_MIN_JACCARD, the same gate as
// the SQL headline write-back). With none, the row is a distinct story: kept,
// and counted in `keptDistinct`. Otherwise it is a twin, and the stored
// article it duplicates is the match with the earliest created_at AMONG THE
// PASSING ones (not among all of them: an earlier unrelated match must not
// take the headline edit).
//
// CPU bound: the key comes from an untrusted url, and a reused key piles up
// stored rows over the window. The lookup is ordered by created_at and limited
// to KEY_LOOKUP_LIMIT rows, and a row is compared against at most the
// MAX_KEPT_TITLES_PER_KEY EARLIEST matches of its pair, each tokenized once
// (the same-url re-poll check still sees every returned match). A failing
// lookup degrades only its own slice (those
// rows are kept, fail-open) and is counted in `lookupErrors`, which the caller
// adds to `stats.prefilterErrors`.
//
// Reused ids keep the old item's pubDate (hunt-132, h132-purity-1). The CMS that
// reuses an id for a new story keeps shipping the OLD item's pubDate on it, so
// the row of a kept (distinct) story was stored hours "old", set its cluster's
// first_published and took the "Kim önce yazdı?" first-mover slot: Evrensel key
// 6008841 (pubDate 2026-11-10T13:11Z on both rows; the first created 13:24Z, the
// second 20:24Z, which set cluster 99f8fd67 "İlk: Evrensel 16:11, İktidar 6 sa
// 35 dk sonra katıldı") and BirGün 745397 (pubDate 08:11Z; rows created 09:12Z
// and 14:15Z; the second set e2be28a4's first_published). Their headlines score
// 0.192 and 0.111, below TITLE_TWIN_MIN_JACCARD, so the gate above keeps them with
// the feed's pubDate. A kept row whose pubDate is NOT LATER than the first time
// that (source, key) was seen (the minimum created_at over EVERY returned match
// of the pair, not only the MAX_KEPT_TITLES_PER_KEY compared ones) cannot be the
// new story's own: that pubDate predates the id's first sighting. It gets the
// poll clock (`nowMs`) instead, and its url goes in `restampedUrls`. A twin is
// dropped and never stamped, a same-url re-poll and a failed lookup slice are
// untouched, and stored rows and clusters are never rewritten (new rows only).
// The sources of STABLE_ARTICLE_ID_SOURCES (Anadolu Ajansı) belong to the re-slug
// check below (hunt-114, #262), whose contract includes "a failed lookup keeps the
// parsed pubDate": their ids are passed in `reslugSourceIds` and this rule never
// touches their rows, so no row is handled by both checks. (A row that check did
// stamp carries the poll clock, later than the id's first sighting, so it would not
// be stamped again either.) Matches created at or after the cycle start
// (`firstSeenBeforeMs`: rows this cycle inserted in an earlier UPSERT_BATCH chunk)
// do not count as the first sighting, so the stamp does not depend on how the
// cycle is chunked.

export interface ExistingKeyedArticle {
  id: string;
  url: string;
  title: string;
  source_id: string;
  source_article_key: string;
  created_at: string;
  published_at: string;
}

export async function dropExistingSourceArticleKeyRows<
  T extends {
    source_id: string;
    url: string;
    title: string;
    source_article_key: string | null;
    published_at: string;
  },
>(
  supabase: ReturnType<typeof createServiceClient>,
  rows: readonly T[],
  sinceIso: string,
  nowMs: number,
  // Ids of the sources whose re-stamping belongs to `restampResluggedRows`
  // (STABLE_ARTICLE_ID_SOURCES): their rows are never stamped here.
  reslugSourceIds: ReadonlySet<string> = new Set<string>(),
  // The cycle start (h133): a match created at or after it is a row this cycle
  // inserted itself (an earlier UPSERT_BATCH chunk), not a prior sighting of the
  // id. Only the first-sighting clock skips it; the twin and same-url checks
  // still see it. +Infinity (the default) counts every match.
  firstSeenBeforeMs: number = Number.POSITIVE_INFINITY,
): Promise<{
  rows: T[];
  twins: Array<{ row: T; existing: ExistingKeyedArticle }>;
  lookupErrors: number;
  // Rows kept although another url is stored under their (source_id, key):
  // none of those headlines shares words with the row's (an id reuse).
  keptDistinct: number;
  // The urls of the kept rows whose `published_at` was replaced by `nowMs`
  // (h132-purity-1): a reused id whose pubDate is not later than the id's first
  // sighting. The rows themselves are mutated in place and are all in `rows`.
  restampedUrls: string[];
}> {
  const keyed = rows.filter((r) => r.source_article_key !== null);
  if (keyed.length === 0) {
    return { rows: [...rows], twins: [], lookupErrors: 0, keptDistinct: 0, restampedUrls: [] };
  }

  // The poll clock as written on a stamped row; null (nothing is ever stamped)
  // when `nowMs` is not a usable date, so a bad clock can never throw here.
  const nowDate = new Date(nowMs);
  const nowIso = Number.isNaN(nowDate.getTime()) ? null : nowDate.toISOString();

  const twinOf = new Map<T, ExistingKeyedArticle>();
  const restampedUrls: string[] = [];
  let lookupErrors = 0;
  let keptDistinct = 0;
  for (let i = 0; i < keyed.length; i += PREFILTER_CHUNK) {
    const slice = keyed.slice(i, i + PREFILTER_CHUNK);
    const sourceIds = [...new Set(slice.map((r) => r.source_id))];
    const keys = [...new Set(slice.map((r) => r.source_article_key as string))];

    let found: ExistingKeyedArticle[];
    try {
      const { data, error } = await supabase
        .from("articles")
        .select("id, url, title, source_id, source_article_key, created_at, published_at")
        .in("source_id", sourceIds)
        .in("source_article_key", keys)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: true })
        .limit(KEY_LOOKUP_LIMIT);
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

    // Per (source, key): every url seen (the normal re-poll check must see ALL
    // matches), and the EARLIEST MAX_KEPT_TITLES_PER_KEY matches with their
    // headline tokenized once. Rows are compared against that bounded list
    // only, however many matches a reused key has piled up.
    const byPair = new Map<
      string,
      {
        urls: Set<string>;
        earliest: Array<{ match: ExistingKeyedArticle; tokens: ReadonlySet<string> }>;
        // The earliest created_at of ALL the pair's returned matches (not just the
        // compared ones): when this id was first seen. +Infinity when none parses.
        firstSeenMs: number;
      }
    >();
    const createdMs = (e: ExistingKeyedArticle): number => {
      const ms = Date.parse(e.created_at);
      return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
    };
    const grouped = new Map<string, ExistingKeyedArticle[]>();
    for (const e of found) {
      const pair = `${e.source_id}\x1f${e.source_article_key}`;
      const list = grouped.get(pair);
      if (list) list.push(e);
      else grouped.set(pair, [e]);
    }
    for (const [pair, list] of grouped) {
      const earliest = [...list]
        .sort((a, b) => {
          const x = createdMs(a);
          const y = createdMs(b);
          return x < y ? -1 : x > y ? 1 : 0;
        })
        .slice(0, MAX_KEPT_TITLES_PER_KEY)
        .map((match) => ({ match, tokens: titleTokens(match.title) }));
      let firstSeenMs = Number.POSITIVE_INFINITY;
      for (const e of list) {
        const ms = createdMs(e);
        // A row this cycle inserted earlier is not a prior sighting (h133).
        if (ms >= firstSeenBeforeMs) continue;
        if (ms < firstSeenMs) firstSeenMs = ms;
      }
      byPair.set(pair, { urls: new Set(list.map((e) => e.url)), earliest, firstSeenMs });
    }
    for (const row of slice) {
      const candidates = byPair.get(`${row.source_id}\x1f${row.source_article_key}`);
      if (!candidates) continue;
      if (candidates.urls.has(row.url)) continue;
      const rowTokens = titleTokens(row.title);
      // The list is ordered earliest first, so the first passing match is the
      // earliest PASSING one.
      let earliest: ExistingKeyedArticle | null = null;
      for (const c of candidates.earliest) {
        if (jaccardOfSets(rowTokens, c.tokens) >= TITLE_TWIN_MIN_JACCARD) {
          earliest = c.match;
          break;
        }
      }
      if (earliest === null) {
        keptDistinct++;
        // A reused id (h132-purity-1): the row's pubDate is not later than the
        // first time this id was seen, so it is the earlier item's, not the new
        // story's. Stamp the poll clock. An unparseable pubDate (NaN) or an id
        // with no usable first sighting (Infinity) never stamps.
        if (
          nowIso !== null &&
          !reslugSourceIds.has(row.source_id) &&
          Number.isFinite(candidates.firstSeenMs) &&
          typeof row.published_at === "string" &&
          Date.parse(row.published_at) <= candidates.firstSeenMs
        ) {
          row.published_at = nowIso;
          restampedUrls.push(row.url);
        }
        continue;
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
  return { rows: kept, twins, lookupErrors, keptDistinct, restampedUrls };
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

// ---------------------------------------------------------------------------
// Stored-url lookup before the heavy normalisation (hunt-11, A-ingest-cpu)
// ---------------------------------------------------------------------------
//
// 99% of the items a poll returns are already stored (2026-11-01: 252,949
// items fully normalised against 1,860 inserted), and they used to be
// normalised and fingerprinted in full only to be dropped at the upsert. The
// feed loop now runs the cheap half of normalisation first (`prepareArticles`),
// asks this function which of the resulting urls are stored, and completes only
// the items that are not "known". An item is KNOWN when its url is stored for
// the SAME source under the same headline (`stored.title.trim() ===
// title.trim()`, the comparison `recordTitleVersions` makes): the upsert would
// ignore it anyway. A changed headline or a url stored under another source
// still takes the full path, so the title-version / write-back machinery sees
// exactly what it saw before.
//
// Same shape as the select in `recordTitleVersions` (`id, url, title,
// source_id`, `.in("url", slice)`, served by the unique url index), bounded by
// TITLE_LOOKUP_BATCH urls AND by URL_LOOKUP_MAX_BYTES of encoded query string
// per request (a count alone does not bound the bytes: see below). Batches run a
// few at a time, since they are independent.
const URL_LOOKUP_PARALLEL = 4;

// Byte budget of ONE `url=in.(...)` request: the percent-encoded length of the
// query value, which is what travels in the request line. Measured 2026-11-01
// (hunt-14): evrensel urls average 175 chars (max 235), so 100 of them are
// ~19-20 kB and the request died with an http2 stream error on every changed
// feed (9 log lines), failing the whole lookup open; sputnik-turkce (~14 kB per
// 100) is close to that line and cumhuriyet (~13 kB per 100) still works. 6 kB
// sits far under every size seen failing. With URL_LOOKUP_PARALLEL = 4 the extra
// slices of a 115-130 char feed (two or three instead of one) run concurrently,
// so the wall-clock of a lookup is unchanged; feeds of short urls (about 55 chars
// or fewer on average) still send all 100 in one request.
export const URL_LOOKUP_MAX_BYTES = 6_000;

// Encoded bytes `encodeURIComponent` adds around the urls of one slice: `in.(`
// and `)` (neither parenthesis is escaped) ...
const URL_LOOKUP_ENVELOPE_BYTES = 5;
// ... and per separator, the comma that becomes `%2C`.
const URL_LOOKUP_SEPARATOR_BYTES = 3;

// Encoded size of one url inside `in.(...)`. A lone surrogate makes
// `encodeURIComponent` throw; such a url is costed at 9 bytes per UTF-16 unit
// (a lone surrogate is sent as U+FFFD, 9 encoded bytes), which over-counts
// rather than lets it through as free. Never throws.
function encodedUrlBytes(url: string): number {
  try {
    return encodeURIComponent(url).length;
  } catch {
    return url.length * 9;
  }
}

/**
 * Cuts `urls` into the consecutive slices `lookupStoredByUrl` sends as one
 * `url=in.(...)` request each: greedy and order-preserving, a new slice starting
 * when one more url would take the open slice past `maxCount` urls or `maxBytes`
 * of encoded query value. A slice's cost is 5 (`in.()`) + the encoded length of
 * each url + 3 per separator, which is exactly
 * `encodeURIComponent(`in.(${slice.join(",")})`).length`. (postgrest-js also
 * double-quotes a value that contains `,` `(` or `)`, at most 6 more encoded
 * bytes for such a url; the margin under the real failure line absorbs it.) A
 * url that alone exceeds `maxBytes` gets a slice of its own: it is never
 * dropped. Pure; never throws.
 */
export function planUrlLookupSlices(
  urls: readonly string[],
  maxCount = TITLE_LOOKUP_BATCH,
  maxBytes = URL_LOOKUP_MAX_BYTES,
): string[][] {
  const slices: string[][] = [];
  let open: string[] = [];
  let openBytes = URL_LOOKUP_ENVELOPE_BYTES;
  for (const url of urls) {
    const cost = encodedUrlBytes(url);
    if (
      open.length > 0 &&
      (open.length >= maxCount || openBytes + URL_LOOKUP_SEPARATOR_BYTES + cost > maxBytes)
    ) {
      slices.push(open);
      open = [];
      openBytes = URL_LOOKUP_ENVELOPE_BYTES;
    }
    openBytes += (open.length > 0 ? URL_LOOKUP_SEPARATOR_BYTES : 0) + cost;
    open.push(url);
  }
  if (open.length > 0) slices.push(open);
  return slices;
}

export interface StoredArticleRef {
  id: string;
  title: string;
  source_id: string;
}

// An error message made safe for a log line: urls redacted, clamped. Titles and
// urls of a feed never reach the logs (see the discipline in `normalizeArticles`).
function safeErrorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err))
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>")
    .slice(0, 200);
}

/**
 * Looks up which of `urls` are stored in `articles`. Duplicates are looked up
 * once. The urls go out in slices of at most TITLE_LOOKUP_BATCH urls AND at most
 * URL_LOOKUP_MAX_BYTES of encoded query string (`planUrlLookupSlices`), so a
 * feed of long urls cannot build the ~20 kB request that fails. A slice whose
 * request fails (an error envelope or a rejection) is retried ONCE, split in
 * half (a one-url slice is retried as is); only a failed retry fails the
 * lookup. Returns the stored rows by url and `ok`: false when ANY slice still
 * failed (or on a synchronous throw), in which case the caller must treat the
 * answer as unknown and take the full path for every item (fail-open) -- `byUrl`
 * may then hold a partial answer and must not be used to conclude that a url is
 * absent. Never throws. On failure ONE line is logged with `slug` and the
 * message only, never a url; when every failed slice recovered through the retry
 * ONE warning with the slug only says so.
 */
export async function lookupStoredByUrl(
  supabase: ReturnType<typeof createServiceClient>,
  urls: readonly string[],
  slug = "?",
): Promise<{ byUrl: Map<string, StoredArticleRef>; ok: boolean }> {
  const byUrl = new Map<string, StoredArticleRef>();
  // Objects, not `let`s: the lanes below assign them from inside closures.
  const failure: { message: string | null } = { message: null };
  const retries = { slices: 0 };
  try {
    const unique = [...new Set(urls)];
    const slices = planUrlLookupSlices(unique);
    // One request: error envelope and rejection both come back as ok:false.
    const fetchSlice = async (
      slice: string[],
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      try {
        const { data, error } = await supabase
          .from("articles")
          .select("id, url, title, source_id")
          .in("url", slice);
        if (error) return { ok: false, message: safeErrorMessage(error.message) };
        for (const row of (data ?? []) as Array<{
          id: string;
          url: string;
          title: string;
          source_id: string;
        }>) {
          byUrl.set(row.url, { id: row.id, title: row.title, source_id: row.source_id });
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, message: safeErrorMessage(err) };
      }
    };
    let cursor = 0;
    const lane = async (): Promise<void> => {
      for (;;) {
        const slice = slices[cursor++];
        if (slice === undefined) return;
        const attempt = await fetchSlice(slice);
        if (attempt.ok) continue;
        // One retry, split in half, the halves one after the other in this
        // lane (the other lanes keep working). A failed half fails the lookup.
        retries.slices++;
        const mid = Math.ceil(slice.length / 2);
        const halves = slice.length > 1 ? [slice.slice(0, mid), slice.slice(mid)] : [slice];
        for (const half of halves) {
          const retry = await fetchSlice(half);
          if (!retry.ok) {
            failure.message ??= retry.message;
            break;
          }
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(URL_LOOKUP_PARALLEL, slices.length) }, lane),
    );
  } catch (err) {
    failure.message ??= safeErrorMessage(err);
  }
  if (failure.message !== null) {
    console.error(`[ingest] ${slug}: known-url lookup failed: ${failure.message}`);
    return { byUrl, ok: false };
  }
  if (retries.slices > 0) {
    console.warn(`[ingest] ${slug}: known-url lookup recovered after split retry`);
  }
  return { byUrl, ok: true };
}

// ---------------------------------------------------------------------------
// Re-slugged items keep the first url's pubDate (hunt-114)
// ---------------------------------------------------------------------------
//
// Anadolu Ajansı retitles a live article under a NEW url (new slug, same trailing
// numeric id) and ships the live stub's pubDate on it. The url-keyed upsert and
// the known-url skip see a new url, so the row was stored 2.5-3 hours "old" and
// gave AA a head start as the first mover of the cluster it joined (cluster
// 9a24657e: "Muhalefet 2 sa 56 dk sonra katıldı"; ids 4117359, 4116605, 4118171).
// For a source in STABLE_ARTICLE_ID_SOURCES a NEW row whose id is stored for the
// same source under a DIFFERENT url, created within RESLUG_WINDOW_MS, is stamped
// with the poll's clock (the time Tayf first saw that article under its new url)
// instead of the feed's pubDate. Stored rows are never rewritten.
//
// The lookup is ONE select per batch of at most RESLUG_LOOKUP_BATCH ids, served
// by the (created_at, source_id) index range (EXPLAIN on prod, 2026-11-11: an
// index scan, ~1,400 buffers, 11-30 ms for 10-50 ids against 1,312 AA rows in 7
// days):
//   articles.select("url").eq("source_id", id).gte("created_at", since)
//           .or("url.like.*/4117359,url.like.*/4116605,...")
// The filter is built ONLY from the digit-only ids `stableArticleId` captured,
// never from url text, so a hostile feed url cannot add a PostgREST operator.
// Fail-open: a batch that errors or throws is counted and its rows keep the parsed
// pubDate.
export const RESLUG_LOOKUP_BATCH = 50;
export const RESLUG_WINDOW_MS = 7 * 24 * 3_600_000;

const RESLUG_ID_RE = /^[0-9]{1,20}$/;

/**
 * The `or=` values of the re-slug lookup, one per request, for `ids`: each is
 * `url.like.*\/<id>` filters joined by commas, at most `maxCount` ids and at most
 * `maxBytes` of encoded query value (the same greedy cut as `planUrlLookupSlices`,
 * whose per-slice cost model it reuses: `or=(` `)` is one encoded byte more than
 * `in.(` `)`, far inside the margin below the failing size). Duplicates are
 * looked up once. An id that is not all ASCII digits is dropped, so no other
 * character can reach the filter. Pure; never throws.
 */
export function planReslugFilters(
  ids: readonly string[],
  maxCount = RESLUG_LOOKUP_BATCH,
  maxBytes = URL_LOOKUP_MAX_BYTES,
): string[] {
  const filters = [...new Set(ids)]
    .filter((id) => typeof id === "string" && RESLUG_ID_RE.test(id))
    .map((id) => `url.like.*/${id}`);
  return planUrlLookupSlices(filters, maxCount, maxBytes).map((slice) => slice.join(","));
}

/**
 * Stamps every row of `rows` (new rows of source `slug`, none of them stored yet)
 * whose `stableArticleId` is stored for `sourceId` under a different url, created
 * at or after `nowMs - RESLUG_WINDOW_MS`, with `published_at = nowMs`. The rows
 * are mutated in place. No request is made when no row has an id. Returns the
 * number restamped, the number of lookup batches that failed and the urls of the
 * rows stamped (the caller counts the ones that survive the twin drop); never throws. On
 * failure ONE line is logged with `slug`, the count and a redacted, clamped message,
 * never a url, an id or a headline.
 */
export async function restampResluggedRows<T extends { url: string; published_at: string }>(
  supabase: ReturnType<typeof createServiceClient>,
  slug: string,
  sourceId: string,
  rows: readonly T[],
  nowMs: number,
): Promise<{ restamped: number; lookupErrors: number; urls: string[] }> {
  const idOf = new Map<T, string>();
  for (const row of rows) {
    const id = stableArticleId(slug, row.url);
    if (id !== null) idOf.set(row, id);
  }
  if (idOf.size === 0) return { restamped: 0, lookupErrors: 0, urls: [] };

  const storedUrlsById = new Map<string, Set<string>>();
  let lookupErrors = 0;
  let firstMessage: string | null = null;
  let restamped = 0;
  const stampedUrls: string[] = [];
  try {
    const sinceIso = new Date(nowMs - RESLUG_WINDOW_MS).toISOString();
    for (const orFilter of planReslugFilters([...idOf.values()])) {
      try {
        const { data, error } = await supabase
          .from("articles")
          .select("url")
          .eq("source_id", sourceId)
          .gte("created_at", sinceIso)
          .or(orFilter);
        if (error) {
          lookupErrors++;
          firstMessage ??= safeErrorMessage(error.message);
          continue;
        }
        for (const stored of (data ?? []) as Array<{ url?: unknown }>) {
          if (typeof stored.url !== "string") continue;
          const id = stableArticleId(slug, stored.url);
          if (id === null) continue;
          const urls = storedUrlsById.get(id);
          if (urls === undefined) storedUrlsById.set(id, new Set([stored.url]));
          else urls.add(stored.url);
        }
      } catch (err) {
        lookupErrors++;
        firstMessage ??= safeErrorMessage(err);
      }
    }
    if (storedUrlsById.size > 0) {
      const nowIso = new Date(nowMs).toISOString();
      for (const [row, id] of idOf) {
        const urls = storedUrlsById.get(id);
        if (urls === undefined) continue;
        for (const storedUrl of urls) {
          if (storedUrl !== row.url) {
            row.published_at = nowIso;
            restamped++;
            stampedUrls.push(row.url);
            break;
          }
        }
      }
    }
  } catch (err) {
    lookupErrors++;
    firstMessage ??= safeErrorMessage(err);
  }
  if (lookupErrors > 0) {
    console.error(`[ingest] ${slug}: re-slug lookup failed (${lookupErrors} batch(es)): ${firstMessage}`);
  }
  return { restamped, lookupErrors, urls: stampedUrls };
}

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
// keyed by the twin's NEW url, and (hunt-11) the stored rows the feed loop's
// `lookupStoredByUrl` already found for urls whose headline changed or that
// belong to another source. They seed `stored`, and only the urls not in it
// are selected, so a twin-only chunk makes no url query at all.
//
// `knownAbsent` (hunt-11): urls the feed loop's lookup already confirmed are
// NOT stored. They cannot match a stored row, so they are not selected again.
// A url in both sets is resolved (preResolved wins). Called with two or three
// arguments the behaviour is unchanged.
export async function recordTitleVersions(
  supabase: ReturnType<typeof createServiceClient>,
  chunk: readonly Pick<IngestArticleRow, "url" | "title" | "source_id">[],
  preResolved?: ReadonlyMap<string, { id: string; title: string; source_id: string }>,
  knownAbsent?: ReadonlySet<string>,
): Promise<RecordTitleVersionsResult> {
  const empty: RecordTitleVersionsResult = { titleVersions: 0, titleWriteBacks: 0 };
  try {
    if (chunk.length === 0) return empty;

    const stored = new Map<
      string,
      { id: string; title: string; source_id: string }
    >(preResolved ?? []);
    const urls = chunk
      .map((row) => row.url)
      .filter((url) => !stored.has(url) && !knownAbsent?.has(url));
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
  // Feed window overflow (migration 212). PRESENT only on a poll that found a
  // full-sized window with none of its urls stored; every other outcome (a normal
  // poll, a bootstrap, a 304, a failure) OMITS it, never null, so the writer's
  // coalesce keeps the last time an overflow was seen. A database still on the
  // pre-212 writer ignores the unknown key (jsonb_to_recordset).
  fetch_window_overflow_at?: string;
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
// `windowOverflowAt` (migration 212) is passed only by a poll that found its feed
// window overflowed; when it is absent the key is OMITTED, same discipline.
function buildFetchStateUpdate(
  source: SourceRow,
  status: number,
  ok: boolean,
  fresh?: { etag: string | null; lastModified: string | null; bodyHash: string | null },
  freshness?: FeedFreshness,
  windowOverflowAt?: string,
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
  if (windowOverflowAt !== undefined) {
    state.fetch_window_overflow_at = windowOverflowAt;
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

// True for the errors a missing column answers: Postgres 42703 (undefined
// column) and PostgREST PGRST204 ("Could not find the 'x' column of 'y' in the
// schema cache", what an insert naming an unknown column gets). Anything else
// is a real failure and is not retried.
function isMissingColumnError(error: { code?: string; message?: string }): boolean {
  if (error.code === "42703" || error.code === "PGRST204") return true;
  return /could not find the .* column|column .* does not exist/i.test(error.message ?? "");
}

// True when a missing-column error names `column` (Postgres: `column "x" of
// relation ... does not exist`; PostgREST: `Could not find the 'x' column of ...`).
// Both messages carry the column name; a plain substring check keeps it linear.
function errorNamesColumn(error: { message?: string }, column: string): boolean {
  return (error.message ?? "").includes(column);
}

// Best-effort telemetry write: one row per cycle in `ingest_cycles`
// (migration 039), regardless of whether the cycle finished cleanly or
// `runCycle` is unwinding through a thrown error. Errors here are logged
// and swallowed — a telemetry outage must never fail (or re-fail) a cycle.
//
// Migration 157 adds three counters (isolate_budget_deferred, parse_deferred,
// parse_deferred_max_streak) and migration 159 two more (stale_deferred,
// oldest_stale_min). An insert that names a column the table does not have fails
// the WHOLE row, so while either migration is not applied the first insert is
// retried ONCE without all five (the same pattern as the legacy sources select
// for migration 119). Ingest can therefore be deployed before or after 157 and
// 159; the counters are simply absent until the migrations are applied. Apply
// both first anyway: a cycle row written without them is a cycle you cannot
// count, and with 159 missing it also loses 157's three.
//
// Migration 212 adds `window_overflows`. A database that has 157 and 159 but not
// 212 answers the first insert with an error that NAMES that column, so the first
// retry drops only it and keeps the five counters above; any other missing-column
// error still goes straight to the legacy row. Ingest can be deployed before or
// after 212, and a late 212 never costs the 157 and 159 counters.
async function recordIngestCycle(
  supabase: ReturnType<typeof createServiceClient>,
  startedAt: number,
  stats: CycleStats,
): Promise<void> {
  try {
    const row = {
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
    };
    // Migration 157: how often the budgets deferred a changed feed this cycle,
    // and the longest streak of consecutive deferrals of one feed. Migration 159:
    // how many of the stale feeds were still deferred, and the age of the oldest.
    const withDeferral = {
      ...row,
      isolate_budget_deferred: stats.isolateBudgetDeferred,
      parse_deferred: stats.parseDeferred,
      parse_deferred_max_streak: stats.parseDeferredMaxStreak,
      stale_deferred: stats.staleDeferred,
      oldest_stale_min: stats.oldestStaleMin,
    };
    // Migration 212: feeds whose window overflowed this cycle (window_overflows).
    const { error } = await supabase.from("ingest_cycles").insert({
      ...withDeferral,
      window_overflows: stats.windowOverflows,
    });
    if (!error) return;
    if (!isMissingColumnError(error)) {
      console.error(`[ingest] ingest_cycles insert failed: ${error.message}`);
      return;
    }
    if (errorNamesColumn(error, "window_overflows")) {
      console.warn(
        "[ingest] ingest_cycles.window_overflows missing (migration 212 not applied?): inserting the row without it",
      );
      const second = await supabase.from("ingest_cycles").insert(withDeferral);
      if (!second.error) return;
      if (!isMissingColumnError(second.error)) {
        console.error(`[ingest] ingest_cycles insert failed: ${second.error.message}`);
        return;
      }
      // 157 or 159 is missing as well: fall through to the legacy row.
    }
    console.warn(
      "[ingest] ingest_cycles deferral columns missing (migration 157 not applied? or 159?): inserting the legacy row",
    );
    const retry = await supabase.from("ingest_cycles").insert(row);
    if (retry.error) {
      console.error(`[ingest] ingest_cycles insert failed: ${retry.error.message}`);
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
    twinsKeptDistinct: 0,
    twinsKeyCapped: 0,
    contentlessTitlesDropped: 0,
    adLinksDropped: 0,
    paidContentDropped: 0,
    foreignHostSkipped: 0,
    offHostItems: 0,
    parseDeferred: 0,
    parseDeferredMaxStreak: 0,
    parsedBytes: 0,
    freshnessBootstraps: 0,
    windowOverflows: 0,
    itemsKnownSkipped: 0,
    knownUrlLookupErrors: 0,
    reslugRestamped: 0,
    reslugLookupErrors: 0,
    keyReuseRestamped: 0,
    isolateItemsUsed: 0,
    isolateCycles: 0,
    isolateBudgetDeferred: 0,
    staleDeferred: 0,
    oldestStaleMin: 0,
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

  // h63-clusterintegrity-2: which active source owns which link host, built once
  // per cycle from EVERY active source (a quarantined one still owns its host;
  // `url` is part of SOURCES_SELECT_LEGACY, so both selects carry it). A host
  // that two active sources claim is left out, so an ambiguous host never skips
  // an item. Read in the feed loop below.
  const hostOwners = buildHostOwners(liveSources);
  // h130-feeds-2 (log only): the host of EVERY active source, an ambiguous one
  // included (`hostOwners` leaves those out), so `offHostItems` never counts a
  // registered host as foreign.
  const registeredHosts = new Set<string>();
  for (const s of liveSources) {
    const host = hostKey(s.url);
    if (host !== null) registeredHosts.add(host);
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
  //
  // h36-pipeline-1: a feed the budgets refuse writes no fetch state, and the
  // memory above is lost when the isolate recycles, so a big feed (BHA, 4.25 MB)
  // could stay unfetched for hours. The sources whose `fetch_last_at` is null
  // or older than three cycle periods are therefore put first, oldest first
  // (the first one meets a fresh isolate's `used === 0` admission); the
  // in-memory deferrals still go before those within an isolate.
  const toFetch = prioritizeIds(
    prioritizeStale(
      rotateForCycle(
        liveSources.filter((s) => !isQuarantined(s, startedAt)),
        startedAt,
      ),
      startedAt,
    ),
    priorityIds,
  );
  stats.quarantined = liveSources.length - toFetch.length;
  //
  // h39-pipeline2-1: that order is only the order the fetches START in; admission
  // follows the order the BODIES arrive in, and BHA's 4.25 MB body finishes last,
  // after the other feeds took the cycle's bytes and the isolate's items (7.17 MB
  // and 4,299 of 5,000 items on 2026-11-05 12:24Z), and it lost both budgets again.
  // So the stalest source with a known item count also gets its items RESERVED
  // before the pool starts (see `reserveItemsFor` below), and the stale ones are
  // counted for the cycle row. `staleIds` is `prioritizeStale`'s rule, read at
  // cycle start.
  //
  // Both read only the sources with NO quarantine marker (`fetch_quarantined_until`
  // null), which is ops_health_report() row 20's population. A source whose marker
  // has passed is still in `toFetch` (it is probed once, about every 1440 minutes)
  // and its `fetch_last_at` is that last attempt, so it would be the "oldest stale"
  // one on every probe cycle and would take the reservation from a feed that is
  // starved. The stale-first ORDER (`prioritizeStale` above) is unchanged.
  const unquarantined = toFetch.filter((s) => s.fetch_quarantined_until == null);
  const stale = summarizeStale(unquarantined, startedAt);
  const staleIds = stale.ids;
  stats.oldestStaleMin = stale.oldestMin;
  const staleReservation = pickStaleReservation(unquarantined, startedAt);
  // Read once per cycle; anything but a positive integer means the default.
  const maxParses = positiveIntEnv(Deno.env.get("INGEST_MAX_PARSES_PER_CYCLE"), MAX_PARSES_PER_CYCLE);
  const budget = createParseBudget(
    maxParses,
    positiveIntEnv(Deno.env.get("INGEST_PARSE_BUDGET_BYTES"), PARSE_BUDGET_BYTES),
  );
  // The isolate-wide item budget (hunt-11): module-scope state, so it carries
  // from one cycle to the next on a reused isolate and starts at zero on a cold
  // one. The limit is read per cycle like the two above.
  const isolateLimit = positiveIntEnv(
    Deno.env.get("INGEST_ISOLATE_ITEM_BUDGET"),
    ISOLATE_ITEM_BUDGET,
  );
  isolateItems.cycles++;
  const itemBudget = createItemBudget(isolateLimit, isolateItems);
  // Books the stale feed's items under the isolate limit (never over it, and with
  // no fresh-isolate exception), or makes no reservation when they do not fit: a
  // busy, reused isolate behaves as before. The booking is handed back, once, on
  // every path on which the feed is not parsed (see the fetch worker, and the
  // `finally` after the pool), or becomes the feed's own booking when it is.
  const reservation = reserveItemsFor(itemBudget, staleReservation);

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

  // hunt-114: url -> source slug of every row the fetch phase stamped with the
  // poll's clock. A restamped row can still be dropped as a stored twin in the
  // upsert phase, so it is counted and logged there, once it survives.
  const restampedUrls = new Map<string, string>();
  // h132-purity-1: the sources whose same-id rows are re-stamped by the re-slug
  // check above, left alone by the reused-id stamp of the upsert phase.
  const reslugSourceIds = new Set<string>(
    toFetch.filter((s) => STABLE_ARTICLE_ID_SOURCES.has(s.slug)).map((s) => s.id),
  );

  const allRows: IngestArticleRow[] = [];
  // Per-source intra-cycle de-dup so two section-slug variants of the same
  // article inside one feed collapse before the upsert. Keyed by
  // `${source_id}\x1f${content_hash}`.
  const seenIntraCycle = new Set<string>();
  // Twin-articles (migration 113): the headlines of the rows KEPT so far this
  // cycle per `${source_id}\x1fk\x1f${source_article_key}`. A later item with
  // the same key is a twin only when its headline shares words with one of
  // them (word-Jaccard >= TITLE_TWIN_MIN_JACCARD); an unrelated one is a
  // different story under a reused id and is kept (and added to the list).
  // Created per cycle, so nothing outlives it.
  // At most MAX_KEPT_TITLES_PER_KEY tokenized headlines per key: the feed is
  // untrusted input and an id repeated on thousands of items must not make the
  // gate quadratic.
  const keptTitlesByKey = new Map<string, Array<ReadonlySet<string>>>();
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
      // Migration 212: set only when this poll found its feed window overflowed.
      windowOverflowAt?: string;
    }
  >();
  // Sources with at least one row that was skipped, never attempted or failed.
  const unsettled = new Set<string>();
  // Sources with a row that failed in isolation (possibly poison): withheld
  // only for a bounded number of consecutive cycles.
  const rowFailed = new Set<string>();
  // The feed loop's stored-url lookups (`lookupStoredByUrl`), kept for the
  // upsert phase so `recordTitleVersions` does not select the same urls again:
  // the stored rows of items that were fully normalised after all (headline
  // changed, or stored under another source), and the urls confirmed absent.
  // Only successful lookups contribute; a failed one leaves its urls to
  // `recordTitleVersions`' own select, as before the lookup existed.
  const storedByUrl = new Map<string, StoredArticleRef>();
  const absentUrls = new Set<string>();

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
      // Items this feed booked on the isolate budget (0 = nothing booked).
      let booked = 0;
      const result = await fetchFeed(source, {
        conditionalCache,
        timeoutMs: FETCH_TIMEOUT_MS,
        knownBodyHash: bootstrap ? undefined : (source.fetch_body_hash ?? undefined),
        // Asked only when a changed body is about to be decoded and parsed.
        // The isolate's item budget is asked first (a pure check that books
        // nothing), then the per-cycle parse budget, which books when it says
        // yes; only then are the estimated items booked on the isolate. Either
        // refusal flows through `result.parseDeferred` below.
        admitParse: (bodyBytes) => {
          // The feed's last parsed item count (migration 119) caps the size
          // estimate: BHA's 4.25 MB is 1000 items, not 2,833 (h36-pipeline-1).
          // Only while the body is within 4x of that cap; a body far bigger
          // than the count explains keeps the size-only estimate.
          const estimated = estimateItems(bodyBytes, source.fetch_items_count);
          const priority = priorityIds.has(source.id);
          // h39-pipeline2-1: the feed this cycle reserved items for is admitted
          // against that booking. Its items are already in `used`, so only an
          // estimate ABOVE the reservation has to fit (and then under the limit,
          // there is no fresh-isolate exception while the reservation is held);
          // the per-cycle byte budget does not apply to it, `maxParses` does.
          const held = reservation.heldFor(source.id);
          if (held > 0) {
            if (estimated <= held || itemBudget.fits(estimated - held)) {
              if (!budget.admit(bodyBytes, priority, true)) return false;
              reservation.consume(estimated);
              booked = estimated;
              return true;
            }
            // The body grew far past what the feed's count explains and the extra
            // does not fit: hand the reservation back and judge the feed like any
            // other, so a lone feed on a fresh isolate is still admitted whatever
            // its size. The reservation never makes this worse than before.
            reservation.release();
          }
          if (!itemBudget.fits(estimated)) {
            stats.isolateBudgetDeferred++;
            return false;
          }
          // While the reservation is held, one parse slot is kept for the reserved
          // feed: the others may take at most maxParses - 1, so its body (it arrives
          // last) is not refused at the cap by 55 small feeds that came first. The
          // slot is freed with the reservation (304, error, release); the reserved
          // feed's own `budget.admit(.., .., true)` above still stops at maxParses.
          if (reservation.state === "held" && budget.parses + 1 >= maxParses) return false;
          if (!budget.admit(bodyBytes, priority)) return false;
          itemBudget.book(estimated);
          booked = estimated;
          return true;
        },
      });

      // h39-pipeline2-1: the reserved feed is back from the network. If it was
      // parsed, its reservation became its booking in `admitParse`; on every other
      // outcome (304, body-hash hit, fetch error, a refusal below) the items it
      // held go back to the isolate now, for the feeds still to come. A no-op for
      // any other feed, and once the reservation is consumed or released.
      if (source.id === staleReservation?.id) reservation.release();

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
        if (staleIds.has(source.id)) stats.staleDeferred++;
        const streak = (deferredBefore.get(source.id) ?? 0) + 1;
        parseDeferredIds.set(source.id, streak);
        if (streak > stats.parseDeferredMaxStreak) stats.parseDeferredMaxStreak = streak;
        if (cacheBeforeCopy) conditionalCache.set(source.id, cacheBeforeCopy);
        else conditionalCache.delete(source.id);
        return;
      }

      if (result.error) {
        // A failure keeps the source's previous validators (etag,
        // last-modified, body hash): `buildFetchStateUpdate` without a `fresh`
        // argument stores what the row already holds. That includes an
        // unparseable 2xx (HTML page, parse error, refused DOCTYPE entity),
        // for which fetcher.ts returns no validators and puts its conditional
        // cache back: adopting the refused body's validators would let the
        // next poll of the same bytes (body-hash short-circuit) or a 304 on its
        // ETag count as a healthy "not modified" and clear the quarantine
        // instead of advancing fetch_fail_streak (h27-live-1).
        stats.failed++;
        // ingest-health: an HTML/plain-text/404 body -- already counted in
        // `failed` above; broken out separately so this failure reason is
        // visible without grepping logs (and reaches quarantine the same
        // way any other fetch failure does).
        if (result.notAFeed) stats.notAFeed++;
        console.error(`[ingest] ${source.slug} fetch failed: ${result.error}`);
        const failState = buildFetchStateUpdate(source, result.status, false);
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
      // The estimate booked in `admitParse` becomes the real item count. A parse
      // that ends in an error (above) keeps its estimate: the CPU was spent.
      if (booked > 0) itemBudget.settle(booked, result.items.length);
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
      // Per source, so the log line below names the feed that sent the junk.
      const normalizeCounters = { contentlessTitles: 0, adLinks: 0, paidContent: 0 };
      // Phase 1 (hunt-11): the cheap half of the normalisation for every item.
      // A bootstrap whose body is the stored one prepares nothing.
      const preparedAll = bootstrapUnchanged
        ? []
        : prepareArticles(source, result.items, normalizeCounters);
      // h63-clusterintegrity-2: an item whose link host is the host of a DIFFERENT
      // active source is left to that source. The url upsert (`onConflict: "url"`,
      // `ignoreDuplicates`) gives a url to whichever source polls first, so
      // haberler.com's feed (which carried the sondakika.com stream from
      // 2026-11-06) took 2,014 of Son Dakika's rows and starved it. This is the
      // one place every row of the cycle passes through before the stored-url
      // lookup, the heavy normalisation, the twin bookkeeping and `allRows.push`,
      // so a skipped item costs none of them and registers no twin key; the
      // owner claims the url on its own poll. Filtering here also keeps
      // `isKnown` / `toComplete` / `completed` aligned with one list below.
      //
      // h130-feeds-2, LOG ONLY, same loop: an item that stays and whose host is
      // neither this source's own host (subdomains allowed) nor a registered
      // source's is counted as off-host. Nothing is dropped on that count. A
      // source whose own host cannot be read counts nothing.
      const leftToOwner = new Map<string, number>();
      const ownHost = hostKey(source.url);
      let offHost = 0;
      const prepared =
        hostOwners.size === 0 && ownHost === null
          ? preparedAll
          : preparedAll.filter((p) => {
              const owner = foreignHostOwner(p.url, source.id, hostOwners);
              if (owner === null) {
                if (ownHost !== null && isOffHostItem(hostKey(p.url), ownHost, registeredHosts)) {
                  offHost++;
                }
                return true;
              }
              leftToOwner.set(owner.slug, (leftToOwner.get(owner.slug) ?? 0) + 1);
              stats.foreignHostSkipped++;
              return false;
            });
      for (const [ownerSlug, count] of leftToOwner) {
        // Slugs and a count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: ${count} item(s) left to ${ownerSlug} (link host belongs to that source)`,
        );
      }
      if (normalizeCounters.contentlessTitles > 0) {
        stats.contentlessTitlesDropped += normalizeCounters.contentlessTitles;
        // Slug and count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: ${normalizeCounters.contentlessTitles} item(s) dropped: no headline text`,
        );
      }
      if (normalizeCounters.adLinks > 0) {
        stats.adLinksDropped += normalizeCounters.adLinks;
        // Slug and count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: ${normalizeCounters.adLinks} item(s) dropped: ad click link`,
        );
      }
      if (normalizeCounters.paidContent > 0) {
        stats.paidContentDropped += normalizeCounters.paidContent;
        // Slug and count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: ${normalizeCounters.paidContent} item(s) dropped: paid content url`,
        );
      }
      if (offHost > 0) {
        stats.offHostItems += offHost;
        // Slug and count only: never a url or a headline. Kept, not dropped.
        console.log(
          `[ingest] ${source.slug}: ${offHost} item(s) off-host (link host is neither the source's own nor a registered source's); kept`,
        );
      }

      // One batched lookup of which of those urls are already stored. An item
      // is KNOWN when its url is stored for this source under the same
      // headline (the comparison `recordTitleVersions` makes): the upsert
      // would ignore it, so it skips the heavy phase altogether. Fail-open:
      // when the lookup failed nothing is known, nothing is confirmed absent,
      // and every item takes the full path.
      const lookup =
        prepared.length > 0
          ? await lookupStoredByUrl(
              supabase,
              prepared.map((p) => p.url),
              source.slug,
            )
          : { byUrl: new Map<string, StoredArticleRef>(), ok: true };
      if (!lookup.ok) stats.knownUrlLookupErrors++;
      const isKnown: boolean[] = [];
      const toComplete: PreparedItem[] = [];
      for (const p of prepared) {
        const stored = lookup.ok ? lookup.byUrl.get(p.url) : undefined;
        if (stored !== undefined && stored.source_id === source.id && stored.title.trim() === p.title.trim()) {
          isKnown.push(true);
          continue;
        }
        isKnown.push(false);
        toComplete.push(p);
        // Kept for the upsert phase (see `storedByUrl` above).
        if (lookup.ok) {
          if (stored !== undefined) storedByUrl.set(p.url, stored);
          else absentUrls.add(p.url);
        }
      }
      // Feed window overflow (migration 212, h174-latency-1). The feed keeps only
      // its newest N items; a poll of a full-sized window whose urls are ALL
      // absent from `articles` (any source, any headline: a retitled url still
      // proves the windows touch) means the window moved past the previous poll
      // and items were never offered. Detection only. Fail-open: a failed lookup
      // or a bootstrap poll concludes nothing (see _shared/rss/feed-window.ts).
      let storedCount = 0;
      if (lookup.ok) {
        for (const p of prepared) {
          if (lookup.byUrl.get(p.url) !== undefined) storedCount++;
        }
      }
      let windowOverflowAt: string | undefined;
      if (
        isWindowOverflow({
          itemCount: prepared.length,
          storedCount,
          lookupOk: lookup.ok,
          bootstrap,
        })
      ) {
        stats.windowOverflows++;
        // Slug and count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: feed window overflow (${prepared.length} items, none stored before)`,
        );
        windowOverflowAt = new Date().toISOString();
      }
      // Phase 2: the heavy half, only for the items that are not known. The
      // result is aligned with `toComplete` (null: legal notice, or threw).
      const completed = completeArticles(source, toComplete, sourceNowMs);

      let pushed = 0;
      // hunt-114: the rows this loop pushes whose url is confirmed absent from
      // `articles`, for a source whose feed keeps the first url's pubDate on a
      // retitled article (STABLE_ARTICLE_ID_SOURCES). They are checked below.
      const resluggable: IngestArticleRow[] = [];
      const stableIdSource = STABLE_ARTICLE_ID_SOURCES.has(source.slug);
      let intraFeedTwins = 0;
      let intraFeedKeptDistinct = 0;
      let intraFeedKeyCapped = 0;
      let completedAt = 0;
      for (let pi = 0; pi < prepared.length; pi++) {
        const p = prepared[pi] as PreparedItem;
        const known = isKnown[pi] === true;
        let row: NormalizedArticle | null = null;
        if (known) {
          stats.itemsKnownSkipped++;
        } else {
          row = completed[completedAt++] ?? null;
          if (row === null) continue;
          stats.itemsNormalized++;
          const key = `${row.source_id}\x1f${row.content_hash}`;
          if (seenIntraCycle.has(key)) continue;
          seenIntraCycle.add(key);
        }
        // A known item never enters `seenIntraCycle` (the one accepted
        // divergence from fully normalising it): a LATER unknown item of the
        // cycle whose hash equals the known item's is no longer caught as an
        // intra-cycle repeat here. It is caught by the stored
        // (source_id, content_hash) pre-filter instead, because the known
        // item's row is stored with that hash whenever its text is unchanged;
        // if its description changed since, the later item is a different
        // article under another url and is now stored rather than dropped.
        //
        // Twin-articles (migration 113): the outlet's numeric article id from
        // the url. A second row of this feed with the same key is the same
        // article under an edited headline (new slug): skip it, the first one
        // stands -- unless its headline shares no words with ANY kept one, in
        // which case the CMS reused the id for another story and the item is
        // kept too. Null (no id in the url, or an excluded slug) is never
        // tracked, so it can never merge two rows. A known item takes part like
        // any other (same url, same cleaned title, same counters), so the
        // items after it see the registry exactly as if it had been completed;
        // it is just never pushed.
        const articleKey = sourceArticleKeyFor(source.slug, p.url);
        if (articleKey !== null) {
          const twinKey = `${source.id}\x1fk\x1f${articleKey}`;
          const rowTokens = titleTokens(p.title);
          const keptTitles = keptTitlesByKey.get(twinKey);
          if (keptTitles === undefined) {
            keptTitlesByKey.set(twinKey, [rowTokens]);
          } else if (
            keptTitles.some((t) => jaccardOfSets(rowTokens, t) >= TITLE_TWIN_MIN_JACCARD)
          ) {
            stats.twinsDroppedIntraFeed++;
            stats.twinsDropped++;
            intraFeedTwins++;
            continue;
          } else if (keptTitles.length < MAX_KEPT_TITLES_PER_KEY) {
            keptTitles.push(rowTokens);
            stats.twinsKeptDistinct++;
            intraFeedKeptDistinct++;
          } else {
            // The key already tracks its maximum: kept, not tracked.
            stats.twinsKeyCapped++;
            intraFeedKeyCapped++;
          }
        }
        if (row === null) continue;
        // Additive: canonicalizeUrl never throws (it catches internally and
        // falls back to the raw URL), so this is always a string in
        // practice — the column stays nullable for any future producer
        // that can't compute one.
        const pushedRow: IngestArticleRow = {
          ...row,
          canonical_url: canonicalizeUrl(row.url, source.slug),
          source_article_key: articleKey,
        };
        allRows.push(pushedRow);
        pushed++;
        // Absent = the stored-url lookup succeeded and found no row for this url
        // (under any source). A failed lookup confirms nothing, so nothing is
        // checked and every row keeps its parsed pubDate (fail-open).
        if (stableIdSource && lookup.ok && !lookup.byUrl.has(pushedRow.url)) {
          resluggable.push(pushedRow);
        }
      }
      // hunt-114: one lookup (per batch of 50 ids) for the AA ids of those rows.
      // The rows are already in `allRows` and the upsert phase starts only after
      // the whole fetch pool settles, so stamping them in place here is safe.
      if (resluggable.length > 0) {
        const reslug = await restampResluggedRows(
          supabase,
          source.slug,
          source.id,
          resluggable,
          sourceNowMs,
        );
        stats.reslugLookupErrors += reslug.lookupErrors;
        for (const url of reslug.urls) restampedUrls.set(url, source.slug);
      }
      if (intraFeedTwins > 0) {
        // Slug and count only: never a url or a headline.
        console.log(`[ingest] ${source.slug}: ${intraFeedTwins} intra-feed twin(s)`);
      }
      if (intraFeedKeptDistinct > 0) {
        // Slug and count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: ${intraFeedKeptDistinct} same-id item(s) kept, headline unrelated`,
        );
      }

      if (intraFeedKeyCapped > 0) {
        // Slug and count only: never a url or a headline.
        console.log(
          `[ingest] ${source.slug}: ${intraFeedKeyCapped} item(s) kept past the per-id headline cap (${MAX_KEPT_TITLES_PER_KEY})`,
        );
      }

      if (pushed === 0) {
        // Nothing to lose: no row of this feed can be starved, so the fresh
        // validators are safe to save right away.
        fetchStateUpdates.set(
          source.id,
          buildFetchStateUpdate(source, result.status, true, fresh, freshness, windowOverflowAt),
        );
        await maybeFlushFetchState(supabase, fetchStateUpdates);
      } else {
        // silent-feeds: saving these validators now (the old behaviour) means
        // a starved or failed upsert leaves the feed answered with a 304 /
        // body-hash hit forever while its rows never landed. Park them, and
        // put the module cache back as it was before `fetchFeed` stamped the
        // fresh values on it; both are committed once the rows are durable.
        deferred.set(source.id, {
          source,
          status: result.status,
          fresh,
          freshness,
          windowOverflowAt,
        });
        if (cacheBeforeCopy) conditionalCache.set(source.id, cacheBeforeCopy);
        else conditionalCache.delete(source.id);
      }
    },
    fetchDeadline,
  ).finally(() => {
    // A reserved feed the pool never reached (the fetch deadline passed first), or
    // one whose worker threw: the reservation must not outlive the cycle, it
    // would stay on this isolate's allowance until the platform recycles it.
    reservation.release();
  });
  stats.parsedBytes = budget.bytes;
  if (stats.parseDeferred > 0) {
    // Count only: never a url or a headline.
    console.log(
      `[ingest] parse budget: deferred ${stats.parseDeferred} changed feed(s) to the next cycle (parsed ${budget.parses}, ${budget.bytes} bytes, longest deferral streak ${stats.parseDeferredMaxStreak})`,
    );
  }
  stats.isolateItemsUsed = isolateItems.used;
  stats.isolateCycles = isolateItems.cycles;
  if (stats.staleDeferred > 0) {
    // Count and age only: never a url or a headline. A stale feed that is still
    // deferred means it found no room this cycle (a reused isolate with no room
    // for a reservation, or the parse cap): see ingest_cycles.stale_deferred.
    console.log(
      `[ingest] stale feeds: ${stats.staleDeferred} still deferred (oldest unpolled ${stats.oldestStaleMin} min, reservation ${reservation.state}, ${isolateItems.used} of ${isolateLimit} items used on this isolate)`,
    );
  }
  if (stats.isolateBudgetDeferred > 0) {
    // Count only: never a url or a headline. These feeds are also in
    // `parseDeferred` above (the same deferral path); this line says why.
    console.log(
      `[ingest] isolate item budget: deferred ${stats.isolateBudgetDeferred} changed feed(s) (${isolateItems.used} of ${isolateLimit} items used on this isolate, cycle ${isolateItems.cycles} on it)`,
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
      // source ids (one per row in the worst case). The pairwise lookup
      // (migration 130) no longer builds a query string out of them, but
      // grouping keeps each PREFILTER_CHUNK-sized slice on few sources, so
      // the index probes of one RPC call stay on neighbouring index pages
      // (and the legacy `.in("source_id", ids)` fallback, which would hit
      // the migration 074 proxy-limit failure mode, stays short).
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
      // source_article_key) is already stored under a different url, with a
      // headline that shares words with the row's, is the same article under
      // an edited headline -- it is not inserted. A same-key row with an
      // unrelated headline is a different story under a reused id: it stays in
      // `chunk` and counts as `keptDistinct`.
      // h132-purity-1: a kept reused-id row whose pubDate predates the id's first
      // sighting is stamped with this clock (taken right before the lookup).
      const keyReuseNowMs = Date.now();
      const {
        rows: chunk,
        twins,
        lookupErrors: twinLookupErrors,
        keptDistinct,
        restampedUrls: keyReuseUrls,
      } = await dropExistingSourceArticleKeyRows(
        supabase,
        afterContentHash,
        twinSinceIso,
        keyReuseNowMs,
        reslugSourceIds,
        // h133: rows this cycle inserted in an earlier chunk are not a prior sighting.
        startedAt,
      );
      // hunt-114: the re-slugged rows that survived every drop above are the ones
      // that reach the database stamped with the poll's clock.
      if (restampedUrls.size > 0) {
        const keptBySlug = new Map<string, number>();
        for (const r of chunk) {
          const slug = restampedUrls.get(r.url);
          if (slug !== undefined) keptBySlug.set(slug, (keptBySlug.get(slug) ?? 0) + 1);
        }
        for (const [slug, kept] of keptBySlug) {
          stats.reslugRestamped += kept;
          // Slug and count only: never a url or a headline.
          console.log(`[ingest] ${slug}: ${kept} re-slugged item(s) stamped with first-seen time`);
        }
      }
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
      if (keyReuseUrls.length > 0) {
        stats.keyReuseRestamped += keyReuseUrls.length;
        // Count only: never a url, a key or a headline.
        console.log(
          `[ingest] restamped ${keyReuseUrls.length} same-id row(s) whose pubDate predates the id's first sighting in chunk ${i}-${i + rawChunk.length}`,
        );
      }
      if (keptDistinct > 0) {
        stats.twinsKeptDistinct += keptDistinct;
        // Count only: never the url or the headline.
        console.log(
          `[ingest] kept ${keptDistinct} row(s) sharing (source_id, source_article_key) with a stored article but an unrelated headline in chunk ${i}-${i + rawChunk.length}`,
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
      // Also resolved without a url select (hunt-11): the stored rows the feed
      // loop's lookup found for this chunk's urls (headline changed, or stored
      // under another source). Twins go last: they win a clash.
      const preResolved = new Map<string, StoredArticleRef>();
      for (const row of [...chunk, ...twinRows]) {
        const found = storedByUrl.get(row.url);
        if (found !== undefined) preResolved.set(row.url, found);
      }
      for (const t of twins) {
        preResolved.set(t.row.url, {
          id: t.existing.id,
          title: t.existing.title,
          source_id: t.existing.source_id,
        });
      }
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
          ? recordTitleVersions(supabase, [...chunk, ...twinRows], preResolved, absentUrls)
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
      buildFetchStateUpdate(d.source, d.status, true, d.fresh, d.freshness, d.windowOverflowAt),
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
    // The validators stay old (the feed is re-offered), but the freshness (and the
    // window overflow, migration 212) is a fact about the feed, not about row
    // durability: it is saved either way.
    fetchStateUpdates.set(
      id,
      buildFetchStateUpdate(d.source, d.status, true, undefined, d.freshness, d.windowOverflowAt),
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

// The CLUSTER_KICK secret, read per request (so the polyfilled env of the tests
// and a `supabase secrets set` between two invocations of a warm isolate both
// take effect). Deno.env.get can throw under restricted permissions: any other
// outcome than the exact string "on" is no kick.
function readKickFlag(): string | undefined {
  try {
    return Deno.env.get(KICK_ENV) ?? undefined;
  } catch {
    return undefined;
  }
}

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
    const response = new Response(JSON.stringify({ ok: true, ...stats }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
    // h106-attachdesign-1: kick cluster-consumer so the articles this cycle
    // just enqueued are read in seconds, not at the next cron minute (attach
    // wait p50 55 s). Behind the Edge secret CLUSTER_KICK=on and only when the
    // cycle inserted something. NEVER awaited: pg_net starts its next batch
    // only after this request has ended, so a handler that waited for the
    // consumer would hold ingest-drain open and queue cluster-drain behind it
    // (the #252 failure mode, h102-pollregression-1). scheduleClusterKick hands
    // the request to EdgeRuntime.waitUntil and returns void; it never throws,
    // and a failed kick is warned about and captured, never able to change this
    // response (see _shared/kick.ts).
    if (shouldKick(readKickFlag(), stats.inserted)) {
      scheduleClusterKick(undefined, { capture: (kickErr) => captureException("ingest", kickErr) });
    }
    return response;
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
