import { cacheLife, cacheTag } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { readAllPages } from "@/lib/db/paging";
import { createReaderClient } from "@/lib/supabase/server";
import {
  buildWeeklyDistinctiveWords,
  type WeeklyDistinctiveWords,
  type WeeklyWordsArticleRow,
  type WeeklyWordsSourceRow,
} from "./distinctive-words";
import type { MediaDnaZone } from "@/types";
import { BIAS_TO_ZONE, isVotingKind } from "@/lib/bias/config";

// IO layer for "Ayrışan Kelimeler" (/hafta): fetches the trailing 7 days of
// headlines, sampled per zone per day, and hands them to the pure
// `buildWeeklyDistinctiveWords`. Mirrors src/lib/clusters/search-query.ts's
// (and politics-query.ts's) fetch/cache split: `fetchWeeklyDistinctiveWords`
// is the uncached raw fetch and THROWS on any error (so a transient
// Supabase blip is never cached as an empty week); it's called twice — once
// wrapped by `attemptCached` inside the `"use cache"` boundary below, and
// once more, live, as `getWeeklyDistinctiveWords`'s retry on a cache-attempt
// failure. Build-safety: a throw that crosses a `"use cache"` boundary fails
// `next build`'s prerender even when every caller catches (see
// src/lib/cache-resilience.ts's file header for the incident this fixes:
// /trends and /rss.xml, 2026-09-28) — `fetchWeeklyDistinctiveWords` itself
// used to carry the `"use cache"` directive directly, which reintroduced
// exactly that hazard for /hafta.
//
// WHERE THE SAMPLE COMES FROM (h14-perf-1). The page needs, per Medya DNA zone
// and per day of the week, the 300 articles with the smallest id (ids are
// uuid v4, so this is a uniform random sample). Reading that straight from
// `articles` means 21 (zone x day) scans of a whole day each, 0.2 to 1.7 s
// apiece, and a cold fill could pass the 4 s reader cap. A single-statement
// sampling RPC was measured and rejected (4.7 s to more than 8 s cold). So
// migration 143 precomputes the sample every hour into the tiny table
// `weekly_words_sample` (at most 3 zones x 300 rows x 36 days), and this
// module reads that table: one request per 1,000 rows, never more than
// WEEKLY_WORDS_SAMPLE_MAX_PAGES. A day the table has no row for (the table is
// not applied yet, the backfill has not run, the day has just started) falls
// back to the pooled `articles` reads of the old path for that day only, so
// the page never shows a thinner week because of the table. The pure builder is
// untouched; it sorts by id itself, so the order rows arrive in does not matter.
//
// Three documented differences from the old rolling slices (also in the header
// of migration 143):
//   1. The windows are Istanbul calendar days: today (partial) plus the 6
//      previous days, instead of 24 h slices anchored at the moment of the
//      fill. The page still says "Son 7 gün".
//   2. Source eligibility (active, kind outlet or wire, a bias the zone map
//      knows) is evaluated at refresh time. The builder re-filters with the
//      live sources list, exactly as before, so a source switched off since
//      the refresh still drops out.
//   3. Today's rows lag by up to 1 h (the refresh runs hourly at minute 38).

export const WEEKLY_WORDS_DAYS = 7;
export const WEEKLY_WORDS_PER_ZONE_PER_DAY = 300;

/** The precomputed sample (migration 143): per (Istanbul day, zone) the 300 smallest article ids. */
export const WEEKLY_WORDS_SAMPLE_TABLE = "weekly_words_sample";

/**
 * Page cap for the table read. A full week is 7 x 3 x 300 = 6,300 rows, so 7
 * requests of 1,000 rows; reaching 8 full pages means the table holds more than
 * it should and the read is rejected rather than used truncated.
 */
export const WEEKLY_WORDS_SAMPLE_MAX_PAGES = 8;

/**
 * Pool size for the article reads of the FALLBACK path: at most 21 (3 zones x 7
 * days) when the sample table is missing or empty, 3 per day otherwise. One read scans one
 * zone-day through idx_articles_created_source (about 2,700 rows; a top-N sort
 * by id keeps 300): ~9 ms warm, 0.5 to 1.7 s cold (1,000 to 1,900 heap pages
 * read). The old `Promise.all(reads)` sent all 21 at once and a cold fill was
 * seen to pass the 4 s reader cap (h14-perf-1). A bounded pool keeps the
 * database queue short. It cannot reduce the pages a cold fill has to read, so
 * a fully cold fill is still I/O bound; this constant is the knob.
 */
export const WEEKLY_WORDS_READ_CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
/** Türkiye has been on a fixed UTC+3 since 2016 (no DST), so a day key is the clock shifted by 3 h. */
const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;
const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const ARTICLE_SELECT = "id, title, url, source_id, created_at";

/**
 * Runs `tasks` with at most `limit` in flight and resolves with their results
 * in task order (so the rows reach the builder in the same order as before).
 * Tasks start in array order. The first rejection rejects the whole run and no
 * further task is started; reads already in flight are left to settle on their
 * own (the capped reader client aborts them at 4 s).
 */
