import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
  writeSnapshots,
  type BookmarkSnapshot,
  type StorageLike,
} from "./bookmark-snapshots";

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

describe("source guards", () => {
  const dir = __dirname;
  const staticImport = /^\s*import\s[^;]*from\s*["']@\/lib\/supabase\/browser["']/m;

  it("use-bookmarks.ts does not statically import the browser Supabase client", () => {
    expect(readFileSync(join(dir, "use-bookmarks.ts"), "utf8")).not.toMatch(staticImport);
  });

  it("bookmark-snapshots.ts imports it only dynamically", () => {
    const src = readFileSync(join(dir, "bookmark-snapshots.ts"), "utf8");
    expect(src).not.toMatch(staticImport);
    expect(src).toContain(`await import("@/lib/supabase/browser")`);
  });
});
