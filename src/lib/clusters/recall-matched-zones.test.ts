import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import { JEV_BLINDSPOT_SUSPECT_PROB } from "../../../supabase/functions/_shared/jev";
import {
  createSupabaseFake,
  type BuilderState,
  type PgResult,
} from "../../../tests/_helpers/supabase-fake";
import type { MediaDnaZone } from "@/types";

import {
  RECALL_MATCH_CHUNK_SIZE,
  RECALL_MATCH_EMPTY_COLUMN,
  RECALL_MATCH_MIN_PROB,
  RECALL_MATCH_NOTE,
  fetchRecallMatchedZones,
  recallQualifiedZones,
} from "./recall-matched-zones";

// h106-blindspotbadges-1: a public blindspot claim whose silent zone the site's
// own Jev recall stage matched with the same event (blindspot_recall_suspect)
// must not print absolute silence for that zone. This module answers "which
// zones did Jev match for these clusters?" and "which of them does a claim call
// silent?". It only ever words things: no count, flag or veto moves.

interface PredictionRow {
  cluster_id: string;
  jev_prob: number | string | null;
  run_id?: number | string | null;
  articles: unknown;
}

const row = (
  clusterId: string,
  prob: number | string | null,
  bias: string | null,
  kind: string | null | undefined = "outlet",
  runId?: number | string | null,
): PredictionRow => ({
  cluster_id: clusterId,
  jev_prob: prob,
  ...(runId === undefined ? {} : { run_id: runId }),
  articles: { sources: { bias, ...(kind === undefined ? {} : { kind }) } },
});

/** A fake client whose jev_shadow_predictions read is served by `serve`. */
function clientWith(serve: (state: BuilderState) => PgResult) {
  const states: BuilderState[] = [];
  const fake = createSupabaseFake({
    tables: {
      jev_shadow_predictions: (state) => {
        states.push(state);
        return serve(state);
      },
    },
  });
  return { client: fake.client as unknown as SupabaseClient, states };
}

const rowsFor =
  (rows: PredictionRow[]) =>
  (): PgResult => ({ data: rows, error: null });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("RECALL_MATCH_MIN_PROB equals the Jev stage's JEV_BLINDSPOT_SUSPECT_PROB (parity with supabase/functions/_shared/jev.ts)", () => {
    expect(RECALL_MATCH_MIN_PROB).toBe(0.7);
    expect(RECALL_MATCH_MIN_PROB).toBe(JEV_BLINDSPOT_SUSPECT_PROB);
  });

  it("chunks the id list by 100", () => {
    expect(RECALL_MATCH_CHUNK_SIZE).toBe(100);
  });

  it("words the note, the framing column and nothing absolute", () => {
    expect(RECALL_MATCH_NOTE).toBe("benzer haber başka kümede olabilir");
    expect(RECALL_MATCH_EMPTY_COLUMN).toBe("bu kümede yok · benzer haber başka kümede olabilir");
    expect(RECALL_MATCH_EMPTY_COLUMN).not.toContain("sessizlik");
  });
});

