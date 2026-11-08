import { BIAS_TO_ZONE } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Pure verdict logic for the public /durum ("Sistem durumu") page. No I/O, no
// clock reads: every age is measured against the snapshot's own
// `generatedAt`, so the same snapshot always renders the same page.
//
// The ingest, labelling and feed numbers below are the SAME thresholds the ops
// heartbeat pages on (public.ops_health_report(), migrations 077/103/108), so
// the public page can never say "fine" while ops says "fail". Ops has no
// cluster-FRESHNESS row (a quiet night with nothing to cluster is not a fault),
// so clustering mirrors ops row 18 `queue_lag` (migrations 150 and 167): the age
// of the oldest visible cluster_work message (warn > 300 s, fail > 900 s), the
// queue depth (warn > 300) and the poison count (warn when one or more messages
// were archived after more than 3 reads; the page counts the last hour, ops the
// last 24). The age line alone cannot see a consumer that fails every message:
// it archives each one on its 4th read (about 3-7 min after enqueue), so the
// oldest visible wait never passes 900 s and the queue stays short; the poison
// count is what surfaces that outage. The older "minutes since the newest
// clusters.updated_at" rule (45/90) survives only as the fallback for a database
// that does not have migration 176 yet.
// Comparisons are strict `>` for ages (as in ops) and `>=` for the silent-feed
// share (as in dead_feeds).
//
// What the page is allowed to say: the snapshot carries safe aggregates only
// (timestamps, a bias->timestamp map, counts). `toPublicStatusSnapshot` is an
// allow-list parser, so a future change that leaks a job name, error text or
// URL into the rpc payload cannot reach the model, and therefore cannot reach
// the HTML.

// ---------------------------------------------------------------------------
// Thresholds. Each carries its source.
// ---------------------------------------------------------------------------

/** How far back the snapshot function looks (110_public_status.sql:
 * `interval '6 hours'`; pinned by tests/migrations/110-public-status.test.ts).
 * Anything quieter than this reads "Son 6 saatte haber yok". */
export const STATUS_LOOKBACK_HOURS = 6;

/** Ingest freshness per zone, minutes since the newest articles.created_at of
 * an active voting source. Source: ops check 4 `ingest_fresh_<zone>_min`
 * (migration 103/108: warn > 79, fail > 158 = max(90, ceil(1.5 x the 104.9 min
 * 7-day max gap)); warn = fail / 2). */
export const STATUS_INGEST_WARN_MIN = 79;
export const STATUS_INGEST_FAIL_MIN = 158;

/** FALLBACK clustering rule, used only when the snapshot carries no queue
 * number (a database before migration 176): minutes since the newest
 * clusters.updated_at. It cannot tell an idle pipeline from a stuck consumer
 * (a night with nothing to cluster touches no cluster), which is why 176 added
 * the queue numbers below.
 * Source: 110 Step 0 (read-only prod, 2026-10-22): max gap between
 * consecutive cluster updates over 7 days = 51 min (10,990 intervals), so
 * fail = max(90, ceil(1.5 x 51) = 77) = 90 and warn = ceil(fail / 2) = 45 (the
 * ops 077 convention: warn is half of fail, floor of 90 min). */
export const STATUS_CLUSTER_WARN_MIN = 45;
export const STATUS_CLUSTER_FAIL_MIN = 90;

/** Clustering lag, seconds the oldest VISIBLE cluster_work message has waited
 * (migration 176 reads it as `clustering.queue_oldest_sec`). Source: ops row 18
 * `queue_lag`, migration 150: warn when cluster_work's oldest visible message
 * is over 300 s, fail over 900 s (strict `>`). Measured 2026-11-08 over 48 h
 * (3,016 messages): wait p95 63.7 s, max 83.4 s, none over 300 s. */
export const STATUS_CLUSTER_QUEUE_WARN_SEC = 300;
export const STATUS_CLUSTER_QUEUE_FAIL_SEC = 900;

/** Clustering backlog, messages in cluster_work (`clustering.queue_depth`).
 * Source: ops row 18 `queue_lag`, migration 150/167: warn when the depth is
 * over 300 (strict `>`), whatever the wait. It never reaches "sorunlu" on its
 * own, as in ops (only the wait fails). */
export const STATUS_CLUSTER_QUEUE_DEPTH_WARN = 300;

