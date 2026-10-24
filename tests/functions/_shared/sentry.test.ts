import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Direct coverage for supabase/functions/_shared/sentry.ts.
//
// The test-infra audit flagged that the Sentry wrapper had zero tests, even
// though it is the module standing between "Edge Function failed" and "nobody
// noticed for 7 days" (the original cluster-cron outage). This file covers
// the full state machine: graceful no-op without a DSN, passthrough wrapping
// when Sentry was never initialised, capture-then-rethrow when it was, and
// the "observability failures must never change the request outcome"
// guarantee on both withSentry and captureException.
//
// HOW THE DENO/NODE GAP IS BRIDGED (documenting the mocking choice):
//
//   * `Deno.env.get` does not exist in the vitest Node env, so we stub the
//     Deno global per-test with vi.stubGlobal — same convention as
//     safe-fetch.test.ts in this directory.
//
//   * sentry.ts keeps its SDK handle in a module-level variable set only by
//     `initSentry`, so we drive initialisation through the exported API with
//     a fake DSN rather than poking at internals. The exact-pinned
//     `npm:@sentry/deno@10.73.0` dynamic import inside `initSentry` (the pin
//     is enforced by tests/guards/edge-deps-pinned.test.ts, so this mock
//     specifier must be bumped together with it) is intercepted with vi.mock —
//     vitest registers mocks for unresolvable specifiers when a factory is
//     supplied, and routes the dynamic import through the mock registry
//     before Node resolution would fail. Each test calls `loadSentryModule`
//     (vi.resetModules + fresh dynamic import) so the module-level state
//     starts at "uninitialised" every time.
// ---------------------------------------------------------------------------

// Hoisted so the vi.mock factory below (which vitest hoists above all
// imports) can close over the same fn instances the tests assert on.
const sentryStub = vi.hoisted(() => ({
  init: vi.fn(),
  captureException: vi.fn(),
}));

vi.mock("npm:@sentry/deno@10.73.0", () => sentryStub);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_DSN = "https://abc123@o0.ingest.sentry.example/1";

interface SentryModule {
  initSentry(functionName: string): Promise<void>;
  captureException(functionName: string, err: unknown): void;
  withSentry(
    functionName: string,
    handler: (req: Request) => Promise<Response> | Response,
  ): (req: Request) => Promise<Response>;
}

/**
 * Install a Deno global whose `env.get` reads from `env`. sentry.ts only
 * touches `Deno.env.get("SENTRY_DSN")`, but we mirror the environment shape
 * the rest of the suite assumes (a `serve` stub) for consistency with
 * safe-fetch.test.ts.
 */
function stubDenoEnv(env: Record<string, string>): ReturnType<typeof vi.fn> {
  const get = vi.fn((name: string) => env[name]);
  vi.stubGlobal("Deno", { env: { get }, serve: vi.fn() });
  return get;
}

/**
 * Re-import sentry.ts with a clean module registry so the module-level
 * `Sentry` variable starts at null. Without the reset, the first test that
 * initialises Sentry would leak the configured state into every later test.
 */
async function loadSentryModule(): Promise<SentryModule> {
  vi.resetModules();
  return await import("../../../supabase/functions/_shared/sentry.ts");
}

/** Quiet console.error and return the spy for assertions. */
function spyConsoleError(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sentryStub.init.mockReset();
  sentryStub.captureException.mockReset();
});

// ---------------------------------------------------------------------------
// initSentry — DSN gate and graceful degradation
// ---------------------------------------------------------------------------

