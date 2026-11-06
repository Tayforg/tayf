import { describe, it, expect } from "vitest";
import {
  AGENCY_COPY_OVERLAP,
  AGREEMENT_HIGH,
  AGREEMENT_LOW,
  AGREEMENT_MIN_CHARS,
  AGREEMENT_MIN_GAIN,
  AGREEMENT_MIN_TITLE_TOKENS,
  agreementSwitches,
  carriesOutcome,
  contentWords,
  hasFiniteVerb,
  seedDisqualified,
  sharedStemsExcluding,
  stageBehindTitle,
  stemsOf,
  summaryDefect,
  textOverlap,
  titleAgreement,
  titleStemOverlap,
} from "./summary-agreement";
import { tidySummaryText } from "@/lib/articles/summary-tidy";

describe("thresholds (h31-reader-3 v2)", () => {
  it("are the documented values", () => {
    expect(AGREEMENT_LOW).toBe(0.5);
    expect(AGREEMENT_HIGH).toBe(0.75);
    expect(AGREEMENT_MIN_GAIN).toBe(0.3);
    expect(AGREEMENT_MIN_TITLE_TOKENS).toBe(3);
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
    const text = `${Array.from({ length: 100_000 }, (_, i) => `kelime${i}`).join(" ")} yaptı.`;
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
