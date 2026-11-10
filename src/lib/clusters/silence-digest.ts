import { ZONE_META } from "@/lib/bias/config";
import type { BlindspotBundle } from "@/lib/clusters/blindspots-query";
import { formatCountTr } from "@/lib/format/number-tr";
import type { MediaDnaZone } from "@/types";

// "Bu listede kim yer vermedi?" band on /blindspots. Pure derivation over the
// claims the fetcher already loaded: no query, no clock, no I/O.
//
// WINDOW: every distinct claim handed in. /blindspots only lists clusters
// whose first_published is older than BLINDSPOT.feedDelayHours (24 h), so a
// "last 24 hours" cut on updated_at left the band with 0-1 stories almost
// always. The list itself is the window.
//
// h53-consistency-1: the list is the trailing 7 days, of which only the 30
// side-balanced claims get a full card and the rest are compact rows. The band
// counts ALL of them (the fetcher passes every claim), so it never disagrees
// with what the page lists; `SilenceDigest.scope` lets the footnote say so.
//
// SILENCE: judged on the VOTING tally (BlindspotBundle.votingZoneCounts, the
// one dominantZone / dominantPct are built from), never on bundle.sources,
// which also lists non-voting aggregator and niche outlets. Counting those
// let a single aggregator in a pole zone mask a "%100 tek tarafta" card.
//
// RECALL (h106-blindspotbadges-1): a zone the site's own Jev recall stage matched
// with the same event (BlindspotBundle.recallMatchedZones, from
// clusters.blindspot_recall_suspect) is not counted as having given no coverage
// on THAT claim: the story may sit in another cluster. The claim itself stays in
// windowTotal and in every other row. A caller that passes no such field (the
// weekly template, /hafta) is counted exactly as before.

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

/** What the counted stories span and how many of them are full cards. */
export interface SilenceScope {
  /** Length of the trailing window the stories were taken from, in days. */
  windowDays: number;
  /** How many of the counted stories are shown as full cards. */
  shown: number;
}

export interface SilenceDigest {
  /** De-duplicated stories the rows were computed from. */
  windowTotal: number;
  /** Always exactly three rows, in ZONE_ROW_ORDER. */
  rows: SilenceRow[];
  /**
   * Set by the /blindspots fetcher, which counts a whole window but shows only
   * part of it as cards; absent for any other caller (the footnote then says
   * "Bu sayfadaki").
   */
  scope?: SilenceScope;
}

type DigestBundle = Pick<
  BlindspotBundle,
  "cluster" | "dominantZone" | "votingZoneCounts"
> & {
  /**
   * Zones Jev matched with the same event (h106-blindspotbadges-1). Optional on
   * purpose: a bundle without it is counted as it always was.
   */
  recallMatchedZones?: readonly MediaDnaZone[];
};

function emptyZoneTally(): Record<MediaDnaZone, number> {
  return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
}

/**
 * For each zone Y, counts the page's blindspot stories on which Y was silent:
 * Y is not the bundle's dominant zone AND `votingZoneCounts[Y] === 0`. Strict
 * zero: a single voting source from the zone means it is not silent.
 * Non-voting kinds are never counted, matching how the blindspot itself is
 * computed. A zone listed in the bundle's `recallMatchedZones` is skipped for
 * that bundle only (see the RECALL note above); `windowTotal` is unchanged.
 * Bundles are de-duplicated by cluster id (first occurrence wins); one story can
 * count in two rows.
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
      if (
        zone !== bundle.dominantZone &&
        bundle.votingZoneCounts[zone] === 0 &&
        !bundle.recallMatchedZones?.includes(zone)
      ) {
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

const SILENCE_RULE =
  "Bir bölgedeki gazete, TV ve ajanslardan hiçbiri haberi yapmadıysa “yer vermedi” sayılır (toplayıcı ve niş siteler, kör nokta hesabında olduğu gibi, sayılmaz); bir hikâye birden fazla satırda sayılabilir.";

/**
 * The band's footnote. Without a scope it counts "the page" (any caller that
 * hands in exactly what it lists); with one it names the window and how many of
 * the counted stories are full cards, the rest being compact rows.
 */
export function silenceFootnote(
  storyCount: number,
  scope?: SilenceScope,
): string {
  if (!scope) {
    return `Bu sayfadaki ${storyCount} kör nokta hikâyesi sayıldı. ${SILENCE_RULE}`;
  }
  const counted = `Son ${scope.windowDays} günün ${storyCount} kör nokta hikâyesi sayıldı`;
  const cards =
    scope.shown < storyCount
      ? `; listede ${scope.shown} tanesi kart olarak gösteriliyor`
      : "";
  return `${counted}${cards}. ${SILENCE_RULE}`;
}

/**
 * The count line above the /blindspots list:
 *
 *   "Son 7 günde 46 kör nokta · İktidar ağırlıklı 38 · Muhalefet ağırlıklı 8"
 *
 * `sideCounts` tallies each claim under the side that WROTE it (the dominant
 * zone), so the line names that side with "ağırlıklı", the word the band rows
 * below it use ("8 muhalefet ağırlıklı"). "İktidar tarafında 38" counted the
 * same stories but read as the government side's own blind spot, the opposite
 * of what is counted (h72-newreader-1; tests/guards/kor-nokta-side-wording).
 * The word order also keeps Turkish case suffixes off the numbers.
 *
 * İktidar and Muhalefet are always named (a "Muhalefet ağırlıklı 0" is a
 * finding); Bağımsız only when it is above zero. Same side wording as the
 * weekly page's tally line (week-copy.ts). `null` when there is no claim, so
 * the empty state speaks instead.
 */
export function blindspotCountLine(
  claimCount: number,
  sideCounts: Record<MediaDnaZone, number>,
  windowDays: number,
): string | null {
  if (!(claimCount > 0)) return null;
  const parts = [
    `Son ${windowDays} günde ${formatCountTr(claimCount)} kör nokta`,
    `İktidar ağırlıklı ${formatCountTr(sideCounts.iktidar)}`,
    `Muhalefet ağırlıklı ${formatCountTr(sideCounts.muhalefet)}`,
  ];
  if (sideCounts.bagimsiz > 0) {
    parts.push(`Bağımsız ağırlıklı ${formatCountTr(sideCounts.bagimsiz)}`);
  }
  return parts.join(" · ");
}
