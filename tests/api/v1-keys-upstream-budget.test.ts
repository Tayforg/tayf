import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// hunt-27 resilience-3: requireApiKey's three database reads (the
// `api_key_touch` RPC, the revoked-key lookup and the `api_key_usage_daily`
// read) each get a 3.5 s budget, and a budget overrun or a classified
// upstream error (PGRST000-003, 57014, AbortError, ...) answers a 503 with
// `Retry-After: 30` instead of the generic 500. The gate stays FAIL-CLOSED:
// no error or timeout ever lets a request through, and any other error stays
// a sanitised 500.
//
// A hand-rolled client replaces the Supabase fake because the cases here need
// a read that never settles, which the shared fake cannot express.
// ---------------------------------------------------------------------------

type Mode =
  | { kind: "data"; data: unknown }
  | { kind: "error"; error: unknown }
  | { kind: "reject"; reason: unknown }
  | { kind: "hang" }
  | { kind: "delay"; ms: number; data: unknown };

const mocks = vi.hoisted(() => ({
  touch: { kind: "data", data: [{ key_id: 7, tier: "free" }] } as Mode,
  revoked: { kind: "data", data: null } as Mode,
  usage: { kind: "data", data: { calls: 1 } } as Mode,
  calls: [] as string[],
}));

function settle(mode: Mode): Promise<{ data: unknown; error: unknown }> {
  switch (mode.kind) {
    case "hang":
      return new Promise(() => {});
    case "error":
      return Promise.resolve({ data: null, error: mode.error });
    case "reject":
      return Promise.reject(mode.reason);
    case "delay":
      return new Promise((resolve) => {
        setTimeout(() => resolve({ data: mode.data, error: null }), mode.ms);
      });
    default:
      return Promise.resolve({ data: mode.data, error: null });
  }
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => ({
    rpc: (name: string) => {
      mocks.calls.push(`rpc:${name}`);
      return settle(mocks.touch);
    },
    from: (table: string) => {
      mocks.calls.push(`from:${table}`);
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "not"]) builder[method] = () => builder;
      builder.maybeSingle = () =>
        settle(table === "api_keys" ? mocks.revoked : mocks.usage);
      return builder;
    },
  }),
}));

// errors.ts imports the Sentry helper; nothing here exercises it.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

const KEY = `tayf_${"a".repeat(40)}`;
let ipCounter = 0;

function request(): Request {
  ipCounter += 1;
  return new Request("http://example.com/api/v1/clusters", {
    headers: {
      authorization: `Bearer ${KEY}`,
      "x-forwarded-for": `198.51.100.${ipCounter % 250}`,
    },
  });
}

async function load() {
  vi.resetModules();
  return import("@/lib/api/keys");
}

/** A key the touch RPC reports as unknown or revoked (an empty row set). */
const UNKNOWN: Mode = { kind: "data", data: [] };

