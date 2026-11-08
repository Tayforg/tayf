import { cache } from "react";
import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";

import type { ZoneHistoryEntry } from "@/components/source/label-card";
import { cleanOutboundUrl } from "@/lib/articles/outbound-url";
import { attemptCached } from "@/lib/cache-resilience";
import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import { isRowQuarantined } from "@/lib/sources/feed-status";
import { classifySilence } from "@/lib/sources/silence-reason";
import { selectSourceRecentArticles } from "@/lib/sources/source-recent-filter";
import { createReaderClient } from "@/lib/supabase/server";
import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { isValidSourceSlug } from "@/lib/validation/source-input";
import type { BiasCategory, Source } from "@/types";

// Data layer for /source/[slug] (single-source profile page).
//
// Why this is its own module: the page used to do the read inside a
// `"use cache"` function that THREW on a Supabase error. That is wrong in two
// ways on a cold Micro database (4 s reader cap -> AbortError):
//   1. a throw across the `"use cache"` boundary fails `next build`'s
//      prerender (see src/lib/cache-resilience.ts), and
//   2. the page's callers could not tell "the read timed out" from "there is
//      no such source", so a timeout risked rendering the 404 for a real
//      source.
// Here the cached body never throws (`attemptCached`), picks its lifetime from
// the outcome, and the public entry point only ever returns `null` for "no
// such source" - a sustained failure THROWS so the root error boundary
// (src/app/error.tsx: noindex, "Tekrar dene") renders instead of a 404.

export interface ArticleRow {
  id: string;
  title: string;
  description: string | null;
  url: string;
  image_url: string | null;
  published_at: string;
}

// S-20/M-04 registry columns (migration 055) - not yet on the shared
// `Source` type, so extended locally here rather than editing `@/types`.
interface SourceRegistryFields {
  zone_rationale: string | null;
  zone_rationale_at: string | null;
  trustee_since: string | null;
  trustee_note: string | null;
}

// Ingest quarantine end (migration 074) - not on the shared `Source` type either.
interface SourceFeedFields {
  fetch_quarantined_until: string | null;
}

// Fetch state columns the frozen-feed verdict reads (migrations 074 and 119),
// the same four /kaynaklar/durum reads in feed-status.ts. Optional on purpose:
// a row (or a test fixture) that lacks them reads as "status unknown", which
// `classifySilence` answers with 'erişim yok', never with 'akış donmuş'.
interface SourceFeedStateFields {
  fetch_last_status?: number | null;
  fetch_fail_streak?: number | null;
  fetch_newest_item_at?: string | null;
  fetch_items_count?: number | null;
}

export type SourceWithRegistry = Source &
  SourceRegistryFields &
  SourceFeedFields &
  SourceFeedStateFields;

export interface ZoneHistoryRow {
  old_bias: string | null;
  new_bias: string;
  reason: string | null;
  rater: string | null;
  changed_at: string;
}

export interface SourceProfile {
  source: SourceWithRegistry;
  /**
   * True while `fetch_quarantined_until` is still in the future, decided when the
   * profile was read (cache fill time), so rendering it never touches the clock.
   * Says nothing about `source.active`: an inactive source can carry a stale
   * quarantine, and the page shows the inactive line for it.
   */
  quarantined: boolean;
  /**
   * h74-sourcepages-3: the feed answers (2xx or 304, no failure streak, not
   * quarantined) but is frozen: it holds no items, or its newest item is more
   * than 72 h old. Exactly the sources /kaynaklar/durum labels 'akış donmuş':
   * the status page's silent gate is applied first (the newest stored article
   * published at or before now is missing or older than FEED_YIELD_WINDOW_MS; a
   * source that still delivers is never classified), then `classifySilence`
   * decides, with the same `nowMs` as `quarantined`, so it never touches the
   * clock at render time. Always false for a quarantined source (that is
   * `quarantined`'s state, not this one). Like `quarantined` it says nothing
   * about `source.active`: the page shows the inactive line first.
   */
  feedFrozen: boolean;
  /**
   * `sources.fetch_newest_item_at` as stored: the newest item date the feed
   * reported at its last parse, or null (never measured, empty or undated feed).
   */
  newestFeedItemAt: string | null;
  articleCount7d: number;
  articles: ArticleRow[];
  zoneHistory: ZoneHistoryEntry[];
}

