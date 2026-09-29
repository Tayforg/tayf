import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// GET /api/v1/clusters/[id] for a cluster merged into another one (099):
// the hot path stays a single clusters query; only a miss triggers the
// merged_into lookup, which turns into a 301 with a Location header.

const FREE_KEY = `tayf_${"1".repeat(40)}`;
const KEY_HASH = crypto.createHash("sha256").update(FREE_KEY).digest("hex");

const LIVE = "c1111111-1111-4111-8111-111111111111";
const MERGED = "c2222222-2222-4222-8222-222222222222"; // archived, merged_into TARGET
const TARGET = "c3333333-3333-4333-8333-333333333333";
const ARCHIVED_PLAIN = "c4444444-4444-4444-8444-444444444444"; // archived, no merged_into
const MISSING = "c9999999-9999-4999-8999-999999999999";
const BAD_POINTER = "c5555555-5555-4555-8555-555555555555"; // merged_into not a uuid

const RECENT = new Date().toISOString();

function row(id: string, extra: Record<string, unknown>) {
  return {
    id,
    title_tr: `t-${id}`,
    title_tr_neutral: null,
    bias_distribution: { pro_government: 1 },
    is_blindspot: false,
    blindspot_side: null,
    article_count: 1,
    first_published: RECENT,
    updated_at: RECENT,
    is_archived: false,
    merged_into: null,
    cluster_articles: [
      { articles: { category: "politika", sources: { slug: "sabah", bias: "pro_government" } } },
    ],
    ...extra,
  };
}

const CLUSTERS = [
  row(LIVE, {}),
  row(MERGED, { is_archived: true, merged_into: TARGET }),
  row(ARCHIVED_PLAIN, { is_archived: true }),
  row(BAD_POINTER, { is_archived: true, merged_into: "not-a-uuid" }),
];

const dbState = vi.hoisted(() => ({
  clusterQueries: [] as Array<{ select: string; archivedEq: boolean }>,
  lookupError: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const archivedEq = state.eq.find((e) => e.col === "is_archived");
        dbState.clusterQueries.push({
          select: String(state.selectArgs[0] ?? ""),
          archivedEq: archivedEq !== undefined,
        });
        const isLookup = String(state.selectArgs[0]) === "merged_into";
        if (isLookup && dbState.lookupError) {
          return { data: null, error: { message: 'column "merged_into" does not exist' } };
        }
        const idEq = state.eq.find((e) => e.col === "id");
        let rows = CLUSTERS as Array<Record<string, unknown>>;
        if (idEq) rows = rows.filter((r) => r.id === idEq.val);
        if (archivedEq) rows = rows.filter((r) => r.is_archived === archivedEq.val);
        if (isLookup) rows = rows.map((r) => ({ merged_into: r.merged_into }));
        return { data: rows, error: null };
      },
      api_keys: () => ({ data: [{ id: 101 }], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
    },
    rpc: {
      api_key_touch: (args) => {
        const { p_key_hash } = args as { p_key_hash: string };
        if (p_key_hash !== KEY_HASH) return { data: [], error: null };
        return { data: [{ key_id: 101, tier: "free" }], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com";
  dbState.clusterQueries = [];
  dbState.lookupError = false;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SITE_URL"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

async function get(id: string) {
  ipCounter += 1;
  const { GET } = await import("@/app/api/v1/clusters/[id]/route");
  const req = new Request(`http://example.com/api/v1/clusters/${id}`, {
    headers: { "x-forwarded-for": `198.51.100.${ipCounter % 250}.${ipCounter}`, authorization: `Bearer ${FREE_KEY}` },
  });
  return GET(req, { params: Promise.resolve({ id }) });
}

describe("GET /api/v1/clusters/[id] — merged clusters", () => {
  it("a live cluster is 200 with exactly one main clusters query and no merged_into lookup", async () => {
    const res = await get(LIVE);
    expect(res.status).toBe(200);
    // (fetchTopic7 issues its own topic probe against clusters; that is not the row lookup.)
    expect(dbState.clusterQueries.filter((q) => q.archivedEq)).toHaveLength(1);
    expect(dbState.clusterQueries.filter((q) => q.select === "merged_into")).toHaveLength(0);
  });

  it("an archived cluster with merged_into answers 301 with Location and details", async () => {
    const res = await get(MERGED);
    expect(res.status).toBe(301);
    expect(res.headers.get("Location")).toBe(`/api/v1/clusters/${TARGET}`);
    expect(await res.json()).toEqual({ error: "Cluster merged", details: { merged_into: TARGET } });
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("an archived cluster without merged_into is 404", async () => {
    expect((await get(ARCHIVED_PLAIN)).status).toBe(404);
  });

  it("a missing cluster is 404", async () => {
    expect((await get(MISSING)).status).toBe(404);
  });

  it("a non-uuid merged_into is 404", async () => {
    expect((await get(BAD_POINTER)).status).toBe(404);
  });

  it("a lookup error stays a 404 (route works before 099 is applied)", async () => {
    dbState.lookupError = true;
    const res = await get(MERGED);
    expect(res.status).toBe(404);
    expect(res.headers.get("Location")).toBeNull();
  });
});
