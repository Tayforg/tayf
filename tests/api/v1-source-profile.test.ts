import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Contract tests for GET /api/v1/sources/{slug}/profile — the keyed mirror of
// the source page's "Kapsama karnesi". Harness copied from
// tests/api/v1-sources.test.ts (KEYS_DB driving api_key_touch, fresh IP per
// request).
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const FREE_KEY = `tayf_${"6".repeat(40)}`;
const KEYS_DB = [{ id: 666, hash: sha256(FREE_KEY), tier: "free", revoked: false }];

const SOURCE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const RAW_SOURCES = [
  {
    id: SOURCE_ID,
    slug: "sabah",
    name: "Sabah",
    url: "https://www.sabah.com.tr",
    bias: "pro_government",
    kind: "outlet",
    active: true,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: null,
    trustee_note: null,
    rss_url: "https://www.sabah.com.tr/rss/anasayfa.xml",
  },
  {
    id: "11111111-2222-3333-4444-555555555555",
    slug: "retired-outlet",
    name: "Retired Outlet",
    url: "https://example.com/retired",
    bias: "opposition",
    kind: "outlet",
    active: false,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: null,
    trustee_note: null,
    rss_url: "https://example.com/retired/rss.xml",
  },
];

function karneRow(over: Record<string, unknown> = {}) {
  return {
    source_id: SOURCE_ID,
    window_days: 30,
    window_start: "2026-08-30T00:00:00.000Z",
    window_end: "2026-09-29T00:00:00.000Z",
    n_clusters: 40,
    n_multi: 25,
    co_iktidar: 10,
    co_bagimsiz: 5,
    co_muhalefet: 20,
    n_blindspot: 3,
    n_blindspot_same_side: 1,
    computed_at: "2026-09-29T03:00:00.000Z",
    ...over,
  };
}