beforeEach(() => {
  mocks.touch = { kind: "data", data: [{ key_id: 7, tier: "free" }] };
  mocks.revoked = { kind: "data", data: null };
  mocks.usage = { kind: "data", data: { calls: 1 } };
  mocks.calls.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function expectUnavailable(res: Response) {
  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("30");
  // withApiV1Headers' contract: CORS + private no-store, Retry-After readable.
  expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  expect(res.headers.get("Access-Control-Expose-Headers")).toContain("Retry-After");
  const body = await res.json();
  expect(body).toEqual({
    error: "Service temporarily unavailable",
    code: "upstream_unavailable",
    details: { request_id: body.details.request_id },
  });
  expect(typeof body.details.request_id).toBe("string");
}

async function expectSanitised500(res: Response, secret: string) {
  expect(res.status).toBe(500);
  expect(res.headers.get("Retry-After")).toBeNull();
  const text = await res.text();
  expect(text).toContain("Internal server error");
  expect(text).not.toContain(secret);
}

/** Runs requireApiKey with fake timers and returns once it settles. */
async function runWithTimers(
  requireApiKey: (r: Request) => Promise<{ ok: boolean; response?: Response }>,
) {
  vi.useFakeTimers();
  const pending = requireApiKey(request());
  let settled = false;
  void pending.then(() => {
    settled = true;
  });
  return {
    pending,
    isSettled: () => settled,
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
  };
}

describe("API_KEY_DB_BUDGET_MS", () => {
  it("is 3500", async () => {
    const { API_KEY_DB_BUDGET_MS } = await load();
    expect(API_KEY_DB_BUDGET_MS).toBe(3500);
  });
});

describe("requireApiKey: api_key_touch", () => {
  it("a touch that never settles answers 503 once the 3500 ms budget has passed (fail-closed)", async () => {
    const { requireApiKey, API_KEY_DB_BUDGET_MS } = await load();
    mocks.touch = { kind: "hang" };

    const run = await runWithTimers(requireApiKey);
    await run.advance(API_KEY_DB_BUDGET_MS - 1);
    expect(run.isSettled()).toBe(false);
    await run.advance(1);
    const auth = await run.pending;

    expect(auth.ok).toBe(false);
    await expectUnavailable(auth.response!);
    // It stopped at the touch: no revoked lookup, no usage read.
    expect(mocks.calls).toEqual(["rpc:api_key_touch"]);
  });

  it("a touch error with code 57014 answers 503", async () => {
    const { requireApiKey } = await load();
    mocks.touch = {
      kind: "error",
      error: { code: "57014", message: "canceling statement due to statement timeout" },
    };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectUnavailable(auth.response);
  });

  it.each([
    ["PGRST002", { code: "PGRST002", message: "schema cache" }],
    ["a postgrest-js fetch-failed error", { code: "", message: "TypeError: fetch failed" }],
    ["a postgrest-js abort error", { code: "", message: "AbortError: This operation was aborted" }],
  ])("a touch error from %s answers 503", async (_label, error) => {
    const { requireApiKey } = await load();
    mocks.touch = { kind: "error", error };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectUnavailable(auth.response);
  });

  it("a touch that REJECTS with an AbortError answers 503", async () => {
    const { requireApiKey } = await load();
    mocks.touch = { kind: "reject", reason: new DOMException("aborted", "AbortError") };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectUnavailable(auth.response);
  });

  it("a generic touch error stays a sanitised 500", async () => {
    const { requireApiKey } = await load();
    mocks.touch = {
      kind: "error",
      error: { message: "function api_key_touch SECRET_NAME exploded" },
    };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectSanitised500(auth.response, "SECRET_NAME");
  });

  it("a touch that REJECTS with a generic Error stays a sanitised 500", async () => {
    const { requireApiKey } = await load();
    mocks.touch = { kind: "reject", reason: new Error("SECRET_NAME exploded") };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectSanitised500(auth.response, "SECRET_NAME");
  });
});

describe("requireApiKey: revoked-key lookup", () => {
  it("a lookup that never settles answers 503 after the budget (the key stays refused)", async () => {
    const { requireApiKey, API_KEY_DB_BUDGET_MS } = await load();
    mocks.touch = UNKNOWN;
    mocks.revoked = { kind: "hang" };

    const run = await runWithTimers(requireApiKey);
    await run.advance(API_KEY_DB_BUDGET_MS - 1);
    expect(run.isSettled()).toBe(false);
    await run.advance(1);
    const auth = await run.pending;

    expect(auth.ok).toBe(false);
    await expectUnavailable(auth.response!);
  });

  it("a classified lookup error answers 503", async () => {
    const { requireApiKey } = await load();
    mocks.touch = UNKNOWN;
    mocks.revoked = { kind: "error", error: { code: "PGRST003", message: "pool timeout" } };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectUnavailable(auth.response);
  });

  it("a generic lookup error stays a sanitised 500", async () => {
    const { requireApiKey } = await load();
    mocks.touch = UNKNOWN;
    mocks.revoked = { kind: "error", error: { message: "relation SECRET_NAME exploded" } };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectSanitised500(auth.response, "SECRET_NAME");
  });
});

describe("requireApiKey: api_key_usage_daily read", () => {
  it("a read that never settles answers 503 after the budget (never lets the call through)", async () => {
    const { requireApiKey, API_KEY_DB_BUDGET_MS } = await load();
    mocks.usage = { kind: "hang" };

    const run = await runWithTimers(requireApiKey);
    await run.advance(API_KEY_DB_BUDGET_MS - 1);
    expect(run.isSettled()).toBe(false);
    await run.advance(1);
    const auth = await run.pending;

    expect(auth.ok).toBe(false);
    await expectUnavailable(auth.response!);
  });

  it("a classified usage error answers 503", async () => {
    const { requireApiKey } = await load();
    mocks.usage = { kind: "error", error: { code: "57014", message: "statement timeout" } };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectUnavailable(auth.response);
  });

  it("a generic usage error stays a sanitised 500", async () => {
    const { requireApiKey } = await load();
    mocks.usage = { kind: "error", error: { message: "relation SECRET_NAME exploded" } };

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    if (!auth.ok) await expectSanitised500(auth.response, "SECRET_NAME");
  });
});

describe("requireApiKey: the budget is per read, and the timer is always cleared", () => {
  it("a touch that answers at 3000 ms is accepted (each read has its own 3500 ms)", async () => {
    const { requireApiKey } = await load();
    mocks.touch = { kind: "delay", ms: 3000, data: [{ key_id: 7, tier: "free" }] };
    mocks.usage = { kind: "delay", ms: 3000, data: { calls: 1 } };

    const run = await runWithTimers(requireApiKey);
    await run.advance(6000);
    const auth = await run.pending;

    expect(auth).toEqual({ ok: true, keyId: 7, tier: "free" });
  });

  it("a healthy gate leaves no budget timer behind", async () => {
    const { requireApiKey } = await load();
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(true);
    expect(vi.getTimerCount()).toBe(before);
  });

  it("a failed gate leaves no budget timer behind either", async () => {
    const { requireApiKey } = await load();
    mocks.touch = { kind: "error", error: { code: "57014", message: "x" } };
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    const auth = await requireApiKey(request());

    expect(auth.ok).toBe(false);
    expect(vi.getTimerCount()).toBe(before);
  });
});
