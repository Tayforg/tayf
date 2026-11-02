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
  deserializeSignature,
  fingerprint,
  MINHASH_VERSION,
  serializeSignature,
  headlineTokens,
  normalizeTurkish,
  strictFingerprint,
  titleTokens,
  type FingerprintBundle,
  type HeadlineTokens,
} from "../_shared/cluster/fingerprint.ts";
import { extractEntities } from "../_shared/cluster/entities.ts";
import { bandKeys, LSH_BANDS } from "../_shared/cluster/lsh.ts";
import { TfidfIndex } from "../_shared/cluster/tfidf.ts";
import { headlineLane, headlineOnlyScore, score } from "../_shared/cluster/ensemble.ts";
import {
  CONTEXT_STICKY_HOURS,
  CONTEXT_STICKY_MAX,
  CONTEXT_STICKY_MIN_ARTICLES,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_MEMBER_SCAN_MAX,
  MATCH_THRESHOLD,
  MAX_CANDIDATE_CLUSTERS,
  MIN_SHARED_ENTITIES,
  TIME_WINDOW_HOURS,
  TOKEN_CANDIDATE_MIN_SHARED,
  TOKEN_MIN_LEN,
} from "../_shared/cluster/constants.ts";
import {
  CANDIDATE_SIZE_TIEBREAK_MARGIN,
  mergeProbeIds,
  rankCandidates,
  selectContextClusterIds,
  stickyUpperBound,
} from "../_shared/cluster/context-select.ts";
import {
  cleanDescription,
  DESCRIPTION_SWAP_GUARD,
  descriptionNamesSwap,
} from "../_shared/cluster/description-clean.ts";
import {
  BIAS_KEYS,
  type BiasKey,
  detectBlindspot,
} from "../_shared/cluster/blindspot.ts";
import { type SourceKind, votingBiasKeys } from "../_shared/cluster/source-kind.ts";
import { statePreview, stateHash } from "../_shared/jev.ts";
import { evaluateJev } from "../_shared/jev-client.ts";
import {
  budgetAllows,
  buildMarginalRequest,
  buildMarginalRow,
  classifyBand,
  decideMarginal,
  JEV_LIVE_POLICY,
  liveEnabled,
  newJevLiveState,
  type JevLiveRow,
  type JevLiveState,
} from "../_shared/cluster/jev-verify.ts";
import {
  admissionMode,
  claimArgs,
  isPoliticsMember,
  JEV_ADMISSION_POLICY,
  parseAdmitTag,
  routeMessage,
  type AdmissionMode,
} from "../_shared/cluster/politics-admission.ts";
import { admissionEffect } from "../_shared/cluster/admission-effect.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const QUEUE_NAME = "cluster_work";
// Messages processed per invocation. Kept small because each article is
// scored against the full cluster context, so large batches push a single
// invocation past the Edge compute limit. The cluster-drain pg_cron fires
// every minute, so a small batch still clears the backlog quickly and keeps
// steady state.
const BATCH_SIZE = 2;
// Upper bound on clusters held in the in-memory rolling context — see
// loadClusterContext. The context build fingerprints seed+latest of every
// included cluster on each cold invocation, and that per-invocation CPU is
// what trips the Edge Function compute limit (546): ~800 fingerprints at
// cap 400 exceeds it, ~300 at cap 150 stays under with margin. Signatures
// are read from articles.minhash_sig (filled lazily by persistEnrichment)
// and only rows without a valid stored signature are recomputed; raising
// the cap is a separate follow-up. On top of the cap, loadClusterContext adds
// up to CONTEXT_STICKY_MAX recent multi-article clusters (see
// _shared/cluster/context-select.ts) so follow-ups to busy stories stay
// matchable once the newest-200 window has moved past them.
const CONTEXT_CLUSTER_CAP = 200;             // was 60; replay showed +7pt recall at 200, and 200 clusters x ~3 members is far under the limit the unbounded load hit
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

// Exact-title probe (h12-cluster-1, migration 135). A story that comes back with
// the identical headline after the 200-cluster context window has moved on
// (Yusra Geyik: 269 clusters updated between posta 06:00 and cnn-turk 09:42)
// never met its own singleton and opened a twin. Once per article the consumer
// asks the database for the live clusters, updated in the last
// TITLE_PROBE_WINDOW_HOURS, whose folded seed title equals the article's folded
// title (public.cluster_title_probe, backed by clusters_title_key_live_idx).
// CONTEXT_CLUSTER_CAP stays 200: raising it is what trips the 546 CPU limit.
const TITLE_PROBE_WINDOW_HOURS = 24;
const TITLE_PROBE_LIMIT = 3;
// A headline with fewer distinct tokens than this ("CANLI", "SON DAKIKA") is
// too generic to be an identity key; the probe is skipped.
const TITLE_PROBE_MIN_TOKENS = 3;
// Members read for a probe hit; the same bound loadClusterContext's per-chunk
// reads effectively give a cluster, and far above any real cluster size we load.
const PROBE_MEMBER_LIMIT = 200;
// Columns of a cluster member the matcher needs (loadClusterContext and
// loadProbeCluster read the same shape).
const MEMBER_ARTICLE_SELECT =
  "id, source_id, title, description, published_at, fingerprint, entities, category, politics_admitted_at, minhash_sig, minhash_version";

// POLITICS_CATEGORIES / isPoliticsMember / admissionMode / routeMessage /
// claimArgs / parseAdmitTag now live in
// ../_shared/cluster/politics-admission.ts (imported above), migration 089
// ("ADMIT"). Ships with JEV_POLITICS_ADMISSION off, so none of this changes
// drain behaviour, writes or JSON in this PR beyond the `admission` summary
// block below.

// BIAS_KEYS / BiasKey / detectBlindspot now live in
// ../_shared/cluster/blindspot.ts (imported above) so the zone-based
// blindspot rule is pure, unit-tested, and shared.
//
// The kind -> vote rule (which source kinds count toward bias_distribution
// and therefore blindspot/surprise detection) lives in
// ../_shared/cluster/source-kind.ts. Aggregator/niche members still become
// cluster_articles rows — article_count counts them, membership is
// unaffected — they just never contribute a bias vote.

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
  politics_admitted_at: string | null;
}

interface EnrichedArticle extends ArticleRow {
  // signature is persisted to articles.minhash_sig by persistEnrichment.
  signature: Uint32Array | null;
  // entities normalised to non-null after enrichment.
  entities: string[];
  // The description the clustering inputs (fingerprint, entities, tf-idf) are
  // built from: `description` without a trailing "Son dakika..." ticker block
  // (cleanDescription, h12-cluster-5). The stored description is untouched.
  clusteringDescription: string | null;
}

interface SourceRow {
  id: string;
  bias: BiasKey | null;
  name: string | null;
  slug: string | null;
  kind: SourceKind | null;
}

interface ClusterRow {
  id: string;
  title_tr: string | null;
  title_tr_neutral: string | null;
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
  politics_admitted_at?: string | null;
  signature?: Uint32Array;
  minhash_sig?: number[] | null;
  minhash_version?: number | null;
}

// One member headline held for the ensemble loop's member scan.
interface HeadlineMember {
  id: string;
  publishedMs: number;
  sourceId: string | null;
  // The raw title, kept by reference only (no tokenising at context build, CPU
  // is tight): sameSourceDupEvidence compares folded titles from it.
  title: string;
  tokens: HeadlineTokens;
}

interface ClusterContext {
  fetchedAt: number;
  clusters: ClusterRow[];
  seedByCluster: Map<string, ClusterMemberArticle>;
  latestByCluster: Map<string, ClusterMemberArticle>;
  sourceIdsByCluster: Map<string, Set<string>>;
  // Recent member headlines per cluster, newest first, at most
  // HEADLINE_MEMBER_SCAN_MAX. Built from the member rows loadClusterContext
  // already fetched (no extra query) and extended by addMemberToIndices. An
  // incoming article is compared with these through the headline lane only,
  // so a cluster's middle members -- neither seed nor latest -- can still
  // attract the follow-up headlines they match.
  headlinesByCluster: Map<string, HeadlineMember[]>;
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
    byToken: Map<string, string[]>;
  };
  // Built once per context over seed+latest docs; incoming articles score
  // via cosineQuery instead of triggering a per-message rebuild.
  tfidf: TfidfIndex;
}

interface QueueMessage {
  article_id: string;
  admit?: unknown;
}

// ---------------------------------------------------------------------------
// Module-level caches — survive between invocations within the same instance.
// ---------------------------------------------------------------------------

const supabase: SupabaseClient = createServiceClient();

let clusterContextCache: ClusterContext | null = null;
let sourceLookupCache: { fetchedAt: number; lookup: Map<string, SourceRow> } | null = null;
const SOURCE_LOOKUP_TTL_MS = 5 * 60_000; // 5 minutes

