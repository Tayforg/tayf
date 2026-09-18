import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for the public, attribution-licensed registry JSON:
//   GET /api/sources
//   GET /api/sources/[slug]
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// per tests/api/corrections.test.ts / tests/api/admin-corrections.test.ts
// convention. `sources` and `source_zone_history` fixtures are functions
// over the builder's recorded predicate state so a route that forgets to
// filter (`.eq('active', true)`) or forgets to order/cap
// (`.order('changed_at', {ascending: false}).limit(50)`) fails these tests
// for real, not just because a mock happened to be pre-filtered.
// ---------------------------------------------------------------------------

interface RawSourceRow {
  id: string;
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
}

// haberturk / tele1 are hand-tagged in src/lib/sources/factuality.ts
// (ownerGroup + factuality both non-null) so they exercise the "tagged"
// branch of toRegistryRecord; 'niche-blog' is deliberately NOT a key in
// SOURCE_METADATA so it exercises the "explicit null, never omitted"
// branch the brief calls out.
const RAW_SOURCES: RawSourceRow[] = [
  {
    id: "src-1",
    slug: "haberturk",
    name: "Habertürk",
    url: "https://www.haberturk.com",
    bias: "gov_leaning",
    kind: "outlet",
    active: true,
    zone_rationale: "Ciner Medya çatısı altında hükümete meyilli yayın.",
    zone_rationale_at: "2026-01-05T10:00:00.000Z",
    trustee_since: "2025-09-11",
    trustee_note: "TMSF kayyum atandı (Can Holding), 11.09.2025",
  },
  {
    id: "src-2",
    slug: "tele1",
    name: "Tele1",
    url: "https://www.tele1.com.tr",
    bias: "opposition_leaning",
    kind: "outlet",
    active: true,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: "2025-10-24",
    trustee_note: "TMSF kayyum atandı, 24.10.2025",
  },
  {
    id: "src-3",
    slug: "niche-blog",
    name: "Niche Blog",
    url: "https://example.com/niche",
    bias: "center",
    kind: "niche",
    active: true,
    zone_rationale: null,
    zone_rationale_at: null,
    trustee_since: null,
    trustee_note: null,
  },
  {
    id: "src-4",
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
  },
];

const ACTIVE_SLUGS = RAW_SOURCES.filter((r) => r.active).map((r) => r.slug);

interface RawHistoryRow {
  id: string;
  source_id: string;
  old_bias: string | null;
  new_bias: string;
  reason: string | null;
  rater: string | null;
  changed_at: string;
}

// 60 rows for 'src-1' so the "cap at 50" assertion is meaningful, plus a
// couple of null-reason/null-rater rows (a change made outside the RPC —
// e.g. the pre-existing update_source action or raw SQL — must still show
// up, honestly, as unexplained).
const RAW_HISTORY: RawHistoryRow[] = Array.from({ length: 60 }, (_, i) => ({
  id: `hist-${i}`,
  source_id: "src-1",
  old_bias: i === 0 ? null : "center",
  new_bias: i % 7 === 0 ? null : "gov_leaning",
  reason: i % 5 === 0 ? null : `Reason for change #${i}`,
  rater: i % 5 === 0 ? null : "editör",
  // Later index = later (more recent) timestamp.
  changed_at: new Date(2026, 0, 1, 0, i).toISOString(),
})).map((r) => ({ ...r, new_bias: r.new_bias ?? "gov_leaning" }));

