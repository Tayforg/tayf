import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// /hafta/[hafta] (h21-journeys-3). The archive page passed `feedStatus={null}`
// to ZoneShares even for the week still in progress, so the in-progress week
// always printed "spektruma sayılan kaynakların durumu şu anda bilinmiyor" while
// the rolling /hafta page printed "71 / 96" from the same data. Mirrors
// src/app/hafta/page.test.tsx: mock the data modules, call the default export
// as a plain async function (no React renderer for an async Server Component).
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  getFeedStatusSummary: vi.fn(),
  getWeekArchiveClusters: vi.fn(),
  /** h207-weekly-1: the closed week's silent voting sources (null = unknown). */
  getWeekSilentVotingSources: vi.fn(async (_key: string): Promise<unknown> => null),
  /** Every (rows, health, nowMs) call the page made to summariseWeek. */
  summariseCalls: [] as unknown[][],
  /** Order of connection() and the week read, to pin the request-time contract. */
  order: [] as string[],
  /** What getWeeklyWireSignals resolves (null = the member read failed). */
  wireSignals: null as Record<
    string,
    { effectiveArticleCount: number; memberCount: number }
  > | null,
  /** Every id list the page asked getWeeklyWireSignals about. */
  wireCalls: [] as string[][],
}));

vi.mock("next/server", () => ({
  connection: async () => {
    mocks.order.push("connection");
  },
}));

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

// Keep the real key helpers (parseWeekKey, shiftWeek, weekKeyFromMs,
// weekLabelTr, WEEK_ARCHIVE_FIRST); only the database read is replaced.
vi.mock("@/lib/weekly/week-archive", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/weekly/week-archive")>();
  return {
    ...actual,
    getWeekArchiveClusters: mocks.getWeekArchiveClusters,
    getWeekSilentVotingSources: mocks.getWeekSilentVotingSources,
  };
});

vi.mock("@/lib/weekly/weekly-query", () => ({
  WEEKLY_CLUSTER_LIMIT: 5000,
  summariseWeek: (...args: unknown[]) => {
    mocks.summariseCalls.push(args);
    return {
      zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
      topClusters: [],
      // One row per side shown, the tally over all the week's public claims.
      blindspots: [
        {
          id: "bs-i",
          title: "İktidar tarafı kör noktası",
          articleCount: 21,
          side: "iktidar",
          share: 1,
          sharePct: 100,
          counts: { iktidar: 21, bagimsiz: 0, muhalefet: 0 },
        },
        {
          id: "bs-m",
          title: "Muhalefet tarafı kör noktası",
          articleCount: 8,
          side: "muhalefet",
          share: 1,
          sharePct: 100,
          counts: { iktidar: 0, bagimsiz: 0, muhalefet: 8 },
        },
      ],
      blindspotSideCounts: { iktidar: 37, bagimsiz: 0, muhalefet: 9 },
    };
  },
}));

// h208-roadmap-1: the bounded member read behind the wire count. weekly-wire.ts
// (the pure ids / attach steps) stays real, so the page's wiring is exercised.
vi.mock("@/lib/weekly/weekly-wire-query", () => ({
  getWeeklyWireSignals: (ids: string[]) => {
    mocks.wireCalls.push(ids);
    return Promise.resolve(mocks.wireSignals);
  },
}));

vi.mock("@/lib/clusters/feed-health", () => ({
  getZoneFeedHealth: () =>
    Promise.resolve({
      iktidar: { delivering: 24, total: 36, degraded: false },
      bagimsiz: { delivering: 33, total: 57, degraded: false },
      muhalefet: { delivering: 15, total: 20, degraded: false },
    }),
  zoneYieldDenominator: (
    health: Record<string, { delivering: number }> | null,
    zone: string,
  ) => (health ? (health[zone]?.delivering ?? null) : null),
}));

vi.mock("@/lib/sources/feed-status", () => ({
  getFeedStatusSummary: mocks.getFeedStatusSummary,
}));

import { shiftWeek, weekKeyFromMs } from "@/lib/weekly/week-archive";

import WeekArchivePage, { generateMetadata } from "./page";

