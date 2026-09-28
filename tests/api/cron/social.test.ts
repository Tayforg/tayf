import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/cron/social — owned-channels auto-poster.
// ---------------------------------------------------------------------------

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../_helpers/supabase-fake");
  const state: {
    fresh: unknown[];
    ledger: unknown[];
    rpc: Record<string, (args: unknown) => { data: unknown; error: { message: string } | null }>;
  } = {
    fresh: [],
    ledger: [],
    rpc: {
      social_post_claim: () => ({ data: 7, error: null }),
      social_post_finish: () => ({ data: true, error: null }),
    },
  };
  const fake = helper.createSupabaseFake({
    tables: {
      clusters: () => ({ data: state.fresh, error: null }),
      social_posts: () => ({ data: state.ledger, error: null }),
    },
    rpc: {
      social_post_claim: (args: unknown) => state.rpc.social_post_claim(args),
      social_post_finish: (args: unknown) => state.rpc.social_post_finish(args),
    },
  });
  return { fake, state };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.fake.client,
}));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

vi.mock("@/lib/site-url", () => ({ siteUrl: () => "https://tayfhaber.com" }));

const mocks = vi.hoisted(() => ({
  health: null as unknown,
  blindspots: { bundles: [] as unknown[] },
  politics: { bundles: [] as unknown[] },
  blindspotsThrows: false,
  politicsThrows: false,
}));

vi.mock("@/lib/clusters/feed-health", () => ({
  getZoneFeedHealth: vi.fn(async () => mocks.health),
  shouldSuppressBlindspot: (zone: string, health: Record<string, { degraded: boolean }> | null) => {
    if (!health) return false;
    const poles = ["iktidar", "muhalefet"];
    return poles.some((z) => z !== zone && health[z]?.degraded);
  },
}));

vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: vi.fn(async () => {
    if (mocks.blindspotsThrows) throw new Error("boom");
    return mocks.blindspots;
  }),
}));

vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: vi.fn(async () => {
    if (mocks.politicsThrows) throw new Error("boom");
    return mocks.politics;
  }),
}));

vi.mock("@/lib/social/telegram", () => ({
  postToTelegram: vi.fn(async () => ({ ok: true, externalId: "msg-1" })),
}));

const blueskyMocks = vi.hoisted(() => ({
  createSession: vi.fn(async () => ({ accessJwt: "jwt", did: "did:plc:x" })),
  post: vi.fn(async () => ({ ok: true, externalId: "at://post/1" })),
}));

vi.mock("@/lib/social/bluesky", () => ({
  createBlueskySession: blueskyMocks.createSession,
  postToBluesky: blueskyMocks.post,
}));

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function healthy() {
  const zone = { healthy: 10, total: 10, degraded: false };
  return { iktidar: { ...zone }, bagimsiz: { ...zone }, muhalefet: { ...zone } };
}

function blindspotBundle(id: string, overrides: Record<string, unknown> = {}) {
  return {
    cluster: {
      id,
      title_tr: "Kör nokta haberi",
      first_published: new Date(Date.now() - 1 * 3600 * 1000).toISOString(),
    },
    articles: [],
    sources: [
      { id: "s1", name: "A", bias: "pro_government" },
      { id: "s2", name: "B", bias: "gov_leaning" },
      { id: "s3", name: "C", bias: "state_media" },
      { id: "s4", name: "D", bias: "nationalist" },
      { id: "s5", name: "E", bias: "islamist_conservative" },
    ],
    dominantZone: "iktidar",
    dominantPct: 0.8,
    isWireRedistribution: false,
    effectiveArticleCount: 5,
    ...overrides,
  };
}

function freshRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    is_blindspot: true,
    blindspot_recall_veto: false,
    blindspot_recall_suspect: false,
    blindspot_recall_checked_at: "2026-09-27T00:00:00.000Z",
    is_archived: false,
    ...overrides,
  };
}

let ipCounter = 0;

function request(headers: Record<string, string> = { Authorization: "Bearer shhh" }) {
  // Each call gets a fresh IP so the shared in-memory rate-limit bucket
  // (cron-social) never bleeds between tests.
  ipCounter += 1;
  return new Request("http://example.com/api/cron/social", {
    headers: { "x-forwarded-for": `203.0.113.${ipCounter % 250}`, ...headers },
  });
}

