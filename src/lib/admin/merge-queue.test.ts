import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { BuilderState } from "../../../tests/_helpers/supabase-fake";

// /admin/birlestir readers. Shared chainable Supabase fake with table
// fixtures-as-functions so the recorded predicates can be asserted.

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
  threads: { data: [], error: null } as Res,
  dismissals: { data: [], error: null } as Res,
  suspects: { data: [], error: null } as Res,
  predictions: { data: [], error: null } as Res,
  articleClusters: { data: [], error: null } as Res,
  headlines: { data: [], error: null } as Res,
  clusters: { data: [], error: null } as Res,
  mergeLog: { data: [], error: null } as Res,
}));

const fake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      story_thread_candidates: (s) => {
        log.states.push(s);
        return fx.threads;
      },
      cluster_merge_dismissals: (s) => {
        log.states.push(s);
        return fx.dismissals;
      },
      clusters: (s) => {
        log.states.push(s);
        if (s.or.length > 0) return fx.suspects;
        return fx.clusters;
      },
      jev_shadow_predictions: (s) => {
        log.states.push(s);
        return fx.predictions;
      },
      cluster_articles: (s) => {
        log.states.push(s);
        return s.in.some((i) => i.col === "cluster_id") ? fx.headlines : fx.articleClusters;
      },
      cluster_merge_log: (s) => {
        log.states.push(s);
        return fx.mergeLog;
      },
    },
  });
});

vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => fake.client,
}));

import {
  getMergeQueue,
  getRecentMerges,
  MERGE_LOG_LIMIT,
  MERGE_QUEUE_CAP,
  MERGE_RECALL_MIN_PROB,
  MERGE_RECALL_WINDOW_DAYS,
  MERGE_THREAD_MAX_HOURS,
  MERGE_THREAD_MIN_CONFIDENCE,
} from "./merge-queue";

function cluster(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    title_tr: `tr ${id.slice(-1)}`,
    title_tr_neutral: null,
    article_count: 5,
    first_published: "2026-09-20T10:00:00Z",
    bias_distribution: null,
    is_blindspot: false,
    is_archived: false,
    merged_into: null,
    ...over,
  };
}

function threadRow(a: string, b: string, over: Record<string, unknown> = {}) {
  return { cluster_a: a, cluster_b: b, confidence: 0.95, shared_terms: ["x", "y"], hours_apart: 3, ...over };
}

