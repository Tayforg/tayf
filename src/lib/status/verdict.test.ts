import { describe, expect, it } from "vitest";

import { BIAS_TO_ZONE } from "@/lib/bias/config";
import {
  STATUS_CLUSTER_FAIL_MIN,
  STATUS_CLUSTER_WARN_MIN,
  STATUS_FEEDS_FAIL_SILENT_SHARE,
  STATUS_FEEDS_WARN_SILENT_SHARE,
  STATUS_INGEST_FAIL_MIN,
  STATUS_INGEST_WARN_MIN,
  STATUS_LABELLING_FAIL_MIN,
  STATUS_LABELLING_WARN_MIN,
  STATUS_LOOKBACK_HOURS,
  VERDICT_LABELS,
  ageMinutes,
  buildStatusView,
  feedsLevel,
  formatAge,
  levelForAge,
  overallVerdict,
  toPublicStatusSnapshot,
  zoneIngestAges,
  type PublicStatusSnapshot,
  type StatusLevel,
} from "./verdict";

const NOW = "2026-10-22T10:00:00.000Z";

/** ISO timestamp `min` minutes before NOW. */
function ago(min: number): string {
  return new Date(Date.parse(NOW) - min * 60_000).toISOString();
}

/** A fully healthy snapshot; tests override one section at a time. */
function snap(over: Partial<PublicStatusSnapshot> = {}): PublicStatusSnapshot {
  return {
    generatedAt: NOW,
    ingest: {
      ok: true,
      lastByBias: {
        pro_government: ago(10),
        center: ago(12),
        opposition: ago(15),
      },
    },
    clustering: { ok: true, lastAt: ago(5) },
    labelling: { ok: true, lastAt: ago(8), paused: false },
    feeds: { ok: true, active: 100, silent: 20 },
    ...over,
  };
}

describe("thresholds (each carries its source in verdict.ts)", () => {
  it("pins the ops-derived numbers", () => {
    expect(STATUS_LOOKBACK_HOURS).toBe(6);
    expect(STATUS_INGEST_WARN_MIN).toBe(79);
    expect(STATUS_INGEST_FAIL_MIN).toBe(158);
    expect(STATUS_LABELLING_WARN_MIN).toBe(20);
    expect(STATUS_LABELLING_FAIL_MIN).toBe(30);
    expect(STATUS_FEEDS_WARN_SILENT_SHARE).toBe(0.4);
    expect(STATUS_FEEDS_FAIL_SILENT_SHARE).toBe(0.5);
  });

  it("clustering follows the ops 077 convention (Step 0: max 7-day gap 51 min)", () => {
    expect(STATUS_CLUSTER_FAIL_MIN).toBe(Math.max(90, Math.ceil(1.5 * 51)));
    expect(STATUS_CLUSTER_WARN_MIN).toBe(Math.ceil(STATUS_CLUSTER_FAIL_MIN / 2));
  });

  it("every warn threshold is strictly below its fail threshold", () => {
    expect(STATUS_INGEST_WARN_MIN).toBeLessThan(STATUS_INGEST_FAIL_MIN);
    expect(STATUS_CLUSTER_WARN_MIN).toBeLessThan(STATUS_CLUSTER_FAIL_MIN);
    expect(STATUS_LABELLING_WARN_MIN).toBeLessThan(STATUS_LABELLING_FAIL_MIN);
    expect(STATUS_FEEDS_WARN_SILENT_SHARE).toBeLessThan(STATUS_FEEDS_FAIL_SILENT_SHARE);
  });

  it("all thresholds sit inside the 6 h lookback", () => {
    for (const fail of [STATUS_INGEST_FAIL_MIN, STATUS_CLUSTER_FAIL_MIN, STATUS_LABELLING_FAIL_MIN]) {
      expect(fail).toBeLessThan(STATUS_LOOKBACK_HOURS * 60);
    }
  });

  it("labels the three overall verdicts in Turkish", () => {
    expect(VERDICT_LABELS).toEqual({
      calisiyor: "Çalışıyor",
      gecikmeli: "Gecikmeli",
      sorunlu: "Sorunlu",
    });
  });
});

