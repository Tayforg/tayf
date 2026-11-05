import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  isRoundupTitle,
  ROUNDUP_SKIP_REASON,
} from "../../../supabase/functions/_shared/cluster/roundup-title.ts";

// Wave BF / W3 (2026-11-02): the daily Resmi Gazete roundups ("Resmi Gazete'de
// bugun: 2 Kasim 2026 Resmi Gazete kararlari") were clustered by title similarity
// into unrelated single-story clusters (bha's 1 Kasim roundup landed in the
// 16-article appointments cluster 85700dfa, the 2 Kasim one in the 15-article
// Cevdet Yilmaz vekalet cluster 8f0bb5b8). isRoundupTitle() recognises whole-title
// roundup shapes so cluster-consumer can skip them. The fixtures below are the
// real titles of a read-only 14-day export (articles.created_at 2026-10-20 ..
// 2026-11-02, 325 rows) plus the shape variants the brief names, so a title that
// is a story stays a story.


describe("ROUNDUP_SKIP_REASON", () => {
  it("is the exact string the cluster-consumer outcome and its summary key off", () => {
    expect(ROUNDUP_SKIP_REASON).toBe("roundup-title");
  });
});

describe("isRoundupTitle: must-skip (the brief's named titles, verbatim)", () => {
  it.each([
    // bha, the two rows that sat in clusters 85700dfa and 8f0bb5b8 (query (a)).
    "Resmi Gazete'de bugün: 2 Kasım 2026 Resmi Gazete kararları",
    "Resmi Gazete'de bugün: 1 Kasım 2026 Resmi Gazete kararları",
    // shape variants
    "Resmi Gazete'de bugün (2 Kasım 2026 Pazar)",
    "RESMİ GAZETE'DE BUGÜN",
    "Resmî Gazete’de bugün - 02.11.2026",
    "Resmi Gazete'de bugün neler var?",
    "2 Kasım 2026 tarihli Resmi Gazete",
    "Bugünkü Resmi Gazete kararları",
    "Günün önemli gelişmeleri",
    "Gündem özeti | 2 Kasım",
    "Sabah bülteni",
    "Akşam Bülteni - 1 Kasım 2026",
    "Haber turu",
  ])("%s", (title) => {
    expect(isRoundupTitle(title)).toBe(true);
  });
});

describe("isRoundupTitle: must-keep (stories, not roundups)", () => {
  it.each([
    "Resmi Gazete'de yayımlandı: Asgari ücret desteği uzatıldı",
    "Atama kararları Resmi Gazete'de: Ankara Valiliğine Vasip Şahin atandı",
    "Merkez Bankası Başkan Yardımcısı atandı: Resmi Gazete'de yayımlandı",
    "Resmi Gazete'de bugün yayımlanan kararla emekli ikramiyesi yükseldi",
    "Erdoğan imzaladı, Resmi Gazete'de yayımlandı: 3 üniversiteye rektör",
    "TRT Akşam Bülteni'nde Bahçeli açıklaması",
    "Gündem özeti: Erdoğan ile Bahçeli görüştü",
    "Sabah bülteni sunucusu istifa etti",
  ])("%s", (title) => {
    expect(isRoundupTitle(title)).toBe(false);
  });

  it.each([
    "",
    " ",
    "\n\t ",
    "...",
    "?!",
    '""',
    "Resmi Gazete",
    "Resmi Gazete'de",
    "Resmi Gazete'de yayımlandı",
    "Resmi Gazete'de yayımlanan kararlar",
    "Resmi Gazete'de bugün yayımlandı",
    "Resmi Gazete'de bugün: Asgari ücret",
    "Bugün",
    "Gündem",
    "Haber",
    "Bülten",
    "Günün özeti: piyasalarda sert düşüş",
    "Haber turu: Erdoğan'dan Kuzey Irak açıklaması",
    "Akşam bülteni: 3 ilde sel",
    "Sabah bülteni 2 Kasım'da yayımlanacak",
    "2 Kasım",
    "02.11.2026",
    "2 Kasım 2026 tarihli Resmi Gazete'de yayımlanan karar",
    "2 Kasım 2026 tarihli Resmi Gazete kararıyla 5 vali değişti",
    "Bugünkü Resmi Gazete'de yayımlanan karar herkesi ilgilendiriyor",
    "Bugünkü Resmi Gazete kararları arasında dikkat çeken düzenleme",
  ])("%j is kept", (title) => {
    expect(isRoundupTitle(title)).toBe(false);
  });
});

describe("isRoundupTitle: input handling", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["NaN", Number.NaN],
    ["true", true],
    ["an object", {}],
    ["an array", ["Haber turu"]],
    ["a function", () => "Haber turu"],
    ["a boxed String", Object("Haber turu")],
    ["a symbol", Symbol("Haber turu")],
  ])("%s is not a roundup (and does not throw)", (_name, value) => {
    expect(isRoundupTitle(value)).toBe(false);
  });

  it("is case-insensitive with Turkish casing (dotted and dotless i)", () => {
    expect(isRoundupTitle("RESMİ GAZETE'DE BUGÜN")).toBe(true);
    expect(isRoundupTitle("resmi gazete'de bugün")).toBe(true);
    expect(isRoundupTitle("Resmi GAZETE'de BUGÜN")).toBe(true);
    expect(isRoundupTitle("GÜNDEM ÖZETİ")).toBe(true);
    expect(isRoundupTitle("AKŞAM BÜLTENİ - 1 KASIM 2026")).toBe(true);
    // ASCII-only typing: an uppercase I lower-cases to a dotless i under 'tr'.
    expect(isRoundupTitle("RESMI GAZETE'DE BUGUN")).toBe(true);
    expect(isRoundupTitle("Gundem ozeti | 2 Kasim")).toBe(true);
  });

  it("folds the circumflex vowels (resmî, hâlâ-style spellings) and NFC-composes decomposed input", () => {
    expect(isRoundupTitle("Resmî Gazete'de bugün")).toBe(true);
    // 'i' + COMBINING CIRCUMFLEX (decomposed) and 'I' + COMBINING DOT ABOVE.
    expect(isRoundupTitle("Resmî Gazete'de bugün")).toBe(true);
    expect(isRoundupTitle("RESMİ GAZETE'DE BUGÜN")).toBe(true);
    expect(isRoundupTitle("Gündem özeti")).toBe(true);
  });

  it.each([
    ["right single quote U+2019", "Resmi Gazete’de bugün"],
    ["left single quote U+2018", "Resmi Gazete‘de bugün"],
    ["backtick", "Resmi Gazete`de bugün"],
    ["acute accent U+00B4", "Resmi Gazete´de bugün"],
    ["modifier letter apostrophe U+02BC", "Resmi Gazeteʼde bugün"],
    ["no apostrophe at all", "Resmi Gazetede bugün"],
  ])("accepts the apostrophe variant: %s", (_name, title) => {
    expect(isRoundupTitle(title)).toBe(true);
  });

  it("collapses and trims whitespace (spaces, tabs, newlines, NBSP)", () => {
    expect(isRoundupTitle("  Resmi   Gazete'de \t bugün  ")).toBe(true);
    expect(isRoundupTitle("Resmi Gazete'de\nbugün")).toBe(true);
    expect(isRoundupTitle("\n\nHaber   turu\r\n")).toBe(true);
    expect(isRoundupTitle("Akşam   Bülteni  -   1   Kasım  2026")).toBe(true);
  });

  it.each([
    "Haber turu.",
    "Haber turu!",
    "Haber turu?",
    "Haber turu…",
    "Haber turu...",
    "Haber turu!?",
    "Haber turu ?",
    '"Haber turu"',
    "'Haber turu'",
    "“Haber turu”",
    "«Haber turu»",
    '"Haber turu."',
    "Sabah bülteni!",
    "Resmi Gazete'de bugün!",
  ])("strips trailing punctuation and wrapping quotes: %s", (title) => {
    expect(isRoundupTitle(title)).toBe(true);
  });

  it("does not strip punctuation or quotes from the middle", () => {
    expect(isRoundupTitle("Haber. turu")).toBe(false);
    expect(isRoundupTitle("Haber 'turu' bitti")).toBe(false);
    expect(isRoundupTitle('Sabah "bülteni"nde')).toBe(false);
  });

  it("is deterministic across repeated calls (no sticky regex state)", () => {
    for (let i = 0; i < 5; i++) {
      expect(isRoundupTitle("Resmi Gazete'de bugün: 2 Kasım 2026 Resmi Gazete kararları")).toBe(true);
      expect(isRoundupTitle("Resmi Gazete'de yayımlandı: Asgari ücret desteği uzatıldı")).toBe(false);
    }
  });
});

