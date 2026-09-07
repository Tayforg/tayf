import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { apiError, withApiErrors } from "@/lib/api/errors";

/**
 * Operational metrics endpoint.
 *
 * Emits row counts for articles / clusters / sources plus a couple of
 * derived ratios used by the on-call dashboards and the post-deploy smoke
 * scripts. The shape is intentionally flat-and-stable: dashboards key off
 * specific field names and breaking changes here cascade into the alert
 * runbooks. Bump the contract carefully.
 *
 * AUTH
 * ----
 * Gated behind `Authorization: Bearer ${CRON_SECRET}`. The data exposed
 * (queue depths, article-age, blindspot counts) is operational
 * reconnaissance — useful to anyone running the dashboards, dangerous in
 * an attacker's hands when timing pressure on the pipeline. The bearer
 * gate is the shared `requireCronBearer` helper (`src/lib/api/bearer.ts`):
 * constant-time compare, FAIL-CLOSED 503 when `CRON_SECRET` is unset.
 *
 * Wrapped in `withApiErrors` so an unexpected throw (Supabase RPC quirk,
 * row-count overflow, etc.) returns the canonical JSON-500 envelope and
 * lands in Sentry rather than rendering Next's default HTML error page.
 */

interface Metrics {
  timestamp: string;
  articles: {
    total: number;
    last24h: number;
    lastHour: number;
    politicsNullImage: number;
    /**
     * All politics-tier articles (politika / son_dakika) — the denominator
     * for `politicsImageMissingRatio` below.
     */
    politicsTotal: number;
    withImage: number;
    /**
     * politicsNullImage / politicsTotal, rounded to two decimals; 0 when
     * no politics-tier articles exist yet. The raw politicsNullImage count
     * is meaningless without this denominator — 15 missing images is noise
     * across 10k politics articles and a crisis across 30.
     */
    politicsImageMissingRatio: number;
  };
  clusters: {
    total: number;
    multiArticle: number;
    blindspots: number;
    /**
     * Mean article count across ALL clusters (singletons included).
     * Singleton clusters drag this toward 1 as the corpus ages, so read it
     * as a corpus-shape signal, not a clustering-quality one. Kept stable —
     * dashboards already chart it.
     */
    avgArticlesPerCluster: number;
    /**
     * Mean article count across multi-article clusters only. Every
     * singleton holds exactly one article, so the multi-cluster article
     * mass is `total articles - (total clusters - multiArticle)`. Rounded
     * to two decimals; 0 when no multi-article clusters exist yet.
     */
    avgArticlesPerMultiCluster: number;
    /**
     * Multi-article clusters eligible for the neutral-headline rewrite
     * (article_count >= 3 per the /api/cron/headline batch query). On-call
     * pages on the ratio vs `neutralized` below; if drift exceeds a
     * threshold, headline cron has stalled.
     */
    neutralizedEligible: number;
    /** Clusters where `title_tr_neutral` has already been written. */
    neutralized: number;
    /**
     * Ratio of neutralized clusters to eligible clusters, rounded to two
     * decimals. 1.0 means headline cron is fully caught up; values below
     * 0.9 typically indicate cron drift.
     */
    neutralizedRatio: number;
    /**
     * Age in seconds of the oldest eligible cluster that has NOT been
     * neutralized yet. The most actionable single signal for headline-
     * cron health — a value rising past ~600 means the cron has skipped
     * at least one batch. Null when no pending neutralization work
     * exists (or when the row has no first_published timestamp, which is
     * itself an upstream bug).
     */
    oldestPendingNeutralAgeSec: number | null;
    /** Latest cluster_quality_snapshots row (039), or null before the first audit run. */
    quality: {
      takenAt: string;
      singletonRate: number;
      clusterCount: number;
      blindspotFlipRate: number;
    } | null;
  };
  sources: {
    total: number;
    active: number;
  };
  ingest: {
    /** sum(row_errors) over ingest_cycles finished in the last hour; 0 when empty. */
    rowErrorsLastHour: number;
  };
}

