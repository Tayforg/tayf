import { describe, expect, it, vi } from "vitest";

// day-buckets imports istanbulDayKey from the trends module, which pulls in
// next/cache; stub it the same way daily-zones.test.ts does. The module under
// test is pure and never touches the cache or Supabase.
vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

import { DAY_BUCKETS, dayBucketOf, groupByDayBucket } from "./day-buckets";

// The home feed labels its sections by the Europe/Istanbul calendar day the
// story broke, not by "less than 24 h ago": at 00:05 local, a story from
// 23:30 the evening before is "Dün", not "Bugün" (h15-tz-1, verified on prod
// 2026-11-01 21:24Z = 02.11 00:25 TRT, where 12 of 14 "Bugün" cards were
// yesterday's news).

const DAY = 24 * 60 * 60 * 1000;
const iso = (s: string) => Date.parse(s);

describe("DAY_BUCKETS", () => {
  it("lists the four buckets in display order with their Turkish labels", () => {
    expect(DAY_BUCKETS).toEqual([
      { key: "today", label: "Bugün" },
      { key: "yesterday", label: "Dün" },
      { key: "last7Days", label: "Son 7 gün" },
      { key: "older", label: "Daha eski" },
    ]);
  });

  it("never says 'Bu hafta' (the window is rolling, not a calendar week)", () => {
    for (const { label } of DAY_BUCKETS) {
      expect(label.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
    }
  });
});

describe("dayBucketOf — just after Istanbul midnight", () => {
  // 2026-11-01T21:05Z is 02.11 00:05 in Istanbul (UTC+3).
  const now = iso("2026-11-01T21:05:00Z");

  it("puts a story from 23:30 the evening before under 'yesterday'", () => {
    expect(dayBucketOf(iso("2026-11-01T20:30:00Z"), now)).toBe("yesterday");
  });

  it("puts a story from 00:02 today under 'today'", () => {
    expect(dayBucketOf(iso("2026-11-01T21:02:00Z"), now)).toBe("today");
  });

  it("puts 01.11 00:03 (21:03Z the day before) under 'yesterday'", () => {
    expect(dayBucketOf(iso("2026-10-31T21:03:00Z"), now)).toBe("yesterday");
  });

  it("puts the last second of the day before yesterday under 'last7Days'", () => {
    // 01.11 00:00 TRT is 2026-10-31T21:00Z, so 20:59:59Z is still 31.10.
    expect(dayBucketOf(iso("2026-10-31T20:59:59Z"), now)).toBe("last7Days");
  });
});

describe("dayBucketOf — the 23:59 / 00:00 Istanbul edge", () => {
  // 2026-11-01T20:59:59Z is 01.11 23:59:59 in Istanbul.
  const now = iso("2026-11-01T20:59:59Z");

  it("treats 01.11 00:00:00 TRT as today", () => {
    expect(dayBucketOf(iso("2026-10-31T21:00:00Z"), now)).toBe("today");
  });

  it("treats 31.10 23:59:59 TRT as yesterday", () => {
    expect(dayBucketOf(iso("2026-10-31T20:59:59Z"), now)).toBe("yesterday");
  });

  it("flips one second later: the same instant is 'yesterday' once now crosses midnight", () => {
    const afterMidnight = iso("2026-11-01T21:00:00Z");
    expect(dayBucketOf(iso("2026-10-31T21:00:00Z"), afterMidnight)).toBe("yesterday");
    expect(dayBucketOf(iso("2026-11-01T21:00:00Z"), afterMidnight)).toBe("today");
  });
});

describe("dayBucketOf — rolling seven days", () => {
  const now = iso("2026-11-01T12:00:00Z");

  it("labels 3 days ago as last7Days", () => {
    expect(dayBucketOf(now - 3 * DAY, now)).toBe("last7Days");
  });

  it("labels 6.9 days ago as last7Days", () => {
    expect(dayBucketOf(now - 6.9 * DAY, now)).toBe("last7Days");
  });

  it("labels exactly 7 days ago as older", () => {
    expect(dayBucketOf(now - 7 * DAY, now)).toBe("older");
  });

  it("labels one millisecond inside 7 days as last7Days", () => {
    expect(dayBucketOf(now - 7 * DAY + 1, now)).toBe("last7Days");
  });

  it("labels a month ago as older", () => {
    expect(dayBucketOf(now - 30 * DAY, now)).toBe("older");
  });

  it("labels the start of the Istanbul day before yesterday as last7Days", () => {
    // 2026-11-01T12:00Z is 15:00 on 01.11; yesterday is 31.10, so 30.10 is last7Days.
    expect(dayBucketOf(iso("2026-10-29T21:00:00Z"), now)).toBe("last7Days");
  });
});

describe("dayBucketOf — unusual input", () => {
  const now = iso("2026-11-01T12:00:00Z");

  it("treats a future timestamp (clock skew) as today", () => {
    expect(dayBucketOf(now + 1, now)).toBe("today");
    expect(dayBucketOf(now + 3 * DAY, now)).toBe("today");
  });

  it("treats NaN as older", () => {
    expect(dayBucketOf(Number.NaN, now)).toBe("older");
  });

  it("treats Infinity as older instead of throwing", () => {
    expect(dayBucketOf(Number.POSITIVE_INFINITY, now)).toBe("older");
    expect(dayBucketOf(Number.NEGATIVE_INFINITY, now)).toBe("older");
  });

  it("treats a non-finite now as older instead of throwing", () => {
    expect(dayBucketOf(now, Number.NaN)).toBe("older");
  });

  it("handles the epoch", () => {
    expect(dayBucketOf(0, now)).toBe("older");
  });
});

describe("groupByDayBucket", () => {
  const now = iso("2026-11-01T21:05:00Z");
  const msOf = (item: { at: string }) => Date.parse(item.at);

  it("returns only the non-empty buckets, in display order", () => {
    const items = [
      { id: "old", at: "2026-10-01T10:00:00Z" },
      { id: "now", at: "2026-11-01T21:02:00Z" },
    ];

    const groups = groupByDayBucket(items, msOf, now);

    expect(groups.map((g) => g.key)).toEqual(["today", "older"]);
    expect(groups.map((g) => g.label)).toEqual(["Bugün", "Daha eski"]);
  });

  it("carries count and the original items, keeping input order inside a bucket", () => {
    const items = [
      { id: "a", at: "2026-11-01T20:30:00Z" },
      { id: "b", at: "2026-11-01T10:00:00Z" },
      { id: "c", at: "2026-11-01T18:00:00Z" },
    ];

    const [group, ...rest] = groupByDayBucket(items, msOf, now);

    expect(rest).toEqual([]);
    expect(group).toEqual({
      key: "yesterday",
      label: "Dün",
      count: 3,
      items,
    });
    expect(group!.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });

  it("returns an empty array for no items", () => {
    expect(groupByDayBucket([], msOf, now)).toEqual([]);
  });

  it("places an item with an unparseable date under 'Daha eski'", () => {
    const groups = groupByDayBucket([{ at: "not-a-date" }], msOf, now);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "older", label: "Daha eski", count: 1 });
  });

  it("does not mutate its input", () => {
    const items = [
      { id: "a", at: "2026-11-01T21:02:00Z" },
      { id: "b", at: "2026-10-01T10:00:00Z" },
    ];
    const snapshot = structuredClone(items);

    groupByDayBucket(items, msOf, now);

    expect(items).toEqual(snapshot);
  });

  it("every item lands in exactly one bucket (10k items)", () => {
    const items = Array.from({ length: 10_000 }, (_, i) => ({
      at: new Date(now - i * 37 * 60 * 1000).toISOString(),
    }));

    const groups = groupByDayBucket(items, msOf, now);
    const total = groups.reduce((sum, g) => sum + g.count, 0);

    expect(total).toBe(10_000);
    expect(groups.every((g) => g.count === g.items.length)).toBe(true);
  });

  it("splits the 2026-11-01 prod snapshot into Bugün 2, Dün 17, Son 7 gün 1", () => {
    // Verified at 2026-11-01T21:24:58Z (02.11 00:25 TRT): 2 stories on 02.11
    // (00:02, 00:11), 17 on 01.11 (23:15 ... 08:23) and 1 on 31.10 21:03 TRT.
    const snapshotNow = iso("2026-11-01T21:24:58Z");
    const trt = (day: string, hhmm: string) => Date.parse(`${day}T${hhmm}:00+03:00`);
    const stories = [
      { id: "t1", ms: trt("2026-11-02", "00:02") },
      { id: "t2", ms: trt("2026-11-02", "00:11") },
      ...[
        "23:15",
        "22:56",
        "21:30",
        "20:10",
        "19:44",
        "18:20",
        "17:05",
        "16:41",
        "15:30",
        "14:02",
        "13:37",
        "12:18",
        "11:58",
        "10:20",
        "09:41",
        "08:23",
        "00:03",
      ].map((hhmm, i) => ({ id: `y${i + 1}`, ms: trt("2026-11-01", hhmm) })),
      { id: "w1", ms: trt("2026-10-31", "21:03") },
    ];
    expect(stories).toHaveLength(20);

    const groups = groupByDayBucket(stories, (s) => s.ms, snapshotNow);

    expect(groups.map((g) => [g.label, g.count])).toEqual([
      ["Bugün", 2],
      ["Dün", 17],
      ["Son 7 gün", 1],
    ]);
  });
});