describe("isRoundupTitle: the date tail", () => {
  const SEPARATORS = ["-", "–", "—", ":", "|", ","];
  const DATES = [
    "2 Kasım",
    "2 Kasım 2026",
    "02 Kasım 2026",
    "2 Kasım Pazartesi",
    "2 Kasım 2026 Pazartesi",
    "2 Kasım Pazartesi 2026",
    "30 Ekim 2026 Cuma",
    "1 Ocak",
    "15 Şubat 2027",
    "9 Mart 2026 Pazartesi",
    "10 Nisan",
    "1 Mayıs 2026",
    "12 Haziran",
    "3 Temmuz",
    "31 Ağustos 2026",
    "5 Eylül",
    "29 Ekim",
    "11 Kasım",
    "24 Aralık 2026",
    "02.11.2026",
    "2.11.2026",
    "02/11/2026",
    "2/11/2026",
    "02.11.2026 Pazartesi",
    "01.11.2026 Pazar",
  ];

  for (const date of DATES) {
    it(`accepts "${date}" after every separator, with no separator, and wrapped in parentheses`, () => {
      for (const sep of SEPARATORS) {
        expect(isRoundupTitle(`Resmi Gazete'de bugün ${sep} ${date}`)).toBe(true);
        expect(isRoundupTitle(`Resmi Gazete'de bugün${sep}${date}`)).toBe(true);
        expect(isRoundupTitle(`Gündem özeti ${sep} ${date}`)).toBe(true);
        expect(isRoundupTitle(`Akşam Bülteni ${sep} ${date}`)).toBe(true);
        expect(isRoundupTitle(`Resmi Gazete'de yayımlandı ${sep} ${date}`)).toBe(true);
      }
      expect(isRoundupTitle(`Resmi Gazete'de bugün ${date}`)).toBe(true);
      expect(isRoundupTitle(`Resmi Gazete'de bugün (${date})`)).toBe(true);
      expect(isRoundupTitle(`Resmi Gazete'de bugün ( ${date} )`)).toBe(true);
      expect(isRoundupTitle(`Günün özeti (${date})`)).toBe(true);
      expect(isRoundupTitle(`Haber turu - ${date}`)).toBe(true);
      expect(isRoundupTitle(`Resmi Gazete'de yayımlanan kararlar (${date})`)).toBe(true);
      expect(isRoundupTitle(`${date} Resmi Gazete`)).toBe(true);
      expect(isRoundupTitle(`${date} tarihli Resmi Gazete`)).toBe(true);
      expect(isRoundupTitle(`${date} Resmi Gazete kararları`)).toBe(true);
    });
  }

  it("shape B: the date leads", () => {
    expect(isRoundupTitle("2 Kasım 2026 Pazartesi Resmi Gazete kararları")).toBe(true);
    expect(isRoundupTitle("2 Kasım 2026 tarihli Resmi Gazete kararları")).toBe(true);
    expect(isRoundupTitle("02.11.2026 tarihli Resmi Gazete")).toBe(true);
  });

  it("shape C: bugünkü, with and without a date tail", () => {
    expect(isRoundupTitle("Bugünkü Resmi Gazete")).toBe(true);
    expect(isRoundupTitle("Bugünkü Resmi Gazete - 2 Kasım")).toBe(true);
    expect(isRoundupTitle("Bugünkü Resmi Gazete kararları (02.11.2026)")).toBe(true);
  });

  it("shape D: yayımlandı / yayımlanan kararlar REQUIRE a date tail", () => {
    expect(isRoundupTitle("Resmi Gazete'de yayımlandı")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de yayımlanan kararlar")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de yayımlandı - 2 Kasım")).toBe(true);
    expect(isRoundupTitle("Resmi Gazete'de yayımlanan kararlar: 2 Kasım 2026")).toBe(true);
    expect(isRoundupTitle("Resmi Gazete'de yayımlanan kararlar (02.11.2026)")).toBe(true);
  });

  it("shape E: the six bulletin phrases, with and without a date tail", () => {
    for (const phrase of [
      "Günün önemli gelişmeleri",
      "Günün özeti",
      "Gündem özeti",
      "Sabah bülteni",
      "Akşam bülteni",
      "Haber turu",
    ]) {
      expect(isRoundupTitle(phrase)).toBe(true);
      expect(isRoundupTitle(`${phrase} - 2 Kasım 2026`)).toBe(true);
      expect(isRoundupTitle(`${phrase} (2 Kasım)`)).toBe(true);
      expect(isRoundupTitle(`${phrase}: Erdoğan görüştü`)).toBe(false);
      expect(isRoundupTitle(`${phrase} - 2 Kasım 2026 ve devamı`)).toBe(false);
      expect(isRoundupTitle(`Yarınki ${phrase}`)).toBe(false);
      expect(isRoundupTitle(`TRT ${phrase}`)).toBe(false);
    }
  });

  it("a date that is only a prefix of a longer story title is not a tail", () => {
    expect(isRoundupTitle("Resmi Gazete'de yayımlandı: 29 Ekim'de bazı raylı sistemler ücretsiz olacak")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de yayımlandı! 29 Ekim'de toplu taşıma ücretsiz olacak")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün: 2 Kasım'da yürürlüğe girecek düzenleme")).toBe(false);
    expect(isRoundupTitle("Haber turu - 2 Kasım 2026 seçimleri")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün 2 Kasım 2026 2027")).toBe(false);
  });

  it("rejects malformed dates", () => {
    expect(isRoundupTitle("Resmi Gazete'de bugün - 2 Kasimm")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün - 2026")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün - 123 Kasım")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün - 02.11.26")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün - Kasım")).toBe(false);
  });
});