/** Clustering poison, messages archived with read_ct > 3 (the consumer's
 * MAX_READS = 3: it archives a message on its 4th failed read) inside this
 * window (`clustering.queue_poison_recent`, migration 176 reads
 * pgmq.a_cluster_work). Source: ops row 18's `q_poison >= 1` warn line,
 * migration 167, whose window is 24 h; the public page uses 1 h so a recovered
 * pipeline stops reading amber within the hour. One or more is "gecikmeli". */
export const STATUS_CLUSTER_POISON_WINDOW_HOURS = 1;

/** Labelling (jev-shadow) freshness, minutes since the last finished run that
 * did work. Source: ops check 5 `jev_shadow_last_run_min` (migration 108:
 * warn > 20, fail > 30; zero-call partial runs do not count). */
export const STATUS_LABELLING_WARN_MIN = 20;
export const STATUS_LABELLING_FAIL_MIN = 30;

/** Share of ACTIVE sources with no article in the trailing 72 h (the same
 * window /kaynaklar/durum uses). Source: 110 Step 0 (read-only prod,
 * 2026-10-22): 26 of 118 active sources silent = 22.0 %, below the 0.35 line
 * where the warn level would have to be lifted, so warn stays at 0.40.
 * Fail = 0.50, the ops `dead_feeds` ratio (migration 077/108), and must stay
 * above warn. Compared with `>=`, as ops does. */
export const STATUS_FEEDS_WARN_SILENT_SHARE = 0.4;
export const STATUS_FEEDS_FAIL_SILENT_SHARE = 0.5;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StatusLevel = "ok" | "gecikmeli" | "sorunlu" | "bilinmiyor";
export type OverallVerdict = "calisiyor" | "gecikmeli" | "sorunlu";

export const VERDICT_LABELS: Record<OverallVerdict, string> = {
  calisiyor: "Çalışıyor",
  gecikmeli: "Gecikmeli",
  sorunlu: "Sorunlu",
};

/** The validated, allow-listed rpc payload. Nothing outside this shape is kept. */
export interface PublicStatusSnapshot {
  /** ISO timestamp of the measurement (database clock). */
  generatedAt: string;
  ingest: { ok: boolean; lastByBias: Partial<Record<BiasCategory, string>> };
  /** `queueDepth` / `queueOldestSec` / `queuePoisonRecent` come from migration
   * 176 (cluster_work messages, seconds the oldest visible one has waited, and
   * messages archived as poison in the last hour). They are absent on a pre-176
   * payload and null when the queue could not be read; null `queueOldestSec`
   * means "no queue number", and the verdict then falls back to the 45/90
   * rule. */
  clustering: {
    ok: boolean;
    lastAt: string | null;
    queueDepth?: number | null;
    queueOldestSec?: number | null;
    queuePoisonRecent?: number | null;
  };
  labelling: { ok: boolean; lastAt: string | null; paused: boolean };
  feeds: { ok: boolean; active: number | null; silent: number | null };
}

export interface ZoneStatusRow {
  zone: MediaDnaZone;
  level: StatusLevel;
  ageMin: number | null;
}

export interface StatusViewModel {
  generatedAt: string;
  overall: OverallVerdict;
  zones: ZoneStatusRow[];
  /** `ageMin` is the age of the last cluster update (informational once the
   * queue rule applies). `queueDepth` / `queueOldestSec` are present only when
   * the level was decided by the queue rule (`queueOldestSec` is then a finite
   * number >= 0). `queuePoisonRecent` is present only under the queue rule and
   * only when the snapshot carried a valid count (0 included). */
  clustering: {
    level: StatusLevel;
    ageMin: number | null;
    queueDepth?: number | null;
    queueOldestSec?: number;
    queuePoisonRecent?: number | null;
  };
  labelling: { level: StatusLevel | "duraklatildi"; ageMin: number | null };
  feeds: { level: StatusLevel; active: number | null; silent: number | null };
}

export const STATUS_ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// ---------------------------------------------------------------------------
// Payload parser (allow-list)
// ---------------------------------------------------------------------------

const ISO_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** True for an ISO-8601 timestamp with a zone designator that denotes a real
 * calendar instant (rejects "2026-02-31T..." and "2026-13-45T..."). */
