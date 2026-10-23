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
  nextQueue: [] as Array<{
    data: unknown;
    error: { message: string; code?: string } | null;
  }>,
  nextDefault: { data: [ELIGIBLE_ROW], error: null } as {
    data: unknown;
    error: { message: string; code?: string } | null;
  },
  // When set, framing_next_headline THROWS this instead of resolving an
  // envelope (supabase-js can reject, e.g. with throwOnError or a transport
  // failure that escapes postgrest-js' own try/catch).
  nextThrow: null as unknown,
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
        if (cerceveState.nextThrow !== null) {
          throw cerceveState.nextThrow;
        }
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

const ADMIN_SECRET = "x".repeat(32);

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  // The session cookie is HMAC-signed with a key derived from this secret.
  process.env.ADMIN_SESSION_SECRET = ADMIN_SECRET;
  delete process.env.FRAMING_SESSION_SECRET;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  cerceveState.nextQueue = [];
  cerceveState.nextThrow = null;
  cerceveState.forceUpsertError = false;
  cerceveState.forceUpsertErrorCode = null;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "ADMIN_SESSION_SECRET",
    "FRAMING_SESSION_SECRET",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

/** `<id>.<hmac>` exactly as the routes mint it, under the CURRENT env secrets. */
async function signedCookie(id: string): Promise<string> {
  const { signSessionId } = await import("@/lib/game/framing-session");
  const value = await signSessionId(id);
  if (value === null) throw new Error("test setup: session signing unavailable");
  return value;
}

const SIGNED_COOKIE_RE = /^[0-9a-f]{32}\.[A-Za-z0-9_-]{43}$/;

