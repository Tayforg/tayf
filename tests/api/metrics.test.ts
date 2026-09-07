import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// next/server mock.
//
// The metrics route awaits `connection()` (directly or via shared helpers) so
// Next.js 16's cache-components prerender doesn't choke on `request.headers`.
// Outside a Next.js request scope (i.e. here in vitest) the real
// `connection()` throws "called outside a request scope" — resolve it to a
// no-op so the handler can run end-to-end and we exercise the real count
// envelope instead of a 500-for-wrong-reason. Everything else from
// `next/server` (NextResponse, etc.) passes through untouched via
// `importOriginal`.
// ---------------------------------------------------------------------------
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

// ---------------------------------------------------------------------------
// Supabase mock plumbing for /api/metrics.
//
// The route issues Promise.all over thirteen count queries. Each one starts with
// `supabase.from("<table>").select("*", { count: "exact", head: true })` and
// then chains zero or more filter predicates (.gte / .is / .in / .not / .eq).
// Every chain is thenable (the route `await`s on them directly via Promise.all)
// and resolves to `{ count: <number>, error: null }`.
//
// The `counts` map below lets each test dial in exactly what every call
// returns. The identity of each Promise.all entry is positional, not
// semantic — the mock tracks calls in the order they're made and returns the
// configured count for that index.
// ---------------------------------------------------------------------------

interface CountResponse {
  count: number | null;
  // Round-6 P1 added a maybeSingle() query for the oldest pending neutral
  // cluster, and 039 added a maybeSingle() quality-snapshot query and a
  // plain-select row-errors query — those surfaces return `data`, not
  // `count`. Keep `data` loose enough to cover all three shapes on the
  // same fake array.
  data?:
    | { first_published: string | null }
    | { taken_at: string; singleton_rate: number | null; cluster_count: number | null; blindspot_flip_rate: number | null }
    | { row_errors: number | null }[]
    | null;
  error: { message: string; code?: string } | null;
}

// Default counts, in the order the route issues them. Matches the
// Promise.all in src/app/api/metrics/route.ts.
const DEFAULT_COUNTS: CountResponse[] = [
  { count: 100, error: null }, // 0  articlesTotal
  { count: 20, error: null }, // 1  articlesLast24h
  { count: 5, error: null }, // 2  articlesLastHour
  { count: 3, error: null }, // 3  politicsNullImage
  // politicsTotal is deliberately distinct from every other default so a
  // query-order swap (e.g. with politicsNullImage above) skews the ratio
  // and fails the shape assertion loudly instead of passing by luck.
  { count: 16, error: null }, // 4  politicsTotal
  { count: 77, error: null }, // 5  articlesWithImage
  { count: 40, error: null }, // 6  clustersTotal
  { count: 12, error: null }, // 7  clustersMulti
  { count: 2, error: null }, // 8  clustersBlindspots
  { count: 10, error: null }, // 9  clustersNeutralizedEligible
  { count: 7, error: null }, // 10 clustersNeutralized
  { count: 8, error: null }, // 11 sourcesTotal
  { count: 7, error: null }, // 12 sourcesActive
  // 13 oldestPendingNeutral — null data means "no pending row"; the
  // route renders this as `oldestPendingNeutralAgeSec: null`.
  { count: null, data: null, error: null },
  // 14 latestQualitySnapshot — a present row; the route renders this as
  // `clusters.quality`.
  {
    count: null,
    data: {
      taken_at: "2026-09-08T03:00:00.000Z",
      singleton_rate: 0.42,
      cluster_count: 80,
      blindspot_flip_rate: 0.05,
    },
    error: null,
  },
  // 15 ingestRowErrors — two cycles finished in the last hour.
  { count: null, data: [{ row_errors: 2 }, { row_errors: 1 }], error: null },
];

let currentCounts: CountResponse[] = [...DEFAULT_COUNTS];
let callIndex = 0;

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      // Each `.from()` opens a fresh chain. The terminal behavior is a
      // thenable whose resolved value is the next configured CountResponse.
      const thenable: {
        then: Promise<CountResponse>["then"];
        select: () => typeof thenable;
        gte: () => typeof thenable;
        is: () => typeof thenable;
        in: () => typeof thenable;
        not: () => typeof thenable;
        eq: () => typeof thenable;
        order: () => typeof thenable;
        limit: () => typeof thenable;
        maybeSingle: () => typeof thenable;
      } = {} as never;

      const chain: {
        select: () => typeof thenable;
        gte: () => typeof thenable;
        is: () => typeof thenable;
        in: () => typeof thenable;
        not: () => typeof thenable;
        eq: () => typeof thenable;
        order: () => typeof thenable;
        limit: () => typeof thenable;
        maybeSingle: () => typeof thenable;
        then: Promise<CountResponse>["then"];
      } = {
        select: () => thenable,
        gte: () => thenable,
        is: () => thenable,
        in: () => thenable,
        not: () => thenable,
        eq: () => thenable,
        order: () => thenable,
        limit: () => thenable,
        maybeSingle: () => thenable,
        then: (onFulfilled, onRejected) => {
          const idx = callIndex++;
          const response =
            currentCounts[idx] ?? { count: 0, error: null };
          return Promise.resolve(response).then(onFulfilled, onRejected);
        },
      };
      Object.assign(thenable, chain);
      return thenable;
    },
  }),
}));

