// Extractive neutral headline for a cluster: pick the member headline that
// sits closest to the centre of the cluster, penalise sensational framing,
// then strip the outlet's house-style markers from it.
//
// This is the zero-cost fallback the headline cron uses when no LLM key is
// configured. It never invents text, so it can't hallucinate — the price is
// that it is one outlet's wording with the framing sanded off, not a
// synthesis. The LLM path overwrites it when enabled.
//
// extractive-v2 (hunt 15): Turkish casing no longer defeats the lead-in and
// framing matchers ("SON DAKİKA", "FLAŞ", "ŞOK"); a minority numeral loses to
// the number most members agree on; loaded wording costs points; and a pick
// must pass isAcceptableNeutral (no question, English, shouting, feed cut) or
// a cluster that already has a title keeps it. A cluster with no title yet
// takes the cleaned best candidate instead ({ floor: true }): it beats the
// raw title_tr.
//
// extractive-v3 (hunt 16): the v2 re-pick (#156) replaced about half of the
// stored titles with vague fragments. Duplicate member titles now count once
// (the first occurrence stays), so a headline two outlets copied no longer wins
// on its twin; a title under 45 characters pays 0.008 per missing character
// (the 28-character "Altın Portakal 'Taş ve Tüy'e" lost to the 82-character
// title that names the event); and two hard defects join shouting: a '|' or '│'
// left after cleaning, and a run of three or more shouted words ("İZMİR
// ELEKTRİK KESİNTİSİ 20 EKİM SALI |GEDİZ UYARDI: ..."). A re-pick is now
// conservative: with { incumbent } (the stored title) the stored title stays
// unless it fails the gate or the best member title outscores it by a margin:
// REPICK_MARGIN (0.05) for a title under 45 characters, REPICK_MARGIN_FULL_LENGTH
// (0.20) from 45 up. The first version of the rule used 0.05 everywhere and a
// replay over 150 production clusters still rewrote 38% of the stored titles
// (two good member titles of one cluster routinely differ by 0.05 to 0.20), so
// the full-length bar moved to 0.20: the same replay changes 8%, and the swaps
// it drops at 0.15-0.20 were mostly lateral or a different sub-event. Picking again with the pick as
// incumbent returns it.

// extractive-v4 (hunt 22): a verdict word no longer survives over members that
// hedge. 'itiraf', 'yalan' (not 'yalanla...': a denial is reporting), 'rezil' and
// 'çarpıcı' join the loaded words; when at least 40% of three or more members say
// 'iddia' / 'öne sürdü' / 'ifade', a title that drops the hedge pays
// HEDGE_LOSS_PENALTY (310aedf3 was titled "Emir Sarıgül itiraf etti: ..." while
// its members wrote 'iddiası' and 'ifadesi'). A "Son dakika" in the middle of a
// title that STANDS ALONE (a separator, a quote or the end of the title follows
// it) is removed by cleanHeadline and is a hard defect (80bfb011 'Altın
// Fiyatlarında Son Dakika. ...'). When a noun follows it ('son dakika
// açıklaması', 'son dakika golüyle') the label licenses that noun's possessive,
// so the words are left alone (deleting them leaves 'açıklaması' without a
// possessor) and the framing penalty ranks the title down, as before. A
// first-pick floor candidate that is all capitals is sentence-cased instead of
// shipped shouting (09f152ec).

// Written to clusters.title_neutral_model so readers can tell an extractive
// pick from an LLM rewrite. Bump the suffix when the selection or cleaning
// rules change in a way that alters output; the headline cron then re-picks
// the last 14 days of older-version titles (neutral_title_repick_candidates,
// migration 141). Readers must not compare against this constant: use
// isExtractiveModelId, which recognises every version.
export const EXTRACTIVE_MODEL_ID = "extractive-v4";

/** True for any extractive pick, whatever rule version wrote it. */
export function isExtractiveModelId(model: unknown): boolean {
  return typeof model === "string" && model.startsWith("extractive-");
}

export interface MemberTitle {
  title: string;
  source?: string | null;
}

const DIACRITICS: Record<string, string> = {
  ş: "s", ı: "i", ü: "u", ö: "o", ç: "c", ğ: "g", â: "a", î: "i", û: "u",
};

const STOP = new Set([
  "ve", "ile", "bir", "bu", "da", "de", "ki", "icin", "ama", "gibi", "kadar",
  "daha", "cok", "olan", "olarak", "var", "yok", "oldu", "dedi", "son", "dakika",
  "haber", "haberi", "sonra", "once", "iste", "icin",
]);

