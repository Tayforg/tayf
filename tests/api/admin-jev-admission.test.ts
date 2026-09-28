import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/admin/jev-admission/review (migration 089,
// "ADMIT"). Modelled on tests/api/admin-jev-unlink.test.ts: hasAdminSession
// gate ORDER (before rate limiting, before the body is ever read), the
// shared Supabase fake, and a poisoned-body request that proves the body is
// never read when unauthenticated.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  rows: [{ article_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", rolled_back_at: null as string | null }],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_politics_admissions: (state) => {
        const eqArticle = state.eq.find((e) => e.col === "article_id")?.val as string | undefined;
        const row = dbState.rows.find(
          (r) => r.article_id === eqArticle && r.rolled_back_at === null,
        );
        if (!row) return { data: null, error: null };
        if (state.mutation?.op === "update") {
          return { data: { article_id: row.article_id }, error: null };
        }
        return { data: row, error: null };
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => supabaseFake.client,
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

const VALID_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const UNKNOWN_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.51.100.${ipCounter}`;
}

function postRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/jev-admission/review", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A Request whose `.json()` throws unconditionally — proves the body is
 * never read when the caller is unauthenticated. */
function poisonedRequest(ip = nextIp()): Request {
  const req = new Request("http://example.com/api/admin/jev-admission/review", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: "{}",
  });
  vi.spyOn(req, "json").mockRejectedValue(new Error("must not be called"));
  return req;
}

beforeEach(() => {
  __adminAuthed = true;
  dbState.rows = [{ article_id: VALID_ID, rolled_back_at: null }];
  supabaseFake.calls.mutations.length = 0;
  vi.resetModules();
});

async function importRoute() {
  const mod = await import("../../src/app/api/admin/jev-admission/review/route");
  return mod.POST;
}

describe("POST /api/admin/jev-admission/review", () => {
  it("401s before the body is ever read", async () => {
    __adminAuthed = false;
    const POST = await importRoute();
    const req = poisonedRequest();
    const jsonSpy = req.json as unknown as ReturnType<typeof vi.fn>;
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(jsonSpy).not.toHaveBeenCalled();
  });

  it("400s on invalid JSON", async () => {
    const POST = await importRoute();
    const res = await POST(postRequest("not json"));
    expect(res.status).toBe(400);
  });

  it("400s on a bad article_id (not a UUID)", async () => {
    const POST = await importRoute();
    const res = await POST(postRequest({ article_id: "not-a-uuid", verdict: "domestic" }));
    expect(res.status).toBe(400);
  });

  it("400s on a bad verdict", async () => {
    const POST = await importRoute();
    const res = await POST(postRequest({ article_id: VALID_ID, verdict: "bogus" }));
    expect(res.status).toBe(400);
  });

  it("404s on an unknown article_id", async () => {
    const POST = await importRoute();
    const res = await POST(postRequest({ article_id: UNKNOWN_ID, verdict: "domestic" }));
    expect(res.status).toBe(404);
  });

  it("200s on success and issues the documented update args", async () => {
    const POST = await importRoute();
    const res = await POST(postRequest({ article_id: VALID_ID, verdict: "domestic" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const updateCalls = supabaseFake.calls.update("jev_politics_admissions");
    expect(updateCalls).toHaveLength(1);
    const patch = updateCalls[0].patch as { review_verdict?: string; reviewed_at?: string };
    expect(patch.review_verdict).toBe("domestic");
    expect(typeof patch.reviewed_at).toBe("string");
    expect(updateCalls[0].state.eq).toContainEqual({ col: "article_id", val: VALID_ID });
    expect(updateCalls[0].state.is).toContainEqual({ col: "rolled_back_at", val: null });
  });

  it("429s once the 20-token bucket is exhausted", async () => {
    const POST = await importRoute();
    const ip = nextIp();
    let lastStatus = 0;
    for (let i = 0; i < 25; i++) {
      const res = await POST(postRequest({ article_id: VALID_ID, verdict: "domestic" }, ip));
      lastStatus = res.status;
    }
    expect(lastStatus).toBe(429);
  });
});
