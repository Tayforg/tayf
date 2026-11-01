import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
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

export const WEEKLY_WORDS_DAYS = 7;
export const WEEKLY_WORDS_PER_ZONE_PER_DAY = 300;

/**
 * Pool size for the 21 article reads (3 zones x 7 days). One read scans one
 * zone-day through idx_articles_created_source (about 2,700 rows; a top-N sort
 * by id keeps 300): ~9 ms warm, 0.5 to 1.7 s cold (1,000 to 1,900 heap pages
 * read). The old `Promise.all(reads)` sent all 21 at once and a cold fill was
 * seen to pass the 4 s reader cap (h14-perf-1). A bounded pool keeps the
 * database queue short. It cannot reduce the pages a cold fill has to read, so
 * a fully cold fill is still I/O bound; this constant is the knob.
 */
export const WEEKLY_WORDS_READ_CONCURRENCY = 4;

const DAY_MS = 24 * 60 * 60 * 1000;
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

  const { data: sourceRows, error: sourcesError } = await supabase
    .from("sources")
    .select("id, name, slug, bias, kind, active")
    .eq("active", true)
    .returns<WeeklyWordsSourceRow[]>();

  if (sourcesError) {
    throw new Error(`[weekly-words] sources query failed: ${sourcesError.message}`);
  }

  const sources = sourceRows ?? [];

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

  // One task per (day, zone), day-major (newest day first, zones in
  // ZONE_ORDER): the order the rows reach the builder is unchanged. A zone with
  // no voting source is skipped, so nothing is read for it.
  const reads: Array<() => Promise<WeeklyWordsArticleRow[]>> = [];

  for (let d = 0; d < WEEKLY_WORDS_DAYS; d++) {
    const gte = new Date(nowMs - (d + 1) * DAY_MS).toISOString();
    const lt = new Date(nowMs - d * DAY_MS).toISOString();

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
            `[weekly-words] articles query failed (zone=${zone}, day=${d}): ${error.message}`,
          );
        }
        return data ?? [];
      });
    }
  }

  const results = await runWithConcurrency(reads, WEEKLY_WORDS_READ_CONCURRENCY);
  const allRows = results.flat();

  return buildWeeklyDistinctiveWords(allRows, sources);
}

// Cached entry point. Build-safety: this never throws — `attemptCached`
// swallows whatever `fetchWeeklyDistinctiveWords` throws and reports
// `{ ok: false }` instead, so a throw never crosses this `"use cache"`
// boundary during `next build`'s prerender.
//
// Shared remote cache (`"use cache: remote"`), not the per-instance default:
// the plain directive made every serverless instance pay its own fill of the
// 21 slow article reads (mean 1.45 s, some hit the 8 s statement timeout),
// ~645 calls/day (h10-dbhot-3). The words are a trailing-7-day comparison and
// barely move intra-day, so a successful result keeps the 6 h `weekly-words`
// profile (next.config.ts). Nothing calls revalidateTag('weekly-words'); the
// tag is only there for manual invalidation.
//
// Cache lifetime follows the outcome (exactly one `cacheLife` call, after the
// attempt; `cacheTag` first): a failed attempt (e.g. a 4 s reader-cap abort on
// any of the 22 reads: the sources read, then the 21 article reads run through
// a pool of WEEKLY_WORDS_READ_CONCURRENCY) is memoised for `minutes` only, never for 6 h.
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
