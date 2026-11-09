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
//      (h101-e2elatency-1, migration 188) in the minutes where ingest-drain runs
//      (UTC minute % 3 === 0) the FIRST read was meant to be a long poll (see
//      planClusterWorkPoll); h102-pollregression-1 switched that OFF (POLL_ENABLED
//      is false, see its comment): the plain read below is the only read
//   5. (hunt-25 W3, migration 151) once cluster_work ran dry, read at most
//      ATTACH_MAX_PER_DRAIN messages of the separate `cluster_attach` queue and
//      run the deterministic, attach-only probe on them (see processAttach)
//
// In-memory caches (cluster context, source lookup) survive between dequeues
// within the same Edge Function instance, so warm invocations skip the
// expensive 48h scan.

import {
  archive,
  deleteMessage,
  isPollRpcMissing,
  type PgmqMessage,
  queueDepth,
  readBatch,
  readBatchPoll,
} from "../_shared/pgmq.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";

// Initialise Sentry at module load. No-op if SENTRY_DSN is unset.
await initSentry("cluster-consumer");
import { createServiceClient, type SupabaseClient } from "../_shared/supabase.ts";
import {
  deserializeSignature,
  fingerprint,
  foldTurkishWord,
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
import { TfidfIndex, type TfidfQuery } from "../_shared/cluster/tfidf.ts";
import { centroidCosine, centroidGuard, centroidGuardEnabled } from "../_shared/cluster/centroid.ts";
import {
  actorMismatchFires,
  headlineLane,
  headlineOnlyScore,
  incidentVetoFires,
  score,
  subjectVetoFires,
} from "../_shared/cluster/ensemble.ts";
import {
  CENTROID_GUARD_ENV,
  CENTROID_MAX_MEMBERS,
  CONTEXT_STICKY_HOURS,
  CONTEXT_STICKY_MAX,
  CONTEXT_STICKY_MIN_ARTICLES,
  GENERIC_ENTITIES,
  HEADLINE_GENERIC_PREFIXES,
  HEADLINE_LANE_MAX_HOURS,
  HEADLINE_MEMBER_SCAN_MAX,
  HEADLINE_TITLE_MAX_CHARS,
  MATCH_THRESHOLD,
  MAX_CANDIDATE_CLUSTERS,
  MIN_SHARED_ENTITIES,
  SAME_SOURCE_UPDATE_ENFORCE,
  SAME_SOURCE_UPDATE_MAX_HOURS,
  SAME_SOURCE_UPDATE_MIN_SHARED,
  SUBJECT_STOP_WORDS,
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
  ATTACH_MODE_ENV,
  attachMode,
  claimArgs,
  isPoliticsMember,
  JEV_ADMISSION_POLICY,
  parseAdmitTag,
  routeMessage,
  type AdmissionMode,
  type AttachMode,
} from "../_shared/cluster/politics-admission.ts";
import {
  ATTACH_MAX_PER_DRAIN,
  attachDecision,
  planAttachRead,
  type AttachArticle,
  type AttachCandidate,
  type AttachDecision,
  type AttachMember,
} from "../_shared/cluster/attach.ts";
import { admissionEffect } from "../_shared/cluster/admission-effect.ts";
import { isRoundupTitle, ROUNDUP_SKIP_REASON } from "../_shared/cluster/roundup-title.ts";

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

const QUEUE_NAME = "cluster_work";
// The attach-only probe's queue (hunt-25 W3, migration 151). Separate from
// cluster_work: ~174 messages an hour against cluster_work's ~78, so on one FIFO
// queue they would delay politika work and trip 150's lag checks.
const ATTACH_QUEUE_NAME = "cluster_attach";
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
// Long poll of the first cluster_work read (h101-e2elatency-1, migration 188).
// cluster-drain runs every minute and ingest-drain every third minute
// ('*/3 * * * *'); ingest inserts its articles at about :04-:12 of its minute,
// after the consumer of that minute has read once at about :02 and left, so 73 %
// of the messages waited 40-65 s for the NEXT minute's consumer. In ingest's
// minutes the first read waits for the insert instead. Other minutes keep the
// plain read and spend no idle wall time.
//
// SWITCHED OFF on 2026-11-09 (h102-pollregression-1, PR #252 regression). Measured on
// production after cluster-consumer v51 (deployed 09:50:34Z): ingest_cycles.started_at,
// seconds of the minute, were :00-:09 in every ingest minute before (09:33:00, 09:36:00,
// 09:39:00, 09:42:02, 09:45:02, 09:48:00) and :13-:19 after it, or :00-:01 in the minutes
// ingest won the race (09:51:14, 09:54:00, 09:57:13, 10:00:19, 10:03:14, 10:06:01,
// 10:09:14). pg_net 0.20.0 sends the queued requests in batches, so the cluster-drain
// request, held open about 13 s by two 6 s polls, keeps the ingest-drain request queued
// behind it. When ingest wins the race the poll finds its messages in 1.3 s, which the
// old consumer achieved in the same race anyway (it then waited behind ingest: 1.3-2.2 s
// at 09:09, 09:12, 09:21, 09:24, 09:36, 09:39); when cluster-drain wins, its polls find
// nothing because ingest cannot start before they end, so the messages still wait for the
// next minute (enqueued at :17-:22, read at :00-:02).
// Net: attach time unchanged, ingest started up to 19 s later, one PostgREST connection held
// about 13 s in every ingest minute. The `wait` metric's fall (54.8 -> 44.6 s p50) was only
// the enqueue moving later. Polling must stay OFF until the consumer no longer holds the
// pg_net request open while it waits (respond first and poll inside EdgeRuntime.waitUntil,
// or a separate trigger): a design change for a later hunt, not a flag flip. While it is
// false the drain is call for call the pre-#252 drain (one plain readBatch per loop turn)
// and `summary.polls` stays 0; planClusterWorkPoll, readBatchPoll and isPollRpcMissing stay
// exported and unit-tested, and migration 188's RPC stays (service_role only, unused).
// tests/functions/cluster-consumer.test.ts asserts this value.
const POLL_ENABLED = false;
const POLL_MINUTE_MODULUS = 3;              // ingest-drain's minutes: 0, 3, 6, ... of every hour (UTC)
const POLL_SECONDS = 6;                     // one call: PostgREST's authenticator cancels a statement after 8 s (the RPC clamps to 6 as well)
const POLL_INTERVAL_MS = 250;               // how often the database re-reads while it waits
const POLL_MAX_CALLS = 2;                   // per invocation
const POLL_SECOND_CALL_BEFORE_MS = 14_000;  // a second poll starts only while less than this has passed since the start
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

// Stem-overlap probe (h19-recall-2, migration 146). The exact-title probe above
// keys on the folded title INCLUDING its punctuation, so 'X' and 'X!' (or a
// quoted title) never meet: 27% of the measured splits had their older cluster
// outside the 200-cluster context. When no candidate reached FALLBACK_FLOOR, the
// consumer sends the headline stems ([...headlineTokens(title).tokens]) to
// public.cluster_stem_probe, which returns up to TITLE_PROBE_LIMIT live clusters
// of the last TITLE_PROBE_WINDOW_HOURS whose folded seed title shares at least
// least(4, n) of them. The hits are loaded and scored like any candidate; the
// MATCH_THRESHOLD bar is unchanged, so the probe only widens the funnel.

// Twin-bridge evidence (h19-recall-3, migration 147). When two or more candidates
// of one article score at least TWIN_BRIDGE_MIN_SCORE, the pairs are written to
// cluster_twin_bridges as shadow evidence for a later merge decision (no merge
// happens here). Keep TWIN_BRIDGE_MIN_SCORE equal to TWIN_MERGE_MIN_BRIDGE_SCORE
// in _shared/cluster/twin-merge.ts: that file's decision reads these rows, and a
// higher bar here would silently starve it. (Not imported: the two live in
// different modules on purpose, and a test pins their equality.)
const TWIN_BRIDGE_MIN_SCORE = 0.55;
// Pairs are built from the best TWIN_BRIDGE_MAX_CANDIDATES candidates only: at
// most 3 rows per article.
const TWIN_BRIDGE_MAX_CANDIDATES = 3;

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
  // The member's stored strict fingerprint (null when it never had one): the
  // attach probe's second kind of evidence.
  fingerprint: string | null;
  // The raw description, kept by reference only like `title`. The centroid guard
  // (h70-mergequality-2) builds the member's tf-idf text from the two
  // (memberTfidfText) when -- and only when -- a candidate reaches the guard, so
  // nothing is cleaned or tokenised at context build.
  description: string | null;
}

