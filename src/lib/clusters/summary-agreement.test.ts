import { describe, it, expect } from "vitest";
import {
  AGENCY_COPY_OVERLAP,
  AGREEMENT_HIGH,
  AGREEMENT_LOW,
  AGREEMENT_MIN_CHARS,
  AGREEMENT_MIN_GAIN,
  AGREEMENT_MIN_TITLE_TOKENS,
  agreementSwitches,
  summaryDefect,
  textOverlap,
  titleAgreement,
} from "./summary-agreement";

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
