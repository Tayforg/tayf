import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { BALANCE_MIN_SOURCES, balanceFromZoneCounts } from "@/lib/bias/balance";
import { createReaderClient } from "@/lib/supabase/server";
import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  KARNE_WINDOW_DAYS,
  karneFreshness,
  pct,
  type SourceKarne,
  type SourceKarneFreshness,
} from "@/lib/sources/karne";

// "Kaynak göstergeleri" (migration 111) -- four neutral numbers about how one
// outlet publishes, shown on /source/[slug] under the Kapsama karnesi. Read
// path only: cadence, wire-copy count and zone mix are precomputed into
// `source_reliability_30d` by `source_karne_refresh_batch()` (the existing
// */15 job); the blindspot share is derived here from the karne row.
//
// Definitions (pinned; mirrored as comments in 111_source_reliability.sql):
//   - Window: articles.published_at >= now() - 30 days (the same `mine` CTE as
//     the karne).
//   - Cadence: n_articles = every article of the source published in the
//     window (not in the future); active_days = distinct Europe/Istanbul dates
//     among them. A 30-day window spans up to 31 dates, so activeDays may be
//     windowDays + 1; the view clamps it for display.
//   - Wire copy: per cluster, members deduped to the earliest article per
//     source (dedupeBySource); the cluster is wire per detectWireRedistribution
//     (>= 3 members, distinct hashes / members <= WIRE_UNIQUE_HASH_RATIO, a
//     NULL hash unique per article). n_wire_copy = the source's clusters that
//     are wire AND where its own member's content_hash equals another source's
//     member hash. Direction-neutral; an independent report inside a wire
//     cluster is never counted.
//   - Zone mix: per cluster, voting-source counts per zone from
//     clusters.bias_distribution; clusters with >= BALANCE_MIN_SOURCES votes
//     are kept as [iktidar, bagimsiz, muhalefet, nClusters] triples. The
//     Denge puanı is computed HERE (balanceFromZoneCounts), not in SQL.
//   - Blindspot share: karne.nBlindspot / karne.nClusters (the public
//     blindspot definition of 071 via the karne). No new SQL.
//
// Deliberately NOT here: any quality / trust grade or a ranking. The rows are
// descriptions of the published stream and the card says so.
//
// Clock reads: `toSourceReliability` / `buildReliabilityView` never read the
// clock. The ONE clock read is `getReliabilityFreshnessCached`, inside a
// "use cache" scope (same shape as karne.ts), so a prerender never sees an
// uncached Date.now().

export const RELIABILITY_WINDOW_DAYS = KARNE_WINDOW_DAYS;
/** Floor for the wire-copy and blindspot shares (same floor as the karne). */
export const RELIABILITY_MIN_CLUSTERS = KARNE_MIN_CLUSTERS;
/** Floor for the zone-diversity mean (clusters with enough votes). */
export const RELIABILITY_MIN_DIVERSITY_CLUSTERS = KARNE_MIN_MULTI_FOR_ZONES;

/** [iktidar, bagimsiz, muhalefet, number of clusters with exactly that vote triple] */
export type ZoneMixEntry = readonly [number, number, number, number];

export interface SourceReliability {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  nArticles: number;
  /** Distinct Istanbul dates with an article; can be windowDays + 1. */
  activeDays: number;
  nClusters: number;
  nWireCopy: number;
  zoneMix: ZoneMixEntry[];
  computedAt: string;
}

/** A validated row plus its freshness; what the page and the card consume. */
export type SourceReliabilityRead = SourceReliability & SourceKarneFreshness;

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function isoString(v: unknown): string | null {
  return typeof v === "string" && v !== "" && !Number.isNaN(new Date(v).getTime())
    ? v
    : null;
}

function toZoneMix(v: unknown): ZoneMixEntry[] | null {
  if (!Array.isArray(v)) return null;
  const out: ZoneMixEntry[] = [];
  for (const e of v as unknown[]) {
    if (!Array.isArray(e) || e.length !== 4) return null;
    const a = count(e[0]);
    const b = count(e[1]);
    const c = count(e[2]);
    const n = count(e[3]);
    if (a === null || b === null || c === null || n === null) return null;
    out.push([a, b, c, n]);
  }
  return out;
}

