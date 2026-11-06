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

// extractive-v6 (hunt 42, h42-titles-1 and h42-titles-2; still extractive-v6, NO model bump).
// h42-titles-1: a stored title that no current member carries is not protected. An outlet edits a
// headline, migration 074 rewrites articles.title and never touches clusters.title_tr_neutral, and the
// incumbent branch only compared scores: 31fde7d7 kept a detention claim on a workplace death after both
// members read "...temizlik işçisi hayatını kaybetti". incumbentIsMemberTitle (case-, quote- and
// separator-blind; the recased, sentence-cased, quote-repaired, glued-twin and lead-in forms of a member
// title still count) is asked first, whether or not the stored title passes the gate (the stale set of
// migration 162 never looks at the gate, so a stored question or a surviving lead-in is stale too). A stale
// stored title that fails the gate gives way to the first pick with the floor, a member's own wording. One
// that passes the gate gives way to the best member wording in three steps (repickStale): the best member
// that passes the gate and is neither more loaded or framed than the stored title nor Title Case; else the
// best member that passes the gate; else the stored title itself, never a floor title that fails the gate.
// Migration 162 offers the clusters of the last 7 days of edits to the re-pick.
// h42-titles-2: the incumbent's 0.20 margin protected four kinds of stored title a fresh pick replaces.
// Lexicon: figurative 'darbe' ('ağır darbe', "Trump'a ara seçim darbesi"), 'istifa depremi', an unmarked
// 'tsunami', 'çöküyor', 'dehşet', price 'çakıldı', 'zehir zemberek', 'tarihi başarı' and FETÖ'cü are loaded,
// and 'şoku', 'skandalı', 'rezaleti', 'müjdesi' are framing; the hedge vocabulary gains the modal and
// forecast forms ('değişebilir', 'bekleniyor', 'muhtemel', 'olası', 'olmazsa', 'sinyal', 'düşünüyor'), as a
// SEPARATE wide set that only the hedge switch rule reads (carriesWideHedge).
// incumbentSwitchRule: a loaded, hedge-dropping, number-cutting or Title Case stored title gives way to the
// best member title with no margin, behind guards found by the replay below: no swap toward more
// framing, none to a Title Case title, the hedge / number / Title Case rules only to a title that restates
// the stored one (token overlap 0.1), the number rule only for a stored title that states a number and only
// when the best title restates every one of them, and the loaded rule only to a title at least as central
// as the stored one.
// Review fixes (h42 review of the first version, 2026-11-05): the 'X deprem' entry matches 'depremi' /
// 'depremler...' only; 'darbe' followed by 'sonrası', 'planı', 'davası', 'iddia...', 'kararı', 'teşebbüsü', or a
// physical blow (body part in the dative or ablative, 'darbe sonucu', 'darbe alan') is not figurative;
// 'çakıldı' is a price move only beside a market word; 'tsunami' with a toll ('ölü', 'yaralı') is the event;
// 'Müjdeci' is a surname; 'Butlan CHP'si', 'feci', 'kıskacı', 'gözyaşlarına boğul', 'tarihi karşılama' are loaded
// and 'acı haber', 'dikkat çekti', 'böyle görüntülendi' framing; 'COP31' / 'F-16' are names, not figures.
// A replay over the 3,884 clusters of the 14-day re-pick set changes 139 titles (3.58%; HEAD changed 12;
// the first version 158), and the model id stays: 1 of the 30 hand-reviewed entries is still worse (59bcbd7c,
// an idiom with a typo that no lexicon entry catches) and 84 rows of the set were still on a model older than
// v6. See neutral-title-replay.test.ts and __fixtures__/h42-*.json.

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
  new RegExp(`${L}(?:bomba|olay|dev|kritik)${R}`, "u"),
  // Case-suffixed forms (h42-titles-2): "Texas şoku", "Fon skandalı", "skandalında", "rezaleti" slipped
  // past the whole-word entry above. 'şok' / 'sok' take an explicit suffix list so 'sokak', 'sokağa' and
  // 'Sokolov' never match; 'skandal' and 'rezalet' take any letters ('skandalın', 'rezalete'), and so does
  // 'müjde' ("vize müjdesi", c85af1d5 in the 14-day replay: a Title Case swap landed on it), except
  // 'müjdeci' (a surname: "Yeniden Refah Partili Müjdeci'den Ömer Çelik'e yanıt"; review, correctness-2).
  // 'olay' and 'dev' keep the right edge above ('olayı', 'devlet' are ordinary words).
  new RegExp(`${L}(?:şok|sok)(?:u|a|ta|tan|un|unu|una|unda|undan|lar|ları)?${R}`, "u"),
  new RegExp(`${L}(?:skandal|rezalet)\\p{L}*`, "u"),
  new RegExp(`${L}(?:müjde|mujde)(?!c[iı])\\p{L}*`, "u"),
  /dikkat çeken|dikkat ceken|işte o|iste o|işte detaylar|iste detaylar|bakın|bakin/u,
  // A Haber / Sabah house style for the president.
  new RegExp(`${L}başkan erdoğan${R}`, "u"),
  // Wording the swap targets of the 14-day replay carried (h42 review, editorial-4): 'acı haber' (a
  // sentence-opening label), and the teaser verbs 'dikkat çekti' ("Kılıçdaroğlu detayı dikkat çekti") and
  // 'böyle görüntülendi' ("... obruk böyle görüntülendi").
  new RegExp(`${L}acı\\s+haber${R}`, "u"),
  /dikkat\s+çekti/u,
  /böyle\s+görüntülen/u,
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
  // Figurative disaster and verdict wording the incumbent protection kept (hunt 42, h42-titles-2).
  // 'istifa depremi' (020a0a63 "Ataşehir CHP'de istifa depremi"): only after the listed nouns, so
  // 'Marmara depremi' and 'Kahramanmaraş'ta 4.2 büyüklüğünde deprem' stay free. Only the possessive or the
  // plural ('depremi', 'depremler...') is the metaphor: a bare 'deprem' after the noun is the natural event
  // ("AK Parti deprem bölgesinde incelemelerde bulundu", "Borsa deprem sonrası sert düştü"; review, correctness-2).
  new RegExp(`${L}(?:istifa|seçim|siyaset|transfer|borsa|piyasa|ihraç|kabine|parti)\\s+deprem(?:i|ler)\\p{L}*`, "u"),
  // 'çöküyor' (671bc01e "İBB davası çöküyor"): the present tense verdict; 'bina çöktü' is reporting.
  new RegExp(`${L}çöküyor${R}`, "u"),
  // 'dehşet' with no right edge (29c38a16 family, "Afyonkarahisar'da dehşet", 'dehşete düşüren').
  new RegExp(`${L}dehşet`, "u"),
  // 'zehir zemberek' (a verdict on a statement) and 'tarihi başarı' (59bcbd7c "Arap partilerden tarihi
  // başarı"); 'tarihi karar' stays free.
  new RegExp(`${L}zehir\\s+zemberek`, "u"),
  new RegExp(`${L}tarihi\\s+başar[ıi]`, "u"),
  // The agent-noun suffix on FETÖ ("FETÖ'cü Enes"): a label for a person, where plain 'FETÖ' (an
  // organisation named by the prosecutors) stays free.
  new RegExp(`${L}fetö['’]?c[üu]`, "u"),
  // Wording the swap targets of the 14-day replay carried (h42 review, editorial-4). 'Butlan CHP'si' is a
  // partisan label for the party (the court term 'mutlak butlan' stays free); 'feci' and 'tarihi karşılama'
  // are the lexicon's 'korkunç' and 'görkemli' under other words; 'kıskacı' only as the possessive
  // ("rüşvet kıskacı"), so the military 'kıskaç hareketi' stays free; 'gözyaşlarına boğul' is the tear-jerker idiom.
  new RegExp(`(?<!mutlak\\s)${L}butlan\\s+chp`, "u"),
  new RegExp(`${L}feci${R}`, "u"),
  new RegExp(`${L}k[ıi]skac[ıi]${R}`, "u"),
  new RegExp(`${L}gözyaşlarına\\s+boğul`, "u"),
  new RegExp(`${L}tarihi\\s+karşılama`, "u"),
];

