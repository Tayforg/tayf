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
  /** Every (rows, health, nowMs) call the page made to summariseWeek. */
  summariseCalls: [] as unknown[][],
}));

vi.mock("next/server", () => ({
  connection: async () => {},
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
  };
});

vi.mock("@/lib/weekly/weekly-query", () => ({
  WEEKLY_CLUSTER_LIMIT: 5000,
  summariseWeek: (...args: unknown[]) => {
    mocks.summariseCalls.push(args);
    return {
      zoneCounts: { iktidar: 6, bagimsiz: 3, muhalefet: 1 },
      topClusters: [],
      blindspots: [],
    };
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

import WeekArchivePage from "./page";

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
