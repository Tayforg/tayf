import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Contract tests for the keyed public API's cluster endpoints:
//   GET /api/v1/clusters
//   GET /api/v1/clusters/[id]
//   OPTIONS on both
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/sources-json.test.ts's convention. `api_key_touch` / the
// `api_keys` disambiguation lookup / `api_key_usage_daily` are all driven
// off one small in-memory KEYS_DB so both the happy path and every auth
// failure mode (unknown / revoked / over-cap) are exercised through the
// real requireApiKey() gate, not a stub.
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const FREE_KEY = `tayf_${"1".repeat(40)}`;
const PARTNER_KEY = `tayf_${"2".repeat(40)}`;
const REVOKED_KEY = `tayf_${"3".repeat(40)}`;
const UNKNOWN_KEY = `tayf_${"4".repeat(40)}`;

const KEYS_DB = [
  { id: 101, hash: sha256(FREE_KEY), tier: "free", revoked: false },
  { id: 202, hash: sha256(PARTNER_KEY), tier: "partner", revoked: false },
  { id: 303, hash: sha256(REVOKED_KEY), tier: "free", revoked: true },
];

const NOW_MS = Date.now();
const RECENT = new Date(NOW_MS - 2 * 3600 * 1000).toISOString(); // 2h ago
const OLD = new Date(NOW_MS - 10 * 24 * 3600 * 1000).toISOString(); // 10d ago

const CLUSTER_C1 = "c1111111-1111-1111-1111-111111111111"; // politics majority, recent
const CLUSTER_C2 = "c2222222-2222-2222-2222-222222222222"; // non-political majority
const CLUSTER_C3 = "c3333333-3333-3333-3333-333333333333"; // politics majority, too old
const CLUSTER_C4 = "c4444444-4444-4444-4444-444444444444"; // archived
const CLUSTER_C5 = "c5555555-5555-5555-5555-555555555555"; // live, for [id] 200 test
const UNKNOWN_CLUSTER = "c9999999-9999-9999-9999-999999999999";

const CLUSTERS = [
  {
    id: CLUSTER_C1,
    title_tr: "C1 orijinal başlık",
    title_tr_neutral: null,
    bias_distribution: { pro_government: 1, opposition: 1 },
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    first_published: RECENT,
    updated_at: RECENT,
    is_archived: false,
    cluster_articles: [
      {
        articles: {
          category: "politika",
          // Extra fields a real embedded select would never even return
          // for this route (V1_CLUSTER_SELECT only asks for
          // category/sources.{slug,bias}) — present here only to prove
          // toV1ClusterRecord never forwards them even if they leaked in.
          title: "SECRET_ARTICLE_TITLE",
          url: "https://a.example/secret",
          image_url: "https://img.example/secret.jpg",
          description: "secret article description",
          sources: { slug: "sabah", bias: "pro_government" },
        },
      },
      {
        articles: {
          category: "son_dakika",
          sources: { slug: "birgun", bias: "opposition" },
        },
      },
    ],
  },
  {
    id: CLUSTER_C2,
    title_tr: "C2 orijinal başlık",
    title_tr_neutral: null,
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: 3,
    first_published: RECENT,
    updated_at: RECENT,
    is_archived: false,
    cluster_articles: [
      { articles: { category: "spor", sources: { slug: "sabah", bias: "pro_government" } } },
      { articles: { category: "spor", sources: { slug: "birgun", bias: "opposition" } } },
      { articles: { category: "politika", sources: { slug: "haberturk", bias: "gov_leaning" } } },
    ],
  },
  {
    id: CLUSTER_C3,
    title_tr: "C3 orijinal başlık",
    title_tr_neutral: null,
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    first_published: OLD,
    updated_at: OLD,
    is_archived: false,
    cluster_articles: [
      { articles: { category: "politika", sources: { slug: "sabah", bias: "pro_government" } } },
      { articles: { category: "politika", sources: { slug: "birgun", bias: "opposition" } } },
    ],
  },
  {
    id: CLUSTER_C4,
    title_tr: "C4 arşivlenmiş",
    title_tr_neutral: null,
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: 1,
    first_published: RECENT,
    updated_at: RECENT,
    is_archived: true,
    cluster_articles: [
      { articles: { category: "politika", sources: { slug: "sabah", bias: "pro_government" } } },
    ],
  },
  {
    id: CLUSTER_C5,
    title_tr: "C5 canlı başlık",
    title_tr_neutral: "C5 nötr başlık",
    bias_distribution: { pro_government: 1 },
    is_blindspot: true,
    blindspot_side: "opposition",
    article_count: 1,
    first_published: RECENT,
    updated_at: RECENT,
    is_archived: false,
    cluster_articles: [
      { articles: { category: "politika", sources: { slug: "sabah", bias: "pro_government" } } },
    ],
  },
];

