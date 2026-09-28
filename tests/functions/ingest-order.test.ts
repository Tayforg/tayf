import { describe, expect, it, vi } from "vitest";
import {
  CYCLE_PERIOD_MS,
  groupChunkBySource,
  interleaveBySource,
  rotateForCycle,
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
