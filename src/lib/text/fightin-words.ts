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
//
// The z cut is calibrated, not 1.96 (h52-weekly-1). A week offers about 1,000
// candidate terms per zone, and each one tested at z >= 1.96 has a few percent
// chance of passing on noise: with the zone labels shuffled, 25 to 28 terms per
// zone still pass, and the best shuffled z has a median near 2.8 and a 95th
// percentile near 3.2 (measured on /hafta, 2026-11-06). So `calibratedZCut`
// shuffles the zone labels over the docs `nullPermutations` times, keeps the
// best z each zone reaches under the same filters and prior, and takes the
// `nullQuantile` quantile of those maxima as the cut. `fightinWords` itself
// stays a plain "z >= zMin" filter; callers pass the calibrated cut as zMin.

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
  /**
   * Label shuffles `calibratedZCut` runs over the week's docs. Each costs one
   * counting pass, so this is the cost knob: all 20 add about 0.13 s to a
   * 6,100-doc /hafta build (0.26 s in total, measured 2026-11-06). 0 turns the
   * calibration off and the cut is plain `zMin`.
   */
  nullPermutations: 20,
  /** Quantile of the shuffled per-zone best z that becomes the cut. */
  nullQuantile: 0.95,
  /** Base seed of the shuffles (shuffle k uses `nullSeed + k`): the same docs always give the same cut. */
  nullSeed: 20261106,
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

interface ZoneCounts {
  docsPerZone: Record<MediaDnaZone, number>;
  stats: Map<string, TermStats>;
}

/**
 * The counting both the real pass and the null (shuffled-label) pass use.
 * `labels[i]` is the zone of `docs[i]`; with no labels each doc keeps its own.
 * `keep`, when given, restricts the per-term stats to those terms (the doc
 * totals still cover every doc). Order-independent: only sums and sets.
 */
function countTerms(
  docs: readonly FwDoc[],
  labels?: readonly MediaDnaZone[],
  keep?: ReadonlySet<string>,
): ZoneCounts {
  const stats = new Map<string, TermStats>();
  const docsPerZone: Record<MediaDnaZone, number> = {
    iktidar: 0,
    bagimsiz: 0,
    muhalefet: 0,
  };

  for (let i = 0; i < docs.length; i++) {
    const doc = docs[i]!;
    const zone = labels ? labels[i]! : doc.zone;
    docsPerZone[zone] += 1;
    for (const term of doc.terms) {
      if (keep && !keep.has(term)) continue;
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
      s.countByZone[zone] += 1;
      s.sourcesByZone[zone].add(doc.sourceId);
      const bySource = s.docsBySourceByZone[zone];
      bySource.set(doc.sourceId, (bySource.get(doc.sourceId) ?? 0) + 1);
    }
  }

  return { docsPerZone, stats };
}

type CandidateFilters = Pick<
  FwOptions,
  "minCount" | "minSources" | "priorScale" | "maxSourceShare"
>;

/**
 * Calls `visit(term, count, sources, z)` for every term that is a candidate
 * for `zoneI`: it passes minCount, minSources and maxSourceShare and has a
 * z-score under the informative prior. The z cut is NOT applied here: the real
 * pass filters on it, the null pass takes the maximum. One definition of
 * "candidate" for both, so the calibration measures exactly the terms the page
 * would list.
 */
function forEachCandidate(
  counts: ZoneCounts,
  zoneI: MediaDnaZone,
  filters: CandidateFilters,
  visit: (term: string, count: number, sources: number, z: number) => void,
): void {
  const { minCount, minSources, priorScale, maxSourceShare } = filters;
  const { docsPerZone, stats } = counts;
  const others = ZONE_ORDER.filter((z) => z !== zoneI);
  const nI = docsPerZone[zoneI];
  const nJ = others.reduce((sum, z) => sum + docsPerZone[z], 0);

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
    visit(term, yI, s.sourcesByZone[zoneI].size, z);
  }
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
 * `opts.zMin` is the cut. The default (1.96) is a floor, not a significance
 * claim over ~1,000 candidate terms: callers that list terms to readers pass
 * the permutation-calibrated cut from `calibratedZCut`.
 *
 * The output must not depend on doc order: all counting is order-independent
 * (Map/Set accumulation) and the final sort/tie-break never touches
 * insertion order.
 */
