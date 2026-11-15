import { describe, expect, it } from "vitest";

import { UPDATED_AGE_PREFIX, cardAgeBasis, cardAgeParts } from "./card-age";
import { SEARCH_SORT_NEW } from "./search-sort";

// h192-yeni-1: the age pill of a card in the newest-first archive list prints the basis of the ORDER. The list is ordered by
// clusters.updated_at, but the pill printed the age of first_published, so the times jumped up and down under an "en yeni"
// heading ("2, 15, 5, 14 saat önce"). In that list only, the pill reads "Güncellendi <age of updated_at>"; everywhere else it
// is the plain age of first_published it always was.

const NOW = Date.parse("2026-11-15T07:00:00Z");
const FIRST = "2026-11-14T15:44:00Z"; // 15 h before NOW
const UPDATED = "2026-11-15T04:43:00Z"; // about 2 h before NOW

describe("cardAgeBasis", () => {
  it("is 'updated' only for the newest-first order", () => {
    expect(SEARCH_SORT_NEW).toBe("yeni");
    expect(cardAgeBasis("yeni")).toBe("updated");
    expect(cardAgeBasis(SEARCH_SORT_NEW)).toBe("updated");
  });

  it("is 'first' for the ranked order (null), so every other list keeps its age", () => {
    expect(cardAgeBasis(null)).toBe("first");
  });
});

describe("cardAgeParts, basis 'first' (today's output)", () => {
  it("prints first_published with no prefix and no title", () => {
    const parts = cardAgeParts({ basis: "first", firstPublished: FIRST, updatedAt: UPDATED });
    expect(parts).toEqual({ iso: FIRST, prefix: "" });
    expect("title" in parts).toBe(false);
  });

  it("does not look at updated_at at all (an invalid or earlier one changes nothing)", () => {
    for (const updatedAt of ["not a date", "", "2020-01-01T00:00:00Z", UPDATED]) {
      expect(cardAgeParts({ basis: "first", firstPublished: FIRST, updatedAt })).toEqual({ iso: FIRST, prefix: "" });
    }
  });
});

describe("cardAgeParts, basis 'updated'", () => {
  it("prints updated_at behind the exact prefix 'Güncellendi ', and keeps the first story's age as the title", () => {
    const parts = cardAgeParts({ basis: "updated", firstPublished: FIRST, updatedAt: UPDATED, nowMs: NOW });
    expect(parts.iso).toBe(UPDATED);
    expect(parts.prefix).toBe("Güncellendi ");
    expect(UPDATED_AGE_PREFIX).toBe("Güncellendi ");
    expect(parts.title).toBe("İlk haber: 15 saat önce");
  });

  it("measures the title against the 'now' it is given, so a static page never reads the clock", () => {
    const later = cardAgeParts({
      basis: "updated",
      firstPublished: FIRST,
      updatedAt: UPDATED,
      nowMs: NOW + 60 * 60_000,
    });
    expect(later.title).toBe("İlk haber: 16 saat önce");
  });

  it("titles a first story older than 48 h with its date (formatTurkishTimeAgo's own rule)", () => {
    const parts = cardAgeParts({
      basis: "updated",
      firstPublished: "2026-11-10T10:00:00Z",
      updatedAt: UPDATED,
      nowMs: NOW,
    });
    expect(parts.title).toBe("İlk haber: 10 Kasım 2026");
  });

  it("an updated_at equal to first_published is a valid update: still the updated basis", () => {
    const parts = cardAgeParts({ basis: "updated", firstPublished: FIRST, updatedAt: FIRST, nowMs: NOW });
    expect(parts.iso).toBe(FIRST);
    expect(parts.prefix).toBe("Güncellendi ");
  });

  it("falls back to the plain first_published result when updated_at is invalid", () => {
    for (const updatedAt of ["", "not a date", "2026-13-45T99:99:99Z"]) {
      const parts = cardAgeParts({ basis: "updated", firstPublished: FIRST, updatedAt, nowMs: NOW });
      expect(parts, JSON.stringify(updatedAt)).toEqual({ iso: FIRST, prefix: "" });
    }
  });

  it("falls back to the plain first_published result when updated_at is earlier than first_published", () => {
    const parts = cardAgeParts({
      basis: "updated",
      firstPublished: FIRST,
      updatedAt: "2026-11-14T15:43:59Z",
      nowMs: NOW,
    });
    expect(parts).toEqual({ iso: FIRST, prefix: "" });
    expect("title" in parts).toBe(false);
  });

  it("with an unreadable first_published and a valid updated_at: the updated age, and no title to print", () => {
    const parts = cardAgeParts({ basis: "updated", firstPublished: "garbage", updatedAt: UPDATED, nowMs: NOW });
    expect(parts.iso).toBe(UPDATED);
    expect(parts.prefix).toBe("Güncellendi ");
    expect(parts.title).toBeUndefined();
  });

  it("without nowMs the title still reads (the per-request page's own clock)", () => {
    const first = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const parts = cardAgeParts({ basis: "updated", firstPublished: first, updatedAt: new Date().toISOString() });
    expect(parts.title).toBe("İlk haber: 3 saat önce");
  });
});

describe("the times read newest-first (the point of the change)", () => {
  it("rows ordered by updated_at descending print a non-decreasing age under the 'updated' basis", () => {
    // first_published jumps around while updated_at falls: the three rows of the live finding.
    const rows = [
      { first: "2026-11-15T04:43:00Z", updated: "2026-11-15T06:46:00Z" },
      { first: "2026-11-14T15:44:00Z", updated: "2026-11-15T04:43:00Z" },
      { first: "2026-11-15T01:31:00Z", updated: "2026-11-15T04:16:00Z" },
    ];
    const ageMs = (iso: string) => NOW - Date.parse(iso);
    const updatedAges = rows.map((r) =>
      ageMs(cardAgeParts({ basis: "updated", firstPublished: r.first, updatedAt: r.updated, nowMs: NOW }).iso),
    );
    expect(updatedAges).toEqual([...updatedAges].sort((a, b) => a - b));
    // The old basis is what jumped: 2 h, 15 h, 5 h.
    const firstAges = rows.map((r) =>
      ageMs(cardAgeParts({ basis: "first", firstPublished: r.first, updatedAt: r.updated }).iso),
    );
    expect(firstAges).not.toEqual([...firstAges].sort((a, b) => a - b));
  });
});
