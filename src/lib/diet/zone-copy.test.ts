import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { ZONE_META } from "@/lib/bias/config";
import { DIET_ZONES } from "@/lib/diet/diet";

import { ZONE_SOURCES_GENITIVE, zoneNewsCount } from "./zone-copy";

// h79-locale-1: the /diyetim least-read nudge built "{label} kaynaklarının" and
// "{n} {label} haberi" from ZONE_META[zone].label. That is right for the nouns
// "İktidar" and "Muhalefet" but wrong for the adjective "Bağımsız": the zone
// name stays an adjective before a noun ("Bağımsız kaynakların ağırlıkta",
// "3 Bağımsız haber"), it never takes a possessive suffix ("Bağımsız
// kaynaklarının", "Bağımsız haberi"). Same rule as src/lib/weekly/zone-media-label.ts.

describe("ZONE_SOURCES_GENITIVE", () => {
  it("has exactly one entry per diet zone", () => {
    expect(Object.keys(ZONE_SOURCES_GENITIVE).sort()).toEqual([...DIET_ZONES].sort());
  });

  it("pins the three exact genitive forms", () => {
    expect(ZONE_SOURCES_GENITIVE.iktidar).toBe("İktidar kaynaklarının");
    expect(ZONE_SOURCES_GENITIVE.bagimsiz).toBe("Bağımsız kaynakların");
    expect(ZONE_SOURCES_GENITIVE.muhalefet).toBe("Muhalefet kaynaklarının");
  });

  it("never glues the possessive onto the adjective 'Bağımsız'", () => {
    for (const zone of DIET_ZONES) {
      expect(ZONE_SOURCES_GENITIVE[zone]).not.toContain("Bağımsız kaynaklarının");
    }
  });

  it("starts with the ZONE_META label so no zone name is hard-coded twice", () => {
    for (const zone of DIET_ZONES) {
      expect(ZONE_SOURCES_GENITIVE[zone].startsWith(`${ZONE_META[zone].label} `)).toBe(true);
    }
  });
});

describe("zoneNewsCount", () => {
  it("pins the exact phrase for each zone", () => {
    expect(zoneNewsCount(3, "iktidar")).toBe("3 İktidar haberi");
    expect(zoneNewsCount(3, "bagimsiz")).toBe("3 Bağımsız haber");
    expect(zoneNewsCount(3, "muhalefet")).toBe("3 Muhalefet haberi");
  });

  it("keeps the same form for other counts (1, 12, 0)", () => {
    expect(zoneNewsCount(1, "bagimsiz")).toBe("1 Bağımsız haber");
    expect(zoneNewsCount(12, "bagimsiz")).toBe("12 Bağımsız haber");
    expect(zoneNewsCount(1, "iktidar")).toBe("1 İktidar haberi");
    expect(zoneNewsCount(12, "muhalefet")).toBe("12 Muhalefet haberi");
    expect(zoneNewsCount(0, "bagimsiz")).toBe("0 Bağımsız haber");
  });

  it("never renders 'Bağımsız haberi' for any count", () => {
    for (const n of [0, 1, 2, 3, 10, 99]) {
      expect(zoneNewsCount(n, "bagimsiz")).not.toContain("Bağımsız haberi");
    }
  });

  it("starts with the count and the ZONE_META label for every zone", () => {
    for (const zone of DIET_ZONES) {
      expect(zoneNewsCount(4, zone).startsWith(`4 ${ZONE_META[zone].label} haber`)).toBe(true);
    }
  });
});

describe("zone-copy.ts source", () => {
  const src = readFileSync(join(__dirname, "zone-copy.ts"), "utf8");

  it("points at the rule in zone-media-label.ts", () => {
    expect(src).toContain("src/lib/weekly/zone-media-label.ts");
  });

  it("stays free of the class-merging stack", () => {
    expect(src).not.toContain("@/lib/utils");
    expect(src).not.toContain("tailwind-merge");
  });
});