describe("initSentry", () => {
  it("is a graceful no-op when SENTRY_DSN is unset (no import attempted, no throw)", async () => {
    const envGet = stubDenoEnv({}); // no SENTRY_DSN
    const errorSpy = spyConsoleError();
    const mod = await loadSentryModule();

    await expect(mod.initSentry("cluster-consumer")).resolves.toBeUndefined();

    expect(envGet).toHaveBeenCalledWith("SENTRY_DSN");
    // The mocked SDK is the only thing `import("npm:@sentry/deno@10.73.0")` can
    // resolve to here, and a successful import is immediately followed by
    // `mod.init(...)` while a failed one logs via console.error — so
    // "neither happened" means the dynamic import was never attempted.
    expect(sentryStub.init).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();

    // And the module state must still read "unconfigured": an explicit
    // capture after the no-op init forwards nothing.
    mod.captureException("cluster-consumer", new Error("boom"));
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });

  it("initialises the SDK with the DSN and function/runtime tags when SENTRY_DSN is set", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const mod = await loadSentryModule();

    await mod.initSentry("cluster-consumer");

    expect(sentryStub.init).toHaveBeenCalledTimes(1);
    expect(sentryStub.init).toHaveBeenCalledWith(
      expect.objectContaining({
        dsn: FAKE_DSN,
        tracesSampleRate: 0,
        initialScope: {
          tags: {
            function: "cluster-consumer",
            runtime: "deno-edge-function",
          },
        },
      }),
    );
  });

  it("is idempotent — the first init wins and a second call does not re-init", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const mod = await loadSentryModule();

    await mod.initSentry("ingest");
    await mod.initSentry("ingest");

    expect(sentryStub.init).toHaveBeenCalledTimes(1);
  });

  it("degrades gracefully (logs, stays unconfigured) when SDK init throws", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const errorSpy = spyConsoleError();
    sentryStub.init.mockImplementationOnce(() => {
      throw new Error("sdk exploded");
    });
    const mod = await loadSentryModule();

    await expect(mod.initSentry("ingest")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalled();
    // `Sentry = mod` is only assigned after a successful init, so the
    // module must still behave as unconfigured.
    mod.captureException("ingest", new Error("later"));
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withSentry — passthrough when Sentry was never initialised
// ---------------------------------------------------------------------------

describe("withSentry (uninitialised — passthrough)", () => {
  it("returns the handler response unchanged", async () => {
    stubDenoEnv({});
    const mod = await loadSentryModule();
    const response = new Response("ok", { status: 201 });
    const handler = vi.fn(async (_req: Request) => response);

    const wrapped = mod.withSentry("cluster-consumer", handler);
    const result = await wrapped(new Request("http://localhost/test"));

    expect(result).toBe(response); // identity, not a copy
    expect(handler).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });

  it("still propagates a throwing handler's error (and captures nothing)", async () => {
    stubDenoEnv({});
    const mod = await loadSentryModule();
    const boom = new Error("handler blew up");
    const wrapped = mod.withSentry("cluster-consumer", () => {
      throw boom;
    });

    await expect(wrapped(new Request("http://localhost/test"))).rejects.toBe(boom);
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// withSentry — capture-then-rethrow when Sentry IS initialised
// ---------------------------------------------------------------------------

describe("withSentry (initialised — capture then rethrow)", () => {
  it("captures the thrown error with the function tag BEFORE re-throwing it", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const mod = await loadSentryModule();
    await mod.initSentry("ingest");

    const boom = new Error("feed parser died");
    const wrapped = mod.withSentry("ingest", () => {
      throw boom;
    });

    await expect(wrapped(new Request("http://localhost/test"))).rejects.toBe(boom);
    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureException).toHaveBeenCalledWith(boom, {
      tags: { function: "ingest" },
    });
  });

  it("does not capture on the success path", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const mod = await loadSentryModule();
    await mod.initSentry("ingest");

    const response = new Response("ok", { status: 200 });
    const wrapped = mod.withSentry("ingest", async () => response);

    expect(await wrapped(new Request("http://localhost/test"))).toBe(response);
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });

  it("re-throws the ORIGINAL error even when capture itself throws", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const errorSpy = spyConsoleError();
    const mod = await loadSentryModule();
    await mod.initSentry("ingest");

    const boom = new Error("the real failure");
    sentryStub.captureException.mockImplementationOnce(() => {
      throw new Error("sentry transport down");
    });
    const wrapped = mod.withSentry("ingest", () => {
      throw boom;
    });

    // Sentry being broken must not swap the error the outer 500 path sees.
    await expect(wrapped(new Request("http://localhost/test"))).rejects.toBe(boom);
    expect(errorSpy).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// captureException — explicit capture from inner catch blocks
// ---------------------------------------------------------------------------

describe("captureException", () => {
  it("is a no-op when Sentry is unconfigured", async () => {
    stubDenoEnv({});
    const mod = await loadSentryModule();

    expect(() => mod.captureException("image-consumer", new Error("x"))).not.toThrow();
    expect(sentryStub.captureException).not.toHaveBeenCalled();
  });

  it("forwards the error with the function name as a tag when configured", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const mod = await loadSentryModule();
    await mod.initSentry("image-consumer");

    const err = new Error("og scrape failed");
    mod.captureException("image-consumer", err);

    expect(sentryStub.captureException).toHaveBeenCalledTimes(1);
    expect(sentryStub.captureException).toHaveBeenCalledWith(err, {
      tags: { function: "image-consumer" },
    });
  });

  it("never throws even when the SDK capture itself throws", async () => {
    stubDenoEnv({ SENTRY_DSN: FAKE_DSN });
    const errorSpy = spyConsoleError();
    const mod = await loadSentryModule();
    await mod.initSentry("image-consumer");

    sentryStub.captureException.mockImplementationOnce(() => {
      throw new Error("sentry transport down");
    });

    expect(() => mod.captureException("image-consumer", new Error("x"))).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
  });
});
