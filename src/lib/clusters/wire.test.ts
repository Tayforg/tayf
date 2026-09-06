import { describe, it, expect } from "vitest";

import {
  detectWireRedistribution,
  wireSignalOf,
  WIRE_UNIQUE_HASH_RATIO,
} from "./wire";

function members(hashes: Array<string | null>) {
  return hashes.map((content_hash, i) => ({ id: `a${i}`, content_hash }));
}

describe("detectWireRedistribution", () => {
  it("never flags fewer than 3 members, even with identical hashes", () => {
    const result = detectWireRedistribution(members(["h", "h"]));
    expect(result.isWire).toBe(false);
    expect(result.uniqueHashes).toBe(2);
  });

  it("never flags a single member", () => {
    const result = detectWireRedistribution(members(["h"]));
    expect(result.isWire).toBe(false);
    expect(result.uniqueHashes).toBe(1);
  });

  it("flags wire at the exact 0.5 ratio boundary (2 unique / 4 members)", () => {
    expect(WIRE_UNIQUE_HASH_RATIO).toBe(0.5);
    const result = detectWireRedistribution(members(["h1", "h1", "h2", "h2"]));
    expect(result.uniqueHashes).toBe(2);
    expect(result.isWire).toBe(true);
  });

  it("does not flag just above the 0.5 ratio (3 unique / 5 members = 0.6)", () => {
    const result = detectWireRedistribution(
      members(["h1", "h1", "h2", "h3", "h3"])
    );
    expect(result.uniqueHashes).toBe(3);
    expect(result.isWire).toBe(false);
  });

  it("flags wire when 5 members collapse to 2 unique hashes (0.4 ratio)", () => {
    const result = detectWireRedistribution(
      members(["h1", "h1", "h1", "h2", "h2"])
    );
    expect(result.uniqueHashes).toBe(2);
    expect(result.isWire).toBe(true);
  });

  it("treats null content_hash as unique per-article, never collapsing", () => {
    const result = detectWireRedistribution(members([null, null, null, null]));
    expect(result.uniqueHashes).toBe(4);
    expect(result.isWire).toBe(false);
  });

  it("treats a mix of null and shared hashes correctly", () => {
    // 3 nulls (each unique) + 2 shared "h" => 4 unique / 5 total = 0.8, not wire
    const result = detectWireRedistribution(members([null, null, null, "h", "h"]));
    expect(result.uniqueHashes).toBe(4);
    expect(result.isWire).toBe(false);
  });
});

describe("wireSignalOf", () => {
  it("returns effectiveArticleCount = uniqueHashes when wire, memberCount unchanged", () => {
    const signal = wireSignalOf(members(["h1", "h1", "h1", "h2", "h2"]));
    expect(signal.isWireRedistribution).toBe(true);
    expect(signal.effectiveArticleCount).toBe(2);
    expect(signal.memberCount).toBe(5);
  });

  it("returns effectiveArticleCount = memberCount when not wire", () => {
    const signal = wireSignalOf(members(["h1", "h2", "h3", "h4", "h5"]));
    expect(signal.isWireRedistribution).toBe(false);
    expect(signal.effectiveArticleCount).toBe(5);
    expect(signal.memberCount).toBe(5);
  });

  it("never flags wire for exactly 2 members regardless of hash overlap", () => {
    const signal = wireSignalOf(members(["h", "h"]));
    expect(signal.isWireRedistribution).toBe(false);
    expect(signal.effectiveArticleCount).toBe(2);
    expect(signal.memberCount).toBe(2);
  });
});
