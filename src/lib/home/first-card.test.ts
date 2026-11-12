import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ClusterBundle,
  PoliticsClustersResult,
} from "@/lib/clusters/politics-query";
import { dayBucketOf, groupByDayBucket } from "@/lib/home/day-buckets";
import { HOME_PAGE_SIZE } from "@/lib/seo/home-canonical";

import { homeFirstCard } from "./first-card";

// h160-1: the home page preloads the first card's banner from the prerendered
// shell, so the shell has to pick the card HomeFeed will render at index 0
// WITHOUT reading the clock. homeFirstCard is that pick. These tests pin it
// against the page's own rule (breaking strip first, else the first card of
// the first day bucket of page 1), and against that rule evaluated at several
// request times.

type Feed = Pick<PoliticsClustersResult, "bundles" | "breakingBundles">;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Europe/Istanbul is a fixed UTC+3 (no DST since 2016).
const ISTANBUL_OFFSET = 3 * HOUR;

function bundleAt(id: string, firstPublished: string | number): ClusterBundle {
  const iso =
    typeof firstPublished === "number"
      ? new Date(firstPublished).toISOString()
      : firstPublished;
  return {
    cluster: { id, first_published: iso, updated_at: iso },
    articles: [],
    sources: [],
  } as unknown as ClusterBundle;
}

function feedOf(bundles: ClusterBundle[], breakingBundles: ClusterBundle[] = []): Feed {
  return { bundles, breakingBundles };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("homeFirstCard", () => {
  it("returns the first Son Dakika card when the breaking strip is not empty", () => {
    const breaking = [
      bundleAt("b0", "2026-11-12T08:00:00Z"),
      bundleAt("b1", "2026-11-12T08:30:00Z"),
    ];
    const ranked = [bundleAt("r0", "2026-11-12T08:45:00Z")];
    expect(homeFirstCard(feedOf(ranked, breaking))).toBe(breaking[0]);
  });

  it("a breaking id that is also in bundles is the breaking card, never the ranked copy", () => {
    const breakingCopy = bundleAt("same", "2026-11-12T08:00:00Z");
    const rankedCopy = bundleAt("same", "2026-11-12T08:00:00Z");
    const other = bundleAt("other", "2026-11-12T08:10:00Z");
    const picked = homeFirstCard(feedOf([rankedCopy, other], [breakingCopy]));
    expect(picked).toBe(breakingCopy);
    expect(picked).not.toBe(rankedCopy);
  });

  it("without a breaking strip: ranked[0] from yesterday and ranked[1] from today (Istanbul) gives ranked[1]", () => {
    // 2026-11-12 09:00Z is 12:00 in Istanbul; 11-11 15:00Z is 18:00 the day before.
    const yesterday = bundleAt("r0", "2026-11-11T15:00:00Z");
    const today = bundleAt("r1", "2026-11-12T09:00:00Z");
    expect(homeFirstCard(feedOf([yesterday, today]))).toBe(today);
  });

  it("keeps ranked order inside the first day bucket", () => {
    const a = bundleAt("a", "2026-11-12T06:00:00Z");
    const b = bundleAt("b", "2026-11-12T09:00:00Z");
    const c = bundleAt("c", "2026-11-12T07:00:00Z");
    expect(homeFirstCard(feedOf([a, b, c]))).toBe(a);
  });

  it("uses the Istanbul calendar day, not a 24 h window: 23:59 and 00:01 are different days", () => {
    // 20:59Z is 23:59 on 11-11 in Istanbul, 21:01Z is 00:01 on 11-12.
    const lateYesterday = bundleAt("late", "2026-11-11T20:59:00Z");
    const earlyToday = bundleAt("early", "2026-11-11T21:01:00Z");
    expect(homeFirstCard(feedOf([lateYesterday, earlyToday]))).toBe(earlyToday);
  });

  it("a 16th ranked item is never chosen, even when it is the newest", () => {
    const older = Array.from({ length: HOME_PAGE_SIZE }, (_, i) =>
      bundleAt(`old-${i}`, Date.parse("2026-11-11T12:00:00Z") + i * 60_000),
    );
    const sixteenth = bundleAt("sixteenth", "2026-11-12T09:00:00Z");
    const ranked = [...older, sixteenth];
    expect(ranked).toHaveLength(HOME_PAGE_SIZE + 1);
    // Page 1 is the 15 older stories, all from the same day: the first one wins.
    expect(homeFirstCard(feedOf(ranked))).toBe(older[0]);
  });

  it("an empty feed gives null", () => {
    expect(homeFirstCard(feedOf([]))).toBeNull();
  });

  it("falls back to ranked[0] when no first_published parses", () => {
    const a = bundleAt("a", "not a date");
    const b = bundleAt("b", "also not a date");
    expect(homeFirstCard(feedOf([a, b]))).toBe(a);
  });

  it("an unparseable stamp never wins over a parseable one", () => {
    const broken = bundleAt("broken", "garbage");
    const good = bundleAt("good", "2026-11-12T09:00:00Z");
    expect(homeFirstCard(feedOf([broken, good]))).toBe(good);
  });

  it("does not read the clock", () => {
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("homeFirstCard must not read the clock");
    });
    const feed = feedOf([
      bundleAt("a", "2026-11-11T15:00:00Z"),
      bundleAt("b", "2026-11-12T09:00:00Z"),
    ]);
    expect(homeFirstCard(feed)?.cluster.id).toBe("b");
    expect(now).not.toHaveBeenCalled();
  });

  it("does not mutate the feed it is given", () => {
    const ranked = [
      bundleAt("a", "2026-11-11T15:00:00Z"),
      bundleAt("b", "2026-11-12T09:00:00Z"),
    ];
    const breaking: ClusterBundle[] = [];
    const feed = feedOf(ranked, breaking);
    const before = JSON.stringify(feed);
    homeFirstCard(feed);
    expect(JSON.stringify(feed)).toBe(before);
    expect(feed.bundles).toBe(ranked);
    expect(feed.breakingBundles).toBe(breaking);
  });
});

