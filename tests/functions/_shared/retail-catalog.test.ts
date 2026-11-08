import { describe, expect, it } from "vitest";

import { expectLinear, rep } from "../../_helpers/linear-time";
import {
  RETAIL_CATALOG_PATTERNS,
  isRetailCatalog,
} from "../../../supabase/functions/_shared/rss/retail-catalog.ts";

// ---------------------------------------------------------------------------
// h72-kap-3: BİM's weekly "aktüel ürünler kataloğu" and "BİM'E ... GELİYOR!" promos were 179 of
// BIMAS's 197 article_tickers rows over 30 days (18 sources, Jev ticker_relevance 0.91 on average,
// so the relevance gates keep and count them). isRetailCatalog is the pure TS twin of the SQL
// predicate public.is_retail_catalog (migration 178): the TITLE, folded with foldTr, carries a retail
// brand token AND one of three cues. The URL is never read. The parity of the two sides is pinned in
// tests/migrations/178-retail-catalog-ticker-gate.test.ts.
// ---------------------------------------------------------------------------

describe("isRetailCatalog: catalog and promo titles (true)", () => {
  it.each([
    // (a) catalog words
    "BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU",
    "BİM 8 Kasım 2026 Pazar Aktüel Ürünler Kataloğu Yayımda!",
    "BİM 11 KASIM ÇARŞAMBA İNDİRİM KATALOĞU YAYINLANDI!",
    "Bim aktüel ürünler kataloğu yayınlandı!",
    "ŞOK AKTÜEL ÜRÜNLER KATALOĞU YAYINLANDI: BU HAFTA RAFLARA GELECEK ÜRÜNLER BELLİ OLDU",
    "A101 15 EKIM AKTÜEL KATALOĞU | ALDIN ALDIN",
    "BİM AKTÜEL LİSTESİNDE KÜÇÜK EV ALETLERİ FIRSATLARI BAŞLIYOR",
    // (b) a day range with a Turkish month, the parentheses and the hyphen folded away
    "BİM'DE DEV İNDİRİM BAŞLIYOR: FİYATLARI GÖREN MARKETE AKIN EDECEK! (BİM 30 EKİM-5 KASIM)",
    "BİM'DE BU ÜRÜNLER RESMEN KAPIŞILACAK! (BİM 27 EKİM 2 KASIM)",
    "BİM’DE BEKLENEN GÜN GELDİ: BU ÜRÜNLER RAFLARDA YERİNİ ALACAK! (BİM 18-24 EKİM)",
    "ÇARŞAMBA BİM’DE! LEDLİ SIRT ÇANTASIYLA TARZINIZI YOLA YANSITIN (BİM 28 EKİM-3 KASIM)",
    "Migros 1 alana 1 bedava kampanyası ne zaman? Migros 10-18 Ekim 2026 indirimli ürünler",
    // (c) brand + dative / locative suffix + geliyor | satista
    "BUGÜN SATIŞTA! BİM'E 3 ÇEKMECELİ DERİN DONDURUCU GELİYOR! (BİM 8-14 KASIM)",
    "BİM'E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR!",
    "BİM'DEN BEYAZ EŞYADA DEV ADIM: BİM'E KEYSMART BULAŞIK MAKİNELERİ GELİYOR!",
    "ŞOK’A ARZUM OKKA MINIO GO TÜRK KAHVE MAKİNESİ GELİYOR!",
    "iPhone 17 Migros'ta satışta",
    "MİGROS'A YENİ BİR SMART TV GELİYOR",
    "CarrefourSA'YA gofret makinesi GELİYOR",
    "BUGÜN SATIŞTA! A101'de 2'Lİ DÜDÜKLÜ SET",
  ])("flags %s", (title) => {
    expect(isRetailCatalog(title)).toBe(true);
  });
});

