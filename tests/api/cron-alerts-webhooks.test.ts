import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/cron/alerts-webhooks. The supabase client is the shared fake (with
// a thin wrapper that also records upsert OPTIONS, which the fake drops),
// getAlertItems / getZoneFeedHealth are mocked, and postWebhook is replaced so
// no socket is ever opened.
// ---------------------------------------------------------------------------

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const SECRET_A = "whsec_" + "1a".repeat(32);
const HOOK_URL = "https://hooks.example.com/secret-path-token/tayf";
const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600 * 1000;

const fx = vi.hoisted(() => ({
  webhooks: [] as unknown[],
  fresh: [] as unknown[],
  freshError: null as { message: string } | null,
  claimRows: [] as unknown[],
  claimError: null as { message: string } | null,
  unknownStreakRows: [] as unknown[],
  tablesTouched: [] as string[],
  upsertOpts: [] as Array<{ table: string; opts: unknown }>,
  items: [] as unknown[],
  health: {} as unknown,
  getAlertItemsCalls: [] as unknown[],
  postResults: [] as unknown[],
  postCalls: [] as Array<{ url: string; body: string; headers: Record<string, string> }>,
  webhookQuery: null as import("../_helpers/supabase-fake").BuilderState | null,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      api_key_webhooks: (st) => {
        if (st.mutation) return { data: null, error: null };
        if (st.in.some((i) => i.col === "key_id")) return { data: fx.unknownStreakRows, error: null };
        fx.webhookQuery = st;
        return { data: fx.webhooks, error: null };
      },
      clusters: () => ({ data: fx.fresh, error: fx.freshError }),
      api_key_webhook_deliveries: () => ({ data: null, error: null }),
    },
    rpc: {
      api_webhook_claim: () => ({ data: fx.claimRows, error: fx.claimError }),
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => {
      fx.tablesTouched.push(table);
      const builder = supabaseFake.client.from(table) as Record<string, unknown>;
      return new Proxy(builder, {
        get(target, prop) {
          if (prop === "upsert") {
            return (patch: unknown, opts: unknown) => {
              fx.upsertOpts.push({ table, opts });
              return (target.upsert as (p: unknown, o: unknown) => unknown)(patch, opts);
            };
          }
          return target[prop as string];
        },
      });
    },
    rpc: supabaseFake.client.rpc,
  }),
}));

vi.mock("@/lib/alerts/alert-query", () => ({
  getAlertItems: async (input: unknown) => {
    fx.getAlertItemsCalls.push(input);
    return fx.items;
  },
}));

vi.mock("@/lib/clusters/feed-health", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/clusters/feed-health")>();
  return { ...actual, getZoneFeedHealth: async () => fx.health };
});

vi.mock("@/lib/alerts/webhook-deliver", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alerts/webhook-deliver")>();
  return {
    ...actual,
    postWebhook: async (url: string, body: string, headers: Record<string, string>) => {
      fx.postCalls.push({ url, body, headers });
      return fx.postResults.shift() ?? { status: 200 };
    },
  };
});

const ORIGINAL_ENV = { ...process.env };
let ipCounter = 0;
const nextIp = () => `203.0.117.${1 + (++ipCounter % 250)}`;

function req(auth: string | null = "Bearer test-cron-secret"): Request {
  const headers: Record<string, string> = { "x-forwarded-for": nextIp() };
  if (auth) headers.authorization = auth;
  return new Request("http://example.com/api/cron/alerts-webhooks", { headers });
}

const HEALTHY = {
  iktidar: { degraded: false },
  bagimsiz: { degraded: false },
  muhalefet: { degraded: false },
};

const ID1 = "11111111-2222-3333-4444-555555555551";
const ID2 = "11111111-2222-3333-4444-555555555552";
const ID3 = "11111111-2222-3333-4444-555555555553";
const ID4 = "11111111-2222-3333-4444-555555555554";
const IDS = "11111111-2222-3333-4444-555555555555";

function item(type: "blindspot" | "one_zone_silent", id: string, updatedMsAgo = 1 * H) {
  return {
    type,
    clusterId: id,
    title: "Başlık",
    firstPublished: iso(30 * H),
    updatedAt: iso(updatedMsAgo),
    sourceCount: 6,
    zoneCounts: { iktidar: 5, bagimsiz: 1, muhalefet: 0 },
    dominantZone: type === "blindspot" ? "iktidar" : null,
    silentZones: ["muhalefet"],
  };
}

