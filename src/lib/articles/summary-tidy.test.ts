import { describe, expect, it } from "vitest";

import { BOILERPLATE_PHRASES } from "./description-boilerplate";
import { tidySummaryText, WIDGET_HEADINGS } from "./summary-tidy";

// [input, expected] — every row is an exact `toBe`.
const CHANGES: ReadonlyArray<readonly [string, string]> = [
  // Glued sentences (stripTags dropped the block separator at ingest).
  ["hastaneye kaldırıldı.Yangın, Ortaköy", "hastaneye kaldırıldı. Yangın, Ortaköy"],
  ["başladı!Mayıs", "başladı! Mayıs"],
  ["dedi…Ancak", "dedi… Ancak"],
  // Trailing call-to-action: the dots stay, only the CTA goes.
  ["Aletli İniş Sistemi (ILS)...Devamı için tıklayınız", "Aletli İniş Sistemi (ILS)..."],
  ["Toplantı yapıldı. HABERİN DEVAMI İÇİN TIKLAYIN", "Toplantı yapıldı."],
  // A capitalised CTA after a plain space (no punctuation boundary).
  ["kişi yaralandı Devamı için tıklayınız", "kişi yaralandı"],
  ["Fire broke out. Read more »", "Fire broke out."],
  // Widget heading on its own line, then newline collapsing.
  ["belirtti.\nİlginizi Çekebilir\nToplantıya", "belirtti. Toplantıya"],
  ["a\n\n b", "a b"],
  ["x\r\ny", "x y"],
];

// Must come back byte-identical.
const UNCHANGED: readonly string[] = [
  "T.C. Ziraat Bankası",
  "A.Ş. açıkladı",
  "3.5 puan",
  "tayfhaber.com adresinde",
  "Dr. Ahmet",
  "U.S. Army said",
  // Lower-case English CTA with no boundary: ordinary prose, not a tail.
  "experts want to read more",
  // The phrase is only a prefix of a longer word, so it is not a tail.
  "Devamı için tıklayınca açılan sayfa",
];

// Whole-string CTAs: nothing left, the caller then hides the summary.
const ONLY_CTA: readonly string[] = [
  "Devamı için tıklayınız",
  "  Read more ›  ",
  "Devamını oku. Devamını oku",
];

