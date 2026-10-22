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
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
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
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

import { cacheLife, cacheTag } from "next/cache";
import * as storyTimelineQuery from "./story-timeline-query";
import { getMemberSeenAt } from "./story-timeline-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };
const TIMEOUT_MESSAGE = "AbortError: Supabase request exceeded 4000 ms";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  fixture.clientOpts = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getMemberSeenAt query", () => {
  it("queries cluster_articles for one cluster with the articles(created_at) embed", async () => {
    await getMemberSeenAt("c1");
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
    await expect(getMemberSeenAt("c1")).resolves.toEqual({
      a1: "2026-09-27T09:03:25Z",
      a2: "2026-09-27T08:54:47Z",
    });
  });

  it("no longer exports the throwing raw fetcher (nothing can call it across the cache boundary)", () => {
    expect("fetchMemberSeenAt" in storyTimelineQuery).toBe(false);
  });
});

describe("getMemberSeenAt read profile", () => {
  it("builds only capped reader clients", async () => {
    await getMemberSeenAt("c1");
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("getMemberSeenAt (fail-open wrapper) + cache lifetime", () => {
  it("returns the map on success and caches it for cluster-feed, once", async () => {
    fixture.data = [{ article_id: "a1", articles: { created_at: "2026-09-27T09:03:25Z" } }];

    await expect(getMemberSeenAt("c1")).resolves.toEqual({ a1: "2026-09-27T09:03:25Z" });

    expect(cacheTag).toHaveBeenCalledWith("clusters");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("an empty cluster is a successful (cacheable) {} answer, not a failure", async () => {
    fixture.data = [];
    await expect(getMemberSeenAt("c1")).resolves.toEqual({});
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("returns null and warns on error, never an empty map", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.error = { message: "boom" };

    await expect(getMemberSeenAt("c1")).resolves.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[story-timeline]"));
  });

  it("a timeout resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.error = { message: TIMEOUT_MESSAGE };

    await expect(getMemberSeenAt("c1")).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });
});
