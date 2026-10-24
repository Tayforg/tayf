import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for POST /api/oyun (U-03 zone-guessing game).
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/corrections.test.ts convention. The most important case in
// this file is the tampering test: a request body claiming `correct: true`
// on a wrong guess must still record `correct: false`, because `correct` is
// computed server-side from `sources.bias`, never trusted from the client.
// ---------------------------------------------------------------------------

const dbState = vi.hoisted(() => ({
  forceInsertError: false,
  forceSelectError: false,
  // Drives the `api_throttle` RPC fixture (migration 118): allow = every
  // bucket under its limit; denyAll = the per-client hourly bucket is full;
  // denySrc = only the per-outlet daily bucket is full; error = the RPC
  // itself fails (the route must fail OPEN).
  throttle: "allow" as "allow" | "denyAll" | "denySrc" | "error",
}));

// Two fixture articles, each joined to its source's bias exactly as the
// route's `.select("id, source_id, sources(bias)")` would return it.
const ARTICLE_IKTIDAR = vi.hoisted(() => ({
  id: "11111111-1111-1111-1111-111111111111",
  source_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  sources: { bias: "pro_government" }, // zone: iktidar
}));
const ARTICLE_MUHALEFET = vi.hoisted(() => ({
  id: "22222222-2222-2222-2222-222222222222",
  source_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  sources: { bias: "opposition" }, // zone: muhalefet
}));
// Not a real shape (Postgres hands uuids back lowercase) -- it exists only to
// pin that the per-outlet bucket name is lowercased defensively.
const ARTICLE_UPPER = vi.hoisted(() => ({
  id: "33333333-3333-3333-3333-333333333333",
  source_id: "DDDDDDDD-DDDD-DDDD-DDDD-DDDDDDDDDDDD",
  sources: { bias: "pro_government" },
}));
const WRONG_SOURCE_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const UNKNOWN_ARTICLE_ID = "99999999-9999-9999-9999-999999999999";

