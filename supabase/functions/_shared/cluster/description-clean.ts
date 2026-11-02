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
//
// Two publishers also wrap every description in feed furniture (hunt 19,
// h19-ingest-2): Diken ("<title> dd.mm.yyyy Diken<body>\nThe post <title>
// appeared first on #site_linkat dd.mm.yyyy .") and Serbestiyet ("<body>\n<title>
// yazısı ilk önce Serbestiyet adresinde yayınlanmıştır."). stripFeedWrappers()
// removes that furniture. cleanDescription() applies it first, then the ticker
// cut, and src/lib/articles/summary-tidy.ts imports the same function to tidy
// the summary at read time, so the clustering text and the shown text agree.
//
// WordPress also ends an excerpt with " [&hellip;]" (hunt 20, h20-live-4: on-haber
// 174 of 177 descriptions in 48 h, "... Bu çalışmaların ardından […]"). A TRAILING
// marker is not text: stripFeedWrappers() turns it into one "…" (or drops it after
// a sentence mark). A marker anywhere else is left alone.
//
// Medyascope ends every description with its own headline again and the site name
// ("<body>\n<headline> Medyascope"; hunt 24, h24-feeds-2: 428 of 430 articles in 14
// days, 5 cluster summaries, the live /rss.xml item of 6e2ecaea). That last line is
// not text either: stripSiteNameFooter() drops it. Only the cluster consumer and the
// read side use stripFeedWrappers(); rss/normalize.ts has its own cleaner, so the
// ingested description and content_hash stay byte-identical.
//
// Milliyet also puts a "related news" headline on the line right before the ticker
// ("...her gayrete hazırız\nSon dakika... Rusya için 3 fırsat!", hunt 23,
// h23-live-2). cutAppendedTicker() is the pure cut the READ side uses
// (src/lib/articles/summary-tidy.ts): it cuts at the ticker line like
// cleanDescription() does and also drops up to two short, unpunctuated lines in
// front of it. cleanDescription()'s own output is deliberately unchanged.

// A ticker line: "Son dakika", "SON DAKİKA" or "Son Dakika" at the start of a
// line (leading blanks allowed), followed by 1-3 dots, an ellipsis, a colon or
// an exclamation mark. "Son dakika haberi" (no punctuation) and a lower-case
// "son dakika" mid-sentence are not tickers.
const TICKER_LINE = /^\s*(?:Son dakika|SON DAKİKA|Son Dakika)\s*(?:\.{1,3}|…|:|!)/u;

// ---------------------------------------------------------------------------
// Feed wrappers (h19-ingest-2, hunt 19). Only indexOf / lastIndexOf, character
// scans and bounded, anchored regexes: every rule is linear in the input and
// looks at no more than a few hundred characters around its anchor.
// ---------------------------------------------------------------------------

// WordPress default footer: "The post <title> appeared first on <site>."
const WP_FOOTER_LEAD = "The post ";
const WP_FOOTER_MID = " appeared first on ";
/** Longest "<title>" between the two markers. */
const WP_FOOTER_MAX_TITLE = 300;
/** Longest "<site>" after the second marker ("#site_linkat 02.11.2026 ." is 25). */
const WP_FOOTER_MAX_TAIL = 80;

// Yoast footer (Turkish): "<title> yazısı ilk önce <site> adresinde yayınlanmıştır."
const YOAST_FOOTER_MARK = " yazısı ilk önce ";
const YOAST_FOOTER_TAIL = /^ yazısı ilk önce .{1,40}? adresinde yayınlanmıştır\.?\s*$/u;
/** The footer's "<title>" sits within this many characters before the marker. */
const YOAST_FOOTER_MAX_TITLE = 300;

// Diken header: "<title> dd.mm.yyyy Diken<body>" ("Dikenli" is not the site name).
const DIKEN_HEADER = / \d{2}\.\d{2}\.\d{4} Diken(?!\p{Ll})/u;
const DIKEN_HEADER_WINDOW = 340;
const DIKEN_HEADER_MAX_INDEX = 300;

// Site-name footer (h24-feeds-2): "<body>\n<headline> Medyascope". The list is
// deliberately a single name; a publisher is added only with evidence.
const SITE_NAME_FOOTERS = ["Medyascope"] as const;
/** The footer's "<headline>" line is at most this long (trimmed); a longer line is text. */
const SITE_FOOTER_MAX_LINE = 300;

// WordPress excerpt marker, in the four spellings feeds ship it in: the literal
// ellipsis, three dots, and the two HTML entities for the ellipsis.
const EXCERPT_MARKERS = ["[…]", "[...]", "[&#8230;]", "[&hellip;]"] as const;

/** Upper bound on how many times the four rules are re-applied (a doubled footer). */
const MAX_WRAPPER_PASSES = 3;

function isBlank(code: number): boolean {
  return code === 32 || code === 9 || code === 160;
}

