import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  selectGameHeadlines,
  sampleHeadlines,
  MAX_HEADLINES_PER_OUTLET,
  type GameClusterRow,
  type GameHeadline,
} from "./headline-pool";
import { GAME_ROUND_SIZE, GAME_SESSION_SIZE } from "./round-size";
import { THROTTLE_POLICY } from "@/lib/api/db-throttle";
import { zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

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
  sourceName?: string;
  sourceSlug?: string;
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
            name: overrides.sourceName ?? `Kaynak ${sourceSeq}`,
            slug: overrides.sourceSlug ?? `kaynak-${sourceSeq}`,
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

  it("collapses two headlines from the same outlet to one within one cluster", () => {
    const sameOutlet = "source-shared";
    const cluster: GameClusterRow = {
      id: "cluster-one",
      article_count: 3,
      cluster_articles: [
        makeRow({ clusterId: "cluster-one", sourceId: sameOutlet }),
        makeRow({ clusterId: "cluster-one", sourceId: sameOutlet }),
      ].flatMap((row) => row.cluster_articles ?? []),
    };

    const result = selectGameHeadlines([cluster]);

    const fromSharedOutlet = result.filter((h) => h.sourceId === sameOutlet);
    expect(fromSharedOutlet).toHaveLength(1);
    // The first article of the outlet in that cluster is the one kept.
    expect(fromSharedOutlet[0]?.articleId).toBe(cluster.cluster_articles![0]!.articles!.id);
  });

  it("keeps an outlet's headline in every cluster it appears in: outlet X in cluster 1 and cluster 2 gives 2 candidates", () => {
    const first = makeRow({ clusterId: "cluster-1", sourceId: "source-x" });
    const second = makeRow({ clusterId: "cluster-2", sourceId: "source-x" });

    const result = selectGameHeadlines([first, second]);

    expect(result).toHaveLength(2);
    expect(result.map((h) => h.clusterId)).toEqual(["cluster-1", "cluster-2"]);
    expect(new Set(result.map((h) => h.sourceId))).toEqual(new Set(["source-x"]));
  });

  it("the per-cluster outlet rule leaves the other rules in force: a stale, small or PII cluster of the same outlet adds nothing", () => {
    const fresh = makeRow({ clusterId: "cluster-1", sourceId: "source-x" });
    const stale = makeRow({
      clusterId: "cluster-2",
      sourceId: "source-x",
      publishedAt: new Date(NOW_MS - 49 * HOUR_MS).toISOString(),
    });
    const small = makeRow({ clusterId: "cluster-3", sourceId: "source-x", articleCount: 2 });
    const pii = makeRow({
      clusterId: "cluster-4",
      sourceId: "source-x",
      title: "17 yaşındaki genç kazada hayatını kaybetti",
    });

    const result = selectGameHeadlines([fresh, stale, small, pii]);

    expect(result.map((h) => h.clusterId)).toEqual(["cluster-1"]);
  });

  it("drops a headline that names its own outlet, and keeps the same title for another outlet", () => {
    const title = "CNN TÜRK Azerbaycan’da | Karabağ Zaferi’nin Yıldönümü!";
    const own = makeRow({ clusterId: "cluster-1", sourceName: "CNN Türk", title });
    const other = makeRow({ clusterId: "cluster-1", sourceName: "Halk TV", title });
    const cluster: GameClusterRow = {
      id: "cluster-1",
      article_count: 3,
      cluster_articles: [own, other].flatMap((row) => row.cluster_articles ?? []),
    };

    const result = selectGameHeadlines([cluster]);

    expect(result.map((h) => h.sourceName)).toEqual(["Halk TV"]);
  });

  it("an outlet-name leak does not use up the outlet's slot in the cluster: its later, clean headline stays", () => {
    const leaking = makeRow({
      clusterId: "cluster-1",
      sourceId: "source-cnn",
      sourceName: "CNN Türk",
      title: "Trump'ın eski kurul üyesi CNN TÜRK'te: açıklamalar",
    });
    const clean = makeRow({
      clusterId: "cluster-1",
      sourceId: "source-cnn",
      sourceName: "CNN Türk",
      title: "Trump'ın eski kurul üyesi açıklamalarda bulundu",
    });
    const cluster: GameClusterRow = {
      id: "cluster-1",
      article_count: 3,
      cluster_articles: [leaking, clean].flatMap((row) => row.cluster_articles ?? []),
    };

    const result = selectGameHeadlines([cluster]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(clean.cluster_articles![0]!.articles!.id);
  });

  it("keeps a headline whose words merely overlap the outlet name (Cumhuriyet Halk Partisi, Yeni Parti)", () => {
    const cumhuriyet = makeRow({
      sourceName: "Cumhuriyet",
      title: "Cumhuriyet Halk Partisi açıklama yaptı",
    });
    const yeniSafak = makeRow({
      sourceName: "Yeni Şafak",
      title: "Yeni Parti'den istifa etti",
    });
    const turkiye = makeRow({
      sourceName: "Türkiye Gazetesi",
      title: "Türkiye ile Azerbaycan arasında anlaşma",
    });

    const result = selectGameHeadlines([cumhuriyet, yeniSafak, turkiye]);

    expect(result).toHaveLength(3);
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

// /oyun asks "which camp is this outlet in?". That is only a fair question for
// a Turkish-language outlet whose zone is a real editorial call: an aggregator
// or niche source carries a placeholder zone, a wire source republishes, and an
// English-language outlet gives the answer away through its language alone
// (h24-pages-2). The daily mode already applied the kind rule; the practice
// pool now applies the same two rules.
describe("selectGameHeadlines -- outlet-only, Turkish-language pool", () => {
  it.each(["aggregator", "niche", "wire"] as const)(
    "drops a %s source",
    (sourceKind) => {
      const outlet = makeRow({ sourceKind: "outlet" });
      const dropped = makeRow({ sourceKind });

      const result = selectGameHeadlines([outlet, dropped]);

      expect(result).toHaveLength(1);
      expect(result[0]?.articleId).toBe(outlet.cluster_articles![0]!.articles!.id);
    },
  );

  it("normalizes a null (legacy) kind to outlet and keeps it", () => {
    const legacy = makeRow({ sourceKind: null });

    const result = selectGameHeadlines([legacy]);

    expect(result).toHaveLength(1);
    expect(result[0]?.articleId).toBe(legacy.cluster_articles![0]!.articles!.id);
  });

  it("keeps a row whose kind is absent from the embedded source", () => {
    const row = makeRow();
    delete row.cluster_articles![0]!.articles!.sources!.kind;

    expect(selectGameHeadlines([row])).toHaveLength(1);
  });

  it.each(["a-news", "hurriyet-daily-news", "daily-sabah", "trt-world", "turkiye-today"])(
    "drops the English-language outlet %s even though its kind is outlet",
    (sourceSlug) => {
      const turkish = makeRow({ sourceSlug: "sozcu" });
      const english = makeRow({ sourceSlug, sourceKind: "outlet" });

      const result = selectGameHeadlines([turkish, english]);

      expect(result).toHaveLength(1);
      expect(result[0]?.sourceSlug).toBe("sozcu");
    },
  );

  it("keeps a normal Turkish outlet", () => {
    const row = makeRow({ sourceSlug: "sozcu", sourceKind: "outlet" });

    const result = selectGameHeadlines([row]);

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceSlug).toBe("sozcu");
  });

  it("does not drop an outlet whose slug merely resembles an English one", () => {
    const result = selectGameHeadlines([
      makeRow({ sourceSlug: "a-haber" }),
      makeRow({ sourceSlug: "hurriyet" }),
      makeRow({ sourceSlug: "daily-sabah-tr" }),
    ]);

    expect(result.map((h) => h.sourceSlug)).toEqual(["a-haber", "hurriyet", "daily-sabah-tr"]);
  });

  it("an English or aggregator source does not use up its cluster: the cluster's Turkish outlets stay", () => {
    const cluster: GameClusterRow = {
      id: "cluster-mixed",
      article_count: 4,
      cluster_articles: [
        makeRow({ clusterId: "cluster-mixed", sourceSlug: "a-news" }),
        makeRow({ clusterId: "cluster-mixed", sourceKind: "aggregator" }),
        makeRow({ clusterId: "cluster-mixed", sourceSlug: "sabah" }),
        makeRow({ clusterId: "cluster-mixed", sourceSlug: "sozcu" }),
      ].flatMap((row) => row.cluster_articles ?? []),
    };

    const result = selectGameHeadlines([cluster]);

    expect(result.map((h) => h.sourceSlug)).toEqual(["sabah", "sozcu"]);
  });

  // The two new rules shrink the pool, so pin that a fixture with enough
  // eligible clusters still fills a full round: the page minimum is not lowered.
  it("sampleHeadlines still returns GAME_ROUND_SIZE headlines from 12 eligible clusters mixed with ineligible ones", () => {
    const eligible = Array.from({ length: 12 }, (_, i) =>
      makeRow({ clusterId: `eligible-${i}`, sourceSlug: `gazete-${i}` }),
    );
    const ineligible = [
      makeRow({ clusterId: "bad-aggregator", sourceKind: "aggregator" }),
      makeRow({ clusterId: "bad-niche", sourceKind: "niche" }),
      makeRow({ clusterId: "bad-wire", sourceKind: "wire" }),
      makeRow({ clusterId: "bad-a-news", sourceSlug: "a-news" }),
      makeRow({ clusterId: "bad-hdn", sourceSlug: "hurriyet-daily-news" }),
    ];

    const pool = selectGameHeadlines([...ineligible, ...eligible]);
    expect(pool).toHaveLength(12);

    for (let run = 0; run < 25; run++) {
      const drawn = sampleHeadlines(pool);

      expect(drawn).toHaveLength(GAME_ROUND_SIZE);
      expect(new Set(drawn.map((h) => h.clusterId)).size).toBe(GAME_ROUND_SIZE);
      for (const headline of drawn) {
        expect(headline.clusterId.startsWith("eligible-")).toBe(true);
      }
    }
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

  it("lets an outlet appear in each cluster it covers (the outlet rule is per cluster)", () => {
    const first = makeRow({ clusterId: "cluster-a", sourceId: "source-shared" });
    const second = makeRow({ clusterId: "cluster-b", sourceId: "source-shared" });

    const result = selectGameHeadlines([first, second]);

    expect(result).toHaveLength(2);
    expect(result.map((h) => h.clusterId)).toEqual(["cluster-a", "cluster-b"]);
  });
});

/**
 * ONE cluster row from per-member specs: the embedded-select shape for a story
 * several outlets (and wires, aggregators ...) covered, each member with its own
 * text, zone and kind. Every member is fresh and in window unless it says
 * otherwise.
 */
interface TwinMember {
  sourceId?: string;
  sourceSlug?: string;
  sourceKind?: "outlet" | "aggregator" | "wire" | "niche" | null;
  sourceActive?: boolean;
  bias: BiasCategory;
  title: string;
  publishedAt?: string;
}

function clusterOf(clusterId: string, members: readonly TwinMember[]): GameClusterRow {
  const rows = members.map((member) => makeRow({ clusterId, ...member }));
  return {
    id: clusterId,
    article_count: Math.max(3, members.length),
    cluster_articles: rows.flatMap((row) => row.cluster_articles ?? []),
  };
}

describe("selectGameHeadlines -- cross-zone twin text", () => {
  const TEXT = "Meclis'te bütçe görüşmeleri yarın başlıyor";
  // Same words, different case, different apostrophe, a final full stop.
  const TEXT_LOUD = "MECLİS’TE BÜTÇE GÖRÜŞMELERİ YARIN BAŞLIYOR.";

  it("drops an iktidar outlet and a bagimsiz outlet that ran the same text (punctuation and case differ)", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-twin", [
        { bias: "pro_government", title: TEXT },
        { bias: "center", title: TEXT_LOUD },
      ]),
    ]);

    expect(result).toEqual([]);
  });

  it("drops the twin on BOTH sides, but keeps a third outlet of the story that wrote its own text", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-twin", [
        { bias: "pro_government", title: TEXT },
        { bias: "opposition", title: TEXT_LOUD },
        { bias: "center", title: "Bütçe için Genel Kurul yarın toplanıyor" },
      ]),
    ]);

    expect(result.map((h) => h.title)).toEqual(["Bütçe için Genel Kurul yarın toplanıyor"]);
  });

  it("keeps two iktidar outlets that ran the same text (one zone: one correct answer)", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-same-zone", [
        { bias: "pro_government", title: TEXT },
        { bias: "gov_leaning", title: TEXT_LOUD },
      ]),
    ]);

    expect(result).toHaveLength(2);
    expect(new Set(result.map((h) => h.zone))).toEqual(new Set(["iktidar"]));
  });

  it("drops a bagimsiz outlet whose text an AA-like wire of another zone ran (the wire is evidence, not a candidate)", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-wire", [
        { bias: "center", title: TEXT },
        { bias: "pro_government", sourceKind: "wire", sourceSlug: "anadolu-ajansi", title: TEXT_LOUD },
      ]),
    ]);

    expect(result).toEqual([]);
  });

  it("keeps a bagimsiz outlet when only an aggregator of another zone ran the same text", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-aggregator", [
        { bias: "center", title: TEXT },
        { bias: "pro_government", sourceKind: "aggregator", title: TEXT },
      ]),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.zone).toBe("bagimsiz");
  });

  it("keeps a bagimsiz outlet when only a niche source of another zone ran the same text", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-niche", [
        { bias: "center", title: TEXT },
        { bias: "opposition", sourceKind: "niche", title: TEXT },
      ]),
    ]);

    expect(result).toHaveLength(1);
  });

  it("keeps the same text in two DIFFERENT clusters (the rule is per cluster)", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-a", [
        { bias: "pro_government", title: TEXT },
        { bias: "center", title: "Bütçe için Genel Kurul yarın toplanıyor" },
      ]),
      clusterOf("cluster-b", [{ bias: "center", title: TEXT_LOUD }]),
    ]);

    expect(result.map((h) => h.clusterId).sort()).toEqual(["cluster-a", "cluster-a", "cluster-b"]);
    expect(result.some((h) => h.clusterId === "cluster-a" && h.title === TEXT)).toBe(true);
    expect(result.some((h) => h.clusterId === "cluster-b" && h.title === TEXT_LOUD)).toBe(true);
  });

  it("gives an outlet whose FIRST headline is a twin its SECOND, clean headline of the cluster", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-second", [
        { sourceId: "source-bagimsiz", bias: "center", title: TEXT },
        { sourceId: "source-bagimsiz", bias: "center", title: "Bütçe için Genel Kurul yarın toplanıyor" },
        { bias: "pro_government", title: TEXT_LOUD },
      ]),
    ]);

    expect(result.map((h) => [h.sourceId, h.title])).toEqual([
      ["source-bagimsiz", "Bütçe için Genel Kurul yarın toplanıyor"],
    ]);
  });

  it("counts a sibling outside the 48 h window, an inactive sibling and an English-language sibling as evidence", () => {
    const stale = new Date(NOW_MS - 100 * HOUR_MS).toISOString();
    const outsideWindow = selectGameHeadlines([
      clusterOf("cluster-stale", [
        { bias: "center", title: TEXT },
        { bias: "pro_government", title: TEXT_LOUD, publishedAt: stale },
      ]),
    ]);
    const inactive = selectGameHeadlines([
      clusterOf("cluster-inactive", [
        { bias: "center", title: TEXT },
        { bias: "opposition", title: TEXT_LOUD, sourceActive: false },
      ]),
    ]);
    const english = selectGameHeadlines([
      clusterOf("cluster-english", [
        { bias: "center", title: TEXT },
        { bias: "pro_government", title: TEXT_LOUD, sourceSlug: "daily-sabah" },
      ]),
    ]);

    expect(outsideWindow).toEqual([]);
    expect(inactive).toEqual([]);
    expect(english).toEqual([]);
  });

  it("treats a legacy null kind as an outlet, so it counts as evidence", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-legacy", [
        { bias: "center", title: TEXT },
        { bias: "opposition", sourceKind: null, title: TEXT_LOUD },
      ]),
    ]);

    expect(result).toEqual([]);
  });

  it("sees through a breaking-news prefix", () => {
    const result = selectGameHeadlines([
      clusterOf("cluster-prefix", [
        { bias: "center", title: `SON DAKİKA: ${TEXT}` },
        { bias: "pro_government", title: TEXT },
      ]),
    ]);

    expect(result).toEqual([]);
  });

  it("a member without a source or an article is no evidence and does not throw", () => {
    const cluster = clusterOf("cluster-holes", [
      { bias: "center", title: TEXT },
      { bias: "pro_government", title: "Başka bir haber metni burada" },
    ]);
    cluster.cluster_articles = [
      ...(cluster.cluster_articles ?? []),
      { articles: null },
      {
        articles: {
          id: "article-no-source",
          title: TEXT_LOUD,
          published_at: new Date(NOW_MS - HOUR_MS).toISOString(),
          source_id: "source-missing",
          sources: null,
        },
      },
    ];

    expect(selectGameHeadlines([cluster]).map((h) => h.title)).toEqual([
      TEXT,
      "Başka bir haber metni burada",
    ]);
  });

  it("an empty-looking title is never a twin of another empty-looking title", () => {
    // The PII and outlet-name rules do not look at empty titles; the key must not
    // turn two of them into a twin pair that removes a real candidate.
    const result = selectGameHeadlines([
      clusterOf("cluster-empty", [
        { bias: "center", title: "!!!" },
        { bias: "pro_government", title: "..." },
      ]),
    ]);

    expect(result).toHaveLength(2);
  });

  it("the pool stays most of its size on a realistic mix: only the twin pair of a story is lost", () => {
    const clusters = Array.from({ length: 10 }, (_, i) =>
      clusterOf(`cluster-${i}`, [
        { bias: "pro_government", title: `Birinci kaynağın ${i}. özgün başlığı budur` },
        { bias: "center", title: `İkinci kaynağın ${i}. özgün başlığı budur` },
        { bias: "opposition", title: i === 0 ? `Birinci kaynağın 0. özgün başlığı budur` : `Üçüncü kaynağın ${i}. özgün başlığı budur` },
      ]),
    );

    // Cluster 0 loses the iktidar and muhalefet twin pair; the other nine keep all three.
    expect(selectGameHeadlines(clusters)).toHaveLength(1 + 9 * 3);
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

// A draw must never hold two headlines of the same story. The pool keeps every
// outlet's headline in every cluster (the outlet rule is per cluster), so the
// one-per-cluster rule is applied per draw: which outlet represents a cluster is
// random, and the zone rotation (below) keeps any zone from getting extra weight.
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
    // Each zone words the story its own way: three outlets of three zones with
    // one text are twins and none would be a candidate (see the twin-text tests).
    const candidates = selectGameHeadlines([
      {
        id: "cluster-zones",
        article_count: 3,
        cluster_articles: [
          makeRow({ bias: "pro_government", title: "Hükümet bütçe teklifini Meclis'e sundu" }),
          makeRow({ bias: "center", title: "Bütçe teklifi Meclis Başkanlığına verildi" }),
          makeRow({ bias: "opposition", title: "Muhalefet yeni bütçeyi eleştirdi" }),
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

// ---------------------------------------------------------------------------
// Zone balance. With the outlet rule per cluster, one random member per cluster
// weights each zone by how many of its outlets cover the story: the live pool
// (23 iktidar, 22 bağımsız, 15 muhalefet outlets) drew 46.5 / 23.0 / 30.5 %.
// The sampler therefore rotates over the zones instead of shuffling the pool.
// ---------------------------------------------------------------------------

/** Deterministic rng (mulberry32), so the statistical tests below cannot flake. */
function seededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const ZONE_NAMES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
const OUTLETS_PER_ZONE: readonly number[] = [23, 22, 15];

/** Builds one candidate; `outletKey` is the outlet's id within the fixture. */
function candidate(
  clusterId: string,
  zone: MediaDnaZone,
  outletKey: string,
  index: number,
): GameHeadline {
  return {
    articleId: `article-${clusterId}-${index}`,
    clusterId,
    sourceId: outletKey,
    title: `Başlık ${clusterId} ${index}`,
    sourceName: outletKey,
    sourceSlug: outletKey,
    bias: zone === "iktidar" ? "pro_government" : zone === "muhalefet" ? "opposition" : "center",
    zone,
  };
}

/**
 * 60 clusters with 1..4 candidates each (sizes cycle 1,2,4,3,2 = 12 per 5
 * clusters, 144 candidates). `zonePattern` deals the 144 candidate slots to the
 * three zones in a 4-slot cycle, so the zone totals are exactly 2:1:1 for
 * [0,1,0,2] and 1:2:1 for [1,0,1,2]. Each zone rotates through 23 / 22 / 15
 * distinct outlets; a cluster never holds one outlet twice.
 */
function zoneFixture(zonePattern: readonly number[]): GameHeadline[] {
  const sizes = [1, 2, 4, 3, 2];
  const perZoneCounter = [0, 0, 0];
  const out: GameHeadline[] = [];
  let slot = 0;
  for (let c = 0; c < 60; c++) {
    const size = sizes[c % sizes.length] as number;
    for (let i = 0; i < size; i++) {
      const z = zonePattern[slot % zonePattern.length] as number;
      const outlet = perZoneCounter[z] as number;
      perZoneCounter[z] = outlet + 1;
      out.push(
        candidate(
          `cluster-${c}`,
          ZONE_NAMES[z] as MediaDnaZone,
          `outlet-${ZONE_NAMES[z]}-${outlet % (OUTLETS_PER_ZONE[z] as number)}`,
          i,
        ),
      );
      slot++;
    }
  }
  return out;
}

function zoneCounts(items: readonly GameHeadline[]): Record<MediaDnaZone, number> {
  const counts: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  for (const item of items) counts[item.zone] += 1;
  return counts;
}

describe("sampleHeadlines -- zone balance", () => {
  const FIXTURES: ReadonlyArray<readonly [string, readonly number[], readonly number[]]> = [
    ["2:1:1", [0, 1, 0, 2], [72, 36, 36]],
    ["1:2:1", [1, 0, 1, 2], [36, 72, 36]],
  ];

  it.each(FIXTURES)(
    "fixture %s: 60 clusters of 1-4 candidates, 23/22/15 outlets, zone totals in the stated ratio",
    (_name, pattern, expectedTotals) => {
      const fixture = zoneFixture(pattern);

      expect(new Set(fixture.map((h) => h.clusterId)).size).toBe(60);
      const perCluster = new Map<string, number>();
      for (const h of fixture) perCluster.set(h.clusterId, (perCluster.get(h.clusterId) ?? 0) + 1);
      expect(Math.min(...perCluster.values())).toBe(1);
      expect(Math.max(...perCluster.values())).toBe(4);
      const totals = zoneCounts(fixture);
      expect([totals.iktidar, totals.bagimsiz, totals.muhalefet]).toEqual([...expectedTotals]);
      for (const [z, zone] of ZONE_NAMES.entries()) {
        const outlets = new Set(fixture.filter((h) => h.zone === zone).map((h) => h.sourceId));
        expect(outlets.size).toBe(OUTLETS_PER_ZONE[z]);
      }
      // No cluster holds one outlet twice (the shape selectGameHeadlines returns).
      const pairs = new Set(fixture.map((h) => `${h.clusterId}|${h.sourceId}`));
      expect(pairs.size).toBe(fixture.length);
    },
  );

  it.each(FIXTURES)(
    "fixture %s: 2,000 draws of 30 all have length 30 and each zone holds 0.30-0.37 of the first 10 headlines",
    (_name, pattern) => {
      const fixture = zoneFixture(pattern);
      const rng = seededRng(20261108);
      const firstTen: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
      const session: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
      const DRAWS = 2000;

      for (let draw = 0; draw < DRAWS; draw++) {
        const result = sampleHeadlines(fixture, 30, rng);
        expect(result).toHaveLength(30);
        for (const h of result.slice(0, 10)) firstTen[h.zone] += 1;
        for (const h of result) session[h.zone] += 1;
      }

      for (const zone of ZONE_NAMES) {
        const share = firstTen[zone] / (DRAWS * 10);
        expect(share, `${zone} share of the first 10`).toBeGreaterThanOrEqual(0.3);
        expect(share, `${zone} share of the first 10`).toBeLessThanOrEqual(0.37);
        // The whole 30-headline session is balanced too.
        const sessionShare = session[zone] / (DRAWS * 30);
        expect(sessionShare, `${zone} share of the session`).toBeGreaterThanOrEqual(0.3);
        expect(sessionShare, `${zone} share of the session`).toBeLessThanOrEqual(0.37);
      }
    },
  );

  it("the zone at position 0 varies across draws", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);
    const rng = seededRng(7);
    const first = new Set<MediaDnaZone>();
    for (let draw = 0; draw < 1000; draw++) {
      first.add((sampleHeadlines(fixture, 30, rng)[0] as GameHeadline).zone);
    }
    expect(first).toEqual(new Set(ZONE_NAMES));
  });

  it("the draw is shuffled at the end: zones do not follow the rotation order", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);
    const rng = seededRng(13);
    let sameZoneNeighbours = 0;
    const patterns = new Set<string>();
    for (let draw = 0; draw < 300; draw++) {
      const result = sampleHeadlines(fixture, 30, rng);
      if (result[0]?.zone === result[1]?.zone) sameZoneNeighbours += 1;
      patterns.add(result.slice(0, 6).map((h) => h.zone[0]).join(""));
    }
    // A strict rotation never puts two neighbours in one zone and has only 6
    // possible 6-long zone patterns; a shuffle of 10/10/10 does neither.
    expect(sameZoneNeighbours).toBeGreaterThan(50);
    expect(patterns.size).toBeGreaterThan(6);
  });

  it("a draw of 10 is balanced too: zone counts differ by at most one", () => {
    // limit 10 = 4/3/3 in some order: the rotation, not the pool shares, decides.
    const fixture = zoneFixture([0, 1, 0, 2]);
    const rng = seededRng(99);
    for (let draw = 0; draw < 500; draw++) {
      const counts = zoneCounts(sampleHeadlines(fixture, 10, rng));
      const values = Object.values(counts);
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      expect(values.reduce((a, b) => a + b, 0)).toBe(10);
    }
  });
});

describe("sampleHeadlines -- invariants over 1,000 draws", () => {
  it("no clusterId appears twice and no outlet more than MAX_HEADLINES_PER_OUTLET times", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);
    const rng = seededRng(31337);

    for (let draw = 0; draw < 1000; draw++) {
      const result = sampleHeadlines(fixture, 30, rng);

      expect(new Set(result.map((h) => h.clusterId)).size).toBe(result.length);
      const perOutlet = new Map<string, number>();
      for (const h of result) perOutlet.set(h.sourceId, (perOutlet.get(h.sourceId) ?? 0) + 1);
      expect(Math.max(...perOutlet.values())).toBeLessThanOrEqual(MAX_HEADLINES_PER_OUTLET);
    }
  });

  it("MAX_HEADLINES_PER_OUTLET is 1", () => {
    expect(MAX_HEADLINES_PER_OUTLET).toBe(1);
  });

  it("three 30-headline loads a day stay under /api/oyun's per-outlet throttle (3 guesses per client per outlet per day)", () => {
    // The throttle silently drops a guess past THROTTLE_POLICY.oyunSourceLimit,
    // so a player who reloads the game must not be served one outlet more often
    // than that: MAX per load x 3 loads has to fit the limit.
    expect(MAX_HEADLINES_PER_OUTLET * 3).toBeLessThanOrEqual(THROTTLE_POLICY.oyunSourceLimit);
  });

  it("the outlet cap binds: 3 zones x 2 outlets x 20 clusters gives 3 x 2 x MAX_HEADLINES_PER_OUTLET headlines, exactly MAX per outlet, never padded", () => {
    const fixture: GameHeadline[] = [];
    for (const zone of ZONE_NAMES) {
      for (let c = 0; c < 20; c++) {
        fixture.push(candidate(`cluster-${zone}-${c}`, zone, `outlet-${zone}-${c % 2}`, 0));
      }
    }
    const rng = seededRng(5);

    for (let draw = 0; draw < 1000; draw++) {
      const result = sampleHeadlines(fixture, 30, rng);

      expect(result).toHaveLength(3 * 2 * MAX_HEADLINES_PER_OUTLET);
      const perOutlet = new Map<string, number>();
      for (const h of result) perOutlet.set(h.sourceId, (perOutlet.get(h.sourceId) ?? 0) + 1);
      expect(perOutlet.size).toBe(6);
      for (const count of perOutlet.values()) expect(count).toBe(MAX_HEADLINES_PER_OUTLET);
    }
  });

  it("fewer usable clusters than the limit: a shorter list, never padded with a second headline of a cluster", () => {
    const fixture = zoneFixture([0, 1, 0, 2]).filter((h) => {
      const n = Number(h.clusterId.replace("cluster-", ""));
      return n < 7;
    });
    expect(new Set(fixture.map((h) => h.clusterId)).size).toBe(7);
    const rng = seededRng(11);

    for (let draw = 0; draw < 1000; draw++) {
      const result = sampleHeadlines(fixture, 30, rng);

      expect(result).toHaveLength(7);
      expect(new Set(result.map((h) => h.clusterId)).size).toBe(7);
    }
  });

  it("a zone with a single cluster still appears, exactly once per draw", () => {
    const fixture: GameHeadline[] = [];
    for (let c = 0; c < 40; c++) {
      fixture.push(candidate(`ik-${c}`, "iktidar", `ik-outlet-${c % 20}`, 0));
      fixture.push(candidate(`bg-${c}`, "bagimsiz", `bg-outlet-${c % 20}`, 0));
    }
    // The lone muhalefet cluster is covered by three outlets: one of them is drawn.
    fixture.push(candidate("mh-only", "muhalefet", "mh-outlet-a", 0));
    fixture.push(candidate("mh-only", "muhalefet", "mh-outlet-b", 1));
    fixture.push(candidate("mh-only", "muhalefet", "mh-outlet-c", 2));
    const rng = seededRng(21);

    const seenOutlets = new Set<string>();
    for (let draw = 0; draw < 1000; draw++) {
      const result = sampleHeadlines(fixture, 30, rng);

      expect(result).toHaveLength(30);
      const muhalefet = result.filter((h) => h.zone === "muhalefet");
      expect(muhalefet).toHaveLength(1);
      seenOutlets.add((muhalefet[0] as GameHeadline).sourceId);
    }
    expect(seenOutlets.size).toBe(3);
  });

  it("a single zone is enough: the draw is just that zone's clusters, one per cluster", () => {
    const fixture = Array.from({ length: 12 }, (_, c) =>
      candidate(`only-${c}`, "bagimsiz", `outlet-${c}`, 0),
    );

    const result = sampleHeadlines(fixture, 10, seededRng(3));

    expect(result).toHaveLength(10);
    expect(new Set(result.map((h) => h.zone))).toEqual(new Set(["bagimsiz"]));
  });

  it("keeps the `clusterId || articleId` fallback key: candidates without a clusterId dedupe per article", () => {
    const base = zoneFixture([0, 1, 0, 2]).map((h) => ({ ...h, clusterId: "" }));
    const rng = seededRng(41);

    for (let draw = 0; draw < 200; draw++) {
      const result = sampleHeadlines(base, 30, rng);

      expect(result).toHaveLength(30);
      expect(new Set(result.map((h) => h.articleId)).size).toBe(30);
    }
  });

  it("an empty clusterId does not collapse the pool to one headline", () => {
    const stale = [
      candidate("", "iktidar", "outlet-a", 0),
      candidate("", "bagimsiz", "outlet-b", 1),
      candidate("", "muhalefet", "outlet-c", 2),
    ];

    expect(sampleHeadlines(stale, 30, seededRng(1))).toHaveLength(3);
  });

  it("limit 0 and an empty pool return an empty list", () => {
    expect(sampleHeadlines(zoneFixture([0, 1, 0, 2]), 0, seededRng(1))).toEqual([]);
    expect(sampleHeadlines([], 30, seededRng(1))).toEqual([]);
  });

  it("does not mutate or reorder the candidate list", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);
    const before = fixture.map((h) => h.articleId);
    const frozen = Object.freeze([...fixture]);

    sampleHeadlines(frozen, 30, seededRng(2));

    expect(fixture.map((h) => h.articleId)).toEqual(before);
  });

  it("returns only candidates it was given, each at most once", () => {
    const fixture = zoneFixture([1, 0, 1, 2]);
    const ids = new Set(fixture.map((h) => h.articleId));

    const result = sampleHeadlines(fixture, 30, seededRng(8));

    expect(new Set(result.map((h) => h.articleId)).size).toBe(result.length);
    for (const h of result) expect(ids.has(h.articleId)).toBe(true);
  });
});

