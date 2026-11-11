import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import {
  RISING_ENTITIES,
  RISING_FOLD_FROM,
  RISING_FOLD_TO,
  RISING_HUB_SPECS,
  type RisingEntity,
  type RisingHubSpec,
} from "@/lib/trends/rising-entities";

// Pure helpers behind the /gundem/[key] entity hubs. No I/O, no clock and no
// Next import, so the page, its metadata and the tests share one definition
// and the middleware-facing vocabulary (rising-entities.ts) stays the only
// source of truth for which hubs exist.

/** Days of coverage a hub shows. Mirrors the SQL default in migrations 123 and 125. */
export const ENTITY_HUB_WINDOW_DAYS = 14;
/** Clusters listed per hub (the RPC clamps p_limit to 1..50). */
export const ENTITY_HUB_LIMIT = 20;
/** A hub with fewer clusters than this is thin and stays out of the index. */
export const ENTITY_HUB_MIN_INDEXABLE = 3;
/**
 * Most queries, and most patterns, a hub sends. Mirrors the `[1:12]` slices in
 * migration 125, which ignore anything beyond the 12th element.
 */
export const ENTITY_HUB_MAX_TERMS = 12;

// A Map, not an object lookup: "__proto__", "constructor" and friends must
// never resolve to something.
const ENTITY_BY_KEY: ReadonlyMap<string, RisingEntity> = new Map(
  RISING_ENTITIES.map((e) => [e.key, e]),
);

/** The curated entity for a route key, or null when the key is unknown. */
export function entityByKey(key: string): RisingEntity | null {
  return typeof key === "string" ? (ENTITY_BY_KEY.get(key) ?? null) : null;
}

export function isEntityKey(key: string): boolean {
  return typeof key === "string" && ENTITY_BY_KEY.has(key);
}

// Moved to @/lib/bias/sum-distributions (shared with /konu/[slug], which the
// /gundem/[key] page now imports directly with distributionTotal and
// SPECTRUM_EMPTY_COPY); re-exported so this module's tests keep importing it
// from here.
export { sumDistributions } from "@/lib/bias/sum-distributions";

/**
 * Robots override for a hub: noindex (but follow) when the read failed or the
 * hub is thin; undefined (inherit the site default, indexable) otherwise.
 */
export function entityHubRobots(
  result: { bundles: readonly unknown[] } | null,
): { index: false; follow: true } | undefined {
  if (result === null || result.bundles.length < ENTITY_HUB_MIN_INDEXABLE) {
    return { index: false, follow: true };
  }
  return undefined;
}

/** "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor". */
export function entityHubNote(total: number, shown: number): string {
  const base = `Son ${ENTITY_HUB_WINDOW_DAYS} günde ${total} küme`;
  return total > shown ? `${base} · en yeni ${shown} tanesi listeleniyor` : base;
}

