import { ZONE_META } from "@/lib/bias/config";
import type { BlindspotBundle } from "@/lib/clusters/blindspots-query";
import type { MediaDnaZone } from "@/types";

// "Bu listede kim yer vermedi?" band on /blindspots. Pure derivation over the
// bundles BlindspotsFeed already loaded: no query, no clock, no I/O.
//
// WINDOW: every distinct bundle on the page. /blindspots only lists clusters
// whose first_published is older than BLINDSPOT.feedDelayHours (24 h), so a
// "last 24 hours" cut on updated_at left the band with 0-1 stories almost
// always. The page itself is the window.
//
// SILENCE: judged on the VOTING tally (BlindspotBundle.votingZoneCounts, the
// one dominantZone / dominantPct are built from), never on bundle.sources,
// which also lists non-voting aggregator and niche outlets. Counting those
// let a single aggregator in a pole zone mask a "%100 tek tarafta" card.

export const ZONE_ROW_ORDER: readonly MediaDnaZone[] = [
  "iktidar",
  "bagimsiz",
  "muhalefet",
];

export interface SilenceRow {
  zone: MediaDnaZone;
  /** Page stories on which this zone had no voting source at all. */
  silentCount: number;
  /** Non-zero breakdown of those stories by dominant zone, in ZONE_ROW_ORDER. */
  byDominant: Array<{ zone: MediaDnaZone; count: number }>;
}

export interface SilenceDigest {
  /** De-duplicated page stories the rows were computed from. */
  windowTotal: number;
  /** Always exactly three rows, in ZONE_ROW_ORDER. */
  rows: SilenceRow[];
}

type DigestBundle = Pick<
  BlindspotBundle,
  "cluster" | "dominantZone" | "votingZoneCounts"
>;

function emptyZoneTally(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

/**
 * For each zone Y, counts the page's blindspot stories on which Y was silent:
 * Y is not the bundle's dominant zone AND `votingZoneCounts[Y] === 0`. Strict
 * zero: a single voting source from the zone means it is not silent.
 * Non-voting kinds are never counted, matching how the blindspot itself is
 * computed. Bundles are de-duplicated by cluster id (first occurrence wins);
 * one story can count in two rows.
 */
export function buildSilenceDigest(
  bundles: ReadonlyArray<DigestBundle>,
): SilenceDigest {
  const seen = new Set<string>();

  // silent[zone][dominant] = stories where `zone` was silent and `dominant` led.
  const silent: Record<MediaDnaZone, Record<MediaDnaZone, number>> = {
    iktidar: emptyZoneTally(),
    bagimsiz: emptyZoneTally(),
    muhalefet: emptyZoneTally(),
  };
  let windowTotal = 0;

  for (const bundle of bundles) {
    if (seen.has(bundle.cluster.id)) continue;
    seen.add(bundle.cluster.id);
    windowTotal += 1;

    for (const zone of ZONE_ROW_ORDER) {
      if (zone !== bundle.dominantZone && bundle.votingZoneCounts[zone] === 0) {
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

export function silenceFootnote(storyCount: number): string {
  return `Bu sayfadaki ${storyCount} kör nokta hikâyesi sayıldı. Bir bölgedeki gazete, TV ve ajanslardan hiçbiri haberi yapmadıysa “yer vermedi” sayılır (toplayıcı ve niş siteler, kör nokta hesabında olduğu gibi, sayılmaz); bir hikâye birden fazla satırda sayılabilir.`;
}
