import { describe, it, expect } from "vitest";
import {
  BIAS_LABELS,
  BIAS_SHORT_LABELS,
  BIAS_COLORS,
  BIAS_ORDER,
  BIAS_TO_ZONE,
  BLINDSPOT,
  SURPRISE,
  tallyZones,
  ZONE_META,
  zoneOf,
} from "./config";
import {
  BIAS_KEYS,
  BIAS_TO_ZONE as CONTRACT_BIAS_TO_ZONE,
  BLINDSPOT as CONTRACT_BLINDSPOT,
  SURPRISE as CONTRACT_SURPRISE,
  tallyZones as contractTallyZones,
} from "../../../supabase/functions/_shared/cluster/blindspot";
import type { BiasCategory, MediaDnaZone } from "@/types";

const ALL_BIASES: BiasCategory[] = [
  "pro_government",
  "gov_leaning",
  "state_media",
  "center",
  "opposition_leaning",
  "opposition",
  "nationalist",
  "islamist_conservative",
  "pro_kurdish",
  "international",
];

const ALL_ZONES: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

describe("BIAS_LABELS", () => {
  it("has a Turkish label for every BiasCategory", () => {
    for (const bias of ALL_BIASES) {
      expect(BIAS_LABELS[bias]).toBeTruthy();
      expect(typeof BIAS_LABELS[bias]).toBe("string");
    }
  });

  it("has no duplicate labels", () => {
    const values = Object.values(BIAS_LABELS);
    expect(new Set(values).size).toBe(values.length);
  });

  it("uses the known canonical labels for a few anchor entries", () => {
    expect(BIAS_LABELS.pro_government).toBe("Hükümete Yakın");
    expect(BIAS_LABELS.center).toBe("Bağımsız");
    expect(BIAS_LABELS.opposition).toBe("Muhalefet");
    expect(BIAS_LABELS.nationalist).toBe("Milliyetçi");
  });
});

describe("BIAS_SHORT_LABELS", () => {
  it("covers every BiasCategory", () => {
    for (const bias of ALL_BIASES) {
      expect(BIAS_SHORT_LABELS[bias]).toBeTruthy();
    }
  });

  it("abbreviates islamist_conservative", () => {
    expect(BIAS_SHORT_LABELS.islamist_conservative).toBe("İslamcı/Muh.");
    // and this is indeed shorter than the full label
    expect(
      BIAS_SHORT_LABELS.islamist_conservative.length
    ).toBeLessThan(BIAS_LABELS.islamist_conservative.length);
  });

  it("matches the full label for most entries (only islamist shortened)", () => {
    for (const bias of ALL_BIASES) {
      if (bias === "islamist_conservative") continue;
      expect(BIAS_SHORT_LABELS[bias]).toBe(BIAS_LABELS[bias]);
    }
  });
});

describe("BIAS_COLORS", () => {
  it("has a BiasColor entry for every BiasCategory", () => {
    for (const bias of ALL_BIASES) {
      const color = BIAS_COLORS[bias];
      expect(color).toBeDefined();
      expect(color.solid).toBeTruthy();
      expect(color.dot).toBeTruthy();
      expect(color.chipBg).toBeTruthy();
      expect(color.chipText).toBeTruthy();
      expect(color.chipBorder).toBeTruthy();
      expect(color.className).toBeTruthy();
    }
  });

  it("className is the pre-combined chip classes", () => {
    for (const bias of ALL_BIASES) {
      const c = BIAS_COLORS[bias];
      expect(c.className).toBe(`${c.chipBg} ${c.chipText} ${c.chipBorder}`);
    }
  });

  it("uses bg-* classes for solid and dot tokens", () => {
    for (const bias of ALL_BIASES) {
      const c = BIAS_COLORS[bias];
      expect(c.solid).toMatch(/^bg-/);
      expect(c.dot).toMatch(/^bg-/);
    }
  });
});

describe("BIAS_ORDER", () => {
  it("lists every BiasCategory exactly once", () => {
    expect(BIAS_ORDER.slice().sort()).toEqual(ALL_BIASES.slice().sort());
    expect(BIAS_ORDER.length).toBe(ALL_BIASES.length);
  });

  it("starts with iktidar-aligned biases and ends with muhalefet-aligned", () => {
    // Based on the grouping comment in config.ts.
    expect(zoneOf(BIAS_ORDER[0])).toBe("iktidar");
    expect(zoneOf(BIAS_ORDER[BIAS_ORDER.length - 1])).toBe("iktidar");
    // Second-to-last is opposition (muhalefet) — "nationalist" is last since
    // it was moved into iktidar per A6. Check that muhalefet actually appears.
    const zones = BIAS_ORDER.map(zoneOf);
    expect(zones).toContain("muhalefet");
    expect(zones).toContain("bagimsiz");
  });
});