export const GET = withApiErrors(async (request: Request) => {
  // Stay dynamic — `cacheComponents` would otherwise prerender this and
  // pin a "100 articles, 0 clusters" snapshot into the CDN forever.
  await connection();

  // FAIL-CLOSED bearer gate (shared helper): a missing or empty CRON_SECRET
  // means we cannot enforce bearer auth, so we refuse the request with 503
  // rather than serving operational data anonymously; 401 on a missing or
  // mismatched token. Same gate as `/api/cron/headline`.
  const auth = requireCronBearer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const supabase = createServerClient();

  // Round-6 P1: the headline-cron health signals — `clustersNeutralizedEligible`,
  // `clustersNeutralized`, and `clustersOldestPendingNeutral` — are the
  // queries that make this endpoint actionable for the on-call rotation. The
  // ratio + age make headline-cron stalls page on age rather than on the
  // ratio alone (the ratio takes hours to drift visibly).
  const oldestPendingNeutralQuery = supabase
    .from("clusters")
    .select("first_published")
    .is("title_neutral_at", null)
    .gte("article_count", 3)
    .order("first_published", { ascending: true, nullsFirst: false })
    .limit(1)
    .maybeSingle();

  // 039: latest quality snapshot for the dashboard card; null before the
  // first `audit-clusters.mjs --persist` run.
  const latestQualitySnapshotQuery = supabase
    .from("cluster_quality_snapshots")
    .select("taken_at, singleton_rate, cluster_count, blindspot_flip_rate")
    .order("taken_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  // 039: row_errors summed client-side (no head-count aggregate over a sum
  // in supabase-js) — cheap, at most one row per ingest cycle per hour.
  const ingestRowErrorsQuery = supabase
    .from("ingest_cycles")
    .select("row_errors")
    .gte("finished_at", new Date(Date.now() - 3600_000).toISOString());

  // Run all the counts in parallel.
  const queries = [
    { name: "articlesTotal", q: supabase.from("articles").select("*", { count: "exact", head: true }) },
    { name: "articlesLast24h", q: supabase.from("articles").select("*", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 24 * 3600_000).toISOString()) },
    { name: "articlesLastHour", q: supabase.from("articles").select("*", { count: "exact", head: true }).gte("created_at", new Date(Date.now() - 3600_000).toISOString()) },
    { name: "politicsNullImage", q: supabase.from("articles").select("*", { count: "exact", head: true }).is("image_url", null).in("category", ["politika", "son_dakika"]) },
    { name: "politicsTotal", q: supabase.from("articles").select("*", { count: "exact", head: true }).in("category", ["politika", "son_dakika"]) },
    { name: "articlesWithImage", q: supabase.from("articles").select("*", { count: "exact", head: true }).not("image_url", "is", null) },
    { name: "clustersTotal", q: supabase.from("clusters").select("*", { count: "exact", head: true }) },
    { name: "clustersMulti", q: supabase.from("clusters").select("*", { count: "exact", head: true }).gte("article_count", 2) },
    { name: "clustersBlindspots", q: supabase.from("clusters").select("*", { count: "exact", head: true }).eq("is_blindspot", true) },
    { name: "clustersNeutralizedEligible", q: supabase.from("clusters").select("*", { count: "exact", head: true }).gte("article_count", 3) },
    { name: "clustersNeutralized", q: supabase.from("clusters").select("*", { count: "exact", head: true }).gte("article_count", 3).not("title_neutral_at", "is", null) },
    { name: "sourcesTotal", q: supabase.from("sources").select("*", { count: "exact", head: true }) },
    { name: "sourcesActive", q: supabase.from("sources").select("*", { count: "exact", head: true }).eq("active", true) },
  ];
  const [results, oldestPendingNeutralRes, latestQualitySnapshotRes, ingestRowErrorsRes] =
    await Promise.all([
      Promise.all(queries.map((entry) => entry.q)),
      oldestPendingNeutralQuery,
      latestQualitySnapshotQuery,
      ingestRowErrorsQuery,
    ]);

  // Surface any per-query Supabase errors instead of silently dropping them
  // into `?? 0` — the previous shape would flatline a metric on RPC failure
  // and the dashboard / on-call would see "zero articles" rather than a 5xx.
  // Round-4 critic finding documented this as a regression of an audit-era
  // anti-pattern resurfacing in a new file.
  const failed = results
    .map((r, i) => ({ name: queries[i]!.name, error: r.error }))
    .filter((entry) => entry.error !== null);
  if (failed.length > 0) {
    console.error("[metrics] supabase query failure", failed);
    return apiError(503, "metrics query failed", {
      code: "METRICS_QUERY_FAILED",
      details: { queries: failed.map((entry) => entry.name) },
    });
  }

  // results[i] is guaranteed defined: the `queries` array is a literal of
  // exactly 13 entries, so Promise.all returns exactly 13 results. The non-
  // null assertions below mirror that invariant for the strict tsconfig
  // (noUncheckedIndexedAccess); the alternative is a tuple type, which is
  // noisier for the same guarantee.
  const articlesTotal = results[0]!;
  const articlesLast24h = results[1]!;
  const articlesLastHour = results[2]!;
  const politicsNullImage = results[3]!;
  const politicsTotal = results[4]!;
  const articlesWithImage = results[5]!;
  const clustersTotal = results[6]!;
  const clustersMulti = results[7]!;
  const clustersBlindspots = results[8]!;
  const clustersNeutralizedEligible = results[9]!;
  const clustersNeutralized = results[10]!;
  const sourcesTotal = results[11]!;
  const sourcesActive = results[12]!;

  if (oldestPendingNeutralRes.error) {
    console.error(
      "[metrics] supabase oldest-pending-neutral query failure",
      oldestPendingNeutralRes.error,
    );
    return apiError(503, "metrics query failed", {
      code: "METRICS_QUERY_FAILED",
      details: { queries: ["oldestPendingNeutral"] },
    });
  }

  // Migration 039 adds cluster_quality_snapshots and ingest_cycles. During a
  // partially-applied migration window (this branch deployed to Vercel
  // before 039 lands on Supabase — see docs/migration-guide.md), PostgREST
  // reports the missing table as an *error* (PGRST205 / Postgres 42P01), not
  // empty data. Treat that one code as "no data yet" so the rest of this
  // pre-existing endpoint keeps working instead of hard-503ing; any other
  // error still fails closed below.
  const isMissingTable = (error: { code?: string } | null) =>
    error?.code === "PGRST205" || error?.code === "42P01";

  if (latestQualitySnapshotRes.error && !isMissingTable(latestQualitySnapshotRes.error)) {
    console.error(
      "[metrics] supabase latest-quality-snapshot query failure",
      latestQualitySnapshotRes.error,
    );
    return apiError(503, "metrics query failed", {
      code: "METRICS_QUERY_FAILED",
      details: { queries: ["latestQualitySnapshot"] },
    });
  }
  if (latestQualitySnapshotRes.error) {
    console.warn(
      "[metrics] cluster_quality_snapshots not found yet (migration 039 pending) — reporting quality: null",
    );
  }

  if (ingestRowErrorsRes.error && !isMissingTable(ingestRowErrorsRes.error)) {
    console.error(
      "[metrics] supabase ingest-row-errors query failure",
      ingestRowErrorsRes.error,
    );
    return apiError(503, "metrics query failed", {
      code: "METRICS_QUERY_FAILED",
      details: { queries: ["ingestRowErrors"] },
    });
  }
  if (ingestRowErrorsRes.error) {
    console.warn(
      "[metrics] ingest_cycles not found yet (migration 039 pending) — reporting rowErrorsLastHour: 0",
    );
  }

  const clustersCount = clustersTotal.count ?? 0;
  const multiClusterCount = clustersMulti.count ?? 0;
  const totalArticles = articlesTotal.count ?? 0;
  const politicsNullImageCount = politicsNullImage.count ?? 0;
  const politicsTotalCount = politicsTotal.count ?? 0;
  const eligibleCount = clustersNeutralizedEligible.count ?? 0;
  const neutralizedCount = clustersNeutralized.count ?? 0;
  const oldestPendingFirstPublished =
    (oldestPendingNeutralRes.data as { first_published: string | null } | null)
      ?.first_published ?? null;
  const oldestPendingAgeSec = oldestPendingFirstPublished
    ? Math.max(
        0,
        Math.floor((Date.now() - new Date(oldestPendingFirstPublished).getTime()) / 1000),
      )
    : null;

  const qualityRow = latestQualitySnapshotRes.data as {
    taken_at: string;
    singleton_rate: number | null;
    cluster_count: number | null;
    blindspot_flip_rate: number | null;
  } | null;
  const quality = qualityRow
    ? {
        takenAt: qualityRow.taken_at,
        singletonRate: qualityRow.singleton_rate ?? 0,
        clusterCount: qualityRow.cluster_count ?? 0,
        blindspotFlipRate: qualityRow.blindspot_flip_rate ?? 0,
      }
    : null;

  const ingestRowErrorRows =
    (ingestRowErrorsRes.data as { row_errors: number | null }[] | null) ?? [];
  const rowErrorsLastHour = ingestRowErrorRows.reduce(
    (sum, row) => sum + (row.row_errors ?? 0),
    0,
  );

  const body: Metrics = {
    timestamp: new Date().toISOString(),
    articles: {
      total: totalArticles,
      last24h: articlesLast24h.count ?? 0,
      lastHour: articlesLastHour.count ?? 0,
      politicsNullImage: politicsNullImageCount,
      politicsTotal: politicsTotalCount,
      withImage: articlesWithImage.count ?? 0,
      politicsImageMissingRatio: politicsTotalCount > 0
        ? Math.round((politicsNullImageCount / politicsTotalCount) * 100) / 100
        : 0,
    },
    clusters: {
      total: clustersCount,
      multiArticle: multiClusterCount,
      blindspots: clustersBlindspots.count ?? 0,
      avgArticlesPerCluster: clustersCount > 0 ? Math.round((totalArticles / clustersCount) * 100) / 100 : 0,
      avgArticlesPerMultiCluster: multiClusterCount > 0
        ? Math.round(((totalArticles - (clustersCount - multiClusterCount)) / multiClusterCount) * 100) / 100
        : 0,
      neutralizedEligible: eligibleCount,
      neutralized: neutralizedCount,
      neutralizedRatio: eligibleCount > 0
        ? Math.round((neutralizedCount / eligibleCount) * 100) / 100
        : 1,
      oldestPendingNeutralAgeSec: oldestPendingAgeSec,
      quality,
    },
    sources: {
      total: sourcesTotal.count ?? 0,
      active: sourcesActive.count ?? 0,
    },
    ingest: {
      rowErrorsLastHour,
    },
  };

  // Auth-gated operational data — must NOT be CDN-cached. The previous
  // `public, max-age=60` is gone because we no longer want any cache
  // layer between Vercel and the dashboard.
  return NextResponse.json(body, {
    headers: { "Cache-Control": "no-store" },
  });
});
