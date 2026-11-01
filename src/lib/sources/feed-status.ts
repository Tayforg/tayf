import { cacheLife, cacheTag } from "next/cache";

import { BIAS_TO_ZONE, isVotingKind } from "@/lib/bias/config";
import { attemptCached } from "@/lib/cache-resilience";
import { normalizeSourceKind } from "@/lib/sources/kind";
import { classifySilence, type SilenceReason } from "@/lib/sources/silence-reason";
import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

// /kaynaklar/durum — the public evidence page behind every "N/M kaynak"
// denominator footnote on /sources and /blindspots (see
// src/components/source/denominator-note.tsx). A share like "zone X covered
// 80% of a story" is only ever computed against sources that actually
// delivered an article in the trailing 72 h (`FEED_YIELD_WINDOW_MS`, owned
// by src/lib/clusters/feed-health.ts, which applies the same window as the
// aggregate per-zone health/degraded rule this page's per-source detail
// backs up). This module answers the reader's next question — "which N
// kaynak, and why isn't the other M-N counted?" — one row per active
// source.
//
// PERF-01: three separate cached round-trips, each sized to what it feeds,
// instead of one query that blocks first paint on the slowest column:
//
//   * `getSourceFeedStatuses()` — the CORE row set behind /kaynaklar/durum's
//     table (name/zone/kind/last item/last HTTP status/silent). Built on
//     the `latest:articles(published_at)` embed only — NEVER
//     `stats:articles(count)`, which PERF-01 measured bimodal against
//     production (177-4639 ms; the repo's own "~4.5 s" warning in
//     active-count.ts reproduces exactly). `latest` alone is cheap (~33-
//     122 ms measured) because it's a single ordered, limited index range
//     scan (idx_articles_source_published, migration 044), not a
//     per-source aggregate.
//   * `getSourceItemsPerDay()` — the 7-day items/day column, isolated so
//     /kaynaklar/durum can stream just that column behind a nested
//     <Suspense> instead of blocking the whole table. Hunt 12 (h12-ops-2):
//     it reads `public.source_items_7d()` (migration 137), ONE set-based
//     query (an index-only lookup per active source on
//     idx_articles_source_published_inc_id), not the per-source
//     `stats:articles(count)` embed. That embed was a LATERAL json_agg per
//     source and hit the 8 s PostgREST timeout about 12 times a day
//     (pg_stat_statements: mean 2515 ms, max 7937 ms), which left the column
//     as "—" for the 'minutes' lifetime of a failed attempt. A database
//     without 137 answers the RPC with PostgREST PGRST202 ("function not in
//     the schema cache"); the read then runs the old embed once
//     (`fetchSourceItemsPerDayLegacy`), so deploying the app before applying
//     the migration only costs the old speed, never the column. Any other
//     error throws, the unchanged contract below.
//   * `getFeedStatusSummary()` — a cheap existence-probe (`recent:
//     articles(id)` + `limit(1, ...)`, same shape as
//     src/lib/sources/active-count.ts and src/lib/clusters/feed-health.ts)
//     for pages that only need the two DenominatorNote integers, not a
//     full per-source row set. /sources doesn't even call this — it
//     derives the same pair for free from rows getSources() already
//     fetched (see src/app/sources/page.tsx).
//
// DURUM-01: `latest` has NO lower bound (a 7-day, then a 30-day floor were
// both tried and both moved the "still renders as a blank '—'" cliff
// instead of removing it — 8 active production sources have a genuine
// last-item timestamp older than 30 days). `.order(...).limit(1, ...)`
// alone returns the true newest row regardless of age, measured cheap (see
// above), so there is no cost reason to bound it either.
//
// SEC-01: `latest` (and `getFeedStatusSummary`'s `recent` probe) DO have an
// upper bound — `.lte(..., nowIso)` — because a source-controlled future
// `published_at` (confirmed live in production: 15 future-dated CNN Türk
// articles, root-caused to supabase/functions/_shared/rss/normalize.ts's
// unclamped `parseDate()`) must not count as "just delivered" forever.
//
// A-H1: `summariseFeedStatus` returns BOTH an `all` tally (every active
// source — what /kaynaklar/durum's own zone cards/totals report, since
// that page lists every active source with a `kind` column) and a `voting`
// tally (only outlet/wire — the real denominator every DenominatorNote
// share footnote must use, since aggregator/niche sources never feed
// bias_distribution/blindspot/trends).
//
// SEC-03: bias -> zone mapping is narrowed defensively (never asserted) —
// an unmapped bias value degrades to "row dropped" rather than a 500 on the
// flagship page, mirroring src/app/sources/page.tsx's `getSources()` guard.
//
// Migration 119 (feed freshness): ingest stores the newest item date a feed
// reports (`fetch_newest_item_at`) and its item count (`fetch_items_count`) next
// to the fetch status. A silent source is labelled with WHY (SilenceReason, see
// src/lib/sources/silence-reason.ts): the feed could not be fetched, the feed
// answers but is frozen, or it is current and the outlet just published nothing
// new. The row exposes only the reason, never the raw timestamps. A database
// without 119 answers the select below with Postgres 42703; the query is then
// retried once with the select that ran before 119, and every silent source
// reads as reachable-and-current (`sessiz`) or `erişim yok` from its status.
//
// Fail-open discipline, and what a failure costs (2026-10-24 /sources '—'
// incident): a `"use cache"` body must never throw (a throw there fails
// `next build`'s prerender even when the caller catches), so each reader splits
// into a raw `fetchX` that THROWS on a Supabase error, a `getXCached` that runs
// it through `attemptCached` and only THEN picks the cache lifetime, and the
// public `getX` that unwraps to `null` = "unknown". The lifetime used to be
// fixed before the query ran, so one transient timeout was memoised as `null`
// for the whole 1 h `source-directory` window and every denominator footnote
// read "—" for that hour. Now a success keeps `source-directory` and a failure
// is cached for `minutes` only. Callers keep the contract: `null` renders an
// honest "durum bilinmiyor" state instead of a fabricated figure. There is
// deliberately no live retry: the fetchers read `Date.now()`, which is only
// allowed inside the cache scope on these static routes (same rule and shape as
// src/lib/clusters/timeline-query.ts, guarded by
// tests/guards/cache-life-after-attempt.test.ts).

