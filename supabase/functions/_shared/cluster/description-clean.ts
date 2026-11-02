// supabase/functions/_shared/cluster/description-clean.ts
//
// Clustering-time clean-up of an article description. Pure, no imports:
// unit-tested from vitest and used from Deno.
//
// Milliyet's RSS description ends with the site's own "Son dakika..." ticker,
// the headline of a different, unrelated story ("...harekete geçebilir.\nSon
// dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! ..."). Fed
// into the entity extractor, the fingerprint and the tf-idf index, it gave the
// article foreign entities (mhp, bahceli on a social-media age-verification
// scam, article 942d7061), seeded an off-topic cluster, and pulled three
// Bahçeli articles into it (hunt 12, h12-cluster-5).
//
// This runs ONLY in the cluster consumer, on the way into enrichment. It is
// deliberately not wired into rss/normalize.ts: strictFingerprint, content_hash
// and normalizeItem output stay byte-identical (tests/functions/_shared/
// ingest-corpus-equality.test.ts), and the stored description is untouched.

// A ticker line: "Son dakika", "SON DAKİKA" or "Son Dakika" at the start of a
// line (leading blanks allowed), followed by 1-3 dots, an ellipsis, a colon or
// an exclamation mark. "Son dakika haberi" (no punctuation) and a lower-case
// "son dakika" mid-sentence are not tickers.
const TICKER_LINE = /^\s*(?:Son dakika|SON DAKİKA|Son Dakika)\s*(?:\.{1,3}|…|:|!)/u;