describe("tidySummaryText", () => {
  it.each(CHANGES)("rewrites %j -> %j", (input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it.each(UNCHANGED)("leaves %j untouched", (input) => {
    expect(tidySummaryText(input)).toBe(input);
  });

  it.each(ONLY_CTA)("returns an empty string for the CTA-only input %j", (input) => {
    expect(tidySummaryText(input)).toBe("");
  });

  it("is idempotent on every fixture", () => {
    const all = [
      ...CHANGES.map(([input]) => input),
      ...CHANGES.map(([, expected]) => expected),
      ...UNCHANGED,
      ...ONLY_CTA,
    ];
    for (const x of all) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once), JSON.stringify(x)).toBe(once);
    }
  });

  describe("widget heading lines", () => {
    it("exports the headings pre-folded (tr-TR lower case, no trailing colon)", () => {
      expect(WIDGET_HEADINGS.has("ilginizi çekebilir")).toBe(true);
      expect(WIDGET_HEADINGS.has("ilgili haberler")).toBe(true);
      expect(WIDGET_HEADINGS.has("bunlar da ilginizi çekebilir")).toBe(true);
      for (const h of WIDGET_HEADINGS) {
        expect(h, h).toBe(h.toLocaleLowerCase("tr-TR"));
        expect(h, h).toBe(h.trim());
        expect(h.endsWith(":"), h).toBe(false);
      }
    });

    it.each([
      ["İLGİLİ HABERLER", "Maç bitti.\nİLGİLİ HABERLER\nTakım kutladı.", "Maç bitti. Takım kutladı."],
      ["ilgili haberler:", "Maç bitti.\nilgili haberler:\nTakım kutladı.", "Maç bitti. Takım kutladı."],
      ["Bunlar da ilginizi çekebilir", "Maç bitti.\nBunlar da ilginizi çekebilir\nTakım kutladı.", "Maç bitti. Takım kutladı."],
      ["İlginizi Çekebilir : (space before colon)", "Maç bitti.\n  İlginizi Çekebilir :  \nTakım kutladı.", "Maç bitti. Takım kutladı."],
      ["ASCII upper-case form", "Maç bitti.\nILGILI HABERLER\nTakım kutladı.", "Maç bitti. Takım kutladı."],
      ["CRLF line endings", "Maç bitti.\r\nİlginizi Çekebilir\r\nTakım kutladı.", "Maç bitti. Takım kutladı."],
    ])("drops the heading line: %s", (_label, input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it("keeps a heading phrase that sits inside a longer line", () => {
      const s = "Bu haber ilginizi çekebilir diye paylaşıldı.";
      expect(tidySummaryText(s)).toBe(s);
      const t = "İlgili Haberler hakkında konuştu.";
      expect(tidySummaryText(t)).toBe(t);
    });

    it("returns an empty string when the whole summary is a widget heading", () => {
      expect(tidySummaryText("İlginizi Çekebilir")).toBe("");
    });
  });

  describe("trailing call-to-action", () => {
    it.each([
      ["Haber metni burada. Devamını oku", "Haber metni burada."],
      ["Haber metni burada. DEVAMINI OKU »", "Haber metni burada."],
      ["Haber metni burada… Devamı için tıklayın", "Haber metni burada…"],
      ["Haber metni burada. Haberin devamı için tıklayın...", "Haber metni burada."],
      ["Fire broke out. READ MORE ›", "Fire broke out."],
      ["Fire broke out. Continue reading", "Fire broke out."],
      ["Fire broke out. CONTINUE READING", "Fire broke out."],
      ["Fire broke out. Click here to continue >", "Fire broke out."],
      ["Fire broke out Click to continue", "Fire broke out"],
      // Quote / bracket boundaries count as punctuation.
      ["Dedi ki “hazırız” Devamını oku", "Dedi ki “hazırız”"],
      ["Dedi ki (hazırız)Devamını oku", "Dedi ki (hazırız)"],
    ])("strips the tail of %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it("does not strip a lower-case CTA that follows only a space", () => {
      expect(tidySummaryText("you can read more")).toBe("you can read more");
      expect(tidySummaryText("daha fazlası için devamını oku")).toBe(
        "daha fazlası için devamını oku",
      );
    });

    it("does strip a lower-case CTA that follows sentence punctuation", () => {
      expect(tidySummaryText("Haber metni burada. devamını oku")).toBe("Haber metni burada.");
    });

    it("does not strip a CTA phrase that is followed by more text", () => {
      expect(tidySummaryText("Devamını oku ve yorum yap")).toBe("Devamını oku ve yorum yap");
      expect(tidySummaryText("Read more about the fire.")).toBe("Read more about the fire.");
    });

    it("strips stacked CTAs until a fixed point", () => {
      expect(tidySummaryText("Haber. Devamını oku. Devamını oku")).toBe("Haber.");
      expect(tidySummaryText("Haber. Read more » Devamını oku")).toBe("Haber.");
    });

    it("strips at most five CTAs and then stops (bounded loop)", () => {
      const five = Array.from({ length: 5 }, () => "Devamını oku.").join(" ");
      expect(tidySummaryText(five)).toBe("");
      const eight = Array.from({ length: 8 }, () => "Devamını oku.").join(" ");
      expect(tidySummaryText(eight)).toBe("Devamını oku. Devamını oku. Devamını oku.");
    });

    it("every phrase in the shared boilerplate set is stripped as a tail", () => {
      for (const phrase of BOILERPLATE_PHRASES) {
        const cta = phrase.charAt(0).toLocaleUpperCase("tr-TR") + phrase.slice(1);
        expect(tidySummaryText(`Haber metni. ${cta}`), phrase).toBe("Haber metni.");
        expect(tidySummaryText(`Haber metni ${cta}`), phrase).toBe("Haber metni");
        expect(tidySummaryText(cta), phrase).toBe("");
      }
    });

    it("keeps working when a dotted capital İ elsewhere changes the length of the plain fold", () => {
      // "İ".toLowerCase() is two code units, so the plain fold is skipped and
      // the tr-TR fold has to do the matching.
      expect(tidySummaryText("İSTANBUL’da yangın. Devamı için tıklayınız")).toBe(
        "İSTANBUL’da yangın.",
      );
    });
  });

  describe("glued sentences", () => {
    it.each([
      ["Nasıl?Hangisi", "Nasıl? Hangisi"],
      ["Çıktı.Şimdi, İstanbul’da", "Çıktı. Şimdi, İstanbul’da"],
      ["bitti.Ömer geldi.Ayşe de", "bitti. Ömer geldi. Ayşe de"],
      ["🔥 Yangın!Büyük", "🔥 Yangın! Büyük"],
    ])("separates %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it("does not touch abbreviations, decimals or domains", () => {
      for (const s of [
        "T.C. Cumhurbaşkanlığı",
        "A.Ş.’nin açıklaması",
        "1.500 kişi",
        "www.tayfhaber.com ve tayf.org",
        "U.S.Army",
      ]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });
  });

  describe("whitespace", () => {
    it("trims both ends", () => {
      expect(tidySummaryText("  merhaba dünya \n")).toBe("merhaba dünya");
    });

    it("collapses every whitespace run that contains a newline, and only those", () => {
      expect(tidySummaryText("bir  \n  iki\r\n\r\nüç\rdört")).toBe("bir iki üç dört");
      // A run of spaces with no newline is the feed's own spacing: left alone.
      expect(tidySummaryText("bir  iki")).toBe("bir  iki");
    });

    it("recognises a CTA whose words are separated by NBSP or double spaces", () => {
      expect(tidySummaryText("Haber metni. Devamını\u00a0oku")).toBe("Haber metni.");
      expect(tidySummaryText("Haber metni. Devamı  için   tıklayınız")).toBe("Haber metni.");
    });

    it("returns an empty string for empty and whitespace-only input", () => {
      expect(tidySummaryText("")).toBe("");
      expect(tidySummaryText("  \n\t\r\n ")).toBe("");
    });
  });

  describe("real stored summaries (clusters.summary_tr, 2026-11-02)", () => {
    it("Diyarbakır ILS: CTA tail after an ellipsis", () => {
      expect(
        tidySummaryText(
          "Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, Diyarbakır Havalimanı’nda ana pistin bakım ve onarım nedeniyle kapatılmasının ardından hizmete alınan paralel piste yeni Aletli İniş Sistemi (ILS)...Devamı için tıklayınız",
        ),
      ).toBe(
        "Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, Diyarbakır Havalimanı’nda ana pistin bakım ve onarım nedeniyle kapatılmasının ardından hizmete alınan paralel piste yeni Aletli İniş Sistemi (ILS)...",
      );
    });

    it("Ortaköy yangın: glued sentence, trailing stored ellipsis kept", () => {
      expect(
        tidySummaryText(
          "Çorum’un Ortaköy ilçesinde çıkan yangında bir ev kullanılamaz hale gelirken, dumandan etkilenen 2 kişi hastaneye kaldırıldı.Yangın, Ortaköy ilçesine b...",
        ),
      ).toBe(
        "Çorum’un Ortaköy ilçesinde çıkan yangında bir ev kullanılamaz hale gelirken, dumandan etkilenen 2 kişi hastaneye kaldırıldı. Yangın, Ortaköy ilçesine b...",
      );
    });

    it("okullar tatil mi: glued sentence after a closing curly quote sentence", () => {
      expect(
        tidySummaryText(
          "4 Mayıs Pazartesi günü için öğrenciler ve veliler, “Yarın okullar tatil mi?” sorusuna yanıt aramaya başladı.Mayıs ayına girilmesiyle birlikte ara tatil ve resmi tatil tarihleri yeniden gündeme gelirken, gözler Milli Eğitim Bakanlığı’nın 2026 eğitim öğretim yılı için yayımladığı çalışma takvimine çevrildi.",
        ),
      ).toBe(
        "4 Mayıs Pazartesi günü için öğrenciler ve veliler, “Yarın okullar tatil mi?” sorusuna yanıt aramaya başladı. Mayıs ayına girilmesiyle birlikte ara tatil ve resmi tatil tarihleri yeniden gündeme gelirken, gözler Milli Eğitim Bakanlığı’nın 2026 eğitim öğretim yılı için yayımladığı çalışma takvimine çevrildi.",
      );
    });

    it("Güvenlik Toplantısı: widget heading line between two sentences", () => {
      expect(
        tidySummaryText(
          "Bakan Çiftçi, sosyal medya hesabından yaptığı açıklamada, İstanbul Emniyet Müdürlüğü'nde, yeni nesil suç örgütleriyle mücadelenin tüm yönleriyle ele alındığı Güvenlik Toplantısı gerçekleştirdiklerini belirtti.\nİlginizi Çekebilir\nToplantıya, İstanbul Valisi Davut Gül, İl Emniyet Müdürü Selami Yıldız katıldı.",
        ),
      ).toBe(
        "Bakan Çiftçi, sosyal medya hesabından yaptığı açıklamada, İstanbul Emniyet Müdürlüğü'nde, yeni nesil suç örgütleriyle mücadelenin tüm yönleriyle ele alındığı Güvenlik Toplantısı gerçekleştirdiklerini belirtti. Toplantıya, İstanbul Valisi Davut Gül, İl Emniyet Müdürü Selami Yıldız katıldı.",
      );
    });
  });

  describe("robustness", () => {
    it("handles a large input in linear-ish time (no regex blow-up)", () => {
      const prose = "Yangın çıktı, ekipler müdahale etti. ".repeat(3000); // ~111k chars
      const inputs = [
        `${prose}Devamı için tıklayınız`,
        "a" + " ".repeat(60_000) + "x",
        ". " + " ".repeat(60_000) + "x",
        "a ".repeat(50_000),
        `${prose}\n`.repeat(20),
        ".".repeat(60_000),
        "a" + " ".repeat(60_000) + "\n" + " ".repeat(60_000) + "x",
        "a" + "\t".repeat(60_000) + "x",
        "a." + " ".repeat(60_000) + "Devamını oku",
        "Devamını oku. ".repeat(10_000),
        "İlginizi Çekebilir\n".repeat(20_000) + "x",
      ];
      const start = performance.now();
      for (const s of inputs) tidySummaryText(s);
      expect(performance.now() - start).toBeLessThan(1500);
      expect(tidySummaryText(`${prose}Devamı için tıklayınız`)).toBe(prose.trim());
    });

    it("never throws on odd Unicode (lone surrogates, combining marks, emoji, RTL)", () => {
      for (const s of ["\ud83d", "é.Ab", "😀.😀", "שלום.עולם", "\u0000​", "ı.İ", "İ.I"]) {
        expect(() => tidySummaryText(s), JSON.stringify(s)).not.toThrow();
      }
    });

    it("is a pure function: same input, same output", () => {
      const s = "Yangın çıktı.Ekipler geldi. Devamı için tıklayınız";
      expect(tidySummaryText(s)).toBe(tidySummaryText(s));
      expect(tidySummaryText(s)).toBe("Yangın çıktı. Ekipler geldi.");
    });
  });
});
