import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { hashSessionId } from "@/lib/game/framing";

// ---------------------------------------------------------------------------
// Contract tests for GET /api/oyun/cerceve/next and POST /api/oyun/cerceve
// (PACK D / R10, W2 — the Çerçeve game routes).
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/oyun.test.ts's convention. R0.2: the fake's `rpc()` resolves
// to a plain envelope, never chainable — routes must never chain
// `.single()`/`.maybeSingle()`/`.limit()` onto an `.rpc()` call.
// ---------------------------------------------------------------------------

// Wrapped in `vi.hoisted` (not plain `const`) because `cerceveState` below
// is also hoisted and reads these at hoist-eval time — a plain `const`
// here would still be in the TDZ when that hoisted callback runs.
const ELIGIBLE_ROW = vi.hoisted(() => ({
  article_id: "11111111-1111-1111-1111-111111111111",
  title: "Merkez bankası faiz kararını açıkladı",
}));
const PII_ROW = vi.hoisted(() => ({
  article_id: "22222222-2222-2222-2222-222222222222",
  title: "17 yaşındaki şüpheli gözaltına alındı",
}));
const TOTALS_ROW = vi.hoisted(() => ({ n: 10, iktidar: 5, muhalefet: 3, neutral_n: 2 }));

const cerceveState = vi.hoisted(() => ({
  // Queue of { data, error } envelopes consumed (shift) by
  // framing_next_headline, one per RPC call. Falls back to
  // `nextDefault` once drained.
  nextQueue: [] as Array<{ data: unknown; error: { message: string } | null }>,
  nextDefault: { data: [ELIGIBLE_ROW], error: null } as {
    data: unknown;
    error: { message: string } | null;
  },
  forceUpsertError: false,
  // Set to a Postgres error code (e.g. "23503") to make the upsert fail
  // with that specific code instead of the generic "upsert boom" message.
  forceUpsertErrorCode: null as string | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      framing_votes: () => {
        if (cerceveState.forceUpsertErrorCode) {
          return {
            data: null,
            error: {
              message: "insert or update on table violates foreign key constraint",
              code: cerceveState.forceUpsertErrorCode,
            },
          };
        }
        return cerceveState.forceUpsertError
          ? { data: null, error: { message: "upsert boom" } }
          : { data: [], error: null };
      },
    },
    rpc: {
      framing_next_headline: () => {
        if (cerceveState.nextQueue.length > 0) {
          return cerceveState.nextQueue.shift()!;
        }
        return cerceveState.nextDefault;
      },
      framing_vote_totals: () => ({ data: [TOTALS_ROW], error: null }),
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
  cerceveState.nextQueue = [];
  cerceveState.forceUpsertError = false;
  cerceveState.forceUpsertErrorCode = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function makeGetRequest(ip: string, cookieValue?: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": ip };
  if (cookieValue) headers["Cookie"] = `tayf_cerceve_sid=${cookieValue}`;
  return new Request("http://example.com/api/oyun/cerceve/next", { headers });
}

function makePostRequest(body: unknown, ip: string, cookieValue?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-forwarded-for": ip,
  };
  if (cookieValue) headers["Cookie"] = `tayf_cerceve_sid=${cookieValue}`;
  return new Request("http://example.com/api/oyun/cerceve", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const VALID_VOTE_BODY = { article_id: ELIGIBLE_ROW.article_id, vote: "iktidar" };

describe("GET /api/oyun/cerceve/next", () => {
  it("returns {article_id, title} from the RPC and sets an HttpOnly session cookie when none is present", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const res = await mod.GET(makeGetRequest("198.51.100.1"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ article_id: ELIGIBLE_ROW.article_id, title: ELIGIBLE_ROW.title });

    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toMatch(/tayf_cerceve_sid=[0-9a-f]{32}/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reuses an existing valid session cookie and sets no new cookie", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const existing = "0123456789abcdef0123456789abcdef";
    const res = await mod.GET(makeGetRequest("198.51.100.2", existing));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("passes the sha256 session hash to the RPC, never the raw cookie value and never an IP", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const raw = "0123456789abcdef0123456789abcdef";
    const ip = "198.51.100.3";
    const res = await mod.GET(makeGetRequest(ip, raw));
    expect(res.status).toBe(200);

    const expectedHash = await hashSessionId(raw);
    const rpcCall = supabaseFake.calls.rpc.find((c) => c.name === "framing_next_headline");
    expect(rpcCall).toBeDefined();
    expect(rpcCall?.args).toEqual({ p_session_hash: expectedHash });
    const serialized = JSON.stringify(rpcCall?.args);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain(ip);
  });

  it("re-draws past a PII-matching headline and never returns a title isGameEligibleTitle rejects", async () => {
    cerceveState.nextQueue = [
      { data: [PII_ROW], error: null },
      { data: [ELIGIBLE_ROW], error: null },
    ];
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const res = await mod.GET(makeGetRequest("198.51.100.4"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ article_id: ELIGIBLE_ROW.article_id, title: ELIGIBLE_ROW.title });
    expect(body.title).not.toBe(PII_ROW.title);

    const rpcCalls = supabaseFake.calls.rpc.filter((c) => c.name === "framing_next_headline");
    expect(rpcCalls).toHaveLength(2);
  });

  it("returns {article_id: null, title: null} after three PII rejections", async () => {
    cerceveState.nextQueue = [
      { data: [PII_ROW], error: null },
      { data: [{ ...PII_ROW, article_id: "22222222-2222-2222-2222-222222222223" }], error: null },
      { data: [{ ...PII_ROW, article_id: "22222222-2222-2222-2222-222222222224" }], error: null },
    ];
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const res = await mod.GET(makeGetRequest("198.51.100.5"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ article_id: null, title: null });

    const rpcCalls = supabaseFake.calls.rpc.filter((c) => c.name === "framing_next_headline");
    expect(rpcCalls).toHaveLength(3);
  });

  it("returns {article_id: null, title: null} when the RPC has no eligible row", async () => {
    cerceveState.nextQueue = [{ data: [], error: null }];
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const res = await mod.GET(makeGetRequest("198.51.100.6"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ article_id: null, title: null });
  });

  it("returns 500 when the RPC errors, and never a silent empty payload", async () => {
    cerceveState.nextQueue = [{ data: null, error: { message: "rpc boom" } }];
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const res = await mod.GET(makeGetRequest("198.51.100.7"));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).not.toEqual({ article_id: null, title: null });
  });

  it("returns 429 with retryAfterMs after its bucket is exhausted", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const ip = "198.51.100.8";
    for (let i = 0; i < 60; i++) {
      const res = await mod.GET(makeGetRequest(ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.GET(makeGetRequest(ip));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.details.retryAfterMs).toBe("number");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("POST /api/oyun/cerceve", () => {
  it("upserts exactly {article_id, vote, session_hash} with ignoreDuplicates and returns only the crowd tally", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const raw = "abcdef0123456789abcdef0123456789";
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.10", raw));
    expect(res.status).toBe(200);

    const upserts = supabaseFake.calls.upsert("framing_votes");
    expect(upserts).toHaveLength(1);
    const expectedHash = await hashSessionId(raw);
    expect(upserts[0]?.patch).toEqual({
      article_id: VALID_VOTE_BODY.article_id,
      vote: VALID_VOTE_BODY.vote,
      session_hash: expectedHash,
    });

    const body = await res.json();
    expect(body).toEqual({ ok: true, totals: { n: 10, iktidar: 5, muhalefet: 3, none: 2 } });
  });

  it("response body has exactly the keys ok and totals, and totals exactly n/iktidar/muhalefet/none", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.11"));
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["ok", "totals"]);
    expect(Object.keys(body.totals).sort()).toEqual(["iktidar", "muhalefet", "n", "none"]);
  });

  it("mints a session cookie when the request has none but does NOT record the vote", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.12"));
    expect(res.status).toBe(200);
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).not.toBeNull();
    expect(setCookie).toMatch(/tayf_cerceve_sid=[0-9a-f]{32}/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(supabaseFake.calls.upsert("framing_votes")).toHaveLength(0);
    expect((await res.json()).ok).toBe(false);
  });

  it("returns 400 with no Supabase call for an unknown vote value", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const res = await mod.POST(
      makePostRequest(
        { article_id: ELIGIBLE_ROW.article_id, vote: "tarafsiz" },
        "198.51.100.13",
      ),
    );
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 400 with no Supabase call for a malformed article_id", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const res = await mod.POST(
      makePostRequest({ article_id: "not-a-uuid", vote: "iktidar" }, "198.51.100.14"),
    );
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("returns 400 for a malformed JSON body", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const res = await mod.POST(makePostRequest("{not json", "198.51.100.15"));
    expect(res.status).toBe(400);
    expect(supabaseFake.calls.mutations).toHaveLength(0);
  });

  it("returns 429 with retryAfterMs after 30 votes from the same key", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const ip = "198.51.100.16";
    for (let i = 0; i < 30; i++) {
      const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, ip));
      expect(res.status).toBe(200);
    }
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, ip));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.details.retryAfterMs).toBe("number");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 500, not a silent 200, when the upsert fails", async () => {
    cerceveState.forceUpsertError = true;
    const mod = await import("@/app/api/oyun/cerceve/route");
    const raw = "abcdef0123456789abcdef0123456789";
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.17", raw));
    expect(res.status).toBe(500);
  });

  it("returns 400 (not 500) when the upsert fails on a foreign-key violation for a non-existent article_id", async () => {
    cerceveState.forceUpsertErrorCode = "23503";
    const mod = await import("@/app/api/oyun/cerceve/route");
    const raw = "abcdef0123456789abcdef0123456789";
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.19", raw));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("Invalid article_id");
  });
});

describe("PII guard", () => {
  it("neither route ever writes an ip, user agent or raw cookie value into framing_votes", async () => {
    const postMod = await import("@/app/api/oyun/cerceve/route");
    const raw = "fedcba9876543210fedcba9876543210";
    const ip = "198.51.100.18";
    const res = await postMod.POST(
      new Request("http://example.com/api/oyun/cerceve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
          "user-agent": "TestAgent/1.0",
          Cookie: `tayf_cerceve_sid=${raw}`,
        },
        body: JSON.stringify(VALID_VOTE_BODY),
      }),
    );
    expect(res.status).toBe(200);

    const upserts = supabaseFake.calls.upsert("framing_votes");
    expect(upserts).toHaveLength(1);
    const patch = upserts[0]?.patch as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(["article_id", "session_hash", "vote"]);
    const serialized = JSON.stringify(patch);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain(ip);
    expect(serialized).not.toContain("TestAgent");
  });
});
