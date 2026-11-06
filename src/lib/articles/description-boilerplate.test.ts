import { describe, expect, it } from "vitest";

import {
  BOILERPLATE_PHRASES,
  isBoilerplateDescription,
  isHeadlineEcho,
  startsWithPlaceholderLine,
  TRAILING_CTA_PHRASES,
} from "./description-boilerplate";

describe("BOILERPLATE_PHRASES", () => {
  it("is exported and holds the known call-to-action phrases", () => {
    expect(BOILERPLATE_PHRASES.has("devamı için tıklayınız")).toBe(true);
    expect(BOILERPLATE_PHRASES.has("read more")).toBe(true);
    expect(BOILERPLATE_PHRASES.has("ayrıntılar birazdan")).toBe(true);
    // h48-ingest-1: the "coming soon" placeholders some feeds ship as the whole
    // description (Milliyet, Posta, Muhalif).
    for (const phrase of [
      "ayrıntılar geliyor",
      "ayrıntılar gelecek",
      "detaylar geliyor",
      "detaylar gelecek",
    ]) {
      expect(BOILERPLATE_PHRASES.has(phrase), phrase).toBe(true);
    }
    expect(BOILERPLATE_PHRASES.size).toBe(13);
  });

  it("stores every entry lower-case and trimmed (the matchers fold the input, not the Set)", () => {
    for (const phrase of BOILERPLATE_PHRASES) {
      expect(phrase, phrase).toBe(phrase.trim());
      expect(phrase, phrase).toBe(phrase.toLowerCase());
      expect(phrase, phrase).toBe(phrase.toLocaleLowerCase("tr-TR"));
      expect(phrase.length, phrase).toBeGreaterThan(0);
    }
  });
});

describe("TRAILING_CTA_PHRASES (h22-editorial-2, h23-live-1)", () => {
  it("holds the six sentence-style tails and leaves the rest of BOILERPLATE_PHRASES alone", () => {
    expect([...TRAILING_CTA_PHRASES].sort()).toEqual([
      "detaylar haberimizde",
      "işte ayrıntılar",
      "işte detaylar",
      "işte merak edilen tüm detaylar",
      "işte merak edilenler",
      "işte tüm detaylar",
    ]);
    expect(BOILERPLATE_PHRASES.size).toBe(13);
    for (const phrase of TRAILING_CTA_PHRASES) expect(BOILERPLATE_PHRASES.has(phrase), phrase).toBe(false);
  });

  it("stores every entry tr-TR lower-case and trimmed", () => {
    for (const phrase of TRAILING_CTA_PHRASES) {
      expect(phrase, phrase).toBe(phrase.trim());
      expect(phrase, phrase).toBe(phrase.toLocaleLowerCase("tr-TR"));
      expect(phrase, phrase).not.toMatch(/\s{2,}/);
    }
  });
});

