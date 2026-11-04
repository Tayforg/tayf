import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { tidySummaryText } from "@/lib/articles/summary-tidy";
import { normalizeSourceKind } from "@/lib/bias/config";
import { sourceLang } from "@/lib/sources/source-language";
import type { SummaryMember } from "./summary-attribution";

// h31-reader-3 v2: the cluster page's summary is the SEED article's description,
// written once when the cluster is created. On a developing story it can
// contradict the headline on the same page (6e19dd5a: the neutral title says El
// Sayed was elected, the summary says "seçimi önde götürüyor"). The first try,
// "show the newest eligible member", changed 19 of 39 live summaries and 8 of
// them for the worse (a feed-cut stub, a teaser question, a dateline, a glued
// run-on, loaded framing, a round-up that is not about the headline, a dropped
// fact, a contradiction), so this rule is the narrow one: keep the seed UNLESS it
// disagrees with the cluster's current neutral title, and then swap in the member
// that agrees best, if there is one that is clearly better and well formed.
//
// "Agrees" is a linear, deterministic token overlap: the share of the title's
// content tokens that the description carries (`titleAgreement`). It measures
// topical coverage, not meaning. It cannot see that a text which covers the
// headline's words says the opposite, which is why a seed that already covers the
// title (>= AGREEMENT_LOW) is never replaced, and why a replacement must cover it
// almost completely (>= AGREEMENT_HIGH) and far better than the seed
// (>= AGREEMENT_MIN_GAIN). No clock, no I/O.
//
// A replacement is never an agency's copy, exact or near: the neutral title echoes
// the wire lead's wording, so the score favours lightly edited wire text, and a
// candidate that carries 85% or more of a wire or aggregator member's stems (and
// the other way round) is dropped (`textOverlap`, AGENCY_COPY_OVERLAP).
//
// What it does NOT catch: tone and meaning. A text that uses the headline's own
// words but frames the story in loaded terms (2441793c, 0.875) or says something
// else (97589454, 1.0) is clean to every check here. On a healthy cluster the
// seed-agrees gate keeps those out; behind a seed that disagrees with the
// headline they win when they are the best-agreeing member. The other six of the
// eight shapes are kept out lexically (the 0.75 line, the quality predicates).
// summary-attribution.test.ts, section 9, pins both halves, so a change to this
// limit has to be a decision.

/** A seed scoring below this disagrees with the title (exclusive: 0.5 is kept). */
export const AGREEMENT_LOW = 0.5;
/** A replacement must score at least this (inclusive). */
export const AGREEMENT_HIGH = 0.75;
/** A replacement must beat the seed by at least this much (inclusive). */
export const AGREEMENT_MIN_GAIN = 0.3;
/** A title with fewer content tokens carries no signal: the seed is kept. */
export const AGREEMENT_MIN_TITLE_TOKENS = 3;
/** A replacement's tidied text must be at least this long (no stubs, no headlines). */
export const AGREEMENT_MIN_CHARS = 60;
/**
 * A replacement whose content stems overlap a wire or aggregator member's by at
 * least this share (inclusive, against the larger of the two texts) is that
 * agency's copy, not the outlet's own words. In the 280-cluster replay the three
 * picks that re-ran an Anadolu Ajansı lead with a phrase dropped or a word changed
 * scored 0.895, 0.935 and 0.952; the closest pick below the line is 0.80 (a
 * one-sentence rewrite of a BHA lead, kept) and the rest are 0.64 or less. The
 * line is a judgement between those, not a measured boundary.
 */
export const AGENCY_COPY_OVERLAP = 0.85;

/** Guards the ratio comparisons against floating point (9/20 + 0.3 is not 15/20). */
const EPSILON = 1e-9;

/**
 * Tokens are compared on their first five characters: a light stemmer for
 * Turkish's suffixes ("kazandı" and "kazanarak", "seçildi" and "seçilen",
 * "Senato" and "senatör"). It errs towards matching, which only makes the seed
 * look better (the safe side) and a replacement has to clear 0.75 anyway.
 */
const STEM_LENGTH = 5;

/**
 * Function words that carry no topic, in the folded spelling (no diacritics, "ı"
 * as "i"). Small on purpose: "oldu", "ilk", "sonra" are content (the outcome
 * words of a headline are exactly what a stale seed lacks). One-letter tokens are
 * dropped separately. "su" (water) is not here although "şu" folds to it.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  "ve", "ile", "de", "da", "ki", "mi", "mu", "bir", "bu", "icin", "gibi", "daha",
  "cok", "en", "ama", "fakat", "ancak", "veya", "ya", "her", "olarak", "olan",
  "ise", "hem", "ne", "bile", "kadar",
  "the", "an", "of", "in", "on", "to", "and", "for", "is", "at", "by", "with",
  "as", "from", "that", "this", "are", "was", "be", "it", "its",
]);

/** Turkish lower case, diacritics stripped, dotless "ı" as "i": "İSTANBUL", "ISTANBUL" and "İstanbul" agree. */
function fold(s: string): string {
  return s
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/ı/g, "i");
}