// ---------------------------------------------------------------------------
// Precision (migration 125). A hub lists only stories that LITERALLY name the
// entity: the stemmed tsquery over `queries` gives recall on the GIN index, and
// a regex guard over `patterns`, run on text folded exactly like migration 112,
// gives precision (no "devam" under DEVA, "domuz" under Dolar, "iyi" under İYİ
// Parti). Both lists come from the curated vocabulary only, never from request
// input.
//
// Scope and amounts (2026-11-01, app-side only: no migration). Migration 125
// runs `~ any(p_patterns)` on the whole folded text, so a pattern may open with
// a lookahead and see all of it:
//   * excludes (aym, tcmb, meclis): a non-trusted form is prefixed with
//     `^(?![\s\S]*(?:<cue>|<cue>))[\s\S]*`, so "Polonya'da polis Anayasa
//     Mahkemesi'ni bastı", "Avrupa Merkez Bankası" and "İsrail meclisi" are not
//     the Turkish institutions. A trusted alias (AYM, TCMB, TBMM, Büyük Millet
//     Meclisi) stays bare: it names the institution on its own.
//   * requires (meclis, tcmb): the same non-trusted form also needs one cue anywhere
//     in the text, a positive lookahead after the exclude one:
//     `^(?![\s\S]*(?:<ex>))(?=[\s\S]*(?:<req>))[\s\S]*`. The bare "Meclis"
//     counts only beside "TBMM", "genel kurul", "milletvekili", a party name and
//     the like, so an İTO, ATSO or MTO "meclis toplantısı", a municipal council
//     and a foreign parliament drop out.
//   * hubExcludes (meclis, 2026-11-09): vetoes migration 163 does not mirror for
//     /trends, as a second negative lookahead right behind the excludes one:
//     `^(?![\s\S]*(?:<ex>))(?![\s\S]*(?:<hub-ex>))(?=[\s\S]*(?:<req>))[\s\S]*`.
//     "Parti Meclisi", the KKTC and Croatian Speakers, the Federal Meclis, the İBB
//     Meclisi and the like are not the TBMM, and the first lookahead stays word for
//     word what tests/migrations/163 compares with the SQL guard.
//     Also curated, since h128-hubs-1 (2026-11-11), on the five generic-word hubs enflasyon, faiz, dolar, borsa and
//     asgari-ucret: a topic every country has, so the foreign cues that a read-only replay showed (abd, fed, ecb,
//     ingiltere, new york borsa, ara secim, irak, cin, japonya, banglades) veto the story. A closed 3-letter cue
//     ("abd", "fed", "ecb", "cin") takes `\M`, so "Abdullah" and "federasyon" are not cues. borsa's trusted aliases
//     skip them too.
//   * quantityGuard (dolar): `\m` + QUANTITY_GUARD + word, so "100 dolar", "2,1
//     milyar dolarlık" and "milyarlarca doları" are amounts, not the currency.
//   * inflections (akp, dem, iyi-parti, asgari-ucret, pkk, borsa): widen the
//     stemmed prefilter only; the patterns do not change.
//   * excludes (borsa, 2026-11-05): 'Borsa İstanbul' and 'BIST' are trusted and
//     stay bare; the bare "borsa" is vetoed by new york, wall street, nasdaq,
//     dow jones, nikkei, asya/avrupa/londra borsa, frankfurt, binance, kripto
//     and ticaret borsa, so the New York, Asian, crypto-exchange and commodity
//     exchange stories drop out.
//   * notAfter (disisleri, 2026-11-05): `\m` + one `(?<!word\s)` per foreign
//     country word + the base word, so "ABD Dışişleri Bakanı", "İran Dışişleri
//     Sözcüsü" and "KKTC Dışişleri" are not the Turkish ministry, while a story
//     that also names "Dışişleri Bakanı Fidan" unprefixed still matches. Every
//     lookbehind is a single fixed-length literal, so the pattern is valid in
//     JS and in PostgreSQL ARE and runs in linear time on both (100k characters).
//     Since 2026-11-10 (h110-trendsdata-2) an entry of two words is one literal
//     too, `(?<!basbakani\sve\s)`, for "Katar Başbakanı ve Dışişleri Bakanı".
// Postgres AREs support (?=...), (?!...) and (?<!...) (checked on production). A
// pattern starts with `^`, never `(?`, which Postgres would read as embedded
// options.
//
// Measured read-only on production, 2026-11-01, 14-day window, live clusters
// (not archived, article_count >= 2, merged_into is null). old = rows the
// pre-change patterns kept; new = rows the new patterns keep; ceiling = every
// live cluster whose text literally matches the new patterns, whatever the
// prefilter says (for the inflection keys old and new are prefilter-and-guard
// counts with and without the inflected queries). All 72 patterns of the 62
// entities compile (`select 'x' ~ p`), and the 21 behaviour samples of
// entity-hub.test.ts, plus the 16 meclis samples of the requires step, give the
// same answer in Postgres and in the JS twin. entity_cluster_ids_v2 called with
// the app's exact arrays returns the 255 meclis rows the counts below say (2026-11-01; h96-entityhubs-2 re-measured
// meclis on 2026-11-09, see its block at the end of this comment).
//
//   key           old   new   ceiling   note
//   aym            40    31       31    9 dropped, all Polonya; 0 Polonya left
//   tcmb            5     2        2    dropped: Avrupa and İsrail Merkez Bankası, FED
//   meclis        409   255      258    409 -> 313 (excludes) -> 255 (requires); see below
//   meclis        252   234      235    2026-11-09 (h96-entityhubs-2): 18 dropped, 0 added; see the last block
//   dolar          44     2        2    63 literal before; all 42 dropped are amounts
//   akp           322   331      331    prefilter 'ak partili', 'ak partimize'
//   dem            30    32       32    'dem partili'
//   iyi-parti      36    38       38    'iyi partili'
//   asgari-ucret    5     6        6    'asgari ücretli', 'asgari ücretlilerin'
//   pkk            11    12       12    'pkk/kck'
//
// The 125 header lists dolar at 70% recall as a gap. It is not: the misses are
// "dolarlık" and "X milyar dolar" amounts, and they are now excluded on purpose.
// Of the 44 rows the old pattern kept, 42 are sums of money (Patriot sales,
// trade targets, fund crises, "111 doları"); the 2 left are one currency
// report and one "75 milyon ABD doları" (a qualifier between the quantity word
// and "doları", the one known hole). 'dolarlık' is deliberately not a form.
//
// meclis, in two steps. CUE = tbmm | büyük millet meclisi | milletvekili | genel
// kurul | kurtulmuş | chp | akp | ak parti | mhp | dem parti.
//   1. Excludes (foreign and municipal cues) took 409 rows to 313. CUE
//      retention was 0.89 (251/281): of the 30 CUE rows dropped, 19 were
//      municipal councils, 10 Israeli or Libyan politics and 1 Luxembourg's
//      parliament, where a party name or "milletvekili" is the whole CUE.
//      Swapping the bare 'israil' and 'iran' for 'israil meclis' and 'iran
//      meclis' reached only 0.92 while letting 20 more rows in. A phrase list
//      could not close the rest: about 11 foreign or municipal rows (an Albanian
//      parliament, an Egyptian approval, Bakırköy, Milas and İzmir municipal
//      stories) and about 14 chamber-of-commerce "meclis" rows (İTO, MTO, ATSO)
//      stayed among the newest 50 rows without CUE.
//   2. Requires (this step) took 313 rows to 255: the bare "Meclis" now needs
//      one cue (tbmm, genel kurul, milletvekil, kanun/yasa teklif, grup
//      toplanti, meclis baskan, kurtulmus, komisyon, butce gorusme or a party
//      name) in the same folded text, and the excludes gained ticaret/sanayi
//      odası, ito, mto, atso, belediyesi meclis, büyükşehir meclis, meclis
//      üyesi and arnavutluk. NEW∩CUE over OLD∩CUE is 242/250 = 0.97 (target
//      0.95; against the first 409 rows it is 242/279 = 0.87, the same
//      municipal and foreign rows as in step 1). The 8 CUE rows dropped are all
//      municipal councils, 7 by 'meclis üyesi' and 1 by 'belediyesi meclis': an
//      MHP'li council member shot in Kocaeli, CHP council members expelled or
//      resigning (Tarsus, Kemer, İBB, 86 who joined Yeni Parti), a Kartal
//      council session and a Sarıyer council decision. One more row, under the
//      wider "milletvekil" cue, is the Albanian parliament, dropped by
//      'arnavutluk' as it should be.
//      Residue (2026-11-01): among the newest 50 NEW rows that match only the bare
//      'Meclis' pattern (not tbmm, not büyük millet meclisi) there are 7. Five are
//      the Turkish parliament ("Meclis'te Yeni Yol grubu düştü", Tanrıkulu's
//      araştırma komisyonu, the Sarıgül fezleke, a soru önergesi) and 2 are
//      foreign, municipal or chamber rows (target at most 2, met exactly): a
//      Gaziantep Ticaret Borsası "meclis başkanı" story and the Kadıköy "CHP
//      meclis grubu" story. Both carry a real cue word, so only a narrower
//      phrase ('ticaret borsas') could close the first; the second reads the
//      same as a TBMM group story and is left alone.
//      Residue (2026-11-09, h96-entityhubs-2): the Gaziantep story went when
//      'meclis baskan' stopped being a cue (it was the matched phrase's own
//      neighbour). The newest 50 rows now hold 6 bare-only rows (11 before), all
//      six the Turkish parliament, and 0 foreign, municipal or chamber rows. The
//      one left anywhere in the 14-day hub is the Kadıköy "CHP meclis grubu"
//      story (0b2e6dc8): "CHP Meclis Grubu" is also how a TBMM group is named
//      ("DEM Parti Meclis Grubu", "Yeni Yol'un Meclis grubu"), so a phrase for it
//      would drop real TBMM rows. It stays.
//
// disisleri and borsa (h43-entities-2, 2026-11-05), measured read-only through
// entity_cluster_ids_v2 with the app's exact arrays, 14-day window, live
// clusters; the JS twin and PostgreSQL agree on all 186 + 38 old rows:
//   disisleri  186 -> 129   57 dropped, 0 added; all 73 patterns of the 62
//                           entities compile in Postgres
//   borsa       38 ->  24   14 dropped, 0 added: 8 New York, 2 Asia, 2 Binance
//                           (crypto) and 2 Ticaret Borsası (commodity exchange)
// Residue left in disisleri, by design of a one-word lookbehind: a second,
// unprefixed mention in the same text (the original headline of a cluster whose
// neutral title says "Almanya Dışişleri", "Dışişleri de sessiz kaldı" in an
// Israeli story, "Başbakan Yardımcısı ve Dışişleri Bakanı" compounds) and
// countries that are not in the list (Yemen, Küba, Norveç, Filistin, İsviçre).
// h110-trendsdata-2 (2026-11-10) closed the two gaps it names: the countries, and the compounds.
//
// disisleri (h110-trendsdata-2, 2026-11-10), measured read-only through entity_cluster_ids_v3 with the app's exact
// arrays (queries 'dışişleri' and 'dişişleri'), 14-day window, live clusters; the JS twin and PostgreSQL agree on
// the 8 behaviour samples of entity-hub.test.ts (4 out, 4 in) and on all 102 old rows, and the pattern compiles in
// Postgres (457 -> 830 characters, 0.4 s for the 102-row scan):
//   disisleri  102 -> 87   15 dropped, 0 added. 9 of the 20 cards of page 1 were another country's minister and all
//                          9 are gone (Fransa 043232d8 and ABD 5bc79ba5 through 'G7 Dışişleri Bakanları' in the lead,
//                          Katar accec1ab and b07dcedc through 'Başbakanı ve', Ürdün 3b682787, Filistin 0818550a,
//                          Küba 46163338, Hollanda 9f791a90, İtalya 122617de through 'Yardımcısı ve'). The other 6:
//                          Katar 15396627, Yemen 59305767 and 1b57abb6, İsviçre 44272989, Finlandiya 6b80373d and
//                          Kazakistan ac27be25. Every one was read by hand: none of the 15 is the Turkish ministry,
//                          each is another state's (or, for the G7 pair, another state's minister at a G7 meeting).
//   The new page 1 is the next 9 clusters by first_published (all the Turkish ministry, Fidan or Keçeli, plus one
//   North Korean story, 51101680: its lead says 'Kuzey Kore ... tepki gösterdi. Dışişleri Bakanlığı, ...' with no
//   country word right before 'Dışişleri', the residue of a one-word lookbehind that stays).
//   'g20' is not in the list (Turkey is a G20 member). With it the hub dropped 19, not 15 (102 -> 83): the four
//   G20 Dışişleri Bakanları meeting stories 14916071, 447e9bc7, 77b5d6f6 and 22c347c7. The last is the Turkish
//   minister ('Fidan ... G20 dışişleri bakanları toplantısına katıldı'; its summary lead glues the sentence,
//   'katıldıDışişleri Bakanı Hakan Fidan', where `\m` finds no word start, so only the G20 occurrences could match
//   it). Keeping 'g20' out brings all four back; the other three are G20 meeting stories that do not name the Turkish
//   ministry (Lavrov and the family photo, the closing statement), a known residue of that choice.
// The tally behind the list (word directly before 'dışişleri', live clusters, 30 days, by clusters): iran 50, abd 28,
// tbmm 20, rusya 16, ve 14, g20 13, kktc 10, cin 9, fransa 9, almanya 7, yemen 7, belçika 6, e3 6, filistin 4, kuba 3,
// bae 2, bulgaristan 2, finlandiya 2, g7 2, hollanda 2, irak 2, isviçre 2, kanada 2, ürdün 2 ... The Turkish or
// Turkish-hosted words are left out: ve, eski, tbmm, meclis (TBMM Dışişleri Komisyonu), tdt and teşkilatı (Türk
// Devletleri Teşkilatı), r4 and e3 (the R4+E3 meeting Fidan hosted), iit, cumhuriyeti, anand (the Canadian
// minister visiting the Turkish ministry), and g20 (Turkey is a G20 member: 'Bakan Fidan, G20 Dışişleri Bakanları
// Toplantısı' is the Turkish minister).
//
// erdogan and akp (h56-entities-1 and h56-entities-2, 2026-11-06), measured read-only with the app's exact arrays, 14-day
// window, live clusters; the JS twin and PostgreSQL agree on all 421 candidate rows of erdogan:
//   erdogan  410 -> 370   42 dropped (16 Emine, 15 Bilal, 5 Fatih and Asuman, 2 Canan, 2 Yılmaz, 1 Filiz, 1 Meryem
//                         Erdoğan), 2 added (the glued "Cumhurbaşkanı Erdoğanın"); none of the dropped rows carries
//                         "cumhurbaşkanı erdoğan" or "recep tayyip erdoğan". The excludes veto the story, the notAfter
//                         skips one occurrence; the two presidential forms are trusted.
//   akp      303 -> 174   129 dropped, 0 added, by headlineOnly: the regex ignores the summary lead and runs on
//                         title_tr + title_tr_neutral (migration 170, entity_cluster_ids_v3); every other hub keeps the lead.
//
// tcmb requires (h61-emptystates-2, 2026-11-07), measured read-only with the app's exact arrays (queries
// 'merkez bankası', 'merkez bankasi', 'tcmb'): the bare "Merkez Bankası" is any country's, and the ten
// foreign excludes only name the banks someone thought of. The non-trusted form now also needs one of 14
// folded cues (tcmb, karahan, ppk, para politika, faiz, enflasyon, rezerv, turk lira, doviz, kur korumal,
// turkiye cumhuriyet merkez, piyasa katilimci, tbmm, repo); 'TCMB' stays bare. The excludes, the trusted
// form and the tokens are unchanged, so /trends (migration 163) is not touched: it never reads `requires`.
//   14-day hub    1 -> 0    the only card was Paraguay's Ueno Bank crisis (c377938c); the /gundem chip
//                           then reads "son 14 günde haber yok"
//   30-day hub    4 -> 1    dropped: c377938c, the 15-arrest fund probe (49dbf40b, the bank only as a
//                           suspect's former title) and the Tarakçı indictment (65a1e2e7, a bank
//                           intervention named as a consequence); kept: the 22 October rate cut (7760be5f)
//   120 days of every cluster that names the bank, archived and single-article ones too (230 old matches):
//                 230 -> 183   the 47 dropped are foreign banks (Paraguay, Özbekistan, Bulgaristan, Kanada,
//                           Güney Kore, Irak, Mısır, Suriye, G20 summaries) or stories where the bank is a
//                           title, an epithet or a side mention; 7 Turkish stories that carry none of the
//                           cues stay lost (a housing-data release, a deposits statistic, an opposition
//                           statement)
//   of those 230, the 24 with article_count >= 2 (what the hub lists): 17 stay, all Turkish central-bank
//   stories (rate decisions, Karahan before the TBMM, liquidity measures, inflation expectations); the
//   7 dropped are Paraguay, the two stories above, a Babacan fund-crisis statement, two G20 summaries
//   and a Turkey-Palestine banking agreement.
// "tbmm" and "repo" were added after that replay (three Turkish stories back, no foreign one); the
// generic words ("faiz", "enflasyon", "rezerv", "doviz", "para politika") each let in about as many
// Turkish stories as foreign ones and stay. JS twin and PostgreSQL agree on the 35 behaviour samples of
// entity-hub.test.ts.
// Residue: a generic word still lets a foreign bank in when no named exclude catches it. Read by title,
// the 120-day sample holds 6 such single-article clusters (Iran's central bank governor on foreign
// exchange, India's reserves, a Philippine rate rise, two Palestinian banking-sector statements); none
// had two articles, so none reaches the hub. Closing them needs more foreign names in `excludes`, which
// migration 163 mirrors word for word, so it is a migration and not an app-side change.
//
// person and ministry hubs (h96-entityhubs-1, 2026-11-09), measured read-only with the app's exact arrays through
// the body of entity_cluster_ids_v3 (p_headline_only false), 14-day window, live clusters, before and after each
// hub's own spec change; the stemmed prefilter reaches every row the regex accepts (the no-prefilter ceiling is
// equal to the listed count for all five):
//   simsek     19 -> 27   +8, 0 dropped: the five 'Bakan Şimşek' stories (4e006e95, 3b041b3c with 19 articles,
//                         71110c3b with 17, 758e72ad, 1edc2e33) and three that name him as 'Bakan Şimşek' only in a
//                         neutral title or the summary lead
//   fidan      44 -> 48   +4, 0 dropped: c05ed0eb and e3262ca6 ('Dışişleri Bakanı Fidan ...'), a Rubio story whose
//                         neutral title is 'Bakan Fidan ...', and a question to 'Dışişleri Bakanı Fidan'
//   meb        11 -> 47   +36, 0 dropped: 'Milli Eğitim Bakanı (Yusuf) Tekin' stories and the ministry's own
//                         announcements; the Syrian ministry (13d5948d) is vetoed, the 'Millî' spelling needed two
//                         inflections for the prefilter
//   msb        17 -> 34   +17, 0 dropped: 'Milli Savunma Bakanı Güler' meetings and ministry announcements; one
//                         row is a 1920s minister named in a medal story (9a550953), the known false positive
//   imamoglu   60 -> 58   -2, 0 added: the Adana district shooting (c828192c) and the Tuğberk İmamoğlu ship (848f51b2)
// meclis (h96-entityhubs-2, 2026-11-09), same read: 252 -> 234, 18 dropped, 0 added; the prefilter ceiling is 235
// (one 'Meclisin en genç milletvekili' story, a stemming gap that was there before). The 18 dropped are exactly the
// party, foreign, municipal and NGO rows of the finding: Parti Meclisi (01cbab9a, 430bacd3, e04f9346, 53c4123b), the
// KKTC (b9601948, d448df20), Croatia (31342903, 2a7e585a), Federal Meclis (048a9b43, 095d29d1), İBB Meclisi (4b46258c,
// 4cc69420), Danışma Meclisi (0f16f0f5, f5b282b7), Kadın Meclisi (278eb682), Barış Anneleri (892a7e64), İSİG (7b66c93b)
// and the Gaziantep Ticaret Borsası (2c54476c). No TBMM row was lost: every one of the 18 was read by hand.
//
// generic-word hubs (h128-hubs-1, 2026-11-11 ~15:54Z), measured read-only through entity_cluster_ids_v3 with the app's exact
// arrays and, row by row, as a plain select of the same body over the 14-day window and over 365 days (live clusters);
// the JS twin and PostgreSQL agree on all 607 replayed rows, and 57 of the 62 hubs have byte-identical queries and patterns
// (akp 190, chp 150, tcmb 1, meclis 245 and disisleri 88 return what they returned before):
//   enflasyon     24 -> 20   4 dropped (Vance on the midterms b6fe7960, "ABD sandık başında" c89215b1, the Fed 4619dcb5, and the
//                            Dolar/TL report 9f7c27c3 that says "enflasyon" in one lead clause); 365 days 175 -> 155
//   faiz          18 -> 11   7 dropped (the Fed, ING on the midterms, three gold stories naming US yields); 365 days 120 -> 72
//   dolar         11 ->  3   8 dropped (the US-election gold and market wraps); 365 days 47 -> 36. No bare "abd": it removes the
//                            Turkish lira report 9f7c27c3 and the Turkish dollar-swap stories
//   borsa         21 -> 18   3 dropped (the midterm wraps 2a6b4822 and 0ef5843d, the Chinese regulator 75ff029b); 365 days 125 -> 119
//   asgari-ucret  17 -> 16   1 dropped (Bangladeshi textile workers 7b83daa0); 365 days 49 -> 48
// Every dropped row was read by hand: none of the 14-day ones is a Turkish story about its hub's topic. The cost of the bare
// "abd" on enflasyon, over 365 days, is two Şimşek statements whose lead names the US-Iran war (eaf2af47, a53c3e7b). The
// summary lead stays in the text: the 8 emekli-zam stories of the 14-day enflasyon hub (32 in 365 days) all stay, where the
// headline alone would have dropped 14 of its 24 rows. Left in on purpose: the Hatay burglary c9e1b994 under dolar (its headline
// says "dolar") and the Turkish passing mentions 5a01e024 and be844f70 under enflasyon. dolar is now 3 clusters, the indexable
// floor; a hub under it is noindex by entityHubRobots, unchanged.
// ---------------------------------------------------------------------------