// Counts every `.from("articles")` lookup so the "no Supabase call on a
// validation failure" tests can prove the select never fired, not just that
// no insert happened.
const articlesLookupCount = vi.hoisted(() => ({ n: 0 }));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      articles: (state) => {
        articlesLookupCount.n++;
        if (dbState.forceSelectError) {
          return { data: null, error: { message: "select boom" } };
        }
        const idPred = state.eq.find((e) => e.col === "id");
        const found = [ARTICLE_IKTIDAR, ARTICLE_MUHALEFET, ARTICLE_UPPER].find(
          (a) => a.id === idPred?.val,
        );
        return { data: found ?? null, error: null };
      },
      zone_guesses: () =>
        dbState.forceInsertError
          ? { data: null, error: { message: "insert boom" } }
          : { data: [], error: null },
    },
    rpc: {
      api_throttle: (args) => {
        const bucket = String((args as { p_bucket?: unknown }).p_bucket ?? "");
        if (dbState.throttle === "error") {
          return { data: null, error: { code: "57014", message: "statement timeout" } };
        }
        const deny =
          (dbState.throttle === "denyAll" && bucket === "oyun:all") ||
          (dbState.throttle === "denySrc" && bucket.startsWith("oyun:src:"));
        return {
          data: [{ allowed: !deny, retry_after_seconds: deny ? 120 : 0 }],
          error: null,
        };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  // The DB throttle HMACs the client key with this; without it the throttle
  // degrades (fail-open) and never calls the RPC.
  process.env.ADMIN_SESSION_SECRET = "oyun-test-secret-0123456789abcdef";
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  dbState.forceInsertError = false;
  dbState.forceSelectError = false;
  dbState.throttle = "allow";
  articlesLookupCount.n = 0;
  vi.spyOn(console, "warn").mockImplementation(() => {});
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
  return new Request("http://example.com/api/oyun", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

const VALID_CORRECT_GUESS = {
  articleId: ARTICLE_IKTIDAR.id,
  sourceId: ARTICLE_IKTIDAR.source_id,
  guessedZone: "iktidar",
};

describe("POST /api/oyun", () => {
  it("inserts exactly one zone_guesses row with correct computed from the fixture's bias, not the request body", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(makeRequest(VALID_CORRECT_GUESS, "198.51.100.1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();

    const resBody = await res.json();
    expect(resBody).toEqual({ ok: true, correct: true, zone: "iktidar" });

    const inserts = supabaseFake.calls.insert("zone_guesses");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.patch).toEqual({
      article_id: ARTICLE_IKTIDAR.id,
      source_id: ARTICLE_IKTIDAR.source_id,
      guessed_zone: "iktidar",
      correct: true,
    });
  });

  it("tampering: a wrong guess whose body claims correct:true still records correct:false", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(
      makeRequest(
        {
          articleId: ARTICLE_IKTIDAR.id,
          sourceId: ARTICLE_IKTIDAR.source_id,
          guessedZone: "muhalefet", // wrong: the fixture's real zone is iktidar
          correct: true, // client-supplied lie — must be ignored entirely
        },
        "198.51.100.2",
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();

    const resBody = await res.json();
    expect(resBody.correct).toBe(false);
    expect(resBody.zone).toBe("iktidar");

    const inserts = supabaseFake.calls.insert("zone_guesses");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.patch).toMatchObject({ correct: false, guessed_zone: "muhalefet" });
  });

  it("returns 400 with no insert when sourceId does not match the article's real source_id", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(
      makeRequest(
        { articleId: ARTICLE_IKTIDAR.id, sourceId: WRONG_SOURCE_ID, guessedZone: "iktidar" },
        "198.51.100.3",
      ),
    );
    expect(res.status).toBe(400);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });

  it("returns 404 with no insert for an unknown articleId", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(
      makeRequest(
        {
          articleId: UNKNOWN_ARTICLE_ID,
          sourceId: ARTICLE_IKTIDAR.source_id,
          guessedZone: "iktidar",
        },
        "198.51.100.4",
      ),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });

  it("returns 400 with no Supabase call for a malformed articleId", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(
      makeRequest(
        { articleId: "not-a-uuid", sourceId: ARTICLE_IKTIDAR.source_id, guessedZone: "iktidar" },
        "198.51.100.5",
      ),
    );
    expect(res.status).toBe(400);
    expect(articlesLookupCount.n).toBe(0);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });

  it("returns 400 with no Supabase call for a missing field", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(
      makeRequest({ articleId: ARTICLE_IKTIDAR.id, guessedZone: "iktidar" }, "198.51.100.6"),
    );
    expect(res.status).toBe(400);
    expect(articlesLookupCount.n).toBe(0);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });

  it("returns 400 with no Supabase call for an invalid guessedZone", async () => {
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(
      makeRequest(
        { articleId: ARTICLE_IKTIDAR.id, sourceId: ARTICLE_IKTIDAR.source_id, guessedZone: "sol" },
        "198.51.100.7",
      ),
    );
    expect(res.status).toBe(400);
    expect(articlesLookupCount.n).toBe(0);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const mod = await import("@/app/api/oyun/route");
    const req = new Request("http://example.com/api/oyun", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": "198.51.100.8" },
      body: "{not json",
    });
    const res = await mod.POST(req);
    expect(res.status).toBe(400);
    expect(articlesLookupCount.n).toBe(0);
  });

  it("returns 429 with retryAfterMs after the 40-request bucket is exhausted", async () => {
    const mod = await import("@/app/api/oyun/route");
    const ip = "198.51.100.9";
    for (let i = 0; i < 40; i++) {
      const res = await mod.POST(makeRequest(VALID_CORRECT_GUESS, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(makeRequest(VALID_CORRECT_GUESS, ip));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toMatch(/^[1-9]\d*$/);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    const body = await res.json();
    expect(typeof body.details.retryAfterMs).toBe("number");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
  });

  it("the inserted row contains ONLY article_id, source_id, guessed_zone, correct (PII guard)", async () => {
    const mod = await import("@/app/api/oyun/route");
    await mod.POST(makeRequest(VALID_CORRECT_GUESS, "198.51.100.10"));
    const inserts = supabaseFake.calls.insert("zone_guesses");
    expect(inserts).toHaveLength(1);
    const keys = Object.keys(inserts[0]?.patch as Record<string, unknown>).sort();
    expect(keys).toEqual(["article_id", "correct", "guessed_zone", "source_id"]);
  });

  it("returns 500, not a silent 200, when the Supabase insert fails", async () => {
    dbState.forceInsertError = true;
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(makeRequest(VALID_CORRECT_GUESS, "198.51.100.11"));
    expect(res.status).toBe(500);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("returns 500 when the article lookup select fails", async () => {
    dbState.forceSelectError = true;
    const mod = await import("@/app/api/oyun/route");
    const res = await mod.POST(makeRequest(VALID_CORRECT_GUESS, "198.51.100.12"));
    expect(res.status).toBe(500);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Fleet-wide DB throttle (migration 118, web-2/web-3). The in-memory limiter
// above stays the first filter; behind it, a forged-guess flood is bounded by
// 40/hour per client (any outlet) and 3/day per client PER OUTLET, enforced in
// Postgres so it holds across every Vercel instance. A throttled guess is
// DROPPED SILENTLY: the response is byte-identical to a recorded one, so the
// client (and an attacker probing the limits) cannot tell the difference.
// ---------------------------------------------------------------------------

function throttleCalls(): Array<{ bucket: string; args: Record<string, unknown> }> {
  return supabaseFake.calls.rpc
    .filter((c) => c.name === "api_throttle")
    .map((c) => {
      const args = c.args as Record<string, unknown>;
      return { bucket: String(args.p_bucket), args };
    });
}

describe("POST /api/oyun DB throttle (migration 118)", () => {
  async function post(ip: string, body: unknown = VALID_CORRECT_GUESS) {
    const mod = await import("@/app/api/oyun/route");
    return mod.POST(makeRequest(body, ip));
  }

  it("records the guess when both buckets allow", async () => {
    const res = await post("198.51.100.20");
    expect(res.status).toBe(200);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(1);
  });

  it("per-client hourly bucket full: no insert, and a 200 body identical to the recorded case", async () => {
    const allowed = await post("198.51.100.21");
    const allowedText = await allowed.text();
    supabaseFake.calls.mutations.length = 0;

    dbState.throttle = "denyAll";
    const denied = await post("198.51.100.22");

    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
    expect(denied.status).toBe(200);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(denied.headers.get("Retry-After")).toBeNull();
    expect(denied.headers.get("set-cookie")).toBeNull();
    expect(await denied.text()).toBe(allowedText);
    expect(JSON.parse(allowedText)).toEqual({ ok: true, correct: true, zone: "iktidar" });
  });

  it("per-outlet daily bucket full: no insert, and an identical 200 body", async () => {
    const allowed = await post("198.51.100.23");
    const allowedText = await allowed.text();
    supabaseFake.calls.mutations.length = 0;

    dbState.throttle = "denySrc";
    const denied = await post("198.51.100.24");

    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
    expect(denied.status).toBe(200);
    expect(denied.headers.get("Cache-Control")).toBe("no-store");
    expect(await denied.text()).toBe(allowedText);
  });

  it("a throttled wrong guess still reveals the true zone (the response never depends on the throttle)", async () => {
    dbState.throttle = "denyAll";
    const res = await post("198.51.100.25", { ...VALID_CORRECT_GUESS, guessedZone: "muhalefet" });
    expect(await res.json()).toEqual({ ok: true, correct: false, zone: "iktidar" });
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(0);
  });

  it("fails OPEN: an RPC error still records the guess", async () => {
    dbState.throttle = "error";
    const res = await post("198.51.100.26");
    expect(res.status).toBe(200);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(1);
  });

  it("fails OPEN: a missing ADMIN_SESSION_SECRET skips the RPC and still records the guess", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const res = await post("198.51.100.27");
    expect(res.status).toBe(200);
    expect(throttleCalls()).toHaveLength(0);
    expect(supabaseFake.calls.insert("zone_guesses")).toHaveLength(1);
  });

  it("checks 'oyun:all' (40/h) first, then 'oyun:src:<source id>' (3/day), in that order", async () => {
    await post("198.51.100.28");

    const calls = throttleCalls();
    expect(calls.map((c) => c.bucket)).toEqual([
      "oyun:all",
      `oyun:src:${ARTICLE_IKTIDAR.source_id}`,
    ]);
    expect(calls[0]?.args).toMatchObject({ p_limit: 40, p_window_seconds: 3600 });
    expect(calls[1]?.args).toMatchObject({ p_limit: 3, p_window_seconds: 86_400 });
  });

  it("lowercases the source id in the per-outlet bucket name", async () => {
    await post("198.51.100.29", {
      articleId: ARTICLE_UPPER.id,
      sourceId: ARTICLE_UPPER.source_id,
      guessedZone: "iktidar",
    });

    const buckets = throttleCalls().map((c) => c.bucket);
    expect(buckets[1]).toBe("oyun:src:dddddddd-dddd-dddd-dddd-dddddddddddd");
    expect(buckets[1]).toMatch(/^[a-z0-9:_-]{1,80}$/);
  });

  it("does not spend a per-outlet check when the per-client bucket already denied", async () => {
    dbState.throttle = "denyAll";
    await post("198.51.100.30");

    expect(throttleCalls().map((c) => c.bucket)).toEqual(["oyun:all"]);
  });

  it("sends only an HMAC digest of the client key: 64-hex, never the IP", async () => {
    await post("203.0.113.1");

    const calls = throttleCalls();
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c.args)).not.toContain("203.0.113.1");
    }
    // Same client, same digest in both buckets (the DB keys on bucket + digest).
    expect(calls[0]?.args.p_key_hash).toBe(calls[1]?.args.p_key_hash);
  });

  it("never logs the IP when a guess is throttled, only the bucket prefix", async () => {
    dbState.throttle = "denySrc";
    await post("203.0.113.1");

    const warn = vi.mocked(console.warn);
    expect(warn).toHaveBeenCalledWith("[oyun] guess not recorded: throttled", {
      bucket: "oyun:src",
    });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("203.0.113.1");
    expect(logged).not.toContain(ARTICLE_IKTIDAR.source_id);
  });

  it("makes no throttle call for a request that fails validation", async () => {
    const bad = await post("198.51.100.31", { ...VALID_CORRECT_GUESS, sourceId: WRONG_SOURCE_ID });
    expect(bad.status).toBe(400);
    const unknown = await post("198.51.100.32", { ...VALID_CORRECT_GUESS, articleId: UNKNOWN_ARTICLE_ID });
    expect(unknown.status).toBe(404);
    expect(throttleCalls()).toHaveLength(0);
  });

  it("the insert payload is unchanged by the throttle (PII guard)", async () => {
    await post("198.51.100.33");
    const inserts = supabaseFake.calls.insert("zone_guesses");
    expect(Object.keys(inserts[0]?.patch as Record<string, unknown>).sort()).toEqual([
      "article_id",
      "correct",
      "guessed_zone",
      "source_id",
    ]);
  });
});
