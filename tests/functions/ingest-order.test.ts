import { describe, expect, it, vi } from "vitest";
import {
  CYCLE_PERIOD_MS,
  ISOLATE_ITEM_BUDGET,
  KNOWN_ITEMS_HEADROOM,
  KNOWN_ITEMS_MAX_SIZE_RATIO,
  createItemBudget,
  createParseBudget,
  estimateItems,
  groupChunkBySource,
  interleaveBySource,
  isolateItems,
  pickStaleReservation,
  prioritizeIds,
  prioritizeStale,
  reserveItemsFor,
  rotateForCycle,
  summarizeStale,
  upsertWithBisect,
} from "../../supabase/functions/ingest/order.ts";

describe("rotateForCycle", () => {
  it("rotates by floor(startedAtMs / periodMs) % n", () => {
    const items = ["a", "b", "c", "d"];
    // offset = floor(5*180000 / 180000) % 4 = 5 % 4 = 1
    expect(rotateForCycle(items, 5 * CYCLE_PERIOD_MS)).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  it("returns an empty array unchanged", () => {
    expect(rotateForCycle([], 12345)).toEqual([]);
  });

  it("returns a single-item array unchanged (as a copy)", () => {
    const items = ["only"];
    const out = rotateForCycle(items, 999_999);
    expect(out).toEqual(["only"]);
    expect(out).not.toBe(items);
  });

  it("wraps around a full period", () => {
    const items = ["a", "b", "c"];
    // offset 0 at cycle 0
    expect(rotateForCycle(items, 0)).toEqual(["a", "b", "c"]);
    // one full period later with n=3 -> offset back to 0 only when
    // startedAtMs/periodMs is a multiple of n; otherwise walks forward.
    expect(rotateForCycle(items, 1 * CYCLE_PERIOD_MS)).toEqual([
      "b",
      "c",
      "a",
    ]);
    expect(rotateForCycle(items, 3 * CYCLE_PERIOD_MS)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });
});

interface Row {
  source_id: string;
  published_at: string;
  label: string;
}

function row(source_id: string, publishedAt: string, label: string): Row {
  return { source_id, published_at: publishedAt, label };
}

describe("interleaveBySource", () => {
  it("round-robins newest-first across sources in first-seen order", () => {
    const rows: Row[] = [
      row("A", "2026-01-01T00:00:03Z", "A1"),
      row("B", "2026-01-01T00:00:00Z", "B1"),
      row("C", "2026-01-01T00:00:02Z", "C1"),
      row("A", "2026-01-01T00:00:02Z", "A2"),
      row("C", "2026-01-01T00:00:01Z", "C2"),
      row("A", "2026-01-01T00:00:01Z", "A3"),
    ];
    const out = interleaveBySource(rows).map((r) => r.label);
    expect(out).toEqual(["A1", "B1", "C1", "A2", "C2", "A3"]);
  });

  it("is stable within a source when published_at ties", () => {
    const rows: Row[] = [
      row("A", "2026-01-01T00:00:00Z", "A1"),
      row("A", "2026-01-01T00:00:00Z", "A2"),
      row("A", "2026-01-01T00:00:00Z", "A3"),
    ];
    expect(interleaveBySource(rows).map((r) => r.label)).toEqual([
      "A1",
      "A2",
      "A3",
    ]);
  });

  it("handles empty input", () => {
    expect(interleaveBySource([])).toEqual([]);
  });
});

describe("groupChunkBySource", () => {
  it("stably groups rows by source_id", () => {
    const rows: Row[] = [
      row("B", "2026-01-01T00:00:00Z", "B1"),
      row("A", "2026-01-01T00:00:00Z", "A1"),
      row("B", "2026-01-01T00:00:00Z", "B2"),
      row("A", "2026-01-01T00:00:00Z", "A2"),
    ];
    const out = groupChunkBySource(rows).map((r) => r.label);
    expect(out).toEqual(["A1", "A2", "B1", "B2"]);
  });

  it("does not mutate the input array", () => {
    const rows: Row[] = [
      row("B", "2026-01-01T00:00:00Z", "B1"),
      row("A", "2026-01-01T00:00:00Z", "A1"),
    ];
    const copy = [...rows];
    groupChunkBySource(rows);
    expect(rows).toEqual(copy);
  });
});

interface FakeRow {
  url: string;
}

function makeRows(n: number): FakeRow[] {
  return Array.from({ length: n }, (_, i) => ({ url: `https://x/${i}` }));
}

function ceilLog2(n: number): number {
  return Math.ceil(Math.log2(n));
}

describe("upsertWithBisect", () => {
  it("takes exactly 1 call when every row succeeds", async () => {
    const rows = makeRows(10);
    const upsert = vi.fn(async (batch: FakeRow[]) => ({
      inserted: batch.length,
      error: null as string | null,
    }));
    const result = await upsertWithBisect(rows, upsert, {
      isPastDeadline: () => false,
    });
    expect(result.calls).toBe(1);
    expect(result.inserted).toBe(10);
    expect(result.rowErrors).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.firstError).toBeNull();
  });

  it("isolates 1 bad row in 8 — inserted 7, rowErrors 1, calls <= 7", async () => {
    const rows = makeRows(8);
    const badUrl = rows[3]!.url;
    const upsert = vi.fn(async (batch: FakeRow[]) => {
      if (batch.some((r) => r.url === badUrl)) {
        return { inserted: 0, error: "poisoned row" };
      }
      return { inserted: batch.length, error: null };
    });
    const onRowError = vi.fn((row: FakeRow, _err: string) => {
      seenBadRows.push(row.url);
    });
    const seenBadRows: string[] = [];
    const result = await upsertWithBisect(rows, upsert, {
      isPastDeadline: () => false,
      onRowError,
    });
    expect(result.inserted).toBe(7);
    expect(result.rowErrors).toBe(1);
    expect(result.calls).toBeLessThanOrEqual(1 + 2 * ceilLog2(8));
    expect(result.calls).toBeLessThanOrEqual(7);
    expect(seenBadRows).toEqual([badUrl]);
    expect(result.firstError).toBe("poisoned row");
  });

  it("isolates 1 bad row in 500 in at most 19 calls", async () => {
    const rows = makeRows(500);
    const badUrl = rows[499]!.url;
    const upsert = vi.fn(async (batch: FakeRow[]) => {
      if (batch.some((r) => r.url === badUrl)) {
        return { inserted: 0, error: "poisoned row" };
      }
      return { inserted: batch.length, error: null };
    });
    const result = await upsertWithBisect(rows, upsert, {
      isPastDeadline: () => false,
    });
    expect(result.inserted).toBe(499);
    expect(result.rowErrors).toBe(1);
    expect(result.calls).toBeLessThanOrEqual(1 + 2 * ceilLog2(500));
    expect(result.calls).toBeLessThanOrEqual(19);
  });

  it("isolates 2 bad rows independently", async () => {
    const rows = makeRows(16);
    const badUrls = new Set([rows[2]!.url, rows[11]!.url]);
    const upsert = vi.fn(async (batch: FakeRow[]) => {
      if (batch.some((r) => badUrls.has(r.url))) {
        return { inserted: 0, error: "poisoned row" };
      }
      return { inserted: batch.length, error: null };
    });
    const seen: string[] = [];
    const result = await upsertWithBisect(rows, upsert, {
      isPastDeadline: () => false,
      onRowError: (row) => seen.push(row.url),
    });
    expect(result.rowErrors).toBe(2);
    expect(result.inserted).toBe(14);
    expect(new Set(seen)).toEqual(badUrls);
  });

  it("counts batches popped after the deadline flips true as skipped, not rowErrors", async () => {
    const rows = makeRows(8);
    let callCount = 0;
    let deadlinePassed = false;
    const upsert = vi.fn(async (_batch: FakeRow[]) => {
      callCount++;
      if (callCount === 2) deadlinePassed = true;
      // Every call fails so the batch keeps splitting (until the deadline
      // check short-circuits the rest).
      return { inserted: 0, error: "always fails" };
    });
    const result = await upsertWithBisect(rows, upsert, {
      isPastDeadline: () => deadlinePassed,
    });
    expect(result.calls).toBe(2);
    expect(result.rowErrors).toBe(0);
    expect(result.skipped).toBe(8);
  });

  it("returns all-zero for an empty input without calling upsert", async () => {
    const upsert = vi.fn(async () => ({ inserted: 0, error: null as string | null }));
    const result = await upsertWithBisect([], upsert, {
      isPastDeadline: () => false,
    });
    expect(result.calls).toBe(0);
    expect(result.inserted).toBe(0);
    expect(result.rowErrors).toBe(0);
    expect(result.skipped).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
  });
});


describe("upsertWithBisect onSkipped [silent-feeds]", () => {
  const mk = (n: number): FakeRow[] =>
    Array.from({ length: n }, (_, i) => ({ id: i }) as unknown as FakeRow);

  it("receives exactly the batches popped after the deadline; total equals skipped", async () => {
    const rows = mk(8);
    let callCount = 0;
    let deadlinePassed = false;
    const upsert = vi.fn(async (_batch: FakeRow[]) => {
      callCount++;
      if (callCount === 2) deadlinePassed = true;
      return { inserted: 0, error: "always fails" };
    });
    const skippedBatches: FakeRow[][] = [];
    const result = await upsertWithBisect(rows, upsert, {
      isPastDeadline: () => deadlinePassed,
      onSkipped: (batch) => skippedBatches.push([...batch]),
    });
    expect(result.skipped).toBe(8);
    expect(skippedBatches.reduce((n, b) => n + b.length, 0)).toBe(result.skipped);
    // Every row is reported skipped exactly once.
    expect(new Set(skippedBatches.flat()).size).toBe(8);
  });

  it("is never called on an on-time run", async () => {
    const onSkipped = vi.fn();
    const upsert = vi.fn(async (_batch: FakeRow[]) => ({ inserted: 1, error: null as string | null }));
    const result = await upsertWithBisect(mk(5), upsert, {
      isPastDeadline: () => false,
      onSkipped,
    });
    expect(result.skipped).toBe(0);
    expect(onSkipped).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Parse budget (twin-articles item, part B): ingest cycles died on the
// platform CPU limit (HTTP 546, reason CPUTime) because one cycle parsed every
// changed feed. `createParseBudget` decides, per changed feed, whether this
// cycle may still afford its decode + XML parse + normalise; a refused feed is
// deferred to the front of the next cycle (`prioritizeIds`).
// ---------------------------------------------------------------------------

describe("createParseBudget", () => {
  it("starts empty", () => {
    const b = createParseBudget(40, 4_000_000);
    expect(b.parses).toBe(0);
    expect(b.bytes).toBe(0);
  });

  it("refuses once maxParses parses were admitted, whatever the bytes or priority", () => {
    const b = createParseBudget(2, 1_000_000);
    expect(b.admit(10)).toBe(true);
    expect(b.admit(10)).toBe(true);
    expect(b.admit(1, false)).toBe(false);
    expect(b.admit(1, true)).toBe(false);
    expect(b.parses).toBe(2);
    expect(b.bytes).toBe(20);
  });

  it("admits the first parse of a cycle even when it is bigger than the whole byte budget", () => {
    const b = createParseBudget(40, 1_000);
    expect(b.admit(5_000)).toBe(true);
    expect(b.parses).toBe(1);
    expect(b.bytes).toBe(5_000);
  });

  it("admits while the running total stays within maxBytes, boundary inclusive", () => {
    const b = createParseBudget(40, 1_000);
    expect(b.admit(400)).toBe(true);
    expect(b.admit(600)).toBe(true); // 1_000 exactly: <= maxBytes
    expect(b.bytes).toBe(1_000);
    expect(b.admit(1)).toBe(false); // 1_001 > 1_000
    expect(b.bytes).toBe(1_000);
  });

  it("refuses a feed that does not fit, and the refusal leaves the counters alone", () => {
    const b = createParseBudget(40, 1_000);
    expect(b.admit(900)).toBe(true);
    expect(b.admit(200)).toBe(false);
    expect(b.parses).toBe(1);
    expect(b.bytes).toBe(900);
    // A smaller feed later in the same cycle still fits.
    expect(b.admit(100)).toBe(true);
    expect(b.parses).toBe(2);
    expect(b.bytes).toBe(1_000);
  });

  it("lets a PRIORITY feed overshoot the byte budget once per cycle, then refuses further overshoots", () => {
    const b = createParseBudget(40, 1_000);
    expect(b.admit(900)).toBe(true);
    expect(b.admit(500, true)).toBe(true); // 1_400: the one overshoot
    expect(b.bytes).toBe(1_400);
    expect(b.admit(500, true)).toBe(false); // a second overshoot, priority or not
    expect(b.admit(500, false)).toBe(false);
    expect(b.parses).toBe(2);
  });

  it("never lets a NON-priority feed overshoot", () => {
    const b = createParseBudget(40, 1_000);
    expect(b.admit(900)).toBe(true);
    expect(b.admit(500, false)).toBe(false);
    expect(b.admit(500)).toBe(false);
    expect(b.bytes).toBe(900);
  });

  it("a priority feed that fits does not spend the overshoot", () => {
    const b = createParseBudget(40, 1_000);
    expect(b.admit(300, true)).toBe(true);
    expect(b.admit(300, true)).toBe(true);
    expect(b.admit(900, true)).toBe(true); // 1_500: still has its one overshoot
    expect(b.admit(900, true)).toBe(false);
  });

  it("a feed bigger than the budget cannot starve: it is first in the next cycle and always admitted", () => {
    // Cycle 1: a 3 MB feed behind a 3 MB feed loses the budget race...
    const c1 = createParseBudget(40, 4_000_000);
    expect(c1.admit(3_000_000, false)).toBe(true);
    expect(c1.admit(3_000_000, false)).toBe(false);
    // ...cycle 2: it is deferred-first (priority) and parses.
    const c2 = createParseBudget(40, 4_000_000);
    expect(c2.admit(3_000_000, true)).toBe(true);
  });

  it("is independent per instance (no shared module state)", () => {
    const a = createParseBudget(1, 10);
    const b = createParseBudget(1, 10);
    expect(a.admit(5)).toBe(true);
    expect(a.admit(5)).toBe(false);
    expect(b.admit(5)).toBe(true);
  });

  it("with maxParses 0 refuses everything, even the first parse", () => {
    const b = createParseBudget(0, 1_000_000);
    expect(b.admit(1, true)).toBe(false);
    expect(b.parses).toBe(0);
  });

  it("handles 0-byte bodies without special cases", () => {
    const b = createParseBudget(3, 0);
    expect(b.admit(0)).toBe(true); // first parse
    expect(b.admit(0)).toBe(true); // 0 + 0 <= 0
    expect(b.admit(1)).toBe(false);
  });
});

describe("prioritizeIds", () => {
  const rows = ["a", "b", "c", "d", "e"].map((id) => ({ id }));

  it("moves the given ids to the front and keeps both groups in their original order", () => {
    const out = prioritizeIds(rows, new Set(["d", "b"]));
    expect(out.map((r) => r.id)).toEqual(["b", "d", "a", "c", "e"]);
  });

  it("ignores the order of the ids argument (stable on the rows' order)", () => {
    const one = prioritizeIds(rows, ["e", "a"]).map((r) => r.id);
    const two = prioritizeIds(rows, ["a", "e"]).map((r) => r.id);
    expect(one).toEqual(["a", "e", "b", "c", "d"]);
    expect(two).toEqual(one);
  });

  it("returns a copy in the same order for an empty id set", () => {
    const out = prioritizeIds(rows, new Set());
    expect(out).toEqual(rows);
    expect(out).not.toBe(rows);
  });

  it("ignores ids that are not in the rows", () => {
    const out = prioritizeIds(rows, ["zzz", "c"]);
    expect(out.map((r) => r.id)).toEqual(["c", "a", "b", "d", "e"]);
  });

  it("does not mutate its input and keeps object identity", () => {
    const input = [...rows];
    const out = prioritizeIds(input, ["e"]);
    expect(input).toEqual(rows);
    expect(out[0]).toBe(rows[4]);
  });

  it("handles an empty row list and all-priority lists", () => {
    expect(prioritizeIds([], ["a"])).toEqual([]);
    expect(prioritizeIds(rows, rows.map((r) => r.id))).toEqual(rows);
  });

  it("keeps other row fields intact", () => {
    const rich = [{ id: "x", n: 1 }, { id: "y", n: 2 }];
    expect(prioritizeIds(rich, ["y"])).toEqual([{ id: "y", n: 2 }, { id: "x", n: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// Isolate item budget [A-ingest-cpu, hunt-11]
//
// The platform's 2 s CPU allowance is cumulative per isolate: on 2026-11-01 the
// 2nd request of a reused isolate was shut down (CPUTime, 2000-2176 ms) 7 times
// out of 12 two-request isolates. The parse budget above is per cycle; this one
// is per isolate and counts ITEMS (the per-item cost dominates), estimated from
// the body size before the parse and corrected to the real count after it.
// ---------------------------------------------------------------------------

describe("estimateItems", () => {
  it("is max(1, floor(bytes / 1500))", () => {
    expect(estimateItems(0)).toBe(1);
    expect(estimateItems(1)).toBe(1);
    expect(estimateItems(1499)).toBe(1);
    expect(estimateItems(1500)).toBe(1);
    expect(estimateItems(2999)).toBe(1);
    expect(estimateItems(3000)).toBe(2);
    expect(estimateItems(45 * 1500)).toBe(45);
    expect(estimateItems(8_000_000)).toBe(Math.floor(8_000_000 / 1500));
  });

  it("never returns less than 1, whatever it is given", () => {
    expect(estimateItems(-5)).toBe(1);
    expect(estimateItems(Number.NaN)).toBe(1);
    expect(estimateItems(Number.POSITIVE_INFINITY)).toBe(1);
  });

  // h36-pipeline-1: BHA's body is 4.25 MB for 1000 items (4.2 kB an item), so the
  // size-only estimate books 2,833 items for a feed that costs 1,000.
  describe("with the feed's last known item count", () => {
    it("is unchanged without a usable count: size alone still gives 2,833 for BHA's 4.25 MB", () => {
      expect(estimateItems(4_250_000)).toBe(2833);
      expect(estimateItems(4_250_000, null)).toBe(2833);
      expect(estimateItems(4_250_000, undefined)).toBe(2833);
    });

    it("caps the size estimate at 125% of the known count (ceil): 1,250 for BHA", () => {
      expect(estimateItems(4_250_000, 1000)).toBe(1250);
    });

    // secdb-1: the cap is only trusted while the body is plausibly the same feed
    // with fatter items. A body more than KNOWN_ITEMS_MAX_SIZE_RATIO (4) times
    // the capped count means the feed changed shape (or serves a huge body that
    // its stored count no longer describes); a stale count must not shrink that
    // estimate, because the size is third-party input to the CPU guard.
    it("returns to the size-only estimate when the body is far larger than the known count explains", () => {
      expect(estimateItems(4_250_000, 3)).toBe(2833);
      expect(estimateItems(4_250_000, 1)).toBe(2833);
      expect(estimateItems(4_000_000, 12)).toBe(2666);
    });

    it("the ratio boundary: size 4 x the capped count is still capped, one item above is not", () => {
      expect(KNOWN_ITEMS_MAX_SIZE_RATIO).toBe(4);
      // by size 500 = 4 x ceil(100 * 1.25) = 4 x 125: capped to 125.
      expect(estimateItems(750_000, 100)).toBe(125);
      // by size 501 > 4 x 125: the size-only estimate stands.
      expect(estimateItems(751_500, 100)).toBe(501);
    });

    it("a stale small count no longer lets a large body into an almost-full isolate", () => {
      const budget = createItemBudget(5000, { used: 4000, cycles: 1 });
      // was true when the 12-item count capped the estimate at 15
      expect(budget.fits(estimateItems(4_000_000, 12))).toBe(false);
    });

    it("never goes above the size estimate: a smaller body keeps its own estimate", () => {
      expect(estimateItems(300_000, 1000)).toBe(200);
      expect(estimateItems(45 * 1500, 1000)).toBe(45);
      expect(estimateItems(3000, 1000)).toBe(2);
    });

    it("ignores a count that is not a positive integer (0, negative, fractional, NaN, Infinity)", () => {
      for (const known of [0, -4, 0.5, 2.5, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(estimateItems(4_250_000, known), String(known)).toBe(2833);
      }
    });

    it("still returns at least 1, and 1 for a bad size, whatever the count", () => {
      expect(estimateItems(0, 1000)).toBe(1);
      expect(estimateItems(100, 1000)).toBe(1);
      expect(estimateItems(-5, 1000)).toBe(1);
      expect(estimateItems(Number.NaN, 1000)).toBe(1);
      expect(estimateItems(Number.POSITIVE_INFINITY, 1000)).toBe(1);
    });

    it("lets BHA in on an isolate that already holds 3,000 items, which the size-only estimate refuses", () => {
      const budget = createItemBudget(5000, { used: 3000, cycles: 1 });
      expect(budget.fits(estimateItems(4_250_000, 1000))).toBe(true);
      // documents the bug: 3000 + 2833 > 5000
      expect(budget.fits(estimateItems(4_250_000))).toBe(false);
    });
  });
});

describe("createItemBudget", () => {
  const fresh = () => ({ used: 0, cycles: 0 });

  it("a fresh isolate admits any one feed, however big", () => {
    const state = fresh();
    const budget = createItemBudget(100, state);
    expect(budget.fits(1)).toBe(true);
    expect(budget.fits(100)).toBe(true);
    expect(budget.fits(1_000_000)).toBe(true);
  });

  it("once something is booked, only what fits under the limit is admitted", () => {
    const state = fresh();
    const budget = createItemBudget(100, state);
    budget.book(40);
    expect(budget.fits(60)).toBe(true);
    expect(budget.fits(61)).toBe(false);
    expect(budget.fits(1_000_000)).toBe(false);
  });

  it("has no priority exemption: fits takes the size only", () => {
    const state = fresh();
    const budget = createItemBudget(10, state);
    budget.book(10);
    expect(budget.fits(1)).toBe(false);
    expect((budget.fits as (n: number, priority?: boolean) => boolean)(1, true)).toBe(false);
  });

  it("book adds to the shared state", () => {
    const state = fresh();
    const budget = createItemBudget(100, state);
    budget.book(7);
    budget.book(5);
    expect(state.used).toBe(12);
    expect(budget.used).toBe(12);
  });

  it("fits does not book", () => {
    const state = fresh();
    const budget = createItemBudget(100, state);
    budget.fits(50);
    expect(state.used).toBe(0);
  });

  it("settle replaces the booked estimate with the real count", () => {
    const state = fresh();
    const budget = createItemBudget(100, state);
    budget.book(45);
    budget.settle(45, 30); // fewer items than estimated: give the difference back
    expect(state.used).toBe(30);
    budget.book(10);
    budget.settle(10, 25); // more items than estimated: charge the difference
    expect(state.used).toBe(55);
  });

  it("settle never takes used below zero", () => {
    const state = fresh();
    const budget = createItemBudget(100, state);
    budget.book(5);
    budget.settle(50, 0);
    expect(state.used).toBe(0);
    budget.settle(10, 0);
    expect(state.used).toBe(0);
  });

  it("two budgets sharing one state accumulate: that is two cycles on one isolate", () => {
    const state = fresh();
    const cycle1 = createItemBudget(60, state);
    expect(cycle1.fits(45)).toBe(true);
    cycle1.book(45);
    cycle1.settle(45, 45);

    const cycle2 = createItemBudget(60, state);
    expect(cycle2.used).toBe(45);
    expect(cycle2.fits(15)).toBe(true);
    expect(cycle2.fits(16)).toBe(false);
    cycle2.book(10);
    expect(cycle1.used).toBe(55);
  });

  it("a different limit applies per budget, the used count is shared", () => {
    const state = fresh();
    createItemBudget(60, state).book(50);
    expect(createItemBudget(60, state).fits(20)).toBe(false);
    // An operator raising INGEST_ISOLATE_ITEM_BUDGET takes effect next cycle.
    expect(createItemBudget(5000, state).fits(20)).toBe(true);
  });

  it("exposes its limit", () => {
    expect(createItemBudget(123, fresh()).limit).toBe(123);
  });
});

describe("isolate item budget defaults", () => {
  it("ships at 5000 items per isolate", () => {
    expect(ISOLATE_ITEM_BUDGET).toBe(5000);
  });

  it("starts with an empty module-scope state", () => {
    expect(isolateItems).toEqual({ used: 0, cycles: 0 });
  });
});

// ---------------------------------------------------------------------------
// h36-pipeline-1: a feed the isolate budget refuses writes no fetch state, so the
// parse-deferral memory (parseDeferredIds, module scope) is lost when the isolate
// recycles. The age of fetch_last_at is the persisted signal.
// ---------------------------------------------------------------------------

describe("prioritizeStale", () => {
  const NOW = Date.parse("2026-11-05T08:00:00.000Z");
  const MIN = 60_000;
  const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
  type Src = { id: string; fetch_last_at?: string | null };

  it("moves a stale feed to the front and keeps the others in their order", () => {
    const rows: Src[] = [
      { id: "a", fetch_last_at: ago(1) },
      { id: "bha", fetch_last_at: ago(160) },
      { id: "c", fetch_last_at: ago(2) },
    ];
    expect(prioritizeStale(rows, NOW).map((r) => r.id)).toEqual(["bha", "a", "c"]);
  });

  it("treats a null, undefined or unparseable fetch_last_at as stale", () => {
    const rows: Src[] = [
      { id: "fresh", fetch_last_at: ago(1) },
      { id: "null", fetch_last_at: null },
      { id: "undef" },
      { id: "junk", fetch_last_at: "not a date" },
    ];
    expect(prioritizeStale(rows, NOW).map((r) => r.id)).toEqual(["null", "undef", "junk", "fresh"]);
  });

  it("orders the stale feeds oldest first, never-fetched first of all, ties in input order", () => {
    const rows: Src[] = [
      { id: "fresh", fetch_last_at: ago(0) },
      { id: "s30", fetch_last_at: ago(30) },
      { id: "s300", fetch_last_at: ago(300) },
      { id: "never", fetch_last_at: null },
      { id: "s30b", fetch_last_at: ago(30) },
      { id: "s100", fetch_last_at: ago(100) },
    ];
    expect(prioritizeStale(rows, NOW).map((r) => r.id)).toEqual(["never", "s300", "s100", "s30", "s30b", "fresh"]);
  });

  it("the default threshold is three cycle periods (9 minutes): older is stale, exactly at or inside is not", () => {
    const rows: Src[] = [
      { id: "inside", fetch_last_at: new Date(NOW - 3 * CYCLE_PERIOD_MS + 1).toISOString() },
      { id: "edge", fetch_last_at: new Date(NOW - 3 * CYCLE_PERIOD_MS).toISOString() },
      { id: "over", fetch_last_at: new Date(NOW - 3 * CYCLE_PERIOD_MS - 1).toISOString() },
    ];
    expect(prioritizeStale(rows, NOW).map((r) => r.id)).toEqual(["over", "inside", "edge"]);
  });

  it("takes the threshold as a parameter", () => {
    const rows: Src[] = [
      { id: "a", fetch_last_at: ago(5) },
      { id: "b", fetch_last_at: ago(20) },
    ];
    expect(prioritizeStale(rows, NOW, 10 * MIN).map((r) => r.id)).toEqual(["b", "a"]);
    expect(prioritizeStale(rows, NOW, 30 * MIN).map((r) => r.id)).toEqual(["a", "b"]);
  });

  it("a fetch_last_at in the future (clock skew) is fresh, not stale", () => {
    const rows: Src[] = [
      { id: "a", fetch_last_at: ago(1) },
      { id: "future", fetch_last_at: new Date(NOW + 5 * MIN).toISOString() },
      { id: "old", fetch_last_at: ago(60) },
    ];
    expect(prioritizeStale(rows, NOW).map((r) => r.id)).toEqual(["old", "a", "future"]);
  });

  it("returns a new array, keeps extra fields and the same objects, and handles empty and all-fresh input", () => {
    expect(prioritizeStale([], NOW)).toEqual([]);
    const fresh: Array<Src & { slug: string }> = [
      { id: "a", slug: "a", fetch_last_at: ago(1) },
      { id: "b", slug: "b", fetch_last_at: ago(2) },
    ];
    const out = prioritizeStale(fresh, NOW);
    expect(out).toEqual(fresh);
    expect(out).not.toBe(fresh);
    expect(out[0]).toBe(fresh[0]);
    const input: Src[] = [
      { id: "x", fetch_last_at: ago(1) },
      { id: "y", fetch_last_at: null },
    ];
    const snapshot = JSON.stringify(input);
    prioritizeStale(input, NOW);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  it("composes with prioritizeIds: an in-memory deferral still wins within an isolate", () => {
    const rows: Src[] = [
      { id: "a", fetch_last_at: ago(1) },
      { id: "deferred", fetch_last_at: ago(2) },
      { id: "bha", fetch_last_at: ago(160) },
    ];
    const order = prioritizeIds(prioritizeStale(rows, NOW), ["deferred"]);
    expect(order.map((r) => r.id)).toEqual(["deferred", "bha", "a"]);
  });

  it("a fresh isolate (nothing booked yet) admits BHA after the reorder, and refuses it before", () => {
    // [x est 2200, y est 1500, bha est 2833]: 2200 + 1500 = 3700, so BHA needs 3700 + 2833 <= 5000, which fails.
    const rows: Array<Src & { est: number }> = [
      { id: "x", est: 2200, fetch_last_at: ago(1) },
      { id: "y", est: 1500, fetch_last_at: ago(2) },
      { id: "bha", est: 2833, fetch_last_at: ago(160) },
    ];
    const admitted = (order: Array<{ id: string; est: number }>): string[] => {
      const budget = createItemBudget(5000, { used: 0, cycles: 0 });
      const out: string[] = [];
      for (const r of order) {
        if (!budget.fits(r.est)) continue;
        budget.book(r.est);
        out.push(r.id);
      }
      return out;
    };
    expect(admitted(rows)).toEqual(["x", "y"]); // today: BHA is starved
    // the first stale feed gets the used === 0 admission; x (2833 + 2200 > 5000) waits, y (2833 + 1500) fits
    expect(admitted(prioritizeStale(rows, NOW))).toEqual(["bha", "y"]);
  });
});

// ---------------------------------------------------------------------------
// h39-pipeline2-1: #198 put the stale feed first in the START order, but the order
// bodies ARRIVE in is what admission follows: BHA's 4.25 MB body finishes last, after
// the other feeds took 7.17 of the 8 MB and 4,299 of the 5,000 items, so it was refused.
// A stale feed now books its items BEFORE the pool starts (a reservation inside the
// isolate item budget, never above it) and is admitted against the reservation.
// ---------------------------------------------------------------------------

describe("pickStaleReservation", () => {
  const NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const MIN = 60_000;
  const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
  type Src = { id: string; fetch_last_at?: string | null; fetch_items_count?: number | null };

  it("picks the stalest stale source and sizes it from its known item count: bha 1000 -> 1250", () => {
    const rows: Src[] = [
      { id: "fresh", fetch_last_at: ago(1), fetch_items_count: 30 },
      { id: "bha", fetch_last_at: ago(20), fetch_items_count: 1000 },
      { id: "x", fetch_last_at: ago(12), fetch_items_count: 50 },
    ];
    expect(pickStaleReservation(rows, NOW)).toEqual({ id: "bha", items: 1250 });
  });

  it("sizes with the same headroom estimateItems caps at (ceil of count * KNOWN_ITEMS_HEADROOM)", () => {
    const rows: Src[] = [{ id: "a", fetch_last_at: ago(30), fetch_items_count: 7 }];
    expect(KNOWN_ITEMS_HEADROOM).toBe(1.25);
    expect(pickStaleReservation(rows, NOW)).toEqual({ id: "a", items: Math.ceil(7 * KNOWN_ITEMS_HEADROOM) });
    expect(pickStaleReservation(rows, NOW)?.items).toBe(9);
  });

  it("returns null when nothing is stale", () => {
    const rows: Src[] = [
      { id: "a", fetch_last_at: ago(1), fetch_items_count: 100 },
      { id: "b", fetch_last_at: ago(8), fetch_items_count: 100 },
    ];
    expect(pickStaleReservation(rows, NOW)).toBeNull();
  });

  it("returns null for an empty list", () => {
    expect(pickStaleReservation([], NOW)).toBeNull();
  });

  it("returns null when the stale feed has no known item count (null, undefined, 0, a fraction, NaN, negative)", () => {
    for (const count of [null, undefined, 0, 0.5, Number.NaN, -3, Number.POSITIVE_INFINITY]) {
      const rows: Src[] = [{ id: "bha", fetch_last_at: ago(60), fetch_items_count: count }];
      expect(pickStaleReservation(rows, NOW), String(count)).toBeNull();
    }
  });

  it("skips a null, undefined or unparseable fetch_last_at (a bootstrap source is not a starved one)", () => {
    const rows: Src[] = [
      { id: "null", fetch_last_at: null, fetch_items_count: 500 },
      { id: "undef", fetch_items_count: 500 },
      { id: "junk", fetch_last_at: "not a date", fetch_items_count: 500 },
    ];
    expect(pickStaleReservation(rows, NOW)).toBeNull();
  });

  it("a future timestamp (clock skew) counts as fresh", () => {
    const rows: Src[] = [{ id: "skew", fetch_last_at: new Date(NOW + 5 * MIN).toISOString(), fetch_items_count: 500 }];
    expect(pickStaleReservation(rows, NOW)).toBeNull();
  });

  it("the default threshold is three cycle periods: at the edge is fresh, one millisecond over is stale", () => {
    const edge: Src[] = [{ id: "edge", fetch_last_at: new Date(NOW - 3 * CYCLE_PERIOD_MS).toISOString(), fetch_items_count: 10 }];
    const over: Src[] = [{ id: "over", fetch_last_at: new Date(NOW - 3 * CYCLE_PERIOD_MS - 1).toISOString(), fetch_items_count: 10 }];
    expect(pickStaleReservation(edge, NOW)).toBeNull();
    expect(pickStaleReservation(over, NOW)).toEqual({ id: "over", items: 13 });
  });

  it("a bha parsed one reused cycle ago (5.5 minutes old) gets no reservation, which pins its roughly 12-minute cadence", () => {
    // Fresh and reused isolates alternate every 3 minutes: parsed on a fresh one at T0, bha is
    // 5.9 minutes old at T0+6 (the next fresh one), under the 9-minute rule. Lowering the rule would
    // make the stalest-wins pick a small feed the reused isolate deferred at T0+3 instead (it is
    // older than bha by seconds), so the threshold stays and the guide says "about every 12 minutes".
    const rows: Src[] = [{ id: "bha", fetch_last_at: ago(5.5), fetch_items_count: 1000 }];
    expect(pickStaleReservation(rows, NOW)).toBeNull();
    expect(pickStaleReservation([{ id: "bha", fetch_last_at: ago(9.1), fetch_items_count: 1000 }], NOW)).toEqual({ id: "bha", items: 1250 });
  });

  it("takes the threshold as a parameter", () => {
    const rows: Src[] = [{ id: "a", fetch_last_at: ago(5), fetch_items_count: 100 }];
    expect(pickStaleReservation(rows, NOW)).toBeNull();
    expect(pickStaleReservation(rows, NOW, 4 * MIN)).toEqual({ id: "a", items: 125 });
  });

  it("an older stale source without a count does not hide a younger stale one that has one", () => {
    const rows: Src[] = [
      { id: "never-counted", fetch_last_at: ago(300), fetch_items_count: null },
      { id: "bha", fetch_last_at: ago(20), fetch_items_count: 1000 },
    ];
    expect(pickStaleReservation(rows, NOW)).toEqual({ id: "bha", items: 1250 });
  });

  it("ties on age go to the first in input order", () => {
    const rows: Src[] = [
      { id: "first", fetch_last_at: ago(20), fetch_items_count: 100 },
      { id: "second", fetch_last_at: ago(20), fetch_items_count: 900 },
    ];
    expect(pickStaleReservation(rows, NOW)?.id).toBe("first");
  });

  it("does not mutate or reorder its input", () => {
    const rows: Src[] = [
      { id: "a", fetch_last_at: ago(1), fetch_items_count: 5 },
      { id: "b", fetch_last_at: ago(90), fetch_items_count: 5 },
    ];
    const snapshot = JSON.stringify(rows);
    pickStaleReservation(rows, NOW);
    expect(JSON.stringify(rows)).toBe(snapshot);
  });
});

describe("summarizeStale", () => {
  const NOW = Date.parse("2026-11-05T12:00:00.000Z");
  const MIN = 60_000;
  const ago = (minutes: number) => new Date(NOW - minutes * MIN).toISOString();
  type Src = { id: string; fetch_last_at?: string | null };

  it("lists exactly the ids prioritizeStale puts first, and the oldest age in whole minutes", () => {
    const rows: Src[] = [
      { id: "fresh", fetch_last_at: ago(1) },
      { id: "bha", fetch_last_at: ago(11.4) },
      { id: "never", fetch_last_at: null },
      { id: "x", fetch_last_at: ago(12) },
    ];
    const s = summarizeStale(rows, NOW);
    expect([...s.ids].sort()).toEqual(["bha", "never", "x"]);
    expect(s.oldestMin).toBe(12);
    const front = prioritizeStale(rows, NOW).slice(0, s.ids.size).map((r) => r.id);
    expect([...s.ids].sort()).toEqual([...front].sort());
  });

  it("is 0 minutes and no ids when nothing is stale", () => {
    const s = summarizeStale([{ id: "a", fetch_last_at: ago(2) }], NOW);
    expect(s.ids.size).toBe(0);
    expect(s.oldestMin).toBe(0);
    expect(summarizeStale([], NOW)).toEqual({ ids: new Set(), oldestMin: 0 });
  });

  it("a never-polled source is stale but has no age: it counts as an id and leaves oldestMin alone", () => {
    const s = summarizeStale([{ id: "new", fetch_last_at: null }, { id: "ok", fetch_last_at: ago(1) }], NOW);
    expect([...s.ids]).toEqual(["new"]);
    expect(s.oldestMin).toBe(0);
  });

  it("a future timestamp is fresh; the threshold is a parameter", () => {
    expect(summarizeStale([{ id: "skew", fetch_last_at: new Date(NOW + MIN).toISOString() }], NOW).ids.size).toBe(0);
    const s = summarizeStale([{ id: "a", fetch_last_at: ago(5) }], NOW, 4 * MIN);
    expect([...s.ids]).toEqual(["a"]);
    expect(s.oldestMin).toBe(5);
  });
});

describe("createItemBudget().reserve", () => {
  const fresh = (used = 0) => ({ used, cycles: 1 });

  it("books n on a fresh isolate and returns true: 1250 reserved, 3750 left", () => {
    const state = fresh();
    const budget = createItemBudget(5000, state);
    expect(budget.reserve(1250)).toBe(true);
    expect(state.used).toBe(1250);
    expect(budget.used).toBe(1250);
    expect(budget.fits(3800)).toBe(false);
    expect(budget.fits(3750)).toBe(true);
  });

  it("settle gives a reservation back or turns it into the real count", () => {
    const kept = fresh();
    const a = createItemBudget(5000, kept);
    expect(a.reserve(1250)).toBe(true);
    a.settle(1250, 1250);
    expect(kept.used).toBe(1250);

    const released = fresh();
    const b = createItemBudget(5000, released);
    expect(b.reserve(1250)).toBe(true);
    b.settle(1250, 0);
    expect(released.used).toBe(0);
  });

  it("refuses, and books nothing, when used + n would pass the limit", () => {
    const state = fresh(4300);
    const budget = createItemBudget(5000, state);
    expect(budget.reserve(1250)).toBe(false);
    expect(state.used).toBe(4300);
  });

  it("books up to the limit exactly, never past it, and has no used === 0 exception", () => {
    const state = fresh();
    const budget = createItemBudget(5000, state);
    expect(budget.reserve(5001)).toBe(false); // fits() would admit this on a fresh isolate; reserve must not
    expect(state.used).toBe(0);
    expect(budget.reserve(5000)).toBe(true);
    expect(state.used).toBe(5000);
    expect(budget.reserve(1)).toBe(false);
    expect(state.used).toBe(5000);
  });

  it("refuses a negative, NaN or infinite size and leaves the state alone", () => {
    const state = fresh(10);
    const budget = createItemBudget(5000, state);
    for (const n of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(budget.reserve(n), String(n)).toBe(false);
      expect(state.used).toBe(10);
    }
  });

  it("two cycles on one isolate share it: a reservation counts against the next cycle's budget too", () => {
    const state = fresh();
    expect(createItemBudget(5000, state).reserve(1250)).toBe(true);
    expect(createItemBudget(5000, state).reserve(3751)).toBe(false);
    expect(createItemBudget(5000, state).reserve(3750)).toBe(true);
  });

  it("a held reservation never lets the isolate book more than the limit in total", () => {
    const state = fresh();
    const budget = createItemBudget(5000, state);
    expect(budget.reserve(1250)).toBe(true);
    let booked = 0;
    for (let i = 0; i < 10; i++) {
      if (budget.fits(717)) {
        budget.book(717);
        booked += 717;
      }
      expect(state.used).toBeLessThanOrEqual(5000);
    }
    expect(booked).toBe(5 * 717); // 1250 + 5 * 717 = 4835; a sixth would be 5552
    // the reserved feed takes its 1250 back out of the reservation and may grow into what is left
    budget.settle(1250, 1250);
    expect(state.used).toBe(4835);
    expect(state.used).toBeLessThanOrEqual(5000);
  });
});

describe("createParseBudget().admit with a reservation", () => {
  it("admits a reserved feed past the byte budget: 7.2 MB in, then BHA's 4.25 MB", () => {
    const b = createParseBudget(55, 8_000_000);
    expect(b.admit(7_200_000)).toBe(true);
    expect(b.admit(4_250_000)).toBe(false); // today
    expect(b.admit(4_250_000, false, true)).toBe(true); // reserved
    // the bytes and the parse still count
    expect(b.bytes).toBe(11_450_000);
    expect(b.parses).toBe(2);
  });

  it("leaves the priority overshoot slot untouched", () => {
    const b = createParseBudget(55, 8_000_000);
    expect(b.admit(7_200_000)).toBe(true);
    expect(b.admit(4_250_000, false, true)).toBe(true);
    expect(b.admit(4_000_000, true)).toBe(true); // the one priority overshoot is still there
    expect(b.admit(4_000_000, true)).toBe(false); // and now it is spent
  });

  it("never bypasses maxParses", () => {
    const b = createParseBudget(2, 8_000_000);
    expect(b.admit(10)).toBe(true);
    expect(b.admit(10)).toBe(true);
    expect(b.admit(10, false, true)).toBe(false);
    expect(b.admit(10, true, true)).toBe(false);
    expect(b.parses).toBe(2);
    expect(b.bytes).toBe(20);
  });

  it("with maxParses 0 refuses even a reserved feed", () => {
    const b = createParseBudget(0, 8_000_000);
    expect(b.admit(1, false, true)).toBe(false);
    expect(b.parses).toBe(0);
  });

  it("is off by default: admit(bytes) and admit(bytes, priority) behave as before", () => {
    const b = createParseBudget(55, 1_000);
    expect(b.admit(900)).toBe(true);
    expect(b.admit(500)).toBe(false);
    expect(b.admit(500, false, false)).toBe(false);
    expect(b.bytes).toBe(900);
  });
});

describe("a stale feed whose body arrives last on a busy fresh isolate [h39-pipeline2-1]", () => {
  // The #198 order tests fed admission in START order. Admission follows ARRIVAL order: the
  // small feeds finish first, BHA's 4.25 MB last.
  const LIMIT = 5000;
  const small = Array.from({ length: 6 }, (_, i) => ({ id: `s${i}`, bytes: 1_200_000, est: 717 }));
  const bha = { id: "bha", bytes: 4_250_000, est: 1250 };

  function simulate(reserve: boolean): { admitted: string[]; deferred: string[]; used: number; bytes: number } {
    const state = { used: 0, cycles: 1 };
    const items = createItemBudget(LIMIT, state);
    const parse = createParseBudget(55, 8_000_000);
    const reserved = reserve ? items.reserve(1250) : false;
    const admitted: string[] = [];
    const deferred: string[] = [];
    for (const f of [...small, bha]) {
      const isBha = f.id === "bha";
      if (isBha && reserved) {
        if (!parse.admit(f.bytes, false, true)) {
          deferred.push(f.id);
          items.settle(1250, 0);
          continue;
        }
        items.settle(1250, f.est);
        admitted.push(f.id);
        continue;
      }
      if (!items.fits(f.est) || !parse.admit(f.bytes)) {
        deferred.push(f.id);
        continue;
      }
      items.book(f.est);
      admitted.push(f.id);
    }
    return { admitted, deferred, used: state.used, bytes: parse.bytes };
  }

  it("without a reservation (today) BHA is refused by both budgets", () => {
    const r = simulate(false);
    expect(r.deferred).toContain("bha");
    expect(r.admitted).toHaveLength(6);
  });

  it("with the reservation BHA is admitted, a small feed waits instead, and the isolate stays at or under 5000 items", () => {
    const r = simulate(true);
    expect(r.admitted).toContain("bha");
    expect(r.deferred).toEqual(["s5"]);
    expect(r.used).toBeLessThanOrEqual(LIMIT);
    expect(r.used).toBe(5 * 717 + 1250);
  });
});

describe("reserveItemsFor: one reservation, released exactly once", () => {
  const fresh = (used = 0) => ({ used, cycles: 1 });
  const bha = { id: "bha", items: 1250 };

  it("holds the items for the picked feed only", () => {
    const state = fresh();
    const r = reserveItemsFor(createItemBudget(5000, state), bha);
    expect(r.state).toBe("held");
    expect(state.used).toBe(1250);
    expect(r.heldFor("bha")).toBe(1250);
    expect(r.heldFor("someone-else")).toBe(0);
  });

  it("makes no reservation without a pick, or when the room is not there (a reused, busy isolate)", () => {
    const s1 = fresh();
    const none = reserveItemsFor(createItemBudget(5000, s1), null);
    expect(none.state).toBe("none");
    expect(none.heldFor("bha")).toBe(0);
    expect(none.release()).toBe(false);
    expect(s1.used).toBe(0);

    const s2 = fresh(4300);
    const busy = reserveItemsFor(createItemBudget(5000, s2), bha);
    expect(busy.state).toBe("none");
    expect(busy.heldFor("bha")).toBe(0);
    expect(busy.consume(1250)).toBe(false);
    expect(busy.release()).toBe(false);
    expect(s2.used).toBe(4300);
  });

  it("never holds more than the limit, even for a feed alone on a fresh isolate", () => {
    const state = fresh();
    const r = reserveItemsFor(createItemBudget(5000, state), { id: "huge", items: 6000 });
    expect(r.state).toBe("none");
    expect(state.used).toBe(0);
  });

  it("consume turns the reservation into a booking of the estimate and releases nothing afterwards", () => {
    const state = fresh();
    const r = reserveItemsFor(createItemBudget(5000, state), bha);
    expect(r.consume(1100)).toBe(true);
    expect(r.state).toBe("consumed");
    expect(state.used).toBe(1100);
    expect(r.heldFor("bha")).toBe(0);
    expect(r.release()).toBe(false); // the feed's parse owns the booking now
    expect(state.used).toBe(1100);
    expect(r.consume(1100)).toBe(false);
  });

  it("consume may exceed the reservation: the booking is the estimate", () => {
    const state = fresh();
    const r = reserveItemsFor(createItemBudget(5000, state), bha);
    expect(r.consume(1400)).toBe(true);
    expect(state.used).toBe(1400);
  });

  it("release gives the items back, once: a second and third call change nothing", () => {
    const state = fresh(300);
    const r = reserveItemsFor(createItemBudget(5000, state), bha);
    expect(state.used).toBe(1550);
    expect(r.release()).toBe(true);
    expect(state.used).toBe(300);
    expect(r.state).toBe("released");
    expect(r.release()).toBe(false);
    expect(r.release()).toBe(false);
    expect(state.used).toBe(300);
    expect(r.heldFor("bha")).toBe(0);
    expect(r.consume(1000)).toBe(false);
    expect(state.used).toBe(300);
  });

  it("a release after other feeds settled in between takes back exactly its own items", () => {
    const state = fresh();
    const budget = createItemBudget(5000, state);
    const r = reserveItemsFor(budget, bha);
    budget.book(717);
    budget.settle(717, 400); // a small feed parsed fewer items than estimated
    expect(state.used).toBe(1650);
    r.release();
    expect(state.used).toBe(400);
  });
});
