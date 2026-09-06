import { describe, it, expect } from "vitest";

import {
  SOURCE_KINDS,
  VOTING_SOURCE_KINDS,
  DEFAULT_SOURCE_KIND,
  isSourceKind,
  normalizeSourceKind,
  isVotingKind,
  votingBiasKeys,
} from "../../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// The source-kind contract (supabase/functions/_shared/cluster/source-kind.ts):
// four source kinds exist (outlet, aggregator, wire, niche); only outlet and
// wire vote in bias_distribution, blindspot/surprise detection and the
// trends view. Aggregators and niche sources remain cluster members but are
// excluded from every vote-derived computation.
// ---------------------------------------------------------------------------

describe("SOURCE_KINDS / VOTING_SOURCE_KINDS", () => {
  it("SOURCE_KINDS is exactly [outlet, aggregator, wire, niche]", () => {
    expect(SOURCE_KINDS).toEqual(["outlet", "aggregator", "wire", "niche"]);
  });

  it("VOTING_SOURCE_KINDS is exactly [outlet, wire]", () => {
    expect(VOTING_SOURCE_KINDS).toEqual(["outlet", "wire"]);
  });

  it("VOTING_SOURCE_KINDS is a subset of SOURCE_KINDS", () => {
    for (const k of VOTING_SOURCE_KINDS) {
      expect(SOURCE_KINDS).toContain(k);
    }
  });

  it("DEFAULT_SOURCE_KIND is outlet and is a voting kind", () => {
    expect(DEFAULT_SOURCE_KIND).toBe("outlet");
    expect(VOTING_SOURCE_KINDS).toContain(DEFAULT_SOURCE_KIND);
  });
});

describe("isSourceKind", () => {
  it("accepts each real kind", () => {
    for (const k of SOURCE_KINDS) {
      expect(isSourceKind(k)).toBe(true);
    }
  });

  it("rejects an unknown string", () => {
    expect(isSourceKind("bogus")).toBe(false);
  });

  it("rejects null, undefined and a non-string", () => {
    expect(isSourceKind(null)).toBe(false);
    expect(isSourceKind(undefined)).toBe(false);
    expect(isSourceKind(3)).toBe(false);
  });
});

describe("normalizeSourceKind", () => {
  it("passes through each real kind unchanged", () => {
    for (const k of SOURCE_KINDS) {
      expect(normalizeSourceKind(k)).toBe(k);
    }
  });

  it("falls back to outlet for null, undefined and bogus values", () => {
    expect(normalizeSourceKind(null)).toBe("outlet");
    expect(normalizeSourceKind(undefined)).toBe("outlet");
    expect(normalizeSourceKind("bogus")).toBe("outlet");
  });
});

describe("isVotingKind", () => {
  it("is true for outlet and wire", () => {
    expect(isVotingKind("outlet")).toBe(true);
    expect(isVotingKind("wire")).toBe(true);
  });

  it("is true for null/undefined (legacy rows without kind keep voting)", () => {
    expect(isVotingKind(null)).toBe(true);
    expect(isVotingKind(undefined)).toBe(true);
  });

  it("is false for aggregator and niche", () => {
    expect(isVotingKind("aggregator")).toBe(false);
    expect(isVotingKind("niche")).toBe(false);
  });
});

describe("votingBiasKeys", () => {
  it("keeps order, drops null rows / null bias / non-voting rows (contract example)", () => {
    const rows = [
      { bias: "center", kind: "aggregator" },
      { bias: "pro_government", kind: "outlet" },
      null,
      { bias: null, kind: "wire" },
      { bias: "opposition" },
    ] as const;
    expect(votingBiasKeys(rows)).toEqual(["pro_government", "opposition"]);
  });

  it("a row with no kind key at all still votes", () => {
    expect(votingBiasKeys([{ bias: "center" }])).toEqual(["center"]);
  });

  it("drops undefined rows and undefined bias", () => {
    expect(
      votingBiasKeys([undefined, { bias: undefined, kind: "outlet" }, { bias: "nationalist", kind: "outlet" }]),
    ).toEqual(["nationalist"]);
  });

  it("returns an empty array when every row is non-voting or unusable", () => {
    expect(
      votingBiasKeys([
        { bias: "center", kind: "niche" },
        { bias: "opposition", kind: "aggregator" },
        null,
      ]),
    ).toEqual([]);
  });
});
