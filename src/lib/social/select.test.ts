import { describe, it, expect } from "vitest";
import {
  selectBlindspotsToPost,
  selectTopStory,
  SOCIAL_BLINDSPOTS_PER_TICK,
  type FreshClusterRow,
  type SocialCandidateBundle,
} from "./select";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";

const NOW = Date.parse("2026-09-28T12:00:00.000Z");

function healthyHealth(): ZoneFeedHealth {
  const zone = { healthy: 10, total: 10, degraded: false };
  return {
    iktidar: { ...zone },
    bagimsiz: { ...zone },
    muhalefet: { ...zone },
  } as unknown as ZoneFeedHealth;
}

function freshOk(id: string, overrides: Partial<FreshClusterRow> = {}): FreshClusterRow {
  return {
    id,
    is_blindspot: true,
    blindspot_recall_veto: false,
    blindspot_recall_suspect: false,
    blindspot_recall_checked_at: "2026-09-27T00:00:00.000Z",
    is_archived: false,
    ...overrides,
  };
}

function bsBundle(
  id: string,
  overrides: Partial<SocialCandidateBundle> & {
    dominantZone: "iktidar" | "bagimsiz" | "muhalefet";
    dominantPct: number;
  },
): SocialCandidateBundle & { dominantZone: "iktidar" | "bagimsiz" | "muhalefet"; dominantPct: number } {
  return {
    cluster: {
      id,
      title_tr: "Normal başlık hakkında haber",
      first_published: new Date(NOW - 6 * 3600 * 1000).toISOString(),
    },
    sources: [
      { id: "s1", bias: "pro_government" },
      { id: "s2", bias: "gov_leaning" },
      { id: "s3", bias: "state_media" },
      { id: "s4", bias: "nationalist" },
      { id: "s5", bias: "islamist_conservative" },
    ],
    effectiveArticleCount: 5,
    isWireRedistribution: false,
    ...overrides,
  };
}

describe("selectBlindspotsToPost", () => {
  it("returns nothing when health is null (fail closed)", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: null,
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a suppressed (degraded opposite pole) blindspot", () => {
    const health = healthyHealth();
    health.muhalefet.degraded = true;
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health,
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a candidate missing a fresh row", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map(),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a fresh row with is_blindspot false", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1", { is_blindspot: false })]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a vetoed row", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1", { blindspot_recall_veto: true })]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a suspect row", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1", { blindspot_recall_suspect: true })]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops an unchecked row (blindspot_recall_checked_at null)", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1", { blindspot_recall_checked_at: null })]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops an archived row", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1", { is_archived: true })]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a story older than 72h", () => {
    const bundles = [
      bsBundle("c1", {
        dominantZone: "iktidar",
        dominantPct: 0.9,
        cluster: {
          id: "c1",
          title_tr: "Eski haber",
          first_published: new Date(NOW - 73 * 3600 * 1000).toISOString(),
        },
      }),
    ];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops effectiveArticleCount < 5", () => {
    const bundles = [
      bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9, effectiveArticleCount: 4 }),
    ];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a wire redistribution", () => {
    const bundles = [
      bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9, isWireRedistribution: true }),
    ];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a title that fails the KVKK eligibility gate", () => {
    const bundles = [
      bsBundle("c1", {
        dominantZone: "iktidar",
        dominantPct: 0.9,
        cluster: {
          id: "c1",
          title_tr: "17 yaşındaki çocuk gözaltına alındı",
          first_published: new Date(NOW - 6 * 3600 * 1000).toISOString(),
        },
      }),
    ];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out).toEqual([]);
  });

  it("drops a cluster already posted", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(["c1"]),
    });
    expect(out).toEqual([]);
  });

  it("orders by dominantPct desc then article_count desc, capped at SOCIAL_BLINDSPOTS_PER_TICK", () => {
    const bundles = [
      bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.7, effectiveArticleCount: 5 }),
      bsBundle("c2", { dominantZone: "iktidar", dominantPct: 0.95, effectiveArticleCount: 5 }),
      bsBundle("c3", { dominantZone: "iktidar", dominantPct: 0.95, effectiveArticleCount: 9 }),
    ];
    const fresh = new Map([
      ["c1", freshOk("c1")],
      ["c2", freshOk("c2")],
      ["c3", freshOk("c3")],
    ]);
    const out = selectBlindspotsToPost({
      bundles,
      fresh,
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out.map((b) => b.cluster.id)).toEqual(["c3", "c2"]);
    expect(out.length).toBeLessThanOrEqual(SOCIAL_BLINDSPOTS_PER_TICK);
  });

  it("a fully eligible blindspot passes every gate", () => {
    const bundles = [bsBundle("c1", { dominantZone: "iktidar", dominantPct: 0.9 })];
    const out = selectBlindspotsToPost({
      bundles,
      fresh: new Map([["c1", freshOk("c1")]]),
      health: healthyHealth(),
      nowMs: NOW,
      postedIds: new Set(),
    });
    expect(out.map((b) => b.cluster.id)).toEqual(["c1"]);
  });
});

