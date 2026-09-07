import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";
import { computeReport } from "./report.mjs";
import { MATCH_THRESHOLD } from "../cluster/constants.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = resolve(__dirname, "..", "..", "..", "tests", "fixtures", "clusters-sample.json");

// ---------------------------------------------------------------------------
// Golden numbers against the deterministic synthetic corpus
// (tests/fixtures/clusters-sample.json, built by scripts/gen-audit-fixture.mjs).
// Pins the summary numbers, NOT `samples` — sample content is real titles
// from the generator's template pool and is exercised separately below by
// shape/count rather than exact text.
// ---------------------------------------------------------------------------

describe("computeReport — golden fixture", () => {
  let fixture;
  let report;

  beforeAll(() => {
    fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    report = computeReport({
      articles: fixture.articles,
      links: fixture.links,
      sources: fixture.sources,
      hours: 48,
    });
  });

  it("matches the pinned summary numbers", () => {
    expect(report.window_hours).toBe(48);
    expect(report.article_count).toBe(250);
    expect(report.cluster_count).toBe(80);
    expect(report.singleton_rate).toBe(0.25);
    expect(report.size_histogram).toEqual({ "1": 20, "2-3": 44, "4-7": 13, "8+": 3 });
    expect(report.source_diversity).toEqual({
      avg_sources_per_multi_cluster: 3.02,
      max_sources_per_cluster: 10,
      duplicate_source_clusters: 7,
    });
    expect(report.precision_probe_count).toBe(44);
    expect(report.recall_probe_count).toBe(598);
    expect(report.blindspot_flip_rate).toBe(0.4);
  });

  it("matches the pinned diagnostic numbers (CLI-only fields)", () => {
    expect(report.unassigned_count).toBe(40);
    expect(report.intra_pairs_scored).toBe(306);
    expect(report.cross_pairs_scored).toBe(2159);
    expect(report.would_merge_component_count).toBe(10);
    expect(report.blindspot_eligible_clusters).toBe(5);
    expect(report.blindspot_flip_count).toBe(2);
  });

  it("blindspot_flip_rate equals blindspot_flip_count / blindspot_eligible_clusters", () => {
    expect(report.blindspot_flip_rate).toBe(
      report.blindspot_flip_count / report.blindspot_eligible_clusters,
    );
  });

  it("caps samples at 5 per probe and finds at least one of each (not pinned by content)", () => {
    expect(report.samples.precision.length).toBeGreaterThan(0);
    expect(report.samples.precision.length).toBeLessThanOrEqual(5);
    expect(report.samples.recall.length).toBeGreaterThan(0);
    expect(report.samples.recall.length).toBeLessThanOrEqual(5);
  });

  it("the sharpest default-window recall sample is a genuine cross-cluster near-duplicate", () => {
    // NOT the deliberately-injected clones (gen-audit-fixture.mjs step 4) —
    // the top-5 default window is dominated by incidental title collisions
    // between unrelated clusters that recycle the same headline template
    // (only 14 templates cycle across 80 clusters), which happen to tie at
    // score=1 ahead of the injected pairs. See the dedicated test below for
    // the injected near-duplicates.
    const top = report.samples.recall[0];
    expect(top.score).toBe(1);
    expect(top.shared_entities).toBe(3);
    expect(top.a.title).toBe(top.b.title);
    expect(top.a_cluster).not.toBe(top.b_cluster);
  });

  it("finds the 3 deliberately-injected near-duplicate pairs when given enough recall samples", () => {
    // gen-audit-fixture.mjs step 4 clones a donor cluster's article into a
    // receiver cluster under a different cluster_id. Those 3 pairs clear
    // MATCH_THRESHOLD but aren't the *sharpest* matches in the corpus (see
    // the test above), so the default top-5 samples don't surface them —
    // ask for every recall hit instead.
    const full = computeReport({
      articles: fixture.articles,
      links: fixture.links,
      sources: fixture.sources,
      hours: 48,
      sampleLimit: { recall: fixture.links.length },
    });
    const injectedPairs = [
      ["cl-011", "cl-031"],
      ["cl-012", "cl-032"],
      ["cl-013", "cl-033"],
    ];
    for (const [donor, receiver] of injectedPairs) {
      const hit = full.samples.recall.find(
        (s) =>
          (s.a_cluster === donor && s.b_cluster === receiver) ||
          (s.a_cluster === receiver && s.b_cluster === donor),
      );
      expect(hit).toBeDefined();
      expect(hit.score).toBeGreaterThanOrEqual(MATCH_THRESHOLD);
    }
  });

  it("is pure and deterministic — same input twice gives byte-identical JSON", () => {
    const again = computeReport({
      articles: fixture.articles,
      links: fixture.links,
      sources: fixture.sources,
      hours: 48,
    });
    expect(JSON.stringify(again)).toBe(JSON.stringify(report));
  });

  it("does not mutate its input arguments", () => {
    expect(fixture.articles[0]).not.toHaveProperty("_entities");
    expect(fixture.articles[0]).not.toHaveProperty("_fpStrict");
  });
});

