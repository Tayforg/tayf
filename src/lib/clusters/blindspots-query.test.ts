import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Two-step query (reader-queries D1): Step A is a lean `select('id')` over
// the same filters as before; Step B fetches the embed in batches of
// EMBED_BATCH_SIZE (50), in Step-A order. The shared fake's `clusters`
// resolver branches on `state.selectArgs[0] === 'id'` to serve the right
// fixture for each step.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

// errors.ts imports the Sentry helper; the classification below never calls it.
vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

const fixture = vi.hoisted(() => ({
  candidateIds: [] as string[],
  candidateError: null as { message: string; code?: string } | null,
  /** The PostgREST response status that rides along with `candidateError`. */
  candidateStatus: undefined as number | undefined,
  /** id -> embedded row. */
  rowsById: new Map<string, unknown>(),
  embedError: null as { message: string; code?: string } | null,
  /** The PostgREST response status that rides along with `embedError`. */
  embedStatus: undefined as number | undefined,
  lastIdState: null as unknown,
  embedStates: [] as unknown[],
  /** The options object each `createClient(url, key, opts)` call received. */
  clientOpts: [] as unknown[],
  /** h106: the jev_shadow_predictions rows the recall lookup receives. */
  recallRows: [] as unknown[],
  recallError: null as { message: string } | null,
  /** Builder state of every recall lookup, in call order. */
  recallStates: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        const s = state as { selectArgs: unknown[]; in: Array<{ col: string; vals: unknown[] }> };
        if (s.selectArgs[0] === "id") {
          fixture.lastIdState = state;
          if (fixture.candidateError) {
            return { data: null, error: fixture.candidateError, status: fixture.candidateStatus };
          }
          return { data: fixture.candidateIds.map((id) => ({ id })), error: null };
        }
        fixture.embedStates.push(state);
        if (fixture.embedError) {
          return { data: null, error: fixture.embedError, status: fixture.embedStatus };
        }
        const wantedIds = (s.in.find((f) => f.col === "id")?.vals ?? []) as string[];
        const rows = wantedIds
          .map((id) => fixture.rowsById.get(id))
          .filter((r): r is unknown => r !== undefined);
        return { data: rows, error: null };
      },
      jev_shadow_predictions: (state: unknown) => {
        fixture.recallStates.push(state);
        if (fixture.recallError) return { data: null, error: fixture.recallError };
        return { data: fixture.recallRows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: (_url: string, _key: string, opts?: unknown) => {
    fixture.clientOpts.push(opts);
    return supabaseFake.client;
  },
}));

// feed-health.ts is owned by a concurrent worker in this pack — mocked here
// so this suite never depends on its real (possibly-Supabase-backed)
// implementation.
const feedHealthMock = vi.hoisted(() => ({
  getZoneFeedHealth: vi.fn(),
  shouldSuppressBlindspot: vi.fn(),
}));

vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return {
    ...actual,
    getZoneFeedHealth: feedHealthMock.getZoneFeedHealth,
    shouldSuppressBlindspot: feedHealthMock.shouldSuppressBlindspot,
  };
});

import { cacheLife } from "next/cache";
import {
  BLINDSPOT_CANDIDATE_SAFETY_CAP,
  BLINDSPOT_LIST_LOOKBACK_DAYS,
  EMBED_BATCH_SIZE,
  fetchEmbedBatch,
  getBlindspots,
  getBlindspotsSafe,
} from "./blindspots-query";
import { isUpstreamUnavailable } from "@/lib/api/errors";
import { __resetCacheResilienceForTests } from "@/lib/cache-resilience";
import { votingZoneCounts } from "@/lib/feeds/zone-line";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

const ORIGINAL_ENV = { ...process.env };

// ---------------------------------------------------------------------------
// Fixture builders — each row carries 5 distinct-source members of the same
// bias category so the live re-tally (zoneTallyOf) clears
// BLINDSPOT.minSources (5) and BLINDSPOT.dominantShare (0.8).
// ---------------------------------------------------------------------------

function mkMember(
  clusterId: string,
  index: number,
  bias: BiasCategory,
  overrides: {
    image_url?: string | null;
    image_allowed?: boolean;
    /** browser-3: `undefined` leaves the key off the embed (legacy row). */
    logo_url?: string | null;
    /** Source kind; defaults to the voting "outlet". */
    kind?: SourceKind;
  } = {},
) {
  const sourceId = `${clusterId}-s${index}`;
  return {
    articles: {
      id: `${clusterId}-a${index}`,
      title: `Haber ${clusterId}-${index}`,
      url: `https://example.com/${clusterId}-${index}`,
      image_url: overrides.image_url ?? null,
      published_at: `2026-01-0${index + 1}T00:00:00.000Z`,
      source_id: sourceId,
      category: "politika",
      content_hash: null,
      sources: {
        id: sourceId,
        name: `Kaynak ${sourceId}`,
        bias,
        kind: overrides.kind ?? "outlet",
        image_allowed: overrides.image_allowed,
        ...(overrides.logo_url !== undefined ? { logo_url: overrides.logo_url } : {}),
      },
    },
  };
}

function mkBlindspotClusterRow(
  id: string,
  bias: BiasCategory,
  memberOverrides: Array<{
    image_url?: string | null;
    image_allowed?: boolean;
    logo_url?: string | null;
  }> = [],
) {
  return {
    id,
    title_tr: `Örnek başlık ${id}`,
    title_tr_neutral: null,
    summary_tr: "Özet",
    bias_distribution: {},
    is_blindspot: true,
    blindspot_side: bias,
    article_count: 5,
    first_published: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-05T00:00:00.000Z",
    cluster_articles: Array.from({ length: 5 }, (_, i) =>
      mkMember(id, i, bias, memberOverrides[i] ?? {}),
    ),
  };
}

function seedRows(rows: Array<{ id: string }>) {
  fixture.candidateIds = rows.map((r) => r.id);
  fixture.rowsById = new Map(rows.map((r) => [r.id, r]));
}

beforeEach(() => {
  // Last-good values and cooldowns are per-process module state; a test must
  // never see another test's success (or outage).
  __resetCacheResilienceForTests();
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.candidateIds = [];
  fixture.candidateError = null;
  fixture.candidateStatus = undefined;
  fixture.rowsById = new Map();
  fixture.embedError = null;
  fixture.embedStatus = undefined;
  fixture.lastIdState = null;
  fixture.embedStates = [];
  fixture.clientOpts = [];
  fixture.recallRows = [];
  fixture.recallError = null;
  fixture.recallStates = [];
  vi.mocked(cacheLife).mockClear();
  feedHealthMock.getZoneFeedHealth.mockReset();
  feedHealthMock.shouldSuppressBlindspot.mockReset();
  feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
  feedHealthMock.shouldSuppressBlindspot.mockReturnValue(false);
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("getBlindspots query shape (Step A: lean candidate select)", () => {
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;
  const NOW = Date.parse("2026-11-06T12:00:00.000Z");

  async function stepAState(): Promise<BuilderState> {
    // Only Date is faked: Step A reads the clock for its two window bounds.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    try {
      await getBlindspots();
    } finally {
      vi.useRealTimers();
    }
    return fixture.lastIdState as BuilderState;
  }

  it("excludes archived clusters and keeps the documented blindspot pre-filters", async () => {
    const state = await stepAState();
    expect(state.table).toBe("clusters");
    expect(state.selectArgs[0]).toBe("id");
    expect(state.eq).toHaveLength(3);
    expect(state.eq).toContainEqual({ col: "is_blindspot", val: true });
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.eq).toContainEqual({ col: "blindspot_recall_veto", val: false });
    expect(state.gte[0]).toEqual({ col: "article_count", val: 3 });
    expect(state.order).toEqual([
      { col: "updated_at", opts: { ascending: false } },
    ]);
  });

  it("keeps the 24 h feed delay: first_published must be older than now - feedDelayHours", async () => {
    const state = await stepAState();
    expect(state.lt).toEqual([
      { col: "first_published", val: new Date(NOW - 24 * HOUR).toISOString() },
    ]);
  });

  it("h53-consistency-1: bounds the window below at now - 7 days (first_published), so every claim of the week is a candidate", async () => {
    const state = await stepAState();
    expect(state.gte).toContainEqual({
      col: "first_published",
      val: new Date(NOW - 7 * DAY).toISOString(),
    });
    expect(state.gte).toHaveLength(2);
    expect(BLINDSPOT_LIST_LOOKBACK_DAYS).toBe(7);
  });

  it("h53-consistency-1: the safety cap is 150 ids (at most 3 embed batches), a bound and not a sample", async () => {
    const state = await stepAState();
    expect(state.limit).toBe(150);
    expect(BLINDSPOT_CANDIDATE_SAFETY_CAP).toBe(150);
    expect(Math.ceil(BLINDSPOT_CANDIDATE_SAFETY_CAP / EMBED_BATCH_SIZE)).toBe(3);
  });

  it("throws with the documented prefix on a Step-A error", async () => {
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots()).rejects.toThrow(
      "[blindspots] candidate select error: db down",
    );
  });
});