describe("isRetailCatalog: real company and market news (false)", () => {
  it.each([
    "BİM, 250 bin lira sermayeli teknoloji şirketi kurdu",
    "BİM'den büyük atak. Şube sayısını katladı A101 ile farkı kapattı!",
    "BofA'nın haftalık bilançosu: Bankaları aldı, BİM'i sattı",
    "29 Ekim zincir marketler açık mı? 29 Ekim Cumhuriyet Bayramı BİM, A101, ŞOK market çalışma saatleri",
    "THY, 7 milyar doları aştı",
    "33 şirketin temettü takvimi açıklandı",
    // a retail brand without a cue, a cue without a brand
    "BİM teknoloji sektörüne giriyor: Yapay zeka ve dijital bankacılık için yeni şirket",
    "Tanju Özcan mahkemede: BİM, ŞOK ve A101 iddialarını yanıtladı",
    "Migros'un üçüncü çeyrek net karı yüzde 12 arttı",
    "Yeni ürün kataloğu yayımlandı: Ofis mobilyaları",
    "Teknoloji devi yeni telefonlarını satışa sundu, 13 Kasım'da geliyor",
    // one date, or a date followed by a year: not a range
    "Migros 13 Kasım 2026 tarihinde genel kurul toplantısı yapacak",
    "BİM 5 Kasım'da bilançosunu açıklayacak",
    // the locative of another word, no brand + suffix pair
    "ŞOK! Borsada sert düşüş geliyor mu?",
    "BİM'den teknoloji hamlesi: yeni şirket kuruluyor",
  ])("passes %s", (title) => {
    expect(isRetailCatalog(title)).toBe(false);
  });

  it("documents the accepted false negative: a promo with only the brand locative and no cue", () => {
    // The bare title has no catalog word, no day range and no 'geliyor' / 'satista': the predicate misses it on purpose.
    expect(isRetailCatalog("MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE!")).toBe(false);
    // Production's title carries the day range, which is the (b) cue.
    expect(
      isRetailCatalog("MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE! (BİM 11-17 KASIM)"),
    ).toBe(true);
  });

  it("documents the accepted false positive: 'BİM e-ticarete geliyor' folds to 'bim e ticarete geliyor'", () => {
    // fold_tr / foldTr turn the apostrophe into a space, so a dative suffix and the letter e of 'e-ticaret' look alike.
    expect(isRetailCatalog("BİM e-ticarete geliyor")).toBe(true);
  });
});

describe("isRetailCatalog: title only, folded", () => {
  it("never reads the URL: the function takes the title alone", () => {
    expect(isRetailCatalog.length).toBe(1);
  });

  it("needs the whole brand token: 'bimbo', 'sokak', 'migrosoft' are not retail brands", () => {
    expect(isRetailCatalog("Bimbo aktüel ürünler kataloğu")).toBe(false);
    expect(isRetailCatalog("Sokak aktüel ürünler kataloğu")).toBe(false);
    expect(isRetailCatalog("Migrosoft aktüel ürünler kataloğu")).toBe(false);
    expect(isRetailCatalog("Migros aktüel ürünler kataloğu")).toBe(true);
  });

  it("folds Turkish letters and case: dotted and dotless I, ş, ğ, ü", () => {
    expect(isRetailCatalog("bim AKTUEL URUNLER KATALOGU")).toBe(true);
    expect(isRetailCatalog("BİM aktüel ürünler kataloğu")).toBe(true);
    expect(isRetailCatalog("BIM AKTÜEL ÜRÜNLER KATALOĞU")).toBe(true);
    expect(isRetailCatalog("sok aktuel urunler kataloğu")).toBe(true);
    expect(isRetailCatalog("CarrefourSA indirim kataloğu")).toBe(true);
  });

  it("accepts all twelve month names in a day range (folded: şubat, ağustos, eylül, aralık)", () => {
    const months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    for (const m of months) {
      expect(isRetailCatalog(`BİM'DE FIRSAT! (BİM 3-9 ${m.toLocaleUpperCase("tr")})`), m).toBe(true);
    }
    expect(isRetailCatalog("BİM'DE FIRSAT! (BİM 3-9 BAYRAM)")).toBe(false);
  });

  it("reads a range that crosses a month and a range of more than two days", () => {
    expect(isRetailCatalog("BİM'DE İNDİRİM (BİM 28 EKİM-3 KASIM)")).toBe(true);
    expect(isRetailCatalog("BİM AKTÜEL 9-10-11-13-14-16 EKİM 2026")).toBe(true);
  });
});

