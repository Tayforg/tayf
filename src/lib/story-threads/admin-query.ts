import { createServerClient } from "@/lib/supabase/server";

// Readers for /admin/hikayeler (migration 098). Plain async, no cache; null
// means "could not read" (e.g. 098 not applied) and renders as a sentence.

const LIST_LIMIT = 50;
const MEMBER_LIMIT = 500;

export interface AdminClusterRef {
  id: string;
  title: string;
  firstPublished: string | null;
  articleCount: number;
  /** Thread the cluster already belongs to (id + title or null when untitled draft). */
  thread: { id: string; title: string | null } | null;
}

export interface ThreadCandidate {
  id: number;
  confidence: number;
  sharedTerms: string[];
  hoursApart: number;
  sameTopic: boolean | null;
  a: AdminClusterRef;
  b: AdminClusterRef;
}

export interface AdminThread {
  id: string;
  slug: string | null;
  title: string | null;
  status: "draft" | "published";
  updatedAt: string;
  publishedAt: string | null;
  suggestedTitle: string;
  members: AdminClusterRef[];
}

interface ClusterRow {
  id: string;
  title_tr: string | null;
  title_tr_neutral: string | null;
  first_published: string | null;
  article_count: number | null;
}

const CLUSTER_COLS = "id, title_tr, title_tr_neutral, first_published, article_count";

function clusterTitle(c: ClusterRow | undefined): string {
  if (!c) return "";
  const n = typeof c.title_tr_neutral === "string" ? c.title_tr_neutral.trim() : "";
  if (n !== "") return n;
  return typeof c.title_tr === "string" ? c.title_tr.trim() : "";
}

function toRef(
  id: string,
  c: ClusterRow | undefined,
  thread: AdminClusterRef["thread"],
): AdminClusterRef {
  return {
    id,
    title: clusterTitle(c) || "(başlıksız küme)",
    firstPublished: c?.first_published ?? null,
    articleCount: typeof c?.article_count === "number" ? c.article_count : 0,
    thread,
  };
}

export async function getThreadCandidates(): Promise<ThreadCandidate[] | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("story_thread_candidates")
      .select("id, cluster_a, cluster_b, confidence, shared_terms, hours_apart, same_topic")
      .eq("status", "pending")
      .order("confidence", { ascending: false })
      .limit(LIST_LIMIT);
    if (error) {
      console.error(`[admin] story thread candidates unavailable: ${error.message}`);
      return null;
    }
    const rows = Array.isArray(data) ? data : [];
    if (rows.length === 0) return [];

    const ids = [...new Set(rows.flatMap((r) => [r.cluster_a as string, r.cluster_b as string]))];
    const [cl, mem] = await Promise.all([
      supabase.from("clusters").select(CLUSTER_COLS).in("id", ids),
      supabase.from("story_thread_members").select("thread_id, cluster_id").in("cluster_id", ids),
    ]);
    if (cl.error || mem.error) {
      console.error(
        `[admin] story thread candidates unavailable: ${(cl.error ?? mem.error)?.message}`,
      );
      return null;
    }
    const clusters = new Map(((cl.data ?? []) as ClusterRow[]).map((c) => [c.id, c]));
    const threadOf = new Map(
      ((mem.data ?? []) as Array<{ thread_id: string; cluster_id: string }>).map((m) => [
        m.cluster_id,
        m.thread_id,
      ]),
    );

    const threadIds = [...new Set(threadOf.values())];
    const titles = new Map<string, string | null>();
    if (threadIds.length > 0) {
      const { data: th, error: thErr } = await supabase
        .from("story_threads")
        .select("id, title_tr")
        .in("id", threadIds);
      if (thErr) {
        console.error(`[admin] story thread candidates unavailable: ${thErr.message}`);
        return null;
      }
      for (const t of (th ?? []) as Array<{ id: string; title_tr: string | null }>) {
        titles.set(t.id, t.title_tr);
      }
    }
    const threadRef = (clusterId: string): AdminClusterRef["thread"] => {
      const tid = threadOf.get(clusterId);
      return tid ? { id: tid, title: titles.get(tid) ?? null } : null;
    };

    return rows.map((r) => ({
      id: Number(r.id),
      confidence: Number(r.confidence),
      sharedTerms: Array.isArray(r.shared_terms) ? (r.shared_terms as string[]) : [],
      hoursApart: Number(r.hours_apart),
      sameTopic: typeof r.same_topic === "boolean" ? r.same_topic : null,
      a: toRef(r.cluster_a as string, clusters.get(r.cluster_a as string), threadRef(r.cluster_a as string)),
      b: toRef(r.cluster_b as string, clusters.get(r.cluster_b as string), threadRef(r.cluster_b as string)),
    }));
  } catch (err) {
    console.error(`[admin] story thread candidates threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

export async function getAdminThreads(): Promise<AdminThread[] | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("story_threads")
      .select("id, slug, title_tr, status, updated_at, published_at")
      .order("updated_at", { ascending: false })
      .limit(LIST_LIMIT);
    if (error) {
      console.error(`[admin] story threads unavailable: ${error.message}`);
      return null;
    }
    const threads = Array.isArray(data) ? data : [];
    if (threads.length === 0) return [];

    const { data: mem, error: mErr } = await supabase
      .from("story_thread_members")
      .select("thread_id, cluster_id")
      .in("thread_id", threads.map((t) => t.id as string))
      .limit(MEMBER_LIMIT);
    if (mErr) {
      console.error(`[admin] story threads unavailable: ${mErr.message}`);
      return null;
    }
    const memberRows = (mem ?? []) as Array<{ thread_id: string; cluster_id: string }>;
    const clusterIds = [...new Set(memberRows.map((m) => m.cluster_id))];
    let clusters = new Map<string, ClusterRow>();
    if (clusterIds.length > 0) {
      const { data: cl, error: cErr } = await supabase
        .from("clusters")
        .select(CLUSTER_COLS)
        .in("id", clusterIds);
      if (cErr) {
        console.error(`[admin] story threads unavailable: ${cErr.message}`);
        return null;
      }
      clusters = new Map(((cl ?? []) as ClusterRow[]).map((c) => [c.id, c]));
    }

    return threads.map((t) => {
      const members = memberRows
        .filter((m) => m.thread_id === t.id)
        .map((m) => toRef(m.cluster_id, clusters.get(m.cluster_id), { id: t.id as string, title: (t.title_tr as string | null) ?? null }))
        .sort((x, y) => (x.firstPublished ?? "").localeCompare(y.firstPublished ?? ""));
      const biggest = [...members].sort((x, y) => y.articleCount - x.articleCount)[0];
      return {
        id: t.id as string,
        slug: (t.slug as string | null) ?? null,
        title: (t.title_tr as string | null) ?? null,
        status: t.status === "published" ? "published" : "draft",
        updatedAt: t.updated_at as string,
        publishedAt: (t.published_at as string | null) ?? null,
        suggestedTitle: biggest && !biggest.title.startsWith("(") ? biggest.title : "",
        members,
      };
    });
  } catch (err) {
    console.error(`[admin] story threads threw: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
