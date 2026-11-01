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

// Written to clusters.title_neutral_model so readers can tell an extractive
// pick from an LLM rewrite. Bump the suffix when the selection or cleaning
// rules change in a way that alters output; the headline cron then re-picks
// the last 14 days of older-version titles (neutral_title_repick_candidates,
// migration 141). Readers must not compare against this constant: use
// isExtractiveModelId, which recognises every version.
export const EXTRACTIVE_MODEL_ID = "extractive-v2";

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
    `${L}(?:bomba|şok|sok|skandal|rezalet|çarp[iı]c[iı]|olay|dev|kritik|müjde|mujde)${R}`,
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
];

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

export function cleanHeadline(title: string): string {
  let t = title.trim();
  // Outlet prefixes ("Halk TV | ...") and "Son dakika" lead-ins, repeatedly:
  // "SON DAKİKA | FLAŞ! x" is "x".
  t = t.replace(/^[^|│]{0,25}[|│]\s*/, "");
  t = stripLeadIns(t);
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

// Defects a first-pick floor does not forgive: shouting, a placeholder, an
// English headline, a feed cut. A question, a leading "İşte" or an odd length
// are only less good than the cleaned text of a title nobody has cleaned yet.
function hasHardDefect(t: string, memberTitles: readonly string[], opts: AcceptOptions): boolean {
  if (/\p{L}/u.test(t) && t === t.toLocaleUpperCase("tr")) return true;
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

export interface PickOptions {
  /**
   * First pick of a cluster that has no neutral title yet. When no candidate
   * passes isAcceptableNeutral, return the cleaned best-scored candidate that
   * has no hard defect (shouting, placeholder, English, feed cut), else the
   * cleaned best-scored one, instead of null: the alternative is the raw
   * `title_tr` with its lead-ins and '!' on every surface. A re-pick leaves
   * this off: it already has a title and keeps it unless the new one is
   * better.
   */
  floor?: boolean;
}

/**
 * Returns the cleaned headline of the most central, least sensational
 * member that passes isAcceptableNeutral, or null when there is nothing to
 * choose from (no members, every member title generic, or every candidate
 * rejected; the headline cron then keeps the title the cluster already has).
 * With `{ floor: true }` a rejected-only cluster still gets its cleaned
 * best candidate (see PickOptions); null then means only "nothing usable".
 */
export function pickNeutralTitle(members: MemberTitle[], opts: PickOptions = {}): string | null {
  const items = members
    .map((m) => ({ ...m, title: (m.title ?? "").trim() }))
    .filter((m) => m.title.length > 0 && !isGenericTitle(m.title));
  if (items.length === 0) return null;

  const toks = items.map((m) => tokens(m.title));
  const outliers = numeralOutliers(items.map((m) => numsOf(m.title)));

  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < items.length; i++) {
    if (outliers.has(i)) continue;
    let sim = 0;
    for (let j = 0; j < items.length; j++) if (j !== i) sim += jaccard(toks[i]!, toks[j]!);
    const centrality = items.length > 1 ? sim / (items.length - 1) : 0;
    const title = items[i]!.title;
    const score =
      centrality -
      0.12 * framingPenalty(title) -
      0.25 * loadedPenalty(title) -
      0.002 * Math.max(0, title.length - 90);
    scored.push({ index: i, score });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  let floorSoft: string | null = null;
  let floorAny: string | null = null;
  for (const { index } of scored) {
    const cleaned = cleanHeadline(items[index]!.title);
    // A lead-in that survived cleaning (an odd Unicode case) must not ship.
    if (cleaned === "" || LEAD_IN.test(foldTr(cleaned))) continue;
    const others = items.filter((_, j) => j !== index).map((m) => m.title);
    if (isAcceptableNeutral(cleaned, others)) return cleaned;
    if (!opts.floor) continue;
    floorAny ??= cleaned;
    if (floorSoft === null && !hasHardDefect(cleaned, others, {})) floorSoft = cleaned;
  }
  return floorSoft ?? floorAny;
}
