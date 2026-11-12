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

// h54-editorial-3 (still extractive-v6, NO model bump): an opinion column is not a candidate. 539e6666 was
// titled with a Hürriyet columnist's insult ("Utanmazlık abidesi Sarıgül, Özgür Özel’i tehdit mi etti", a
// /yazarlar/nedim-sener/ column) next to a Yeni Akit news rewrite of it. A MemberTitle whose article URL is
// an opinion path (`opinion`, set by the caller from isOpinionUrl: the headline cron does) is dropped from
// the pick, its centrality, its sibling evidence and the incumbent's "does a member carry it" test, as long
// as at least one non-opinion member with a usable title exists (`withoutOpinion`). A cluster that is
// columns and nothing else (4555a9bd) is picked as before. A stored title only a column carries is stale
// (repickStale), so a re-pick for any other reason replaces it; there is no backfill and no model bump, so a
// stored title is not re-offered because of this change alone. Readers that compute the first pick before
// the cron has written one (display-headline.ts) hold no article URLs and still pick over every title.

// h59-english-2 (still extractive-v6, NO model bump): a Turkish member is preferred over an English one. Eleven
// live mixed Turkish + English clusters (749b0eea: Daily Sabah's 'NATO chief visits Türkiye ahead of key summit'
// beside A Haber's Turkish headline) carry an English neutral title, because the picker saw titles only. A
// MemberTitle flagged `english` (the headline cron sets it from the source slug, ENGLISH_SOURCE_SLUGS) is dropped
// from the pick, its centrality, its sibling evidence and the incumbent's "does a member carry it" test, as long
// as at least one non-English member with a usable title exists (`withoutEnglish`, applied after `withoutOpinion`).
// An all-English cluster (fbb078b4) is picked as before; an English stored title in a mixed cluster is stale
// (repickStale), so a re-pick for any other reason replaces it. There is no backfill and no model bump, so the
// eleven stored English titles stay until a one-off re-pick. Readers that compute the first pick before the cron
// has written one (display-headline.ts) hold titles only and still pick over every title.

// h94-neutraltitles-2 and h94-neutraltitles-3 (hunt 95; still extractive-v6, NO model bump: new picks, and stored
// titles when they are re-offered).
// -2, attribution. A two-member cluster dropped what a sibling carried, because at n = 2 centrality is symmetric and
// the length term let the shorter, unlabelled restatement win: the hedge ('GKRY ... girişim yürüttüğü öne sürüldü',
// 'Emir Sarıgül'den Özgür Özel iddiası') and the speaker ('Sağlık Bakanı Memişoğlu: ...', 'Emine Erdoğan: ...').
//   1. HEDGE_ALLEGATION also reads the passive 'öne sürül...', 'ileri sürd... / sürül...' and the stem 'kulis'.
//   2. At exactly two deduplicated usable members one hedging member is enough for ctx.hedged (the narrow set only).
//   3. ATTRIBUTION_LOSS_PENALTY: a title that no label and no quote mark of its own attributes, which restates (same
//      folded text, or token overlap 0.8) what another member says behind a '<Label>:' pays 0.15.
//   4. cleanHeadline keeps the quotes around a first-person sentence ('... mücadelemizi sürdürüyoruz'): without them
//      the H1 speaks in the site's own voice.
//   5. UNATTRIBUTED_VOICE_PENALTY: a title that ends in such a form and has no ':' and no quote mark pays 0.12, and the
//      stored one gives way to a title that does not ('voice' switch rule).
// -3, case and quotes. The picker copied one outlet's sentence casing and stray single quotes into the H1 although a
// sibling had the clean form ('Bakan bak, Kktc başbakan yardımcısı ataoğlu ile görüştü'): a title-cased acronym ('Kktc',
// 'Tbmm') whose upper form a sibling writes is the odd one out and is recased from the siblings (titleCasedAcronym);
// a stored title with one, or one that opens with an unpaired single quote, gives way ('case' switch rule);
// cleanHeadline drops a leading ' or ‘ the title never closes; and preferUnglued also swaps a title for its member twin
// that differs only in quote marks and has fewer of them between no two letters.

// h164-titles-1 and h164-titles-2 (hunt 164; still extractive-v6, NO model bump: the v6 heal is running; new picks, and stored
// titles when they are re-offered).
// -1, content-free H1s. "MHP Lideri Bahçeli'den açıklamalar" and "Cumhurbaşkanı Erdoğan'dan açıklamalar" (27 and 22 members)
// were served as H1s, and teasers that ask without a '?' ("... YENİ Parti ile neden görüşmedi", "... oy oranı ne oldu",
// "Listede kimler var") were protected incumbents. isGenericTitle knows the placeholder (ABLATIVE_STATEMENT, on the whole title
// and after the last '. ' for an event label in front); isQuestionTitle knows the teasers (isQuestionTeaser), and so does the
// acceptance gate, so a stored teaser is not protected and a statement member wins; an all-teaser cluster is still answered
// by the first-pick floor. Migration 208 offers the stored titles these rules reject (no stamp condition).
// -2, lost capitals and a mispaired quote. İşçi Haber's machine-cased headlines ('libya ve venezuela', 'Bakan kurum',
// 'çöp31') reached the H1 because lowerCaseSourced only fires on a title that opens lower case. A MemberTitle flagged
// `caseUnreliable` (the headline cron sets it from the source slug, LOWERCASE_PRONE_SOURCE_SLUGS) is the odd one out when a
// sibling capitalises a word it writes in lower case, or writes in capitals a letters-and-digits code it writes in other
// letters, and is recased from the siblings (lenient evidence: a run bridged by 've' counts, and a capital that one of
// four or more other members writes alone is not enough); a stored title that is such a member's wording gives way when
// recasing would change it ('case' switch rule). cleanHeadline strips a wrapping quote pair only when nothing inside holds
// a mark of the opener's family between the edges, outside words ("'İmamoğlu ... örgütü' davası: 'Seçim ... mısın?'"
// keeps both pairs), and a title whose first single mark outside words closes before one opens fails the gate.
// h165 review of -1 and -2: the placeholder is the speaker's line behind a LABEL or a name, never behind a sentence (the
// head, the text in front of the line, has no finite verb, and a ':' makes the line a statement under a topic); 'neden ol-'
// (causative: "kazaya neden oldu") is no teaser and a clause ends at '!', '?' and a sentence break; 'hangi <word> ne' with a
// reported answer in the clause ("ne yapılacağını") is no teaser; and the 'case' rule keeps a stored title that a
// case-trusted outlet wrote with exactly that casing.

import { hasFiniteVerb } from "../articles/finite-verb";

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
  /**
   * The article is an opinion column (its URL path is an opinion path, isOpinionUrl in
   * src/lib/articles/opinion-url.ts). Such a member is not a candidate while a non-opinion
   * member with a usable title exists (`withoutOpinion`); a cluster of columns only is picked
   * as if none were flagged. Absent or false: a news article.
   */
  opinion?: boolean;
  /**
   * The article comes from one of the English-language outlets (ENGLISH_SOURCE_SLUGS in
   * src/lib/sources/source-language.ts; the headline cron derives it from the source slug). Such a
   * member is not a candidate while a non-English member with a usable title exists
   * (`withoutEnglish`); an all-English cluster is picked as if none were flagged. Absent or false:
   * a Turkish (or unknown) outlet.
   */
  english?: boolean;
  /**
   * The article comes from an outlet that publishes machine-cased headlines whose names lost their capitals
   * ('libya ve venezuela', 'Bakan kurum', 'çöp31' for COP31): LOWERCASE_PRONE_SOURCE_SLUGS in
   * src/lib/sources/source-language.ts, which the headline cron turns into this flag the way it sets `english`
   * (h164-titles-2). The title is still a candidate, but its lower-case words are not evidence (a sibling's capital
   * is not vetoed by it), and when a sibling capitalises a word it writes in lower case, or writes in capitals a
   * letters-and-digits code it writes in other letters ('çöp31' for 'COP31'), the title is the odd one out and is
   * recased from the siblings, whatever its first letter (the lenient evidence of caseEvidence: a run bridged by 've'
   * counts). A stored title that is such a member's wording gives way to the best candidate when recasing would change
   * it (caseDefectIncumbent). Absent or false: no change; a title-only caller (display-headline.ts) never sets it.
   */
  caseUnreliable?: boolean;
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

// 'şaibe' (h140-seo-1, bffb0a3f): the partisan label for the CHP congress case, "CHP'nin şaibeli kurultay davası 18 Kasım'a
// ertelendi". Left edge only, any suffix (şaibe, şaibeli, şaibesi), the dotless i and the plain s of a title typed without
// diacritics ('SAIBELI' folds to 'saıbelı'). The privative -siz/-sız is not the label: 'şaibesiz' ('free of irregularity',
// "Seçim şaibesiz tamamlandı"), 'şaibesizlik' and the undotted 'SAIBESIZ' ('saıbesız') say the opposite, so the lookahead
// refuses them (ts-3). It is listed in LOADED_FOLDED next to 'butlan CHP'si'; it is also in LOADED_OWN_WORDS_ONLY, which
// loadedPenalty reads.
const SAIBE_FOLDED = new RegExp(`${L}[şs]a[ıi]be(?!s[ıi]z)`, "u");

/**
 * The rules loadedPenalty tests on the headline's own words only: the text after a speaker label's opening quote
 * (SPEAKER_QUOTE_OPEN, "Özel: 'Şaibe iddiaları asılsız'") is someone's own wording and is cut off first. Every other rule
 * of LOADED_FOLDED is tested on the whole title, as before. A quote that is not a speaker's ("CHP'nin 'şaibeli kurultay'
 * davası", 'Dava ertelendi! CHP'deki “şaibeli kurultay” ...') is charged: an epithet right after an opening quote is
 * charged (h54 rule (b)). A bulletin lead-in ('Son dakika:', 'FLAŞ:', 'Şok:', chained) is not a speaker label: the quote
 * after it is the headline's own scare quote and is charged too (ts-1; see ownWordsFolded).
 */
