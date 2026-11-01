import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** Every argument list `getBlindspots` was called with. */
  blindspotCalls: [] as unknown[][],
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
  getBlindspots: async (...args: unknown[]) => {
    state.blindspotCalls.push(args);
    return { bundles: state.bundles };
  },
}));

import { getAlertItems } from "@/lib/alerts/alert-query";
import { SILENT_MIN_AGE_H } from "@/lib/alerts/alert-feed";
import { BLINDSPOT } from "@/lib/bias/config";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";

const H = 3600 * 1000;
const MIN = 60 * 1000;
const NOW = Date.parse("2026-09-29T12:00:00.000Z");
const SINCE = "2026-09-28T12:00:00.000Z";
const DELAY_MS = BLINDSPOT.feedDelayHours * H;
const SILENT_MS = SILENT_MIN_AGE_H * H;

const at = (nowMs: number, agoMs: number) => new Date(nowMs - agoMs).toISOString();

/** A blindspot bundle as `getBlindspots()` returns it. */
function bundle(
  id: string,
  firstPublished: string,
  updatedAt: string,
  dist: Record<string, number> = { pro_government: 5, center: 1 },
  dominantZone = "iktidar",
) {
  return {
    cluster: {
      id,
      title_tr: `orijinal ${id}`,
      title_tr_neutral: null,
      bias_distribution: dist,
      first_published: firstPublished,
      updated_at: updatedAt,
    },
    dominantZone,
  };
}

function silentRow(
  id: string,
  firstPublished: string,
  updatedAt: string,
  dist: unknown = { pro_government: 3, center: 2 },
  neutral: string | null = null,
) {
  return {
    id,
    title_tr: `orijinal ${id}`,
    title_tr_neutral: neutral,
    bias_distribution: dist,
    article_count: 5,
    first_published: firstPublished,
    updated_at: updatedAt,
  };
}

function health(degraded: Partial<Record<"iktidar" | "bagimsiz" | "muhalefet", boolean>>): ZoneFeedHealth {
  const z = (d: boolean) => ({ total: 10, fetchOk: 9, fetchOkShare: 0.9, delivering: 9, deliveringShare: 0.9, healthy: 9, healthyShare: 0.9, degraded: d });
  return { iktidar: z(!!degraded.iktidar), bagimsiz: z(!!degraded.bagimsiz), muhalefet: z(!!degraded.muhalefet) };
}

beforeEach(() => {
  state.blindspotCalls = [];
  state.bundles = [];
  state.silentRows = [];
  state.silentError = null;
  captured.states.length = 0;
});

describe("getAlertItems read profile", () => {
  it("reads blindspots through the capped reader profile by default (the public alerts API)", async () => {
    await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(state.blindspotCalls).toHaveLength(1);
    const opts = state.blindspotCalls[0]![0] as { profile?: string } | undefined;
    expect(opts?.profile ?? "reader").toBe("reader");
  });

  it("forwards the batch profile (the alerts-webhooks cron) so its read is uncapped", async () => {
    await getAlertItems({
      sinceIso: SINCE,
      limit: 50,
      health: null,
      nowMs: NOW,
      profile: "batch",
    });
    expect(state.blindspotCalls).toEqual([[{ profile: "batch" }]]);
  });
});

