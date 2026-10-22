import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createSupabaseFake, type PgResult } from "../../../tests/_helpers/supabase-fake";

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// Only the capped reader client is exported by the mock: if public-status.ts
// ever reached for createServerClient it would be undefined and every test
// below would fail.
const h = vi.hoisted(() => ({
  createReaderClient: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createReaderClient: h.createReaderClient,
}));

import { cacheLife, cacheTag } from "next/cache";

import { fetchPublicStatus, getPublicStatus } from "./public-status";

const VALID_PAYLOAD = {
  generated_at: "2026-10-22T10:00:00.123456+00:00",
  ingest: { ok: true, last_by_bias: { center: "2026-10-22T09:50:00+00:00" } },
  clustering: { ok: true, last_at: "2026-10-22T09:55:00+00:00" },
  labelling: { ok: true, last_at: "2026-10-22T09:45:00+00:00", paused: false },
  feeds: { ok: true, active: 118, silent: 26 },
};

const EXPECTED_SNAPSHOT = {
  generatedAt: "2026-10-22T10:00:00.123456+00:00",
  ingest: { ok: true, lastByBias: { center: "2026-10-22T09:50:00+00:00" } },
  clustering: { ok: true, lastAt: "2026-10-22T09:55:00+00:00" },
  labelling: { ok: true, lastAt: "2026-10-22T09:45:00+00:00", paused: false },
  feeds: { ok: true, active: 118, silent: 26 },
};

let results: Array<PgResult | (() => PgResult)>;
let fake: ReturnType<typeof createSupabaseFake>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function ok(data: unknown): PgResult {
  return { data, error: null };
}
function fail(message: string): PgResult {
  return { data: null, error: { message } };
}

beforeEach(() => {
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  h.createReaderClient.mockReset();
  results = [];
  fake = createSupabaseFake({
    rpc: {
      public_status_snapshot: () => {
        const next = results.length > 1 ? results.shift()! : results[0]!;
        return typeof next === "function" ? next() : next;
      },
    },
  });
  h.createReaderClient.mockImplementation(() => fake.client);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
});

describe("getPublicStatus", () => {
  it("reads public_status_snapshot through the capped reader client and returns the validated snapshot", async () => {
    results = [ok(VALID_PAYLOAD)];

    await expect(getPublicStatus()).resolves.toEqual(EXPECTED_SNAPSHOT);

    expect(h.createReaderClient).toHaveBeenCalled();
    expect(fake.calls.rpc.map((c) => c.name)).toEqual(["public_status_snapshot"]);
  });

  it("tags the cache entry and, on success, calls cacheLife exactly once with the short 'status' profile (staleness bounded to a few minutes, never the 1 h 'minutes' expiry)", async () => {
    results = [ok(VALID_PAYLOAD)];

    await getPublicStatus();

    expect(cacheTag).toHaveBeenCalledWith("public-status");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("status");
  });

  it("does not retry live when the cached attempt succeeded (one rpc)", async () => {
    results = [ok(VALID_PAYLOAD)];
    await getPublicStatus();
    expect(fake.calls.rpc).toHaveLength(1);
  });

  it("returns null when the rpc errors on both the cached attempt and the live retry", async () => {
    results = [fail("canceling statement due to statement timeout")];

    await expect(getPublicStatus()).resolves.toBeNull();

    expect(fake.calls.rpc).toHaveLength(2);
    // the failed attempt is memoised for 'minutes' only, still one cacheLife call
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("status");
  });

  it("a transient first failure is healed by the live retry", async () => {
    results = [fail("connection reset"), ok(VALID_PAYLOAD)];

    await expect(getPublicStatus()).resolves.toEqual(EXPECTED_SNAPSHOT);
    expect(fake.calls.rpc).toHaveLength(2);
  });

  it.each([
    ["a null payload", null],
    ["a non-object payload", "ok"],
    ["an empty object", {}],
    ["an invalid generated_at", { ...VALID_PAYLOAD, generated_at: "yesterday" }],
    ["a missing section", { ...VALID_PAYLOAD, feeds: undefined }],
    ["an array payload", [VALID_PAYLOAD]],
  ])("returns null for %s (a malformed payload is never rendered as a verdict)", async (_label, payload) => {
    results = [ok(payload)];
    await expect(getPublicStatus()).resolves.toBeNull();
  });

  it("strips unknown keys from the payload before it leaves the module", async () => {
    results = [
      ok({
        ...VALID_PAYLOAD,
        detail: "cron failed net._http_response",
        labelling: { ...VALID_PAYLOAD.labelling, jobname: "jev-shadow" },
      }),
    ];

    const s = await getPublicStatus();

    expect(JSON.stringify(s)).not.toMatch(/cron|_http_response|jobname|jev-shadow/);
    expect(s).toEqual(EXPECTED_SNAPSHOT);
  });

  it("never throws, even when the client factory itself throws", async () => {
    h.createReaderClient.mockImplementation(() => {
      throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
    });

    await expect(getPublicStatus()).resolves.toBeNull();
  });

  it("never throws when the rpc promise rejects", async () => {
    results = [
      () => {
        throw new Error("socket hang up");
      },
    ];

    await expect(getPublicStatus()).resolves.toBeNull();
  });
});

describe("fetchPublicStatus", () => {
  it("throws on an rpc error (so the cache wrapper can record the failure)", async () => {
    results = [fail("permission denied for function public_status_snapshot")];
    await expect(fetchPublicStatus()).rejects.toThrow(/public_status_snapshot/);
  });

  it("throws when validation yields null", async () => {
    results = [ok({ generated_at: "nope" })];
    await expect(fetchPublicStatus()).rejects.toThrow();
  });

  it("returns the validated snapshot on success", async () => {
    results = [ok(VALID_PAYLOAD)];
    await expect(fetchPublicStatus()).resolves.toEqual(EXPECTED_SNAPSHOT);
  });
});

describe("public-status.ts source contract", () => {
  const src = readFileSync(join(__dirname, "public-status.ts"), "utf8");
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/gm, "$1");

  it("uses the remote cache directive and one string-literal cacheLife per outcome branch ('status' on success, 'minutes' on failure)", () => {
    expect(code).toContain('"use cache: remote"');
    expect([...code.matchAll(/\bcacheLife\(([^)]*)\)/g)].map((m) => m[1])).toEqual([
      '"status"',
      '"minutes"',
    ]);
    // success -> status, failure -> minutes, as an if/else (one call executes)
    expect(code).toMatch(/if\s*\(\s*r\.ok\s*\)\s*cacheLife\("status"\);\s*else\s+cacheLife\("minutes"\);/);
  });

  it("never touches the plain server client and never reads the clock", () => {
    expect(code).not.toMatch(/\bcreateServerClient\s*\(/);
    expect(code).toMatch(/\bcreateReaderClient\s*\(/);
    expect(code).not.toMatch(/Date\.now\(|new Date\(\)/);
  });

  it("calls the rpc by its exact name and nothing else", () => {
    expect([...code.matchAll(/\.rpc\(\s*"([a-z_]+)"/g)].map((m) => m[1])).toEqual(["public_status_snapshot"]);
    expect(code).not.toMatch(/\.from\(/);
  });
});
