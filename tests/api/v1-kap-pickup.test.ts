import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for GET /api/v1/kap/pickup — the keyed mirror of the
// "Medyada yankı" panel on /ekonomi/[ticker]. Reuses the auth-harness shape
// from tests/api/v1-sources.test.ts (small in-memory keysDb driving
// api_key_touch). The sha256 hash is computed lazily, INSIDE the rpc
// handler (a dynamic `await import("node:crypto")`, at call time, not at
// vi.hoisted() factory-build time) — a static top-level `import crypto`
// gets transformed to a `__vi_import_*__` binding that is still in its
// temporal dead zone when a `vi.hoisted()` factory runs (verified: this
// blew up with "Cannot access '__vi_import_0__' before initialization"
// before this file switched to the dynamic form).
const fixtures = vi.hoisted(() => {
  const freeKey = `tayf_${"7".repeat(40)}`;
  const HOUR = 3_600_000;
  const DAY = 86_400_000;
  const disclosedAtMs = Date.now() - 2 * DAY;
  const kapDisclosureRows = [
    {
      disclosure_index: 4242,
      published_at: new Date(disclosedAtMs).toISOString(),
      subject: "Genel Kurul Toplantısı",
      disclosure_class: "ODA",
    },
  ];

  // a1: relevant, voting outlet -> counted. a2: scored below 0.2 -> excluded.
  const articleTickerRows = [
    {
      article_id: "a1",
      published_at: new Date(disclosedAtMs + HOUR).toISOString(),
      created_at: new Date(disclosedAtMs + HOUR).toISOString(),
      source_id: "src-1",
    },
    {
      article_id: "a2",
      published_at: new Date(disclosedAtMs + 2 * HOUR).toISOString(),
      created_at: new Date(disclosedAtMs + 2 * HOUR).toISOString(),
      source_id: "src-1",
    },
  ];

  const relevanceRows = [{ subject_id: "a2:THYAO", jev_prob: "0.100" }];
  const sourceRows = [{ id: "src-1", slug: "sabah", bias: "pro_government", kind: "outlet" }];

  return { kapDisclosureRows, articleTickerRows, relevanceRows, sourceRows, freeKey };
});

const FREE_KEY = fixtures.freeKey;
const DAY = 86_400_000;

const SECRET_TITLE = "Bu başlık asla API yanıtında görünmemeli";
const SECRET_URL = "https://example-secret-outlet.test/gizli-haber";