/** See src/app/kalite/page.test.tsx for the function-expansion rationale. */
function collectText(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (node && typeof node === "object") {
    const el = node as { type?: unknown; props?: Record<string, unknown> };
    if (typeof el.type === "function") {
      const rendered = (el.type as (props: Record<string, unknown>) => unknown)(
        el.props ?? {},
      );
      collectText(rendered, out);
      return out;
    }
    if (el.props?.children !== undefined) {
      collectText(el.props.children as ReactNode, out);
    }
  }
  return out;
}

async function renderWeek(key: string): Promise<string> {
  const tree = await WeekArchivePage({ params: Promise.resolve({ hafta: key }) });
  return collectText(tree).join(" ");
}

const UNKNOWN = "spektruma sayılan kaynakların durumu şu anda bilinmiyor";

// 2026-11-02 is a Monday; 09:00Z is noon in Istanbul, well inside the week.
const NOW = new Date("2026-11-02T09:00:00.000Z");

describe("/hafta/[hafta] source status", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const current = weekKeyFromMs(NOW.getTime());
  const closed = shiftWeek(current, -1) as string;

  beforeEach(() => {
    mocks.summariseCalls = [];
    mocks.getFeedStatusSummary.mockReset();
    mocks.getWeekArchiveClusters.mockReset();
    mocks.getWeekArchiveClusters.mockResolvedValue({
      rows: [{ id: "cl-1" }],
      truncated: false,
    });
  });

  it("derives the keys from the frozen clock (guards the fixture)", () => {
    expect(current).toBe("2026-W45");
    expect(closed).toBe("2026-W44");
  });

  it("the current week prints the delivering / total sources instead of 'bilinmiyor'", async () => {
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });

    const text = await renderWeek(current);

    expect(text).toContain("71 / 96");
    expect(text).toContain("spektruma sayılan kaynaklardan 71 / 96 tanesi haber verdi");
    expect(text).not.toContain("şu anda bilinmiyor");
    expect(mocks.getFeedStatusSummary).toHaveBeenCalledTimes(1);
  });

  it("the current week still says the status is unknown when the summary is null (a real failure)", async () => {
    mocks.getFeedStatusSummary.mockResolvedValue(null);

    const text = await renderWeek(current);

    expect(text).toContain(UNKNOWN);
    expect(text).not.toContain("71 / 96");
    expect(mocks.getFeedStatusSummary).toHaveBeenCalledTimes(1);
  });

  it("measures the blindspot delay against the cached read's own clock (asOfMs), never a clock read in the render (h37-content-1)", async () => {
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });
    mocks.getWeekArchiveClusters.mockResolvedValue({
      rows: [{ id: "cl-1" }],
      truncated: false,
      asOfMs: 1_790_000_000_000,
    });

    await renderWeek(current);

    expect(mocks.summariseCalls).toHaveLength(1);
    expect(mocks.summariseCalls[0]![2]).toBe(1_790_000_000_000);
  });

  it("a closed week never reads the live status and states no source basis", async () => {
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });

    const text = await renderWeek(closed);

    expect(mocks.getFeedStatusSummary).not.toHaveBeenCalled();
    expect(text).not.toContain("71 / 96");
    expect(text).not.toContain(UNKNOWN);
    // The archive copy is unchanged: it still states the percentage basis.
    expect(text).toContain("Yüzdeler o haftanın çok kaynaklı kümelerindeki 10 kaynak kaydı");
  });
});