export function cleanDescription(d: string): string;
export function cleanDescription(d: string | null): string | null;
export function cleanDescription(d: string | undefined): string | undefined;
export function cleanDescription(d: string | null | undefined): string | null | undefined;
export function cleanDescription(d: string | null | undefined): string | null | undefined {
  if (!d) return d;
  // The first line can never be a ticker block: the ticker is appended to an
  // article, so a "Son dakika..." opening is the article's own text.
  let at = d.indexOf("\n");
  while (at !== -1) {
    const next = d.indexOf("\n", at + 1);
    const line = d.slice(at + 1, next === -1 ? d.length : next);
    if (TICKER_LINE.test(line)) return d.slice(0, at).trimEnd();
    at = next;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Description swap detector (h16-precision-2, hunt 16). LOG-ONLY this wave.
//
// A publisher can ship the RSS description of a DIFFERENT story: sabah
// 1bf7ab12's title is "Başkan Erdoğan, KKTC Cumhurbaşkanı Erhürman ile
// görüştü" but its description is the Berdimuhammedov meeting ("...Türkmenistan
// Devlet Başkanı Serdar Berdimuhammedov'la Cumhurbaşkanlığı Külliyesi'nde...").
// Fed into the fingerprint, the entities and tf-idf, it scored as a
// Berdimuhammedov story and bridged the Erhürman and Caparov meetings into one
// cluster (575fc5eb).
//
// descriptionNamesSwap() reports the pattern: the person names of the title and
// of the first DESCRIPTION_SWAP_HEAD_CHARS characters of the cleaned
// description are both non-empty and share no name stem. A blanket "no shared
// stem" rule over all capitalised words hit 3.4% of articles (sozcu 19%), so a
// name here is deliberately narrow: a curated list of public figures, or the
// short run of capitalised words right after a role word ("Devlet Başkanı Serdar
// Berdimuhammedov"). The two hosts of most diplomacy items are ignored on both
// sides.
//
// Pure, no imports (the pure-module guard in the tests enforces it). Nothing
// here is wired into scoring: the consumer only COUNTS suspects per drain.
// ---------------------------------------------------------------------------

/**
 * What the consumer does with a suspect.
 *  - 'off': the detector is not called.
 *  - 'log': the consumer counts suspects per drain (the "[cluster-consumer]
 *    drain" line and the HTTP body). Clustering text is unchanged.
 *  - 'drop-description': reserved for a later wave (fingerprint and tf-idf text
 *    would use the title only). NOT wired anywhere yet: it counts like 'log'.
 */
export type DescriptionSwapGuardMode = "off" | "log" | "drop-description";

// The explicit annotation widens the literal so a consumer comparison such as
// `DESCRIPTION_SWAP_GUARD === "off"` type-checks.
export const DESCRIPTION_SWAP_GUARD: DescriptionSwapGuardMode = "log";

/** How much of the cleaned description is searched for names. */
export const DESCRIPTION_SWAP_HEAD_CHARS = 200;
/** Name stems are compared on their first N folded characters. */
export const DESCRIPTION_SWAP_PREFIX = 5;

// Same table as fingerprint.ts DIACRITIC_MAP (parity-tested). Inline: this
// module has no imports.
const NAME_FOLD: Record<string, string> = {
  ş: "s", Ş: "s",
  ı: "i", İ: "i", I: "i",
  ü: "u", Ü: "u",
  ö: "o", Ö: "o",
  ç: "c", Ç: "c",
  ğ: "g", Ğ: "g",
  â: "a", Â: "a",
  î: "i", Î: "i",
  û: "u", Û: "u",
};
const NAME_FOLD_RE = new RegExp(`[${Object.keys(NAME_FOLD).join("")}]`, "g");

/** Diacritic-fold, lower-case, then keep only [a-z0-9]. */
export function foldNameToken(s: string): string {
  if (typeof s !== "string" || !s) return "";
  return s
    .replace(NAME_FOLD_RE, (ch) => NAME_FOLD[ch] ?? ch)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

// Public figures whose names recur in diplomacy and party-politics headlines,
// folded. The homographs of common words (özel, yavaş, tatar, yılmaz) are left
// out on purpose: they are names only after a role word, which the run rule
// below already covers.
export const CURATED_PERSONS: ReadonlySet<string> = new Set([
  "bahceli", "imamoglu", "babacan", "davutoglu", "dervisoglu", "bakirhan",
  "kurtulmus", "putin", "trump", "biden", "zelenski", "zelenskiy",
  "netanyahu", "aliyev", "tokayev", "mirziyoyev", "caparov",
  "berdimuhammedov", "erhurman", "macron", "merz", "starmer", "meloni",
  "orban", "lavrov", "rubio", "guterres", "rutte", "pezeskiyan", "sisi",
  "vucic", "pasinyan", "micotakis",
]);

// A name follows these words ("Devlet Başkanı Serdar Berdimuhammedov").
export const ROLE_TOKENS: ReadonlySet<string> = new Set([
  "baskan", "baskani", "cumhurbaskani", "cumhurbaskanimiz", "basbakan",
  "basbakani", "bakan", "bakani", "lideri", "sozcusu", "sekreteri",
  "yardimcisi", "danismani", "basdanismani", "valisi", "milletvekili",
  "adayi", "kral", "krali", "emiri", "prensi",
]);

// Capitalised words that are not part of a name even right after a role word.
export const NAME_STOP: ReadonlySet<string> = new Set([
  "son", "dakika", "haber", "haberi", "flas", "canli", "video", "genel",
  "devlet", "yeni", "eski",
]);

// Skipped inside a name run ("Sağlık Bakanı Prof. Dr. Kemal Memişoğlu").
export const HONORIFICS: ReadonlySet<string> = new Set([
  "prof", "dr", "doc", "av", "sn", "sayin",
]);

// The hosts of most diplomacy items. They appear on both sides of nearly every
// pair, so they say nothing about a swap: removed from both name sets (erdogan
// and fidan are already GENERIC_ENTITIES in constants.ts).
export const HOST_NAMES: ReadonlySet<string> = new Set([
  "recep", "tayyip", "erdogan", "hakan", "fidan",
]);

const NAME_RUN_MAX = 3;
const NAME_MIN_LEN = 3;
// A token that closes the run it is in: , ; : . ! ? | ) "
const RUN_END_PUNCT = /[,;:.!?|)"]$/;
const APOSTROPHE = /['’‘ʼ]/;
const CAPITAL_START = /^\p{Lu}/u;
const HAS_LOWER = /\p{Ll}/u;

/**
 * The folded person names in `text`: a capitalised curated name, or up to three
 * capitalised words after a role word. Acronyms (KKTC, TDT, ABD) and ALL-CAPS
 * text are never names. Never throws; null, '' and non-strings give an empty set.
 */
export function personNames(text: string | null | undefined): Set<string> {
  const out = new Set<string>();
  if (typeof text !== "string" || !text) return out;
  let anchored = false; // inside the run that follows a role word
  let taken = 0; // capitalised words taken in the current run
  for (const token of text.split(/\s+/)) {
    if (!token) continue;
    const cut = token.search(APOSTROPHE);
    // "Berdimuhammedov’la" -> "Berdimuhammedov"; a suffix closes the run.
    const stem = cut === -1 ? token : token.slice(0, cut);
    const closes = cut !== -1 || RUN_END_PUNCT.test(token);
    const f = foldNameToken(stem);
    if (ROLE_TOKENS.has(f)) {
      // Consecutive role words keep the anchor ("Cumhurbaşkanı Yardımcısı").
      anchored = !closes;
      taken = 0;
      continue;
    }
    if (anchored && HONORIFICS.has(f)) continue; // "Prof." "Dr." keep the run open
    const nameLike = CAPITAL_START.test(stem) && HAS_LOWER.test(stem) && !NAME_STOP.has(f);
    if (nameLike && f.length >= NAME_MIN_LEN && CURATED_PERSONS.has(f)) out.add(f);
    if (!anchored) continue;
    if (!nameLike) {
      anchored = false;
      continue;
    }
    if (f.length >= NAME_MIN_LEN) out.add(f);
    taken += 1;
    if (taken >= NAME_RUN_MAX || closes) anchored = false;
  }
  return out;
}

function withoutHosts(names: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const n of names) if (!HOST_NAMES.has(n)) out.add(n);
  return out;
}

function foldedTokens(text: string): string[] {
  const out: string[] = [];
  for (const t of text.split(/\s+/)) {
    const f = foldNameToken(t);
    if (f) out.push(f);
  }
  return out;
}

/** True when some name's stem (first DESCRIPTION_SWAP_PREFIX chars) starts one of the tokens. */
function sharesStem(names: Set<string>, tokens: string[]): boolean {
  for (const n of names) {
    const stem = n.slice(0, DESCRIPTION_SWAP_PREFIX);
    for (const t of tokens) if (t.startsWith(stem)) return true;
  }
  return false;
}

/**
 * True when the title and the head of the description each name at least one
 * person (hosts excluded) and no name of either side shares a stem with any word
 * of the other side: the description most likely belongs to another story.
 * Abstains (false) on null/empty input, a title or description that names no
 * one, and any error.
 */
export function descriptionNamesSwap(title: string | null | undefined, description: string | null | undefined): boolean {
  try {
    if (typeof title !== "string" || typeof description !== "string") return false;
    if (!title || !description) return false;
    const head = cleanDescription(description).slice(0, DESCRIPTION_SWAP_HEAD_CHARS);
    const t = withoutHosts(personNames(title));
    if (t.size === 0) return false;
    const d = withoutHosts(personNames(head));
    if (d.size === 0) return false;
    if (sharesStem(t, foldedTokens(head))) return false;
    if (sharesStem(d, foldedTokens(title))) return false;
    return true;
  } catch {
    return false;
  }
}
