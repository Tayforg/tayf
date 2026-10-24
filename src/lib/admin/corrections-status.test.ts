import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// /admin "Düzeltme bildirimleri" reader. The old reader took the newest 50
// rows regardless of status, so the 51st-oldest OPEN report was invisible and
// the attention tile capped at "50". It now pages the OPEN rows oldest first
// (so nothing starves behind newer reports) and keeps a small separate window
// of recently closed rows.
//
// The Supabase fake does not execute queries, so this file evaluates the
// recorded builder state (filters, orders, range, limit) against an in-memory
// table: the assertions prove that the QUERY the reader built yields the right
// rows, not merely that certain methods were called.

interface Row {
  id: string;
  status: string;
  created_at: string;
  reviewed_at: string | null;
  url: string;
  message: string;
  email: string | null;
}

const fixture = vi.hoisted(() => ({
  rows: [] as Row[],
  states: [] as unknown[],
  failWith: null as
    | null
    | ((state: import("../../../tests/_helpers/supabase-fake").BuilderState) => unknown),
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  type State = import("../../../tests/_helpers/supabase-fake").BuilderState;

  function run(state: State) {
    fixture.states.push(state);
    const injected = fixture.failWith?.(state);
    if (injected) return injected as never;

    let rows = fixture.rows.slice();
    for (const f of state.in) {
      rows = rows.filter((r) => f.vals.includes((r as unknown as Record<string, unknown>)[f.col]));
    }
    for (const f of state.not) {
      if (f.op === "in") {
        const list = String(f.val).replace(/^\(|\)$/g, "").split(",");
        rows = rows.filter((r) => !list.includes(String((r as unknown as Record<string, unknown>)[f.col])));
      }
    }
    const total = rows.length;
    // The FIRST .order() is the primary key, so sort by the later ones first
    // (Array.prototype.sort is stable).
    for (const o of [...state.order].reverse()) {
      const asc = (o.opts as { ascending?: boolean } | undefined)?.ascending !== false;
      rows.sort((a, b) => {
        const av = String((a as unknown as Record<string, unknown>)[o.col]);
        const bv = String((b as unknown as Record<string, unknown>)[o.col]);
        return (av < bv ? -1 : av > bv ? 1 : 0) * (asc ? 1 : -1);
      });
    }
    if (state.range) rows = rows.slice(state.range.from, state.range.to + 1);
    if (state.limit !== null) rows = rows.slice(0, state.limit);
    const exact = (state.selectArgs[1] as { count?: string } | undefined)?.count === "exact";
    return { data: rows, error: null, count: exact ? total : undefined };
  }

  return helper.createSupabaseFake({ tables: { corrections: run } });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import {
  CORRECTIONS_CLOSED_LIMIT,
  CORRECTIONS_LIMIT,
  CORRECTIONS_MAX_PAGE,
  OPEN_CORRECTION_STATUSES,
  getCorrectionsPage,
  parseCorrectionsPage,
} from "./corrections-status";

const ORIGINAL_ENV = { ...process.env };

function pad(n: number, w = 3): string {
  return String(n).padStart(w, "0");
}

/** i = 1 is the OLDEST. Statuses alternate open/new so both legacy and current open rows exist. */
function openRow(i: number): Row {
  return {
    id: `open-${pad(i)}`,
    status: i % 2 === 0 ? "open" : "new",
    created_at: `2026-01-01T00:${pad(Math.floor(i / 60), 2)}:${pad(i % 60, 2)}Z`,
    reviewed_at: null,
    url: `https://example.com/${i}`,
    message: `open message ${i}`,
    email: i % 5 === 0 ? `reader${i}@example.com` : null,
  };
}

function closedRow(i: number): Row {
  return {
    id: `closed-${pad(i)}`,
    status: i % 2 === 0 ? "reviewed" : "dismissed",
    // Older than every open row, spread over days: i = 7 is the newest closed.
    created_at: `2025-12-${pad(i, 2)}T09:00:00Z`,
    reviewed_at: `2025-12-${pad(i, 2)}T10:00:00Z`,
    url: `https://example.com/closed/${i}`,
    message: `closed message ${i}`,
    email: null,
  };
}

/** Deterministic shuffle so the reader's ORDER BY, not the fixture order, decides the result. */
function shuffled<T>(items: T[]): T[] {
  const out = items.slice();
  let seed = 12345;
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

function seed(openCount = 120, closedCount = 7) {
  const rows = [
    ...Array.from({ length: openCount }, (_, k) => openRow(k + 1)),
    ...Array.from({ length: closedCount }, (_, k) => closedRow(k + 1)),
  ];
  fixture.rows = shuffled(rows);
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.rows = [];
  fixture.states = [];
  fixture.failWith = null;
  seed();
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
});

describe("constants", () => {
  it("pages 50 open rows, shows up to 20 closed, and caps the page number at 1000", () => {
    expect(CORRECTIONS_LIMIT).toBe(50);
    expect(CORRECTIONS_CLOSED_LIMIT).toBe(20);
    expect(CORRECTIONS_MAX_PAGE).toBe(1000);
    expect([...OPEN_CORRECTION_STATUSES]).toEqual(["open", "new"]);
  });
});

describe("getCorrectionsPage", () => {
  it("page 1: the 50 OLDEST open rows, ascending, with the exact open total and page count", async () => {
    const r = await getCorrectionsPage(1);

    expect(r).not.toBeNull();
    expect(r!.page).toBe(1);
    expect(r!.openTotal).toBe(120);
    expect(r!.pageCount).toBe(3);
    expect(r!.open).toHaveLength(50);
    expect(r!.open.map((c) => c.id)).toEqual(
      Array.from({ length: 50 }, (_, k) => `open-${pad(k + 1)}`),
    );
    const times = r!.open.map((c) => c.created_at);
    expect(times).toEqual([...times].sort());
    // Only open/new rows ever land in `open`.
    expect(r!.open.every((c) => c.status === "open" || c.status === "new")).toBe(true);
  });

  it("page 1: at most 20 closed rows, newest first, and no open row among them", async () => {
    const r = await getCorrectionsPage(1);

    expect(r!.closed).toHaveLength(7);
    expect(r!.closed.map((c) => c.id)).toEqual([
      "closed-007",
      "closed-006",
      "closed-005",
      "closed-004",
      "closed-003",
      "closed-002",
      "closed-001",
    ]);
    expect(r!.closed.every((c) => c.status !== "open" && c.status !== "new")).toBe(true);
  });

  it("caps the closed window at 20 when more exist", async () => {
    seed(10, 45);
    const r = await getCorrectionsPage(1);
    expect(r!.closed).toHaveLength(20);
  });

  it("page 2: rows 51-100 of the open list", async () => {
    const r = await getCorrectionsPage(2);

    expect(r!.page).toBe(2);
    expect(r!.openTotal).toBe(120);
    expect(r!.pageCount).toBe(3);
    expect(r!.open.map((c) => c.id)).toEqual(
      Array.from({ length: 50 }, (_, k) => `open-${pad(k + 51)}`),
    );
  });

  it("the last page holds the remainder (rows 101-120)", async () => {
    const r = await getCorrectionsPage(3);
    expect(r!.open.map((c) => c.id)).toEqual(
      Array.from({ length: 20 }, (_, k) => `open-${pad(k + 101)}`),
    );
  });

  it("every open row appears on exactly one page (nothing starves)", async () => {
    const seen: string[] = [];
    for (const page of [1, 2, 3]) {
      const r = await getCorrectionsPage(page);
      seen.push(...r!.open.map((c) => c.id));
    }
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it("breaks created_at ties by id so a page boundary is stable", async () => {
    const twin = { ...openRow(1), id: "open-000" };
    fixture.rows = shuffled([...fixture.rows, twin]);
    const r = await getCorrectionsPage(1);
    expect(r!.open[0]?.id).toBe("open-000");
    expect(r!.open[1]?.id).toBe("open-001");
  });

  it("builds an exact-count, status-filtered, oldest-first, id-tiebroken range query", async () => {
    await getCorrectionsPage(2);

    const states = fixture.states as BuilderState[];
    const open = states.find((s) => s.in.some((f) => f.col === "status"))!;
    expect(open.table).toBe("corrections");
    expect(String(open.selectArgs[0]).split(",").map((c) => c.trim())).toEqual([
      "id",
      "status",
      "created_at",
      "reviewed_at",
      "url",
      "message",
      "email",
    ]);
    expect(open.selectArgs[1]).toEqual({ count: "exact" });
    expect(open.in).toEqual([{ col: "status", vals: ["open", "new"] }]);
    expect(open.order).toEqual([
      { col: "created_at", opts: { ascending: true } },
      { col: "id", opts: { ascending: true } },
    ]);
    expect(open.range).toEqual({ from: 50, to: 99 });

    const closed = states.find((s) => s.not.length > 0)!;
    expect(closed.not).toEqual([{ col: "status", op: "in", val: "(open,new)" }]);
    expect(closed.order).toEqual([{ col: "created_at", opts: { ascending: false } }]);
    expect(closed.limit).toBe(20);
  });

  it("an empty table is a valid empty page, not an error", async () => {
    fixture.rows = [];
    const r = await getCorrectionsPage(1);
    expect(r).toEqual({ open: [], openTotal: 0, page: 1, pageCount: 1, closed: [] });
  });

  it("only closed rows: openTotal 0 with the closed window still returned", async () => {
    seed(0, 3);
    const r = await getCorrectionsPage(1);
    expect(r!.openTotal).toBe(0);
    expect(r!.open).toEqual([]);
    expect(r!.closed).toHaveLength(3);
    expect(r!.pageCount).toBe(1);
  });

  it("a PGRST103 (range not satisfiable) retries ONCE as page 1 and reports page 1", async () => {
    fixture.failWith = (state) =>
      state.range && state.range.from >= 120
        ? { data: null, error: { code: "PGRST103", message: "Requested range not satisfiable" } }
        : null;

    const r = await getCorrectionsPage(9);

    expect(r).not.toBeNull();
    expect(r!.page).toBe(1);
    expect(r!.open[0]?.id).toBe("open-001");
    const openQueries = (fixture.states as BuilderState[]).filter((s) =>
      s.in.some((f) => f.col === "status"),
    );
    expect(openQueries.map((s) => s.range)).toEqual([
      { from: 400, to: 449 },
      { from: 0, to: 49 },
    ]);
  });

  it("an empty page past the end (200 with no rows) also falls back to page 1", async () => {
    const r = await getCorrectionsPage(7);
    expect(r!.page).toBe(1);
    expect(r!.open).toHaveLength(50);
  });

  it("does not retry a PGRST103 on page 1 itself (returns null, never loops)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.failWith = () => ({
      data: null,
      error: { code: "PGRST103", message: "Requested range not satisfiable" },
    });

    await expect(getCorrectionsPage(1)).resolves.toBeNull();
    const openQueries = (fixture.states as BuilderState[]).filter((s) =>
      s.in.some((f) => f.col === "status"),
    );
    expect(openQueries).toHaveLength(1);
  });

  it("any other error returns null without retrying", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.failWith = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });

    await expect(getCorrectionsPage(2)).resolves.toBeNull();
    const openQueries = (fixture.states as BuilderState[]).filter((s) =>
      s.in.some((f) => f.col === "status"),
    );
    expect(openQueries).toHaveLength(1);
  });

  it("an error on the closed query alone also returns null (never a half-page)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.failWith = (state) =>
      state.not.length > 0
        ? { data: null, error: { code: "57014", message: "statement timeout" } }
        : null;

    await expect(getCorrectionsPage(1)).resolves.toBeNull();
  });

  it("a missing exact count is unreadable, not a guess", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.failWith = (state) =>
      state.in.length > 0 ? { data: [], error: null, count: null } : null;

    await expect(getCorrectionsPage(1)).resolves.toBeNull();
  });

  it("never throws: a missing env var or a thrown client error yields null", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    await expect(getCorrectionsPage(1)).resolves.toBeNull();
  });

  it("never logs a row, a message or an e-mail address when it fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.failWith = () => ({ data: null, error: { code: "57014", message: "statement timeout" } });

    await getCorrectionsPage(1);

    const logged = JSON.stringify(spy.mock.calls);
    expect(logged).not.toContain("@example.com");
    expect(logged).not.toContain("open message");
  });

  it("clamps a nonsensical page argument to a valid range", async () => {
    const r = await getCorrectionsPage(0);
    expect(r!.page).toBe(1);
    const nan = await getCorrectionsPage(Number.NaN);
    expect(nan!.page).toBe(1);
  });
});

describe("parseCorrectionsPage", () => {
  it("parses a plain positive integer", () => {
    expect(parseCorrectionsPage("2")).toBe(2);
    expect(parseCorrectionsPage("1")).toBe(1);
  });

  it("falls back to page 1 for anything that is not a positive integer string", () => {
    expect(parseCorrectionsPage(undefined)).toBe(1);
    expect(parseCorrectionsPage("x")).toBe(1);
    expect(parseCorrectionsPage("-1")).toBe(1);
    expect(parseCorrectionsPage("0")).toBe(1);
    expect(parseCorrectionsPage("")).toBe(1);
    expect(parseCorrectionsPage("2.5")).toBe(1);
    expect(parseCorrectionsPage("1e3")).toBe(1);
    expect(parseCorrectionsPage(["2", "3"])).toBe(1);
  });

  it("caps at CORRECTIONS_MAX_PAGE", () => {
    expect(parseCorrectionsPage("5000")).toBe(1000);
    expect(parseCorrectionsPage("1000")).toBe(1000);
    expect(parseCorrectionsPage("1001")).toBe(1000);
    expect(parseCorrectionsPage("99999999999999999999999")).toBe(1000);
  });
});
