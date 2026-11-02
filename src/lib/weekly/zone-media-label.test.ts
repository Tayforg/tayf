import { describe, expect, it } from "vitest";

import { ZONE_META } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

import { ZONE_MEDIA_HEADING, ZONE_MEDIA_LOCATIVE } from "./zone-media-label";

// h19-copy-1 (hunt 19, 2026-11-02): /hafta built the zone heading as
// `${label} medyası`, which is right for the nouns "İktidar" and "Muhalefet"
// but wrong for the adjective "Bağımsız" ("Bağımsız medyası"). The copy is now
// one literal string per zone, never a label plus a suffix.

describe("ZONE_MEDIA_HEADING", () => {
  it("has the three exact headings", () => {
    expect(ZONE_MEDIA_HEADING.iktidar).toBe("İktidar medyası");
    expect(ZONE_MEDIA_HEADING.bagimsiz).toBe("Bağımsız medya");
    expect(ZONE_MEDIA_HEADING.muhalefet).toBe("Muhalefet medyası");
  });
});

describe("ZONE_MEDIA_LOCATIVE", () => {
  it("has the three exact locative forms", () => {
    expect(ZONE_MEDIA_LOCATIVE.iktidar).toBe("İktidar medyasında");
    expect(ZONE_MEDIA_LOCATIVE.bagimsiz).toBe("Bağımsız medyada");
    expect(ZONE_MEDIA_LOCATIVE.muhalefet).toBe("Muhalefet medyasında");
  });
});

describe("zone media labels vs ZONE_META", () => {
  const zones = Object.keys(ZONE_META).sort();

  it("both maps cover exactly the zones ZONE_META defines", () => {
    expect(Object.keys(ZONE_MEDIA_HEADING).sort()).toEqual(zones);
    expect(Object.keys(ZONE_MEDIA_LOCATIVE).sort()).toEqual(zones);
  });

  it("every string starts with the zone's own label, so the two cannot drift apart", () => {
    for (const zone of Object.keys(ZONE_META) as MediaDnaZone[]) {
      expect(ZONE_MEDIA_HEADING[zone].startsWith(ZONE_META[zone].label), zone).toBe(true);
      expect(ZONE_MEDIA_LOCATIVE[zone].startsWith(ZONE_META[zone].label), zone).toBe(true);
    }
  });

  it("no value is the ungrammatical 'Bağımsız medyas...'", () => {
    for (const value of [...Object.values(ZONE_MEDIA_HEADING), ...Object.values(ZONE_MEDIA_LOCATIVE)]) {
      expect(value).not.toMatch(/Bağımsız medyas/);
    }
  });

  it("every value is trimmed, single-spaced and non-empty", () => {
    for (const value of [...Object.values(ZONE_MEDIA_HEADING), ...Object.values(ZONE_MEDIA_LOCATIVE)]) {
      expect(value).toBe(value.trim());
      expect(value.includes("  ")).toBe(false);
      expect(value.length).toBeGreaterThan(0);
    }
  });

  it("never says 'bu hafta' (/hafta is a trailing 7-day window)", () => {
    for (const value of [...Object.values(ZONE_MEDIA_HEADING), ...Object.values(ZONE_MEDIA_LOCATIVE)]) {
      expect(value.toLocaleLowerCase("tr-TR").includes("bu hafta")).toBe(false);
    }
  });
});