// h208-roadmap-1: the week pages count a wire redistribution in distinct texts,
// like every other surface. The page reads the members of the displayed rows
// (current and closed weeks alike) and fails open to today's line.
describe("/hafta/[hafta] wire rows", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const current = weekKeyFromMs(NOW.getTime());
  const closed = shiftWeek(current, -1) as string;

  beforeEach(() => {
    mocks.summariseCalls = [];
    mocks.wireSignals = null;
    mocks.wireCalls = [];
    mocks.getFeedStatusSummary.mockReset();
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });
    mocks.getWeekArchiveClusters.mockReset();
    mocks.getWeekArchiveClusters.mockResolvedValue({
      rows: [{ id: "cl-1" }],
      truncated: false,
    });
  });

  it("asks for the members of the displayed rows only, once, sorted", async () => {
    await renderWeek(closed);

    expect(mocks.wireCalls).toEqual([["bs-i", "bs-m"]]);
  });

  it.each([
    ["the week in progress", () => current],
    ["a closed week", () => closed],
  ])("%s prints the distinct-text count and the cue on a wire row only", async (_label, key) => {
    // bs-i: 21 members voted, but they are 4 distinct texts.
    mocks.wireSignals = { "bs-i": { effectiveArticleCount: 4, memberCount: 21 } };

    const text = await renderWeek(key());

    expect(text).toContain("Spektrumda yalnızca İktidar · 4 kaynak · 21 sınıflandırılmış");
    expect(text).toContain("Ajans ağırlıklı · 21 haber, 4 farklı metin");
    expect(text).not.toContain("İktidar · 21 kaynak");
    expect(text).toContain("Spektrumda yalnızca Muhalefet · 8 kaynak");
    expect(text.match(/Ajans ağırlıklı|Tek kaynaktan dağıtıldı/g) ?? []).toHaveLength(1);
  });

  it("a failed member read fails open: every row prints as before", async () => {
    mocks.wireSignals = null;

    const text = await renderWeek(closed);

    expect(text).toContain("Spektrumda yalnızca İktidar · 21 kaynak");
    expect(text).toContain("Spektrumda yalnızca Muhalefet · 8 kaynak");
    expect(text).not.toContain("Ajans ağırlıklı");
    expect(text).not.toContain("Tek kaynaktan dağıtıldı");
  });

  it("does not read members when the week could not be read", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue(null);

    await renderWeek(closed);

    expect(mocks.wireCalls).toEqual([]);
  });
});

// h52-weekly-2: every week's blindspot list is side-balanced, and the line
// under the heading gives the per-side totals and how the rows were chosen.
describe("/hafta/[hafta] blindspot side tally", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const current = weekKeyFromMs(NOW.getTime());
  const closed = shiftWeek(current, -1) as string;
  const TALLY =
    "Toplam 46 kör nokta · İktidar ağırlıklı 37 · Muhalefet ağırlıklı 9. Her taraftan en büyükleri gösteriliyor.";

  beforeEach(() => {
    mocks.summariseCalls = [];
    mocks.getFeedStatusSummary.mockReset();
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });
    mocks.getWeekArchiveClusters.mockReset();
    mocks.getWeekArchiveClusters.mockResolvedValue({
      rows: [{ id: "cl-1" }],
      truncated: false,
    });
  });

  it.each([
    ["a closed week", () => closed],
    ["the week in progress", () => current],
  ])("%s prints the tally and a row from each side", async (_name, key) => {
    const text = await renderWeek(key());

    expect(text).toContain(TALLY);
    expect(text).toContain("İktidar tarafı kör noktası");
    expect(text).toContain("Muhalefet tarafı kör noktası");
  });

  it("a closed week's tally adds no 'Bu hafta' wording", async () => {
    const text = await renderWeek(closed);

    expect(text.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });
});

