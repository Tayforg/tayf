import type { MediaDnaZone } from "@/types";

// Fightin' Words (Monroe, Colaresi & Quinn 2008): a log-odds-ratio-with an
// informative Dirichlet prior, reported as z-scores. Pure, deterministic,
// zero-cost — no LLM call anywhere in this module.
//
// Each Medya DNA zone is compared against the other two, pooled. A term
// surfaces for a zone only when it is *over-represented* there relative to
// the rest of the week's coverage; under-use is never reported ("side X
// avoids word Y" is not a claim this method can support).
//
// A term must also be spread across the zone's outlets, not just present in
// several: when one outlet supplies more than `maxSourceShare` of the zone's
// docs containing the term, the term is that outlet's house wording and not
// how the zone writes, so it is skipped. `minSources` alone does not catch
// this, because two or three stray headlines from other outlets satisfy it.
// Measured on /hafta, 2026-11-02 (bagimsiz): of the week's distinct titles
// containing "coşkusu", 231 of 239 (97%) came from Haberport, and of those
// containing "dakikada", 88 of 102 (86%) came from Haber.com; both were
// listed (z 5.6 for "coşkusu") because a few stray headlines from other
// outlets satisfied minSources 3.

export const FW_DEFAULTS = {
  minCount: 5,
  minSources: 3,
  zMin: 1.96,
  topK: 8,
  minTermsToShow: 2,
  priorScale: 0.1,
  /**
   * Largest share of a term's zone docs one source may supply. The test is
   * strictly `>`: a source at exactly this share is kept. The denominator is
   * the zone's docs containing the term, not all of the zone's docs.
   */
  maxSourceShare: 0.5,
} as const;

/** Every default is a plain number; `as const` would otherwise pin each to its literal type. */
export type FwOptions = { readonly [K in keyof typeof FW_DEFAULTS]: number };

/**
 * Closed-form log-odds-ratio z-score for one term, zone i vs. zone j, with
 * an informative Dirichlet prior (aW = prior count for this word, a0 =
 * prior count for the whole vocabulary).
 *
 * yI / nI: count of docs containing the word / total docs, zone i.
 * yJ / nJ: same, zone j (or the pooled "rest").
 */
export function logOddsZ(
  yI: number,
  nI: number,
  yJ: number,
  nJ: number,
  alphaW: number,
  alpha0: number,
): { delta: number; z: number } {
  const logOddsI = Math.log((yI + alphaW) / (nI + alpha0 - yI - alphaW));
  const logOddsJ = Math.log((yJ + alphaW) / (nJ + alpha0 - yJ - alphaW));
  const delta = logOddsI - logOddsJ;
  const variance = 1 / (yI + alphaW) + 1 / (yJ + alphaW);
  const z = delta / Math.sqrt(variance);
  return { delta, z };
}

export interface FwDoc {
  zone: MediaDnaZone;
  sourceId: string;
  terms: ReadonlySet<string>;
}

export interface FwTerm {
  term: string;
  count: number;
  sources: number;
  z: number;
}

const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

function emptyResult(): Record<MediaDnaZone, FwTerm[]> {
  return { iktidar: [], bagimsiz: [], muhalefet: [] };
}

interface TermStats {
  /** Per-zone doc count containing this term. */
  countByZone: Record<MediaDnaZone, number>;
  /** Per-zone distinct source-id set containing this term. */
  sourcesByZone: Record<MediaDnaZone, Set<string>>;
  /** Per-zone, per-source count of docs containing this term (once per doc and term). */
  docsBySourceByZone: Record<MediaDnaZone, Map<string, number>>;
}

/** Sort by z desc, then count desc, then term by code-unit comparison. */
function compareTerms(a: FwTerm, b: FwTerm): number {
  if (a.z !== b.z) return b.z - a.z;
  if (a.count !== b.count) return b.count - a.count;
  if (a.term < b.term) return -1;
  if (a.term > b.term) return 1;
  return 0;
}

/** The set of whitespace-separated tokens making up a (possibly bigram) term. */
function tokensOf(term: string): string[] {
  return term.split(" ");
}

