// scripts/lib/audit/report.mjs
//
// Pure computation core of the clustering quality audit. Factored out of
// scripts/audit-clusters.mjs so it can run against a fixture corpus in tests
// (report.test.mjs pins golden summary numbers against
// tests/fixtures/clusters-sample.json) and so migration 039's
// cluster_quality_snapshots row is built from the exact same code path the
// CLI's console banners read from — no drift between "what got printed" and
// "what got persisted".
//
// computeReport() takes already-fetched rows and does no I/O of its own:
// no Supabase client, no Date.now(), no randomness. Same input → same
// output, always.
//
//   computeReport({ articles, links, sources, sourcesById, hours, maxPairs })
//
//   articles — article rows: { id, source_id, title, description,
//              published_at, fingerprint?, entities?, category? }.
//              fingerprint/entities are computed here when absent so callers
//              can pass raw `articles` rows straight off the wire.
//   links    — cluster membership rows, one per (article, cluster) pair,
//              carrying the PARENT cluster's blindspot fields (there is no
//              separate `clusters` param — the caller embeds them, e.g. via
//              `cluster_articles(...).select("cluster_id, article_id,
//              clusters(is_blindspot, bias_distribution)")` and flattens):
//              { cluster_id, article_id, is_blindspot, bias_distribution }.
//   sources  — source rows: { id, slug, ... }. Only `id` and `slug` are used
//              (source-penalty lookups inside ensemble.score()).
//   sourcesById — optional pre-built Map/object (id → source row), so a
//              caller that already has one doesn't pay to rebuild it.
//   hours    — label only: how far back `articles` was fetched from. Does
//              NOT gate pair-scoring — that uses the ensemble's own
//              TIME_WINDOW_HOURS constant, same as production clustering.
//   maxPairs — cap on cross-cluster candidate pairs scored in the recall
//              probe (perf guard on large windows). When the cap is hit,
//              the report says so via max_pairs_hit/max_pairs instead of
//              silently truncating.
//   sampleLimit — how many top findings `samples` keeps per probe. Either a
//              number (applied to both probes) or { precision, recall } for
//              different verbosity per probe. Defaults to 5, matching the
//              persisted-snapshot contract; the CLI passes
//              { precision: 8, recall: 10 } to keep its older console output.
//
// Returns the persisted-snapshot shape (window_hours, article_count,
// cluster_count, singleton_rate, size_histogram, source_diversity,
// precision_probe_count, recall_probe_count, blindspot_flip_rate, samples)
// plus a handful of extra diagnostic fields the CLI's fuller console output
// uses (unassigned_count, would_merge_component_count, near_miss_histogram,
// ...) — all cheap byproducts of the same single scoring pass, and all
// JSON-safe so the whole object round-trips through the `report` jsonb
// column untouched.

import { fingerprint } from "../cluster/fingerprint.mjs";
import { extractEntities } from "../cluster/entities.mjs";
import { TfidfIndex } from "../cluster/tfidf.mjs";
import { score as ensembleScore } from "../cluster/ensemble.mjs";
import { MATCH_THRESHOLD, TIME_WINDOW_HOURS } from "../cluster/constants.mjs";
import { detectBlindspot } from "../cluster/blindspot.mjs";

const DEFAULT_MAX_PAIRS = 200_000;
// Cross-cluster pairs need at least this many shared whitelist entities to
// be scored at all — mirrors the audit CLI's original candidate gate.
const MIN_SHARED_ENTITIES_FOR_CANDIDACY = 2;
// Clusters need at least this many IN-WINDOW members before their stored
// is_blindspot flag is checked — below this, "nobody covered it yet" and
// "the other side ignored it" are indistinguishable (same floor blindspot.mjs
// uses for the flag itself).
const BLINDSPOT_MIN_CLUSTER_SIZE = 5;
// Score buckets for the near-miss histogram. The 3rd boundary tracks
// MATCH_THRESHOLD (not a hardcoded literal) so the histogram always shows
// the bucket edge that actually matters, even after a threshold re-tune.
const HIST_BUCKETS = [0, 0.1, 0.2, 0.3, MATCH_THRESHOLD, 0.55, 0.65, 0.8, 1.01];

