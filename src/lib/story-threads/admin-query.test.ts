import { describe, it, expect, vi, beforeEach } from "vitest";

const fx = vi.hoisted(() => ({ fail: false }));
const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      story_thread_candidates: () =>
        fx.fail
          ? { data: null, error: { message: "relation does not exist" } }
          : {
              data: [
                { id: 7, cluster_a: "a", cluster_b: "b", confidence: "0.812", shared_terms: ["sarpyener", "fon"], hours_apart: "23.0", same_topic: true },
              ],
              error: null,
            },
      clusters: () => ({
        data: [
          { id: "a", title_tr: "A orijinal", title_tr_neutral: "A nötr", first_published: "2026-09-01T00:00:00Z", article_count: 5 },
          { id: "b", title_tr: "B orijinal", title_tr_neutral: null, first_published: "2026-09-02T00:00:00Z", article_count: 9 },
        ],
        error: null,
      }),
      story_thread_members: () => ({ data: [{ thread_id: "t1", cluster_id: "a" }, { thread_id: "t1", cluster_id: "b" }], error: null }),
      story_threads: () => ({
        data: [{ id: "t1", slug: null, title_tr: null, status: "draft", updated_at: "2026-09-02T00:00:00Z", published_at: null }],
        error: null,
      }),
    },
  });
});
vi.mock("@supabase/supabase-js", () => ({ createClient: () => supabaseFake.client }));

import { getAdminThreads, getThreadCandidates } from "./admin-query";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "k";
  fx.fail = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("admin-query", () => {
  it("maps candidates with titles and current thread", async () => {
    const c = await getThreadCandidates();
    expect(c).toHaveLength(1);
    expect(c![0]!.confidence).toBeCloseTo(0.812);
    expect(c![0]!.a.title).toBe("A nötr");
    expect(c![0]!.b.title).toBe("B orijinal");
    expect(c![0]!.a.thread).toEqual({ id: "t1", title: null });
  });

  it("returns null on error", async () => {
    fx.fail = true;
    expect(await getThreadCandidates()).toBeNull();
    expect(await getAdminThreads()).not.toBeUndefined();
  });

  it("suggests the title of the member with the most articles", async () => {
    const t = await getAdminThreads();
    expect(t![0]!.suggestedTitle).toBe("B orijinal");
    expect(t![0]!.members.map((m) => m.id)).toEqual(["a", "b"]);
  });
});
