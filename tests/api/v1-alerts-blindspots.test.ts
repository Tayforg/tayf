import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// GET /api/v1/alerts/blindspots — keyed alert feed (JSON + RSS).
// getBlindspots and getZoneFeedHealth are mocked; api_key_touch is driven by a
// tiny in-memory key table (same harness as tests/api/v1-sources.test.ts). The
// silent-candidate `clusters` fixture applies the recorded .eq/.lte filters so
// the veto and the 6h-age exclusion are exercised end to end.
// ---------------------------------------------------------------------------

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

const KEY = `tayf_${"a".repeat(40)}`;
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600 * 1000;

interface Row {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  bias_distribution: unknown;
  article_count: number;
  first_published: string;
  updated_at: string;
  is_archived: boolean;
  is_blindspot: boolean;
  blindspot_recall_veto: boolean;
}

const mk = (id: string, over: Partial<Row> = {}): Row => ({
  id,
  title_tr: `Başlık ${id}`,
  title_tr_neutral: null,
  bias_distribution: { pro_government: 3, center: 2 },
  article_count: 5,
  first_published: iso(10 * H),
  updated_at: iso(1 * H),
  is_archived: false,
  is_blindspot: false,
  blindspot_recall_veto: false,
  ...over,
});

const db = vi.hoisted(() => ({
  rows: [] as unknown[],
  lastState: null as unknown,
  bundles: [] as unknown[],
  health: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        db.lastState = state;
        let rows = db.rows as Row[];
        for (const e of state.eq) rows = rows.filter((r) => (r as unknown as Record<string, unknown>)[e.col] === e.val);
        for (const l of state.lte) rows = rows.filter((r) => String((r as unknown as Record<string, unknown>)[l.col]) <= String(l.val));
        for (const g of state.gte) {
          if (g.col === "updated_at") rows = rows.filter((r) => r.updated_at >= String(g.val));
        }
        return { data: rows, error: null };
      },
      api_keys: () => ({ data: [], error: null }),
      api_key_usage_daily: () => ({ data: [{ calls: 0 }], error: null }),
    },
    rpc: {
      api_key_touch: (args) => {
        const { p_key_hash } = args as { p_key_hash: string };
        return p_key_hash === sha256(KEY)
          ? { data: [{ key_id: 901, tier: "free" }], error: null }
          : { data: [], error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({ createClient: () => supabaseFake.client }));
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});
vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: async () => ({ bundles: db.bundles }),
}));
vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return { ...actual, getZoneFeedHealth: async () => db.health };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
const nextIp = () => `203.0.116.${1 + (++ipCounter % 250)}`;

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  db.rows = [];
  db.bundles = [];
  db.health = null;
  db.lastState = null;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function req(qs = "", opts: { key?: string | null; accept?: string } = {}): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  const key = opts.key === undefined ? KEY : opts.key;
  if (key) headers.authorization = `Bearer ${key}`;
  if (opts.accept) headers.accept = opts.accept;
  return new Request(`http://example.com/api/v1/alerts/blindspots${qs}`, { headers });
}

function bundle(id: string, updatedAgo = 2 * H) {
  return {
    cluster: {
      id,
      title_tr: `Kör nokta ${id}`,
      title_tr_neutral: null,
      bias_distribution: { pro_government: 5, center: 1 },
      first_published: iso(30 * H),
      updated_at: iso(updatedAgo),
    },
    dominantZone: "iktidar",
  };
}

async function get(r: Request) {
  const { GET } = await import("@/app/api/v1/alerts/blindspots/route");
  return GET(r);
}

