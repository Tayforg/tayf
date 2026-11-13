import { describe, expect, it } from "vitest";

import {
  LEGAL_NOTICE_DESCRIPTION_PATTERNS,
  LEGAL_NOTICE_MIN_LETTERS,
  LEGAL_NOTICE_MIN_UPPER_RATIO,
  LEGAL_NOTICE_PATTERNS,
  NOTICE_DESCRIPTION_SCAN_CAP,
  isLegalNotice,
} from "../../../supabase/functions/_shared/rss/legal-notice.ts";
import { LEGAL_NOTICE_CASES } from "../../fixtures/legal-notice-cases";
import corpusJson from "../../fixtures/ingest-corpus.json";
import { expectLinear, rep } from "../../_helpers/linear-time";
import type { Gen } from "../../_helpers/linear-time";

// ---------------------------------------------------------------------------
// ingest-hygiene: BİK (Basın İlan Kurumu) court / official notices ride the
// same RSS feeds as news and were ending up in clusters and the /ekonomi
// ticker feed. They are recognisable by an ALL-CAPS title that ends in an
// institution name (or carries the ablative "...MAHKEMESİNDEN"), or by an
// /ilan/ path. Real all-caps news mentioning a court mid-headline must pass.
// ---------------------------------------------------------------------------

describe("isLegalNotice: rejected", () => {
  it.each([
    "T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN",
    "BARTIN 2. ASLİYE HUKUK MAHKEMESİ",
    "VAN BÜYÜKŞEHİR BELEDİYESİ EMLAK VE İSTİMLAK DAİRE BAŞKANLIĞI",
    "BAKIRKÖY BANKA ALACAKLARI İCRA DAİRESİ",
    "BAKIRKÖY GAYRİMENKUL SATIŞ İCRA DAİRESİ",
    "İLAN",
  ])("rejects %s", (title) => {
    expect(isLegalNotice(title)).toBe(true);
  });

  it("rejects an ablative form in the middle of an all-caps title", () => {
    expect(
      isLegalNotice("ANKARA 5. İCRA DAİRESİNDEN SATIŞ İLANI TEBLİGAT"),
    ).toBe(true);
  });

  it("rejects 'T.C. ... MAHKEMESİ' prefixed all-caps titles", () => {
    expect(isLegalNotice("T.C. İSTANBUL 3. TÜKETİCİ MAHKEMESİ DOSYA 2026/14")).toBe(
      true,
    );
  });

  it("rejects 'İLAN' followed by a separator", () => {
    expect(isLegalNotice("İLAN: ARAÇ SATIŞ İHALESİ")).toBe(true);
    expect(isLegalNotice("İLAN - ARAÇ SATIŞ İHALESİ")).toBe(true);
  });

  it("rejects any title when the url path is an /ilan/ section", () => {
    expect(isLegalNotice("Normal başlık", "https://www.cnnturk.com/ilan/abc")).toBe(
      true,
    );
    expect(
      isLegalNotice("Normal başlık", "https://example.com/resmi-ilanlar/2026/1"),
    ).toBe(true);
    expect(isLegalNotice("Normal başlık", "https://example.com/ilan")).toBe(true);
  });

  it("still rejects the decomposed (NFD) form of İ", () => {
    // "İ" typed as I + U+0307 combining dot above.
    const nfd = "BARTIN 2. ASLİYE HUKUK MAHKEMESİ";
    expect(nfd).not.toBe(nfd.normalize("NFC"));
    expect(isLegalNotice(nfd)).toBe(true);
  });

  it("accepts the dotless-I ASCII spelling (feeds that strip Turkish letters)", () => {
    expect(isLegalNotice("BARTIN 2. ASLIYE HUKUK MAHKEMESI")).toBe(true);
  });
});