/** The `tayf_cerceve_sid` value a response sets, or null when it sets none. */
function setCookieValue(res: Response): string | null {
  const header = res.headers.get("set-cookie");
  const m = header ? /tayf_cerceve_sid=([^;]*)/.exec(header) : null;
  return m ? (m[1] ?? null) : null;
}

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
    expect(setCookieValue(res)).toMatch(SIGNED_COOKIE_RE);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).toMatch(/Max-Age=2592000/);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("reuses an existing SIGNED session cookie and sets no new cookie", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const existing = await signedCookie("0123456789abcdef0123456789abcdef");
    const res = await mod.GET(makeGetRequest("198.51.100.2", existing));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("replaces a forged unsigned 32-hex cookie with a fresh signed one and never hashes the forged id", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const forgedId = "abababababababababababababababab";
    const res = await mod.GET(makeGetRequest("198.51.100.50", forgedId));
    expect(res.status).toBe(200);

    const minted = setCookieValue(res);
    expect(minted).toMatch(SIGNED_COOKIE_RE);
    expect((minted as string).split(".")[0]).not.toBe(forgedId);

    const rpcCall = supabaseFake.calls.rpc.find((c) => c.name === "framing_next_headline");
    expect(rpcCall?.args).not.toEqual({ p_session_hash: await hashSessionId(forgedId) });
    expect(rpcCall?.args).toEqual({
      p_session_hash: await hashSessionId((minted as string).split(".")[0] as string),
    });
  });

  it("replaces a cookie with a tampered signature", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const good = await signedCookie("0123456789abcdef0123456789abcdef");
    const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    const res = await mod.GET(makeGetRequest("198.51.100.51", tampered));
    expect(res.status).toBe(200);
    expect(setCookieValue(res)).toMatch(SIGNED_COOKIE_RE);
    expect(setCookieValue(res)).not.toBe(tampered);
  });

  it("without any usable secret still draws (200), sets the plain id cookie and warns once", async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const first = await mod.GET(makeGetRequest("198.51.100.52"));
    const second = await mod.GET(makeGetRequest("198.51.100.52"));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toEqual({
      article_id: ELIGIBLE_ROW.article_id,
      title: ELIGIBLE_ROW.title,
    });
    expect(setCookieValue(first)).toMatch(/^[0-9a-f]{32}$/);
    const unavailable = warn.mock.calls.filter(
      (args) => args[0] === "[oyun/cerceve] session signing unavailable",
    );
    expect(unavailable).toHaveLength(1);
  });

  it("passes the sha256 session hash to the RPC, never the raw cookie value and never an IP", async () => {
    const mod = await import("@/app/api/oyun/cerceve/next/route");
    const raw = "0123456789abcdef0123456789abcdef";
    const ip = "198.51.100.3";
    const res = await mod.GET(makeGetRequest(ip, await signedCookie(raw)));
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

  describe("draw timeout (cold-read resilience)", () => {
    const COOKIE_ID = "0123456789abcdef0123456789abcdef";
    // The SIGNED cookie value, built per test once the env secret is set.
    let COOKIE = "";
    beforeEach(async () => {
      COOKIE = await signedCookie(COOKIE_ID);
    });

    async function expectRetryable503(res: Response) {
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("5");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(await res.json()).toEqual({
        error: "Service unavailable",
        details: { retryAfterMs: 5000 },
      });
    }

    it("answers an AbortError from the aborted fetch with a retryable 503, not a 500", async () => {
      cerceveState.nextQueue = [
        {
          data: null,
          error: { message: "AbortError: The user aborted a request.", code: "" },
        },
      ];
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      // No cookie: a minted-cookie request must still NOT set one on a failure.
      const res = await mod.GET(makeGetRequest("198.51.100.20"));
      await expectRetryable503(res);
    });

    it("answers a TimeoutError (AbortSignal.timeout) with a retryable 503", async () => {
      cerceveState.nextQueue = [
        {
          data: null,
          error: {
            message: "TimeoutError: The operation was aborted due to timeout",
            code: "",
          },
        },
      ];
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.21", COOKIE));
      await expectRetryable503(res);
    });

    it("answers a Postgres statement timeout (57014) with a retryable 503", async () => {
      cerceveState.nextQueue = [
        {
          data: null,
          error: { message: "canceling statement due to statement timeout", code: "57014" },
        },
      ];
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.22", COOKIE));
      await expectRetryable503(res);
    });

    it("treats a THROWN abort/timeout the same way as a returned one", async () => {
      cerceveState.nextThrow = new DOMException(
        "The operation was aborted due to timeout",
        "TimeoutError",
      );
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.23"));
      await expectRetryable503(res);
    });

    it("keeps any other RPC error a 500 (no Retry-After)", async () => {
      cerceveState.nextQueue = [{ data: null, error: { message: "boom", code: "XX000" } }];
      vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.24"));
      expect(res.status).toBe(500);
      expect(res.headers.get("retry-after")).toBeNull();
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("keeps any other THROWN error a 500", async () => {
      cerceveState.nextThrow = new Error("kaboom");
      vi.spyOn(console, "error").mockImplementation(() => {});
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.25"));
      expect(res.status).toBe(500);
      expect(res.headers.get("retry-after")).toBeNull();
    });

    it("a timeout on the PII redraw (second RPC) is also a 503, never a partial 200", async () => {
      cerceveState.nextQueue = [
        { data: [PII_ROW], error: null },
        { data: null, error: { message: "AbortError: The user aborted a request.", code: "" } },
      ];
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.26", COOKIE));
      await expectRetryable503(res);
      expect(supabaseFake.calls.rpc.filter((c) => c.name === "framing_next_headline")).toHaveLength(2);
    });

    it("chains an AbortSignal onto the RPC", async () => {
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.27", COOKIE));
      expect(res.status).toBe(200);
      const call = supabaseFake.calls.rpc.find((c) => c.name === "framing_next_headline");
      expect(call?.signal).toBeInstanceOf(AbortSignal);
      expect(call?.signal?.aborted).toBe(false);
    });

    it("shares ONE deadline signal across PII redraws so the whole draw stays within the budget", async () => {
      cerceveState.nextQueue = [
        { data: [PII_ROW], error: null },
        { data: [ELIGIBLE_ROW], error: null },
      ];
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      const res = await mod.GET(makeGetRequest("198.51.100.28", COOKIE));
      expect(res.status).toBe(200);
      const rpcCalls = supabaseFake.calls.rpc.filter((c) => c.name === "framing_next_headline");
      expect(rpcCalls).toHaveLength(2);
      expect(rpcCalls[0]?.signal).toBeInstanceOf(AbortSignal);
      expect(rpcCalls[1]?.signal).toBe(rpcCalls[0]?.signal);
    });

    it("never logs the session hash, the raw cookie or the title", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const hash = await hashSessionId(COOKIE_ID);
      const timeoutEnvelopes = [
        { data: null, error: { message: "AbortError: The user aborted a request.", code: "" } },
        { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } },
      ];
      const mod = await import("@/app/api/oyun/cerceve/next/route");
      for (const [i, envelope] of timeoutEnvelopes.entries()) {
        cerceveState.nextQueue = [envelope];
        const res = await mod.GET(makeGetRequest(`198.51.100.${30 + i}`, COOKIE));
        expect(res.status).toBe(503);
      }
      // A successful draw and a plain 500 must not leak either.
      cerceveState.nextQueue = [{ data: [ELIGIBLE_ROW], error: null }];
      await mod.GET(makeGetRequest("198.51.100.40", COOKIE));
      cerceveState.nextQueue = [{ data: null, error: { message: "boom" } }];
      await mod.GET(makeGetRequest("198.51.100.41", COOKIE));

      const logged = [...warn.mock.calls, ...error.mock.calls];
      expect(warn).toHaveBeenCalledWith("[oyun/cerceve] draw timed out", { code: "" });
      expect(warn).toHaveBeenCalledWith("[oyun/cerceve] draw timed out", { code: "57014" });
      for (const args of logged) {
        for (const arg of args) {
          const serialized = JSON.stringify(arg) ?? "";
          expect(serialized).not.toContain(hash);
          expect(serialized).not.toContain(COOKIE_ID);
          expect(serialized).not.toContain(COOKIE);
          expect(serialized).not.toContain(ELIGIBLE_ROW.title);
        }
      }
    });
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
    // apiTooManyRequests: whole seconds, never below 1.
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("retry-after")).toBe(
      String(Math.max(1, Math.ceil(body.details.retryAfterMs / 1000))),
    );
  });
});

