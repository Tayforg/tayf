import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { evaluateJev } from "../../../supabase/functions/_shared/jev-client.ts";
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROTOCOL_VERSION,
  JEV_SPEC_VERSION,
  JevRateLimitError,
  retryDelayMs,
  type JevRequest,
} from "../../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Direct tests for supabase/functions/_shared/jev-client.ts (h29-tests-2): the
// raw-fetch gateway client used by the live cluster-consumer path. Pins the
// status -> error mapping (429 / rate-limit body -> JevRateLimitError, other
// non-200 -> the static 'gateway-error'), the 5xx retry ladder, that network
// failures are rethrown unchanged, and that no error ever carries the API key
// or the gateway's response text.
//
// fetch is always a stub; the retry sleep runs on vitest fake timers.
// ---------------------------------------------------------------------------

const API_KEY = "vck_test_secret_key_do_not_leak";
const REQUEST: JevRequest = {
  state: { pair: { a: "headline a", b: "headline b" } },
  questions: { same_story: { type: "boolean", instructions: "Are these the same story?" } },
};
const VALID_BODY = {
  answers: { same_story: { type: "boolean", probability: 0.82 } },
  usage: { inputTokens: 120, outputTokens: 4 },
};

function okResponse(): Response {
  return new Response(JSON.stringify(VALID_BODY), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(...steps: Array<Response | Error>): ReturnType<typeof vi.fn> {
  const queue = [...steps];
  const fetchStub = vi.fn(async () => {
    const next = queue.shift();
    if (next === undefined) throw new Error("fetch stub queue exhausted");
    if (next instanceof Error) throw next;
    return next;
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

/** Catches the rejection of a promise without letting it become unhandled. */
async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error("expected the promise to reject");
    },
    (error: unknown) => error,
  );
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("evaluateJev success path", () => {
  it("parses a 200 body and reports a non-negative latency", async () => {
    stubFetch(okResponse());
    const result = await evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500 });
    expect(result.response.answers).toEqual(VALID_BODY.answers);
    expect(result.response.usage).toEqual(VALID_BODY.usage);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("POSTs the JSON request to the gateway with the bearer key and protocol headers", async () => {
    const fetchStub = stubFetch(okResponse());
    await evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500 });

    expect(fetchStub).toHaveBeenCalledTimes(1);
    const [url, init] = fetchStub.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(REQUEST));
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("ai-gateway-protocol-version")).toBe(JEV_PROTOCOL_VERSION);
    expect(headers.get("ai-gateway-auth-method")).toBe("api-key");
    expect(headers.get("ai-evaluation-model-specification-version")).toBe(JEV_SPEC_VERSION);
    expect(headers.get("ai-model-id")).toBe(JEV_MODEL);
    expect(headers.get("user-agent")).toBe("tayf-jev-live/1");
  });
});

describe("evaluateJev rate limiting", () => {
  it("maps a 429 to JevRateLimitError('gateway rate limited')", async () => {
    stubFetch(new Response("", { status: 429 }));
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500 }));
    expect(error).toBeInstanceOf(JevRateLimitError);
    expect((error as Error).message).toBe("gateway rate limited");
  });

  it("maps a 400 whose body says 'Too many requests' to JevRateLimitError", async () => {
    stubFetch(new Response('{"error":"Too many requests, slow down"}', { status: 400 }));
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500 }));
    expect(error).toBeInstanceOf(JevRateLimitError);
    expect((error as Error).message).toBe("gateway rate limited");
  });

  it("does not retry a rate limit even when retries are available", async () => {
    const fetchStub = stubFetch(new Response("", { status: 429 }), okResponse());
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 2 }));
    expect(error).toBeInstanceOf(JevRateLimitError);
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("evaluateJev error mapping", () => {
  it("maps a 401 to the static 'gateway-error' and never leaks the key or the body", async () => {
    const body = '{"error":"unauthorized, create a key at https://vercel.com/d?to=/ai-gateway/api-keys"}';
    stubFetch(new Response(body, { status: 401 }));
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500 }));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(JevRateLimitError);
    const message = (error as Error).message;
    expect(message).toBe("gateway-error");
    expect(message).not.toContain(API_KEY);
    expect(message).not.toContain("https://");
    expect(message).not.toContain("unauthorized");
  });

  it("makes one call and throws 'gateway-error' for a non-rate-limited 400 even with retries left", async () => {
    const fetchStub = stubFetch(new Response('{"error":"bad question"}', { status: 400 }), okResponse());
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 2 }));
    expect((error as Error).message).toBe("gateway-error");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("throws 'gateway-error' after one call for a 503 when maxRetries is 0", async () => {
    const fetchStub = stubFetch(new Response("", { status: 503 }), okResponse());
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 0 }));
    expect((error as Error).message).toBe("gateway-error");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("defaults maxRetries to 0", async () => {
    const fetchStub = stubFetch(new Response("", { status: 500 }), okResponse());
    const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500 }));
    expect((error as Error).message).toBe("gateway-error");
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });
});

describe("evaluateJev retries", () => {
  it("retries a 503 once and succeeds on the second call", async () => {
    const fetchStub = stubFetch(new Response("", { status: 503 }), okResponse());
    const pending = evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(retryDelayMs(0));
    const result = await pending;
    expect(result.response.usage.inputTokens).toBe(120);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("waits the backoff delay before the retry", async () => {
    const fetchStub = stubFetch(new Response("", { status: 502 }), okResponse());
    const pending = evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(retryDelayMs(0) - 1);
    expect(fetchStub).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("gives up with 'gateway-error' once the retries are used up", async () => {
    const fetchStub = stubFetch(
      new Response("", { status: 503 }),
      new Response("", { status: 503 }),
      okResponse(),
    );
    const failure = rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 1 }));
    await vi.advanceTimersByTimeAsync(retryDelayMs(0) + retryDelayMs(1));
    expect(((await failure) as Error).message).toBe("gateway-error");
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });

  it("retries a network error once and succeeds", async () => {
    const fetchStub = stubFetch(new TypeError("fetch failed"), okResponse());
    const pending = evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 1 });
    await vi.advanceTimersByTimeAsync(retryDelayMs(0));
    const result = await pending;
    expect(result.response.answers).toEqual(VALID_BODY.answers);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});

describe("evaluateJev fetch-level failures", () => {
  it.each(["AbortError", "TimeoutError"])(
    "rethrows the very same %s object when maxRetries is 0",
    async (name) => {
      const abort = new DOMException("The operation was aborted.", name);
      const fetchStub = stubFetch(abort, okResponse());
      const error = await rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 0 }));
      expect(error).toBe(abort);
      expect((error as Error).name).toBe(name);
      expect(fetchStub).toHaveBeenCalledTimes(1);
    },
  );

  it("rethrows the last network error unchanged once retries are exhausted", async () => {
    const first = new TypeError("fetch failed (first)");
    const last = new TypeError("fetch failed (last)");
    const fetchStub = stubFetch(first, last, okResponse());
    const failure = rejection(evaluateJev(API_KEY, REQUEST, { timeoutMs: 1500, maxRetries: 1 }));
    await vi.advanceTimersByTimeAsync(retryDelayMs(0));
    expect(await failure).toBe(last);
    expect(fetchStub).toHaveBeenCalledTimes(2);
  });
});
