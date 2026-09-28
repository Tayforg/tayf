import { fightinWords, type FwDoc } from "@/lib/text/fightin-words";
import { headlineKey, headlineTerms } from "@/lib/text/tokenize-tr";
import { BIAS_TO_ZONE, isVotingKind } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Pure assembly layer for "Ayrışan Kelimeler" (/hafta, "Aynı hafta, farklı
// kelimeler"): turns raw articles + sources rows into the Fightin' Words
// terms shown per Medya DNA zone. No Supabase/Next import here — the IO
// split lives in distinctive-words-query.ts, mirroring weekly-query.ts's
// pure-aggregation / cached-fetch split.

/** A zone needs at least this many kept (deduped, voting-source) headlines. */
export const WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE = 200;

export interface WeeklyWordsArticleRow {
  id: string;
  title: string | null;
  url: string | null;
  source_id: string;
  created_at: string;
}

export interface WeeklyWordsSourceRow {
  id: string;
  name: string | null;
  bias: BiasCategory | null;
  kind: string | null;
  active: boolean | null;
}

export interface DistinctiveTerm {
  term: string;
  display: string;
  count: number;
  z: number;
  example: { title: string; url: string | null; sourceName: string } | null;
}

export type WeeklyDistinctiveWords =
  | {
      status: "ok";
      sample: Record<MediaDnaZone, number>;
      zones: Record<MediaDnaZone, DistinctiveTerm[]>;
    }
  | {
      status: "insufficient";
      sample: Record<MediaDnaZone, number>;
    };

const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const HTTP_URL_RE = /^https?:\/\//i;

function emptySample(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

interface KeptDoc {
  row: WeeklyWordsArticleRow;
  zone: MediaDnaZone;
  sourceName: string;
  terms: Map<string, string>;
}

function isAllCaps(s: string): boolean {
  // "ALL-CAPS" means the string has at least one letter and no lowercase
  // letters (per Turkish case rules).
  const lower = s.toLocaleLowerCase("tr");
  const upper = s.toLocaleUpperCase("tr");
  return s === upper && s !== lower;
}

/**
 * The most frequent surface form of a term within a zone, preferring
 * non-ALL-CAPS forms unless every observed form is all-caps. Ties break by
 * plain code-unit comparison (never localeCompare).
 */
function pickDisplay(surfaceCounts: Map<string, number>): string {
  const entries = [...surfaceCounts.entries()];
  const nonCaps = entries.filter(([surface]) => !isAllCaps(surface));
  const pool = nonCaps.length > 0 ? nonCaps : entries;

  let best = pool[0]!;
  for (const entry of pool.slice(1)) {
    const [surface, count] = entry;
    const [bestSurface, bestCount] = best;
    if (count > bestCount || (count === bestCount && surface < bestSurface)) {
      best = entry;
    }
  }
  return best[0];
}

/**
 * Pure aggregation: rows + sources -> the section's plain, serialisable
 * payload. `opts` forwards straight to `fightinWords`.
 */
export function buildWeeklyDistinctiveWords(
  rows: readonly WeeklyWordsArticleRow[],
  sources: readonly WeeklyWordsSourceRow[],
  opts?: Parameters<typeof fightinWords>[1],
): WeeklyDistinctiveWords {
  const sourceById = new Map<string, WeeklyWordsSourceRow>();
  for (const s of sources) sourceById.set(s.id, s);

  // 1. Zone mapping — drop rows with unknown/inactive/non-mapped/non-voting
  // sources.
  const mapped: Array<{ row: WeeklyWordsArticleRow; zone: MediaDnaZone; sourceName: string }> = [];
  for (const row of rows) {
    const source = sourceById.get(row.source_id);
    if (!source) continue;
    if (source.active !== true) continue;
    if (!isVotingKind(source.kind)) continue;
    if (!source.bias || !(source.bias in BIAS_TO_ZONE)) continue;
    const zone = BIAS_TO_ZONE[source.bias];
    mapped.push({ row, zone, sourceName: source.name ?? "Kaynak" });
  }

  // 2. Order by id, drop empty titles, dedupe per zone by headlineKey.
  mapped.sort((a, b) => (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0));

  const keptByZone: Record<MediaDnaZone, KeptDoc[]> = {
    iktidar: [],
    bagimsiz: [],
    muhalefet: [],
  };
  const seenKeyByZone: Record<MediaDnaZone, Set<string>> = {
    iktidar: new Set(),
    bagimsiz: new Set(),
    muhalefet: new Set(),
  };

  for (const { row, zone, sourceName } of mapped) {
    const title = row.title;
    if (!title || title.trim().length === 0) continue;
    const key = headlineKey(title);
    if (seenKeyByZone[zone].has(key)) continue;
    seenKeyByZone[zone].add(key);
    keptByZone[zone].push({ row, zone, sourceName, terms: headlineTerms(title) });
  }

  // 3. Sample check.
  const sample = emptySample();
  for (const zone of ZONE_ORDER) sample[zone] = keptByZone[zone].length;

  if (ZONE_ORDER.some((zone) => sample[zone] < WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE)) {
    return { status: "insufficient", sample };
  }

  // 4. Score.
  const fwDocs: FwDoc[] = [];
  for (const zone of ZONE_ORDER) {
    for (const doc of keptByZone[zone]) {
      fwDocs.push({
        zone,
        sourceId: doc.row.source_id,
        terms: new Set(doc.terms.keys()),
      });
    }
  }
  const scored = fightinWords(fwDocs, opts);

  // 5 & 6. Display form + example, per zone.
  const zones: Record<MediaDnaZone, DistinctiveTerm[]> = {
    iktidar: [],
    bagimsiz: [],
    muhalefet: [],
  };

  for (const zone of ZONE_ORDER) {
    const docs = keptByZone[zone];
    for (const fwTerm of scored[zone]) {
      const surfaceCounts = new Map<string, number>();
      let example: DistinctiveTerm["example"] = null;

      for (const doc of docs) {
        const surface = doc.terms.get(fwTerm.term);
        if (surface === undefined) continue;
        surfaceCounts.set(surface, (surfaceCounts.get(surface) ?? 0) + 1);
        if (example === null) {
          const url = doc.row.url && HTTP_URL_RE.test(doc.row.url) ? doc.row.url : null;
          example = { title: doc.row.title!, url, sourceName: doc.sourceName };
        }
      }

      zones[zone].push({
        term: fwTerm.term,
        display: pickDisplay(surfaceCounts),
        count: fwTerm.count,
        z: fwTerm.z,
        example,
      });
    }
  }

  return { status: "ok", sample, zones };
}