const FOLD_MAP: ReadonlyMap<string, string> = (() => {
  const from = [...RISING_FOLD_FROM];
  const to = [...RISING_FOLD_TO];
  return new Map(from.map((ch, i) => [ch, to[i] as string]));
})();

/**
 * JS twin of the SQL fold in migration 125 (and 112):
 * `lower(translate(text, FOLD_FROM, FOLD_TO))`. `translate` runs BEFORE
 * `toLowerCase`, so the capital dotted İ and the capital dotless I both become
 * a plain "i" instead of the two-code-point "i̇" that JS lowercasing gives İ.
 */
export function foldEntityText(text: string): string {
  let folded = "";
  for (const ch of text) folded += FOLD_MAP.get(ch) ?? ch;
  return folded.toLowerCase();
}

// A Map, not an object lookup, for the same reason as ENTITY_BY_KEY.
const HUB_SPEC_BY_KEY: ReadonlyMap<string, RisingHubSpec> = new Map(
  Object.entries(RISING_HUB_SPECS),
);

/** The hub-only search data for an entity; `{}` (label, whole word) when none is curated. */
export function entityHubSpec(entity: RisingEntity): RisingHubSpec {
  return HUB_SPEC_BY_KEY.get(entity.key) ?? {};
}

/**
 * Whether the hub's regex runs on the headlines only (title_tr and
 * title_tr_neutral, never the summary's first line): the spec's `headlineOnly`,
 * the literal `true`, curated on akp alone (migration 170). `spec` defaults to
 * the curated one; tests pass their own. It only picks a column of the RPC and
 * never changes `entityHubQueries` or `entityHubPatterns`.
 */
