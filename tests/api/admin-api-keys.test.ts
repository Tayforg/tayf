import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for:
//   POST /api/admin/api-keys
//   POST /api/admin/api-keys/revoke
//
// Harness combines tests/api/admin-corrections.test.ts's admin-session mock
// with the shared proxy-based Supabase fake. `api_keys` fixture tracks a
// small mutable `dbState.rows` array so revoke can simulate found/not-found.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  rows: [{ id: 7, revoked_at: null as string | null }],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      api_keys: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        const isRevokedNull = state.is.find((i) => i.col === "revoked_at" && i.val === null);
        if (idEq) {
          let rows = dbState.rows.filter((r) => r.id === idEq.val);
          if (isRevokedNull) rows = rows.filter((r) => r.revoked_at === null);
          return { data: rows, error: null };
        }
        return { data: dbState.rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
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
  dbState.rows = [{ id: 7, revoked_at: null }];
  __adminAuthed = true;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
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
  return `203.0.115.${1 + (ipCounter % 250)}`;
}

function createRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/api-keys", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function revokeRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/api-keys/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/admin/api-keys", () => {
  it("401 without an admin session and never touches Supabase", async () => {
    __adminAuthed = false;
    const { POST } = await import("@/app/api/admin/api-keys/route");
    const res = await POST(createRequest({ label: "smoke", tier: "free" }));
    expect(res.status).toBe(401);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("400 for an empty label, a 65-char label and an unknown tier", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/route");

    const emptyLabel = await POST(createRequest({ label: "", tier: "free" }));
    expect(emptyLabel.status).toBe(400);

    const longLabel = await POST(createRequest({ label: "a".repeat(65), tier: "free" }));
    expect(longLabel.status).toBe(400);

    const badTier = await POST(createRequest({ label: "ok", tier: "enterprise" }));
    expect(badTier.status).toBe(400);

    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("201 returns the plaintext key once and inserts ONLY its sha256 hash", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/route");
    const res = await POST(createRequest({ label: "smoke", tier: "free" }));
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(typeof body.api_key).toBe("string");
    expect(body.api_key).toMatch(/^tayf_[0-9a-f]{40}$/);
    expect(body.label).toBe("smoke");
    expect(body.tier).toBe("free");
    expect(typeof body.created_at).toBe("string");

    const inserts = supabaseFake.calls.insert("api_keys");
    expect(inserts).toHaveLength(1);
    const patch = inserts[0]?.patch as Record<string, unknown>;
    expect(patch.key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(patch.label).toBe("smoke");
    expect(patch.tier).toBe("free");
    expect(JSON.stringify(patch)).not.toContain(body.api_key);
    expect(Object.keys(patch)).not.toContain("api_key");
    expect(Object.keys(patch)).not.toContain("key");
  });

  it("returns 429 after 20 successful creates from one IP, on the 21st", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/route");
    const ip = "198.51.102.42";
    for (let i = 0; i < 20; i++) {
      const res = await POST(createRequest({ label: `k${i}`, tier: "free" }, ip));
      expect(res.status).toBe(201);
    }
    const res = await POST(createRequest({ label: "one-too-many", tier: "free" }, ip));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/api-keys/revoke", () => {
  it("401 without an admin session", async () => {
    __adminAuthed = false;
    const { POST } = await import("@/app/api/admin/api-keys/revoke/route");
    const res = await POST(revokeRequest({ id: 7 }));
    expect(res.status).toBe(401);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("400 for a non-numeric id", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/revoke/route");
    const res = await POST(revokeRequest({ id: "abc" }));
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("404 for an unknown id", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/revoke/route");
    const res = await POST(revokeRequest({ id: 999 }));
    expect(res.status).toBe(404);
  });

  it("200 sets revoked_at", async () => {
    const { POST } = await import("@/app/api/admin/api-keys/revoke/route");
    const res = await POST(revokeRequest({ id: 7 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, id: 7, revoked_at: expect.any(String) });

    const updates = supabaseFake.calls.update("api_keys");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.state.eq).toContainEqual({ col: "id", val: 7 });
  });
});

describe("both admin routes check the session before the rate limiter and before reading the body", () => {
  it("returns 401 (not 400) for a malformed JSON body when unauthenticated, on both routes", async () => {
    __adminAuthed = false;
    const createMod = await import("@/app/api/admin/api-keys/route");
    const createRes = await createMod.POST(createRequest("{not json"));
    expect(createRes.status).toBe(401);

    const revokeMod = await import("@/app/api/admin/api-keys/revoke/route");
    const revokeRes = await revokeMod.POST(revokeRequest("{not json"));
    expect(revokeRes.status).toBe(401);

    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });
});
