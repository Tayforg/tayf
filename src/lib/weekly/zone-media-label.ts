import type { MediaDnaZone } from "@/types";

// Reader-facing zone names for /hafta's "Aynı hafta, farklı kelimeler" block.
//
// One literal string per zone, never ZONE_META[zone].label plus a suffix: the
// label is a noun for "İktidar" and "Muhalefet" ("İktidar medyası") but an
// adjective for "Bağımsız" ("Bağımsız medya", not "Bağımsız medyası"). Pure: no
// imports beyond a type, no Date, no IO.

/** The zone as a heading: "İktidar medyası", "Bağımsız medya", "Muhalefet medyası". */
export const ZONE_MEDIA_HEADING: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar medyası",
  bagimsiz: "Bağımsız medya",
  muhalefet: "Muhalefet medyası",
};

/** The zone in the locative ("in the ... media"): "İktidar medyasında", "Bağımsız medyada", "Muhalefet medyasında". */
export const ZONE_MEDIA_LOCATIVE: Readonly<Record<MediaDnaZone, string>> = {
  iktidar: "İktidar medyasında",
  bagimsiz: "Bağımsız medyada",
  muhalefet: "Muhalefet medyasında",
};