// ---------------------------------------------------------------------------
// Focused unit tests on hand-built minimal inputs — isolate one concern per
// test rather than relying solely on the fixture's emergent numbers.
// ---------------------------------------------------------------------------

describe("computeReport — structural stats", () => {
  it("returns an all-zero report for empty input", () => {
    const report = computeReport({ articles: [], links: [], sources: [] });
    expect(report.article_count).toBe(0);
    expect(report.cluster_count).toBe(0);
    expect(report.singleton_rate).toBe(0);
    expect(report.size_histogram).toEqual({ "1": 0, "2-3": 0, "4-7": 0, "8+": 0 });
    expect(report.source_diversity).toEqual({
      avg_sources_per_multi_cluster: 0,
      max_sources_per_cluster: 0,
      duplicate_source_clusters: 0,
    });
    expect(report.precision_probe_count).toBe(0);
    expect(report.recall_probe_count).toBe(0);
    expect(report.blindspot_flip_rate).toBe(0);
    expect(report.samples).toEqual({ precision: [], recall: [] });
  });

  it("computes singleton_rate over clusters that have a link row, not raw article count", () => {
    // 3 articles: one pair clustered together, one lone singleton cluster.
    // singleton_rate = 1/2 clusters, regardless of the 3rd article's fate.
    const articles = [
      { id: "a1", source_id: "s1", title: "x", description: "", published_at: "2026-09-06T00:00:00Z" },
      { id: "a2", source_id: "s2", title: "x", description: "", published_at: "2026-09-06T00:00:00Z" },
      { id: "a3", source_id: "s3", title: "y", description: "", published_at: "2026-09-06T00:00:00Z" },
    ];
    const links = [
      { cluster_id: "c1", article_id: "a1" },
      { cluster_id: "c1", article_id: "a2" },
      { cluster_id: "c2", article_id: "a3" },
    ];
    const report = computeReport({ articles, links, sources: [] });
    expect(report.cluster_count).toBe(2);
    expect(report.singleton_rate).toBe(0.5);
    expect(report.size_histogram).toEqual({ "1": 1, "2-3": 1, "4-7": 0, "8+": 0 });
    expect(report.unassigned_count).toBe(0);
  });

  it("counts articles with no link row as unassigned", () => {
    const articles = [
      { id: "a1", source_id: "s1", title: "x", description: "", published_at: "2026-09-06T00:00:00Z" },
      { id: "a2", source_id: "s2", title: "y", description: "", published_at: "2026-09-06T00:00:00Z" },
    ];
    const report = computeReport({ articles, links: [], sources: [] });
    expect(report.unassigned_count).toBe(2);
    expect(report.cluster_count).toBe(0);
  });

  it("flags a multi-member cluster with a repeated source as a duplicate", () => {
    const articles = [
      { id: "a1", source_id: "dup", title: "x", description: "", published_at: "2026-09-06T00:00:00Z" },
      { id: "a2", source_id: "dup", title: "x", description: "", published_at: "2026-09-06T00:00:00Z" },
      { id: "a3", source_id: "unique", title: "x", description: "", published_at: "2026-09-06T00:00:00Z" },
    ];
    const links = [
      { cluster_id: "c1", article_id: "a1" },
      { cluster_id: "c1", article_id: "a2" },
      { cluster_id: "c1", article_id: "a3" },
    ];
    const report = computeReport({ articles, links, sources: [] });
    expect(report.source_diversity.duplicate_source_clusters).toBe(1);
    expect(report.source_diversity.max_sources_per_cluster).toBe(2); // "dup" + "unique"
  });
});

