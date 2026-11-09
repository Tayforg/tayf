import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { SourceFeedStatus } from "@/lib/sources/feed-status";

import {
  darkVotingSourcesInWindow,
  istanbulDayStartIso,
  type DarkZoneGroup,
} from "./dark-sources";

// ---------------------------------------------------------------------------
// h90-trends-2: the /trends 30-day chart shows a feed outage as editorial
// change. Five voting outlets went dark inside the window (15-25 Oct 2026) and
// caused the whole visible drift in zone shares. `darkVotingSourcesInWindow` picks
// the sources that DELIVERED inside the window and then stopped, so the page can
// say so. Pure: it reads `silent` (72 h, computed inside getSourceFeedStatuses'
// cache scope), `silenceReason` and `lastItemAt` from the rows and never the
// clock. Only a feed Tayf cannot fetch ('erisim_yok') counts: a feed that answers
// but has no new item (a weekly outlet such as Bianet) is not an outage.
// ---------------------------------------------------------------------------

// First chart bucket of the fixture window: 2026-10-10 (Istanbul), i.e. 00:00 at
// UTC+3 = 2026-10-09T21:00:00.000Z.
const WINDOW_START = "2026-10-09T21:00:00.000Z";

// The defaults are a real outage: the feed answers 403, has failed 38 times in a
// row and is quarantined, so the classifier says 'erisim_yok'.
function row(over: Partial<SourceFeedStatus> = {}): SourceFeedStatus {
  return {
    slug: "halk-tv",
    name: "Halk TV",
    bias: "opposition_leaning",
    zone: "muhalefet",
    kind: "outlet",
    lastItemAt: "2026-10-16T09:00:00+00:00",
    lastHttpStatus: 403,
    lastFetchAt: "2026-11-09T01:00:00+00:00",
    silent: true,
    failStreak: 38,
    quarantined: true,
    silenceReason: "erisim_yok",
    ...over,
  };
}

describe("istanbulDayStartIso", () => {
  it("is 00:00 Europe/Istanbul of the day, as a UTC instant", () => {
    expect(istanbulDayStartIso("2026-10-10")).toBe("2026-10-09T21:00:00.000Z");
    expect(istanbulDayStartIso("2026-11-09")).toBe("2026-11-08T21:00:00.000Z");
  });

  it("crosses a month and a year boundary", () => {
    expect(istanbulDayStartIso("2026-11-01")).toBe("2026-10-31T21:00:00.000Z");
    expect(istanbulDayStartIso("2027-01-01")).toBe("2026-12-31T21:00:00.000Z");
  });

  it("accepts a real leap day", () => {
    expect(istanbulDayStartIso("2024-02-29")).toBe("2024-02-28T21:00:00.000Z");
  });

  it("returns '' for anything that is not a YYYY-MM-DD day (never throws)", () => {
    // "2026-02-31" and friends parse (V8 rolls them into the next month), so only
    // the round-trip check rejects them.
    for (const bad of [
      "",
      "2026-10",
      "2026-13-40",
      "not a day",
      "2026-10-10T00:00:00Z",
      "10/10/2026",
      "2026-02-31",
      "2026-02-30",
      "2026-04-31",
      "2025-02-29",
    ]) {
      expect(() => istanbulDayStartIso(bad), bad).not.toThrow();
      expect(istanbulDayStartIso(bad), bad).toBe("");
    }
  });
});

