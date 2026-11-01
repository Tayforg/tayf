import { describe, it, expect } from "vitest";

import {
  SILENT_MIN_AGE_H,
  SILENT_MIN_SOURCES,
  alertAtOf,
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
    alertAt: "2026-09-28T12:00:00.000Z",
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

describe("alertAtOf", () => {
  const FP = "2026-09-27T08:00:00.000Z";
  const H = 3600 * 1000;
  const fpMs = Date.parse(FP);

  it("blindspot: first_published + feedDelayHours when updated_at is earlier", () => {
    const got = alertAtOf("blindspot", FP, "2026-09-27T09:00:00.000Z");
    expect(got).toBe(new Date(fpMs + BLINDSPOT.feedDelayHours * H).toISOString());
  });

  it("blindspot: updated_at when it is later than the delay boundary", () => {
    const upd = new Date(fpMs + (BLINDSPOT.feedDelayHours + 5) * H).toISOString();
    expect(alertAtOf("blindspot", FP, upd)).toBe(upd);
  });

  it("one_zone_silent: first_published + SILENT_MIN_AGE_H when updated_at is earlier", () => {
    const got = alertAtOf("one_zone_silent", FP, "2026-09-27T09:00:00.000Z");
    expect(got).toBe(new Date(fpMs + SILENT_MIN_AGE_H * H).toISOString());
  });

  it("one_zone_silent: updated_at when it is later than the age boundary", () => {
    const upd = new Date(fpMs + (SILENT_MIN_AGE_H + 2) * H).toISOString();
    expect(alertAtOf("one_zone_silent", FP, upd)).toBe(upd);
  });

  it("is exactly the boundary when updated_at equals it", () => {
    const boundary = new Date(fpMs + SILENT_MIN_AGE_H * H).toISOString();
    expect(alertAtOf("one_zone_silent", FP, boundary)).toBe(boundary);
  });

  it("falls back to first_published + delay when updated_at is unparsable", () => {
    expect(alertAtOf("blindspot", FP, "garbage")).toBe(
      new Date(fpMs + BLINDSPOT.feedDelayHours * H).toISOString(),
    );
    expect(alertAtOf("one_zone_silent", FP, "")).toBe(
      new Date(fpMs + SILENT_MIN_AGE_H * H).toISOString(),
    );
  });

  it("falls back to updated_at when first_published is unparsable", () => {
    expect(alertAtOf("blindspot", "nope", "2026-09-28T12:00:00.000Z")).toBe(
      "2026-09-28T12:00:00.000Z",
    );
  });

  it("returns null when both timestamps are unparsable", () => {
    expect(alertAtOf("blindspot", "x", "y")).toBeNull();
    expect(alertAtOf("one_zone_silent", "", "")).toBeNull();
  });

  it("normalises a Postgres-style offset timestamp to a UTC ISO string", () => {
    expect(alertAtOf("one_zone_silent", "2026-09-27T11:00:00.123456+03:00", "2026-09-27T20:00:00+00:00")).toBe(
      "2026-09-27T20:00:00.000Z",
    );
  });

  it("is pure: the same input gives the same output", () => {
    expect(alertAtOf("blindspot", FP, "2026-09-27T09:00:00.000Z")).toBe(
      alertAtOf("blindspot", FP, "2026-09-27T09:00:00.000Z"),
    );
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
      alert_at: "2026-09-28T12:00:00.000Z",
      source_count: 6,
      zone_counts: { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
      dominant_zone: "iktidar",
      silent_zones: ["muhalefet"],
    });
  });

  it("alert_at carries item.alertAt and updated_at stays the cluster's own updated_at", () => {
    const rec = toV1AlertRecord(
      item({ updatedAt: "2026-09-27T09:00:00.000Z", alertAt: "2026-09-28T08:00:00.000Z" }),
    );
    expect(rec.alert_at).toBe("2026-09-28T08:00:00.000Z");
    expect(rec.updated_at).toBe("2026-09-27T09:00:00.000Z");
  });

  it("puts alert_at right after updated_at in the key order", () => {
    const keys = Object.keys(toV1AlertRecord(item()));
    expect(keys.indexOf("alert_at")).toBe(keys.indexOf("updated_at") + 1);
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

  it("pubDate is the alert_at moment, not the cluster's updated_at", () => {
    const rec = toV1AlertRecord(
      item({ updatedAt: "2026-09-27T09:00:00.000Z", alertAt: "2026-09-28T08:00:00.000Z" }),
    );
    const out = buildAlertRss([rec], base);
    expect(out).toContain(`<pubDate>${new Date("2026-09-28T08:00:00.000Z").toUTCString()}</pubDate>`);
    expect(out).not.toContain(new Date("2026-09-27T09:00:00.000Z").toUTCString());
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
