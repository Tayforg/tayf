import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Harness adapted from blindspots-query.test.ts: Step A is a lean
// `select('id, bias_distribution')` (the stored distribution lets the share
// band be tested BEFORE any cap), Step B embeds only the survivors in batches
// of EMBED_BATCH_SIZE (50) through blindspots-query's exported fetchEmbedBatch.
// The shared fake's `clusters` resolver branches on
// `state.selectArgs[0] === 'id, bias_distribution'`.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  /** Step-A rows (id + stored bias_distribution), newest updated_at first. */
  candidates: [] as Array<{ id: string; bias_distribution: unknown }>,
  candidateError: null as { message: string } | null,
  /** The first N Step-A calls fail, later ones succeed (live-retry healing). */
  candidateFailuresRemaining: 0,
  /** id -> embedded row. */
  rowsById: new Map<string, unknown>(),
  embedError: null as { message: string } | null,
  idStates: [] as unknown[],
  embedStates: [] as unknown[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        const s = state as {
          selectArgs: unknown[];
          in: Array<{ col: string; vals: unknown[] }>;
        };
        if (s.selectArgs[0] === "id, bias_distribution") {
          fixture.idStates.push(state);
          if (fixture.candidateFailuresRemaining > 0) {
            fixture.candidateFailuresRemaining -= 1;
            return { data: null, error: { message: "transient blip" } };
          }
          if (fixture.candidateError) return { data: null, error: fixture.candidateError };
          return { data: fixture.candidates, error: null };
        }
        fixture.embedStates.push(state);
        if (fixture.embedError) return { data: null, error: fixture.embedError };
        const wantedIds = (s.in.find((f) => f.col === "id")?.vals ?? []) as string[];
        const rows = wantedIds
          .map((id) => fixture.rowsById.get(id))
          .filter((r): r is unknown => r !== undefined);
        return { data: rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

const feedHealthMock = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(),
  shouldSuppressBlindspot: vi.fn(),
}));

vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealthMock.getZoneFeedHealth,
    shouldSuppressBlindspot: feedHealthMock.shouldSuppressBlindspot,
  };
});

import { cacheLife, cacheTag } from "next/cache";
import { balanceFromZoneCounts } from "@/lib/bias/balance";
import { BLINDSPOT } from "@/lib/bias/config";
import { NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP } from "./near-blindspot-rule";
import { getNearBlindspotsSafe } from "./near-blindspots-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import type { BiasCategory, SourceKind } from "@/types";

const ORIGINAL_ENV = { ...process.env };

