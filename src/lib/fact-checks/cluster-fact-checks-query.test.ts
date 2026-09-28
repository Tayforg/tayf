import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts),
// mirroring src/lib/clusters/search-query.test.ts's next/cache mock + fixture
// shape.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  throwOnQuery: false,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_fact_checks: (state: unknown) => {
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        return { data: fixture.error ? null : fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { getClusterFactChecks } from "./cluster-fact-checks-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.FACT_CHECK_BOX;
  fixture.data = [];
  fixture.error = null;
  fixture.throwOnQuery = false;
  fixture.lastState = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "FACT_CHECK_BOX"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

const OBJECT_ROW = {
  score: 0.7,
  fact_checks: {
    id: "fc-1",
    publisher: "teyit",
    url: "https://teyit.org/analiz/x",
    title: "Bir iddianın analizi",
    published_at: "2026-09-27T10:00:00Z",
    is_published: true,
  },
};

const ARRAY_ROW = {
  score: 0.65,
  fact_checks: [
    {
      id: "fc-2",
      publisher: "malumatfurus",
      url: "https://www.malumatfurus.org/bir-yazi/",
      title: "Başka bir analiz",
      published_at: "2026-09-26T10:00:00Z",
      is_published: true,
    },
  ],
};

describe("getClusterFactChecks", () => {
  it("records eq(is_published,true) on both sides and limit(3)", async () => {
    fixture.data = [OBJECT_ROW];
    await getClusterFactChecks("c1");
    const state = fixture.lastState as BuilderState;
    expect(state.eq).toEqual(
      expect.arrayContaining([
        { col: "cluster_id", val: "c1" },
        { col: "is_published", val: true },
        { col: "fact_checks.is_published", val: true },
      ]),
    );
    expect(state.limit).toBe(3);
  });

  it("maps the object embed shape", async () => {
    fixture.data = [OBJECT_ROW];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      id: "fc-1",
      publisher: "teyit",
      publisherLabel: "Teyit",
      url: "https://teyit.org/analiz/x",
      title: "Bir iddianın analizi",
      score: 0.7,
    });
    expect(result[0]!.dateLabel).toMatch(/2026/);
  });

  it("maps the array embed shape", async () => {
    fixture.data = [ARRAY_ROW];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(1);
    expect(result[0]!.publisher).toBe("malumatfurus");
  });

  it("drops a disallowed url at read time (defence in depth)", async () => {
    fixture.data = [
      {
        score: 0.8,
        fact_checks: {
          id: "fc-bad",
          publisher: "teyit",
          url: "https://evil.example.com/x",
          title: "Kötü url",
          published_at: "2026-09-27T10:00:00Z",
          is_published: true,
        },
      },
    ];
    const result = await getClusterFactChecks("c1");
    expect(result).toHaveLength(0);
  });

  it("throws inside the cached fn on error, while the wrapper returns []", async () => {
    fixture.error = { message: "relation \"cluster_fact_checks\" does not exist" };
    const result = await getClusterFactChecks("c1");
    expect(result).toEqual([]);
  });

  it("swallows an unexpected throw (e.g. connection reset) to []", async () => {
    fixture.throwOnQuery = true;
    const result = await getClusterFactChecks("c1");
    expect(result).toEqual([]);
  });

  it("FACT_CHECK_BOX=off returns [] with no from() call", async () => {
    process.env.FACT_CHECK_BOX = "off";
    fixture.data = [OBJECT_ROW];
    fixture.lastState = null;
    const result = await getClusterFactChecks("c1");
    expect(result).toEqual([]);
    expect(fixture.lastState).toBeNull();
  });
});