describe("computeReport — maxPairs cap", () => {
  it("flags max_pairs_hit and reports max_pairs when the cap truncates pair scoring", () => {
    const ts = "2026-09-06T00:00:00Z";
    // 3 articles in 3 different clusters, all sharing entities — 3 candidate
    // cross-cluster pairs, but maxPairs=1 stops after the first.
    const articles = ["a1", "a2", "a3"].map((id) => ({
      id,
      source_id: id,
      title: "x",
      description: "",
      published_at: ts,
      entities: ["e1", "e2", "e3"],
    }));
    const links = [
      { cluster_id: "c1", article_id: "a1" },
      { cluster_id: "c2", article_id: "a2" },
      { cluster_id: "c3", article_id: "a3" },
    ];
    const report = computeReport({ articles, links, sources: [], maxPairs: 1 });
    expect(report.cross_pairs_scored).toBe(1);
    expect(report.max_pairs).toBe(1);
    expect(report.max_pairs_hit).toBe(true);
  });

  it("does not flag max_pairs_hit when scoring finishes under the cap", () => {
    const report = computeReport({ articles: [], links: [], sources: [], maxPairs: 200_000 });
    expect(report.max_pairs_hit).toBe(false);
    expect(report.max_pairs).toBe(200_000);
  });
});

describe("computeReport — sampleLimit", () => {
  it("defaults to 5 samples per probe", () => {
    const report = computeReport({ articles: [], links: [], sources: [] });
    expect(report.samples).toEqual({ precision: [], recall: [] });
  });

  it("accepts a single number applied to both probes, or {precision, recall}", () => {
    const ts = "2026-09-06T00:00:00Z";
    const articles = ["a1", "a2", "a3", "a4"].map((id) => ({
      id,
      source_id: id,
      title: "x",
      description: "",
      published_at: ts,
      entities: ["e1", "e2", "e3"],
    }));
    const links = articles.map((a, i) => ({ cluster_id: `c${i}`, article_id: a.id }));
    const uniform = computeReport({ articles, links, sources: [], sampleLimit: 2 });
    expect(uniform.samples.recall.length).toBe(2);
    const perProbe = computeReport({ articles, links, sources: [], sampleLimit: { recall: 1 } });
    expect(perProbe.samples.recall.length).toBe(1);
  });
});

