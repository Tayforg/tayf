import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Capped clients never retry (server.ts, hunt-27 resilience-1).
//
// postgrest-js's fetchWithRetry retries GET/HEAD three times (1 s / 2 s / 4 s,
// or the response's `Retry-After` in seconds, uncapped) on a 503 or a 520 and
// on any fetch rejection that is not an abort. Under the 4 s reader cap that
// turned a Supabase outage into about 7 s per request and ~14 s per page once
// the resolveCachedOrRetry live retry ran. Capped clients (`timeoutMs` set)
// therefore pass `db: { retry: false }`.
//
// REAL supabase-js against a stubbed `globalThis.fetch`: the behaviour under
// test lives in the interaction of supabase-js, postgrest-js and our wrapper,
// so a fake client would prove nothing. Dummy URL and key; nothing leaves the
// process.
// ---------------------------------------------------------------------------

import {
  createReaderClient,
  createServerClient,
  createSlowReaderClient,
} from "./server";

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const ORIGINAL_ENV: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) ORIGINAL_ENV[k] = process.env[k];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const k of ENV_KEYS) {
    const original = ORIGINAL_ENV[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

/** A fresh Response per call (a body can be consumed once). */
function respondWith(status: number, headers: Record<string, string>, body: string) {
  return vi.fn(async () => new Response(body, { status, headers }));
}

interface Scenario {
  name: string;
  fetchMock: () => ReturnType<typeof vi.fn>;
}

const SCENARIOS: Scenario[] = [
  {
    name: "a 503 with a PGRST002 JSON body",
    fetchMock: () =>
      respondWith(503, { "content-type": "application/json" }, '{"code":"PGRST002"}'),
  },
  {
    name: "a 520 with retry-after: 30",
    fetchMock: () =>
      respondWith(520, { "content-type": "text/plain", "retry-after": "30" }, "origin error"),
  },
  {
    name: "a fetch rejection (TypeError: fetch failed)",
    fetchMock: () => vi.fn().mockRejectedValue(new TypeError("fetch failed")),
  },
];

const CAPPED_FACTORIES = [
  ["createReaderClient", createReaderClient],
  ["createSlowReaderClient", createSlowReaderClient],
] as const;

describe.each(CAPPED_FACTORIES)("%s never retries", (_name, factory) => {
  it.each(SCENARIOS)("makes exactly one call on $name", async ({ fetchMock }) => {
    const fetchSpy = fetchMock();
    vi.stubGlobal("fetch", fetchSpy);

    const startedAt = performance.now();
    const result = await factory().from("t").select("id");
    const elapsedMs = performance.now() - startedAt;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(elapsedMs).toBeLessThan(500);
    expect(result.data).toBeNull();
    expect(result.error).not.toBeNull();
  });
});

describe("the retrying clients keep their retries (control)", () => {
  it("createServerClient() makes 4 calls on a 503 (crons and writers keep postgrest-js retries)", async () => {
    vi.useFakeTimers();
    const fetchSpy = respondWith(
      503,
      { "content-type": "application/json" },
      '{"code":"PGRST002"}',
    );
    vi.stubGlobal("fetch", fetchSpy);

    // The builder is lazy: the request starts when it is awaited.
    const pending = (async () => await createServerClient().from("t").select("id"))();
    await vi.advanceTimersByTimeAsync(8000);
    const result = await pending;

    // 1 initial attempt + DEFAULT_MAX_RETRIES (3) at 1 s / 2 s / 4 s. The 7 s
    // of backoff is skipped by advancing the fake clock past it.
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(result.error).not.toBeNull();
  });

  it("createServerClient() makes 4 calls when fetch rejects with TypeError: fetch failed", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchSpy);

    // The builder is lazy: the request starts when it is awaited.
    const pending = (async () => await createServerClient().from("t").select("id"))();
    await vi.advanceTimersByTimeAsync(8000);
    await pending;

    expect(fetchSpy).toHaveBeenCalledTimes(4);
  });
});
