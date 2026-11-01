import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Contract tests for the error surface of the keyed /api/v1 API:
//
//   - 401 carries `WWW-Authenticate` (RFC 6750): realm only when no credential
//     was sent, `error="invalid_token"` when one was sent and is bad.
//   - 429 carries `Retry-After` (whole seconds, == ceil(details.retryAfterMs
//     / 1000)) and a machine-readable `code` (ip_floor | key_minute | key_day).
//   - Every non-GET/HEAD/OPTIONS method on every route is a JSON 405 with
//     `Allow` and the CORS headers (instead of Next's empty-body 405).
//   - Unknown /api/v1/* paths are a JSON 404 from the catch-all (instead of
//     Next's HTML 404), and its OPTIONS preflight is a 204. The bare /api/v1
//     (which the catch-all does not match) answers the same way via the root
//     route.ts.
//   - Every one of those responses lets a browser READ `X-Tayf-Tier` and
//     `Retry-After` cross-origin (Access-Control-Expose-Headers).
//
// Reuses the auth harness shape from tests/api/v1-sources.test.ts: a small
// in-memory KEYS_DB drives `api_key_touch`, so the REAL requireApiKey() gate
// runs in every case. Each test uses a fresh IP (and module registry), so no
// token bucket leaks between cases.
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const FREE_KEY = `tayf_${"6".repeat(40)}`;
const PARTNER_KEY = `tayf_${"7".repeat(40)}`;
const REVOKED_KEY = `tayf_${"8".repeat(40)}`;
// Syntactically valid (tayf_ + 40 hex) but never issued.
const UNKNOWN_KEY = `tayf_${"9".repeat(40)}`;

const KEYS_DB = [
  { id: 666, hash: sha256(FREE_KEY), tier: "free", revoked: false },
  { id: 777, hash: sha256(PARTNER_KEY), tier: "partner", revoked: false },
  { id: 888, hash: sha256(REVOKED_KEY), tier: "free", revoked: true },
];

const EXPOSE = "X-Tayf-Tier, Retry-After";

const dbState = vi.hoisted(() => ({
  dailyUsage: {} as Record<number, number>,
  touchError: false,
  revokedLookupError: false,
  usageError: false,
  touchAsObject: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: () => ({ data: [], error: null }),
      api_keys: (state) => {
        if (dbState.revokedLookupError) {
          return { data: null, error: { message: "relation api_keys exploded" } };
        }
        const hashEq = state.eq.find((e) => e.col === "key_hash");
        const notRevoked = state.not.find(
          (n) => n.col === "revoked_at" && n.op === "is",
        );
        let rows = KEYS_DB;
        if (hashEq) rows = rows.filter((k) => k.hash === hashEq.val);
        if (notRevoked) rows = rows.filter((k) => k.revoked);
        return { data: rows.map((k) => ({ id: k.id })), error: null };
      },
      api_key_usage_daily: (state) => {
        if (dbState.usageError) {
          return { data: null, error: { message: "relation api_key_usage_daily exploded" } };
        }
        const keyIdEq = state.eq.find((e) => e.col === "key_id");
        const keyId = keyIdEq ? Number(keyIdEq.val) : undefined;
        const calls = keyId !== undefined ? (dbState.dailyUsage[keyId] ?? 0) : 0;
        return { data: [{ calls }], error: null };
      },
    },
    rpc: {
      api_key_touch: (args) => {
        if (dbState.touchError) {
          return { data: null, error: { message: "function api_key_touch exploded" } };
        }
        const { p_key_hash } = args as { p_key_hash: string };
        const found = KEYS_DB.find((k) => k.hash === p_key_hash && !k.revoked);
        if (!found) return { data: [], error: null };
        const row = { key_id: found.id, tier: found.tier };
        // PostgREST can return a single-row set function result as an object.
        return { data: dbState.touchAsObject ? row : [row], error: null };
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

// The alerts / kap routes import modules that pull in cacheLife/cacheTag from
// next/cache (their "use cache" directive is inert under vitest); nothing here
// calls them, but the import must resolve.
vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `198.18.${Math.floor(ipCounter / 250)}.${1 + (ipCounter % 250)}`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com";
  dbState.dailyUsage = {};
  dbState.touchError = false;
  dbState.revokedLookupError = false;
  dbState.usageError = false;
  dbState.touchAsObject = false;
  supabaseFake.calls.rpc.length = 0;
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SITE_URL",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function sourcesRequest(opts: { authorization?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  return new Request("http://example.com/api/v1/sources", { headers });
}

function bearer(key: string): string {
  return `Bearer ${key}`;
}

describe("401 carries WWW-Authenticate", () => {
  it("a request with NO Authorization header gets the realm only (no error attribute)", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe('Bearer realm="tayf-api"');
    const body = await res.json();
    expect(body.error).toBe("Missing or invalid API key");
  });

  it.each([
    ["a non-Bearer scheme", "Basic dXNlcjpwYXNz"],
    ["a Bearer token that is not a tayf key", "Bearer not-a-key"],
    ["a too-short tayf key", `Bearer tayf_${"a".repeat(39)}`],
    ["a non-hex tayf key", `Bearer tayf_${"z".repeat(40)}`],
    ["an empty Bearer value", "Bearer "],
  ])("%s gets error=\"invalid_token\"", async (_label, authorization) => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="tayf-api", error="invalid_token"',
    );
  });

  it("a well-formed but unknown key gets error=\"invalid_token\"", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization: bearer(UNKNOWN_KEY) }));
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer realm="tayf-api", error="invalid_token"',
    );
  });

  it("a revoked key is a 403 with no WWW-Authenticate challenge", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization: bearer(REVOKED_KEY) }));
    expect(res.status).toBe(403);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("a 200 never carries WWW-Authenticate", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("WWW-Authenticate")).toBeNull();
  });

  it("never logs the presented key or its hash on any refusal path", async () => {
    const sinks = [
      vi.spyOn(console, "log").mockImplementation(() => {}),
      vi.spyOn(console, "info").mockImplementation(() => {}),
      vi.spyOn(console, "warn").mockImplementation(() => {}),
      vi.spyOn(console, "error").mockImplementation(() => {}),
      vi.spyOn(console, "debug").mockImplementation(() => {}),
    ];
    const { GET } = await import("@/app/api/v1/sources/route");
    for (const key of [UNKNOWN_KEY, REVOKED_KEY]) {
      const res = await GET(sourcesRequest({ authorization: bearer(key) }));
      expect([401, 403]).toContain(res.status);
      const text = await res.text();
      expect(text).not.toContain(key);
      expect(text).not.toContain(sha256(key));
      for (const [, value] of res.headers) {
        expect(value).not.toContain(key);
        expect(value).not.toContain(sha256(key));
      }
    }
    for (const sink of sinks) {
      for (const call of sink.mock.calls) {
        const flat = JSON.stringify(call);
        expect(flat).not.toContain(UNKNOWN_KEY);
        expect(flat).not.toContain(sha256(UNKNOWN_KEY));
        expect(flat).not.toContain(REVOKED_KEY);
        expect(flat).not.toContain(sha256(REVOKED_KEY));
      }
    }
  });
});