export interface SourceFeedStatus {
  slug: string;
  name: string;
  bias: BiasCategory;
  zone: MediaDnaZone;
  kind: SourceKind;
  lastItemAt: string | null;
  lastHttpStatus: number | null;
  lastFetchAt: string | null;
  silent: boolean;
  /** Consecutive ingest fetch failures (migration 074). Defaults to 0. */
  failStreak: number;
  /** True while `fetch_quarantined_until` is still in the future. */
  quarantined: boolean;
  /** Why the source is silent (migration 119); null when it is not silent. */
  silenceReason: SilenceReason | null;
}

// Local 3-line quarantine check -- deliberately not imported from
// `supabase/functions/_shared/rss/quarantine.ts` (Deno-side code, not part
// of this Next.js bundle's module graph). Same semantics as that module's
// `isQuarantined`: an unparseable/absent `until` is never quarantined.
function isRowQuarantined(until: string | null | undefined, nowMs: number): boolean {
  if (until == null) return false;
  return Date.parse(until) > nowMs;
}

/** Raw shape of one row from the `getSourceFeedStatuses` select below. */
export interface SourceFeedStatusRawRow {
  slug: string;
  name: string;
  bias: BiasCategory;
  kind?: SourceKind | string | null;
  fetch_last_status: number | null;
  fetch_last_at: string | null;
  fetch_fail_streak?: number | null;
  fetch_quarantined_until?: string | null;
  /** Migration 119: newest item date the feed reported at its last parse. */
  fetch_newest_item_at?: string | null;
  /** Migration 119: entries the feed held at its last parse (null = never measured). */
  fetch_items_count?: number | null;
  latest?: Array<{ published_at: string }>;
}

/**
 * Pure shaper — the counting rules, unit-testable without Supabase.
 *
 * Never throws: a row whose `latest` embed is entirely missing (not just an
 * empty array — the key itself absent, e.g. a hand-built fixture or a
 * future select that drops the alias) degrades to "no last item" instead of
 * a TypeError, since every "use cache" caller must not throw. A row whose
 * `bias` has no zone mapping (SEC-03 — should never happen, DB has a CHECK
 * constraint, but defended anyway) is dropped rather than throwing.
 */
