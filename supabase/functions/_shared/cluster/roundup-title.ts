// Roundup titles: the daily "what is in today's Resmi Gazete" digest, the
// "gündem özeti" and the news-bulletin headers. A roundup lists every item of the
// day, so its title is similar to whichever single story the day's headlines share
// and the clusterer attached it to an unrelated cluster (2026-11-02: bha's
// "Resmi Gazete'de bugün: 1 Kasım 2026 Resmi Gazete kararları" sat in the
// 16-article appointments cluster 85700dfa, the 2 Kasım one in the 15-article
// Cevdet Yılmaz vekalet cluster 8f0bb5b8). cluster-consumer skips such an article
// instead of clustering it.
//
// isRoundupTitle() recognises WHOLE-TITLE shapes only. A headline that merely
// contains the phrase ("Resmi Gazete'de yayımlandı: Asgari ücret desteği uzatıldı",
// "TRT Akşam Bülteni'nde Bahçeli açıklaması", "Gündem özeti: Erdoğan ile Bahçeli
// görüştü") is a story and is never matched: every shape is anchored at both ends.
//
// Shapes, on the normalised title (see normalise()). DATE is "2 kasim", "2 kasim 2026",
// "2 kasim 2026 pazartesi", "2 kasim pazartesi 2026", "02.11.2026" or "02/11/2026"
// (the numeric form may carry a weekday). A date tail is DATE introduced by one of
// - – — : | , (or by a bare space), or DATE wrapped in parentheses.
//
//   A  resmi gazete'de bugün[ neler var][date tail[ resmi gazete][ kararları]]
//   B  DATE[ tarihli] resmi gazete[ kararları[ ne|neler[ var]]][: resmi gazete'de neler var]
//   C  bugünkü resmi gazete[ kararları][date tail]
//   D  resmi gazete'de (yayımlandı|yayımlanan kararlar) date tail   (the date is REQUIRED)
//   E  (günün önemli gelişmeleri|günün özeti|gündem özeti|sabah bülteni|akşam bülteni|haber turu)[date tail]
//
// Shapes added because the read-only 14-day export (2026-10-20 .. 2026-11-02, 325 rows)
// showed them and every hit is a true roundup:
//
//   A+ bha's "Resmi Gazete'de bugün: 21 Ekim 2026 Resmi Gazete kararları" (also with the
//      "kararlrı" typo, and "...: 30 Ekim 2026 kararları"): the tail of A carries the
//      second "resmi gazete" / "kararları" words.
//   F  DATE gününün[ son dakika] önemli gelişmeleri[!][ (cnn türk 16.30 bülteni)]   (CNN Türk)
//      and "Günün Özeti (01.11.2026 Pazar)" (istiklal), which is E with a numeric date + weekday.
//   G  haberler-com's daily SEO title "21 Ekim Çarşamba 2026 Resmi Gazete ATAMA KARARLARI!
//      Bugünün kararları neler? 21 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!"
//   H  posta's "RESMİ GAZETE KARARLARI 26 EKİM 2026! Resmi Gazete'de bugünün kararları neler?"
//
// Deliberately NOT matched: "21 EKİM RESMİ GAZETE KARARLARI: <one decision's headline>" (CNN
// Türk) carries a story; "Piyasalarda günün özeti: 20 Ekim 2026 BIST 100'de ..." is a market
// recap, not a politics roundup.
//
// ReDoS: every pattern below is built from literal text, `?`, `{n}` and `{n,m}` only. There is
// no `*`, no `+` and no nested quantifier, the input is capped, and the whitespace / punctuation
// handling is a character scan, not a regex.
//
// Keep this module dependency-free: it has to compile under tsc (Next, vitest) and deno with
// no import map, and NEVER via a `./x.ts`-extension relative import under
// `moduleResolution: bundler` (TS5097). It has no mirror under scripts/lib/cluster.

/** The `reason` of a "skipped" outcome for a roundup title (and its by_reason key). */
export const ROUNDUP_SKIP_REASON = "roundup-title";

// Longest real roundup title in the export is ~145 characters. Anything longer than this
// before normalisation cannot be one of the shapes below and is rejected without work.
const MAX_RAW_CHARS = 400;

// Characters dropped from the end of the title: sentence punctuation, quotes, spaces.
const TRAILING_NOISE = new Set([".", "!", "?", "…", '"', "“", "”", "„", "«", "»", "'", " "]);
// Characters dropped from the start: wrapping quotes and spaces.
const LEADING_NOISE = new Set(['"', "“", "”", "„", "«", "»", "'", " "]);

