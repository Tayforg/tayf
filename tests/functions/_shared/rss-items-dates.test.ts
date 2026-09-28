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