describe("ageMinutes", () => {
  it("returns null for a null lastAt", () => {
    expect(ageMinutes(NOW, null)).toBeNull();
  });

  it("returns whole and fractional minutes between lastAt and generatedAt", () => {
    expect(ageMinutes(NOW, ago(12))).toBe(12);
    expect(ageMinutes(NOW, new Date(Date.parse(NOW) - 90_000).toISOString())).toBeCloseTo(1.5, 5);
  });

  it("clamps a negative age (lastAt after generatedAt) to 0", () => {
    expect(ageMinutes(NOW, ago(-3))).toBe(0);
  });

  it("returns null for an unparseable timestamp rather than NaN", () => {
    expect(ageMinutes(NOW, "not-a-date")).toBeNull();
  });
});

describe("levelForAge (strict > comparisons, as in ops)", () => {
  const W = STATUS_INGEST_WARN_MIN;
  const F = STATUS_INGEST_FAIL_MIN;

  it.each([
    [0, "ok"],
    [78.9, "ok"],
    [79, "ok"],
    [79.1, "gecikmeli"],
    [158, "gecikmeli"],
    [158.1, "sorunlu"],
    [10_000, "sorunlu"],
  ] as const)("age %s -> %s", (age, expected) => {
    expect(levelForAge(age, W, F)).toBe(expected);
  });

  it("null age (no data in the lookback) -> sorunlu", () => {
    expect(levelForAge(null, W, F)).toBe("sorunlu");
  });
});

describe("zoneIngestAges", () => {
  it("collapses biases to zones taking the NEWEST timestamp (smallest age)", () => {
    const ages = zoneIngestAges(
      snap({
        ingest: {
          ok: true,
          lastByBias: {
            pro_government: ago(60),
            gov_leaning: ago(20), // same zone, newer -> wins
            center: ago(30),
            international: ago(90),
            opposition: ago(45),
            opposition_leaning: ago(200),
          },
        },
      }),
    );
    expect(ages).toEqual({ iktidar: 20, bagimsiz: 30, muhalefet: 45 });
  });

  it("a zone with no recent bias entry is null", () => {
    const ages = zoneIngestAges(
      snap({ ingest: { ok: true, lastByBias: { center: ago(5) } } }),
    );
    expect(ages).toEqual({ iktidar: null, bagimsiz: 5, muhalefet: null });
  });

  it("agrees with BIAS_TO_ZONE for every bias (no private zone map)", () => {
    for (const [bias, zone] of Object.entries(BIAS_TO_ZONE)) {
      const ages = zoneIngestAges(
        snap({ ingest: { ok: true, lastByBias: { [bias]: ago(7) } } }),
      );
      expect(ages[zone as keyof typeof ages]).toBe(7);
    }
  });
});

describe("feedsLevel", () => {
  it("null or zero active sources -> bilinmiyor", () => {
    expect(feedsLevel(null, null)).toBe("bilinmiyor");
    expect(feedsLevel(0, 0)).toBe("bilinmiyor");
    expect(feedsLevel(100, null)).toBe("bilinmiyor");
    expect(feedsLevel(null, 5)).toBe("bilinmiyor");
  });

  it("is ok below the warn share, gecikmeli AT warn, sorunlu AT fail (>=)", () => {
    expect(feedsLevel(100, 39)).toBe("ok");
    expect(feedsLevel(100, 40)).toBe("gecikmeli");
    expect(feedsLevel(100, 49)).toBe("gecikmeli");
    expect(feedsLevel(100, 50)).toBe("sorunlu");
    expect(feedsLevel(100, 100)).toBe("sorunlu");
  });

  it("the live Step 0 baseline (26 of 118 silent, 22%) is ok", () => {
    expect(feedsLevel(118, 26)).toBe("ok");
  });
});

