import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";

import { clusterDisplayTitle, type HeadlineMember } from "./display-headline";
import { fetchLanguageIsolatedIds } from "./language-isolation-read";
import { isExtractiveModelId } from "./neutral-title";
import { detectWireRedistribution } from "./wire";

// Fetcher for /timeline — extracted out of the page component so the unit
// tests can exercise it without rendering JSX (mirrors blindspots-query.ts).

/**
 * Row cap for the feed. Measured 2026-10-24: ~234 clusters with
 * article_count >= 2 are minted per 24 h, so 100 covered only the newest
 * ~10 h; 200 covers ~20 h and the page copy names the real total for the
 * remainder. ~200 rows x 5 small columns is ~50 KB of HTML on a static
 * cached route.
 */
export const TIMELINE_LIMIT = 200;

export interface ClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  /**
   * The headline the page prints (h76-timeline-2): the stored neutral title
   * verbatim when there is one, else the headline cron's own first pick over the
   * member titles (clusterDisplayTitle, the same function the home feed and the
   * cluster page use), else `title_tr`. Never the raw outlet headline of a
   * cluster the cron is about to title.
   */
  title: string;
  article_count: number;
  /**
   * The source count the page prints (h142-consistency-1): the same honest
   * number the cluster page header, the cards, the RSS feed and the OG card
   * print. The members are de-duplicated to the earliest article per source,
   * then it is the distinct-text count (detectWireRedistribution, wire.ts) for a
   * wire redistribution and the member count otherwise. `article_count` is the
   * raw stored count, so it over-counts an agency dispatch reprinted by N
   * outlets (8 members, 3 texts); it is also the value here when no member could
   * be read, so the page degrades to today's number and never to a wrong one.
   */
  source_count: number;
  /**
   * Present only when the cluster is a wire redistribution (detectWireRedistribution
   * over the de-duplicated members): the member count and the number of distinct
   * texts behind it, the two numbers wireBadgeLabel (wire.ts) takes. The key is
   * omitted for every other row, so a non-wire row serialises exactly as before
   * apart from `source_count`. Two numbers only: the member descriptions and
   * hashes the detection reads are server-side input and never leave the query
   * (wire.ts header).
   */
  wire?: { memberCount: number; uniqueTexts: number };
  first_published: string;
  /**
   * 'en' when every member of the cluster is an English-language outlet
   * (isLanguageIsolatedCluster; h118-english-1) and the row's headline is one
   * member's own English title, so it is an English article title inside
   * <html lang="tr"> (WCAG 3.1.2). A headline the LLM rewrote is Turkish and
   * gets no lang. The key is omitted for every other row, so a Turkish row
   * serialises exactly as before.
   */
  lang?: "en";
}

/**
 * A `clusters` row as the row read returns it, before the display title, the
 * honest source count, the wire mark and lang are attached. `title_neutral_model`
 * is read only to decide `lang` (see fetchRecentClusters) and is dropped before
 * the row is returned, so it is not part of the public ClusterRow.
 */
type StoredClusterRow = Omit<ClusterRow, "title" | "lang" | "source_count" | "wire"> & {
  title_neutral_model: string | null;
};

export interface RecentClusters {
  rows: ClusterRow[];
  /**
   * Real number of qualifying clusters minted in the window (>= rows.length),
   * or null when the count read failed. The page must never present
   * `rows.length` as the day's total when `total` is null.
   */
  total: number | null;
}

type ReaderClient = ReturnType<typeof createReaderClient>;