const freshOk = (id: string) => ({
  id,
  is_blindspot: true,
  blindspot_recall_veto: false,
  blindspot_recall_suspect: false,
  blindspot_recall_checked_at: iso(2 * H),
  is_archived: false,
});

function claimRow(over: Record<string, unknown> = {}) {
  return {
    id: 501,
    key_id: 7,
    alert_id: `blindspot:${ID1}`,
    payload: { event: "tayf.alert", alert: { id: `blindspot:${ID1}` }, licence: "L", attribution: "A" },
    attempts: 1,
    url: HOOK_URL,
    secret: SECRET_A,
    ...over,
  };
}

const webhook = (over: Record<string, unknown> = {}) => ({
  key_id: 7,
  created_at: iso(48 * H),
  fail_streak: 0,
  ...over,
});

let spies: Array<ReturnType<typeof vi.spyOn>> = [];

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CRON_SECRET = "test-cron-secret";
  delete process.env.ALERT_WEBHOOKS_DISABLED;
  fx.webhooks = [webhook()];
  fx.fresh = [];
  fx.freshError = null;
  fx.claimRows = [];
  fx.claimError = null;
  fx.unknownStreakRows = [];
  fx.tablesTouched = [];
  fx.upsertOpts = [];
  fx.items = [];
  fx.health = HEALTHY;
  fx.getAlertItemsCalls = [];
  fx.postResults = [];
  fx.postCalls = [];
  fx.webhookQuery = null;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});

