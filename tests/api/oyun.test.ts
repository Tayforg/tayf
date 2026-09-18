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
        const found = [ARTICLE_IKTIDAR, ARTICLE_MUHALEFET].find(
          (a) => a.id === idPred?.val,
        );
        return { data: found ?? null, error: null };
      },
      zone_guesses: () =>
        dbState.forceInsertError
          ? { data: null, error: { message: "insert boom" } }
          : { data: [], error: null },
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
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  dbState.forceInsertError = false;
  dbState.forceSelectError = false;
  articlesLookupCount.n = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
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
