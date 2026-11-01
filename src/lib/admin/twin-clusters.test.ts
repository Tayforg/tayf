import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

// /admin/birlestir "Olası ikiz kümeler" reader (migration 120). Same chainable
// Supabase fake as merge-queue.test.ts, plus an rpc fixture. The reader is
// read-only by construction: the tests pin that no mutation is ever recorded
// and that the only rpc it calls is admin_twin_cluster_pairs.

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";
const C = "00000000-0000-4000-8000-00000000000c";
const D = "00000000-0000-4000-8000-00000000000d";

interface Res {
  data: unknown;
  error: { message: string } | null;
}

const log = vi.hoisted(() => ({
  states: [] as BuilderState[],
}));

const fx = vi.hoisted(() => ({
  rpc: { data: [], error: null } as Res,
  headlines: { data: [], error: null } as Res,
  clusters: { data: [], error: null } as Res,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (s) => {
        log.states.push(s);
        return fx.clusters;
      },
      cluster_articles: (s) => {
        log.states.push(s);
        return fx.headlines;
      },
    },
    rpc: {
      admin_twin_cluster_pairs: () => fx.rpc,
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => fake.client,
}));

import { getTwinClusterPairs, TWIN_PAIR_CAP, TWIN_WINDOW_DAYS } from "./twin-clusters";
import { loadClusterRefs } from "./merge-queue";

function cluster(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title_tr: `tr ${id.slice(-1)}`,
    title_tr_neutral: null,
    article_count: 5,
    first_published: "2026-10-20T10:00:00Z",
    bias_distribution: null,
    is_blindspot: false,
    is_archived: false,
    merged_into: null,
    ...over,
  };
}

function pair(a: string, b: string, over: Record<string, unknown> = {}) {
  return {
    cluster_a: a,
    cluster_b: b,
    twin_count: 1,
    source_slugs: ["aksam"],
    newest_at: "2026-10-23T17:27:00Z",
    ...over,
  };
}

function statesOf(table: string) {
  return log.states.filter((s) => s.table === table);
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  log.states.length = 0;
  fake.calls.rpc.length = 0;
  fake.calls.mutations.length = 0;
  fx.rpc = { data: [], error: null };
  fx.headlines = { data: [], error: null };
  fx.clusters = { data: [cluster(A), cluster(B), cluster(C), cluster(D)], error: null };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getTwinClusterPairs rpc", () => {
  it("exposes the 14 day window and the 50 pair cap", () => {
    expect(TWIN_WINDOW_DAYS).toBe(14);
    expect(TWIN_PAIR_CAP).toBe(50);
  });

  it("calls admin_twin_cluster_pairs once with { p_days: 14, p_limit: 50 }", async () => {
    await getTwinClusterPairs();
    expect(fake.calls.rpc).toHaveLength(1);
    expect(fake.calls.rpc[0]?.name).toBe("admin_twin_cluster_pairs");
    expect(fake.calls.rpc[0]?.args).toEqual({ p_days: 14, p_limit: 50 });
  });

  it("returns null and logs when the rpc fails (120 not applied)", async () => {
    fx.rpc = { data: null, error: { message: "function does not exist" } };
    await expect(getTwinClusterPairs()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalledTimes(1);
    expect(String((console.error as ReturnType<typeof vi.fn>).mock.calls[0]?.[0])).toContain("function does not exist");
  });

  it("returns [] for an empty result without reading clusters", async () => {
    fx.rpc = { data: [], error: null };
    await expect(getTwinClusterPairs()).resolves.toEqual([]);
    expect(statesOf("clusters")).toHaveLength(0);
    expect(statesOf("cluster_articles")).toHaveLength(0);
  });

  it("treats a null or non-array rpc payload as empty", async () => {
    fx.rpc = { data: null, error: null };
    await expect(getTwinClusterPairs()).resolves.toEqual([]);
    fx.rpc = { data: { not: "an array" }, error: null };
    await expect(getTwinClusterPairs()).resolves.toEqual([]);
  });
});