const dbState = vi.hoisted(() => ({
  clustersQueryCount: 0,
  dailyUsage: {} as Record<number, number>,
  forceClustersError: false,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        dbState.clustersQueryCount += 1;
        if (dbState.forceClustersError) {
          return { data: null, error: { message: "boom" } };
        }
        const idEq = state.eq.find((e) => e.col === "id");
        const archivedEq = state.eq.find((e) => e.col === "is_archived");
        const gteUpdated = state.gte.find((g) => g.col === "updated_at");
        const inIds = state.in.find((i) => i.col === "id");

        let rows = CLUSTERS as unknown[] as Array<(typeof CLUSTERS)[number]>;
        if (idEq) rows = rows.filter((r) => r.id === idEq.val);
        if (inIds) rows = rows.filter((r) => inIds.vals.includes(r.id));
        if (archivedEq !== undefined) {
          rows = rows.filter((r) => r.is_archived === archivedEq.val);
        }
        if (gteUpdated) {
          rows = rows.filter((r) => r.updated_at >= (gteUpdated.val as string));
        }
        rows = [...rows].sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        if (state.limit != null) rows = rows.slice(0, state.limit);
        return { data: rows, error: null };
      },
      api_keys: (state) => {
        const hashEq = state.eq.find((e) => e.col === "key_hash");
        const notRevoked = state.not.find(
          (n) => n.col === "revoked_at" && n.op === "is",
        );
        let rows = KEYS_DB;
        if (hashEq) rows = rows.filter((k) => k.hash === hashEq.val);
        if (notRevoked) rows = rows.filter((k) => k.revoked);
        return { data: rows.map((k) => ({ id: k.id })), error: null };
      },
      api_key_usage_daily: (state) => {
        const keyIdEq = state.eq.find((e) => e.col === "key_id");
        const keyId = keyIdEq ? Number(keyIdEq.val) : undefined;
        const calls = keyId !== undefined ? (dbState.dailyUsage[keyId] ?? 0) : 0;
        return { data: [{ calls }], error: null };
      },
    },
    rpc: {
      api_key_touch: (args) => {
        const { p_key_hash } = args as { p_key_hash: string };
        const found = KEYS_DB.find((k) => k.hash === p_key_hash && !k.revoked);
        if (!found) return { data: [], error: null };
        return { data: [{ key_id: found.id, tier: found.tier }], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
  };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${1 + (ipCounter % 250)}.${ipCounter}`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com";
  dbState.clustersQueryCount = 0;
  dbState.dailyUsage = {};
  dbState.forceClustersError = false;
  supabaseFake.calls.rpc.length = 0;
  supabaseFake.calls.mutations.length = 0;
});

afterEach(() => {
  for (const k of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
    "NEXT_PUBLIC_SITE_URL",
  ]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function listRequest(opts: {
  key?: string;
  ip?: string;
  since?: string;
  limit?: string;
} = {}): Request {
  const url = new URL("http://example.com/api/v1/clusters");
  if (opts.since !== undefined) url.searchParams.set("since", opts.since);
  if (opts.limit !== undefined) url.searchParams.set("limit", opts.limit);
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  return new Request(url, { headers });
}

function detailRequest(id: string, opts: { key?: string; ip?: string } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? nextIp() };
  if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  return new Request(`http://example.com/api/v1/clusters/${id}`, { headers });
}

function paramsFor(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe("GET /api/v1/clusters", () => {
  it("401 with no Authorization header and Supabase is never queried for clusters", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest());
    expect(res.status).toBe(401);
    expect(dbState.clustersQueryCount).toBe(0);
  });

  it("401 for a well-formed key whose hash is unknown", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: UNKNOWN_KEY }));
    expect(res.status).toBe(401);
    expect(dbState.clustersQueryCount).toBe(0);
  });

  it("403 for a revoked key", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: REVOKED_KEY }));
    expect(res.status).toBe(403);
    expect(dbState.clustersQueryCount).toBe(0);
  });

  it("200 calls api_key_touch exactly once with the sha256 hex of the presented key", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    expect(res.status).toBe(200);
    const touchCalls = supabaseFake.calls.rpc.filter((c) => c.name === "api_key_touch");
    expect(touchCalls).toHaveLength(1);
    expect(touchCalls[0]?.args).toEqual({ p_key_hash: sha256(FREE_KEY) });
  });

  it("the body carries licence 'CC BY-SA 4.0 — Tayf'a göre', attribution, methodology and generated_at", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    const body = await res.json();
    expect(body.licence).toBe("CC BY-SA 4.0 — Tayf'a göre");
    expect(typeof body.attribution).toBe("string");
    expect(typeof body.methodology).toBe("string");
    expect(typeof body.generated_at).toBe("string");
    expect(new Date(body.generated_at).toString()).not.toBe("Invalid Date");
  });

  it("the body carries no article title, url, image_url or description anywhere", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    const body = await res.json();
    const json = JSON.stringify(body);
    expect(json).not.toContain("SECRET_ARTICLE_TITLE");
    expect(json).not.toContain("a.example/secret");
    expect(json).not.toContain("img.example/secret.jpg");
    expect(json).not.toContain("secret article description");
  });

  it("sets X-Tayf-Tier, Cache-Control private no-store and Access-Control-Allow-Origin *", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("a 401 with no Authorization header still carries Access-Control-Allow-Origin * and Cache-Control private, no-store (E3-V1-ERROR-NO-CORS)", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest());
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("OPTIONS returns 204 with the CORS headers and no body", async () => {
    const { OPTIONS } = await import("@/app/api/v1/clusters/route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    const text = await res.text();
    expect(text).toBe("");
  });

  it("400 for a bad since and for limit 101", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const badSince = await GET(listRequest({ key: FREE_KEY, since: "not-a-date" }));
    expect(badSince.status).toBe(400);
    const badLimit = await GET(listRequest({ key: FREE_KEY, limit: "101" }));
    expect(badLimit.status).toBe(400);
  });

  it("applies the >=60% politics-majority filter and the since window", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const ids = body.clusters.map((c: { id: string }) => c.id);
    // C1 and C5 are both recent + politics-majority; C2 fails the
    // majority filter, C3 fails the since window, C4 is archived.
    expect(new Set(ids)).toEqual(new Set([CLUSTER_C1, CLUSTER_C5]));
    expect(ids).not.toContain(CLUSTER_C2); // non-political majority
    expect(ids).not.toContain(CLUSTER_C3); // outside the since window
    expect(ids).not.toContain(CLUSTER_C4); // archived
  });

  it("free tier 429s on the 61st request within the minute and partner does not", async () => {
    const { GET } = await import("@/app/api/v1/clusters/route");

    for (let i = 0; i < 60; i++) {
      const res = await GET(listRequest({ key: FREE_KEY, ip: `198.51.100.${1 + (i % 250)}` }));
      expect(res.status).toBe(200);
    }
    const res61 = await GET(listRequest({ key: FREE_KEY, ip: "198.51.100.201" }));
    expect(res61.status).toBe(429);

    for (let i = 0; i < 61; i++) {
      const res = await GET(
        listRequest({ key: PARTNER_KEY, ip: `198.51.101.${1 + (i % 250)}` }),
      );
      expect(res.status).toBe(200);
    }
  });

  it("429 with details.retryAfterMs when today's api_key_usage_daily calls exceed the tier's daily cap", async () => {
    dbState.dailyUsage[101] = 2001; // free perDay = 2000
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.details.retryAfterMs).toBe("number");
    expect(body.details.retryAfterMs).toBeGreaterThan(0);
  });

  it("a Supabase read error yields 500 with Access-Control-Allow-Origin * and Cache-Control private, no-store (E3-V1-500-NO-CORS)", async () => {
    dbState.forceClustersError = true;
    const { GET } = await import("@/app/api/v1/clusters/route");
    const res = await GET(listRequest({ key: FREE_KEY }));
    expect(res.status).toBe(500);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("GET /api/v1/clusters/[id]", () => {
  it("400 for a non-uuid, 404 for unknown, 404 for archived, 200 for a live cluster", async () => {
    const { GET } = await import("@/app/api/v1/clusters/[id]/route");

    const badId = await GET(detailRequest("not-a-uuid", { key: FREE_KEY }), paramsFor("not-a-uuid"));
    expect(badId.status).toBe(400);

    const unknown = await GET(
      detailRequest(UNKNOWN_CLUSTER, { key: FREE_KEY }),
      paramsFor(UNKNOWN_CLUSTER),
    );
    expect(unknown.status).toBe(404);

    const archived = await GET(
      detailRequest(CLUSTER_C4, { key: FREE_KEY }),
      paramsFor(CLUSTER_C4),
    );
    expect(archived.status).toBe(404);

    const live = await GET(detailRequest(CLUSTER_C5, { key: FREE_KEY }), paramsFor(CLUSTER_C5));
    expect(live.status).toBe(200);
    const body = await live.json();
    expect(body.cluster.id).toBe(CLUSTER_C5);
    expect(body.cluster.title).toBe("C5 nötr başlık");
  });
});
