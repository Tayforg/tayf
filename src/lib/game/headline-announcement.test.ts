import { describe, it, expect } from "vitest";

import { headlineAnnouncement } from "./headline-announcement";

describe("headlineAnnouncement", () => {
  it("prefixes 'position/total.' when the round size is known", () => {
    expect(headlineAnnouncement(1, 5, "Başlık A")).toBe("1/5. Başlık A");
    expect(headlineAnnouncement(10, 10, "Son manşet")).toBe("10/10. Son manşet");
  });

  it("prefixes 'position.' alone when the total is unknown (Çerçeve)", () => {
    expect(headlineAnnouncement(3, null, "B")).toBe("3. B");
  });

  it("returns '' for an undefined title, so no stale or empty sentence is announced", () => {
    expect(headlineAnnouncement(1, 5, undefined)).toBe("");
    expect(headlineAnnouncement(2, null, undefined)).toBe("");
  });

  it("returns '' for an empty title", () => {
    expect(headlineAnnouncement(1, 5, "")).toBe("");
    expect(headlineAnnouncement(4, null, "")).toBe("");
  });

  it("keeps Turkish characters and punctuation in the title untouched", () => {
    expect(headlineAnnouncement(2, 5, "Çağrı: “Şüphe” ğüşıöç İ")).toBe(
      "2/5. Çağrı: “Şüphe” ğüşıöç İ",
    );
  });
});
