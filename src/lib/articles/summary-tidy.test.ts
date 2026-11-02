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
