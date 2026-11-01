import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Contract tests for /api/cron/fact-checks (Vercel cron).
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// and vi.stubGlobal("fetch") for the feed fetches, mirroring
// tests/api/cron/headline.test.ts's mock shape for next/server + next/cache
// + sentry.
// ---------------------------------------------------------------------------

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, connection: async () => {} };
});

const { revalidateTagMock } = vi.hoisted(() => ({ revalidateTagMock: vi.fn() }));
vi.mock("next/cache", () => ({ revalidateTag: revalidateTagMock }));

const { captureServerExceptionMock } = vi.hoisted(() => ({
  captureServerExceptionMock: vi.fn(),
}));
vi.mock("@/lib/sentry/server", () => ({
  captureServerException: captureServerExceptionMock,
}));

const TEYIT_XML = (items: string) => `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Teyit</title>
${items}
</channel></rss>`;

const THREE_ITEM_TEYIT_XML = TEYIT_XML(`
  <item>
    <title>Video Mekke'ye yapılan İHA saldırısını mı gösteriyor?</title>
    <link>https://teyit.org/analiz/mekke-iha</link>
    <pubDate>Mon, 28 Sep 2026 10:00:00 +0300</pubDate>
    <category>Mekke</category>
  </item>
  <item>
    <title>JS enjekte edilen kayit</title>
    <link>javascript:alert(1)</link>
    <pubDate>Mon, 28 Sep 2026 09:00:00 +0300</pubDate>
  </item>
  <item>
    <title>Off host kayit</title>
    <link>https://evil.example.com/x</link>
    <pubDate>Mon, 28 Sep 2026 08:00:00 +0300</pubDate>
  </item>
`);

const EMPTY_TEYIT_XML = TEYIT_XML("");

const fixture = vi.hoisted(() => ({
  factChecksData: [] as unknown[],
  factChecksUpsertError: null as { message: string } | null,
  clustersData: [] as unknown[],
  clusterArticlesData: [] as unknown[],
  existingLinksData: [] as unknown[],
  lastTextSearch: null as { col: string; query: string; opts: unknown } | null,
  lastFactChecksUpsertPatch: null as unknown,
}));

const supabaseFake = await vi.hoisted(async () => {
  const helper = await import("../_helpers/supabase-fake");
  return helper.createSupabaseFake({
    tables: {
      fact_checks: (state) => {
        if (state.mutation) {
          fixture.lastFactChecksUpsertPatch = state.mutation.patch;
          return { data: null, error: fixture.factChecksUpsertError };
        }
        return { data: fixture.factChecksData, error: null };
      },
      clusters: (state) => {
        fixture.lastTextSearch = state.textSearch[0] ?? null;
        return { data: fixture.clustersData, error: null };
      },
      cluster_articles: () => ({ data: fixture.clusterArticlesData, error: null }),
      cluster_fact_checks: (state) => {
        if (state.mutation) return { data: null, error: null };
        return { data: fixture.existingLinksData, error: null };
      },
    },
  });
});

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => supabaseFake.client,
}));

const ORIGINAL_ENV = { ...process.env };
let fetchMock: ReturnType<typeof vi.fn>;

// Exact host match (not a substring check) so the mock routes only real
// teyit.org feed URLs.
function isTeyitUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "teyit.org" || host === "www.teyit.org";
  } catch {
    return false;
  }
}

