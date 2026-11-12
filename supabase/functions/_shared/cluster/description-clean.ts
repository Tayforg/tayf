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
//
// Other outlets paste "related news" headlines under an article without any ticker
// ("...İstanbul'a geldi.\nAnkara'da kritik güvenlik zirvesi! Bakan Çiftçi, İtalyan
// mevkidaşı ile bir araya geldi\nDünyanın gözü ABD'den gelen sonuçlarda! İşte ABD'deki
// seçim hezimetinin nedeni! Trump...", cluster d91ab2f1, hunt 34, h34-reader-5): the
// teaser gave an Erdoğan-returns story its only "Trump", so it listed under
// /gundem/trump. stripTrailingTeasers() drops such headline-shaped trailing lines
// (an exclamation headline that shares no content stem with the text in front of it,
// plus the unpunctuated headlines after it); cleanDescription() applies it last, and
// summary-tidy.ts imports the same function for the shown summary.
//
// Independent Türkçe ships its raw Drupal field dump as the description (hunt 122,
// h122-ozet-1: "AYM Başkanı Kadir ÖzkayaAYM Başkanı Kadir Özkaya, ... dediPazartesi,
// Kasım 9, 2026 - 21:30Main image: HaberType: newsSEO Title: <the headline again>copyright
// Independentturkish:"): the page caption glued to the lead, the date stamp, and the CMS
// fields. It was picked as the Özet and the meta description of b8e7cc75 (28 sources) and
// 710ef4bb. stripIndyturkCmsDump() cuts the tail and the glued caption; stripFeedWrappers()
// runs it first, so the consumer's clustering text (entities, fingerprint, tf-idf) and the
// shown summary both lose the dump.

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

// ---------------------------------------------------------------------------
// Independent Türkçe CMS dump (h122-ozet-1, hunt 122). Only regular expressions with bounded
// gaps (every run of blanks is `\s{0,n}`, no nested quantifier), a bounded character walk,
// `indexOf` and a few `slice`s: linear in the input, and the caption search looks at no more
// than INDY_CAPTION_WINDOW characters.
// ---------------------------------------------------------------------------

/** The gate: a text without one of the CMS fields is never touched. */
const INDY_GATE = /copyright\s{0,8}Independentturkish|SEO Title:|Main image:/i;
const INDY_MAIN_IMAGE = /Main image:/i;
const INDY_SEO_TITLE = /SEO Title:/i;
const INDY_COPYRIGHT = /copyright\s{0,8}Independentturkish/i;
const INDY_TYPE_FIELD = /Type:\s{0,4}news/i;
/** "Pazartesi, Kasım 9, 2026 - 18:30": the Drupal date stamp, which may be glued to the word before it. */
const INDY_DATE_STAMP =
  /(?:Pazartesi|Salı|Çarşamba|Perşembe|Cuma|Cumartesi|Pazar),\s{0,4}(?:Ocak|Şubat|Mart|Nisan|Mayıs|Haziran|Temmuz|Ağustos|Eylül|Ekim|Kasım|Aralık)\s{1,4}\d{1,2},\s{0,4}\d{4}\s{0,4}-\s{0,4}\d{1,2}:\d{2}/u;
/** A section label glued in front of "Type: news" ("Haber", "Dünya") is at most this many letters long. */
const INDY_LABEL_MAX = 30;
/** The caption's repeat is looked for among the first this many characters. */
const INDY_CAPTION_WINDOW = 150;
/** A first word longer than this is not a caption word. */
const INDY_CAPTION_MAX_WORD = 40;
/** The caption's first word has at least this many letters. */
const INDY_CAPTION_MIN_WORD = 2;
/** Dropping the caption must leave at least this many characters. */
const INDY_MIN_BODY_AFTER_CAPTION = 60;
/** A cut that would leave less than this returns the input (the dump is then seen by the caller's own rules). */
const INDY_MIN_RESULT = 20;

