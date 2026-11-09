import { describe, it, expect } from "vitest";

import {
  SIBLING_VETO,
  siblingTitleTokens,
  siblingTitlesMatch,
  siblingTitlesMatchRare,
  stemDocFrequency,
} from "./sibling-veto";

// Migration 180 adds a second, rare-stem evidence tier to the sibling veto of 126/148.
// The strict tier (3 shared stems, Jaccard >= 0.5) is unchanged; the new tier accepts a
// looser overlap (3 shared stems, Jaccard >= 0.3) when at least two of the shared stems are
// rare in the search window (document frequency <= 0.25 percent of the window's titles).
// This file pins the TypeScript twin of that rule; the SQL copy is pinned to these numbers
// by tests/migrations/180-blindspot-sibling-rare-tier.test.ts and exercised on PG15 by
// tests/migrations/sql/180-blindspot-sibling-rare-tier-dryrun.sql.

// Production, read-only, 2026-11-08: cluster 30b3b262 (Ruhsatli silahlara celik kasa sarti) and
// the headline the silent zone ran on the same day. Six shared stems, Jaccard 0.43: below the
// strict tier's 0.5, so migration 148 let the public "Kor nokta" claim stand.
const CELIK_A = "Ruhsatlı Silahlara Çelik Kasa Şartı! Bakan Çiftçi Yeni Düzenlemeyi Açıkladı";
const CELIK_B = "Okul saldırılarının ardından yeni dönem: Silah ruhsatında çelik kasa şartı!";
const CELIK_DF = { kasa: 9, sarti: 11, ruhsa: 22, celik: 33, silah: 95, yeni: 600 };

// The false-positive guard: two different ministers announcing flood aid. Five shared stems,
// Jaccard 0.36, but only ONE of them (selde) is rare.
const SELDEN_A = "Bakan Göktaş Mersin'e selden etkilenenler için 11 milyon lira aktarıldığını açıkladı";
const SELDEN_B = "Bakan Kacır duyurdu: Selden etkilenen işletmelere 1 milyon lira destek";
const SELDEN_DF = { selde: 3, etkil: 105, milyo: 242, lira: 89, bakan: 655 };

const TOTAL = 15105; // titles in the window; 0.0025 * 15105 = 37.76, so a stem is rare at df <= 37

const dfOf = (counts: Record<string, number>): Map<string, number> => new Map(Object.entries(counts));

/** Two headlines built from named stems: `shared` of them in both, `onlyA` / `onlyB` in one. */
function pair(shared: string[], onlyA: string[], onlyB: string[]): [string, string] {
  return [[...shared, ...onlyA].join(" "), [...shared, ...onlyB].join(" ")];
}

describe("SIBLING_VETO constants", () => {
  it("keeps the 126 numbers and adds the rare tier's", () => {
    expect(SIBLING_VETO.minJaccard).toBe(0.5);
    expect(SIBLING_VETO.minShared).toBe(3);
    expect(SIBLING_VETO.windowHours).toBe(24);
    expect(SIBLING_VETO.scopeHours).toBe(48);
    expect(SIBLING_VETO.tokenMinLen).toBe(4);
    expect(SIBLING_VETO.stemLen).toBe(5);
    expect(SIBLING_VETO.looseMinShared).toBe(3);
    expect(SIBLING_VETO.looseMinJaccard).toBe(0.3);
    expect(SIBLING_VETO.rareMinShared).toBe(2);
    expect(SIBLING_VETO.rareMaxDocShare).toBe(0.0025);
  });

  it("the loose tier is looser than the strict one, never stricter", () => {
    expect(SIBLING_VETO.looseMinJaccard).toBeLessThan(SIBLING_VETO.minJaccard);
    expect(SIBLING_VETO.looseMinShared).toBeGreaterThanOrEqual(SIBLING_VETO.minShared);
  });
});

