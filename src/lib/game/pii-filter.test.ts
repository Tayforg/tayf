import { describe, it, expect } from "vitest";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import {
  PRIVATE_INDIVIDUAL_PATTERNS,
  PRIVATE_INDIVIDUAL_PATTERNS_V1,
  isGameEligibleTitle,
  isGameEligibleTitleV1,
} from "./pii-filter";

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

// h172-oyun-1: the list was anchored on ONE inflection of each word
// ("tutuklandı" but not "tutuklanmıştı" / "tutuklanan"), so a private
// individual named in a different inflection reached Bölge, Çerçeve, embeds and
// cards. v2 widens the stem of words ALREADY on the list; the list itself stays
// founder-owned, so the exact set of changes is pinned below.
describe("isGameEligibleTitle -- every inflection of a listed word (v2 stems)", () => {
  it.each([
    "Sarıgül soruşturmasında tutuklanmıştı: Aylin Kotil'den suç duyurusu",
    "Mesleki faaliyeti nedeniyle tutuklanan gazeteci Ali Tarakçı 46 gün sonra tahliye edildi",
    "Fon soruşturmasında tutuklanan Fatma Betül Sayan Kaya'nın ifadesi ortaya çıktı",
    "Casusluk soruşturmasıyla gözaltına alınmıştı: X'in ifadesi ortaya çıktı",
    "Yazar hakkında gözaltına alınan kişiler serbest bırakıldı",
    "Operasyonda gözaltına alınacak isimler belli oldu",
    "Dün gözaltı kararı verilen kişiler hakkında yeni gelişme",
    "Eylemde gözaltılar sürüyor, sayı açıklandı bugün",
    "HABAŞ'ta hayatını kaybeden işçiler için anma töreni düzenlendi",
    "Kazada hayatını kaybedenlerin sayısı yükseldi bugün",
    "Evinde öldürülen kadının cenazesi toprağa verildi",
    "Komşusunu öldüren kişi hakkında karar çıktı",
    "Aracıyla çarpıp öldürdü iddiası mahkemeye taşındı",
  ])("excludes %j", (title) => {
    expect(isGameEligibleTitle(title)).toBe(false);
  });

  it("matches an ALL-CAPS inflection through the Turkish-locale lowercase", () => {
    expect(isGameEligibleTitle("TUTUKLANMIŞTI")).toBe(false);
    expect(isGameEligibleTitle("GÖZALTINA ALINMIŞTI: ALİ VELİ'NİN İFADESİ")).toBe(false);
  });

  it("matches the diacritic-free spelling of an inflection", () => {
    expect(isGameEligibleTitle("tutuklanmisti")).toBe(false);
    expect(isGameEligibleTitle("Gazeteci gozaltina alinmisti, ifadesi cikti")).toBe(false);
    expect(isGameEligibleTitle("Isci hayatini kaybeden kisilerin yakinlari konustu")).toBe(false);
    expect(isGameEligibleTitle("Kadini oldurdu iddiasiyla yargilaniyor bugun")).toBe(false);
  });

  it("still accepts ordinary political headlines", () => {
    expect(isGameEligibleTitle("Bakan Şimşek bütçeyi Meclis'e sundu")).toBe(true);
    expect(isGameEligibleTitle("Merkez Bankası faiz kararını bugün açıklayacak")).toBe(true);
    expect(isGameEligibleTitle("Meclis bütçe görüşmelerine yarın devam edecek")).toBe(true);
  });

  // Review of h173: the diacritic-folded copy of /öldür/ is /oldur/, which also sits inside every
  // doldur- / soldur- form ("dolduruyor", "doldurdu", "soldurdu"). v2's stem is anchored on a word
  // start, so those ordinary headlines stay in the pool (20 of 32,104 prod titles in 3 days).
  it.each([
    "Dünya Türkiye’de buluştu: NYT’den itiraf gibi analiz! Boşluğu Ankara dolduruyor",
    "CHP mitingi Gündoğdu Meydanı'nı doldurdu",
    "Nvidia'nın boşalttığı koltuğunu kim doldurabilecek?",
    "Festival kampüsü doldurdu",
    "Renkler soldurdu",
  ])("accepts %j: the stem needs a word start, so doldur- / soldur- are no match", (title) => {
    expect(isGameEligibleTitle(title)).toBe(true);
  });

  it("keeps every word-start form of the stem, in every spelling", () => {
    for (const title of [
      "Evinde öldürülen kadının cenazesi toprağa verildi",
      "Komşusunu öldüren kişi hakkında karar çıktı",
      "Aracıyla çarpıp öldürdü iddiası mahkemeye taşındı",
      "Kadini oldurdu iddiasiyla yargilaniyor bugun",
      "KADINI ÖLDÜRDÜ",
      "\"Öldürdü\" iddiası",
      "Ali'yi öldürdü",
      "Öldürülmüş halde bulundu",
      "Yaralayıp-öldürdü",
    ]) {
      expect(isGameEligibleTitle(title), title).toBe(false);
    }
  });

  it("the one v1 rejection v2 drops is the mid-word one: v1's folded /oldurul/ sat inside 'doldurul-'", () => {
    expect(isGameEligibleTitleV1("Sandık doldurulacak")).toBe(false);
    expect(isGameEligibleTitle("Sandık doldurulacak")).toBe(true);
  });
});

