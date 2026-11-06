import { describe, it, expect } from "vitest";
import {
  parseDiet,
  serializeDiet,
  pruneDiet,
  appendDiet,
  dietEntryFromTrack,
  summarizeDiet,
  nudgeZones,
  DIET_TTL_DAYS,
  DIET_MAX_ENTRIES,
  DIET_DEDUPE_MS,
  DIET_MIN_SAMPLE,
  DIET_ZONES,
  type DietEntry,
  type DietZone,
} from "./diet";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);

describe("parseDiet", () => {
  it("returns [] for null", () => {
    expect(parseDiet(null)).toEqual([]);
  });

  it("returns [] for garbage JSON", () => {
    expect(parseDiet("{not json")).toEqual([]);
  });

  it("returns [] for a wrong version", () => {
    expect(parseDiet(JSON.stringify({ v: 2, e: [{ t: 1, z: "iktidar" }] }))).toEqual([]);
  });

  it("drops invalid entries and sorts the valid ones ascending by t", () => {
    const raw = JSON.stringify({
      v: 1,
      e: [
        { t: 300, z: "iktidar" },
        { t: "nope", z: "iktidar" }, // non-numeric t
        { t: 100, z: "bagimsiz" },
        { t: 200, z: "not-a-zone" }, // unknown zone
        { t: NaN, z: "muhalefet" }, // non-finite t
        { t: 250, z: "muhalefet" },
      ],
    });
    expect(parseDiet(raw)).toEqual([
      { t: 100, z: "bagimsiz" },
      { t: 250, z: "muhalefet" },
      { t: 300, z: "iktidar" },
    ]);
  });
});

describe("serializeDiet", () => {
  it("round-trips and keeps only t/z keys", () => {
    const entries: DietEntry[] = [{ t: 1, z: "iktidar" }];
    const withExtra = entries.map((e) => ({ ...e, extra: "drop-me" }));
    const json = serializeDiet(withExtra as unknown as DietEntry[]);
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({ v: 1, e: [{ t: 1, z: "iktidar" }] });
    expect(Object.keys(parsed.e[0])).toEqual(["t", "z"]);
    expect(parseDiet(json)).toEqual(entries);
  });
});

describe("pruneDiet", () => {
  it("keeps an entry exactly at the 30-day TTL boundary", () => {
    const boundary = NOW - DIET_TTL_DAYS * DAY_MS;
    const entries: DietEntry[] = [{ t: boundary, z: "iktidar" }];
    expect(pruneDiet(entries, NOW)).toEqual(entries);
  });

  it("drops an entry 1ms older than the TTL boundary", () => {
    const boundary = NOW - DIET_TTL_DAYS * DAY_MS - 1;
    const entries: DietEntry[] = [{ t: boundary, z: "iktidar" }];
    expect(pruneDiet(entries, NOW)).toEqual([]);
  });

  it("drops entries more than 60s in the future (clock skew)", () => {
    const entries: DietEntry[] = [
      { t: NOW + 60_000, z: "iktidar" }, // exactly at boundary: kept
      { t: NOW + 60_001, z: "bagimsiz" }, // past boundary: dropped
    ];
    expect(pruneDiet(entries, NOW)).toEqual([{ t: NOW + 60_000, z: "iktidar" }]);
  });

  it("caps at DIET_MAX_ENTRIES, keeping the newest", () => {
    const entries: DietEntry[] = Array.from({ length: DIET_MAX_ENTRIES + 10 }, (_, i) => ({
      t: NOW - (DIET_MAX_ENTRIES + 10 - i) * 1000,
      z: "iktidar" as const,
    }));
    const result = pruneDiet(entries, NOW);
    expect(result).toHaveLength(DIET_MAX_ENTRIES);
    expect(result[0]).toEqual(entries[10]);
    expect(result[result.length - 1]).toEqual(entries[entries.length - 1]);
  });
});

describe("appendDiet", () => {
  it("dedupes a same-zone click 1999ms after the previous entry", () => {
    const entries: DietEntry[] = [{ t: 1000, z: "iktidar" }];
    const result = appendDiet(entries, { t: 1000 + 1999, z: "iktidar" }, 1000 + 1999);
    expect(result).toEqual(entries);
  });

  it("keeps a same-zone click exactly 2000ms after the previous entry", () => {
    const entries: DietEntry[] = [{ t: 1000, z: "iktidar" }];
    const result = appendDiet(entries, { t: 1000 + 2000, z: "iktidar" }, 1000 + 2000);
    expect(result).toEqual([...entries, { t: 3000, z: "iktidar" }]);
  });

  it("keeps a different-zone click within the dedupe window", () => {
    const entries: DietEntry[] = [{ t: 1000, z: "iktidar" }];
    const result = appendDiet(entries, { t: 1500, z: "muhalefet" }, 1500);
    expect(result).toEqual([
      { t: 1000, z: "iktidar" },
      { t: 1500, z: "muhalefet" },
    ]);
  });
});