// Head/exact count over the SAME filters and the SAME `since` bound as the row
// read, so "N of M" can never describe two different windows. A count is a
// nicety: a returned error, a null count (no Content-Range total) or a
// rejection (including the 4 s reader-cap abort) yields null and never fails
// the attempt — the rows are the page.
async function countRecentClusters(
  supabase: ReaderClient,
  since: string,
): Promise<number | null> {
  try {
    const { count, error } = await supabase
      .from("clusters")
      .select("id", { count: "exact", head: true })
      .eq("is_archived", false)
      .gte("article_count", 2)
      .gt("first_published", since);
    if (error) {
      console.error(`[timeline] total unavailable: ${error.message}`);
      return null;
    }
    return count ?? null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[timeline] total unavailable: ${message}`);
    return null;
  }
}

/**
 * Members read per cluster, for both member reads (the titles of a cluster the
 * headline cron has not titled yet, normally a fresh one of 2-5 members, and the
 * wire members of every row); the cap only bounds a pathological answer.
 */
const MEMBERS_PER_CLUSTER = 50;
/** Hard ceiling on the member read, however many rows lack a title. */
const MEMBER_READ_MAX_ROWS = 1000;

// The stored column is the cron's output, so a row without one (null, or
// whitespace only) is the only kind that needs its members read.
function lacksStoredNeutral(row: Pick<StoredClusterRow, "title_tr_neutral">): boolean {
  const neutral: unknown = row.title_tr_neutral;
  return typeof neutral !== "string" || neutral.trim().length === 0;
}

type MemberReadRow = {
  cluster_id: string;
  articles: HeadlineMember | HeadlineMember[] | null;
};

// ONE read for every row that lacks a stored neutral title: the member titles
// the headline cron itself reads (cluster_articles -> articles), grouped by
// cluster. A member title is a nicety on top of the rows, like the count: a
// returned error or a throw (including the 4 s reader-cap abort) is logged and
// yields no members at all, so those rows keep the `title_tr` they always had.
// It never throws and never fails the attempt -- the rows are the page.
async function fetchMemberTitles(
  supabase: ReaderClient,
  clusterIds: string[],
): Promise<Map<string, HeadlineMember[]>> {
  const byCluster = new Map<string, HeadlineMember[]>();
  try {
    const { data, error } = await supabase
      .from("cluster_articles")
      .select("cluster_id, articles ( title, published_at )")
      .in("cluster_id", clusterIds)
      .limit(Math.min(clusterIds.length * MEMBERS_PER_CLUSTER, MEMBER_READ_MAX_ROWS));
    if (error) {
      console.error(`[timeline] member titles unavailable: ${error.message}`);
      return new Map();
    }
    for (const r of (data ?? []) as unknown as MemberReadRow[]) {
      const article = Array.isArray(r.articles) ? r.articles[0] : r.articles;
      if (!article) continue;
      const list = byCluster.get(r.cluster_id);
      if (list) list.push(article);
      else byCluster.set(r.cluster_id, [article]);
    }
    return byCluster;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[timeline] member titles unavailable: ${message}`);
    return new Map();
  }
}

/**
 * Cluster ids per wire member read. A chunk's row limit is
 * CHUNK x MEMBERS_PER_CLUSTER = 2,500, clamped to MEMBER_READ_MAX_ROWS (1,000,
 * PostgREST's max-rows), so no request asks for more than the server answers. A
 * 200-row window is 4 reads (today's 875 member rows, ~220 per read), in parallel.
 */
const WIRE_CHUNK_SIZE = 50;

/**
 * The slice of a member article wire detection needs, server-side only: it is
 * read, reduced to two numbers per cluster (honestSourceCount) and dropped, and
 * no ClusterRow, prop or serialised output carries it.
 */
interface WireMember {
  id: string;
  source_id: string | null;
  content_hash: string | null;
  description: string | null;
  published_at: string | null;
}

type WireMemberReadRow = {
  cluster_id: string;
  articles: unknown;
};

