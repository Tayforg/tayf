import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Reader fail-fast timeout (server.ts).
//
// These tests use the REAL supabase-js client against a stubbed global
// `fetch`, because the behaviour under test is an interaction between three
// layers: our `withFetchTimeout` wrapper, supabase-js's `fetchWithAuth`, and
// postgrest-js's `fetchWithRetry`. A fake client would hide exactly the
// retry/abort interplay that makes the 4 s cap real (see the comment on
// `withFetchTimeout` in server.ts).
// ---------------------------------------------------------------------------

// errors.ts imports the Sentry capture helper; only isUpstreamUnavailable is
// used here.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

import { isUpstreamUnavailable } from "@/lib/api/errors";
import {
  READER_SLOW_TIMEOUT_MS,
  READER_TIMEOUT_MS,
  createFinanceServerClient,
  createReaderClient,
  createServerClient,
  createSlowReaderClient,
  withFetchTimeout,
} from "./server";

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

/** A fetch that never settles on its own and rejects when its signal aborts. */
function hangingFetch() {
  return vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) return; // would hang forever — a test failure by timeout
        if (signal.aborted) {
          reject(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  );
}

/**
 * A fetch that answers its headers at once with a body that enqueues one chunk
 * and then errors with the signal's reason once the signal aborts: what undici
 * does when an `AbortSignal` fires while the body is still streaming.
 */
function slowBodyFetch(opts: { onCancel?: (reason: unknown) => void } = {}) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        if (!signal) return;
        if (signal.aborted) {
          controller.error(signal.reason);
          return;
        }
        signal.addEventListener("abort", () => controller.error(signal.reason), {
          once: true,
        });
      },
      cancel(reason) {
        opts.onCancel?.(reason);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  });
}

