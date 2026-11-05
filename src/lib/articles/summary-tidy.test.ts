import { describe, expect, it } from "vitest";

import h26Fixtures from "../../../tests/fixtures/summary-tidy-h26.json";
import { BOILERPLATE_PHRASES, TRAILING_CTA_PHRASES } from "./description-boilerplate";
import { cleanDescription, stripTrailingTeasers } from "../../../supabase/functions/_shared/cluster/description-clean";
import { backOffOpenQuote, tidySummaryText, trimDanglingEnd, WIDGET_HEADINGS } from "./summary-tidy";

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

// ---------------------------------------------------------------------------
// h23 (hunt 23, 2026-11-02): residue that survived the #169 clamp repair. The
// rows are the verbatim clusters.summary_tr of fifteen live clusters (read-only
// SELECT on 2026-11-02; every id is the 8-character prefix of the cluster id):
//   h23-live-1  ticker / bullet / CTA residue: abae2026 18d67e3b 55cc9990
//               (Son dakika haberi...), 4f1b3e56 (leading "- "), da55a291
//               af529f2a 869ffc17 (CTA sentence), 3a46fc27 (placeholder)
//   h23-live-2  a different story's headline at the end: 9e83921e 4c8e7533
//               (Milliyet ticker / related line), 1f0261af (mid-text line)
//   h23-live-3  the clamp repair ended on an ordinal or a title: 4327f6d8
//               2328a68d dec5e1a6 (13. / 103.), 4ca344b8 (Prof. Dr.)
// ---------------------------------------------------------------------------

// 9e83921e (500 chars)
const RAW_9E83 =
  "Türkiye'de 15 yaşını doldurmamış çocuklara yönelik sosyal medya düzenlemesinin yürürlüğe girmesiyle birlikte gözler yaş doğrulama sürecine çevrildi. Ancak kullanıcıları bekleyen tehlike yalnızca yeni kurallar değil. Dolandırıcılar, \"Hesabınız kapatılacak\" ve \"Yaşınızı doğrulayın\" mesajlarıyla vatandaşların dijital bilgilerini ele geçirmek için harekete geçebilir.\nSon dakika... MHP lideri Bahçeli'den 100 il 1000 ilçe açıklaması! Türkiye'de 19 yeni il, 78 yeni ilçe önerisi\nE-Devlet veya sosyal ...";

// 4c8e7533 (314 chars)
const RAW_4C8E =
  "Dışişleri Bakanı Hakan Fidan, Atlanta'da G20 Dışişleri Bakanları Toplantısı marjında Meksika Dışişleri Bakanı Roberto Velasco Álvarez ile görüştü.\nZelenskiy ile görüşen Cumhurbaşkanı Erdoğan: Barışa giden yolu açmak için her gayrete hazırız\nSon dakika... Rusya için 3 fırsat! Polonya'daki kriz Avrupa'yı sarsabilir";

// 1f0261af (500 chars)
const RAW_1F02 =
  "Partiden yapılan açıklamaya göre, AK Parti Kültür ve Sanat Politikaları Başkanlığı ile Teşkilat Başkanlığı işbirliğinde \"Kuruluşunun 25. İktidara Gelişinin 24. Yılında AK Parti\" paneli yapılacak. AK Parti Genel Merkezi'nde 3 Kasım Salı günü gerçekleştirilecek panelin moderatörlüğünü Genel Başkan Yardımcısı ve Kültür ve Sanat Politikaları Başkanı Hüseyin Yayman üstlenecek.\n11 ilde sahte kanser ilacı operasyonu! 22 gözaltı\nPanele, Genel Başkanvekilleri Efkan Ala ve Mustafa Elitaş ile Genel Başk...";

// 4327f6d8 (500 chars)
const RAW_4327 =
  "Cumhurbaşkanı Erdoğan, \"Türk dünyasının aile fotoğrafında ayrılığa, gayrılığa, ihtilafa yer yoktur. Hepimiz biriz, beraberiz, ezelden ebede kadar inşallah kardeşiz\" dedi Cumhurbaşkanı Erdoğan, Beştepe Millet Sergi Salonu'nda \"Türk Yüzyılı: Dilde, Fikirde, İşte Birlik\" temasıyla düzenlenen Türk Devletleri Teşkilatı (TDT) Devlet Başkanları Konseyi 13. Zirvesi'nde konuştu.Konuşmasına katılımcıları selamlayarak başlayan Erdoğan, \"Dün Cumhuriyetimizin 103'üncü yıl dönümünü sizlerin katılımıyla büy...";

// 2328a68d (500 chars)
const RAW_2328 =
  "Cumhurbaşkanı Recep Tayyip Erdoğan, Beştepe Millet Sergi Salonu'nda 29 Ekim Cumhuriyet Bayramı ve TDT Zirvesi dolayısıyla konuk devlet başkanlarını ağırladı.\nCumhurbaşkanı Erdoğan'ın açıklamalarından satır başları:\nMustafa Kemal Atatürk başta olmak üzere milli mücadeleyi sevk ve idare eden tüm kadroları, tüm şehitlerimizi, gazilerimizi, Meclisimizin o dönemdeki muhterem mensuplarını rahmetle, minnetle yâd ediyorum. Cumhuriyetimizin 103. yıl dönümünü millet olarak bu sene çok farklı idrak ediy...";

// dec5e1a6 (500 chars)
const RAW_DEC5 =
  "HABER MERKEZİ - Başkent Ankara, Türk Devletleri Teşkilatı'nın (TDT) 13. zirvesine ev sahipliği yapıyor. Cumhurbaşkanı Erdoğan'ın \"Türk dünyası olarak sarsılmaz kardeşliğimize dinamit koymak isteyenlerin karşısına inanıyorum ki yine birlik ve beraberlikle dikileceğiz.\" sözleriyle dikkat çektiği Türk Devletleri Teşkilatı 13. Zirvesi'ne katılacak liderler Türkiye'ye geldi.\nDIŞİŞLERİ BAKANLARI KONSEYİ TOPLANDI\nTürk Devletleri Teşkilatı (TDT) 13. Zirvesi kapsamında Ankara'da düzenlenen TDT Dışişle...";

// 4ca344b8 (500 chars)
const RAW_4CA3 =
  "Cumhurbaşkanı Recep Tayyip Erdoğan şu açıklamada bulundu: 2026 Cumhurbaşkanlığı Kültür ve Sanat Büyük Ödülü’ne layık görülen çok kıymetli ilim, kültür ve sanat erbabımıza ülkemize yaptıkları eşsiz katkılar için şükranlarımı sunuyor, gönül ve fikir dünyamızın yıldızlarından Ahmed-i Hânî'yi rahmetle yad ediyorum\n▪\uFE0F Bilim ve Kültür: Sabri Koz▪\uFE0F Geleneksel Sanatlar: Prof. Dr. İlhami Turan▪\uFE0F Edebiyat: Sibel Eraslan▪\uFE0F Sinema: Burçak Evren▪\uFE0F Müzik: Prof. Dr. Gönül Paçacı▪\uFE0F Vefa: Ahmed-i Hânî\n\nTrump ...";

// abae2026 (152 chars)
const RAW_ABAE =
  "Son dakika haberi... AFAD verilerine göre Ege Denizi'nde 3.7 büyüklüğünde bir deprem meydana geldi. Depremin derinliği 8.83 kilometre olarak kaydedildi.";

// 18d67e3b (94 chars)
const RAW_18D6 =
  "Son dakika haberi: Türkiye ve Özbekistan arasında iş birliği anlaşmalarının imzaları atılıyor.";

// 55cc9990 (228 chars)
const RAW_55CC =
  "Son dakika haberine göre; Milli İstihbarat Teşkilatı Başkanlığı tarafından, terör örgütü DEAŞ’ın Horasan Vilayeti’ne yönelik bir operasyon gerçekleştirdi. Operasyonda yakalanan DEAŞ’lı terörist Uğur Bahadır Türkiye'ye getirildi.";

// 4f1b3e56 (500 chars)
const RAW_4F1B =
  "- \"Kadınların toplum hayatında güçlü ve etkin konumları olması, medeniyet coğrafyamıza yabancı bir tecrübe değildir. Yapmamız gereken, bu tecrübeyi toplumlarımızın kültürel hassasiyetleriyle, öncelikleriyle ve sosyal gerçeklikleriyle örtüşen, Türk dünyasına özgü bir perspektife dönüştürmektir\"\n\"Konseyimizin kalıcı bir işbirliği zemini olmasını hedefliyoruz. Bugün Ankara'da Konseyimizin ilk adımlarını sizlerle birlikte atmış olduk. Konseyimizin ilk resmi toplantısını inşallah önümüzdeki sene T...";

// da55a291 (445 chars)
const RAW_DA55 =
  "8 Eylül 1999 sonrasında sigortalı olan ve emeklilikte yaş şartına takılan milyonlarca çalışanı ilgilendiren yeni bir kanun teklifi Meclis'e geldi. Kademeli emeklilik beklentisini yeniden gündeme taşıyan teklif, gerekli sigortalılık süresini ve prim gün sayısını tamamlayanlara yaş şartı aranmaksızın emekli aylığı bağlanmasını öngörüyor. Üç maddeden oluşan düzenleme, TBMM Plan ve Bütçe Komisyonuna sevk edildi. İşte merak edilen tüm detaylar...";

// af529f2a (440 chars)
const RAW_AF52 =
  "Dijital mecralara yönelik düzenlemede geri sayım bitti. Kamuoyunda sosyal medya düzenlemesi olarak da bilinen 15-17 yaş aralığındakilerin sosyal medya hesaplarının yarın itibarıyla tek tek silinmesi bekleniyor. Velilerinin rızası olsa dahi bu yaş grubu kişilerin hiçbir mecrada hesap açamaması sağlanacak. Sosyal medya düzenlemesinin milyonlarca kişiyi kapsadığı öğrenilirken, platformlar için ağır cezalar da gündemde... İşte tüm detaylar!";

// 869ffc17 (365 chars)
const RAW_869F =
  "2026-2027 eğitim öğretim yılı KYK burs ve öğrenim kredisi başvuru sonuçları için öğrencilerin bekleyişi sürüyor. Gençlik ve Spor Bakanlığı tarafından başvuru sürecinin tamamlanmasının ardından gözler sonuçların açıklanacağı tarihe çevrildi. Peki, 2026 KYK burs sonuçları açıklandı mı, ne zaman açıklanacak? KYK burs ve kredi başvurularına dair detaylar haberimizde.";

// 3a46fc27 (22 chars)
const RAW_3A46 =
  "Ayrıntılar birazdan...";

/** The text up to (not including) the first occurrence of `marker`. */
function before(text: string, marker: string): string {
  const at = text.indexOf(marker);
  expect(at, marker).toBeGreaterThan(0);
  return text.slice(0, at);
}

const H23_RAW_ALL: ReadonlyArray<readonly [string, string]> = [
  ["9e83921e", RAW_9E83],
  ["4c8e7533", RAW_4C8E],
  ["1f0261af", RAW_1F02],
  ["4327f6d8", RAW_4327],
  ["2328a68d", RAW_2328],
  ["dec5e1a6", RAW_DEC5],
  ["4ca344b8", RAW_4CA3],
  ["abae2026", RAW_ABAE],
  ["18d67e3b", RAW_18D6],
  ["55cc9990", RAW_55CC],
  ["4f1b3e56", RAW_4F1B],
  ["da55a291", RAW_DA55],
  ["af529f2a", RAW_AF52],
  ["869ffc17", RAW_869F],
  ["3a46fc27", RAW_3A46],
];

describe("tidySummaryText h23 live rows: the fixtures are the live raw texts", () => {
  it("the clamped rows have the clamp signature (500 characters, ending '...')", () => {
    for (const raw of [RAW_9E83, RAW_1F02, RAW_4327, RAW_2328, RAW_DEC5, RAW_4CA3, RAW_4F1B]) {
      expect(raw).toHaveLength(500);
      expect(raw.endsWith("...")).toBe(true);
    }
  });
});

describe("tidySummaryText appended ticker (h23-live-2)", () => {
  it("9e83921e: the Milliyet ticker and the related headline go; the summary ends '... harekete geçebilir.'", () => {
    const out = tidySummaryText(RAW_9E83);
    expect(out.endsWith(" harekete geçebilir.")).toBe(true);
    expect(out).toBe(before(RAW_9E83, "\nSon dakika"));
    expect(out).not.toMatch(/son dakika/i);
    expect(out).not.toContain("Bahçeli");
    expect(out).not.toContain("E-Devlet");
    expect(out).not.toContain("…");
  });

  it("4c8e7533: the Zelenskiy headline and the ticker go; the summary ends '... Roberto Velasco Álvarez ile görüştü.'", () => {
    const out = tidySummaryText(RAW_4C8E);
    expect(out.endsWith(" Roberto Velasco Álvarez ile görüştü.")).toBe(true);
    expect(out).toBe(before(RAW_4C8E, "\nZelenskiy"));
    expect(out).not.toContain("Zelenskiy");
    expect(out).not.toMatch(/son dakika/i);
    expect(out).not.toContain("Polonya");
  });

  it("1f0261af: the short unpunctuated line in the middle is not a sentence end; the summary ends '... Hüseyin Yayman üstlenecek.'", () => {
    const out = tidySummaryText(RAW_1F02);
    expect(out.endsWith(" Hüseyin Yayman üstlenecek.")).toBe(true);
    expect(out).toBe("Partiden yapılan açıklamaya göre, AK Parti Kültür ve Sanat Politikaları Başkanlığı ile Teşkilat Başkanlığı işbirliğinde \"Kuruluşunun 25. İktidara Gelişinin 24. Yılında AK Parti\" paneli yapılacak. AK Parti Genel Merkezi'nde 3 Kasım Salı günü gerçekleştirilecek panelin moderatörlüğünü Genel Başkan Yardımcısı ve Kültür ve Sanat Politikaları Başkanı Hüseyin Yayman üstlenecek.");
    expect(out).not.toContain("sahte kanser ilacı");
    expect(out).not.toContain("22 gözaltı");
  });

  it("a non-clamped text is cut too (4c8e7533 is 314 characters, so the clamp repair never ran)", () => {
    expect(RAW_4C8E.length).toBeLessThan(499);
    expect(tidySummaryText("Birinci cümle.\nSon dakika... Başka haber")).toBe("Birinci cümle.");
  });

  it("a related line that ends in a sentence mark is a real line of the article and stays", () => {
    expect(tidySummaryText("Birinci cümle.\nİkinci cümle de bitti.\nSon dakika... Başka haber")).toBe(
      "Birinci cümle. İkinci cümle de bitti.",
    );
  });

  it("a ticker that is the only thing after an empty first line does not empty the summary", () => {
    expect(tidySummaryText("\nSon dakika... Deprem oldu")).toBe("Deprem oldu");
    expect(tidySummaryText("\nSon dakika:")).toBe("");
  });

  it("a ticker on the first line is still the leading-ticker rule's business (h31-reader-4: the line break after a letter in front of a capital is now '. ')", () => {
    expect(tidySummaryText("Son dakika... Deprem oldu\nİkinci satır.")).toBe("Deprem oldu. İkinci satır.");
  });

  describe("clamp repair with a ticker line (repairClamp)", () => {
    const FIRST = "Bakan açıklama yaptı ve kararı duyurdu.";

    it("cuts at the first line whatever share that keeps, and adds no ellipsis", () => {
      const raw = clamp(`${FIRST}\nSon dakika... ${"Başka haber ".repeat(60)}`);
      expect(FIRST.length / 497).toBeLessThan(0.6);
      expect(tidySummaryText(raw)).toBe(FIRST);
    });

    it("drops the related headline that precedes the ticker", () => {
      const raw = clamp(`${FIRST}\nİlgili haber başlığı bitmeden\nSon dakika... ${"Başka haber ".repeat(60)}`);
      expect(tidySummaryText(raw)).toBe(FIRST);
    });

    it("keeps a related line that ends in a sentence mark", () => {
      const raw = clamp(`${FIRST}\nİlgili cümle bitti.\nSon dakika... ${"Başka haber ".repeat(60)}`);
      expect(tidySummaryText(raw)).toBe(`${FIRST} İlgili cümle bitti.`);
    });

    it("an empty first line falls back to the ordinary repair, and the ticker is still removed", () => {
      const raw = clamp(`\nSon dakika... ${"kelimeler ".repeat(60)}`);
      expect(raw).toHaveLength(500);
      const out = tidySummaryText(raw);
      // h24: the first word is capitalised once the ticker line has gone.
      expect(out).toBe("Kelimeler" + " kelimeler".repeat(47) + "…");
    });

    it("a ticker on the first line only is not cut by the ticker rule", () => {
      const raw = clamp(`Son dakika... ${"kelimeler ".repeat(60)}`);
      const out = tidySummaryText(raw);
      expect(out).toBe("Kelimeler" + " kelimeler".repeat(47) + "…");
    });
  });

  describe("clamp repair skips a short unpunctuated later line", () => {
    const FIRST_LINE = "kelimeler ".repeat(30) + "Bitti.";
    const TAIL = "yarımkalan ".repeat(20);

    it("a '!' inside it is not a sentence end", () => {
      const raw = clamp(`${FIRST_LINE}\nYeni bir haber! 22 gözaltı\n${TAIL}`);
      expect(tidySummaryText(raw)).toBe(FIRST_LINE);
    });

    it("a '?' or '…' inside it is not a sentence end either", () => {
      expect(tidySummaryText(clamp(`${FIRST_LINE}\nNe oldu? Bilinmiyor\n${TAIL}`))).toBe(FIRST_LINE);
      expect(tidySummaryText(clamp(`${FIRST_LINE}\nDevamı var… sonra\n${TAIL}`))).toBe(FIRST_LINE);
    });

    it("a line longer than 120 characters is not skipped", () => {
      // h34-reader-5: the repaired line says "kelimeler" like the first line (the stem "kelime"), so the
      // teaser strip leaves it alone; an unrelated "Yeni bir haber!" headline would now be dropped there.
      const mid = `Yeni kelimeler geldi! ${"x".repeat(110)}`;
      expect(mid.length).toBeGreaterThan(120);
      const raw = clamp(`${FIRST_LINE}\n${mid}\n${TAIL}`);
      expect(tidySummaryText(raw)).toBe(`${FIRST_LINE} Yeni kelimeler geldi!`);
    });

    it("h34-reader-5: a repaired paragraph that keeps only a short unrelated exclamation sentence loses it to the teaser strip", () => {
      // HEAD kept ' Yeni bir haber!' here: the clamp repair cuts the long (> 120 characters)
      // middle paragraph back to its first sentence, "Yeni bir haber!". The raw text itself is no
      // teaser (the stored line is long), but the repaired paragraph is a headline-shaped last line
      // with an exclamation anchor that shares no stem with the first line, so the h34 strip drops
      // it. Accepted behaviour change; "Yeni kelimeler geldi!" above shares the stem "kelime" and stays.
      const mid = `Yeni bir haber! ${"x".repeat(110)}`;
      const raw = clamp(`${FIRST_LINE}\n${mid}\n${TAIL}`);
      expect(stripTrailingTeasers(raw)).toBe(raw);
      expect(tidySummaryText(raw)).toBe(FIRST_LINE);
    });

    it("a line of exactly 120 characters is skipped", () => {
      const mid = `Yeni bir haber! ${"x".repeat(104)}`;
      expect(mid).toHaveLength(120);
      const raw = clamp(`${FIRST_LINE}\n${mid}\n${TAIL}`);
      expect(tidySummaryText(raw)).toBe(FIRST_LINE);
    });

    it("a line that ends in a sentence mark is not skipped", () => {
      const raw = clamp(`${FIRST_LINE}\nYeni bir haber! 22 gözaltı.\n${TAIL}`);
      expect(tidySummaryText(raw)).toBe(`${FIRST_LINE} Yeni bir haber! 22 gözaltı.`);
    });

    it("the clamped last line is never skipped, even when it is short", () => {
      const raw = clamp(`${"kelimeler ".repeat(44)}Bitti.\nKısa haber! ${TAIL}`);
      expect(tidySummaryText(raw)).toBe(`${"kelimeler ".repeat(44)}Bitti. Kısa haber!`);
    });

    it("the first line is never skipped", () => {
      // 60% of 497 is 299 characters, more than a skippable line can hold, so
      // a first line is only testable as a unit: a short first line with a '!'
      // keeps ending at that '!' once nothing later qualifies.
      const raw = clamp(`Kısa! ilk satır\n${"kelimeler ".repeat(60)}`);
      const out = tidySummaryText(raw);
      expect(out.startsWith("Kısa! ilk satır kelimeler")).toBe(true);
      expect(out.endsWith("…")).toBe(true);
    });
  });
});