/** Start of the section label glued in front of the "Type:" at `at`, or `at` when there is none. */
function indyTypeFieldStart(text: string, at: number): number {
  const lowest = Math.max(0, at - INDY_LABEL_MAX);
  let start = at;
  while (start > lowest && ONE_LETTER.test(text.charAt(start - 1))) start--;
  // The label begins at an upper-case letter that does not follow another one: "…açıkladıHaber" -> "Haber".
  for (let p = at - 1; p >= start; p--) {
    if (!ONE_UPPER.test(text.charAt(p))) continue;
    if (p === 0 || !ONE_UPPER.test(text.charAt(p - 1))) return p;
  }
  return at;
}

/**
 * The glued caption in front of the lead ("Bahçeli10 KASIMMHP Genel Başkanı Devlet Bahçeli, ...",
 * "ÖzkayaAYM Başkanı Kadir Özkaya, ...", "arıkanSaadet Partisi ...", "gazeteResmi Gazete’de ..."): the
 * first word's letters (2 to 40) come back among the first 150 characters, glued to the
 * character before (a letter or a digit, not a blank) and starting upper case, so "Ak" is never
 * found inside "bakanlıkta". The repeat must also end at a word boundary (no letter right after
 * it), so neither "ak" inside "bakanlıkta" nor "ab" inside "KABUL" counts. Everything in front of
 * that repeat goes, when 60 characters or more are left. The text itself otherwise.
 */
function dropGluedCaption(text: string): string {
  let end = 0;
  while (end <= INDY_CAPTION_MAX_WORD && end < text.length && ONE_LETTER.test(text.charAt(end))) end++;
  if (end < INDY_CAPTION_MIN_WORD || end > INDY_CAPTION_MAX_WORD) return text;
  const windowEnd = Math.min(text.length, INDY_CAPTION_WINDOW + end);
  const lowered = text.slice(0, windowEnd).toLocaleLowerCase("tr-TR");
  if (lowered.length !== windowEnd) return text; // the fold changed the length: cannot index safely
  const word = lowered.slice(0, end);
  let from = 1;
  for (;;) {
    const at = lowered.indexOf(word, from);
    if (at === -1 || at >= INDY_CAPTION_WINDOW) return text;
    if (ONE_ALNUM.test(text.charAt(at - 1)) && ONE_UPPER.test(text.charAt(at)) && !ONE_LETTER.test(text.charAt(at + end))) {
      return text.length - at >= INDY_MIN_BODY_AFTER_CAPTION ? text.slice(at) : text;
    }
    from = at + 1;
  }
}

/**
 * Independent Türkçe's raw Drupal field dump (h122-ozet-1): the description is
 * "<caption><lead><date stamp>Main image: <label>Type: newsSEO Title: <headline>copyright
 * Independentturkish:". The SAME string comes back unless the text holds "Main image:",
 * "SEO Title:" or "copyright Independentturkish" (any case). Then:
 *  - the tail goes, from the earliest of the Turkish date stamp ("Pazartesi, Kasım 9, 2026 -
 *    18:30", glued or not to the word before it), "Main image:", the "<label>Type: news" field,
 *    "SEO Title:" and "copyright Independentturkish"; the rest is trimmed and gets a "." when it
 *    ends in a letter or a digit;
 *  - the glued caption in front of the lead goes ({@link dropGluedCaption});
 *  - a result under 20 characters is not used: the input comes back.
 * Idempotent (the markers are gone from the result). Pure, linear.
 */
export function stripIndyturkCmsDump(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  if (!INDY_GATE.test(text)) return text;
  let cut = text.length;
  for (const re of [INDY_DATE_STAMP, INDY_MAIN_IMAGE, INDY_SEO_TITLE, INDY_COPYRIGHT]) {
    const m = re.exec(text);
    if (m !== null && m.index < cut) cut = m.index;
  }
  const field = INDY_TYPE_FIELD.exec(text);
  if (field !== null) {
    const start = indyTypeFieldStart(text, field.index);
    if (start < cut) cut = start;
  }
  let out = dropGluedCaption(text.slice(0, cut).trim());
  if (out !== "" && ONE_ALNUM.test(out.charAt(out.length - 1))) out += ".";
  return out.length < INDY_MIN_RESULT ? text : out;
}

