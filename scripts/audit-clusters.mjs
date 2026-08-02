#!/usr/bin/env node
// scripts/audit-clusters.mjs
//
// One-shot clustering quality audit. Reads the last 48h of politics articles
// + their clusters, replays the ensemble scorer against every pair, and
// reports:
//
//   - Structural stats: article counts, singleton rate, size histogram,
//     source-diversity per cluster.
//   - Precision probe: intra-cluster pairs whose ensemble score is far below
//     MATCH_THRESHOLD — evidence of over-merging / entity-glue.
//   - Recall probe: inter-cluster pairs (different clusters, same 48h
//     window) whose ensemble score CLEARS MATCH_THRESHOLD — evidence of
//     under-merging / fragmentation.
//   - Samples: human-readable title lists for the top-5 findings in each
//     category so the user can eyeball what the system got right and wrong.
//
// Read-only. Never writes to Supabase. Safe to run anytime.
//
// Usage:
//   node scripts/audit-clusters.mjs
//   HOURS=24 node scripts/audit-clusters.mjs     # narrower window
//   MAX_PAIRS=50000 node scripts/audit-clusters.mjs  # cap pair scoring

import { fingerprint } from "./lib/cluster/fingerprint.mjs";
import { extractEntities } from "./lib/cluster/entities.mjs";
import { TfidfIndex } from "./lib/cluster/tfidf.mjs";
import { score } from "./lib/cluster/ensemble.mjs";
import { MATCH_THRESHOLD, TIME_WINDOW_HOURS } from "./lib/cluster/constants.mjs";
import { createClient } from "@supabase/supabase-js";

// `scripts/lib/shared/` was deleted with the tmux workers (50b9703), so the
// two helpers this script used are inlined. Node >=22 (see package.json
// engines) loads dotenv natively; a missing .env.local is fine when the vars
// come from the real environment instead.
try {
  process.loadEnvFile(".env.local");
} catch {
  // no .env.local — fall through to process.env
}

const HOURS = Number(process.env.HOURS || TIME_WINDOW_HOURS);
const MAX_PAIRS = Number(process.env.MAX_PAIRS || 200_000);
const POLITICS_CATEGORIES = ["politika", "son_dakika"];

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Put them in .env.local (see .env.local.example) or export them.",
  );
  process.exit(1);
}

// Service role: this reads every article/cluster row regardless of RLS. The
// script never writes — see the header contract.
const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

function pct(n, d) {
  if (!d) return "0.0%";
  return ((100 * n) / d).toFixed(1) + "%";
}

function banner(title) {
  const line = "=".repeat(78);
  console.log(`\n${line}\n${title}\n${line}`);
}

async function inChunked(table, select, column, values, chunkSize = 100) {
  if (values.length === 0) return [];
  const out = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    const slice = values.slice(i, i + chunkSize);
    const res = await supabase.from(table).select(select).in(column, slice);
    if (res.error) throw new Error(`inChunked(${table}): ${res.error.message}`);
    for (const row of res.data ?? []) out.push(row);
  }
  return out;
}

async function paged(table, select, filter, pageSize = 1000) {
  const out = [];
  let offset = 0;
  while (true) {
    let q = supabase.from(table).select(select);
    for (const [col, vals] of Object.entries(filter || {})) {
      if (vals && vals.gte != null) q = q.gte(col, vals.gte);
      else if (Array.isArray(vals)) q = q.in(col, vals);
    }
    q = q.range(offset, offset + pageSize - 1);
    const res = await q;
    if (res.error) throw new Error(`paged(${table}): ${res.error.message}`);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) break;
    offset += pageSize;
    if (offset > 1_000_000) break;
  }
  return out;
}

function enrich(article) {
  const fp = fingerprint(article.title || "", article.description || "");
  article._fpStrict = article.fingerprint || fp.strict;
  article._signature = fp.signature;
  article._entities = Array.isArray(article.entities) && article.entities.length
    ? article.entities
    : extractEntities(`${article.title || ""} ${article.description || ""}`) || [];
  return article;
}