async function runWithConcurrency<T>(
  tasks: ReadonlyArray<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  let failed = false;

  async function worker(): Promise<void> {
    while (!failed) {
      const index = next++;
      if (index >= tasks.length) return;
      try {
        results[index] = await tasks[index]!();
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.min(Math.max(limit, 1), tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * The Istanbul calendar days ending at `nowMs`, newest first, as `YYYY-MM-DD`
 * keys (the `day` column of the sample table). This module does not import
 * src/lib/trends: the fixed UTC+3 offset is all it needs.
 */
export function istanbulDayKeys(nowMs: number, days: number): string[] {
  const keys: string[] = [];
  for (let d = 0; d < days; d++) {
    keys.push(new Date(nowMs + ISTANBUL_OFFSET_MS - d * DAY_MS).toISOString().slice(0, 10));
  }
  return keys;
}

/** `[gte, lt)` of an Istanbul calendar day as UTC ISO strings (a day is exactly 24 h wide). */
export function istanbulDayWindow(key: string): { gte: string; lt: string } {
  const startMs = Date.parse(`${key}T00:00:00+03:00`);
  return {
    gte: new Date(startMs).toISOString(),
    lt: new Date(startMs + DAY_MS).toISOString(),
  };
}

/** The columns of `weekly_words_sample` the fill reads (zone and the order columns stay server side). */
interface SampleTableRow {
  day: string;
  article_id: string;
  source_id: string;
  title: string | null;
  url: string | null;
  created_at: string;
}

/** What PostgREST answers when the table is not there (yet): PGRST205 from the schema cache, 42P01 from Postgres. */
const MISSING_TABLE_CODES: ReadonlySet<string> = new Set(["PGRST205", "42P01"]);

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every row of the sample table for the given Istanbul days (newest first),
 * paged by the primary key. `null` means the table does not exist yet, so the
 * caller treats every day as missing; any other failure, and a truncated read,
 * THROWS (a `[weekly-words]` error keeps the 'minutes' failure caching and the
 * live retry of the public entry point).
 */
async function readSampleTable(
  supabase: SupabaseClient,
  dayKeys: readonly string[],
): Promise<SampleTableRow[] | null> {
  const newest = dayKeys[0];
  const oldest = dayKeys[dayKeys.length - 1];
  if (newest === undefined || oldest === undefined) return [];

  // The last Supabase error, so a throw from readAllPages can be told from a missing table by code.
  const seen: { error: { message: string; code?: string } | null } = { error: null };

  try {
    const { rows, truncated } = await readAllPages<SampleTableRow>(
      async (from, to) => {
        const { data, error } = await supabase
          .from(WEEKLY_WORDS_SAMPLE_TABLE)
          .select("day, article_id, source_id, title, url, created_at")
          .gte("day", oldest)
          .lte("day", newest)
          .order("day")
          .order("zone")
          .order("article_id")
          .range(from, to)
          .returns<SampleTableRow[]>();
        if (error) seen.error = error;
        return { data, error };
      },
      { label: "weekly-words sample", maxPages: WEEKLY_WORDS_SAMPLE_MAX_PAGES },
    );
    if (truncated) {
      throw new Error(
        `[weekly-words] sample table read truncated at ${WEEKLY_WORDS_SAMPLE_MAX_PAGES} pages`,
      );
    }
    return rows;
  } catch (error) {
    const code = seen.error?.code;
    if (code !== undefined && MISSING_TABLE_CODES.has(code)) {
      console.warn(
        `[weekly-words] ${WEEKLY_WORDS_SAMPLE_TABLE} is not available (${code}); reading the articles directly`,
      );
      return null;
    }
    if (error instanceof Error && error.message.startsWith("[weekly-words] ")) throw error;
    throw new Error(
      `[weekly-words] sample table query failed: ${seen.error?.message ?? describeError(error)}`,
    );
  }
}

/**
 * Uncached raw fetch + pure assembly. Throws on any Supabase error — kept
 * free of the `"use cache"` directive so it can be called twice: once
 * (wrapped by `attemptCached`) inside the cache boundary below, and once
 * more, live, as `getWeeklyDistinctiveWords`'s retry on a cache-attempt
 * failure.
 */
export async function fetchWeeklyDistinctiveWords(): Promise<WeeklyDistinctiveWords> {
  const supabase = createReaderClient();

  // One clock read, same pattern as weekly-query.ts: two Date.now() calls
  // could straddle a tick and widen a window past a day boundary.
  const nowMs = Date.now();
  const dayKeys = istanbulDayKeys(nowMs, WEEKLY_WORDS_DAYS);

  // The sources list and the precomputed sample are independent: read both at once.
  const [sourcesResult, sampleRows] = await Promise.all([
    supabase
      .from("sources")
      .select("id, name, slug, bias, kind, active")
      .eq("active", true)
      .returns<WeeklyWordsSourceRow[]>(),
    readSampleTable(supabase, dayKeys),
  ]);

  const { data: sourceRows, error: sourcesError } = sourcesResult;
  if (sourcesError) {
    throw new Error(`[weekly-words] sources query failed: ${sourcesError.message}`);
  }

  const sources = sourceRows ?? [];

  // Rows of the precomputed sample, shaped like an article read.
  const tableRows: WeeklyWordsArticleRow[] = (sampleRows ?? []).map((row) => ({
    id: row.article_id,
    title: row.title,
    url: row.url,
    source_id: row.source_id,
    created_at: row.created_at,
  }));

  // A day with no row in the table is read from `articles` instead (the table is
  // absent, not backfilled for that day, or the day has just opened).
  const daysWithRows = new Set((sampleRows ?? []).map((row) => row.day));
  const missingDays = dayKeys
    .map((key, index) => ({ key, index }))
    .filter(({ key }) => !daysWithRows.has(key));

  // Group voting source ids by zone.
  const idsByZone: Record<MediaDnaZone, string[]> = {
    iktidar: [],
    bagimsiz: [],
    muhalefet: [],
  };
  for (const source of sources) {
    if (!source.bias || !(source.bias in BIAS_TO_ZONE)) continue;
    if (!isVotingKind(source.kind)) continue;
    const zone = BIAS_TO_ZONE[source.bias];
    idsByZone[zone].push(source.id);
  }

  // One task per (missing day, zone), day-major (newest day first, zones in
  // ZONE_ORDER): the order the rows reach the builder is unchanged. A zone with
  // no voting source is skipped, so nothing is read for it.
  const reads: Array<() => Promise<WeeklyWordsArticleRow[]>> = [];

  for (const { key, index } of missingDays) {
    const { gte, lt } = istanbulDayWindow(key);

    for (const zone of ZONE_ORDER) {
      const ids = idsByZone[zone];
      if (ids.length === 0) continue;

      reads.push(async () => {
        const { data, error } = await supabase
          .from("articles")
          .select(ARTICLE_SELECT)
          .in("source_id", ids)
          .gte("created_at", gte)
          .lt("created_at", lt)
          .order("id", { ascending: true })
          .limit(WEEKLY_WORDS_PER_ZONE_PER_DAY)
          .returns<WeeklyWordsArticleRow[]>();

        if (error) {
          throw new Error(
            `[weekly-words] articles query failed (zone=${zone}, day=${index}): ${error.message}`,
          );
        }
        return data ?? [];
      });
    }
  }

  const results = await runWithConcurrency(reads, WEEKLY_WORDS_READ_CONCURRENCY);
  const fallbackRows = results.flat();

  return buildWeeklyDistinctiveWords(tableRows.concat(fallbackRows), sources);
}

// Cached entry point. Build-safety: this never throws — `attemptCached`
// swallows whatever `fetchWeeklyDistinctiveWords` throws and reports
// `{ ok: false }` instead, so a throw never crosses this `"use cache"`
// boundary during `next build`'s prerender.
//
// Shared remote cache (`"use cache: remote"`), not the per-instance default:
// the plain directive made every serverless instance pay its own fill of the
// 21 slow article reads (mean 1.45 s, some hit the 8 s statement timeout),
// ~645 calls/day (h10-dbhot-3); the table read of migration 143 makes the fill
// itself cheap, but a cold shared entry still saves every instance the round trips. The words are a trailing-7-day comparison and
// barely move intra-day, so a successful result keeps the 6 h `weekly-words`
// profile (next.config.ts). Nothing calls revalidateTag('weekly-words'); the
// tag is only there for manual invalidation.
//
// Cache lifetime follows the outcome (exactly one `cacheLife` call, after the
// attempt; `cacheTag` first): a failed attempt (e.g. a 4 s reader-cap abort on
// the sources read, on a page of the sample table, or on one of the fallback
// article reads that run through a pool of WEEKLY_WORDS_READ_CONCURRENCY) is
// memoised for `minutes` only, never for 6 h.
async function getCachedWeeklyDistinctiveWords() {
  "use cache: remote";
  cacheTag("weekly-words");
  const r = await attemptCached("weekly-words", fetchWeeklyDistinctiveWords);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("weekly-words");
  else cacheLife("minutes");
  return r;
}

/**
 * Public, uncached entry point. `null` on a sustained failure (the cached
 * attempt AND a live retry both fail) — the page renders that as "kelime
 * karşılaştırması şu anda hesaplanamıyor" without failing the rest of
 * /hafta. On a cache-attempt failure this retries the query live once (so
 * a transient Supabase blip is not pinned as "the week" for the whole
 * `weekly-words` cacheLife window) before falling back to `null`. Never
 * throws.
 */
export async function getWeeklyDistinctiveWords(): Promise<WeeklyDistinctiveWords | null> {
  return resolveCachedOrRetry(
    "weekly-words",
    getCachedWeeklyDistinctiveWords,
    fetchWeeklyDistinctiveWords,
    null,
  );
}
