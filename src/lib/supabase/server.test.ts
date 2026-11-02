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
    vi.stubGlobal("fetch", hangingFetch());

    const err = await withFetchTimeout(30)("https://example.supabase.co/x").catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe("AbortError");
    expect((err as DOMException).message).toBe("Supabase request exceeded 30 ms");
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
