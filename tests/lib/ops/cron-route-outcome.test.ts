import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// withCronOutcome (src/lib/ops/cron-route-outcome.ts), h12-ops-1.
//
// On 2026-10-31/11-01 the headline-pick query timed out 189 times over 18+
// hours; the cron route turned each one into a 500 and nothing paged, because
// the ops heartbeat only reads the database. The wrapper records one outcome
// row per AUTHENTICATED /api/cron/* run (route, status, duration) through the
// service-role RPC ops_cron_route_run_record, scheduled with after() so it can
// never delay or break the response. ops_health_report() row 15 reads it.
//
// The wrapper must be inert when it cannot do its job: unauthenticated traffic
// is never recorded (a public caller must not be able to fill the table),
// after() outside a request scope is a no-op, and a failing write is logged at
// most once per instance without headers or tokens.
// ---------------------------------------------------------------------------

const hoisted = vi.hoisted(() => ({
  afterMock: vi.fn(),
  connectionMock: vi.fn(),
  createServerClientMock: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: hoisted.afterMock,
    connection: hoisted.connectionMock,
  };
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: hoisted.createServerClientMock,
}));

const { afterMock, connectionMock, createServerClientMock, rpc } = hoisted;

const ORIGINAL_SECRET = process.env.CRON_SECRET;
const SECRET = "shhh-cron-secret";

type Mod = typeof import("@/lib/ops/cron-route-outcome");

async function load(): Promise<Mod> {
  vi.resetModules();
  return await import("@/lib/ops/cron-route-outcome");
}

function req(authorization?: string): Request {
  return new Request("https://tayf.test/api/cron/headline", {
    headers: authorization === undefined ? {} : { authorization },
  });
}

/** The callbacks handed to after(), in order. */
function scheduled(): Array<() => unknown> {
  return afterMock.mock.calls.map((c) => c[0] as () => unknown);
}

/** Runs every scheduled callback, the way Next does once the response is sent. */
async function flushAfter(): Promise<void> {
  await Promise.all(scheduled().map((cb) => Promise.resolve(cb())));
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.CRON_SECRET = SECRET;
  afterMock.mockReset();
  afterMock.mockImplementation(() => {});
  connectionMock.mockReset();
  connectionMock.mockResolvedValue(undefined);
  rpc.mockReset();
  rpc.mockResolvedValue({ data: null, error: null });
  createServerClientMock.mockReset();
  createServerClientMock.mockImplementation(() => ({ rpc }));
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  if (ORIGINAL_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = ORIGINAL_SECRET;
});