describe("overallVerdict", () => {
  type Row = {
    name: string;
    zones: StatusLevel[];
    clustering: StatusLevel;
    labelling: StatusLevel | "duraklatildi";
    feeds: StatusLevel;
    expected: "calisiyor" | "gecikmeli" | "sorunlu";
  };
  const ok: StatusLevel = "ok";
  const table: Row[] = [
    { name: "everything ok", zones: [ok, ok, ok], clustering: ok, labelling: ok, feeds: ok, expected: "calisiyor" },
    { name: "one zone gecikmeli", zones: [ok, "gecikmeli", ok], clustering: ok, labelling: ok, feeds: ok, expected: "gecikmeli" },
    { name: "one zone sorunlu", zones: [ok, ok, "sorunlu"], clustering: ok, labelling: ok, feeds: ok, expected: "sorunlu" },
    { name: "clustering gecikmeli", zones: [ok, ok, ok], clustering: "gecikmeli", labelling: ok, feeds: ok, expected: "gecikmeli" },
    { name: "clustering sorunlu", zones: [ok, ok, ok], clustering: "sorunlu", labelling: ok, feeds: ok, expected: "sorunlu" },
    { name: "labelling sorunlu is CAPPED at gecikmeli", zones: [ok, ok, ok], clustering: ok, labelling: "sorunlu", feeds: ok, expected: "gecikmeli" },
    { name: "feeds sorunlu is CAPPED at gecikmeli", zones: [ok, ok, ok], clustering: ok, labelling: ok, feeds: "sorunlu", expected: "gecikmeli" },
    { name: "labelling gecikmeli", zones: [ok, ok, ok], clustering: ok, labelling: "gecikmeli", feeds: ok, expected: "gecikmeli" },
    { name: "labelling bilinmiyor counts as gecikmeli", zones: [ok, ok, ok], clustering: ok, labelling: "bilinmiyor", feeds: ok, expected: "gecikmeli" },
    { name: "feeds bilinmiyor counts as gecikmeli", zones: [ok, ok, ok], clustering: ok, labelling: ok, feeds: "bilinmiyor", expected: "gecikmeli" },
    { name: "zone bilinmiyor counts as gecikmeli", zones: [ok, "bilinmiyor", ok], clustering: ok, labelling: ok, feeds: ok, expected: "gecikmeli" },
    { name: "clustering bilinmiyor counts as gecikmeli", zones: [ok, ok, ok], clustering: "bilinmiyor", labelling: ok, feeds: ok, expected: "gecikmeli" },
    { name: "paused labelling is excluded", zones: [ok, ok, ok], clustering: ok, labelling: "duraklatildi", feeds: ok, expected: "calisiyor" },
    { name: "paused labelling does not mask a zone problem", zones: [ok, "gecikmeli", ok], clustering: ok, labelling: "duraklatildi", feeds: ok, expected: "gecikmeli" },
    { name: "sorunlu zone wins over capped labelling", zones: ["sorunlu", ok, ok], clustering: ok, labelling: "sorunlu", feeds: "sorunlu", expected: "sorunlu" },
    { name: "capped labelling + gecikmeli zone stays gecikmeli", zones: [ok, "gecikmeli", ok], clustering: ok, labelling: "sorunlu", feeds: ok, expected: "gecikmeli" },
    { name: "bilinmiyor never reaches sorunlu", zones: ["bilinmiyor", "bilinmiyor", "bilinmiyor"], clustering: "bilinmiyor", labelling: "bilinmiyor", feeds: "bilinmiyor", expected: "gecikmeli" },
  ];

  it.each(table)("$name -> $expected", ({ zones, clustering, labelling, feeds, expected }) => {
    expect(overallVerdict({ zones, clustering, labelling, feeds })).toBe(expected);
  });
});