describe("BIAS_TO_ZONE / zoneOf", () => {
  it("maps every BiasCategory to one of the three zones", () => {
    for (const bias of ALL_BIASES) {
      const zone = BIAS_TO_ZONE[bias];
      expect(ALL_ZONES).toContain(zone);
      expect(zoneOf(bias)).toBe(zone);
    }
  });

  it("places nationalist in iktidar per the A6 finding", () => {
    expect(BIAS_TO_ZONE.nationalist).toBe("iktidar");
    expect(zoneOf("nationalist")).toBe("iktidar");
  });

  it("places opposition and opposition_leaning in muhalefet", () => {
    expect(zoneOf("opposition")).toBe("muhalefet");
    expect(zoneOf("opposition_leaning")).toBe("muhalefet");
  });

  it("places center, international, pro_kurdish in bagimsiz", () => {
    expect(zoneOf("center")).toBe("bagimsiz");
    expect(zoneOf("international")).toBe("bagimsiz");
    expect(zoneOf("pro_kurdish")).toBe("bagimsiz");
  });

  it("places pro_government, gov_leaning, state_media, islamist_conservative in iktidar", () => {
    expect(zoneOf("pro_government")).toBe("iktidar");
    expect(zoneOf("gov_leaning")).toBe("iktidar");
    expect(zoneOf("state_media")).toBe("iktidar");
    expect(zoneOf("islamist_conservative")).toBe("iktidar");
  });
});

describe("contract re-exports (supabase/functions/_shared/cluster/blindspot.ts)", () => {
  it("BIAS_TO_ZONE is the SAME object as the contract's export, not a copy", () => {
    expect(BIAS_TO_ZONE).toBe(CONTRACT_BIAS_TO_ZONE);
  });

  it("BLINDSPOT re-export equals the contract's", () => {
    expect(BLINDSPOT).toBe(CONTRACT_BLINDSPOT);
    expect(BLINDSPOT).toEqual(CONTRACT_BLINDSPOT);
  });

  it("SURPRISE re-export equals the contract's", () => {
    expect(SURPRISE).toBe(CONTRACT_SURPRISE);
    expect(SURPRISE).toEqual(CONTRACT_SURPRISE);
  });

  it("tallyZones re-export is the contract's function", () => {
    expect(tallyZones).toBe(contractTallyZones);
  });

  it("every BiasCategory in src/types is a contract BIAS_KEY and vice-versa", () => {
    // Guards the `satisfies Record<BiasCategory, MediaDnaZone>` assertion in
    // config.ts: if either union grows or shrinks without updating the
    // other, this fails loudly instead of the `satisfies` silently
    // widening one side.
    const appKeys = ALL_BIASES.slice().sort();
    const contractKeys = (BIAS_KEYS as readonly string[]).slice().sort();
    expect(appKeys).toEqual(contractKeys);
  });
});

describe("ZONE_META", () => {
  it("has an entry for each zone", () => {
    for (const zone of ALL_ZONES) {
      expect(ZONE_META[zone]).toBeDefined();
    }
  });

  it("each entry has the required presentation tokens", () => {
    for (const zone of ALL_ZONES) {
      const meta = ZONE_META[zone];
      expect(meta.label).toBeTruthy();
      expect(meta.description).toBeTruthy();
      expect(meta.dot).toMatch(/^bg-/);
      expect(meta.chipBg).toBeTruthy();
      expect(meta.chipHover).toMatch(/^hover:bg-/);
      expect(meta.chipText).toBeTruthy();
      expect(meta.chipBorder).toBeTruthy();
      expect(meta.zoneBg).toBeTruthy();
      expect(meta.zoneBorder).toBeTruthy();
      expect(meta.zoneLabel).toBeTruthy();
    }
  });

  it("uses the expected Turkish labels", () => {
    expect(ZONE_META.iktidar.label).toBe("İktidar");
    expect(ZONE_META.bagimsiz.label).toBe("Bağımsız");
    expect(ZONE_META.muhalefet.label).toBe("Muhalefet");
  });
});