describe("getTwinClusterPairs rows", () => {
  it("hydrates rows in the SQL order and keys each pair min:max", async () => {
    fx.rpc = { data: [pair(C, D, { newest_at: "2026-10-23T20:00:00Z" }), pair(A, B)], error: null };
    const rows = await getTwinClusterPairs();
    expect(rows!.map((r) => r.key)).toEqual([`${C}:${D}`, `${A}:${B}`]);
    expect(rows![0]!.a.id).toBe(C);
    expect(rows![0]!.b.id).toBe(D);
    expect(rows![0]!.newestAt).toBe("2026-10-23T20:00:00Z");
    expect(rows![1]!.newestAt).toBe("2026-10-23T17:27:00Z");
  });

  it("normalises a reversed pair so a is always the smaller id", async () => {
    fx.rpc = { data: [pair(B, A)], error: null };
    const [r] = (await getTwinClusterPairs())!;
    expect(r!.key).toBe(`${A}:${B}`);
    expect(r!.a.id).toBe(A);
    expect(r!.b.id).toBe(B);
  });

  it("builds the detail line from the slugs and the twin count", async () => {
    fx.rpc = { data: [pair(A, B, { twin_count: 2, source_slugs: ["aksam", "haber7"] })], error: null };
    const [r] = (await getTwinClusterPairs())!;
    expect(r!.detail).toBe("aksam, haber7 · 2 ikiz haber");
    expect(r!.twinCount).toBe(2);
    expect(r!.sourceSlugs).toEqual(["aksam", "haber7"]);
  });

  it("picks the larger cluster as the default merge target", async () => {
    fx.rpc = { data: [pair(A, B)], error: null };
    fx.clusters = { data: [cluster(A, { article_count: 2 }), cluster(B, { article_count: 9 })], error: null };
    const [r] = (await getTwinClusterPairs())!;
    expect(r!.defaultTargetId).toBe(B);
  });

  it("carries titles, counts and the newest headlines of both sides", async () => {
    fx.rpc = { data: [pair(A, B)], error: null };
    fx.clusters = {
      data: [cluster(A, { title_tr_neutral: "Nötr başlık", is_blindspot: true }), cluster(B)],
      error: null,
    };
    fx.headlines = {
      data: [
        { cluster_id: A, article: { title: "eski", published_at: "2026-10-23T01:00:00Z", source: { name: "Akşam" } } },
        { cluster_id: A, article: { title: "yeni", published_at: "2026-10-23T05:00:00Z", source: { name: "Akşam" } } },
      ],
      error: null,
    };
    const [r] = (await getTwinClusterPairs())!;
    expect(r!.a.title).toBe("Nötr başlık");
    expect(r!.a.isBlindspot).toBe(true);
    expect(r!.a.headlines.map((h) => h.title)).toEqual(["yeni", "eski"]);
    expect(r!.b.headlines).toEqual([]);
  });

  it("skips a pair with a missing cluster", async () => {
    fx.rpc = { data: [pair(A, B), pair(C, D)], error: null };
    fx.clusters = { data: [cluster(A), cluster(B), cluster(C)], error: null }; // D missing
    const rows = await getTwinClusterPairs();
    expect(rows!.map((r) => r.key)).toEqual([`${A}:${B}`]);
  });

  it("skips a pair with an archived or already merged cluster", async () => {
    fx.rpc = { data: [pair(A, B), pair(A, C), pair(A, D)], error: null };
    fx.clusters = {
      data: [cluster(A), cluster(B, { is_archived: true }), cluster(C, { merged_into: A }), cluster(D)],
      error: null,
    };
    const rows = await getTwinClusterPairs();
    expect(rows!.map((r) => r.key)).toEqual([`${A}:${D}`]);
  });

  it("drops malformed rpc rows: missing ids and a cluster paired with itself", async () => {
    fx.rpc = {
      data: [pair(A, A), { cluster_a: A }, null, "x", pair(A, B)],
      error: null,
    };
    const rows = await getTwinClusterPairs();
    expect(rows!.map((r) => r.key)).toEqual([`${A}:${B}`]);
  });

  it("tolerates missing optional fields: no slugs, no count, no timestamp", async () => {
    fx.rpc = { data: [{ cluster_a: A, cluster_b: B }], error: null };
    const [r] = (await getTwinClusterPairs())!;
    expect(r!.sourceSlugs).toEqual([]);
    expect(r!.twinCount).toBe(0);
    expect(r!.newestAt).toBeNull();
    expect(r!.detail).toBe("0 ikiz haber");
  });

  it("reads all clusters in one .in('id') call and all headlines in one .in('cluster_id') call", async () => {
    fx.rpc = { data: [pair(A, B), pair(C, B)], error: null };
    await getTwinClusterPairs();
    const cl = statesOf("clusters");
    expect(cl).toHaveLength(1);
    expect(cl[0]!.in[0]!.col).toBe("id");
    expect([...(cl[0]!.in[0]!.vals as string[])].sort()).toEqual([A, B, C]);
    const hl = statesOf("cluster_articles");
    expect(hl).toHaveLength(1);
    expect(hl[0]!.in[0]!.col).toBe("cluster_id");
    // Paged with .range() (PostgREST cuts a response at 1,000 rows), in a deterministic order.
    expect(hl[0]!.limit).toBeNull();
    expect(hl[0]!.range).toEqual({ from: 0, to: 999 });
    expect(hl[0]!.order.map((o) => o.col)).toEqual(["cluster_id", "article_id"]);
  });
});

