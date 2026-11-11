import { describe, it, expect, vi, beforeEach } from "vitest";

const state = vi.hoisted(() => ({
  /** Every argument list `getBlindspots` was called with. */
  blindspotCalls: [] as unknown[][],
  bundles: [] as unknown[],
  /** The compact rows of /blindspots (claims without a card). */
  more: [] as unknown[],
  silentRows: [] as unknown[],
  silentError: null as { message: string; code?: string } | null,
  /** The PostgREST response status that rides along with `silentError`. */
  silentStatus: undefined as number | undefined,
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
        // Like PostgREST: the rows come back already cut by .range() / .limit().
        let rows = state.silentRows;
        if (st.range) rows = rows.slice(st.range.from, st.range.to + 1);
        else if (st.limit !== null) rows = rows.slice(0, st.limit);
        return { data: rows, error: state.silentError, status: state.silentStatus };
      },
    },
  });
});

// errors.ts imports the Sentry helper; the classification below never calls it.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => fake.client,
}));

vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: async (...args: unknown[]) => {
    state.blindspotCalls.push(args);
    return { bundles: state.bundles, more: state.more };
  },
}));

import { getAlertItems } from "@/lib/alerts/alert-query";
import { isUpstreamUnavailable } from "@/lib/api/errors";
import { SILENT_MIN_AGE_H, toV1AlertRecord } from "@/lib/alerts/alert-feed";
import { BLINDSPOT } from "@/lib/bias/config";
import type { ZoneFeedHealth } from "@/lib/clusters/feed-health";

/** The items only; the `truncated` flag has its own tests below. */
async function itemsOf(input: Parameters<typeof getAlertItems>[0]) {
  return (await getAlertItems(input)).items;
}

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

/**
 * A compact row of /blindspots as `getBlindspots().more` carries it (a claim
 * without a card). Zone counts default to 5 / 1 / 0 like `bundle`.
 */
