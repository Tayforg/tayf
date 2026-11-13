import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import { titleNamesOutlet } from "./outlet-leak";

// titleNamesOutlet: does a headline NAME its own outlet ("CNN TÜRK'te", "GZT
// sordu ...")? Such a headline gives the /oyun answer away. The daily mode's
// titleLeaksOutlet (daily-set.ts) is a plain substring test on the folded name
// and slug tokens, so it also fires on "Yeni Parti'den istifa etti" for Yeni
// Şafak; this rule matches whole words and skips names that are ordinary words.

describe("titleNamesOutlet -- the headline names its own outlet", () => {
  it.each([
    ["CNN TÜRK Azerbaycan’da | Karabağ Zaferi’nin Yıldönümü!", "CNN Türk"],
    ["Trump'ın eski kurul üyesi CNN TÜRK'te: …", "CNN Türk"],
    ["OdaTV'ye konuştu", "OdaTV"],
    ["GZT sordu Bilal Erdoğan yanıtladı", "GZT"],
  ])("true for %j / %s", (title, name) => {
    expect(titleNamesOutlet(title, { name })).toBe(true);
  });
});

describe("titleNamesOutlet -- the headline merely shares words with the name", () => {
  it.each([
    ["Cumhuriyet Halk Partisi açıklama yaptı", "Cumhuriyet"],
    ["Yeni Parti'den istifa etti", "Yeni Şafak"],
    ["AK Parti Sözcüsü Çelik açıkladı", "Sözcü"],
    ["Sözcü Ömer Çelik açıkladı", "Sözcü"],
    ["Türkiye ile Azerbaycan arasında anlaşma", "Türkiye Gazetesi"],
    ["Sabah saatlerinde deprem", "Sabah"],
  ])("false for %j / %s", (title, name) => {
    expect(titleNamesOutlet(title, { name })).toBe(false);
  });
});

describe("titleNamesOutlet -- single-word names that are ordinary Turkish words", () => {
  // Each of these is the name of an active outlet AND a word that appears in
  // headlines on its own ("Anayasa'ya aykırı", "İstiklal Caddesi", "muhalif
  // gazeteci"), so it is never checked. Titles are the outlet's own name in the
  // headline position that WOULD match for any other single-word name.
  it.each([
    "Akşam",
    "Aydınlık",
    "Bugün",
    "Cumhuriyet",
    "Diken",
    "Evrensel",
    "Güneş",
    "Hürriyet",
    "Karar",
    "Korkusuz",
    "Milliyet",
    "Posta",
    "Sabah",
    "Sözcü",
    "Star",
    "Takvim",
    "Türkiye",
    "Yurt",
    "Aykırı",
    "İstiklal",
    "Milat",
    "Muhalif",
    "Haberiniz",
  ])("never reports a leak for the ordinary-word name %s", (name) => {
    expect(titleNamesOutlet(`${name} haberi: yeni gelişme`, { name })).toBe(false);
    // Lowercase, as the common word is written. (An ALL-CAPS "SÖZCÜ" or a name
    // followed by an apostrophe is the outlet's own self-reference: the section
    // "ordinary-word names, forms the common word never takes" below.)
    expect(titleNamesOutlet(`Son dakika ${name.toLocaleLowerCase("tr-TR")}`, { name })).toBe(false);
  });

  it.each(["Agos", "Bianet", "BirGün", "Habertürk", "NTV", "T24", "Tele1", "Medyascope", "Haber7"])(
    "still reports a leak for the coined name %s",
    (name) => {
      expect(titleNamesOutlet(`${name}'e konuştu`, { name })).toBe(true);
    },
  );

  it("the ordinary-word rule applies to the whole name only: a two-word name made of ordinary words is checked as a phrase", () => {
    expect(titleNamesOutlet("Türkiye Gazetesi'ne konuştu", { name: "Türkiye Gazetesi" })).toBe(true);
    expect(titleNamesOutlet("Yeni Şafak yazarı açıkladı", { name: "Yeni Şafak" })).toBe(true);
    expect(titleNamesOutlet("Türkiye ile Azerbaycan", { name: "Türkiye Gazetesi" })).toBe(false);
  });
});