/** "The post X appeared first on Y" at the very end: cut from "The post ". */
function stripWordPressFooter(text: string): string {
  const i = text.lastIndexOf(WP_FOOTER_LEAD);
  if (i === -1) return text;
  const j = text.indexOf(WP_FOOTER_MID, i);
  if (j === -1 || j - i > WP_FOOTER_MAX_TITLE) return text;
  const tailStart = j + WP_FOOTER_MID.length;
  if (text.length - tailStart > WP_FOOTER_MAX_TAIL) return text;
  if (text.indexOf("\n", tailStart) !== -1) return text;
  return text.slice(0, i).trimEnd();
}

/**
 * "<title> yazısı ilk önce <site> adresinde yayınlanmıştır." at the very end.
 * The title is the last line before the marker or, on a one-line text, the
 * words after the last sentence mark. A footer whose start cannot be found
 * within 300 characters is left alone, except when the marker itself is that
 * close to the start of the text (the text is then the footer and nothing else).
 */
function stripYoastFooter(text: string): string {
  const k = text.lastIndexOf(YOAST_FOOTER_MARK);
  if (k === -1) return text;
  if (!YOAST_FOOTER_TAIL.test(text.slice(k))) return text;
  const lowest = Math.max(0, k - YOAST_FOOTER_MAX_TITLE);
  let start = -1;
  for (let p = k - 1; p >= lowest; p--) {
    if (text.charCodeAt(p) === 10) {
      start = p;
      break;
    }
  }
  if (start === -1) {
    for (let p = k - 1; p >= lowest; p--) {
      const c = text.charAt(p);
      if ((c === "." || c === "!" || c === "?" || c === "…") && isBlank(text.charCodeAt(p + 1))) {
        start = p + 2;
        break;
      }
    }
  }
  if (start === -1) return k <= YOAST_FOOTER_MAX_TITLE ? "" : text;
  return text.slice(0, start).trimEnd();
}

/** "<title> dd.mm.yyyy Diken<body>": drop everything through "Diken". */
function stripDikenHeader(text: string): string {
  const head = text.slice(0, DIKEN_HEADER_WINDOW);
  const m = DIKEN_HEADER.exec(head);
  if (!m || m.index < 1 || m.index > DIKEN_HEADER_MAX_INDEX) return text;
  if (head.lastIndexOf("\n", m.index) !== -1) return text;
  return text.slice(m.index + m[0].length).trimStart();
}

/**
 * "<headline> Medyascope" as the LAST line (hunt 24, h24-feeds-2): the site name
 * at the very end of the text, a blank (space, tab, NBSP) or a newline right in
 * front of it, and the line it ends at most {@link SITE_FOOTER_MAX_LINE}
 * characters long once trimmed. The whole last line goes, together with the
 * blanks and newlines in front of it. The SAME string is returned when
 *  - the text does not end with the name (blanks and newlines after it are
 *    ignored), or the name is glued to the previous word ("XMedyascope"), or
 *    written in another case, or followed by anything ("Medyascope.");
 *  - the footer would be on line 0: the first line is the article's own text,
 *    so a one-line "<headline> Medyascope" stays (a headline-only description
 *    is never emptied);
 *  - the last line is longer than the limit, or what is left of the text is
 *    blank ("\nMedyascope" alone).
 * Only trim / trimEnd / endsWith / lastIndexOf and character checks: linear, no regex.
 */
function stripSiteNameFooter(text: string): string {
  const t = text.trimEnd();
  for (const name of SITE_NAME_FOOTERS) {
    if (!t.endsWith(name)) continue;
    const start = t.length - name.length;
    if (start <= 0) continue;
    const before = t.charCodeAt(start - 1);
    if (!isBlank(before) && before !== 10) continue;
    const nl = t.lastIndexOf("\n", start - 1);
    if (nl <= 0) continue; // line 0 is never a footer
    if (t.slice(nl + 1, start).trim().length > SITE_FOOTER_MAX_LINE) continue;
    const head = t.slice(0, nl).trimEnd();
    if (head.trim() === "") continue;
    return head;
  }
  return text;
}

/**
 * A WordPress excerpt marker ("[…]", "[...]", "[&#8230;]", "[&hellip;]") at the
 * very end, blanks and newlines after it allowed: it stands for "the text goes
 * on", so it becomes one "…" glued to the last word. After a sentence mark (. ! ?
 * or …) the sentence is already closed and the marker is just dropped, and a text
 * that was only the marker gives ''. A marker anywhere but the end is ordinary
 * text; the SAME string is returned when there is no trailing marker.
 */
function stripExcerptMarker(text: string): string {
  const t = text.trimEnd();
  for (const marker of EXCERPT_MARKERS) {
    if (!t.endsWith(marker)) continue;
    const head = t.slice(0, t.length - marker.length).trimEnd();
    if (head === "") return "";
    const last = head.charAt(head.length - 1);
    if (last === "." || last === "!" || last === "?" || last === "…") return head;
    return head + "…";
  }
  return text;
}

