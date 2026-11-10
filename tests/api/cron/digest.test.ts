import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
    /** When set, every last_sent_at UPDATE fails with it (W3). */
    updateError: { message: string; code?: string } | null;
    /** The next N last_sent_at UPDATEs fail with a transient error, then they succeed. */
    updateFailuresLeft: number;
    /** One entry per subscriber SELECT (one per page), recorded from the builder state. */
    pages: Array<{
      range: { from: number; to: number } | null;
      order: Array<{ col: string; opts: unknown }>;
      not: Array<{ col: string; op: string; val: unknown }>;
    }>;
  } = { subscribers: [], errorFromRow: null, updateError: null, updateFailuresLeft: 0, pages: [] };
  const fake = helper.createSupabaseFake({
    tables: {
      // Range-aware like PostgREST: rows from..to inclusive of the ordered table.
      newsletter_subscribers: (s) => {
        // A last_sent_at UPDATE resolves through the same handler; only SELECTs are pages.
        if (s.selectArgs.length === 0) {
          if (state.updateFailuresLeft > 0) {
            state.updateFailuresLeft--;
            return { data: state.subscribers, error: { message: "transient blip" } };
          }
          return { data: state.subscribers, error: state.updateError };
        }
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
// h71-timebounds-1: the digest reads the trailing week through
// getWeeklyDigestClusters (a plain ClusterBundle[] in article_count order),
// not the home-feed pool; the window itself is covered by
// src/lib/clusters/politics-query.weekly-digest.test.ts.
vi.mock("@/lib/clusters/politics-query", () => ({
  getWeeklyDigestClusters: vi.fn(async () => [
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
  ]),
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
  supabaseFake.state.updateError = null;
  supabaseFake.state.updateFailuresLeft = 0;
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
  // A per-test getBlindspots.mockResolvedValue must not leak into later tests
  // (order-dependent under --sequence.shuffle).
  const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
  (getBlindspots as unknown as Mock).mockReset();
  (getBlindspots as unknown as Mock).mockResolvedValue({ bundles: [] });
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
    expect(body).toEqual({ sent: 2, skipped: 0, substepErrors: 0 });

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
      expect(await res.json()).toEqual({ sent: 1001, skipped: 0, substepErrors: 0 });

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

      expect(await res.json()).toEqual({ sent: 3, skipped: 0, substepErrors: 0 });
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
    expect(body).toEqual({ sent: 1, skipped: 1, substepErrors: 0 });

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
    const { getWeeklyDigestClusters } = await import("@/lib/clusters/politics-query");
    const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
    (getWeeklyDigestClusters as unknown as Mock).mockClear();
    (getBlindspots as unknown as Mock).mockClear();

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    expect(getWeeklyDigestClusters).toHaveBeenCalledWith(
      expect.objectContaining({ profile: "batch" }),
    );
    expect(getBlindspots).toHaveBeenCalledWith({ profile: "batch" });
  });

  describe("weekly content window (h71-timebounds-1)", () => {
    function storyBundle(id: string, title: string, articleCount: number) {
      return {
        cluster: {
          id,
          title_tr: title,
          summary_tr: "",
          bias_distribution: {},
          is_blindspot: false,
          blindspot_side: null,
          article_count: articleCount,
          first_published: "2026-11-03T10:00:00Z",
          updated_at: "2026-11-03T10:00:00Z",
        },
        articles: Array.from({ length: articleCount }, () => ({})),
        sources: [],
      };
    }

    async function runDigest() {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "never@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];
      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );
      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));
      return { res, sendBatch: sendBatch as unknown as Mock };
    }

    it("reads the week once, with the batch profile and the request-time clock as nowMs", async () => {
      const { getWeeklyDigestClusters } = await import("@/lib/clusters/politics-query");
      (getWeeklyDigestClusters as unknown as Mock).mockClear();

      // Only Date is faked (timers and promises stay real). The route module
      // loads at T_LOAD and the request lands at T_REQUEST: nowMs must be the
      // second, i.e. read per request, never captured at module load.
      const T_LOAD = Date.parse("2026-11-07T05:59:00Z");
      const T_REQUEST = Date.parse("2026-11-07T06:00:00Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(T_LOAD);
        process.env.CRON_SECRET = "shhh";
        supabaseFake.state.subscribers = [
          { id: "s1", email: "never@example.com", unsubscribe_token: "t1", last_sent_at: null },
        ];
        const { sendBatch } = await import("@/lib/email/resend");
        (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
          list.map(() => ({ ok: true, id: "resend-id" })),
        );
        const mod = await importRoute();
        vi.setSystemTime(T_REQUEST);
        const res = await mod.GET(req("shhh"));
        expect(res.status).toBe(200);
      } finally {
        vi.useRealTimers();
      }

      expect(getWeeklyDigestClusters).toHaveBeenCalledTimes(1);
      expect(getWeeklyDigestClusters).toHaveBeenCalledWith({
        nowMs: T_REQUEST,
        profile: "batch",
      });
    });

    it("no longer reads the home-feed pool: route.ts never mentions the home fetcher", () => {
      const src = readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "../../../src/app/api/cron/digest/route.ts"),
        "utf8",
      );
      expect(src).not.toContain("getPoliticsClusters");
      expect(src).toContain("getWeeklyDigestClusters");
    });

    it("renders the first five stories in the reader's order and leaves the sixth out", async () => {
      const { getWeeklyDigestClusters } = await import("@/lib/clusters/politics-query");
      // Ascending article counts on purpose: a route that re-sorted by count
      // would reverse this order, and the sixth must still be cut by position.
      (getWeeklyDigestClusters as unknown as Mock).mockResolvedValueOnce([
        storyBundle("w1", "Birinci Hikaye", 2),
        storyBundle("w2", "Ikinci Hikaye", 3),
        storyBundle("w3", "Ucuncu Hikaye", 4),
        storyBundle("w4", "Dorduncu Hikaye", 5),
        storyBundle("w5", "Besinci Hikaye", 6),
        storyBundle("w6", "Altinci Hikaye", 7),
      ]);

      const { res, sendBatch } = await runDigest();
      expect(res.status).toBe(200);

      const html = sendBatch.mock.calls[0]![0][0].html as string;
      const positions = [
        "Birinci Hikaye",
        "Ikinci Hikaye",
        "Ucuncu Hikaye",
        "Dorduncu Hikaye",
        "Besinci Hikaye",
      ].map((title) => html.indexOf(title));
      expect(positions.every((p) => p >= 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
      expect(html).not.toContain("Altinci Hikaye");
    });

    it("hands getRssSummaryMembers exactly the five clusters it renders", async () => {
      const { getWeeklyDigestClusters } = await import("@/lib/clusters/politics-query");
      (getWeeklyDigestClusters as unknown as Mock).mockResolvedValueOnce(
        Array.from({ length: 8 }, (_, i) => storyBundle(`w${i + 1}`, `Hikaye ${i + 1}`, 10 - i)),
      );
      const { getRssSummaryMembers } = await import("@/lib/clusters/rss-summary-attribution");
      (getRssSummaryMembers as unknown as Mock).mockClear();

      await runDigest();
      expect((getRssSummaryMembers as unknown as Mock).mock.calls[0]![0]).toEqual([
        "w1",
        "w2",
        "w3",
        "w4",
        "w5",
      ]);
    });

    it("an empty week still sends the template's empty-state copy rather than failing", async () => {
      const { getWeeklyDigestClusters } = await import("@/lib/clusters/politics-query");
      (getWeeklyDigestClusters as unknown as Mock).mockResolvedValueOnce([]);

      const { res, sendBatch } = await runDigest();
      expect(res.status).toBe(200);
      const html = sendBatch.mock.calls[0]![0][0].html as string;
      expect(html).toContain("Bu hafta öne çıkan bir hikâye yok.");
    });

    it("a failed week read is a 500, never a mail built from nothing", async () => {
      const { getWeeklyDigestClusters } = await import("@/lib/clusters/politics-query");
      (getWeeklyDigestClusters as unknown as Mock).mockRejectedValueOnce(
        new Error("[clusters] weekly digest select error: statement timeout"),
      );

      const { res, sendBatch } = await runDigest();
      expect(res.status).toBe(500);
      expect(sendBatch).not.toHaveBeenCalled();
    });
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
      // h87-newsletter-1: hidden entirely means no attribution heading either.
      expect(html).not.toContain("Özet —");
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
      // h87-newsletter-1: the excerpt is one outlet's words and carries the cluster page's heading.
      expect(html).toContain("Özet — Allowed Kaynak");
      expect(html.indexOf("Özet — Allowed Kaynak")).toBeLessThan(html.indexOf("Test summary"));
    });

    it("h87-newsletter-1: no member holds the text, so the label is the cluster page's 'Özet — Kaynak açıklaması', never an outlet", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];
      const { getRssSummaryMembers } = await import("@/lib/clusters/rss-summary-attribution");
      (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
        members: {
          c1: [
            {
              source: { name: "Baska Kaynak", bias: "center", excerpt_allowed: true },
              article: {
                published_at: "2026-01-01T00:00:00Z",
                content_hash: null,
                description: "Tamamen farkli bir aciklama",
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
      expect((await mod.GET(req("shhh"))).status).toBe(200);

      const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(html).toContain("Test summary");
      expect(html).toContain("Özet — Kaynak açıklaması");
      expect(html).not.toContain("Özet — Baska Kaynak");
      expect(html.indexOf("Özet — Kaynak açıklaması")).toBeLessThan(html.indexOf("Test summary"));
    });

    it("h87-newsletter-1: the degraded no-members path (lookup ran, cluster has none) also labels the excerpt", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];
      // beforeEach's default: members {} and lookupFailed false.
      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      const mod = await importRoute();
      expect((await mod.GET(req("shhh"))).status).toBe(200);

      const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(html).toContain("Özet — Kaynak açıklaması");
      expect(html.indexOf("Özet — Kaynak açıklaması")).toBeLessThan(html.indexOf("Test summary"));
    });

    it("h87-newsletter-1: the Kör Nokta excerpt is labelled with its own outlet, and hidden with its label when rights-blocked", async () => {
      process.env.CRON_SECRET = "shhh";
      supabaseFake.state.subscribers = [
        { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
      ];
      const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
      const blindspotBundle = {
        cluster: {
          id: "b1",
          title_tr: "Tek taraflı haber",
          summary_tr: "Kör nokta özeti",
          bias_distribution: {
            pro_government: 3, gov_leaning: 0, state_media: 0, center: 0, opposition_leaning: 0,
            opposition: 0, nationalist: 0, islamist_conservative: 0, pro_kurdish: 0, international: 0,
          },
        },
        sources: [],
        dominantZone: "iktidar",
        dominantPct: 1,
      };
      (getBlindspots as unknown as Mock).mockResolvedValue({ bundles: [blindspotBundle] });
      const memberOf = (name: string, excerptAllowed: boolean) => ({
        source: { name, bias: "pro_government", excerpt_allowed: excerptAllowed },
        article: { published_at: "2026-01-01T00:00:00Z", content_hash: null, description: "Kör nokta özeti" },
      });
      const { getRssSummaryMembers } = await import("@/lib/clusters/rss-summary-attribution");
      const { sendBatch } = await import("@/lib/email/resend");
      (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
        list.map(() => ({ ok: true, id: "resend-id" })),
      );

      (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
        members: { b1: [memberOf("Kor Kaynak", true)] },
        lookupFailed: false,
      });
      const mod = await importRoute();
      expect((await mod.GET(req("shhh"))).status).toBe(200);
      const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(html).toContain("Özet — Kor Kaynak");
      expect(html.indexOf("Özet — Kor Kaynak")).toBeLessThan(html.indexOf("Kör nokta özeti"));

      // Same bundle, but its only matching outlet has opted out: no excerpt and no heading.
      supabaseFake.state.subscribers = [
        { id: "s2", email: "ok2@example.com", unsubscribe_token: "t2", last_sent_at: null },
      ];
      (sendBatch as unknown as Mock).mockClear();
      (getRssSummaryMembers as unknown as Mock).mockResolvedValue({
        members: { b1: [memberOf("Kor Kaynak", false)] },
        lookupFailed: false,
      });
      expect((await mod.GET(req("shhh"))).status).toBe(200);
      const blocked = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
      expect(blocked).not.toContain("Kör nokta özeti");
      expect(blocked).not.toContain("Özet — Kor Kaynak");
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
      expect(html).not.toContain("Özet —");
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
      expect(await res.json()).toEqual({ sent: 1, skipped: 1, substepErrors: 0 });

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
      expect(await res.json()).toEqual({ sent: 1, skipped: 1, substepErrors: 0 });

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
      expect(await res.json()).toEqual({ sent: 1, skipped: 0, substepErrors: 0 });

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
      expect(await res.json()).toEqual({ sent: 1, skipped: 1, substepErrors: 0 });

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
      expect(await res.json()).toEqual({ sent: 1, skipped: 0, substepErrors: 0 });

      expect(captureServerException).not.toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// W3: a Supabase failure that the digest swallows used to leave the run at 200 with a
// plain `{ sent, skipped }`, so a tick that mailed subscribers but could not stamp
// last_sent_at (they would be mailed again next tick) looked healthy. The route now
// counts it (`updateError`) and a failed rights-gated summary member lookup
// (`memberLookupFailed`: the summaries are hidden, fail closed, but the run is
// degraded), reports `substepErrors` in the final body, and sets the internal header;
// withCronOutcome records 599 and strips it. A Resend send that fails is a vendor
// failure and is not counted.
// ---------------------------------------------------------------------------
describe("GET /api/cron/digest: sub-step failures are recorded as 599, answered as 200 (W3)", () => {
  const SUBSTEP_HEADER = "x-cron-substep-errors";
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
    ];
  });

  afterEach(() => {
    errSpy.mockRestore();
  });

  async function sendsOk() {
    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );
  }

  /** Runs the pending after() callbacks once, the way Next does once the response is on its way. */
  const flush = () => Promise.all(afterCallbacks.splice(0).map((cb) => cb()));
  /** Every `ops_cron_route_run_record` call (withCronOutcome's row for ops_health_report row 15). */
  const outcomeCalls = () => supabaseFake.fake.calls.rpc.filter((c) => c.name === "ops_cron_route_run_record");

  async function runRecorded() {
    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    const body = await res.json();
    await flush();
    return { res, body };
  }

  it("a clean run records 200 and reports substepErrors 0", async () => {
    await sendsOk();
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body).toEqual({ sent: 1, skipped: 0, substepErrors: 0 });
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "digest", p_status: 200 });
  });

  it("a failed last_sent_at update records 599 and answers 200 without the header", async () => {
    await sendsOk();
    supabaseFake.state.updateError = { message: "update boom", code: "57014" };
    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body).toEqual({ sent: 1, skipped: 0, substepErrors: 1 });
    expect(body.substepErrors).toBeGreaterThanOrEqual(1);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "digest", p_status: 599 });
  });

  it("counts one failure per subscriber whose last_sent_at could not be stamped", async () => {
    supabaseFake.state.subscribers = [
      { id: "s1", email: "a@example.com", unsubscribe_token: "t1", last_sent_at: null },
      { id: "s2", email: "b@example.com", unsubscribe_token: "t2", last_sent_at: null },
      { id: "s3", email: "c@example.com", unsubscribe_token: "t3", last_sent_at: null },
    ];
    await sendsOk();
    supabaseFake.state.updateError = { message: "update boom" };
    const { body } = await runRecorded();
    expect(body).toEqual({ sent: 3, skipped: 0, substepErrors: 3 });
  });

  it("a failed summary member lookup records 599: the summaries stay hidden (fail closed) and the mail still goes out", async () => {
    await sendsOk();
    const { getRssSummaryMembers } = await import("@/lib/clusters/rss-summary-attribution");
    (getRssSummaryMembers as unknown as Mock).mockResolvedValue({ members: {}, lookupFailed: true });
    const { sendBatch } = await import("@/lib/email/resend");

    const { res, body } = await runRecorded();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body).toEqual({ sent: 1, skipped: 0, substepErrors: 1 });
    const html = (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
    expect(html).not.toContain("Test summary");
    expect(html).not.toContain("Özet —");
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "digest", p_status: 599 });
  });

  it("a lookup failure and a failed stamp add up", async () => {
    await sendsOk();
    const { getRssSummaryMembers } = await import("@/lib/clusters/rss-summary-attribution");
    (getRssSummaryMembers as unknown as Mock).mockResolvedValue({ members: {}, lookupFailed: true });
    supabaseFake.state.updateError = { message: "update boom" };
    const { body } = await runRecorded();
    expect(body.substepErrors).toBe(2);
  });

  it("a send that fails at Resend (a vendor failure) is not counted: 200 recorded", async () => {
    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: false, error: "Resend 500" })),
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { body } = await runRecorded();
    warnSpy.mockRestore();

    expect(body).toEqual({ sent: 0, skipped: 1, substepErrors: 0 });
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "digest", p_status: 200 });
  });

  it("the 'nobody is due' body is the plain { sent: 0, skipped: 0 } and records 200", async () => {
    supabaseFake.state.subscribers = [
      { id: "s1", email: "recent@example.com", unsubscribe_token: "t1", last_sent_at: new Date().toISOString() },
    ];
    const { body } = await runRecorded();
    expect(body).toEqual({ sent: 0, skipped: 0 });
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "digest", p_status: 200 });
  });
});

