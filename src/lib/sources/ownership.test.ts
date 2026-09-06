import { describe, it, expect } from "vitest";

import { OWNER_GROUPS, groupByOwner } from "./ownership";
import type { Source } from "@/types";

function source(slug: string, id = slug): Source {
  return {
    id,
    name: slug,
    slug,
    url: `https://${slug}.example`,
    rss_url: `https://${slug}.example/rss`,
    bias: "center",
    logo_url: null,
    active: true,
  };
}

describe("groupByOwner", () => {
  it("returns empty summary for empty input", () => {
    const result = groupByOwner([]);
    expect(result.groups).toEqual([]);
    expect(result.taggedSourceCount).toBe(0);
    expect(result.totalSourceCount).toBe(0);
    expect(result.taggedShare).toBe(0);
    expect(result.dominant).toBeNull();
  });

  it("counts untagged sources toward totalSourceCount only", () => {
    const result = groupByOwner([source("not-a-real-source")]);
    expect(result.totalSourceCount).toBe(1);
    expect(result.taggedSourceCount).toBe(0);
    expect(result.taggedShare).toBe(0);
    expect(result.groups).toEqual([]);
    expect(result.dominant).toBeNull();
  });

  it("groups mixed tagged/untagged sources correctly", () => {
    const result = groupByOwner([
      source("sabah"), // turkuvaz
      source("a-haber"), // turkuvaz
      source("hurriyet"), // demiroren
      source("not-a-real-source"), // untagged
    ]);
    expect(result.totalSourceCount).toBe(4);
    expect(result.taggedSourceCount).toBe(3);
    expect(result.taggedShare).toBeCloseTo(0.75);
    expect(result.groups).toHaveLength(2);
    expect(result.groups[0]?.ownerGroup).toBe("turkuvaz");
    expect(result.groups[0]?.sources).toHaveLength(2);
    expect(result.groups[1]?.ownerGroup).toBe("demiroren");
  });

  it("dedupes sources by slug", () => {
    const result = groupByOwner([source("sabah", "id-1"), source("sabah", "id-2")]);
    expect(result.totalSourceCount).toBe(1);
    expect(result.taggedSourceCount).toBe(1);
    expect(result.groups[0]?.sources).toHaveLength(1);
  });

  it("sorts groups by size descending, then label", () => {
    const result = groupByOwner([
      source("sabah"), // turkuvaz (1)
      source("hurriyet"), // demiroren (1)
      source("bbc-turkce"), // foreign-public (1)
      source("dw-turkce"), // foreign-public (2)
    ]);
    expect(result.groups[0]?.ownerGroup).toBe("foreign-public");
    expect(result.groups[0]?.sources).toHaveLength(2);
    // demiroren ("Demirören Medya") sorts before turkuvaz ("Turkuvaz Medya")
    // once size ties (both 1), by Turkish label.
    expect(result.groups[1]?.ownerGroup).toBe("demiroren");
    expect(result.groups[2]?.ownerGroup).toBe("turkuvaz");
  });

  it("marks dominant only when the top group holds >=50% of tagged sources", () => {
    const belowThreshold = groupByOwner([
      source("sabah"), // turkuvaz (1)
      source("hurriyet"), // demiroren (1)
      source("bbc-turkce"), // foreign-public (1)
    ]);
    expect(belowThreshold.dominant).toBeNull();

    const atThreshold = groupByOwner([
      source("sabah"), // turkuvaz
      source("a-haber"), // turkuvaz
      source("hurriyet"), // demiroren
      source("posta"), // demiroren
    ]);
    expect(atThreshold.dominant?.ownerGroup).toBe("demiroren");
    expect(atThreshold.dominant?.sources).toHaveLength(2);
  });

  it("every OWNER_GROUPS key has a Turkish label string", () => {
    for (const label of Object.values(OWNER_GROUPS)) {
      expect(typeof label).toBe("string");
      expect(label.length).toBeGreaterThan(0);
    }
  });
});