const NOW = Date.parse("2026-10-22T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------
// Fixture builders. Every member is category 'politika' with a unique
// content_hash and a unique source, so the feed filters (min sources, wire
// dedup, politics share) all pass and only the zone tally decides.
// ---------------------------------------------------------------------------

type MemberSpec = { bias: BiasCategory; kind?: SourceKind };

const IKTIDAR: BiasCategory = "pro_government";
const MUHALEFET: BiasCategory = "opposition";
const BAGIMSIZ: BiasCategory = "center";

function repeat(n: number, spec: MemberSpec): MemberSpec[] {
  return Array.from({ length: n }, () => spec);
}

function mkMember(clusterId: string, index: number, spec: MemberSpec) {
  const sourceId = `${clusterId}-s${index}`;
  return {
    articles: {
      id: `${clusterId}-a${index}`,
      title: `Haber ${clusterId}-${index}`,
      url: `https://example.com/${clusterId}-${index}`,
      image_url: null,
      published_at: new Date(NOW - 3 * DAY + index * 60_000).toISOString(),
      source_id: sourceId,
      category: "politika",
      content_hash: `hash-${clusterId}-${index}`,
      sources: {
        id: sourceId,
        name: `Kaynak ${sourceId}`,
        bias: spec.bias,
        kind: spec.kind ?? "outlet",
      },
    },
  };
}

/**
 * The stored bias_distribution cluster-consumer would have written for these
 * members: VOTING kinds only (outlet, wire; aggregator and niche never vote),
 * one count per member bias category.
 */
function storedDistOf(members: MemberSpec[]): Record<string, number> {
  const dist: Record<string, number> = {};
  for (const m of members) {
    const kind = m.kind ?? "outlet";
    if (kind !== "outlet" && kind !== "wire") continue;
    dist[m.bias] = (dist[m.bias] ?? 0) + 1;
  }
  return dist;
}

/** iktidar / bagimsiz / muhalefet counts as a stored bias_distribution. */
function zoneDist(iktidar: number, bagimsiz: number, muhalefet: number) {
  return { pro_government: iktidar, center: bagimsiz, opposition: muhalefet };
}

function mkRow(
  id: string,
  members: MemberSpec[],
  overrides: Partial<{
    title_tr: string;
    title_tr_neutral: string | null;
    updated_at: string;
    /** Stored bias_distribution; defaults to the voting tally of `members`. */
    stored: unknown;
  }> = {},
) {
  return {
    id,
    title_tr: overrides.title_tr ?? `Örnek başlık ${id}`,
    title_tr_neutral: overrides.title_tr_neutral ?? null,
    summary_tr: "Özet",
    bias_distribution: (overrides.stored ?? storedDistOf(members)) as unknown,
    is_blindspot: false,
    blindspot_side: null,
    article_count: members.length,
    first_published: new Date(NOW - 3 * DAY).toISOString(),
    updated_at: overrides.updated_at ?? new Date(NOW - 2 * DAY).toISOString(),
    cluster_articles: members.map((m, i) => mkMember(id, i, m)),
  };
}

/** `dom` iktidar outlets + `other` muhalefet outlets (all voting). */
function splitRow(
  id: string,
  dom: number,
  other: number,
  overrides: Parameters<typeof mkRow>[2] = {},
) {
  return mkRow(
    id,
    [...repeat(dom, { bias: IKTIDAR }), ...repeat(other, { bias: MUHALEFET })],
    overrides,
  );
}

/**
 * A candidate that survives the Step-A pre-filter (its stored distribution is
 * in band) but can never qualify live (one member), to fill batches cheaply.
 */
function mkFailingRow(id: string, overrides: Parameters<typeof mkRow>[2] = {}) {
  return mkRow(id, [{ bias: IKTIDAR }], { stored: zoneDist(7, 0, 3), ...overrides });
}

/**
 * Seeds the fixture. Step A returns every row's id + stored distribution in
 * the given (updated_at desc) order; `stepA` overrides the distribution Step A
 * sees for one id, while the embedded row keeps its own members.
 */
function seedRows(
  rows: Array<{ id: string; bias_distribution: unknown }>,
  stepA: Record<string, unknown> = {},
) {
  fixture.candidates = rows.map((r) => ({
    id: r.id,
    bias_distribution: r.id in stepA ? stepA[r.id] : r.bias_distribution,
  }));
  fixture.rowsById = new Map(rows.map((r) => [r.id, r]));
}

/** Every id the embed step asked for, across all batches, in request order. */
function embeddedIds(): string[] {
  return fixture.embedStates.flatMap((st) => {
    const f = (st as BuilderState).in.find((x) => x.col === "id");
    return (f?.vals ?? []) as string[];
  });
}

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  // Only Date is faked: the fake client resolves via microtasks.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fixture.candidates = [];
  fixture.candidateError = null;
  fixture.candidateFailuresRemaining = 0;
  fixture.rowsById = new Map();
  fixture.embedError = null;
  fixture.idStates = [];
  fixture.embedStates = [];
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  feedHealthMock.getZoneFeedHealth.mockReset();
  feedHealthMock.shouldSuppressBlindspot.mockReset();
  feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
  feedHealthMock.shouldSuppressBlindspot.mockReturnValue(false);
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

async function ids(): Promise<string[]> {
  const items = await getNearBlindspotsSafe();
  return (items ?? []).map((i) => i.id);
}

describe("getNearBlindspotsSafe Step A: lean candidate select", () => {
  it("filters on non-blindspot, non-archived, >= minSources, both first_published bounds and the updated_at bound", async () => {
    await getNearBlindspotsSafe();

    const state = fixture.idStates[0] as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.selectArgs[0]).toBe("id, bias_distribution");

    expect(state.eq).toHaveLength(2);
    expect(state.eq).toContainEqual({ col: "is_blindspot", val: false });
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });

    const weekAgo = new Date(NOW - 7 * DAY).toISOString();
    expect(state.gte).toHaveLength(3);
    expect(state.gte).toContainEqual({
      col: "article_count",
      val: BLINDSPOT.minSources,
    });
    expect(state.gte).toContainEqual({ col: "first_published", val: weekAgo });
    expect(state.gte).toContainEqual({ col: "updated_at", val: weekAgo });

    // Same 24 h feed delay as /blindspots: the absent side gets time to catch up.
    expect(state.lt).toEqual([
      {
        col: "first_published",
        val: new Date(NOW - BLINDSPOT.feedDelayHours * HOUR).toISOString(),
      },
    ]);

    expect(state.order).toEqual([{ col: "updated_at", opts: { ascending: false } }]);
    // (e) A documented safety bound, not a sample: the band is pre-tested on
    // the stored distribution, so the cap is far above any real window.
    expect(state.limit).toBe(NEAR_BLINDSPOT_CANDIDATE_SAFETY_CAP);
    expect(state.limit).toBe(1000);
  });

  it("(e) selects exactly the id and the stored bias_distribution", async () => {
    await getNearBlindspotsSafe();

    const state = fixture.idStates[0] as BuilderState;
    expect(state.selectArgs[0]).toContain("bias_distribution");
    expect(state.selectArgs[0]).toBe("id, bias_distribution");
  });

  it("with no candidates returns [] without an embed call and caches for cluster-feed", async () => {
    const items = await getNearBlindspotsSafe();
    expect(items).toEqual([]);
    expect(fixture.embedStates).toHaveLength(0);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });
});