/** Validate a `source_reliability_30d` row. Null unless every invariant holds. */
export function toSourceReliability(raw: unknown): SourceReliability | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const windowDays = count(r.window_days);
  const nArticles = count(r.n_articles);
  const activeDays = count(r.active_days);
  const nClusters = count(r.n_clusters);
  const nWireCopy = count(r.n_wire_copy);
  const zoneMix = toZoneMix(r.zone_mix);
  const windowStart = isoString(r.window_start);
  const windowEnd = isoString(r.window_end);
  const computedAt = isoString(r.computed_at);

  if (
    windowDays === null || nArticles === null || activeDays === null ||
    nClusters === null || nWireCopy === null || zoneMix === null ||
    windowStart === null || windowEnd === null || computedAt === null
  ) {
    return null;
  }
  // Mirror the table's CHECK constraints.
  if (windowDays < 1 || windowDays > 90) return null;
  if (activeDays > windowDays + 1) return null;
  if (nWireCopy > nClusters) return null;

  return {
    windowDays,
    windowStart,
    windowEnd,
    nArticles,
    activeDays,
    nClusters,
    nWireCopy,
    zoneMix,
    computedAt,
  };
}

export interface ZoneDiversity {
  /** Cluster-weighted mean Denge puanı, whole number 0..100. */
  meanScore: number;
  /** Clusters the mean was computed from (those with >= BALANCE_MIN_SOURCES votes). */
  n: number;
}

/**
 * Weighted mean Denge puanı over the zone-mix entries that have enough votes
 * to be scored; null when no cluster qualifies.
 */
export function diversityFromZoneMix(
  mix: ReadonlyArray<ZoneMixEntry>,
): ZoneDiversity | null {
  let weighted = 0;
  let n = 0;
  for (const [iktidar, bagimsiz, muhalefet, clusters] of mix) {
    const b = balanceFromZoneCounts({ iktidar, bagimsiz, muhalefet });
    if (b === null) continue;
    weighted += b.score * clusters;
    n += clusters;
  }
  if (n === 0) return null;
  return { meanScore: Math.round(weighted / n), n };
}

export type ReliabilityKey = "cadence" | "wire" | "blindspot" | "diversity";

export interface ReliabilityRow {
  key: ReliabilityKey;
  label: string;
  /** null when the row is below its sample gate (then `note` explains). */
  value: string | null;
  note: string | null;
  /** "Nasıl hesaplanır?" disclosure text. */
  how: string;
}

const RATE_FORMAT = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 1 });

function share(num: number, den: number): string {
  return `%${pct(num, den) ?? 0} (${num}/${den})`;
}

function insufficient(n: number, min: number): string {
  return `Yeterli örnek yok (n = ${n}, en az ${min}).`;
}

function cadenceValue(rel: SourceReliability): string {
  if (rel.nArticles === 0) return `Son ${rel.windowDays} günde haber yok`;
  const perDay = rel.nArticles / rel.windowDays;
  // A non-zero rate must never be shown as "0".
  const rate =
    Math.round(perDay * 10) === 0 ? "<0,1" : RATE_FORMAT.format(perDay);
  const days = Math.min(rel.activeDays, rel.windowDays);
  return `${rate} haber/gün · ${days}/${rel.windowDays} gün yayın`;
}

