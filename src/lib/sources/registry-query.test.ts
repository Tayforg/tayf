import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Data layer behind GET /api/sources and GET /api/sources/[slug]. Pinned here:
//   - every Supabase request is built through createReaderClient (the 4 s
//     reader cap), never the plain createServerClient;
//   - the "use cache" bodies never throw (attemptCached): a failure comes back
//     as a sentinel, is retried once live, and only a sustained failure
//     THROWS (so the route answers 500 instead of caching an empty registry);
//   - exactly ONE cacheLife per invocation: 'source-directory' on success,
//     'minutes' on a failed attempt;
//   - the detail is keyed by the source id and returns exactly
//     { zone_history, reader_agreement }.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

type PgError = { message: string };
type Envelope = { data: unknown; error: PgError | null };

const fixture = vi.hoisted(() => ({
  /** One envelope per query of that kind, consumed in order; the last repeats. */
  sources: [] as Envelope[],
  history: [] as Envelope[],
  served: { sources: 0, history: 0 },
  sourcesStates: [] as unknown[],
  historyStates: [] as unknown[],
}));

function nextEnvelope(kind: "sources" | "history"): Envelope {
  const list = fixture[kind];
  const i = Math.min(fixture.served[kind], list.length - 1);
  fixture.served[kind] += 1;
  return list[i] as Envelope;
}

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state: unknown) => {
        fixture.sourcesStates.push(state);
        return nextEnvelope("sources");
      },
      source_zone_history: (state: unknown) => {
        fixture.historyStates.push(state);
        return nextEnvelope("history");
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

// The reader-cap spy: wraps the REAL factory so the client is still built
// from the mocked supabase-js, and fails the suite if the plain client is used.
const clients = vi.hoisted(() => ({
  reader: vi.fn(),
  plain: vi.fn(),
}));

vi.mock("@/lib/supabase/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/supabase/server")>();
  clients.reader.mockImplementation(actual.createReaderClient);
  clients.plain.mockImplementation(actual.createServerClient);
  return {
    ...actual,
    createReaderClient: clients.reader,
    createServerClient: clients.plain,
  };
});

const agreement = vi.hoisted(() => ({ getSourceAgreement: vi.fn() }));
vi.mock("@/lib/game/agreement", () => agreement);

import { cacheLife, cacheTag } from "next/cache";
import { getRegistryDetail, getRegistryRows } from "./registry-query";

const ROWS = [
  {
    id: "src-1",
    slug: "haberturk",
    name: "Habertürk",
    url: "https://www.haberturk.com",
    bias: "gov_leaning",
    kind: "outlet",
    active: true,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: null,
    trustee_note: null,
  },
];

const HISTORY = [
  {
    old_bias: "center",
    new_bias: "gov_leaning",
    reason: "r",
    rater: "editör",
    changed_at: "2026-01-02T00:00:00.000Z",
  },
  {
    old_bias: null,
    new_bias: "center",
    reason: null,
    rater: null,
    changed_at: "2026-01-01T00:00:00.000Z",
  },
];

const ENV_KEYS = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"] as const;
const ORIGINAL_ENV = { ...process.env };

const ok = (data: unknown): Envelope => ({ data, error: null });
const fail = (message: string): Envelope => ({ data: null, error: { message } });

let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.sources = [ok(ROWS)];
  fixture.history = [ok(HISTORY)];
  fixture.served = { sources: 0, history: 0 };
  fixture.sourcesStates = [];
  fixture.historyStates = [];
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  clients.reader.mockClear();
  clients.plain.mockClear();
  agreement.getSourceAgreement.mockReset();
  agreement.getSourceAgreement.mockResolvedValue(null);
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  for (const k of ENV_KEYS) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

type State = {
  selectArgs: unknown[];
  eq: Array<{ col: string; val: unknown }>;
  order: Array<{ col: string; opts: unknown }>;
  limit: number | null;
};