function okFetch() {
  return vi.fn(
    async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  );
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    const original = ORIGINAL_ENV[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

describe("READER_TIMEOUT_MS", () => {
  it("is 4 seconds — half of PostgREST's 8 s statement_timeout", () => {
    expect(READER_TIMEOUT_MS).toBe(4000);
  });
});

describe("READER_SLOW_TIMEOUT_MS", () => {
  it("is 9 seconds — just above PostgREST's 8 s statement_timeout", () => {
    expect(READER_SLOW_TIMEOUT_MS).toBe(9000);
    expect(READER_SLOW_TIMEOUT_MS).toBeGreaterThan(8000);
  });
});

describe("createServerClient({ timeoutMs })", () => {
  it("aborts a hung request and surfaces an AbortError WITHOUT postgrest-js retrying it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);

    const startedAt = performance.now();
    const result = await createServerClient({ timeoutMs: 50 })
      .from("t")
      .select("id");
    const elapsedMs = performance.now() - startedAt;

    expect(result.data).toBeNull();
    expect(result.error?.message).toMatch(/AbortError/);
    expect(elapsedMs).toBeLessThan(1000);
    // Exactly one call: a capped client has `db: { retry: false }`, and the
    // timeout is also re-thrown as an AbortError (second guard), so
    // postgrest-js's retry loop never engages.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("a caller-supplied abort signal still wins and settles fast with an AbortError", async () => {
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);

    const startedAt = performance.now();
    const result = await createServerClient({ timeoutMs: 5000 })
      .from("t")
      .select("id")
      .abortSignal(controller.signal);
    const elapsedMs = performance.now() - startedAt;

    expect(result.error?.message).toMatch(/AbortError/);
    expect(elapsedMs).toBeLessThan(1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("passes a healthy response through untouched", async () => {
    vi.stubGlobal("fetch", okFetch());

    const result = await createServerClient({ timeoutMs: 5000 })
      .from("t")
      .select("id");

    expect(result.error).toBeNull();
    expect(result.data).toEqual([]);
  });
});

describe("createServerClient() without options", () => {
  it("never installs a timeout (crons, admin and writers keep the old behaviour)", async () => {
    vi.stubGlobal("fetch", okFetch());
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const result = await createServerClient().from("t").select("id");

    expect(result.error).toBeNull();
    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it("throws a readable error when the Supabase env vars are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createServerClient()).toThrow(/Missing NEXT_PUBLIC_SUPABASE_URL/);
    expect(() => createReaderClient()).toThrow(/Missing NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("createServerClient() without options keeps postgrest-js retries", () => {
  it("a non-abort failure stays retryable on the UNCAPPED client (1 attempt + 3 retries)", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
      vi.stubGlobal("fetch", fetchMock);

      // The builder is lazy: the request starts when it is awaited.
      const pending = (async () => await createServerClient().from("t").select("id"))();
      await vi.advanceTimersByTimeAsync(8000);
      const result = await pending;

      expect(fetchMock).toHaveBeenCalledTimes(4);
      expect(result.error?.message).toMatch(/fetch failed/);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createReaderClient()", () => {
  it("applies READER_TIMEOUT_MS (4000) to every request", async () => {
    vi.stubGlobal("fetch", okFetch());
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const result = await createReaderClient().from("t").select("id");

    expect(result.error).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(4000);
  });
});

describe("createSlowReaderClient()", () => {
  it("applies READER_SLOW_TIMEOUT_MS (9000) to every request", async () => {
    vi.stubGlobal("fetch", okFetch());
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const result = await createSlowReaderClient().from("t").select("id");

    expect(result.error).toBeNull();
    expect(timeoutSpy).toHaveBeenCalledWith(9000);
  });

  it("throws a readable error when the Supabase env vars are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    expect(() => createSlowReaderClient()).toThrow(/Missing NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("withFetchTimeout", () => {
  it("resolves globalThis.fetch at call time, so a later stub is honoured", async () => {
    const wrapped = withFetchTimeout(1000);
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    const res = await wrapped("https://example.supabase.co/rest/v1/t");

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("re-throws a timeout as an AbortError DOMException naming the budget", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", hangingFetch());

    const err = await withFetchTimeout(30)("https://example.supabase.co/x").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect((err as DOMException).message).toBe("Supabase request exceeded 30 ms");
  });

  it("logs the header-phase relabel once, naming the phase and the elapsed ms, never the URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", hangingFetch());

    await withFetchTimeout(30)(
      "https://example.supabase.co/rest/v1/secret_table?token=abc123",
    ).catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(warn.mock.calls[0]?.[0]);
    expect(warn.mock.calls[0]).toHaveLength(1);
    expect(line).toMatch(
      /^\[supabase\] request exceeded 30 ms \(phase: headers, elapsed: \d+ ms\)$/,
    );
    expect(line).not.toContain("://");
    expect(line).not.toContain("secret_table");
    expect(line).not.toContain("abc123");
  });

  it("does not log for a caller abort during the header phase", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("caller gave up")), 5);

    await withFetchTimeout(5000)("https://example.supabase.co/x", {
      signal: controller.signal,
    }).catch(() => undefined);

    expect(warn).not.toHaveBeenCalled();
  });

  it("does NOT rename a caller abort — the caller's own reason propagates", async () => {
    vi.stubGlobal("fetch", hangingFetch());
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    setTimeout(() => controller.abort(reason), 5);

    const err = await withFetchTimeout(5000)("https://example.supabase.co/x", {
      signal: controller.signal,
    }).catch((e: unknown) => e);

    expect(err).toBe(reason);
  });

  it("does NOT rewrite non-abort failures (the wrapper passes them through untouched)", async () => {
    const boom = new TypeError("fetch failed");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(boom));

    await expect(withFetchTimeout(5000)("https://example.supabase.co/x")).rejects.toBe(
      boom,
    );
  });

  it("forwards init (method, headers) alongside the combined signal", async () => {
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);

    await withFetchTimeout(5000)("https://example.supabase.co/x", {
      method: "HEAD",
      headers: { "x-test": "1" },
    });

    const [, init] = fetchMock.mock.calls[0] as unknown as [unknown, RequestInit];
    expect(init.method).toBe("HEAD");
    expect(init.headers).toEqual({ "x-test": "1" });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

// ---------------------------------------------------------------------------
// h28-errors-2: AbortSignal.timeout stays attached to the response body, so a
// timer that fires during `res.text()` used to reject OUTSIDE the header-phase
// try/catch with a DOMException named TimeoutError (postgrest-js then surfaced
// "TimeoutError: The operation was aborted due to timeout", status 0). The
// body is now wrapped so the same budget is relabelled as the AbortError.
// ---------------------------------------------------------------------------
describe("withFetchTimeout: body phase", () => {
  const BODY_URL = "https://example.supabase.co/rest/v1/secret_table?token=abc123";

  it("(i) a timeout while the body streams rejects res.text() with the relabelled AbortError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", slowBodyFetch());

    const res = await withFetchTimeout(50)(BODY_URL);
    const err = await res.text().catch((e: unknown) => e);

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect((err as DOMException).message).toBe("Supabase request exceeded 50 ms");
  });

  it("(ii) a caller abort during the body keeps the caller's own reason", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", slowBodyFetch());
    const controller = new AbortController();
    const reason = new Error("caller gave up");
    setTimeout(() => controller.abort(reason), 10);

    const res = await withFetchTimeout(5000)(BODY_URL, { signal: controller.signal });
    const err = await res.text().catch((e: unknown) => e);

    expect(err).toBe(reason);
    expect(warn).not.toHaveBeenCalled();
  });

  it("a body error that is not our timeout passes through untouched", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const boom = new TypeError("terminated");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.error(boom);
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const res = await withFetchTimeout(5000)(BODY_URL);
    const err = await res.text().catch((e: unknown) => e);

    expect(err).toBe(boom);
    expect(warn).not.toHaveBeenCalled();
  });

  it("(iii) a body that completes in time is byte-identical, status line and headers preserved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // Not valid UTF-8 on purpose: the wrap must never decode and re-encode.
    const bytes = new Uint8Array([0, 255, 254, 128, 10, 13, 123, 125, 0xc3, 0x28]);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(bytes, {
            status: 206,
            statusText: "Partial Content",
            headers: {
              "content-type": "application/octet-stream",
              "content-range": "0-9/10",
              "x-test": "kept",
            },
          }),
      ),
    );

    const res = await withFetchTimeout(5000)(BODY_URL);

    expect(res.status).toBe(206);
    expect(res.statusText).toBe("Partial Content");
    expect(res.ok).toBe(true);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect(res.headers.get("content-range")).toBe("0-9/10");
    expect(res.headers.get("x-test")).toBe("kept");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes);
    expect(warn).not.toHaveBeenCalled();
  });

  it("an error status keeps its status, statusText and body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response('{"code":"PGRST116"}', {
            status: 406,
            statusText: "Not Acceptable",
            headers: { "content-type": "application/json" },
          }),
      ),
    );

    const res = await withFetchTimeout(5000)(BODY_URL);

    expect(res.ok).toBe(false);
    expect(res.status).toBe(406);
    expect(res.statusText).toBe("Not Acceptable");
    expect(await res.json()).toEqual({ code: "PGRST116" });
  });

  it.each([
    ["new Response(null)", () => new Response(null)],
    ["a 204", () => new Response(null, { status: 204 })],
    ["a 205", () => new Response(null, { status: 205 })],
    ["a 304", () => new Response(null, { status: 304 })],
    [
      "a 101 (cannot be built with the Response constructor, so a stub)",
      () => ({ status: 101, body: new ReadableStream() }) as unknown as Response,
    ],
  ])("(iv) %s is returned as the SAME object", async (_label, make) => {
    const original = make();
    vi.stubGlobal("fetch", vi.fn(async () => original));

    const res = await withFetchTimeout(5000)(BODY_URL);

    expect(res).toBe(original);
  });

  it("(v) streams: the first chunk is readable before the second is enqueued", async () => {
    const enc = new TextEncoder();
    const dec = new TextDecoder();
    let second: (() => void) | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(enc.encode("one"));
                second = () => {
                  controller.enqueue(enc.encode("two"));
                  controller.close();
                };
              },
            }),
            { status: 200 },
          ),
      ),
    );

    const res = await withFetchTimeout(5000)(BODY_URL);
    const reader = res.body!.getReader();

    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(dec.decode(first.value)).toBe("one");
    // The stub has not enqueued "two" yet: nothing was buffered to the end.
    expect(second).toBeDefined();

    second!();
    const next = await reader.read();
    expect(dec.decode(next.value)).toBe("two");
    expect((await reader.read()).done).toBe(true);
  });

  it("cancelling the wrapped body forwards the reason to the original body", async () => {
    const cancelled = vi.fn();
    vi.stubGlobal("fetch", slowBodyFetch({ onCancel: cancelled }));

    const res = await withFetchTimeout(5000)(BODY_URL);
    await res.body!.cancel("not needed");

    expect(cancelled).toHaveBeenCalledTimes(1);
    expect(cancelled).toHaveBeenCalledWith("not needed");
  });

  it("(vi) logs the body-phase relabel once, naming the phase and the elapsed ms, never the URL", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal("fetch", slowBodyFetch());

    const res = await withFetchTimeout(50)(BODY_URL);
    await res.text().catch(() => undefined);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]).toHaveLength(1);
    const line = String(warn.mock.calls[0]?.[0]);
    const m = /^\[supabase\] request exceeded 50 ms \(phase: body, elapsed: (\d+) ms\)$/.exec(line);
    expect(m).not.toBeNull();
    const elapsed = Number(m?.[1]);
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(2000);
    expect(line).not.toContain("://");
    expect(line).not.toContain("secret_table");
    expect(line).not.toContain("abc123");
  });

  it("(vii) end to end: the reader client answers an upstream-unavailable AbortError, not a TimeoutError", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = slowBodyFetch();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createServerClient({ timeoutMs: 50 }).from("x").select();

    expect(result.data).toBeNull();
    expect(result.error?.message.startsWith("AbortError: Supabase request exceeded 50 ms")).toBe(true);
    expect(isUpstreamUnavailable(result.error)).toBe(true);
    // A capped client never retries.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("createFinanceServerClient({ timeoutMs })", () => {
  it("passes the timeout through on the real (non-fixture) branch", async () => {
    vi.stubGlobal("fetch", okFetch());
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const client = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
    await client.from("t").select("id");

    expect(timeoutSpy).toHaveBeenCalledWith(4000);
  });

  it("without options installs no timeout (admin finance fetchers keep the old behaviour)", async () => {
    vi.stubGlobal("fetch", okFetch());
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");

    const client = await createFinanceServerClient();
    await client.from("t").select("id");

    expect(timeoutSpy).not.toHaveBeenCalled();
  });

  it("the dev-fixture branch ignores the options and never touches the network", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TAYF_FAKE_FINANCE", "1");
    const fetchMock = okFetch();
    vi.stubGlobal("fetch", fetchMock);
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const client = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });

    expect(client).toBeDefined();
    expect(timeoutSpy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
