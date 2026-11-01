import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/corrections.
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/admin.test.ts / tests/api/cron/headline.test.ts convention.
// ---------------------------------------------------------------------------

// Mutable so a single test can force the insert to fail (DB-error branch)
// without needing a second fake instance / module reset.
const dbState = vi.hoisted(() => ({
  forceInsertError: false,
  // Foreign-key violation (SQLSTATE 23503) on any insert that carries a
  // non-null cluster_id — a stale `?cluster=` id the reader's page never
  // validated. The same row with cluster_id null inserts fine.
  fkFail: false,
  // Fails EVERY insert with this error, whatever cluster_id it carries.
  insertError: null as null | { code?: string; message: string },
  // Fails only inserts WITHOUT a cluster_id (the retry after an FK violation).
  nullClusterError: null as null | { code?: string; message: string },
  // Wired to the fake's call log right after it is built (below). The shared
  // fake clears `state.mutation` before it asks a fixture for its result, so
  // a fixture cannot branch on `state.mutation.patch`; the mutation is
  // committed to the call log first, so the fixture reads the latest insert
  // from there instead.
  lastInsertPatch: (() => null) as () => Record<string, unknown> | null,
  // Drives the `api_throttle` RPC fixture (migration 118): allow, deny (the
  // per-client hourly bucket is full -> 120 s retry), or error (the RPC
  // itself fails; the route must fail OPEN).
  throttle: "allow" as "allow" | "deny" | "error",
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      corrections: () => {
        if (dbState.forceInsertError) {
          return { data: null, error: { message: "boom" } };
        }
        if (dbState.insertError) {
          return { data: null, error: dbState.insertError };
        }
        const patch = dbState.lastInsertPatch();
        if (dbState.fkFail && patch?.cluster_id != null) {
          return { data: null, error: { code: "23503", message: "fk" } };
        }
        if (dbState.nullClusterError && patch?.cluster_id == null) {
          return { data: null, error: dbState.nullClusterError };
        }
        return { data: [], error: null };
      },
    },
    rpc: {
      api_throttle: () => {
        if (dbState.throttle === "error") {
          return { data: null, error: { code: "57014", message: "statement timeout" } };
        }
        return dbState.throttle === "deny"
          ? { data: [{ allowed: false, retry_after_seconds: 120 }], error: null }
          : { data: [{ allowed: true, retry_after_seconds: 0 }], error: null };
      },
    },
  });
});

dbState.lastInsertPatch = () =>
  (supabaseFake.calls.insert("corrections").at(-1)?.patch ?? null) as Record<
    string,
    unknown
  > | null;

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
  // The DB throttle HMACs the client key with this; without it the throttle
  // degrades (fail-open) and never calls the RPC.
  process.env.ADMIN_SESSION_SECRET = "corrections-test-secret-0123456789";
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  dbState.forceInsertError = false;
  dbState.fkFail = false;
  dbState.insertError = null;
  dbState.nullClusterError = null;
  dbState.throttle = "allow";
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ADMIN_SESSION_SECRET",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
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
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect((await res.json()).details.retryAfterMs).toBeGreaterThan(0);
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

// ---------------------------------------------------------------------------
// Fleet-wide DB throttle (migration 118, web-2). The in-memory limiter above
// is the first filter; behind it, 5 accepted submissions per hour per client
// are enforced in Postgres so the cap holds across every Vercel instance. It
// runs AFTER the honeypot and all validation, so a bot or a malformed body
// never spends (or learns about) a DB round-trip.
// ---------------------------------------------------------------------------

function throttleCalls() {
  return supabaseFake.calls.rpc.filter((c) => c.name === "api_throttle");
}