describe("isBoilerplateDescription", () => {
  it.each([
    "Click to continue",
    "Click to continue.",
    " click to continue… ",
    "CLICK TO CONTINUE",
    "Click here to continue",
    "Read more",
    "Read more »",
    "Continue reading",
    "Devamını oku",
    "Devamını oku...",
    "Devamı için tıklayın",
    "Devamı için tıklayınız!",
    "Haberin devamı için tıklayın",
  ])("flags %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "İşte detaylar...",
    "İşte ayrıntılar",
    "İŞTE AYRINTILAR!",
    "Detaylar haberimizde…",
    "DETAYLAR HABERİMİZDE",
    "  işte   detaylar \n",
  ])("flags the sentence-style tail %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "İşte merak edilen tüm detaylar...",
    "İşte merak edilen tüm detaylar",
    "İŞTE MERAK EDİLEN TÜM DETAYLAR!",
    "İşte tüm detaylar!",
    "işte  tüm   detaylar",
    "İşte merak edilenler",
    "İşte merak edilenler…",
  ])("flags the h23 sentence-style tail %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "Ayrıntılar birazdan...",
    "Ayrıntılar birazdan",
    "AYRINTILAR BİRAZDAN",
    "  ayrıntılar   birazdan…  ",
  ])("flags the placeholder %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "Ayrıntılar birazdan açıklanacak",
    "Ayrıntılar birazdan sonra",
    "Tüm ayrıntılar birazdan",
    "İşte tüm detaylar ve rakamlar",
    "İşte merak edilenleri açıkladı",
    "İşte merak edilen tüm detaylarıyla",
    "Bakan açıkladı: İşte tüm detaylar",
  ])("does not flag %j (exact match only)", (s) => {
    expect(isBoilerplateDescription(s)).toBe(false);
  });

  it.each([
    "İşte detaylarıyla yeni düzenleme",
    "İşte detaylar ve yeni kurallar",
    "Detaylar haberimizde yer alıyor",
    "Yeni kurallar: İşte detaylar",
  ])("does not flag %j (the phrase is not the whole text)", (s) => {
    expect(isBoilerplateDescription(s)).toBe(false);
  });

  it("strips a very long trailing punctuation run in linear time", () => {
    const start = performance.now();
    expect(isBoilerplateDescription("Read more" + "!".repeat(200_000))).toBe(true);
    expect(isBoilerplateDescription(".".repeat(200_000) + "a")).toBe(false);
    expect(isBoilerplateDescription("a" + ".".repeat(200_000) + "b")).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("flags the Turkish uppercase form (dotted capital İ)", () => {
    expect(isBoilerplateDescription("DEVAMI İÇİN TIKLAYIN")).toBe(true);
    expect(isBoilerplateDescription("HABERİN DEVAMI İÇİN TIKLAYIN")).toBe(true);
  });

  it("flags the Turkish uppercase form of a word with dotless ı", () => {
    // "DEVAMINI OKU": plain toLowerCase() gives "devamini oku" (wrong i);
    // toLocaleLowerCase('tr-TR') gives "devamını oku" (the Set entry).
    expect(isBoilerplateDescription("DEVAMINI OKU")).toBe(true);
  });

  it("collapses internal whitespace and newlines", () => {
    expect(isBoilerplateDescription("Click   to\n continue")).toBe(true);
    expect(isBoilerplateDescription("\tDevamını oku\t")).toBe(true);
  });

  it("strips mixed trailing punctuation", () => {
    expect(isBoilerplateDescription("Click to continue ...")).toBe(true);
    expect(isBoilerplateDescription("Read more >")).toBe(true);
    expect(isBoilerplateDescription("Read more ›")).toBe(true);
  });

  it("does not flag a real summary", () => {
    expect(
      isBoilerplateDescription(
        "Bakan, yeni vergi düzenlemesinin ilk aşamasının gelecek ay yürürlüğe gireceğini açıkladı.",
      ),
    ).toBe(false);
  });

  it("uses exact matching: a longer sentence starting with the phrase is not boilerplate", () => {
    expect(
      isBoilerplateDescription(
        "Click to continue reading the minister's statement on ...",
      ),
    ).toBe(false);
    expect(isBoilerplateDescription("Please click to continue")).toBe(false);
    expect(isBoilerplateDescription("Devamını oku ve yorum yap")).toBe(false);
  });

  it("does not flag a leading-punctuation variant (only trailing is stripped)", () => {
    expect(isBoilerplateDescription("» Read more")).toBe(false);
  });

  it("returns false for null, undefined, empty and whitespace-only input", () => {
    expect(isBoilerplateDescription(null)).toBe(false);
    expect(isBoilerplateDescription(undefined)).toBe(false);
    expect(isBoilerplateDescription("")).toBe(false);
    expect(isBoilerplateDescription("   \n\t ")).toBe(false);
  });

});

describe("isBoilerplateDescription: the 'coming soon' placeholders (h48-ingest-1)", () => {
  it.each([
    "Ayrıntılar geliyor...",
    "Ayrıntılar geliyor",
    "ayrıntılar geliyor...",
    "Ayrıntılar gelecek…",
    "Detaylar geliyor.",
    "Detaylar gelecek…",
    "DETAYLAR GELİYOR...",
    "DETAYLAR GELECEK",
    "AYRINTILAR GELİYOR!",
    "  detaylar   geliyor \n",
  ])("flags the placeholder %j as boilerplate", (s) => {
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "Ayrıntılar geliyor: Bakan Yılmaz açıklama yaptı ve ...",
    "Ayrıntılar geliyor, Bakan Yılmaz açıklama yaptı",
    "Detaylar gelecek hafta açıklanacak",
    "Tüm ayrıntılar geliyor",
    "Bakan açıkladı: detaylar geliyor",
    "Ayrıntılar gelmedi",
  ])("does not flag %j (exact match only)", (s) => {
    expect(isBoilerplateDescription(s)).toBe(false);
  });
});