// h92-weeklyarchive-1: closed weeks before 2026-W44 were never judged by both
// the Jev recall check and the sibling-headline veto (W38: 39 of 41 flags never
// recall-checked), so their "Toplam N kör nokta" is not comparable with later
// weeks. Those pages say so under the note; W44 on, and the week in progress,
// print no caveat. Nothing else changes: same tally, same rows.
describe("/hafta/[hafta] filter-coverage caveat", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const CAVEAT =
    "O haftanın kör noktaları, sonradan eklenen doğrulama süzgeçlerinin hepsinden geçmedi; toplamlar sonraki haftalarla birebir karşılaştırılamaz.";
  const NOTE =
    "Kör noktalar o hafta işaretlenen haberlerdir; sonradan geri alınan işaretler listede yer almaz.";
  const TALLY =
    "Toplam 46 kör nokta · İktidar ağırlıklı 37 · Muhalefet ağırlıklı 9. Her taraftan en büyükleri gösteriliyor.";

  beforeEach(() => {
    mocks.summariseCalls = [];
    mocks.getFeedStatusSummary.mockReset();
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });
    mocks.getWeekArchiveClusters.mockReset();
    mocks.getWeekArchiveClusters.mockResolvedValue({
      rows: [{ id: "cl-1" }],
      truncated: false,
    });
  });

  it("derives the keys from the frozen clock (guards the fixture)", () => {
    expect(weekKeyFromMs(NOW.getTime())).toBe("2026-W45");
  });

  it.each(["2026-W38", "2026-W43"])(
    "%s (closed, before the first covered week) prints the caveat",
    async (key) => {
      const text = await renderWeek(key);

      expect(text).toContain(CAVEAT);
    },
  );

  it.each([
    ["2026-W44", "the first covered week"],
    ["2026-W45", "the week in progress"],
  ])("%s (%s) prints no caveat", async (key) => {
    const text = await renderWeek(key);

    expect(text).not.toContain(CAVEAT);
    expect(text).not.toContain("birebir karşılaştırılamaz");
  });

  it("places the caveat right after the closed-week note, before any section", async () => {
    const text = await renderWeek("2026-W38");

    const note = text.indexOf(NOTE);
    const caveat = text.indexOf(CAVEAT);
    const firstSection = text.indexOf("O hafta kim neyi öne çıkardı");
    expect(note).toBeGreaterThanOrEqual(0);
    expect(caveat).toBeGreaterThan(note);
    expect(firstSection).toBeGreaterThan(caveat);
    // Directly after the note: nothing but the separator between them.
    expect(text.slice(note + NOTE.length, caveat).trim()).toBe("");
  });

  it("changes no count and removes no row: the tally and both sides' rows still print", async () => {
    const withCaveat = await renderWeek("2026-W38");
    const without = await renderWeek("2026-W44");

    for (const text of [withCaveat, without]) {
      expect(text).toContain(TALLY);
      expect(text).toContain("İktidar tarafı kör noktası");
      expect(text).toContain("Muhalefet tarafı kör noktası");
      expect(text).toContain(NOTE);
    }
    // The summary the page builds is read the same way either side of the cut-off.
    expect(mocks.summariseCalls).toHaveLength(2);
    expect(mocks.summariseCalls[0]![0]).toEqual(mocks.summariseCalls[1]![0]);
  });

  it("still prints the caveat when the week read failed or is empty (the note prints then too)", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue(null);
    expect(await renderWeek("2026-W38")).toContain(CAVEAT);

    mocks.getWeekArchiveClusters.mockResolvedValue({ rows: [], truncated: false });
    expect(await renderWeek("2026-W38")).toContain(CAVEAT);
  });
});