describe("getRegistryRows", () => {
  it("reads the active sources through the capped reader client, ordered by name", async () => {
    const rows = await getRegistryRows();

    expect(rows).toEqual(ROWS);
    expect(clients.reader).toHaveBeenCalledTimes(1);
    expect(clients.plain).not.toHaveBeenCalled();

    const state = fixture.sourcesStates[0] as State;
    const columns = String(state.selectArgs[0])
      .split(",")
      .map((c) => c.trim())
      .sort();
    expect(columns).toEqual(
      [
        "id",
        "slug",
        "name",
        "url",
        "bias",
        "kind",
        "active",
        "zone_rationale",
        "zone_rationale_at",
        "trustee_since",
        "trustee_note",
      ].sort(),
    );
    expect(String(state.selectArgs[0])).not.toContain("*");
    expect(String(state.selectArgs[0])).not.toContain("rss_url");
    expect(state.eq).toEqual([{ col: "active", val: true }]);
    expect(state.order).toEqual([{ col: "name", opts: undefined }]);
  });

  it("tags the entry 'sources' and keeps the source-directory lifetime on success, once", async () => {
    await getRegistryRows();
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("returns [] (not null) for an empty result", async () => {
    fixture.sources = [ok(null)];
    expect(await getRegistryRows()).toEqual([]);
  });

  it("heals a transient failure with one live retry, memoising the blip for 'minutes' only", async () => {
    fixture.sources = [fail("canceling statement due to statement timeout"), ok(ROWS)];

    const rows = await getRegistryRows();

    expect(rows).toEqual(ROWS);
    expect(fixture.served.sources).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("THROWS when the cached attempt and the live retry both fail (never an empty registry)", async () => {
    fixture.sources = [fail("boom")];

    await expect(getRegistryRows()).rejects.toThrow(/boom/);

    expect(fixture.served.sources).toBe(2);
    // One cacheLife for the one cached invocation, and it is the short one.
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("logs the cached failure but never lets it reject across the cache boundary", async () => {
    fixture.sources = [fail("first"), ok(ROWS)];
    await expect(getRegistryRows()).resolves.toEqual(ROWS);
    expect(errorSpy).toHaveBeenCalled();
  });

  it("treats a missing Supabase env var as a failure that throws, not a crash inside the cache", async () => {
    // The real factory (wrapped by the spy) throws on a missing key.
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    await expect(getRegistryRows()).rejects.toThrow(/Missing NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("getRegistryDetail", () => {
  it("returns the newest-first 50-row history plus the reader agreement for that source id", async () => {
    agreement.getSourceAgreement.mockResolvedValue({ n: 30, share: 0.633 });

    const detail = await getRegistryDetail("src-1");

    expect(detail).toEqual({
      zone_history: HISTORY,
      reader_agreement: { n: 30, share: 0.633 },
    });
    expect(agreement.getSourceAgreement).toHaveBeenCalledTimes(1);
    expect(agreement.getSourceAgreement).toHaveBeenCalledWith("src-1");

    const state = fixture.historyStates[0] as State;
    expect(String(state.selectArgs[0]).split(",").map((c) => c.trim())).toEqual([
      "old_bias",
      "new_bias",
      "reason",
      "rater",
      "changed_at",
    ]);
    expect(state.eq).toEqual([{ col: "source_id", val: "src-1" }]);
    expect(state.order).toEqual([
      { col: "changed_at", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(50);
  });

  it("builds its client through createReaderClient, never the plain client", async () => {
    await getRegistryDetail("src-1");
    expect(clients.reader).toHaveBeenCalled();
    expect(clients.plain).not.toHaveBeenCalled();
  });

  it("keeps a null reader agreement (the endpoint degrades, it does not fail)", async () => {
    agreement.getSourceAgreement.mockResolvedValue(null);
    const detail = await getRegistryDetail("src-1");
    expect(detail.reader_agreement).toBeNull();
    expect(detail.zone_history).toEqual(HISTORY);
  });

  it("returns an empty history array (not null) when the source has no changes", async () => {
    fixture.history = [ok(null)];
    expect((await getRegistryDetail("src-1")).zone_history).toEqual([]);
  });

  it("tags the entry 'sources' and keeps the source-directory lifetime on success, once", async () => {
    await getRegistryDetail("src-1");
    expect(cacheTag).toHaveBeenCalledWith("sources");
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("heals a transient history failure with one live retry", async () => {
    fixture.history = [fail("timeout"), ok(HISTORY)];
    const detail = await getRegistryDetail("src-1");
    expect(detail.zone_history).toEqual(HISTORY);
    expect(fixture.served.history).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("THROWS when the history read fails on the cached attempt and the live retry", async () => {
    fixture.history = [fail("history boom")];

    await expect(getRegistryDetail("src-1")).rejects.toThrow(/history boom/);

    expect(fixture.served.history).toBe(2);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});
