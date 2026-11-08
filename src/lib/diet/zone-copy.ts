import { ZONE_META } from "@/lib/bias/config";
import type { DietZone } from "@/lib/diet/diet";

// Reader-facing zone phrases for the /diyetim least-read nudge.
//
// The zone name is a noun for "İktidar" and "Muhalefet" ("İktidar haberi",
// "İktidar kaynaklarının") but an adjective for "Bağımsız": it stays in front of
// the noun and takes no possessive ("3 Bağımsız haber", "Bağımsız kaynakların").
// So the label is never glued to a suffix; each zone names the whole noun phrase
// that follows it. Same rule as src/lib/weekly/zone-media-label.ts. The labels
// still come from ZONE_META, so no zone name is hard-coded here. Pure: no Date,
// no IO, and nothing heavier than the config the nudge already imports.

const SOURCES_GENITIVE: Readonly<Record<DietZone, string>> = {
  iktidar: "kaynaklarının",
  bagimsiz: "kaynakların",
  muhalefet: "kaynaklarının",
};

const NEWS_NOUN: Readonly<Record<DietZone, string>> = {
  iktidar: "haberi",
  bagimsiz: "haber",
  muhalefet: "haberi",
};

/** "İktidar kaynaklarının", "Bağımsız kaynakların", "Muhalefet kaynaklarının". */
export const ZONE_SOURCES_GENITIVE: Readonly<Record<DietZone, string>> = {
  iktidar: `${ZONE_META.iktidar.label} ${SOURCES_GENITIVE.iktidar}`,
  bagimsiz: `${ZONE_META.bagimsiz.label} ${SOURCES_GENITIVE.bagimsiz}`,
  muhalefet: `${ZONE_META.muhalefet.label} ${SOURCES_GENITIVE.muhalefet}`,
};

/** "3 İktidar haberi", "3 Bağımsız haber", "3 Muhalefet haberi". */
export function zoneNewsCount(n: number, zone: DietZone): string {
  return `${n} ${ZONE_META[zone].label} ${NEWS_NOUN[zone]}`;
}
