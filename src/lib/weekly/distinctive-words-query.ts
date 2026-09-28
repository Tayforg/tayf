import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { createServerClient } from "@/lib/supabase/server";
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

const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const ARTICLE_SELECT = "id, title, url, source_id, created_at";

/**
 * Uncached raw fetch + pure assembly. Throws on any Supabase error — kept
 * free of the `"use cache"` directive so it can be called twice: once
 * (wrapped by `attemptCached`) inside the cache boundary below, and once
 * more, live, as `getWeeklyDistinctiveWords`'s retry on a cache-attempt
 * failure.
 */
export async function fetchWeeklyDistinctiveWords(): Promise<WeeklyDistinctiveWords> {
  const supabase = createServerClient();

  // One clock read, same pattern as weekly-query.ts: two Date.now() calls
  // could straddle a tick and widen a window past a day boundary.
  const nowMs = Date.now();

  const { data: sourceRows, error: sourcesError } = await supabase
    .from("sources")
    .select("id, name, bias, kind, active")
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

  const reads: Array<Promise<WeeklyWordsArticleRow[]>> = [];

  for (let d = 0; d < WEEKLY_WORDS_DAYS; d++) {
    const gte = new Date(nowMs - (d + 1) * DAY_MS).toISOString();
    const lt = new Date(nowMs - d * DAY_MS).toISOString();

    for (const zone of ZONE_ORDER) {
      const ids = idsByZone[zone];
      if (ids.length === 0) continue;

      reads.push(
        (async () => {
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
        })(),
      );
    }
  }

  const results = await Promise.all(reads);
  const allRows = results.flat();

  return buildWeeklyDistinctiveWords(allRows, sources);
}

// Cached entry point. Build-safety: this never throws — `attemptCached`
// swallows whatever `fetchWeeklyDistinctiveWords` throws and reports
// `{ ok: false }` instead, so a throw never crosses this `"use cache"`
// boundary during `next build`'s prerender.
async function getCachedWeeklyDistinctiveWords() {
  "use cache";
  cacheLife("hours");
  cacheTag("weekly-words");
  return attemptCached("weekly-words", fetchWeeklyDistinctiveWords);
}

/**
 * Public, uncached entry point. `null` on a sustained failure (the cached
 * attempt AND a live retry both fail) — the page renders that as "kelime
 * karşılaştırması şu anda hesaplanamıyor" without failing the rest of
 * /hafta. On a cache-attempt failure this retries the query live once (so
 * a transient Supabase blip is not pinned as "the week" for the whole
 * `hours` cacheLife window) before falling back to `null`. Never throws.
 */
export async function getWeeklyDistinctiveWords(): Promise<WeeklyDistinctiveWords | null> {
  return resolveCachedOrRetry(
    "weekly-words",
    getCachedWeeklyDistinctiveWords,
    fetchWeeklyDistinctiveWords,
    null,
  );
}