describe("tidySummaryText ordinals and title abbreviations at a clamp (h23-live-3)", () => {
  it("4327f6d8: does not end on 'Konseyi 13.'; it ends at the glued sentence end 'konuştu.' (h26-live-1)", () => {
    const out = tidySummaryText(RAW_4327);
    expect(out).not.toMatch(/\d{1,3}\.$/);
    // h25-live-1: the word cut used to end inside the open quotation; h26-live-1:
    // the raw text glues its last complete sentence ("... Zirvesi'nde konuştu.Konuşmasına
    // katılımcıları ..."), which is a sentence end now, so the cut keeps that sentence
    // instead of the half sentence "Konuşmasına katılımcıları selamlayarak başlayan Erdoğan…".
    expect(out).toBe("Cumhurbaşkanı Erdoğan, \"Türk dünyasının aile fotoğrafında ayrılığa, gayrılığa, ihtilafa yer yoktur. Hepimiz biriz, beraberiz, ezelden ebede kadar inşallah kardeşiz\" dedi Cumhurbaşkanı Erdoğan, Beştepe Millet Sergi Salonu'nda \"Türk Yüzyılı: Dilde, Fikirde, İşte Birlik\" temasıyla düzenlenen Türk Devletleri Teşkilatı (TDT) Devlet Başkanları Konseyi 13. Zirvesi'nde konuştu.");
    expect(out.endsWith("Zirvesi'nde konuştu.")).toBe(true);
    expect(countChar(out, '"') % 2).toBe(0);
  });

  it("2328a68d: does not end on 'Cumhuriyetimizin 103.'; it ends at the previous real sentence end", () => {
    const out = tidySummaryText(RAW_2328);
    expect(out).not.toMatch(/\d{1,3}\.$/);
    expect(out).toBe("Cumhurbaşkanı Recep Tayyip Erdoğan, Beştepe Millet Sergi Salonu'nda 29 Ekim Cumhuriyet Bayramı ve TDT Zirvesi dolayısıyla konuk devlet başkanlarını ağırladı. Cumhurbaşkanı Erdoğan'ın açıklamalarından satır başları: Mustafa Kemal Atatürk başta olmak üzere milli mücadeleyi sevk ve idare eden tüm kadroları, tüm şehitlerimizi, gazilerimizi, Meclisimizin o dönemdeki muhterem mensuplarını rahmetle, minnetle yâd ediyorum.");
    expect(out.endsWith("minnetle yâd ediyorum.")).toBe(true);
  });

  it("dec5e1a6: does not end on '(TDT) 13.'; it ends at the previous real sentence end", () => {
    const out = tidySummaryText(RAW_DEC5);
    expect(out).not.toMatch(/\d{1,3}\.$/);
    expect(out).toBe("HABER MERKEZİ - Başkent Ankara, Türk Devletleri Teşkilatı'nın (TDT) 13. zirvesine ev sahipliği yapıyor. Cumhurbaşkanı Erdoğan'ın \"Türk dünyası olarak sarsılmaz kardeşliğimize dinamit koymak isteyenlerin karşısına inanıyorum ki yine birlik ve beraberlikle dikileceğiz.\" sözleriyle dikkat çektiği Türk Devletleri Teşkilatı 13. Zirvesi'ne katılacak liderler Türkiye'ye geldi.");
    expect(out.endsWith("liderler Türkiye'ye geldi.")).toBe(true);
  });

  it("4ca344b8: does not end on 'Prof. Dr.' or 'Dr.', nor on the first word of the next paragraph", () => {
    const out = tidySummaryText(RAW_4CA3);
    expect(out.endsWith("Dr.")).toBe(false);
    expect(out.endsWith("Prof. Dr.")).toBe(false);
    expect(out).toBe("Cumhurbaşkanı Recep Tayyip Erdoğan şu açıklamada bulundu: 2026 Cumhurbaşkanlığı Kültür ve Sanat Büyük Ödülü’ne layık görülen çok kıymetli ilim, kültür ve sanat erbabımıza ülkemize yaptıkları eşsiz katkılar için şükranlarımı sunuyor, gönül ve fikir dünyamızın yıldızlarından Ahmed-i Hânî'yi rahmetle yad ediyorum. Bilim ve Kültür: Sabri Koz▪\uFE0F Geleneksel Sanatlar: Prof. Dr. İlhami Turan▪\uFE0F Edebiyat: Sibel Eraslan▪\uFE0F Sinema: Burçak Evren▪\uFE0F Müzik: Prof. Dr. Gönül Paçacı▪\uFE0F Vefa: Ahmed-i Hânî…");
    // h24: the first word of the next paragraph ("Trump") no longer survives the cut.
    expect(out).not.toContain("Trump");
  });

  describe("synthetic clamps", () => {
    const PRE = "kelimeler ".repeat(40) + "Bitti. ";
    const PREV = "kelimeler ".repeat(40) + "Bitti.";
    const REST = "yarımkalan ".repeat(20);
    const build = (mid: string) => clamp(`${PRE}${mid} ${REST}`);

    it.each(["1", "9", "13", "99", "103", "999", "1899", "2100", "9999", "0"])(
      "a 1-4 digit run '%s' before '.' is an ordinal, not a sentence end",
      (digits) => {
        expect(tidySummaryText(build(`Zirve ${digits}. Yeni dönem başlıyor`))).toBe(PREV);
      },
    );

    it.each(["1900", "1999", "2000", "2026", "2099"])(
      "the year rule: '%s' before '.' IS a sentence end",
      (year) => {
        expect(tidySummaryText(build(`Etkinlik ${year}. Yeni dönem başlıyor`))).toBe(
          `${PRE}Etkinlik ${year}.`,
        );
      },
    );

    it.each([
      "Dr", "DR", "Prof", "PROF", "Doç", "DOÇ", "Doc", "Av", "Op", "Uzm", "Yrd",
      "Öğr", "ÖĞR", "Arş", "ARŞ", "Gör", "Org", "Korg", "Tümg", "Tuğg", "Alb",
      "Sn", "Mah", "Cad", "Sok", "No", "vs", "vb", "Bkz", "Örn",
    ])("the abbreviation '%s.' is not a sentence end", (abbr) => {
      expect(tidySummaryText(build(`Konuşmacı ${abbr}. Ali Veli`))).toBe(PREV);
    });

    it("Prof. Dr. and Öğr. Gör. stack: every dot of the title is skipped", () => {
      expect(tidySummaryText(build("Konuşmacı Prof. Dr. Ali Veli"))).toBe(PREV);
      expect(tidySummaryText(build("Konuşmacı Öğr. Gör. Dr. Ali Veli"))).toBe(PREV);
    });

    it.each(["kararı", "ev", "Cumhurbaşkanlığı", "abcdr", "Kahramanmaraşdr", "XXXXXXXXdr", "profesör"])(
      "an ordinary word '%s' before '.' is a sentence end (an abbreviation counts only as a whole word)",
      (word) => {
        expect(tidySummaryText(build(`Konuşmacı ${word}. Ali Veli`))).toBe(`${PRE}Konuşmacı ${word}.`);
      },
    );

    it("a single letter is still an initial, and a decimal is still not an end", () => {
      expect(tidySummaryText(build("Konuşmacı Mustafa K. Sarıgül"))).toBe(PREV);
      expect(tidySummaryText(build("Oran 3.5 puan oldu"))).toBe(PREV);
    });

    it("the bar is on the sentence end that remains: an ordinal skipped, the real end kept at 60% or more", () => {
      const raw = clamp(`${"a".repeat(299)}. Zirve 13. ${"kelimeler ".repeat(20)}`);
      expect(tidySummaryText(raw)).toBe(`${"a".repeat(299)}.`);
    });

    it("an ordinal is also not a sentence end for the CTA rule", () => {
      expect(tidySummaryText("Toplantı 13. Zirvesi'nde yapıldı işte detaylar")).toBe(
        "Toplantı 13. Zirvesi'nde yapıldı işte detaylar",
      );
    });
  });

  it("unchanged: 'K. Sarıgül', '3.5', a year sentence and a real final sentence", () => {
    for (const s of [
      "Mustafa K. Sarıgül açıkladı",
      "K. Sarıgül",
      "Oran 3.5 puan oldu",
      "Etkinlik 2026. Yeni dönem başlıyor ...",
      "Bakan kararı açıkladı.",
      "Zam geldi. Bakan kararı açıkladı.",
      "Prof. Dr. Ahmet Yılmaz açıkladı",
    ]) {
      expect(tidySummaryText(s), s).toBe(s);
    }
  });
});

describe("tidySummaryText leading ticker with 'haber' and list markers (h23-live-1)", () => {
  it("abae2026: 'Son dakika haberi...' goes", () => {
    const out = tidySummaryText(RAW_ABAE);
    expect(out).not.toMatch(/^son dakika/i);
    expect(out).toBe(
      "AFAD verilerine göre Ege Denizi'nde 3.7 büyüklüğünde bir deprem meydana geldi. Depremin derinliği 8.83 kilometre olarak kaydedildi.",
    );
  });

  it("18d67e3b: 'Son dakika haberi:' goes", () => {
    const out = tidySummaryText(RAW_18D6);
    expect(out).not.toMatch(/^son dakika/i);
    expect(out).toBe("Türkiye ve Özbekistan arasında iş birliği anlaşmalarının imzaları atılıyor.");
  });

  it("55cc9990: 'Son dakika haberine göre;' goes", () => {
    const out = tidySummaryText(RAW_55CC);
    expect(out).not.toMatch(/^son dakika/i);
    expect(out).toBe(RAW_55CC.slice(RAW_55CC.indexOf("Milli İstihbarat")));
  });

  it("4f1b3e56: the leading '- ' goes (and the clamp is repaired first)", () => {
    const out = tidySummaryText(RAW_4F1B);
    expect(out.startsWith("- ")).toBe(false);
    expect(out.startsWith('"Kadınların toplum hayatında')).toBe(true);
    // h25-live-1: the sentence end "... atmış olduk." used to be the cut, inside the
    // second quotation (never closed); the cut is now in front of it (56% of the text).
    expect(out).toBe("\"Kadınların toplum hayatında güçlü ve etkin konumları olması, medeniyet coğrafyamıza yabancı bir tecrübe değildir. Yapmamız gereken, bu tecrübeyi toplumlarımızın kültürel hassasiyetleriyle, öncelikleriyle ve sosyal gerçeklikleriyle örtüşen, Türk dünyasına özgü bir perspektife dönüştürmektir\"…");
    expect(countChar(out, '"') % 2).toBe(0);
  });

  describe("tickers", () => {
    it.each([
      ["Son dakika haberi... AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi: AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi! AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi | AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi. AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi… AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi; AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberine göre; AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberine göre: AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberine göre... AFAD açıkladı", "AFAD açıkladı"],
      ["SON DAKİKA HABERİ: AFAD açıkladı", "AFAD açıkladı"],
      ["SON DAKİKA HABERİNE GÖRE; AFAD açıkladı", "AFAD açıkladı"],
      ["Son Dakika Haberi! AFAD açıkladı", "AFAD açıkladı"],
      ["Son  dakika   haberi  ... AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberine  göre ; AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika haberi:\nAFAD açıkladı", "AFAD açıkladı"],
      // Two stacked tickers, one of each shape.
      ["Son dakika haberi: Son dakika | AFAD açıkladı", "AFAD açıkladı"],
      ["Son dakika: Son dakika haberine göre; AFAD açıkladı", "AFAD açıkladı"],
    ])("rewrites %j -> %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it.each([
      "Son dakika haberi olarak duyuruldu",
      "Son dakika haberine göre karar verildi",
      "Son dakika haberleri geldi",
      "Son dakika haberi",
      "Son dakika haberine göre",
      "Son dakika golüyle Galatasaray kazandı",
      "Son dakikada gelen golle Galatasaray kazandı",
      "Son dakika haberiyle ilgili açıklama",
      "Son dakikalar haberi: çok sayıda",
      "Deprem oldu. Son dakika haberi: yeni gelişme",
    ])("leaves %j untouched (no separator right after the ticker)", (input) => {
      expect(tidySummaryText(input)).toBe(input);
    });

    it("peels at most two tickers in total, whatever their shape", () => {
      expect(tidySummaryText("Son dakika haberi: Son dakika: Son dakika! Deprem oldu")).toBe(
        "Son dakika! Deprem oldu",
      );
    });

    it("a ticker and nothing else gives ''", () => {
      expect(tidySummaryText("Son dakika haberi...")).toBe("");
      expect(tidySummaryText("SON DAKİKA HABERİNE GÖRE;")).toBe("");
    });
  });

  describe("list markers", () => {
    it.each([
      ["- Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["– Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["• Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["* Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["▪ Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["▪️ Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["-   Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ['- "Kadınların" dedi', '"Kadınların" dedi'],
      ["- Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      ["- \n Kadınların toplumdaki yeri", "Kadınların toplumdaki yeri"],
      // A marker and a ticker, either way round.
      ["Son dakika | - Deprem oldu", "Deprem oldu"],
      ["- Son dakika: Deprem oldu", "Deprem oldu"],
      ["- Son dakika haberi: - Deprem oldu", "Deprem oldu"],
      // At most two markers in total.
      ["- - Deprem oldu", "Deprem oldu"],
      ["- - - Deprem oldu", "- Deprem oldu"],
    ])("rewrites %j -> %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it.each([
      "-5 derece",
      "–5 derece",
      "*önemli* not",
      "•madde",
      "Galatasaray - Fenerbahçe maçı bugün oynanacak",
      "Maç sonucu 2 - 1 bitti",
      "Not: - madde",
      "— tırnak",
      "Bakan açıkladı - detaylar sonra gelecek",
    ])("leaves %j untouched (no marker followed by blanks at the start)", (input) => {
      expect(tidySummaryText(input)).toBe(input);
    });

    it("a marker and nothing else is left as it is", () => {
      expect(tidySummaryText("-")).toBe("-");
      expect(tidySummaryText("•")).toBe("•");
    });
  });
});

describe("tidySummaryText CTA sentences and the placeholder (h23-live-1)", () => {
  it("da55a291: 'İşte merak edilen tüm detaylar...' goes", () => {
    const out = tidySummaryText(RAW_DA55);
    expect(out).not.toMatch(/detaylar/i);
    expect(out).toBe(before(RAW_DA55, " İşte merak edilen"));
    expect(out.endsWith("Komisyonuna sevk edildi.")).toBe(true);
  });

  it("af529f2a: 'İşte tüm detaylar!' goes, the stored ellipsis before it stays", () => {
    const out = tidySummaryText(RAW_AF52);
    expect(out).not.toMatch(/detaylar/i);
    expect(out).toBe(before(RAW_AF52, " İşte tüm detaylar"));
    expect(out.endsWith("ağır cezalar da gündemde...")).toBe(true);
  });

  it("869ffc17: the WHOLE sentence 'KYK burs ve kredi başvurularına dair detaylar haberimizde.' goes", () => {
    const out = tidySummaryText(RAW_869F);
    expect(out).toBe(before(RAW_869F, " KYK burs ve kredi başvurularına"));
    expect(out.endsWith("açıklanacak?")).toBe(true);
    expect(out).not.toContain("başvurularına");
    expect(out).not.toContain("dair");
    expect(out).not.toContain("haberimizde");
  });

  it("3a46fc27: 'Ayrıntılar birazdan...' alone gives ''", () => {
    expect(tidySummaryText(RAW_3A46)).toBe("");
  });

  it.each([
    ["Zam geldi. İşte merak edilen tüm detaylar...", "Zam geldi."],
    ["Zam geldi. İşte merak edilen tüm detaylar", "Zam geldi."],
    ["Zam geldi. İŞTE MERAK EDİLEN TÜM DETAYLAR!", "Zam geldi."],
    ["Zam geldi. İşte tüm detaylar!", "Zam geldi."],
    ["Zam geldi. İşte merak edilenler", "Zam geldi."],
    ["Zam geldi. İşte merak edilenler...", "Zam geldi."],
    ["Zam geldi… İşte tüm detaylar", "Zam geldi…"],
    ["Zam geldi. Ayrıntılar birazdan...", "Zam geldi."],
    ["Zam geldi. AYRINTILAR BİRAZDAN", "Zam geldi."],
    ["Gelişmeler şöyle: İşte tüm detaylar", "Gelişmeler şöyle"],
    ["Bakan açıklama yaptı İşte tüm detaylar", "Bakan açıklama yaptı"],
    ["Bakan açıklama yaptı Ayrıntılar birazdan", "Bakan açıklama yaptı"],
    ["Zam geldi. İşte  merak edilen   tüm detaylar", "Zam geldi."],
  ])("strips the tail of %j", (input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it.each([
    "İşte merak edilen tüm detaylar...",
    "İşte tüm detaylar!",
    "İşte merak edilenler",
    "Ayrıntılar birazdan...",
    "AYRINTILAR BİRAZDAN",
  ])("a CTA-only summary %j gives ''", (input) => {
    expect(tidySummaryText(input)).toBe("");
  });

  it.each([
    "İşte tüm detaylar ve rakamlar",
    "İşte merak edilenleri açıkladı",
    "İşte merak edilen tüm detaylarıyla",
    "Ayrıntılar birazdan açıklanacak",
    "Ayrıntılar birazdan sonra gelecek.",
    "Bakan açıklama yaptı ayrıntılar birazdan",
  ])("does not strip %j", (input) => {
    expect(tidySummaryText(input)).toBe(input);
  });

  describe("a lower-case CTA phrase ends a short last sentence", () => {
    it("the whole trailing sentence goes back to the previous sentence mark", () => {
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, detaylar haberimizde")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, detaylar haberimizde.")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, detaylar haberimizde...")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, işte detaylar")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı işte ayrıntılar!")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, işte tüm detaylar")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, işte merak edilen tüm detaylar")).toBe("Zam geldi.");
      expect(tidySummaryText("Zam geldi. Bakan açıklama yaptı, işte merak edilenler")).toBe("Zam geldi.");
    });

    it("the previous mark may be a question mark, an exclamation mark, an ellipsis or a quote", () => {
      expect(tidySummaryText("Zam gelecek mi? KYK burs sonuçlarına dair detaylar haberimizde.")).toBe("Zam gelecek mi?");
      expect(tidySummaryText("Zam geldi! KYK burs sonuçlarına dair detaylar haberimizde.")).toBe("Zam geldi!");
      expect(tidySummaryText("Zam geldi… KYK burs sonuçlarına dair detaylar haberimizde.")).toBe("Zam geldi…");
      expect(tidySummaryText("Dedi ki “hazırız.” KYK burs sonuçlarına dair detaylar haberimizde.")).toBe(
        "Dedi ki “hazırız.”",
      );
    });

    it("the trailing sentence is at most 90 characters (code points): 90 goes, 91 stays", () => {
      const tail = " detaylar haberimizde.";
      expect(tail).toHaveLength(22);
      const at90 = `Zam geldi. ${"a".repeat(68)}${tail}`;
      const at91 = `Zam geldi. ${"a".repeat(69)}${tail}`;
      expect(tidySummaryText(at90)).toBe("Zam geldi.");
      expect(tidySummaryText(at91)).toBe(at91);
    });

    it("the length is counted in code points, not UTF-16 units", () => {
      const sentence = `${"😀".repeat(50)} detaylar haberimizde.`;
      expect(sentence.length).toBeGreaterThan(90);
      expect([...sentence].length).toBeLessThanOrEqual(90);
      expect(tidySummaryText(`Zam geldi. ${sentence}`)).toBe("Zam geldi.");
    });

    it("with no earlier sentence mark the text is left alone (the cut would empty it)", () => {
      expect(tidySummaryText("Bakan açıklama yaptı, detaylar haberimizde")).toBe(
        "Bakan açıklama yaptı, detaylar haberimizde",
      );
      expect(tidySummaryText("Bakan açıklama yaptı işte detaylar")).toBe("Bakan açıklama yaptı işte detaylar");
    });

    it("stacked: a CTA after punctuation goes first, then the lower-case sentence", () => {
      expect(tidySummaryText("Zam geldi. Bakan açıkladı, detaylar haberimizde. Devamını oku")).toBe("Zam geldi.");
    });

    it("the English and older Turkish phrases never take this path", () => {
      for (const s of [
        "Fire broke out. experts say you can read more",
        "Fire broke out. you can click to continue",
        "Zam geldi. daha fazlası için devamını oku",
        "Zam geldi. ayrıntılar için devamı için tıklayın",
        "Zam geldi. bu konuda ayrıntılar birazdan",
      ]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });

    it("a lower-case phrase that is followed by more text is not a tail", () => {
      expect(tidySummaryText("Zam geldi. Bakan dedi ki detaylar haberimizde yer alıyor")).toBe(
        "Zam geldi. Bakan dedi ki detaylar haberimizde yer alıyor",
      );
    });
  });
});

describe("tidySummaryText h23 idempotence and robustness", () => {
  const OUTPUT_FIXTURES: readonly string[] = [
    "Cumhurbaşkanı Erdoğan, \"Türk dünyasının aile fotoğrafında ayrılığa, gayrılığa, ihtilafa yer yoktur. Hepimiz biriz, beraberiz, ezelden ebede kadar inşallah kardeşiz\" dedi Cumhurbaşkanı Erdoğan, Beştepe Millet Sergi Salonu'nda \"Türk Yüzyılı: Dilde, Fikirde, İşte Birlik\" temasıyla düzenlenen Türk Devletleri Teşkilatı (TDT) Devlet Başkanları Konseyi 13. Zirvesi'nde konuştu. Konuşmasına katılımcıları selamlayarak başlayan Erdoğan, \"Dün Cumhuriyetimizin 103'üncü yıl dönümünü sizlerin katılımıyla…",
    "Cumhurbaşkanı Recep Tayyip Erdoğan, Beştepe Millet Sergi Salonu'nda 29 Ekim Cumhuriyet Bayramı ve TDT Zirvesi dolayısıyla konuk devlet başkanlarını ağırladı. Cumhurbaşkanı Erdoğan'ın açıklamalarından satır başları: Mustafa Kemal Atatürk başta olmak üzere milli mücadeleyi sevk ve idare eden tüm kadroları, tüm şehitlerimizi, gazilerimizi, Meclisimizin o dönemdeki muhterem mensuplarını rahmetle, minnetle yâd ediyorum.",
    "HABER MERKEZİ - Başkent Ankara, Türk Devletleri Teşkilatı'nın (TDT) 13. zirvesine ev sahipliği yapıyor. Cumhurbaşkanı Erdoğan'ın \"Türk dünyası olarak sarsılmaz kardeşliğimize dinamit koymak isteyenlerin karşısına inanıyorum ki yine birlik ve beraberlikle dikileceğiz.\" sözleriyle dikkat çektiği Türk Devletleri Teşkilatı 13. Zirvesi'ne katılacak liderler Türkiye'ye geldi.",
    "Cumhurbaşkanı Recep Tayyip Erdoğan şu açıklamada bulundu: 2026 Cumhurbaşkanlığı Kültür ve Sanat Büyük Ödülü’ne layık görülen çok kıymetli ilim, kültür ve sanat erbabımıza ülkemize yaptıkları eşsiz katkılar için şükranlarımı sunuyor, gönül ve fikir dünyamızın yıldızlarından Ahmed-i Hânî'yi rahmetle yad ediyorum ▪\uFE0F Bilim ve Kültür: Sabri Koz▪\uFE0F Geleneksel Sanatlar: Prof. Dr. İlhami Turan▪\uFE0F Edebiyat: Sibel Eraslan▪\uFE0F Sinema: Burçak Evren▪\uFE0F Müzik: Prof. Dr. Gönül Paçacı▪\uFE0F Vefa: Ahmed-i Hânî Trump…",
    "\"Kadınların toplum hayatında güçlü ve etkin konumları olması, medeniyet coğrafyamıza yabancı bir tecrübe değildir. Yapmamız gereken, bu tecrübeyi toplumlarımızın kültürel hassasiyetleriyle, öncelikleriyle ve sosyal gerçeklikleriyle örtüşen, Türk dünyasına özgü bir perspektife dönüştürmektir\" \"Konseyimizin kalıcı bir işbirliği zemini olmasını hedefliyoruz. Bugün Ankara'da Konseyimizin ilk adımlarını sizlerle birlikte atmış olduk.",
    "Partiden yapılan açıklamaya göre, AK Parti Kültür ve Sanat Politikaları Başkanlığı ile Teşkilat Başkanlığı işbirliğinde \"Kuruluşunun 25. İktidara Gelişinin 24. Yılında AK Parti\" paneli yapılacak. AK Parti Genel Merkezi'nde 3 Kasım Salı günü gerçekleştirilecek panelin moderatörlüğünü Genel Başkan Yardımcısı ve Kültür ve Sanat Politikaları Başkanı Hüseyin Yayman üstlenecek.",
  ];

  it("tidy(tidy(x)) === tidy(x) over every new fixture and every output", () => {
    for (const [id, raw] of H23_RAW_ALL) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), id).toBe(once);
    }
    for (const out of OUTPUT_FIXTURES) {
      expect(tidySummaryText(out), out.slice(0, 40)).toBe(out);
    }
  });

  it("is idempotent on the synthetic inputs of this block", () => {
    const FIRST = "Bakan açıklama yaptı ve kararı duyurdu.";
    const FIRST_LINE = "kelimeler ".repeat(30) + "Bitti.";
    const TAIL = "yarımkalan ".repeat(20);
    for (const x of [
      "\nSon dakika... Deprem oldu",
      "Birinci cümle.\nİlgili satır\nSon dakika... Başka haber",
      "Son dakika haberine göre; - Deprem oldu",
      "- - Deprem oldu",
      "Zam geldi. Bakan açıklama yaptı, detaylar haberimizde.",
      "Zam geldi. Bakan açıkladı, detaylar haberimizde. Devamını oku",
      "Zam geldi. İşte merak edilenler",
      clamp(`${FIRST}\nİlgili haber başlığı bitmeden\nSon dakika... ${"Başka haber ".repeat(60)}`),
      clamp(`${FIRST_LINE}\nYeni bir haber! 22 gözaltı\n${TAIL}`),
      clamp("kelimeler ".repeat(40) + "Bitti. Zirve 13. Yeni dönem " + TAIL),
      clamp("kelimeler ".repeat(40) + "Bitti. Konuşmacı Prof. Dr. Ali " + TAIL),
    ]) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once), x.slice(0, 40)).toBe(once);
    }
  });

  it("linear time on 100k-character inputs built from the new anchors", () => {
    const inputs = [
      "\nSon dakika...".repeat(7_200),
      "\nx".repeat(50_000),
      "x\n".repeat(50_000) + "Son dakika... x",
      "Son dakika haberi | ".repeat(5_000),
      "- ".repeat(50_000),
      "Son dakika haberi".concat(" ".repeat(100_000), "x"),
      "Son dakika haberine".concat(" ".repeat(100_000), "göre;"),
      "a. ".concat("Bakan açıkladı detaylar haberimizde. ".repeat(3_000)),
      "a. ".concat("x işte detaylar ".repeat(8_000)),
      "a. ".concat("işte merak edilen tüm detaylar. ".repeat(3_000), "işte tüm detaylar"),
      "x\n".repeat(248) + "a...",
      "a!\n".repeat(165) + "ab...",
      "1. ".repeat(165) + "ab...",
      "Dr. ".repeat(124) + "ab...",
    ];
    const start = performance.now();
    for (const s of inputs) tidySummaryText(s);
    expect(performance.now() - start).toBeLessThan(1500);
  });

  it("never throws on a clamp-shaped text of odd characters with newlines and marks", () => {
    for (const s of [
      "😀\n".repeat(166) + "..",
      "\ud83d\n".repeat(249) + "...",
      "!\n".repeat(249) + "...",
      ".\n".repeat(249) + "...",
      "1.\n".repeat(166) + "ab...",
    ]) {
      expect(() => tidySummaryText(s)).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// h24 follow-ups (hunt 24, 2026-11-02): the Medyascope site-name footer
// (h24-feeds-2), the leading "Son dakika haberine göre," / "Son dakika
// gelişmesi" openers, and the clamp cut that kept the first word of the next
// paragraph. The summaries below are the stored clusters.summary_tr texts
// (read-only SELECT, 2026-11-02), copied verbatim.
// ---------------------------------------------------------------------------

// 6e2ecaea: an NBSP and a blank in front of the site name.
const H24_6E2E =
  "TİP Genel Başkanı Erkan Baş, Kurtuluş Bildirgesi’nin tanıtımında muhalefetin yalnızca mitinglere ve seçimlere odaklanmasını eleştirdi.\nErkan Baş: “’Seçimlere kadar sabredelim anlayışı’ doğru değil”  Medyascope";
const H24_EAAA =
  "Mete Kaan Kaynar, Türkiye’deki seçimlerin tarihlerini ve erken seçim örneklerini inceleyerek 2028 için olası seçim takvimini değerlendirdi.\nMete Kaan Kaynar yazdı: Erken seçim ne zaman? – 2 Medyascope";
const H24_EAE2 =
  "Bakırköy Belediyesi’ne yönelik soruşturmada 39 kişi tutuklandı. Tutuklananlar arasında Abdülhamit Pehlivan ve Ali Rıza Akyüz de var.\nBakırköy Belediyesi dosyasında damacana su, hırdavat, antivirüs ihaleleri suç sayıldı Medyascope";
const H24_F481 =
  "Savcı Sayan şişenin kapağını açtı: Fon soruşturmasıyla birlikte AKP içindeki kavgalar ve hesaplaşma yeniden gündeme geldi.\nRuşen Çakır yorumladı: Savcı Sayan şişenin kapağını açtı, iktidar içindeki kavgaları kızıştırdı Medyascope";
const H24_08BF =
  "İsrail uzmanı Doç. Dr. Ferit Belder değerlendirdi: Netanyahu iktidarda kalabilir mi, aşırı sağ geriledi mi, Filistinliler için ne değişecek?\nİsrail uzmanı Doç. Dr. Ferit Belder ile söyleşi: İsrail’de seçim bitti, şimdi ne olacak? Medyascope";
// 3de687a6 and f567ccc7: the two openers.
const H24_3DE6 =
  "Son dakika haberine göre, tasfiyesine karar verilen bazı yatırım fonları hakkında kanun, Resmi Gazete'de yayımlanarak yürürlüğe girdi.";
const H24_F567 =
  "Son dakika gelişmesi... Avukat Akın Atalay, Üsküdar Belediye Başkanı Sinem Dedetaş'ın tahliye başvurusunun kabul edildiğini duyurdu. Atalay, Dedetaş'ın ev hapsi şeklindeki adli kontrol tedbiri uygulanarak cezaevinden tahliyesine karar verildiğini açıkladı.";

const H24_MEDYA_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "6e2ecaea",
    H24_6E2E,
    "TİP Genel Başkanı Erkan Baş, Kurtuluş Bildirgesi’nin tanıtımında muhalefetin yalnızca mitinglere ve seçimlere odaklanmasını eleştirdi.",
  ],
  [
    "eaaa529c",
    H24_EAAA,
    "Mete Kaan Kaynar, Türkiye’deki seçimlerin tarihlerini ve erken seçim örneklerini inceleyerek 2028 için olası seçim takvimini değerlendirdi.",
  ],
  [
    "eae25e62",
    H24_EAE2,
    "Bakırköy Belediyesi’ne yönelik soruşturmada 39 kişi tutuklandı. Tutuklananlar arasında Abdülhamit Pehlivan ve Ali Rıza Akyüz de var.",
  ],
  [
    "f481725d",
    H24_F481,
    "Savcı Sayan şişenin kapağını açtı: Fon soruşturmasıyla birlikte AKP içindeki kavgalar ve hesaplaşma yeniden gündeme geldi.",
  ],
  [
    "08bfd151",
    H24_08BF,
    "İsrail uzmanı Doç. Dr. Ferit Belder değerlendirdi: Netanyahu iktidarda kalabilir mi, aşırı sağ geriledi mi, Filistinliler için ne değişecek?",
  ],
];

describe("tidySummaryText Medyascope footer (h24-feeds-2)", () => {
  it.each(H24_MEDYA_ROWS)("%s: the echoed headline and the site name go", (_id, raw, expected) => {
    const out = tidySummaryText(raw);
    expect(out).toBe(expected);
    expect(out).not.toContain("Medyascope");
  });

  it("a one-line 'headline Medyascope' summary keeps its text (line 0 is never a footer)", () => {
    expect(tidySummaryText("Erken seçim ne zaman? Medyascope")).toBe("Erken seçim ne zaman? Medyascope");
  });

  it("the name inside a sentence is text", () => {
    const s = "Medyascope'a konuşan uzman seçimlerin yakın olduğunu söyledi.\nİkinci satır.";
    expect(tidySummaryText(s)).toBe("Medyascope'a konuşan uzman seçimlerin yakın olduğunu söyledi. İkinci satır.");
  });

  it("the footer goes together with a trailing newline or blanks", () => {
    expect(tidySummaryText("Gövde cümlesi.\nBaşlık Medyascope \n")).toBe("Gövde cümlesi.");
    expect(tidySummaryText("Gövde cümlesi.\nBaşlık Medyascope")).toBe("Gövde cümlesi.");
  });

  it("a Medyascope footer and a leading ticker are both removed", () => {
    expect(tidySummaryText("Son dakika | seçim kararı alındı.\nSeçim kararı Medyascope")).toBe(
      "Seçim kararı alındı.",
    );
  });

  it("is idempotent", () => {
    for (const [, raw, expected] of H24_MEDYA_ROWS) {
      expect(tidySummaryText(expected), expected).toBe(expected);
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once)).toBe(once);
    }
  });
});