function round(n, decimals) {
  if (!Number.isFinite(n)) return 0;
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

function toSourceMap(sourcesById, sources) {
  if (sourcesById instanceof Map) return sourcesById;
  if (sourcesById && typeof sourcesById === "object") {
    return new Map(Object.entries(sourcesById));
  }
  return new Map((sources ?? []).map((s) => [s.id, s]));
}

// Computes fingerprint + entities for an article that may not carry them
// yet. Returns a NEW object (never mutates the input) so computeReport stays
// side-effect-free on its arguments.
function enrichArticle(article) {
  const fp = fingerprint(article.title || "", article.description || "");
  const entities =
    Array.isArray(article.entities) && article.entities.length
      ? article.entities
      : extractEntities(`${article.title || ""} ${article.description || ""}`) || [];
  return {
    ...article,
    _fpStrict: article.fingerprint || fp.strict,
    _signature: fp.signature,
    _entities: entities,
  };
}

function clusterSizeBucket(n) {
  if (n === 1) return "1";
  if (n <= 3) return "2-3";
  if (n <= 7) return "4-7";
  return "8+";
}

const DEFAULT_SAMPLE_LIMIT = 5;

function resolveSampleLimits(sampleLimit) {
  if (typeof sampleLimit === "number") return { precision: sampleLimit, recall: sampleLimit };
  return {
    precision: sampleLimit?.precision ?? DEFAULT_SAMPLE_LIMIT,
    recall: sampleLimit?.recall ?? DEFAULT_SAMPLE_LIMIT,
  };
}

export function computeReport({
  articles = [],
  links = [],
  sources = [],
  sourcesById,
  hours = TIME_WINDOW_HOURS,
  maxPairs = DEFAULT_MAX_PAIRS,
  sampleLimit = DEFAULT_SAMPLE_LIMIT,
} = {}) {
  const sampleLimits = resolveSampleLimits(sampleLimit);
  const bySourceId = toSourceMap(sourcesById, sources);
  const sourceSlug = (article) => bySourceId.get(article.source_id)?.slug ?? null;

  const enriched = articles.map(enrichArticle);
  const articlesById = new Map(enriched.map((a) => [a.id, a]));

  // ---- Group links into per-cluster membership + blindspot metadata ------
  const memberIdsByCluster = new Map();
  const clusterIdByArticle = new Map();
  const clusterMetaById = new Map();
  for (const link of links) {
    clusterIdByArticle.set(link.article_id, link.cluster_id);
    const list = memberIdsByCluster.get(link.cluster_id) || [];
    list.push(link.article_id);
    memberIdsByCluster.set(link.cluster_id, list);
    if (!clusterMetaById.has(link.cluster_id)) {
      clusterMetaById.set(link.cluster_id, {
        is_blindspot: link.is_blindspot ?? null,
        bias_distribution: link.bias_distribution ?? null,
      });
    }
  }

  const articleIds = enriched.map((a) => a.id);
  const unassignedIds = articleIds.filter((id) => !clusterIdByArticle.has(id));

  // ---- Structural stats ---------------------------------------------------
  const sizeHistogram = { "1": 0, "2-3": 0, "4-7": 0, "8+": 0 };
  for (const ids of memberIdsByCluster.values()) {
    sizeHistogram[clusterSizeBucket(ids.length)] += 1;
  }

  const totalArticles = enriched.length;
  const totalClusters = memberIdsByCluster.size;
  const multiMemberEntries = [...memberIdsByCluster.entries()].filter(
    ([, ids]) => ids.length >= 2,
  );
  const singletonCount = totalClusters - multiMemberEntries.length;
  const singletonRate = totalClusters > 0 ? round(singletonCount / totalClusters, 4) : 0;

  let sumSources = 0;
  let maxSourcesPerCluster = 0;
  let duplicateSourceClusters = 0;
  for (const [, ids] of multiMemberEntries) {
    const sourceCounts = new Map();
    for (const id of ids) {
      const a = articlesById.get(id);
      if (!a) continue;
      sourceCounts.set(a.source_id, (sourceCounts.get(a.source_id) || 0) + 1);
    }
    sumSources += sourceCounts.size;
    if (sourceCounts.size > maxSourcesPerCluster) maxSourcesPerCluster = sourceCounts.size;
    for (const c of sourceCounts.values()) {
      if (c > 1) {
        duplicateSourceClusters++;
        break;
      }
    }
  }
  const sourceDiversity = {
    avg_sources_per_multi_cluster: multiMemberEntries.length
      ? round(sumSources / multiMemberEntries.length, 2)
      : 0,
    max_sources_per_cluster: maxSourcesPerCluster,
    duplicate_source_clusters: duplicateSourceClusters,
  };

  // ---- Shared TF-IDF index + pair scorer -----------------------------------
  const tfidf = new TfidfIndex();
  for (const a of enriched) tfidf.addDoc(a.id, `${a.title || ""} ${a.description || ""}`);
  tfidf.finalize();

  function scorePair(a, b) {
    const hoursDelta = hoursBetween(a.published_at, b.published_at);
    if (hoursDelta > TIME_WINDOW_HOURS) return null;
    const aFp = { strict: a._fpStrict, signature: a._signature };
    const bFp = { strict: b._fpStrict, signature: b._signature };
    const tfc = tfidf.cosine(a.id, b.id);
    const res = ensembleScore(aFp, bFp, a._entities, b._entities, tfc, hoursDelta, {
      aSourceSlug: sourceSlug(a),
      bSourceSlug: sourceSlug(b),
    });
    return { ...res, hoursDelta, tfc };
  }

  // ---- Precision probe — weak intra-cluster pairs --------------------------
  const WEAK_FLOOR = MATCH_THRESHOLD * 0.6;
  const weakPairs = [];
  let intraPairsScored = 0;
  for (const [clusterId, ids] of memberIdsByCluster.entries()) {
    if (ids.length < 2) continue;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = articlesById.get(ids[i]);
        const b = articlesById.get(ids[j]);
        if (!a || !b) continue;
        const r = scorePair(a, b);
        if (!r) continue;
        intraPairsScored++;
        if (r.score < WEAK_FLOOR) weakPairs.push({ clusterId, a, b, r });
      }
    }
  }

  // ---- Recall probe — cross-cluster pairs that clear the threshold --------
  const byEntity = new Map();
  for (const a of enriched) {
    for (const e of a._entities || []) {
      const list = byEntity.get(e) || [];
      list.push(a.id);
      byEntity.set(e, list);
    }
  }

  const seenPairs = new Set();
  const crossMisses = [];
  let crossScored = 0;
  let maxPairsHit = false;
  const histCounts = new Array(HIST_BUCKETS.length - 1).fill(0);
  const bucketize = (s) => {
    for (let i = 0; i < histCounts.length; i++) {
      if (s >= HIST_BUCKETS[i] && s < HIST_BUCKETS[i + 1]) {
        histCounts[i]++;
        return;
      }
    }
  };

  outer: for (const a of enriched) {
    const candidates = new Map();
    for (const e of a._entities || []) {
      const list = byEntity.get(e) || [];
      for (const other of list) {
        if (other === a.id) continue;
        candidates.set(other, (candidates.get(other) || 0) + 1);
      }
    }
    for (const [otherId, shared] of candidates.entries()) {
      if (shared < MIN_SHARED_ENTITIES_FOR_CANDIDACY) continue;
      const pairKey = a.id < otherId ? `${a.id}|${otherId}` : `${otherId}|${a.id}`;
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      const ca = clusterIdByArticle.get(a.id);
      const cb = clusterIdByArticle.get(otherId);
      if (ca && cb && ca === cb) continue; // already merged
      const b = articlesById.get(otherId);
      if (!b) continue;
      const r = scorePair(a, b);
      if (!r) continue;
      crossScored++;
      bucketize(r.score);
      if (r.score >= MATCH_THRESHOLD) crossMisses.push({ a, b, r, ca, cb });
      if (crossScored >= maxPairs) {
        maxPairsHit = true;
        break outer;
      }
    }
  }

  // Would-merge components: union-find over crossMisses so we can estimate
  // how many *clusters* would collapse if every recall miss were merged.
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let cur = x;
    while (parent.get(cur) !== r) {
      const n = parent.get(cur);
      parent.set(cur, r);
      cur = n;
    }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const m of crossMisses) {
    const ka = m.ca ? `c:${m.ca}` : `a:${m.a.id}`;
    const kb = m.cb ? `c:${m.cb}` : `a:${m.b.id}`;
    union(ka, kb);
  }
  const componentSizes = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    componentSizes.set(r, (componentSizes.get(r) || 0) + 1);
  }
  let wouldMergeComponentCount = 0;
  for (const size of componentSizes.values()) if (size >= 2) wouldMergeComponentCount++;

  const unassignedSet = new Set(unassignedIds);
  let unassignedWithCandidateEndpoints = 0;
  for (const m of crossMisses) {
    if (unassignedSet.has(m.a.id)) unassignedWithCandidateEndpoints++;
    if (unassignedSet.has(m.b.id)) unassignedWithCandidateEndpoints++;
  }

  // ---- Blindspot contract check --------------------------------------------
  let blindspotEligible = 0;
  let blindspotFlips = 0;
  for (const [clusterId, ids] of memberIdsByCluster.entries()) {
    if (ids.length < BLINDSPOT_MIN_CLUSTER_SIZE) continue;
    blindspotEligible++;
    const meta = clusterMetaById.get(clusterId) || {};
    const stored = !!meta.is_blindspot;
    const predicted = detectBlindspot(meta.bias_distribution || {}).is_blindspot;
    if (stored !== predicted) blindspotFlips++;
  }
  const blindspotFlipRate = blindspotEligible > 0 ? round(blindspotFlips / blindspotEligible, 4) : 0;

  // ---- Samples — top 5 findings per probe, for human eyeballing -----------
  const sampleSide = (article) => ({ source: sourceSlug(article), title: article.title || "" });
  // NOT `r.components.sharedEntities` — the ensemble's strict-fingerprint
  // auto-accept branch (score=1.0 wire-copy matches) omits that field
  // entirely, which would silently show "0 shared entities" on exactly the
  // pairs that share the most. Recompute directly from the entity sets.
  const sharedEntityCount = (a, b) => {
    const bEnts = new Set(b._entities || []);
    let n = 0;
    for (const e of a._entities || []) if (bEnts.has(e)) n++;
    return n;
  };

  const precisionSamples = [...weakPairs]
    .sort((x, y) => x.r.score - y.r.score)
    .slice(0, sampleLimits.precision)
    .map((w) => ({
      cluster_id: w.clusterId,
      score: round(w.r.score, 4),
      hours_delta: round(w.r.hoursDelta, 2),
      shared_entities: sharedEntityCount(w.a, w.b),
      tfidf: round(w.r.components.tfidfScore, 4),
      jaccard: round(w.r.components.jaccard, 4),
      a: sampleSide(w.a),
      b: sampleSide(w.b),
    }));

  const recallSamples = [...crossMisses]
    .sort((x, y) => y.r.score - x.r.score)
    .slice(0, sampleLimits.recall)
    .map((m) => ({
      score: round(m.r.score, 4),
      hours_delta: round(m.r.hoursDelta, 2),
      shared_entities: sharedEntityCount(m.a, m.b),
      tfidf: round(m.r.components.tfidfScore, 4),
      jaccard: round(m.r.components.jaccard, 4),
      a_cluster: m.ca ?? null,
      b_cluster: m.cb ?? null,
      a: sampleSide(m.a),
      b: sampleSide(m.b),
    }));

  return {
    window_hours: hours,
    article_count: totalArticles,
    cluster_count: totalClusters,
    singleton_rate: singletonRate,
    size_histogram: sizeHistogram,
    source_diversity: sourceDiversity,
    precision_probe_count: weakPairs.length,
    recall_probe_count: crossMisses.length,
    blindspot_flip_rate: blindspotFlipRate,
    samples: {
      precision: precisionSamples,
      recall: recallSamples,
    },

    // Diagnostics beyond the persisted-column contract — cheap byproducts of
    // the same pass above, used by the CLI's fuller console banners. Still
    // pure/deterministic; still safe inside the `report` jsonb blob.
    unassigned_count: unassignedIds.length,
    singleton_count: singletonCount,
    intra_pairs_scored: intraPairsScored,
    cross_pairs_scored: crossScored,
    max_pairs: maxPairs,
    max_pairs_hit: maxPairsHit,
    would_merge_component_count: wouldMergeComponentCount,
    unassigned_with_candidate_endpoints: unassignedWithCandidateEndpoints,
    blindspot_eligible_clusters: blindspotEligible,
    blindspot_flip_count: blindspotFlips,
    near_miss_histogram: { buckets: HIST_BUCKETS, counts: histCounts },
  };
}