const LOADED_OWN_WORDS_ONLY: ReadonlySet<RegExp> = new Set([SAIBE_FOLDED]);

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
  // 'şaibe' is the other partisan label of the same case (h140-seo-1: bffb0a3f served "CHP'nin şaibeli kurultay davası
  // 18 Kasım'a ertelendi", an Akşam headline Akşam later edited away, while Milliyet, Yeni Şafak, Posta and haberler-com
  // carry 'şaibeli kurultay' in scare quotes). Charged quoted or not; only a speaker's quote is exempt (see
  // LOADED_OWN_WORDS_ONLY), so "Özel: 'Şaibe iddiaları asılsız'" stays free.
  SAIBE_FOLDED,
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
// h94-neutraltitles-2 adds the passive and its synonym ('öne sürüldü', 'ileri sürdü / sürüldü': fa08b570's haberler-com
// title was read as unhedged) and the stem 'kulis' ('Kulislerde ...', 'kulislere göre': a report from the corridors, not a
// statement). 'sürgüne sürüldü' (banished) and 'Kulüp' (club) do not match: the first word of each phrase carries the left
// edge, and 'kulis' is not a prefix of 'kulüp'.
// 'iddianame' (indictment: 'iddianamesiz tutuklu') and 'ifade özgürlüğü' (freedom of expression) are not hedges, and
// since the n = 2 rule (HEDGED_PAIR_SIZE) a single member carrying either decides the pair, so they are carved out of
// 'iddia' and 'ifade' (h95 review, correctness-2). 'ifade' as testimony ('tanık ifadesi', 'ifade verdi') attributes
// by design and stays; so does 'kulis' in every sense a headline uses it (the corridor rumour).
const HEDGE_ALLEGATION = String.raw`${L}(?:iddia(?!n[aâ]me)|öne\s+sürd|öne\s+sürül|ileri\s+sür(?:d|ül)|kulis|ifade(?!\s+özgürl))`;
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
/**
 * At exactly this many deduplicated usable members one hedging member is enough for ctx.hedged (h94-neutraltitles-2).
 * A pair has no majority to wait for: fa08b570 and 50571fc6 each had one member that attributed and one that asserted,
 * and the share rule (three members) never fired. The narrow set only: the wide one stays out of scoring.
 */
const HEDGED_PAIR_SIZE = 2;

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

/**
 * `folded` up to the first speaker label's opening quote (SPEAKER_QUOTE_OPEN: "<speaker>: '", with ", “, ‘ or « too): what
 * follows is the speaker's own wording. The whole text when there is no such quote. Leading bulletin lead-ins ('Son dakika:',
 * 'FLAŞ:', 'Şok:', chained, the same LEAD_IN / LEAD_IN_PASSES stripLeadIns uses) are skipped first: they are a label for the
 * bulletin, not a speaker, so "Son dakika: 'Şaibeli kurultay' davası ..." keeps its scare quote in the headline's own words
 * (ts-1). scoreTitle is handed the raw member title, lead-in included. A bounded number of anchored matches, then one scan.
 * LEAD_IN and LEAD_IN_PASSES are declared below; that is fine, the function runs only at call time.
 */
function ownWordsFolded(folded: string): string {
  let from = 0;
  for (let pass = 0; pass < LEAD_IN_PASSES; pass++) {
    const lead = LEAD_IN.exec(folded.slice(from));
    if (!lead || lead[0].length === 0) break;
    from += lead[0].length;
  }
  const quote = SPEAKER_QUOTE_OPEN.exec(folded.slice(from));
  return quote ? folded.slice(0, from + quote.index) : folded;
}