export function fightinWords(
  docs: readonly FwDoc[],
  opts: Partial<FwOptions> = {},
): Record<MediaDnaZone, FwTerm[]> {
  const cfg = { ...FW_DEFAULTS, ...opts };

  if (docs.length === 0) return emptyResult();

  const counts = countTerms(docs);
  const result = emptyResult();

  for (const zoneI of ZONE_ORDER) {
    const candidates: FwTerm[] = [];

    forEachCandidate(counts, zoneI, cfg, (term, count, sources, z) => {
      if (z < cfg.zMin) return;
      candidates.push({ term, count, sources, z });
    });

    candidates.sort(compareTerms);
    const picked = greedyPick(candidates, cfg.topK);
    result[zoneI] = picked.length >= cfg.minTermsToShow ? picked : [];
  }

  return result;
}

/**
 * Mulberry32: a tiny seeded PRNG returning floats in [0, 1). Same seed, same
 * stream, on every machine (integer arithmetic only).
 */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Code-unit comparison of two strings (never localeCompare). */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The docs in a canonical order, sorted by (zone, sourceId, sorted terms), so
 * that what the shuffles do cannot depend on the order the caller listed them
 * in. The terms are joined with NUL, which no term contains: a space would let
 * the unigram pair {"a", "b"} and the bigram {"a b"} collide.
 */
function canonicalDocs(docs: readonly FwDoc[]): FwDoc[] {
  const keyed = docs.map((doc) => ({
    doc,
    zoneRank: ZONE_ORDER.indexOf(doc.zone),
    key: [...doc.terms].sort(compareStrings).join("\u0000"),
  }));
  keyed.sort(
    (a, b) =>
      a.zoneRank - b.zoneRank ||
      compareStrings(a.doc.sourceId, b.doc.sourceId) ||
      compareStrings(a.key, b.key),
  );
  return keyed.map((k) => k.doc);
}

/** In-place Fisher-Yates shuffle driven by `rand`. */
function shuffleInPlace<T>(items: T[], rand: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

/** Quantile `q` (clamped to [0, 1]) of an ascending list, linearly interpolated between ranks. */
function quantileSorted(ascending: readonly number[], q: number): number {
  if (ascending.length === 0) return 0;
  const qq = Number.isFinite(q) ? Math.min(1, Math.max(0, q)) : FW_DEFAULTS.nullQuantile;
  const pos = qq * (ascending.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = ascending[lo]!;
  const b = ascending[hi]!;
  return a + (b - a) * (pos - lo);
}

/**
 * The z cut that chance alone rarely beats: a null calibration of
 * `fightinWords` by label permutation.
 *
 * For each of `nullPermutations` shuffles (Fisher-Yates over the zone labels,
 * seeded `mulberry32(nullSeed + k)`, which keeps every zone's size) the term
 * counts are recomputed for the shuffled labels, the same candidate filters and
 * prior are applied, and the best z each zone reaches is recorded (0 when it
 * has no candidate). The cut is the `nullQuantile` quantile of those
 * 3 x nullPermutations maxima, never below `zMin`. With nullPermutations 0 the
 * cut is `zMin`.
 *
 * Deterministic and independent of the order of `docs`: the same docs give the
 * same number. Cost: one counting pass per permutation.
 */
export function calibratedZCut(docs: readonly FwDoc[], opts: Partial<FwOptions> = {}): number {
  const cfg = { ...FW_DEFAULTS, ...opts };
  const permutations = Number.isFinite(cfg.nullPermutations) ? Math.floor(cfg.nullPermutations) : 0;
  if (permutations < 1 || docs.length === 0) return cfg.zMin;

  const canonical = canonicalDocs(docs);

  // A term in fewer than `minCount` docs overall cannot reach minCount in any
  // zone, whatever the labels: leave it out of every shuffled pass. It changes
  // no result, only the cost (most of a headline vocabulary is such a term).
  const docFrequency = new Map<string, number>();
  for (const doc of canonical) {
    for (const term of doc.terms) docFrequency.set(term, (docFrequency.get(term) ?? 0) + 1);
  }
  const keep = new Set<string>();
  for (const [term, df] of docFrequency) if (df >= cfg.minCount) keep.add(term);

  const maxima: number[] = [];
  const labels = canonical.map((doc) => doc.zone);
  for (let k = 1; k <= permutations; k++) {
    const shuffled = [...labels];
    shuffleInPlace(shuffled, mulberry32(cfg.nullSeed + k));
    const counts = countTerms(canonical, shuffled, keep);
    for (const zone of ZONE_ORDER) {
      let best = 0;
      forEachCandidate(counts, zone, cfg, (_term, _count, _sources, z) => {
        if (z > best) best = z;
      });
      maxima.push(best);
    }
  }

  maxima.sort((a, b) => a - b);
  return Math.max(cfg.zMin, quantileSorted(maxima, cfg.nullQuantile));
}