describe("getNearBlindspotsSafe reader profile", () => {
  it("builds only capped reader clients for Step A and Step B", async () => {
    seedRows([splitRow("r1", 7, 3)]);
    await getNearBlindspotsSafe();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(2);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("fetches feed health once, with the reader profile", async () => {
    seedRows([splitRow("h1", 7, 3), splitRow("h2", 8, 3)]);
    await getNearBlindspotsSafe();
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledWith({ profile: "reader" });
  });

  it("tags the cache entry with clusters and clusters-politics", async () => {
    await getNearBlindspotsSafe();
    expect(cacheTag).toHaveBeenCalledWith("clusters", "clusters-politics");
  });
});

describe("getNearBlindspotsSafe band boundaries (live voting tally)", () => {
  it("excludes 9 of 13 (0.692), includes 7 of 10 (0.70) and 11 of 14 (0.786), excludes 8 of 10 (0.80, a blindspot)", async () => {
    seedRows([
      splitRow("below", 9, 4),
      splitRow("lower-edge", 7, 3),
      splitRow("upper-in", 11, 3),
      splitRow("is-blindspot", 8, 2),
    ]);

    const found = (await ids()).sort();

    expect(found).toEqual(["lower-edge", "upper-in"]);
  });

  it("exposes the share and the voting total on each item", async () => {
    seedRows([splitRow("lower-edge", 7, 3), splitRow("upper-in", 11, 3)]);

    const items = (await getNearBlindspotsSafe()) ?? [];
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    expect(byId["lower-edge"]?.dominantZone).toBe("iktidar");
    expect(byId["lower-edge"]?.dominantShare).toBe(0.7);
    expect(byId["lower-edge"]?.votingTotal).toBe(10);
    expect(byId["upper-in"]?.dominantShare).toBeCloseTo(11 / 14, 10);
    expect(byId["upper-in"]?.votingTotal).toBe(14);
  });

  it("excludes 3 of 4 (0.75) because the cluster has fewer than minSources sources", async () => {
    seedRows([splitRow("too-small", 3, 1)]);
    expect(await ids()).toEqual([]);
  });

  it("names the muhalefet zone when the opposition dominates", async () => {
    seedRows([splitRow("opp", 3, 7)]);
    const items = (await getNearBlindspotsSafe()) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.dominantZone).toBe("muhalefet");
    expect(items[0]?.dominantShare).toBe(0.7);
  });
});

describe("getNearBlindspotsSafe voting basis", () => {
  it("does not let 3 bagimsiz aggregators lower the share: 7 iktidar + 3 muhalefet outlets + 3 aggregators -> share 0.7, votingTotal 10", async () => {
    seedRows([
      mkRow("agg-low", [
        ...repeat(7, { bias: IKTIDAR }),
        ...repeat(3, { bias: MUHALEFET }),
        ...repeat(3, { bias: BAGIMSIZ, kind: "aggregator" }),
      ]),
    ]);

    const items = (await getNearBlindspotsSafe()) ?? [];

    expect(items).toHaveLength(1);
    expect(items[0]?.dominantShare).toBe(0.7);
    expect(items[0]?.votingTotal).toBe(10);
    // The aggregators do not vote, but they are members of the cluster: the
    // row's member count (what the cluster page prints) keeps them.
    expect(items[0]?.memberCount).toBe(13);
  });

  it("does not let 2 iktidar aggregators raise the share: 6 iktidar + 4 muhalefet outlets + 2 aggregators -> 0.6, excluded", async () => {
    seedRows([
      mkRow(
        "agg-high",
        [
          ...repeat(6, { bias: IKTIDAR }),
          ...repeat(4, { bias: MUHALEFET }),
          ...repeat(2, { bias: IKTIDAR, kind: "aggregator" }),
        ],
        // A legacy stored distribution that (wrongly) counted the aggregators
        // (8/12 = 0.67) survives the pre-filter, so the LIVE voting tally is
        // what excludes the row.
        { stored: zoneDist(8, 0, 4) },
      ),
    ]);

    expect(await ids()).toEqual([]);
  });

  it("niche sources never vote either", async () => {
    seedRows([
      mkRow("niche", [
        ...repeat(7, { bias: IKTIDAR }),
        ...repeat(3, { bias: MUHALEFET }),
        ...repeat(4, { bias: MUHALEFET, kind: "niche" }),
      ]),
    ]);

    const items = (await getNearBlindspotsSafe()) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.votingTotal).toBe(10);
    expect(items[0]?.memberCount).toBe(14);
  });
});

