import { describe, expect, it } from "vitest";

import { BOILERPLATE_PHRASES, TRAILING_CTA_PHRASES } from "./description-boilerplate";
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

    it("every phrase in the shared boilerplate sets is stripped as a tail", () => {
      for (const phrase of [...BOILERPLATE_PHRASES, ...TRAILING_CTA_PHRASES]) {
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

    it("collapses every whitespace run to one space, newline or not (h22-editorial-2)", () => {
      expect(tidySummaryText("bir  \n  iki\r\n\r\nüç\rdört")).toBe("bir iki üç dört");
      // A run of spaces with no newline used to be left alone; it left
      // "geçirilecek. …" in the meta description (c2a97d0a).
      expect(tidySummaryText("bir  iki")).toBe("bir iki");
      expect(tidySummaryText("bir\u00a0\u00a0iki\t\tüç \u2003dört")).toBe("bir iki üç dört");
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

// ---------------------------------------------------------------------------
// h19-ingest-2 (hunt 19, 2026-11-02): Diken and Serbestiyet feed wrappers.
//
// Diken ships "<title> dd.mm.yyyy Diken<body>\nThe post <title> appeared first
// on #site_linkat dd.mm.yyyy ." and Serbestiyet ships "<body>\n<title> yazısı
// ilk önce Serbestiyet adresinde yayınlanmıştır.". Both were shown as the story
// summary. tidySummaryText strips them at read time (step 1b, the shared
// stripFeedWrappers); the stored description is untouched.
//
// The fixtures below are real rows (read-only SELECT on 2026-11-02): a3be851f
// and dab0eb01 (Diken), a6a2f0bd and 9cab88ae (Serbestiyet).
// ---------------------------------------------------------------------------

const DIKEN_A3BE =
  "ABD'de özel bir jet otoyola düştü 02.11.2026 DikenABD'nin Florida eyaletinde dokuz kişiyi taşıyan özel jet otoyola düştü.\nThe post ABD'de özel bir jet otoyola düştü appeared first on #site_linkat 02.11.2026 .";
const DIKEN_A3BE_BODY = "ABD'nin Florida eyaletinde dokuz kişiyi taşıyan özel jet otoyola düştü.";

const DIKEN_DAB0 =
  "Üç il için şiddetli yağış uyarısı 31.10.2026 Dikenİzmir, Aydın ve Muğla'da şiddetli yağış bekleniyor.\nThe post Üç il için şiddetli yağış uyarısı appeared first on #site_linkat 31.10.2026 .";
const DIKEN_DAB0_BODY = "İzmir, Aydın ve Muğla'da şiddetli yağış bekleniyor.";

// The footer sits on its own line, after a trailing blank on the body line.
const SERBESTIYET_A6A2 =
  "Fon soruşturmasında şüpheli sıfatıyla ifade veren Takasbank Genel Müdürü Yunus Arıncı, yurt dışına çıkış yasağı ve adli kontrol şartıyla serbest bırakıldıktan sonra görevinden istifa etti. \nTakasbank Genel Müdürü, fon soruşturmasında şüpheli olarak ifade verip istifa etti: Meclis’te Tera’ya finansmanı savunmuştu yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
const SERBESTIYET_A6A2_BODY =
  "Fon soruşturmasında şüpheli sıfatıyla ifade veren Takasbank Genel Müdürü Yunus Arıncı, yurt dışına çıkış yasağı ve adli kontrol şartıyla serbest bırakıldıktan sonra görevinden istifa etti.";

// The title carries a colon and curly quotes.
const SERBESTIYET_9CAB =
  "DEM Parti İmralı Heyeti Üyesi Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi'ndeki yeni bir bölüme kalıcı olarak geçtiğini açıkladı\nPervin Buldan: “Öcalan yeni yerine taşındı ama bu ona statü kazandırmıyor, süreçte tıkanma var” yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.";
const SERBESTIYET_9CAB_BODY =
  "DEM Parti İmralı Heyeti Üyesi Pervin Buldan, Abdullah Öcalan’ın İmralı Cezaevi'ndeki yeni bir bölüme kalıcı olarak geçtiğini açıkladı";

const WRAPPER_CHANGES: ReadonlyArray<readonly [string, string, string]> = [
  ["Diken a3be851f (header + footer)", DIKEN_A3BE, DIKEN_A3BE_BODY],
  ["Diken dab0eb01 (header + footer)", DIKEN_DAB0, DIKEN_DAB0_BODY],
  ["Serbestiyet a6a2f0bd", SERBESTIYET_A6A2, SERBESTIYET_A6A2_BODY],
  ["Serbestiyet 9cab88ae", SERBESTIYET_9CAB, SERBESTIYET_9CAB_BODY],
  [
    "Serbestiyet footer after a sentence mark, no newline",
    "Gövde metni. Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.",
    "Gövde metni.",
  ],
  [
    "Serbestiyet footer without the final dot",
    "Gövde metni.\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır",
    "Gövde metni.",
  ],
  [
    "Serbestiyet footer with trailing blanks",
    "Gövde metni.\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.  \n ",
    "Gövde metni.",
  ],
  [
    "Serbestiyet footer after an exclamation mark and an ellipsis",
    "Gövde metni! İkinci cümle… Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.",
    "Gövde metni! İkinci cümle…",
  ],
  [
    "WordPress footer only (header-less)",
    "Gövde metni.\nThe post Başlık appeared first on Site Adı.",
    "Gövde metni.",
  ],
  [
    "WordPress footer glued to the body (tags were stripped to nothing)",
    "Gövde metni.The post Başlık appeared first on Site Adı.",
    "Gövde metni.",
  ],
  [
    "Diken header only (footer missing)",
    "Başlık metni 31.10.2026 DikenGövde metni burada.",
    "Gövde metni burada.",
  ],
  [
    "Diken header, body starts with a capital Turkish letter (İ, Ü)",
    "Başlık 01.11.2026 DikenÜlke genelinde yağış var.",
    "Ülke genelinde yağış var.",
  ],
  [
    "Diken header, a space after the word Diken",
    "Başlık 01.11.2026 Diken Gövde metni.",
    "Gövde metni.",
  ],
  [
    "footer and then a stacked CTA tail on the body",
    "Gövde metni. Devamını oku\nThe post Başlık appeared first on Site Adı.",
    "Gövde metni.",
  ],
];

// Wrapper-shaped text that must NOT be stripped. The expected value is what the
// older tidy steps make of it (a newline becomes one space), nothing more.
const WRAPPER_UNCHANGED: ReadonlyArray<readonly [string, string, string]> = [
  [
    "'The post-election' (a hyphen, not a space)",
    "The post-election period was long",
    "The post-election period was long",
  ],
  [
    "a mid-text 'ilk önce'",
    "Gazete ilk önce haberi duyurdu, sonra yalanladı.",
    "Gazete ilk önce haberi duyurdu, sonra yalanladı.",
  ],
  [
    "'yazısı ilk önce' mid-text, no 'adresinde yayınlanmıştır' tail",
    "Kitabın yazısı ilk önce Meclis'te okundu, sonra basıldı.",
    "Kitabın yazısı ilk önce Meclis'te okundu, sonra basıldı.",
  ],
  [
    "a Serbestiyet footer followed by more text",
    "Gövde.\nBaşlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır. Devamı burada.",
    "Gövde. Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır. Devamı burada.",
  ],
  [
    "a truncated Serbestiyet footer (the feed cut the description)",
    "Gövde metni.\nÇakma Japon kuruluş fon vurguncularına nasıl bol keseden not dağıttı? yazısı ilk önce Serbestiyet ad...",
    "Gövde metni. Çakma Japon kuruluş fon vurguncularına nasıl bol keseden not dağıttı? yazısı ilk önce Serbestiyet ad...",
  ],
  [
    "'Dikenli' is not 'Diken'",
    "Sınırda tel örgü 02.11.2026 Dikenli teller çekildi.",
    "Sınırda tel örgü 02.11.2026 Dikenli teller çekildi.",
  ],
  [
    "a date and 'Diken' at the very start (no header title)",
    "02.11.2026 DikenGövde metni.",
    "02.11.2026 DikenGövde metni.",
  ],
  [
    "a date followed by 'Diken' deep in a long text",
    `${"Uzun gövde metni burada. ".repeat(20)}Başlık 02.11.2026 DikenGövde metni.`,
    `${"Uzun gövde metni burada. ".repeat(20)}Başlık 02.11.2026 DikenGövde metni.`,
  ],
  [
    "a long title before the footer and no boundary within 300 characters",
    `${"x".repeat(400)} yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.`,
    `${"x".repeat(400)} yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.`,
  ],
];

describe("tidySummaryText feed wrappers (h19-ingest-2)", () => {
  it("a3be851f: the exact stored Diken text gives only the body", () => {
    expect(tidySummaryText(DIKEN_A3BE)).toBe(
      "ABD'nin Florida eyaletinde dokuz kişiyi taşıyan özel jet otoyola düştü.",
    );
  });

  it.each(WRAPPER_CHANGES)("strips the wrappers: %s", (_label, input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it("the stripped result carries none of the wrapper tokens", () => {
    for (const input of [DIKEN_A3BE, DIKEN_DAB0, SERBESTIYET_A6A2, SERBESTIYET_9CAB]) {
      const out = tidySummaryText(input);
      for (const token of ["The post", "appeared", "#site_link", " Diken", "ilk önce", "yayınlanmıştır"]) {
        expect(out.includes(token), `${token} in ${JSON.stringify(out)}`).toBe(false);
      }
    }
  });

  it.each(WRAPPER_UNCHANGED)("leaves %s alone", (_label, input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it("a header-shaped text on a later line is not a header (the first line owns the header)", () => {
    // Not in the idempotence list on purpose: the newline collapse turns this
    // into a one-line text, and a second tidy would then treat it as a header.
    expect(tidySummaryText("Birinci satır.\nBaşlık 02.11.2026 DikenGövde metni.")).toBe(
      "Birinci satır. Başlık 02.11.2026 DikenGövde metni.",
    );
  });

  it("a text that is only a footer gives an empty string (the caller hides the summary)", () => {
    expect(tidySummaryText("Başlık yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.")).toBe("");
    expect(tidySummaryText("The post Başlık appeared first on #site_linkat 02.11.2026 .")).toBe("");
    expect(tidySummaryText("\nThe post Başlık appeared first on Site Adı.")).toBe("");
  });

  it("is idempotent on every wrapper fixture and on its result", () => {
    const all = [
      ...WRAPPER_CHANGES.map(([, input]) => input),
      ...WRAPPER_CHANGES.map(([, , expected]) => expected),
      ...WRAPPER_UNCHANGED.map(([, input]) => input),
      ...WRAPPER_UNCHANGED.map(([, , expected]) => expected),
    ];
    for (const x of all) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once), JSON.stringify(x)).toBe(once);
    }
  });

  it("does not change what the tidy steps did before: the widget and glue rules still apply around a footer", () => {
    expect(
      tidySummaryText("Maç bitti.Takım kutladı.\nİlginizi Çekebilir\nSon düdük.\nThe post Başlık appeared first on Site Adı."),
    ).toBe("Maç bitti. Takım kutladı. Son düdük.");
  });

  describe("robustness", () => {
    const BUDGET_MS = 100;

    it("a 100k-character 'The post ' input with space runs finishes in under 100 ms", () => {
      const inputs = [
        "The post ".repeat(11_200),
        `${"The post ".repeat(5_000)}${" ".repeat(55_000)}appeared first on`,
        `${"The post x".repeat(5_000)} appeared first on ${" ".repeat(50_000)}`,
        `The post ${" ".repeat(100_000)} appeared first on x`,
        `${" ".repeat(50_000)}The post ${" ".repeat(50_000)}`,
      ];
      for (const s of inputs) {
        const start = performance.now();
        tidySummaryText(s);
        const elapsed = performance.now() - start;
        expect(elapsed, `${s.length} chars`).toBeLessThan(BUDGET_MS);
      }
    });

    it("100k characters of the Serbestiyet and Diken markers finish in under 100 ms", () => {
      const inputs = [
        " yazısı ilk önce ".repeat(6_000),
        `${" yazısı ilk önce x adresinde yayınlanmıştır".repeat(2_500)}`,
        `x yazısı ilk önce ${" ".repeat(100_000)} adresinde yayınlanmıştır.`,
        "01.01.2026 Diken ".repeat(6_000),
        `${" ".repeat(100_000)}01.01.2026 Diken`,
        `\n${"a".repeat(100_000)} yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.`,
        `${"a. ".repeat(33_000)} yazısı ilk önce Serbestiyet adresinde yayınlanmıştır.`,
      ];
      for (const s of inputs) {
        const start = performance.now();
        tidySummaryText(s);
        const elapsed = performance.now() - start;
        expect(elapsed, `${s.length} chars`).toBeLessThan(BUDGET_MS);
      }
    });
  });
});

// h20-live-4 (hunt 20, 2026-11-02): WordPress ends an excerpt with " [&hellip;]".
// on-haber had it on 174 of 177 descriptions in 48 h; cluster c2a97d0a showed
// "... Bu çalışmaların ardından […]". stripFeedWrappers() (step 1b) now turns a
// trailing marker into one "…".
describe("tidySummaryText trailing WordPress excerpt marker (h20-live-4)", () => {
  const C2A9_BODY =
    "... Bakan Uraloğlu, ilk olarak mevcut demiryolu hattının elektrikli ve sinyalli hale getirileceğini açıkladı. Bu çalışmaların ardından";
  // Real on-haber description (article 49a6d622, read-only SELECT on 2026-11-02).
  const ON_HABER_BODY =
    "HBO’nun en güzel dönem dizilerinden birinin dördüncü sezonu bugün gösterime giriyor. “The Gilded Age” adlı dizi, adındaki gibi Amerikan kapitalizminin ve özellikle New York’un “Yaldızlı Çağ”ını anlatıyor. Geçen salı günü iki saatimi geçirdiğim binanın üzerinde, işte o dizide anlatılan dönemin en önemli isimlerinden biri yazıyor: “J.P. Morgan…” Bankanın kurucusu… Dizide doğrudan adı geçmiyor. Ama Amerika’da";
  const MARKERS = ["[…]", "[...]", "[&#8230;]", "[&hellip;]"] as const;

  it("the c2a97d0a sample ends with 'ardından…' and never with '[…]'", () => {
    const out = tidySummaryText(`${C2A9_BODY} […]`);
    expect(out).toBe(`${C2A9_BODY}…`);
    expect(out.endsWith("ardından…")).toBe(true);
    expect(out.endsWith("[…]")).toBe(false);
    expect(out).not.toContain("[…]");
  });

  it("the real on-haber sample ends with '…' and never with '[…]'", () => {
    const out = tidySummaryText(`${ON_HABER_BODY} […]`);
    expect(out).toBe(`${ON_HABER_BODY}…`);
    expect(out.endsWith("…")).toBe(true);
    expect(out.endsWith("[…]")).toBe(false);
  });

  it.each(MARKERS)("'%s' at the end of a summary becomes '…'", (marker) => {
    expect(tidySummaryText(`${C2A9_BODY} ${marker}`)).toBe(`${C2A9_BODY}…`);
    expect(tidySummaryText(`${C2A9_BODY}${marker}`)).toBe(`${C2A9_BODY}…`);
    expect(tidySummaryText(`${C2A9_BODY} ${marker}\n`)).toBe(`${C2A9_BODY}…`);
  });

  it("after a sentence mark the marker is dropped without a doubled mark", () => {
    expect(tidySummaryText("Toplantı bitti. […]")).toBe("Toplantı bitti.");
    expect(tidySummaryText("Toplantı bitti. [&hellip;]")).toBe("Toplantı bitti.");
  });

  it("a summary that is only the marker gives '' (the caller hides it)", () => {
    for (const marker of MARKERS) expect(tidySummaryText(marker)).toBe("");
  });

  it("a marker in the middle of a summary is left alone", () => {
    expect(tidySummaryText("Birinci […] ikinci cümle.")).toBe("Birinci […] ikinci cümle.");
  });

  it("composes with the other steps: widget line, newline collapse, footer and marker in one call", () => {
    expect(
      tidySummaryText(
        "Maç bitti.Takım kutladı, ardından […]\nİlginizi Çekebilir\nThe post Başlık appeared first on Site Adı.",
      ),
    ).toBe("Maç bitti. Takım kutladı, ardından…");
  });

  it("is idempotent on the new inputs and their results", () => {
    for (const marker of MARKERS) {
      for (const x of [
        `${C2A9_BODY} ${marker}`,
        `${ON_HABER_BODY} ${marker}`,
        `Toplantı bitti. ${marker}`,
        marker,
        `a ${marker} b`,
      ]) {
        const once = tidySummaryText(x);
        expect(tidySummaryText(once), JSON.stringify(x)).toBe(once);
      }
    }
  });

  it("a 100k-character input with a trailing marker finishes in under 100 ms", () => {
    const inputs = [
      `${"a. ".repeat(33_000)} […]`,
      `${" ".repeat(100_000)} […]`,
      `[…]${" ".repeat(100_000)}`,
      "[…] ".repeat(25_000),
    ];
    for (const s of inputs) {
      const start = performance.now();
      tidySummaryText(s);
      expect(performance.now() - start, `${s.length} chars`).toBeLessThan(100);
    }
  });
});

// ---------------------------------------------------------------------------
// h22-editorial-2 (hunt 22, 2026-11-02): four kinds of residue in a rendered
// summary. The ingest clamp (normalize.ts: 497 UTF-16 units + "...") cut
// c526f480 mid-word; "Son dakika |" tickers opened d8c49a89, 4433b6f7 and
// a81379a9; "Detaylar haberimizde..." / "İşte ayrıntılar..." closed f097fa3e
// and a65f404a; double spaces left "geçirilecek. …" in the meta description of
// c2a97d0a. The rows below are real (read-only SELECT on clusters.summary_tr).
// ---------------------------------------------------------------------------

const C526_CLAMPED =
  "Sağlık Bakanı Prof. Dr. Kemal Memişoğlu, Düzce'de yapımı tamamlanan 50 yataklı Akçakoca Devlet Hastanesi'nin açılış töreninde yaptığı açıklamada, \"Evde sağlık, uzaktan sağlık hizmetlerini birbirine entegre ederek yeni bir model oluşturuyoruz. Evde Sağlık Hizmetleri Koordinasyon Merkezi projemizi başlattık. Evde sağlık hizmeti alacak olan vatandaşlarımızın hizmete kolay ulaşmasını sağlayacağız. Hastanede tedavi gören hastalarımızın taburcu olduktan sonra evlerinde de tedaviye devam edecek şeki...";

const E5FD_CLAMPED =
  "Sanayi ve Teknoloji Bakanı Mehmet Fatih Kacır, 2027 Yılı Merkezi Yönetim Bütçe Kanunu Teklifi görüşmelerinin yapıldığı TBMM Plan ve Bütçe Komisyonu’na, millî otomobil Togg ile geldi.\nBakan Kacır, makam aracı olarak kullandığı T10F oltu rengi ile TBMM’ye giriş yaptı.\nKacır’a, Bakan Yardımcıları Çetin Ali Dönmez, Oruç Baba İnan, Zekeriya Çoştu ile Muhammet Kasım Gönüllü de Togg araçlarıyla eşlik etti.\nASELSAN’IN GELİŞTİRDİĞİ KALP AKCİĞER MAKİNESİ MECLİS SALONUNDA\nBütçe salonundaki ASELSAN’ın ge...";

const C2A9_STORED =
  "Türkiye’nin demiryolu yatırımları kapsamında Erzincan, Erzurum ve Kars’ı kapsayan yeni bir hızlı tren projesi hayata geçirilecek.  Ulaştırma ve Altyapı Bakanı Abdulkadir Uraloğlu, projenin Londra’dan Orta Asya’ya uzanan demiryolu koridorunun önemli bir parçası olacağını söyledi.  Projenin aşamalarına ilişkin bilgi veren Bakan Uraloğlu, ilk olarak mevcut demiryolu hattının elektrikli ve sinyalli hale getirileceğini açıkladı. Bu çalışmaların ardından […]";

const F097_STORED =
  "Kasım ara tatili için geri sayım başladı. Birinci ve ikinci ara tatil tarihleri Milli Eğitim Bakanlığı (MEB) 2026-2027 takvimi ile belli oldu. Milyonlarca öğrenci ve veli ara tatil başlangıç ve bitiş tarihlerini sorguluyor. Ara tatil ile öğrenciler dinlenme fırsatı bulacak. Peki kasım ara tatili ne zaman? 1. ve 2. ara tatil hangi tarihte yapılacak? Detaylar haberimizde...";
const F097_TIDY = F097_STORED.slice(0, F097_STORED.indexOf(" Detaylar haberimizde"));

const A65F_STORED =
  "BDDK Başkanı Şahap Kavcıoğlu'nun Emre Tezmen’den 20 milyar TL talep ettiği iddialarını gündeme getiren AKP'li Savcı Sayan'dan yeni paylaşım geldi. İşte ayrıntılar...";
const A65F_TIDY = A65F_STORED.slice(0, A65F_STORED.indexOf(" İşte ayrıntılar"));

/** What the ingest clamp does to a long text: 497 UTF-16 units, then "...". */
function clamp(text: string, keep = 497): string {
  expect(text.length).toBeGreaterThanOrEqual(keep);
  return text.slice(0, keep) + "...";
}

describe("tidySummaryText ingest-clamp repair (h22-editorial-2)", () => {
  it("c526f480: the real clamped summary no longer ends mid-word", () => {
    expect(C526_CLAMPED).toHaveLength(500);
    const out = tidySummaryText(C526_CLAMPED);
    expect(out).not.toContain("şeki");
    expect(out).not.toContain("...");
    // The last sentence end keeps 79.7% of the text, so the cut is there.
    expect(out).toBe(C526_CLAMPED.slice(0, C526_CLAMPED.indexOf(" Hastanede tedavi gören")));
    expect(out.endsWith("sağlayacağız.")).toBe(true);
  });

  it("e5fd4c5b: a clamp that lands in a new paragraph is cut at the sentence before the heading line", () => {
    expect(E5FD_CLAMPED).toHaveLength(500);
    const out = tidySummaryText(E5FD_CLAMPED);
    expect(out.endsWith("Togg araçlarıyla eşlik etti.")).toBe(true);
    expect(out).not.toContain("ASELSAN");
    expect(out).not.toContain("\n");
  });

  it("without a late sentence end it cuts at the last word and adds one ellipsis", () => {
    const raw = clamp("kelimeler ".repeat(60));
    expect(raw).toHaveLength(500);
    expect(raw.endsWith("kelimel...")).toBe(true);
    expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(49).trimEnd() + "…");
  });

  it("a sentence end that keeps under 60% of the text does not count", () => {
    const raw = clamp("Bir cümle bitti şimdi. " + "kelimeler ".repeat(60));
    expect(tidySummaryText(raw)).toBe(
      "Bir cümle bitti şimdi. " + "kelimeler ".repeat(47).trimEnd() + "…",
    );
  });

  it("the 60% bar is exact: 298 of 497 characters fails, 299 passes", () => {
    const tail = " " + "kelimeler ".repeat(60);
    // k characters through the full stop; the body is 497 characters long.
    const kept = (k: number) => "a".repeat(k - 1) + "." + tail;
    expect(tidySummaryText(clamp(kept(299)))).toBe("a".repeat(298) + ".");
    const below = tidySummaryText(clamp(kept(298)));
    expect(below.endsWith("…")).toBe(true);
    expect(below.startsWith("a".repeat(297) + ". kelimeler")).toBe(true);
  });

  it("a late sentence end wins over the word cut", () => {
    const raw = clamp("kelimeler ".repeat(40) + "Bitti. " + "yarımkalan ".repeat(20));
    expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(40) + "Bitti.");
  });

  it("keeps a closing quote that follows the full stop", () => {
    const raw = clamp("kelimeler ".repeat(40) + "Dedi ki “hazırız.” Sonra " + "yarımkalan ".repeat(20));
    expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(40) + "Dedi ki “hazırız.”");
  });

  it("a full stop right before the stored '...' is a sentence end (no ellipsis added)", () => {
    const raw = clamp("kelimeler ".repeat(49) + "Bittii." + " devam");
    expect(raw.endsWith("Bittii....")).toBe(true);
    expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(49) + "Bittii.");
  });

  it("an initial or a decimal is not a sentence end", () => {
    const raw = clamp("kelimeler ".repeat(35) + "Mustafa K. Sarıgül 3.5 puan " + "yarımkalan ".repeat(20));
    const out = tidySummaryText(raw);
    // "K." sits at 72% of the text: if it counted, the cut would be there.
    expect(out.endsWith("yarımkalan…")).toBe(true);
    expect(out).toContain("Mustafa K. Sarıgül 3.5 puan yarımkalan");
  });

  it("trims ',;:–—-' before the ellipsis", () => {
    const raw = clamp("kelime, ".repeat(70));
    expect(raw.endsWith("k...")).toBe(true);
    expect(tidySummaryText(raw)).toBe("kelime, ".repeat(61) + "kelime…");
    for (const sep of [";", ":", " –", " —", " -"]) {
      const out = tidySummaryText(clamp(`kelime${sep} `.repeat(70)));
      expect(out.endsWith("kelime…"), JSON.stringify(sep)).toBe(true);
    }
  });

  it("a clamp that landed on a word boundary keeps the last word", () => {
    const raw = clamp("kelime ".repeat(80)); // 497 = 71 * 7: the body ends with a blank
    expect(raw.endsWith("kelime ...")).toBe(true);
    expect(tidySummaryText(raw)).toBe("kelime ".repeat(71).trimEnd() + "…");
  });

  it("repairs a 499-character clamp as well", () => {
    const raw = clamp("kelimeler ".repeat(60), 496);
    expect(raw).toHaveLength(499);
    expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(49).trimEnd() + "…");
  });

  it("is keyed on the signature: other lengths, a one-character ellipsis or no blank are left alone", () => {
    const words = "kelimeler ".repeat(60);
    for (const keep of [495, 498]) {
      const raw = clamp(words, keep);
      expect([498, 501]).toContain(raw.length);
      expect(tidySummaryText(raw), `${raw.length}`).toBe(raw);
    }
    const oneChar = words.slice(0, 499) + "…";
    expect(oneChar).toHaveLength(500);
    expect(tidySummaryText(oneChar)).toBe(oneChar);
    const noBlank = "a".repeat(497) + "...";
    expect(tidySummaryText(noBlank)).toBe(noBlank);
  });

  it("a 120-character text ending 'Detaylar...' is not the signature and stays untouched", () => {
    const lead = "Yeni düzenleme bugün Resmi Gazete'de yayımlandı ve yürürlüğe girdi, ";
    const raw = lead + "x".repeat(120 - lead.length - " Detaylar...".length) + " Detaylar...";
    expect(raw).toHaveLength(120);
    expect(tidySummaryText(raw)).toBe(raw);
  });

  it("every clamp output is shorter than the signature and a fixed point", () => {
    for (const raw of [
      C526_CLAMPED,
      E5FD_CLAMPED,
      clamp("kelimeler ".repeat(60)),
      clamp("kelime ".repeat(80)),
      clamp("kelime, ".repeat(70)),
      clamp("kelimeler ".repeat(40) + "Bitti. " + "yarımkalan ".repeat(20)),
      clamp("kelimeler ".repeat(60), 496),
    ]) {
      const once = tidySummaryText(raw);
      expect(once.length).toBeLessThan(499);
      expect(tidySummaryText(once)).toBe(once);
    }
  });
});

describe("tidySummaryText leading ticker (h22-editorial-2)", () => {
  const TICKER_CHANGES: ReadonlyArray<readonly [string, string]> = [
    // d8c49a89, 4433b6f7 and a81379a9, as stored.
    [
      "Son dakika | Galatasaray'da Abdullah Kavukcu istifa etti",
      "Galatasaray'da Abdullah Kavukcu istifa etti",
    ],
    [
      "Son dakika! Borsa İstanbul Genel Müdürlüğü'ne vekaleten Atila Türeli getirildi",
      "Borsa İstanbul Genel Müdürlüğü'ne vekaleten Atila Türeli getirildi",
    ],
    [
      "Son dakika... Fenerbahçe yönetimi, Göztepe maçında alınan 2-1'lik yenilgi sonrasında bugün saat 14:00'te istifa ve birçok gündem ile ilgili acil toplanıyor.",
      "Fenerbahçe yönetimi, Göztepe maçında alınan 2-1'lik yenilgi sonrasında bugün saat 14:00'te istifa ve birçok gündem ile ilgili acil toplanıyor.",
    ],
    ["SON DAKİKA: Deprem oldu", "Deprem oldu"],
    ["SON DAKIKA: Deprem oldu", "Deprem oldu"],
    ["Son Dakika… Deprem oldu", "Deprem oldu"],
    ["Son dakika|Deprem oldu", "Deprem oldu"],
    ["Son dakika. Deprem oldu", "Deprem oldu"],
    ["Son  dakika !!! Deprem oldu", "Deprem oldu"],
    ["Son dakika ...... Deprem oldu", "Deprem oldu"],
    ["Son dakika:\nDeprem oldu", "Deprem oldu"],
    ["  Son dakika | Deprem oldu", "Deprem oldu"],
    // Two stacked tickers.
    ["Son dakika | Son dakika! Deprem oldu", "Deprem oldu"],
  ];

  const TICKER_UNCHANGED: readonly string[] = [
    "Son dakikada gelen golle Galatasaray kazandı",
    "Son dakika golüyle Galatasaray kazandı",
    "Son dakika haberi olarak duyuruldu",
    "Son dakikalar boyunca bekledi",
    "Maçın son dakika golüyle kazanıldı",
    "Galatasaray son dakika | tartışma çıktı",
    "Deprem oldu. Son dakika: yeni gelişme",
    "Son dakika",
  ];

  it.each(TICKER_CHANGES)("rewrites %j -> %j", (input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it.each(TICKER_UNCHANGED)("leaves %j untouched", (input) => {
    expect(tidySummaryText(input)).toBe(input);
  });

  it("peels at most two tickers", () => {
    expect(tidySummaryText("Son dakika: Son dakika: Son dakika: Deprem oldu")).toBe(
      "Son dakika: Deprem oldu",
    );
  });

  it("a ticker and nothing else gives '' (the caller hides the summary)", () => {
    expect(tidySummaryText("Son dakika |")).toBe("");
    expect(tidySummaryText("SON DAKİKA...")).toBe("");
  });

  it("is idempotent on every fixture and on its result", () => {
    for (const [input, expected] of TICKER_CHANGES) {
      const once = tidySummaryText(input);
      expect(tidySummaryText(once), input).toBe(once);
      expect(tidySummaryText(expected), expected).toBe(expected);
    }
    for (const x of TICKER_UNCHANGED) expect(tidySummaryText(tidySummaryText(x))).toBe(x);
  });
});

describe("tidySummaryText trailing CTA sentence (h22-editorial-2)", () => {
  it("f097fa3e: 'Detaylar haberimizde...' goes, the question before it stays", () => {
    expect(tidySummaryText(F097_STORED)).toBe(F097_TIDY);
    expect(F097_TIDY.endsWith("hangi tarihte yapılacak?")).toBe(true);
  });

  it("a65f404a: 'İşte ayrıntılar...' goes", () => {
    expect(tidySummaryText(A65F_STORED)).toBe(A65F_TIDY);
    expect(A65F_TIDY.endsWith("yeni paylaşım geldi.")).toBe(true);
  });

  it.each([
    ["Peki, neden? Detaylar haberimizde.", "Peki, neden?"],
    ["Zam geldi. İşte detaylar", "Zam geldi."],
    ["Zam geldi. İŞTE DETAYLAR…", "Zam geldi."],
    ["Zam geldi… DETAYLAR HABERİMİZDE", "Zam geldi…"],
    ["Zam geldi. İşte ayrıntılar!", "Zam geldi."],
    ["Zam geldi (kesin) İşte ayrıntılar", "Zam geldi (kesin)"],
    // After a plain space only a capitalised CTA is a tail.
    ["Bakan açıklama yaptı Detaylar haberimizde", "Bakan açıklama yaptı"],
    ["Bakan açıklama yaptı işte detaylar", "Bakan açıklama yaptı işte detaylar"],
    // A colon left dangling by the strip goes with it.
    ["Gelişmeler şöyle: Detaylar haberimizde", "Gelişmeler şöyle"],
    ["Neler oldu: İşte ayrıntılar...", "Neler oldu"],
    // Stacked with an older CTA.
    ["Zam geldi. İşte detaylar. Devamını oku", "Zam geldi."],
  ])("strips the tail of %j", (input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it("a colon is kept when no CTA was stripped", () => {
    expect(tidySummaryText("Gelişmeler şöyle:")).toBe("Gelişmeler şöyle:");
  });

  it.each(["Detaylar haberimizde", "İşte ayrıntılar...", "işte detaylar", "  İŞTE DETAYLAR  "])(
    "a CTA-only summary %j gives ''",
    (input) => {
      expect(tidySummaryText(input)).toBe("");
    },
  );

  it.each([
    "İşte detaylarıyla yeni düzenleme",
    "Detaylar haberimizde yer alıyor",
    "İşte ayrıntılar ve yeni kurallar",
    "Detaylar haberimizdeki yazıda",
  ])("does not strip %j (the phrase is not the end)", (input) => {
    expect(tidySummaryText(input)).toBe(input);
  });

  it("is idempotent", () => {
    for (const x of [
      F097_STORED,
      A65F_STORED,
      "Peki, neden? Detaylar haberimizde.",
      "Gelişmeler şöyle: Detaylar haberimizde",
      "Zam geldi. İşte detaylar. Devamını oku",
      "Detaylar haberimizde",
    ]) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once), x).toBe(once);
    }
  });
});

describe("tidySummaryText inner whitespace (h22-editorial-2)", () => {
  it("c2a97d0a: the double spaces between sentences collapse and the marker becomes one ellipsis", () => {
    expect(C2A9_STORED).toContain("  ");
    const out = tidySummaryText(C2A9_STORED);
    expect(out).not.toMatch(/\s{2,}/);
    expect(out).toContain("hayata geçirilecek. Ulaştırma");
    expect(out.endsWith("ardından…")).toBe(true);
  });

  it("collapses after the ticker and the CTA strip, so no seam is left behind", () => {
    expect(tidySummaryText("Son dakika |   Zam  geldi.   İşte   detaylar")).toBe("Zam geldi.");
  });

  it("is idempotent", () => {
    for (const x of [C2A9_STORED, "a  b\t\tc  d", "  a  "]) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once)).toBe(once);
    }
  });
});

describe("tidySummaryText h22 residue robustness", () => {
  it("linear time on 100k-character inputs built from the new anchors", () => {
    const inputs = [
      "Son dakika | ".repeat(8_000),
      "Son dakika".concat(" ".repeat(100_000), "x"),
      "Son dakika".concat("!".repeat(100_000)),
      "a. ".concat("İşte detaylar ".repeat(8_000)),
      "a. ".concat("İşte detaylar. ".repeat(8_000), "Detaylar haberimizde"),
      " ".repeat(497) + "...",
      "a ".repeat(247) + "abc" + "...",
      ". ".repeat(247) + "abc" + "...",
    ];
    const start = performance.now();
    for (const s of inputs) tidySummaryText(s);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("never throws on a clamp-shaped text of odd characters", () => {
    for (const s of ["😀".repeat(249) + "...", "\ud83d".repeat(497) + "...", "ı İ ".repeat(124) + "...", "\n".repeat(497) + "..."]) {
      expect(() => tidySummaryText(s)).not.toThrow();
    }
  });
});