describe("sampleHeadlines -- rng parameter", () => {
  it("defaults to Math.random: the two-argument call keeps working and varies", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);

    const draws = new Set<string>();
    for (let i = 0; i < 20; i++) {
      draws.add(
        sampleHeadlines(fixture, 30)
          .map((h) => h.articleId)
          .join(","),
      );
    }

    expect(draws.size).toBeGreaterThan(1);
  });

  it("uses the injected rng for every random choice and never touches Math.random", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);
    const spy = vi.spyOn(Math, "random");
    try {
      sampleHeadlines(fixture, 30, seededRng(4));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("the same seed gives the same draw; another seed gives another", () => {
    const fixture = zoneFixture([0, 1, 0, 2]);
    const ids = (seed: number) =>
      sampleHeadlines(fixture, 30, seededRng(seed)).map((h) => h.articleId);

    expect(ids(123)).toEqual(ids(123));
    expect(ids(123)).not.toEqual(ids(124));
  });

  it.each([0, 0.5, 0.999999999])("a constant rng of %s still returns a valid, full draw", (value) => {
    const fixture = zoneFixture([0, 1, 0, 2]);

    const result = sampleHeadlines(fixture, 30, () => value);

    expect(result).toHaveLength(30);
    expect(new Set(result.map((h) => h.clusterId)).size).toBe(30);
  });

  it("handles a large pool (12,000 candidates in 4,000 clusters) in one call", () => {
    const big: GameHeadline[] = [];
    for (let c = 0; c < 4000; c++) {
      for (let k = 0; k < 3; k++) {
        const z = (c + k) % 3;
        big.push(candidate(`big-${c}`, ZONE_NAMES[z] as MediaDnaZone, `o-${z}-${(c * 3 + k) % 40}`, k));
      }
    }

    const result = sampleHeadlines(big, 30, seededRng(77));

    expect(result).toHaveLength(30);
    expect(new Set(result.map((h) => h.clusterId)).size).toBe(30);
  });
});