function hoursBetween(a, b) {
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) / 3_600_000;
}

async function main() {
  const cutoff = new Date(Date.now() - HOURS * 3_600_000).toISOString();
  banner(`CLUSTERING AUDIT — last ${HOURS}h (cutoff=${cutoff})`);

  // ---- 1. Pull politics articles in window -------------------------------
  const articles = await paged(
    "articles",
    "id, source_id, title, description, published_at, fingerprint, entities, category",
    { category: POLITICS_CATEGORIES, published_at: { gte: cutoff } },
  );
  const sourceLookup = new Map();
  {
    const sourcesRes = await supabase.from("sources").select("id, name, slug, bias");
    if (sourcesRes.error) throw new Error(sourcesRes.error.message);
    for (const s of sourcesRes.data ?? []) sourceLookup.set(s.id, s);
  }

  for (const a of articles) enrich(a);
  const articlesById = new Map(articles.map((a) => [a.id, a]));

  // ---- 2. Pull cluster_articles for this set -----------------------------
  const articleIds = articles.map((a) => a.id);
  const caRows = await inChunked(
    "cluster_articles",
    "cluster_id, article_id",
    "article_id",
    articleIds,
    100,
  );

  const memberIdsByCluster = new Map();
  const clusterIdByArticle = new Map();
  for (const row of caRows) {
    clusterIdByArticle.set(row.article_id, row.cluster_id);
    const list = memberIdsByCluster.get(row.cluster_id) || [];
    list.push(row.article_id);
    memberIdsByCluster.set(row.cluster_id, list);
  }

  // Drop singleton "pseudo clusters" for articles that are actually in a
  // multi-member cluster — we only want clusters that contain AT LEAST ONE
  // article from our window. But we also want to identify true unassigned
  // articles.
  const unassignedIds = articleIds.filter((id) => !clusterIdByArticle.has(id));

  // Size histogram — counts are over cluster members IN WINDOW, not the
  // cluster's lifetime size. For the quality audit this is what matters.
  const sizeHistogram = new Map();
  for (const ids of memberIdsByCluster.values()) {
    const k = ids.length === 1 ? "1" :
              ids.length <= 3 ? "2-3" :
              ids.length <= 7 ? "4-7" : "8+";
    sizeHistogram.set(k, (sizeHistogram.get(k) || 0) + 1);
  }

  const totalArticles = articles.length;
  const totalClusters = memberIdsByCluster.size;
  const multiMember = [...memberIdsByCluster.values()].filter((ids) => ids.length >= 2);
  const singletonClusters = [...memberIdsByCluster.values()].filter((ids) => ids.length === 1);

  banner("STRUCTURAL STATS");
  console.log(`politics articles in window:   ${totalArticles}`);
  console.log(`  assigned to a cluster:       ${articleIds.length - unassignedIds.length}  (${pct(articleIds.length - unassignedIds.length, totalArticles)})`);
  console.log(`  unassigned:                  ${unassignedIds.length}  (${pct(unassignedIds.length, totalArticles)})`);
  console.log(`clusters with members in window: ${totalClusters}`);
  console.log(`  singleton:                   ${singletonClusters.length}  (${pct(singletonClusters.length, totalClusters)})`);
  console.log(`  multi-member:                ${multiMember.length}  (${pct(multiMember.length, totalClusters)})`);
  console.log(`size histogram: ${[...sizeHistogram.entries()].map(([k, v]) => `${k}:${v}`).join("  ")}`);

  // Source diversity per multi-member cluster.
  let sumSources = 0;
  let maxSources = 0;
  let clustersWithDupSource = 0;
  for (const ids of multiMember) {
    const sourceSet = new Set();
    const sourceCounts = new Map();
    for (const id of ids) {
      const a = articlesById.get(id);
      if (!a) continue;
      sourceSet.add(a.source_id);
      sourceCounts.set(a.source_id, (sourceCounts.get(a.source_id) || 0) + 1);
    }
    sumSources += sourceSet.size;
    if (sourceSet.size > maxSources) maxSources = sourceSet.size;
    for (const c of sourceCounts.values()) if (c > 1) { clustersWithDupSource++; break; }
  }
  console.log(`avg sources per multi-member cluster: ${multiMember.length ? (sumSources / multiMember.length).toFixed(2) : "n/a"}`);
  console.log(`max sources in a single cluster: ${maxSources}`);
  console.log(`multi-member clusters with duplicate source: ${clustersWithDupSource}  (violates dedupe guard)`);

  // ---- 3. Build one big TF-IDF index over every article in window --------
  const tfidf = new TfidfIndex();
  for (const a of articles) tfidf.addDoc(a.id, `${a.title || ""} ${a.description || ""}`);
  tfidf.finalize();

  function scorePair(a, b) {
    const hoursDelta = hoursBetween(a.published_at, b.published_at);
    if (hoursDelta > TIME_WINDOW_HOURS) return null;
    const aFp = { strict: a._fpStrict, signature: a._signature };
    const bFp = { strict: b._fpStrict, signature: b._signature };
    const tfc = tfidf.cosine(a.id, b.id);
    const res = score(
      aFp, bFp,
      a._entities, b._entities,
      tfc, hoursDelta,
      {
        aSourceSlug: sourceLookup.get(a.source_id)?.slug,
        bSourceSlug: sourceLookup.get(b.source_id)?.slug,
      },
    );
    return { ...res, hoursDelta, tfc };
  }

  // ---- 4. Precision probe — intra-cluster weak pairs ---------------------
  banner("PRECISION PROBE — weak intra-cluster pairs");
  const WEAK_FLOOR = MATCH_THRESHOLD * 0.6;  // e.g. 0.288 at threshold 0.48
  const weakIntra = [];
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
        if (r.score < WEAK_FLOOR) {
          weakIntra.push({ clusterId, a, b, r });
        }
      }
    }
  }
  console.log(`intra-cluster pairs scored: ${intraPairsScored}`);
  console.log(`weak pairs (score < ${WEAK_FLOOR.toFixed(2)}): ${weakIntra.length}  (${pct(weakIntra.length, intraPairsScored)} of intra-pairs)`);
  // Show up to 8 worst.
  weakIntra.sort((x, y) => x.r.score - y.r.score);
  for (const w of weakIntra.slice(0, 8)) {
    const sa = sourceLookup.get(w.a.source_id)?.slug || "?";
    const sb = sourceLookup.get(w.b.source_id)?.slug || "?";
    console.log(
      `  [${w.r.score.toFixed(2)}] cluster=${String(w.clusterId).slice(0, 8)}  Δt=${w.r.hoursDelta.toFixed(1)}h  shared-ent=${w.r.components.sharedEntities}  tfidf=${w.r.components.tfidfScore.toFixed(2)}  jac=${w.r.components.jaccard.toFixed(2)}`,
    );
    console.log(`    A(${sa}): ${String(w.a.title || "").slice(0, 100)}`);
    console.log(`    B(${sb}): ${String(w.b.title || "").slice(0, 100)}`);
  }

  // ---- 5. Recall probe — cross-cluster pairs above threshold -------------
  banner("RECALL PROBE — cross-cluster pairs that SHOULD have merged");
  // For each article, get candidates via entity inverted index over the whole
  // corpus. We won't do full O(n²); that blows past MAX_PAIRS fast.
  const byEntity = new Map();
  for (const a of articles) {
    for (const e of a._entities || []) {
      const list = byEntity.get(e) || [];
      list.push(a.id);
      byEntity.set(e, list);
    }
  }

  const seen = new Set();
  const crossMisses = [];
  let crossScored = 0;
  outer: for (const a of articles) {
    const cand = new Map();  // otherId → sharedCount
    for (const e of a._entities || []) {
      const list = byEntity.get(e) || [];
      for (const other of list) {
        if (other === a.id) continue;
        cand.set(other, (cand.get(other) || 0) + 1);
      }
    }
    // need at least 2 shared entities AND different clusters (or both unassigned)
    for (const [otherId, shared] of cand.entries()) {
      if (shared < 2) continue;
      const pairKey = a.id < otherId ? `${a.id}|${otherId}` : `${otherId}|${a.id}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const ca = clusterIdByArticle.get(a.id);
      const cb = clusterIdByArticle.get(otherId);
      // Same-cluster pair → already merged, skip.
      if (ca && cb && ca === cb) continue;
      const b = articlesById.get(otherId);
      if (!b) continue;
      const r = scorePair(a, b);
      if (!r) continue;
      crossScored++;
      if (crossScored >= MAX_PAIRS) {
        console.log(`  (hit MAX_PAIRS=${MAX_PAIRS} — stopping pair scoring)`);
        break outer;
      }
      if (r.score >= MATCH_THRESHOLD) {
        crossMisses.push({ a, b, r, ca, cb });
      }
    }
  }
  console.log(`cross-cluster pairs scored: ${crossScored}`);
  console.log(`pairs ≥ MATCH_THRESHOLD (${MATCH_THRESHOLD}): ${crossMisses.length}  (${pct(crossMisses.length, crossScored)})`);

  // Group misses into "would-merge components" via union-find so we can
  // estimate how many *clusters* would collapse if we fixed them all.
  const parent = new Map();
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    let cur = x;
    while (parent.get(cur) !== r) { const n = parent.get(cur); parent.set(cur, r); cur = n; }
    return r;
  };
  const union = (a, b) => {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  };
  for (const m of crossMisses) {
    // Use cluster id if assigned, else an "article:" handle so unassigned
    // articles still cluster together in the component view.
    const ka = m.ca ? `c:${m.ca}` : `a:${m.a.id}`;
    const kb = m.cb ? `c:${m.cb}` : `a:${m.b.id}`;
    union(ka, kb);
  }
  const components = new Map();
  for (const k of parent.keys()) {
    const r = find(k);
    const list = components.get(r) || [];
    list.push(k);
    components.set(r, list);
  }
  const multiComponent = [...components.values()].filter((c) => c.length >= 2);
  console.log(`would-merge components (≥2 members): ${multiComponent.length}`);
  console.log(`total entities involved in merges:  ${parent.size}`);

  // Show up to 10 top misses by score.
  crossMisses.sort((x, y) => y.r.score - x.r.score);
  for (const m of crossMisses.slice(0, 10)) {
    const sa = sourceLookup.get(m.a.source_id)?.slug || "?";
    const sb = sourceLookup.get(m.b.source_id)?.slug || "?";
    const caTag = m.ca ? `c=${String(m.ca).slice(0, 6)}` : "unassigned";
    const cbTag = m.cb ? `c=${String(m.cb).slice(0, 6)}` : "unassigned";
    console.log(
      `  [${m.r.score.toFixed(2)}] Δt=${m.r.hoursDelta.toFixed(1)}h shared=${m.r.components.sharedEntities} tfidf=${m.r.components.tfidfScore.toFixed(2)} jac=${m.r.components.jaccard.toFixed(2)}  ${caTag} vs ${cbTag}`,
    );
    console.log(`    A(${sa}): ${String(m.a.title || "").slice(0, 100)}`);
    console.log(`    B(${sb}): ${String(m.b.title || "").slice(0, 100)}`);
  }

  // ---- 6. Unassigned-article analysis ------------------------------------
  banner("UNASSIGNED ARTICLES");
  console.log(`${unassignedIds.length} unassigned articles in window`);
  // How many have a would-match candidate?
  let unassignedWithCandidate = 0;
  const unassignedSet = new Set(unassignedIds);
  for (const m of crossMisses) {
    if (unassignedSet.has(m.a.id)) unassignedWithCandidate++;
    if (unassignedSet.has(m.b.id)) unassignedWithCandidate++;
  }
  console.log(`unassigned articles appearing in ≥1 would-merge pair: ~${unassignedWithCandidate} pair-endpoints`);

  // ---- 7. Near-miss distribution ----------------------------------------
  banner("NEAR-MISS DISTRIBUTION (cross-cluster pairs)");
  // Bucket scores so we can see where the threshold sits relative to the mass.
  const buckets = [0, 0.1, 0.2, 0.3, 0.4, 0.48, 0.55, 0.65, 0.8, 1.01];
  const hist = new Array(buckets.length - 1).fill(0);
  // Recount pair scores for histogram — reuse the cross-cluster set by
  // re-scoring (we didn't keep them all). To avoid an expensive rescan, only
  // rebuild histogram over crossMisses + a sampled below-threshold bucket.
  // For a clearer picture, re-score a sample.
  const SAMPLE = Math.min(crossScored, 5000);
  console.log(`sampling ${SAMPLE} cross-cluster pairs for histogram...`);
  const sampleScores = [];
  let taken = 0;
  outerS: for (const a of articles) {
    const cand = new Map();
    for (const e of a._entities || []) {
      const list = byEntity.get(e) || [];
      for (const other of list) {
        if (other === a.id) continue;
        cand.set(other, (cand.get(other) || 0) + 1);
      }
    }
    for (const [otherId, shared] of cand.entries()) {
      if (shared < 2) continue;
      if (otherId <= a.id) continue;  // dedupe pairs
      const ca = clusterIdByArticle.get(a.id);
      const cb = clusterIdByArticle.get(otherId);
      if (ca && cb && ca === cb) continue;
      const b = articlesById.get(otherId);
      if (!b) continue;
      const r = scorePair(a, b);
      if (!r) continue;
      sampleScores.push(r.score);
      taken++;
      if (taken >= SAMPLE) break outerS;
    }
  }
  for (const s of sampleScores) {
    for (let i = 0; i < hist.length; i++) {
      if (s >= buckets[i] && s < buckets[i + 1]) { hist[i]++; break; }
    }
  }
  for (let i = 0; i < hist.length; i++) {
    const lo = buckets[i].toFixed(2);
    const hi = buckets[i + 1].toFixed(2);
    const n = hist[i];
    const bar = "█".repeat(Math.min(60, Math.round((n / Math.max(1, sampleScores.length)) * 200)));
    console.log(`  [${lo}–${hi})  ${String(n).padStart(5)}  ${bar}`);
  }

  // ---- 8. Bottom line ----------------------------------------------------
  banner("BOTTOM LINE");
  console.log(`singleton cluster rate:        ${pct(singletonClusters.length, totalClusters)}`);
  console.log(`precision-glue pairs:          ${weakIntra.length} / ${intraPairsScored}  (${pct(weakIntra.length, intraPairsScored)})`);
  console.log(`recall-miss pairs (≥ thresh):  ${crossMisses.length} / ${crossScored}  (${pct(crossMisses.length, crossScored)})`);
  console.log(`estimated clusters to collapse if all recall misses were merged: ~${multiComponent.length}`);
  console.log("");
  console.log("Interpretation guide:");
  console.log("  - high singleton rate + many recall-miss pairs → under-merging (threshold too high or signals too weak).");
  console.log("  - many weak intra-cluster pairs → over-merging (entity-glue or aggregator source dragging stories together).");
  console.log("  - histogram bulge at 0.30–0.48 with few 0.48–0.60 pairs → threshold is sitting right on top of real signal.");
}

main().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
