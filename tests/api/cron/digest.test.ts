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
  const state: { subscribers: SubscriberFixture[] } = { subscribers: [] };
  const fake = helper.createSupabaseFake({
    tables: {
      newsletter_subscribers: () => ({ data: state.subscribers, error: null }),
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

const ORIGINAL_ENV = { ...process.env };

beforeEach(async () => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  delete process.env.CRON_SECRET;
  supabaseFake.state.subscribers = [];
  supabaseFake.fake.calls.mutations.length = 0;
  supabaseFake.fake.calls.rpc.length = 0;
  // vi.resetModules() (afterEach) re-evaluates route.ts but the mocked
  // "@/lib/email/resend" module factory only runs once, so the same
  // vi.fn() instance carries call history across tests without this.
  const { sendBatch, isMailConfigured } = await import("@/lib/email/resend");
  (sendBatch as unknown as Mock).mockReset();
  (isMailConfigured as unknown as Mock).mockReset();
  (isMailConfigured as unknown as Mock).mockReturnValue(true);
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
});