describe("buildStatusView", () => {
  it("builds three zone rows in iktidar, bagimsiz, muhalefet order with levels and ages", () => {
    const v = buildStatusView(snap());
    expect(v.generatedAt).toBe(NOW);
    expect(v.zones.map((z) => z.zone)).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
    expect(v.zones.map((z) => z.ageMin)).toEqual([10, 12, 15]);
    expect(v.zones.every((z) => z.level === "ok")).toBe(true);
    expect(v.clustering).toEqual({ level: "ok", ageMin: 5 });
    expect(v.labelling).toEqual({ level: "ok", ageMin: 8 });
    expect(v.feeds).toEqual({ level: "ok", active: 100, silent: 20 });
    expect(v.overall).toBe("calisiyor");
  });

  it("a zone with no data in the lookback is sorunlu with a null age", () => {
    const v = buildStatusView(
      snap({ ingest: { ok: true, lastByBias: { pro_government: ago(5), center: ago(5) } } }),
    );
    const muh = v.zones.find((z) => z.zone === "muhalefet");
    expect(muh).toEqual({ zone: "muhalefet", level: "sorunlu", ageMin: null });
    expect(v.overall).toBe("sorunlu");
  });

  it("applies the ingest thresholds at the boundaries", () => {
    const at = (min: number) =>
      buildStatusView(
        snap({
          ingest: { ok: true, lastByBias: { pro_government: ago(min), center: ago(1), opposition: ago(1) } },
        }),
      ).zones[0]!.level;
    expect(at(79)).toBe("ok");
    expect(at(80)).toBe("gecikmeli");
    expect(at(158)).toBe("gecikmeli");
    expect(at(159)).toBe("sorunlu");
  });

  it("clustering uses its own warn/fail thresholds", () => {
    const at = (min: number) => buildStatusView(snap({ clustering: { ok: true, lastAt: ago(min) } })).clustering.level;
    expect(at(STATUS_CLUSTER_WARN_MIN)).toBe("ok");
    expect(at(STATUS_CLUSTER_WARN_MIN + 1)).toBe("gecikmeli");
    expect(at(STATUS_CLUSTER_FAIL_MIN)).toBe("gecikmeli");
    expect(at(STATUS_CLUSTER_FAIL_MIN + 1)).toBe("sorunlu");
  });

  it("labelling uses 20/30 and never drags the overall verdict past gecikmeli", () => {
    const at = (min: number | null) =>
      buildStatusView(snap({ labelling: { ok: true, lastAt: min === null ? null : ago(min), paused: false } }));
    expect(at(20).labelling.level).toBe("ok");
    expect(at(21).labelling.level).toBe("gecikmeli");
    expect(at(30).labelling.level).toBe("gecikmeli");
    expect(at(31).labelling.level).toBe("sorunlu");
    expect(at(31).overall).toBe("gecikmeli");
    expect(at(null).labelling.level).toBe("sorunlu");
    expect(at(null).overall).toBe("gecikmeli");
  });

  it("paused labelling reports duraklatildi and is excluded from the verdict", () => {
    const v = buildStatusView(snap({ labelling: { ok: true, lastAt: ago(500), paused: true } }));
    expect(v.labelling.level).toBe("duraklatildi");
    expect(v.overall).toBe("calisiyor");
  });

  it("a section with ok=false becomes bilinmiyor (ingest: all three zones)", () => {
    const v = buildStatusView(snap({ ingest: { ok: false, lastByBias: {} } }));
    expect(v.zones.every((z) => z.level === "bilinmiyor")).toBe(true);
    expect(v.zones.every((z) => z.ageMin === null)).toBe(true);
    expect(v.overall).toBe("gecikmeli");
  });

  it("ok=false clustering / labelling / feeds each become bilinmiyor", () => {
    expect(buildStatusView(snap({ clustering: { ok: false, lastAt: null } })).clustering.level).toBe("bilinmiyor");
    expect(buildStatusView(snap({ labelling: { ok: false, lastAt: null, paused: false } })).labelling.level).toBe(
      "bilinmiyor",
    );
    expect(buildStatusView(snap({ feeds: { ok: false, active: null, silent: null } })).feeds.level).toBe("bilinmiyor");
  });

  it("feeds at the warn and fail share through the view", () => {
    expect(buildStatusView(snap({ feeds: { ok: true, active: 100, silent: 40 } })).feeds.level).toBe("gecikmeli");
    expect(buildStatusView(snap({ feeds: { ok: true, active: 100, silent: 50 } })).feeds.level).toBe("sorunlu");
    expect(buildStatusView(snap({ feeds: { ok: true, active: 0, silent: 0 } })).feeds.level).toBe("bilinmiyor");
  });

  it("is a pure function of the snapshot (no clock read)", () => {
    expect(buildStatusView(snap())).toEqual(buildStatusView(snap()));
  });
});

