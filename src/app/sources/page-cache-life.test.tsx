import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake } from "../../../tests/_helpers/supabase-fake";

// ---------------------------------------------------------------------------
// cached-failure-sweep: /sources reads the directory through a "use cache"
// function, and its cache lifetime must follow the outcome of that read.
//
// Before the sweep the directory was cached for the whole 'source-directory'
// window (expire 1 h) BEFORE the query ran, and the failure was a throw out of
// the cache body. Now: `getSourcesCached` wraps the raw `readSourcesDirectory`
// in attemptCached and picks 'source-directory' only after a success; a failed
// read is memoised for 'minutes', retried live once, and only then does the
// page render its "Kaynak listesi şu an yüklenemedi" state.
//
// Kept apart from page.test.tsx (the kind-badge UI suite) so the cacheLife
// counting does not entangle with its shuffled fixtures.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));
vi.mock("next/server", () => ({
  connection: vi.fn(async () => undefined),
}));

// The clickbait gate stays closed: no karne read, no extra cacheLife.
vi.mock("@/lib/sources/clickbait", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/clickbait")>();
  return {
    ...actual,
    isClickbaitPublic: vi.fn(() => false),
    getClickbaitKarne: vi.fn(async () => null),
  };
});

// SourcesPage starts the weekly-count read (getSourceItemsPerDay, its own "use
// cache" with its own cacheLife and client build) before it awaits the
// directory. This suite counts the DIRECTORY read's cacheLife calls and client
// builds, so the counts read is stubbed out; its own lifetime rule is covered
// in src/lib/sources/feed-status.test.ts.
vi.mock("@/lib/sources/feed-status", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sources/feed-status")>();
  return { ...actual, getSourceItemsPerDay: vi.fn(async () => null) };
});

const supabaseFixture = vi.hoisted(() => ({
  /** Every client build throws. */
  fail: false,
  /** The first N builds throw (a blip the live retry heals). */
  blips: 0,
  builds: 0,
}));

function makeFakeClient() {
  const rows = [
    {
      id: "s-outlet",
      name: "Outlet Gazete",
      slug: "s-outlet",
      url: "https://example.com/outlet",
      rss_url: "https://example.com/outlet/rss",
      bias: "pro_government",
      logo_url: null,
      active: true,
      kind: "outlet",
      latest: [],
    },
  ];
  return createSupabaseFake({ tables: { sources: rows } }).client;
}

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    supabaseFixture.builds += 1;
    if (supabaseFixture.blips > 0) {
      supabaseFixture.blips -= 1;
      throw new Error("supabase blip");
    }
    if (supabaseFixture.fail) throw new Error("supabase unavailable");
    return makeFakeClient();
  },
}));

import { cacheLife, cacheTag } from "next/cache";
import { connection } from "next/server";
import SourcesPage from "./page";

/** Every string leaf under an element tree (components are NOT expanded). */
function collectStrings(node: unknown, out: string[] = []): string[] {
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
  } else if (Array.isArray(node)) {
    for (const child of node) collectStrings(child, out);
  } else if (node && typeof node === "object") {
    const el = node as { props?: { children?: unknown } };
    if (el.props?.children !== undefined) collectStrings(el.props.children, out);
  }
  return out;
}

const FAILURE_COPY = "Kaynak listesi şu an yüklenemedi";

beforeEach(() => {
  supabaseFixture.fail = false;
  supabaseFixture.blips = 0;
  supabaseFixture.builds = 0;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  vi.mocked(connection).mockClear();
  // attemptCached / the retry log with console.error; the page with warn.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("/sources directory cache lifetime", () => {
  it("failure: renders the unavailable state and memoises the failure for 'minutes' only", async () => {
    supabaseFixture.fail = true;

    const text = collectStrings(await SourcesPage()).join(" ");

    expect(text).toContain(FAILURE_COPY);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
    // The cached attempt + exactly one live retry, then the fallback.
    expect(supabaseFixture.builds).toBe(2);
  });

  it("success: the directory renders and is cached for 'source-directory', tagged first", async () => {
    const text = collectStrings(await SourcesPage()).join(" ");

    expect(text).not.toContain(FAILURE_COPY);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
    expect(supabaseFixture.builds).toBe(1);
  });

  it("success: the page never waits for a request (connection() is not called), so `next build` can prerender it", async () => {
    await SourcesPage();

    // The first hit after a deploy must be a prerender, not a request-time
    // render: a connection() on the success path postpones the whole body at
    // build time (the 4.4-5.6 s cold hit). Only the live retry may wait for a
    // request, and only after the cached attempt failed.
    expect(connection).not.toHaveBeenCalled();
  });

  it("failure: only the live retry waits for a request scope, once, before it re-reads", async () => {
    supabaseFixture.fail = true;

    await SourcesPage();

    // awaitRequestScope() inside resolveCachedOrRetry: in a prerender it never
    // settles and postpones the body to request time (loading.tsx is the
    // boundary); at request time it resolves and the retry runs.
    expect(connection).toHaveBeenCalledTimes(1);
  });

  it("a blip on the cached attempt is healed by the live retry: the page renders, the failure stays cached for 'minutes'", async () => {
    supabaseFixture.blips = 1;

    const text = collectStrings(await SourcesPage()).join(" ");

    expect(text).not.toContain(FAILURE_COPY);
    expect(supabaseFixture.builds).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});
