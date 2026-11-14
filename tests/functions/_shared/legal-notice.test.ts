import { describe, expect, it } from "vitest";

import {
  LEGAL_NOTICE_DESCRIPTION_PATTERNS,
  LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS,
  LEGAL_NOTICE_MIN_LETTERS,
  LEGAL_NOTICE_MIN_UPPER_RATIO,
  LEGAL_NOTICE_PATTERNS,
  LEGAL_NOTICE_TITLE_V2_PATTERNS,
  MIXED_COURT_NOTICE,
  MIXED_COURT_NOTICE_MAX_TITLE,
  NOTICE_DESCRIPTION_SCAN_CAP,
  isLegalNotice,
} from "../../../supabase/functions/_shared/rss/legal-notice.ts";
import { LEGAL_NOTICE_CASES } from "../../fixtures/legal-notice-cases";
import {
  LEGAL_NOTICE_V2_CASES,
  MIXED_COURT_CASES,
  NEWS_V2_CASES,
  OFFICE_CASES,
  OFFICE_EDGE_CASES,
} from "../../fixtures/legal-notice-v2-cases";
import corpusJson from "../../fixtures/ingest-corpus.json";
import { expectCpuUnder, expectLinear, rep } from "../../_helpers/linear-time";
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

// ---------------------------------------------------------------------------
// h181-sourcepages-1: tax-office, enforcement-office and mixed-case court notices. Three families passed every earlier rule and
// showed (debtors' and defendants' names, tax numbers, addresses) under 'Son haberler' on indexable source pages:
//   * an all-caps title that ends in a tax or enforcement office's own name ("KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ",
//     "SİLİVRİ İCRA VE İFLAS MÜDÜRLÜĞÜ"): ENDS_WITH_OFFICE under the uppercase gate;
//   * the same notices' descriptions ("... İLANEN TEBLİĞ", "... GAZETE VEYA İNTERNET HABER SİTESİ İLANI") under an all-caps title;
//   * İşçi Haber's sentence-case rewrite of a BİK court notice ("Kocaeli 3. sulh hukuk Mahkemesi'nden ilanen tebliğ"): the
//     TS-only MIXED_COURT_NOTICE rule (a court-level word, 'mahkemesi', a title that ends in ilan / ilanı / ilanen tebliğ /
//     ilanen tebligat). It has no SQL twin on purpose: case folding of İ and ı is not reliable in a POSIX ARE.
// The rows are production rows of 2026-11-14 (tests/fixtures/legal-notice-v2-cases.ts), the private text cut away.
// ---------------------------------------------------------------------------

describe("isLegalNotice: tax-office and enforcement-office notices [h181-sourcepages-1]", () => {
  it.each(OFFICE_CASES)("flags $label, by its title alone and with its description", (c) => {
    expect(isLegalNotice(c.title, null)).toBe(true);
    expect(isLegalNotice(c.title, c.url, c.description)).toBe(true);
  });

  it.each(OFFICE_EDGE_CASES)("office-title edge: $label -> $expected", (c) => {
    expect(isLegalNotice(c.title, c.url, c.description)).toBe(c.expected);
  });

  it("the earlier rules alone missed every one of the six (the new rules are what catch them)", () => {
    const { ENDS_WITH_INSTITUTION, CONTAINS_ABLATIVE, TC_COURT, STARTS_WITH_ILAN } = LEGAL_NOTICE_PATTERNS;
    for (const c of OFFICE_CASES) {
      const t = c.title.normalize("NFC").trim();
      expect(ENDS_WITH_INSTITUTION.test(t) || CONTAINS_ABLATIVE.test(t) || TC_COURT.test(t) || STARTS_WITH_ILAN.test(t), c.label).toBe(false);
    }
  });
});

