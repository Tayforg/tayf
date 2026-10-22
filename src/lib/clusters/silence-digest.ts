import { ZONE_META } from "@/lib/bias/config";
import type { BlindspotBundle } from "@/lib/clusters/blindspots-query";
import { zoneCountsFromSources } from "@/lib/feeds/zone-line";
import type { MediaDnaZone } from "@/types";

// "Kim yer vermedi?" band on /blindspots. Pure derivation over the bundles
// BlindspotsFeed already loaded: no query, no clock read (the caller passes
// `nowMs`), no I/O.
//
// WINDOW: rolling `SILENCE_WINDOW_HOURS` on cluster.updated_at, not the
// Istanbul calendar day. /blindspots only lists clusters whose
// first_published is older than BLINDSPOT.feedDelayHours (24 h), so a
// calendar-day window would be close to empty every morning.

export const SILENCE_WINDOW_HOURS = 24;

export const ZONE_ROW_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

/** Future timestamps up to this far ahead of `nowMs` still count (clock skew). */
const CLOCK_SKEW_TOLERANCE_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;

export interface SilenceRow {
  zone: MediaDnaZone;
  /** In-window stories on which this zone had no source at all. */
  silentCount: number;
  /** Non-zero breakdown of those stories by dominant zone, in ZONE_ROW_ORDER. */
  byDominant: Array<{ zone: MediaDnaZone; count: number }>;
}

export interface SilenceDigest {
  /** In-window, de-duplicated stories the rows were computed from. */
  windowTotal: number;
  /** Always exactly three rows, in ZONE_ROW_ORDER. */
  rows: SilenceRow[];
}

type DigestBundle = Pick<BlindspotBundle, "cluster" | "sources" | "dominantZone">;

function emptyZoneTally(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

/**
 * For each zone, counts the in-window blindspot stories on which that zone
 * had zero sources. Strict zero: a single source from the zone means it is
 * not silent. `bundle.sources` includes non-voting outlets, which is
 * deliberately conservative so "yer vermedi" is literally true. The bundle's
 * own dominant zone is never silent on it. One story can count in two rows.
 */
export function buildSilenceDigest(
  bundles: ReadonlyArray<DigestBundle>,
  nowMs: number,
  windowHours: number = SILENCE_WINDOW_HOURS,
): SilenceDigest {
  const windowMs = windowHours * HOUR_MS;
  const seen = new Set<string>();

  // silent[zone][dominant] = stories where `zone` was silent and `dominant` led.
  const silent: Record<MediaDnaZone, Record<MediaDnaZone, number>> = {
    iktidar: emptyZoneTally(),
    bagimsiz: emptyZoneTally(),
    muhalefet: emptyZoneTally(),
  };
  let windowTotal = 0;

  for (const bundle of bundles) {
    const updatedMs = Date.parse(bundle.cluster.updated_at);
    if (!Number.isFinite(updatedMs)) continue;
    if (updatedMs > nowMs + CLOCK_SKEW_TOLERANCE_MS) continue;
    if (nowMs - updatedMs > windowMs) continue;

    if (seen.has(bundle.cluster.id)) continue;
    seen.add(bundle.cluster.id);
    windowTotal += 1;

    const counts = zoneCountsFromSources(bundle.sources);
    for (const zone of ZONE_ROW_ORDER) {
      if (zone !== bundle.dominantZone && counts[zone] === 0) {
        silent[zone][bundle.dominantZone] += 1;
      }
    }
  }

  const rows: SilenceRow[] = ZONE_ROW_ORDER.map((zone) => {
    const byDominant = ZONE_ROW_ORDER.flatMap((dominant) => {
      const count = silent[zone][dominant];
      return count > 0 ? [{ zone: dominant, count }] : [];
    });
    return {
      zone,
      silentCount: byDominant.reduce((sum, entry) => sum + entry.count, 0),
      byDominant,
    };
  });

  return { windowTotal, rows };
}

/** Upper-cases the first character with Turkish rules ('i' -> 'İ'). */
export function capitalizeTr(s: string): string {
  return s.charAt(0).toLocaleUpperCase("tr") + s.slice(1);
}

/**
 * One row as a sentence. Neutral wording on purpose: "yer vermedi" states a
 * count of absent coverage and does not attribute intent.
 */
export function formatSilenceRow(row: SilenceRow): string {
  const subject = capitalizeTr(ZONE_META[row.zone].description);
  if (row.silentCount === 0) {
    return `${subject}: yer vermedikleri hikâye yok`;
  }
  const parts = row.byDominant
    .map(
      (entry) =>
        `${entry.count} ${ZONE_META[entry.zone].label.toLocaleLowerCase("tr")} ağırlıklı`,
    )
    .join(", ");
  return `${subject} ${row.silentCount} hikâyeye yer vermedi (${parts})`;
}

export function silenceFootnote(windowTotal: number): string {
  return `Bu sayfadaki kör noktalardan son 24 saatte güncellenen ${windowTotal} hikâye sayıldı. Bir bölgeden izlediğimiz hiçbir kaynak haberi yapmadıysa “yer vermedi” sayılır; bir hikâye birden fazla satırda sayılabilir.`;
}