// A member article as the embed returns it (object, or a one-element array, or
// null when the article is unreadable). Anything that is not an article with an
// id is not a member. Values are passed through as read, exactly as the cluster
// page hands them to the detection: a missing or non-string hash is null (each
// null is its own text), a non-string description is null (it links nothing).
function toWireMember(embed: unknown): WireMember | null {
  const article = Array.isArray(embed) ? embed[0] : embed;
  if (typeof article !== "object" || article === null) return null;
  const a = article as Record<string, unknown>;
  if (typeof a.id !== "string" || a.id.length === 0) return null;
  return {
    id: a.id,
    source_id: typeof a.source_id === "string" && a.source_id.length > 0 ? a.source_id : null,
    content_hash: typeof a.content_hash === "string" ? a.content_hash : null,
    description: typeof a.description === "string" ? a.description : null,
    published_at: typeof a.published_at === "string" ? a.published_at : null,
  };
}

// ONE chunk of the wire member read. A chunk is all-or-nothing: a returned error,
// a throw (including the 4 s reader-cap abort) or an answer as long as its row
// limit (it may have been cut, and a cut list under-counts the sources) is logged
// and yields no members at all for the clusters of this chunk, which then keep
// their article_count. It never throws.
async function readWireChunk(
  supabase: ReaderClient,
  ids: string[],
): Promise<Map<string, WireMember[]>> {
  const byCluster = new Map<string, WireMember[]>();
  try {
    const limit = Math.min(ids.length * MEMBERS_PER_CLUSTER, MEMBER_READ_MAX_ROWS);
    const { data, error } = await supabase
      .from("cluster_articles")
      .select("cluster_id, articles ( id, source_id, content_hash, description, published_at )")
      .in("cluster_id", ids)
      .limit(limit);
    if (error) {
      console.error(`[timeline] wire members unavailable: ${error.message}`);
      return new Map();
    }
    const rows = (data ?? []) as unknown as WireMemberReadRow[];
    if (rows.length >= limit) {
      console.error(
        `[timeline] wire members truncated at ${limit} rows (${ids.length} clusters), ignored`,
      );
      return new Map();
    }
    const asked = new Set(ids);
    for (const r of rows) {
      if (!asked.has(r.cluster_id)) continue;
      const member = toWireMember(r.articles);
      if (!member) continue;
      const list = byCluster.get(r.cluster_id);
      if (list) list.push(member);
      else byCluster.set(r.cluster_id, [member]);
    }
    return byCluster;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[timeline] wire members unavailable: ${message}`);
    return new Map();
  }
}

// h142-consistency-1: the members of EVERY row, grouped by cluster, for the
// honest source count. The row read carries no members, and the detection needs
// each member's hash and description, so this is one more read inside the same
// cache scope, chunked by WIRE_CHUNK_SIZE ids and run in parallel on the page's
// one reader client. Like the title and isolation reads it is a nicety on top of
// the rows: each chunk contains its own failure, so one bad chunk only leaves ITS
// clusters at article_count. It never throws and never fails the attempt -- the
// rows are the page.
async function fetchWireMembers(
  supabase: ReaderClient,
  clusterIds: string[],
): Promise<Map<string, WireMember[]>> {
  const chunks: string[][] = [];
  for (let i = 0; i < clusterIds.length; i += WIRE_CHUNK_SIZE) {
    chunks.push(clusterIds.slice(i, i + WIRE_CHUNK_SIZE));
  }
  const reads = await Promise.all(chunks.map((ids) => readWireChunk(supabase, ids)));
  const byCluster = new Map<string, WireMember[]>();
  for (const read of reads) {
    for (const [id, list] of read) byCluster.set(id, list);
  }
  return byCluster;
}

// Epoch ms of a member's published_at; a missing or unparsable one sorts last so
// it can never displace a dated article as its source's earliest.
function epochMsOrLast(iso: string | null): number {
  if (iso === null) return Number.POSITIVE_INFINITY;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

// Earliest article per source: the cluster page's dedupe (cluster-detail-query.ts,
// "keep the EARLIEST article per source") run before the detection, so two
// articles of one outlet are one source and the count here is the page header's.
// Sorted by published_at ascending (ties by article id, so the pick never depends
// on the order the read answered in). A member with no source_id cannot be shown
// to share a source with anyone, so it is its own.
function dedupeEarliestPerSource(members: readonly WireMember[]): WireMember[] {
  const sorted = [...members].sort((a, b) => {
    const am = epochMsOrLast(a.published_at);
    const bm = epochMsOrLast(b.published_at);
    if (am !== bm) return am < bm ? -1 : 1;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
  });
  const seen = new Set<string>();
  const kept: WireMember[] = [];
  for (const m of sorted) {
    const key = m.source_id ?? `__no_source__:${m.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(m);
  }
  return kept;
}

// The row's honest source count and, for a wire redistribution only, its wire
// mark. The union rule is wire.ts's (detectWireRedistribution): not
// reimplemented here. `members` undefined (nothing was read for this cluster)
// keeps the stored article_count and no wire key.
function honestSourceCount(
  articleCount: number,
  members: readonly WireMember[] | undefined,
): Pick<ClusterRow, "source_count" | "wire"> {
  const deduped = members ? dedupeEarliestPerSource(members) : [];
  if (deduped.length === 0) return { source_count: articleCount };
  const { isWire, uniqueHashes } = detectWireRedistribution(deduped);
  if (!isWire) return { source_count: deduped.length };
  return {
    source_count: uniqueHashes,
    wire: { memberCount: deduped.length, uniqueTexts: uniqueHashes },
  };
}

// Raw read: THROWS on a Supabase error in the ROW read (including a 4 s
// reader-cap abort) so a failure can never be mistaken for "no clusters in the
// last 24 h". Called only from `getRecentClustersCached`, i.e. from inside the
// cache scope, which is why the clock read below is allowed: /timeline is a
// static route, and Next 16 prerender (cacheComponents) rejects `Date.now()`
// in the uncached render path (same rule as /trends, see
// trends/daily-zones.ts).
async function fetchRecentClusters(): Promise<RecentClusters> {
  const supabase = createReaderClient();

  // Window: last 24 hours, anchored at the moment this cache entry is filled.
  // The entry revalidates after 300 s (cacheLife "cluster-feed",
  // next.config.ts) and is served stale once past that, so the window can lag
  // by minutes between fills, which is still small against a 24 h window. One
  // `since` for both reads.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [{ data, error }, count] = await Promise.all([
    supabase
      .from("clusters")
      .select(
        "id, title_tr, title_tr_neutral, title_neutral_model, article_count, first_published",
      )
      // Archived (migration 037) clusters are excluded from every reader-facing
      // surface; the detail page still resolves them so shared links never 404.
      .eq("is_archived", false)
      // The site's own cluster definition: a story needs at least two
      // articles. Singletons are not clusters (see /clusters, /konu).
      .gte("article_count", 2)
      .gt("first_published", since)
      .order("first_published", { ascending: false })
      .limit(TIMELINE_LIMIT),
    countRecentClusters(supabase, since),
  ]);

  if (error) {
    throw new Error(`timeline query failed: ${error.message}`);
  }

  const stored = (data ?? []) as StoredClusterRow[];

  // h76-timeline-2: the display title. A cluster whose neutral title the
  // headline cron has not written yet (it ticks every 5 minutes) used to print
  // the seed article's raw outlet headline here, and kept printing it after the
  // cron wrote the neutral one, because this entry is cached. The reader now
  // computes the cron's own first pick (clusterDisplayTitle, pure) from ONE
  // member read over just the rows that need it (normally 0-5), inside this
  // cache scope: one small extra read per cache fill, none when every row
  // already has a stored title. Nothing is written.
  //
  // h118-english-1: the rows whose every member is an English outlet carry
  // lang: 'en' (WCAG 3.1.2), unless the title is an LLM rewrite: the headline cron
  // in LLM mode writes a Turkish neutral title, which must not be marked English.
  // The isolation read is independent of the title read, so the two run together;
  // both are nicety reads that never throw, and an empty set / no members is
  // today's output.
  //
  // h142-consistency-1: the honest source count. A third read, over EVERY row,
  // fetches the members' hashes and descriptions (fetchWireMembers, chunked), and
  // each row's `source_count` / `wire` come from wire.ts's detection over the
  // members de-duplicated per source, the cluster page header's own number. It is
  // independent of the other two (a failure in one never touches the others) and
  // never throws; a row it could not read keeps article_count.
  const missing = stored.filter(lacksStoredNeutral).map((r) => r.id);
  const [members, isolated, wireMembers] = await Promise.all([
    missing.length > 0
      ? fetchMemberTitles(supabase, missing)
      : Promise.resolve(new Map<string, HeadlineMember[]>()),
    fetchLanguageIsolatedIds(supabase, stored),
    stored.length > 0
      ? fetchWireMembers(
          supabase,
          stored.map((r) => r.id),
        )
      : Promise.resolve(new Map<string, WireMember[]>()),
  ]);
  // The title is English only when it is a member's own title: no stored neutral
  // title yet (the first pick over the members, extractive), or a stored one from
  // an extractive model id. A stored neutral title from any other model is the
  // Turkish LLM rewrite. This is the cluster page's title_method rule
  // (cluster-detail-query.ts); title_neutral_model is read here and not returned.
  const rows: ClusterRow[] = stored.map(({ title_neutral_model, ...r }) => ({
    ...r,
    title: clusterDisplayTitle(r, members.get(r.id) ?? []).title,
    ...honestSourceCount(r.article_count, wireMembers.get(r.id)),
    ...(isolated.has(r.id) &&
    (lacksStoredNeutral(r) || isExtractiveModelId(title_neutral_model))
      ? { lang: "en" as const }
      : {}),
  }));

  // The two reads are not one snapshot: a cluster archived between them could
  // make the count smaller than what was listed. Never claim fewer than shown.
  const total = count === null ? null : Math.max(count, rows.length);
  return { rows, total };
}