afterEach(() => {
  spies.forEach((s) => s.mockRestore());
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET", "ALERT_WEBHOOKS_DISABLED"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

async function run(r: Request = req()) {
  const { GET } = await import("@/app/api/cron/alerts-webhooks/route");
  return GET(r);
}

describe("GET /api/cron/alerts-webhooks", () => {
  it("503 without CRON_SECRET and 401 with a wrong bearer", async () => {
    delete process.env.CRON_SECRET;
    expect((await run()).status).toBe(503);
    process.env.CRON_SECRET = "test-cron-secret";
    expect((await run(req("Bearer nope"))).status).toBe(401);
    expect((await run(req(null))).status).toBe(401);
    expect(fx.tablesTouched).toEqual([]);
  });

  it("ALERT_WEBHOOKS_DISABLED=1 short-circuits before any query", async () => {
    process.env.ALERT_WEBHOOKS_DISABLED = "1";
    const body = await (await run()).json();
    expect(body).toEqual({ skipped: "disabled" });
    expect(fx.tablesTouched).toEqual([]);
  });

  it("with zero webhooks returns {skipped:'no webhooks'} before ANY other query", async () => {
    fx.webhooks = [];
    const body = await (await run()).json();
    expect(body).toEqual({ skipped: "no webhooks" });
    expect(fx.tablesTouched).toEqual(["api_key_webhooks"]);
    expect(fx.getAlertItemsCalls).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("loads only enabled webhooks on live keys, selecting no url or secret, capped at 20 (fetches 21 to detect overflow)", async () => {
    await run();
    const q = fx.webhookQuery!;
    expect(q.eq).toContainEqual({ col: "enabled", val: true });
    expect(q.is).toContainEqual({ col: "api_keys.revoked_at", val: null });
    expect(q.limit).toBe(21);
    const sel = String(q.selectArgs[0]);
    expect(sel).not.toMatch(/\b(secret|url)\b/);
  });

  it("logs when more than 20 webhooks exist and only serves the first 20", async () => {
    fx.webhooks = Array.from({ length: 21 }, (_, i) => webhook({ key_id: i + 1 }));
    fx.items = [item("one_zone_silent", IDS)];
    await run();
    const rows = supabaseFake.calls.upsert("api_key_webhook_deliveries");
    expect(rows).toHaveLength(20);
    expect(spies.flatMap((s) => s.mock.calls).some((c) => String(c[0]).includes("more than 20"))).toBe(true);
  });

  it("fails CLOSED when feed health is unknown", async () => {
    fx.health = null;
    const body = await (await run()).json();
    expect(body).toEqual({ skipped: "feed health unknown" });
    expect(fx.getAlertItemsCalls).toHaveLength(0);
    expect(supabaseFake.calls.rpc).toHaveLength(0);
  });

  it("queries alerts for the trailing 24h, limit 100, with the health it read", async () => {
    await run();
    expect(fx.getAlertItemsCalls).toHaveLength(1);
    const call = fx.getAlertItemsCalls[0] as { sinceIso: string; limit: number; health: unknown };
    expect(call.limit).toBe(100);
    expect(call.health).toBe(HEALTHY);
    expect(Math.abs(Date.parse(call.sinceIso) - (Date.now() - 24 * H))).toBeLessThan(60_000);
  });

  it("never enqueues a blindspot that is suspect, unchecked, vetoed, archived, no longer flagged or unknown", async () => {
    fx.items = [
      item("blindspot", ID1),
      item("blindspot", ID2),
      item("blindspot", ID3),
      item("blindspot", ID4),
      item("blindspot", "11111111-2222-3333-4444-555555555556"),
      item("blindspot", "11111111-2222-3333-4444-555555555557"),
      item("blindspot", "11111111-2222-3333-4444-555555555558"),
    ];
    fx.fresh = [
      freshOk(ID1),
      { ...freshOk(ID2), blindspot_recall_suspect: true },
      { ...freshOk(ID3), blindspot_recall_checked_at: null },
      { ...freshOk(ID4), blindspot_recall_veto: true },
      { ...freshOk("11111111-2222-3333-4444-555555555556"), is_archived: true },
      { ...freshOk("11111111-2222-3333-4444-555555555557"), is_blindspot: false },
      // ...558 is absent from the fresh read entirely.
    ];
    await run();
    const upserts = supabaseFake.calls.upsert("api_key_webhook_deliveries");
    expect(upserts).toHaveLength(1);
    const rows = upserts[0]!.patch as Array<{ alert_id: string }>;
    expect(rows.map((r) => r.alert_id)).toEqual([`blindspot:${ID1}`]);
  });

  it("fails closed for blindspots when the fresh re-read errors, but still passes silent alerts", async () => {
    fx.items = [item("blindspot", ID1), item("one_zone_silent", IDS)];
    fx.freshError = { message: "boom" };
    await run();
    const rows = supabaseFake.calls.upsert("api_key_webhook_deliveries")[0]!.patch as Array<{ alert_id: string }>;
    expect(rows.map((r) => r.alert_id)).toEqual([`one_zone_silent:${IDS}`]);
  });

  it("only enqueues items updated at or after the webhook was created", async () => {
    fx.webhooks = [webhook({ created_at: iso(3 * H) })];
    fx.items = [item("one_zone_silent", IDS, 1 * H), item("one_zone_silent", ID2, 10 * H)];
    await run();
    const rows = supabaseFake.calls.upsert("api_key_webhook_deliveries")[0]!.patch as Array<{ alert_id: string }>;
    expect(rows.map((r) => r.alert_id)).toEqual([`one_zone_silent:${IDS}`]);
  });

  it("upserts with onConflict key_id,alert_id and ignoreDuplicates, storing the payload once", async () => {
    fx.items = [item("one_zone_silent", IDS)];
    const body = await (await run()).json();
    expect(fx.upsertOpts).toEqual([
      {
        table: "api_key_webhook_deliveries",
        opts: { onConflict: "key_id,alert_id", ignoreDuplicates: true },
      },
    ]);
    const rows = supabaseFake.calls.upsert("api_key_webhook_deliveries")[0]!.patch as Array<{
      key_id: number;
      alert_id: string;
      payload: { event: string; alert: { id: string; cluster_id: string }; licence: string; attribution: string };
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key_id).toBe(7);
    expect(rows[0]!.payload.event).toBe("tayf.alert");
    expect(rows[0]!.payload.alert.id).toBe(`one_zone_silent:${IDS}`);
    expect(rows[0]!.payload.licence).toBeTruthy();
    expect(rows[0]!.payload.attribution).toBeTruthy();
    expect(body.enqueued).toBe(1);
  });

  it("claims with p_limit 20 and signs each attempt with a verifiable signature over the exact body", async () => {
    fx.claimRows = [claimRow()];
    const { verifyWebhookSignature } = await import("@/lib/alerts/webhook-sign");
    await run();
    expect(supabaseFake.calls.rpc.filter((c) => c.name === "api_webhook_claim")[0]!.args).toEqual({ p_limit: 20 });
    expect(fx.postCalls).toHaveLength(1);
    const c = fx.postCalls[0]!;
    expect(c.url).toBe(HOOK_URL);
    expect(c.body).toBe(JSON.stringify(claimRow().payload));
    expect(c.headers["X-Tayf-Delivery"]).toBe("501");
    const ts = Number(c.headers["X-Tayf-Timestamp"]);
    expect(Math.abs(ts - Date.now() / 1000)).toBeLessThan(120);
    expect(verifyWebhookSignature(SECRET_A, ts, c.body, c.headers["X-Tayf-Signature"]!)).toBe(true);
  });

  it("a retry sends the same delivery id and identical bytes", async () => {
    fx.claimRows = [claimRow({ attempts: 2 })];
    await run();
    fx.claimRows = [claimRow({ attempts: 3 })];
    await run();
    expect(fx.postCalls).toHaveLength(2);
    expect(fx.postCalls[1]!.body).toBe(fx.postCalls[0]!.body);
    expect(fx.postCalls[1]!.headers["X-Tayf-Delivery"]).toBe(fx.postCalls[0]!.headers["X-Tayf-Delivery"]);
  });

  it("a 2xx marks the delivery delivered and resets the fail streak", async () => {
    fx.webhooks = [webhook({ fail_streak: 4 })];
    fx.claimRows = [claimRow()];
    fx.postResults = [{ status: 204 }];
    const body = await (await run()).json();
    expect(body).toMatchObject({ ok: true, delivered: 1, retried: 0, failed: 0 });
    const dUpdate = supabaseFake.calls.update("api_key_webhook_deliveries")[0]!;
    expect(dUpdate.patch).toMatchObject({ status: "delivered", last_status: 204, last_error: null });
    expect((dUpdate.patch as { delivered_at: string }).delivered_at).toBeTruthy();
    expect(dUpdate.state.eq).toContainEqual({ col: "id", val: 501 });
    const wUpdate = supabaseFake.calls.update("api_key_webhooks")[0]!;
    expect(wUpdate.patch).toMatchObject({ fail_streak: 0, last_status: 204 });
    expect((wUpdate.patch as { last_success_at: string }).last_success_at).toBeTruthy();
    expect(wUpdate.state.eq).toContainEqual({ col: "key_id", val: 7 });
  });

  it("a 500 re-queues as pending with the 1 minute backoff and bumps the streak", async () => {
    fx.claimRows = [claimRow({ attempts: 1 })];
    fx.postResults = [{ status: 500 }];
    const t0 = Date.now();
    const body = await (await run()).json();
    expect(body).toMatchObject({ delivered: 0, retried: 1, failed: 0 });
    const patch = supabaseFake.calls.update("api_key_webhook_deliveries")[0]!.patch as {
      status: string;
      next_attempt_at: string;
      last_status: number;
    };
    expect(patch.status).toBe("pending");
    expect(patch.last_status).toBe(500);
    const delta = Date.parse(patch.next_attempt_at) - t0;
    expect(delta).toBeGreaterThan(55_000);
    expect(delta).toBeLessThan(70_000);
    const w = supabaseFake.calls.update("api_key_webhooks")[0]!.patch as { fail_streak: number; last_failure_at: string };
    expect(w.fail_streak).toBe(1);
    expect(w.last_failure_at).toBeTruthy();
  });

  it("uses the 5 / 15 / 60 minute steps on later attempts", async () => {
    for (const [attempts, minutes] of [[2, 5], [3, 15], [4, 60]] as const) {
      supabaseFake.calls.mutations.length = 0;
      fx.claimRows = [claimRow({ attempts })];
      fx.postResults = [{ error: "timeout" }];
      const t0 = Date.now();
      await run();
      const patch = supabaseFake.calls.update("api_key_webhook_deliveries")[0]!.patch as { next_attempt_at: string };
      const delta = Date.parse(patch.next_attempt_at) - t0;
      expect(Math.abs(delta - minutes * 60_000)).toBeLessThan(10_000);
    }
  });

  it("marks the delivery failed once MAX_ATTEMPTS is reached", async () => {
    fx.claimRows = [claimRow({ attempts: 5 })];
    fx.postResults = [{ status: 503 }];
    const body = await (await run()).json();
    expect(body).toMatchObject({ retried: 0, failed: 1 });
    const patch = supabaseFake.calls.update("api_key_webhook_deliveries")[0]!.patch as Record<string, unknown>;
    expect(patch.status).toBe("failed");
    expect(patch).not.toHaveProperty("next_attempt_at");
  });

  it("a row reclaimed past MAX_ATTEMPTS is failed without any POST (no infinite stale loop)", async () => {
    fx.claimRows = [claimRow({ attempts: 6 })];
    const body = await (await run()).json();
    expect(fx.postCalls).toHaveLength(0);
    expect(body).toMatchObject({ delivered: 0, retried: 0, failed: 1 });
    const upd = supabaseFake.calls.update("api_key_webhook_deliveries")[0]!;
    expect(upd.patch).toMatchObject({ status: "failed", last_error: "attempts_exceeded" });
    expect(upd.patch).not.toHaveProperty("next_attempt_at");
    expect(upd.state.eq).toContainEqual({ col: "id", val: 501 });
    expect(upd.state.eq).toContainEqual({ col: "status", val: "sending" });
  });

  it("only the over-ceiling row is short-circuited; a live row in the same batch is still delivered", async () => {
    fx.claimRows = [claimRow({ id: 501, attempts: 9 }), claimRow({ id: 502, attempts: 1 })];
    fx.postResults = [{ status: 204 }];
    const body = await (await run()).json();
    expect(fx.postCalls).toHaveLength(1);
    expect(fx.postCalls[0]!.headers["X-Tayf-Delivery"]).toBe("502");
    expect(body).toMatchObject({ delivered: 1, failed: 1 });
  });

  it("a 302 or a 4xx is terminally failed at once (no redirect following, no retry)", async () => {
    fx.claimRows = [claimRow({ attempts: 1 })];
    fx.postResults = [{ status: 302 }];
    const body = await (await run()).json();
    expect(body).toMatchObject({ retried: 0, failed: 1 });
    expect(supabaseFake.calls.update("api_key_webhook_deliveries")[0]!.patch).toMatchObject({
      status: "failed",
      last_status: 302,
    });
    expect(fx.postCalls).toHaveLength(1);
  });

  it("disables the webhook on the 20th consecutive failure", async () => {
    fx.webhooks = [webhook({ fail_streak: 19 })];
    fx.claimRows = [claimRow()];
    fx.postResults = [{ status: 500 }];
    await run();
    const w = supabaseFake.calls.update("api_key_webhooks")[0]!.patch as Record<string, unknown>;
    expect(w).toMatchObject({ fail_streak: 20, enabled: false, disabled_reason: "too_many_failures" });
  });

  it("does not disable at the 19th failure", async () => {
    fx.webhooks = [webhook({ fail_streak: 18 })];
    fx.claimRows = [claimRow()];
    fx.postResults = [{ status: 500 }];
    await run();
    const w = supabaseFake.calls.update("api_key_webhooks")[0]!.patch as Record<string, unknown>;
    expect(w.fail_streak).toBe(19);
    expect(w).not.toHaveProperty("enabled");
  });

  it("returns a 500 (not a crash) when the claim RPC errors", async () => {
    fx.claimError = { message: "rpc down" };
    const res = await run();
    expect(res.status).toBe(500);
  });

  it("never writes the secret, the URL path or a body to any console method", async () => {
    fx.items = [item("one_zone_silent", IDS)];
    fx.claimRows = [claimRow(), claimRow({ id: 502, alert_id: `blindspot:${ID2}` })];
    fx.postResults = [{ status: 500 }, { error: "network" }];
    await run();
    fx.health = null;
    await run();
    const logged = spies
      .flatMap((s) => s.mock.calls)
      .map((args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "))
      .join("\n");
    expect(logged).not.toContain(SECRET_A);
    expect(logged).not.toContain("secret-path-token");
    expect(logged).not.toContain("tayf.alert");
  });
});
