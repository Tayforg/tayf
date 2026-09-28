import { describe, it, expect } from "vitest";
import {
  isAllowedFactCheckUrl,
  cleanTitle,
  normalizeFeedItems,
} from "./normalize";
import { FACT_CHECK_PUBLISHERS, FACT_CHECK_FEEDS } from "./feeds";

const teyit = FACT_CHECK_PUBLISHERS.teyit;
const aa = FACT_CHECK_PUBLISHERS["aa-teyit"];

describe("isAllowedFactCheckUrl", () => {
  it("drops javascript: and http: links", () => {
    expect(isAllowedFactCheckUrl("javascript:alert(1)", teyit)).toBe(false);
    expect(isAllowedFactCheckUrl("http://teyit.org/analiz/x", teyit)).toBe(false);
  });

  it("drops off-host links", () => {
    expect(isAllowedFactCheckUrl("https://evil.example.com/x", teyit)).toBe(false);
  });

  it("keeps a valid https link on an allowed host", () => {
    expect(isAllowedFactCheckUrl("https://teyit.org/analiz/x", teyit)).toBe(true);
  });

  it("drops an unparsable url", () => {
    expect(isAllowedFactCheckUrl("not a url", teyit)).toBe(false);
  });

  it("requires /teyithatti/ in the path for AA", () => {
    expect(isAllowedFactCheckUrl("https://www.aa.com.tr/tr/gundem/x", aa)).toBe(false);
    expect(isAllowedFactCheckUrl("https://www.aa.com.tr/tr/teyithatti/x", aa)).toBe(true);
  });
});

describe("cleanTitle", () => {
  it("decodes named and numeric entities", () => {
    expect(cleanTitle("Bir ba&#351;l&#305;k &amp; test")).toBe('Bir başlık & test');
    expect(cleanTitle("&quot;alinti&quot;")).toBe('"alinti"');
    expect(cleanTitle("O&#39;Brien")).toBe("O'Brien");
    // Entity-decode runs before tag-strip (spec order), so an escaped tag
    // becomes a real one and is then stripped along with it.
    expect(cleanTitle("a &lt;b&gt; c")).toBe("a c");
  });

  it("strips tags", () => {
    expect(cleanTitle("<b>Kalın</b> başlık <i>metni</i>")).toBe("Kalın başlık metni");
  });

  it("collapses whitespace", () => {
    expect(cleanTitle("  çok    boşluklu   \n\n başlık  ")).toBe("çok boşluklu başlık");
  });

  it("caps at 300 chars on a word boundary with an ellipsis", () => {
    const long = "kelime ".repeat(80).trim();
    const cleaned = cleanTitle(long);
    expect(cleaned).not.toBeNull();
    expect(cleaned!.length).toBeLessThanOrEqual(301);
    expect(cleaned!.endsWith("…")).toBe(true);
    expect(cleaned!.includes(" …")).toBe(false);
  });

  it("returns null for an empty or non-string input", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("   ")).toBeNull();
    expect(cleanTitle(undefined)).toBeNull();
    expect(cleanTitle(null)).toBeNull();
    expect(cleanTitle(42)).toBeNull();
  });
});

describe("normalizeFeedItems", () => {
  const nowMs = Date.parse("2026-09-28T12:00:00Z");

  it("drops javascript:, off-host, and (for AA) non-teyithatti links", () => {
    const rows = normalizeFeedItems(teyit, [
      { title: "Valid", link: "https://teyit.org/analiz/valid", pubDate: "2026-09-27T10:00:00Z" },
      { title: "JS", link: "javascript:alert(1)", pubDate: "2026-09-27T10:00:00Z" },
      { title: "OffHost", link: "https://evil.example.com/x", pubDate: "2026-09-27T10:00:00Z" },
    ], nowMs);
    expect(rows.length).toBe(1);
    expect(rows[0]!.row.url).toBe("https://teyit.org/analiz/valid");
  });

  it("drops AA items whose link lacks /teyithatti/", () => {
    const rows = normalizeFeedItems(aa, [
      { title: "Genel haber", link: "https://www.aa.com.tr/tr/gundem/x" },
      { title: "Teyit haberi", link: "https://www.aa.com.tr/tr/teyithatti/x" },
    ], nowMs);
    expect(rows.length).toBe(1);
    expect(rows[0]!.row.url).toContain("/teyithatti/");
  });

  it("decodes entities and strips tags in titles", () => {
    const rows = normalizeFeedItems(teyit, [
      { title: "<b>Ba&amp;lik</b>", link: "https://teyit.org/x" },
    ], nowMs);
    expect(rows[0]!.row.title).toBe("Ba&lik");
  });

  it("caps title length at 300", () => {
    const long = "kelime ".repeat(80).trim();
    const rows = normalizeFeedItems(teyit, [
      { title: long, link: "https://teyit.org/x" },
    ], nowMs);
    expect(rows[0]!.row.title.length).toBeLessThanOrEqual(301);
  });

  it("clamps a future date to now and defaults a missing date to now", () => {
    const future = new Date(nowMs + 1000 * 60 * 60 * 24 * 30).toISOString();
    const rows = normalizeFeedItems(teyit, [
      { title: "Gelecek", link: "https://teyit.org/future", isoDate: future },
      { title: "Tarihsiz", link: "https://teyit.org/nodate" },
    ], nowMs);
    const futureRow = rows.find((r) => r.row.url === "https://teyit.org/future")!;
    const noDateRow = rows.find((r) => r.row.url === "https://teyit.org/nodate")!;
    expect(Date.parse(futureRow.row.published_at)).toBeLessThanOrEqual(nowMs);
    expect(Date.parse(noDateRow.row.published_at)).toBe(nowMs);
  });

  it("dedupes by url", () => {
    const rows = normalizeFeedItems(teyit, [
      { title: "Bir", link: "https://teyit.org/dup" },
      { title: "İki (farklı başlık)", link: "https://teyit.org/dup" },
    ], nowMs);
    expect(rows.length).toBe(1);
    expect(rows[0]!.row.title).toBe("Bir");
  });

  it("caps at 50 rows per feed", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({
      title: `Başlık ${i}`,
      link: `https://teyit.org/item-${i}`,
    }));
    const rows = normalizeFeedItems(teyit, items, nowMs);
    expect(rows.length).toBe(50);
  });

  it("each row carries exactly 4 keys (no description ever)", () => {
    const rows = normalizeFeedItems(teyit, [
      {
        title: "Test",
        link: "https://teyit.org/x",
        contentSnippet: "should never leak",
        content: "should never leak either",
      },
    ], nowMs);
    expect(Object.keys(rows[0]!.row).sort()).toEqual(
      ["publisher", "published_at", "title", "url"].sort(),
    );
  });

  it("keeps categories in the returned batch item but never inside row", () => {
    const rows = normalizeFeedItems(teyit, [
      { title: "Test", link: "https://teyit.org/x", categories: ["Sağlık", "Gündem"] },
    ], nowMs);
    expect(rows[0]!.categories).toEqual(["Sağlık", "Gündem"]);
    expect(rows[0]!.row).not.toHaveProperty("categories");
  });
});

describe("feeds.ts parity", () => {
  it("every FACT_CHECK_FEEDS entry has an https feedUrl whose host is in its own hosts list", () => {
    expect(FACT_CHECK_FEEDS.length).toBeGreaterThan(0);
    for (const p of FACT_CHECK_FEEDS) {
      expect(p.feedUrl).not.toBeNull();
      const u = new URL(p.feedUrl!);
      expect(u.protocol).toBe("https:");
      expect(p.hosts).toContain(u.host);
    }
  });
});
