import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract test for POST /api/admin/jev-alerts/ack (pack "Sinyaller",
// migration 065, W3). Modelled line for line on tests/api/admin-jev-gold.test.ts:
// the shared proxy-based Supabase fake, the __adminAuthed switch, the
// next/server `connection` shim, and a per-test nextIp() so the rate
// limiter does not bleed between tests.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  notFound: false,
  dbError: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      jev_alerts: () => {
        if (dbState.dbError) {
          return { data: null, error: { message: "connection reset" } } as never;
        }
        if (dbState.notFound) {
          return { data: [], error: null };
        }
        return { data: [{ id: 1 }], error: null };
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
  dbState.notFound = false;
  dbState.dbError = false;
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
  return `203.0.113.${ipCounter}`;
}

function postRequest(path: string, body: unknown, ip = nextIp()): Request {
  return new Request(`http://example.com${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/admin/jev-alerts/ack", () => {
  it("401s when unauthenticated and never touches the DB", async () => {
    __adminAuthed = false;
    const mod = await import("@/app/api/admin/jev-alerts/ack/route");

    const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", { id: 1 }));

    expect(res.status).toBe(401);
    expect(supabaseFake.calls.forTable("jev_alerts")).toHaveLength(0);
  });

  it("400s on malformed JSON", async () => {
    const mod = await import("@/app/api/admin/jev-alerts/ack/route");
    const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", "{not json"));
    expect(res.status).toBe(400);
  });

  it("400s on a non-integer id, a negative id, id 0 and a string id, without mutating", async () => {
    const mod = await import("@/app/api/admin/jev-alerts/ack/route");

    const bad = [{ id: 1.5 }, { id: -1 }, { id: 0 }, { id: "1" }, {}, { id: null }];

    for (const body of bad) {
      const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", body));
      expect(res.status).toBe(400);
    }

    expect(supabaseFake.calls.forTable("jev_alerts")).toHaveLength(0);
  });

  it("200s and sets acknowledged_at only where it is still null", async () => {
    const mod = await import("@/app/api/admin/jev-alerts/ack/route");

    const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", { id: 1 }));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const updates = supabaseFake.calls.update("jev_alerts");
    expect(updates).toHaveLength(1);
    const call = updates[0]!;
    const patch = call.patch as { acknowledged_at: string };
    expect(new Date(patch.acknowledged_at).toISOString()).toBe(patch.acknowledged_at);
    expect(call.state.eq).toContainEqual({ col: "id", val: 1 });
    expect(call.state.is).toContainEqual({ col: "acknowledged_at", val: null });
  });

  it("404s when the update matched no row", async () => {
    dbState.notFound = true;
    const mod = await import("@/app/api/admin/jev-alerts/ack/route");

    const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", { id: 999 }));

    expect(res.status).toBe(404);
  });

  it("returns 429 after 20 successful posts from one IP, on the 21st", async () => {
    const mod = await import("@/app/api/admin/jev-alerts/ack/route");
    const ip = "198.51.100.99";
    for (let i = 0; i < 20; i++) {
      const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", { id: 1 }, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(postRequest("/api/admin/jev-alerts/ack", { id: 1 }, ip));
    expect(res.status).toBe(429);
  });
});