// h207-weekly-1: a closed week names the voting sources that delivered nothing
// that week although they delivered materially in the weeks around it, and says
// the zone shares are not one-to-one comparable with those weeks (what /trends
// says since h90-trends-2). The names come from migration 219's RPC through
// getWeekSilentVotingSources; the sentence comes from week-copy. The week in
// progress never asks (its feeds are being read right now), and while the RPC
// does not exist yet the read is null and the page prints nothing extra.
describe("/hafta/[hafta] silent voting sources", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const SILENT = [
    { zone: "iktidar", names: ["En Son Haber"] },
    { zone: "muhalefet", names: ["Artı Gerçek", "Halk TV"] },
  ];
  const SILENT_TEXT =
    "O hafta 3 spektrum kaynağı hiç veri vermedi (İktidar: En Son Haber; Muhalefet: Artı Gerçek, Halk TV). " +
    "Bu kaynaklar yakın haftalarda düzenli haber veriyordu; bölge payları bu yüzden o haftalarla birebir karşılaştırılamaz.";
  const NOTE =
    "Kör noktalar o hafta işaretlenen haberlerdir; sonradan geri alınan işaretler listede yer almaz.";
  const COVERAGE =
    "O haftanın kör noktaları, sonradan eklenen doğrulama süzgeçlerinin hepsinden geçmedi; toplamlar sonraki haftalarla birebir karşılaştırılamaz.";
  const TALLY =
    "Toplam 46 kör nokta · İktidar ağırlıklı 37 · Muhalefet ağırlıklı 9. Her taraftan en büyükleri gösteriliyor.";

  beforeEach(() => {
    mocks.summariseCalls = [];
    mocks.getFeedStatusSummary.mockReset();
    mocks.getFeedStatusSummary.mockResolvedValue({ delivering: 71, total: 96 });
    mocks.getWeekArchiveClusters.mockReset();
    mocks.getWeekArchiveClusters.mockResolvedValue({
      rows: [{ id: "cl-1" }],
      truncated: false,
    });
    mocks.getWeekSilentVotingSources.mockReset();
    mocks.getWeekSilentVotingSources.mockResolvedValue(SILENT);
  });

  it("derives the keys from the frozen clock (guards the fixture)", () => {
    expect(weekKeyFromMs(NOW.getTime())).toBe("2026-W45");
  });

  it.each(["2026-W38", "2026-W43", "2026-W44"])(
    "closed week %s prints the sentence and reads exactly that week",
    async (key) => {
      const text = await renderWeek(key);

      expect(text).toContain(SILENT_TEXT);
      expect(mocks.getWeekSilentVotingSources).toHaveBeenCalledTimes(1);
      expect(mocks.getWeekSilentVotingSources).toHaveBeenCalledWith(key);
    },
  );

  it("the week in progress never calls the RPC and prints no sentence", async () => {
    const text = await renderWeek("2026-W45");

    expect(mocks.getWeekSilentVotingSources).not.toHaveBeenCalled();
    expect(text).not.toContain("hiç veri vermedi");
    expect(text).not.toContain("spektrum kaynağı");
  });

  it.each([
    ["null (read failed, or migration 219 not applied yet)", null],
    ["an empty list (nobody was silent)", []],
  ])("%s prints no sentence, no error, and the rest of the page is untouched", async (_name, value) => {
    mocks.getWeekSilentVotingSources.mockResolvedValue(value);

    const text = await renderWeek("2026-W44");

    expect(text).not.toContain("hiç veri vermedi");
    expect(text).not.toContain("spektrum kaynağı");
    expect(text).not.toContain("hesaplanamıyor");
    expect(text).toContain(NOTE);
    expect(text).toContain(TALLY);
  });

  it("sits in its own paragraph directly under the filter-coverage caveat, before any section", async () => {
    const text = await renderWeek("2026-W38");

    const note = text.indexOf(NOTE);
    const coverage = text.indexOf(COVERAGE);
    const silent = text.indexOf(SILENT_TEXT);
    const firstSection = text.indexOf("O hafta kim neyi öne çıkardı");
    expect(note).toBeGreaterThanOrEqual(0);
    expect(coverage).toBeGreaterThan(note);
    expect(silent).toBeGreaterThan(coverage);
    expect(firstSection).toBeGreaterThan(silent);
    // Directly after the coverage caveat: nothing but the separator between them.
    expect(text.slice(coverage + COVERAGE.length, silent).trim()).toBe("");
  });

  it("without a coverage caveat (W44 on) it follows the note directly", async () => {
    const text = await renderWeek("2026-W44");

    const note = text.indexOf(NOTE);
    const silent = text.indexOf(SILENT_TEXT);
    expect(text).not.toContain(COVERAGE);
    expect(silent).toBeGreaterThan(note);
    expect(text.slice(note + NOTE.length, silent).trim()).toBe("");
  });

  it("changes no count and removes no row: tally and both sides' rows still print with the sentence", async () => {
    const text = await renderWeek("2026-W44");

    expect(text).toContain(TALLY);
    expect(text).toContain("İktidar tarafı kör noktası");
    expect(text).toContain("Muhalefet tarafı kör noktası");
    expect(mocks.summariseCalls).toHaveLength(1);
    expect(mocks.summariseCalls[0]![0]).toEqual([{ id: "cl-1" }]);
  });

  it("still prints when the week read failed or is empty (the note and caveats print then too)", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue(null);
    expect(await renderWeek("2026-W44")).toContain(SILENT_TEXT);

    mocks.getWeekArchiveClusters.mockResolvedValue({ rows: [], truncated: false });
    expect(await renderWeek("2026-W44")).toContain(SILENT_TEXT);
  });

  it("adds no 'Bu hafta' wording to a closed week", async () => {
    const text = await renderWeek("2026-W44");

    expect(text.toLocaleLowerCase("tr-TR")).not.toContain("bu hafta");
  });
});

