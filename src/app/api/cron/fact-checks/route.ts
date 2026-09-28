import { connection, NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import Parser from "rss-parser";

import { createServerClient } from "@/lib/supabase/server";
import { requireCronBearer } from "@/lib/api/bearer";
import { apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { captureServerException } from "@/lib/sentry/server";
import { FACT_CHECK_FEEDS, type FactCheckPublisher } from "@/lib/fact-checks/feeds";
import { normalizeFeedItems } from "@/lib/fact-checks/normalize";
import {
  CANDIDATE_WINDOW_DAYS,
  MATCH_METHOD,
  buildFtsQuery,
  extractFactCheckTerms,
  rankMatches,
  type ClusterDoc,
} from "@/lib/fact-checks/match";

/**
 * Vercel cron -- "Bu konuda doğrulama" fact-check link ingest (migration
 * 080). Fetches every verified fact-check feed (feeds.ts), upserts new
 * articles into `fact_checks`, then runs the pure keyword matcher
 * (match.ts) against a recent-cluster candidate set to write/promote rows
 * in `cluster_fact_checks`.
 *
 * COPYRIGHT: only headline + link ever reach the database. RSS
 * `<category>` terms are kept in-memory for this run only (keyed by url)
 * and are never stored.
 *
 * SSRF: only the hard-coded FACT_CHECK_FEEDS URLs are fetched. After
 * following redirects, the FINAL host is re-checked against the
 * publisher's allow-list (a redirect to an attacker-controlled host is
 * rejected even though the request started at a trusted URL). 10s timeout,
 * 2MB response cap.
 *
 * AUTH: same `requireCronBearer` contract as `/api/cron/headline` --
 * FAIL-CLOSED 503 on a missing `CRON_SECRET`, 401 on a bad/missing bearer.
 */
export const maxDuration = 60;

const factCheckLimit = createRateLimiter("cron-fact-checks", {
  capacity: 3,
  refillPerSecond: 1 / 60,
});

// Only fact-checks published within this window are candidates for
// cluster matching -- an older item has already had its shot at every
// cluster that could plausibly still be "recent" for a reader.
const RECENT_WINDOW_DAYS = 3;
const RECENT_ITEM_LIMIT = 40;
const CLUSTER_CANDIDATE_LIMIT = 25;

interface FeedStatus {
  status: "ok" | "error";
  items: number;
  error?: string;
}

interface FetchedFeedItem {
  row: { publisher: string; url: string; title: string; published_at: string };
  categories: string[];
}

async function fetchFeed(
  p: FactCheckPublisher,
): Promise<{ key: string; status: FeedStatus; items: FetchedFeedItem[] }> {
  try {
    const res = await fetch(p.feedUrl as string, {
      headers: {
        "User-Agent": "TayfBot/1.0 (fact-check links)",
        Accept:
          "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.1",
      },
      signal: AbortSignal.timeout(10_000),
      redirect: "follow",
    });

    if (!res.ok) {
      return {
        key: p.key,
        status: { status: "error", items: 0, error: `http ${res.status}` },
        items: [],
      };
    }

    // SSRF / redirect guard: the final host (after any redirect) must
    // still belong to the publisher. `res.url` can be empty for a
    // hand-constructed Response (tests); fall back to the requested URL.
    const finalUrl = res.url || (p.feedUrl as string);
    let finalHost = "";
    try {
      finalHost = new URL(finalUrl).host;
    } catch {
      // fall through: empty host never matches the allow-list below.
    }
    if (!p.hosts.includes(finalHost)) {
      return {
        key: p.key,
        status: { status: "error", items: 0, error: "host mismatch after redirect" },
        items: [],
      };
    }

    const text = await res.text();
    if (text.length > 2_000_000) {
      return {
        key: p.key,
        status: { status: "error", items: 0, error: "response too large" },
        items: [],
      };
    }

    const parser = new Parser();
    const feed = await parser.parseString(text);
    const normalized = normalizeFeedItems(p, feed.items ?? [], Date.now());

    return {
      key: p.key,
      status: { status: "ok", items: normalized.length },
      items: normalized as FetchedFeedItem[],
    };
  } catch (err) {
    return {
      key: p.key,
      status: {
        status: "error",
        items: 0,
        error: err instanceof Error ? err.message : "fetch failed",
      },
      items: [],
    };
  }
}

interface RecentFactCheckRow {
  id: string;
  publisher: string;
  url: string;
  title: string;
  published_at: string;
}

interface ClusterCandidateRow {
  id: string;
  title_tr: string | null;
  title_tr_neutral: string | null;
}

type ClusterArticleNested = { title: string | null };
interface ClusterArticleRow {
  cluster_id: string;
  articles: ClusterArticleNested | ClusterArticleNested[] | null;
}

interface ExistingLinkRow {
  cluster_id: string;
  fact_check_id: string;
  is_published: boolean;
  decided_by: string;
}

export const GET = withApiErrors(async (request: Request) => {
  // Next.js 16 cacheComponents: `await connection()` before touching
  // `request.headers` so a build-time prerender never reads a real
  // request. See src/app/api/cron/headline/route.ts.
  await connection();

  const auth = requireCronBearer(request);
  if (!auth.ok) {
    return auth.response;
  }

  const rl = factCheckLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  const supabase = createServerClient();

  // 1. Fetch every verified feed in parallel. A failing feed is recorded
  // in the response and never fails the run.
  const settled = await Promise.allSettled(FACT_CHECK_FEEDS.map(fetchFeed));

  const feedsStatus: Record<string, FeedStatus> = {};
  const categoriesByUrl = new Map<string, string[]>();
  const rowsToUpsert: FetchedFeedItem["row"][] = [];

  settled.forEach((s, i) => {
    const p = FACT_CHECK_FEEDS[i]!;
    if (s.status === "fulfilled") {
      feedsStatus[p.key] = s.value.status;
      for (const { row, categories } of s.value.items) {
        rowsToUpsert.push(row);
        categoriesByUrl.set(row.url, categories);
      }
    } else {
      feedsStatus[p.key] = {
        status: "error",
        items: 0,
        error: s.reason instanceof Error ? s.reason.message : "rejected",
      };
    }
  });

  // 2. Upsert fact-checks. ignoreDuplicates means a re-seen url is a no-op
  // (fact_checks rows are otherwise immutable once written).
  let upserted = 0;
  if (rowsToUpsert.length > 0) {
    const { error: upsertErr } = await supabase
      .from("fact_checks")
      .upsert(rowsToUpsert, { onConflict: "url", ignoreDuplicates: true });
    if (upsertErr) {
      return apiServerError(upsertErr);
    }
    upserted = rowsToUpsert.length;
  }

  // 3. Pick recent published items to match against clusters.
  const since = new Date(
    Date.now() - RECENT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const { data: recentData, error: recentErr } = await supabase
    .from("fact_checks")
    .select("id, publisher, url, title, published_at")
    .eq("is_published", true)
    .gte("published_at", since)
    .order("published_at", { ascending: false })
    .limit(RECENT_ITEM_LIMIT);

  if (recentErr) {
    return apiServerError(recentErr);
  }

  const recentItems = (recentData ?? []) as RecentFactCheckRow[];

  let matched = 0;
  let published = 0;
  let shadow = 0;
  const publishedClusterIds = new Set<string>();

  for (const item of recentItems) {
    const categories = categoriesByUrl.get(item.url) ?? [];
    const terms = extractFactCheckTerms(item.title, categories);
    const ftsQuery = buildFtsQuery(terms);
    if (!ftsQuery) continue;

    const publishedAtMs = new Date(item.published_at).getTime();
    const gteWindow = new Date(
      publishedAtMs - CANDIDATE_WINDOW_DAYS.before * 24 * 60 * 60 * 1000,
    ).toISOString();
    const lteWindow = new Date(
      publishedAtMs + CANDIDATE_WINDOW_DAYS.after * 24 * 60 * 60 * 1000,
    ).toISOString();

    // 4. Find candidate clusters via the search_tsv GIN index.
    const { data: clusterData, error: clusterErr } = await supabase
      .from("clusters")
      .select("id, title_tr, title_tr_neutral")
      .eq("is_archived", false)
      .gte("article_count", 2)
      .gte("updated_at", gteWindow)
      .lte("first_published", lteWindow)
      .textSearch("search_tsv", ftsQuery, { config: "turkish", type: "websearch" })
      .order("article_count", { ascending: false })
      .limit(CLUSTER_CANDIDATE_LIMIT);

    if (clusterErr) {
      console.error("[fact-checks-cron] cluster search failed", item.id, clusterErr);
      captureServerException(clusterErr, { factCheckId: item.id });
      continue;
    }

    const clusters = (clusterData ?? []) as ClusterCandidateRow[];
    if (clusters.length === 0) continue;

    const clusterIds = clusters.map((c) => c.id);
    const { data: memberData, error: memberErr } = await supabase
      .from("cluster_articles")
      .select("cluster_id, articles ( title )")
      .in("cluster_id", clusterIds)
      .limit(1000);

    if (memberErr) {
      console.error("[fact-checks-cron] member fetch failed", item.id, memberErr);
      captureServerException(memberErr, { factCheckId: item.id });
      continue;
    }

    const memberTitlesByCluster = new Map<string, string[]>();
    for (const row of (memberData ?? []) as ClusterArticleRow[]) {
      const a = Array.isArray(row.articles) ? row.articles[0] : row.articles;
      if (!a?.title) continue;
      const titles = memberTitlesByCluster.get(row.cluster_id) ?? [];
      titles.push(a.title);
      memberTitlesByCluster.set(row.cluster_id, titles);
    }

    const docs: ClusterDoc[] = clusters.map((c) => ({
      id: c.id,
      headline: c.title_tr_neutral ?? c.title_tr ?? "",
      memberTitles: memberTitlesByCluster.get(c.id) ?? [],
    }));

    const ranked = rankMatches(terms, docs);
    if (ranked.length === 0) continue;
    matched++;

    // 5. Write links: read existing rows for this fact-check, then
    // insert new pairs / promote eligible shadow rows. Admin-decided rows
    // and already-published auto rows are never touched.
    const { data: existingData, error: existingErr } = await supabase
      .from("cluster_fact_checks")
      .select("cluster_id, fact_check_id, is_published, decided_by")
      .in("fact_check_id", [item.id]);

    if (existingErr) {
      console.error("[fact-checks-cron] existing links fetch failed", item.id, existingErr);
      captureServerException(existingErr, { factCheckId: item.id });
      continue;
    }

    const existingByCluster = new Map<string, ExistingLinkRow>();
    for (const row of (existingData ?? []) as ExistingLinkRow[]) {
      existingByCluster.set(row.cluster_id, row);
    }

    const newRows: Array<{
      cluster_id: string;
      fact_check_id: string;
      score: number;
      matched_terms: string[];
      method: string;
      is_published: boolean;
    }> = [];

    for (const r of ranked) {
      const isPublishDecision = r.decision === "publish";
      const existing = existingByCluster.get(r.clusterId);

      if (!existing) {
        newRows.push({
          cluster_id: r.clusterId,
          fact_check_id: item.id,
          score: r.score,
          matched_terms: r.matched,
          method: MATCH_METHOD,
          is_published: isPublishDecision,
        });
        if (isPublishDecision) {
          published++;
          publishedClusterIds.add(r.clusterId);
        } else {
          shadow++;
        }
        continue;
      }

      // Promote an existing auto-decided shadow row when the decision is
      // now publish. Never touches admin rows or an already-published row.
      if (
        existing.decided_by === "auto" &&
        !existing.is_published &&
        isPublishDecision
      ) {
        const { error: promoteErr } = await supabase
          .from("cluster_fact_checks")
          .update({ is_published: true, score: r.score, matched_terms: r.matched })
          .eq("cluster_id", r.clusterId)
          .eq("fact_check_id", item.id)
          .eq("decided_by", "auto")
          .eq("is_published", false);

        if (promoteErr) {
          console.error(
            "[fact-checks-cron] promote failed",
            item.id,
            r.clusterId,
            promoteErr,
          );
          captureServerException(promoteErr, {
            factCheckId: item.id,
            clusterId: r.clusterId,
          });
        } else {
          published++;
          publishedClusterIds.add(r.clusterId);
        }
      }
      // Otherwise (admin row, or already-published auto row): untouched.
    }

    if (newRows.length > 0) {
      const { error: insertErr } = await supabase
        .from("cluster_fact_checks")
        .upsert(newRows, {
          onConflict: "cluster_id,fact_check_id",
          ignoreDuplicates: true,
        });
      if (insertErr) {
        console.error("[fact-checks-cron] insert links failed", item.id, insertErr);
        captureServerException(insertErr, { factCheckId: item.id });
      }
    }
  }

  // 6. Revalidate every cluster that gained a newly-published link this
  // cycle. Best-effort: a throw here must never turn a successful cron
  // cycle into a 500.
  try {
    for (const clusterId of publishedClusterIds) {
      revalidateTag(`fact-checks:${clusterId}`, "max");
    }
  } catch (err) {
    console.error("[fact-checks-cron] revalidateTag failed", err);
  }

  return NextResponse.json({
    success: true,
    feeds: feedsStatus,
    upserted,
    matched,
    published,
    shadow,
    timestamp: new Date().toISOString(),
  });
});
