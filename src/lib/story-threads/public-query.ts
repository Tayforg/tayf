import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { createServerClient } from "@/lib/supabase/server";
import { isStoryThreadsEnabled, isValidThreadSlug } from "./config";
import type { ThreadMemberCluster } from "./timeline";

// Public readers for "Gelişen hikaye" threads (migration 098). Both are
// never-throw: a missing migration, an outage or a draft all read as null.
// Only PUBLISHED threads are ever returned; status is re-checked in TS on
// top of the query filter.

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
  const supabase = createServerClient();
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

async function getThreadBySlugCached(slug: string) {
  "use cache";
  cacheLife("hours");
  cacheTag("story-threads");
  return attemptCached("story-threads", () => fetchThreadBySlug(slug));
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

async function fetchThreadForCluster(clusterId: string): Promise<ClusterThreadRef | null> {
  const supabase = createServerClient();
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
  cacheLife("hours");
  cacheTag("story-threads");
  return attemptCached("story-threads", () => fetchThreadForCluster(clusterId));
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
