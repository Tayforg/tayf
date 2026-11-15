import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import {
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_ENTRIES,
  SNAPSHOT_MAX_RAW_CHARS,
  captureSnapshot,
  changeBadgeLabels,
  changeTitleFor,
  diffSnapshot,
  makeSnapshot,
  markStorySeen,
  parseSnapshots,
  pruneSnapshots,
  readSnapshots,
  reconcileSnapshots,
  removeSnapshot,
  safeZoneCounts,
  sourceCountOf,
  writeSnapshots,
  type BookmarkSnapshot,
  type SeenDeps,
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

// ---------------------------------------------------------------------------
// h185-roadmap2-2: opening a saved story marks it seen on this device, and the
// next /saved load clears the badge when nothing newer arrived. Client-only: the
// mark is a `seenUpdatedAt` inside the existing snapshot entry (same key, same 500-entry
// cap), written by markStorySeen, read by reconcileSnapshots. It is the server's
// `clusters.updated_at` of the page copy the reader rendered, never the client clock: an
// offline stale copy (served by the service worker) or a skewed clock must not clear a badge.
// ---------------------------------------------------------------------------

const ID_A = "6ea8b39a-6ca7-4efe-ab30-71fdf1a2187b";
const SAVED_AT = "2026-09-20T00:00:00.000Z";
// The cluster's updated_at as the page the reader opened rendered it. Server stamps, ordered T0 < UPD_1 < SEEN_UPDATED_AT.
const UPD_0 = "2026-09-29T07:00:00.000Z";
const UPD_1 = "2026-09-29T08:00:00.000Z";
const SEEN_UPDATED_AT = "2026-09-29T09:00:00.000Z";
// A client clock far ahead of every server stamp (skew, or a device set to the future).
const FAR_FUTURE = "2099-01-01T00:00:00.000Z";

/** A storage whose writes are spied on, for the "no write" assertions. */
function spyStorage(seed: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(seed));
  const setItem = vi.fn((k: string, v: string) => void map.set(k, v));
  const storage: StorageLike = { getItem: (k) => map.get(k) ?? null, setItem };
  return { map, setItem, storage };
}

describe("parseSnapshots: seenUpdatedAt and basis 'open'", () => {
  const good = snap({ iktidar: 1 }, 2, { at: SAVED_AT });

  it("keeps a snapshot whose seenUpdatedAt is a parseable ISO string", () => {
    const withSeen = { ...good, seenUpdatedAt: SEEN_UPDATED_AT };
    expect(parseSnapshots(JSON.stringify({ a: withSeen }))).toEqual({ a: withSeen });
    // Postgres-style microseconds and an offset are parseable too
    const pg = { ...good, seenUpdatedAt: "2026-09-29T08:59:59.123456+00:00" };
    expect(parseSnapshots(JSON.stringify({ a: pg })).a?.seenUpdatedAt).toBe(pg.seenUpdatedAt);
  });

  it("drops only the seenUpdatedAt field when it is not a string or not parseable; the snapshot survives", () => {
    for (const bad of [123, null, true, {}, [], "", "garbage", "2026-13-45T99:99:99Z", "x".repeat(100_000)]) {
      const out = parseSnapshots(JSON.stringify({ a: { ...good, seenUpdatedAt: bad } }));
      expect(out.a, String(bad).slice(0, 20)).toEqual(good);
      expect("seenUpdatedAt" in out.a!, String(bad).slice(0, 20)).toBe(false);
    }
  });

  it("leaves a snapshot without a seenUpdatedAt as it was", () => {
    const out = parseSnapshots(JSON.stringify({ a: good }));
    expect(out.a).toEqual(good);
    expect("seenUpdatedAt" in out.a!).toBe(false);
  });

  it("accepts basis 'open'; any other basis is still dropped", () => {
    expect(parseSnapshots(JSON.stringify({ a: { ...good, basis: "open" } })).a?.basis).toBe("open");
    for (const bad of ["bogus", "Open", "OPEN", "", 1, null, ["open"]]) {
      expect(parseSnapshots(JSON.stringify({ a: { ...good, basis: bad } })), String(bad)).toEqual({});
    }
    const noBasis: Record<string, unknown> = { ...good };
    delete noBasis.basis;
    expect(parseSnapshots(JSON.stringify({ a: noBasis }))).toEqual({});
  });

  it("an oversized stored value reads as empty instead of being parsed", () => {
    const body = JSON.stringify({ a: good });
    expect(parseSnapshots(body + " ".repeat(SNAPSHOT_MAX_RAW_CHARS + 1 - body.length))).toEqual({});
    // exactly at the limit is still read
    expect(parseSnapshots(body + " ".repeat(SNAPSHOT_MAX_RAW_CHARS - body.length))).toEqual({ a: good });
    // a full 500-entry map is far below the limit
    const full: Record<string, BookmarkSnapshot> = {};
    for (let i = 0; i < SNAPSHOT_MAX_ENTRIES; i++) full[`${ID_A.slice(0, 30)}${String(i).padStart(6, "0")}`] = { ...good, seenUpdatedAt: SEEN_UPDATED_AT };
    expect(JSON.stringify(full).length).toBeLessThan(SNAPSHOT_MAX_RAW_CHARS / 4);
    expect(Object.keys(parseSnapshots(JSON.stringify(full)))).toHaveLength(SNAPSHOT_MAX_ENTRIES);
  });
});