// Build-safety: `attemptCached` swallows whatever `fetchRecentClusters` throws
// instead of letting it cross the `"use cache"` boundary (a throw there fails
// `next build`'s prerender -- see src/lib/cache-resilience.ts). Cache lifetime
// follows the outcome: rows keep the `cluster-feed` window, a failed attempt
// is memoised for `minutes` only. Exactly one `cacheLife` call per invocation,
// after the attempt; `cacheTag` first.
async function getRecentClustersCached() {
  "use cache";
  // "timeline" is this entry's own tag: the headline cron revalidates it when it
  // writes a title (h76-timeline-2). "clusters" alone is not enough: it also tags
  // every per-cluster story-timeline entry, so revalidating it would add reads on
  // cluster pages.
  cacheTag("clusters", "timeline");
  const r = await attemptCached("timeline", fetchRecentClusters);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("cluster-feed");
  else cacheLife("minutes");
  return r;
}

/**
 * Clusters (article_count >= 2) minted in the last 24 hours, newest first,
 * capped at TIMELINE_LIMIT, plus the real total. `null` = the row read failed
 * (the page renders an honest "unavailable" state); `{ rows: [] }` = it read
 * fine and nothing was minted; `total: null` = only the count failed.
 *
 * There is deliberately NO live retry (unlike getClusterDetail or
 * getTopicClusters): the route is static and the raw fetch reads
 * `Date.now()`, so a bypass-retry would put that clock read outside any
 * cache scope. A failed attempt falls straight back to `null`, is memoised
 * for the built-in "minutes" window (revalidate ~60 s) only, and the next
 * request after it tries again. A good result lives under "cluster-feed":
 * 300 s, served stale once after that while it regenerates, so the page copy
 * and /api/timeline/head each see this entry on their own lifecycle (see the
 * pill, src/components/timeline/new-clusters-pill.tsx). Never throws.
 */
export async function getRecentClusters(): Promise<RecentClusters | null> {
  const r = await getRecentClustersCached();
  return r.ok ? r.data : null;
}