function xmlResponse(body: string, opts: { status?: number; url?: string } = {}) {
  const res = new Response(body, {
    status: opts.status ?? 200,
    headers: { "content-type": "application/rss+xml" },
  });
  if (opts.url !== undefined) {
    Object.defineProperty(res, "url", { value: opts.url });
  }
  return res;
}

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-role-key";
  process.env.CRON_SECRET = "shhh";
  fixture.factChecksData = [];
  fixture.factChecksUpsertError = null;
  fixture.clustersData = [];
  fixture.clusterArticlesData = [];
  fixture.existingLinksData = [];
  fixture.lastTextSearch = null;
  fixture.lastFactChecksUpsertPatch = null;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  revalidateTagMock.mockClear();
  captureServerExceptionMock.mockClear();

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (isTeyitUrl(url)) {
      return xmlResponse(EMPTY_TEYIT_XML, { url });
    }
    return xmlResponse(EMPTY_TEYIT_XML, { url });
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  for (const k of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "CRON_SECRET"]) {
    if (k in ORIGINAL_ENV) process.env[k] = ORIGINAL_ENV[k] as string;
    else delete process.env[k];
  }
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function importRoute() {
  return await import("@/app/api/cron/fact-checks/route");
}

describe("GET /api/cron/fact-checks", () => {
  it("returns 503 without CRON_SECRET", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await importRoute();
    const res = await GET(new Request("http://example.com/api/cron/fact-checks"));
    expect(res.status).toBe(503);
  });

  it("returns 401 with a wrong bearer", async () => {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer wrong" },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("upserts exactly 1 valid row from a 3-item feed (js/off-host dropped), onConflict url", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (isTeyitUrl(url)) return xmlResponse(THREE_ITEM_TEYIT_XML, { url });
      return xmlResponse(EMPTY_TEYIT_XML, { url });
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.upserted).toBe(1);

    const upsertCalls = supabaseFake.calls.upsert("fact_checks");
    expect(upsertCalls).toHaveLength(1);
    const patch = upsertCalls[0]!.patch as Array<Record<string, unknown>>;
    expect(patch).toHaveLength(1);
    expect(Object.keys(patch[0]!).sort()).toEqual(
      ["publisher", "published_at", "title", "url"].sort(),
    );
    expect(patch[0]!.url).toBe("https://teyit.org/analiz/mekke-iha");
    expect(upsertCalls[0]!.state.selectArgs).toBeDefined();
  });

  it("one feed returning 500 still yields a 200 with that feed's status recorded", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (isTeyitUrl(url)) {
        return xmlResponse("server error", { status: 500, url });
      }
      return xmlResponse(EMPTY_TEYIT_XML, { url });
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.feeds.teyit.status).toBe("error");
  });

  it("a constructed Response with empty res.url falls back to the requested URL for the host check", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (isTeyitUrl(url)) {
        // Empty res.url (as a hand-constructed Response would have) --
        // the route must fall back to the request url for the host check
        // rather than treating an empty host as a mismatch.
        return xmlResponse(EMPTY_TEYIT_XML, { url: "" });
      }
      return xmlResponse(EMPTY_TEYIT_XML, { url });
    });

    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    const body = await res.json();
    expect(body.feeds.teyit.status).toBe("ok");
  });

  describe("matching + link writes", () => {
    const FACT_CHECK_ROW = {
      id: "fc-1",
      publisher: "teyit",
      url: "https://teyit.org/analiz/mekke-iha",
      title: "Video Mekke'ye yapılan İHA saldırısını mı gösteriyor?",
      published_at: new Date().toISOString(),
    };

    const CLUSTER_ROW = {
      id: "cluster-1",
      title_tr: "Mekke'ye alçak saldırı girişimi: İçişleri Bakanı Çiftçi'den tepki",
      title_tr_neutral: null,
    };

    const MEMBER_ROWS = [
      {
        cluster_id: "cluster-1",
        articles: {
          title:
            "AK Parti Sözcüsü Çelik, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi",
        },
      },
      {
        cluster_id: "cluster-1",
        articles: {
          title:
            "İletişim Başkanı Duran, Mekke çevresinde önlenen Husilerin İHA saldırısını lanetledi",
        },
      },
    ];

    beforeEach(() => {
      fixture.factChecksData = [FACT_CHECK_ROW];
      fixture.clustersData = [CLUSTER_ROW];
      fixture.clusterArticlesData = MEMBER_ROWS;
    });

    it("records textSearch with config turkish / type websearch", async () => {
      const { GET } = await importRoute();
      await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      expect(fixture.lastTextSearch).not.toBeNull();
      expect(fixture.lastTextSearch!.col).toBe("search_tsv");
      expect(fixture.lastTextSearch!.opts).toMatchObject({
        config: "turkish",
        type: "websearch",
      });
    });

    it("inserts a new link with is_published matching the decision", async () => {
      fixture.existingLinksData = [];
      const { GET } = await importRoute();
      const res = await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      const body = await res.json();
      expect(body.matched).toBeGreaterThanOrEqual(1);

      const upserts = supabaseFake.calls.upsert("cluster_fact_checks");
      expect(upserts.length).toBeGreaterThanOrEqual(1);
      const rows = upserts[0]!.patch as Array<Record<string, unknown>>;
      const row = rows.find((r) => r.cluster_id === "cluster-1");
      expect(row).toBeDefined();
      expect(typeof row!.is_published).toBe("boolean");
      expect(row!.method).toBe("keyword-v1");
    });

    it("promotes an existing auto shadow row (decided_by=auto, is_published=false) when now publish", async () => {
      fixture.existingLinksData = [
        {
          cluster_id: "cluster-1",
          fact_check_id: "fc-1",
          is_published: false,
          decided_by: "auto",
        },
      ];
      const { GET } = await importRoute();
      await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );

      const updates = supabaseFake.calls.update("cluster_fact_checks");
      const promote = updates.find(
        (u) =>
          u.state.eq.some((e) => e.col === "decided_by" && e.val === "auto") &&
          u.state.eq.some((e) => e.col === "is_published" && e.val === false),
      );
      expect(promote).toBeDefined();
      expect((promote!.patch as Record<string, unknown>).is_published).toBe(true);
    });

    it("never updates an admin-decided row", async () => {
      fixture.existingLinksData = [
        {
          cluster_id: "cluster-1",
          fact_check_id: "fc-1",
          is_published: false,
          decided_by: "admin",
        },
      ];
      const { GET } = await importRoute();
      await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );

      const updates = supabaseFake.calls.update("cluster_fact_checks");
      expect(updates).toHaveLength(0);
    });

    it("calls revalidateTag for a newly-published cluster", async () => {
      fixture.existingLinksData = [];
      const { GET } = await importRoute();
      await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      const calledWithFactCheckTag = revalidateTagMock.mock.calls.some((c) =>
        String(c[0]).startsWith("fact-checks:"),
      );
      expect(calledWithFactCheckTag).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// h10-silent-3: a failing feed used to be recorded as {status: "error"} in the
// response and nowhere else, so a broken publisher went unnoticed. Every
// failing feed now logs ONE console.error line with a stable prefix and one
// Sentry event (grouped by message), carrying only the publisher key and a
// short single-line reason. Bodies, headers and URLs never reach either sink.
// The response shape is unchanged.
// ---------------------------------------------------------------------------
describe("feed failure reporting (h10-silent-3)", () => {
  const PREFIX = "[fact-checks-cron] feed failed";
  const SECRET = "SECRET-BODY-MARKER";
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  function urlOf(input: RequestInfo | URL): string {
    return typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  }

  function hostOf(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return "";
    }
  }

  /** Route each feed through `behaviour`; unlisted publishers answer with an empty, valid feed. */
  function routeFeeds(
    behaviour: Partial<Record<"teyit" | "dogrulukpayi" | "malumatfurus", (url: string) => Response | Promise<Response>>>,
  ) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      const host = hostOf(url);
      const key = host.endsWith("teyit.org")
        ? "teyit"
        : host.endsWith("dogrulukpayi.com")
          ? "dogrulukpayi"
          : host.endsWith("malumatfurus.org")
            ? "malumatfurus"
            : null;
      const handler = key ? behaviour[key] : undefined;
      return handler ? handler(url) : xmlResponse(EMPTY_TEYIT_XML, { url });
    });
  }

  async function runCron() {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    return { res, body: await res.json() };
  }

  const feedFailedCalls = () => errorSpy.mock.calls.filter((c) => c[0] === PREFIX);

  it("a feed answering 500 logs once with the publisher key and 'http 500', and reports it to Sentry", async () => {
    routeFeeds({ teyit: (url) => xmlResponse(SECRET, { status: 500, url }) });

    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(PREFIX, "teyit", "http 500");

    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    const [captured, context] = captureServerExceptionMock.mock.calls[0]!;
    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("teyit");
    expect((captured as Error).message).toContain("http 500");
    expect(context).toEqual({ publisher: "teyit" });

    // The body is never logged or reported.
    const sinks = JSON.stringify([
      errorSpy.mock.calls.map((c) => c.map(String)),
      captureServerExceptionMock.mock.calls.map(([e, c]) => [String(e), (e as Error).message, (e as Error).stack, c]),
    ]);
    expect(sinks).not.toContain(SECRET);

    // The response keeps its shape.
    expect(body.success).toBe(true);
    expect(body.feeds.teyit).toEqual({ status: "error", items: 0, error: "http 500" });
    expect(body.feeds.dogrulukpayi).toEqual({ status: "ok", items: 0 });
    expect(body.feeds.malumatfurus).toEqual({ status: "ok", items: 0 });
    expect(Object.keys(body).sort()).toEqual(
      ["feeds", "matched", "published", "shadow", "success", "timestamp", "upserted"].sort(),
    );
    expect(body.upserted).toBe(0);
  });

  it("a rejecting fetch with a long multi-line message logs a single line of at most 200 characters", async () => {
    const head = "line one\n\tline two\r\n";
    const original = head + "x".repeat(500 - head.length);
    expect(original).toHaveLength(500);
    routeFeeds({
      teyit: () => {
        throw new Error(original);
      },
    });

    const { body } = await runCron();

    expect(feedFailedCalls()).toHaveLength(1);
    const [, key, message] = feedFailedCalls()[0]! as [string, string, string];
    expect(key).toBe("teyit");
    expect(message).not.toMatch(/[\r\n\t]/);
    expect(message.length).toBeLessThanOrEqual(200);
    expect(message.startsWith("line one line two xxx")).toBe(true);

    const [captured] = captureServerExceptionMock.mock.calls[0]!;
    expect((captured as Error).message).not.toMatch(/[\r\n\t]/);
    expect((captured as Error).message).toContain("teyit");
    // fact-check feed failed: teyit: <= 200 chars of reason
    expect((captured as Error).message.length).toBeLessThanOrEqual("fact-check feed failed: teyit: ".length + 200);

    // The response is untouched: it still carries the full, original reason.
    expect(body.feeds.teyit).toEqual({ status: "error", items: 0, error: original });
  });

  it("a redirect to a foreign host logs once", async () => {
    routeFeeds({ teyit: () => xmlResponse(EMPTY_TEYIT_XML, { url: "https://evil.example.com/feed" }) });

    const { body } = await runCron();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(PREFIX, "teyit", "host mismatch after redirect");
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureServerExceptionMock.mock.calls[0]![1]).toEqual({ publisher: "teyit" });
    // The foreign URL is not logged.
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("evil.example.com");
    expect(body.feeds.teyit).toEqual({ status: "error", items: 0, error: "host mismatch after redirect" });
  });

  it("an oversized response logs once and never logs the payload", async () => {
    routeFeeds({ dogrulukpayi: (url) => xmlResponse(`${SECRET}${"x".repeat(2_000_001)}`, { url }) });

    const { body } = await runCron();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledWith(PREFIX, "dogrulukpayi", "response too large");
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureServerExceptionMock.mock.calls[0]![1]).toEqual({ publisher: "dogrulukpayi" });
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain(SECRET);
    expect(body.feeds.dogrulukpayi).toEqual({ status: "error", items: 0, error: "response too large" });
  });

  it("an unparseable feed logs once without echoing its body", async () => {
    routeFeeds({ malumatfurus: (url) => xmlResponse(`${SECRET} <not-xml`, { url }) });

    const { body } = await runCron();

    expect(feedFailedCalls()).toHaveLength(1);
    expect(feedFailedCalls()[0]![1]).toBe("malumatfurus");
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureServerExceptionMock.mock.calls[0]![1]).toEqual({ publisher: "malumatfurus" });
    expect(body.feeds.malumatfurus.status).toBe("error");
    expect(body.success).toBe(true);
  });

  it("reports once per failing feed per run (three failing feeds, three reports)", async () => {
    routeFeeds({
      teyit: (url) => xmlResponse("", { status: 503, url }),
      dogrulukpayi: (url) => xmlResponse("", { status: 404, url }),
      malumatfurus: (url) => xmlResponse("", { status: 500, url }),
    });

    const { body } = await runCron();

    expect(feedFailedCalls().map((c) => [c[1], c[2]])).toEqual([
      ["teyit", "http 503"],
      ["dogrulukpayi", "http 404"],
      ["malumatfurus", "http 500"],
    ]);
    expect(captureServerExceptionMock.mock.calls.map((c) => c[1])).toEqual([
      { publisher: "teyit" },
      { publisher: "dogrulukpayi" },
      { publisher: "malumatfurus" },
    ]);
    expect(Object.values(body.feeds).every((f) => (f as { status: string }).status === "error")).toBe(true);
  });

  it("when every feed is fine nothing is logged and nothing is captured", async () => {
    const { body } = await runCron();

    expect(body.success).toBe(true);
    expect(Object.values(body.feeds).every((f) => (f as { status: string }).status === "ok")).toBe(true);
    expect(feedFailedCalls()).toHaveLength(0);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(captureServerExceptionMock).not.toHaveBeenCalled();
  });

  describe("rejected branch (fetchFeed itself throws)", () => {
    // fetchFeed catches its own errors, so the `rejected` branch of the
    // settled loop is only reachable if its catch handler throws. A publisher
    // whose `key` getter throws on the first read does exactly that (the read
    // in the catch), then behaves from the second read on (the settled loop).
    async function runWithThrowingKey(thrown: unknown) {
      let reads = 0;
      const publisher = {
        get key() {
          reads++;
          if (reads === 1) throw thrown;
          return "teyit" as const;
        },
        label: "Teyit",
        hosts: ["teyit.org"],
        feedUrl: "https://teyit.org/feed",
      };
      vi.doMock("@/lib/fact-checks/feeds", async (importOriginal) => ({
        ...(await importOriginal<typeof import("@/lib/fact-checks/feeds")>()),
        FACT_CHECK_FEEDS: [publisher],
      }));
      // The first read (inside the catch) happens only after the fetch failed.
      fetchMock.mockImplementation(async () => {
        throw new Error("network down");
      });
      try {
        return await runCron();
      } finally {
        vi.doUnmock("@/lib/fact-checks/feeds");
      }
    }

    it("logs and captures a rejection that is an Error, with its single-line message", async () => {
      const { res, body } = await runWithThrowingKey(new Error("boom\nsecond line"));

      expect(res.status).toBe(200);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(PREFIX, "teyit", "boom second line");
      expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
      expect(captureServerExceptionMock.mock.calls[0]![1]).toEqual({ publisher: "teyit" });
      expect(body.feeds.teyit).toEqual({ status: "error", items: 0, error: "boom\nsecond line" });
    });

    it("logs the fallback reason for a non-Error rejection", async () => {
      const { body } = await runWithThrowingKey("plain string");

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy).toHaveBeenCalledWith(PREFIX, "teyit", "rejected");
      expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
      expect(body.feeds.teyit).toEqual({ status: "error", items: 0, error: "rejected" });
    });
  });
});