describe("markStorySeen", () => {
  const stored = snap({ iktidar: 1, bagimsiz: 2 }, 5, { at: SAVED_AT, basis: "first-view" });
  const saved = () => true;

  it("makes no write and adds no key for a story with no snapshot (an unsaved story's page leaves no trace)", () => {
    const empty = spyStorage();
    markStorySeen(ID_A, UPD_1, { storage: empty.storage, isStillSaved: saved });
    expect(empty.setItem).not.toHaveBeenCalled();
    expect(empty.map.size).toBe(0);
    // another story's snapshot is no reason to write either
    const other = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ other: stored }) });
    markStorySeen(ID_A, UPD_1, { storage: other.storage, isStillSaved: saved });
    expect(other.setItem).not.toHaveBeenCalled();
  });

  it("rewrites the snapshot with seenUpdatedAt = the page's server stamp and every other field byte-identical", () => {
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
    markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved });
    expect(s.setItem).toHaveBeenCalledTimes(1);
    expect(s.setItem.mock.calls[0]![0]).toBe(SNAPSHOT_KEY);
    const after = JSON.parse(s.map.get(SNAPSHOT_KEY)!) as Record<string, Record<string, unknown>>;
    const { seenUpdatedAt, ...rest } = after[ID_A]!;
    expect(seenUpdatedAt).toBe(UPD_1);
    expect(JSON.stringify(rest)).toBe(JSON.stringify(stored));
    expect(readSnapshots(s.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: UPD_1 });
  });

  it("keeps every other story's snapshot exactly as it was", () => {
    const other = snap({ muhalefet: 3 }, 7, { at: SAVED_AT, seenUpdatedAt: SEEN_UPDATED_AT });
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored, other }) });
    markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage).other).toEqual(other);
  });

  it("a later page copy moves seenUpdatedAt forward and nothing else", () => {
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: { ...stored, seenUpdatedAt: UPD_1 } }) });
    markStorySeen(ID_A, SEEN_UPDATED_AT, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: SEEN_UPDATED_AT });
  });

  it("(d) never lowers it: an offline stale copy that opens after a fresh one keeps the later stamp", () => {
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
    markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved });
    markStorySeen(ID_A, UPD_0, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: UPD_1 });
    // the same stamp again leaves it as it is
    markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: UPD_1 });
    // a later one still moves it
    markStorySeen(ID_A, SEEN_UPDATED_AT, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]?.seenUpdatedAt).toBe(SEEN_UPDATED_AT);
  });

  it("(d) compares instants, not strings: a Postgres offset stamp is ordered by its instant", () => {
    const later = "2026-09-29T11:30:00+03:00"; // 08:30Z, later than UPD_1 (08:00Z) though 'smaller' as a string
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: { ...stored, seenUpdatedAt: UPD_1 } }) });
    markStorySeen(ID_A, later, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]?.seenUpdatedAt).toBe(later);
    markStorySeen(ID_A, "2026-09-29T07:00:00.000000+00:00", { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]?.seenUpdatedAt).toBe(later);
  });

  it("an unusable stored seenUpdatedAt is replaced by the new stamp (it never blocks a mark)", () => {
    const raw = JSON.stringify({ [ID_A]: { ...stored, seenUpdatedAt: "garbage" } });
    const s = spyStorage({ [SNAPSHOT_KEY]: raw });
    markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved });
    expect(readSnapshots(s.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: UPD_1 });
  });

  it("(c) ignores the client clock: a skewed-ahead clock and a nowIso dep change nothing", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(FAR_FUTURE));
      const plain = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
      markStorySeen(ID_A, UPD_1, { storage: plain.storage, isStillSaved: saved });
      expect(readSnapshots(plain.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: UPD_1 });
      expect(plain.map.get(SNAPSHOT_KEY)).not.toContain("2099");

      // a deps clock is not a field of SeenDeps any more: handed one anyway, it is not read
      const withClock = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
      markStorySeen(ID_A, UPD_1, { storage: withClock.storage, isStillSaved: saved, nowIso: FAR_FUTURE } as SeenDeps);
      expect(readSnapshots(withClock.storage)[ID_A]).toEqual({ ...stored, seenUpdatedAt: UPD_1 });
      expect(withClock.map.get(SNAPSHOT_KEY)).not.toContain("2099");
    } finally {
      vi.useRealTimers();
    }
  });

  it("(e) an empty, garbage or oversized updatedAt writes nothing", () => {
    const bad: unknown[] = [
      "",
      "   ",
      "garbage",
      "2026-13-45T99:99:99Z",
      "x".repeat(100_000),
      "9".repeat(65), // one past MAX_TIME_CHARS
      null,
      undefined,
      0,
      1790672399123,
      {},
      [],
      true,
    ];
    for (const updatedAt of bad) {
      const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
      markStorySeen(ID_A, updatedAt as string, { storage: s.storage, isStillSaved: saved });
      expect(s.setItem, String(updatedAt).slice(0, 20)).not.toHaveBeenCalled();
      expect(readSnapshots(s.storage)[ID_A], String(updatedAt).slice(0, 20)).toEqual(stored);
    }
  });

  it("a bad updatedAt does not disturb a stamp that is already there", () => {
    const seeded = { ...stored, seenUpdatedAt: UPD_1 };
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: seeded }) });
    markStorySeen(ID_A, "garbage", { storage: s.storage, isStillSaved: saved });
    expect(s.setItem).not.toHaveBeenCalled();
    expect(readSnapshots(s.storage)[ID_A]).toEqual(seeded);
  });

  it("makes no write when the story is not bookmarked (any longer)", () => {
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
    markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: () => false });
    expect(s.setItem).not.toHaveBeenCalled();
    expect(readSnapshots(s.storage)[ID_A]).toEqual(stored);
  });

  it("asks isStillSaved about the lower-case key the bookmarks and snapshots use", () => {
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
    const asked: string[] = [];
    markStorySeen(ID_A.toUpperCase(), UPD_1, {
      storage: s.storage,
      isStillSaved: (id) => {
        asked.push(id);
        return true;
      },
    });
    expect(asked).toEqual([ID_A]);
    expect(readSnapshots(s.storage)[ID_A]?.seenUpdatedAt).toBe(UPD_1);
  });

  it("without isStillSaved it reads tayf:bookmarks from the same storage it was given", () => {
    const seed = { [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) };
    const yes = spyStorage({ ...seed, "tayf:bookmarks": JSON.stringify([ID_A]) });
    markStorySeen(ID_A, UPD_1, { storage: yes.storage });
    expect(readSnapshots(yes.storage)[ID_A]?.seenUpdatedAt).toBe(UPD_1);

    for (const list of [JSON.stringify(["other"]), "{nope", "null", JSON.stringify({ [ID_A]: true })]) {
      const no = spyStorage({ ...seed, "tayf:bookmarks": list });
      markStorySeen(ID_A, UPD_1, { storage: no.storage });
      expect(no.setItem, list).not.toHaveBeenCalled();
    }
    const missing = spyStorage(seed);
    markStorySeen(ID_A, UPD_1, { storage: missing.storage });
    expect(missing.setItem).not.toHaveBeenCalled();
  });

  it("counts a legacy upper-case bookmark entry as saved, the way use-bookmarks folds it on read", () => {
    const s = spyStorage({
      [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }),
      "tayf:bookmarks": JSON.stringify([ID_A.toUpperCase(), 7, null]),
    });
    markStorySeen(ID_A, UPD_1, { storage: s.storage });
    expect(readSnapshots(s.storage)[ID_A]?.seenUpdatedAt).toBe(UPD_1);
  });

  it("only ever writes the snapshot key: no new storage key", () => {
    const s = spyStorage({
      [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }),
      "tayf:bookmarks": JSON.stringify([ID_A]),
    });
    markStorySeen(ID_A, UPD_1, { storage: s.storage });
    expect(s.setItem.mock.calls.map((c) => c[0])).toEqual([SNAPSHOT_KEY]);
    expect([...s.map.keys()].sort()).toEqual([SNAPSHOT_KEY, "tayf:bookmarks"].sort());
  });

  it("never throws: storage that throws on read or write, null storage, a throwing isStillSaved, node's default storage", () => {
    const seed = JSON.stringify({ [ID_A]: stored });
    const readBoom: StorageLike = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {},
    };
    const writeBoom: StorageLike = {
      getItem: (k) => (k === SNAPSHOT_KEY ? seed : null),
      setItem: () => {
        throw new Error("quota");
      },
    };
    expect(() => markStorySeen(ID_A, UPD_1, { storage: readBoom, isStillSaved: saved })).not.toThrow();
    expect(() => markStorySeen(ID_A, UPD_1, { storage: writeBoom, isStillSaved: saved })).not.toThrow();
    expect(() => markStorySeen(ID_A, UPD_1, { storage: null, isStillSaved: saved })).not.toThrow();
    expect(() =>
      markStorySeen(ID_A, UPD_1, {
        storage: spyStorage({ [SNAPSHOT_KEY]: seed }).storage,
        isStillSaved: () => {
          throw new Error("boom");
        },
      }),
    ).not.toThrow();
    // SSR / node env: the default storage resolves to null
    expect(() => markStorySeen(ID_A, UPD_1)).not.toThrow();
    expect(() => markStorySeen(ID_A, UPD_1, {})).not.toThrow();
    // a junk id
    for (const bad of ["", "   ", null, undefined, 42, {}] as unknown[]) {
      expect(() => markStorySeen(bad as string, UPD_1, { storage: writeBoom, isStillSaved: saved })).not.toThrow();
    }
  });

  it("an empty, malformed or oversized stored value is no snapshot: no write, no throw", () => {
    const body = JSON.stringify({ [ID_A]: stored });
    for (const raw of [
      "",
      "{nope",
      "null",
      "[]",
      "42",
      '"text"',
      body + " ".repeat(SNAPSHOT_MAX_RAW_CHARS + 1 - body.length),
    ]) {
      const s = spyStorage({ [SNAPSHOT_KEY]: raw });
      expect(() => markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved }), raw.slice(0, 12)).not.toThrow();
      expect(s.setItem, raw.slice(0, 12)).not.toHaveBeenCalled();
    }
  });

  it("stays capped: a stored map over the cap is written back at the cap, the marked story kept", () => {
    const map: Record<string, BookmarkSnapshot> = {};
    for (let i = 0; i < SNAPSHOT_MAX_ENTRIES + 5; i++) {
      map[`id${i}`] = snap({}, 1, { at: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString() });
    }
    const newest = `id${SNAPSHOT_MAX_ENTRIES + 4}`;
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify(map) });
    markStorySeen(newest, UPD_1, { storage: s.storage, isStillSaved: saved });
    const out = readSnapshots(s.storage);
    expect(Object.keys(out)).toHaveLength(SNAPSHOT_MAX_ENTRIES);
    expect(out[newest]?.seenUpdatedAt).toBe(UPD_1);
    expect(out.id0).toBeUndefined();
  });

  it("marking the same story again does not grow the map", () => {
    const s = spyStorage({ [SNAPSHOT_KEY]: JSON.stringify({ [ID_A]: stored }) });
    for (let i = 0; i < 5; i++) markStorySeen(ID_A, UPD_1, { storage: s.storage, isStillSaved: saved });
    expect(Object.keys(readSnapshots(s.storage))).toEqual([ID_A]);
  });
});

