import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_ENTRIES,
  captureSnapshot,
  changeBadgeLabels,
  diffSnapshot,
  makeSnapshot,
  parseSnapshots,
  pruneSnapshots,
  readSnapshots,
  reconcileSnapshots,
  removeSnapshot,
  safeZoneCounts,
  sourceCountOf,
  writeSnapshots,
  type BookmarkSnapshot,
  type StorageLike,
} from "./bookmark-snapshots";

// The browser client is mocked so defaultFetchRow can be exercised without a
// network: `factory` counts evaluations of the module (i.e. real imports).
const browser = vi.hoisted(() => ({
  factory: vi.fn(),
  createBrowserClient: vi.fn(),
}));
vi.mock("@/lib/supabase/browser", () => {
  browser.factory();
  return { createBrowserClient: browser.createBrowserClient };
});

const NOW = "2026-09-29T10:00:00.000Z";

function memStorage(seed: Record<string, string> = {}): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>(Object.entries(seed));
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
  };
}

function snap(
  zones: Partial<Record<"iktidar" | "bagimsiz" | "muhalefet", number>>,
  sources: number,
  extra: Partial<BookmarkSnapshot> = {},
): BookmarkSnapshot {
  return {
    v: 1,
    at: NOW,
    zones: { iktidar: 0, bagimsiz: 0, muhalefet: 0, ...zones },
    sources,
    basis: "save",
    ...extra,
  };
}

// pro_government -> iktidar, center -> bagimsiz, opposition -> muhalefet
function row(dist: unknown, article_count: number) {
  return { bias_distribution: dist, article_count };
}

