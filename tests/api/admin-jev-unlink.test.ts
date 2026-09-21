import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/admin/jev-unlink (migration 064, pack A,
// shared_contract §I). Modelled on tests/api/revalidate.test.ts (the
// next/cache mock) and tests/api/admin-corrections.test.ts (the
// hasAdminSession mock + shared Supabase fake).
//
// The load-bearing assertion is gate ORDER: hasAdminSession() must run
// BEFORE the rate limiter and BEFORE the request body is ever read. The
// 401 test below passes a Request whose `.json()` throws unconditionally
// (not just on malformed JSON) so a route that reads the body before
// checking the session fails loudly, not silently as a different status.
// ---------------------------------------------------------------------------

const { revalidateTagMock } = vi.hoisted(() => ({
  revalidateTagMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

const dbState = vi.hoisted(() => ({
  candidates: [{ id: 1, cluster_id: "c1", article_id: "a1", status: "pending" }] as Array<{
    id: number;
    cluster_id: string;
    article_id: string;
    status: string;
  }>,
  articleCount: 4,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_unlink_candidates: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        const statusEq = state.eq.find((e) => e.col === "status");
        const row = dbState.candidates.find(
          (r) =>
            (!idEq || String(r.id) === String(idEq.val)) &&
            (!statusEq || r.status === statusEq.val),
        );
        return { data: row ? [row] : [], error: null };
      },
    },
    rpc: {
      cluster_unlink_article: () => ({ data: dbState.articleCount, error: null }),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

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

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function postRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/jev-unlink", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A Request whose `.json()` throws unconditionally — proves the body is
 * never read when the caller is unauthenticated, not merely that a
 * malformed body happens to fail parsing after the fact. */
function poisonedRequest(ip = nextIp()): Request {
  const req = new Request("http://example.com/api/admin/jev-unlink", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ id: 1, decision: "unlink" }),
  });
  Object.defineProperty(req, "json", {
    value: () => {
      throw new Error("json() must not be called before the admin-session gate");
    },
  });
  return req;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __adminAuthed = true;
  dbState.candidates = [{ id: 1, cluster_id: "c1", article_id: "a1", status: "pending" }];
  dbState.articleCount = 4;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  revalidateTagMock.mockClear();
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

describe("POST /api/admin/jev-unlink", () => {
  it("401s before reading the body when there is no admin session", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-unlink/route");

    const res = await mod.POST(poisonedRequest());

    expect(res.status).toBe(401);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("rate limits after the bucket is drained, with retryAfterMs in details", async () => {
    const mod = await import("@/app/api/admin/jev-unlink/route");
    const ip = "198.51.100.77";

    for (let i = 0; i < 20; i++) {
      const res = await mod.POST(postRequest({ id: 1, decision: "keep" }, ip));
      expect(res.status).toBe(200);
    }

    const res = await mod.POST(postRequest({ id: 1, decision: "keep" }, ip));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { details?: { retryAfterMs?: number } };
    expect(typeof body.details?.retryAfterMs).toBe("number");
  });

  it("400s on a non-object body, a non-integer id, and an unknown decision", async () => {
    const mod = await import("@/app/api/admin/jev-unlink/route");

    const badJson = await mod.POST(postRequest("{not json"));
    expect(badJson.status).toBe(400);

    const nonObject = await mod.POST(postRequest("42"));
    expect(nonObject.status).toBe(400);

    const stringId = await mod.POST(postRequest({ id: "1", decision: "keep" }));
    expect(stringId.status).toBe(400);

    const negativeId = await mod.POST(postRequest({ id: -1, decision: "keep" }));
    expect(negativeId.status).toBe(400);

    const badDecision = await mod.POST(postRequest({ id: 1, decision: "delete" }));
    expect(badDecision.status).toBe(400);

    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("unlink: 200 with article_count and revalidates clusters, clusters-politics and cluster-detail:<id>", async () => {
    dbState.candidates = [{ id: 3, cluster_id: "c3", article_id: "a3", status: "pending" }];
    dbState.articleCount = 6;
    const mod = await import("@/app/api/admin/jev-unlink/route");

    const res = await mod.POST(postRequest({ id: 3, decision: "unlink" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, article_count: 6 });

    expect(revalidateTagMock).toHaveBeenCalledTimes(3);
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("clusters-politics", "max");
    expect(revalidateTagMock).toHaveBeenCalledWith("cluster-detail:c3", "max");

    const rpcCalls = supabaseFake.calls.rpc.filter((c) => c.name === "cluster_unlink_article");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.args).toEqual({ p_cluster_id: "c3", p_article_id: "a3" });
  });

  it("keep: 200 and revalidates nothing", async () => {
    dbState.candidates = [{ id: 4, cluster_id: "c4", article_id: "a4", status: "pending" }];
    const mod = await import("@/app/api/admin/jev-unlink/route");

    const res = await mod.POST(postRequest({ id: 4, decision: "keep" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(revalidateTagMock).not.toHaveBeenCalled();

    const updates = supabaseFake.calls.update("jev_unlink_candidates");
    expect(updates).toHaveLength(1);
    const patch = updates[0]?.patch as { status: string; decided_at: unknown };
    expect(patch.status).toBe("kept");
    expect(typeof patch.decided_at).toBe("string");
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("404s when the candidate id has no pending row", async () => {
    dbState.candidates = [];
    const mod = await import("@/app/api/admin/jev-unlink/route");

    const res = await mod.POST(postRequest({ id: 999, decision: "unlink" }));

    expect(res.status).toBe(404);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });
});
