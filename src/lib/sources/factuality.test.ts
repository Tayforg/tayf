import { describe, it, expect } from "vitest";

import { SOURCE_METADATA } from "./factuality";
import { OWNER_GROUPS } from "./ownership";

describe("SOURCE_METADATA ownerGroup", () => {
  it("every tagged entry has a non-null ownerGroup", () => {
    for (const [slug, meta] of Object.entries(SOURCE_METADATA)) {
      expect(meta.ownerGroup, `${slug} should have an ownerGroup`).not.toBeNull();
    }
  });

  it("every ownerGroup is a key of OWNER_GROUPS", () => {
    for (const [slug, meta] of Object.entries(SOURCE_METADATA)) {
      expect(
        Object.keys(OWNER_GROUPS),
        `${slug}'s ownerGroup "${meta.ownerGroup}" should be a known OWNER_GROUPS key`,
      ).toContain(meta.ownerGroup);
    }
  });
});