export function entityHubHeadlineOnly(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): boolean {
  return spec.headlineOnly === true;
}

/** What a headline-only hub (akp) says it searches: a name that sits only in the summary is not listed. */
const HUB_NOTE_HEADLINE_ONLY =
  "Eşleşme, küme başlığında geçen ada göre yapılır; adı yalnızca özette geçen haberler listelenmez. Eş adlı kişi ve kurumlar karışabilir.";
/**
 * What every other hub says it searches: the headline and the summary's first line (its first paragraph; for
 * almost every cluster the whole summary). Not "first sentence": on prod most first lines hold several sentences.
 */
const HUB_NOTE_HEADLINE_AND_LEAD =
  "Eşleşme, küme başlığında ve özetin ilk paragrafında geçen ada göre yapılır; eş adlı kişi ve kurumlar karışabilir.";

/**
 * The line under a hub's count that says what the hub actually searches
 * (h128-hubs-1). It used to be one static sentence on all 62 hubs claiming a
 * "tam metin" search, but the hub regex never sees the body: it runs on
 * title_tr, title_tr_neutral and the FIRST LINE of summary_tr (migration 156),
 * and for a `headlineOnly` hub (akp, migration 170) on the two titles alone, so
 * a story that names the party only in its summary is not listed. The text
 * follows {@link entityHubHeadlineOnly}, the same flag that picks the RPC's
 * column, so the copy and the read can never disagree. Pure; `spec` defaults to
 * the curated one and tests pass their own.
 */