describe("getAlertItems", () => {
  it("maps a blindspot bundle (alertAt = updated_at once it is the later moment)", async () => {
    const fp = at(NOW, 40 * H);
    const upd = at(NOW, 4 * H);
    state.bundles = [bundle("b1", fp, upd)];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "blindspot",
      clusterId: "b1",
      firstPublished: fp,
      updatedAt: upd,
      alertAt: upd,
      dominantZone: "iktidar",
      sourceCount: 6,
      zoneCounts: { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
      silentZones: ["muhalefet"],
    });
  });

  it("(a) includes a blindspot that qualified 30 min ago although updated_at is 24.4 h old; alertAt = first_published + 24 h", async () => {
    const fpMs = NOW - 24.5 * H;
    const fp = new Date(fpMs).toISOString();
    state.bundles = [bundle("b-new", fp, at(NOW, 24.4 * H))];
    const since = at(NOW, 1 * H);
    const items = await getAlertItems({ sinceIso: since, limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-new"]);
    expect(items[0]!.alertAt).toBe(new Date(fpMs + DELAY_MS).toISOString());
    // The record still reports the cluster's own updated_at.
    expect(items[0]!.updatedAt).toBe(at(NOW, 24.4 * H));
  });

  it("(b) excludes a blindspot that qualified 6 h ago when since is 1 h ago", async () => {
    state.bundles = [bundle("b-old", at(NOW, 30 * H), at(NOW, 29 * H))];
    const items = await getAlertItems({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("(c) a blindspot updated after it qualified is included with alertAt = updated_at", async () => {
    const upd = at(NOW, 10 * MIN);
    state.bundles = [bundle("b-upd", at(NOW, 40 * H), upd)];
    const items = await getAlertItems({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.alertAt).toBe(upd);
  });

  it("keeps the boundary: alertAt exactly equal to since is included", async () => {
    const fpMs = NOW - 30 * H;
    state.bundles = [bundle("b-edge", new Date(fpMs).toISOString(), at(NOW, 29 * H))];
    const since = new Date(fpMs + DELAY_MS).toISOString();
    const items = await getAlertItems({ sinceIso: since, limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-edge"]);
  });

  it("issues ONE lean silent query with the exact filters (no bare updated_at gte)", async () => {
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
    expect(q.gte).toEqual([{ col: "article_count", val: 5 }]);
    expect(q.gte.some((g) => g.col === "updated_at")).toBe(false);
    expect(q.lte).toEqual([
      { col: "first_published", val: new Date(NOW - SILENT_MS).toISOString() },
    ]);
    expect(q.order).toEqual([{ col: "updated_at", opts: { ascending: false } }]);
    expect(q.limit).toBe(200);
  });

  it("(d) the silent query ORs updated_at >= since with first_published >= since - SILENT_MIN_AGE_H", async () => {
    await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    const q = captured.states[0]!;
    const floor = new Date(Date.parse(SINCE) - SILENT_MS).toISOString();
    expect(q.or).toEqual([`updated_at.gte.${SINCE},first_published.gte.${floor}`]);
  });

  it("(d) re-serialises since to a canonical ISO value inside the .or() logic tree", async () => {
    await getAlertItems({ sinceIso: "2026-09-28T12:00:00Z", limit: 50, health: null, nowMs: NOW });
    const q = captured.states[0]!;
    const floor = new Date(Date.parse(SINCE) - SILENT_MS).toISOString();
    expect(q.or).toEqual([`updated_at.gte.${SINCE},first_published.gte.${floor}`]);
  });

  it("(d) includes a silent row that turned 6 h old inside the window; alertAt = first_published + 6 h", async () => {
    const fpMs = NOW - 6.5 * H;
    state.silentRows = [silentRow("s-new", new Date(fpMs).toISOString(), at(NOW, 6.4 * H))];
    const items = await getAlertItems({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      type: "one_zone_silent",
      clusterId: "s-new",
      alertAt: new Date(fpMs + SILENT_MS).toISOString(),
      updatedAt: at(NOW, 6.4 * H),
    });
  });

  it("drops a silent row whose alertAt is before since even if the query returned it", async () => {
    state.silentRows = [silentRow("s-stale", at(NOW, 20 * H), at(NOW, 19 * H))];
    const items = await getAlertItems({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("keeps a one-zone-silent cluster and prefers the neutral title", async () => {
    state.silentRows = [
      silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H), { pro_government: 3, center: 2 }, "Nötr başlık"),
    ];
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
    state.silentRows = [silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H))];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: health({ muhalefet: true }), nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("does not drop when a DIFFERENT zone is degraded", async () => {
    state.silentRows = [silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H))];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: health({ iktidar: true }), nowMs: NOW });
    expect(items).toHaveLength(1);
  });

  it("fails open when health is null or undefined", async () => {
    state.silentRows = [silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H))];
    expect(await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toHaveLength(1);
    expect(await getAlertItems({ sinceIso: SINCE, limit: 50, nowMs: NOW })).toHaveLength(1);
  });

  it("filters rows that are not exactly-one-zone-silent (malformed, 4 sources, two silent)", async () => {
    const fp = at(NOW, 12 * H);
    const upd = at(NOW, 3 * H);
    state.silentRows = [
      silentRow("m", fp, upd, "garbage"),
      silentRow("f", fp, upd, { pro_government: 2, center: 2 }),
      silentRow("t", fp, upd, { pro_government: 9 }),
    ];
    expect(await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toEqual([]);
  });

  it("(e) merges both lists, sorts by alertAt desc and slices to the limit", async () => {
    state.bundles = [bundle("b-mid", at(NOW, 40 * H), at(NOW, 6 * H))];
    state.silentRows = [
      silentRow("s-new", at(NOW, 20 * H), at(NOW, 2 * H)),
      silentRow("s-old", at(NOW, 20 * H), at(NOW, 11 * H)),
    ];
    const all = await getAlertItems({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(all.map((i) => i.clusterId)).toEqual(["s-new", "b-mid", "s-old"]);
    const two = await getAlertItems({ sinceIso: SINCE, limit: 2, health: null, nowMs: NOW });
    expect(two.map((i) => i.clusterId)).toEqual(["s-new", "b-mid"]);
  });

  it("(e) sorts by alertAt, not updated_at: a newly eligible blindspot outranks an older update", async () => {
    // b-fresh qualified 30 min ago (updated_at is a day old); s-upd was updated 2 h ago.
    state.bundles = [bundle("b-fresh", at(NOW, 24.5 * H), at(NOW, 24.4 * H))];
    state.silentRows = [silentRow("s-upd", at(NOW, 20 * H), at(NOW, 2 * H))];
    const items = await getAlertItems({ sinceIso: at(NOW, 3 * H), limit: 10, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-fresh", "s-upd"]);
  });

  it("(e) breaks an alertAt tie by clusterId ascending", async () => {
    const fp = at(NOW, 40 * H);
    const upd = at(NOW, 2 * H);
    state.bundles = [bundle("b-z", fp, upd), bundle("b-a", fp, upd)];
    state.silentRows = [silentRow("s-m", at(NOW, 20 * H), upd)];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-a", "b-z", "s-m"]);
  });

  it("(e) applies the limit after the merge sort, not before", async () => {
    state.bundles = [
      bundle("b-old", at(NOW, 40 * H), at(NOW, 9 * H)),
      bundle("b-old2", at(NOW, 40 * H), at(NOW, 8 * H)),
    ];
    state.silentRows = [silentRow("s-top", at(NOW, 20 * H), at(NOW, 1 * H))];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 1, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["s-top"]);
  });

  it("caps blindspots at 30 like /blindspots", async () => {
    state.bundles = Array.from({ length: 40 }, (_, i) =>
      bundle(`b${i}`, at(NOW, 40 * H), at(NOW, 4 * H)),
    );
    const items = await getAlertItems({ sinceIso: SINCE, limit: 100, health: null, nowMs: NOW });
    expect(items).toHaveLength(30);
  });

  it("throws when the silent query errors (the route turns it into a 500)", async () => {
    state.silentError = { message: "boom" };
    await expect(getAlertItems({ sinceIso: SINCE, limit: 5, health: null, nowMs: NOW })).rejects.toThrow(/silent/);
  });

  it("throws a clear error on an unparsable sinceIso instead of querying with it", async () => {
    await expect(
      getAlertItems({ sinceIso: "not-a-date", limit: 5, health: null, nowMs: NOW }),
    ).rejects.toThrow(/sinceIso/);
    expect(captured.states).toHaveLength(0);
  });
});

describe("getAlertItems incremental poller", () => {
  it("(f) a blindspot that becomes eligible between polls appears in exactly one poll", async () => {
    // Becomes eligible (first_published + 24 h) 6 minutes after the first poll.
    const t0 = NOW;
    const fp = new Date(t0 - 24 * H + 6 * MIN).toISOString();
    const upd = new Date(t0 - 23 * H).toISOString(); // earlier than its alertAt
    const polls = [t0, t0 + 10 * MIN, t0 + 20 * MIN];

    const seen: string[][] = [];
    let prev = t0 - 10 * MIN;
    for (const now of polls) {
      // getBlindspots only returns a bundle once first_published < now - 24 h.
      state.bundles =
        Date.parse(fp) < now - DELAY_MS ? [bundle("b-late", fp, upd)] : [];
      const items = await getAlertItems({
        sinceIso: new Date(prev).toISOString(),
        limit: 50,
        health: null,
        nowMs: now,
      });
      seen.push(items.map((i) => i.clusterId));
      prev = now;
    }
    expect(seen).toEqual([[], ["b-late"], []]);
    expect(seen.flat().filter((id) => id === "b-late")).toHaveLength(1);
  });

  it("(f) the same blindspot comes back later only when the cluster changes again", async () => {
    const fp = at(NOW, 40 * H);
    const quiet = at(NOW, 30 * H);
    state.bundles = [bundle("b1", fp, quiet)];
    expect(
      await getAlertItems({ sinceIso: at(NOW, 10 * MIN), limit: 50, health: null, nowMs: NOW }),
    ).toEqual([]);

    const bumped = at(NOW, 5 * MIN);
    state.bundles = [bundle("b1", fp, bumped)];
    const items = await getAlertItems({ sinceIso: at(NOW, 10 * MIN), limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b1"]);
    expect(items[0]!.alertAt).toBe(bumped);
  });

  it("(f) a silent cluster crossing the 6 h mark between polls appears in exactly one poll", async () => {
    const t0 = NOW;
    const fpMs = t0 - SILENT_MS + 5 * MIN; // turns 6 h old 5 minutes after poll 0
    const fp = new Date(fpMs).toISOString();
    const upd = new Date(fpMs + 20 * MIN).toISOString();
    const polls = [t0, t0 + 10 * MIN, t0 + 20 * MIN];
    const seen: string[][] = [];
    let prev = t0 - 10 * MIN;
    for (const now of polls) {
      // The SQL: first_published <= now - 6 h; the OR on updated_at / first_published >= since - 6 h.
      state.silentRows = fpMs <= now - SILENT_MS ? [silentRow("s-late", fp, upd)] : [];
      const items = await getAlertItems({
        sinceIso: new Date(prev).toISOString(),
        limit: 50,
        health: null,
        nowMs: now,
      });
      seen.push(items.map((i) => i.clusterId));
      prev = now;
    }
    // alertAt = fp + 6 h = poll 0 + 5 min: inside poll 1's window only.
    expect(seen).toEqual([[], ["s-late"], []]);
    expect(seen.flat().filter((id) => id === "s-late")).toHaveLength(1);
  });
});

describe("getAlertItems unparsable timestamps", () => {
  it("(g) an unparsable updated_at falls back to first_published + the delay", async () => {
    const fpMs = NOW - 30 * H;
    state.bundles = [bundle("b-bad-upd", new Date(fpMs).toISOString(), "garbage")];
    state.silentRows = [silentRow("s-bad-upd", at(NOW, 6.5 * H), "garbage")];
    const items = await getAlertItems({ sinceIso: at(NOW, 12 * H), limit: 50, health: null, nowMs: NOW });
    const byId = new Map(items.map((i) => [i.clusterId, i]));
    expect(byId.get("b-bad-upd")?.alertAt).toBe(new Date(fpMs + DELAY_MS).toISOString());
    expect(byId.get("s-bad-upd")?.alertAt).toBe(
      new Date(Date.parse(at(NOW, 6.5 * H)) + SILENT_MS).toISOString(),
    );
  });

  it("(g) an item with both timestamps unparsable is dropped, never thrown on", async () => {
    state.bundles = [bundle("b-bad", "nope", "garbage")];
    state.silentRows = [silentRow("s-bad", "nope", "garbage")];
    const items = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(items).toEqual([]);
  });
});