describe("isRoundupTitle: shapes the 14-day export added", () => {
  it.each([
    // bha series: "kararları" typo, and the form without the second "Resmi Gazete".
    "Resmi Gazete'de bugün: 21 Ekim 2026 Resmi Gazete kararlrı",
    "Resmi Gazete'de bugün: 30 Ekim 2026 kararları",
    // haber-global (spor desk), CNN Turk's "Neler Var" header, posta's reversed form.
    "27 Ekim Salı 2026 Resmi Gazete kararları ne?",
    "24 EKİM RESMİ GAZETE KARARLARI: Resmî Gazete’de Neler Var?",
    "RESMİ GAZETE KARARLARI 26 EKİM 2026! Resmi Gazete'de bugünün kararları neler?",
    "RESMİ GAZETE KARARLARI 26 EKİM 2026",
    // haberler-com's daily SEO template.
    "21 Ekim Çarşamba 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 21 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
    // CNN Turk's two daily bulletins, istiklal's "Günün Özeti".
    "2 Kasım 2026 Pazartesi gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
    "22 Ekim Perşembe 2026 gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
    "2 Kasım 2026 Pazartesi gününün önemli gelişmeleri",
    "Günün Özeti (01.11.2026 Pazar)",
  ])("skips %s", (title) => {
    expect(isRoundupTitle(title)).toBe(true);
  });

  it.each([
    // A roundup header that carries ONE decision's story stays a story.
    "21 EKİM RESMİ GAZETE KARARLARI: Gençlik ve Spor Bakanlığı Yurtlarında Bulunan Yemekhane, Kantin ve Diğer İşletmeler Hakkında Yönetmelikte Değişiklik!",
    "30 EKİM RESMİ GAZETE KARARLARI: Sağlık Bakanlığı 2026 yılı 3. Dönem İlk Defa ve Yeniden Atama Kurası ilanı yayınlandı!",
    "Resmi Gazete'de bugün: 2 Kasım 2026 kararıyla vali atandı",
    "2 Kasım 2026 Pazartesi gününün son dakika önemli gelişmeleri: Erdoğan açıkladı",
    "Piyasalarda günün özeti: 20 Ekim 2026 BIST 100'de değişimler ve döviz fiyatları",
    "BIST 100 geriledi, Brent petrol yükseldi! Piyasalarda günün özeti",
    "Oksijen Haftalık Bülten: ’Şampiyonlar’ bölümü bitti, ‘Ligi’ başlıyor",
  ])("keeps %s", (title) => {
    expect(isRoundupTitle(title)).toBe(false);
  });
});

// Every true roundup in the 14-day export (articles created 2026-10-20 .. 2026-11-02), verbatim, one per distinct title.
const EXPORT_ROUNDUPS: readonly string[] = [
  "2 Kasım 2026 Pazartesi gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "2 Kasım 2026 Pazartesi gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "20 Ekim 2026 Salı gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "20 Ekim 2026 Salı gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "21 Ekim 2026 Çarşamba gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "21 Ekim 2026 Çarşamba gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "21 Ekim Çarşamba 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 21 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "22 Ekim 2026 Perşembe gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "22 Ekim Perşembe 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 22 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "22 Ekim Perşembe 2026 gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "23 Ekim 2026 Cuma gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "23 Ekim 2026 Cuma gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "23 Ekim Perşembe 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 23 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "24 EKİM RESMİ GAZETE KARARLARI: Resmî Gazete’de Neler Var?",
  "24 Ekim Cumartesi 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 24 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "26 Ekim 2026 Pazartesi gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "26 Ekim 2026 Pazartesi gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "27 Ekim 2026 Salı gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "27 Ekim 2026 Salı gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "27 Ekim Salı 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 27 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "27 Ekim Salı 2026 Resmi Gazete kararları ne?",
  "28 Ekim 2026 Çarşamba gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "28 Ekim 2026 Çarşamba gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "28 Ekim Çarşamba 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 28 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "29 Ekim 2026 Perşembe gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "29 Ekim Perşembe 2026 Resmi Gazete ATAMA KARARLARI! Bugünün kararları neler? 29 Ekim Resmi Gazete yayımlandı! Resmi Gazete atamalar listesi!",
  "29 Ekim Perşembe 2026 gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "30 Ekim 2026 Cuma gününün son dakika önemli gelişmeleri! (CNN TÜRK 11.30 bülteni)",
  "30 Ekim 2026 Cuma gününün son dakika önemli gelişmeleri! (CNN TÜRK 16.30 bülteni)",
  "30 Ekim Cuma 2026 Resmî Gazete ATAMA KARARLARI! Bugünün kararları neler? 30 Ekim Resmî Gazete yayımlandı! Resmî Gazete atamalar listesi!",
  "31 Ekim Cumartesi 2026 Resmî Gazete ATAMA KARARLARI! Bugünün kararları neler? 31 Ekim Resmî Gazete yayımlandı! Resmî Gazete atamalar listesi!",
  "Günün Özeti (01.11.2026 Pazar)",
  "Günün Özeti (20.10.2026 Salı)",
  "Günün Özeti (21.10.2026 Çarşamba)",
  "Günün Özeti (22.10.2026 Perşembe)",
  "Günün Özeti (23.10.2026 Cuma)",
  "Günün Özeti (24.10.2026 Cumartesi)",
  "Günün Özeti (25.10.2026 Pazar)",
  "Günün Özeti (27.10.2026 Salı)",
  "Günün Özeti (28.10.2026 Çarşamba)",
  "Günün Özeti (29.10.2026 Perşembe)",
  "Günün Özeti (30.10.2026 Cuma)",
  "Günün Özeti (31.10.2026 Cumartesi)",
  "RESMİ GAZETE KARARLARI 26 EKİM 2026! Resmi Gazete'de bugünün kararları neler?",
  "Resmi Gazete'de bugün (01.11.2026)",
  "Resmi Gazete'de bugün (02.11.2026)",
  "Resmi Gazete'de bugün (21.10.2026)",
  "Resmi Gazete'de bugün (22.10.2026)",
  "Resmi Gazete'de bugün (23.10.2026)",
  "Resmi Gazete'de bugün (24.10.2026)",
  "Resmi Gazete'de bugün (27.10.2026)",
  "Resmi Gazete'de bugün (28.10.2026)",
  "Resmi Gazete'de bugün (29.10.2026)",
  "Resmi Gazete'de bugün (31.10.2026)",
  "Resmi Gazete'de bugün neler var?",
  "Resmi Gazete'de bugün: 1 Kasım 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 2 Kasım 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 21 Ekim 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 21 Ekim 2026 Resmi Gazete kararlrı",
  "Resmi Gazete'de bugün: 22 Ekim 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 23 Ekim 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 24 Ekim 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 26 Ekim 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 27 Ekim 2026 Resmi Gazete kararları",
  "Resmi Gazete'de bugün: 30 Ekim 2026 kararları",
];

