import { describe, expect, it } from "vitest";

import { companyDisplayName } from "./company-display-name";

// Real KAP titles (bist_companies.title), hard-coded: this test never reads
// the database. Input -> the short, reader-facing name.
const REAL_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["ARÇELİK A.Ş.", "Arçelik"],
  ["BİM BİRLEŞİK MAĞAZALAR A.Ş.", "BİM Birleşik Mağazalar"],
  ["ASELSAN ELEKTRONİK SANAYİ VE TİCARET A.Ş.", "Aselsan Elektronik"],
  ["EREĞLİ DEMİR VE ÇELİK FABRİKALARI T.A.Ş.", "Ereğli Demir ve Çelik Fabrikaları"],
  ["TÜRKİYE PETROL RAFİNERİLERİ A.Ş.", "Türkiye Petrol Rafinerileri"],
  ["TÜRKİYE ŞİŞE VE CAM FABRİKALARI A.Ş.", "Türkiye Şişe ve Cam Fabrikaları"],
  ["HEKTAŞ TİCARET T.A.Ş.", "Hektaş"],
  ["TÜRKİYE İŞ BANKASI A.Ş.", "Türkiye İş Bankası"],
  ["AKBANK T.A.Ş.", "Akbank"],
  ["TÜRK HAVA YOLLARI A.O.", "Türk Hava Yolları"],
  ["KOÇ HOLDİNG A.Ş.", "Koç Holding"],
  ["SASA POLYESTER SANAYİ A.Ş.", "Sasa Polyester"],
  ["ORZAKS İLAÇ VE KİMYA SANAYİ TİCARET A.Ş.", "Orzaks İlaç ve Kimya"],
  ["İŞ YATIRIM MENKUL DEĞERLER A.Ş.", "İş Yatırım Menkul Değerler"],
  ["MLP SAĞLIK HİZMETLERİ A.Ş.", "MLP Sağlık Hizmetleri"],
  ["TAV HAVALİMANLARI HOLDİNG A.Ş.", "TAV Havalimanları Holding"],
  ["ŞOK MARKETLER TİCARET A.Ş.", "ŞOK Marketler"],
  ["COCA-COLA İÇECEK A.Ş.", "Coca-Cola İçecek"],
  ["T.C. ZİRAAT BANKASI A.Ş.", "T.C. Ziraat Bankası"],
  ["KAP TEST A.Ş.", "KAP Test"],
];

// More prod titles from the read-only sample: the legal forms the first list
// does not cover (ORTAKLIĞI, ŞİRKETİ in the tail, SANAYİİ, digits, AG).
const SAMPLED_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["A1 CAPİTAL YATIRIM MENKUL DEĞERLER A.Ş.", "A1 Capital Yatırım Menkul Değerler"],
  ["AG ANADOLU GRUBU HOLDİNG A.Ş.", "AG Anadolu Grubu Holding"],
  ["ANADOLU EFES BİRACILIK VE MALT SANAYİİ A.Ş.", "Anadolu Efes Biracılık ve Malt"],
  ["ANADOLU ANONİM TÜRK SİGORTA ŞİRKETİ", "Anadolu Anonim Türk Sigorta"],
  ["AĞAOĞLU AVRASYA GAYRİMENKUL YATIRIM ORTAKLIĞI A.Ş.", "Ağaoğlu Avrasya Gayrimenkul Yatırım"],
  ["AKHAN UN FABRİKASI VE TARIM ÜRÜNLERİ GIDA SANAYİ TİCARET A.Ş.", "Akhan Un Fabrikası ve Tarım Ürünleri Gıda"],
  ["AFYON ÇİMENTO SANAYİ T.A.Ş.", "Afyon Çimento"],
];

