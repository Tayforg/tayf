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
//
// The clusters fake also understands the keyset-paging query shape: it sorts by
// the recorded `.order()` chain (updated_at desc, id desc) and applies the
// `.or('updated_at.lt."U",and(updated_at.eq."U",id.lt."I")')` cursor filter by
// comparing the RAW strings, exactly like Postgres would compare the raw
// timestamps, so a cursor that lost microsecond precision would visibly
// skip or repeat rows.
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

interface FakeOrder {
  col: string;
  opts: unknown;
}

const dbState = vi.hoisted(() => ({
  clustersQueryCount: 0,
  dailyUsage: {} as Record<number, number>,
  forceClustersError: false,
  // When set, replaces CLUSTERS as the table contents (the paging suites).
  clusterRows: null as Array<Record<string, unknown>> | null,
  // Every clusters query that carried an .order() (i.e. the list query).
  listQueries: [] as Array<{ or: string[]; order: FakeOrder[]; limit: number | null }>,
}));

const KEYSET_OR_RE =
  /^updated_at\.lt\."([^"]+)",and\(updated_at\.eq\."([^"]+)",id\.lt\."([^"]+)"\)$/;

function compareRows(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  order: FakeOrder[],
): number {
  const specs: FakeOrder[] = order.length
    ? order
    : [{ col: "updated_at", opts: { ascending: false } }];
  for (const o of specs) {
    const av = a[o.col] as string;
    const bv = b[o.col] as string;
    if (av === bv) continue;
    const asc = (o.opts as { ascending?: boolean } | undefined)?.ascending !== false;
    const cmp = av < bv ? -1 : 1;
    return asc ? cmp : -cmp;
  }
  return 0;
}

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

        if (state.order.length > 0) {
          dbState.listQueries.push({
            or: [...state.or],
            order: [...state.order],
            limit: state.limit,
          });
        }

        type Row = Record<string, unknown> & { id: string; updated_at: string };
        let rows = (dbState.clusterRows ?? CLUSTERS) as unknown[] as Row[];
        if (idEq) rows = rows.filter((r) => r.id === idEq.val);
        if (inIds) rows = rows.filter((r) => inIds.vals.includes(r.id));
        if (archivedEq !== undefined) {
          rows = rows.filter((r) => r.is_archived === archivedEq.val);
        }
        if (gteUpdated) {
          rows = rows.filter((r) => r.updated_at >= (gteUpdated.val as string));
        }
        for (const filter of state.or) {
          const m = KEYSET_OR_RE.exec(filter);
          if (!m) throw new Error(`fake cannot parse .or(${filter})`);
          const [, lt, eq, id] = m as unknown as [string, string, string, string];
          if (lt !== eq) throw new Error("keyset .or() must use the same timestamp twice");
          rows = rows.filter(
            (r) => r.updated_at < lt || (r.updated_at === lt && r.id < id),
          );
        }
        rows = [...rows].sort((a, b) => compareRows(a, b, state.order));
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
  dbState.clusterRows = null;
  dbState.listQueries = [];
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
  before?: string;
} = {}): Request {
  const url = new URL("http://example.com/api/v1/clusters");
  if (opts.since !== undefined) url.searchParams.set("since", opts.since);
  if (opts.limit !== undefined) url.searchParams.set("limit", opts.limit);
  if (opts.before !== undefined) url.searchParams.set("before", opts.before);
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
    // Everything in the window was scanned, so there is no next page.
    expect(body).toHaveProperty("next_cursor", null);
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

// ---------------------------------------------------------------------------
// Keyset paging (api-9): `?before=<next_cursor>` continues after the last
// row of the previous page, ordered (updated_at desc, id desc).
// ---------------------------------------------------------------------------

/** A PostgREST-style timestamptz string with microseconds: 2026-10-23T12:34:56.789123+00:00 */
function rawTs(msAgo: number, micro = "123"): string {
  return new Date(NOW_MS - msAgo)
    .toISOString()
    .replace(/\.(\d{3})Z$/, `.$1${micro}+00:00`);
}

function uuidN(n: number): string {
  return `a0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function pageCluster(id: string, updatedAt: string, politics = true) {
  return {
    id,
    title_tr: `Küme ${id.slice(-4)}`,
    title_tr_neutral: null,
    bias_distribution: {},
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    first_published: updatedAt,
    updated_at: updatedAt,
    is_archived: false,
    cluster_articles: [
      {
        articles: {
          category: politics ? "politika" : "spor",
          sources: { slug: "sabah", bias: "pro_government" },
        },
      },
      {
        articles: {
          category: politics ? "son_dakika" : "spor",
          sources: { slug: "birgun", bias: "opposition" },
        },
      },
    ],
  };
}

function encodeRawCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeRawCursor(cursor: string): { u: string; i: string } {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
}

async function getPage(opts: { limit?: string; before?: string } = {}) {
  const { GET } = await import("@/app/api/v1/clusters/route");
  const res = await GET(listRequest({ key: PARTNER_KEY, ...opts }));
  return res;
}

describe("GET /api/v1/clusters — keyset paging", () => {
  // Seven politics clusters, newest first. C and D share the same updated_at
  // (the tie), so id desc decides: D (…04) is listed before C (…03).
  const T3 = rawTs(3 * 60_000);
  const A = pageCluster(uuidN(1), rawTs(1 * 60_000));
  const B = pageCluster(uuidN(2), rawTs(2 * 60_000));
  const C = pageCluster(uuidN(3), T3);
  const D = pageCluster(uuidN(4), T3);
  const E = pageCluster(uuidN(5), rawTs(4 * 60_000));
  const F = pageCluster(uuidN(6), rawTs(5 * 60_000));
  const G = pageCluster(uuidN(7), rawTs(6 * 60_000));
  const EXPECTED_ORDER = [A, B, D, C, E, F, G].map((c) => c.id);

  beforeEach(() => {
    dbState.clusterRows = [G, C, A, F, D, B, E];
  });

  it("?limit=2 returns the two newest clusters and a next_cursor", async () => {
    const res = await getPage({ limit: "2" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.clusters.map((c: { id: string }) => c.id)).toEqual([A.id, B.id]);
    expect(body.count).toBe(2);
    expect(typeof body.next_cursor).toBe("string");
    expect(body.next_cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.next_cursor.length).toBeLessThanOrEqual(200);
  });

  it("queries ordered by (updated_at desc, id desc) with no .or() on the first page", async () => {
    await getPage({ limit: "2" });
    expect(dbState.listQueries).toHaveLength(1);
    const q = dbState.listQueries[0]!;
    expect(q.order).toEqual([
      { col: "updated_at", opts: { ascending: false } },
      { col: "id", opts: { ascending: false } },
    ]);
    expect(q.or).toEqual([]);
    // limit * 3 candidates (CANDIDATE_MULTIPLIER), capped at 300.
    expect(q.limit).toBe(6);
  });

  it("?before=<next_cursor> returns the next two with no overlap and in order", async () => {
    const first = await (await getPage({ limit: "2" })).json();
    const second = await (await getPage({ limit: "2", before: first.next_cursor })).json();

    expect(second.clusters.map((c: { id: string }) => c.id)).toEqual([D.id, C.id]);
    const firstIds = new Set(first.clusters.map((c: { id: string }) => c.id));
    for (const c of second.clusters) expect(firstIds.has(c.id)).toBe(false);
    expect(typeof second.next_cursor).toBe("string");

    // The cursor query: strictly after (updated_at, id), on the raw strings.
    const cursor = decodeRawCursor(first.next_cursor);
    const q = dbState.listQueries[1]!;
    expect(q.or).toEqual([
      `updated_at.lt."${cursor.u}",and(updated_at.eq."${cursor.u}",id.lt."${cursor.i}")`,
    ]);
  });

  it("walking one row at a time visits every cluster once, in order, across the updated_at tie", async () => {
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 20; page++) {
      const res = await getPage({ limit: "1", ...(before ? { before } : {}) });
      expect(res.status).toBe(200);
      const body = await res.json();
      for (const c of body.clusters) seen.push(c.id);
      if (body.next_cursor === null) break;
      before = body.next_cursor;
    }
    expect(seen).toEqual(EXPECTED_ORDER);
  });

  it("next_cursor is null once the scan is exhausted", async () => {
    const all = await (await getPage({ limit: "10" })).json();
    expect(all.clusters.map((c: { id: string }) => c.id)).toEqual(EXPECTED_ORDER);
    expect(all.next_cursor).toBeNull();

    // The last page of a limit=2 walk (G alone) is exhausted too.
    const cursorBeforeG = encodeRawCursor({ u: F.updated_at, i: F.id });
    const last = await (await getPage({ limit: "2", before: cursorBeforeG })).json();
    expect(last.clusters.map((c: { id: string }) => c.id)).toEqual([G.id]);
    expect(last.next_cursor).toBeNull();
  });

  it("a page that ends exactly on the last cluster still reports null when nothing is left", async () => {
    const res = await (await getPage({ limit: "7" })).json();
    expect(res.clusters).toHaveLength(7);
    expect(res.next_cursor).toBeNull();
  });

  it("the cursor carries the RAW updated_at string, microseconds intact", async () => {
    const body = await (await getPage({ limit: "3" })).json();
    // Third row is D (the tie). Its raw updated_at has six fractional digits.
    expect(body.clusters.at(-1).id).toBe(D.id);
    const cursor = decodeRawCursor(body.next_cursor);
    expect(cursor).toEqual({ u: D.updated_at, i: D.id });
    expect(cursor.u).toMatch(/\.\d{6}\+00:00$/);
    expect(cursor.u).not.toMatch(/Z$/);
    // And exactly that string reaches the database filter.
    const next = await getPage({ limit: "3", before: body.next_cursor });
    expect(next.status).toBe(200);
    expect(dbState.listQueries[1]!.or[0]).toContain(`"${D.updated_at}"`);
    expect((await next.json()).clusters[0].id).toBe(C.id);
  });

  it("microsecond neighbours page correctly (a millisecond-truncated cursor would repeat or skip one)", async () => {
    const m1 = pageCluster(uuidN(11), rawTs(10 * 60_000, "111"));
    const m2 = pageCluster(uuidN(12), rawTs(10 * 60_000, "222"));
    const m3 = pageCluster(uuidN(13), rawTs(10 * 60_000, "333"));
    dbState.clusterRows = [m1, m2, m3];
    const seen: string[] = [];
    let before: string | undefined;
    for (let page = 0; page < 6; page++) {
      const body = await (await getPage({ limit: "1", ...(before ? { before } : {}) })).json();
      for (const c of body.clusters) seen.push(c.id);
      if (body.next_cursor === null) break;
      before = body.next_cursor;
    }
    expect(seen).toEqual([m3.id, m2.id, m1.id]);
  });

  it("when 300 scanned candidates hold fewer politics rows than limit, next_cursor is the last scanned candidate", async () => {
    // 320 clusters, newest first. Only every 60th is politics, so the first
    // 300 candidates hold 5 politics rows (limit=100 asks for far more).
    const rows = Array.from({ length: 320 }, (_, k) =>
      pageCluster(uuidN(1000 + k), rawTs((k + 1) * 1000, String(100 + (k % 900))), k % 60 === 0),
    );
    dbState.clusterRows = rows;

    const first = await (await getPage({ limit: "100" })).json();
    expect(dbState.listQueries[0]!.limit).toBe(300);
    expect(first.clusters.map((c: { id: string }) => c.id)).toEqual(
      rows.slice(0, 300).filter((_, k) => k % 60 === 0).map((c) => c.id),
    );
    expect(first.count).toBe(5);
    expect(first.count).toBeLessThan(100);

    const last = rows[299]!;
    expect(decodeRawCursor(first.next_cursor)).toEqual({ u: last.updated_at, i: last.id });

    // The next window starts right after row 300 and finds the rest.
    const second = await (await getPage({ limit: "100", before: first.next_cursor })).json();
    expect(second.clusters.map((c: { id: string }) => c.id)).toEqual(
      rows.slice(300).filter((_, k) => (300 + k) % 60 === 0).map((c) => c.id),
    );
    expect(second.next_cursor).toBeNull();
  });

  it("a truncated page resumes right after the last RETURNED row, not the last scanned one", async () => {
    // 30 candidates (limit 10 * 3), all politics: 30 > 10 -> truncated page.
    // The 20 unreturned politics rows must be re-scanned by the next page.
    const rows = Array.from({ length: 40 }, (_, k) =>
      pageCluster(uuidN(2000 + k), rawTs((k + 1) * 1000)),
    );
    dbState.clusterRows = rows;
    const body = await (await getPage({ limit: "10" })).json();
    expect(body.count).toBe(10);
    expect(decodeRawCursor(body.next_cursor)).toEqual({
      u: rows[9]!.updated_at,
      i: rows[9]!.id,
    });
  });

  it("omits nothing from the old payload: since, count, clusters and the licence envelope are still there", async () => {
    const body = await (await getPage({ limit: "2" })).json();
    for (const key of ["since", "count", "clusters", "next_cursor", "licence", "attribution", "methodology", "generated_at"]) {
      expect(body, key).toHaveProperty(key);
    }
  });

  describe("a bad ?before is a 400 'Invalid cursor' before any clusters query", () => {
    const GOOD_I = uuidN(1);
    const GOOD_U = rawTs(60_000);
    const cases: Record<string, string> = {
      "not base64": "!!!not-base64!!!",
      "base64 of non-JSON": Buffer.from("nope", "utf8").toString("base64url"),
      "JSON that is not an object": encodeRawCursor("just a string"),
      "JSON null": encodeRawCursor(null),
      "JSON array": encodeRawCursor([GOOD_U, GOOD_I]),
      "missing u": encodeRawCursor({ i: GOOD_I }),
      "missing i": encodeRawCursor({ u: GOOD_U }),
      "u is not a string": encodeRawCursor({ u: 1234, i: GOOD_I }),
      "u is not a timestamp": encodeRawCursor({ u: "yesterday", i: GOOD_I }),
      "u has no time part": encodeRawCursor({ u: "2026-10-20", i: GOOD_I }),
      "u has no timezone": encodeRawCursor({ u: "2026-10-20T10:00:00", i: GOOD_I }),
      "u has too many fraction digits": encodeRawCursor({ u: "2026-10-20T10:00:00.1234567Z", i: GOOD_I }),
      "u is an impossible date": encodeRawCursor({ u: "2026-13-45T10:00:00Z", i: GOOD_I }),
      "u smuggles filter syntax": encodeRawCursor({ u: `2026-10-20T10:00:00Z"),id.gt."0`, i: GOOD_I }),
      "i is not a uuid": encodeRawCursor({ u: GOOD_U, i: "not-a-uuid" }),
      "i smuggles filter syntax": encodeRawCursor({ u: GOOD_U, i: `${GOOD_I}"),is_archived.eq."true` }),
      "longer than 200 characters": "A".repeat(201),
    };

    for (const [name, before] of Object.entries(cases)) {
      it(name, async () => {
        const res = await getPage({ before });
        expect(res.status).toBe(400);
        expect((await res.json()).error).toBe("Invalid cursor");
        expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
        expect(res.headers.get("X-Tayf-Tier")).toBe("partner");
        expect(dbState.listQueries).toHaveLength(0);
        expect(dbState.clustersQueryCount).toBe(0);
      });
    }

    it("a blank ?before= is treated as absent, like a blank since or limit", async () => {
      const res = await getPage({ before: "" });
      expect(res.status).toBe(200);
      expect(dbState.listQueries[0]!.or).toEqual([]);
    });

    it("an unauthenticated request with a bad cursor is still a 401, not a 400", async () => {
      const { GET } = await import("@/app/api/v1/clusters/route");
      const res = await GET(listRequest({ before: "!!!" }));
      expect(res.status).toBe(401);
    });
  });

  it("encodeV1Cursor and decodeV1Cursor round-trip, and decode refuses anything else", async () => {
    const { encodeV1Cursor, decodeV1Cursor } = await import("@/lib/api/v1-clusters");
    const cursor = { u: "2026-10-20T10:00:00.123456+00:00", i: uuidN(9) };
    const encoded = encodeV1Cursor(cursor);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeRawCursor(encoded)).toEqual(cursor);
    expect(decodeV1Cursor(encoded)).toEqual(cursor);

    expect(decodeV1Cursor("")).toBeNull();
    expect(decodeV1Cursor("%%%")).toBeNull();
    expect(decodeV1Cursor(encodeRawCursor({ u: "x", i: uuidN(9) }))).toBeNull();
    // Offsets, with and without fractions, and Z, are all valid timestamptz renderings.
    for (const u of [
      "2026-10-20T10:00:00Z",
      "2026-10-20T10:00:00.1Z",
      "2026-10-20T10:00:00.123456Z",
      "2026-10-20T10:00:00+03:00",
      "2026-10-20T10:00:00.5-01:30",
    ]) {
      expect(decodeV1Cursor(encodeV1Cursor({ u, i: uuidN(9) })), u).toEqual({ u, i: uuidN(9) });
    }
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
