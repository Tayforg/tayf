import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for /api/cron/digest (Vercel cron, runtime: nodejs).
//
// Content assembly (clusters/blindspot -> HTML) is covered by
// src/lib/digest/template.test.ts; these tests exercise the route's own
// job: bearer auth, "due" subscriber selection, batch send, and the
// last_sent_at write-back. Content-source modules are mocked with fixed
// fixtures so this file doesn't need to replicate their query shape.
// ---------------------------------------------------------------------------

interface SubscriberFixture {
  id: string;
  email: string;
  unsubscribe_token: string;
  last_sent_at: string | null;
}

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../../_helpers/supabase-fake");
  const state: {
    subscribers: SubscriberFixture[];
    /** When set, a subscriber page whose range starts at or after this row fails. */
    errorFromRow: number | null;
    /** One entry per subscriber SELECT (one per page), recorded from the builder state. */
    pages: Array<{
      range: { from: number; to: number } | null;
      order: Array<{ col: string; opts: unknown }>;
      not: Array<{ col: string; op: string; val: unknown }>;
    }>;
  } = { subscribers: [], errorFromRow: null, pages: [] };
  const fake = helper.createSupabaseFake({
    tables: {
      // Range-aware like PostgREST: rows from..to inclusive of the ordered table.
      newsletter_subscribers: (s) => {
        // A last_sent_at UPDATE resolves through the same handler; only SELECTs are pages.
        if (s.selectArgs.length === 0) return { data: state.subscribers, error: null };
        state.pages.push({ range: s.range, order: s.order, not: s.not });
        if (state.errorFromRow !== null && (s.range?.from ?? 0) >= state.errorFromRow) {
          return { data: null, error: { message: "statement timeout" } };
        }
        const data = s.range ? state.subscribers.slice(s.range.from, s.range.to + 1) : state.subscribers;
        return { data, error: null };
      },
    },
  });
  return { fake, state };
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.fake.client,
}));

// after() throws outside a request scope, so withCronOutcome (h12-ops-1) would log
// a warning on every authenticated call here. Capture the callbacks instead; the
// outcome test below runs them.
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

// Digest content: fixed fixtures. What actually renders into HTML is the
// template module's job (template.test.ts); this file just needs a
// non-empty, deterministic payload so buildDigestHtml doesn't throw.
vi.mock("@/lib/clusters/politics-query", () => ({
  getPoliticsClusters: vi.fn(async () => ({
    bundles: [
      {
        cluster: {
          id: "c1",
          title_tr: "Test cluster",
          summary_tr: "Test summary",
          bias_distribution: {},
          is_blindspot: false,
          blindspot_side: null,
          article_count: 5,
          first_published: "2026-01-01T00:00:00Z",
          updated_at: "2026-01-01T00:00:00Z",
        },
        articles: [{}, {}, {}, {}, {}],
        sources: [],
      },
    ],
    breakingBundles: [],
    prefilterCount: 1,
  })),
}));

vi.mock("@/lib/clusters/blindspots-query", () => ({
  getBlindspots: vi.fn(async () => ({ bundles: [] })),
}));

// BL-13: rights-attribution member lookup. Default resolves to no members
// found for any cluster id, so pre-existing tests (which don't care about
// summary text) fall through to summaryAttributionWithoutMembers's
// non-wire, non-empty-text path unchanged. Per-test overrides below drive
// the actual gate.
vi.mock("@/lib/clusters/rss-summary-attribution", () => ({
  getRssSummaryMembers: vi.fn(async () => ({ members: {}, lookupFailed: false })),
}));

vi.mock("@/lib/site-url", () => ({
  siteUrl: () => "https://test.tayfhaber.com",
}));

vi.mock("@/lib/email/resend", () => ({
  sendBatch: vi.fn(),
  // Default true (mail configured) so every pre-existing test in this file
  // keeps exercising the normal send path unchanged; the RESEND_API_KEY-
  // absent test below overrides this per-case.
  isMailConfigured: vi.fn(() => true),
}));

