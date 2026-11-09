import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import type { BuilderState } from "../_helpers/supabase-fake";
import { buildFtsQuery, extractFactCheckTerms } from "@/lib/fact-checks/match";

// ---------------------------------------------------------------------------
// Contract tests for /api/cron/fact-checks (Vercel cron).
//
// Uses the shared proxy-based Supabase fake (tests/_helpers/supabase-fake.ts)
// and vi.stubGlobal("fetch") for the feed fetches, mirroring
// tests/api/cron/headline.test.ts's mock shape for next/server + next/cache
// + sentry.
// ---------------------------------------------------------------------------

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

// An rpc or query failure as PostgREST reports it: `code` is what the route reads to tell a MISSING
// function (PGRST202, 42883) from any other failure.
type DbError = { message: string; code?: string };

const fixture = vi.hoisted(() => ({
  factChecksData: [] as unknown[],
  factChecksUpsertError: null as { message: string } | null,
  // fact_check_cluster_candidates rpc (migration 181): the primary candidate source.
  candidatesData: [] as unknown[],
  candidatesError: null as DbError | null,
  /** 1-based rpc calls that answer candidatesError; null = every call does. */
  candidatesFailOnCalls: null as number[] | null,
  /** The `status` of the failing rpc envelope (PostgREST answers 404 for a missing function). */
  candidatesErrorStatus: undefined as number | undefined,
  rpcArgs: [] as unknown[],
  // The legacy `clusters` query: only the missing-rpc fallback may reach it.
  clustersData: [] as unknown[],
  clustersError: null as { message: string } | null,
  clustersQueries: [] as BuilderState[],
  clusterArticlesData: [] as unknown[],
  clusterArticlesError: null as { message: string } | null,
  memberQueries: [] as BuilderState[],
  existingLinksData: [] as unknown[],
  existingLinksError: null as { message: string } | null,
  promoteError: null as { message: string } | null,
  insertError: null as { message: string } | null,
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
        fixture.clustersQueries.push(state);
        return { data: fixture.clustersData, error: fixture.clustersError };
      },
      cluster_articles: (state) => {
        fixture.memberQueries.push(state);
        return { data: fixture.clusterArticlesData, error: fixture.clusterArticlesError };
      },
      cluster_fact_checks: (state) => {
        // A read always calls select(); the two writes never do. Of the writes, the
        // promote update filters on its key (eq) and the new-links upsert has no filter.
        // (The helper clears `state.mutation` before it resolves a fixture.)
        if (state.selectArgs.length > 0) {
          return { data: fixture.existingLinksData, error: fixture.existingLinksError };
        }
        return { data: null, error: state.eq.length > 0 ? fixture.promoteError : fixture.insertError };
      },
    },
    rpc: {
      fact_check_cluster_candidates: (args) => {
        fixture.rpcArgs.push(args);
        const call = fixture.rpcArgs.length;
        const failing =
          fixture.candidatesError !== null &&
          (fixture.candidatesFailOnCalls === null || fixture.candidatesFailOnCalls.includes(call));
        if (failing) {
          return { data: null, error: fixture.candidatesError, status: fixture.candidatesErrorStatus };
        }
        return { data: fixture.candidatesData, error: null };
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
  fixture.candidatesData = [];
  fixture.candidatesError = null;
  fixture.candidatesFailOnCalls = null;
  fixture.candidatesErrorStatus = undefined;
  fixture.rpcArgs = [];
  fixture.clustersData = [];
  fixture.clustersError = null;
  fixture.clustersQueries = [];
  fixture.clusterArticlesData = [];
  fixture.clusterArticlesError = null;
  fixture.memberQueries = [];
  fixture.existingLinksData = [];
  fixture.existingLinksError = null;
  fixture.promoteError = null;
  fixture.insertError = null;
  fixture.lastFactChecksUpsertPatch = null;
  supabaseFake.calls.mutations.length = 0;
  supabaseFake.calls.rpc.length = 0;
  afterCallbacks.length = 0;
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

// One fact-check that matches one cluster: the fixtures of the link-writing tests below and
// of the sub-step failure tests (W3) at the end of this file.
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
    beforeEach(() => {
      fixture.factChecksData = [FACT_CHECK_ROW];
      fixture.candidatesData = [CLUSTER_ROW];
      fixture.clusterArticlesData = MEMBER_ROWS;
    });

    // h87-factchecks-1: the 25 candidates are the 25 BEST by ts_rank_cd (migration 181), not the 25 largest
    // clusters that match: a small same-event cluster (the Peru 'Hitler Mussolini' piece's, #139 of 315 by
    // size) never reached the matcher.
    it("asks the fact_check_cluster_candidates rpc for the 25 best clusters of the tsquery in the pub-7d to pub+2d window", async () => {
      const { GET } = await importRoute();
      await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      const publishedAtMs = new Date(FACT_CHECK_ROW.published_at).getTime();
      const day = 24 * 60 * 60 * 1000;
      const expectedQuery = buildFtsQuery(extractFactCheckTerms(FACT_CHECK_ROW.title, []));
      expect(expectedQuery).not.toBe("");

      const candidateCalls = supabaseFake.calls.rpc.filter((c) => c.name === "fact_check_cluster_candidates");
      expect(candidateCalls).toHaveLength(1);
      expect(candidateCalls[0]!.args).toEqual({
        p_query: expectedQuery,
        p_gte: new Date(publishedAtMs - 7 * day).toISOString(),
        p_lte: new Date(publishedAtMs + 2 * day).toISOString(),
        p_limit: 25,
      });
    });

    it("no longer reads the clusters table: the size-ordered textSearch chain is gone", async () => {
      const { GET } = await importRoute();
      await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      expect(fixture.clustersQueries).toHaveLength(0);
    });

    it("fetches the member titles of exactly the clusters the rpc returned, then writes the link", async () => {
      fixture.candidatesData = [CLUSTER_ROW];
      const { GET } = await importRoute();
      const res = await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      const body = await res.json();

      expect(fixture.memberQueries).toHaveLength(1);
      expect(fixture.memberQueries[0]!.in).toEqual([{ col: "cluster_id", vals: ["cluster-1"] }]);
      expect(fixture.memberQueries[0]!.limit).toBe(1000);
      expect(body.matched).toBe(1);
      expect(body.published).toBe(1);
      expect(body.substepErrors).toBe(0);
      const rows = supabaseFake.calls.upsert("cluster_fact_checks")[0]!.patch as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ cluster_id: "cluster-1", fact_check_id: "fc-1", is_published: true, method: "keyword-v2" });
    });

    it("an rpc that returns no row skips the member fetch and writes nothing", async () => {
      fixture.candidatesData = [];
      const { GET } = await importRoute();
      const res = await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.matched).toBe(0);
      expect(body.substepErrors).toBe(0);
      expect(fixture.memberQueries).toHaveLength(0);
      expect(supabaseFake.calls.upsert("cluster_fact_checks")).toHaveLength(0);
    });

    it("a null rpc payload is treated as no candidates", async () => {
      fixture.candidatesData = null as unknown as unknown[];
      const { GET } = await importRoute();
      const res = await GET(
        new Request("http://example.com/api/cron/fact-checks", {
          headers: { Authorization: "Bearer shhh" },
        }),
      );
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.matched).toBe(0);
      expect(body.substepErrors).toBe(0);
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
      expect(row!.method).toBe("keyword-v2");
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

  /** Exact host or a subdomain of it (a bare suffix check would also match "evilteyit.org"). */
  function isHostOf(host: string, domain: string): boolean {
    return host === domain || host.endsWith(`.${domain}`);
  }

  /** Route each feed through `behaviour`; unlisted publishers answer with an empty, valid feed. */
  function routeFeeds(
    behaviour: Partial<Record<"teyit" | "dogrulukpayi" | "malumatfurus", (url: string) => Response | Promise<Response>>>,
  ) {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = urlOf(input);
      const host = hostOf(url);
      const key = isHostOf(host, "teyit.org")
        ? "teyit"
        : isHostOf(host, "dogrulukpayi.com")
          ? "dogrulukpayi"
          : isHostOf(host, "malumatfurus.org")
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
      ["feeds", "matched", "published", "shadow", "substepErrors", "success", "timestamp", "upserted"].sort(),
    );
    expect(body.substepErrors).toBe(0);
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

// ---------------------------------------------------------------------------
// W3: a database step that fails inside the per-item loop is logged, captured and
// skipped, and the run answers 200 with `success: true`, so a run that lost its
// link writes looked healthy. The route now counts each swallowed Supabase failure
// (clusterErr, memberErr, existingErr, promoteErr, insertErr) in `substepErrors`,
// answers the same 200 with `success: substepErrors === 0` and the count in the
// body, and sets the internal header; withCronOutcome records 599 and strips it.
// A feed that fails to fetch is a vendor failure and stays uncounted.
// ---------------------------------------------------------------------------
describe("sub-step failures are recorded as 599, answered as 200 (W3)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const SUBSTEP_HEADER = "x-cron-substep-errors";

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fixture.factChecksData = [FACT_CHECK_ROW];
    fixture.candidatesData = [CLUSTER_ROW];
    fixture.clusterArticlesData = MEMBER_ROWS;
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  /** Runs the after() callbacks, the way Next does once the response is on its way. */
  const flush = () => Promise.all(afterCallbacks.map((cb) => cb()));
  /** Every `ops_cron_route_run_record` call (withCronOutcome's row for ops_health_report row 15). */
  const outcomeCalls = () => supabaseFake.calls.rpc.filter((c) => c.name === "ops_cron_route_run_record");

  async function runCron() {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    const body = await res.json();
    await flush();
    return { res, body };
  }

  it("a clean run records 200, reports substepErrors 0 and success true", async () => {
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body.matched).toBeGreaterThanOrEqual(1);
    expect(body.success).toBe(true);
    expect(body.substepErrors).toBe(0);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 200 });
  });

  const failing: Array<{ name: string; arrange: () => void }> = [
    { name: "the cluster candidate rpc (clusterErr)", arrange: () => { fixture.candidatesError = { message: "search boom", code: "57014" }; } },
    { name: "the member titles fetch (memberErr)", arrange: () => { fixture.clusterArticlesError = { message: "member boom" }; } },
    { name: "the existing links read (existingErr)", arrange: () => { fixture.existingLinksError = { message: "existing boom" }; } },
    {
      name: "the shadow-row promote update (promoteErr)",
      arrange: () => {
        fixture.existingLinksData = [
          { cluster_id: "cluster-1", fact_check_id: "fc-1", is_published: false, decided_by: "auto" },
        ];
        fixture.promoteError = { message: "promote boom" };
      },
    },
    { name: "the new links upsert (insertErr)", arrange: () => { fixture.insertError = { message: "insert boom" }; } },
  ];

  it.each(failing)("$name failing records 599, answers 200 without the header and reports success false", async ({ arrange }) => {
    arrange();
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body.substepErrors).toBeGreaterThanOrEqual(1);
    expect(body.success).toBe(false);
    expect(outcomeCalls()).toHaveLength(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 599 });
  });

  it("counts one failure for one failed step", async () => {
    fixture.existingLinksError = { message: "existing boom" };
    const { body } = await runCron();
    expect(body.substepErrors).toBe(1);
  });

  it("counts a failure for every fact-check that hits the failing step (two recent items, two failures)", async () => {
    fixture.candidatesError = { message: "search boom", code: "57014" };
    fixture.factChecksData = [FACT_CHECK_ROW, { ...FACT_CHECK_ROW, id: "fc-2", url: "https://teyit.org/analiz/second" }];
    const { body } = await runCron();
    expect(body.substepErrors).toBe(2);
    expect(body.success).toBe(false);
  });

  it("a failing candidate rpc is captured and counted once, the run goes on to the next fact-check and answers 200", async () => {
    // Only the first rpc call fails: the second fact-check must still be matched and written.
    fixture.candidatesError = { message: "canceling statement due to statement timeout", code: "57014" };
    fixture.candidatesFailOnCalls = [1];
    fixture.factChecksData = [FACT_CHECK_ROW, { ...FACT_CHECK_ROW, id: "fc-2", url: "https://teyit.org/analiz/second" }];
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(res.headers.get(SUBSTEP_HEADER)).toBeNull();
    expect(body.substepErrors).toBe(1);
    expect(body.success).toBe(false);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 599 });

    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureServerExceptionMock.mock.calls[0]![0]).toBe(fixture.candidatesError);
    expect(captureServerExceptionMock.mock.calls[0]![1]).toEqual({ factCheckId: "fc-1" });

    // fc-1 stopped at the failed search; fc-2 reached the member fetch and wrote its link.
    expect(fixture.rpcArgs).toHaveLength(2);
    expect(fixture.memberQueries).toHaveLength(1);
    const writes = supabaseFake.calls.upsert("cluster_fact_checks");
    expect(writes).toHaveLength(1);
    const rows = writes[0]!.patch as Array<Record<string, unknown>>;
    expect(rows.map((r) => r.fact_check_id)).toEqual(["fc-2"]);
  });

  it("a failing feed alone (a vendor failure) stays uncounted: 200 recorded, success true", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return xmlResponse("server error", { status: 500, url });
    });
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(Object.values(body.feeds).every((f) => (f as { status: string }).status === "error")).toBe(true);
    expect(body.success).toBe(true);
    expect(body.substepErrors).toBe(0);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 200 });
  });
});

