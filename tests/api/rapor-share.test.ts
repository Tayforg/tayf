import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for pack E / B9 (migration 069):
//   POST /api/admin/rapor/share
//   POST /api/admin/rapor/revoke
//   GET  /rapor/[token]/markdown
//
// Harness combines tests/api/admin-corrections.test.ts's admin-session
// mock with tests/api/sources-json.test.ts's shared proxy-based Supabase
// fake. The `report_share_links` fixture is a function over the builder's
// recorded predicate state so a revoke that forgets `.is('revoked_at',
// null)` fails this suite for real. `/rapor/[token]/markdown` mocks
// `@/lib/reports/yelpaze` (per the W2 brief: this test is about the token
// gate and the headers, not report assembly, which yelpaze.test.ts already
// covers) but exercises the REAL `reportToMarkdown` + `resolveShareToken`.
// ---------------------------------------------------------------------------

const CLUSTER_ID = "11111111-2222-3333-4444-555555555555";
const UNKNOWN_CLUSTER_ID = "99999999-8888-7777-6666-555555555555";
const LIVE_TOKEN = "a".repeat(32);
const REVOKED_TOKEN = "b".repeat(32);
const UNKNOWN_TOKEN = "c".repeat(32);

function futureIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

function pastIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

const dbState = vi.hoisted(() => ({
  clusterRows: [] as Array<{ id: string }>,
  shareLinkRows: [] as Array<{
    token: string;
    cluster_id: string;
    revoked_at: string | null;
    expires_at: string;
  }>,
}));

// Not `vi.hoisted` — this fixture is only read inside `beforeEach` (via
// `buildYelpazeReportMock.mockResolvedValue(...)`), never inside a
// `vi.mock(...)` factory, so it doesn't need to run before CLUSTER_ID's
// declaration above.
const FIXTURE_REPORT = ({
  header: { clusterId: CLUSTER_ID, title: "Test başlık" },
  coverage: {
    rows: [
      {
        zone: "iktidar",
        outlets: 2,
        denominator: 5,
        share: 0.4,
        denominatorKnown: true,
        denominatorBelowOutlets: false,
      },
    ],
    denominatorBasis: "yield" as const,
  },
  framing: [],
  blindspot: {
    isBlindspot: false,
    blindspotSide: null,
    dominantZone: null,
    blindspotSuppressed: false,
    silentZone: null,
    healthStatus: "none" as const,
    caveat: "",
  },
  timeline: {
    clusterFirstPublished: "2026-09-01T00:00:00.000Z",
    zones: [
      {
        zone: "iktidar",
        firstPublishedAt: null,
        lagMs: null,
        wire: { isWireRedistribution: false, effectiveArticleCount: 0, memberCount: 0 },
      },
    ],
    overallWire: { isWireRedistribution: false, effectiveArticleCount: 3, memberCount: 3 },
    votingCount: 3,
    nonVotingCount: 0,
  },
  ownership: {
    groups: [],
    taggedSourceCount: 0,
    totalSourceCount: 3,
    taggedShare: 0,
    dominant: null,
  },
  generatedAt: "2026-09-21T12:00:00.000Z",
});

const buildYelpazeReportMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/reports/yelpaze", () => ({
  buildYelpazeReport: buildYelpazeReportMock,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      clusters: (state) => {
        const idEq = state.eq.find((e) => e.col === "id");
        const found = idEq
          ? dbState.clusterRows.some((r) => r.id === idEq.val)
          : false;
        return { data: found ? [{ id: idEq!.val }] : [], error: null };
      },
      report_share_links: (state) => {
        // Only the revoke chain (`.update().eq('token', t).is('revoked_at',
        // null).select('token').maybeSingle()`) touches this table via a
        // predicated read in these tests — insert is handled by the shared
        // fake's own insert-enrichment path.
        const tokenEq = state.eq.find((e) => e.col === "token");
        const revokedIsNull = state.is.some(
          (i) => i.col === "revoked_at" && i.val === null,
        );
        if (tokenEq && revokedIsNull) {
          const row = dbState.shareLinkRows.find(
            (r) => r.token === tokenEq.val && r.revoked_at === null,
          );
          if (!row) return { data: [], error: null };
          row.revoked_at = new Date().toISOString();
          return { data: [{ token: row.token }], error: null };
        }
        return { data: [], error: null };
      },
    },
    rpc: {
      report_share_view: (args) => {
        const token = (args as { p_token?: string } | undefined)?.p_token;
        const row = dbState.shareLinkRows.find(
          (r) =>
            r.token === token &&
            r.revoked_at === null &&
            new Date(r.expires_at).getTime() > Date.now(),
        );
        return { data: row ? row.cluster_id : null, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

let __adminAuthed = true;
vi.mock("@/lib/admin/session", () => ({
  hasAdminSession: async () => __adminAuthed,
  requireAdminSession: async () => {
    if (!__adminAuthed) throw new Error("unauthenticated");
  },
  checkAdminPassword: () => false,
  createAdminSession: async () => {},
  deleteAdminSession: async () => {},
}));

const ORIGINAL_ENV = { ...process.env };

let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.NEXT_PUBLIC_SITE_URL = "https://tayfhaber.com";
  __adminAuthed = true;
  dbState.clusterRows = [{ id: CLUSTER_ID }];
  dbState.shareLinkRows = [
    { token: LIVE_TOKEN, cluster_id: CLUSTER_ID, revoked_at: null, expires_at: futureIso(7) },
    {
      token: REVOKED_TOKEN,
      cluster_id: CLUSTER_ID,
      revoked_at: pastIso(1),
      expires_at: futureIso(6),
    },
  ];
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  buildYelpazeReportMock.mockReset();
  buildYelpazeReportMock.mockResolvedValue(FIXTURE_REPORT);
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

function shareRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/rapor/share", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function revokeRequest(body: unknown, ip = nextIp()): Request {
  return new Request("http://example.com/api/admin/rapor/revoke", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-forwarded-for": ip },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function markdownRequest(token: string, ip = nextIp()): Request {
  return new Request(`http://example.com/rapor/${token}/markdown`, {
    headers: { "x-forwarded-for": ip },
  });
}

function paramsFor(token: string) {
  return { params: Promise.resolve({ token }) };
}

describe("POST /api/admin/rapor/share", () => {
  it("401 without an admin session and never touches Supabase", async () => {
    __adminAuthed = false;
    const fromSpy = vi.spyOn(supabaseFake.client, "from");
    fromSpy.mockClear();

    const { POST } = await import("@/app/api/admin/rapor/share/route");
    const res = await POST(shareRequest({ cluster_id: CLUSTER_ID }));
    expect(res.status).toBe(401);
    expect(fromSpy).not.toHaveBeenCalled();

    fromSpy.mockRestore();
  });

  it("checks the admin session BEFORE the rate limiter and before reading the body", async () => {
    const ip = nextIp();
    // Exhaust the shared 20-token bucket for this IP while authenticated.
    const { POST } = await import("@/app/api/admin/rapor/share/route");
    for (let i = 0; i < 20; i++) {
      await POST(shareRequest({ cluster_id: CLUSTER_ID }, ip));
    }

    // Now unauthenticate and reuse the same (exhausted) IP with a
    // malformed body. If the limiter or the body parse ran first this
    // would be 429 or 400; the session check must win with 401.
    __adminAuthed = false;
    const res = await POST(shareRequest("{not json", ip));
    expect(res.status).toBe(401);
  });

  it("400 for a non-uuid cluster_id, a days of 0, and a days of 31", async () => {
    const { POST } = await import("@/app/api/admin/rapor/share/route");

    const badId = await POST(shareRequest({ cluster_id: "not-a-uuid" }));
    expect(badId.status).toBe(400);

    const badDaysZero = await POST(
      shareRequest({ cluster_id: CLUSTER_ID, days: 0 }),
    );
    expect(badDaysZero.status).toBe(400);

    const badDaysHigh = await POST(
      shareRequest({ cluster_id: CLUSTER_ID, days: 31 }),
    );
    expect(badDaysHigh.status).toBe(400);
  });

  it("404 when the cluster does not exist", async () => {
    const { POST } = await import("@/app/api/admin/rapor/share/route");
    const res = await POST(shareRequest({ cluster_id: UNKNOWN_CLUSTER_ID }));
    expect(res.status).toBe(404);
  });

  it("201 with a 32-hex token, an absolute url and an expires_at 7 days out by default", async () => {
    const before = Date.now();
    const { POST } = await import("@/app/api/admin/rapor/share/route");
    const res = await POST(shareRequest({ cluster_id: CLUSTER_ID }));
    expect(res.status).toBe(201);
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.token).toMatch(/^[0-9a-f]{32}$/);
    expect(body.url).toBe(`https://tayfhaber.com/rapor/${body.token}`);

    const expiresMs = new Date(body.expires_at).getTime();
    const expectedMs = before + 7 * 86_400_000;
    expect(Math.abs(expiresMs - expectedMs)).toBeLessThan(5_000);
  });

  it("inserts token, cluster_id and expires_at and nothing else", async () => {
    const { POST } = await import("@/app/api/admin/rapor/share/route");
    const res = await POST(shareRequest({ cluster_id: CLUSTER_ID, days: 3 }));
    expect(res.status).toBe(201);

    const inserts = supabaseFake.calls.insert("report_share_links");
    expect(inserts).toHaveLength(1);
    const patch = inserts[0]?.patch as Record<string, unknown>;
    expect(Object.keys(patch).sort()).toEqual(
      ["cluster_id", "expires_at", "token"].sort(),
    );
    expect(patch.cluster_id).toBe(CLUSTER_ID);
    expect(typeof patch.token).toBe("string");
    expect(typeof patch.expires_at).toBe("string");
  });

  it("429 with details.retryAfterMs after 20 requests from the same client", async () => {
    const ip = nextIp();
    const { POST } = await import("@/app/api/admin/rapor/share/route");
    for (let i = 0; i < 20; i++) {
      const res = await POST(shareRequest({ cluster_id: CLUSTER_ID }, ip));
      expect(res.status).toBe(201);
    }
    const res = await POST(shareRequest({ cluster_id: CLUSTER_ID }, ip));
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(typeof body.details?.retryAfterMs).toBe("number");
  });
});

describe("POST /api/admin/rapor/revoke", () => {
  it("401 without an admin session, 400 for a malformed token, 200 {revoked:false} for an unknown token", async () => {
    const { POST } = await import("@/app/api/admin/rapor/revoke/route");

    __adminAuthed = false;
    const unauthedRes = await POST(revokeRequest({ token: LIVE_TOKEN }));
    expect(unauthedRes.status).toBe(401);

    __adminAuthed = true;
    const malformedRes = await POST(revokeRequest({ token: "not-a-token" }));
    expect(malformedRes.status).toBe(400);

    const unknownRes = await POST(revokeRequest({ token: UNKNOWN_TOKEN }));
    expect(unknownRes.status).toBe(200);
    const body = await unknownRes.json();
    expect(body).toEqual({ ok: true, revoked: false });
  });

  it("sets revoked_at only on a row whose revoked_at is still null", async () => {
    const { POST } = await import("@/app/api/admin/rapor/revoke/route");

    const alreadyRevokedRes = await POST(revokeRequest({ token: REVOKED_TOKEN }));
    expect(alreadyRevokedRes.status).toBe(200);
    expect((await alreadyRevokedRes.json()).revoked).toBe(false);

    const liveRes = await POST(revokeRequest({ token: LIVE_TOKEN }));
    expect(liveRes.status).toBe(200);
    expect((await liveRes.json()).revoked).toBe(true);

    // Revoking the same live token a second time now finds no live row.
    const secondRes = await POST(revokeRequest({ token: LIVE_TOKEN }));
    expect((await secondRes.json()).revoked).toBe(false);
  });
});

describe("GET /rapor/[token]/markdown", () => {
  it("404 for a malformed token without calling the rpc", async () => {
    const { GET } = await import("@/app/rapor/[token]/markdown/route");
    const res = await GET(markdownRequest("not-a-token"), paramsFor("not-a-token"));
    expect(res.status).toBe(404);
    expect(
      supabaseFake.calls.rpc.filter((c) => c.name === "report_share_view"),
    ).toHaveLength(0);
  });

  it("404 when report_share_view returns null (unknown, expired or revoked are indistinguishable)", async () => {
    const { GET } = await import("@/app/rapor/[token]/markdown/route");
    const res = await GET(markdownRequest(UNKNOWN_TOKEN), paramsFor(UNKNOWN_TOKEN));
    expect(res.status).toBe(404);
  });

  it("200 text/markdown with Content-Disposition attachment, Cache-Control private no-store and X-Robots-Tag noindex", async () => {
    const { GET } = await import("@/app/rapor/[token]/markdown/route");
    const res = await GET(markdownRequest(LIVE_TOKEN), paramsFor(LIVE_TOKEN));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toBe(
      `attachment; filename="tayf-yelpaze-${LIVE_TOKEN.slice(0, 8)}.md"`,
    );
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("the body contains no article description and no image URL", async () => {
    const { GET } = await import("@/app/rapor/[token]/markdown/route");
    const res = await GET(markdownRequest(LIVE_TOKEN), paramsFor(LIVE_TOKEN));
    const text = await res.text();
    expect(text).not.toContain("image_url");
    expect(text).not.toContain("description");
    expect(text).not.toMatch(/https?:\/\/\S+\.(jpg|jpeg|png|webp|gif)/i);
  });

  it("429 after 10 requests from the same client", async () => {
    const ip = nextIp();
    const { GET } = await import("@/app/rapor/[token]/markdown/route");
    for (let i = 0; i < 10; i++) {
      const res = await GET(markdownRequest(LIVE_TOKEN, ip), paramsFor(LIVE_TOKEN));
      expect(res.status).toBe(200);
    }
    const res = await GET(markdownRequest(LIVE_TOKEN, ip), paramsFor(LIVE_TOKEN));
    expect(res.status).toBe(429);
  });
});
