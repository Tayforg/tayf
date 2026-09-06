import { describe, it, expect } from "vitest";
import {
  SOURCE_KINDS,
  SOURCE_KIND_META,
  sourceKindOf,
  isVotingSource,
  partitionByVote,
} from "./kind";
import type { SourceKind } from "@/types";

describe("SOURCE_KIND_META", () => {
  it("covers every SOURCE_KINDS key with a non-empty label and description", () => {
    for (const kind of SOURCE_KINDS) {
      const meta = SOURCE_KIND_META[kind];
      expect(meta).toBeDefined();
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
    }
  });

  it("voting kinds' descriptions say they count; non-voting say they don't", () => {
    expect(SOURCE_KIND_META.outlet.description).toMatch(/sayılır/);
    expect(SOURCE_KIND_META.wire.description).toMatch(/sayılır/);
    expect(SOURCE_KIND_META.aggregator.description).toMatch(/sayılmaz/);
    expect(SOURCE_KIND_META.niche.description).toMatch(/sayılmaz/);
  });
});

describe("sourceKindOf", () => {
  it("normalizes undefined to outlet", () => {
    expect(sourceKindOf({ kind: undefined })).toBe("outlet");
  });

  it("passes through a valid kind", () => {
    expect(sourceKindOf({ kind: "niche" })).toBe("niche");
  });
});

describe("isVotingSource", () => {
  it("undefined kind votes (legacy rows default to outlet)", () => {
    expect(isVotingSource({ kind: undefined })).toBe(true);
  });

  it("niche does not vote", () => {
    expect(isVotingSource({ kind: "niche" })).toBe(false);
  });
});

describe("partitionByVote", () => {
  it("keeps input order and splits voting vs non-voting members", () => {
    const kinds: Array<SourceKind | undefined> = ["outlet", "aggregator", "wire", "niche", undefined];
    const members = kinds.map((kind, i) => ({
      id: `m${i}`,
      source: { kind },
    }));

    const { voting, nonVoting } = partitionByVote(members);

    expect(voting.map((m) => m.id)).toEqual(["m0", "m2", "m4"]);
    expect(nonVoting.map((m) => m.id)).toEqual(["m1", "m3"]);
  });
});