export function hubMatchNote(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string {
  return entityHubHeadlineOnly(entity, spec) ? HUB_NOTE_HEADLINE_ONLY : HUB_NOTE_HEADLINE_AND_LEAD;
}

/**
 * The spellings a hub searches: the curated aliases when there are any, else
 * the label alone. Display spellings, with Turkish letters and capitals.
 * `spec` defaults to the curated one; tests pass their own.
 */
export function entityHubForms(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): readonly string[] {
  return spec.aliases !== undefined && spec.aliases.length > 0 ? spec.aliases : [entity.label];
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * `p_queries` for entity_cluster_ids_v2: the Turkish lexeme spellings
 * (turkishQueryVariants) of every form, then of every curated inflection,
 * deduped and capped at ENTITY_HUB_MAX_TERMS (so a cap can only ever drop an
 * inflection). The RPC ORs them into one websearch tsquery. Inflections widen
 * the prefilter only: entityHubPatterns ignores them.
 */
export function entityHubQueries(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string[] {
  return dedupe(
    [...entityHubForms(entity, spec), ...(spec.inflections ?? [])].flatMap((form) =>
      turkishQueryVariants(form),
    ),
  ).slice(0, ENTITY_HUB_MAX_TERMS);
}

/**
 * Lookbehinds that keep a word out of amounts, for a `quantityGuard` entity:
 * the word may not follow a digit ("100 dolar", "2,1 milyar dolarlık", "49,57
 * dolar") or a quantity word ("bin", "milyon", "milyar", "trilyon",
 * "milyonlarca", "milyarlarca"). PostgreSQL AREs support (?<!...); every one
 * is a single fixed-length alternative, so each is its own lookbehind.
 */
export const QUANTITY_GUARD =
  "(?<![0-9]\\s)(?<![0-9])(?<!bin\\s)(?<!milyon\\s)(?<!milyar\\s)(?<!trilyon\\s)(?<!milyonlarca\\s)(?<!milyarlarca\\s)";

/** The folded, ASCII, non-empty words of a phrase (the shape of a pattern word). */
function foldedWords(text: string): string[] {
  return foldEntityText(text)
    .split(/[^a-z0-9]+/)
    .filter((w) => w !== "");
}

/**
 * One alternative of the exclude and require guards: `\m` + the words joined
 * by `\s+`. It stays open-ended ("polonya" catches "polonyada", "belediye
 * meclis" catches "belediye meclisinde") except for a single word of 3 letters
 * or fewer, which takes `\M`: "fed" must not hit "federasyon", "chp" must not
 * hit "chpx".
 */
function excludeAlternative(words: readonly string[]): string {
  const closed = words.length === 1 && (words[0] as string).length <= 3;
  return `\\m${words.join("\\s+")}${closed ? "\\M" : ""}`;
}

/** The alternatives of a curated phrase list; entries that fold to nothing are dropped. */
function guardAlternatives(phrases: readonly string[] | undefined): string[] {
  return (phrases ?? [])
    .map(foldedWords)
    .filter((words) => words.length > 0)
    .map(excludeAlternative);
}

/**
 * The `notAfter` block: one fixed-length negative lookbehind per entry,
 * `(?<!abd\s)(?<!iran\s)`, so the base word that follows is not directly
 * preceded by a listed word and one whitespace character. An entry that folds
 * to exactly TWO words ("Başbakanı ve") renders `(?<!basbakani\sve\s)`: the
 * two words joined by one literal `\s`, then the closing `\s` (h110-trendsdata-2:
 * "Katar Başbakanı ve Dışişleri Bakanı" and "Başbakan Yardımcısı ve Dışişleri
 * Bakanı" are a foreign minister, and "ve" alone must stay out of the list:
 * "Cumhurbaşkanı Erdoğan ve Dışişleri Bakanı Fidan" is the Turkish one). An entry
 * of three or more words, or one that folds to nothing, is dropped, so every
 * lookbehind is a single literal of fixed length: valid in JavaScript and in
 * PostgreSQL ARE alike. The words are re-joined from the folded pieces, so no
 * metacharacter of the curated text can reach the pattern. Single-word output is
 * byte for byte what it was before two-word entries were allowed. Deduped, in
 * curated order; "" when none is left.
 */
function notAfterGuard(words: readonly string[] | undefined): string {
  const phrases = (words ?? [])
    .map(foldedWords)
    .filter((w) => w.length === 1 || w.length === 2)
    .map((w) => w.join("\\s"));
  return dedupe(phrases)
    .map((phrase) => `(?<!${phrase}\\s)`)
    .join("");
}

/**
 * `p_patterns` for entity_cluster_ids_v2: one PostgreSQL regex (ARE) per form,
 * matched against the folded title and summary. For each form: fold it, split
 * it into words on /[^a-z0-9]+/ and join them with `\s+`.
 *   * single word -> `\m<w>\M` (a word of its own), or `\m<w>` for a
 *     `hubMatch: 'prefix'` entity whose word takes suffixes ("dolara").
 *   * several words -> `\m<w1>\s+<w2>` with NO closing `\M`: the last word may
 *     take a suffix ("AK Partili", "Merkez Bankasının", "asgari ücrete") and
 *     the words being adjacent already keeps it precise.
 * An apostrophe suffix ("DEVA'nın", "Erdoğan'ın") still meets `\M`, because the
 * apostrophe is not a word character. Forms that fold to nothing are dropped.
 *
 * Three optional guards, all built from curated data only:
 *   * `quantityGuard`: a single-word base becomes `\m` + QUANTITY_GUARD + word,
 *     so "100 dolar" and "2,1 milyar dolarlık" are not the currency.
 *   * `excludes`: a form that is not `trusted` is prefixed with
 *     `^(?![\s\S]*(?:<alt>|<alt>))[\s\S]*`, a lookahead over the whole text, so
 *     "Polonya'da ... Anayasa Mahkemesi" never matches.
 *   * `hubExcludes`: vetoes that migration 163 does not mirror for /trends, as a
 *     second negative lookahead right behind the `excludes` one (so the first stays
 *     equal to the SQL list): `^(?![\s\S]*(?:<ex>))(?![\s\S]*(?:<hub-ex>))...`.
 *     Same shape, same open/closed word rule; a trusted form skips it too.
 *   * `requires`: the same form also needs at least one cue anywhere in the
 *     text, a positive lookahead `(?=[\s\S]*(?:<alt>|<alt>))` placed after the
 *     exclude ones: `^(?![\s\S]*(?:<ex>))(?=[\s\S]*(?:<req>))[\s\S]*`. So the
 *     bare "Meclis" of an İTO or a municipal story, with no TBMM cue, is out.
 *   The guard is emitted only when either list holds a usable entry. The
 *   pattern starts with `^`, never `(?`, which Postgres would read as embedded
 *   options. A trusted form ("TCMB", "TBMM") stays bare.
 *   * `notAfter`: `\m` + notAfterGuard + the first word, so "Dışişleri" does not
 *     match right behind "ABD", "İran", "Başbakanı ve" or another listed
 *     country word or two-word compound. It is
 *     part of the base, so it applies to a trusted form too, and it sits after
 *     the amount guard on a `quantityGuard` word. Unlike `excludes` it reads only
 *     the word's own neighbour: a story that names the Turkish ministry once,
 *     unprefixed, still matches.
 */
export function entityHubPatterns(
  entity: RisingEntity,
  spec: RisingHubSpec = entityHubSpec(entity),
): string[] {
  const prefix = spec.hubMatch === "prefix";
  const trusted = new Set(spec.trusted ?? []);
  const excludeAlts = guardAlternatives(spec.excludes);
  const hubExcludeAlts = guardAlternatives(spec.hubExcludes);
  const requireAlts = guardAlternatives(spec.requires);
  const veto = (alts: readonly string[]) =>
    alts.length > 0 ? `(?![\\s\\S]*(?:${alts.join("|")}))` : "";
  const guard =
    excludeAlts.length > 0 || hubExcludeAlts.length > 0 || requireAlts.length > 0
      ? `^${veto(excludeAlts)}${veto(hubExcludeAlts)}${
          requireAlts.length > 0 ? `(?=[\\s\\S]*(?:${requireAlts.join("|")}))` : ""
        }[\\s\\S]*`
      : "";
  const notAfter = notAfterGuard(spec.notAfter);
  const patterns: string[] = [];
  for (const form of entityHubForms(entity, spec)) {
    const words = foldedWords(form);
    if (words.length === 0) continue;
    const body = words.join("\\s+");
    const base =
      words.length > 1
        ? `\\m${notAfter}${body}`
        : spec.quantityGuard === true
          ? `\\m${QUANTITY_GUARD}${notAfter}${body}${prefix ? "" : "\\M"}`
          : `\\m${notAfter}${body}${prefix ? "" : "\\M"}`;
    patterns.push(trusted.has(form) ? base : `${guard}${base}`);
  }
  return dedupe(patterns).slice(0, ENTITY_HUB_MAX_TERMS);
}
