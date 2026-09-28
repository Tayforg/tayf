import type { MediaDnaZone } from "@/types";

// Fightin' Words (Monroe, Colaresi & Quinn 2008): a log-odds-ratio-with an
// informative Dirichlet prior, reported as z-scores. Pure, deterministic,
// zero-cost — no LLM call anywhere in this module.
//
// Each Medya DNA zone is compared against the other two, pooled. A term
// surfaces for a zone only when it is *over-represented* there relative to
// the rest of the week's coverage; under-use is never reported ("side X
// avoids word Y" is not a claim this method can support).

export const FW_DEFAULTS = {
  minCount: 5,
  minSources: 3,
  zMin: 1.96,
  topK: 8,
  minTermsToShow: 2,
  priorScale: 0.1,
} as const;

export type FwOptions = typeof FW_DEFAULTS;

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
  const { minCount, minSources, zMin, topK, minTermsToShow, priorScale } = {
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
        };
        stats.set(term, s);
      }
      s.countByZone[doc.zone] += 1;
      s.sourcesByZone[doc.zone].add(doc.sourceId);
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
