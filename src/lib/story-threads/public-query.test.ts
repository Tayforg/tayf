import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fx = vi.hoisted(() => ({
  threads: [] as unknown[],
  members: [] as unknown[],
  clusters: [] as unknown[],
  memberEmbed: null as unknown,
  error: null as { message: string } | null,
  /** The next N table reads fail with `failError`, then reads succeed again. */
  failNext: 0,
  failError: { message: "AbortError: Supabase request exceeded 4000 ms" } as { message: string },
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
  called: [] as string[],
  states: [] as Array<{ table: string; eq: Array<{ col: string; val: unknown }>; in: Array<{ col: string; vals: unknown[] }> }>,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  const pick = (name: string, rows: () => unknown) => (state: never) => {
    fx.called.push(name);
    fx.states.push(state as never);
    if (fx.failNext > 0) {
      fx.failNext -= 1;
      return { data: null, error: fx.failError };
    }
    if (fx.error) return { data: null, error: fx.error };
    return { data: rows(), error: null };
  };
  return helper.createSupabaseFake({
    tables: {
      story_threads: pick("story_threads", () => fx.threads),
      story_thread_members: (state) => {
        // Embedded lookup (cluster -> thread) selects thread_id + the embed.
        const sel = String((state.selectArgs as unknown[])[0] ?? "");
        return pick("story_thread_members", () =>
          sel.includes("story_threads") ? fx.memberEmbed : fx.members,
        )(state as never);
      },
      clusters: pick("clusters", () => fx.clusters),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fx.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

import { cacheLife, cacheTag } from "next/cache";
import {
  getPublishedThreadBySlug,
  getPublishedThreadForCluster,
  loadPublishedThreadBySlug,
} from "./public-query";

const T_ID = "11111111-1111-4111-8111-111111111111";
const C1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const C2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ORIGINAL = process.env.STORY_THREADS;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.STORY_THREADS;
  fx.threads = [
    { id: T_ID, slug: "sarpyener-fon-a1b2c3", title_tr: "Sarpyener fon soruşturması", status: "published", published_at: "2026-09-02T10:00:00Z" },
  ];
  fx.members = [{ cluster_id: C1 }, { cluster_id: C2 }];
  fx.clusters = [
    { id: C1, title_tr: "Bir", title_tr_neutral: null, first_published: "2026-09-01T10:00:00Z", article_count: 4, bias_distribution: { center: 2 } },
    { id: C2, title_tr: "İki", title_tr_neutral: "İki nötr", first_published: "2026-09-02T10:00:00Z", article_count: 3, bias_distribution: { opposition: 1 } },
  ];
  fx.memberEmbed = { thread_id: T_ID, story_threads: { slug: "sarpyener-fon-a1b2c3", title_tr: "Sarpyener fon soruşturması", status: "published" } };
  fx.error = null;
  fx.failNext = 0;
  fx.clientOpts = [];
  fx.called.length = 0;
  fx.states.length = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (ORIGINAL === undefined) delete process.env.STORY_THREADS;
  else process.env.STORY_THREADS = ORIGINAL;
});

describe("getPublishedThreadBySlug", () => {
  it("returns the thread with its member clusters", async () => {
    const t = await getPublishedThreadBySlug("sarpyener-fon-a1b2c3");
    expect(t).not.toBeNull();
    expect(t!.slug).toBe("sarpyener-fon-a1b2c3");
    expect(t!.title).toBe("Sarpyener fon soruşturması");
    expect(t!.members.map((m) => m.id)).toEqual([C1, C2]);
  });

  it("filters on slug and status = published", async () => {
    await getPublishedThreadBySlug("sarpyener-fon-a1b2c3");
    const s = fx.states.find((x) => x.table === "story_threads")!;
    expect(s.eq).toContainEqual({ col: "slug", val: "sarpyener-fon-a1b2c3" });
    expect(s.eq).toContainEqual({ col: "status", val: "published" });
    const c = fx.states.find((x) => x.table === "clusters")!;
    expect(c.in[0]!.vals).toEqual([C1, C2]);
  });

  it("returns null for a draft row even if the DB handed it over", async () => {
    fx.threads = [{ id: T_ID, slug: "sarpyener-fon-a1b2c3", title_tr: "Sarpyener fon soruşturması", status: "draft", published_at: null }];
    expect(await getPublishedThreadBySlug("sarpyener-fon-a1b2c3")).toBeNull();
  });

  it("returns null for an invalid slug without touching any table", async () => {
    for (const s of ["../etc", "AB", "a b c", "", "x".repeat(200)]) {
      expect(await getPublishedThreadBySlug(s)).toBeNull();
    }
    expect(fx.called).toEqual([]);
  });

  it("returns null when the thread does not exist", async () => {
    fx.threads = [];
    expect(await getPublishedThreadBySlug("yok-boyle-bir")).toBeNull();
  });

  it("returns null on a DB error", async () => {
    fx.error = { message: "connection reset" };
    expect(await getPublishedThreadBySlug("sarpyener-fon-a1b2c3")).toBeNull();
  });
});

describe("getPublishedThreadForCluster", () => {
  it("returns {slug, title} for a published thread (object embed)", async () => {
    expect(await getPublishedThreadForCluster(C1)).toEqual({
      slug: "sarpyener-fon-a1b2c3",
      title: "Sarpyener fon soruşturması",
    });
    const s = fx.states.find((x) => x.table === "story_thread_members")!;
    expect(s.eq).toContainEqual({ col: "cluster_id", val: C1 });
    expect(s.eq).toContainEqual({ col: "story_threads.status", val: "published" });
  });

  it("normalises an array embed", async () => {
    fx.memberEmbed = { thread_id: T_ID, story_threads: [{ slug: "abc-def-123456", title_tr: "Bir başlık burada", status: "published" }] };
    expect(await getPublishedThreadForCluster(C1)).toEqual({ slug: "abc-def-123456", title: "Bir başlık burada" });
  });

  it("returns null for a draft, missing slug or missing title", async () => {
    fx.memberEmbed = { thread_id: T_ID, story_threads: { slug: "abc-def", title_tr: "Bir başlık burada", status: "draft" } };
    expect(await getPublishedThreadForCluster(C1)).toBeNull();
    fx.memberEmbed = { thread_id: T_ID, story_threads: { slug: null, title_tr: "Bir başlık burada", status: "published" } };
    expect(await getPublishedThreadForCluster(C1)).toBeNull();
    fx.memberEmbed = { thread_id: T_ID, story_threads: { slug: "abc-def", title_tr: null, status: "published" } };
    expect(await getPublishedThreadForCluster(C1)).toBeNull();
    fx.memberEmbed = null;
    expect(await getPublishedThreadForCluster(C1)).toBeNull();
  });

  it("returns null for a non-uuid id without touching any table", async () => {
    expect(await getPublishedThreadForCluster("not-a-uuid")).toBeNull();
    expect(await getPublishedThreadForCluster("")).toBeNull();
    expect(fx.called).toEqual([]);
  });

  it("returns null on a DB error", async () => {
    fx.error = { message: "boom" };
    expect(await getPublishedThreadForCluster(C1)).toBeNull();
  });

  it("returns null with no query when STORY_THREADS=off", async () => {
    process.env.STORY_THREADS = "off";
    expect(await getPublishedThreadForCluster(C1)).toBeNull();
    expect(fx.called).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Cold-read resilience: capped client, failure cached for minutes only, and
// "a timeout is not a 404" via loadPublishedThreadBySlug.
// ---------------------------------------------------------------------------

const SLUG = "sarpyener-fon-a1b2c3";

describe("story-threads read profile", () => {
  it("getPublishedThreadBySlug builds only capped reader clients", async () => {
    await getPublishedThreadBySlug(SLUG);
    expect(fx.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fx.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("getPublishedThreadForCluster builds only capped reader clients", async () => {
    await getPublishedThreadForCluster(C1);
    expect(fx.clientOpts.length).toBeGreaterThanOrEqual(1);
    expect(fx.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("loadPublishedThreadBySlug builds only capped reader clients", async () => {
    fx.failNext = 1; // force the live retry path too
    await loadPublishedThreadBySlug(SLUG);
    expect(fx.clientOpts.length).toBeGreaterThanOrEqual(2);
    expect(fx.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

describe("story-threads cache lifetime: a failure is cached for minutes only", () => {
  it("by slug: success is cached for hours, once, tagged before the fetch", async () => {
    await getPublishedThreadBySlug(SLUG);
    expect(cacheTag).toHaveBeenCalledWith("story-threads");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("by slug: a genuinely missing thread is a successful answer (hours), not a failure", async () => {
    fx.threads = [];
    await expect(getPublishedThreadBySlug("yok-boyle-bir")).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("by slug: a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    fx.error = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(getPublishedThreadBySlug(SLUG)).resolves.toBeNull();

    // cached attempt (cacheLife) + live retry (uncached, no cacheLife)
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("hours");
  });

  it("for cluster: success is cached for hours, once", async () => {
    await getPublishedThreadForCluster(C1);
    expect(cacheTag).toHaveBeenCalledWith("story-threads");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("for cluster: an unthreaded cluster is a successful answer (hours)", async () => {
    fx.memberEmbed = null;
    await expect(getPublishedThreadForCluster(C1)).resolves.toBeNull();
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("for cluster: a timeout resolves null and calls cacheLife('minutes') exactly once", async () => {
    fx.error = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(getPublishedThreadForCluster(C1)).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("hours");
  });
});

describe("loadPublishedThreadBySlug (a timeout is not a 404)", () => {
  it("rejects when the cached attempt AND the live retry both fail", async () => {
    fx.error = { message: "AbortError: Supabase request exceeded 4000 ms" };

    await expect(loadPublishedThreadBySlug(SLUG)).rejects.toThrow(/AbortError/);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("returns the thread when the live retry succeeds after a failed cached attempt", async () => {
    fx.failNext = 1;

    const t = await loadPublishedThreadBySlug(SLUG);

    expect(t).not.toBeNull();
    expect(t!.slug).toBe(SLUG);
    expect(t!.members.map((m) => m.id)).toEqual([C1, C2]);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("returns the cached thread without a live retry when the first attempt succeeds", async () => {
    const t = await loadPublishedThreadBySlug(SLUG);

    expect(t!.title).toBe("Sarpyener fon soruşturması");
    expect(fx.clientOpts).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledWith("hours");
  });

  it("returns null (and does not throw) for a thread that is genuinely missing", async () => {
    fx.threads = [];

    await expect(loadPublishedThreadBySlug("yok-boyle-bir")).resolves.toBeNull();
    expect(fx.clientOpts).toHaveLength(1);
  });

  it("returns null for a draft row (not a failure, no retry)", async () => {
    fx.threads = [
      { id: T_ID, slug: SLUG, title_tr: "Sarpyener fon soruşturması", status: "draft", published_at: null },
    ];

    await expect(loadPublishedThreadBySlug(SLUG)).resolves.toBeNull();
    expect(fx.clientOpts).toHaveLength(1);
  });

  it("returns null for an invalid slug without touching any table", async () => {
    for (const s of ["../etc", "AB", "a b c", "", "x".repeat(200)]) {
      await expect(loadPublishedThreadBySlug(s)).resolves.toBeNull();
    }
    expect(fx.called).toEqual([]);
    expect(cacheLife).not.toHaveBeenCalled();
  });

  it("getPublishedThreadBySlug keeps its never-throw contract on the same sustained timeout", async () => {
    fx.error = { message: "AbortError: Supabase request exceeded 4000 ms" };
    await expect(getPublishedThreadBySlug(SLUG)).resolves.toBeNull();
  });
});
