import { describe, it, expect } from "vitest";
import {
  AGENCY_COPY_OVERLAP,
  AGREEMENT_FORM_DEFECT_MIN,
  AGREEMENT_HIGH,
  AGREEMENT_LOW,
  AGREEMENT_MIN_CHARS,
  AGREEMENT_MIN_GAIN,
  AGREEMENT_MIN_TITLE_TOKENS,
  AGREEMENT_STUB_LOW_SEED,
  agreementSwitches,
  carriesOutcome,
  contentWords,
  findAgreeingMember,
  hasFiniteVerb,
  isCaseGarbled,
  isExplainerTitle,
  isLiveLine,
  isQuoteOnly,
  seedDisqualified,
  sharedStemsExcluding,
  stageBehindTitle,
  stemsOf,
  summaryDefect,
  textOverlap,
  titleAgreement,
  titleStemOverlap,
} from "./summary-agreement";
import { clampCutIntroducedQuote, isCtaFeedCut, tidySummaryText } from "@/lib/articles/summary-tidy";
import tailFixtures from "../../../tests/fixtures/summary-tail-h164.json";
import { summaryAttribution, summaryAttributionWithoutMembers } from "./summary-attribution";
import type { SummaryMember } from "./summary-attribution";
import type { SourceKind } from "@/types";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import type { Gen } from "../../../tests/_helpers/linear-time";

describe("thresholds (h31-reader-3 v2)", () => {
  it("are the documented values", () => {
    expect(AGREEMENT_LOW).toBe(0.5);
    expect(AGREEMENT_HIGH).toBe(0.75);
    expect(AGREEMENT_MIN_GAIN).toBe(0.3);
    expect(AGREEMENT_MIN_TITLE_TOKENS).toBe(3);
    expect(AGREEMENT_STUB_LOW_SEED).toBe(0.3);
    expect(AGREEMENT_MIN_CHARS).toBe(60);
    expect(AGENCY_COPY_OVERLAP).toBe(0.85);
  });
});

