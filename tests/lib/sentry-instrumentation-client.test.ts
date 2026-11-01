import { afterEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Behaviour of the browser entry point (instrumentation-client.ts): it must
// not touch the Sentry SDK unless NEXT_PUBLIC_SENTRY_DSN is set, and its
// onRouterTransitionStart forwarder must be a safe no-op until the lazily
// loaded browser-init module (and with it the SDK) is in. The module under
// test is imported fresh per case; browser-init is replaced by a gated fake so
// "before the chunk arrives" is deterministic, not a race.
//
// The init options themselves are pinned by
// tests/guards/sentry-data-collection.test.ts.
// ---------------------------------------------------------------------------

const INIT_SPECIFIER = "../../src/lib/sentry/browser-init";
const DSN = "https://public@o0.ingest.sentry.io/0";

const fake = vi.hoisted(() => ({
  /** Runs when the browser-init module is evaluated, i.e. when its chunk would be fetched. */
  evaluated: vi.fn(),
  initBrowserSentry: vi.fn(),
  captureRouterTransitionStart: vi.fn(),
}));

type Entry = {
  onRouterTransitionStart: (href: string, navigationType: string) => void;
};

/**
 * Imports instrumentation-client.ts with NEXT_PUBLIC_SENTRY_DSN set to `dsn`.
 * `gate` (optional) delays, or fails, the fake browser-init module load.
 */
async function loadEntry(
  dsn: string | undefined,
  gate?: () => Promise<void>,
): Promise<Entry> {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_SENTRY_DSN", dsn);
  vi.doMock(INIT_SPECIFIER, async () => {
    fake.evaluated();
    await gate?.();
    return {
      initBrowserSentry: fake.initBrowserSentry,
      captureRouterTransitionStart: fake.captureRouterTransitionStart,
    };
  });
  return (await import("../../instrumentation-client")) as unknown as Entry;
}

/** Lets a pending dynamic import (and its .then) settle if one was started. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock(INIT_SPECIFIER);
  fake.evaluated.mockReset();
  fake.initBrowserSentry.mockReset();
  fake.captureRouterTransitionStart.mockReset();
});

describe.each([
  ["unset", undefined],
  ["an empty string", ""],
])("instrumentation-client with NEXT_PUBLIC_SENTRY_DSN %s", (_label, dsn) => {
  it("never loads the browser Sentry module", async () => {
    await loadEntry(dsn);
    await flush();

    expect(fake.evaluated).not.toHaveBeenCalled();
    expect(fake.initBrowserSentry).not.toHaveBeenCalled();
  });

  it("exports a forwarder that does nothing and does not throw", async () => {
    const entry = await loadEntry(dsn);
    await flush();

    expect(() => entry.onRouterTransitionStart("/gundem", "push")).not.toThrow();
    expect(fake.captureRouterTransitionStart).not.toHaveBeenCalled();
  });
});

describe("instrumentation-client with NEXT_PUBLIC_SENTRY_DSN set", () => {
  it("loads browser-init and initialises it with the DSN exactly once", async () => {
    await loadEntry(DSN);
    await vi.waitFor(() => expect(fake.initBrowserSentry).toHaveBeenCalled());

    expect(fake.initBrowserSentry).toHaveBeenCalledTimes(1);
    expect(fake.initBrowserSentry).toHaveBeenCalledWith(DSN);
  });

  it("drops navigations that start before the SDK chunk has loaded", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = await loadEntry(DSN, () => gate);
    await flush();
    expect(fake.evaluated).toHaveBeenCalledTimes(1);

    expect(() => entry.onRouterTransitionStart("/early", "push")).not.toThrow();
    expect(fake.captureRouterTransitionStart).not.toHaveBeenCalled();
    expect(fake.initBrowserSentry).not.toHaveBeenCalled();

    release();
    await vi.waitFor(() => expect(fake.initBrowserSentry).toHaveBeenCalled());
  });

  it("forwards navigations to the SDK's captureRouterTransitionStart once loaded", async () => {
    const entry = await loadEntry(DSN);
    await vi.waitFor(() => expect(fake.initBrowserSentry).toHaveBeenCalled());

    entry.onRouterTransitionStart("/gundem?q=1", "push");
    entry.onRouterTransitionStart("/", "traverse");

    expect(fake.captureRouterTransitionStart.mock.calls).toEqual([
      ["/gundem?q=1", "push"],
      ["/", "traverse"],
    ]);
  });

  it("never lets a throwing SDK break a navigation", async () => {
    fake.captureRouterTransitionStart.mockImplementation(() => {
      throw new Error("sdk exploded");
    });
    const entry = await loadEntry(DSN);
    await vi.waitFor(() => expect(fake.initBrowserSentry).toHaveBeenCalled());

    expect(() => entry.onRouterTransitionStart("/x", "replace")).not.toThrow();
    expect(fake.captureRouterTransitionStart).toHaveBeenCalledTimes(1);
  });

  it("survives the SDK chunk failing to load (offline, blocked by an ad-blocker)", async () => {
    const entry = await loadEntry(DSN, () => Promise.reject(new Error("ChunkLoadError")));
    await flush();

    expect(fake.initBrowserSentry).not.toHaveBeenCalled();
    expect(() => entry.onRouterTransitionStart("/x", "push")).not.toThrow();
    expect(fake.captureRouterTransitionStart).not.toHaveBeenCalled();
  });

  it("survives Sentry.init throwing and keeps the forwarder inert", async () => {
    fake.initBrowserSentry.mockImplementation(() => {
      throw new Error("bad DSN");
    });
    const entry = await loadEntry(DSN);
    await vi.waitFor(() => expect(fake.initBrowserSentry).toHaveBeenCalled());
    await flush();

    expect(() => entry.onRouterTransitionStart("/x", "push")).not.toThrow();
    expect(fake.captureRouterTransitionStart).not.toHaveBeenCalled();
  });
});
