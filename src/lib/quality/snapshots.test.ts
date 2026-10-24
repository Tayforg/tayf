import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// M-09 (/kalite). Mirrors src/lib/sources/active-count.test.ts and
// src/lib/headline/status.test.ts: the shared chainable Supabase fake
// (tests/_helpers/supabase-fake.ts) plus a mocked next/cache so the
// "use cache" directive's cacheLife/cacheTag calls don't throw outside a
// real Next.js request scope.
//
// 2026-10-24 /sources '—' incident: a failed read used to be cached for the
// full 1 h `source-directory` life (cacheLife ran before the query). The
// "cache lifetime" block at the end pins the fix: a failure is memoised for
// `minutes` only.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as unknown[],
  error: null as { message: string } | null,
  lastState: null as unknown,
  // a query that throws (client blew up) instead of answering with an error
  throwOnQuery: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      cluster_quality_snapshots: (state) => {
        fixture.lastState = state;
        if (fixture.throwOnQuery) throw new Error("connection reset");
        if (fixture.error) return { data: null, error: fixture.error };
        return { data: fixture.data, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import { cacheLife, cacheTag } from "next/cache";
import {
  getQualitySnapshots,
  shapeQualitySnapshots,
  type QualitySnapshotRawRow,
} from "./snapshots";
import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.data = [];
  fixture.error = null;
  fixture.lastState = null;
  fixture.throwOnQuery = false;
  vi.mocked(cacheLife).mockClear();
  vi.mocked(cacheTag).mockClear();
  // attemptCached logs every failed attempt with console.error
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

function rawRow(overrides: Partial<QualitySnapshotRawRow> = {}): QualitySnapshotRawRow {
  return {
    id: 1,
    taken_at: "2026-09-18T03:00:00.000Z",
    window_hours: 48,
    article_count: 1200,
    cluster_count: 640,
    singleton_rate: 0.92,
    size_histogram: { "1": 589, "2-3": 40, "4-7": 8, "8+": 3 },
    source_diversity: {
      avg_sources_per_multi_cluster: 2.4,
      max_sources_per_cluster: 9,
      duplicate_source_clusters: 0,
    },
    precision_probe_count: 12,
    recall_probe_count: 34,
    blindspot_flip_rate: 0.02,
    report: { some: "blob" },
    ...overrides,
  };
}

describe("shapeQualitySnapshots", () => {
  it("shapes a well-formed row into a camelCase, typed snapshot", () => {
    const [shaped] = shapeQualitySnapshots([rawRow()]);

    expect(shaped).toEqual({
      id: 1,
      takenAt: "2026-09-18T03:00:00.000Z",
      windowHours: 48,
      articleCount: 1200,
      clusterCount: 640,
      singletonRate: 0.92,
      sizeHistogram: { "1": 589, "2-3": 40, "4-7": 8, "8+": 3 },
      sourceDiversity: {
        avg_sources_per_multi_cluster: 2.4,
        max_sources_per_cluster: 9,
        duplicate_source_clusters: 0,
      },
      precisionProbeCount: 12,
      recallProbeCount: 34,
      blindspotFlipRate: 0.02,
    });
  });

  it("sorts newest first regardless of input order", () => {
    const older = rawRow({ id: 1, taken_at: "2026-09-01T03:00:00.000Z" });
    const newer = rawRow({ id: 2, taken_at: "2026-09-18T03:00:00.000Z" });

    const shaped = shapeQualitySnapshots([older, newer]);

    expect(shaped.map((s) => s.id)).toEqual([2, 1]);
  });

  it("coerces stringified numeric columns", () => {
    const [shaped] = shapeQualitySnapshots([
      rawRow({
        id: "7",
        article_count: "1200",
        singleton_rate: "0.92",
        blindspot_flip_rate: "0.02",
      }),
    ]);

    expect(shaped!.id).toBe(7);
    expect(shaped!.articleCount).toBe(1200);
    expect(shaped!.singletonRate).toBeCloseTo(0.92);
    expect(shaped!.blindspotFlipRate).toBeCloseTo(0.02);
  });

  it("is null-safe: null/missing numeric columns default to 0 and object columns default to their all-zero shape", () => {
    const [shaped] = shapeQualitySnapshots([
      rawRow({
        article_count: null,
        cluster_count: null,
        singleton_rate: null,
        size_histogram: null,
        source_diversity: null,
        precision_probe_count: null,
        recall_probe_count: null,
        blindspot_flip_rate: null,
      }),
    ]);

    expect(shaped).toMatchObject({
      articleCount: 0,
      clusterCount: 0,
      singletonRate: 0,
      sizeHistogram: { "1": 0, "2-3": 0, "4-7": 0, "8+": 0 },
      sourceDiversity: {
        avg_sources_per_multi_cluster: 0,
        max_sources_per_cluster: 0,
        duplicate_source_clusters: 0,
      },
      precisionProbeCount: 0,
      recallProbeCount: 0,
      blindspotFlipRate: 0,
    });
  });

  it("returns [] for empty, null, or undefined input", () => {
    expect(shapeQualitySnapshots([])).toEqual([]);
    expect(shapeQualitySnapshots(null)).toEqual([]);
    expect(shapeQualitySnapshots(undefined)).toEqual([]);
  });
});

describe("getQualitySnapshots", () => {
  it("returns the shaped rows end-to-end through the fake Supabase client", async () => {
    fixture.data = [rawRow()];

    const result = await getQualitySnapshots();

    expect(result).toHaveLength(1);
    expect(result![0]!.articleCount).toBe(1200);
    expect(result![0]!.singletonRate).toBeCloseTo(0.92);
  });

  it("returns [] (not null) when there are no snapshot rows yet", async () => {
    fixture.data = [];

    await expect(getQualitySnapshots()).resolves.toEqual([]);
  });

  it("returns null (never throws) on a Supabase query error", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getQualitySnapshots()).resolves.toBeNull();
  });

  it("returns null (never throws) when Supabase env vars are missing", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getQualitySnapshots()).resolves.toBeNull();
  });

  it("pins the query shape: table, selected columns, taken_at desc order, limit 30", async () => {
    fixture.data = [];

    await getQualitySnapshots();

    const state = fixture.lastState as BuilderState;
    expect(state.table).toBe("cluster_quality_snapshots");

    const select = String(state.selectArgs[0] ?? "");
    for (const col of [
      "id",
      "taken_at",
      "window_hours",
      "article_count",
      "cluster_count",
      "singleton_rate",
      "size_histogram",
      "source_diversity",
      "precision_probe_count",
      "recall_probe_count",
      "blindspot_flip_rate",
    ]) {
      expect(select).toContain(col);
    }

    expect(state.order).toEqual([{ col: "taken_at", opts: { ascending: false } }]);
    expect(state.limit).toBe(30);
  });

  it("logs a PII-free '[quality-snapshots] error: ...' message once on error (attemptCached)", async () => {
    fixture.error = { message: "connection refused" };

    await getQualitySnapshots();

    expect(console.error).toHaveBeenCalledTimes(1);
    const logged = String(vi.mocked(console.error).mock.calls[0]![0]);
    expect(logged).toMatch(/^\[quality-snapshots\] error: .*connection refused/);
    expect(logged).not.toContain("test-service-role-key");
  });
});

