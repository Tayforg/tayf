import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/corrections.
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/admin.test.ts / tests/api/cron/headline.test.ts convention.
// ---------------------------------------------------------------------------

// Mutable so a single test can force the insert to fail (DB-error branch)
// without needing a second fake instance / module reset.
const dbState = vi.hoisted(() => ({ forceInsertError: false }));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      corrections: () =>
        dbState.forceInsertError
          ? { data: null, error: { message: "boom" } }
          : { data: [], error: null },
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  dbState.forceInsertError = false;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function makeRequest(body: unknown, ip = "203.0.113.1"): Request {
  return new Request("http://example.com/api/corrections", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  url: "https://www.tayfhaber.com/cluster/abc",
  message: "Bu başlık yanlış bilgi içeriyor, lütfen düzeltin.",
};

describe("POST /api/corrections", () => {
  it("returns 201 and inserts on the happy path", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.1"));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toEqual({ ok: true });

    const inserts = supabaseFake.calls.insert("corrections");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.patch).toMatchObject({
      url: VALID_BODY.url,
      message: VALID_BODY.message,
      email: null,
      cluster_id: null,
    });
  });

  it("returns 400 for a message shorter than 10 characters", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, message: "too short" }, "198.51.100.2"),
    );
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(0);
  });

  it("returns 400 for a malformed url", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, url: "not-a-url" }, "198.51.100.3"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed email", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, email: "not-an-email" }, "198.51.100.4"),
    );
    expect(res.status).toBe(400);
  });

  it("honeypot: returns 200 without inserting when website is filled in", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, website: "http://spam.example" }, "198.51.100.5"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(0);
  });

  it("returns 429 after 5 requests from the same client within the window", async () => {
    const mod = await import("@/app/api/corrections/route");
    const ip = "198.51.100.6";
    for (let i = 0; i < 5; i++) {
      const res = await mod.POST(makeRequest(VALID_BODY, ip));
      expect(res.status).toBe(201);
    }
    const res = await mod.POST(makeRequest(VALID_BODY, ip));
    expect(res.status).toBe(429);
  });

  it("returns 400 for a message longer than 2000 characters, and 201 at exactly 2000", async () => {
    const mod = await import("@/app/api/corrections/route");

    const tooLong = await mod.POST(
      makeRequest({ ...VALID_BODY, message: "a".repeat(2001) }, "198.51.100.7"),
    );
    expect(tooLong.status).toBe(400);

    const exact = await mod.POST(
      makeRequest({ ...VALID_BODY, message: "a".repeat(2000) }, "198.51.100.8"),
    );
    expect(exact.status).toBe(201);
  });

  it("returns 400 for a url longer than 512 characters", async () => {
    const mod = await import("@/app/api/corrections/route");
    const longUrl = "https://example.com/" + "a".repeat(500);
    expect(longUrl.length).toBeGreaterThan(512);
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, url: longUrl }, "198.51.100.9"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a non-http(s) url scheme", async () => {
    const mod = await import("@/app/api/corrections/route");

    const js = await mod.POST(
      makeRequest({ ...VALID_BODY, url: "javascript:alert(1)" }, "198.51.100.10"),
    );
    expect(js.status).toBe(400);

    const ftp = await mod.POST(
      makeRequest({ ...VALID_BODY, url: "ftp://example.com/file" }, "198.51.100.11"),
    );
    expect(ftp.status).toBe(400);
  });

  it("returns 400 for an email longer than 254 characters", async () => {
    const mod = await import("@/app/api/corrections/route");
    const longEmail = "a".repeat(250) + "@x.com";
    expect(longEmail.length).toBeGreaterThan(254);
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, email: longEmail }, "198.51.100.12"),
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const mod = await import("@/app/api/corrections/route");
    const req = new Request("http://example.com/api/corrections", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.13" },
      body: "{not json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 500 when the database insert fails", async () => {
    dbState.forceInsertError = true;
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.14"));
    expect(res.status).toBe(500);
  });

  it("persists a valid email and a valid clusterId", async () => {
    const mod = await import("@/app/api/corrections/route");
    const clusterId = "11111111-2222-3333-4444-555555555555";
    const res = await mod.POST(
      makeRequest(
        { ...VALID_BODY, email: "reader@example.com", clusterId },
        "198.51.100.15",
      ),
    );
    expect(res.status).toBe(201);
    const inserts = supabaseFake.calls.insert("corrections");
    expect(inserts.at(-1)?.patch).toMatchObject({
      email: "reader@example.com",
      cluster_id: clusterId,
    });
  });
});