describe("formatAge", () => {
  it.each([
    [0, "1 dakikadan kısa süre önce"],
    [0.99, "1 dakikadan kısa süre önce"],
    [1, "1 dakika önce"],
    [12, "12 dakika önce"],
    [59.9, "59 dakika önce"],
    [60, "1 saat önce"],
    [61, "1 saat 1 dakika önce"],
    [135, "2 saat 15 dakika önce"],
    [180, "3 saat önce"],
  ] as const)("%s min -> %s", (min, expected) => {
    expect(formatAge(min)).toBe(expected);
  });
});

describe("toPublicStatusSnapshot (allow-list parser for the rpc payload)", () => {
  const rawOk = () => ({
    generated_at: "2026-10-22T10:00:00.123456+00:00",
    ingest: { ok: true, last_by_bias: { center: "2026-10-22T09:50:00.5+00:00" } },
    clustering: { ok: true, last_at: "2026-10-22T09:55:00+00:00" },
    labelling: { ok: true, last_at: null, paused: false },
    feeds: { ok: true, active: 118, silent: 26 },
  });

  it("maps a well-formed payload into the camelCase model", () => {
    const s = toPublicStatusSnapshot(rawOk());
    expect(s).toEqual({
      generatedAt: "2026-10-22T10:00:00.123456+00:00",
      ingest: { ok: true, lastByBias: { center: "2026-10-22T09:50:00.5+00:00" } },
      clustering: { ok: true, lastAt: "2026-10-22T09:55:00+00:00" },
      labelling: { ok: true, lastAt: null, paused: false },
      feeds: { ok: true, active: 118, silent: 26 },
    });
  });

  it("strips every key outside the allow-list: a leaked detail never reaches the model", () => {
    const raw = {
      ...rawOk(),
      detail: "cron failed net._http_response",
      ingest: { ok: true, last_by_bias: {}, detail: "jobname jev-shadow", sqlerrm: "boom" },
      clustering: { ok: true, last_at: null, error_msg: "pg_net timeout", url: "https://x.test/fn" },
      labelling: { ok: true, last_at: null, paused: false, jobname: "jev-shadow", command: "select 1" },
      feeds: { ok: true, active: 1, silent: 0, ids: ["6f1c1b52-2f0f-4d52-a9f2-3a3c0d3a6c11"] },
    };
    const s = toPublicStatusSnapshot(raw);
    expect(s).not.toBeNull();
    const dump = JSON.stringify(s);
    expect(dump).not.toMatch(/cron|net\._http|_http_response|jobname|jev-shadow|sqlerrm|error_msg|pg_net|https?:|command|6f1c1b52/i);
    expect(Object.keys(s!).sort()).toEqual(["clustering", "feeds", "generatedAt", "ingest", "labelling"]);
    expect(Object.keys(s!.ingest).sort()).toEqual(["lastByBias", "ok"]);
    expect(Object.keys(s!.clustering).sort()).toEqual(["lastAt", "ok"]);
    expect(Object.keys(s!.labelling).sort()).toEqual(["lastAt", "ok", "paused"]);
    expect(Object.keys(s!.feeds).sort()).toEqual(["active", "ok", "silent"]);
  });

  it("keeps last_by_bias entries only for known biases with an ISO timestamp value", () => {
    const raw = rawOk();
    raw.ingest.last_by_bias = {
      center: "2026-10-22T09:50:00+00:00",
      opposition: "2026-10-22T09:40:00Z",
      "jev-shadow": "2026-10-22T09:50:00+00:00", // unknown key -> dropped
      __proto__x: "2026-10-22T09:50:00+00:00", // unknown key -> dropped
      pro_government: "yesterday", // not ISO -> dropped
      gov_leaning: 12345, // not a string -> dropped
      nationalist: "2026-13-45T99:99:99Z", // ISO-shaped but invalid -> dropped
    } as never;
    const s = toPublicStatusSnapshot(raw);
    expect(s?.ingest.lastByBias).toEqual({
      center: "2026-10-22T09:50:00+00:00",
      opposition: "2026-10-22T09:40:00Z",
    });
  });

  it("does not let a __proto__ key pollute the result", () => {
    const raw = JSON.parse(
      '{"generated_at":"2026-10-22T10:00:00Z","ingest":{"ok":true,"last_by_bias":{"__proto__":"2026-10-22T09:50:00Z","center":"2026-10-22T09:50:00Z"}},"clustering":{"ok":true,"last_at":null},"labelling":{"ok":true,"last_at":null,"paused":false},"feeds":{"ok":true,"active":1,"silent":0}}',
    );
    const s = toPublicStatusSnapshot(raw);
    expect(Object.keys(s!.ingest.lastByBias)).toEqual(["center"]);
    expect(({} as Record<string, unknown>)["2026-10-22T09:50:00Z"]).toBeUndefined();
  });

  it("returns null when generated_at is missing or invalid", () => {
    expect(toPublicStatusSnapshot({ ...rawOk(), generated_at: undefined })).toBeNull();
    expect(toPublicStatusSnapshot({ ...rawOk(), generated_at: "soon" })).toBeNull();
    expect(toPublicStatusSnapshot({ ...rawOk(), generated_at: 1761127200000 })).toBeNull();
    expect(toPublicStatusSnapshot({ ...rawOk(), generated_at: "2026-02-31T00:00:00Z" })).toBeNull();
  });

  it.each(["ingest", "clustering", "labelling", "feeds"] as const)("returns null when the %s section is missing", (key) => {
    const raw: Record<string, unknown> = rawOk();
    delete raw[key];
    expect(toPublicStatusSnapshot(raw)).toBeNull();
  });

  it.each([null, undefined, 42, "text", true, [], [rawOk()]])("returns null for a non-object payload (%j)", (bad) => {
    expect(toPublicStatusSnapshot(bad)).toBeNull();
  });

  it("returns null for malformed section fields instead of guessing a state", () => {
    const base = rawOk();
    expect(toPublicStatusSnapshot({ ...base, ingest: { ok: "yes", last_by_bias: {} } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, ingest: { ok: true, last_by_bias: "x" } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, ingest: { ok: true, last_by_bias: [] } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, clustering: { ok: true, last_at: "nope" } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, clustering: { ok: true } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, labelling: { ok: true, last_at: null, paused: "no" } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, feeds: { ok: true, active: "118", silent: 26 } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, feeds: { ok: true, active: 1.5, silent: 0 } })).toBeNull();
    expect(toPublicStatusSnapshot({ ...base, feeds: { ok: true, active: -1, silent: 0 } })).toBeNull();
  });

  it("accepts the exact document PG15 produced in the 110 dry run (microseconds, +01:00 offset)", () => {
    const s = toPublicStatusSnapshot({
      feeds: { ok: true, active: 4, silent: 1 },
      ingest: {
        ok: true,
        last_by_bias: {
          opposition: "2026-10-22T04:07:24.555549+01:00",
          pro_government: "2026-10-22T05:37:24.555549+01:00",
        },
      },
      labelling: { ok: true, paused: false, last_at: "2026-10-22T05:35:24.556233+01:00" },
      clustering: { ok: true, last_at: "2026-10-22T05:42:24.556037+01:00" },
      generated_at: "2026-10-22T05:47:24.568138+01:00",
    });
    expect(s).not.toBeNull();
    const v = buildStatusView(s!);
    expect(v.zones.map((z) => Math.round(z.ageMin ?? -1))).toEqual([10, -1, 100]);
    expect(v.clustering.ageMin).toBeCloseTo(5, 1);
    expect(v.labelling.ageMin).toBeCloseTo(12, 1);
    // the bagimsiz zone has no entry in this fixture -> no data in the lookback
    expect(v.zones[1]).toEqual({ zone: "bagimsiz", level: "sorunlu", ageMin: null });
  });

  it("accepts the failure-section shape (ok=false with null counts)", () => {
    const s = toPublicStatusSnapshot({
      ...rawOk(),
      feeds: { ok: false, active: null, silent: null },
      clustering: { ok: false, last_at: null },
      ingest: { ok: false, last_by_bias: {} },
    });
    expect(s?.feeds).toEqual({ ok: false, active: null, silent: null });
    expect(s?.clustering).toEqual({ ok: false, lastAt: null });
    expect(s?.ingest).toEqual({ ok: false, lastByBias: {} });
  });
});