describe("GET /api/v1/alerts/blindspots", () => {
  it("401 without a key, with the v1 CORS headers", async () => {
    const res = await get(req("", { key: null }));
    expect(res.status).toBe(401);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("returns the JSON envelope and record fields", async () => {
    db.bundles = [bundle("b1")];
    db.rows = [mk("s1")];
    const res = await get(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^application\/json/);
    expect(res.headers.get("X-Tayf-Tier")).toBe("free");
    const body = await res.json();
    expect(body.licence).toBeTruthy();
    expect(body.attribution).toBeTruthy();
    expect(typeof body.since).toBe("string");
    expect(body.count).toBe(2);
    const ids = body.alerts.map((a: { id: string }) => a.id).sort();
    expect(ids).toEqual(["blindspot:b1", "one_zone_silent:s1"]);
    const silent = body.alerts.find((a: { type: string }) => a.type === "one_zone_silent");
    expect(Object.keys(silent).sort()).toEqual(
      [
        "id", "type", "cluster_id", "title", "url", "first_published", "updated_at",
        "source_count", "zone_counts", "dominant_zone", "silent_zones",
      ].sort(),
    );
    expect(silent).toMatchObject({
      cluster_id: "s1",
      source_count: 5,
      dominant_zone: null,
      silent_zones: ["muhalefet"],
      zone_counts: { iktidar: 3, bagimsiz: 2, muhalefet: 0 },
    });
    expect(silent.url).toMatch(/\/cluster\/s1$/);
  });

  it("serves RSS for ?format=rss with the content type and Vary", async () => {
    db.bundles = [bundle("b1")];
    const res = await get(req("?format=rss"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    expect(res.headers.get("Vary")).toBe("Origin, Authorization, Accept");
    const xml = await res.text();
    expect(xml).toContain("<rss");
    expect(xml).toContain("Kör nokta · İktidar ağırlıklı: Kör nokta b1");
  });

  it("negotiates RSS from Accept when format is absent, JSON when format=json", async () => {
    db.bundles = [bundle("b1")];
    const viaAccept = await get(req("", { accept: "application/rss+xml" }));
    expect(viaAccept.headers.get("Content-Type")).toBe("application/rss+xml; charset=utf-8");
    const forcedJson = await get(req("?format=json", { accept: "application/rss+xml" }));
    expect(forcedJson.headers.get("Content-Type")).toMatch(/^application\/json/);
    const plain = await get(req("", { accept: "text/html,*/*" }));
    expect(plain.headers.get("Content-Type")).toMatch(/^application\/json/);
  });

  it("400 Invalid format for format=xml, through the v1 headers", async () => {
    const res = await get(req("?format=xml"));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Invalid format");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("400 for a bad since and a bad limit", async () => {
    expect((await get(req("?since=yesterday"))).status).toBe(400);
    expect((await get(req("?limit=0"))).status).toBe(400);
  });

  it("never emits a vetoed row and records eq('blindspot_recall_veto', false)", async () => {
    db.rows = [mk("ok"), mk("vetoed", { blindspot_recall_veto: true })];
    const res = await get(req());
    const body = await res.json();
    expect(body.alerts.map((a: { cluster_id: string }) => a.cluster_id)).toEqual(["ok"]);
    const st = db.lastState as { eq: Array<{ col: string; val: unknown }> };
    expect(st.eq).toContainEqual({ col: "blindspot_recall_veto", val: false });
  });

  it("drops a silent item whose silent zone feeds are degraded", async () => {
    db.rows = [mk("s1")];
    const z = (d: boolean) => ({ total: 9, fetchOk: 9, fetchOkShare: 1, delivering: 9, deliveringShare: 1, healthy: 9, healthyShare: 1, degraded: d });
    db.health = { iktidar: z(false), bagimsiz: z(false), muhalefet: z(true) };
    const body = await (await get(req())).json();
    expect(body.count).toBe(0);
  });

  it("excludes an item younger than 6h through the lte filter", async () => {
    db.rows = [mk("young", { first_published: iso(2 * H) }), mk("aged", { first_published: iso(7 * H) })];
    const body = await (await get(req())).json();
    expect(body.alerts.map((a: { cluster_id: string }) => a.cluster_id)).toEqual(["aged"]);
    const st = db.lastState as { lte: Array<{ col: string; val: string }> };
    expect(st.lte[0]!.col).toBe("first_published");
    const cutoff = Date.parse(st.lte[0]!.val);
    expect(Math.abs(cutoff - (Date.now() - 6 * H))).toBeLessThan(60_000);
  });

  it("never contains accusatory silence wording in JSON or RSS", async () => {
    db.bundles = [bundle("b1")];
    db.rows = [mk("s1")];
    const json = await (await get(req())).text();
    const rss = await (await get(req("?format=rss"))).text();
    for (const text of [json, rss]) expect(text).not.toMatch(/yazmadı|görmezden/i);
  });

  it("respects limit", async () => {
    db.rows = [mk("a"), mk("b"), mk("c")].map((r, i) => ({ ...r, updated_at: iso((i + 1) * H) }));
    const body = await (await get(req("?limit=2"))).json();
    expect(body.count).toBe(2);
    expect(body.alerts.map((a: { cluster_id: string }) => a.cluster_id)).toEqual(["a", "b"]);
  });

  it("has no ?key= parameter: a key in the query string does not authenticate", async () => {
    const res = await get(req(`?key=${KEY}`, { key: null }));
    expect(res.status).toBe(401);
  });

  it("OPTIONS returns 204", async () => {
    const { OPTIONS } = await import("@/app/api/v1/alerts/blindspots/route");
    const res = await OPTIONS();
    expect(res.status).toBe(204);
  });
});
