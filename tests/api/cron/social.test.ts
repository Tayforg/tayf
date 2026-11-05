import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/cron/social — owned-channels auto-poster.
// ---------------------------------------------------------------------------

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../_helpers/supabase-fake");
  const state: {
    fresh: unknown[];
    freshError: { message: string } | null;
    ledger: unknown[];
    ledgerError: { message: string } | null;
    rpc: Record<string, (args: unknown) => { data: unknown; error: { message: string } | null }>;
  } = {
    fresh: [],
    freshError: null,
    ledger: [],
    ledgerError: null,
    rpc: {
      social_post_claim: () => ({ data: 7, error: null }),
      social_post_finish: () => ({ data: true, error: null }),
    },
  };
  const fake = helper.createSupabaseFake({
    tables: {
      clusters: () => ({ data: state.fresh, error: state.freshError }),
      social_posts: () => ({ data: state.ledger, error: state.ledgerError }),
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

// withCronOutcome schedules its outcome row with after(); outside a request scope it throws.
// Capture the callbacks instead, so a test can run them and read the recorded status.
const afterCallbacks = vi.hoisted(() => [] as Array<() => unknown>);

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    connection: async () => {},
    after: (callback: () => unknown) => {
      afterCallbacks.push(callback);
    },
  };
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
  supabaseFake.state.freshError = null;
  supabaseFake.state.ledger = [];
  supabaseFake.state.ledgerError = null;
  afterCallbacks.length = 0;
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

  it("dry run builds the zone line on the voting basis: bundle sources carry kind, an aggregator is counted in 'N kaynak' and the head names the classified count", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    process.env.SOCIAL_POST_DRY_RUN = "1";
    mocks.blindspots = {
      bundles: [
        blindspotBundle("bs-agg", {
          sources: [
            { id: "s1", name: "A", bias: "pro_government", kind: "outlet" },
            { id: "s2", name: "B", bias: "gov_leaning", kind: "outlet" },
            { id: "s3", name: "C", bias: "state_media", kind: "wire" },
            { id: "s4", name: "D", bias: "nationalist", kind: "outlet" },
            { id: "s5", name: "E", bias: "islamist_conservative", kind: "outlet" },
            { id: "s6", name: "F", bias: "center", kind: "aggregator" },
          ],
        }),
      ],
    };
    supabaseFake.state.fresh = [freshRow("bs-agg")];

    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();

    const preview = (body.previews as Array<{ clusterId: string; text: string }>).find(
      (p) => p.clusterId === "bs-agg",
    );
    expect(preview).toBeDefined();
    expect(preview!.text).toContain(
      "6 kaynak (5 sınıflandırılmış): İktidar 5 · Bağımsız 0 · Muhalefet 0",
    );
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

  it("reads blindspots and politics through the uncapped batch profile (the 4 s reader cap must not skip a tick)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    const { GET } = await import("@/app/api/cron/social/route");
    const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
    const { getPoliticsClusters } = await import("@/lib/clusters/politics-query");
    vi.mocked(getBlindspots).mockClear();
    vi.mocked(getPoliticsClusters).mockClear();
    await GET(request());
    expect(getBlindspots).toHaveBeenCalledWith({ profile: "batch" });
    expect(getPoliticsClusters).toHaveBeenCalledWith({ profile: "batch" });
  });

  it("reads feed health through the uncapped batch profile too (the 4 s reader cap must not skip a tick)", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    const { GET } = await import("@/app/api/cron/social/route");
    const { getZoneFeedHealth } = await import("@/lib/clusters/feed-health");
    vi.mocked(getZoneFeedHealth).mockClear();
    await GET(request());
    expect(getZoneFeedHealth).toHaveBeenCalledTimes(1);
    expect(getZoneFeedHealth).toHaveBeenCalledWith({ profile: "batch" });
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

// ---------------------------------------------------------------------------
// W3: a Supabase read or rpc that fails is swallowed and the run answers 200 with
// `ok: true`, so a tick that lost its ledger writes looked healthy. The route now
// counts each swallowed database failure (freshError, ledgerError, claimError,
// finishError) in `substepErrors`, answers the same 200 with `ok: substepErrors === 0`
// and the count in the body, and sets the internal header; withCronOutcome records
// 599 and strips it. A failed ledger read FAILS CLOSED: with no ledger every
// already-posted cluster would look new, so the tick posts nothing. A Telegram or
// Bluesky post that fails (a vendor failure) and a claim that returns no id (daily
// cap, already claimed) are not counted.
// ---------------------------------------------------------------------------
describe("GET /api/cron/social — sub-step failures are recorded as 599, answered as 200 (W3)", () => {
  const SUBSTEP_HEADER = "x-cron-substep-errors";

  /** Runs the pending after() callbacks once, the way Next does once the response is on its way. */
  const flush = () => Promise.all(afterCallbacks.splice(0).map((cb) => cb()));
  /** Every `ops_cron_route_run_record` call (withCronOutcome's row for ops_health_report row 15). */
  const outcomeCalls = () => supabaseFake.fake.calls.rpc.filter((c) => c.name === "ops_cron_route_run_record");
  const rpcCalls = (name: string) => supabaseFake.fake.calls.rpc.filter((c) => c.name === name);

  function telegramWithBlindspot() {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];
  }

  async function runRecorded() {
    const { GET } = await import("@/app/api/cron/social/route");
    const res = await GET(request());
    const body = await res.json();
    await flush();
    return { res, body };
  }

  const finishFails = () => {
    supabaseFake.state.rpc.social_post_finish = () => ({ data: null, error: { message: "finish boom" } });
  };

  it("a clean post records 200, reports substepErrors 0 and ok true", async () => {
    telegramWithBlindspot();
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body).toMatchObject({ ok: true, posted: 1, substepErrors: 0 });
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 200 });
  });

  it("a failed social_post_finish after a Telegram post records 599 and reports ok false", async () => {
    telegramWithBlindspot();
    finishFails();
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body.posted).toBe(1);
    expect(body.substepErrors).toBe(1);
    expect(body.ok).toBe(false);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 599 });
  });

  it("every social_post_finish path counts its failure: Telegram failed, Bluesky posted, Bluesky failed, Bluesky thrown", async () => {
    const { postToTelegram } = await import("@/lib/social/telegram");

    // Telegram: the post itself failed, then the 'failed' finish failed too.
    telegramWithBlindspot();
    finishFails();
    (postToTelegram as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "boom" });
    const telegramFailed = await runRecorded();
    expect(telegramFailed.body).toMatchObject({ posted: 0, substepErrors: 1, ok: false });
    expect(rpcCalls("social_post_finish")).toHaveLength(1);

    // Bluesky: posted, then the finish failed.
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_CHANNEL_ID;
    process.env.BLUESKY_HANDLE = "tayf.bsky.social";
    process.env.BLUESKY_APP_PASSWORD = "app-password";
    const blueskyPosted = await runRecorded();
    expect(blueskyPosted.body).toMatchObject({ posted: 1, substepErrors: 1, ok: false });

    // Bluesky: the post returned ok:false, then the finish failed.
    (blueskyMocks.post as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "rejected" });
    const blueskyFailed = await runRecorded();
    expect(blueskyFailed.body).toMatchObject({ posted: 0, substepErrors: 1, ok: false });

    // Bluesky: the session threw (the catch branch), then the finish failed.
    blueskyMocks.createSession.mockRejectedValueOnce(new Error("session boom"));
    const blueskyThrown = await runRecorded();
    expect(blueskyThrown.body).toMatchObject({ posted: 0, substepErrors: 1, ok: false });

    expect(outcomeCalls().map((c) => (c.args as { p_status: number }).p_status)).toEqual([599, 599, 599, 599]);
  });

  it("the sum over both channels: one failed finish per channel counts 2", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "t";
    process.env.TELEGRAM_CHANNEL_ID = "c";
    process.env.BLUESKY_HANDLE = "tayf.bsky.social";
    process.env.BLUESKY_APP_PASSWORD = "app-password";
    mocks.blindspots = { bundles: [blindspotBundle("bs1")] };
    supabaseFake.state.fresh = [freshRow("bs1")];
    finishFails();
    const { body } = await runRecorded();
    expect(body).toMatchObject({ posted: 2, substepErrors: 2, ok: false });
  });

  it("a claim rpc error records 599, counts it as claim_failed and posts nothing", async () => {
    telegramWithBlindspot();
    supabaseFake.state.rpc.social_post_claim = () => ({ data: null, error: { message: "claim boom" } });
    const { postToTelegram } = await import("@/lib/social/telegram");
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(body.posted).toBe(0);
    expect(body.skipped).toEqual({ claim_failed: 1 });
    expect(body.substepErrors).toBe(1);
    expect(body.ok).toBe(false);
    expect(postToTelegram).not.toHaveBeenCalled();
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 599 });
  });

  it("a claim that returns no id without an error (daily cap, already claimed) is not a failure: 200 recorded", async () => {
    telegramWithBlindspot();
    supabaseFake.state.rpc.social_post_claim = () => ({ data: null, error: null });
    const { body } = await runRecorded();

    expect(body.skipped).toEqual({ claim_failed: 1 });
    expect(body.substepErrors).toBe(0);
    expect(body.ok).toBe(true);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 200 });
  });

  it("a failed fresh re-read records 599 and fails closed for blindspots: nothing is claimed", async () => {
    telegramWithBlindspot();
    supabaseFake.state.freshError = { message: "fresh boom" };
    const { postToTelegram } = await import("@/lib/social/telegram");
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body.posted).toBe(0);
    expect(body.substepErrors).toBe(1);
    expect(body.ok).toBe(false);
    expect(rpcCalls("social_post_claim")).toHaveLength(0);
    expect(postToTelegram).not.toHaveBeenCalled();
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 599 });
  });

  it("a failed ledger read FAILS CLOSED: 'ledger unavailable' skip, no claim, no post, recorded as 599", async () => {
    telegramWithBlindspot();
    // An already-posted cluster would be re-planned if the empty ledger were trusted.
    supabaseFake.state.ledger = [
      { channel: "telegram", cluster_id: "bs1", kind: "blindspot", created_at: new Date().toISOString() },
    ];
    supabaseFake.state.ledgerError = { message: "ledger boom" };
    const { postToTelegram } = await import("@/lib/social/telegram");
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body).toMatchObject({ skipped: true, reason: "ledger unavailable" });
    expect(body.substepErrors).toBeGreaterThanOrEqual(1);
    expect(rpcCalls("social_post_claim")).toHaveLength(0);
    expect(postToTelegram).not.toHaveBeenCalled();
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 599 });
  });

  it("the ledger skip counts the earlier fresh failure too", async () => {
    telegramWithBlindspot();
    supabaseFake.state.freshError = { message: "fresh boom" };
    supabaseFake.state.ledgerError = { message: "ledger boom" };
    const { body } = await runRecorded();
    expect(body).toMatchObject({ skipped: true, reason: "ledger unavailable", substepErrors: 2 });
  });

  it("a dry run reports the swallowed failure of its reads too, and still touches no rpc", async () => {
    telegramWithBlindspot();
    process.env.SOCIAL_POST_DRY_RUN = "1";
    supabaseFake.state.freshError = { message: "fresh boom" };
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body.dryRun).toBe(true);
    expect(body.substepErrors).toBe(1);
    expect(rpcCalls("social_post_claim")).toHaveLength(0);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 599 });
  });

  it("a clean dry run records 200 with substepErrors 0", async () => {
    telegramWithBlindspot();
    process.env.SOCIAL_POST_DRY_RUN = "1";
    const { body } = await runRecorded();
    expect(body.dryRun).toBe(true);
    expect(body.substepErrors).toBe(0);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 200 });
  });

  it("a post that fails at the vendor (Telegram answers not ok) is not counted: 200 recorded, ok true", async () => {
    telegramWithBlindspot();
    const { postToTelegram } = await import("@/lib/social/telegram");
    (postToTelegram as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, error: "boom" });
    const { body } = await runRecorded();

    expect(body).toMatchObject({ ok: true, posted: 0, substepErrors: 0 });
    expect(body.skipped).toEqual({ post_failed: 1 });
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "social", p_status: 200 });
  });
});