const ROUTE_LOADERS: Record<string, () => Promise<Record<string, unknown>>> = {
  "alerts/blindspots": () => import("@/app/api/v1/alerts/blindspots/route"),
  clusters: () => import("@/app/api/v1/clusters/route"),
  "clusters/[id]": () => import("@/app/api/v1/clusters/[id]/route"),
  "kap/pickup": () => import("@/app/api/v1/kap/pickup/route"),
  "openapi.json": () => import("@/app/api/v1/openapi.json/route"),
  sources: () => import("@/app/api/v1/sources/route"),
  "sources/[slug]/profile": () => import("@/app/api/v1/sources/[slug]/profile/route"),
};

const DISALLOWED_METHODS = ["POST", "PUT", "PATCH", "DELETE"] as const;

describe("405 on every route", () => {
  for (const [name, load] of Object.entries(ROUTE_LOADERS)) {
    it(`/api/v1/${name}: POST, PUT, PATCH and DELETE are JSON 405 with Allow and CORS`, async () => {
      const mod = await load();
      for (const method of DISALLOWED_METHODS) {
        const handler = mod[method] as
          | ((req?: Request) => Promise<Response> | Response)
          | undefined;
        expect(handler, `${method} /api/v1/${name} is not exported`).toBeTypeOf("function");
        const res = await handler!(
          new Request(`http://example.com/api/v1/${name}`, {
            method,
            headers: { "x-forwarded-for": nextIp() },
          }),
        );
        expect(res.status, `${method} /api/v1/${name}`).toBe(405);
        expect(res.headers.get("Content-Type")).toContain("application/json");
        expect(res.headers.get("Allow")).toBe("GET, HEAD, OPTIONS");
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
        expect(res.headers.get("Cache-Control")).toContain("no-store");
        expect(await res.json()).toEqual({ error: "Method not allowed" });
      }
    });
  }

  it("a 405 does not touch the database or the rate limiters", async () => {
    const { POST } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();
    for (let i = 0; i < 50; i++) {
      const res = await POST(
        new Request("http://example.com/api/v1/sources", {
          method: "POST",
          headers: { "x-forwarded-for": ip },
        }),
      );
      expect(res.status).toBe(405);
    }
    expect(supabaseFake.calls.rpc.length).toBe(0);
  });
});

