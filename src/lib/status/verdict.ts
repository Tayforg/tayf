import { BIAS_TO_ZONE } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Pure verdict logic for the public /durum ("Sistem durumu") page. No I/O, no
// clock reads: every age is measured against the snapshot's own
// `generatedAt`, so the same snapshot always renders the same page.
//
// The numbers below are the SAME thresholds the ops heartbeat pages on
// (public.ops_health_report(), migrations 077/103/108), so the public page can
// never say "fine" while ops says "fail". Comparisons are strict `>` for
// ages (as in ops) and `>=` for the silent-feed share (as in dead_feeds).
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

/** Clustering freshness, minutes since the newest clusters.updated_at.
 * Source: 110 Step 0 (read-only prod, 2026-10-22): max gap between
 * consecutive cluster updates over 7 days = 51 min (10,990 intervals), so
 * fail = max(90, ceil(1.5 x 51) = 77) = 90 and warn = ceil(fail / 2) = 45 (the
 * ops 077 convention: warn is half of fail, floor of 90 min). */
export const STATUS_CLUSTER_WARN_MIN = 45;
export const STATUS_CLUSTER_FAIL_MIN = 90;

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
  clustering: { ok: boolean; lastAt: string | null };
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
  clustering: { level: StatusLevel; ageMin: number | null };
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

function isoOrNull(v: unknown): { ok: true; value: string | null } | { ok: false } {
  if (v === null) return { ok: true, value: null };
  if (isIsoTimestamp(v)) return { ok: true, value: v };
  return { ok: false };
}

/**
 * Copies ONLY the known keys of the `public_status_snapshot()` payload.
 * Unknown keys (at any level) are dropped; `last_by_bias` keeps an entry only
 * when its key is a real bias (BIAS_TO_ZONE) and its value is an ISO
 * timestamp. Returns null when the payload is not an object, `generated_at`
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
    clustering: { ok: clusteringRaw.ok, lastAt: clusterAt.value },
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

export function buildStatusView(s: PublicStatusSnapshot): StatusViewModel {
  const ingestAges = zoneIngestAges(s);
  const zones: ZoneStatusRow[] = STATUS_ZONE_ORDER.map((zone) => {
    if (!s.ingest.ok) return { zone, level: "bilinmiyor", ageMin: null };
    const ageMin = ingestAges[zone];
    return { zone, level: levelForAge(ageMin, STATUS_INGEST_WARN_MIN, STATUS_INGEST_FAIL_MIN), ageMin };
  });

  const clusterAge = s.clustering.ok ? ageMinutes(s.generatedAt, s.clustering.lastAt) : null;
  const clustering = {
    level: s.clustering.ok
      ? levelForAge(clusterAge, STATUS_CLUSTER_WARN_MIN, STATUS_CLUSTER_FAIL_MIN)
      : ("bilinmiyor" as const),
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