// h172-oyun-2: an ordinary-word name is exempt as a bare word, but an outlet
// naming itself takes forms the common word never takes: an apostrophe suffix
// ("Milliyet’e konuştu"), ALL CAPS ("KARAR"), a series line ("Cumhuriyet
// Silivri'den bildiriyor"), an alias (CNN for CNN Türk).
describe("titleNamesOutlet -- the six live self-references", () => {
  it.each([
    [
      "KKTC CTP Genel Başkanı İncirli, COP31 Zirvesi’nde Milliyet’e konuştu: Türkiye tüm adanın garantörü",
      "Milliyet",
    ],
    [
      "İYİ Partili Vekil Kavuncu KARAR'ın gündeme getirdiği skandalı Meclis'e taşıdı: Camideki ayıba kimler izin verdi?",
      "Karar",
    ],
    [
      "Kılıçdaroğlu’ndan Mahiroğlu’na “50 milyon dolar” davası! Çelişkiyi Takvim yakaladı... Bay Kemal aslında ne dedi",
      "Takvim",
    ],
    [
      "Cumhuriyet Silivri'den bildiriyor... İmamoğlu, İBB davasında gazetecilere seslendi: 'Kalemi hür gazetecileri Allah korusun'",
      "Cumhuriyet",
    ],
    [
      "Cumhuriyet Silivri'den bildiriyor... İBB davasında 108. duruşma günü: Tahliye talepleri devam ediyor",
      "Cumhuriyet",
    ],
    ["Bakan Murat Kurum, CNN'e konuştu: Yaşayacak doğanız yoksa bütçe artırmak neden?", "CNN Türk"],
  ])("true for %j / %s", (title, name) => {
    expect(titleNamesOutlet(title, { name })).toBe(true);
  });
});

describe("titleNamesOutlet -- outlet aliases", () => {
  it("CNN Türk is also named CNN, TRT Haber also TRT, as a whole word", () => {
    expect(titleNamesOutlet("Bakan Kurum CNN'e konuştu", { name: "CNN Türk" })).toBe(true);
    expect(titleNamesOutlet("CNN: bakan açıkladı", { name: "CNN Türk" })).toBe(true);
    expect(titleNamesOutlet("Bakan Kurum TRT'ye konuştu", { name: "TRT Haber" })).toBe(true);
    expect(titleNamesOutlet("Bakan Kurum TRT 1'de açıkladı", { name: "TRT Haber" })).toBe(true);
  });

  it("the full phrase still matches as before", () => {
    expect(titleNamesOutlet("CNN TÜRK'te konuştu", { name: "CNN Türk" })).toBe(true);
    expect(titleNamesOutlet("TRT Haber'e konuştu", { name: "TRT Haber" })).toBe(true);
  });

  it("the key is the folded name, so case, diacritics and spacing of the source name do not matter", () => {
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "CNN TÜRK" })).toBe(true);
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "cnn turk" })).toBe(true);
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "  CNN   Türk " })).toBe(true);
  });

  it("an alias is a whole word: it does not match inside a longer word", () => {
    expect(titleNamesOutlet("CNNX raporu açıklandı", { name: "CNN Türk" })).toBe(false);
    expect(titleNamesOutlet("ACNN raporu açıklandı", { name: "CNN Türk" })).toBe(false);
    expect(titleNamesOutlet("Trta raporu açıklandı", { name: "TRT Haber" })).toBe(false);
    expect(titleNamesOutlet("Strt projesi açıklandı", { name: "TRT Haber" })).toBe(false);
  });

  it("an alias belongs to its own outlet only", () => {
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "NTV" })).toBe(false);
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "CGTN Türk" })).toBe(false);
    expect(titleNamesOutlet("Bakan TRT'ye konuştu", { name: "CNN Türk" })).toBe(false);
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "TRT Haber" })).toBe(false);
    expect(titleNamesOutlet("Bakan CNN'e konuştu", { name: "CNN" })).toBe(true);
  });
});