describe("dietEntryFromTrack", () => {
  it("counts outbound with a zone", () => {
    expect(dietEntryFromTrack("outbound", { zone: "iktidar" }, NOW)).toEqual({
      t: NOW,
      z: "iktidar",
    });
  });

  it("counts cta_other_side with a zone", () => {
    expect(dietEntryFromTrack("cta_other_side", { zone: "muhalefet" }, NOW)).toEqual({
      t: NOW,
      z: "muhalefet",
    });
  });

  it("ignores outbound without a zone", () => {
    expect(dietEntryFromTrack("outbound", { kind: "factcheck" }, NOW)).toBeNull();
  });

  // h47-personal-4: a click on a toplayıcı / niş point in the story timeline is
  // sent as {kind:'timeline-niche'} with no zone, because those sources are not
  // counted on the spectrum. The diet must read that as "not a read". This pins
  // the contract between story-timeline.tsx and the diet.
  it("ignores a non-voting (toplayıcı / niş) timeline click: kind only, no zone", () => {
    expect(dietEntryFromTrack("outbound", { kind: "timeline-niche" }, NOW)).toBeNull();
    expect(dietEntryFromTrack("cta_other_side", { kind: "timeline-niche" }, NOW)).toBeNull();
  });

  it("still counts a voting timeline click: zone plus kind 'timeline'", () => {
    expect(dietEntryFromTrack("outbound", { zone: "bagimsiz", kind: "timeline" }, NOW)).toEqual({
      t: NOW,
      z: "bagimsiz",
    });
  });

  it("ignores share, bookmark and search regardless of props", () => {
    expect(dietEntryFromTrack("share", { zone: "iktidar" }, NOW)).toBeNull();
    expect(dietEntryFromTrack("bookmark", { zone: "iktidar" }, NOW)).toBeNull();
    expect(dietEntryFromTrack("search", { zone: "iktidar" }, NOW)).toBeNull();
  });

  it("ignores an invalid zone string", () => {
    expect(
      dietEntryFromTrack("outbound", { zone: "invalid" as never }, NOW),
    ).toBeNull();
  });
});

describe("summarizeDiet", () => {
  it("counts an entry exactly at the 7-day boundary as within the week", () => {
    const entries: DietEntry[] = [{ t: NOW - DIET_WEEK_DAYS_MS(), z: "iktidar" }];
    const summary = summarizeDiet(entries, NOW);
    expect(summary.total).toBe(1);
  });

  it("excludes an entry 1ms older than the 7-day boundary from the week", () => {
    const entries: DietEntry[] = [{ t: NOW - DIET_WEEK_DAYS_MS() - 1, z: "iktidar" }];
    const summary = summarizeDiet(entries, NOW);
    expect(summary.total).toBe(0);
    expect(summary.total30d).toBe(1);
  });

  it("leastRead is null when the weekly total is 0", () => {
    const summary = summarizeDiet([], NOW);
    expect(summary.leastRead).toBeNull();
  });

  it("picks the zone with the strict minimum weekly count", () => {
    const entries: DietEntry[] = [
      { t: NOW, z: "iktidar" },
      { t: NOW, z: "iktidar" },
      { t: NOW, z: "bagimsiz" },
    ];
    const summary = summarizeDiet(entries, NOW);
    expect(summary.leastRead).toBe("muhalefet");
  });

  it("breaks a weekly tie using the lower 30-day count", () => {
    const entries: DietEntry[] = [
      // iktidar: 1 this week, 1 total(30d)
      { t: NOW, z: "iktidar" },
      // bagimsiz: 1 this week, but an older click pushes its 30d count to 2
      { t: NOW, z: "bagimsiz" },
      { t: NOW - 10 * DAY_MS, z: "bagimsiz" },
      // muhalefet: 1 this week, 1 total(30d)
      { t: NOW, z: "muhalefet" },
    ];
    const summary = summarizeDiet(entries, NOW);
    // iktidar and muhalefet tie on both week (1) and 30d (1); spectrum
    // order picks iktidar first.
    expect(summary.leastRead).toBe("iktidar");
  });

  it("falls back to spectrum order when week and 30d counts are all tied", () => {
    const entries: DietEntry[] = [
      { t: NOW, z: "iktidar" },
      { t: NOW, z: "bagimsiz" },
      { t: NOW, z: "muhalefet" },
    ];
    const summary = summarizeDiet(entries, NOW);
    expect(summary.leastRead).toBe(DIET_ZONES[0]);
  });

  it("sampleOk is false at 9 and true at 10", () => {
    const nine: DietEntry[] = Array.from({ length: 9 }, (_, i) => ({
      t: NOW - i,
      z: "iktidar" as const,
    }));
    const ten: DietEntry[] = Array.from({ length: 10 }, (_, i) => ({
      t: NOW - i,
      z: "iktidar" as const,
    }));
    expect(summarizeDiet(nine, NOW).sampleOk).toBe(false);
    expect(summarizeDiet(ten, NOW).sampleOk).toBe(true);
    expect(DIET_MIN_SAMPLE).toBe(10);
  });
});