// ---------------------------------------------------------------------------
// Parity with the request-time choice.
//
// HomeFeed buckets page 1 at the REQUEST time; homeFirstCard buckets it at its
// own newest story (no clock). They agree whenever the newest page-1 story is
// from today or yesterday (Istanbul), because then the first bucket is the
// newest story's calendar day either way.
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded PRNG (never Math.random, so a failure replays). */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomFeed(rand: () => number, feedIndex: number): Feed {
  const base = Date.parse("2026-11-12T12:00:00Z");
  const stamp = () => base - Math.floor(rand() * 40 * HOUR);
  const size = Math.floor(rand() * 31); // 0..30: empty, short and past one page
  const bundles = Array.from({ length: size }, (_, i) =>
    bundleAt(`f${feedIndex}-r${i}`, stamp()),
  );
  const breaking: ClusterBundle[] = [];
  if (rand() < 0.25) {
    const n = 1 + Math.floor(rand() * 3);
    for (let i = 0; i < n; i++) {
      // Half of them overlap a ranked bundle (same id), as the real feed allows.
      const twin = bundles[i];
      breaking.push(
        twin !== undefined && rand() < 0.5
          ? bundleAt(twin.cluster.id, Date.parse(twin.cluster.first_published))
          : bundleAt(`f${feedIndex}-b${i}`, stamp()),
      );
    }
  }
  return { bundles, breakingBundles: breaking };
}

/** The request-time rule, written out independently of homeFirstCard. */
function requestTimeFirst(feed: Feed, nowMs: number): ClusterBundle | null {
  const first = feed.breakingBundles[0];
  if (first !== undefined) return first;
  const paged = feed.bundles.slice(0, HOME_PAGE_SIZE);
  return (
    groupByDayBucket(paged, (b) => Date.parse(b.cluster.first_published), nowMs)[0]
      ?.items[0] ?? null
  );
}

function nextIstanbulMidnight(ms: number): number {
  return Math.floor((ms + ISTANBUL_OFFSET) / DAY) * DAY + DAY - ISTANBUL_OFFSET;
}

describe("homeFirstCard parity with the request-time choice", () => {
  it("200 seeded feeds, four request times each: same card whenever the newest page-1 story is today or yesterday", () => {
    const rand = seeded(160_001);
    let compared = 0;
    let withBreaking = 0;
    let acrossMidnight = 0;
    for (let f = 0; f < 200; f++) {
      const feed = randomFeed(rand, f);
      const paged = feed.bundles.slice(0, HOME_PAGE_SIZE);
      const stamps = paged
        .map((b) => Date.parse(b.cluster.first_published))
        .filter(Number.isFinite);
      const newest = stamps.length > 0 ? Math.max(...stamps) : Date.parse("2026-11-12T12:00:00Z");
      const nowTimes = [
        newest,
        newest + HOUR,
        nextIstanbulMidnight(newest) + 60_000,
        newest + 20 * HOUR,
      ];
      const picked = homeFirstCard(feed);
      for (const nowMs of nowTimes) {
        const bucket = dayBucketOf(newest, nowMs);
        if (bucket !== "today" && bucket !== "yesterday") continue;
        const expected = requestTimeFirst(feed, nowMs);
        expect(picked, `feed ${f} at ${new Date(nowMs).toISOString()}`).toBe(expected);
        compared++;
        if (feed.breakingBundles.length > 0) withBreaking++;
        if (nowMs === nowTimes[2]) acrossMidnight++;
      }
    }
    // Not vacuous: most of the 800 (feed, time) pairs qualify, and the sample
    // holds feeds with a breaking strip and requests just after midnight.
    expect(compared).toBeGreaterThan(400);
    expect(withBreaking).toBeGreaterThan(20);
    expect(acrossMidnight).toBeGreaterThan(50);
  });
});
