import { tallyZones, zoneOf } from "@/lib/bias/config";
import { zoneCountsOf, zonePercents } from "@/lib/bias/zone-summary";
import type { BiasCategory, BiasDistribution, MediaDnaZone } from "@/types";

// Lowercase Turkish zone labels for share text. `ZONE_META` labels
// ("İktidar", "Bağımsız", "Muhalefet" in src/lib/bias/config.ts) are
// capitalized for UI chips; hardcoding the lowercase forms here avoids
// depending on `toLocaleLowerCase("tr")` (dotted/dotless İ/I handling)
// for what is only a 3-entry table.
const ZONE_LABEL_LOWER: Record<MediaDnaZone, string> = {
  iktidar: "iktidar",
  bagimsiz: "bağımsız",
  muhalefet: "muhalefet",
};

/**
 * Builds the text handed to `navigator.share` / the clipboard fallback
 * (see `ShareButton`) so a shared cluster link argues the bias story
 * before the click. Turkish percent formatting puts the sign first
 * ("%70"), so this is plain string interpolation, not
 * `Intl.NumberFormat`.
 *
 * e.g. "12 kaynak · %70 iktidar · %20 bağımsız · %10 muhalefet", plus
 * " · Kör nokta: sadece iktidar yazdı" when the cluster is a blindspot.
 */
export function buildShareText(input: {
  articleCount: number;
  distribution: BiasDistribution;
  isBlindspot: boolean;
  blindspotSide: BiasCategory | null;
}): string {
  const { articleCount, distribution, isBlindspot, blindspotSide } = input;
  const counts = zoneCountsOf(distribution);
  const percents = zonePercents(counts);

  let text = [
    `${articleCount} kaynak`,
    `%${percents.iktidar} iktidar`,
    `%${percents.bagimsiz} bağımsız`,
    `%${percents.muhalefet} muhalefet`,
  ].join(" · ");

  if (isBlindspot) {
    // Same "no reported side → fall back to the tallied dominant zone"
    // rule as the OG card's ribbon (opengraph-image.tsx). The DB flag now
    // fires at >= BLINDSPOT.dominantShare (80%), so "sadece {zone} yazdı"
    // only holds at an exact 100% share.
    const tally = tallyZones(distribution);
    const zone = blindspotSide ? zoneOf(blindspotSide) : (tally.dominantZone ?? "iktidar");
    const share = Math.round(tally.dominantShare * 100);
    text +=
      share === 100
        ? ` · Kör nokta: sadece ${ZONE_LABEL_LOWER[zone]} yazdı`
        : ` · Kör nokta: ${ZONE_LABEL_LOWER[zone]} ağırlıklı`;
  }

  return text;
}