/** Number of loaded-wording rules the title trips (0.25 each in scoreTitle). */
export function loadedPenalty(title: string): number {
  const folded = foldTr(title);
  let n = 0;
  let own: string | null = null;
  for (const re of LOADED_FOLDED) {
    if (!re.test(folded)) continue;
    if (LOADED_OWN_WORDS_ONLY.has(re)) {
      own ??= ownWordsFolded(folded);
      if (!re.test(own)) continue;
    }
    n++;
  }
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

// ---------------------------------------------------------------------------
// First-person voice and stray single quotes (h94-neutraltitles-2 and -3).
// ---------------------------------------------------------------------------

// The endings of a sentence in the first person, or an imperative to the reader, tested on the Turkish-lower-cased text
// with trailing punctuation and quotes read past: '-iyoruz', '-iyorum' (with the ı / u / ü vowels), '-acağız',
// '-eceğiz', '-acağım', '-eceğim', and the whole words 'olun' and 'edin' (the left edge keeps 'yolun', 'kolun' and the
// name 'Edin' out). A headline that speaks like this with no speaker named ("mücadelemizi sürdürüyoruz") is read as the
// site's own voice.
const FIRST_PERSON_ENDING = new RegExp(
  `(?:[iıuü]yor(?:uz|um)|[ae]ca[gğ][ıi][zm]|[ae]ce[gğ]i[zm]|${L}(?:olun|edin))$`,
  "u",
);
/** Only the last characters of a title are tested: the longest ending is six letters and the one before it a word edge. */
const FIRST_PERSON_TAIL_CHARS = 16;
const VOICE_TRAILING_NOISE: ReadonlySet<string> = new Set([
  ".", ",", ";", ":", "!", "?", "…", "-", "–", "—", '"', "'", "“", "”", "‘", "’", "«", "»", "(", ")", "[", "]",
]);

/**
 * Whether the text ends in a first-person form or an imperative (FIRST_PERSON_ENDING), with trailing punctuation and
 * quote marks read past. A right-to-left scan of the noise and a bounded tail, so a long title costs a pass, not a
 * regular expression over it.
 */
function endsInFirstPerson(text: string): boolean {
  let end = text.length;
  while (end > 0) {
    const ch = text.charAt(end - 1);
    if (!VOICE_TRAILING_NOISE.has(ch) && !/\s/.test(ch)) break;
    end--;
  }
  if (end === 0) return false;
  return FIRST_PERSON_ENDING.test(foldTr(text.slice(Math.max(0, end - FIRST_PERSON_TAIL_CHARS), end)));
}

const SINGLE_QUOTE_MARKS: ReadonlySet<string> = new Set(["'", "‘", "’"]);
/** The double marks: " “ ”. */
const DOUBLE_QUOTE_MARKS: ReadonlySet<string> = new Set(['"', "“", "”"]);
/** Every mark the quote twin ignores: ' ‘ ’ " “ ”. */
const TWIN_QUOTE_MARKS: ReadonlySet<string> = new Set(["'", "‘", "’", '"', "“", "”"]);

function isWordCharAt(t: string, at: number): boolean {
  return at >= 0 && at < t.length && WORD_CHAR.test(t.charAt(at));
}

/**
 * How many of `marks` sit between no two letters or digits. A mark inside a word ("Kılıçdaroğlu’ndan", "Özel'e",
 * "10'luk") is the apostrophe of a suffix and not a quotation; one at a word edge opens or closes a quote. One pass.
 */
function marksOutsideWords(t: string, marks: ReadonlySet<string>): number {
  let n = 0;
  for (let i = 0; i < t.length; i++) {
    if (!marks.has(t.charAt(i))) continue;
    if (isWordCharAt(t, i - 1) && isWordCharAt(t, i + 1)) continue;
    n++;
  }
  return n;
}

/**
 * Drops a leading ' or ‘ when the title's single-quote marks that sit between no two letters are odd in number: the
 * quote opens and nothing closes it (59a68086: "'Kaşif Kozinoğlu'nun ATK raporu ...: 'Ölüm nedeni' açıklandı", what
 * is left after cumhuriyet's "Son Dakika..." lead-in goes). A closed lead quote ("'Ölüm nedeni' açıklandı") has an even
 * count and stays. Pure; the title is cleaned otherwise.
 */
function dropStrayLeadingQuote(t: string): string {
  return hasStrayLeadingQuote(t) ? t.slice(1) : t;
}

/** The title opens with ' or ‘ and its single-quote marks outside words are odd in number (see dropStrayLeadingQuote). */
function hasStrayLeadingQuote(t: string): boolean {
  const first = t.charAt(0);
  if (first !== "'" && first !== "‘") return false;
  return marksOutsideWords(t, SINGLE_QUOTE_MARKS) % 2 === 1;
}

/** The quotes cleanHeadline strips from around a whole headline. */
const WRAPPING_QUOTES = /^["'“‘](.+)["'”’]$/;
/** The closing mark that pairs with each opening mark WRAPPING_QUOTES accepts. */
const WRAPPING_CLOSE: Readonly<Record<string, string>> = { '"': '"', "'": "'", "“": "”", "‘": "’" };
/** The marks of the opener's family: a ' or ‘ opens a span closed by ' or ’, a " or “ one closed by " or ”. */
const WRAPPING_FAMILY: Readonly<Record<string, ReadonlySet<string>>> = {
  "'": SINGLE_QUOTE_MARKS,
  "‘": SINGLE_QUOTE_MARKS,
  '"': DOUBLE_QUOTE_MARKS,
  "“": DOUBLE_QUOTE_MARKS,
};

/**
 * Whether the text inside a wrapping pair holds a mark of the opener's family between its two edges, outside words: the
 * outer pair is then the opener of one span and the closer of another, not a pair of its own (h164-titles-2). The first
 * and the last character of the inner text are not counted: a doubled wrap (two apostrophes each side, one outlet's
 * style, so the inner text is itself "'X'") is one span quoted twice and is stripped once, as before. One pass.
 */
function holdsInnerPair(inner: string, family: ReadonlySet<string>): boolean {
  for (let i = 1; i < inner.length - 1; i++) {
    if (family.has(inner.charAt(i)) && !(isWordCharAt(inner, i - 1) && isWordCharAt(inner, i + 1))) return true;
  }
  return false;
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
  // Wrapping quotes around the whole headline, unless it is a first-person sentence: a quote that loses its quotes
  // speaks in the site's own voice ('"... mücadelemizi sürdürüyoruz"', h94-neutraltitles-2). A matched pair stays as
  // written. A mismatched one ('"..."' opened straight and closed curly, h95 review correctness-1) is rewritten as “…”:
  // kept as written it leaves a dangling mark that the unbalanced-quote gate rejects, so the attribution is lost anyway.
  // The outer pair is a pair only when nothing inside holds a mark of the opener's family outside a word: a title that
  // opens with one quoted span and ends with another ("'İmamoğlu çıkar amaçlı suç örgütü' davası: 'Seçim vaadimiz var
  // kreş yapar mısın?'", h164-titles-2) has its first and last mark as the opener of the first span and the closer of
  // the last, and stripping them left a title that closed a quote it never opened. It stays as written.
  t = t.replace(WRAPPING_QUOTES, (whole: string, inner: string) => {
    if (holdsInnerPair(inner, WRAPPING_FAMILY[whole.charAt(0)] ?? SINGLE_QUOTE_MARKS)) return whole;
    if (!endsInFirstPerson(inner)) return inner;
    return WRAPPING_CLOSE[whole.charAt(0)] === whole.charAt(whole.length - 1) ? whole : `“${inner}”`;
  });
  // A lead quote nothing closes (h94-neutraltitles-3).
  t = dropStrayLeadingQuote(t);
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t.length > 0) t = t[0]!.toLocaleUpperCase("tr") + t.slice(1);
  return t;
}

// "<name or title>'den açıklamalar" (h164-titles-1): the headline of a live speech that names the speaker and nothing
// they said ("MHP Lideri Bahçeli'den açıklamalar", "Cumhurbaşkanı Erdoğan'dan önemli açıklamalar", "Bakanlıktan
// açıklama"). On folded text (single spaces, the apostrophe a space): one to six name or title tokens, the ablative (a
// token of its own after the apostrophe, 'dan|den|tan|ten|ndan|nden', or glued to the last token), then optionally one
// of 'önemli', 'son dakika', 'yeni', 'kritik', then 'açıklama', 'açıklamalar' or 'mesajlar' as the WHOLE rest of the
// title. Anchored at the start, and every repeat is bounded (a token is at most 40 characters, at most six of them), so
// the match costs a constant however long the title is. The pattern alone is no verdict (ablativeStatement is): it also
// reads the text after the last '. ' of the cleaned title, so an event label in front is allowed ("COP31 Zirvesi. Bakan
// Kurum'dan açıklamalar"), and it refuses a head that is a sentence (h165 review: "Azil süreci başladı! Trump'tan
// açıklama" says what happened) or a topic with a ':' ("Hürmüz Boğazı'nda tanker olayı: UKMTO'dan açıklama").
// migrations/208 mirrors this verdict in SQL over tayf_search_fold as a SUBSET of it; keep the two in step.
const ABLATIVE_STATEMENT =
  /^(?:[a-z0-9]{1,40} ){0,5}(?:[a-z0-9]{1,40} (?:dan|den|tan|ten|ndan|nden)|[a-z0-9]{1,40}(?:dan|den|tan|ten)) (?:(?:onemli|son dakika|yeni|kritik) )?(?:aciklama(?:lar)?|mesajlar)$/;

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

// The words that close an ablative statement (the optional adjective and the placeholder word), folded.
const ABLATIVE_TAIL_WORDS: ReadonlySet<string> = new Set([
  "aciklama", "aciklamalar", "mesajlar", "onemli", "yeni", "kritik", "son", "dakika",
]);

/**
 * The words in front of the word that carries the ablative ("Bahçeli'den", "Bakanlıktan"), as one text: the cleaned title
 * minus its closing placeholder words and that word. Only read for a title ABLATIVE_STATEMENT has matched, so it holds a
 * handful of words; the speaker's own earlier words ("MHP Lideri") are capitalised, which hasFiniteVerb takes for names.
 */
function wordsBeforeAblative(cleanedText: string): string {
  const words = cleanedText.split(/\s+/);
  let end = words.length;
  while (end > 1 && ABLATIVE_TAIL_WORDS.has(fold(words[end - 1]!))) end--;
  return words.slice(0, Math.max(end - 1, 0)).join(" ");
}

/**
 * "<name or title>'den açıklamalar" as the verdict of h164-titles-1, narrowed by its review (h165): the speaker's line stands
 * behind a label or a name, never behind a sentence. (1) The last break of the cleaned title is a ':' (after the last '. '):
 * the line is a statement under a topic ("Hürmüz Boğazı'nda tanker olayı: UKMTO'dan açıklama"), not a placeholder. (2) There is
 * a '. ' (the outlet's '!' is one after cleanHeadline): the text after the last one must match ABLATIVE_STATEMENT and the text
 * before it, the head, must hold no finite verb ("COP31 Zirvesi. Bakan Kurum'dan açıklamalar" is a placeholder, "Azil süreci
 * başladı. Trump'tan açıklama" says what happened). (3) No break: the whole title must match and the words in front of the
 * ablative word hold no finite verb. isGenericTitle and isAblativeStatementTitle both read this one verdict.
 */
function ablativeStatement(cleanedText: string): boolean {
  const dot = cleanedText.lastIndexOf(". ");
  if (cleanedText.lastIndexOf(":") > dot) return false;
  if (dot >= 0) {
    return ABLATIVE_STATEMENT.test(fold(cleanedText.slice(dot + 2))) && !hasFiniteVerb(cleanedText.slice(0, dot));
  }
  return ABLATIVE_STATEMENT.test(fold(cleanedText)) && !hasFiniteVerb(wordsBeforeAblative(cleanedText));
}

/**
 * Whether the cleaned headline is "<name or title>'den açıklamalar" (h164-titles-1, narrowed by h165): the speaker's line
 * behind a label or a name (ablativeStatement). The one part of isGenericTitle that migration 208 mirrors in SQL, exported so
 * a test can hold the SQL pattern against exactly this verdict. Pure.
 */
export function isAblativeStatementTitle(title: string): boolean {
  return ablativeStatement(cleanHeadline(title));
}

/**
 * True for a headline that is a content-free placeholder (a news-bulletin
 * label, a live-blog lead-in, "<person> konuşuyor", "<person>'den açıklamalar")
 * rather than a description of an event. Deliberately no minimum length or token count: short real
 * headlines ("İstanbul'da deprem oldu") must stay eligible.
 */
export function isGenericTitle(title: string): boolean {
  const cleanedText = cleanHeadline(title);
  const cleaned = fold(cleanedText);
  if (cleaned === "" || GENERIC_CLEANED.some((re) => re.test(cleaned))) return true;
  // The speaker's line behind a label or a name, alone or behind an event label ("111. Dönem Kaymakamlar Kurası Töreni.
  // Cumhurbaşkanı Erdoğan'dan önemli açıklamalar"), never behind a sentence (h164-titles-1, h165).
  if (ablativeStatement(cleanedText)) return true;
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

// Whether a single quote closes before anything opened it and a quote opens after that (h164-titles-2): the title's marks
// outside words run closer, then opener, so the real opener was lost. "İmamoğlu ... örgütü' davası: 'Seçim vaadimiz var"
// lost the ' that opened its first span. A lone closer with no opener after it ("... yarın geliyor’") is still accepted
// (the h32 pin: single quotes are never counted as unbalanced). A mark between two letters or digits is the apostrophe of
// a suffix. A ‘ opens; a ’ closes when a word hugs it on the left (a ’ with none, "’90'lı", is an elision); a straight '
// closes when a word hugs it on the left and none on the right, and opens when none hugs it on the left and a word on the
// right. One pass, no regular expression.
function closesUnopenedSingleQuote(t: string): boolean {
  let open = 0;
  let unopenedCloser = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t.charAt(i);
    if (!SINGLE_QUOTE_MARKS.has(ch)) continue;
    const left = isWordCharAt(t, i - 1);
    const right = isWordCharAt(t, i + 1);
    if (left && right) continue;
    if (ch === "‘" || (ch === "'" && !left && right)) {
      if (unopenedCloser) return true;
      open++;
    } else if ((ch === "’" && left) || (ch === "'" && left && !right)) {
      if (open === 0) unopenedCloser = true;
      else open--;
    }
  }
  return false;
}

// Defects a first-pick floor does not forgive: shouting (all of it, or a run of
// shouted words), a residual '|', unbalanced double quotes, a single quote that
// closes before one opens, a placeholder, an English headline, a feed cut. A question, a leading "İşte" or an odd length
// are only less good than the cleaned text of a title nobody has cleaned yet.
function hasHardDefect(t: string, memberTitles: readonly string[], opts: AcceptOptions): boolean {
  if (/\p{L}/u.test(t) && t === t.toLocaleUpperCase("tr")) return true;
  // An outlet prefix that cleanHeadline could not strip (longer than 25
  // characters) or a separator inside the text: "... SALI |GEDİZ UYARDI: ...".
  if (/[|│]/.test(t)) return true;
  // A feed cut that opens a double quote it never closes: 'X: "Kaybedersek ...'.
  if (unbalancedDoubleQuotes(t)) return true;
  // The same for a single quote that closes before one opens: "İmamoğlu ... örgütü' davası: 'Seçim ..." (h164-titles-2).
  if (closesUnopenedSingleQuote(t)) return true;
  if (hasShoutedRun(t)) return true;
  // A bulletin label in the middle of the title (the lead-in is cleanHeadline's).
  if (MID_SON_DAKIKA.test(foldTr(t))) return true;
  if (isGenericTitle(t)) return true;
  if (looksEnglish(t)) return true;
  if (!opts.generated && looksTruncated(t, memberTitles)) return true;
  return false;
}

/**
 * Whether a candidate neutral headline may be shown. Rejects a question (a '?' or a
 * teaser, isQuestionTeaser), a leading "İşte", shouting, a title that is too short or too long, a generic
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
  // A teaser asks without the '?' (h164-titles-1): the gate keeps it out, so a stored one is not protected and a
  // statement member wins; an all-teaser cluster is still answered by the first-pick floor.
  if (isQuestionTeaser(t)) return false;
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

// The teasers (h164-titles-1): a headline that asks and withholds the answer without a '?' ("Tera'nın patronu Emre
// Tezmen YENİ Parti ile neden görüşmedi" while four members say he refused; "... oy oranı ne oldu: Birinci sıra dikkat
// çekti"; "...: Listede kimler var"). Three whole-word phrases anywhere in the folded own words, and three patterns that
// are tested on each clause (the own words split at ':', every clause folded: single spaces, the apostrophe a space):
//   - 'kimler var' ending the clause (end of the title or before ':'): "Listede kimler var", not "O listede kimler var
//     açıkladı", where somebody says who is on it;
//   - 'hangi <word> ne' ("Hangi parti ne oy verdi");
//   - 'neden', up to four words, then a negative past ending in -madı, -medi, -madu or -medü (folded: m[ae]d[iu]) that
//     ends the clause ("... Parti ile neden görüşmedi"): a verb of any other shape ("neden yapıldığını anlattı", "neden
//     böldüğünü sordu") reports an answer, and 'neden ol-' ("kazaya neden olan sürücü tutuklanmadı", causative: the cause
//     of something) is no question at all.
// A clause ends at ':', '!', '?' and at a sentence break ('. ' or the end), so a pattern cannot run into the next sentence.
// A clause 'hangi <word> ne' that also holds a nominalised reported answer ("Bakan Tekin hangi ilde ne yapılacağını
// açıkladı": a word ending -dığını, -tığını, -acağını, -eceğini ...) answers its own question and is no teaser.
// Every repeat is bounded or runs over disjoint classes, so a hostile title costs a scan. migrations/208 mirrors the
// phrases and the three patterns in SQL over tayf_search_fold; keep the two in step.
const TEASER_PHRASES: readonly string[] = ["ne oldu", "neler oldu", "neler var"];
const KIMLER_VAR_END = /(?:^| )kimler var$/;
const HANGI_NE = /(?:^| )hangi [a-z0-9]{1,40} ne(?: |$)/;
const REPORTED_ANSWER = /(?:^| )[a-z0-9]{0,40}(?:d[iu]g|t[iu]g|[ae]c[ae]g)[iu]n[iu](?: |$)/;
const NEDEN_NEGATIVE = /(?:^| )neden(?! ol)(?: [a-z0-9]{1,40}){0,4} [a-z0-9]{0,40}m[ae]d[iu]$/;
const CLAUSE_BREAK = /:|[!?]|\.\s/;

/** The headline's own words: the first QUESTION_SCAN_MAX_CHARS characters up to a speaker's opening quote. */
function ownHeadlineWords(title: string): string {
  const head = title.slice(0, QUESTION_SCAN_MAX_CHARS);
  const quote = SPEAKER_QUOTE_OPEN.exec(head);
  return quote ? head.slice(0, quote.index) : head;
}

function holdsTeaser(own: string): boolean {
  const padded = ` ${fold(own)} `;
  if (TEASER_PHRASES.some((phrase) => padded.includes(` ${phrase} `))) return true;
  for (const clause of own.split(CLAUSE_BREAK)) {
    const folded = fold(clause);
    if (KIMLER_VAR_END.test(folded) || NEDEN_NEGATIVE.test(folded)) return true;
    if (HANGI_NE.test(folded) && !REPORTED_ANSWER.test(folded)) return true;
  }
  return false;
}

/**
 * Whether a headline is a teaser (h164-titles-1): it asks and withholds the answer without a '?'. 'ne oldu', 'neler
 * oldu' and 'neler var' anywhere as whole words; 'kimler var' at the end of a clause; a clause 'hangi <word> ne' that holds no
 * nominalised reported answer; a clause that ends 'neden <up to four words> <negative past>' ('neden ol-' is no teaser).
 * A clause ends at ':', '!', '?' and a sentence break. Folded, so 'Ne Oldu' counts; a speaker's quote after
 * "<speaker>: '" is left out, as in isQuestionTitle. isAcceptableNeutral rejects it. Pure; false for a missing or
 * non-string title.
 */
export function isQuestionTeaser(title: string): boolean {
  if (typeof title !== "string" || title === "") return false;
  return holdsTeaser(ownHeadlineWords(title));
}

/**
 * Whether a headline is a question or an SEO explainer: it holds a '?', or one of
 * 'kimdir', 'kaç yaşında', 'nereli', 'ne zaman', 'oldu mu', 'kim elendi' as whole
 * words (Turkish-folded, so 'KİMDİR' and 'Kaç Yaşında' count), or it is a teaser
 * that asks without a '?' (isQuestionTeaser: 'ne oldu', 'neler oldu', 'neler var',
 * a clause that ends 'kimler var', 'hangi <word> ne' or 'neden ... <negative past>').
 * Two clusters of
 * explainers ("Saniye Caran kimdir? ... kaç yaşında, nereli?") used to ship as the
 * floor pick of a first pick and to be served index,follow (h34-reader-2). The first-pick
 * floor ranks such a title last and the cluster page keeps it out of the index (so a served
 * teaser is kept out of the index too, which is intended).
 * Only the headline's own words count: a speaker's quote after "<speaker>: '" is left
 * out, so a quoted question stays an ordinary headline.
 * Pure; false for a missing or non-string title.
 */
export function isQuestionTitle(title: string): boolean {
  if (typeof title !== "string" || title === "") return false;
  const own = ownHeadlineWords(title);
  if (own.includes("?")) return true;
  const padded = ` ${fold(own)} `;
  if (QUESTION_PHRASES.some((phrase) => padded.includes(` ${phrase} `))) return true;
  return holdsTeaser(own);
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
 * `lenient` reads the bridged and '!' runs as names (see below), for the one candidate whose own casing is not trusted.
 */
function caseEvidence(title: string, lenient = false): CaseEvidence {
  const evidence: CaseEvidence = { spellings: new Map(), lower: new Set() };
  const text = title.trim().slice(0, EVIDENCE_MAX_CHARS);
  if (text === "" || isAllCaps(text) || hasShoutedRun(text)) return evidence;

  const tokens = text.split(WORD_JOINERS).filter((t) => t !== "").slice(0, EVIDENCE_MAX_TOKENS);
  const quoted = quotedFlags(tokens);
  const stems = tokens.map(stemOf);
  // Lenient (h164-titles-2: the evidence a caseUnreliable candidate is recased from): a run bridged by 've' / 'ile' or
  // ended by '!' is read as names, not as capitalised common nouns, because the candidate is the one whose casing is
  // not trusted ("Libya ve Venezuela" is evidence for 'libya' and 'venezuela'). A quoted span and a Title Case title
  // still add none.
  const runFlags = lenient
    ? tokens.map(() => false)
    : commonNounRunFlags(
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

/**
 * What one member says about how words are written, for a pick that has caseUnreliable members: such a member's lower-case
 * words are not evidence (a machine lost them), so they veto no sibling's capital; its capitals still count.
 */
function memberEvidence(cleaned: string, member: MemberTitle, lenient: boolean): CaseEvidence {
  const evidence = caseEvidence(cleaned, lenient);
  return member.caseUnreliable === true ? { spellings: evidence.spellings, lower: new Set() } : evidence;
}

// The lenient reading reads one title more kindly than the strict one does (a bridged run is names), so a capital that
// only ONE of many other members writes is not enough to recase a flagged title: 0792bdea's "anma günü" became "anma
// Günü" from the one sibling that Title-Cased "Anma Günü". With this many other members (the cluster's usable titles
// but the candidate), a word needs LENIENT_MIN_TITLES of them; in a smaller cluster one is all there is.
const LENIENT_CORROBORATION_OTHERS = 4;
const LENIENT_MIN_TITLES = 2;

function lenientMinTitles(others: number): number {
  return others >= LENIENT_CORROBORATION_OTHERS ? LENIENT_MIN_TITLES : 1;
}

// A letters-and-digits code a machine casing turns into another word ('COP31' -> 'çöp31', 'F16' -> 'f16'): the sibling
// writes it in capitals, so the ASCII fold of the two is equal and the capitals are the spelling to restore. A code
// has at least one upper-case letter and one digit and nothing else; the stem of a token, so "COP31'de" is "COP31".
const CODE_MAX_CHARS = 12;

function isUpperCode(stem: string): boolean {
  if (stem.length < 3 || stem.length > CODE_MAX_CHARS) return false;
  let letters = 0;
  let digits = 0;
  for (const ch of stem) {
    if (/\p{N}/u.test(ch)) digits++;
    else if (ch !== ch.toLocaleLowerCase("tr") && ch === ch.toLocaleUpperCase("tr")) letters++;
    else return false;
  }
  return letters >= 1 && digits >= 1;
}

/** The upper-case codes one cleaned title writes. A shouted title has lost its case and says nothing. */
function codeSpellingsOf(cleaned: string): Set<string> {
  const out = new Set<string>();
  const text = cleaned.trim().slice(0, EVIDENCE_MAX_CHARS);
  if (text === "" || isAllCaps(text) || hasShoutedRun(text)) return out;
  for (const token of text.split(WORD_JOINERS).slice(0, EVIDENCE_MAX_TOKENS)) {
    const stem = stemOf(token);
    if (isUpperCode(stem)) out.add(stem);
  }
  return out;
}

/** ASCII fold of a code -> its capital spelling ("cop31" -> "COP31"), kept only when every sibling spells it the same. */
function codeFormsFrom(list: readonly ReadonlySet<string>[]): Map<string, string> {
  const spellings = new Map<string, Set<string>>();
  for (const set of list) {
    for (const code of set) {
      const key = asciiLower(code);
      let merged = spellings.get(key);
      if (merged === undefined) {
        merged = new Set();
        spellings.set(key, merged);
      }
      merged.add(code);
    }
  }
  const forms = new Map<string, string>();
  for (const [key, set] of spellings) {
    const [only] = set;
    if (set.size === 1 && only !== undefined) forms.set(key, only);
  }
  return forms;
}

/** The sibling's capital spelling of `stem` when it is a code written in other letters ("çöp31", "cop31"), else undefined. */
function codeRestored(codes: ReadonlyMap<string, string>, stem: string): string | undefined {
  if (!hasDigit(stem)) return undefined;
  const code = codes.get(asciiLower(stem));
  return code !== undefined && code !== stem ? code : undefined;
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
 * ACRONYMS member; a longer shouted word is not evidence of a name. `minTitles` is how many of the titles
 * must spell the word with a capital (1: one is enough; the lenient reading for a caseUnreliable candidate asks
 * for LENIENT_MIN_TITLES when the cluster has enough other members to corroborate it).
 */
function capitalFormsFrom(list: readonly CaseEvidence[], minTitles = 1): Map<string, string> {
  const spellings = new Map<string, Set<string>>();
  const support = new Map<string, number>();
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
      support.set(word, (support.get(word) ?? 0) + 1);
    }
  }
  const forms = new Map<string, string>();
  for (const [word, set] of spellings) {
    if (set.size !== 1 || lower.has(word) || (support.get(word) ?? 0) < minTitles) continue;
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
  return capitalFormsFrom(others.map((other) => caseEvidence(other)));
}

function recaseWith(
  forms: ReadonlyMap<string, string>,
  text: string,
  acronyms?: ReadonlySet<string>,
  codes?: ReadonlyMap<string, string>,
): string {
  const known = acronyms !== undefined && acronyms.size > 0 ? acronyms : null;
  const knownCodes = codes !== undefined && codes.size > 0 ? codes : null;
  if ((forms.size === 0 && known === null && knownCodes === null) || text === "" || text.length > EVIDENCE_MAX_CHARS) {
    return text;
  }
  const parts = text.split(WORD_JOINERS_KEPT);
  let seenWord = false;
  // Even indices are words, odd ones the separators that were kept.
  for (let i = 0; i < parts.length; i += 2) {
    const token = parts[i]!;
    const [a, b] = coreRange(token);
    if (a >= b) continue;
    const [stem, suffix] = splitSuffix(token.slice(a, b));
    const first = !seenWord;
    seenWord = true;
    // A title-cased acronym ('Kktc', 'Tbmm') takes the capitals a sibling writes, the first word included
    // (h94-neutraltitles-3).
    if (known !== null && CASED_ACRONYM.test(stem)) {
      const upper = stem.toLocaleUpperCase("tr");
      if (known.has(upper)) {
        parts[i] = token.slice(0, a) + upper + suffix + token.slice(b);
        continue;
      }
    }
    // A letters-and-digits code a sibling writes in capitals ('çöp31' -> 'COP31'), the first word included (h164-titles-2).
    const code = knownCodes === null ? undefined : codeRestored(knownCodes, stem);
    if (code !== undefined) {
      parts[i] = token.slice(0, a) + code + suffix + token.slice(b);
      continue;
    }
    if (first) continue; // the first word: cleanHeadline already capitalised it
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
 * reports), each word once. With `codes` (a caseUnreliable candidate's), a letters-and-digits code that a sibling
 * writes in capitals ('çöp31' beside 'COP31') is one too, the first word included.
 */
function disagreements(forms: ReadonlyMap<string, string>, text: string, codes?: ReadonlyMap<string, string>): number {
  const names = leakNames(forms);
  let disagree = 0;
  let seenWord = false;
  for (const token of candidateTokens(text)) {
    const [a, b] = coreRange(token);
    if (a >= b) continue;
    const [stem] = splitSuffix(token.slice(a, b));
    const first = !seenWord;
    seenWord = true;
    // A code a sibling writes in capitals counts, the first word included ('çöp31' for 'COP31').
    if (codes !== undefined && codeRestored(codes, stem) !== undefined) {
      disagree++;
      continue;
    }
    if (first) continue;
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
  const parts = splitSpeakerLabel(title);
  return parts !== null && startsLowerCase(parts.rest);
}

/**
 * The speaker label of a title and what follows it: the text before the first ':' when that sits at index 1 to
 * LABEL_MAX_CHARS and holds 1 to LABEL_MAX_WORDS words that all start with a capital ("Bilal Erdoğan: ...",
 * "Sağlık Bakanı Memişoğlu: ..."); null for any other title ("Vali yardımcısının ölümünde yeni iddia: başsavcı ..."
 * has a lower-case word before the colon). The title is read up to EVIDENCE_MAX_CHARS characters. The one definition
 * lowerCaseSourced and the attribution rule (h94-neutraltitles-2) share.
 */
function splitSpeakerLabel(rawTitle: string): { label: string; rest: string } | null {
  const title = rawTitle.trim().slice(0, EVIDENCE_MAX_CHARS);
  const colon = title.indexOf(":");
  if (colon < 1 || colon > LABEL_MAX_CHARS) return null;
  const words = title.slice(0, colon).split(WORD_JOINERS).filter((w) => w !== "");
  if (words.length < 1 || words.length > LABEL_MAX_WORDS || !words.every(startsUpper)) return null;
  return { label: title.slice(0, colon), rest: title.slice(colon + 1) };
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

// ---------------------------------------------------------------------------
// The title-cased acronym (extractive-v6, hunt 95, h94-neutraltitles-3).
// ---------------------------------------------------------------------------
//
// One outlet sentence-cases a headline word for word ("Bakan bak, Kktc başbakan yardımcısı ataoğlu ile görüştü",
// "Tbmm başkanı Kurtulmuş: ...") and the picker copied it into the H1 although two other outlets wrote "KKTC" and ten
// wrote "TBMM". isOddOneOut needs lowerCaseSourced, which a title that opens with a capital never is. A word of two
// to five letters with one capital and the rest lower case ("Kktc", "Tbmm") whose upper form some sibling writes as a
// whole token is that outlet's casing, not a name: the title is the odd one out, recaseWith repairs it from the sibling
// forms (the acronym itself included) and leaksWith still guards what it cannot restore.

/** A word the sentence-casing lost the capitals of: one capital, one to four lower-case letters ("Kktc", "Tbmm", "Ak"). */
const CASED_ACRONYM = /^\p{Lu}\p{Ll}{1,4}$/u;
/** An acronym as a sibling writes it: two to five capitals and nothing else. */
const UPPER_ACRONYM = /^\p{Lu}{2,5}$/u;

/** What one cleaned title says about acronyms: the upper-case spellings it writes, and the words it writes in any other case. */
interface AcronymEvidence {
  upper: Set<string>;
  /** Tr-lower-cased words the title writes in lower case or with one capital ('kasım' in "1 Kasım 2026"). */
  notUpper: Set<string>;
}

/** A vowel of the Turkish alphabet in capitals: a word has one, an abbreviation such as KKTC, TBMM or BDDK need not. */
const UPPER_VOWEL = /[AEIİOÖUÜÂÎÛ]/u;

/**
 * Reads one cleaned title. `upper` holds the whole-token acronyms ("TBMM'de" -> "TBMM": two to five capitals) a title
 * can be trusted to mean as acronyms, with the guards the existing suites needed:
 *   - only a spelling with no vowel (KKTC, TBMM, BDDK, EPDK: no Turkish word is spelled without one) or one of the
 *     ACRONYMS counts. A shouted ordinary word is emphasis or a styled name, not evidence: 'YENİ' ("YENİ Parti"), 'KASIM'
 *     ("DEPREM 1 KASIM!"), 'ENKA' ("... Kazanan ENKA Oldu") and 'İZMİR' must not turn a member's 'Yeni', 'Kasım', 'Enka'
 *     or 'İzmir' into capitals (the h26 and h27 pins; two corpus titles said 'Yeni Parti' and another outlet 'YENİ Parti');
 *   - a shouted title (all capitals) or one with a run of shouted words (hasShoutedRun) has lost its case and
 *     contributes nothing;
 *   - a bulletin cue ('ŞOK', 'FLAŞ', 'SON': a stop word, a framing or a loaded word) is emphasis, not an acronym.
 * `notUpper` lists every other word of two or more letters (lower case, one capital, mixed), so evidence a title
 * contradicts is dropped: a sibling that also writes 'Tcmb' shows 'TCMB' is not settled.
 */
function acronymEvidenceOf(cleaned: string): AcronymEvidence {
  const evidence: AcronymEvidence = { upper: new Set(), notUpper: new Set() };
  const text = cleaned.trim().slice(0, EVIDENCE_MAX_CHARS);
  if (text === "" || isAllCaps(text) || hasShoutedRun(text)) return evidence;
  for (const word of text.split(WORD_JOINERS).slice(0, EVIDENCE_MAX_TOKENS)) {
    const stem = stemOf(word);
    if (letterCount(stem) < 2) continue;
    const lowered = stem.toLocaleLowerCase("tr");
    if (!UPPER_ACRONYM.test(stem)) {
      if (stem !== stem.toLocaleUpperCase("tr")) evidence.notUpper.add(lowered);
      continue;
    }
    if (UPPER_VOWEL.test(stem) && !ACRONYMS.has(stem)) continue;
    if (STOP.has(asciiLower(stem)) || framingPenalty(lowered) > 0 || loadedPenalty(lowered) > 0) continue;
    evidence.upper.add(stem);
  }
  return evidence;
}

/** The acronym spellings the evidence supports: written in capitals by some title and contradicted by none. */
function supportedAcronyms(list: readonly AcronymEvidence[]): Set<string> {
  const upper = new Set<string>();
  const notUpper = new Set<string>();
  for (const e of list) {
    for (const u of e.upper) upper.add(u);
    for (const w of e.notUpper) notUpper.add(w);
  }
  const out = new Set<string>();
  for (const u of upper) if (!notUpper.has(u.toLocaleLowerCase("tr"))) out.add(u);
  return out;
}

/** True when a token of the cleaned title (its apostrophe suffix removed) is a CASED_ACRONYM whose upper form is in `acronyms`. */
function hasCasedAcronymToken(cleaned: string, acronyms: ReadonlySet<string>): boolean {
  if (acronyms.size === 0) return false;
  for (const token of cleaned.trim().slice(0, EVIDENCE_MAX_CHARS).split(WORD_JOINERS).slice(0, EVIDENCE_MAX_TOKENS)) {
    const stem = stemOf(token);
    if (CASED_ACRONYM.test(stem) && acronyms.has(stem.toLocaleUpperCase("tr"))) return true;
  }
  return false;
}

/** The acronym spellings the given titles support (cleaned inside, each read up to EVIDENCE_MAX_CHARS). */
function acronymEvidence(titles: readonly string[]): Set<string> {
  const list: AcronymEvidence[] = [];
  for (const raw of titles) {
    if (typeof raw === "string") list.push(acronymEvidenceOf(cleanHeadline(raw.slice(0, EVIDENCE_MAX_CHARS))));
  }
  return supportedAcronyms(list);
}

/**
 * True when the cleaned title holds a title-cased acronym ("Kktc", "Tbmm'de") whose upper form ("KKTC", "TBMM") a
 * sibling title writes as a whole token. The token is judged without its apostrophe suffix, anywhere in the title.
 * A sibling that is all capitals (or has a run of shouted words) is not evidence (it has lost its case), nor is a
 * bulletin cue ('ŞOK'), a word of more than five letters, a shouted word that has a vowel and is no known acronym
 * ('YENİ', 'KASIM': emphasis, not an abbreviation), or a spelling some sibling also writes in lower case or with one
 * capital. `siblings` are the cluster's other titles, raw or cleaned. Pure.
 */
export function titleCasedAcronym(title: string, siblings: readonly string[]): boolean {
  if (typeof title !== "string" || title === "") return false;
  return hasCasedAcronymToken(title, acronymEvidence(siblings));
}

// ---------------------------------------------------------------------------
// Attribution and voice (extractive-v6, hunt 95, h94-neutraltitles-2).
// ---------------------------------------------------------------------------
//
// At two members the centrality of both titles is the same, so the length term decided: 'Sağlık Bakanı Memişoğlu:
// Toplum sağlığını ... mücadelemizi sürdürüyoruz' (AA) lost to haberturk's quote-wrapped copy of the same sentence, whose
// quotes cleanHeadline stripped, and the H1 read as the site's own claim. scoreTitle had no term for attribution lost.
// Two terms now: a restatement of what a sibling says behind a speaker label pays ATTRIBUTION_LOSS_PENALTY, and a
// title that speaks in the first person with no speaker named, no colon and no quote pays UNATTRIBUTED_VOICE_PENALTY.

/**
 * What a title pays for restating, without its label, what another member says behind a '<Label>:' (the label parsed as
 * lowerCaseSourced parses it: at most LABEL_MAX_WORDS words, all capitalised): the folded texts are equal or the
 * token overlap is ATTRIBUTION_MIN_OVERLAP or more, and the title has no label and no quote mark of its own. The same
 * size as HEDGE_LOSS_PENALTY: dropping who said it and dropping that it is only said are the same kind of loss.
 */
export const ATTRIBUTION_LOSS_PENALTY = 0.15;
const ATTRIBUTION_MIN_OVERLAP = 0.8;

/**
 * What a title pays when it ends in a first-person form or an imperative ('mücadelemizi sürdürüyoruz', 'hazır olun':
 * FIRST_PERSON_ENDING) and has no ':' and no quote mark: nobody is speaking but the site (h94-neutraltitles-2, 759001a8's
 * bare 'Diplomatik çözüm için çalışıyoruz'). A quote, or a title with a label, is somebody's voice and pays nothing.
 */
export const UNATTRIBUTED_VOICE_PENALTY = 0.12;

/** Every mark that makes a title a quotation, the guillemets included. */
const ANY_QUOTE_MARKS: ReadonlySet<string> = new Set([...TWIN_QUOTE_MARKS, "«", "»"]);

/** True when one of `marks` sits between no two letters or digits (a quote, not a suffix apostrophe). Stops at the first. */
function hasMarkOutsideWords(t: string, marks: ReadonlySet<string>): boolean {
  for (let i = 0; i < t.length; i++) {
    if (marks.has(t.charAt(i)) && !(isWordCharAt(t, i - 1) && isWordCharAt(t, i + 1))) return true;
  }
  return false;
}

/**
 * Whether the title speaks in the first person (or gives the reader an order) with nobody speaking: it ends in a
 * FIRST_PERSON_ENDING form, holds no ':' and no quote mark. Exported for tests. Pure; false for a non-string.
 */
export function isUnattributedVoice(title: string): boolean {
  if (typeof title !== "string" || !endsInFirstPerson(title)) return false;
  if (title.includes(":")) return false;
  return !hasMarkOutsideWords(title, ANY_QUOTE_MARKS);
}

/** The other members' words behind a label: `index` is the member, `folded` and `toks` the folded rest and its tokens. */
interface LabelledRest {
  index: number;
  folded: string;
  toks: Set<string>;
}

/** Single words an outlet puts before a colon that name a kind of item, not a speaker ('Haberi: ...', 'Video: ...'). Tr-lower-cased. */
const NON_SPEAKER_LABELS: ReadonlySet<string> = new Set([
  "haber", "haberi", "haberler", "video", "foto", "fotoğraf", "galeri", "analiz", "özet", "canlı", "flaş",
]);

/**
 * A label that names no speaker: capitals longer than an acronym ('FLAŞ HABER', 'HABERİ': what is left of a bulletin
 * tag once the lead-in is stripped) or one of NON_SPEAKER_LABELS ('Haberi', 'Video'). A short upper-case label ('CHP',
 * 'AKP', 'DEM Parti') is a speaker.
 */
function isBulletinTag(label: string): boolean {
  return (isAllCaps(label) && letterCount(label) > ACRONYM_MAX_LETTERS) || NON_SPEAKER_LABELS.has(foldTr(label.trim()));
}

/** The members that carry a speaker label, with the folded text and tokens of what follows it. Cleaned titles in, member order kept. */
function labelledRests(cleanedTitles: readonly string[]): LabelledRest[] {
  const out: LabelledRest[] = [];
  cleanedTitles.forEach((cleaned, index) => {
    const parts = splitSpeakerLabel(cleaned);
    if (parts === null || isBulletinTag(parts.label)) return;
    const folded = fold(parts.rest);
    if (folded === "") return;
    out.push({ index, folded, toks: tokens(parts.rest) });
  });
  return out;
}

/** The title without the one pair of quotes cleanHeadline strips from around a whole headline (kept for a first-person sentence). */
function withoutWrappingQuotes(cleaned: string): string {
  return WRAPPING_QUOTES.exec(cleaned)?.[1] ?? cleaned;
}

/** What a title pays for attribution (see ATTRIBUTION_LOSS_PENALTY and UNATTRIBUTED_VOICE_PENALTY). */
interface AttributionCost {
  /** It restates a labelled member without the label. */
  dropped: boolean;
  /** It speaks in the first person with no speaker. */
  voice: boolean;
}

/**
 * Whether the cleaned title restates, without the label, what a labelled member (other than member `selfIndex`, -1 for
 * the stored title) says: it carries no label of its own and no quote mark (a wrapping pair around the whole of it does
 * not count: it is the quote-wrapped copy of the sentence the label names), and its folded text equals the rest of a
 * labelled member's or overlaps its tokens by ATTRIBUTION_MIN_OVERLAP or more.
 */
function attributionDropped(cleaned: string, labelled: readonly LabelledRest[], selfIndex: number): boolean {
  if (labelled.length === 0 || (labelled.length === 1 && labelled[0]!.index === selfIndex)) return false;
  if (splitSpeakerLabel(cleaned) !== null) return false;
  const body = withoutWrappingQuotes(cleaned);
  if (hasMarkOutsideWords(body, ANY_QUOTE_MARKS)) return false;
  const folded = fold(body);
  if (folded === "") return false;
  const toks = tokens(body);
  for (const other of labelled) {
    if (other.index === selfIndex) continue;
    if (folded === other.folded || jaccard(toks, other.toks) >= ATTRIBUTION_MIN_OVERLAP) return true;
  }
  return false;
}

function attributionCost(cleaned: string, labelled: readonly LabelledRest[], selfIndex: number): AttributionCost {
  return { dropped: attributionDropped(cleaned, labelled, selfIndex), voice: isUnattributedVoice(cleaned) };
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
// The title is the text as written (a member's raw title, the stored title); `attribution` is read off its
// cleaned form and the labelled members (attributionCost, h94-neutraltitles-2).
function scoreTitle(title: string, centrality: number, ctx: ScoreContext, attribution: AttributionCost): number {
  return (
    centrality -
    0.12 * framingPenalty(title) -
    0.25 * loadedPenalty(title) -
    (ctx.hedged && !carriesHedge(title) ? HEDGE_LOSS_PENALTY : 0) -
    (ctx.qualified && !carriesQualifier(title) ? QUALIFIER_LOSS_PENALTY : 0) -
    (attribution.dropped ? ATTRIBUTION_LOSS_PENALTY : 0) -
    (attribution.voice ? UNATTRIBUTED_VOICE_PENALTY : 0) -
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

type SwitchRule = "loaded" | "voice" | "hedge" | "number" | "titleCase" | "case";

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
 * Which h42-titles-2 rule (or h94-neutraltitles-2 and -3 rule) makes the stored title `inc` give way to the best
 * candidate `best` with no margin, or null when none does: (1) the stored title is loaded and the best one is not and
 * at least as central as the stored one, (1b, 'voice') the stored title is an unattributed first-person sentence
 * (isUnattributedVoice) and the best one is not, under the same centrality guard (h94-neutraltitles-2: 759001a8's bare
 * 'Diplomatik çözüm için çalışıyoruz' beside 'Erdoğan Trump ile telefonda görüştü'), (2) the cluster hedges in the
 * wide vocabulary, the stored title does not and the best one does, (3) the stored title lacks a number that half of
 * the other members carry and the best one has it, (4) the stored title is Title Case and the best one is not,
 * (5, 'case') the stored title holds a title-cased acronym a sibling writes in capitals ('Tbmm' beside 'TBMM') or opens
 * with a single quote nothing closes, and the best one does neither (h94-neutraltitles-3). Checked in that order; the
 * first that holds names the rule. No rule swaps to a title with more framing or to a Title Case title
 * (SWITCH_TARGET_TITLE_CASE_WORDS), and rules (2) to (5) need a best title that restates the stored one
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
  flaggedTitles: readonly string[],
): SwitchRule | null {
  if (isTitleCaseTitle(best, SWITCH_TARGET_TITLE_CASE_WORDS)) return null;
  // No rule trades toward more framing: d1ed614b swapped "fon vurgunu tepkisi" for "olay çağrı" in the replay. The 'case'
  // rule has its own version of this guard: the acronym it restores ('KKTC', 'TBMM') is a shouted word to framingPenalty.
  if (framingPenalty(best) > framingPenalty(inc)) {
    return caseDefectIncumbent(inc, best, items, memberTitles, flaggedTitles) ? "case" : null;
  }
  if (loadedPenalty(inc) > 0 && loadedPenalty(best) === 0 && bestCentrality() >= incCentrality) return "loaded";
  // The stored title speaks for the site and the best one does not: no margin, behind the loaded rule's guard.
  if (isUnattributedVoice(inc) && !isUnattributedVoice(best) && bestCentrality() >= incCentrality) return "voice";
  if (jaccard(tokens(inc), tokens(best)) < SAME_STORY_MIN_OVERLAP) return null;
  if (hedgedWide(items) && !carriesWideHedge(inc) && carriesWideHedge(best)) return "hedge";
  if (lacksMajorityNumber(inc, best, items)) return "number";
  if (titleCaseIncumbent(inc, best, memberTitles)) return "titleCase";
  if (caseDefectIncumbent(inc, best, items, memberTitles, flaggedTitles)) return "case";
  return null;
}

/**
 * framingPenalty with the sibling-supported acronyms ('KKTC', 'TBMM': four capitals read as a shouted word) written
 * with one capital, so a title that carries the correct acronym is not "more framed" than one that does not.
 */
function framingWithoutAcronyms(title: string, acronyms: ReadonlySet<string>): number {
  if (acronyms.size === 0) return framingPenalty(title);
  const softened = title
    .split(/(\s+)/)
    .map((token) => {
      const stem = stemOf(token);
      return acronyms.has(stem) ? token.replace(stem, stem.charAt(0) + stem.slice(1).toLocaleLowerCase("tr")) : token;
    })
    .join("");
  return framingPenalty(softened);
}

/**
 * The stored title carries one outlet's casing or a stray quote and the best candidate does not (h94-neutraltitles-3):
 * (a) it holds a title-cased acronym whose upper form a sibling (a member title that is not a copy of the stored one)
 * writes as a whole token ('Tbmm başkanı Kurtulmuş: ...' while ten members write 'TBMM'), (b) it opens with a ' or ‘
 * that nothing closes ("'Kaşif Kozinoğlu'nun ATK raporu ...", what cleanHeadline now drops from a fresh pick), or (c, h164-
 * titles-2) it is the wording of a caseUnreliable member and the siblings would restore capitals in it ('Bakan kurum:
 * ...', 'libya ve venezuela', 'çöp31'), where the best candidate needs none. The best candidate is a fresh pick, so it
 * has none of these unless every member does. Like the h42 rules it needs a best title that restates the stored one
 * (SAME_STORY_MIN_OVERLAP) and none that is more framed (the acronym itself not counted).
 */
function caseDefectIncumbent(
  inc: string,
  best: string,
  items: readonly MemberTitle[],
  memberTitles: readonly string[],
  flaggedTitles: readonly string[] = [],
): boolean {
  if (jaccard(tokens(inc), tokens(best)) < SAME_STORY_MIN_OVERLAP) return false;
  const strayQuote = hasStrayLeadingQuote(inc);
  const incFold = fold(inc);
  const siblings = memberTitles.filter((t) => fold(t) !== incFold && fold(cleanHeadline(t.slice(0, EVIDENCE_MAX_CHARS))) !== incFold);
  const acronyms = acronymEvidence(siblings);
  if (framingWithoutAcronyms(best, acronyms) > framingWithoutAcronyms(inc, acronyms)) return false;
  if (strayQuote) return !hasStrayLeadingQuote(best);
  if (hasCasedAcronymToken(inc, acronyms) && !hasCasedAcronymToken(best, acronyms)) return true;
  return lostCapitalsIncumbent(inc, best, items, flaggedTitles);
}

/**
 * (c) of caseDefectIncumbent: the stored title is the wording of a caseUnreliable member (fold-equal to its title, raw or
 * cleaned) and recasing it from the lenient evidence of the members and the capital codes they write would change it,
 * while the best candidate would not change. The same recasing the pick applies to a fresh flagged candidate. The evidence
 * is each of `items` (the usable members, a twin folded into one: usableItems keeps the case-trusted copy of a title two
 * outlets wrote alike), read with its own flag, so a flagged member's lower-case words are no evidence and a trusted one's
 * are. `flaggedTitles` (the titles of every flagged member) only says whether the stored title is a flagged member's wording.
 * A case-trusted member that wrote exactly the stored title (raw or cleaned, byte for byte) settles it: that casing is an
 * outlet's own, not a machine's (h165 review: İşçi Haber's casing equals the agency's when no proper noun follows the first
 * word, and the string-keyed flag made the trusted twin count as flagged).
 */
function lostCapitalsIncumbent(
  inc: string,
  best: string,
  items: readonly MemberTitle[],
  flaggedTitles: readonly string[],
): boolean {
  if (flaggedTitles.length === 0) return false;
  const incFold = fold(inc);
  if (!flaggedTitles.some((t) => fold(t) === incFold || fold(cleanHeadline(t.slice(0, EVIDENCE_MAX_CHARS))) === incFold)) return false;
  const cleaned = items.map((m) => cleanHeadline(m.title.slice(0, EVIDENCE_MAX_CHARS)));
  if (items.some((m, i) => m.caseUnreliable !== true && (m.title === inc || cleaned[i] === inc))) return false;
  const forms = capitalFormsFrom(
    items.map((m, i) => memberEvidence(cleaned[i]!, m, true)),
    lenientMinTitles(items.length - 1),
  );
  const codes = codeFormsFrom(cleaned.map(codeSpellingsOf));
  return recaseWith(forms, inc, undefined, codes) !== inc && recaseWith(forms, best, undefined, codes) === best;
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
 * The twin tiebreaks of the final result: the glued-twin one (preferUngluedJoin), then the quote twin
 * (preferFewerStrayQuotes, h94-neutraltitles-3).
 *
 * The glued-twin tiebreak: when `chosen` holds a glued join (see gluedJoinCount) and a
 * member title, cleaned, is the same text with strictly fewer joins (identical letters and
 * digits in the same case, only the separators differ) and passes isAcceptableNeutral, that
 * member's cleaned title is returned instead; of several, the one with the fewest joins, the
 * first in member order on a tie.
 *
 * The quote-twin tiebreak: when `chosen` has a single quote nothing closes (an odd number of ' ‘ ’ between no two
 * letters: "Kılıçdaroğlu'ndan 'adaylık açıklaması", the ' before 'adaylık' opens a quote nobody closes) and a member title, cleaned, is
 * the same text after ' ‘ ’ " “ ” are removed from both and has fewer of those marks, and passes
 * isAcceptableNeutral, the member's cleaned title is returned instead ("Kılıçdaroğlu’ndan adaylık
 * açıklaması", hurriyet's); of several, the one with the fewest, the first in member order on a tie.
 *
 * Any other `chosen` is returned as passed, and a member that is not a twin is never considered.
 * Pure; the members are the cluster's raw titles.
 */
export function preferUnglued(chosen: string, memberTitles: readonly string[]): string {
  return preferFewerStrayQuotes(preferUngluedJoin(chosen, memberTitles), memberTitles);
}

/** The glued-twin half of preferUnglued: see there. */
function preferUngluedJoin(chosen: string, memberTitles: readonly string[]): string {
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

// What two quote twins share: the text with every ' ‘ ’ " “ ” removed. Case and every other character are kept, so
// the two differ in quote marks and nothing else.
const TWIN_QUOTE_STRIP = /['‘’"“”]/g;

function quoteTwinKey(title: string): string {
  return title.replace(TWIN_QUOTE_STRIP, "");
}

/** The quote-twin half of preferUnglued: see there. */
function preferFewerStrayQuotes(chosen: string, memberTitles: readonly string[]): string {
  // Only a chosen title with a single quote nothing closes is a candidate for the swap (an odd number of ' ‘ ’ that sit
  // between no two letters; unbalancedDoubleQuotes ignores them by design). A title whose quotes pair up ('"Türk
  // Yüzyılı" temasıyla', "'Sıfır Atık Kadın Elçiliği' daveti") is somebody's quotation and stays as chosen.
  if (marksOutsideWords(chosen, SINGLE_QUOTE_MARKS) % 2 === 0) return chosen;
  let bestMarks = marksOutsideWords(chosen, TWIN_QUOTE_MARKS);
  const key = quoteTwinKey(chosen);
  let best = chosen;
  for (let i = 0; i < memberTitles.length; i++) {
    const raw = (memberTitles[i] ?? "").trim();
    if (raw === "") continue;
    const cleaned = cleanHeadline(raw);
    if (cleaned === "" || quoteTwinKey(cleaned) !== key) continue;
    const marks = marksOutsideWords(cleaned, TWIN_QUOTE_MARKS);
    if (marks >= bestMarks) continue;
    if (LEAD_IN.test(foldTr(cleaned))) continue;
    if (!isAcceptableNeutral(cleaned, memberTitles.filter((_, j) => j !== i))) continue;
    best = cleaned;
    bestMarks = marks;
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

/**
 * U+0001 stands in the member key for a quotation mark that sits outside a word (h140-seo-1). A literal U+0001 in a title is
 * removed first, so no title can forge one. Migration 200's stale key writes it chr(1).
 */
const KEY_QUOTE_SENTINEL = "\u0001";
/** The quotation marks the key reads: ' ‘ ’ " “ ” « ». */
const KEY_QUOTE_MARKS: ReadonlySet<string> = new Set(["'", "‘", "’", '"', "“", "”", "«", "»"]);
/** Every character outside letters, digits and the sentinel, removed: the key ignores case and separators. */
const NOT_KEY_CHAR = /[^\p{L}\p{N}\u0001]+/gu;

/**
 * The membership key of a title (h42-titles-1, quote-aware since h140-seo-1), five steps: (a) any U+0001 is removed;
 * (b) every quotation mark that does NOT sit between two letters or digits becomes the sentinel (the rule marksOutsideWords
 * uses, so the in-word apostrophe of "CHP'nin", "Kasım’a" and "Erdoğan’dan" is not a mark); (c) the Turkish lower case;
 * (d) everything but letters, digits and the sentinel is removed; (e) the sentinels at the two ends of the key are removed.
 * The key is blind to case, separators, which quotation mark is used (straight, curly, guillemets), the in-word apostrophe
 * and quotes that wrap the whole title (they say nothing about a span inside it: a stored '"Diplomatik çözüm için
 * çalışıyoruz"' is still the member that writes it bare). It is not blind to WHERE a span is quoted: a title that writes
 * 'şaibeli kurultay' in quotes is not the title that writes it bare. One pass; the lower case comes after the marks are
 * found, so the positions are the title's own. Migration 200 does the same in SQL.
 */
function memberKey(title: string): string {
  const t = title.replaceAll(KEY_QUOTE_SENTINEL, "");
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < t.length; i++) {
    if (!KEY_QUOTE_MARKS.has(t.charAt(i))) continue;
    if (isWordCharAt(t, i - 1) && isWordCharAt(t, i + 1)) continue;
    parts.push(t.slice(from, i), KEY_QUOTE_SENTINEL);
    from = i + 1;
  }
  parts.push(t.slice(from));
  const key = parts.join("").toLocaleLowerCase("tr").replace(NOT_KEY_CHAR, "");
  let start = 0;
  let end = key.length;
  while (start < end && key.charAt(start) === KEY_QUOTE_SENTINEL) start++;
  while (end > start && key.charAt(end - 1) === KEY_QUOTE_SENTINEL) end--;
  return key.slice(start, end);
}

// cleanHeadline's house-style rewrite as it stood before it learned to leave "Başkan Erdoğan Tosun" alone
// (a capitalised name after it is a different person): v1 to v5 titles stored "Cumhurbaşkanı Erdoğan
// Tokayev'i ..." from "Başkan Erdoğan Tokayev'i ...". Those stored titles are still a member's wording.
const LEGACY_HOUSE_STYLE = /(?<![\p{L}\p{N}])Başkan Erdoğan(?![\p{L}\p{N}])/gu;

/**
 * Whether the stored title `inc` is still some member's wording. True when a member title m has
 * key(cleanHeadline(m)) === key(inc) or key(m) contains key(inc), where key is memberKey: the Turkish
 * lower case with every character outside letters and digits removed and every quotation mark that
 * sits outside a word, except at the very edges of the title, kept as one sentinel. That makes it blind
 * to case, separators, the kind of quotation mark and the in-word apostrophe, so a recased ("türkiye" ->
 * "Türkiye"), sentence-cased (a shouted member), quote-repaired (curly against straight, a stray leading
 * quote dropped) or glued-twin ("Tel Aviv-Washington" against "Tel AvivWashington") form of a member title
 * still counts, and so does the cleaned form of a title with a lead-in, an outlet prefix, and the
 * "Başkan Erdoğan" -> "Cumhurbaşkanı Erdoğan" rewrite older cleaning rules applied before a capitalised
 * name. It is NOT blind to where a span is quoted (h140-seo-1): a member that writes 'şaibeli kurultay' in
 * quotes does not carry a stored title that writes the span bare. Pass ALL raw member titles, not the
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

/** A trimmed title the pick can work with: not blank and not a placeholder ("Kısa haberler", a live-blog lead-in). */
function isUsableTitle(trimmed: string): boolean {
  return trimmed.length > 0 && !isGenericTitle(trimmed);
}

/**
 * The members the pick chooses among (h54-editorial-3): the opinion columns (`opinion: true`) are dropped
 * when at least one non-opinion member has a usable title, and kept when none has (a cluster of columns
 * only, or news members that are all blank or placeholders, is picked as before). Judged BEFORE usableItems
 * folds twins together, so a column and a news article that share a headline cannot make the news one
 * disappear. Returns the same array when nothing is flagged, a new one otherwise; never mutates.
 */
function withoutOpinion(members: MemberTitle[]): MemberTitle[] {
  if (!members.some((m) => m.opinion === true)) return members;
  const hasNews = members.some((m) => m.opinion !== true && isUsableTitle((m.title ?? "").trim()));
  return hasNews ? members.filter((m) => m.opinion !== true) : members;
}

/**
 * The members the pick chooses among, language side (h59-english-2): the English-outlet members
 * (`english: true`) are dropped when at least one non-English member has a usable title, and kept when none
 * has (an all-English cluster, or Turkish members that are all blank or placeholders, is picked as before).
 * Applied to the output of `withoutOpinion`, so a Turkish column next to English news leaves the news, as
 * h54-editorial-3 wants, and a column beside Turkish news and English news leaves the Turkish news. Returns
 * the same array when nothing is flagged, a new one otherwise; never mutates.
 */
function withoutEnglish(members: MemberTitle[]): MemberTitle[] {
  if (!members.some((m) => m.english === true)) return members;
  const hasTurkish = members.some((m) => m.english !== true && isUsableTitle((m.title ?? "").trim()));
  return hasTurkish ? members.filter((m) => m.english !== true) : members;
}

/** The members the pick may choose among and learn from: no opinion columns, no English outlets (when avoidable). */
function pickableMembers(members: MemberTitle[]): MemberTitle[] {
  return withoutEnglish(withoutOpinion(members));
}

/**
 * The member titles the pick works from: blank titles and placeholders ("Kısa haberler", a
 * live-blog lead-in) out, and a title that folds to the same text as an earlier one counted once. The
 * first occurrence stands, except that a caseUnreliable member's title gives its place to a later twin that is
 * not flagged ('Bakan kurum: ...' from İşçi Haber and the same words with their capitals from another outlet fold
 * alike, and the capitals are the ones to keep; h164-titles-2).
 */
function usableItems(members: MemberTitle[]): MemberTitle[] {
  const seen = new Map<string, number>();
  const out: MemberTitle[] = [];
  for (const m of members.map((x) => ({ ...x, title: (x.title ?? "").trim() })).filter((x) => isUsableTitle(x.title))) {
    const key = fold(m.title);
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, out.length);
      out.push(m);
    } else if (out[at]!.caseUnreliable === true && m.caseUnreliable !== true) {
      out[at] = m;
    }
  }
  return out;
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
 * Members flagged `opinion` (an opinion column by URL) are dropped first when a non-opinion member with a
 * usable title exists (`withoutOpinion`, h54-editorial-3): they are neither candidates nor evidence, and a
 * stored title that only a column carries counts as carried by no member (stale).
 * Members flagged `english` (an English-language outlet, set by the headline cron from the source slug) are
 * dropped next, the same way, when a non-English member with a usable title exists (`withoutEnglish`,
 * h59-english-2): a stored title that only an English outlet carries is stale in a mixed cluster, and an
 * all-English cluster is picked as before.
 * Whatever the result (a first pick, a floor pick, the stored title a re-pick keeps), a glued word join
 * in it gives way to a member title that is the same text without the join (preferUnglued, h35).
 */
export function pickNeutralTitle(allMembers: MemberTitle[], opts: PickOptions = {}): string | null {
  // h54-editorial-3: an opinion column is not a candidate, nor does it carry the stored title.
  // h59-english-2: nor does an English outlet while a Turkish member exists.
  const members = pickableMembers(allMembers);
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
  const items = usableItems(pickableMembers(members));
  if (items.length === 0) return null;

  const toks = items.map((m) => tokens(m.title));
  const outliers = numeralOutliers(items.map((m) => numsOf(m.title)));
  const hedgingMembers = items.filter((m) => carriesHedge(m.title)).length;
  const ctx: ScoreContext = {
    hedged:
      items.length === HEDGED_PAIR_SIZE
        ? hedgingMembers >= 1
        : items.length >= HEDGED_MIN_MEMBERS && hedgingMembers / items.length >= HEDGED_SHARE,
    qualified:
      items.length >= QUALIFIED_MIN_MEMBERS &&
      items.filter((m) => carriesQualifier(m.title)).length / items.length >= QUALIFIED_SHARE,
  };

  // The cleaned titles, and the members that name a speaker (h94-neutraltitles-2): a title that restates what a
  // labelled member says without the label pays ATTRIBUTION_LOSS_PENALTY.
  const cleanedItems = items.map((m) => cleanHeadline(m.title));
  const labelled = labelledRests(cleanedItems);

  const scored: Array<{ index: number; score: number }> = [];
  for (let i = 0; i < items.length; i++) {
    if (outliers.has(i)) continue;
    let sim = 0;
    for (let j = 0; j < items.length; j++) if (j !== i) sim += jaccard(toks[i]!, toks[j]!);
    const centrality = items.length > 1 ? sim / (items.length - 1) : 0;
    scored.push({
      index: i,
      score: scoreTitle(items[i]!.title, centrality, ctx, attributionCost(cleanedItems[i]!, labelled, i)),
    });
  }
  scored.sort((a, b) => b.score - a.score || a.index - b.index);

  // How each member title writes its words, read once and only when a candidate
  // is reached (h27-copy-2). Sibling evidence comes from the cleaned titles, so
  // an outlet prefix or a "SON DAKİKA" lead-in is not mistaken for a name.
  let evidence: CaseEvidence[] | null = null;
  // The lenient reading and the codes, read only when a caseUnreliable candidate is reached (h164-titles-2).
  let lenientEvidence: CaseEvidence[] | null = null;
  let codeReads: Set<string>[] | null = null;
  // What each cleaned title says about acronyms, read the same way (h94-neutraltitles-3).
  let acronymReads: AcronymEvidence[] | null = null;

  let best: { cleaned: string; score: number } | null = null;
  // The first-pick floor, best first: a statement with no hard defect, then a
  // question (or SEO explainer) with none (h34-reader-2: a question is never the
  // soft pick while any statement exists), then whatever ranked highest.
  let floorSoft: string | null = null;
  let floorQuestion: string | null = null;
  let floorAny: string | null = null;
  for (const { index, score } of scored) {
    const cleaned = cleanedItems[index]!;
    // A lead-in that survived cleaning (an odd Unicode case) must not ship.
    if (cleaned === "" || LEAD_IN.test(foldTr(cleaned))) continue;
    const others = items.filter((_, j) => j !== index).map((m) => m.title);
    // A lower-case-sourced title gets its names back from the siblings; one
    // that still has a lower-case name it cannot restore ('berlinden') is not
    // eligible for a normal pick, but can still be a floor candidate.
    evidence ??= items.map((m) => memberEvidence(cleanHeadline(m.title.slice(0, EVIDENCE_MAX_CHARS)), m, false));
    const forms = capitalFormsFrom(evidence.filter((_, j) => j !== index));
    // A caseUnreliable candidate (İşçi Haber: 'libya ve venezuela', 'Bakan kurum', 'çöp31') is recased from the lenient
    // evidence of its siblings and the codes they write in capitals, whatever its first letter (h164-titles-2).
    const flagged = items[index]!.caseUnreliable === true;
    let shownForms = forms;
    let codes: ReadonlyMap<string, string> | undefined;
    if (flagged) {
      lenientEvidence ??= items.map((m) => memberEvidence(cleanHeadline(m.title.slice(0, EVIDENCE_MAX_CHARS)), m, true));
      const lenientOthers = lenientEvidence.filter((_, j) => j !== index);
      shownForms = capitalFormsFrom(lenientOthers, lenientMinTitles(lenientOthers.length));
      codeReads ??= cleanedItems.map((c) => codeSpellingsOf(c.slice(0, EVIDENCE_MAX_CHARS)));
      codes = codeFormsFrom(codeReads.filter((_, j) => j !== index));
    }
    // A title-cased acronym ('Kktc', 'Tbmm') that a sibling writes in capitals is one outlet's casing: the title is
    // the odd one out whether or not it opens in lower case, and takes the siblings' forms (h94-neutraltitles-3).
    acronymReads ??= cleanedItems.map(acronymEvidenceOf);
    const acronyms = supportedAcronyms(acronymReads.filter((_, j) => j !== index));
    const oddOneOut =
      hasCasedAcronymToken(cleaned, acronyms) ||
      (forms.size > 0 && isOddOneOut(forms, items[index]!.title, cleaned)) ||
      (flagged && (shownForms.size > 0 || (codes?.size ?? 0) > 0) && disagreements(shownForms, cleaned, codes) >= 1);
    const shown = oddOneOut ? recaseWith(shownForms, cleaned, acronyms, codes) : cleaned;
    if (
      !(oddOneOut && leaksWith(shownForms, shown)) &&
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
      const incScore = scoreTitle(inc, incCentrality, ctx, attributionCost(cleanHeadline(inc), labelled, -1));
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
      // The titles of the caseUnreliable members (all of them, a case-trusted twin that stands for one in `items` too): a
      // stored title that is one of them may be a lost-capitals defect (h164-titles-2).
      const flaggedTitles = members.filter((m) => m.caseUnreliable === true).map((m) => (m.title ?? "").trim());
      if (incumbentSwitchRule(inc, best.cleaned, items, memberTitles, incCentrality, bestCentrality, flaggedTitles) !== null) {
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