describe("withCronOutcome: recording", () => {
  it("(a) an authed 200 is recorded through the service-role RPC and the response is returned unchanged", async () => {
    const { withCronOutcome } = await load();
    const response = new Response("ok", { status: 200 });
    const handler = vi.fn(async (_r: Request) => response);
    const wrapped = withCronOutcome("headline", handler);

    const request = req(`Bearer ${SECRET}`);
    const out = await wrapped(request);

    expect(out).toBe(response);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(request);
    // deferred: nothing is written before after() runs the callback
    expect(afterMock).toHaveBeenCalledTimes(1);
    expect(rpc).not.toHaveBeenCalled();

    await flushAfter();

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ops_cron_route_run_record", {
      p_route: "headline",
      p_status: 200,
      p_duration_ms: expect.any(Number),
    });
    const args = rpc.mock.calls[0]?.[1] as { p_duration_ms: number };
    expect(Number.isInteger(args.p_duration_ms)).toBe(true);
    expect(args.p_duration_ms).toBeGreaterThanOrEqual(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it("(b) a 500 response is recorded as 500 and still returned unchanged", async () => {
    const { withCronOutcome } = await load();
    const response = new Response("{}", { status: 500 });
    const wrapped = withCronOutcome("digest", async (_r: Request) => response);

    expect(await wrapped(req(`Bearer ${SECRET}`))).toBe(response);
    await flushAfter();

    expect(rpc).toHaveBeenCalledWith("ops_cron_route_run_record", {
      p_route: "digest",
      p_status: 500,
      p_duration_ms: expect.any(Number),
    });
  });

  it("records other statuses verbatim (a 503 from the route, a 429 from its rate limiter)", async () => {
    const { withCronOutcome } = await load();
    for (const status of [503, 429, 204]) {
      rpc.mockClear();
      afterMock.mockClear();
      const wrapped = withCronOutcome("social", async (_r: Request) => new Response(null, { status }));
      await wrapped(req(`Bearer ${SECRET}`));
      await flushAfter();
      expect(rpc).toHaveBeenCalledWith("ops_cron_route_run_record", expect.objectContaining({ p_status: status }));
    }
  });

  it("(c) an inner throw records 500 and rethrows the same error", async () => {
    const { withCronOutcome } = await load();
    const boom = new Error("boom");
    const wrapped = withCronOutcome("fact-checks", async (_r: Request): Promise<Response> => {
      throw boom;
    });

    await expect(wrapped(req(`Bearer ${SECRET}`))).rejects.toBe(boom);
    await flushAfter();

    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith("ops_cron_route_run_record", {
      p_route: "fact-checks",
      p_status: 500,
      p_duration_ms: expect.any(Number),
    });
  });

  it("waits for connection() before running the handler, so no clock is read during prerender", async () => {
    const { withCronOutcome } = await load();
    const order: string[] = [];
    connectionMock.mockImplementation(async () => {
      order.push("connection");
    });
    const wrapped = withCronOutcome("alerts-webhooks", async (_r: Request) => {
      order.push("handler");
      return new Response("ok");
    });
    await wrapped(req(`Bearer ${SECRET}`));
    expect(order).toEqual(["connection", "handler"]);
  });

  it("forwards every argument to the handler untouched (same signature as withApiErrors)", async () => {
    const { withCronOutcome } = await load();
    const handler = vi.fn(async (_r: Request, _ctx: { params: Promise<object> }) => new Response("ok"));
    const wrapped = withCronOutcome("headline", handler);
    const request = req(`Bearer ${SECRET}`);
    const ctx = { params: Promise.resolve({}) };
    await wrapped(request, ctx);
    expect(handler).toHaveBeenCalledWith(request, ctx);
  });
});

describe("withCronOutcome: unauthenticated traffic is never recorded", () => {
  it("(d) a 401 (wrong bearer) writes nothing and does not even schedule", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request) => new Response("no", { status: 401 }));

    const out = await wrapped(req("Bearer not-the-secret"));
    expect(out.status).toBe(401);
    await flushAfter();

    expect(afterMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(createServerClientMock).not.toHaveBeenCalled();
  });

  it("(d) no Authorization header, a non-bearer scheme and a bare token are not recorded either", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request) => new Response("no", { status: 401 }));
    for (const header of [undefined, "", `Basic ${SECRET}`, SECRET]) {
      await wrapped(req(header));
    }
    await flushAfter();
    expect(afterMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("(d) a missing or empty CRON_SECRET never records, even when the request carries a bearer", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request) => new Response("x", { status: 503 }));

    delete process.env.CRON_SECRET;
    await wrapped(req(`Bearer ${SECRET}`));
    await wrapped(req("Bearer "));
    process.env.CRON_SECRET = "";
    await wrapped(req(`Bearer ${SECRET}`));
    await wrapped(req("Bearer "));
    await flushAfter();

    expect(afterMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("an unauthenticated request that makes the handler throw is not recorded, and the error still propagates", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request): Promise<Response> => {
      throw new Error("kaboom");
    });
    await expect(wrapped(req())).rejects.toThrow("kaboom");
    expect(afterMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("withCronOutcome: a failing outcome write never hurts the route", () => {
  it("(e) an rpc error object, a rejection and a throwing client never throw and warn exactly once in total", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request) => new Response("ok"));

    // 1. PostgREST answers an error (statement timeout)
    rpc.mockResolvedValueOnce({ data: null, error: { code: "57014", message: `canceling statement for Bearer ${SECRET}` } });
    // 2. the request rejects (network down)
    rpc.mockRejectedValueOnce(new Error(`fetch failed; Authorization: Bearer ${SECRET}`));
    // 3. the client cannot even be built (env missing)
    createServerClientMock
      .mockImplementationOnce(() => ({ rpc }))
      .mockImplementationOnce(() => ({ rpc }))
      .mockImplementationOnce(() => {
        throw new Error(`Missing SUPABASE_SERVICE_ROLE_KEY ${SECRET}`);
      });

    for (let i = 0; i < 3; i++) {
      const out = await wrapped(req(`Bearer ${SECRET}`));
      expect(out.status).toBe(200);
    }
    await expect(flushAfter()).resolves.toBeUndefined();

    expect(afterMock).toHaveBeenCalledTimes(3);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("(e) the single warning names the route and an error code, and carries no header, token or message text", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request) => new Response("ok"));
    rpc.mockResolvedValueOnce({
      data: null,
      error: { code: "57014", message: `statement timeout, header Authorization: Bearer ${SECRET}` },
    });
    await wrapped(req(`Bearer ${SECRET}`));
    await flushAfter();

    expect(warn).toHaveBeenCalledTimes(1);
    const printed = JSON.stringify(warn.mock.calls);
    expect(printed).toContain("[cron-outcome]");
    expect(printed).toContain("headline");
    expect(printed).toContain("57014");
    expect(printed).not.toContain(SECRET);
    expect(printed.toLowerCase()).not.toContain("bearer");
    expect(printed.toLowerCase()).not.toContain("authorization");
  });

  it("(e) a rejection is logged without its message (it can embed request details)", async () => {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("digest", async (_r: Request) => new Response("ok"));
    rpc.mockRejectedValueOnce(new Error(`fetch failed for Bearer ${SECRET}`));
    await wrapped(req(`Bearer ${SECRET}`));
    await flushAfter();

    expect(warn).toHaveBeenCalledTimes(1);
    const printed = JSON.stringify(warn.mock.calls);
    expect(printed).toContain("digest");
    expect(printed).not.toContain(SECRET);
    expect(printed.toLowerCase()).not.toContain("bearer");
  });

  it("(e) a hanging write never delays the response", async () => {
    const { withCronOutcome } = await load();
    rpc.mockReturnValue(new Promise(() => {})); // never settles
    const response = new Response("ok");
    const wrapped = withCronOutcome("headline", async (_r: Request) => response);

    const winner = await Promise.race([
      wrapped(req(`Bearer ${SECRET}`)),
      new Promise<string>((resolve) => setTimeout(() => resolve("late"), 500)),
    ]);
    expect(winner).toBe(response);

    // the write was only scheduled, and is still pending: after() owns it
    expect(afterMock).toHaveBeenCalledTimes(1);
    let settled = false;
    void Promise.resolve(scheduled()[0]!()).then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("(f) after() throwing outside a request scope neither throws nor writes", async () => {
    const { withCronOutcome } = await load();
    afterMock.mockImplementation(() => {
      throw new Error("`after` was called outside a request scope.");
    });
    const response = new Response("ok");
    const wrapped = withCronOutcome("headline", async (_r: Request) => response);

    await expect(wrapped(req(`Bearer ${SECRET}`))).resolves.toBe(response);

    expect(rpc).not.toHaveBeenCalled();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SECRET);
  });

  it("(f) after() throwing does not swallow the handler's own error either", async () => {
    const { withCronOutcome } = await load();
    afterMock.mockImplementation(() => {
      throw new Error("outside request scope");
    });
    const boom = new Error("handler failed");
    const wrapped = withCronOutcome("headline", async (_r: Request): Promise<Response> => {
      throw boom;
    });
    await expect(wrapped(req(`Bearer ${SECRET}`))).rejects.toBe(boom);
  });
});

