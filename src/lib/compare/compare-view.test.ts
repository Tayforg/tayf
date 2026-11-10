import { describe, it, expect } from "vitest";

import type {
  ClusterDetail,
  ClusterDetailMember,
} from "@/lib/clusters/cluster-detail-query";
import type { WireSignal } from "@/lib/clusters/wire";
import type { BiasDistribution, MediaDnaZone, Source } from "@/types";

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

function makeMember(source: Source, n = 1, title?: string): ClusterDetailMember {
  return {
    source,
    article: {
      id: `a-${source.slug}-${n}`,
      title: title ?? `${source.name} başlığı ${n}`,
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
    wire?: Partial<WireSignal>;
    title_tr?: string;
    title_method?: ClusterDetail["cluster"]["title_method"];
    recallMatchedZones?: MediaDnaZone[];
  } = {},
): ClusterDetail {
  const distribution = emptyDistribution();
  distribution.pro_government = 2;
  distribution.center = 1;
  const members = overrides.members ?? [];
  return {
    cluster: {
      id: ID,
      title_tr: overrides.title_tr ?? "Deneme hikâyesi",
      title_original: null,
      title_method: overrides.title_method ?? null,
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
      ...overrides.wire,
    },
    blindspotSuppressed: false,
    blindspotRecallVetoed: false,
    // Absent unless given: a detail cached before the field existed has none.
    ...(overrides.recallMatchedZones !== undefined
      ? { recallMatchedZones: overrides.recallMatchedZones }
      : {}),
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
    expect(state.view.nonVotingZones).toEqual([]);
    expect(state.view.wire).toEqual({ isWire: false, memberCount: 1, uniqueTexts: 7 });
    // h110-karsilastir-1: the three fields of a plain Turkish cluster that was
    // never looked up by Jev recall are the neutral ones.
    expect(state.view.languageIsolated).toBe(false);
    expect(state.view.recallMatchedZones).toEqual([]);
    expect(state.view.headlineLang).toBeUndefined();
  });

  it("carries the zones of the non-voting members through to the view", () => {
    const state = toSideState(ID_SIDE, {
      status: "fulfilled",
      value: makeDetail({
        members: [
          makeMember(makeSource("gov", "Hükümet", "pro_government")),
          makeMember(makeSource("nic", "Niş Merkez", "center", "niche")),
        ],
      }),
    });
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.view.roster.bagimsiz).toEqual([]);
    expect(state.view.nonVoting).toEqual(["Niş Merkez"]);
    expect(state.view.nonVotingZones).toEqual(["bagimsiz"]);
  });

  it("exposes the wire signal without changing the source count", () => {
    const state = toSideState(ID_SIDE, {
      status: "fulfilled",
      value: makeDetail({
        members: [
          makeMember(makeSource("a", "Anadolu", "state_media", "wire"), 1),
          makeMember(makeSource("e", "Elips", "pro_government"), 2),
          makeMember(makeSource("m", "Milat", "pro_government"), 3),
        ],
        wire: { isWireRedistribution: true, memberCount: 3, effectiveArticleCount: 1 },
      }),
    });
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.view.wire).toEqual({ isWire: true, memberCount: 3, uniqueTexts: 1 });
    expect(state.view.sourceCount).toBe(1);
  });

  it("exposes a several-texts wire cluster (4 members, 2 texts)", () => {
    const state = toSideState(ID_SIDE, {
      status: "fulfilled",
      value: makeDetail({
        wire: { isWireRedistribution: true, memberCount: 4, effectiveArticleCount: 2 },
      }),
    });
    expect(state.kind).toBe("ok");
    if (state.kind !== "ok") return;
    expect(state.view.wire).toEqual({ isWire: true, memberCount: 4, uniqueTexts: 2 });
    expect(state.view.sourceCount).toBe(2);
  });

  describe("h110-karsilastir-1: language and recall facts the cluster page already derives", () => {
    const aNews = () => makeSource("a-news", "A News", "gov_leaning");
    const trtWorld = () => makeSource("trt-world", "TRT World", "gov_leaning");
    const turkish = () => makeSource("sozcu", "Sözcü", "opposition");

    function okView(detail: ClusterDetail) {
      const state = toSideState(ID_SIDE, { status: "fulfilled", value: detail });
      expect(state.kind).toBe("ok");
      if (state.kind !== "ok") throw new Error("expected an ok side");
      return state.view;
    }

    it("marks a cluster whose every member is an English outlet as language-isolated with an 'en' headline", () => {
      const view = okView(
        makeDetail({ members: [makeMember(aNews()), makeMember(trtWorld())] }),
      );
      expect(view.languageIsolated).toBe(true);
      expect(view.headlineLang).toBe("en");
    });

    it("does not isolate a mixed Turkish and English cluster", () => {
      const view = okView(
        makeDetail({ members: [makeMember(aNews()), makeMember(turkish())] }),
      );
      expect(view.languageIsolated).toBe(false);
    });

    it("counts a non-voting English member too (voting or not, as the cluster page does)", () => {
      const view = okView(
        makeDetail({
          members: [
            makeMember(aNews()),
            makeMember(makeSource("mfa-turkey", "MFA Türkiye", "gov_leaning", "niche")),
          ],
        }),
      );
      expect(view.languageIsolated).toBe(true);
    });

    it("never isolates an empty member list", () => {
      const view = okView(makeDetail({ members: [] }));
      expect(view.languageIsolated).toBe(false);
      expect(view.headlineLang).toBeUndefined();
    });

    it("gives a mixed cluster an 'en' headline only when an English member's title IS the headline", () => {
      const english = "NATO chief visits Türkiye ahead of key summit";
      const view = okView(
        makeDetail({
          title_tr: english,
          members: [makeMember(aNews(), 1, english), makeMember(turkish(), 1, "NATO Genel Sekreteri ziyaret etti")],
        }),
      );
      expect(view.languageIsolated).toBe(false);
      expect(view.headlineLang).toBe("en");
    });

    it("gives a mixed cluster with a Turkish headline no lang", () => {
      const view = okView(
        makeDetail({
          title_tr: "NATO Genel Sekreteri ziyaret etti",
          members: [
            makeMember(aNews(), 1, "NATO chief visits Türkiye ahead of key summit"),
            makeMember(turkish(), 1, "NATO Genel Sekreteri ziyaret etti"),
          ],
        }),
      );
      expect(view.headlineLang).toBeUndefined();
    });

    it("lets a Turkish member that carries the same title veto the 'en' headline", () => {
      const shared = "NATO";
      const view = okView(
        makeDetail({
          title_tr: shared,
          members: [makeMember(aNews(), 1, shared), makeMember(turkish(), 1, shared)],
        }),
      );
      expect(view.headlineLang).toBeUndefined();
    });

    it("leaves the headline of an LLM rewrite undefined, even for an all-English cluster", () => {
      const view = okView(
        makeDetail({
          title_method: "llm",
          members: [makeMember(aNews()), makeMember(trtWorld())],
        }),
      );
      expect(view.languageIsolated).toBe(true);
      expect(view.headlineLang).toBeUndefined();
    });

    it("leaves a contentless headline undefined (the page prints it as text without a language claim)", () => {
      for (const title_tr of ["—", "...", "", "   "]) {
        const view = okView(
          makeDetail({ title_tr, members: [makeMember(aNews()), makeMember(trtWorld())] }),
        );
        expect(view.headlineLang).toBeUndefined();
      }
    });

    it("passes the recall-matched zones through", () => {
      const view = okView(makeDetail({ recallMatchedZones: ["muhalefet"] }));
      expect(view.recallMatchedZones).toEqual(["muhalefet"]);
      const two = okView(makeDetail({ recallMatchedZones: ["bagimsiz", "iktidar"] }));
      expect(two.recallMatchedZones).toEqual(["bagimsiz", "iktidar"]);
    });

    it("reads a missing recallMatchedZones (a cache entry from before the field, a failed lookup) as []", () => {
      const detail = makeDetail();
      expect("recallMatchedZones" in detail).toBe(false);
      expect(okView(detail).recallMatchedZones).toEqual([]);
      expect(okView(makeDetail({ recallMatchedZones: [] })).recallMatchedZones).toEqual([]);
    });
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

  it("lists the zone of a niche member next to voting members of other zones", () => {
    const { roster, nonVoting, nonVotingZones } = rosterByZone([
      makeMember(makeSource("gov", "Hükümet Gazetesi", "pro_government")),
      makeMember(makeSource("nic", "Niş Merkez", "center", "niche")),
    ]);
    expect(roster.bagimsiz).toEqual([]);
    expect(nonVoting).toEqual(["Niş Merkez"]);
    expect(nonVotingZones).toEqual(["bagimsiz"]);
  });

  it("returns no non-voting zones when no member is non-voting", () => {
    expect(
      rosterByZone([
        makeMember(makeSource("gov", "Hükümet Gazetesi", "pro_government")),
        makeMember(makeSource("ctr", "Merkez Haber", "center")),
      ]).nonVotingZones,
    ).toEqual([]);
    expect(rosterByZone([]).nonVotingZones).toEqual([]);
  });

  it("dedupes non-voting zones and orders them iktidar, bagimsiz, muhalefet", () => {
    const { nonVotingZones } = rosterByZone([
      makeMember(makeSource("n1", "Niş Bir", "center", "niche")),
      makeMember(makeSource("agg", "Toplayıcı", "gov_leaning", "aggregator")),
      makeMember(makeSource("n2", "Niş İki", "center", "niche")),
    ]);
    expect(nonVotingZones).toEqual(["iktidar", "bagimsiz"]);
  });

  it("orders all three zones regardless of member order", () => {
    const { nonVotingZones } = rosterByZone([
      makeMember(makeSource("n3", "Niş Muhalif", "opposition", "niche")),
      makeMember(makeSource("n2", "Niş Merkez", "center", "niche")),
      makeMember(makeSource("n1", "Niş İktidar", "pro_government", "niche")),
    ]);
    expect(nonVotingZones).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
  });

  it("still lists a zone that also has a voting member (the page only reads it for empty zones)", () => {
    const { roster, nonVotingZones } = rosterByZone([
      makeMember(makeSource("ctr", "Merkez Haber", "center")),
      makeMember(makeSource("nic", "Niş Merkez", "center", "niche")),
    ]);
    expect(roster.bagimsiz).toEqual(["Merkez Haber"]);
    expect(nonVotingZones).toEqual(["bagimsiz"]);
  });

  it("maps a non-voting member to its zone through zoneOf (international is bagimsiz)", () => {
    expect(
      rosterByZone([makeMember(makeSource("n", "Niş Dış", "international", "niche"))])
        .nonVotingZones,
    ).toEqual(["bagimsiz"]);
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
