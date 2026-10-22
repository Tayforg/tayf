import { cacheLife, cacheTag } from "next/cache";
import { cache } from "react";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import { isStoryThreadsEnabled, isValidThreadSlug } from "./config";
import type { ThreadMemberCluster } from "./timeline";

// Public readers for "Gelişen hikaye" threads (migration 098). Both are
// never-throw: a missing migration, an outage or a draft all read as null.
// Only PUBLISHED threads are ever returned; status is re-checked in TS on
// top of the query filter.
//
// Reads run on the capped reader client (4 s), and a failed cache attempt is
// memoised for `minutes` only (a success keeps `hours`). The /hikaye/[slug]
// page uses `loadPublishedThreadBySlug` instead, which REJECTS on a sustained
// failure so a timeout is not served as a 404.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_LIMIT = 100;

export interface PublishedThread {
  id: string;
  slug: string;
  title: string;
  publishedAt: string | null;
  members: ThreadMemberCluster[];
}

export interface ClusterThreadRef {
  slug: string;
  title: string;
}

async function fetchThreadBySlug(slug: string): Promise<PublishedThread | null> {
  const supabase = createReaderClient();
  const { data: t, error: tErr } = await supabase
    .from("story_threads")
    .select("id, slug, title_tr, status, published_at")
    .eq("slug", slug)
    .eq("status", "published")
    .maybeSingle();
  if (tErr) throw new Error(`[story-threads] thread fetch error: ${tErr.message}`);
  if (!t || t.status !== "published") return null;
  if (typeof t.slug !== "string" || typeof t.title_tr !== "string" || t.title_tr === "") return null;

  const { data: mem, error: mErr } = await supabase
    .from("story_thread_members")
    .select("cluster_id")
    .eq("thread_id", t.id)
    .limit(MEMBER_LIMIT);
  if (mErr) throw new Error(`[story-threads] members fetch error: ${mErr.message}`);
  const ids = (Array.isArray(mem) ? mem : [])
    .map((r) => (r as { cluster_id?: unknown }).cluster_id)
    .filter((v): v is string => typeof v === "string");

  let members: ThreadMemberCluster[] = [];
  if (ids.length > 0) {
    const { data: cl, error: cErr } = await supabase
      .from("clusters")
      .select("id, title_tr, title_tr_neutral, first_published, article_count, bias_distribution")
      .in("id", ids);
    if (cErr) throw new Error(`[story-threads] clusters fetch error: ${cErr.message}`);
    members = (Array.isArray(cl) ? cl : []) as ThreadMemberCluster[];
  }

  return {
    id: t.id as string,
    slug: t.slug,
    title: t.title_tr,
    publishedAt: typeof t.published_at === "string" ? t.published_at : null,
    members,
  };
}

// Cache lifetime follows the outcome (exactly one `cacheLife` call, after the
// attempt; `cacheTag` first): a result -- including "no such thread" -- keeps
// `hours`, a failed attempt is memoised for `minutes` only.
async function getThreadBySlugCached(slug: string) {
  "use cache";
  cacheTag("story-threads");
  const r = await attemptCached("story-threads", () => fetchThreadBySlug(slug));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

/** Never throws; null for an invalid slug, a draft/missing thread or an outage. */
export async function getPublishedThreadBySlug(slug: string): Promise<PublishedThread | null> {
  if (!isValidThreadSlug(slug)) return null;
  return resolveCachedOrRetry(
    "story-threads",
    () => getThreadBySlugCached(slug),
    () => fetchThreadBySlug(slug),
    null,
  );
}

/**
 * Throwing sibling of `getPublishedThreadBySlug` for the /hikaye/[slug] page
 * and its `generateMetadata`. Resolves `null` ONLY for an invalid slug or a
 * thread that is genuinely absent / not published; on a sustained read failure
 * (the cached attempt AND the live retry both fail) it REJECTS, so the page
 * can surface an error instead of a 404 that search engines would act on.
 *
 * Wrapped in React `cache` so `generateMetadata` and the page body in one
 * request share a single result (and a single live retry) per slug. Never call
 * it from a `"use cache"` body: it can throw.
 */
export const loadPublishedThreadBySlug = cache(
  async (slug: string): Promise<PublishedThread | null> => {
    if (!isValidThreadSlug(slug)) return null;
    const cached = await getThreadBySlugCached(slug);
    if (cached.ok) return cached.data;
    return fetchThreadBySlug(slug);
  },
);

async function fetchThreadForCluster(clusterId: string): Promise<ClusterThreadRef | null> {
  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("story_thread_members")
    .select("thread_id, story_threads!inner(slug, title_tr, status)")
    .eq("cluster_id", clusterId)
    .eq("story_threads.status", "published")
    .maybeSingle();
  if (error) throw new Error(`[story-threads] cluster thread fetch error: ${error.message}`);
  if (!data) return null;

  const embed = (data as { story_threads?: unknown }).story_threads;
  const t = (Array.isArray(embed) ? embed[0] : embed) as
    | { slug?: unknown; title_tr?: unknown; status?: unknown }
    | null
    | undefined;
  if (!t || t.status !== "published") return null;
  if (typeof t.slug !== "string" || t.slug === "") return null;
  if (typeof t.title_tr !== "string" || t.title_tr === "") return null;
  return { slug: t.slug, title: t.title_tr };
}

async function getThreadForClusterCached(clusterId: string) {
  "use cache";
  cacheTag("story-threads");
  const r = await attemptCached("story-threads", () =>
    fetchThreadForCluster(clusterId),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

/** Never throws; null when off, non-uuid, unthreaded, draft or on outage. */
export async function getPublishedThreadForCluster(
  clusterId: string,
): Promise<ClusterThreadRef | null> {
  if (!isStoryThreadsEnabled()) return null;
  if (typeof clusterId !== "string" || !UUID_RE.test(clusterId)) return null;
  return resolveCachedOrRetry(
    "story-threads",
    () => getThreadForClusterCached(clusterId),
    () => fetchThreadForCluster(clusterId),
    null,
  );
}