interface ClusterContext {
  fetchedAt: number;
  clusters: ClusterRow[];
  seedByCluster: Map<string, ClusterMemberArticle>;
  latestByCluster: Map<string, ClusterMemberArticle>;
  sourceIdsByCluster: Map<string, Set<string>>;
  // Hunt-25 W3 (attach probe). Share of each loaded cluster's members -- ALL of
  // them, from cluster_articles -- that count as politics (isPoliticsMember), the
  // same ratio src/lib/clusters/politics-query.ts gates on. Computed from rows
  // loadClusterContext already fetched; no extra query.
  politicsShareByCluster: Map<string, number>;
  // Every source with a member in the cluster, politics or not. sourceIdsByCluster
  // only knows the politics members, but a non-politics member's source must block
  // an attach too.
  allSourceIdsByCluster: Map<string, Set<string>>;
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
  // h40-clusters-1 (diagnostic only): epoch ms of the oldest updated_at among the
  // non-sticky rows of the newest-CONTEXT_CLUSTER_CAP window this context was
  // built from; null when the window was empty. The drain summary reports it as
  // ctx_window_min: a value of an hour or less means a busy story that went quiet
  // for an hour had already fallen out of the window.
  windowOldestUpdatedMs: number | null;
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
// h45-clusters-1 (shadow): articles that carried 'same-source-update' evidence
// while SAME_SOURCE_UPDATE_ENFORCE is off and went on to open a cluster of their
// own, i.e. the twins the skip would have prevented. Reset at the top of every
// drainQueue() next to descriptionSwapSuspects.
let sameSourceUpdateShadow = 0;
// h70-mergequality-2: candidates the centroid guard passed over in live drains (a
// dry run is not counted), plus up to CENTROID_SKIP_SAMPLE_MAX {clusterId, cos}
// samples. Reset at the top of every drainQueue() next to sameSourceUpdateShadow.
let centroidSkipCount = 0;
let centroidSkipSamples: Array<{ clusterId: string; cos: number }> = [];
const CENTROID_SKIP_SAMPLE_MAX = 5;
// h40-clusters-1: at most this many {article_id, top_cluster_id, top_score}
// samples of created_with_floor_candidate in one drain summary.
const CREATED_FLOOR_SAMPLE_MAX = 3;
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

// Epoch ms of the oldest parseable updated_at of `rows`; null when there is none
// (an empty window, or no row with a usable timestamp). Does not rely on the
// order of `rows`.
function oldestUpdatedMs(rows: readonly { updated_at: string }[]): number | null {
  let oldest: number | null = null;
  for (const row of rows) {
    const ms = Date.parse(row.updated_at);
    if (!Number.isFinite(ms)) continue;
    if (oldest === null || ms < oldest) oldest = ms;
  }
  return oldest;
}

// Whole minutes from `oldestMs` to `nowMs`, never negative; null when unknown.
function windowAgeMinutes(oldestMs: number | null | undefined, nowMs: number): number | null {
  if (oldestMs === null || oldestMs === undefined || !Number.isFinite(oldestMs)) return null;
  return Math.max(0, Math.round((nowMs - oldestMs) / 60_000));
}

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

  // The window's age, from the newest-CAP rows only (the sticky tail is older by
  // construction and would hide the very crowding this number is there to show).
  const windowOldestUpdatedMs = oldestUpdatedMs(newestRows);

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
    politicsShareByCluster: new Map(),
    allSourceIdsByCluster: new Map(),
    headlinesByCluster: new Map(),
    indices: { byFingerprint: new Map(), byEntity: new Map(), byBand: new Map(), byToken: new Map() },
    tfidf,
    windowOldestUpdatedMs,
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