describe("reconcileSnapshots: a story opened since it was saved is rebaselined (h185-roadmap2-2)", () => {
  // The comparison is between two SERVER stamps: the cluster's updated_at as the opened page rendered it
  // (seenUpdatedAt) and the row's updated_at today. The client clock and the baseline's own time are not read.
  // The cluster grew from 1 zone / 3 sources to 2 zones / 9 sources: today a badge forever.
  const GROWN = { pro_government: 1, opposition: 1 };
  const seenRow = (updated_at: unknown) => ({ id: "a", ...row(GROWN, 9), updated_at: updated_at as string | null | undefined });
  const withSeen = (extra: Partial<BookmarkSnapshot> = {}) => snap({ iktidar: 1 }, 3, { at: SAVED_AT, seenUpdatedAt: SEEN_UPDATED_AT, ...extra });
  const unseen = () => snap({ iktidar: 1 }, 3, { at: SAVED_AT });

  it("sanity: without a seenUpdatedAt the same row carries the badges", () => {
    const { changes, toWrite } = reconcileSnapshots([seenRow("2026-09-29T08:00:00.000Z")], { a: unseen() }, NOW);
    expect(changeBadgeLabels(changes.a!)).toEqual(["Muhalefet medyası da yazmaya başladı", "+6 yeni kaynak"]);
    expect(toWrite).toEqual({});
  });

  it("(b) updated_at not newer than seenUpdatedAt: no change, an 'open' baseline without seenUpdatedAt", () => {
    const r = seenRow("2026-09-29T08:00:00.000Z");
    const { changes, toWrite } = reconcileSnapshots([r], { a: withSeen() }, NOW);
    expect(changes).toEqual({});
    expect(toWrite.a).toEqual(makeSnapshot(r, "open", NOW));
    expect(toWrite.a).toEqual(snap({ iktidar: 1, muhalefet: 1 }, 9, { basis: "open" }));
    expect("seenUpdatedAt" in toWrite.a!).toBe(false);
  });

  it("(b) equal stamps rebaseline with basis 'open' and no seenUpdatedAt on the new snapshot", () => {
    const r = seenRow(SEEN_UPDATED_AT);
    const { changes, toWrite } = reconcileSnapshots([r], { a: withSeen() }, NOW);
    expect(changes).toEqual({});
    expect(toWrite.a).toEqual(makeSnapshot(r, "open", NOW));
    expect(toWrite.a?.basis).toBe("open");
    expect("seenUpdatedAt" in toWrite.a!).toBe(false);
  });

  it("(a) compares instants, not strings: Postgres microseconds and offsets", () => {
    for (const ts of ["2026-09-29T08:59:59.999999+00:00", "2026-09-29T11:30:00+03:00", "2026-09-29 08:30:00+00"]) {
      expect(reconcileSnapshots([seenRow(ts)], { a: withSeen() }, NOW).changes, ts).toEqual({});
    }
    for (const ts of ["2026-09-29T09:00:01.000000+00:00", "2026-09-29T12:30:00+03:00", "2026-09-29 09:30:00+00"]) {
      expect(reconcileSnapshots([seenRow(ts)], { a: withSeen() }, NOW).changes.a, ts).toBeDefined();
    }
  });

  it("clears a zone-only change as well as a source change", () => {
    const zoneOnly = { id: "a", ...row(GROWN, 3), updated_at: "2026-09-29T08:00:00.000Z" };
    expect(reconcileSnapshots([zoneOnly], { a: unseen() }, NOW).changes.a?.newZones).toEqual(["muhalefet"]);
    const out = reconcileSnapshots([zoneOnly], { a: withSeen() }, NOW);
    expect(out.changes).toEqual({});
    expect(out.toWrite.a).toEqual(snap({ iktidar: 1, muhalefet: 1 }, 3, { basis: "open" }));
  });

  it("(a) a stale copy keeps the badge and writes nothing: seenUpdatedAt T0 < row.updated_at T1, whatever the clock says", () => {
    // The reader opened a copy the service worker served from its cache: its updated_at (T0) is older than
    // the cluster's (T1). The old client-clock stamp would have been later than T1 and cleared the badge.
    const r = seenRow(SEEN_UPDATED_AT); // T1
    const stale = withSeen({ seenUpdatedAt: UPD_0 }); // T0 < T1
    const today = reconcileSnapshots([r], { a: unseen() }, NOW);
    expect(today.changes.a).toBeDefined();
    for (const clock of [NOW, "2026-09-30T00:00:00.000Z", FAR_FUTURE]) {
      const kept = reconcileSnapshots([r], { a: stale }, clock);
      expect(kept.changes, clock).toEqual(today.changes);
      expect(kept.changes.a?.basis, clock).toBe("save");
      expect(kept.toWrite, clock).toEqual({});
    }
  });

  it("(a) an updated_at later than seenUpdatedAt keeps the badge exactly as today, with no rebaseline", () => {
    const r = seenRow("2026-09-29T09:30:00.000Z");
    const kept = reconcileSnapshots([r], { a: withSeen() }, NOW);
    const today = reconcileSnapshots([r], { a: unseen() }, NOW);
    expect(kept.changes).toEqual(today.changes);
    expect(kept.changes.a?.basis).toBe("save");
    expect(kept.toWrite).toEqual({});
  });

  it("(c) the reconcile clock does not decide: a rebaseline needs the stamps, not 'now'", () => {
    const r = seenRow("2026-09-29T08:00:00.000Z");
    // opened-and-quiet at any clock, even one before the baseline: the stamps say nothing moved
    for (const clock of [NOW, "2026-01-01T00:00:00.000Z", FAR_FUTURE]) {
      const out = reconcileSnapshots([r], { a: withSeen() }, clock);
      expect(out.changes, clock).toEqual({});
      expect(out.toWrite.a, clock).toEqual(makeSnapshot(r, "open", clock));
    }
  });

  it("(c) an updated_at that is missing, null or unparseable behaves as today (conservative)", () => {
    const today = reconcileSnapshots([seenRow(undefined)], { a: unseen() }, NOW);
    expect(today.changes.a).toBeDefined();
    for (const bad of [undefined, null, "", "garbage", "2026-13-45", 1790672399123, {}, [], true, "9".repeat(5000)]) {
      const out = reconcileSnapshots([seenRow(bad)], { a: withSeen() }, NOW);
      expect(out.changes, String(bad).slice(0, 12)).toEqual(today.changes);
      expect(out.toWrite, String(bad).slice(0, 12)).toEqual({});
    }
    // a row that has no updated_at key at all (v1 fallback shape)
    const bare = reconcileSnapshots([{ id: "a", ...row(GROWN, 9) }], { a: withSeen() }, NOW);
    expect(bare.changes).toEqual(today.changes);
    expect(bare.toWrite).toEqual({});
  });

  it("(d) a garbage seenUpdatedAt behaves as today", () => {
    const r = seenRow("2026-09-01T00:00:00.000Z");
    const today = reconcileSnapshots([r], { a: unseen() }, NOW);
    expect(today.changes.a).toBeDefined();
    const cases: Array<Partial<BookmarkSnapshot>> = [
      { seenUpdatedAt: "garbage" },
      { seenUpdatedAt: "" },
      { seenUpdatedAt: 1790672399123 as unknown as string },
      { seenUpdatedAt: "x".repeat(5000) },
    ];
    for (const extra of cases) {
      const out = reconcileSnapshots([r], { a: withSeen(extra) }, NOW);
      expect(out.changes, JSON.stringify(extra).slice(0, 30)).toEqual(today.changes);
      expect(out.toWrite, JSON.stringify(extra).slice(0, 30)).toEqual({});
    }
  });

  it("the baseline's own time is not compared with the stamp: an older seenUpdatedAt that still covers updated_at rebaselines", () => {
    // Saved on 20 Sep, but the page the reader opened rendered a cluster last touched on 10 Sep, which is
    // also the row's updated_at: nothing has moved, whatever the two clocks say.
    const r = seenRow("2026-09-10T00:00:00.000Z");
    for (const extra of [
      { seenUpdatedAt: "2026-09-10T00:00:00.000Z" }, // before SAVED_AT
      { seenUpdatedAt: "2026-09-10T00:00:00.000Z", at: "garbage" }, // an unusable baseline time orders nothing
      { seenUpdatedAt: "2026-09-10T00:00:00.000Z", at: "" },
    ] as Array<Partial<BookmarkSnapshot>>) {
      const out = reconcileSnapshots([r], { a: withSeen(extra) }, NOW);
      expect(out.changes, JSON.stringify(extra)).toEqual({});
      expect(out.toWrite.a, JSON.stringify(extra)).toEqual(makeSnapshot(r, "open", NOW));
    }
  });

  it("(e) idempotent: applying toWrite and reconciling again gives no change and no write", () => {
    const r = seenRow("2026-09-29T08:00:00.000Z");
    const first = reconcileSnapshots([r], { a: withSeen() }, NOW);
    const second = reconcileSnapshots([r], { a: first.toWrite.a! }, "2026-09-29T10:05:00.000Z");
    expect(second.changes).toEqual({});
    expect(second.toWrite).toEqual({});
    // through storage, as /saved does it
    const s = memStorage();
    writeSnapshots({ a: withSeen() }, s);
    const one = reconcileSnapshots([r], readSnapshots(s), NOW);
    writeSnapshots({ ...readSnapshots(s), ...one.toWrite }, s);
    const two = reconcileSnapshots([r], readSnapshots(s), NOW);
    expect(two.changes).toEqual({});
    expect(two.toWrite).toEqual({});
  });

  it("after the rebaseline a later growth of 2 shows the badge, worded for an 'open' baseline", () => {
    const r = seenRow("2026-09-29T08:00:00.000Z");
    const baseline = reconcileSnapshots([r], { a: withSeen() }, NOW).toWrite.a!;
    const later = reconcileSnapshots([{ id: "a", ...row(GROWN, 11), updated_at: "2026-09-30T00:00:00.000Z" }], { a: baseline }, "2026-09-30T08:00:00.000Z");
    expect(changeBadgeLabels(later.changes.a!)).toEqual(["+2 yeni kaynak"]);
    expect(later.changes.a?.basis).toBe("open");
    expect(later.toWrite).toEqual({});
  });

  it("an opened baseline that is opened again is rebaselined again only when nothing moved since", () => {
    const baseline = snap({ iktidar: 1, muhalefet: 1 }, 9, { basis: "open", at: NOW });
    const reopened = { ...baseline, seenUpdatedAt: "2026-09-29T12:00:00.000Z" };
    const moved = { id: "a", ...row(GROWN, 12), updated_at: "2026-09-29T11:00:00.000Z" };
    const out = reconcileSnapshots([moved], { a: reopened }, "2026-09-29T13:00:00.000Z");
    expect(out.changes).toEqual({});
    expect(out.toWrite.a).toEqual(snap({ iktidar: 1, muhalefet: 1 }, 12, { basis: "open", at: "2026-09-29T13:00:00.000Z" }));
    const newer = { ...moved, updated_at: "2026-09-29T12:30:00.000Z" };
    expect(reconcileSnapshots([newer], { a: reopened }, "2026-09-29T13:00:00.000Z").changes.a?.newSources).toBe(3);
  });

  it("(f) the effective-count lowering and the first-view cases are unchanged", () => {
    // a legacy raw-count baseline that was also opened: the rebaseline stores the effective count, no badge
    const legacy = withSeen({ sources: 6 });
    const r = { id: "a", ...effRow({ pro_government: 1 }, 6, 3), updated_at: "2026-09-29T08:00:00.000Z" };
    const out = reconcileSnapshots([r], { a: legacy }, NOW);
    expect(out.changes).toEqual({});
    expect(out.toWrite.a).toEqual(snap({ iktidar: 1 }, 3, { basis: "open" }));
    // a moving story keeps its seenUpdatedAt through the silent lowering (nothing is rebaselined)
    const moving = { ...r, updated_at: "2026-09-29T09:30:00.000Z" };
    const lowered = reconcileSnapshots([moving], { a: legacy }, NOW);
    expect(lowered.changes).toEqual({});
    expect(lowered.toWrite.a).toEqual({ ...legacy, sources: 3 });
    // no snapshot at all: a first-view baseline, as before
    const first = reconcileSnapshots([seenRow("2026-09-29T08:00:00.000Z")], {}, NOW);
    expect(first.changes).toEqual({});
    expect(first.toWrite.a).toEqual(snap({ iktidar: 1, muhalefet: 1 }, 9, { basis: "first-view" }));
  });

  it("only the opened-and-quiet rows are rebaselined; the rest of the list is untouched", () => {
    const rows = [
      { id: "quiet", ...row(GROWN, 9), updated_at: "2026-09-29T08:00:00.000Z" },
      { id: "moving", ...row(GROWN, 9), updated_at: "2026-09-29T09:30:00.000Z" },
      { id: "unopened", ...row(GROWN, 9), updated_at: "2026-09-29T08:00:00.000Z" },
    ];
    const { changes, toWrite } = reconcileSnapshots(rows, { quiet: withSeen(), moving: withSeen(), unopened: unseen() }, NOW);
    expect(Object.keys(changes).sort()).toEqual(["moving", "unopened"]);
    expect(Object.keys(toWrite)).toEqual(["quiet"]);
  });

  it("never throws on a garbage row or snapshot", () => {
    expect(() =>
      reconcileSnapshots([{ id: "a", bias_distribution: null, article_count: NaN, updated_at: {} as unknown as string }], { a: withSeen() }, NOW),
    ).not.toThrow();
  });
});

describe("changeTitleFor", () => {
  it("names what each baseline was taken at", () => {
    expect(changeTitleFor("save")).toBe("Kaydettiğinizden beri");
    expect(changeTitleFor("first-view")).toBe("Bu listeyi ilk açtığınızdan beri");
    expect(changeTitleFor("open")).toBe("Bu hikâyeyi son açtığınızdan beri");
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

  it("bookmark-snapshots.ts makes no network call of its own and names no storage key besides its two", () => {
    const src = readFileSync(join(dir, "bookmark-snapshots.ts"), "utf8");
    expect(src).not.toMatch(/\bfetch\s*\(/);
    expect(src).not.toMatch(/sendBeacon|XMLHttpRequest|WebSocket/);
    // "tayf:bookmark-snapshots:v1" and "tayf:bookmarks": the footer promise (bookmarks stay in the browser) needs no third key
    expect(src.split('"tayf:').length - 1).toBe(2);
  });

  it("bookmark-snapshots.ts imports it only dynamically", () => {
    const src = readFileSync(join(dir, "bookmark-snapshots.ts"), "utf8");
    expect(src).not.toMatch(staticImport);
    expect(src).toContain(`await import("@/lib/supabase/browser")`);
  });
});