describe("getNearBlindspotsSafe same-source dedupe", () => {
  it("counts a source once: duplicate iktidar articles cannot lift 6 of 10 (0.6) into the band", async () => {
    const row = splitRow("dup-excl", 6, 4);
    // 4 extra, later articles from iktidar source s0..s3: 10/14 = 0.714 if
    // they were (wrongly) counted.
    for (let i = 0; i < 4; i++) {
      const base = row.cluster_articles[i]!.articles;
      row.cluster_articles.push({
        articles: {
          ...base,
          id: `dup-excl-extra${i}`,
          content_hash: `hash-dup-excl-extra${i}`,
          published_at: new Date(NOW - DAY).toISOString(),
        },
      });
    }
    // Stored as if the duplicates had been counted (10/14), so the row clears
    // the pre-filter and only the live same-source dedupe rejects it.
    row.bias_distribution = zoneDist(10, 0, 4);
    seedRows([row]);

    expect(await ids()).toEqual([]);
  });

  it("counts a source once: duplicate muhalefet articles do not push 7 of 10 (0.70) out of the band", async () => {
    const row = splitRow("dup-incl", 7, 3);
    // 3 extra articles from the first muhalefet source (index 7): 7/13 = 0.54
    // if they were (wrongly) counted.
    for (let i = 0; i < 3; i++) {
      const base = row.cluster_articles[7]!.articles;
      row.cluster_articles.push({
        articles: {
          ...base,
          id: `dup-incl-extra${i}`,
          content_hash: `hash-dup-incl-extra${i}`,
          published_at: new Date(NOW - DAY).toISOString(),
        },
      });
    }
    seedRows([row]);

    const items = (await getNearBlindspotsSafe()) ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.votingTotal).toBe(10);
    expect(items[0]?.dominantShare).toBe(0.7);
    // Members are deduped by source first, so the 3 extra articles of one
    // source are not members: 7 + 3 distinct sources = 10.
    expect(items[0]?.memberCount).toBe(10);
  });
});

