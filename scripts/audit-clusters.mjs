#!/usr/bin/env node
// scripts/audit-clusters.mjs
//
// One-shot clustering quality audit. Reads the last 48h of politics articles
// + their clusters, replays the ensemble scorer against every pair via
// scripts/lib/audit/report.mjs's computeReport(), and reports:
//
//   - Structural stats: article counts, singleton rate, size histogram,
//     source-diversity per cluster.
//   - Precision probe: intra-cluster pairs whose ensemble score is far below
//     MATCH_THRESHOLD — evidence of over-merging / entity-glue.
//   - Recall probe: inter-cluster pairs (different clusters, same 48h
//     window) whose ensemble score CLEARS MATCH_THRESHOLD — evidence of
//     under-merging / fragmentation.
//   - Blindspot probe: clusters with >=5 members whose stored is_blindspot
//     disagrees with detectBlindspot(bias_distribution) — the contract
//     drifting from the data (recompute_blindspot_flags() not re-run, a
//     schema change, etc).
//   - Samples: human-readable title lists for the top-5 findings in each
//     category so the user can eyeball what the system got right and wrong.
//
// Read-only by default. Never writes to Supabase unless --persist is given.
//
// Usage:
//   node scripts/audit-clusters.mjs                  # human-readable banners
//   node scripts/audit-clusters.mjs --json            # print the report as JSON
//   node scripts/audit-clusters.mjs --persist         # also insert one row
//                                                      # into cluster_quality_snapshots
//   HOURS=24 node scripts/audit-clusters.mjs          # narrower window
//   MAX_PAIRS=50000 node scripts/audit-clusters.mjs   # cap pair scoring

import { computeReport } from "./lib/audit/report.mjs";
import { TIME_WINDOW_HOURS } from "./lib/cluster/constants.mjs";
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

const argv = process.argv.slice(2);
const args = {
  json: argv.includes("--json"),
  persist: argv.includes("--persist"),
};

const HOURS = Number(process.env.HOURS || TIME_WINDOW_HOURS);
const MAX_PAIRS = Number(process.env.MAX_PAIRS || 200_000);
const POLITICS_CATEGORIES = ["politika", "son_dakika"];

// Accept SUPABASE_URL (what the CI workflow sets) with the Next.js public
// var as a local-dev fallback, mirroring supabase/functions/_shared/supabase.ts.
const SUPABASE_URL = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error(
    "Missing SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) or SUPABASE_SERVICE_ROLE_KEY.\n" +
      "Put them in .env.local (see .env.local.example) or export them.",
  );
  process.exit(1);
}

// Service role: this reads every article/cluster row regardless of RLS.
// The script only writes when --persist is passed (see the header contract).
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

function printSample(prefix, s) {
  console.log(
    `  [${s.score.toFixed(2)}] Δt=${s.hours_delta.toFixed(1)}h shared=${s.shared_entities} tfidf=${s.tfidf.toFixed(2)} jac=${s.jaccard.toFixed(2)}${prefix}`,
  );
  console.log(`    A(${s.a.source || "?"}): ${s.a.title.slice(0, 100)}`);
  console.log(`    B(${s.b.source || "?"}): ${s.b.title.slice(0, 100)}`);
}

function printHistogram(hist) {
  const { buckets, counts } = hist;
  const total = counts.reduce((a, b) => a + b, 0);
  for (let i = 0; i < counts.length; i++) {
    const lo = buckets[i].toFixed(2);
    const hi = buckets[i + 1].toFixed(2);
    const n = counts[i];
    const bar = "█".repeat(Math.min(60, Math.round((n / Math.max(1, total)) * 200)));
    console.log(`  [${lo}–${hi})  ${String(n).padStart(5)}  ${bar}`);
  }
}

async function main() {
  const cutoff = new Date(Date.now() - HOURS * 3_600_000).toISOString();

  // ---- 1. Pull politics articles in window -------------------------------
  const articles = await paged(
    "articles",
    "id, source_id, title, description, published_at, fingerprint, entities, category",
    { category: POLITICS_CATEGORIES, published_at: { gte: cutoff } },
  );

  const sourcesRes = await supabase.from("sources").select("id, name, slug, bias");
  if (sourcesRes.error) throw new Error(sourcesRes.error.message);
  const sources = sourcesRes.data ?? [];

  // ---- 2. Pull cluster_articles for this set, embedding the parent
  //         cluster's blindspot fields so computeReport doesn't need a
  //         separate `clusters` fetch. ------------------------------------
  const articleIds = articles.map((a) => a.id);
  const caRows = await inChunked(
    "cluster_articles",
    "cluster_id, article_id, clusters(is_blindspot, bias_distribution)",
    "article_id",
    articleIds,
    100,
  );
  const links = caRows.map((row) => ({
    cluster_id: row.cluster_id,
    article_id: row.article_id,
    is_blindspot: row.clusters?.is_blindspot ?? null,
    bias_distribution: row.clusters?.bias_distribution ?? null,
  }));

  // ---- 3. Compute the report ----------------------------------------------
  const report = computeReport({
    articles,
    links,
    sources,
    hours: HOURS,
    maxPairs: MAX_PAIRS,
    // Keep the CLI's pre-refactor verbosity (8 precision / 10 recall
    // samples) even though the persisted-snapshot default is 5.
    sampleLimit: { precision: 8, recall: 10 },
  });

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printBanners(report, cutoff);
  }

  // ---- 4. Persist (opt-in) -------------------------------------------------
  if (args.persist) {
    const { error } = await supabase.from("cluster_quality_snapshots").insert({
      window_hours: report.window_hours,
      article_count: report.article_count,
      cluster_count: report.cluster_count,
      singleton_rate: report.singleton_rate,
      size_histogram: report.size_histogram,
      source_diversity: report.source_diversity,
      precision_probe_count: report.precision_probe_count,
      recall_probe_count: report.recall_probe_count,
      blindspot_flip_rate: report.blindspot_flip_rate,
      report,
    });
    if (error) throw new Error(`persist cluster_quality_snapshots: ${error.message}`);
    if (!args.json) console.log("\npersisted 1 row to public.cluster_quality_snapshots");
  }
}

