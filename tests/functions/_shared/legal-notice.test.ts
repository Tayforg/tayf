import { describe, expect, it } from "vitest";

import {
  LEGAL_NOTICE_MIN_LETTERS,
  LEGAL_NOTICE_MIN_UPPER_RATIO,
  LEGAL_NOTICE_PATTERNS,
  isLegalNotice,
} from "../../../supabase/functions/_shared/rss/legal-notice.ts";
import { LEGAL_NOTICE_CASES } from "../../fixtures/legal-notice-cases";
import corpusJson from "../../fixtures/ingest-corpus.json";

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