describe("titleNamesOutlet -- ordinary-word names, forms the common word never takes", () => {
  describe("the name followed by an apostrophe and a letter, in Title case or ALL CAPS", () => {
    it.each([
      ["Sözcü'ye konuştu", "Sözcü"],
      ["Bakan Sözcü’ye konuştu", "Sözcü"],
      ["Bakan SÖZCÜ’ye konuştu", "Sözcü"],
      ["Bakan SOZCU'ya konuştu", "Sözcü"],
      ["Bakan Hürriyet’e konuştu", "Hürriyet"],
      ["Bakan AKŞAM'a konuştu", "Akşam"],
      ["Bakan Sabah'a konuştu", "Sabah"],
      ["Bakan Posta’ya konuştu", "Posta"],
      ["Bakan İstiklal’e konuştu", "İstiklal"],
      ["Bakan Bugün’e konuştu", "Bugün"],
      ["Bakan STAR'a konuştu", "Star"],
      ["Bakan Evrensel’e konuştu", "Evrensel"],
      ["Bakan Sözcü‘ye konuştu", "Sözcü"],
      ["Bakan Sözcüʼye konuştu", "Sözcü"],
    ])("true for %j / %s", (title, name) => {
      expect(titleNamesOutlet(title, { name })).toBe(true);
    });

    it("is false for lowercase, a bare apostrophe, or an apostrophe not followed by a letter", () => {
      expect(titleNamesOutlet("sözcü'ye konuştu", { name: "Sözcü" })).toBe(false);
      expect(titleNamesOutlet("Bakan sabah'a kadar bekledi", { name: "Sabah" })).toBe(false);
      expect(titleNamesOutlet("Bakan Karar' dedi", { name: "Karar" })).toBe(false);
      expect(titleNamesOutlet("Bakan Karar'", { name: "Karar" })).toBe(false);
      expect(titleNamesOutlet("Bakan Karar'1 dedi", { name: "Karar" })).toBe(false);
    });

    it("is false for mixed case that is neither Title case nor ALL CAPS", () => {
      expect(titleNamesOutlet("Bakan sÖzcü'ye konuştu", { name: "Sözcü" })).toBe(false);
      expect(titleNamesOutlet("Bakan SözCü'ye konuştu", { name: "Sözcü" })).toBe(false);
    });

    it("needs the whole name before the apostrophe, not a longer word that ends in it", () => {
      expect(titleNamesOutlet("Bakan Karardan'a konuştu", { name: "Karar" })).toBe(false);
      expect(titleNamesOutlet("Bakan AKarar'a konuştu", { name: "Karar" })).toBe(false);
      expect(titleNamesOutlet("Bakan Sözcüsü'ne konuştu", { name: "Sözcü" })).toBe(false);
    });
  });

  describe("an ALL-CAPS whole word of 4 or more letters", () => {
    it.each([
      ["Bakan SÖZCÜ'ye değil, SÖZCÜ yazdı", "Sözcü"],
      ["Gündeme getiren KARAR oldu", "Karar"],
      ["KARAR gazetesi yazdı: bakan istifa etti", "Karar"],
      ["Bakan AKŞAM yazdı", "Akşam"],
      ["Bakan YURT yazdı", "Yurt"],
      ["Bakan DİKEN yazdı", "Diken"],
    ])("true for %j / %s", (title, name) => {
      expect(titleNamesOutlet(title, { name })).toBe(true);
    });

    it("is false for lowercase and Title case at the title start (the common word)", () => {
      expect(titleNamesOutlet("Sabah saatlerinde deprem", { name: "Sabah" })).toBe(false);
      expect(titleNamesOutlet("Anayasa Mahkemesi karar verdi", { name: "Karar" })).toBe(false);
    });
  });

  describe("the sub-list Milliyet, Takvim, Sözcü, Korkusuz, Diken: Title case after the first word", () => {
    it.each([
      ["Çelişkiyi Takvim yakaladı", "Takvim"],
      ["Bakan, Milliyet yazarına yanıt verdi", "Milliyet"],
      ["Çelişkiyi Sözcü yakaladı", "Sözcü"],
      ["Çelişkiyi Korkusuz yakaladı", "Korkusuz"],
      ["Çelişkiyi Diken yakaladı", "Diken"],
      ["Bakan yanıt verdi - Takvim", "Takvim"],
    ])("true for %j / %s", (title, name) => {
      expect(titleNamesOutlet(title, { name })).toBe(true);
    });

    it("is false at the title start, where the common word is capitalised", () => {
      expect(titleNamesOutlet("Takvim yaprağı değişti", { name: "Takvim" })).toBe(false);
      expect(titleNamesOutlet("Sözcü Ömer Çelik açıkladı", { name: "Sözcü" })).toBe(false);
      expect(titleNamesOutlet("Milliyet haberi: yeni gelişme", { name: "Milliyet" })).toBe(false);
    });

    it("is false for lowercase, and for a longer word that only starts with the name", () => {
      expect(titleNamesOutlet("seçim takvimi açıklandı", { name: "Takvim" })).toBe(false);
      expect(titleNamesOutlet("Hükümet takvim açıkladı", { name: "Takvim" })).toBe(false);
      expect(titleNamesOutlet("AK Parti Sözcüsü Çelik açıkladı", { name: "Sözcü" })).toBe(false);
      expect(titleNamesOutlet("Bakan dikenli telin yanında", { name: "Diken" })).toBe(false);
    });

    it("does not extend to the other ordinary-word names", () => {
      expect(titleNamesOutlet("Mahkemenin Karar Duruşması başladı", { name: "Karar" })).toBe(false);
      expect(titleNamesOutlet("Meclis Cumhuriyet Bayramı için toplandı", { name: "Cumhuriyet" })).toBe(false);
      expect(titleNamesOutlet("Bakan Sabah Namazı sonrası konuştu", { name: "Sabah" })).toBe(false);
    });
  });

  describe("a title-initial series line, '<Name> <place>'den bildiriyor'", () => {
    it.each([
      ["Cumhuriyet Silivri'den bildiriyor... İBB davasında karar", "Cumhuriyet"],
      ["Cumhuriyet Ankara’dan bildiriyor: Meclis'te son durum", "Cumhuriyet"],
      ["Sabah Ankara'dan bildiriyor", "Sabah"],
      ["Cumhuriyet Mersin'den bildiriyor", "Cumhuriyet"],
      ["Cumhuriyet Antep'ten bildiriyor", "Cumhuriyet"],
      ["  Cumhuriyet Silivri'den bildiriyor", "Cumhuriyet"],
      ["CUMHURİYET SİLİVRİ'DEN BİLDİRİYOR", "Cumhuriyet"],
      ["cumhuriyet silivri'den bildiriyor", "Cumhuriyet"],
    ])("true for %j / %s", (title, name) => {
      expect(titleNamesOutlet(title, { name })).toBe(true);
    });

    it.each([
      ["Silivri'den bildiriyor Cumhuriyet", "Cumhuriyet"],
      ["Muhabir Cumhuriyet Silivri'den bildiriyor", "Cumhuriyet"],
      ["Cumhuriyet Halk Partisi Silivri'den bildiriyor", "Cumhuriyet"],
      ["Cumhuriyet Silivri'ye bildiriyor", "Cumhuriyet"],
      ["Cumhuriyet Silivri'den haber geldi", "Cumhuriyet"],
      ["Cumhuriyet Silivri bildiriyor", "Cumhuriyet"],
      ["Cumhuriyet Silivri'den bildiriyor", "Sabah"],
      ["Cumhuriyet Silivri'den bildiriyor", "Habertürk"],
    ])("false for %j / %s", (title, name) => {
      expect(titleNamesOutlet(title, { name })).toBe(false);
    });
  });

  describe("the exemptions that stay", () => {
    it("Türkiye is never reported in any form (the country, not only an outlet)", () => {
      expect(titleNamesOutlet("Türkiye'nin ekonomisi büyüdü", { name: "Türkiye" })).toBe(false);
      expect(titleNamesOutlet("TÜRKİYE'de enflasyon düştü", { name: "Türkiye" })).toBe(false);
      expect(titleNamesOutlet("Bakan TÜRKİYE yazdı", { name: "Türkiye" })).toBe(false);
      expect(titleNamesOutlet("Bakan Türkiye'ye döndü", { name: "Türkiye" })).toBe(false);
      expect(titleNamesOutlet("Türkiye Ankara'dan bildiriyor", { name: "Türkiye" })).toBe(false);
    });

    it("Türkiye Gazetesi is the multi-word phrase and does not fire on the country", () => {
      expect(titleNamesOutlet("Türkiye'nin ekonomisi büyüdü", { name: "Türkiye Gazetesi" })).toBe(false);
      expect(titleNamesOutlet("TÜRKİYE'de enflasyon düştü", { name: "Türkiye Gazetesi" })).toBe(false);
    });

    it("another outlet's name in the title is not this outlet's self-reference", () => {
      expect(titleNamesOutlet("Bakan Hürriyet’e konuştu", { name: "Sabah" })).toBe(false);
      expect(titleNamesOutlet("Bakan SÖZCÜ'ye konuştu", { name: "Karar" })).toBe(false);
      expect(titleNamesOutlet("Çelişkiyi Takvim yakaladı", { name: "Milliyet" })).toBe(false);
    });

    it("Cumhuriyet Halk Partisi stays a party, in every form it takes", () => {
      expect(titleNamesOutlet("Cumhuriyet Halk Partisi açıklama yaptı", { name: "Cumhuriyet" })).toBe(false);
      expect(titleNamesOutlet("Bakan Cumhuriyet Halk Partisi'ne yanıt verdi", { name: "Cumhuriyet" })).toBe(false);
    });
  });

  describe("linear time", () => {
    // Every shape is a title that does NOT match (checked below), so the whole
    // title is scanned: a shape that matched at its first word would return at
    // once and guard nothing.
    const shapes: Array<[string, (n: number) => string, string]> = [
      ["candidate words, apostrophe not followed by a letter", rep("Karar' "), "Karar"],
      ["lowercase candidates with an apostrophe suffix", rep("karar'ın "), "Karar"],
      ["mixed-case candidates", rep("kARAR "), "Karar"],
      ["Title-case candidates after the first word, name not on the sub-list", rep("Bakan Karar "), "Karar"],
      ["Title-case candidates, apostrophe run", rep("'", "Karar"), "Karar"],
      ["series line with a long place token", rep("a'", "Cumhuriyet ", " bildiriyor"), "Cumhuriyet"],
      ["series line with a long run of apostrophes", rep("'", "Cumhuriyet x"), "Cumhuriyet"],
      ["one long word", rep("a", "Karar"), "Karar"],
      ["whitespace run", rep(" ", "Karar"), "Karar"],
      ["alias candidates", rep("CNNX "), "CNN Türk"],
    ];
    it.each(shapes)("grows linearly with the title: %s", (_label, gen, name) => {
      expect(titleNamesOutlet(gen(1_000), { name })).toBe(false);
      expectLinear(gen, (title) => titleNamesOutlet(title, { name }), { n: 200_000, ceilingMs: 4000 });
    });
  });
});

