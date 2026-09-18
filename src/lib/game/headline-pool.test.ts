import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { selectGameHeadlines, sampleHeadlines, type GameClusterRow } from "./headline-pool";
import { zoneOf } from "@/lib/bias/config";
import type { BiasCategory } from "@/types";

const NOW_MS = new Date("2026-09-18T12:00:00.000Z").getTime();
const HOUR_MS = 3_600_000;

let sourceSeq = 0;
let articleSeq = 0;

function makeRow(overrides: {
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
  const sourceId = overrides.sourceId ?? `source-${sourceSeq}`;
  return {
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
    const empty: GameClusterRow = { article_count: 3, cluster_articles: [] };

    expect(selectGameHeadlines([empty])).toEqual([]);
  });

  it("handles a null cluster_articles list gracefully", () => {
    const empty: GameClusterRow = { article_count: 3, cluster_articles: null };

    expect(selectGameHeadlines([empty])).toEqual([]);
  });

  it("handles a null embedded source gracefully", () => {
    const row: GameClusterRow = {
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
