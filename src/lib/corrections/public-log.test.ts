import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// S-18 (/duzeltmeler). Mirrors src/lib/quality/snapshots.test.ts: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) plus a mocked
// next/cache so the "use cache" directive's cacheLife/cacheTag calls don't
// throw outside a real Next.js request scope.
//
// The privacy contract is the point of this suite: the reader's `message`
// and `email` columns must never leave the database, so the select string is
// pinned both as a constant and as the value the fake actually recorded.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
  throwOnQuery: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      corrections: (state) => {
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.data, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getPublicCorrections, PUBLIC_LOG_SELECT } from "./public-log";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  fixture.throwOnQuery = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
});

function state(): BuilderState {
  return fixture.lastState as BuilderState;
}

describe("PUBLIC_LOG_SELECT", () => {
  it("never selects the reader's email or message", () => {
    expect(PUBLIC_LOG_SELECT).not.toMatch(/email|message/);
  });

  it("selects only the public columns plus the cluster embed", () => {
    expect(PUBLIC_LOG_SELECT).toContain("id");
    expect(PUBLIC_LOG_SELECT).toContain("cluster_id");
    expect(PUBLIC_LOG_SELECT).toContain("created_at");
    expect(PUBLIC_LOG_SELECT).toContain("reviewed_at");
    expect(PUBLIC_LOG_SELECT).toContain("clusters");
  });
});

describe("getPublicCorrections", () => {
  it("queries only reviewed corrections, newest review first, capped at 100", async () => {
    await getPublicCorrections();

    expect(state().table).toBe("corrections");
    expect(state().eq).toEqual([{ col: "status", val: "reviewed" }]);
    expect(state().order).toEqual([
      { col: "reviewed_at", opts: { ascending: false, nullsFirst: false } },
      { col: "created_at", opts: { ascending: false } },
    ]);
    expect(state().limit).toBe(100);
  });

  it("sorts un-stamped (pre-042) reviewed rows last, not first", async () => {
    // Postgres defaults DESC to NULLS FIRST; without nullsFirst: false a
    // pre-042 row with a null `reviewed_at` would head the page.
    await getPublicCorrections();

    const reviewedAt = state().order.find((o) => o.col === "reviewed_at");
    expect(
      (reviewedAt?.opts as { nullsFirst?: boolean } | undefined)?.nullsFirst,
    ).toBe(false);
    // ...and the tiebreak keeps the order stable for equal stamps.
    expect(state().order[1]?.col).toBe("created_at");
  });

  it("honours an explicit limit", async () => {
    await getPublicCorrections(5);

    expect(state().limit).toBe(5);
  });

  it("never sends email or message over the wire", async () => {
    await getPublicCorrections();

    const recorded = String(state().selectArgs[0]);
    expect(recorded).toBe(PUBLIC_LOG_SELECT);
    expect(recorded).not.toMatch(/email|message/);
  });

  it("maps rows when the cluster embed comes back as an object", async () => {
    fixture.data = [
      {
        id: "c1",
        cluster_id: "k1",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-11T09:30:00.000Z",
        cluster: {
          id: "k1",
          title_tr: "Ham başlık",
          title_tr_neutral: "Nötr başlık",
        },
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "c1",
        clusterId: "k1",
        clusterTitle: "Nötr başlık",
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: "2026-09-11T09:30:00.000Z",
      },
    ]);
  });

  it("maps rows when the cluster embed comes back as a one-element array", async () => {
    fixture.data = [
      {
        id: "c2",
        cluster_id: "k2",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: null,
        cluster: [{ id: "k2", title_tr: "Ham başlık", title_tr_neutral: null }],
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "c2",
        clusterId: "k2",
        clusterTitle: "Ham başlık",
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: null,
      },
    ]);
  });

  it("returns a null title and null clusterId when the cluster is gone", async () => {
    fixture.data = [
      {
        id: "c3",
        cluster_id: null,
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-12T10:00:00.000Z",
        cluster: null,
      },
    ];

    const rows = await getPublicCorrections();

    expect(rows).toEqual([
      {
        id: "c3",
        clusterId: null,
        clusterTitle: null,
        createdAt: "2026-09-10T08:00:00.000Z",
        reviewedAt: "2026-09-12T10:00:00.000Z",
      },
    ]);
  });

  it("drops the reader's message and email even if PostgREST returns them", async () => {
    fixture.data = [
      {
        id: "c4",
        cluster_id: "k4",
        created_at: "2026-09-10T08:00:00.000Z",
        reviewed_at: "2026-09-12T10:00:00.000Z",
        message: "başlık yanlış, kaynak şu",
        email: "okur@example.com",
        cluster: { id: "k4", title_tr: "Ham", title_tr_neutral: "Nötr" },
      },
    ];

    const rows = await getPublicCorrections();

    expect(JSON.stringify(rows)).not.toMatch(/okur@example\.com|yanlış/);
    expect(Object.keys(rows![0])).toEqual([
      "id",
      "clusterId",
      "clusterTitle",
      "createdAt",
      "reviewedAt",
    ]);
  });

  it("returns an empty array when there is nothing reviewed yet", async () => {
    fixture.data = [];

    await expect(getPublicCorrections()).resolves.toEqual([]);
  });

  it("returns an empty array when PostgREST returns null data without an error", async () => {
    fixture.data = [];
    fixture.error = null;

    await expect(getPublicCorrections()).resolves.toEqual([]);
  });

  it("returns null (never throws) when the query errors", async () => {
    fixture.error = { message: "permission denied for table corrections" };

    await expect(getPublicCorrections()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("returns null (never throws) when the client blows up", async () => {
    fixture.throwOnQuery = true;

    await expect(getPublicCorrections()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });
});