const ORIGINAL_ENV = { ...process.env };
const TEST_CRON_SECRET = "test-cron-secret-for-metrics-route";

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  // The metrics route fail-closes on a missing CRON_SECRET (503) and
  // 401s any caller without a matching Bearer header. Tests default to
  // a bearer-authed Request so they exercise the count-aggregation path.
  process.env.CRON_SECRET = TEST_CRON_SECRET;
  currentCounts = [...DEFAULT_COUNTS];
  callIndex = 0;
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "CRON_SECRET",
  ]) {
    if (k in ORIGINAL_ENV) {
      process.env[k] = ORIGINAL_ENV[k] as string;
    } else {
      delete process.env[k];
    }
  }
  vi.resetModules();
});

async function callGet(request?: Request) {
  const mod = await import("@/app/api/metrics/route");
  const authedRequest =
    request ??
    new Request("http://localhost/api/metrics", {
      headers: { Authorization: `Bearer ${TEST_CRON_SECRET}` },
    });
  const res = await mod.GET(authedRequest);
  const body = await res.json();
  return { res, status: res.status, body };
}

describe("GET /api/metrics", () => {
  it("returns 200 with the documented metric shape", async () => {
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body).toHaveProperty("timestamp");
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    expect(body.articles).toEqual({
      total: 100,
      last24h: 20,
      lastHour: 5,
      politicsNullImage: 3,
      politicsTotal: 16,
      withImage: 77,
      // 3 / 16 = 0.1875 → 0.19 (rounded to 2 decimal places)
      politicsImageMissingRatio: 0.19,
    });

    expect(body.clusters).toEqual({
      total: 40,
      multiArticle: 12,
      blindspots: 2,
      // 100 / 40 = 2.5 (rounded to 2 decimal places)
      avgArticlesPerCluster: 2.5,
      // (100 - (40 - 12)) / 12 = 72 / 12 = 6 — singleton clusters hold
      // exactly one article each, so 72 articles live in the 12
      // multi-article clusters.
      avgArticlesPerMultiCluster: 6,
      neutralizedEligible: 10,
      neutralized: 7,
      // 7 / 10 = 0.70 — well below the 0.9 page threshold the docs
      // call out as the headline-cron drift signal.
      neutralizedRatio: 0.7,
      // null because the fake's index-13 row returns data: null,
      // meaning "no pending row at all".
      oldestPendingNeutralAgeSec: null,
      quality: {
        takenAt: "2026-09-08T03:00:00.000Z",
        singletonRate: 0.42,
        clusterCount: 80,
        blindspotFlipRate: 0.05,
      },
    });

    expect(body.sources).toEqual({
      total: 8,
      active: 7,
    });

    // 2 + 1 = 3 row_errors across the two ingest_cycles rows fetched.
    expect(body.ingest).toEqual({ rowErrorsLastHour: 3 });
  });

  it("returns the no-store cache header so auth-gated data is not CDN-cached", async () => {
    const { res } = await callGet();
    // The metrics route used to emit `public, max-age=60` but the
    // worker-stream refactor moved the route behind a bearer gate; we no
    // longer want any cache layer between Vercel and the dashboard.
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("treats null count values as 0", async () => {
    currentCounts = DEFAULT_COUNTS.map(() => ({ count: null, error: null }));
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.articles.total).toBe(0);
    expect(body.articles.last24h).toBe(0);
    expect(body.articles.lastHour).toBe(0);
    expect(body.articles.politicsNullImage).toBe(0);
    expect(body.articles.politicsTotal).toBe(0);
    expect(body.articles.politicsImageMissingRatio).toBe(0);
    expect(body.articles.withImage).toBe(0);
    expect(body.clusters.total).toBe(0);
    expect(body.clusters.multiArticle).toBe(0);
    expect(body.clusters.avgArticlesPerMultiCluster).toBe(0);
    expect(body.clusters.blindspots).toBe(0);
    expect(body.sources.total).toBe(0);
    expect(body.sources.active).toBe(0);
    // No data on either fake row: no snapshot yet, no ingest_cycles rows.
    expect(body.clusters.quality).toBeNull();
    expect(body.ingest.rowErrorsLastHour).toBe(0);
  });

  it("sets avgArticlesPerCluster to 0 when there are no clusters (avoids div-by-zero)", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    // clustersTotal is index 6
    currentCounts[6] = { count: 0, error: null };
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.clusters.total).toBe(0);
    expect(body.clusters.avgArticlesPerCluster).toBe(0);
  });

  it("rounds avgArticlesPerCluster to two decimal places", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    // 7 articles / 3 clusters = 2.3333... → rounds to 2.33
    currentCounts[0] = { count: 7, error: null }; // articlesTotal
    currentCounts[6] = { count: 3, error: null }; // clustersTotal
    const { body } = await callGet();
    expect(body.clusters.avgArticlesPerCluster).toBe(2.33);
  });

  it("sets politicsImageMissingRatio to 0 when there are no politics articles", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[4] = { count: 0, error: null }; // politicsTotal
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.articles.politicsTotal).toBe(0);
    expect(body.articles.politicsImageMissingRatio).toBe(0);
  });

  it("computes avgArticlesPerMultiCluster over multi-article clusters only", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    // 50 articles, 20 clusters, 7 of them multi-article:
    // (50 - (20 - 7)) / 7 = 37 / 7 = 5.2857... → rounds to 5.29
    currentCounts[0] = { count: 50, error: null }; // articlesTotal
    currentCounts[6] = { count: 20, error: null }; // clustersTotal
    currentCounts[7] = { count: 7, error: null }; // clustersMulti
    const { body } = await callGet();
    expect(body.clusters.avgArticlesPerMultiCluster).toBe(5.29);
    // The all-clusters mean keeps its original denominator: 50 / 20 = 2.5.
    expect(body.clusters.avgArticlesPerCluster).toBe(2.5);
  });

  it("sets avgArticlesPerMultiCluster to 0 when there are no multi-article clusters", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[7] = { count: 0, error: null }; // clustersMulti
    const { body } = await callGet();
    expect(body.clusters.multiArticle).toBe(0);
    expect(body.clusters.avgArticlesPerMultiCluster).toBe(0);
  });

  it("sets clusters.quality to null before the first audit-clusters --persist run", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[14] = { count: null, data: null, error: null }; // latestQualitySnapshot
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.clusters.quality).toBeNull();
  });

  it("sets ingest.rowErrorsLastHour to 0 when ingest_cycles is empty", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[15] = { count: null, data: [], error: null }; // ingestRowErrors
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.ingest.rowErrorsLastHour).toBe(0);
  });

  it("treats a missing row_errors value on an ingest_cycles row as 0", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[15] = {
      count: null,
      data: [{ row_errors: null }, { row_errors: 4 }],
      error: null,
    };
    const { body } = await callGet();
    expect(body.ingest.rowErrorsLastHour).toBe(4);
  });

  it("returns 503 when the latest-quality-snapshot query errors", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[14] = { count: null, error: { message: "boom" } }; // latestQualitySnapshot
    const { status, body } = await callGet();
    expect(status).toBe(503);
    expect(body.code).toBe("METRICS_QUERY_FAILED");
    expect(body.details.queries).toEqual(["latestQualitySnapshot"]);
  });

  it("returns 503 when the ingest-row-errors query errors", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[15] = { count: null, error: { message: "boom" } }; // ingestRowErrors
    const { status, body } = await callGet();
    expect(status).toBe(503);
    expect(body.code).toBe("METRICS_QUERY_FAILED");
    expect(body.details.queries).toEqual(["ingestRowErrors"]);
  });

  // Migration 039 window: cluster_quality_snapshots / ingest_cycles don't
  // exist yet if this branch reaches Vercel before 039 lands on Supabase.
  // PostgREST reports that as an error (missing-relation code), not empty
  // data — the route treats those two specific codes as "no data yet"
  // instead of 503ing the whole endpoint (docs/migration-guide.md F2).
  it("treats a missing cluster_quality_snapshots table (PGRST205) as quality: null instead of 503", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[14] = { count: null, data: null, error: { message: "not found", code: "PGRST205" } };
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.clusters.quality).toBeNull();
  });

  it("treats a missing ingest_cycles table (Postgres 42P01) as rowErrorsLastHour: 0 instead of 503", async () => {
    currentCounts = [...DEFAULT_COUNTS];
    currentCounts[15] = { count: null, data: null, error: { message: "relation does not exist", code: "42P01" } };
    const { status, body } = await callGet();
    expect(status).toBe(200);
    expect(body.ingest.rowErrorsLastHour).toBe(0);
  });
});
