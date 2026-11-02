import { describe, expect, it } from "vitest";

import {
  BOOKMARK_LABEL_TITLE_MAX,
  bookmarkChipSuffix,
  bookmarkStoryLabel,
  labelTitle,
  savedRemovalAnnouncement,
  savedRemoveLabel,
} from "./bookmark-label";

describe("labelTitle", () => {
  it("trims and collapses whitespace runs", () => {
    expect(labelTitle("  Seçim \n\t sonuçları  ")).toBe("Seçim sonuçları");
  });

  it("returns null for null, undefined, blank and non-string input", () => {
    expect(labelTitle(null)).toBeNull();
    expect(labelTitle(undefined)).toBeNull();
    expect(labelTitle("")).toBeNull();
    expect(labelTitle("   \n ")).toBeNull();
    expect(labelTitle(42 as unknown as string)).toBeNull();
  });

  it("keeps a title of exactly the maximum length untouched", () => {
    const exact = "a".repeat(BOOKMARK_LABEL_TITLE_MAX);
    expect(labelTitle(exact)).toBe(exact);
  });

  it("cuts a longer title to the maximum, ending with an ellipsis", () => {
    const out = labelTitle("a".repeat(BOOKMARK_LABEL_TITLE_MAX + 20));
    expect(out).toBe(`${"a".repeat(BOOKMARK_LABEL_TITLE_MAX - 1)}…`);
    expect(Array.from(out ?? "")).toHaveLength(BOOKMARK_LABEL_TITLE_MAX);
  });

  it("counts code points, so an astral character is never split", () => {
    const out = labelTitle("😀".repeat(BOOKMARK_LABEL_TITLE_MAX + 5)) ?? "";
    expect(out.endsWith("…")).toBe(true);
    expect(Array.from(out)).toHaveLength(BOOKMARK_LABEL_TITLE_MAX);
    // No lone surrogate survives the cut.
    expect(out).toBe(`${"😀".repeat(BOOKMARK_LABEL_TITLE_MAX - 1)}…`);
  });
});

describe("bookmark accessible names", () => {
  it("names the overlay button after the story, generic without a title", () => {
    expect(bookmarkStoryLabel("Seçim")).toBe("«Seçim» hikâyesini kaydet");
    expect(bookmarkStoryLabel(null)).toBe("Hikâyeyi kaydet");
  });

  it("builds the chip suffix, null without a title", () => {
    expect(bookmarkChipSuffix("Seçim")).toBe(": «Seçim»");
    expect(bookmarkChipSuffix("  ")).toBeNull();
  });

  it("names the /saved remove button after the story, generic without a title", () => {
    expect(savedRemoveLabel("Seçim")).toBe("«Seçim» hikâyesini kaydedilenlerden çıkar");
    expect(savedRemoveLabel(undefined)).toBe("Kaydedilenlerden çıkar");
    expect(savedRemoveLabel("")).toBe("Kaydedilenlerden çıkar");
  });
});

describe("savedRemovalAnnouncement", () => {
  it("names the story and how many are left", () => {
    expect(savedRemovalAnnouncement("Seçim", 2)).toBe(
      "«Seçim» kaydedilenlerden çıkarıldı. 2 hikâye kaldı.",
    );
  });

  it("says '1 hikâye kaldı' for a single remaining story", () => {
    expect(savedRemovalAnnouncement("Seçim", 1)).toBe(
      "«Seçim» kaydedilenlerden çıkarıldı. 1 hikâye kaldı.",
    );
  });

  it("says nothing is left when the list is now empty", () => {
    expect(savedRemovalAnnouncement("Seçim", 0)).toBe(
      "«Seçim» kaydedilenlerden çıkarıldı. Kaydedilen hikâye kalmadı.",
    );
  });

  it("falls back to a generic subject for a null, undefined or blank title", () => {
    expect(savedRemovalAnnouncement(null, 2)).toBe(
      "Hikâye kaydedilenlerden çıkarıldı. 2 hikâye kaldı.",
    );
    expect(savedRemovalAnnouncement(undefined, 0)).toBe(
      "Hikâye kaydedilenlerden çıkarıldı. Kaydedilen hikâye kalmadı.",
    );
    expect(savedRemovalAnnouncement("   \n ", 1)).toBe(
      "Hikâye kaydedilenlerden çıkarıldı. 1 hikâye kaldı.",
    );
  });

  it("shortens a title longer than 80 code points through labelTitle", () => {
    const long = "b".repeat(100);
    const out = savedRemovalAnnouncement(long, 3);
    expect(out).toBe(`«${labelTitle(long)}» kaydedilenlerden çıkarıldı. 3 hikâye kaldı.`);
    expect(out).toContain("…»");
    expect(out).not.toContain("b".repeat(80));
  });

  it("collapses whitespace inside the title like the other names", () => {
    expect(savedRemovalAnnouncement("  Seçim \n sonucu ", 1)).toBe(
      "«Seçim sonucu» kaydedilenlerden çıkarıldı. 1 hikâye kaldı.",
    );
  });

  it("treats a negative or NaN remaining count as none left", () => {
    const none = "«Seçim» kaydedilenlerden çıkarıldı. Kaydedilen hikâye kalmadı.";
    expect(savedRemovalAnnouncement("Seçim", -1)).toBe(none);
    expect(savedRemovalAnnouncement("Seçim", Number.NaN)).toBe(none);
    expect(savedRemovalAnnouncement("Seçim", Number.NEGATIVE_INFINITY)).toBe(none);
  });

  it("groups thousands with the shared tr-TR count formatter", () => {
    expect(savedRemovalAnnouncement("Seçim", 1234)).toBe(
      "«Seçim» kaydedilenlerden çıkarıldı. 1.234 hikâye kaldı.",
    );
  });
});