describe("fetchRecallMatchedZones: the query", () => {
  it("reads blindspot_recall predictions of the given clusters at jev_prob >= 0.7, with the source's bias and kind", async () => {
    const { client, states } = clientWith(rowsFor([]));

    await fetchRecallMatchedZones(client, ["c1", "c2"]);

    expect(states).toHaveLength(1);
    const state = states[0]!;
    expect(state.table).toBe("jev_shadow_predictions");
    const select = String(state.selectArgs[0]);
    for (const needle of ["cluster_id", "run_id", "jev_prob", "articles", "sources", "bias", "kind"]) {
      expect(select).toContain(needle);
    }
    expect(state.eq).toContainEqual({ col: "task", val: "blindspot_recall" });
    expect(state.in).toEqual([{ col: "cluster_id", vals: ["c1", "c2"] }]);
    expect(state.gte).toContainEqual({ col: "jev_prob", val: RECALL_MATCH_MIN_PROB });
  });

  it("makes no request for an empty id list", async () => {
    const { client, states } = clientWith(rowsFor([]));

    const out = await fetchRecallMatchedZones(client, []);

    expect(out).toEqual(new Map());
    expect(states).toHaveLength(0);
  });

  it("asks for each distinct id once", async () => {
    const { client, states } = clientWith(rowsFor([]));

    await fetchRecallMatchedZones(client, ["c1", "c1", "c2", "c1"]);

    expect(states[0]!.in[0]!.vals).toEqual(["c1", "c2"]);
  });

  it("splits 150 ids into two chunked calls (100 + 50) and merges their answers", async () => {
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    const { client, states } = clientWith((state) => {
      const wanted = state.in[0]!.vals as string[];
      return {
        data: wanted.includes("c0")
          ? [row("c0", 0.9, "opposition")]
          : [row("c149", 0.8, "pro_government")],
        error: null,
      };
    });

    const out = await fetchRecallMatchedZones(client, ids);

    expect(states).toHaveLength(2);
    expect(states.map((s) => (s.in[0]!.vals as string[]).length).sort((a, b) => a - b)).toEqual([50, 100]);
    expect(out.get("c0")).toEqual(["muhalefet"]);
    expect(out.get("c149")).toEqual(["iktidar"]);
  });

  it("100 ids are a single call", async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `c${i}`);
    const { client, states } = clientWith(rowsFor([]));

    await fetchRecallMatchedZones(client, ids);

    expect(states).toHaveLength(1);
  });
});

