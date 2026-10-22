import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import {
  createReaderClient,
  createServerClient,
  type ReadProfile,
} from "@/lib/supabase/server";
import type { BiasCategory } from "@/types";
import type { SummaryMember } from "./summary-attribution";

// RSS-only member projection for summary attribution. rss.xml needs the
// same seed-matching / wire-majority logic as the cluster detail page
// (summary-attribution.ts) but must not widen politics-query.ts's
// CLUSTER_EMBED_SELECT — that query is shared by every reader of the
// cached home feed. This module runs one extra, RSS-only Supabase query,
// bounded to the <=30 cluster ids the feed already chose, and selects
// only the columns SummaryMember needs (source name/bias, article
// published_at/content_hash/description) — never rss_url/url/slug/id.
//
// TODO(follow-up): this duplicates ~20 lines of the embedded-select /
// same-source-dedupe logic in cluster-detail-query.ts and politics-
// query.ts's flattenClusterMembers. Both files are out of scope for this
// pass; factoring a shared helper is follow-up debt, not silently
// copy-pasted without this note.

// BL-13: `excerpt_allowed` optional/undefined is treated as allowed by
// dedupeBySource below and by summaryAttribution's own gate — see
// summary-attribution.ts.
type EmbeddedSourceRow = {
  name: string;
  bias: BiasCategory;
  excerpt_allowed?: boolean;
};

type EmbeddedArticleRow = {
  source_id: string;
  published_at: string;
  content_hash: string | null;
  description: string | null;
  sources: EmbeddedSourceRow | null;
};

type Row = {
  cluster_id: string;
  articles: EmbeddedArticleRow | null;
};

/** Same-source dedupe, earliest article per source_id — mirrors politics-query.ts's flattenClusterMembers/buildClusterBundle so the wire-majority check here runs over the same member set isWireRedistribution was computed from. */
function dedupeBySource(rows: EmbeddedArticleRow[]): SummaryMember[] {
  const sorted = [...rows].sort(
    (a, b) => new Date(a.published_at).getTime() - new Date(b.published_at).getTime(),
  );
  const seen = new Set<string>();
  const members: SummaryMember[] = [];
  for (const row of sorted) {
    if (seen.has(row.source_id)) continue;
    seen.add(row.source_id);
    const source = row.sources;
    if (!source) continue;
    members.push({
      source: {
        name: source.name,
        bias: source.bias,
        excerpt_allowed: source.excerpt_allowed,
      },
      article: {
        published_at: row.published_at,
        content_hash: row.content_hash,
        description: row.description,
      },
    });
  }
  return members;
}

// Internal, uncached implementation. THROWS on a Supabase error/exception.
// The cached wrapper below converts that throw into a `{ ok: false }` sentinel
// (never let it cross the "use cache" boundary), and the public entry's live
// retry calls this directly.
//
// "reader" (/rss.xml) fails fast at 4 s; "batch" (the weekly digest cron)
// keeps the plain client so a cold read can use the 8 s statement_timeout
// instead of skipping the run.
async function fetchRssSummaryMembers(
  clusterIds: string[],
  profile: ReadProfile,
): Promise<Record<string, SummaryMember[]>> {
  const supabase =
    profile === "batch" ? createServerClient() : createReaderClient();
  const { data, error } = await supabase
    .from("cluster_articles")
    .select(
      `cluster_id, articles ( source_id, published_at, content_hash, description, sources ( name, bias, excerpt_allowed ) )`,
    )
    .in("cluster_id", clusterIds)
    .returns<Row[]>();

  if (error) {
    throw new Error(`[rss-summary-attribution] query error: ${error.message}`);
  }

  const byCluster = new Map<string, EmbeddedArticleRow[]>();
  for (const row of data ?? []) {
    if (!row.articles) continue;
    const list = byCluster.get(row.cluster_id) ?? [];
    list.push(row.articles);
    byCluster.set(row.cluster_id, list);
  }

  const result: Record<string, SummaryMember[]> = {};
  for (const [clusterId, rows] of byCluster) {
    result[clusterId] = dedupeBySource(rows);
  }
  return result;
}

// Cached entry. Build-safety: `attemptCached` swallows whatever
// `fetchRssSummaryMembers` throws, so nothing crosses the "use cache"
// boundary (a throw there fails `next build`'s prerender). A failed attempt is
// still cached, but only for `minutes` (exactly ONE `cacheLife` per
// invocation, chosen after the attempt) so one cold-read timeout cannot park
// an `{ ok: false }` sentinel for a whole `cluster-feed` window; the public
// entry's live retry heals it per request in the meantime.
//
// `profile` is an argument on purpose: it is part of the cache key, so a
// capped "reader" entry (or its cached failure) is never served to the
// "batch" digest cron, and the cron's own miss runs uncapped.
async function rssSummaryMembersCached(
  clusterIds: string[],
  profile: ReadProfile,
) {
  "use cache";
  cacheTag("clusters-politics");
  const r = await attemptCached("rss-summary-attribution", () =>
    fetchRssSummaryMembers(clusterIds, profile),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

export interface RssSummaryMembersResult {
  members: Record<string, SummaryMember[]>;
  /**
   * True only when the batched Supabase lookup itself errored/threw for
   * THIS request — never true just because a requested cluster id has no
   * matching rows. Callers must not conflate the two: `members[id]` being
   * absent is ambiguous on its own (see summary-attribution.ts's
   * resolveSummaryAttribution), but `lookupFailed` disambiguates it. A
   * caller that ignores this flag and always falls back to
   * summaryAttributionWithoutMembers on a missing entry would render
   * clusters.summary_tr verbatim — with no excerpt_allowed check at all —
   * for every cluster whenever this lookup fails, defeating the BL-13
   * rights gate.
   */
  lookupFailed: boolean;
}

// Public, uncached entry point. Lives OUTSIDE the cache boundary so a
// failure is never memoised: on a cached-attempt failure it retries the
// lookup live once (`resolveCachedOrRetry`), and only when that also fails
// does it return `{ members: {}, lookupFailed: true }` for THIS request - the
// next request gets a fresh attempt instead of a cached failure. Never
// throws. `lookupFailed` is the fail-closed-on-rights signal callers must
// check before falling back to summaryAttributionWithoutMembers (see that
// function and resolveSummaryAttribution in summary-attribution.ts): an empty
// `members` result alone is ambiguous between "no attributable members" (safe
// to degrade) and "the lookup broke" (must hide the excerpt, not degrade to
// it).
//
// `opts.profile` defaults to the capped "reader" (/rss.xml). The digest cron
// shares this lookup and must pass `{ profile: "batch" }` (CI guard:
// tests/guards/cron-read-profile.test.ts).
export async function getRssSummaryMembers(
  clusterIds: string[],
  opts?: { profile?: ReadProfile },
): Promise<RssSummaryMembersResult> {
  if (clusterIds.length === 0) return { members: {}, lookupFailed: false };

  const profile = opts?.profile ?? "reader";
  const members = await resolveCachedOrRetry<Record<
    string,
    SummaryMember[]
  > | null>(
    "rss-summary-attribution",
    () => rssSummaryMembersCached(clusterIds, profile),
    () => fetchRssSummaryMembers(clusterIds, profile),
    null,
  );
  if (members === null) return { members: {}, lookupFailed: true };
  return { members, lookupFailed: false };
}