// h61-journey-3: 'Son haberler' hides an UNCLUSTERED article that matches the
// site's private-individual filter (see source-recent-filter.ts), so the list
// is read from a wider newest-first window and sliced back to
// SOURCE_RECENT_LIMIT (20) after filtering. 40 is twice the page size: a source
// whose newest 25 items are crime briefs still fills most of the list, and the
// payload stays small.
export const SOURCE_RECENT_FETCH = 40;

// Which of `ids` sit in at least one cluster. Deliberately non-fatal: a failed
// (or throwing) read is logged and answers "none", so the unclustered filter
// then drops every flagged row (fail closed) while the profile still renders.
// Throwing here would instead turn a secondary read into the error boundary.
async function readClusteredIds(
  supabase: ReturnType<typeof createReaderClient>,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  if (ids.length === 0) return new Set();
  try {
    const { data, error } = await supabase
      .from("cluster_articles")
      .select("article_id")
      .in("article_id", ids as string[]);
    if (error) {
      console.error("[source-profile] cluster membership query failed", error);
      return new Set();
    }
    return new Set(
      ((data ?? []) as { article_id: string }[]).map((r) => r.article_id),
    );
  } catch (err) {
    console.error("[source-profile] cluster membership query threw", err);
    return new Set();
  }
}

// Uncached implementation. THROWS on a source, count or articles query error
// (never returns null for a failure); returns null only when no row matches
// the slug. A zone-history failure is deliberately non-fatal.
async function fetchSourceProfile(slug: string): Promise<SourceProfile | null> {
  const supabase = createReaderClient();

  const { data: sourceRow, error: sourceError } = await supabase
    .from("sources")
    .select(
      "id, name, slug, url, rss_url, bias, logo_url, active, kind, image_allowed, excerpt_allowed, zone_rationale, zone_rationale_at, trustee_since, trustee_note, fetch_quarantined_until, fetch_last_status, fetch_fail_streak, fetch_newest_item_at, fetch_items_count",
    )
    .eq("slug", slug)
    .maybeSingle();

  // `maybeSingle` returns null (not an error) when no row matches; only a
  // genuine query failure should throw. notFound() is handled by the page.
  if (sourceError) {
    throw new Error(`source query failed: ${sourceError.message}`);
  }
  if (!sourceRow) return null;

  const source = sourceRow as SourceWithRegistry;

  // Three read-only fetches that depend only on source.id - fire in
  // parallel (one round-trip). The 7-day count uses head/exact to avoid
  // pulling row bodies; the recent-articles list reads a bounded window of
  // SOURCE_RECENT_FETCH rows (filtered and cut to 20 below); the zone-history
  // list is capped at 20, newest first.
  // The one clock read of this module, inside the cache scope: it anchors the
  // 7-day window and the quarantine verdict (h47-sources-1) alike.
  const nowMs = Date.now();
  const sevenDaysAgo = new Date(nowMs - 7 * 24 * 60 * 60 * 1000).toISOString();

  const [countResult, articlesResult, historyResult] = await Promise.all([
    supabase
      .from("articles")
      .select("id", { count: "exact", head: true })
      .eq("source_id", source.id)
      .gte("published_at", sevenDaysAgo),
    supabase
      .from("articles")
      .select("id, title, description, url, image_url, published_at")
      .eq("source_id", source.id)
      .order("published_at", { ascending: false })
      .limit(SOURCE_RECENT_FETCH),
    supabase
      .from("source_zone_history")
      .select("old_bias, new_bias, reason, rater, changed_at")
      .eq("source_id", source.id)
      .order("changed_at", { ascending: false })
      .limit(20),
  ]);

  if (countResult.error) {
    throw new Error(`count query failed: ${countResult.error.message}`);
  }
  if (articlesResult.error) {
    throw new Error(`articles query failed: ${articlesResult.error.message}`);
  }
  // Deliberately non-fatal, unlike the two checks above: a
  // source_zone_history read failure renders the card without a history
  // list (LabelCard's own empty state) rather than failing the whole
  // profile over a secondary, non-essential fetch. Still logged (not
  // swallowed) so a permanently-broken query doesn't silently masquerade
  // as the honest "Bu etiket hiç değişmedi." empty state forever.
  if (historyResult.error) {
    console.error(
      "[source-profile] zone history query failed",
      historyResult.error,
    );
  }
  const zoneHistory: ZoneHistoryEntry[] = historyResult.error
    ? []
    : ((historyResult.data ?? []) as ZoneHistoryRow[]).map((row) => ({
        oldBias: row.old_bias as BiasCategory | null,
        newBias: row.new_bias as BiasCategory,
        reason: row.reason,
        rater: row.rater,
        changedAt: row.changed_at,
      }));

  // Read-time repair of double-encoded feed residue ("&quot;", "&#39;"):
  // rows stored before the ingest fix still carry it. Pure and non-throwing,
  // so it is safe inside the "use cache" body.
  // h24-feeds-3: the href gets the cleaned url (a literal '&#038;' decoded,
  // utm_*/fbclid/gclid dropped); the stored url is the upsert key and is
  // not touched.
  const repaired: ArticleRow[] = ((articlesResult.data ?? []) as ArticleRow[]).map(
    (a) => ({
      ...a,
      url: cleanOutboundUrl(a.url),
      title: repairEntityResidue(a.title),
      description:
        typeof a.description === "string"
          ? repairEntityResidue(a.description)
          : null,
    }),
  );
  // h61-journey-3: judged on the repaired text the visitor would read, and
  // only for articles outside every cluster (clustered ones are political and
  // already public on their cluster page). No clock read: the 7-day count, the
  // label card and the zone history above are untouched.
  const clusteredIds = await readClusteredIds(
    supabase,
    repaired.map((a) => a.id),
  );

  // h74-sourcepages-3: the quarantine and frozen-feed verdicts share the one
  // clock read above. `classifySilence` is the rule behind /kaynaklar/durum's
  // 'akış donmuş', so the profile and the status page agree; a quarantined
  // source classifies as 'erişim yok' there, hence never frozen here.
  // The status page classifies only a SILENT source: its newest stored article
  // with published_at <= now (its `.lte("latest.published_at", now)` embed; a
  // future-dated pubDate never counts as delivering) is missing or more than
  // FEED_YIELD_WINDOW_MS old (strict, a last item exactly at the edge still
  // delivers). `repaired` is the articles read newest first, before the
  // private-individual filter, so its first row at or before now is that embed.
  const quarantined = isRowQuarantined(source.fetch_quarantined_until, nowMs);
  const newestFeedItemAt = source.fetch_newest_item_at ?? null;
  const newestStoredMs = repaired
    .map((a) => Date.parse(a.published_at))
    .find((ms) => Number.isFinite(ms) && ms <= nowMs);
  const silent =
    newestStoredMs === undefined || nowMs - newestStoredMs > FEED_YIELD_WINDOW_MS;
  const feedFrozen =
    silent &&
    classifySilence(
      {
        lastHttpStatus: source.fetch_last_status ?? null,
        failStreak: source.fetch_fail_streak ?? 0,
        quarantined,
        newestFeedItemAt,
        feedItemsCount: source.fetch_items_count ?? null,
      },
      nowMs,
    ) === "akis_donmus";

  return {
    source,
    quarantined,
    feedFrozen,
    newestFeedItemAt,
    articleCount7d: countResult.count ?? 0,
    articles: selectSourceRecentArticles(repaired, clusteredIds),
    zoneHistory,
  };
}