describe("getNearBlindspotsSafe feed quality and health gates", () => {
  it("skips an SEO-explainer title like /blindspots does", async () => {
    seedRows([splitRow("seo", 7, 3, { title_tr: "Bakan kimdir, kaç yaşında?" })]);
    expect(await ids()).toEqual([]);
  });

  // h44-consistency-3: the SEO-explainer filter judges the headline the list
  // shows (title_tr_neutral ?? title_tr), not the stored seed title.
  describe("SEO filter runs on the served headline (h44-consistency-3)", () => {
    const SEED_SEO = "Semiha Bahçeli kimdir, Semiha Bahçeli kaç yaşında, nereli?";
    const NEUTRAL_CLEAN = "Cumhurbaşkanı Erdoğan'dan Devlet Bahçeli'ye taziye mesajı";

    it("keeps a near-blindspot whose seed title is an SEO explainer but whose served title is clean, with the served title", async () => {
      // 11 İktidar + 4 Muhalefet = 73% dominant share (inside [70, 80)).
      seedRows([
        splitRow("seo-seed-clean-served", 11, 4, {
          title_tr: SEED_SEO,
          title_tr_neutral: NEUTRAL_CLEAN,
        }),
      ]);

      const items = (await getNearBlindspotsSafe()) ?? [];

      expect(items.map((i) => i.id)).toEqual(["seo-seed-clean-served"]);
      expect(items[0]?.title).toBe(NEUTRAL_CLEAN);
      expect(items[0]?.dominantShare).toBeGreaterThanOrEqual(0.7);
      expect(items[0]?.dominantShare).toBeLessThan(0.8);
    });

    it("skips a cluster whose served (neutral) title is an SEO explainer although the seed is clean", async () => {
      seedRows([
        splitRow("clean-seed-seo-served", 11, 4, {
          title_tr: "Bakan X açıkladı",
          title_tr_neutral: "Ali Koç kimdir?",
        }),
      ]);
      expect(await ids()).toEqual([]);
    });

    it("still skips an SEO seed title when there is no neutral title", async () => {
      seedRows([
        splitRow("seo-seed-no-neutral", 11, 4, {
          title_tr: "Ali Koç kimdir?",
          title_tr_neutral: null,
        }),
      ]);
      expect(await ids()).toEqual([]);
    });
  });

  it("skips a cluster that is one wire copy amplified (passesFeedFilters wire_dedup)", async () => {
    const row = splitRow("wire", 7, 3);
    for (const ca of row.cluster_articles) ca.articles.content_hash = "same-wire-copy";
    seedRows([row]);
    expect(await ids()).toEqual([]);
  });

  it("excludes a cluster when shouldSuppressBlindspot is true for its dominant zone", async () => {
    const health = {
      iktidar: { total: 10, healthy: 9, healthyShare: 0.9, degraded: false },
      muhalefet: { total: 10, healthy: 2, healthyShare: 0.2, degraded: true },
      bagimsiz: { total: 5, healthy: 5, healthyShare: 1, degraded: false },
    };
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(health);
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (zone: string) => zone === "iktidar",
    );
    seedRows([splitRow("suppress", 7, 3), splitRow("keep", 3, 7)]);

    expect(await ids()).toEqual(["keep"]);
    expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith("iktidar", health);
    expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith("muhalefet", health);
  });

  it("fails open when feed health is unknown (null) and lets the gate decide", async () => {
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
    seedRows([splitRow("unknown-health", 7, 3)]);
    expect(await ids()).toEqual(["unknown-health"]);
    expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith("iktidar", null);
  });
});

describe("getNearBlindspotsSafe item shape", () => {
  it("title is title_tr_neutral when present, else title_tr", async () => {
    seedRows([
      splitRow("neutral", 7, 3, { title_tr_neutral: "Tarafsız başlık" }),
      splitRow("plain", 8, 3),
    ]);

    const items = (await getNearBlindspotsSafe()) ?? [];
    const byId = Object.fromEntries(items.map((i) => [i.id, i]));

    expect(byId["neutral"]?.title).toBe("Tarafsız başlık");
    expect(byId["plain"]?.title).toBe("Örnek başlık plain");
  });

  it("balance equals balanceFromZoneCounts of the voting tally", async () => {
    seedRows([splitRow("bal", 7, 3)]);

    const items = (await getNearBlindspotsSafe()) ?? [];

    const expected = balanceFromZoneCounts({ iktidar: 7, bagimsiz: 0, muhalefet: 3 });
    expect(expected).not.toBeNull();
    expect(items[0]?.balance).toEqual(expected);
  });

  it("carries the cluster's updated_at as updatedAt", async () => {
    const updated = new Date(NOW - 5 * HOUR).toISOString();
    seedRows([splitRow("ts", 7, 3, { updated_at: updated })]);

    const items = (await getNearBlindspotsSafe()) ?? [];

    expect(items[0]?.updatedAt).toBe(updated);
  });
});

