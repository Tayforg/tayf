import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { createReaderClient } from "@/lib/supabase/server";
import type { MediaDnaZone } from "@/types";

// "Kapsama karnesi" (migration 096) -- how one outlet's CLUSTERED stories
// behave over the last KARNE_WINDOW_DAYS days. Read path only: the numbers
// are precomputed into `source_karne_30d` by `source_karne_refresh()`.
//
// Definitions (pinned; mirrored as comments in 096_source_karne.sql):
//   - Window: articles.published_at >= now() - 30 days.
//   - Story: a distinct cluster holding >= 1 article from the source
//     published in the window. Non-politics articles are never clustered, so
//     they drop out (the card's footnote says so).
//   - own_vote = 1 if source.kind in ('outlet','wire') else 0;
//     own_zone = BIAS_TO_ZONE[source.bias].
//   - Per cluster, zone counts come from clusters.bias_distribution (distinct
//     voting sources); others_z = greatest(z - (z == own_zone ? own_vote : 0), 0).
//   - nMulti: clusters with others_i + others_b + others_m >= 1;
//     nSolo = nClusters - nMulti.
//   - co[zone]: multi clusters with others_zone >= 1 (a cluster can count in
//     several zones, so the shares do not sum to 100%).
//   - nBlindspot: is_blindspot AND NOT blindspot_recall_veto (071);
//     nBlindspotSameSide: subset where zone(blindspot_side) == own_zone.
//
// Deliberately NOT here: clickbait (precision gate closed), headline edits
// (056 counsel gate), first-mover counts, any "skipped stories" list.
//
// Clock reads: `toSourceKarne` / `buildKarneView` never read the clock (the
// window bounds come from the row itself). The ONE clock read is
// `getKarneFreshnessCached`, which runs inside a "use cache" scope, so a
// prerender never sees an uncached Date.now() and the live-retry path of
// `getSourceKarne` is covered by the same scope.
//
// Freshness (migration 106): the refresh runs in bounded cron batches and a
// row older than KARNE_STALE_AFTER_HOURS means the batches are not keeping up
// (or the job is failing). The card then says so instead of presenting old
// numbers as current.

export const KARNE_WINDOW_DAYS = 30;
export const KARNE_MIN_CLUSTERS = 20;
export const KARNE_MIN_MULTI_FOR_ZONES = 10;
export const KARNE_STALE_AFTER_HOURS = 48;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface SourceKarne {
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  nClusters: number;
  nMulti: number;
  nSolo: number;
  co: Record<MediaDnaZone, number>;
  nBlindspot: number;
  nBlindspotSameSide: number;
  computedAt: string;
}

export interface SourceKarneFreshness {
  /** computed_at is older than KARNE_STALE_AFTER_HOURS. */
  isStale: boolean;
  /** Whole days since computed_at (0 for a future or unparseable date). */
  ageDays: number;
}

/** A validated row plus its freshness; what the page and the card consume. */
export type SourceKarneRead = SourceKarne & SourceKarneFreshness;

function count(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function isoString(v: unknown): string | null {
  return typeof v === "string" && v !== "" && !Number.isNaN(new Date(v).getTime())
    ? v
    : null;
}

/** Validate a `source_karne_30d` row. Null unless every invariant holds. */
export function toSourceKarne(raw: unknown): SourceKarne | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const windowDays = count(r.window_days);
  const nClusters = count(r.n_clusters);
  const nMulti = count(r.n_multi);
  const coI = count(r.co_iktidar);
  const coB = count(r.co_bagimsiz);
  const coM = count(r.co_muhalefet);
  const nBlindspot = count(r.n_blindspot);
  const nSame = count(r.n_blindspot_same_side);
  const windowStart = isoString(r.window_start);
  const windowEnd = isoString(r.window_end);
  const computedAt = isoString(r.computed_at);

  if (
    windowDays === null || nClusters === null || nMulti === null ||
    coI === null || coB === null || coM === null ||
    nBlindspot === null || nSame === null ||
    windowStart === null || windowEnd === null || computedAt === null
  ) {
    return null;
  }
  if (nMulti > nClusters) return null;
  if (coI > nMulti || coB > nMulti || coM > nMulti) return null;
  if (nSame > nBlindspot) return null;

  return {
    windowDays,
    windowStart,
    windowEnd,
    nClusters,
    nMulti,
    nSolo: nClusters - nMulti,
    co: { iktidar: coI, bagimsiz: coB, muhalefet: coM },
    nBlindspot,
    nBlindspotSameSide: nSame,
    computedAt,
  };
}

/**
 * Pure freshness of a `computed_at` timestamp at `nowMs`. Unparseable input
 * and clock skew (future dates) are never reported as stale.
 */
export function karneFreshness(
  computedAt: string,
  nowMs: number,
): SourceKarneFreshness {
  const computedMs = Date.parse(computedAt);
  if (Number.isNaN(computedMs)) return { isStale: false, ageDays: 0 };
  const ageMs = Math.max(0, nowMs - computedMs);
  return {
    isStale: ageMs > KARNE_STALE_AFTER_HOURS * HOUR_MS,
    ageDays: Math.floor(ageMs / DAY_MS),
  };
}