describe("POST /api/corrections DB throttle (migration 118)", () => {
  it("denied -> 429 via apiTooManyRequests with Retry-After from the DB, and no insert", async () => {
    dbState.throttle = "deny";
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.40"));

    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({
      error: "Too many requests",
      details: { retryAfterMs: 120_000 },
    });
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(0);
  });

  it("the DB 429 has the same body shape as the in-memory 429", async () => {
    const mod = await import("@/app/api/corrections/route");
    const ip = "198.51.100.41";
    for (let i = 0; i < 5; i++) await mod.POST(makeRequest(VALID_BODY, ip));
    const inMemory = await mod.POST(makeRequest(VALID_BODY, ip));
    expect(inMemory.status).toBe(429);

    dbState.throttle = "deny";
    const viaDb = await mod.POST(makeRequest(VALID_BODY, "198.51.100.42"));
    expect(viaDb.status).toBe(429);

    const a = await inMemory.json();
    const b = await viaDb.json();
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
    expect(Object.keys(a.details).sort()).toEqual(Object.keys(b.details).sort());
    expect(a.error).toBe(b.error);
    expect(inMemory.headers.get("Cache-Control")).toBe(viaDb.headers.get("Cache-Control"));
  });

  it("the in-memory limiter stays the first filter: its 429 never reaches the DB", async () => {
    const mod = await import("@/app/api/corrections/route");
    const ip = "198.51.100.43";
    for (let i = 0; i < 5; i++) await mod.POST(makeRequest(VALID_BODY, ip));
    expect(throttleCalls()).toHaveLength(5);

    const res = await mod.POST(makeRequest(VALID_BODY, ip));
    expect(res.status).toBe(429);
    expect(throttleCalls()).toHaveLength(5);
  });

  it("allowed -> 201 and the row is inserted", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.44"));
    expect(res.status).toBe(201);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
  });

  it("fails OPEN: an RPC error still inserts and returns 201", async () => {
    dbState.throttle = "error";
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.45"));
    expect(res.status).toBe(201);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
  });

  it("fails OPEN: a missing ADMIN_SESSION_SECRET skips the RPC and still inserts", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.46"));
    expect(res.status).toBe(201);
    expect(throttleCalls()).toHaveLength(0);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
  });

  it("uses the 'corrections:all' bucket at 5 per hour and sends only an HMAC digest, never the IP", async () => {
    const mod = await import("@/app/api/corrections/route");
    await mod.POST(makeRequest(VALID_BODY, "203.0.113.1"));

    const calls = throttleCalls();
    expect(calls).toHaveLength(1);
    const args = calls[0]?.args as Record<string, unknown>;
    expect(args).toMatchObject({
      p_bucket: "corrections:all",
      p_limit: 5,
      p_window_seconds: 3600,
    });
    expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(args)).not.toContain("203.0.113.1");
  });

  it("honeypot: returns 200 and makes no throttle call", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(
      makeRequest({ ...VALID_BODY, website: "http://spam.example" }, "198.51.100.47"),
    );
    expect(res.status).toBe(200);
    expect(throttleCalls()).toHaveLength(0);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(0);
  });

  it("an invalid body returns 400 and makes no throttle call", async () => {
    const mod = await import("@/app/api/corrections/route");
    const bad: unknown[] = [
      { ...VALID_BODY, message: "too short" },
      { ...VALID_BODY, url: "not-a-url" },
      { ...VALID_BODY, email: "not-an-email" },
      { ...VALID_BODY, clusterId: "not-a-uuid" },
      "just a string",
    ];
    for (const [i, body] of bad.entries()) {
      const res = await mod.POST(makeRequest(body, `198.51.100.${50 + i}`));
      expect(res.status).toBe(400);
    }
    const malformed = await mod.POST(
      new Request("http://example.com/api/corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.60" },
        body: "{not json",
      }),
    );
    expect(malformed.status).toBe(400);

    expect(throttleCalls()).toHaveLength(0);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(0);
  });

  it("a database insert failure after an allowed throttle is still a 500", async () => {
    dbState.forceInsertError = true;
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.61"));
    expect(res.status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// A stale `?cluster=<uuid>` (a cluster that was deleted or merged away, or one
// that never existed) used to turn every submission into a 500: the insert
// violates corrections.cluster_id's foreign key (SQLSTATE 23503). The reader's
// correction is still worth keeping, so the route retries ONCE without the
// cluster link, logs a PII-free warning, and answers 201. Any other error, a
// 23503 without a cluster id, and a failing retry all stay 500.
// ---------------------------------------------------------------------------

const CLUSTER_ID = "11111111-2222-3333-4444-555555555555";
const FK_WARNING = "[corrections] unknown clusterId; stored without a cluster link";

/** Every console line the route wrote, flattened to text. */
function loggedText(): string {
  const all = [
    ...vi.mocked(console.warn).mock.calls,
    ...vi.mocked(console.error).mock.calls,
    ...vi.mocked(console.log).mock.calls,
    ...vi.mocked(console.info).mock.calls,
  ];
  return all
    .flat()
    .map((a) => (typeof a === "string" ? a : a instanceof Error ? a.message : JSON.stringify(a)))
    .join("\n");
}

describe("POST /api/corrections unknown clusterId (FK violation 23503)", () => {
  const withCluster = {
    ...VALID_BODY,
    email: "okur@example.com",
    clusterId: CLUSTER_ID,
  };

  it("retries once with cluster_id null (same url/message/email) and answers 201", async () => {
    dbState.fkFail = true;
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(withCluster, "198.51.100.70"));

    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true });

    const inserts = supabaseFake.calls.insert("corrections");
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.patch).toEqual({
      url: VALID_BODY.url,
      message: VALID_BODY.message,
      email: "okur@example.com",
      cluster_id: CLUSTER_ID,
    });
    expect(inserts[1]?.patch).toEqual({
      url: VALID_BODY.url,
      message: VALID_BODY.message,
      email: "okur@example.com",
      cluster_id: null,
    });
  });

  it("warns once with the fixed, PII-free message", async () => {
    dbState.fkFail = true;
    const mod = await import("@/app/api/corrections/route");
    await mod.POST(makeRequest(withCluster, "198.51.100.71"));

    expect(console.warn).toHaveBeenCalledWith(FK_WARNING);
    expect(
      vi.mocked(console.warn).mock.calls.filter((c) => c[0] === FK_WARNING),
    ).toHaveLength(1);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("checks the DB throttle exactly once, before the first insert (the retry does not spend a second token)", async () => {
    dbState.fkFail = true;
    const mod = await import("@/app/api/corrections/route");
    await mod.POST(makeRequest(withCluster, "198.51.100.72"));

    expect(throttleCalls()).toHaveLength(1);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(2);
  });

  it("a valid clusterId that exists inserts once and does not warn", async () => {
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(withCluster, "198.51.100.73"));

    expect(res.status).toBe(201);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalledWith(FK_WARNING);
  });

  it("23503 without a clusterId is not retried: 1 insert, 500", async () => {
    dbState.insertError = { code: "23503", message: "fk" };
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(VALID_BODY, "198.51.100.74"));

    expect(res.status).toBe(500);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalledWith(FK_WARNING);
  });

  it("any other error with a clusterId is not retried: 1 insert, 500", async () => {
    dbState.forceInsertError = true;
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(withCluster, "198.51.100.75"));

    expect(res.status).toBe(500);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
    expect(console.warn).not.toHaveBeenCalledWith(FK_WARNING);
  });

  it("a different SQLSTATE with a clusterId (e.g. 23505) is not retried either", async () => {
    dbState.insertError = { code: "23505", message: "duplicate" };
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(withCluster, "198.51.100.76"));

    expect(res.status).toBe(500);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(1);
  });

  it("retries only once: if the null-cluster retry also fails, the answer is 500 after exactly 2 inserts", async () => {
    dbState.insertError = { code: "23503", message: "fk" };
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(withCluster, "198.51.100.77"));

    expect(res.status).toBe(500);
    const inserts = supabaseFake.calls.insert("corrections");
    expect(inserts).toHaveLength(2);
    expect((inserts[1]?.patch as { cluster_id: unknown }).cluster_id).toBeNull();
  });

  it("a non-FK failure of the retry is a 500 as well", async () => {
    // First insert: FK violation; second (null cluster) insert: a plain error.
    dbState.fkFail = true;
    dbState.nullClusterError = { message: "boom" };
    const mod = await import("@/app/api/corrections/route");
    const res = await mod.POST(makeRequest(withCluster, "198.51.100.78"));

    expect(res.status).toBe(500);
    expect(supabaseFake.calls.insert("corrections")).toHaveLength(2);
  });

  it("no log line carries the reader's email or message, on the retry path or any failure path", async () => {
    const cases: Array<() => void> = [
      () => {
        dbState.fkFail = true;
      },
      () => {
        dbState.forceInsertError = true;
      },
      () => {
        dbState.insertError = { code: "23503", message: "fk" };
      },
    ];
    const mod = await import("@/app/api/corrections/route");
    for (const [i, arrange] of cases.entries()) {
      dbState.fkFail = false;
      dbState.forceInsertError = false;
      dbState.insertError = null;
      arrange();
      await mod.POST(makeRequest(withCluster, `198.51.100.${80 + i}`));
    }

    const text = loggedText();
    expect(text).not.toContain("okur@example.com");
    expect(text).not.toContain(VALID_BODY.message);
    expect(text).not.toContain(VALID_BODY.url);
  });
});