// h55-personal-2: the /diyetim "En az okuduğunuz taraf" nudge used to point at
// `leastRead` even below the page's own 10-click floor, and `leastRead` breaks a
// full tie by spectrum order (Muhalefet never won). `nudgeZones` is the
// nudge's own selector: nothing below the floor, every still-tied zone
// instead of the first, nothing when no side is behind.
describe("nudgeZones", () => {
  function clicks(zone: DietZone, n: number, t = NOW): DietEntry[] {
    return Array.from({ length: n }, (_, i) => ({ t: t - i, z: zone }));
  }
  const nudgeFor = (entries: DietEntry[]) => nudgeZones(summarizeDiet(entries, NOW));

  it("is empty with 0 clicks", () => {
    expect(nudgeFor([])).toEqual([]);
  });

  it("is empty below the 10-click floor (9 clicks, all iktidar)", () => {
    expect(nudgeFor(clicks("iktidar", 9))).toEqual([]);
  });

  it("is empty for a single click, whichever side it was on", () => {
    for (const zone of DIET_ZONES) expect(nudgeFor(clicks(zone, 1)), zone).toEqual([]);
  });

  it("names both unread sides at the floor (10 clicks, all iktidar, no history)", () => {
    expect(nudgeFor(clicks("iktidar", 10))).toEqual(["bagimsiz", "muhalefet"]);
  });

  it("is not biased towards the spectrum-first side: 10 muhalefet clicks name iktidar and bagimsiz", () => {
    expect(nudgeFor(clicks("muhalefet", 10))).toEqual(["iktidar", "bagimsiz"]);
  });

  it("names the single zone with the strict weekly minimum (6/4/0)", () => {
    const entries = [...clicks("iktidar", 6), ...clicks("bagimsiz", 4)];
    expect(nudgeFor(entries)).toEqual(["muhalefet"]);
  });

  it("is empty when all three sides are tied (4/4/4)", () => {
    const entries = [...clicks("iktidar", 4), ...clicks("bagimsiz", 4), ...clicks("muhalefet", 4)];
    expect(nudgeFor(entries)).toEqual([]);
  });

  it("breaks a weekly tie between two sides by the lower 30-day count", () => {
    // 10 this week on iktidar; bagimsiz also has 2 older clicks (30d = 2), muhalefet none.
    const entries = [
      ...clicks("iktidar", 10),
      { t: NOW - 10 * DAY_MS, z: "bagimsiz" as const },
      { t: NOW - 11 * DAY_MS, z: "bagimsiz" as const },
    ];
    expect(nudgeFor(entries)).toEqual(["muhalefet"]);
  });

  it("keeps both sides when the weekly and the 30-day counts tie", () => {
    const entries = [
      ...clicks("iktidar", 10),
      { t: NOW - 10 * DAY_MS, z: "bagimsiz" as const },
      { t: NOW - 11 * DAY_MS, z: "muhalefet" as const },
    ];
    expect(nudgeFor(entries)).toEqual(["bagimsiz", "muhalefet"]);
  });

  it("returns the two lowest 30-day sides when the weekly counts are all tied but 30-day counts differ", () => {
    const entries = [
      ...clicks("iktidar", 4),
      ...clicks("bagimsiz", 4),
      ...clicks("muhalefet", 4),
      { t: NOW - 10 * DAY_MS, z: "bagimsiz" as const },
    ];
    expect(nudgeFor(entries)).toEqual(["iktidar", "muhalefet"]);
  });

  it("ignores clicks older than the week when checking the floor", () => {
    const entries = [...clicks("iktidar", 9), ...clicks("iktidar", 5, NOW - 9 * DAY_MS)];
    expect(nudgeFor(entries)).toEqual([]);
  });

  it("does not change summarizeDiet's leastRead contract (spectrum-order tie-break stays)", () => {
    const summary = summarizeDiet(clicks("iktidar", 10), NOW);
    expect(summary.leastRead).toBe("bagimsiz");
    expect(nudgeZones(summary)).toEqual(["bagimsiz", "muhalefet"]);
  });
});

function DIET_WEEK_DAYS_MS(): number {
  return 7 * DAY_MS;
}

// Sanity check the dedupe constant used in the appendDiet tests above lines
// up with the exported constant (guards against the tests and the module
// drifting independently).
describe("constants", () => {
  it("DIET_DEDUPE_MS is 2000", () => {
    expect(DIET_DEDUPE_MS).toBe(2000);
  });
});