describe("PRIVATE_INDIVIDUAL_PATTERNS_V1 / isGameEligibleTitleV1 (daily keys before the stem gate)", () => {
  it("keeps the list that served the already-played daily puzzles, word for word", () => {
    expect(PRIVATE_INDIVIDUAL_PATTERNS_V1.map((p) => p.source)).toEqual([
      "yaşındaki",
      "isimli",
      "adlı",
      "çocuk",
      "reşit olmayan",
      "şüpheli",
      "sanık",
      "mağdur",
      "tutukland",
      "tutuklu",
      "tutuklama",
      "gözaltına alınd",
      "gözaltında",
      "cinayet",
      "taciz",
      "istismar",
      "tecavüz",
      "intihar",
      "ceset",
      "öldürül",
      "yaralan",
      "hayatını kaybet",
      "bıçakl",
    ]);
  });

  it("accepts the later inflections v1 never matched", () => {
    expect(isGameEligibleTitleV1("Sarıgül soruşturmasında tutuklanmıştı: Aylin Kotil'den suç duyurusu")).toBe(true);
    expect(isGameEligibleTitleV1("tutuklanmisti")).toBe(true);
    expect(isGameEligibleTitleV1("Gazeteci gözaltına alınmıştı: X'in ifadesi")).toBe(true);
    expect(isGameEligibleTitleV1("HABAŞ'ta hayatını kaybeden işçiler")).toBe(true);
    expect(isGameEligibleTitleV1("Komşusunu öldüren kişi hakkında karar çıktı")).toBe(true);
  });

  it("still rejects what v1 always rejected, diacritic-aware and folded", () => {
    expect(isGameEligibleTitleV1("Zanlı bugün çıkarıldığı mahkemece tutuklandı")).toBe(false);
    expect(isGameEligibleTitleV1("Olayla bağlantılı kişi gözaltına alındı")).toBe(false);
    expect(isGameEligibleTitleV1("X. ADLI KİŞİ GÖZALTINA ALINDI")).toBe(false);
    expect(isGameEligibleTitleV1("Sanik ifadesinde suclamalari reddetti")).toBe(false);
    expect(isGameEligibleTitleV1("Kadın evinde öldürülmüş halde bulundu")).toBe(false);
    expect(isGameEligibleTitleV1("Sürücü kazada hayatını kaybetti")).toBe(false);
  });

  it("accepts a clean headline", () => {
    expect(isGameEligibleTitleV1("Bakan Şimşek bütçeyi Meclis'e sundu")).toBe(true);
  });

  it("every v1 rejection is also a v2 rejection (v2 only ever widens)", () => {
    for (const title of [
      "17 yaşındaki genç trafik kazasında hayatını kaybetti",
      "Zanlı bugün çıkarıldığı mahkemece tutuklandı",
      "Olayla bağlantılı kişi gözaltına alındı",
      "Şüpheli hâlâ gözaltında tutuluyor",
      "Kadın evinde öldürülmüş halde bulundu",
      "Mahkeme tutuklama kararı verdi",
    ]) {
      expect(isGameEligibleTitleV1(title)).toBe(false);
      expect(isGameEligibleTitle(title)).toBe(false);
    }
  });
});