// h57-outbound-1: toBlindspotItem hands the template the number of non-voting
// sources outside the dominant zone, from the bundle's de-duplicated sources
// (the helper /blindspots already uses), so the mail words "sadece" the same way.
describe("blindspot item wording (h57-outbound-1)", () => {
  type Src = { kind: string | null; bias: string };
  const VOTING: Src[] = [
    { kind: "outlet", bias: "pro_government" },
    { kind: "outlet", bias: "gov_leaning" },
    { kind: "wire", bias: "pro_government" },
  ];

  async function sentHtml(sources: Src[], distribution: Record<string, number>): Promise<string> {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
    ];
    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );
    const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
    (getBlindspots as unknown as Mock).mockResolvedValueOnce({
      bundles: [
        {
          cluster: {
            id: "b1",
            title_tr: "Tek taraflı haber",
            summary_tr: "",
            bias_distribution: {
              pro_government: 0, gov_leaning: 0, state_media: 0, center: 0, opposition_leaning: 0,
              opposition: 0, nationalist: 0, islamist_conservative: 0, pro_kurdish: 0, international: 0,
              ...distribution,
            },
          },
          sources,
          dominantZone: "iktidar",
          dominantPct: 1,
        },
      ],
    });
    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    return (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
  }

  it("prints 'Spektrumda sadece İktidar' when a non-voting source from another zone is in the bundle", async () => {
    const html = await sentHtml(
      [...VOTING, { kind: "aggregator", bias: "center" }, { kind: "niche", bias: "opposition" }],
      { pro_government: 2, gov_leaning: 1 },
    );
    expect(html).toContain("Spektrumda sadece İktidar");
    expect(html).not.toContain("Sadece İktidar yazdı");
  });

  it("keeps 'Sadece İktidar yazdı' when the only non-voting source sits inside the zone", async () => {
    const html = await sentHtml([...VOTING, { kind: "aggregator", bias: "gov_leaning" }], {
      pro_government: 2,
      gov_leaning: 1,
    });
    expect(html).toContain("Sadece İktidar yazdı");
    expect(html).not.toContain("Spektrumda");
  });

  it("keeps 'Sadece İktidar yazdı' when the bundle has no sources at all", async () => {
    const html = await sentHtml([], { pro_government: 3 });
    expect(html).toContain("Sadece İktidar yazdı");
  });
});