describe("fetchRecallMatchedZones: the answer", () => {
  it("the 0.7 threshold is inclusive: 0.7 counts, 0.69 does not", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", 0.7, "opposition"),
        row("b", 0.69, "opposition"),
        row("c", 0.699, "opposition"),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b", "c"]);

    expect(out.get("a")).toEqual(["muhalefet"]);
    expect(out.has("b")).toBe(false);
    expect(out.has("c")).toBe(false);
  });

  it("ignores a null or non-numeric probability", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", null, "opposition"),
        { cluster_id: "b", jev_prob: Number.NaN, articles: { sources: { bias: "opposition", kind: "outlet" } } },
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b"]);

    expect(out.size).toBe(0);
  });

  it("ignores aggregator and niche sources, whatever the probability", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", 0.95, "opposition", "aggregator"),
        row("a", 0.95, "opposition_leaning", "niche"),
        row("b", 0.95, "center", "niche"),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b"]);

    expect(out.size).toBe(0);
  });

  it("keeps outlet and wire sources, and a source with no kind (a legacy row votes)", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", 0.8, "opposition", "outlet"),
        row("b", 0.8, "pro_government", "wire"),
        row("c", 0.8, "center", null),
        row("d", 0.8, "opposition", undefined),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b", "c", "d"]);

    expect(out.get("a")).toEqual(["muhalefet"]);
    expect(out.get("b")).toEqual(["iktidar"]);
    expect(out.get("c")).toEqual(["bagimsiz"]);
    expect(out.get("d")).toEqual(["muhalefet"]);
  });

  it("maps the source's bias to its zone", async () => {
    const cases: Array<[string, MediaDnaZone]> = [
      ["pro_government", "iktidar"],
      ["gov_leaning", "iktidar"],
      ["state_media", "iktidar"],
      ["center", "bagimsiz"],
      ["international", "bagimsiz"],
      ["opposition_leaning", "muhalefet"],
      ["opposition", "muhalefet"],
    ];
    const { client } = clientWith(
      rowsFor(cases.map(([bias], i) => row(`c${i}`, 0.9, bias))),
    );

    const out = await fetchRecallMatchedZones(client, cases.map((_, i) => `c${i}`));

    cases.forEach(([, zone], i) => expect(out.get(`c${i}`)).toEqual([zone]));
  });

  it("skips a source with an unknown or missing bias", async () => {
    const { client } = clientWith(
      rowsFor([row("a", 0.9, "not_a_bias"), row("b", 0.9, null)]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b"]);

    expect(out.size).toBe(0);
  });

  it("returns one sorted, de-duplicated array per cluster (the value must serialise in a 'use cache' payload)", async () => {
    // f5012836's shape: one Muhalefet and two Bağımsız sources, plus a repeat.
    const { client } = clientWith(
      rowsFor([
        row("f5012836", 0.86, "opposition_leaning"),
        row("f5012836", 0.76, "center"),
        row("f5012836", 0.76, "international"),
        row("f5012836", 0.9, "opposition"),
        row("411e24fc", 0.81, "center"),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["f5012836", "411e24fc"]);

    expect(out.get("f5012836")).toEqual(["bagimsiz", "muhalefet"]);
    expect(out.get("411e24fc")).toEqual(["bagimsiz"]);
    expect(JSON.parse(JSON.stringify(out.get("f5012836")))).toEqual(["bagimsiz", "muhalefet"]);
    expect(Array.isArray(out.get("f5012836"))).toBe(true);
  });

  it("has no entry for a cluster Jev matched nothing for", async () => {
    const { client } = clientWith(rowsFor([row("a", 0.9, "opposition")]));

    const out = await fetchRecallMatchedZones(client, ["a", "other"]);

    expect(out.has("other")).toBe(false);
  });

  it("tolerates a row with no article or no source, and rows of an unrequested cluster", async () => {
    const { client } = clientWith(
      rowsFor([
        { cluster_id: "a", jev_prob: 0.9, articles: null },
        { cluster_id: "a", jev_prob: 0.9, articles: { sources: null } },
        { cluster_id: null as unknown as string, jev_prob: 0.9, articles: { sources: { bias: "opposition", kind: "outlet" } } },
        row("a", 0.9, "opposition"),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a"]);

    expect(out.get("a")).toEqual(["muhalefet"]);
    expect(out.size).toBe(1);
  });

  it("accepts the embed as one-element arrays too (PostgREST shapes it by the relationship)", async () => {
    const { client } = clientWith(
      rowsFor([
        {
          cluster_id: "a",
          jev_prob: 0.9,
          articles: [{ sources: [{ bias: "opposition", kind: "outlet" }] }],
        },
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a"]);

    expect(out.get("a")).toEqual(["muhalefet"]);
  });
});

describe("fetchRecallMatchedZones: only the latest check's answers (h114-postship-1)", () => {
  // jev.ts now stores every re-check's answers (subject_id carries the day), so a
  // cluster re-checked on several days has rows of several runs. The flag follows
  // the latest check, and so must the wording.

  it("a cluster with rows of two runs reads only the newer run's: 6334 muhalefet 0.72 then 6380 center 0.75 gives bagimsiz only", async () => {
    const { client } = clientWith(
      rowsFor([
        row("23b4563e", 0.72, "opposition", "outlet", 6334),
        row("23b4563e", 0.75, "center", "outlet", 6380),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["23b4563e"]);

    expect(out.get("23b4563e")).toEqual(["bagimsiz"]);
  });

  it("the newer run wins whatever order the rows arrive in (the query has no order)", async () => {
    const { client } = clientWith(
      rowsFor([
        row("c", 0.75, "center", "outlet", 6380),
        row("c", 0.72, "opposition", "outlet", 6334),
        row("c", 0.8, "pro_government", "outlet", 6001),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["c"]);

    expect(out.get("c")).toEqual(["bagimsiz"]);
  });

  it("several rows of the SAME (latest) run all count: the zones are their union", async () => {
    const { client } = clientWith(
      rowsFor([
        row("f5012836", 0.86, "opposition_leaning", "outlet", 6380),
        row("f5012836", 0.76, "center", "outlet", 6380),
        row("f5012836", 0.72, "pro_government", "outlet", 6334),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["f5012836"]);

    expect(out.get("f5012836")).toEqual(["bagimsiz", "muhalefet"]);
  });

  it("a single run is unchanged", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", 0.9, "opposition", "outlet", 6380),
        row("a", 0.8, "center", "wire", 6380),
        row("b", 0.8, "pro_government", "outlet", 6380),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b"]);

    expect(out.get("a")).toEqual(["bagimsiz", "muhalefet"]);
    expect(out.get("b")).toEqual(["iktidar"]);
  });

  it("each cluster is judged against ITS OWN latest run, not the page's", async () => {
    const { client } = clientWith(
      rowsFor([
        row("old", 0.8, "opposition", "outlet", 6100),
        row("new", 0.8, "center", "outlet", 6380),
        row("new", 0.8, "opposition", "outlet", 6200),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["old", "new"]);

    expect(out.get("old")).toEqual(["muhalefet"]);
    expect(out.get("new")).toEqual(["bagimsiz"]);
  });

  it("an older run is read when it is the only one with a match (the latest check cleared nothing here: no newer row passes 0.7)", async () => {
    const { client } = clientWith(rowsFor([row("a", 0.8, "opposition", "outlet", 6334)]));

    const out = await fetchRecallMatchedZones(client, ["a"]);

    expect(out.get("a")).toEqual(["muhalefet"]);
  });

  it("a string jev_prob below 0.7 is still dropped, and does not make its run 'the latest'", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", "0.65", "opposition", "outlet", 6380),
        row("b", "0.75", "center", "outlet", 6380),
        row("b", "0.69", "opposition", "outlet", 6390),
        row("c", "0.7", "pro_government", "outlet", 6380),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a", "b", "c"]);

    expect(out.has("a")).toBe(false);
    expect(out.get("b")).toEqual(["bagimsiz"]);
    expect(out.get("c")).toEqual(["iktidar"]);
  });

  it("a run_id that arrives as a numeric string compares as a number (6380 beats 998, which sorts later as text)", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", 0.8, "opposition", "outlet", "998"),
        row("a", 0.8, "center", "outlet", "6380"),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a"]);

    expect(out.get("a")).toEqual(["bagimsiz"]);
  });

  it("rows with no run_id (their run was pruned) are older than any row with one; all-null rows still count together", async () => {
    const { client } = clientWith(
      rowsFor([
        row("mixed", 0.8, "opposition", "outlet", null),
        row("mixed", 0.8, "center", "outlet", 6380),
        row("nulls", 0.8, "opposition", "outlet", null),
        row("nulls", 0.8, "pro_government", "outlet"),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["mixed", "nulls"]);

    expect(out.get("mixed")).toEqual(["bagimsiz"]);
    expect(out.get("nulls")).toEqual(["iktidar", "muhalefet"]);
  });

  it("a non-voting latest-run match is ignored, but the latest run is still the one read (no fall back to a stale voting match)", async () => {
    const { client } = clientWith(
      rowsFor([
        row("a", 0.9, "opposition", "outlet", 6334),
        row("a", 0.9, "center", "aggregator", 6380),
      ]),
    );

    const out = await fetchRecallMatchedZones(client, ["a"]);

    expect(out.has("a")).toBe(false);
  });

  it("an error still returns an empty Map, run rows or not", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith(() => ({ data: null, error: { message: "boom" } }));

    await expect(fetchRecallMatchedZones(client, ["a"])).resolves.toEqual(new Map());
  });
});

describe("fetchRecallMatchedZones: fail-open", () => {
  it("returns an empty map and warns with the module prefix when the read errors; never throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith(() => ({ data: null, error: { message: "boom" } }));

    const out = await fetchRecallMatchedZones(client, ["a"]);

    expect(out).toEqual(new Map());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[recall-matched-zones\] /);
  });

  it("returns an empty map when the client itself throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = {
      from() {
        throw new Error("no connection");
      },
    } as unknown as SupabaseClient;

    await expect(fetchRecallMatchedZones(client, ["a"])).resolves.toEqual(new Map());
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/^\[recall-matched-zones\] /);
  });

  it("returns an empty map when a rejected promise comes back", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith(() => {
      throw new Error("statement timeout");
    });

    await expect(fetchRecallMatchedZones(client, ["a"])).resolves.toEqual(new Map());
  });

  it("one failing chunk empties the whole answer (no half-qualified page)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const ids = Array.from({ length: 150 }, (_, i) => `c${i}`);
    const { client } = clientWith((state) =>
      (state.in[0]!.vals as string[]).includes("c0")
        ? { data: [row("c0", 0.9, "opposition")], error: null }
        : { data: null, error: { message: "boom" } },
    );

    const out = await fetchRecallMatchedZones(client, ids);

    expect(out).toEqual(new Map());
  });

  it("does not log a cluster id, a headline or a count when it warns", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { client } = clientWith(() => ({ data: null, error: { message: "boom" } }));

    await fetchRecallMatchedZones(client, ["0746c9d2-8f33-4bad-b2da-64b3a600e5f9"]);

    expect(JSON.stringify(warn.mock.calls)).not.toContain("0746c9d2");
  });
});

describe("recallQualifiedZones", () => {
  const counts = (iktidar: number, bagimsiz: number, muhalefet: number) => ({
    iktidar,
    bagimsiz,
    muhalefet,
  });

  it("returns a matched zone that has no voting member (the 0746c9d2 shape: 9 İktidar, Muhalefet matched)", () => {
    expect(recallQualifiedZones(counts(9, 0, 0), "iktidar", ["muhalefet"])).toEqual(["muhalefet"]);
  });

  it("excludes the dominant zone even if it is listed as matched", () => {
    expect(recallQualifiedZones(counts(9, 0, 0), "iktidar", ["iktidar", "muhalefet"])).toEqual(["muhalefet"]);
    // Defensive: a (corrupt) zero tally for the dominant zone still never qualifies it.
    expect(recallQualifiedZones(counts(0, 0, 0), "iktidar", ["iktidar"])).toEqual([]);
  });

  it("excludes a matched zone that has voting members (it was not silent)", () => {
    expect(recallQualifiedZones(counts(9, 1, 0), "iktidar", ["bagimsiz", "muhalefet"])).toEqual(["muhalefet"]);
    expect(recallQualifiedZones(counts(8, 1, 1), "iktidar", ["bagimsiz", "muhalefet"])).toEqual([]);
  });

  it("a null dominant zone (no voting member at all) excludes no zone", () => {
    expect(recallQualifiedZones(counts(0, 0, 0), null, ["muhalefet", "iktidar"])).toEqual(["iktidar", "muhalefet"]);
    expect(recallQualifiedZones(counts(0, 0, 0), null, undefined)).toEqual([]);
  });

  it("returns [] when nothing matched or the lookup gave nothing", () => {
    expect(recallQualifiedZones(counts(9, 0, 0), "iktidar", [])).toEqual([]);
    expect(recallQualifiedZones(counts(9, 0, 0), "iktidar", undefined)).toEqual([]);
  });

  it("never qualifies a silent zone Jev did not match (Muhalefet here stays plain silence)", () => {
    expect(recallQualifiedZones(counts(9, 0, 0), "iktidar", ["bagimsiz"])).toEqual(["bagimsiz"]);
    expect(recallQualifiedZones(counts(0, 0, 9), "muhalefet", ["iktidar"])).toEqual(["iktidar"]);
    expect(recallQualifiedZones(counts(9, 1, 0), "iktidar", ["bagimsiz"])).toEqual([]);
  });

  it("returns a sorted, de-duplicated array", () => {
    expect(
      recallQualifiedZones(counts(9, 0, 0), "iktidar", ["muhalefet", "bagimsiz", "muhalefet"]),
    ).toEqual(["bagimsiz", "muhalefet"]);
  });

  it("does not modify its inputs", () => {
    const c = counts(9, 0, 0);
    const matched: MediaDnaZone[] = ["muhalefet", "bagimsiz"];
    recallQualifiedZones(c, "iktidar", matched);
    expect(c).toEqual(counts(9, 0, 0));
    expect(matched).toEqual(["muhalefet", "bagimsiz"]);
  });
});