  // Attach-probe inputs (hunt-25 W3), from the rows already in hand: the share of
  // ALL members (caRows, via memberIdsByCluster) that are politics members
  // (memberArticles), and every member's source.
  const sourceOfArticle = new Map<string, string | null>(articleRows.map((a) => [a.id, a.source_id ?? null]));
  const politicsShareByCluster = new Map<string, number>();
  const allSourceIdsByCluster = new Map<string, Set<string>>();
  for (const [clusterId, ids] of memberIdsByCluster.entries()) {
    let politics = 0;
    const sources = new Set<string>();
    for (const id of ids) {
      if (memberArticles.has(id)) politics += 1;
      const sid = sourceOfArticle.get(id);
      if (sid) sources.add(sid);
    }
    politicsShareByCluster.set(clusterId, ids.length === 0 ? 0 : politics / ids.length);
    allSourceIdsByCluster.set(clusterId, sources);
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
  // a 100-article story costs HEADLINE_MEMBER_SCAN_MAX tokenisations, not 100.
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
        fingerprint: art.fingerprint ?? null,
        description: art.description ?? null,
      })),
    );
  }

  return {
    fetchedAt: Date.now(),
    clusters,
    seedByCluster,
    latestByCluster,
    sourceIdsByCluster,
    politicsShareByCluster,
    allSourceIdsByCluster,
    headlinesByCluster,
    indices,
    tfidf,
    windowOldestUpdatedMs,
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
    // Only the centroid guard reads it (HeadlineMember.description).
    description?: string | null;
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
    fingerprint: article.fingerprint ?? null,
    description: article.description ?? null,
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
  let all = clusterContextCache.allSourceIdsByCluster.get(clusterId);
  if (!all) {
    all = new Set();
    clusterContextCache.allSourceIdsByCluster.set(clusterId, all);
  }
  all.add(sourceId);
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
  clusterContextCache.allSourceIdsByCluster.set(
    clusterId,
    new Set(seed.source_id ? [seed.source_id] : []),
  );
  // A cluster the clusterer just opened holds one politics member.
  clusterContextCache.politicsShareByCluster.set(clusterId, 1);
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

// Stem-overlap probe (migration 146): best-effort like the title probe, one
// warning per isolate.
let stemProbeWarned = false;

function warnStemProbeOnce(detail: string) {
  if (stemProbeWarned) return;
  stemProbeWarned = true;
  console.warn(
    `[cluster-consumer] cluster_stem_probe failed, continuing without it: ${detail}`,
  );
}

// Twin-bridge evidence (migration 147): best-effort, one warning per isolate.
let twinBridgeWarned = false;

function warnTwinBridgeOnce(detail: string) {
  if (twinBridgeWarned) return;
  twinBridgeWarned = true;
  console.warn(`[cluster-consumer] cluster_twin_bridges upsert failed, continuing: ${detail}`);
}

// The bridge rows of one article: every pair of its best TWIN_BRIDGE_MAX_CANDIDATES
// candidates that score at least TWIN_BRIDGE_MIN_SCORE, as
// {article_id, cluster_a, cluster_b, score}. Ids are lower-cased and ordered by
// plain string comparison (cluster_a < cluster_b, which is also the order of
// Postgres uuids), so the pair has one canonical form; the pair's score is the
// lower of the two. [] with fewer than two such candidates. Pure.
function twinBridgeRows(
  articleId: string,
  ranked: ReadonlyArray<{ clusterId: string; score: number }>,
): Array<{ article_id: string; cluster_a: string; cluster_b: string; score: number }> {
  const best = ranked
    .filter((c) => c.score >= TWIN_BRIDGE_MIN_SCORE)
    .map((c) => ({ id: c.clusterId.toLowerCase(), score: c.score }))
    .sort((x, y) => y.score - x.score || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const top: Array<{ id: string; score: number }> = [];
  for (const c of best) {
    if (top.length >= TWIN_BRIDGE_MAX_CANDIDATES) break;
    if (top.some((t) => t.id === c.id)) continue;
    top.push(c);
  }
  const rows: Array<{ article_id: string; cluster_a: string; cluster_b: string; score: number }> = [];
  for (let i = 0; i < top.length; i++) {
    for (let j = i + 1; j < top.length; j++) {
      const a = top[i]!;
      const b = top[j]!;
      const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
      rows.push({
        article_id: articleId,
        cluster_a: lo.id,
        cluster_b: hi.id,
        score: Math.min(a.score, b.score),
      });
    }
  }
  return rows;
}

// h19-recall-3: writes the bridge rows of one article. It is AWAITED, not left as
// a floating promise: a write that is still in flight when the isolate returns
// can be dropped, and an un-awaited write would make the mutation log of the
// test fake racy. It is best-effort like recordSkip: a failure (error envelope or
// throw) warns once per isolate and never touches the decision, so the caller
// ignores the result. Insert-or-ignore on the primary key keeps a re-delivered
// message from rewriting the first record.
async function recordTwinBridges(
  articleId: string,
  ranked: ReadonlyArray<{ clusterId: string; score: number }>,
): Promise<void> {
  const rows = twinBridgeRows(articleId, ranked);
  if (rows.length === 0) return;
  try {
    const res = await supabase
      .from("cluster_twin_bridges")
      .upsert(rows, { onConflict: "article_id,cluster_a,cluster_b", ignoreDuplicates: true });
    if (res.error) warnTwinBridgeOnce(res.error.message);
  } catch (err) {
    warnTwinBridgeOnce(err instanceof Error ? err.message : String(err));
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
  // Attach-probe inputs for the probed cluster, from the rows just read.
  ctx.allSourceIdsByCluster.set(
    row.id,
    new Set(articleRows.map((a) => a.source_id).filter((x): x is string => Boolean(x))),
  );
  ctx.politicsShareByCluster.set(
    row.id,
    articleRows.filter((a) => isPoliticsMember(a)).length / articleIds.length,
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

// Ids of the live clusters (updated in the last TITLE_PROBE_WINDOW_HOURS) whose
// folded seed title shares enough headline stems with this article
// (public.cluster_stem_probe, migration 146), loaded into `ctx` so the scorer can
// see them, in the order the database ranked them. [] when the headline is too
// generic, on any failure, or when nothing matches. Rows that are already in
// ctx.clusters are skipped: the first scoring pass had them. Never called in a
// dry run.
async function probeStemClusters(
  ctx: ClusterContext,
  article: EnrichedArticle,
): Promise<string[]> {
  const stems = [...headlineTokens(article.title).tokens];
  if (stems.length < TITLE_PROBE_MIN_TOKENS) return [];

  let rows: ClusterRow[];
  try {
    const res = await supabase.rpc("cluster_stem_probe", {
      p_stems: stems,
      p_since: new Date(Date.now() - TITLE_PROBE_WINDOW_HOURS * 3_600_000).toISOString(),
      p_limit: TITLE_PROBE_LIMIT,
    });
    if (res.error) {
      warnStemProbeOnce(res.error.message);
      return [];
    }
    rows = Array.isArray(res.data) ? (res.data as ClusterRow[]) : [];
  } catch (err) {
    warnStemProbeOnce(err instanceof Error ? err.message : String(err));
    return [];
  }

  const ids: string[] = [];
  for (const row of rows.slice(0, TITLE_PROBE_LIMIT)) {
    if (!row || typeof row.id !== "string") continue;
    if (ctx.clusters.some((c) => c.id === row.id)) continue;
    try {
      if (await loadProbeCluster(ctx, row)) ids.push(row.id);
    } catch (err) {
      console.warn(
        `[cluster-consumer] stem probe: cluster ${row.id} not loaded, skipping it: ${
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
//   same-source-update  (h45-clusters-1) a follow-up in other words: a member of
//                 the same source within SAME_SOURCE_UPDATE_MAX_HOURS, shared
//                 headline stems and a shared named subject (isSameSourceUpdate).
//                 The weakest kind: any of the three above replaces it
//                 (noteDupBlock), and with SAME_SOURCE_UPDATE_ENFORCE off it
//                 is only logged and counted, never a skip.
type DupEvidence = "fingerprint" | "exact-title" | "headline-lane" | "same-source-update";

// One side of the same-source-update test: a title and its publication time in
// ms. `tokens` are the title's headlineTokens when the caller already holds them.
export interface UpdateSide {
  title: string;
  ms: number;
  tokens?: HeadlineTokens;
}

// Words that name nobody: the subject veto's role / wire stop words, the generic
// entities (bakan, abd, turkiye, erdogan, fidan, istanbul, ...) and, by prefix,
// the headline lane's boilerplate (cumhurbaskan..., erdogan..., bakan..., turkiye...).
const UPDATE_GENERIC_WORDS: ReadonlySet<string> = new Set([...SUBJECT_STOP_WORDS, ...GENERIC_ENTITIES]);

// The folded named-subject tokens of a title: every capitalised word (up to its
// first apostrophe, leading quotes and brackets ignored) that is not generic,
// read the way the subject veto reads its subject span but over the whole
// (clipped) title. A headline written entirely in capitals names nothing: every
// word of it is capitalised.
function namedSubjectTokens(title: string): Set<string> {
  const out = new Set<string>();
  const clipped = title.slice(0, HEADLINE_TITLE_MAX_CHARS);
  if (clipped === clipped.toLocaleUpperCase("tr")) return out;
  for (const word of clipped.split(/\s+/)) {
    // \u0027 and \u2019: the straight and the typographic apostrophe.
    const stem = word.replace(/^[^\p{L}\p{N}]+/u, "").split(/[\u0027\u2019]/)[0] ?? "";
    const first = [...stem][0] ?? "";
    if (!/\p{L}/u.test(first) || first === first.toLocaleLowerCase("tr")) continue;
    for (const piece of foldTurkishWord(stem).split(/[^a-z0-9]+/)) {
      if (piece === "" || UPDATE_GENERIC_WORDS.has(piece)) continue;
      if (HEADLINE_GENERIC_PREFIXES.some((p) => piece.startsWith(p))) continue;
      out.add(piece);
    }
  }
  return out;
}

// h45-clusters-1. Pure and in-memory: true when two articles of ONE source read
// as the same story told twice. ALL of: the two publication times are finite and
// at most SAME_SOURCE_UPDATE_MAX_HOURS apart; the titles share at least
// SAME_SOURCE_UPDATE_MIN_SHARED headline stems that are not numerals (headlineTokens
// already drops the generic prefixes); at least one named subject (a capitalised,
// non-generic word) occurs in both original titles; and neither the subject veto
// (different leading actor, same template) nor the incident veto (different
// provinces) fires. A shared numeral is not a stem: "69 kisi" alone proves
// nothing, and a changing death toll is still the same story.
export function isSameSourceUpdate(a: UpdateSide, b: UpdateSide): boolean {
  if (typeof a.title !== "string" || typeof b.title !== "string") return false;
  if (a.title === "" || b.title === "") return false;
  if (!Number.isFinite(a.ms) || !Number.isFinite(b.ms)) return false;
  if (Math.abs(a.ms - b.ms) > SAME_SOURCE_UPDATE_MAX_HOURS * 3_600_000) return false;

  const ta = a.tokens ?? headlineTokens(a.title);
  const tb = b.tokens ?? headlineTokens(b.title);
  let shared = 0;
  for (const t of ta.tokens) {
    if (!ta.numbers.has(t) && tb.tokens.has(t)) shared += 1;
  }
  if (shared < SAME_SOURCE_UPDATE_MIN_SHARED) return false;

  const namedA = namedSubjectTokens(a.title);
  if (namedA.size === 0) return false;
  let sharedName = false;
  for (const w of namedSubjectTokens(b.title)) {
    if (namedA.has(w)) {
      sharedName = true;
      break;
    }
  }
  if (!sharedName) return false;
  return !subjectVetoFires(a.title, b.title) && !incidentVetoFires(a.title, b.title);
}

interface SameSourceMember {
  id: string;
  ms: number;
  title: string;
  tokens: HeadlineTokens;
}

// The members of `clusterId` that share the article's source: the cluster's
// recent member headlines (ctx.headlinesByCluster, the newest HEADLINE_MEMBER_SCAN_MAX)
// plus its seed and latest rows, which may fall outside that list and are the
// rows the scorer compared against. Pure and in-memory.
function sameSourceMembers(
  ctx: ClusterContext,
  clusterId: string,
  article: Pick<EnrichedArticle, "id" | "source_id">,
): SameSourceMember[] {
  const members: SameSourceMember[] = [];
  const listed = new Set<string>();
  for (const m of ctx.headlinesByCluster.get(clusterId) ?? []) {
    if (m.sourceId !== article.source_id || m.id === article.id) continue;
    listed.add(m.id);
    members.push({ id: m.id, ms: m.publishedMs, title: m.title, tokens: m.tokens });
  }
  for (const m of [ctx.seedByCluster.get(clusterId), ctx.latestByCluster.get(clusterId)]) {
    if (!m || m.source_id !== article.source_id || m.id === article.id || listed.has(m.id)) continue;
    listed.add(m.id);
    members.push({ id: m.id, ms: Date.parse(m.published_at), title: m.title, tokens: headlineTokens(m.title) });
  }
  return members;
}

// The first same-source member (newest first) that isSameSourceUpdate ties to
// the article, or null.
function sameSourceUpdateMember(
  members: readonly SameSourceMember[],
  article: Pick<EnrichedArticle, "title" | "published_at">,
  articleHeadline: HeadlineTokens,
): SameSourceMember | null {
  const articleMs = Date.parse(article.published_at);
  for (const m of members) {
    if (
      isSameSourceUpdate(
        { title: article.title, ms: articleMs, tokens: articleHeadline },
        { title: m.title, ms: m.ms, tokens: m.tokens },
      )
    ) {
      return m;
    }
  }
  return null;
}

// Pure and in-memory (no DB read, dry-run safe). Reads the same-source members
// of the cluster (sameSourceMembers) and returns the strongest evidence found, or
// null when nothing ties the article to one of them. Priority: exact-title, then
// the headline lane, then (h45-clusters-1) same-source-update. Exact-title wins
// over the lane when different members of the source give both. A lane match
// across actors ("Cumhurbaskani Erdogan, ..." against "AK Parti Sozcusu Celik ...")
// is not identity evidence: the lane is withdrawn everywhere else it counts
// (score(), the member scan, the attach probe), so it is here too
// (h70-mergequality-3, actorMismatchFires()).
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

  const members = sameSourceMembers(ctx, clusterId, article);
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
      headlineLane(articleHeadline, m.tokens, Math.abs(articleMs - m.ms) / 3_600_000).fired &&
      !actorMismatchFires(article.title, m.title)
    ) {
      evidence = "headline-lane";
    }
  }
  if (evidence === null && sameSourceUpdateMember(members, article, articleHeadline) !== null) {
    return "same-source-update";
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

// True when the full scorer's headline lane is in effect for the result (h70-mergequality-2:
// a lane the actor veto withdrew reports headlineLane false). Structural, like
// fallbackEligibleScore, so a partial result is read the same way.
function headlineLaneFired(res: { components?: Partial<{ headlineLane: boolean }> }): boolean {
  return res.components?.headlineLane === true;
}

async function addArticleToCluster(
  sourceLookup: Map<string, SourceRow>,
  clusterId: string,
  // Only the id and the source are read; the attach probe links an article it never enriched.
  article: Pick<EnrichedArticle, "id" | "source_id">,
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
  // h40-clusters-1 (diagnostic, "created" only): the context's best candidate when
  // it scored at least FALLBACK_FLOOR and the article still opened a cluster.
  // Ids and a number; never a title or a URL.
  floorCandidate?: { clusterId: string; score: number };
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
      // The attach routes belong to processAttach: processArticle is never given an
      // "attach" tag (drainQueue maps a stray one to null), so these cannot occur
      // here; if they ever do, the message is not politics work.
      case "attach":
      case "in-gate":
        return { result: "not-politics", articleSourceId: raw.source_id };
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

  // Wave BF / W3: a daily roundup ("Resmi Gazete'de bugün: 2 Kasım 2026 Resmi Gazete
  // kararları", "Gündem özeti", ...) lists every item of the day, so its title is
  // similar to whichever single story the day's headlines share and it was attached to
  // unrelated clusters (85700dfa, 8f0bb5b8). It is skipped here: AFTER the enrichment
  // is stored, BEFORE the cluster context and any scoring. No cluster_skip_log row: its
  // cluster_id is NOT NULL and there is no cluster.
  if (isRoundupTitle(raw.title)) {
    console.log(`[cluster-consumer] roundup-title skip article=${raw.id}${dryRun ? " dry-run" : ""}`);
    return { result: "skipped", reason: ROUNDUP_SKIP_REASON };
  }

  const ctx = await getClusterContext();
  const sourceLookup = await getSourceLookup();
  const { seedByCluster, latestByCluster, headlinesByCluster, indices } = ctx;

  // h12-cluster-1, narrowed by h14-cluster-1: remembers the first cluster that
  // matched at MATCH_THRESHOLD or better, was blocked because it already holds
  // this article's source, AND is tied to that source's own member by strong
  // evidence (DupEvidence: equal strict fingerprint, equal folded headline, the
  // headline lane against that member, or -- h45-clusters-1, only with
  // SAME_SOURCE_UPDATE_ENFORCE -- a follow-up in other words). If nothing else takes the article,
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
  // h45-clusters-1 (shadow): the first cluster that blocked the article with
  // 'same-source-update' evidence at MATCH_THRESHOLD or better while
  // SAME_SOURCE_UPDATE_ENFORCE is off. Never a skip: takeSameSourceSkip logs and
  // counts it once, and only when nothing took the article.
  const updateShadow: { clusterId: string | null; score: number; memberId: string | null; reported: boolean } = {
    clusterId: null,
    score: 0,
    memberId: null,
    reported: false,
  };
  const noteDupBlock = (clusterId: string, matchScore: number, evidence: DupEvidence | null) => {
    if (evidence === null) return;
    if (evidence === "same-source-update" && !SAME_SOURCE_UPDATE_ENFORCE) {
      if (matchScore >= MATCH_THRESHOLD && updateShadow.clusterId === null) {
        updateShadow.clusterId = clusterId;
        updateShadow.score = matchScore;
        updateShadow.memberId =
          sameSourceUpdateMember(sameSourceMembers(ctx, clusterId, article), article, headlineTokens(article.title))?.id ?? null;
      }
      return;
    }
    // 'same-source-update' is the weakest kind: a block held with it is replaced by
    // the first block of any other kind, so the existing kinds keep their priority.
    if (
      matchScore >= MATCH_THRESHOLD &&
      (dupBlock.clusterId === null ||
        (dupBlock.evidence === "same-source-update" && evidence !== "same-source-update"))
    ) {
      dupBlock.clusterId = clusterId;
      dupBlock.score = matchScore;
      dupBlock.evidence = evidence;
    }
  };
  // The same-source skip, taken at two places: after the context candidates were
  // tried, and after the stem-probe hits were. Returns the "skipped" outcome (and,
  // live, writes the cluster_skip_log row) when dupBlock holds a cluster with
  // evidence, else null. `outcomeScore` is only reported in the outcome.
  const takeSameSourceSkip = async (outcomeScore: number | undefined): Promise<ProcessOutcome | null> => {
    if (dupBlock.clusterId !== null && dupBlock.evidence !== null) {
      console.log(
        `[cluster-consumer] same-source-duplicate skip article=${article.id} cluster=${dupBlock.clusterId} matchScore=${dupBlock.score.toFixed(3)} evidence=${dupBlock.evidence}${dryRun ? " dry-run" : ""}`,
      );
      if (!dryRun) await recordSkip(article.id, { clusterId: dupBlock.clusterId, score: dupBlock.score, evidence: dupBlock.evidence });
      return { result: "skipped", reason: "same-source-duplicate", score: outcomeScore };
    }
    // h45-clusters-1 shadow: this article is about to open a cluster although the
    // evidence says it is a follow-up of its own source's member. Log it and count
    // it (live drains only), once per article.
    if (updateShadow.clusterId !== null && !updateShadow.reported) {
      updateShadow.reported = true;
      console.log(
        `[cluster-consumer] same-source-update shadow article=${article.id} cluster=${updateShadow.clusterId} member=${updateShadow.memberId ?? "unknown"} score=${updateShadow.score.toFixed(3)}${dryRun ? " dry-run" : ""}`,
      );
      if (!dryRun) sameSourceUpdateShadow += 1;
    }
    return null;
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
  //
  // `headlineHit` (h70-mergequality-2): the headline lane carried some part of the
  // candidate's result -- the full scorer's lane against the seed or the latest, or a
  // member headline of the scan. Such a candidate is exempt from the centroid guard.
  type Scored = { clusterId: string; score: number; fallbackScore: number; headlineHit: boolean };
  const scored: Scored[] = [];

  // Scores one candidate cluster against the incoming article: the full
  // ensemble against the cluster's seed and latest member, then the headline
  // lane against its other recent members. null when the cluster has no seed
  // in the context or the seed is outside TIME_WINDOW_HOURS. The caller decides
  // what to do with a low score (the main loop keeps the ones at FALLBACK_FLOOR
  // or better). `query` is passed in because the stem probe rebuilds it after
  // loading clusters into the corpus.
  const scoreCandidate = (clusterId: string, query: TfidfQuery): Scored | null => {
    const seed = seedByCluster.get(clusterId);
    if (!seed) return null;
    const hoursDeltaSeed = hoursBetween(article.published_at, seed.published_at);
    if (hoursDeltaSeed > TIME_WINDOW_HOURS) return null;

    const seedFp = { strict: seed.fingerprint, signature: seed.signature ?? null };
    const tfidfCosineSeed = ctx.tfidf.cosineQuery(query, seed.id);
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
    let headlineHit = headlineLaneFired(seedRes);
    const latest = latestByCluster.get(clusterId);
    if (latest) {
      const hoursDeltaLatest = hoursBetween(article.published_at, latest.published_at);
      if (hoursDeltaLatest <= TIME_WINDOW_HOURS) {
        const latestFp = { strict: latest.fingerprint, signature: latest.signature ?? null };
        const tfidfCosineLatest = ctx.tfidf.cosineQuery(query, latest.id);
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
        if (headlineLaneFired(latestRes)) headlineHit = true;
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
            // h70-mergequality-3: a headline-lane match must not cross actors.
            aTitle: article.title,
            bTitle: m.title,
          },
        );
        if (memberScore > bestScore) bestScore = memberScore;
        if (memberScore > fallbackScore) fallbackScore = memberScore;
        if (memberScore > 0) headlineHit = true;
      }
    }

    return { clusterId, score: bestScore, fallbackScore, headlineHit };
  };

  for (const clusterId of candidateIds) {
    const s = scoreCandidate(clusterId, tfidfQuery);
    if (s && s.score >= FALLBACK_FLOOR) scored.push(s);
  }
  // Best score first, except that among the candidates which all match
  // (>= MATCH_THRESHOLD) and sit within CANDIDATE_SIZE_TIEBREAK_MARGIN of the
  // best one, the larger cluster goes first: the 18-article original, not its
  // 7-article twin (h12-cluster-1). The size is the row's article_count or the
  // number of member sources loaded for it, whichever is larger.
  // Rebuilt from ctx.clusters on every call of makeSizeOf: clusters the stem
  // probe loads after the first ranking must be sized by their own row, not
  // read as 0 from a map built before they were there.
  const makeSizeOf = (): ((clusterId: string) => number) => {
    const articleCountById = new Map<string, number>();
    for (const c of ctx.clusters) articleCountById.set(c.id, Number(c.article_count) || 0);
    return (clusterId: string): number =>
      Math.max(
        articleCountById.get(clusterId) ?? 0,
        ctx.sourceIdsByCluster.get(clusterId)?.size ?? 0,
      );
  };
  const ranked = rankCandidates(scored, makeSizeOf(), {
    margin: CANDIDATE_SIZE_TIEBREAK_MARGIN,
    threshold: MATCH_THRESHOLD,
  });
  // h19-recall-3: shadow evidence for twin clusters. Written before the decision
  // below is acted on, awaited and best-effort; it never changes the decision.
  if (!dryRun) await recordTwinBridges(article.id, ranked);

  const primary = ranked[0];

  // ---------------------------------------------------------------------
  // Centroid guard (h70-mergequality-2). Seed and latest are the only members the
  // full scorer sees, so an off-topic article that shares a person's name with one
  // of them used to join a big cluster with no check against the cluster as a whole
  // (centroid.ts, constants.ts CENTROID_*). Before joining a candidate of
  // CENTROID_MIN_MEMBERS or more members on non-headline evidence the article's
  // tf-idf vector must reach CENTROID_FLOOR with the centroid of the cluster's
  // seed and its CENTROID_MAX_MEMBERS newest scan members. A candidate the guard
  // passes over is skipped, not blocked: the walk goes on to the next candidate and,
  // with none left, the article opens its own cluster. The vectors are built lazily,
  // only for a candidate that reaches the guard, and the cosine is kept per
  // cluster for this article. CLUSTER_CENTROID_GUARD=off turns it off.
  //
  // The guard sits before the Jev live band below, not only in the join loop: Jev sees
  // just the seed headline and the latest headline, the same blind spot, and its "join"
  // answer is executed on its own path (pendingJoin). A guard-failing primary therefore
  // makes no gateway call and never reaches that join; the verdict is memoised per
  // cluster, so a cluster evaluated here and again by the join loop is logged and
  // counted once per article.
  // ---------------------------------------------------------------------
  const centroidOn = centroidGuardEnabled(Deno.env.get(CENTROID_GUARD_ENV) ?? undefined);
  const centroidCosines = new Map<string, number>();
  const centroidVerdicts = new Map<string, boolean>();
  const memberCountOf = (clusterId: string): number =>
    Math.max(
      Number(ctx.clusters.find((c) => c.id === clusterId)?.article_count) || 0,
      ctx.sourceIdsByCluster.get(clusterId)?.size ?? 0,
    );
  // The article's cosine with the centroid of the cluster's seed and newest scan
  // members (not the article itself, whose own text would flatter the cluster);
  // 1 when there is nothing to compare with.
  const centroidCosineFor = (clusterId: string): number => {
    const cached = centroidCosines.get(clusterId);
    if (cached !== undefined) return cached;
    const texts: string[] = [];
    const seen = new Set<string>();
    const add = (m: { id: string; title: string; description: string | null }) => {
      if (m.id === article.id || seen.has(m.id)) return;
      seen.add(m.id);
      texts.push(memberTfidfText(m));
    };
    const seed = seedByCluster.get(clusterId);
    if (seed) add(seed);
    let scanned = 0;
    for (const m of headlinesByCluster.get(clusterId) ?? []) {
      if (scanned >= CENTROID_MAX_MEMBERS) break;
      scanned += 1;
      add(m);
    }
    const cos = texts.length === 0
      ? 1
      : centroidCosine(`${article.title || ""} ${article.clusteringDescription || ""}`, texts, ctx.tfidf);
    centroidCosines.set(clusterId, cos);
    return cos;
  };
  // Evaluates the guard for `cand`: true when it passes the candidate over (logged and,
  // in a live drain, counted).
  const evaluateCentroidGuard = (cand: Scored): boolean => {
    const seed = seedByCluster.get(cand.clusterId);
    const latest = latestByCluster.get(cand.clusterId);
    const scan = headlinesByCluster.get(cand.clusterId) ?? [];
    const fp = article.fingerprint;
    const verdict = centroidGuard({
      enabled: centroidOn,
      memberCount: memberCountOf(cand.clusterId),
      headlineHit: cand.headlineHit,
      exactTitleProbeHit: probeSet.has(cand.clusterId),
      strictFingerprintMatch: Boolean(fp) &&
        (seed?.fingerprint === fp || latest?.fingerprint === fp || scan.some((m) => m.fingerprint === fp)),
      alreadyMember: seed?.id === article.id || latest?.id === article.id || scan.some((m) => m.id === article.id),
      cosine: () => centroidCosineFor(cand.clusterId),
    });
    if (!verdict.blocked) return false;
    const cos = verdict.cosine ?? 0;
    console.log(
      `[cluster-consumer] centroid-guard skip article=${article.id} cluster=${cand.clusterId} cos=${cos.toFixed(3)}${dryRun ? " dry-run" : ""}`,
    );
    if (!dryRun) {
      centroidSkipCount += 1;
      if (centroidSkipSamples.length < CENTROID_SKIP_SAMPLE_MAX) {
        centroidSkipSamples.push({ clusterId: cand.clusterId, cos: Math.round(cos * 1000) / 1000 });
      }
    }
    return true;
  };
  // True when the guard passes `cand` over. Evaluated once per cluster for this article
  // (the Jev live band and the join loop may both ask), so it is logged and counted once.
  const centroidBlocks = (cand: Scored): boolean => {
    if (!centroidOn) return false;
    const memo = centroidVerdicts.get(cand.clusterId);
    if (memo !== undefined) return memo;
    const verdict = evaluateCentroidGuard(cand);
    centroidVerdicts.set(cand.clusterId, verdict);
    return verdict;
  };

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

  if (jevLive.enabled && primary && band !== "none" && !dryRun && !centroidBlocks(primary)) {
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

  // The join loop, shared by the context candidates below and by the stem-probe
  // hits further down: walks `cands` in ranking order and hands the article to
  // the first cluster that takes it. A candidate below `bar` ends the walk; one
  // whose fallbackScore is below `bar` is passed over, and so is one the centroid
  // guard above rejects. In a dry run it reports
  // "would_match" instead of writing. Clusters that already hold the article's
  // source are added to `blocked` (and, with evidence, to dupBlock via
  // noteDupBlock). Returns the outcome of the join, or null when nothing took the
  // article.
  //
  // A centroid-guard skip of a candidate at or above MATCH_THRESHOLD withdraws the
  // "primary is a match" premise, exactly as a Jev reject does (see fallbackBar
  // below): from then on the bar is at least MATCH_THRESHOLD, so the loop cannot
  // fall into a sub-threshold candidate the ensemble would never have joined on its
  // own. A duplicate-source skip of an at-or-above-threshold candidate keeps the
  // premise (the story is matched, its cluster merely holds the source), so once one
  // has happened the bar stays as given (h70-mergequality-2).
  const joinFirstAvailable = async (
    cands: readonly Scored[],
    bar: number,
    blocked: Set<string>,
  ): Promise<ProcessOutcome | null> => {
    let guardSkippedMatch = false;
    let dupSkippedMatch = false;
    for (const cand of cands) {
      if (blocked.has(cand.clusterId)) continue;
      const effBar = guardSkippedMatch && !dupSkippedMatch ? Math.max(bar, MATCH_THRESHOLD) : bar;
      if (cand.score < effBar) break;
      // The text floor caps the entity/tfidf lane at MATCH_THRESHOLD - 0.01,
      // inside [FALLBACK_FLOOR, MATCH_THRESHOLD). A candidate whose only
      // results in that window rest on the capped lane is a pair joined by
      // entities alone; it may still be reviewed by Jev's low band above, but
      // must not join here when the primary was skipped as a duplicate-source.
      if (cand.fallbackScore < effBar) continue;
      // h70-mergequality-2: the centroid guard. Skipped, not blocked: a later
      // candidate is still tried, and the cluster is not recorded as a duplicate.
      if (centroidBlocks(cand)) {
        if (cand.score >= MATCH_THRESHOLD) guardSkippedMatch = true;
        continue;
      }
      if (dryRun) {
        if (wouldDuplicate(ctx, cand.clusterId, article)) {
          blocked.add(cand.clusterId);
          if (cand.score >= MATCH_THRESHOLD) dupSkippedMatch = true;
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
          if (cand.score >= MATCH_THRESHOLD) dupSkippedMatch = true;
          // probeSet holds only exact-title probe hits; a stem-probe hit is never
          // in it (its id was not in ctx.clusters yet), so it gets probeHit false.
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
    return null;
  };

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
    // A Jev reject withdraws the "primary is a match" premise, so the
    // fallback may only reach a candidate the ensemble would have joined
    // on its own (score >= MATCH_THRESHOLD); otherwise createCluster.
    // Without this, a band-high reject (primary in [0.40, 0.44)) could
    // fall through into a genuinely sub-threshold join in [FALLBACK_FLOOR,
    // MATCH_THRESHOLD) -- a join the ensemble alone would never make.
    // A centroid-guard skip of an at-or-above-threshold candidate withdraws
    // the same premise, and joinFirstAvailable raises its own bar to
    // MATCH_THRESHOLD from then on -- unless an above-threshold candidate
    // was skipped as a duplicate-source, whose premise (the story matches)
    // is intact, so the old sub-threshold fallback stays (h70-mergequality-2).
    const fallbackBar = marginalRejectedClusterId ? MATCH_THRESHOLD : FALLBACK_FLOOR;
    const joined = await joinFirstAvailable(ranked, fallbackBar, blocked);
    if (joined) return joined;
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
  // does the weak-match case (best score below MATCH_THRESHOLD). The same holds
  // for a follow-up in other words while SAME_SOURCE_UPDATE_ENFORCE is off: it is
  // logged and counted by takeSameSourceSkip and opens a cluster (h45-clusters-1).
  const dupSkip = await takeSameSourceSkip(primary?.score);
  if (dupSkip) return dupSkip;

  // No viable match. In a dry run, report what would happen without ever
  // calling createCluster/registerNewClusterInCache/addMemberToIndices.
  if (dryRun) {
    return { result: "would_create", score: primary?.score, sourcesBefore: [] };
  }

  // h19-recall-2: no candidate of the context reached FALLBACK_FLOOR, so the
  // story may sit in a cluster older than the 200-cluster window that the
  // exact-title probe missed over punctuation ('X' against 'X!', a quoted
  // title). Ask the database once for live clusters that share the headline
  // stems, load them, and score them like any candidate. The bar is
  // MATCH_THRESHOLD, exactly as above: no sub-threshold fallback here. After the
  // dry-run return, so a dry run never asks.
  if (!primary) {
    const stemIds = await probeStemClusters(ctx, article);
    if (stemIds.length > 0) {
      // The corpus changed (the hits' docs were added), so the query vector is
      // rebuilt from the same text.
      const stemQuery = ctx.tfidf.query(
        `${article.title || ""} ${article.clusteringDescription || ""}`,
        article.id,
      );
      const stemScored: Scored[] = [];
      for (const clusterId of stemIds) {
        const s = scoreCandidate(clusterId, stemQuery);
        if (s) stemScored.push(s);
      }
      const stemRanked = rankCandidates(stemScored, makeSizeOf(), {
        margin: CANDIDATE_SIZE_TIEBREAK_MARGIN,
        threshold: MATCH_THRESHOLD,
      });
      const stemJoined = await joinFirstAvailable(stemRanked, MATCH_THRESHOLD, new Set<string>());
      if (stemJoined) {
        const joinedScore = stemRanked.find((c) => c.clusterId === stemJoined.clusterId)?.score ?? 0;
        console.log(
          `[cluster-consumer] stem-probe join article=${article.id} cluster=${stemJoined.clusterId} score=${joinedScore.toFixed(3)}`,
        );
        return stemJoined;
      }
      // Nothing joined; a hit that holds the article's source with strong
      // evidence still makes the article that source's own duplicate.
      const stemSkip = await takeSameSourceSkip(stemRanked[0]?.score);
      if (stemSkip) return stemSkip;
    }
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
  // `scored` only holds candidates at FALLBACK_FLOOR or better, so a primary here
  // means the article opened a cluster although the context had a floor candidate
  // (below MATCH_THRESHOLD, blocked by its source, or rejected by Jev).
  if (primary) {
    return {
      result: "created",
      clusterId: newId,
      floorCandidate: { clusterId: primary.clusterId, score: primary.score },
    };
  }
  return { result: "created", clusterId: newId };
}

// ---------------------------------------------------------------------------
// Attach-only probe (hunt-25 W3, h25-clusters-3, migration 151)
// ---------------------------------------------------------------------------
//
// The politics gate is decided per article, so one story can split: identical
// headlines filed under genel sat next to a 13-member politika cluster. Migration
// 151's trigger sends such articles (genel, ekonomi, dunya, yasam, teknoloji of an
// outlet or a wire) to the separate cluster_attach queue; this section decides, for
// each, whether an EXISTING politics cluster of the in-memory context already holds
// its story. Evidence is attachDecision()'s and nothing else: the identical folded
// headline, an equal strict fingerprint, or the headline lane, against clusters
// with >= 60% politics members and without the article's source.
//
//   CLUSTER_ATTACH_MODE   off     the queue is not read
//                         shadow  (default) the decision is recorded in
//                                 cluster_attach_shadow, nothing is clustered
//                         live    the article is stamped politics_admitted_at (the
//                                 reader's 60% politics share counts the stamp) and
//                                 linked through cluster_link_atomic
//
// A successful message is DELETED, not archived: the queue carries ~4k messages a
// day and 037's archive retention only covers the two older queues. A message past
// MAX_READS is archived as in cluster_work. Reading happens only after cluster_work
// ran dry and with the read-budget floor left (planAttachRead), so attach work can
// never take the time politika work needs.

// Best-effort like the skip log: the first failure of each kind in an isolate
// warns, later ones stay quiet.
let attachShadowWarned = false;

function warnAttachShadowOnce(detail: string) {
  if (attachShadowWarned) return;
  attachShadowWarned = true;
  console.warn(`[cluster-consumer] cluster_attach_shadow insert failed, continuing: ${detail}`);
}

let attachReadWarned = false;

function warnAttachReadOnce(detail: string) {
  if (attachReadWarned) return;
  attachReadWarned = true;
  console.warn(`[cluster-consumer] cluster_attach read failed, continuing: ${detail}`);
}

interface AttachSummary {
  mode: AttachMode;
  read: number;
  would_attach: number;
  attached: number;
  // Messages that threw (transient retry or poison archive).
  failed: number;
  // Work done, but the acknowledging delete failed (the redelivery is idempotent).
  delete_errors: number;
  // Everything that was not an attach, by reason (no-match, same-source, in-gate, ...).
  by_reason: Record<string, number>;
  // Best-effort queue depth after the phase (null when unknown).
  depth_after: number | null;
  oldest_age_after_s: number | null;
}

function newAttachSummary(mode: AttachMode): AttachSummary {
  return {
    mode,
    read: 0,
    would_attach: 0,
    attached: 0,
    failed: 0,
    delete_errors: 0,
    by_reason: {},
    depth_after: null,
    oldest_age_after_s: null,
  };
}

interface AttachOutcome {
  result: "would_attach" | "attached" | "skipped" | "not-found" | "in-gate" | "disabled";
  reason?: string;
  clusterId?: string;
}

// The candidate list is rebuilt from the context once per batch (and after a live
// attach changed the context), not once per message.
interface AttachState {
  candidates: AttachCandidate[] | null;
}

// The clusters of the in-memory context as attach candidates: the headlines the
// context already scans, plus seed and latest, with the politics share and every
// member source. A cluster without a known share is not a candidate.
function buildAttachCandidates(ctx: ClusterContext): AttachCandidate[] {
  const out: AttachCandidate[] = [];
  const seen = new Set<string>();
  for (const cluster of ctx.clusters) {
    if (seen.has(cluster.id)) continue;
    seen.add(cluster.id);
    const share = ctx.politicsShareByCluster.get(cluster.id);
    if (share === undefined) continue;
    const members = new Map<string, AttachMember>();
    for (const m of ctx.headlinesByCluster.get(cluster.id) ?? []) {
      members.set(m.id, {
        id: m.id,
        sourceId: m.sourceId,
        title: m.title,
        tokens: m.tokens,
        publishedMs: m.publishedMs,
        fingerprint: m.fingerprint,
      });
    }
    for (const m of [ctx.seedByCluster.get(cluster.id), ctx.latestByCluster.get(cluster.id)]) {
      if (!m || members.has(m.id)) continue;
      members.set(m.id, {
        id: m.id,
        sourceId: m.source_id,
        title: m.title,
        tokens: headlineTokens(m.title),
        publishedMs: Date.parse(m.published_at),
        fingerprint: m.fingerprint ?? null,
      });
    }
    if (members.size === 0) continue;
    out.push({
      clusterId: cluster.id,
      politicsShare: share,
      sourceIds: ctx.allSourceIdsByCluster.get(cluster.id) ?? ctx.sourceIdsByCluster.get(cluster.id) ?? [],
      articleCount: Number(cluster.article_count) || members.size,
      members: [...members.values()],
    });
  }
  return out;
}

async function recordAttach(
  articleId: string,
  decision: { clusterId: string; score: number; lane: string },
  mode: "shadow" | "live",
): Promise<void> {
  try {
    const res = await supabase.from("cluster_attach_shadow").upsert(
      [
        {
          article_id: articleId,
          cluster_id: decision.clusterId,
          score: decision.score,
          lane: decision.lane,
          mode,
        },
      ],
      { onConflict: "article_id", ignoreDuplicates: true },
    );
    if (res.error) warnAttachShadowOnce(res.error.message);
  } catch (err) {
    warnAttachShadowOnce(err instanceof Error ? err.message : String(err));
  }
}

// Removes the stamp THIS attempt set (and only that value) after a failed link.
async function clearAttachStamp(articleId: string, stampedAt: string): Promise<void> {
  try {
    const res = await supabase
      .from("articles")
      .update({ politics_admitted_at: null })
      .eq("id", articleId)
      .eq("politics_admitted_at", stampedAt);
    if (res.error) {
      console.warn(`[cluster-consumer] clearing the attach stamp of ${articleId} failed: ${res.error.message}`);
    }
  } catch (err) {
    console.warn(
      `[cluster-consumer] clearing the attach stamp of ${articleId} failed: ${err instanceof Error ? err.message : err}`,
    );
  }
}

interface AttachArticleRow {
  id: string;
  source_id: string | null;
  title: string | null;
  description: string | null;
  url: string | null;
  published_at: string;
  category: string | null;
  politics_admitted_at: string | null;
}

async function processAttach(
  articleId: string,
  mode: AttachMode,
  state: AttachState,
): Promise<AttachOutcome> {
  const artRes = await supabase
    .from("articles")
    .select("id, source_id, title, description, url, published_at, category, politics_admitted_at")
    .eq("id", articleId)
    .maybeSingle();
  if (artRes.error) throw new Error(`processAttach fetch: ${artRes.error.message}`);
  if (!artRes.data) return { result: "not-found" };
  const raw = artRes.data as AttachArticleRow;

  try {
    const route = routeMessage(raw, "attach", "off", mode);
    if (route === "disabled") return { result: "disabled" };
    if (route === "in-gate") return { result: "in-gate" };
    if (route !== "attach") return { result: "skipped", reason: `route-${route}` };
    // Wave BF / W3: a roundup title never attaches (see isRoundupTitle). Counted in by_reason.
    if (isRoundupTitle(raw.title)) return { result: "skipped", reason: ROUNDUP_SKIP_REASON };

    // The strict fingerprint of title + cleaned description: a SHA-1 of the folded
    // text, exactly what the clusterer stores for its members.
    const fingerprint = strictFingerprint(raw.title || "", cleanDescription(raw.description) || "");
    const article: AttachArticle = {
      id: raw.id,
      sourceId: raw.source_id,
      title: raw.title || "",
      tokens: headlineTokens(raw.title),
      publishedMs: Date.parse(raw.published_at),
      fingerprint,
    };
    // The context warmed at the top of the drain is used as it is: reloading it here
    // is the expensive step the 546 CPU limit is about.
    const ctx = clusterContextCache ?? (await getClusterContext());
    if (state.candidates === null) state.candidates = buildAttachCandidates(ctx);
    const decision: AttachDecision = attachDecision(article, state.candidates, { nowMs: Date.now() });
    if ("reason" in decision) return { result: "skipped", reason: decision.reason };

    if (mode === "shadow") {
      await recordAttach(raw.id, decision, "shadow");
      return { result: "would_attach", clusterId: decision.clusterId };
    }

    // live: the stamp first, so the cluster never holds a member the reader's
    // politics share does not count; then the existing atomic link.
    const stampedAt = new Date().toISOString();
    const stampRes = await supabase
      .from("articles")
      .update({ politics_admitted_at: stampedAt })
      .eq("id", raw.id)
      .is("politics_admitted_at", null)
      .select("id");
    if (stampRes.error) throw new Error(`attach stamp: ${stampRes.error.message}`);
    const stamped = Array.isArray(stampRes.data) ? stampRes.data.length : stampRes.data ? 1 : 0;
    if (stamped === 0) return { result: "skipped", reason: "stamp-lost" };
    try {
      const linked = await addArticleToCluster(await getSourceLookup(), decision.clusterId, {
        id: raw.id,
        source_id: raw.source_id,
      });
      if (linked.skipped) {
        await clearAttachStamp(raw.id, stampedAt);
        return { result: "skipped", reason: "same-source" };
      }
    } catch (err) {
      await clearAttachStamp(raw.id, stampedAt);
      throw err;
    }
    addMemberToIndices(decision.clusterId, {
      id: raw.id,
      published_at: raw.published_at,
      source_id: raw.source_id,
      fingerprint,
      title: raw.title || "",
      description: raw.description,
      entities: null,
      signature: null,
    });
    state.candidates = null;
    await recordAttach(raw.id, decision, "live");
    return { result: "attached", clusterId: decision.clusterId };
  } catch (err) {
    // The URL for the msg-error log, as processArticle does (audit O14).
    if (err instanceof Error) {
      (err as Error & { article_url?: string }).article_url = raw.url ?? undefined;
    }
    throw err;
  }
}

// One read of the attach queue (qty from planAttachRead), then one decision per
// message. Never throws: a failure here must not touch the cluster_work summary.
async function drainAttach(
  qty: number,
  mode: AttachMode,
  startedAt: number,
  summary: AttachSummary,
  touchedClusterIds: Set<string>,
): Promise<void> {
  let messages: PgmqMessage<QueueMessage>[];
  try {
    messages = await readBatch<QueueMessage>(supabase, ATTACH_QUEUE_NAME, VT_SECONDS, qty);
  } catch (err) {
    warnAttachReadOnce(err instanceof Error ? err.message : String(err));
    return;
  }
  summary.read = messages.length;
  const state: AttachState = { candidates: null };
  const tally = (key: string) => {
    summary.by_reason[key] = (summary.by_reason[key] ?? 0) + 1;
  };
  const archiveQuietly = async (msgId: number) => {
    try {
      await archive(supabase, ATTACH_QUEUE_NAME, msgId);
    } catch (archErr) {
      console.warn(
        `[cluster-consumer] archive of attach msg ${msgId} failed: ${archErr instanceof Error ? archErr.message : archErr}`,
      );
    }
  };

  for (const msg of messages) {
    // Same deadline rule as cluster_work: leave the rest untouched, the visibility
    // timeout returns them to the queue.
    if (Date.now() - startedAt >= MAX_INVOCATION_MS) break;
    const articleId = msg.message?.article_id;
    if (!articleId || typeof articleId !== "string") {
      await archiveQuietly(msg.msg_id);
      tally("malformed");
      continue;
    }
    if (parseAdmitTag(msg.message?.admit) !== "attach") {
      await archiveQuietly(msg.msg_id);
      tally("bad-tag");
      continue;
    }

    let outcome: AttachOutcome;
    try {
      outcome = await processAttach(articleId, mode, state);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const url = (err as { article_url?: string } | null | undefined)?.article_url ?? null;
      console.error(
        "[cluster-consumer] attach msg-error",
        JSON.stringify({ msg_id: msg.msg_id, read_ct: msg.read_ct, article_id: articleId, url, error: errMsg }),
      );
      summary.failed += 1;
      // Poison contract (shared with cluster_work): archive once read_ct EXCEEDS
      // MAX_READS; otherwise leave the message for the visibility timeout.
      if (msg.read_ct > MAX_READS) await archiveQuietly(msg.msg_id);
      continue;
    }

    switch (outcome.result) {
      case "would_attach":
        summary.would_attach += 1;
        break;
      case "attached":
        summary.attached += 1;
        if (outcome.clusterId) touchedClusterIds.add(outcome.clusterId);
        break;
      default:
        tally(outcome.reason ?? outcome.result);
    }

    try {
      await deleteMessage(supabase, ATTACH_QUEUE_NAME, msg.msg_id);
    } catch (delErr) {
      summary.delete_errors += 1;
      console.warn(
        `[cluster-consumer] delete of attach msg ${msg.msg_id} failed: ${delErr instanceof Error ? delErr.message : delErr}`,
      );
    }
  }

  const depth = await queueDepth(supabase, ATTACH_QUEUE_NAME);
  summary.depth_after = depth.depth;
  summary.oldest_age_after_s = depth.oldest_msg_age_sec;
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
  // Wave BF / W3: the part of `skipped` that was a roundup title (reason "roundup-title").
  roundupSkipped: number;
  notFound: number;
  notPolitics: number;
  failedTransient: number;
  failedPermanent: number;
  // h16-precision-2 (log-only): title/description name swaps seen this drain,
  // plus up to 3 sample article ids.
  descriptionSwapSuspects: number;
  descriptionSwapSamples: string[];
  // h45-clusters-1 (shadow): follow-ups of a source on its own story that would
  // have been skipped with SAME_SOURCE_UPDATE_ENFORCE on and opened a cluster
  // instead. Always 0 once the constant is true (they are skipped, not counted).
  sameSourceUpdateShadow: number;
  // h70-mergequality-2: candidate clusters the centroid guard passed over (live drains
  // only) -- the article did not join them because its text does not fit the cluster as
  // a whole -- and up to CENTROID_SKIP_SAMPLE_MAX {clusterId, cos} samples (ids and a
  // cosine, never a title). Watch it after a deploy: more than ~2% of joins deserves a look.
  centroidSkips: { count: number; samples: Array<{ clusterId: string; cos: number }> };
  // h40-clusters-1 (diagnostics, counts and ids only -- never a title or a URL).
  // Whole minutes from now to the oldest updated_at among the newest-
  // CONTEXT_CLUSTER_CAP clusters of the context this drain used (null when that
  // window was empty). An hour or less at the time a twin was opened means the
  // twin's older cluster had already left the window.
  ctx_window_min: number | null;
  // New clusters opened while the context's best candidate scored at least
  // FALLBACK_FLOOR (it did not join: below MATCH_THRESHOLD, source-blocked or
  // rejected by Jev), plus up to CREATED_FLOOR_SAMPLE_MAX samples of them.
  created_with_floor_candidate: number;
  created_with_floor_candidate_samples: Array<{
    article_id: string;
    top_cluster_id: string;
    top_score: number;
  }>;
  // h101-e2elatency-1: long-poll reads of cluster_work made this invocation (never more
  // than POLL_MAX_CALLS). Always 0 while POLL_ENABLED is false (h102-pollregression-1).
  polls: number;
  duration_ms: number;
  budgeted_out: boolean;
  jev_live: JevLiveState;
  admission: AdmissionSummary;
  // hunt-25 W3: the attach-only probe's block ({mode, read, would_attach, attached, by_reason, ...}).
  attach: AttachSummary;
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

// Seconds the NEXT cluster_work read may wait for a message (a long poll), or 0 for
// the plain read. Pure: the clock is a parameter, so the minute rule and the budget
// are tested without waiting. Not consulted while POLL_ENABLED is false
// (h102-pollregression-1); kept exported and unit-tested for the redesign.
//   * only an invocation that STARTED in a UTC minute with minute % 3 === 0 polls
//     (ingest-drain's minutes); every other minute answers 0;
//   * at most POLL_MAX_CALLS polls per invocation; the second only while less than
//     POLL_SECOND_CALL_BEFORE_MS have passed since the start;
//   * a poll never runs past the point where the loop stops leasing new batches
//     (MAX_INVOCATION_MS - READ_BUDGET_FLOOR_MS): the wait is shortened to what is
//     left, whole seconds, and 0 when less than one second is left. A message found
//     at the very end of a poll still has READ_BUDGET_FLOOR_MS to be processed.
// A clock that is not a number answers 0.
export function planClusterWorkPoll(input: {
  startedAtMs: number;
  nowMs: number;
  pollsMade: number;
}): number {
  const { startedAtMs, nowMs, pollsMade } = input;
  if (pollsMade >= POLL_MAX_CALLS) return 0;
  if (new Date(startedAtMs).getUTCMinutes() % POLL_MINUTE_MODULUS !== 0) return 0;
  const elapsedMs = nowMs - startedAtMs;
  if (pollsMade >= 1 && !(elapsedMs < POLL_SECOND_CALL_BEFORE_MS)) return 0;
  const leftSeconds = Math.floor((MAX_INVOCATION_MS - READ_BUDGET_FLOOR_MS - elapsedMs) / 1000);
  const seconds = Math.min(POLL_SECONDS, leftSeconds);
  return seconds >= 1 ? seconds : 0;
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
  sameSourceUpdateShadow = 0;
  centroidSkipCount = 0;
  centroidSkipSamples = [];

  // Migration 089 ("ADMIT"): read the flag inside drainQueue (not at module
  // load) so the Deno-env polyfill test harness keeps working, same
  // discipline as jevLive above.
  const admissionModeValue = admissionMode(Deno.env.get(JEV_ADMISSION_POLICY.envFlag) ?? undefined);
  // Hunt-25 W3: unset is SHADOW, only the exact strings "off" and "live" differ.
  const attachModeValue = attachMode(Deno.env.get(ATTACH_MODE_ENV) ?? undefined);

  const startedAt = Date.now();
  const summary: InvocationSummary = {
    drained: 0,
    matched: 0,
    created: 0,
    skipped: 0,
    roundupSkipped: 0,
    notFound: 0,
    notPolitics: 0,
    failedTransient: 0,
    failedPermanent: 0,
    descriptionSwapSuspects: 0,
    descriptionSwapSamples: [],
    sameSourceUpdateShadow: 0,
    centroidSkips: { count: 0, samples: [] },
    ctx_window_min: null,
    created_with_floor_candidate: 0,
    created_with_floor_candidate_samples: [],
    polls: 0,
    duration_ms: 0,
    budgeted_out: false,
    jev_live: jevLive,
    admission: newAdmissionSummary(admissionModeValue),
    attach: newAttachSummary(attachModeValue),
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

  // True only when a cluster_work read came back short (nothing more visible): the
  // gate for the attach phase. A read error, the deadline or the budget leave it false.
  let clusterWorkEmpty = false;

  // h101-e2elatency-1 (migration 188): in an ingest minute the first reads were long
  // polls. `polling` is true until a poll finds a message, the plan says stop, or the
  // RPC turns out not to exist; the plain read below is the same read as always and
  // always follows the last empty poll. Nothing here sleeps: the wait is inside the
  // database call. h102-pollregression-1: POLL_ENABLED is false, so the plan is never
  // asked, `polling` is cleared by the first turn, and the loop below is the pre-#252
  // loop: one readBatch per turn, `summary.polls` 0.
  let polling = true;

  while (true) {
    // Lease a new batch only while enough budget remains to actually
    // process it. pgmq bumps read_ct on every read, so a read that only
    // ever budget-outs walks a never-attempted message toward the poison
    // threshold (audit S11). A poll is a read like any other: this guard
    // runs before each one, and the plan keeps the poll inside the budget.
    if (Date.now() - startedAt > MAX_INVOCATION_MS - READ_BUDGET_FLOOR_MS) {
      summary.budgeted_out = true;
      break;
    }
    let messages: PgmqMessage<QueueMessage>[];
    try {
      const pollSeconds = POLL_ENABLED && polling
        ? planClusterWorkPoll({ startedAtMs: startedAt, nowMs: Date.now(), pollsMade: summary.polls })
        : 0;
      if (pollSeconds > 0) {
        summary.polls += 1;
        try {
          messages = await readBatchPoll<QueueMessage>(
            supabase,
            QUEUE_NAME,
            VT_SECONDS,
            BATCH_SIZE,
            pollSeconds,
            POLL_INTERVAL_MS,
          );
        } catch (pollErr) {
          if (!isPollRpcMissing(pollErr)) throw pollErr;
          // Migration 188 is not applied (yet): this consumer was deployed first.
          // Read plainly, as before the poll existed; no poll is retried this invocation.
          console.warn(
            `[cluster-consumer] pgmq_read_msgs_poll is not available (apply migration 188), reading without the poll: ${pollErr instanceof Error ? pollErr.message : pollErr}`,
          );
          polling = false;
          messages = await readBatch<QueueMessage>(supabase, QUEUE_NAME, VT_SECONDS, BATCH_SIZE);
        }
        if (messages.length > 0) polling = false;
      } else {
        polling = false;
        messages = await readBatch<QueueMessage>(
          supabase,
          QUEUE_NAME,
          VT_SECONDS,
          BATCH_SIZE,
        );
      }
    } catch (err) {
      console.error(
        `[cluster-consumer] pgmq.read failed: ${err instanceof Error ? err.message : err}`,
      );
      summary.failedTransient += 1;
      break;
    }
    if (messages.length === 0) {
      // An empty poll is not an empty queue yet: go round again for the second poll
      // (if the plan allows one) or for the plain read; the budget guard runs first.
      if (polling) continue;
      clusterWorkEmpty = true;
      break;
    }

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

      // "attach" belongs to the cluster_attach queue; a stray one on cluster_work is
      // not a Jev claim.
      const parsedTag = parseAdmitTag(msg.message?.admit);
      const admitTag = parsedTag === "attach" ? null : parsedTag;

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
            if (outcome.floorCandidate) {
              summary.created_with_floor_candidate += 1;
              if (summary.created_with_floor_candidate_samples.length < CREATED_FLOOR_SAMPLE_MAX) {
                summary.created_with_floor_candidate_samples.push({
                  article_id: articleId,
                  top_cluster_id: outcome.floorCandidate.clusterId,
                  top_score: Math.round(outcome.floorCandidate.score * 1000) / 1000,
                });
              }
            }
            break;
          case "skipped":
            summary.skipped += 1;
            if (outcome.reason === ROUNDUP_SKIP_REASON) summary.roundupSkipped += 1;
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
    if (messages.length < BATCH_SIZE) {
      clusterWorkEmpty = true;
      break;
    }
  }

  // Hunt-25 W3: the attach-only probe, strictly after cluster_work. planAttachRead
  // is 0 unless cluster_work ran dry AND the read-budget floor is left, and never
  // more than ATTACH_MAX_PER_DRAIN: the attach queue cannot starve politika work.
  // Best-effort end to end -- nothing in here may fail the drain.
  if (attachModeValue !== "off") {
    const attachQty = planAttachRead({
      clusterWorkEmpty,
      elapsedMs: Date.now() - startedAt,
      budgetMs: MAX_INVOCATION_MS,
      cap: ATTACH_MAX_PER_DRAIN,
      floorMs: READ_BUDGET_FLOOR_MS,
    });
    if (attachQty > 0) {
      try {
        await drainAttach(attachQty, attachModeValue, startedAt, summary.attach, touchedClusterIds);
      } catch (err) {
        console.warn(
          `[cluster-consumer] attach phase failed, continuing: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (summary.matched + summary.created + summary.attach.attached > 0) {
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
  summary.sameSourceUpdateShadow = sameSourceUpdateShadow;
  summary.centroidSkips = { count: centroidSkipCount, samples: centroidSkipSamples.map((x) => ({ ...x })) };
  // h40-clusters-1: the age of the window of the context the drain ended with
  // (windowOldestUpdatedMs is set once per context build, so this is the window
  // the last message was scored against).
  summary.ctx_window_min = windowAgeMinutes(clusterContextCache?.windowOldestUpdatedMs, Date.now());
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
