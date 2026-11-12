import type { MediaDnaZone } from "@/types";

// Reader-facing zone phrases that need a suffix: "bölgesine", "kanadı",
// "kaynakları" and their case forms.
//
// The zone name is a noun for "İktidar" and "Muhalefet" ("İktidar bölgesine",
// "İktidar kanadı", "İktidar kaynakları") but an adjective for "Bağımsız": it
// stays in front of the noun and takes no possessive ("Bağımsız bölgeye",
// "Bağımsız kanat", "Bağımsız kaynaklar"). So a label is never glued to a
// suffix; each zone names the whole phrase. Same rule as h79-locale-1
// (PR 241), src/lib/weekly/zone-media-label.ts and src/lib/diet/zone-copy.ts;
// /metodoloji already writes "Bağımsız bölgenin".
//
// The phrases are literals, not ZONE_META labels plus a suffix, so a new call
// site cannot bring "Bağımsız bölgesine" back; zone-phrases.test.ts pins every
// string and scans src for the glued shape. Pure: no Date, no IO, and only a
// type import.

/** "İktidar bölgesine", "Bağımsız bölgeye", "Muhalefet bölgesine". */
export const ZONE_BOLGE_DATIVE: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar bölgesine",
  bagimsiz: "Bağımsız bölgeye",
  muhalefet: "Muhalefet bölgesine",
};

/** "İktidar bölgesinden", "Bağımsız bölgeden", "Muhalefet bölgesinden". */
export const ZONE_BOLGE_ABLATIVE: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar bölgesinden",
  bagimsiz: "Bağımsız bölgeden",
  muhalefet: "Muhalefet bölgesinden",
};

/** "İktidar bölgesindeki", "Bağımsız bölgedeki", "Muhalefet bölgesindeki". */
export const ZONE_BOLGE_LOCATIVE_ATTR: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar bölgesindeki",
  bagimsiz: "Bağımsız bölgedeki",
  muhalefet: "Muhalefet bölgesindeki",
};

/** "İktidar kanadı", "Bağımsız kanat", "Muhalefet kanadı". */
export const ZONE_KANAT: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar kanadı",
  bagimsiz: "Bağımsız kanat",
  muhalefet: "Muhalefet kanadı",
};

/** "İktidar kanadının", "Bağımsız kanadın", "Muhalefet kanadının". */
export const ZONE_KANAT_GENITIVE: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar kanadının",
  bagimsiz: "Bağımsız kanadın",
  muhalefet: "Muhalefet kanadının",
};

/** "İktidar kaynakları", "Bağımsız kaynaklar", "Muhalefet kaynakları". */
export const ZONE_KAYNAKLAR: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar kaynakları",
  bagimsiz: "Bağımsız kaynaklar",
  muhalefet: "Muhalefet kaynakları",
};
