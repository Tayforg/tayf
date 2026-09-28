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
    if (url.includes("teyit.org")) {
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
      if (url.includes("teyit.org")) return xmlResponse(THREE_ITEM_TEYIT_XML, { url });
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
      if (url.includes("teyit.org")) {
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
      if (url.includes("teyit.org")) {
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
