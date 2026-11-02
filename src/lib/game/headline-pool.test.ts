import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  selectGameHeadlines,
  sampleHeadlines,
  type GameClusterRow,
  type GameHeadline,
} from "./headline-pool";
import { GAME_ROUND_SIZE, GAME_SESSION_SIZE } from "./round-size";
import { zoneOf } from "@/lib/bias/config";
import type { BiasCategory } from "@/types";

const NOW_MS = new Date("2026-09-18T12:00:00.000Z").getTime();
const HOUR_MS = 3_600_000;

let sourceSeq = 0;
let articleSeq = 0;
let clusterSeq = 0;

function makeRow(overrides: {
  clusterId?: string;
  articleCount?: number;
  publishedAt?: string;
  sourceId?: string;
  sourceKind?: "outlet" | "aggregator" | "wire" | "niche" | null;
  sourceActive?: boolean;
  bias?: BiasCategory;
  title?: string;
  articleId?: string;
} = {}): GameClusterRow {
  sourceSeq += 1;
  articleSeq += 1;
  clusterSeq += 1;
  const sourceId = overrides.sourceId ?? `source-${sourceSeq}`;
  return {
    id: overrides.clusterId ?? `cluster-${clusterSeq}`,
    article_count: overrides.articleCount ?? 3,
    cluster_articles: [
      {
        articles: {
          id: overrides.articleId ?? `article-${articleSeq}`,
          title: overrides.title ?? "Merkez Bankası faiz kararını bugün açıklayacak",
          published_at:
            overrides.publishedAt ?? new Date(NOW_MS - HOUR_MS).toISOString(),
          source_id: sourceId,
          sources: {
            id: sourceId,
            name: `Kaynak ${sourceSeq}`,
            slug: `kaynak-${sourceSeq}`,
            bias: overrides.bias ?? "center",
            kind: overrides.sourceKind === undefined ? "outlet" : overrides.sourceKind,
            active: overrides.sourceActive ?? true,
          },
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("selectGameHeadlines", () => {
  it("returns [] rather than throwing on empty input", () => {
    expect(selectGameHeadlines([])).toEqual([]);
  });

  it("drops rows whose article is older than 48h", () => {
    const fresh = makeRow({ publishedAt: new Date(NOW_MS - HOUR_MS).toISOString() });
    const stale = makeRow({ publishedAt: new Date(NOW_MS - 49 * HOUR_MS).toISOString() });

    const result = selectGameHeadlines([fresh, stale]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(fresh.cluster_articles![0]!.articles!.id);
  });

  it("drops clusters with article_count < 3", () => {
    const eligible = makeRow({ articleCount: 3 });
    const tooSmall = makeRow({ articleCount: 2 });

    const result = selectGameHeadlines([eligible, tooSmall]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(eligible.cluster_articles![0]!.articles!.id);
  });

  it("drops a wire-kind source", () => {
    const outlet = makeRow({ sourceKind: "outlet" });
    const wire = makeRow({ sourceKind: "wire" });

    const result = selectGameHeadlines([outlet, wire]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(outlet.cluster_articles![0]!.articles!.id);
  });

  it("drops an inactive source", () => {
    const active = makeRow({ sourceActive: true });
    const inactive = makeRow({ sourceActive: false });

    const result = selectGameHeadlines([active, inactive]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(active.cluster_articles![0]!.articles!.id);
  });

  it("collapses two headlines from the same outlet to one", () => {
    const sameOutlet = "source-shared";
    const first = makeRow({ sourceId: sameOutlet });
    const second = makeRow({ sourceId: sameOutlet });

    const result = selectGameHeadlines([first, second]);

    const fromSharedOutlet = result.filter((h) => h.sourceId === sameOutlet);
    expect(fromSharedOutlet).toHaveLength(1);
  });

  it("drops a PII-matching headline even when everything else passes", () => {
    const clean = makeRow({ title: "Merkez Bankası faiz kararını bugün açıklayacak" });
    const pii = makeRow({ title: "17 yaşındaki genç kazada hayatını kaybetti" });

    const result = selectGameHeadlines([clean, pii]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(clean.cluster_articles![0]!.articles!.id);
  });

  it("does not cap the result -- returns every eligible candidate", () => {
    const rows = Array.from({ length: 15 }, () => makeRow());

    const result = selectGameHeadlines(rows);

    expect(result).toHaveLength(15);
  });

  it("every returned item carries a zone consistent with zoneOf(bias)", () => {
    const biases: BiasCategory[] = ["pro_government", "center", "opposition"];
    const rows = biases.map((bias) => makeRow({ bias }));

    const result = selectGameHeadlines(rows);

    expect(result.length).toBeGreaterThan(0);
    for (const item of result) {
      expect(item.zone).toBe(zoneOf(item.bias));
    }
  });

  it("handles a cluster with no articles gracefully", () => {
    const empty: GameClusterRow = { id: "cluster-empty", article_count: 3, cluster_articles: [] };

    expect(selectGameHeadlines([empty])).toEqual([]);
  });

  it("handles a null cluster_articles list gracefully", () => {
    const empty: GameClusterRow = { id: "cluster-null", article_count: 3, cluster_articles: null };

    expect(selectGameHeadlines([empty])).toEqual([]);
  });

  it("handles a null embedded source gracefully", () => {
    const row: GameClusterRow = {
      id: "cluster-orphan",
      article_count: 3,
      cluster_articles: [
        {
          articles: {
            id: "orphan-article",
            title: "Bir haber başlığı",
            published_at: new Date(NOW_MS - HOUR_MS).toISOString(),
            source_id: "missing-source",
            sources: null,
          },
        },
      ],
    };

    expect(selectGameHeadlines([row])).toEqual([]);
  });
});

/**
 * ONE cluster row that holds `outlets` articles, each from its own outlet:
 * the shape the embedded select returns for a story many outlets covered.
 */
function makeCluster(clusterId: string, outlets: number, bias?: BiasCategory): GameClusterRow {
  const rows = Array.from({ length: outlets }, () => makeRow({ clusterId, bias }));
  return {
    id: clusterId,
    article_count: Math.max(3, outlets),
    cluster_articles: rows.flatMap((row) => row.cluster_articles ?? []),
  };
}

describe("selectGameHeadlines -- cluster id", () => {
  it("carries the cluster's id onto every headline as clusterId", () => {
    const row = makeRow({ clusterId: "cluster-abc" });

    const result = selectGameHeadlines([row]);

    expect(result).toHaveLength(1);
    expect(result[0]?.clusterId).toBe("cluster-abc");
  });

  it("keeps all three outlets of one cluster in the pool (only the outlet rule applies here)", () => {
    const result = selectGameHeadlines([makeCluster("cluster-x", 3)]);

    expect(result).toHaveLength(3);
    expect(new Set(result.map((h) => h.clusterId))).toEqual(new Set(["cluster-x"]));
    expect(new Set(result.map((h) => h.sourceId)).size).toBe(3);
  });

  it("still lets an outlet appear once across clusters (the outlet rule is unchanged)", () => {
    const first = makeRow({ clusterId: "cluster-a", sourceId: "source-shared" });
    const second = makeRow({ clusterId: "cluster-b", sourceId: "source-shared" });

    const result = selectGameHeadlines([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0]?.clusterId).toBe("cluster-a");
  });
});

// MF-09: randomisation must not run inside the cached `getGameHeadlines`
// call graph (one draw would be reused by every visitor for the whole
// cache window). `sampleHeadlines` is the per-request piece that does the
// shuffle + cap instead.
describe("sampleHeadlines", () => {
  function makeHeadlines(n: number): ReturnType<typeof selectGameHeadlines> {
    const rows = Array.from({ length: n }, () => makeRow());
    return selectGameHeadlines(rows);
  }

  it("caps the result at `limit`", () => {
    const candidates = makeHeadlines(15);

    const result = sampleHeadlines(candidates, 5);

    expect(result).toHaveLength(5);
  });

  it("defaults limit to 10", () => {
    const candidates = makeHeadlines(15);

    const result = sampleHeadlines(candidates);

    expect(result).toHaveLength(10);
  });

  it("returns a permutation of its input, capped at limit -- never drops or duplicates entries", () => {
    const candidates = makeHeadlines(8);

    const result = sampleHeadlines(candidates, 100);

    expect(result).toHaveLength(candidates.length);
    expect(new Set(result.map((h) => h.articleId))).toEqual(
      new Set(candidates.map((h) => h.articleId)),
    );
  });

  it("returns [] on an empty candidate list", () => {
    expect(sampleHeadlines([])).toEqual([]);
  });
});

describe("round and session sizes", () => {
  it("a round is 10 headlines and a page session holds 30", () => {
    expect(GAME_ROUND_SIZE).toBe(10);
    expect(GAME_SESSION_SIZE).toBe(30);
  });
});

// A round must never hold two headlines of the same story. The pool keeps
// every outlet's headline (outlet rule only), so the one-per-cluster rule is
// applied per draw, on a uniform shuffle: which outlet represents a cluster
// is random and no zone gets extra weight.
describe("sampleHeadlines -- at most one headline per cluster", () => {
  function pool(clusterX: number, singles: number): GameHeadline[] {
    return selectGameHeadlines([
      makeCluster("cluster-x", clusterX),
      ...Array.from({ length: singles }, (_, i) => makeRow({ clusterId: `single-${i}` })),
    ]);
  }

  it("4 headlines of one cluster plus 12 singles: always 10 items with distinct clusterIds", () => {
    const candidates = pool(4, 12);
    expect(candidates).toHaveLength(16);

    for (let run = 0; run < 50; run++) {
      const result = sampleHeadlines(candidates, 10);

      expect(result).toHaveLength(10);
      expect(new Set(result.map((h) => h.clusterId)).size).toBe(10);
    }
  });

  it("4 headlines of one cluster plus 9 singles: exactly 10, the round size is kept", () => {
    const candidates = pool(4, 9);

    for (let run = 0; run < 50; run++) {
      const result = sampleHeadlines(candidates, 10);

      expect(result).toHaveLength(10);
      expect(new Set(result.map((h) => h.clusterId)).size).toBe(10);
    }
  });

  it("fewer distinct clusters than the limit: a shorter list, never padded with duplicates", () => {
    const candidates = pool(4, 2);

    const result = sampleHeadlines(candidates, 10);

    expect(result).toHaveLength(3);
    expect(new Set(result.map((h) => h.clusterId)).size).toBe(3);
  });

  it("which outlet represents a cluster is random: every outlet of a 3-zone cluster gets drawn", () => {
    const candidates = selectGameHeadlines([
      {
        id: "cluster-zones",
        article_count: 3,
        cluster_articles: [
          makeRow({ bias: "pro_government" }),
          makeRow({ bias: "center" }),
          makeRow({ bias: "opposition" }),
        ].flatMap((row) => row.cluster_articles ?? []),
      },
    ]);
    expect(new Set(candidates.map((h) => h.zone)).size).toBe(3);

    const drawn = new Set<string>();
    for (let run = 0; run < 600; run++) {
      const result = sampleHeadlines(candidates, 1);
      expect(result).toHaveLength(1);
      drawn.add(result[0]!.articleId);
    }

    expect(drawn).toEqual(new Set(candidates.map((h) => h.articleId)));
  });

  it("keeps working for a stale pool without clusterId: falls back to the article id", () => {
    const candidates = pool(1, 4).map((h) => ({ ...h, clusterId: "" }));

    const result = sampleHeadlines(candidates, 10);

    expect(result).toHaveLength(5);
    expect(new Set(result.map((h) => h.articleId)).size).toBe(5);
  });

  it("limit 0 returns an empty list", () => {
    expect(sampleHeadlines(pool(2, 3), 0)).toEqual([]);
  });

  it("does not mutate the candidate list", () => {
    const candidates = pool(4, 6);
    const before = candidates.map((h) => h.articleId);

    sampleHeadlines(candidates, 10);

    expect(candidates.map((h) => h.articleId)).toEqual(before);
  });
});

describe("headline-pool source guard", () => {
  const source = readFileSync(resolve(__dirname, "headline-pool.ts"), "utf8");

  it("the clusters select starts with `id, article_count`", () => {
    const selectAt = source.indexOf(".select(");
    expect(selectAt).toBeGreaterThan(-1);
    const openTick = source.indexOf("`", selectAt);
    expect(openTick).toBeGreaterThan(selectAt);
    // Nothing but whitespace may sit between `.select(` and the opening tick.
    expect(source.slice(selectAt + ".select(".length, openTick).trim()).toBe("");
    const body = source.slice(openTick + 1, source.indexOf("`", openTick + 1));
    expect(body.startsWith("id, article_count")).toBe(true);
  });

  it("the round size is the default sample limit, imported from the plain round-size module", () => {
    expect(source).toContain('import { GAME_ROUND_SIZE } from "./round-size";');
    expect(source).toContain("const DEFAULT_LIMIT = GAME_ROUND_SIZE;");
    // Defined once, in round-size.ts: a second copy here would let the client
    // game and the sampler drift apart.
    expect(source).not.toContain("export const GAME_ROUND_SIZE");
    expect(source).not.toContain("export const GAME_SESSION_SIZE");
  });

  it("round-size.ts defines both sizes and imports nothing (it is bundled into the client game)", () => {
    const sizes = readFileSync(resolve(__dirname, "round-size.ts"), "utf8");
    expect(sizes).toContain("export const GAME_ROUND_SIZE = 10;");
    expect(sizes).toContain("export const GAME_SESSION_SIZE = 30;");
    for (const line of sizes.split("\n")) {
      expect(line.trimStart().startsWith("import "), line).toBe(false);
    }
  });
});
