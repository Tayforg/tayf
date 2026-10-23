import { describe, it, expect } from "vitest";

import {
  ARTICLE_KEY_EXCLUDED_SLUGS,
  KEY_DATE_PREFIX_RE,
  KEY_FILE_EXT_RE,
  KEY_MAX_DIGITS,
  KEY_MIN_DIGITS,
  KEY_ROUND_RE,
  URL_PATH_RE,
  sourceArticleKey,
  sourceArticleKeyFor,
} from "../../../supabase/functions/_shared/rss/article-key";
import { SOURCE_ARTICLE_KEY_CASES } from "../../fixtures/source-article-key-cases";

// The source article key (twin-articles): the numeric id an outlet's CMS puts
// in an article URL. A headline edit changes the slug but keeps the id, so
// two URLs of one source with the same key are the same article. The truth
// table lives in tests/fixtures/source-article-key-cases.ts and is shared
// with the SQL twin's live test (tests/migrations/113-source-article-key.test.ts).

describe("sourceArticleKey: fixture table", () => {
  it.each(SOURCE_ARTICLE_KEY_CASES.map((c) => [c.url, c.key, c.note] as const))(
    "%s -> %s (%s)",
    (url, key) => {
      expect(sourceArticleKey(url)).toBe(key);
    },
  );

  it("covers the incident pair, null, and every digit-length bound", () => {
    const keys = new Set(SOURCE_ARTICLE_KEY_CASES.map((c) => c.key));
    expect(keys.has("1708664")).toBe(true);
    expect(keys.has(null)).toBe(true);
    expect(SOURCE_ARTICLE_KEY_CASES.length).toBeGreaterThanOrEqual(40);
  });
});