// Characters rewritten one for one after lower-casing: the circumflex vowels and apostrophe
// variants from the spec, then the remaining Turkish letters, so "RESMI GAZETE'DE BUGUN"
// (an uppercase ASCII I lower-cases to a dotless ı under 'tr') and "gundem ozeti" match too.
const FOLD: Record<string, string> = {
  "î": "i",
  "â": "a",
  "û": "u",
  "’": "'",
  "‘": "'",
  "`": "'",
  "´": "'",
  "ʼ": "'",
  "ı": "i",
  "ç": "c",
  "ğ": "g",
  "ö": "o",
  "ş": "s",
  "ü": "u",
};

function isSpaceChar(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\f" || ch === "\v" || ch === " " ||
    ch === " " || ch === " " || ch === "﻿" || ch === " " || ch === "　" ||
    (ch >= " " && ch <= " ") || ch === " " || ch === " ";
}

/** NFC, Turkish lower-case, folded letters, single spaces, no wrapping quotes and no
 * trailing punctuation. Linear: one pass to fold and collapse, two to trim. */
function normalise(raw: string): string {
  const lowered = raw.normalize("NFC").toLocaleLowerCase("tr");
  const out: string[] = [];
  let lastWasSpace = true; // leading whitespace is dropped
  for (const ch of lowered) {
    if (isSpaceChar(ch)) {
      if (!lastWasSpace) out.push(" ");
      lastWasSpace = true;
      continue;
    }
    out.push(FOLD[ch] ?? ch);
    lastWasSpace = false;
  }
  let start = 0;
  let end = out.length;
  while (end > start && TRAILING_NOISE.has(out[end - 1]!)) end -= 1;
  while (start < end && LEADING_NOISE.has(out[start]!)) start += 1;
  return out.slice(start, end).join("");
}

// ---------------------------------------------------------------------------
// Pattern fragments (strings, so the shapes read as the table above).
// ---------------------------------------------------------------------------

const MONTH = "(?:ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik)";
const WEEKDAY = "(?:pazartesi|sali|carsamba|persembe|cuma|cumartesi|pazar)";
const DATE_TEXT = `\\d{1,2} ${MONTH}(?: ${WEEKDAY})?(?: \\d{4})?(?: ${WEEKDAY})?`;
const DATE_NUM = `\\d{1,2}[./]\\d{1,2}[./]\\d{4}(?: ${WEEKDAY})?`;
const DATE = `(?:${DATE_TEXT}|${DATE_NUM})`;
// - (hyphen) en dash em dash : | ,
const SEP = "[-\\u2013\\u2014:|,]";
// A date introduced by a separator or a bare space, or wrapped in parentheses.
const DATE_TAIL = `(?:(?: ?${SEP} ?| )${DATE}| ?\\( ?${DATE} ?\\))`;
// "kararları" and the typo seen on bha's titles ("kararlrı"); kararlar.
const KARAR = "karar(?:lari?|lri)";
const RG = "resmi gazete";
const RG_DE = "resmi gazete'?de";

const SHAPES: readonly RegExp[] = [
  // A (+ A+)
  new RegExp(`^${RG_DE} bugun(?: neler var)?(?:${DATE_TAIL}(?: ${RG})?(?: ${KARAR})?)?$`),
  // B
  new RegExp(
    `^${DATE}(?: tarihli)? ${RG}(?: ${KARAR}(?: (?:ne|neler)(?: var)?)?)?(?: ?${SEP} ?${RG_DE} neler var)?$`,
  ),
  // C
  new RegExp(`^bugunku ${RG}(?: ${KARAR})?(?:${DATE_TAIL})?$`),
  // D (the date tail is required)
  new RegExp(`^${RG_DE} (?:yayimlandi|yayimlanan kararlar)${DATE_TAIL}$`),
  // E
  new RegExp(
    `^(?:gunun onemli gelismeleri|gunun ozeti|gundem ozeti|sabah bulteni|aksam bulteni|haber turu)(?:${DATE_TAIL})?$`,
  ),
  // F
  new RegExp(
    `^${DATE} gununun (?:son dakika )?onemli gelismeleri!?(?: ?\\((?:cnn turk )?\\d{1,2}[.:]\\d{2} bulteni\\))?$`,
  ),
  // G
  new RegExp(
    `^${DATE} ${RG} atama ${KARAR}!? bugunun kararlari neler\\??` +
      ` ${DATE} ${RG} yayimlandi!? ${RG} atamalar listesi$`,
  ),
  // H
  new RegExp(`^${RG} ${KARAR} ${DATE}(?: ?[!\\-\\u2013\\u2014:|,] ?${RG_DE} bugunun kararlari neler)?$`),
];

/** True when `title` is, as a whole, a daily roundup / bulletin header and must not be
 * clustered. Non-strings, '' and every title that is a story return false. */
export function isRoundupTitle(title: unknown): boolean {
  if (typeof title !== "string") return false;
  if (title.length === 0 || title.length > MAX_RAW_CHARS) return false;
  const t = normalise(title);
  if (t.length === 0) return false;
  for (const shape of SHAPES) {
    if (shape.test(t)) return true;
  }
  return false;
}
