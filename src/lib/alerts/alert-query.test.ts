import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  bundles: [] as unknown[],
  silentRows: [] as unknown[],
  silentError: null as { message: string } | null,
}));

const captured = vi.hoisted(() => ({
  states: [] as import("../../../tests/_helpers/supabase-fake").BuilderState[],
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (st) => {
        captured.states.push(st);
        return { data: state.silentRows, error: state.silentError };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => fake.client,
}));

vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: async () => ({ bundles: state.bundles }),
}));

import { getAlertItems } from "@/lib/alerts/alert-query";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";

const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const SINCE = "2026-09-28T12:00:00.000Z";

function bundle(id: string, updatedAt: string, dist: Record<string, number>, dominantZone = "iktidar") {
  return {
    cluster: {
      id,
      title_tr: `orijinal ${id}`,
      title_tr_neutral: null,
      bias_distribution: dist,
      first_published: "2026-09-27T00:00:00.000Z",
      updated_at: updatedAt,
    },
    dominantZone,
  };
}

function silentRow(id: string, updatedAt: string, dist: unknown, neutral: string | null = null) {
  return {
    id,
    title_tr: `orijinal ${id}`,
    title_tr_neutral: neutral,
    bias_distribution: dist,
    article_count: 5,
    first_published: "2026-09-28T01:00:00.000Z",
    updated_at: updatedAt,
  };
}

function health(degraded: Partial<Record<"iktidar" | "bagimsiz" | "muhalefet", boolean>>): ZoneFeedHealth {
  const z = (d: boolean) => ({ total: 10, fetchOk: 9, fetchOkShare: 0.9, delivering: 9, deliveringShare: 0.9, healthy: 9, healthyShare: 0.9, degraded: d });
  return { iktidar: z(!!degraded.iktidar), bagimsiz: z(!!degraded.bagimsiz), muhalefet: z(!!degraded.muhalefet) };
}

beforeEach(() => {
  state.bundles = [];
  state.silentRows = [];
  state.silentError = null;
  captured.states.length = 0;
});

describe("getAlertItems", () => {
  it("maps a blindspot bundle and keeps only updated_at >= since", async () => {
    state.bundles = [
      bundle("b1", "2026-09-29T08:00:00.000Z", { pro_government: 5, center: 1 }),
      bundle("old", "2026-09-27T08:00:00.000Z", { pro_government: 5, center: 1 }),
    ];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "blindspot",
      clusterId: "b1",
      dominantZone: "iktidar",
      sourceCount: 6,
      zoneCounts: { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
      silentZones: ["muhalefet"],
    });
  });

  it("issues ONE lean silent query with the exact filters", async () => {
    await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(captured.states).toHaveLength(1);
    const q = captured.states[0]!;
    expect(q.selectArgs[0]).toBe(
      "id,title_tr,title_tr_neutral,bias_distribution,article_count,first_published,updated_at",
    );
    expect(q.eq).toEqual(
      expect.arrayContaining([
        { col: "is_archived", val: false },
        { col: "is_blindspot", val: false },
        { col: "blindspot_recall_veto", val: false },
      ]),
    );
    expect(q.gte).toEqual(
      expect.arrayContaining([
        { col: "article_count", val: 5 },
        { col: "updated_at", val: SINCE },
      ]),
    );
    expect(q.lte).toEqual([
      { col: "first_published", val: new Date(NOW - 6 * 3600 * 1000).toISOString() },
    ]);
    expect(q.order).toEqual([{ col: "updated_at", opts: { ascending: false } }]);
    expect(q.limit).toBe(200);
  });

  it("keeps a one-zone-silent cluster and prefers the neutral title", async () => {
    state.silentRows = [silentRow("s1", "2026-09-29T09:00:00.000Z", { pro_government: 3, center: 2 }, "Nötr başlık")];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: health({}), nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "one_zone_silent",
      clusterId: "s1",
      title: "Nötr başlık",
      dominantZone: null,
      silentZones: ["muhalefet"],
      sourceCount: 5,
    });
  });

  it("drops a silent item whose silent zone feeds are degraded", async () => {
    state.silentRows = [silentRow("s1", "2026-09-29T09:00:00.000Z", { pro_government: 3, center: 2 })];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: health({ muhalefet: true }), nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("does not drop when a DIFFERENT zone is degraded", async () => {
    state.silentRows = [silentRow("s1", "2026-09-29T09:00:00.000Z", { pro_government: 3, center: 2 })];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: health({ iktidar: true }), nowMs: NOW });
    expect(items).toHaveLength(1);
  });

  it("fails open when health is null or undefined", async () => {
    state.silentRows = [silentRow("s1", "2026-09-29T09:00:00.000Z", { pro_government: 3, center: 2 })];
    expect(await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toHaveLength(1);
    expect(await getAlertItems({ sinceIso: SINCE, limit: 50, nowMs: NOW })).toHaveLength(1);
  });

  it("filters rows that are not exactly-one-zone-silent (malformed, 4 sources, two silent)", async () => {
    state.silentRows = [
      silentRow("m", "2026-09-29T09:00:00.000Z", "garbage"),
      silentRow("f", "2026-09-29T09:00:00.000Z", { pro_government: 2, center: 2 }),
      silentRow("t", "2026-09-29T09:00:00.000Z", { pro_government: 9 }),
    ];
    expect(await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toEqual([]);
  });

  it("merges both lists, sorts by updated_at desc and slices to the limit", async () => {
    state.bundles = [
      bundle("b-mid", "2026-09-29T06:00:00.000Z", { pro_government: 5, center: 1 }),
    ];
    state.silentRows = [
      silentRow("s-new", "2026-09-29T10:00:00.000Z", { pro_government: 3, center: 2 }),
      silentRow("s-old", "2026-09-29T01:00:00.000Z", { pro_government: 3, center: 2 }),
    ];
    const all = await getAlertItems({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(all.map((i) => i.clusterId)).toEqual(["s-new", "b-mid", "s-old"]);
    const two = await getAlertItems({ sinceIso: SINCE, limit: 2, health: null, nowMs: NOW });
    expect(two.map((i) => i.clusterId)).toEqual(["s-new", "b-mid"]);
  });

  it("caps blindspots at 30 like /blindspots", async () => {
    state.bundles = Array.from({ length: 40 }, (_, i) =>
      bundle(`b${i}`, "2026-09-29T08:00:00.000Z", { pro_government: 5, center: 1 }),
    );
    const items = await getAlertItems({ sinceIso: SINCE, limit: 100, health: null, nowMs: NOW });
    expect(items).toHaveLength(30);
  });

  it("throws when the silent query errors (the route turns it into a 500)", async () => {
    state.silentError = { message: "boom" };
    await expect(getAlertItems({ sinceIso: SINCE, limit: 5, health: null, nowMs: NOW })).rejects.toThrow(/silent/);
  });
});