function moreRow(
  id: string,
  firstPublished: string,
  updatedAt: string,
  counts: Record<"iktidar" | "bagimsiz" | "muhalefet", number> = { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
  dominantZone = "iktidar",
) {
  return {
    id,
    title: `kompakt ${id}`,
    dominantZone,
    dominantPct: 0.83,
    sourceCount: 99, // deliberately not the tally: the alert counts voting sources
    firstPublished,
    updatedAt,
    votingZoneCounts: counts,
    recallMatchedZones: [],
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
  state.more = [];
  state.silentRows = [];
  state.silentError = null;
  state.silentStatus = undefined;
  captured.states.length = 0;
});

describe("getAlertItems read profile", () => {
  it("reads blindspots through the capped reader profile by default (the public alerts API)", async () => {
    await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(state.blindspotCalls).toHaveLength(1);
    const opts = state.blindspotCalls[0]![0] as { profile?: string } | undefined;
    expect(opts?.profile ?? "reader").toBe("reader");
  });

  it("forwards the batch profile (the alerts-webhooks cron) so its read is uncapped", async () => {
    await itemsOf({
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
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
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
    const items = await itemsOf({ sinceIso: since, limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-new"]);
    expect(items[0]!.alertAt).toBe(new Date(fpMs + DELAY_MS).toISOString());
    // The record still reports the cluster's own updated_at.
    expect(items[0]!.updatedAt).toBe(at(NOW, 24.4 * H));
  });

  it("(b) excludes a blindspot that qualified 6 h ago when since is 1 h ago", async () => {
    state.bundles = [bundle("b-old", at(NOW, 30 * H), at(NOW, 29 * H))];
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("(c) a blindspot updated after it qualified is included with alertAt = updated_at", async () => {
    const upd = at(NOW, 10 * MIN);
    state.bundles = [bundle("b-upd", at(NOW, 40 * H), upd)];
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.alertAt).toBe(upd);
  });

  it("keeps the boundary: alertAt exactly equal to since is included", async () => {
    const fpMs = NOW - 30 * H;
    state.bundles = [bundle("b-edge", new Date(fpMs).toISOString(), at(NOW, 29 * H))];
    const since = new Date(fpMs + DELAY_MS).toISOString();
    const items = await itemsOf({ sinceIso: since, limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-edge"]);
  });

  it("issues ONE lean silent query with the exact filters (no bare updated_at gte)", async () => {
    await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
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
    expect(q.limit).toBe(1000);
    expect(q.range).toBeNull();
  });

  it("(d) the silent query ORs updated_at >= since with first_published >= since - SILENT_MIN_AGE_H", async () => {
    await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    const q = captured.states[0]!;
    const floor = new Date(Date.parse(SINCE) - SILENT_MS).toISOString();
    expect(q.or).toEqual([`updated_at.gte.${SINCE},first_published.gte.${floor}`]);
  });

  it("(d) re-serialises since to a canonical ISO value inside the .or() logic tree", async () => {
    await itemsOf({ sinceIso: "2026-09-28T12:00:00Z", limit: 50, health: null, nowMs: NOW });
    const q = captured.states[0]!;
    const floor = new Date(Date.parse(SINCE) - SILENT_MS).toISOString();
    expect(q.or).toEqual([`updated_at.gte.${SINCE},first_published.gte.${floor}`]);
  });

  it("(d) includes a silent row that turned 6 h old inside the window; alertAt = first_published + 6 h", async () => {
    const fpMs = NOW - 6.5 * H;
    state.silentRows = [silentRow("s-new", new Date(fpMs).toISOString(), at(NOW, 6.4 * H))];
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
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
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("keeps a one-zone-silent cluster and prefers the neutral title", async () => {
    state.silentRows = [
      silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H), { pro_government: 3, center: 2 }, "Nötr başlık"),
    ];
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: health({}), nowMs: NOW });
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
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: health({ muhalefet: true }), nowMs: NOW });
    expect(items).toEqual([]);
  });

  it("does not drop when a DIFFERENT zone is degraded", async () => {
    state.silentRows = [silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H))];
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: health({ iktidar: true }), nowMs: NOW });
    expect(items).toHaveLength(1);
  });

  it("fails open when health is null or undefined", async () => {
    state.silentRows = [silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H))];
    expect(await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toHaveLength(1);
    expect(await itemsOf({ sinceIso: SINCE, limit: 50, nowMs: NOW })).toHaveLength(1);
  });

  it("filters rows that are not exactly-one-zone-silent (malformed, 4 sources, two silent)", async () => {
    const fp = at(NOW, 12 * H);
    const upd = at(NOW, 3 * H);
    state.silentRows = [
      silentRow("m", fp, upd, "garbage"),
      silentRow("f", fp, upd, { pro_government: 2, center: 2 }),
      silentRow("t", fp, upd, { pro_government: 9 }),
    ];
    expect(await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toEqual([]);
  });

  it("(e) merges both lists, sorts by alertAt desc and slices to the limit", async () => {
    state.bundles = [bundle("b-mid", at(NOW, 40 * H), at(NOW, 6 * H))];
    state.silentRows = [
      silentRow("s-new", at(NOW, 20 * H), at(NOW, 2 * H)),
      silentRow("s-old", at(NOW, 20 * H), at(NOW, 11 * H)),
    ];
    const all = await itemsOf({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(all.map((i) => i.clusterId)).toEqual(["s-new", "b-mid", "s-old"]);
    const two = await itemsOf({ sinceIso: SINCE, limit: 2, health: null, nowMs: NOW });
    expect(two.map((i) => i.clusterId)).toEqual(["s-new", "b-mid"]);
  });

  it("(e) sorts by alertAt, not updated_at: a newly eligible blindspot outranks an older update", async () => {
    // b-fresh qualified 30 min ago (updated_at is a day old); s-upd was updated 2 h ago.
    state.bundles = [bundle("b-fresh", at(NOW, 24.5 * H), at(NOW, 24.4 * H))];
    state.silentRows = [silentRow("s-upd", at(NOW, 20 * H), at(NOW, 2 * H))];
    const items = await itemsOf({ sinceIso: at(NOW, 3 * H), limit: 10, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-fresh", "s-upd"]);
  });

  it("(e) breaks an alertAt tie by clusterId ascending", async () => {
    const fp = at(NOW, 40 * H);
    const upd = at(NOW, 2 * H);
    state.bundles = [bundle("b-z", fp, upd), bundle("b-a", fp, upd)];
    state.silentRows = [silentRow("s-m", at(NOW, 20 * H), upd)];
    const items = await itemsOf({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["b-a", "b-z", "s-m"]);
  });

  it("(e) applies the limit after the merge sort, not before", async () => {
    state.bundles = [
      bundle("b-old", at(NOW, 40 * H), at(NOW, 9 * H)),
      bundle("b-old2", at(NOW, 40 * H), at(NOW, 8 * H)),
    ];
    state.silentRows = [silentRow("s-top", at(NOW, 20 * H), at(NOW, 1 * H))];
    const items = await itemsOf({ sinceIso: SINCE, limit: 1, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["s-top"]);
  });

  it("has no separate blindspot cap: 40 card bundles all come back (only `limit` caps the merged list)", async () => {
    state.bundles = Array.from({ length: 40 }, (_, i) =>
      bundle(`b${i}`, at(NOW, 40 * H), at(NOW, 4 * H)),
    );
    const items = await itemsOf({ sinceIso: SINCE, limit: 100, health: null, nowMs: NOW });
    expect(items).toHaveLength(40);
    expect(items.every((i) => i.type === "blindspot")).toBe(true);
  });

  it("throws when the silent query errors (the route turns it into a 500)", async () => {
    state.silentError = { message: "boom" };
    await expect(getAlertItems({ sinceIso: SINCE, limit: 5, health: null, nowMs: NOW })).rejects.toThrow(/silent/);
  });

  // h128-apiv1-3: a database outage must still be recognisable after the prefix is added.
  it.each([
    ["a 57014 statement timeout", { message: "canceling statement due to statement timeout", code: "57014" }, 500],
    ["the reader cap's AbortError", { message: "AbortError: Supabase request exceeded 4000 ms", code: "" }, 0],
    ["a gateway answer with an HTML body (504)", { message: "<html>Gateway Timeout</html>", code: "" }, 504],
  ])("the silent query error is classified as an outage: %s", async (_label, error, status) => {
    state.silentError = error;
    state.silentStatus = status;

    const err = await getAlertItems({ sinceIso: SINCE, limit: 5, health: null, nowMs: NOW }).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe(`[alerts] silent candidate select error: ${error.message}`);
    expect(isUpstreamUnavailable(err)).toBe(true);
  });

  it("a unique violation on the silent query is not an outage", async () => {
    state.silentError = { message: "duplicate key", code: "23505" };
    state.silentStatus = 409;

    const err = await getAlertItems({ sinceIso: SINCE, limit: 5, health: null, nowMs: NOW }).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe("[alerts] silent candidate select error: duplicate key");
    expect(isUpstreamUnavailable(err)).toBe(false);
  });

  it("throws a clear error on an unparsable sinceIso instead of querying with it", async () => {
    await expect(
      getAlertItems({ sinceIso: "not-a-date", limit: 5, health: null, nowMs: NOW }),
    ).rejects.toThrow(/sinceIso/);
    expect(captured.states).toHaveLength(0);
  });
});

describe("getAlertItems blindspots beyond the 30 cards (h120-methodology-2)", () => {
  const fp = () => at(NOW, 40 * H);
  const upd = () => at(NOW, 4 * H);

  it("(a) 30 card bundles plus 14 compact rows, all inside the window, give 44 blindspot items at limit 100", async () => {
    state.bundles = Array.from({ length: 30 }, (_, i) => bundle(`b${i}`, fp(), upd()));
    state.more = Array.from({ length: 14 }, (_, i) => moreRow(`m${i}`, fp(), upd()));
    const items = await itemsOf({ sinceIso: SINCE, limit: 100, health: null, nowMs: NOW });
    expect(items).toHaveLength(44);
    expect(items.every((i) => i.type === "blindspot")).toBe(true);
    expect(new Set(items.map((i) => i.clusterId)).size).toBe(44);
    expect(items.filter((i) => i.clusterId.startsWith("m"))).toHaveLength(14);
  });

  it("(b) a compact row qualifying inside the window gets alertAt = first_published + 24 h while its updated_at is older", async () => {
    const fpMs = NOW - 24.5 * H;
    state.more = [moreRow("m-new", new Date(fpMs).toISOString(), at(NOW, 24.4 * H))];
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["m-new"]);
    expect(items[0]!.alertAt).toBe(new Date(fpMs + DELAY_MS).toISOString());
    // The record still reports the cluster's own timestamps.
    expect(items[0]!.firstPublished).toBe(new Date(fpMs).toISOString());
    expect(items[0]!.updatedAt).toBe(at(NOW, 24.4 * H));
  });

  it("(b) a compact row updated inside the window whose first_published + 24 h lies after it takes the later moment", async () => {
    // first_published + 24 h is one hour AFTER now; updated_at (1 h ago) is inside the window.
    const fpMs = NOW - 23 * H;
    state.more = [moreRow("m-later", new Date(fpMs).toISOString(), at(NOW, 1 * H))];
    const items = await itemsOf({ sinceIso: at(NOW, 2 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.alertAt).toBe(new Date(fpMs + 24 * H).toISOString());
  });

  it("(b) a compact row updated after it qualified is included with alertAt = updated_at", async () => {
    const u = at(NOW, 10 * MIN);
    state.more = [moreRow("m-upd", at(NOW, 40 * H), u)];
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.alertAt).toBe(u);
  });

  it("(c) a compact row whose alertAt is older than since is skipped, one inside the window is kept", async () => {
    state.more = [
      moreRow("m-old", at(NOW, 30 * H), at(NOW, 29 * H)),
      moreRow("m-in", at(NOW, 30 * H), at(NOW, 20 * MIN)),
    ];
    const items = await itemsOf({ sinceIso: at(NOW, 1 * H), limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["m-in"]);
  });

  it("keeps the boundary for a compact row: alertAt exactly equal to since is included", async () => {
    const fpMs = NOW - 30 * H;
    state.more = [moreRow("m-edge", new Date(fpMs).toISOString(), at(NOW, 29 * H))];
    const since = new Date(fpMs + DELAY_MS).toISOString();
    const items = await itemsOf({ sinceIso: since, limit: 50, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["m-edge"]);
  });

  it("(d) a compact row carries its dominant zone, silent zones, voting source count and zone counts from votingZoneCounts", async () => {
    state.more = [
      moreRow("m-ik", fp(), upd(), { iktidar: 8, bagimsiz: 1, muhalefet: 0 }, "iktidar"),
      moreRow("m-mu", fp(), at(NOW, 5 * H), { iktidar: 0, bagimsiz: 0, muhalefet: 6 }, "muhalefet"),
      moreRow("m-bg", fp(), at(NOW, 6 * H), { iktidar: 0, bagimsiz: 5, muhalefet: 1 }, "bagimsiz"),
    ];
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    const byId = new Map(items.map((i) => [i.clusterId, i]));
    expect(byId.get("m-ik")).toMatchObject({
      type: "blindspot",
      title: "kompakt m-ik",
      dominantZone: "iktidar",
      sourceCount: 9, // 8 + 1 + 0, not the row's own sourceCount (99)
      zoneCounts: { iktidar: 8, bagimsiz: 1, muhalefet: 0 },
      silentZones: ["muhalefet"],
    });
    expect(byId.get("m-mu")).toMatchObject({
      dominantZone: "muhalefet",
      sourceCount: 6,
      zoneCounts: { iktidar: 0, bagimsiz: 0, muhalefet: 6 },
      silentZones: ["iktidar", "bagimsiz"],
    });
    expect(byId.get("m-bg")).toMatchObject({
      dominantZone: "bagimsiz",
      sourceCount: 6,
      silentZones: ["iktidar"],
    });
  });

  it("a compact row's zoneCounts is a copy, not the cached row's own object", async () => {
    const row = moreRow("m-copy", fp(), upd());
    state.more = [row];
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(items[0]!.zoneCounts).toEqual(row.votingZoneCounts);
    expect(items[0]!.zoneCounts).not.toBe(row.votingZoneCounts);
  });

  it("(e) limit 10 returns the 10 newest by alertAt across cards, compact rows and silent clusters", async () => {
    // Every updated_at is later than its first_published + delay, so alertAt = updated_at.
    const ago = (n: number) => at(NOW, n * H);
    state.bundles = [bundle("b-1", ago(60), ago(30)), bundle("b-2", ago(60), ago(8))];
    state.more = [
      moreRow("m-1", ago(60), ago(25)),
      moreRow("m-2", ago(60), ago(3)),
      moreRow("m-3", ago(60), ago(1)),
    ];
    state.silentRows = [
      silentRow("s-1", ago(40), ago(20)),
      silentRow("s-2", ago(40), ago(7)),
      silentRow("s-3", ago(40), ago(2)),
    ];
    const ten = await itemsOf({ sinceIso: ago(100), limit: 10, health: null, nowMs: NOW });
    // 8 candidates only: all come back, newest alertAt first (1, 2, 3, 7, 8, 20, 25, 30 h ago).
    expect(ten.map((i) => i.clusterId)).toEqual(["m-3", "s-3", "m-2", "s-2", "b-2", "s-1", "m-1", "b-1"]);

    // 13 candidates, limit 10: the three OLDEST alertAt (42, 43, 44 h ago) fall off, whatever
    // their type. first_published 100 h ago keeps their alertAt on updated_at, not on the delay.
    state.bundles = [
      ...state.bundles,
      bundle("b-3", ago(100), ago(40)),
      bundle("b-4", ago(100), ago(41)),
    ];
    state.more = [...state.more, moreRow("m-4", ago(100), ago(42))];
    state.silentRows = [...state.silentRows, silentRow("s-4", ago(80), ago(43)), silentRow("s-5", ago(80), ago(44))];
    const capped = await itemsOf({ sinceIso: ago(100), limit: 10, health: null, nowMs: NOW });
    expect(capped).toHaveLength(10);
    expect(capped.map((i) => i.clusterId)).toEqual(["m-3", "s-3", "m-2", "s-2", "b-2", "s-1", "m-1", "b-1", "b-3", "b-4"]);
  });

  it("breaks an alertAt tie between a card and a compact row by clusterId ascending", async () => {
    state.bundles = [bundle("b-z", fp(), upd())];
    state.more = [moreRow("m-a", fp(), upd()), moreRow("a-first", fp(), upd())];
    const items = await itemsOf({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(items.map((i) => i.clusterId)).toEqual(["a-first", "b-z", "m-a"]);
  });

  it("lists a claim once if it ever sits in both bundles and more (the card wins)", async () => {
    state.bundles = [bundle("dup", fp(), upd())];
    state.more = [moreRow("dup", fp(), upd(), { iktidar: 9, bagimsiz: 0, muhalefet: 0 })];
    const items = await itemsOf({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    // The card's tally (5 / 1 / 0), not the row's (9 / 0 / 0).
    expect(items[0]!.sourceCount).toBe(6);
  });

  it("webhook dedupe: a claim has the same alert id whether it is a card or a compact row, so a promotion or demotion never re-delivers", async () => {
    const f = fp();
    const u = upd();
    state.bundles = [bundle("c1", f, u)];
    const asCard = (await itemsOf({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW }))[0]!;
    state.bundles = [];
    state.more = [moreRow("c1", f, u)];
    const asRow = (await itemsOf({ sinceIso: SINCE, limit: 10, health: null, nowMs: NOW }))[0]!;
    expect(toV1AlertRecord(asRow).id).toBe("blindspot:c1");
    expect(toV1AlertRecord(asRow).id).toBe(toV1AlertRecord(asCard).id);
    // And the same alertAt, so the since window sees it in the same polls.
    expect(asRow.alertAt).toBe(asCard.alertAt);
  });

  it("a compact row cached before updatedAt existed falls back to first_published + 24 h instead of throwing", async () => {
    const fpMs = NOW - 30 * H;
    const legacy = moreRow("m-legacy", new Date(fpMs).toISOString(), "x") as Record<string, unknown>;
    delete legacy.updatedAt;
    state.more = [legacy];
    const items = await itemsOf({ sinceIso: at(NOW, 12 * H), limit: 50, health: null, nowMs: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.alertAt).toBe(new Date(fpMs + DELAY_MS).toISOString());
  });

  it("(g) a compact row with both timestamps unparsable is dropped, never thrown on", async () => {
    state.more = [moreRow("m-bad", "nope", "garbage")];
    expect(await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).toEqual([]);
  });

  it("an empty title falls back to an empty string like a card", async () => {
    state.more = [{ ...moreRow("m-nt", fp(), upd()), title: "   " }];
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(items[0]!.title).toBe("");
  });

  it("one_zone_silent stays disjoint: its query still excludes blindspot claims and its limit is unchanged", async () => {
    state.more = [moreRow("m1", fp(), upd())];
    await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(captured.states).toHaveLength(1);
    expect(captured.states[0]!.eq).toEqual(expect.arrayContaining([{ col: "is_blindspot", val: false }]));
    expect(captured.states[0]!.limit).toBe(1000);
  });
});

describe("getAlertItems silent candidate cap (h103-apiv1-1)", () => {
  /** A candidate row the SQL returns but `oneZoneSilentOf` rejects (4 voting sources). */
  const filler = (i: number) =>
    silentRow(`f${i}`, at(NOW, 20 * H), at(NOW, 2 * H + i * 1000), { pro_government: 2, center: 2 });

  it("(a) the silent select asks for 1000 candidates, not 200", async () => {
    await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(captured.states).toHaveLength(1);
    expect(captured.states[0]!.limit).toBe(1000);
  });

  it("(b) reports truncated=true when the candidate pull returns exactly 1000 rows", async () => {
    state.silentRows = Array.from({ length: 1000 }, (_, i) => filler(i));
    const res = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(res.truncated).toBe(true);
    // The flag reflects the pull, not what was kept: none of the 1000 qualified.
    expect(res.items).toEqual([]);
  });

  it("(b) reports truncated=false for 999 rows, for an empty pull and for a plain pull", async () => {
    state.silentRows = Array.from({ length: 999 }, (_, i) => filler(i));
    expect((await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).truncated).toBe(false);
    state.silentRows = [];
    expect((await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW })).truncated).toBe(false);
    state.silentRows = [silentRow("s1", at(NOW, 12 * H), at(NOW, 3 * H))];
    const res = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(res.truncated).toBe(false);
    expect(res.items.map((i) => i.clusterId)).toEqual(["s1"]);
  });

  it("(b) always returns the { items, truncated } shape with a boolean flag", async () => {
    const res = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(Object.keys(res).sort()).toEqual(["items", "truncated"]);
    expect(typeof res.truncated).toBe("boolean");
    expect(Array.isArray(res.items)).toBe(true);
  });

  it("(b) truncated reflects the silent pull only, however many blindspots (cards and rows) are listed", async () => {
    state.bundles = Array.from({ length: 30 }, (_, i) => bundle(`b${i}`, at(NOW, 40 * H), at(NOW, 4 * H)));
    state.more = Array.from({ length: 14 }, (_, i) => moreRow(`m${i}`, at(NOW, 40 * H), at(NOW, 4 * H)));
    const res = await getAlertItems({ sinceIso: SINCE, limit: 100, health: null, nowMs: NOW });
    expect(res.items).toHaveLength(44);
    expect(res.truncated).toBe(false);
  });

  it("(b) a full silent pull stays truncated=true when the limit slice or the health filter drops rows afterwards", async () => {
    state.silentRows = Array.from({ length: 1000 }, (_, i) =>
      silentRow(`s${i}`, at(NOW, 20 * H), at(NOW, 2 * H + i * 1000)),
    );
    const res = await getAlertItems({ sinceIso: SINCE, limit: 5, health: health({}), nowMs: NOW });
    expect(res.items).toHaveLength(5);
    expect(res.truncated).toBe(true);
    const degraded = await getAlertItems({ sinceIso: SINCE, limit: 5, health: health({ muhalefet: true }), nowMs: NOW });
    expect(degraded.items).toEqual([]);
    expect(degraded.truncated).toBe(true);
  });

  it("(c) a qualifying row at rank 230 by updated_at, behind 229 non-qualifying candidates, is returned (no 200 cut left)", async () => {
    const rows = Array.from({ length: 229 }, (_, i) => filler(i));
    rows.push(silentRow("s-rank-230", at(NOW, 20 * H), at(NOW, 2 * H + 500 * 1000)));
    expect(rows).toHaveLength(230);
    state.silentRows = rows;
    const res = await getAlertItems({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(res.items.map((i) => i.clusterId)).toEqual(["s-rank-230"]);
    expect(res.truncated).toBe(false);
  });

  it("(c) keeps every qualifying row of a 7-day pull beyond the old 200 cut (64 qualify among 402 candidates)", async () => {
    const SEVEN_DAYS = 7 * 24 * H;
    // 402 candidates in updated_at-descending order; every ~6th qualifies, as on prod.
    const rows = Array.from({ length: 402 }, (_, i) => {
      const updatedAgo = 2 * H + Math.floor((i * (SEVEN_DAYS - 3 * H)) / 402);
      return i % 6 === 0 && i < 384
        ? silentRow(`q${i}`, at(NOW, updatedAgo + 3 * H), at(NOW, updatedAgo))
        : silentRow(`n${i}`, at(NOW, updatedAgo + 3 * H), at(NOW, updatedAgo), { pro_government: 2, center: 2 });
    });
    state.silentRows = rows;
    const expected = rows.filter((r) => r.id.startsWith("q")).length;
    expect(expected).toBe(64);
    const res = await getAlertItems({
      sinceIso: at(NOW, SEVEN_DAYS),
      limit: 100,
      health: null,
      nowMs: NOW,
    });
    expect(res.items.filter((i) => i.type === "one_zone_silent")).toHaveLength(64);
    expect(res.truncated).toBe(false);
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
      const items = await itemsOf({
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
      await itemsOf({ sinceIso: at(NOW, 10 * MIN), limit: 50, health: null, nowMs: NOW }),
    ).toEqual([]);

    const bumped = at(NOW, 5 * MIN);
    state.bundles = [bundle("b1", fp, bumped)];
    const items = await itemsOf({ sinceIso: at(NOW, 10 * MIN), limit: 50, health: null, nowMs: NOW });
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
      const items = await itemsOf({
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
    const items = await itemsOf({ sinceIso: at(NOW, 12 * H), limit: 50, health: null, nowMs: NOW });
    const byId = new Map(items.map((i) => [i.clusterId, i]));
    expect(byId.get("b-bad-upd")?.alertAt).toBe(new Date(fpMs + DELAY_MS).toISOString());
    expect(byId.get("s-bad-upd")?.alertAt).toBe(
      new Date(Date.parse(at(NOW, 6.5 * H)) + SILENT_MS).toISOString(),
    );
  });

  it("(g) an item with both timestamps unparsable is dropped, never thrown on", async () => {
    state.bundles = [bundle("b-bad", "nope", "garbage")];
    state.silentRows = [silentRow("s-bad", "nope", "garbage")];
    const items = await itemsOf({ sinceIso: SINCE, limit: 50, health: null, nowMs: NOW });
    expect(items).toEqual([]);
  });
});