// Live marginal-verification counters (P3, migration 064) -- RESET at the
// top of every drainQueue() invocation (see below). Read here as a plain
// module-scoped `let`, not inside a class, so the Deno-polyfill test harness
// (tests/functions/cluster-consumer.test.ts) can import the module fresh
// per test without any extra wiring.
let jevLive: JevLiveState = newJevLiveState(false);
// Attempts (not successes) gate the per-drain budget -- see A2 fix at the
// live-verification call site. Reset alongside `jevLive` at the top of
// drainQueue() so a timeout/5xx-only gateway outage still hard-stops at
// JEV_LIVE_POLICY.maxCallsPerDrain instead of never budgeting out.
let jevLiveAttempts = 0;
// h16-precision-2 (log-only): articles whose title and description name
// different people (see noteDescriptionSwap). Reset at the top of every
// drainQueue() next to jevLiveAttempts; at most 3 ids are kept as samples so
// the drain line stays small.
let descriptionSwapSuspects = 0;
let descriptionSwapSamples: string[] = [];
const DESCRIPTION_SWAP_SAMPLE_MAX = 3;
// Guards against two overlapping POST /drainQueue invocations in the same
// warm isolate: drainQueue() resets jevLive/jevLiveAttempts as its first
// statements, so a second concurrent drain would zero the first drain's
// in-flight counters (the 40-call live-verification budget would silently
// become 80+) and both HTTP responses / log lines would end up reporting
// the second drain's numbers. pgmq's own visibility timeout already
// prevents double-processing of the same queue message -- this guard is
// only about the live-verification budget and its counters. A concurrent
// POST is answered `{ ok: true, busy: true }` instead of draining.
let drainInFlight = false;

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

// title_tr_neutral (set once the neutral-title picker has run) wins over
// the raw title_tr when present; loadClusterContext/registerNewClusterInCache
// keep both columns populated on every ClusterRow.
function clusterTitleFromContext(ctx: ClusterContext, clusterId: string): string {
  const cluster = ctx.clusters.find((c) => c.id === clusterId);
  return cluster?.title_tr_neutral ?? cluster?.title_tr ?? "";
}

function hoursBetween(aIso: string, bIso: string): number {
  return (
    Math.abs(new Date(aIso).getTime() - new Date(bIso).getTime()) /
    (1000 * 60 * 60)
  );
}

// Reuse the persisted MinHash when its version matches; recompute otherwise.
function attachSignature(art: ClusterMemberArticle): void {
  if (art.signature) return;
  // Recomputed from the cleaned description, like the incoming article's own
  // enrichment (a milliyet member's "Son dakika..." ticker is not its text).
  const description = cleanDescription(art.description) || "";
  const stored = deserializeSignature(art.minhash_sig, art.minhash_version);
  if (stored) {
    art.signature = stored;
    if (!art.fingerprint) art.fingerprint = strictFingerprint(art.title || "", description);
    return;
  }
  const fp = fingerprint(art.title || "", description);
  art.signature = fp.signature;
  if (!art.fingerprint) art.fingerprint = fp.strict;
}

// The tf-idf document of a cluster member: title plus the cleaned description
// (the same text the incoming article's query is built from).
function memberTfidfText(art: { title: string; description: string | null }): string {
  return `${art.title || ""} ${cleanDescription(art.description) || ""}`;
}