// ---------------------------------------------------------------------------
// h87-factchecks-1: the route calls fact_check_cluster_candidates (migration 181). The migration is applied by
// hand after the deploy, so for a while the function does not exist and PostgREST answers PGRST202 (404, not in the
// schema cache) or 42883 (undefined_function). That must not break the hourly cron: the route logs ONCE per run and
// falls back to the query it ran before (the 25 largest matching clusters). Any OTHER rpc failure is a real
// database failure and stays a counted sub-step error, with no silent second query.
// ---------------------------------------------------------------------------
describe("a missing candidate rpc degrades to the size-ordered query (h87-factchecks-1)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const MISSING: DbError = {
    message: "Could not find the function public.fact_check_cluster_candidates(p_gte, p_limit, p_lte, p_query) in the schema cache",
    code: "PGRST202",
  };
  const SECOND_ROW = { ...FACT_CHECK_ROW, id: "fc-2", url: "https://teyit.org/analiz/second" };

  beforeEach(() => {
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    fixture.factChecksData = [FACT_CHECK_ROW];
    fixture.candidatesError = MISSING;
    fixture.candidatesErrorStatus = 404;
    fixture.clustersData = [CLUSTER_ROW];
    fixture.clusterArticlesData = MEMBER_ROWS;
  });

  afterEach(() => {
    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });

  const flush = () => Promise.all(afterCallbacks.map((cb) => cb()));
  const outcomeCalls = () => supabaseFake.calls.rpc.filter((c) => c.name === "ops_cron_route_run_record");

  async function runCron() {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    const body = await res.json();
    await flush();
    return { res, body };
  }

  it("PGRST202 falls back to the previous clusters query, unchanged, and the run stays healthy", async () => {
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.substepErrors).toBe(0);
    expect(body.matched).toBe(1);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 200 });

    // The previous query, as it was: archived out, 2+ articles, the window, the websearch tsquery, 25 largest.
    const publishedAtMs = new Date(FACT_CHECK_ROW.published_at).getTime();
    const day = 24 * 60 * 60 * 1000;
    expect(fixture.clustersQueries).toHaveLength(1);
    const q = fixture.clustersQueries[0]!;
    expect(q.eq).toEqual([{ col: "is_archived", val: false }]);
    expect(q.gte).toEqual([
      { col: "article_count", val: 2 },
      { col: "updated_at", val: new Date(publishedAtMs - 7 * day).toISOString() },
    ]);
    expect(q.lte).toEqual([{ col: "first_published", val: new Date(publishedAtMs + 2 * day).toISOString() }]);
    expect(q.textSearch).toEqual([
      {
        col: "search_tsv",
        query: buildFtsQuery(extractFactCheckTerms(FACT_CHECK_ROW.title, [])),
        opts: { config: "turkish", type: "websearch" },
      },
    ]);
    expect(q.order).toEqual([{ col: "article_count", opts: { ascending: false } }]);
    expect(q.limit).toBe(25);

    // The rest of the flow is untouched: member titles of the fallback's clusters, then the link.
    expect(fixture.memberQueries).toHaveLength(1);
    expect(fixture.memberQueries[0]!.in).toEqual([{ col: "cluster_id", vals: ["cluster-1"] }]);
    const rows = supabaseFake.calls.upsert("cluster_fact_checks")[0]!.patch as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ cluster_id: "cluster-1", fact_check_id: "fc-1", is_published: true });
  });

  it("is not reported to Sentry and not counted as a sub-step error", async () => {
    const { body } = await runCron();
    expect(body.substepErrors).toBe(0);
    expect(captureServerExceptionMock).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs once per run, however many fact-checks follow, and asks the rpc only until it is known to be missing", async () => {
    fixture.factChecksData = [FACT_CHECK_ROW, SECOND_ROW];
    const { body } = await runCron();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0]![0])).toContain("[fact-checks-cron]");
    expect(warnSpy.mock.calls.flat().map(String).join(" ")).toContain("fact_check_cluster_candidates");
    expect(fixture.rpcArgs).toHaveLength(1);
    expect(fixture.clustersQueries).toHaveLength(2);
    expect(body.substepErrors).toBe(0);
    expect(body.matched).toBe(2);
  });

  it("a fresh run asks the rpc again, so applying the migration takes effect without a redeploy", async () => {
    await runCron();
    expect(fixture.rpcArgs).toHaveLength(1);

    // Migration applied between two cron runs.
    fixture.candidatesError = null;
    fixture.candidatesData = [CLUSTER_ROW];
    fixture.clustersQueries.length = 0;
    warnSpy.mockClear();
    afterCallbacks.length = 0;
    const { body } = await runCron();

    expect(fixture.rpcArgs).toHaveLength(2);
    expect(fixture.clustersQueries).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(body.matched).toBe(1);
    expect(body.substepErrors).toBe(0);
  });

  it.each([
    { name: "42883 (Postgres undefined_function)", error: { message: 'function public.fact_check_cluster_candidates(text, timestamp with time zone, timestamp with time zone, integer) does not exist', code: "42883" } as DbError, status: undefined },
    { name: "a bare 404 with no PostgREST code", error: { message: "Not Found" } as DbError, status: 404 },
  ])("$name is a missing function too", async ({ error, status }) => {
    fixture.candidatesError = error;
    fixture.candidatesErrorStatus = status;
    const { body } = await runCron();

    expect(fixture.clustersQueries).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(body.success).toBe(true);
    expect(body.substepErrors).toBe(0);
    expect(body.matched).toBe(1);
  });

  it.each([
    { name: "a statement timeout (57014)", error: { message: "canceling statement due to statement timeout", code: "57014" } as DbError, status: 500 },
    { name: "a permission failure (42501)", error: { message: "permission denied for function fact_check_cluster_candidates", code: "42501" } as DbError, status: 403 },
    { name: "an error with no code and no status", error: { message: "fetch failed" } as DbError, status: undefined },
  ])("$name is NOT a missing function: counted, captured, and no fallback query runs", async ({ error, status }) => {
    fixture.candidatesError = error;
    fixture.candidatesErrorStatus = status;
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(body.substepErrors).toBe(1);
    expect(body.success).toBe(false);
    expect(fixture.clustersQueries).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(1);
    expect(captureServerExceptionMock.mock.calls[0]![0]).toBe(error);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 599 });
  });

  it("a fallback query that fails is a counted sub-step error, and the run goes on to the next fact-check", async () => {
    fixture.factChecksData = [FACT_CHECK_ROW, SECOND_ROW];
    fixture.clustersError = { message: "fallback boom" };
    const { res, body } = await runCron();

    expect(res.status).toBe(200);
    expect(body.substepErrors).toBe(2);
    expect(body.success).toBe(false);
    expect(fixture.clustersQueries).toHaveLength(2);
    expect(captureServerExceptionMock).toHaveBeenCalledTimes(2);
    expect(captureServerExceptionMock.mock.calls.map((c) => c[1])).toEqual([{ factCheckId: "fc-1" }, { factCheckId: "fc-2" }]);
    expect(outcomeCalls()[0]!.args).toMatchObject({ p_route: "fact-checks", p_status: 599 });
  });

  it("a healthy rpc logs nothing and never touches the clusters table", async () => {
    fixture.candidatesError = null;
    fixture.candidatesData = [CLUSTER_ROW];
    const { body } = await runCron();

    expect(warnSpy).not.toHaveBeenCalled();
    expect(fixture.clustersQueries).toHaveLength(0);
    expect(body.matched).toBe(1);
    expect(body.substepErrors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// SEC-factcheck-autopublish-fp-1: candidates ranked by relevance (migration 181) put clusters that share only
// generic stems in front of the matcher. The replay published Teyit 29c5930e -> cluster 087390a8 at 0.6 with 3
// distinct terms: a clip said to show a carrier strike against satellite images of the damage to US bases, two
// different claims. So a pair that comes from the RPC needs RPC_PUBLISH_MIN_SCORE = 0.7 to auto-publish; a 0.6
// 'publish' decision of match.ts is kept as a shadow row (is_published false) for an admin to promote. The
// size-ordered fallback query keeps the old behaviour: its candidates were never relevance-ranked.
// ---------------------------------------------------------------------------
describe("an RPC-sourced pair needs 0.7 to auto-publish (SEC-factcheck-autopublish-fp-1)", () => {
  const IRAN_FACT_CHECK = {
    id: "29c5930e",
    publisher: "teyit",
    url: "https://teyit.org/analiz/iran-belgesel",
    title: "Görüntülerin İran'ın ABD uçak gemisini vurduğunu anlatan belgeselden olduğu iddiası",
    published_at: new Date().toISOString(),
  };
  const IRAN_CLUSTER = {
    id: "087390a8",
    title_tr:
      "Uydu görüntüleriyle incelendi: İran'ın vurduğu ABD üslerindeki hasar milyarlarca doları buldu",
    title_tr_neutral: null,
  };
  const IRAN_MEMBERS = [
    {
      cluster_id: "087390a8",
      articles: {
        title: "Uydu görüntüleriyle incelendi: İran'ın vurduğu ABD üslerindeki hasar milyarlarca doları buldu",
      },
    },
    {
      cluster_id: "087390a8",
      articles: { title: "İran'dan ABD'ye ağır darbe! Orta Doğu'daki milyarlarca dolarlık zarar ortaya çıktı" },
    },
  ];

  // Peru 506da2d9 scores 0.8 (match.test.ts); Resmi Gazete 903f9541 scores exactly 0.7, the floor itself.
  const PERU_FACT_CHECK = {
    id: "f8a58b4b",
    publisher: "teyit",
    url: "https://teyit.org/analiz/peru-hitler-mussolini",
    title: "Peru'da Hitler Mussolini adlı bir aday belediye başkanı seçildi",
    published_at: new Date().toISOString(),
  };
  const PERU_CLUSTER = {
    id: "506da2d9",
    title_tr: "Sol aday Hitler Mussolini Peru'da yerel seçimi kazandı",
    title_tr_neutral: null,
  };
  const PERU_MEMBERS = [
    "Belediye başkanlığı seçimini Hitler Mussolini Simeon Flores kazandı",
    "Sol aday Hitler Mussolini Peru'da yerel seçimi kazandı",
    "Peru’da Hitler Mussolini Simeon Flores, sosyal demokrat partiden belediye başkanı oldu",
    "Peru'da solcu Hitler Mussolini belediye başkanı seçildi",
  ].map((title) => ({ cluster_id: "506da2d9", articles: { title } }));

  const RESMI_FACT_CHECK = {
    id: "28f0f694",
    publisher: "teyit",
    url: "https://teyit.org/analiz/resmi-gazete-yas",
    title: "Sosyal medyada yaşa takılanlar: Yaş kısıtlaması Resmi Gazete’de",
    published_at: new Date().toISOString(),
  };
  const RESMI_CLUSTER = {
    id: "903f9541",
    title_tr: "Resmi Gazete'de yayımlandı: Sosyal medyada 15 yaş Şartı",
    title_tr_neutral: null,
  };
  const RESMI_MEMBERS = [
    "Resmi Gazete'de yayımlandı: 15 yaşını doldurmamış kimseler sosyal medya hesabı açamayacak",
    "Resmi Gazete'de yayımlandı: Sosyal medyada 15 yaş Şartı",
    "Resmi Gazete'de yayımlandı: Sosyal medyaya 15 sınırı getirildi",
  ].map((title) => ({ cluster_id: "903f9541", articles: { title } }));

  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function runCron() {
    const { GET } = await importRoute();
    const res = await GET(
      new Request("http://example.com/api/cron/fact-checks", {
        headers: { Authorization: "Bearer shhh" },
      }),
    );
    return { res, body: await res.json() };
  }

  const upsertedRows = () =>
    supabaseFake.calls.upsert("cluster_fact_checks").flatMap((c) => c.patch as Array<Record<string, unknown>>);

  it("(a) the RPC's Iran/ABD pair (0.6, 3 distinct terms) is upserted as a shadow row: published 0, shadow 1, no revalidation", async () => {
    fixture.factChecksData = [IRAN_FACT_CHECK];
    fixture.candidatesData = [IRAN_CLUSTER];
    fixture.clusterArticlesData = IRAN_MEMBERS;

    const { body } = await runCron();

    expect(fixture.rpcArgs).toHaveLength(1);
    expect(body.matched).toBe(1);
    expect(body.published).toBe(0);
    expect(body.shadow).toBe(1);
    expect(body.substepErrors).toBe(0);
    const rows = upsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cluster_id: "087390a8",
      fact_check_id: "29c5930e",
      score: 0.6,
      method: "keyword-v2",
      is_published: false,
    });
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("(b) the same pair through the PGRST202 fallback is still upserted with is_published true (old behaviour unchanged)", async () => {
    fixture.factChecksData = [IRAN_FACT_CHECK];
    fixture.candidatesError = { message: "not in the schema cache", code: "PGRST202" };
    fixture.candidatesErrorStatus = 404;
    fixture.clustersData = [IRAN_CLUSTER];
    fixture.clusterArticlesData = IRAN_MEMBERS;

    const { body } = await runCron();

    expect(fixture.clustersQueries).toHaveLength(1);
    expect(body.published).toBe(1);
    expect(body.shadow).toBe(0);
    const rows = upsertedRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ cluster_id: "087390a8", score: 0.6, is_published: true });
    expect(revalidateTagMock).toHaveBeenCalledWith("fact-checks:087390a8", "max");
  });

  it("(c) an RPC-sourced pair at 0.8 (the Peru pair) is upserted with is_published true and revalidated", async () => {
    fixture.factChecksData = [PERU_FACT_CHECK];
    fixture.candidatesData = [PERU_CLUSTER];
    fixture.clusterArticlesData = PERU_MEMBERS;

    const { body } = await runCron();

    expect(body.published).toBe(1);
    expect(body.shadow).toBe(0);
    expect(upsertedRows()[0]).toMatchObject({ cluster_id: "506da2d9", score: 0.8, is_published: true });
    expect(revalidateTagMock).toHaveBeenCalledWith("fact-checks:506da2d9", "max");
  });

  it("an RPC-sourced pair at exactly 0.7 (the Resmi Gazete pair) publishes: the floor is a plain >=", async () => {
    fixture.factChecksData = [RESMI_FACT_CHECK];
    fixture.candidatesData = [RESMI_CLUSTER];
    fixture.clusterArticlesData = RESMI_MEMBERS;

    const { body } = await runCron();

    expect(body.published).toBe(1);
    expect(body.shadow).toBe(0);
    expect(upsertedRows()[0]).toMatchObject({ cluster_id: "903f9541", score: 0.7, is_published: true });
  });

  it("(d) an existing auto shadow row plus an RPC-sourced 0.6 'publish' decision issues no promote update and writes nothing", async () => {
    fixture.factChecksData = [IRAN_FACT_CHECK];
    fixture.candidatesData = [IRAN_CLUSTER];
    fixture.clusterArticlesData = IRAN_MEMBERS;
    fixture.existingLinksData = [
      { cluster_id: "087390a8", fact_check_id: "29c5930e", is_published: false, decided_by: "auto" },
    ];

    const { body } = await runCron();

    expect(supabaseFake.calls.update("cluster_fact_checks")).toHaveLength(0);
    expect(upsertedRows()).toHaveLength(0);
    expect(body.published).toBe(0);
    expect(body.shadow).toBe(0);
    expect(body.substepErrors).toBe(0);
    expect(revalidateTagMock).not.toHaveBeenCalled();
  });

  it("an existing auto shadow row IS promoted when the RPC-sourced decision scores 0.7 or more", async () => {
    fixture.factChecksData = [PERU_FACT_CHECK];
    fixture.candidatesData = [PERU_CLUSTER];
    fixture.clusterArticlesData = PERU_MEMBERS;
    fixture.existingLinksData = [
      { cluster_id: "506da2d9", fact_check_id: "f8a58b4b", is_published: false, decided_by: "auto" },
    ];

    const { body } = await runCron();

    const updates = supabaseFake.calls.update("cluster_fact_checks");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch).toMatchObject({ is_published: true, score: 0.8 });
    expect(body.published).toBe(1);
  });

  it("an RPC-sourced 0.6 pair next to a 0.8 pair of another fact-check: only the 0.8 one is published", async () => {
    fixture.factChecksData = [IRAN_FACT_CHECK, PERU_FACT_CHECK];
    // The fake answers every rpc call with the same candidates: both clusters come back for both fact-checks, and
    // each fact-check's matcher keeps only the cluster it is about.
    fixture.candidatesData = [IRAN_CLUSTER, PERU_CLUSTER];
    fixture.clusterArticlesData = [...IRAN_MEMBERS, ...PERU_MEMBERS];

    const { body } = await runCron();

    expect(body.matched).toBe(2);
    expect(body.published).toBe(1);
    expect(body.shadow).toBe(1);
    const byCluster = new Map(upsertedRows().map((r) => [r.cluster_id, r.is_published]));
    expect(byCluster.get("087390a8")).toBe(false);
    expect(byCluster.get("506da2d9")).toBe(true);
    expect(revalidateTagMock.mock.calls.map((c) => c[0])).toEqual(["fact-checks:506da2d9"]);
  });
});