// Foreign-trade titles (hunt-17 review, real prod titles): "DIŞ" (foreign) and
// "İÇ" (domestic) are trade descriptors, so they go with "TİCARET" instead of
// being left behind as a stray fragment ("Teknosa İç ve Dış").
const FOREIGN_TRADE_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["TEKNOSA İÇ VE DIŞ TİCARET A.Ş.", "Teknosa"],
  ["TGS DIŞ TİCARET A.Ş.", "TGS"],
  ["GÜNDOĞDU GIDA SÜT ÜRÜNLERİ SANAYİ VE DIŞ TİCARET A.Ş.", "Gündoğdu Gıda Süt Ürünleri"],
  ["KOROPLAST TEMİZLİK AMBALAJ ÜRÜNLERİ SANAYİ VE DIŞ TİCARET A.Ş.", "Koroplast Temizlik Ambalaj Ürünleri"],
  ["VANET GIDA SANAYİ İÇ VE DIŞ TİCARET A.Ş.", "Vanet Gıda"],
  ["TUREKS TURUNÇ MADENCİLİK İÇ VE DIŞ TİCARET A.Ş.", "Tureks Turunç Madencilik"],
  ["DCT TRADİNG DIŞ TİCARET A.Ş.", "DCT Trading"],
  ["PERGAMON STATUS DIŞ TİCARET A.Ş.", "Pergamon Status"],
  ["PASİFİK EURASİA LOJİSTİK DIŞ TİCARET A.Ş.", "Pasifik Eurasia Lojistik"],
  [
    "ATA TURİZM İŞLETMECİLİK TAŞIMACILIK MADENCİLİK KUYUMCULUK SANAYİ VE DIŞ TİCARET A.Ş.",
    "Ata Turizm İşletmecilik Taşımacılık Madencilik Kuyumculuk",
  ],
];

// Brand words that KAP spells in ASCII capitals: a blind tr-TR lowercase turns
// their I into a dotless ı ("Carrıer", "Fortıs"). Real prod titles -> the
// correctly spelled name. A frozen list, so a reviewer sees every new case.
const FOREIGN_BRAND_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["ALARKO CARRIER SANAYİ VE TİCARET A.Ş.", "Alarko Carrier"],
  ["CREDITWEST FAKTORİNG A.Ş.", "Creditwest Faktoring"],
  ["GRAINTURK HOLDİNG A.Ş.", "Grainturk Holding"],
  ["QUA GRANITE HAYAL YAPI VE ÜRÜNLERİ SANAYİ TİCARET A.Ş.", "Qua Granite Hayal Yapı ve Ürünleri"],
  ["DO & CO AKTIENGESELLSCHAFT", "DO & CO"],
  ["BNP PARIBAS ISSUANCE B.V.", "BNP Paribas Issuance B.V."],
  ["FORTIS BANK A.Ş.", "Fortis Bank"],
  ["GALATA WIND ENERJİ A.Ş.", "Galata Wind Enerji"],
  ["GOLDMAN SACHS INTERNATIONAL", "Goldman Sachs International"],
  ["IC ENTERRA YENİLENEBİLİR ENERJİ A.Ş.", "IC Enterra Yenilenebilir Enerji"],
  ["IC İÇTAŞ ENERJİ YATIRIM HOLDİNG A.Ş.", "IC İçtaş Enerji Yatırım Holding"],
  ["ICU GİRİŞİM SERMAYESİ YATIRIM ORTAKLIĞI A.Ş.", "ICU Girişim Sermayesi Yatırım"],
  ["MONDI OLMUKSAN KAĞIT VE AMBALAJ SANAYİ A.Ş.", "Mondi Olmuksan Kağıt ve Ambalaj"],
  ["PRIME FAKTORİNG HİZMETLERİ A.Ş.", "Prime Faktoring Hizmetleri"],
  ["QUICK FİNANSMAN A.Ş.", "Quick Finansman"],
  ["TRIVE YATIRIM MENKUL DEĞERLER A.Ş.", "Trive Yatırım Menkul Değerler"],
  ["TURKISH FAKTORİNG A.Ş.", "Turkish Faktoring"],
  ["UNICO SİGORTA A.Ş.", "Unico Sigorta"],
  ["UNICREDIT BANK AG", "Unicredit Bank AG"],
  ["VTB CAPITAL PLC", "VTB Capital PLC"],
];