describe("computeReport — blindspot flip rate", () => {
  // The flip check only cares about link-level grouping + the meta each
  // link carries — article content is irrelevant, so `articles: []` here.
  it("ignores clusters below the 5-member eligibility floor", () => {
    const links = [1, 2, 3, 4].map((i) => ({
      cluster_id: "small",
      article_id: `a${i}`,
      is_blindspot: true,
      bias_distribution: { pro_government: 4 }, // would predict false anyway (< minSources)
    }));
    const report = computeReport({ articles: [], links, sources: [] });
    expect(report.blindspot_eligible_clusters).toBe(0);
    expect(report.blindspot_flip_rate).toBe(0);
  });

  it("does not flag a cluster whose stored flag agrees with detectBlindspot()", () => {
    const links = [1, 2, 3, 4, 5].map((i) => ({
      cluster_id: "consistent",
      article_id: `a${i}`,
      is_blindspot: true, // 5x pro_government → 100% share, correctly flagged
      bias_distribution: { pro_government: 5 },
    }));
    const report = computeReport({ articles: [], links, sources: [] });
    expect(report.blindspot_eligible_clusters).toBe(1);
    expect(report.blindspot_flip_count).toBe(0);
    expect(report.blindspot_flip_rate).toBe(0);
  });

  it("flags a cluster whose stored flag disagrees with detectBlindspot()", () => {
    const links = [1, 2, 3, 4, 5].map((i) => ({
      cluster_id: "flipped",
      article_id: `a${i}`,
      is_blindspot: false, // stale/wrong — the distribution says true
      bias_distribution: { pro_government: 5 },
    }));
    const report = computeReport({ articles: [], links, sources: [] });
    expect(report.blindspot_eligible_clusters).toBe(1);
    expect(report.blindspot_flip_count).toBe(1);
    expect(report.blindspot_flip_rate).toBe(1);
  });

  it("treats a missing bias_distribution as empty (never a blindspot)", () => {
    const links = [1, 2, 3, 4, 5].map((i) => ({
      cluster_id: "no-dist",
      article_id: `a${i}`,
      is_blindspot: true, // stored true with nothing to justify it → a flip
      bias_distribution: null,
    }));
    const report = computeReport({ articles: [], links, sources: [] });
    expect(report.blindspot_flip_count).toBe(1);
  });

  it("averages correctly across multiple eligible clusters", () => {
    const consistent = [1, 2, 3, 4, 5].map((i) => ({
      cluster_id: "c-ok",
      article_id: `ok${i}`,
      is_blindspot: true,
      bias_distribution: { opposition: 5 },
    }));
    const flipped = [1, 2, 3, 4, 5].map((i) => ({
      cluster_id: "c-flip",
      article_id: `fl${i}`,
      is_blindspot: false,
      bias_distribution: { opposition: 5 },
    }));
    const report = computeReport({ articles: [], links: [...consistent, ...flipped], sources: [] });
    expect(report.blindspot_eligible_clusters).toBe(2);
    expect(report.blindspot_flip_count).toBe(1);
    expect(report.blindspot_flip_rate).toBe(0.5);
  });
});

describe("computeReport — precision and recall probes", () => {
  it("does not score pairs published more than TIME_WINDOW_HOURS apart", () => {
    // Same cluster, 60h apart — outside the ensemble's 48h window, so
    // scorePair returns null and the pair contributes to neither count.
    const articles = [
      { id: "a1", source_id: "s1", title: "AKP Meclis toplantısı", description: "", published_at: "2026-09-06T00:00:00Z" },
      { id: "a2", source_id: "s2", title: "AKP Meclis toplantısı", description: "", published_at: "2026-09-08T12:00:00Z" },
    ];
    const links = [
      { cluster_id: "c1", article_id: "a1" },
      { cluster_id: "c1", article_id: "a2" },
    ];
    const report = computeReport({ articles, links, sources: [] });
    expect(report.intra_pairs_scored).toBe(0);
    expect(report.precision_probe_count).toBe(0);
  });

  it("finds a recall-probe hit for near-identical articles kept in separate clusters", () => {
    const title = "Cumhurbaşkanı Erdoğan Ankara'da kritik açıklamalarda bulundu";
    const description = "AKP grup toplantısı sonrası basın açıklaması yapıldı";
    const articles = [
      { id: "a1", source_id: "s1", title, description, published_at: "2026-09-06T00:00:00Z" },
      { id: "a2", source_id: "s2", title, description, published_at: "2026-09-06T01:00:00Z" },
    ];
    const links = [
      { cluster_id: "c1", article_id: "a1" },
      { cluster_id: "c2", article_id: "a2" },
    ];
    const report = computeReport({ articles, links, sources: [] });
    expect(report.recall_probe_count).toBe(1);
    expect(report.samples.recall[0].a_cluster).not.toBe(report.samples.recall[0].b_cluster);
  });

  it("does not count a same-cluster pair as a recall miss", () => {
    const title = "Cumhurbaşkanı Erdoğan Ankara'da kritik açıklamalarda bulundu";
    const description = "AKP grup toplantısı sonrası basın açıklaması yapıldı";
    const articles = [
      { id: "a1", source_id: "s1", title, description, published_at: "2026-09-06T00:00:00Z" },
      { id: "a2", source_id: "s2", title, description, published_at: "2026-09-06T01:00:00Z" },
    ];
    const links = [
      { cluster_id: "c1", article_id: "a1" },
      { cluster_id: "c1", article_id: "a2" },
    ];
    const report = computeReport({ articles, links, sources: [] });
    expect(report.recall_probe_count).toBe(0);
  });
});
