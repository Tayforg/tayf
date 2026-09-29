import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { threadSlug } from "../../src/lib/story-threads/config";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/admin/story-threads/candidates and
// POST /api/admin/story-threads/thread (migration 098). Same harness as
// tests/api/admin-jev-alerts.test.ts: shared proxy Supabase fake, the
// __adminAuthed switch, a next/server `connection` shim and a per-test
// nextIp() so the rate limiter never bleeds between tests.
// ---------------------------------------------------------------------------

const T_ID = "11111111-1111-4111-8111-111111111111";
const C_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const dbState = vi.hoisted(() => ({
  candidateMissing: false,
  thread: null as null | {
    id: string;
    slug: string | null;
    title_tr: string | null;
    status: "draft" | "published";
    published_at: string | null;
  },
  memberCount: 3,
  uniqueViolation: false,
  rpcResult: { data: null as unknown, error: null as null | { message: string } },
  touched: [] as string[],
}));

const revalidateTag = vi.hoisted(() => vi.fn());

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      story_thread_candidates: () => {
        dbState.touched.push("story_thread_candidates");
        return dbState.candidateMissing ? { data: [], error: null } : { data: [{ id: 7 }], error: null };
      },
      story_threads: (state) => {
        dbState.touched.push("story_threads");
        // A bare update (no .select()) is the write; reads always select.
        if (dbState.uniqueViolation && state.selectArgs.length === 0) {
          return { data: null, error: { message: "duplicate key", code: "23505" } as never };
        }
        return { data: dbState.thread ? [dbState.thread] : [], error: null };
      },
      story_thread_members: () => {
        dbState.touched.push("story_thread_members");
        return {
          data: Array.from({ length: dbState.memberCount }, (_, i) => ({ cluster_id: `c-${i}` })),
          error: null,
        };
      },
    },
    rpc: {
      story_thread_approve_candidate: () => dbState.rpcResult as never,
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/cache", () => ({
  revalidateTag,
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

let __adminAuthed = true;
vi.mock("@/lib/admin/session", () => ({
  hasAdminSession: async () => __adminAuthed,
  requireAdminSession: async () => {
    if (!__adminAuthed) throw new Error("unauthenticated");
  },
  checkAdminPassword: () => false,
  createAdminSession: async () => {},
  deleteAdminSession: async () => {},
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __adminAuthed = true;
  dbState.candidateMissing = false;
  dbState.thread = { id: T_ID, slug: null, title_tr: "Sarpyener fon soruşturması", status: "draft", published_at: null };
  dbState.memberCount = 3;
  dbState.uniqueViolation = false;
  dbState.rpcResult = { data: T_ID, error: null };
  dbState.touched.length = 0;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  revalidateTag.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function postRequest(path: string, body: unknown, ip = nextIp()): Request {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const CAND = "/api/admin/story-threads/candidates";
const THREAD = "/api/admin/story-threads/thread";

describe("POST /api/admin/story-threads/candidates", () => {
  it("401s when unauthenticated, before reading the body, with no DB call", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/story-threads/candidates/route");
    const res = await mod.POST(postRequest(CAND, "{not json"));
    expect(res.status).toBe(401);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
    expect(dbState.touched).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("400s on malformed JSON, bad ids and bad actions", async () => {
    const mod = await import("@/app/api/admin/story-threads/candidates/route");
    expect((await mod.POST(postRequest(CAND, "{not json"))).status).toBe(400);
    const bad = [
      { id: 0, action: "approve" },
      { id: -1, action: "approve" },
      { id: 1.5, action: "approve" },
      { id: "7", action: "approve" },
      { id: 2 ** 60, action: "approve" },
      { id: 7, action: "publish" },
      { id: 7 },
      { action: "approve" },
      null,
    ];
    for (const body of bad) {
      expect((await mod.POST(postRequest(CAND, body))).status).toBe(400);
    }
    expect(supabaseFake.calls.rpc).toHaveLength(0);
    expect(dbState.touched).toHaveLength(0);
  });

  it("429s once the bucket is empty", async () => {
    const mod = await import("@/app/api/admin/story-threads/candidates/route");
    const ip = nextIp();
    let last = 200;
    for (let i = 0; i < 70; i++) {
      last = (await mod.POST(postRequest(CAND, { id: 7, action: "approve" }, ip))).status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });

  it("approve calls the rpc with {p_candidate_id: 7} and returns the thread id", async () => {
    const mod = await import("@/app/api/admin/story-threads/candidates/route");
    const res = await mod.POST(postRequest(CAND, { id: 7, action: "approve" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, threadId: T_ID });
    expect(supabaseFake.calls.rpc).toEqual([
      { name: "story_thread_approve_candidate", args: { p_candidate_id: 7 } },
    ]);
    expect(revalidateTag).toHaveBeenCalledWith("story-threads", "max");
  });

  it("approve maps conflict to 409, not_pending to 404 and anything else to 500", async () => {
    const mod = await import("@/app/api/admin/story-threads/candidates/route");

    dbState.rpcResult = { data: null, error: { message: "story_thread_conflict" } };
    expect((await mod.POST(postRequest(CAND, { id: 7, action: "approve" }))).status).toBe(409);

    dbState.rpcResult = { data: null, error: { message: "story_thread_candidate_not_pending" } };
    expect((await mod.POST(postRequest(CAND, { id: 7, action: "approve" }))).status).toBe(404);

    dbState.rpcResult = { data: null, error: { message: "connection reset" } };
    const res = await mod.POST(postRequest(CAND, { id: 7, action: "approve" }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("connection reset");
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("reject updates only a pending row and does not touch the rpc", async () => {
    const mod = await import("@/app/api/admin/story-threads/candidates/route");
    const res = await mod.POST(postRequest(CAND, { id: 7, action: "reject" }));
    expect(res.status).toBe(200);
    expect(supabaseFake.calls.rpc).toHaveLength(0);

    const updates = supabaseFake.calls.update("story_thread_candidates");
    expect(updates).toHaveLength(1);
    const patch = updates[0]!.patch as Record<string, unknown>;
    expect(patch.status).toBe("rejected");
    expect(typeof patch.reviewed_at).toBe("string");
    expect(updates[0]!.state.eq).toEqual(
      expect.arrayContaining([
        { col: "id", val: 7 },
        { col: "status", val: "pending" },
      ]),
    );
  });

  it("reject of a missing or already reviewed candidate is 404", async () => {
    dbState.candidateMissing = true;
    const mod = await import("@/app/api/admin/story-threads/candidates/route");
    expect((await mod.POST(postRequest(CAND, { id: 7, action: "reject" }))).status).toBe(404);
  });
});

describe("POST /api/admin/story-threads/thread", () => {
  it("401s when unauthenticated with no DB call", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(401);
    expect(dbState.touched).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("400s on bad json, uuid, action, clusterId and title without touching the DB", async () => {
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    expect((await mod.POST(postRequest(THREAD, "{nope"))).status).toBe(400);
    const bad = [
      { threadId: "not-a-uuid", action: "publish" },
      { action: "publish" },
      { threadId: T_ID, action: "explode" },
      { threadId: T_ID },
      { threadId: T_ID, action: "rename" },
      { threadId: T_ID, action: "rename", title: "kısa" },
      { threadId: T_ID, action: "rename", title: "x".repeat(141) },
      { threadId: T_ID, action: "rename", title: "başlık\nikinci satır" },
      { threadId: T_ID, action: "remove_member" },
      { threadId: T_ID, action: "remove_member", clusterId: "nope" },
      [],
    ];
    for (const body of bad) {
      expect((await mod.POST(postRequest(THREAD, body))).status).toBe(400);
    }
    expect(dbState.touched).toHaveLength(0);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("404s on an unknown thread", async () => {
    dbState.thread = null;
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(404);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("rename writes the trimmed title", async () => {
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(
      postRequest(THREAD, { threadId: T_ID, action: "rename", title: "  Yeni hikaye başlığı  " }),
    );
    expect(res.status).toBe(200);
    const u = supabaseFake.calls.update("story_threads");
    expect(u).toHaveLength(1);
    const patch = u[0]!.patch as Record<string, unknown>;
    expect(patch.title_tr).toBe("Yeni hikaye başlığı");
    expect(typeof patch.updated_at).toBe("string");
    expect("status" in patch).toBe(false);
    expect(u[0]!.state.eq).toContainEqual({ col: "id", val: T_ID });
    expect(revalidateTag).toHaveBeenCalledWith("story-threads", "max");
  });

  it("publish 409s without a title", async () => {
    dbState.thread = { id: T_ID, slug: null, title_tr: null, status: "draft", published_at: null };
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(409);
    expect(supabaseFake.calls.update("story_threads")).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("publish 409s with fewer than 3 members", async () => {
    dbState.memberCount = 2;
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(409);
    expect(supabaseFake.calls.update("story_threads")).toHaveLength(0);
  });

  it("publish sets status, a generated slug and published_at", async () => {
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(200);
    const patch = supabaseFake.calls.update("story_threads")[0]!.patch as Record<string, unknown>;
    expect(patch.status).toBe("published");
    expect(patch.slug).toBe(threadSlug("Sarpyener fon soruşturması", T_ID));
    expect(typeof patch.published_at).toBe("string");
    expect(typeof patch.updated_at).toBe("string");
    expect(revalidateTag).toHaveBeenCalledWith("story-threads", "max");
  });

  it("publish keeps an existing slug and published_at", async () => {
    dbState.thread = {
      id: T_ID,
      slug: "eski-slug-a1b2c3",
      title_tr: "Tamamen yeni bir başlık",
      status: "draft",
      published_at: "2026-09-01T00:00:00.000Z",
    };
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(200);
    const patch = supabaseFake.calls.update("story_threads")[0]!.patch as Record<string, unknown>;
    expect(patch.slug).toBe("eski-slug-a1b2c3");
    expect(patch.published_at).toBe("2026-09-01T00:00:00.000Z");
  });

  it("publish maps a unique violation to 409", async () => {
    dbState.uniqueViolation = true;
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "publish" }));
    expect(res.status).toBe(409);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("unpublish sets the thread back to draft", async () => {
    dbState.thread = { id: T_ID, slug: "abc-def-a1b2c3", title_tr: "Sarpyener fon soruşturması", status: "published", published_at: "2026-09-01T00:00:00.000Z" };
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "unpublish" }));
    expect(res.status).toBe(200);
    const patch = supabaseFake.calls.update("story_threads")[0]!.patch as Record<string, unknown>;
    expect(patch.status).toBe("draft");
    expect(revalidateTag).toHaveBeenCalledWith("story-threads", "max");
  });

  it("remove_member 409s on a published thread", async () => {
    dbState.thread = { id: T_ID, slug: "abc-def-a1b2c3", title_tr: "Sarpyener fon soruşturması", status: "published", published_at: "2026-09-01T00:00:00.000Z" };
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "remove_member", clusterId: C_ID }));
    expect(res.status).toBe(409);
    expect(supabaseFake.calls.delete("story_thread_members")).toHaveLength(0);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("remove_member deletes the membership of a draft", async () => {
    const mod = await import("@/app/api/admin/story-threads/thread/route");
    const res = await mod.POST(postRequest(THREAD, { threadId: T_ID, action: "remove_member", clusterId: C_ID }));
    expect(res.status).toBe(200);
    const d = supabaseFake.calls.delete("story_thread_members");
    expect(d).toHaveLength(1);
    expect(d[0]!.state.eq).toEqual(
      expect.arrayContaining([
        { col: "thread_id", val: T_ID },
        { col: "cluster_id", val: C_ID },
      ]),
    );
    expect(revalidateTag).toHaveBeenCalledWith("story-threads", "max");
  });
});
