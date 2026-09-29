import { describe, it, expect } from "vitest";

import {
  SILENT_MIN_AGE_H,
  SILENT_MIN_SOURCES,
  buildAlertRss,
  oneZoneSilentOf,
  toV1AlertRecord,
  type AlertItem,
} from "@/lib/alerts/alert-feed";
import { BLINDSPOT } from "@/lib/bias/config";

const ID = "11111111-2222-3333-4444-555555555555";

function item(overrides: Partial<AlertItem> = {}): AlertItem {
  return {
    type: "blindspot",
    clusterId: ID,
    title: "Başlık & <özet>",
    firstPublished: "2026-09-27T08:00:00.000Z",
    updatedAt: "2026-09-28T12:00:00.000Z",
    sourceCount: 6,
    zoneCounts: { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
    dominantZone: "iktidar",
    silentZones: ["muhalefet"],
    ...overrides,
  };
}

describe("constants", () => {
  it("SILENT_MIN_SOURCES tracks the blindspot contract", () => {
    expect(SILENT_MIN_SOURCES).toBe(BLINDSPOT.minSources);
    expect(SILENT_MIN_AGE_H).toBe(6);
  });
});

describe("oneZoneSilentOf", () => {
  it("finds the single silent zone (muhalefet)", () => {
    const r = oneZoneSilentOf({ pro_government: 3, center: 2 });
    expect(r).toEqual({
      silentZone: "muhalefet",
      total: 5,
      counts: { iktidar: 3, bagimsiz: 2, muhalefet: 0 },
    });
  });

  it("finds a silent iktidar zone", () => {
    const r = oneZoneSilentOf({ center: 3, opposition: 2 });
    expect(r?.silentZone).toBe("iktidar");
  });

  it("returns null below the 5-source floor (4 sources)", () => {
    expect(oneZoneSilentOf({ pro_government: 2, center: 2 })).toBeNull();
  });

  it("returns null when two zones are silent (that is a blindspot, not one-zone-silent)", () => {
    expect(oneZoneSilentOf({ pro_government: 6 })).toBeNull();
  });

  it("returns null when no zone is silent", () => {
    expect(oneZoneSilentOf({ pro_government: 2, center: 2, opposition: 2 })).toBeNull();
  });

  it.each([null, undefined, "x", 5, [], { pro_government: "5", center: NaN }, {}])(
    "returns null for malformed jsonb %#",
    (bad) => {
      expect(oneZoneSilentOf(bad)).toBeNull();
    },
  );

  it("ignores unknown keys and negative counts", () => {
    expect(
      oneZoneSilentOf({ pro_government: 3, center: 2, bogus: 50, opposition: -4 }),
    ).toMatchObject({ silentZone: "muhalefet", total: 5 });
  });
});

describe("toV1AlertRecord", () => {
  it("maps the fields and builds a typed id and cluster url", () => {
    const rec = toV1AlertRecord(item());
    expect(rec).toEqual({
      id: `blindspot:${ID}`,
      type: "blindspot",
      cluster_id: ID,
      title: "Başlık & <özet>",
      url: expect.stringMatching(new RegExp(`/cluster/${ID}$`)),
      first_published: "2026-09-27T08:00:00.000Z",
      updated_at: "2026-09-28T12:00:00.000Z",
      source_count: 6,
      zone_counts: { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
      dominant_zone: "iktidar",
      silent_zones: ["muhalefet"],
    });
  });

  it("silent alerts carry dominant_zone null", () => {
    const rec = toV1AlertRecord(item({ type: "one_zone_silent", dominantZone: null }));
    expect(rec.id).toBe(`one_zone_silent:${ID}`);
    expect(rec.dominant_zone).toBeNull();
  });
});

describe("buildAlertRss", () => {
  const base = "https://tayf.test";
  const blind = toV1AlertRecord(item({ title: "Bir & iki" }));
  const silent = toV1AlertRecord(
    item({
      type: "one_zone_silent",
      dominantZone: null,
      clusterId: "aaaaaaaa-2222-3333-4444-555555555555",
      zoneCounts: { iktidar: 3, bagimsiz: 2, muhalefet: 0 },
      sourceCount: 5,
      silentZones: ["muhalefet"],
    }),
  );
  const xml = buildAlertRss([blind, silent], base);

  it("uses the channel title, link and self url", () => {
    expect(xml).toContain("<title>Tayf — Kör nokta ve sessiz bölge uyarıları</title>");
    expect(xml).toContain(`<link>${base}/blindspots</link>`);
    expect(xml).toContain(`href="${base}/api/v1/alerts/blindspots?format=rss"`);
  });

  it("titles items per type", () => {
    expect(xml).toContain("Kör nokta · İktidar ağırlıklı: Bir &amp; iki");
    expect(xml).toMatch(/Sessiz bölge · Muhalefet: /);
  });

  it("describes counts and the per-type sentence", () => {
    expect(xml).toContain("6 kaynak · İktidar 5 · Bağımsız 1 · Muhalefet 0.");
    expect(xml).toContain("Kaynakların en az %80&apos;i İktidar bölgesinden.");
    expect(xml).toContain(
      "Tayf, Muhalefet bölgesindeki kaynaklardan bu kümeye eşleşen haber bulamadı.",
    );
  });

  it("guid is the bare cluster url; link carries UTM", () => {
    expect(xml).toContain(`<guid isPermaLink="true">${blind.url}</guid>`);
    expect(xml).toContain("utm_source=api");
    expect(xml).toContain("utm_medium=alerts");
    expect(xml).toContain("utm_campaign=alerts");
  });

  it("never uses accusatory silence wording", () => {
    expect(xml).not.toMatch(/yazmadı|görmezden/i);
  });

  it("renders an empty channel for no alerts", () => {
    const empty = buildAlertRss([], base);
    expect(empty).not.toContain("<item>");
    expect(empty).toContain("<channel>");
  });
});