function statesOf(table: string) {
  return log.states.filter((s) => s.table === table);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T12:00:00.000Z"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  log.states.length = 0;
  fx.threads = { data: [], error: null };
  fx.dismissals = { data: [], error: null };
  fx.suspects = { data: [], error: null };
  fx.predictions = { data: [], error: null };
  fx.articleClusters = { data: [], error: null };
  fx.headlines = { data: [], error: null };
  fx.clusters = { data: [cluster(A), cluster(B), cluster(C), cluster(D)], error: null };
  fx.mergeLog = { data: [], error: null };
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("getMergeQueue thread source", () => {
  it("queries pending candidates with the confidence/hours predicates, ordered and limited", async () => {
    await getMergeQueue();
    const [s] = statesOf("story_thread_candidates");
    expect(MERGE_THREAD_MIN_CONFIDENCE).toBe(0.9);
    expect(MERGE_THREAD_MAX_HOURS).toBe(24);
    expect(s.eq).toEqual([{ col: "status", val: "pending" }]);
    expect(s.gte).toEqual([{ col: "confidence", val: 0.9 }]);
    expect(s.lte).toEqual([{ col: "hours_apart", val: 24 }]);
    expect(s.order).toEqual([{ col: "confidence", opts: { ascending: false } }]);
    expect(s.limit).toBe(50);
  });

  it("builds a row with detail, both refs in id order, and the larger cluster as default target", async () => {
    fx.threads = { data: [threadRow(B, A)], error: null };
    fx.clusters = {
      data: [cluster(A, { article_count: 2 }), cluster(B, { article_count: 9 })],
      error: null,
    };
    const rows = await getMergeQueue();
    expect(rows).toHaveLength(1);
    const r = rows![0];
    expect(r.key).toBe(`${A}:${B}`);
    expect(r.a.id).toBe(A);
    expect(r.b.id).toBe(B);
    expect(r.origin).toBe("thread");
    expect(r.origins).toEqual(["thread"]);
    expect(r.score).toBe(0.95);
    expect(r.detail).toBe("Ortak terimler: x, y · 3 saat arayla");
    expect(r.defaultTargetId).toBe(B);
  });

  it("reads all clusters in one .in('id') call", async () => {
    fx.threads = { data: [threadRow(A, B), threadRow(C, D)], error: null };
    await getMergeQueue();
    const ins = statesOf("clusters").filter((s) => s.or.length === 0);
    expect(ins).toHaveLength(1);
    expect(ins[0].in[0].col).toBe("id");
    expect([...(ins[0].in[0].vals as string[])].sort()).toEqual([A, B, C, D]);
  });
});

describe("getMergeQueue recall source", () => {
  const since = new Date("2026-09-22T12:00:00.000Z").toISOString();

  beforeEach(() => {
    fx.suspects = { data: [{ id: A }], error: null };
    fx.predictions = {
      data: [
        {
          cluster_id: A,
          article_id: "art-1",
          jev_prob: 0.91,
          article: { title: "Eşleşen haber", source: { slug: "bbc-turkce" } },
        },
      ],
      error: null,
    };
    fx.articleClusters = {
      data: [
        { cluster_id: A, article_id: "art-1" },
        { cluster_id: C, article_id: "art-1" },
      ],
      error: null,
    };
  });

  it("issues the three recall queries with the documented predicates", async () => {
    await getMergeQueue();
    expect(MERGE_RECALL_MIN_PROB).toBe(0.85);
    expect(MERGE_RECALL_WINDOW_DAYS).toBe(7);
    const susp = statesOf("clusters").find((s) => s.or.length > 0)!;
    expect(susp.or).toEqual([
      `blindspot_recall_veto.eq.true,and(blindspot_recall_suspect.eq.true,blindspot_recall_checked_at.gte."${since}")`,
    ]);
    expect(susp.limit).toBe(30);

    const [p] = statesOf("jev_shadow_predictions");
    expect(p.eq).toEqual([{ col: "task", val: "blindspot_recall" }]);
    expect(p.not).toEqual([{ col: "article_id", op: "is", val: null }]);
    expect(p.gte).toEqual(
      expect.arrayContaining([
        { col: "jev_prob", val: 0.85 },
        { col: "created_at", val: since },
      ]),
    );
    expect(p.in).toEqual([{ col: "cluster_id", vals: [A] }]);
    expect(p.order).toEqual([{ col: "jev_prob", opts: { ascending: false } }]);
    expect(p.limit).toBe(300);

    const ca = statesOf("cluster_articles").find((s) => s.in.some((i) => i.col === "article_id"))!;
    expect(ca.in).toEqual([{ col: "article_id", vals: ["art-1"] }]);
  });

  it("pairs X with the other cluster Y (never itself) and describes the Jev match", async () => {
    const rows = await getMergeQueue();
    expect(rows).toHaveLength(1);
    expect(rows![0].key).toBe(`${A}:${C}`);
    expect(rows![0].origin).toBe("recall");
    expect(rows![0].origins).toEqual(["recall"]);
    expect(rows![0].score).toBe(0.91);
    expect(rows![0].detail).toBe("Jev: %91 aynı olay · bbc-turkce: Eşleşen haber");
  });

  it("ignores an article that only belongs to X", async () => {
    fx.articleClusters = { data: [{ cluster_id: A, article_id: "art-1" }], error: null };
    expect(await getMergeQueue()).toEqual([]);
  });
});

describe("getMergeQueue pair rules", () => {
  it("shows a pair found by both sources once, primary origin thread", async () => {
    fx.threads = { data: [threadRow(A, C)], error: null };
    fx.suspects = { data: [{ id: C }], error: null };
    fx.predictions = {
      data: [{ cluster_id: C, article_id: "art-1", jev_prob: 0.88, article: null }],
      error: null,
    };
    fx.articleClusters = { data: [{ cluster_id: A, article_id: "art-1" }], error: null };
    const rows = await getMergeQueue();
    expect(rows).toHaveLength(1);
    expect(rows![0].key).toBe(`${A}:${C}`);
    expect(rows![0].origins).toEqual(["thread", "recall"]);
    expect(rows![0].origin).toBe("thread");
    expect(rows![0].detail).toContain("Ortak terimler: x, y");
    expect(rows![0].detail).toContain("Jev: %88 aynı olay");
  });

  it("excludes dismissed pairs", async () => {
    fx.threads = { data: [threadRow(B, A), threadRow(C, D)], error: null };
    fx.dismissals = { data: [{ cluster_a: A, cluster_b: B }], error: null };
    const rows = await getMergeQueue();
    expect(rows!.map((r) => r.key)).toEqual([`${C}:${D}`]);
  });

  it("excludes pairs with an archived, merged or missing cluster", async () => {
    fx.threads = { data: [threadRow(A, B), threadRow(A, C), threadRow(A, D), threadRow(B, C)], error: null };
    fx.clusters = {
      data: [
        cluster(A),
        cluster(B, { is_archived: true }),
        cluster(C, { merged_into: A }),
        // D is missing entirely
      ],
      error: null,
    };
    expect(await getMergeQueue()).toEqual([]);
  });

  it("caps the total at 60", async () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const data = Array.from({ length: 50 }, (_, i) => threadRow(id(i * 2 + 1), id(i * 2 + 2), { confidence: 0.99 - i * 0.001 }));
    fx.threads = { data, error: null };
    fx.suspects = { data: [{ id: id(1000) }], error: null };
    fx.predictions = {
      data: Array.from({ length: 30 }, (_, i) => ({
        cluster_id: id(1000),
        article_id: `art-${i}`,
        jev_prob: 0.99 - i * 0.001,
        article: null,
      })),
      error: null,
    };
    fx.articleClusters = {
      data: Array.from({ length: 30 }, (_, i) => ({ cluster_id: id(2000 + i), article_id: `art-${i}` })),
      error: null,
    };
    fx.clusters = {
      data: [
        ...Array.from({ length: 100 }, (_, i) => cluster(id(i + 1))),
        cluster(id(1000)),
        ...Array.from({ length: 30 }, (_, i) => cluster(id(2000 + i))),
      ],
      error: null,
    };
    const rows = await getMergeQueue();
    expect(MERGE_QUEUE_CAP).toBe(60);
    expect(rows).toHaveLength(60);
    const ins = statesOf("clusters").find((s) => s.or.length === 0)!;
    expect((ins.in[0].vals as string[]).length).toBeLessThanOrEqual(120);
  });
});