describe("isRetailCatalog: input edges", () => {
  it("returns false for empty, whitespace, null, undefined and non-string input, never throwing", () => {
    expect(isRetailCatalog("")).toBe(false);
    expect(isRetailCatalog("   ")).toBe(false);
    for (const t of [null, undefined, 0, 42, {}, [], true] as unknown as string[]) {
      expect(isRetailCatalog(t)).toBe(false);
    }
  });

  it("handles punctuation-only, emoji and SQL-looking titles without matching", () => {
    expect(isRetailCatalog("!!! ??? ...")).toBe(false);
    expect(isRetailCatalog("🛒🛒🛒 BİM 🛒🛒🛒")).toBe(false);
    expect(isRetailCatalog("'; drop table articles; -- BİM")).toBe(false);
    expect(isRetailCatalog("🛒 BİM aktüel ürünler kataloğu 🛒")).toBe(true);
  });

  it("is stateless across calls (no sticky or global regex state)", () => {
    const t = "BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU";
    for (let i = 0; i < 5; i++) expect(isRetailCatalog(t)).toBe(true);
    for (let i = 0; i < 5; i++) expect(isRetailCatalog("THY, 7 milyar doları aştı")).toBe(false);
  });

  it("scans a 200,000-character title in linear time (no catastrophic backtracking)", () => {
    // many near-matches of the day range, ending in a catalog word; and a brand with no cue at all
    const nearMisses = rep("bim 12 ekim 3 ", "", " katalog yok");
    const noCue = rep("migros 12 ve 3 ");
    expect(isRetailCatalog(nearMisses(200_000))).toBe(true);
    expect(isRetailCatalog(noCue(200_000))).toBe(false);
    expectLinear(nearMisses, (t) => isRetailCatalog(t), { n: 200_000, ceilingMs: 4_000 });
    expectLinear(noCue, (t) => isRetailCatalog(t), { n: 200_000, ceilingMs: 4_000 });
  });
});

describe("RETAIL_CATALOG_PATTERNS (embedded verbatim by migration 178)", () => {
  it("exposes the five rules by name", () => {
    expect(Object.keys(RETAIL_CATALOG_PATTERNS).sort()).toEqual([
      "ARRIVAL",
      "BRAND",
      "BRAND_SUFFIX",
      "CATALOG_CUE",
      "DAY_RANGE",
    ]);
  });

  it("every rule is a space-delimited ASCII pattern valid in a Postgres ARE unchanged: no escape, no flag, no lookbehind", () => {
    for (const [name, re] of Object.entries(RETAIL_CATALOG_PATTERNS)) {
      expect(re.flags, name).toBe("");
      expect(re.source, name).not.toContain("\\");
      expect(re.source, name).not.toContain("(?");
      expect(re.source.startsWith(" "), name).toBe(true);
      expect(/^[\x20-\x7e]+$/.test(re.source), name).toBe(true);
    }
  });

  it("states the five rules exactly as the spec words them", () => {
    expect(RETAIL_CATALOG_PATTERNS.BRAND.source).toBe(" (bim|a101|sok|migros|carrefoursa) ");
    expect(RETAIL_CATALOG_PATTERNS.CATALOG_CUE.source).toBe(
      " (aktuel (urun|katalog|liste)|indirim katalog|katalog(u|lari)?)",
    );
    expect(RETAIL_CATALOG_PATTERNS.BRAND_SUFFIX.source).toBe(" (bim|a101|sok|migros|carrefoursa) (e|a|ye|ya|de|da|te|ta) ");
    expect(RETAIL_CATALOG_PATTERNS.ARRIVAL.source).toBe(" (geliyor|satista) ");
    expect(RETAIL_CATALOG_PATTERNS.DAY_RANGE.source).toBe(
      " [0-9]{1,2} ((ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) )?[0-9]{1,2} (ocak|subat|mart|nisan|mayis|haziran|temmuz|agustos|eylul|ekim|kasim|aralik) ",
    );
  });
});
