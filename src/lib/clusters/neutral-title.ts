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
//
// extractive-v4 (hunt 26, h26-editorial-1; still extractive-v4, NO model bump:
// the rules below change new picks only and migration 141 must not re-offer the
// last 14 days): eight more loaded wordings ('görkemli', 'vurgun', 'dayatma',
// 'korku dolu', 'savaş alanına çevir', 'soğuk duş', 'perde arkası', 'önemli
// açıklama|mesaj|çağrı') cost 0.25 each; an acting appointment's qualifier
// ('vekaleten', 'vekalet', 'vekil...') that at least 40% of three or more members
// carry costs a title that drops it QUALIFIER_LOSS_PENALTY (0.30; 4433b6f7 was
// titled "Genel Müdürü Atila Türeli oldu" while its members wrote 'vekaleten' and
// 'Vekilliğine'); and cleanHeadline turns a teaser pause in the middle of a title
// ("AK Parti çalışmaları tamamladı... Yeni anayasa takvimi belli oldu") into a
// sentence break unless it ends a comma list or sits inside a quote.

// extractive-v4 (hunt 27, h27-copy-2; still extractive-v4, NO model bump: new
// picks only, no backfill): a member title written in all lower case no longer
// ships as "Avrupa, türkiye’yi ... berlinden yükseldi" while a sibling writes
// "Türkiye" and "Berlin". cleanHeadline only upper-cases the first letter, so
// the pick recases a lower-case word that the sibling titles capitalise
// mid-sentence, and only when that is unambiguous (recaseFromSiblings). A
// candidate that still has a lower-case word starting with such a name
// ('berlinden', which cannot be recased without guessing the stem) is not eligible
// while another acceptable candidate exists (lowercaseLeak); with { floor: true }
// it can still ship when nothing else is usable. Both apply only to a candidate the
// outlet wrote in lower case (isOddOneOut): the first version applied the sibling
// forms to every candidate and turned 'ilk olağan kurultayı' into 'ilk olağan
// Kurultayı' (a sibling capitalises part of an event name) in 2 of 150 replayed
// clusters.

// extractive-v4 (hunt 28, h28-live-2; still extractive-v4, NO model bump: new picks
// only, no backfill): the h27 rule also recased a title that opens with a capital
// when two or more of its words disagreed (the old second branch of isOddOneOut),
// which capitalised common nouns on neutral titles: "Net Mesaj" (sibling
// "Erdoğan'dan Net Mesaj!"), "Kadın ... Aile" (sibling "TDT Aile ve Kadın Konseyi"),
// "Soyut Resim" (a sibling's quoted exhibition name), "Acil Sağlık". For 85deda69 the
// recasing made the candidate odd, so the leak guard threw it out for a more
// sensational member. The rule is now: only a lowerCaseSourced title is recased,
// i.e. one that opens in lower case or is a speaker label ("Bilal Erdoğan:")
// followed by a lower-case body. A title that opens with a capital already
// capitalises its own names; its lower-case words are the outlet's choice. And a
// sibling's capital is no evidence of a name when it sits inside a quoted span, in a
// run of capitalised words bridged by 've' / 'ile' / 'için' / 'veya' ("TDT Aile ve
// Kadın Konseyi") or in a run that ends with '!' ("Net Mesaj!"); see caseEvidence.

// extractive-v5 (hunt 31, h31-reader-2): MODEL BUMP. Two top stories kept a loaded
// or teaser member headline because the re-pick protects the incumbent and the
// loaded list had no entry for them: 2ee853c9 (26 sources) "ABD seçimlerinin
// ardından İran'dan tehdit gibi açıklama" (25 members report "savaşa hayır dedi")
// and d89374ba (12 sources) "Gazze'nin tanığı cerrah da ABD'de seçimi kazandı".
// 'tehdit gibi', 'yıktı', 'hezimet...' and 'tarihe geçen' join the loaded words, and
// a sequel teaser (a lower-case word and then a standalone 'da' / 'de' among the
// first five words: "Gazze'nin tanığı cerrah da ...", a continuation of another
// story that names nobody) pays one loaded unit too; see sequelTeaser. Both are
// charged to a member's score and to the stored title's score alike, so the 0.25
// exceeds the 0.20 full-length re-pick margin and the factual member title wins.
// What the bump does: migration 141 (neutral_title_repick_candidates) re-offers the
// active clusters of the last 14 days whose title_neutral_model is older than this
// id, the newest 5000 (about 4,100 today). The headline cron heals about 20 per
// 5-minute run, so the whole window takes roughly 17 hours. This is the first time
// the h26, h27 and h28 rules reach stored titles: they changed new picks only and
// did not bump the id. The re-pick never writes updated_at, so a healed cluster
// does not jump in the "newest" order. A replay of the 141 population and of the
// 150-cluster corpus is in neutral-title-replay.test.ts.

// extractive-v6 (hunt 34, h34-reader-1 and h34-reader-2): MODEL BUMP. The re-pick's
// incumbent protection froze five live top-story titles: b6fe7960 (19 sources)
// says Vance blamed the loss on Israel while about 12 members say the war, 2f43df00
// names no subject ("DEM Parti Sözcüsü ile Barış Anneleri'ni kabul etti" while eight
// of nine members say Kurtulmuş), 97da6195 (28 sources) is a vague Title Case line,
// 97589454 announces ("açıklama yapılacak") what the members report as done and
// 268d231b dropped its verb. incumbentDefect() lowers the bar for such a stored title
// from REPICK_MARGIN / REPICK_MARGIN_FULL_LENGTH to zero (a minority claim, a Title
// Case run, a majority subject the stored title lacks); it never decides a pick by
// itself: the best member title must still outscore the stored one. The first-pick
// floor no longer ships a question or an SEO explainer ("Saniye Caran kimdir? ...
// kaç yaşında, nereli?") while any statement exists (isQuestionTitle), and
// 'şahlanış', 'dev dönüşüm', 'tescillendi' and 'sarsılmaz' (an advertorial's
// vocabulary) join the loaded words. What the bump does: migration 141 re-offers the
// active clusters of the last 14 days whose title_neutral_model is older than this id,
// and migration 155 re-offers a stamped cluster after it has grown by greatest(3,
// half of its stamped size) instead of doubling. There is no UPDATE: the headline cron
// heals about 20 clusters per 5-minute run.

// extractive-v6 (hunt 35, h35; still extractive-v6, NO model bump: a bump would re-offer
// about 3,900 clusters in the middle of the v6 heal for a rule that changes the text of
// three stored titles; a replay of the 168 live clusters whose stored title holds a glued
// join and of the 240 with a glued member title in the last 21 days changes 3 re-picks and
// 3 first picks, all of them a glued variant swapped for its correctly punctuated twin):
// a pick that holds a glued lower-to-upper join inside a word is replaced by a member title
// that is the same text with fewer such joins. e02ef916 was titled "... Tel
// AvivWashington ilişkisini ...": one outlet's feed lost the hyphen of "Tel
// Aviv-Washington", a second outlet wrote it correctly, and the picker chose the glued
// variant (the two fold to different strings, so neither counts as a duplicate of the
// other). preferUnglued() runs on the final result of pickNeutralTitle, the first pick and
// the stored title a re-pick keeps alike, and only swaps to a member title that has the same
// letters and digits in the same case (so a brand such as YouTube, TikTok, WhatsApp or
// iPhone, which both twins carry, is never swapped) and passes the gate. It never writes a
// text no member wrote. Without a bump a glued title that already carries v6 heals only when
// migration 155's growth rule offers its cluster again (it has grown by greatest(3, half of
// its stamped size)); one still stamped v1 to v5 heals in the running v6 pass.