// Every other title the export's keyword filter returned (single-story Resmi Gazete headlines, 'kırmızı bülten' crime news, SPK / MEB / Karayolları bulletins, ...), verbatim, one per distinct title.
const EXPORT_KEEP: readonly string[] = [
  "\"Fon kanunu\" Resmi Gazete'de: 1 milyon liraya kadar ara ödeme yapılabilecek",
  "12 yıldır kırmızı bültenle aranan firari Büyükçekmece'de yakalandı",
  "12 yıldır kırmızı bültenle aranan firari Büyükçekmece'de yakalandı! Günahı çok büyük",
  "12 yıldır kırmızı bültenle aranan firari yakayı ele verdi",
  "2027 Cumhurbaşkanlığı Yıllık Programı Resmi Gazete’de: Memurlara ek zam var mı? Kariyer meslekler için yeni düzenleme geliyor!",
  "2027 Yıllık Programı Resmi Gazete'de yayımlandı, büyüme hedefi yüzde 4,2 oldu",
  "2027 Yılı Cumhurbaşkanlığı Yıllık Programı Resmi Gazete'de",
  "2027 Yılı Cumhurbaşkanlığı Yıllık Programı Resmi Gazete'de yayımlandı",
  "2027 Yılı Cumhurbaşkanlığı Yıllık Programı, Resmi Gazete'de: Enflasyon hedefi gelecek yıl sonu için yüzde 21",
  "2027 büyüme ve enflasyon hedefleri Resmi Gazete'de",
  "2027 yılı 'Cumhurbaşkanlığı Yıllık Programı' Resmi Gazete'de yayımlandı",
  "21 EKİM RESMİ GAZETE KARARLARI: Gençlik ve Spor Bakanlığı Yurtlarında Bulunan Yemekhane, Kantin ve Diğer İşletmeler Hakkında Yönetmelikte Değişiklik!",
  "29 Ekim'de Marmaray, Başkentray ve İZBAN ücretsiz! Karar Resmi Gazete'de, İstanbul Havalimanı metrosu da dahil",
  "29 Ekim’de 5 raylı sistem hattı ücretsiz olacak! Resmî Gazete’de yayımlandı",
  "3 bakanlığa yeni müdürlük! Resmi Gazete'de yayımlandı",
  "30 EKİM RESMİ GAZETE KARARLARI: Sağlık Bakanlığı 2026 yılı 3. Dönem İlk Defa ve Yeniden Atama Kurası ilanı yayınlandı!",
  "30 ilde yeni nesil suç örgütüne dev operasyon! Kırmızı bültenli örgüt liderinin WhatsApp ağı ifşa oldu",
  "33 şüpheli kırmızı bültenle aranıyordu: 8 ülkeden 63 firari Türkiye'ye getirildi!",
  "33'ü Kırmızı Bültenle Aranıyordu! 63 Kişi Yakalanarak Ülkeye Getirildi",
  "33'ü kırmızı bültenle aranıyordu! Survivor yarışmacısı ve oyuncu dahil 63 suçlu Türkiye'ye getirildi",
  "33’ü hakkında kırmızı bülten vardı: Aranan 63 kişi Türkiye’ye getirildi",
  "33’ü kırmızı bültenle aranan 63 suçlu Türkiye’ye getirildi! İçişleri Bakanı Çiftçi: Sınır ötesi kapan daralıyor!",
  "Acele kamulaştırma kararı! Resmi Gazete'de yayımlandı",
  "Aile meclisinde karar alıp öldürmüşlerdi: Suzan'ın katil zanlısına kırmızı bülten",
  "Atama kararları Resmi Gazete'de: SPK Başkanlığı'na Muhsin Atcı atandı",
  "Atama kararları Resmi Gazete’de! Bakanlıklarda görev değişikliği",
  "Atama ve Görevden Alma Kararları Resmi Gazete'de",
  "Atama ve görevden alma kararları Resmi Gazete'de",
  "Atama ve görevden alma kararları Resmi Gazete'de yayımlandı",
  "Atama ve görevden alma kararları Resmi Gazete'de!",
  "Avrupa'yı dolandıran çetenin beyni: Euro Mehmet için kırmızı bülten kararı-",
  "Avusturya’dan 'Euro Mehmet' için kırmızı bülten talebi: Düğün fotoğrafı milyarlık dolandırıcılık ağını ortaya çıkardı!",
  "BIST 100 geriledi, Brent petrol yükseldi! Piyasalarda günün özeti",
  "Bakan Çiftçi: Son bir ayda kırmızı bültenle ve ulusal seviyede aranan 63 suçlu Türkiye'ye getirildi",
  "Başkan Erdoğan imzaladı... Atama ve görevden alma kararları Resmi Gazete'de",
  "Bilgilendirilmiş Rızanın elektronik ortamda alınması yönetmeliği Resmî Gazete’de",
  "Bilgilendirilmiş rızanın elektronik ortamda alınmasına ilişkin yönetmelik Resmi Gazete'de",
  "Cezaevinden kaçıp Almanya'ya gitmişti: Kırmızı bültenli hükümlü 12 yıl sonra İstanbul'da yakalandı",
  "Cezaevinden kaçıp Avrupa'ya gitmişti: Kırmızı bültenle aranan firari İstanbul'da ortaya çıktı",
  "Cumhurbaşkanlığı 2027 Yıllık Programı Resmi Gazete'de",
  "Cumhurbaşkanlığı'na Cevdet Yılmaz'ın vekalet etmesine dair tezkere Resmi Gazete'de",
  "Cumhurbaşkanı Erdoğan İmzaladı: Memurları İlgilendiren Düzenleme Resmî Gazete'de Yayımlandı",
  "Dizi oyuncusu Cengizhan Yurdutek yakalandı: Kırmızı bültenle Türkiye'ye getirildi",
  "Dünyanın kırmızı bültenle aradığı baron İzmir'de yakayı ele verdi",
  "EPDK kararı Resmî Gazete’de: Konutlarda doğal gaz tüketim sınırı yıllık 3 bin kWh’a düşürüldü",
  "EPDK'nın Emisyon Ticaret Piyasası yönetmeliği Resmi Gazete'de yayımlandı",
  "Enerjide acele kamulaştırma kararı Resmi Gazete'de",
  "Erdoğan imzaladı: Atama ve görevden alma kararları Resmi Gazete'de",
  "Erdoğan imzaladı: Memurları ilgilendiren düzenleme Resmi Gazete'de",
  "Erdoğan imzaladı: Memurları ilgilendiren yönetmelik değişikliği Resmi Gazete’de",
  "Fon Kanunu Resmi Gazete'de",
  "Fon Kanunu Resmi Gazetede yayımlandı",
  "Fon Tasfiye Kanunu Resmî Gazete'de yayımlandı: 1 milyon liraya kadar ödeme ve sorumluların mal varlığından tahsilat",
  "Fon düzenlemesi Resmi Gazete'de! Yatırımcıya 1 milyon TL ara ödeme yapılacak",
  "Fon kanunu Resmi Gazete'de",
  "Fon kanunu Resmi Gazete'de yayımlanarak yürürlüğe girdi",
  "Fon kanunu Resmi Gazete'de yayımlandı",
  "Fon kanunu Resmi Gazete'de: 9 soruda düzenlemenin etkileri",
  "Fon kanunu Resmi Gazete'de: Artık yürürlükte",
  "Fon kanunu Resmi Gazete’de yayımlandı",
  "Fon kanunu, Resmi Gazete'de yayımlandı",
  "Fon mağdurlarına yönelik kanun Resmi Gazete'de yayımlandı",
  "Fon mağdurlarına yönelik kanun Resmî Gazete’de yayımlandı",
  "Fon yasası Resmi Gazete’de yayımlandı: 1 milyon TL ara ödemenin detayları",
  "Fonların tasfiyesini düzenleyen kanun Resmi Gazete'de yayımlanarak yürürlüğe girdi",
  "HSK bazı ilçelerin yargı çevrelerini yeniden belirledi! Karar Resmi Gazete'de yayımlandı",
  "HSK kararı Resmi Gazete’de yayımlandı: Üç ilçenin yargı çevresi değişti",
  "HSK kararı Resmî Gazete’de: 3 ilçede ağır cezanın adresi değişti",
  "HSK'nin üç ilçeye ilişkin yargı çevresi kararı Resmi Gazete'de",
  "Hangi Hisselerin Bugün Hareketli Olması Bekleniyor? İş Yatırım'dan Teknik Bülten Açıklamaları",
  "INTERPOL Gümüş Bülten/Difüzyonu",
  "Interpol arıyordu! Kırmızı bültenli suçluya operasyon",
  "Interpol kırmızı bültenle arıyordu: Büyükçekmece'de yakalandı",
  "Interpol kırmızı bültenle arıyordu: Ordu'da yakalandı",
  "Interpol'ün kırmızı bültenle aradığı Gürcistan uyruklu hükümlü Ünye'de yakalandı",
  "Interpol'ün kırmızı bültenle aradığı Gürcistan vatandaşı Ordu'da yakalandı",
  "Interpol'ün kırmızı bültenle aradığı zanlı Büyükçekmece'de yakalandı",
  "Interpol'ün kırmızı bültenle aradığı Ö.G., Büyükçekmece'de operasyonla yakalandı",
  "Interpol’ün kırmızı bültenle aradığı, çocuk istismarı suçundan 6 yıl hapis cezası bulunan Ömer Güney İstanbul’da yakalandı",
  "Jandarmayı oyalayıp, kaçırdılar... Kırmızı bültenli lüks firar",
  "Kamuda üst düzey atamalar ve görevden almalar Resmî Gazete'de",
  "Karar Resmi Gazete'de! Bazı taşınmazlar kamulaştırılacak",
  "Karar Resmi Gazete'de... Fon kanunu yürürlüğe girdi",
  "Karar Resmi Gazete'de.... SPK'nın Yeni Başkanı Muhsin Atcı oldu",
  "Karar Resmi Gazete'de: SPK Başkanlığına Muhsin Atcı atandı",
  "Karar Resmi Gazete'de: SPK'nın Yeni Başkanı Muhsin Atcı oldu",
  "Karayolları bülteni çalışma yapılan yollarda ulaşımın etkilendiğini bildirdi",
  "Karayolları bültenine göre Trabzon-Rize yolunda tünel bakımı 17.00'ye kadar sürüyor",
  "Karayolları bültenine göre birçok güzergahta çalışma var, sürücüler dikkatli olmalı",
  "Karayolları bültenine göre birçok yolda çalışma var, sürücüler yavaş gitmeli",
  "Kurumlar Arası Geçici Görevlendirme Yönetmeliği değişti! Resmi Gazete'de yayımlandı",
  "Kırmızı Bültenle Aranan 63 Kişi Türkiye’ye Getirildi: Listede Ünlü İsimler de Var",
  "Kırmızı Bültenle Aranan Belçikalı Uyuşturucu Baronu İstanbul'da Yakalandı",
  "Kırmızı Bültenle Aranan Çocuk İstismarcısı İstanbul'da Yakalandı",
  "Kırmızı bülten aranan kişi Ordu'da yakalandı",
  "Kırmızı bültenle aranan 33 kişi dahil 63 firari 8 ülkeden Türkiye’ye getirildi",
  "Kırmızı bültenle aranan 63 kişi Türkiye'ye getirildi: Aralarında Hikmet Tuğsuz ve Cengizhan Yurdutek de var",
  "Kırmızı bültenle aranan Belçikalı baron İstanbul'da yakalandı",
  "Kırmızı bültenle aranan Gürcistan uyruklu hükümlü Ordu'da yakalandı",
  "Kırmızı bültenle aranan Gürcistan vatandaşı Ordu'da yakalandı",
  "Kırmızı bültenle aranan Gürcistan vatandaşı Ünye’de yakalandı",
  "Kırmızı bültenle aranan Survivor yarışmacısı Hikmet Tuğsuz, Türkiye'ye getirildi",
  "Kırmızı bültenle aranan hükümlü Ordu'da yakalandı",
  "Kırmızı bültenle aranan hükümlü İstanbul'da yakalandı",
  "Kırmızı bültenle aranan şahıs Büyükçekmece’de yakalandı",
  "Kırmızı bültenle aranıyordu! Ordu'da yakalandı",
  "Kırmızı bültenle aranıyordu! Sıfır Bir ve Kıyma oyuncusu Türkiye'ye iade edildi",
  "Kırmızı bültenle aranıyordu, Türk polisi İzmir'de yakalandı",
  "Kırmızı bültenle aranıyordu... Valmir Berısha yakalandı",
  "Kırmızı bültenle aranıyordu: Suç makinesi İstanbul'da yakalandı",
  "Kırmızı bültenle aranıyordu: Yabancı uyruklu hükümlü Ordu'da yakalandı",
  "Kırmızı bültenle aranıyorlardı! 63 suçlu Türkiye’ye getirildi",
  "Kırmızı bültenle aranıyorlardı: Türkiye'ye getirildiler",
  "Kırmızı bültenle ve ulusal seviyede aranan 63 firari suçlu Türkiye'ye getirildi",
  "Kırmızı bültenli hükümlü yakalandı! Suç dosyası şoke etti",
  "Kırmızı bültenli hükümlü İstanbul'da yakalandı",
  "MEB aile bülteninin ekim sayısı okul öncesini ele aldı",
  "MEB'in \"Aile Eğitim Bülteni\" ekim sayısı yayımlandı",
  "MEB'in ekim ayı aile eğitim bülteni okul öncesi eğitim temasıyla erişime açıldı",
  "Markanız Bültende Yayımlandı: İlk İki Ay Neden Kritik?",
  "Mavi ve kırmızı bültenle aranıyorlardı! İstanbul'da kıskıvrak yakalandılar",
  "Mavi ve kırmızı bültenle aranıyorlardı: Sarıyer'de yakalandılar",
  "Milletlerarası anlaşma Resmi Gazete'de",
  "Milletlerarası anlaşma Resmi Gazete'de yayımlandı",
  "Milletlerarası anlaşma Resmi Gazete'de yayımlandı!",
  "MİT ve emniyetten İzmir'de ortak nokta operasyonu! Almanya'nın kırmızı bültenle aradığı isim yakalandı",
  "Oksijen Haftalık Bülten: ’Şampiyonlar’ bölümü bitti, ‘Ligi’ başlıyor",
  "Ordu'da kırmızı bülten operasyonu: Aranan hükümlü yakalandı",
  "Ordu'da kırmızı bültenli avı! Türk polisi saklandığı evde yakaladı",
  "Ordu'da operasyon: Kırmızı bültenle aranan şahıs yakalandı",
  "Piyasalarda günün özeti: 20 Ekim 2026 BIST 100'de değişimler ve döviz fiyatları",
  "Piyasalarda günün özeti: 21 Ekim 2026 BIST 100'de değişimler ve döviz fiyatları",
  "Piyasalarda günün özeti: 30 Ekim 2026 BIST 100'de değişimler ve döviz fiyatları",
  "Resmi Gazete yayımladı: EPDK enerji piyasalarında açıklanacak verileri belirledi",
  "Resmi Gazete yayımladı: HSK’den başsavcı ve vekillerin iş yüküne ilişkin yeni düzenleme",
  "Resmi Gazete'de Yayımlandı! 81 İlde Yeni Müdürlükler Kuruluyor",
  "Resmi Gazete'de Yayımlandı: Bakanlıklarda Yeni Atama ve Görevden Almalar",
  "Resmi Gazete'de Yayımlandı: SPK Başkanlığı'na Muhsin Atcı Atandı",
  "Resmi Gazete'de atama ve görevden alma kararları: Çok sayıda il müdürü değişti",
  "Resmi Gazete'de yayımlanan kararla netleşti: 29 Ekim'de 3 büyükşehirde o hatlardan ücret alınmayacak",
  "Resmi Gazete'de yayımlanan yönetmelikle bilgilendirilmiş rıza e-Nabız'dan alınacak",
  "Resmi Gazete'de yayımlandı! 'Yarısı Bizden Desteği' o tarihe kadar uzatıldı",
  "Resmi Gazete'de yayımlandı! 29 Ekim'de bazı toplu taşıma ücretsiz olacak",
  "Resmi Gazete'de yayımlandı! 29 Ekim'de toplu taşıma ücretsiz olacak",
  "Resmi Gazete'de yayımlandı! HSK bazı ilçelerin yargı çevrelerini yeniden belirledi",
  "Resmi Gazete'de yayımlandı! Hastanelerde yeni dönem başlıyor! Sistem değişti",
  "Resmi Gazete'de yayımlandı! Perşembe günü bedava hizmet verecek",
  "Resmi Gazete'de yayımlandı! Üç bakanlığa yeni birimler!",
  "Resmi Gazete'de yayımlandı: 'Fon kanunu' yürürlüğe girdi",
  "Resmi Gazete'de yayımlandı: 29 Ekim'de bazı raylı sistemler ücretsiz olacak",
  "Resmi Gazete'de yayımlandı: 29 Ekim'de ücretsiz olacak",
  "Resmi Gazete'de yayımlandı: AYM'den dikkat çeken emeklilik kararı",
  "Resmi Gazete'de yayımlandı: Cumhurbaşkanlığına Cevdet Yılmaz vekalet edecek",
  "Resmi Gazete'de yayımlandı: Erdoğan'ın yerine Cevdet Yılmaz vekalet edecek",
  "Resmi Gazete'de yayımlandı: Fon kanunu yürürlüğe girdi",
  "Resmi Gazete'de yayımlandı: HSK, bazı ilçelerin yargı çevrelerini yeniden belirledi",
  "Resmi Gazete'de yayımlandı: HSK, ilçelerin yargı çevrelerini yeniden belirledi",
  "Resmi Gazete'de yayımlandı: Kamuda müdür atamalarına yeni şart",
  "Resmi Gazete'de yayımlandı: Kentsel dönüşüm desteği uzatıldı",
  "Resmi Gazete'de yayımlandı: Memurlar için yeni ücret sistemi",
  "Resmi Gazete'de yayımlandı: Sağlık Bakanlığı atama kurası takvimi",
  "Resmi Gazete'de yayımlandı: Sosyal medyada 15 yaş sınırı yürürlüğe girdi",
  "Resmi Gazete'de yayımlandı: Tasfiye edilen fonlar için yeni yasal düzenleme yürürlükte",
  "Resmi Gazete'de yayımlandı: Turistik amaçlı kiralık konutlarda yeni dönem",
  "Resmi Gazete'de yayımlandı: Turizm amaçlı konut kiralamasında yeni dönem",
  "Resmi Gazete'de yayımlandı: Yargıtay'dan dikkat çeken karar",
  "Resmi Gazete'de yayımlandı: Üç büyük şehirdeki taşınmazlar için kritik karar!",
  "Resmi Gazete'de yayımlandı: Üç ilçede mahkemelerin yetki alanı değişti",
  "Resmi Gazete'de yayımlandı: İstifa ettiğini söyleyen SPK Başkanı Sütcü görevden alındı",
  "Resmi Gazete’de atama ve görevden alma kararları yayımlandı",
  "Resmi Gazete’de yayımlandı! 3 ilçenin yargı çevresi ...",
  "Resmi Gazete’de yayımlandı: Hastanelerde 'SMS Onaylı' yeni dönem başladı! Elektronik Rıza nedir, nasıl yapılır?",
  "Resmi Gazete’de yayımlandı: Hastanelerde 'SMS onaylı' yeni dönem",
  "Resmi Gazete’de yayımlandı: Hastanelerde yeni dönem",
  "Resmi Gazete’de yayımlandı: İşte 2027 için ekonomi hedefleri",
  "Resmi Gazete’de yayımlandı: ‘Fon kanunu’ yürürlüğe girdi",
  "Resmi Gazete’de çok sayıda atama ve görevden alma kararı",
  "Resmi gazete yayımlandı: Yeni SPK başkanı belli oldu",
  "Resmi gazetede yayımlandı: Milli Eğitim, Milli Savunma ve Aile Bakanlığı'nda görev değişikliği",
  "Resmi gazetede yayımlandı; 3 ilde yapı denetim bölgeleri yeniden çizildi",
  "Resmî Gazete’de yayımlandı! Üç bakanlığın teşkilat yapısı değişti",
  "Resmî Gazete’de yayımlandı: Sağlık Bakanlığı atama kurası takvimi belli oldu",
  "Resmî Gazete’de yayımlandı: Yargıtay’dan sigortalıları ilgilendiren karar",
  "SON DAKİKA | SPK bülteni yayımlandı: Tera Yatırım hakkında faaliyet durdurma ve tasfiye kararı verildi",
  "SON DAKİKA | Tasfiyesine karar verilen fonlara dair kanun Resmi Gazete'de yayımlandı",
  "SPK Başkanlığına Muhsin Atcı atandı! Karar Resmi Gazete'de",
  "SPK Başkanlığına Muhsin Atcı atandı! Resmi Gazete'de yayımlandı",
  "SPK bülteni yayınlandı: 48 kişi hakkında suç duyurusu kararı",
  "SPK bülteninde geniş çaplı yaptırım yayımlandı: 50 kişiye suç duyurusu, 55 kişi ve şirkete işlem yasağı",
  "SPK’dan dev bülten: Suç duyuruları, işlem yasakları ve lisans iptalleri",
  "Sarıyer’de aynı adreste yakalandılar: Biri kırmızı, diğeri mavi bültenle aranıyordu",
  "Son 1 ayda kırmızı bültenle ve ulusal seviyede aranan 63 suçlu Türkiye'ye getirildi",
  "Sosyal medyaya 15 yaş sınırı! Resmi Gazete'de yayımlandı",
  "Sumud Filosu davasında 35 sanık hakkındaki yakalama ve kırmızı bülten emri devam etti",
  "Suzan Elik Cinayetinde Flaş Gelişme: Katil Zanlısı İçin Kırmızı Bülten Çıkarıldı",
  "Suzan Elik cinayeti davasında ikinci duruşma görüldü: Firari Yunus Elik hakkında kırmızı bülten kararı",
  "Suzan Elik cinayeti davasında yeni gelişme! Firari koca için kırmızı bülten çıkarıldı",
  "Suzan Elik'in katiline kırmızı bülten!",
  "Suzan Elik’i öldüren firari sanık hakkında kırmızı bülten çıkartıldı: Sanık ailesinin tutukluluğuna devam kararı",
  "Suzan Elik’in katili Yunus Elik kırmızı bültenle aranıyor: Failin ailesinin yargılandığı duruşma ertelendi",
  "Sırbistan'da İktidar Değişince Spiker Haber Bültenine Özür Dileyerek Başladı",
  "Tasfiye edilen bazı yatırım fonları hakkındaki kanun Resmi Gazete'de yayımlandı",
  "Tasfiye edilen fonların yatırımcılarına 1 milyon liraya kadar ara ödeme! Kanun Resmi Gazete'de yayımlandı",
  "Tasfiye kararı alınan yatırım fonlarına ilişkin düzenleme Resmi Gazete'de",
  "Tasfiyedeki yatırım fonları için yeni düzenleme Resmi Gazete'de",
  "Tasfiyesine karar verilen bazı yatırım fonlarına ilişkin düzenlemeleri içeren kanun Resmi Gazete'de",
  "Tezkere Resmi Gazete'de yayımlandı: Cumhurbaşkanlığına Cevdet Yılmaz vekalet edecek",
  "Türk devletleri arasında 'Dijital Ekonomi' dönemi: Resmi Gazete'de yayımlandı",
  "Türk devletleri arasında Dijital Ekonomi Ortaklık Anlaşması'nın onaylanmasına ilişkin karar Resmi Gazete'de",
  "Türkiye ekonomisinin 2027 hedefleri Resmi Gazete'de",
  "Türkiye ekonomisinin 2027 yılı yol haritası netleşti... Cumhurbaşkanlığı yıllık programı Resmi Gazete'de yayımlandı",
  "Uluslararası bültenle aranıyorlardı, Sarıyer'de yakalandılar!",
  "Yarısı bizden kararı Resmi Gazete'de yayımlandı",
  "Yatırım Fonlarının Tasfiyesine İlişkin Yeni Kanun Resmi Gazete'de",
  "Yatırım fonlarına ilişkin düzenlemeleri içeren kanun Resmi Gazete'de",
  "Yatırım fonlarının tasfiyesi Resmi Gazete'de",
  "Yatırım fonlarının tasfiyesine ilişkin kanun Resmi Gazete'de",
  "Yeni atamalar Resmi Gazete'de: 3 bakanlıkta üst düzey değişiklik",
  "Çekmeköy'de eşin kiralık araçla takip edip kurşun yağdırmıştı: Firari eş için kırmızı bülten çıkarıldı",
  "Çocuğa cinsel istismar dahil birçok suçtan dolayı kırmızı bültenle aranan firari hükümlü İstanbul'da yakalandı",
  "Ülkeye dönüş: kırmızı bültenle aranan 33 ve ulusal 30 kişi Türkiye'ye iade edildi",
  "Üç ilçenin Keşan Ağır Ceza Mahkemesine bağlanması Resmi Gazete'de yayımlandı",
  "İnterpol kırmızı bültenle arıyordu: 12 yıllık firari İstanbul'da yakalandı",
  "İstanbul Sarıyer'de uluslararası operasyon: Kırmızı ve mavi bültenle aranan Moğolistan uyruklu 2 şüpheli yakalandı",
  "İstanbul Sarıyer'deki operasyonda mavi ve kırmızı bültenle aranan 2 şüpheli yakalandı",
  "İstanbul'da uluslararası dev operasyon! Kırmızı ve mavi bültenle aranan iki firari Sarıyer'de lüks adreste yakalandı",
  "İstanbul'da uluslararası operasyon! Kırmızı ve mavi bültenli iki şüpheli Sarıyer'de yakalandı",
  "İstanbul'da uyuşturucu ticaretinden mavi, hırsızlıktan kırmızı bültenle aranan 2 şüpheli yakalandı",
  "İstanbul’da mavi bültenle aranan 2 şüpheli yakalandı",
  "İçişleri Bakanlığı açıkladı: Kırmızı bültenle aranan 33 suçlu yakalandı",
  "İçişleri Bakanlığı açıkladı: Kırmızı bültenle aranan 63 firari suçlu Türkiye'ye getirildi",
  "İçişleri Bakanlığı duyurdu: Kırmızı bültenle aranan 33 kişinin de aralarında olduğu 63 kişi Türkiye'ye getirildi",
  "İçişleri Bakanlığı duyurdu: Kırmızı bültenle ve Ulusal seviyede aranan suçlular yakalandı",
  "’Şampiyonlar’ bölümü bitti, ‘Ligi’ başlıyor Oksijen Haftalık Bülten:",
];