function isIsoTimestamp(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = ISO_TIMESTAMP.exec(v);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(year, month)) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  return Number.isFinite(Date.parse(v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0;
}

/** A queue wait in seconds: a finite number >= 0, else null (null for NaN, Infinity, negatives and every non-number). */
function queueSecondsOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function isoOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (isIsoTimestamp(v)) return { ok: true, value: v };
  return { ok: false };
}

/**
 * Copies ONLY the known keys of the `public_status_snapshot()` payload.
 * Unknown keys (at any level) are dropped; `last_by_bias` keeps an entry only
 * when its key is a real bias (BIAS_TO_ZONE) and its value is an ISO
 * timestamp. `clustering.queue_oldest_sec` is kept when it is a finite number
 * >= 0, `queue_depth` and `queue_poison_recent` when they are non-negative
 * integers; a present key with anything else becomes null, and a payload with
 * none of the keys (a database before migration 176) parses to the old shape.
 * A payload with the two older queue keys but no `queue_poison_recent` parses
 * without `queuePoisonRecent`. Returns null when the payload is not an object, `generated_at`
 * is not a valid timestamp, or a section is missing or malformed, so the page
 * shows "alınamıyor" instead of guessing a verdict from a broken payload.
 */
export function toPublicStatusSnapshot(raw: unknown): PublicStatusSnapshot | null {
  if (!isRecord(raw)) return null;
  if (!isIsoTimestamp(raw.generated_at)) return null;

  const ingestRaw = raw.ingest;
  const clusteringRaw = raw.clustering;
  const labellingRaw = raw.labelling;
  const feedsRaw = raw.feeds;
  if (!isRecord(ingestRaw) || !isRecord(clusteringRaw) || !isRecord(labellingRaw) || !isRecord(feedsRaw)) {
    return null;
  }

  // ingest
  if (typeof ingestRaw.ok !== "boolean" || !isRecord(ingestRaw.last_by_bias)) return null;
  const lastByBias: Partial<Record<BiasCategory, string>> = {};
  for (const key of Object.keys(ingestRaw.last_by_bias)) {
    if (!Object.hasOwn(BIAS_TO_ZONE, key)) continue;
    const value = ingestRaw.last_by_bias[key];
    if (!isIsoTimestamp(value)) continue;
    lastByBias[key as BiasCategory] = value;
  }

  // clustering
  if (typeof clusteringRaw.ok !== "boolean") return null;
  const clusterAt = isoOrNull(clusteringRaw.last_at);
  if (!clusterAt.ok) return null;
  // migration 176: the queue numbers are optional and never make the payload invalid
  const hasPoisonKey = Object.hasOwn(clusteringRaw, "queue_poison_recent");
  const hasQueueKeys =
    Object.hasOwn(clusteringRaw, "queue_depth") || Object.hasOwn(clusteringRaw, "queue_oldest_sec") || hasPoisonKey;
  const queueDepth = isCount(clusteringRaw.queue_depth) ? clusteringRaw.queue_depth : null;
  const queueOldestSec = queueSecondsOrNull(clusteringRaw.queue_oldest_sec);
  const queuePoisonRecent = isCount(clusteringRaw.queue_poison_recent) ? clusteringRaw.queue_poison_recent : null;

  // labelling
  if (typeof labellingRaw.ok !== "boolean" || typeof labellingRaw.paused !== "boolean") return null;
  const labelAt = isoOrNull(labellingRaw.last_at);
  if (!labelAt.ok) return null;

  // feeds
  if (typeof feedsRaw.ok !== "boolean") return null;
  const active = feedsRaw.active;
  const silent = feedsRaw.silent;
  if (!(active === null || isCount(active)) || !(silent === null || isCount(silent))) return null;

  return {
    generatedAt: raw.generated_at,
    ingest: { ok: ingestRaw.ok, lastByBias },
    clustering: {
      ok: clusteringRaw.ok,
      lastAt: clusterAt.value,
      ...(hasQueueKeys
        ? { queueDepth, queueOldestSec, ...(hasPoisonKey ? { queuePoisonRecent } : {}) }
        : {}),
    },
    labelling: { ok: labellingRaw.ok, lastAt: labelAt.value, paused: labellingRaw.paused },
    feeds: { ok: feedsRaw.ok, active, silent },
  };
}

// ---------------------------------------------------------------------------
// Ages and levels
// ---------------------------------------------------------------------------