// Cached entry. Never throws (`attemptCached`): a failure is returned as
// `{ ok: false }` and memoised only for `minutes`; a success - including the
// legitimate "no such source" `null` - keeps the normal source-directory
// lifetime. Exactly ONE `cacheLife` per invocation, chosen after the attempt.
// The clock read inside `fetchSourceProfile` is inside this cache scope.
async function getSourceProfileCached(slug: string) {
  "use cache";
  cacheTag("sources", "articles");
  const r = await attemptCached("source-profile", () => fetchSourceProfile(slug));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Source profile for /source/[slug] (and its metadata). `null` means exactly
 * one thing: no such source (or a slug that can never be one). A sustained
 * read failure - the cached attempt AND one live retry both failing - THROWS,
 * so the caller renders the error boundary rather than a 404. React `cache`
 * dedupes the page body and `generateMetadata` within a request.
 */
export const getSourceProfile = cache(
  async (slug: string): Promise<SourceProfile | null> => {
    // Cheap guard: a slug the registry can never contain is a clean 404 and
    // must not cost a database round-trip.
    if (!isValidSourceSlug(slug)) return null;

    const attempt = await getSourceProfileCached(slug);
    if (attempt.ok) return attempt.data;

    // The live retry reads the clock (7-day window); Next 16 prerender forbids
    // that in an uncached path, so opt this request into dynamic rendering
    // first. Only reached after a failed cached attempt.
    await connection();
    return fetchSourceProfile(slug);
  },
);