describe("stemDocFrequency", () => {
  it("counts the titles that contain each stem", () => {
    const df = stemDocFrequency(["Kasa şartı geldi", "Çelik kasa şartı", "Yeni kasa kararı"]);
    expect(df.get("kasa")).toBe(3);
    expect(df.get("sarti")).toBe(2);
    expect(df.get("celik")).toBe(1);
    expect(df.get("yeni")).toBe(1);
    expect(df.get("zzzzz")).toBeUndefined();
  });

  it("counts a stem once per title, however often the title repeats it", () => {
    const df = stemDocFrequency(["kasa kasa kasa kasalar kasada"]);
    expect(df.get("kasa")).toBe(1);
  });

  it("uses the same stems as siblingTitleTokens (fold, 4+ letters, first 5 characters)", () => {
    const title = "Ruhsatlı Silahlara Çelik Kasa Şartı ve Bir Ay";
    const df = stemDocFrequency([title]);
    expect([...df.keys()].sort()).toEqual([...siblingTitleTokens(title)].sort());
    expect(df.has("ve")).toBe(false);
    expect(df.has("silah")).toBe(true);
  });

  it("returns an empty map for no titles, empty titles and nullish entries", () => {
    expect(stemDocFrequency([]).size).toBe(0);
    expect(stemDocFrequency(["", "   ", "ab cd"]).size).toBe(0);
    expect(stemDocFrequency([null, undefined] as unknown as string[]).size).toBe(0);
  });

  it("handles 10,000 titles", () => {
    const titles = Array.from({ length: 10_000 }, (_, i) => `ortak haber başlığı ${i}x${i % 97}abc benzersiz${i}`);
    const df = stemDocFrequency(titles);
    expect(df.get("ortak")).toBe(10_000);
    expect(df.get("haber")).toBe(10_000);
    expect(df.get("benze")).toBe(10_000);
  });
});

describe("siblingTitlesMatchRare, the 30b3b262 shape (fixture 1)", () => {
  it("fixture is as documented: 6 shared stems, Jaccard 0.43, strict tier false", () => {
    const a = siblingTitleTokens(CELIK_A);
    const b = siblingTitleTokens(CELIK_B);
    const shared = [...a].filter((t) => b.has(t));
    expect(shared.sort()).toEqual(["celik", "kasa", "ruhsa", "sarti", "silah", "yeni"]);
    expect(shared.length / (a.size + b.size - shared.length)).toBeCloseTo(0.4286, 3);
    expect(siblingTitlesMatch(CELIK_A, CELIK_B)).toBe(false);
  });

  it("matches through the rare tier: kasa, sarti, ruhsa and celik are rare in 15,105 titles", () => {
    expect(siblingTitlesMatchRare(CELIK_A, CELIK_B, dfOf(CELIK_DF), TOTAL)).toBe(true);
    expect(siblingTitlesMatchRare(CELIK_B, CELIK_A, dfOf(CELIK_DF), TOTAL)).toBe(true);
  });

  it("does not match once those stems are common (not rare)", () => {
    const common = { ...CELIK_DF, kasa: 400, sarti: 400, ruhsa: 400, celik: 400 };
    expect(siblingTitlesMatchRare(CELIK_A, CELIK_B, dfOf(common), TOTAL)).toBe(false);
  });

  it("needs two rare stems: one rare stem is not enough", () => {
    const one = { ...CELIK_DF, kasa: 400, sarti: 400, ruhsa: 400, celik: 9 };
    expect(siblingTitlesMatchRare(CELIK_A, CELIK_B, dfOf(one), TOTAL)).toBe(false);
    const two = { ...one, ruhsa: 9 };
    expect(siblingTitlesMatchRare(CELIK_A, CELIK_B, dfOf(two), TOTAL)).toBe(true);
  });
});

