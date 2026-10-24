import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// reader-queries F1: getNeutralizedStatus() now calls the 083 migration's
// `headline_neutral_counts()` RPC (a single index-friendly scan) instead of
// two `count: "exact", head: true` aggregates. Fixture wiring uses the
// shared fake's `rpc` option.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  eligible: 0,
  neutralized: 0,
  error: null as { message: string } | null,
  malformed: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    rpc: {
      headline_neutral_counts: () => {
        if (fixture.error) return { data: null, error: fixture.error };
        if (fixture.malformed) return { data: [{}], error: null };
        return {
          data: [{ eligible: fixture.eligible, neutralized: fixture.neutralized }],
          error: null,
        };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";
import { getNeutralizedStatus } from "./status";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.eligible = 0;
  fixture.neutralized = 0;
  fixture.error = null;
  fixture.malformed = false;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  // attemptCached logs a failed read with console.error; keep the output clean.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.mocked(console.error).mockRestore();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getNeutralizedStatus", () => {
  it("returns {neutralized: 0, eligible: N} when nothing has been rewritten yet", async () => {
    fixture.eligible = 12;
    fixture.neutralized = 0;

    await expect(getNeutralizedStatus()).resolves.toEqual({
      eligible: 12,
      neutralized: 0,
    });
  });

  it("returns the live counts once some clusters have been rewritten", async () => {
    fixture.eligible = 12;
    fixture.neutralized = 5;

    await expect(getNeutralizedStatus()).resolves.toEqual({
      eligible: 12,
      neutralized: 5,
    });
  });

  it("returns null (never throws) on a Supabase query error", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getNeutralizedStatus()).resolves.toBeNull();
  });

  it("returns null (never throws) when Supabase env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getNeutralizedStatus()).resolves.toBeNull();
  });

  it("returns null on a malformed/missing row", async () => {
    fixture.malformed = true;

    await expect(getNeutralizedStatus()).resolves.toBeNull();
  });

  describe("logging (silent-failure fix)", () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      warnSpy.mockRestore();
    });

    it("warns once with a PII-free message on a Supabase query error", async () => {
      fixture.error = { message: "canceling statement due to statement timeout" };

      await getNeutralizedStatus();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toBe(
        "[headline-status] unavailable: canceling statement due to statement timeout",
      );
      // No row/user data — only the query-level diagnostic string.
      expect(message).not.toMatch(/@/);
    });

    it("warns once with a PII-free message when Supabase env vars are missing (catch path)", async () => {
      delete process.env.NEXT_PUBLIC_SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;

      await getNeutralizedStatus();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message.startsWith("[headline-status] unavailable: ")).toBe(true);
      expect(message).not.toMatch(/@/);
    });

    it("warns 'malformed counts' on a malformed row", async () => {
      fixture.malformed = true;

      await getNeutralizedStatus();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const [message] = warnSpy.mock.calls[0] as [string];
      expect(message).toBe("[headline-status] unavailable: malformed counts");
    });
  });
});

// ---------------------------------------------------------------------------
// cached-failure-sweep: the lifetime follows the outcome. A failed read
// (rpc error, malformed counts, a client that cannot be built) resolves null
// and is memoised for 'minutes' only -- never for the whole 'cluster-feed'
// window, which would hide the "N başlık tarafsızlaştırıldı" claim copy for
// that long after a one-off timeout.
// ---------------------------------------------------------------------------

describe("getNeutralizedStatus cache lifetime", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.mocked(console.warn).mockRestore();
  });

  it("success: the counts and exactly one cacheLife('cluster-feed'), tagged first", async () => {
    fixture.eligible = 12;
    fixture.neutralized = 5;

    await expect(getNeutralizedStatus()).resolves.toEqual({ eligible: 12, neutralized: 5 });

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
    expect(cacheTag).toHaveBeenCalledWith("clusters-politics");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });

  it("a zero count is a successful answer: cached for 'cluster-feed'", async () => {
    fixture.eligible = 0;
    fixture.neutralized = 0;

    await expect(getNeutralizedStatus()).resolves.toEqual({ eligible: 0, neutralized: 0 });
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("an rpc error resolves null and is cached for 'minutes' only", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getNeutralizedStatus()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("cluster-feed");
  });

  it("malformed counts resolve null and are cached for 'minutes' only", async () => {
    fixture.malformed = true;

    await expect(getNeutralizedStatus()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("a client that cannot be built (missing env) resolves null and is cached for 'minutes' only", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getNeutralizedStatus()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("never throws across the cache boundary, whatever the rpc does", async () => {
    fixture.error = { message: "boom" };
    await expect(getNeutralizedStatus()).resolves.toBeNull();
  });

  it("stays a \"use cache: remote\" entry (the cross-instance cache) on the cached function", () => {
    const src = readFileSync(resolve(__dirname, "status.ts"), "utf8");
    expect(src).toMatch(/^\s+"use cache: remote";/m);
  });
});
