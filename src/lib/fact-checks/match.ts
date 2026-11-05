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
//
// POST-LAUNCH AUDIT (2026-11-05, keyword-v1): n=10 was too small. 4 of the 11
// auto-published links were wrong, and all 4 share one shape: a person's
// first + last name plus one generic claim verb ("konuş", "katıl", "göster")
// supplied the three matched terms and an entity, so Teyit's "Hakan Fidan'ın
// Almanca konuştuğu video" went live on three unrelated Fidan stories.
// keyword-v2 therefore publishes on DISTINCT terms: a person-name span counts
// once, and generic claim verbs count toward the score but never toward the
// term minimum. Replay and detail in docs/fact-checks.md.
export const MATCH_METHOD = "keyword-v2";
export const PUBLISH_MIN_SCORE = 0.6;
export const SHADOW_MIN_SCORE = 0.3;
/** Minimum DISTINCT terms to publish (a name span counts once, generic claim
 * verbs not at all -- see GENERIC_CLAIM_VERB_STEMS). The shadow rule still
 * works on the raw matched count. */
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

/**
 * Folded stems of the verbs fact-check titles use to describe the claimed
 * video or statement ("X'in Almanca konuştuğu video", "Y'nin katıldığı
 * çalışma", "... gösteren video"). They say what the clip shows, not which
 * event it is, so they keep their weight in the score but never count toward
 * the distinct-term minimum for publishing.
 *
 * Stems are what `stemTr` yields, so at most 5 characters: "paylaştı",
 * "paylaştığı" and "paylaşılan" all stem to "payla" (a 6-character "paylas"
 * could never match anything). Known collisions with other words are
 * harmless here because they can only make publishing stricter: "katil"
 * (murderer), "yapti" (yaptırım), "goste" (gösteri), "soyle" (söyleşi).
 */
export const GENERIC_CLAIM_VERB_STEMS: ReadonlySet<string> = new Set([
  "konus",
  "katil",
  "goste",
  "acikl",
  "soyle",
  "yapti",
  "payla",
]);

function isMeaningfulToken(tok: string): boolean {
  return tok.length >= 3 && !/^\d+$/.test(tok);
}

export interface FactCheckTerms {
  stems: string[];
  entityStems: string[];
  /** Stems of person-name spans (runs of 2+ capitalised words) found in a
   * sentence-case title; each inner array is one name. See detectNameSpans. */
  nameSpans: string[][];
  ftsWords: string[];
}

/** Case of a word's first character: letters are "upper" or "lower"; digits,
 * punctuation and caseless scripts are "none". */
function initialCase(word: string): "upper" | "lower" | "none" {
  if (word.length === 0) return "none";
  const first = word[0]!;
  const upper = first.toLocaleUpperCase("tr");
  const lower = first.toLocaleLowerCase("tr");
  if (first === upper && first !== lower) return "upper";
  if (first === lower && first !== upper) return "lower";
  return "none";
}

function isEntityWord(strippedWord: string, index: number): boolean {
  if (strippedWord.length === 0) return false;
  const isUpperStart = initialCase(strippedWord) === "upper";
  const letters = strippedWord.replace(/[^\p{L}]+/gu, "");
  const isAllCaps =
    letters.length >= 3 && strippedWord === strippedWord.toLocaleUpperCase("tr");
  return (isUpperStart && index !== 0) || isAllCaps;
}

/** One title word, as the name-span detector sees it. */
interface TitleWord {
  index: number;
  /** Initial letter is upper case (index 0 allowed -- a name may open the title). */
  capitalised: boolean;
  /** Initial letter is lower case. */
  lowercase: boolean;
  /** Carries an apostrophe suffix ("Fidan'ın"): a name ends here. */
  apostrophe: boolean;
  /** Raw word ends in clause punctuation ("Erdoğan,"): a name ends here. */
  clauseEnd: boolean;
  stopword: boolean;
  /** Stems this word contributes to FactCheckTerms.stems. */
  stems: string[];
}

/**
 * Person-name spans: runs of 2+ adjacent capitalised words. A run ends at,
 * and includes, the first word with an apostrophe suffix ("Hakan Fidan'ın"),
 * a word ending in clause punctuation, or stops before the next
 * non-capitalised word. A run must contribute at least 2 stems (a leading
 * stopword such as "Video" in "Video Mekke'ye" is not part of a name).
 *
 * Spans are only trusted in sentence-case titles. In a Title Case title
 * (Doğruluk Payı: "Video Panama'da Gerçekleşen ... Depremi mi Gösteriyor?")
 * every word is capitalised and adjacency means nothing. The title counts as
 * sentence case when, among its non-leading, non-stopword words, the
 * lowercase-initial ones are at least as many as the capitalised ones --
 * with two refinements, both needed by real Teyit titles:
 *
 * - Words inside the candidate spans are left out of that count: the name is
 *   capitalised in every title, and counting it as Title Case evidence (plus
 *   a capitalised language name) rejects "Hakan Fidan'ın Almanca konuştuğu
 *   video gerçek mi?" and "NASA astronotu Deniz Burnham'ın Türkçe konuştuğu
 *   video gerçek".
 * - A title with no lowercase-initial content word at all and 2+ capitalised
 *   ones is Title Case outright. Without this, leaving the spans out of the
 *   count would turn "Bir Okul Saldırısı Başlamadan Önlenebilir mi?" -- one
 *   run that swallows the whole title -- into a single name.
 */
