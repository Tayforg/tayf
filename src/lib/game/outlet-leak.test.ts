import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
    expect(titleNamesOutlet(`Son dakika ${name.toUpperCase()}`, { name })).toBe(false);
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