export function buildReliabilityView(
  rel: SourceReliability,
  karne: SourceKarne | null,
): ReliabilityRow[] {
  const cadence: ReliabilityRow = {
    key: "cadence",
    label: "Yayın sıklığı",
    value: cadenceValue(rel),
    note: null,
    how: `Son ${rel.windowDays} günün haber sayısı ${rel.windowDays}’a bölünür; etkin gün, en az bir haber yayımlanan gündür (Türkiye saati).`,
  };

  const wireOpen = rel.nClusters >= RELIABILITY_MIN_CLUSTERS;
  const wire: ReliabilityRow = {
    key: "wire",
    label: "Başka kaynaklarla aynı başlık ve özet",
    value: wireOpen ? share(rel.nWireCopy, rel.nClusters) : null,
    note: wireOpen ? null : insufficient(rel.nClusters, RELIABILITY_MIN_CLUSTERS),
    how: "Ajans dağıtımı sayılan kümelerde başlığı ve özeti başka bir kaynakla aynı olan haberlerin payı (haber gövdesi karşılaştırılmaz); yön belirtmez.",
  };

  let blindspotValue: string | null = null;
  let blindspotNote: string | null = null;
  if (karne === null) {
    blindspotNote = "Kapsama karnesi henüz hesaplanmadı.";
  } else if (karne.nClusters < RELIABILITY_MIN_CLUSTERS) {
    blindspotNote = insufficient(karne.nClusters, RELIABILITY_MIN_CLUSTERS);
  } else {
    blindspotValue = share(karne.nBlindspot, karne.nClusters);
  }
  const blindspot: ReliabilityRow = {
    key: "blindspot",
    label: "Kör nokta kümelerindeki payı",
    value: blindspotValue,
    note: blindspotNote,
    how: "Kaynağın yer aldığı haber kümelerinden kör nokta olarak işaretlenenlerin payı (Kapsama karnesiyle aynı sayım).",
  };

  const diversity = diversityFromZoneMix(rel.zoneMix);
  const diversityN = diversity?.n ?? 0;
  const diversityOpen =
    diversity !== null && diversityN >= RELIABILITY_MIN_DIVERSITY_CLUSTERS;
  const diversityRow: ReliabilityRow = {
    key: "diversity",
    label: "Bölge çeşitliliği",
    value:
      diversityOpen && diversity
        ? `Ortalama Denge puanı ${diversity.meanScore}/100 (n = ${diversity.n} küme)`
        : null,
    note: diversityOpen
      ? null
      : insufficient(diversityN, RELIABILITY_MIN_DIVERSITY_CLUSTERS),
    how: `En az ${BALANCE_MIN_SOURCES} oy veren kaynağı olan kümelerin Denge puanı ortalaması (0 tek bölge, 100 üç bölgeye eşit).`,
  };

  return [cadence, wire, blindspot, diversityRow];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS =
  "source_id, window_days, window_start, window_end, n_articles, active_days, n_clusters, n_wire_copy, zone_mix, computed_at";

/**
 * One point lookup on the PK. Throws on a Supabase error. Runs under the 4 s
 * reader cap (user-facing: /source/[slug]); the cached attempt turns the
 * resulting AbortError into `{ ok: false }` and the caller's live retry
 * heals it.
 */
async function fetchReliabilityRow(
  sourceId: string,
): Promise<SourceReliability | null> {
  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("source_reliability_30d")
    .select(COLUMNS)
    .eq("source_id", sourceId)
    .maybeSingle();
  if (error) {
    throw new Error(`[source-reliability] fetch error: ${error.message}`);
  }
  return data ? toSourceReliability(data) : null;
}

// Exactly ONE `cacheLife` per invocation, chosen after the attempt: a failed
// attempt (typically the 4 s reader abort on a cold database) is memoised for
// `minutes` only, so one blip cannot park an `{ ok: false }` sentinel for
// hours; a success - including a legitimately missing row - keeps `hours`.
async function getSourceReliabilityCached(sourceId: string) {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("source-reliability", () =>
    fetchReliabilityRow(sourceId),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

// The only clock read. Pure body (cannot throw across the cache boundary);
// keyed on computed_at, so a refreshed row gets a fresh entry.
async function getReliabilityFreshnessCached(
  computedAt: string,
): Promise<SourceKarneFreshness> {
  "use cache";
  cacheLife("hours");
  return karneFreshness(computedAt, Date.now());
}

/** Never throws; null for a non-uuid id, a missing/invalid row or an outage. */
export async function getSourceReliability(
  sourceId: string,
): Promise<SourceReliabilityRead | null> {
  if (typeof sourceId !== "string" || !UUID_RE.test(sourceId)) return null;
  const row = await resolveCachedOrRetry(
    "source-reliability",
    () => getSourceReliabilityCached(sourceId),
    () => fetchReliabilityRow(sourceId),
    null,
  );
  if (!row) return null;
  return { ...row, ...(await getReliabilityFreshnessCached(row.computedAt)) };
}