// The list is founder-owned (migration 165): v2 may only widen the stem of a
// word already on it. Any other change must touch this test, so it cannot slip
// in unnoticed. /yaşamını yitir/, /zanlı/ and /etkin pişmanlık/ are founder
// proposals and are deliberately NOT here.
describe("PRIVATE_INDIVIDUAL_PATTERNS (v2) is v1 plus stem widening only", () => {
  const sources = PRIVATE_INDIVIDUAL_PATTERNS.map((p) => p.source);
  const v1Sources = PRIVATE_INDIVIDUAL_PATTERNS_V1.map((p) => p.source);

  it("differs from v1 by exactly four stems widened and one stem split off", () => {
    const widened: Record<string, string> = {
      tutukland: "tutuklan",
      "gözaltına alınd": "gözaltına alın",
      "öldürül": "(?<![a-zçğıöşü])öldür",
      "hayatını kaybet": "hayatını kayb",
    };
    const expected = v1Sources.flatMap((s) => {
      const next = widened[s] ?? s;
      return s === "gözaltında" ? [next, "gözaltı"] : [next];
    });
    expect(sources).toEqual(expected);
  });

  it("leaves the three founder proposals out of the code", () => {
    expect(sources).not.toContain("yaşamını yitir");
    expect(sources).not.toContain("zanlı");
    expect(sources).not.toContain("etkin pişmanlık");
    // The three words are not on the list in any other form either, so a title
    // that holds only them stays eligible until the founder decides.
    expect(isGameEligibleTitle("Aracın çarpması sonucu yaşamını yitiren Murat için tören düzenlendi")).toBe(true);
    expect(isGameEligibleTitle("Ömer Sarıgül etkin pişmanlıktan yararlanmak istiyor")).toBe(true);
    expect(isGameEligibleTitle("Yaşanan olayda zanlı polise teslim oldu bugün")).toBe(true);
  });

  it("stays short and reviewable", () => {
    expect(PRIVATE_INDIVIDUAL_PATTERNS.length).toBeLessThanOrEqual(30);
  });
});

describe("isGameEligibleTitle -- linear time", () => {
  // Every pattern is a literal (öldür behind a one-character lookbehind), so a long title cannot backtrack; the growth of
  // the CPU time (not a wall-clock budget) is the guard. Every shape is a title
  // that matches no pattern (checked below), so the whole title is scanned.
  it.each([
    ["no match, plain words", rep("siyasi gundem ")],
    ["near-match stems", rep("tutukla ")],
    ["near-match stems, folded", rep("gozalt ")],
    ["near-match stems, diacritics", rep("öld ür ")],
    ["near-match stem behind a letter (the lookbehind of öldür)", rep("doldur ")],
  ])("grows linearly with the title: %s", (_label, gen) => {
    expect(isGameEligibleTitle(gen(1_000))).toBe(true);
    expect(isGameEligibleTitleV1(gen(1_000))).toBe(true);
    expectLinear(gen, (title) => isGameEligibleTitle(title), { n: 200_000, ceilingMs: 4000 });
    expectLinear(gen, (title) => isGameEligibleTitleV1(title), { n: 200_000, ceilingMs: 4000 });
  });
});