describe("tidySummaryText leading openers (h24)", () => {
  it("3de687a6: 'Son dakika haberine göre,' goes and the sentence starts upper-case", () => {
    const out = tidySummaryText(H24_3DE6);
    expect(out).toBe(
      "Tasfiyesine karar verilen bazı yatırım fonları hakkında kanun, Resmi Gazete'de yayımlanarak yürürlüğe girdi.",
    );
    expect(out.startsWith("Son dakika")).toBe(false);
  });

  it("f567ccc7: 'Son dakika gelişmesi...' goes", () => {
    const out = tidySummaryText(H24_F567);
    expect(out).toBe(
      "Avukat Akın Atalay, Üsküdar Belediye Başkanı Sinem Dedetaş'ın tahliye başvurusunun kabul edildiğini duyurdu. Atalay, Dedetaş'ın ev hapsi şeklindeki adli kontrol tedbiri uygulanarak cezaevinden tahliyesine karar verildiğini açıkladı.",
    );
    expect(out.startsWith("Son dakika")).toBe(false);
  });

  const OPENER_CHANGES: ReadonlyArray<readonly [string, string]> = [
    // A comma is a separator after 'haberine göre' only; the next word is capitalised (tr-TR).
    ["Son dakika haberine göre, kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["Son dakika haberine göre, işçiler greve çıktı.", "İşçiler greve çıktı."],
    ["Son dakika haberine göre, ılık hava geliyor.", "Ilık hava geliyor."],
    ["Son dakika haberine göre, çocuklar okula başladı.", "Çocuklar okula başladı."],
    ["Son dakika haberine göre, öğrenciler sınava girdi.", "Öğrenciler sınava girdi."],
    ["Son dakika haberine göre, şehir sular altında.", "Şehir sular altında."],
    ["Son dakika haberine göre , kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["SON DAKİKA HABERİNE GÖRE, kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["Son dakika haberine göre,kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["Son dakika haberine göre, Kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["Son dakika haberine göre, istanbul'da yangın çıktı.", "İstanbul'da yangın çıktı."],
    ["Son dakika haberine göre; kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["Son dakika haberine göre: kentte yangın çıktı.", "Kentte yangın çıktı."],
    ["Son dakika haberine göre... kentte yangın çıktı.", "Kentte yangın çıktı."],
    // 'gelişmesi' with every separator the other tickers take.
    ["Son dakika gelişmesi: Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi... Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi! Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi | Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi; Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi… Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi. Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi!!! Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelismesi: Deprem oldu.", "Deprem oldu."],
    ["SON DAKİKA GELİŞMESİ: Deprem oldu.", "Deprem oldu."],
    ["Son Dakika Gelişmesi! Deprem oldu.", "Deprem oldu."],
    ["Son  dakika   gelişmesi  ... Deprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi:\nDeprem oldu.", "Deprem oldu."],
    ["Son dakika gelişmesi: deprem oldu.", "Deprem oldu."],
    // The first word is upper-cased after any stripped ticker, not only after the new ones.
    ["Son dakika | deprem oldu.", "Deprem oldu."],
    ["Son dakika haberi: deprem oldu.", "Deprem oldu."],
    ["SON DAKİKA: ışık yandı.", "Işık yandı."],
    // A ticker and a list marker, in either order.
    ["Son dakika | - deprem oldu.", "Deprem oldu."],
    ["- Son dakika: deprem oldu.", "Deprem oldu."],
    // Stacked tickers.
    ["Son dakika haberine göre, son dakika gelişmesi: deprem oldu.", "Deprem oldu."],
    // A word with an inner capital, a digit, a quote or a non-lower-case letter is never upper-cased.
    ["Son dakika | iPhone 18 satışa çıktı", "iPhone 18 satışa çıktı"],
    ["Son dakika gelişmesi: eBay satışı durduruldu", "eBay satışı durduruldu"],
    ["Son dakika: iOS 20 yayında", "iOS 20 yayında"],
    ["Son dakika: 5 kişi yaralandı", "5 kişi yaralandı"],
    ["Son dakika: \"deprem\" dedi", "\"deprem\" dedi"],
    ["Son dakika: ABD açıkladı", "ABD açıkladı"],
    ["Son dakika: ßtest açıklandı", "ßtest açıklandı"],
    // A word glued to a hyphen, a dot, a digit or a combining mark is a name or an
    // address, not the start of a sentence.
    ["Son dakika: e-devlet sistemi çöktü", "e-devlet sistemi çöktü"],
    ["Son dakika: tayfhaber.com yayında", "tayfhaber.com yayında"],
    ["Son dakika: iphone17 çıktı", "iphone17 çıktı"],
    ["Son dakika: i\u0307stanbul", "i\u0307stanbul"],
    // A one-letter word is still a word.
    ["Son dakika haberine göre, o gün kentte yangın çıktı.", "O gün kentte yangın çıktı."],
    // Other scripts follow the same lower-case rule.
    ["Son dakika: élysée açıklaması", "Élysée açıklaması"],
  ];

  it.each(OPENER_CHANGES)("rewrites %j -> %j", (input, expected) => {
    expect(tidySummaryText(input)).toBe(expected);
  });

  it.each([
    "Son dakika golüyle Galatasaray kazandı.",
    "Son dakikada gelen golle Galatasaray kazandı.",
    "Son dakika haberi olarak duyuruldu.",
    "Son dakika gelişmesi olarak duyuruldu.",
    "Son dakika haberine göre kentte yangın çıktı.",
    "Son dakika gelişmesi kentte yangın çıkardı.",
    "Son dakika gelişmeleri: kentte yangın çıktı.",
    "Son dakika gelişmesinde yangın çıktı.",
    "Son dakika haberine göre",
    "Son dakika gelişmesi",
    // The comma is a separator after 'haberine göre' only.
    "Son dakika, kentte yangın çıktı.",
    "Son dakika haberi, kentte yangın çıktı.",
    "Son dakika gelişmesi, kentte yangın çıktı.",
    "Deprem oldu. Son dakika gelişmesi: yeni açıklama",
  ])("leaves %j untouched (no separator, or not a ticker)", (input) => {
    expect(tidySummaryText(input)).toBe(input);
  });

  it("a list marker alone does not change the case of the first word", () => {
    expect(tidySummaryText("- kadınların toplumdaki yeri")).toBe("kadınların toplumdaki yeri");
    expect(tidySummaryText("• ılık hava")).toBe("ılık hava");
  });

  it("a ticker and nothing else gives ''", () => {
    expect(tidySummaryText("Son dakika haberine göre,")).toBe("");
    expect(tidySummaryText("Son dakika gelişmesi...")).toBe("");
  });

  it("is idempotent on every opener case", () => {
    const all = [
      H24_3DE6,
      H24_F567,
      ...OPENER_CHANGES.map(([input]) => input),
      ...OPENER_CHANGES.map(([, expected]) => expected),
    ];
    for (const x of all) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once), JSON.stringify(x)).toBe(once);
    }
  });

  it("linear time: long runs of blanks and commas finish quickly", () => {
    const inputs = [
      "Son dakika haberine".concat(" ".repeat(100_000), "göre, x"),
      "Son dakika haberine göre".concat(",".repeat(100_000)),
      "Son dakika gelişmesi".concat(" ".repeat(100_000), "x"),
      "Son dakika gelişmesi: ".repeat(5_000),
      "Son dakika haberine göre, ".repeat(5_000),
    ];
    const start = performance.now();
    for (const s of inputs) tidySummaryText(s);
    expect(performance.now() - start).toBeLessThan(1500);
  });
});

describe("tidySummaryText clamp word-cut at a line break (h24, 4ca344b8)", () => {
  // 11 characters, no sentence mark: every cut below falls on a word.
  const UNIT = "bir iki üç ";
  const w = (n: number) => "w".repeat(n);

  it("4ca344b8: the cut stops at the paragraph end, 'Trump' (first word of the next paragraph) is gone", () => {
    expect(RAW_4CA3).toHaveLength(500);
    const out = tidySummaryText(RAW_4CA3);
    expect(out.endsWith("Vefa: Ahmed-i Hânî…")).toBe(true);
    expect(out).not.toContain("Trump");
    expect(out).not.toContain("...");
    expect(out).toBe(
      "Cumhurbaşkanı Recep Tayyip Erdoğan şu açıklamada bulundu: 2026 Cumhurbaşkanlığı Kültür ve Sanat Büyük Ödülü’ne layık görülen çok kıymetli ilim, kültür ve sanat erbabımıza ülkemize yaptıkları eşsiz katkılar için şükranlarımı sunuyor, gönül ve fikir dünyamızın yıldızlarından Ahmed-i Hânî'yi rahmetle yad ediyorum. Bilim ve Kültür: Sabri Koz▪️ Geleneksel Sanatlar: Prof. Dr. İlhami Turan▪️ Edebiyat: Sibel Eraslan▪️ Sinema: Burçak Evren▪️ Müzik: Prof. Dr. Gönül Paçacı▪️ Vefa: Ahmed-i Hânî…",
    );
  });

  it("the whole cut paragraph goes, not only its first word", () => {
    // 'Trump söyledi k' is the clamped last line: the word cut alone kept 'Trump söyledi'.
    const raw = clamp(`${w(480)}\n\nTrump söyledi ki konuşma sürdü`);
    expect(raw).toHaveLength(500);
    expect(tidySummaryText(raw)).toBe(`${w(480)}…`);
  });

  describe("the 60% bar: the last line break must keep at least 60% of the clamped text", () => {
    // 0.6 * 497 = 298.2: a break at index 298 is too early, a break at 299 is enough.
    it("a break at index 298 keeps today's word cut", () => {
      const out = tidySummaryText(clamp(`${w(298)}\n${UNIT.repeat(40)}`));
      expect(out).toBe(`${w(298)} ${UNIT.repeat(17)}bir iki üç…`);
    });

    it("a break at index 299 is the cut", () => {
      expect(tidySummaryText(clamp(`${w(299)}\n${UNIT.repeat(40)}`))).toBe(`${w(299)}…`);
    });

    it("a break at index 300 is the cut", () => {
      expect(tidySummaryText(clamp(`${w(300)}\n${UNIT.repeat(40)}`))).toBe(`${w(300)}…`);
    });

    it("a break late in the text is the cut, a clamp that ends in a blank included", () => {
      expect(tidySummaryText(clamp(`${w(400)}\n${UNIT.repeat(40)}`))).toBe(`${w(400)}…`);
      expect(tidySummaryText(clamp(`${w(450)}\n${UNIT.repeat(40)}`))).toBe(`${w(450)}…`);
    });

    it("a synthetic 500-char clamp whose last break is before 60% keeps today's word cut", () => {
      const raw = clamp(`${w(100)}\n${UNIT.repeat(40)}`);
      expect(raw).toHaveLength(500);
      expect(tidySummaryText(raw)).toBe(`${w(100)} ${UNIT.repeat(35)}bir iki üç…`);
    });

    it("an early break and a late break: only the LAST break counts, and the cut keeps the earlier lines", () => {
      const raw = clamp(`${w(100)}\n${w(250)}\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(100)} ${w(250)}…`);
    });

    it("two early breaks (both before 60%): today's word cut", () => {
      const raw = clamp(`${w(100)}\n${w(100)}\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(100)} ${w(100)} ${UNIT.repeat(26)}bir iki…`);
    });
  });

  describe("the line the cut would end on must be a paragraph (hand review of the 7-day corpus)", () => {
    // e345d54d, 9c4dc3ea, 3da4c962 and 307cf42b: a short unpunctuated line in front of the
    // break is a heading, a related headline or a "Name:" label. Cutting there ended the
    // summary on that line and dropped the real text after it, so the word cut stays.
    const HEADLINE = "İstanbul'da kuvvetli yağış: Yollar göle döndü";
    const LABEL = "Kırgızistan Cumhurbaşkanı Sadır Caparov'un eşi Aygül Caparova:";
    const HEADING = "İSTANBUL'DA İKİ SİLAHLI SALDIRI AYDINLATILDI";

    it("a related headline in front of the break: today's word cut", () => {
      const raw = clamp(`${w(270)}\n${HEADLINE}\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(270)}. ${HEADLINE} ${UNIT.repeat(16)}bir…`);
    });

    it("a 'Name:' label in front of the break: today's word cut", () => {
      const raw = clamp(`${w(250)}\n${LABEL}\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(250)}. ${LABEL} ${UNIT.repeat(16)}bir…`);
    });

    it("a heading in capitals in front of the break: today's word cut", () => {
      const raw = clamp(`${w(270)}\n${HEADING}\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(270)}. ${HEADING} ${UNIT.repeat(16)}bir…`);
    });

    it("120 characters is still a short line, 121 is a paragraph", () => {
      expect(tidySummaryText(clamp(`${w(200)}\n${w(120)}\n${UNIT.repeat(40)}`))).toBe(
        `${w(200)} ${w(120)} ${UNIT.repeat(15)}bir iki…`,
      );
      expect(tidySummaryText(clamp(`${w(200)}\n${w(121)}\n${UNIT.repeat(40)}`))).toBe(`${w(200)} ${w(121)}…`);
    });

    it("a long quoted paragraph (closing quote, no sentence mark) in front of the break is the cut", () => {
      const raw = clamp(`${w(200)}\n"${w(150)}"\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(200)} "${w(150)}"…`);
    });

    it("a short line that ends in a sentence mark is a sentence end, which wins as before", () => {
      const raw = clamp(`${w(300)}\nKısa ama noktalı satır.\n${UNIT.repeat(40)}`);
      expect(tidySummaryText(raw)).toBe(`${w(300)}. Kısa ama noktalı satır.`);
    });
  });

  it("a clamp with no line break is unchanged from HEAD", () => {
    const raw = clamp(UNIT.repeat(60));
    expect(raw).toHaveLength(500);
    expect(tidySummaryText(raw)).toBe(`${UNIT.repeat(44)}bir iki üç…`);
  });

  it("a complete last paragraph (the clamp fell inside the FIRST word after its line break) is kept", () => {
    // 473 + "\n" + 19 + "\n" + "Tru": nothing of the stub survives the word cut, so the
    // paragraph before it is complete and stays, exactly as at HEAD.
    const raw = clamp(`${w(473)}\nikinci paragraf tam\nTrump söyledi`);
    expect(raw).toHaveLength(500);
    expect(tidySummaryText(raw)).toBe(`${w(473)} ikinci paragraf tam…`);
  });

  it("a clamp that fell right after a line break keeps the paragraph before it", () => {
    const raw = clamp(`${w(473)}\nikinci paragraf tam\n\n\nTrump söyledi`);
    expect(raw).toHaveLength(500);
    expect(tidySummaryText(raw)).toBe(`${w(473)} ikinci paragraf tam…`);
  });

  it("a sentence end that keeps 60% still wins over the line break", () => {
    const raw = clamp(`${w(299)}. ${UNIT.repeat(5)}\n${UNIT.repeat(40)}`);
    expect(tidySummaryText(raw)).toBe(`${w(299)}.`);
  });

  it("never turns a clamp into ''", () => {
    // Everything in front of the break is blank: the cut would be empty, so the
    // clamp repair steps aside and the text is tidied as it is.
    const raw = clamp(`${" ".repeat(300)}\n${"word ".repeat(60)}`);
    expect(raw).toHaveLength(500);
    const out = tidySummaryText(raw);
    expect(out).not.toBe("");
    expect(out.startsWith("word word")).toBe(true);
  });

  it("is idempotent on every clamp case", () => {
    const raws = [
      RAW_4CA3,
      clamp(`${w(480)}\n\nTrump söyledi ki konuşma sürdü`),
      clamp(`${w(298)}\n${UNIT.repeat(40)}`),
      clamp(`${w(299)}\n${UNIT.repeat(40)}`),
      clamp(`${w(100)}\n${UNIT.repeat(40)}`),
      clamp(`${w(100)}\n${w(250)}\n${UNIT.repeat(40)}`),
      clamp(`${w(100)}\n${w(100)}\n${UNIT.repeat(40)}`),
      clamp(`${w(270)}\n${"İstanbul'da kuvvetli yağış: Yollar göle döndü"}\n${UNIT.repeat(40)}`),
      clamp(`${w(200)}\n"${w(150)}"\n${UNIT.repeat(40)}`),
      clamp(`${" ".repeat(300)}\n${"word ".repeat(60)}`),
      clamp(UNIT.repeat(60)),
      clamp(`${w(473)}\nikinci paragraf tam\nTrump söyledi`),
      clamp(`${w(299)}. ${UNIT.repeat(5)}\n${UNIT.repeat(40)}`),
    ];
    for (const raw of raws) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), once.slice(-40)).toBe(once);
    }
  });
});