/**
 * Greedily pick up to `topK` terms from a z/count/term-sorted candidate
 * list, skipping any term that shares a token with an already-picked term
 * (so "terör örgütü" suppresses both "terör" and "örgütü").
 */
function greedyPick(candidates: FwTerm[], topK: number): FwTerm[] {
  const picked: FwTerm[] = [];
  const usedTokens = new Set<string>();

  for (const candidate of candidates) {
    if (picked.length >= topK) break;
    const tokens = tokensOf(candidate.term);
    if (tokens.some((t) => usedTokens.has(t))) continue;
    picked.push(candidate);
    for (const t of tokens) usedTokens.add(t);
  }

  return picked;
}

/**
 * Fightin' Words over a corpus of per-headline documents. Each doc's `terms`
 * is a set (binary presence, not raw frequency) — a headline that repeats a
 * word counts once.
 *
 * The output must not depend on doc order: all counting is order-independent
 * (Map/Set accumulation) and the final sort/tie-break never touches
 * insertion order.
 */
export function fightinWords(
  docs: readonly FwDoc[],
  opts: Partial<FwOptions> = {},
): Record<MediaDnaZone, FwTerm[]> {
  const { minCount, minSources, zMin, topK, minTermsToShow, priorScale, maxSourceShare } = {
    ...FW_DEFAULTS,
    ...opts,
  };

  if (docs.length === 0) return emptyResult();

  const stats = new Map<string, TermStats>();
  const docsPerZone: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };

  for (const doc of docs) {
    docsPerZone[doc.zone] += 1;
    for (const term of doc.terms) {
      let s = stats.get(term);
      if (!s) {
        s = {
          countByZone: { iktidar: 0, bagimsiz: 0, muhalefet: 0 },
          sourcesByZone: {
            iktidar: new Set<string>(),
            bagimsiz: new Set<string>(),
            muhalefet: new Set<string>(),
          },
          docsBySourceByZone: {
            iktidar: new Map<string, number>(),
            bagimsiz: new Map<string, number>(),
            muhalefet: new Map<string, number>(),
          },
        };
        stats.set(term, s);
      }
      s.countByZone[doc.zone] += 1;
      s.sourcesByZone[doc.zone].add(doc.sourceId);
      const bySource = s.docsBySourceByZone[doc.zone];
      bySource.set(doc.sourceId, (bySource.get(doc.sourceId) ?? 0) + 1);
    }
  }

  const result = emptyResult();

  for (const zoneI of ZONE_ORDER) {
    const others = ZONE_ORDER.filter((z) => z !== zoneI);
    const nI = docsPerZone[zoneI];
    const nJ = others.reduce((sum, z) => sum + docsPerZone[z], 0);

    const candidates: FwTerm[] = [];

    for (const [term, s] of stats) {
      const yI = s.countByZone[zoneI];
      if (yI === 0) continue;
      if (yI < minCount) continue;
      if (s.sourcesByZone[zoneI].size < minSources) continue;

      // One outlet's house wording: its docs are more than `maxSourceShare`
      // of this zone's docs containing the term (yI, not the whole zone).
      let top = 0;
      for (const n of s.docsBySourceByZone[zoneI].values()) {
        if (n > top) top = n;
      }
      if (top / yI > maxSourceShare) continue;

      const yJ = others.reduce((sum, z) => sum + s.countByZone[z], 0);

      // Informative prior from the whole week's counts for this term.
      const yAll = yI + yJ;
      const nAll = nI + nJ;
      const alphaW = priorScale * yAll;
      const alpha0 = priorScale * nAll;

      const { z } = logOddsZ(yI, nI, yJ, nJ, alphaW, alpha0);
      if (z < zMin) continue;

      candidates.push({
        term,
        count: yI,
        sources: s.sourcesByZone[zoneI].size,
        z,
      });
    }

    candidates.sort(compareTerms);
    const picked = greedyPick(candidates, topK);
    result[zoneI] = picked.length >= minTermsToShow ? picked : [];
  }

  return result;
}