describe("sourceArticleKey: behaviour", () => {
  it("gives a headline edit (new slug, same id) the same key", () => {
    const before = "https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu/haber-1708664";
    const after =
      "https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu-husilerle-catismaya-girilmeyecek/haber-1708664";
    expect(before).not.toBe(after);
    expect(sourceArticleKey(before)).toBe(sourceArticleKey(after));
    expect(sourceArticleKey(before)).toBe("1708664");
  });

  it("gives different ids different keys", () => {
    const a = sourceArticleKey("https://www.aksam.com.tr/spor/x/haber-1708701");
    const b = sourceArticleKey("https://www.aksam.com.tr/spor/x/haber-1708700");
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
  });

  it("collides only for the intended twin pairs among the real sample URLs", () => {
    const real = SOURCE_ARTICLE_KEY_CASES.filter(
      (c) => c.key !== null && /aksam\.com|aa\.com\.tr|cnnturk|yenisafak|dunya\.com/.test(c.url),
    );
    const byKey = new Map<string, number>();
    for (const c of real) byKey.set(c.key as string, (byKey.get(c.key as string) ?? 0) + 1);
    const collisions = [...byKey.entries()].filter(([, n]) => n > 1).map(([k]) => k).sort();
    // The aksam incident pair and the dunya headline-edit pair, nothing else.
    expect(collisions).toEqual(["1708664", "845066"]);
  });

  it("never throws, whatever it is given", () => {
    const weird: unknown[] = [
      null,
      undefined,
      "",
      " ",
      "\u0000",
      "https://",
      "https:///",
      "https://x.test/%E0%A4%A",
      "https://x.test/" + "9".repeat(10_000),
      "https://x.test/" + "a1".repeat(10_000),
      "ünicode://başlık/ğüşiöç-1234567",
      "🙂",
      "https://x.test/\n1234567\n",
      42,
      {},
      [],
      Symbol.iterator,
    ];
    for (const w of weird) {
      expect(() => sourceArticleKey(w as string)).not.toThrow();
    }
  });

  it("returns null for null, undefined and non-strings", () => {
    expect(sourceArticleKey(null)).toBeNull();
    expect(sourceArticleKey(undefined)).toBeNull();
    expect(sourceArticleKey(1234567 as unknown as string)).toBeNull();
  });

  it("is a pure function of the url (no regex state leaks between calls)", () => {
    const url = "https://x.test/a/slug-1234567";
    for (let i = 0; i < 5; i++) expect(sourceArticleKey(url)).toBe("1234567");
  });

  it("handles a very long run of slashes without blowing up (linear time)", () => {
    const started = Date.now();
    expect(sourceArticleKey("https://x.test/slug-1234567" + "/".repeat(200_000) + "x")).toBeNull();
    expect(sourceArticleKey("https://x.test/slug-1234567" + "/".repeat(200_000))).toBe("1234567");
    expect(sourceArticleKey("https://x.test/" + "a./".repeat(100_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("handles a very long digit run without blowing up (linear time)", () => {
    const started = Date.now();
    expect(sourceArticleKey("https://x.test/" + "9".repeat(100_000))).toBeNull();
    expect(Date.now() - started).toBeLessThan(500);
  });
});

describe("article-key constants", () => {
  it("exports the documented regexes and bounds", () => {
    expect(URL_PATH_RE.source).toBe("^[A-Za-z][A-Za-z0-9+.-]*:\\/\\/[^/?#]*([^?#]*)");
    expect(KEY_FILE_EXT_RE.source).toBe("\\.(s?html?|php|aspx?)$");
    expect(KEY_FILE_EXT_RE.flags).toBe("i");
    expect(KEY_DATE_PREFIX_RE.source).toBe(
      "^(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])",
    );
    expect(KEY_ROUND_RE.source).toBe("^[1-9][0-9]?0{4,}$");
    expect(KEY_MIN_DIGITS).toBe(6);
    expect(KEY_MAX_DIGITS).toBe(20);
  });

  it("none of the regexes carries the g or y flag (no lastIndex state)", () => {
    for (const re of [URL_PATH_RE, KEY_FILE_EXT_RE, KEY_DATE_PREFIX_RE, KEY_ROUND_RE]) {
      expect(re.flags).not.toMatch(/[gy]/);
    }
  });
});

describe("round numbers are quantities, not ids", () => {
  // A headline number ("100,000 customers") lands in an English slug as a
  // round run: one or two significant digits and at least four zeros. Keying
  // on it merges unrelated stories of one outlet (30-day replay, 2026-10-23:
  // a-news 100000 x3, 250000 x2, 300000 x2; daily-sabah 500000 x2).
  it.each([
    "100000",
    "110000",
    "250000",
    "300000",
    "960000",
    "1000000",
    "1100000",
    "12000000",
    "50000000000000000000",
  ])("KEY_ROUND_RE matches %s", (run) => {
    expect(KEY_ROUND_RE.test(run)).toBe(true);
  });

  it.each(["100001", "123000", "421000", "874000", "1708664", "845066", "740001", "1790776947", "120100"])(
    "KEY_ROUND_RE does not match %s",
    (run) => {
      expect(KEY_ROUND_RE.test(run)).toBe(false);
    },
  );

  it("gives a round run no key, wherever it sits in the slug", () => {
    expect(sourceArticleKey("https://x.test/world/over-100000-customers-without-power")).toBeNull();
    expect(sourceArticleKey("https://x.test/world/protesters-250000")).toBeNull();
    expect(sourceArticleKey("https://x.test/a/slug-1000000")).toBeNull();
  });

  it("skips a round run like a date-shaped one: the last non-round, non-date run still wins", () => {
    expect(sourceArticleKey("https://x.test/a/slug-1234567-100000")).toBe("1234567");
    expect(sourceArticleKey("https://x.test/a/100000-slug-1234567")).toBe("1234567");
    expect(sourceArticleKey("https://x.test/a/slug-100000-20261023")).toBeNull();
  });

  it("keeps a run that merely ends in zeros", () => {
    expect(sourceArticleKey("https://x.test/a/slug-123000")).toBe("123000");
    expect(sourceArticleKey("https://x.test/a/slug-100001")).toBe("100001");
  });

  it("does not merge the three false a-news groups seen in production (30-day replay)", () => {
    const groups: string[][] = [
      [
        "https://www.anews.com.tr/world/2026/09/26/noreaster-leaves-over-100000-customers-without-power-in-us-northeast-over-400-flights-canceled",
        "https://www.anews.com.tr/asia/2026/10/01/chinas-tencent-leases-100000-chips-from-us-oracle-amid-escalating-ai-race-report",
        "https://www.anews.com.tr/world/2026/10/11/dengue-deaths-surpass-300-in-bangladesh-as-infections-near-100000",
      ],
      [
        "https://www.anews.com.tr/world/2026/10/06/more-than-250000-protesters-at-school-marches-across-france",
        "https://www.anews.com.tr/world/2026/10/20/more-than-250000-displaced-in-yemen-since-august-as-fighting-escalates-unhcr",
      ],
      [
        "https://www.anews.com.tr/economy/2026/10/09/trump-russia-to-immediately-supply-300000-tons-of-diesel-fuel",
        "https://www.anews.com.tr/americas/2026/10/21/us-says-over-300000-visas-revoked-under-trump",
      ],
    ];
    for (const group of groups) for (const url of group) expect(sourceArticleKey(url), url).toBeNull();
  });
});

describe("ARTICLE_KEY_EXCLUDED_SLUGS / sourceArticleKeyFor", () => {
  it("excludes daily-sabah and a-news, whose slugs carry numbers but (almost) no ids", () => {
    expect(ARTICLE_KEY_EXCLUDED_SLUGS).toContain("daily-sabah");
    expect(ARTICLE_KEY_EXCLUDED_SLUGS).toContain("a-news");
  });

  it("is a list of unique, lower-case, non-empty slugs", () => {
    expect(new Set(ARTICLE_KEY_EXCLUDED_SLUGS).size).toBe(ARTICLE_KEY_EXCLUDED_SLUGS.length);
    for (const slug of ARTICLE_KEY_EXCLUDED_SLUGS) {
      expect(slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it("returns null for an excluded slug even when the url has a key", () => {
    // Not round, so the round-number guard cannot be what returns null.
    const sabah = "https://www.dailysabah.com/business/economy/german-industry-lost-nearly-421000-jobs-since-2019-ifo";
    expect(sourceArticleKey(sabah)).toBe("421000");
    expect(sourceArticleKeyFor("daily-sabah", sabah)).toBeNull();

    const anews = "https://www.anews.com.tr/world/2026/10/21/macron-arrives-in-saudi-arabia-on-gulf-tour-elysee-1792588576";
    expect(sourceArticleKey(anews)).toBe("1792588576");
    expect(sourceArticleKeyFor("a-news", anews)).toBeNull();

    const slugNumber = "https://www.anews.com.tr/world/2026/10/20/germanys-afd-investigates-alleged-theft-of-421000-internal-emails";
    expect(sourceArticleKey(slugNumber)).toBe("421000");
    expect(sourceArticleKeyFor("a-news", slugNumber)).toBeNull();
  });

  it("returns the plain key for every other slug", () => {
    expect(sourceArticleKeyFor("aksam", "https://www.aksam.com.tr/a/b/haber-1708664")).toBe("1708664");
    expect(sourceArticleKeyFor("aksam", "https://www.aksam.com.tr/a/b/haber")).toBeNull();
    expect(sourceArticleKeyFor("", "https://x.test/a-1234567")).toBe("1234567");
  });
});