// ---------------------------------------------------------------------------
// h128-apiv1-3: the message keeps its prefix, so the PostgREST code and status
// of a database outage (a 57014, the reader cap's AbortError, a gateway 504 with
// an HTML body) ride along as the Error's `cause`. getBlindspots rethrows the
// live retry's error unchanged (resolveCachedOrThrow), so the keyed alerts route
// can still answer 503 instead of 500.
// ---------------------------------------------------------------------------
describe("getBlindspots: a database outage stays classifiable (h128-apiv1-3)", () => {
  const OUTAGES: Array<[string, { message: string; code?: string }, number]> = [
    ["a 57014 statement timeout", { message: "canceling statement due to statement timeout", code: "57014" }, 500],
    ["the reader cap's AbortError", { message: "AbortError: Supabase request exceeded 4000 ms", code: "" }, 0],
    ["a gateway answer with an HTML body (504)", { message: "<html>Gateway Timeout</html>", code: "" }, 504],
  ];
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it.each(OUTAGES)("Step A, %s", async (_label, error, status) => {
    fixture.candidateError = error;
    fixture.candidateStatus = status;

    const err = await getBlindspots().catch((e: unknown) => e);

    expect((err as Error).message).toBe(`[blindspots] candidate select error: ${error.message}`);
    expect(isUpstreamUnavailable(err)).toBe(true);
  });

  it.each(OUTAGES)("Step B, %s", async (_label, error, status) => {
    seedRows([mkBlindspotClusterRow("cluster-x", "pro_government")]);
    fixture.embedError = error;
    fixture.embedStatus = status;

    const err = await getBlindspots().catch((e: unknown) => e);

    expect((err as Error).message).toBe(`[blindspots] embedded select error: ${error.message}`);
    expect(isUpstreamUnavailable(err)).toBe(true);
  });

  it("a unique violation is not an outage (Step A and Step B)", async () => {
    fixture.candidateError = { message: "duplicate key", code: "23505" };
    fixture.candidateStatus = 409;
    expect(isUpstreamUnavailable(await getBlindspots().catch((e: unknown) => e))).toBe(false);

    fixture.candidateError = null;
    seedRows([mkBlindspotClusterRow("cluster-x", "pro_government")]);
    fixture.embedError = { message: "duplicate key", code: "23505" };
    fixture.embedStatus = 409;
    expect(isUpstreamUnavailable(await getBlindspots().catch((e: unknown) => e))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Read profile (cold-read resilience): the 4 s reader cap belongs to
// user-facing callers only. The digest / social crons and the alerts-webhooks
// cron call the same fetcher; they must keep the plain client (no per-request
// timeout) so a cold read can use the full 8 s statement_timeout.
// ---------------------------------------------------------------------------

/** A capped client is built with a custom `global.fetch`; a plain one is not. */
function isCappedClientOpts(opts: unknown): boolean {
  const g = (opts as { global?: { fetch?: unknown } } | undefined)?.global;
  return typeof g?.fetch === "function";
}

describe("getBlindspots read profile", () => {
  it("defaults to capped reader clients for both Step A and Step B", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots();
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(2);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });

  it("the batch profile (crons) builds only plain, uncapped clients", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots({ profile: "batch" });
    expect(fixture.clientOpts.length).toBeGreaterThanOrEqual(2);
    expect(fixture.clientOpts.some(isCappedClientOpts)).toBe(false);
  });

  it("the batch live retry after a failed cache attempt is uncapped too", async () => {
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots({ profile: "batch" })).rejects.toThrow(
      "[blindspots] candidate select error: db down",
    );
    // cached attempt + live retry
    expect(fixture.clientOpts).toHaveLength(2);
    expect(fixture.clientOpts.some(isCappedClientOpts)).toBe(false);
  });

  it("getBlindspotsSafe (the /blindspots page) stays on the capped reader client", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspotsSafe();
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The feed-health gate follows the caller's profile, and the cached entry's
// lifetime depends on the outcome (failures live for "minutes", never for a
// full cluster-feed window).
// ---------------------------------------------------------------------------

describe("getBlindspots feed-health profile forwarding", () => {
  it("forwards { profile: 'reader' } to getZoneFeedHealth by default", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots();
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledWith({ profile: "reader" });
  });

  it("forwards { profile: 'batch' } for the crons, so their health read is uncapped too", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots({ profile: "batch" });
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledWith({ profile: "batch" });
  });

  it("getBlindspotsSafe (the /blindspots page) forwards the reader profile", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspotsSafe();
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledWith({ profile: "reader" });
  });
});

describe("getBlindspots cache lifetime", () => {
  it("success calls cacheLife exactly once with cluster-feed", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("an empty candidate list is a success: cluster-feed, not minutes", async () => {
    await getBlindspots();
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("cluster-feed");
  });

  it("a failed attempt calls cacheLife exactly once with minutes (the live retry is outside the cache)", async () => {
    fixture.candidateError = {
      message: "AbortError: Supabase request exceeded 4000 ms",
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(getBlindspots()).rejects.toThrow(
        "[blindspots] candidate select error",
      );
    } finally {
      errSpy.mockRestore();
    }
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });
});

// A candidate that never clears the contract (only 1 source, well under
// BLINDSPOT.minSources) — used below to force full batch traversal
// without any early-exit from the `bundles.length >= 30` stop condition.
function mkFailingCandidateRow(id: string) {
  return {
    id,
    title_tr: `Fail ${id}`,
    title_tr_neutral: null,
    summary_tr: "",
    bias_distribution: {},
    is_blindspot: true,
    blindspot_side: "pro_government",
    article_count: 1,
    first_published: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    cluster_articles: [mkMember(id, 0, "pro_government")],
  };
}

describe("getBlindspots Step B: batched embed", () => {
  it("uses .in batches of at most EMBED_BATCH_SIZE (50), in Step-A order", async () => {
    const rows = Array.from({ length: 60 }, (_, i) => mkFailingCandidateRow(`c${i}`));
    seedRows(rows);

    await getBlindspots();

    expect(fixture.embedStates.length).toBeGreaterThanOrEqual(2);
    for (const s of fixture.embedStates) {
      const st = s as BuilderState;
      expect((st.in[0]?.vals.length ?? 0)).toBeLessThanOrEqual(50);
      expect(st.limit).toBeNull();
      expect(st.order).toEqual([]);
    }
  });

  it("carries the BL-13 rights flags in the embed select", async () => {
    seedRows([mkBlindspotClusterRow("cluster-gate", "pro_government")]);
    await getBlindspots();
    const st = fixture.embedStates[0] as BuilderState;
    const selectArg = st.selectArgs[0] as string;
    expect(selectArg).toMatch(/\bblindspot_recall_veto\b/);
    expect(selectArg).toMatch(/sources\s*\([^)]*\bimage_allowed\b/);
    expect(selectArg).toMatch(/sources\s*\([^)]*\bexcerpt_allowed\b/);
    // browser-3: the sources embed must carry logo_url so the headline rows
    // can render favicons (ClusterCardSource.logo_url).
    expect(selectArg).toMatch(/sources\s*\([^)]*\blogo_url\b/);
    // Migration 089 ("ADMIT"): politics_share must see the admission stamp.
    expect(selectArg).toMatch(/\bpolitics_admitted_at\b/);
  });

  it("120 candidates (none clearing the contract) produce exactly 3 embed batches (ceil(120/50))", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => mkFailingCandidateRow(`c${i}`));
    seedRows(rows);

    await getBlindspots();

    expect(fixture.embedStates).toHaveLength(3);
  });

  it("h53-consistency-1: never stops early at 30 bundles: 120 passing candidates request all 3 embed batches", async () => {
    // Used to stop after the first batch of 50 once 30 bundles passed, which is
    // how 20 public claims (7 of the 9 Muhalefet ones) never reached the page.
    const rows = Array.from({ length: 120 }, (_, i) =>
      mkBlindspotClusterRow(`c${i}`, i % 2 === 0 ? "pro_government" : "opposition"),
    );
    seedRows(rows);

    const result = await getBlindspots();

    expect(fixture.embedStates).toHaveLength(3);
    expect(result.bundles).toHaveLength(30);
    expect(result.claimCount).toBe(120);
    expect(result.more).toHaveLength(90);
  });

  it("h53-consistency-1: the embed batches and the feed-health read are issued together (Promise.all), not one after another", async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      mkBlindspotClusterRow(`c${i}`, "pro_government"),
    );
    seedRows(rows);
    let releaseHealth!: (v: null) => void;
    feedHealthMock.getZoneFeedHealth.mockImplementation(
      () => new Promise<null>((resolve) => (releaseHealth = resolve)),
    );

    const pending = getBlindspots();
    // Health is held open: if the batches waited for it, none would be asked.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(fixture.embedStates).toHaveLength(3);

    releaseHealth(null);
    await expect(pending).resolves.toMatchObject({ claimCount: 120 });
  });

  it("keeps fetchEmbedBatch and EMBED_BATCH_SIZE exported for near-blindspots-query", async () => {
    expect(EMBED_BATCH_SIZE).toBe(50);
    const row = mkBlindspotClusterRow("near-1", "pro_government");
    fixture.rowsById = new Map([["near-1", row]]);

    const rows = await fetchEmbedBatch(["near-1"], "reader");

    expect(rows.map((r) => r.id)).toEqual(["near-1"]);
  });

  it("fewer than 30 bundles from the first batch triggers a second batch", async () => {
    // Only 5 candidates in Step A total (well under one batch), but split
    // across a synthetic scenario where the first "batch" undershoots 30 —
    // simulated by seeding 55 ids where only the first 5 pass the contract
    // (others have <5 distinct sources so they fail BLINDSPOT.minSources).
    const passing = Array.from({ length: 5 }, (_, i) =>
      mkBlindspotClusterRow(`pass${i}`, "pro_government"),
    );
    const failing = Array.from({ length: 50 }, (_, i) => ({
      id: `fail${i}`,
      title_tr: `Fail ${i}`,
      title_tr_neutral: null,
      summary_tr: "",
      bias_distribution: {},
      is_blindspot: true,
      blindspot_side: "pro_government",
      article_count: 1,
      first_published: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
      cluster_articles: [mkMember(`fail${i}`, 0, "pro_government")],
    }));
    const extra = mkBlindspotClusterRow("extra0", "opposition");
    seedRows([...passing, ...failing, extra]);

    const { bundles } = await getBlindspots();

    expect(fixture.embedStates).toHaveLength(2);
    expect(bundles.map((b) => b.cluster.id)).toContain("extra0");
  });

  it("throws with the documented prefix on a Step-B error", async () => {
    seedRows([mkBlindspotClusterRow("cluster-x", "pro_government")]);
    fixture.embedError = { message: "embed down" };
    await expect(getBlindspots()).rejects.toThrow(
      "[blindspots] embedded select error: embed down",
    );
  });
});

