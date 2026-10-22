import { describe, it, expect } from "vitest";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { BiasDistribution, Source } from "@/types";

import type { ParsedSide } from "./compare-params";
import {
  formatIstanbulDateTime,
  rosterByZone,
  toSideState,
} from "./compare-view";

const ID = "aaaaaaaa-1111-4111-8111-bbbbbbbbbbbb";
const SURVIVOR = "cccccccc-2222-4222-8222-dddddddddddd";

function emptyDistribution(): BiasDistribution {
  return {
    pro_government: 0,
    gov_leaning: 0,
    state_media: 0,
    center: 0,
    opposition_leaning: 0,
    opposition: 0,
    nationalist: 0,
    islamist_conservative: 0,
    pro_kurdish: 0,
    international: 0,
  };
}

function makeSource(
  slug: string,
  name: string,
  bias: Source["bias"],
  kind?: Source["kind"],
): Source {
  return {
    id: `id-${slug}`,
    name,
    slug,
    url: `https://example.com/${slug}`,
    rss_url: `https://example.com/${slug}/rss`,
    bias,
    logo_url: null,
    active: true,
    kind,
    trustee_since: null,
    trustee_note: null,
  };
}

function makeMember(source: Source, n = 1): ClusterDetailMember {
  return {
    source,
    article: {
      id: `a-${source.slug}-${n}`,
      title: `${source.name} başlığı ${n}`,
      url: `https://example.com/${source.slug}/${n}`,
      published_at: "2026-10-22T11:05:00.000Z",
      image_url: null,
      content_hash: `h-${source.slug}-${n}`,
    },
  };
}

function makeDetail(
  overrides: {
    merged_into?: string | null;
    members?: ClusterDetailMember[];
    is_blindspot?: boolean;
  } = {},
): ClusterDetail {
  const distribution = emptyDistribution();
  distribution.pro_government = 2;
  distribution.center = 1;
  const members = overrides.members ?? [];
  return {
    cluster: {
      id: ID,
      title_tr: "Deneme hikâyesi",
      title_original: null,
      title_method: null,
      summary_tr: "özet",
      article_count: 3,
      bias_distribution: distribution,
      is_blindspot: overrides.is_blindspot ?? false,
      blindspot_side: null,
      first_published: "2026-10-22T11:05:00.000Z",
      updated_at: "2026-10-22T12:00:00.000Z",
      is_archived: false,
      ...(overrides.merged_into !== undefined
        ? { merged_into: overrides.merged_into }
        : {}),
    },
    members,
    allSources: [],
    wire: {
      isWireRedistribution: false,
      effectiveArticleCount: 7,
      memberCount: members.length,
    },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
  };
}

const ID_SIDE: ParsedSide = { kind: "id", id: ID };

describe("toSideState", () => {
  it.each<ParsedSide>([
    { kind: "missing" },
    { kind: "invalid" },
    { kind: "duplicate" },
  ])("passes a %j side through unchanged without looking at the fetch", (parsed) => {
    expect(toSideState(parsed)).toEqual({ kind: parsed.kind });
    expect(
      toSideState(parsed, { status: "fulfilled", value: makeDetail() }),
    ).toEqual({ kind: parsed.kind });
    expect(
      toSideState(parsed, { status: "rejected", reason: new Error("boom") }),
    ).toEqual({ kind: parsed.kind });
  });

  it("maps a rejected fetch to unavailable", () => {
    expect(
      toSideState(ID_SIDE, { status: "rejected", reason: new Error("timeout") }),
    ).toEqual({ kind: "unavailable" });
  });

  it("maps an id side with no settled result to unavailable (defensive)", () => {
    expect(toSideState(ID_SIDE)).toEqual({ kind: "unavailable" });
  });

  it("maps a fulfilled null to not_found", () => {
    expect(
      toSideState(ID_SIDE, { status: "fulfilled", value: null }),
    ).toEqual({ kind: "not_found" });
  });

  it("maps a merged cluster with a valid survivor to merged", () => {
    expect(
      toSideState(ID_SIDE, {
        status: "fulfilled",
        value: makeDetail({ merged_into: SURVIVOR }),
      }),
    ).toEqual({ kind: "merged", survivorId: SURVIVOR });
  });

  it("maps a merged cluster whose survivor is not a UUID to not_found", () => {
    expect(
      toSideState(ID_SIDE, {
        status: "fulfilled",
        value: makeDetail({ merged_into: "<script>" }),
      }),
    ).toEqual({ kind: "not_found" });
  });

  it("treats merged_into null/undefined as a live cluster", () => {
    for (const merged_into of [null, undefined]) {
      const state = toSideState(ID_SIDE, {
        status: "fulfilled",
        value: makeDetail({ merged_into }),
      });
      expect(state.kind).toBe("ok");
    }
  });

  it("builds the SideView for a live cluster", () => {
    const state = toSideState(ID_SIDE, {
      status: "fulfilled",
      value: makeDetail({
        is_blindspot: true,
        members: [makeMember(makeSource("a", "Alfa", "pro_government"))],
      }),
    });
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.view.id).toBe(ID);
    expect(state.view.title).toBe("Deneme hikâyesi");
    expect(state.view.isBlindspot).toBe(true);
    expect(state.view.sourceCount).toBe(7);
    expect(state.view.firstPublished).toBe("2026-10-22T11:05:00.000Z");
    expect(state.view.distribution.pro_government).toBe(2);
    expect(state.view.roster.iktidar).toEqual(["Alfa"]);
    expect(state.view.nonVoting).toEqual([]);
  });
});