describe("headline-pool source guard", () => {
  const source = readFileSync(resolve(__dirname, "headline-pool.ts"), "utf8");

  it("uses the shared outlet-name rule from outlet-leak.ts, after the PII check", () => {
    expect(source).toContain('import { titleNamesOutlet } from "./outlet-leak";');
    expect(source).toContain("if (titleNamesOutlet(article.title, source)) continue;");
    expect(source.indexOf("isGameEligibleTitle(article.title)")).toBeLessThan(
      source.indexOf("titleNamesOutlet(article.title, source)"),
    );
    // The daily mode's substring rule must not be used for the practice pool.
    expect(source).not.toContain("titleLeaksOutlet");
    expect(source).not.toContain("daily-set");
  });


  it("applies the twin-text rule after the PII and outlet-name checks and BEFORE the outlet is marked seen", () => {
    expect(source).toContain('import { crossZoneTwinKeys, twinKey } from "./title-twin";');
    const twinAt = source.indexOf("if (twins.has(twinKey(article.title))) continue;");
    expect(twinAt).toBeGreaterThan(-1);
    expect(source.indexOf("if (titleNamesOutlet(article.title, source)) continue;")).toBeLessThan(twinAt);
    expect(twinAt).toBeLessThan(source.indexOf("seenSourceIds.add(source.id)"));
  });

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

  it("applies the outlet-only and English-source rules from the shared modules", () => {
    expect(source).toContain('import { ENGLISH_SOURCE_SLUGS } from "@/lib/sources/source-language";');
    expect(source).toContain('if (sourceKindOf({ kind: source.kind ?? undefined }) !== "outlet") continue;');
    expect(source).toContain("if (ENGLISH_SOURCE_SLUGS.has(source.slug)) continue;");
    // The old wire-only rule must not linger next to the new one.
    expect(source).not.toContain('=== "wire") continue;');
  });

  it("source-language.ts has no imports at all (it is safe for this module to depend on)", () => {
    const language = readFileSync(resolve(__dirname, "../sources/source-language.ts"), "utf8");
    for (const line of language.split("\n")) {
      expect(line.trimStart().startsWith("import "), line).toBe(false);
    }
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
