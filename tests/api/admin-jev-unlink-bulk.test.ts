import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/admin/jev-unlink/bulk (migration 075).
// Copies the harness of tests/api/admin-jev-unlink.test.ts: same next/cache
// mock, same hasAdminSession mock, same shared Supabase fake. The
// load-bearing assertion is gate ORDER (session before rate limit before
// body read), same as the single-decision route, plus the band 'review'
// restriction landing in the recorded update predicate, not just in the
// route logic.
// ---------------------------------------------------------------------------

const { revalidateTagMock } = vi.hoisted(() => ({
  revalidateTagMock: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidateTag: revalidateTagMock,
}));

const dbState = vi.hoisted(() => ({
  candidates: [
    { id: 1, cluster_id: "c1", article_id: "a1", status: "pending", band: "review" },
    { id: 2, cluster_id: "c2", article_id: "a2", status: "pending", band: "review" },
  ] as Array<{ id: number; cluster_id: string; article_id: string; status: string; band: string }>,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_unlink_candidates: (state) => {
        const idIn = state.in.find((e) => e.col === "id");
        const statusEq = state.eq.find((e) => e.col === "status");
        const bandEq = state.eq.find((e) => e.col === "band");
        const matched = dbState.candidates.filter(
          (r) =>
            (!idIn || idIn.vals.map(String).includes(String(r.id))) &&
            (!statusEq || r.status === statusEq.val) &&
            (!bandEq || r.band === bandEq.val),
        );
        return { data: matched.map((r) => ({ id: r.id })), error: null };
      },
    },
    rpc: {},
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
  return `203.0.114.${ipCounter}`;
}

function postRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/jev-unlink/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A Request whose `.json()` throws unconditionally — proves the body is
 * never read when the caller is unauthenticated. */
function poisonedRequest(ip = nextIp()): Request {
  const req = new Request("http://example.com/api/admin/jev-unlink/bulk", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify({ ids: [1], decision: "keep" }),
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
  dbState.candidates = [
    { id: 1, cluster_id: "c1", article_id: "a1", status: "pending", band: "review" },
    { id: 2, cluster_id: "c2", article_id: "a2", status: "pending", band: "review" },
  ];
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

describe("POST /api/admin/jev-unlink/bulk", () => {
  it("401s before reading the body when there is no admin session, and mutates nothing", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-unlink/bulk/route");

    const res = await mod.POST(poisonedRequest());

    expect(res.status).toBe(401);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("rate limits after 10 requests from one IP, with retryAfterMs in details", async () => {
    const mod = await import("@/app/api/admin/jev-unlink/bulk/route");
    const ip = "198.51.100.88";

    for (let i = 0; i < 10; i++) {
      const res = await mod.POST(postRequest({ ids: [1], decision: "keep" }, ip));
      expect(res.status).toBe(200);
    }

    const res = await mod.POST(postRequest({ ids: [1], decision: "keep" }, ip));
    expect(res.status).toBe(429);
    const body = (await res.json()) as { details?: { retryAfterMs?: number } };
    expect(typeof body.details?.retryAfterMs).toBe("number");
  });

  it("400s on bad JSON, a non-object body, missing ids, 51 ids, id 0, and decision 'unlink'", async () => {
    const mod = await import("@/app/api/admin/jev-unlink/bulk/route");

    const badJson = await mod.POST(postRequest("{not json"));
    expect(badJson.status).toBe(400);

    const nonObject = await mod.POST(postRequest("42"));
    expect(nonObject.status).toBe(400);

    const missingIds = await mod.POST(postRequest({ decision: "keep" }));
    expect(missingIds.status).toBe(400);

    const tooMany = await mod.POST(
      postRequest({ ids: Array.from({ length: 51 }, (_, i) => i + 1), decision: "keep" }),
    );
    expect(tooMany.status).toBe(400);

    const zeroId = await mod.POST(postRequest({ ids: [0], decision: "keep" }));
    expect(zeroId.status).toBe(400);

    const badDecision = await mod.POST(postRequest({ ids: [1], decision: "unlink" }));
    expect(badDecision.status).toBe(400);

    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("200s with { ok, kept, skipped }, and the update carries eq band 'review'; no RPC, no revalidateTag", async () => {
    dbState.candidates = [
      { id: 1, cluster_id: "c1", article_id: "a1", status: "pending", band: "review" },
      { id: 2, cluster_id: "c2", article_id: "a2", status: "pending", band: "likely_unlink" },
    ];
    const mod = await import("@/app/api/admin/jev-unlink/bulk/route");

    const res = await mod.POST(postRequest({ ids: [1, 2], decision: "keep" }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, kept: 1, skipped: 1 });

    const updates = supabaseFake.calls.update("jev_unlink_candidates");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.state.eq).toContainEqual({ col: "band", val: "review" });
    expect(updates[0]?.state.eq).toContainEqual({ col: "status", val: "pending" });

    expect(supabaseFake.calls.rpc).toHaveLength(0);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });
});
