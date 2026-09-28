// PURE module -- zero imports on purpose, so the Step 0 precision-sampling
// scratch script (and this file's own test) can load it standalone with
// `node --experimental-strip-types` against a throwaway array of clusters,
// with no Supabase / Next.js dependency graph to drag in.
//
// PRECISION TABLE (Step 0, 2026-09-28; top 50 of the 169 pairs scored
// score >= 0.3 across the 3 verified feeds (Teyit, Doğruluk Payı,
// Malumatfuruş -- AA has no qualifying feed, see feeds.ts) x the
// 3,000-cluster sample, judged by hand. Full pair list and methodology in
// docs/fact-checks.md.
//
//   threshold | n judged | positives | precision
//   ----------+----------+-----------+----------
//   0.3       |    50    |    30     |  0.600
//   0.4       |    50    |    30     |  0.600
//   0.5       |    44    |    28     |  0.636
//   0.6       |    10    |     9     |  0.900
//   0.7       |     8    |     8     |  1.000
//
// Below 0.6 the matcher is dominated by generic word overlap ("okul",
// "saldırı", "gemi") pulling in unrelated headlines; at 0.6+ it isolates
// same-event pairs (the Mekke İHA saldırısı and Rusya/Ukrayna clusters
// against their matching fact-checks). 0.6 is the lowest threshold
// clearing precision >= 0.90 with >= 5 judged positives at or above it, so
// PUBLISH_MIN_SCORE = 0.6 per the decision rule.
export const MATCH_METHOD = "keyword-v1";
export const PUBLISH_MIN_SCORE = 0.6;
export const SHADOW_MIN_SCORE = 0.3;
export const MIN_MATCHED_TERMS = 3;
export const MAX_CLUSTERS_PER_FACT_CHECK = 3;
export const CANDIDATE_WINDOW_DAYS = { before: 7, after: 2 } as const;

const DIACRITIC_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
  â: "a",
  î: "i",
  û: "u",
};

/** Lowercase with the Turkish locale (İ/I fold correctly), strip accents to
 * ASCII, then collapse every non alnum run to a single space. */
export function foldTr(s: string): string {
  let out = "";
  for (const ch of s.toLocaleLowerCase("tr")) out += DIACRITIC_MAP[ch] ?? ch;
  return out.replace(/[^a-z0-9]+/g, " ");
}

/** Turkish-locale lowercase, diacritics KEPT (the turkish FTS config stems
 * but does not unaccent, so the query text must match its vocabulary). */
function foldTrKeepDiacritics(s: string): string {
  return s.toLocaleLowerCase("tr").replace(/[^\p{L}\p{N}]+/gu, " ");
}

/** Cheap fixed-prefix stemmer: long enough tokens lose their suffix. */
export function stemTr(tok: string): string {
  return tok.length >= 6 ? tok.slice(0, 5) : tok;
}

// Turkish function words (from src/lib/clusters/neutral-title.ts's STOP set)
// plus fact-check boilerplate and too-generic words, all pre-folded so a
// single Set lookup covers every casing/diacritic variant.
const STOP = new Set(
  [
    "ve", "ile", "bir", "bu", "da", "de", "ki", "icin", "ama", "gibi", "kadar",
    "daha", "cok", "olan", "olarak", "var", "yok", "oldu", "dedi", "son",
    "dakika", "haber", "haberi", "sonra", "once", "iste",
    "iddia", "iddiasi", "iddialar", "dogru", "yanlis", "yalan", "gercek",
    "gercegi", "mi", "mu", "musunuz", "video", "videosu", "videonun",
    "goruntu", "goruntuler", "fotograf", "fotografi", "paylasilan",
    "paylasim", "sosyal", "medya", "hakkinda", "ait", "degil", "oldugu",
    "edilen", "iddiasina", "acikladi", "aciklamasi", "analiz", "teyit",
    "nedir", "neden", "nasil",
    "turkiye", "turk",
  ].map(foldTr).map((s) => s.trim()),
);

function isMeaningfulToken(tok: string): boolean {
  return tok.length >= 3 && !/^\d+$/.test(tok);
}

export interface FactCheckTerms {
  stems: string[];
  entityStems: string[];
  ftsWords: string[];
}

function isEntityWord(strippedWord: string, index: number): boolean {
  if (strippedWord.length === 0) return false;
  const first = strippedWord[0]!;
  const isUpperStart =
    first === first.toLocaleUpperCase("tr") &&
    first !== first.toLocaleLowerCase("tr");
  const letters = strippedWord.replace(/[^\p{L}]+/gu, "");
  const isAllCaps =
    letters.length >= 3 && strippedWord === strippedWord.toLocaleUpperCase("tr");
  return (isUpperStart && index !== 0) || isAllCaps;
}

/** Strip the Turkish possessive/case suffix off an apostrophe'd proper
 * noun ("Erdoğan'ın" -> "Erdoğan"). */
