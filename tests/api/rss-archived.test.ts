import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// End-to-end proof that /rss.xml inherits politics-query's is_archived
// filter. tests/api/rss.test.ts mocks getPoliticsClusters wholesale (module
// boundary), so it can never exercise a Supabase predicate. This file lets
// the real politics-query run against the shared fake instead.
// ---------------------------------------------------------------------------

vi.mock("next/cache", () => ({
  cacheLife: vi.fn(),
  cacheTag: vi.fn(),
}));

const fixture = vi.hoisted(() => ({
  data: [] as Array<Record<string, unknown>>,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const rows = fixture.data.filter((r) =>
          state.eq.every(({ col, val }) => r[col] === val),
        );
        return { data: rows, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

const ORIGINAL_ENV = { ...process.env };
const NOW_MS = new Date("2026-04-18T12:00:00Z").getTime();

function iso(msOffset: number): string {
  return new Date(NOW_MS - msOffset).toISOString();
}

// Same row shape as politics-query.test.ts's mkCluster, plus is_archived —
// two distinct sourceIds so the members clear the ≥2-source candidate bar.
function mkCluster(opts: {
  id: string;
  is_archived: boolean;
  sourceIds: [string, string];
}) {
  return {
    id: opts.id,
    title_tr: `Cluster ${opts.id}`,
    title_tr_neutral: null,
    summary_tr: "summary",
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    is_archived: opts.is_archived,
    first_published: iso(10 * 60 * 1000),
    updated_at: iso(5 * 60 * 1000),
    cluster_articles: opts.sourceIds.map((sourceId, i) => ({
      articles: {
        id: `${opts.id}-a${i}`,
        title: `Article ${opts.id}-${i}`,
        url: `https://example.com/${opts.id}-${i}`,
        image_url: null,
        published_at: iso(10 * 60 * 1000),
        source_id: sourceId,
        category: "politika",
        content_hash: `h-${opts.id}-${i}`,
        sources: {
          id: sourceId,
          name: `Source ${sourceId}`,
          bias: "center",
          logo_url: null,
          kind: null,
        },
      },
    })),
  };
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  vi.useFakeTimers();
  vi.setSystemTime(new Date(NOW_MS));
  fixture.data = [
    mkCluster({ id: "active-1", is_archived: false, sourceIds: ["s1", "s2"] }),
    mkCluster({ id: "archived-1", is_archived: true, sourceIds: ["s3", "s4"] }),
  ];
});

afterEach(() => {
  vi.useRealTimers();
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

describe("GET /rss.xml (real politics-query, no module mock)", () => {
  it("never lists an archived cluster in the feed", async () => {
    const { GET } = await import("@/app/rss.xml/route");
    const xml = await (await GET()).text();

    expect(xml).toContain("/cluster/active-1"); // sanity: pipeline emits items
    expect(xml).not.toContain("/cluster/archived-1");
  });
});