describe("rosterByZone", () => {
  it("groups voting members into the three zones", () => {
    const { roster } = rosterByZone([
      makeMember(makeSource("gov", "Hükümet Gazetesi", "pro_government")),
      makeMember(makeSource("ctr", "Merkez Haber", "center")),
      makeMember(makeSource("opp", "Muhalif Gazete", "opposition")),
    ]);
    expect(roster).toEqual({
      iktidar: ["Hükümet Gazetesi"],
      bagimsiz: ["Merkez Haber"],
      muhalefet: ["Muhalif Gazete"],
    });
  });

  it("returns empty arrays for zones without a source", () => {
    expect(rosterByZone([]).roster).toEqual({
      iktidar: [],
      bagimsiz: [],
      muhalefet: [],
    });
  });

  it("maps several bias values of one zone into that zone", () => {
    const { roster } = rosterByZone([
      makeMember(makeSource("s1", "Devlet", "state_media")),
      makeMember(makeSource("s2", "Milliyetçi", "nationalist")),
      makeMember(makeSource("s3", "Dış", "international")),
    ]);
    expect(roster.iktidar).toEqual(["Devlet", "Milliyetçi"]);
    expect(roster.bagimsiz).toEqual(["Dış"]);
  });

  it("dedupes by source slug (several articles from one outlet)", () => {
    const s = makeSource("dup", "Tekrar Gazete", "center");
    const { roster } = rosterByZone([makeMember(s, 1), makeMember(s, 2), makeMember(s, 3)]);
    expect(roster.bagimsiz).toEqual(["Tekrar Gazete"]);
  });

  it("keeps non-voting members out of the zones and separate", () => {
    const { roster, nonVoting } = rosterByZone([
      makeMember(makeSource("out", "Gazete", "center", "outlet")),
      makeMember(makeSource("agg", "Toplayıcı", "center", "aggregator")),
      makeMember(makeSource("nic", "Niş", "opposition", "niche")),
    ]);
    expect(roster.bagimsiz).toEqual(["Gazete"]);
    expect(roster.muhalefet).toEqual([]);
    expect(nonVoting).toEqual(["Niş", "Toplayıcı"]);
  });

  it("dedupes non-voting members by slug too", () => {
    const agg = makeSource("agg", "Toplayıcı", "center", "aggregator");
    expect(rosterByZone([makeMember(agg, 1), makeMember(agg, 2)]).nonVoting).toEqual([
      "Toplayıcı",
    ]);
  });

  it("sorts names with Turkish collation", () => {
    const { roster } = rosterByZone([
      makeMember(makeSource("z", "Zaman", "center")),
      makeMember(makeSource("i", "Işık", "center")),
      makeMember(makeSource("c", "Cumhuriyet", "center")),
      makeMember(makeSource("cc", "Çarşı", "center")),
      makeMember(makeSource("h", "Habertürk", "center")),
    ]);
    // Turkish alphabet: C < Ç < H < I (dotless) < Z
    expect(roster.bagimsiz).toEqual(["Cumhuriyet", "Çarşı", "Habertürk", "Işık", "Zaman"]);
  });

  it("does not mutate its input", () => {
    const members = Object.freeze([
      makeMember(makeSource("b", "B", "center")),
      makeMember(makeSource("a", "A", "center")),
    ]);
    expect(() => rosterByZone(members)).not.toThrow();
    expect(members.map((m) => m.source.slug)).toEqual(["b", "a"]);
  });
});

describe("formatIstanbulDateTime", () => {
  it("formats in Istanbul time (UTC+3), Turkish, with 24h time", () => {
    const out = formatIstanbulDateTime("2026-10-22T11:05:00.000Z");
    expect(out).toContain("2026");
    expect(out).toContain("14:05");
    expect(out).toContain("Ekim");
    expect(out).toContain("22");
  });

  it("rolls over the date across midnight Istanbul time", () => {
    const out = formatIstanbulDateTime("2026-10-22T22:30:00.000Z");
    expect(out).toContain("23");
    expect(out).toContain("01:30");
  });

  it("returns '' for invalid input", () => {
    expect(formatIstanbulDateTime("")).toBe("");
    expect(formatIstanbulDateTime("not a date")).toBe("");
    expect(formatIstanbulDateTime("2026-13-45T99:99:99Z")).toBe("");
  });
});