/** Minutes between `lastAt` and `generatedAt`. Null for a null/unparseable
 * `lastAt`; a `lastAt` after `generatedAt` (clock skew) clamps to 0. */
export function ageMinutes(generatedAt: string, lastAt: string | null): number | null {
  if (lastAt === null) return null;
  const end = Date.parse(generatedAt);
  const start = Date.parse(lastAt);
  if (!Number.isFinite(end) || !Number.isFinite(start)) return null;
  return Math.max(0, (end - start) / 60_000);
}

/** null age (nothing in the lookback) -> sorunlu; > fail -> sorunlu;
 * > warn -> gecikmeli; otherwise ok. Strict `>`, as in ops. */
export function levelForAge(age: number | null, warn: number, fail: number): StatusLevel {
  if (age === null) return "sorunlu";
  if (age > fail) return "sorunlu";
  if (age > warn) return "gecikmeli";
  return "ok";
}

/** Clustering level from the age in seconds of the oldest visible cluster_work
 * message (ops row 18 `queue_lag`, migration 150): > 900 s sorunlu, > 300 s
 * gecikmeli, otherwise ok. Strict `>`, as in ops. An empty queue is 0 s. The
 * depth and poison lines of the same row are applied on top of this in
 * buildStatusView (they can only raise ok to gecikmeli). */
export function clusterQueueLevel(oldestSec: number): StatusLevel {
  if (oldestSec > STATUS_CLUSTER_QUEUE_FAIL_SEC) return "sorunlu";
  if (oldestSec > STATUS_CLUSTER_QUEUE_WARN_SEC) return "gecikmeli";
  return "ok";
}

/** Age per zone, taking the newest `lastAt` across the zone's biases. */
export function zoneIngestAges(s: PublicStatusSnapshot): Record<MediaDnaZone, number | null> {
  const out: Record<MediaDnaZone, number | null> = { iktidar: null, bagimsiz: null, muhalefet: null };
  for (const [bias, lastAt] of Object.entries(s.ingest.lastByBias)) {
    if (!Object.hasOwn(BIAS_TO_ZONE, bias) || typeof lastAt !== "string") continue;
    const zone = BIAS_TO_ZONE[bias as BiasCategory];
    const age = ageMinutes(s.generatedAt, lastAt);
    if (age === null) continue;
    const current = out[zone];
    out[zone] = current === null ? age : Math.min(current, age);
  }
  return out;
}

/** Silent-source share -> level. Unknown when there is nothing to divide by. */
export function feedsLevel(active: number | null, silent: number | null): StatusLevel {
  if (active === null || silent === null || active <= 0) return "bilinmiyor";
  const share = silent / active;
  if (share >= STATUS_FEEDS_FAIL_SILENT_SHARE) return "sorunlu";
  if (share >= STATUS_FEEDS_WARN_SILENT_SHARE) return "gecikmeli";
  return "ok";
}

// ---------------------------------------------------------------------------
// Overall verdict
// ---------------------------------------------------------------------------

export interface VerdictInputs {
  zones: readonly StatusLevel[];
  clustering: StatusLevel;
  labelling: StatusLevel | "duraklatildi";
  feeds: StatusLevel;
}

// 0 = fine, 1 = late, 2 = broken. bilinmiyor counts as late: an unmeasured
// step is not a measured failure, so it can slow the verdict but never
// declare an outage on its own.
function rank(level: StatusLevel | "duraklatildi"): 0 | 1 | 2 {
  if (level === "sorunlu") return 2;
  if (level === "gecikmeli" || level === "bilinmiyor") return 1;
  return 0;
}

/**
 * Ingest zones and clustering count as measured. Labelling and feed coverage
 * are capped at "gecikmeli": a stalled classifier or a quiet source list slows
 * the product down but does not stop news from flowing. A paused labelling
 * job is deliberate and is excluded.
 */
export function overallVerdict(inputs: VerdictInputs): OverallVerdict {
  const ranks: number[] = [
    ...inputs.zones.map(rank),
    rank(inputs.clustering),
    Math.min(1, rank(inputs.labelling)),
    Math.min(1, rank(inputs.feeds)),
  ];
  const worst = Math.max(...ranks);
  if (worst >= 2) return "sorunlu";
  if (worst >= 1) return "gecikmeli";
  return "calisiyor";
}

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

