import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for PATCH/DELETE /api/admin/corrections/[id].
//
// Harness combines tests/api/corrections.test.ts's shared proxy-based
// Supabase fake with tests/api/admin.test.ts's admin-session mock. The
// `corrections` fixture is a function over a mutable `dbState.rows` array
// so tests can simulate a found / not-found row without a second fake
// instance.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  rows: [{ id: "11111111-2222-3333-4444-555555555555" }] as Array<{
    id: string;
  }>,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      corrections: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        const found = idEq
          ? dbState.rows.some((r) => r.id === idEq.val)
          : dbState.rows.length > 0;
        if (!found) return { data: [], error: null };
        return { data: [{ id: idEq ? idEq.val : dbState.rows[0]?.id }], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
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
const ID = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  dbState.rows = [{ id: ID }];
  __adminAuthed = true;
  supabaseFake.calls.mutations.length = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function patchRequest(body: unknown, ip = nextIp()): Request {
  return new Request(`http://example.com/api/admin/corrections/${ID}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function deleteRequest(ip = nextIp()): Request {
  return new Request(`http://example.com/api/admin/corrections/${ID}`, {
    method: "DELETE",
    headers: { "x-forwarded-for": ip },
  });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("PATCH/DELETE /api/admin/corrections/[id]", () => {
  it("returns 401 for both PATCH and DELETE when unauthenticated, and never touches the DB", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/corrections/[id]/route");

    const patchRes = await mod.PATCH(
      patchRequest({ status: "reviewed" }),
      paramsFor(ID),
    );
    expect(patchRes.status).toBe(401);

    const deleteRes = await mod.DELETE(deleteRequest(), paramsFor(ID));
    expect(deleteRes.status).toBe(401);

    expect(supabaseFake.calls.forTable("corrections")).toHaveLength(0);
  });

  it("returns 400 for the retired 033 vocabulary and for an unknown status, without mutating", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");

    for (const status of ["resolved", "new", "nope"]) {
      const res = await mod.PATCH(patchRequest({ status }), paramsFor(ID));
      expect(res.status).toBe(400);
    }

    expect(supabaseFake.calls.forTable("corrections")).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");
    const res = await mod.PATCH(patchRequest("{not json"), paramsFor(ID));
    expect(res.status).toBe(400);
  });

  it("returns 400 when the id param is not a uuid, without mutating", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");
    const res = await mod.PATCH(
      patchRequest({ status: "reviewed" }),
      paramsFor("not-a-uuid"),
    );
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.forTable("corrections")).toHaveLength(0);
  });

  it("returns 200 and updates status + reviewed_at on a PATCH to 'reviewed'", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");
    const res = await mod.PATCH(
      patchRequest({ status: "reviewed" }),
      paramsFor(ID),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, status: "reviewed" });

    const updates = supabaseFake.calls.update("corrections");
    expect(updates).toHaveLength(1);
    const patch = updates[0]?.patch as { status: string; reviewed_at: unknown };
    expect(patch).toMatchObject({ status: "reviewed" });
    expect(typeof patch.reviewed_at).toBe("string");
    expect(updates[0]?.state.eq).toContainEqual({ col: "id", val: ID });
  });

  it("sets reviewed_at to exactly null when status is set back to 'open'", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");
    const res = await mod.PATCH(patchRequest({ status: "open" }), paramsFor(ID));
    expect(res.status).toBe(200);
    const updates = supabaseFake.calls.update("corrections");
    const patch = updates[0]?.patch as { reviewed_at: unknown };
    expect(patch.reviewed_at).toBeNull();
  });

  it("returns 404 for PATCH and DELETE when the row is not found", async () => {
    dbState.rows = [];
    const mod = await import("@/app/api/admin/corrections/[id]/route");

    const patchRes = await mod.PATCH(
      patchRequest({ status: "reviewed" }),
      paramsFor(ID),
    );
    expect(patchRes.status).toBe(404);

    const deleteRes = await mod.DELETE(deleteRequest(), paramsFor(ID));
    expect(deleteRes.status).toBe(404);
  });

  it("returns 200 and deletes the row on DELETE", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");
    const res = await mod.DELETE(deleteRequest(), paramsFor(ID));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const deletes = supabaseFake.calls.delete("corrections");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.state.eq).toContainEqual({ col: "id", val: ID });
  });

  it("never leaks email or message in a PATCH-200 or DELETE-200 response body", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");

    const patchRes = await mod.PATCH(
      patchRequest({ status: "dismissed" }),
      paramsFor(ID),
    );
    const patchBody = await patchRes.json();
    expect(Object.keys(patchBody)).not.toContain("email");
    expect(Object.keys(patchBody)).not.toContain("message");

    const deleteRes = await mod.DELETE(deleteRequest(), paramsFor(ID));
    const deleteBody = await deleteRes.json();
    expect(Object.keys(deleteBody)).not.toContain("email");
    expect(Object.keys(deleteBody)).not.toContain("message");
  });

  it("returns 429 after 20 successful PATCHes from one IP, on the 21st", async () => {
    const mod = await import("@/app/api/admin/corrections/[id]/route");
    const ip = "198.51.100.42";
    for (let i = 0; i < 20; i++) {
      const res = await mod.PATCH(
        patchRequest({ status: "reviewed" }, ip),
        paramsFor(ID),
      );
      expect(res.status).toBe(200);
    }
    const res = await mod.PATCH(patchRequest({ status: "reviewed" }, ip), paramsFor(ID));
    expect(res.status).toBe(429);
  });
});