// ---------------------------------------------------------------------------
// h25-live-1 / h25-live-2 (hunt 25, 2026-11-02): outlet feed caps that leave a
// summary mid-word, a clamp repair that ends inside an open quote, and a
// Haberport sub-heading glued onto the body. The rows below are the live
// texts (read-only SELECT on clusters.summary_tr / articles.description).
//
// Feed caps: Haberport 202/203, Sözcü 123 and Daily Sabah 183 characters (120
// or 180 or 200 of text plus "..."), 7-day count of descriptions ending
// letter-or-digit + "..." in the articles table: haberport 203: 3569, sozcu 123:
// 1494, haberport 202: 483, daily-sabah 183: 352. No row held an astral
// character, so the PostgreSQL length is the JS .length.
// ---------------------------------------------------------------------------

/** Occurrences of the single character `ch` in `s` (no regex). */
function countChar(s: string, ch: string): number {
  let n = 0;
  for (const c of s) if (c === ch) n++;
  return n;
}

// 63232d42 / e245d316 (Haberport, 203): a heading line, then the body, cut mid-word.
const HP_KUAFOR =
  "Antakya Açıkdere'de mor eviyle fark yarattı:\nHatay'ın Antakya ilçesi Açıkdere Mahallesi'nde yaşayan Lütfiye Sönmez, en sevdiği renk olan mora boyattığı 3 katlı evinin ikinci katında açtığı kuaför salo...";
// ed3f958f / f1b9797f (Haberport, 203): "ziyaret" glued to "İçişleri", cut after "ziyaret".
const HP_ZIYARET =
  "Selçuklu'da yerel yönetim ve hizmet odaklı ziyaretİçişleri Bakanı Mustafa Çiftçi, Konya programı çerçevesinde Selçuklu Belediyesi ile Selçuklu Otizmli Bireyler Eğitim Vakfı (SOBE) merkezlerini ziyaret...";
// fca0a270 / 53586f51 (Haberport, 203): "label:Body", cut after "Resm".
const HP_ONEM =
  "ziyaretin önemi:Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor. Bu ziyaret, iki ülke arasındaki diplomasi ve ekonomik ilişkilerin detaylı şekilde ele alınacağı bir platform olarak değerlendiriliyor. Resm...";
// d06b4a01 (Haberport, 202): a heading line and a body with one sentence end.
const HP_GAZIANTEP =
  "Gaziantep'te ulaşım hizmetlerinde dijital adım\nGaziantep Büyükşehir Belediyesi, ulaşım hizmetlerinde dijital dönüşümü genişletmeye devam ediyor. Ulaşım Daire Başkanlığı tarafından geliştirilen GURTAS...";
// e8af07db (Haberport, 202): lower-case "label:Body" and a sentence end after the label.
const HP_KAZA =
  "kaza anı ve müdahale:Erzincan'ın Yavuz Selim Mahallesi'nde meydana gelen kazada, ara yoldan ana yola bisikletiyle çıkan E.S.'ye bir otomobil çarptı. Çevredeki vatandaşların ihbarı üzerine olay yerine...";
// afd1a0be (Haberport, 202): lower-case label, then a sentence end.
const HP_MAC =
  "maç özeti:Nazilli Şehir Spor, 2. haftada sahasında konuk ettiği Sazlı Gençlikspor ile taraftarları önünde 0-0 berabere kaldı. Tribünlerin dolu olduğu karşılaşmada iki ekip de aradığı golü bulamayınca...";
// afb9c9dd (Sözcü, 123): no sentence end.
const SOZCU_RUTUBET =
  "Kış aylarında dış cepheye bakan soğuk duvarlarda oluşan yoğuşma, zamanla gri küf lekelerine ve yoğun rutubet kokusuna yo...";
// 6d20e07b (Sözcü, 123): one sentence end that keeps most of the text.
const SOZCU_BALIK =
  "Polonya'da düzenlenen balıkçılık turnuvasında oltaya takılan dev yayın balığı, büyüklüğüyle herkesi şaşkına çevirdi. Tam...";
// fb5aff13 (Sözcü, 123): the cap fell inside an open quotation.
const SOZCU_TIRNAK =
  "Sermaye piyasalarındaki işlemlere yönelik yürütülen fon soruşturması kapsamında, \"suç işlemek amacıyla kurulan örgüte üy...";
// 732cacbd (Daily Sabah, 183): no sentence end.
const DS_BULGARIA =
  "Incumbent Iliana Iotova has won Bulgaria's presidential runoff by a clear margin, according to official results published Monday, making her the country's first elected woman presi...";
// 58f520c4 (Daily Sabah, 183): a sentence end, then an opened quotation.
const DS_WARS =
  "Wars triggered by Israeli provocations are exerting increased pressure on global energy prices and national economies, Vice President Cevdet Yılmaz said Monday. \"As a result of the...";
// e5d77d31 (500 characters): the ingest clamp fell inside an open quotation.
const E5D7_CLAMPED =
  "\"Ekrem İmamoğlu çıkar amaçlı suç örgütü\" davasında beyanda bulunan iş insanları Nezih Barut, Alaattin Kameroğlu, Çetin Gül ve Selahattin Özgül şikayetçi oldu. Özgül, Bakırköy'deki bir alışveriş merkezinin yönetim kurulu başkanı olduğunu ifade ederek, \"Bakırköy Belediyesinin Bülent Kerimoğlu zamanında başlayan ve yaşatılan ıstırapları söylemek istiyorum. İstanbul Cumhuriyet Başsavcılığına hem mekanik hem dijital ortamda evrakı verdik. Bunlar hiç verilmemiş gibi uygulama yaptılar ve '197 milyon...";

const H25_LIVE_RAW: ReadonlyArray<readonly [string, string]> = [
  ["63232d42 haberport kuaför", HP_KUAFOR],
  ["ed3f958f haberport ziyaret", HP_ZIYARET],
  ["fca0a270 haberport önemi", HP_ONEM],
  ["d06b4a01 haberport Gaziantep", HP_GAZIANTEP],
  ["e8af07db haberport kaza", HP_KAZA],
  ["afd1a0be haberport maç", HP_MAC],
  ["afb9c9dd sözcü rutubet", SOZCU_RUTUBET],
  ["6d20e07b sözcü balık", SOZCU_BALIK],
  ["fb5aff13 sözcü tırnak", SOZCU_TIRNAK],
  ["732cacbd daily sabah Bulgaria", DS_BULGARIA],
  ["58f520c4 daily sabah wars", DS_WARS],
  ["e5d77d31 clamp", E5D7_CLAMPED],
];

/** `len` characters of "kelime kelime ...": every cut falls inside a word. */
function kelimeText(len: number): string {
  return "kelime ".repeat(Math.ceil(len / 7)).slice(0, len);
}

/** `kelimeText(len)` whose last character is a letter (never a blank). */
function midWord(len: number): string {
  const text = kelimeText(len);
  return text.endsWith(" ") ? text.slice(0, -1) + "x" : text;
}

/** A feed-capped text: `body` cut to `len - 3` characters, then "...". */
function feedCapped(body: string, len: number): string {
  expect(body.length).toBeGreaterThanOrEqual(len - 3);
  return body.slice(0, len - 3) + "...";
}

describe("tidySummaryText outlet feed caps (h25-live-1)", () => {
  it("the live fixtures have the lengths the outlets cap at", () => {
    expect(HP_KUAFOR).toHaveLength(203);
    expect(HP_ZIYARET).toHaveLength(203);
    expect(HP_ONEM).toHaveLength(203);
    expect(HP_GAZIANTEP).toHaveLength(202);
    expect(HP_KAZA).toHaveLength(202);
    expect(HP_MAC).toHaveLength(202);
    expect(SOZCU_RUTUBET).toHaveLength(123);
    expect(SOZCU_BALIK).toHaveLength(123);
    expect(SOZCU_TIRNAK).toHaveLength(123);
    expect(DS_BULGARIA).toHaveLength(183);
    expect(DS_WARS).toHaveLength(183);
  });

  describe("live rows", () => {
    it("63232d42: no sentence end, so the partial word goes and one ellipsis is added", () => {
      const out = tidySummaryText(HP_KUAFOR);
      expect(out).toBe(
        "Antakya Açıkdere'de mor eviyle fark yarattı: Hatay'ın Antakya ilçesi Açıkdere Mahallesi'nde yaşayan Lütfiye Sönmez, en sevdiği renk olan mora boyattığı 3 katlı evinin ikinci katında açtığı kuaför…",
      );
      expect(out.endsWith("açtığı kuaför…")).toBe(true);
      expect(countChar(out, "…")).toBe(1);
      expect(out).not.toContain("...");
    });

    it("Sözcü 123 characters: 'rutubet kokusuna yo...' ends on the last whole word", () => {
      expect(tidySummaryText(SOZCU_RUTUBET)).toBe(
        "Kış aylarında dış cepheye bakan soğuk duvarlarda oluşan yoğuşma, zamanla gri küf lekelerine ve yoğun rutubet kokusuna…",
      );
    });

    it("Sözcü 123 characters: the sentence end keeps most of the text, so the cut is there", () => {
      expect(tidySummaryText(SOZCU_BALIK)).toBe(
        "Polonya'da düzenlenen balıkçılık turnuvasında oltaya takılan dev yayın balığı, büyüklüğüyle herkesi şaşkına çevirdi.",
      );
    });

    it("Daily Sabah 183 characters: no sentence end, partial word dropped", () => {
      expect(tidySummaryText(DS_BULGARIA)).toBe(
        "Incumbent Iliana Iotova has won Bulgaria's presidential runoff by a clear margin, according to official results published Monday, making her the country's first elected woman…",
      );
    });

    it("Daily Sabah 183 characters: the sentence end before the opened quotation is the cut", () => {
      expect(tidySummaryText(DS_WARS)).toBe(
        "Wars triggered by Israeli provocations are exerting increased pressure on global energy prices and national economies, Vice President Cevdet Yılmaz said Monday.",
      );
    });

    it("Haberport 202 characters: the sentence end after the heading line is the cut, and the heading line goes (h30-live-1)", () => {
      // h25 pinned "Gaziantep'te ulaşım hizmetlerinde dijital adım Gaziantep Büyükşehir
      // Belediyesi, ...": the heading run on into the first sentence. The body
      // is 97 characters, so the heading line is dropped.
      expect(tidySummaryText(HP_GAZIANTEP)).toBe(
        "Gaziantep Büyükşehir Belediyesi, ulaşım hizmetlerinde dijital dönüşümü genişletmeye devam ediyor.",
      );
    });

    it("Sözcü 123 characters: the cap inside an open quotation cuts in front of the quotation", () => {
      const out = tidySummaryText(SOZCU_TIRNAK);
      expect(out).toBe("Sermaye piyasalarındaki işlemlere yönelik yürütülen fon soruşturması kapsamında…");
      expect(countChar(out, '"') % 2).toBe(0);
    });
  });

  describe("every cap length (synthetic)", () => {
    // [length, whole words kept by the word cut, filler words in front of the sentence end,
    //  whole words kept after a sentence end that is too early]
    const CAPS: ReadonlyArray<readonly [number, number, number, number]> = [
      [123, 17, 14, 16],
      [183, 25, 22, 24],
      [202, 28, 24, 27],
      [203, 28, 24, 27],
    ];

    it.each(CAPS)("%i characters: the word cut drops the partial word and adds one ellipsis", (len, words) => {
      const raw = feedCapped(kelimeText(len), len);
      expect(raw).toHaveLength(len);
      expect(raw.endsWith("...")).toBe(true);
      expect(tidySummaryText(raw)).toBe("kelime ".repeat(words).trimEnd() + "…");
    });

    it.each(CAPS)("%i characters: a late sentence end wins over the word cut", (len, _w, filler) => {
      const raw = feedCapped("kelime ".repeat(filler) + "Bitti. " + "kelime ".repeat(40), len);
      expect(raw).toHaveLength(len);
      expect(tidySummaryText(raw)).toBe("kelime ".repeat(filler) + "Bitti.");
    });

    it.each(CAPS)("%i characters: a sentence end under 60% does not count", (len, _w, _f, after) => {
      const raw = feedCapped("Bitti. " + "kelime ".repeat(40), len);
      expect(tidySummaryText(raw)).toBe("Bitti. " + "kelime ".repeat(after).trimEnd() + "…");
    });

    it.each(CAPS)("%i characters: a digit in front of the '...' is a cut as well", (len) => {
      const raw = feedCapped("kelime ".repeat(40), len - 1).slice(0, len - 4) + "2...";
      expect(raw).toHaveLength(len);
      const out = tidySummaryText(raw);
      expect(out.endsWith("…")).toBe(true);
      expect(out).not.toContain("2");
      expect(out).not.toContain("...");
    });

    it("the 60% bar is exact at a feed cap: 72 of 120 characters passes, 71 fails", () => {
      const tail = " " + "kelime ".repeat(40);
      // k characters through the full stop; the body is 120 characters long.
      const kept = (k: number) => "a".repeat(k - 1) + "." + tail;
      expect(tidySummaryText(feedCapped(kept(72), 123))).toBe("a".repeat(71) + ".");
      const below = tidySummaryText(feedCapped(kept(71), 123));
      expect(below.endsWith("…")).toBe(true);
      expect(below.startsWith("a".repeat(70) + ". kelime")).toBe(true);
    });
  });

  describe("left alone", () => {
    it("a 150-character text ending 'Detaylar...' is not a cap length", () => {
      const lead = "Yeni düzenleme bugün Resmi Gazete'de yayımlandı ve yürürlüğe girdi, ";
      const raw = lead + "x".repeat(150 - lead.length - " Detaylar...".length) + " Detaylar...";
      expect(raw).toHaveLength(150);
      expect(tidySummaryText(raw)).toBe(raw);
    });

    it.each([100, 122, 124, 150, 182, 184, 201, 204, 300, 498, 501])(
      "a %i-character text ending letter + '...' is not a signature",
      (len) => {
        const raw = midWord(len - 3) + "...";
        expect(raw).toHaveLength(len);
        expect(tidySummaryText(raw)).toBe(raw);
      },
    );

    it.each([123, 183, 202, 203])(
      "a %i-character text whose '...' follows a blank or punctuation is left to the CTA path (HEAD output)",
      (len) => {
        for (const before of [" ", ",", "?", "!", ")", ":", '"', "”", "-", "…"]) {
          const raw = midWord(len - 3 - before.length) + before + "...";
          expect(raw).toHaveLength(len);
          // HEAD returned these as they are: no CTA phrase, no glue, no clamp.
          expect(tidySummaryText(raw), JSON.stringify(before)).toBe(raw);
        }
      },
    );

    it.each([123, 183, 202, 203])("a %i-character text that does not end in '...' is left alone", (len) => {
      for (const tail of ["xyz", "..", "…", "kelime.", "kelime.."]) {
        const raw = kelimeText(len - tail.length) + tail;
        expect(raw).toHaveLength(len);
        expect(tidySummaryText(raw), tail).toBe(raw);
      }
    });

    it("a 200-character cut followed by a CTA keeps the cut as the outlet wrote it (the signature is read off the raw input)", () => {
      const cut =
        "Libya Temsilciler Meclisinin, Türkiye ile imzalanan deniz yetki alanlarının sınırlandırılmasına ilişkin mutabakatı onaylayarak 2020 yılında aldığı boykot kararını kaldırması, Doğu Akdeniz'de yeni bir...";
      expect(cut).toHaveLength(202);
      expect(tidySummaryText(cut + "Devamı için tıklayınız")).toBe(cut);
    });

    it("a text of a cap length with a single-character ellipsis is left alone", () => {
      const raw = kelimeText(202) + "…";
      expect(raw).toHaveLength(203);
      expect(tidySummaryText(raw)).toBe(raw);
    });

    it("the 499/500 clamp keeps its behaviour (word cut and sentence end)", () => {
      expect(tidySummaryText(clamp("kelimeler ".repeat(60)))).toBe("kelimeler ".repeat(49).trimEnd() + "…");
      expect(tidySummaryText(clamp("kelimeler ".repeat(40) + "Bitti. " + "yarımkalan ".repeat(20)))).toBe(
        "kelimeler ".repeat(40) + "Bitti.",
      );
    });
  });

  it("is idempotent on every live row and every synthetic cap", () => {
    for (const [id, raw] of H25_LIVE_RAW) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), id).toBe(once);
    }
    for (const len of [123, 183, 202, 203]) {
      for (const body of ["kelime ".repeat(40), "kelime ".repeat(20) + "Bitti. " + "kelime ".repeat(40)]) {
        const once = tidySummaryText(feedCapped(body, len));
        expect(tidySummaryText(once), `${len}`).toBe(once);
      }
    }
  });
});

describe("tidySummaryText clamp repair and open quotes (h25-live-1, e5d77d31)", () => {
  // 300 characters, "Bitti." ends at 306: 61.6% of the 497-character body.
  const EARLY = "kelimeler ".repeat(30) + "Bitti. ";
  const EARLY_OUT = "kelimeler ".repeat(30) + "Bitti.";

  it("e5d77d31: the repair does not end inside the open quotation", () => {
    expect(E5D7_CLAMPED).toHaveLength(500);
    const out = tidySummaryText(E5D7_CLAMPED);
    expect(countChar(out, '"') % 2).toBe(0);
    expect(countChar(out, "“") + countChar(out, "«")).toBeLessThanOrEqual(countChar(out, "”") + countChar(out, "»"));
    // The sentence end in front of the quotation keeps 31.8% of the text, too little,
    // so the cut is in front of the quotation, with its dangling comma gone.
    expect(out).toBe(E5D7_CLAMPED.slice(0, E5D7_CLAMPED.indexOf(', "Bakırköy Belediyesinin')) + "…");
    expect(out.endsWith("ifade ederek…")).toBe(true);
    expect(out).not.toContain("istiyorum");
  });

  describe("a sentence end inside an open quotation is not a cut", () => {
    it.each([
      ["“ ”", "“", "”"],
      ["« »", "«", "»"],
      ["‘ ’", "‘", "’"],
    ])("%s: the sentence end in front of the opener wins", (_label, open) => {
      const raw = clamp(EARLY + "kelimeler ".repeat(8) + `Dedi ki ${open}hazırız. Sonra ` + "yarımkalan ".repeat(20));
      expect(tidySummaryText(raw)).toBe(EARLY_OUT);
    });

    it("a straight quotation is judged by parity", () => {
      const raw = clamp(EARLY + "kelimeler ".repeat(8) + 'Dedi ki "hazırız. Sonra ' + "yarımkalan ".repeat(20));
      expect(tidySummaryText(raw)).toBe(EARLY_OUT);
    });

    it("walks back over several rejected sentence ends", () => {
      const raw = clamp(
        EARLY + "kelimeler ".repeat(8) + 'Dedi ki “bir. İki. Üç. Dört ' + "yarımkalan ".repeat(20),
      );
      expect(tidySummaryText(raw)).toBe(EARLY_OUT);
    });

    it("a closed quotation followed by a sentence end still cuts at that end", () => {
      for (const [open, close] of [
        ["“", "”"],
        ["«", "»"],
        ["‘", "’"],
        ['"', '"'],
      ]) {
        const raw = clamp(
          "kelimeler ".repeat(30) + `Dedi ki ${open}hazırız${close} ve gitti. Sonra ` + "yarımkalan ".repeat(20),
        );
        expect(tidySummaryText(raw), open).toBe(
          "kelimeler ".repeat(30) + `Dedi ki ${open}hazırız${close} ve gitti.`,
        );
      }
    });

    it("a sentence end that closes its quotation keeps the closing mark", () => {
      for (const [open, close] of [
        ["“", "”"],
        ["«", "»"],
        ['"', '"'],
      ]) {
        const raw = clamp(
          "kelimeler ".repeat(30) + `Dedi ki ${open}hazırız.${close} Sonra ` + "yarımkalan ".repeat(20),
        );
        expect(tidySummaryText(raw), open).toBe("kelimeler ".repeat(30) + `Dedi ki ${open}hazırız.${close}`);
      }
    });

    it("a quotation that opened and closed before the cut does not matter", () => {
      const raw = clamp(
        'Başlık "kapalı alıntı" burada. ' + "kelimeler ".repeat(40) + "Bitti. " + "yarımkalan ".repeat(20),
      );
      expect(tidySummaryText(raw)).toBe('Başlık "kapalı alıntı" burada. ' + "kelimeler ".repeat(40) + "Bitti.");
    });
  });

  describe("the word cut does not end inside an open quotation either", () => {
    it.each([
      ["“", "”"],
      ["«", "»"],
      ["‘", "’"],
      ['"', '"'],
    ])("%s: cuts in front of the opener when that keeps enough, dropping the dangling comma", (open) => {
      const raw = clamp("kelimeler ".repeat(30) + `Dedi ki, ${open}hazırız ` + "yarımkalan ".repeat(40));
      expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(30) + "Dedi ki…");
    });

    it("a sentence end in front of the opener ends the cut without an ellipsis", () => {
      const raw = clamp("kelimeler ".repeat(30) + 'Bitti. "hazırız ' + "yarımkalan ".repeat(40));
      expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(30) + "Bitti.");
    });

    it("an opener too early to cut in front of keeps the word cut", () => {
      const raw = clamp('Dedi ki "hazırız ' + "kelimeler ".repeat(60));
      const out = tidySummaryText(raw);
      expect(out.startsWith('Dedi ki "hazırız kelimeler')).toBe(true);
      expect(out.endsWith("kelimeler…")).toBe(true);
    });

    it("the bar for the cut in front of an opener is 50%: 249 of 497 characters passes, 248 fails", () => {
      const at = (n: number) => "a".repeat(n) + ' "' + "kelimeler ".repeat(40);
      expect(tidySummaryText(clamp(at(249)))).toBe("a".repeat(249) + "…");
      const below = tidySummaryText(clamp(at(248)));
      expect(below.startsWith("a".repeat(248) + ' "kelimeler')).toBe(true);
      expect(below.endsWith("kelimeler…")).toBe(true);
    });

    it("a balanced quotation in front of the cut is not an opener", () => {
      const raw = clamp("kelimeler ".repeat(30) + 'Dedi ki "hazırız" ve ' + "yarımkalan ".repeat(40));
      const out = tidySummaryText(raw);
      expect(out.startsWith('kelimeler kelimeler')).toBe(true);
      expect(out).toContain('"hazırız" ve yarımkalan');
      expect(out.endsWith("yarımkalan…")).toBe(true);
    });

    it("two openers: the cut leaves a balanced text", () => {
      const raw = clamp("kelimeler ".repeat(30) + "Dedi ki “bir ve “iki " + "yarımkalan ".repeat(40));
      expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(30) + "Dedi ki…");
    });

    it("when no cut leaves the quotation closed and long enough, the repair is the one without the quote check (c526f480)", () => {
      // The whole speech is one quotation that opens at 27% of the text: nothing
      // balanced is long enough, so the last sentence end of the clamp stays.
      const out = tidySummaryText(C526_CLAMPED);
      expect(out.endsWith("sağlayacağız.")).toBe(true);
      expect(countChar(out, '"') % 2).toBe(1);
      // The same holds when the clamp holds no sentence end that keeps 60%.
      const raw = clamp('Dedi ki "hazırız ' + "kelimeler ".repeat(60));
      expect(tidySummaryText(raw)).toBe('Dedi ki "hazırız ' + "kelimeler ".repeat(48).trimEnd() + "…");
    });
  });

  it("is idempotent on every quote case", () => {
    const raws = [
      E5D7_CLAMPED,
      clamp(EARLY + "kelimeler ".repeat(8) + "Dedi ki “hazırız. Sonra " + "yarımkalan ".repeat(20)),
      clamp(EARLY + "kelimeler ".repeat(8) + "Dedi ki «hazırız. Sonra " + "yarımkalan ".repeat(20)),
      clamp(EARLY + "kelimeler ".repeat(8) + 'Dedi ki "hazırız. Sonra ' + "yarımkalan ".repeat(20)),
      clamp("kelimeler ".repeat(30) + "Dedi ki, “hazırız " + "yarımkalan ".repeat(40)),
      clamp("kelimeler ".repeat(30) + 'Bitti. "hazırız ' + "yarımkalan ".repeat(40)),
      clamp('Dedi ki "hazırız ' + "kelimeler ".repeat(60)),
      clamp("kelimeler ".repeat(30) + "Dedi ki “bir ve “iki " + "yarımkalan ".repeat(40)),
      SOZCU_TIRNAK,
    ];
    for (const raw of raws) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), once.slice(-40)).toBe(once);
    }
  });

  it("a 500-character text of quotation marks only finishes at once and stays non-empty", () => {
    const raw = clamp('"“«‘'.repeat(125));
    const start = performance.now();
    const out = tidySummaryText(raw);
    expect(performance.now() - start).toBeLessThan(100);
    expect(out).not.toBe("");
  });
});

