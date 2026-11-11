import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// h128-apiv1-4: `topic7` is read in the SAME query as the record. It used to
// come from a second `select id, topic7 ... in(ids)` that returned an empty map
// on any error, so a failed second read nulled topic7 on a 200 and a consumer
// could not tell "degraded" from "no topic assigned". Now the main select asks
// for it: a failed read is the main query's own 503, and a null is a real null.
// ---------------------------------------------------------------------------

const KEY = `tayf_${"8".repeat(40)}`;
const KEY_HASH = crypto.createHash("sha256").update(KEY).digest("hex");

const C1 = "c1111111-1111-4111-8111-111111111111";
const C2 = "c2222222-2222-4222-8222-222222222222";
const C3 = "c3333333-3333-4333-8333-333333333333";
const C4 = "c4444444-4444-4444-8444-444444444444";

const RECENT = new Date().toISOString();

/** `topic7: undefined` leaves the key off the row (a fixture from before the column was selected). */
function row(id: string, topic7: string | null | undefined) {
  return {
    id,
    title_tr: `t-${id}`,
    title_tr_neutral: null,
    bias_distribution: { pro_government: 1, opposition: 1 },
    is_blindspot: false,
    blindspot_side: null,
    article_count: 2,
    first_published: RECENT,
    updated_at: RECENT,
    is_archived: false,
    ...(topic7 === undefined ? {} : { topic7 }),
    cluster_articles: [
      { articles: { category: "politika", sources: { slug: "sabah", bias: "pro_government" } } },
      { articles: { category: "son_dakika", sources: { slug: "birgun", bias: "opposition" } } },
    ],
  };
}

