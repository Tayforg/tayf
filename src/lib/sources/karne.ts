import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, resolveCachedOrRetry } from "@/lib/cache-resilience";
import { createServerClient } from "@/lib/supabase/server";
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
// No Date.now(): the window bounds come from the row itself.

export const KARNE_WINDOW_DAYS = 30;
export const KARNE_MIN_CLUSTERS = 20;
export const KARNE_MIN_MULTI_FOR_ZONES = 10;

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

/** One point lookup on the PK. Throws on a Supabase error. */
async function fetchKarneRow(sourceId: string): Promise<SourceKarne | null> {
  const supabase = createServerClient();
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

async function getSourceKarneCached(sourceId: string) {
  "use cache";
  cacheLife("hours");
  cacheTag("sources");
  return attemptCached("source-karne", () => fetchKarneRow(sourceId));
}

/** Never throws; null for a non-uuid id, a missing/invalid row or an outage. */
export async function getSourceKarne(sourceId: string): Promise<SourceKarne | null> {
  if (typeof sourceId !== "string" || !UUID_RE.test(sourceId)) return null;
  return resolveCachedOrRetry(
    "source-karne",
    () => getSourceKarneCached(sourceId),
    () => fetchKarneRow(sourceId),
    null,
  );
}