// ---------------------------------------------------------------------------
// h18-jobs-1: a cron route can swallow a failed sub-step and still answer 200
// (the headline re-pick RPC failed with 42501 on 9 ticks in a row, 2026-11-01
// 23:15-23:55 UTC, and ops_health_report row 15 stayed green because every
// tick was recorded as 200). The route now says so in an internal response
// header; the wrapper records 599 for it (row 15 counts status >= 500) and
// strips the header, so Vercel still sees the real status, normally 200.
// ---------------------------------------------------------------------------
describe("withCronOutcome: sub-step failures", () => {
  const HEADER = "x-cron-substep-errors";

  function responseWith(value: string | null, init: { status?: number; body?: string | null } = {}): Response {
    const headers = new Headers({ "content-type": "text/plain" });
    if (value !== null) headers.set(HEADER, value);
    const body = init.body === undefined ? "ok" : init.body;
    return new Response(body, { status: init.status ?? 200, statusText: "Fine", headers });
  }

  /** Runs the wrapper once with an authed request and returns the response and the recorded statuses. */
  async function runOnce(response: Response, auth = `Bearer ${SECRET}`) {
    const { withCronOutcome } = await load();
    const wrapped = withCronOutcome("headline", async (_r: Request) => response);
    const out = await wrapped(req(auth));
    await flushAfter();
    const statuses = rpc.mock.calls.map((c) => (c[1] as { p_status: number }).p_status);
    return { out, statuses };
  }

  it("the constants are 'x-cron-substep-errors' and 599", async () => {
    const mod = await load();
    expect(mod.CRON_SUBSTEP_ERRORS_HEADER).toBe("x-cron-substep-errors");
    expect(mod.CRON_SUBSTEP_FAILURE_STATUS).toBe(599);
  });

  it("a 200 with the header '2' is recorded as 599, while the caller still gets a 200 without the header", async () => {
    const { out, statuses } = await runOnce(responseWith("2"));

    expect(statuses).toEqual([599]);
    expect(rpc).toHaveBeenCalledWith("ops_cron_route_run_record", {
      p_route: "headline",
      p_status: 599,
      p_duration_ms: expect.any(Number),
    });
    expect(out.status).toBe(200);
    expect(out.headers.get(HEADER)).toBeNull();
    expect(await out.text()).toBe("ok");
    expect(warn).not.toHaveBeenCalled();
  });

  it("the stripped copy keeps the status text, the other headers and the body", async () => {
    const response = responseWith("4");
    response.headers.append("x-request-id", "abc123");
    const { out } = await runOnce(response);

    expect(out.status).toBe(200);
    expect(out.statusText).toBe("Fine");
    expect(out.headers.get("content-type")).toBe("text/plain");
    expect(out.headers.get("x-request-id")).toBe("abc123");
    expect(out.headers.has(HEADER)).toBe(false);
    expect(await out.text()).toBe("ok");
  });

  it("a JSON body from NextResponse.json survives the copy", async () => {
    const { NextResponse } = await import("next/server");
    const { out, statuses } = await runOnce(
      NextResponse.json({ success: true, reason: "no candidates" }, { headers: { [HEADER]: "1" } }),
    );
    expect(statuses).toEqual([599]);
    expect(out.status).toBe(200);
    expect(out.headers.get(HEADER)).toBeNull();
    expect(out.headers.get("content-type")).toContain("application/json");
    expect(await out.json()).toEqual({ success: true, reason: "no candidates" });
  });

  it("the header '1' is recorded as 599", async () => {
    const { statuses } = await runOnce(responseWith("1"));
    expect(statuses).toEqual([599]);
  });

  it("the largest accepted count (6 digits) is recorded as 599, 7 digits are not a count", async () => {
    expect((await runOnce(responseWith("999999"))).statuses).toEqual([599]);
    rpc.mockClear();
    afterMock.mockClear();
    expect((await runOnce(responseWith("1000000"))).statuses).toEqual([200]);
  });

  it.each(["0", "abc", "-1", "1.5", "", "+1", "1e3", "0x10", "1 2"])(
    "the header %j is not a positive count: recorded as 200, and the header is stripped",
    async (value) => {
      const { out, statuses } = await runOnce(responseWith(value));

      expect(statuses).toEqual([200]);
      expect(out.status).toBe(200);
      expect(out.headers.has(HEADER)).toBe(false);
      expect(await out.text()).toBe("ok");
    },
  );

  it("a missing header records 200 and returns the very same response object", async () => {
    const response = responseWith(null);
    const { out, statuses } = await runOnce(response);

    expect(statuses).toEqual([200]);
    expect(out).toBe(response);
  });

  it("a real 5xx keeps its own status even with the header", async () => {
    const { out, statuses } = await runOnce(responseWith("1", { status: 500, body: "{}" }));
    expect(statuses).toEqual([500]);
    expect(out.status).toBe(500);
    expect(out.headers.has(HEADER)).toBe(false);

    rpc.mockClear();
    afterMock.mockClear();
    const gateway = await runOnce(responseWith("2", { status: 503, body: "down" }));
    expect(gateway.statuses).toEqual([503]);
    expect(gateway.out.status).toBe(503);
  });

  it("a status below 500 other than 200 (an empty 204, a 429) is also recorded as 599", async () => {
    const empty = await runOnce(responseWith("1", { status: 204, body: null }));
    expect(empty.statuses).toEqual([599]);
    expect(empty.out.status).toBe(204);
    expect(empty.out.headers.has(HEADER)).toBe(false);

    rpc.mockClear();
    afterMock.mockClear();
    const limited = await runOnce(responseWith("1", { status: 429, body: "slow down" }));
    expect(limited.statuses).toEqual([599]);
    expect(limited.out.status).toBe(429);
  });

  it("an unauthenticated 401 with the header is not scheduled, and the header is stripped", async () => {
    const { out, statuses } = await runOnce(responseWith("3", { status: 401, body: "no" }), "Bearer not-the-secret");

    expect(statuses).toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(createServerClientMock).not.toHaveBeenCalled();
    expect(out.status).toBe(401);
    expect(out.headers.has(HEADER)).toBe(false);
    expect(await out.text()).toBe("no");
  });

  it("an authenticated request is not recorded when the secret is unset, and the header is still stripped", async () => {
    delete process.env.CRON_SECRET;
    const { out, statuses } = await runOnce(responseWith("2", { status: 503, body: "x" }));
    expect(statuses).toEqual([]);
    expect(afterMock).not.toHaveBeenCalled();
    expect(out.headers.has(HEADER)).toBe(false);
  });

  it("the sub-step status survives a failing outcome write: the response is still the stripped 200", async () => {
    rpc.mockRejectedValueOnce(new Error("fetch failed"));
    const { out } = await runOnce(responseWith("2"));
    expect(out.status).toBe(200);
    expect(out.headers.has(HEADER)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  describe("substepErrorCount", () => {
    const countOf = async (value: string | null): Promise<number> => {
      const { substepErrorCount } = await load();
      return substepErrorCount(responseWith(value));
    };

    it("is 0 without the header", async () => {
      expect(await countOf(null)).toBe(0);
    });

    it("returns the number for 1 to 6 digits", async () => {
      expect(await countOf("1")).toBe(1);
      expect(await countOf("2")).toBe(2);
      expect(await countOf("42")).toBe(42);
      expect(await countOf("999999")).toBe(999999);
      expect(await countOf("007")).toBe(7);
    });

    it("is 0 for zero, for 7 or more digits and for anything that is not plain digits", async () => {
      for (const value of ["0", "000", "1000000", "abc", "-1", "1.5", "", "+1", "1e3", "0x10", "1,2", "1 2", "NaN"]) {
        expect(await countOf(value), JSON.stringify(value)).toBe(0);
      }
    });

    it("reads the header case-insensitively and does not consume the body", async () => {
      const { substepErrorCount } = await load();
      const response = new Response("body", { headers: { "X-Cron-Substep-Errors": "3" } });
      expect(substepErrorCount(response)).toBe(3);
      expect(response.bodyUsed).toBe(false);
      expect(await response.text()).toBe("body");
    });
  });

  // The four routes besides headline (fact-checks, alerts-webhooks, social, digest)
  // count their swallowed database failures and build the response init with this
  // helper, so a positive count becomes the internal header and zero stays invisible.
  describe("substepErrorsInit", () => {
    it.each([0, Number.NaN, -1])("adds no header for the count %s and returns the init as given", async (count) => {
      const { substepErrorsInit } = await load();
      expect(substepErrorsInit(count)).toBeUndefined();
      const init = { status: 202, headers: { "x-keep": "yes" } };
      expect(substepErrorsInit(count, init)).toBe(init);
    });

    it.each([1.5, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0.4])(
      "adds no header for the non-integer or infinite count %s",
      async (count) => {
        const { substepErrorsInit } = await load();
        expect(substepErrorsInit(count)).toBeUndefined();
      },
    );

    it("sets the header to '3' for the count 3", async () => {
      const { substepErrorsInit, CRON_SUBSTEP_ERRORS_HEADER } = await load();
      const init = substepErrorsInit(3);
      expect(init).toBeDefined();
      expect(new Headers(init?.headers).get(CRON_SUBSTEP_ERRORS_HEADER)).toBe("3");
      expect(new Headers(init?.headers).get("x-cron-substep-errors")).toBe("3");
    });

    it("keeps the existing init headers and the other init fields", async () => {
      const { substepErrorsInit } = await load();
      const init = substepErrorsInit(2, { status: 202, statusText: "Accepted", headers: { "x-keep": "yes", "cache-control": "no-store" } });
      expect(init?.status).toBe(202);
      expect(init?.statusText).toBe("Accepted");
      const headers = new Headers(init?.headers);
      expect(headers.get("x-keep")).toBe("yes");
      expect(headers.get("cache-control")).toBe("no-store");
      expect(headers.get("x-cron-substep-errors")).toBe("2");
    });

    it("accepts a Headers instance and a tuple list as the existing headers", async () => {
      const { substepErrorsInit } = await load();
      const fromInstance = substepErrorsInit(1, { headers: new Headers({ "x-a": "1" }) });
      expect(new Headers(fromInstance?.headers).get("x-a")).toBe("1");
      expect(new Headers(fromInstance?.headers).get("x-cron-substep-errors")).toBe("1");
      const fromTuples = substepErrorsInit(1, { headers: [["x-b", "2"]] });
      expect(new Headers(fromTuples?.headers).get("x-b")).toBe("2");
      expect(new Headers(fromTuples?.headers).get("x-cron-substep-errors")).toBe("1");
    });

    it("does not mutate the init the caller passed in", async () => {
      const { substepErrorsInit } = await load();
      const original = new Headers({ "x-keep": "yes" });
      const init = { status: 200, headers: original };
      substepErrorsInit(4, init);
      expect(original.has("x-cron-substep-errors")).toBe(false);
      expect(init.headers).toBe(original);
    });

    it("clamps a huge count to 999999, the largest the wrapper reads", async () => {
      const { substepErrorsInit, substepErrorCount } = await load();
      const init = substepErrorsInit(5_000_000);
      expect(new Headers(init?.headers).get("x-cron-substep-errors")).toBe("999999");
      expect(substepErrorCount(new Response(null, init))).toBe(999999);
    });

    it("round-trips through substepErrorCount", async () => {
      const { substepErrorsInit, substepErrorCount } = await load();
      expect(substepErrorCount(new Response(null, substepErrorsInit(2)))).toBe(2);
      expect(substepErrorCount(new Response(null, substepErrorsInit(0)))).toBe(0);
    });

    it("a NextResponse.json built with it is recorded as 599 and answered as the real 200 without the header", async () => {
      const { NextResponse } = await import("next/server");
      const { substepErrorsInit, withCronOutcome } = await load();
      const wrapped = withCronOutcome("digest", async (_r: Request) =>
        NextResponse.json({ sent: 1, substepErrors: 2 }, substepErrorsInit(2)),
      );
      const out = await wrapped(req(`Bearer ${SECRET}`));
      await flushAfter();

      expect(rpc).toHaveBeenCalledWith("ops_cron_route_run_record", {
        p_route: "digest",
        p_status: 599,
        p_duration_ms: expect.any(Number),
      });
      expect(out.status).toBe(200);
      expect(out.headers.has("x-cron-substep-errors")).toBe(false);
      expect(await out.json()).toEqual({ sent: 1, substepErrors: 2 });
    });
  });
});

describe("withCronOutcome: client and route validation", () => {
  it("(g) the client is created with the 2 s timeout, and CRON_OUTCOME_TIMEOUT_MS is 2000", async () => {
    const mod = await load();
    expect(mod.CRON_OUTCOME_TIMEOUT_MS).toBe(2000);

    const wrapped = mod.withCronOutcome("headline", async (_r: Request) => new Response("ok"));
    await wrapped(req(`Bearer ${SECRET}`));
    await flushAfter();

    expect(createServerClientMock).toHaveBeenCalledTimes(1);
    expect(createServerClientMock).toHaveBeenCalledWith({ timeoutMs: 2000 });
  });

  it("(h) a bad route literal throws at wrap time", async () => {
    const { withCronOutcome } = await load();
    const handler = async (_r: Request) => new Response("ok");
    const bad = ["", "Headline", "head line", "a/b", "../x", "head_line", "x".repeat(41), "headline\n", "ı"];
    for (const route of bad) {
      expect(() => withCronOutcome(route, handler), JSON.stringify(route)).toThrow();
    }
    // the shapes the table accepts
    for (const route of ["headline", "fact-checks", "alerts-webhooks", "a", "x".repeat(40), "r2"]) {
      expect(() => withCronOutcome(route, handler), route).not.toThrow();
    }
  });
});