describe("defaultTargetId", () => {
  async function target(a: Record<string, unknown>, b: Record<string, unknown>) {
    fx.threads = { data: [threadRow(A, B)], error: null };
    fx.clusters = { data: [cluster(A, a), cluster(B, b)], error: null };
    return (await getMergeQueue())![0].defaultTargetId;
  }

  it("prefers the larger article_count", async () => {
    expect(await target({ article_count: 3 }, { article_count: 8 })).toBe(B);
    expect(await target({ article_count: 8 }, { article_count: 3 })).toBe(A);
  });

  it("breaks a tie with the earlier first_published", async () => {
    expect(
      await target({ first_published: "2026-09-21T00:00:00Z" }, { first_published: "2026-09-20T00:00:00Z" }),
    ).toBe(B);
  });

  it("breaks a full tie with the smaller id", async () => {
    expect(await target({}, {})).toBe(A);
  });
});

describe("cluster refs", () => {
  it("returns at most 3 headlines per cluster, newest first, with the source name", async () => {
    fx.threads = { data: [threadRow(A, B)], error: null };
    const art = (cid: string, title: string, at: string, name: string) => ({
      cluster_id: cid,
      article: { title, published_at: at, source: { name } },
    });
    fx.headlines = {
      data: [
        art(A, "eski", "2026-09-20T01:00:00Z", "S1"),
        art(A, "yeni", "2026-09-20T05:00:00Z", "S2"),
        art(A, "orta", "2026-09-20T03:00:00Z", "S3"),
        art(A, "en eski", "2026-09-19T03:00:00Z", "S4"),
        art(B, "b1", "2026-09-20T03:00:00Z", "S5"),
      ],
      error: null,
    };
    const rows = await getMergeQueue();
    expect(rows![0].a.headlines).toEqual([
      { title: "yeni", sourceName: "S2" },
      { title: "orta", sourceName: "S3" },
      { title: "eski", sourceName: "S1" },
    ]);
    expect(rows![0].b.headlines).toEqual([{ title: "b1", sourceName: "S5" }]);
    const h = statesOf("cluster_articles").find((s) => s.in.some((i) => i.col === "cluster_id"))!;
    expect(h.limit).toBe(2000);
  });

  it("normalizes bias_distribution and falls back from a malformed value to zeros", async () => {
    fx.threads = { data: [threadRow(A, B)], error: null };
    fx.clusters = {
      data: [cluster(A, { bias_distribution: { nationalist: 2 } }), cluster(B, { bias_distribution: "garbage" })],
      error: null,
    };
    const rows = await getMergeQueue();
    expect(rows![0].a.biasDistribution.nationalist).toBe(2);
    expect(rows![0].a.biasDistribution.pro_kurdish).toBe(0);
    expect(Object.values(rows![0].b.biasDistribution).every((n) => n === 0)).toBe(true);
  });

  it("prefers title_tr_neutral and carries isBlindspot", async () => {
    fx.threads = { data: [threadRow(A, B)], error: null };
    fx.clusters = {
      data: [cluster(A, { title_tr_neutral: "Nötr", is_blindspot: true }), cluster(B)],
      error: null,
    };
    const rows = await getMergeQueue();
    expect(rows![0].a.title).toBe("Nötr");
    expect(rows![0].a.isBlindspot).toBe(true);
    expect(rows![0].b.title).toBe("tr b");
  });
});