const dbState = vi.hoisted(() => ({
  forceListError: false,
  lastSourcesSelectArgs: [] as unknown[],
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      sources: (state) => {
        dbState.lastSourcesSelectArgs = state.selectArgs;
        if (dbState.forceListError) {
          return { data: null, error: { message: "boom" } };
        }
        const activeEq = state.eq.find((e) => e.col === "active");
        const slugEq = state.eq.find((e) => e.col === "slug");
        let rows = RAW_SOURCES;
        if (activeEq) rows = rows.filter((r) => r.active === activeEq.val);
        if (slugEq) rows = rows.filter((r) => r.slug === slugEq.val);
        return { data: rows, error: null };
      },
      source_zone_history: (state) => {
        const sourceIdEq = state.eq.find((e) => e.col === "source_id");
        let rows = RAW_HISTORY.filter(
          (r) => !sourceIdEq || r.source_id === sourceIdEq.val,
        );
        const orderedDesc = state.order.some(
          (o) =>
            o.col === "changed_at" &&
            (o.opts as { ascending?: boolean } | undefined)?.ascending ===
              false,
        );
        rows = [...rows].sort((a, b) =>
          orderedDesc
            ? b.changed_at.localeCompare(a.changed_at)
            : a.changed_at.localeCompare(b.changed_at),
        );
        if (state.limit != null) rows = rows.slice(0, state.limit);

        // Project down to exactly the columns the route selected, mirroring
        // real PostgREST — the shared supabase-fake helper records
        // `.select()` args but doesn't project fixture rows on its own, so
        // without this a route that forgets to narrow its select (or drops
        // a column it needs) would go undetected by a wire-shape assertion.
        const selectStr =
          typeof state.selectArgs[0] === "string" ? state.selectArgs[0] : "";
        const columns = selectStr
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        const projected =
          columns.length > 0
            ? rows.map((r) => {
                const out: Record<string, unknown> = {};
                for (const col of columns) {
                  out[col] = (r as unknown as Record<string, unknown>)[col];
                }
                return out;
              })
            : rows;

        return { data: projected, error: null };
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

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  dbState.forceListError = false;
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

function listRequest(ip = "203.0.113.20"): Request {
  return new Request("http://example.com/api/sources", {
    headers: { "x-forwarded-for": ip },
  });
}

function detailRequest(slug: string, ip = "203.0.113.20"): Request {
  return new Request(`http://example.com/api/sources/${slug}`, {
    headers: { "x-forwarded-for": ip },
  });
}

function paramsFor(slug: string) {
  return { params: Promise.resolve({ slug }) };
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

const LIST_CACHE_CONTROL =
  "public, s-maxage=3600, stale-while-revalidate=86400";
// Detail route's stale-while-revalidate is capped lower than the list
// route's — a retraction (rationale/bias correction) published through the
// admin dispute path must not be servable from a stale CDN copy for up to
// a day. s-maxage=3600 matches the list route (pack's acceptance criteria).
const DETAIL_CACHE_CONTROL =
  "public, s-maxage=3600, stale-while-revalidate=300";

describe("GET /api/sources", () => {
  it("returns the registry envelope with licence, attribution and generated_at", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const { REGISTRY_LICENCE } = await import("@/lib/sources/registry");
    const res = await GET(listRequest());
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.licence).toBe(REGISTRY_LICENCE);
    expect(REGISTRY_LICENCE).toBe("CC BY-SA 4.0 — Tayf'a göre");
    expect(typeof body.attribution).toBe("string");
    expect(body.attribution.length).toBeGreaterThan(0);
    expect(typeof body.generated_at).toBe("string");
    expect(new Date(body.generated_at).toString()).not.toBe("Invalid Date");
  });

  it("returns only active sources", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    const body = await res.json();

    expect(body.count).toBe(ACTIVE_SLUGS.length);
    const slugs = body.sources.map((s: { slug: string }) => s.slug).sort();
    expect(slugs).toEqual([...ACTIVE_SLUGS].sort());
    expect(slugs).not.toContain("retired-outlet");
  });

  it("gives every record all RegistryRecord keys, with explicit null (never omitted) for untagged fields", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    const body = await res.json();

    for (const record of body.sources) {
      expect(Object.keys(record).sort()).toEqual(REGISTRY_RECORD_KEYS);
    }

    const niche = body.sources.find(
      (s: { slug: string }) => s.slug === "niche-blog",
    );
    expect(niche).toBeTruthy();
    expect(niche.owner_group).toBeNull();
    expect(niche.owner_group_label).toBeNull();
    expect(niche.factuality).toBeNull();
    expect(niche.rationale).toBeNull();
    expect(niche.rationale_at).toBeNull();
    expect(niche.trustee_since).toBeNull();
    expect(niche.trustee_note).toBeNull();
    expect("owner_group" in niche).toBe(true);
    expect("rationale" in niche).toBe(true);
  });

  it("derives zone from bias via zoneOf (gov_leaning -> iktidar, opposition_leaning -> muhalefet)", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    const body = await res.json();

    const haberturk = body.sources.find(
      (s: { slug: string }) => s.slug === "haberturk",
    );
    const tele1 = body.sources.find(
      (s: { slug: string }) => s.slug === "tele1",
    );
    expect(haberturk.bias).toBe("gov_leaning");
    expect(haberturk.zone).toBe("iktidar");
    expect(tele1.bias).toBe("opposition_leaning");
    expect(tele1.zone).toBe("muhalefet");
  });

  it("tags a hand-classified source's owner_group/factuality and carries its rationale + trustee fields", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    const body = await res.json();

    const haberturk = body.sources.find(
      (s: { slug: string }) => s.slug === "haberturk",
    );
    expect(haberturk.owner_group).toBe("ciner");
    expect(typeof haberturk.owner_group_label).toBe("string");
    expect(haberturk.factuality).not.toBeNull();
    expect(haberturk.rationale).toBe(
      "Ciner Medya çatısı altında hükümete meyilli yayın.",
    );
    expect(haberturk.rationale_at).toBe("2026-01-05T10:00:00.000Z");
    expect(haberturk.trustee_since).toBe("2025-09-11");
    expect(haberturk.trustee_note).toBe(
      "TMSF kayyum atandı (Can Holding), 11.09.2025",
    );
  });

  it("sets Cache-Control: public, s-maxage=3600, stale-while-revalidate=86400", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    expect(res.headers.get("Cache-Control")).toBe(LIST_CACHE_CONTROL);
  });

  it("sets Content-Type: application/json; charset=utf-8", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    expect(res.headers.get("Content-Type")).toBe(
      "application/json; charset=utf-8",
    );
  });

  it("returns 500 (never a 200 with an empty list) when the Supabase query errors", async () => {
    dbState.forceListError = true;
    const { GET } = await import("@/app/api/sources/route");
    const res = await GET(listRequest());
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(Array.isArray(body.sources)).toBe(false);
  });

  // B-SEC-05: 60-token bucket, 1/sec refill, keyed on clientKey(request).
  it("returns 429 with the standard error envelope after 60 requests from the same client", async () => {
    const { GET } = await import("@/app/api/sources/route");
    const ip = "203.0.113.21";
    for (let i = 0; i < 60; i++) {
      const res = await GET(listRequest(ip));
      expect(res.status).toBe(200);
    }
    const res = await GET(listRequest(ip));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});

