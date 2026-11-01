import { describe, expect, it } from "vitest";
import { pickItemLink } from "../../../supabase/functions/_shared/rss/items.ts";
import {
  cleanFeedDate,
  isParseableFeedDate,
} from "../../../supabase/functions/_shared/rss/dates.ts";
import { parseDate } from "../../../supabase/functions/_shared/rss/normalize.ts";

const NOW_MS = Date.parse("2026-09-29T00:00:00Z");

// ---------------------------------------------------------------------------
// pickItemLink (supabase/functions/_shared/rss/items.ts)
// ---------------------------------------------------------------------------

describe("pickItemLink", () => {
  it("uses the plain <link> text when present and non-blank", () => {
    expect(pickItemLink({ link: "https://example.com/a" })).toBe(
      "https://example.com/a",
    );
  });

  it("keeps a relative link rather than falling through", () => {
    expect(pickItemLink({ link: "/haber/1" })).toBe("/haber/1");
  });

  it("falls through to atom:link when <link> is whitespace-only", () => {
    const node = {
      link: "  ",
      "atom:link": { href: "https://example.com/atom-fallback", rel: "alternate" },
    };
    expect(pickItemLink(node)).toBe("https://example.com/atom-fallback");
  });

  it("resolves Milliyet-style items: no <link>, atom:link + non-permalink guid", () => {
    const node = {
      "atom:link": { href: "https://www.milliyet.com.tr/gundem/haber-7669353" },
      guid: { "#text": "7669353", isPermaLink: "false" },
    };
    expect(pickItemLink(node)).toBe(
      "https://www.milliyet.com.tr/gundem/haber-7669353",
    );
  });

  it("prefers rel=alternate among an array of atom:link entries, never rel=self", () => {
    const node = {
      "atom:link": [
        { href: "https://example.com/self", rel: "self" },
        { href: "https://example.com/canonical", rel: "alternate" },
      ],
    };
    expect(pickItemLink(node)).toBe("https://example.com/canonical");
  });

  it("falls back to a non-self atom:link when no rel=alternate exists", () => {
    const node = {
      "atom:link": [{ href: "https://example.com/self", rel: "self" }],
    };
    expect(pickItemLink(node)).toBe("https://example.com/self");
  });

  it("uses an absolute http(s) guid as the last resort", () => {
    const node = { guid: "https://x/y" };
    expect(pickItemLink(node)).toBe("https://x/y");
  });

  it("ignores a guid explicitly marked isPermaLink=false with no other candidate", () => {
    const node = { guid: { "#text": "https://x/y", isPermaLink: "false" } };
    expect(pickItemLink(node)).toBeUndefined();
  });

  it("ignores a non-URL guid", () => {
    const node = { guid: "7669353" };
    expect(pickItemLink(node)).toBeUndefined();
  });

  it("returns undefined when nothing resolves", () => {
    expect(pickItemLink({})).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// cleanFeedDate / isParseableFeedDate (supabase/functions/_shared/rss/dates.ts)
// ---------------------------------------------------------------------------

describe("cleanFeedDate", () => {
  it("decodes a hex HTML entity in the offset sign (Sözcü)", () => {
    const cleaned = cleanFeedDate(
      "Mon, 28 Sep 2026 22:25:43 &#x2B;0300",
      "sozcu",
    );
    expect(cleaned).toBe("Mon, 28 Sep 2026 22:25:43 +0300");
    expect(parseDate(cleaned, { nowMs: NOW_MS, sourceSlug: "sozcu" })).toBe(
      "2026-09-28T19:25:43.000Z",
    );
  });

  it("decodes the decimal HTML entity form the same way", () => {
    const cleaned = cleanFeedDate(
      "Mon, 28 Sep 2026 22:25:43 &#43;0300",
      "sozcu",
    );
    expect(parseDate(cleaned, { nowMs: NOW_MS, sourceSlug: "sozcu" })).toBe(
      "2026-09-28T19:25:43.000Z",
    );
  });

  it("rewrites a literal Z followed by a numeric offset to the offset (Beyaz Gazete)", () => {
    const cleaned = cleanFeedDate(
      "2026-09-28T12:04:39Z +0300",
      "beyaz-gazete",
    );
    expect(cleaned).toBe("2026-09-28T12:04:39+03:00");
    expect(
      parseDate(cleaned, { nowMs: NOW_MS, sourceSlug: "beyaz-gazete" }),
    ).toBe("2026-09-28T09:04:39.000Z");
  });

  it("collapses extra internal whitespace before the zone designator (Milliyet)", () => {
    const cleaned = cleanFeedDate(
      "Mon, 28 Sep 2026 18:13:15  Z",
      "milliyet",
    );
    expect(cleaned).toBe("Mon, 28 Sep 2026 18:13:15 Z");
    expect(parseDate(cleaned, { nowMs: NOW_MS, sourceSlug: "milliyet" })).toBe(
      "2026-09-28T18:13:15.000Z",
    );
  });

  it("leaves a cnn-turk-style string untouched so the 074 UTC-mislabel rule still applies", () => {
    const raw = "Mon, 28 Sep 2026 22:00:00 Z";
    const cleaned = cleanFeedDate(raw, "cnn-turk");
    expect(cleaned).toBe(raw);
    // normalize.ts's own rule 3 (a cnn-turk UTC-labelled designator is
    // really Istanbul wall-clock time) still fires unchanged.
    expect(parseDate(cleaned, { nowMs: NOW_MS, sourceSlug: "cnn-turk" })).toBe(
      "2026-09-28T19:00:00.000Z",
    );
  });

  it("does not throw on an out-of-range numeric entity in a pubDate (it used to drop the whole source)", () => {
    let cleaned: string | undefined;
    expect(() => {
      cleaned = cleanFeedDate("Mon, 28 Sep 2026 12:00:00 &#1114112;+0300");
    }).not.toThrow();
    expect(cleaned).toBe("Mon, 28 Sep 2026 12:00:00 +0300");
  });

  it.each(["&#x110000;", "&#0;", "&#11;", "&#xD800;", "&#99999999999999999999;"])(
    "drops %s from a pubDate instead of throwing",
    (entity) => {
      expect(cleanFeedDate(`Mon, 28 Sep 2026 12:00:00 ${entity}+0300`)).toBe(
        "Mon, 28 Sep 2026 12:00:00 +0300",
      );
    },
  );

  it("still decodes '&#x2B;0300' and '&#43;0300' to '+0300'", () => {
    expect(cleanFeedDate("Mon, 28 Sep 2026 12:00:00 &#x2B;0300")).toBe(
      "Mon, 28 Sep 2026 12:00:00 +0300",
    );
    expect(cleanFeedDate("Mon, 28 Sep 2026 12:00:00 &#43;0300")).toBe(
      "Mon, 28 Sep 2026 12:00:00 +0300",
    );
  });

  it("returns undefined for undefined input", () => {
    expect(cleanFeedDate(undefined)).toBeUndefined();
  });

  it("returns undefined for a whitespace-only input", () => {
    expect(cleanFeedDate("   ")).toBeUndefined();
  });
});

describe("isParseableFeedDate", () => {
  it("is false for undefined", () => {
    expect(isParseableFeedDate(undefined)).toBe(false);
  });

  it("is false for an empty string", () => {
    expect(isParseableFeedDate("")).toBe(false);
  });

  it("is false for unparseable garbage", () => {
    expect(isParseableFeedDate("not a date")).toBe(false);
  });

  it("is true for a cleaned Sözcü date", () => {
    const cleaned = cleanFeedDate(
      "Mon, 28 Sep 2026 22:25:43 &#x2B;0300",
      "sozcu",
    );
    expect(isParseableFeedDate(cleaned, "sozcu")).toBe(true);
  });

  it("is true for a cleaned Beyaz Gazete date", () => {
    const cleaned = cleanFeedDate("2026-09-28T12:04:39Z +0300", "beyaz-gazete");
    expect(isParseableFeedDate(cleaned, "beyaz-gazete")).toBe(true);
  });

  it("is true for a cleaned Milliyet date", () => {
    const cleaned = cleanFeedDate("Mon, 28 Sep 2026 18:13:15  Z", "milliyet");
    expect(isParseableFeedDate(cleaned, "milliyet")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// A-ingest-cpu (hunt-11): parseDate builds its "unparseable -> nowMs" fallback
// lazily and isParseableFeedDate hoists its sentinel ISO string to a module
// constant. Neither may change an output.
// ---------------------------------------------------------------------------

describe("parseDate fallback [A-ingest-cpu]", () => {
  const NOW = Date.parse("2026-10-26T07:33:20Z");

  it.each([
    ["undefined", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["whitespace controls", "\t\n "],
    ["garbage", "not a date"],
    ["impossible day", "32 Foo 2026 99:99"],
    ["impossible ISO month", "2026-13-45T25:00:00Z"],
    ["slashed date", "2026/10/25"],
    ["time only", "10:30"],
  ])("falls back to nowMs for %s", (_name, raw) => {
    expect(parseDate(raw as string | undefined, { nowMs: NOW })).toBe("2026-10-26T07:33:20.000Z");
    expect(parseDate(raw as string | undefined, { nowMs: NOW })).toBe(new Date(NOW).toISOString());
  });

  it("the fallback follows whatever nowMs it is given, including the extremes", () => {
    for (const nowMs of [0, 1, NOW, 8.64e15, -8.64e15]) {
      expect(parseDate("", { nowMs })).toBe(new Date(nowMs).toISOString());
      expect(parseDate("garbage", { nowMs, sourceSlug: "cnn-turk" })).toBe(new Date(nowMs).toISOString());
    }
  });

  it("still parses real dates and clamps to nowMs", () => {
    expect(parseDate("Mon, 26 Oct 2026 08:30:00 +0300", { nowMs: NOW })).toBe("2026-10-26T05:30:00.000Z");
    expect(parseDate("2026-10-25 08:30", { nowMs: NOW })).toBe("2026-10-25T05:30:00.000Z");
    expect(parseDate("2026-10-25T10:00:00Z", { nowMs: NOW, sourceSlug: "cnn-turk" })).toBe(
      "2026-10-25T07:00:00.000Z",
    );
    // later than nowMs: clamped, never outruns ingest time
    expect(parseDate("2099-01-01T00:00:00Z", { nowMs: NOW })).toBe("2026-10-26T07:33:20.000Z");
  });
});

describe("isParseableFeedDate is unchanged [A-ingest-cpu]", () => {
  // The previous implementation, copied inline: the sentinel string was built
  // on every call.
  function isParseableFeedDateOld(cleaned: string | undefined, sourceSlug?: string): boolean {
    if (!cleaned) return false;
    const sentinelNow = 8.64e15;
    const sentinel = new Date(sentinelNow).toISOString();
    return parseDate(cleaned, { nowMs: sentinelNow, sourceSlug }) !== sentinel;
  }

  const CASES: Array<[string | undefined, string | undefined, boolean]> = [
    [undefined, undefined, false],
    ["", undefined, false],
    ["not a date", undefined, false],
    ["32 Foo 2026 99:99", "sozcu", false],
    ["2026-10-25 08:30", undefined, true],
    ["Mon, 26 Oct 2026 08:30:00 +0300", "milliyet", true],
    ["Mon, 26 Oct 2026 08:30:00", undefined, true],
    ["2026-10-25T10:00:00Z", "cnn-turk", true],
    ["2099-01-01T00:00:00Z", undefined, true],
    // The sentinel itself is indistinguishable from the fallback by design.
    [new Date(8.64e15).toISOString(), undefined, false],
  ];

  it.each(CASES)("%s (%s) -> %s", (cleaned, slug, expected) => {
    expect(isParseableFeedDate(cleaned, slug)).toBe(expected);
    expect(isParseableFeedDate(cleaned, slug)).toBe(isParseableFeedDateOld(cleaned, slug));
  });

  it("agrees with the old implementation on every cleaned corpus date", async () => {
    const corpus = (await import("../../fixtures/ingest-corpus.json")).default as unknown as {
      rows: Array<{ slug: string; item: { pubDate?: string } }>;
    };
    expect(corpus.rows.length).toBeGreaterThanOrEqual(200);
    const mismatches: string[] = [];
    for (const [i, row] of corpus.rows.entries()) {
      const cleaned = cleanFeedDate(row.item.pubDate, row.slug);
      if (isParseableFeedDate(cleaned, row.slug) !== isParseableFeedDateOld(cleaned, row.slug)) {
        mismatches.push(`#${i}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