// (H) silent-failures-3: per-item catch sites report to Sentry with a
// subscriberId (never an email) in the context. Mocked so these tests don't
// depend on a real Sentry init.
vi.mock("@/lib/sentry/server", () => ({
  captureServerException: vi.fn(),
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.CRON_SECRET;
  supabaseFake.state.subscribers = [];
  supabaseFake.state.errorFromRow = null;
  supabaseFake.state.pages = [];
  supabaseFake.fake.calls.mutations.length = 0;
  supabaseFake.fake.calls.rpc.length = 0;
  afterCallbacks.length = 0;
  // vi.resetModules() (afterEach) re-evaluates route.ts but the mocked
  // "@/lib/email/resend" module factory only runs once, so the same
  // vi.fn() instance carries call history across tests without this.
  const { sendBatch, isMailConfigured } = await import("@/lib/email/resend");
  (sendBatch as unknown as Mock).mockReset();
  (isMailConfigured as unknown as Mock).mockReset();
  (isMailConfigured as unknown as Mock).mockReturnValue(true);
  const { captureServerException } = await import("@/lib/sentry/server");
  (captureServerException as unknown as Mock).mockReset();
  const { getRssSummaryMembers } = await import(
    "@/lib/clusters/rss-summary-attribution"
  );
  (getRssSummaryMembers as unknown as Mock).mockReset();
  (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
    members: {},
    lookupFailed: false,
  });
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.resetModules();
});

async function importRoute() {
  return await import("@/app/api/cron/digest/route");
}

function req(bearer?: string): Request {
  return new Request("http://example.com/api/cron/digest", {
    headers: bearer ? { Authorization: `Bearer ${bearer}` } : {},
  });
}

