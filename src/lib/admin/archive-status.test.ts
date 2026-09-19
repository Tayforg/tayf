import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// M-10 admin card. Mirrors src/lib/quality/snapshots.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts). No next/cache
// mock here — getRecentArchiveExports is a plain async fetcher on purpose
// (the /admin page is cookie-gated and dynamic, so it must never be
// "use cache").

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  nullData: false,
  error: null as { message: string } | null,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      archive_exports: (state) => {
        fixture.lastState = state;
        if (fixture.error) return { data: null, error: fixture.error };
        if (fixture.nullData) return { data: null, error: null };
        return { data: fixture.data, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getRecentArchiveExports, type ArchiveExportRow } from "./archive-status";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.nullData = false;
  fixture.error = null;
  fixture.lastState = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

function row(overrides: Partial<ArchiveExportRow> = {}): ArchiveExportRow {
  return {
    day: "2026-09-18",
    object_path: "2026/09/18",
    sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    rows: 1420,
    bytes: 384_512,
    created_at: "2026-09-19T03:40:12.000Z",
    ...overrides,
  };
}

describe("getRecentArchiveExports", () => {
  it("passes the ledger rows through unchanged", async () => {
    fixture.data = [row({ day: "2026-09-18" }), row({ day: "2026-09-17" })];

    const result = await getRecentArchiveExports();

    expect(result).toHaveLength(2);
    expect(result![0]!.day).toBe("2026-09-18");
    expect(result![0]!.rows).toBe(1420);
    expect(result![0]!.bytes).toBe(384_512);
    expect(result![1]!.day).toBe("2026-09-17");
  });

  it("returns [] (not null) when no export has run yet", async () => {
    fixture.data = [];

    await expect(getRecentArchiveExports()).resolves.toEqual([]);
  });

  it("returns [] when Supabase hands back a null data payload with no error", async () => {
    fixture.nullData = true;

    await expect(getRecentArchiveExports()).resolves.toEqual([]);
  });

  it("returns null (never throws) on a query error, and logs a PII-free message", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.error = { message: "relation \"archive_exports\" does not exist" };

    await expect(getRecentArchiveExports()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalledWith(
      '[admin] archive exports unavailable: relation "archive_exports" does not exist',
    );

    errorSpy.mockRestore();
  });

  it("returns null (never throws) when the Supabase env vars are missing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getRecentArchiveExports()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it("pins the query shape: table, selected columns, day desc order, limit 7", async () => {
    await getRecentArchiveExports();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("archive_exports");

    const select = String(state.selectArgs[0] ?? "");
    for (const col of ["day", "object_path", "sha256", "rows", "bytes", "created_at"]) {
      expect(select).toContain(col);
    }
    expect(select).not.toContain("*");

    expect(state.order).toEqual([{ col: "day", opts: { ascending: false } }]);
    expect(state.limit).toBe(7);
  });

  it("honours an explicit limit", async () => {
    await getRecentArchiveExports(3);

    expect((fixture.lastState as BuilderState).limit).toBe(3);
  });
});