describe("safeZoneCounts", () => {
  it("ignores unknown keys, non-numbers and negative values", () => {
    expect(safeZoneCounts({ bogus: 3, center: "x", opposition: -1 })).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
  it("sums biases into zones and tolerates junk input", () => {
    expect(safeZoneCounts({ pro_government: 2, gov_leaning: 1, center: 4, opposition: 1 })).toEqual({
      iktidar: 3,
      bagimsiz: 4,
      muhalefet: 1,
    });
    expect(safeZoneCounts(null)).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
    expect(safeZoneCounts("x")).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
    expect(safeZoneCounts({ opposition: Infinity, center: NaN })).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });
});

describe("makeSnapshot", () => {
  it("captures zones, sources, basis and time", () => {
    expect(makeSnapshot(row({ center: 2 }, 5), "first-view", NOW)).toEqual(
      snap({ bagimsiz: 2 }, 5, { basis: "first-view" }),
    );
  });
  it("coerces a bad article_count to 0", () => {
    expect(makeSnapshot({ bias_distribution: {}, article_count: NaN }, "save", NOW).sources).toBe(0);
  });
});

describe("diffSnapshot / changeBadgeLabels", () => {
  it("flags a zone that went 0 -> 2", () => {
    const d = diffSnapshot(snap({ iktidar: 1, bagimsiz: 1 }, 2), row({ pro_government: 1, center: 1, opposition: 2 }, 2));
    expect(d).not.toBeNull();
    expect(d!.newZones).toEqual(["muhalefet"]);
    expect(changeBadgeLabels(d!)).toEqual(["Muhalefet medyası da yazmaya başladı"]);
  });

  it("drops ' da' when all zones were 0 at baseline", () => {
    const d = diffSnapshot(snap({}, 0), row({ opposition: 1 }, 1));
    expect(d!.hadCoverage).toBe(false);
    expect(changeBadgeLabels(d!)).toEqual(["Muhalefet medyası yazmaya başladı"]);
  });

  it("+1 source gives no badge, +2 gives '+2 yeni kaynak'", () => {
    const base = snap({ iktidar: 1 }, 3);
    expect(diffSnapshot(base, row({ pro_government: 1 }, 4))).toBeNull();
    const d = diffSnapshot(base, row({ pro_government: 1 }, 5));
    expect(changeBadgeLabels(d!)).toEqual(["+2 yeni kaynak"]);
  });

  it("ignores a decrease", () => {
    expect(diffSnapshot(snap({ iktidar: 2, bagimsiz: 1 }, 6), row({ pro_government: 1 }, 2))).toBeNull();
  });

  it("caps at 2 zone badges plus 1 sources badge, in spectrum order", () => {
    const d = diffSnapshot(snap({}, 1), row({ pro_government: 1, center: 1, opposition: 1 }, 9));
    expect(changeBadgeLabels(d!)).toEqual([
      "İktidar medyası yazmaya başladı",
      "Bağımsız medya yazmaya başladı",
      "+8 yeni kaynak",
    ]);
  });

  it("never throws on garbage rows", () => {
    expect(diffSnapshot(snap({}, 0), row(undefined, undefined as unknown as number))).toBeNull();
    expect(() => diffSnapshot(null as unknown as BookmarkSnapshot, row({}, 1))).not.toThrow();
  });
});

describe("reconcileSnapshots", () => {
  it("writes first-view baselines and reports no change for them", () => {
    const rows = [{ id: "a", ...row({ center: 1 }, 3) }];
    const { changes, toWrite } = reconcileSnapshots(rows, {}, NOW);
    expect(changes).toEqual({});
    expect(toWrite.a).toEqual(snap({ bagimsiz: 1 }, 3, { basis: "first-view" }));
  });

  it("reports changes for rows with a snapshot and carries the basis", () => {
    const rows = [{ id: "a", ...row({ center: 1, opposition: 1 }, 3) }];
    const { changes, toWrite } = reconcileSnapshots(rows, { a: snap({ bagimsiz: 1 }, 3, { basis: "first-view" }) }, NOW);
    expect(toWrite).toEqual({});
    expect(changes.a.newZones).toEqual(["muhalefet"]);
    expect(changes.a.basis).toBe("first-view");
  });
});

// h112-follows-3 (migration 192): /saved prints the wire-collapsed count (saved_clusters_v4's
// effective_article_count), so the snapshot's `sources` and the "+N yeni kaynak" badge count the same thing.
// Example from production: cluster 1e801e36 has article_count 6 (6 sources, 3 distinct texts) and its own
// page says "3 kaynak": raw 6 -> effective 3.
function effRow(dist: unknown, article_count: number, effective_article_count: number | null | undefined) {
  return { bias_distribution: dist, article_count, effective_article_count };
}

describe("sourceCountOf / makeSnapshot: the effective count when the row has one", () => {
  it("prefers a positive effective_article_count over article_count", () => {
    expect(sourceCountOf(effRow({}, 6, 3))).toBe(3);
    expect(sourceCountOf(effRow({}, 6, 6))).toBe(6);
    expect(sourceCountOf(effRow({}, 2, 1))).toBe(1);
  });

  it("falls back to article_count when the field is absent, null or unusable (v3 / v2 / v1 rows, a cluster with no members)", () => {
    expect(sourceCountOf(row({}, 6))).toBe(6);
    expect(sourceCountOf(effRow({}, 6, null))).toBe(6);
    expect(sourceCountOf(effRow({}, 6, undefined))).toBe(6);
    for (const bad of [0, -1, NaN, Infinity, 2.5, "3" as unknown as number]) {
      expect(sourceCountOf(effRow({}, 6, bad)), String(bad)).toBe(6);
    }
  });

  it("is 0 when neither count is usable", () => {
    expect(sourceCountOf(effRow({}, NaN, null))).toBe(0);
    expect(sourceCountOf({ bias_distribution: {}, article_count: undefined as unknown as number })).toBe(0);
    expect(sourceCountOf(undefined as unknown as { bias_distribution: unknown; article_count: number })).toBe(0);
  });

  it("makeSnapshot stores the effective count as `sources`", () => {
    expect(makeSnapshot(effRow({ center: 2 }, 6, 3), "save", NOW)).toEqual(snap({ bagimsiz: 2 }, 3));
    expect(makeSnapshot(effRow({ center: 2 }, 6, null), "save", NOW)).toEqual(snap({ bagimsiz: 2 }, 6));
  });
});

describe("diffSnapshot: the '+N yeni kaynak' badge follows the effective count", () => {
  it("no badge when the raw count grows but the effective count does not (outlets reprinting the same wire text)", () => {
    const base = snap({ iktidar: 1 }, 3); // taken on the effective count
    expect(diffSnapshot(base, effRow({ pro_government: 1 }, 6, 3))).toBeNull();
    expect(diffSnapshot(base, effRow({ pro_government: 1 }, 40, 3))).toBeNull();
    // +1 effective is still below MIN_NEW_SOURCES
    expect(diffSnapshot(base, effRow({ pro_government: 1 }, 9, 4))).toBeNull();
  });

  it("a badge when the effective count grows by 2 or more, worded as before", () => {
    const base = snap({ iktidar: 1 }, 3);
    const d = diffSnapshot(base, effRow({ pro_government: 1 }, 9, 5));
    expect(d).not.toBeNull();
    expect(d!.newSources).toBe(2);
    expect(changeBadgeLabels(d!)).toEqual(["+2 yeni kaynak"]);
    expect(changeBadgeLabels(diffSnapshot(base, effRow({ pro_government: 1 }, 9, 8))!)).toEqual(["+5 yeni kaynak"]);
  });

  it("a row without an effective count is diffed on article_count exactly as before", () => {
    const base = snap({ iktidar: 1 }, 3);
    expect(diffSnapshot(base, row({ pro_government: 1 }, 4))).toBeNull();
    expect(changeBadgeLabels(diffSnapshot(base, row({ pro_government: 1 }, 5))!)).toEqual(["+2 yeni kaynak"]);
    expect(diffSnapshot(base, effRow({ pro_government: 1 }, 5, null))!.newSources).toBe(2);
  });

  it("a raw-based snapshot above the current effective count shows no badge and no negative delta", () => {
    const legacy = snap({ iktidar: 1 }, 6); // taken on the raw count of 1e801e36
    expect(diffSnapshot(legacy, effRow({ pro_government: 1 }, 6, 3))).toBeNull();
  });

  it("still reports a new zone on a re-based row (the zones baseline is untouched)", () => {
    const legacy = snap({ iktidar: 1 }, 6);
    const d = diffSnapshot(legacy, effRow({ pro_government: 1, opposition: 1 }, 6, 3));
    expect(d).not.toBeNull();
    expect(d!.newZones).toEqual(["muhalefet"]);
    expect(d!.newSources).toBe(0);
    expect(changeBadgeLabels(d!)).toEqual(["Muhalefet medyası da yazmaya başladı"]);
  });
});

describe("reconcileSnapshots: a snapshot taken on the raw count is re-based silently (h112-follows-3)", () => {
  it("lowers `sources` to the effective count on first read, with no badge, keeping zones, time and basis", () => {
    const stored = snap({ iktidar: 1 }, 6, { basis: "save", at: "2026-09-01T00:00:00.000Z" });
    const { changes, toWrite } = reconcileSnapshots([{ id: "a", ...effRow({ pro_government: 1 }, 6, 3) }], { a: stored }, NOW);
    expect(changes).toEqual({});
    expect(toWrite.a).toEqual({ ...stored, sources: 3 });
    expect(toWrite.a!.basis).toBe("save");
    expect(toWrite.a!.at).toBe("2026-09-01T00:00:00.000Z");
    expect(toWrite.a!.zones).toEqual(stored.zones);
  });

  it("after the re-base, a later effective growth of 2 shows the badge", () => {
    const stored = snap({ iktidar: 1 }, 6);
    const first = reconcileSnapshots([{ id: "a", ...effRow({ pro_government: 1 }, 6, 3) }], { a: stored }, NOW);
    const rebased = { a: first.toWrite.a! };
    const later = reconcileSnapshots([{ id: "a", ...effRow({ pro_government: 1 }, 9, 5) }], rebased, NOW);
    expect(later.toWrite).toEqual({});
    expect(changeBadgeLabels(later.changes.a!)).toEqual(["+2 yeni kaynak"]);
  });

  it("a re-based row can still carry a zone badge in the same read", () => {
    const stored = snap({ iktidar: 1 }, 6);
    const { changes, toWrite } = reconcileSnapshots(
      [{ id: "a", ...effRow({ pro_government: 1, opposition: 1 }, 6, 3) }],
      { a: stored },
      NOW,
    );
    expect(toWrite.a!.sources).toBe(3);
    expect(changes.a!.newZones).toEqual(["muhalefet"]);
    expect(changes.a!.newSources).toBe(0);
  });

  it("writes nothing when the snapshot is not above the effective count, or the row has no effective count", () => {
    const equal = reconcileSnapshots([{ id: "a", ...effRow({ pro_government: 1 }, 6, 3) }], { a: snap({ iktidar: 1 }, 3) }, NOW);
    expect(equal.toWrite).toEqual({});
    const below = reconcileSnapshots([{ id: "a", ...effRow({ pro_government: 1 }, 6, 4) }], { a: snap({ iktidar: 1 }, 3) }, NOW);
    expect(below.toWrite).toEqual({});
    // v3 / v2 / v1 rows (no effective count): a lower raw count never rewrites the stored baseline (as before)
    const raw = reconcileSnapshots([{ id: "a", ...row({ pro_government: 1 }, 2) }], { a: snap({ iktidar: 1 }, 6) }, NOW);
    expect(raw.toWrite).toEqual({});
    expect(raw.changes).toEqual({});
    const nul = reconcileSnapshots([{ id: "a", ...effRow({ pro_government: 1 }, 2, null) }], { a: snap({ iktidar: 1 }, 6) }, NOW);
    expect(nul.toWrite).toEqual({});
  });

  it("a first view stores the effective count, not the raw one", () => {
    const { changes, toWrite } = reconcileSnapshots([{ id: "a", ...effRow({ center: 1 }, 6, 3) }], {}, NOW);
    expect(changes).toEqual({});
    expect(toWrite.a).toEqual(snap({ bagimsiz: 1 }, 3, { basis: "first-view" }));
  });
});

describe("parseSnapshots", () => {
  it("handles garbage JSON and non-objects", () => {
    expect(parseSnapshots("{nope")).toEqual({});
    expect(parseSnapshots(null)).toEqual({});
    expect(parseSnapshots("[1,2]")).toEqual({});
    expect(parseSnapshots("42")).toEqual({});
  });
  it("keeps valid entries and drops malformed ones", () => {
    const good = snap({ iktidar: 1 }, 2);
    const raw = JSON.stringify({ ok: good, bad1: { v: 2 }, bad2: { ...good, zones: { iktidar: "x" } }, bad3: null });
    expect(parseSnapshots(raw)).toEqual({ ok: good });
  });
});

describe("storage functions", () => {
  it("round-trips through read/write and removes", () => {
    const s = memStorage();
    writeSnapshots({ a: snap({}, 1), b: snap({}, 2) }, s);
    expect(Object.keys(readSnapshots(s)).sort()).toEqual(["a", "b"]);
    removeSnapshot("a", s);
    expect(Object.keys(readSnapshots(s))).toEqual(["b"]);
  });

  it("evicts the oldest entries past the cap", () => {
    const s = memStorage();
    const map: Record<string, BookmarkSnapshot> = {};
    for (let i = 0; i < SNAPSHOT_MAX_ENTRIES + 5; i++) {
      map[`id${i}`] = snap({}, 1, { at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }
    writeSnapshots(map, s);
    const out = readSnapshots(s);
    expect(Object.keys(out)).toHaveLength(SNAPSHOT_MAX_ENTRIES);
    expect(out.id0).toBeUndefined();
    expect(out.id4).toBeUndefined();
    expect(out.id5).toBeDefined();
  });

  it("prunes entries not in keepIds", () => {
    const s = memStorage();
    writeSnapshots({ a: snap({}, 1), b: snap({}, 1) }, s);
    pruneSnapshots(["b"], s);
    expect(Object.keys(readSnapshots(s))).toEqual(["b"]);
  });

  it("never throws when storage throws or is null", () => {
    const boom: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readSnapshots(boom)).toEqual({});
    expect(() => writeSnapshots({ a: snap({}, 1) }, boom)).not.toThrow();
    expect(() => removeSnapshot("a", boom)).not.toThrow();
    expect(() => pruneSnapshots([], boom)).not.toThrow();
    // SSR / node env: default storage resolves to null
    expect(readSnapshots()).toEqual({});
    expect(() => writeSnapshots({})).not.toThrow();
  });
});

describe("captureSnapshot", () => {
  const fetched = row({ center: 2 }, 4);

  it("writes a 'save' snapshot when still saved", async () => {
    const s = memStorage();
    await captureSnapshot("a", { fetchRow: async () => fetched, storage: s, isStillSaved: () => true, nowIso: NOW });
    expect(readSnapshots(s).a).toEqual(snap({ bagimsiz: 2 }, 4));
    expect(s.map.has(SNAPSHOT_KEY)).toBe(true);
  });

  it("skips when un-saved mid-fetch", async () => {
    const s = memStorage();
    let saved = true;
    await captureSnapshot("a", {
      fetchRow: async () => {
        saved = false;
        return fetched;
      },
      storage: s,
      isStillSaved: () => saved,
      nowIso: NOW,
    });
    expect(readSnapshots(s)).toEqual({});
  });

  it("skips when a snapshot already exists", async () => {
    const existing = snap({ iktidar: 1 }, 1, { basis: "first-view" });
    const s = memStorage();
    writeSnapshots({ a: existing }, s);
    await captureSnapshot("a", { fetchRow: async () => fetched, storage: s, isStillSaved: () => true, nowIso: NOW });
    expect(readSnapshots(s).a).toEqual(existing);
  });

  it("swallows fetch errors and null rows", async () => {
    const s = memStorage();
    await expect(
      captureSnapshot("a", {
        fetchRow: async () => {
          throw new Error("network");
        },
        storage: s,
        isStillSaved: () => true,
        nowIso: NOW,
      }),
    ).resolves.toBeUndefined();
    await captureSnapshot("a", { fetchRow: async () => null, storage: s, isStillSaved: () => true, nowIso: NOW });
    expect(readSnapshots(s)).toEqual({});
  });
});

describe("captureSnapshot default fetch (saved_clusters RPC, migration 116)", () => {
  const ID = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
  const fetchSpy = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    browser.factory.mockClear();
    browser.createBrowserClient.mockReset();
    fetchSpy.mockReset();
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function clientReturning(result: { data: unknown; error: unknown }) {
    // No `from` on purpose: a table read would throw and write no snapshot.
    const rpc = vi.fn().mockResolvedValue(result);
    browser.createBrowserClient.mockReturnValue({ rpc });
    return rpc;
  }

  it("calls the RPC with the single id and snapshots the first returned row", async () => {
    const rpc = clientReturning({
      data: [{ id: ID, title_tr: "x", bias_distribution: { center: 2 }, article_count: 4, updated_at: NOW }],
      error: null,
    });
    const s = memStorage();
    await captureSnapshot(ID, { storage: s, isStillSaved: () => true, nowIso: NOW });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("saved_clusters", { p_ids: [ID] });
    expect(readSnapshots(s)[ID]).toEqual(snap({ bagimsiz: 2 }, 4));
  });

  it("writes nothing on an RPC error, an empty result or a null result", async () => {
    for (const result of [
      { data: null, error: { message: "boom" } },
      { data: [{ bias_distribution: {}, article_count: 1 }], error: { message: "boom" } },
      { data: [], error: null },
      { data: null, error: null },
    ]) {
      clientReturning(result);
      const s = memStorage();
      await captureSnapshot(ID, { storage: s, isStillSaved: () => true, nowIso: NOW });
      expect(readSnapshots(s), JSON.stringify(result)).toEqual({});
    }
  });

  it("returns null for a non-UUID id with no import and no network call", async () => {
    clientReturning({ data: [{ bias_distribution: {}, article_count: 9 }], error: null });
    for (const bad of ["not-a-uuid", "", "1; drop table clusters", "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b-extra", "x".repeat(5000)]) {
      const s = memStorage();
      await captureSnapshot(bad, { storage: s, isStillSaved: () => true, nowIso: NOW });
      expect(readSnapshots(s), bad.slice(0, 20)).toEqual({});
    }
    expect(browser.factory).not.toHaveBeenCalled();
    expect(browser.createBrowserClient).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("source guards", () => {
  const dir = __dirname;
  const staticImport = /^\s*import\s[^;]*from\s*["']@\/lib\/supabase\/browser["']/m;

  it("use-bookmarks.ts does not statically import the browser Supabase client", () => {
    expect(readFileSync(join(dir, "use-bookmarks.ts"), "utf8")).not.toMatch(staticImport);
  });

  it("bookmark-snapshots.ts reads through the saved_clusters RPC and never a table", () => {
    const src = readFileSync(join(dir, "bookmark-snapshots.ts"), "utf8");
    expect(src).toMatch(/\.rpc\(\s*["']saved_clusters["']\s*,\s*\{\s*p_ids:\s*\[id\]\s*\}\s*\)/);
    // Array.from(...) is not a PostgREST table call.
    expect(src.match(/(?<!Array)\.from\(/g)).toBeNull();
  });

  it("bookmark-snapshots.ts imports it only dynamically", () => {
    const src = readFileSync(join(dir, "bookmark-snapshots.ts"), "utf8");
    expect(src).not.toMatch(staticImport);
    expect(src).toContain(`await import("@/lib/supabase/browser")`);
  });
});
