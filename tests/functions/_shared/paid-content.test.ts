import { describe, expect, it } from "vitest";

import {
  PAID_CONTENT_SEGMENTS,
  isPaidContentUrl,
} from "../../../supabase/functions/_shared/rss/paid-content";
import { expectLinear, rep } from "../../_helpers/linear-time";

// ---------------------------------------------------------------------------
// h148-sources-1: paid advertorials and press releases ride the same RSS feeds
// as news. Their urls carry a section segment: `/advertorial/` (Posta, CNN
// Türk, Dünya, Türkiye Gazetesi) or `/tanitim-bulteni/` (Halk TV). They were
// stored as news, showed on /ekonomi/GARAN as Garanti BBVA news and headed
// /source/halk-tv's 'Son haberler'. `isPaidContentUrl` is the url check that
// keeps them out of `articles`.
//
// It PARSES the url and compares whole path segments (first or second one):
// never a substring or a regex over the raw url.
// ---------------------------------------------------------------------------

describe("PAID_CONTENT_SEGMENTS", () => {
  it("lists the two section names, lowercase and bare", () => {
    expect([...PAID_CONTENT_SEGMENTS]).toEqual(["advertorial", "tanitim-bulteni"]);
    for (const segment of PAID_CONTENT_SEGMENTS) {
      expect(segment).toBe(segment.toLowerCase());
      expect(segment).not.toMatch(/\//);
    }
  });
});

describe("isPaidContentUrl: true", () => {
  it.each([
    "https://www.posta.com.tr/advertorial/ziraat-bankasi-10-trilyon-tl-aktif-buyuklugu-asan-ilk-banka-oldu-3063347",
    "https://www.cnnturk.com/advertorial/ziraat-bankasi-10-trilyon-tl-aktif-buyuklugu-asan-ilk-banka-oldu-3491897",
    "https://www.dunya.com/advertorial/garanti-bbva-kiraladan-iphonekiralama-ve-dijitalden-ikinci-el-arac-satisi-haberi-846144",
    "https://www.turkiyegazetesi.com.tr/advertorial/kuzey-marmara-otoyolu-1825924",
    "https://halktv.com.tr/tanitim-bulteni/otel-fiyatlarini-karsilastirmanin-pratik-bir-yolu-1061590h",
  ])("is true for the real stored url %s", (url) => {
    expect(isPaidContentUrl(url)).toBe(true);
  });

  it("is case-insensitive (the path segment, not only the lowercase section)", () => {
    expect(isPaidContentUrl("https://x.com/Advertorial/x")).toBe(true);
    expect(isPaidContentUrl("https://x.com/ADVERTORIAL/x")).toBe(true);
    expect(isPaidContentUrl("https://x.com/Tanitim-Bulteni/x")).toBe(true);
    expect(isPaidContentUrl("HTTPS://X.COM/TANITIM-BULTENI/X")).toBe(true);
  });

  it("is true when the section is the SECOND segment (a language or desk prefix)", () => {
    expect(isPaidContentUrl("https://x.com/tr/advertorial/y")).toBe(true);
    expect(isPaidContentUrl("https://x.com/ekonomi/tanitim-bulteni/y")).toBe(true);
  });

  it("is true over http as well as https, with a port, a query or a fragment after the path", () => {
    expect(isPaidContentUrl("http://x.com/advertorial/y")).toBe(true);
    expect(isPaidContentUrl("https://x.com:8443/advertorial/y")).toBe(true);
    expect(isPaidContentUrl("https://x.com/advertorial/y?utm_source=rss#top")).toBe(true);
  });

  it("ignores empty path parts (a trailing slash, a doubled slash)", () => {
    expect(isPaidContentUrl("https://x.com/advertorial/")).toBe(true);
    expect(isPaidContentUrl("https://x.com//advertorial//y")).toBe(true);
    expect(isPaidContentUrl("https://x.com/tr//tanitim-bulteni/y")).toBe(true);
  });

  it("decodes a percent-encoded segment before comparing", () => {
    expect(isPaidContentUrl("https://x.com/%61dvertorial/y")).toBe(true);
    expect(isPaidContentUrl("https://x.com/tanitim%2Dbulteni/y")).toBe(true);
  });

  it("is true when a LATER part of the path is malformed percent-encoding (the raw part is kept, nothing throws)", () => {
    expect(isPaidContentUrl("https://x.com/advertorial/%E0%A4%A")).toBe(true);
    expect(isPaidContentUrl("https://x.com/tr/advertorial/%")).toBe(true);
  });
});

describe("isPaidContentUrl: false", () => {
  it("is false for a segment that only STARTS with the section name", () => {
    expect(isPaidContentUrl("https://x.com/haber/advertorial-ajansi-kuruldu-1")).toBe(false);
    expect(isPaidContentUrl("https://x.com/advertorials/y")).toBe(false);
    expect(isPaidContentUrl("https://x.com/tanitim-bulteni-arsivi/y")).toBe(false);
    expect(isPaidContentUrl("https://x.com/non-advertorial/y")).toBe(false);
  });

  it("is false when the name is only in the query or the fragment", () => {
    expect(isPaidContentUrl("https://x.com/haber/x?ref=advertorial")).toBe(false);
    expect(isPaidContentUrl("https://x.com/haber/x?next=/advertorial/y")).toBe(false);
    expect(isPaidContentUrl("https://x.com/haber/x#tanitim-bulteni")).toBe(false);
    expect(isPaidContentUrl("https://x.com/haber/x#/advertorial/y")).toBe(false);
  });

  it("is false for the section as the THIRD segment or deeper", () => {
    expect(isPaidContentUrl("https://x.com/a/b/advertorial/x")).toBe(false);
    expect(isPaidContentUrl("https://x.com/a/b/c/tanitim-bulteni/x")).toBe(false);
  });

  it("is false when the name is a HOST label or in userinfo, not the path", () => {
    expect(isPaidContentUrl("https://advertorial.example.com/haber/x")).toBe(false);
    expect(isPaidContentUrl("https://tanitim-bulteni.example.com/haber/x")).toBe(false);
    expect(isPaidContentUrl("https://advertorial@example.com/haber/x")).toBe(false);
  });

  it("is false for a percent-encoded slash inside one segment (it is not a separator)", () => {
    expect(isPaidContentUrl("https://x.com/haber%2Fadvertorial/x")).toBe(false);
  });

  it("is false for a scheme other than http(s)", () => {
    expect(isPaidContentUrl("ftp://x.com/advertorial/y")).toBe(false);
    expect(isPaidContentUrl("javascript:advertorial/y")).toBe(false);
    expect(isPaidContentUrl("file:///advertorial/y")).toBe(false);
    expect(isPaidContentUrl("mailto:a@b.c/advertorial/y")).toBe(false);
  });

  it("is false for anything that does not parse as an absolute url", () => {
    expect(isPaidContentUrl("/advertorial/x")).toBe(false);
    expect(isPaidContentUrl("//x.com/advertorial/y")).toBe(false);
    expect(isPaidContentUrl("advertorial/x")).toBe(false);
    expect(isPaidContentUrl("not a url advertorial")).toBe(false);
    expect(isPaidContentUrl("")).toBe(false);
    expect(isPaidContentUrl("   ")).toBe(false);
  });

  it("is false for a non-string, without throwing", () => {
    expect(isPaidContentUrl(null)).toBe(false);
    expect(isPaidContentUrl(undefined)).toBe(false);
    expect(isPaidContentUrl(42)).toBe(false);
    expect(isPaidContentUrl({})).toBe(false);
    expect(isPaidContentUrl(["https://x.com/advertorial/y"])).toBe(false);
    expect(isPaidContentUrl(new URL("https://x.com/advertorial/y"))).toBe(false);
  });

  it("is false for the home page and ordinary article urls", () => {
    expect(isPaidContentUrl("https://x.com")).toBe(false);
    expect(isPaidContentUrl("https://x.com/")).toBe(false);
    expect(isPaidContentUrl("https://www.posta.com.tr/gundem/bir-haber-3063348")).toBe(false);
    expect(isPaidContentUrl("https://www.dunya.com/finans/banka/bir-haber-846145")).toBe(false);
    expect(isPaidContentUrl("https://halktv.com.tr/gundem/bir-haber-1061591h")).toBe(false);
  });
});

describe("isPaidContentUrl: bounded work", () => {
  it("answers a long path correctly, in linear time", () => {
    // The section sits at the THIRD segment of a 20,000-segment path: false.
    expect(isPaidContentUrl(`https://x.com/${"a/".repeat(20_000)}advertorial/y`)).toBe(false);
    expectLinear(rep("a/", "https://x.com/", "advertorial/y"), (s) => isPaidContentUrl(s), {
      n: 200_000,
      ceilingMs: 4000,
    });
  });

  it("handles a long run of slashes and a long malformed percent run in linear time", () => {
    expect(isPaidContentUrl(`https://x.com/${"/".repeat(50_000)}advertorial/y`)).toBe(true);
    expectLinear(rep("/", "https://x.com/", "advertorial/y"), (s) => isPaidContentUrl(s), {
      n: 200_000,
      ceilingMs: 4000,
    });
    expectLinear(rep("%", "https://x.com/advertorial/"), (s) => isPaidContentUrl(s), {
      n: 200_000,
      ceilingMs: 4000,
    });
  });
});
