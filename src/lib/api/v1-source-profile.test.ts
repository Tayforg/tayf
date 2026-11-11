import { describe, expect, it } from "vitest";

import { toV1SourceProfile } from "@/lib/api/v1-source-profile";
import { buildKarneView, type SourceKarne } from "@/lib/sources/karne";

// h128-apiv1-2 part B: the site's karne drops the "yazan bölgedeydi" (same-side) clause for an
// aggregator or niche source (buildKarneView's `voting: false`), because migration 106 derives
// such a source's own_zone from its bias label: "the zone that wrote the story" is a zone the
// source never voted in. The keyed profile mirrors the card, so it drops the number as well.
// haberler-com on 2026-11-11: 152 blindspot appearances, 131 "same side".

function karne(over: Partial<SourceKarne> = {}): SourceKarne {
  return {
    windowDays: 30,
    windowStart: "2026-10-12T00:00:00.000Z",
    windowEnd: "2026-11-11T00:00:00.000Z",
    nClusters: 600,
    nMulti: 400,
    nSolo: 200,
    co: { iktidar: 300, bagimsiz: 280, muhalefet: 250 },
    nBlindspot: 152,
    nBlindspotSameSide: 131,
    computedAt: "2026-11-11T03:00:00.000Z",
    ...over,
  };
}

describe("toV1SourceProfile: the voting option", () => {
  it("voting: false keeps the appearance count and nulls the same-side count", () => {
    const p = toV1SourceProfile(karne(), { voting: false });
    expect(p.public_blindspot_appearances).toBe(152);
    expect(p.public_blindspot_same_side).toBeNull();
  });

  it("voting: false changes nothing else in the profile", () => {
    const voting = toV1SourceProfile(karne(), { voting: true });
    const nonVoting = toV1SourceProfile(karne(), { voting: false });
    expect({ ...nonVoting, public_blindspot_same_side: voting.public_blindspot_same_side }).toEqual(voting);
  });

  it("voting: true keeps the same-side count", () => {
    const p = toV1SourceProfile(karne(), { voting: true });
    expect(p.public_blindspot_appearances).toBe(152);
    expect(p.public_blindspot_same_side).toBe(131);
  });

  it("the default is voting (no options, and an empty options object)", () => {
    expect(toV1SourceProfile(karne()).public_blindspot_same_side).toBe(131);
    expect(toV1SourceProfile(karne(), {}).public_blindspot_same_side).toBe(131);
  });

  it("a non-voting source with no blindspot appearances is 0 and null, not 0 and 0", () => {
    const p = toV1SourceProfile(karne({ nBlindspot: 0, nBlindspotSameSide: 0 }), { voting: false });
    expect(p.public_blindspot_appearances).toBe(0);
    expect(p.public_blindspot_same_side).toBeNull();
  });

  it("below the cluster threshold both blindspot fields are null whatever the option", () => {
    for (const voting of [true, false]) {
      const p = toV1SourceProfile(karne({ nClusters: 12, nMulti: 5, nSolo: 7, co: { iktidar: 1, bagimsiz: 1, muhalefet: 1 } }), { voting });
      expect(p.sufficient).toBe(false);
      expect(p.public_blindspot_appearances).toBeNull();
      expect(p.public_blindspot_same_side).toBeNull();
    }
  });

  it("follows the site: the karne text drops the same-side clause exactly when the profile drops the number", () => {
    for (const voting of [true, false]) {
      const view = buildKarneView(karne(), { voting });
      if (view.state !== "ok") throw new Error("expected an ok view");
      const profile = toV1SourceProfile(karne(), { voting });
      expect(view.blindspotText.includes("yazan bölgedeydi")).toBe(profile.public_blindspot_same_side !== null);
    }
  });
});