describe("POST /api/oyun/cerceve", () => {
  it("upserts exactly {article_id, vote, session_hash} with ignoreDuplicates and returns only the crowd tally", async () => {
    const mod = await import("@/app/api/oyun/cerceve/route");
    const raw = "abcdef0123456789abcdef0123456789";
    const res = await mod.POST(
      makePostRequest(VALID_VOTE_BODY, "198.51.100.10", await signedCookie(raw)),
    );
    expect(res.status).toBe(200);
    // A verified cookie is not re-issued.
    expect(res.headers.get("set-cookie")).toBeNull();

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
    expect(setCookieValue(res)).toMatch(SIGNED_COOKIE_RE);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(supabaseFake.calls.upsert("framing_votes")).toHaveLength(0);
    expect((await res.json()).ok).toBe(false);
  });

  describe("signed session cookie (api-7)", () => {
    const FORGED_ID = "abcdef0123456789abcdef0123456789";

    async function expectNotCounted(res: Response) {
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(false);
      expect(supabaseFake.calls.upsert("framing_votes")).toHaveLength(0);
      const minted = setCookieValue(res);
      expect(minted).toMatch(SIGNED_COOKIE_RE);
      // A brand new id, never the attacker-chosen one.
      expect((minted as string).split(".")[0]).not.toBe(FORGED_ID);
      expect(res.headers.get("cache-control")).toBe("no-store");
    }

    it("a forged unsigned 32-hex cookie is not counted and is replaced by a signed one", async () => {
      const mod = await import("@/app/api/oyun/cerceve/route");
      const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.60", FORGED_ID));
      await expectNotCounted(res);
      expect(res.headers.get("set-cookie")).toMatch(/^tayf_cerceve_sid=[0-9a-f]{32}\.[A-Za-z0-9_-]{43};/);
    });

    it("a cookie minted by GET /api/oyun/cerceve/next is counted, hashing only the 32-hex part", async () => {
      const next = await import("@/app/api/oyun/cerceve/next/route");
      const post = await import("@/app/api/oyun/cerceve/route");
      const minted = setCookieValue(await next.GET(makeGetRequest("198.51.100.61"))) as string;
      expect(minted).toMatch(SIGNED_COOKIE_RE);
      const id = minted.split(".")[0] as string;

      const res = await post.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.62", minted));
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);

      const upserts = supabaseFake.calls.upsert("framing_votes");
      expect(upserts).toHaveLength(1);
      const patch = upserts[0]?.patch as { session_hash: string };
      expect(patch.session_hash).toBe(await hashSessionId(id));
      expect(patch.session_hash).not.toBe(await hashSessionId(minted));
      expect(JSON.stringify(patch)).not.toContain(minted);
    });

    it("a cookie whose last signature char is flipped is treated as unsigned", async () => {
      const mod = await import("@/app/api/oyun/cerceve/route");
      const good = await signedCookie(FORGED_ID);
      const flipped = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
      const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.63", flipped));
      await expectNotCounted(res);
    });

    it("a cookie signed under another secret is treated as unsigned", async () => {
      process.env.ADMIN_SESSION_SECRET = "z".repeat(32);
      const foreign = await signedCookie(FORGED_ID);
      process.env.ADMIN_SESSION_SECRET = ADMIN_SECRET;

      const mod = await import("@/app/api/oyun/cerceve/route");
      const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.64", foreign));
      await expectNotCounted(res);
    });

    it("with FRAMING_SESSION_SECRET set, a cookie signed with the ADMIN-derived key is treated as unsigned", async () => {
      const adminSigned = await signedCookie(FORGED_ID);
      process.env.FRAMING_SESSION_SECRET = "framing-secret-0123456789";

      const mod = await import("@/app/api/oyun/cerceve/route");
      const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.65", adminSigned));
      await expectNotCounted(res);
    });

    it("with FRAMING_SESSION_SECRET set, a cookie signed with it is counted", async () => {
      process.env.FRAMING_SESSION_SECRET = "framing-secret-0123456789";
      const mod = await import("@/app/api/oyun/cerceve/route");
      const res = await mod.POST(
        makePostRequest(VALID_VOTE_BODY, "198.51.100.66", await signedCookie(FORGED_ID)),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).ok).toBe(true);
      expect(supabaseFake.calls.upsert("framing_votes")).toHaveLength(1);
    });

    it("with no usable secret a vote is never counted, nothing throws, and it warns once", async () => {
      delete process.env.ADMIN_SESSION_SECRET;
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const mod = await import("@/app/api/oyun/cerceve/route");

      const a = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.67", FORGED_ID));
      const b = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.68"));
      for (const res of [a, b]) {
        expect(res.status).toBe(200);
        expect((await res.json()).ok).toBe(false);
        // Degraded: the plain id is set, but it can never be counted.
        expect(setCookieValue(res)).toMatch(/^[0-9a-f]{32}$/);
      }
      expect(supabaseFake.calls.upsert("framing_votes")).toHaveLength(0);

      const unavailable = warn.mock.calls.filter(
        (args) => args[0] === "[oyun/cerceve] session signing unavailable",
      );
      expect(unavailable).toHaveLength(1);
    });
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
    expect(res.headers.get("retry-after")).toBe(
      String(Math.max(1, Math.ceil(body.details.retryAfterMs / 1000))),
    );
  });

  it("returns 500, not a silent 200, when the upsert fails", async () => {
    cerceveState.forceUpsertError = true;
    const mod = await import("@/app/api/oyun/cerceve/route");
    const raw = await signedCookie("abcdef0123456789abcdef0123456789");
    const res = await mod.POST(makePostRequest(VALID_VOTE_BODY, "198.51.100.17", raw));
    expect(res.status).toBe(500);
  });

  it("returns 400 (not 500) when the upsert fails on a foreign-key violation for a non-existent article_id", async () => {
    cerceveState.forceUpsertErrorCode = "23503";
    const mod = await import("@/app/api/oyun/cerceve/route");
    const raw = await signedCookie("abcdef0123456789abcdef0123456789");
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
    const signed = await signedCookie(raw);
    const ip = "198.51.100.18";
    const res = await postMod.POST(
      new Request("http://example.com/api/oyun/cerceve", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-forwarded-for": ip,
          "user-agent": "TestAgent/1.0",
          Cookie: `tayf_cerceve_sid=${signed}`,
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
    expect(serialized).not.toContain(signed.split(".")[1] as string);
    expect(serialized).not.toContain(ip);
    expect(serialized).not.toContain("TestAgent");
  });
});
