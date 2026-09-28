import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Harness mirrors timeline-query.test.ts: next/cache is a no-op and the
// shared chainable Supabase fake stands in for PostgREST.

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[] | null,
  error: null as { message: string } | null,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_articles: (state: unknown) => {
        fixture.lastState = state;
        return { data: fixture.data, error: fixture.error };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { fetchMemberSeenAt, getMemberSeenAt } from "./story-timeline-query";
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
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("fetchMemberSeenAt", () => {
  it("queries cluster_articles for one cluster with the articles(created_at) embed", async () => {
    await fetchMemberSeenAt("c1");
    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("cluster_articles");
    expect(String(state.selectArgs[0]).replace(/\s+/g, " ")).toBe(
      "article_id, articles ( created_at )",
    );
    expect(state.eq).toEqual([{ col: "cluster_id", val: "c1" }]);
    expect(state.limit).toBe(1000);
  });

  it("maps article_id → created_at for object and array embeds, skipping empties", async () => {
    fixture.data = [
      { article_id: "a1", articles: { created_at: "2026-09-27T09:03:25Z" } },
      { article_id: "a2", articles: [{ created_at: "2026-09-27T08:54:47Z" }] },
      { article_id: "a3", articles: null },
      { article_id: "a4", articles: { created_at: null } },
      { article_id: "a5", articles: [] },
    ];
    await expect(fetchMemberSeenAt("c1")).resolves.toEqual({
      a1: "2026-09-27T09:03:25Z",
      a2: "2026-09-27T08:54:47Z",
    });
  });

  it("rethrows inside the cached function so an error is never cached as an empty map", async () => {
    fixture.error = { message: "boom" };
    await expect(fetchMemberSeenAt("c1")).rejects.toThrow("boom");
  });
});

describe("getMemberSeenAt (fail-open wrapper)", () => {
  it("returns the map on success", async () => {
    fixture.data = [{ article_id: "a1", articles: { created_at: "2026-09-27T09:03:25Z" } }];
    await expect(getMemberSeenAt("c1")).resolves.toEqual({ a1: "2026-09-27T09:03:25Z" });
  });

  it("returns null and warns on error", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.error = { message: "boom" };
    await expect(getMemberSeenAt("c1")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[story-timeline]"));
  });
});