export function toFeedStatusRows(
  rows: readonly SourceFeedStatusRawRow[],
  nowMs: number,
): SourceFeedStatus[] {
  const out: SourceFeedStatus[] = [];

  for (const row of rows) {
    const zone = BIAS_TO_ZONE[row.bias];
    if (!zone) continue;

    const lastItemAt = row.latest?.[0]?.published_at ?? null;
    const lastItemAtMs = lastItemAt ? new Date(lastItemAt).getTime() : null;

    // Silent = no last-item timestamp at all, a future-dated timestamp
    // (SEC-01 — a source-controlled pubDate must never count as "just
    // delivered"), or the last item fell outside the trailing 72h yield
    // window (strict `>` — a last item exactly at the window edge still
    // counts as delivering).
    const silent =
      lastItemAtMs === null ||
      lastItemAtMs > nowMs ||
      nowMs - lastItemAtMs > FEED_YIELD_WINDOW_MS;

    const failStreak = row.fetch_fail_streak ?? 0;
    const quarantined = isRowQuarantined(row.fetch_quarantined_until, nowMs);
    const lastHttpStatus = row.fetch_last_status ?? null;

    out.push({
      slug: row.slug,
      name: row.name,
      bias: row.bias,
      zone,
      kind: normalizeSourceKind(row.kind),
      lastItemAt,
      lastHttpStatus,
      lastFetchAt: row.fetch_last_at ?? null,
      silent,
      failStreak,
      quarantined,
      silenceReason: silent
        ? classifySilence(
            {
              lastHttpStatus,
              failStreak,
              quarantined,
              newestFeedItemAt: row.fetch_newest_item_at ?? null,
              feedItemsCount: row.fetch_items_count ?? null,
            },
            nowMs,
          )
        : null,
    });
  }

  return out;
}

export interface ZoneFeedStatusTally {
  total: number;
  delivering: number;
  silent: number;
}

export interface FeedStatusSummary {
  total: number;
  delivering: number;
  silent: number;
  byZone: Record<MediaDnaZone, ZoneFeedStatusTally>;
}

export interface FeedStatusSummaryPair {
  /** Every active source, regardless of kind. */
  all: FeedStatusSummary;
  /**
   * Only voting kinds (outlet/wire) — the real denominator every "N/M
   * kaynak" DenominatorNote footnote on /sources and /blindspots must use.
   * Aggregator/niche sources are listed on /kaynaklar/durum (with a `kind`
   * column) but never counted here, since they never feed
   * bias_distribution/blindspot/trends (A-H1).
   */
  voting: FeedStatusSummary;
}

function emptyZoneTally(): ZoneFeedStatusTally {
  return { total: 0, delivering: 0, silent: 0 };
}

function emptySummary(): FeedStatusSummary {
  return {
    total: 0,
    delivering: 0,
    silent: 0,
    byZone: {
      iktidar: emptyZoneTally(),
      bagimsiz: emptyZoneTally(),
      muhalefet: emptyZoneTally(),
    },
  };
}

function tallyInto(summary: FeedStatusSummary, row: SourceFeedStatus): void {
  const bucket = summary.byZone[row.zone];
  // SEC-03: defensive — toFeedStatusRows already drops rows whose bias has
  // no zone mapping, so `bucket` should always exist for a real
  // `SourceFeedStatus`, but a hand-built one (a future caller, a test) must
  // not throw here either.
  if (!bucket) return;

  summary.total += 1;
  if (row.silent) {
    summary.silent += 1;
    bucket.silent += 1;
  } else {
    summary.delivering += 1;
    bucket.delivering += 1;
  }
  bucket.total += 1;
}

/**
 * Pure directory-wide + per-zone tally over already-shaped rows (the output
 * of `toFeedStatusRows`). This is the one place "how many kaynak count as
 * the denominator" is computed — see the file header (A-H1) for why the
 * result carries both an `all` and a `voting` tally, and
 * `src/components/source/denominator-note.tsx` for how `voting` is used.
 */
export function summariseFeedStatus(
  rows: readonly SourceFeedStatus[],
): FeedStatusSummaryPair {
  const all = emptySummary();
  const voting = emptySummary();

  for (const row of rows) {
    tallyInto(all, row);
    if (isVotingKind(row.kind)) {
      tallyInto(voting, row);
    }
  }

  return { all, voting };
}

// The select that ran before migration 119, and the current one. The retry on
// Postgres 42703 (undefined column) falls back to the legacy string.
const FEED_STATUS_SELECT_LEGACY =
  "id, name, slug, url, bias, kind, active, fetch_last_status, fetch_last_at, fetch_fail_streak, fetch_quarantined_until, latest:articles(published_at)";
