import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mirrors src/lib/sources/active-count.test.ts's harness: the shared
// chainable Supabase fake (tests/_helpers/supabase-fake.ts) plus a mocked
// next/cache so the "use cache" directive's cacheLife/cacheTag calls don't
// throw outside a real Next.js request scope.
//
// getNeutralizedStatus() issues two head-count queries against the same
// `clusters` table (eligible, then eligible+neutralized) — the fixture
// resolver below distinguishes them by whether `.not("title_neutral_at", ...)`
// was chained, and returns the configured count for each branch.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  eligibleCount: 0,
  neutralizedCount: 0,
  error: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        if (fixture.error) return { data: null, error: fixture.error };
        const isNeutralizedQuery = state.not.some(
          (n) => n.col === "title_neutral_at",
        );
        const count = isNeutralizedQuery
          ? fixture.neutralizedCount
          : fixture.eligibleCount;
        return { data: [], error: null, count };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getNeutralizedStatus } from "./status";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.eligibleCount = 0;
  fixture.neutralizedCount = 0;
  fixture.error = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getNeutralizedStatus", () => {
  it("returns {neutralized: 0, eligible: N} when nothing has been rewritten yet", async () => {
    fixture.eligibleCount = 12;
    fixture.neutralizedCount = 0;

    await expect(getNeutralizedStatus()).resolves.toEqual({
      eligible: 12,
      neutralized: 0,
    });
  });

  it("returns the live counts once some clusters have been rewritten", async () => {
    fixture.eligibleCount = 12;
    fixture.neutralizedCount = 5;

    await expect(getNeutralizedStatus()).resolves.toEqual({
      eligible: 12,
      neutralized: 5,
    });
  });

  it("returns null (never throws) on a Supabase query error", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getNeutralizedStatus()).resolves.toBeNull();
  });

  it("returns null (never throws) when Supabase env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getNeutralizedStatus()).resolves.toBeNull();
  });
});
