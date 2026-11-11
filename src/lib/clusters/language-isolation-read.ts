import type { SupabaseClient } from "@supabase/supabase-js";

import { isLanguageIsolatedCluster } from "@/lib/sources/source-language";

// Which of these clusters formed among English-language outlets only?
//
// WCAG 3.1.2 and the "not compared" wording both hang on one fact the list
// readers do not carry: every member of the cluster is an English outlet
// (isLanguageIsolatedCluster, h59-english-1). /timeline rows, the news sitemap
// and /api/takip select no member sources, so this does ONE small read for the
// rows that could be isolated and answers with their ids (h118-english-1).
//
// Candidates are the clusters with 2..12 members: only six outlets publish in
// English (ENGLISH_SOURCE_SLUGS), so an English-only cluster is small, and a
// 20-member cluster is never read. The read is a plain member embed
// (cluster_articles -> articles -> sources), grouped by cluster in JS.
//
// A cluster is isolated only when its group has exactly `article_count` rows AND
// every source in it is English. The count guard is what makes a short read
// harmless: PostgREST truncates at its row cap, a member can be unreadable, and
// `article_count` can be stale, and every one of those leaves a group that is
// not the right size, so the cluster is left out (today's behaviour). A partial
// answer can drop an id; it can never add one.
//
// The ids go to PostgREST in chunks of ISOLATION_CHUNK_SIZE: an `in (...)` list
// of 200+ uuids is a long URL (recall-matched-zones.ts keeps its lists to 100 for
// the same reason), and a chunk's row limit (12 per id) then stays under the
// 1,000-row cap. One failed chunk empties the whole answer, so a list is never
// half-qualified.
//
// Reads only; never throws. Callers run it inside their own cache scope.

/** Fewest members a cluster has (the site's own definition of a cluster). */
export const ISOLATION_MIN_MEMBERS = 2;
/** Most members an English-only cluster can plausibly have; larger ones are never read. */
export const ISOLATION_MAX_MEMBERS = 12;
/** Cluster ids per request: 80 x 12 rows is 960, under PostgREST's 1,000-row cap. */
export const ISOLATION_CHUNK_SIZE = 80;

type EmbedSource = { slug: string | null; name: string | null };
type OneOrMany<T> = T | T[] | null;
type MemberRow = {
  cluster_id: string;
  articles: OneOrMany<{ sources: OneOrMany<EmbedSource> }>;
};

function firstOf<T>(value: OneOrMany<T> | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

/** The member's source, or null when the row carries none (it then cannot be shown English). */
function sourceOf(row: MemberRow): EmbedSource | null {
  const article = firstOf(row.articles);
  return article ? firstOf(article.sources) : null;
}

function isCandidateCount(n: unknown): n is number {
  return (
    typeof n === "number" &&
    Number.isInteger(n) &&
    n >= ISOLATION_MIN_MEMBERS &&
    n <= ISOLATION_MAX_MEMBERS
  );
}

async function readChunk(supabase: SupabaseClient, ids: string[]): Promise<MemberRow[]> {
  const { data, error } = await supabase
    .from("cluster_articles")
    .select("cluster_id, articles ( sources ( slug, name ) )")
    .in("cluster_id", ids)
    .limit(ids.length * ISOLATION_MAX_MEMBERS);
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MemberRow[];
}

/**
 * The ids of `rows` whose every member source is an English outlet. `rows` is
 * whatever the caller already read (it needs only `id` and `article_count`); a
 * row outside 2..12 members is not read and is never in the answer. On an error
 * or a throw it logs and returns an empty set, so every surface keeps today's
 * output.
 */
export async function fetchLanguageIsolatedIds(
  supabase: SupabaseClient,
  rows: ReadonlyArray<{ id: string; article_count: number }>,
): Promise<Set<string>> {
  try {
    const expected = new Map<string, number>();
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row || typeof row.id !== "string" || !isCandidateCount(row.article_count)) continue;
      expected.set(row.id, row.article_count);
    }
    if (expected.size === 0) return new Set();

    const ids = [...expected.keys()];
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += ISOLATION_CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + ISOLATION_CHUNK_SIZE));
    }
    const reads = await Promise.all(chunks.map((chunk) => readChunk(supabase, chunk)));

    const sourcesByCluster = new Map<string, Array<EmbedSource | null>>();
    for (const row of reads.flat()) {
      if (!expected.has(row.cluster_id)) continue;
      const list = sourcesByCluster.get(row.cluster_id);
      if (list) list.push(sourceOf(row));
      else sourcesByCluster.set(row.cluster_id, [sourceOf(row)]);
    }

    const isolated = new Set<string>();
    for (const [id, sources] of sourcesByCluster) {
      if (sources.length !== expected.get(id)) continue;
      if (isLanguageIsolatedCluster(sources)) isolated.add(id);
    }
    return isolated;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[language-isolation] unavailable: ${message}`);
    return new Set();
  }
}