// h108-sharesurfaces-1: toBlindspotItem also hands the template how many silent
// zones Jev's recall stage matched with the event (BlindspotBundle.recallMatchedZones),
// so the mail says "Kümede sadece İktidar", the wording /blindspots uses.
describe("blindspot item wording, zones Jev matched (h108-sharesurfaces-1)", () => {
  const VOTING = [
    { kind: "outlet", bias: "pro_government" },
    { kind: "outlet", bias: "gov_leaning" },
    { kind: "wire", bias: "pro_government" },
  ];

  async function sentHtml(
    sources: Array<{ kind: string | null; bias: string }>,
    recallMatchedZones: string[] | undefined,
  ): Promise<string> {
    process.env.CRON_SECRET = "shhh";
    supabaseFake.state.subscribers = [
      { id: "s1", email: "ok@example.com", unsubscribe_token: "t1", last_sent_at: null },
    ];
    const { sendBatch } = await import("@/lib/email/resend");
    (sendBatch as unknown as Mock).mockImplementation(async (list: Array<{ to: string }>) =>
      list.map(() => ({ ok: true, id: "resend-id" })),
    );
    const { getBlindspots } = await import("@/lib/clusters/blindspots-query");
    (getBlindspots as unknown as Mock).mockResolvedValueOnce({
      bundles: [
        {
          cluster: {
            id: "b1",
            title_tr: "Tek taraflı haber",
            summary_tr: "",
            bias_distribution: {
              pro_government: 2, gov_leaning: 1, state_media: 0, center: 0, opposition_leaning: 0,
              opposition: 0, nationalist: 0, islamist_conservative: 0, pro_kurdish: 0, international: 0,
            },
          },
          sources,
          dominantZone: "iktidar",
          dominantPct: 1,
          ...(recallMatchedZones === undefined ? {} : { recallMatchedZones }),
        },
      ],
    });
    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));
    expect(res.status).toBe(200);
    return (sendBatch as unknown as Mock).mock.calls[0]![0][0].html as string;
  }

  it("prints 'Kümede sadece İktidar' when Jev matched the silent zone", async () => {
    const html = await sentHtml(VOTING, ["muhalefet"]);
    expect(html).toContain("Kümede sadece İktidar");
    expect(html).not.toContain("Sadece İktidar yazdı");
  });

  it("keeps 'Sadece İktidar yazdı' with [] (a failed lookup) and with the field missing (an old cache entry)", async () => {
    for (const zones of [[], undefined]) {
      const html = await sentHtml(VOTING, zones);
      expect(html).toContain("Sadece İktidar yazdı");
      expect(html).not.toContain("Kümede sadece");
    }
  });

  it("keeps 'Spektrumda sadece İktidar' when a non-voting outsider is also in the bundle", async () => {
    const html = await sentHtml([...VOTING, { kind: "niche", bias: "opposition" }], ["bagimsiz"]);
    expect(html).toContain("Spektrumda sadece İktidar");
    expect(html).not.toContain("Kümede sadece");
  });
});