describe("getNearBlindspotsSafe ordering and limit", () => {
  // (dominant, other) pairs whose share is inside [0.70, 0.80); all distinct.
  const PAIRS: Array<[number, number]> = [
    [7, 3], // 0.7000
    [12, 5], // 0.7059
    [10, 4], // 0.7143
    [18, 7], // 0.7200
    [13, 5], // 0.7222
    [8, 3], // 0.7273
    [11, 4], // 0.7333
    [14, 5], // 0.7368
    [17, 6], // 0.7391
    [9, 3], // 0.7500
    [16, 5], // 0.7619
    [13, 4], // 0.7647
    [10, 3], // 0.7692
    [11, 3], // 0.7857
    [15, 4], // 0.7895
  ];

  it("15 qualifying clusters return the 10 with the highest share, sorted by share desc", async () => {
    // Shuffle the candidate order so the sort, not Step-A order, decides.
    const order = [3, 11, 0, 14, 7, 1, 9, 5, 13, 2, 8, 12, 4, 10, 6];
    seedRows(order.map((i) => splitRow(`q${i}`, PAIRS[i]![0], PAIRS[i]![1])));

    const items = (await getNearBlindspotsSafe()) ?? [];

    expect(items).toHaveLength(10);
    const shares = items.map((i) => i.dominantShare);
    expect(shares).toEqual([...shares].sort((a, b) => b - a));
    expect(items.map((i) => i.id)).toEqual([
      "q14",
      "q13",
      "q12",
      "q11",
      "q10",
      "q9",
      "q8",
      "q7",
      "q6",
      "q5",
    ]);
  });

  it("breaks a share tie by updatedAt, newest first", async () => {
    seedRows([
      splitRow("old", 9, 3, { updated_at: new Date(NOW - 4 * DAY).toISOString() }),
      splitRow("new", 15, 5, { updated_at: new Date(NOW - 1 * HOUR).toISOString() }),
      splitRow("mid", 12, 4, { updated_at: new Date(NOW - 2 * DAY).toISOString() }),
    ]);

    expect(await ids()).toEqual(["new", "mid", "old"]);
  });

  it("processes every survivor batch (no early stop at 10): 120 qualifying candidates -> 3 batches, 10 shown, feed health fetched once", async () => {
    seedRows(Array.from({ length: 120 }, (_, i) => splitRow(`c${i}`, 7, 3)));

    const items = (await getNearBlindspotsSafe()) ?? [];

    expect(items).toHaveLength(10);
    expect(fixture.embedStates).toHaveLength(3);
    expect(
      fixture.embedStates.map((st) => (st as BuilderState).in[0]?.vals.length),
    ).toEqual([50, 50, 20]);
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
  });

  it("uses .in batches of at most 50 and walks every batch when nothing qualifies (100 survivors -> 2 batches)", async () => {
    seedRows(Array.from({ length: 100 }, (_, i) => mkFailingRow(`f${i}`)));

    const items = await getNearBlindspotsSafe();

    expect(items).toEqual([]);
    expect(fixture.embedStates).toHaveLength(2);
    for (const s of fixture.embedStates) {
      const st = s as BuilderState;
      expect(st.in[0]?.vals.length ?? 0).toBeLessThanOrEqual(50);
      expect(st.limit).toBeNull();
    }
  });

  it("a qualifying survivor beyond the first batch is still embedded and returned", async () => {
    const failing = Array.from({ length: 50 }, (_, i) => mkFailingRow(`f${i}`));
    seedRows([...failing, splitRow("late", 7, 3)]);

    expect(await ids()).toEqual(["late"]);
    expect(fixture.embedStates).toHaveLength(2);
  });

  it("(f) final order is share desc then updatedAt desc, sliced to 10, across batch boundaries", async () => {
    // 60 candidates in updated_at-desc order (r0 newest). Ranks 0-49 sit at
    // 0.70; the two strongest are in the SECOND batch (r55 = 15/4 = 0.789,
    // r57 = 11/3 = 0.786), so only a global sort puts them first.
    const at = (i: number) => ({
      updated_at: new Date(NOW - 2 * HOUR - i * 60_000).toISOString(),
    });
    const rows = Array.from({ length: 60 }, (_, i) => {
      if (i === 55) return splitRow(`r${i}`, 15, 4, at(i));
      if (i === 57) return splitRow(`r${i}`, 11, 3, at(i));
      return splitRow(`r${i}`, 7, 3, at(i));
    });
    seedRows(rows);

    expect(await ids()).toEqual([
      "r55",
      "r57",
      // the 0.70 ties: newest updatedAt first
      "r0",
      "r1",
      "r2",
      "r3",
      "r4",
      "r5",
      "r6",
      "r7",
    ]);
    expect(fixture.embedStates).toHaveLength(2);
  });
});

