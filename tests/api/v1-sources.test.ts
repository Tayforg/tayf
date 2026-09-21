import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Contract tests for GET /api/v1/sources — the keyed mirror of the free,
// unkeyed GET /api/sources. Reuses the auth harness shape from
// tests/api/v1-clusters.test.ts (small in-memory KEYS_DB driving
// api_key_touch) and the RAW_SOURCES fixture shape from
// tests/api/sources-json.test.ts.
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const FREE_KEY = `tayf_${"5".repeat(40)}`;
const KEYS_DB = [{ id: 555, hash: sha256(FREE_KEY), tier: "free", revoked: false }];

interface RawSourceRow {
  slug: string;
  name: string;
  url: string;
  bias: string;
  kind: string;
  active: boolean;
  zone_rationale: string | null;
  zone_rationale_at: string | null;
  trustee_since: string | null;
  trustee_note: string | null;
  rss_url: string; // must never be selected/returned — see the column-list test.
}

const RAW_SOURCES: RawSourceRow[] = [
  {
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

const dbState = vi.hoisted(() => ({ lastSelectArgs: [] as unknown[] }));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state) => {
        dbState.lastSelectArgs = state.selectArgs;
        const activeEq = state.eq.find((e) => e.col === "active");
        let rows = RAW_SOURCES;
        if (activeEq) rows = rows.filter((r) => r.active === activeEq.val);
        return { data: rows, error: null };
      },
      api_keys: () => ({ data: [], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
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
  return { ...actual, connection: async () => {} };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.114.${1 + (ipCounter % 250)}`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  dbState.lastSelectArgs = [];
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function sourcesRequest(key?: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request("http://example.com/api/v1/sources", { headers });
}

const REGISTRY_RECORD_KEYS = [
  "slug",
  "name",
  "url",
  "bias",
  "bias_label",
  "zone",
  "zone_label",
  "kind",
  "owner_group",
  "owner_group_label",
  "factuality",
  "trustee_since",
  "trustee_note",
  "rationale",
  "rationale_at",
  "active",
].sort();

describe("GET /api/v1/sources", () => {
  it("401 without a key and 200 with one, returning the same record keys as /api/sources", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");

    const unauth = await GET(sourcesRequest());
    expect(unauth.status).toBe(401);

    const res = await GET(sourcesRequest(FREE_KEY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.sources)).toBe(true);
    for (const record of body.sources) {
      expect(Object.keys(record).sort()).toEqual(REGISTRY_RECORD_KEYS);
    }
  });

  it("returns only active sources and selects an explicit column list, never '*' and never rss_url", async () => {
    const { GET } = await import("@/app/api/v1/sources/route");
    const res = await GET(sourcesRequest(FREE_KEY));
    const body = await res.json();

    const slugs = body.sources.map((s: { slug: string }) => s.slug);
    expect(slugs).toEqual(["sabah"]);
    expect(slugs).not.toContain("retired-outlet");

    const selectStr = dbState.lastSelectArgs[0];
    expect(typeof selectStr).toBe("string");
    expect(selectStr).not.toContain("*");
    expect(selectStr).not.toContain("rss_url");
  });
});