describe("getMergeQueue errors", () => {
  it.each(["threads", "dismissals", "suspects", "predictions", "articleClusters", "headlines", "clusters"] as const)(
    "returns null when %s fails",
    async (key) => {
      fx.threads = { data: [threadRow(A, B)], error: null };
      fx.suspects = { data: [{ id: C }], error: null };
      fx.predictions = {
        data: [{ cluster_id: C, article_id: "art-1", jev_prob: 0.9, article: null }],
        error: null,
      };
      fx.articleClusters = { data: [{ cluster_id: D, article_id: "art-1" }], error: null };
      fx[key] = { data: null, error: { message: "boom" } };
      await expect(getMergeQueue()).resolves.toBeNull();
    },
  );

  it("returns null instead of throwing when the client throws", async () => {
    const spy = vi.spyOn(fake.client, "from").mockImplementation(() => {
      throw new Error("down");
    });
    await expect(getMergeQueue()).resolves.toBeNull();
    await expect(getRecentMerges()).resolves.toBeNull();
    spy.mockRestore();
  });
});

describe("getRecentMerges", () => {
  it("orders by created_at desc, limits to 20 and joins cluster titles", async () => {
    fx.mergeLog = {
      data: [
        {
          id: 1,
          source_id: A,
          target_id: B,
          actor: "admin",
          origin: "thread",
          source_count_before: 2,
          target_count_before: 5,
          moved: 2,
          duplicates: 0,
          target_count_after: 7,
          target_blindspot_before: true,
          target_blindspot_after: false,
          created_at: "2026-09-29T10:00:00Z",
        },
      ],
      error: null,
    };
    fx.clusters = {
      data: [
        { id: A, title_tr: "Kaynak", title_tr_neutral: null },
        { id: B, title_tr: "ham", title_tr_neutral: "Hedef" },
      ],
      error: null,
    };
    const rows = await getRecentMerges();
    const [s] = statesOf("cluster_merge_log");
    expect(MERGE_LOG_LIMIT).toBe(20);
    expect(s.order).toEqual([{ col: "created_at", opts: { ascending: false } }]);
    expect(s.limit).toBe(20);
    expect(rows).toEqual([
      {
        id: 1,
        createdAt: "2026-09-29T10:00:00Z",
        actor: "admin",
        origin: "thread",
        source: { id: A, title: "Kaynak" },
        target: { id: B, title: "Hedef" },
        sourceCountBefore: 2,
        targetCountBefore: 5,
        moved: 2,
        duplicates: 0,
        targetCountAfter: 7,
        blindspotBefore: true,
        blindspotAfter: false,
      },
    ]);
  });

  it("returns [] for an empty log without reading clusters", async () => {
    expect(await getRecentMerges()).toEqual([]);
    expect(statesOf("clusters")).toHaveLength(0);
  });

  it("returns null on a log or cluster error", async () => {
    fx.mergeLog = { data: null, error: { message: "no table" } };
    expect(await getRecentMerges()).toBeNull();
    fx.mergeLog = {
      data: [{ id: 1, source_id: A, target_id: B, origin: "manual", created_at: "2026-09-29T10:00:00Z" }],
      error: null,
    };
    fx.clusters = { data: null, error: { message: "x" } };
    expect(await getRecentMerges()).toBeNull();
  });
});