// Partisan epithets (hunt 54, h54-editorial-4). Seven multi-source titles of ten days carried them as the "neutral"
// headline (f771e177 "İşgalci İsrail'in koalisyon kabusu: ...", 96915d56 "Siyonist lobinin musluğu kesiliyor: ...",
// 4e89e31d "Katil Netanyahu seçim yenilgisini hazmedemedi", 7a26bbe9 "Soykırımcı Netanyahu'dan ...", 130a9e04
// "Soykırımcı İsrail ...") and, with no entry in LOADED_FOLDED, the h42 'loaded' incumbent switch (it needs
// loadedPenalty(inc) > 0) could never replace them. One unit per rule, like 'vurgun':
//   (a) 'işgalci' and 'siyonist', left edge only (işgalcinin, siyonistlerin), tested on the title with its quoted
//       spans removed, so an actor's own words stay free (b2d44624 "Eisenkot 'Siyonist askerlik hükümeti' ...",
//       6d7faa51 "''Siyonist çoğunluk ...''");
//   (b) an epithet in front of a name, 'Katil|Soykırımcı|İşgalci <Capital>' on the raw title (it needs the case) or
//       'katil|soykırımcı israil|netanyahu' on the folded one (shouted titles). Not quote-stripped, as the rule is
//       written: an epithet right after an opening quote is charged. 'Katil zanlısı', 'Eşini öldüren katil yakalandı'
//       and 'katile ağırlaştırılmış müebbet' have no capital name behind the word, and the Title Case spelling of the
//       suspect's label ('Katil Zanlısı', 'Katil Şüphelisi', 'Katil Sanığı') is excluded by name. In a Title Case
//       title (isTitleCaseTitle: nearly every word capitalised) the capital behind the word is the style, not a name
//       ('Eşini Öldüren Katil Yakalandı', 'Katil Koca Tutuklandı', 'Seri Katil Ted Bundy Belgeseli Yayında'), so the
//       raw rule is not applied there (correctness-4): such a title relies on the folded israil|netanyahu rule and
//       any other name behind the epithet is not charged;
//   (c) a figurative '<noun> kabusu' ("koalisyon kabusu", "seçim kabusu"), the possessive only: a noun directly in
//       front of it (the lookbehind keeps the scan linear: `\p{L}+\s+` would try every start of a long word).
// The noun 'soykırım' ('soykırım davası') and a bare 'işgal' are not charged. Where every member carries an epithet
// (4e89e31d) there is nothing clean to swap to and the stored title stays: the floor, as for any loaded cluster.
const EPITHET_UNQUOTED: RegExp[] = [
  new RegExp(`${L}[iı]şgalc[iı]`, "u"),
  new RegExp(`${L}s[iı]yon[iı]st`, "u"),
];
const EPITHET_BEFORE_NAME_RAW =
  /(?:^|[\s:"“])(?:Katil|Soykırımcı|İşgalci)\s+(?!Zanl|Şüphel|Sanık|Sanığ)\p{Lu}/u;
const EPITHET_BEFORE_NAME_FOLDED = new RegExp(`${L}(?:katil|soykır[ıi]mc[ıi])\\s+(?:israil|netanyahu)`, "u");
const NIGHTMARE_OF_NOUN = /(?<=\p{L})\s+kabusu(?!\p{L})/u;
/**
 * The raw epithet rule is skipped for a title isTitleCaseTitle reads as Title Case over at least this many words of
 * three letters or more: three, so that 'Katil Koca Tutuklandı' (all three words capitalised) is judged, while the
 * 80% share of isTitleCaseTitle keeps sentence-case headlines charged ('İşgalci İsrail'den El Halil'e askeri
 * takviye': 3 of 5 words capitalised; 'Katil Putin Ukrayna'ya saldırdı': 3 of 4).
 */
const EPITHET_TITLE_CASE_MIN_WORDS = 3;

/** Quote openers and the closer each one waits for. */
const QUOTE_CLOSERS: ReadonlyMap<string, string> = new Map([
  ["“", "”"],
  ['"', '"'],
  ["‘", "’"],
  ["'", "'"],
  ["«", "»"],
]);
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const WHITESPACE = /\s/u;

/**
 * A straight ' and a curly ’ are also the apostrophe of "İsrail'in" and "Gazze’de", so they only count as a quote
 * where a quote can stand: an opening ' follows a non-letter and hugs the word after it, a closing ' or ’ hugs the
 * word before it and is not followed by a letter. “ ” " ‘ « » always count.
 */
function canOpenQuote(t: string, at: number): boolean {
  const ch = t.charAt(at);
  if (ch !== "'") return true;
  const next = t.charAt(at + 1);
  return next !== "" && !WHITESPACE.test(next) && !LETTER_OR_DIGIT.test(t.charAt(at - 1) || " ");
}

function canCloseQuote(t: string, at: number): boolean {
  const ch = t.charAt(at);
  if (ch !== "'" && ch !== "’") return true;
  return !WHITESPACE.test(t.charAt(at - 1)) && !LETTER_OR_DIGIT.test(t.charAt(at + 1) || " ");
}

/**
 * The title with every matched quotation span (“ ”, " ", ‘ ’, ' ' and « », the marks included) replaced by one
 * space. A quote that never closes hides nothing. One pass: an opener that finds no closer is never searched for
 * again, so a hostile title of a million quotes costs a few scans, not a quadratic one.
 */
function withoutQuotedSpans(title: string): string {
  const exhausted = new Set<string>();
  const parts: string[] = [];
  let kept = 0;
  let i = 0;
  while (i < title.length) {
    const ch = title.charAt(i);
    const closer = QUOTE_CLOSERS.get(ch);
    if (closer !== undefined && !exhausted.has(ch) && canOpenQuote(title, i)) {
      let j = i + 1;
      while (j < title.length && !(title.charAt(j) === closer && canCloseQuote(title, j))) j++;
      if (j < title.length) {
        parts.push(title.slice(kept, i), " ");
        kept = j + 1;
        i = j + 1;
        continue;
      }
      exhausted.add(ch);
    }
    i++;
  }
  if (kept === 0) return title;
  parts.push(title.slice(kept));
  return parts.join("");
}

/** The h54-editorial-4 rules (a), (b) and (c): 0 to 4 units. `folded` is foldTr(title). */
function epithetPenalty(title: string, folded: string): number {
  let n = 0;
  let unquoted: string | null = null;
  for (const re of EPITHET_UNQUOTED) {
    if (!re.test(folded)) continue;
    unquoted ??= foldTr(withoutQuotedSpans(title));
    if (re.test(unquoted)) n++;
  }
  const rawEpithet = EPITHET_BEFORE_NAME_RAW.test(title) && !isTitleCaseTitle(title, EPITHET_TITLE_CASE_MIN_WORDS);
  if (rawEpithet || EPITHET_BEFORE_NAME_FOLDED.test(folded)) n++;
  if (NIGHTMARE_OF_NOUN.test(folded)) n++;
  return n;
}

// Figurative 'darbe' (hunt 42, h42-titles-2): "Netanyahu'ya Ağır Darbe" (29c38a16), "Trump'a ara seçim
// darbesi", "Netanyahu'ya kendi ülkesinden darbe" (5f761c9a). Two forms, both never before 'girişim' (a
// coup attempt is reporting): an intensifier or 'seçim' directly before it, or a name in the dative
// ("...'a" / "...'ya" / "...'e" / "...'ye") followed within three words by it, where those words are not
// 'askeri' or 'girişim'. 'askeri darbe', '15 Temmuz darbe girişimi' and 'darbe girişimi davası' stay free.
// The review (correctness-2) found the first version charging a coup REPORTED about, and a blow TAKEN:
//   - 'darbe' followed by 'sonrası', 'planı', 'davası', 'iddia...', 'kararı', 'teşebbüsü' is the coup as an
//     event ("Myanmar'a darbe sonrası yaptırım kararı", "Erdoğan'a yönelik darbe planı iddianamesi");
//   - an intensifier form followed by 'sonucu', 'alan', 'aldı', 'aldığı' or 'alarak' is a physical blow
//     ("Başına aldığı ağır darbe sonucu hayatını kaybetti"), and so is any title that names a body part in
//     the dative or ablative ("Kafasına sert darbe alan genç ...", "göğsüne", "boynuna", "vücuduna"). 'yüz'
//     takes the dative only: 'yüzünden' ("because of") is not a body part.
const NOT_COUP_ATTEMPT = String.raw`(?!\s+(?:giri[şs]im|sonras|plan|dava|iddia|karar|te[şs]ebb))`;
const NOT_BLOW_TAKEN = String.raw`(?!\s+(?:sonucu|alan|ald[ıi]|alarak))`;
const DARBE_INTENSIFIER = new RegExp(
  `${L}(?:ağır|büyük|sert|seçim|kendi\\s+ülkesinden)\\s+darbe\\p{L}*${R}${NOT_COUP_ATTEMPT}${NOT_BLOW_TAKEN}`,
  "u",
);
const DARBE_AFTER_NAME = new RegExp(
  `${L}\\p{L}+['’]y?[ae]${R}(?:\\s+(?!askeri|askerî|giri[şs]im)[\\p{L}\\p{N}]+){0,3}\\s+darbe(?:si)?${R}${NOT_COUP_ATTEMPT}`,
  "u",
);
const BLOW_ON_BODY = new RegExp(
  `${L}(?:baş|kafa|göğs|boyn|vücud)s?[ıiuü](?:na|ne|ndan|nden)${R}|${L}yüz[ıiuü]?(?:na|ne)${R}`,
  "u",
);

// 'tsunami' is loaded ("ABD'de sandık tsunamisi", 'mavi tsunami') unless the title also carries a
// literal marker of the natural event: uyarı, dalga, kıyı, büyüklüğünde, deprem, AFAD, Kandilli, or its
// toll ('ölü', 'yaralı', 'can kaybı', 'hayatını kaybetti': "Endonezya'da tsunami: 12 ölü"; review, editorial-5).
const TSUNAMI = new RegExp(`${L}tsunami`, "u");
const TSUNAMI_LITERAL =
  /uyar[ıi]|dalga|k[ıi]y[ıi]|büyüklüğ|deprem|afad|kandilli|ölü|yaral|can\s+kayb|hayat[ıi]n[ıi]\s+kaybet/u;

// 'çakıldı' about prices ("hisseleri çakıldı") is loaded. Anything that hit a wall, a tree or the ground is
// not: the review (correctness-2) found "Otomobil duvara çakıldı", "Tır markete çakıldı" and "Projenin ilk
// kazığı çakıldı" charged, so the verb only counts when the title also names a market (PRICE_MARKET) and the
// aircraft exemption of the first version is gone: nothing to exempt. 'çakıl' alone and 'çakıllı' are
// gravel, so a letter must follow the passive 'çakıl' and it must not be a second 'l'. The open stems take
// any suffix ('hisseleri', 'fiyatları'); 'kur', 'değer', 'euro' and 'altın' only their own, so 'kurum',
// 'değerli', 'Eurovision' and 'altında' (under) are not markets.
const PRICE_CRASH = new RegExp(`${L}çak[ıi]l(?!l)\\p{L}+`, "u");
const PRICE_MARKET = new RegExp(
  `${L}(?:hisse|borsa|b[iı]st|endeks|dolar|f[iı]yat|kr[iı]pto|b[iı]tco[iı]n|petrol|p[iı]yasa|fa[iı]z|tahv[iı]l)\\p{L}*|${L}(?:kur|değer|euro|altın)(?:u|i|ı|lar|ları|ler|leri|ın|in)?${R}`,
  "u",
);

// Words that attribute a claim instead of asserting it. Tested on foldTr(title). HEDGE is the allegation
// set of hunt 22 ('iddia', 'öne sürdü', 'ifade'); every scoring path reads it: carriesHedge, ctx.hedged and
// the hedge-loss term. HEDGE_WIDE adds the modal and forecast vocabulary of h42-titles-2: a stem plus
// -ebilir / -abilir / -ebilecek / -abilecek ("Fed'in faiz hesabı değişebilir"), and 'bekleniyor',
// 'muhtemel', 'olası', 'olmazsa', 'sinyal', 'düşünüyor' (8ea9e45f: two of three members hedge and the
// stored "Fed beklentilerini değiştirdi" asserted it). It drives ONLY incumbentSwitchRule's hedge branch:
// when the wide set fed the existing paths too, d5a6d9ab ("Yavuzyılmaz, ... zam yapılacağını öne sürdü",
// a stored title that attributes) turned into a defect and was traded for "gizli elektrik zammı
// uyarısı: ... zam gelebilir", losing the 2027 and 82-104 figures (h42 review, editorial-3).
const HEDGE_ALLEGATION = String.raw`${L}(?:iddia|öne\s+sürd|ifade)`;
const HEDGE = new RegExp(HEDGE_ALLEGATION, "u");
const HEDGE_WIDE = new RegExp(
  `${HEDGE_ALLEGATION}|\\p{L}[ae]bil(?:ir|ece)|${L}(?:bekleniyor|muhtemel|olas[ıi]|olmazsa|sinyal|düşünüyor)`,
  "u",
);

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

/** True when the title attributes what it says as an allegation (see HEDGE); exported for tests. Pure. */
export function carriesHedge(title: string): boolean {
  return HEDGE.test(foldTr(title));
}

/**
 * True when the title attributes or qualifies what it says in the wide vocabulary (HEDGE_WIDE: the allegation
 * words plus the modal and forecast ones). Only the hedge switch rule asks. Exported for tests. Pure.
 */
export function carriesWideHedge(title: string): boolean {
  return HEDGE_WIDE.test(foldTr(title));
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
  // A blow on a named body part is physical, whatever the intensifier (review, correctness-2).
  if (!BLOW_ON_BODY.test(folded)) {
    if (DARBE_INTENSIFIER.test(folded)) n++;
    if (DARBE_AFTER_NAME.test(folded)) n++;
  }
  if (TSUNAMI.test(folded) && !TSUNAMI_LITERAL.test(folded)) n++;
  if (PRICE_CRASH.test(folded) && PRICE_MARKET.test(folded)) n++;
  if (sequelTeaser(title)) n++;
  n += epithetPenalty(title, folded);
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

// The number, then an optional distributive suffix ("14'er", "10’ar", "5'şer", "3’şar") or an ordinal dot
// ("104. gün") that is read past, not as a part of it (h42-titles-2): "14'er yıl" says 14, "104." says 104.
const NUMBER = /(\d+(?:[.,]\d+)?)(?:['’](?:er|ar|şer|şar)(?![\p{L}\p{N}])|\.(?![\d]))?/gu;

/**
 * The numbers a title states, as strings: "91,1" and "91.1" are one number, and a distributive
 * ("14'er") or ordinal ("104.") suffix is not part of it. Exported for tests. Pure.
 */
export function numsOf(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(NUMBER)) out.add((m[1] ?? "").replace(",", "."));
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
   * missing incumbent changes nothing. A stored title that no member carries any more
   * (incumbentIsMemberTitle is false: the outlet edited it away) is not protected at
   * all, whether or not it passes the gate: see pickNeutralTitle.
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
 * The evidence the defect rules and the Title Case rule read: the deduplicated member titles minus
 * the copies of the stored title and of the best candidate. Empty when the two are the same text
 * or either folds to nothing (then nothing is judged).
 */
function defectSample(inc: string, best: string, memberTitles: readonly string[]): string[] {
  const incFold = fold(inc);
  const bestFold = fold(best);
  if (incFold === "" || bestFold === "" || incFold === bestFold) return [];
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
  return sample;
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
  const sample = defectSample(inc, best, memberTitles);
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
// The stored title gives way with no margin (hunt 42, h42-titles-2).
// ---------------------------------------------------------------------------
//
// The incumbent's 0.20 margin protects a good stored title from a lateral swap. It also protected four
// kinds of stored title that a fresh pick on the same members replaces, because the score does not see
// them (or sees them for a fraction of the margin): loaded wording the lexicon did not know ("Netanyahu'ya
// Ağır Darbe", "istifa depremi", "İBB davası çöküyor"), a dropped hedge (8ea9e45f: 2 of 3 members say
// 'bekleniyor' / 'değişebilir'; the stored "Fed beklentilerini değiştirdi" states it), a number cut short
// (2441793c: 4 of 6 members say '14 yıl 10 ay'; the stored "14'er yıl hapis talebi") and Title Case
// (6d0f5c12: incumbentDefect fired but the best title did not outscore it, and scoreTitle has no case
// term). Each of these returns the best member title outright; the best title has passed
// isAcceptableNeutral, so what the stored title is replaced with is always an acceptable member wording.

/** At least this many other member titles, and at least this share of them, must carry a number for its absence to count. */
const NUMBER_MIN_MEMBERS = 2;
const NUMBER_SHARE = 0.5;

// numsOf without the digits glued to letters: 'COP31', 'F-16' and 'R4' are names, not figures (d69feb0f counted
// COP31 as 31 and switched to the Bakan Çiftçi '26 bin personel' story). The lookbehind skips a digit run that
// follows a letter (with an optional hyphen), and a digit that follows a digit, so the second digit of 'COP31'
// is not read as a number of its own. numsOf itself stays as it is: first-pick scoring and numeralOutliers use it.
const STANDALONE_NUMBER = new RegExp(`(?<!\\p{L}-?)(?<!\\d)${NUMBER.source}`, "gu");

function standaloneNumsOf(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(STANDALONE_NUMBER)) out.add((m[1] ?? "").replace(",", "."));
  return out;
}

/**
 * The stored title states a number but lacks one that at least NUMBER_SHARE (and at least
 * NUMBER_MIN_MEMBERS) of the other member titles carry, and the best candidate carries it. `items` are
 * the deduplicated usable members; the copies of the stored title are not evidence about themselves.
 * The stored title has to state some number: "14'er yıl" (2441793c) cut the months, while a numberless
 * "Martı TAG davasında karar çıktı" is a style the replay showed no reason to swap (29 of the first 51
 * swaps of this rule had a numberless stored title, most of them lateral, three of them worse).
 */
function lacksMajorityNumber(inc: string, best: string, items: readonly MemberTitle[]): boolean {
  const incNums = standaloneNumsOf(inc);
  // A stored title that states no number at all omits them by style, it did not cut one: no mismatch to repair.
  if (incNums.size === 0) return false;
  const bestNums = numsOf(best);
  // The rule repairs a figure that was cut short and restated in full ("14'er yıl" -> "14 yıl 10 ay"), so every
  // figure the stored title states has to be restated by the best title too. A stored "1 milyon 83 bin 706 TL"
  // against a best title that says 'rekor ceza' was a fine figure dropped (5dec458d, 494bafc1).
  for (const n of incNums) if (!bestNums.has(n)) return false;
  const incFold = fold(inc);
  const others = items.filter((m) => fold(m.title) !== incFold && fold(cleanHeadline(m.title)) !== incFold);
  if (others.length < NUMBER_MIN_MEMBERS) return false;
  const counts = new Map<string, number>();
  for (const m of others) for (const n of numsOf(m.title)) counts.set(n, (counts.get(n) ?? 0) + 1);
  for (const [n, count] of counts) {
    if (count >= NUMBER_MIN_MEMBERS && count / others.length >= NUMBER_SHARE && !incNums.has(n) && bestNums.has(n)) {
      return true;
    }
  }
  return false;
}

/**
 * A whole-title Title Case needs at least this many words of three letters or more. Eight, not the four
 * caseEvidence uses: the 150-cluster corpus holds "112 Acil Çağrı ve Koordinasyon Genel Müdürlüğü kuruldu"
 * (an institution's name is capitalised on purpose: 5 of 6 words) and it must stay.
 */
const TITLE_CASE_TITLE_MIN_WORDS = 8;

/**
 * Whether almost every word of the title starts with a capital: at least TITLE_CASE_TITLE_MIN_WORDS words
 * of TITLE_CASE_MIN_LETTERS letters or more (digits and the bare number words left out), TITLE_CASE_SHARE
 * of them capitalised ("ABD Ara Seçimlerinde İlk Sonuçlar Belli Oldu: Senato Demokratlara Geçti"). The
 * same share caseEvidence uses to stop reading a sibling's capitals as names, here with a higher word
 * floor: a headline of two names and three common words is not Title Case. titleCaseRun is the other
 * detector: it needs the sample to write those words in lower case, which a Title Case title made of
 * words nobody else uses ('İlk', 'Sonuçlar', 'Belli', 'Oldu') never gets.
 */
export function isTitleCaseTitle(title: string, minWords: number = TITLE_CASE_TITLE_MIN_WORDS): boolean {
  let long = 0;
  let capitalised = 0;
  for (const token of title.trim().slice(0, EVIDENCE_MAX_CHARS).split(/\s+/).slice(0, EVIDENCE_MAX_TOKENS)) {
    const stem = stemOf(token);
    if (stem === "" || hasDigit(stem) || letterCount(stem) < TITLE_CASE_MIN_LETTERS) continue;
    long++;
    if (startsUpper(stem)) capitalised++;
  }
  return long >= minWords && capitalised / long >= TITLE_CASE_SHARE;
}

/**
 * The stored title is Title Case and the best candidate is not: a run of capitalised words the sample
 * writes in lower case (titleCaseRun, incumbentDefect's detector) or a title whose words are almost all
 * capitalised (isTitleCaseTitle). The sample is incumbentDefect's, and needs TITLE_CASE_MIN_SAMPLE titles.
 */
function titleCaseIncumbent(inc: string, best: string, memberTitles: readonly string[]): boolean {
  const sample = defectSample(inc, best, memberTitles);
  if (sample.length < TITLE_CASE_MIN_SAMPLE) return false;
  const votes = caseVotes(sample);
  const titleCase = (t: string): boolean => titleCaseRun(t, votes) || isTitleCaseTitle(t);
  return titleCase(inc) && !titleCase(best);
}

type SwitchRule = "loaded" | "hedge" | "number" | "titleCase";

/**
 * The hedge, number and Title Case rules repair a wording of the SAME story ("14'er yıl" for "14 yıl 10 ay"),
 * so the title they swap to has to restate the stored title: at least this token overlap (Jaccard over
 * tokens()). The 14-day replay showed the unguarded rules landing on a different angle of the day's news
 * (fd95db1f, an Israeli minister's denial, became a conference about the Mekke alliance; d6fefff8, a
 * grain-corridor quote, became a patriarchate visit). The loaded rule has no such floor: 5f761c9a's
 * "Netanyahu'ya kendi ülkesinden darbe" shares no word with the attributed title that replaces it.
 */
const SAME_STORY_MIN_OVERLAP = 0.1;
/** No swap lands on a title with this many words of three letters or more that is (almost) all capitals. */
const SWITCH_TARGET_TITLE_CASE_WORDS = 5;

/**
 * How many of the cluster's usable members carry the wide hedge vocabulary (HEDGE_WIDE), at least
 * HEDGED_MIN_MEMBERS of them in the cluster and HEDGED_SHARE of the cluster: the hedge switch rule's own
 * measure, apart from ScoreContext.hedged (the allegation set) that scoring uses.
 */
function hedgedWide(items: readonly MemberTitle[]): boolean {
  return (
    items.length >= HEDGED_MIN_MEMBERS &&
    items.filter((m) => carriesWideHedge(m.title)).length / items.length >= HEDGED_SHARE
  );
}

/**
 * Which h42-titles-2 rule makes the stored title `inc` give way to the best candidate `best` with no
 * margin, or null when none does: (1) the stored title is loaded and the best one is not and at least as
 * central as the stored one, (2) the cluster hedges in the wide vocabulary, the stored title does not and the
 * best one does, (3) the stored title lacks a number that half of the other members carry and the best one has
 * it, (4) the stored title is Title Case and the best one is not. Checked in that order; the first that holds
 * names the rule. No rule swaps to a title with more framing or to a Title Case title
 * (SWITCH_TARGET_TITLE_CASE_WORDS), and rules (2) to (4) need a best title that restates the stored one
 * (SAME_STORY_MIN_OVERLAP).
 *
 * The centrality guard of (1) (h42 review, editorial-6): ad76f79a's stored "...perde arkası" title is a member
 * and central (mean member overlap 0.194); the loaded rule swapped it for a title one member in six wrote
 * (0.130). `incCentrality` is the mean similarity the core computed for the stored title's score;
 * `bestCentrality` is the same mean for the best candidate, computed only when the loaded rule is reached.
 */
function incumbentSwitchRule(
  inc: string,
  best: string,
  items: readonly MemberTitle[],
  memberTitles: readonly string[],
  incCentrality: number,
  bestCentrality: () => number,
): SwitchRule | null {
  if (isTitleCaseTitle(best, SWITCH_TARGET_TITLE_CASE_WORDS)) return null;
  // No rule trades toward more framing: d1ed614b swapped "fon vurgunu tepkisi" for "olay çağrı" in the replay.
  if (framingPenalty(best) > framingPenalty(inc)) return null;
  if (loadedPenalty(inc) > 0 && loadedPenalty(best) === 0 && bestCentrality() >= incCentrality) return "loaded";
  if (jaccard(tokens(inc), tokens(best)) < SAME_STORY_MIN_OVERLAP) return null;
  if (hedgedWide(items) && !carriesWideHedge(inc) && carriesWideHedge(best)) return "hedge";
  if (lacksMajorityNumber(inc, best, items)) return "number";
  if (titleCaseIncumbent(inc, best, memberTitles)) return "titleCase";
  return null;
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

// ---------------------------------------------------------------------------
// A stored title that no current member carries (h42-titles-1).
// ---------------------------------------------------------------------------
//
// An outlet edits a headline and migration 074 (apply_article_title_edits) rewrites
// articles.title, but it never touches clusters.title_tr_neutral: 31fde7d7 kept "Denizli'de
// çöp kamyonu sürücüsü, sıkışan temizlikçinin ölümü üzerine gözaltına alındı" (a detention
// claim) while both members had been edited to "... temizlik işçisi hayatını kaybetti". The
// incumbent branch of the re-pick only compares scores, so a stored title that no member says
// any more was kept as a "good" title. A stored title is supposed to be a member's wording:
// this asks whether it still is, ignoring everything the picker itself changes (case, quotes,
// separators, a glued join, a lead-in).

/** Every character outside letters and digits, removed: the key ignores case, quotes and separators. */
const NOT_LETTER_OR_DIGIT_KEY = /[^\p{L}\p{N}]+/gu;

function memberKey(title: string): string {
  return title.toLocaleLowerCase("tr").replace(NOT_LETTER_OR_DIGIT_KEY, "");
}

// cleanHeadline's house-style rewrite as it stood before it learned to leave "Başkan Erdoğan Tosun" alone
// (a capitalised name after it is a different person): v1 to v5 titles stored "Cumhurbaşkanı Erdoğan
// Tokayev'i ..." from "Başkan Erdoğan Tokayev'i ...". Those stored titles are still a member's wording.
const LEGACY_HOUSE_STYLE = /(?<![\p{L}\p{N}])Başkan Erdoğan(?![\p{L}\p{N}])/gu;

/**
 * Whether the stored title `inc` is still some member's wording. True when a member title m has
 * key(cleanHeadline(m)) === key(inc) or key(m) contains key(inc), where key is the Turkish lower
 * case with every character outside letters and digits removed. That makes it blind to case,
 * separators and quotes, so a recased ("türkiye" -> "Türkiye"), sentence-cased (a shouted
 * member), quote-repaired or glued-twin ("Tel Aviv-Washington" against "Tel AvivWashington")
 * form of a member title still counts, and so does the cleaned form of a title with a lead-in,
 * an outlet prefix, and the "Başkan Erdoğan" -> "Cumhurbaşkanı Erdoğan" rewrite older cleaning rules
 * applied before a capitalised name. Pass ALL raw member titles, not the
 * generic-filtered list. A title with no letter or digit is not judged here (true): the
 * acceptance gate rejects it. No members: false. Each member is read up to
 * EVIDENCE_MAX_CHARS characters, so a hostile feed title costs a bounded scan. Pure.
 */
export function incumbentIsMemberTitle(inc: string, memberTitles: readonly string[]): boolean {
  const own = memberKey(inc);
  if (own === "") return true;
  for (const raw of memberTitles) {
    if (typeof raw !== "string") continue;
    const title = raw.trim().slice(0, EVIDENCE_MAX_CHARS);
    if (title === "") continue;
    if (memberKey(title).includes(own)) return true;
    if (memberKey(cleanHeadline(title)) === own) return true;
    if (title.includes("Başkan Erdoğan") && memberKey(title.replace(LEGACY_HOUSE_STYLE, "Cumhurbaşkanı Erdoğan")).includes(own)) {
      return true;
    }
  }
  return false;
}

/**
 * The member titles the pick works from: blank titles and placeholders ("Kısa haberler", a
 * live-blog lead-in) out, and a title that folds to the same text as an earlier one counted once.
 */
function usableItems(members: MemberTitle[]): MemberTitle[] {
  const seen = new Set<string>();
  return members
    .map((m) => ({ ...m, title: (m.title ?? "").trim() }))
    .filter((m) => m.title.length > 0 && !isGenericTitle(m.title))
    .filter((m) => {
      const key = fold(m.title);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * Whether the stored title is a candidate the gate accepts: it passes isAcceptableNeutral against the usable
 * member titles and no lead-in survives in it.
 */
function passesGate(inc: string, memberTitles: readonly string[]): boolean {
  return isAcceptableNeutral(inc, memberTitles) && !LEAD_IN.test(foldTr(inc));
}

/**
 * The pick for a stored title that no member carries any more (incumbentIsMemberTitle is false), staleness
 * being independent of the gate (h42 review, sec-db-1): migration 162's stale set never looks at it, so a
 * stored title that fails the gate (a question, a surviving lead-in) is stale too, and null would leave the
 * row in the set for 7 days.
 *   - The stored title fails the gate: the floor first pick of the members, a member's own wording.
 *   - It passes the gate (h42 review, editorial-1; member wording is still the contract, the quality guards
 *     only choose among members):
 *       1. the best member that passes the gate AND is no more loaded or framed than the stored title and
 *          not Title Case (without the floor);
 *       2. else the best member that passes the gate: a member's wording still beats a removed headline;
 *       3. else the stored title, as passed: no member passes the gate, and a floor title that fails it
 *          (a 193-character quote, a question) must not replace one that passes (fd5896d8). This and a
 *          stored title whose members give no usable title (null) are the residue: the row is re-offered
 *          and stamped on each tick until its old_title is 7 days old.
 * Null when there is no usable member title at all.
 */
function repickStale(members: MemberTitle[], opts: PickOptions, incumbent: string): string | null {
  const items = usableItems(members);
  if (items.length === 0) return null;
  const inc = incumbent.trim();
  const base: CoreOptions = { ...opts, incumbent: undefined };
  if (!passesGate(inc, items.map((m) => m.title))) return pickNeutralTitleCore(members, { ...base, floor: true });

  const incLoaded = loadedPenalty(inc);
  const incFraming = framingPenalty(inc);
  const guarded = pickNeutralTitleCore(members, {
    ...base,
    floor: false,
    accept: (shown) =>
      loadedPenalty(shown) <= incLoaded &&
      framingPenalty(shown) <= incFraming &&
      !isTitleCaseTitle(shown, SWITCH_TARGET_TITLE_CASE_WORDS),
  });
  if (guarded !== null) return guarded;
  return pickNeutralTitleCore(members, { ...base, floor: false }) ?? incumbent;
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
 * text count once, the first occurrence standing. A stored title that no member carries any more (the
 * outlet edited it away: incumbentIsMemberTitle, h42-titles-1) is not protected: the pick is a member's own
 * wording (repickStale), and the stored title only stays when no member passes the gate.
 * Whatever the result (a first pick, a floor pick, the stored title a re-pick keeps), a glued word join
 * in it gives way to a member title that is the same text without the join (preferUnglued, h35).
 */
export function pickNeutralTitle(members: MemberTitle[], opts: PickOptions = {}): string | null {
  const inc = opts.incumbent?.trim() ?? "";
  const stale = inc !== "" && !incumbentIsMemberTitle(inc, members.map((m) => m.title ?? ""));
  const picked = stale ? repickStale(members, opts, opts.incumbent as string) : pickNeutralTitleCore(members, opts);
  if (picked === null) return null;
  return preferUnglued(picked, members.map((m) => m.title ?? ""));
}

/** The pick's own options: PickOptions plus the member filter the stale re-pick passes (not part of the public type). */
interface CoreOptions extends PickOptions {
  /** Extra condition on a candidate's shown form, checked together with isAcceptableNeutral. */
  accept?: (shown: string) => boolean;
}

// The pick itself (extractive-v1 to v6); pickNeutralTitle adds the glued-twin tiebreak on top.
function pickNeutralTitleCore(members: MemberTitle[], opts: CoreOptions): string | null {
  const items = usableItems(members);
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
    if (
      !(oddOneOut && leaksWith(forms, shown)) &&
      isAcceptableNeutral(shown, others) &&
      (opts.accept === undefined || opts.accept(shown))
    ) {
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
      const incCentrality = n > 0 ? sim / n : 0;
      const incScore = scoreTitle(inc, incCentrality, ctx);
      // The best candidate's centrality, the same mean against the members that are not the candidate itself
      // (raw, cleaned or as shown): asked only by the loaded rule.
      const bestCentrality = (): number => {
        const bestFold = fold(best!.cleaned);
        const bestToks = tokens(best!.cleaned);
        let bsim = 0;
        let bn = 0;
        for (let j = 0; j < items.length; j++) {
          const t = items[j]!.title;
          const tf = fold(t);
          if (tf === bestFold || fold(cleanHeadline(t)) === bestFold) continue;
          bsim += jaccard(bestToks, toks[j]!);
          bn++;
        }
        return bn > 0 ? bsim / bn : 0;
      };
      // A loaded, hedge-dropping, number-cutting or Title Case stored title gives way with no margin (h42-titles-2).
      if (incumbentSwitchRule(inc, best.cleaned, items, memberTitles, incCentrality, bestCentrality) !== null) {
        return best.cleaned;
      }
      // A stored title that is itself the defect (a minority claim, Title Case, no
      // majority subject) gives way to any member title that outscores it at all.
      if (incumbentDefect(inc, best.cleaned, memberTitles)) return best.score > incScore ? best.cleaned : incumbent;
      const margin = inc.length >= FULL_LENGTH_TITLE_CHARS ? REPICK_MARGIN_FULL_LENGTH : REPICK_MARGIN;
      return best.score - incScore < margin ? incumbent : best.cleaned;
    }
  }

  return best?.cleaned ?? floorSoft ?? floorQuestion ?? floorAny;
}