/**
 * Remove the Diken header, the WordPress / Yoast footers, the Medyascope
 * site-name footer ("<headline> Medyascope" as the last line, hunt 24: 428 of 430
 * articles) and the trailing WordPress excerpt marker ("[…]") that feeds wrap
 * around a description. The footers go first (the site-name footer innermost, so
 * a WordPress / Yoast footer or a marker in front of it is trailing once it is
 * gone), then the header, then the marker. Returns the SAME string when nothing
 * matches, '' when the text was only a footer or a marker, and is idempotent (the
 * rules are re-applied until nothing changes, at most {@link MAX_WRAPPER_PASSES}
 * times).
 */
export function stripFeedWrappers(text: string): string {
  if (!text) return text;
  let out = text;
  for (let pass = 0; pass < MAX_WRAPPER_PASSES; pass++) {
    const next = stripExcerptMarker(
      stripDikenHeader(stripYoastFooter(stripWordPressFooter(stripSiteNameFooter(out)))),
    );
    if (next === out) break;
    out = next;
  }
  return out;
}

/** Index of the "\n" that starts the first ticker line after line 0, or -1. */
function findTickerBreak(text: string): number {
  // The first line can never be a ticker block: the ticker is appended to an
  // article, so a "Son dakika..." opening is the article's own text.
  let at = text.indexOf("\n");
  while (at !== -1) {
    const next = text.indexOf("\n", at + 1);
    const line = text.slice(at + 1, next === -1 ? text.length : next);
    if (TICKER_LINE.test(line)) return at;
    at = next;
  }
  return -1;
}

export function cleanDescription(d: string): string;
export function cleanDescription(d: string | null): string | null;
export function cleanDescription(d: string | undefined): string | undefined;
export function cleanDescription(d: string | null | undefined): string | null | undefined;
export function cleanDescription(d: string | null | undefined): string | null | undefined {
  if (!d) return d;
  // Feed wrappers first (Diken / Serbestiyet footers, the trailing […] excerpt
  // marker), then the ticker cut.
  const text = stripFeedWrappers(d);
  const at = findTickerBreak(text);
  return at === -1 ? text : text.slice(0, at).trimEnd();
}

// ---------------------------------------------------------------------------
// Appended ticker, related-news lines included (h23-live-2, hunt 23).
// ---------------------------------------------------------------------------

/** A "related news" line is at most this many characters long (trimmed). */
const RELATED_LINE_MAX_LENGTH = 120;
/** At most this many related-news lines are dropped in front of a ticker. */
const MAX_RELATED_LINES = 2;
/** Quotes and brackets that may close a sentence right after its mark. */
const LINE_CLOSERS = new Set(['"', "”", "»", "’", "'", ")", "]"]);
const LINE_SENTENCE_MARKS = new Set([".", "!", "?", "…"]);

/**
 * True for the shape of a headline pasted in as its own line: after trimming it
 * is 1 to 120 characters long and, once any closing quotes or brackets are
 * stripped, it does not end in . ! ? or …. A line that ends in a sentence mark
 * is a sentence of the article itself. Character scan, no regex.
 */
export function isUnpunctuatedShortLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.length > RELATED_LINE_MAX_LENGTH) return false;
  let end = t.length;
  while (end > 0 && LINE_CLOSERS.has(t.charAt(end - 1))) end--;
  return end === 0 || !LINE_SENTENCE_MARKS.has(t.charAt(end - 1));
}

/**
 * Cut an appended ticker and the related-news lines in front of it: everything
 * from the first ticker line after line 0 on goes (the same line shape as
 * cleanDescription), and so do up to two directly preceding lines that are
 * short and unpunctuated ({@link isUnpunctuatedShortLine}). Blank lines are
 * skipped on the way back and do not count. The first line is never dropped. The
 * SAME string is returned when there is no ticker line after line 0; otherwise
 * the kept text with its end trimmed. Pure, linear, idempotent.
 */
export function cutAppendedTicker(text: string): string {
  const tickerBreak = findTickerBreak(text);
  if (tickerBreak === -1) return text;
  let cutAt = tickerBreak;
  let end = tickerBreak; // exclusive end of the line under inspection
  let dropped = 0;
  while (dropped < MAX_RELATED_LINES && end > 0) {
    const lineBreak = text.lastIndexOf("\n", end - 1);
    if (lineBreak === -1) break; // line 0 is never dropped
    if (text.slice(lineBreak + 1, end).trim() === "") {
      end = lineBreak; // a blank line: skipped, not counted
      continue;
    }
    if (!isUnpunctuatedShortLine(text.slice(lineBreak + 1, end))) break;
    cutAt = lineBreak;
    end = lineBreak;
    dropped++;
  }
  return text.slice(0, cutAt).trimEnd();
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