describe("isRoundupTitle: the 14-day export, row by row", () => {
  it("fixtures are non-trivial and disjoint", () => {
    expect(EXPORT_ROUNDUPS.length).toBeGreaterThanOrEqual(60);
    expect(EXPORT_KEEP.length).toBeGreaterThanOrEqual(200);
    const roundups = new Set(EXPORT_ROUNDUPS);
    expect(roundups.size).toBe(EXPORT_ROUNDUPS.length);
    expect(new Set(EXPORT_KEEP).size).toBe(EXPORT_KEEP.length);
    for (const t of EXPORT_KEEP) expect(roundups.has(t)).toBe(false);
  });

  it("every true roundup in the export is skipped", () => {
    const missed = EXPORT_ROUNDUPS.filter((t) => !isRoundupTitle(t));
    expect(missed).toEqual([]);
  });

  it("every other title in the export (every single-story Resmi Gazete headline included) is kept", () => {
    const wronglySkipped = EXPORT_KEEP.filter((t) => isRoundupTitle(t));
    expect(wronglySkipped).toEqual([]);
  });

  it("the export contains the single-story Resmi Gazete headlines of the two clusters that held roundups", () => {
    // Members of 85700dfa and 8f0bb5b8 (query (a)), verbatim: all stories, all kept.
    const members = [
      "Kamuda üst düzey atamalar ve görevden almalar Resmî Gazete'de",
      "Atama ve görevden alma kararları Resmi Gazete'de",
      "Atama ve görevden alma kararları Resmi Gazete'de!",
      "Resmi Gazete'de Yayımlandı: Bakanlıklarda Yeni Atama ve Görevden Almalar",
      "Başkan Erdoğan imzaladı... Atama ve görevden alma kararları Resmi Gazete'de",
      "Üç bakanlıkta atama ve görevden alma kararları yayımlandı",
      "Yeni atamalar Resmi Gazete'de: 3 bakanlıkta üst düzey değişiklik",
      "Erdoğan imzaladı: Atama ve görevden alma kararları Resmi Gazete'de",
      "Atama kararları Resmi Gazete’de! Bakanlıklarda görev değişikliği",
      "Resmi gazetede yayımlandı: Milli Eğitim, Milli Savunma ve Aile Bakanlığı'nda görev değişikliği",
      "Resmi Gazete'de yayımlandı: Cumhurbaşkanlığına Cevdet Yılmaz vekalet edecek",
      "Cumhurbaşkanlığı'na Cevdet Yılmaz'ın vekalet etmesine dair tezkere Resmi Gazete'de",
      "Tezkere Resmi Gazete'de yayımlandı: Cumhurbaşkanlığına Cevdet Yılmaz vekalet edecek",
    ];
    for (const t of members) expect(isRoundupTitle(t)).toBe(false);
  });
});

