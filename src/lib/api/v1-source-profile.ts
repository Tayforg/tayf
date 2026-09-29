import {
  KARNE_MIN_CLUSTERS,
  KARNE_MIN_MULTI_FOR_ZONES,
  type SourceKarne,
} from "@/lib/sources/karne";

/**
 * Keyed-API projection of one outlet's "Kapsama karnesi" (migration 096).
 * Pure: no I/O. Mirrors the site's publication thresholds (buildKarneView):
 * below KARNE_MIN_CLUSTERS only the window + n_clusters are shown; below
 * KARNE_MIN_MULTI_FOR_ZONES multi-source stories the zone split is withheld.
 *
 * Deliberately NOT here: clickbait scores (precision gate closed) and
 * headline-edit data (056 counsel gate).
 */

// karne.ts's COLUMNS constant is private; copied literally.
export const V1_PROFILE_SOURCE_COLUMNS =
  "id, slug, name, url, bias, kind, active, zone_rationale, zone_rationale_at, trustee_since, trustee_note";
export const V1_PROFILE_KARNE_COLUMNS =
  "source_id, window_days, window_start, window_end, n_clusters, n_multi, co_iktidar, co_bagimsiz, co_muhalefet, n_blindspot, n_blindspot_same_side, computed_at";

export interface V1SourceProfile {
  window_days: number;
  window_start: string;
  window_end: string;
  computed_at: string;
  n_clusters: number;
  min_clusters: number;
  sufficient: boolean;
  n_multi: number | null;
  n_solo: number | null;
  min_multi_for_zones: number;
  co_covering_zones: { iktidar: number; bagimsiz: number; muhalefet: number } | null;
  public_blindspot_appearances: number | null;
  public_blindspot_same_side: number | null;
}

export function toV1SourceProfile(k: SourceKarne): V1SourceProfile {
  const sufficient = k.nClusters >= KARNE_MIN_CLUSTERS;
  const zonesShown = sufficient && k.nMulti >= KARNE_MIN_MULTI_FOR_ZONES;
  return {
    window_days: k.windowDays,
    window_start: k.windowStart,
    window_end: k.windowEnd,
    computed_at: k.computedAt,
    n_clusters: k.nClusters,
    min_clusters: KARNE_MIN_CLUSTERS,
    sufficient,
    n_multi: sufficient ? k.nMulti : null,
    n_solo: sufficient ? k.nSolo : null,
    min_multi_for_zones: KARNE_MIN_MULTI_FOR_ZONES,
    co_covering_zones: zonesShown
      ? { iktidar: k.co.iktidar, bagimsiz: k.co.bagimsiz, muhalefet: k.co.muhalefet }
      : null,
    public_blindspot_appearances: sufficient ? k.nBlindspot : null,
    public_blindspot_same_side: sufficient ? k.nBlindspotSameSide : null,
  };
}