describe("GET /api/cron/digest", () => {
  it("FAIL-CLOSED: returns 503 when CRON_SECRET is unset", async () => {
    const mod = await importRoute();
    const res = await mod.GET(req("anything"));
    expect(res.status).not.toBe(200);
    expect([503, 500]).toContain(res.status);
  });

  it("returns 401 when the bearer token is missing or wrong", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await importRoute();

    const noAuth = await mod.GET(req());
    expect(noAuth.status).toBe(401);

    const wrong = await mod.GET(req("nope"));
    expect(wrong.status).toBe(401);
  });

  it("records only the authenticated run, as route 'digest' with the response status (withCronOutcome, h12-ops-1)", async () => {
    process.env.CRON_SECRET = "shhh";
    const mod = await importRoute();

    expect((await mod.GET(req())).status).toBe(401);
    expect((await mod.GET(req("nope"))).status).toBe(401);
    expect(afterCallbacks).toHaveLength(0);

    const res = await mod.GET(req("shhh"));
    expect(afterCallbacks).toHaveLength(1);
    expect(supabaseFake.fake.calls.rpc).toHaveLength(0);
    await afterCallbacks[0]!();

    const recorded = supabaseFake.fake.calls.rpc.filter((c) => c.name === "ops_cron_route_run_record");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.args).toEqual({
      p_route: "digest",
      p_status: res.status,
      p_duration_ms: expect.any(Number),
    });
  });

  it("sends only to due confirmed subscribers and updates their last_sent_at", async () => {
    process.env.CRON_SECRET = "shhh";
    const now = Date.now();
    const tenDaysAgo = new Date(now - 10 * 24 * 3600 * 1000).toISOString();
    const oneDayAgo = new Date(now - 1 * 24 * 3600 * 1000).toISOString();

    // never-sent (due), recently-sent (not due), stale-sent (due).
    supabaseFake.state.subscribers = [
      { id: "s1", email: "never@example.com", unsubscribe_token: "t1", last_sent_at: null },
      { id: "s2", email: "recent@example.com", unsubscribe_token: "t2", last_sent_at: oneDayAgo },
      { id: "s3", email: "stale@example.com", unsubscribe_token: "t3", last_sent_at: tenDaysAgo },
    ];

    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sent: 2, skipped: 0 });

    // Only the two due subscribers were handed to sendBatch.
    const sentTo = (sendBatch as unknown as Mock).mock.calls[0]![0].map(
      (m: { to: string }) => m.to,
    );
    expect(sentTo.sort()).toEqual(["never@example.com", "stale@example.com"]);

    // Only those two rows got a last_sent_at write; the recently-sent one
    // is untouched.
    const updates = supabaseFake.fake.calls.update("newsletter_subscribers");
    const updatedIds = updates
      .map((u) => (u.state.eq.find((p) => p.col === "id")?.val as string | undefined))
      .sort();
    expect(updatedIds).toEqual(["s1", "s3"]);
    for (const u of updates) {
      expect((u.patch as { last_sent_at?: string }).last_sent_at).toBeTruthy();
    }
  });

  describe("subscriber paging (PostgREST caps one response at 1,000 rows)", () => {
    function manySubscribers(n: number): SubscriberFixture[] {
      return Array.from({ length: n }, (_, i) => ({
        id: `s${String(i).padStart(5, "0")}`,
        email: `user${i}@example.com`,
        unsubscribe_token: `t${i}`,
        last_sent_at: null,
      }));
    }

    it("reads both pages of 1,001 confirmed, due subscribers and processes every one of them", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = manySubscribers(1001);

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1001, skipped: 0 });

      // Page 1 is full, so page 2 is read; the 1,001st subscriber is on it.
      expect(supabaseFake.state.pages.map((p) => p.range)).toEqual([
        { from: 0, to: 999 },
        { from: 1000, to: 1999 },
      ]);

      const recipients = (sendBatch as unknown as Mock).mock.calls.flatMap(
        (call) => (call[0] as Array<{ to: string }>).map((m) => m.to),
      );
      expect(recipients).toHaveLength(1001);
      expect(new Set(recipients).size).toBe(1001);
      expect(recipients).toContain("user1000@example.com");

      const stamped = supabaseFake.fake.calls
        .update("newsletter_subscribers")
        .map((u) => u.state.eq.find((p) => p.col === "id")?.val);
      expect(stamped).toHaveLength(1001);
      expect(stamped).toContain("s01000");
    });

    it("pages with a unique per-row order (id asc) and keeps the confirmed-only filter on every page", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = manySubscribers(1001);
      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      await mod.GET(req("shhh"));

      expect(supabaseFake.state.pages).toHaveLength(2);
      for (const page of supabaseFake.state.pages) {
        expect(page.order).toEqual([{ col: "id", opts: { ascending: true } }]);
        expect(page.not).toContainEqual({ col: "confirmed_at", op: "is", val: null });
      }
    });

    it("a short first page costs a single request", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = manySubscribers(3);
      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 3, skipped: 0 });
      expect(supabaseFake.state.pages).toHaveLength(1);
    });

    it("an error on page 2 returns the same 500 as before and sends nothing (no half-read list)", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = manySubscribers(1001);
      supabaseFake.state.errorFromRow = 1000;
      const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      const { sendBatch } = await import("@/lib/email/resend");

      try {
        const mod = await importRoute();
        const res = await mod.GET(req("shhh"));
        expect(res.status).toBe(500);
      } finally {
        errSpy.mockRestore();
      }

      expect(sendBatch).not.toHaveBeenCalled();
      expect(supabaseFake.fake.calls.update("newsletter_subscribers")).toHaveLength(0);
    });
  });

  it("carries List-Unsubscribe / List-Unsubscribe-Post headers matching the html unsubscribe link's token", async () => {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "never@example.com", unsubscribe_token: "t-1", last_sent_at: null },
    ];

    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);

    const item = (sendBatch as unknown as Mock).mock.calls[0]![0][0] as {
      headers?: Record<string, string>;
      html: string;
    };
    expect(item.headers).toEqual({
      "List-Unsubscribe": "<https://test.tayfhaber.com/api/newsletter/unsubscribe?token=t-1>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(item.html).toContain(
      "https://test.tayfhaber.com/api/newsletter/unsubscribe?token=t-1",
    );
  });

  it("does not update last_sent_at for a subscriber whose send failed", async () => {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      { id: "s2", email: "fails@example.com", unsubscribe_token: "t2", last_sent_at: null },
    ];

    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map((m) =>
        m.to === "fails@example.com"
          ? { ok: false, error: "Resend 500" }
          : { ok: true, id: "resend-id" },
      ),
    );

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    const body = await res.json();
    expect(body).toEqual({ sent: 1, skipped: 1 });

    const updates = supabaseFake.fake.calls.update("newsletter_subscribers");
    expect(updates).toHaveLength(1);
    expect(updates[0]?.state.eq.find((p) => p.col === "id")?.val).toBe("s1");
  });

  it("reads its content through the uncapped batch profile (the 4 s reader cap must not abort a weekly digest)", async () => {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "never@example.com", unsubscribe_token: "t1", last_sent_at: null },
    ];
    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );
    const { getPoliticsClusters } = await import("@/lib/clusters/politics-query");
    const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
    (getPoliticsClusters as unknown as Mock).mockClear();
    (getBlindspots as unknown as Mock).mockClear();

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    expect(getPoliticsClusters).toHaveBeenCalledWith({ profile: "batch" });
    expect(getBlindspots).toHaveBeenCalledWith({ profile: "batch" });
  });

  it("looks up the rights-gated summary members through the uncapped batch profile too", async () => {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "never@example.com", unsubscribe_token: "t1", last_sent_at: null },
    ];
    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );
    const { getRssSummaryMembers } = await import(
      "@/lib/clusters/rss-summary-attribution"
    );
    (getRssSummaryMembers as unknown as Mock).mockClear();

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    expect(getRssSummaryMembers).toHaveBeenCalledTimes(1);
    expect(getRssSummaryMembers).toHaveBeenCalledWith(expect.any(Array), {
      profile: "batch",
    });
  });

  it("skips sending entirely (0/0) when no subscriber is due", async () => {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      {
        id: "s1",
        email: "recent@example.com",
        unsubscribe_token: "t1",
        last_sent_at: new Date().toISOString(),
      },
    ];

    const { sendBatch } = await import("@/lib/email/resend");

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sent: 0, skipped: 0 });
    expect(sendBatch).not.toHaveBeenCalled();
  });

  it("short-circuits with skipped:true and performs no Supabase query when RESEND_API_KEY is not set", async () => {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "never@example.com", unsubscribe_token: "t1", last_sent_at: null },
    ];

    const { sendBatch, isMailConfigured } = await import("@/lib/email/resend");
    (isMailConfigured as unknown as Mock).mockReturnValue(false);

    const fromSpy = vi.spyOn(supabaseFake.fake.client, "from");

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      skipped: true,
      reason: "RESEND_API_KEY not set",
      sent: 0,
    });

    // Fail-closed means fail BEFORE touching the database: no subscriber
    // select, no last_sent_at update, no send attempt at all.
    expect(fromSpy).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();

    fromSpy.mockRestore();
  });

  describe("BL-13 excerpt_allowed gate", () => {
    it("does not render clusters.summary_tr in the email when every matching member's source has excerpt_allowed: false", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];

      const { getRssSummaryMembers } = await import(
        "@/lib/clusters/rss-summary-attribution"
      );
      (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
        members: {
          c1: [
            {
              source: { name: "Blocked Kaynak", bias: "center", excerpt_allowed: false },
              article: {
                published_at: "2026-01-01T00:00:00Z",
                content_hash: null,
                description: "Test summary",
              },
            },
          ],
        },
        lookupFailed: false,
      });

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(res.status).toBe(200);

      const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(html).not.toContain("Test summary");
    });

    it("control: renders clusters.summary_tr when the matching member's source allows excerpt reuse", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];

      const { getRssSummaryMembers } = await import(
        "@/lib/clusters/rss-summary-attribution"
      );
      (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
        members: {
          c1: [
            {
              source: { name: "Allowed Kaynak", bias: "center", excerpt_allowed: true },
              article: {
                published_at: "2026-01-01T00:00:00Z",
                content_hash: null,
                description: "Test summary",
              },
            },
          ],
        },
        lookupFailed: false,
      });

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(res.status).toBe(200);

      const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(html).toContain("Test summary");
    });

    it("fail-closed: omits clusters.summary_tr from the email when the member lookup itself fails, even though the fixture summary text would otherwise be shown", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];

      const { getRssSummaryMembers } = await import(
        "@/lib/clusters/rss-summary-attribution"
      );
      // No members entry for c1 at all, flagged as a failed lookup — must
      // not fall through to summaryAttributionWithoutMembers, which would
      // otherwise render "Test summary" raw with no excerpt_allowed check.
      (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
        members: {},
        lookupFailed: true,
      });

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(res.status).toBe(200);

      const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(html).not.toContain("Test summary");
    });
  });

  describe("logging", () => {
    let errSpy: ReturnType<typeof vi.spyOn>;
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      errSpy.mockRestore();
      warnSpy.mockRestore();
    });

    it("never logs a subscriber's e-mail address, even on a send failure", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
        { id: "s2", email: "fails@example.com", unsubscribe_token: "t2", last_sent_at: null },
      ];

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map((m) =>
          m.to === "fails@example.com"
            ? { ok: false, error: "Resend 500" }
            : { ok: true, id: "resend-id" },
        ),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1, skipped: 1 });

      const loggedText = JSON.stringify([...errSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(loggedText).not.toContain("@");
      expect(loggedText).not.toContain("fails@example.com");
      expect(loggedText).toContain("s2");
    });

    it("never logs a recipient address even when Resend's own error body echoes it back", async () => {
      // Resend-shaped validation errors can embed the submitted `to`
      // address in the response body (`result.error` in the route is
      // built straight from that raw text — see src/lib/email/resend.ts).
      // A synthetic PII-free string like "Resend 500" would pass this test
      // even if the route logged `result.error` verbatim, so this fixture
      // mimics a real Resend error payload that contains the address.
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
        { id: "s2", email: "fails@example.com", unsubscribe_token: "t2", last_sent_at: null },
      ];

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map((m) =>
          m.to === "fails@example.com"
            ? {
                ok: false,
                error: 'Resend 422: {"message":"Invalid to: fails@example.com"}',
              }
            : { ok: true, id: "resend-id" },
        ),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 1, skipped: 1 });

      const loggedText = JSON.stringify(errSpy.mock.calls);
      expect(loggedText).not.toContain("fails@example.com");
      expect(loggedText).not.toContain("@");
      expect(loggedText).toContain("s2");
      expect(loggedText).toContain("Resend 422");
    });

    it("logs an aggregate send-failures warning with counts only", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
        { id: "s2", email: "fails@example.com", unsubscribe_token: "t2", last_sent_at: null },
      ];

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map((m) =>
          m.to === "fails@example.com"
            ? { ok: false, error: "Resend 500" }
            : { ok: true, id: "resend-id" },
        ),
      );

      const mod = await importRoute();
      await mod.GET(req("shhh"));

      expect(warnSpy).toHaveBeenCalledWith(
        "[digest-cron] send failures",
        expect.objectContaining({ sent: 1, skipped: 1 }),
      );
    });

    it("logs no console.warn at all on the all-success path", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(await res.json()).toEqual({ sent: 1, skipped: 0 });

      expect(warnSpy).not.toHaveBeenCalled();
    });
  });

  describe("Sentry reporting (H)", () => {
    it("reports a per-subscriber send failure with subscriberId (never an email) in the context", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
        { id: "s2", email: "fails@example.com", unsubscribe_token: "t2", last_sent_at: null },
      ];

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map((m) =>
          m.to === "fails@example.com"
            ? { ok: false, error: "Resend 500" }
            : { ok: true, id: "resend-id" },
        ),
      );

      const { captureServerException } = await import("@/lib/sentry/server");

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(await res.json()).toEqual({ sent: 1, skipped: 1 });

      expect(captureServerException).toHaveBeenCalledTimes(1);
      const [, context] = (captureServerException as unknown as Mock).mock.calls[0]!;
      expect(context).toEqual({ subscriberId: "s2" });
      expect(JSON.stringify(context)).not.toContain("@");
    });

    it("does not report to Sentry on the all-success happy path", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];

      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const { captureServerException } = await import("@/lib/sentry/server");

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      expect(await res.json()).toEqual({ sent: 1, skipped: 0 });

      expect(captureServerException).not.toHaveBeenCalled();
    });
  });
});