// Titles whose ASCII I belongs to a Turkish word: the dotless ı must stay, and
// the pre-existing "X & Co" names must not be forced into capitals by the DO & CO override.
const TURKISH_I_TITLES: ReadonlyArray<readonly [string, string]> = [
  ["ALTINAY SAVUNMA TEKNOLOJİLERİ A.Ş.", "Altınay Savunma Teknolojileri"],
  ["ACIBADEM SAĞLIK HİZMETLERİ VE TİCARET A.Ş.", "Acıbadem Sağlık Hizmetleri"],
  ["TATLIPINAR TATLI VE GIDA SANAYİ A.Ş.", "Tatlıpınar Tatlı ve Gıda"],
  ["ANADOLU ISUZU OTOMOTİV SANAYİ VE TİCARET A.Ş.", "Anadolu Isuzu Otomotiv"],
  ["EGELİ & CO YATIRIM HOLDİNG A.Ş.", "Egeli & Co Yatırım Holding"],
  ["SHELL & TURCAS PETROL A.Ş.", "Shell & Turcas Petrol"],
];

describe("companyDisplayName", () => {
  describe("foreign-trade titles", () => {
    it.each(FOREIGN_TRADE_TITLES)("%s -> %s", (input, expected) => {
      expect(companyDisplayName(input)).toBe(expected);
    });

    it("never leaves İÇ / DIŞ dangling at the end of the name", () => {
      for (const [input] of FOREIGN_TRADE_TITLES) {
        expect(companyDisplayName(input)).not.toMatch(/(^|\s)(İç|Dış|ve)$/);
      }
    });

    it("keeps İÇ / DIŞ when they are not the tail (İÇ ANADOLU, DIŞ BANK)", () => {
      expect(companyDisplayName("İÇ ANADOLU ENERJİ A.Ş.")).toBe("İç Anadolu Enerji");
      expect(companyDisplayName("DIŞ BANK A.Ş.")).toBe("Dış Bank");
    });

    it("never strips the last remaining token even if it is İÇ or DIŞ", () => {
      expect(companyDisplayName("İÇ VE DIŞ TİCARET A.Ş.")).toBe("İç");
      expect(companyDisplayName("DIŞ TİCARET A.Ş.")).toBe("Dış");
    });
  });

  describe("foreign brand words in ASCII capitals", () => {
    it.each(FOREIGN_BRAND_TITLES)("%s -> %s", (input, expected) => {
      expect(companyDisplayName(input)).toBe(expected);
    });

    it.each(TURKISH_I_TITLES)("keeps the Turkish spelling: %s -> %s", (input, expected) => {
      expect(companyDisplayName(input)).toBe(expected);
    });

    it("applies the override to every part of a hyphenated word", () => {
      expect(companyDisplayName("CARRIER-GRANITE A.Ş.")).toBe("Carrier-Granite");
    });

    it("drops AKTIENGESELLSCHAFT as a legal form but never reduces a name to it", () => {
      expect(companyDisplayName("ALFA AKTIENGESELLSCHAFT")).toBe("Alfa");
      expect(companyDisplayName("AKTIENGESELLSCHAFT")).toBeNull();
    });
  });

  describe("real KAP titles", () => {
    it.each(REAL_TITLES)("%s -> %s", (input, expected) => {
      expect(companyDisplayName(input)).toBe(expected);
    });
  });

  describe("further titles from the prod sample", () => {
    it.each(SAMPLED_TITLES)("%s -> %s", (input, expected) => {
      expect(companyDisplayName(input)).toBe(expected);
    });
  });

  describe("spelling variants of the legal form", () => {
    it.each([
      ["ARÇELİK ANONİM ŞİRKETİ", "Arçelik"],
      ["ARÇELİK A. Ş.", "Arçelik"],
      ["ARÇELİK A.Ş", "Arçelik"],
      ["ARÇELİK AŞ", "Arçelik"],
      ["ARÇELİK a.ş.", "Arçelik"],
      ["  ARÇELİK \t  A.Ş.  ", "Arçelik"],
      ["\nARÇELİK\nA.Ş.\n", "Arçelik"],
    ])("%j -> %s", (input, expected) => {
      expect(companyDisplayName(input)).toBe(expected);
    });
  });

  describe("casing", () => {
    it("keeps the casing of a mixed-case title and strips only the suffix", () => {
      expect(companyDisplayName("Pegasus Hava Taşımacılığı A.Ş.")).toBe("Pegasus Hava Taşımacılığı");
    });

    it("strips a lowercase descriptor from a mixed-case title without re-casing the rest", () => {
      expect(companyDisplayName("Pegasus Hava Taşımacılığı Sanayi ve Ticaret A.Ş.")).toBe("Pegasus Hava Taşımacılığı");
    });

    it("turns the Turkish dotted and dotless I the Turkish way, not the English way", () => {
      // en-US would give 'Hi̇zmetleri' (i + combining dot) or 'Sağlik'; tr-TR gives these.
      expect(companyDisplayName("SAĞLIK HİZMETLERİ A.Ş.")).toBe("Sağlık Hizmetleri");
      expect(companyDisplayName("İŞ GİRİŞİM A.Ş.")).toBe("İş Girişim");
    });

    it("keeps vowel-free codes, dotted tokens and digit tokens as written", () => {
      expect(companyDisplayName("QNB BANK A.Ş.")).toBe("QNB Bank");
      expect(companyDisplayName("HSBC YATIRIM A.Ş.")).toBe("HSBC Yatırım");
      expect(companyDisplayName("A1 YENİLENEBİLİR ENERJİ ÜRETİM A.Ş.")).toBe("A1 Yenilenebilir Enerji Üretim");
    });

    it("lowercases ve / ile / veya in the middle but not as the first token", () => {
      expect(companyDisplayName("ALFA VE BETA A.Ş.")).toBe("Alfa ve Beta");
      expect(companyDisplayName("ALFA İLE BETA A.Ş.")).toBe("Alfa ile Beta");
      expect(companyDisplayName("ALFA VEYA BETA A.Ş.")).toBe("Alfa veya Beta");
      expect(companyDisplayName("VE ALFA A.Ş.")).toBe("Ve Alfa");
    });
  });

  describe("what is stripped", () => {
    it("strips legal forms and descriptors repeatedly from the tail, in any order", () => {
      expect(companyDisplayName("AKSA SANAYİ TİCARET SANAYİ A.Ş.")).toBe("Aksa");
      expect(companyDisplayName("ALFA TİC. SAN. A.Ş.")).toBe("Alfa");
      expect(companyDisplayName("ALFA A.Ş. T.A.Ş.")).toBe("Alfa");
    });

    it("leaves a descriptor in the middle of the name alone", () => {
      expect(companyDisplayName("ANADOLU SANAYİ GRUBU HOLDİNG A.Ş.")).toBe("Anadolu Sanayi Grubu Holding");
    });

    it("never strips the last remaining token if it is a descriptor", () => {
      expect(companyDisplayName("TİCARET A.Ş.")).toBe("Ticaret");
      expect(companyDisplayName("SANAYİ VE TİCARET A.Ş.")).toBe("Sanayi");
      expect(companyDisplayName("TİCARET")).toBe("Ticaret");
    });
  });

  describe("no usable name", () => {
    it.each([
      ["null", null],
      ["undefined", undefined],
      ["an empty string", ""],
      ["whitespace only", "   "],
      ["the legal form alone", "A.Ş."],
      ["a spaced legal form alone", "A. Ş."],
      ["only legal forms", "ANONİM ŞİRKETİ"],
      ["a single letter plus the legal form", "X A.Ş."],
      ["a single digit plus the legal form", "7 A.Ş."],
      ["punctuation only", "-- A.Ş."],
    ])("%s -> null", (_label, input) => {
      expect(companyDisplayName(input)).toBeNull();
    });

    it("returns null for a non-string value that slipped through a cast", () => {
      expect(companyDisplayName(42 as unknown as string)).toBeNull();
      expect(companyDisplayName({} as unknown as string)).toBeNull();
    });
  });

  describe("purity", () => {
    it("gives the same answer on every call and does not depend on earlier calls", () => {
      const first = companyDisplayName("ARÇELİK A.Ş.");
      companyDisplayName("TÜRK HAVA YOLLARI A.O.");
      expect(companyDisplayName("ARÇELİK A.Ş.")).toBe(first);
    });

    it("is stable on its own output (a display name is not stripped again)", () => {
      for (const [, expected] of [
        ...REAL_TITLES,
        ...SAMPLED_TITLES,
        ...FOREIGN_TRADE_TITLES,
        ...FOREIGN_BRAND_TITLES,
        ...TURKISH_I_TITLES,
      ]) {
        expect(companyDisplayName(expected)).toBe(expected);
      }
    });
  });
});