function detectNameSpans(words: readonly TitleWord[]): string[][] {
  const runs: TitleWord[][] = [];
  let run: TitleWord[] = [];
  const closeRun = (): void => {
    if (run.length >= 2) runs.push(run);
    run = [];
  };
  for (const w of words) {
    if (!w.capitalised) {
      closeRun();
      continue;
    }
    run.push(w);
    if (w.apostrophe || w.clauseEnd) closeRun();
  }
  closeRun();

  const candidates = runs
    .map((r) => ({ words: r, stems: Array.from(new Set(r.flatMap((w) => w.stems))) }))
    .filter((c) => c.stems.length >= 2);
  if (candidates.length === 0) return [];

  const inCandidate = new Set<TitleWord>(candidates.flatMap((c) => c.words));
  let lowercaseAll = 0;
  let capitalisedAll = 0;
  let lowercaseOutside = 0;
  let capitalisedOutside = 0;
  for (const w of words) {
    if (w.index === 0 || w.stopword) continue;
    if (w.lowercase) lowercaseAll++;
    else if (w.capitalised) capitalisedAll++;
    if (inCandidate.has(w)) continue;
    if (w.lowercase) lowercaseOutside++;
    else if (w.capitalised) capitalisedOutside++;
  }
  const titleCase = lowercaseAll === 0 && capitalisedAll >= 2;
  if (titleCase || lowercaseOutside < capitalisedOutside) return [];

  const seen = new Set<string>();
  const spans: string[][] = [];
  for (const c of candidates) {
    const key = c.stems.join(" ");
    if (seen.has(key)) continue;
    seen.add(key);
    spans.push(c.stems);
  }
  return spans;
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

  const titleWords: TitleWord[] = [];
  // A word that strips to nothing (a lone dash) is not a word, but it still
  // separates the words around it, so it closes any open name run.
  const separator = (index: number): TitleWord => ({
    index,
    capitalised: false,
    lowercase: false,
    apostrophe: false,
    clauseEnd: true,
    stopword: true,
    stems: [],
  });

  const rawWords = title.trim().split(/\s+/).filter(Boolean);
  rawWords.forEach((rawWord, index) => {
    const stripped = stripPunctuation(rawWord);
    if (!stripped) {
      titleWords.push(separator(index));
      return;
    }
    const entity = isEntityWord(stripped, index);
    const core = apostropheCore(stripped);
    if (!core) {
      titleWords.push(separator(index));
      return;
    }

    const wordStems: string[] = [];
    const foldedAscii = foldTr(core).trim();
    for (const sub of foldedAscii.split(" ")) {
      if (!sub || !isMeaningfulToken(sub) || STOP.has(sub)) continue;
      const stem = stemTr(sub);
      stems.push(stem);
      wordStems.push(stem);
      if (entity) entityStems.push(stem);
    }
    const initial = initialCase(stripped);
    titleWords.push({
      index,
      capitalised: initial === "upper",
      lowercase: initial === "lower",
      apostrophe: /['’]/.test(stripped),
      clauseEnd: /[^\p{L}\p{N}'’]$/u.test(rawWord),
      stopword: STOP.has(foldedAscii),
      stems: wordStems,
    });

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
    nameSpans: detectNameSpans(titleWords),
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
  /** Distinct terms behind the match: matched name spans plus matched stems
   * outside any span that are not generic claim verbs. A span counts once, and
   * only if it claims a matched stem no earlier span claimed, so overlapping
   * spans of one person ("Hakan Fidan" ... "Hakan Fidan'ın") are one term.
   * Never more than `matched.length` by construction (every counted span owns
   * a matched stem of its own). This -- not `matched.length` -- is what the
   * publish gate counts. */
  distinctTerms: number;
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
 *
 * Publish gate (keyword-v2): needs MIN_MATCHED_TERMS DISTINCT terms, not
 * matched stems. A person's first + last name is one term (name span), and
 * generic claim verbs (GENERIC_CLAIM_VERB_STEMS) are none, though both still
 * count in `matched` and in the score. Overlapping spans of one person count
 * once: each span counts only if it claims a matched stem no earlier span
 * claimed. The gate also keeps v1's `matched.length >= MIN_MATCHED_TERMS`, so
 * v2 can only ever publish what v1 would have. The shadow rule is unchanged.
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

  const matchedSet = new Set(matched);
  const spanStems = new Set<string>();
  // Matched stems an earlier span already accounts for. Overlapping spans of
  // one person ("Hakan Fidan" ... "Hakan Fidan'ın") share stems, and a span
  // that adds no matched stem of its own is the same evidence again.
  const claimed = new Set<string>();
  let distinctTerms = 0;
  for (const span of t.nameSpans) {
    for (const stem of span) spanStems.add(stem);
    const hits = span.filter((stem) => matchedSet.has(stem));
    if (hits.some((stem) => !claimed.has(stem))) distinctTerms++;
    for (const stem of hits) claimed.add(stem);
  }
  for (const stem of matched) {
    if (!spanStems.has(stem) && !GENERIC_CLAIM_VERB_STEMS.has(stem)) distinctTerms++;
  }

  let decision: MatchResult["decision"] = "none";
  if (
    matched.length >= MIN_MATCHED_TERMS &&
    distinctTerms >= MIN_MATCHED_TERMS &&
    entityMatched >= 1 &&
    score >= PUBLISH_MIN_SCORE
  ) {
    decision = "publish";
  } else if (matched.length >= 2 && score >= SHADOW_MIN_SCORE) {
    decision = "shadow";
  }

  return { clusterId: doc.id, score, matched, entityMatched, distinctTerms, decision };
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