const FEED_STATUS_SELECT =
  "id, name, slug, url, bias, kind, active, fetch_last_status, fetch_last_at, fetch_fail_streak, fetch_quarantined_until, fetch_newest_item_at, fetch_items_count, latest:articles(published_at)";

// Raw read: THROWS on a Supabase error so a failure can never be mistaken for
// "no active sources". Runs inside `getSourceFeedStatusesCached`, so the clock
// read below stays within the cache scope.
async function fetchSourceFeedStatuses(): Promise<SourceFeedStatus[]> {
  const nowMs = Date.now();
  const supabase = createServerClient();
  const nowIso = new Date(nowMs).toISOString();

  const query = (columns: string) =>
    supabase
      .from("sources")
      .select(columns)
      .eq("active", true)
      .lte("latest.published_at", nowIso)
      .order("published_at", { referencedTable: "latest", ascending: false })
      .limit(1, { referencedTable: "latest" })
      .order("name", { ascending: true });

  let { data, error } = await query(FEED_STATUS_SELECT);
  if (error?.code === "42703") {
    // Migration 119 is not applied yet: one retry with the select that ran
    // before it. Never a loop; a second error falls through to the throw.
    ({ data, error } = await query(FEED_STATUS_SELECT_LEGACY));
  }

  if (error) {
    throw new Error(`source feed statuses query failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as SourceFeedStatusRawRow[];
  return toFeedStatusRows(rows, nowMs);
}

// `attemptCached` swallows whatever the fetch throws instead of letting it
// cross the `"use cache"` boundary. Lifetime follows the outcome: rows keep
// the `source-directory` window, a failed attempt is memoised for `minutes`
// only. Exactly one `cacheLife` call per invocation, after the attempt;
// `cacheTag` first.
async function getSourceFeedStatusesCached() {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("feed-status", fetchSourceFeedStatuses);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Per-source feed status CORE for every active source — the row-level
 * evidence behind /kaynaklar/durum's table (name/zone/kind/last item/last
 * HTTP status/silent) and, via `summariseFeedStatus`, the directory-wide
 * tallies. Does NOT include the 7-day items/day figure — see
 * `getSourceItemsPerDay()`. `null` means "status unknown" (a Supabase
 * error) — callers must render an honest empty state, never a fabricated
 * figure; `[]` means it read fine and there are no active sources. Never
 * throws. See the file header for the fail-open contract.
 */
export async function getSourceFeedStatuses(): Promise<SourceFeedStatus[] | null> {
  const r = await getSourceFeedStatusesCached();
  return r.ok ? r.data : null;
}

/** Raw shape of one row from the legacy `getSourceItemsPerDay` embed below. */
export interface ItemsPerDayRawRow {
  slug: string;
  stats?: Array<{ count: number }>;
}

/** One row of `public.source_items_7d()` (migration 137): the 7-day article count of an active source. */
export interface ItemsPerDayRpcRow {
  slug: string;
  items: number;
}

/**
 * Pure shaper for the legacy embed's items/day map — unit-testable without
 * Supabase, same spirit as `toFeedStatusRows`. Never throws: a row missing
 * `stats` entirely degrades to 0 items/day.
 */
export function toItemsPerDayMap(
  rows: readonly ItemsPerDayRawRow[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const count = row.stats?.[0]?.count ?? 0;
    out[row.slug] = Math.round((count / 7) * 10) / 10;
  }
  return out;
}

/**
 * Pure shaper for `source_items_7d()` rows: items / 7, one decimal. Never
 * throws: a count that is not a finite, non-negative number reads as 0, so a
 * malformed row cannot poison the column with NaN or a negative rate.
 */
export function toItemsPerDayMapFromRpc(
  rows: readonly ItemsPerDayRpcRow[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) {
    const items =
      typeof row.items === "number" && Number.isFinite(row.items) && row.items > 0
        ? row.items
        : 0;
    out[row.slug] = Math.round((items / 7) * 10) / 10;
  }
  return out;
}

// The pre-137 read, moved as-is: one embed, a LATERAL json_agg per source. Only
// reached while migration 137 is not applied (PGRST202). THROWS on a Supabase
// error (see `fetchSourceFeedStatuses`).
async function fetchSourceItemsPerDayLegacy(): Promise<Record<string, number>> {
  const supabase = createServerClient();
  const sevenDaysAgoIso = new Date(
    Date.now() - 7 * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select("slug, stats:articles(count)")
    .eq("active", true)
    .gte("stats.published_at", sevenDaysAgoIso);

  if (error) {
    throw new Error(`source items/day query failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as ItemsPerDayRawRow[];
  return toItemsPerDayMap(rows);
}

// Raw read: THROWS on a Supabase error (see `fetchSourceFeedStatuses`).
async function fetchSourceItemsPerDay(): Promise<Record<string, number>> {
  const supabase = createServerClient();

  const { data, error } = await supabase.rpc("source_items_7d");

  // Migration 137 is not applied (or PostgREST has not reloaded its schema cache
  // yet): one fall back to the old embed. Never a loop; its error is thrown.
  if (error?.code === "PGRST202") return fetchSourceItemsPerDayLegacy();

  if (error) {
    throw new Error(`source items/day query failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as ItemsPerDayRpcRow[];
  return toItemsPerDayMapFromRpc(rows);
}

// Same shape as `getSourceFeedStatusesCached`: tag, attempt, then one lifetime.
async function getSourceItemsPerDayCached() {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("items-per-day", fetchSourceItemsPerDay);
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * slug -> 7-day items/day (rounded to one decimal) for every active source,
 * from `public.source_items_7d()` (migration 137). Isolated so
 * /kaynaklar/durum's table shell can paint from the cheap
 * `getSourceFeedStatuses()` core while this streams in behind its own nested
 * <Suspense> for just the "7 günlük gün başına haber" column. Before 137 is
 * applied it runs the legacy `stats:articles(count)` embed instead (PGRST202).
 * `null` means "unknown" (a Supabase error); callers should render a neutral
 * placeholder ("—"), not fabricate 0. Never throws.
 */
export async function getSourceItemsPerDay(): Promise<Record<string, number> | null> {
  const r = await getSourceItemsPerDayCached();
  return r.ok ? r.data : null;
}

/** Raw shape of one row from the `getFeedStatusSummary` select below. */
interface FeedStatusSummaryRawRow {
  kind?: SourceKind | string | null;
  recent?: Array<{ id: string }>;
}

export interface FeedStatusSummaryCounts {
  delivering: number;
  total: number;
}

// Raw read: THROWS on a Supabase error (see `fetchSourceFeedStatuses`).
async function fetchFeedStatusSummary(): Promise<FeedStatusSummaryCounts> {
  const supabase = createServerClient();
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const yieldSince = new Date(nowMs - FEED_YIELD_WINDOW_MS).toISOString();

  const { data, error } = await supabase
    .from("sources")
    .select("kind, recent:articles(id)")
    .eq("active", true)
    .gte("recent.published_at", yieldSince)
    // SEC-01: bound the probe on both sides — see the file header.
    .lte("recent.published_at", nowIso)
    .limit(1, { referencedTable: "recent" });

  if (error) {
    throw new Error(`feed status summary query failed: ${error.message}`);
  }

  const rows = (data ?? []) as unknown as FeedStatusSummaryRawRow[];
  let total = 0;
  let delivering = 0;
  for (const row of rows) {
    if (!isVotingKind(row.kind)) continue;
    total += 1;
    if ((row.recent?.length ?? 0) > 0) delivering += 1;
  }
  return { total, delivering };
}

// Same shape as `getSourceFeedStatusesCached`: tag, attempt, then one lifetime.
async function getFeedStatusSummaryCached() {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("feed-summary", fetchFeedStatusSummary);
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Cheap voting-kind `{ delivering, total }` pair for a DenominatorNote
 * footnote — an existence probe (`recent:articles(id)` +
 * `limit(1, { referencedTable: "recent" })`, the same shape as
 * src/lib/sources/active-count.ts and src/lib/clusters/feed-health.ts),
 * never the `stats:articles(count)` aggregate. Used by /blindspots and /hafta,
 * which have no per-source rows of their own; /sources derives the same pair
 * for free from rows `getSources()` already fetched instead of calling this
 * (see src/app/sources/page.tsx). `null` means "unknown" (a Supabase
 * error) — callers must render the wording-without-numbers fallback. Never
 * throws.
 */
export async function getFeedStatusSummary(): Promise<FeedStatusSummaryCounts | null> {
  const r = await getFeedStatusSummaryCached();
  return r.ok ? r.data : null;
}