function printBanners(report, cutoff) {
  banner(`CLUSTERING AUDIT — last ${report.window_hours}h (cutoff=${cutoff})`);

  banner("STRUCTURAL STATS");
  const assigned = report.article_count - report.unassigned_count;
  console.log(`politics articles in window:   ${report.article_count}`);
  console.log(`  assigned to a cluster:       ${assigned}  (${pct(assigned, report.article_count)})`);
  console.log(`  unassigned:                  ${report.unassigned_count}  (${pct(report.unassigned_count, report.article_count)})`);
  console.log(`clusters with members in window: ${report.cluster_count}`);
  console.log(`  singleton:                   ${report.singleton_count}  (${pct(report.singleton_count, report.cluster_count)})`);
  console.log(`  multi-member:                ${report.cluster_count - report.singleton_count}  (${pct(report.cluster_count - report.singleton_count, report.cluster_count)})`);
  const h = report.size_histogram;
  console.log(`size histogram: 1:${h["1"]}  2-3:${h["2-3"]}  4-7:${h["4-7"]}  8+:${h["8+"]}`);
  console.log(`avg sources per multi-member cluster: ${report.source_diversity.avg_sources_per_multi_cluster}`);
  console.log(`max sources in a single cluster: ${report.source_diversity.max_sources_per_cluster}`);
  console.log(`multi-member clusters with duplicate source: ${report.source_diversity.duplicate_source_clusters}  (violates dedupe guard)`);

  banner("PRECISION PROBE — weak intra-cluster pairs");
  console.log(`intra-cluster pairs scored: ${report.intra_pairs_scored}`);
  console.log(`weak pairs: ${report.precision_probe_count}  (${pct(report.precision_probe_count, report.intra_pairs_scored)} of intra-pairs)`);
  for (const s of report.samples.precision) printSample(`  cluster=${String(s.cluster_id).slice(0, 8)}`, s);

  banner("RECALL PROBE — cross-cluster pairs that SHOULD have merged");
  console.log(`cross-cluster pairs scored: ${report.cross_pairs_scored}`);
  if (report.max_pairs_hit) {
    console.log(`  (hit MAX_PAIRS=${report.max_pairs} — stopping pair scoring; recall_probe_count is a lower bound)`);
  }
  console.log(`pairs above threshold: ${report.recall_probe_count}  (${pct(report.recall_probe_count, report.cross_pairs_scored)})`);
  console.log(`would-merge components (>=2 members): ${report.would_merge_component_count}`);
  for (const s of report.samples.recall) {
    printSample(`  ${s.a_cluster ? `c=${String(s.a_cluster).slice(0, 6)}` : "unassigned"} vs ${s.b_cluster ? `c=${String(s.b_cluster).slice(0, 6)}` : "unassigned"}`, s);
  }

  banner("UNASSIGNED ARTICLES");
  console.log(`${report.unassigned_count} unassigned articles in window`);
  console.log(`unassigned articles appearing in >=1 would-merge pair: ~${report.unassigned_with_candidate_endpoints} pair-endpoints`);

  banner("NEAR-MISS DISTRIBUTION (cross-cluster pairs)");
  printHistogram(report.near_miss_histogram);

  banner("BLINDSPOT CONTRACT CHECK");
  console.log(`clusters with >=5 members: ${report.blindspot_eligible_clusters}`);
  console.log(`stored is_blindspot disagreeing with detectBlindspot(): ${report.blindspot_flip_count}  (${pct(report.blindspot_flip_count, report.blindspot_eligible_clusters)})`);

  banner("BOTTOM LINE");
  console.log(`singleton cluster rate:        ${pct(report.singleton_count, report.cluster_count)}`);
  console.log(`precision-glue pairs:          ${report.precision_probe_count} / ${report.intra_pairs_scored}  (${pct(report.precision_probe_count, report.intra_pairs_scored)})`);
  console.log(`recall-miss pairs (>= thresh): ${report.recall_probe_count} / ${report.cross_pairs_scored}  (${pct(report.recall_probe_count, report.cross_pairs_scored)})`);
  console.log(`estimated clusters to collapse if all recall misses were merged: ~${report.would_merge_component_count}`);
  console.log(`blindspot flip rate:           ${(report.blindspot_flip_rate * 100).toFixed(1)}%`);
  console.log("");
  console.log("Interpretation guide:");
  console.log("  - high singleton rate + many recall-miss pairs → under-merging (threshold too high or signals too weak).");
  console.log("  - many weak intra-cluster pairs → over-merging (entity-glue or aggregator source dragging stories together).");
  console.log("  - nonzero blindspot flip rate → recompute_blindspot_flags() hasn't been re-run since the contract or data changed.");
}

main().catch((err) => {
  console.error("audit failed:", err);
  process.exit(1);
});