const dbState = vi.hoisted(() => ({
  rows: [] as Array<Record<string, unknown>>,
  /** The `select` string of every clusters read, in call order. */
  selects: [] as string[],
  error: null as { code?: string; message: string } | null,
  errorStatus: 500,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        dbState.selects.push(String(state.selectArgs[0] ?? ""));
        if (dbState.error) {
          return { data: null, error: dbState.error, status: dbState.errorStatus };
        }
        const idEq = state.eq.find((e) => e.col === "id");
        const rows = idEq ? dbState.rows.filter((r) => r.id === idEq.val) : dbState.rows;
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

vi.mock("@supabase/supabase-js", () => ({ createClient: () => supabaseFake.client }));

vi.mock("@/lib/sentry/server", () => ({ captureServerException: vi.fn() }));

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
  dbState.rows = [];
  dbState.selects = [];
  dbState.error = null;
  dbState.errorStatus = 500;
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "NEXT_PUBLIC_SITE_URL"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function request(pathname: string): Request {
  ipCounter += 1;
  return new Request(`http://example.com${pathname}`, {
    headers: {
      "x-forwarded-for": `198.51.100.${ipCounter % 250}.${ipCounter}`,
      authorization: `Bearer ${KEY}`,
    },
  });
}

async function getList() {
  const { GET } = await import("@/app/api/v1/clusters/route");
  return GET(request("/api/v1/clusters"));
}

async function getOne(id: string) {
  const { GET } = await import("@/app/api/v1/clusters/[id]/route");
  return GET(request(`/api/v1/clusters/${id}`), { params: Promise.resolve({ id }) });
}

describe("GET /api/v1/clusters: topic7 comes from the main read", () => {
  it("copies the stored topic7 onto each record, null and absent alike giving null", async () => {
    dbState.rows = [row(C1, "ekonomi"), row(C2, null), row(C3, "spor"), row(C4, undefined)];

    const res = await getList();

    expect(res.status).toBe(200);
    const body = await res.json();
    const byId = new Map<string, { topic7: string | null }>(
      body.clusters.map((c: { id: string; topic7: string | null }) => [c.id, c]),
    );
    expect(byId.get(C1)?.topic7).toBe("ekonomi");
    expect(byId.get(C2)?.topic7).toBeNull();
    expect(byId.get(C3)?.topic7).toBe("spor");
    expect(byId.get(C4)?.topic7).toBeNull();
    for (const c of body.clusters) expect("topic7" in c).toBe(true);
  });

  it("reads clusters exactly once: topic7 rides in the one select, no second `id, topic7` probe", async () => {
    dbState.rows = [row(C1, "ekonomi"), row(C2, "politika")];

    await getList();

    expect(dbState.selects).toHaveLength(1);
    expect(dbState.selects[0]).toMatch(/\btopic7\b/);
    expect(dbState.selects).not.toContain("id, topic7");
    expect(dbState.selects.some((s) => /^id,\s*topic7$/.test(s.trim()))).toBe(false);
  });

  it("a main-query 57014 is the stable 503 (there is no second read left to swallow it)", async () => {
    dbState.error = { code: "57014", message: "canceling statement SECRET_NAME" };

    const res = await getList();

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    const text = await res.text();
    expect(text).toContain("upstream_unavailable");
    expect(text).not.toContain("SECRET_NAME");
    expect(dbState.selects).toHaveLength(1);
  });
});

describe("GET /api/v1/clusters/[id]: topic7 comes from the main read", () => {
  it("returns the stored topic7 from one clusters read", async () => {
    dbState.rows = [row(C1, "ekonomi")];

    const res = await getOne(C1);

    expect(res.status).toBe(200);
    expect((await res.json()).cluster.topic7).toBe("ekonomi");
    expect(dbState.selects).toHaveLength(1);
    expect(dbState.selects[0]).toMatch(/\btopic7\b/);
    expect(dbState.selects).not.toContain("id, topic7");
  });

  it("an unassigned cluster is topic7 null on the same 200", async () => {
    dbState.rows = [row(C2, null)];

    const res = await getOne(C2);

    expect(res.status).toBe(200);
    expect((await res.json()).cluster.topic7).toBeNull();
  });

  it("a main-query 57014 is the stable 503", async () => {
    dbState.error = { code: "57014", message: "canceling statement SECRET_NAME" };

    const res = await getOne(C1);

    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(await res.text()).not.toContain("SECRET_NAME");
  });
});

describe("v1-clusters module: the topic7 contract", () => {
  it("V1_CLUSTER_SELECT asks for topic7 on the cluster row, outside the member embed", async () => {
    const { V1_CLUSTER_SELECT } = await import("@/lib/api/v1-clusters");
    const clusterColumns = V1_CLUSTER_SELECT.split("cluster_articles")[0] as string;
    expect(clusterColumns).toMatch(/\btopic7\b/);
  });

  it("toV1ClusterRecord reads topic7 off the row (and null when the row has none)", async () => {
    const { toV1ClusterRecord } = await import("@/lib/api/v1-clusters");
    const base = row(C1, undefined) as unknown as Parameters<typeof toV1ClusterRecord>[0];
    expect(toV1ClusterRecord({ ...base, topic7: "dunya" }).topic7).toBe("dunya");
    expect(toV1ClusterRecord({ ...base, topic7: null }).topic7).toBeNull();
    expect(toV1ClusterRecord(base).topic7).toBeNull();
  });

  it("the second-read helper and its process-wide latch are gone", async () => {
    const mod = (await import("@/lib/api/v1-clusters")) as Record<string, unknown>;
    expect(mod.fetchTopic7).toBeUndefined();
  });

  it("V1_TOPIC7_VALUES is the production check constraint (migration 067): the six hubs plus politika", async () => {
    const { V1_TOPIC7_VALUES } = await import("@/lib/api/v1-clusters");
    const sql = readFileSync(
      path.join(process.cwd(), "supabase/migrations/067_cluster_topics.sql"),
      "utf8",
    );
    const list = /or topic7 in \(([^)]*)\)/.exec(sql)?.[1] ?? "";
    const inConstraint = list.split(",").map((v) => v.trim().replace(/'/g, "")).filter(Boolean);
    expect(inConstraint).toHaveLength(7);
    expect([...V1_TOPIC7_VALUES].sort()).toEqual([...inConstraint].sort());
  });
});
