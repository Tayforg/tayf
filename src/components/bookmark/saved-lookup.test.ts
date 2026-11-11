import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { savedRemovalAnnouncement } from "./bookmark-label";
import {
  SNAPSHOT_KEY,
  SNAPSHOT_MAX_ENTRIES,
  captureSnapshot,
  readSnapshots,
  reconcileSnapshots,
  writeSnapshots,
  type StorageLike,
} from "./bookmark-snapshots";
import {
  SAVED_MAX_CALLS,
  SAVED_MAX_IDS,
  SAVED_PARTIAL_TEXT,
  SAVED_RPC_MAX_IDS,
  SavedTruncationNote,
  UUID_RE,
  fetchOlderSavedChunks,
  mergeSavedRows,
  nextSavedAnnouncement,
  rowsForSnapshots,
  savedLookupPlan,
  savedLookupStatus,
  type SavedRpcClient,
  type SavedRpcName,
} from "./saved-lookup";

// h135 / h134-reader-2: /saved sent only the newest 200 bookmarks to saved_clusters_v4 (the RPC's own cap), so a
// reader with more bookmarks lost the older ones from the page with no notice. savedLookupPlan splits the saved
// ids into chunks of at most 200 (newest chunk first, at most 5 chunks), mergeSavedRows puts the answers back in
// the page's order, and fetchOlderSavedChunks runs chunks 1..4 one after another.

/** The n-th well-formed id. The stored bookmark array runs oldest first, so a smaller n is an older bookmark. */
function uid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function uids(count: number, from = 0): string[] {
  return Array.from({ length: count }, (_, i) => uid(from + i));
}

/** What saved-list.tsx sent before h135, written out (NOT via the new code): valid ids, newest 200. */
function oldClientIds(idList: readonly unknown[]): string[] {
  return idList.filter((id): id is string => typeof id === "string" && UUID_RE.test(id)).slice(-200);
}

describe("constants", () => {
  it("sends at most 200 ids per call (migration 192's cap) and looks at most 1000 ids deep: 5 calls", () => {
    expect(SAVED_RPC_MAX_IDS).toBe(200);
    expect(SAVED_MAX_IDS).toBe(1000);
    expect(SAVED_MAX_CALLS).toBe(5);
    expect(SAVED_MAX_CALLS * SAVED_RPC_MAX_IDS).toBe(SAVED_MAX_IDS);
  });
});

