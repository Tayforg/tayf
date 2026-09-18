import { cacheLife, cacheTag } from "next/cache";

import { BIAS_TO_ZONE, isVotingKind } from "@/lib/bias/config";
import { normalizeSourceKind } from "@/lib/sources/kind";
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
//   * `getSourceItemsPerDay()` — the ONLY place `stats:articles(count)`
//     still runs, isolated so /kaynaklar/durum can stream just its "7
//     günlük gün başına haber" column behind a nested <Suspense> instead of
//     blocking the whole table.
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
// Fail-open discipline (mirrors src/lib/sources/active-count.ts and
// src/lib/clusters/feed-health.ts verbatim): never throw. A Supabase error
// resolves to `null`, and every caller renders an honest "durum bilinmiyor"
// state instead of a fabricated figure — a throw inside "use cache" during
// prerender fails the Vercel build even though the caller catches.

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
}

/** Raw shape of one row from the `getSourceFeedStatuses` select below. */
export interface SourceFeedStatusRawRow {
  slug: string;
  name: string;
  bias: BiasCategory;
  kind?: SourceKind | string | null;
  fetch_last_status: number | null;
  fetch_last_at: string | null;
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

    out.push({
      slug: row.slug,
      name: row.name,
      bias: row.bias,
      zone,
      kind: normalizeSourceKind(row.kind),
      lastItemAt,
      lastHttpStatus: row.fetch_last_status ?? null,
      lastFetchAt: row.fetch_last_at ?? null,
      silent,
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

/**
 * Per-source feed status CORE for every active source — the row-level
 * evidence behind /kaynaklar/durum's table (name/zone/kind/last item/last
 * HTTP status/silent) and, via `summariseFeedStatus`, the directory-wide
 * tallies. Does NOT include the 7-day items/day figure — see
 * `getSourceItemsPerDay()`. `null` means "status unknown" (a Supabase
 * error) — callers must render an honest empty state, never a fabricated
 * figure. See the file header for the fail-open contract.
 */
export async function getSourceFeedStatuses(): Promise<SourceFeedStatus[] | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  const nowMs = Date.now();

  try {
    const supabase = createServerClient();
    const nowIso = new Date(nowMs).toISOString();

    const { data, error } = await supabase
      .from("sources")
      .select(
        "id, name, slug, url, bias, kind, active, fetch_last_status, fetch_last_at, latest:articles(published_at)",
      )
      .eq("active", true)
      .lte("latest.published_at", nowIso)
      .order("published_at", { referencedTable: "latest", ascending: false })
      .limit(1, { referencedTable: "latest" })
      .order("name", { ascending: true });

    if (error) {
      // Never throw — see the file header. A "use cache" throw during
      // prerender fails the Vercel build even though callers catch.
      console.warn(`[feed-status] status unknown: ${error.message}`);
      return null;
    }

    const rows = (data ?? []) as unknown as SourceFeedStatusRawRow[];
    return toFeedStatusRows(rows, nowMs);
  } catch (err) {
    console.warn(
      `[feed-status] status unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Raw shape of one row from the `getSourceItemsPerDay` select below. */
export interface ItemsPerDayRawRow {
  slug: string;
  stats?: Array<{ count: number }>;
}

/**
 * Pure shaper for the items/day map — unit-testable without Supabase, same
 * spirit as `toFeedStatusRows`. Never throws: a row missing `stats`
 * entirely degrades to 0 items/day.
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
 * slug -> 7-day items/day (rounded to one decimal). The ONLY remaining
 * caller of the `stats:articles(count)` aggregate PERF-01 measured bimodal
 * (177-4639 ms) — isolated here so /kaynaklar/durum's table shell can paint
 * from the cheap `getSourceFeedStatuses()` core while this streams in
 * behind its own nested <Suspense> for just the "7 günlük gün başına
 * haber" column. `null` means "unknown" (a Supabase error); callers should
 * render a neutral placeholder ("—"), not fabricate 0.
 */
export async function getSourceItemsPerDay(): Promise<Record<string, number> | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  try {
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
      console.warn(`[feed-status] items/day unknown: ${error.message}`);
      return null;
    }

    const rows = (data ?? []) as unknown as ItemsPerDayRawRow[];
    return toItemsPerDayMap(rows);
  } catch (err) {
    console.warn(
      `[feed-status] items/day unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
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

/**
 * Cheap voting-kind `{ delivering, total }` pair for a DenominatorNote
 * footnote — an existence probe (`recent:articles(id)` +
 * `limit(1, { referencedTable: "recent" })`, the same shape as
 * src/lib/sources/active-count.ts and src/lib/clusters/feed-health.ts),
 * never the `stats:articles(count)` aggregate. Used by /blindspots, which
 * has no per-source rows of its own; /sources derives the same pair for
 * free from rows `getSources()` already fetched instead of calling this
 * (see src/app/sources/page.tsx). `null` means "unknown" (a Supabase
 * error) — callers must render the wording-without-numbers fallback.
 */
export async function getFeedStatusSummary(): Promise<FeedStatusSummaryCounts | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("sources");

  try {
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
      console.warn(`[feed-status] summary unknown: ${error.message}`);
      return null;
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
  } catch (err) {
    console.warn(
      `[feed-status] summary unknown: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}