// ---------------------------------------------------------------------------
// h87-newsletter-2: Resend allows 2 requests per second, so sendBatch paces its
// sends and retries a 429 (src/lib/email/resend.test.ts). A send that still
// fails stays unstamped, and the cron now ticks on Saturday AND Sunday (vercel.ts):
// the 6-day window keeps Saturday's recipients out of Sunday's run, so only the
// failed or left-over rows go out on Sunday. These tests pin that contract at the
// route: what it hands sendBatch, what it stamps, and what a second tick re-sends.
// ---------------------------------------------------------------------------
describe("GET /api/cron/digest: rate-limited sends and the Sunday retry tick (h87-newsletter-2)", () => {
  const DAY_MS = 24 * 3600 * 1000;
  // A Saturday, 06:00 UTC: the first of the two weekly ticks.
  const SATURDAY = Date.parse("2026-11-14T06:00:00.000Z");

  let errSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.CRON_SECRET = "shhh";
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(SATURDAY);
  });

  afterEach(() => {
    vi.useRealTimers();
    errSpy.mockRestore();
    warnSpy.mockRestore();
  });

  function sub(i: number, lastSentAt: string | null = null): SubscriberFixture {
    const n = String(i).padStart(3, "0");
    return { id: `s${n}`, email: `user${n}@example.com`, unsubscribe_token: `t${n}`, last_sent_at: lastSentAt };
  }

  async function sendBatchMock() {
    const { sendBatch } = await import("@/lib/email/resend");
    return sendBatch as unknown as Mock;
  }

  const recipientsOf = (call: unknown[]) => (call[0] as Array<{ to: string }>).map((m) => m.to);
  const stampedIds = () =>
    supabaseFake.fake.calls
      .update("newsletter_subscribers")
      .map((u) => u.state.eq.find((p) => p.col === "id")?.val as string);

  it("a send that is still rate limited after Resend's retries (Resend 429) is skipped and leaves last_sent_at untouched", async () => {
    supabaseFake.state.subscribers = [sub(1), sub(2)];
    const sendBatch = await sendBatchMock();
    sendBatch.mockImplementation(async (list: Array<{ to: string }>) =>
      list.map((m) =>
        m.to === "user002@example.com"
          ? { ok: false, error: "Resend 429: rate_limit_exceeded for user002@example.com" }
          : { ok: true, id: "resend-id" },
      ),
    );

    const mod = await importRoute();
    const res = await mod.GET(req("shhh"));

    expect(await res.json()).toEqual({ sent: 1, skipped: 1, substepErrors: 0 });
    expect(stampedIds()).toEqual(["s001"]);
    // The row stays due, and the failure is logged by id with the address redacted.
    const logged = JSON.stringify([...errSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).toContain("s002");
    expect(logged).not.toContain("@example.com");
  });

  it("keeps calling sendBatch(rows, 5) with the default pacing: five workers, no override of the 500 ms spacing", async () => {
    supabaseFake.state.subscribers = [sub(1), sub(2)];
    const sendBatch = await sendBatchMock();
    sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

    const mod = await importRoute();
    await mod.GET(req("shhh"));

    expect(sendBatch).toHaveBeenCalledTimes(1);
    expect(sendBatch.mock.calls[0]![0]).toHaveLength(2);
    expect(sendBatch.mock.calls[0]![1]).toBe(5);
    // The options carry the hard deadline and the per-item callback, never a pacing override.
    expect(sendBatch.mock.calls[0]![2]).not.toHaveProperty("minIntervalMs");
  });

  it("mails never-sent subscribers first, then the longest-waiting, so a tick cut short does not starve the same rows every week", async () => {
    supabaseFake.state.subscribers = [
      sub(1, new Date(SATURDAY - 10 * DAY_MS).toISOString()),
      sub(2),
      sub(3, new Date(SATURDAY - 20 * DAY_MS).toISOString()),
      sub(4),
      sub(5, new Date(SATURDAY - 7 * DAY_MS).toISOString()),
    ];
    const sendBatch = await sendBatchMock();
    sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

    const mod = await importRoute();
    await mod.GET(req("shhh"));

    expect(recipientsOf(sendBatch.mock.calls[0]!)).toEqual([
      "user002@example.com",
      "user004@example.com",
      "user003@example.com",
      "user001@example.com",
      "user005@example.com",
    ]);
  });

  describe("send-time budget (a tick must end inside maxDuration, never be killed mid-chunk)", () => {
    it("stops starting chunks once the budget is spent, reports the left-over rows as deferred, and stamps only what was sent", async () => {
      supabaseFake.state.subscribers = Array.from({ length: 60 }, (_, i) => sub(i));
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => {
        // The first chunk took 40 s of the 60 s: Resend's pacing plus its 429 retries.
        vi.setSystemTime(Date.now() + 40_000);
        return list.map(() => ({ ok: true, id: "r" }));
      });

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ sent: 25, skipped: 0, substepErrors: 0, deferred: 35 });
      expect(sendBatch).toHaveBeenCalledTimes(1);
      expect(sendBatch.mock.calls[0]![0]).toHaveLength(25);
      expect(stampedIds()).toHaveLength(25);
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("deferred");
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain("@");
    });

    it("the deferred rows are the ones the next tick sends first, and nobody who got the mail gets it twice", async () => {
      const all = Array.from({ length: 60 }, (_, i) => sub(i));
      supabaseFake.state.subscribers = all;
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => {
        vi.setSystemTime(Date.now() + 40_000);
        return list.map(() => ({ ok: true, id: "r" }));
      });
      const mod = await importRoute();
      await mod.GET(req("shhh"));
      const mailedSaturday = recipientsOf(sendBatch.mock.calls[0]!);

      // Sunday 06:00: Saturday's stamps are in the table now.
      const stamp = new Date(SATURDAY).toISOString();
      const stamped = new Set(stampedIds());
      supabaseFake.state.subscribers = all.map((r) => (stamped.has(r.id) ? { ...r, last_sent_at: stamp } : r));
      supabaseFake.fake.calls.mutations.length = 0;
      vi.setSystemTime(SATURDAY + DAY_MS);
      sendBatch.mockClear();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

      const sunday = await mod.GET(req("shhh"));
      const mailedSunday = sendBatch.mock.calls.flatMap((c) => recipientsOf(c));

      expect(await sunday.json()).toEqual({ sent: 35, skipped: 0, substepErrors: 0 });
      expect(mailedSunday).toHaveLength(35);
      expect(mailedSaturday.filter((to) => mailedSunday.includes(to))).toEqual([]);
      expect(new Set([...mailedSaturday, ...mailedSunday]).size).toBe(60);
    });

    it("sends every chunk when the clock never nears the budget, and adds no 'deferred' key", async () => {
      supabaseFake.state.subscribers = Array.from({ length: 60 }, (_, i) => sub(i));
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => {
        vi.setSystemTime(Date.now() + 5_000);
        return list.map(() => ({ ok: true, id: "r" }));
      });

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 60, skipped: 0, substepErrors: 0 });
      expect(sendBatch).toHaveBeenCalledTimes(3);
    });
  });

  // SEC-digest-double-send-1: a chunk's length is not bounded by the 35 s start check
  // (pacing, 429 sleeps and a hung fetch all add to it), and stamps used to be written
  // only after the whole chunk resolved, so a platform kill left every mail of the
  // chunk unstamped for Sunday's tick to send again. Each delivered mail is now
  // stamped as its own send resolves, and sendBatch gets a hard deadline.
  describe("per-item stamping and the hard send deadline (SEC-digest-double-send-1)", () => {
    type BatchOptions = {
      deadlineAt?: number;
      onResult?: (index: number, result: unknown) => void | Promise<void>;
    };

    it("(e) stamps each delivered mail as its own send resolves: a kill mid-chunk loses at most what is in flight", async () => {
      supabaseFake.state.subscribers = Array.from({ length: 10 }, (_, i) => sub(i));
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (_list: unknown[], _concurrency: number, options: BatchOptions) => {
        for (let i = 0; i < 10; i++) await options.onResult!(i, { ok: true, id: "r" });
        // The platform kills the function here: the batch promise never settles.
        return new Promise(() => {});
      });

      const mod = await importRoute();
      void mod.GET(req("shhh"));

      await vi.waitFor(() => expect(stampedIds()).toHaveLength(10));
      expect(stampedIds()).toEqual(Array.from({ length: 10 }, (_, i) => `s${String(i).padStart(3, "0")}`));
    });

    it("an item handled through onResult is not handled again from the returned array: counted and stamped once", async () => {
      supabaseFake.state.subscribers = [sub(1), sub(2), sub(3)];
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[], _concurrency: number, options: BatchOptions) => {
        const results = [
          { ok: true, id: "r" },
          { ok: false, error: "Resend 422: bad" },
          { ok: true, id: "r" },
        ];
        for (let i = 0; i < list.length; i++) await options.onResult!(i, results[i]);
        return results;
      });

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 2, skipped: 1, substepErrors: 0 });
      expect(stampedIds().sort()).toEqual(["s001", "s003"]);
      expect(errSpy.mock.calls.filter((c) => String(c[0]).includes("send failed"))).toHaveLength(1);
    });

    it("a mock that ignores onResult still gets every returned result handled (stamps after the batch)", async () => {
      supabaseFake.state.subscribers = [sub(1), sub(2)];
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 2, skipped: 0, substepErrors: 0 });
      expect(stampedIds().sort()).toEqual(["s001", "s002"]);
    });

    it.each([
      ["through onResult", true],
      ["in the returned array", false],
    ])("(f) counts { deferred: true } results (%s) as deferred, not skipped, and stamps and logs nothing for them", async (_label, viaCallback) => {
      supabaseFake.state.subscribers = [sub(1), sub(2), sub(3), sub(4)];
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[], _concurrency: number, options: BatchOptions) => {
        const results = [
          { ok: true, id: "r" },
          { deferred: true },
          { ok: false, error: "Resend 422: bad" },
          { deferred: true },
        ];
        if (viaCallback) for (let i = 0; i < list.length; i++) await options.onResult!(i, results[i]);
        return results;
      });

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 1, skipped: 1, substepErrors: 0, deferred: 2 });
      expect(stampedIds()).toEqual(["s001"]);
      // Only the real failure is logged, by id; a deferred row is not a failure.
      const failures = errSpy.mock.calls.filter((c) => String(c[0]).includes("send failed"));
      expect(failures).toHaveLength(1);
      expect(failures[0]![1]).toBe("s003");
      expect(warnSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("deferred");
    });

    it("adds the deferred rows of a chunk to the chunks it never started, instead of overwriting them", async () => {
      supabaseFake.state.subscribers = Array.from({ length: 60 }, (_, i) => sub(i));
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => {
        // The chunk ran past the hard deadline: 10 mails went out, 15 were never attempted.
        vi.setSystemTime(Date.now() + 46_000);
        return list.map((_, i) => (i < 10 ? { ok: true, id: "r" } : { deferred: true }));
      });

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 10, skipped: 0, substepErrors: 0, deferred: 50 });
      expect(sendBatch).toHaveBeenCalledTimes(1);
      expect(stampedIds()).toHaveLength(10);
    });

    it("(g) hands sendBatch deadlineAt = the request start + 45 s, so the last send settles inside maxDuration (8 s fetch timeout)", async () => {
      supabaseFake.state.subscribers = [sub(1)];
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

      const mod = await importRoute();
      await mod.GET(req("shhh"));

      const options = sendBatch.mock.calls[0]![2] as BatchOptions;
      expect(options.deadlineAt).toBe(SATURDAY + 45_000);
      expect(typeof options.onResult).toBe("function");
      expect(mod.maxDuration).toBe(60);
    });

    it("uses the same request-start deadline for every chunk, not one that moves with the clock", async () => {
      supabaseFake.state.subscribers = Array.from({ length: 60 }, (_, i) => sub(i));
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => {
        vi.setSystemTime(Date.now() + 5_000);
        return list.map(() => ({ ok: true, id: "r" }));
      });

      const mod = await importRoute();
      await mod.GET(req("shhh"));

      expect(sendBatch).toHaveBeenCalledTimes(3);
      const deadlines = sendBatch.mock.calls.map((c) => (c[2] as BatchOptions).deadlineAt);
      expect(deadlines).toEqual([SATURDAY + 45_000, SATURDAY + 45_000, SATURDAY + 45_000]);
    });

    it("a stamp that fails twice during onResult is one sub-step error, and the batch goes on", async () => {
      supabaseFake.state.subscribers = [sub(1), sub(2)];
      supabaseFake.state.updateError = { message: "update boom", code: "57014" };
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[], _concurrency: number, options: BatchOptions) => {
        const results = list.map(() => ({ ok: true, id: "r" }));
        for (let i = 0; i < list.length; i++) await options.onResult!(i, results[i]);
        return results;
      });

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 2, skipped: 0, substepErrors: 2 });
      expect(stampedIds().sort()).toEqual(["s001", "s001", "s002", "s002"]);
    });
  });

  describe("Sunday retry tick (vercel.ts '0 6 * * 6,0')", () => {
    it("re-sends only what Saturday failed, never a recipient Saturday already mailed", async () => {
      supabaseFake.state.subscribers = [sub(1), sub(2), sub(3), sub(4)];
      const sendBatch = await sendBatchMock();
      const failing = new Set(["user002@example.com", "user004@example.com"]);
      sendBatch.mockImplementation(async (list: Array<{ to: string }>) =>
        list.map((m) =>
          failing.has(m.to) ? { ok: false, error: "Resend 429: rate_limit_exceeded" } : { ok: true, id: "r" },
        ),
      );
      const mod = await importRoute();

      const saturday = await mod.GET(req("shhh"));
      expect(await saturday.json()).toEqual({ sent: 2, skipped: 2, substepErrors: 0 });
      expect(stampedIds().sort()).toEqual(["s001", "s003"]);

      // Sunday 06:00 UTC, 24 h later: the stamps Saturday wrote are in the table.
      const patches = supabaseFake.fake.calls.update("newsletter_subscribers");
      const stampOf = new Map(
        patches.map((u) => [u.state.eq.find((p) => p.col === "id")?.val as string, (u.patch as { last_sent_at: string }).last_sent_at]),
      );
      expect([...stampOf.values()].every((v) => v === new Date(SATURDAY).toISOString())).toBe(true);
      supabaseFake.state.subscribers = supabaseFake.state.subscribers.map((r) => ({
        ...r,
        last_sent_at: stampOf.get(r.id) ?? r.last_sent_at,
      }));
      supabaseFake.fake.calls.mutations.length = 0;
      vi.setSystemTime(SATURDAY + DAY_MS);
      sendBatch.mockClear();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

      const sunday = await mod.GET(req("shhh"));

      expect(await sunday.json()).toEqual({ sent: 2, skipped: 0, substepErrors: 0 });
      expect(sendBatch.mock.calls.flatMap((c) => recipientsOf(c)).sort()).toEqual([
        "user002@example.com",
        "user004@example.com",
      ]);
      expect(stampedIds().sort()).toEqual(["s002", "s004"]);
    });

    // ts-digest-sunday-6day-boundary: the row a Sunday tick stamped must be due again at
    // the next Saturday's tick, whatever the seconds of jitter between the two ticks'
    // clock reads (each tick reads the clock after its own subscriber read).
    it("(a) a row Sunday stamped at 06:00:04.200 is due on the next Saturday's tick that reads 06:00:03.900 (6 days minus 300 ms)", async () => {
      supabaseFake.state.subscribers = [sub(1, "2026-11-15T06:00:04.200Z")];
      vi.setSystemTime(Date.parse("2026-11-21T06:00:03.900Z"));
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 1, skipped: 0, substepErrors: 0 });
      expect(sendBatch.mock.calls.flatMap((c) => recipientsOf(c))).toEqual(["user001@example.com"]);
    });

    it("(b) a Saturday stamp 23 h 59 min 1 s old is not due on Sunday: no send, { sent: 0, skipped: 0 }", async () => {
      supabaseFake.state.subscribers = [sub(1, "2026-11-14T06:00:59.000Z")];
      vi.setSystemTime(Date.parse("2026-11-15T06:00:00.000Z"));
      const sendBatch = await sendBatchMock();

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 0, skipped: 0 });
      expect(sendBatch).not.toHaveBeenCalled();
    });

    it("a Saturday stamp is not due until 5 days 18 hours have passed, and is due at that instant", async () => {
      const stamp = Date.parse("2026-11-14T06:00:00.000Z");
      const threshold = (6 * 24 - 6) * 3600 * 1000;
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));
      const mod = await importRoute();
      supabaseFake.state.subscribers = [sub(1, new Date(stamp).toISOString())];

      vi.setSystemTime(stamp + threshold - 1);
      expect(await (await mod.GET(req("shhh"))).json()).toEqual({ sent: 0, skipped: 0 });
      expect(sendBatch).not.toHaveBeenCalled();

      vi.setSystemTime(stamp + threshold);
      expect(await (await mod.GET(req("shhh"))).json()).toEqual({ sent: 1, skipped: 0, substepErrors: 0 });
      expect(sendBatch).toHaveBeenCalledTimes(1);
    });

    it("an all-delivered Saturday leaves Sunday with nobody due: no send at all", async () => {
      // Every row was stamped at Saturday's start (06:00:00); Sunday's tick is 24 h later.
      supabaseFake.state.subscribers = [sub(1, new Date(SATURDAY).toISOString()), sub(2, new Date(SATURDAY).toISOString())];
      vi.setSystemTime(SATURDAY + DAY_MS);
      const sendBatch = await sendBatchMock();

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 0, skipped: 0 });
      expect(sendBatch).not.toHaveBeenCalled();
    });
  });

  describe("stamping a delivered mail (the only record that stops Sunday's tick re-sending it)", () => {
    async function allOk() {
      const sendBatch = await sendBatchMock();
      sendBatch.mockImplementation(async (list: unknown[]) => list.map(() => ({ ok: true, id: "r" })));
    }

    it("retries a failed last_sent_at write once, and a transient failure is no sub-step error", async () => {
      supabaseFake.state.subscribers = [sub(1)];
      supabaseFake.state.updateFailuresLeft = 1;
      await allOk();

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 1, skipped: 0, substepErrors: 0 });
      expect(stampedIds()).toEqual(["s001", "s001"]);
      expect(errSpy).not.toHaveBeenCalled();
    });

    it("gives up after the retry: one sub-step error and one Sentry report per subscriber, two writes each", async () => {
      supabaseFake.state.subscribers = [sub(1), sub(2)];
      supabaseFake.state.updateError = { message: "update boom", code: "57014" };
      await allOk();
      const { captureServerException } = await import("@/lib/sentry/server");

      const mod = await importRoute();
      const res = await mod.GET(req("shhh"));

      expect(await res.json()).toEqual({ sent: 2, skipped: 0, substepErrors: 2 });
      expect(stampedIds().sort()).toEqual(["s001", "s001", "s002", "s002"]);
      expect(captureServerException).toHaveBeenCalledTimes(2);
      expect(JSON.stringify(errSpy.mock.calls)).not.toContain("@");
    });
  });
});
