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

const fixture = vi.hoisted(() => ({
  candidateIds: [] as string[],
  candidateError: null as { message: string } | null,
  /** id -> embedded row. */
  rowsById: new Map<string, unknown>(),
  embedError: null as { message: string } | null,
  lastIdState: null as unknown,
  embedStates: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state: unknown) => {
        const s = state as { selectArgs: unknown[]; in: Array<{ col: string; vals: unknown[] }> };
        if (s.selectArgs[0] === "id") {
          fixture.lastIdState = state;
          if (fixture.candidateError) return { data: null, error: fixture.candidateError };
          return { data: fixture.candidateIds.map((id) => ({ id })), error: null };
        }
        fixture.embedStates.push(state);
        if (fixture.embedError) return { data: null, error: fixture.embedError };
        const wantedIds = (s.in.find((f) => f.col === "id")?.vals ?? []) as string[];
        const rows = wantedIds
          .map((id) => fixture.rowsById.get(id))
          .filter((r): r is unknown => r !== undefined);
        return { data: rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
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

import { getBlindspots, getBlindspotsSafe } from "./blindspots-query";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";
import type { BiasCategory } from "@/types";

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
  overrides: { image_url?: string | null; image_allowed?: boolean } = {},
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
        kind: "outlet",
        image_allowed: overrides.image_allowed,
      },
    },
  };
}

function mkBlindspotClusterRow(
  id: string,
  bias: BiasCategory,
  memberOverrides: Array<{ image_url?: string | null; image_allowed?: boolean }> = [],
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
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.candidateIds = [];
  fixture.candidateError = null;
  fixture.rowsById = new Map();
  fixture.embedError = null;
  fixture.lastIdState = null;
  fixture.embedStates = [];
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
  it("excludes archived clusters and keeps the documented blindspot pre-filters", async () => {
    await getBlindspots();

    const state = fixture.lastIdState as BuilderState;
    expect(state.table).toBe("clusters");
    expect(state.selectArgs[0]).toBe("id");
    expect(state.eq).toHaveLength(3);
    expect(state.eq).toContainEqual({ col: "is_blindspot", val: true });
    expect(state.eq).toContainEqual({ col: "is_archived", val: false });
    expect(state.eq).toContainEqual({ col: "blindspot_recall_veto", val: false });
    expect(state.gte).toEqual([{ col: "article_count", val: 3 }]);
    expect(state.lt[0]?.col).toBe("first_published");
    expect(state.order).toEqual([
      { col: "updated_at", opts: { ascending: false } },
    ]);
    expect(state.limit).toBe(200);
  });

  it("throws with the documented prefix on a Step-A error", async () => {
    fixture.candidateError = { message: "db down" };
    await expect(getBlindspots()).rejects.toThrow(
      "[blindspots] candidate select error: db down",
    );
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
    // Migration 089 ("ADMIT"): politics_share must see the admission stamp.
    expect(selectArg).toMatch(/\bpolitics_admitted_at\b/);
  });

  it("120 candidates (none clearing the contract) produce exactly 3 embed batches (ceil(120/50))", async () => {
    const rows = Array.from({ length: 120 }, (_, i) => mkFailingCandidateRow(`c${i}`));
    seedRows(rows);

    await getBlindspots();

    expect(fixture.embedStates).toHaveLength(3);
  });

  it("stops requesting batches once 30 bundles have already been produced", async () => {
    // 60 valid blindspot candidates, all passing the contract — the first
    // batch of 50 alone already exceeds DISPLAY_LIMIT (30), so only ONE
    // embed call should happen.
    const rows = Array.from({ length: 60 }, (_, i) =>
      mkBlindspotClusterRow(`c${i}`, i % 2 === 0 ? "pro_government" : "opposition"),
    );
    seedRows(rows);

    const { bundles } = await getBlindspots();

    expect(fixture.embedStates).toHaveLength(1);
    expect(bundles.length).toBeLessThanOrEqual(30);
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

describe("getBlindspotsSafe", () => {
  it("returns { ok: true, bundles } on success", async () => {
    seedRows([mkBlindspotClusterRow("c1", "pro_government")]);
    const result = await getBlindspotsSafe();
    expect(result.ok).toBe(true);
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

describe("getBlindspots build-safety", () => {
  it("never throws on a Step-A error — retries live and falls back to an empty list", async () => {
    // A throw crossing the "use cache: remote" boundary fails `next
    // build`'s prerender even though this function wraps every call (see
    // src/lib/cache-resilience.ts). The fixture errors on every call, so
    // both the cache attempt and the live retry fail.
    fixture.candidateError = { message: "db down" };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(getBlindspots()).resolves.toEqual({ bundles: [] });
    } finally {
      errorSpy.mockRestore();
    }
  });
});