// h40-clusters-2 (2026-11-05): IndyTurk publishes a nightly digest whose title is just
// "Kısa haberler" (14 in 14 days, about 21:00-23:00 UTC). Its description is the first
// item of the digest, so the clusterer matched it on that description and 7 of the 14
// became members of unrelated politics clusters (b59f3bb6 with 43 articles, e7cde92e
// with 18, ...), one of them seeding the 1-article cluster a520b58a titled "Kısa
// haberler". Shape I: the digest title alone, with the same optional date tail as E.
describe("isRoundupTitle: shape I, the IndyTürk 'Kısa haberler' digest (h40-clusters-2)", () => {
  it.each([
    // The title as indyturk publishes it, and the casing / diacritic variants.
    "Kısa haberler",
    "Kısa Haberler",
    "KISA HABERLER",
    "kısa haberler",
    "KİSA HABERLER", // dotted capital İ
    "Kisa haberler", // ASCII-only typing
    "KISA haberler",
    "Kısa HABERLER",
    // Punctuation: a trailing colon, a trailing dash, sentence punctuation, quotes.
    "Kısa haberler:",
    "Kısa haberler :",
    "Kısa haberler -",
    "Kısa haberler.",
    "Kısa haberler!",
    "Kısa haberler…",
    '"Kısa haberler"',
    "“Kısa haberler”",
    // Whitespace: collapsed and trimmed (tab, newline, NBSP, double space).
    "  Kısa   haberler  ",
    "Kısa\thaberler",
    "Kısa\nhaberler",
    "Kısa haberler",
    // The same date tails shape E accepts.
    "Kısa haberler (4 Kasım 2026)",
    "Kısa haberler ( 4 Kasım 2026 )",
    "Kısa haberler (04.11.2026)",
    "Kısa haberler - 04.11.2026",
    "Kısa haberler – 4 Kasım 2026",
    "Kısa haberler — 4 Kasım",
    "Kısa haberler | 4 Kasım 2026 Çarşamba",
    "Kısa haberler, 4 Kasım",
    "Kısa haberler: 4 Kasım 2026",
    "Kısa haberler 4 Kasım",
    "Kısa haberler 04/11/2026",
    "KISA HABERLER - 4 KASIM 2026",
    // The long form.
    "Günün kısa haberleri",
    "Günün Kısa Haberleri",
    "GÜNÜN KISA HABERLERİ",
    "Gunun kisa haberleri",
    "Günün kısa haberleri:",
    "Günün kısa haberleri (4 Kasım 2026)",
    "Günün kısa haberleri - 04.11.2026",
    "Günün kısa haberleri!",
  ])("skips %j", (title) => {
    expect(isRoundupTitle(title)).toBe(true);
  });

  it("NFC-composes a decomposed 'Günün' (u + combining diaeresis)", () => {
    expect(isRoundupTitle("Günün kısa haberleri")).toBe(true);
  });

  it.each([
    // The brief's named stories: the phrase leads or follows, but there is more.
    "Kısa haberler: Erdoğan Bakü'ye gitti",
    "Kısa sürede haberler yayıldı",
    "Haberler kısa kesildi",
    "Kısa kısa: Bahçeli'den açıklama",
    // Ordinary headlines that merely start with 'Kısa'.
    "Kısa sürede 3 milyon aşı yapıldı",
    "Kısa sürede toparlandı",
    "Kısa çalışma ödeneği 3 ay daha uzatıldı",
    "Kısa çalışma ödeneği",
    "Kısa vadeli faiz oranları yükseldi",
    "Kısa dalga radyo yayını durduruldu",
    "Kısa mesaj dolandırıcılığına dikkat",
    "Kısa süreli tutuklama kararı",
    "Kısa bir açıklama yaptı",
    "Kısa",
    "Kısa haber",
    "Haberler",
    "Kısa haberler ve yorumlar",
    "Kısa haberler: Meclis'te yoğun gündem",
    "Kısa haberler | Erdoğan Bakü'ye gitti",
    "Kısa haberler - Bahçeli'den açıklama",
    // The phrase inside a longer headline, either side.
    "Çok kısa haberler",
    "TRT Kısa haberler",
    "İşte günün kısa haberleri",
    "Kısa haberler özetle",
    "Haberler kısa kısa",
    // A date that is only the prefix of more text, or malformed.
    "Kısa haberler - 4 Kasım 2026 seçimleri",
    "Kısa haberler 2026 seçimleri",
    "Kısa haberler 123 Kasım",
    "Kısa haberler 04.11.26",
    "Kısa haberler 4 Kasım 2026 2027",
    // The long form with a story attached.
    "Günün kısa haberleri: Erdoğan Bakü'ye gitti",
    "Günün kısa haberlerinde Bahçeli sürprizi",
    "Günün kısa haberleri ve yorumlar",
    "Günün haberleri",
    "Günün kısa",
    "Bugünün kısa haberleri: Meclis kapanıyor",
  ])("keeps %j", (title) => {
    expect(isRoundupTitle(title)).toBe(false);
  });

  it("is anchored at both ends: a prefix or a suffix around the phrase is a story", () => {
    for (const phrase of ["Kısa haberler", "Günün kısa haberleri"]) {
      expect(isRoundupTitle(`${phrase} - 4 Kasım 2026`)).toBe(true);
      expect(isRoundupTitle(`${phrase}: Erdoğan görüştü`)).toBe(false);
      expect(isRoundupTitle(`${phrase} - 4 Kasım 2026 ve devamı`)).toBe(false);
      expect(isRoundupTitle(`Yarınki ${phrase}`)).toBe(false);
      expect(isRoundupTitle(`TRT ${phrase}`)).toBe(false);
      expect(isRoundupTitle(`${phrase}x`)).toBe(false);
      expect(isRoundupTitle(`x${phrase}`)).toBe(false);
    }
  });

  it("leaves the other shapes alone: the bare trailing separator is shape I only", () => {
    // Shape E phrases followed by a colon and a story, or a colon alone after a story, stay stories.
    expect(isRoundupTitle("Haber turu: Erdoğan'dan Kuzey Irak açıklaması")).toBe(false);
    expect(isRoundupTitle("Gündem özeti: Erdoğan ile Bahçeli görüştü")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün: Asgari ücret")).toBe(false);
    expect(isRoundupTitle("Haber turu:")).toBe(false);
    expect(isRoundupTitle("Gündem özeti -")).toBe(false);
    expect(isRoundupTitle("Resmi Gazete'de bugün:")).toBe(false);
  });

  it("answers in linear time on adversarial input around the new phrases", () => {
    const adversarial = [
      "Kısa haberler" + " ".repeat(50_000) + "x",
      "Kısa haberler - " + "1 ".repeat(30_000),
      "kısa haberler".repeat(10_000),
      "günün kısa haberleri".repeat(10_000),
      "Kısa haberler" + ":".repeat(50_000),
      "Kısa haberler" + "!".repeat(50_000) + "x",
      "Kısa haberler (".repeat(20_000),
    ];
    const started = performance.now();
    for (const title of adversarial) expect(isRoundupTitle(title)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("isRoundupTitle: robustness", () => {
  it("answers in linear time on adversarial input (no catastrophic backtracking)", () => {
    const adversarial = [
      "Resmi Gazete'de bugün" + " ".repeat(50_000) + "x",
      "Resmi Gazete'de bugün - " + "1 ".repeat(30_000),
      "1 Kasım ".repeat(20_000),
      "resmi gazete".repeat(10_000),
      "kararlar".repeat(10_000),
      "(".repeat(50_000),
      "Haber turu" + "!".repeat(50_000) + "x",
      "'".repeat(50_000),
      " ".repeat(50_000),
      "a".repeat(1_000_000),
    ];
    const started = performance.now();
    for (const title of adversarial) expect(isRoundupTitle(title)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("a very long run of trailing punctuation or whitespace after a real roundup still resolves", () => {
    expect(isRoundupTitle("Haber turu" + "!".repeat(100))).toBe(true);
    expect(isRoundupTitle("Haber turu" + " ".repeat(100))).toBe(true);
    expect(isRoundupTitle(" ".repeat(100) + "Haber turu")).toBe(true);
  });

  it("handles emoji, other scripts and SQL-ish characters without throwing", () => {
    for (const t of [
      "Haber turu 😀",
      "😀",
      "\uD83D", // lone surrogate
      "Новости дня",
      "ニュース",
      "'; DROP TABLE articles; --",
      "Resmi Gazete'de bugün'; --",
      "%00%0d%0a",
      "\u0000",
    ]) {
      expect(isRoundupTitle(t)).toBe(false);
    }
  });
});

describe("roundup-title.ts: module contract", () => {
  const source = readFileSync(
    resolve(__dirname, "../../../supabase/functions/_shared/cluster/roundup-title.ts"),
    "utf8",
  );

  it("is dependency-free: no import or require, so it compiles under tsc and deno alike", () => {
    for (const line of source.split("\n")) {
      const code = line.trim();
      expect(code.startsWith("import ")).toBe(false);
      expect(code.startsWith("import(")).toBe(false);
      expect(code.includes("require(")).toBe(false);
      expect(code.startsWith("export * from")).toBe(false);
      expect(code.startsWith("export {")).toBe(false);
    }
  });

  it("exports exactly ROUNDUP_SKIP_REASON and isRoundupTitle", () => {
    const exported: string[] = [];
    for (const line of source.split("\n")) {
      if (!line.startsWith("export ")) continue;
      const rest = line.slice("export ".length);
      const name = rest.split(/[\s(:=<]+/).filter((p) => p !== "const" && p !== "function" && p !== "type" && p !== "interface")[0];
      if (name) exported.push(name);
    }
    expect(exported.sort()).toEqual(["ROUNDUP_SKIP_REASON", "isRoundupTitle"]);
  });

  it("uses no unbounded repetition (* or +) in any regex literal or RegExp string, so nothing can backtrack catastrophically", () => {
    // Every regular expression in the module is assembled from fragments that use
    // only ?, {n} and {n,m}. Scan the code (comments dropped) for a quantifier
    // character that follows a regex atom, which is how a * or + would appear.
    const code = source
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"))
      .join("\n");
    expect(code).not.toMatch(/\)[*+]/); // a quantified group
    expect(code).not.toMatch(/\][*+]/); // a quantified class
    expect(code).not.toMatch(/\\[sdw][*+]/); // \s+ \d* ...
    expect(code).not.toContain(".*");
    expect(code).not.toContain(".+");
  });
});
