import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// New coverage — no test file existed for blindspots-query.ts before.
// Harness mirrors search-query.test.ts's shared-fake wiring.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getBlindspots } from "./blindspots-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getBlindspots query shape", () => {
  it("excludes archived clusters and keeps the documented blindspot pre-filters", async () => {
    await getBlindspots();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("clusters");
    // Two boolean-flag predicates: is_blindspot (existing) + is_archived (new).
    expect(state.eq).toHaveLength(2);
    expect(state.eq).toContainEqual({ col: "is_blindspot", val: true });
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.gte).toEqual([{ col: "article_count", val: 3 }]);
    expect(state.lt[0]?.col).toBe("first_published");
    expect(state.order).toEqual([
      { col: "updated_at", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(200);
  });
});
