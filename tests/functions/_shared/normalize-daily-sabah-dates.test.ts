import { describe, expect, it } from "vitest";
import fixture from "../../../supabase/functions/_shared/rss/__fixtures__/daily-sabah-dates.json";
import {
  cleanFeedDate,
  isParseableFeedDate,
} from "../../../supabase/functions/_shared/rss/dates.ts";
import { computeFeedFreshness } from "../../../supabase/functions/_shared/rss/feed-freshness.ts";
import type {
  RawFeedItem,
  RssSource,
} from "../../../supabase/functions/_shared/rss/fetcher.ts";
import {
  normalizeItem,
  parseDate,
} from "../../../supabase/functions/_shared/rss/normalize.ts";

// ---------------------------------------------------------------------------
// h42-latency-2 -- Daily Sabah stores ~17% of its items 3 h too early.
//
// The feed (https://www.dailysabah.com/rss/home-page) mixes two kinds of
// <pubDate>, both labelled "+0300":
//
//   * minute precision, seconds ":00"  -- honest Istanbul time;
//   * seconds precision (":18", ":26"...) -- the clock is UTC, only the label
//     says +0300. Read at face value the instant lands 3 h in the past
//     (Thu, 05 Nov 2026 13:54:18 +0300 was ingested at 13:57Z, not 16:57Z).
//
// The fixture is a trimmed capture of the live feed (see its "note") with the
// real ingest instant of each stored row. The rule is per source (a Set of
// slugs) because the discriminator, a non-zero seconds field, is the normal
// shape of EVERY other outlet's correct "+0300" stamp: 43,765 seconds-precision
// rows from 88 other sources were stored in the 7 days before this fix.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const HOUR = 3_600_000;

interface FixtureItem {
  title: string;
  link: string;
  pubDate: string;
  ingestedAt: string | null;
}

const SECONDS_ITEMS: FixtureItem[] = fixture.secondsPrecision;
const MINUTE_ITEMS: FixtureItem[] = fixture.minutePrecision;

// What the engine makes of the string at face value (the label honoured).
// Both pubDate and the numeric offset are explicit, so this is runtime-TZ
// independent.
const atFaceValue = (raw: string): string => new Date(Date.parse(raw)).toISOString();
// The same wall clock read as UTC: the instant the item was really published.
const wallClockAsUtc = (raw: string): number =>
  Date.parse(raw.replace(/ \+0300$/, " GMT"));

// 88 distinct sources that stored rows in the 7 days before the fix (read-only
// query, 2026-11-05), every slug except daily-sabah.
const OTHER_LIVE_SLUGS: string[] = [
  "a-haber", "a-news", "abc-haber", "acik-gazete", "agos", "ajans-haber", "aksam",
  "anadolu-ajansi", "aydinlik", "aykiri", "bbc-turkce", "beyaz-gazete", "bha",
  "bianet", "bir-gazete", "birgun", "bloomberg-ht", "cgtn-turk", "cnn-turk",
  "cumhuriyet", "demokrat-haber", "dijital-gaste", "diken", "dirilis-postasi",
  "diyanet-haber", "dokuz8-haber", "dunya", "dw-turkce", "ekonomim", "elips-haber",
  "en-politik", "euronews-turkce", "evrensel", "f5-haber", "fayn", "gazete-oksijen",
  "gzt", "haber-com", "haber-global", "haber7", "haberet", "haberler-com", "haberport",
  "haberturk", "habervakti", "hukuki-haber", "hurriyet", "hurriyet-daily-news",
  "iklim-haber", "ilke-tv", "indyturk", "isci-haber", "isin-detayi", "istiklal",
  "journo", "kamudanhaber", "karar", "kisa-dalga", "korkusuz", "medyascope",
  "mfa-turkey", "milat", "milliyet", "muhalif", "mynet", "newslab-turkey", "odatv",
  "on-haber", "onedio", "platform-24", "posta", "sabah", "serbestiyet", "son-dakika",
  "sozcu", "sputnik-turkce", "star", "takvim", "tele1", "trt-haber", "trt-world",
  "turkiye-gazetesi", "turkiye-haber-ajansi", "yeni-akit", "yeni-asir", "yeni-mesaj",
  "yeni-safak", "yenicag",
];

const SOURCE = (slug: string): RssSource => ({
  id: "00000000-0000-0000-0000-000000000042",
  name: slug,
  slug,
  url: "https://example.test",
  rss_url: "https://example.test/rss",
});