// ---------------------------------------------------------------------------
// votingZoneCounts: the per-zone VOTING tally the card's dominantZone /
// dominantPct come from. The silence band reads it, so it must be that very
// tally and never a recount over bundle.sources (which also holds the
// non-voting aggregator / niche kinds).
// ---------------------------------------------------------------------------

function mkMixedRow(
  id: string,
  members: Array<{ bias: BiasCategory; kind?: SourceKind }>,
) {
  return {
    ...mkBlindspotClusterRow(id, "pro_government"),
    cluster_articles: members.map((m, i) =>
      mkMember(id, i, m.bias, m.kind ? { kind: m.kind } : {}),
    ),
  };
}

describe("getBlindspots votingZoneCounts", () => {
  it("is the voting tally the card is built from (prod case: 5 outlets, 100% iktidar)", async () => {
    seedRows([mkBlindspotClusterRow("vz-prod", "pro_government")]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.dominantZone).toBe("iktidar");
    expect(bundles[0]!.dominantPct).toBe(1);
    expect(bundles[0]!.votingZoneCounts).toEqual({
      iktidar: 5,
      bagimsiz: 0,
      muhalefet: 0,
    });
  });

  it("excludes non-voting kinds even though they stay in bundle.sources", async () => {
    seedRows([
      mkMixedRow("vz-agg", [
        { bias: "pro_government" },
        { bias: "pro_government" },
        { bias: "gov_leaning" },
        { bias: "state_media", kind: "wire" },
        { bias: "nationalist" },
        { bias: "opposition", kind: "aggregator" },
        { bias: "center", kind: "niche" },
      ]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    // The aggregator and niche sources are listed on the card ...
    expect(bundle.sources).toHaveLength(7);
    // ... but never vote: neither the zone counts nor the 100% share see them.
    expect(bundle.votingZoneCounts).toEqual({
      iktidar: 5,
      bagimsiz: 0,
      muhalefet: 0,
    });
    expect(bundle.dominantZone).toBe("iktidar");
    expect(bundle.dominantPct).toBe(1);
  });

  it("counts a voting minority source and agrees with dominantPct", async () => {
    seedRows([
      mkMixedRow("vz-mixed", [
        { bias: "pro_government" },
        { bias: "pro_government" },
        { bias: "pro_government" },
        { bias: "pro_government" },
        { bias: "opposition" },
      ]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const { votingZoneCounts, dominantZone, dominantPct } = bundles[0]!;
    expect(votingZoneCounts).toEqual({ iktidar: 4, bagimsiz: 0, muhalefet: 1 });
    const total =
      votingZoneCounts.iktidar + votingZoneCounts.bagimsiz + votingZoneCounts.muhalefet;
    expect(votingZoneCounts[dominantZone] / total).toBe(dominantPct);
  });

  it("counts each source once (same-source duplicates are deduped before the tally)", async () => {
    const row = mkMixedRow("vz-dedupe", [
      { bias: "opposition" },
      { bias: "opposition" },
      { bias: "opposition" },
      { bias: "opposition" },
      { bias: "opposition" },
    ]);
    // A second, later article from the first source: must not inflate the count.
    row.cluster_articles.push({
      articles: {
        ...row.cluster_articles[0]!.articles,
        id: "vz-dedupe-dup",
        published_at: "2026-01-09T00:00:00.000Z",
      },
    });
    seedRows([row]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.dominantZone).toBe("muhalefet");
    expect(bundles[0]!.votingZoneCounts).toEqual({
      iktidar: 0,
      bagimsiz: 0,
      muhalefet: 5,
    });
  });
});

// bundle.sources carry `kind`, so zone lines outside the card (RSS, social)
// can recount on the voting basis from the sources alone and land on exactly
// the tally the card's dominantZone / dominantPct are built from.
describe("getBlindspots source kind", () => {
  it("carries kind on bundle.sources, null when the embed has none", async () => {
    const row = mkMixedRow("vk-kind", [
      { bias: "pro_government" },
      { bias: "pro_government" },
      { bias: "gov_leaning" },
      { bias: "state_media", kind: "wire" },
      { bias: "nationalist" },
      { bias: "opposition", kind: "aggregator" },
      { bias: "center", kind: "niche" },
    ]);
    // A legacy member whose embedded source has no kind column at all.
    delete (row.cluster_articles[2]!.articles.sources as { kind?: SourceKind }).kind;
    seedRows([row]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const kindById = Object.fromEntries(
      bundles[0]!.sources.map((s) => [s.id, s.kind]),
    );
    expect(kindById).toEqual({
      "vk-kind-s0": "outlet",
      "vk-kind-s1": "outlet",
      "vk-kind-s2": null,
      "vk-kind-s3": "wire",
      "vk-kind-s4": "outlet",
      "vk-kind-s5": "aggregator",
      "vk-kind-s6": "niche",
    });
  });

  it("votingZoneCounts(bundle.sources) deep-equals bundle.votingZoneCounts", async () => {
    seedRows([
      mkMixedRow("vk-eq", [
        { bias: "pro_government" },
        { bias: "pro_government" },
        { bias: "gov_leaning" },
        { bias: "state_media", kind: "wire" },
        { bias: "nationalist" },
        { bias: "opposition", kind: "aggregator" },
        { bias: "center", kind: "niche" },
      ]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(votingZoneCounts(bundle.sources)).toEqual(bundle.votingZoneCounts);
    // The raw source list is wider than the voting basis.
    expect(bundle.sources).toHaveLength(7);
  });
});

describe("getBlindspots BL-13 image_allowed gate", () => {
  it("nulls image_url for a member whose source has image_allowed: false, leaving an allowed member's image untouched", async () => {
    seedRows([
      mkBlindspotClusterRow("cluster-gate", "pro_government", [
        {
          image_url: "https://cdn.blocked.example/foto.jpg",
          image_allowed: false,
        },
        {
          image_url: "https://cdn.allowed.example/foto.jpg",
          image_allowed: true,
        },
      ]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const byId = Object.fromEntries(
      bundles[0]!.articles.map((a) => [a.id, a]),
    );
    expect(byId["cluster-gate-a0"]?.image_url).toBeNull();
    expect(byId["cluster-gate-a1"]?.image_url).toBe(
      "https://cdn.allowed.example/foto.jpg",
    );
  });
});

describe("getBlindspots gif-filter image_url gate (http-1)", () => {
  it("nulls a .gif member image_url, leaving a .jpg member untouched", async () => {
    seedRows([
      mkBlindspotClusterRow("cluster-gif", "pro_government", [
        { image_url: "https://i12.haber7.net/x/rlQtL_1579004365_7688.gif" },
        { image_url: "https://cdn.allowed.example/foto.jpg" },
        { image_url: "https://cdn.elips.example/ph.GIF?v=2", image_allowed: true },
      ]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const byId = Object.fromEntries(bundles[0]!.articles.map((a) => [a.id, a]));
    expect(byId["cluster-gif-a0"]?.image_url).toBeNull();
    expect(byId["cluster-gif-a1"]?.image_url).toBe("https://cdn.allowed.example/foto.jpg");
    expect(byId["cluster-gif-a2"]?.image_url).toBeNull();
  });
});

describe("getBlindspots placeholder image_url gate (db-4)", () => {
  it("nulls a known publisher logo card, leaving a .jpg sibling untouched", async () => {
    seedRows([
      mkBlindspotClusterRow("cluster-ph", "pro_government", [
        { image_url: "https://image.cnnturk.com/i/cnnturk/75/1200x675/57834bf8f0dc1e53e4fccb9d.jpg" },
        { image_url: "https://cdn.allowed.example/foto.jpg" },
        { image_url: "https://foto.haberler.com/haber/2026/07/03/son-dakika_o.jpg" },
      ]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const byId = Object.fromEntries(bundles[0]!.articles.map((a) => [a.id, a]));
    expect(byId["cluster-ph-a0"]?.image_url).toBeNull();
    expect(byId["cluster-ph-a1"]?.image_url).toBe("https://cdn.allowed.example/foto.jpg");
    expect(byId["cluster-ph-a2"]?.image_url).toBeNull();
  });
});

describe("getBlindspots source logo_url (browser-3)", () => {
  it("surfaces the embedded source logo_url on bundle.sources", async () => {
    const logo = "https://www.google.com/s2/favicons?domain=x.com&sz=64";
    seedRows([
      mkBlindspotClusterRow("cluster-logo", "pro_government", [{ logo_url: logo }]),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    const byId = Object.fromEntries(bundles[0]!.sources.map((s) => [s.id, s]));
    expect(byId["cluster-logo-s0"]?.logo_url).toBe(logo);
  });

  it("falls back to null when the embed carries no logo_url", async () => {
    seedRows([mkBlindspotClusterRow("cluster-nologo", "pro_government")]);

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(1);
    expect(bundles[0]!.sources.length).toBeGreaterThan(0);
    for (const src of bundles[0]!.sources) {
      expect(src.logo_url).toBeNull();
    }
  });

  it("keeps an explicit null logo_url as null", async () => {
    seedRows([
      mkBlindspotClusterRow("cluster-nulllogo", "pro_government", [{ logo_url: null }]),
    ]);

    const { bundles } = await getBlindspots();

    const first = bundles[0]!.sources.find((s) => s.id === "cluster-nulllogo-s0");
    expect(first?.logo_url).toBeNull();
  });
});

// h44-consistency-3: the SEO-explainer filter must judge the headline the card
// shows (title_tr_neutral ?? title_tr), not the stored seed title. Prod case
// 25de268f: seed 'Semiha Bahçeli kimdir, ...' (an SEO explainer), served
// neutral title 'Cumhurbaşkanı Erdoğan'dan Devlet Bahçeli'ye taziye mesajı',
// 18 articles, a real blindspot that /blindspots hid.
describe("getBlindspots SEO filter runs on the served headline (h44-consistency-3)", () => {
  const SEED_SEO = "Semiha Bahçeli kimdir, Semiha Bahçeli kaç yaşında, nereli?";
  const NEUTRAL_CLEAN = "Cumhurbaşkanı Erdoğan'dan Devlet Bahçeli'ye taziye mesajı";

  /** 16 distinct voting outlets (14 İktidar), all politika, distinct hashes. */
  function mkWideRow(
    id: string,
    titles: { title_tr: string; title_tr_neutral: string | null },
  ) {
    const bias = (i: number): BiasCategory =>
      i < 14 ? "pro_government" : i === 14 ? "center" : "opposition";
    return {
      ...mkBlindspotClusterRow(id, "pro_government"),
      ...titles,
      article_count: 16,
      cluster_articles: Array.from({ length: 16 }, (_, i) => {
        const { articles } = mkMember(id, i, bias(i));
        return {
          articles: {
            ...articles,
            // mkMember's day-of-month is a single digit (invalid from index 9
            // on), so the date is rebuilt; every member keeps a distinct hash.
            published_at: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
            content_hash: `hash-${id}-${i}`,
          },
        };
      }),
    };
  }

  it("returns a blindspot whose seed title is an SEO explainer but whose served title is clean, with the served title", async () => {
    seedRows([
      mkWideRow("seo-seed-clean-served", {
        title_tr: SEED_SEO,
        title_tr_neutral: NEUTRAL_CLEAN,
      }),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles.map((b) => b.cluster.id)).toEqual(["seo-seed-clean-served"]);
    expect(bundles[0]!.cluster.title_tr).toBe(NEUTRAL_CLEAN);
    expect(bundles[0]!.votingZoneCounts).toEqual({ iktidar: 14, bagimsiz: 1, muhalefet: 1 });
  });

  it("filters a cluster whose served (neutral) title is an SEO explainer although the seed is clean", async () => {
    seedRows([
      mkWideRow("clean-seed-seo-served", {
        title_tr: "Bakan X açıkladı",
        title_tr_neutral: "Ali Koç kimdir?",
      }),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toEqual([]);
  });

  it("still filters an SEO seed title when there is no neutral title", async () => {
    seedRows([
      mkWideRow("seo-seed-no-neutral", {
        title_tr: "Ali Koç kimdir?",
        title_tr_neutral: null,
      }),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles).toEqual([]);
  });

  it("keeps a clean seed with a clean neutral title (no behaviour change)", async () => {
    seedRows([
      mkWideRow("clean-both", {
        title_tr: "Bakan X açıkladı",
        title_tr_neutral: "Bakan X faiz kararını açıkladı",
      }),
    ]);

    const { bundles } = await getBlindspots();

    expect(bundles.map((b) => b.cluster.title_tr)).toEqual(["Bakan X faiz kararını açıkladı"]);
  });
});

describe("getBlindspots feed-health suppression", () => {
  it("fetches health once (alongside the first batch) and drops a cluster whose silent pole shouldSuppressBlindspot flags, logging once", async () => {
    const health = {
      iktidar: { total: 10, healthy: 9, healthyShare: 0.9, degraded: false },
      muhalefet: { total: 10, healthy: 2, healthyShare: 0.2, degraded: true },
      bagimsiz: { total: 5, healthy: 5, healthyShare: 1, degraded: false },
    };
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(health);
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (zone: string) => zone === "iktidar",
    );

    seedRows([
      mkBlindspotClusterRow("cluster-suppress", "pro_government"),
      mkBlindspotClusterRow("cluster-keep", "opposition"),
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bundles } = await getBlindspots();

      expect(bundles.map((b) => b.cluster.id)).toEqual(["cluster-keep"]);
      expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
      expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith(
        "iktidar",
        health,
      );
      expect(feedHealthMock.shouldSuppressBlindspot).toHaveBeenCalledWith(
        "muhalefet",
        health,
      );

      const suppressionLogs = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[feed-health] suppressed blindspot"),
      );
      expect(suppressionLogs).toHaveLength(1);
      expect(suppressionLogs[0]?.[0]).toContain(
        "suppressed blindspot for cluster cluster-suppress",
      );
      expect(suppressionLogs[0]?.[0]).toContain("muhalefet");
      expect(suppressionLogs[0]?.[0]).toContain("2/10 feeds healthy");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("names the actually-degraded pole (not a hardcoded 'iktidar') when the dominant zone is bagimsiz", async () => {
    const health = {
      iktidar: { total: 8, healthy: 8, healthyShare: 1, degraded: false },
      muhalefet: { total: 10, healthy: 2, healthyShare: 0.2, degraded: true },
      bagimsiz: { total: 5, healthy: 5, healthyShare: 1, degraded: false },
    };
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(health);
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (zone: string) => zone === "bagimsiz",
    );

    seedRows([mkBlindspotClusterRow("cluster-bagimsiz", "center")]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bundles } = await getBlindspots();

      expect(bundles).toEqual([]);
      const suppressionLogs = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[feed-health] suppressed blindspot"),
      );
      expect(suppressionLogs).toHaveLength(1);
      expect(suppressionLogs[0]?.[0]).toContain(
        "suppressed blindspot for cluster cluster-bagimsiz",
      );
      expect(suppressionLogs[0]?.[0]).toContain("muhalefet");
      expect(suppressionLogs[0]?.[0]).toContain("2/10 feeds healthy");
      expect(suppressionLogs[0]?.[0]).not.toContain("silent zone iktidar");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("passes every candidate through unaffected when health is null (unknown)", async () => {
    feedHealthMock.getZoneFeedHealth.mockResolvedValue(null);
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (_zone: string, health: unknown) => health != null,
    );

    seedRows([
      mkBlindspotClusterRow("cluster-a", "pro_government"),
      mkBlindspotClusterRow("cluster-b", "opposition"),
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const { bundles } = await getBlindspots();

      expect(bundles.map((b) => b.cluster.id).sort()).toEqual([
        "cluster-a",
        "cluster-b",
      ]);
      expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(1);
      const suppressionLogs = logSpy.mock.calls.filter((args) =>
        String(args[0]).includes("[feed-health] suppressed blindspot"),
      );
      expect(suppressionLogs).toHaveLength(0);
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// h53-consistency-1: the list is every public claim of the trailing 7 days.
// 30 side-balanced claims get a full card (`bundles`), every other passing
// claim is a slim row (`more`), and the counts and the silence digest cover the
// whole window. Prod, 2026-11-06: 41 Iktidar : 9 Muhalefet claims; the page
// showed 28 : 2 and its "Bu listede kim yer vermedi?" box read 25 : 2.
// ---------------------------------------------------------------------------

const BIAS_OF_ZONE: Record<MediaDnaZone, BiasCategory> = {
  iktidar: "pro_government",
  bagimsiz: "center",
  muhalefet: "opposition",
};
const OTHER_BIAS_OF_ZONE: Record<MediaDnaZone, BiasCategory> = {
  iktidar: "center",
  bagimsiz: "pro_government",
  muhalefet: "center",
};

/** `inZone` voters of `zone` plus `outZone` voters from another zone, one outlet each. */
function mkClaimRow(
  id: string,
  zone: MediaDnaZone,
  inZone: number,
  outZone: number,
  updatedAt = "2026-11-05T12:00:00.000Z",
) {
  const members = [
    ...Array.from({ length: inZone }, (_, i) => mkMember(id, i, BIAS_OF_ZONE[zone])),
    ...Array.from({ length: outZone }, (_, i) =>
      mkMember(id, inZone + i, OTHER_BIAS_OF_ZONE[zone]),
    ),
  ];
  return {
    ...mkBlindspotClusterRow(id, BIAS_OF_ZONE[zone]),
    updated_at: updatedAt,
    article_count: members.length,
    cluster_articles: members,
  };
}

/** 41 Iktidar claims (86-100%) and 9 Muhalefet claims (exactly 80%). */
function seedWeek() {
  const minute = 60_000;
  const base = Date.parse("2026-11-05T12:00:00.000Z");
  const iktidar = Array.from({ length: 41 }, (_, i) =>
    mkClaimRow(
      `ik-${String(i).padStart(2, "0")}`,
      "iktidar",
      6 + (i % 3),
      i % 2,
      new Date(base - i * minute).toISOString(),
    ),
  );
  const muhalefet = Array.from({ length: 9 }, (_, i) =>
    mkClaimRow(`mu-${i}`, "muhalefet", 4, 1, new Date(base - i * minute).toISOString()),
  );
  // Interleave so the Step-A (updated_at) order is not already side-sorted.
  const rows = [];
  for (let i = 0; i < 41; i += 1) {
    rows.push(iktidar[i]!);
    if (i < 9) rows.push(muhalefet[i]!);
  }
  seedRows(rows);
  return rows;
}

describe("getBlindspots result: cards, compact rows, counts, digest (h53-consistency-1)", () => {
  it("41 Iktidar : 9 Muhalefet gives 30 cards that hold all 9 Muhalefet claims", async () => {
    seedWeek();

    const { bundles } = await getBlindspots();

    expect(bundles).toHaveLength(30);
    expect(bundles.filter((b) => b.dominantZone === "muhalefet")).toHaveLength(9);
    expect(bundles.filter((b) => b.dominantZone === "iktidar")).toHaveLength(21);
  });

  it("orders the cards by dominantPct descending, ties by updated_at descending", async () => {
    seedWeek();

    const { bundles } = await getBlindspots();

    for (let i = 1; i < bundles.length; i += 1) {
      const prev = bundles[i - 1]!;
      const cur = bundles[i]!;
      expect(prev.dominantPct).toBeGreaterThanOrEqual(cur.dominantPct);
      if (prev.dominantPct === cur.dominantPct) {
        expect(Date.parse(prev.cluster.updated_at)).toBeGreaterThanOrEqual(
          Date.parse(cur.cluster.updated_at),
        );
      }
    }
  });

  it("every other passing claim is a compact row, and no claim is lost or listed twice", async () => {
    const rows = seedWeek();

    const { bundles, more, claimCount } = await getBlindspots();

    expect(more).toHaveLength(20);
    expect(claimCount).toBe(bundles.length + more.length);
    expect(claimCount).toBe(50);
    const listed = [...bundles.map((b) => b.cluster.id), ...more.map((m) => m.id)];
    expect(new Set(listed).size).toBe(50);
    expect([...listed].sort()).toEqual(rows.map((r) => r.id).sort());
  });

  it("orders the compact rows like the cards (most lopsided first) and below the cards' Iktidar cut", async () => {
    seedWeek();

    const { bundles, more } = await getBlindspots();

    for (let i = 1; i < more.length; i += 1) {
      expect(more[i - 1]!.dominantPct).toBeGreaterThanOrEqual(more[i]!.dominantPct);
    }
    const cardIktidarFloor = Math.min(
      ...bundles.filter((b) => b.dominantZone === "iktidar").map((b) => b.dominantPct),
    );
    for (const row of more) expect(row.dominantPct).toBeLessThanOrEqual(cardIktidarFloor);
  });

  it("a compact row is slim: id, title, zone, share, source count, first-published and updated times, the voting tally and the recall-matched zones", async () => {
    const slim = {
      ...mkClaimRow("slim", "iktidar", 6, 1, "2026-11-04T08:00:00.000Z"),
      // Older than updated_at: the feed dates a compact row by this, as it dates a card.
      first_published: "2026-11-02T06:30:00.000Z",
      title_tr_neutral: "Nötr başlık",
    };
    seedRows([
      // 30 claims at 100% take the 30 cards; the 86% claim is the one compact row.
      ...Array.from({ length: 30 }, (_, i) =>
        mkClaimRow(`ik-${i}`, "iktidar", 7, 0, `2026-11-05T12:${String(i).padStart(2, "0")}:00.000Z`),
      ),
      slim,
    ]);

    const { more } = await getBlindspots();

    expect(more).toEqual([
      {
        id: "slim",
        title: "Nötr başlık",
        dominantZone: "iktidar",
        dominantPct: 6 / 7,
        sourceCount: 7,
        firstPublished: "2026-11-02T06:30:00.000Z",
        // h120-methodology-2: the cluster's own last update; the alerts feed derives alert_at from it.
        updatedAt: "2026-11-04T08:00:00.000Z",
        votingZoneCounts: { iktidar: 6, bagimsiz: 1, muhalefet: 0 },
        // h106: the zones Jev matched with the same event; none for an ordinary claim.
        recallMatchedZones: [],
      },
    ]);
    expect(Object.keys(more[0]!).sort()).toEqual([
      "dominantPct",
      "dominantZone",
      "firstPublished",
      "id",
      "recallMatchedZones",
      "sourceCount",
      "title",
      "updatedAt",
      "votingZoneCounts",
    ]);
  });

  it("every compact row carries its cluster's own first_published and updated_at (h120-methodology-2)", async () => {
    const seeded = seedWeek();

    const { more } = await getBlindspots();

    expect(more).toHaveLength(20);
    for (const row of more) {
      const src = seeded.find((r) => r.id === row.id)!;
      // Not swapped with another claim's and not re-derived: the cluster row's own values.
      expect(row.updatedAt).toBe(src.updated_at);
      expect(row.firstPublished).toBe(src.first_published);
    }
  });

  it("sideCounts cover the whole window and sum to claimCount", async () => {
    seedWeek();

    const { sideCounts, claimCount } = await getBlindspots();

    expect(sideCounts).toEqual({ iktidar: 41, bagimsiz: 0, muhalefet: 9 });
    expect(sideCounts.iktidar + sideCounts.bagimsiz + sideCounts.muhalefet).toBe(claimCount);
  });

  it("counts a Bagimsiz-dominant claim on its own side", async () => {
    seedRows([
      mkClaimRow("ik", "iktidar", 5, 0),
      mkClaimRow("bg", "bagimsiz", 5, 0),
      mkClaimRow("mu", "muhalefet", 5, 0),
    ]);

    const { sideCounts, claimCount, bundles, more } = await getBlindspots();

    expect(sideCounts).toEqual({ iktidar: 1, bagimsiz: 1, muhalefet: 1 });
    expect(claimCount).toBe(3);
    expect(bundles).toHaveLength(3);
    expect(more).toEqual([]);
  });

  it("the digest is built over ALL claims, not the 30 cards, and says how many are cards", async () => {
    seedWeek();

    const { digest, bundles } = await getBlindspots();

    expect(digest.windowTotal).toBe(50);
    expect(digest.scope).toEqual({ windowDays: 7, shown: bundles.length });
    // Muhalefet was silent on every one of the 41 Iktidar claims (all rows
    // carry no Muhalefet voter), Iktidar on every one of the 9 Muhalefet ones.
    const byZone = Object.fromEntries(digest.rows.map((r) => [r.zone, r.silentCount]));
    expect(byZone.muhalefet).toBe(41);
    expect(byZone.iktidar).toBe(9);
    // Bagimsiz was silent only on the 21 even-numbered Iktidar claims (the odd
    // ones and every Muhalefet claim carry one Bagimsiz voter).
    expect(digest.rows.map((r) => r.byDominant)).toEqual([
      [{ zone: "muhalefet", count: 9 }],
      [{ zone: "iktidar", count: 21 }],
      [{ zone: "iktidar", count: 41 }],
    ]);
  });

  it("the cap warning fires when Step A returns the full 150, and not below it", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      fixture.candidateIds = Array.from({ length: 149 }, (_, i) => `c${i}`);
      await getBlindspots();
      expect(warnSpy).not.toHaveBeenCalled();

      __resetCacheResilienceForTests();
      fixture.candidateIds = Array.from({ length: 150 }, (_, i) => `c${i}`);
      await getBlindspots();
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining("candidate cap 150 reached"),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("an empty window is a clean zero result, not an error", async () => {
    const result = await getBlindspots();

    expect(result.bundles).toEqual([]);
    expect(result.more).toEqual([]);
    expect(result.claimCount).toBe(0);
    expect(result.sideCounts).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 0 });
    expect(result.digest.windowTotal).toBe(0);
    expect(result.digest.rows).toHaveLength(3);
  });

  it("candidates that fail the live contract are in neither bundles nor more nor the counts", async () => {
    seedRows([
      mkClaimRow("keep", "iktidar", 5, 0),
      mkFailingCandidateRow("one-source"),
      // 4 of 6 voters = 0.667: below the 0.8 dominant share.
      mkClaimRow("diluted", "iktidar", 4, 2),
    ]);

    const result = await getBlindspots();

    expect(result.bundles.map((b) => b.cluster.id)).toEqual(["keep"]);
    expect(result.more).toEqual([]);
    expect(result.claimCount).toBe(1);
    expect(result.digest.windowTotal).toBe(1);
  });

  it("a suppressed claim (degraded silent side) is in neither bundles nor more nor the counts", async () => {
    feedHealthMock.shouldSuppressBlindspot.mockImplementation(
      (zone: string) => zone === "iktidar",
    );
    seedRows([
      ...Array.from({ length: 33 }, (_, i) =>
        mkClaimRow(`ik-${i}`, "iktidar", 5, 0, `2026-11-05T12:${String(i).padStart(2, "0")}:00.000Z`),
      ),
      mkClaimRow("mu-keep", "muhalefet", 5, 0),
    ]);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const result = await getBlindspots();

      expect(result.bundles.map((b) => b.cluster.id)).toEqual(["mu-keep"]);
      expect(result.more).toEqual([]);
      expect(result.claimCount).toBe(1);
      expect(result.sideCounts).toEqual({ iktidar: 0, bagimsiz: 0, muhalefet: 1 });
      expect(result.digest.windowTotal).toBe(1);
    } finally {
      logSpy.mockRestore();
    }
  });

  it("the cached payload stays small: compact rows carry no cluster, article or source objects", async () => {
    seedWeek();

    const result = await getBlindspots();

    const bytes = JSON.stringify(result.more).length;
    // 20 slim rows; a full bundle is several KB each.
    expect(bytes).toBeLessThan(20 * 400);
    for (const row of result.more) {
      expect(row).not.toHaveProperty("cluster");
      expect(row).not.toHaveProperty("articles");
      expect(row).not.toHaveProperty("sources");
    }
  });
});

// ---------------------------------------------------------------------------
// h106-blindspotbadges-1: a public claim whose silent zone the site's own Jev
// recall stage matched with the same event (clusters.blindspot_recall_suspect,
// migration 064) must not print absolute silence for that zone. The fetcher
// reads the column, asks jev_shadow_predictions ONLY for the flagged claims and
// carries the zones it matched on the bundle (recallMatchedZones). The claim
// list, the veto, the count line and every vote stay as they are; only the
// "yer vermedi" digest drops the matched zone of that claim. Fail-open: a failed
// lookup renders today's strings.
// ---------------------------------------------------------------------------

/** A jev_shadow_predictions row: one candidate article of a source with `bias`. */
function recallRow(
  clusterId: string,
  prob: number,
  bias: BiasCategory,
  kind: SourceKind = "outlet",
) {
  return {
    cluster_id: clusterId,
    jev_prob: prob,
    articles: { sources: { bias, kind } },
  };
}

/** A claim row carrying the migration-064 flag. */
function mkSuspectRow(
  id: string,
  zone: MediaDnaZone,
  inZone: number,
  outZone: number,
  // "absent" leaves the column off the row (a row from before the column was read);
  // a bare `undefined` would fall to the default, so it is not used for that.
  suspect: boolean | null | "absent" = true,
) {
  return {
    ...mkClaimRow(id, zone, inZone, outZone),
    ...(suspect === "absent" ? {} : { blindspot_recall_suspect: suspect }),
  };
}

describe("getBlindspots recall-matched zones (h106-blindspotbadges-1)", () => {
  it("carries blindspot_recall_suspect in the embed select", async () => {
    seedRows([mkClaimRow("c1", "iktidar", 5, 0)]);

    await getBlindspots();

    expect(fixture.embedStates).toHaveLength(1);
    const select = String((fixture.embedStates[0] as BuilderState).selectArgs[0]);
    expect(select).toContain("blindspot_recall_suspect");
    // The veto columns it sits next to are untouched.
    expect(select).toContain("blindspot_recall_veto");
  });

  it("the candidate filter still keys on the veto only (the claim list is unchanged)", async () => {
    seedRows([mkSuspectRow("c1", "iktidar", 5, 0)]);

    await getBlindspots();

    const stepA = fixture.lastIdState as BuilderState;
    expect(stepA.eq).toContainEqual({ col: "blindspot_recall_veto", val: false });
    expect(stepA.eq.some((f) => f.col === "blindspot_recall_suspect")).toBe(false);
  });

  it("makes no extra request when no claim is flagged (false, null and a missing column)", async () => {
    seedRows([
      mkSuspectRow("f", "iktidar", 5, 0, false),
      mkSuspectRow("n", "iktidar", 5, 0, null),
      mkSuspectRow("u", "iktidar", 5, 0, "absent"),
    ]);

    const { bundles } = await getBlindspots();

    expect(fixture.recallStates).toHaveLength(0);
    expect(bundles).toHaveLength(3);
    for (const b of bundles) expect(b.recallMatchedZones).toEqual([]);
  });

  it("asks for the flagged claims only, in one request, and qualifies the zone Jev matched (the 0746c9d2 shape)", async () => {
    seedRows([
      mkSuspectRow("0746c9d2", "iktidar", 9, 0),
      mkClaimRow("plain", "iktidar", 6, 0),
    ]);
    fixture.recallRows = [
      recallRow("0746c9d2", 0.92, "opposition_leaning"),
      recallRow("0746c9d2", 0.92, "opposition_leaning"),
    ];

    const { bundles } = await getBlindspots();

    expect(fixture.recallStates).toHaveLength(1);
    const lookup = fixture.recallStates[0] as BuilderState;
    expect(lookup.table).toBe("jev_shadow_predictions");
    expect(lookup.in).toEqual([{ col: "cluster_id", vals: ["0746c9d2"] }]);
    expect(lookup.eq).toContainEqual({ col: "task", val: "blindspot_recall" });

    const byId = new Map(bundles.map((b) => [b.cluster.id, b]));
    expect(byId.get("0746c9d2")!.recallMatchedZones).toEqual(["muhalefet"]);
    expect(byId.get("plain")!.recallMatchedZones).toEqual([]);
  });

  it("qualifies both silent zones when Jev matched both (the f5012836 shape: Muhalefet plus Bağımsız)", async () => {
    seedRows([mkSuspectRow("f5012836", "iktidar", 7, 0)]);
    fixture.recallRows = [
      recallRow("f5012836", 0.86, "opposition_leaning"),
      recallRow("f5012836", 0.76, "center"),
      recallRow("f5012836", 0.76, "international"),
    ];

    const { bundles } = await getBlindspots();

    expect(bundles[0]!.recallMatchedZones).toEqual(["bagimsiz", "muhalefet"]);
  });

  it("a flagged claim whose matches sit in a zone that has voters, or in no silent zone, gets no qualifier", async () => {
    // 6 İktidar + 1 Bağımsız voter: Bağımsız has a member, Muhalefet is silent.
    seedRows([
      mkSuspectRow("has-members", "iktidar", 6, 1),
      mkSuspectRow("only-dominant", "iktidar", 5, 0),
    ]);
    fixture.recallRows = [
      recallRow("has-members", 0.9, "center"),
      recallRow("only-dominant", 0.9, "pro_government"),
    ];

    const { bundles } = await getBlindspots();

    for (const b of bundles) expect(b.recallMatchedZones).toEqual([]);
  });

  it("a flagged claim that Jev matched nothing for keeps today's strings (no qualifier)", async () => {
    seedRows([mkSuspectRow("c1", "iktidar", 6, 0)]);
    fixture.recallRows = [];

    const { bundles } = await getBlindspots();

    expect(fixture.recallStates).toHaveLength(1);
    expect(bundles[0]!.recallMatchedZones).toEqual([]);
  });

  it("does not ask for a flagged claim that never became one (fails the live contract)", async () => {
    // 3 voters: below BLINDSPOT.minSources, so it is dropped before the lookup.
    seedRows([mkSuspectRow("too-small", "iktidar", 3, 0), mkSuspectRow("ok", "iktidar", 6, 0)]);
    fixture.recallRows = [];

    await getBlindspots();

    expect(fixture.recallStates).toHaveLength(1);
    expect((fixture.recallStates[0] as BuilderState).in).toEqual([{ col: "cluster_id", vals: ["ok"] }]);
  });

  it("leaves the claim list, the counts and the card order exactly as without the lookup", async () => {
    const rows = [
      mkSuspectRow("s1", "iktidar", 9, 0),
      mkSuspectRow("s2", "muhalefet", 6, 0),
      mkClaimRow("p1", "iktidar", 7, 1),
    ];
    seedRows(rows);
    const without = await getBlindspots();

    __resetCacheResilienceForTests();
    seedRows(rows);
    fixture.recallRows = [
      recallRow("s1", 0.9, "opposition"),
      recallRow("s2", 0.9, "pro_government"),
    ];
    const withLookup = await getBlindspots();

    expect(withLookup.claimCount).toBe(without.claimCount);
    expect(withLookup.sideCounts).toEqual(without.sideCounts);
    expect(withLookup.bundles.map((b) => b.cluster.id)).toEqual(without.bundles.map((b) => b.cluster.id));
    expect(withLookup.more).toEqual(without.more);
    expect(withLookup.digest.windowTotal).toBe(without.digest.windowTotal);
    for (const b of withLookup.bundles) {
      const before = without.bundles.find((x) => x.cluster.id === b.cluster.id)!;
      expect(b.dominantZone).toBe(before.dominantZone);
      expect(b.dominantPct).toBe(before.dominantPct);
      expect(b.votingZoneCounts).toEqual(before.votingZoneCounts);
    }
  });

  it("the silence digest drops the matched zone of the flagged claims and nothing else", async () => {
    // Three İktidar claims silent on Muhalefet and Bağımsız; Jev matched
    // Muhalefet on two of them and Bağımsız on one of those.
    seedRows([
      mkSuspectRow("m1", "iktidar", 9, 0),
      mkSuspectRow("m2", "iktidar", 8, 0),
      mkClaimRow("p", "iktidar", 7, 0),
    ]);
    fixture.recallRows = [
      recallRow("m1", 0.92, "opposition_leaning"),
      recallRow("m2", 0.81, "opposition"),
      recallRow("m2", 0.7, "center"),
    ];

    const { digest, claimCount, sideCounts } = await getBlindspots();

    const byZone = Object.fromEntries(digest.rows.map((r) => [r.zone, r.silentCount]));
    // Muhalefet was silent on three claims; two of them are matched.
    expect(byZone.muhalefet).toBe(1);
    // Bağımsız was silent on three; one of them is matched.
    expect(byZone.bagimsiz).toBe(2);
    expect(byZone.iktidar).toBe(0);
    // The claim count line and the story total are unchanged.
    expect(digest.windowTotal).toBe(3);
    expect(claimCount).toBe(3);
    expect(sideCounts).toEqual({ iktidar: 3, bagimsiz: 0, muhalefet: 0 });
  });

  it("a claim beyond the 30 cards counts in the digest as the cards do, and its slim row carries the zones", async () => {
    const minute = 60_000;
    const base = Date.parse("2026-11-05T12:00:00.000Z");
    const cards = Array.from({ length: 30 }, (_, i) =>
      mkClaimRow(`ik-${i}`, "iktidar", 7, 0, new Date(base - i * minute).toISOString()),
    );
    // 6/7 = 86%: less lopsided than the 100% claims, so it is the one compact row.
    const slim = { ...mkClaimRow("slim", "iktidar", 6, 1), blindspot_recall_suspect: true };
    seedRows([...cards, slim]);
    fixture.recallRows = [recallRow("slim", 0.9, "opposition")];

    const { more, bundles, digest } = await getBlindspots();

    expect(bundles).toHaveLength(30);
    expect(more.map((m) => m.id)).toEqual(["slim"]);
    expect(more[0]!.recallMatchedZones).toEqual(["muhalefet"]);
    const muhalefet = digest.rows.find((r) => r.zone === "muhalefet")!;
    // 30 cards silent on Muhalefet; the slim claim is matched, so not counted.
    expect(muhalefet.silentCount).toBe(30);
    expect(digest.windowTotal).toBe(31);
  });

  it("fails open: a failed lookup warns, leaves every qualifier empty and the digest as today's", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      seedRows([mkSuspectRow("m1", "iktidar", 9, 0), mkClaimRow("p", "iktidar", 7, 0)]);
      fixture.recallError = { message: "statement timeout" };

      const { bundles, digest } = await getBlindspots();

      expect(bundles).toHaveLength(2);
      for (const b of bundles) expect(b.recallMatchedZones).toEqual([]);
      const byZone = Object.fromEntries(digest.rows.map((r) => [r.zone, r.silentCount]));
      expect(byZone.muhalefet).toBe(2);
      expect(byZone.bagimsiz).toBe(2);
      expect(
        warn.mock.calls.some((c) => String(c[0]).startsWith("[recall-matched-zones] ")),
      ).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("getBlindspotsSafe stays ok: true when only the lookup fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      seedRows([mkSuspectRow("m1", "iktidar", 9, 0)]);
      fixture.recallError = { message: "boom" };

      const result = await getBlindspotsSafe();

      expect(result.ok).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("the lookup rides the same read profile as the embed (reader: capped client; batch: plain client)", async () => {
    seedRows([mkSuspectRow("m1", "iktidar", 9, 0)]);
    fixture.recallRows = [recallRow("m1", 0.9, "opposition")];
    await getBlindspots();
    // Step A, Step B and the lookup: three clients, every one capped.
    expect(fixture.clientOpts).toHaveLength(3);
    expect(fixture.clientOpts.every(isCappedClientOpts)).toBe(true);

    __resetCacheResilienceForTests();
    fixture.clientOpts = [];
    seedRows([mkSuspectRow("m1", "iktidar", 9, 0)]);
    await getBlindspots({ profile: "batch" });
    expect(fixture.clientOpts).toHaveLength(3);
    expect(fixture.clientOpts.some(isCappedClientOpts)).toBe(false);
  });

  it("the cached payload stays JSON-serialisable (arrays, not a Map or a Set)", async () => {
    seedRows([mkSuspectRow("m1", "iktidar", 9, 0)]);
    fixture.recallRows = [recallRow("m1", 0.9, "opposition")];

    const result = await getBlindspots();

    expect(JSON.parse(JSON.stringify(result)).bundles[0].recallMatchedZones).toEqual(["muhalefet"]);
  });
});

describe("getBlindspotsSafe", () => {
  it("returns { ok: true, bundles, more, claimCount, sideCounts, digest } on success", async () => {
    seedRows([mkBlindspotClusterRow("c1", "pro_government")]);
    const result = await getBlindspotsSafe();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.bundles).toHaveLength(1);
    expect(result.more).toEqual([]);
    expect(result.claimCount).toBe(1);
    expect(result.sideCounts).toEqual({ iktidar: 1, bagimsiz: 0, muhalefet: 0 });
    expect(result.digest.windowTotal).toBe(1);
  });

  it("returns { ok: false } and never throws on a Step-A error", async () => {
    fixture.candidateError = { message: "db down" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getBlindspotsSafe()).resolves.toEqual({ ok: false });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("returns { ok: false } and never throws on a Step-B error", async () => {
    seedRows([mkBlindspotClusterRow("c1", "pro_government")]);
    fixture.embedError = { message: "embed down" };
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(getBlindspotsSafe()).resolves.toEqual({ ok: false });
    } finally {
      warnSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// W3 (h27-resilience-2): stale-if-error and single-flight for the reader
// profile. A failed cached attempt plus a failed live fetch serves the last
// good result this instance saw (at most 60 min old); concurrent live retries
// share one fetch; a failed flight cools down for 5 s. The batch profile
// (crons) gets none of it: a cron must never send stale data.
// ---------------------------------------------------------------------------

describe("getBlindspots stale-if-error and single-flight", () => {
  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const MIN = 60_000;

  function deferred() {
    let reject!: (reason: unknown) => void;
    const promise = new Promise<null>((_, rej) => {
      reject = rej;
    });
    return { promise, reject };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it("reader: serves the last good result when the attempt and the live fetch both fail", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    const first = await getBlindspots();
    expect(first.bundles).toHaveLength(1);

    vi.setSystemTime(Date.now() + 10 * MIN);
    fixture.candidateError = { message: "db down" };
    const during = await getBlindspots();
    expect(during).toBe(first);
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("[blindspots-query] serving last-good"),
    );
  });

  it("reader: never serves a result older than 60 minutes", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots();
    vi.setSystemTime(Date.now() + 61 * MIN);
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots()).rejects.toThrow("[blindspots] candidate select error");
  });

  it("reader: with no earlier success a sustained outage still throws", async () => {
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots()).rejects.toThrow("[blindspots] candidate select error");
  });

  it("batch: success then failure still throws and serves nothing stale", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots({ profile: "batch" });
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots({ profile: "batch" })).rejects.toThrow(
      "[blindspots] candidate select error",
    );
  });

  it("batch: a reader success is never served to a batch caller", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    await getBlindspots();
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots({ profile: "batch" })).rejects.toThrow(
      "[blindspots] candidate select error",
    );
  });

  it("reader: 20 concurrent live retries make ONE live fetch and all get the last good result", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    const first = await getBlindspots();
    feedHealthMock.getZoneFeedHealth.mockClear();

    // The health read is the second leg of every fetch: hold the 20 cached
    // attempts open on it, fail them, then hold the live retries open too.
    const attempts = deferred();
    const live = deferred();
    let healthReads = 0;
    feedHealthMock.getZoneFeedHealth.mockImplementation(() =>
      ++healthReads <= 20 ? attempts.promise : live.promise,
    );
    const calls = Array.from({ length: 20 }, () => getBlindspots());
    await vi.advanceTimersByTimeAsync(0);
    expect(healthReads).toBe(20);

    attempts.reject(new Error("db down"));
    await vi.advanceTimersByTimeAsync(0);
    expect(healthReads).toBe(21);

    live.reject(new Error("db down"));
    const results = await Promise.all(calls);
    expect(results.every((r) => r === first)).toBe(true);
    expect(healthReads).toBe(21);
  });

  it("batch: concurrent live retries never coalesce (every caller reads for itself)", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    feedHealthMock.getZoneFeedHealth.mockRejectedValue(new Error("db down"));
    const results = await Promise.all(
      Array.from({ length: 3 }, () =>
        getBlindspots({ profile: "batch" }).catch((e: unknown) => e),
      ),
    );
    expect(results.every((r) => r instanceof Error)).toBe(true);
    // 3 cached attempts + 3 live retries.
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(6);
  });

  it("reader: after a failed live flight the next calls within 5 s do not hit the database", async () => {
    seedRows([mkBlindspotClusterRow("b1", "pro_government")]);
    feedHealthMock.getZoneFeedHealth.mockRejectedValue(new Error("db down"));
    const start = Date.now();
    await expect(getBlindspots()).rejects.toThrow("db down");
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(2);

    vi.setSystemTime(start + 4_000);
    await expect(getBlindspots()).rejects.toThrow("db down");
    // Only the cached attempt ran again; the live retry sat out the cooldown.
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(3);

    vi.setSystemTime(start + 5_001);
    await expect(getBlindspots()).rejects.toThrow("db down");
    expect(feedHealthMock.getZoneFeedHealth).toHaveBeenCalledTimes(5);
  });
});