describe("GET /api/sources/[slug]", () => {
  it("returns 404 with the api/errors envelope for an unknown (but well-formed) slug", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("does-not-exist"), paramsFor("does-not-exist"));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });

  it("returns 400 for a malformed slug and never calls Supabase", async () => {
    const fromSpy = vi.spyOn(supabaseFake.client, "from");
    fromSpy.mockClear();
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(
      detailRequest("Not A Slug!"),
      paramsFor("Not A Slug!"),
    );
    expect(res.status).toBe(400);
    expect(fromSpy).not.toHaveBeenCalled();
    fromSpy.mockRestore();
  });

  it("returns the source + zone_history in the registry envelope for a known slug", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.source.slug).toBe("haberturk");
    expect(Object.keys(body.source).sort()).toEqual(REGISTRY_RECORD_KEYS);
    expect(typeof body.licence).toBe("string");
    expect(Array.isArray(body.zone_history)).toBe(true);
  });

  it("returns zone_history newest-first and capped at 50", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    const body = await res.json();

    expect(body.zone_history).toHaveLength(50);
    const timestamps = body.zone_history.map(
      (h: { changed_at: string }) => h.changed_at,
    );
    const sortedDesc = [...timestamps].sort((a, b) => b.localeCompare(a));
    expect(timestamps).toEqual(sortedDesc);
    // Newest raw row is index 59 (latest changed_at) — must be first. Note:
    // this asserts on `changed_at`, not `id` — the route's select
    // ("old_bias, new_bias, reason, rater, changed_at") never projects
    // `id`, so a real PostgREST response would give `undefined` there; the
    // fake only returned it because it doesn't project fixture rows.
    expect(body.zone_history[0].changed_at).toBe(RAW_HISTORY[59].changed_at);
  });

  it("pins the public zone_history wire shape to exactly the columns the route selects", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    const body = await res.json();

    expect(Object.keys(body.zone_history[0]).sort()).toEqual(
      ["changed_at", "new_bias", "old_bias", "rater", "reason"].sort(),
    );
  });

  it("selects sources by an explicit column allowlist — never 'rss_url' or '*'", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    await GET(detailRequest("haberturk"), paramsFor("haberturk"));

    const selectStr = dbState.lastSourcesSelectArgs[0];
    expect(typeof selectStr).toBe("string");
    expect(selectStr).not.toContain("rss_url");
    expect(selectStr).not.toContain("*");

    const columns = (selectStr as string).split(",").map((c) => c.trim()).sort();
    expect(columns).toEqual(
      [
        "id",
        "slug",
        "name",
        "url",
        "bias",
        "kind",
        "active",
        "zone_rationale",
        "zone_rationale_at",
        "trustee_since",
        "trustee_note",
      ].sort(),
    );
  });

  it("passes through a null reason/rater on zone_history rows honestly (never fabricated)", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    const body = await res.json();

    const nullReasonRow = body.zone_history.find(
      (h: { reason: string | null }) => h.reason === null,
    );
    expect(nullReasonRow).toBeTruthy();
    expect(nullReasonRow.rater).toBeNull();
  });

  it("sets Cache-Control: public, s-maxage=3600, stale-while-revalidate=300", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    expect(res.headers.get("Cache-Control")).toBe(DETAIL_CACHE_CONTROL);
  });

  it("returns 404 with a short public Cache-Control for a deactivated (retired) source", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(
      detailRequest("retired-outlet"),
      paramsFor("retired-outlet"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("Cache-Control")).toBe("public, s-maxage=300");
  });

  it("returns 500 when the Supabase query errors on the detail route", async () => {
    dbState.forceListError = true;
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const res = await GET(detailRequest("haberturk"), paramsFor("haberturk"));
    expect(res.status).toBe(500);
  });

  // B-SEC-05: same 60-token bucket / 1-per-second refill as the list route.
  it("returns 429 with the standard error envelope after 60 requests from the same client", async () => {
    const { GET } = await import("@/app/api/sources/[slug]/route");
    const ip = "203.0.113.22";
    for (let i = 0; i < 60; i++) {
      const res = await GET(detailRequest("haberturk", ip), paramsFor("haberturk"));
      expect(res.status).toBe(200);
    }
    const res = await GET(detailRequest("haberturk", ip), paramsFor("haberturk"));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.error).toBe("string");
  });
});
