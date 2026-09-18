import { describe, it, expect } from "vitest";
import { PRIVATE_INDIVIDUAL_PATTERNS, isGameEligibleTitle } from "./pii-filter";

// Each listed pattern (see pii-filter.ts header) excludes a realistic
// Turkish headline that would name or strongly imply a private individual.
describe("isGameEligibleTitle — each pattern excludes", () => {
  const cases: Array<[string, string]> = [
    ["yaşındaki", "17 yaşındaki genç trafik kazasında hayatını kaybetti"],
    ["isimli", "Ahmet Yılmaz isimli kişi ifadeye çağrıldı"],
    ["adlı", "Mehmet K. adlı şahıs olay yerinde yakalandı"],
    ["çocuk", "Depremde bir çocuk enkazdan sağ çıkarıldı"],
    ["reşit olmayan", "Reşit olmayan bir kişi olayda gözlemlendi"],
    ["şüpheli", "Şüpheli ifadesinde suçlamaları reddetti"],
    ["sanık", "Sanık duruşmada susma hakkını kullandı"],
    ["mağdur", "Mağdur aileye psikolojik destek sağlandı"],
    ["tutuklandı", "Zanlı bugün çıkarıldığı mahkemece tutuklandı"],
    ["gözaltına alındı", "Olayla bağlantılı kişi gözaltına alındı"],
    ["tutuklu", "Tutuklu sayısı açıklandı"],
    ["tutuklama", "Mahkeme tutuklama kararı verdi"],
    ["gözaltında", "Şüpheli hâlâ gözaltında tutuluyor"],
    ["cinayet", "Kadın cinayeti davasında karar açıklandı"],
    ["taciz", "Taciz iddiasıyla gözaltına alındı"],
    ["istismar", "İstismar iddiaları soruşturuluyor"],
    ["tecavüz", "Tecavüz suçlamasıyla yargılanıyor"],
    ["intihar", "Genç kadın intihar girişiminde bulundu"],
    ["ceset", "Ormanlık alanda ceset bulundu"],
    ["öldürül", "Kadın evinde öldürülmüş halde bulundu"],
    ["yaralan", "İki kişi trafik kazasında yaralandı"],
    ["hayatını kaybet", "Sürücü kazada hayatını kaybetti"],
    ["bıçakl", "Şüpheli bir kişiyi bıçakladı"],
  ];

  it.each(cases)("excludes a headline matching %s", (_label, title) => {
    expect(isGameEligibleTitle(title)).toBe(false);
  });
});

describe("isGameEligibleTitle — clean political headline", () => {
  it("passes a headline with no private-individual markers", () => {
    expect(
      isGameEligibleTitle("Merkez Bankası faiz kararını bugün açıklayacak"),
    ).toBe(true);
  });

  it("passes a headline about institutions, not people", () => {
    expect(
      isGameEligibleTitle("Meclis bütçe görüşmelerine yarın devam edecek"),
    ).toBe(true);
  });
});

describe("isGameEligibleTitle — case-insensitivity", () => {
  it("matches an all-uppercase headline using plain ASCII-folding letters", () => {
    expect(isGameEligibleTitle("BU ÇOCUK OKULA GİTMEK İSTEMİYOR")).toBe(false);
  });

  it("matches mixed-case variants of a pattern", () => {
    expect(isGameEligibleTitle("Mağdur AiLe konuştu")).toBe(false);
  });
});

describe("isGameEligibleTitle — Turkish dotted/dotless I", () => {
  it("matches a dotted capital İ variant (İSİMLİ)", () => {
    expect(isGameEligibleTitle("İSİMLİ bir kişi ifade verdi")).toBe(false);
  });

  it("matches a dotless capital I variant (ADLI, all-caps headline style)", () => {
    expect(
      isGameEligibleTitle("X. ADLI KİŞİ GÖZALTINA ALINDI"),
    ).toBe(false);
  });
});

// MF-06: diacritic-free Turkish (mistranscribed/degraded encoding, which
// this pipeline already carries a CP1254 mojibake regression test for)
// evades every plain-diacritic pattern above unless folded.
describe("isGameEligibleTitle — diacritic-free bypass [MF-06]", () => {
  it("excludes a diacritic-free 'yasindaki' headline", () => {
    expect(isGameEligibleTitle("17 yasindaki genc trafik kazasinda hayatini kaybetti")).toBe(
      false,
    );
  });

  it("excludes a diacritic-free 'sanik' headline", () => {
    expect(isGameEligibleTitle("Sanik ifadesinde suclamalari reddetti")).toBe(false);
  });

  it("excludes a diacritic-free 'magdur' headline", () => {
    expect(isGameEligibleTitle("Magdur aileye destek saglandi")).toBe(false);
  });

  it("excludes a diacritic-free 'supheli' headline", () => {
    expect(isGameEligibleTitle("Supheli olay yerinde yakalandi")).toBe(false);
  });

  it("does not exclude an ordinary political headline once folded", () => {
    // Folding must not introduce new false matches: "faiz kararini" has no
    // diacritics to fold and shares no stem with the exclusion list.
    expect(
      isGameEligibleTitle("Merkez Bankasi faiz kararini bugun aciklayacak"),
    ).toBe(true);
  });
});

describe("PRIVATE_INDIVIDUAL_PATTERNS", () => {
  it("is a short, non-empty, readonly list", () => {
    expect(PRIVATE_INDIVIDUAL_PATTERNS.length).toBeGreaterThan(0);
    // Bumped from 15 (MF-06 added the missing high-risk vocabulary: named
    // private individuals implicated in violent crime, sexual offences,
    // self-harm, and the "gözaltında"/"tutuklu" status stems the original
    // list only partially covered) — still small and reviewable.
    expect(PRIVATE_INDIVIDUAL_PATTERNS.length).toBeLessThanOrEqual(30);
    for (const pattern of PRIVATE_INDIVIDUAL_PATTERNS) {
      expect(pattern).toBeInstanceOf(RegExp);
    }
  });
});