describe("UUID_RE (the one regex both files use)", () => {
  it("accepts a well-formed id in either case and nothing else", () => {
    expect(UUID_RE.test(uid(7))).toBe(true);
    expect(UUID_RE.test(uid(7).toUpperCase())).toBe(true);
    for (const bad of ["", "abc", `${uid(7)} `, ` ${uid(7)}`, uid(7).slice(1), `${uid(7)}0`, "g".repeat(36), `${uid(7)}\n`]) {
      expect(UUID_RE.test(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("savedLookupPlan", () => {
  it("an empty list gives no chunks", () => {
    expect(savedLookupPlan([])).toEqual({ chunks: [], total: 0, requested: 0 });
  });

  it("150 valid ids give one chunk equal to today's filter(UUID).slice(-200)", () => {
    const ids = uids(150);
    const plan = savedLookupPlan(ids);
    expect(plan.chunks).toEqual([oldClientIds(ids)]);
    expect(plan.chunks[0]).toEqual(ids);
    expect(plan.total).toBe(150);
    expect(plan.requested).toBe(150);
  });

  it("200 valid ids give one chunk of 200", () => {
    const plan = savedLookupPlan(uids(200));
    expect(plan.chunks).toHaveLength(1);
    expect(plan.chunks[0]).toHaveLength(200);
    expect(plan).toMatchObject({ total: 200, requested: 200 });
  });

  it("201 valid ids, oldest first: chunk 0 is ids[1..200] (the set sent today), chunk 1 is [ids[0]]", () => {
    const ids = uids(201);
    const plan = savedLookupPlan(ids);
    expect(plan.chunks).toHaveLength(2);
    expect(plan.chunks[0]).toEqual(ids.slice(1, 201));
    expect(plan.chunks[0]).toEqual(oldClientIds(ids));
    expect(plan.chunks[1]).toEqual([ids[0]]);
    expect(plan.total).toBe(201);
    expect(plan.requested).toBe(201);
  });

  it("1001 valid ids give 5 chunks of 200: requested 1000, total 1001, and the oldest id is in no chunk", () => {
    const ids = uids(1001);
    const plan = savedLookupPlan(ids);
    expect(plan.chunks).toHaveLength(5);
    for (const chunk of plan.chunks) expect(chunk).toHaveLength(200);
    expect(plan.requested).toBe(1000);
    expect(plan.total).toBe(1001);
    expect(plan.chunks.flat()).not.toContain(ids[0]);
    // newest chunk first; inside a chunk the stored (oldest first) order is kept
    expect(plan.chunks[0]).toEqual(ids.slice(801, 1001));
    expect(plan.chunks[4]).toEqual(ids.slice(1, 201));
  });

  it("skips non-string and non-UUID entries and does not count them in total", () => {
    const good = uids(3);
    const mixed: unknown[] = [
      null, good[0], undefined, 7, good[1], {}, [], true, "", "not-a-uuid", `${uid(9)}x`, " ", good[2], Symbol.for("x"),
    ];
    const plan = savedLookupPlan(mixed);
    expect(plan.chunks).toEqual([good]);
    expect(plan.total).toBe(3);
    expect(plan.requested).toBe(3);
  });

  it("an all-junk list is the empty plan (the page short-circuits it without loading the client)", () => {
    expect(savedLookupPlan([null, "x", 1, {}])).toEqual({ chunks: [], total: 0, requested: 0 });
  });

  it("junk past the 1000 window does not eat window slots: only valid ids are counted", () => {
    const ids = uids(1001);
    const noisy: unknown[] = [];
    for (const id of ids) noisy.push("junk", id, 42);
    const plan = savedLookupPlan(noisy);
    expect(plan.total).toBe(1001);
    expect(plan.requested).toBe(1000);
    expect([...plan.chunks.flat()].sort()).toEqual([...ids.slice(1)].sort());
  });

  it("does not mutate its input", () => {
    const ids = uids(450);
    const copy = [...ids];
    savedLookupPlan(ids);
    expect(ids).toEqual(copy);
  });

  for (const n of [0, 1, 2, 199, 200, 201, 399, 400, 401, 599, 600, 601, 999, 1000, 1001, 1200, 2500, 20000]) {
    it(`invariants for ${n} valid ids: chunks <= 200, disjoint, at most 5, union is the newest min(total, 1000)`, () => {
      const ids = uids(n);
      const plan = savedLookupPlan(ids);
      const window = Math.min(n, SAVED_MAX_IDS);
      expect(plan.total).toBe(n);
      expect(plan.requested).toBe(window);
      expect(plan.chunks).toHaveLength(Math.ceil(window / SAVED_RPC_MAX_IDS));
      expect(plan.chunks.length).toBeLessThanOrEqual(SAVED_MAX_CALLS);
      for (const chunk of plan.chunks) {
        expect(chunk.length).toBeGreaterThan(0);
        expect(chunk.length).toBeLessThanOrEqual(SAVED_RPC_MAX_IDS);
      }
      const flat = plan.chunks.flat();
      expect(new Set(flat).size).toBe(flat.length);
      const newest = window === 0 ? [] : ids.slice(-window);
      expect([...flat].sort()).toEqual([...newest].sort());
      // chunk 0 is always today's slice, so the reader's first call is the one the page always made
      expect(plan.chunks[0] ?? []).toEqual(oldClientIds(ids));
    });
  }
});

describe("readers with 200 bookmarks or fewer: exactly one call with today's arguments", () => {
  for (const n of [1, 50, 199, 200]) {
    it(`${n} saved ids: one chunk, the same p_ids as the old client`, () => {
      const idList = ["junk", ...uids(n), null];
      const plan = savedLookupPlan(idList);
      expect(plan.chunks).toHaveLength(1);
      expect(plan.chunks[0]).toEqual(oldClientIds(idList));
      expect(plan.chunks.slice(1)).toEqual([]);
    });
  }
});

describe("mergeSavedRows", () => {
  const row = (id: string, updated_at: string, extra: Record<string, unknown> = {}) => ({ id, updated_at, ...extra });

  it("returns [] for [] and for [[]]", () => {
    expect(mergeSavedRows([])).toEqual([]);
    expect(mergeSavedRows([[]])).toEqual([]);
    expect(mergeSavedRows([[], []])).toEqual([]);
  });

  it("orders by updated_at descending across chunks (string compare of the ISO values)", () => {
    const out = mergeSavedRows([
      [row("a", "2026-11-11T10:00:00+00:00"), row("b", "2026-11-09T10:00:00+00:00")],
      [row("c", "2026-11-10T10:00:00+00:00"), row("d", "2026-11-12T10:00:00+00:00")],
    ]);
    expect(out.map((r) => r.id)).toEqual(["d", "a", "c", "b"]);
  });

  it("orders ISO values that differ in the length of the fraction the way the clock does", () => {
    // PostgREST trims trailing zeros of the fraction: ".5" is later than "" (whole second), ".123" later than ".12".
    const out = mergeSavedRows([
      [row("whole", "2026-11-11T09:22:03+00:00")],
      [row("frac2", "2026-11-11T09:22:03.12+00:00")],
      [row("frac3", "2026-11-11T09:22:03.123+00:00")],
      [row("half", "2026-11-11T09:22:03.5+00:00")],
    ]);
    expect(out.map((r) => r.id)).toEqual(["half", "frac3", "frac2", "whole"]);
  });

  it("dedupes by id and the first occurrence wins", () => {
    const first = row("x", "2026-11-11T10:00:00+00:00", { title: "first" });
    const second = row("x", "2026-11-12T10:00:00+00:00", { title: "second" });
    const out = mergeSavedRows([[first], [second, row("y", "2026-11-01T00:00:00+00:00")]]);
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.id === "x")).toBe(first);
  });

  it("is stable on ties: earlier chunk first, then earlier index", () => {
    const at = "2026-11-11T10:00:00+00:00";
    const out = mergeSavedRows([
      [row("a1", at), row("a2", at)],
      [row("b1", at), row("b2", at)],
      [row("c1", at)],
    ]);
    expect(out.map((r) => r.id)).toEqual(["a1", "a2", "b1", "b2", "c1"]);
  });

  it("keeps every other column of the row untouched and does not mutate its input", () => {
    const input = [[row("a", "2026-11-11T10:00:00+00:00", { title_tr: "T", n: 3 })], [row("b", "2026-11-12T10:00:00+00:00")]];
    const snapshot = JSON.stringify(input);
    const out = mergeSavedRows(input);
    expect(out[1]).toEqual({ id: "a", updated_at: "2026-11-11T10:00:00+00:00", title_tr: "T", n: 3 });
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("a single chunk the RPC already ordered comes back in the same order", () => {
    const rows = [row("a", "2026-11-11T12:00:00+00:00"), row("b", "2026-11-11T11:00:00+00:00"), row("c", "2026-11-11T10:00:00+00:00")];
    expect(mergeSavedRows([rows])).toEqual(rows);
  });

  it("copes with 5 chunks of 200 rows", () => {
    const chunks = [0, 1, 2, 3, 4].map((c) =>
      Array.from({ length: 200 }, (_, i) => row(uid(c * 200 + i), `2026-11-11T${String(c).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00+00:00`)),
    );
    const out = mergeSavedRows(chunks);
    expect(out).toHaveLength(1000);
    const stamps = out.map((r) => r.updated_at);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });
});

describe("SavedTruncationNote", () => {
  it("renders nothing when everything is shown (total <= shown)", () => {
    expect(renderToStaticMarkup(createElement(SavedTruncationNote, { shown: 1000, total: 1000 }))).toBe("");
    expect(renderToStaticMarkup(createElement(SavedTruncationNote, { shown: 200, total: 150 }))).toBe("");
    expect(renderToStaticMarkup(createElement(SavedTruncationNote, { shown: 0, total: 0 }))).toBe("");
    expect(renderToStaticMarkup(createElement(SavedTruncationNote, { shown: Number.NaN, total: 5 }))).toBe("");
  });

  it("renders exactly the Turkish note for shown 1000 and total 1001", () => {
    const markup = renderToStaticMarkup(createElement(SavedTruncationNote, { shown: 1000, total: 1001 }));
    expect(markup).toBe(
      '<p class="mb-3 text-xs text-muted-foreground">En yeni 1.000 kayıt gösteriliyor; toplam 1.001 kayıt var.</p>',
    );
    expect(markup).toContain("En yeni 1.000 kayıt gösteriliyor; toplam 1.001 kayıt var.");
  });

  it("groups thousands with a dot, at any size", () => {
    const text = (shown: number, total: number) =>
      renderToStaticMarkup(createElement(SavedTruncationNote, { shown, total })).replace(/<[^>]*>/g, "");
    expect(text(1000, 12345)).toBe("En yeni 1.000 kayıt gösteriliyor; toplam 12.345 kayıt var.");
    expect(text(200, 201)).toBe("En yeni 200 kayıt gösteriliyor; toplam 201 kayıt var.");
  });
});

describe("savedLookupStatus(attempted, failed, rows)", () => {
  it("is ok when no chunk failed, partial when some did and rows arrived, failed when all did", () => {
    expect(savedLookupStatus(1, 0, 40)).toBe("ok");
    expect(savedLookupStatus(5, 0, 900)).toBe("ok");
    expect(savedLookupStatus(5, 1, 800)).toBe("partial");
    expect(savedLookupStatus(5, 4, 12)).toBe("partial");
    expect(savedLookupStatus(5, 5, 0)).toBe("failed");
    // one chunk (a reader with 200 bookmarks or fewer): a failure is a failure, as before
    expect(savedLookupStatus(1, 1, 0)).toBe("failed");
  });

  it("no failed chunk is ok even with no rows: stale bookmarks still show the empty state, as before", () => {
    expect(savedLookupStatus(1, 0, 0)).toBe("ok");
    expect(savedLookupStatus(3, 0, 0)).toBe("ok");
  });

  it("a failed chunk while the others brought no row is a failure, never the 'no saved stories' empty state", () => {
    expect(savedLookupStatus(2, 1, 0)).toBe("failed");
    expect(savedLookupStatus(5, 3, 0)).toBe("failed");
  });

  it("never reports success for an oversized failure count", () => {
    expect(savedLookupStatus(0, 0, 0)).toBe("ok");
    expect(savedLookupStatus(2, 3, 10)).toBe("failed");
  });
});

describe("SAVED_PARTIAL_TEXT", () => {
  it("is Turkish, short, and ends like the page's existing failure copy", () => {
    expect(SAVED_PARTIAL_TEXT).toBe("Kaydedilenlerin bir kısmı yüklenemedi. Lütfen sayfayı yenileyin.");
    expect(SAVED_PARTIAL_TEXT.endsWith("Lütfen sayfayı yenileyin.")).toBe(true);
  });
});

describe("nextSavedAnnouncement(prev, partial)", () => {
  it("a partial lookup announces the partial-failure copy", () => {
    expect(nextSavedAnnouncement("", true)).toBe(SAVED_PARTIAL_TEXT);
  });

  it("a partial lookup that already announced it returns the same string (React bails out, nothing is re-announced)", () => {
    expect(nextSavedAnnouncement(SAVED_PARTIAL_TEXT, true)).toBe(SAVED_PARTIAL_TEXT);
  });

  it("a complete lookup clears the stale partial-failure copy (the note is gone, so the live region must not still say it)", () => {
    expect(nextSavedAnnouncement(SAVED_PARTIAL_TEXT, false)).toBe("");
  });

  it("a complete lookup leaves any other announcement alone, e.g. a removal sentence", () => {
    const removal = savedRemovalAnnouncement("Bir başlık", 3);
    expect(removal).not.toBe("");
    expect(nextSavedAnnouncement(removal, false)).toBe(removal);
    expect(nextSavedAnnouncement("", false)).toBe("");
  });

  it("a partial lookup replaces a removal sentence with the partial-failure copy", () => {
    expect(nextSavedAnnouncement(savedRemovalAnnouncement("Bir başlık", 3), true)).toBe(SAVED_PARTIAL_TEXT);
  });
});

// h135 review fix: the change badges (device-local snapshots) must keep seeing exactly the rows they saw before
// h135, the newest 200. The merged list can now hold 1000 rows; reconciling all of them gives every row without a
// snapshot a 'first-view' snapshot stamped now, and writeSnapshots (SNAPSHOT_MAX_ENTRIES = 500, newest `at` wins)
// then evicts the older 'save' baselines, including those of the newest 200, and the eviction rotates every visit.
describe("rowsForSnapshots (the rows the change badges look at)", () => {
  const row = (id: string, n = 0) => ({ id, updated_at: `2026-11-11T10:00:${String(n % 60).padStart(2, "0")}+00:00` });

  it("keeps only the chunk-0 ids (the newest 200), in the input order", () => {
    const ids = uids(450);
    const plan = savedLookupPlan(ids);
    // the page's order is updated_at desc, not bookmark order: feed the rows in a scrambled order
    const rows = [...ids].reverse().map((id, i) => row(id, i)).sort((a, b) => (a.id < b.id ? 1 : -1));
    const out = rowsForSnapshots(rows, plan);
    expect(out).toHaveLength(200);
    expect(new Set(out.map((r) => r.id))).toEqual(new Set(plan.chunks[0]));
    expect(out).toEqual(rows.filter((r) => new Set(plan.chunks[0]).has(r.id)));
    // the rows are the same objects, not copies
    for (const r of out) expect(rows).toContain(r);
  });

  it("drops the rows of the older chunks and rows that are in no chunk", () => {
    const ids = uids(1001);
    const plan = savedLookupPlan(ids);
    const rows = ids.map((id, i) => row(id, i));
    const out = rowsForSnapshots(rows, plan);
    expect(out.map((r) => r.id)).toEqual(ids.slice(801, 1001));
    expect(out.map((r) => r.id)).not.toContain(ids[0]);
    expect(rowsForSnapshots([row(uid(99999))], plan)).toEqual([]);
  });

  it("returns [] for an empty plan", () => {
    const rows = uids(5).map((id, i) => row(id, i));
    expect(rowsForSnapshots(rows, savedLookupPlan([]))).toEqual([]);
    expect(rowsForSnapshots([], savedLookupPlan([]))).toEqual([]);
    expect(rowsForSnapshots([], savedLookupPlan(uids(3)))).toEqual([]);
  });

  for (const n of [1, 50, 199, 200]) {
    it(`keeps every row for a reader with ${n} bookmarks (one chunk: exactly what the page always reconciled)`, () => {
      const ids = uids(n);
      const rows = ids.map((id, i) => row(id, i));
      expect(rowsForSnapshots(rows, savedLookupPlan(ids))).toEqual(rows);
    });
  }

  it("does not mutate its input", () => {
    const ids = uids(300);
    const plan = savedLookupPlan(ids);
    const rows = ids.map((id, i) => row(id, i));
    const copy = JSON.stringify(rows);
    const planCopy = JSON.stringify(plan);
    rowsForSnapshots(rows, plan);
    expect(JSON.stringify(rows)).toBe(copy);
    expect(JSON.stringify(plan)).toBe(planCopy);
  });

  it("the RPC window of one call stays well inside the snapshot cap (2.5x headroom), so chunk 0 can never evict itself", () => {
    expect(SAVED_RPC_MAX_IDS).toBeLessThan(SNAPSHOT_MAX_ENTRIES);
    expect(SAVED_RPC_MAX_IDS * 2).toBeLessThan(SNAPSHOT_MAX_ENTRIES);
  });
});

describe("snapshot baselines across repeated /saved visits (1000 bookmarks)", () => {
  /** In-memory localStorage stand-in. */
  function memoryStorage(initial?: string | null): StorageLike & { raw: () => string | null } {
    let value: string | null = initial ?? null;
    return {
      getItem: (k) => (k === SNAPSHOT_KEY ? value : null),
      setItem: (k, v) => {
        if (k === SNAPSHOT_KEY) value = v;
      },
      raw: () => value,
    };
  }

  const ids = uids(1000);
  const plan = savedLookupPlan(ids);
  const newest200 = ids.slice(-200);
  const v4 = (id: string, n: number) => ({
    id,
    updated_at: `2026-11-11T10:00:00.${String(n).padStart(3, "0")}+00:00`,
    bias_distribution: { pro_government: 1, opposition: 1 } as unknown,
    article_count: 2,
    effective_article_count: 2,
  });
  // the page's rows: every bookmark answered, newest update first
  const rows = ids.map((id, n) => v4(id, n)).reverse();
  const captureAt = (i: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, i)).toISOString();
  const visitAt = (v: number) => new Date(Date.UTC(2026, 10, 1, 0, 0, v)).toISOString();

  /** The reader saved all 1000 stories one after another: a 'save' baseline each, oldest first. */
  async function savedAll(): Promise<string> {
    const storage = memoryStorage();
    for (let i = 0; i < ids.length; i += 1) {
      await captureSnapshot(ids[i] as string, {
        storage,
        fetchRow: async () => v4(ids[i] as string, i),
        isStillSaved: () => true,
        nowIso: captureAt(i),
      });
    }
    return storage.raw() ?? "";
  }

  function visit(storage: StorageLike, toReconcile: typeof rows, v: number) {
    const snaps = readSnapshots(storage);
    const { changes, toWrite } = reconcileSnapshots(toReconcile, snaps, visitAt(v));
    if (Object.keys(toWrite).length > 0) writeSnapshots({ ...snaps, ...toWrite }, storage);
    return changes;
  }

  const basisOfNewest200 = (storage: StorageLike) => {
    const snaps = readSnapshots(storage);
    return newest200.map((id) => snaps[id]?.basis);
  };

  it("the setup is what production does: 1000 captures leave the newest 500 baselines, all 'save'", async () => {
    const raw = await savedAll();
    const snaps = readSnapshots(memoryStorage(raw));
    expect(Object.keys(snaps)).toHaveLength(SNAPSHOT_MAX_ENTRIES);
    expect(Object.values(snaps).every((s) => s.basis === "save")).toBe(true);
    expect(newest200.every((id) => snaps[id]?.basis === "save")).toBe(true);
  });

  it("through rowsForSnapshots, the newest 200 keep their 'save' baseline after every one of 4 visits", async () => {
    const storage = memoryStorage(await savedAll());
    for (let v = 1; v <= 4; v += 1) {
      const changes = visit(storage, rowsForSnapshots(rows, plan), v);
      expect(basisOfNewest200(storage), `visit ${v}`).toEqual(newest200.map(() => "save"));
      // the rows did not change since they were saved: no badge
      expect(Object.keys(changes), `visit ${v}`).toEqual([]);
      expect(Object.keys(readSnapshots(storage)).length, `visit ${v}`).toBeLessThanOrEqual(SNAPSHOT_MAX_ENTRIES);
    }
  });

  it("pins the regression: reconciling every merged row (the unfixed page) drops the 'save' baselines of the newest 200", async () => {
    const storage = memoryStorage(await savedAll());
    visit(storage, rows, 1);
    expect(basisOfNewest200(storage).filter((b) => b === "save").length).toBeLessThan(200);
  });
});

// A recording stand-in for the browser client.
type Answer = { data: unknown[] | null; error: { message: string; code?: string } | null };

function recordingClient(answer: (name: SavedRpcName, pIds: string[], callNo: number) => Promise<Answer> | Answer) {
  const calls: { name: SavedRpcName; p_ids: string[] }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const client: SavedRpcClient = {
    async rpc<T>(name: SavedRpcName, args: { p_ids: string[] }) {
      calls.push({ name, p_ids: args.p_ids });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      try {
        return (await answer(name, args.p_ids, calls.length)) as { data: T | null; error: { message: string; code?: string } | null };
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { client, calls, maxInFlight: () => maxInFlight };
}

describe("fetchOlderSavedChunks", () => {
  afterEach(() => vi.restoreAllMocks());

  const never = () => false;

  it("makes no call for no chunks (so a reader with 200 bookmarks or fewer makes exactly the one chunk-0 call)", async () => {
    const rec = recordingClient(() => ({ data: [], error: null }));
    await expect(fetchOlderSavedChunks(rec.client, "saved_clusters_v4", [], never)).resolves.toEqual({ results: [], failed: 0 });
    expect(rec.calls).toEqual([]);
  });

  it("calls the chunks one after another (never two in flight), in order, with the resolved name and { p_ids: chunk }", async () => {
    const chunks = [uids(3, 0), uids(3, 10), uids(3, 20)];
    const rec = recordingClient(async (_name, pIds, callNo) => {
      // later calls answer FASTER: a parallel implementation would finish out of order
      await new Promise((resolve) => setTimeout(resolve, 20 - callNo * 5));
      return { data: pIds.map((id) => ({ id })), error: null };
    });
    const out = await fetchOlderSavedChunks<{ id: string }>(rec.client, "saved_clusters_v2", chunks, never);
    expect(rec.maxInFlight()).toBe(1);
    expect(rec.calls).toEqual(chunks.map((p_ids) => ({ name: "saved_clusters_v2", p_ids })));
    expect(out?.failed).toBe(0);
    expect(out?.results.map((r) => r.map((x) => x.id))).toEqual(chunks);
  });

  it("never makes more than SAVED_MAX_CALLS - 1 older calls, whatever it is given", async () => {
    const rec = recordingClient(() => ({ data: [], error: null }));
    const chunks = Array.from({ length: 12 }, (_, i) => uids(2, i * 2));
    await fetchOlderSavedChunks(rec.client, "saved_clusters_v4", chunks, never);
    expect(rec.calls).toHaveLength(SAVED_MAX_CALLS - 1);
  });

  it("a failed chunk is counted and logged, and the chunks that succeeded keep their rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = recordingClient((_name, pIds, callNo) =>
      callNo === 2
        ? { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } }
        : { data: pIds.map((id) => ({ id })), error: null },
    );
    const out = await fetchOlderSavedChunks<{ id: string }>(rec.client, "saved_clusters_v4", [uids(2, 0), uids(2, 5), uids(2, 9)], never);
    expect(rec.calls).toHaveLength(3); // the failure does not stop the later chunks
    expect(out?.failed).toBe(1);
    expect(out?.results.map((r) => r.map((x) => x.id))).toEqual([uids(2, 0), uids(2, 9)]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("[saved] title lookup error:", "canceling statement due to statement timeout");
  });

  it("a thrown error is a failed chunk, not a failed page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const rec = recordingClient((_name, pIds, callNo) => {
      if (callNo === 1) throw new Error("socket hang up");
      return { data: pIds.map((id) => ({ id })), error: null };
    });
    const out = await fetchOlderSavedChunks<{ id: string }>(rec.client, "saved_clusters_v4", [uids(1, 0), uids(1, 1)], never);
    expect(out?.failed).toBe(1);
    expect(out?.results).toEqual([[{ id: uid(1) }]]);
    expect(warn).toHaveBeenCalledWith("[saved] title lookup error:", "socket hang up");
  });

  it("a null data answer is an empty chunk, not a failure", async () => {
    const rec = recordingClient(() => ({ data: null, error: null }));
    const out = await fetchOlderSavedChunks(rec.client, "saved_clusters_v4", [uids(2)], never);
    expect(out).toEqual({ results: [[]], failed: 0 });
  });

  it("stops and returns null when the page is cancelled after an answer: no further call is made", async () => {
    let cancelled = false;
    const rec = recordingClient((_name, pIds, callNo) => {
      if (callNo === 1) cancelled = true; // the reader navigates away while chunk 1 is in flight
      return { data: pIds.map((id) => ({ id })), error: null };
    });
    const out = await fetchOlderSavedChunks(rec.client, "saved_clusters_v4", [uids(2, 0), uids(2, 4), uids(2, 8)], () => cancelled);
    expect(out).toBeNull();
    expect(rec.calls).toHaveLength(1);
  });

  it("returns null when it was cancelled before the first answer arrived, and does not log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let cancelled = false;
    const rec = recordingClient(() => {
      cancelled = true;
      return { data: null, error: { message: "boom" } };
    });
    const out = await fetchOlderSavedChunks(rec.client, "saved_clusters_v4", [uids(2)], () => cancelled);
    expect(out).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fixture: old client against new client on the shape production returned.
//
// Read-only replay, 2026-11-11 19:52Z, anon key, GET /rest/v1/rpc/saved_clusters_v4: the 201 newest clusters with
// is_archived = false and article_count >= 2, i.e. a reader who saved all of them (stored oldest first):
//   - p_ids = the newest 200 (what the page sent)         -> HTTP 200, 200 rows, the oldest id missing
//   - p_ids = [the oldest id] alone (chunk 1)             -> HTTP 200, 1 row
//   - p_ids = all 201 in one call                         -> 200 rows, and the one dropped is the NEWEST id (the
//     server keeps p_ids[1:200], the first 200 of the array), which is why the client sends the newest slice
// Every `updated_at` of the answers was descending as a string. Only id and updated_at are kept below (no titles),
// newest first, exactly as the RPC returned them: the old rows (200) followed by chunk 1's row (1).
// ---------------------------------------------------------------------------------------------------------------
const PROD_201: ReadonlyArray<readonly [string, string]> = [
  ["8222ce97-2536-43d5-aadf-6f892642bbb4", "2026-11-11T19:52:03.245977+00:00"],
  ["3711a86e-2ccc-4d70-80f2-d34328cdaa60", "2026-11-11T19:46:01.322229+00:00"],
  ["7e155ce2-b439-466d-954a-2dd362a51bb1", "2026-11-11T19:43:04.093014+00:00"],
  ["915d1e32-790f-425e-a8e8-325271df39dc", "2026-11-11T19:40:04.017592+00:00"],
  ["22e105ab-b88d-4c76-a478-00127a172df3", "2026-11-11T19:37:02.621868+00:00"],
  ["f9d02405-e0fe-4e07-80e0-126994fcfb2f", "2026-11-11T19:37:02.390469+00:00"],
  ["5f55c79d-2586-42d4-adf2-6c54e1af44a2", "2026-11-11T19:34:03.844879+00:00"],
  ["56eaa832-c70f-4825-9007-ec08ffb11c7c", "2026-11-11T19:34:01.704264+00:00"],
  ["bce89e07-ac19-47f6-af5c-b1272935b4b6", "2026-11-11T19:34:01.288967+00:00"],
  ["8eee11ae-2e67-41a5-baa8-80333cb0291a", "2026-11-11T19:31:03.680392+00:00"],
  ["bfc11271-7408-4e7f-b4a0-4091474e9373", "2026-11-11T19:28:01.430611+00:00"],
  ["2ef0b085-0af4-4a12-a142-1264ff36ed92", "2026-11-11T19:25:04.157665+00:00"],
  ["d3b6e1b1-0e34-40f6-b2cb-56231498673e", "2026-11-11T19:25:03.474181+00:00"],
  ["06127ea2-89e4-4042-8ae7-36e80389813e", "2026-11-11T19:22:01.894369+00:00"],
  ["d718d8b1-da86-4628-9210-20049acd4169", "2026-11-11T19:16:06.766632+00:00"],
  ["37f95fda-f5da-4354-844c-b9c74840c93c", "2026-11-11T19:16:04.308333+00:00"],
  ["0654691c-b590-4610-8058-416db65d65cd", "2026-11-11T19:10:02.119658+00:00"],
  ["383e09f8-8610-4818-9b6c-6fd26a3893bd", "2026-11-11T19:10:01.747293+00:00"],
  ["cf696161-be10-432f-8ae4-e92461e2d762", "2026-11-11T19:10:01.418015+00:00"],
  ["4797e4f6-7b7c-4a9f-8aba-c27b59fb26ff", "2026-11-11T19:06:09.617702+00:00"],
  ["2be56a19-ffc3-4208-92fa-ea81bbee2da8", "2026-11-11T18:58:01.898299+00:00"],
  ["1a74e811-b5d7-4c75-88cb-745e0144df84", "2026-11-11T18:58:01.305555+00:00"],
  ["28cb1b17-0c39-44eb-9c17-3bbc42c81d93", "2026-11-11T18:55:03.452664+00:00"],
  ["a5bf5d1e-29b1-4163-bf7b-1dac1308d0bb", "2026-11-11T18:52:02.778356+00:00"],
  ["43095fe7-f79a-453d-95a3-7a11a2c14a93", "2026-11-11T18:46:06.196085+00:00"],
  ["410b4b9d-de68-46e6-8988-b5de5c9ad663", "2026-11-11T18:46:01.999126+00:00"],
  ["06908f36-d8f5-45b9-bc27-42c971cdfcbd", "2026-11-11T18:42:05.342486+00:00"],
  ["af3c375d-d551-48a4-a595-7c2a16b49922", "2026-11-11T18:39:06.444319+00:00"],
  ["90725b39-4bed-489d-a5c7-453823cc0d0c", "2026-11-11T18:37:01.037797+00:00"],
  ["03b65ca9-4be4-4378-8e58-178f1fdadc27", "2026-11-11T18:31:03.146433+00:00"],
  ["a01d0e77-0372-4d1b-9717-bf28250f2889", "2026-11-11T18:31:01.819852+00:00"],
  ["22778a97-0501-4129-93a4-c43467aee767", "2026-11-11T18:31:01.542774+00:00"],
  ["d83c8053-28c8-42ed-ad5c-754a9a2e0429", "2026-11-11T18:31:01.329344+00:00"],
  ["1db8fab8-a660-41e5-b58d-d3e81267ef73", "2026-11-11T18:16:02.548202+00:00"],
  ["b5498f0b-b205-4604-a7c8-e2cbb0d3a0b5", "2026-11-11T18:13:01.992907+00:00"],
  ["139ed35d-f52f-4c07-8d7f-6455afbdba04", "2026-11-11T18:10:11.156807+00:00"],
  ["e569e531-33ab-4011-93df-8e7230e4019f", "2026-11-11T18:07:02.570313+00:00"],
  ["6444d93b-1791-41aa-aba4-cc93e3f83d9c", "2026-11-11T18:03:07.707744+00:00"],
  ["1a23b8de-3454-4738-b80a-cb2336f75587", "2026-11-11T17:58:04.962852+00:00"],
  ["cd5e002f-2407-47f6-9667-aa53ef88aed7", "2026-11-11T17:58:04.2258+00:00"],
  ["c91397d4-8b18-4b13-be66-22e8cccf3f89", "2026-11-11T17:54:10.321121+00:00"],
  ["0925e9ad-0b97-4976-b6e7-75c73215741b", "2026-11-11T17:51:09.438478+00:00"],
  ["905dab59-7dc3-42f0-aabb-a995c1bb220d", "2026-11-11T17:43:04.072637+00:00"],
  ["d1507a40-c13f-49c6-ba39-151399bffe2b", "2026-11-11T17:43:02.607979+00:00"],
  ["492ef327-ecfd-459f-8558-ed9287b082bb", "2026-11-11T17:37:03.12573+00:00"],
  ["dcf0fe63-ae9f-450f-9c8e-c55ee707be3a", "2026-11-11T17:34:01.878039+00:00"],
  ["82a02fa4-38be-4601-a1fd-fea1867348bc", "2026-11-11T17:34:01.51682+00:00"],
  ["36e5390f-61e9-4f77-a5d5-9d9ea73228d5", "2026-11-11T17:22:05.856313+00:00"],
  ["36b71221-7125-40fe-9515-a825eabdb559", "2026-11-11T17:16:04.549974+00:00"],
  ["db5b0969-40f5-4186-b75a-0ef4a8bf6260", "2026-11-11T17:09:07.324866+00:00"],
  ["d986f886-a6c8-4bea-8634-36552c1a6c26", "2026-11-11T17:06:08.900585+00:00"],
  ["0afafad6-d874-478a-b1d2-91d928c9a889", "2026-11-11T17:06:07.95382+00:00"],
  ["1741124d-0704-46c2-98bc-bf055baf3134", "2026-11-11T17:04:02.419829+00:00"],
  ["a36dc670-7c9d-4709-a8f4-4a9c5009a9e3", "2026-11-11T16:58:03.494785+00:00"],
  ["71d84345-b97c-4ef6-baef-bd4da999ba90", "2026-11-11T16:52:02.577238+00:00"],
  ["06e3dab4-d447-4eec-ad27-d997dd5cd5be", "2026-11-11T16:52:01.823028+00:00"],
  ["5c6dfe96-899d-44cf-b5ea-99e59af6de43", "2026-11-11T16:52:01.412686+00:00"],
  ["7c160931-4ded-462e-9e42-055b21b266d0", "2026-11-11T16:46:03.433041+00:00"],
  ["2bf73420-1279-4851-a9bc-5e85b7ca11a7", "2026-11-11T16:31:03.849468+00:00"],
  ["51806ac6-47d0-4970-b55e-c31a5e3de9c3", "2026-11-11T16:27:07.715353+00:00"],
  ["16951161-b166-4d16-a6b0-e2b2c9cede7c", "2026-11-11T16:24:06.364505+00:00"],
  ["2380acd2-8449-4d95-a741-b6aad45a1ca3", "2026-11-11T16:21:11.512626+00:00"],
  ["960b231b-4a9e-40c1-a061-7f8a4c0b556c", "2026-11-11T16:01:04.622425+00:00"],
  ["8464bcbe-a51b-41dd-aee9-d7e99097dec0", "2026-11-11T16:01:03.504854+00:00"],
  ["82dc7ef2-4f36-4845-a1f9-b04222616152", "2026-11-11T15:55:03.278533+00:00"],
  ["2af1f57a-5549-446d-b082-a1793bfe86f4", "2026-11-11T15:52:06.988277+00:00"],
  ["496d6987-1c69-47c2-8c30-3815b8cbc6c8", "2026-11-11T15:43:02.976559+00:00"],
  ["b2e5b074-6207-4aba-84f9-112854aeaff3", "2026-11-11T15:40:16.605796+00:00"],
  ["d0e07c0f-0ce6-498d-857b-58e46a7aae03", "2026-11-11T15:40:16.186206+00:00"],
  ["884857e0-4136-4090-85c8-e98518f223ed", "2026-11-11T15:40:15.860276+00:00"],
  ["d2c9ee1c-265c-4566-bce9-5e05880beb3a", "2026-11-11T15:37:05.96379+00:00"],
  ["45befd7c-6d76-4d4b-9a2e-65c6a4d153f4", "2026-11-11T15:28:02.328135+00:00"],
  ["3052c70f-f64d-439c-87cf-29fb4e80e51c", "2026-11-11T15:25:04.41925+00:00"],
  ["5203d393-bd69-4eef-801f-429c1825a505", "2026-11-11T15:22:01.076208+00:00"],
  ["d8230df4-df4d-4d6b-aa54-c10f5c159fcc", "2026-11-11T15:19:02.389975+00:00"],
  ["ab85637b-bc1e-4ea1-aaa2-0200e2facf1d", "2026-11-11T15:13:03.698607+00:00"],
  ["7059794c-fd0b-4ec8-a740-98ae4b46c3d9", "2026-11-11T15:13:03.412849+00:00"],
  ["663cf3f4-6360-44f1-b5bc-1ec7487b8499", "2026-11-11T15:03:13.104084+00:00"],
  ["2afd8068-2c5d-44c6-a73d-0c9e3f8af664", "2026-11-11T15:03:11.094734+00:00"],
  ["f9c8d01b-e959-4666-9ff5-aca2c6915ce4", "2026-11-11T15:03:09.523202+00:00"],
  ["506f7767-8483-4a00-bc8e-aa7bbbe4b5a4", "2026-11-11T15:01:04.10323+00:00"],
  ["7a93f068-4e50-4f26-8433-b8efff94e7ff", "2026-11-11T15:01:03.376451+00:00"],
  ["1e6350f0-a703-4a18-92b1-feec6106a3c6", "2026-11-11T14:58:06.349483+00:00"],
  ["e8eeabf2-9310-43ff-946f-dc460b198dc0", "2026-11-11T14:58:05.814046+00:00"],
  ["97448fae-9d04-49fb-921c-7f6fa13f6103", "2026-11-11T14:37:06.730652+00:00"],
  ["959122de-8c12-465d-b342-11ce64eefaa9", "2026-11-11T14:37:06.016124+00:00"],
  ["2fa7c131-1714-49d0-9fbd-2168b2ffef00", "2026-11-11T14:37:03.512523+00:00"],
  ["b72c1728-67fc-4ec4-b51b-8ec9a7214b2f", "2026-11-11T14:31:03.197497+00:00"],
  ["7fbab880-8cba-40e8-908f-b9dfec4d058b", "2026-11-11T14:31:02.801189+00:00"],
  ["7fe96d89-ce1f-402b-9d21-6c11bdad9f7b", "2026-11-11T14:25:06.659498+00:00"],
  ["b41eb5e7-9695-49df-b08b-e37d9748e354", "2026-11-11T14:25:05.38733+00:00"],
  ["25c67b45-4ec6-4027-9ffa-0c9fd98a4041", "2026-11-11T14:22:01.390005+00:00"],
  ["7a31a7ff-7508-473c-a449-a08134ea4161", "2026-11-11T14:19:04.107152+00:00"],
  ["86d4f277-7b93-4b6c-b6ce-1e74b7c7c790", "2026-11-11T14:19:03.025563+00:00"],
  ["fe576b17-8d29-43e3-b5e7-a89deb15c549", "2026-11-11T14:13:10.303755+00:00"],
  ["e1e22720-ec16-4623-88a3-1ec0e4d0f6f2", "2026-11-11T14:13:08.459068+00:00"],
  ["80315bc1-24bb-4891-84eb-02fe94880c65", "2026-11-11T14:13:06.426169+00:00"],
  ["175538bf-aa42-4382-b9e7-2808fec2555c", "2026-11-11T14:13:03.577763+00:00"],
  ["d39f1764-c83f-4a3a-b18b-9eecdeebb80a", "2026-11-11T14:13:03.099253+00:00"],
  ["bffb0a3f-a552-45d6-a2fd-a2f69050c73b", "2026-11-11T14:09:06.628063+00:00"],
  ["f5ea1c1b-f8b9-4ccd-a20e-0294053b1705", "2026-11-11T14:09:06.273135+00:00"],
  ["7b4b0e7d-19ff-470d-9409-ff9c6fd59c15", "2026-11-11T14:04:04.933211+00:00"],
  ["6808e522-f21b-4a9b-a793-d13f16c32d8e", "2026-11-11T14:04:04.146084+00:00"],
  ["07c6d420-e50a-43ca-9fd5-fc220a15fa76", "2026-11-11T14:04:02.553889+00:00"],
  ["fae1286d-cf72-4e8b-95d9-765c84d03c01", "2026-11-11T14:01:03.998852+00:00"],
  ["b0338ada-d972-47ec-a3e6-e28897c499a2", "2026-11-11T13:58:04.717197+00:00"],
  ["ece7ef31-6f4c-49ab-87c4-a3479b5e9730", "2026-11-11T13:58:04.103515+00:00"],
  ["ac06b609-4378-4ab5-bc27-5899e03a41b2", "2026-11-11T13:55:06.039129+00:00"],
  ["c9863e98-48c1-4756-856f-059947f104e7", "2026-11-11T13:52:10.530702+00:00"],
  ["6295923f-be9e-4003-bcf2-83a7a0ae6751", "2026-11-11T13:52:06.007336+00:00"],
  ["f91c7a40-82d7-4c38-a0c3-4f21b99b12d2", "2026-11-11T13:49:02.151779+00:00"],
  ["640f920f-b77b-447d-9c3c-4e8b4a9519be", "2026-11-11T13:40:17.608308+00:00"],
  ["e22b67e9-22dd-4d55-bc07-39c247beec39", "2026-11-11T13:37:07.141124+00:00"],
  ["45620276-fdb5-43f3-bafa-2b0829423971", "2026-11-11T13:37:05.460653+00:00"],
  ["f4245a43-89b6-4999-b42a-118327946254", "2026-11-11T13:37:04.48174+00:00"],
  ["0a57fcb4-5adb-42e4-b672-dc4e53d0a3f3", "2026-11-11T13:31:04.190106+00:00"],
  ["64cc7225-3348-4e58-ae14-6a379ca1b34f", "2026-11-11T13:31:03.458261+00:00"],
  ["eb4b0927-8575-4c57-a53d-bbaa8db78499", "2026-11-11T13:22:04.486394+00:00"],
  ["fb7a7af9-7c6c-474b-b5fb-b65a37eeb0c2", "2026-11-11T13:22:02.783359+00:00"],
  ["4d315507-ba48-415e-b986-918e7b7fdaf8", "2026-11-11T13:19:03.465211+00:00"],
  ["7a821c88-d1c5-499e-86c9-fab87f2b0e32", "2026-11-11T13:19:02.748373+00:00"],
  ["72f00c38-5663-4865-9df5-e1ba04d285d1", "2026-11-11T13:13:03.375811+00:00"],
  ["2e081baa-fa32-4880-96b8-e18fa85c863a", "2026-11-11T13:04:05.019218+00:00"],
  ["20f6c202-eceb-4cfb-9271-2b45324d9488", "2026-11-11T12:57:06.892059+00:00"],
  ["ceae1447-c046-4f94-98d0-759785b91245", "2026-11-11T12:52:09.705519+00:00"],
  ["b468056d-2d03-4de0-80dc-a902dcb48f34", "2026-11-11T12:52:09.481588+00:00"],
  ["b9cdd373-c998-46ac-aa96-5981e689ebba", "2026-11-11T12:52:09.308749+00:00"],
  ["2a28f64e-cc5c-49df-af1b-dd4c877c35b2", "2026-11-11T12:52:03.238646+00:00"],
  ["828d3955-4471-40a6-b8a8-2c7aa6fcbc90", "2026-11-11T12:49:02.795349+00:00"],
  ["dd8ae206-691f-4300-b3ef-7fd28aec0793", "2026-11-11T12:39:16.10056+00:00"],
  ["98f8382d-e7aa-4dfd-add4-d312b149b228", "2026-11-11T12:33:06.589154+00:00"],
  ["878b4d5a-e936-4b01-ba04-21738904a6ff", "2026-11-11T12:16:02.737203+00:00"],
  ["fe2bf594-c94d-402d-af66-5e213de4d4fa", "2026-11-11T12:13:04.252092+00:00"],
  ["04579e35-34b3-4e22-ac1c-d6be3c86828a", "2026-11-11T12:10:05.001093+00:00"],
  ["a91db382-3147-47ee-bdf4-1f469ba9e48f", "2026-11-11T12:10:04.806133+00:00"],
  ["8ed338ed-005a-4e82-bca4-bd8bc82c9506", "2026-11-11T12:10:03.731797+00:00"],
  ["de55760f-8e03-468e-b623-276acd717271", "2026-11-11T12:07:04.018328+00:00"],
  ["e6875315-3146-4ee6-9922-ed248a9f41bc", "2026-11-11T12:04:05.284243+00:00"],
  ["33282852-29ab-4597-b3ef-223b71c3df89", "2026-11-11T12:01:04.317563+00:00"],
  ["70ccc9ab-0f51-4d3b-9723-e55b47fdbd70", "2026-11-11T12:01:04.016008+00:00"],
  ["6d6f276b-c00f-4776-b657-7ee971f5c669", "2026-11-11T11:55:07.373951+00:00"],
  ["ef83e14c-182a-4de0-9909-f761cdf427ab", "2026-11-11T11:55:05.667735+00:00"],
  ["4a33c5ba-51fd-4a00-838c-892c33481772", "2026-11-11T11:52:02.593403+00:00"],
  ["9efa4848-7210-4cc5-afdd-08c003b92776", "2026-11-11T11:46:01.99872+00:00"],
  ["ca4d1f5c-ff3a-483d-8e7a-febc72c1fc06", "2026-11-11T11:42:09.409286+00:00"],
  ["280a0726-ce24-485b-af67-fffca36af61b", "2026-11-11T11:40:14.807676+00:00"],
  ["2c6b5b76-8964-4b21-8630-745ec6d62965", "2026-11-11T11:37:04.044853+00:00"],
  ["8093af49-4e00-47de-8d8f-4a12b45d2359", "2026-11-11T11:34:08.152201+00:00"],
  ["cdbf202d-8040-48bd-98fe-f626e10a6083", "2026-11-11T11:34:06.840666+00:00"],
  ["7dbc9b59-d4b0-4051-97c3-2452ff8dbe05", "2026-11-11T11:34:05.334312+00:00"],
  ["9058ad60-f685-475d-9ab6-a9a0fdeaabd7", "2026-11-11T11:34:02.001276+00:00"],
  ["419d5568-1f61-475d-b5e7-fa724bcd3827", "2026-11-11T11:31:03.342193+00:00"],
  ["80bd4e47-7b26-478b-9389-367a8e3906bb", "2026-11-11T11:28:04.496975+00:00"],
  ["e2213fb9-63f2-4acf-8570-a2ffc88eb337", "2026-11-11T11:28:01.663484+00:00"],
  ["78d3a0ee-2cd1-4a20-9768-dd507110a31d", "2026-11-11T11:25:05.318539+00:00"],
  ["3f946486-777b-45b9-81a0-315eb08c2c6d", "2026-11-11T11:25:03.789322+00:00"],
  ["1ea59954-c28d-4969-83db-12c5279d5b7d", "2026-11-11T11:22:03.948621+00:00"],
  ["42e9b83e-bfaf-44e4-a7b0-b9544ab1c9a2", "2026-11-11T11:22:02.748339+00:00"],
  ["acc21cf3-5426-4533-96fd-d0322286b8a7", "2026-11-11T11:19:04.91826+00:00"],
  ["78387bef-2d45-43c4-b9e1-a321ed847ae6", "2026-11-11T11:19:03.713835+00:00"],
  ["ab55cb4d-30a1-46a9-9794-6cbe158cec85", "2026-11-11T11:16:14.663123+00:00"],
  ["18549b6e-ecac-43bc-8ff9-7ee069d4b32a", "2026-11-11T11:16:06.080989+00:00"],
  ["cd05fb3d-7370-4330-b4a3-b9e3dea86177", "2026-11-11T11:04:07.867898+00:00"],
  ["bb4e1ce3-b7b1-4779-b8df-fec82cf5f914", "2026-11-11T11:04:07.527984+00:00"],
  ["ebf69a4f-6d35-4721-b2fb-dc616661fefb", "2026-11-11T11:04:04.903065+00:00"],
  ["2a47f100-702a-419e-b12f-fe774db50474", "2026-11-11T11:04:04.448189+00:00"],
  ["02a78080-f3fb-49a4-8006-9b395f47475f", "2026-11-11T10:58:03.606068+00:00"],
  ["dff71c34-cea6-4299-8a58-dc40715e5d72", "2026-11-11T10:55:29.686769+00:00"],
  ["47004eb4-7420-4e8e-9aae-08c0ad2c3c55", "2026-11-11T10:51:07.531638+00:00"],
  ["dcab5d3d-e40f-4f3f-a2ad-3d1bbe68f187", "2026-11-11T10:49:05.456454+00:00"],
  ["0949bade-0fa5-43f8-9c17-1783de069544", "2026-11-11T10:46:02.169231+00:00"],
  ["b7832f34-7e40-4ba8-90f6-9473d568f22d", "2026-11-11T10:43:03.498699+00:00"],
  ["110a8aaf-365d-4f55-9e88-d10128826770", "2026-11-11T10:36:07.453879+00:00"],
  ["63d89a6c-988b-494f-b45b-f147a20f470c", "2026-11-11T10:34:03.42223+00:00"],
  ["3d012b6b-0c00-4122-81fc-5b08e53c0285", "2026-11-11T10:34:02.922868+00:00"],
  ["31aaeda2-2342-4770-8f49-338d48cce7ec", "2026-11-11T10:27:09.742578+00:00"],
  ["925fa984-4462-49c3-9ba6-e072ca40f250", "2026-11-11T10:27:09.488975+00:00"],
  ["b13f3b0f-f178-4cd4-b026-7eb69d0bd17c", "2026-11-11T10:27:07.487076+00:00"],
  ["777bd421-1aea-4499-9345-cc8b0e15382e", "2026-11-11T10:25:05.929878+00:00"],
  ["fb29045a-94db-4bdd-ab67-12bb0883b8cf", "2026-11-11T10:22:03.725227+00:00"],
  ["97a9e47a-fb2f-4725-ae57-8faa40a96c3c", "2026-11-11T10:22:02.276767+00:00"],
  ["c042b77b-6e22-428e-b815-d95791427f19", "2026-11-11T10:16:04.01951+00:00"],
  ["92dac16c-2ab5-4678-b98c-d87c46ad27b0", "2026-11-11T10:16:03.112638+00:00"],
  ["37348989-84c9-4f58-ba04-14b50f155acd", "2026-11-11T10:10:13.771154+00:00"],
  ["4f075780-213e-4042-8af0-36279aae058d", "2026-11-11T10:10:11.423324+00:00"],
  ["7926fef2-7e54-4e9c-9c30-aa68a9bfc741", "2026-11-11T10:10:06.972639+00:00"],
  ["7be361af-619b-4a7a-abc5-e9f3d3708f61", "2026-11-11T10:10:03.47547+00:00"],
  ["cc21e463-b6d8-487b-9a0c-4449837105f7", "2026-11-11T10:07:03.135315+00:00"],
  ["90223be9-d383-4392-bbe9-82374824e89c", "2026-11-11T10:07:02.709674+00:00"],
  ["920efa9c-90c7-40e0-9964-baced54b7679", "2026-11-11T10:01:03.092394+00:00"],
  ["261298ba-63f5-4dab-a811-e1d5f4bf28cd", "2026-11-11T10:01:02.330032+00:00"],
  ["34adcc89-9ce0-40f4-9f92-78a8767cf2ff", "2026-11-11T09:58:03.829619+00:00"],
  ["1671c37e-3f2d-4eb7-968b-3e40522ffd44", "2026-11-11T09:58:02.392223+00:00"],
  ["d9a596ab-bd50-42a8-86f8-f79afcc1ff49", "2026-11-11T09:51:06.404275+00:00"],
  ["d88e6d2a-a010-41ef-a885-878447d7646c", "2026-11-11T09:49:01.430651+00:00"],
  ["17dedb4d-d33c-4645-aec9-e8d346c4623b", "2026-11-11T09:46:02.430829+00:00"],
  ["fda489ac-9fe3-4f1a-a077-e8a259bf4f37", "2026-11-11T09:43:05.359105+00:00"],
  ["d79d6d13-df75-488d-b63a-b173d962632e", "2026-11-11T09:40:04.164118+00:00"],
  ["0d6af10a-be3b-4a0c-8aba-c32d4b653f63", "2026-11-11T09:31:02.136475+00:00"],
  ["2f5d7d53-2900-4373-82b9-6704e1374ec0", "2026-11-11T09:27:08.520241+00:00"],
  ["da5743b6-c68c-4c8c-ad1d-0bbc66810dd2", "2026-11-11T09:22:03.282898+00:00"],
];

/** The nine columns of saved_clusters_v4 (migration 192), with the two the replay recorded. */
function v4Row(id: string, updated_at: string) {
  return {
    id,
    title_tr: `Küme ${id.slice(0, 8)}`,
    title_tr_neutral: null,
    article_count: 2,
    bias_distribution: null,
    updated_at,
    is_blindspot: false,
    first_published: null,
    effective_article_count: 2,
  };
}
type V4Row = ReturnType<typeof v4Row>;

/** saved_clusters_v4 as the database runs it: p_ids[1:200], rows that exist, order by updated_at desc, limit 200. */
function stubDatabase(clusters: readonly V4Row[]) {
  const byId = new Map(clusters.map((c) => [c.id, c]));
  const calls: { name: SavedRpcName; p_ids: string[] }[] = [];
  const client: SavedRpcClient = {
    async rpc<T>(name: SavedRpcName, args: { p_ids: string[] }) {
      calls.push({ name, p_ids: [...args.p_ids] });
      const hit = args.p_ids.slice(0, 200).flatMap((id) => byId.get(id) ?? []);
      hit.sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
      return { data: hit.slice(0, 200) as unknown as T, error: null };
    },
  };
  return { client, calls };
}

/** saved-list.tsx before h135: one call with the newest 200 valid ids. */
async function oldClientLoad(client: SavedRpcClient, idList: readonly unknown[]): Promise<V4Row[]> {
  const ids = oldClientIds(idList);
  if (ids.length === 0) return [];
  const res = await client.rpc<V4Row[]>("saved_clusters_v4", { p_ids: ids });
  return res.data ?? [];
}

/** saved-list.tsx after h135: chunk 0 through the v4 call, chunks 1..4 through fetchOlderSavedChunks, then the merge. */
async function newClientLoad(client: SavedRpcClient, idList: readonly unknown[]) {
  const plan = savedLookupPlan(idList);
  if (plan.total === 0) return { rows: [] as V4Row[], plan, failed: 0 };
  const [first = [], ...older] = plan.chunks;
  const res = await client.rpc<V4Row[]>("saved_clusters_v4", { p_ids: first });
  const results: V4Row[][] = [res.data ?? []];
  const more = await fetchOlderSavedChunks<V4Row>(client, "saved_clusters_v4", older, () => false);
  if (more === null) throw new Error("cancelled");
  results.push(...more.results);
  return { rows: mergeSavedRows(results), plan, failed: more.failed };
}

describe("fixture: 201 real saved ids (production shape, 2026-11-11)", () => {
  const clusters = PROD_201.map(([id, at]) => v4Row(id, at));
  // The reader saved them all; the array runs oldest first.
  const bookmarks = PROD_201.map(([id]) => id).reverse();
  const oldest = bookmarks[0] as string;

  it("the fixture is 201 distinct well-formed ids, newest first as the RPC returned them", () => {
    expect(PROD_201).toHaveLength(201);
    expect(new Set(PROD_201.map(([id]) => id)).size).toBe(201);
    for (const [id] of PROD_201) expect(UUID_RE.test(id)).toBe(true);
    const stamps = PROD_201.map(([, at]) => at);
    expect(stamps).toEqual([...stamps].sort().reverse());
  });

  it("the stub reproduces what production did: all 201 in one call drops the newest id, and the oldest alone is reachable", async () => {
    const db = stubDatabase(clusters);
    const all = await db.client.rpc<V4Row[]>("saved_clusters_v4", { p_ids: bookmarks });
    expect(all.data).toHaveLength(200);
    expect(all.data?.map((r) => r.id)).not.toContain(PROD_201[0]?.[0]);
    const alone = await db.client.rpc<V4Row[]>("saved_clusters_v4", { p_ids: [oldest] });
    expect(alone.data?.map((r) => r.id)).toEqual([oldest]);
  });

  it("OLD client: one call with the newest 200, 200 rows, and the oldest bookmark has no row (no link, no remove button)", async () => {
    const db = stubDatabase(clusters);
    const rows = await oldClientLoad(db.client, bookmarks);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]?.p_ids).toEqual(bookmarks.slice(1));
    expect(rows).toHaveLength(200);
    expect(rows.map((r) => r.id)).not.toContain(oldest);
  });

  it("NEW client: two calls (the newest 200, then the oldest id), 201 rows including the oldest, in updated_at order", async () => {
    const db = stubDatabase(clusters);
    const { rows, plan, failed } = await newClientLoad(db.client, bookmarks);
    expect(db.calls).toEqual([
      { name: "saved_clusters_v4", p_ids: bookmarks.slice(1) },
      { name: "saved_clusters_v4", p_ids: [oldest] },
    ]);
    expect(failed).toBe(0);
    expect(rows).toHaveLength(201);
    expect(rows.map((r) => r.id)).toContain(oldest);
    // the page's existing order: exactly the order production listed them in
    expect(rows.map((r) => r.id)).toEqual(PROD_201.map(([id]) => id));
    expect(plan).toMatchObject({ total: 201, requested: 201 });
    // nothing to say to the reader: total <= requested
    expect(renderToStaticMarkup(createElement(SavedTruncationNote, { shown: plan.requested, total: plan.total }))).toBe("");
  });

  it("NEW client, 200 bookmarks or fewer: exactly ONE call, byte-for-byte the call the old client made, same rows", async () => {
    for (const n of [1, 17, 150, 200]) {
      const list = bookmarks.slice(-n);
      const oldDb = stubDatabase(clusters);
      const newDb = stubDatabase(clusters);
      const oldRows = await oldClientLoad(oldDb.client, list);
      const { rows } = await newClientLoad(newDb.client, list);
      expect(newDb.calls, `n=${n}`).toHaveLength(1);
      expect(newDb.calls, `n=${n}`).toEqual(oldDb.calls);
      expect(rows, `n=${n}`).toEqual(oldRows);
    }
  });

  it("NEW client, a hand-edited list: junk entries never reach the RPC, same single call as before", async () => {
    const list: unknown[] = ["x", null, ...bookmarks.slice(-3), 12, "also-bad"];
    const oldDb = stubDatabase(clusters);
    const newDb = stubDatabase(clusters);
    await oldClientLoad(oldDb.client, list);
    await newClientLoad(newDb.client, list);
    expect(newDb.calls).toEqual(oldDb.calls);
    expect(newDb.calls).toHaveLength(1);
  });

  it("NEW client, 1001 saved ids: 5 calls of at most 200, at most 1000 rows, the oldest id is not requested", async () => {
    const many = uids(1001);
    // distinct stamps, later with n (an older bookmark is an older cluster): 00:00:00 .. 00:16:40, one second apart
    const stamp = (n: number) => `2026-10-01T00:${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}+00:00`;
    const db = stubDatabase(many.map((id, n) => v4Row(id, stamp(n))));
    const { rows, plan } = await newClientLoad(db.client, many);
    expect(db.calls).toHaveLength(5);
    for (const call of db.calls) expect(call.p_ids.length).toBeLessThanOrEqual(200);
    expect(db.calls.flatMap((c) => c.p_ids)).not.toContain(many[0]);
    expect(rows).toHaveLength(1000);
    expect(new Set(rows.map((r) => r.id)).size).toBe(1000);
    expect(rows.map((r) => r.id)).toEqual(many.slice(1).reverse()); // newest first
    expect(plan).toMatchObject({ total: 1001, requested: 1000 });
    expect(
      renderToStaticMarkup(createElement(SavedTruncationNote, { shown: plan.requested, total: plan.total })).replace(/<[^>]*>/g, ""),
    ).toBe("En yeni 1.000 kayıt gösteriliyor; toplam 1.001 kayıt var.");
  });

  it("NEW client, one older chunk fails: the rows of the chunks that succeeded stay, and the failure is counted", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const db = stubDatabase(clusters);
    const flaky: SavedRpcClient = {
      async rpc<T>(name: SavedRpcName, args: { p_ids: string[] }) {
        // the single-id chunk (the oldest) fails with a statement timeout
        if (args.p_ids.length === 1) return { data: null, error: { message: "statement timeout", code: "57014" } };
        return db.client.rpc<T>(name, args);
      },
    };
    const { rows, failed, plan } = await newClientLoad(flaky, bookmarks);
    expect(failed).toBe(1);
    expect(rows).toHaveLength(200); // chunk 0's rows are NOT blanked
    expect(rows.map((r) => r.id)).not.toContain(oldest);
    expect(savedLookupStatus(plan.chunks.length, failed, rows.length)).toBe("partial");
    vi.restoreAllMocks();
  });
});

describe("saved-lookup.ts source", () => {
  const src = readFileSync(join(__dirname, "saved-lookup.ts"), "utf8");
  // code only: block comments and line comments removed, so prose can neither satisfy nor trip a guard
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

  it("is browser-safe and holds no secrets: no browser client import, no storage, no table call", () => {
    expect(code).not.toMatch(/@\/lib\/supabase/);
    expect(code).not.toContain("localStorage");
    expect(code).not.toMatch(/(?<!Array)\.from\s*\(/);
    expect(code).not.toMatch(/SUPABASE|anon/i);
  });

  it("can only name the four allowlisted /saved RPCs (browser.ts enforces the same set at runtime)", () => {
    expect(src).toContain(
      'export type SavedRpcName = "saved_clusters_v4" | "saved_clusters_v3" | "saved_clusters_v2" | "saved_clusters";',
    );
    // the one .rpc( call takes the typed name, never a string built from input
    expect(Array.from(code.matchAll(/\.rpc\s*(?:<[^>]*>)?\s*\(\s*([^,)\s]*)/g), (m) => m[1])).toEqual(["name"]);
  });

  it("reads no clock", () => {
    expect(code).not.toMatch(/Date\.now|new Date|performance\.now/);
  });

  it("builds the note with createElement (a .ts module, no JSX)", () => {
    expect(code).toContain("createElement(");
    expect(code).toMatch(/import\s*\{[^}]*\bcreateElement\b[^}]*\}\s*from\s*"react";/);
  });
});
