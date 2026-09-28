import { cacheLife, cacheTag } from "next/cache";

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
// fetch/cache split: the cached function THROWS on any error (so a
// transient Supabase blip is never cached as an empty week), and the
// uncached wrapper below fails open to null.

export const WEEKLY_WORDS_DAYS = 7;
export const WEEKLY_WORDS_PER_ZONE_PER_DAY = 300;

const DAY_MS = 24 * 60 * 60 * 1000;
const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const ARTICLE_SELECT = "id, title, url, source_id, created_at";

/**
 * Cached fetch + pure assembly. Throws on any Supabase error — the caller
 * (`getWeeklyDistinctiveWords`) is the only place that converts a failure
 * into `null`.
 */
export async function fetchWeeklyDistinctiveWords(): Promise<WeeklyDistinctiveWords> {
  "use cache";
  cacheLife("hours");
  cacheTag("weekly-words");

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

/**
 * Uncached, fail-open wrapper. `null` on any error — the page renders that
 * as "kelime karşılaştırması şu anda hesaplanamıyor" without failing the
 * rest of /hafta.
 */
export async function getWeeklyDistinctiveWords(): Promise<WeeklyDistinctiveWords | null> {
  try {
    return await fetchWeeklyDistinctiveWords();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // No titles, no ids — just the failure reason.
    console.error("[weekly-words] unavailable: " + message);
    return null;
  }
}