describe("isBoilerplateDescription: punctuation-only text (h48-ingest-1)", () => {
  it.each([".", "…", "...", " . ", "!", "?!", "- - -", "***", "«»", ". . .", "\n.\n", "\u00a0.\u00a0", "|", "› »", "🔴"])(
    "flags %j (nothing but punctuation and whitespace)",
    (s) => {
      expect(isBoilerplateDescription(s)).toBe(true);
    },
  );

  it.each(["a.", ".a", "1", "…ve", "- 5 derece", "Hayır.", "ç", "…\nBakan"])(
    "does not flag %j (it holds a letter or a digit)",
    (s) => {
      expect(isBoilerplateDescription(s)).toBe(false);
    },
  );

  it("still returns false for empty and whitespace-only input", () => {
    expect(isBoilerplateDescription("")).toBe(false);
    expect(isBoilerplateDescription("   \n\t ")).toBe(false);
  });
});

describe("startsWithPlaceholderLine / a placeholder FIRST line (h48-ingest-1, a72f9464)", () => {
  it.each([
    "Ayrıntılar geliyor...\n\n\n\nKKTC Başbakanı Üstel, KKTC ile ilgili açıklamaları için Cumhurbaşkanı Erdoğan'a teşekkür etti",
    "Ayrıntılar birazdan...\nKaynak: TRT Haber",
    "\n\n  Detaylar gelecek…  \r\nBaşka bir haberin başlığı",
    "Click to continue\nBakan açıkladı",
    "DETAYLAR GELİYOR\rBaşlık",
    "Ayrıntılar geliyor...",
  ])("is true for %j", (s) => {
    expect(startsWithPlaceholderLine(s)).toBe(true);
    expect(isBoilerplateDescription(s)).toBe(true);
  });

  it.each([
    "Ayrıntılar geliyor: Bakan Yılmaz açıklama yaptı\nİkinci satır",
    "Bakan açıkladı.\nAyrıntılar geliyor...",
    "Ayrıntılar geliyor, Bakan\nYılmaz açıkladı",
    "İşte detaylar\nBakan Yılmaz açıkladı",
    "Gerçek özet satırı\nDetaylar gelecek",
    "",
    "   \n  ",
  ])("is false for %j", (s) => {
    expect(startsWithPlaceholderLine(s)).toBe(false);
  });

  it("is false for null and undefined", () => {
    expect(startsWithPlaceholderLine(null)).toBe(false);
    expect(startsWithPlaceholderLine(undefined)).toBe(false);
  });

  it("looks at the first line only, in linear time (a 1 MB text of blank lines or one long line)", () => {
    const start = performance.now();
    expect(startsWithPlaceholderLine("\n".repeat(1_000_000) + "Ayrıntılar geliyor...\nx")).toBe(true);
    expect(startsWithPlaceholderLine("a".repeat(1_000_000) + "\nAyrıntılar geliyor")).toBe(false);
    expect(startsWithPlaceholderLine(" ".repeat(1_000_000) + "x")).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});

describe("isHeadlineEcho (h48-ingest-1)", () => {
  const TITLE = "Bakan Yılmaz yeni vergi düzenlemesini açıkladı";

  it("is true when the description is the title", () => {
    expect(isHeadlineEcho(TITLE, TITLE)).toBe(true);
    expect(isHeadlineEcho("Korkusuz", "Korkusuz")).toBe(true);
  });

  it("ignores case, punctuation and whitespace differences", () => {
    expect(isHeadlineEcho(TITLE, TITLE.toLocaleUpperCase("tr-TR"))).toBe(true);
    expect(isHeadlineEcho(TITLE.toLocaleUpperCase("tr-TR"), TITLE)).toBe(true);
    expect(isHeadlineEcho(TITLE, `  ${TITLE}  `)).toBe(true);
    expect(isHeadlineEcho(TITLE, "Bakan  Yılmaz\nyeni   vergi\tdüzenlemesini açıkladı")).toBe(true);
    expect(isHeadlineEcho(TITLE, `${TITLE}.`)).toBe(true);
    expect(isHeadlineEcho(`${TITLE}!`, TITLE)).toBe(true);
    expect(isHeadlineEcho(TITLE, `${TITLE}...`)).toBe(true);
    expect(isHeadlineEcho(`${TITLE}…`, TITLE)).toBe(true);
    expect(isHeadlineEcho(`${TITLE} ...`, `${TITLE}!?`)).toBe(true);
  });

  it("folds with the Turkish locale: I/ı and İ/i", () => {
    // A plain lower-case would give "ISPARTA" -> "isparta" and "Isparta" -> "isparta" (equal by luck) but
    // "ISPARTA'DA" vs "Isparta'da" and "İZMİR" vs "İzmir" both need the tr-TR rules to stay equal.
    expect(isHeadlineEcho("ISPARTA'DA YANGIN", "Isparta'da yangın")).toBe(true);
    expect(isHeadlineEcho("İZMİR'DE DEPREM", "İzmir'de deprem")).toBe(true);
    expect(isHeadlineEcho("İzmir'de deprem", "Izmir'de deprem")).toBe(false); // İ -> i, I -> ı: different words
  });

  it("normalises to NFC: a decomposed letter equals the composed one", () => {
    expect(isHeadlineEcho("Çalışma bakanı", "C\u0327alışma bakanı")).toBe(true);
    expect(isHeadlineEcho("Öğrenci", "O\u0308g\u0306renci")).toBe(true);
  });

  it("is true for an ellipsis-truncated echo: the description is a prefix of the title and ended in an ellipsis", () => {
    expect(isHeadlineEcho(TITLE, "Bakan Yılmaz yeni vergi düzenlemesini aç...")).toBe(true);
    expect(isHeadlineEcho(TITLE, "Bakan Yılmaz yeni vergi…")).toBe(true);
    expect(isHeadlineEcho(TITLE, "BAKAN YILMAZ YENİ VERGİ ...")).toBe(true);
    expect(isHeadlineEcho(`${TITLE}...`, "Bakan Yılmaz yeni vergi düzenlemesini...")).toBe(true);
  });

  it("is false for a truncated text that is not a prefix of the title", () => {
    expect(isHeadlineEcho(TITLE, "Bakan Yılmaz eski vergi...")).toBe(false);
    expect(isHeadlineEcho(TITLE, "yeni vergi düzenlemesini açıkladı...")).toBe(false);
  });

  it("is false for a prefix of the title WITHOUT an ellipsis (a complete shorter text)", () => {
    expect(isHeadlineEcho(TITLE, "Bakan Yılmaz yeni vergi")).toBe(false);
    expect(isHeadlineEcho(TITLE, "Bakan Yılmaz yeni vergi.")).toBe(false);
  });

  it("is false for a real summary that merely starts with the title and goes on", () => {
    expect(
      isHeadlineEcho(
        TITLE,
        `${TITLE}. Düzenleme gelecek ay yürürlüğe girecek ve ilk aşamada yalnızca şirketleri kapsayacak.`,
      ),
    ).toBe(false);
    expect(isHeadlineEcho(TITLE, `${TITLE}: ilk aşama gelecek ay`)).toBe(false);
    expect(isHeadlineEcho(TITLE, `${TITLE} ve devamı...`)).toBe(false);
  });

  it("is false when the description is longer than the title and only the title is a prefix of it", () => {
    expect(isHeadlineEcho("Bakan açıkladı", "Bakan açıkladı, yeni kurallar geliyor...")).toBe(false);
  });

  it("is false for null, undefined and empty input", () => {
    expect(isHeadlineEcho(TITLE, null)).toBe(false);
    expect(isHeadlineEcho(TITLE, undefined)).toBe(false);
    expect(isHeadlineEcho(TITLE, "")).toBe(false);
    expect(isHeadlineEcho(TITLE, "   \n ")).toBe(false);
    expect(isHeadlineEcho(null, "Bir özet")).toBe(false);
    expect(isHeadlineEcho(undefined, "Bir özet")).toBe(false);
    expect(isHeadlineEcho("", "Bir özet")).toBe(false);
    expect(isHeadlineEcho(null, null)).toBe(false);
    expect(isHeadlineEcho("", "")).toBe(false);
  });

  it("is false when either side is only punctuation (an empty prefix is not an echo)", () => {
    expect(isHeadlineEcho(TITLE, "...")).toBe(false);
    expect(isHeadlineEcho(TITLE, "…")).toBe(false);
    expect(isHeadlineEcho("...", "...")).toBe(false);
    expect(isHeadlineEcho("!", ".")).toBe(false);
  });

  it("is false for two different headlines", () => {
    expect(isHeadlineEcho(TITLE, "Merkez Bankası faizi sabit tuttu")).toBe(false);
  });

  it("runs in linear time on a very long text", () => {
    const start = performance.now();
    expect(isHeadlineEcho("a".repeat(200_000), "a".repeat(200_000) + "...")).toBe(true);
    expect(isHeadlineEcho("a ".repeat(100_000), " ".repeat(200_000) + "b")).toBe(false);
    expect(isHeadlineEcho("x", "!".repeat(200_000) + "...")).toBe(false);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