const fakeState = vi.hoisted(() => ({ lastDisclosureState: null as unknown }));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      kap_disclosures: (state) => {
        fakeState.lastDisclosureState = state;
        return { data: fixtures.kapDisclosureRows, error: null };
      },
      article_tickers: () => ({ data: fixtures.articleTickerRows, error: null }),
      jev_shadow_predictions: () => ({ data: fixtures.relevanceRows, error: null }),
      sources: () => ({ data: fixtures.sourceRows, error: null }),
      api_keys: () => ({ data: [], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
    },
    rpc: {
      api_key_touch: async (args) => {
        const { createHash } = await import("node:crypto");
        const { p_key_hash } = args as { p_key_hash: string };
        const expectedHash = createHash("sha256").update(fixtures.freeKey).digest("hex");
        if (p_key_hash !== expectedHash) return { data: [], error: null };
        return { data: [{ key_id: 777, tier: "free" }], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.115.${1 + (ipCounter % 250)}`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  fakeState.lastDisclosureState = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
});

function req(qs: string, key?: string): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (key) headers.authorization = `Bearer ${key}`;
  return new Request(`http://example.com/api/v1/kap/pickup${qs}`, { headers });
}

const TOP_LEVEL_KEYS = [
  "licence",
  "attribution",
  "methodology",
  "generated_at",
  "ticker",
  "window_hours",
  "since",
  "until",
  "relevance_filter",
  "truncated",
  "totals",
  "count",
  "disclosures",
].sort();

const DISCLOSURE_KEYS = [
  "disclosure_index",
  "disclosed_at",
  "subject",
  "disclosure_class",
  "kap_url",
  "articles",
  "outlets",
  "first_lag_minutes",
  "zones",
  "sources",
  "window_complete",
  "overlapping_disclosures",
].sort();

describe("GET /api/v1/kap/pickup", () => {
  it("401 without a key", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req("?ticker=THYAO"));
    expect(res.status).toBe(401);
  });

  it("400 for a missing ticker", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req("", FREE_KEY));
    expect(res.status).toBe(400);
  });

  it("400 for a malformed ticker ('THY-AO')", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req("?ticker=THY-AO", FREE_KEY));
    expect(res.status).toBe(400);
  });

  it("400 for an injection-shaped ticker ('<script>')", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req(`?ticker=${encodeURIComponent("<script>")}`, FREE_KEY));
    expect(res.status).toBe(400);
  });

  it("400 for a future since", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const future = new Date(Date.now() + DAY).toISOString();
    const res = await GET(req(`?ticker=THYAO&since=${encodeURIComponent(future)}`, FREE_KEY));
    expect(res.status).toBe(400);
  });

  it("clamps a since 200 days ago to now - 90d (kap_disclosures gte >= now - 90d - 1s)", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const longAgo = new Date(Date.now() - 200 * DAY).toISOString();
    const res = await GET(req(`?ticker=THYAO&since=${encodeURIComponent(longAgo)}`, FREE_KEY));
    expect(res.status).toBe(200);

    const state = fakeState.lastDisclosureState as { gte: Array<{ col: string; val: string }> };
    const gte = state.gte.find((g) => g.col === "published_at");
    expect(gte).toBeDefined();
    const gteMs = new Date(gte!.val).getTime();
    const floorMs = Date.now() - 90 * DAY;
    expect(gteMs).toBeGreaterThanOrEqual(floorMs - 1000);
    expect(gteMs).toBeLessThanOrEqual(floorMs + 5000);
  });

  it("200 with exactly the wire-shape keys at top level and per disclosure", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req("?ticker=THYAO", FREE_KEY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(TOP_LEVEL_KEYS);
    expect(body.disclosures.length).toBeGreaterThan(0);
    for (const d of body.disclosures) {
      expect(Object.keys(d).sort()).toEqual(DISCLOSURE_KEYS);
    }
  });

  it("never leaks the fixture article's title or URL in the JSON body", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req("?ticker=THYAO", FREE_KEY));
    const text = await res.text();
    expect(text).not.toContain(SECRET_TITLE);
    expect(text).not.toContain(SECRET_URL);
    expect(text).not.toContain("a1");
    expect(text).not.toContain("a2");
  });

  it("calls the api_key_touch RPC exactly once per request", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    let touchCalls = 0;
    const originalRpc = supabaseFake.client.rpc;
    supabaseFake.client.rpc = async (name: string, args?: unknown) => {
      if (name === "api_key_touch") touchCalls += 1;
      return originalRpc(name, args);
    };
    await GET(req("?ticker=THYAO", FREE_KEY));
    expect(touchCalls).toBe(1);
    supabaseFake.client.rpc = originalRpc;
  });

  it("OPTIONS returns 204 with CORS headers", async () => {
    const { OPTIONS } = await import("@/app/api/v1/kap/pickup/route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });

  it("excludes a relevance-filtered mention (score < 0.2) from the counts", async () => {
    const { GET } = await import("@/app/api/v1/kap/pickup/route");
    const res = await GET(req("?ticker=THYAO", FREE_KEY));
    const body = await res.json();
    const disclosure = body.disclosures[0];
    // Fixture: a1 relevant (kept), a2 scored 0.10 (dropped) -> articles === 1.
    expect(disclosure.articles).toBe(1);
  });
});