describe("titleNamesOutlet -- matching", () => {
  it("is case-insensitive with the Turkish dotted/dotless i, and ignores diacritics", () => {
    expect(titleNamesOutlet("BİANET'e göre", { name: "Bianet" })).toBe(true);
    expect(titleNamesOutlet("BIANET'e göre", { name: "Bianet" })).toBe(true);
    expect(titleNamesOutlet("habertürk yazdı", { name: "Habertürk" })).toBe(true);
    expect(titleNamesOutlet("HABERTURK yazdı", { name: "Habertürk" })).toBe(true);
    expect(titleNamesOutlet("halk tv'de konuştu", { name: "Halk TV" })).toBe(true);
  });

  it("matches at the start, the middle and the end of the title", () => {
    expect(titleNamesOutlet("NTV: bakan açıkladı", { name: "NTV" })).toBe(true);
    expect(titleNamesOutlet("Bakan, NTV'ye açıkladı", { name: "NTV" })).toBe(true);
    expect(titleNamesOutlet("Bakan açıkladı - NTV", { name: "NTV" })).toBe(true);
    expect(titleNamesOutlet("NTV", { name: "NTV" })).toBe(true);
  });

  it("needs a whole-word match: the name inside a longer word is not a leak", () => {
    expect(titleNamesOutlet("Kontvilla projesi tamamlandı", { name: "NTV" })).toBe(false);
    expect(titleNamesOutlet("T245 sayılı karar", { name: "T24" })).toBe(false);
    expect(titleNamesOutlet("Haber77 kullanıcıları", { name: "Haber7" })).toBe(false);
    expect(titleNamesOutlet("Agosto ayında satış", { name: "Agos" })).toBe(false);
  });

  it("a multi-word name matches across any run of whitespace, in any case", () => {
    expect(titleNamesOutlet("Bakan Halk   TV'ye konuştu", { name: "Halk TV" })).toBe(true);
    expect(titleNamesOutlet("Bakan Halk\tTV'ye konuştu", { name: "Halk TV" })).toBe(true);
    expect(titleNamesOutlet("Bakan HALK TV'ye konuştu", { name: "halk  tv" })).toBe(true);
  });

  it("a multi-word name must match as one phrase, not as separate words", () => {
    expect(titleNamesOutlet("Halk için TV yayını başladı", { name: "Halk TV" })).toBe(false);
    expect(titleNamesOutlet("TV Halk anketi", { name: "Halk TV" })).toBe(false);
  });

  it("treats regex metacharacters in a name literally", () => {
    expect(titleNamesOutlet("Gazete.net'e konuştu", { name: "Gazete.net" })).toBe(true);
    expect(titleNamesOutlet("Gazetexnet'e konuştu", { name: "Gazete.net" })).toBe(false);
    expect(titleNamesOutlet("Bakan (A+B) açıkladı", { name: "(A+B)" })).toBe(true);
    expect(titleNamesOutlet("anything", { name: "(" })).toBe(false);
    expect(titleNamesOutlet("anything", { name: "[a-z]+" })).toBe(false);
  });

  it("does not throw and returns false for an empty or blank name or title", () => {
    expect(titleNamesOutlet("Bakan açıkladı", { name: "" })).toBe(false);
    expect(titleNamesOutlet("Bakan açıkladı", { name: "   " })).toBe(false);
    expect(titleNamesOutlet("", { name: "NTV" })).toBe(false);
    expect(titleNamesOutlet("   ", { name: "NTV" })).toBe(false);
  });

  it("handles emoji, quotes and other special characters around the name", () => {
    expect(titleNamesOutlet("🔴 NTV 🔴 son dakika", { name: "NTV" })).toBe(true);
    expect(titleNamesOutlet("“NTV” açıkladı", { name: "NTV" })).toBe(true);
    expect(titleNamesOutlet("'; DROP TABLE sources; -- açıklama", { name: "NTV" })).toBe(false);
  });

  it("is fast on a very long title (no catastrophic backtracking)", () => {
    const title = `${"halk ".repeat(20_000)}tv`;
    expect(titleNamesOutlet(title, { name: "Halk TV" })).toBe(true);
    expect(titleNamesOutlet(`${"halk ".repeat(20_000)}x`, { name: "Halk TV" })).toBe(false);
  });
});

describe("outlet-leak source guard", () => {
  const source = readFileSync(resolve(__dirname, "outlet-leak.ts"), "utf8");

  // No imports also means no import of daily-set.ts: the daily puzzle's own
  // titleLeaksOutlet stays untouched and this module stays client-safe.
  it("has no imports at all (it is pure and client-safe)", () => {
    for (const line of source.split("\n")) {
      expect(line.trimStart().startsWith("import "), line).toBe(false);
    }
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });
});