describe("daily-sabah-dates fixture", () => {
  it("holds five seconds-precision and five minute-precision pubDates, all labelled +0300", () => {
    expect(SECONDS_ITEMS).toHaveLength(5);
    expect(MINUTE_ITEMS).toHaveLength(5);
    for (const it of SECONDS_ITEMS) {
      expect(it.pubDate).toMatch(/ \d\d:\d\d:(?!00)\d\d \+0300$/);
    }
    for (const it of MINUTE_ITEMS) {
      expect(it.pubDate).toMatch(/ \d\d:\d\d:00 \+0300$/);
    }
    for (const it of [...SECONDS_ITEMS, ...MINUTE_ITEMS]) {
      expect(it.link).toMatch(/^https:\/\/www\.dailysabah\.com\//);
      expect(it.ingestedAt).toMatch(/^2026-11-05T\d\d:\d\d:\d\d\.\d{3}Z$/);
    }
  });

  it("proves the branch: the wall clock of every seconds-precision item is UTC, every :00 label is honest", () => {
    for (const it of SECONDS_ITEMS) {
      const gap = Date.parse(it.ingestedAt!) - wallClockAsUtc(it.pubDate);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(10 * MIN);
    }
    for (const it of MINUTE_ITEMS) {
      const gap = Date.parse(it.ingestedAt!) - Date.parse(it.pubDate);
      expect(gap).toBeGreaterThan(0);
      expect(gap).toBeLessThanOrEqual(35 * MIN);
    }
  });
});

describe("parseDate: daily-sabah seconds-precision +0300 stamps are UTC wall-clock [h42-latency-2]", () => {
  it.each(SECONDS_ITEMS.map((i) => [i.pubDate, i] as const))(
    "%s -> the wall clock read as UTC, within 15 min before a now 3 min after publish",
    (raw) => {
      const publishedMs = wallClockAsUtc(raw);
      const nowMs = publishedMs + 3 * MIN;
      const iso = parseDate(raw, { nowMs, sourceSlug: "daily-sabah" });
      expect(iso).toBe(new Date(publishedMs).toISOString());
      expect(nowMs - Date.parse(iso)).toBeGreaterThanOrEqual(0);
      expect(nowMs - Date.parse(iso)).toBeLessThanOrEqual(15 * MIN);
      // Today (before the fix) this is exactly 3 h earlier.
      expect(iso).not.toBe(atFaceValue(raw));
    },
  );

  it.each(SECONDS_ITEMS.map((i) => [i.pubDate, i.ingestedAt!] as const))(
    "%s -> lands 0-10 min before the real ingest instant %s",
    (raw, ingestedAt) => {
      const nowMs = Date.parse(ingestedAt);
      const iso = parseDate(raw, { nowMs, sourceSlug: "daily-sabah" });
      expect(nowMs - Date.parse(iso)).toBeGreaterThan(0);
      expect(nowMs - Date.parse(iso)).toBeLessThanOrEqual(10 * MIN);
    },
  );

  it.each(MINUTE_ITEMS.map((i) => [i.pubDate, i.ingestedAt!] as const))(
    "%s (:00) parses exactly as before: the +0300 label is honoured",
    (raw, ingestedAt) => {
      const iso = parseDate(raw, {
        nowMs: Date.parse(ingestedAt),
        sourceSlug: "daily-sabah",
      });
      expect(iso).toBe(atFaceValue(raw));
      expect(Date.parse(ingestedAt) - Date.parse(iso)).toBeLessThanOrEqual(35 * MIN);
    },
  );

  it("the ISO form of the same stamp (+03:00, with or without a fraction) gets the same reading", () => {
    const nowMs = Date.parse("2026-11-05T14:00:00Z");
    expect(
      parseDate("2026-11-05T13:54:18+03:00", { nowMs, sourceSlug: "daily-sabah" }),
    ).toBe("2026-11-05T13:54:18.000Z");
    expect(
      parseDate("2026-11-05T13:54:18.250+03:00", { nowMs, sourceSlug: "daily-sabah" }),
    ).toBe("2026-11-05T13:54:18.250Z");
    expect(
      parseDate("2026-11-05 13:54:18 +0300", { nowMs, sourceSlug: "daily-sabah" }),
    ).toBe("2026-11-05T13:54:18.000Z");
  });

  it("minute precision in any shape is left alone: no seconds field, or ':00'", () => {
    const nowMs = Date.parse("2026-11-05T14:00:00Z");
    for (const raw of [
      "2026-11-05T13:54:00+03:00",
      "2026-11-05T13:54+03:00",
      "Thu, 05 Nov 2026 13:54:00 +03:00",
    ]) {
      expect(parseDate(raw, { nowMs, sourceSlug: "daily-sabah" })).toBe(
        "2026-11-05T10:54:00.000Z",
      );
    }
  });

  it("only the mislabelled +03:00 offset is reinterpreted: Z, GMT, other offsets and zone-less stay as before", () => {
    const nowMs = Date.parse("2026-11-05T20:00:00Z");
    const slug = { nowMs, sourceSlug: "daily-sabah" };
    // A truthful UTC label with seconds is NOT shifted (no cnn-turk-style correction either).
    expect(parseDate("Thu, 05 Nov 2026 13:54:18 GMT", slug)).toBe("2026-11-05T13:54:18.000Z");
    expect(parseDate("2026-11-05T13:54:18Z", slug)).toBe("2026-11-05T13:54:18.000Z");
    expect(parseDate("2026-11-05T13:54:18+00:00", slug)).toBe("2026-11-05T13:54:18.000Z");
    expect(parseDate("2026-11-05T13:54:18+01:00", slug)).toBe("2026-11-05T12:54:18.000Z");
    expect(parseDate("Thu, 05 Nov 2026 13:54:18 -0500", slug)).toBe("2026-11-05T18:54:18.000Z");
    // Zone-less is still rule 2 (Istanbul), not UTC: the fixture proves no such shape.
    expect(parseDate("2026-11-05 13:54:18", slug)).toBe("2026-11-05T10:54:18.000Z");
    expect(parseDate("Thu, 05 Nov 2026 13:54:18", slug)).toBe("2026-11-05T10:54:18.000Z");
  });

  it("rolls the day over correctly: 00:30:05 +0300 on the 6th is 00:30:05Z on the 6th", () => {
    const nowMs = Date.parse("2026-11-06T01:00:00Z");
    expect(
      parseDate("Fri, 06 Nov 2026 00:30:05 +0300", { nowMs, sourceSlug: "daily-sabah" }),
    ).toBe("2026-11-06T00:30:05.000Z");
    // Not season dependent (Turkey has no DST; the label is constant).
    expect(
      parseDate("Mon, 12 Jan 2026 09:00:07 +0300", {
        nowMs: Date.parse("2026-01-12T10:00:00Z"),
        sourceSlug: "daily-sabah",
      }),
    ).toBe("2026-01-12T09:00:07.000Z");
  });

  it("keeps the rule-4 clamp: a reinterpreted instant is never later than nowMs", () => {
    const raw = "Thu, 05 Nov 2026 13:54:18 +0300";
    const nowMs = wallClockAsUtc(raw) - 10 * MIN; // feed clock ahead of ingest clock
    expect(parseDate(raw, { nowMs, sourceSlug: "daily-sabah" })).toBe(
      new Date(nowMs).toISOString(),
    );
    // One second of slack both ways.
    expect(
      parseDate(raw, { nowMs: wallClockAsUtc(raw), sourceSlug: "daily-sabah" }),
    ).toBe("2026-11-05T13:54:18.000Z");
    expect(
      parseDate(raw, { nowMs: wallClockAsUtc(raw) - 1000, sourceSlug: "daily-sabah" }),
    ).toBe("2026-11-05T13:54:17.000Z");
  });

  it("unparseable or empty input still falls back to nowMs for daily-sabah", () => {
    const nowMs = Date.parse("2026-11-05T14:00:00Z");
    for (const raw of ["not a date", "", "   ", undefined, "Thu, 05 Nov 2026 13:54:18 +0300 trailing"]) {
      expect(parseDate(raw, { nowMs, sourceSlug: "daily-sabah" })).toBe(
        new Date(nowMs).toISOString(),
      );
    }
  });
});

describe("parseDate: no other source's dates change [h42-latency-2]", () => {
  it("a seconds-precision +0300 stamp keeps the +0300 reading with no slug", () => {
    for (const it of SECONDS_ITEMS) {
      const nowMs = wallClockAsUtc(it.pubDate) + 3 * MIN;
      expect(parseDate(it.pubDate, { nowMs })).toBe(atFaceValue(it.pubDate));
    }
  });

  it("sabah (the Turkish daily), the lookalike slugs and cnn-turk keep today's result", () => {
    for (const slug of [
      "sabah",
      "daily-sabah-tr",
      "daily-sabah ",
      "Daily-Sabah",
      "DAILY-SABAH",
      "dailysabah",
      "hurriyet-daily-news",
      "cnn-turk",
      "",
    ]) {
      for (const it of SECONDS_ITEMS) {
        const nowMs = wallClockAsUtc(it.pubDate) + 3 * MIN;
        expect(parseDate(it.pubDate, { nowMs, sourceSlug: slug })).toBe(
          atFaceValue(it.pubDate),
        );
      }
    }
  });

  it("every one of the 88 other live sources keeps the +0300 reading of a seconds-precision stamp", () => {
    expect(OTHER_LIVE_SLUGS).toHaveLength(88);
    expect(new Set(OTHER_LIVE_SLUGS).size).toBe(88);
    expect(OTHER_LIVE_SLUGS).not.toContain("daily-sabah");
    const raw = SECONDS_ITEMS[0]!.pubDate;
    const nowMs = wallClockAsUtc(raw) + 3 * MIN;
    for (const sourceSlug of OTHER_LIVE_SLUGS) {
      expect(parseDate(raw, { nowMs, sourceSlug })).toBe(atFaceValue(raw));
    }
  });

  it("every other source, every date shape: same instant as with no slug", () => {
    const nowMs = Date.parse("2026-11-05T20:00:00Z");
    const shapes = [
      ...SECONDS_ITEMS.map((i) => i.pubDate),
      ...MINUTE_ITEMS.map((i) => i.pubDate),
      "2026-11-05T13:54:18+03:00",
      "2026-11-05T13:54:18.250+03:00",
      "2026-11-05T13:54:18Z",
      "Thu, 05 Nov 2026 13:54:18 GMT",
      "2026-11-05 13:54:18",
      "Thu, 05 Nov 2026 13:54:18",
      "Thu, 05 Nov 2026 13:54:18 -0500",
      "not a date",
    ];
    for (const sourceSlug of OTHER_LIVE_SLUGS) {
      // cnn-turk's own rule 3 is the only per-source difference that already exists.
      if (sourceSlug === "cnn-turk") continue;
      for (const raw of shapes) {
        expect(parseDate(raw, { nowMs, sourceSlug })).toBe(parseDate(raw, { nowMs }));
      }
    }
  });
});

describe("ingest wiring: daily-sabah rows get the right published_at [h42-latency-2]", () => {
  const rawItem = (pubDate: string): RawFeedItem => ({
    title: "Istanbul summit aims to boost co-op in Turkic cinema",
    link: "https://www.dailysabah.com/arts/cinema/istanbul-summit-aims-to-boost-co-op-in-turkic-cinema",
    pubDate,
  });

  it("normalizeItem stores the UTC wall clock for a seconds-precision stamp", () => {
    const it0 = SECONDS_ITEMS[0]!;
    const row = normalizeItem(
      SOURCE("daily-sabah"),
      rawItem(it0.pubDate),
      Date.parse(it0.ingestedAt!),
    );
    expect(row?.published_at).toBe("2026-11-05T13:54:18.000Z");
  });

  it("normalizeItem keeps the +0300 reading for a :00 stamp and for any other source", () => {
    const it0 = SECONDS_ITEMS[0]!;
    const nowMs = Date.parse(it0.ingestedAt!);
    expect(
      normalizeItem(SOURCE("sabah"), rawItem(it0.pubDate), nowMs)?.published_at,
    ).toBe("2026-11-05T10:54:18.000Z");
    const m0 = MINUTE_ITEMS[0]!;
    expect(
      normalizeItem(SOURCE("daily-sabah"), rawItem(m0.pubDate), Date.parse(m0.ingestedAt!))
        ?.published_at,
    ).toBe("2026-11-05T17:04:00.000Z");
  });

  it("the date cleaner leaves the stamp alone and the feed-date check still accepts it", () => {
    for (const it of SECONDS_ITEMS) {
      expect(cleanFeedDate(it.pubDate, "daily-sabah")).toBe(it.pubDate);
      expect(isParseableFeedDate(it.pubDate, "daily-sabah")).toBe(true);
    }
  });

  it("feed freshness (no-clamp parse) reads the reinterpreted instant and never a future one", () => {
    const items: RawFeedItem[] = SECONDS_ITEMS.map((i) => ({ pubDate: i.pubDate }));
    const nowMs = Date.parse(fixture.fetchedAt);
    const fresh = computeFeedFreshness(items, nowMs, "daily-sabah");
    // Newest seconds-precision stamp: 13:54:18 UTC (not 10:54:18Z at face value).
    expect(fresh.newestItemAt).toBe("2026-11-05T13:54:18.000Z");
    expect(Date.parse(fresh.newestItemAt!)).toBeLessThanOrEqual(nowMs);
    expect(nowMs - Date.parse(fresh.newestItemAt!)).toBeLessThan(4 * HOUR);
    // Another source reading the same strings is unchanged.
    expect(computeFeedFreshness(items, nowMs, "sabah").newestItemAt).toBe(
      "2026-11-05T10:54:18.000Z",
    );
  });
});