describe("textOverlap (is this text an agency's copy?)", () => {
  it("is 1 for the same words in any order, case, diacritics, punctuation and apostrophe suffix", () => {
    expect(textOverlap("kedi köpek kuş balık", "kedi köpek kuş balık")).toBe(1);
    expect(textOverlap("Senato'ya Michigan'da Rogers’ı", "ROGERS, michigan; SENATO!")).toBe(1);
    expect(textOverlap("İstanbul Şehir Güneş", "ISTANBUL SEHIR GUNES")).toBe(1);
    expect(textOverlap("Abdul El-Sayed kazandı", "abdul el sayed kazandi ve")).toBe(1);
  });

  it("is the share of the LARGER text's content stems that both carry (a long article that holds a lead is not a copy of it)", () => {
    expect(textOverlap("kedi köpek kuş balık", "kedi köpek")).toBe(0.5);
    expect(textOverlap("kedi köpek", "kedi köpek kuş balık")).toBe(0.5);
    expect(textOverlap("kedi köpek kuş balık", "kedi köpek kuş aslan")).toBe(0.75);
  });

  it("matches on the first five characters like the title agreement does", () => {
    expect(textOverlap("kazandı seçildi hapis", "kazanarak seçilen hapsi")).toBeCloseTo(2 / 3, 10);
  });

  it("is 0 for disjoint texts, an empty text, a text of stopwords only and a non-string", () => {
    expect(textOverlap("kedi köpek", "aslan kaplan")).toBe(0);
    expect(textOverlap("", "kedi köpek")).toBe(0);
    expect(textOverlap("kedi köpek", "")).toBe(0);
    expect(textOverlap("", "")).toBe(0);
    expect(textOverlap("ve ile bir", "ve ile bir")).toBe(0);
    expect(textOverlap(undefined as unknown as string, "kedi")).toBe(0);
    expect(textOverlap("kedi", null as unknown as string)).toBe(0);
  });

  it("is linear: two 100k-token texts are compared in well under a second", () => {
    const a = Array.from({ length: 100_000 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 100_000 }, (_, i) => `w${i + 50_000}`).join(" ");
    const start = Date.now();
    expect(textOverlap(a, b)).toBeGreaterThan(0);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("titleStemOverlap (the counts behind titleAgreement)", () => {
  it("is the shared stems and the title's stems, so shared / total is titleAgreement", () => {
    expect(titleStemOverlap("kedi köpek kuş balık", "kedi ve köpek")).toEqual({ shared: 2, total: 4 });
    expect(titleStemOverlap("kedi köpek kuş balık", "balık kuş köpek kedi")).toEqual({ shared: 4, total: 4 });
    expect(titleStemOverlap("kedi köpek kuş balık", "aslan kaplan fil zürafa")).toEqual({ shared: 0, total: 4 });
    for (const [t, x] of [
      ["kazandı seçildi hapis", "kazanarak seçilen hapsi"],
      ["Senato'ya Michigan'da Rogers’ı", "senato michigan"],
      ["kedi kedi köpek kuş", "kuş"],
    ] as const) {
      const o = titleStemOverlap(t, x);
      expect(o).not.toBeNull();
      expect((o?.shared ?? 0) / (o?.total ?? 1)).toBe(titleAgreement(t, x));
    }
  });

  it("counts each stem once, whatever its multiplicity", () => {
    expect(titleStemOverlap("kedi kedi köpek kuş", "kuş kuş kuş")).toEqual({ shared: 1, total: 3 });
  });

  it("is null for a title with too few content tokens, and for a non-string title (as titleAgreement)", () => {
    expect(titleStemOverlap("kedi köpek", "kedi köpek")).toBeNull();
    expect(titleStemOverlap(42 as unknown as string, "kedi köpek kuş")).toBeNull();
  });

  it("treats a non-string text as sharing nothing", () => {
    expect(titleStemOverlap("kedi köpek kuş", undefined as unknown as string)).toEqual({ shared: 0, total: 3 });
  });
});

describe("stemsOf and sharedStemsExcluding (h37-clusters-1: the shared stems, minus words that must not count)", () => {
  it("stemsOf is the folded five-character content stems: case, diacritics, apostrophe suffix and stopwords gone", () => {
    expect([...stemsOf("Cumhurbaşkanı Erdoğan'ın ziyareti")].sort()).toEqual(["cumhu", "erdog", "ziyar"]);
    expect([...stemsOf("İSTANBUL ve ISTANBUL")]).toEqual(["istan"]);
    expect(stemsOf("").size).toBe(0);
    expect(stemsOf(undefined as unknown as string).size).toBe(0);
  });

  it("stemsOf hands out a fresh set each time (a caller may keep it)", () => {
    const a = stemsOf("kedi köpek");
    a.add("zzz");
    expect(stemsOf("kedi köpek").has("zzz")).toBe(false);
  });

  it("counts the distinct stems of a that b also has", () => {
    const none = new Set<string>();
    expect(sharedStemsExcluding("kedi köpek kuş balık", "kedi ve köpek", none)).toBe(2);
    expect(sharedStemsExcluding("kedi köpek kuş balık", "aslan kaplan", none)).toBe(0);
    // Multiplicity does not matter, on either side.
    expect(sharedStemsExcluding("kedi kedi kedi köpek", "kedi kedi", none)).toBe(1);
    // Same folding as titleStemOverlap: suffixes, diacritics, case.
    expect(sharedStemsExcluding("Senato'ya Michigan'da Rogers’ı", "SENATO michigan", none)).toBe(2);
    // Five characters: kazan, seçil, and "hapis" is not "hapsi".
    expect(sharedStemsExcluding("kazandı seçildi hapis", "kazanarak seçilen hapsi", none)).toBe(2);
  });

  it("agrees with titleStemOverlap when nothing is excluded", () => {
    for (const [t, x] of [
      ["kedi köpek kuş balık", "kedi ve köpek"],
      ["Senato'ya Michigan'da Rogers’ı", "senato michigan"],
      ["kedi kedi köpek kuş", "kuş"],
    ] as const) {
      expect(sharedStemsExcluding(t, x, new Set())).toBe(titleStemOverlap(t, x)?.shared);
    }
  });

  it("drops the excluded stems from the count (stems, not words: the caller folds them the same way)", () => {
    const a = "Cumhurbaşkanı Erdoğan Azerbaycan'a ziyaret düşünüyor";
    const b = "Emine Erdoğan'dan Güney Kore ziyaretine ilişkin paylaşım";
    expect(sharedStemsExcluding(a, b, new Set())).toBe(2); // erdog, ziyar
    expect(sharedStemsExcluding(a, b, new Set(["erdog"]))).toBe(1);
    expect(sharedStemsExcluding(a, b, new Set(["erdog", "ziyar"]))).toBe(0);
    // A stem neither text has changes nothing.
    expect(sharedStemsExcluding(a, b, new Set(["nobody"]))).toBe(2);
    // The excluded set is read, never written.
    const excluded = new Set(["erdog"]);
    sharedStemsExcluding(a, b, excluded);
    expect([...excluded]).toEqual(["erdog"]);
  });

  it("has no minimum-token rule: a two-word title still counts (titleStemOverlap says null for it)", () => {
    expect(titleStemOverlap("Erdoğan ziyaret", "Erdoğan ziyaret etti")).toBeNull();
    expect(sharedStemsExcluding("Erdoğan ziyaret", "Erdoğan ziyaret etti", new Set())).toBe(2);
    expect(sharedStemsExcluding("Erdoğan ziyaret", "Erdoğan ziyaret etti", new Set(["erdog"]))).toBe(1);
  });

  it("is 0 for an empty text and for a non-string on either side", () => {
    const none = new Set<string>();
    expect(sharedStemsExcluding("", "kedi", none)).toBe(0);
    expect(sharedStemsExcluding("kedi", "", none)).toBe(0);
    expect(sharedStemsExcluding(undefined as unknown as string, "kedi", none)).toBe(0);
    expect(sharedStemsExcluding("kedi", null as unknown as string, none)).toBe(0);
    expect(sharedStemsExcluding(42 as unknown as string, 7 as unknown as string, none)).toBe(0);
  });

  it("is symmetric in its count of distinct shared stems", () => {
    const a = "Kestane Lokanta Marmara Nergis Orman";
    const b = "Lokanta Nergis festivali";
    expect(sharedStemsExcluding(a, b, new Set())).toBe(sharedStemsExcluding(b, a, new Set()));
    expect(sharedStemsExcluding(a, b, new Set(["lokan"]))).toBe(1);
  });
});

describe("contentWords and the skipWord parameter of sharedStemsExcluding (review fix: generic words match as words)", () => {
  it("contentWords is the folded content words: case, diacritics, apostrophe suffix, stopwords and one-letter words gone", () => {
    expect(contentWords("Cumhurbaşkanı Erdoğan'ın ve ZİYARETİ")).toEqual(["cumhurbaskani", "erdogan", "ziyareti"]);
    expect(contentWords("İSTANBUL ile ISTANBUL")).toEqual(["istanbul", "istanbul"]);
    expect(contentWords("a b ve 7")).toEqual(["7"]);
  });

  it("contentWords is the word list behind stemsOf: the same words cut to five characters", () => {
    const text = "Cumhuriyet Bayramı'nda kutlamalar, Kestane lokantası ve 14 Kasım";
    expect(new Set(contentWords(text).map((w) => w.slice(0, 5)))).toEqual(stemsOf(text));
  });

  it("contentWords is [] for an empty string and for a non-string", () => {
    expect(contentWords("")).toEqual([]);
    expect(contentWords(undefined as unknown as string)).toEqual([]);
    expect(contentWords(null as unknown as string)).toEqual([]);
    expect(contentWords(42 as unknown as string)).toEqual([]);
  });

  it("skipWord drops the flagged words from BOTH texts before the stems are built", () => {
    const a = "Cumhuriyet Bayramı kutlaması Cumhurbaşkanı";
    const b = "Cumhurbaşkanı Bayramı Cumhuriyet töreni";
    // No skip: cumhu, bayra are shared.
    expect(sharedStemsExcluding(a, b, new Set())).toBe(2);
    // Skipping the exact word 'cumhurbaskani' leaves Cumhuriyet's `cumhu` alone: still shared.
    expect(sharedStemsExcluding(a, b, new Set(), (w) => w === "cumhurbaskani")).toBe(2);
    // Skipping every cumhu* word removes the stem from both sides.
    expect(sharedStemsExcluding(a, b, new Set(), (w) => w.startsWith("cumhu"))).toBe(1);
  });

  it("a stem that only a skipped word on one side carries is not shared with the other side's plain word", () => {
    // Without skipWord: `cumhu` is shared (Cumhurbaşkanı vs Cumhuriyet). With the
    // generic word skipped on its side, Cumhuriyet has nothing to match.
    expect(sharedStemsExcluding("Cumhurbaşkanı Kestane", "Cumhuriyet Kestane", new Set())).toBe(2);
    expect(
      sharedStemsExcluding("Cumhurbaşkanı Kestane", "Cumhuriyet Kestane", new Set(), (w) => w === "cumhurbaskani"),
    ).toBe(1);
  });

  it("skipWord receives the folded word (diacritics out, lower case) and is called with nothing else", () => {
    const seen: string[] = [];
    sharedStemsExcluding("Açıklama ve İSTANBUL", "açıklama", new Set(), (w) => {
      seen.push(w);
      return false;
    });
    expect(seen.length).toBeGreaterThan(0);
    for (const w of seen) expect(w).toMatch(/^[a-z0-9]+$/);
    expect(seen).not.toContain("ve");
  });

  it("without skipWord the behaviour is unchanged, and `excluded` still applies beside it", () => {
    const a = "Kestane Lokanta Marmara Nergis";
    const b = "Kestane Lokanta Nergis festivali";
    expect(sharedStemsExcluding(a, b, new Set())).toBe(3);
    expect(sharedStemsExcluding(a, b, new Set(["kesta"]), (w) => w === "lokanta")).toBe(1);
  });

  it("is still 0 for a non-string on either side when a skipWord is given", () => {
    expect(sharedStemsExcluding(undefined as unknown as string, "kedi", new Set(), () => true)).toBe(0);
    expect(sharedStemsExcluding("kedi", null as unknown as string, new Set(), () => false)).toBe(0);
  });
});

describe("titleAgreement", () => {
  it("is the share of the title's content tokens that the text carries", () => {
    expect(titleAgreement("kedi köpek kuş balık", "kedi ve köpek")).toBe(0.5);
    expect(titleAgreement("kedi köpek kuş balık", "balık kuş köpek kedi")).toBe(1);
    expect(titleAgreement("kedi köpek kuş balık", "aslan kaplan fil zürafa")).toBe(0);
  });

  it("counts each title token once, whatever its multiplicity, and ignores the order", () => {
    expect(titleAgreement("kedi kedi köpek kuş", "kuş")).toBeCloseTo(1 / 3, 10);
    expect(titleAgreement("kedi köpek kuş", "kuş kuş kuş kuş kedi")).toBeCloseTo(2 / 3, 10);
  });

  it("folds Turkish case and diacritics: İ/I/ı, ş, ğ, ü, ö, ç", () => {
    expect(titleAgreement("İstanbul Şehir Güneş", "ISTANBUL SEHIR GUNES")).toBe(1);
    expect(titleAgreement("ISTANBUL SEHIR GUNES", "İstanbul şehir güneş")).toBe(1);
    expect(titleAgreement("seçim ağaç öğün", "SECIM AGAC OGUN")).toBe(1);
  });

  it("drops the suffix after an apostrophe, straight or curly", () => {
    expect(titleAgreement("Senato'ya Michigan'da Rogers’ı", "senato michigan rogers")).toBe(1);
    expect(titleAgreement("senato michigan rogers", "Senato’da Michigan'dan Rogers'a")).toBe(1);
  });

  it("splits on hyphens, slashes and punctuation, so 'El-Sayed' equals 'El Sayed'", () => {
    expect(titleAgreement("Abdul El-Sayed kazandı", "abdul el sayed kazandi")).toBe(1);
    expect(titleAgreement("Abdul El Sayed kazandı", "Abdul el-Sayed, kazandı!")).toBe(1);
    expect(titleAgreement("kedi/köpek “kuş” (balık)", "kedi köpek kuş balık")).toBe(1);
  });

  it("matches on the first five characters, so Turkish suffixes do not break a match", () => {
    expect(titleAgreement("kazandı seçildi hapis", "kazanarak seçilen hapsi")).toBeCloseTo(2 / 3, 10);
    // "seçim" and "seçilen" are different words: they share four characters only.
    expect(titleAgreement("seçim kazandı hapis", "seçilen kazandı hapis")).toBeCloseTo(2 / 3, 10);
  });

  it("counts numbers as content and drops stopwords and one-letter tokens", () => {
    expect(titleAgreement("14 yıl hapis istendi", "14 yıl")).toBe(0.5);
    // "ve", "ile", "bir", "için" and the single letter "k" are not content.
    expect(titleAgreement("Erdoğan ve Putin için bir toplantı K", "erdoğan putin toplantı")).toBe(1);
    expect(titleAgreement("the cat and the dog of a king", "cat dog king")).toBe(1);
  });

  it("is null when the title has fewer than 3 content tokens, a number when it has exactly 3", () => {
    expect(titleAgreement("ve ile bir", "ve ile bir")).toBeNull();
    expect(titleAgreement("Erdoğan Putin", "Erdoğan Putin görüştü")).toBeNull();
    expect(titleAgreement("Erdoğan Putin görüştü", "Erdoğan Putin görüştü")).toBe(1);
    expect(titleAgreement("", "metin metin metin")).toBeNull();
    expect(titleAgreement("   ", "metin")).toBeNull();
  });

  it("is 0 for an empty text and never throws on a non-string", () => {
    expect(titleAgreement("kedi köpek kuş", "")).toBe(0);
    expect(titleAgreement(undefined as unknown as string, "kedi")).toBeNull();
    expect(titleAgreement(null as unknown as string, "kedi")).toBeNull();
    expect(titleAgreement("kedi köpek kuş", undefined as unknown as string)).toBe(0);
    expect(titleAgreement("kedi köpek kuş", null as unknown as string)).toBe(0);
  });

  it("ignores emoji, quotes and other special characters", () => {
    expect(titleAgreement("kedi köpek kuş 🎉", "“kedi” 🐱 köpek 🐶 kuş 🐦")).toBe(1);
    expect(titleAgreement("kedi köpek kuş", "<b>kedi</b>; DROP TABLE x; köpek -- kuş")).toBe(1);
  });

  it("is linear: a 100k-token text is scored in well under a second", () => {
    const text = Array.from({ length: 100_000 }, (_, i) => `kelime${i}`).join(" ") + " kedi köpek";
    const start = Date.now();
    expect(titleAgreement("kedi köpek kuş", text)).toBeCloseTo(2 / 3, 10);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("agreementSwitches (the three-way gate)", () => {
  it("switches when the seed is below LOW, the candidate at least HIGH and the gain at least 0.3", () => {
    expect(agreementSwitches(0.44, 1)).toBe(true);
    expect(agreementSwitches(0, 0.75)).toBe(true);
    expect(agreementSwitches(0.25, 0.9)).toBe(true);
  });

  it("LOW is exclusive: a seed at exactly 0.5 is kept, just under it can be replaced", () => {
    expect(agreementSwitches(0.5, 1)).toBe(false);
    expect(agreementSwitches(0.4999, 0.9)).toBe(true);
    expect(agreementSwitches(0.75, 1)).toBe(false);
  });

  it("HIGH is inclusive: a candidate at exactly 0.75 qualifies, just under it does not", () => {
    expect(agreementSwitches(0.2, 0.75)).toBe(true);
    expect(agreementSwitches(0.2, 0.7499)).toBe(false);
    expect(agreementSwitches(0.2, 0.5)).toBe(false);
  });

  it("the gain is inclusive: 0.45 -> 0.75 is a gain of exactly 0.3, 0.46 -> 0.75 is not enough", () => {
    expect(agreementSwitches(0.45, 0.75)).toBe(true);
    expect(agreementSwitches(0.46, 0.75)).toBe(false);
    expect(agreementSwitches(0.4, 0.7)).toBe(false); // gain 0.3 but below HIGH
    expect(agreementSwitches(0.4, 0.75)).toBe(true);
  });

  it("works on the ratios a real title produces (9/20 -> 15/20, 17 tokens: 8/17 -> 13/17)", () => {
    expect(agreementSwitches(9 / 20, 15 / 20)).toBe(true);
    expect(agreementSwitches(8 / 17, 13 / 17)).toBe(false); // 0.7647 - 0.4706 = 0.294
    expect(agreementSwitches(8 / 17, 14 / 17)).toBe(true);
  });

  it("a seed with no score (null) or a candidate with none is never replaced", () => {
    expect(agreementSwitches(null, 1)).toBe(false);
    expect(agreementSwitches(0.1, null)).toBe(false);
    expect(agreementSwitches(null, null)).toBe(false);
  });
});

describe("summaryDefect", () => {
  const CLEAN =
    "Abdul El Sayed, Michigan'da Senato seçimini kazanarak ABD Senatosu'na seçilen ilk Müslüman oldu.";

  it("a clean sentence has no defect", () => {
    expect(summaryDefect(CLEAN, CLEAN)).toBeNull();
    expect(summaryDefect("", "")).toBeNull();
  });

  describe("stub: a feed-cut text", () => {
    it.each([
      ["three dots", "Sanatçı Canan Tolon'un eserlerinin gümrükte kırılmasıyla ilgili açıkl..."],
      ["an ellipsis character", "Michigan'da Senato seçimini kazanan Abdul El Sayed'in zaferi memnuniyetle…"],
      ["three dots and a closing quote", 'Bakan "olayı yakından takip ediyoruz" dedi ve açıklamasına devam e..."'],
      ["trailing blanks", "Cumhuriyetçileri desteklemek için yaklaşık 445 milyon dolar harcayan Elon Musk...  "],
    ])("%s", (_label, raw) => {
      expect(summaryDefect(raw, raw.trim())).toBe("stub");
    });

    it("a tidied text that ends in an ellipsis is a stub even when the raw text does not", () => {
      expect(summaryDefect(CLEAN, `${CLEAN.slice(0, -1)}…`)).toBe("stub");
    });

    it("an ellipsis in the middle of a text is not a stub", () => {
      const mid = "Bakan açıklamasında ... diye konuştu ve ardından yeni kararları duyurdu.";
      expect(summaryDefect(mid, mid)).toBeNull();
    });
  });

  describe("teaser: a question or a come-on", () => {
    it.each([
      ["a closing question", "Michigan'da ipi göğüsleyerek ilk Müslüman senatör olmayı başaran Abdul El-Sayed kimdir?"],
      ["a question in the middle", "Abdul El Sayed seçimi kazandı. Peki, Abdul El Sayed kimdir? Kaç yaşında, nereli?"],
      ["a quoted question", 'Sanatçı "Bu eserleri kim kırdı?" diye sordu ve gümrük kapısında bekledi.'],
      ["a sentence that opens with Peki", "Abdul El Sayed seçimi kazandı. Peki seçim sonrası neler oldu ve nasıl yorumlandı"],
      ["a sentence that opens with İşte", "Abdul El Sayed Senato'ya seçildi. İşte seçim sürecinde yaşananlar ve hayat hikayesi."],
      ["a text that opens with İŞTE", "İŞTE Michigan'daki seçimin ardından yaşanan tüm gelişmeler ve sonuçlar hakkında bilgiler"],
    ])("%s", (_label, text) => {
      expect(summaryDefect(text, text)).toBe("teaser");
    });

    it("'işte' and 'peki' inside a sentence are ordinary words", () => {
      const text = "Bakan, işte bu nedenle kararı geri çekti; peki denildiğinde ise sessiz kaldı ve toplantıyı terk etti.";
      expect(summaryDefect(text, text)).toBeNull();
    });
  });

  describe("dateline: an agency or place lead", () => {
    it.each([
      ["Medyascope", "İSTANBUL (Medyascope) – Selahattin Demirtaş'ın Diyarbakır'da yargılandığı davanın birleştirilmesine karar verildi."],
      ["AA", "ANKARA (AA) - Cumhurbaşkanı Erdoğan, Güney Kore ziyaretini tamamlayarak yurda döndü ve açıklama yaptı."],
      ["DHA after a place and a comma", "GÜNEY KORE, (DHA) - CUMHURBAŞKANI Recep Tayyip Erdoğan'ın eşi Emine Erdoğan açılışı yaptı."],
      ["a byline before the agency", "Melih Kiram GEDİK, (DHA) - ESKİ ABD Başkanı Barack Obama, Kongre ara seçimlerinin ardından konuştu."],
      ["a place and a date", "Ankara, 4 Kasım (AA) - Dışişleri Bakanlığı, Avrupa Komisyonu raporuna sert tepki gösterdi ve açıkladı."],
      ["an all-caps desk with a dash", "HABER MERKEZİ - Dışişleri Bakanlığı'nın açıklaması şöyle: Avrupa Komisyonu raporu mesnetsiz."],
      ["an all-caps desk with a tight dash", "HABER MERKEZİ- Bakanlık sosyal medya hesabından yaptığı açıklamada konuştu ve duyurdu."],
      ["an en dash after a city", "ANKARA – Demokrat Parti'nin Michigan adayı Abdul el-Sayed seçimleri kazanarak Senato'ya seçildi."],
    ])("%s", (_label, text) => {
      expect(summaryDefect(text, text)).toBe("dateline");
    });

    it.each([
      ["a party in capitals", 'YENİ Parti Grup Başkanvekili Ali Mahir Başarır, "görevimden affımı istedim" dedi ve konuştu.'],
      ["an acronym with a hyphen", "ABD-İran gerilimi sürerken Dışişleri Bakanlığı yeni bir açıklama yaptı ve tepki gösterdi."],
      ["a dash after lower-case words", "Bakan açıkladı - yeni karar bugün Resmi Gazete'de yayımlanarak yürürlüğe girdi ve uygulanacak."],
      ["a parenthesised age", "Mehmet Yılmaz (74) - uzun yıllardır görev yaptığı kurumdan emekli oldu ve veda konuşması yaptı."],
      ["a parenthesis with no dash", "Türk Devletleri Teşkilatı (TDT) gözlemci üyelik için başvuru koşullarını açıkladı ve duyurdu."],
    ])("is not flagged: %s", (_label, text) => {
      expect(summaryDefect(text, text)).toBeNull();
    });

    // h81-textclean-2: tidySummaryText now strips a dateline lead, so the tidied text
    // no longer carries it and the raw text is what tells a dateline-led member apart.
    describe("the lead is stripped from the shown text (h81-textclean-2)", () => {
      it.each([
        ["Medyascope", "İSTANBUL (Medyascope) – Abdul El Sayed, Michigan'daki Senato yarışını kazanarak ABD'de Senato'ya seçilen ilk Müslüman oldu."],
        ["AA", "ANKARA (AA) - Cumhurbaşkanı Erdoğan, Güney Kore ziyaretini tamamlayarak yurda döndü ve açıklama yaptı."],
        ["a desk", "HABER MERKEZİ- Milli Savunma Bakanlığı, askerlik görevini yerine getirecek yükümlülerin sınıflandırma sonuçlarını açıkladı."],
        ["a two-word place", "BİRLEŞMİŞ MİLLETLER (BM) - Türkiye'nin BM Daimi Temsilcisi, Gazze'deki insani durumun kötüleştiğini söyledi."],
        ["a place and a date", "Ankara, 4 Kasım (AA) - Dışişleri Bakanlığı, Avrupa Komisyonu raporuna sert tepki gösterdi ve açıkladı."],
      ])("%s: the tidied text is clean but the raw lead still makes it a dateline", (_label, raw) => {
        const shown = tidySummaryText(raw);
        expect(shown.length).toBeLessThan(raw.length);
        expect(raw.endsWith(shown)).toBe(true);
        expect(summaryDefect(shown, shown)).toBeNull();
        expect(summaryDefect(raw, shown)).toBe("dateline");
      });

      it("the raw text is trimmed before the lead is looked for", () => {
        const raw = "İSTANBUL (Medyascope) – Abdul El Sayed, Michigan'daki Senato yarışını kazanarak ABD'de Senato'ya seçilen ilk Müslüman oldu.";
        expect(summaryDefect(`  \n${raw}  `, tidySummaryText(raw))).toBe("dateline");
      });

      it("a lead the tidy step would NOT strip (a short remainder) is still a dateline by the detector", () => {
        const raw = "HABER MERKEZİ - kısa bir metin";
        expect(tidySummaryText(raw)).toBe(raw);
        expect(summaryDefect(raw, tidySummaryText(raw))).toBe("dateline");
      });

      it("a raw text with no lead stays clean once tidied", () => {
        const raw = "Dışişleri Bakanlığı, Avrupa Komisyonu raporuna sert tepki gösterdi ve resmi bir açıklama yaptı.";
        expect(summaryDefect(raw, tidySummaryText(raw))).toBeNull();
      });

      it("a stub, a teaser and a run-on still win or lose in the documented order", () => {
        const stub = "ANKARA (AA) - Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu ve tarihe geç...";
        expect(summaryDefect(stub, tidySummaryText(stub))).toBe("stub");
        const teaser = "ANKARA (AA) - Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu, kimdir?";
        expect(summaryDefect(teaser, tidySummaryText(teaser))).toBe("teaser");
      });
    });
  });

  describe("run-on: the opening repeated inside the text", () => {
    const OPENING =
      "Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae-myung'un daveti üzerine gerçekleştirdiği resmi ziyaret kapsamındaki temaslarını tamamlayarak Seul'den ayrıldı";

    it("a headline glued onto its body", () => {
      const text = `${OPENING} Cumhurbaşkanı Recep Tayyip Erdoğan, Güney Kore Devlet Başkanı Lee Jae-myung'un daveti üzerine 8 yıl aradan sonra geldiği Seul'de temaslarını tamamladı.`;
      expect(summaryDefect(text, text)).toBe("run-on");
    });

    it("the same opening after a full stop is a run-on too", () => {
      const text = "Abdul El Sayed Michigan'da Senato seçimini kazandı. Abdul El Sayed Michigan'da Senato seçimini kazandı ve tarihe geçti.";
      expect(summaryDefect(text, text)).toBe("run-on");
    });

    it("a subject that recurs with a different continuation is not a run-on", () => {
      const text =
        "ABD Başkanı Donald Trump, ara seçim yenilgisini İran savaşına bağladı. ABD Başkanı Donald Trump ayrıca hayat pahalılığına dikkat çekti.";
      expect(summaryDefect(text, text)).toBeNull();
    });

    it("a text shorter than twice the opening cannot be a run-on", () => {
      const text = "Abdul El Sayed Michigan'da Senato seçimini kazandı";
      expect(summaryDefect(text, text)).toBeNull();
    });
  });

  it("reports the first defect in a fixed order: stub, teaser, dateline, run-on", () => {
    const both = "ANKARA (AA) - Abdul El Sayed kimdir?...";
    expect(summaryDefect(both, both)).toBe("stub");
    const two = "ANKARA (AA) - Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu, kimdir?";
    expect(summaryDefect(two, two)).toBe("teaser");
  });

  it("never throws on odd input", () => {
    expect(summaryDefect(undefined as unknown as string, undefined as unknown as string)).toBeNull();
    expect(summaryDefect("🎉".repeat(200), "🎉".repeat(200))).toBeNull();
    expect(summaryDefect("(".repeat(500), "(".repeat(500))).toBeNull();
    expect(summaryDefect("-".repeat(5000), "-".repeat(5000))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// h34-reader-4: the gate also looks at the seed's own form. A feed-cut stub or a
// summary with unbalanced quotes counts as disagreeing even when it covers the
// headline's words, and then the gain over the seed is waived.
// ---------------------------------------------------------------------------

describe("agreementSwitches with a malformed seed (h34-reader-4)", () => {
  it("waives the seed ceiling and the gain: only the candidate's 0.75 is left", () => {
    expect(agreementSwitches(0.5, 0.75, true)).toBe(true);
    expect(agreementSwitches(0.8, 0.75, true)).toBe(true);
    expect(agreementSwitches(1, 0.75, true)).toBe(true);
    expect(agreementSwitches(0.2, 0.9, true)).toBe(true);
  });

  it("HIGH is still inclusive and still needed", () => {
    expect(agreementSwitches(0.8, 0.7499, true)).toBe(false);
    expect(agreementSwitches(0.2, 0.5, true)).toBe(false);
    expect(agreementSwitches(0, 0.74, true)).toBe(false);
  });

  it("a null score on either side never switches, malformed or not", () => {
    expect(agreementSwitches(null, 1, true)).toBe(false);
    expect(agreementSwitches(0.8, null, true)).toBe(false);
    expect(agreementSwitches(null, null, true)).toBe(false);
  });

  it("the third argument defaults to false: the three-way gate is what it was", () => {
    expect(agreementSwitches(0.5, 1)).toBe(false);
    expect(agreementSwitches(0.5, 1, false)).toBe(false);
    expect(agreementSwitches(0.46, 0.75, false)).toBe(false);
    expect(agreementSwitches(0.45, 0.75)).toBe(true);
  });
});

describe("hasFiniteVerb (a Turkish finite-verb form, lexically; a miss only keeps a seed)", () => {
  it.each([
    ["simple past", "Bakan açıklama yaptı"],
    ["simple past after a vowel stem", "Başkan konuşmasında bunu dedi"],
    ["past with a voiceless stem", "Erdoğan Seul'den ayrıldı ve yurda geldi"],
    ["past, plural person", "Bakanlar toplantıdan sonra gazetecilere konuştular"],
    ["past, first person plural", "Biz bu yolu birlikte yürüdük"],
    ["reported past with a copula", "Karar oy birliğiyle benimsenmiştir"],
    ["reported past", "Sanık ifadesini değiştirmiş"],
    ["progressive", "Fiyatlar yükseliyor"],
    ["progressive, first person plural", "Bu hedefi gerçekleştirmek için çalışıyoruz"],
    ["future", "Bakan yarın açıklama yapacak"],
    ["future, first person plural", "Süreci birlikte yöneteceğiz"],
    ["necessity", "Dokunulmazlıklar süratle kaldırılmalı"],
    ["possibility", "Kararın sonuçları ağır olabilir"],
    ["copula", "Türkiye güçlü bir ülkedir"],
    ["existential", "Saldırılara karşı taviz yok"],
    ["upper case and dotted İ", "ERDOĞAN GÜNEY KORE'DEN AYRILDI"],
  ])("%s", (_label, text) => {
    expect(hasFiniteVerb(text)).toBe(true);
  });

  it.each([
    ["a noun phrase", "Mücteba Hamaney, ABD ara seçim sonuçlarının Washington'ın İran'a yönelik düşmanca yaklaşımını"],
    ["a converb (-ken)", "CHP Genel Başkanı Kılıçdaroğlu, fon vurgunu üzerinden konuşurken"],
    ["a converb (-erek)", "Hamaney, siyasette arınma ve aklanmanın ertelenemez bir gereklilik olduğunu belirterek"],
    ["a participle (-dığı)", "Bakan Yılmaz'ın dün yaptığı açıklama"],
    ["'toplantı' (n + tı is not a past tense)", "Bakanlar kurulu toplantı"],
    ["a possessive noun in -eti (e + ti is not a past tense)", "Cumhuriyet hükümeti ve devleti"],
    ["'kadın' (a + dın)", "Kadın"],
    ["'Suudi' and 'kedi' end like a past tense and are nouns", "Suudi Arabistan ve Hindi kedi"],
    ["adjectives in -maz/-mez (not read as a verb)", "Kaçınılmaz ve ertelenemez bir gereklilik"],
    ["a name", "Özgür Özel"],
    ["a teaser fragment", "İşte ABD'deki ara seçimlere dair son dakika gelişmeler"],
    ["empty", ""],
    ["only punctuation", "…"],
  ])("none in %s", (_label, text) => {
    expect(hasFiniteVerb(text)).toBe(false);
  });

  it("folds case and diacritics like the rest of the module", () => {
    expect(hasFiniteVerb("ACIKLADI")).toBe(true);
    expect(hasFiniteVerb("açıkladı")).toBe(true);
    expect(hasFiniteVerb("AÇIKLADI")).toBe(true);
  });

  it("an apostrophe suffix is not a word of its own", () => {
    expect(hasFiniteVerb("Washington'dı")).toBe(false);
  });

  it("never throws on a non-string and is linear on a long text", () => {
    expect(hasFiniteVerb(undefined as unknown as string)).toBe(false);
    expect(hasFiniteVerb(null as unknown as string)).toBe(false);
    const long = Array.from({ length: 20_000 }, (_, i) => `kelime${i}`).join(" ");
    const start = Date.now();
    expect(hasFiniteVerb(long)).toBe(false);
    expect(hasFiniteVerb(`${long} yaptı`)).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("seedDisqualified (h34-reader-4)", () => {
  // 78e56dca (Sözcü, 123 characters): the feed cut the sentence inside "değiştirmeyecek".
  const HAMANEY_RAW =
    "İran Dini Lideri Mücteba Hamaney, ABD ara seçim sonuçlarının Washington'ın İran'a yönelik düşmanca yaklaşımını değiştirm...";
  const HAMANEY_SHOWN =
    "İran Dini Lideri Mücteba Hamaney, ABD ara seçim sonuçlarının Washington'ın İran'a yönelik düşmanca yaklaşımını…";
  // b6fe7960 (Serbestiyet): three openers and one closer.
  const VANCE_RAW =
    "ABD Başkan Yardımcısı JD Vance: “Seçimi kaybetmemizin nedeni savaş. Başkan dün gece bunu bizzat söyledi” “Vance 2024’te Trump’a oy verip bu kez Demokratlara yönelen seçmenlerin taleplerini de sıraladı: “Savaşı bitirin. Hayat pahalılığına ve enflasyona odaklanın. Amerika’yı önceleyin. İsrail’le ilişkimizi değiştirin.\nJD Vance bayrak açtı: Seçimi kaybetmemizin nedeni savaş yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
  const VANCE_SHOWN =
    "ABD Başkan Yardımcısı JD Vance: “Seçimi kaybetmemizin nedeni savaş. Başkan dün gece bunu bizzat söyledi” “Vance 2024’te Trump’a oy verip bu kez Demokratlara yönelen seçmenlerin taleplerini de sıraladı: “Savaşı bitirin. Hayat pahalılığına ve enflasyona odaklanın. Amerika’yı önceleyin. İsrail’le ilişkimizi değiştirin.";
  const CLEAN =
    "Abdul El Sayed, Michigan'da Senato seçimini kazanarak ABD Senatosu'na seçilen ilk Müslüman oldu.";

  it("the fixtures are what the cases below assume", () => {
    expect(HAMANEY_RAW).toHaveLength(123);
    expect(tidySummaryText(HAMANEY_RAW)).toBe(HAMANEY_SHOWN);
    expect(tidySummaryText(VANCE_RAW)).toBe(VANCE_SHOWN);
    expect(summaryDefect(CLEAN, CLEAN)).toBeNull();
  });

  it("a clean sentence is not disqualified", () => {
    expect(seedDisqualified(CLEAN, CLEAN)).toBeNull();
    expect(seedDisqualified("", "")).toBeNull();
  });

  describe("stub: the text ends in a cut and its last sentence has no finite verb", () => {
    it("78e56dca: a Sözcü cut, shown as 'yaklaşımını…'", () => {
      expect(seedDisqualified(HAMANEY_RAW, HAMANEY_SHOWN)).toBe("stub");
    });

    it.each([
      [
        "a converb in front of the cut (7b465c54)",
        'CHP Genel Başkanı Kılıçdaroğlu, fon vurgunu üzerinden konuşurken, "Dolandırıcı siyasetçilerin dokunulmazlıklarının sürat...',
        "CHP Genel Başkanı Kılıçdaroğlu, fon vurgunu üzerinden konuşurken…",
      ],
      [
        "a clause with no verb yet (8bfb01b7)",
        "Ticaret Bakanlığı Basın ve Halkla İlişkiler Müşaviri Bekir Kaplan, sanatçı Canan Tolon ile görüşüp üzüntüsünü ilettiğini belirterek, eserlerinin gümrükte kırılmasıyla ilgili açıkl...",
        "Ticaret Bakanlığı Basın ve Halkla İlişkiler Müşaviri Bekir Kaplan, sanatçı Canan Tolon ile görüşüp üzüntüsünü ilettiğini belirterek, eserlerinin gümrükte kırılmasıyla ilgili…",
      ],
      [
        "an earlier sentence has a verb, the last one is a name (8967f60c)",
        "Emir Sarıgül'ün, Ekrem İmamoğlu ile avukat görüş alanında sözlü atışma yaşadığı öne sürüldü. Yeni Parti lideri Özgür Özel...Devamı için tıklayınız",
        "Emir Sarıgül'ün, Ekrem İmamoğlu ile avukat görüş alanında sözlü atışma yaşadığı öne sürüldü. Yeni Parti lideri Özgür Özel...",
      ],
      [
        "the outlet's own come-on (9731962b)",
        "Oy sayımı sürerken harita mavi mi kırmızı mı olacak? İşte ABD'deki ara seçimlere dair son dakika gelişmeler…",
        "Oy sayımı sürerken harita mavi mi kırmızı mı olacak? İşte ABD'deki ara seçimlere dair son dakika gelişmeler…",
      ],
      [
        "a blank in front of the three dots (2291840c)",
        "CHP’den istifa ederek Yeni Parti’ye katılan iki meclis üyesinin ayrı oturma düzeni talebi, Silivri Belediye Meclisi’nin ...",
        "CHP’den istifa ederek Yeni Parti’ye katılan iki meclis üyesinin ayrı oturma düzeni talebi, Silivri Belediye Meclisi’nin ...",
      ],
      [
        "the cut is followed by a closing quote",
        "Bakan, “bu konuda atılan hiçbir adımın hesabı...”",
        "Bakan, “bu konuda atılan hiçbir adımın hesabı...”",
      ],
    ])("%s", (_label, raw, shown) => {
      expect(seedDisqualified(raw, shown)).toBe("stub");
    });

    it("an ellipsis in the middle of a text is not a cut", () => {
      const mid = "Bakan açıklamasında ... diye konuştu ve ardından yeni kararları duyurdu.";
      expect(seedDisqualified(mid, mid)).toBeNull();
    });
  });

  describe("not a stub: the cut sentence still has its verb", () => {
    it.each([
      [
        "8a567fa5: a clause with 'benimsenmiştir' in front of the ellipsis",
        '"Bununla ilgili geçtiğimiz sene TDT Plus işbirliği modeli benimsenmiştir"…',
      ],
      ["b6c356e3: 'hedefliyoruz'", '"Kazanımları vatandaşlarımızın alım gücüne yansıtmayı hedefliyoruz"…'],
      ["60765023: 'kazandı' ends the last sentence", "Sağlıkta Dönüşüm Programı ve AB uyum yasalarıyla ivme kazandı…"],
      ["three dots after a complete sentence", "Fon soruşturması genişliyor, yeni isimler ifade verecek..."],
    ])("%s", (_label, shown) => {
      expect(seedDisqualified(shown, shown)).toBeNull();
    });

    it("only the LAST sentence counts: a verb two sentences back does not help", () => {
      const shown = "Bakan dün açıklama yaptı. Ardından gazetecilerin sorularını yanıtladı. Muhalefet lideri ise toplantıya katılan isimlerin…";
      expect(seedDisqualified(shown, shown)).toBe("stub");
    });

    it("an abbreviation, an initial or an ordinal does not end the sentence", () => {
      // The verb is in front of the dot; nothing behind it has one.
      const abbreviation = "Anayasa Mahkemesi kararını verdi ve Prof. Dr. Ahmet Yılmaz'ın disiplin cezasıyla ilgili gerekçeli…";
      const initial = "Anayasa Mahkemesi kararını verdi ve M. Kemal Yılmaz'ın disiplin cezasıyla ilgili gerekçeli…";
      const ordinal = "Anayasa Mahkemesi dosyayı gönderdi ve Mersin 14. Asliye Ceza Mahkemesi'nin görevsizlik gerekçesiyle ilgili…";
      for (const shown of [abbreviation, initial, ordinal]) expect(seedDisqualified(shown, shown), shown).toBeNull();
      // A real sentence end in the same place does end it.
      const real = "Anayasa Mahkemesi kararını verdi. Ahmet Yılmaz'ın disiplin cezasıyla ilgili gerekçeli…";
      expect(seedDisqualified(real, real)).toBe("stub");
    });
  });

  describe("a text the tidy step repaired is judged by what it shows", () => {
    it("the 500-character ingest clamp, cut back to a sentence end, is not a stub", () => {
      const one = "Cumhurbaşkanı Erdoğan, Güney Kore ziyaretini tamamlayarak yurda döndü.";
      const two =
        "Havalimanında resmi törenle karşılanan Erdoğan, burada gazetecilerin sorularını yanıtladı ve görüşmelerin ayrıntılarını paylaştı.";
      let body = "";
      for (let i = 0; body.length < 560; i++) body += `${i % 2 === 0 ? one : two} `;
      const raw = `${body.slice(0, 497)}...`;
      expect(raw).toHaveLength(500);
      const shown = tidySummaryText(raw);
      expect(shown.endsWith("…")).toBe(false);
      expect(seedDisqualified(raw, shown)).toBeNull();
    });

    it("a 500-character clamp that is cut inside its only sentence and has a verb in it is judged by the verb", () => {
      const raw = `${"Bakan açıklama yaptı ve ".repeat(25).slice(0, 497)}...`;
      expect(raw).toHaveLength(500);
      const shown = tidySummaryText(raw);
      expect(shown.endsWith("…")).toBe(true);
      expect(seedDisqualified(raw, shown)).toBeNull();
    });
  });

  describe("a known feed-cap length cut is a stub whatever the verbs", () => {
    // 123 characters: Sözcü cuts the description at 120 and adds "...".
    const BASE =
      "Bakan Yılmaz, dün Ankara'da düzenlenen toplantıda enflasyonla mücadele programını açıkladı ve ardından gazetecilerin sorularını yanıtlayarak yeni dönem adımlarını paylaşmayı sürdürdü.";

    const LONG = `${BASE.slice(0, -1)} ve bu kapsamda önümüzdeki aylarda atılacak adımların ayrıntılarını kamuoyuyla paylaşmayı planlıyor.`;

    function cutAt(length: number): { raw: string; shown: string } {
      const raw = `${BASE.slice(0, length - 3)}...`;
      return { raw, shown: tidySummaryText(raw) };
    }

    it("the fixture: a verb sits in front of the cut and the cut falls inside a word", () => {
      const { raw, shown } = cutAt(123);
      expect(raw).toHaveLength(123);
      expect(/\p{L}$/u.test(raw.slice(0, -3))).toBe(true);
      expect(shown.endsWith("…")).toBe(true);
      expect(hasFiniteVerb(shown)).toBe(true);
    });

    it.each([123, 183, 202, 203])("%i characters", (length) => {
      // One long sentence: the tidy step has no sentence end to cut back to.
      const raw = `${LONG.slice(0, length - 3)}...`;
      expect(raw).toHaveLength(length);
      expect(/\p{L}$/u.test(raw.slice(0, -3))).toBe(true);
      const shown = tidySummaryText(raw);
      expect(shown.endsWith("…")).toBe(true);
      expect(seedDisqualified(raw, shown)).toBe("stub");
    });

    it("the same cut at an ordinary length (130) keeps its verb's say: not a stub", () => {
      const { raw, shown } = cutAt(130);
      expect(raw).toHaveLength(130);
      expect(seedDisqualified(raw, shown)).toBeNull();
    });

    it("the cap counts only when the three dots follow a letter or a digit (an outlet's own ellipsis stays)", () => {
      const raw = `${BASE.slice(0, 119)} ...`;
      expect(raw).toHaveLength(123);
      expect(raw.endsWith(" ...")).toBe(true);
      const shown = tidySummaryText(raw);
      expect(shown.endsWith("...")).toBe(true);
      expect(seedDisqualified(raw, shown)).toBeNull();
    });
  });

  describe("quotes: unequal “ and ”, or an odd number of straight \"", () => {
    it("b6fe7960: three openers and one closer", () => {
      expect(seedDisqualified(VANCE_RAW, VANCE_SHOWN)).toBe("quotes");
    });

    it.each([
      ["an opener with no closer", "Hamaney “Basra Körfezi'ndeki gelişmeler ABD'nin yenilmezliği efsanesini yerle bir etti."],
      ["a closer with no opener", "Hamaney Basra Körfezi'ndeki gelişmeler ABD'nin yenilmezliği efsanesini yerle bir etti.”"],
      ["two openers and no closer", "Bayındır “Caizdir“ diyerek vakfın gerekli dersi çıkaracağını söyledi ve açıklamayı tamamladı."],
      ["two closers and no opener", "Bayındır ”Caizdir” diyerek vakfın gerekli dersi çıkaracağını söyledi ve açıklamayı tamamladı."],
      ["one straight quote (16f038d3)", 'İran dini lideri Hamaney, "Basra Körfezi ve Hürmüz Boğazı\'ndaki gelişmeler, ABD\'nin yenilmezliği efsanesini yerle bir etti.'],
      ["three straight quotes", 'Bakan "bu karar" doğru ve "gerekliydi dedi ve toplantıyı bitirdi.'],
      ["a straight quote and a curly pair that cancel out", 'Bakan “bu karar” doğru ve "gerekliydi dedi ve toplantıyı bitirdi.'],
    ])("%s", (_label, text) => {
      expect(seedDisqualified(text, text)).toBe("quotes");
    });

    it.each([
      ["a curly pair", "Bakan “bu karar doğru ve gerekliydi” dedi ve toplantıyı bitirdi."],
      ["a straight pair", 'Bakan "bu karar doğru ve gerekliydi" dedi ve toplantıyı bitirdi.'],
      ["two pairs of each style", 'Bakan “birinci” ve “ikinci” maddeyi, "üçüncü" ve "dördüncü" maddeyi anlattı ve bitirdi.'],
      ["two curly pairs", "Bakan “bu karar” dedi, ardından “şimdi sıra sizde” diyerek toplantıyı bitirdi."],
      ["apostrophes and single curly quotes are not counted", "Erdoğan’ın ‘ilk’ açıklaması Washington'ın İran'a yönelik politikasını değiştirmeyeceğini söyledi."],
      ["angle quotes are not counted", "Bakan «bu karar doğru ve gerekliydi dedi ve toplantıyı bitirdi."],
      ["no quotes at all", CLEAN],
    ])("balanced or not counted: %s", (_label, text) => {
      expect(seedDisqualified(text, text)).toBeNull();
    });

    it("is judged on the tidied text: an open quotation in a wrapper line the tidy step peels off is not counted", () => {
      const raw =
        "ABD Başkan Yardımcısı JD Vance, “Seçimi kaybetmemizin nedeni savaş” dedi.\nJD Vance “Seçimi kaybetmemizin nedeni savaş yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
      const shown = tidySummaryText(raw);
      expect(shown).toBe("ABD Başkan Yardımcısı JD Vance, “Seçimi kaybetmemizin nedeni savaş” dedi.");
      expect(seedDisqualified(raw, shown)).toBeNull();
      // The same text as it would stand if the wrapper were kept is not balanced.
      expect(seedDisqualified(raw, raw)).toBe("quotes");
    });
  });

  it("reports the first defect: stub before quotes", () => {
    const both = "Bakan “bu karar doğru ve gerekli olan konuda gazetecilerin…";
    expect(seedDisqualified(both, both)).toBe("stub");
  });

  it("never throws on odd input", () => {
    expect(seedDisqualified(undefined as unknown as string, "x")).toBeNull();
    expect(seedDisqualified("x", null as unknown as string)).toBeNull();
    expect(seedDisqualified("🎉".repeat(200), "🎉".repeat(200))).toBeNull();
    expect(seedDisqualified("…", "…")).toBe("stub");
    expect(seedDisqualified("-".repeat(5000), "-".repeat(5000))).toBeNull();
  });

  it("is linear: a 100k-word text is judged in well under a second", () => {
    // Capitalised: an all-lower-case text of 25 letters or more is a 'case' defect since h164-summaries-2.
    const text = `${Array.from({ length: 100_000 }, (_, i) => `Kelime${i}`).join(" ")} yaptı.`;
    const start = Date.now();
    expect(seedDisqualified(text, text)).toBeNull();
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// h54-editorial-1: a headline that reports a LATER stage of the story than the
// seed's summary. b34a5fe0 (21 kaynak): the H1 says "tutuklandı", the Özet says
// "tutuklama talebiyle mahkemeye sevk edildi". The word-stem overlap folds
// "tutuklama" and "tutuklandı" to "tutuk" and scores the seed 6/7, so the
// agreement gate kept it.
// ---------------------------------------------------------------------------
describe("stageBehindTitle (h54-editorial-1: the text reports an earlier stage than the headline)", () => {
  const TITLE = "Fon soruşturmasında Fatma Betül Sayan Kaya tutuklandı";
  // The GZT seed of b34a5fe0, verbatim (the typo "Beyül" is the feed's).
  const GZT_SEED =
    "İstanbul Cumhuriyet Başsavcılığı tarafından yürütülen fon soruşturması kapsamında; Fatma Beyül Sayan Kaya tutuklama talebiyle mahkemeye sevk edildi Eski SPK Başkanı İbrahim Ömer Gönül ve İlyas Kaya adli kontrolle mahkemeye sevk edildi.";
  const MEDYASCOPE_LEAD =
    "Fon krizi soruşturması kapsamında yeniden ifade veren eski bakan Fatma Betül Sayan Kaya, tutuklanarak cezaevine gönderildi.";

  it("b34a5fe0: 'tutuklandı' over 'tutuklama talebiyle ... sevk edildi' is a stage behind", () => {
    expect(stageBehindTitle(TITLE, GZT_SEED)).toBe(true);
    // The stem overlap alone cannot see it: the seed covers 6 of the 7 title stems.
    expect(titleAgreement(TITLE, GZT_SEED)!).toBeGreaterThanOrEqual(AGREEMENT_LOW);
  });

  it("is false for a text that reports the outcome", () => {
    expect(stageBehindTitle(TITLE, MEDYASCOPE_LEAD)).toBe(false);
    expect(stageBehindTitle(TITLE, "Fatma Betül Sayan Kaya fon soruşturmasında tutuklandı. İlyas Kaya serbest bırakıldı.")).toBe(false);
  });

  it("is false when the text has both the request and the outcome", () => {
    expect(
      stageBehindTitle(TITLE, "Kaya tutuklama talebiyle hakimliğe sevk edildi, hakimlik Kaya'nın tutuklandı kararını verdi."),
    ).toBe(false);
    // 'hakimliğe sevk edilen ... tutuklandı': the dispatch is history, the outcome is stated.
    expect(
      stageBehindTitle(TITLE, "Fon soruşturması kapsamında hakimliğe sevk edilen eski bakan Fatma Betül Sayan Kaya tutuklandı."),
    ).toBe(false);
  });

  it("is false when the title itself is at the earlier stage", () => {
    const requestTitle = "tutuklama istemiyle hakimliğe sevk edildi";
    expect(stageBehindTitle(requestTitle, GZT_SEED)).toBe(false);
    expect(stageBehindTitle("Fatma Betül Sayan Kaya tutuklama talebiyle sevk edildi", GZT_SEED)).toBe(false);
    expect(stageBehindTitle("Fatma Betül Sayan Kaya gözaltına alındı", "Kaya tutuklama talebiyle sevk edildi")).toBe(false);
  });

  describe("arrest family", () => {
    it.each([
      ["tutuklama talebi", "Kaya tutuklama talebiyle hakimliğe sevk edildi."],
      ["tutuklama istemi", "Savcılık Kaya hakkında tutuklama istemiyle hakimliğe başvurdu."],
      ["tutuklanması talebi", "Kaya'nın tutuklanması talebiyle hakimliğe sevk edildi."],
      ["tutuklanması istemi", "Kaya'nın tutuklanması istemiyle hakimliğe sevk edildi."],
      ["sevk edildi", "Kaya adliyeye sevk edildi."],
      ["gözaltına alındı", "Kaya sabah saatlerinde gözaltına alındı."],
    ])("%s is an earlier stage than 'tutuklandı'", (_label, text) => {
      expect(stageBehindTitle("Fatma Betül Sayan Kaya tutuklandı", text)).toBe(true);
    });

    it.each([
      "Fatma Betül Sayan Kaya tutuklandı",
      "Kaya tutuklanarak cezaevine gönderildi",
      "Tutuklanan eski bakan Kaya cezaevine girdi",
      "Kaya hakkında tutuklanmasına karar verildi",
    ])("%j is an outcome", (title) => {
      expect(stageBehindTitle(title, "Kaya gözaltına alındı.")).toBe(true);
    });

    it("the request noun 'tutuklanması talebi' is not an outcome (it holds the stem 'tutuklan')", () => {
      expect(stageBehindTitle("Kaya tutuklandı", "Kaya'nın tutuklanması talebiyle hakimliğe sevk edildi.")).toBe(true);
      expect(stageBehindTitle("Kaya tutuklandı", "Kaya'nın tutuklanması istemiyle hakimliğe sevk edildi, hakim tutuklanmasına karar verdi.")).toBe(false);
    });

    // correctness-1: a request is not an arrest. "tutuklanması talep edilen",
    // "tutuklanmasını istedi" and "tutuklanması istendi" hold the stem "tutuklan"
    // but report the request, so they are an earlier stage and never an outcome.
    it.each([
      "Kaya'nın tutuklanması talep edildi.",
      "tutuklanması talep edilen Kaya hakimliğe sevk edildi.",
      "Savcı Kaya'nın tutuklanmasını istedi.",
      "Kaya'nın tutuklanması istendi.",
    ])("the request form %j is not an outcome but an earlier stage", (text) => {
      expect(carriesOutcome("Kaya tutuklandı", text)).toBe(false);
      expect(stageBehindTitle("Kaya tutuklandı", text)).toBe(true);
    });

    it("a negation is not an arrest outcome: 'tutuklanmadı' does not carry 'tutuklandı'", () => {
      expect(carriesOutcome("Kaya tutuklandı", "Kaya tutuklanmadı.")).toBe(false);
      expect(carriesOutcome("Kaya tutuklandı", "Kaya hakkında tutuklanmayan kişi sayısı arttı.")).toBe(false);
    });

    it("a headline that negates the arrest states no outcome, so nothing is behind it", () => {
      expect(stageBehindTitle("X tutuklanmadı", "X gözaltına alındı ve adliyeye sevk edildi")).toBe(false);
      expect(stageBehindTitle("Kaya tutuklanması talep edilerek hakimliğe sevk edildi", GZT_SEED)).toBe(false);
    });

    it("the arrest outcomes stay outcomes: 'tutuklanmasına karar verildi', 'tutuklanarak', 'tutuklanan'", () => {
      expect(carriesOutcome("Kaya tutuklandı", "Hakimlik Kaya'nın tutuklanmasına karar verdi.")).toBe(true);
      expect(carriesOutcome("Kaya tutuklandı", "Kaya tutuklanarak cezaevine gönderildi.")).toBe(true);
      expect(carriesOutcome("Kaya tutuklandı", "Tutuklanan Kaya cezaevine girdi.")).toBe(true);
      expect(stageBehindTitle("Kaya tutuklandı", "Kaya'nın tutuklanmasına karar verildi, daha önce adliyeye sevk edilmişti.")).toBe(false);
    });

    it("is false when the title is not an arrest outcome", () => {
      expect(stageBehindTitle("Fon soruşturmasında yeni gelişme", GZT_SEED)).toBe(false);
      expect(stageBehindTitle("Fatma Betül Sayan Kaya'ya tutuklama talebi", GZT_SEED)).toBe(false);
    });
  });

  describe("release family", () => {
    it("a release over a release request is a stage behind", () => {
      expect(
        stageBehindTitle(
          "İlyas Kaya adli kontrol şartıyla serbest bırakıldı",
          "İlyas Kaya hakkında tahliye talebi hakimliğe iletildi, karar bekleniyor.",
        ),
      ).toBe(true);
      expect(stageBehindTitle("Sanık tahliye edildi", "Sanığın avukatı tahliye istemiyle başvurdu.")).toBe(true);
      expect(stageBehindTitle("Mahkeme tahliyesine karar verdi", "Sanığın tahliye talebi incelendi.")).toBe(true);
    });

    // correctness-1: "tahliye edilmedi" and "serbest bırakılmadı" hold the release
    // words but report that it did not happen.
    it("a negation is not a release outcome", () => {
      expect(carriesOutcome("Sanık tahliye edildi", "Sanık tahliye edilmedi.")).toBe(false);
      expect(carriesOutcome("Sanık serbest bırakıldı", "Sanık serbest bırakılmadı.")).toBe(false);
      expect(carriesOutcome("Sanık serbest bırakıldı", "Serbest bırakılmayan sanık sayısı arttı.")).toBe(false);
      expect(stageBehindTitle("Sanık tahliye edilmedi", "Sanığın avukatı tahliye talebiyle başvurdu.")).toBe(false);
    });

    it("a release request is not a release outcome but an earlier stage", () => {
      for (const text of [
        "Sanığın tahliye edilmesi talep edildi.",
        "Avukat sanığın tahliye edilmesini istedi.",
        "Sanığın serbest bırakılması talep edildi.",
        "Savcı sanığın serbest bırakılmasını istedi.",
      ]) {
        expect(carriesOutcome("Sanık tahliye edildi", text), text).toBe(false);
        expect(stageBehindTitle("Sanık tahliye edildi", text), text).toBe(true);
      }
    });

    it("the release outcomes stay outcomes: 'serbest bırakılmasına karar verildi', 'tahliye edilmesine karar'", () => {
      expect(carriesOutcome("Sanık serbest bırakıldı", "Mahkeme sanığın serbest bırakılmasına karar verdi.")).toBe(true);
      expect(carriesOutcome("Sanık tahliye edildi", "Mahkeme sanığın tahliye edilmesine karar verdi.")).toBe(true);
      expect(carriesOutcome("Sanık tahliye edildi", "Sanık tahliye edilerek cezaevinden çıktı.")).toBe(true);
    });

    it("is false when the text states the release too, or has no request", () => {
      expect(
        stageBehindTitle(
          "İlyas Kaya adli kontrol şartıyla serbest bırakıldı",
          "İlyas Kaya'nın tahliye talebi kabul edildi, Kaya serbest bırakıldı.",
        ),
      ).toBe(false);
      expect(stageBehindTitle("İlyas Kaya serbest bırakıldı", "İlyas Kaya adli kontrol talep edildi.")).toBe(false);
    });
  });

  describe("death family", () => {
    it("'hayatını kaybetti' over 'ağır yaralandı' is a stage behind", () => {
      expect(stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "Ahmet Yılmaz ağır yaralandı.")).toBe(true);
      expect(stageBehindTitle("Ahmet Yılmaz yaşamını yitirdi", "Ahmet Yılmaz hastaneye kaldırıldı.")).toBe(true);
      expect(stageBehindTitle("Ahmet Yılmaz öldü", "Ahmet Yılmaz yoğun bakımda tedavi ediliyor.")).toBe(true);
      expect(stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "Ahmet Yılmaz ağır yaralı olarak kurtarıldı.")).toBe(true);
    });

    it("is false when the text states the death too", () => {
      expect(stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "2 kişi öldü, 5 kişi yaralandı")).toBe(false);
      expect(stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "Ahmet Yılmaz'ın hayatını kaybettiği kazada 3 kişi yaralandı.")).toBe(false);
      expect(stageBehindTitle("Ahmet Yılmaz öldü", "Yılmaz yaşamını yitirdi, eşi yoğun bakımda.")).toBe(false);
    });

    // correctness-3: the headline's death words are not all spelled "hayatını
    // kaybetti"; a text that says the same death another way is not a stage behind.
    it.each([
      "Kazada 3 kişi yaşamını kaybetti, 2 kişi yaralandı.",
      "Kazada 3 kişi hayatını yitirdi, 2 kişi yaralandı.",
      "Kazada 3 kişi öldürüldü, 2 kişi yaralandı.",
      "Kazada 3 kişi can verdi, 2 kişi yaralandı.",
      "Saldırıda 3 asker şehit oldu, 2 asker yaralandı.",
      "Saldırıda 3 asker şehit düştü, 2 asker yaralandı.",
    ])("a seed that states the death as %j is not a stage behind", (text) => {
      expect(stageBehindTitle("Kazada 3 kişi hayatını kaybetti", text)).toBe(false);
      expect(carriesOutcome("Kazada 3 kişi hayatını kaybetti", text)).toBe(true);
    });

    it.each([
      "Kazada 3 kişi yaşamını kaybetti",
      "Kazada 3 kişi hayatını yitirdi",
      "Kazada 3 kişi öldürüldü",
      "Kazada 3 kişi can verdi",
      "Saldırıda 3 asker şehit oldu",
      "Saldırıda 3 asker şehit düştü",
    ])("the headline %j is a death outcome over 'yaralandı'", (title) => {
      expect(stageBehindTitle(title, "Kazada 3 kişi yaralandı.")).toBe(true);
    });

    it("'can ver' needs a letter boundary: a name ending in -can does not read as a death", () => {
      expect(
        stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "Özcan verdiği ifadede Yılmaz'ın ağır yaralandığını söyledi."),
      ).toBe(true);
      expect(
        stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "Ercan verdi, Yılmaz ağır yaralandı."),
      ).toBe(true);
      expect(carriesOutcome("Ahmet Yılmaz hayatını kaybetti", "Özcan verdiği ifadede Yılmaz'ı anlattı.")).toBe(false);
      // A headline with the same shape is not a death either.
      expect(stageBehindTitle("Özcan verdi cevabı", "Özcan ağır yaralandı.")).toBe(false);
    });

    it("'öldü' (died) is not 'oldu' (became): a headline with 'oldu' is no death", () => {
      const title = "Abdul El Sayed Senato'ya seçilen ilk Müslüman oldu";
      expect(stageBehindTitle(title, "Sayed'in seçim gecesi bir destekçisi yaralandı.")).toBe(false);
      // The same word with the dots is the outcome.
      expect(stageBehindTitle("Sayed'in kardeşi öldü", "Sayed'in kardeşi yaralandı.")).toBe(true);
      // A text that says 'oldu' did not say that he died.
      expect(stageBehindTitle("Ahmet Yılmaz öldü", "Ahmet Yılmaz ağır yaralandı, durumu iyi oldu.")).toBe(true);
      // 'öldü' only as a whole word: 'öldürdü' (killed) and 'ölümcül' are not it.
      expect(stageBehindTitle("Saldırgan iki kişiyi öldürdü", "Bir kişi yaralandı.")).toBe(false);
    });

    it("is false for an unrelated pair", () => {
      expect(stageBehindTitle("Ahmet Yılmaz hayatını kaybetti", "Yılmaz'ın ailesi açıklama yaptı.")).toBe(false);
      expect(stageBehindTitle("Ahmet Yılmaz ağır yaralandı", "Ahmet Yılmaz hastaneye kaldırıldı.")).toBe(false);
    });
  });

  describe("spelling", () => {
    it("reads upper case, dotted and dotless I, and ASCII-only spelling like the rest of the module", () => {
      expect(stageBehindTitle("FATMA BETÜL SAYAN KAYA TUTUKLANDI", "KAYA TUTUKLAMA TALEBİYLE HAKİMLİĞE SEVK EDİLDİ")).toBe(true);
      expect(stageBehindTitle("Kaya tutuklandi", "Kaya tutuklama talebiyle sevk edildi")).toBe(true);
      expect(stageBehindTitle("Kaya TUTUKLANMASI TALEBİYLE", "Kaya gözaltına alındı")).toBe(false);
      expect(stageBehindTitle("Ahmet hayatini kaybetti", "Ahmet agir yaralandi")).toBe(true);
      expect(stageBehindTitle("Sanık serbest birakildi", "Sanık için tahliye talebi verildi")).toBe(true);
    });

    it("reads a decomposed 'ö' and 'ü' (o and u with a combining diaeresis) like the composed letters", () => {
      const decomposed = "Yılmaz öldü".normalize("NFD");
      expect(stageBehindTitle(decomposed, "Yılmaz ağır yaralandı")).toBe(true);
    });

    it("tolerates blanks, tabs, non-breaking spaces and line breaks inside a phrase", () => {
      expect(stageBehindTitle("Kaya tutuklandı", "Kaya tutuklama  talebiyle\nhakimliğe sevk edildi")).toBe(true);
      expect(stageBehindTitle("Kaya tutuklandı", "Kaya tutuklama \t talebiyle hakimliğe başvurdu")).toBe(true);
    });
  });

  describe("never throws, always a boolean", () => {
    it.each([
      [undefined, "Kaya tutuklama talebiyle sevk edildi"],
      ["Kaya tutuklandı", undefined],
      [null, null],
      [42, {}],
      ["", ""],
      ["Kaya tutuklandı", ""],
      ["", "Kaya tutuklama talebiyle sevk edildi"],
    ])("stageBehindTitle(%j, %j)", (title, text) => {
      const out = stageBehindTitle(title as unknown as string, text as unknown as string);
      expect(out).toBe(false);
    });

    it("handles emoji, SQL characters and a lone surrogate", () => {
      expect(stageBehindTitle("Kaya tutuklandı 🎉", "'; DROP TABLE x; -- tutuklama talebiyle \ud800 sevk edildi 🎉")).toBe(true);
      expect(stageBehindTitle("🎉🎉🎉", "🎉🎉🎉")).toBe(false);
    });
  });

  it("is linear: a 500k-word text is judged in well under a second, with and without a match", () => {
    const filler = Array.from({ length: 500_000 }, (_, i) => `kelime${i}`).join(" ");
    const start = Date.now();
    expect(stageBehindTitle("Kaya tutuklandı", `${filler} tutuklama talebiyle sevk edildi`)).toBe(true);
    expect(stageBehindTitle("Kaya tutuklandı", filler)).toBe(false);
    expect(stageBehindTitle("Kaya tutuklandı", `${filler} tutuklandı`)).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("is linear on the hostile shapes of its own phrases (long runs of 'tutuklama ' and of blanks)", () => {
    const start = Date.now();
    expect(stageBehindTitle("Kaya tutuklandı", "tutuklama ".repeat(100_000))).toBe(false);
    expect(stageBehindTitle("Kaya tutuklandı", `tutuklama${" ".repeat(200_000)}x`)).toBe(false);
    expect(stageBehindTitle("Kaya tutuklandı", "tutuklanması ".repeat(100_000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(2000);
  });
});

describe("carriesOutcome (h54-editorial-1: the text states the outcome the headline reports)", () => {
  const TITLE = "Fon soruşturmasında Fatma Betül Sayan Kaya tutuklandı";

  it("is true for a text that states the outcome of the family the headline triggered", () => {
    expect(carriesOutcome(TITLE, "Kaya, tutuklanarak cezaevine gönderildi.")).toBe(true);
    expect(carriesOutcome(TITLE, "Fon soruşturmasında tutuklanan Kaya cezaevine girdi.")).toBe(true);
    expect(carriesOutcome("Ahmet Yılmaz hayatını kaybetti", "Yılmaz'ın hayatını kaybettiği kazada 3 kişi yaralandı.")).toBe(true);
    expect(carriesOutcome("Sanık serbest bırakıldı", "Mahkeme sanığın tahliyesine karar verdi.")).toBe(true);
  });

  it("is false for a text at the earlier stage, or one that says nothing of the outcome", () => {
    expect(carriesOutcome(TITLE, "Kaya tutuklama talebiyle mahkemeye sevk edildi.")).toBe(false);
    expect(carriesOutcome(TITLE, "Kaya'nın tutuklanması talebiyle hakimliğe sevk edildi.")).toBe(false);
    expect(carriesOutcome(TITLE, "Fon soruşturmasında Kaya hakkında karar bekleniyor.")).toBe(false);
    expect(carriesOutcome("Ahmet Yılmaz hayatını kaybetti", "Ahmet Yılmaz ağır yaralandı.")).toBe(false);
  });

  it("is false for a headline that triggers no family (there is no outcome to carry)", () => {
    expect(carriesOutcome("Fon soruşturmasında yeni gelişme", "Kaya tutuklandı.")).toBe(false);
    expect(carriesOutcome("Kaya'ya tutuklama talebi", "Kaya tutuklandı.")).toBe(false);
  });

  it("a text with only another family's outcome does not carry this one", () => {
    expect(carriesOutcome(TITLE, "İlyas Kaya serbest bırakıldı.")).toBe(false);
  });

  it("with a headline that triggers two families, the text must state both outcomes", () => {
    const title = "Fatma Betül Sayan Kaya tutuklandı, İlyas Kaya serbest bırakıldı";
    expect(carriesOutcome(title, "Kaya tutuklandı, eşi İlyas Kaya adli kontrolle serbest bırakıldı.")).toBe(true);
    expect(carriesOutcome(title, "Kaya tutuklandı.")).toBe(false);
    expect(carriesOutcome(title, "İlyas Kaya serbest bırakıldı.")).toBe(false);
  });

  it("never throws on odd input", () => {
    expect(carriesOutcome(undefined as unknown as string, "tutuklandı")).toBe(false);
    expect(carriesOutcome("Kaya tutuklandı", null as unknown as string)).toBe(false);
    expect(carriesOutcome("", "")).toBe(false);
    expect(carriesOutcome("Kaya tutuklandı", "")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h95-summaries-1 (hunt 95, 2026-11-09): the seed's FORM, second pass. A live-blog
// line ("X açıklamalarda bulunuyor."), a Peki / İşte teaser, an echo of the
// headline and a stub that a surname hides were all kept, and every clean
// replacement still needed 0.75.
// ---------------------------------------------------------------------------

describe("isLiveLine (h95-summaries-1)", () => {
  it.each([
    // 85ef184c (Star): a year in the event name.
    ["85ef184c, Star", "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 Resmi Açılış Töreni'nde açıklamalarda bulunuyor."],
    // b04edded (Star): a quoted event name with an ordinal, the closing quote glued to its suffix.
    [
      "b04edded, Star",
      'Cumhurbaşkanı Erdoğan, İstanbul\'da "12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni"nde konuşuyor.',
    ],
    // f1837ee1 (CNN Türk).
    [
      "f1837ee1, CNN Türk",
      "Enerji ve Tabii Kaynaklar Bakanı Alparslan Bayraktar, enerjinin yeni yol haritası programında açıklamalarda bulunuyor.",
    ],
    // 459a7b61 (Haber7).
    [
      "459a7b61, Haber7",
      "Cumhurbaşkanı Erdoğan, Azerbaycan Cumhurbaşkanı Aliyev ile yaptığı ortak toplantıda açıklamalarda bulunuyor.",
    ],
    // 772a5a49 (Yeniçağ).
    ["772a5a49, Yeniçağ", "İYİ Parti lideri Müsavat Dervişoğlu partisinin grup toplantısında konuşuyor."],
    ["abdfa19a-style: sorularını yanıtlıyor", "Cumhurbaşkanı Başdanışmanı Mehmet Uçum, Tarafsız Bölge programında Ahmet Hakan'ın sorularını yanıtlıyor."],
    ["soruları yanıtlıyor", "Bakan Yılmaz, gazetecilerin soruları yanıtlıyor."],
    ["yanıtlıyor", "Bakan Yılmaz gazetecilerin sorularını yanıtlıyor."],
    ["cevaplıyor", "Bakan Yılmaz gazetecilerin sorularını cevaplıyor."],
    ["konuşma yapıyor", "Bakan Yılmaz grup toplantısında konuşma yapıyor."],
    ["açıklama yapıyor", "Bakan Yılmaz Meclis'te açıklama yapıyor."],
    ["önemli açıklamalarda bulunuyor", "Bakan Yılmaz, Milli Enerji 2040 Lansmanı'nda önemli açıklamalarda bulunuyor."],
    ["no full stop (the feed dropped it)", "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 etkinliğinde açıklamalarda bulunuyor"],
    ["dots after the predicate (CGTN Türk, İstiklal)", "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 etkinliğinde konuşuyor..."],
    ["an abbreviation does not end the sentence", "Prof. Dr. Ali Yılmaz, kongrede konuşuyor."],
    ["upper case", "BAKAN YILMAZ KONGREDE KONUŞUYOR."],
  ])("is true for %s", (_label, text) => {
    expect(isLiveLine(text)).toBe(true);
  });

  it.each([
    ["a past tense: the event is over", "Erdoğan, TRT World Forum'da konuştu: 'İsrail'e iltimas geçiliyor' dedi."],
    ["a clause behind a semicolon, a figure in it", "Bakan X grup toplantısında konuşuyor; enflasyonun yüzde 30'a ineceğini söyledi."],
    ["the predicate is not last", "Cumhurbaşkanı Erdoğan konuşuyor ve yeni vergi paketini duyurdu."],
    ["a second sentence", "Cumhurbaşkanı Erdoğan konuşuyor. Yeni vergi paketini duyurdu."],
    ["a second clause with a finite verb in front of the predicate", "Bakan Yılmaz toplantıyı açtı ve konuşuyor."],
    ["a colon opens the substance", "Bakan Yılmaz, konuşuyor: vergi paketi geliyor."],
    ["a figure that is not a year or an ordinal", "Bakan Yılmaz, yüzde 30 oranında açıklama yapıyor."],
    ["a quotation that is not an event name", 'Bakan Yılmaz, "enflasyon düşecek" diyerek açıklamalarda bulunuyor.'],
    ["a curly quotation that is not an event name", "Bakan Yılmaz, “enflasyon düşecek” diyerek açıklamalarda bulunuyor."],
    ["longer than 160 characters", `Bakan Yılmaz, ${"çok uzun bir etkinlik adının ".repeat(6)}açıklamalarda bulunuyor.`],
    ["a stub that is cut inside the predicate", "Cumhurbaşkanı Erdoğan, TRT World Forum etkinliğinde konuşu..."],
    ["a question", "Bakan Yılmaz neden konuşuyor?"],
    ["two sentences, the first one a question", "Bakan Yılmaz kimdir? Meclis'te konuşuyor."],
    ["a plain news sentence", "Cumhurbaşkanı Erdoğan, Azerbaycan'daki temaslarının ardından yurda döndü."],
    ["'konuşuyor' as part of a longer word", "Bakan Yılmaz'ın konuşuyorlar dediği şey."],
    ["empty", ""],
    ["blank", "   "],
  ])("is false for %s", (_label, text) => {
    expect(isLiveLine(text)).toBe(false);
  });

  it("the 160-character limit is inclusive", () => {
    const tail = " açıklamalarda bulunuyor.";
    const head = "Bakan Yılmaz,";
    const filler = (n: number): string => ` ${"a".repeat(n - 1)}`;
    const at160 = head + filler(160 - head.length - tail.length) + tail;
    expect(at160).toHaveLength(160);
    expect(isLiveLine(at160)).toBe(true);
    const at161 = head + filler(161 - head.length - tail.length) + tail;
    expect(at161).toHaveLength(161);
    expect(isLiveLine(at161)).toBe(false);
  });

  it("a character whose folding changes the text's length makes the verdict 'no' rather than a guess", () => {
    // A Hangul syllable decomposes to three jamo under NFD, so the predicate's index would not line up.
    expect(isLiveLine("Bakan Yılmaz 한 konuşuyor.")).toBe(false);
  });

  it("an apostrophe in a name is not a quotation: 'D'Arcy' and a Turkish suffix are fine", () => {
    expect(isLiveLine("Bakan Yılmaz, Meclis'te konuşuyor.")).toBe(true);
    expect(isLiveLine("Bakan D'Arcy Meclis'te konuşuyor.")).toBe(true);
    expect(isLiveLine("Bakan Yılmaz, Meclis’te konuşuyor.")).toBe(true);
  });

  it("an event name in single quotes with the closing mark glued to its suffix is an event name (Türkiye Gazetesi)", () => {
    expect(
      isLiveLine("Cumhurbaşkanı Erdoğan, İstanbul'da '12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni'nde konuşuyor."),
    ).toBe(true);
    expect(
      isLiveLine("Cumhurbaşkanı Erdoğan, İstanbul’da “12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni”nde konuşuyor."),
    ).toBe(true);
  });

  it("never throws on a non-string", () => {
    expect(isLiveLine(undefined as unknown as string)).toBe(false);
    expect(isLiveLine(null as unknown as string)).toBe(false);
    expect(isLiveLine(42 as unknown as string)).toBe(false);
  });

  it("stays linear on hostile input (a long text is refused by its length before any pattern runs)", () => {
    const gens: Array<[string, Gen]> = [
      ["a long blank run", (n) => `Bakan${" ".repeat(n)}konuşuyor.`],
      ["quote openers", rep('"')],
      ["quote openers and letters", rep('"a')],
      ["dots", rep(".")],
      ["digits and dots", rep("1.")],
      // h132-ozetpost-1: the digit-bearing name rule (a capital, up to 10 letters, an optional hyphen, 1-4 digits).
      ["digit-bearing names", rep("COP31 ")],
      ["hyphenated names", rep("F-16 ")],
      ["names glued together", rep("A1B2C3")],
      ["a letter run longer than a name, then digits", rep("Aaaaaaaaaaaaaaaaaaaa1")],
      ["a digit run longer than a name", rep("A12345678")],
      ["capitals, hyphens and digits with no break", rep("A-1-")],
    ];
    for (const [label, gen] of gens) {
      expect(() => expectLinear(gen, (s) => isLiveLine(s), { n: 100_000, ceilingMs: 2_000 }), label).not.toThrow();
    }
  });
});

describe("summaryDefect: a live line is a defect for a candidate (h95-summaries-1)", () => {
  const HABER7 =
    "Cumhurbaşkanı Erdoğan, Azerbaycan Cumhurbaşkanı Aliyev ile yaptığı ortak toplantıda açıklamalarda bulunuyor.";

  it("459a7b61: Haber7's line is 'live'", () => {
    expect(summaryDefect(HABER7, HABER7)).toBe("live");
  });

  it("the same line in the past tense is a sentence, not a defect", () => {
    const done = "Cumhurbaşkanı Erdoğan, Azerbaycan Cumhurbaşkanı Aliyev ile yaptığı ortak toplantıda açıklamalarda bulundu.";
    expect(summaryDefect(done, done)).toBeNull();
  });

  it("the earlier labels keep their order: a cut, a teaser, a dateline and a run-on come first", () => {
    const cut = "Cumhurbaşkanı Erdoğan, TRT World Forum etkinliğinde konuşuyor...";
    expect(summaryDefect(cut, cut)).toBe("stub");
    const dateline = "HABER MERKEZİ - Cumhurbaşkanı Erdoğan, TRT World Forum etkinliğinde konuşuyor.";
    expect(summaryDefect(dateline, dateline)).toBe("dateline");
  });
});

describe("hasFiniteVerb ignores a capitalised word that does not open a sentence (h95-summaries-1)", () => {
  it("dd5535a7: 'Kurtulmuş' is a surname, not a reported past", () => {
    expect(
      hasFiniteVerb("Başkan Recep Tayyip Erdoğan'ın liderliğindeki Aslanlı Yol'daki kortejde, TBMM Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, Yeni Parti Genel Başkanı"),
    ).toBe(false);
  });

  it.each([
    ["a lower-case 'kurtulmuş' is the verb", "Fon sanığı cezadan kurtulmuş"],
    ["a capital at the start of the text opens a sentence", "Kurtulmuş"],
    ["a capital after a full stop opens a sentence", "Bakan Yılmaz. Açıkladı"],
    ["a capital after a colon opens a clause", "Bakan Yılmaz: Kazandık"],
    ["a capital after an opening quote opens a clause", 'Bakan "Kazandık'],
    ["an ALL-CAPS headline still has its verb", "ERDOĞAN GÜNEY KORE'DEN AYRILDI"],
    ["a lower-case verb behind capitalised names", "Numan Kurtulmuş ve Cevdet Yılmaz toplantıya katıldı"],
  ])("%s", (_label, text) => {
    expect(hasFiniteVerb(text)).toBe(true);
  });

  it.each([
    ["capitalised names only", "TBMM Başkanı Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz"],
    ["Suudi Arabistan stays a noun", "Suudi Arabistan ve Hindi kedi"],
  ])("%s", (_label, text) => {
    expect(hasFiniteVerb(text)).toBe(false);
  });
});

describe("seedDisqualified: live, teaser, echo and the surname stub (h95-summaries-1)", () => {
  // dd5535a7 (Yeni Asır, 226 characters), verbatim: the feed cut it and the CTA followed.
  const DD5_RAW =
    "Ankara'da ilk tören Anıtkabir'de yapıldı. Başkan Recep Tayyip Erdoğan'ın liderliğindeki Aslanlı Yol'daki kortejde, TBMM Numan Kurtulmuş, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, Yeni Parti Genel Başkanı...Devamı için tıklayınız";
  const LIVE = "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 Resmi Açılış Töreni'nde açıklamalarda bulunuyor.";
  const CLEAN = "Abdul El Sayed, Michigan'da Senato seçimini kazanarak ABD Senatosu'na seçilen ilk Müslüman oldu.";

  it("a live line is 'live'", () => {
    expect(seedDisqualified(LIVE, LIVE)).toBe("live");
  });

  it("a text that opens with Peki / İşte, with nothing in front to cut, is 'teaser'", () => {
    const peki = "Peki, İstanbul Barosu'nun yeni başkanı kim oldu? Seçim sonuçları belli oldu.";
    expect(seedDisqualified(peki, tidySummaryText(peki))).toBe("teaser");
    const iste = "İşte Erdoğan'ın açıklamalarından öne çıkan satır başları:";
    expect(seedDisqualified(iste, tidySummaryText(iste))).toBe("teaser");
  });

  it("a text whose come-on the tidy step cut is clean again", () => {
    const raw =
      "İstanbul Barosu başkanlık seçimlerinde adaylar arasında yer alan eski başkan Ümit Kocasakal, yeniden gündeme geldi. Peki, Ümit Kocasakal kimdir?";
    const shown = tidySummaryText(raw);
    expect(shown.endsWith("gündeme geldi.")).toBe(true);
    expect(seedDisqualified(raw, shown)).toBeNull();
  });

  describe("echo", () => {
    const TITLE = "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı";

    it("8e1a8c91: the shown text is the cluster title again", () => {
      const shown = "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.";
      expect(seedDisqualified(shown, shown, { clusterTitle: TITLE })).toBe("echo");
    });

    it("181cd879: the shown text is the member's own headline (Korkusuz ships the title as the description)", () => {
      const headline = "Erdoğan'dan fon açıklaması: Hiç ummadığınız insanlar işin içine girmişler";
      expect(seedDisqualified(headline, headline, { memberTitle: headline })).toBe("echo");
      expect(seedDisqualified(headline, headline, { memberTitle: null, clusterTitle: headline })).toBe("echo");
    });

    it("case, blanks and a trailing mark do not matter", () => {
      const shown = "tbmm genel  sekreterliğine kemal şamlıoğlu ATANDI!";
      expect(seedDisqualified(shown, shown, { clusterTitle: TITLE })).toBe("echo");
    });

    it("a description that goes on after the title is a summary, not an echo", () => {
      const shown = "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı. Atama Meclis'in resmi sitesinde yayımlandı.";
      expect(seedDisqualified(shown, shown, { clusterTitle: TITLE })).toBeNull();
    });

    it("without titles there is nothing to echo", () => {
      const shown = "TBMM Genel Sekreterliğine Kemal Şamlıoğlu atandı.";
      expect(seedDisqualified(shown, shown)).toBeNull();
      expect(seedDisqualified(shown, shown, {})).toBeNull();
      expect(seedDisqualified(shown, shown, { memberTitle: "", clusterTitle: null })).toBeNull();
    });
  });

  it("dd5535a7: the cut that 'Kurtulmuş' hid is a stub", () => {
    // Turkuvaz's "<cut>...Devamı için tıklayınız" (a CTA feed cut). h122-ozet-3: the tidy step now repairs it like a
    // clamp, with a word cut that drops the last word and one "…" (it showed "...Yeni Parti Genel Başkanı..." before).
    const shown = tidySummaryText(DD5_RAW);
    expect(isCtaFeedCut(DD5_RAW)).toBe(true);
    expect(shown.endsWith("Cevdet Yılmaz, Yeni Parti Genel…")).toBe(true);
    expect(seedDisqualified(DD5_RAW, shown)).toBe("stub");
  });

  it("a 400 or 500 character cut with no sentence end ('…' after the word cut) is a stub whatever it holds", () => {
    // A finite verb sits in the last sentence, which the old rule read as a complete one.
    const raw = `${"Bakan açıklama yaptı ve toplantı sürdü ".repeat(13).slice(0, 499)}k`;
    expect(raw).toHaveLength(500);
    const shown = tidySummaryText(raw);
    expect(shown.endsWith("…")).toBe(true);
    expect(seedDisqualified(raw, shown)).toBe("stub");
  });

  it("a live line that only trails off is a sentence with its verb, so it is 'live', not a stub", () => {
    const trailing = "Cumhurbaşkanı Erdoğan, TRT World Forum 2026 etkinliğinde konuşuyor...";
    expect(seedDisqualified(trailing, trailing)).toBe("live");
  });

  it("the earlier verdicts keep their order: unbalanced quotes come before live", () => {
    const quote = "“Cumhurbaşkanı Erdoğan konuşuyor.";
    expect(seedDisqualified(quote, quote)).toBe("quotes");
  });

  it("a clean sentence stays clean, whatever the titles say", () => {
    expect(seedDisqualified(CLEAN, CLEAN, { memberTitle: "Başka bir başlık", clusterTitle: "Michigan seçimi" })).toBeNull();
  });
});

describe("agreementSwitches takes the floor of the replacement (h95-summaries-1)", () => {
  it("AGREEMENT_FORM_DEFECT_MIN is 0.6", () => {
    expect(AGREEMENT_FORM_DEFECT_MIN).toBe(0.6);
  });

  it("the default floor is still AGREEMENT_HIGH", () => {
    expect(agreementSwitches(0.2, 0.7, true)).toBe(false);
    expect(agreementSwitches(0.2, 0.75, true)).toBe(true);
    expect(agreementSwitches(0.2, 0.7, true, AGREEMENT_HIGH)).toBe(false);
  });

  it("a lower floor lets a malformed seed be replaced by a score at or above it (inclusive)", () => {
    expect(agreementSwitches(0.2, 0.6, true, AGREEMENT_FORM_DEFECT_MIN)).toBe(true);
    expect(agreementSwitches(0.2, 0.67, true, AGREEMENT_FORM_DEFECT_MIN)).toBe(true);
    expect(agreementSwitches(0.2, 0.5999, true, AGREEMENT_FORM_DEFECT_MIN)).toBe(false);
    expect(agreementSwitches(3 / 5, 3 / 5, true, AGREEMENT_FORM_DEFECT_MIN)).toBe(true);
  });

  it("a malformed seed's own score does not matter, the floor does", () => {
    expect(agreementSwitches(0.9, 0.6, true, AGREEMENT_FORM_DEFECT_MIN)).toBe(true);
    expect(agreementSwitches(0.9, 0.55, true, AGREEMENT_FORM_DEFECT_MIN)).toBe(false);
  });

  it("the floor never applies to a well-formed seed: the ceiling and the gain still do", () => {
    expect(agreementSwitches(0.5, 0.9, false, AGREEMENT_FORM_DEFECT_MIN)).toBe(false);
    expect(agreementSwitches(0.4, 0.6, false, AGREEMENT_FORM_DEFECT_MIN)).toBe(false);
    expect(agreementSwitches(0.2, 0.6, false, AGREEMENT_FORM_DEFECT_MIN)).toBe(true);
  });

  it("a null score never switches, whatever the floor", () => {
    expect(agreementSwitches(null, 1, true, 0)).toBe(false);
    expect(agreementSwitches(0.1, null, true, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// h122-ozet-1 (hunt 122, 2026-11-11): Independent Türkçe's CMS field dump is a form defect.
//
// indyturk's RSS description is its Drupal field dump ("...dediPazartesi, Kasım 9, 2026 -
// 21:30Main image: HaberType: newsSEO Title: <the headline>copyright Independentturkish:"). The
// tidy step now cuts it, but the cut text is still a guess at what the caption and the lead were,
// and its "SEO Title:" repeats the headline word for word, so it scored 1.00 and was picked as
// the Özet of 710ef4bb and, by the recency tie-break, of b8e7cc75. 'cms' is read on the RAW text
// (the tidied text no longer holds the markers): a member that has it never stands in for the
// seed, and a seed that has it is replaced from AGREEMENT_FORM_DEFECT_MIN up.
//
// The members are the real outlet texts of the live clusters (dumped read-only 2026-11-11), the
// ones each case needs.
// ---------------------------------------------------------------------------

function mem(name: string, kind: SourceKind, at: string, description: string, title: string): SummaryMember {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  return {
    source: { name, slug, kind, bias: "center" },
    article: { published_at: at, content_hash: `h-${slug}`, title, description, url: `https://example.com/${slug}` },
  };
}

function memberNamed(members: readonly SummaryMember[], name: string): SummaryMember {
  const m = members.find((x) => x.source.name === name);
  if (!m) throw new Error(`no member ${name}`);
  return m;
}

/** findAgreeingMember with `seedName` as the seed (its description is the stored summary). */
function pickFor(title: string, members: readonly SummaryMember[], seedName: string) {
  const seed = memberNamed(members, seedName);
  return findAgreeingMember({
    members,
    seed,
    seedShown: tidySummaryText((seed.article.description ?? "").trim()),
    title,
    wireMajorityHashes: new Set<string>(),
  });
}

const CMS_BAHCELI_TITLE = "MHP lideri Bahçeli’den 10 Kasım mesajı";
const CMS_BAHCELI_MEMBERS: SummaryMember[] = [
  mem("Türkiye Gazetesi", "outlet", "2026-11-09T14:40:03Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün vefatının 88'inci yıl dönümü dolayısıyla yayımladığı mesajda, Atatürk'ün fikirlerinin çağın gerçekleriyle geliştirilmesi ve Cumhuriyet mirasına sahip çıkılması gerektiğini belirtti.", "MHP lideri Bahçeli'den 10 Kasım mesajı"),
  mem("Milliyet", "outlet", "2026-11-09T14:43:41Z", "Milliyetçi Hareket Partisi Genel Başkanı Devlet Bahçeli’nin, \"Gazi Mustafa Kemal Atatürk’ün 88. Vefat Yıldönümü\" münasebetiyle yapmış olduğu yazılı basın açıklaması şöyle;\n\n\"ATATÜRK’Ü ANMA GÜNÜ, DEVLETİMİZ ADINA, MİLLETİMİZ NAMINA ÇOK KIYMETLİ\" \n\"Türkiye Cumhuriyeti devletinin kurucusu, istiklal mücadelemizin lideri, ilk Cumhurbaşkanımız Gazi Mustafa Kemal Atatürk’ü ebediyete irtihalinin 88. senesinde hürmet, rahmet ve minnetle anıyoruz. Türkiye Cumhuriyeti Devleti’nin kurucusu Gazi Mustafa K...", "Son dakika... Bahçeli'den 'Gazi Mustafa Kemal Atatürk’ün 88. vefat yıl dönümü' mesajı"),
  mem("Hürriyet", "outlet", "2026-11-09T14:45:00Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün vefatının 88. yıl dönümü dolayısıyla mesajı yayımladı.", "MHP lideri Bahçeli'den 10 Kasım mesajı"),
  mem("Haber7", "outlet", "2026-11-09T14:46:00Z", "Bahçeli, \"Aramızdan ayrılışının 88'inci yıl dönümünde Gazi Mustafa Kemal Atatürk’ü, Milli Mücadele kahramanlarıyla birlikte aziz şehitlerimizi saygı ve şükran hislerimle anıyor, hepsine Cenab-ı Allah’tan rahmetler niyaz ediyorum.\" dedi.", "Bahçeli'den 10 Kasım mesajı"),
  mem("Haberler.com", "aggregator", "2026-11-09T14:49:07Z", "MHP Genel Başkanı Devlet Bahçeli, Atatürk'ün 88. vefat yıl dönümü dolayısıyla yayımladığı mesajda, Atatürk'ü anlamanın kurucu felsefesine, devlet aklına ve temel ilkelerine sahip çıkmaktan geçtiğini belirterek, Cumhuriyet'in sonsuza kadar yaşatılması gerektiğini vurguladı.", "MHP Genel Başkanı Bahçeli: Atatürk'ü anlamanın yolu eserine ve fikirlerine sahip çıkmaktır"),
  mem("Yeniçağ", "outlet", "2026-11-09T15:00:18Z", "MHP Genel Başkanı Devlet Bahçeli, 10 Kasım dolayısıyla Atatürk’ü anma mesajı yayımladı. Atatürk’ü 88. ölüm yıl dönümünde anan Bahçeli, “Atatürk’ü yaşatmanın doğru yolu, eserine sahip çıkmak ve onun fikirlerini çağın gerçekleriyle yorumlayarak geliştirmekle imkana kavuşur” dedi.", "Devlet Bahçeli’den 10 Kasım’da Atatürk mesajı: “Fikirlerini çağın gerçekleriyle geliştirmeliyiz”"),
  mem("A Haber", "outlet", "2026-11-09T15:04:23Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün ebediyete irtihalinin 88. yıl dönümü dolayısıyla yayımladığı mesajda, Atatürk'ü anmanın yanı sıra onun fikirlerini yaşatmanın önemine...Devamı için tıklayınız", "MHP lideri Bahçeli'den Atatürk'ün 88. yıl dönümünde anma mesajı"),
  mem("Posta", "outlet", "2026-11-09T15:08:45Z", "MHP lideri Bahçeli, 10 Kasım dolayısıyla yayımladığı mesajında şu ifadelere yer verdi:\nTürkiye Cumhuriyeti devletinin kurucusu, istiklal mücadelemizin lideri, ilk Cumhurbaşkanımız Gazi Mustafa Kemal Atatürk’ü ebediyete irtihalinin 88. senesinde hürmet, rahmet ve minnetle anıyoruz.\nTürkiye Cumhuriyeti Devleti’nin kurucusu Gazi Mustafa Kemal Atatürk’ün ebediyete irtihalinin 88. Yıldönümü, Atatürk’ü anma günü, hiç kuşkusuz devletimiz adına, milletimiz namına çok kıymetli ve çok değerlidir. Ancak...", "MHP lideri Bahçeli'den 10 Kasım mesajı"),
  mem("Sabah", "outlet", "2026-11-09T15:09:32Z", "MHP Genel Başkanı Devlet Bahçeli, Atatürk’ü vefatının 88’nci yıl dönümünde andı. Bahçeli paylaşımında, “Milli Mücadele kahramanlarıyla birlikte aziz şehitlerimizi saygı ve şükran hislerimle anıyor, hepsine...Devamı için tıklayınız", "MHP lideri Bahçeli’den 10 Kasım paylaşımı!"),
  mem("TRT Haber", "outlet", "2026-11-09T15:22:00Z", "MHP Genel Başkanı Devlet Bahçeli, Gazi Mustafa Kemal Atatürk'ün ebediyete intikalinin 88. yılı vesilesiyle yayımladığı mesajda, \"Atatürke sevgi, saygı ve büyük bir duyguyla bağlı olan kuşaklara düşen görev onu anarken anlayıp geriye bıraktığı bu büyük mirası sonsuza kadar yaşatmaktır\" ifadelerini kullandı.", "MHP Genel Başkanı Bahçeli'den 10 Kasım mesajı"),
  mem("Independent Türkçe", "outlet", "2026-11-09T15:32:08Z", "MHP Genel Başkanı Devlet Bahçeli10 KASIMMHP Genel Başkanı Devlet Bahçeli, 10 Kasım dolayısıyla yayımladığı mesajda Gazi Mustafa Kemal Atatürk'ü rahmet ve minnetle andıPazartesi, Kasım 9, 2026 - 18:30Main image: Type: newsSEO Title: Bahçeli'den 10 Kasım mesajı: Atatürk'ü anlamanın en sağlıklı yolu temel ilkelerini faaliyetlerimizin merkezine koymaktırcopyright Independentturkish:", "Bahçeli'den 10 Kasım mesajı: Atatürk'ü anlamanın en sağlıklı yolu temel ilkelerini faaliyetlerimizin merkezine koymaktır"),
];
const CMS_AYM_TITLE = "AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir";
const CMS_AYM_MEMBERS: SummaryMember[] = [
  mem("Dokuz8 Haber", "outlet", "2026-11-09T17:55:00Z", "Anayasa Mahkemesi Başkanı Kadir Özkaya, anayasanın devletin işleyişini ve bireylerin hak ve özgürlüklerini güvence altına alan temel hukuk metni olduğunu vurguladı.", "AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir"),
  mem("Independent Türkçe", "outlet", "2026-11-09T18:38:43Z", "AYM Başkanı Kadir ÖzkayaAYM Başkanı Kadir Özkaya, anayasanın hak ve özgürlükleri güvence altına alan temel hukuk metni olduğunu belirterek, “Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir” dediPazartesi, Kasım 9, 2026 - 21:30Main image: HaberType: newsSEO Title: AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidircopyright Independentturkish:", "AYM Başkanı Özkaya: Anayasa, insan onurunu merkeze alan bir toplumsal mutabakat metnidir"),
];
const CMS_AYM_RAW = memberNamed(CMS_AYM_MEMBERS, "Independent Türkçe").article.description ?? "";
const CMS_BAHCELI_RAW = memberNamed(CMS_BAHCELI_MEMBERS, "Independent Türkçe").article.description ?? "";

describe("cms: Independent Türkçe's CMS field dump (h122-ozet-1)", () => {
  it("the fixtures are the dumps the cases below assume", () => {
    expect(CMS_AYM_RAW).toContain("SEO Title:");
    expect(CMS_BAHCELI_RAW).toContain("copyright Independentturkish:");
    expect(CMS_BAHCELI_RAW).toContain("Main image:");
    expect(tidySummaryText(CMS_AYM_RAW)).not.toContain("SEO Title");
    expect(tidySummaryText(CMS_BAHCELI_RAW)).not.toContain("Main image");
  });

  it.each([
    ["710ef4bb (AYM Başkanı)", CMS_AYM_RAW],
    ["b8e7cc75 (Bahçeli)", CMS_BAHCELI_RAW],
  ])("%s: summaryDefect and seedDisqualified both say 'cms' although the tidied text is clean", (_label, raw) => {
    const shown = tidySummaryText(raw);
    expect(shown).not.toMatch(/SEO Title|Main image|Independentturkish/i);
    expect(summaryDefect(raw, shown)).toBe("cms");
    expect(seedDisqualified(raw, shown)).toBe("cms");
    expect(seedDisqualified(raw, shown, { memberTitle: "x", clusterTitle: "y" })).toBe("cms");
  });

  it("each of the three fields alone is enough, in any case", () => {
    const lead = "Bakan Yılmaz, yeni düzenlemeyi açıkladı.";
    for (const tail of ["SEO Title: Başlık", "seo title: Başlık", "Main image: ", "MAIN IMAGE: x", "copyright Independentturkish:", "copyrightIndependentturkish:"]) {
      const raw = lead + tail;
      expect(summaryDefect(raw, lead), tail).toBe("cms");
      expect(seedDisqualified(raw, lead), tail).toBe("cms");
    }
  });

  it("it is the first verdict: before a cut stub, unbalanced quotes and a teaser", () => {
    const stub = "Bakan Yılmaz, yeni düzenlemeye ilişkin açıklamasında Main image: \n  Fotoğraf: AA...";
    expect(summaryDefect(stub, tidySummaryText(stub))).toBe("cms");
    const quotes = "“Bakan Yılmaz yeni düzenlemeyi açıkladı.SEO Title: x";
    expect(seedDisqualified(quotes, "“Bakan Yılmaz yeni düzenlemeyi açıkladı.")).toBe("cms");
    const teaser = "Peki, yeni düzenleme neler getiriyor?SEO Title: x";
    expect(summaryDefect(teaser, "Peki, yeni düzenleme neler getiriyor?")).toBe("cms");
  });

  it("a text that only mentions a date, a section label or an image is not 'cms'", () => {
    const dated = "Toplantı Pazartesi, Kasım 9, 2026 - 18:30 saatinde başlayacak ve iki gün sürecek.";
    expect(summaryDefect(dated, dated)).toBeNull();
    expect(seedDisqualified(dated, dated)).toBeNull();
    const image = "Sergide yer alan ana görüntü (main image) ile ilgili açıklama yapıldı ve ziyaretçilere bilgi verildi.";
    expect(summaryDefect(image, image)).toBeNull();
    expect(seedDisqualified(image, image)).toBeNull();
    expect(summaryDefect("", "")).toBeNull();
  });

  it("never throws on a non-string", () => {
    expect(summaryDefect(null as unknown as string, "x")).toBeNull();
    expect(seedDisqualified("x", undefined as unknown as string)).toBeNull();
  });

  describe("the replacement floor of a 'cms' seed is AGREEMENT_FORM_DEFECT_MIN, like any form defect", () => {
    // Five title stems: cumhu, erdog, azerb, forum, konus.
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu";
    const dump = "Cumhurbaşkanı Erdoğan, Azerbaycan forumunda konuştu.Cuma, Kasım 6, 2026 - 12:00Main image: Type: newsSEO Title: x";
    const seed = mem("Tohum", "outlet", "2026-11-08T10:00:00Z", dump, "Başlık");
    const three = mem("Üç", "outlet", "2026-11-08T10:05:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan ziyaretinde yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    const two = mem("İki", "outlet", "2026-11-08T10:06:00Z", "Cumhurbaşkanı Erdoğan, bugün yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");

    it("the seed itself covers the whole headline, so only its form can replace it", () => {
      expect(titleAgreement(title, tidySummaryText(dump))).toBe(1);
      expect(titleAgreement(title, tidySummaryText(three.article.description ?? ""))).toBeCloseTo(0.6, 9);
      expect(titleAgreement(title, tidySummaryText(two.article.description ?? ""))).toBeCloseTo(0.4, 9);
    });

    it("a 0.6 member replaces it (the floor is 0.6, not 0.75) and a 0.4 member does not", () => {
      expect(pickFor(title, [seed, three, two], "Tohum")?.member.source.name).toBe("Üç");
      expect(pickFor(title, [seed, two], "Tohum")).toBeNull();
    });

    it("the same seed without the CMS fields is kept: it agrees with the headline and is well formed", () => {
      const clean = mem("Tohum", "outlet", "2026-11-08T10:00:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan forumunda konuştu.", "Başlık");
      expect(pickFor(title, [clean, three], "Tohum")).toBeNull();
    });

    it("a member that carries the dump never stands in, whatever it scores", () => {
      const clean = mem("Tohum", "outlet", "2026-11-08T10:00:00Z", "Bugün hava parçalı bulutlu ve rüzgarlı geçecek, sıcaklıklar mevsim normalleri civarında olacak.", "Başlık");
      const dumped = mem("Dump", "outlet", "2026-11-08T10:10:00Z", dump, "Başlık");
      // The seed is a clean text that disagrees with the headline: it keeps the 0.75 bar, which `four` clears.
      const four = mem("Dört", "outlet", "2026-11-08T10:06:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan forumunda yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
      expect(titleAgreement(title, tidySummaryText(dump))).toBe(1);
      expect(pickFor(title, [clean, dumped], "Tohum")).toBeNull();
      expect(pickFor(title, [clean, dumped, four], "Tohum")?.member.source.name).toBe("Dört");
    });
  });

  describe("the live clusters", () => {
    it("b8e7cc75: the dump ties Yeniçağ at 0.83 and is the newer, so it used to win; now Yeniçağ is picked", () => {
      const dumped = memberNamed(CMS_BAHCELI_MEMBERS, "Independent Türkçe");
      const yenicag = memberNamed(CMS_BAHCELI_MEMBERS, "Yeniçağ");
      const dumpScore = titleAgreement(CMS_BAHCELI_TITLE, tidySummaryText(dumped.article.description ?? ""));
      const yenicagScore = titleAgreement(CMS_BAHCELI_TITLE, tidySummaryText(yenicag.article.description ?? ""));
      expect(dumpScore).toBeCloseTo(5 / 6, 9);
      expect(yenicagScore).toBeCloseTo(5 / 6, 9);
      expect(Date.parse(dumped.article.published_at)).toBeGreaterThan(Date.parse(yenicag.article.published_at));

      const pick = pickFor(CMS_BAHCELI_TITLE, CMS_BAHCELI_MEMBERS, "Milliyet");
      expect(pick?.member.source.name).toBe("Yeniçağ");
      expect(pick?.text).toBe(tidySummaryText(yenicag.article.description ?? ""));
      expect(pick?.text).not.toMatch(/SEO Title|Main image/);
    });

    it("b8e7cc75: Posta (1.00, a cut) and the other candidates do not beat Yeniçağ either", () => {
      const without = CMS_BAHCELI_MEMBERS.filter((m) => m.source.name !== "Independent Türkçe");
      expect(pickFor(CMS_BAHCELI_TITLE, without, "Milliyet")?.member.source.name).toBe("Yeniçağ");
      expect(pickFor(CMS_BAHCELI_TITLE, without.filter((m) => m.source.name !== "Yeniçağ"), "Milliyet")).toBeNull();
    });

    it("710ef4bb: the dump scores 1.00 because its SEO Title is the headline, yet nothing replaces the Dokuz8 Haber seed", () => {
      const dumped = memberNamed(CMS_AYM_MEMBERS, "Independent Türkçe");
      expect(titleAgreement(CMS_AYM_TITLE, tidySummaryText(dumped.article.description ?? ""))).toBe(1);
      expect(titleAgreement(CMS_AYM_TITLE, tidySummaryText(memberNamed(CMS_AYM_MEMBERS, "Dokuz8 Haber").article.description ?? ""))).toBeCloseTo(5 / 11, 9);
      expect(pickFor(CMS_AYM_TITLE, CMS_AYM_MEMBERS, "Dokuz8 Haber")).toBeNull();
    });

    it("a dump that is the SEED is replaced by a clean member from the form floor up", () => {
      // Independent Türkçe seeds the cluster; Yeniçağ (0.83) is a clean text of the same story.
      const members = CMS_BAHCELI_MEMBERS.filter((m) => ["Independent Türkçe", "Yeniçağ", "Posta", "A Haber"].includes(m.source.name));
      expect(pickFor(CMS_BAHCELI_TITLE, members, "Independent Türkçe")?.member.source.name).toBe("Yeniçağ");
    });
  });
});

// ---------------------------------------------------------------------------
// h122-ozet-2 (hunt 122, 2026-11-11): seeds that never state the news.
//
// (a) Haberler.com copies Anadolu Ajansı's quote bullets as its description ('- "Genel
//     Sekreterlik görevine talibim ..." "40 yıllık ..."'): 72abfb9f (7 sources), c859c91b and
//     4e0c0003 showed two or one bare, speaker-less quotations as the Özet. The seed scored
//     0.50, 0.36 and 0.00 and every replacement was under 0.75. A text that is only quotations
//     is a form defect ('quote-only', floor AGREEMENT_FORM_DEFECT_MIN) and never stands in.
// (b) 777ea7c5's seed is Elips Haber's "Yonca Verdioğlu Şık kimdir?" biography under a headline
//     that says she was detained: it names the people (0.63) and never says what happened. A seed
//     whose own article title is an explainer ("kimdir", "kaç yaşında", "nereli", "biyografisi")
//     under a headline that is not one counts as malformed (the gain is waived, its text is kept
//     out) but keeps the 0.75 floor: the gate is about what the text says.
//
// The members are the real outlet texts of the live clusters (dumped read-only 2026-11-11).
// ---------------------------------------------------------------------------

const QO_SINIRLIOGLU_TITLE = "Türkiye'nin BM Genel Sekreter adayı Sinirlioğlu: Diyalog taviz değil sorumluluktur";
const QO_SINIRLIOGLU: SummaryMember[] = [
  mem("Anadolu Ajansı", "wire", "2026-11-06T21:39:49Z", "Türkiye’nin Birleşmiş Milletler (BM) Genel Sekreter adayı Feridun Sinirlioğlu, \"Genel Sekreterlik görevine talibim çünkü BM'nin kusursuz olduğunu düşündüğüm için değil onun vazgeçilmez olduğuna inandığım için buradayım.\" dedi.", "Türkiye’nin BM Genel Sekreter adayı Sinirlioğlu, \"İnteraktif Diyalog Başlangıcı\" toplantısında hedeflerini açıkladı"),
  mem("Haberler.com", "aggregator", "2026-11-06T21:42:20Z", "- \"Genel Sekreterlik görevine talibim çünkü BM'nin kusursuz olduğunu düşündüğüm için değil onun vazgeçilmez olduğuna inandığım için buradayım\"\n\"40 yıllık diplomatik kariyerimde öğrendiğim bir ders varsa o da şudur: Diyalog, her zaman mümkündür. Bunun için yalnızca bir platforma ihtiyaç vardır. BM ise bu platformların en önemlisi\"", "Türkiye’nin BM Genel Sekreter adayı Sinirlioğlu, \"İnteraktif Diyalog Başlangıcı\" toplantısında hedeflerini açıkladı:"),
  mem("Star", "outlet", "2026-11-06T21:48:00Z", "Türkiye'nin BM Genel Sekreter adayı Feridun Sinirlioğlu, New York'taki BM Genel Merkezi'nde vizyonunu açıkladı. 40 yıllık diplomatik tecrübesine dikkat çekerek etkili arabuluculuk ve sessiz diplomasinin önemini vurgulayan Sinirlioğlu, kriz anlarında taraflarla temas kurmanın taviz değil, barış için bir sorumluluk olduğunu ifade etti.", "Türkiye'nin BM Genel Sekreter adayı Sinirlioğlu: Diyalog taviz değil sorumluluktur"),
  mem("İşçi Haber", "niche", "2026-11-06T21:52:59Z", "Türkiye'nin Birleşmiş Milletler Genel Sekreter adayı Feridun Sinirlioğlu, katıldığı interaktif diyalog toplantısında adaylık hedeflerini kamuoyu ile paylaştı. Sinirlioğlu, BM'nin yapısının kusursuz olmadığını ancak küresel sistem için vazgeçilmez bir öneme sahip olduğunu vurguladı.", "Feridun sinirlioğlu BM genel sekreterliği için vizyonunu açıkladı"),
  mem("CGTN Türk", "outlet", "2026-11-06T22:18:00Z", "Türkiye’nin Birleşmiş Milletler (BM) Genel Sekreter adayı Feridun Sinirlioğlu, \"Genel Sekreterlik görevine talibim çünkü BM'nin kusursuz olduğunu düşündüğüm için değil onun vazgeçilmez olduğuna inandığım için buradayım.\" dedi.", "Feridun Sinirlioğlu: BM Genel Sekreterliğine adayım çünkü..."),
  mem("Milliyet", "outlet", "2026-11-06T22:58:45Z", "Eski Dışişleri Bakanı ve halen Avrupa Güvenlik ve İşbirliği Teşkilatı (AGİT) Genel Sekreterliği görevini yürüten Sinirlioğlu, BM Genel Merkezi’nde düzenlenen \"İnteraktif Diyalog Başlangıcı\" toplantısında yaptığı konuşmada, BM Genel Sekreteri seçilmesi halinde izleyeceği politikaları ve öncelik vereceği alanları anlattı.\nSinirlioğlu, BM Şartı'na bağlı kalmanın idealizm meselesi olmadığını ve devletler arasındaki anlaşmazlıkları çözmenin yegane yolu olduğunu vurguladı.\nBM Şartı'nın, uluslararas...", "Türkiye’nin BM Genel Sekreter adayı Sinirlioğlu hedeflerini açıkladı"),
];
const QO_KACIR_TITLE = "Bakan Kacır, Seul'de Güney Koreli şirketlerin üst düzey yöneticileriyle görüştüklerini bildirdi";
const QO_KACIR: SummaryMember[] = [
  mem("Haberler.com", "aggregator", "2026-11-04T17:05:16Z", "- \"Ülkemizin yatırım, üretim ve teknoloji alanlarındaki potansiyelini küresel ölçekte daha ileriye taşımak için uluslararası işbirliklerini artırmaya devam edeceğiz\"", "Bakan Kacır, Seul'de Güney Koreli şirketlerin üst düzey yöneticileriyle görüştüklerini bildirdi:"),
  mem("Milliyet", "outlet", "2026-11-04T17:45:37Z", "Kacır, sanal medya hesabından hesabından, görüşmeye ilişkin paylaşım yaptı. Cumhurbaşkanımız Erdoğan'ın başkanlığında, Güney Kore'nin başkenti Seul'de teknoloji, otomotiv, elektronik, biyoteknoloji, kimya ve enerji gibi stratejik sektörlerde faaliyet gösteren şirketlerin üst düzey yöneticileriyle bir araya geldiklerini aktaran Kacır, \"⁠LG Electronics Üst Yöneticisi (CEO) Lyu Jae-cheol, ⁠Celltrion CEO'su Seo Jin-seok, ⁠SK Chemicals ve SK Plasma CEO'su Jaehyun Ahn, ⁠Hyundai Motor Group CEO'su C...", "Seul'de stratejik zirve! Bakan Kacır, Güney Koreli şirketlerin üst düzey yöneticileriyle görüştüklerini bildirdi"),
  mem("Haber7", "outlet", "2026-11-04T19:16:00Z", "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, Seul’de Samsung, Hyundai, LG ve SK Chemicals gibi şirketlerin üst düzey yöneticileriyle Türkiye’deki yatırım ve iş birliği fırsatlarını görüştü.", "Bakan Kacır, Güney Koreli teknoloji devleriyle bir araya geldi"),
  mem("Muhalif", "outlet", "2026-11-04T19:28:33Z", "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, Cumhurbaşkanı Erdoğan'ın Seul temasları kapsamında Güney Koreli dev şirketlerin CEO'larıyla bir araya gelerek...", "Seul'de dev zirve: Bakan Kacır küresel teknoloji devleriyle masaya oturdu"),
  mem("Posta", "outlet", "2026-11-04T22:14:18Z", "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, sanal medya hesabından yaptığı açıklamada şu ifadeleri kullandı:\n\"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın başkanlığında, Güney Kore'nin başkenti Seul'de teknoloji, otomotiv, elektronik, biyoteknoloji, kimya ve enerji gibi stratejik sektörlerde faaliyet gösteren şirketlerin üst düzey yöneticileriyle bir araya geldik. LG Electronics Üst Yöneticisi (CEO) Lyu Jae-cheol, Celltrion CEO'su Seo Jin-seok, SK Chemicals ve SK Plasma CEO'su Jaehyun Ah...", "Bakan Kacır, Cumhurbaşkanı Erdoğan'ın başkanlığında Güney Koreli teknoloji devleriyle bir araya geldi"),
  mem("Yeni Şafak", "outlet", "2026-11-05T01:00:00Z", "Cumhurbaşkanı Erdoğan, Güney Kore ziyaretinde teknoloji, elektronik, biyoteknoloji ve kimya alanlarında faaliyet gösteren şirketlerin üst düzey yöneticileriyle görüştü. Görüşmelerde LG Electronics CEO’su Lyu Jae-cheol, Samsung CEO’su Roh Tae-moon ve Hyundai Motor Group CEO’su Chung Euisun de yer aldı.", "Güney Kore’de teknoloji buluşması"),
];
const QO_ALABED_TITLE = "Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed'den okulların onarılması çağrısı";
const QO_ALABED: SummaryMember[] = [
  mem("Haberler.com", "aggregator", "2026-11-06T15:21:10Z", "- \"Suriye'deki okullar halen yıkık durumda; geleceğimizi yeniden inşa edebilmemiz için bu okulların onarılmasına yardım etmeliyiz\"\n\"Benim için Cumhurbaşkanı Erdoğan büyük bir rol model ve gelecekte onun gibi büyük bir lider olmayı diliyorum\"", "Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed'den okulların onarılması çağrısı:"),
  mem("Anadolu Ajansı", "wire", "2026-11-06T15:27:43Z", "Cumhurbaşkanı Erdoğan'a savaştan etkilenen çocukları temsil eden kelebek figürünü takdim eden Suriyeli Alabed, Erdoğan'la 10 yıl sonra bir araya gelmenin kendisi için büyük bir onur olduğunu belirterek \"Kendisi, benim için büyük bir rol model\" dedi.", "Cumhurbaşkanı Erdoğan'a kelebek figürü takdim eden Halepli Alabed'den okulların onarılması çağrısı"),
  mem("Star", "outlet", "2026-11-06T15:44:00Z", "Cumhurbaşkanı Recep Tayyip Erdoğan'a savaş ve açlıktan etkilenen çocukları temsil eden kelebek figürünü takdim eden Suriyeli Bana Alabed, Cumhurbaşkanı Erdoğan'la 10 yıl sonra yeniden bir araya gelmenin kendisi için büyük bir onur olduğunu belirterek, \"Benim için Cumhurbaşkanı Erdoğan büyük bir rol model ve gelecekte onun gibi büyük bir lider olmayı diliyorum.\" dedi.", "Halep'in sesi Alabed: Cumhurbaşkanı Erdoğan gibi bir lider olmak istiyorum"),
  mem("Akşam", "outlet", "2026-11-06T15:51:00Z", "Suriyeli aktivist Bana Alabed, Başkan Erdoğan'a savaş ve açlıktan etkilenen çocukları temsil eden kelebek figürünü takdim etti. Alabed, Erdoğan'ı kendisi için büyük bir rol model olarak nitelendirdi. Alabed, Başkan Erdoğan'la 10 yıl sonra yeniden bir araya gelmenin kendisi için büyük bir onur olduğunu belirterek \"Gelecekte onun gibi büyük bir lider olmayı diliyorum.\" dedi.", "Halepli Alabed 10 yıl sonra yeniden Başkan Erdoğan ile bir arada: Benim için büyük bir rol model"),
  mem("Takvim", "outlet", "2026-11-06T19:30:01Z", "Suriye'deki savaş sürecinde yaptığı sosyal medya paylaşımlarıyla tüm dünyaya sesini duyuran ve 10 yıl önce Cumhurbaşkanlığı Külliyesi'nde ağırlanan Halepli Bana Alabed, İstanbul Kongre Merkezi'nde düzenlenen TRT World Forum 2026'nın açılışında Basşkan Recep Tayyip Erdoğan ile yeniden bir araya geldi. Alabed, programda Erdoğan'a savaş ve açlıktan etkilenen çocukları temsil eden kelebek figürünü takdim etti.", "Suriye'nin sesi Bana Alabed 10 yıl sonra Başkan Erdoğan'la bir araya geldi: \"O benim için büyük bir rol model\""),
  mem("A Haber", "outlet", "2026-11-06T20:34:57Z", "Suriye'deki kanlı savaş sırasında sosyal medya paylaşımlarıyla Haleplilerin yaşadığı dramı tüm dünyaya duyuran ve 10 yıl önce Cumhurbaşkanlığı Külliyesi'nde ağırlanan Bana Alabed, Başkan Recep Tayyip...Devamı için tıklayınız", "Savaşın acılarını dünyaya duyurmuştu! Başkan Erdoğan ile Halepli Bana Alabed 10 yıl sonra yeniden bir arada"),
];
const EX_SIK_TITLE = "TİP Milletvekili Ahmet Şık'ın eşi Yonca Şık gözaltına alındı";
const EX_SIK: SummaryMember[] = [
  mem("Elips Haber", "outlet", "2026-11-10T10:55:00Z", "Yonca Verdioğlu Şık, TİP İstabul Milletvekili Ahmet Şık'ın eşidir. Sivil toplum ve medya alanındaki çalışmalarıyla tanınan Şık, İstanbul Üniversitesi İletişim Fakültesi Gazetecilik Bölümü mezunudur.", "Yonca Verdioğlu Şık kimdir?"),
  mem("Karar", "outlet", "2026-11-10T10:58:00Z", "TİP İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık, \"siyasal veya askeri casusluk\" suçlamasıyla evinden gözaltına alındı. Gözaltı kararının, TİP Genel Başkanı Erkan Baş'ın TBMM'de Şık'ın fon skandalına ilişkin paylaşımlarını silmesi karşılığında tutuklu arkadaşının serbest bırakılmasının teklif edildiğini açıklamasından bir gün sonra gelmesi dikkat çekti. Şık'ın arkadaşı Ahmet Saymadi de daha önce uyuşturucu soruşturması kapsamında tutuklanmıştı.", "Erkan Baş'ın 'tweeti silsin' açıklamasından bir gün sonra Ahmet Şık'ın eşine gözaltı"),
  mem("Haber7", "outlet", "2026-11-10T10:59:00Z", "TİP İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık hakkında gözaltı ve ev araması iddialarının gerçeği yansıtmadığı açıklandı.  Yetkililer, Şık hakkında herhangi bir gözaltı kararı bulunmadığını belirtti.", "Ahmet Şık'ın eşi hakkında yeni gelişme: \"Gözaltına alındı\" iddiası yalan çıktı!"),
  mem("Haber.com", "outlet", "2026-11-10T11:05:19Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık “siyasal veya askeri casusluk” suçlamasıyla gözaltına alındı.", "TİP Milletvekili Ahmet Şık'ın eşi Yonca Şık gözaltına alındı"),
  mem("Takvim", "outlet", "2026-11-10T11:25:48Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık’ın gözaltına alındığı yönündeki haberlerin gerçeği yansıtmadığı ortaya çıktı. Şık hakkında gözaltı kararı bulunmadığı, evinde arama yapılmadığı ve yalnızca ifadesinin alınması amacıyla mevcutlu olarak hazır edildiği belirtildi.", "Yonca Şık’ın gözaltına alındığı iddiası asılsız çıktı! Alman derneğiyle para trafiği mercek altında"),
  mem("GZT", "outlet", "2026-11-10T11:31:07Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili ve gazeteci Ahmet Şık'ın eşi Yonca Verdioğlu Şık, hakkında yürütülen soruşturma kapsamında \"siyasal veya askeri casusluk\" iddiasıyla gözaltına alındı. Evinde gözaltına alınan Yonca Şık'ın Çağlayan'daki İstanbul Adalet Sarayı'na götürüldüğü öğrenildi. Gelişmenin ardından Yonca Şık'ın hayatı, yaşı, memleketi ve mesleği yeniden araştırılmaya başlandı. Peki, Yonca Şık kimdir, nereli, kaç yaşında ve ne iş yapıyor?", "Yonca Şık kimdir?  Ahmet Şık'ın eşi Yonca Şık nereli, kaç yaşında, ne iş yapıyor?"),
  mem("BirGün", "outlet", "2026-11-10T11:34:00Z", "Partisinin İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık gözaltına alınmasıyla ilgili TBMM'de basın toplantısı düzenleyen TİP Genel Başkanı Erkan Baş, \"Bu kadar alçaklık, bu kadar mafyavari bir uygulama sanıyorum Türkiye Cumhuriyeti tarihinde eşine rastlanmamış bir şey\" dedi.", "Erkan Baş, Yonca Şık'ın gözaltına alınmasıyla ilgili konuştu: \"Saray rejimi bir mafya düzenine dönüşmüştür\""),
  mem("Sözcü", "outlet", "2026-11-10T11:37:10Z", "TİP İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık, \"siyasal veya askeri casusluk\" soruşturması kapsamında e...", "Yonca Verdioğlu Şık kimdir, Ahmet Şık'ın eşi neden göz altına alındı?"),
  mem("Yeni Akit", "outlet", "2026-11-10T11:43:00Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık, 'siyasal veya askeri casusluk' soruşturması kapsamında gözaltına alındı.", "Bütün kamuoyuna yalan söyledikleri ortaya çıktı! Ahmet Şık’ın eşine casusluk incelemesi"),
  mem("Haberler.com", "aggregator", "2026-11-10T11:52:09Z", "TİP İstanbul Milletvekili Ahmet Şık, eşi Yonca Verdioğlu Şık'ın gözaltına alınmasının ardından gündeme geldi. Gazetecilik geçmişi ve siyasi kariyeriyle tanınan Şık'ın hayatı, yaşı, memleketi ve hangi partiden milletvekili olduğu araştırılmaya başlandı. Peki, Ahmet Şık kimdir, milletvekili mi, hangi partiden? Ahmet Şık kaç yaşında, nereli? Detaylar haberimizde.", "Ahmet Şık kimdir, milletvekili mi, hangi partiden? Ahmet Şık kaç yaşında, nereli?"),
  mem("Cumhuriyet", "outlet", "2026-11-10T11:55:00Z", "TİP İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık, “siyasal veya askeri casusluk” soruşturması kapsamında Beyoğlu’ndaki evinden gözaltına alınarak İstanbul Adliyesi’ne götürüldü. Peki, Ahmet Şık kimdir? TİP Milletvekili Ahmet Şık kaç yaşında, nereli? Ahmet Şık'ın eşi Yonca Şık kim, neden gözaltına alındı?", "Ahmet Şık kimdir? TİP Milletvekili Ahmet Şık kaç yaşında, nereli? Ahmet Şık'ın eşi kim, neden gözaltına alındı?"),
  mem("Diken", "outlet", "2026-11-10T13:51:13Z", "Sera Kadıgil: Ahmet Şık'ın eşi kanser; bu mudur vekilliğin bedeli? 10.11.2026 DikenTürkiye İşçi Partisi (TİP) İstanbul Milletvekili Sera Kadıgil, gözaltına alınan vekil Ahmet Şık'ın eşi Yonca Şık'ın kanser olduğunu söyledi.\nThe post Sera Kadıgil: Ahmet Şık'ın eşi kanser; bu mudur vekilliğin bedeli? appeared first on #site_linkat 10.11.2026 .", "Sera Kadıgil: Ahmet Şık'ın eşi kanser; bu mudur vekilliğin bedeli?"),
  mem("İstiklal", "outlet", "2026-11-10T15:30:18Z", "TİP İstanbul Milletvekili Ahmet Şık'ın eşi Yonca Verdioğlu Şık hakkında yürütülen gözaltı sürecinde yeni gelişme yaşandı. Casusluk iddiasıyla gözaltına alınan Şık'ın ifadesinin ardından verilen karar belli oldu.", "Ahmet Şık'ın eşi Yonca Verdioğlu Şık hakkında yeni gelişme"),
  mem("Dokuz8 Haber", "outlet", "2026-11-10T17:19:22Z", "Türkiye İşçi Partisi (TİP) İstanbul Milletvekili Ahmet Şık’ın eşi Yonca Verdioğlu Şık, bir soruşturma kapsamında ifade vermek üzere gözaltına alındıktan sonra adli kontrolle serbest bırakıldı.", "Erkan Baş: Biz yarım adım bile geri atmayacağız, siz yolsuzluktan vazgeçeceksiniz"),
];

/** The tidied text of a member's description: what the page shows for it. */
const shownOfMember = (members: readonly SummaryMember[], name: string): string =>
  tidySummaryText((memberNamed(members, name).article.description ?? "").trim());

describe("isQuoteOnly (h122-ozet-2)", () => {
  it.each([
    ["72abfb9f: two segments, the list marker already tidied away", shownOfMember(QO_SINIRLIOGLU, "Haberler.com")],
    ["c859c91b: two segments", shownOfMember(QO_ALABED, "Haberler.com")],
    ["4e0c0003: one segment", shownOfMember(QO_KACIR, "Haberler.com")],
  ])("is true for the tidied seed of %s", (_label, shown) => {
    expect(isQuoteOnly(shown)).toBe(true);
  });

  it.each([
    ['one straight segment', '"Ekonomi büyüyecek"'],
    ['one curly segment', "“Ekonomi büyüyecek”"],
    ['two segments with a blank between', '"Birinci söz" "İkinci söz"'],
    ['two segments with several blanks and a newline', '"Birinci söz"   \n  "İkinci söz"'],
    ['a trailing full stop', '"Ekonomi büyüyecek".'],
    ['a trailing full stop after a blank', '"Ekonomi büyüyecek" .'],
    ['a raw list marker "- "', '- "Ekonomi büyüyecek"'],
    ['a raw list marker "• "', '• "Ekonomi büyüyecek"'],
    ['blanks around it all', '   "Ekonomi büyüyecek"   '],
    ['segments with no blank between them', '"Birinci""İkinci"'],
    ['sentences, a colon and digits inside a segment', '"Bu bir ders: Diyalog mümkündür. 40 yıl, 3 ay"'],
    ['a nested curly pair inside a curly segment', "“Dedi ki “yarın” gelir”"],
    ['a straight pair inside a curly segment', '“Dedi ki "yarın" gelir”'],
    ['an apostrophe and single quotes inside a segment', "\"BM'nin 'kusursuz' olduğu\""],
    ['mixed straight and curly segments', '"Birinci" “İkinci”'],
  ])("is true for %s", (_label, text) => {
    expect(isQuoteOnly(text)).toBe(true);
  });

  it.each([
    ["a speaker in front of the quotation", 'Sinirlioğlu, "Genel Sekreterlik görevine talibim" dedi.'],
    ["a quoted word in a sentence", '"Ekonomi" başlıklı rapor yayımlandı.'],
    ["a word after the last quotation", '"Ekonomi büyüyecek" dedi'],
    ["a word between two quotations", '"Birinci söz" ve "İkinci söz"'],
    ["a comma between two quotations", '"Birinci söz", "İkinci söz"'],
    ["a dash between two quotations", '"Birinci söz" - "İkinci söz"'],
    ["a trailing ellipsis", '"Ekonomi büyüyecek"…'],
    ["two trailing full stops", '"Ekonomi büyüyecek"..'],
    ["the empty string", ""],
    ["blanks only", "   \n "],
    ["a list marker only", "- "],
    ["a list marker with no blank after it", '-"Ekonomi büyüyecek"'],
    ["two list markers", '- - "Ekonomi büyüyecek"'],
    ["an unbalanced straight quote", '"Ekonomi büyüyecek'],
    ["an unbalanced second quotation", '"Birinci söz" "İkinci söz'],
    ["an opener with no closer", "“Ekonomi büyüyecek"],
    ["a closer with no opener", "Ekonomi büyüyecek”"],
    ["two openers and one closer", "“Birinci “İkinci”"],
    ["an empty pair of quotes", '""'],
    ["a pair of quotes holding blanks", '"   "'],
    ["single quotes only", "'Ekonomi büyüyecek'"],
    ["a plain sentence", "Cumhurbaşkanı Erdoğan, partisinin grup toplantısında konuştu."],
    ["a digit outside the quotes", '"Birinci söz" 2'],
  ])("is false for %s", (_label, text) => {
    expect(isQuoteOnly(text)).toBe(false);
  });

  it("never throws on a non-string", () => {
    expect(isQuoteOnly(undefined as unknown as string)).toBe(false);
    expect(isQuoteOnly(null as unknown as string)).toBe(false);
    expect(isQuoteOnly(42 as unknown as string)).toBe(false);
  });

  // 200,000 characters; ceiling 2000 ms (CPU time over a size ladder, tests/_helpers/linear-time.ts).
  it.each([
    ["segments repeated", rep('"a" ', "", ""), 200_000],
    ["curly segments repeated", rep("“a” ", "", ""), 200_000],
    ["an opener and 200000 letters", rep("a", '"', ""), 200_000],
    ["200000 curly openers", rep("“", "", ""), 200_000],
    ["200000 straight quotes", rep('"', "", ""), 200_000],
    ["a segment, then 200000 blanks and a letter", rep(" ", '"a"', "x"), 200_000],
    ["200000 nested curly pairs", rep("“a”", "“", "”"), 200_000],
  ] as Array<[string, Gen, number]>)("linear time: %s", (_name, gen, n) => {
    expectLinear(gen, (s) => isQuoteOnly(s), { n, ceilingMs: 2_000 });
  });
});

describe("'quote-only' is a form defect of a seed and of a candidate (h122-ozet-2)", () => {
  const QUOTES = '"Ülkemizin yatırım, üretim ve teknoloji alanlarındaki potansiyelini daha ileriye taşıyacağız"';

  it("seedDisqualified says 'quote-only' for the three live seeds", () => {
    for (const [members, name] of [
      [QO_SINIRLIOGLU, "Haberler.com"],
      [QO_ALABED, "Haberler.com"],
      [QO_KACIR, "Haberler.com"],
    ] as const) {
      const raw = (memberNamed(members, name).article.description ?? "").trim();
      expect(seedDisqualified(raw, tidySummaryText(raw)), `${members.length} members`).toBe("quote-only");
    }
  });

  it("summaryDefect says 'quote-only' for them too", () => {
    for (const [members, name] of [
      [QO_SINIRLIOGLU, "Haberler.com"],
      [QO_ALABED, "Haberler.com"],
      [QO_KACIR, "Haberler.com"],
    ] as const) {
      const raw = (memberNamed(members, name).article.description ?? "").trim();
      expect(summaryDefect(raw, tidySummaryText(raw))).toBe("quote-only");
    }
  });

  it("it is checked after 'quotes': an unbalanced text keeps 'quotes'", () => {
    const unbalanced = '"Birinci söz" "İkinci söz';
    expect(seedDisqualified(unbalanced, unbalanced)).toBe("quotes");
    expect(seedDisqualified(QUOTES, QUOTES)).toBe("quote-only");
  });

  it("a quotation with a speaker is not quote-only: it is clean", () => {
    const attributed = 'Sinirlioğlu, "Genel Sekreterlik görevine talibim çünkü BM vazgeçilmez" dedi.';
    expect(seedDisqualified(attributed, attributed)).toBeNull();
    expect(summaryDefect(attributed, attributed)).toBeNull();
  });

  it("a quote-only seed is replaced from the form floor (0.6), not from 0.75", () => {
    // Five title stems: cumhu, erdog, azerb, forum, konus.
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu";
    const seed = mem("Tohum", "outlet", "2026-11-08T10:00:00Z", '"Cumhurbaşkanı Erdoğan, Azerbaycan forumunda konuştu"', "x");
    const three = mem("Üç", "outlet", "2026-11-08T10:05:00Z", "Cumhurbaşkanı Erdoğan, Azerbaycan ziyaretinde yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    const two = mem("İki", "outlet", "2026-11-08T10:06:00Z", "Cumhurbaşkanı Erdoğan, bugün yaptığı görüşmeleri özetledi ve gazetecilere bilgi verdi.", "x");
    // The seed covers the whole headline: only its form can replace it.
    expect(titleAgreement(title, tidySummaryText(seed.article.description ?? ""))).toBe(1);
    expect(pickFor(title, [seed, three, two], "Tohum")?.member.source.name).toBe("Üç");
    expect(pickFor(title, [seed, two], "Tohum")).toBeNull();
  });

  it("a member whose description is only quotations never stands in, whatever it scores", () => {
    // Five title stems: cumhu, erdog, azerb, forum, konus.
    const title = "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu";
    const weather = mem("Tohum", "outlet", "2026-11-08T10:00:00Z", "Bugün hava parçalı bulutlu ve rüzgarlı geçecek, sıcaklıklar mevsim normalleri civarında olacak.", "x");
    const quotes = mem("Alıntı", "outlet", "2026-11-08T10:05:00Z", '- "Cumhurbaşkanı Erdoğan Azerbaycan forumunda konuştu, ilişkileri anlattı"', "x");
    expect(titleAgreement(title, tidySummaryText(quotes.article.description ?? ""))).toBe(1);
    expect(pickFor(title, [weather, quotes], "Tohum")).toBeNull();
  });
});

describe("findAgreeingMember: the quote-only seeds of the live clusters (h122-ozet-2)", () => {
  it("72abfb9f: the seed scores exactly 0.50 (kept before); Star (0.90) replaces it", () => {
    const seedShown = shownOfMember(QO_SINIRLIOGLU, "Haberler.com");
    expect(titleAgreement(QO_SINIRLIOGLU_TITLE, seedShown)).toBe(0.5);
    expect(titleAgreement(QO_SINIRLIOGLU_TITLE, shownOfMember(QO_SINIRLIOGLU, "Star"))).toBeCloseTo(0.9, 9);
    const pick = pickFor(QO_SINIRLIOGLU_TITLE, QO_SINIRLIOGLU, "Haberler.com");
    expect(pick?.member.source.name).toBe("Star");
    expect(pick?.text).toBe(shownOfMember(QO_SINIRLIOGLU, "Star"));
  });

  it("4e0c0003: the seed scores 0.00; Haber7 (0.73, under 0.75) replaces it", () => {
    expect(titleAgreement(QO_KACIR_TITLE, shownOfMember(QO_KACIR, "Haberler.com"))).toBe(0);
    expect(titleAgreement(QO_KACIR_TITLE, shownOfMember(QO_KACIR, "Haber7"))).toBeCloseTo(8 / 11, 9);
    const pick = pickFor(QO_KACIR_TITLE, QO_KACIR, "Haberler.com");
    expect(pick?.member.source.name).toBe("Haber7");
    expect(pick?.text).toBe(shownOfMember(QO_KACIR, "Haber7"));
  });

  it("c859c91b: the seed scores 0.36; Takvim (0.73, under 0.75) replaces it", () => {
    expect(titleAgreement(QO_ALABED_TITLE, shownOfMember(QO_ALABED, "Haberler.com"))).toBeCloseTo(4 / 11, 9);
    expect(titleAgreement(QO_ALABED_TITLE, shownOfMember(QO_ALABED, "Takvim"))).toBeCloseTo(8 / 11, 9);
    const pick = pickFor(QO_ALABED_TITLE, QO_ALABED, "Haberler.com");
    expect(pick?.member.source.name).toBe("Takvim");
    expect(pick?.text).toBe(shownOfMember(QO_ALABED, "Takvim"));
  });

  it("a cluster with no qualifying member keeps the seed (never blank)", () => {
    // Yeni Şafak scores 0.55 against the 4e0c0003 headline, under the 0.6 floor; Muhalif is a cut stub.
    const two = QO_KACIR.filter((m) => ["Haberler.com", "Yeni Şafak"].includes(m.source.name));
    expect(two).toHaveLength(2);
    expect(titleAgreement(QO_KACIR_TITLE, shownOfMember(QO_KACIR, "Yeni Şafak"))).toBeCloseTo(6 / 11, 9);
    expect(pickFor(QO_KACIR_TITLE, two, "Haberler.com")).toBeNull();
    const stub = QO_KACIR.filter((m) => ["Haberler.com", "Muhalif"].includes(m.source.name));
    expect(pickFor(QO_KACIR_TITLE, stub, "Haberler.com")).toBeNull();
  });
});

describe("isExplainerTitle (h122-ozet-2)", () => {
  it.each([
    "Yonca Verdioğlu Şık kimdir?",
    "YONCA ŞIK KİMDİR",
    "Ahmet Şık kimdir, milletvekili mi, hangi partiden?",
    "Yonca Şık kaç yaşında, ne iş yapıyor?",
    "Yonca Şık KAÇ YAŞINDA",
    "Yonca Şık nereli?",
    "Yonca Şık biyografisi",
    "Ahmet Şık'ın eşi kimdir",
    "Yonca Şık kaç\u00a0yaşında",
  ])("is true for %s", (title) => {
    expect(isExplainerTitle(title)).toBe(true);
  });

  it.each([
    "TİP Milletvekili Ahmet Şık'ın eşi Yonca Şık gözaltına alındı",
    "Kimdirler bunlar",
    "Kimdirin bir sözü",
    "Nerelerde yağış var",
    "Biyografisiz bir hayat",
    "",
  ])("is false for %s", (title) => {
    expect(isExplainerTitle(title)).toBe(false);
  });

  it("never throws on a non-string", () => {
    expect(isExplainerTitle(undefined)).toBe(false);
    expect(isExplainerTitle(null)).toBe(false);
    expect(isExplainerTitle(7 as unknown as string)).toBe(false);
  });

  it.each([
    ["a long text with no match", rep("a ", "", ""), 200_000],
    ["'kimdir' glued to letters, repeated", rep("kimdirx ", "", ""), 200_000],
    ["blanks", rep(" ", "kac", "yasinda"), 200_000],
  ] as Array<[string, Gen, number]>)("linear time: %s", (_name, gen, n) => {
    expectLinear(gen, (s) => isExplainerTitle(s), { n, ceilingMs: 2_000 });
  });
});

describe("findAgreeingMember: an explainer seed (h122-ozet-2, 777ea7c5)", () => {
  const SEED = "Elips Haber";
  const SIX = ["Karar", "Haber.com", "Takvim", "GZT", "Yeni Akit", "Dokuz8 Haber"];

  it("the fixtures are what the cases assume: a biography at 0.63 under a headline of detention", () => {
    expect(memberNamed(EX_SIK, SEED).article.title).toBe("Yonca Verdioğlu Şık kimdir?");
    const seedShown = shownOfMember(EX_SIK, SEED);
    expect(seedShown.endsWith("Gazetecilik Bölümü mezunudur.")).toBe(true);
    expect(titleAgreement(EX_SIK_TITLE, seedShown)).toBeCloseTo(5 / 8, 9);
    expect(seedDisqualified((memberNamed(EX_SIK, SEED).article.description ?? "").trim(), seedShown)).toBeNull();
    for (const name of SIX) expect(titleAgreement(EX_SIK_TITLE, shownOfMember(EX_SIK, name)), name).toBe(1);
  });

  it("the pick is Dokuz8 Haber: the newest of the six members that cover the whole headline", () => {
    const times = SIX.map((n) => [n, memberNamed(EX_SIK, n).article.published_at] as const);
    const newest = [...times].sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))[0]!;
    expect(newest[0]).toBe("Dokuz8 Haber");
    const pick = pickFor(EX_SIK_TITLE, EX_SIK, SEED);
    expect(pick?.member.source.name).toBe("Dokuz8 Haber");
    expect(pick?.text).toBe(shownOfMember(EX_SIK, "Dokuz8 Haber"));
  });

  it("the seed's own words are kept out, also under another outlet's name", () => {
    // The seed (an explainer-titled article) holds Haber.com's statement, which covers the headline
    // (1.00): it is replaced for its title, so neither Haber.com's identical text nor a newer copy of it may stand in.
    const description = memberNamed(EX_SIK, "Haber.com").article.description ?? "";
    const members = EX_SIK.map((m) => (m.source.name === SEED ? { ...m, article: { ...m.article, description } } : m));
    const copy = mem("Kopya", "outlet", "2026-11-10T18:00:00Z", description, "Başka başlık");
    expect(titleAgreement(EX_SIK_TITLE, tidySummaryText(description))).toBe(1);
    const pick = pickFor(EX_SIK_TITLE, [...members, copy], SEED);
    expect(pick?.member.source.name).toBe("Dokuz8 Haber");
  });

  it("candidates are not filtered by their titles: Cumhuriyet's 'Ahmet Şık kimdir?' carries the detention", () => {
    const cumhuriyet = memberNamed(EX_SIK, "Cumhuriyet");
    expect(isExplainerTitle(cumhuriyet.article.title)).toBe(true);
    expect(shownOfMember(EX_SIK, "Cumhuriyet")).toContain("gözaltına alınarak");
    const only = EX_SIK.filter((m) => [SEED, "Cumhuriyet"].includes(m.source.name));
    // 0.88 clears the 0.75 floor: the explainer-titled candidate stands in.
    expect(titleAgreement(EX_SIK_TITLE, shownOfMember(EX_SIK, "Cumhuriyet"))).toBeCloseTo(7 / 8, 9);
    expect(pickFor(EX_SIK_TITLE, only, SEED)?.member.source.name).toBe("Cumhuriyet");
  });

  it("the floor stays 0.75: a 0.63 member does not replace an explainer seed", () => {
    // Haberler.com's text is a come-on ('teaser'), Sözcü's is a cut stub: build a clean 0.63 member.
    const sixtyThree = mem("Altmış", "outlet", "2026-11-10T12:00:00Z", "Yonca Verdioğlu Şık, TİP İstanbul Milletvekili Ahmet Şık'ın hayat arkadaşı olarak biliniyor ve gazetecilik yapıyor.", "Başka başlık");
    expect(titleAgreement(EX_SIK_TITLE, shownOfMember([sixtyThree], "Altmış"))).toBeCloseTo(5 / 8, 9);
    const only = [memberNamed(EX_SIK, SEED), sixtyThree];
    expect(pickFor(EX_SIK_TITLE, only, SEED)).toBeNull();
  });

  it("the same seed under the cluster title 'Yonca Verdioğlu Şık kimdir?' is kept: the headline is an explainer too", () => {
    expect(pickFor("Yonca Verdioğlu Şık kimdir?", EX_SIK, SEED)).toBeNull();
  });

  it("a seed whose article title has no explainer word behaves as today: the 0.63 seed is kept", () => {
    const members = EX_SIK.map((m) =>
      m.source.name === SEED ? { ...m, article: { ...m.article, title: "Yonca Şık hakkında bilgi" } } : m,
    );
    expect(pickFor(EX_SIK_TITLE, members, SEED)).toBeNull();
    const noTitle = EX_SIK.map((m) => (m.source.name === SEED ? { ...m, article: { ...m.article, title: undefined } } : m));
    expect(pickFor(EX_SIK_TITLE, noTitle, SEED)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// h122-ozet-3 (hunt 122, 2026-11-11): a seed that is cut where it hides the statement.
//
// (A) Turkuvaz's "<cut>...Devamı için tıklayınız" (A Haber, Sabah, Yeni Aşır: 107 cluster seeds in 7
//     days) is a cut stub whether or not it matches the 202/203 feed-cap lengths: the tidy step now
//     repairs it, and when what is shown still ends in "…" the seed is a 'stub' (dfaaceac: it
//     scored 0.43 and escaped the stub check, because "…terörsüz Türkiye sürecine, fon..." has a
//     finite verb in its last sentence).
// (B) A clamp cut inside a quotation that follows "şunları kaydetti:" or "şöyle sürdürdü:" shows the
//     sentence in front of the introducer's sentence, and the quotation is gone: the seed is a
//     'stub' (837fa770: Milliyet's text said nothing of the headline's quote, while four outlets
//     score 1.00).
// The members are the real outlet texts of the live clusters (dumped read-only 2026-11-11).
// ---------------------------------------------------------------------------

const CT_FAKIBABA_TITLE = "Ahmet Eşref Fakıbaba A Haber'e konuştu. Kapıyı aralayan sözler: \"AK Parti bana emek verdi, ben AK Parti'ye...\"";
const CT_FAKIBABA: SummaryMember[] = [
  mem("A Haber", "outlet", "2026-11-10T19:51:25Z", "Geçtiğimiz günlerde İYİ Parti üyeliğinden ve Ankara Milletvekilliği görevinden istifa eden Ahmet Eşref Fakıbaba, AK Parti'ye geçeceği yönündeki kulis iddialarına A Haber ekranlarından yanıt verdi. AK...Devamı için tıklayınız", "Ahmet Eşref Fakıbaba A Haber'e konuştu! Kapıyı aralayan sözler: \"AK Parti bana emek verdi, ben AK Parti'ye...\""),
  mem("Takvim", "outlet", "2026-11-10T20:42:28Z", "İYİ Parti üyeliğinden ve Ankara Milletvekilliği görevinden istifa eden Ahmet Eşref Fakıbaba, AK Parti'ye geçeceği yönündeki iddialara A Haber'de yanıt verdi. AK Parti ile herhangi bir temasının olmadığını belirten Fakıbaba, siyasi geleceğine ilişkin kararını henüz vermediğini söyledi. Olası bir teklife ise \"Büyük bir sürpriz olur mu sizce? Bilmiyorum.\" sözleriyle kapıyı açık bıraktı.", "Ahmet Eşref Fakıbaba'dan AK Parti'ye dönüş iddialarına A Haber'de yanıt! \"Büyük bir sürpriz olur mu sizce?\""),
];
const CT_MAHIROGLU_TITLE = "Mahiroğlu'nun kara para ağına 2. dalga operasyon: 7 şüpheli gözaltında";
const CT_MAHIROGLU: SummaryMember[] = [
  mem("Sabah", "outlet", "2026-11-10T19:55:43Z", "İstanbul Büyükşehir Belediyesi eski Başkanı Ekrem İmamoğlu'na verdiği destek nedeniyle Sarıyer'deki kaçak villasına göz yumulan Halk TV'nin firari eski sahibi Cafer Mahiroğlu'na yönelik rüşvet, ihaleye...Devamı için tıklayınız", "Mahiroğlu'nun kara para ağına 2. dalga operasyon: 7 şüpheli gözaltında"),
];
const CT_KABINE_TITLE = "Kabine Erdoğan liderliğinde toplanıyor: Masada kritik başlıklar";
const CT_KABINE: SummaryMember[] = [
  mem("A Haber", "outlet", "2026-11-08T17:11:11Z", "Başkan Recep Tayyip Erdoğan başkanlığında Cumhurbaşkanlığı Külliyesi'nde toplanacak Cumhurbaşkanlığı Kabinesi; emekli maaşlarına yönelik yeni düzenlemelerden terörsüz Türkiye sürecine, fon...Devamı için tıklayınız", "CANLI | Kabine sona erdi! Başkan Erdoğan'dan önemli açıklamalar"),
  mem("İşçi Haber", "niche", "2026-11-08T17:27:16Z", "Başkan Erdoğan liderliğinde toplanan Kabine, emekli maaşlarına yapılacak ek zam ve piyasa manipülasyonlarına karşı alınacak önlemleri değerlendirecek. Toplantıda ayrıca terörle mücadeledeki yeni süreç ve Türkiye'nin ev sahipliğinde gerçekleşecek uluslararası zirveler masaya yatırılacak.", "Kabine Erdoğan liderliğinde toplanıyor: Masada kritik başlıklar"),
  mem("Yeni Şafak", "outlet", "2026-11-09T06:16:48Z", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de saat 16.00'da toplanıyor. Yılın en kritik toplantılarından birinde emeklilere refah payı düzenlemesinden dev yatırım fonu soruşturmasına, Terörsüz Türkiye sürecinden ABD-İran gerilimine kadar çok sayıda hayati başlık masaya yatırılacak.", "Beştepe'de kritik Kabine toplanıyor: Masada emekli zammı var"),
  mem("Yeni Mesaj", "outlet", "2026-11-09T07:45:00Z", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak.Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de saat 16.00'da toplanacak kabinenin gündeminde; emeklilere refah payı düzenlemesi , fon ...", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak"),
  mem("F5 Haber", "aggregator", "2026-11-09T08:20:00Z", "Cumhurbaşkanlığı Kabinesi, Cumhurbaşkanı Recep Tayyip Erdoğan başkanlığında Beştepe'de toplanıyor. Toplantıda emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak.", "Kabine toplanıyor. Emekliye refah payı düzenlemesi ve fon soruşturması ele alınacak"),
];
const CT_DURAN_TITLE = "Burhanettin Duran: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek";
const CT_DURAN: SummaryMember[] = [
  mem("Haberler.com", "aggregator", "2026-11-09T19:58:05Z", "- \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek\"", "İletişim Başkanı Duran'dan \"COP31\" paylaşımı:"),
  mem("Milliyet", "outlet", "2026-11-09T20:08:52Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, NSosyal hesabından, Türkiye'nin ev sahipliğinde Antalya'da düzenlenen Birleşmiş Milletler İklim Değişikliği Çerçeve Sözleşmesi'nin 31. Taraflar Konferansı'na (COP31) ilişkin paylaşımda bulundu.\nTürkiye'nin, COP31'e başkanlık ve ev sahipliği yaparak küresel iklim diplomasisinin merkezinde yer aldığını belirten Duran, şunları kaydetti: \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin ...", "İletişim Başkanı Duran'dan 'COP31' paylaşımı: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek"),
  mem("Diriliş Postası", "outlet", "2026-11-09T20:15:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek.\" ifadesini kullandı.", "Burhanettin Duran: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek"),
  mem("Yeni Şafak", "outlet", "2026-11-09T20:25:05Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran NSosyal hesabından, Türkiye'nin ev sahipliğinde Antalya'da düzenlenen Birleşmiş Milletler İklim Değişikliği Çerçeve Sözleşmesi'nin 31. Taraflar Konferansı'na (COP31) ilişkin paylaşımda bulundu. Türkiye'nin, COP31'e başkanlık ve ev sahipliği yaparak küresel iklim diplomasisinin merkezinde yer aldığını belirten Duran, şunları kaydetti: \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin k...", "İletişim Başkanı Duran'dan \"COP31\" paylaşımı"),
  mem("Haber Global", "outlet", "2026-11-09T20:52:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek.\" ifadesini kullandı.", "İletişim Başkanı Duran'dan \"COP31\" paylaşımı: Türkiye küresel iklim politikalarına katkı sunmaya devam edecek"),
  mem("Elips Haber", "outlet", "2026-11-09T21:07:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek.\" ifadesini kullandı.", "İletişim Başkanı Duran'dan 'COP31' paylaşımı"),
  mem("TRT Haber", "outlet", "2026-11-09T21:21:00Z", "Cumhurbaşkanlığı İletişim Başkanı Burhanettin Duran, \"Cumhurbaşkanımız Sayın Recep Tayyip Erdoğan'ın liderliğinde Türkiye, sürdürülebilir kalkınmayı ve çevrenin korunmasını birlikte ele alan yaklaşımıyla küresel iklim politikalarının şekillenmesine katkı sunmaya devam edecek\" dedi.", "İletişim Başkanı Duran: Türkiye küresel iklim diplomasisinin merkezinde yer alıyor"),
];
const CT_YAYMAN_TITLE = "AK Parti'li Yayman'dan yeni anayasa açıklaması";
const CT_YAYMAN: SummaryMember[] = [
  mem("Milliyet", "outlet", "2026-11-07T12:49:01Z", "Yayman, Türkiye Yüzyılı Buluşmaları kapsamında AK Parti Mersin İl Başkanlığınca Suphi Öner Öğretmenevi'nde düzenlenen Basın Buluşması programına katıldı.\nBurada konuşan Yayman, AK Parti'nin krizlerle mücadele ederek bu noktaya geldiğini söyledi.\nFon meselesiyle ilgili değerlendirmede bulunan Yayman, konuşmasını şöyle sürdürdü: \"Cumhurbaşkanı'mızın söylediği gibi biz bunu da aşacağız çünkü AK Parti '3 Y' ile kurulmuştur. Yasaklarla mücadele etmek, sessiz devrimler başarmıştır. Yoksullukla müca...", "AK Parti'li Yayman'dan yeni anayasa açıklaması"),
  mem("Posta", "outlet", "2026-11-07T13:33:50Z", "Yayman, Türkiye Yüzyılı Buluşmaları kapsamında AK Parti Mersin İl Başkanlığınca Suphi Öner Öğretmenevi'nde düzenlenen Basın Buluşması programına katıldı.\nBurada konuşan Yayman, AK Parti'nin krizlerle mücadele ederek bu noktaya geldiğini söyledi.\nFon meselesiyle ilgili değerlendirmede bulunan Yayman, konuşmasını şöyle sürdürdü:\n\"Cumhurbaşkanı'mızın söylediği gibi biz bunu da aşacağız çünkü AK Parti '3 Y' ile kurulmuştur. Yasaklarla mücadele etmek, sessiz devrimler başarmıştır. Yoksullukla müca...", "AK Parti'li Yayman: Türkiye'yi dünyanın en gelişmiş 10 ülkesinden birisi haline getireceğiz"),
];

/** The repaired, trimmed description of a member: what `seedDisqualified` is given as `raw`. */
const rawOfMember = (members: readonly SummaryMember[], name: string): string =>
  (memberNamed(members, name).article.description ?? "").trim();

describe("seedDisqualified: a Turkuvaz CTA feed cut (h122-ozet-3)", () => {
  it("dfaaceac: the repaired text still ends in '…' and the raw text is a CTA feed cut: 'stub'", () => {
    const raw = rawOfMember(CT_KABINE, "A Haber");
    const shown = tidySummaryText(raw);
    expect(isCtaFeedCut(raw)).toBe(true);
    expect(shown.endsWith("terörsüz Türkiye sürecine…")).toBe(true);
    // The last sentence holds a finite verb ("toplanacak"), which is why the old rule let it through.
    expect(hasFiniteVerb("Başkan Recep Tayyip Erdoğan başkanlığında Cumhurbaşkanlığı Külliyesi'nde toplanacak")).toBe(true);
    expect(titleAgreement(CT_KABINE_TITLE, shown)).toBeCloseTo(3 / 7, 9);
    expect(seedDisqualified(raw, shown)).toBe("stub");
  });

  it("dfaaceac: Yeni Şafak (0.71, under 0.75, over the form floor) replaces the cut seed", () => {
    expect(titleAgreement(CT_KABINE_TITLE, shownOfMember(CT_KABINE, "Yeni Şafak"))).toBeCloseTo(5 / 7, 9);
    const pick = pickFor(CT_KABINE_TITLE, CT_KABINE, "A Haber");
    expect(pick?.member.source.name).toBe("Yeni Şafak");
    expect(pick?.text).toBe(shownOfMember(CT_KABINE, "Yeni Şafak"));
  });

  it("605765b8: the repaired seed ends at a sentence, so it is no stub any more and stays", () => {
    const raw = rawOfMember(CT_FAKIBABA, "A Haber");
    const shown = tidySummaryText(raw);
    expect(isCtaFeedCut(raw)).toBe(true);
    expect(shown.endsWith("A Haber ekranlarından yanıt verdi.")).toBe(true);
    expect(seedDisqualified(raw, shown)).toBeNull();
    expect(pickFor(CT_FAKIBABA_TITLE, CT_FAKIBABA, "A Haber")).toBeNull();
  });

  it("7fd1bd19: a single-member cluster keeps its cut seed, which now ends in one '…'", () => {
    const raw = rawOfMember(CT_MAHIROGLU, "Sabah");
    const shown = tidySummaryText(raw);
    expect(shown.endsWith("Cafer Mahiroğlu'na yönelik rüşvet…")).toBe(true);
    expect(seedDisqualified(raw, shown)).toBe("stub");
    expect(pickFor(CT_MAHIROGLU_TITLE, CT_MAHIROGLU, "Sabah")).toBeNull();
  });

  it("a candidate that is a CTA feed cut ending in '…' is a 'stub' for summaryDefect (it already was)", () => {
    const raw = rawOfMember(CT_KABINE, "A Haber");
    expect(summaryDefect(raw, tidySummaryText(raw))).toBe("stub");
  });

  it("a CTA feed cut whose repair ends at a sentence is not a stub, and a seed with a CTA after a sentence mark is untouched", () => {
    const raw = "Bakan Yılmaz yeni düzenlemeyi bugün Ankara'da düzenlediği basın toplantısıyla kamuoyuna duyurdu ve uygulama takvimini açıkladı. Düzenleme kapsamında kurumlara yeni görevler ver...Devamı için tıklayınız";
    expect(isCtaFeedCut(raw)).toBe(true);
    expect(seedDisqualified(raw, tidySummaryText(raw))).toBeNull();
    const plain = "Bakan Yılmaz yeni düzenlemeyi bugün Ankara'da düzenlediği basın toplantısıyla kamuoyuna duyurdu ve uygulama takvimini açıkladı. Devamı için tıklayınız";
    expect(seedDisqualified(plain, tidySummaryText(plain))).toBeNull();
  });
});

describe("seedDisqualified: a clamp cut that hides the quotation behind a ':' (h122-ozet-3)", () => {
  it("837fa770: the shown text ends on a full stop, yet the seed is a 'stub'", () => {
    const raw = rawOfMember(CT_DURAN, "Milliyet");
    const shown = tidySummaryText(raw);
    expect(shown.endsWith("ilişkin paylaşımda bulundu.")).toBe(true);
    expect(clampCutIntroducedQuote(raw)).toBe(true);
    expect(seedDisqualified(raw, shown)).toBe("stub");
  });

  it("837fa770: the seed scores 0.40 (0.50 with its old '...şunları kaydetti…' cut), four outlets score 1.00, and the newest stands in", () => {
    const seedShown = shownOfMember(CT_DURAN, "Milliyet");
    expect(titleAgreement(CT_DURAN_TITLE, seedShown)).toBeCloseTo(0.4, 9);
    for (const name of ["Diriliş Postası", "Haber Global", "Elips Haber", "TRT Haber"]) {
      expect(titleAgreement(CT_DURAN_TITLE, shownOfMember(CT_DURAN, name)), name).toBe(1);
    }
    // Diriliş Postası, Haber Global and Elips Haber hold one text (credited to the earliest); TRT Haber's differs by "dedi".
    const pick = pickFor(CT_DURAN_TITLE, CT_DURAN, "Milliyet");
    expect(pick?.member.source.name).toBe("TRT Haber");
    expect(pick?.text).toBe(shownOfMember(CT_DURAN, "TRT Haber"));
    const withoutTrt = CT_DURAN.filter((m) => m.source.name !== "TRT Haber");
    expect(pickFor(CT_DURAN_TITLE, withoutTrt, "Milliyet")?.member.source.name).toBe("Diriliş Postası");
  });

  it("837fa770: Haberler.com's quotation-only text (0.80) never stands in", () => {
    const raw = rawOfMember(CT_DURAN, "Haberler.com");
    expect(summaryDefect(raw, tidySummaryText(raw))).toBe("quote-only");
    const onlyQuote = CT_DURAN.filter((m) => ["Milliyet", "Haberler.com"].includes(m.source.name));
    expect(pickFor(CT_DURAN_TITLE, onlyQuote, "Milliyet")).toBeNull();
  });

  it("98266829: the seed is a 'stub', but Posta holds the same text, so the seed is kept with its sentence-end cut", () => {
    const raw = rawOfMember(CT_YAYMAN, "Milliyet");
    const shown = tidySummaryText(raw);
    expect(shown.endsWith("bu noktaya geldiğini söyledi.")).toBe(true);
    expect(seedDisqualified(raw, shown)).toBe("stub");
    expect(tidySummaryText(rawOfMember(CT_YAYMAN, "Posta"))).toBe(shown);
    expect(pickFor(CT_YAYMAN_TITLE, CT_YAYMAN, "Milliyet")).toBeNull();
  });

  it("a clamp cut behind a comma (no colon) is no 'introduced quote': a kept sentence end is a clean seed, as before", () => {
    // Four whole sentences (78% of the text), then a quotation after "Yılmaz," that the clamp cut: the sentence end is kept.
    const sentence = "Bakan Yılmaz yeni düzenlemeyi bugün Ankara'da düzenlediği basın toplantısıyla kamuoyuna duyurdu. ";
    const raw = `${sentence.repeat(4)}Yılmaz, "${"çok önemli bir adım ".repeat(20)}`.slice(0, 497) + "...";
    expect(raw).toHaveLength(500);
    expect(clampCutIntroducedQuote(raw)).toBe(false);
    const shown = tidySummaryText(raw);
    expect(shown.endsWith("kamuoyuna duyurdu.")).toBe(true);
    expect(seedDisqualified(raw, shown)).toBeNull();
  });

  it("the same clamp with a colon in front of the opener hides the quotation: a 'stub' although the shown text ends on a full stop", () => {
    const sentence = "Bakan Yılmaz yeni düzenlemeyi bugün Ankara'da düzenlediği basın toplantısıyla kamuoyuna duyurdu. ";
    const raw = `${sentence.repeat(1)}Yılmaz, şunları söyledi: "${"çok önemli bir adım ".repeat(30)}`.slice(0, 497) + "...";
    expect(raw).toHaveLength(500);
    expect(clampCutIntroducedQuote(raw)).toBe(true);
    const shown = tidySummaryText(raw);
    expect(shown).toBe("Bakan Yılmaz yeni düzenlemeyi bugün Ankara'da düzenlediği basın toplantısıyla kamuoyuna duyurdu.");
    expect(seedDisqualified(raw, shown)).toBe("stub");
  });

  it("the order: a stub is decided before unbalanced quotes", () => {
    const raw = rawOfMember(CT_DURAN, "Milliyet");
    expect(seedDisqualified(raw, "“Bakan Yılmaz konuştu.")).toBe("stub");
  });
});

// ---------------------------------------------------------------------------
// h132-ozetpost-1 (hunt 132, 2026-11-11): two gaps in the Özet seed rules.
//
// (a) A digit-bearing NAME ("COP31 Başkanı ...") made the digit test of `isLiveLine` fail, so
//     Star's "... Antalya'da \"COP31 Liderler Zirvesi\"nde konuşuyor" (ece7ef31, 6 sources) was
//     not a live line and stayed the Özet. A name token (a capital letter, up to 10 letters, an
//     optional hyphen, 1 to 4 digits, not glued to a letter or digit in front or a digit behind:
//     COP31, G20, F-16, Covid-19) is blanked out before the digit test, as a year and an ordinal
//     are. A figure ("yüzde 30", "58 bin", "17 işçinin") is not a name and still fails the line.
// (b) A feed-cut stub that covers almost none of the headline (78d3a0ee: Sözcü's "... Aile ...",
//     score 0.0) was replaced only by a member from AGREEMENT_FORM_DEFECT_MIN (0.6) up, and the
//     clean member scored 0.56. Behind such a stub (below AGREEMENT_STUB_LOW_SEED, exclusive)
//     the floor is AGREEMENT_LOW (0.5); every other form defect and every stub that covers the
//     headline at 0.3 or more keeps 0.6.
//
// The texts are the real outlet texts of the live clusters (dumped read-only 2026-11-11).
// ---------------------------------------------------------------------------

const H132_STAR_ECE = 'COP31 Başkanı ve Çevre, Şehircilik ve İklim Değişikliği Bakanı Murat Kurum, Antalya\'da "COP31 Liderler Zirvesi"nde konuşuyor';
const H132_AKSAM_ECE = "COP31 Başkanı ve Çevre, Şehircilik ve İklim Değişikliği Bakanı Murat Kurum, Antalya'da “COP31 Liderler Zirvesi”nde konuşuyor.";
const H132_HABER7_NTV = "COP31 Başkanı ve Çevre, Şehircilik ve İklim Değişikliği Bakanı Murat Kurum, NTV canlı yayınında soruları yanıtlıyor.";
const H132_ILKE_HABAS = "DEM Parti Eş Genel Başkanı Tülay Hatimoğulları, yaşanan patlamada 17 işçinin yaşamını yitirdiği HABAŞ önünde açıklama yapıyor.";

describe("isLiveLine: a name that carries a digit is not a figure (h132-ozetpost-1)", () => {
  it.each([
    ["ece7ef31, Star (no closing mark)", H132_STAR_ECE],
    ["ece7ef31, Akşam (closing full stop)", H132_AKSAM_ECE],
    ["9dd62dcd, Haber7", H132_HABER7_NTV],
    ["G20", "Bakan Kurum, G20 toplantısında konuşuyor."],
    ["a hyphen in front of the digits: F-16", "Bakan Yılmaz, F-16 teslimatı için soruları yanıtlıyor."],
    ["Covid-19", "Sağlık Bakanı Koca, Covid-19 toplantısında açıklama yapıyor."],
    ["a case suffix behind the name", "Bakan Kurum, COP31'de konuşuyor."],
    ["the name opens the line", "COP31 Başkanı Kurum konuşuyor."],
    ["a name of 11 letters is the longest", "Bakan Kurum, Abcdefghijk7 toplantısında konuşuyor."],
    ["a name of one letter and four digits", "Bakan Kurum, F1234 toplantısında konuşuyor."],
  ])("is true for %s", (_label, text) => {
    expect(isLiveLine(text)).toBe(true);
  });

  it.each([
    ["a figure behind 'yüzde'", "Bakan, yüzde 30 enflasyon hedefini açıklarken konuşuyor."],
    ["a figure in front of a noun", "Bakan, 58 bin konut için konuşuyor."],
    ["a figure in front of a plural noun (7abb902e, İlke TV)", H132_ILKE_HABAS],
    ["a name does not excuse a figure next to it", "Bakan Kurum, COP31 için yüzde 30 oranında konuşuyor."],
    ["a name does not excuse a figure of its own", "Bakan Kurum, COP31 kapsamında 58 bin konut için konuşuyor."],
    ["five digits are a number, not a name", "Bakan Kurum, G20202 toplantısında konuşuyor."],
    ["12 letters in front of the digits is not a name", "Bakan Kurum, Abcdefghijkl7 toplantısında konuşuyor."],
    ["a long word with digits is not a name", "Bakan Kurum, Cumhurbaşkanlığı31 toplantısında konuşuyor."],
    ["a lower-case word with digits is not a name", "Bakan Kurum, cop31 toplantısında konuşuyor."],
    ["a blank between the letters and the digits is not a name token", "Bakan Kurum, COP 31 toplantısında konuşuyor."],
    ["a second digit group: only the first is a name", "Bakan Kurum, A1B2 toplantısında konuşuyor."],
    ["a digit in front of the capital", "Bakan Kurum, 3COP toplantısında konuşuyor."],
    ["a name in a line that is not a live line", "Bakan Kurum, COP31 Başkanı olarak konuştu."],
    ["a name in a line with a second sentence", "Bakan Kurum, COP31 toplantısında konuşuyor. Yeni paketi duyurdu."],
    ["a name in a line with a question mark", "Bakan Kurum COP31 için neden konuşuyor?"],
    ["a name in a line with a colon", "Bakan Kurum, COP31 toplantısında konuşuyor: iklim paketi geliyor."],
  ])("is false for %s", (_label, text) => {
    expect(isLiveLine(text)).toBe(false);
  });

  it("the existing pins are untouched: a year, an ordinal and a quoted event name still do not make a line a figure", () => {
    expect(isLiveLine("Cumhurbaşkanı Erdoğan, TRT World Forum 2026 Resmi Açılış Töreni'nde açıklamalarda bulunuyor.")).toBe(true);
    expect(
      isLiveLine('Cumhurbaşkanı Erdoğan, İstanbul\'da "12. Türk Tıp Dünyası Kurultayı ve TÜSEB Aziz Sancar Bilim, Hizmet ve Teşvik Ödülleri Töreni"nde konuşuyor.'),
    ).toBe(true);
    expect(isLiveLine("Bakan Yılmaz, yüzde 30 oranında açıklama yapıyor.")).toBe(false);
  });

  it("a digit-bearing name at the 160-character limit is decided (inclusive), one character more is refused", () => {
    const tail = " konuşuyor.";
    const head = "Bakan Kurum, COP31";
    const filler = (n: number): string => ` ${"a".repeat(n - 1)}`;
    const at160 = head + filler(160 - head.length - tail.length) + tail;
    expect(at160).toHaveLength(160);
    expect(isLiveLine(at160)).toBe(true);
    const at161 = head + filler(161 - head.length - tail.length) + tail;
    expect(at161).toHaveLength(161);
    expect(isLiveLine(at161)).toBe(false);
  });

  it("a line of nothing but digit-bearing names inside the limit is no live line and ends at once", () => {
    for (const unit of ["A1", "A-1", "COP31 ", "A1B2C3", "Aaaaaaaaaaaa1"]) {
      expect(isLiveLine(unit.repeat(Math.ceil(160 / unit.length)).slice(0, 160))).toBe(false);
    }
  });

  it("stays linear on a 100k-character hostile text, through isLiveLine and through the two callers that reach it", () => {
    const gens: Array<[string, Gen]> = [
      ["names", rep("COP31 ", "", " konuşuyor.")],
      ["hyphenated names", rep("F-16 ", "", " konuşuyor.")],
      ["a long letter run and digits", rep("Aaaaaaaaaaaaaaaaaaaa1", "", " konuşuyor.")],
      ["a long digit run", rep("A12345678", "", " konuşuyor.")],
      ["capitals, hyphens and digits", rep("A-1-", "", " konuşuyor.")],
    ];
    for (const [label, gen] of gens) {
      expect(() => expectLinear(gen, (s) => isLiveLine(s), { n: 100_000, ceilingMs: 2_000 }), `isLiveLine, ${label}`).not.toThrow();
      expect(() => expectLinear(gen, (s) => summaryDefect(s, s), { n: 100_000, ceilingMs: 4_000 }), `summaryDefect, ${label}`).not.toThrow();
      expect(() => expectLinear(gen, (s) => seedDisqualified(s, s), { n: 100_000, ceilingMs: 4_000 }), `seedDisqualified, ${label}`).not.toThrow();
    }
  });
});

describe("a live line with a digit-bearing name is a defect of a seed and of a candidate (h132-ozetpost-1)", () => {
  it("ece7ef31: seedDisqualified says 'live' for Star's text", () => {
    expect(seedDisqualified(H132_STAR_ECE, H132_STAR_ECE)).toBe("live");
  });

  it("ece7ef31: summaryDefect says 'live' for Akşam's text, so it never stands in for the seed", () => {
    expect(summaryDefect(H132_AKSAM_ECE, H132_AKSAM_ECE)).toBe("live");
    expect(seedDisqualified(H132_AKSAM_ECE, H132_AKSAM_ECE)).toBe("live");
  });

  it("9dd62dcd: Haber7's NTV line is 'live' as a seed and as a candidate", () => {
    expect(seedDisqualified(H132_HABER7_NTV, H132_HABER7_NTV)).toBe("live");
    expect(summaryDefect(H132_HABER7_NTV, H132_HABER7_NTV)).toBe("live");
  });

  it("7abb902e: İlke TV's line with '17 işçinin' is a sentence of the outlet's, not a defect", () => {
    expect(summaryDefect(H132_ILKE_HABAS, H132_ILKE_HABAS)).toBeNull();
    expect(seedDisqualified(H132_ILKE_HABAS, H132_ILKE_HABAS)).toBeNull();
  });

  it("the same sentence in the past tense, with the same name, is a report and not a defect", () => {
    const done = "COP31 Başkanı ve Çevre, Şehircilik ve İklim Değişikliği Bakanı Murat Kurum, Antalya'da “COP31 Liderler Zirvesi”nde konuştu.";
    expect(summaryDefect(done, done)).toBeNull();
    expect(seedDisqualified(done, done)).toBeNull();
  });
});

describe("findAgreeingMember: a stub seed that covers almost none of the headline (h132-ozetpost-1)", () => {
  const WORDS = ["abaka", "bobin", "cidem", "dalka", "ekmek", "fidan", "gazoz", "havuz", "irmak", "jeton"];
  const TITLE10 = WORDS.join(" ");
  // The fixtures start with a capital letter: an all-lower-case text of 25 letters or more is a 'case' defect
  // since h164-summaries-2, and these cases are about the other defects. The title stems are unchanged by it.
  const cap = (text: string): string => text.charAt(0).toLocaleUpperCase("tr") + text.slice(1);
  /** A complete sentence that carries the first `hits` title words and nothing else of the title. */
  const clean = (hits: number, salt = ""): string =>
    cap(`${WORDS.slice(0, hits).join(" ")} hakkında şehir genelinde yeni gelişmeler yaşandığı ve uzmanların açıklama yaptığı bildirildi${salt}.`.trim());
  /** A feed cut that carries the first `hits` title words: no verb in its last sentence, so a stub. */
  const stub = (hits: number): string => cap(`${WORDS.slice(0, hits).join(" ")} hakkında şehir genelinde yeni gelişmelerin ayrıntıları…`.trim());
  /** A live line (no digit, one sentence) that carries the first `hits` title words. */
  const live = (hits: number): string => `Bakan ${WORDS.slice(0, hits).join(" ")} toplantısında konuşuyor.`;
  /** Unbalanced quotes: one “ against no ”. */
  const quotes = (hits: number): string => cap(`${WORDS.slice(0, hits).join(" ")} hakkında “şehir genelinde yeni gelişmeler yaşandığı bildirildi.`.trim());

  const AT = (n: number): string => `2026-11-11T10:${String(n).padStart(2, "0")}:00Z`;
  const seedOf = (text: string): SummaryMember => mem("Tohum", "outlet", AT(0), text, "tohum");
  const candidateOf = (text: string, name = "Aday"): SummaryMember => mem(name, "outlet", AT(5), text, `${name} başlığı`);
  const pick = (seed: SummaryMember, others: SummaryMember[]) =>
    findAgreeingMember({
      members: [...others, seed],
      seed,
      seedShown: tidySummaryText((seed.article.description ?? "").trim()),
      title: TITLE10,
      wireMajorityHashes: new Set<string>(),
    });

  it("the fixtures score and classify as the cases below assume", () => {
    for (let hits = 0; hits <= 10; hits++) {
      expect(titleAgreement(TITLE10, clean(hits)), `clean(${hits})`).toBeCloseTo(hits / 10, 9);
      expect(titleAgreement(TITLE10, stub(hits)), `stub(${hits})`).toBeCloseTo(hits / 10, 9);
      expect(summaryDefect(clean(hits), clean(hits)), `clean(${hits})`).toBeNull();
      expect(seedDisqualified(stub(hits), stub(hits)), `stub(${hits})`).toBe("stub");
    }
    expect(titleAgreement(TITLE10, live(2))).toBeCloseTo(0.2, 9);
    expect(seedDisqualified(live(2), live(2))).toBe("live");
    expect(titleAgreement(TITLE10, quotes(0))).toBe(0);
    expect(seedDisqualified(quotes(0), quotes(0))).toBe("quotes");
  });

  it("a stub seed under AGREEMENT_STUB_LOW_SEED is replaced from AGREEMENT_LOW up: 0.5 (inclusive), not 0.4", () => {
    for (const seedHits of [0, 1, 2]) {
      const seed = seedOf(stub(seedHits));
      expect(pick(seed, [candidateOf(clean(5))])?.member.source.name, `seed ${seedHits}/10, candidate 0.5`).toBe("Aday");
      expect(pick(seed, [candidateOf(clean(6))])?.member.source.name, `seed ${seedHits}/10, candidate 0.6`).toBe("Aday");
      expect(pick(seed, [candidateOf(clean(4))]), `seed ${seedHits}/10, candidate 0.4`).toBeNull();
      expect(pick(seed, [candidateOf(clean(0))]), `seed ${seedHits}/10, candidate 0`).toBeNull();
    }
  });

  it("a stub seed at exactly AGREEMENT_STUB_LOW_SEED (3/10) or above keeps the 0.6 floor", () => {
    for (const seedHits of [3, 4]) {
      const seed = seedOf(stub(seedHits));
      expect(pick(seed, [candidateOf(clean(5))]), `seed ${seedHits}/10, candidate 0.5`).toBeNull();
      expect(pick(seed, [candidateOf(clean(6))])?.member.source.name, `seed ${seedHits}/10, candidate 0.6`).toBe("Aday");
    }
  });

  it("the best of the qualifiers still wins, and a tie goes to the newest", () => {
    const seed = seedOf(stub(0));
    const five = candidateOf(clean(5), "Beş");
    const seven = mem("Yedi", "outlet", AT(4), clean(7), "yedi");
    const sevenLate = mem("Yedi Geç", "outlet", AT(9), clean(7, " (geç)"), "yedi geç");
    expect(pick(seed, [five, seven])?.member.source.name).toBe("Yedi");
    expect(pick(seed, [five, seven, sevenLate])?.member.source.name).toBe("Yedi Geç");
    expect(pick(seed, [five])?.member.source.name).toBe("Beş");
  });

  it("the other form defects keep 0.6 whatever the seed scores: quotes at 0, a live line at 0.2", () => {
    for (const [label, text] of [
      ["quotes", quotes(0)],
      ["live", live(2)],
    ] as const) {
      const seed = seedOf(text);
      expect(pick(seed, [candidateOf(clean(5))]), `${label}, candidate 0.5`).toBeNull();
      expect(pick(seed, [candidateOf(clean(6))])?.member.source.name, `${label}, candidate 0.6`).toBe("Aday");
    }
  });

  it("a clean seed that disagrees keeps 0.75, and a clean seed at 0.5 or more is never replaced", () => {
    const poor = seedOf(clean(2, " (tohum)"));
    expect(pick(poor, [candidateOf(clean(5))])).toBeNull();
    expect(pick(poor, [candidateOf(clean(7))])).toBeNull();
    expect(pick(poor, [candidateOf(clean(8))])?.member.source.name).toBe("Aday");
    const fair = seedOf(clean(5, " (tohum)"));
    expect(pick(fair, [candidateOf(clean(10))])).toBeNull();
  });

  it("an opinion seed keeps 0.75: the lowered floor is for a stub only", () => {
    const column = seedOf(clean(0, " (köşe)"));
    column.article.url = "https://example.com/yazarlar/biri/yazi";
    expect(pick(column, [candidateOf(clean(5))])).toBeNull();
    expect(pick(column, [candidateOf(clean(8))])?.member.source.name).toBe("Aday");
  });

  describe("every other gate of a candidate is unchanged at the lower floor", () => {
    const seed = seedOf(stub(0));

    it("a candidate that is itself a stub, a live line or an echo is not picked", () => {
      expect(pick(seed, [candidateOf(stub(5))])).toBeNull();
      expect(pick(seed, [candidateOf(live(5))])).toBeNull();
      const echo = mem("Yankı", "outlet", AT(5), clean(5), clean(5).replace(/\.$/, ""));
      expect(pick(seed, [echo])).toBeNull();
    });

    it("a wire or an aggregator member is not picked", () => {
      expect(pick(seed, [mem("Ajans", "wire", AT(5), clean(5), "ajans")])).toBeNull();
      expect(pick(seed, [mem("Toplayıcı", "aggregator", AT(5), clean(5), "toplayıcı")])).toBeNull();
    });

    it("a near copy of a wire member's text is the agency's and is not picked", () => {
      const wire = mem("Ajans", "wire", AT(1), clean(5), "ajans");
      expect(pick(seed, [wire, candidateOf(clean(5, " bugün"))])).toBeNull();
    });

    it("a member whose source does not allow excerpts is not picked (BL-13)", () => {
      const blocked = candidateOf(clean(5));
      blocked.source.excerpt_allowed = false;
      expect(pick(seed, [blocked])).toBeNull();
    });

    it("an opinion column is not picked", () => {
      const column = candidateOf(clean(5));
      column.article.url = "https://example.com/yazarlar/biri/yazi";
      expect(pick(seed, [column])).toBeNull();
    });

    it("a text under 60 characters is not picked", () => {
      const short = candidateOf("abaka bobin cidem dalka ekmek yazdı.");
      expect(short.article.description?.length ?? 0).toBeLessThan(AGREEMENT_MIN_CHARS);
      expect(pick(seed, [short])).toBeNull();
    });

    it("a title with no signal (under 3 content tokens) keeps the seed", () => {
      const seed2 = seedOf(stub(0));
      const out = findAgreeingMember({
        members: [candidateOf(clean(5)), seed2],
        seed: seed2,
        seedShown: tidySummaryText((seed2.article.description ?? "").trim()),
        title: "abaka bobin",
        wireMajorityHashes: new Set<string>(),
      });
      expect(out).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// h164-summaries-1 / h164-summaries-2 (2026-11-12): the 'lead-in' and 'case' defects of a seed.
// The raw rows are the members' descriptions dumped read-only from prod
// (tests/fixtures/summary-tail-h164.json).
// ---------------------------------------------------------------------------

type TailMember = { source: string; title: string; description: string };
type TailCluster = { id: string; title: string; members: TailMember[] };
const TAIL = (tailFixtures as { clusters: Record<string, TailCluster> }).clusters;

/** The raw description of `source` in the fixture cluster `short` (the 8-character id prefix). */
function tailRaw(short: string, source: string): string {
  const member = TAIL[short]?.members.find((m) => m.source === source);
  if (member === undefined) throw new Error(`no fixture member ${short} / ${source}`);
  return member.description;
}

describe("seedDisqualified: 'lead-in' (h164-summaries-1)", () => {
  const KEEP40 = "Ab cd ef Ab cd ef Ab cd ef Ab cd ef Abc.";
  const SIXTY = "Bakan Yılmaz yeni vergi düzenlemesini bugün Ankara'da açıkladı.";

  it("the back-off emptied the text: 'lead-in' (226929aa, one sentence that ends in a colon)", () => {
    const raw = tailRaw("226929aa", "Haber.com");
    expect(tidySummaryText(raw)).toBe("");
    expect(seedDisqualified(raw, "")).toBe("lead-in");
  });

  it("the back-off kept fewer than 60 characters: 'lead-in'", () => {
    const raw = `${KEEP40} Şunlar açıklandı:`;
    const shown = tidySummaryText(raw);
    expect(shown).toBe(KEEP40);
    expect(seedDisqualified(raw, shown)).toBe("lead-in");
  });

  it("the back-off kept 60 characters or more: the shown text is clean again", () => {
    expect(SIXTY.length).toBeGreaterThanOrEqual(60);
    const raw = `${SIXTY} Şunlar değişti:`;
    const shown = tidySummaryText(raw);
    expect(shown).toBe(SIXTY);
    expect(seedDisqualified(raw, shown)).toBeNull();
    const c44 = tailRaw("c44095e2", "Hürriyet");
    expect(seedDisqualified(c44, tidySummaryText(c44))).toBeNull();
  });

  it("a ';' lead-in counts too, closing quotes aside", () => {
    const raw = `${KEEP40} Bakan şöyle konuştu: “Hedefimiz açık;”`;
    expect(seedDisqualified(raw, tidySummaryText(raw))).toBe("lead-in");
  });

  it("a teaser that ends in a colon stays 'teaser': the verdict reads the text before the back-off", () => {
    const iste = "İşte Erdoğan'ın açıklamalarından öne çıkan satır başları:";
    expect(tidySummaryText(iste)).toBe("");
    expect(seedDisqualified(iste, tidySummaryText(iste))).toBe("teaser");
  });

  it("a text that does not end in a lead-in, and a shown text that is not the raw text's, are not 'lead-in'", () => {
    expect(seedDisqualified(SIXTY, SIXTY)).toBeNull();
    expect(seedDisqualified("Bakanlar şunlar: Yılmaz, Demir ve Kaya toplantıya katıldı.", "Kısa metin.")).toBeNull();
  });

  it("never throws on a non-string", () => {
    expect(seedDisqualified(null as unknown as string, "x")).toBeNull();
    expect(seedDisqualified("x:", undefined as unknown as string)).toBeNull();
  });
});

describe("findAgreeingMember: a 'lead-in' seed is replaced by a clean member (h164-summaries-1)", () => {
  const TITLE = "Bakan Yılmaz yeni vergi düzenlemesini açıkladı";
  const SEED_RAW = "Bakan Yılmaz yeni vergi düzenlemesini açıkladı. Şunlar değişti:";
  const CLEAN = "Bakan Yılmaz, yeni vergi düzenlemesinin ayrıntılarını bugün düzenlediği basın toplantısında kamuoyuyla paylaştı.";

  it("the seed's own text covers the whole headline, yet its form lets a 0.6 member replace it", () => {
    expect(tidySummaryText(SEED_RAW)).toBe("Bakan Yılmaz yeni vergi düzenlemesini açıkladı.");
    const seed = mem("Tohum", "outlet", "2026-11-12T10:00:00Z", SEED_RAW, "Başlık");
    const clean = mem("Temiz", "outlet", "2026-11-12T10:05:00Z", CLEAN, "Başka başlık");
    const pick = pickFor(TITLE, [seed, clean], "Tohum");
    expect(pick?.member.source.name).toBe("Temiz");
    expect(pick?.text).toBe(CLEAN);
  });

  it("the same seed without the lead-in is kept: it agrees with the headline and is well formed", () => {
    const seed = mem("Tohum", "outlet", "2026-11-12T10:00:00Z", "Bakan Yılmaz yeni vergi düzenlemesini bugün Ankara'da açıkladı.", "Başlık");
    const clean = mem("Temiz", "outlet", "2026-11-12T10:05:00Z", CLEAN, "Başka başlık");
    expect(pickFor(TITLE, [seed, clean], "Tohum")).toBeNull();
  });

  it("a member that covers less than the form floor (0.6) does not replace it", () => {
    const seed = mem("Tohum", "outlet", "2026-11-12T10:00:00Z", SEED_RAW, "Başlık");
    const weak = mem("Zayıf", "outlet", "2026-11-12T10:05:00Z", "Hava bugün parçalı bulutlu ve rüzgarlı geçecek, sıcaklıklar mevsim normallerinde seyredecek.", "Başka başlık");
    expect(pickFor(TITLE, [seed, weak], "Tohum")).toBeNull();
  });

  it("a text that the back-off emptied is replaced through summaryAttribution too (it is not hidden before the swap)", () => {
    const raw = tailRaw("226929aa", "Haber.com");
    const title = "Bakan Şimşek Dezenflasyonu Destekleyecek 4 Temel Unsuru Açıkladı";
    const seed = mem("Haber.com", "outlet", "2026-11-12T10:00:00Z", raw, "Bakan Şimşek Dezenflasyonu Destekleyecek 4 Temel Unsuru Açıkladı");
    const clean = mem(
      "Temiz",
      "outlet",
      "2026-11-12T10:05:00Z",
      "Bakan Şimşek, dezenflasyonu destekleyecek dört temel unsuru açıkladı ve önümüzdeki dönemde fiyat istikrarının sürdürüleceğini söyledi.",
      "Başka başlık",
    );
    const wire = { isWireRedistribution: false };
    const swapped = summaryAttribution({ summary: raw, members: [seed, clean], wire, agreeWithTitle: title });
    expect(swapped?.source?.name).toBe("Temiz");
    // Without a member that agrees the Özet is hidden, and without the title agreement it is hidden too.
    expect(summaryAttribution({ summary: raw, members: [seed], wire, agreeWithTitle: title })).toBeNull();
    expect(summaryAttribution({ summary: raw, members: [seed, clean], wire })).toBeNull();
  });

  it("a teaser that ends in a colon is still replaced by a clean member (the swap the teaser verdict always gave)", () => {
    const raw = "İşte Bakan Yılmaz'ın vergi düzenlemesine ilişkin açıklamalarından öne çıkan satır başları:";
    const seed = mem("Tohum", "outlet", "2026-11-12T10:00:00Z", raw, "Başlık");
    const clean = mem("Temiz", "outlet", "2026-11-12T10:05:00Z", CLEAN, "Başka başlık");
    const swapped = summaryAttribution({
      summary: raw,
      members: [seed, clean],
      wire: { isWireRedistribution: false },
      agreeWithTitle: TITLE,
    });
    expect(swapped?.source?.name).toBe("Temiz");
  });
});

describe("437c0d7e (11 sources): the Milliyet seed 'satır başları şöyle;' is a lead-in with nothing to back off to (h164-summaries-1)", () => {
  const CLUSTER = TAIL["437c0d7e"]!;
  const toMember = (m: TailMember & { kind: string; published_at: string }): SummaryMember =>
    mem(m.source, m.kind as SourceKind, m.published_at, m.description, m.title);
  const MEMBERS = (CLUSTER.members as Array<TailMember & { kind: string; published_at: string }>).map(toMember);
  const wire = { isWireRedistribution: false };

  it("the seed is 'lead-in', and only an aggregator covers the headline: the Özet is hidden, not the dangling line", () => {
    const seed = memberNamed(MEMBERS, "Milliyet");
    const raw = seed.article.description ?? "";
    expect(tidySummaryText(raw)).toBe("");
    expect(seedDisqualified(raw, "", { clusterTitle: CLUSTER.title })).toBe("lead-in");
    expect(summaryAttribution({ summary: raw, members: MEMBERS, wire, agreeWithTitle: CLUSTER.title })).toBeNull();
  });

  it("a member that covers the headline from the form floor (0.6) up takes it over", () => {
    const seed = memberNamed(MEMBERS, "Milliyet");
    const clean = mem(
      "Temiz",
      "outlet",
      "2026-11-10T09:00:00Z",
      "Cumhurbaşkanı Erdoğan, iç cephemizi yeni hamlelerle daha da tahkim ediyoruz diyerek önümüzdeki dönemin yol haritasını açıkladı.",
      "Başka başlık",
    );
    const shown = summaryAttribution({
      summary: seed.article.description ?? "",
      members: [...MEMBERS, clean],
      wire,
      agreeWithTitle: CLUSTER.title,
    });
    expect(shown?.source?.name).toBe("Temiz");
  });
});

describe("isCaseGarbled / seedDisqualified: 'case' (h164-summaries-2)", () => {
  const A2260 = tailRaw("a2260dd6", "En Politik");
  const EA472 = tailRaw("ea472c81", "En Politik");

  it("a2260dd6 and ea472c81: U+0307 after an 'i' is 'case', before 'quote-only' and 'echo'", () => {
    expect(A2260).toContain("i\u0307");
    expect(EA472).toContain("i\u0307");
    expect(isCaseGarbled(A2260)).toBe(true);
    expect(isCaseGarbled(EA472)).toBe(true);
    expect(seedDisqualified(A2260, tidySummaryText(A2260))).toBe("case");
    expect(isQuoteOnly(tidySummaryText(EA472))).toBe(true);
    expect(seedDisqualified(EA472, tidySummaryText(EA472))).toBe("case");
    expect(
      seedDisqualified(EA472, tidySummaryText(EA472), { memberTitle: TAIL["ea472c81"]?.members[0]?.title, clusterTitle: "x" }),
    ).toBe("case");
  });

  it("25 or more lower-case letters, no upper-case letter and a lower-case start is 'case' (En Politik's title in lower case)", () => {
    for (const text of [
      "emine erdoğan: atık krizi aynı zamanda bir zihniyet ve kültür krizidir",
      "cumhurbaşkanı erdoğan: sivil anayasayı milletimize kazandırmak istiyoruz",
      "“bahçeli’den muhalefete: kimse yanlış hesap yapmasın!”",
    ]) {
      expect(isCaseGarbled(text), text).toBe(true);
      expect(seedDisqualified(text, text), text).toBe("case");
    }
  });

  it("the boundary is 25 lower-case letters", () => {
    expect(isCaseGarbled("abcde fghij klmno pqrst uvwxy")).toBe(true); // 25
    expect(isCaseGarbled("abcde fghij klmno pqrst uvwx")).toBe(false); // 24
  });

  it("a normal mixed-case text and an all-caps acronym line are not 'case'", () => {
    for (const text of [
      "Bakan Yılmaz, yeni vergi düzenlemesini bugün Ankara'da açıkladı.",
      "Bakan Yılmaz yeni düzenlemeyi açıkladı ve iPhone satışlarına ilişkin kararı duyurdu.",
      "TBMM NATO ABD THY ASELSAN BIST",
      "AA - ANKARA HABER MERKEZİ",
      "",
    ]) {
      expect(isCaseGarbled(text), text).toBe(false);
      expect(seedDisqualified(text, text), text).toBeNull();
    }
  });

  it("a text that starts with a digit is a sentence, not a lower-cased headline (when unsure, keep)", () => {
    // c7931eb3 (İşçi Haber) and 5aaadcc2: real sentences that happen to hold no capital letter.
    for (const text of [
      "14 yıl boyunca kayıplara karışan firari hükümlü, emekli maaşını çektiği yerden tespit edilerek yakalandı.",
      "2026-2027 eğitim öğretim yılı için belirlenen ara tatil tarihleri, öğrencilerin merak ettiği konular arasında yer alıyor.",
    ]) {
      expect(isCaseGarbled(text), text).toBe(false);
    }
  });

  it("a text in a script without case is not 'case' (no lower-case letters to count)", () => {
    expect(isCaseGarbled("هذا نص طويل بما يكفي للاختبار هنا وهو بدون حروف كبيرة")).toBe(false);
    expect(isCaseGarbled("これは大文字のない十分に長い日本語のテキストです。それはテストのために使用されます。")).toBe(false);
  });

  it("U+0307 elsewhere than after an 'i' does not count on its own", () => {
    expect(isCaseGarbled("Bakan Yılmaz, yeni düzenlemeyi aç\u0307ıkladı.")).toBe(false);
  });

  it("is linear: lower-case words with a trailing capital, and the same text lower-cased, are judged in one pass", () => {
    expect(isCaseGarbled(`${"kelime ".repeat(1000)}Sonuç`)).toBe(false);
    expect(isCaseGarbled("kelime ".repeat(1000))).toBe(true);
    const gen = rep("kelime ", "", "Sonuç");
    expectLinear(gen, (s) => isCaseGarbled(s), { n: 100_000, ceilingMs: 1_000 });
    expectLinear(rep("kelime "), (s) => isCaseGarbled(s), { n: 100_000, ceilingMs: 1_000 });
  });

  it("never throws on a non-string", () => {
    expect(isCaseGarbled(null as unknown as string)).toBe(false);
    expect(isCaseGarbled(undefined as unknown as string)).toBe(false);
  });

  describe("replacement and hiding", () => {
    const TITLE = "ÖZDAĞ: “HİJYENDEN TASARRUF EDİLEMEZ!\"";
    const CLEAN =
      "Selçuk Özdağ, okullarda hijyenden tasarruf edilemeyeceğini söyleyerek bakanlığa seslendi ve gerekli önlemlerin hemen alınmasını istedi.";
    const wire = { isWireRedistribution: false };

    it("a2260dd6 (1 member): the Özet is hidden", () => {
      const seed = mem("En Politik", "outlet", "2026-11-12T10:00:00Z", A2260, TITLE);
      expect(summaryAttribution({ summary: A2260, members: [seed], wire, agreeWithTitle: TITLE })).toBeNull();
      expect(summaryAttribution({ summary: A2260, members: [seed], wire })).toBeNull();
      expect(summaryAttributionWithoutMembers({ summary: A2260, wire })).toBeNull();
    });

    it("ea472c81 (1 member): the Özet is hidden", () => {
      const title = "SELÇUK ÖZDAĞ’DAN TBMM’DE MEKKE ANLAŞMASINA SERT TEPKİ";
      const seed = mem("En Politik", "outlet", "2026-11-12T10:00:00Z", EA472, title);
      expect(summaryAttribution({ summary: EA472, members: [seed], wire, agreeWithTitle: title })).toBeNull();
    });

    it("a multi-member cluster: a clean member is swapped in", () => {
      const seed = mem("En Politik", "outlet", "2026-11-12T10:00:00Z", A2260, TITLE);
      const clean = mem("Temiz", "outlet", "2026-11-12T10:05:00Z", CLEAN, "Başka başlık");
      const pick = pickFor(TITLE, [seed, clean], "En Politik");
      expect(pick?.member.source.name).toBe("Temiz");
      expect(pick?.text).toBe(CLEAN);
      const shown = summaryAttribution({ summary: A2260, members: [seed, clean], wire, agreeWithTitle: TITLE });
      expect(shown?.text).toBe(CLEAN);
    });

    it("a multi-member cluster without a clean member: the Özet is hidden, not the garbled text", () => {
      const seed = mem("En Politik", "outlet", "2026-11-12T10:00:00Z", A2260, TITLE);
      const other = mem("Başka", "outlet", "2026-11-12T10:05:00Z", "Hava bugün parçalı bulutlu ve rüzgarlı geçecek, sıcaklıklar mevsim normallerinde seyredecek.", "Başlık");
      expect(summaryAttribution({ summary: A2260, members: [seed, other], wire, agreeWithTitle: TITLE })).toBeNull();
    });

    it("a member that is garbled never stands in for the seed, whatever it scores", () => {
      const seed = mem("Tohum", "outlet", "2026-11-12T10:00:00Z", "Hava bugün parçalı bulutlu ve rüzgarlı geçecek, sıcaklıklar mevsim normallerinde seyredecek.", "Başlık");
      const garbled = mem("En Politik", "outlet", "2026-11-12T10:05:00Z", "özdağ: hijyenden tasarruf edilemez; çocukların beslenmesi ertelenemez ve okul güvenliği ihmal edilemez!", "Başlık");
      expect(pickFor(TITLE, [seed, garbled], "Tohum")).toBeNull();
      const clean = mem("Temiz", "outlet", "2026-11-12T10:06:00Z", CLEAN, "Başka başlık");
      expect(pickFor(TITLE, [seed, garbled, clean], "Tohum")?.member.source.name).toBe("Temiz");
    });
  });
});

// ---------------------------------------------------------------------------
// h168-ozet-1: a seed that is a "coming soon" placeholder ("Ayrıntılar geliyor...") tidies to ""
// and used to hide the Özet even when other members had a clean sentence (41ebdae3, bb7e0804,
// df08098c). It is a form defect now, so a clean member replaces it. A placeholder or blank seed
// covers none of the headline, so the floor is AGREEMENT_LOW (the near-zero stub's), not 0.6/0.75.
// ---------------------------------------------------------------------------
describe("seedDisqualified: 'placeholder' (h168-ozet-1)", () => {
  const A72F =
    "Ayrıntılar geliyor...\n\n\n\nKKTC Başbakanı Üstel, KKTC ile ilgili açıklamaları için Cumhurbaşkanı Erdoğan'a teşekkür etti";
  const PLACEHOLDERS = [
    "Ayrıntılar geliyor...",
    "ayrıntılar geliyor...",
    "Detaylar gelecek…",
    "DETAYLAR GELİYOR",
    "Ayrıntılar birazdan...\nKaynak: TRT Haber",
    A72F,
  ];

  it("a placeholder that tidies to nothing is 'placeholder' (41ebdae3's Milliyet seed)", () => {
    expect(tidySummaryText("Ayrıntılar geliyor...")).toBe("");
    expect(seedDisqualified("Ayrıntılar geliyor...", "")).toBe("placeholder");
  });

  it.each(PLACEHOLDERS)("%j is 'placeholder' once the tidy step has emptied it", (raw) => {
    const shown = tidySummaryText(raw);
    expect(shown).toBe("");
    expect(seedDisqualified(raw, shown)).toBe("placeholder");
  });

  it("only an EMPTY shown text can be 'placeholder': the verdict of every non-empty shown text is unchanged", () => {
    // The same raw text with something shown (a caller that tidied it differently): no placeholder verdict.
    expect(seedDisqualified("Ayrıntılar geliyor...", "Bakan Yılmaz yeni vergi düzenlemesini açıkladı.")).toBeNull();
    expect(seedDisqualified(A72F, "Bakan Yılmaz yeni vergi düzenlemesini açıkladı.")).toBeNull();
    // A real sentence that merely starts with the phrase is shown whole and is not a placeholder.
    const sentence = "Ayrıntılar geliyor: Bakan Yılmaz yeni vergi düzenlemesini açıkladı ve gelecek ay yürürlüğe girecek.";
    expect(seedDisqualified(sentence, tidySummaryText(sentence))).toBeNull();
    // The earlier verdicts keep their place: a cut stub is still 'stub', a lead-in still 'lead-in'.
    const cut = "CHP’den istifa ederek Yeni Parti’ye katılan iki meclis üyesinin ayrı oturma düzeni talebi, Silivri Belediye Meclisi’nin ...";
    expect(seedDisqualified(cut, cut)).toBe("stub");
    const leadIn = "Bakan Yılmaz yeni vergi düzenlemesini açıkladı. Şunlar değişti:";
    expect(seedDisqualified(leadIn, tidySummaryText(leadIn))).toBe("lead-in");
    const emptied = "Cumhurbaşkanı Erdoğan'ın açıklamalarından öne çıkan satır başları şöyle;";
    expect(seedDisqualified(emptied, "")).toBe("lead-in");
  });

  it("a blank or whitespace-only raw text is not a placeholder (there is nothing to recognise)", () => {
    expect(seedDisqualified("", "")).toBeNull();
    expect(seedDisqualified("  ", "")).toBeNull();
    expect(seedDisqualified("\n", "")).toBeNull();
  });

  it("never throws on a non-string", () => {
    expect(seedDisqualified(null as unknown as string, "")).toBeNull();
    expect(seedDisqualified("Ayrıntılar geliyor...", undefined as unknown as string)).toBeNull();
  });
});

describe("findAgreeingMember: a placeholder or blank seed is replaced by a member that covers half the headline (h168-ozet-1)", () => {
  // 41ebdae3: six content stems (izmir, habas, demir, celik, fabri, patla).
  const TITLE = "İzmir'de Habaş Demir Çelik Fabrikası'nda patlama";
  const HALF = "İzmir'in Aliağa ilçesinde HABAŞ'a ait karbondioksit dolum tesisinde patlama meydana geldi.";
  const THIRD = "İzmir'in Aliağa ilçesinde bir karbondioksit dolum tesisinde patlama meydana geldi ve ekipler sevk edildi.";

  it("the seed is 'placeholder' and Sözcü's sentence (3 of 6 stems, 0.5) replaces it: the floor is AGREEMENT_LOW, not 0.6", () => {
    const seed = mem("Milliyet", "outlet", "2026-11-09T09:33:58Z", "Ayrıntılar geliyor...", "Başlık");
    const sozcu = mem("Sözcü", "outlet", "2026-11-09T09:35:17Z", HALF, "Başka başlık");
    expect(titleAgreement(TITLE, tidySummaryText(HALF))).toBeCloseTo(0.5, 9);
    expect(AGREEMENT_LOW).toBeLessThan(AGREEMENT_FORM_DEFECT_MIN);
    const pick = pickFor(TITLE, [seed, sozcu], "Milliyet");
    expect(pick?.member.source.name).toBe("Sözcü");
    expect(pick?.text).toBe(HALF);
  });

  it("a member under the floor (2 of 6 stems) does not replace it, and with none the result is null", () => {
    const seed = mem("Milliyet", "outlet", "2026-11-09T09:33:58Z", "Ayrıntılar geliyor...", "Başlık");
    const weak = mem("Sözcü", "outlet", "2026-11-09T09:35:17Z", THIRD, "Başka başlık");
    expect(titleAgreement(TITLE, tidySummaryText(THIRD))).toBeLessThan(AGREEMENT_LOW);
    expect(pickFor(TITLE, [seed, weak], "Milliyet")).toBeNull();
    expect(pickFor(TITLE, [seed], "Milliyet")).toBeNull();
  });

  it("another outlet's placeholder is never the pick, and neither is a text under the length floor", () => {
    const seed = mem("Milliyet", "outlet", "2026-11-09T09:33:58Z", "Ayrıntılar geliyor...", "Başlık");
    const other = mem("Hürriyet", "outlet", "2026-11-09T09:34:00Z", "Ayrıntılar geliyor...", "Başlık 2");
    const short = mem("Kısa", "outlet", "2026-11-09T09:34:30Z", "İzmir'de HABAŞ'ta patlama.", "Başlık 3");
    expect(pickFor(TITLE, [seed, other, short], "Milliyet")).toBeNull();
  });

  it("the rest of the candidate rules still apply: a wire, an aggregator and a rights-blocked member are skipped", () => {
    const seed = mem("Milliyet", "outlet", "2026-11-09T09:33:58Z", "Ayrıntılar geliyor...", "Başlık");
    const wire = mem("AA", "wire", "2026-11-09T09:35:00Z", HALF, "Başka başlık");
    const aggregator = mem("Haberler.com", "aggregator", "2026-11-09T09:36:00Z", `${HALF} Ekipler bölgede.`, "Başka başlık");
    const blocked = mem("Engelli", "outlet", "2026-11-09T09:37:00Z", `${HALF} Çalışmalar sürüyor.`, "Başka başlık");
    blocked.source.excerpt_allowed = false;
    expect(pickFor(TITLE, [seed, wire, aggregator, blocked], "Milliyet")).toBeNull();
  });

  it("a blank seed (nothing shown, no defect) takes the same floor", () => {
    const seed = mem("AA", "wire", "2026-11-11T14:22:44Z", "", "Başlık");
    const sozcu = mem("Sözcü", "outlet", "2026-11-11T14:30:00Z", HALF, "Başka başlık");
    const pick = findAgreeingMember({
      members: [seed, sozcu],
      seed,
      seedShown: "",
      title: TITLE,
      wireMajorityHashes: new Set<string>(),
    });
    expect(pick?.member.source.name).toBe("Sözcü");
    expect(pick?.text).toBe(HALF);
  });

  it("a clean seed that shows text keeps its floor: a 0.5 member does not replace a seed scoring 0", () => {
    const seed = mem("Tohum", "outlet", "2026-11-09T09:33:58Z", "Hava bugün parçalı bulutlu ve rüzgarlı geçecek, sıcaklıklar mevsim normallerinde seyredecek.", "Başlık");
    const sozcu = mem("Sözcü", "outlet", "2026-11-09T09:35:17Z", HALF, "Başka başlık");
    expect(pickFor(TITLE, [seed, sozcu], "Tohum")).toBeNull();
  });

  it("a lead-in seed keeps the 0.6 floor it always had", () => {
    const seed = mem("Tohum", "outlet", "2026-11-09T09:33:58Z", "Cumhurbaşkanı Erdoğan'ın açıklamalarından öne çıkan satır başları şöyle;", "Başlık");
    const sozcu = mem("Sözcü", "outlet", "2026-11-09T09:35:17Z", HALF, "Başka başlık");
    expect(seedDisqualified(seed.article.description ?? "", "")).toBe("lead-in");
    expect(pickFor(TITLE, [seed, sozcu], "Tohum")).toBeNull();
  });
});