describe("isLegalNotice: mixed-case court notices (MIXED_COURT_NOTICE, TS only) [h181-sourcepages-1]", () => {
  it.each(MIXED_COURT_CASES)("flags $label, by its title alone and with its description", (c) => {
    expect(isLegalNotice(c.title, null)).toBe(true);
    expect(isLegalNotice(c.title, c.url, c.description)).toBe(true);
  });

  it("the earlier rules alone missed every one of the seven", () => {
    const { ENDS_WITH_INSTITUTION, CONTAINS_ABLATIVE, TC_COURT, STARTS_WITH_ILAN } = LEGAL_NOTICE_PATTERNS;
    for (const c of MIXED_COURT_CASES) {
      const t = c.title.normalize("NFC").trim();
      expect(ENDS_WITH_INSTITUTION.test(t) || CONTAINS_ABLATIVE.test(t) || TC_COURT.test(t) || STARTS_WITH_ILAN.test(t), c.label).toBe(false);
    }
  });

  it.each([
    ["an ASCII apostrophe before -nden", "Batman 6. asliye hukuk Mahkemesi'nden ilan"],
    ["a typographic apostrophe before -nden", "Batman 6. asliye hukuk Mahkemesi’nden ilan"],
    ["no -nden at all", "Ankara 22. Aile Mahkemesi ilanı"],
    ["the ablative without an apostrophe", "Ankara 3. aile mahkemesinden ilan"],
    ["a trailing exclamation mark and a space", "Batman 6. asliye hukuk Mahkemesi'nden ilan! "],
    ["a trailing dot", "Kocaeli 3. sulh hukuk mahkemesinden ilanen tebliğ."],
    ["ağır ceza", "Bursa 2. ağır ceza mahkemesinden ilan"],
    ["çocuk", "Ankara 4. çocuk mahkemesinden ilanen tebligat"],
    ["bölge", "Ankara bölge idare mahkemesinden ilan"],
    ["icra hukuk", "İstanbul 3. icra hukuk mahkemesinden satış ilanı"],
    ["idare", "Ankara 5. idare mahkemesinden ilan"],
    ["vergi", "İzmir 2. vergi mahkemesi'nden ilan"],
    ["ticaret", "İstanbul 9. asliye ticaret mahkemesinden ilan"],
    ["kadastro", "Muğla kadastro mahkemesinden ilan"],
    ["tüketici", "Bursa 3. tüketici mahkemesinden ilan"],
    ["'fikri' with a longer gap before 'mahkemesi'", "Ankara 2. fikri ve sınai haklar hukuk mahkemesinden ilan"],
    ["capitals (the lower-casing is Turkish: İ -> i)", "ANKARA 3. AİLE MAHKEMESİ'NDEN İLAN"],
    ["capitals, ilanen tebliğ", "KOCAELİ 3. SULH HUKUK MAHKEMESİ'NDEN İLANEN TEBLİĞ"],
    ["a decomposed İ in the title (NFC first)", "Ankara 3. aile mahkemesinden İlan"],
    ["leading and trailing whitespace", "   Ankara 3. aile mahkemesinden ilan   "],
    ["the court word first in the title", "Asliye hukuk mahkemesinden ilan"],
  ])("flags %s", (_label, title) => {
    expect(isLegalNotice(title)).toBe(true);
  });

  it.each([
    ["Anayasa Mahkemesi is not a court level of the list", "Anayasa Mahkemesi'nden önemli ilan"],
    ["'ceza' alone is not a court level (only 'ağır ceza')", "Uluslararası ceza mahkemesinden ilan"],
    ["no 'mahkemesi' at all", "Ankara 3. aile hakimliğinden ilan"],
    ["the title does not END in the notice word", "Ankara 3. aile mahkemesi ilan edildi"],
    ["'ilan' is the middle word", "Ankara 3. aile mahkemesinden ilan metni"],
    ["'ilan' only as the tail of a longer word", "Ankara 3. aile mahkemesinden bilan"],
    ["'ilanı' as the tail of a longer word", "Ankara 3. aile mahkemesinden kabilanı"],
    ["'iş' only inside a longer word", "Yeniş mahkemesinden ilan"],
    ["a longer word that merely starts with a court-level word", "Ankara idareci mahkemesinden ilan"],
    ["'icra' as the start of 'icraat'", "Hükümetin icraat mahkemesinden ilan"],
    ["a court word after 'mahkemesi'", "Mahkemesi asliye ilan"],
    ["a plain headline with a court and a decision", "Ankara 3. aile mahkemesi boşanma kararı verdi"],
    ["the notice wording without a court", "Ankara 3. kat malikleri ilanen tebliğ"],
    ["a title in sentence form that ends in 'ilan etti'", "Mahkeme heyeti, aile mahkemesinin kararını ilan etti"],
    // The notice word must follow "mahkemesi" directly (review h182): a court word and an "ilan" tail somewhere else do not make a notice.
    ["a ruling, then 'kararın gazetede ilanı' (the tail is not tied to the court)", "Tüketici Mahkemesi'nden Apple'a ceza: kararın gazetede ilanı"],
    ["a court ruling and a rector notice", "Bölge Adliye Mahkemesi'nden Boğaziçi kararı sonrası rektör ilanı"],
    ["a recruitment notice with a dative after 'mahkemesi'", "Aile Mahkemesi'ne yeni hakim alım ilanı"],
    ["a staff recruitment notice", "Bölge Adliye Mahkemesi personel alım ilanı"],
    ["a job advertisement with a locative after 'mahkemesi'", "Çocuk Mahkemesi'nde görev yapacak uzman için iş ilanı"],
    ["a genitive after 'mahkemesi' and a company's bankruptcy notice", "Ticaret Mahkemesi'nin kararının ardından Boyner'den iflas ilanı"],
    ["the verb 'ilan' at the end of a sentence about a court", "İstanbul Ticaret Mahkemesi, şirketin iflasını ilan"],
  ])("passes %s", (_label, title) => {
    expect(isLegalNotice(title)).toBe(false);
  });

  it("the notice word may follow -nden by at most 24 characters (the tail is anchored at 'mahkemesi' and bounded)", () => {
    const tail = (n: number) => `Ankara 3. aile mahkemesinden ${"x".repeat(n)} ilan`;
    // The text between "nden" and the notice word is " " + x * n + " ": the gap quantifier counts " " + x * n = n + 1 characters.
    expect(isLegalNotice(tail(23))).toBe(true);
    expect(isLegalNotice(tail(24))).toBe(false);
  });

  it("the court word and 'mahkemesi' are at most 40 characters apart (the gap is bounded)", () => {
    const gap = (n: number) => `asliye${" ".repeat(1)}${"x".repeat(n - 2)} mahkemesinden ilan`;
    // The text between "asliye" and "mahkemesi" is " " + x * (n - 2) + " " = n characters.
    expect(isLegalNotice(gap(40))).toBe(true);
    expect(isLegalNotice(gap(41))).toBe(false);
  });

  it("a title longer than MIXED_COURT_NOTICE_MAX_TITLE is not judged by this rule (bounded input)", () => {
    expect(MIXED_COURT_NOTICE_MAX_TITLE).toBe(300);
    const base = "Ankara 3. aile mahkemesinden ilan";
    const padded = (len: number) => `${"x".repeat(len - base.length - 1)} ${base}`;
    expect(padded(300)).toHaveLength(300);
    expect(isLegalNotice(padded(300))).toBe(true);
    expect(isLegalNotice(padded(301))).toBe(false);
    // The length is the trimmed one: surrounding spaces do not count against the cap.
    expect(isLegalNotice(`  ${padded(300)}  `)).toBe(true);
  });

  it("needs neither the uppercase gate nor a description, and a description cannot clear it", () => {
    expect(isLegalNotice("ankara 3. aile mahkemesinden ilan")).toBe(true);
    for (const d of [undefined, null, "", "Bir haberin ilk cümlesi.", "4734 sayılı Kamu İhale Kanunu"]) {
      expect(isLegalNotice("Ankara 3. aile mahkemesinden ilan", null, d)).toBe(true);
    }
  });

  it("never throws on a non-string title", () => {
    for (const t of [undefined, null, 0, {}, []] as unknown as string[]) expect(isLegalNotice(t)).toBe(false);
  });
});