describe("catch-all /api/v1/[...path]", () => {
  // The handlers never read the request or its params (a 404 needs neither),
  // so they are called bare -- exactly what makes them key-less and DB-free.
  it("GET and POST on an unknown path are application/json 404 with CORS and no-store", async () => {
    const { GET, POST } = await import("@/app/api/v1/[...path]/route");
    for (const handler of [GET, POST]) {
      const res = await handler();
      expect(res.status).toBe(404);
      expect(res.headers.get("Content-Type")).toContain("application/json");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      expect(res.headers.get("Cache-Control")).toContain("no-store");
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
  });

  it("HEAD, PUT, PATCH and DELETE are 404 too", async () => {
    const mod = await import("@/app/api/v1/[...path]/route");
    for (const method of ["HEAD", "PUT", "PATCH", "DELETE"] as const) {
      const handler = mod[method];
      expect(handler, `${method} is not exported`).toBeTypeOf("function");
      const res = await handler();
      expect(res.status, method).toBe(404);
    }
  });

  it("OPTIONS is a bodyless 204 with the CORS headers, so a browser can read the 404", async () => {
    const { OPTIONS } = await import("@/app/api/v1/[...path]/route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
    expect(await res.text()).toBe("");
  });

  it("answers without a key, a database call or a rate-limit charge", async () => {
    const { GET } = await import("@/app/api/v1/[...path]/route");
    for (let i = 0; i < 60; i++) {
      const res = await GET();
      expect(res.status).toBe(404);
    }
    expect(supabaseFake.calls.rpc.length).toBe(0);
  });
});

describe("bare /api/v1", () => {
  // The catch-all `[...path]` does not match the bare `/api/v1` itself (a
  // required catch-all needs at least one segment), so Next served its HTML
  // not-found page there. The root route.ts re-exports the same handlers, so
  // `/api/v1` answers exactly like `/api/v1/nope`.
  it("GET, HEAD, POST, PUT, PATCH and DELETE are application/json 404 with CORS and no-store", async () => {
    const mod = await import("@/app/api/v1/route");
    for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
      const handler = mod[method];
      expect(handler, `${method} is not exported`).toBeTypeOf("function");
      // Called bare, like the catch-all's own tests: a 404 needs no request.
      const res = await handler();
      expect(res.status, method).toBe(404);
      expect(res.headers.get("Content-Type"), method).toContain("application/json");
      expect(res.headers.get("Access-Control-Allow-Origin"), method).toBe("*");
      expect(res.headers.get("Access-Control-Expose-Headers"), method).toBe(EXPOSE);
      expect(res.headers.get("Cache-Control"), method).toContain("no-store");
      // A HEAD response is bodyless on the wire, but the handler itself is the
      // same JSON 404 as the catch-all's; only read the body for the others.
      expect(await res.json(), method).toEqual({ error: "Not found" });
    }
  });

  it("OPTIONS is a bodyless 204 with the CORS headers", async () => {
    const { OPTIONS } = await import("@/app/api/v1/route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain("Authorization");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
    expect(await res.text()).toBe("");
  });

  it("answers exactly like the catch-all, without a key, a database call or a rate-limit charge", async () => {
    const root = await import("@/app/api/v1/route");
    const catchAll = await import("@/app/api/v1/[...path]/route");
    for (let i = 0; i < 60; i++) {
      const res = await root.GET();
      expect(res.status).toBe(404);
    }
    const a = await root.GET();
    const b = await catchAll.GET();
    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
    expect([...a.headers].sort()).toEqual([...b.headers].sort());
    expect(supabaseFake.calls.rpc.length).toBe(0);
  });
});

describe("Access-Control-Expose-Headers: X-Tayf-Tier, Retry-After", () => {
  it("is present on 200, 401, 403, 404, 405 and 429", async () => {
    const sources = await import("@/app/api/v1/sources/route");
    const catchAll = await import("@/app/api/v1/[...path]/route");

    const ok = await sources.GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);

    const unauthorized = await sources.GET(sourcesRequest());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);

    const revoked = await sources.GET(sourcesRequest({ authorization: bearer(REVOKED_KEY) }));
    expect(revoked.status).toBe(403);
    expect(revoked.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);

    const notFound = await catchAll.GET();
    expect(notFound.status).toBe(404);
    expect(notFound.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);

    const notAllowed = await sources.POST();
    expect(notAllowed.status).toBe(405);
    expect(notAllowed.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);

    dbState.dailyUsage[666] = 2001;
    const limited = await sources.GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
  });

  it("is present on a 429 from the per-IP floor", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();
    let last: Response | undefined;
    for (let i = 0; i < 31; i++) {
      last = await GET(sourcesRequest({ ip }));
    }
    expect(last!.status).toBe(429);
    expect(last!.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
  });

  it("is present on the OPTIONS preflight and the static openapi.json", async () => {
    const sources = await import("@/app/api/v1/sources/route");
    const preflight = await sources.OPTIONS();
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);

    const openapi = await import("@/app/api/v1/openapi.json/route");
    const doc = openapi.GET();
    expect(doc.status).toBe(200);
    expect(doc.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
  });
});