beforeEach(() => {
  process.env.CRON_SECRET = "shhh";
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.SOCIAL_POST_DISABLED;
  delete process.env.SOCIAL_POST_DRY_RUN;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHANNEL_ID;
  delete process.env.BLUESKY_HANDLE;
  delete process.env.BLUESKY_APP_PASSWORD;

  mocks.health = healthy();
  mocks.blindspots = { bundles: [] };
  mocks.politics = { bundles: [] };
  mocks.blindspotsThrows = false;
  mocks.politicsThrows = false;

  supabaseFake.state.fresh = [];
  supabaseFake.state.ledger = [];
  supabaseFake.state.rpc.social_post_claim = () => ({ data: 7, error: null });
  supabaseFake.state.rpc.social_post_finish = () => ({ data: true, error: null });
  supabaseFake.fake.calls.rpc.length = 0;

  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

  blueskyMocks.createSession.mockClear();
  blueskyMocks.post.mockClear();
  blueskyMocks.createSession.mockResolvedValue({ accessJwt: "jwt", did: "did:plc:x" });
  blueskyMocks.post.mockResolvedValue({ ok: true, externalId: "at://post/1" });
});

describe("GET /api/cron/social — auth", () => {
  it("503s without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    expect(res.status).toBe(503);
  });

  it("401s on a bad bearer", async () => {
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request({ Authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/cron/social — kill switches / config", () => {
  it("disabled makes no rpc and no fetch", async () => {
    process.env.SOCIAL_POST_DISABLED = "1";
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("disabled");
    expect(supabaseFake.fake.calls.rpc.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("no channels configured: 200, logs, no rpc, no fetch", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("no channels configured");
    expect(logSpy).toHaveBeenCalled();
    expect(supabaseFake.fake.calls.rpc.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });

  it("health null means no posts", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.health = null;
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("feed health unknown");
    expect(supabaseFake.fake.calls.rpc.length).toBe(0);
  });

  it("dry run returns previews with zero rpc and zero fetch", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    process.env.SOCIAL_POST_DRY_RUN = "1";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];

    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();
    expect(body.dryRun).toBe(true);
    expect(Array.isArray(body.previews)).toBe(true);
    expect(body.previews.length).toBeGreaterThan(0);
    expect(supabaseFake.fake.calls.rpc.length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("GET /api/cron/social — happy paths", () => {
  it("Telegram only: claim returns 7, posts once, finishes posted", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];

    const { GET } = await import("@/app/api/cron/social/route");
    const { postToTelegram } = await import("@/lib/social/telegram");
    const res = await GET(request());
    const body = await res.json();

    expect(body.ok).toBe(true);
    expect(body.posted).toBe(1);
    expect(postToTelegram).toHaveBeenCalledTimes(1);

    const claimCalls = supabaseFake.fake.calls.rpc.filter((c) => c.name === "social_post_claim");
    expect(claimCalls.length).toBe(1);
    const finishCalls = supabaseFake.fake.calls.rpc.filter((c) => c.name === "social_post_finish");
    expect(finishCalls.length).toBe(1);
    expect((finishCalls[0]!.args as { p_status: string }).p_status).toBe("posted");
  });

  it("claim null means no post call (second-run idempotency)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];
    supabaseFake.state.rpc.social_post_claim = () => ({ data: null, error: null });

    const { GET } = await import("@/app/api/cron/social/route");
    const { postToTelegram } = await import("@/lib/social/telegram");
    const res = await GET(request());
    const body = await res.json();

    expect(body.posted).toBe(0);
    expect(postToTelegram).not.toHaveBeenCalled();
  });

  it("a fresh-veto row means no claim (skips before claiming)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1", { blindspot_recall_veto: true })];

    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();

    expect(body.posted).toBe(0);
    expect(supabaseFake.fake.calls.rpc.filter((c) => c.name === "social_post_claim").length).toBe(0);
  });

  it("a post failure calls finish(failed) with a sanitized error", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];

    const { postToTelegram } = await import("@/lib/social/telegram");
    (postToTelegram as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: "boom",
    });

    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();

    expect(body.posted).toBe(0);
    const finishCalls = supabaseFake.fake.calls.rpc.filter((c) => c.name === "social_post_finish");
    expect(finishCalls.length).toBe(1);
    expect((finishCalls[0]!.args as { p_status: string }).p_status).toBe("failed");
  });

  it("Bluesky: creates a session then calls createRecord", async () => {
    process.env.BLUESKY_HANDLE = "tayf.bsky.social";
    process.env.BLUESKY_APP_PASSWORD = "app-password";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];

    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();

    expect(body.posted).toBe(1);
    expect(blueskyMocks.createSession).toHaveBeenCalledTimes(1);
    expect(blueskyMocks.post).toHaveBeenCalledTimes(1);
  });

  it("source data unavailable when getBlindspots throws", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.blindspotsThrows = true;

    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe("source data unavailable");
  });
});
