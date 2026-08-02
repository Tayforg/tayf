// supabase/functions/cluster-consumer/index.ts
//
// Edge Function (Deno 2.x) that drains the `cluster_work` pgmq queue and
// runs the ensemble clusterer on each article. Co-located with Postgres so
// the per-article round-trips that drove the cron-based clusterer into the
// 300s timeout are now ~10ms each.
//
// Per invocation:
//   1. read up to BATCH_SIZE messages with visibility timeout VT_SECONDS
//   2. for each message: fetch the article, score against the 48h cluster
//      context, upsert into clusters/cluster_articles, then `pgmq.archive`
//   3. messages whose `read_ct` exceeds MAX_READS get `pgmq.archive`d
//      (DLQ-lite — the payload survives in pgmq.a_cluster_work for audit)
//   4. cap total wall-clock work at MAX_INVOCATION_MS so we never hit the
//      Edge Functions 400s limit
//
// In-memory caches (cluster context, source lookup) survive between dequeues
// within the same Edge Function instance, so warm invocations skip the
// expensive 48h scan.

import {
  archive,
  type PgmqMessage,
  queueDepth,
  readBatch,
} from "../_shared/pgmq.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";

// Initialise Sentry at module load. No-op if SENTRY_DSN is unset.
await initSentry("cluster-consumer");
import { createServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import {
  fingerprint,
  type FingerprintBundle,
} from "../_shared/cluster/fingerprint.ts";
import { extractEntities } from "../_shared/cluster/entities.ts";
import { bandKeys, LSH_BANDS } from "../_shared/cluster/lsh.ts";
import { TfidfIndex } from "../_shared/cluster/tfidf.ts";
import { score } from "../_shared/cluster/ensemble.ts";
import {
  MATCH_THRESHOLD,
  MAX_CANDIDATE_CLUSTERS,
  MIN_SHARED_ENTITIES,
  TIME_WINDOW_HOURS,
} from "../_shared/cluster/constants.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const QUEUE_NAME = "cluster_work";
// Messages processed per invocation. Kept small because each article is
// scored against the full cluster context (a per-article TF-IDF build), so
// large batches push a single invocation past the Edge compute limit. The
// cluster-drain pg_cron fires every minute, so a small batch still clears
// the backlog quickly and keeps steady state.
const BATCH_SIZE = 2;
// Upper bound on clusters held in the in-memory rolling context — see
// loadClusterContext. The context build fingerprints seed+latest of every
// included cluster on each cold invocation, and that per-invocation CPU is
// what trips the Edge Function compute limit (546): ~800 fingerprints at
// cap 400 exceeds it, ~300 at cap 150 stays under with margin. This is a
// stopgap — the durable fix is to persist the MinHash signature at ingest
// so the consumer reads instead of recomputing, which would let the full
// 48h window back in. Tracked as a follow-up.
const CONTEXT_CLUSTER_CAP = 60;
const VT_SECONDS = 60;                      // visibility timeout per message
// Poison contract (shared with image-consumer): a message is permanently
// failed once read_ct EXCEEDS this — i.e. on its 4th read.
const MAX_READS = 3;
const MAX_INVOCATION_MS = 30_000;           // 30 s wall budget per invocation
// Minimum budget that must remain before leasing another batch. pgmq bumps
// read_ct on every read — including messages this invocation never gets to
// process — so reading with the budget nearly spent walks healthy messages
// toward the poison threshold (audit S11).
const READ_BUDGET_FLOOR_MS = 5_000;
const CLUSTER_CONTEXT_TTL_MS = 60_000;      // refresh rolling-window context

const POLITICS_CATEGORIES = ["politika", "son_dakika"];

const BIAS_KEYS = [
  "pro_government", "gov_leaning", "state_media", "center",
  "opposition_leaning", "opposition", "nationalist",
  "islamist_conservative", "pro_kurdish", "international",
] as const;
type BiasKey = (typeof BIAS_KEYS)[number];

// ---------------------------------------------------------------------------
// DB row shapes (narrow, only what the consumer reads/writes)
// ---------------------------------------------------------------------------

interface ArticleRow {
  id: string;
  source_id: string | null;
  title: string;
  description: string | null;
  url: string;
  content_hash: string;
  published_at: string;
  fingerprint: string | null;
  entities: string[] | null;
  category: string | null;
}

interface EnrichedArticle extends ArticleRow {
  // signature is computed in-memory; there is no DB column yet.
  signature: Uint32Array | null;
  // entities normalised to non-null after enrichment.
  entities: string[];
}

interface SourceRow {
  id: string;
  bias: BiasKey | null;
  name: string | null;
  slug: string | null;
}

interface ClusterRow {
  id: string;
  title_tr: string | null;
  first_published: string;
  updated_at: string;
  article_count: number;
}

interface ClusterMemberArticle {
  id: string;
  source_id: string | null;
  title: string;
  description: string | null;
  published_at: string;
  fingerprint: string | null;
  entities: string[] | null;
  category: string | null;
  signature?: Uint32Array;
}

interface ClusterContext {
  fetchedAt: number;
  clusters: ClusterRow[];
  seedByCluster: Map<string, ClusterMemberArticle>;
  latestByCluster: Map<string, ClusterMemberArticle>;
  sourceIdsByCluster: Map<string, Set<string>>;
  indices: {
    byFingerprint: Map<string, string[]>;
    byEntity: Map<string, string[]>;
    // LSH bands over the seed/latest MinHash signatures. Third candidate
    // route: without it, near-duplicate articles sharing fewer than
    // MIN_SHARED_ENTITIES whitelist entities were never scored at all.
    // Keyed on seed+latest only, matching what the ensemble actually
    // compares against below — admitting a cluster whose seed and latest
    // will not score buys nothing.
    byBand: Map<string, string[]>;
  };
}

interface QueueMessage {
  article_id: string;
}

// ---------------------------------------------------------------------------
// Module-level caches — survive between invocations within the same instance.
// ---------------------------------------------------------------------------

const supabase: SupabaseClient = createServiceClient();

let clusterContextCache: ClusterContext | null = null;
let sourceLookupCache: { fetchedAt: number; lookup: Map<string, SourceRow> } | null = null;
const SOURCE_LOOKUP_TTL_MS = 5 * 60_000; // 5 minutes

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

function hoursBetween(aIso: string, bIso: string): number {
  return (
    Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) /
    (1000 * 60 * 60)
  );
}