function topBundle(
  id: string,
  overrides: Partial<SocialCandidateBundle & { isBlindspot?: boolean }> = {},
): SocialCandidateBundle & { isBlindspot?: boolean } {
  return {
    cluster: {
      id,
      title_tr: "Gündem haberi hakkında",
      first_published: new Date(NOW - 1 * 3600 * 1000).toISOString(),
    },
    sources: [
      { id: "s1", bias: "pro_government" },
      { id: "s2", bias: "gov_leaning" },
      { id: "s3", bias: "state_media" },
      { id: "s4", bias: "center" },
      { id: "s5", bias: "international" },
      { id: "s6", bias: "nationalist" },
      { id: "s7", bias: "islamist_conservative" },
      { id: "s8", bias: "opposition" },
      { id: "s9", bias: "opposition_leaning" },
      { id: "s10", bias: "pro_kurdish" },
    ],
    effectiveArticleCount: 10,
    isBlindspot: false,
    ...overrides,
  };
}

describe("selectTopStory", () => {
  it("picks the first eligible bundle in ranking order", () => {
    const bundles = [topBundle("c1"), topBundle("c2")];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out?.cluster.id).toBe("c1");
  });

  it("skips a blindspot", () => {
    const bundles = [topBundle("c1", { isBlindspot: true }), topBundle("c2")];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out?.cluster.id).toBe("c2");
  });

  it("requires sources.length >= 10", () => {
    const bundles = [topBundle("c1", { sources: topBundle("c1").sources.slice(0, 9) })];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out).toBeNull();
  });

  it("requires effectiveArticleCount >= 10", () => {
    const bundles = [topBundle("c1", { effectiveArticleCount: 9 })];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out).toBeNull();
  });

  it("requires >= 2 zones covered", () => {
    const singleZoneSources = Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      bias: "pro_government" as const,
    }));
    const bundles = [topBundle("c1", { sources: singleZoneSources })];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out).toBeNull();
  });

  it("requires first_published within 6h", () => {
    const bundles = [
      topBundle("c1", {
        cluster: {
          id: "c1",
          title_tr: "Eski gündem",
          first_published: new Date(NOW - 7 * 3600 * 1000).toISOString(),
        },
      }),
    ];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out).toBeNull();
  });

  it("requires the KVKK eligible-title gate", () => {
    const bundles = [
      topBundle("c1", {
        cluster: {
          id: "c1",
          title_tr: "Şüpheli tutuklandı",
          first_published: new Date(NOW - 1 * 3600 * 1000).toISOString(),
        },
      }),
    ];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: null,
    });
    expect(out).toBeNull();
  });

  it("skips an already-posted cluster", () => {
    const bundles = [topBundle("c1")];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(["c1"]),
      lastTopStoryAtMs: null,
    });
    expect(out).toBeNull();
  });

  it("returns null if a top story posted on this channel within the last 3h", () => {
    const bundles = [topBundle("c1")];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: NOW - 2 * 3600 * 1000,
    });
    expect(out).toBeNull();
  });

  it("allows a top story once spacing has elapsed", () => {
    const bundles = [topBundle("c1")];
    const out = selectTopStory({
      bundles,
      nowMs: NOW,
      postedIds: new Set(),
      lastTopStoryAtMs: NOW - 4 * 3600 * 1000,
    });
    expect(out?.cluster.id).toBe("c1");
  });
});