describe("tidySummaryText glued sub-headings (h25-live-2)", () => {
  describe("a lower-case word glued to a capitalised one", () => {
    it.each([
      [
        "Selçuklu'da yerel yönetim ve hizmet odaklı ziyaretİçişleri Bakanı Mustafa Çiftçi, Konya programı çerçevesinde merkezleri gezdi.",
        "Selçuklu'da yerel yönetim ve hizmet odaklı ziyaret. İçişleri Bakanı Mustafa Çiftçi, Konya programı çerçevesinde merkezleri gezdi.",
      ],
      [
        "Meclis komisyon üyelikleri yenilendiBüyükçekmece Belediye Meclisi toplandı.",
        "Meclis komisyon üyelikleri yenilendi. Büyükçekmece Belediye Meclisi toplandı.",
      ],
      [
        "Ortaköy'de çıkan yangınıÇorum'un ilçesinde bir ev kullanılamaz hale geldi.",
        "Ortaköy'de çıkan yangını. Çorum'un ilçesinde bir ev kullanılamaz hale geldi.",
      ],
      [
        "Savcılık yeni bir soruşturmaİstanbul Cumhuriyet Başsavcılığı tarafından başlatıldı.",
        "Savcılık yeni bir soruşturma. İstanbul Cumhuriyet Başsavcılığı tarafından başlatıldı.",
      ],
      [
        "Polis uyuşturucu operasyonMersin'de düzenlendi, 5 kişi gözaltına alındı.",
        "Polis uyuşturucu operasyon. Mersin'de düzenlendi, 5 kişi gözaltına alındı.",
      ],
      ["gerilimSilivri'de yaşandı", "gerilim. Silivri'de yaşandı"],
      ["değişimUlaştırma Bakanlığı açıkladı", "değişim. Ulaştırma Bakanlığı açıkladı"],
      ["sonuçlarıErzurum’un en büyük", "sonuçları. Erzurum’un en büyük"],
      ["hamlesiBodrum'da", "hamlesi. Bodrum'da"],
    ])("splits %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it("splits every glue of one text, not only the first", () => {
      expect(tidySummaryText("kaldırıldıYenişehir açıldıKayseri başladıKonya")).toBe(
        "kaldırıldı. Yenişehir açıldı. Kayseri başladı. Konya",
      );
    });

    it("splits when the lower-case word is the whole first token and after a line break", () => {
      expect(tidySummaryText("ziyaretİçişleri Bakanı")).toBe("ziyaret. İçişleri Bakanı");
      expect(tidySummaryText("Birinci satır.\nziyaretİçişleri Bakanı")).toBe("Birinci satır. ziyaret. İçişleri Bakanı");
    });

    it("needs three lower-case letters in front of the capital", () => {
      for (const s of ["ab Cde", "iPhone 17", "eBay", "iMac", "iPad", "kWh", "mRNA", "mAh", "eVTOL", "beIN Sports"]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });

    it("an acronym behind the word is split too (h26-live-1: it used to be left alone)", () => {
      for (const [input, expected] of [
        ["toplantısıTBMM", "toplantısı. TBMM"],
        ["ettiAK Parti", "etti. AK Parti"],
        ["kutlamaCHP", "kutlama. CHP"],
        ["simgelerUNESCO", "simgeler. UNESCO"],
        ["çıkardıG20", "çıkardı. G20"],
      ] as const) {
        expect(tidySummaryText(input), input).toBe(expected);
      }
    });

    it("the lower-case run must start the token: a capitalised word, a hashtag, a quote or a path is left alone", () => {
      for (const s of [
        "TürkçedeFaddey",
        "#yerelSeçim",
        '"ankaraBüyükşehir"',
        "(açtıTürkiye)",
        "@YelizzKoray",
        "https://x.com/abcDef",
        "tayfhaber.com/haberDetay",
        "www.tayfhaber.com/haberDetay",
        "dosya_adıDeğer",
        "e-DevletKapısı",
      ]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });

    it("a CTA that was glued to the last word is stripped in the same call (idempotent)", () => {
      const once = tidySummaryText("Toplantı tamamlandıDevamını oku");
      expect(once).toBe("Toplantı tamamlandı.");
      expect(tidySummaryText(once)).toBe(once);
    });
  });

  describe("a leading lower-case label glued to its body", () => {
    it("ziyaretin önemi:Cumhurbaşkanı ... drops the label", () => {
      expect(tidySummaryText("ziyaretin önemi:Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor.")).toBe(
        "Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor.",
      );
    });

    it("drops a label of up to 81 characters and keeps one that is longer", () => {
      const label = (n: number) => "a" + "b".repeat(n - 1);
      expect(tidySummaryText(`${label(81)}:Bakan açıkladı`)).toBe("Bakan açıkladı");
      expect(tidySummaryText(`${label(82)}:Bakan açıkladı`)).toBe(`${label(82)}: Bakan açıkladı`);
    });

    it.each([
      ["ilk cümle. ikinci:Bakan açıkladı", "ilk cümle. ikinci: Bakan açıkladı"],
      ["soru? cevap:Bakan açıkladı", "soru? cevap: Bakan açıkladı"],
      ["dedi! sonra:Bakan açıkladı", "dedi! sonra: Bakan açıkladı"],
      ["bekle… sonra:Bakan açıkladı", "bekle… sonra: Bakan açıkladı"],
    ])("keeps a label that holds a sentence mark: %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it("keeps a text that starts with a capital or a digit", () => {
      expect(tidySummaryText("Ziyaretin önemi:Cumhurbaşkanı Erdoğan gidiyor")).toBe(
        "Ziyaretin önemi: Cumhurbaşkanı Erdoğan gidiyor",
      );
      expect(tidySummaryText("2026 bütçesi:Maliye Bakanı açıkladı")).toBe("2026 bütçesi: Maliye Bakanı açıkladı");
    });

    it("needs a capital right after the colon", () => {
      for (const s of ["ziyaretin önemi: Cumhurbaşkanı Erdoğan", "ziyaretin önemi:cumhurbaşkanı", "saat 10:30'da"]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });
  });

  describe("a lower-case word, a colon and a capital in the middle of a text", () => {
    it("önemi:Cumhurbaşkanı -> önemi: Cumhurbaşkanı", () => {
      expect(tidySummaryText("Ziyaretin önemi:Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor.")).toBe(
        "Ziyaretin önemi: Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor.",
      );
      expect(tidySummaryText("Marmaris'te kasım ayı kruvaziyer programı açıklandı:Muğla'nın turizm merkezleri")).toBe(
        "Marmaris'te kasım ayı kruvaziyer programı açıklandı: Muğla'nın turizm merkezleri",
      );
    });

    it("leaves digits, times and scores alone", () => {
      for (const s of ["Maç saat 10:30'da", "Saat 14:30", "Skor 2:1", "Skor 2:Bir", "TBMM'de", "NOT:Bu"]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });
  });

  describe("live rows", () => {
    it("ed3f958f: the cap and the glue are both repaired", () => {
      expect(tidySummaryText(HP_ZIYARET)).toBe(
        "Selçuklu'da yerel yönetim ve hizmet odaklı ziyaret. İçişleri Bakanı Mustafa Çiftçi, Konya programı çerçevesinde Selçuklu Belediyesi ile Selçuklu Otizmli Bireyler Eğitim Vakfı (SOBE) merkezlerini…",
      );
    });

    it("fca0a270: the cap keeps the last sentence and the label goes", () => {
      expect(tidySummaryText(HP_ONEM)).toBe(
        "Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor. Bu ziyaret, iki ülke arasındaki diplomasi ve ekonomik ilişkilerin detaylı şekilde ele alınacağı bir platform olarak değerlendiriliyor.",
      );
    });

    it("e8af07db: a lower-case label in front of a body with a sentence end", () => {
      expect(tidySummaryText(HP_KAZA)).toBe(
        "Erzincan'ın Yavuz Selim Mahallesi'nde meydana gelen kazada, ara yoldan ana yola bisikletiyle çıkan E.S.'ye bir otomobil çarptı.",
      );
    });

    it("afd1a0be: a lower-case label whose body keeps its sentence end", () => {
      const out = tidySummaryText(HP_MAC);
      expect(out.startsWith("Nazilli Şehir Spor, 2. haftada")).toBe(true);
      expect(out).not.toContain("özeti:");
      expect(out).not.toContain("...");
    });

    it("e245d316: a sub-heading followed by a line break is untouched by the glue steps", () => {
      expect(tidySummaryText("Antakya Açıkdere'de mor eviyle fark yarattı:\nHatay'ın Antakya ilçesi")).toBe(
        "Antakya Açıkdere'de mor eviyle fark yarattı: Hatay'ın Antakya ilçesi",
      );
    });
  });

  describe("brands, names, URLs and times stay byte-identical", () => {
    const NEGATIVES: readonly string[] = [
      // From the 7-day scan of live cluster summaries (hand-classified as brands).
      "BirGün",
      "BirGün gazetesi bugün yayımlandı.",
      "BirGün’ün haberine göre",
      "YouTube",
      "YouTube'da yayınlanan video",
      "“YouTube'da paylaştı”",
      "MasterChef'te",
      "MasterChef’te yarışan",
      "“MasterChef Türkiye” finali",
      "VakıfBank,",
      "VakıfBank, Halkbank'ı geçti.",
      "EuroLeague",
      "EuroLeague'in 10. haftası",
      "iPhone",
      "iPhone 17 satışa çıktı",
      "iPhone'un yeni modeli",
      "BioWare'i satın aldı",
      "ChildGen'i geliştirdi",
      "TraderTraitor saldırısı",
      '"TraderTraitor" grubu',
      "@YelizzKoray",
      "@YelizzKoray, dedi",
      "WhatsApp, TikTok ve ChatGPT",
      "PlayStation 5, MacBook Air ve PlayStation",
      "beIN Sports yayınladı",
      "BeIN Sports",
      "AstraZeneca, BioNTech ve BlackRock",
      "OpenAI’nin ChatGPT'si",
      "SpaceX roketi fırlattı",
      "GmbH'nin",
      "McGinnis, dedi",
      "ShiftDelete.net'in haberi",
      "BayraktarTB2’den atış yapıldı",
      "NeodraDynamics, açıkladı",
      "DevOps ekibi",
      "iMac, iPad ve kWh",
      "mRNA aşısı 5000 mAh pil eVTOL",
      "SözcüTV’nin",
      // URLs and paths.
      "https://x.com/abcDef",
      "Detaylar https://x.com/abcDef adresinde",
      "tayfhaber.com/haberDetay",
      "Bkz. tayfhaber.com/haberDetay sayfası",
      "https://t.co/g5McIyrZt3",
      "https://t.co/g5McIyrZt3—",
      // Times, scores, abbreviations, hashtags.
      "saat 10:30'da",
      "Maç saat 10:30'da başlayacak",
      "14:30",
      "2:1",
      "TBMM'de",
      "T.C.",
      "T.C. Cumhurbaşkanlığı",
      "A.Ş.",
      "A.Ş.'nin",
      "#yerelSeçim",
      "#yerelSeçim hakkında",
      "#MilliTeknolojiHamlesi",
    ];

    it.each(NEGATIVES)("leaves %j untouched", (s) => {
      expect(tidySummaryText(s)).toBe(s);
    });
  });

  it("is idempotent on every glue fixture and every output", () => {
    const inputs = [
      "Selçuklu'da yerel yönetim ve hizmet odaklı ziyaretİçişleri Bakanı Mustafa Çiftçi, Konya",
      "Meclis komisyon üyelikleri yenilendiBüyükçekmece Belediye Meclisi toplandı.",
      "Ortaköy'de çıkan yangınıÇorum'un ilçesinde bir ev kullanılamaz hale geldi.",
      "Savcılık yeni bir soruşturmaİstanbul Cumhuriyet Başsavcılığı",
      "Polis uyuşturucu operasyonMersin'de düzenlendi",
      "ziyaretin önemi:Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor.",
      "Ziyaretin önemi:Cumhurbaşkanı Erdoğan Güney Kore'ye gidiyor.",
      "a:B c:D e:F",
      "abcDef ghi:Jkl mnoPqr:Stu",
      "abc:Def:Ghi",
      "Toplantı tamamlandıDevamını oku",
      "kaldırıldıYenişehir açıldıKayseri başladıKonya",
      "odaklıZiyaret:Cumhurbaşkanı Erdoğan",
      ...H25_LIVE_RAW.map(([, raw]) => raw),
    ];
    for (const x of inputs) {
      const once = tidySummaryText(x);
      expect(tidySummaryText(once), JSON.stringify(x)).toBe(once);
    }
  });

  it("runs in linear time on 200k-character inputs", () => {
    const inputs = [
      "a".repeat(200_000),
      "a".repeat(200_000) + "Bc",
      "ab:".repeat(66_667),
      "ab:A ".repeat(40_000),
      "aaaB ".repeat(40_000),
      "abcdefghij".repeat(20_000),
      "a ".repeat(100_000),
      "a:".repeat(100_000),
      "ç".repeat(100_000) + "İ" + "ç".repeat(100_000),
      "a" + " ".repeat(200_000) + "bcD",
    ];
    const start = performance.now();
    for (const s of inputs) tidySummaryText(s);
    expect(performance.now() - start).toBeLessThan(1500);
    expect(tidySummaryText("a".repeat(200_000) + "Bc")).toBe("a".repeat(200_000) + ". Bc");
  });
});

describe("tidySummaryText clamp repair: abbreviation dots, glued final sentence, acronym glue (h26-live-1, regression of #173)", () => {
  // The raw clusters.summary_tr of the 12 hunt-26 ids (read-only SELECT,
  // 2026-11-02), kept verbatim in tests/fixtures/summary-tidy-h26.json.
  const H26: ReadonlyMap<string, string> = new Map(
    (h26Fixtures as ReadonlyArray<{ id8: string; raw: string }>).map((f) => [f.id8, f.raw]),
  );
  const raw26 = (id8: string): string => {
    const raw = H26.get(id8);
    if (raw === undefined) throw new Error(`missing fixture ${id8}`);
    return raw;
  };

  // Every output below was read by hand against its raw text.
  const EXPECTED: ReadonlyArray<readonly [string, string]> = [
    // (a) a cut that used to end on an abbreviation dot.
    [
      "7765376d",
      "President Recep Tayyip Erdoğan sent a congratulatory message to Azerbaijani President Ilham Aliyev and the Azerbaijani people ahead of the country's Nov. 8 Victory Day while…",
    ],
    [
      "65cb64f9",
      "İbn Haldun Üniversitesi Mütevelli Heyeti Başkan Vekili Necmeddin Bilal Erdoğan, Tokyo'da düzenlenen 'Sultan II. Abdülhamid Döneminde Türk-Japon İlişkileri ve…",
    ],
    [
      "40a6fa6e",
      "Eski Millî Eğitim Bakanı Prof. Dr. Hüseyin Çelik, Sultan II. Abdülhamid üzerine yaptığı akademik araştırmalar ve doktora tez sürecine dair çarpıcı açıklamalarda bulundu Eski Millî Eğitim Bakanı Prof. Dr. Hüseyin Çelik, Sultan II. Abdülhamid üzerine yaptığı akademik araştırmalar ve doktora tez sürecine dair çarpıcı açıklamalarda bulundu.",
    ],
    [
      "d3592ddc",
      "MV Aroyat'ın boğaz geçişi: Karadeniz'de Eylül ayı sonlarında Ukrayna'ya ait bir insansız hava aracı tarafından hedef alınarak ağır hasar gören Palau bayraklı, Kiva Marine Ltd. işletmesindeki MV…",
    ],
    // (b) a glued final sentence is a sentence end.
    [
      "db625c4a",
      "Olayın gelişimi. Çorum'un Alaca ilçesinde Yıldızhan Mahallesi Orhun Sokak'ta çıkan yangında, Fahrettin Maaşlı'ya ait bir tandır ve depo zarar gördü. Yangının çıkış nedeni henüz belirlenemedi.",
    ],
    [
      "91a4d62a",
      "Polonya Anayasa Mahkemesi'nin yeni üyelerinin atanması konusunda cumhurbaşkanı ile hükümet arasında yaşanan gerilim AB gündemine taşındı. Avrupa Komisyonu, 8 yeni üyenin atanmasının parlamentonun anayasal yetkileri kapsamında olduğunu açıkladı Polonya Anayasa Mahkemesi'nin yeni üyelerinin atanması konusunda cumhurbaşkanı ile hükümet arasında yaşanan gerilim AB gündemine taşındı. Avrupa Komisyonu, 8 yeni üyenin atanmasının parlamentonun anayasal yetkileri kapsamında olduğunu açıkladı.",
    ],
    [
      "1b58d142",
      "İran ile Batı arasındaki gerilim enerji cephesinde de büyüyor İran ile Batı arasındaki gerilim enerji cephesinde de büyüyor. Almanya Başbakanı Friedrich Merz, İran'a karşı savaşın Avrupa'ya enerji maliyetleri üzerinden 100 milyar euronun üzerinde ek yük getirdiğini açıklarken, İran Dışişleri Bakanı Abbas Arakçi'den sert yanıt geldi. Tahran, yeni bir saldırının çok daha ağır sonuçlar doğurabileceği mesajını verdi.",
    ],
    // (c) an acronym glued behind a lower-case word.
    [
      "6a397264",
      "ASELSAN LIFELINE HLM ile TÜSEB prestij ödülünü aldı. ASELSAN, geliştirdiği LIFELINE HLM Kalp Akciğer Makinesi ile TÜSEB tarafından verilen prestij ödülüne değer bulundu.",
    ],
    [
      "dfa18eca",
      "Fon mağdurlarının ödemesi devletten değil manipülasyon yapanlardan karşılanacak. TBMM Başkanvekili ve AK Parti Tokat Milletvekili Yusuf Beyazıt, Tokat'ta basın mensuplarıyla bir araya gelerek fonlarla…",
    ],
    [
      "00ddca16",
      "Rubio'nun açıklamaları Karadeniz gündemini öne çıkardı. G20 Dışişleri Bakanları Toplantısı'nın ardından Atlanta'da basın mensuplarının sorularını yanıtlayan ABD Dışişleri Bakanı Marco Rubio…",
    ],
    [
      "0dfe7899",
      "Ekim ayı danışma meclisi toplantısı. AK Parti Erzincan teşkilatı, Ekim ayı Danışma Meclisi Toplantısı'nı gerçekleştirdi. Toplantıda öncelikli olarak teşkilat çalışmaları ele alınırken, birlik ve…",
    ],
    [
      "cfdf076d",
      "AK Parti Mersin teşkilatlarından eski yöneticilere vefa ziyareti. AK Parti Mersin İl Başkanı Adem Aldemir, partinin kuruluşundan bu yana teşkilatlarda görev almış isimlere yönelik kapsamlı bir vefa…",
    ],
  ];

  it("holds the 12 live rows, each a clamp or feed-cap signature", () => {
    expect(H26.size).toBe(12);
    for (const [id8, raw] of H26) {
      expect(raw.endsWith("..."), id8).toBe(true);
      expect([183, 202, 203, 499, 500], id8).toContain(raw.length);
    }
  });

  it.each(EXPECTED)("%s: the exact output", (id8, expected) => {
    expect(tidySummaryText(raw26(id8))).toBe(expected);
  });

  describe("(a) the cut does not end on an abbreviation dot", () => {
    it.each(["7765376d", "65cb64f9", "40a6fa6e", "d3592ddc"])("%s", (id8) => {
      const out = tidySummaryText(raw26(id8));
      for (const tail of ["Nov.", "II.", "Ltd."]) expect(out.endsWith(tail), tail).toBe(false);
      expect(out.endsWith(".") || out.endsWith("…")).toBe(true);
    });

    it("7765376d, 65cb64f9 and d3592ddc end on a word cut, 40a6fa6e on the previous real sentence end", () => {
      for (const id8 of ["7765376d", "65cb64f9", "d3592ddc"]) {
        expect(tidySummaryText(raw26(id8)).endsWith("…"), id8).toBe(true);
      }
      expect(tidySummaryText(raw26("40a6fa6e")).endsWith("çarpıcı açıklamalarda bulundu.")).toBe(true);
    });
  });

  describe("(b) a glued final sentence is kept", () => {
    it("db625c4a keeps 'Yangının çıkış nedeni henüz belirlenemedi.'", () => {
      const out = tidySummaryText(raw26("db625c4a"));
      expect(out.endsWith(" Yangının çıkış nedeni henüz belirlenemedi.")).toBe(true);
      expect(out).not.toContain("Müdahale");
    });

    it("91a4d62a keeps the 'Avrupa Komisyonu, 8 yeni üyenin atanmasının ... açıkladı.' sentence", () => {
      const out = tidySummaryText(raw26("91a4d62a"));
      expect(
        out.endsWith(
          "Avrupa Komisyonu, 8 yeni üyenin atanmasının parlamentonun anayasal yetkileri kapsamında olduğunu açıkladı.",
        ),
      ).toBe(true);
      expect(out).not.toContain("Avrupa Ko…");
    });

    it("1b58d142 keeps 'Tahran, ... mesajını verdi.' and drops the glued heading behind it", () => {
      const out = tidySummaryText(raw26("1b58d142"));
      expect(out.endsWith(" Tahran, yeni bir saldırının çok daha ağır sonuçlar doğurabileceği mesajını verdi.")).toBe(true);
      expect(out).not.toContain("ARAKÇİ");
    });

    it("a synthetic glued last sentence is a candidate cut (the 60% bar is on the unglued text)", () => {
      const raw = clamp("kelimeler ".repeat(30) + "Bitti.Son cümle bitti.Yarım " + "kalan ".repeat(40));
      expect(tidySummaryText(raw)).toBe("kelimeler ".repeat(30) + "Bitti. Son cümle bitti.");
    });

    it("the clamp signature stays on the raw length: gluing is not a way into the repair", () => {
      // 498 characters ending "...", two glued sentence marks: the glue adds 2 and
      // would make 500, but the raw text is not a clamp. It keeps its "...".
      const raw = "kelimeler ".repeat(30) + "Bitti.Son cümle bitti.Yarım " + "kalan ".repeat(27) + "kalan...";
      expect(raw).toHaveLength(498);
      expect(tidySummaryText(raw)).toBe(
        "kelimeler ".repeat(30) + "Bitti. Son cümle bitti. Yarım " + "kalan ".repeat(27) + "kalan...",
      );
    });

    it("the appended-ticker repair is still the cut at the first line, with no ellipsis", () => {
      const first = "Bakan açıklama yaptı.Karar duyuruldu.";
      const raw = clamp(`${first}\nSon dakika... ${"Başka haber ".repeat(60)}`);
      expect(tidySummaryText(raw)).toBe("Bakan açıklama yaptı. Karar duyuruldu.");
    });
  });

  describe("(c) an acronym glued behind a lower-case word is split", () => {
    it.each([
      ["6a397264", "aldı. ASELSAN,"],
      ["dfa18eca", "karşılanacak. TBMM Başkanvekili"],
      ["00ddca16", "çıkardı. G20 Dışişleri"],
      ["0dfe7899", "toplantısı. AK Parti"],
      ["cfdf076d", "ziyareti. AK Parti"],
    ])("%s has %j", (id8, expected) => {
      expect(tidySummaryText(raw26(id8))).toContain(expected);
    });

    it.each([
      ["Meclis toplantısıTBMM Başkanı konuştu.", "Meclis toplantısı. TBMM Başkanı konuştu."],
      ["Parti etkinliği düzenlediAK Parti il başkanı", "Parti etkinliği düzenledi. AK Parti il başkanı"],
      ["zirve sonrası açıklamaG20 liderleri", "zirve sonrası açıklama. G20 liderleri"],
      ["bakan konuştuABD ile görüştü", "bakan konuştu. ABD ile görüştü"],
    ])("splits %j", (input, expected) => {
      expect(tidySummaryText(input)).toBe(expected);
    });

    it("an acronym-glued CTA is peeled in the same call (idempotent)", () => {
      const once = tidySummaryText("Toplantı tamamlandıDEVAMI İÇİN TIKLAYIN");
      expect(once).toBe("Toplantı tamamlandı.");
      expect(tidySummaryText(once)).toBe(once);
    });
  });

  describe("abbreviation dots in a synthetic clamp", () => {
    const PRE = "kelimeler ".repeat(40) + "Bitti. ";
    const PREV = "kelimeler ".repeat(40) + "Bitti.";
    const REST = "yarımkalan ".repeat(20);
    const build = (mid: string) => clamp(`${PRE}${mid} ${REST}`);

    it.each(["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X", "XI", "XIV", "XIX", "XX", "XXIX", "XXXIX"])(
      "the Roman numeral '%s.' is not a sentence end",
      (roman) => {
        expect(tidySummaryText(build(`Sultan ${roman}. Abdülhamid döneminde`))).toBe(PREV);
      },
    );

    it.each(["ABD", "NATO", "VIP", "XL", "CD", "MIX", "XXXX", "ii", "iv", "Mart"])(
      "'%s.' is not a Roman numeral: it ends the sentence",
      (word) => {
        expect(tidySummaryText(build(`Konuşmacı ${word}. Ali Veli`))).toBe(`${PRE}Konuşmacı ${word}.`);
      },
    );

    it.each([
      "Jan", "Feb", "Mar", "Apr", "Jun", "Jul", "Aug", "Sep", "Sept", "Oct", "Nov", "Dec",
      "Ltd", "Inc", "Co", "Corp", "Şti", "Mr", "Mrs", "Ms", "Jr", "St",
      "NOV", "LTD", "INC", "ŞTİ", "ltd", "inc",
    ])("the abbreviation '%s.' is not a sentence end", (abbr) => {
      expect(tidySummaryText(build(`Şirket ${abbr}. Yeni dönem başlıyor`))).toBe(PREV);
    });

    it.each(["Novel", "Decor", "Incir", "Stop", "Cold", "Nova", "Aralık", "Ocak"])(
      "an ordinary word '%s' before '.' still ends the sentence (an abbreviation counts only as a whole word)",
      (word) => {
        expect(tidySummaryText(build(`Şirket ${word}. Yeni dönem başlıyor`))).toBe(`${PRE}Şirket ${word}.`);
      },
    );

    it("'II.' in the middle of a 500-character clamp: the text after it survives and the cut is not on it", () => {
      const raw = clamp(`${"kelimeler ".repeat(30)}Sultan II. Abdülhamid döneminde ${"yarımkalan ".repeat(40)}`);
      const out = tidySummaryText(raw);
      expect(out).toBe(
        "kelimeler ".repeat(30) + "Sultan II. Abdülhamid döneminde " + "yarımkalan ".repeat(15).trimEnd() + "…",
      );
      expect(out).toContain("II. Abdülhamid döneminde yarımkalan");
      expect(out).not.toMatch(/II\.…?$/);
    });

    it("the #170 year rule: a last sentence that ends '... 2026.' still cuts there", () => {
      expect(tidySummaryText(build("Etkinlik 2026. Yeni dönem başlıyor"))).toBe(`${PRE}Etkinlik 2026.`);
      expect(tidySummaryText(build("Sultan II. Abdülhamid 2026. Yeni dönem başlıyor"))).toBe(
        `${PRE}Sultan II. Abdülhamid 2026.`,
      );
    });
  });

  describe("must not change, standalone and inside a sentence", () => {
    const GUARDS: readonly string[] = [
      "macOS",
      "macOS'un",
      "watchOS",
      "iPadOS",
      "visionOS",
      "webOS",
      "iPhone",
      "iPad",
      "iMac",
      "eVTOL",
      "beIN Sports",
      "kWh",
      "mRNA",
      "mAh",
      "BirGün",
      "T.C.",
      "A.Ş.",
      "U.S.",
      "3.5",
      "tayfhaber.com",
      // Currency glue stays: the capitals are a currency code, not an acronym.
      "5 milyarTL",
      "5 milyarTL'lik",
      "5 milyonYTL",
      "3 milyonUSD",
      "2 milyarEUR",
      "7 milyarGBP",
      "9 milyonCHF",
    ];
    const FRAMES: ReadonlyArray<(g: string) => string> = [
      (g) => g,
      (g) => `${g} hakkında açıklama yaptı.`,
      (g) => `Şirket ${g} hakkında açıklama yaptı.`,
    ];

    it.each(GUARDS)("%j", (g) => {
      for (const frame of FRAMES) expect(tidySummaryText(frame(g)), frame(g)).toBe(frame(g));
    });

    it("a lower-case brand that would match the new rule is excluded by its core, before the apostrophe", () => {
      for (const s of ["macOS'un", "macOS’un yeni sürümü", "webOS'ta", "watchOS 26", "ipadOS", "visionOS'ta"]) {
        expect(tidySummaryText(s), s).toBe(s);
        expect(tidySummaryText(`Apple ${s} duyurdu.`), s).toBe(`Apple ${s} duyurdu.`);
      }
    });

    it("fewer than three lower-case letters in front, a lower-case start and a prefix are left alone", () => {
      for (const s of [
        "ab Cde",
        "abCDE",
        "xAI",
        "iOS 26",
        "tvOS",
        "TürkçedeFaddey",
        "TBMMBaşkanı",
        "#yerelSeçim",
        "#yerelTBMM",
        "@kullaniciABC",
        "https://x.com/abcDEF",
        "tayfhaber.com/haberDETAY",
        "dosya_adıDEĞER",
        "e-DevletKAPI",
      ]) {
        expect(tidySummaryText(s), s).toBe(s);
      }
    });

    it("a currency code followed by a lower-case letter is not the currency word, so it is split", () => {
      expect(tidySummaryText("yaptıTLeri")).toBe("yaptı. TLeri");
    });
  });

  describe("idempotency and time", () => {
    it("tidy(tidy(x)) === tidy(x) for every new fixture and every pinned output", () => {
      for (const [id8, expected] of EXPECTED) {
        const once = tidySummaryText(raw26(id8));
        expect(once, id8).toBe(expected);
        expect(tidySummaryText(once), id8).toBe(once);
      }
    });

    it("tidy(tidy(x)) === tidy(x) for the synthetic cases", () => {
      const inputs = [
        clamp("kelimeler ".repeat(30) + "Bitti.Son cümle bitti.Yarım " + "kalan ".repeat(40)),
        clamp(`${"kelimeler ".repeat(30)}Sultan II. Abdülhamid döneminde ${"yarımkalan ".repeat(40)}`),
        clamp("kelimeler ".repeat(40) + "Bitti. Şirket Ltd. Yeni dönem " + "yarımkalan ".repeat(20)),
        "Meclis toplantısıTBMM Başkanı konuştu.",
        "Toplantı tamamlandıDEVAMI İÇİN TIKLAYIN",
        "Apple macOS'un yeni sürümünü duyurdu. 5 milyarTL gelir.",
      ];
      for (const x of inputs) {
        const once = tidySummaryText(x);
        expect(tidySummaryText(once), JSON.stringify(x)).toBe(once);
      }
    });

    it.each([
      ["'a' x 100000 + 'B'", () => "a".repeat(100_000) + "B"],
      ["'aB' x 50000", () => "aB".repeat(50_000)],
      ["a 500-character clamp of 'x.Y' repeats", () => clamp("x.Y".repeat(170))],
    ])("%s finishes in under 100 ms", (_name, make) => {
      const input = make();
      const start = performance.now();
      tidySummaryText(input);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

// ---------------------------------------------------------------------------
// An excerpt marker after an open quotation (h29-regress-1). Feeds that end a
// description with " […]" cut it wherever their excerpt limit fell, often inside
// a quotation: stripFeedWrappers turns the marker into "…", and the visible
// summary ended "…videoda “ABD Senatosu için…" (49cb984b), one opening “ and no
// closing ”. A cut is balanced when it leaves no quotation open (the same test
// the clamp repair uses): the straight quote an even number of times, no more
// “ « ‘ than ” » ’.
// ---------------------------------------------------------------------------

/** True when `s` leaves no quotation open. Counts only, written for the assertions. */
function leavesNothingOpen(s: string): boolean {
  return (
    countChar(s, '"') % 2 === 0 &&
    countChar(s, "“") <= countChar(s, "”") &&
    countChar(s, "«") <= countChar(s, "»") &&
    countChar(s, "‘") <= countChar(s, "’")
  );
}

const H29_49CB_HEAD =
  "ABD’de Cumhuriyetçiler seçimlere iki gün kala çoğu siyasi stratejistin yalnızca hayalini kurabileceği bir hediye aldı. Michigan’daki Demokrat temsilci Haley Stevens partisinin adayına karşı kaybettiği ön seçimin ardından eyaletin çekişmeli Senato yarışında Cumhuriyetçi aday Mike Rogers’ı desteklediğini açıkladı. Ağustos ayındaki ön seçimde el-Sayed, Stevens’ı küçük bir farkla yenmişti.";
// clusters.summary_tr of 49cb984b-87c1-487f-9d56-bc3419416cfe, verbatim.
const H29_49CB_RAW = `${H29_49CB_HEAD} Haley Stevens internette yayınladığı videoda “ABD Senatosu için […]`;
const H29_SYNTHETIC_RAW =
  "Ağustos ayındaki ön seçimde el-Sayed, Stevens’ı küçük bir farkla yenmişti. Haley Stevens internette yayınladığı videoda “ABD Senatosu için […]";
const H29_SYNTHETIC_OUT = "Ağustos ayındaki ön seçimde el-Sayed, Stevens’ı küçük bir farkla yenmişti.";
const H29_WORDS = "kelimeler ".repeat(30);

describe("tidySummaryText excerpt marker after an open quotation (h29-regress-1)", () => {
  it("49cb984b: the summary ends at the last sentence end in front of the open quotation", () => {
    const out = tidySummaryText(H29_49CB_RAW);
    expect(out).toBe(H29_49CB_HEAD);
    expect(out.endsWith("yenmişti.")).toBe(true);
    expect(leavesNothingOpen(out)).toBe(true);
    expect(out).not.toContain("ABD Senatosu");
  });

  it("the synthetic tail of 49cb984b ends at '…yenmişti.'", () => {
    expect(tidySummaryText(H29_SYNTHETIC_RAW)).toBe(H29_SYNTHETIC_OUT);
  });

  it.each([
    ["curly double", "“"],
    ["angle", "«"],
    ["curly single", "‘"],
    ["straight", '"'],
  ])("%s quotation: a long text with no sentence end is cut in front of the opener", (_label, open) => {
    const out = tidySummaryText(`${H29_WORDS}Bakan ${open}Biz […]`);
    expect(out).toBe(`${H29_WORDS}Bakan…`);
    expect(leavesNothingOpen(out)).toBe(true);
  });

  it("the other excerpt markers behave like '[…]'", () => {
    expect(tidySummaryText(`${H29_WORDS}Bakan “Biz [...]`)).toBe(`${H29_WORDS}Bakan…`);
    expect(tidySummaryText(`${H29_WORDS}Bakan “Biz [&hellip;]`)).toBe(`${H29_WORDS}Bakan…`);
  });

  it("a comma or a colon in front of the opener goes with it", () => {
    expect(tidySummaryText(`${H29_WORDS}Bakan şunları söyledi: “Biz […]`)).toBe(`${H29_WORDS}Bakan şunları söyledi…`);
    expect(tidySummaryText(`${H29_WORDS}Bakan şunları söyledi, “Biz […]`)).toBe(`${H29_WORDS}Bakan şunları söyledi…`);
  });

  it("keeps the sentence end when it is at least 60% of what a cut in front of the opener keeps", () => {
    // 32 of 45 characters: the sentence end wins.
    expect(tidySummaryText("Uzun bir ilk cümle burada bitti. Bakan Yılmaz “Biz […]")).toBe(
      "Uzun bir ilk cümle burada bitti.",
    );
  });

  it("cuts in front of the opener when the sentence end would drop more than 40% of that cut", () => {
    // The sentence end keeps 25 of 49 characters (valid), but 25 < 0.6 * 43.
    expect(tidySummaryText("Birinci cümle tamamlandı. Sonra uzun kelime “Biz […]")).toBe(
      "Birinci cümle tamamlandı. Sonra uzun kelime…",
    );
  });

  it("an opener in the first half of the text leaves the output as it is today", () => {
    const expected = `Bakan “Biz ${H29_WORDS.trimEnd()}…`;
    expect(tidySummaryText(`Bakan “Biz ${H29_WORDS.trimEnd()} […]`)).toBe(expected);
    // A short first sentence does not change that.
    const withSentence = `Kısa cümle. Bakan “Biz ${H29_WORDS.trimEnd()}…`;
    expect(tidySummaryText(`Kısa cümle. Bakan “Biz ${H29_WORDS.trimEnd()} […]`)).toBe(withSentence);
  });

  it("a balanced text keeps its quotation and its '…'", () => {
    expect(tidySummaryText("Bakan “Biz hazırız” dedi ve toplantıdan çıktı [...]")).toBe(
      "Bakan “Biz hazırız” dedi ve toplantıdan çıktı…",
    );
    expect(tidySummaryText('Bakan "Biz hazırız" dedi ve toplantıdan [&hellip;]')).toBe(
      'Bakan "Biz hazırız" dedi ve toplantıdan…',
    );
  });

  it("only the rewrite of a wrapper is backed off: the author's own ellipsis stays", () => {
    expect(tidySummaryText("Bakan “Biz devam ediyor…")).toBe("Bakan “Biz devam ediyor…");
  });

  it("is idempotent on every new fixture", () => {
    const inputs = [
      H29_49CB_RAW,
      H29_SYNTHETIC_RAW,
      `${H29_WORDS}Bakan “Biz […]`,
      `${H29_WORDS}Bakan «Biz […]`,
      `${H29_WORDS}Bakan ‘Biz […]`,
      `${H29_WORDS}Bakan "Biz […]`,
      `${H29_WORDS}Bakan şunları söyledi: “Biz […]`,
      "Uzun bir ilk cümle burada bitti. Bakan Yılmaz “Biz […]",
      "Birinci cümle tamamlandı. Sonra uzun kelime “Biz […]",
      `Bakan “Biz ${H29_WORDS.trimEnd()} […]`,
      `Kısa cümle. Bakan “Biz ${H29_WORDS.trimEnd()} […]`,
      "Bakan “Biz hazırız” dedi ve toplantıdan çıktı [...]",
    ];
    for (const raw of inputs) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), once.slice(-40)).toBe(once);
    }
  });
});

describe("backOffOpenQuote (h29-regress-1)", () => {
  it.each([
    "",
    "   ",
    "Tırnaksız bir cümle",
    'Dedi ki "merhaba" ve gitti.',
    "Dedi ki “merhaba” ve gitti.",
    "Dedi ki «merhaba» ve gitti.",
    "Dedi ki ‘merhaba’ ve gitti.",
    "Stevens’ı yendi, Rogers’ı destekledi.",
    "Bir “iç içe ‘tırnak’ örneği” ve devamı",
  ])("a balanced input comes back as the same string: %j", (input) => {
    expect(backOffOpenQuote(input)).toBe(input);
    expect(backOffOpenQuote(input, { floor: 5, minShare: 0.9 })).toBe(input);
  });

  it.each([
    ["straight", '"'],
    ["curly double", "“"],
    ["angle", "«"],
    ["curly single", "‘"],
  ])("%s quotation: ends at the sentence end in front of the opener, without an ellipsis", (_label, open) => {
    expect(backOffOpenQuote(`Bu bir cümle. Bakan ${open}Biz`)).toBe("Bu bir cümle.");
  });

  it.each([
    ["straight", '"'],
    ["curly double", "“"],
    ["angle", "«"],
    ["curly single", "‘"],
  ])("%s quotation: ends in front of the opener with an ellipsis when the sentence end keeps too little", (_label, open) => {
    expect(backOffOpenQuote(`Evet. Bakan Yılmaz bugün kentte açıklamada ${open}Biz`)).toBe(
      "Evet. Bakan Yılmaz bugün kentte açıklamada…",
    );
  });

  it("drops dangling ', ; : – — -' and blanks in front of the opener", () => {
    expect(backOffOpenQuote('Bakan Yılmaz bugün şunları söyledi , : "Biz')).toBe("Bakan Yılmaz bugün şunları söyledi…");
    expect(backOffOpenQuote("Bakan Yılmaz şunları söyledi - “Biz")).toBe("Bakan Yılmaz şunları söyledi…");
    expect(backOffOpenQuote("Bakan Yılmaz şunları söyledi; «Biz")).toBe("Bakan Yılmaz şunları söyledi…");
  });

  it("adds no ellipsis when the cut already ends in a sentence mark", () => {
    // "Dr." is an abbreviation, not a sentence end, so the sentence-end cut is
    // not available; the cut in front of the opener ends in the dot.
    expect(backOffOpenQuote('Dr. "Biz')).toBe("Dr.");
  });

  it("keeps a closed quotation and cuts in front of the one that is open", () => {
    expect(backOffOpenQuote('Dedi ki “merhaba” ve "Biz')).toBe("Dedi ki “merhaba” ve…");
    // The sentence end may sit inside the closing quote.
    expect(backOffOpenQuote('Dedi ki “tamam.” Sonra "Biz')).toBe("Dedi ki “tamam.”");
  });

  it("is not confused by an apostrophe", () => {
    expect(backOffOpenQuote("O’nun sözü. Bakan “Biz")).toBe("O’nun sözü.");
  });

  it("returns a balanced string that is not longer than the input and is a fixed point", () => {
    const inputs = [
      'Bu bir cümle. Bakan "Biz',
      "Evet. Bakan Yılmaz bugün kentte açıklamada “Biz",
      'Bakan Yılmaz bugün şunları söyledi , : "Biz',
      'Dedi ki “merhaba” ve "Biz',
      `${H29_WORDS}Bakan «Biz`,
    ];
    for (const input of inputs) {
      const out = backOffOpenQuote(input);
      expect(out, input).not.toBeNull();
      if (out === null) continue;
      expect(leavesNothingOpen(out), input).toBe(true);
      expect(out.length, input).toBeLessThanOrEqual(input.length);
      expect(backOffOpenQuote(out), input).toBe(out);
    }
  });

  describe("floor", () => {
    const text = 'Bu bir cümle. Bakan "Biz'; // sentence end at 13, cut in front of the opener at 19

    it("a cut must end after the floor", () => {
      expect(backOffOpenQuote(text, { floor: 12 })).toBe("Bu bir cümle.");
      // The sentence end is AT the floor: not after it. The opener cut is.
      expect(backOffOpenQuote(text, { floor: 13 })).toBe("Bu bir cümle. Bakan…");
      expect(backOffOpenQuote(text, { floor: 18 })).toBe("Bu bir cümle. Bakan…");
    });

    it("returns null when no cut ends after the floor", () => {
      expect(backOffOpenQuote(text, { floor: 19 })).toBeNull();
      expect(backOffOpenQuote(text, { floor: 100 })).toBeNull();
    });
  });

  describe("minShare", () => {
    const early = `Bakan “Biz ${"kelimeler ".repeat(20).trimEnd()}`; // opener at 6 of 210

    it("defaults to no minimum", () => {
      expect(backOffOpenQuote(early)).toBe("Bakan…");
      expect(backOffOpenQuote(early, { minShare: 0 })).toBe("Bakan…");
    });

    it("rejects a cut that keeps less than the share of the text", () => {
      expect(backOffOpenQuote(early, { minShare: 0.5 })).toBeNull();
    });

    it("accepts a cut that keeps exactly the share", () => {
      expect(backOffOpenQuote("abcde “fgh", { minShare: 0.5 })).toBe("abcde…");
      expect(backOffOpenQuote("abcde “fgh", { minShare: 0.51 })).toBeNull();
    });

    it("the opener cut wins over a sentence end that is below the share", () => {
      const input = `Evet. ${"kelimeler ".repeat(20)}“Biz`;
      expect(backOffOpenQuote(input, { minShare: 0.5 })).toBe(`Evet. ${"kelimeler ".repeat(20).trimEnd()}…`);
    });
  });

  it("returns null when no valid cut exists", () => {
    expect(backOffOpenQuote('"Biz')).toBeNull();
    expect(backOffOpenQuote("“Biz devam ediyor")).toBeNull();
    expect(backOffOpenQuote(" «Biz")).toBeNull();
    expect(backOffOpenQuote("“".repeat(50))).toBeNull();
  });

  describe("linear time on 100k characters", () => {
    it.each([
      ["'“' x 100000 + '…'", () => "“".repeat(100_000) + "…"],
      ["'\"a. ' x 30000 + '…' (balanced)", () => '"a. '.repeat(30_000) + "…"],
      ["'\"a. ' x 30001 + '…' (one quote open)", () => '"a. '.repeat(30_001) + "…"],
      ["'Aa. ' x 25000 + ' “Biz…'", () => "Aa. ".repeat(25_000) + " “Biz…"],
    ])("%s finishes in under 100 ms", (_name, make) => {
      const input = make();
      const start = performance.now();
      backOffOpenQuote(input);
      expect(performance.now() - start).toBeLessThan(100);
    });

    it.each([
      ["'“' x 100000 + ' […]'", () => "“".repeat(100_000) + " […]"],
      ["'\"a. ' x 30000 + ' […]'", () => '"a. '.repeat(30_000) + " […]"],
      ["'\"a. ' x 30001 + ' […]'", () => '"a. '.repeat(30_001) + " […]"],
    ])("tidySummaryText of %s finishes in under 100 ms", (_name, make) => {
      const input = make();
      const start = performance.now();
      tidySummaryText(input);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

// ---------------------------------------------------------------------------
// h30-live-1: an ASCII apostrophe closes an open U+2018 (c5627cb9 stores
// "‘100 il 1000 ilçe' projesini": U+2018 opener, ASCII closer), and a summary
// that starts with a heading line no longer runs on into the body (3158fd7a,
// 6c2af39b, bef94c53, d298d680). clusters.summary_tr values below are the live
// rows, verbatim (read-only query, 2026-11-03).
// ---------------------------------------------------------------------------

// c5627cb9-4000-471c-9c42-0be5f29e62b3
const H30_C5627 =
  "MHP Genel Başkanı Devlet Bahçeli, ‘100 il 1000 ilçe' projesini kamuoyuyla paylaştı. Bahçeli, artan nüfus ve ihtiyaçlara dikkat çekerek 9 yeni il ve 78 yeni ilçe kurulması gerektiğini belirtti.";
// 3158fd7a-ce5b-4b34-b528-49683b3706d9 (203 characters: an outlet feed cap)
const H30_3158 =
  "Bolat ve Buşıha ikili ilişkileri ve ticaret hedefini ele aldı\nTicaret Bakanı Ömer Bolat ile Libya Milli Birlik Hükümeti Ekonomi ve Ticaret Bakanı Süheyl Abdülmüttalib Buşıha İstanbul'da gerçekleştiril...";
// 6c2af39b-3b40-4d17-af18-1a2befe33e5e
const H30_6C2A =
  "Düzce valiliği kadın masa tenisinde il şampiyonu oldu\nKamu Spor Oyunları çerçevesinde düzenlenen masa tenisi müsabakalarında Düzce Valiliği kadın masa tenisi takımı il birinciliğini elde ederek kentte...";
// bef94c53-cc15-45e7-b904-617663e098aa
const H30_BEF9 =
  "Genel provanın akışı\nSinop'ta 29 Ekim Cumhuriyet Bayramı'nın 103. yıl dönümü kutlama programı öncesinde genel bir prova yapıldı. Öğrenciler, bando eşliğinde Hükümet Konağı önünden başlayarak kortej ha...";
// d298d680-f9db-4136-be6b-fb36c7867b2a
const H30_D298 =
  "Yılmaz'ın değerlendirmesi\nCumhurbaşkanı Yardımcısı Cevdet Yılmaz tarafından yapılan değerlendirmede, Türkmenistan'ın zengin doğal kaynakları ve jeostratejik konumunun yanında halkın gayretiyle ekonomi...";
// f85bc48e-692d-41be-8f6b-0d0ecd1d2281, verbatim: three bullet lines (the later
// ones lost their markers in the feed). The replay of 8,488 live summaries
// found it as a false cut of step 1d: the first bullet is a sentence of the
// story, not a heading.
const H30_F85B =
  '- Koreli öğrencilere Türkçe öğretilen sınıfı ziyaret eden Emine Erdoğan, öğrencilerle sohbet etti\nKoreli iki öğrencinin Türkçe diyaloglarını dinleyen Emine Erdoğan, konuşmalarını beğendiği öğrencileri alkışlayarak tebrik etti\nEmine Erdoğan: \n"Türkçemize ilgi duyan öğrencilerimizle buluşmak, dilimizin ve kültürümüzün uzak coğrafyalarda nasıl güzel karşılıklar bulduğuna şahit olmak çok kıymetli"';

/** A character-scan check that `s` has no newline (never a regex over the text). */
function hasNoNewline(s: string): boolean {
  for (const ch of s) if (ch === "\n" || ch === "\r") return false;
  return true;
}

describe("trimDanglingEnd (h30-live-1)", () => {
  it("is exported and moves the end back over ', ; : – — -' and blanks", () => {
    expect(trimDanglingEnd("abc, ", 5)).toBe(3);
    expect(trimDanglingEnd("abc;", 4)).toBe(3);
    expect(trimDanglingEnd("abc :- ", 7)).toBe(3);
    expect(trimDanglingEnd("abc –— x", 6)).toBe(3);
  });

  it("leaves a clean end where it is", () => {
    expect(trimDanglingEnd("abc", 3)).toBe(3);
    expect(trimDanglingEnd("abc.", 4)).toBe(4);
    expect(trimDanglingEnd("abc…", 4)).toBe(4);
    expect(trimDanglingEnd("", 0)).toBe(0);
  });

  it("honours an end in the middle of the text and never goes below 0", () => {
    expect(trimDanglingEnd("ab, cd", 3)).toBe(2);
    expect(trimDanglingEnd(" , - ", 5)).toBe(0);
  });
});

describe("quoteBalance: an ASCII apostrophe closes an open U+2018 (h30-live-1)", () => {
  it("c5627cb9 (U+2018 + ASCII closer) is balanced, so the text comes back as the same string", () => {
    expect(backOffOpenQuote(H30_C5627)).toBe(H30_C5627);
    expect(backOffOpenQuote(H30_C5627, { floor: 10, minShare: 0.9 })).toBe(H30_C5627);
  });

  it("an apostrophe followed by a letter does not close: \"‘İsrail'in tutumu\" stays open", () => {
    expect(backOffOpenQuote("Bakan Yılmaz ‘İsrail'in tutumu")).toBe("Bakan Yılmaz…");
    expect(backOffOpenQuote("Bu bir cümle. Bakan ‘Ali'ye dedi")).toBe("Bu bir cümle.");
  });

  it.each([
    ["end of the text", "Dedi ki ‘tamam'"],
    ["a space", "Dedi ki ‘tamam' ve gitti"],
    ["a comma", "Dedi ki ‘tamam', sonra gitti"],
    ["a full stop", "Dedi ki ‘tamam'. Sonra gitti"],
    ["a closing bracket", "(Dedi ki ‘tamam') ve gitti"],
    ["a digit", "Dedi ki ‘tamam'2 kez"],
  ])("closes when the next character is not a letter: %s", (_label, input) => {
    expect(backOffOpenQuote(input), input).toBe(input);
  });

  it("an ASCII apostrophe with no open U+2018 changes nothing", () => {
    const apostrophes = "İsrail'de sandıktan koalisyon belirsizliğinin çıktığı 27 Ekim'deki genel seçimlerin ardından Partisi' destekledi";
    expect(backOffOpenQuote(apostrophes)).toBe(apostrophes);
    // ... and it does not close a different kind of quotation.
    expect(backOffOpenQuote("O' sözü Bakanlığa gelen son açıklama oldu. Bakan “Biz")).toBe(
      "O' sözü Bakanlığa gelen son açıklama oldu.",
    );
    expect(backOffOpenQuote("Sonuç' dedi ve toplantıdan çıktı bugün. Bakan «Biz")).toBe(
      "Sonuç' dedi ve toplantıdan çıktı bugün.",
    );
  });

  it("one apostrophe closes one opener: a second apostrophe is ignored, a second opener stays open", () => {
    expect(backOffOpenQuote("Dedi ki ‘a' b' c")).toBe("Dedi ki ‘a' b' c");
    expect(backOffOpenQuote("Dedi ki ‘a ‘b' c")).toBe("Dedi ki…");
  });

  it("the typographic closer still closes, as before", () => {
    expect(backOffOpenQuote("Dedi ki ‘merhaba’ ve gitti.")).toBe("Dedi ki ‘merhaba’ ve gitti.");
    expect(backOffOpenQuote("Dedi ki ‘merhaba ve gitti")).toBe("Dedi ki…");
  });

  it("the clamp repair reads the same balance: a sentence end after \"‘…'\" is a valid cut", () => {
    // The sentence holding the pair ends at about 70% of the clamped text. With
    // the pair read as open, that sentence end was passed over (an unbalanced
    // cut) and the repair fell back to a word cut ending in "…".
    const filler = "enerji güvenliği ve nüfus artışı ";
    const sentence = `Bahçeli, ${filler.repeat(9)}‘100 il 1000 ilçe' projesini paylaştı.`;
    let body = `${sentence} `;
    const tail = "yeni il ve ilçeler kurulması gerektiğini belirten açıklamada ";
    while (body.length < 497) body += tail;
    const raw = body.slice(0, 497) + "...";
    expect(raw).toHaveLength(500);
    expect(sentence.length).toBeGreaterThan(0.6 * 497);
    const out = tidySummaryText(raw);
    expect(out).toBe(sentence);
    expect(tidySummaryText(out)).toBe(out);
  });
});

describe("tidySummaryText heading line (h30-live-1)", () => {
  const BODY = "Ticaret Bakanı Ömer Bolat ile Libya Milli Birlik Hükümeti Ekonomi ve Ticaret Bakanı Süheyl Abdülmüttalib Buşıha İstanbul'da…";

  it.each([
    [
      "3158fd7a",
      H30_3158,
      "Ticaret Bakanı Ömer Bolat ile Libya Milli Birlik Hükümeti Ekonomi ve Ticaret Bakanı Süheyl Abdülmüttalib Buşıha İstanbul'da…",
    ],
    [
      "6c2af39b",
      H30_6C2A,
      "Kamu Spor Oyunları çerçevesinde düzenlenen masa tenisi müsabakalarında Düzce Valiliği kadın masa tenisi takımı il birinciliğini elde ederek…",
    ],
    [
      "bef94c53",
      H30_BEF9,
      "Sinop'ta 29 Ekim Cumhuriyet Bayramı'nın 103. yıl dönümü kutlama programı öncesinde genel bir prova yapıldı.",
    ],
    [
      "d298d680",
      H30_D298,
      "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz tarafından yapılan değerlendirmede, Türkmenistan'ın zengin doğal kaynakları ve jeostratejik konumunun yanında halkın gayretiyle…",
    ],
  ])("%s: the heading line goes and the body stays", (_id, raw, expected) => {
    const out = tidySummaryText(raw);
    expect(out).toBe(expected);
    expect(out.length).toBeGreaterThanOrEqual(80);
  });

  it("3158fd7a keeps its body whole (the heading is the only thing dropped)", () => {
    expect(tidySummaryText(H30_3158)).toBe(BODY);
  });

  it("a body shorter than 80 characters is joined to the heading with '. '", () => {
    expect(tidySummaryText("Yeni tebliğ yayımlandı\nBakanlık düzenlemeyi duyurdu.")).toBe(
      "Yeni tebliğ yayımlandı. Bakanlık düzenlemeyi duyurdu.",
    );
  });

  describe("the 80-character bar counts the body with its blanks collapsed", () => {
    const HEAD = "Başlık satırı burada yazılı";
    const body = (n: number) => "B" + "a".repeat(n - 2) + ".";

    it("80 characters: the heading goes", () => {
      expect(tidySummaryText(`${HEAD}\n${body(80)}`)).toBe(body(80));
    });

    it("79 characters: heading and body are joined", () => {
      expect(tidySummaryText(`${HEAD}\n${body(79)}`)).toBe(`${HEAD}. ${body(79)}`);
    });

    it("blank runs count once: 90 raw characters that collapse to 79 are joined", () => {
      // "B" + 38 x "a" + 12 blanks + 38 x "a" + "." = 90 raw, 79 collapsed.
      const raw = `B${"a".repeat(38)}${" ".repeat(12)}${"a".repeat(38)}.`;
      expect(raw).toHaveLength(90);
      expect(tidySummaryText(`${HEAD}\n${raw}`)).toBe(`${HEAD}. B${"a".repeat(38)} ${"a".repeat(38)}.`);
    });

    it("a body of several lines is counted whole: its line breaks are blanks, counted once", () => {
      // "B" + 38 x "a" + a line break + 38 x "a" + "." = 79 collapsed; one more "a" makes 80.
      const two = (n: number) => `B${"a".repeat(n)}\n${"a".repeat(38)}.`;
      expect(tidySummaryText(`${HEAD}\n${two(38)}`)).toBe(`${HEAD}. B${"a".repeat(38)} ${"a".repeat(38)}.`);
      expect(tidySummaryText(`${HEAD}\n${two(39)}`)).toBe(`B${"a".repeat(39)} ${"a".repeat(38)}.`);
    });
  });

  describe("length of the first line: 15 to 140 characters", () => {
    const rest = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
    const head = (n: number) => "B".padEnd(n, "k");

    it.each([15, 16, 100, 140])("%i characters: dropped", (n) => {
      expect(head(n)).toHaveLength(n);
      expect(tidySummaryText(`${head(n)}\n${rest}`)).toBe(rest);
    });

    // h31-reader-4 changed the expectation: a first line that is NOT a heading (too
    // short or too long) still ends in a letter in front of a capital, so the line
    // break is a sentence boundary and becomes ". ", no longer a bare blank.
    it.each([1, 14, 141, 300])(
      "%i characters: not a heading, kept as its own sentence (the line break becomes '. ' since h31-reader-4)",
      (n) => {
        expect(head(n)).toHaveLength(n);
        expect(tidySummaryText(`${head(n)}\n${rest}`)).toBe(`${head(n)}. ${rest}`);
      },
    );
  });

  describe("untouched", () => {
    const rest = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";

    it.each([
      [".", "Başlık satırı burada biter."],
      ["!", "Başlık satırı burada biter!"],
      ["?", "Başlık satırı burada biter mi?"],
      [":", "Başlık satırı burada biter:"],
      ["…", "Başlık satırı burada biter…"],
      [",", "Başlık satırı burada biter,"],
      [";", "Başlık satırı burada biter;"],
      ["–", "Başlık satırı burada biter –"],
      ["—", "Başlık satırı burada biter —"],
      ["-", "Başlık satırı burada biter -"],
    ])("a first line ending in %s", (_mark, head) => {
      expect(tidySummaryText(`${head}\n${rest}`)).toBe(`${head} ${rest}`);
    });

    it.each([
      ["a full stop", "Prof. Dr. Ali açıkladı yeni kararı"],
      ["a colon", "Saat 10:30 itibarıyla başladı bile"],
      ["a question mark", "Neden böyle oldu? kimse bilmiyor"],
      ["an exclamation mark", "Vay canına! gerçekten oldu burada"],
      ["an ellipsis", "Başlık… devamı yazılmış burada"],
    ])("a first line with %s in the middle (not a heading; h31-reader-4: its line break is '. ')", (_label, head) => {
      expect(tidySummaryText(`${head}\n${rest}`)).toBe(`${head}. ${rest}`);
    });

    it("a single-line text", () => {
      const one = "Başlık gibi görünen ama tek satırlık bir metin burada";
      expect(tidySummaryText(one)).toBe(one);
      expect(tidySummaryText("")).toBe("");
    });

    it.each([
      ["lower case", "küçük harfle başlayan satır devam ediyor"],
      ["a digit", "29 Ekim kutlamaları kapsamında program yapıldı"],
      ["a quote", "“Tam bir başarıydı” diyen yetkili konuştu"],
      ["a bracket", "(Fotoğraf: AA) görüntüler yayımlandı bugün"],
    ])("a second line that starts with %s", (_label, second) => {
      expect(tidySummaryText(`Başlık gibi bir satır var burada\n${second}`)).toBe(
        `Başlık gibi bir satır var burada ${second}`,
      );
    });

    it("f85bc48e: a list item is not a heading, and its lines become sentences", () => {
      expect(tidySummaryText(H30_F85B)).toBe(
        'Koreli öğrencilere Türkçe öğretilen sınıfı ziyaret eden Emine Erdoğan, öğrencilerle sohbet etti. Koreli iki öğrencinin Türkçe diyaloglarını dinleyen Emine Erdoğan, konuşmalarını beğendiği öğrencileri alkışlayarak tebrik etti. Emine Erdoğan: "Türkçemize ilgi duyan öğrencilerimizle buluşmak, dilimizin ve kültürümüzün uzak coğrafyalarda nasıl güzel karşılıklar bulduğuna şahit olmak çok kıymetli"',
      );
    });

    // h31-reader-4: the bullet is not a heading (step 1d keeps it) and its line is a
    // sentence of its own, so the line break after it is '. ' and no longer a bare blank.
    it.each(["- ", "– ", "• ", "* ", "\u25AA\uFE0F "])("a first line that starts with the list marker %j", (marker) => {
      const body = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
      expect(tidySummaryText(`${marker}Başlık satırı burada yazılı\n${body}`)).toBe(`Başlık satırı burada yazılı. ${body}`);
    });

    it("a dash glued to a digit is not a list marker: '-5 derece ...' can still be a heading", () => {
      const body = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
      expect(tidySummaryText(`-5 derece hava sıcaklığı bekleniyor\n${body}`)).toBe(body);
    });

    it("a heading with nothing behind it", () => {
      expect(tidySummaryText("Başlık gibi bir satır var burada\n")).toBe("Başlık gibi bir satır var burada");
      expect(tidySummaryText("Başlık gibi bir satır var burada\n   \n")).toBe("Başlık gibi bir satır var burada");
    });
  });

  it("works through CRLF line breaks and leading blank lines", () => {
    expect(
      tidySummaryText(
        "Genel provanın akışı\r\nSinop'ta 29 Ekim Cumhuriyet Bayramı'nın 103. yıl dönümü kutlama programı öncesinde genel bir prova yapıldı.",
      ),
    ).toBe("Sinop'ta 29 Ekim Cumhuriyet Bayramı'nın 103. yıl dönümü kutlama programı öncesinde genel bir prova yapıldı.");
    expect(tidySummaryText("\n\n  Başlık satırı burada yazılı\nGövde metni başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.")).toBe(
      "Gövde metni başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.",
    );
  });

  // h31-reader-4 changed the expectation: the second heading line stays in the body
  // as a sentence of its own, so its line break is ". " and no longer a bare blank.
  it("only the first line is looked at: a second heading line stays in the body, as its own sentence", () => {
    const body = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
    expect(tidySummaryText(`Birinci başlık satırı yazılı\nİkinci başlık satırı yazılı\n${body}`)).toBe(
      `İkinci başlık satırı yazılı. ${body}`,
    );
  });

  it("a widget heading line is dropped first, then the real heading line", () => {
    const body = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
    expect(tidySummaryText(`İlginizi Çekebilir\nBaşlık satırı burada yazılı\n${body}`)).toBe(body);
  });

  it("the Medyascope footer still goes, and the heading line with it", () => {
    const body = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
    const out = tidySummaryText(`Başlık satırı burada yazılı\n${body}\nBaşka bir haberin başlığı Medyascope`);
    expect(out).toBe(body);
  });

  it("a leading ticker behind the heading line is peeled afterwards", () => {
    expect(
      tidySummaryText(
        "Başlık satırı burada yazılı\nSon dakika | Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.",
      ),
    ).toBe("Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.");
  });

  it("no newline is left in any output", () => {
    for (const raw of [H30_3158, H30_6C2A, H30_BEF9, H30_D298]) {
      expect(hasNoNewline(tidySummaryText(raw))).toBe(true);
    }
  });

  it("is idempotent on every new fixture, input and output", () => {
    const inputs = [
      H30_C5627,
      H30_3158,
      H30_6C2A,
      H30_BEF9,
      H30_D298,
      '- Koreli öğrencilere Türkçe öğretilen sınıfı ziyaret eden Emine Erdoğan, öğrencilerle sohbet etti\nKoreli iki öğrencinin Türkçe diyaloglarını dinleyen Emine Erdoğan',
      "Yeni tebliğ yayımlandı\nBakanlık düzenlemeyi duyurdu.",
      "Başlık satırı burada yazılı\nGövde.",
      "Birinci başlık satırı yazılı\nİkinci başlık satırı yazılı\nGövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.",
      "Başlık satırı burada biter.\nGövde metni.",
      "Dedi ki ‘tamam' ve gitti. Başlık satırı burada yazılı\nGövde.",
    ];
    for (const raw of inputs) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), raw).toBe(once);
      for (const line of [raw, once]) {
        const again = tidySummaryText(line);
        expect(tidySummaryText(again), line).toBe(again);
      }
    }
  });

  it("is linear: a 100k-character text with an early heading line finishes in under 1000 ms", () => {
    // Measured at under 100 ms on a development machine; the bound leaves 10x.
    const input = `Başlık satırı burada yazılı\nGövde ${"kelime ".repeat(16_000)}sonu.`;
    expect(input.length).toBeGreaterThan(95_000);
    const start = performance.now();
    const out = tidySummaryText(input);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(out.startsWith("Gövde kelime")).toBe(true);
  });

  it("is linear on a line that is mostly newlines", () => {
    const input = `Başlık satırı burada yazılı\n${"\n".repeat(50_000)}Gövde metni.`;
    const start = performance.now();
    tidySummaryText(input);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});

describe("tidySummaryText line breaks between sentences (h31-reader-4)", () => {
  // The first line holds a sentence mark in its middle, so step 1d (heading line)
  // leaves it alone and these cases only exercise step 2.
  const LEAD = "Bakan konuştu. Haber metni burada biter";
  const NEXT = "Yeni satır burada başlıyor.";

  describe("a line that ends in punctuation joins with one blank, never with '. '", () => {
    it.each([".", "!", "?", "…", ":", ";", ",", "–", "—", "-", '"', "”", "»", ")"])(
      "a line ending in %s",
      (mark) => {
        expect(tidySummaryText(`${LEAD}${mark}\n${NEXT}`)).toBe(`${LEAD}${mark} ${NEXT}`);
      },
    );
  });

  describe("a line that ends in a letter or a digit in front of a capital becomes a sentence", () => {
    it("a letter at the end", () => {
      expect(tidySummaryText(`${LEAD}\n${NEXT}`)).toBe(`${LEAD}. ${NEXT}`);
    });

    it("a digit at the end", () => {
      expect(tidySummaryText("Ölü sayısı 12\nKurtarma çalışmaları sürüyor.")).toBe(
        "Ölü sayısı 12. Kurtarma çalışmaları sürüyor.",
      );
    });

    it.each(["Ç", "Ğ", "İ", "Ö", "Ş", "Ü", "Â", "A", "Z"])("a next line that starts with %s", (ch) => {
      expect(tidySummaryText(`${LEAD}\n${ch}lan satır burada başlıyor.`)).toBe(
        `${LEAD}. ${ch}lan satır burada başlıyor.`,
      );
    });

    it.each([
      ["lower case", "ç", "çalışmalar sürüyor."],
      ["a lower-case dotted i", "i", "ilerleyen saatlerde açıklama yapıldı."],
      ["a lower-case dotless i", "ı", "ılımlı bir hava bekleniyor."],
      ["a digit", "2", "2026 yılının son ayı geliyor."],
      ["a straight quote", '"', '"Tam bir başarı" dedi.'],
      ["a curly quote", "“", "“Tam bir başarı” dedi."],
      ["a bracket", "(", "(Fotoğraf: AA) yayımlandı."],
      ["a dash", "-", "-5 derece bekleniyor."],
    ])("a next line that starts with %s: only a blank", (_label, _ch, next) => {
      expect(tidySummaryText(`${LEAD}\n${next}`)).toBe(`${LEAD} ${next}`);
    });
  });

  describe("a line that ends in a continuation word goes on in the next line", () => {
    it.each([
      ["Bakan açıklama yaptı ve\nAnkara'da toplantı yapıldı.", "Bakan açıklama yaptı ve Ankara'da toplantı yapıldı."],
      ["Bakan Rusya ile\nİstanbul'da görüştü.", "Bakan Rusya ile İstanbul'da görüştü."],
      ["Vali açıklama yaptı veya\nBelediye duyurdu.", "Vali açıklama yaptı veya Belediye duyurdu."],
      ["Takım yendi ama\nÇok yoruldu.", "Takım yendi ama Çok yoruldu."],
      ["Karar verildi çünkü\nÜlke zor durumda.", "Karar verildi çünkü Ülke zor durumda."],
      ["Bu iş için\nÖzel bütçe ayrıldı.", "Bu iş için Özel bütçe ayrıldı."],
      ["Bakan dedi ki\nŞehir güvende.", "Bakan dedi ki Şehir güvende."],
      ["Takım Ankara kadar\nİstanbul'da da güçlü.", "Takım Ankara kadar İstanbul'da da güçlü."],
      ["Fire broke out and\nPolice arrived.", "Fire broke out and Police arrived."],
      ["Police arrived to\nSecure the area.", "Police arrived to Secure the area."],
    ])("%j", (raw, expected) => {
      expect(tidySummaryText(raw)).toBe(expected);
    });

    it("the word is compared in upper case too, with both Turkish and plain folds", () => {
      expect(tidySummaryText("Bakan açıklama yaptı VE\nAnkara'da toplantı yapıldı.")).toBe(
        "Bakan açıklama yaptı VE Ankara'da toplantı yapıldı.",
      );
      expect(tidySummaryText("Bu iş İÇİN\nÖzel bütçe ayrıldı.")).toBe("Bu iş İÇİN Özel bütçe ayrıldı.");
      expect(tidySummaryText("Bakan Rusya ILE\nİstanbul'da görüştü.")).toBe("Bakan Rusya ILE İstanbul'da görüştü.");
    });

    it("the word must stand alone: a suffix or a longer word with the same ending is a sentence end", () => {
      // "da" after an apostrophe is a suffix; "Sevde", "kaide" and "hiçbiri" only end in a listed word.
      expect(tidySummaryText("Toplantı Ankara'da\nİstanbul'da sürdü.")).toBe("Toplantı Ankara'da. İstanbul'da sürdü.");
      expect(tidySummaryText("Başkan konuştu Sevde\nAnkara'da kaldı.")).toBe("Başkan konuştu Sevde. Ankara'da kaldı.");
      expect(tidySummaryText("Kural bu kaide\nAnkara'da geçerli.")).toBe("Kural bu kaide. Ankara'da geçerli.");
    });

    it("a word longer than eight letters is never a continuation word", () => {
      expect(tidySummaryText("Toplantı sürdü ilevarmıyor\nAnkara'da bitti.")).toBe(
        "Toplantı sürdü ilevarmıyor. Ankara'da bitti.",
      );
    });

    it("a heading-shaped first line that ends in a continuation word is not a heading (step 1d keeps it)", () => {
      // 23 characters, no mark, a capital behind it and a body of 80+ characters: step 1d
      // would drop it as a heading if it did not end in "ve".
      const body = "Gövde metni burada başlıyor ve devam ediyor, ayrıntılar ise haberin sonraki bölümlerinde yer alıyor.";
      expect(tidySummaryText(`Bakan açıklama yaptı ve\n${body}`)).toBe(`Bakan açıklama yaptı ve ${body}`);
      expect(tidySummaryText(`Bakan açıklama yaptı\n${body}`)).toBe(body);
    });

    it("a continuation word on a line of its own", () => {
      expect(tidySummaryText("Ankara\nve\nİstanbul'da sağanak bekleniyor.")).toBe(
        "Ankara ve İstanbul'da sağanak bekleniyor.",
      );
    });
  });

  describe("list markers on the later lines are dropped, the first line is left to step 2b", () => {
    it("bullets with '-', '•' and the square bullet", () => {
      expect(
        tidySummaryText("Birinci madde burada\n- İkinci madde burada\n• Üçüncü madde burada\n▪️ Dördüncü madde"),
      ).toBe("Birinci madde burada. İkinci madde burada. Üçüncü madde burada. Dördüncü madde");
    });

    it("a lead-in line with a colon and two bullets", () => {
      expect(tidySummaryText("Gelişmeler:\n- Yangın söndürüldü\n- Yollar açıldı")).toBe(
        "Gelişmeler: Yangın söndürüldü. Yollar açıldı",
      );
    });

    it("the other markers '–' and '*', and two stacked markers", () => {
      expect(tidySummaryText("Birinci madde burada\n– İkinci madde burada\n* Üçüncü madde burada\n- - Dördüncü madde")).toBe(
        "Birinci madde burada. İkinci madde burada. Üçüncü madde burada. Dördüncü madde",
      );
    });

    it("a dash glued to a digit is not a marker", () => {
      expect(tidySummaryText("Hava soğuyor\n-5 derece bekleniyor")).toBe("Hava soğuyor -5 derece bekleniyor");
    });

    it("a marker glued to the word is not a marker either", () => {
      expect(tidySummaryText("Hava soğuyor\n•Üşüyoruz")).toBe("Hava soğuyor •Üşüyoruz");
    });

    it("the first line keeps step 2b's budget: it still loses its marker there", () => {
      expect(tidySummaryText("- Birinci madde burada\n- İkinci madde burada")).toBe(
        "Birinci madde burada. İkinci madde burada",
      );
    });

    it("a leading blank line does not make the next line 'later': step 2b still strips two markers", () => {
      expect(tidySummaryText("\n\n- - - X\n- Y")).toBe("- X. Y");
    });
  });

  describe("single-line texts are untouched", () => {
    it.each([
      ["- - - X", "- X"],
      ["- X", "X"],
      ["• X", "X"],
      ["Tek satırlık bir metin burada Yeni", "Tek satırlık bir metin burada Yeni"],
      ["Ölü sayısı 12 Kurtarma çalışmaları sürüyor.", "Ölü sayısı 12 Kurtarma çalışmaları sürüyor."],
      ["", ""],
      ["   ", ""],
    ])("%j", (raw, expected) => {
      expect(tidySummaryText(raw)).toBe(expected);
    });

    it("a lone carriage return is a line break, as it was before", () => {
      expect(tidySummaryText("Satır bir burada\rSatır iki burada.")).toBe("Satır bir burada. Satır iki burada.");
      expect(tidySummaryText("Satır bir burada,\rsatır iki burada.")).toBe("Satır bir burada, satır iki burada.");
    });
  });

  describe("CRLF, blank lines and blanks around the breaks", () => {
    it("CRLF with blank and whitespace-only lines in between", () => {
      expect(tidySummaryText("Satır bir burada\r\n\r\n  \nSatır iki burada.")).toBe(
        "Satır bir burada. Satır iki burada.",
      );
    });

    it("blanks and NBSP around the line breaks", () => {
      expect(tidySummaryText("Satır bir burada  \t\n   Satır iki burada.")).toBe(
        "Satır bir burada. Satır iki burada.",
      );
    });

    it("leading and trailing line breaks", () => {
      expect(tidySummaryText("\n\nSatır bir burada\nSatır iki burada.\n\n")).toBe("Satır bir burada. Satır iki burada.");
    });

    it("a trailing line break after a letter adds no full stop", () => {
      expect(tidySummaryText("Satır bir burada\n")).toBe("Satır bir burada");
    });
  });

  describe("a trailing CTA after a line break is still peeled", () => {
    it("'Devamı için tıklayınız' on the next line", () => {
      expect(tidySummaryText("Yangın söndürüldü\nDevamı için tıklayınız")).toBe("Yangın söndürüldü.");
    });

    it("'Detaylar haberimizde' on the next line after a sentence", () => {
      expect(tidySummaryText("Yangın söndürüldü.\nDetaylar haberimizde")).toBe("Yangın söndürüldü.");
    });
  });

  describe("the older line-break behaviour that must not move", () => {
    it("a widget heading line is dropped, the lines around it join as before", () => {
      expect(tidySummaryText("belirtti.\nİlginizi Çekebilir\nToplantıya")).toBe("belirtti. Toplantıya");
    });

    it("a line ending in a letter in front of a lower-case line", () => {
      expect(tidySummaryText("a\n\n b")).toBe("a b");
    });
  });

  it("f85bc48e verbatim, run through the whole pipeline", () => {
    expect(tidySummaryText(H30_F85B)).toBe(
      'Koreli öğrencilere Türkçe öğretilen sınıfı ziyaret eden Emine Erdoğan, öğrencilerle sohbet etti. Koreli iki öğrencinin Türkçe diyaloglarını dinleyen Emine Erdoğan, konuşmalarını beğendiği öğrencileri alkışlayarak tebrik etti. Emine Erdoğan: "Türkçemize ilgi duyan öğrencilerimizle buluşmak, dilimizin ve kültürümüzün uzak coğrafyalarda nasıl güzel karşılıklar bulduğuna şahit olmak çok kıymetli"',
    );
  });

  const FIXTURES: readonly string[] = [
    H30_F85B,
    `${LEAD}\n${NEXT}`,
    `${LEAD}.\n${NEXT}`,
    "Ölü sayısı 12\nKurtarma çalışmaları sürüyor.",
    "Bakan açıklama yaptı ve\nAnkara'da toplantı yapıldı.",
    "Birinci madde burada\n- İkinci madde burada\n• Üçüncü madde burada\n▪️ Dördüncü madde",
    "Gelişmeler:\n- Yangın söndürüldü\n- Yollar açıldı",
    "Hava soğuyor\n-5 derece bekleniyor",
    // At most MAX_MARKER_PASSES (2) stacked markers on the first line: three are the
    // documented idempotence exception ("- - - X" -> "- X" -> "X").
    "- - X",
    "\n\n- - X\n- Y",
    "Satır bir burada\r\n\r\n  \nSatır iki burada.",
    "Yangın söndürüldü\nDevamı için tıklayınız",
    "Yangın söndürüldü\nDevamı için tıklayınız\nDetaylar haberimizde",
    "Son dakika | Yangın söndürüldü\nYollar açıldı\nTrafik normale döndü",
    "Satır bir burada\rSatır iki burada.",
    "A\nB\nC\nD",
    "1\nA\n2\nB",
  ];

  it("no newline is left in any output", () => {
    for (const raw of FIXTURES) {
      expect(hasNoNewline(tidySummaryText(raw)), raw).toBe(true);
    }
  });

  it("is idempotent on every fixture, input and output", () => {
    for (const raw of FIXTURES) {
      const once = tidySummaryText(raw);
      expect(tidySummaryText(once), raw).toBe(once);
      for (const line of [raw, once]) {
        const again = tidySummaryText(line);
        expect(tidySummaryText(again), line).toBe(again);
      }
    }
  });

  describe("linear time", () => {
    // Each bound is 1000 ms; the measured values (Node 24, development machine, cold
    // process) are recorded next to each case and every one is at most 333 ms, so the
    // bound keeps 3x headroom. Every input is long enough to expose a quadratic scan.
    function timed(input: string): { ms: number; out: string } {
      const start = performance.now();
      const out = tidySummaryText(input);
      return { ms: performance.now() - start, out };
    }

    it("6,000 sentence lines", () => {
      const input = "Satır kelime burada\n".repeat(6_000);
      const { ms, out } = timed(input);
      // Measured: 20-23 ms (3 cold runs; limit 1000, ceiling for the record 333).
      expect(ms).toBeLessThan(1000);
      expect(out.startsWith("Satır kelime burada. Satır kelime burada. ")).toBe(true);
      expect(hasNoNewline(out)).toBe(true);
    });

    it("15,000 bullet lines", () => {
      const input = "- Madde\n".repeat(15_000);
      const { ms, out } = timed(input);
      // Measured: 33-36 ms (3 cold runs; limit 1000, ceiling for the record 333).
      expect(ms).toBeLessThan(1000);
      expect(out.startsWith("Madde. Madde. Madde")).toBe(true);
      expect(hasNoNewline(out)).toBe(true);
    });

    it("60,000 one-letter lines", () => {
      const input = "a\n".repeat(60_000);
      const { ms, out } = timed(input);
      // Measured: 60-62 ms (3 cold runs; limit 1000, ceiling for the record 333).
      expect(ms).toBeLessThan(1000);
      expect(out.startsWith("a a a a")).toBe(true);
      expect(hasNoNewline(out)).toBe(true);
    });

    it("100,000 line breaks and nothing else", () => {
      const { ms, out } = timed("\n".repeat(100_000));
      // Measured: 8 ms (3 cold runs; limit 1000, ceiling for the record 333).
      expect(ms).toBeLessThan(1000);
      expect(out).toBe("");
    });

    it("a 100k single line", () => {
      const input = "kelime ".repeat(14_300);
      expect(input.length).toBeGreaterThan(99_000);
      const { ms, out } = timed(input);
      // Measured: 1.4 ms (3 cold runs; limit 1000, ceiling for the record 333).
      expect(ms).toBeLessThan(1000);
      expect(out).toBe(input.trim());
    });
  });
});

// ---------------------------------------------------------------------------
// h34-reader-5 (hunt 34, 2026-11-05): trailing teaser lines in the shown summary.
//
// d91ab2f1 (Erdoğan returns from Korea) stores two real sentences and then two
// other stories' headlines pasted by the feed. tidySummaryText now drops them with
// stripTrailingTeasers (one implementation, shared with the cluster consumer's
// cleanDescription; tests/functions/_shared/description-clean.test.ts holds the
// shape table). The rows are the stored summary_tr texts, read-only, 2026-11-05.
// ---------------------------------------------------------------------------

const H34_D91 =
  "Cumhurbaşkanı Erdoğan'ı, \"TUR\" uçağıyla geldiği Atatürk Havalimanı'nda, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İstanbul Valisi Davut Gül ile AK Parti İstanbul İl Başkanı Abdullah Özdemir ve ilgililer karşıladı.\nCumhurbaşkanı Erdoğan ile eşi Emine Erdoğan ve ziyarette kendisine eşlik eden heyet üyeleri de İstanbul'a geldi.\nAnkara'da kritik güvenlik zirvesi! Bakan Çiftçi, İtalyan mevkidaşı ile bir araya geldi\nDünyanın gözü ABD'den gelen sonuçlarda! İşte ABD'deki seçim hezimetinin nedeni! Trump...";
const H34_D91_SHOWN =
  "Cumhurbaşkanı Erdoğan'ı, \"TUR\" uçağıyla geldiği Atatürk Havalimanı'nda, Cumhurbaşkanı Yardımcısı Cevdet Yılmaz, İstanbul Valisi Davut Gül ile AK Parti İstanbul İl Başkanı Abdullah Özdemir ve ilgililer karşıladı. Cumhurbaşkanı Erdoğan ile eşi Emine Erdoğan ve ziyarette kendisine eşlik eden heyet üyeleri de İstanbul'a geldi.";

const H34_AB24_LEAD =
  "Ankara Cumhuriyet Başsavcılığı koordinesinde, Alihan Kuriş suç örgütüne yönelik operasyonda gözaltına alınan şüphelilerden 19’u tutuklandı, 5’i adli kontrol şartıyla serbest bırakıldı.";
const H34_AB24 = `${H34_AB24_LEAD}\nMacron duyurdu: Fransa'da yağma ve şiddet olaylarının ardından 'yasaklama' kararı!\nBeyaz Saray tarih verdi: ABD, 3 Kasım seçimlerinden önce İran'a saldırmayacak`;

const H34_FD00_KEPT =
  "Manisa Organize Sanayi Bölgesi'ndeki akü fabrikasında henüz belirlenemeyen nedenle yangın çıktı.\nİhbar üzerine bölgeye itfaiye ve sağlık ekipleri sevk edildi.\nİtfaiye ekipleri, yangını kontrol altına almak için çalışmalarını sürdürüyor.\nİçişleri Bakanlığı duyurdu: Çukurova Belediye Başkanı Emrah Kozay görevden uzaklaştırıldı";
const H34_FD00 = `${H34_FD00_KEPT}\nVolkswagen'de kriz sürüyor! Çalışanlardan 'hafta sonu greve gideriz' tehdidi`;

const H34_1E6D_LEAD =
  "Çin’in Tibet Özerk Bölgesi’nde TSİ 17.33’te 7 büyüklüğünde deprem meydana geldi.\nÇin Deprem Ağları Merkezi (CENC) verilerine göre, merkez üssü Tibet'in kuzeyindeki Nagqu olan deprem yerin 10 kilometre derinliğinde gerçekleşti.\nCENC, sarsıntının bölgede hissedildiğini açıkladı. Depremdeki can ve mal kaybına ilişkin henüz açıklama yapılmadı.";
const H34_1E6D_JULIDE = "Jülide Kural sessizliğini bozdu! Kadir İnanır’ın miras tartışmaları sonrası ilk açıklama";
const H34_1E6D = `${H34_1E6D_LEAD}\n${H34_1E6D_JULIDE}\nLütfi Arıboğan hakkında 5 yıla kadar hapis istemi! İşte FETÖ'cü Ba...`;

/** [label, stored text, shown text] */
const H34_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["d91ab2f1: two teaser lines (an unpunctuated one with a mid-line '!' and a clamped 'İşte ...!' one)", H34_D91, H34_D91_SHOWN],
  ["ab24d85a: an exclamation headline and an unpunctuated headline after it", H34_AB24, H34_AB24_LEAD],
  [
    "fd00fb08: the exclamation headline goes, the unpunctuated headline in front of it stays",
    H34_FD00,
    tidySummaryText(H34_FD00_KEPT),
  ],
  [
    "1e6da42b: the clamped headline goes, the one that shares the stem 'açıkla' stays",
    H34_1E6D,
    tidySummaryText(`${H34_1E6D_LEAD}\n${H34_1E6D_JULIDE}`),
  ],
];

describe("tidySummaryText drops trailing teaser lines (h34-reader-5)", () => {
  it.each(H34_ROWS)("%s", (_label, stored, shown) => {
    expect(tidySummaryText(stored)).toBe(shown);
  });

  it("d91ab2f1: the shown text keeps both real sentences and loses the only 'Trump'", () => {
    const out = tidySummaryText(H34_D91);
    expect(out).toBe(H34_D91_SHOWN);
    expect(out.endsWith("de İstanbul'a geldi.")).toBe(true);
    expect(out).not.toContain("Trump");
    expect(out).not.toContain("Çiftçi");
    expect(out).toContain("AK Parti İstanbul İl Başkanı Abdullah Özdemir");
  });

  it("fd00fb08 and 1e6da42b: the kept headline is still there (nothing proves it is a teaser)", () => {
    expect(tidySummaryText(H34_FD00)).toContain("Çukurova Belediye Başkanı Emrah Kozay görevden uzaklaştırıldı");
    expect(tidySummaryText(H34_FD00)).not.toContain("Volkswagen");
    expect(tidySummaryText(H34_1E6D)).toContain("Jülide Kural sessizliğini bozdu!");
    expect(tidySummaryText(H34_1E6D)).not.toContain("Arıboğan");
  });

  describe("parity with the cluster consumer's cleaning", () => {
    it.each(H34_ROWS)("%s: tidying the stripped text gives the same shown text", (_label, stored) => {
      const stripped = stripTrailingTeasers(stored);
      expect(stripped).not.toBe(stored);
      expect(cleanDescription(stored)).toBe(stripped);
      expect(tidySummaryText(stripped)).toBe(tidySummaryText(stored));
    });

    it("the shapes the strip refuses are refused here too (same text in, same text out)", () => {
      const refused = [
        // a headline-shaped last line that ends in a full stop
        "Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor.",
        // a quoted line
        'Manisa\'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.\nVolkswagen\'de kriz sürüyor! "Greve gideriz" dediler',
        // a bare clamp
        "Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.\nVolkswagen'de kriz sürüyor, çalışanlar greve gidiyor...",
        // the same story
        "Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.\nManisa'da korkutan yangın! İtfaiye ekipleri müdahale etti",
        // a bullet
        "Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.\n- Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor",
        // b5f5c40f: a real paragraph opened by a conjunction ("Ama ...!"), then a call-to-action line
        "Gelin, Kardeş-Gardaş'a, duygusallıktan uzak konuşalım, biraz da dertleşelim.\nAma şu iki liderin sözünü, ayrıca o tarihi belgeyi imzalayanların kıymetini asla unutmayalım!\n Azerbaycan'ın sevinci...Devamı için tıklayınız",
        // a speech in typographic single quotes ending in a quoted "!"
        "Kabine toplantısı sona erdi.\nBakan Yılmaz: ‘Kimse endişe etmesin, bu iş burada bitmeyecek!’",
      ];
      for (const raw of refused) {
        expect(stripTrailingTeasers(raw) === raw, raw).toBe(true);
        const second = raw.split("\n")[1]!.replace(/^- /, "");
        expect(tidySummaryText(raw), raw).toContain(second.slice(0, 20));
      }
    });
  });

  it("the h31-reader-4 bullet list and its neighbours are unchanged", () => {
    expect(tidySummaryText(H30_F85B)).toBe(
      'Koreli öğrencilere Türkçe öğretilen sınıfı ziyaret eden Emine Erdoğan, öğrencilerle sohbet etti. Koreli iki öğrencinin Türkçe diyaloglarını dinleyen Emine Erdoğan, konuşmalarını beğendiği öğrencileri alkışlayarak tebrik etti. Emine Erdoğan: "Türkçemize ilgi duyan öğrencilerimizle buluşmak, dilimizin ve kültürümüzün uzak coğrafyalarda nasıl güzel karşılıklar bulduğuna şahit olmak çok kıymetli"',
    );
    expect(tidySummaryText("Gelişmeler:\n- Yangın söndürüldü!\n- Yollar açıldı!")).toBe(
      "Gelişmeler: Yangın söndürüldü! Yollar açıldı!",
    );
    expect(tidySummaryText("Birinci madde burada\n- İkinci madde burada\n• Üçüncü madde burada\n▪️ Dördüncü madde")).toBe(
      "Birinci madde burada. İkinci madde burada. Üçüncü madde burada. Dördüncü madde",
    );
  });

  it("a real multi-sentence description with an exclamation in the middle of a sentence keeps every line", () => {
    const raw = "Galatasaray, Stuttgart'ı 2-0 yendi.\nKazandık! Galatasaray taraftarı stadı inletti\nStuttgart cephesinde hayal kırıklığı yaşandı.";
    expect(tidySummaryText(raw)).toBe(
      "Galatasaray, Stuttgart'ı 2-0 yendi. Kazandık! Galatasaray taraftarı stadı inletti. Stuttgart cephesinde hayal kırıklığı yaşandı.",
    );
  });

  describe("order of the steps", () => {
    it("a ticker line cut first, then the teaser in front of it", () => {
      const raw = "Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor\nSon dakika... Rusya için 3 fırsat!";
      expect(tidySummaryText(raw)).toBe("Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti.");
    });

    it("a text whose only later line is a teaser keeps its first line (nothing is emptied)", () => {
      expect(tidySummaryText("Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor")).toBe(
        "Manisa'da akü fabrikasında yangın çıktı, itfaiye ekipleri müdahale etti",
      );
      expect(tidySummaryText("\nVolkswagen'de kriz sürüyor! Çalışanlar greve gidiyor")).toBe(
        "Volkswagen'de kriz sürüyor! Çalışanlar greve gidiyor",
      );
    });
  });

  it("no newline is left and the output is idempotent on every teaser row", () => {
    for (const [, stored] of H34_ROWS) {
      const once = tidySummaryText(stored);
      expect(hasNoNewline(once)).toBe(true);
      expect(tidySummaryText(once)).toBe(once);
    }
  });

  it("100k-character adversarial inputs stay linear (1000 ms bound each)", () => {
    const inputs = [
      "Giriş cümlesi burada biter.\n" + "Gündem hareketli! Piyasalar duyurdu\n".repeat(3_000),
      "Giriş cümlesi burada biter.\n" + "!".repeat(100_000),
      "Giriş cümlesi burada biter.\n" + "A! ".repeat(33_000),
      "Giriş cümlesi burada biter.\n" + "a".repeat(100_000) + "!",
      "\n".repeat(100_000) + "Başlık duyuruldu! Gündem hareketli",
      "x\n".repeat(50_000) + "Volkswagen kriz sürüyor!",
    ];
    for (const raw of inputs) {
      const start = performance.now();
      tidySummaryText(raw);
      expect(performance.now() - start, `${raw.length} chars`).toBeLessThan(1000);
    }
  });
});