// Written to clusters.title_neutral_model so readers can tell an extractive
// pick from an LLM rewrite. Bump the suffix when the selection or cleaning
// rules change in a way that alters output; the headline cron then re-picks
// the last 14 days of older-version titles (neutral_title_repick_candidates,
// migration 141). Readers must not compare against this constant: use
// isExtractiveModelId, which recognises every version.
export const EXTRACTIVE_MODEL_ID = "extractive-v6";

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
  // Hype and content-free wording (hunt 26, h26-editorial-1). 'vurgun' has no
  // right edge on purpose (vurgunu, vurgunlar) and does not match 'vurgu' /
  // 'vurgusu'; the multi-word entries are the outlet's cliché, not the event.
  new RegExp(`${L}görkemli${R}`, "u"),
  new RegExp(`${L}vurgun`, "u"),
  new RegExp(`${L}dayatma`, "u"),
  new RegExp(`${L}korku\\s+dolu${R}`, "u"),
  new RegExp(`${L}savaş\\s+alanına\\s+çevir`, "u"),
  new RegExp(`${L}soğuk\\s+duş`, "u"),
  new RegExp(`${L}perde\\s+arkas[ıi]`, "u"),
  new RegExp(`${L}önemli\\s+(?:açıklama|mesaj|çağrı)`, "u"),
  // Loaded simile and verdict wording (hunt 31, h31-reader-2). 'tehdit gibi' is
  // one outlet's editorial simile ("İran'dan tehdit gibi açıklama" while 25 members
  // quote "savaşa hayır dedi"). 'yıktı' is the verdict verb of a party or a leader
  // "brought down"; it is charged for a storm that "yıktı" roofs too, which costs
  // every member of such a cluster the same and so moves no pick, while 'yıkıldı'
  // (a building collapsed) is a different word and stays free. 'hezimet' has no
  // right edge (hezimeti, hezimete); 'tarihe geçen' is "made history", not the event.
  new RegExp(`${L}tehdit\\s+gibi${R}`, "u"),
  new RegExp(`${L}y[ıi]kt[ıi]${R}`, "u"),
  new RegExp(`${L}hezimet`, "u"),
  new RegExp(`${L}tarihe\\s+ge[çc]en${R}`, "u"),
  // Advertorial vocabulary (hunt 34, h34-reader-2, 82a06ce6: "Çeyrek asırlık istikrar,
  // küresel siyasette şahlanış: 24 yıllık dev dönüşüm verilerle tescillendi"). The
  // first two have no right edge on purpose (şahlanışı, dönüşümü); 'tescillendi' and
  // 'sarsılmaz' are whole words.
  new RegExp(`${L}şahlanış`, "u"),
  new RegExp(`${L}dev\\s+dönüşüm`, "u"),
  new RegExp(`${L}tescillendi${R}`, "u"),
  new RegExp(`${L}sarsılmaz${R}`, "u"),
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

// The qualifier of an acting appointment: 'vekaleten' (by proxy), 'vekalet',
// 'vekil' / 'vekili' / 'vekilliğine' (acting, deputy). The left word edge keeps
// 'milletvekili' and 'başkanvekili' out: a member of parliament is not an
// acting anything. Tested on foldTr(title); [aâ] and [iı] because the tr-locale
// lower case of "VEKİL" is 'vekil' but a typed "vekâleten" keeps its circumflex.
const QUALIFIER = new RegExp(`${L}(?:vek[aâ]leten|vek[aâ]let|vek[iı]l)`, "u");

/**
 * What a title pays for dropping the qualifier its cluster's members carry (the
 * hedge rule's twin, charged more because an acting appointment shown as a full
 * one is a different fact, not a softer verb): when three or more (deduplicated)
 * members exist and at least QUALIFIED_SHARE of them carry 'vekaleten' /
 * 'vekalet' / 'vekil...', a title without it is asserting a full appointment.
 * Charged to a member's score and to the stored title's score alike. Separate
 * from HEDGE_LOSS_PENALTY (0.15), which stays below the 0.20 re-pick margin.
 */
export const QUALIFIER_LOSS_PENALTY = 0.3;
const QUALIFIED_MIN_MEMBERS = 3;
const QUALIFIED_SHARE = 0.4;

function carriesQualifier(title: string): boolean {
  return QUALIFIER.test(foldTr(title));
}

export function framingPenalty(title: string): number {
  const folded = foldTr(title);
  let n = 0;
  for (const re of FRAMING_RAW) if (re.test(title)) n++;
  for (const re of FRAMING_FOLDED) if (re.test(folded)) n++;
  return n;
}

// The sequel teaser (hunt 31, h31-reader-2): a title that is the continuation of
// another story, "Gazze'nin tanığı cerrah da ABD'de seçimi kazandı" ("the surgeon
// ... too won"). It leans on a headline the reader has not seen and names nobody,
// so it pays one loaded unit. Judged on the raw title, no regular expression over
// the whole title: it is walked once, token by token, and the walk stops after the
// fifth word.
//   - Tokens are whitespace-delimited, with the punctuation and quotes trimmed off
//     both ends. The first token that ends in ':' stops the scan: "Bahçeli: biz de
//     hazırız" is a speaker label and a quote, not a teaser.
//   - The particle is the FIRST token that reads 'da' or 'de' (a suffix such as
//     "ABD'de" is not a standalone particle). Only a particle at index 1 to 4 is
//     judged: at index 0 it is part of a name ("De Bruyne"), and past the fifth word
//     the title has already said what happened.
//   - It is a teaser when the token before the particle starts with a lower-case
//     letter and is not a pronoun or a conjunction that licenses the particle ("ya
//     da", "hem de", "yine de", "ben de", "bana da", "o da") nor a concessive verb
//     ("düşse de", "olsa da": 'even if', which ends in -sa / -se). A capitalised word
//     before it ("İran da açıklama yaptı", "Törene Bakan da katıldı") is a subject
//     that is named.
// Deviations from the fix_spec, all found by the live replay of the 141 population:
//   1. The fix_spec said "no capitalised proper noun before it". That would let
//      "Gazze'nin tanığı cerrah da ..." through, because 'Gazze'nin' opens the title
//      with a capital, so the rule judges the word immediately before the particle.
//   2. A concessive verb before the particle is not a teaser: "Ağıralioğlu,
//      enflasyon düşse de ... dedi" (74ce6708) was swapped for the vague "Yavuz
//      Ağıralioğlu'ndan ekonomi eleştirisi", and "Trump istese de" (92748902) was
//      charged too.
//   3. The particle has to be written in lower case: a capitalised 'De' / 'Da' after
//      a lower-case word is a surname ("Belçika hükümeti düşecek mi? De Wever ...").
//   4. The oblique forms of the pronouns in the exclusion list ("bana da anlatın")
//      are excluded with them.
const TEASER_LAST_PARTICLE_INDEX = 4;
const TEASER_NOT_A_SUBJECT: ReadonlySet<string> = new Set([
  "ya", "hem", "yine", "gene", "ise", "ama", "ben", "sen", "o", "biz", "siz",
  "onlar", "bu", "şu",
  "bana", "sana", "ona", "bize", "size", "onlara", "beni", "seni", "onu", "bizi",
  "sizi", "onları", "bunu", "buna", "bunun", "şunu", "şuna", "benim", "senin",
  "onun", "bizim", "sizin", "onların",
]);
// A token longer than this is never 'da' / 'de' nor in the set above: only its
// first letters are kept, so a 2 MB token costs a scan and not a copy.
const TEASER_TOKEN_KEEP = 24;
const TEASER_TRAILING_QUOTES: ReadonlySet<string> = new Set([
  '"', "'", "’", "”", "‘", "“", "»", "«", ")", "]",
]);
const WORD_CHAR = /[\p{L}\p{N}]/u;

function isTeaserSpace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === "\u00a0" || ch === "\f" || ch === "\v";
}

function sequelTeaser(title: string): boolean {
  const n = title.length;
  let at = 0;
  let previous: string | null = null; // the trimmed token before the current one
  for (let index = 0; index <= TEASER_LAST_PARTICLE_INDEX; index++) {
    while (at < n && isTeaserSpace(title.charAt(at))) at++;
    if (at >= n) return false;
    const start = at;
    while (at < n && !isTeaserSpace(title.charAt(at))) at++;
    const end = at;
    // A speaker label ends the scan.
    let last = end;
    while (last > start && TEASER_TRAILING_QUOTES.has(title.charAt(last - 1))) last--;
    if (last > start && title.charAt(last - 1) === ":") return false;
    // Trim punctuation and quotes from both ends.
    let from = start;
    while (from < end && !WORD_CHAR.test(title.charAt(from))) from++;
    let to = end;
    while (to > from && !WORD_CHAR.test(title.charAt(to - 1))) to--;
    const token = title.slice(from, Math.min(to, from + TEASER_TOKEN_KEEP));
    if (token === "da" || token === "de") {
      if (index < 1 || previous === null) return false;
      if (!/^\p{Ll}/u.test(previous)) return false;
      const before = previous.toLocaleLowerCase("tr");
      return !TEASER_NOT_A_SUBJECT.has(before) && !before.endsWith("sa") && !before.endsWith("se");
    }
    previous = token;
  }
  return false;
}