/**
 * Remove the Diken header, the WordPress / Yoast footers, the Medyascope
 * site-name footer ("<headline> Medyascope" as the last line, hunt 24: 428 of 430
 * articles) and the trailing WordPress excerpt marker ("[…]") that feeds wrap
 * around a description. The footers go first (the site-name footer innermost, so
 * a WordPress / Yoast footer or a marker in front of it is trailing once it is
 * gone), then the header, then the marker. Independent Türkçe's CMS field dump
 * ({@link stripIndyturkCmsDump}, h122-ozet-1) goes before all of them, because its tail
 * ends the text. Returns the SAME string when nothing
 * matches, '' when the text was only a footer or a marker, and is idempotent (the
 * rules are re-applied until nothing changes, at most {@link MAX_WRAPPER_PASSES}
 * times).
 */
export function stripFeedWrappers(text: string): string {
  if (!text) return text;
  let out = text;
  for (let pass = 0; pass < MAX_WRAPPER_PASSES; pass++) {
    const next = stripExcerptMarker(
      stripDikenHeader(
        stripYoastFooter(stripWordPressFooter(stripSiteNameFooter(stripIndyturkCmsDump(out)))),
      ),
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
  const cut = at === -1 ? text : text.slice(0, at).trimEnd();
  // Then the trailing teaser lines (h34-reader-5). A strip can leave a footer or an
  // excerpt marker at the very end ("body […]\nTeaser!"), and unwrapping it can expose
  // another trailing line, so strip and unwrap alternate until nothing changes (at most
  // MAX_WRAPPER_PASSES times). A text without a teaser is returned exactly as before.
  let out = cut;
  for (let pass = 0; pass < MAX_WRAPPER_PASSES; pass++) {
    const stripped = stripTrailingTeasers(out);
    if (stripped === out) break;
    out = stripFeedWrappers(stripped);
  }
  return out;
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
// Trailing teaser lines (h34-reader-5, hunt 34).
//
// A feed pastes other stories' headlines under an article. d91ab2f1's stored
// summary is two real sentences and then
//   "Ankara'da kritik güvenlik zirvesi! Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi"
//   "Dünyanın gözü ABD'den gelen sonuçlarda! İşte ABD'deki seçim hezimetinin nedeni! Trump..."
// and the only "Trump" of the cluster was the second one. The shape is told apart
// from article text by three things together, and a line that fails ANY of them
// stays ("when unsure, keep"):
//  1. Headline shape: 12 to 160 characters, at least three words, starting with a
//     capital letter or a digit (not a list marker, not "1." / "2)"), and not led by
//     a conjunction (Ama, Fakat, Ancak, Lakin, Oysa, Çünkü, Ve, Yani, Ayrıca,
//     Üstelik: such a line continues the article, so the walk stops there; b5f5c40f
//     "Ama şu iki liderin sözünü ... unutmayalım!"). No quotation mark: the
//     double-quote family plus the opening single quotes U+2018 and U+201B (a quoted
//     line is somebody's words). ASCII ' and U+2019 are NOT quote marks here, they
//     are Turkish apostrophes (Fransa'da, 19’u) and the ab24d85a teaser holds
//     'yasaklama' in ASCII quotes. Not ending in a full stop, ":", ";", "," or "?".
//     A line that ends in "..." / "…" is a clamp of a sentence unless it also holds
//     a headline exclamation (measured on 245 live multi-line summaries, 2026-11-05:
//     162 later lines end in an ellipsis, 158 have no headline exclamation and are
//     clamp tails of real sentences), so it counts only then.
//  2. An ANCHOR: some line of the trailing run holds an exclamation used as
//     headline punctuation, a "!" at the end of the line or followed by a blank
//     ("Sel, yıldırım, dolu, hortum! Meteoroloji ...", "İşte ...!"). A "!" directly
//     followed by ' ’ or ‘ closes a quoted speech ("...bitmeyecek!'") and is no
//     anchor. Real prose rarely carries one outside quotes. Without an anchor
//     nothing is cut: the unpunctuated bullet lists of h31-reader-4 have the same
//     shape as a headline.
//  3. No content stem shared with the text in front of the run: every word of 6+
//     letters is reduced to its first 6 folded letters, and a line that has one in
//     common with the text before the run is about the same story, so the walk
//     stops there.
// The lines examined are the trailing run (at most TEASER_MAX_RUN lines, blank lines
// skipped; a longer run is a digest and is left alone). The cut is made at the first
// anchor of the run that survived the stem test, so the unpunctuated headlines
// AFTER an anchor go with it and the ones in front of it stay. The first non-blank
// line is never examined.
//
// No regular expression runs over the text: lines are found with indexOf /
// lastIndexOf, only lines of at most 400 raw characters are looked at, and the
// regular expressions below are single-character tests. At most five lines and
// 2,000 characters of lead text are scanned, so the cost is linear in the input
// and bounded by a constant per call after the line search.
// ---------------------------------------------------------------------------

const TEASER_MIN_LINE = 12;
const TEASER_MAX_LINE = 160;
/** A line longer than this (blanks included) is text and ends the run. */
const TEASER_MAX_RAW_LINE = 400;
const TEASER_MIN_WORDS = 3;
/** A run of more trailing headline-shaped lines than this is left alone. */
const TEASER_MAX_RUN = 4;
const TEASER_STEM_LEN = 6;
/** Characters of lead text that feed the stem set. */
const TEASER_LEAD_SCAN = 2000;
// The double-quote family plus the two OPENING single quotes U+2018 and U+201B (summary-tidy
// treats both as quote openers). ASCII ' and U+2019 are deliberately absent: Turkish uses them
// as apostrophes (Fransa'da, 19’u) and the ab24d85a teaser holds 'yasaklama' in ASCII quotes.
const TEASER_QUOTES: ReadonlySet<string> = new Set([
  '"', "“", "”", "„", "«", "»", "‟", "〝", "〞", "＂",
  "‘", // ‘ left single quotation mark
  "‛", // ‛ single high-reversed-9 quotation mark
]);
/** A "!" directly followed by one of these closes a quoted speech ("...bitmeyecek!'"), it is no headline mark. */
const TEASER_QUOTE_CLOSERS: ReadonlySet<string> = new Set(["'", "’", "‘"]);
/**
 * A line led by one of these continues the article ("Ama şu iki liderin sözünü ... unutmayalım!"),
 * it is never a pasted headline. Compared lower-cased with the Turkish locale.
 */
const TEASER_CONTINUATION_OPENERS: ReadonlySet<string> = new Set([
  "ama", "fakat", "ancak", "lakin", "oysa", "çünkü", "ve", "yani", "ayrıca", "üstelik",
]);
const TEASER_ENDS_NOT_HEADLINE: ReadonlySet<string> = new Set([".", ":", ";", ",", "?"]);
const ONE_UPPER = /^\p{Lu}$/u;
const ONE_LETTER = /^\p{L}$/u;
const ONE_ALNUM = /^[\p{L}\p{N}]$/u;

function isDigitChar(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/**
 * 0 = not a teaser-shaped line, 1 = headline-shaped, 2 = headline-shaped with a
 * headline exclamation (an anchor). `t` is the trimmed line.
 */
function teaserShape(t: string): 0 | 1 | 2 {
  if (t.length < TEASER_MIN_LINE || t.length > TEASER_MAX_LINE) return 0;
  const first = t.charAt(0);
  if (!isDigitChar(first) && !ONE_UPPER.test(first)) return 0; // lower case, a marker, a quote
  if (isDigitChar(first)) {
    // "1." / "12)" numbered item; "63 suçlu ..." is a headline.
    let d = 1;
    while (d < 4 && isDigitChar(t.charAt(d))) d++;
    const after = t.charAt(d);
    if (after === "." || after === ")") return 0;
  }
  // A line that opens with a conjunction continues the article: its first word (letters up
  // to the first blank or non-letter) is looked up lower-cased with the Turkish locale.
  let wordEnd = 0;
  while (wordEnd < t.length && ONE_LETTER.test(t.charAt(wordEnd))) wordEnd++;
  if (wordEnd > 0 && TEASER_CONTINUATION_OPENERS.has(t.slice(0, wordEnd).toLocaleLowerCase("tr"))) return 0;
  let words = 0;
  let inWord = false;
  let bang = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (TEASER_QUOTES.has(ch)) return 0;
    if (isBlank(t.charCodeAt(i))) {
      inWord = false;
      continue;
    }
    if (!inWord) {
      words++;
      inWord = true;
    }
    if (ch === "!") {
      // Headline punctuation: the last character, or followed by a blank or other mark. Not
      // "bitmeyecek!'" / "!’": an exclamation closing a quoted speech.
      const next = t.charAt(i + 1);
      if (i === t.length - 1 || (!ONE_ALNUM.test(next) && !TEASER_QUOTE_CLOSERS.has(next))) bang = true;
    }
  }
  if (words < TEASER_MIN_WORDS) return 0;
  const last = t.charAt(t.length - 1);
  const ellipsis = last === "…" || t.endsWith("..");
  if (TEASER_ENDS_NOT_HEADLINE.has(last) && !ellipsis) return 0;
  if (ellipsis && !bang) return 0;
  return bang ? 2 : 1;
}

/** Add the stem (first TEASER_STEM_LEN folded letters) of every word of 6+ letters of `s[0, limit)`. */
function addTeaserStems(s: string, limit: number, into: Set<string>): void {
  const end = Math.min(s.length, limit);
  let wordStart = -1;
  for (let i = 0; i <= end; i++) {
    const letter = i < end && ONE_LETTER.test(s.charAt(i));
    if (letter) {
      if (wordStart === -1) wordStart = i;
      continue;
    }
    if (wordStart !== -1 && i - wordStart >= TEASER_STEM_LEN) {
      const folded = foldNameToken(s.slice(wordStart, i));
      if (folded.length >= TEASER_STEM_LEN) into.add(folded.slice(0, TEASER_STEM_LEN));
    }
    wordStart = -1;
  }
}

function sharesTeaserStem(line: string, stems: ReadonlySet<string>): boolean {
  const own = new Set<string>();
  addTeaserStems(line, line.length, own);
  for (const stem of own) if (stems.has(stem)) return true;
  return false;
}

/** Index of the "\n" that ends the first non-blank line, or -1 when no line follows it. */
function leadLineEnd(text: string): number {
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const stop = nl === -1 ? text.length : nl;
    if (text.slice(pos, stop).trim() !== "") return nl;
    if (nl === -1) return -1;
    pos = nl + 1;
  }
  return -1;
}

/**
 * Drop the headline-shaped teaser lines pasted under an article (see the section
 * comment). The first non-blank line is never touched; the SAME string is returned
 * when nothing is cut; otherwise the kept text with its end trimmed. Pure, linear,
 * idempotent; null, '' and non-strings are returned as they are.
 */
export function stripTrailingTeasers(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const leadEnd = leadLineEnd(text);
  if (leadEnd === -1) return text;

  // 1. The trailing run of headline-shaped lines, from the end of the text backwards.
  const run: Array<{ start: number; line: string; anchor: boolean }> = [];
  let end = text.length; // exclusive end of the span under inspection
  while (end > leadEnd) {
    const nl = text.lastIndexOf("\n", end - 1);
    const start = nl + 1;
    if (end - start > TEASER_MAX_RAW_LINE) break;
    const line = text.slice(start, end).trim();
    if (line !== "") {
      const shape = teaserShape(line);
      if (shape === 0) break;
      if (run.length >= TEASER_MAX_RUN) return text; // a digest, not a teaser pair
      run.push({ start, line, anchor: shape === 2 });
    }
    end = nl;
  }
  if (run.length === 0) return text;

  // 2. Walk it from the end; a line that shares a content stem with the text in
  //    front of the run is about the story itself and ends the walk.
  const lead = new Set<string>();
  addTeaserStems(text, Math.min(run[run.length - 1]!.start, TEASER_LEAD_SCAN), lead);
  let cutAt = -1;
  for (const entry of run) {
    if (sharesTeaserStem(entry.line, lead)) break;
    if (entry.anchor) cutAt = entry.start;
  }
  if (cutAt === -1) return text;
  return text.slice(0, cutAt).trimEnd();
}

// ---------------------------------------------------------------------------
// A lone trailing headline (h164-summaries-1, hunt 164).
//
// Milliyet and Posta paste ONE other story's headline as the last line of a description, with
// no "Son dakika" ticker behind it ({@link cutAppendedTicker}) and no "!" headline in the run
// ({@link stripTrailingTeasers}):
//   bb349ef1 "...bulunulduğu öğrenildi.\nCumhurbaşkanı Erdoğan'dan COP31'de diplomasi trafiği"
//   0ad663a9 "...ekipleri sevk edildi.\nCumhurbaşkanı Erdoğan ABD Başkanı Trump ile görüştü"
//   f4451eba "...devam edecek.\nNev’in ağabeyi miras için harekete mi geçti? Avukatından sert yanıt: '...'"
// The line stands out by four things together, and a line that fails ANY of them stays ("when
// unsure, keep"):
//  1. It is the last, or the last but one, non-blank line, and not line 0.
//  2. Its shape is a headline's: short and unpunctuated ({@link isUnpunctuatedShortLine}) and
//     teaser-shaped (teaserShape >= 1: no quote, no conjunction opener, three words, a capital),
//     with no ellipsis ("…" or two dots) anywhere in it: a line with one is a text a feed cut,
//     not a headline it pasted (fefb05a2's last line "Hangi birini sayalım? Mehmet
//     Keçeciler......Devamı için tıklayınız" is the column's own clamp tail with its CTA).
//  3. It shares no TEASER_STEM_LEN stem with the text in front of it (the stripTrailingTeasers
//     rule: a line about the same words is about the same story; fdfc440c's "Erdoğan'dan fon
//     soruşturmasıyla ..." shares 'soruşt' with its body and stays).
//  4. The nearest line that is kept ends in a sentence mark (closers aside). A text whose last
//     lines are all unpunctuated is a bullet list or a digest, not a sentence and a headline.
// At most two lines go. Lines are found with indexOf / lastIndexOf, only lines of at most 400
// raw characters are looked at and the stem sets cover at most 2,000 characters of lead text, so
// the cost is linear in the input; no regular expression runs over the text.
// ---------------------------------------------------------------------------

/** At most this many trailing lines are dropped. */
const LONE_HEADLINE_MAX_LINES = 2;

/** True when `line` holds "…" or two dots in a row: a cut text, which no feed pastes as a headline. */
function holdsEllipsis(line: string): boolean {
  return line.includes("…") || line.includes("..");
}

/** True when `s` ends in . ! ? or … once the closing quotes and brackets are looked past. */
function endsInSentenceMark(s: string): boolean {
  let end = s.length;
  while (end > 0 && LINE_CLOSERS.has(s.charAt(end - 1))) end--;
  return end > 0 && LINE_SENTENCE_MARKS.has(s.charAt(end - 1));
}

/**
 * Drop up to two headline-shaped lines pasted at the end of a description, behind a sentence
 * (see the section comment). The first non-blank line is never touched. The SAME string is
 * returned when nothing is cut; otherwise the kept text with its end trimmed. Pure, linear,
 * idempotent; an empty string and a non-string are returned as they are.
 */
export function cutLoneTrailingHeadline(text: string): string {
  if (typeof text !== "string" || text.length === 0) return text;
  const leadEnd = leadLineEnd(text);
  if (leadEnd === -1) return text;

  let end = text.length; // exclusive end of the span under inspection
  let cutAt = -1;
  let dropped = 0;
  while (end > leadEnd && dropped < LONE_HEADLINE_MAX_LINES) {
    // `end > leadEnd` and text[leadEnd] is "\n": the search cannot fall off the front.
    const nl = text.lastIndexOf("\n", end - 1);
    const start = nl + 1;
    if (end - start > TEASER_MAX_RAW_LINE) break;
    const line = text.slice(start, end).trim();
    if (line === "") {
      end = nl;
      continue;
    }
    if (!isUnpunctuatedShortLine(line) || teaserShape(line) === 0 || holdsEllipsis(line)) break;
    const lead = new Set<string>();
    addTeaserStems(text, Math.min(start, TEASER_LEAD_SCAN), lead);
    if (sharesTeaserStem(line, lead)) break;
    cutAt = nl;
    end = nl;
    dropped++;
  }
  if (cutAt === -1) return text;
  const kept = text.slice(0, cutAt).trimEnd();
  return endsInSentenceMark(kept) ? kept : text;
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