function buildBiasDistribution(biasLabels: Array<BiasKey | null | undefined>): Record<BiasKey, number> {
  const dist = Object.fromEntries(BIAS_KEYS.map((k) => [k, 0])) as Record<BiasKey, number>;
  for (const b of biasLabels) {
    if (b && b in dist) dist[b as BiasKey]++;
  }
  return dist;
}

function detectBlindspot(dist: Record<BiasKey, number>): { is_blindspot: boolean; blindspot_side: BiasKey | null } {
  const entries = (Object.entries(dist) as Array<[BiasKey, number]>).filter(([, n]) => n > 0);
  if (entries.length === 1) {
    return { is_blindspot: true, blindspot_side: entries[0][0] };
  }
  return { is_blindspot: false, blindspot_side: null };
}

function summaryFallback(description: string | null | undefined): string {
  const d = (description || "").trim();
  return d.length > 0 ? d : " ";
}

function buildMemberIndicesFromRows(
  caRows: Array<{ cluster_id: string; article_id: string }>,
  memberArticles: Map<string, ClusterMemberArticle>,
) {
  const byFingerprint = new Map<string, string[]>();
  const byEntity = new Map<string, string[]>();
  // Populated by the caller from the seed/latest signatures — see
  // loadClusterContext. Created here so the indices object has one shape.
  const byBand = new Map<string, string[]>();
  const fpSeen = new Set<string>();
  const entSeen = new Set<string>();

  for (const row of caRows) {
    const art = memberArticles.get(row.article_id);
    if (!art) continue;
    if (art.fingerprint) {
      const key = `${row.cluster_id}|${art.fingerprint}`;
      if (!fpSeen.has(key)) {
        fpSeen.add(key);
        const list = byFingerprint.get(art.fingerprint) || [];
        list.push(row.cluster_id);
        byFingerprint.set(art.fingerprint, list);
      }
    }
    if (Array.isArray(art.entities)) {
      for (const ent of art.entities) {
        const key = `${row.cluster_id}|${ent}`;
        if (entSeen.has(key)) continue;
        entSeen.add(key);
        const list = byEntity.get(ent) || [];
        list.push(row.cluster_id);
        byEntity.set(ent, list);
      }
    }
  }

  return { byFingerprint, byEntity, byBand };
}

