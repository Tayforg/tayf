import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// New coverage — no test file existed for src/app/sitemap.ts before.
// Uses a predicate-honouring resolver so this also proves archived rows are
// actually dropped from the emitted <url> list, not just from the query shape.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
  lastState: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        fixture.lastState = state;
        const rows = fixture.data.filter((r) =>
          state.eq.every(({ col, val }) => r[col] === val),
        );
        return { data: rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import sitemap from "@/app/sitemap";
import type { BuilderState } from "../_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayf.test";
  fixture.data = [];
  fixture.lastState = null;
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SITE_URL",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("sitemap query shape", () => {
  it("filters archived clusters out of the query", async () => {
    await sitemap();

    const state = fixture.lastState as BuilderState;
    expect(state.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(state.gte).toEqual([{ col: "article_count", val: 2 }]);
    expect(state.order).toEqual([
      { col: "updated_at", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(1000);
  });
});

describe("sitemap output", () => {
  it("omits archived cluster URLs from the emitted sitemap", async () => {
    fixture.data = [
      {
        id: "active-1",
        is_archived: false,
        updated_at: "2026-04-18T11:00:00.000Z",
        cluster_articles: [
          {
            articles: {
              image_url: "https://img/1.jpg",
              published_at: "2026-04-18T10:00:00.000Z",
            },
          },
        ],
      },
      {
        id: "archived-1",
        is_archived: true,
        updated_at: "2026-04-17T11:00:00.000Z",
        cluster_articles: [
          {
            articles: {
              image_url: "https://img/2.jpg",
              published_at: "2026-04-17T10:00:00.000Z",
            },
          },
        ],
      },
    ];

    const entries = await sitemap();
    const urls = entries.map((e) => e.url);

    expect(urls).toContain("https://tayf.test/cluster/active-1");
    expect(urls).not.toContain("https://tayf.test/cluster/archived-1");
    expect(urls).toContain("https://tayf.test/");
  });
});