// An apostrophe glued to a word starts a Turkish suffix ("Senato'ya", "ABD’nin",
// "14'er"): the suffix goes. A quote mark next to a space is only punctuation.
const APOSTROPHE_SUFFIX = /(?<=[\p{L}\p{N}])['’‘ʼ`´]\p{L}*/gu;
const NOT_A_WORD = /[^\p{L}\p{N}]+/u;

/** Every word of `text` in the folded spelling: apostrophe suffixes gone, split on anything that is not a letter or a digit. */
function words(text: string): string[] {
  return fold(text)
    .replace(APOSTROPHE_SUFFIX, " ")
    .split(NOT_A_WORD)
    .filter((w) => w !== "");
}

/** Stems of the content words of `text` (stopwords and one-letter words dropped). */
function contentStems(text: string): Set<string> {
  const stems = new Set<string>();
  for (const w of words(text)) {
    if (STOPWORDS.has(w)) continue;
    if (w.length < 2 && !/^\p{N}$/u.test(w)) continue;
    stems.add(w.slice(0, STEM_LENGTH));
  }
  return stems;
}

/** The title's content stems, or null when it has too few to say anything. */
function titleStems(title: unknown): Set<string> | null {
  if (typeof title !== "string") return null;
  const stems = contentStems(title);
  return stems.size >= AGREEMENT_MIN_TITLE_TOKENS ? stems : null;
}

function coverage(stems: ReadonlySet<string>, text: unknown): number {
  if (typeof text !== "string") return 0;
  const present = contentStems(text);
  let hits = 0;
  for (const stem of stems) if (present.has(stem)) hits++;
  return hits / stems.size;
}

/**
 * The share of the title's distinct content tokens that `text` carries, 0 to 1,
 * or null when the title has fewer than {@link AGREEMENT_MIN_TITLE_TOKENS}
 * content tokens (or is not a string). Case, Turkish diacritics, punctuation,
 * apostrophe suffixes, stopwords and the order of the words do not matter;
 * tokens match on their first five characters. One pass over each text.
 */
export function titleAgreement(title: string, text: string): number | null {
  const stems = titleStems(title);
  return stems === null ? null : coverage(stems, text);
}

/** Shared stems over the size of the LARGER set: 1 for the same words, 0 when either set is empty. */
function mutualOverlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (large.size === 0) return 0;
  let hits = 0;
  for (const stem of small) if (large.has(stem)) hits++;
  return hits / large.size;
}

/**
 * How much two texts say the same words, 0 to 1: the content stems both carry,
 * over the stems of the larger text. Symmetric. A long article that holds a short
 * lead scores low against it (a lead of 20 stems inside 40 is 0.5), the same lead
 * with a phrase dropped or a word changed scores high (20 of 22 is 0.91). Same
 * folding as {@link titleAgreement}; one pass over each text; 0 for a non-string.
 */
export function textOverlap(a: string, b: string): number {
  if (typeof a !== "string" || typeof b !== "string") return 0;
  return mutualOverlap(contentStems(a), contentStems(b));
}

/** True when the seed's score is low enough to look for something better. */
function disagrees(seedScore: number): boolean {
  return seedScore < AGREEMENT_LOW - EPSILON;
}

/**
 * The three-way gate: the seed is below {@link AGREEMENT_LOW} (exclusive), the
 * candidate is at least {@link AGREEMENT_HIGH} (inclusive) and beats the seed by
 * at least {@link AGREEMENT_MIN_GAIN} (inclusive). A null score on either side
 * (a title with no signal) never switches.
 */
export function agreementSwitches(seedScore: number | null, candidateScore: number | null): boolean {
  if (seedScore === null || candidateScore === null) return false;
  return (
    disagrees(seedScore) &&
    candidateScore >= AGREEMENT_HIGH - EPSILON &&
    candidateScore - seedScore >= AGREEMENT_MIN_GAIN - EPSILON
  );
}

export type SummaryDefect = "stub" | "teaser" | "dateline" | "run-on";

const CLOSERS = new Set(['"', "”", "»", "’", "'", ")", "]"]);

/** `s` without the blanks and closing quotes at its end (a loop: a regex on a long blank run is quadratic). */
function withoutClosingMarks(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charAt(end - 1).trim() === "" || CLOSERS.has(s.charAt(end - 1)))) end--;
  return s.slice(0, end);
}