describe("getNearBlindspotsSafe pre-cap band test (h50-biasmath-1)", () => {
  it("(a) reaches qualifying stories far down the candidate list: 150 candidates, ranks 120/130/145 in band -> all three returned", async () => {
    const at = (i: number) => ({
      updated_at: new Date(NOW - 2 * HOUR - i * 60_000).toISOString(),
    });
    const inBand = (i: number): MemberSpec[] | null => {
      if (i === 120) return [...repeat(7, { bias: IKTIDAR }), { bias: BAGIMSIZ }, { bias: MUHALEFET }]; // 7/1/1
      if (i === 130) return [...repeat(5, { bias: IKTIDAR }), { bias: BAGIMSIZ }, { bias: MUHALEFET }]; // 5/1/1
      if (i === 145) return [...repeat(2, { bias: BAGIMSIZ }), ...repeat(5, { bias: MUHALEFET })]; // 0/2/5
      return null;
    };
    const rows = Array.from({ length: 150 }, (_, i) =>
      // 9/0/0: one-sided, a blindspot-shaped distribution, far out of band.
      mkRow(`k${i}`, inBand(i) ?? repeat(9, { bias: IKTIDAR }), at(i)),
    );
    seedRows(rows);

    const items = (await getNearBlindspotsSafe()) ?? [];

    // 7/9 = 0.778, then the two 5/7 = 0.714 ties broken by updatedAt desc.
    expect(items.map((i) => i.id)).toEqual(["k120", "k130", "k145"]);
    expect(items.map((i) => i.dominantZone)).toEqual(["iktidar", "iktidar", "muhalefet"]);
    expect(items[0]?.dominantShare).toBeCloseTo(7 / 9, 10);
    expect(items[1]?.dominantShare).toBeCloseTo(5 / 7, 10);
    expect(items[2]?.dominantShare).toBeCloseTo(5 / 7, 10);
  });

  it("(b) never requests out-of-band candidates (9/0/0, 3/3/3) from the embed step", async () => {
    seedRows([
      mkRow("one-sided-1", repeat(9, { bias: IKTIDAR })),
      splitRow("near-1", 7, 3),
      mkRow("even-1", [
        ...repeat(3, { bias: IKTIDAR }),
        ...repeat(3, { bias: BAGIMSIZ }),
        ...repeat(3, { bias: MUHALEFET }),
      ]),
      mkRow("one-sided-2", repeat(9, { bias: MUHALEFET })),
      splitRow("near-2", 3, 8),
      mkRow("even-2", [
        ...repeat(3, { bias: IKTIDAR }),
        ...repeat(3, { bias: BAGIMSIZ }),
        ...repeat(3, { bias: MUHALEFET }),
      ]),
    ]);

    const found = (await ids()).sort();

    expect(found).toEqual(["near-1", "near-2"]);
    // In updated_at (= candidate) order, survivors only.
    expect(embeddedIds()).toEqual(["near-1", "near-2"]);
  });

  it("(c) still embeds a candidate whose bias_distribution is null or unparseable (fallback)", async () => {
    const rows = ["null", "string", "empty", "junk"].map((k) => splitRow(`fb-${k}`, 7, 3));
    seedRows(rows, {
      "fb-null": null,
      "fb-string": "not a distribution",
      "fb-empty": {},
      "fb-junk": { pro_government: "seven", opposition: null },
    });

    const found = (await ids()).sort();

    expect(embeddedIds()).toEqual(["fb-null", "fb-string", "fb-empty", "fb-junk"]);
    // The live re-tally (7/3) still qualifies every one of them.
    expect(found).toEqual(["fb-empty", "fb-junk", "fb-null", "fb-string"]);
  });

  it("(d) drops a candidate whose stored distribution is in band but whose embedded members re-tally out of band", async () => {
    // Stored 7/0/3 (0.70) survives the pre-filter; the live members are 6/4.
    seedRows(
      [splitRow("drifted", 6, 4), splitRow("steady", 7, 3)],
      { drifted: zoneDist(7, 0, 3) },
    );

    expect(await ids()).toEqual(["steady"]);
    expect(embeddedIds().sort()).toEqual(["drifted", "steady"]);
  });

  it("embeds a stored 0.65 candidate (tolerance) and rejects it on the live tally, but never requests a stored 0.60", async () => {
    seedRows(
      [splitRow("edge-in", 6, 4), splitRow("edge-out", 6, 4)],
      { "edge-in": zoneDist(13, 0, 7), "edge-out": zoneDist(12, 0, 8) },
    );

    expect(await ids()).toEqual([]);
    expect(embeddedIds()).toEqual(["edge-in"]);
  });

  it("caps the survivors at 200 (newest first): 250 survivors -> the first 200 are embedded in 4 batches", async () => {
    seedRows(Array.from({ length: 250 }, (_, i) => mkFailingRow(`s${i}`)));

    expect(await getNearBlindspotsSafe()).toEqual([]);

    const requested = embeddedIds();
    expect(requested).toHaveLength(200);
    expect(requested[0]).toBe("s0");
    expect(requested[199]).toBe("s199");
    expect(requested).not.toContain("s200");
    expect(fixture.embedStates).toHaveLength(4);
  });

  it("counts the cap on survivors, not on candidates: 400 one-sided candidates then 1 near story at rank 399 is still returned", async () => {
    const rows = [
      ...Array.from({ length: 399 }, (_, i) => mkRow(`o${i}`, repeat(9, { bias: IKTIDAR }))),
      splitRow("deep", 7, 3),
    ];
    seedRows(rows);

    expect(await ids()).toEqual(["deep"]);
    expect(embeddedIds()).toEqual(["deep"]);
  });
});