function apostropheCore(word: string): string {
  const idx = word.search(/['’]/);
  return idx >= 0 ? word.slice(0, idx) : word;
}

function stripPunctuation(word: string): string {
  return word.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "");
}

/**
 * Extract matching terms from a fact-check title: generic content stems
 * (folded, stopword-filtered, length >= 3), the subset of those that are
 * entities (capitalised non-leading words, ALLCAPS acronyms, or RSS
 * categories -- weighted double in scoring), and a diacritics-preserving
 * word list for the Postgres `websearch_to_tsquery('turkish', ...)` call.
 */
export function extractFactCheckTerms(
  title: string,
  categories: readonly string[] = [],
): FactCheckTerms {
  const stems: string[] = [];
  const entityStems: string[] = [];
  const entityFts: string[] = [];
  const otherFts: string[] = [];

  const rawWords = title.trim().split(/\s+/).filter(Boolean);
  rawWords.forEach((rawWord, index) => {
    const stripped = stripPunctuation(rawWord);
    if (!stripped) return;
    const entity = isEntityWord(stripped, index);
    const core = apostropheCore(stripped);
    if (!core) return;

    const foldedAscii = foldTr(core).trim();
    for (const sub of foldedAscii.split(" ")) {
      if (!sub || !isMeaningfulToken(sub) || STOP.has(sub)) continue;
      const stem = stemTr(sub);
      stems.push(stem);
      if (entity) entityStems.push(stem);
    }

    const foldedAccented = foldTrKeepDiacritics(core).trim();
    for (const sub of foldedAccented.split(" ")) {
      if (!sub || !isMeaningfulToken(sub)) continue;
      if (STOP.has(foldTr(sub).trim())) continue;
      (entity ? entityFts : otherFts).push(sub);
    }
  });

  // RSS <category> terms: always treated as entities, matched title's-own
  // stopword/length rules but never subject to the "not first word" carve
  // out (a category has no position in a sentence).
  for (const cat of categories) {
    if (typeof cat !== "string") continue;
    const foldedAscii = foldTr(cat).trim();
    for (const sub of foldedAscii.split(" ")) {
      if (!sub || !isMeaningfulToken(sub) || STOP.has(sub)) continue;
      const stem = stemTr(sub);
      stems.push(stem);
      entityStems.push(stem);
    }
    const foldedAccented = foldTrKeepDiacritics(cat).trim();
    for (const sub of foldedAccented.split(" ")) {
      if (!sub || !isMeaningfulToken(sub)) continue;
      if (STOP.has(foldTr(sub).trim())) continue;
      entityFts.push(sub);
    }
  }

  return {
    stems: Array.from(new Set(stems)),
    entityStems: Array.from(new Set(entityStems)),
    ftsWords: Array.from(new Set([...entityFts, ...otherFts])),
  };
}

/** `websearch_to_tsquery`-ready OR-query: entities first, capped at 6 words,
 * null when there are fewer than 2 -- too weak a signal to search on. */
export function buildFtsQuery(t: FactCheckTerms): string | null {
  if (t.ftsWords.length < 2) return null;
  return t.ftsWords.slice(0, 6).join(" or ");
}

export interface ClusterDoc {
  id: string;
  headline: string;
  memberTitles: string[];
}

export interface MatchResult {
  clusterId: string;
  score: number;
  matched: string[];
  entityMatched: number;
  decision: "publish" | "shadow" | "none";
}

/** Folded, stemmed token set of a headline/member title, used only to test
 * whether a fact-check stem is "supported" by the cluster's own text. */
function stemsOfText(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of foldTr(text).trim().split(" ")) {
    if (!tok || !isMeaningfulToken(tok)) continue;
    out.add(stemTr(tok));
  }
  return out;
}

/**
 * Score one cluster against a fact-check's extracted terms.
 *
 * Support rule: a stem only counts as "matched" if the cluster itself
 * carries it -- in the headline, OR in at least 2 member titles. A stem
 * appearing in exactly one member title (one outlet's incidental word
 * choice) does not count; this keeps a single mis-tagged outlet from
 * manufacturing a match.
 *
 * Weighting: entity stems (proper nouns / acronyms / RSS categories) count
 * double. `score` = matched weight / total weight, rounded to 3 decimals.
 */
export function scoreCluster(t: FactCheckTerms, doc: ClusterDoc): MatchResult {
  const headlineStems = stemsOfText(doc.headline);
  const memberStemSets = doc.memberTitles.map(stemsOfText);
  const entitySet = new Set(t.entityStems);

  const matched: string[] = [];
  let entityMatched = 0;
  let matchedWeight = 0;
  let totalWeight = 0;

  for (const stem of t.stems) {
    const weight = entitySet.has(stem) ? 2 : 1;
    totalWeight += weight;

    const inHeadline = headlineStems.has(stem);
    const memberSupport = memberStemSets.reduce(
      (n, s) => n + (s.has(stem) ? 1 : 0),
      0,
    );
    if (inHeadline || memberSupport >= 2) {
      matched.push(stem);
      matchedWeight += weight;
      if (entitySet.has(stem)) entityMatched++;
    }
  }

  const score = totalWeight > 0 ? Math.round((matchedWeight / totalWeight) * 1000) / 1000 : 0;

  let decision: MatchResult["decision"] = "none";
  if (
    matched.length >= MIN_MATCHED_TERMS &&
    entityMatched >= 1 &&
    score >= PUBLISH_MIN_SCORE
  ) {
    decision = "publish";
  } else if (matched.length >= 2 && score >= SHADOW_MIN_SCORE) {
    decision = "shadow";
  }

  return { clusterId: doc.id, score, matched, entityMatched, decision };
}

/** Score every candidate cluster, drop non-matches, sort by score desc,
 * cap at MAX_CLUSTERS_PER_FACT_CHECK. */
export function rankMatches(
  t: FactCheckTerms,
  docs: readonly ClusterDoc[],
): MatchResult[] {
  return docs
    .map((doc) => scoreCluster(t, doc))
    .filter((r) => r.decision !== "none")
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CLUSTERS_PER_FACT_CHECK);
}