/** Rounded whole percent, or null when the denominator is 0. */
export function pct(num: number, den: number): number | null {
  if (den === 0) return null;
  return Math.round((100 * num) / den);
}

function share(num: number, den: number): string {
  return `%${pct(num, den) ?? 0} (${num}/${den})`;
}

export interface KarneZoneRow {
  zone: MediaDnaZone;
  label: string;
  text: string;
}

export type KarneView =
  | { state: "insufficient"; n: number }
  | {
      state: "ok";
      multiText: string;
      soloText: string;
      /** null when nMulti < KARNE_MIN_MULTI_FOR_ZONES */
      zones: KarneZoneRow[] | null;
      zoneHeader: string;
      zoneNote: string;
      zonesInsufficientText: string;
      blindspotText: string;
    };

const ZONE_ROWS: ReadonlyArray<{ zone: MediaDnaZone; label: string }> = [
  { zone: "iktidar", label: "İktidar medyası" },
  { zone: "bagimsiz", label: "Bağımsız medya" },
  { zone: "muhalefet", label: "Muhalefet medyası" },
];

export function buildKarneView(k: SourceKarne): KarneView {
  if (k.nClusters < KARNE_MIN_CLUSTERS) {
    return { state: "insufficient", n: k.nClusters };
  }
  const zones =
    k.nMulti >= KARNE_MIN_MULTI_FOR_ZONES
      ? ZONE_ROWS.map(({ zone, label }) => ({
          zone,
          label,
          text: share(k.co[zone], k.nMulti),
        }))
      : null;

  let blindspotText = `Kör nokta işaretli haberler: ${k.nBlindspot}`;
  if (k.nBlindspot > 0) {
    blindspotText += ` · ${k.nBlindspotSameSide} tanesinde haberi ağırlıkla yazan bölgedeydi`;
  }

  return {
    state: "ok",
    multiText: share(k.nMulti, k.nClusters),
    soloText: share(k.nSolo, k.nClusters),
    zones,
    zoneHeader: `Aynı haberi yazan diğer kaynakların bölgesi (${k.nMulti} çok kaynaklı haber)`,
    zoneNote:
      "Bir haber birden çok bölgeden kaynak içerebilir; oranların toplamı %100 değildir.",
    zonesInsufficientText: `Bölge dağılımı için yeterli çok kaynaklı haber yok (n = ${k.nMulti}, en az ${KARNE_MIN_MULTI_FOR_ZONES}).`,
    blindspotText,
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const COLUMNS =
  "source_id, window_days, window_start, window_end, n_clusters, n_multi, co_iktidar, co_bagimsiz, co_muhalefet, n_blindspot, n_blindspot_same_side, computed_at";

/**
 * One point lookup on the PK. Throws on a Supabase error. Runs under the 4 s
 * reader cap (user-facing: /source/[slug]); the cached attempt turns the
 * resulting AbortError into `{ ok: false }` and the caller's live retry
 * heals it.
 */
async function fetchKarneRow(sourceId: string): Promise<SourceKarne | null> {
  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("source_karne_30d")
    .select(COLUMNS)
    .eq("source_id", sourceId)
    .maybeSingle();
  if (error) {
    throw new Error(`[source-karne] fetch error: ${error.message}`);
  }
  return data ? toSourceKarne(data) : null;
}

// Exactly ONE `cacheLife` per invocation, chosen after the attempt: a failed
// attempt (typically the 4 s reader abort on a cold database) is memoised for
// `minutes` only, so one blip cannot park an `{ ok: false }` sentinel for
// hours; a success - including a legitimately missing row - keeps `hours`.
async function getSourceKarneCached(sourceId: string) {
  "use cache";
  cacheTag("sources");
  const r = await attemptCached("source-karne", () => fetchKarneRow(sourceId));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("hours");
  else cacheLife("minutes");
  return r;
}

// The only clock read. Pure body (cannot throw across the cache boundary);
// keyed on computed_at, so a refreshed row gets a fresh entry.
async function getKarneFreshnessCached(
  computedAt: string,
): Promise<SourceKarneFreshness> {
  "use cache";
  cacheLife("hours");
  return karneFreshness(computedAt, Date.now());
}

/** Never throws; null for a non-uuid id, a missing/invalid row or an outage. */
export async function getSourceKarne(
  sourceId: string,
): Promise<SourceKarneRead | null> {
  if (typeof sourceId !== "string" || !UUID_RE.test(sourceId)) return null;
  const karne = await resolveCachedOrRetry(
    "source-karne",
    () => getSourceKarneCached(sourceId),
    () => fetchKarneRow(sourceId),
    null,
  );
  if (!karne) return null;
  return { ...karne, ...(await getKarneFreshnessCached(karne.computedAt)) };
}