describe("getTwinClusterPairs never throws and never writes", () => {
  it.each(["clusters", "headlines"] as const)("returns null when the %s read fails", async (key) => {
    fx.rpc = { data: [pair(A, B)], error: null };
    fx[key] = { data: null, error: { message: "boom" } };
    await expect(getTwinClusterPairs()).resolves.toBeNull();
    expect(console.error).toHaveBeenCalled();
  });

  it("returns null instead of throwing when the client throws", async () => {
    fx.rpc = { data: [pair(A, B)], error: null };
    const spy = vi.spyOn(fake.client, "from").mockImplementation(() => {
      throw new Error("down");
    });
    await expect(getTwinClusterPairs()).resolves.toBeNull();
    spy.mockRestore();
  });

  it("records no mutation and calls no rpc but admin_twin_cluster_pairs", async () => {
    fx.rpc = { data: [pair(A, B), pair(C, D)], error: null };
    await getTwinClusterPairs();
    expect(fake.calls.mutations).toEqual([]);
    expect(fake.calls.rpc.map((c) => c.name)).toEqual(["admin_twin_cluster_pairs"]);
  });
});

describe("loadClusterRefs", () => {
  it("returns an empty map for no ids without querying", async () => {
    const refs = await loadClusterRefs(fake.client as never, []);
    expect(refs.size).toBe(0);
    expect(log.states).toHaveLength(0);
  });

  it("maps id to the ref plus an archived flag (archived or merged_into counts)", async () => {
    fx.clusters = {
      data: [cluster(A), cluster(B, { is_archived: true }), cluster(C, { merged_into: A })],
      error: null,
    };
    const refs = await loadClusterRefs(fake.client as never, [A, B, C, D]);
    expect([...refs.keys()].sort()).toEqual([A, B, C]);
    expect(refs.get(A)!.archived).toBe(false);
    expect(refs.get(B)!.archived).toBe(true);
    expect(refs.get(C)!.archived).toBe(true);
    expect(refs.get(A)!.title).toBe("tr a");
  });

  it("throws when a read fails (callers turn it into null)", async () => {
    fx.clusters = { data: null, error: { message: "nope" } };
    await expect(loadClusterRefs(fake.client as never, [A])).rejects.toThrow(/merge clusters: nope/);
    fx.clusters = { data: [], error: null };
    fx.headlines = { data: null, error: { message: "nope2" } };
    await expect(loadClusterRefs(fake.client as never, [A])).rejects.toThrow(/merge headlines: nope2/);
  });
});