describe("getNearBlindspotsSafe failure handling (never throws)", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  it("a Step-A error returns null after the live retry also fails", async () => {
    fixture.candidateError = { message: "db down" };

    await expect(getNearBlindspotsSafe()).resolves.toBeNull();

    // cached attempt + one live retry
    expect(fixture.idStates).toHaveLength(2);
  });

  it("a Step-B error returns null", async () => {
    seedRows([splitRow("x", 7, 3)]);
    fixture.embedError = { message: "embed down" };

    await expect(getNearBlindspotsSafe()).resolves.toBeNull();
  });

  it("a rejecting feed-health read returns null instead of throwing", async () => {
    seedRows([splitRow("x", 7, 3)]);
    feedHealthMock.getZoneFeedHealth.mockRejectedValue(new Error("health blew up"));

    await expect(getNearBlindspotsSafe()).resolves.toBeNull();
  });

  it("a transient Step-A blip is healed by the live retry", async () => {
    seedRows([splitRow("healed", 7, 3)]);
    fixture.candidateFailuresRemaining = 1;

    const items = await getNearBlindspotsSafe();

    expect(items?.map((i) => i.id)).toEqual(["healed"]);
  });

  it("caches a failed attempt for minutes only, exactly one cacheLife call", async () => {
    fixture.candidateError = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await getNearBlindspotsSafe();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("caches a success for cluster-feed, exactly one cacheLife call", async () => {
    seedRows([splitRow("ok", 7, 3)]);

    await getNearBlindspotsSafe();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });
});