describe("isLegalNotice: real stories and near-misses stay [h181-sourcepages-1]", () => {
  it.each(NEWS_V2_CASES)("passes $label, with and without its description", (c) => {
    expect(isLegalNotice(c.title, c.url)).toBe(false);
    expect(isLegalNotice(c.title, c.url, c.description)).toBe(false);
    expect(isLegalNotice(c.title, null, null)).toBe(false);
  });

  it("every shared-table row has the verdict its table says, in every argument form", () => {
    for (const c of LEGAL_NOTICE_V2_CASES) {
      expect(isLegalNotice(c.title, c.url, c.description), c.label).toBe(c.expected);
    }
  });

  it("the table has both outcomes, the SQL twin differs only on the TS-only mixed-case rows, and no (title, url, description) repeats", () => {
    const keys = LEGAL_NOTICE_V2_CASES.map((c) => JSON.stringify([c.title, c.url, c.description]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(LEGAL_NOTICE_V2_CASES.some((c) => c.expected)).toBe(true);
    expect(LEGAL_NOTICE_V2_CASES.some((c) => !c.expected)).toBe(true);
    const differing = LEGAL_NOTICE_V2_CASES.filter((c) => c.expected !== c.sqlExpected).map((c) => c.title);
    expect(differing).toEqual(MIXED_COURT_CASES.map((c) => c.title));
  });

  it("a known residue stays visible: a court sale title with no 'ilan' and no office name", () => {
    const residue = NEWS_V2_CASES.find((c) => c.title.startsWith("Kandıra sulh hukuk"));
    expect(residue).toBeDefined();
    expect(isLegalNotice(residue!.title, residue!.url, residue!.description)).toBe(false);
  });

  it("every earlier shared-fixture row keeps its verdict (the new rules only ADD)", () => {
    for (const c of LEGAL_NOTICE_CASES) {
      expect(isLegalNotice(c.title, c.url), JSON.stringify(c)).toBe(c.expected);
    }
  });
});

describe("isLegalNotice description rule E2: 'İLANEN TEBLİĞ' and 'GAZETE VEYA İNTERNET HABER SİTESİ İLANI' [h181-sourcepages-1]", () => {
  // An all-caps title that no earlier rule and not ENDS_WITH_OFFICE recognises: only the description can flag it.
  const CAPS = "KOZYATAĞI VERGİ DAİRESİ TEBLİGATLARI";
  const MIXED = "Kozyatağı Vergi Dairesi tebligatları";
  const TEBLIG = "İSTANBUL DEFTERDARLIĞI’NDAN İLANEN TEBLİĞVergi NoSoyad Ad/Unvan";
  const GAZETE = "TAŞINIRIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI";

  it("the title alone is no notice", () => {
    expect(isLegalNotice(CAPS, null)).toBe(false);
    expect(isLegalNotice(CAPS, null, null)).toBe(false);
    expect(isLegalNotice(CAPS, null, "")).toBe(false);
  });

  it.each([
    ["the ilanen tebliğ header glued to the next word", TEBLIG],
    ["the ilanen tebliğ header on its own", "İLANEN TEBLİĞ"],
    ["the ilanen tebliğ header in the middle", "Bir şey. İSTANBUL DEFTERDARLIĞINDAN İLANEN TEBLİĞ SIRA NO VKN"],
    ["the newspaper-or-website sale notice", GAZETE],
    ["the sale notice in the middle of a tab-separated row", "Örnek No:55*\tT.C.SİLİVRİİCRA DAİRESİ\t2025/623 TLMT.\tTAŞINMAZIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI\tBir borçtan dolayı"],
    ["a decomposed İ in ilanen tebliğ", "İLANEN TEBLİĞ"],
    ["a decomposed İ in the sale notice", "TAŞINIRIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI"],
  ])("flags an all-caps title with %s", (_label, description) => {
    expect(isLegalNotice(CAPS, null, description)).toBe(true);
  });

  it("does not flag the same descriptions under a mixed-case title (the uppercase gate)", () => {
    expect(isLegalNotice(MIXED, null, TEBLIG)).toBe(false);
    expect(isLegalNotice(MIXED, null, GAZETE)).toBe(false);
  });

  it.each([
    ["lower case ilanen tebliğ", "ilanen tebliğ edildi"],
    ["title case İlanen Tebliğ", "İlanen Tebliğ"],
    ["İLANEN alone", "İLANEN satış yapılacaktır"],
    ["TEBLİĞ alone", "TEBLİĞ"],
    ["İLAN TEBLİĞ in the middle (a different phrase; a leading İLAN is the older D2 marker)", "Bir İLAN TEBLİĞ EDİLİR"],
    ["the sale notice in lower case", "gazete veya internet haber sitesi ilanı"],
    ["the sale notice with a different last word", "GAZETE VEYA İNTERNET HABER SİTESİ DUYURUSU"],
    ["a different medium", "GAZETE VEYA TELEVİZYON İLANI"],
  ])("passes an all-caps title with %s", (_label, description) => {
    expect(isLegalNotice(CAPS, null, description)).toBe(false);
  });

  it("applies the 8-letter floor and the 0.85 ratio to the title", () => {
    expect(isLegalNotice("BOTAŞ", null, TEBLIG)).toBe(false);
    expect(isLegalNotice("BOTAŞ GÜ", null, TEBLIG)).toBe(false);
    expect(isLegalNotice("BOTAŞ GÜZ", null, TEBLIG)).toBe(true);
    expect(isLegalNotice("ABCDEFGH abc MAHKEMESİ", null, GAZETE)).toBe(true);
    expect(isLegalNotice("ABCDEFG abc MAHKEMESİ", null, GAZETE)).toBe(false);
  });

  it("reads a marker inside NOTICE_DESCRIPTION_SCAN_CAP units and none past it", () => {
    const cap = NOTICE_DESCRIPTION_SCAN_CAP;
    const pad = (units: number) => "a ".repeat(Math.ceil(units / 2)).slice(0, units);
    for (const marker of ["İLANEN TEBLİĞ", "GAZETE VEYA İNTERNET HABER SİTESİ İLANI"]) {
      expect(isLegalNotice(CAPS, null, `${pad(cap - marker.length)}${marker}`), marker).toBe(true);
      expect(isLegalNotice(CAPS, null, `${pad(cap)}${marker}`), marker).toBe(false);
    }
  });

  it("a description can only ADD notices: no earlier notice is ever cleared by one", () => {
    for (const c of LEGAL_NOTICE_CASES) {
      if (!c.expected) continue;
      for (const d of [TEBLIG, GAZETE, "", "Bir haberin ilk cümlesi."]) expect(isLegalNotice(c.title, c.url, d)).toBe(true);
    }
    for (const c of [...OFFICE_CASES, ...MIXED_COURT_CASES]) {
      for (const d of [TEBLIG, GAZETE, "", "Bir haberin ilk cümlesi.", null, undefined]) expect(isLegalNotice(c.title, c.url, d)).toBe(true);
    }
  });

  it("never throws on a non-string title or description", () => {
    for (const t of [undefined, null, 0, {}] as unknown as string[]) {
      expect(isLegalNotice(t, null, TEBLIG)).toBe(false);
      expect(isLegalNotice(t, "https://example.com/ilan/x", {} as unknown as string)).toBe(true);
    }
    for (const d of [7, {}, []] as unknown as string[]) expect(isLegalNotice(CAPS, null, d)).toBe(false);
  });
});

describe("h181 rule constants (mirrored by SQL migration 213, except MIXED_COURT_NOTICE) [h181-sourcepages-1]", () => {
  const T = LEGAL_NOTICE_TITLE_V2_PATTERNS;
  const D = LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS;

  it("exposes ENDS_WITH_OFFICE and the two description literals as their exact sources", () => {
    expect(Object.keys(T)).toEqual(["ENDS_WITH_OFFICE"]);
    expect(T.ENDS_WITH_OFFICE.source).toBe(
      "((V[Eİ]RG[İI]|[İI]CRA) DA[İI]RES[İI]|[İI]CRA VE [İI]FLAS) M[ÜU]D[ÜU]RL[ÜU][ĞG][ÜU][\\s.:;,!-]*$",
    );
    expect(Object.values(D).map((re) => re.source).sort()).toEqual(["GAZETE VEYA İNTERNET HABER SİTESİ İLANI", "İLANEN TEBLİĞ"]);
    expect(Object.keys(D)).toHaveLength(2);
  });

  it("the new objects stay out of the two earlier ones (migrations 107 and 210 embed exactly their own)", () => {
    expect(Object.keys(LEGAL_NOTICE_PATTERNS)).toHaveLength(5);
    expect(Object.keys(LEGAL_NOTICE_DESCRIPTION_PATTERNS)).toHaveLength(4);
    for (const name of [...Object.keys(T), ...Object.keys(D)]) {
      expect(LEGAL_NOTICE_PATTERNS).not.toHaveProperty(name);
      expect(LEGAL_NOTICE_DESCRIPTION_PATTERNS).not.toHaveProperty(name);
    }
    for (const name of Object.keys(MIXED_COURT_NOTICE)) {
      expect(LEGAL_NOTICE_PATTERNS).not.toHaveProperty(name);
      expect(LEGAL_NOTICE_DESCRIPTION_PATTERNS).not.toHaveProperty(name);
    }
  });

  it("the earlier patterns are exactly what migrations 107 and 210 embed (nothing edited them)", () => {
    expect(Object.fromEntries(Object.entries(LEGAL_NOTICE_PATTERNS).map(([k, re]) => [k, re.source]))).toEqual({
      ENDS_WITH_INSTITUTION: "(MAHKEMES[İI]|[İI]CRA DA[İI]RES[İI]|DA[İI]RE BAŞKANLI[ĞG]I)(NDEN|NDAN)?[\\s.:;,!-]*$",
      CONTAINS_ABLATIVE: "(MAHKEMES[İI]NDEN|[İI]CRA DA[İI]RES[İI]NDEN|DA[İI]RE BAŞKANLI[ĞG]INDAN)",
      TC_COURT: "^T\\.\\s?C\\.\\s.*MAHKEMES[İI]",
      STARTS_WITH_ILAN: "^[İI]LAN([\\s:.–-]|$)",
      ILAN_PATH: "(^|\\/)(ilan|ilanlar|resmi-ilan|resmi-ilanlar)(\\/|$)",
    });
    expect(Object.fromEntries(Object.entries(LEGAL_NOTICE_DESCRIPTION_PATTERNS).map(([k, re]) => [k, re.source]))).toEqual({
      DESCRIPTION_ILAN_DASH: "^\\s*[İI]lan\\s*[-–]",
      DESCRIPTION_TENDER_LAW: "4734 sayılı Kamu İhale Kanunu",
      DESCRIPTION_TENDER_REGISTRY: "İhale Kayıt Numarası",
      DESCRIPTION_STARTS_WITH_ILAN: "^\\s*[İI]LAN\\s",
    });
  });

  it("every SQL-mirrored source is a valid Postgres ARE unchanged: no lookaround, no \\- escape, no \\p class, no quote", () => {
    for (const [name, re] of [...Object.entries(T), ...Object.entries(D)]) {
      const src = re.source;
      expect(src, name).not.toContain("(?");
      expect(src, name).not.toContain("\\-");
      expect(src, name).not.toContain("\\p{");
      expect(src, name).not.toContain("\\P{");
      expect(src, name).not.toContain("'");
      expect(re.flags, name).toBe("u");
      expect(re.ignoreCase, name).toBe(false);
      expect(re.multiline, name).toBe(false);
      expect(re.global, name).toBe(false);
      expect(re.sticky, name).toBe(false);
    }
  });

  it("MIXED_COURT_NOTICE is TS only: its sources use \\p{L} (not a Postgres ARE) and use bounded quantifiers only", () => {
    const sources = Object.values(MIXED_COURT_NOTICE).map((re) => re.source);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.some((s) => s.includes("\\p{L}"))).toBe(true);
    for (const s of sources) {
      // An unbounded quantifier is a star or a plus; the bounded ones are {m,n}.
      expect(s.includes("*"), s).toBe(false);
      expect(s.includes("+"), s).toBe(false);
    }
  });
});

describe("h181 rules run in linear time [h181-sourcepages-1]", () => {
  const OPTS = { n: 100_000, ceilingMs: 2_000 };
  const CAPS = "KOZYATAĞI VERGİ DAİRESİ TEBLİGATLARI";

  describe("ENDS_WITH_OFFICE on a hostile title", () => {
    it.each([
      ["near-misses of the tail, repeated, ending in x", rep("VERGİ DAİRESİ MÜDÜRLÜĞÜ ", "", "x")],
      ["a whitespace run after a complete tail, then x", rep(" ", "VERGİ DAİRESİ MÜDÜRLÜĞÜ", "x")],
      ["a punctuation run after a complete tail, then x", rep(".-;", "İCRA DAİRESİ MÜDÜRLÜĞÜ", "x")],
      ["the tail repeated and ending in the tail (it matches: the uppercase gate counts every letter)", rep("VERGİ DAİRESİ MÜDÜRLÜĞÜ ", "", "VERGİ DAİRESİ MÜDÜRLÜĞÜ")],
      ["the bankruptcy-office near-miss, repeated", rep("İCRA VE İFLAS MÜDÜRLÜĞ ")],
      ["the bankruptcy-office tail, repeated", rep("İCRA VE İFLAS MÜDÜRLÜĞÜ ", "", "İCRA VE İFLAS MÜDÜRLÜĞÜ")],
      ["one non-BMP character repeated", rep("\u{1F600}")],
    ])("%s", (_label, gen) => {
      expectLinear(gen, (t) => isLegalNotice(t), OPTS);
    });
  });

  describe("E2 on a hostile description", () => {
    it.each([
      ["a near-miss of ilanen tebliğ, repeated", rep("İLANEN TEBLİ ")],
      ["ilanen tebliğ in lower case, repeated", rep("ilanen tebliğ ")],
      ["a near-miss of the sale notice, repeated", rep("GAZETE VEYA İNTERNET HABER SİTESİ İLAN ")],
      ["the sale notice's first words, repeated", rep("GAZETE VEYA İNTERNET ")],
      ["whitespace", rep(" ", "", "x")],
      ["one non-BMP character repeated", rep("\u{1F600}")],
    ])("%s", (_label, gen) => {
      expectLinear(gen, (d) => isLegalNotice(CAPS, null, d), OPTS);
    });
  });

  describe("MIXED_COURT_NOTICE on a hostile title", () => {
    it.each([
      ["court words and a near-miss tail, repeated (a title over the cap is not judged)", rep("asliye hukuk mahkemesi ilan ", "", "x")],
      ["'mahkemesi' repeated, ending in ilan", rep("mahkemesi ", "", "ilan")],
      ["'asliye' repeated with long gaps, ending in ilan", rep(`asliye ${"x".repeat(45)} `, "", "ilan")],
      ["spaces, ending in ilan", rep(" ", "asliye mahkemesi", "ilan")],
      ["one non-BMP character repeated", rep("\u{1F600}")],
    ])("%s", (_label, gen) => {
      expectLinear(gen, (t) => isLegalNotice(t), OPTS);
    });

    it.each([
      ["court words with gaps just past the bound, then a notice tail", `${`asliye ${"x".repeat(45)} `.repeat(5)}ilan`],
      ["'mahkemesi' and court words alternating, no tail", "asliye mahkemesi ".repeat(17)],
      ["court words with gaps just inside the bound, tail missing by one letter", `${`icra ${"x".repeat(35)} mahkemesi `.repeat(6)}ila`],
    ])("a 300-character worst case for the bounded regexes is cheap: %s", (_label, title) => {
      expect(title.length).toBeLessThanOrEqual(MIXED_COURT_NOTICE_MAX_TITLE + 20);
      expectCpuUnder(() => isLegalNotice(title.slice(0, MIXED_COURT_NOTICE_MAX_TITLE)), 50);
    });
  });
});

describe("isLegalNotice with the h181 rules: rule order does not change the verdict [h181-sourcepages-1]", () => {
  // Reference: the three new rules written out without the cheap prechecks, uppercase scan first, over the earlier
  // rules' own verdict (isLegalNotice minus the new rules is not callable, so the earlier verdict comes from the
  // exported earlier patterns, as in the A-ingest-cpu reference above).
  const { ENDS_WITH_OFFICE } = LEGAL_NOTICE_TITLE_V2_PATTERNS;
  const [D_TEBLIG, D_GAZETE] = Object.values(LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS);
  const upper = (s: string, min: number) => mostlyUppercaseOld(s, min);

  function reference(title: string, url: string | null, description: string | null): boolean {
    if (isLegalNoticeUppercaseFirst(title, url)) return true;
    const t = typeof title === "string" ? title.normalize("NFC").trim() : "";
    if (t !== "" && upper(t, LEGAL_NOTICE_MIN_LETTERS) && ENDS_WITH_OFFICE.test(t)) return true;
    if (t !== "" && t.length <= MIXED_COURT_NOTICE_MAX_TITLE) {
      const l = t.toLocaleLowerCase("tr");
      const court = /(^|[^\p{L}])(asliye|sulh|ağır ceza|icra|iş|aile|tüketici|idare|vergi|ticaret|kadastro|fikri|infaz|çocuk|bölge)(?![\p{L}])[\s\S]{0,40}?mahkemesi/u;
      const tail = /^(['’]?nden[\s\S]{0,24}?)?[^\p{L}](ilan|ilanı|ilanen tebliğ|ilanen tebligat)[\s.:;,!-]*$/u;
      const m = court.exec(l);
      if (m !== null && tail.test(l.slice(m.index + m[0].length))) return true;
    }
    if (typeof description !== "string" || description === "") return false;
    const d = description.slice(0, NOTICE_DESCRIPTION_SCAN_CAP).normalize("NFC");
    const { DESCRIPTION_ILAN_DASH, DESCRIPTION_STARTS_WITH_ILAN, DESCRIPTION_TENDER_LAW, DESCRIPTION_TENDER_REGISTRY } =
      LEGAL_NOTICE_DESCRIPTION_PATTERNS;
    if (DESCRIPTION_ILAN_DASH.test(d)) return true;
    return (
      t !== "" &&
      upper(t, LEGAL_NOTICE_MIN_LETTERS) &&
      (DESCRIPTION_TENDER_LAW.test(d) ||
        DESCRIPTION_TENDER_REGISTRY.test(d) ||
        DESCRIPTION_STARTS_WITH_ILAN.test(d) ||
        D_TEBLIG!.test(d) ||
        D_GAZETE!.test(d))
    );
  }

  const corpus = corpusJson as unknown as { rows: Array<{ item: { title?: string; link?: string } }> };

  it("agrees on every table row", () => {
    for (const c of LEGAL_NOTICE_V2_CASES) {
      expect(isLegalNotice(c.title, c.url, c.description), c.label).toBe(reference(c.title, c.url, c.description));
    }
  });

  it("agrees on every corpus title in every case form against the new markers, and flags none of the plain forms", () => {
    const descriptions = [null, "", "Bir haberin ilk cümlesi.", "İLANEN TEBLİĞ", "TAŞINIRIN GAZETE VEYA İNTERNET HABER SİTESİ İLANI"];
    const mismatches: string[] = [];
    let plainFlagged = 0;
    for (const [i, { item }] of corpus.rows.entries()) {
      const title = item.title ?? "";
      const link = item.link ?? "";
      for (const t of [title, title.toLocaleUpperCase("tr"), `${title.toLocaleUpperCase("tr")} VERGİ DAİRESİ MÜDÜRLÜĞÜ`, `${title} asliye mahkemesinden ilan`]) {
        for (const d of descriptions) {
          if (isLegalNotice(t, link, d) !== reference(t, link, d)) mismatches.push(`#${i} ${JSON.stringify([t, d])}`);
        }
      }
      // A real headline of the corpus, as published, is no notice by the new rules.
      if (isLegalNotice(title, link, null) && !isLegalNoticeUppercaseFirst(title, link)) plainFlagged++;
    }
    expect(mismatches).toEqual([]);
    expect(plainFlagged).toBe(0);
  });
});
