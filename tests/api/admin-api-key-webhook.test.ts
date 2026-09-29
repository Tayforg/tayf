import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// POST / DELETE /api/admin/api-keys/webhook. Harness: the admin-session mock
// and shared Supabase fake from tests/api/admin-api-keys.test.ts, plus a mocked
// node:dns so assertPublicHost never touches the network.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  keys: [
    { id: 7, revoked_at: null as string | null },
    { id: 8, revoked_at: "2026-09-01T00:00:00.000Z" as string | null },
  ],
  webhookError: null as { message: string } | null,
}));

const dnsState = vi.hoisted(() => ({
  lookup: null as unknown as ReturnType<typeof import("vitest").vi.fn>,
}));

vi.mock("node:dns", async () => {
  const { vi: v } = await import("vitest");
  dnsState.lookup = v.fn(async () => [{ address: "93.184.216.34", family: 4 }]);
  const promises = { lookup: (...a: unknown[]) => (dnsState.lookup as (...x: unknown[]) => unknown)(...a) };
  return { default: { promises }, promises };
});

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      api_keys: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        const live = state.is.find((i) => i.col === "revoked_at" && i.val === null);
        let rows = dbState.keys;
        if (idEq) rows = rows.filter((r) => r.id === idEq.val);
        if (live) rows = rows.filter((r) => r.revoked_at === null);
        return { data: rows, error: null };
      },
      api_key_webhooks: () => ({ data: null, error: dbState.webhookError }),
      api_key_webhook_deliveries: () => ({ data: null, error: null }),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({ createClient: () => supabaseFake.client }));
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
let ipCounter = 0;
const nextIp = () => `203.0.118.${1 + (++ipCounter % 250)}`;

let spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  __adminAuthed = true;
  dbState.webhookError = null;
  supabaseFake.calls.mutations.length = 0;
  spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function request(method: "POST" | "DELETE", body: unknown): Request {
  return new Request("http://example.com/api/admin/api-keys/webhook", {
    method,
    headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const GOOD_URL = "https://hooks.example.com/tayf";

async function post(body: unknown) {
  const { POST } = await import("@/app/api/admin/api-keys/webhook/route");
  return POST(request("POST", body));
}
async function del(body: unknown) {
  const { DELETE } = await import("@/app/api/admin/api-keys/webhook/route");
  return DELETE(request("DELETE", body));
}

describe("POST /api/admin/api-keys/webhook", () => {
  it("401 without an admin session and never touches Supabase or DNS", async () => {
    __adminAuthed = false;
    const res = await post({ keyId: 7, url: GOOD_URL });
    expect(res.status).toBe(401);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(dnsState.lookup).not.toHaveBeenCalled();
  });

  it.each([
    ["bad JSON", "{not json"],
    ["array body", []],
    ["no keyId", { url: GOOD_URL }],
    ["string keyId", { keyId: "7", url: GOOD_URL }],
    ["fractional keyId", { keyId: 7.5, url: GOOD_URL }],
    ["no url", { keyId: 7 }],
    ["non-string url", { keyId: 7, url: 42 }],
  ])("400 for %s", async (_label, body) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it.each([
    "http://hooks.example.com/x",
    "https://user:pw@hooks.example.com/x",
    "https://1.2.3.4/x",
    "https://hooks.example.com:8443/x",
    "https://localhost/x",
    "https://a.internal/x",
    "https://hooks.example.com/x#frag",
  ])("400 'Invalid webhook URL' for %s, without echoing a reason", async (url) => {
    const res = await post({ keyId: 7, url });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text).error).toBe("Invalid webhook URL");
    expect(text).not.toMatch(/userinfo|ip_literal|not_https|port|internal|fragment|localhost/i);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("400 when DNS resolves to a private address (10.0.0.5)", async () => {
    dnsState.lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }]);
    const res = await post({ keyId: 7, url: GOOD_URL });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid webhook URL");
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("400 when one of several answers is private, or the name does not resolve", async () => {
    dnsState.lookup.mockResolvedValueOnce([
      { address: "93.184.216.34", family: 4 },
      { address: "192.168.1.9", family: 4 },
    ]);
    expect((await post({ keyId: 7, url: GOOD_URL })).status).toBe(400);
    dnsState.lookup.mockRejectedValueOnce(new Error("ENOTFOUND"));
    expect((await post({ keyId: 7, url: GOOD_URL })).status).toBe(400);
  });

  it("404 for a revoked key and for an unknown key", async () => {
    expect((await post({ keyId: 8, url: GOOD_URL })).status).toBe(404);
    expect((await post({ keyId: 999, url: GOOD_URL })).status).toBe(404);
    expect(supabaseFake.calls.upsert("api_key_webhooks")).toHaveLength(0);
  });

  it("200 returns host and a fresh secret that equals the upserted value", async () => {
    const res = await post({ keyId: 7, url: GOOD_URL });
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, key_id: 7, host: "hooks.example.com" });
    expect(body.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(body).not.toHaveProperty("url");

    const ups = supabaseFake.calls.upsert("api_key_webhooks");
    expect(ups).toHaveLength(1);
    const patch = ups[0]!.patch as Record<string, unknown>;
    expect(patch).toMatchObject({
      key_id: 7,
      url: GOOD_URL,
      secret: body.secret,
      enabled: true,
      fail_streak: 0,
      disabled_reason: null,
    });
  });

  it("issues a different secret on every registration", async () => {
    const a = await (await post({ keyId: 7, url: GOOD_URL })).json();
    const b = await (await post({ keyId: 7, url: GOOD_URL })).json();
    expect(a.secret).not.toBe(b.secret);
  });

  it("500 (generic) when the upsert fails, never echoing the secret", async () => {
    dbState.webhookError = { message: "db down" };
    const res = await post({ keyId: 7, url: GOOD_URL });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toMatch(/whsec_/);
  });

  it("never logs the secret or the URL path", async () => {
    const body = await (await post({ keyId: 7, url: "https://hooks.example.com/private-token-path" })).json();
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((a) => a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "))
      .join("\n");
    expect(logged).not.toContain(body.secret);
    expect(logged).not.toContain("private-token-path");
  });
});

describe("DELETE /api/admin/api-keys/webhook", () => {
  it("401 without a session", async () => {
    __adminAuthed = false;
    expect((await del({ keyId: 7 })).status).toBe(401);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("400 for an invalid keyId", async () => {
    expect((await del({ keyId: "x" })).status).toBe(400);
    expect((await del("{oops")).status).toBe(400);
  });

  it("deletes the webhook row and its unsent deliveries, accepting the POST body shape", async () => {
    const res = await del({ keyId: 7, url: GOOD_URL });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, key_id: 7 });
    const hookDel = supabaseFake.calls.delete("api_key_webhooks");
    expect(hookDel).toHaveLength(1);
    expect(hookDel[0]!.state.eq).toContainEqual({ col: "key_id", val: 7 });
    const queueDel = supabaseFake.calls.delete("api_key_webhook_deliveries");
    expect(queueDel).toHaveLength(1);
    expect(queueDel[0]!.state.eq).toContainEqual({ col: "key_id", val: 7 });
    expect(queueDel[0]!.state.in).toContainEqual({ col: "status", vals: ["pending", "sending"] });
  });
});