/** The clustering view model when a queue wait is known (ops row 18's three lines). */
function queueClustering(
  c: PublicStatusSnapshot["clustering"],
  queueOldestSec: number,
  ageMin: number | null,
): StatusViewModel["clustering"] {
  const queueDepth = isCount(c.queueDepth) ? c.queueDepth : null;
  const queuePoisonRecent = isCount(c.queuePoisonRecent) ? c.queuePoisonRecent : null;
  let level = clusterQueueLevel(queueOldestSec);
  if (level === "ok") {
    const backlog = queueDepth !== null && queueDepth > STATUS_CLUSTER_QUEUE_DEPTH_WARN;
    const poisoned = queuePoisonRecent !== null && queuePoisonRecent >= 1;
    if (backlog || poisoned) level = "gecikmeli";
  }
  return {
    level,
    ageMin,
    queueDepth: c.queueDepth ?? null,
    queueOldestSec,
    ...(queuePoisonRecent !== null ? { queuePoisonRecent } : {}),
  };
}

export function buildStatusView(s: PublicStatusSnapshot): StatusViewModel {
  const ingestAges = zoneIngestAges(s);
  const zones: ZoneStatusRow[] = STATUS_ZONE_ORDER.map((zone) => {
    if (!s.ingest.ok) return { zone, level: "bilinmiyor", ageMin: null };
    const ageMin = ingestAges[zone];
    return { zone, level: levelForAge(ageMin, STATUS_INGEST_WARN_MIN, STATUS_INGEST_FAIL_MIN), ageMin };
  });

  // Clustering: when the snapshot carries the cluster_work queue lag (migration
  // 176) the level is the queue rule and the age of the last cluster update is
  // informational only (an idle night leaves it old without any backlog). The
  // rule is ops row 18: the oldest visible wait decides gecikmeli/sorunlu, and
  // a depth over 300 or one or more messages archived as poison in the last
  // hour raise an otherwise-ok level to gecikmeli (a consumer that fails every
  // message archives each on its 4th read, so the wait alone never shows it).
  // They never lower sorunlu. With no queue number the old updated_at rule
  // (45/90) decides, unchanged.
  const clusterAge = s.clustering.ok ? ageMinutes(s.generatedAt, s.clustering.lastAt) : null;
  const queueOldestSec = s.clustering.ok ? queueSecondsOrNull(s.clustering.queueOldestSec) : null;
  const clustering: StatusViewModel["clustering"] = !s.clustering.ok
    ? { level: "bilinmiyor", ageMin: null }
    : queueOldestSec !== null
      ? queueClustering(s.clustering, queueOldestSec, clusterAge)
      : {
          level: levelForAge(clusterAge, STATUS_CLUSTER_WARN_MIN, STATUS_CLUSTER_FAIL_MIN),
          ageMin: clusterAge,
        };

  const labelAge = s.labelling.ok ? ageMinutes(s.generatedAt, s.labelling.lastAt) : null;
  let labelLevel: StatusViewModel["labelling"]["level"];
  if (!s.labelling.ok) labelLevel = "bilinmiyor";
  else if (s.labelling.paused) labelLevel = "duraklatildi";
  else labelLevel = levelForAge(labelAge, STATUS_LABELLING_WARN_MIN, STATUS_LABELLING_FAIL_MIN);
  const labelling = { level: labelLevel, ageMin: labelAge };

  const feeds = {
    level: s.feeds.ok ? feedsLevel(s.feeds.active, s.feeds.silent) : ("bilinmiyor" as const),
    active: s.feeds.ok ? s.feeds.active : null,
    silent: s.feeds.ok ? s.feeds.silent : null,
  };

  return {
    generatedAt: s.generatedAt,
    overall: overallVerdict({
      zones: zones.map((z) => z.level),
      clustering: clustering.level,
      labelling: labelling.level,
      feeds: feeds.level,
    }),
    zones,
    clustering,
    labelling,
    feeds,
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "1 dakikadan kısa süre önce" / "N dakika önce" / "S saat D dakika önce". */
export function formatAge(min: number): string {
  const total = Number.isFinite(min) && min > 0 ? Math.floor(min) : 0;
  if (total < 1) return "1 dakikadan kısa süre önce";
  if (total < 60) return `${total} dakika önce`;
  const hours = Math.floor(total / 60);
  const rest = total % 60;
  return rest === 0 ? `${hours} saat önce` : `${hours} saat ${rest} dakika önce`;
}
