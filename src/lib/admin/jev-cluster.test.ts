import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pack A ("Jev canlı küme", migration 064), W3. Mirrors
// src/lib/admin/jev-shadow-status.test.ts: the shared chainable Supabase
// fake (tests/_helpers/supabase-fake.ts) plus its table-fixture-as-function
// form, since these fetchers need to inspect the recorded eq/order/limit
// predicates (not just return canned rows). No next/cache mock here — none
// of these functions call revalidateTag; that is the route's job.

const queryLog = vi.hoisted(() => ({
  unlinkCandidateStates: [] as unknown[],
  suspectClusterStates: [] as unknown[],
  blindspotPredictionStates: [] as unknown[],
}));

const fixture = vi.hoisted(() => ({
  unlinkCandidates: [] as unknown[],
  unlinkError: null as { message: string } | null,
  candidateRows: [] as Array<{
    id: number;
    cluster_id: string;
    article_id: string;
    status: string;
    band?: string | null;
  }>,
  suspectClusters: [] as unknown[],
  suspectClustersError: null as { message: string } | null,
  blindspotPredictions: [] as unknown[],
  blindspotPredictionsError: null as { message: string } | null,
  rpcResult: { data: 4, error: null } as { data: unknown; error: { message: string } | null },
  triageBandCounts: { likely_unlink: 0, review: 0, untriaged: 0 },
  triageError: null as { message: string } | null,
  dryRunRows: [] as unknown[],
  dryRunError: null as { message: string } | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../../tests/_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      // Serves both getJevUnlinkCandidates (no `id` predicate — the list
      // query) and unlinkClusterArticle/keepClusterArticle (an `id` +
      // `status` predicate — the single-row lookup/update).
      jev_unlink_candidates: (state) => {
        queryLog.unlinkCandidateStates.push(state);

        const headOpts = state.selectArgs[1] as { head?: boolean } | undefined;
        if (headOpts?.head) {
          if (fixture.triageError) return { data: null, error: fixture.triageError };
          const bandEq = state.eq.find((e) => e.col === "band");
          const bandIs = state.is.find((e) => e.col === "band");
          let key: "likely_unlink" | "review" | "untriaged" = "untriaged";
          if (bandEq?.val === "likely_unlink") key = "likely_unlink";
          else if (bandEq?.val === "review") key = "review";
          else if (bandIs) key = "untriaged";
          return { data: null, error: null, count: fixture.triageBandCounts[key] };
        }

        const idIn = state.in.find((e) => e.col === "id");
        if (idIn !== undefined) {
          if (fixture.unlinkError) return { data: null, error: fixture.unlinkError };
          const statusEq = state.eq.find((e) => e.col === "status");
          const bandEq = state.eq.find((e) => e.col === "band");
          const matched = fixture.candidateRows.filter(
            (r) =>
              idIn.vals.map(String).includes(String(r.id)) &&
              (!statusEq || r.status === statusEq.val) &&
              (!bandEq || r.band === bandEq.val),
          );
          return { data: matched.map((r) => ({ id: r.id })), error: null };
        }

        const idEq = state.eq.find((e) => e.col === "id");
        if (idEq !== undefined) {
          if (fixture.unlinkError) return { data: null, error: fixture.unlinkError };
          const statusEq = state.eq.find((e) => e.col === "status");
          const row = fixture.candidateRows.find(
            (r) =>
              String(r.id) === String(idEq.val) &&
              (!statusEq || r.status === statusEq.val),
          );
          return { data: row ? [row] : [], error: null };
        }
        if (fixture.unlinkError) return { data: null, error: fixture.unlinkError };
        return { data: fixture.unlinkCandidates, error: null };
      },
      clusters: (state) => {
        queryLog.suspectClusterStates.push(state);
        if (fixture.suspectClustersError) return { data: null, error: fixture.suspectClustersError };
        return { data: fixture.suspectClusters, error: null };
      },
      jev_shadow_predictions: (state) => {
        queryLog.blindspotPredictionStates.push(state);
        if (fixture.blindspotPredictionsError) return { data: null, error: fixture.blindspotPredictionsError };
        return { data: fixture.blindspotPredictions, error: null };
      },
      jev_unlink_dryrun: () => {
        if (fixture.dryRunError) return { data: null, error: fixture.dryRunError };
        return { data: fixture.dryRunRows, error: null };
      },
    },
    rpc: {
      cluster_unlink_article: () => fixture.rpcResult,
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

import {
  getJevUnlinkCandidates,
  getJevBlindspotSuspects,
  unlinkClusterArticle,
  keepClusterArticle,
  getJevUnlinkTriage,
  keepClusterArticles,
  JEV_UNLINK_LIMIT,
  JEV_BLINDSPOT_SUSPECT_LIMIT,
  JEV_BLINDSPOT_SUSPECT_DAYS,
} from "./jev-cluster";

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fixture.unlinkCandidates = [];
  fixture.unlinkError = null;
  fixture.candidateRows = [];
  fixture.suspectClusters = [];
  fixture.suspectClustersError = null;
  fixture.triageBandCounts = { likely_unlink: 0, review: 0, untriaged: 0 };
  fixture.triageError = null;
  fixture.dryRunRows = [];
  fixture.dryRunError = null;
  fixture.blindspotPredictions = [];
  fixture.blindspotPredictionsError = null;
  fixture.rpcResult = { data: 4, error: null };
  queryLog.unlinkCandidateStates.length = 0;
  queryLog.suspectClusterStates.length = 0;
  queryLog.blindspotPredictionStates.length = 0;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  vi.useRealTimers();
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.useRealTimers();
});

describe("getJevUnlinkCandidates", () => {
  it("filters status=pending, orders by band then jev_prob ascending, limits to JEV_UNLINK_LIMIT", async () => {
    fixture.unlinkCandidates = [
      {
        id: 1,
        cluster_id: "c1",
        article_id: "a1",
        jev_prob: 0.12,
        created_at: "2026-09-20T10:00:00.000Z",
        title_jaccard: 0.15,
        band: "likely_unlink",
        cluster: { title_tr: "Kume 1", title_tr_neutral: null },
        article: { title: "Haber 1", source: { slug: "kaynak-1" } },
      },
    ];

    const result = await getJevUnlinkCandidates();

    expect(result).toEqual([
      {
        id: 1,
        clusterId: "c1",
        articleId: "a1",
        jevProb: 0.12,
        createdAt: "2026-09-20T10:00:00.000Z",
        clusterTitle: "Kume 1",
        articleTitle: "Haber 1",
        sourceSlug: "kaynak-1",
        titleJaccard: 0.15,
        band: "likely_unlink",
      },
    ]);

    expect(JEV_UNLINK_LIMIT).toBe(30);
    const state = queryLog.unlinkCandidateStates[0] as {
      selectArgs: unknown[];
      eq: Array<{ col: string; val: unknown }>;
      order: Array<{ col: string; opts: unknown }>;
      limit: number | null;
    };
    expect(String(state.selectArgs[0])).toMatch(/\btitle_jaccard\b/);
    expect(String(state.selectArgs[0])).toMatch(/\bband\b/);
    expect(state.eq).toContainEqual({ col: "status", val: "pending" });
    expect(state.order).toEqual([
      { col: "band", opts: { ascending: true, nullsFirst: false } },
      { col: "jev_prob", opts: { ascending: true } },
    ]);
    expect(state.limit).toBe(JEV_UNLINK_LIMIT);
  });

  it("maps a bad band string and non-finite title_jaccard to null", async () => {
    fixture.unlinkCandidates = [
      {
        id: 9,
        cluster_id: "c9",
        article_id: "a9",
        jev_prob: 0.2,
        created_at: "2026-09-20T10:00:00.000Z",
        title_jaccard: "not-a-number",
        band: "something_else",
        cluster: { title_tr: "K", title_tr_neutral: null },
        article: { title: "H", source: null },
      },
    ];

    const result = await getJevUnlinkCandidates();
    expect(result?.[0]?.titleJaccard).toBeNull();
    expect(result?.[0]?.band).toBeNull();
  });

  it("prefers title_tr_neutral over title_tr and degrades to null on a query error", async () => {
    fixture.unlinkCandidates = [
      {
        id: 2,
        cluster_id: "c2",
        article_id: "a2",
        jev_prob: 0.2,
        created_at: "2026-09-20T11:00:00.000Z",
        cluster: { title_tr: "Eski başlık", title_tr_neutral: "Yeni başlık" },
        article: { title: "Haber 2", source: null },
      },
    ];

    const ok = await getJevUnlinkCandidates();
    expect(ok?.[0]?.clusterTitle).toBe("Yeni başlık");
    expect(ok?.[0]?.sourceSlug).toBeNull();

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.unlinkError = { message: "relation does not exist" };
    const errored = await getJevUnlinkCandidates();
    expect(errored).toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("getJevBlindspotSuspects", () => {
  it("filters blindspot_recall_suspect and the 7-day window, attaches the highest-probability candidate", async () => {
    vi.useFakeTimers();
    const now = new Date("2026-09-21T12:00:00.000Z");
    vi.setSystemTime(now);
    const sinceIso = new Date(
      now.getTime() - JEV_BLINDSPOT_SUSPECT_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    fixture.suspectClusters = [
      {
        id: "c1",
        title_tr: "K1",
        title_tr_neutral: null,
        blindspot_recall_checked_at: "2026-09-19T00:00:00.000Z",
        blindspot_recall_veto: true,
        blindspot_recall_veto_at: "2026-09-19T00:07:00.000Z",
      },
      // Pre-071 row shape (no veto columns) — must degrade to "not vetoed".
      { id: "c2", title_tr: "K2", title_tr_neutral: "K2 nötr", blindspot_recall_checked_at: "2026-09-18T00:00:00.000Z" },
    ];
    fixture.blindspotPredictions = [
      { cluster_id: "c2", jev_prob: 0.91, article: { title: "H2a", source: { slug: "kaynakX" } } },
      { cluster_id: "c1", jev_prob: 0.85, article: { title: "H1a", source: { slug: "kaynakY" } } },
      { cluster_id: "c1", jev_prob: 0.70, article: { title: "H1b (lower, must be ignored)", source: { slug: "kaynakZ" } } },
    ];

    const result = await getJevBlindspotSuspects();

    expect(result).toEqual([
      {
        clusterId: "c1",
        clusterTitle: "K1",
        checkedAt: "2026-09-19T00:00:00.000Z",
        topArticleTitle: "H1a",
        topSourceSlug: "kaynakY",
        topProb: 0.85,
        vetoed: true,
        vetoedAt: "2026-09-19T00:07:00.000Z",
      },
      {
        clusterId: "c2",
        clusterTitle: "K2 nötr",
        checkedAt: "2026-09-18T00:00:00.000Z",
        topArticleTitle: "H2a",
        topSourceSlug: "kaynakX",
        topProb: 0.91,
        vetoed: false,
        vetoedAt: null,
      },
    ]);

    const clusterState = queryLog.suspectClusterStates[0] as {
      selectArgs: unknown[];
      eq: Array<{ col: string; val: unknown }>;
      gte: Array<{ col: string; val: unknown }>;
      or: string[];
      limit: number | null;
    };
    // Migration 071: a recall-vetoed cluster is always reviewable here, even
    // when 064's independently computed suspect flag is false or its check
    // is older than the 7-day window (a veto can be refreshed from
    // updated_at alone). Suspects stay bounded by the window.
    expect(clusterState.or).toEqual([
      `blindspot_recall_veto.eq.true,and(blindspot_recall_suspect.eq.true,blindspot_recall_checked_at.gte."${sinceIso}")`,
    ]);
    expect(clusterState.eq).not.toContainEqual({ col: "blindspot_recall_suspect", val: true });
    expect(clusterState.gte).toEqual([]);
    // Migration 071: the admin view shows which suspects were hidden from readers.
    expect(String(clusterState.selectArgs[0])).toMatch(/\bblindspot_recall_veto\b/);
    expect(String(clusterState.selectArgs[0])).toMatch(/\bblindspot_recall_veto_at\b/);
    expect(clusterState.limit).toBe(JEV_BLINDSPOT_SUSPECT_LIMIT);

    const predictionState = queryLog.blindspotPredictionStates[0] as {
      eq: Array<{ col: string; val: unknown }>;
      in: Array<{ col: string; vals: unknown[] }>;
      not: Array<{ col: string; op: string; val: unknown }>;
    };
    expect(predictionState.eq).toContainEqual({ col: "task", val: "blindspot_recall" });
    expect(predictionState.in).toContainEqual({ col: "cluster_id", vals: ["c1", "c2"] });
    expect(predictionState.not).toContainEqual({ col: "article_id", op: "is", val: null });

    // DB-07: the predictions query must be bounded by the same window as
    // the cluster query, plus a row cap (JEV_BLINDSPOT_SUSPECT_LIMIT x the
    // shadow stage's per-cluster-per-call answer cap of 15) -- otherwise it
    // pulls the entire unbounded blindspot_recall history for every listed
    // cluster.
    const predictionStateWithBounds = queryLog.blindspotPredictionStates[0] as {
      gte: Array<{ col: string; val: unknown }>;
      limit: number | null;
    };
    expect(predictionStateWithBounds.gte).toContainEqual({ col: "created_at", val: sinceIso });
    expect(predictionStateWithBounds.limit).toBe(JEV_BLINDSPOT_SUSPECT_LIMIT * 15);
  });

  it("returns null on error and never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.suspectClustersError = { message: "relation does not exist" };

    await expect(getJevBlindspotSuspects()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });
});

describe("unlinkClusterArticle", () => {
  it("calls cluster_unlink_article with p_cluster_id/p_article_id and returns the new article_count", async () => {
    fixture.candidateRows = [{ id: 5, cluster_id: "c9", article_id: "a9", status: "pending" }];
    fixture.rpcResult = { data: 7, error: null };

    const result = await unlinkClusterArticle(5);

    expect(result).toEqual({ ok: true, clusterId: "c9", articleCount: 7 });
    const rpcCalls = supabaseFake.calls.rpc.filter((c) => c.name === "cluster_unlink_article");
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.args).toEqual({ p_cluster_id: "c9", p_article_id: "a9" });
  });

  it("returns not-found for an id with no pending row and never calls the RPC", async () => {
    fixture.candidateRows = [];

    const result = await unlinkClusterArticle(99);

    expect(result).toEqual({ ok: false, reason: "not-found" });
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("[A7] degrades to ok:false when the RPC succeeds but returns a non-numeric article_count", async () => {
    fixture.candidateRows = [{ id: 5, cluster_id: "c9", article_id: "a9", status: "pending" }];
    fixture.rpcResult = { data: null, error: null };

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await unlinkClusterArticle(5);
    expect(result).toEqual({ ok: false, reason: "error" });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("keepClusterArticle", () => {
  it("updates status to kept with decided_at and never calls the RPC", async () => {
    fixture.candidateRows = [{ id: 5, cluster_id: "c9", article_id: "a9", status: "pending" }];

    const result = await keepClusterArticle(5);

    expect(result).toEqual({ ok: true });
    const updates = supabaseFake.calls.update("jev_unlink_candidates");
    expect(updates).toHaveLength(1);
    const patch = updates[0]?.patch as { status: string; decided_at: unknown };
    expect(patch.status).toBe("kept");
    expect(typeof patch.decided_at).toBe("string");
    expect(updates[0]?.state.eq).toContainEqual({ col: "id", val: 5 });
    expect(updates[0]?.state.eq).toContainEqual({ col: "status", val: "pending" });
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });
});

describe("getJevUnlinkTriage", () => {
  it("the happy path returns band counts and the dry-run summary", async () => {
    fixture.triageBandCounts = { likely_unlink: 3, review: 40, untriaged: 5 };
    fixture.dryRunRows = [
      {
        candidate_id: 1,
        jev_prob: 0.05,
        title_jaccard: 0.1,
        cluster_size: 5,
        would_unlink: true,
        skip_reasons: [],
        first_evaluated_at: "2026-09-28T00:00:00.000Z",
        candidate: {
          status: "pending",
          article: { title: "Haber" },
          cluster: { title_tr: "Küme", title_tr_neutral: null },
        },
      },
    ];

    const result = await getJevUnlinkTriage();

    expect(result?.bands).toEqual({ likelyUnlink: 3, review: 40, untriaged: 5 });
    expect(result?.dryRun.evaluated).toBe(1);
    expect(result?.dryRun.wouldUnlink).toBe(1);
  });

  it("degrades to null on a query error and never throws", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.triageError = { message: "relation does not exist" };

    await expect(getJevUnlinkTriage()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("degrades to null when the dry-run read errors", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.dryRunError = { message: "relation does not exist" };

    await expect(getJevUnlinkTriage()).resolves.toBeNull();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("keepClusterArticles", () => {
  it("updates only pending, band 'review' rows among the given ids to kept with a string decided_at", async () => {
    fixture.candidateRows = [
      { id: 1, cluster_id: "c1", article_id: "a1", status: "pending", band: "review" },
      { id: 2, cluster_id: "c2", article_id: "a2", status: "pending", band: "review" },
      { id: 3, cluster_id: "c3", article_id: "a3", status: "pending", band: "likely_unlink" },
    ];

    const result = await keepClusterArticles([1, 2, 3]);

    expect(result).toEqual({ ok: true, kept: 2, skipped: 1 });
    const updates = supabaseFake.calls.update("jev_unlink_candidates");
    expect(updates).toHaveLength(1);
    const patch = updates[0]?.patch as { status: string; decided_at: unknown };
    expect(patch.status).toBe("kept");
    expect(typeof patch.decided_at).toBe("string");
    expect(updates[0]?.state.in).toContainEqual({ col: "id", vals: [1, 2, 3] });
    expect(updates[0]?.state.eq).toContainEqual({ col: "status", val: "pending" });
    expect(updates[0]?.state.eq).toContainEqual({ col: "band", val: "review" });
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("never throws; a query error returns ok:false", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.unlinkError = { message: "boom" };

    const result = await keepClusterArticles([1]);
    expect(result).toEqual({ ok: false, reason: "error" });
    errorSpy.mockRestore();
  });
});