function buildBiasDistribution(biasLabels: Array<BiasKey | null | undefined>): Record<BiasKey, number> {
  const dist = Object.fromEntries(BIAS_KEYS.map((k) => [k, 0])) as Record<BiasKey, number>;
  for (const b of biasLabels) {
    if (b && b in dist) dist[b as BiasKey]++;
  }
  return dist;
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
  const byToken = new Map<string, string[]>();
  const fpSeen = new Set<string>();
  const entSeen = new Set<string>();
  const tokSeen = new Set<string>();

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
    for (const tok of titleTokens(art.title, TOKEN_MIN_LEN)) {
      const key = `${row.cluster_id}|${tok}`;
      if (tokSeen.has(key)) continue;
      tokSeen.add(key);
      const list = byToken.get(tok) || [];
      list.push(row.cluster_id);
      byToken.set(tok, list);
    }
  }

  return { byFingerprint, byEntity, byBand, byToken };
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
  const loadStartedAt = Date.now();
  const clusterSelect = "id, title_tr, title_tr_neutral, first_published, updated_at, article_count";
  const newestRows: ClusterRow[] = [];
  {
    const res = await supabase
      .from("clusters")
      .select(clusterSelect)
      .gte("updated_at", cutoffIso)
      .order("updated_at", { ascending: false })
      .limit(CONTEXT_CLUSTER_CAP);
    if (res.error) {
      throw new Error(`loadClusterContext clusters: ${res.error.message}`);
    }
    newestRows.push(...((res.data ?? []) as ClusterRow[]));
  }

  // Sticky tail (2026-11-01). At peak the newest-CAP clusters span only ~2 h,
  // so a busy story that went quiet for a few hours fell out of the context
  // and its follow-ups opened duplicate clusters. When the window is full,
  // also load the recent, well-covered clusters just beyond it. This query is
  // best-effort: any failure leaves the newest-CAP context exactly as before.
  type StickyRow = ClusterRow & {
    is_archived?: boolean | null;
    merged_into?: string | null;
  };
  const stickyRows: StickyRow[] = [];
  const stickyBound = stickyUpperBound(newestRows, CONTEXT_CLUSTER_CAP);
  if (stickyBound !== null) {
    try {
      const stickyCutoffIso = new Date(
        Date.now() - CONTEXT_STICKY_HOURS * 60 * 60 * 1000,
      ).toISOString();
      const res = await supabase
        .from("clusters")
        .select(`${clusterSelect}, is_archived, merged_into`)
        .gte("updated_at", stickyCutoffIso)
        .lt("updated_at", stickyBound)
        .gte("article_count", CONTEXT_STICKY_MIN_ARTICLES)
        .eq("is_archived", false)
        .is("merged_into", null)
        .order("article_count", { ascending: false })
        .limit(CONTEXT_STICKY_MAX);
      if (res.error) {
        console.warn(
          `[cluster-consumer] sticky context query failed, continuing without it: ${res.error.message}`,
        );
      } else {
        stickyRows.push(...((res.data ?? []) as StickyRow[]));
      }
    } catch (err) {
      console.warn(
        `[cluster-consumer] sticky context query threw, continuing without it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  const rowsById = new Map<string, StickyRow>();
  for (const row of [...newestRows, ...stickyRows]) {
    if (!rowsById.has(row.id)) rowsById.set(row.id, row);
  }
  // Keep the ClusterRow shape (drop the sticky-only columns) downstream.
  const clusters: ClusterRow[] = selectContextClusterIds(
    [...rowsById.values()],
    {
      cap: CONTEXT_CLUSTER_CAP,
      stickyMinArticles: CONTEXT_STICKY_MIN_ARTICLES,
      stickyHours: CONTEXT_STICKY_HOURS,
      stickyMax: CONTEXT_STICKY_MAX,
      now: Date.now(),
    },
  ).map((id) => {
    const row = rowsById.get(id)!;
    return {
      id: row.id,
      title_tr: row.title_tr,
      title_tr_neutral: row.title_tr_neutral,
      first_published: row.first_published,
      updated_at: row.updated_at,
      article_count: row.article_count,
    };
  });
  console.log(
    `[cluster-consumer] context clusters=${clusters.length} sticky=${
      Math.max(0, clusters.length - Math.min(newestRows.length, CONTEXT_CLUSTER_CAP))
    } loadMs=${Date.now() - loadStartedAt}`,
  );

  // Constructed once per loadClusterContext call (not once per branch): the
  // empty-path returns below hand back this same untouched instance, and the
  // full path populates it in place instead of allocating a second one.
  const tfidf = new TfidfIndex();
  const emptyCtx: ClusterContext = {
    fetchedAt: Date.now(),
    clusters: [],
    seedByCluster: new Map(),
    latestByCluster: new Map(),
    sourceIdsByCluster: new Map(),
    headlinesByCluster: new Map(),
    indices: { byFingerprint: new Map(), byEntity: new Map(), byBand: new Map(), byToken: new Map() },
    tfidf,
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
    MEMBER_ARTICLE_SELECT,
    "id",
    allArticleIds,
    100,
  );
  // isPoliticsMember (migration 089): NOT flag-gated -- a cluster seeded
  // only by an admitted (politics_admitted_at-stamped) member must still
  // load as a seed even while the flag is off, or a later live claim would
  // silently orphan it from the rolling context.
  const politicsArticleRows = articleRows.filter((a) => isPoliticsMember(a));
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
      attachSignature(seed);
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
      attachSignature(latest);
      latestByCluster.set(clusterId, latest);
    }
  }

  const indices = buildMemberIndicesFromRows(caRows, memberArticles);

  // Band the seed/latest signatures. Seed/latest signatures come from
  // articles.minhash_sig when valid (attachSignature above) and are
  // recomputed only for rows without one — those are precisely the two the
  // ensemble scores against.
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

  // Populate the single tfidf instance declared above (built once per
  // context load); the ensemble path vectorizes each incoming article
  // against it via query()/cosineQuery() instead of rebuilding it per
  // message. Seeds first, then latests — same order the old per-message
  // build used.
  for (const seed of seedByCluster.values()) {
    tfidf.addDoc(seed.id, memberTfidfText(seed));
  }
  for (const latest of latestByCluster.values()) {
    tfidf.addDoc(latest.id, memberTfidfText(latest));
  }

  // Member headlines for the scan. Sorting is by publication time and only
  // the newest HEADLINE_MEMBER_SCAN_MAX members per cluster are tokenised, so
  // a 50-article story costs 12 tokenisations, not 50.
  const headlinesByCluster = new Map<string, HeadlineMember[]>();
  for (const [clusterId, ids] of memberIdsByCluster.entries()) {
    const members: Array<{ art: ClusterMemberArticle; ms: number }> = [];
    for (const id of ids) {
      const art = memberArticles.get(id);
      if (!art) continue;
      const ms = Date.parse(art.published_at);
      if (!Number.isFinite(ms)) continue;
      members.push({ art, ms });
    }
    if (members.length === 0) continue;
    members.sort((a, b) => b.ms - a.ms || (a.art.id < b.art.id ? -1 : 1));
    headlinesByCluster.set(
      clusterId,
      members.slice(0, HEADLINE_MEMBER_SCAN_MAX).map(({ art, ms }) => ({
        id: art.id,
        publishedMs: ms,
        sourceId: art.source_id,
        title: art.title,
        tokens: headlineTokens(art.title),
      })),
    );
  }

  return {
    fetchedAt: Date.now(),
    clusters,
    seedByCluster,
    latestByCluster,
    sourceIdsByCluster,
    headlinesByCluster,
    indices,
    tfidf,
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
  const res = await supabase.from("sources").select("id, bias, name, slug, kind");
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

// Insert a member headline into a cluster's newest-first scan list, keeping at
// most HEADLINE_MEMBER_SCAN_MAX entries. Idempotent per article id (a
// re-delivered message must not add a second copy).
function insertHeadlineMember(
  lists: Map<string, HeadlineMember[]>,
  clusterId: string,
  member: HeadlineMember,
) {
  if (!Number.isFinite(member.publishedMs)) return;
  const list = lists.get(clusterId) ?? [];
  if (list.some((m) => m.id === member.id)) return;
  let at = list.findIndex((m) => m.publishedMs < member.publishedMs);
  if (at === -1) at = list.length;
  list.splice(at, 0, member);
  if (list.length > HEADLINE_MEMBER_SCAN_MAX) list.length = HEADLINE_MEMBER_SCAN_MAX;
  lists.set(clusterId, list);
}

function addMemberToIndices(
  clusterId: string,
  article: {
    id: string;
    published_at: string;
    source_id: string | null;
    fingerprint: string | null;
    title: string;
    entities: string[] | null;
    signature?: Uint32Array | null;
  },
  // The context to index into: the module cache by default; loadProbeCluster
  // passes the context it is extending.
  target: ClusterContext | null = clusterContextCache,
) {
  if (!target) return;
  const idx = target.indices;
  // Member-headline scan list (see ClusterContext.headlinesByCluster). Covers
  // registerNewClusterInCache too, which routes the seed through here.
  insertHeadlineMember(target.headlinesByCluster, clusterId, {
    id: article.id,
    publishedMs: Date.parse(article.published_at),
    sourceId: article.source_id,
    title: article.title,
    tokens: headlineTokens(article.title),
  });
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
  for (const tok of titleTokens(article.title, TOKEN_MIN_LEN)) {
    const list = idx.byToken.get(tok) || [];
    if (!list.includes(clusterId)) {
      list.push(clusterId);
      idx.byToken.set(tok, list);
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
  // Makes the cluster scorable by the next message dequeued in this same
  // invocation — the old per-message rebuild included it implicitly.
  clusterContextCache.tfidf.addDoc(seed.id, memberTfidfText(seed));
  addMemberToIndices(clusterId, seed);
  clusterContextCache.sourceIdsByCluster.set(
    clusterId,
    new Set(seed.source_id ? [seed.source_id] : []),
  );
  clusterContextCache.clusters.push({
    id: clusterId,
    title_tr: seed.title,
    title_tr_neutral: null,
    first_published: seed.published_at,
    updated_at: seed.published_at,
    article_count: 1,
  });
}

// ---------------------------------------------------------------------------
// Exact-title probe (h12-cluster-1, migration 135)
// ---------------------------------------------------------------------------

// The probe is best-effort: the first failure in an isolate warns, later ones
// stay quiet (one log line per cold start, not one per article).
let titleProbeWarned = false;

function warnTitleProbeOnce(detail: string) {
  if (titleProbeWarned) return;
  titleProbeWarned = true;
  console.warn(
    `[cluster-consumer] cluster_title_probe failed, continuing without it: ${detail}`,
  );
}

// h14-cluster-1: every live same-source skip leaves one row in cluster_skip_log
// (migration 140): the skip is otherwise persisted nowhere (no cluster_articles
// row, the article row untouched), so a wrong skip could only be found in the
// function logs. Best-effort like the probe: a failed write warns once per
// isolate and never fails the message.
let skipLogWarned = false;

function warnSkipLogOnce(detail: string) {
  if (skipLogWarned) return;
  skipLogWarned = true;
  console.warn(`[cluster-consumer] cluster_skip_log insert failed, continuing: ${detail}`);
}

async function recordSkip(
  articleId: string,
  block: { clusterId: string; score: number; evidence: DupEvidence },
): Promise<void> {
  try {
    const res = await supabase.from("cluster_skip_log").upsert(
      [
        {
          article_id: articleId,
          cluster_id: block.clusterId,
          score: block.score,
          reason: `same-source-duplicate/${block.evidence}`,
        },
      ],
      { onConflict: "article_id", ignoreDuplicates: true },
    );
    if (res.error) warnSkipLogOnce(res.error.message);
  } catch (err) {
    warnSkipLogOnce(err instanceof Error ? err.message : String(err));
  }
}

// Reads one probe hit's members and registers the cluster in `ctx` the way
// loadClusterContext would have: seed = earliest member, latest = newest other
// member, signatures attached, tf-idf docs, source ids, the candidate indices
// and the member-headline scan list for the newest HEADLINE_MEMBER_SCAN_MAX
// members. Returns false when the cluster has no politics member to score.
// Everything that can fail (the two reads) runs before ctx is touched, so a
// throw leaves the context exactly as it was.
async function loadProbeCluster(ctx: ClusterContext, row: ClusterRow): Promise<boolean> {
  const caRes = await supabase
    .from("cluster_articles")
    .select("article_id")
    .eq("cluster_id", row.id)
    .limit(PROBE_MEMBER_LIMIT);
  if (caRes.error) throw new Error(`cluster_articles: ${caRes.error.message}`);
  const articleIds = [
    ...new Set(((caRes.data ?? []) as Array<{ article_id: string }>).map((r) => r.article_id)),
  ];
  if (articleIds.length === 0) return false;

  const articleRows = await inChunked<ClusterMemberArticle>(
    "articles",
    MEMBER_ARTICLE_SELECT,
    "id",
    articleIds,
    100,
  );
  // Same membership rule as the context loader (isPoliticsMember is not flag-gated).
  const members = articleRows
    .filter((a) => isPoliticsMember(a))
    .map((art) => ({ art, ms: Date.parse(art.published_at) }))
    .filter((m) => Number.isFinite(m.ms))
    .sort((a, b) => a.ms - b.ms || (a.art.id < b.art.id ? -1 : 1));
  const first = members[0];
  if (!first) return false;
  const seed = first.art;
  const latest = members.length > 1 ? members[members.length - 1]!.art : null;
  attachSignature(seed);
  if (latest) attachSignature(latest);

  ctx.clusters.push({
    id: row.id,
    title_tr: row.title_tr ?? seed.title,
    title_tr_neutral: row.title_tr_neutral ?? null,
    first_published: row.first_published ?? seed.published_at,
    updated_at: row.updated_at ?? seed.published_at,
    article_count: Number(row.article_count) || members.length,
  });
  ctx.seedByCluster.set(row.id, seed);
  if (latest) ctx.latestByCluster.set(row.id, latest);
  ctx.sourceIdsByCluster.set(
    row.id,
    new Set(members.map((m) => m.art.source_id).filter((x): x is string => Boolean(x))),
  );
  ctx.tfidf.addDoc(seed.id, memberTfidfText(seed));
  if (latest) ctx.tfidf.addDoc(latest.id, memberTfidfText(latest));
  for (const m of members.slice(-HEADLINE_MEMBER_SCAN_MAX)) {
    addMemberToIndices(row.id, m.art, ctx);
  }
  return true;
}

// Ids of the live clusters (updated in the last TITLE_PROBE_WINDOW_HOURS)
// whose folded seed title equals this article's folded title, loaded into
// `ctx` so the scorer can see them. [] when the headline is too generic, on
// any failure, or when nothing matches. Never called in a dry run.
async function probeExactTitleClusters(
  ctx: ClusterContext,
  article: EnrichedArticle,
): Promise<string[]> {
  if (headlineTokens(article.title).tokens.size < TITLE_PROBE_MIN_TOKENS) return [];

  let rows: ClusterRow[];
  try {
    const res = await supabase.rpc("cluster_title_probe", {
      p_title: article.title,
      p_since: new Date(Date.now() - TITLE_PROBE_WINDOW_HOURS * 3_600_000).toISOString(),
      p_limit: TITLE_PROBE_LIMIT,
    });
    if (res.error) {
      warnTitleProbeOnce(res.error.message);
      return [];
    }
    rows = Array.isArray(res.data) ? (res.data as ClusterRow[]) : [];
  } catch (err) {
    warnTitleProbeOnce(err instanceof Error ? err.message : String(err));
    return [];
  }

  const ids: string[] = [];
  for (const row of rows.slice(0, TITLE_PROBE_LIMIT)) {
    if (!row || typeof row.id !== "string") continue;
    if (ctx.seedByCluster.has(row.id)) {
      ids.push(row.id);
      continue;
    }
    // In the context but without a scorable seed: loading it again would not help.
    if (ctx.clusters.some((c) => c.id === row.id)) continue;
    try {
      if (await loadProbeCluster(ctx, row)) ids.push(row.id);
    } catch (err) {
      console.warn(
        `[cluster-consumer] title probe: cluster ${row.id} not loaded, skipping it: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  return ids;
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

  // Title-token votes: lets stories with no whitelisted entity at all
  // (a dead actor, a ferry sinking, a journalist's arrest) reach the
  // scorer. The scorer still decides; this only widens the funnel.
  const tokenCounts = new Map<string, number>();
  for (const tok of titleTokens(article.title, TOKEN_MIN_LEN)) {
    const hit = indices.byToken.get(tok);
    if (!hit) continue;
    for (const id of hit) {
      tokenCounts.set(id, (tokenCounts.get(id) || 0) + 1);
    }
  }
  for (const [id, shared] of tokenCounts.entries()) {
    if (shared >= TOKEN_CANDIDATE_MIN_SHARED) {
      const prev = candidates.get(id) ?? 0;
      candidates.set(id, Math.max(prev, shared));
    }
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
  // Entities, fingerprint and tf-idf are built from the description WITHOUT a
  // trailing "Son dakika..." ticker block (h12-cluster-5); the stored
  // description, createCluster's summary and the ingest-side content_hash keep
  // the original text.
  const clusteringDescription = cleanDescription(article.description);
  const fp: FingerprintBundle = fingerprint(article.title || "", clusteringDescription || "");
  const freshEnts = extractEntities(
    `${article.title || ""} ${clusteringDescription || ""}`,
  ) || [];
  return {
    ...article,
    fingerprint: fp.strict,
    entities: freshEnts,
    signature: fp.signature,
    clusteringDescription,
  };
}

// h16-precision-2: counts articles whose title names someone the description
// does not (sabah 1bf7ab12 carried the Berdimuhammedov description under an
// Erhurman title). LOG-ONLY: it reads the cleaned description the clustering
// already uses and changes none of it -- enrichment, entities, fingerprint,
// tf-idf, scoring and cluster writes are untouched. 'drop-description' is
// NOT wired in this wave; it counts like 'log'. A detector error counts
// nothing and never fails the message.
function noteDescriptionSwap(
  id: string,
  title: string | null,
  clusteringDescription: string | null,
): void {
  if (DESCRIPTION_SWAP_GUARD === "off") return;
  let suspect = false;
  try {
    suspect = descriptionNamesSwap(title, clusteringDescription);
  } catch {
    return;
  }
  if (!suspect) return;
  descriptionSwapSuspects += 1;
  if (descriptionSwapSamples.length < DESCRIPTION_SWAP_SAMPLE_MAX) {
    descriptionSwapSamples.push(id);
  }
}

async function persistEnrichment(article: EnrichedArticle): Promise<void> {
  // Only patch the columns we recompute; never touch the immutable fields.
  const update = {
    fingerprint: article.fingerprint,
    entities: article.entities,
    minhash_sig: article.signature ? serializeSignature(article.signature) : null,
    minhash_version: article.signature ? MINHASH_VERSION : null,
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
  const src = article.source_id ? sourceLookup.get(article.source_id) : undefined;
  // Unknown source rows keep the legacy "center" fallback and vote; a known
  // source votes only when its kind does (outlet/wire). A null bias on a
  // known row still falls back to center, as before.
  const dist = buildBiasDistribution(
    src ? votingBiasKeys([{ bias: src.bias ?? "center", kind: src.kind }]) : ["center"],
  );
  // dist now contains voting sources only, so the blindspot verdict below
  // is over classified (outlet/wire) sources.
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

// Pure, read-only dedupe check for a dry-run (shadow) claim: reads only the
// in-memory cluster context's sourceIdsByCluster, never touches the DB.
// Migration 089's rule -- "dry-run must never call addArticleToCluster: even
// its dedupe branch can issue a DB read" -- means a dry-run that hasn't
// warmed the cache for this cluster yet treats it as "no duplicate" rather
// than falling back to a live query.
function wouldDuplicate(
  ctx: ClusterContext,
  clusterId: string,
  article: EnrichedArticle,
): boolean {
  if (!article.source_id) return false;
  const existingSources = ctx.sourceIdsByCluster.get(clusterId);
  if (!existingSources) return false;
  return existingSources.has(article.source_id);
}

// What ties an incoming article to a member of the SAME source in a cluster
// that blocked it as a duplicate-source. The same-source skip (h12-cluster-1)
// is taken only on one of these; a bare ensemble score is not enough, because
// a templated MinHash false match scored 0.85 for a different story
// (h14-cluster-1).
//   fingerprint   the strict fingerprint equals an indexed member's (clusterArticle's fast path)
//   exact-title   the folded headline equals a same-source member's, or the
//                 cluster came from the exact-title probe (its seed headline
//                 equals this article's)
//   headline-lane the headline lane fires against a same-source member
type DupEvidence = "fingerprint" | "exact-title" | "headline-lane";

// Pure and in-memory (no DB read, dry-run safe). Reads the same-source members
// of the cluster from ctx.headlinesByCluster (the newest HEADLINE_MEMBER_SCAN_MAX)
// plus the seed and latest rows, and returns the strongest evidence found, or
// null when nothing ties the article to one of them. Exact-title wins over the
// lane when different members of the source give both.
function sameSourceDupEvidence(
  ctx: ClusterContext,
  clusterId: string,
  article: Pick<EnrichedArticle, "id" | "source_id" | "title" | "published_at">,
  articleHeadline: HeadlineTokens,
  probeHit: boolean,
): DupEvidence | null {
  if (!article.source_id) return null;
  // A generic headline ("CANLI", "SON DAKIKA") is no identity key: the same
  // floor the exact-title probe applies.
  const identifiable = articleHeadline.tokens.size >= TITLE_PROBE_MIN_TOKENS;
  if (probeHit && identifiable) return "exact-title";

  const members: Array<{ id: string; ms: number; title: string; tokens: HeadlineTokens }> = [];
  const listed = new Set<string>();
  for (const m of ctx.headlinesByCluster.get(clusterId) ?? []) {
    if (m.sourceId !== article.source_id || m.id === article.id) continue;
    listed.add(m.id);
    members.push({ id: m.id, ms: m.publishedMs, title: m.title, tokens: m.tokens });
  }
  // Seed and latest may fall outside the scan list (older than its newest
  // HEADLINE_MEMBER_SCAN_MAX); they are the rows the scorer compared against.
  for (const m of [ctx.seedByCluster.get(clusterId), ctx.latestByCluster.get(clusterId)]) {
    if (!m || m.source_id !== article.source_id || m.id === article.id || listed.has(m.id)) continue;
    listed.add(m.id);
    members.push({ id: m.id, ms: Date.parse(m.published_at), title: m.title, tokens: headlineTokens(m.title) });
  }
  if (members.length === 0) return null;

  const articleMs = Date.parse(article.published_at);
  const articleKey = identifiable ? normalizeTurkish(article.title) : "";
  let evidence: DupEvidence | null = null;
  for (const m of members) {
    if (articleKey !== "" && articleKey === normalizeTurkish(m.title)) return "exact-title";
    if (
      evidence === null &&
      Number.isFinite(articleMs) &&
      Number.isFinite(m.ms) &&
      headlineLane(articleHeadline, m.tokens, Math.abs(articleMs - m.ms) / 3_600_000).fired
    ) {
      evidence = "headline-lane";
    }
  }
  return evidence;
}

// The score a scored pair may contribute to the fallback join loop (see the
// call site). A result below MATCH_THRESHOLD whose entity/tfidf lane was capped
// by ENTITY_TEXT_FLOOR (components.textFloorCapped) and which that capped lane
// alone produced (raw above the MinHash lane's score; the headline lane never
// coexists with the cap) is entities-only evidence: it contributes 0. Any other
// result contributes its own score. Total over partial `components` objects.
function fallbackEligibleScore(res: {
  score: number;
  components?: Partial<{ textFloorCapped: boolean; raw: number; jaccardScore: number }>;
}): number {
  const c = res.components;
  const carriedByCappedLane = c?.textFloorCapped === true &&
    typeof c.raw === "number" && typeof c.jaccardScore === "number" &&
    c.raw > c.jaccardScore;
  return carriedByCappedLane && res.score < MATCH_THRESHOLD ? 0 : res.score;
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
        ((dupRes.data ?? []) as unknown as DupRow[])
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
  const biasLabels = votingBiasKeys(
    arts.map((a) => (a.source_id ? sourceLookup.get(a.source_id) ?? null : null)),
  );
  const dist = buildBiasDistribution(biasLabels);
  // dist now contains voting sources only, so the blindspot verdict below
  // is over classified (outlet/wire) sources.
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
// Live marginal-verification prediction write (P3, migration 064). Every
// jev_shadow_predictions row this module writes goes through here so the
// insert failure path is centralised: never rethrows, always accounted for
// in jevLive.errors, called AFTER the join/reject/unchanged decision has
// already been executed so `decision` reflects the truth.
// ---------------------------------------------------------------------------

async function recordMarginal(row: JevLiveRow): Promise<void> {
  try {
    const res = await supabase
      .from("jev_shadow_predictions")
      .upsert([row], { onConflict: "task,subject_id", ignoreDuplicates: true });
    if (res.error) {
      jevLive.errors += 1;
    }
  } catch {
    jevLive.errors += 1;
  }
}

// ---------------------------------------------------------------------------
// Per-message processing
// ---------------------------------------------------------------------------

type ProcessResult =
  | "matched"
  | "created"
  | "skipped"
  | "not-found"
  | "not-politics"
  | "would_match"
  | "would_create"
  | "disabled"
  | "rejected";

// Carries the touched cluster id alongside the outcome so drainQueue can
// build the revalidation tag list without re-deriving it from scratch.
// score/sourcesBefore (089) are populated only for admission-claimed
// (admit-tagged) messages, read-only copies taken BEFORE any mutation, so a
// plain (non-admitted) message's outcome shape is unaffected.
interface ProcessOutcome {
  result: ProcessResult;
  // Why a "skipped" outcome was skipped ("same-source-duplicate").
  reason?: string;
  clusterId?: string;
  score?: number;
  sourcesBefore?: string[];
  articleSourceId?: string | null;
}

async function processArticle(
  articleId: string,
  admitTag: "shadow" | "live" | null,
  mode: AdmissionMode,
): Promise<ProcessOutcome> {
  const artRes = await supabase
    .from("articles")
    .select(
      "id, source_id, title, description, url, content_hash, published_at, fingerprint, entities, category, politics_admitted_at",
    )
    .eq("id", articleId)
    .maybeSingle();
  if (artRes.error) {
    throw new Error(`processArticle fetch: ${artRes.error.message}`);
  }
  if (!artRes.data) return { result: "not-found" };
  const raw = artRes.data as ArticleRow;

  const route = routeMessage(raw, admitTag, mode);

  try {
    switch (route) {
      case "cluster": {
        const outcome = await clusterArticle(raw);
        return { ...outcome, articleSourceId: raw.source_id };
      }
      case "dry-run": {
        const outcome = await clusterArticle(raw, { dryRun: true });
        return { ...outcome, articleSourceId: raw.source_id };
      }
      case "not-politics":
        return { result: "not-politics", articleSourceId: raw.source_id };
      case "disabled":
        return { result: "disabled", articleSourceId: raw.source_id };
      case "rejected":
        return { result: "rejected", articleSourceId: raw.source_id };
    }
  } catch (err) {
    // Stamp the article URL onto the error so drainQueue's msg-error log
    // can include it without re-fetching the row (audit O14).
    if (err instanceof Error) {
      (err as Error & { article_url?: string }).article_url = raw.url;
    }
    throw err;
  }
}

async function clusterArticle(
  raw: ArticleRow,
  opts: { dryRun?: boolean } = {},
): Promise<ProcessOutcome> {
  const dryRun = opts.dryRun === true;
  // Idempotency is enforced inside `cluster_link_atomic` via the
  // (cluster_id, article_id) primary key + per-cluster advisory lock:
  // a duplicate INSERT is a no-op but the recompute still runs, which
  // is the Round-6 P1 fix for "half-applied cluster writes" (link
  // committed, clusters UPDATE failed, idempotency check then locked
  // the row in its stale state forever). We deliberately do NOT
  // short-circuit on a pre-existing cluster_articles row anymore.

  const article = enrichArticleInMemory(raw);
  noteDescriptionSwap(raw.id, raw.title, article.clusteringDescription);
  if (!dryRun) {
    await persistEnrichment(article);
  }

  const ctx = await getClusterContext();
  const sourceLookup = await getSourceLookup();
  const { seedByCluster, latestByCluster, headlinesByCluster, indices } = ctx;

  // h12-cluster-1, narrowed by h14-cluster-1: remembers the first cluster that
  // matched at MATCH_THRESHOLD or better, was blocked because it already holds
  // this article's source, AND is tied to that source's own member by strong
  // evidence (DupEvidence: equal strict fingerprint, equal folded headline, or
  // the headline lane against that member). If nothing else takes the article,
  // opening a new cluster would only create a twin of that cluster, so the
  // article is skipped instead (see the end of this function). A block without
  // evidence is not recorded: a bare ensemble score is not proof of a
  // duplicate. #152 skipped on the score alone and dropped two cumhuriyet film
  // articles ("Muhbir", "Eller Yukarı") as duplicates of the "Suikast Treni"
  // cluster, matched at 0.85 only through the shared description template; such
  // an article now falls through to createCluster, as before #152. A holder
  // object rather than a `let`, so the narrowing of the closure-assigned value
  // stays honest for the compiler.
  const dupBlock: { clusterId: string | null; score: number; evidence: DupEvidence | null } = {
    clusterId: null,
    score: 0,
    evidence: null,
  };
  const noteDupBlock = (clusterId: string, matchScore: number, evidence: DupEvidence | null) => {
    if (evidence === null) return;
    if (matchScore >= MATCH_THRESHOLD && dupBlock.clusterId === null) {
      dupBlock.clusterId = clusterId;
      dupBlock.score = matchScore;
      dupBlock.evidence = evidence;
    }
  };

  // Strict-fingerprint fast-path against any indexed member.
  if (article.fingerprint) {
    const fpHit = indices.byFingerprint.get(article.fingerprint) || [];
    const blocked = new Set<string>();
    for (const clusterId of fpHit) {
      if (blocked.has(clusterId)) continue;
      if (dryRun) {
        // wouldDuplicate is pure and read-only (in-memory context only) --
        // dry-run must never call addArticleToCluster, even its dedupe
        // branch can issue a DB read.
        if (wouldDuplicate(ctx, clusterId, article)) {
          blocked.add(clusterId);
          noteDupBlock(clusterId, 1, "fingerprint");
          continue;
        }
        return {
          result: "would_match",
          clusterId,
          score: 1,
          sourcesBefore: [...(ctx.sourceIdsByCluster.get(clusterId) ?? [])],
        };
      }
      try {
        const result = await addArticleToCluster(sourceLookup, clusterId, article);
        if (result.skipped) {
          blocked.add(clusterId);
          // An identical item from a source the cluster already holds.
          if (result.reason === "duplicate-source") noteDupBlock(clusterId, 1, "fingerprint");
          continue;
        }
        addMemberToIndices(clusterId, article);
        return { result: "matched", clusterId };
      } catch (err) {
        console.warn(
          `[cluster-consumer] fp-fast-path error ${article.id}: ${err instanceof Error ? err.message : err}`,
        );
        // Fall through to ensemble path on transient failure.
        break;
      }
    }
  }

  // Ensemble path. The context's TF-IDF index is built once per
  // loadClusterContext; vectorize this article against it instead of
  // rebuilding the index per message.
  // Pass article.id as selfId: if this article is already indexed in
  // ctx.tfidf (a re-delivered message, or a re-processed existing
  // seed/latest — clusterArticle explicitly supports both), cosineQuery
  // must treat this as a replace, not a second doc in the corpus.
  //
  // First the exact-title probe (h12-cluster-1): clusters outside the context
  // window whose seed headline is identical to this one are loaded into the
  // context here, before the query vector is built, so the tf-idf corpus is
  // the one the scorer will compare against. Not in a dry run.
  const probeIds = dryRun ? [] : await probeExactTitleClusters(ctx, article);
  const probeSet = new Set(probeIds);
  const tfidfQuery = ctx.tfidf.query(
    `${article.title || ""} ${article.clusteringDescription || ""}`,
    article.id,
  );
  // Probe hits go in front and are not counted against MAX_CANDIDATE_CLUSTERS.
  const candidateIds = mergeProbeIds(probeIds, findCandidateClusters(article, indices));
  const articleFp = { strict: article.fingerprint, signature: article.signature };
  const aSourceSlug = article.source_id
    ? sourceLookup.get(article.source_id)?.slug ?? null
    : null;
  const FALLBACK_FLOOR = MATCH_THRESHOLD * 0.9;
  // Headline tokens of the incoming article, computed once for the member scan.
  const articleHeadline = headlineTokens(article.title);
  const articleMs = Date.parse(article.published_at);
  const scanWindowMs = HEADLINE_LANE_MAX_HOURS * 3_600_000;

  // `score` ranks candidates and feeds Jev's bands. `fallbackScore` is what the
  // fallback loop below may join on: the best result that is NOT carried by the
  // text-floor-capped entity/tfidf lane (see fallbackEligibleScore).
  type Scored = { clusterId: string; score: number; fallbackScore: number };
  const scored: Scored[] = [];

  for (const clusterId of candidateIds) {
    const seed = seedByCluster.get(clusterId);
    if (!seed) continue;
    const hoursDeltaSeed = hoursBetween(article.published_at, seed.published_at);
    if (hoursDeltaSeed > TIME_WINDOW_HOURS) continue;

    const seedFp = { strict: seed.fingerprint, signature: seed.signature ?? null };
    const tfidfCosineSeed = ctx.tfidf.cosineQuery(tfidfQuery, seed.id);
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
      {
        aSourceSlug,
        bSourceSlug: bSourceSlugSeed,
        aTitle: article.title,
        bTitle: seed.title,
      },
    );

    let bestScore = seedRes.score;
    let fallbackScore = fallbackEligibleScore(seedRes);
    const latest = latestByCluster.get(clusterId);
    if (latest) {
      const hoursDeltaLatest = hoursBetween(article.published_at, latest.published_at);
      if (hoursDeltaLatest <= TIME_WINDOW_HOURS) {
        const latestFp = { strict: latest.fingerprint, signature: latest.signature ?? null };
        const tfidfCosineLatest = ctx.tfidf.cosineQuery(tfidfQuery, latest.id);
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
          {
            aSourceSlug,
            bSourceSlug: bSourceSlugLatest,
            aTitle: article.title,
            bTitle: latest.title,
          },
        );
        if (latestRes.score > bestScore) bestScore = latestRes.score;
        fallbackScore = Math.max(fallbackScore, fallbackEligibleScore(latestRes));
      }
    }

    // Member-headline scan. The cluster's other recent members (newest first;
    // seed, latest and the article itself are skipped: the full scorer above
    // already saw seed and latest) are compared through the headline lane
    // only, within the lane's own hour limit. A headline-lane result is
    // never the text-floor-capped lane, so it is fallback-eligible as is.
    // Pure in-memory work: headlinesByCluster came from rows already loaded.
    const memberHeadlines = Number.isFinite(articleMs)
      ? headlinesByCluster.get(clusterId)
      : undefined;
    if (memberHeadlines) {
      for (const m of memberHeadlines) {
        if (m.id === seed.id || m.id === latest?.id || m.id === article.id) continue;
        // Newest first: members newer than the window are skipped, and the
        // first one older than it ends the scan.
        if (m.publishedMs > articleMs + scanWindowMs) continue;
        if (m.publishedMs < articleMs - scanWindowMs) break;
        const memberScore = headlineOnlyScore(
          articleHeadline,
          m.tokens,
          Math.abs(articleMs - m.publishedMs) / 3_600_000,
          {
            aSourceSlug,
            bSourceSlug: m.sourceId ? sourceLookup.get(m.sourceId)?.slug ?? null : null,
          },
        );
        if (memberScore > bestScore) bestScore = memberScore;
        if (memberScore > fallbackScore) fallbackScore = memberScore;
      }
    }

    if (bestScore >= FALLBACK_FLOOR) {
      scored.push({ clusterId, score: bestScore, fallbackScore });
    }
  }
  // Best score first, except that among the candidates which all match
  // (>= MATCH_THRESHOLD) and sit within CANDIDATE_SIZE_TIEBREAK_MARGIN of the
  // best one, the larger cluster goes first: the 18-article original, not its
  // 7-article twin (h12-cluster-1). The size is the row's article_count or the
  // number of member sources loaded for it, whichever is larger.
  const articleCountById = new Map<string, number>();
  for (const c of ctx.clusters) articleCountById.set(c.id, Number(c.article_count) || 0);
  const sizeOf = (clusterId: string): number =>
    Math.max(
      articleCountById.get(clusterId) ?? 0,
      ctx.sourceIdsByCluster.get(clusterId)?.size ?? 0,
    );
  const ranked = rankCandidates(scored, sizeOf, {
    margin: CANDIDATE_SIZE_TIEBREAK_MARGIN,
    threshold: MATCH_THRESHOLD,
  });

  const primary = ranked[0];

  // ---------------------------------------------------------------------
  // P3 live marginal verification (migration 064, JEV_LIVE_PAIRS flag).
  // Exactly one gateway call per article, always about `primary` only, and
  // only in the two narrow bands where the ensemble's own decision is a
  // single hair's-width call. `jevLive.enabled` is false (and this whole
  // block a no-op) whenever the flag is unset/off or AI_GATEWAY_API_KEY is
  // missing -- see drainQueue's reset of `jevLive` -- so with the flag off
  // this function's behaviour, DB writes and JSON output are byte-for-byte
  // identical to before this pack, apart from the `jev_live` summary block
  // added far below.
  //
  // Every failure path here (budget exhausted, gateway timeout/error,
  // malformed response, failed prediction insert) falls through leaving
  // the ensemble's decision untouched -- this block only ever RETURNS
  // early on an executed "join", and only ever narrows the fallback loop
  // below via `marginalRejectedClusterId` on an executed "reject".
  // ---------------------------------------------------------------------
  const band = primary
    ? classifyBand({
        score: primary.score,
        floor: FALLBACK_FLOOR,
        threshold: MATCH_THRESHOLD,
        highBand: JEV_LIVE_POLICY.highBandWidth,
      })
    : "none";
  let marginalRejectedClusterId: string | null = null;
  // Set only when the gateway's own answer says "join" -- the actual DB
  // write (addArticleToCluster) happens AFTER the try/catch below, outside
  // any try, so a thrown DB error propagates unchanged instead of being
  // mis-counted as a gateway failure (contract §G).
  let pendingJoin: {
    probability: number;
    hash: string;
    preview: string;
    latencyMs: number;
    inputTokens: number;
  } | null = null;

  if (jevLive.enabled && primary && band !== "none" && !dryRun) {
    // Budget is gated on ATTEMPTS, not successes -- jevLiveAttempts is
    // bumped immediately before the gateway call below regardless of
    // outcome, so a gateway outage (timeouts/5xx on every call) still
    // hard-stops at JEV_LIVE_POLICY.maxCallsPerDrain instead of burning up
    // to timeoutMs per article for the rest of the drain.
    if (!budgetAllows(jevLiveAttempts)) {
      jevLive.budget_skipped += 1;
    } else {
      const apiKey = Deno.env.get("AI_GATEWAY_API_KEY") ?? "";
      const request = buildMarginalRequest({
        headlineA: article.title,
        headlineB: clusterTitleFromContext(ctx, primary.clusterId),
        headlineC: latestByCluster.get(primary.clusterId)?.title ?? null,
      });
      try {
        jevLiveAttempts += 1;
        const { response, latencyMs } = await evaluateJev(apiKey, request, {
          timeoutMs: JEV_LIVE_POLICY.timeoutMs,
          maxRetries: JEV_LIVE_POLICY.maxRetries,
        });
        jevLive.calls += 1;

        const answer = response.answers.p1;
        if (!answer || answer.type !== "boolean") {
          // Malformed/incomplete gateway response for our one question --
          // never fabricate a probability; leave the ensemble untouched.
          jevLive.errors += 1;
        } else {
          const probability = answer.probability;
          const decision = decideMarginal({
            score: primary.score,
            floor: FALLBACK_FLOOR,
            threshold: MATCH_THRESHOLD,
            highBand: JEV_LIVE_POLICY.highBandWidth,
            probability,
          });
          const hash = await stateHash(request.state);
          const preview = statePreview(request.state);

          if (decision === "join") {
            // The DB write itself happens after this try/catch closes --
            // see pendingJoin above.
            pendingJoin = { probability, hash, preview, latencyMs, inputTokens: response.usage.inputTokens };
          } else if (decision === "reject") {
            marginalRejectedClusterId = primary.clusterId;
            jevLive.rejected_by_jev += 1;
            await recordMarginal(
              buildMarginalRow({
                articleId: article.id,
                clusterId: primary.clusterId,
                band,
                ensembleScore: primary.score,
                probability,
                decision: "rejected",
                stateHash: hash,
                preview,
                latencyMs,
                inputTokens: response.usage.inputTokens,
              }),
            );
          } else {
            await recordMarginal(
              buildMarginalRow({
                articleId: article.id,
                clusterId: primary.clusterId,
                band,
                ensembleScore: primary.score,
                probability,
                decision: "unchanged",
                stateHash: hash,
                preview,
                latencyMs,
                inputTokens: response.usage.inputTokens,
              }),
            );
          }
        }
      } catch (err) {
        // Timeout/abort vs. any other gateway failure -- see JevLiveState.
        // Log only { name }: never the key, the request body, or a gateway
        // response body (inherited discipline from jev-shadow/index.ts).
        const name = err instanceof Error ? err.name : "unknown";
        if (name === "TimeoutError" || name === "AbortError") {
          jevLive.timeouts += 1;
        } else {
          jevLive.errors += 1;
        }
        console.warn(`[cluster-consumer] jev live verification failed for ${article.id}`, { name });
      }
    }
  }

  // Executed OUTSIDE the try/catch above on purpose (A1 fix): addArticleToCluster
  // throws on every DB failure, and that throw must propagate exactly as it
  // does for the non-Jev join path below (contract §G) -- never swallowed
  // into jevLive.errors, never mis-counted as a gateway failure.
  if (pendingJoin && primary) {
    const r = await addArticleToCluster(sourceLookup, primary.clusterId, article);
    if (!r.skipped) {
      addMemberToIndices(primary.clusterId, article);
      jevLive.joined_by_jev += 1;
      await recordMarginal(
        buildMarginalRow({
          articleId: article.id,
          clusterId: primary.clusterId,
          band: band as "low" | "high",
          ensembleScore: primary.score,
          probability: pendingJoin.probability,
          decision: "joined",
          stateHash: pendingJoin.hash,
          preview: pendingJoin.preview,
          latencyMs: pendingJoin.latencyMs,
          inputTokens: pendingJoin.inputTokens,
        }),
      );
      return { result: "matched", clusterId: primary.clusterId };
    }
    // Duplicate-source skip -- record "unchanged" and continue into
    // the existing flow below (which will re-attempt, and re-skip,
    // the same cluster on its own).
    if (r.reason === "duplicate-source") {
      noteDupBlock(
        primary.clusterId,
        primary.score,
        sameSourceDupEvidence(ctx, primary.clusterId, article, articleHeadline, probeSet.has(primary.clusterId)),
      );
    }
    await recordMarginal(
      buildMarginalRow({
        articleId: article.id,
        clusterId: primary.clusterId,
        band: band as "low" | "high",
        ensembleScore: primary.score,
        probability: pendingJoin.probability,
        decision: "unchanged",
        stateHash: pendingJoin.hash,
        preview: pendingJoin.preview,
        latencyMs: pendingJoin.latencyMs,
        inputTokens: pendingJoin.inputTokens,
      }),
    );
  }

  const blocked = new Set<string>();
  if (marginalRejectedClusterId) {
    // Block the primary candidate BEFORE the fallback loop below -- the
    // loop's own `primary.score >= MATCH_THRESHOLD` entry condition and
    // per-candidate logic are otherwise untouched, so the next candidate
    // (or createCluster) wins exactly as it already does for any other
    // blocked cluster.
    blocked.add(marginalRejectedClusterId);
  }
  if (primary && primary.score >= MATCH_THRESHOLD) {
    for (const cand of ranked) {
      if (blocked.has(cand.clusterId)) continue;
      // A Jev reject withdraws the "primary is a match" premise, so the
      // fallback may only reach a candidate the ensemble would have joined
      // on its own (score >= MATCH_THRESHOLD); otherwise createCluster.
      // Without this, a band-high reject (primary in [0.40, 0.44)) could
      // fall through into a genuinely sub-threshold join in [FALLBACK_FLOOR,
      // MATCH_THRESHOLD) -- a join the ensemble alone would never make.
      const fallbackBar = marginalRejectedClusterId ? MATCH_THRESHOLD : FALLBACK_FLOOR;
      if (cand.score < fallbackBar) break;
      // The text floor caps the entity/tfidf lane at MATCH_THRESHOLD - 0.01,
      // inside [FALLBACK_FLOOR, MATCH_THRESHOLD). A candidate whose only
      // results in that window rest on the capped lane is a pair joined by
      // entities alone; it may still be reviewed by Jev's low band above, but
      // must not join here when the primary was skipped as a duplicate-source.
      if (cand.fallbackScore < fallbackBar) continue;
      if (dryRun) {
        if (wouldDuplicate(ctx, cand.clusterId, article)) {
          blocked.add(cand.clusterId);
          noteDupBlock(
            cand.clusterId,
            cand.score,
            sameSourceDupEvidence(ctx, cand.clusterId, article, articleHeadline, probeSet.has(cand.clusterId)),
          );
          continue;
        }
        return {
          result: "would_match",
          clusterId: cand.clusterId,
          score: cand.score,
          sourcesBefore: [...(ctx.sourceIdsByCluster.get(cand.clusterId) ?? [])],
        };
      }
      const result = await addArticleToCluster(sourceLookup, cand.clusterId, article);
      if (result.skipped) {
        blocked.add(cand.clusterId);
        if (result.reason === "duplicate-source") {
          noteDupBlock(
            cand.clusterId,
            cand.score,
            sameSourceDupEvidence(ctx, cand.clusterId, article, articleHeadline, probeSet.has(cand.clusterId)),
          );
        }
        continue;
      }
      addMemberToIndices(cand.clusterId, article);
      return { result: "matched", clusterId: cand.clusterId };
    }
  }

  // Nothing took the article, but a cluster that matched it at MATCH_THRESHOLD
  // or better already holds its source AND the article is tied to that
  // source's own member by strong evidence (noteDupBlock above): the article
  // is that source's own duplicate of the story. A new cluster would be a
  // permanent twin of that one (Antalya-Alanya otoyolu: 8ab93bbd [18] and
  // 2c9941bd [7]), so skip the article; the queue message is still archived and
  // counted in `skipped`, and a live skip is also written to cluster_skip_log.
  // A source-blocked match without that evidence (a templated MinHash false
  // match, h14-cluster-1) never sets dupBlock and still opens a cluster, as
  // does the weak-match case (best score below MATCH_THRESHOLD).
  if (dupBlock.clusterId !== null && dupBlock.evidence !== null) {
    console.log(
      `[cluster-consumer] same-source-duplicate skip article=${article.id} cluster=${dupBlock.clusterId} matchScore=${dupBlock.score.toFixed(3)} evidence=${dupBlock.evidence}${dryRun ? " dry-run" : ""}`,
    );
    if (!dryRun) await recordSkip(article.id, { clusterId: dupBlock.clusterId, score: dupBlock.score, evidence: dupBlock.evidence });
    return { result: "skipped", reason: "same-source-duplicate", score: primary?.score };
  }

  // No viable match. In a dry run, report what would happen without ever
  // calling createCluster/registerNewClusterInCache/addMemberToIndices.
  if (dryRun) {
    return { result: "would_create", score: primary?.score, sourcesBefore: [] };
  }

  // → spawn a new cluster. registerNewClusterInCache makes sure subsequent
  // dequeues in this same invocation see it.
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
  return { result: "created", clusterId: newId };
}

// ---------------------------------------------------------------------------
// Top-level invocation handler
// ---------------------------------------------------------------------------

interface AdmissionSummary {
  mode: AdmissionMode;
  claim: "skipped" | "ok" | "error";
  claimed: number;
  live_claimed: number;
  would_match: number;
  would_create: number;
  matched: number;
  created: number;
  rejected: number;
  disabled: number;
  not_found: number;
  record_errors: number;
}

function newAdmissionSummary(mode: AdmissionMode): AdmissionSummary {
  return {
    mode,
    claim: "skipped",
    claimed: 0,
    live_claimed: 0,
    would_match: 0,
    would_create: 0,
    matched: 0,
    created: 0,
    rejected: 0,
    disabled: 0,
    not_found: 0,
    record_errors: 0,
  };
}

interface InvocationSummary {
  drained: number;
  matched: number;
  created: number;
  skipped: number;
  notFound: number;
  notPolitics: number;
  failedTransient: number;
  failedPermanent: number;
  // h16-precision-2 (log-only): title/description name swaps seen this drain,
  // plus up to 3 sample article ids.
  descriptionSwapSuspects: number;
  descriptionSwapSamples: string[];
  duration_ms: number;
  budgeted_out: boolean;
  jev_live: JevLiveState;
  admission: AdmissionSummary;
}

// /api/revalidate rejects payloads over MAX_TAGS; reserve room for the two
// feed tags so a large drain never overflows the cap into a 400.
const MAX_REVALIDATION_TAGS = 100;
// reader-queries E4: these two tags mark the ENTIRE home feed, /blindspots,
// every topic page and RSS stale — cluster-consumer used to send them on
// EVERY drain that changed clusters, and pg_cron's 'cluster-drain' job
// (038_cron_schedules.sql) runs every minute, so the 300s cluster-feed
// cache window (E1) never actually held: revalidateTag(tag, 'max') at
// api/revalidate/route.ts:92 re-marked those surfaces stale about once a
// minute regardless of the window. Feed tags are now opt-in
// (REVALIDATE_FEED_TAGS=1) — detail tags (cluster-detail:<id>) still flip
// on every drain, since a single cluster's own page should update
// immediately when ITS content changes.
const FEED_REVALIDATION_TAGS = ["clusters-politics", "clusters"];

export function buildRevalidationTags(
  clusterIds: string[],
  includeFeedTags = false,
): string[] {
  const statics = includeFeedTags ? FEED_REVALIDATION_TAGS : [];
  return [
    ...statics,
    ...clusterIds
      .slice(0, MAX_REVALIDATION_TAGS - statics.length)
      .map((id) => `cluster-detail:${id}`),
  ];
}

// Fire-and-forget Next.js cache revalidation for the clusters this drain
// touched. Best-effort: any failure (missing env, network, non-2xx) is
// logged and swallowed — a stale cache page is far cheaper than a failed
// drain that leaves the queue backed up.
async function triggerRevalidation(clusterIds: string[]): Promise<void> {
  const revalidateUrl = Deno.env.get("REVALIDATE_URL");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!revalidateUrl || !cronSecret) {
    console.warn(
      "[cluster-consumer] REVALIDATE_URL/CRON_SECRET unset; skipping revalidation",
    );
    return;
  }

  // Opt-in escape hatch: set REVALIDATE_FEED_TAGS=1 to restore the old
  // per-drain feed invalidation (e.g. while diagnosing a staleness report)
  // — the cluster-feed window (300s, E1) is the default freshness contract
  // otherwise.
  const includeFeedTags = Deno.env.get("REVALIDATE_FEED_TAGS") === "1";
  const tags = buildRevalidationTags(clusterIds, includeFeedTags);
  try {
    const res = await fetch(revalidateUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cronSecret}`,
      },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      console.warn(
        `[cluster-consumer] revalidation POST returned ${res.status}`,
      );
    }
  } catch (err) {
    console.warn(
      `[cluster-consumer] revalidation POST failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// Records the routing outcome of an admit-tagged claim (migration 089).
// Only ever called for messages that carried an `admit` tag -- a plain
// (non-admitted) message never reaches this function. Wrapped by the
// caller in try/catch: a record error must still archive the message and
// count admission.record_errors, never failedTransient, and must log only
// the error code, never the message or article contents.
/** p_outcome values, per the migration's CHECK constraint. */
type AdmissionOutcome =
  | "matched"
  | "created"
  | "would_match"
  | "would_create"
  | "disabled"
  | "rejected"
  | "not_found";

async function recordAdmission(
  articleId: string,
  outcomeName: AdmissionOutcome,
  outcome: ProcessOutcome,
  extra: { sourceLookup: Map<string, SourceRow>; articleSourceId: string | null },
): Promise<void> {
  const sourceLookup = extra.sourceLookup;
  const before = (outcome.sourcesBefore ?? []).map((id) => sourceLookup.get(id) ?? null);
  const added = extra.articleSourceId ? sourceLookup.get(extra.articleSourceId) ?? null : null;
  const effect = admissionEffect(before, added);

  const dryRun = outcomeName === "would_match" || outcomeName === "would_create";
  let clusterSeededByAdmission = false;
  if (!dryRun && outcomeName === "matched" && outcome.clusterId) {
    const seedRes = await supabase
      .from("jev_politics_admissions")
      .select("article_id")
      .eq("cluster_id", outcome.clusterId)
      .eq("outcome", "created")
      .is("rolled_back_at", null)
      .limit(1);
    clusterSeededByAdmission = Boolean(seedRes.data && seedRes.data.length > 0);
  }

  const res = await supabase.rpc("jev_politics_admission_record", {
    p_article_id: articleId,
    p_outcome: outcomeName,
    p_cluster_id: outcome.clusterId ?? null,
    p_score: outcome.score ?? null,
    p_sources_before: outcome.sourcesBefore?.length ?? null,
    p_blindspot_before: effect.blindspotBefore,
    p_blindspot_after: effect.blindspotAfter,
    p_zone_added: effect.zoneAdded,
    p_cluster_seeded_by_admission: clusterSeededByAdmission,
  });
  if (res.error) {
    throw new Error(res.error.code ?? "record-failed");
  }
}

async function drainQueue(): Promise<InvocationSummary> {
  // FIRST statement: reset the live-verification counters for this
  // invocation. Read the env here (not at module load) so the Deno-env
  // polyfill in tests/functions/cluster-consumer.test.ts keeps working.
  jevLive = newJevLiveState(
    liveEnabled(
      Deno.env.get("JEV_LIVE_PAIRS") ?? undefined,
      Deno.env.get("AI_GATEWAY_API_KEY") ?? undefined,
    ),
  );
  jevLiveAttempts = 0;
  descriptionSwapSuspects = 0;
  descriptionSwapSamples = [];

  // Migration 089 ("ADMIT"): read the flag inside drainQueue (not at module
  // load) so the Deno-env polyfill test harness keeps working, same
  // discipline as jevLive above.
  const admissionModeValue = admissionMode(Deno.env.get(JEV_ADMISSION_POLICY.envFlag) ?? undefined);

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
    descriptionSwapSuspects: 0,
    descriptionSwapSamples: [],
    duration_ms: 0,
    budgeted_out: false,
    jev_live: jevLive,
    admission: newAdmissionSummary(admissionModeValue),
  };

  // Best-effort depth sample for the drain summary log (audit O13).
  const before = await queueDepth(supabase, QUEUE_NAME);

  // Clusters touched (matched or created) this invocation — fed to the
  // once-per-drain revalidation POST below so Next.js drops its stale
  // cluster-detail / clusters-politics caches without waiting on TTL.
  const touchedClusterIds = new Set<string>();

  // Force-warm cluster context once at the top of the invocation so the
  // per-message path is read-only against the cache (cheap).
  await getClusterContext();
  await getSourceLookup();

  // One admission claim per drain, after the context warm-up and before the
  // first readBatch. A claim error is non-fatal -- logged with only the
  // error code, never the message -- and leaves summary.admission.claim as
  // "error" so the drain proceeds exactly as if the flag were off.
  if (admissionModeValue !== "off") {
    try {
      const claimRes = await supabase.rpc(
        "jev_politics_admission_claim",
        claimArgs(admissionModeValue),
      );
      if (claimRes.error) {
        summary.admission.claim = "error";
        console.warn("[cluster-consumer] admission claim failed", { code: claimRes.error.code });
      } else {
        summary.admission.claim = "ok";
        const row = Array.isArray(claimRes.data) ? claimRes.data[0] : claimRes.data;
        summary.admission.claimed = Number(row?.claimed ?? 0);
        summary.admission.live_claimed = Number(row?.live ?? 0);
      }
    } catch (err) {
      summary.admission.claim = "error";
      const code = (err as { code?: string } | null)?.code ?? "unknown";
      console.warn("[cluster-consumer] admission claim failed", { code });
    }
  }

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

      const admitTag = parseAdmitTag(msg.message?.admit);

      try {
        const outcome = await processArticle(articleId, admitTag, admissionModeValue);
        await archive(supabase, QUEUE_NAME, msg.msg_id);
        summary.drained += 1;
        switch (outcome.result) {
          case "matched":
            summary.matched += 1;
            if (outcome.clusterId) touchedClusterIds.add(outcome.clusterId);
            break;
          case "created":
            summary.created += 1;
            if (outcome.clusterId) touchedClusterIds.add(outcome.clusterId);
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
          // Dry-run and disabled/rejected outcomes never touch matched/
          // created, touchedClusterIds or revalidation -- see the
          // admission.* counters below.
          case "would_match":
            summary.admission.would_match += 1;
            break;
          case "would_create":
            summary.admission.would_create += 1;
            break;
          case "disabled":
            summary.admission.disabled += 1;
            break;
          case "rejected":
            summary.admission.rejected += 1;
            break;
        }
        if (outcome.result === "matched" && admitTag !== null) summary.admission.matched += 1;
        if (outcome.result === "created" && admitTag !== null) summary.admission.created += 1;
        if (outcome.result === "not-found" && admitTag !== null) summary.admission.not_found += 1;

        if (admitTag !== null) {
          const admissionOutcome: AdmissionOutcome | null =
            outcome.result === "not-found"
              ? "not_found"
              : outcome.result === "matched" ||
                  outcome.result === "created" ||
                  outcome.result === "would_match" ||
                  outcome.result === "would_create" ||
                  outcome.result === "disabled" ||
                  outcome.result === "rejected"
                ? outcome.result
                : null;
          if (admissionOutcome) {
            try {
              await recordAdmission(articleId, admissionOutcome, outcome, {
                sourceLookup: await getSourceLookup(),
                articleSourceId: outcome.articleSourceId ?? null,
              });
            } catch (recErr) {
              summary.admission.record_errors += 1;
              const code = (recErr as Error | undefined)?.message ?? "unknown";
              console.warn("[cluster-consumer] admission record failed", { code });
            }
          }
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

  if (summary.matched + summary.created > 0) {
    await triggerRevalidation([...touchedClusterIds]);
  }

  // jevLive may have been re-assigned counters throughout the drain; take
  // the final snapshot right before duration_ms so both the log line and
  // the HTTP body reflect the same invocation.
  // Copy, not a reference -- a later concurrent drain reassigns the module
  // binding `jevLive`, and if this summary object held that reference, the
  // HTTP body/log line built here would silently pick up the later drain's
  // numbers instead of this invocation's own.
  summary.jev_live = { ...jevLive };
  // Copies, for the same reason: the module bindings are reassigned by the
  // next drain.
  summary.descriptionSwapSuspects = descriptionSwapSuspects;
  summary.descriptionSwapSamples = [...descriptionSwapSamples];
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
  // A concurrent POST is answered `{ ok: true, busy: true }` rather than
  // draining -- drainQueue() resets the module-scoped live-verification
  // counters as its first statements, so two overlapping drains in the same
  // warm isolate would corrupt each other's budget/counters (see
  // `drainInFlight` above). pgmq's own visibility timeout already guards
  // message-level double-processing; this guard is only about that budget.
  if (drainInFlight) {
    return new Response(JSON.stringify({ ok: true, busy: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  drainInFlight = true;
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
  } finally {
    drainInFlight = false;
  }
}));
