import { describe, expect, it } from "vitest";

import { BIAS_TO_ZONE } from "@/lib/bias/config";
import {
  STATUS_CLUSTER_FAIL_MIN,
  STATUS_CLUSTER_POISON_WINDOW_HOURS,
  STATUS_CLUSTER_QUEUE_DEPTH_WARN,
  STATUS_CLUSTER_QUEUE_FAIL_SEC,
  STATUS_CLUSTER_QUEUE_WARN_SEC,
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
  clusterQueueLevel,
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

  it("the clustering queue rule is ops row 18 queue_lag (migration 150): 300 s warn, 900 s fail", () => {
    expect(STATUS_CLUSTER_QUEUE_WARN_SEC).toBe(300);
    expect(STATUS_CLUSTER_QUEUE_FAIL_SEC).toBe(900);
    expect(STATUS_CLUSTER_QUEUE_WARN_SEC).toBeLessThan(STATUS_CLUSTER_QUEUE_FAIL_SEC);
  });

  it("the queue depth line and the poison window are ops row 18's: depth > 300, poison counted over the last hour", () => {
    expect(STATUS_CLUSTER_QUEUE_DEPTH_WARN).toBe(300);
    expect(STATUS_CLUSTER_POISON_WINDOW_HOURS).toBe(1);
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

describe("clusterQueueLevel (strict >, as in ops row 18)", () => {
  it.each([
    [0, "ok"],
    [60, "ok"],
    [300, "ok"],
    [300.01, "gecikmeli"],
    [900, "gecikmeli"],
    [900.01, "sorunlu"],
    [86_400, "sorunlu"],
  ] as const)("oldest visible message %s s -> %s", (sec, expected) => {
    expect(clusterQueueLevel(sec)).toBe(expected);
  });
});

describe("clustering follows the cluster_work queue lag, not the age of the last cluster update (h71-transparency-3)", () => {
  /** 2026-11-08 02:30Z: the quiet night. Nothing politika/son_dakika arrived from 01:27 to 02:33Z, so no cluster was touched. */
  const QUIET_NIGHT = "2026-11-08T02:30:00.000Z";
  const quiet = (clustering: PublicStatusSnapshot["clustering"]): PublicStatusSnapshot => ({
    generatedAt: QUIET_NIGHT,
    ingest: {
      ok: true,
      lastByBias: {
        pro_government: "2026-11-08T02:28:00.000Z",
        center: "2026-11-08T02:27:00.000Z",
        opposition: "2026-11-08T02:29:00.000Z",
      },
    },
    clustering,
    labelling: { ok: true, lastAt: "2026-11-08T02:25:00.000Z", paused: false },
    feeds: { ok: true, active: 118, silent: 26 },
  });
  const rawQuiet = (clustering: Record<string, unknown>) => ({
    generated_at: "2026-11-08T02:30:00+00:00",
    ingest: {
      ok: true,
      last_by_bias: {
        pro_government: "2026-11-08T02:28:00+00:00",
        center: "2026-11-08T02:27:00+00:00",
        opposition: "2026-11-08T02:29:00+00:00",
      },
    },
    clustering,
    labelling: { ok: true, last_at: "2026-11-08T02:25:00+00:00", paused: false },
    feeds: { ok: true, active: 118, silent: 26 },
  });

  it("REPLAY: last cluster update 63 min old but an empty queue reads Normal and the page reads Çalışıyor (was Gecikmeli)", () => {
    const v = buildStatusView(
      quiet({ ok: true, lastAt: "2026-11-08T01:27:04.000Z", queueDepth: 0, queueOldestSec: 0 }),
    );
    expect(v.clustering.level).toBe("ok");
    expect(v.overall).toBe("calisiyor");
    // the age stays as informational text
    expect(v.clustering.ageMin).toBeCloseTo(62.93, 1);
  });

  it("REPLAY through the parser: the raw document the new function returns on the quiet night", () => {
    const s = toPublicStatusSnapshot(
      rawQuiet({ ok: true, last_at: "2026-11-08T01:27:04+00:00", queue_depth: 0, queue_oldest_sec: 0 }),
    );
    expect(s).not.toBeNull();
    const v = buildStatusView(s!);
    expect(v.clustering.level).toBe("ok");
    expect(v.overall).toBe("calisiyor");
  });

  it("the same idle night on a database WITHOUT migration 176 is still Gecikmeli (the baseline this fixes)", () => {
    const s = toPublicStatusSnapshot(rawQuiet({ ok: true, last_at: "2026-11-08T01:27:04+00:00" }));
    const v = buildStatusView(s!);
    expect(v.clustering.level).toBe("gecikmeli");
    expect(v.overall).toBe("gecikmeli");
  });

  it("a queue wait of 400 s is gecikmeli and 1000 s is sorunlu, whatever the last update age", () => {
    const at = (sec: number, lastAt: string | null) =>
      buildStatusView(quiet({ ok: true, lastAt, queueDepth: 7, queueOldestSec: sec }));
    expect(at(400, "2026-11-08T02:29:00.000Z").clustering.level).toBe("gecikmeli");
    expect(at(400, "2026-11-08T02:29:00.000Z").overall).toBe("gecikmeli");
    expect(at(1000, "2026-11-08T02:29:00.000Z").clustering.level).toBe("sorunlu");
    expect(at(1000, "2026-11-08T02:29:00.000Z").overall).toBe("sorunlu");
    expect(at(400, null).clustering.level).toBe("gecikmeli");
  });

  it("a stuck consumer is still detected: last update 1 min old, oldest message 1000 s -> sorunlu", () => {
    const v = buildStatusView(
      quiet({ ok: true, lastAt: "2026-11-08T02:29:00.000Z", queueDepth: 12, queueOldestSec: 1000 }),
    );
    expect(v.clustering.ageMin).toBe(1);
    expect(v.clustering.level).toBe("sorunlu");
    expect(v.overall).toBe("sorunlu");
  });

  it("boundaries are strict: 300 s and 900 s sit on the lower side", () => {
    const at = (sec: number) =>
      buildStatusView(quiet({ ok: true, lastAt: null, queueDepth: 1, queueOldestSec: sec })).clustering.level;
    expect(at(300)).toBe("ok");
    expect(at(300.5)).toBe("gecikmeli");
    expect(at(900)).toBe("gecikmeli");
    expect(at(900.5)).toBe("sorunlu");
  });

  it("no cluster update in the whole lookback is Normal while the queue is empty (the old rule said Sorunlu)", () => {
    const v = buildStatusView(quiet({ ok: true, lastAt: null, queueDepth: 0, queueOldestSec: 0 }));
    expect(v.clustering).toMatchObject({ level: "ok", ageMin: null });
    expect(v.overall).toBe("calisiyor");
  });

  it("an unmeasured clustering section stays bilinmiyor even if queue numbers ride along", () => {
    const v = buildStatusView(quiet({ ok: false, lastAt: null, queueDepth: 0, queueOldestSec: 0 }));
    expect(v.clustering.level).toBe("bilinmiyor");
    expect(v.clustering.queueOldestSec).toBeUndefined();
  });

  it("the view model carries the queue numbers only when the queue rule applies", () => {
    const withQueue = buildStatusView(quiet({ ok: true, lastAt: "2026-11-08T02:20:00.000Z", queueDepth: 3, queueOldestSec: 42 }));
    expect(withQueue.clustering).toEqual({ level: "ok", ageMin: 10, queueDepth: 3, queueOldestSec: 42 });
    const without = buildStatusView(quiet({ ok: true, lastAt: "2026-11-08T02:20:00.000Z" }));
    expect(without.clustering).toEqual({ level: "ok", ageMin: 10 });
    const explicitNull = buildStatusView(
      quiet({ ok: true, lastAt: "2026-11-08T02:20:00.000Z", queueDepth: null, queueOldestSec: null }),
    );
    expect(explicitNull.clustering).toEqual({ level: "ok", ageMin: 10 });
  });

  describe("poison and depth lines of ops row 18 (a failing consumer archives each message on its 4th read, so the oldest visible wait stays short)", () => {
    const QUIET_LAST_UPDATE = "2026-11-08T01:27:04.000Z";
    const level = (clustering: Partial<PublicStatusSnapshot["clustering"]>) =>
      buildStatusView(quiet({ ok: true, lastAt: QUIET_LAST_UPDATE, queueDepth: 0, queueOldestSec: 0, ...clustering }));

    it("an empty queue with 2 messages archived as poison in the last hour is gecikmeli and the page is not Çalışıyor", () => {
      const v = level({ queuePoisonRecent: 2 });
      expect(v.clustering.level).toBe("gecikmeli");
      expect(v.overall).not.toBe("calisiyor");
      expect(v.overall).toBe("gecikmeli");
      expect(v.clustering.queuePoisonRecent).toBe(2);
    });

    it("one poison message is enough (ops row 18: q_poison >= 1)", () => {
      expect(level({ queuePoisonRecent: 1 }).clustering.level).toBe("gecikmeli");
    });

    it("zero poison keeps the idle-night replay Normal, and so does an absent or null key", () => {
      for (const clustering of [
        { queuePoisonRecent: 0 },
        {},
        { queuePoisonRecent: undefined },
        { queuePoisonRecent: null },
      ] as const) {
        const v = level(clustering);
        expect(v.clustering.level, JSON.stringify(clustering)).toBe("ok");
        expect(v.overall, JSON.stringify(clustering)).toBe("calisiyor");
      }
    });

    it("a stale last update, an empty queue and poison >= 1 is never ok (the page cannot say Çalışıyor)", () => {
      for (const lastAt of [QUIET_LAST_UPDATE, null]) {
        const v = level({ lastAt, queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: 3 });
        expect(v.clustering.level).not.toBe("ok");
        expect(v.overall).not.toBe("calisiyor");
      }
    });

    it("poison never lowers sorunlu: poison 1 with a 1000 s wait stays sorunlu", () => {
      const v = level({ queueDepth: 5, queueOldestSec: 1000, queuePoisonRecent: 1 });
      expect(v.clustering.level).toBe("sorunlu");
      expect(v.overall).toBe("sorunlu");
    });

    it("poison on top of a 400 s wait stays gecikmeli, and 0 poison with a 400 s wait is gecikmeli too", () => {
      expect(level({ queueDepth: 5, queueOldestSec: 400, queuePoisonRecent: 4 }).clustering.level).toBe("gecikmeli");
      expect(level({ queueDepth: 5, queueOldestSec: 400, queuePoisonRecent: 0 }).clustering.level).toBe("gecikmeli");
    });

    it("a depth of 301 with a 10 s wait is gecikmeli; 300 is still ok (ops row 18: qc_depth > 300)", () => {
      expect(level({ queueDepth: 301, queueOldestSec: 10 }).clustering.level).toBe("gecikmeli");
      expect(level({ queueDepth: 301, queueOldestSec: 10 }).overall).toBe("gecikmeli");
      expect(level({ queueDepth: 300, queueOldestSec: 10 }).clustering.level).toBe("ok");
      expect(level({ queueDepth: 5000, queueOldestSec: 0 }).clustering.level).toBe("gecikmeli");
    });

    it("a depth over 300 never lowers sorunlu", () => {
      expect(level({ queueDepth: 301, queueOldestSec: 1000 }).clustering.level).toBe("sorunlu");
    });

    it("a null depth cannot raise the level", () => {
      expect(level({ queueDepth: null, queueOldestSec: 10, queuePoisonRecent: null }).clustering.level).toBe("ok");
    });

    it("hand-built garbage (NaN, negative, fractional, Infinity) in the poison or depth field is ignored, not trusted", () => {
      for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
        const v = level({ queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: bad });
        expect(v.clustering.level, String(bad)).toBe("ok");
        expect(v.clustering.queuePoisonRecent, String(bad)).toBeUndefined();
        expect(level({ queueDepth: bad, queueOldestSec: 5 }).clustering.level, String(bad)).toBe("ok");
      }
    });

    it("the view model exposes queuePoisonRecent only when it is a valid count", () => {
      expect(level({ queuePoisonRecent: 0 }).clustering).toMatchObject({ queuePoisonRecent: 0 });
      expect(level({}).clustering).not.toHaveProperty("queuePoisonRecent");
      expect(level({ queuePoisonRecent: null }).clustering).not.toHaveProperty("queuePoisonRecent");
    });

    it("an unmeasured clustering section stays bilinmiyor even if poison rides along", () => {
      const v = buildStatusView(quiet({ ok: false, lastAt: null, queueDepth: 0, queueOldestSec: 0, queuePoisonRecent: 9 }));
      expect(v.clustering.level).toBe("bilinmiyor");
      expect(v.clustering).not.toHaveProperty("queuePoisonRecent");
    });

    it("REPLAY through the parser: the 176 document with poison 2 reads Gecikmeli, with poison 0 Çalışıyor", () => {
      const doc = (poison: number) =>
        rawQuiet({
          ok: true,
          last_at: "2026-11-08T01:27:04+00:00",
          queue_depth: 0,
          queue_oldest_sec: 0,
          queue_poison_recent: poison,
        });
      const bad = buildStatusView(toPublicStatusSnapshot(doc(2))!);
      expect(bad.clustering.level).toBe("gecikmeli");
      expect(bad.overall).toBe("gecikmeli");
      const good = buildStatusView(toPublicStatusSnapshot(doc(0))!);
      expect(good.clustering.level).toBe("ok");
      expect(good.overall).toBe("calisiyor");
    });
  });

  describe("back-compat: queueOldestSec absent or null keeps the 45/90 updated_at rule byte for byte", () => {
    const at = (min: number, queue: Partial<PublicStatusSnapshot["clustering"]> = {}) =>
      buildStatusView(snap({ clustering: { ok: true, lastAt: ago(min), ...queue } })).clustering;

    it.each([
      [STATUS_CLUSTER_WARN_MIN, "ok"],
      [STATUS_CLUSTER_WARN_MIN + 1, "gecikmeli"],
      [STATUS_CLUSTER_FAIL_MIN, "gecikmeli"],
      [STATUS_CLUSTER_FAIL_MIN + 1, "sorunlu"],
    ] as const)("age %s min -> %s with the key absent, undefined or null", (min, expected) => {
      const absent = at(min);
      expect(absent).toEqual({ level: expected, ageMin: min });
      expect(at(min, { queueOldestSec: null })).toEqual(absent);
      expect(at(min, { queueOldestSec: undefined, queueDepth: undefined })).toEqual(absent);
      expect(at(min, { queueDepth: 5, queueOldestSec: null })).toEqual(absent);
    });

    it("a null last update with no queue number is still sorunlu", () => {
      expect(buildStatusView(snap({ clustering: { ok: true, lastAt: null } })).clustering.level).toBe("sorunlu");
    });

    it("a hand-built snapshot with a non-finite or negative queue number falls back to the old rule", () => {
      for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        expect(at(66, { queueOldestSec: bad }).level).toBe("gecikmeli");
      }
    });
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

  describe("clustering.queue_depth / queue_oldest_sec (migration 176)", () => {
    const withClustering = (clustering: Record<string, unknown>) => ({ ...rawOk(), clustering });

    it("keeps a well-formed pair, including the zero of an empty queue and a fractional wait", () => {
      expect(
        toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_depth: 0, queue_oldest_sec: 0 }))
          ?.clustering,
      ).toEqual({ ok: true, lastAt: null, queueDepth: 0, queueOldestSec: 0 });
      expect(
        toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_depth: 14, queue_oldest_sec: 12.345678 }))
          ?.clustering,
      ).toEqual({ ok: true, lastAt: null, queueDepth: 14, queueOldestSec: 12.345678 });
    });

    it("maps a string, a negative number, NaN, Infinity, a boolean, an object or null to null", () => {
      for (const bad of ["300", "", -1, -0.001, Number.NaN, Number.POSITIVE_INFINITY, true, {}, [], null]) {
        const s = toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_oldest_sec: bad }));
        expect(s, JSON.stringify(bad)).not.toBeNull();
        expect(s!.clustering.queueOldestSec, JSON.stringify(bad)).toBeNull();
      }
    });

    it("maps a non-count queue_depth (string, negative, fractional, NaN) to null", () => {
      for (const bad of ["3", -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, null, {}]) {
        const s = toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_depth: bad, queue_oldest_sec: 5 }));
        expect(s!.clustering.queueDepth, JSON.stringify(bad)).toBeNull();
        expect(s!.clustering.queueOldestSec).toBe(5);
      }
    });

    it("absent keys mean null: a pre-176 payload parses to the old shape and the readers see null", () => {
      const s = toPublicStatusSnapshot(withClustering({ ok: true, last_at: "2026-10-22T09:55:00+00:00" }));
      expect(s?.clustering).toEqual({ ok: true, lastAt: "2026-10-22T09:55:00+00:00" });
      expect(s?.clustering.queueOldestSec ?? null).toBeNull();
      expect(s?.clustering.queueDepth ?? null).toBeNull();
    });

    it("one key present is enough to mark the payload as 176-shaped: the other reads null", () => {
      const s = toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_oldest_sec: 7 }));
      expect(s?.clustering).toEqual({ ok: true, lastAt: null, queueDepth: null, queueOldestSec: 7 });
    });

    describe("queue_poison_recent", () => {
      const parse = (clustering: Record<string, unknown>) =>
        toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_depth: 0, queue_oldest_sec: 0, ...clustering }));

      it("keeps a non-negative integer, zero included", () => {
        for (const good of [0, 1, 2, 417]) {
          expect(parse({ queue_poison_recent: good })?.clustering.queuePoisonRecent, String(good)).toBe(good);
        }
        expect(parse({ queue_poison_recent: 2 })?.clustering).toEqual({
          ok: true,
          lastAt: null,
          queueDepth: 0,
          queueOldestSec: 0,
          queuePoisonRecent: 2,
        });
      });

      it("maps -1, 1.5, '2', NaN, Infinity, booleans, objects and null to null (present but invalid)", () => {
        for (const bad of [-1, 1.5, "2", "", Number.NaN, Number.POSITIVE_INFINITY, true, {}, [], null]) {
          const s = parse({ queue_poison_recent: bad });
          expect(s, JSON.stringify(bad)).not.toBeNull();
          expect(s!.clustering.queuePoisonRecent, JSON.stringify(bad)).toBeNull();
          // the other queue numbers are untouched by a bad poison value
          expect(s!.clustering.queueOldestSec).toBe(0);
        }
      });

      it("a payload without the key parses as before: no queuePoisonRecent property", () => {
        const s = parse({});
        expect(s?.clustering).toEqual({ ok: true, lastAt: null, queueDepth: 0, queueOldestSec: 0 });
        expect(s?.clustering).not.toHaveProperty("queuePoisonRecent");
        const pre176 = toPublicStatusSnapshot(withClustering({ ok: true, last_at: "2026-10-22T09:55:00+00:00" }));
        expect(pre176?.clustering).toEqual({ ok: true, lastAt: "2026-10-22T09:55:00+00:00" });
      });

      it("the key alone marks the payload as 176-shaped: the other queue numbers read null", () => {
        const s = toPublicStatusSnapshot(withClustering({ ok: true, last_at: null, queue_poison_recent: 3 }));
        expect(s?.clustering).toEqual({
          ok: true,
          lastAt: null,
          queueDepth: null,
          queueOldestSec: null,
          queuePoisonRecent: 3,
        });
      });

      it("accepts the document PG produces: bigint count as a JSON integer", () => {
        const s = toPublicStatusSnapshot(
          JSON.parse(
            '{"generated_at":"2026-11-08T02:30:00.123456+00:00","ingest":{"ok":true,"last_by_bias":{}},"clustering":{"ok":true,"last_at":null,"queue_depth":0,"queue_oldest_sec":0,"queue_poison_recent":0},"labelling":{"ok":true,"last_at":null,"paused":false},"feeds":{"ok":true,"active":1,"silent":0}}',
          ),
        );
        expect(s?.clustering.queuePoisonRecent).toBe(0);
      });
    });

    it("still drops every unknown key next to the queue keys (allow-list)", () => {
      const s = toPublicStatusSnapshot(
        withClustering({
          ok: true,
          last_at: null,
          queue_depth: 2,
          queue_oldest_sec: 30,
          queue_name: "cluster_work",
          msg_id: 991,
          message: { article_id: "6f1c1b52-2f0f-4d52-a9f2-3a3c0d3a6c11" },
          queue_oldest_msg: "secret",
        }),
      );
      expect(Object.keys(s!.clustering).sort()).toEqual(["lastAt", "ok", "queueDepth", "queueOldestSec"]);
      expect(JSON.stringify(s)).not.toMatch(/cluster_work|msg_id|6f1c1b52|secret|article_id/);
    });

    it("accepts the document PG produces: numeric epoch seconds with microseconds", () => {
      const s = toPublicStatusSnapshot(
        JSON.parse(
          '{"generated_at":"2026-11-08T02:30:00.123456+00:00","ingest":{"ok":true,"last_by_bias":{}},"clustering":{"ok":true,"last_at":"2026-11-08T01:27:04.467008+00:00","queue_depth":0,"queue_oldest_sec":0},"labelling":{"ok":true,"last_at":null,"paused":false},"feeds":{"ok":true,"active":1,"silent":0}}',
        ),
      );
      expect(s?.clustering).toEqual({
        ok: true,
        lastAt: "2026-11-08T01:27:04.467008+00:00",
        queueDepth: 0,
        queueOldestSec: 0,
      });
    });
  });
});