describe("darkVotingSourcesInWindow", () => {
  it("(a) lists a silent outlet whose last item is inside the window, under its zone", () => {
    const out = darkVotingSourcesInWindow([row()], WINDOW_START);
    expect(out).toEqual([{ zone: "muhalefet", names: ["Halk TV"] }]);
  });

  it("(a) a silent wire counts like an outlet", () => {
    const out = darkVotingSourcesInWindow(
      [row({ kind: "wire", name: "Bir Ajans", zone: "bagimsiz", bias: "center" })],
      WINDOW_START,
    );
    expect(out).toEqual([{ zone: "bagimsiz", names: ["Bir Ajans"] }]);
  });

  it("(b) a source whose last item is before the window is excluded: it was absent every day, so it moves no share", () => {
    const out = darkVotingSourcesInWindow(
      [row({ lastItemAt: "2026-10-09T20:59:59+00:00" })],
      WINDOW_START,
    );
    expect(out).toEqual([]);
  });

  it("(b) a last item exactly at the window start is inside it (>=)", () => {
    const out = darkVotingSourcesInWindow([row({ lastItemAt: WINDOW_START })], WINDOW_START);
    expect(out).toHaveLength(1);
  });

  it("(b) compares instants, not strings: an item written with a +03:00 offset is placed correctly", () => {
    // 2026-10-10T00:30:00+03:00 = 2026-10-09T21:30:00Z, after the window start.
    expect(
      darkVotingSourcesInWindow([row({ lastItemAt: "2026-10-10T00:30:00+03:00" })], WINDOW_START),
    ).toHaveLength(1);
    // 2026-10-09T23:30:00+03:00 = 2026-10-09T20:30:00Z, before it, although the
    // string sorts after "2026-10-09T21:00:00.000Z" lexicographically.
    expect(
      darkVotingSourcesInWindow([row({ lastItemAt: "2026-10-09T23:30:00+03:00" })], WINDOW_START),
    ).toEqual([]);
  });

  it("(c) a source that never delivered (lastItemAt null) is excluded", () => {
    expect(darkVotingSourcesInWindow([row({ lastItemAt: null })], WINDOW_START)).toEqual([]);
  });

  it("(c) an unparseable lastItemAt is excluded, and so is an unparseable window start", () => {
    expect(darkVotingSourcesInWindow([row({ lastItemAt: "yesterday" })], WINDOW_START)).toEqual([]);
    expect(darkVotingSourcesInWindow([row()], "")).toEqual([]);
    expect(darkVotingSourcesInWindow([row()], "not a date")).toEqual([]);
  });

  it("(d) aggregator and niche sources are excluded", () => {
    const out = darkVotingSourcesInWindow(
      [
        row({ kind: "aggregator", name: "Derleme" }),
        row({ kind: "niche", name: "Dar Alan" }),
      ],
      WINDOW_START,
    );
    expect(out).toEqual([]);
  });

  it("(e) a source that is not silent is excluded", () => {
    const out = darkVotingSourcesInWindow(
      [row({ silent: false, silenceReason: null, lastItemAt: "2026-11-08T22:00:00+00:00" })],
      WINDOW_START,
    );
    expect(out).toEqual([]);
  });

  it("(g) a silent outlet whose feed still answers is excluded: a low-cadence outlet is not an outage", () => {
    // Bianet delivers in weekly batches: last item 2026-11-06 21:00Z, the feed
    // answers 304 with no failures and is not quarantined.
    const answering: Partial<SourceFeedStatus> = {
      lastItemAt: "2026-11-06T21:00:00+00:00",
      lastHttpStatus: 304,
      failStreak: 0,
      quarantined: false,
    };
    expect(
      darkVotingSourcesInWindow([row({ ...answering, silenceReason: "akis_donmus" })], WINDOW_START),
    ).toEqual([]);
    expect(
      darkVotingSourcesInWindow([row({ ...answering, silenceReason: "sessiz" })], WINDOW_START),
    ).toEqual([]);
  });

  it("(g) a silent source with no reason is excluded", () => {
    expect(darkVotingSourcesInWindow([row({ silenceReason: null })], WINDOW_START)).toEqual([]);
  });

  it("(f) zones come in ZONES order (iktidar, bagimsiz, muhalefet), whatever the input order", () => {
    const out = darkVotingSourcesInWindow(
      [
        row({ name: "M1", zone: "muhalefet" }),
        row({ name: "I1", zone: "iktidar", bias: "pro_government" }),
        row({ name: "B1", zone: "bagimsiz", bias: "center" }),
      ],
      WINDOW_START,
    );
    expect(out.map((g) => g.zone)).toEqual(["iktidar", "bagimsiz", "muhalefet"]);
  });

  it("(f) names are sorted with the Turkish collation, not by code unit", () => {
    const out = darkVotingSourcesInWindow(
      [
        row({ name: "Zaman" }),
        row({ name: "Ülke Gazetesi" }),
        row({ name: "Çınar" }),
        row({ name: "Artı Gerçek" }),
        row({ name: "İstanbul Postası" }),
        row({ name: "Halk TV" }),
        row({ name: "Işık" }),
      ],
      WINDOW_START,
    );
    // Turkish alphabet: a b c ç ... h ı i ... u ü ... z. 'ı' sorts before 'i', and
    // 'ç' directly after 'c'.
    expect(out[0]!.names).toEqual([
      "Artı Gerçek",
      "Çınar",
      "Halk TV",
      "Işık",
      "İstanbul Postası",
      "Ülke Gazetesi",
      "Zaman",
    ]);
  });

  it("(f) a zone with no dark source is omitted", () => {
    const out = darkVotingSourcesInWindow(
      [row({ zone: "bagimsiz", bias: "center", name: "Benguturk" })],
      WINDOW_START,
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.zone).toBe("bagimsiz");
  });

  it("returns [] for no statuses", () => {
    expect(darkVotingSourcesInWindow([], WINDOW_START)).toEqual([]);
  });

  it("replays the 2026-11-09 production picture: five sources in two zones", () => {
    const fixtures: SourceFeedStatus[] = [
      row({ slug: "gazete-pencere", name: "Gazete Pencere", zone: "bagimsiz", bias: "center", lastItemAt: "2026-10-15T08:00:00+00:00" }),
      row({ slug: "halk-tv", name: "Halk TV", lastItemAt: "2026-10-16T08:00:00+00:00" }),
      row({ slug: "benguturk", name: "Benguturk", zone: "bagimsiz", bias: "center", lastItemAt: "2026-10-23T08:00:00+00:00" }),
      row({ slug: "arti-gercek", name: "Artı Gerçek", lastItemAt: "2026-10-23T09:00:00+00:00" }),
      row({ slug: "medya-gazete", name: "Medya Gazete", lastItemAt: "2026-10-25T08:00:00+00:00" }),
      // not dark: still delivering, an aggregator, and one dark since September
      row({ slug: "sozcu", name: "Sözcü", silent: false, silenceReason: null, lastItemAt: "2026-11-09T01:00:00+00:00" }),
      row({ slug: "agg", name: "Derleme", kind: "aggregator", lastItemAt: "2026-10-20T08:00:00+00:00" }),
      row({ slug: "old", name: "Eski Kaynak", lastItemAt: "2026-09-12T08:00:00+00:00" }),
    ];
    const out: DarkZoneGroup[] = darkVotingSourcesInWindow(fixtures, WINDOW_START);
    expect(out).toEqual([
      { zone: "bagimsiz", names: ["Benguturk", "Gazete Pencere"] },
      { zone: "muhalefet", names: ["Artı Gerçek", "Halk TV", "Medya Gazete"] },
    ]);
  });

  it("does not mutate its input", () => {
    const rows = [row({ name: "B" }), row({ name: "A" })];
    const snapshot = JSON.stringify(rows);
    darkVotingSourcesInWindow(rows, WINDOW_START);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("dark-sources.ts: source guard", () => {
  const source = readFileSync(resolve(__dirname, "dark-sources.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("reads no clock (the page renders inside Cache Components)", () => {
    expect(code).not.toMatch(/Date\.now\s*\(/);
    expect(code).not.toMatch(/new Date\s*\(\s*\)/);
    expect(code).not.toMatch(/performance\.now/);
  });
});