const dbState = vi.hoisted(() => ({
  sourcesSelects: [] as unknown[],
  karneSelects: [] as unknown[],
  sourcesQueries: 0,
  karneRow: null as Record<string, unknown> | null,
  karneError: null as { message: string } | null,
  touchCalls: 0,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state) => {
        dbState.sourcesQueries += 1;
        dbState.sourcesSelects.push(state.selectArgs[0]);
        let rows = RAW_SOURCES;
        for (const e of state.eq) rows = rows.filter((r) => (r as Record<string, unknown>)[e.col] === e.val);
        return { data: rows, error: null };
      },
      source_karne_30d: (state) => {
        dbState.karneSelects.push(state.selectArgs[0]);
        if (dbState.karneError) return { data: null, error: dbState.karneError };
        const idEq = state.eq.find((e) => e.col === "source_id");
        const row = dbState.karneRow;
        if (!row || !idEq || row.source_id !== idEq.val) return { data: [], error: null };
        return { data: [row], error: null };
      },
      api_keys: () => ({ data: [], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
    },
    rpc: {
      api_key_touch: (args) => {
        dbState.touchCalls += 1;
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

vi.mock("next/cache", () => ({ cacheLife: vi.fn(), cacheTag: vi.fn() }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.115.${1 + (ipCounter % 250)}`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  dbState.sourcesSelects = [];
  dbState.karneSelects = [];
  dbState.sourcesQueries = 0;
  dbState.karneRow = karneRow();
  dbState.karneError = null;
  dbState.touchCalls = 0;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function req(slug: string, key?: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request(`http://example.com/api/v1/sources/${slug}/profile`, { headers });
}

function ctx(slug: string) {
  return { params: Promise.resolve({ slug }) };
}

async function get(slug: string, key: string | null = FREE_KEY) {
  const { GET } = await import("@/app/api/v1/sources/[slug]/profile/route");
  return GET(req(slug, key ?? undefined), ctx(slug));
}

const REGISTRY_RECORD_KEYS = [
  "slug", "name", "url", "bias", "bias_label", "zone", "zone_label", "kind",
  "owner_group", "owner_group_label", "factuality", "trustee_since",
  "trustee_note", "rationale", "rationale_at", "active",
].sort();

const PROFILE_KEYS = [
  "window_days", "window_start", "window_end", "computed_at", "n_clusters",
  "min_clusters", "sufficient", "n_multi", "n_solo", "min_multi_for_zones",
  "co_covering_zones", "public_blindspot_appearances", "public_blindspot_same_side",
].sort();

describe("GET /api/v1/sources/{slug}/profile", () => {
  it("401 without a key", async () => {
    const res = await get("sabah", null);
    expect(res.status).toBe(401);
  });

  it("400 for a malformed or 65-char slug and never queries sources", async () => {
    for (const slug of ["Bad_Slug!", "a".repeat(65)]) {
      const res = await get(slug);
      expect(res.status).toBe(400);
      expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    }
    expect(dbState.sourcesQueries).toBe(0);
  });

  it("404 for an unknown slug and for an inactive source", async () => {
    expect((await get("nope")).status).toBe(404);
    expect((await get("retired-outlet")).status).toBe(404);
  });

  it("200 happy path: registry record without id/rss_url, exactly 13 profile keys", async () => {
    const res = await get("sabah");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    const body = await res.json();
    expect(Object.keys(body.source).sort()).toEqual(REGISTRY_RECORD_KEYS);
    expect(body.source).not.toHaveProperty("id");
    expect(body.source).not.toHaveProperty("rss_url");
    expect(Object.keys(body.profile).sort()).toEqual(PROFILE_KEYS);
    expect(body.profile.n_clusters).toBe(40);
    expect(body.profile.min_clusters).toBe(20);
    expect(body.profile.sufficient).toBe(true);
    expect(body.profile.n_multi).toBe(25);
    expect(body.profile.n_solo).toBe(15);
    expect(body.profile.min_multi_for_zones).toBe(10);
    expect(body.profile.co_covering_zones).toEqual({ iktidar: 10, bagimsiz: 5, muhalefet: 20 });
    expect(body.profile.public_blindspot_appearances).toBe(3);
    expect(body.profile.public_blindspot_same_side).toBe(1);
    expect(body.profile.window_days).toBe(30);
  });

  it("insufficient (n_clusters 12): only window fields and n_clusters, gated fields null", async () => {
    dbState.karneRow = karneRow({
      n_clusters: 12, n_multi: 5, co_iktidar: 1, co_bagimsiz: 1, co_muhalefet: 1,
    });
    const body = await (await get("sabah")).json();
    expect(body.profile.sufficient).toBe(false);
    expect(body.profile.n_clusters).toBe(12);
    expect(body.profile.n_multi).toBeNull();
    expect(body.profile.n_solo).toBeNull();
    expect(body.profile.co_covering_zones).toBeNull();
    expect(body.profile.public_blindspot_appearances).toBeNull();
    expect(body.profile.public_blindspot_same_side).toBeNull();
    expect(Object.keys(body.profile).sort()).toEqual(PROFILE_KEYS);
  });

  it("n_multi below 10 with enough clusters: only co_covering_zones is null", async () => {
    dbState.karneRow = karneRow({
      n_clusters: 30, n_multi: 7, co_iktidar: 3, co_bagimsiz: 2, co_muhalefet: 4,
    });
    const body = await (await get("sabah")).json();
    expect(body.profile.sufficient).toBe(true);
    expect(body.profile.co_covering_zones).toBeNull();
    expect(body.profile.n_multi).toBe(7);
    expect(body.profile.n_solo).toBe(23);
    expect(body.profile.public_blindspot_appearances).toBe(3);
    expect(body.profile.public_blindspot_same_side).toBe(1);
  });

  it("200 with profile null when there is no karne row", async () => {
    dbState.karneRow = null;
    const res = await get("sabah");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.profile).toBeNull();
    expect(body.source.slug).toBe("sabah");
  });

  it("profile null for an invalid row (n_multi > n_clusters)", async () => {
    dbState.karneRow = karneRow({ n_clusters: 30, n_multi: 31 });
    const res = await get("sabah");
    expect(res.status).toBe(200);
    expect((await res.json()).profile).toBeNull();
  });

  it("500 when the karne query errors", async () => {
    dbState.karneError = { message: "boom" };
    const res = await get("sabah");
    expect(res.status).toBe(500);
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
  });

  it("selects explicit columns only and leaks no clickbait/title_version data", async () => {
    const res = await get("sabah");
    const text = await res.text();
    for (const sel of [...dbState.sourcesSelects, ...dbState.karneSelects]) {
      expect(typeof sel).toBe("string");
      expect(sel).not.toContain("*");
      expect(sel).not.toContain("rss_url");
      expect(sel).not.toContain("clickbait");
    }
    expect(dbState.sourcesSelects).toHaveLength(1);
    expect(dbState.karneSelects).toHaveLength(1);
    expect(text).not.toContain("clickbait");
    expect(text).not.toContain("title_version");
  });

  it("meters exactly once per GET (api_key_touch)", async () => {
    await get("sabah");
    expect(dbState.touchCalls).toBe(1);
  });

  it("OPTIONS returns 204", async () => {
    const { OPTIONS } = await import("@/app/api/v1/sources/[slug]/profile/route");
    const res = await OPTIONS(req("sabah"), ctx("sabah"));
    expect(res.status).toBe(204);
  });
});