describe("siblingTitlesMatchRare, the false-positive guard (fixture 2)", () => {
  it("fixture is as documented: 5 shared stems, Jaccard 0.36, strict tier false", () => {
    const a = siblingTitleTokens(SELDEN_A);
    const b = siblingTitleTokens(SELDEN_B);
    const shared = [...a].filter((t) => b.has(t));
    expect(shared.sort()).toEqual(["bakan", "etkil", "lira", "milyo", "selde"]);
    expect(shared.length / (a.size + b.size - shared.length)).toBeCloseTo(0.357, 3);
    expect(siblingTitlesMatch(SELDEN_A, SELDEN_B)).toBe(false);
  });

  it("is not a match: only one shared stem (selde) is rare", () => {
    expect(siblingTitlesMatchRare(SELDEN_A, SELDEN_B, dfOf(SELDEN_DF), TOTAL)).toBe(false);
    expect(siblingTitlesMatchRare(SELDEN_B, SELDEN_A, dfOf(SELDEN_DF), TOTAL)).toBe(false);
  });
});

describe("siblingTitlesMatchRare, boundaries (all inclusive)", () => {
  // A: 3 shared + 3 own = 6 stems; B: 3 shared + 4 own = 7 stems; union 10, Jaccard exactly 0.3.
  const SHARED = ["alfa", "beta", "gama"];
  const [a30, b30] = pair(SHARED, ["delta", "kappa", "sigma"], ["omega", "theta", "iota", "lambda"]);
  const RARE_DF = { alfa: 1, beta: 1, gama: 900 };

  it("fixture: Jaccard exactly 0.3, three shared stems, strict tier false", () => {
    const a = siblingTitleTokens(a30);
    const b = siblingTitleTokens(b30);
    expect([a.size, b.size]).toEqual([6, 7]);
    expect(3 / (a.size + b.size - 3)).toBe(0.3);
    expect(siblingTitlesMatch(a30, b30)).toBe(false);
  });

  it("Jaccard exactly 0.3 passes", () => {
    expect(siblingTitlesMatchRare(a30, b30, dfOf(RARE_DF), 100_000)).toBe(true);
  });

  it("Jaccard just below 0.3 fails (3 / 11)", () => {
    const [a, b] = pair(SHARED, ["delta", "kappa", "sigma"], ["omega", "theta", "iota", "lambda", "upsil"]);
    expect(siblingTitlesMatchRare(a, b, dfOf(RARE_DF), 100_000)).toBe(false);
  });

  it("a stem whose df is exactly floor(0.0025 * total) is rare; one more is not", () => {
    // total 4000: limit 10.
    const edge = (df: number) => dfOf({ alfa: df, beta: df, gama: 900 });
    expect(siblingTitlesMatchRare(a30, b30, edge(10), 4000)).toBe(true);
    expect(siblingTitlesMatchRare(a30, b30, edge(11), 4000)).toBe(false);
    // total 15,105: limit 37.76, so 37 is rare and 38 is not.
    expect(siblingTitlesMatchRare(a30, b30, edge(37), TOTAL)).toBe(true);
    expect(siblingTitlesMatchRare(a30, b30, edge(38), TOTAL)).toBe(false);
  });

  it("the rare-stem floor is two: one rare shared stem fails, two pass", () => {
    expect(siblingTitlesMatchRare(a30, b30, dfOf({ alfa: 1, beta: 900, gama: 900 }), 100_000)).toBe(false);
    expect(siblingTitlesMatchRare(a30, b30, dfOf({ alfa: 1, beta: 1, gama: 900 }), 100_000)).toBe(true);
  });

  it("the shared-stem floor stays three: two shared rare stems with Jaccard 1.0 do not match", () => {
    const [a, b] = ["alfa beta", "alfa beta"];
    expect(siblingTitlesMatchRare(a as string, b as string, dfOf({ alfa: 1, beta: 1 }), 100_000)).toBe(false);
    // two shared, rare, 3 stems each: Jaccard 0.5, still under three shared
    const [c, d] = pair(["alfa", "beta"], ["gama"], ["delta"]);
    expect(siblingTitlesMatchRare(c, d, dfOf({ alfa: 1, beta: 1 }), 100_000)).toBe(false);
  });

  it("a stem missing from docFreq counts as df 0, so it is rare (as specified)", () => {
    expect(siblingTitlesMatchRare(a30, b30, new Map(), 100_000)).toBe(true);
    // ... but an empty window (total 0) has limit 0 and df 0 is still <= 0
    expect(siblingTitlesMatchRare(a30, b30, new Map(), 0)).toBe(true);
    // a present stem with df 1 is not rare when the window is empty
    expect(siblingTitlesMatchRare(a30, b30, dfOf({ alfa: 1, beta: 1, gama: 1 }), 0)).toBe(false);
  });
});

