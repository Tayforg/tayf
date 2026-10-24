import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Direct coverage for supabase/functions/_shared/auth.ts (edge-hardening,
// edge-1).
//
// All 7 Edge Functions run with verify_jwt=false (deployed with
// --no-verify-jwt), so requireServiceRoleBearer is the ONLY auth gate in front
// of them. Two properties are pinned here:
//
//   1. The Authorization parse is LINEAR and length-capped. The old
//      `/^\s*Bearer\s+(.+?)\s*$/i` was quadratic on a long whitespace run that
//      ends in a non-space (~1 s at 50k characters), i.e. an unauthenticated
//      caller could burn CPU on a function whose gate had not yet said no.
//   2. Every VALID bearer shape still passes: case-insensitive scheme, any
//      whitespace between scheme and token, either of the two secrets.
//
// `Deno.env.get` does not exist in the vitest Node env, so the Deno global is
// stubbed per-test (same convention as sentry.test.ts / safe-fetch.test.ts).
// ---------------------------------------------------------------------------

import {
  MAX_AUTHORIZATION_LENGTH,
  parseBearer,
  requireServiceRoleBearer,
} from "../../../supabase/functions/_shared/auth.ts";

const SERVICE_KEY = "sb_secret_unit-test-service-key";
const CRON_SECRET = "unit-test-cron-secret";

let env: Record<string, string | undefined>;

beforeEach(() => {
  env = {
    SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY,
    WORKER_CRON_SECRET: CRON_SECRET,
  };
  vi.stubGlobal("Deno", { env: { get: (k: string) => env[k] } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function reqWith(authorization?: string): Request {
  const headers = new Headers();
  if (authorization !== undefined) headers.set("authorization", authorization);
  return new Request("http://localhost/fn", { method: "POST", headers });
}

async function bodyOf(res: Response): Promise<unknown> {
  return await res.json();
}

async function expectUnauthorized(res: Response | null, reason: string): Promise<void> {
  expect(res).not.toBeNull();
  const r = res as Response;
  expect(r.status).toBe(401);
  expect(r.headers.get("content-type")).toBe("application/json");
  expect(await bodyOf(r)).toEqual({ ok: false, error: "unauthorized", reason });
}

/** Wall-clock ms of one synchronous call. */
function timed<T>(fn: () => T): { value: T; ms: number } {
  const t0 = performance.now();
  const value = fn();
  return { value, ms: performance.now() - t0 };
}

// ---------------------------------------------------------------------------
// parseBearer
// ---------------------------------------------------------------------------

describe("parseBearer", () => {
  it("returns the token for a plain bearer header", () => {
    expect(parseBearer("Bearer abc.def-123")).toBe("abc.def-123");
  });

  it("accepts any case for the scheme (RFC 6750 is case-insensitive)", () => {
    expect(parseBearer("bearer K")).toBe("K");
    expect(parseBearer("BEARER K")).toBe("K");
    expect(parseBearer("bEaReR K")).toBe("K");
  });

  it("accepts any whitespace between scheme and token", () => {
    expect(parseBearer("Bearer   K")).toBe("K");
    expect(parseBearer("BEARER\tK")).toBe("K");
    expect(parseBearer("Bearer \t \tK")).toBe("K");
  });

  it("trims leading and trailing whitespace (Request/Headers would strip it before us)", () => {
    expect(parseBearer("  Bearer   K  ")).toBe("K");
    expect(parseBearer("\tBearer K\t")).toBe("K");
  });

  it("returns null when the token is missing or contains whitespace", () => {
    expect(parseBearer("Bearer")).toBeNull();
    expect(parseBearer("Bearer ")).toBeNull();
    expect(parseBearer("Bearer    ")).toBeNull();
    expect(parseBearer("Bearer a b")).toBeNull();
    expect(parseBearer("Bearer a\tb")).toBeNull();
  });

  it("returns null for another scheme, a glued scheme, or an empty header", () => {
    expect(parseBearer("Basic dXNlcjpwYXNz")).toBeNull();
    expect(parseBearer("BearerK")).toBeNull();
    expect(parseBearer("Token K")).toBeNull();
    expect(parseBearer("")).toBeNull();
    expect(parseBearer("K")).toBeNull();
  });

  it("costs under 50 ms on a 50,000-space run that ends in a non-space (old regex: ~1 s)", () => {
    const hostile = "Bearer x" + " ".repeat(50_000) + "y";
    const { value, ms } = timed(() => parseBearer(hostile));
    expect(value).toBeNull();
    expect(ms).toBeLessThan(50);
  });

  it("stays linear for whitespace runs in the other positions too", () => {
    const leading = " ".repeat(50_000) + "Bearer";
    const between = "Bearer" + " ".repeat(50_000) + "a b";
    const trailing = "Bearer a" + "\t".repeat(50_000) + "!x";
    for (const hostile of [leading, between, trailing]) {
      const { value, ms } = timed(() => parseBearer(hostile));
      expect(value).toBeNull();
      expect(ms).toBeLessThan(50);
    }
  });

  it("still parses a very long but well-formed token quickly", () => {
    const token = "a".repeat(200_000);
    const { value, ms } = timed(() => parseBearer(`Bearer ${token}`));
    expect(value).toBe(token);
    expect(ms).toBeLessThan(50);
  });
});

// ---------------------------------------------------------------------------
// requireServiceRoleBearer
// ---------------------------------------------------------------------------

describe("requireServiceRoleBearer: length cap", () => {
  it("caps the Authorization header at 1024 characters", () => {
    expect(MAX_AUTHORIZATION_LENGTH).toBe(1024);
  });

  it("rejects a 1025-character header as malformed-authorization", async () => {
    const header = "Bearer " + "a".repeat(MAX_AUTHORIZATION_LENGTH + 1 - "Bearer ".length);
    expect(header.length).toBe(1025);
    await expectUnauthorized(requireServiceRoleBearer(reqWith(header)), "malformed-authorization");
  });

  it("rejects an over-long header even when the token inside is the real key", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "k".repeat(2000);
    const header = `Bearer ${"k".repeat(2000)}`;
    await expectUnauthorized(requireServiceRoleBearer(reqWith(header)), "malformed-authorization");
  });

  it("parses a header of exactly 1024 characters (bad-bearer, not malformed)", async () => {
    const header = "Bearer " + "a".repeat(1017);
    expect(header.length).toBe(MAX_AUTHORIZATION_LENGTH);
    await expectUnauthorized(requireServiceRoleBearer(reqWith(header)), "bad-bearer");
  });

  it("answers a 16,000-space adversarial header with 401 in under 50 ms", async () => {
    const header = "Bearer x" + " ".repeat(16_000) + "y";
    const { value, ms } = timed(() => requireServiceRoleBearer(reqWith(header)));
    expect(ms).toBeLessThan(50);
    await expectUnauthorized(value, "malformed-authorization");
  });

  it("answers a short hostile header (inside the cap) with 401 in under 50 ms", async () => {
    const header = "Bearer x" + " ".repeat(900) + "y z";
    expect(header.length).toBeLessThanOrEqual(MAX_AUTHORIZATION_LENGTH);
    const { value, ms } = timed(() => requireServiceRoleBearer(reqWith(header)));
    expect(ms).toBeLessThan(50);
    await expectUnauthorized(value, "malformed-authorization");
  });
});

describe("requireServiceRoleBearer: valid bearers still pass", () => {
  // Only one secret is configured per case so a pass proves THAT secret matched.
  const cases: Array<[string, string]> = [
    ["Bearer K", "canonical"],
    ["bearer K", "lower-case scheme"],
    ["BEARER\tK", "tab separator"],
    ["Bearer   K", "multiple spaces"],
  ];

  for (const [template, label] of cases) {
    it(`accepts the service-role key: ${label}`, () => {
      env.WORKER_CRON_SECRET = "";
      const res = requireServiceRoleBearer(reqWith(template.replace("K", SERVICE_KEY)));
      expect(res).toBeNull();
    });

    it(`accepts the cron secret: ${label}`, () => {
      env.SUPABASE_SERVICE_ROLE_KEY = "";
      const res = requireServiceRoleBearer(reqWith(template.replace("K", CRON_SECRET)));
      expect(res).toBeNull();
    });
  }

  it("accepts either secret when both are configured", () => {
    expect(requireServiceRoleBearer(reqWith(`Bearer ${SERVICE_KEY}`))).toBeNull();
    expect(requireServiceRoleBearer(reqWith(`Bearer ${CRON_SECRET}`))).toBeNull();
  });

  it("works when only the cron secret is configured (unset service key)", () => {
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    expect(requireServiceRoleBearer(reqWith(`Bearer ${CRON_SECRET}`))).toBeNull();
  });
});

describe("requireServiceRoleBearer: rejections", () => {
  it("rejects a token with a space inside as malformed-authorization", async () => {
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer a b")), "malformed-authorization");
  });

  it("rejects a non-bearer scheme as malformed-authorization", async () => {
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Basic dXNlcjpwYXNz")), "malformed-authorization");
  });

  it("rejects a bare scheme with no token as malformed-authorization", async () => {
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer")), "malformed-authorization");
  });

  it("rejects a wrong token as bad-bearer", async () => {
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer nope")), "bad-bearer");
  });

  it("rejects a token that is only a prefix or an extension of a secret", async () => {
    await expectUnauthorized(
      requireServiceRoleBearer(reqWith(`Bearer ${SERVICE_KEY.slice(0, -1)}`)),
      "bad-bearer",
    );
    await expectUnauthorized(
      requireServiceRoleBearer(reqWith(`Bearer ${SERVICE_KEY}x`)),
      "bad-bearer",
    );
  });

  it("rejects the empty string even if one secret is unset (no empty-secret match)", async () => {
    env.WORKER_CRON_SECRET = "";
    // "Bearer " is trimmed to "Bearer" by Headers: no token at all.
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer ")), "malformed-authorization");
  });

  it("answers a missing header with missing-authorization", async () => {
    await expectUnauthorized(requireServiceRoleBearer(reqWith()), "missing-authorization");
  });

  it("answers server-misconfigured when both secrets are empty or unset", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "";
    env.WORKER_CRON_SECRET = "";
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer anything")), "server-misconfigured");
    delete env.SUPABASE_SERVICE_ROLE_KEY;
    delete env.WORKER_CRON_SECRET;
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer anything")), "server-misconfigured");
  });

  it("never accepts an empty-secret deploy, even for a header that parses", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = "";
    env.WORKER_CRON_SECRET = "";
    await expectUnauthorized(requireServiceRoleBearer(reqWith("Bearer x")), "server-misconfigured");
  });
});

describe("requireServiceRoleBearer: both comparisons are always evaluated", () => {
  // Timing hygiene: the service-key check must not short-circuit the cron
  // check (or vice versa), otherwise response time reveals which secret
  // matched. Each constant-time compare encodes both of its operands, so two
  // configured secrets means four encode() calls whatever the outcome. The
  // 401 body is also UTF-8 encoded by the runtime on the failure path; it is
  // JSON (starts with "{"), which no token or secret here does, so it is
  // filtered out and only the comparison traffic is counted.
  it.each([
    ["matches the service key", SERVICE_KEY],
    ["matches the cron secret", CRON_SECRET],
    ["matches neither", "nope"],
  ])("runs both compares when the token %s", (_label, token) => {
    const encode = vi.spyOn(TextEncoder.prototype, "encode");
    requireServiceRoleBearer(reqWith(`Bearer ${token}`));
    const compared = encode.mock.calls.filter(
      ([s]) => typeof s === "string" && !s.startsWith("{"),
    );
    expect(compared).toHaveLength(4);
  });
});