describe("isLegalNotice: accepted (real news passes)", () => {
  it.each([
    "SON DAKİKA: MERKEZ BANKASI FAİZİ SABİT TUTTU",
    "ANAYASA MAHKEMESİ CHP'NİN BAŞVURUSUNU REDDETTİ",
    "İSRAİL SAVAŞ İLAN ETTİ",
    "Bartın 2. Asliye Hukuk Mahkemesi",
    "Anayasa Mahkemesi kararını açıkladı",
  ])("passes %s", (title) => {
    expect(isLegalNotice(title)).toBe(false);
  });

  it("passes a url whose path merely contains 'ilan' as a substring", () => {
    expect(isLegalNotice("Başlık", "/haber/bilanco-aciklandi")).toBe(false);
    expect(
      isLegalNotice("Başlık", "https://example.com/haber/bilanco-aciklandi"),
    ).toBe(false);
  });

  it("passes a bare institution word in the middle of an all-caps headline", () => {
    expect(isLegalNotice("MAHKEMESİ KARARI SONRASI BORSA YÜKSELDİ")).toBe(false);
    expect(isLegalNotice("BORSA İLAN EDİLEN KARARLA YÜKSELDİ")).toBe(false);
  });

  it("passes a short non-matching all-caps title", () => {
    expect(isLegalNotice("GOL")).toBe(false);
  });

  it("passes null / undefined / unparseable urls without throwing", () => {
    expect(isLegalNotice("Normal başlık", null)).toBe(false);
    expect(isLegalNotice("Normal başlık", undefined)).toBe(false);
    expect(isLegalNotice("Normal başlık", "not a url")).toBe(false);
    expect(isLegalNotice("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared truth table (tests/fixtures/legal-notice-cases.ts). The SQL predicate
// public.is_legal_notice() (migration 107) is checked against the same rows by
// tests/migrations/107-legal-notice-articles.test.ts.
// ---------------------------------------------------------------------------

describe("isLegalNotice: shared fixture table", () => {
  it.each(LEGAL_NOTICE_CASES)(
    "title=$title url=$url -> $expected",
    ({ title, url, expected }) => {
      expect(isLegalNotice(title, url)).toBe(expected);
    },
  );

  it("the fixture table has both outcomes and no duplicate (title, url) pair", () => {
    const keys = LEGAL_NOTICE_CASES.map((c) => JSON.stringify([c.title, c.url ?? null]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(LEGAL_NOTICE_CASES.some((c) => c.expected)).toBe(true);
    expect(LEGAL_NOTICE_CASES.some((c) => !c.expected)).toBe(true);
  });
});

describe("legal-notice exported rule constants (mirrored by SQL migration 107)", () => {
  it("exposes the five patterns and the two gates", () => {
    expect(Object.keys(LEGAL_NOTICE_PATTERNS).sort()).toEqual([
      "CONTAINS_ABLATIVE",
      "ENDS_WITH_INSTITUTION",
      "ILAN_PATH",
      "STARTS_WITH_ILAN",
      "TC_COURT",
    ]);
    expect(LEGAL_NOTICE_MIN_LETTERS).toBe(8);
    expect(LEGAL_NOTICE_MIN_UPPER_RATIO).toBe(0.85);
  });

  it("keeps STARTS_WITH_ILAN free of regex escapes so its source is valid in a Postgres ARE", () => {
    expect(LEGAL_NOTICE_PATTERNS.STARTS_WITH_ILAN.source).toBe("^[İI]LAN([\\s:.–-]|$)");
    expect(LEGAL_NOTICE_PATTERNS.STARTS_WITH_ILAN.source).not.toContain("\\-");
  });
});

// ---------------------------------------------------------------------------
// A-ingest-cpu (hunt-11): isLegalNotice used to run isMostlyUppercase (one
// toLocaleLowerCase("tr") per letter) BEFORE the three anchored regexes, so
// every ordinary mixed-case headline paid for a per-letter scan that the
// regexes would have rejected for free. The regexes now run first. The two
// orders must agree on every input: this is the old AND order, copied inline.
// ---------------------------------------------------------------------------

const { ENDS_WITH_INSTITUTION, CONTAINS_ABLATIVE, TC_COURT, STARTS_WITH_ILAN, ILAN_PATH } =
  LEGAL_NOTICE_PATTERNS;

function mostlyUppercaseOld(s: string, minLetters: number): boolean {
  const letters = s.match(/\p{L}/gu);
  if (!letters || letters.length < minLetters) return false;
  let upper = 0;
  for (const ch of letters) {
    if (ch !== ch.toLocaleLowerCase("tr")) upper++;
  }
  return upper / letters.length >= LEGAL_NOTICE_MIN_UPPER_RATIO;
}

function isLegalNoticeUppercaseFirst(title: string, url?: string | null): boolean {
  if (typeof title === "string" && title) {
    const t = title.normalize("NFC").trim();
    if (
      mostlyUppercaseOld(t, LEGAL_NOTICE_MIN_LETTERS) &&
      (ENDS_WITH_INSTITUTION.test(t) || CONTAINS_ABLATIVE.test(t) || TC_COURT.test(t))
    ) {
      return true;
    }
    if (STARTS_WITH_ILAN.test(t) && mostlyUppercaseOld(t, 3)) return true;
  }
  if (url) {
    try {
      if (ILAN_PATH.test(new URL(url).pathname)) return true;
    } catch {
      // Unparseable / relative URL: no signal from B.
    }
  }
  return false;
}

describe("isLegalNotice: regex-first ordering is equivalent to the old uppercase-first AND [A-ingest-cpu]", () => {
  const corpus = corpusJson as unknown as {
    rows: Array<{ item: { title?: string; link?: string } }>;
  };

  it("agrees on every shared-fixture case", () => {
    for (const c of LEGAL_NOTICE_CASES) {
      expect(isLegalNotice(c.title, c.url)).toBe(isLegalNoticeUppercaseFirst(c.title, c.url));
      expect(isLegalNotice(c.title, c.url)).toBe(c.expected);
    }
  });

  it("agrees on every corpus title and url, alone and together", () => {
    expect(corpus.rows.length).toBeGreaterThanOrEqual(200);
    const mismatches: string[] = [];
    for (const [i, { item }] of corpus.rows.entries()) {
      const title = item.title ?? "";
      const link = item.link ?? "";
      for (const [t, u] of [
        [title, null],
        [title, link],
        ["", link],
        [title.toUpperCase(), null],
        [title.toLocaleUpperCase("tr"), link],
        [`${title.toLocaleUpperCase("tr")} MAHKEMESİ`, null],
        [`T.C. ${title.toLocaleUpperCase("tr")} MAHKEMESİNDEN`, null],
        [`İLAN ${title.toLocaleUpperCase("tr")}`, null],
      ] as Array<[string, string | null]>) {
        if (isLegalNotice(t, u) !== isLegalNoticeUppercaseFirst(t, u)) mismatches.push(`#${i} ${JSON.stringify([t, u])}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("agrees on non-string and nullish titles", () => {
    for (const t of [undefined, null, 0, {}] as unknown as string[]) {
      expect(isLegalNotice(t, "https://example.com/ilan/x")).toBe(
        isLegalNoticeUppercaseFirst(t, "https://example.com/ilan/x"),
      );
      expect(isLegalNotice(t)).toBe(isLegalNoticeUppercaseFirst(t));
    }
  });

  it("still gates an institution suffix on the uppercase ratio", () => {
    // Regex hits, ratio fails: mixed case must pass. Ratio holds, regex
    // misses: plain all-caps news must pass.
    expect(isLegalNotice("Bartın 2. Asliye Hukuk Mahkemesi")).toBe(false);
    expect(isLegalNotice("BORSA GÜNÜ YÜKSELİŞLE KAPATTI")).toBe(false);
    expect(isLegalNotice("BARTIN 2. ASLİYE HUKUK MAHKEMESİ")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// h168-notices-1: court and tender notices (resmi ilan) that the title rules
// miss. Yeniçağ prints a court or tax-office notice under a MIXED-case title
// ("T.C. Kırıkhan 2. Asliye Ceza Mahkemesi") and marks it only in the
// description ("İlan-<title>"); Yeni Mesaj and Milat print a municipality's EKAP
// tender under an all-caps title that names no court ("ÜMRANİYE BELEDİYE
// BAŞKANLIĞI") and say what it is only in the description ("... 4734 sayılı
// Kamu İhale Kanununun 19 uncu maddesine göre ..."). isLegalNotice gains an
// optional third argument, the description, with two anchored rules:
//   D1  the description starts "İlan" + a dash (a dash is required: "İlan
//       sitesine" is a real CNN Türk story);
//   D2  the title is mostly upper case AND the description carries a tender
//       marker (4734 sayılı Kamu İhale Kanunu, İhale Kayıt Numarası) or starts
//       with the capitals "İLAN ".
// A bare "Kamu İhale Kanunu" test is NOT safe: real news (Kızılay ihalesiz alım,
// Emniyet kumanya, Gaziantep ihalesi) carries it under a mixed-case title.
// ---------------------------------------------------------------------------

const YENICAG_URL = "https://www.yenicaggazetesi.com/tc-kirikhan-2-asliye-ceza-mahkemesi-1090289h.htm";
const YENIMESAJ_URL = "https://www.yenimesaj.com.tr/umraniye-belediye-baskanligi-H1621484.htm";
const MILAT_URL = "https://www.milatgazetesi.com/sisli-belediye-baskanligi";
const DIRILIS_URL = "https://www.dirilispostasi.com/botas-silivri-isletme-mudurlugu";
const CNN_URL =
  "https://www.cnnturk.com/turkiye/ilan-sitesine-111-tl-yazip-alicidan-6-bin-tl-isteyen-saticiya-sorusturma";

interface NoticeCase {
  label: string;
  title: string;
  url: string;
  description: string;
}

const NOTICE_CASES: readonly NoticeCase[] = [
  {
    label: "Yeniçağ court notice",
    title: "T.C. Kırıkhan 2. Asliye Ceza Mahkemesi",
    url: YENICAG_URL,
    description: "İlan-T.C. Kırıkhan 2. Asliye Ceza Mahkemesi",
  },
  {
    label: "Yeniçağ tax-office notice",
    title: "Ankara Defterdarlığı (Cumhuriyet Vergi Dairesi Müdürlüğü)",
    url: YENICAG_URL,
    description: "İlan-Ankara Defterdarlığı (Cumhuriyet Vergi Dairesi Müdürlüğü)",
  },
  {
    label: "Yeniçağ company notice",
    title: "Hamidiye Kaynak Suları San. Tur Ve Tic. A.Ş.",
    url: YENICAG_URL,
    description: "İlan-Hamidiye Kaynak Suları San. Tur Ve Tic. A.Ş.",
  },
  {
    label: "Yeni Mesaj municipality tender (İLAN header)",
    title: "ÜMRANİYE BELEDİYE BAŞKANLIĞI",
    url: YENIMESAJ_URL,
    description:
      "İLAN BİNA İNŞAATI YAPTIRILACAKTIR ... 4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre açık ihale usulü ile ihale edilecektir.",
  },
  {
    label: "Milat municipality tender (4734 marker only)",
    title: "ŞİŞLİ BELEDİYE BAŞKANLIĞI",
    url: MILAT_URL,
    description:
      "JENERATÖR MONTAJ DAHİL ALIMI İŞİ ... mal alımı 4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre ...",
  },
  {
    label: "Diriliş Postası BOTAŞ tender",
    title: "BOTAŞ SİLİVRİ İŞLETME MÜDÜRLÜĞÜ",
    url: DIRILIS_URL,
    description: "TRİETİLEN GLİKOL TEMİNİ ... 4734 sayılı Kamu İhale Kanunu ... ihale edilecektir.",
  },
];

interface NewsCase {
  label: string;
  title: string;
  url: string;
  description: string;
}

// Real stories (2-week production scan) that mention the tender law or start with
// the word "İlan". None may be dropped.
const NEWS_CASES: readonly NewsCase[] = [
  {
    label: "CNN Türk 'İlan sitesine' story",
    title: "İlan sitesine 111 TL yazıp alıcıdan 6 bin TL isteyen satıcıya soruşturma",
    url: CNN_URL,
    description: "İlan sitesine 111 TL yazıp alıcıdan 6 bin TL isteyen satıcı hakkında soruşturma başlatıldı.",
  },
  {
    label: "Kızılay ihalesiz alım",
    title: "Meclis’te kabul edildi, Kızılay’a ihalesiz alım yolu açıldı",
    url: "https://www.example-news.test/gundem/kizilay-ihalesiz-alim",
    description: "Teklifle Kızılay’ın alımları 4734 sayılı Kamu İhale Kanunu kapsamı dışına çıkarılıyor.",
  },
  {
    label: "Emniyet kumanya",
    title: "İstanbul Emniyet Müdürlüğünden nezarethanelerde verilen kumanyalara ilişkin açıklama",
    url: "https://www.example-news.test/gundem/emniyet-kumanya",
    description: "Kumanya alımı 4734 sayılı Kamu İhale Kanunu hükümlerine göre yapıldı, denildi.",
  },
  {
    label: "Gaziantep otobüs ihalesi",
    title: "Gaziantep Büyükşehir’den otobüs İhalesi: 19,9 milyonluk ihale ...",
    url: "https://www.example-news.test/ekonomi/gaziantep-otobus-ihalesi",
    description: "Gaziantep Büyükşehir Belediyesi, 4734 sayılı Kamu İhale Kanunu uyarınca otobüs alımı için ihaleye çıktı.",
  },
];

describe("isLegalNotice(title, url, description): notices the title rules miss [h168-notices-1]", () => {
  it.each(NOTICE_CASES)("flags $label with its description, and the title+url rules alone still miss it", (c) => {
    expect(isLegalNotice(c.title, c.url)).toBe(false);
    expect(isLegalNotice(c.title, c.url, c.description)).toBe(true);
  });

  it.each(NEWS_CASES)("passes $label, with and without its description", (c) => {
    expect(isLegalNotice(c.title, c.url)).toBe(false);
    expect(isLegalNotice(c.title, c.url, c.description)).toBe(false);
  });

  it("a missing, null, empty or non-string description changes nothing", () => {
    for (const c of NOTICE_CASES) {
      for (const d of [undefined, null, "", "   ", 7, {}, []] as unknown as Array<string | null | undefined>) {
        expect(isLegalNotice(c.title, c.url, d), `${c.label} / ${JSON.stringify(d)}`).toBe(false);
      }
    }
    expect(isLegalNotice("T.C. SAMSUN 2. SULH HUKUK MAHKEMESİNDEN", undefined, null)).toBe(true);
  });

  it("every shared-fixture row keeps its verdict under a missing or an ordinary description", () => {
    for (const c of LEGAL_NOTICE_CASES) {
      for (const d of [undefined, null, "", "Bir haberin ilk cümlesi."]) {
        expect(isLegalNotice(c.title, c.url, d), `${JSON.stringify(c)} / ${JSON.stringify(d)}`).toBe(c.expected);
      }
    }
  });

  it("a description can only ADD notices: no 2-argument notice is ever cleared by one", () => {
    const descriptions = [
      "",
      "Bir haberin ilk cümlesi.",
      "İlan sitesine 111 TL ...",
      "4734 sayılı Kamu İhale Kanunu",
      "İlan-x",
    ];
    for (const c of LEGAL_NOTICE_CASES) {
      if (!c.expected) continue;
      for (const d of descriptions) expect(isLegalNotice(c.title, c.url, d)).toBe(true);
    }
  });
});

describe("isLegalNotice description rule D1: the description starts 'İlan' and a dash [h168-notices-1]", () => {
  const TITLE = "Bir mahkemenin ilan başlığı";

  it.each([
    ["İlan-x", "İlan-T.C. Kırıkhan 2. Asliye Ceza Mahkemesi"],
    ["a space before the dash", "İlan -T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
    ["spaces around an en dash", "İlan – T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
    ["an en dash", "İlan–T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
    ["the ASCII spelling Ilan-", "Ilan-T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
    ["leading whitespace", "  \t\nİlan-T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
    ["a decomposed İ (I + U+0307)", "I\u0307lan-T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
  ])("flags %s", (_label, description) => {
    expect(isLegalNotice(TITLE, null, description)).toBe(true);
  });

  it.each([
    ["'İlan sitesine' (a space, no dash)", "İlan sitesine 111 TL yazıp ..."],
    ["a bare İlan", "İlan"],
    ["İlan and a colon", "İlan: araç satışı"],
    ["a lower-case ilan-", "ilan-T.C. Ankara 3. Asliye Hukuk Mahkemesi"],
    ["the dash not directly after the word", "İlan sitesinde - 111 TL"],
    ["İlan in the middle", "Satıcı İlan-x sitesine yazdı"],
    ["a hyphen in a later word", "Bilanço-x açıklandı"],
    ["a digit between the word and the dash", "İlan2-x"],
  ])("passes %s", (_label, description) => {
    expect(isLegalNotice(TITLE, null, description)).toBe(false);
  });

  it("needs no title condition: a mixed-case title with a notice marker is judged on the description alone", () => {
    expect(isLegalNotice("Ankara Defterdarlığı", null, "İlan-Ankara Defterdarlığı")).toBe(true);
    expect(isLegalNotice("", null, "İlan-Ankara Defterdarlığı")).toBe(true);
  });
});

describe("isLegalNotice description rule D2: an upper-case title and a tender marker [h168-notices-1]", () => {
  const CAPS = "ÜMRANİYE BELEDİYE BAŞKANLIĞI";
  const MIXED = "Ümraniye Belediye Başkanlığı";

  it.each([
    ["the 4734 sentence", "Bina yapımı. 4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre ihale edilecektir."],
    ["the 4734 sentence at the very start", "4734 sayılı Kamu İhale Kanunu"],
    ["the registry number phrase", "İhale Kayıt Numarası: 2026/123456"],
    ["a capitals İLAN header", "İLAN BİNA İNŞAATI YAPTIRILACAKTIR"],
    ["a capitals ILAN header (ASCII)", "ILAN BINA INSAATI YAPTIRILACAKTIR"],
    ["a capitals İLAN header after whitespace", "  İLAN\nBİNA İNŞAATI"],
    ["a decomposed İ in the marker", "I\u0307hale Kayıt Numarası: 2026/1"],
  ])("flags an all-caps title with %s", (_label, description) => {
    expect(isLegalNotice(CAPS, null, description)).toBe(true);
  });

  it("does not flag the same descriptions under a mixed-case title (real news carries them)", () => {
    expect(isLegalNotice(MIXED, null, "4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre")).toBe(false);
    expect(isLegalNotice(MIXED, null, "İhale Kayıt Numarası: 2026/123456")).toBe(false);
    expect(isLegalNotice(MIXED, null, "İLAN BİNA İNŞAATI YAPTIRILACAKTIR")).toBe(false);
  });

  it.each([
    ["no marker at all", "Belediye başkanı yeni projeleri anlattı."],
    ["a lower-case ilan header", "ilan bina inşaatı yaptırılacaktır"],
    ["İLAN with no separator (a different word)", "İLANEN satış yapılacaktır"],
    ["İLAN as the whole description", "İLAN"],
    ["İLAN in the middle", "SATIŞ İLAN METNİ"],
    ["the law named without the number", "Kamu İhale Kanununa göre ihale edilecektir"],
    ["a different law number", "2886 sayılı Devlet İhale Kanununun 45 inci maddesine göre"],
    ["the marker in lower case", "4734 sayılı kamu ihale kanunu"],
    ["the registry phrase in lower case", "ihale kayıt numarası: 2026/1"],
    ["the registry phrase with a different word", "İhale Kayıt Numaraları: 2026/1"],
  ])("passes an all-caps title with %s", (_label, description) => {
    expect(isLegalNotice(CAPS, null, description)).toBe(false);
  });

  it("applies the 8-letter floor and the 0.85 upper-case ratio to the title", () => {
    const law = "4734 sayılı Kamu İhale Kanunu";
    // 5 and 7 letters: below LEGAL_NOTICE_MIN_LETTERS.
    expect(isLegalNotice("BOTAŞ", null, law)).toBe(false);
    expect(isLegalNotice("BOTAŞ GÜ", null, law)).toBe(false);
    // 8 letters exactly: allowed.
    expect(isLegalNotice("BOTAŞ GÜZ", null, law)).toBe(true);
    // 17 upper + 3 lower = 0.85 exactly: passes the gate; 16 + 3 = 0.842 fails.
    expect(isLegalNotice("ABCDEFGH abc MAHKEMESİ", null, law)).toBe(true);
    expect(isLegalNotice("ABCDEFG abc MAHKEMESİ", null, law)).toBe(false);
    expect(isLegalNotice("Ümraniye BELEDİYE BAŞKANLIĞI", null, law)).toBe(false);
  });

  it("reads the title like the other rules: NFC first, surrounding spaces ignored", () => {
    const law = "4734 sayılı Kamu İhale Kanunu";
    expect(isLegalNotice("  ÜMRANİYE BELEDİYE BAŞKANLIĞI  ", null, law)).toBe(true);
    expect(isLegalNotice("ÜMRANI\u0307YE BELEDI\u0307YE BAŞKANLIĞI", null, law)).toBe(true);
  });

  it("never throws on a non-string title or description", () => {
    for (const t of [undefined, null, 0, {}] as unknown as string[]) {
      expect(isLegalNotice(t, null, "4734 sayılı Kamu İhale Kanunu")).toBe(false);
      expect(isLegalNotice(t, "https://example.com/ilan/x", {} as unknown as string)).toBe(true);
    }
  });
});

describe("legal-notice description rule constants (mirrored by SQL migration 210) [h168-notices-1]", () => {
  const P = LEGAL_NOTICE_DESCRIPTION_PATTERNS;

  it("exposes the four description patterns as their exact sources", () => {
    expect(Object.keys(P).sort()).toEqual([
      "DESCRIPTION_ILAN_DASH",
      "DESCRIPTION_STARTS_WITH_ILAN",
      "DESCRIPTION_TENDER_LAW",
      "DESCRIPTION_TENDER_REGISTRY",
    ]);
    expect(P.DESCRIPTION_ILAN_DASH.source).toBe("^\\s*[İI]lan\\s*[-–]");
    expect(P.DESCRIPTION_STARTS_WITH_ILAN.source).toBe("^\\s*[İI]LAN\\s");
    expect(P.DESCRIPTION_TENDER_LAW.source).toBe("4734 sayılı Kamu İhale Kanunu");
    expect(P.DESCRIPTION_TENDER_REGISTRY.source).toBe("İhale Kayıt Numarası");
  });

  it("the description patterns stay out of LEGAL_NOTICE_PATTERNS (migration 107 embeds exactly those five)", () => {
    expect(Object.keys(LEGAL_NOTICE_PATTERNS)).toHaveLength(5);
    for (const name of Object.keys(P)) expect(LEGAL_NOTICE_PATTERNS).not.toHaveProperty(name);
  });

  it("every source is a valid Postgres ARE unchanged: no lookbehind, lookahead, named group, \\- escape, \\p class or quote", () => {
    for (const [name, re] of Object.entries(P)) {
      const src = re.source;
      expect(src, name).not.toContain("(?");
      expect(src, name).not.toContain("\\-");
      expect(src, name).not.toContain("\\p{");
      expect(src, name).not.toContain("\\P{");
      expect(src, name).not.toContain("'");
      expect(re.flags, name).toBe("u");
    }
  });

  it("every pattern is case-sensitive and carries no flag that SQL cannot reproduce", () => {
    for (const re of Object.values(P)) {
      expect(re.ignoreCase).toBe(false);
      expect(re.multiline).toBe(false);
      expect(re.global).toBe(false);
      expect(re.sticky).toBe(false);
    }
  });
});

describe("isLegalNotice description rules run in linear time [h168-notices-1]", () => {
  const CAPS = "ÜMRANİYE BELEDİYE BAŞKANLIĞI";
  const run = (description: string) => isLegalNotice(CAPS, null, description);

  it.each([
    ["only whitespace", rep(" ", "", "x")],
    ["whitespace then a near-miss word", rep(" ", "", "İlan")],
    ["a near-miss of the law sentence, repeated", rep("4734 sayılı Kamu İhale Kanun ")],
    ["a near-miss of the registry phrase, repeated", rep("İhale Kayıt Numara ")],
    ["the word İlan and a space, repeated", rep("İlan ")],
    ["İLAN and a space, repeated", rep("İLAN ", "x")],
    ["dashes", rep("-", "İlan")],
    ["one non-BMP character repeated", rep("\u{1F600}")],
  ])("%s", (_label, gen) => {
    expectLinear(gen, run, { n: 200_000, ceilingMs: 1_000 });
  });
});

// h169 review (sec-ingest-nfc-quadratic-dos): feed text is attacker-controlled, and String.prototype.normalize is super-linear on
// combining marks that need reordering ('a' + U+0301 x n/2 + U+0316 x n/2: 1.5 ms at 2,000 units, 36 ms at 10,000, 152 ms at
// 20,000; benign text of the same length takes about 0.01 ms). isNoticeByDescription used to normalise the whole description
// completeItem hands it (up to DESCRIPTION_SCAN_CAP = 20,000 units) where HEAD never normalised it at all, so about 14 hostile
// items in a cycle could exhaust the isolate's cumulative 2 s while ISOLATE_ITEM_BUDGET booked each as a handful of items. The
// description is cut to NOTICE_DESCRIPTION_SCAN_CAP units (4x the 500 cleaned characters the SQL twin, migration 210, judges)
// BEFORE the normalisation; these cases run on 200,000 units and fail on the whole-string normalisation.
describe("isLegalNotice reads a bounded prefix of the description [h169 review: sec-ingest-nfc-quadratic-dos]", () => {
  const URL = "https://example.test/haber/1";
  const MARKER = "4734 sayılı Kamu İhale Kanunu";
  const CAPS = "ÜMRANİYE BELEDİYE BAŞKANLIĞI";

  it("the cap is 2,000 units: the title's own bound, four times what the SQL twin judges", () => {
    expect(NOTICE_DESCRIPTION_SCAN_CAP).toBe(2_000);
  });

  // Combining marks of two classes that need reordering: 230-class above, 220-class below.
  const HOSTILE: Array<[string, Gen]> = [
    ["alternating U+0316 and U+0301 marks", rep("\u0316\u0301", "a")],
    ["alternating U+0301 and U+0316 marks", rep("\u0301\u0316", "a")],
    ["a run of 230-class marks, then 220-class marks", (n) => `a${"\u0301".repeat(n >> 1)}${"\u0316".repeat(n - (n >> 1))}`],
  ];

  describe.each([
    ["an all-caps title", CAPS],
    ["a mixed-case title", "Mixed case title"],
  ])("%s", (_label, title) => {
    it.each(HOSTILE)("%s: linear in the description", (_gen, gen) => {
      expectLinear(gen, (d) => isLegalNotice(title, URL, d), { n: 200_000, ceilingMs: 1_000 });
    });
  });

  it("the verdict is read from the first NOTICE_DESCRIPTION_SCAN_CAP units: a marker inside counts, one past it does not", () => {
    const cap = NOTICE_DESCRIPTION_SCAN_CAP;
    const pad = (units: number) => "a ".repeat(Math.ceil(units / 2)).slice(0, units);
    // The tender sentence ends exactly at the cap.
    expect(isLegalNotice(CAPS, URL, `${pad(cap - MARKER.length)}${MARKER}`)).toBe(true);
    // It starts exactly at the cap, or one unit before the cap (cut in half): not read.
    expect(isLegalNotice(CAPS, URL, `${pad(cap)}${MARKER}`)).toBe(false);
    expect(isLegalNotice(CAPS, URL, `${pad(cap - MARKER.length + 1)}${MARKER}`)).toBe(false);
    // 'a '.repeat(N) and a marker just past the cap, as a feed would carry it.
    expect(isLegalNotice(CAPS, URL, `${"a ".repeat(cap / 2 + 1)}${MARKER}`)).toBe(false);
    // The anchored rules read the start: whitespace never pushes 'İlan-' out of reach of the cap's front, but past it nothing is read.
    expect(isLegalNotice("Mixed case title", URL, `${" ".repeat(cap - 10)}İlan-x`)).toBe(true);
    expect(isLegalNotice("Mixed case title", URL, `${" ".repeat(cap + 10)}İlan-x`)).toBe(false);
  });

  it("a decomposed 'İ' (I + U+0307) inside the bound is still composed before the rules run", () => {
    expect(isLegalNotice(CAPS, URL, "I\u0307LAN BİNA İNŞAATI ... 4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre")).toBe(true);
    expect(isLegalNotice("Mixed case title", URL, "I\u0307lan-T.C. Kırıkhan 2. Asliye Ceza Mahkemesi")).toBe(true);
  });

  it("a cut that would leave half of a surrogate pair at the end changes no verdict", () => {
    const cap = NOTICE_DESCRIPTION_SCAN_CAP;
    const emoji = "\u{1F600}";
    expect(isLegalNotice(CAPS, URL, `${"x".repeat(cap - 1)}${emoji}${MARKER}`)).toBe(false);
    expect(isLegalNotice(CAPS, URL, `${MARKER} ${emoji.repeat(cap)}`)).toBe(true);
  });
});

// The rule order inside isLegalNotice is a cost choice only (cheap regexes
// before the per-letter uppercase scan). This reference runs the uppercase
// scan FIRST and must agree on every title x description pair.
describe("isLegalNotice with a description: rule order does not change the verdict [h168-notices-1]", () => {
  const { DESCRIPTION_ILAN_DASH, DESCRIPTION_STARTS_WITH_ILAN, DESCRIPTION_TENDER_LAW, DESCRIPTION_TENDER_REGISTRY } =
    LEGAL_NOTICE_DESCRIPTION_PATTERNS;

  function reference(title: string, url: string | null, description: string | null): boolean {
    if (isLegalNoticeUppercaseFirst(title, url)) return true;
    if (typeof description !== "string" || description === "") return false;
    const d = description.normalize("NFC");
    if (DESCRIPTION_ILAN_DASH.test(d)) return true;
    const t = typeof title === "string" ? title.normalize("NFC").trim() : "";
    return (
      t !== "" &&
      mostlyUppercaseOld(t, LEGAL_NOTICE_MIN_LETTERS) &&
      (DESCRIPTION_TENDER_LAW.test(d) || DESCRIPTION_TENDER_REGISTRY.test(d) || DESCRIPTION_STARTS_WITH_ILAN.test(d))
    );
  }

  const corpus = corpusJson as unknown as {
    rows: Array<{ item: { title?: string; link?: string; contentSnippet?: string } }>;
  };

  it("agrees on every notice and news case", () => {
    for (const c of [...NOTICE_CASES, ...NEWS_CASES]) {
      expect(isLegalNotice(c.title, c.url, c.description)).toBe(reference(c.title, c.url, c.description));
    }
  });

  it("agrees on every corpus title, in every case form, against marker descriptions", () => {
    const descriptions = [
      null,
      "",
      "İlan-x",
      "İLAN BİNA İNŞAATI",
      "Bir haberin ilk cümlesi.",
      "4734 sayılı Kamu İhale Kanununun 19 uncu maddesine göre",
      "İhale Kayıt Numarası: 1",
    ];
    const mismatches: string[] = [];
    for (const [i, { item }] of corpus.rows.entries()) {
      const title = item.title ?? "";
      const link = item.link ?? "";
      for (const t of [title, title.toLocaleUpperCase("tr"), `${title.toLocaleUpperCase("tr")} BELEDİYE BAŞKANLIĞI`]) {
        for (const d of descriptions) {
          if (isLegalNotice(t, link, d) !== reference(t, link, d)) mismatches.push(`#${i} ${JSON.stringify([t, d])}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});