describe("429 carries Retry-After, a code and the envelope", () => {
  it("per-minute 429 (61st request on a free key from distinct IPs): key_minute, Retry-After == ceil(retryAfterMs / 1000)", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    for (let i = 0; i < 60; i++) {
      const res = await GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
      expect(res.status).toBe(200);
    }
    const res = await GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe("Too many requests");
    expect(body.code).toBe("key_minute");
    expect(typeof body.details.retryAfterMs).toBe("number");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);

    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).toBe(String(Math.ceil(body.details.retryAfterMs / 1000)));
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
    // The tier is known on this path, so it is reported.
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
  });

  it("daily 429 (calls past the cap): key_day, 'Daily limit exceeded', Retry-After == ceil(retryAfterMs / 1000)", async () => {
    dbState.dailyUsage[666] = 2001; // free perDay = 2000
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe("Daily limit exceeded");
    expect(body.code).toBe("key_day");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
    // Until the next UTC midnight: at most one day.
    expect(body.details.retryAfterMs).toBeLessThanOrEqual(24 * 60 * 60 * 1000);

    expect(res.headers.get("Retry-After")).toBe(
      String(Math.ceil(body.details.retryAfterMs / 1000)),
    );
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("a partner key at the daily cap reports its own tier", async () => {
    dbState.dailyUsage[777] = 50001; // partner perDay = 50000
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization: bearer(PARTNER_KEY) }));
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe("key_day");
    expect(res.headers.get("X-Tayf-Tier")).toBe("partner");
  });

  it("per-IP floor 429 (31st keyless request): ip_floor, no tier header, Retry-After >= 1", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const ip = nextIp();
    for (let i = 0; i < 30; i++) {
      const res = await GET(sourcesRequest({ ip }));
      expect(res.status).toBe(401);
    }
    const res = await GET(sourcesRequest({ ip }));
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe("Too many requests");
    expect(body.code).toBe("ip_floor");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
    expect(res.headers.get("Retry-After")).toBe(
      String(Math.ceil(body.details.retryAfterMs / 1000)),
    );
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThanOrEqual(1);
    // The caller was never identified, so no tier is claimed.
    expect(res.headers.get("X-Tayf-Tier")).toBeNull();
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("a 401 and a 200 carry no Retry-After", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const unauthorized = await GET(sourcesRequest());
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Retry-After")).toBeNull();
    const ok = await GET(sourcesRequest({ authorization: bearer(FREE_KEY) }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Retry-After")).toBeNull();
  });
});

describe("upstream failures keep the v1 contract", () => {
  async function expectSanitised500(res: Response) {
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toBe(EXPOSE);
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("Retry-After")).toBeNull();
    const text = await res.text();
    const body = JSON.parse(text);
    expect(body.error).toBe("Internal server error");
    expect(typeof body.details.request_id).toBe("string");
    // Never echoes the raw upstream error.
    expect(text).not.toContain("exploded");
  }

  it("an api_key_touch failure is a sanitised 500 (not a 401, not a limiter charge)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.touchError = true;
    const { GET } = await import("@/app/api/v1/sources/route");
    await expectSanitised500(await GET(sourcesRequest({ authorization: bearer(FREE_KEY) })));
  });

  it("a failing revoked-key lookup is a sanitised 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.revokedLookupError = true;
    const { GET } = await import("@/app/api/v1/sources/route");
    await expectSanitised500(await GET(sourcesRequest({ authorization: bearer(UNKNOWN_KEY) })));
  });

  it("a failing daily-usage read is a sanitised 500", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    dbState.usageError = true;
    const { GET } = await import("@/app/api/v1/sources/route");
    await expectSanitised500(await GET(sourcesRequest({ authorization: bearer(FREE_KEY) })));
  });

  it("accepts api_key_touch returning a single object instead of a row array", async () => {
    dbState.touchAsObject = true;
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest({ authorization: bearer(PARTNER_KEY) }));
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Tayf-Tier")).toBe("partner");
  });
});
