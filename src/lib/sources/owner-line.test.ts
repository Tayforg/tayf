import { describe, expect, it } from "vitest";
import { ownerLineParts } from "./owner-line";

describe("ownerLineParts", () => {
  it("collapses an identical group and ownership into a single primary", () => {
    const parts = ownerLineParts({
      groupLabel: "Demirören Medya",
      ownership: "Demirören Medya",
      hasTrusteeBadge: false,
    });
    expect(parts).toEqual({ primary: "Demirören Medya", secondary: null });
  });

  it("prefers the more specific ownership string when it starts with the group", () => {
    const parts = ownerLineParts({
      groupLabel: "Turkuvaz Medya",
      ownership: "Turkuvaz Medya (Kalyon Grubu)",
      hasTrusteeBadge: false,
    });
    expect(parts).toEqual({ primary: "Turkuvaz Medya (Kalyon Grubu)", secondary: null });
  });

  it("with the trustee badge, strips the group's trailing kayyum parenthetical and dedupes against ownership", () => {
    const parts = ownerLineParts({
      groupLabel: "Can Holding (TMSF kayyum, 11.09.2025)",
      ownership: "Can Holding (TMSF kayyum yönetiminde, 11.09.2025; önceki sahip Ciner Medya)",
      hasTrusteeBadge: true,
    });
    expect(parts.primary).toBe("Can Holding");
    expect(parts.secondary).toBeNull();
    expect((parts.primary + " " + (parts.secondary ?? "")).toLowerCase().match(/kayyum/g)?.length ?? 0).toBe(0);
  });

  it("without the badge, keeps the group and still does not duplicate when ownership starts with it", () => {
    const parts = ownerLineParts({
      groupLabel: "Can Holding (TMSF kayyum, 11.09.2025)",
      ownership: "Can Holding (TMSF kayyum yönetiminde, 11.09.2025; önceki sahip Ciner Medya)",
      hasTrusteeBadge: false,
    });
    // base ("Can Holding", the group with its trailing parenthetical
    // stripped) is a prefix of `ownership`, so per the ownerLineParts
    // algorithm `ownership` alone is shown — it already carries "Can
    // Holding" plus the full trustee detail, so nothing is duplicated.
    expect(parts.primary).toBe("Can Holding (TMSF kayyum yönetiminde, 11.09.2025; önceki sahip Ciner Medya)");
    expect(parts.secondary).toBeNull();
  });

  it("keeps both parts when ownership is unrelated to the group", () => {
    const parts = ownerLineParts({
      groupLabel: "Ciner Medya",
      ownership: "Can Holding (TMSF kayyum yönetiminde, 11.09.2025; önceki sahip Ciner Medya)",
      hasTrusteeBadge: false,
    });
    expect(parts.primary).toBe("Ciner Medya");
    expect(parts.secondary).toBe("Can Holding (TMSF kayyum yönetiminde, 11.09.2025; önceki sahip Ciner Medya)");
  });

  it("returns only the group when ownership is missing", () => {
    expect(ownerLineParts({ groupLabel: "İhlas Holding", ownership: null, hasTrusteeBadge: false })).toEqual({
      primary: "İhlas Holding",
      secondary: null,
    });
    expect(ownerLineParts({ groupLabel: "İhlas Holding", hasTrusteeBadge: false })).toEqual({
      primary: "İhlas Holding",
      secondary: null,
    });
  });
});