// Turkish-locale lowercasing: "İ" -> "i", "I" -> "ı", so "SON DAKİKA" folds to
// "son dakika" (plain toLowerCase() would give "i" + U+0307). The lead-in
// matcher slices the original by the length of a match on the folded text, so
// the two must have the same length; if a runtime ever changes it, fall back
// to the locale-free mapping (cleanHeadline then refuses to slice).
function foldTr(s: string): string {
  const t = s.toLocaleLowerCase("tr");
  return t.length === s.length ? t : s.toLowerCase();
}

// Locale-aware lowercasing matches cleanHeadline's toLocaleUpperCase("tr")
// below: plain toLowerCase() turns "İ" into "i" + a combining dot-above
// (U+0307) instead of "i", which the a-z0-9 filter then strips, silently
// corrupting tokens for any title starting a word with a dotted capital I.
function asciiLower(title: string): string {
  let s = "";
  for (const ch of title.toLocaleLowerCase("tr")) s += DIACRITICS[ch] ?? ch;
  return s;
}

// Lowercased, diacritics folded, every run of non-alphanumerics collapsed to
// one space: "Canlı: Meclis'te" -> "canli meclis te".
function fold(title: string): string {
  return asciiLower(title).replace(/[^a-z0-9]+/g, " ").trim();
}