/** Number of loaded-wording rules the title trips (0.25 each in scoreTitle). */
export function loadedPenalty(title: string): number {
  const folded = foldTr(title);
  let n = 0;
  for (const re of LOADED_FOLDED) if (re.test(folded)) n++;
  if (sequelTeaser(title)) n++;
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

// A teaser pause in the middle of a title: '...' or '…' directly after a letter,
// then whitespace and an upper-case letter or a digit ("AK Parti çalışmaları
// tamamladı... Yeni anayasa takvimi belli oldu"). Lower case after the dots is a
// continuation and stays.
const TEASER_PAUSE = /(?<=\p{L})(?:\.{3}|…)\s+(?=[\p{Lu}\p{Nd}])/gu;
const TEASER_MIN_WORDS = 2;

// A question after which the pause stays a pause. "Emekliye ara zam var mı...
// Bakan açıkladı" would become "var mı. Bakan": a full stop after a question is
// wrong Turkish punctuation and the title loses its question form. A segment is a
// question when it holds the question particle (mı / mi / mu / mü, with the
// person and tense suffixes that can follow it: miyim, misin, miyiz, misiniz,
// midir, miydi(m/n/k/niz), mıymış) or a question word. Whole tokens only, so
// "mimar", "muhtar", "kimse", "nehir", "MI6" are not questions. A false positive
// merely leaves the pause as the outlet wrote it (what HEAD did); a false
// negative would put a full stop after a question.
const QUESTION_PARTICLE =
  /^m[ıiuü](?:y[ıiuü]m|s[ıiuü]n|y[ıiuü]z|s[ıiuü]n[ıiuü]z|d[ıiuü]r|yd[ıiuü](?:m|n|k|n[ıiuü]z)?|ym[ıiuü]ş)?$/u;
const QUESTION_WORDS: ReadonlySet<string> = new Set([
  "ne", "neler", "nedir", "neyi", "neye", "neden", "niçin", "niye", "nasıl",
  "nasıldır", "kim", "kimin", "kimler", "kimdir", "nerede", "nereye", "nereden",
  "nerde", "neresi", "hangi", "hangisi", "hangileri", "kaç", "kaçı", "kaçıncı",
]);
// The longest form above is 8 letters; a longer token is never a question token,
// so the scan does not even collect it (a 100 KB token costs a counter, not a
// string).
const QUESTION_TOKEN_MAX = 10;

function isQuestionToken(token: string): boolean {
  const w = token.toLocaleLowerCase("tr");
  return QUESTION_WORDS.has(w) || QUESTION_PARTICLE.test(w);
}

/**
 * Turns a teaser pause into a sentence break ('. '), but only when the segment
 * before it (since the start or the previous '.', '!', '?', ':' or '…') has at
 * least TEASER_MIN_WORDS words and no comma (a comma list's dots end an
 * enumeration, not a sentence), is not a question (see QUESTION_PARTICLE) and no
 * quote is open there: an unpaired '"', a '“' / '‘' / '«' without its closer, or
 * a straight single quote that opens a word and was not closed (an apostrophe
 * sits inside a word and is not a quote).
 * One left-to-right scan: the replace callback only advances the counters, so
 * the cost is linear in the title however many pauses it has.
 */
function breakTeaserPauses(t: string): string {
  let at = 0;
  let straightDouble = 0;
  let curlyOpen = 0;
  let curlyClose = 0;
  let guillemetOpen = 0;
  let guillemetClose = 0;
  let singleOpen = 0; // ‘
  let singleClose = 0; // ’
  let straightOpen = 0; // ' at a word start
  let straightClose = 0; // ' after a letter, before a non-letter
  let words = 0;
  let comma = false;
  let inWord = false;
  let question = false;
  // The letters of the current whitespace-delimited token, collected only while
  // it can still be a question token. A digit anywhere spoils it ("MI6").
  let token = "";
  let tokenLength = 0;
  let tokenSpoiled = false;
  const endToken = (): void => {
    if (tokenLength > 0 && tokenLength <= QUESTION_TOKEN_MAX && !tokenSpoiled && isQuestionToken(token)) {
      question = true;
    }
    token = "";
    tokenLength = 0;
    tokenSpoiled = false;
  };
  const advance = (to: number): void => {
    for (; at < to; at++) {
      const ch = t.charAt(at);
      switch (ch) {
        case '"': straightDouble++; break;
        case "“": curlyOpen++; break;
        case "”": curlyClose++; break;
        case "«": guillemetOpen++; break;
        case "»": guillemetClose++; break;
        case "‘": singleOpen++; break;
        case "’": singleClose++; break;
        case "'": {
          const before = at > 0 ? t.charAt(at - 1) : "";
          const after = at + 1 < t.length ? t.charAt(at + 1) : "";
          const beforeLetter = before !== "" && /[\p{L}\p{N}]/u.test(before);
          const afterLetter = after !== "" && /[\p{L}\p{N}]/u.test(after);
          if (!beforeLetter && afterLetter) straightOpen++;
          else if (beforeLetter && !afterLetter) straightClose++;
          break;
        }
        default:
      }
      if (ch === "." || ch === "!" || ch === "?" || ch === ":" || ch === "…") {
        words = 0;
        comma = false;
        inWord = false;
        question = false;
        token = "";
        tokenLength = 0;
        tokenSpoiled = false;
      } else if (/\s/.test(ch)) {
        endToken();
        inWord = false;
      } else {
        if (!inWord) words++;
        inWord = true;
        if (ch === ",") comma = true;
        if (/\p{L}/u.test(ch)) {
          tokenLength++;
          if (tokenLength <= QUESTION_TOKEN_MAX) token += ch;
        } else if (/\p{N}/u.test(ch)) {
          tokenSpoiled = true;
        }
      }
    }
  };
  return t.replace(TEASER_PAUSE, (match: string, offset: number) => {
    advance(offset);
    endToken(); // the word that ends right where the dots begin
    const quotesOpen =
      straightDouble % 2 !== 0 ||
      curlyOpen > curlyClose ||
      guillemetOpen > guillemetClose ||
      singleOpen > singleClose ||
      straightOpen > straightClose;
    if (words < TEASER_MIN_WORDS || comma || question || quotesOpen) return match;
    return ". ";
  });
}

const TRAILING_PUNCTUATION = new Set([".", ":", "…", "-", "–", "—"]);

// The old `/[\s.:…\-–—]+$/` strip, as one right-to-left scan: the regex was
// retried from every position of a long run that something else follows (k^2).
function trimTrailingPunctuation(t: string): string {
  let end = t.length;
  while (end > 0) {
    const ch = t.charAt(end - 1);
    if (!TRAILING_PUNCTUATION.has(ch) && !/\s/.test(ch)) break;
    end--;
  }
  return end === t.length ? t : t.slice(0, end);
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
  // (?<!!) starts a match only at the head of a run: without it a run of k '!'
  // that no whitespace or end follows is retried from every position (k^2).
  t = t.replace(/(?<!!)!+\s+/g, ". ").replace(/(?<!!)!+$/g, "");
  t = breakTeaserPauses(t);
  // Trailing ellipsis / colon / dash.
  t = trimTrailingPunctuation(t);
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

// Whether the title opens a double quote it never closes (or closes one it never
// opened): an odd number of straight " (U+0022), unequal “ (U+201C) and ” (U+201D),
// or unequal « (U+00AB) and » (U+00BB). That also catches the ”...” same-glyph and
// the “..." mixed styles. Single quotes and apostrophes (' ‘ ’ ʼ) and „ are never
// counted: a Turkish apostrophe or a lone ‘ is not a quote left open. One pass,
// no regex.
function unbalancedDoubleQuotes(t: string): boolean {
  let straight = 0;
  let curly = 0;
  let angle = 0;
  for (let i = 0; i < t.length; i++) {
    switch (t.charCodeAt(i)) {
      case 0x22:
        straight++;
        break;
      case 0x201c:
        curly++;
        break;
      case 0x201d:
        curly--;
        break;
      case 0xab:
        angle++;
        break;
      case 0xbb:
        angle--;
        break;
    }
  }
  return straight % 2 === 1 || curly !== 0 || angle !== 0;
}

// Defects a first-pick floor does not forgive: shouting (all of it, or a run of
// shouted words), a residual '|', unbalanced double quotes, a placeholder, an
// English headline, a feed cut. A question, a leading "İşte" or an odd length
// are only less good than the cleaned text of a title nobody has cleaned yet.
function hasHardDefect(t: string, memberTitles: readonly string[], opts: AcceptOptions): boolean {
  if (/\p{L}/u.test(t) && t === t.toLocaleUpperCase("tr")) return true;
  // An outlet prefix that cleanHeadline could not strip (longer than 25
  // characters) or a separator inside the text: "... SALI |GEDİZ UYARDI: ...".
  if (/[|│]/.test(t)) return true;
  // A feed cut that opens a double quote it never closes: 'X: "Kaybedersek ...'.
  if (unbalancedDoubleQuotes(t)) return true;
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
 * Unbalanced double quotes (an odd straight ", unequal “/” or «/») are a hard
 * defect too, for copied and generated text alike.
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

// The question and SEO-explainer phrases a title can carry without a '?'
// ("Saniye Caran kimdir kaç yaşında nereli"). Matched on whole words of the folded
// title, so 'kimdirler' and 'zamanında' are not hits.
const QUESTION_PHRASES: readonly string[] = [
  "kimdir", "kac yasinda", "nereli", "ne zaman", "oldu mu", "kim elendi",
];
// A headline is far shorter; a hostile feed title costs a bounded scan.
const QUESTION_SCAN_MAX_CHARS = 1000;
// "<speaker>: <opening quote>": what follows is the speaker's words, so a '?' there
// is a quoted question ("Erdoğan'ın kuzeni sordu: 'Ballı'nınki sıradan bir intihar
// mı?'"), which is news, not an SEO question.
const SPEAKER_QUOTE_OPEN = /:\s*["“'‘«]/u;

/**
 * Whether a headline is a question or an SEO explainer: it holds a '?', or one of
 * 'kimdir', 'kaç yaşında', 'nereli', 'ne zaman', 'oldu mu', 'kim elendi' as whole
 * words (Turkish-folded, so 'KİMDİR' and 'Kaç Yaşında' count). Two clusters of
 * explainers ("Saniye Caran kimdir? ... kaç yaşında, nereli?") used to ship as the
 * floor pick of a first pick and to be served index,follow (h34-reader-2). The first-pick
 * floor ranks such a title last and the cluster page keeps it out of the index.
 * Only the headline's own words count: a speaker's quote after "<speaker>: '" is left
 * out, so a quoted question stays an ordinary headline.
 * Pure; false for a missing or non-string title.
 */
export function isQuestionTitle(title: string): boolean {
  if (typeof title !== "string" || title === "") return false;
  const head = title.slice(0, QUESTION_SCAN_MAX_CHARS);
  const quote = SPEAKER_QUOTE_OPEN.exec(head);
  const own = quote ? head.slice(0, quote.index) : head;
  if (own.includes("?")) return true;
  const padded = ` ${fold(own)} `;
  return QUESTION_PHRASES.some((phrase) => padded.includes(` ${phrase} `));
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

// ---------------------------------------------------------------------------
// Lower-case-sourced candidates (extractive-v4, hunt 27).
// ---------------------------------------------------------------------------
//
// Some outlets publish headlines in all lower case ("avrupa, türkiye’yi ...
// berlinden yükseldi"); cleanHeadline only restores the first letter. The
// sibling titles of the cluster say how the names are written, so the evidence
// is read back from them, the way sentenceCaseShout reads it for a shouted
// title, and only when it is unambiguous.

// A sibling is read up to this many characters and words: real headlines are far
// shorter, and a hostile feed title must not cost more than a counter.
const EVIDENCE_MAX_CHARS = 1000;
const EVIDENCE_MAX_TOKENS = 200;
/** A word of this many letters or more can be part of a Title Case run. */
const TITLE_CASE_MIN_LETTERS = 3;
/** Title Case is judged on at least this many such words ... */
const TITLE_CASE_MIN_WORDS = 4;
/** ... of which at least this share start with a capital. */
const TITLE_CASE_SHARE = 0.8;
/** The shortest sibling name that makes a lower-case word starting with it a leak. */
const LEAK_MIN_LETTERS = 4;
/** The longest name checked as a prefix of a word (a real name is far shorter). */
const LEAK_MAX_NAME_CHARS = 40;

const SENTENCE_END_CHARS = new Set([".", ":", "!", "?", "…"]);
const OPENING_QUOTES = new Set(['"', "“", "‘", "«", "'"]);
const CLOSING_QUOTES = new Set(['"', "”", "»", "’", "'"]);
/** Punctuation that may follow a closing quote ('..." dedi,' / '...".'). */
const QUOTE_TRAILING_PUNCT = new Set([",", ".", "!", "?", ":", ";"]);
/**
 * A capitalised run ends at a token that carries one of these. ':' is not one:
 * a speaker label ("Bilal Erdoğan:") runs on into what follows it.
 */
const RUN_END_CHARS = new Set([",", ";", ".", "!", "?", "…"]);
/** The lower-case words that join two names or nouns ("Aile ve Kadın", "Türkiye ile Japonya"). */
const RUN_BRIDGES = new Set(["ve", "ile", "için", "veya"]);
/** A speaker label is the text before the first ':' and is at most this many characters ... */
const LABEL_MAX_CHARS = 40;
/** ... and this many words. */
const LABEL_MAX_WORDS = 3;
// Hyphens, dashes and the slash join two words ("Türkiye-Japonya"). One
// character class under +, so the split is linear.
const WORD_JOINERS = /[\s\-–—/]+/u;
const WORD_JOINERS_KEPT = /([\s\-–—/]+)/u;

/** What one sibling title says about how its words are written. */
interface CaseEvidence {
  /** Tr-lower-cased word -> the distinct upper-case spellings it appeared in ("berlin" -> {"Berlin"}). */
  spellings: Map<string, Set<string>>;
  /** Tr-lower-cased words it writes entirely in lower case. */
  lower: Set<string>;
}

function hasDigit(s: string): boolean {
  return /\p{N}/u.test(s);
}

function startsUpper(word: string): boolean {
  const first = word.charAt(0);
  return first !== first.toLocaleLowerCase("tr");
}

/** The word of a token: its core between the edge punctuation, up to an apostrophe ("Türkiye'yi" -> "Türkiye"). "" when there is none. */
function stemOf(token: string): string {
  const [a, b] = coreRange(token);
  if (a >= b) return "";
  return splitSuffix(token.slice(a, b))[0];
}

/** True for a token whose last character, past trailing , . ! ? : ;, closes a quote. A mid-token apostrophe does not. */
function closesQuote(token: string): boolean {
  let end = token.length;
  while (end > 0 && QUOTE_TRAILING_PUNCT.has(token.charAt(end - 1))) end--;
  return end > 0 && CLOSING_QUOTES.has(token.charAt(end - 1));
}

/**
 * Per token: whether it sits inside a quoted span. A span opens at a token whose
 * first character is an opening quote and closes at the first token (the opening
 * one included) that closesQuote; one that never closes runs to the end.
 */
function quotedFlags(tokens: readonly string[]): boolean[] {
  const flags: boolean[] = [];
  let open = false;
  for (const token of tokens) {
    if (!open && OPENING_QUOTES.has(token.charAt(0))) open = true;
    flags.push(open);
    if (open && closesQuote(token)) open = false;
  }
  return flags;
}

/**
 * Per token: whether it is a capitalised word of a run that capitalises common
 * nouns, so its capital says nothing about the word. A run is consecutive
 * capitalised tokens, the title's first word included, that may bridge one
 * lower-case connector between two of them; it ends at a token that carries one
 * of RUN_END_CHARS. Its words are flagged when the run bridges a connector ("TDT
 * Aile ve Kadın Konseyi") or has at least two tokens and ends with '!'
 * ("Erdoğan'dan Net Mesaj!"). One pass over the tokens, so the cost is linear.
 */
function commonNounRunFlags(
  tokens: readonly string[],
  capital: readonly boolean[],
  connector: readonly boolean[],
): boolean[] {
  const flags = tokens.map(() => false);
  let i = 0;
  while (i < tokens.length) {
    if (!capital[i]) {
      i++;
      continue;
    }
    const members = [i];
    let bridged = false;
    let last = i;
    while (!RUN_END_CHARS.has(tokens[last]!.charAt(tokens[last]!.length - 1))) {
      if (capital[last + 1]) {
        last += 1;
      } else if (connector[last + 1] && capital[last + 2]) {
        bridged = true;
        last += 2;
      } else {
        break;
      }
      members.push(last);
    }
    if (bridged || (members.length >= 2 && tokens[last]!.endsWith("!"))) {
      for (const m of members) flags[m] = true;
    }
    i = last + 1;
  }
  return flags;
}

/**
 * Reads one sibling title. The evidence skips the title's first word and any
 * word right after '.', ':', '!', '?', '…' or an opening quote (a capital
 * there says nothing about the word), keeps the stem before an apostrophe
 * ("Türkiye'yi" -> "Türkiye"), and splits on whitespace, hyphens, dashes and
 * the slash ("Türkiye-Japonya" is evidence for both). A shouted title, or one
 * with a run of shouted words, has lost its case. A Title Case title (at least
 * TITLE_CASE_SHARE of its words of TITLE_CASE_MIN_LETTERS or more letters start
 * with a capital, over at least TITLE_CASE_MIN_WORDS of them) capitalises
 * common nouns too, so it adds no capital evidence; its lower-case words still count.
 * So does a part of a title that is capitalised for another reason (h28): a word
 * inside a quoted span (an exhibition or film name: "Hikayenin En Güzel Yeri:
 * Türkiye'de Soyut Resim"), and the words of a run bridged by 've' / 'ile' /
 * 'için' / 'veya' ("TDT Aile ve Kadın Konseyi") or ending with '!' ("Net Mesaj!").
 * They add no capital evidence either; their lower-case words still count.
 */
function caseEvidence(title: string): CaseEvidence {
  const evidence: CaseEvidence = { spellings: new Map(), lower: new Set() };
  const text = title.trim().slice(0, EVIDENCE_MAX_CHARS);
  if (text === "" || isAllCaps(text) || hasShoutedRun(text)) return evidence;

  const tokens = text.split(WORD_JOINERS).filter((t) => t !== "").slice(0, EVIDENCE_MAX_TOKENS);
  const quoted = quotedFlags(tokens);
  const stems = tokens.map(stemOf);
  const runFlags = commonNounRunFlags(
    tokens,
    stems.map((stem, i) => !quoted[i] && stem !== "" && startsUpper(stem)),
    stems.map((stem, i) => !quoted[i] && RUN_BRIDGES.has(stem)),
  );
  let long = 0;
  let longCapitalised = 0;
  const words: Array<{ stem: string; capitalEvidence: boolean }> = [];
  tokens.forEach((token, i) => {
    const stem = stems[i]!;
    if (stem === "" || hasDigit(stem)) return;
    const letters = letterCount(stem);
    if (letters >= TITLE_CASE_MIN_LETTERS) {
      long++;
      if (startsUpper(stem)) longCapitalised++;
    }
    const prev = i > 0 ? tokens[i - 1]! : "";
    const skipped =
      i === 0 || SENTENCE_END_CHARS.has(prev.charAt(prev.length - 1)) || OPENING_QUOTES.has(token.charAt(0));
    if (!skipped && letters >= 2) words.push({ stem, capitalEvidence: !quoted[i] && !runFlags[i] });
  });
  const titleCase = long >= TITLE_CASE_MIN_WORDS && longCapitalised / long >= TITLE_CASE_SHARE;

  for (const { stem, capitalEvidence } of words) {
    const lowered = stem.toLocaleLowerCase("tr");
    if (stem === lowered) {
      evidence.lower.add(lowered);
      continue;
    }
    if (titleCase || !capitalEvidence) continue;
    if (stem === stem.toLocaleUpperCase("tr")) {
      // A shouted cue ("ŞOK", "SON") is the outlet's emphasis, not an acronym.
      if (STOP.has(asciiLower(stem)) || framingPenalty(lowered) > 0) continue;
    } else if (stem !== lowered.charAt(0).toLocaleUpperCase("tr") + lowered.slice(1)) {
      continue; // "iPhone", "McDonald": mixed case says nothing
    }
    let set = evidence.spellings.get(lowered);
    if (set === undefined) {
      set = new Set();
      evidence.spellings.set(lowered, set);
    }
    set.add(stem);
  }
  return evidence;
}

/** True for an upper-case spelling that stands for an acronym, not a shouted word. */
function isAcronymSpelling(spelling: string): boolean {
  return letterCount(spelling) <= ACRONYM_MAX_LETTERS || ACRONYMS.has(spelling);
}

/**
 * Tr-lower-cased word -> its capitalised spelling, over the given evidence:
 * kept only when exactly one upper-case spelling exists (two spellings, "Roma"
 * and "ROMA", are a conflict) and no sibling writes the word in lower case. An
 * all-capitals spelling maps only when it is short (ACRONYM_MAX_LETTERS) or an
 * ACRONYMS member; a longer shouted word is not evidence of a name.
 */
function capitalFormsFrom(list: readonly CaseEvidence[]): Map<string, string> {
  const spellings = new Map<string, Set<string>>();
  const lower = new Set<string>();
  for (const evidence of list) {
    for (const word of evidence.lower) lower.add(word);
    for (const [word, set] of evidence.spellings) {
      let merged = spellings.get(word);
      if (merged === undefined) {
        merged = new Set();
        spellings.set(word, merged);
      }
      for (const spelling of set) merged.add(spelling);
    }
  }
  const forms = new Map<string, string>();
  for (const [word, set] of spellings) {
    if (set.size !== 1 || lower.has(word)) continue;
    const [spelling] = set;
    if (spelling === undefined) continue;
    if (spelling === spelling.toLocaleUpperCase("tr") && !isAcronymSpelling(spelling)) continue;
    forms.set(word, spelling);
  }
  return forms;
}

/**
 * How the sibling titles capitalise their words: tr-lower-cased word -> the
 * spelling to restore ("türkiye" -> "Türkiye", "epdk" -> "EPDK"). Pure; `others`
 * are the cluster's other titles (cleaned or raw: the first word of each is
 * skipped either way). See caseEvidence for what counts as evidence.
 */
export function siblingCapitalForms(others: readonly string[]): Map<string, string> {
  return capitalFormsFrom(others.map(caseEvidence));
}

function recaseWith(forms: ReadonlyMap<string, string>, text: string): string {
  if (forms.size === 0 || text === "" || text.length > EVIDENCE_MAX_CHARS) return text;
  const parts = text.split(WORD_JOINERS_KEPT);
  let seenWord = false;
  // Even indices are words, odd ones the separators that were kept.
  for (let i = 0; i < parts.length; i += 2) {
    const token = parts[i]!;
    const [a, b] = coreRange(token);
    if (a >= b) continue;
    if (!seenWord) {
      seenWord = true; // the first word: cleanHeadline already capitalised it
      continue;
    }
    const [stem, suffix] = splitSuffix(token.slice(a, b));
    if (letterCount(stem) === 0 || stem !== stem.toLocaleLowerCase("tr")) continue;
    const form = forms.get(stem);
    if (form === undefined) continue;
    parts[i] = token.slice(0, a) + form + suffix + token.slice(b);
  }
  return parts.join("");
}

/**
 * Restores the capital letter of every word after the first that is written in
 * lower case here but that the sibling titles capitalise mid-sentence, when that
 * is unambiguous (see siblingCapitalForms): "türkiye’yi" -> "Türkiye’yi", the
 * suffix after the apostrophe and the edge punctuation untouched. A word with
 * no entry stays as written; no stem is guessed ('berlinden' stays lower case
 * when a sibling only has "Berlin'de").
 */
export function recaseFromSiblings(cleaned: string, others: readonly string[]): string {
  return recaseWith(siblingCapitalForms(others), cleaned);
}

/** The sibling names (tr-lower-cased) a lower-case word may leak: LEAK_MIN_LETTERS or more letters. */
function leakNames(forms: ReadonlyMap<string, string>): Set<string> {
  const names = new Set<string>();
  for (const word of forms.keys()) {
    if (word.length <= LEAK_MAX_NAME_CHARS && letterCount(word) >= LEAK_MIN_LETTERS) names.add(word);
  }
  return names;
}

/** True when `stem` starts with one of `names`. One set lookup per prefix length, so no scan of the names. */
function startsWithName(stem: string, names: ReadonlySet<string>): boolean {
  const longest = Math.min(stem.length, LEAK_MAX_NAME_CHARS);
  for (let k = LEAK_MIN_LETTERS; k <= longest; k++) if (names.has(stem.slice(0, k))) return true;
  return false;
}

/**
 * The title's tokens that candidate checks look at: a title longer than
 * EVIDENCE_MAX_CHARS (never an acceptable headline) is not read at all, and
 * only its first EVIDENCE_MAX_TOKENS tokens are.
 */
function candidateTokens(text: string): string[] {
  if (text.length > EVIDENCE_MAX_CHARS) return [];
  return text.split(WORD_JOINERS).slice(0, EVIDENCE_MAX_TOKENS);
}

function leaksWith(forms: ReadonlyMap<string, string>, text: string): boolean {
  const names = leakNames(forms);
  if (names.size === 0) return false;
  let seenWord = false;
  for (const token of candidateTokens(text)) {
    const [a, b] = coreRange(token);
    if (a >= b) continue;
    if (!seenWord) {
      seenWord = true;
      continue;
    }
    const [stem] = splitSuffix(token.slice(a, b));
    if (letterCount(stem) === 0 || stem !== stem.toLocaleLowerCase("tr")) continue;
    if (startsWithName(stem, names)) return true;
  }
  return false;
}

/**
 * True when a word after the first is still all lower case and starts with a
 * name of LEAK_MIN_LETTERS or more letters that the sibling titles capitalise:
 * 'berlinden' against "Berlin'de". Run it on the recased text: what recasing
 * could fix is gone, so what is left is a suffixed form whose stem would have
 * to be guessed. Such a title would ship a lower-case name.
 */
export function lowercaseLeak(text: string, others: readonly string[]): boolean {
  return leaksWith(siblingCapitalForms(others), text);
}

/**
 * How many of a candidate's words after the first disagree with the sibling
 * forms: lower-case words the siblings capitalise, or lower-case words that start
 * with a name they capitalise (the words recaseWith restores and leaksWith
 * reports), each word once.
 */
function disagreements(forms: ReadonlyMap<string, string>, text: string): number {
  const names = leakNames(forms);
  let disagree = 0;
  let seenWord = false;
  for (const token of candidateTokens(text)) {
    const [a, b] = coreRange(token);
    if (a >= b) continue;
    if (!seenWord) {
      seenWord = true;
      continue;
    }
    const [stem] = splitSuffix(token.slice(a, b));
    if (letterCount(stem) === 0 || stem !== stem.toLocaleLowerCase("tr")) continue;
    if (forms.has(stem) || startsWithName(stem, names)) disagree++;
  }
  return disagree;
}

/**
 * True when the title, as the outlet wrote it, opens with a lower-case letter.
 * A number first ("5 kişi gözaltına alındı") says nothing, so it is false.
 */
function startsLowerCase(title: string): boolean {
  const first = title.match(/[\p{L}\p{N}]/u)?.[0];
  return first !== undefined && first !== first.toLocaleUpperCase("tr");
}

/**
 * True when the outlet wrote the title in lower case, so its names are the ones
 * that lost their capitals: it opens with a lower-case letter, or it is a speaker
 * label followed by a lower-case body ("Bilal Erdoğan: türkiye ile japonya ...").
 * A label is the text before the first ':' when that sits at index 1 to
 * LABEL_MAX_CHARS, with 1 to LABEL_MAX_WORDS words that all start with a capital
 * ("SON DAKİKA: türkiye ..." counts; "İddia: Vali ..." and "Vali yardımcısının
 * ölümünde yeni iddia: başsavcı ..." do not). A title that opens with a capital
 * and has no such label capitalises its own names (h28).
 */
export function lowerCaseSourced(rawTitle: string): boolean {
  const title = rawTitle.trim().slice(0, EVIDENCE_MAX_CHARS);
  if (startsLowerCase(title)) return true;
  const colon = title.indexOf(":");
  if (colon < 1 || colon > LABEL_MAX_CHARS) return false;
  const label = title.slice(0, colon).split(WORD_JOINERS).filter((w) => w !== "");
  if (label.length < 1 || label.length > LABEL_MAX_WORDS || !label.every(startsUpper)) return false;
  return startsLowerCase(title.slice(colon + 1));
}

/**
 * Whether the sibling forms should be applied to the candidate. Only a title the
 * outlet wrote in lower case (lowerCaseSourced) takes them, and only once at least
 * one word disagrees. A title that opens with a capital already capitalises its
 * own names, so its remaining lower-case words are the outlet's choice ("kurultayı"
 * in "Yeni Parti’nin ilk olağan kurultayı ..." against a sibling's "Olağan
 * Kurultayı'na", "savunma ittifakına" against "Mekke Ortak Savunma Anlaşması"): it
 * is never odd, however many words disagree, and so never reaches the leak guard
 * either. h27 also let such a title in when two words disagreed and more
 * disagreed than agreed; that capitalised common nouns (h28-live-2).
 */
function isOddOneOut(forms: ReadonlyMap<string, string>, rawTitle: string, cleaned: string): boolean {
  return lowerCaseSourced(rawTitle) && disagreements(forms, cleaned) >= 1;
}

export interface PickOptions {
  /**
   * First pick of a cluster that has no neutral title yet. When no candidate
   * passes isAcceptableNeutral, return the cleaned best-scored candidate that
   * has no hard defect (shouting, placeholder, English, feed cut) and is not a
   * question or SEO explainer (isQuestionTitle, extractive-v6: those rank below
   * every statement, however short), else the best-scored question without a
   * hard defect, else the cleaned best-scored one, instead of null: the alternative is the raw
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
   * (a longer one), or by any margin at all when incumbentDefect says the stored
   * title is itself the defect (extractive-v6). It is scored like a member that is not itself part of the comparison: its
   * centrality is the mean similarity to the members whose text differs from
   * it, so a stored title equal to member k scores like member k. A blank or
   * missing incumbent changes nothing.
   */
  incumbent?: string | null;
}

/** What the members of one cluster say about their own wording. */
interface ScoreContext {
  /** Enough members hedge ('iddia', 'öne sürdü', 'ifade'): dropping it costs HEDGE_LOSS_PENALTY. */
  hedged: boolean;
  /** Enough members carry an acting qualifier ('vekaleten', 'vekil...'): dropping it costs QUALIFIER_LOSS_PENALTY. */
  qualified: boolean;
}

// One formula for a member candidate and for the stored title it competes with.
// The title is the text as written (a member's raw title, the stored title).
function scoreTitle(title: string, centrality: number, ctx: ScoreContext): number {
  return (
    centrality -
    0.12 * framingPenalty(title) -
    0.25 * loadedPenalty(title) -
    (ctx.hedged && !carriesHedge(title) ? HEDGE_LOSS_PENALTY : 0) -
    (ctx.qualified && !carriesQualifier(title) ? QUALIFIER_LOSS_PENALTY : 0) -
    0.002 * Math.max(0, title.length - 90) -
    0.008 * Math.max(0, FULL_LENGTH_TITLE_CHARS - title.length)
  );
}

// ---------------------------------------------------------------------------
// The stored title's defect (extractive-v6, hunt 34, h34-reader-1).
// ---------------------------------------------------------------------------
//
// The re-pick protects the stored title (the incumbent) unless the best member title
// outscores it by REPICK_MARGIN / REPICK_MARGIN_FULL_LENGTH. That bar is right for two
// good titles that differ in wording, and wrong for a stored title that is itself the
// defect: b6fe7960 (19 sources) said Vance blamed the loss on Israel while about 12 of
// 19 members say the war, 97da6195 (28 sources) is a vague Title Case line, 2f43df00
// names no subject. incumbentDefect() recognises such a title from the members alone
// (no word list), and a stored title that has the defect gives way to any member title
// that outscores it at all. It does not pick: the caller still compares scores.
//
// Every share below is measured over the SAMPLE: the deduplicated member titles minus
// the copies of the stored title and of the best candidate themselves, so a title is
// never counted as evidence for itself. A stem is the first STEM_LETTERS letters of a
// folded content word (the word before an apostrophe suffix, hyphen or slash; no stop
// words, three letters or more, no digits), which keeps 'israil' / 'israil'e' together.
//
// A first version judged "the words only the stored title has are rare, the words only
// the best has are common" and, replayed, changed 26 of the 150 corpus titles (HEAD: 12)
// and 81 of the 1,891 v5 titles of the last 7 days (HEAD: 2), most of the extra ones a
// lateral swap or a different sub-event ('Keisha Lance Bottoms' is a rare name, not a
// minority claim; Fidan's G20 attendance became his meeting with Rubio). What separates a
// minority claim from an elaboration is what the stored title OMITS: b6fe7960's covers a
// quarter of the eight stems most members use (it has 'seçim' and 'ABD', not 'Vance',
// 'kaybetmek', 'neden', 'İran', 'savaş'), while a longer title that names a person still
// has the words everybody uses. The rule is therefore a coverage rule, and a
// missing subject needs 75% of the members (at 50% it changed eight more titles of the 7-day
// replay, one of them 'Devlet Bahçeli'nin kız kardeşi hayatını kaybetti' for a condolence
// message). Replay of the final rules: 12 of 150 (the twelve HEAD already changes) and 15
// of 1,891 (HEAD: 2), the other 13 hand-reviewed in __fixtures__/h34-incumbents.json.

/** Fewer sample members than this say too little about a "majority". */
const DEFECT_MIN_SAMPLE = 5;
const STEM_LETTERS = 5;
/** The words only the stored title has are said by under this mean share of the sample ... */
const MINORITY_SUPPORT = 0.25;
/** ... the majority vocabulary is every stem said by at least this share, ... */
const MAJORITY_SUPPORT = 0.4;
/** ... of which there must be at least this many ... */
const MAJORITY_MIN_STEMS = 4;
/** ... the stored title covers at most this share of it ... */
const INCUMBENT_MAX_COVERAGE = 0.5;
/** ... and the best candidate covers at least this much more. */
const MIN_COVERAGE_GAP = 0.3;
/** A proper-noun stem the stored title lacks is a missing subject when this share of the sample says it. */
const SUBJECT_SUPPORT = 0.75;
/** A proper noun is capitalised mid-title by at least this many sample members and written lower-case by none. */
const SUBJECT_MIN_CAPITALISED = 2;
/** A run of this many capitalised common nouns in a row is Title Case ... */
const TITLE_CASE_RUN = 3;
/** ... judged against at least this many other member titles. */
const TITLE_CASE_MIN_SAMPLE = 3;

// The words before an apostrophe suffix, hyphen or slash ("AYM'den" -> 'aym',
// "Mahkemesi'nden" -> 'mahke'): tokens() would also keep the suffixes ('den', 'nden').
function stemSet(title: string): Set<string> {
  const out = new Set<string>();
  for (const raw of title.slice(0, EVIDENCE_MAX_CHARS).split(WORD_JOINERS).slice(0, EVIDENCE_MAX_TOKENS)) {
    for (const t of fold(stemOf(raw)).split(" ")) {
      if (t.length >= 3 && !STOP.has(t) && !hasDigit(t)) out.add(t.slice(0, STEM_LETTERS));
    }
  }
  return out;
}

/** Share of the sample whose stem set holds `stem`. */
function shareOf(stem: string, sample: readonly Set<string>[]): number {
  let n = 0;
  for (const s of sample) if (s.has(stem)) n++;
  return n / sample.length;
}

/**
 * The stored title says what few members say and omits what most say: its own words
 * (the best candidate lacks them) are under MINORITY_SUPPORT of the sample on
 * average, and it covers at most INCUMBENT_MAX_COVERAGE of the majority vocabulary
 * (the stems at least MAJORITY_SUPPORT of the sample says, MAJORITY_MIN_STEMS or more
 * of them) where the best candidate covers MIN_COVERAGE_GAP more.
 */
function minorityClaim(inc: Set<string>, best: Set<string>, sample: readonly Set<string>[]): boolean {
  const incOnly = [...inc].filter((s) => !best.has(s));
  if (incOnly.length === 0) return false;
  if (incOnly.reduce((sum, s) => sum + shareOf(s, sample), 0) / incOnly.length >= MINORITY_SUPPORT) return false;
  const counts = new Map<string, number>();
  for (const stems of sample) for (const s of stems) counts.set(s, (counts.get(s) ?? 0) + 1);
  const majority = [...counts].filter(([, n]) => n / sample.length >= MAJORITY_SUPPORT).map(([s]) => s);
  if (majority.length < MAJORITY_MIN_STEMS) return false;
  const covered = (stems: Set<string>): number => majority.filter((s) => stems.has(s)).length / majority.length;
  const incCoverage = covered(inc);
  return incCoverage <= INCUMBENT_MAX_COVERAGE && covered(best) - incCoverage >= MIN_COVERAGE_GAP;
}

/** How many sample titles write a word in lower case, and how many with a capital (a Title Case title adds none). */
interface CaseVotes {
  lower: Map<string, number>;
  capital: Map<string, number>;
}

function caseVotes(sample: readonly string[]): CaseVotes {
  const votes: CaseVotes = { lower: new Map(), capital: new Map() };
  for (const member of sample) {
    const evidence = caseEvidence(cleanHeadline(member));
    for (const word of evidence.lower) votes.lower.set(word, (votes.lower.get(word) ?? 0) + 1);
    for (const word of evidence.spellings.keys()) votes.capital.set(word, (votes.capital.get(word) ?? 0) + 1);
  }
  return votes;
}

/**
 * A run of TITLE_CASE_RUN or more capitalised words that the sample writes in lower
 * case ("Kararı: İfade Özgürlüğü ..." against 'kararı', 'ifade özgürlüğü'). The title's
 * first word and a word after a sentence end are capitalised by grammar and neither
 * count nor break a run; a lower-case word, a word nobody writes in lower case (a
 * name) or a ',' ';' '.' '!' '?' '…' ends it.
 */
function titleCaseRun(title: string, votes: CaseVotes): boolean {
  const words = title.trim().slice(0, EVIDENCE_MAX_CHARS).split(/\s+/).slice(0, EVIDENCE_MAX_TOKENS);
  let run = 0;
  for (let i = 0; i < words.length; i++) {
    const token = words[i]!;
    const stem = stemOf(token);
    if (stem === "" || !startsUpper(stem)) {
      run = 0;
      continue;
    }
    const prev = i > 0 ? words[i - 1]! : "";
    const grammatical = i === 0 || [".", "!", "?", "…"].includes(prev.charAt(prev.length - 1));
    if (!grammatical) {
      const word = stem.toLocaleLowerCase("tr");
      const asLower = votes.lower.get(word) ?? 0;
      if (asLower > 0 && asLower > (votes.capital.get(word) ?? 0)) {
        run++;
        if (run >= TITLE_CASE_RUN) return true;
      } else {
        run = 0;
      }
    }
    if (RUN_END_CHARS.has(token.charAt(token.length - 1))) run = 0;
  }
  return false;
}

/**
 * A proper-noun stem that at least SUBJECT_SUPPORT of the sample says and the best
 * candidate has, which the stored title lacks ("TBMM Başkanı Kurtulmuş, 'Barış
 * Anneleri'ni kabul etti" against "DEM Parti Sözcüsü ile Barış Anneleri'ni kabul
 * etti": 'Kurtulmuş' is in eight of nine member titles). A stem is a proper noun when
 * SUBJECT_MIN_CAPITALISED sample titles write it with a capital past their first
 * word and none writes it in lower case. Only for a stored title whose own words are
 * a minority (under MINORITY_SUPPORT of the sample on average): a shorter title that
 * merely omits a name the others add is not wrong.
 */
function missingSubject(
  inc: Set<string>,
  best: Set<string>,
  sample: readonly string[],
  sampleStems: readonly Set<string>[],
): boolean {
  const incOnly = [...inc].filter((s) => !best.has(s));
  if (incOnly.length === 0) return false;
  if (incOnly.reduce((sum, s) => sum + shareOf(s, sampleStems), 0) / incOnly.length >= MINORITY_SUPPORT) return false;
  const wanted = [...best].filter((s) => !inc.has(s) && shareOf(s, sampleStems) >= SUBJECT_SUPPORT);
  if (wanted.length === 0) return false;
  const capitalised = new Map<string, number>();
  const lowered = new Set<string>();
  for (const member of sample) {
    const words = member.trim().slice(0, EVIDENCE_MAX_CHARS).split(/\s+/).slice(0, EVIDENCE_MAX_TOKENS);
    const counted = new Set<string>();
    for (let i = 0; i < words.length; i++) {
      const stem = stemOf(words[i]!);
      if (stem === "" || hasDigit(stem)) continue;
      const key = fold(stem).replace(/ /g, "").slice(0, STEM_LETTERS);
      const prev = i > 0 ? words[i - 1]! : "";
      const grammatical = i === 0 || [".", "!", "?", "…"].includes(prev.charAt(prev.length - 1));
      if (!startsUpper(stem)) lowered.add(key);
      else if (!grammatical && !counted.has(key)) {
        counted.add(key);
        capitalised.set(key, (capitalised.get(key) ?? 0) + 1);
      }
    }
  }
  return wanted.some((s) => (capitalised.get(s) ?? 0) >= SUBJECT_MIN_CAPITALISED && !lowered.has(s));
}

/**
 * Whether the stored title `inc` is itself the defect, judged against the best
 * member title `best` and the cluster's member titles: (1) a minority claim (it says
 * what few members say and omits the words most of them use), (2) a Title Case run
 * (TITLE_CASE_RUN capitalised words the others write in lower case) or (3) a missing
 * subject (a proper noun that SUBJECT_SUPPORT of the others say and only `best` has).
 * Rules (1) and (3) need DEFECT_MIN_SAMPLE other members. A `best` that is Title Case
 * itself changes nothing, so it is never a defect. True lowers the re-pick margin to
 * zero: the stored title still stays unless `best` outscores it. Pure; the copies of
 * `inc` and `best` among the members are not evidence.
 */
export function incumbentDefect(inc: string, best: string, memberTitles: readonly string[]): boolean {
  const incFold = fold(inc);
  const bestFold = fold(best);
  if (incFold === "" || bestFold === "" || incFold === bestFold) return false;
  const seen = new Set<string>();
  const sample: string[] = [];
  for (const raw of memberTitles) {
    const t = (raw ?? "").trim().slice(0, EVIDENCE_MAX_CHARS);
    if (t === "") continue;
    const key = fold(t);
    const cleaned = fold(cleanHeadline(t));
    if (key === incFold || cleaned === incFold || key === bestFold || cleaned === bestFold) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    sample.push(t);
  }
  if (sample.length < TITLE_CASE_MIN_SAMPLE) return false;
  const votes = caseVotes(sample);
  if (titleCaseRun(best, votes)) return false;
  if (titleCaseRun(inc, votes)) return true;
  if (sample.length < DEFECT_MIN_SAMPLE) return false;
  const sampleStems = sample.map(stemSet);
  const incStems = stemSet(inc);
  const bestStems = stemSet(best);
  return minorityClaim(incStems, bestStems, sampleStems) || missingSubject(incStems, bestStems, sample, sampleStems);
}

// ---------------------------------------------------------------------------
// The glued twin (extractive-v6, hunt 35, h35).
// ---------------------------------------------------------------------------
//
// A feed that loses a hyphen or a slash between two capitalised words glues them:
// "Tel Aviv-Washington" arrives as "Tel AvivWashington". The glued title and the
// correct one fold to different strings, so the duplicate rule keeps both, and the
// glued one can outscore its twin (its token 'avivwashington' is shared by nobody,
// yet in e02ef916 it won in all four member orders). A glued join is a lower-case
// letter directly followed by an upper-case one inside a word. Brands have them
// legitimately (YouTube, TikTok, WhatsApp, iPhone), which is why the join alone never
// decides anything: a swap needs a member title that is the same text with strictly
// fewer joins, and a brand appears in both twins.

/** A lower-case letter immediately followed by an upper-case one (Unicode, so 'ç' + 'Ö' counts). */
const GLUED_JOIN = /(?<=\p{Ll})\p{Lu}/gu;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]+/gu;

/**
 * Number of glued joins in a title: a lower-case letter directly followed by an upper-case
 * letter ("AvivWashington" has one, "Aviv-Washington", "TBMM'de" and "ABD" none). Brands
 * such as "YouTube" and "iPhone" count one each.
 */
export function gluedJoinCount(title: string): number {
  return title.match(GLUED_JOIN)?.length ?? 0;
}

// What two twins share: every letter and digit, in order and in the same case. The
// separators between them are the only difference. Case is kept on purpose: folding it
// would make "Youtube'da ..." and a shouted "YOUTUBE'DA ..." twins of "YouTube'da ..." and
// swap a correct brand spelling for a worse one. Digits are kept because 39 and 40 are
// different titles.
function twinKey(title: string): string {
  return title.replace(NOT_LETTER_OR_DIGIT, "");
}

/**
 * The glued-twin tiebreak: when `chosen` holds a glued join (see gluedJoinCount) and a
 * member title, cleaned, is the same text with strictly fewer joins (identical letters and
 * digits in the same case, only the separators differ) and passes isAcceptableNeutral, that
 * member's cleaned title is returned instead; of several, the one with the fewest joins, the
 * first in member order on a tie. Any other `chosen` is returned as passed, and a member
 * that is not a twin is never considered. Pure; the members are the cluster's raw titles.
 */
export function preferUnglued(chosen: string, memberTitles: readonly string[]): string {
  let bestJoins = gluedJoinCount(chosen);
  if (bestJoins === 0) return chosen;
  const key = twinKey(chosen);
  let best = chosen;
  for (let i = 0; i < memberTitles.length; i++) {
    const raw = (memberTitles[i] ?? "").trim();
    if (raw === "") continue;
    const cleaned = cleanHeadline(raw);
    const joins = gluedJoinCount(cleaned);
    if (joins >= bestJoins || twinKey(cleaned) !== key) continue;
    if (cleaned === "" || LEAD_IN.test(foldTr(cleaned))) continue;
    if (!isAcceptableNeutral(cleaned, memberTitles.filter((_, j) => j !== i))) continue;
    best = cleaned;
    bestJoins = joins;
  }
  return best;
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
 * text count once, the first occurrence standing. Whatever the result (a first pick, a floor pick, the
 * stored title a re-pick keeps), a glued word join in it gives way to a member title that is the same
 * text without the join (preferUnglued, h35).
 */
export function pickNeutralTitle(members: MemberTitle[], opts: PickOptions = {}): string | null {
  const picked = pickNeutralTitleCore(members, opts);
  if (picked === null) return null;
  return preferUnglued(picked, members.map((m) => m.title ?? ""));
}

// The pick itself (extractive-v1 to v6); pickNeutralTitle adds the glued-twin tiebreak on top.
function pickNeutralTitleCore(members: MemberTitle[], opts: PickOptions): string | null {
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
  const ctx: ScoreContext = {
    hedged:
      items.length >= HEDGED_MIN_MEMBERS &&
      items.filter((m) => carriesHedge(m.title)).length / items.length >= HEDGED_SHARE,
    qualified:
      items.length >= QUALIFIED_MIN_MEMBERS &&
      items.filter((m) => carriesQualifier(m.title)).length / items.length >= QUALIFIED_SHARE,
  };

  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < items.length; i++) {
    if (outliers.has(i)) continue;
    let sim = 0;
    for (let j = 0; j < items.length; j++) if (j !== i) sim += jaccard(toks[i]!, toks[j]!);
    const centrality = items.length > 1 ? sim / (items.length - 1) : 0;
    scored.push({ index: i, score: scoreTitle(items[i]!.title, centrality, ctx) });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  // How each member title writes its words, read once and only when a candidate
  // is reached (h27-copy-2). Sibling evidence comes from the cleaned titles, so
  // an outlet prefix or a "SON DAKİKA" lead-in is not mistaken for a name.
  let evidence: CaseEvidence[] | null = null;

  let best: { cleaned: string; score: number } | null = null;
  // The first-pick floor, best first: a statement with no hard defect, then a
  // question (or SEO explainer) with none (h34-reader-2: a question is never the
  // soft pick while any statement exists), then whatever ranked highest.
  let floorSoft: string | null = null;
  let floorQuestion: string | null = null;
  let floorAny: string | null = null;
  for (const { index, score } of scored) {
    const cleaned = cleanHeadline(items[index]!.title);
    // A lead-in that survived cleaning (an odd Unicode case) must not ship.
    if (cleaned === "" || LEAD_IN.test(foldTr(cleaned))) continue;
    const others = items.filter((_, j) => j !== index).map((m) => m.title);
    // A lower-case-sourced title gets its names back from the siblings; one
    // that still has a lower-case name it cannot restore ('berlinden') is not
    // eligible for a normal pick, but can still be a floor candidate.
    evidence ??= items.map((m) => caseEvidence(cleanHeadline(m.title.slice(0, EVIDENCE_MAX_CHARS))));
    const forms = capitalFormsFrom(evidence.filter((_, j) => j !== index));
    const oddOneOut = forms.size > 0 && isOddOneOut(forms, items[index]!.title, cleaned);
    const shown = oddOneOut ? recaseWith(forms, cleaned) : cleaned;
    if (!(oddOneOut && leaksWith(forms, shown)) && isAcceptableNeutral(shown, others)) {
      best = { cleaned: shown, score };
      break;
    }
    if (!opts.floor) continue;
    // Shouting is a hard defect, but a floor title is shown: sentence-case it
    // first, so "NEV'İN MİRASI GÜNDEM OLDU" ships as "Nev'in mirası gündem oldu".
    const floorTitle = isAllCaps(shown) ? sentenceCaseShout(shown, others) : shown;
    floorAny ??= floorTitle;
    if (floorSoft === null) {
      const question = isQuestionTitle(floorTitle);
      if (!(question && floorQuestion !== null) && !hasHardDefect(floorTitle, others, {})) {
        if (question) floorQuestion = floorTitle;
        else floorSoft = floorTitle;
      }
    }
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
      const incScore = scoreTitle(inc, n > 0 ? sim / n : 0, ctx);
      // A stored title that is itself the defect (a minority claim, Title Case, no
      // majority subject) gives way to any member title that outscores it at all.
      if (incumbentDefect(inc, best.cleaned, memberTitles)) return best.score > incScore ? best.cleaned : incumbent;
      const margin = inc.length >= FULL_LENGTH_TITLE_CHARS ? REPICK_MARGIN_FULL_LENGTH : REPICK_MARGIN;
      return best.score - incScore < margin ? incumbent : best.cleaned;
    }
  }

  return best?.cleaned ?? floorSoft ?? floorQuestion ?? floorAny;
}