describe("siblingTitlesMatchRare is a superset of siblingTitlesMatch", () => {
  const A = "alfa beta gama delta";

  it("keeps every strict match, whatever the document frequencies say", () => {
    const common = dfOf({ alfa: 9999, beta: 9999, gama: 9999, delta: 9999 });
    expect(siblingTitlesMatch(A, "alfa beta gama kappa sigma")).toBe(true);
    expect(siblingTitlesMatchRare(A, "alfa beta gama kappa sigma", common, TOTAL)).toBe(true);
    expect(siblingTitlesMatchRare(A, "alfa beta gama kappa sigma", new Map(), 0)).toBe(true);
  });

  it("agrees with siblingTitlesMatch where neither tier fires", () => {
    expect(siblingTitlesMatchRare(A, "omega theta iota lambda", new Map(), TOTAL)).toBe(false);
    expect(siblingTitlesMatchRare("alfa beta", "alfa beta", new Map(), TOTAL)).toBe(false);
  });

  it("the bdbf9948 birgun headline stays unmatched against all five members when its stems are common", () => {
    // Production 2026-11-02 (the 148 fixture): birgun's short headline shares at most 4 stems with a
    // member, Jaccard 0.364 at best, and the strict tier rejects it. The rare tier must not rescue it
    // while the words of the story (sosyal, medya, hesap, yarin) are common in the window.
    const members = [
      "Sosyal medyada yeni dönem yarın başlıyor: e-Devlet üzerinden zorunlu olacak",
      "15 yaşını doldurmamış çocukların sosyal hesabı kapatılıyor! Yeni uygulama yarın başlayacak",
      "15 yaş altına sosyal medya yasağı yarın başlıyor: Yaş doğrulama e-Devlet'ten yapılacak",
      "Yapmayanın hesabı kapanacak... Sosyal medyada yeni dönem 1 Kasım'da başlıyor",
      "Yapmayanın hesabı kapatılacak: Sosyal medyada yeni dönem yarın başlıyor",
    ];
    const birgun = "Sosyal medya yasağı başlıyor: Hesaplar kapatılacak";
    const window = [
      ...members,
      birgun,
      ...Array.from({ length: 2000 }, (_, i) => `sosyal medya hesap yarın başlıyor yasak ${i}`),
    ];
    const df = stemDocFrequency(window);
    for (const member of members) {
      expect(siblingTitlesMatch(member, birgun)).toBe(false);
      expect(siblingTitlesMatchRare(member, birgun, df, window.length)).toBe(false);
    }
  });
});

describe("siblingTitlesMatchRare, invalid input", () => {
  it("is false for null, undefined and empty titles", () => {
    const df = dfOf(CELIK_DF);
    expect(siblingTitlesMatchRare(null, CELIK_B, df, TOTAL)).toBe(false);
    expect(siblingTitlesMatchRare(CELIK_A, undefined, df, TOTAL)).toBe(false);
    expect(siblingTitlesMatchRare("", "", df, TOTAL)).toBe(false);
    expect(siblingTitlesMatchRare(null, null, df, TOTAL)).toBe(false);
  });

  it("folds Turkish capitals and special characters before comparing", () => {
    // İ, Ş, Ğ, Ü, Ö, Ç fold to ASCII; emoji and punctuation split words
    const [a, b] = pair(["İSTANBUL", "ŞİŞLİ", "ÇÖZÜM"], ["alfa 🚀", "beta, gama"], ["delta", "kappa", "sigma!!"]);
    const df = dfOf({ istan: 1, sisli: 1, cozum: 1 });
    expect(siblingTitlesMatchRare(a, b, df, 100_000)).toBe(true);
  });
});