describe("getQualitySnapshots cache lifetime", () => {
  it("a Supabase error resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.error = { message: "canceling statement due to statement timeout" };

    await expect(getQualitySnapshots()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("a thrown query resolves null and is cached for minutes only (exactly one cacheLife)", async () => {
    fixture.throwOnQuery = true;

    await expect(getQualitySnapshots()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
    expect(cacheLife).not.toHaveBeenCalledWith("source-directory");
  });

  it("missing Supabase env resolves null and is cached for minutes only", async () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;

    await expect(getQualitySnapshots()).resolves.toBeNull();

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("minutes");
  });

  it("success returns the shaped rows and is cached for source-directory, once", async () => {
    fixture.data = [rawRow()];

    const result = await getQualitySnapshots();

    expect(result).toHaveLength(1);
    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
    expect(cacheLife).not.toHaveBeenCalledWith("minutes");
    expect(console.error).not.toHaveBeenCalled();
  });

  it("an empty successful read returns [] (not null) and keeps source-directory", async () => {
    fixture.data = [];

    await expect(getQualitySnapshots()).resolves.toEqual([]);

    expect(cacheLife).toHaveBeenCalledTimes(1);
    expect(cacheLife).toHaveBeenCalledWith("source-directory");
  });

  it("tags the entry 'quality' before cacheLife runs (cacheTag precedes cacheLife), on success and failure", async () => {
    await getQualitySnapshots();
    expect(cacheTag).toHaveBeenCalledWith("quality");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );

    vi.mocked(cacheTag).mockClear();
    vi.mocked(cacheLife).mockClear();
    fixture.error = { message: "boom" };
    await getQualitySnapshots();
    expect(cacheTag).toHaveBeenCalledWith("quality");
    expect(vi.mocked(cacheTag).mock.invocationCallOrder[0]!).toBeLessThan(
      vi.mocked(cacheLife).mock.invocationCallOrder[0]!,
    );
  });
});