async function inChunked<R>(
  table: string,
  select: string,
  column: string,
  values: Array<string | number>,
  chunkSize = 100,
): Promise<R[]> {
  if (values.length === 0) return [];
  const out: R[] = [];
  for (let i = 0; i < values.length; i += chunkSize) {
    const slice = values.slice(i, i + chunkSize);
    const res = await supabase.from(table).select(select).in(column, slice);
    if (res.error) {
      throw new Error(`inChunked(${table}): ${res.error.message}`);
    }
    for (const row of (res.data ?? []) as R[]) out.push(row);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Cluster context loader (rolling 48h politics window)
// ---------------------------------------------------------------------------

async function loadClusterContext(): Promise<ClusterContext> {
  const cutoffIso = new Date(
    Date.now() - TIME_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();

  // Bound the in-memory context to the most-recently-updated clusters. The
  // unbounded load (every cluster touched in the 48h window, plus all their
  // member articles + per-article TF-IDF) blew the Edge Function compute
  // limit at production scale (72k clusters, tens of thousands inside 48h →
  // 546 WORKER_RESOURCE_LIMIT). The newest clusters are the only realistic
  // match targets for an incoming article — a story that stopped getting
  // coverage is not one a fresh article will join — so capping to the top
  // CONTEXT_CLUSTER_CAP by updated_at keeps clustering quality while making
  // memory deterministic.
  const clusters: ClusterRow[] = [];
  {
    const res = await supabase
      .from("clusters")
      .select("id, title_tr, first_published, updated_at, article_count")
      .gte("updated_at", cutoffIso)
      .order("updated_at", { ascending: false })
      .limit(CONTEXT_CLUSTER_CAP);
    if (res.error) {
      throw new Error(`loadClusterContext clusters: ${res.error.message}`);
    }
    clusters.push(...((res.data ?? []) as ClusterRow[]));
  }

  const emptyCtx: ClusterContext = {
    fetchedAt: Date.now(),
    clusters: [],
    seedByCluster: new Map(),
    latestByCluster: new Map(),
    sourceIdsByCluster: new Map(),
    indices: { byFingerprint: new Map(), byEntity: new Map(), byBand: new Map() },
  };

  if (clusters.length === 0) return emptyCtx;
  const clusterIds = clusters.map((c) => c.id);

  const caRows = await inChunked<{ cluster_id: string; article_id: string }>(
    "cluster_articles",
    "cluster_id, article_id",
    "cluster_id",
    clusterIds,
    100,
  );

  const allArticleIds = [...new Set(caRows.map((r) => r.article_id))];
  if (allArticleIds.length === 0) {
    return { ...emptyCtx, clusters };
  }

  const articleRows = await inChunked<ClusterMemberArticle & { source_id: string | null }>(
    "articles",
    "id, source_id, title, description, published_at, fingerprint, entities, category",
    "id",
    allArticleIds,
    100,
  );
  const politicsArticleRows = articleRows.filter((a) =>
    a.category != null && POLITICS_CATEGORIES.includes(a.category),
  );
  const memberArticles = new Map(politicsArticleRows.map((a) => [a.id, a]));

  const sourceIdsByCluster = new Map<string, Set<string>>();
  const memberIdsByCluster = new Map<string, string[]>();
  for (const row of caRows) {
    const list = memberIdsByCluster.get(row.cluster_id) || [];
    list.push(row.article_id);
    memberIdsByCluster.set(row.cluster_id, list);

    const art = memberArticles.get(row.article_id);
    if (!art || !art.source_id) continue;
    let set = sourceIdsByCluster.get(row.cluster_id);
    if (!set) {
      set = new Set();
      sourceIdsByCluster.set(row.cluster_id, set);
    }
    set.add(art.source_id);
  }

  const seedByCluster = new Map<string, ClusterMemberArticle>();
  for (const [clusterId, ids] of memberIdsByCluster.entries()) {
    let seed: ClusterMemberArticle | null = null;
    for (const id of ids) {
      const art = memberArticles.get(id);
      if (!art) continue;
      if (!seed || new Date(art.published_at) < new Date(seed.published_at)) {
        seed = art;
      }
    }
    if (seed) {
      if (!seed.signature) {
        const fp = fingerprint(seed.title || "", seed.description || "");
        seed.signature = fp.signature;
        if (!seed.fingerprint) seed.fingerprint = fp.strict;
      }
      seedByCluster.set(clusterId, seed);
    }
  }

  const latestByCluster = new Map<string, ClusterMemberArticle>();
  for (const [clusterId, ids] of memberIdsByCluster.entries()) {
    const seed = seedByCluster.get(clusterId);
    if (!seed) continue;
    let latest: ClusterMemberArticle | null = null;
    for (const id of ids) {
      const art = memberArticles.get(id);
      if (!art || art.id === seed.id) continue;
      if (
        !latest ||
        new Date(art.published_at) > new Date(latest.published_at)
      ) {
        latest = art;
      }
    }
    if (latest) {
      const fp = fingerprint(latest.title || "", latest.description || "");
      latest.signature = fp.signature;
      if (!latest.fingerprint) latest.fingerprint = fp.strict;
      latestByCluster.set(clusterId, latest);
    }
  }

  const indices = buildMemberIndicesFromRows(caRows, memberArticles);

  // Band the seed/latest signatures computed above. Done here rather than in
  // buildMemberIndicesFromRows because signatures are not persisted — only
  // seed and latest get one recomputed per context load, and those are
  // precisely the two the ensemble scores against.
  for (const byCluster of [seedByCluster, latestByCluster]) {
    for (const [clusterId, art] of byCluster.entries()) {
      for (const key of bandKeys(art.signature)) {
        const list = indices.byBand.get(key);
        if (!list) {
          indices.byBand.set(key, [clusterId]);
        } else if (!list.includes(clusterId)) {
          list.push(clusterId);
        }
      }
    }
  }

  return {
    fetchedAt: Date.now(),
    clusters,
    seedByCluster,
    latestByCluster,
    sourceIdsByCluster,
    indices,
  };
}

async function getClusterContext({ force = false } = {}): Promise<ClusterContext> {
  const now = Date.now();
  if (
    !force &&
    clusterContextCache &&
    now - clusterContextCache.fetchedAt < CLUSTER_CONTEXT_TTL_MS
  ) {
    return clusterContextCache;
  }
  clusterContextCache = await loadClusterContext();
  return clusterContextCache;
}

async function getSourceLookup(): Promise<Map<string, SourceRow>> {
  const now = Date.now();
  if (sourceLookupCache && now - sourceLookupCache.fetchedAt < SOURCE_LOOKUP_TTL_MS) {
    return sourceLookupCache.lookup;
  }
  const res = await supabase.from("sources").select("id, bias, name, slug");
  if (res.error) throw new Error(`sources: ${res.error.message}`);
  const rows = (res.data ?? []) as SourceRow[];
  const lookup = new Map(rows.map((s) => [s.id, s]));
  sourceLookupCache = { fetchedAt: now, lookup };
  return lookup;
}

// ---------------------------------------------------------------------------
// Cache mutation helpers (mirror in-memory state when we create/extend clusters
// during this invocation, so subsequent dequeues see the change without
// waiting for the TTL to expire)
// ---------------------------------------------------------------------------

function addMemberToIndices(
  clusterId: string,
  article: {
    fingerprint: string | null;
    entities: string[] | null;
    signature?: Uint32Array | null;
  },
) {
  if (!clusterContextCache) return;
  const idx = clusterContextCache.indices;
  if (article.fingerprint) {
    const list = idx.byFingerprint.get(article.fingerprint) || [];
    if (!list.includes(clusterId)) {
      list.push(clusterId);
      idx.byFingerprint.set(article.fingerprint, list);
    }
  }
  for (const ent of article.entities || []) {
    const list = idx.byEntity.get(ent) || [];
    if (!list.includes(clusterId)) {
      list.push(clusterId);
      idx.byEntity.set(ent, list);
    }
  }
  // Band the member too, so a cluster created earlier in THIS invocation is
  // reachable by the next dequeued article without waiting for the context
  // TTL. Two same-outlet near-duplicates arriving in one batch was a
  // reproducible miss before this.
  for (const key of bandKeys(article.signature)) {
    const list = idx.byBand.get(key) || [];
    if (!list.includes(clusterId)) {
      list.push(clusterId);
      idx.byBand.set(key, list);
    }
  }
}

function markClusterHasSource(clusterId: string, sourceId: string | null) {
  if (!clusterContextCache || !sourceId) return;
  let set = clusterContextCache.sourceIdsByCluster.get(clusterId);
  if (!set) {
    set = new Set();
    clusterContextCache.sourceIdsByCluster.set(clusterId, set);
  }
  set.add(sourceId);
}

function registerNewClusterInCache(clusterId: string, seed: ClusterMemberArticle) {
  if (!clusterContextCache) return;
  clusterContextCache.seedByCluster.set(clusterId, seed);
  addMemberToIndices(clusterId, seed);
  clusterContextCache.sourceIdsByCluster.set(
    clusterId,
    new Set(seed.source_id ? [seed.source_id] : []),
  );
  clusterContextCache.clusters.push({
    id: clusterId,
    title_tr: seed.title,
    first_published: seed.published_at,
    updated_at: seed.published_at,
    article_count: 1,
  });
}

// ---------------------------------------------------------------------------
// Candidate search (inverted indices over ALL cluster members)
// ---------------------------------------------------------------------------

function findCandidateClusters(
  article: EnrichedArticle,
  indices: ClusterContext["indices"],
): string[] {
  const candidates = new Map<string, number>();

  if (article.fingerprint) {
    const hit = indices.byFingerprint.get(article.fingerprint);
    if (hit) {
      for (const id of hit) candidates.set(id, Number.POSITIVE_INFINITY);
    }
  }

  const entityCounts = new Map<string, number>();
  for (const ent of article.entities || []) {
    const hit = indices.byEntity.get(ent);
    if (!hit) continue;
    for (const id of hit) {
      entityCounts.set(id, (entityCounts.get(id) || 0) + 1);
    }
  }
  for (const [id, shared] of entityCounts.entries()) {
    if (shared >= MIN_SHARED_ENTITIES) {
      const prev = candidates.get(id) ?? 0;
      candidates.set(id, Math.max(prev, shared));
    }
  }

  // LSH route. Half the corpus carries fewer than MIN_SHARED_ENTITIES
  // whitelist entities, so without this a near-duplicate whose strict
  // fingerprint differs by one character is never scored at all. Bands are a
  // proxy for jaccard: more shared bands means more similar, so the count is
  // used as the sort weight. It is deliberately damped below the entity
  // weight — an entity agreement is semantic, a band agreement is lexical, so
  // when the candidate list is trimmed to MAX_CANDIDATE_CLUSTERS the entity
  // hits should survive first.
  const bandCounts = new Map<string, number>();
  for (const key of bandKeys(article.signature)) {
    const hit = indices.byBand.get(key);
    if (!hit) continue;
    for (const id of hit) {
      bandCounts.set(id, (bandCounts.get(id) || 0) + 1);
    }
  }
  for (const [id, bands] of bandCounts.entries()) {
    const prev = candidates.get(id) ?? 0;
    candidates.set(id, Math.max(prev, bands / LSH_BANDS));
  }

  return [...candidates.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_CANDIDATE_CLUSTERS)
    .map(([id]) => id);
}

// ---------------------------------------------------------------------------
// Article enrichment — recompute fingerprint + entities (in memory + DB).
// ---------------------------------------------------------------------------

function enrichArticleInMemory(article: ArticleRow): EnrichedArticle {
  const fp: FingerprintBundle = fingerprint(article.title || "", article.description || "");
  const freshEnts = extractEntities(
    `${article.title || ""} ${article.description || ""}`,
  ) || [];
  return {
    ...article,
    fingerprint: fp.strict,
    entities: freshEnts,
    signature: fp.signature,
  };
}

async function persistEnrichment(article: EnrichedArticle): Promise<void> {
  // Only patch the columns we recompute; never touch the immutable fields.
  const update = {
    fingerprint: article.fingerprint,
    entities: article.entities,
  };
  const res = await supabase.from("articles").update(update).eq("id", article.id);
  if (res.error) {
    // Non-fatal — fingerprint persistence is best-effort. Log and continue;
    // the clustering decision uses the in-memory value either way.
    console.warn(
      `[cluster-consumer] persistEnrichment failed for ${article.id}: ${res.error.message}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Cluster mutations (create + append, with per-source dedupe guard)
// ---------------------------------------------------------------------------

async function createCluster(
  sourceLookup: Map<string, SourceRow>,
  article: EnrichedArticle,
): Promise<string> {
  const bias = (article.source_id && sourceLookup.get(article.source_id)?.bias) || "center";
  const dist = buildBiasDistribution([bias as BiasKey]);
  const { is_blindspot, blindspot_side } = detectBlindspot(dist);

  const insertRes = await supabase
    .from("clusters")
    .insert({
      title_tr: article.title,
      title_en: article.title,
      summary_tr: summaryFallback(article.description),
      summary_en: summaryFallback(article.description),
      bias_distribution: dist,
      is_blindspot,
      blindspot_side,
      article_count: 1,
      first_published: article.published_at,
      updated_at: article.published_at,
    })
    .select("id")
    .single();

  if (insertRes.error) {
    throw new Error(`createCluster: ${insertRes.error.message}`);
  }
  const clusterId = (insertRes.data as { id: string }).id;

  // Idempotent on the unique (cluster_id, article_id) constraint — re-runs of
  // the same message will land on the same cluster row and be tolerated by
  // the duplicate-key swallow below.
  const linkRes = await supabase.from("cluster_articles").insert({
    cluster_id: clusterId,
    article_id: article.id,
  });
  if (linkRes.error && !/duplicate/i.test(linkRes.error.message)) {
    throw new Error(`createCluster link: ${linkRes.error.message}`);
  }
  return clusterId;
}

interface AddResult {
  skipped: boolean;
  reason?: string;
}

async function addArticleToCluster(
  sourceLookup: Map<string, SourceRow>,
  clusterId: string,
  article: EnrichedArticle,
): Promise<AddResult> {
  if (article.source_id) {
    const cached = clusterContextCache?.sourceIdsByCluster.get(clusterId);
    let existingSources = cached;
    if (!existingSources) {
      const dupRes = await supabase
        .from("cluster_articles")
        .select("article:articles(source_id)")
        .eq("cluster_id", clusterId);
      if (dupRes.error) {
        throw new Error(`addArticle dedupe-check: ${dupRes.error.message}`);
      }
      type DupRow = { article: { source_id: string | null } | null };
      existingSources = new Set(
        ((dupRes.data ?? []) as DupRow[])
          .map((r) => r.article?.source_id)
          .filter((x): x is string => Boolean(x)),
      );
      if (clusterContextCache) {
        clusterContextCache.sourceIdsByCluster.set(clusterId, existingSources);
      }
    }
    if (existingSources.has(article.source_id)) {
      return { skipped: true, reason: "duplicate-source" };
    }
  }

  // Round-6 P1 fix: read the existing member set FIRST so we can compute
  // the aggregate (bias distribution, blindspot, timestamps) against a
  // snapshot that INCLUDES the about-to-be-inserted article. The RPC
  // below then takes a per-cluster advisory lock, performs the INSERT
  // (idempotent via the (cluster_id, article_id) primary key), recounts
  // under the lock, and writes article_count + the aggregates we passed
  // in. This eliminates two races the previous shape carried:
  //   * Two consumers both INSERTing for the same cluster and both
  //     UPDATEing clusters.article_count from the pre-INSERT count,
  //     leaving the row permanently under-counted.
  //   * INSERT succeeding then UPDATE failing, leaving clusters stale
  //     while the (cluster_id, article_id) primary key blocks every
  //     retry from re-firing the recompute.
  const memberRes = await supabase
    .from("cluster_articles")
    .select("article_id")
    .eq("cluster_id", clusterId);
  if (memberRes.error) {
    throw new Error(`addArticle members: ${memberRes.error.message}`);
  }
  const memberIds = new Set<string>(
    ((memberRes.data ?? []) as Array<{ article_id: string }>).map(
      (r) => r.article_id,
    ),
  );
  // Include the about-to-be-inserted article so the aggregate matches
  // the count the RPC will compute under the lock.
  memberIds.add(article.id);

  const artRes = await supabase
    .from("articles")
    .select("id, source_id, published_at")
    .in("id", [...memberIds]);
  if (artRes.error) {
    throw new Error(`addArticle articles: ${artRes.error.message}`);
  }
  type AggRow = { id: string; source_id: string | null; published_at: string };
  const arts = (artRes.data ?? []) as AggRow[];
  const biasLabels = arts
    .map((a) => (a.source_id ? sourceLookup.get(a.source_id)?.bias ?? null : null))
    .filter((b): b is BiasKey => Boolean(b));
  const dist = buildBiasDistribution(biasLabels);
  const { is_blindspot, blindspot_side } = detectBlindspot(dist);

  const timestamps = arts
    .map((a) => new Date(a.published_at).getTime())
    .filter((t) => !Number.isNaN(t));
  const firstPublishedIso = timestamps.length
    ? new Date(Math.min(...timestamps)).toISOString()
    : new Date().toISOString();

  // clusters.updated_at is stamped server-side (now()) inside the RPC —
  // it is the /api/health liveness signal, not a member-article aggregate.
  const rpcRes = await supabase.rpc("cluster_link_atomic", {
    p_cluster_id: clusterId,
    p_article_id: article.id,
    p_bias_distribution: dist,
    p_is_blindspot: is_blindspot,
    p_blindspot_side: blindspot_side,
    p_first_published: firstPublishedIso,
  });
  if (rpcRes.error) {
    throw new Error(`addArticle rpc: ${rpcRes.error.message}`);
  }

  markClusterHasSource(clusterId, article.source_id);
  return { skipped: false };
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

/**
 * Build a per-cycle TF-IDF index that includes the article being scored plus
 * every seed/latest member of the rolling-window clusters. Doing this once
 * per message is wasteful in absolute terms but the seed/latest set is in
 * the low thousands at worst, and the TfidfIndex is pure in-memory math.
 */
function buildTfidfForArticle(
  article: EnrichedArticle,
  ctx: ClusterContext,
): TfidfIndex {
  const idx = new TfidfIndex();
  for (const [, seed] of ctx.seedByCluster.entries()) {
    idx.addDoc(seed.id, `${seed.title || ""} ${seed.description || ""}`);
  }
  for (const [, latest] of ctx.latestByCluster.entries()) {
    idx.addDoc(latest.id, `${latest.title || ""} ${latest.description || ""}`);
  }
  idx.addDoc(article.id, `${article.title || ""} ${article.description || ""}`);
  idx.finalize();
  return idx;
}

type ProcessResult = "matched" | "created" | "skipped" | "not-found" | "not-politics";

async function processArticle(articleId: string): Promise<ProcessResult> {
  const artRes = await supabase
    .from("articles")
    .select(
      "id, source_id, title, description, url, content_hash, published_at, fingerprint, entities, category",
    )
    .eq("id", articleId)
    .maybeSingle();
  if (artRes.error) {
    throw new Error(`processArticle fetch: ${artRes.error.message}`);
  }
  if (!artRes.data) return "not-found";
  const raw = artRes.data as ArticleRow;
  if (!raw.category || !POLITICS_CATEGORIES.includes(raw.category)) {
    return "not-politics";
  }

  try {
    return await clusterArticle(raw);
  } catch (err) {
    // Stamp the article URL onto the error so drainQueue's msg-error log
    // can include it without re-fetching the row (audit O14).
    if (err instanceof Error) {
      (err as Error & { article_url?: string }).article_url = raw.url;
    }
    throw err;
  }
}

async function clusterArticle(raw: ArticleRow): Promise<ProcessResult> {
  // Idempotency is enforced inside `cluster_link_atomic` via the
  // (cluster_id, article_id) primary key + per-cluster advisory lock:
  // a duplicate INSERT is a no-op but the recompute still runs, which
  // is the Round-6 P1 fix for "half-applied cluster writes" (link
  // committed, clusters UPDATE failed, idempotency check then locked
  // the row in its stale state forever). We deliberately do NOT
  // short-circuit on a pre-existing cluster_articles row anymore.

  const article = enrichArticleInMemory(raw);
  await persistEnrichment(article);

  const ctx = await getClusterContext();
  const sourceLookup = await getSourceLookup();
  const { seedByCluster, latestByCluster, indices } = ctx;

  // Strict-fingerprint fast-path against any indexed member.
  if (article.fingerprint) {
    const fpHit = indices.byFingerprint.get(article.fingerprint) || [];
    const blocked = new Set<string>();
    for (const clusterId of fpHit) {
      if (blocked.has(clusterId)) continue;
      try {
        const result = await addArticleToCluster(sourceLookup, clusterId, article);
        if (result.skipped) {
          blocked.add(clusterId);
          continue;
        }
        addMemberToIndices(clusterId, article);
        return "matched";
      } catch (err) {
        console.warn(
          `[cluster-consumer] fp-fast-path error ${article.id}: ${err instanceof Error ? err.message : err}`,
        );
        // Fall through to ensemble path on transient failure.
        break;
      }
    }
  }

  // Ensemble path.
  const tfidf = buildTfidfForArticle(article, ctx);
  const candidateIds = findCandidateClusters(article, indices);
  const articleFp = { strict: article.fingerprint, signature: article.signature };
  const aSourceSlug = article.source_id
    ? sourceLookup.get(article.source_id)?.slug ?? null
    : null;
  const FALLBACK_FLOOR = MATCH_THRESHOLD * 0.9;

  type Scored = { clusterId: string; score: number };
  const scored: Scored[] = [];

  for (const clusterId of candidateIds) {
    const seed = seedByCluster.get(clusterId);
    if (!seed) continue;
    const hoursDeltaSeed = hoursBetween(article.published_at, seed.published_at);
    if (hoursDeltaSeed > TIME_WINDOW_HOURS) continue;

    const seedFp = { strict: seed.fingerprint, signature: seed.signature ?? null };
    const tfidfCosineSeed = tfidf.cosine(article.id, seed.id);
    const bSourceSlugSeed = seed.source_id
      ? sourceLookup.get(seed.source_id)?.slug ?? null
      : null;
    const seedRes = score(
      articleFp,
      seedFp,
      article.entities,
      seed.entities,
      tfidfCosineSeed,
      hoursDeltaSeed,
      { aSourceSlug, bSourceSlug: bSourceSlugSeed },
    );

    let bestScore = seedRes.score;
    const latest = latestByCluster.get(clusterId);
    if (latest) {
      const hoursDeltaLatest = hoursBetween(article.published_at, latest.published_at);
      if (hoursDeltaLatest <= TIME_WINDOW_HOURS) {
        const latestFp = { strict: latest.fingerprint, signature: latest.signature ?? null };
        const tfidfCosineLatest = tfidf.cosine(article.id, latest.id);
        const bSourceSlugLatest = latest.source_id
          ? sourceLookup.get(latest.source_id)?.slug ?? null
          : null;
        const latestRes = score(
          articleFp,
          latestFp,
          article.entities,
          latest.entities,
          tfidfCosineLatest,
          hoursDeltaLatest,
          { aSourceSlug, bSourceSlug: bSourceSlugLatest },
        );
        if (latestRes.score > bestScore) bestScore = latestRes.score;
      }
    }

    if (bestScore >= FALLBACK_FLOOR) {
      scored.push({ clusterId, score: bestScore });
    }
  }
  scored.sort((a, b) => b.score - a.score);

  const blocked = new Set<string>();
  const primary = scored[0];
  if (primary && primary.score >= MATCH_THRESHOLD) {
    for (const cand of scored) {
      if (blocked.has(cand.clusterId)) continue;
      if (cand.score < FALLBACK_FLOOR) break;
      const result = await addArticleToCluster(sourceLookup, cand.clusterId, article);
      if (result.skipped) {
        blocked.add(cand.clusterId);
        continue;
      }
      addMemberToIndices(cand.clusterId, article);
      return "matched";
    }
  }

  // No viable match → spawn a new cluster. registerNewClusterInCache makes
  // sure subsequent dequeues in this same invocation see it.
  const newId = await createCluster(sourceLookup, article);
  registerNewClusterInCache(newId, {
    id: article.id,
    source_id: article.source_id,
    title: article.title,
    description: article.description,
    published_at: article.published_at,
    fingerprint: article.fingerprint,
    entities: article.entities,
    category: article.category,
    signature: article.signature ?? undefined,
  });
  return "created";
}

// ---------------------------------------------------------------------------
// Top-level invocation handler
// ---------------------------------------------------------------------------

interface InvocationSummary {
  drained: number;
  matched: number;
  created: number;
  skipped: number;
  notFound: number;
  notPolitics: number;
  failedTransient: number;
  failedPermanent: number;
  duration_ms: number;
  budgeted_out: boolean;
}

async function drainQueue(): Promise<InvocationSummary> {
  const startedAt = Date.now();
  const summary: InvocationSummary = {
    drained: 0,
    matched: 0,
    created: 0,
    skipped: 0,
    notFound: 0,
    notPolitics: 0,
    failedTransient: 0,
    failedPermanent: 0,
    duration_ms: 0,
    budgeted_out: false,
  };

  // Best-effort depth sample for the drain summary log (audit O13).
  const before = await queueDepth(supabase, QUEUE_NAME);

  // Force-warm cluster context once at the top of the invocation so the
  // per-message path is read-only against the cache (cheap).
  await getClusterContext();
  await getSourceLookup();

  while (true) {
    // Lease a new batch only while enough budget remains to actually
    // process it. pgmq bumps read_ct on every read, so a read that only
    // ever budget-outs walks a never-attempted message toward the poison
    // threshold (audit S11).
    if (Date.now() - startedAt > MAX_INVOCATION_MS - READ_BUDGET_FLOOR_MS) {
      summary.budgeted_out = true;
      break;
    }
    let messages: PgmqMessage<QueueMessage>[];
    try {
      messages = await readBatch<QueueMessage>(
        supabase,
        QUEUE_NAME,
        VT_SECONDS,
        BATCH_SIZE,
      );
    } catch (err) {
      console.error(
        `[cluster-consumer] pgmq.read failed: ${err instanceof Error ? err.message : err}`,
      );
      summary.failedTransient += 1;
      break;
    }
    if (messages.length === 0) break;

    for (const msg of messages) {
      if (Date.now() - startedAt >= MAX_INVOCATION_MS) {
        // Deadline hit mid-batch: leave the remaining messages untouched —
        // the visibility timeout returns them to the queue — and keep them
        // out of the poison accounting; only messages that genuinely
        // errored during processing reach the read_ct check below.
        summary.budgeted_out = true;
        break;
      }
      const articleId = msg.message?.article_id;
      if (!articleId || typeof articleId !== "string") {
        // Malformed payload — archive so it doesn't loop forever.
        try {
          await archive(supabase, QUEUE_NAME, msg.msg_id);
        } catch (err) {
          console.warn(
            `[cluster-consumer] archive of malformed msg ${msg.msg_id} failed: ${err instanceof Error ? err.message : err}`,
          );
        }
        summary.failedPermanent += 1;
        continue;
      }

      try {
        const result = await processArticle(articleId);
        await archive(supabase, QUEUE_NAME, msg.msg_id);
        summary.drained += 1;
        switch (result) {
          case "matched":
            summary.matched += 1;
            break;
          case "created":
            summary.created += 1;
            break;
          case "skipped":
            summary.skipped += 1;
            break;
          case "not-found":
            summary.notFound += 1;
            break;
          case "not-politics":
            summary.notPolitics += 1;
            break;
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const url =
          (err as { article_url?: string } | null | undefined)?.article_url ??
            null;
        console.error(
          "[cluster-consumer] msg-error",
          JSON.stringify({
            msg_id: msg.msg_id,
            read_ct: msg.read_ct,
            article_id: articleId,
            url,
            error: errMsg,
          }),
        );
        // Poison contract (shared with image-consumer): read_ct includes
        // the current read, so > MAX_READS means the visibility timeout
        // has already retried this message MAX_READS times and it's still
        // failing.
        if (msg.read_ct > MAX_READS) {
          try {
            // Archive — never delete — so the payload survives in
            // pgmq.a_cluster_work as the poison audit trail (audit S12).
            await archive(supabase, QUEUE_NAME, msg.msg_id);
          } catch (archErr) {
            console.warn(
              `[cluster-consumer] archive of permanent-failure msg ${msg.msg_id} failed: ${archErr instanceof Error ? archErr.message : archErr}`,
            );
          }
          summary.failedPermanent += 1;
        } else {
          // Don't archive/delete — let the visibility timeout expire so
          // pgmq.read picks it up again on the next invocation.
          summary.failedTransient += 1;
        }
      }
    }
    if (summary.budgeted_out) break;
    // If the batch came back smaller than BATCH_SIZE, the queue is drained
    // for now — exit the loop instead of paging on more empty reads.
    if (messages.length < BATCH_SIZE) break;
  }

  summary.duration_ms = Date.now() - startedAt;
  const after = await queueDepth(supabase, QUEUE_NAME);
  // One JSON-shaped summary line per drain (audit O13) — depth + oldest-age
  // samples are best-effort and surface as null when the metrics probe fails.
  console.log(
    "[cluster-consumer] drain",
    JSON.stringify({
      depth_before: before.depth,
      depth_after: after.depth,
      oldest_age_before_s: before.oldest_msg_age_sec,
      oldest_age_after_s: after.oldest_msg_age_sec,
      ...summary,
    }),
  );
  return summary;
}

// ---------------------------------------------------------------------------
// Deno.serve entrypoint
// ---------------------------------------------------------------------------

Deno.serve(withSentry("cluster-consumer", async (req: Request) => {
  // Defence-in-depth: require an explicit service-role bearer before any
  // method-routing or body-parsing logic runs. Returns a deterministic
  // JSON-shaped 401 so a misdeploy with `--no-verify-jwt` does not silently
  // expose the worker drain endpoint.
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;

  // GET is a cheap liveness probe (no DB or queue work). pg_cron and
  // operator-driven drains use POST.
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }
  try {
    const summary = await drainQueue();
    return new Response(JSON.stringify({ ok: true, ...summary }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const request_id = crypto.randomUUID();
    // Round-6 P1: forward to Sentry explicitly. The withSentry wrapper
    // only sees thrown errors; this catch builds a 500 response so the
    // throw never reaches the wrapper.
    captureException("cluster-consumer", err);
    // Log the full error (stack + message) to Edge Function logs as well.
    console.error(`[cluster-consumer] ${request_id}`, err);
    // Mark the cache as stale so a fresh invocation rebuilds from DB truth.
    clusterContextCache = null;
    sourceLookupCache = null;
    return new Response(
      JSON.stringify({ ok: false, error: "internal-error", request_id }),
      {
        status: 500,
        headers: { "content-type": "application/json" },
      },
    );
  }
}));