function tokens(title: string): Set<string> {
  const out = new Set<string>();
  for (const t of fold(title).split(" ")) {
    if (t.length >= 3 && !STOP.has(t)) out.add(t);
  }
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

// Unicode-aware word edges. `\b` is ASCII-only without the `u` flag and not
// Turkish-aware with it, so "Flaş gelişme" never matched `\bflaş\b`.
const L = String.raw`(?<![\p{L}\p{N}])`;
const R = String.raw`(?![\p{L}\p{N}])`;

// Tested on the raw text: they depend on case or on punctuation that folding
// would not change anyway.
const FRAMING_RAW: RegExp[] = [
  /!/,
  /\?/,
  /\b[A-ZÇĞİÖŞÜ]{4,}\b/, // shouted words
  /\|/, // "Outlet | headline" prefixes
  /\.\.\.$/,
];

// Tested on the Turkish-lowercased text. Each hit is one unit of "this outlet
// is selling, not reporting". [iı] because an ASCII-capital "SON DAKIKA"
// lowercases to "dakıka" in the tr locale.
const FRAMING_FOLDED: RegExp[] = [
  /son\s*dak[iı]ka/u,
  new RegExp(`${L}(?:flaş|flas|canlı|canli)${R}`, "u"),
  new RegExp(
    `${L}(?:bomba|şok|sok|skandal|rezalet|olay|dev|kritik|müjde|mujde)${R}`,
    "u",
  ),
  /dikkat çeken|dikkat ceken|işte o|iste o|işte detaylar|iste detaylar|bakın|bakin/u,
  // A Haber / Sabah house style for the president.
  new RegExp(`${L}başkan erdoğan${R}`, "u"),
];

// Wording that editorialises rather than reports. Costs more than framing:
// the hunt found 'Netanyahu Trump'a yalvardı' standing in for a hedged
// "... talep ettiği iddiası" in 8 of 500 sampled clusters.
const LOADED_FOLDED: RegExp[] = [
  new RegExp(`${L}yalvard[iı]${R}`, "u"),
  new RegExp(`${L}şaşt[iı]\\s+kald[iı]${R}`, "u"),
  new RegExp(`${L}korkunç${R}`, "u"),
  new RegExp(`${L}sert\\s+çıktı${R}`, "u"),
  new RegExp(`${L}vahşet${R}`, "u"),
  new RegExp(`${L}dev\\s+operasyon${R}`, "u"),
  new RegExp(`${L}işte${R}`, "u"),
  // A verdict where the members report an allegation (hunt 22, 310aedf3).
  // 'yalanla...' (to deny) is reporting, so only 'yalan' not followed by 'la'.
  new RegExp(`${L}itiraf`, "u"),
  new RegExp(`${L}yalan(?!la)`, "u"),
  new RegExp(`${L}rezil`, "u"),
  // Was a framing unit (0.12) until extractive-v4.
  new RegExp(`${L}çarp[iı]c[iı]${R}`, "u"),
];

// Words that attribute a claim instead of asserting it. Tested on foldTr(title).
const HEDGE = new RegExp(`${L}(?:iddia|öne\\s+sürd|ifade)`, "u");

/**
 * What a title pays for dropping the hedge its cluster's members carry: when
 * three or more (deduplicated) members exist and at least HEDGED_SHARE of them
 * say 'iddia' / 'öne sürdü' / 'ifade', a title without any of those words is
 * asserting what the sources only allege. Charged to a member's score and to the
 * stored title's score alike.
 */
export const HEDGE_LOSS_PENALTY = 0.15;
const HEDGED_MIN_MEMBERS = 3;
const HEDGED_SHARE = 0.4;

function carriesHedge(title: string): boolean {
  return HEDGE.test(foldTr(title));
}

export function framingPenalty(title: string): number {
  const folded = foldTr(title);
  let n = 0;
  for (const re of FRAMING_RAW) if (re.test(title)) n++;
  for (const re of FRAMING_FOLDED) if (re.test(folded)) n++;
  return n;
}

function loadedPenalty(title: string): number {
  const folded = foldTr(title);
  let n = 0;
  for (const re of LOADED_FOLDED) if (re.test(folded)) n++;
  return n;
}

// Bulletin lead-ins. "son dakika" / "flaş" are lead-ins wherever they start the
// title; "canlı" / "şok" only before a separator, because "Canlı bomba
// saldırısında 3 kişi öldü" (suicide bomber) and "Şok geçiren hasta" are
// sentences. Matched on foldTr(title), sliced from the original by length.
const LEAD_IN =
  /^(?:(?:son\s*dak[iı]ka|flaş|flas)(?![\p{L}\p{N}])\s*[!:.…|│\-–—]*|(?:canlı|canli|şok|sok)\s*[!:|│\-–—]+)\s*/u;
const LEAD_IN_PASSES = 4;

function stripLeadIns(title: string): string {
  let t = title;
  for (let pass = 0; pass < LEAD_IN_PASSES; pass++) {
    const folded = foldTr(t);
    if (folded.length !== t.length) break; // cannot slice safely
    const m = LEAD_IN.exec(folded);
    if (!m || m[0].length === 0) break;
    t = t.slice(m[0].length);
  }
  return t;
}

// A "son dakika" that does not open the title and STANDS ALONE: a separator, an
// opening quote or the end of the title follows it ("Altın Fiyatlarında Son
// Dakika. 1 Yılın Dibini Gördü", "Meteoroloji'den son dakika 'kırmızı alarm': ...",
// "Ankara'da deprem son dakika"). That is a bulletin label, not part of the
// event. When a word follows it directly ("son dakika açıklaması", "son dakika
// transferi", "son dakika golüyle") the label licenses a possessive on that
// noun, so deleting the two words would leave "açıklaması" without a possessor;
// such a title is left as written (the framing penalty ranks it down) and is
// not a defect. `(?<=.)` makes the match non-leading. Tested on foldTr(title).
const MID_SON_DAKIKA_SOURCE = String.raw`(?<=.)${L}son\s+dak[iı]ka${R}(?=\s*(?:$|[.:!…|])|\s+['"‘“])`;
const MID_SON_DAKIKA = new RegExp(MID_SON_DAKIKA_SOURCE, "u");
// The label with the separators that trail it ("Son Dakika." "son dakika:" "SON DAKİKA |").
const MID_SON_DAKIKA_STRIP = new RegExp(`${MID_SON_DAKIKA_SOURCE}(?:\\s*[.:!…|]+)?`, "gu");

function stripMidSonDakika(title: string): string {
  const folded = foldTr(title);
  if (folded.length !== title.length) return title; // cannot splice safely
  let out = "";
  let at = 0;
  for (const m of folded.matchAll(MID_SON_DAKIKA_STRIP)) {
    out += title.slice(at, m.index);
    at = m.index + m[0].length;
  }
  if (at === 0) return title;
  return (out + title.slice(at)).replace(/\s{2,}/g, " ").trim();
}

export function cleanHeadline(title: string): string {
  let t = title.trim();
  // Outlet prefixes ("Halk TV | ...") and "Son dakika" lead-ins, repeatedly:
  // "SON DAKİKA | FLAŞ! x" is "x".
  t = t.replace(/^[^|│]{0,25}[|│]\s*/, "");
  t = stripLeadIns(t);
  t = stripMidSonDakika(t);
  // House style. Not before a capitalised name: "Başkan Erdoğan Tosun" is a
  // different person than the president.
  t = t.replace(
    /(?<![\p{L}\p{N}])Başkan Erdoğan(?![\p{L}\p{N}])(?!\s+\p{Lu})/gu,
    "Cumhurbaşkanı Erdoğan",
  );
  // Exclamation marks: sentence break inside, dropped at the end.
  t = t.replace(/!+\s+/g, ". ").replace(/!+$/g, "");
  // Trailing ellipsis / colon / dash.
  t = t.replace(/[\s.:…\-–—]+$/g, "");
  // Wrapping quotes around the whole headline.
  t = t.replace(/^["'“‘](.+)["'”’]$/, "$1");
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 0) t = t[0]!.toLocaleUpperCase("tr") + t.slice(1);
  return t;
}

// Placeholders outlets publish as a headline ("Kısa haberler", "Son dakika",
// "CANLI | Cumhurbaşkanı Erdoğan konuşuyor"): they name no event, so a cluster
// must never be titled with one. Matched on the folded cleanHeadline output.
const GENERIC_CLEANED: RegExp[] = [
  /^kisa haberler?$/,
  /^son dakika$/,
  /gundem ozeti/,
  /konusuyor$/,
  /aciklamalarda bulunuyor$/,
];

// Matched on the folded RAW title: cleanHeadline strips these lead-ins, which
// would otherwise hide the live-blog marker from the check above. "canlı
// bomba" (suicide bomber) is a real subject, not a live-blog lead-in.
const GENERIC_RAW: RegExp[] = [/^canli\b(?! bomba\b)/, /^son dakika$/];

// A title built only from these says nothing about what happened.
const FILLER = new Set([
  "kisa", "haberler", "canli", "gundem", "ozeti", "konusuyor", "cumhurbaskani", "erdogan",
]);

/**
 * True for a headline that is a content-free placeholder (a news-bulletin
 * label, a live-blog lead-in, "<person> konuşuyor") rather than a description
 * of an event. Deliberately no minimum length or token count: short real
 * headlines ("İstanbul'da deprem oldu") must stay eligible.
 */
export function isGenericTitle(title: string): boolean {
  const cleaned = fold(cleanHeadline(title));
  if (cleaned === "" || GENERIC_CLEANED.some((re) => re.test(cleaned))) return true;
  const raw = fold(title);
  if (GENERIC_RAW.some((re) => re.test(raw))) return true;
  for (const t of tokens(title)) if (!FILLER.has(t)) return false;
  return true;
}

const ACCEPT_MIN_LEN = 20;
const ACCEPT_MAX_LEN = 110;

const ENGLISH_STOPWORDS = new Set([
  "the", "a", "an", "and", "of", "to", "in", "at", "on", "for", "with", "from",
  "by", "after", "over", "says", "is", "are", "was", "were", "will", "has", "have",
]);
const TURKISH_LETTER = /[çğıöşüÇĞİÖŞÜ]/;

// "Erdoğan hails unity ... in Ankar": two or more English function words and
// at most one token with a Turkish-only letter. "On yıl sonra at yarışında
// rekor" has two stopword homographs ("on", "at") but two Turkish-letter
// tokens, so it stays Turkish.
function looksEnglish(title: string): boolean {
  const words = title.split(/[^\p{L}]+/u).filter((w) => w.length > 0);
  let hits = 0;
  let turkish = 0;
  for (const w of words) {
    if (ENGLISH_STOPWORDS.has(w.toLowerCase())) hits++;
    if (TURKISH_LETTER.test(w)) turkish++;
  }
  return hits >= 2 && turkish <= 1;
}

// A feed cut: another member's title continues this one's exact text, and the
// continuation finishes this title's last word with one or two letters
// ("...için Ankar" against "...için Ankara'ya geliyor"). Only a strict prefix
// counts. Comparing last words alone flagged ordinary Turkish suffixes (-ı,
// -na, -si, -ız are as long as the cut): 'protestoda 139 gözaltı' against '139
// kişi gözaltına alındı' is two outlets' wording, not a truncation. The short
// word appearing whole in any other member also clears the title. The title
// itself (an exact folded match) is never evidence about itself.
const CUT_COMPLETION = /^[a-z0-9]{1,2}(?: |$)/;

function looksTruncated(title: string, memberTitles: readonly string[]): boolean {
  const own = fold(title);
  const last = own.split(" ").pop() ?? "";
  if (last.length < 2) return false;
  let continuedByAnother = false;
  for (const m of memberTitles) {
    const raw = fold(m);
    const cleaned = fold(cleanHeadline(m));
    if (raw === own || cleaned === own) continue;
    for (const t of raw.split(" ")) if (t === last) return false;
    // The cleaned form too: this title was cleaned, the member's lead-in
    // ("SON DAKİKA | ...") was not.
    for (const f of [raw, cleaned]) {
      if (f.length > own.length && f.startsWith(own) && CUT_COMPLETION.test(f.slice(own.length))) {
        continuedByAnother = true;
      }
    }
  }
  return continuedByAnother;
}

export interface AcceptOptions {
  /**
   * The text was written by a model, not copied from a feed: skip the
   * feed-cut heuristic (a model does not truncate mid-word) and keep every
   * other rule.
   */
  generated?: boolean;
}

const SHOUT_RUN = 3;
const SHOUT_MIN_LETTERS = 3;

// A run of SHOUT_RUN or more consecutive shouted words. A word is shouted when,
// stripped of edge punctuation and an apostrophe suffix ("TBMM'de" -> "TBMM"),
// it has at least three letters and equals its tr-locale upper-case form. A
// short acronym ("AK"), a lowercase word or a bare number ends the run, so
// "CHP ve AK Parti TBMM'de uzlaştı" and "TBMM CHP grubu toplandı" pass while
// "İZMİR ELEKTRİK KESİNTİSİ: ..." does not.
function hasShoutedRun(t: string): boolean {
  let run = 0;
  for (const raw of t.split(/\s+/)) {
    const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").replace(/['’ʼ‘].*$/u, "");
    const letters = word.match(/\p{L}/gu)?.length ?? 0;
    if (letters >= SHOUT_MIN_LETTERS && word === word.toLocaleUpperCase("tr")) {
      run++;
      if (run >= SHOUT_RUN) return true;
    } else {
      run = 0;
    }
  }
  return false;
}

// Defects a first-pick floor does not forgive: shouting (all of it, or a run of
// shouted words), a residual '|', a placeholder, an English headline, a feed cut. A question, a leading "İşte" or an odd length
// are only less good than the cleaned text of a title nobody has cleaned yet.
function hasHardDefect(t: string, memberTitles: readonly string[], opts: AcceptOptions): boolean {
  if (/\p{L}/u.test(t) && t === t.toLocaleUpperCase("tr")) return true;
  // An outlet prefix that cleanHeadline could not strip (longer than 25
  // characters) or a separator inside the text: "... SALI |GEDİZ UYARDI: ...".
  if (/[|│]/.test(t)) return true;
  if (hasShoutedRun(t)) return true;
  // A bulletin label in the middle of the title (the lead-in is cleanHeadline's).
  if (MID_SON_DAKIKA.test(foldTr(t))) return true;
  if (isGenericTitle(t)) return true;
  if (looksEnglish(t)) return true;
  if (!opts.generated && looksTruncated(t, memberTitles)) return true;
  return false;
}

/**
 * Whether a candidate neutral headline may be shown. Rejects a question, a
 * leading "İşte", shouting, a title that is too short or too long, a generic
 * placeholder, an English headline and (copied text only) a truncated one.
 * `memberTitles` are the cluster's other member headlines (the title itself,
 * if present, is ignored). Pure; the headline cron also runs it on LLM output
 * with `{ generated: true }`.
 */
export function isAcceptableNeutral(
  title: string,
  memberTitles: readonly string[],
  opts: AcceptOptions = {},
): boolean {
  const t = (title ?? "").trim();
  if (t.length < ACCEPT_MIN_LEN || t.length > ACCEPT_MAX_LEN) return false;
  if (t.includes("?")) return false;
  if (/^işte(?![\p{L}\p{N}])/u.test(foldTr(t))) return false;
  if (hasHardDefect(t, memberTitles, opts)) return false;
  return true;
}

const NUMBER = /\d+(?:[.,]\d+)?/g;

// "91,1" and "91.1" are one number.
function numsOf(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.match(NUMBER) ?? []) out.add(m.replace(",", "."));
  return out;
}

/**
 * Candidates to leave out: one that carries a number no other member has,
 * while two or more other members agree on a different number it lacks
 * ("40 kişi tutuklandı" against six members that say 39). Indices into
 * `nums`. Empty when every candidate would be excluded (the rule is then
 * moot, not a verdict).
 */
function numeralOutliers(nums: Set<string>[]): Set<number> {
  const holders = new Map<string, number>();
  for (const s of nums) for (const n of s) holders.set(n, (holders.get(n) ?? 0) + 1);

  const out = new Set<number>();
  nums.forEach((mine, i) => {
    let unique = false;
    for (const n of mine) if (holders.get(n) === 1) unique = true;
    if (!unique) return;
    for (const [m, count] of holders) {
      // `count` includes i itself when i has m; others = count - (mine.has(m) ? 1 : 0).
      if (!mine.has(m) && count >= 2) {
        out.add(i);
        return;
      }
    }
  });
  return out.size === nums.length ? new Set<number>() : out;
}

/**
 * A title shorter than this pays 0.008 per missing character in scoreTitle,
 * and a re-pick holds a stored title of at least this length to the wider
 * REPICK_MARGIN_FULL_LENGTH.
 */
export const FULL_LENGTH_TITLE_CHARS = 45;

/**
 * How far the best member title must outscore a stored title shorter than
 * FULL_LENGTH_TITLE_CHARS before a re-pick replaces it. Scores are centrality
 * minus penalties (see scoreTitle), so 0.05 is a few percent of token overlap.
 * A short stored title is the shape of #156's fragments (the 28-character
 * "Altın Portakal 'Taş ve Tüy'e" lost to the title that names the event by
 * 0.119), so it gives way readily.
 */
export const REPICK_MARGIN = 0.05;

/**
 * The same bar for a stored title of FULL_LENGTH_TITLE_CHARS or more. Such a
 * title already says what happened, and two good member titles of one cluster
 * differ by 0.05 to 0.20 on ordinary wording, so a smaller bar swaps one good
 * headline for another (and now and then for a different sub-event). Measured
 * on a replay of 150 production clusters (src/lib/clusters/neutral-title-
 * replay.test.ts): 0.05 changes 38% of the stored titles, 0.10 changes 23%,
 * 0.15 with the 45-character split changes 12.7%, and 0.20 changes 8%; 0.20
 * keeps five lateral or sub-event swaps the 0.15 bar allowed.
 */
export const REPICK_MARGIN_FULL_LENGTH = 0.2;

// ---------------------------------------------------------------------------
// Sentence case for a shouted floor title (extractive-v4).
// ---------------------------------------------------------------------------

/** Short all-caps words that are acronyms whatever the other members write. */
const ACRONYMS: ReadonlySet<string> = new Set([
  "TBMM", "AFAD", "CHP", "AKP", "MHP", "DEM", "ABD", "AB", "BM", "NATO", "YSK",
  "PKK", "İBB", "TÜİK", "SGK", "MEB", "MİT", "TSK", "THY",
]);
/** A word of at most this many letters may be an acronym; longer ones are words. */
const ACRONYM_MAX_LETTERS = 5;
const APOSTROPHES = new Set(["'", "’", "ʼ", "‘"]);

function isAllCaps(t: string): boolean {
  return /\p{L}/u.test(t) && t === t.toLocaleUpperCase("tr");
}

function isWordChar(ch: string): boolean {
  return /[\p{L}\p{N}]/u.test(ch);
}

/** Start and end (exclusive) of the word inside `token`, without edge punctuation. */
function coreRange(token: string): [number, number] {
  let a = 0;
  let b = token.length;
  while (a < b && !isWordChar(token.charAt(a))) a++;
  while (b > a && !isWordChar(token.charAt(b - 1))) b--;
  return [a, b];
}

/** Splits "AFAD'DAN" into the stem "AFAD" and the suffix "'DAN" (suffix "" when there is no apostrophe). */
function splitSuffix(word: string): [string, string] {
  for (let i = 0; i < word.length; i++) {
    if (APOSTROPHES.has(word.charAt(i))) return [word.slice(0, i), word.slice(i)];
  }
  return [word, ""];
}

function letterCount(s: string): number {
  return s.match(/\p{L}/gu)?.length ?? 0;
}

interface WordForms {
  /** Short words some non-shouting member writes in upper case ("EPDK'dan zam" -> "EPDK"). */
  upper: Set<string>;
  /** Tr-lower-cased word -> how a non-shouting member writes it with a capital ("ankara" -> "Ankara"). */
  capitalised: Map<string, string>;
  /** Words some non-shouting member writes entirely in lower case. */
  lower: Set<string>;
}

/**
 * How the non-shouting member titles write their words. A shouted title has lost
 * that information, so it is read back from the members: an acronym stays in
 * capitals, a name keeps its capital letter ("ankara" is not what "Ankara'da"
 * means), unless some member also writes the word in lower case (then it is a
 * common word that merely opened a sentence).
 */
function memberWordForms(memberTitles: readonly string[]): WordForms {
  const forms: WordForms = { upper: new Set(), capitalised: new Map(), lower: new Set() };
  for (const title of memberTitles) {
    if (isAllCaps(title)) continue;
    for (const token of title.split(/\s+/)) {
      const [a, b] = coreRange(token);
      const [stem] = splitSuffix(token.slice(a, b));
      const letters = letterCount(stem);
      if (letters < 2) continue;
      const lowered = stem.toLocaleLowerCase("tr");
      if (stem === stem.toLocaleUpperCase("tr")) {
        if (letters <= ACRONYM_MAX_LETTERS) forms.upper.add(stem);
      } else if (stem === lowered) {
        forms.lower.add(lowered);
      } else if (stem === lowered.charAt(0).toLocaleUpperCase("tr") + lowered.slice(1)) {
        forms.capitalised.set(lowered, stem);
      }
    }
  }
  return forms;
}

/**
 * Tr-TR lower case with the first letter upper, except
 *   - short acronyms (the ACRONYMS allowlist, or a word of at most
 *     ACRONYM_MAX_LETTERS letters that a non-shouting member writes in upper
 *     case), which keep their capitals ("AFAD'DAN" -> "AFAD'dan");
 *   - a name that a non-shouting member writes with a capital and no member
 *     writes in lower case ("ANKARA'DA" -> "Ankara'da").
 * Pure; `memberTitles` are the other raw titles of the cluster.
 */
function sentenceCaseShout(shouted: string, memberTitles: readonly string[]): string {
  const forms = memberWordForms(memberTitles);
  const out = shouted
    .split(/(\s+)/)
    .map((token) => {
      if (token.trim() === "") return token;
      const [a, b] = coreRange(token);
      const [stem, suffix] = splitSuffix(token.slice(a, b));
      const lowered = stem.toLocaleLowerCase("tr");
      let kept: string | undefined;
      if (letterCount(stem) <= ACRONYM_MAX_LETTERS && (ACRONYMS.has(stem) || forms.upper.has(stem))) kept = stem;
      else if (!forms.lower.has(lowered)) kept = forms.capitalised.get(lowered);
      if (kept === undefined) return token.toLocaleLowerCase("tr");
      return (
        token.slice(0, a).toLocaleLowerCase("tr") +
        kept +
        suffix.toLocaleLowerCase("tr") +
        token.slice(b).toLocaleLowerCase("tr")
      );
    })
    .join("");
  // The first letter, not the first character: a title can open with a quote.
  for (let i = 0; i < out.length; i++) {
    if (/\p{L}/u.test(out.charAt(i))) return out.slice(0, i) + out.charAt(i).toLocaleUpperCase("tr") + out.slice(i + 1);
  }
  return out;
}

export interface PickOptions {
  /**
   * First pick of a cluster that has no neutral title yet. When no candidate
   * passes isAcceptableNeutral, return the cleaned best-scored candidate that
   * has no hard defect (shouting, placeholder, English, feed cut), else the
   * cleaned best-scored one, instead of null: the alternative is the raw
   * `title_tr` with its lead-ins and '!' on every surface. A candidate that is
   * all capitals is sentence-cased first (extractive-v4), so shouting alone no
   * longer ranks it below a title with a soft defect. A re-pick leaves this
   * off: it already has a title and keeps it unless the new one is better.
   */
  floor?: boolean;
  /**
   * The title the cluster carries now (a re-pick). It is returned exactly as
   * passed when it passes isAcceptableNeutral and no lead-in survives in it,
   * unless the best acceptable member title outscores it by REPICK_MARGIN (a
   * stored title under FULL_LENGTH_TITLE_CHARS) or REPICK_MARGIN_FULL_LENGTH
   * (a longer one). It is scored like a member that is not itself part of the comparison: its
   * centrality is the mean similarity to the members whose text differs from
   * it, so a stored title equal to member k scores like member k. A blank or
   * missing incumbent changes nothing.
   */
  incumbent?: string | null;
}

// One formula for a member candidate and for the stored title it competes with.
// The title is the text as written (a member's raw title, the stored title).
function scoreTitle(title: string, centrality: number, hedged: boolean): number {
  return (
    centrality -
    0.12 * framingPenalty(title) -
    0.25 * loadedPenalty(title) -
    (hedged && !carriesHedge(title) ? HEDGE_LOSS_PENALTY : 0) -
    0.002 * Math.max(0, title.length - 90) -
    0.008 * Math.max(0, FULL_LENGTH_TITLE_CHARS - title.length)
  );
}

/**
 * Returns the cleaned headline of the most central, least sensational
 * member that passes isAcceptableNeutral, or null when there is nothing to
 * choose from (no members, every member title generic, or every candidate
 * rejected; the headline cron then keeps the title the cluster already has).
 * With `{ floor: true }` a rejected-only cluster still gets its cleaned
 * best candidate (see PickOptions); null then means only "nothing usable".
 * With `{ incumbent }` the stored title wins unless it fails the gate or loses
 * by REPICK_MARGIN / REPICK_MARGIN_FULL_LENGTH (see PickOptions). Member titles that fold to the same
 * text count once, the first occurrence standing.
 */
export function pickNeutralTitle(members: MemberTitle[], opts: PickOptions = {}): string | null {
  const seen = new Set<string>();
  const items = members
    .map((m) => ({ ...m, title: (m.title ?? "").trim() }))
    .filter((m) => m.title.length > 0 && !isGenericTitle(m.title))
    .filter((m) => {
      const key = fold(m.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  if (items.length === 0) return null;

  const toks = items.map((m) => tokens(m.title));
  const outliers = numeralOutliers(items.map((m) => numsOf(m.title)));
  const hedged =
    items.length >= HEDGED_MIN_MEMBERS &&
    items.filter((m) => carriesHedge(m.title)).length / items.length >= HEDGED_SHARE;

  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < items.length; i++) {
    if (outliers.has(i)) continue;
    let sim = 0;
    for (let j = 0; j < items.length; j++) if (j !== i) sim += jaccard(toks[i]!, toks[j]!);
    const centrality = items.length > 1 ? sim / (items.length - 1) : 0;
    scored.push({ index: i, score: scoreTitle(items[i]!.title, centrality, hedged) });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  let best: { cleaned: string; score: number } | null = null;
  let floorSoft: string | null = null;
  let floorAny: string | null = null;
  for (const { index, score } of scored) {
    const cleaned = cleanHeadline(items[index]!.title);
    // A lead-in that survived cleaning (an odd Unicode case) must not ship.
    if (cleaned === "" || LEAD_IN.test(foldTr(cleaned))) continue;
    const others = items.filter((_, j) => j !== index).map((m) => m.title);
    if (isAcceptableNeutral(cleaned, others)) {
      best = { cleaned, score };
      break;
    }
    if (!opts.floor) continue;
    // Shouting is a hard defect, but a floor title is shown: sentence-case it
    // first, so "NEV'İN MİRASI GÜNDEM OLDU" ships as "Nev'in mirası gündem oldu".
    const shown = isAllCaps(cleaned) ? sentenceCaseShout(cleaned, others) : cleaned;
    floorAny ??= shown;
    if (floorSoft === null && !hasHardDefect(shown, others, {})) floorSoft = shown;
  }

  const incumbent = opts.incumbent;
  const inc = incumbent?.trim() ?? "";
  if (incumbent && inc !== "") {
    const memberTitles = items.map((m) => m.title);
    if (isAcceptableNeutral(inc, memberTitles) && !LEAD_IN.test(foldTr(inc))) {
      if (best === null || best.cleaned === incumbent || best.cleaned === inc) return incumbent;
      // Centrality against the members that are not the stored title itself,
      // raw or cleaned: an incumbent equal to member k scores like member k.
      const incFold = fold(inc);
      const incToks = tokens(inc);
      let sim = 0;
      let n = 0;
      for (let j = 0; j < items.length; j++) {
        const t = items[j]!.title;
        if (fold(t) === incFold || fold(cleanHeadline(t)) === incFold) continue;
        sim += jaccard(incToks, toks[j]!);
        n++;
      }
      const incScore = scoreTitle(inc, n > 0 ? sim / n : 0, hedged);
      const margin = inc.length >= FULL_LENGTH_TITLE_CHARS ? REPICK_MARGIN_FULL_LENGTH : REPICK_MARGIN;
      return best.score - incScore < margin ? incumbent : best.cleaned;
    }
  }

  return best?.cleaned ?? floorSoft ?? floorAny;
}
