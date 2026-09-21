import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for the two /api/admin/jev-regression/* routes (pack B2
// "Metodoloji regresyonu", migration 066, W2, shared_contract §D). Modelled
// line for line on tests/api/admin-jev-gold.test.ts: the shared proxy-based
// Supabase fake, the __adminAuthed switch, the next/server `connection`
// stub, a per-test nextIp() so the rate limiter does not bleed between
// tests, and ORIGINAL_ENV save/restore.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  requestId: 4711 as number | null,
  rpcError: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      jev_regression_freeze: () => {
        if (dbState.rpcError) {
          return { data: null, error: { message: "statement timeout" } };
        }
        return { data: [{ articles_inserted: 12, pairs_inserted: 4 }], error: null };
      },
      jev_regression_trigger: () => {
        if (dbState.rpcError) {
          return { data: null, error: { message: "pg_net is not installed" } };
        }
        return { data: dbState.requestId, error: null };
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

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __adminAuthed = true;
  dbState.requestId = 4711;
  dbState.rpcError = false;
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
  return `203.0.113.${ipCounter}`;
}

function postRequest(path: string, body: unknown, ip = nextIp()): Request {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** A Request whose `.json()` throws unconditionally — proves the body is
 * never read when the caller is unauthenticated. */
function poisonedRequest(path: string, ip = nextIp()): Request {
  const req = new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: "irrelevant",
  });
  Object.defineProperty(req, "json", {
    value: () => {
      throw new Error("body must never be read here");
    },
  });
  return req;
}

describe("POST /api/admin/jev-regression/freeze", () => {
  it("POST /api/admin/jev-regression/freeze 401s when unauthenticated and never calls the RPC", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-regression/freeze/route");

    const res = await mod.POST(poisonedRequest("/api/admin/jev-regression/freeze"));

    expect(res.status).toBe(401);
    expect(supabaseFake.calls.rpc.some((c) => c.name === "jev_regression_freeze")).toBe(false);
  });

  it("POST /api/admin/jev-regression/freeze 200s with the inserted counts from the RPC", async () => {
    const mod = await import("@/app/api/admin/jev-regression/freeze/route");

    const res = await mod.POST(postRequest("/api/admin/jev-regression/freeze", {}));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, articles: 12, pairs: 4 });
  });

  it("POST /api/admin/jev-regression/freeze calls jev_regression_freeze with no arguments", async () => {
    const mod = await import("@/app/api/admin/jev-regression/freeze/route");
    await mod.POST(postRequest("/api/admin/jev-regression/freeze", {}));

    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_regression_freeze");
    expect(call).toBeDefined();
    expect(call!.args).toBeUndefined();
  });

  it("POST /api/admin/jev-regression/freeze 500s when the RPC errors", async () => {
    dbState.rpcError = true;
    const mod = await import("@/app/api/admin/jev-regression/freeze/route");

    const res = await mod.POST(postRequest("/api/admin/jev-regression/freeze", {}));

    expect(res.status).toBe(500);
  });

  it("POST /api/admin/jev-regression/freeze returns 429 after 3 posts from one IP, on the 4th", async () => {
    const mod = await import("@/app/api/admin/jev-regression/freeze/route");
    const ip = "198.51.100.10";

    for (let i = 0; i < 3; i++) {
      const res = await mod.POST(postRequest("/api/admin/jev-regression/freeze", {}, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(postRequest("/api/admin/jev-regression/freeze", {}, ip));
    expect(res.status).toBe(429);
  });
});

describe("POST /api/admin/jev-regression/run", () => {
  it("POST /api/admin/jev-regression/run 401s when unauthenticated and never calls the RPC", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-regression/run/route");

    const res = await mod.POST(poisonedRequest("/api/admin/jev-regression/run"));

    expect(res.status).toBe(401);
    expect(supabaseFake.calls.rpc.some((c) => c.name === "jev_regression_trigger")).toBe(false);
  });

  it("POST /api/admin/jev-regression/run 200s with the pg_net request id", async () => {
    dbState.requestId = 4711;
    const mod = await import("@/app/api/admin/jev-regression/run/route");

    const res = await mod.POST(postRequest("/api/admin/jev-regression/run", {}));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, request_id: 4711 });
  });

  it("POST /api/admin/jev-regression/run 200s with request_id null when the RPC returns null", async () => {
    dbState.requestId = null;
    const mod = await import("@/app/api/admin/jev-regression/run/route");

    const res = await mod.POST(postRequest("/api/admin/jev-regression/run", {}));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, request_id: null });
  });

  it("POST /api/admin/jev-regression/run calls jev_regression_trigger with no arguments", async () => {
    const mod = await import("@/app/api/admin/jev-regression/run/route");
    await mod.POST(postRequest("/api/admin/jev-regression/run", {}));

    const call = supabaseFake.calls.rpc.find((c) => c.name === "jev_regression_trigger");
    expect(call).toBeDefined();
    expect(call!.args).toBeUndefined();
  });

  it("POST /api/admin/jev-regression/run returns 429 after 3 posts from one IP, on the 4th", async () => {
    const mod = await import("@/app/api/admin/jev-regression/run/route");
    const ip = "198.51.100.20";

    for (let i = 0; i < 3; i++) {
      const res = await mod.POST(postRequest("/api/admin/jev-regression/run", {}, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(postRequest("/api/admin/jev-regression/run", {}, ip));
    expect(res.status).toBe(429);
  });
});

describe("malformed body handling", () => {
  it("both routes swallow a malformed body instead of 400ing", async () => {
    const freezeMod = await import("@/app/api/admin/jev-regression/freeze/route");
    const runMod = await import("@/app/api/admin/jev-regression/run/route");

    const freezeRes = await freezeMod.POST(
      postRequest("/api/admin/jev-regression/freeze", "{not json"),
    );
    expect(freezeRes.status).toBe(200);

    const runRes = await runMod.POST(postRequest("/api/admin/jev-regression/run", "{not json"));
    expect(runRes.status).toBe(200);
  });
});