/** A text that ends in "..." or "…": a feed cut it (Sözcü at 123 characters, Haberport at 203, the ingest clamp at 500). */
function endsCut(s: string): boolean {
  const end = withoutClosingMarks(s);
  return end.endsWith("...") || end.endsWith("…");
}

// A come-on: "Peki, ... kimdir?" "İşte ayrıntılar". A sentence that opens with
// "Peki" or "İşte" (folded: "peki", "iste"), not the same words inside a sentence.
const COME_ON = /(?:^|[.!?…]["”»’')\]]*\s+)(?:peki|iste)(?![\p{L}\p{N}])/u;

function isTeaser(shown: string): boolean {
  return shown.includes("?") || COME_ON.test(fold(shown));
}

// "İSTANBUL (Medyascope) – ...", "ANKARA (AA) - ...", "GÜNEY KORE, (DHA) - ...",
// "Melih Kiram GEDİK, (DHA) - ...", "Ankara, 4 Kasım (AA) - ...": a short lead, a
// parenthesised agency that starts with a letter, a dash.
const AGENCY_DATELINE = /^[^()\n]{0,40}\(\p{L}[^()\n]{0,29}\)\s*[-–—]/u;
// "HABER MERKEZİ - ...", "ANKARA – ...": nothing but capitals up to a dash. At
// least four letters, so "ABD-İran gerilimi" is not a dateline.
const CAPITALS_DATELINE = /^\p{Lu}[\p{Lu}\s.,'’]{1,40}[-–—]/u;
const MIN_DATELINE_LETTERS = 4;

function hasDatelineLead(shown: string): boolean {
  if (AGENCY_DATELINE.test(shown)) return true;
  const caps = CAPITALS_DATELINE.exec(shown);
  return caps !== null && (caps[0].match(/\p{L}/gu)?.length ?? 0) >= MIN_DATELINE_LETTERS;
}

/** The first this many words of a text, repeated further on, are a headline glued onto its own body. */
const RUN_ON_WORDS = 5;

function isRunOn(shown: string): boolean {
  const all = words(shown);
  const k = RUN_ON_WORDS;
  if (all.length < 2 * k) return false;
  for (let start = k; start + k <= all.length; start++) {
    let same = true;
    for (let j = 0; j < k && same; j++) same = all[start + j] === all[j];
    if (same) return true;
  }
  return false;
}

/**
 * Why a description is not fit to stand in for the seed, or null. `raw` is the
 * member's repaired, trimmed description and `shown` its tidied form
 * (`tidySummaryText`). Checked in this order, the first that applies is returned:
 *   - "stub": a feed cut it ("..." or "…" at the end, raw or tidied);
 *   - "teaser": a question mark anywhere, or a sentence that opens with Peki/İşte;
 *   - "dateline": an agency or all-caps place lead ("İSTANBUL (Medyascope) –");
 *   - "run-on": its first five words come again later (a title glued to the body).
 * Never throws.
 */
export function summaryDefect(raw: string, shown: string): SummaryDefect | null {
  if (typeof raw !== "string" || typeof shown !== "string") return null;
  if (endsCut(raw) || endsCut(shown)) return "stub";
  if (isTeaser(shown)) return "teaser";
  if (hasDatelineLead(shown)) return "dateline";
  if (isRunOn(shown)) return "run-on";
  return null;
}

/** The member that should replace the seed, with the text to show (its tidied description). */
export interface AgreeingPick {
  member: SummaryMember;
  text: string;
}

interface Scored extends AgreeingPick {
  score: number;
  /** Publish time for "newest" ordering; unknown is oldest. */
  recency: number;
  /** Publish time for "earliest" ordering; unknown is latest. */
  seniority: number;
}

function byNewest(a: Scored, b: Scored): number {
  return (
    b.score - a.score ||
    b.recency - a.recency ||
    a.member.source.name.localeCompare(b.member.source.name, "tr")
  );
}

/**
 * The member whose description should replace the seed's on the cluster page, or
 * null to keep the seed. Pure, one pass over the members plus one sort of the
 * qualifiers.
 *
 * The seed must disagree with `title` ({@link AGREEMENT_LOW}); a title without
 * enough content tokens, or a seed that agrees, returns null before any other
 * member is looked at. A member qualifies when ALL of these hold:
 *   - its source allows excerpts (`excerpt_allowed !== false`) and is not a wire
 *     or aggregator (`normalizeSourceKind`; a missing kind is an outlet);
 *   - it is written in the seed's language (`sourceLang`);
 *   - its content hash is not one of `wireMajorityHashes` (the dispatch a wire
 *     redistribution copied: the seed's own check, applied to the candidate);
 *   - its description, repaired and trimmed, is not empty, is not the text of a
 *     rights-blocked member and is not the text of a wire or aggregator member (a
 *     copy of an agency's words is the agency's), and its tidied text is not a
 *     near copy of one either ({@link AGENCY_COPY_OVERLAP}: a phrase dropped, a
 *     word changed, a CTA tail added still leave the agency's words);
 *   - its tidied text is at least {@link AGREEMENT_MIN_CHARS} long and has no
 *     {@link summaryDefect};
 *   - its score passes {@link agreementSwitches}. A copy of the seed's text scores
 *     what the seed scores, so it can never pass.
 * Among the qualifiers the highest score wins and a tie goes to the newest; the
 * outlet name, ascending in Turkish order, settles the same instant, so the pick
 * never depends on the member order. Members with the same text count once and
 * are credited to the earliest of them, as `findSeedMember` credits the seed.
 */
export function findAgreeingMember({
  members,
  seed,
  seedShown,
  title,
  wireMajorityHashes,
}: {
  members: readonly SummaryMember[];
  seed: SummaryMember;
  /** The seed's tidied text: what the page would show without a replacement. */
  seedShown: string;
  title: string;
  wireMajorityHashes: ReadonlySet<string>;
}): AgreeingPick | null {
  const stems = titleStems(title);
  if (stems === null) return null;
  const seedScore = coverage(stems, seedShown);
  if (!disagrees(seedScore)) return null;

  const texts = members.map((m) => repairEntityResidue(m.article.description ?? "").trim());
  const blockedTexts = new Set<string>();
  const agencyTexts = new Set<string>();
  members.forEach((m, i) => {
    if (m.source.excerpt_allowed === false) blockedTexts.add(texts[i] ?? "");
    const kind = normalizeSourceKind(m.source.kind);
    if (kind === "wire" || kind === "aggregator") agencyTexts.add(texts[i] ?? "");
  });

  // The wire and aggregator members' tidied stems, built on first use: only a
  // member that already passed every other gate is compared against them.
  let agencyStems: Set<string>[] | null = null;
  const isAgencyCopy = (shown: string): boolean => {
    if (agencyStems === null) {
      agencyStems = [];
      const seen = new Set<string>();
      members.forEach((m, i) => {
        const kind = normalizeSourceKind(m.source.kind);
        const raw = texts[i] ?? "";
        if ((kind !== "wire" && kind !== "aggregator") || raw === "" || seen.has(raw)) return;
        seen.add(raw);
        agencyStems!.push(contentStems(tidySummaryText(raw)));
      });
    }
    const own = contentStems(shown);
    return agencyStems.some((agency) => {
      // The overlap cannot reach the line when one text is much the smaller.
      const [small, large] = own.size <= agency.size ? [own.size, agency.size] : [agency.size, own.size];
      if (large === 0 || small / large < AGENCY_COPY_OVERLAP - EPSILON) return false;
      return mutualOverlap(own, agency) >= AGENCY_COPY_OVERLAP - EPSILON;
    });
  };

  const seedLang = sourceLang(seed.source);
  // Same text, one entry: the earliest publisher.
  const byText = new Map<string, Scored>();
  members.forEach((m, i) => {
    if (m === seed) return;
    if (m.source.excerpt_allowed === false) return;
    // Stated outright although `agencyTexts` below implies it (an agency's own
    // text is in that set): the rule is "no wire or aggregator member".
    const kind = normalizeSourceKind(m.source.kind);
    if (kind === "wire" || kind === "aggregator") return;
    if (sourceLang(m.source) !== seedLang) return;
    const hash = m.article.content_hash;
    if (hash !== null && wireMajorityHashes.has(hash)) return;
    const raw = texts[i] ?? "";
    if (raw === "" || blockedTexts.has(raw) || agencyTexts.has(raw)) return;

    const shown = tidySummaryText(raw);
    if (shown.length < AGREEMENT_MIN_CHARS) return;
    if (summaryDefect(raw, shown) !== null) return;
    const score = coverage(stems, shown);
    if (!agreementSwitches(seedScore, score)) return;
    if (isAgencyCopy(shown)) return;

    const t = Date.parse(m.article.published_at);
    const entry: Scored = {
      member: m,
      text: shown,
      score,
      recency: Number.isFinite(t) ? t : -Infinity,
      seniority: Number.isFinite(t) ? t : Infinity,
    };
    const held = byText.get(raw);
    if (
      held === undefined ||
      entry.seniority < held.seniority ||
      (entry.seniority === held.seniority &&
        entry.member.source.name.localeCompare(held.member.source.name, "tr") < 0)
    ) {
      byText.set(raw, entry);
    }
  });

  let best: Scored | null = null;
  for (const entry of byText.values()) {
    if (best === null || byNewest(entry, best) < 0) best = entry;
  }
  return best === null ? null : { member: best.member, text: best.text };
}