// ---------------------------------------------------------------------------
// generateMetadata robots (h49-seo-1). This route is request-time
// (connection()), so a failed or empty week read can be reported in the robots
// meta of the same response; /konu does it with topicPageRobots(null). The read
// is the page body's own cached call (same "use cache" key), so it adds no
// round trip, and an out-of-range key never reaches it (no unbounded cache keys).
// ---------------------------------------------------------------------------

type MetaShape = {
  title?: string;
  alternates?: { canonical?: string };
  openGraph?: { url?: string };
  robots?: unknown;
};

async function metaFor(key: string): Promise<MetaShape> {
  return (await generateMetadata({
    params: Promise.resolve({ hafta: key }),
  })) as unknown as MetaShape;
}

describe("/hafta/[hafta] generateMetadata robots", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  const current = weekKeyFromMs(NOW.getTime());
  const closed = shiftWeek(current, -1) as string;

  beforeEach(() => {
    mocks.order = [];
    mocks.getWeekArchiveClusters.mockReset();
    mocks.getWeekArchiveClusters.mockImplementation(async () => {
      mocks.order.push("read");
      return { rows: [{ id: "cl-1" }], truncated: false };
    });
  });

  it("noindexes (follow kept) when the week read failed (null) and keeps the share identity", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue(null);

    const m = await metaFor(closed);

    expect(m.robots).toEqual({ index: false, follow: true });
    expect(m.alternates?.canonical).toBe(`/hafta/${closed}`);
    expect(m.openGraph?.url).toBe(`/hafta/${closed}`);
    expect(m.title).toContain("Haftanın yelpazesi");
  });

  it("noindexes (follow kept) a week that was read fine but holds no rows", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue({ rows: [], truncated: false });

    expect((await metaFor(closed)).robots).toEqual({ index: false, follow: true });
  });

  it("leaves a normal week indexable: no robots key at all", async () => {
    const m = await metaFor(closed);

    expect("robots" in m).toBe(false);
    expect(m.alternates?.canonical).toBe(`/hafta/${closed}`);
  });

  it("applies the same rule to the week still in progress", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue(null);
    expect((await metaFor(current)).robots).toEqual({ index: false, follow: true });

    mocks.getWeekArchiveClusters.mockResolvedValue({ rows: [{ id: "cl-1" }], truncated: false });
    expect("robots" in (await metaFor(current))).toBe(false);
  });

  it("reads the requested week exactly once, with the page body's own key (no extra round trip)", async () => {
    await metaFor(closed);

    expect(mocks.getWeekArchiveClusters).toHaveBeenCalledTimes(1);
    expect(mocks.getWeekArchiveClusters).toHaveBeenCalledWith(closed);
  });

  it("awaits connection() before the read (the clock is read only at request time)", async () => {
    await metaFor(closed);

    expect(mocks.order).toEqual(["connection", "read"]);
  });

  it.each([
    ["a far-future key", "2099-W01"],
    ["next week", "2026-W46"],
    ["a week before the archive began", "2026-W37"],
  ])("%s: does NOT touch the read (no unbounded cache keys) and returns the base metadata", async (_name, key) => {
    const m = await metaFor(key);

    expect(mocks.getWeekArchiveClusters).not.toHaveBeenCalled();
    expect("robots" in m).toBe(false);
    expect(m.alternates?.canonical).toBe(`/hafta/${key}`);
  });

  it("returns {} for an unparseable key without reading", async () => {
    expect(await metaFor("garbage")).toEqual({});
    expect(await metaFor("2026-W99")).toEqual({});
    expect(mocks.getWeekArchiveClusters).not.toHaveBeenCalled();
  });

  it("the first archive week is still in range (the lower bound is inclusive)", async () => {
    mocks.getWeekArchiveClusters.mockResolvedValue(null);

    expect((await metaFor("2026-W38")).robots).toEqual({ index: false, follow: true });
    expect(mocks.getWeekArchiveClusters).toHaveBeenCalledWith("2026-W38");
  });
});
