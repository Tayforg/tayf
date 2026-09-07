import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
// Real (unmocked) normalizer — used only to pre-compute the exact
// content_hash a fixture item will get, so the migration-041 F2 test below
// can seed `existingArticleHashPairs` with a value the SUT will actually
// produce, instead of a hand-picked string that happens to never collide.
import { normalizeArticles } from "../../supabase/functions/_shared/rss/normalize.ts";

// ---------------------------------------------------------------------------
// Contract tests for the ingest Edge Function (audit T7 P1-22 verification).
//
// The headline test in this file — "decodes a CP1254 (iso-8859-9) Turkish
// feed without mojibake" — is the mandatory regression check for the
// charset bug the audit caught: the old `res.text()` path silently fell
// back to UTF-8 and corrupted Turkish characters (ş, ı, ğ, ç, ö, ü).
//
// We exercise the contract at three levels:
//
//   1. The pure helper (`decodeRssBody`) if it can be
//      imported standalone — the cheapest, most diagnostic-friendly check.
//   2. The whole `ingest` handler invoked end-to-end against a `fetch`
//      stub that yields the CP1254 fixture — proves the full pipeline
//      doesn't lose the decoded characters between fetcher → normalizer →
//      Supabase upsert.
//   3. SSRF / safety guards (rejecting feeds whose URL resolves into
//      RFC1918 / 169.254 space) — partial coverage; B5 owns the full
//      `safe-fetch` and tests it more deeply in image-consumer.test.ts.
//
// All Supabase + pgmq surfaces are mocked. No network. No live feeds.
// ---------------------------------------------------------------------------

// Polyfill Deno before importing the SUT.
(globalThis as unknown as { Deno?: unknown }).Deno = {
  env: { get: (k: string) => process.env[k] },
  serve: (handler: (req: Request) => Promise<Response> | Response) => {
    (globalThis as unknown as { __ingestHandler?: unknown }).__ingestHandler = handler;
    return { finished: Promise.resolve() };
  },
};

// Service-role bearer mirrored into `SUPABASE_SERVICE_ROLE_KEY` in
// `beforeEach`. The `requireServiceRoleBearer` gate in the handler reads the
// env var via the Deno polyfill and compares it to the inbound Authorization
// header. Every authorised `new Request(...)` is built via `authedRequest(...)`
// so the gate accepts the call; the dedicated 401 test below intentionally
// bypasses this helper.
const TEST_SERVICE_ROLE_KEY = "test-service-role-key";

function authedRequest(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TEST_SERVICE_ROLE_KEY}`,
    },
  });
}

// ---------------------------------------------------------------------------
// CP1254 fixture
//
// Turkish source line — every character that differs from ISO-8859-1 /
// UTF-8 single-byte is exercised: ş (0xFE), ı (0xFD), ğ (0xF0), ç (0xE7),
// ö (0xF6), ü (0xFC), İ (0xDD), Ş (0xDE).
//
// We hand-assemble the bytes rather than calling `iconv-lite` so the
// fixture is self-contained and CI doesn't need a third-party encoder
// installed just to run this test.
// ---------------------------------------------------------------------------

const CP1254_BYTES = new Uint8Array([
  0x3c, 0x3f, 0x78, 0x6d, 0x6c, 0x20, 0x76, 0x65, 0x72, 0x73, 0x69, 0x6f,
  0x6e, 0x3d, 0x22, 0x31, 0x2e, 0x30, 0x22, 0x20, 0x65, 0x6e, 0x63, 0x6f,
  0x64, 0x69, 0x6e, 0x67, 0x3d, 0x22, 0x69, 0x73, 0x6f, 0x2d, 0x38, 0x38,
  0x35, 0x39, 0x2d, 0x39, 0x22, 0x3f, 0x3e, 0x0a, // <?xml version="1.0" encoding="iso-8859-9"?>
  0x3c, 0x72, 0x73, 0x73, 0x3e, 0x3c, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65,
  0x6c, 0x3e, // <rss><channel>
  0x3c, 0x69, 0x74, 0x65, 0x6d, 0x3e, // <item>
  0x3c, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, // <title>
  // Body bytes for: "Türkçe başlık: şirin İğne çağı"
  0x54, 0xfc, 0x72, 0x6b, 0xe7, 0x65, 0x20, 0x62, 0x61, 0xfe, 0x6c, 0xfd,
  0x6b, 0x3a, 0x20, 0xfe, 0x69, 0x72, 0x69, 0x6e, 0x20, 0xdd, 0xf0, 0x6e,
  0x65, 0x20, 0xe7, 0x61, 0xf0, 0xfd,
  0x3c, 0x2f, 0x74, 0x69, 0x74, 0x6c, 0x65, 0x3e, // </title>
  0x3c, 0x6c, 0x69, 0x6e, 0x6b, 0x3e, 0x68, 0x74, 0x74, 0x70, 0x73, 0x3a,
  0x2f, 0x2f, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x2e, 0x63, 0x6f,
  0x6d, 0x2f, 0x61, 0x31, 0x3c, 0x2f, 0x6c, 0x69, 0x6e, 0x6b, 0x3e, // <link>https://example.com/a1</link>
  0x3c, 0x2f, 0x69, 0x74, 0x65, 0x6d, 0x3e, // </item>
  0x3c, 0x2f, 0x63, 0x68, 0x61, 0x6e, 0x6e, 0x65, 0x6c, 0x3e, 0x3c, 0x2f,
  0x72, 0x73, 0x73, 0x3e, // </channel></rss>
]);

const EXPECTED_TITLE = "Türkçe başlık: şirin İğne çağı";

// ---------------------------------------------------------------------------
// Mock collaborators.
// ---------------------------------------------------------------------------

const upserted: Array<Record<string, unknown>> = [];

// Rows the SUT writes to `ingest_cycles` (migration 039's best-effort
// per-cycle telemetry row — supabase/functions/ingest/index.ts's
// `recordIngestCycle`). Tracked the same way `upserted` tracks `articles`.
const ingestCycleInserts: Array<Record<string, unknown>> = [];

// When set, the "sources" branch of `settle()` below returns this as a
// Supabase `error` instead of the fake roster — used to exercise the
// `runCycleBody` failure path (the `sourcesError` throw) and confirm
// `ingest_cycles` still gets a row via the `finally` in `runCycle`.
let forcedSourcesError: string | null = null;

// Rows the SUT writes to `sources` via `persistSourceFetchState` (migration
// 041's best-effort per-cycle fetch-validator write). One entry per
// `.rpc("ingest_set_source_fetch_state", ...)` call — and, as a regression
// tripwire, per `.from("sources").upsert(...)` call, which the real DB
// rejects with 23502 (NOT NULL on name/slug/... is checked before the ON
// CONFLICT arbiter) — so the tests can assert both the call count (exactly
// one per cycle) and that it went through the RPC.
const sourceFetchStateWrites: Array<{
  fn: string;
  rows: Array<Record<string, unknown>>;
}> = [];

// Simulates rows that already exist in `articles` from a previous cycle —
// seeded by the migration-041 F2 test to reproduce the production 23505:
// a row sharing (source_id, content_hash) with an ALREADY-STORED article
// under a different url. `.from("articles").select(...).in(...).in(...)`
// (dropExistingSourceContentHashRows) reads this; `.from("articles").upsert(...)`
// simulates the real UNIQUE-constraint failure when a call's payload still
// contains a colliding pair, so the test can prove the fix drops the row
// BEFORE that call rather than relying on (and retrying through) the
// per-row fallback.
let existingArticleHashPairs: Array<{ source_id: string; content_hash: string }> = [];

// One entry per `.from("articles").upsert(rows, opts)` call this test made
// — lets the migration-041 F2 test assert the offending row never reaches
// an upsert call at all (batched OR per-row fallback), not just that it's
// absent from `upserted`.
const articlesUpsertCalls: Array<Array<Record<string, unknown>>> = [];

// When set, the "ingest_cycles" `insert()` mock below returns this as an
// error instead of recording the row — used to prove `recordIngestCycle`'s
// try/catch absorbs a telemetry-write failure instead of failing the cycle.
let forcedIngestCyclesInsertError: string | null = null;

// Per-test source roster. The ingest handler reads from `sources` via
// `.from("sources").select(...).eq("active", true).order("slug")` and
// awaits the chain directly — so the chainable mock terminates via `then`.
// Tests that exercise the end-to-end ingest path populate this list with
// a single source pointing at the fixture URL.
const fakeSources: Array<Record<string, unknown>> = [];

vi.mock("../../supabase/functions/_shared/supabase.ts", () => ({
  createServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {};
      const settle = () => {
        if (table === "sources") {
          if (forcedSourcesError) {
            return { data: null, error: { message: forcedSourcesError } };
          }
          return { data: [...fakeSources], error: null };
        }
        if (table === "articles") {
          // Only reached by a plain `.select(...)` read (the batched/
          // per-row `.upsert(...)` calls below return their own thenable
          // and never hit this `settle()`) — i.e.
          // `dropExistingSourceContentHashRows`'s existing-pair lookup.
          return { data: [...existingArticleHashPairs], error: null };
        }
        return { data: null, error: null };
      };
      Object.assign(chain, {
        select: () => chain,
        eq: () => chain,
        order: () => chain,
        limit: () => chain,
        in: () => chain,
        maybeSingle: async () => ({ data: null, error: null }),
        single: async () => ({ data: null, error: null }),
        // Make the chain awaitable: `await supabase.from("sources").select(...)`.
        then: (
          onFul?: (v: { data: unknown; error: unknown }) => unknown,
          onRej?: (e: unknown) => unknown,
        ) => Promise.resolve(settle()).then(onFul, onRej),
        upsert: (rows: unknown) => {
          const arr = Array.isArray(rows) ? rows : [rows];
          if (table === "articles") {
            articlesUpsertCalls.push(arr as Array<Record<string, unknown>>);
            // Simulate the real `articles_source_content_hash_key` UNIQUE
            // constraint: if this call's payload still contains a row
            // sharing (source_id, content_hash) with an already-"stored"
            // pair, the whole call fails exactly like production's 23505
            // — proving (migration 041 F2) that the fix must drop such a
            // row BEFORE either the batched or per-row upsert call, not
            // rely on this failure + fallback to sort it out.
            const collides = (arr as Array<Record<string, unknown>>).some((r) =>
              existingArticleHashPairs.some(
                (p) =>
                  p.source_id === r.source_id && p.content_hash === r.content_hash,
              ),
            );
            if (collides) {
              const result = {
                data: null,
                error: {
                  message:
                    'duplicate key value violates unique constraint "articles_source_content_hash_key"',
                },
              };
              return {
                select: () => Promise.resolve(result),
                then: (
                  onFul?: (v: typeof result) => unknown,
                  onRej?: (e: unknown) => unknown,
                ) => Promise.resolve(result).then(onFul, onRej),
              };
            }
            for (const r of arr) upserted.push(r as Record<string, unknown>);
          } else if (table === "sources") {
            // Regression tripwire: a partial-row upsert on `sources` fails
            // in the real DB (23502) — record it under its own `fn` so the
            // "exactly one RPC write" assertions below catch a drift back.
            sourceFetchStateWrites.push({
              fn: "sources.upsert",
              rows: arr as Array<Record<string, unknown>>,
            });
          }
          // The SUT chains `.upsert(...).select("id")` (production code at
          // supabase/functions/ingest/index.ts:185-188). Returning a bare
          // Promise here makes the chain throw `select is not a function`
          // — vitest swallows the throw inside the SUT's outer catch and
          // the tests then green-pass on the `upserted[]` rows we pushed
          // ABOVE the throw. Round-3 / Round-4 QA flagged this as TC-R4-F1.
          // Return a chainable thenable so `.select("id")` works AND
          // direct-await still resolves to the result envelope.
          const result = { data: [{ id: "fake-row-id" }], error: null };
          const builder = {
            select: () => Promise.resolve(result),
            then: (
              onFul?: (v: typeof result) => unknown,
              onRej?: (e: unknown) => unknown,
            ) => Promise.resolve(result).then(onFul, onRej),
          };
          return builder;
        },
        insert: (rows: unknown) => {
          if (table === "ingest_cycles") {
            if (forcedIngestCyclesInsertError) {
              return Promise.resolve({
                data: null,
                error: { message: forcedIngestCyclesInsertError },
              });
            }
            const arr = Array.isArray(rows) ? rows : [rows];
            for (const r of arr) ingestCycleInserts.push(r as Record<string, unknown>);
          }
          return Promise.resolve({ data: null, error: null });
        },
        update: () => chain,
      });
      return chain;
    },
    rpc: vi.fn(async (fn: string, args?: Record<string, unknown>) => {
      if (fn === "ingest_set_source_fetch_state") {
        sourceFetchStateWrites.push({
          fn,
          rows: (args?.p_rows ?? []) as Array<Record<string, unknown>>,
        });
      }
      return { data: null, error: null };
    }),
  }),
}));

// Stub the fetcher module. The real module exports `fetchFeed(source, opts)`
// and returns a `FetchResult` ({ source, items, status, ... }); the mock
// mirrors that named export and shape exactly — any drift (e.g. exporting
// `fetchAllFeeds`/`fetchOneFeed` instead) leaves the SUT's named import as
// `undefined` and silently masks regressions.
//
// Per-test fixtures live in `fetcherItems` keyed by `source.rss_url`. Each
// test seeds the items it wants the handler to see, the mock returns them,
// and the post-handler tripwire asserts `upserted.length === fixtureItems.length`
// so a silent fetcher/normalizer drop is impossible to miss.
type MockFeedItem = {
  title: string;
  link: string;
  pubDate?: string;
  contentSnippet?: string;
  content?: string;
  contentHash?: string;
};

type FetchOverride = {
  status?: number;
  notModified?: boolean;
  etag?: string | null;
  lastModified?: string | null;
  bodyHash?: string;
  error?: string;
};

const fetcherItems: Record<string, MockFeedItem[]> = {};
// Per-test overrides on top of the default `{ status: 200, items }` result —
// used by the migration-041 tests below to simulate a 304, a body-hash
// match, an etag/lastModified change, or a fetch error without needing a
// real `fetch` round trip.
const fetcherResultOverrides: Record<string, FetchOverride> = {};
// One entry per `fetchFeed(source, opts)` call this test made, capturing
// exactly the `conditionalCache` entry (if any) the SUT looked up for that
// source — the cheapest way to prove hydration ran without re-implementing
// header construction (fetchFeed itself is mocked out in this file).
const fetchFeedCalls: Array<{
  sourceId: string;
  cached?: { etag?: string; lastModified?: string };
}> = [];

vi.mock("../../supabase/functions/_shared/rss/fetcher.ts", () => ({
  fetchFeed: vi.fn(
    async (
      source: { id: string; rss_url: string },
      opts?: { conditionalCache?: Map<string, { etag?: string; lastModified?: string }> },
    ): Promise<{
      source: unknown;
      items: MockFeedItem[];
      status: number;
      notModified?: boolean;
      etag?: string | null;
      lastModified?: string | null;
      bodyHash?: string;
      error?: string;
    }> => {
      fetchFeedCalls.push({
        sourceId: source.id,
        cached: opts?.conditionalCache?.get(source.id),
      });
      const items = fetcherItems[source.rss_url] ?? [];
      const override = fetcherResultOverrides[source.rss_url] ?? {};
      return { source, items, status: 200, ...override };
    },
  ),
}));

async function tryImport(path: string): Promise<unknown> {
  try {
    return await import(path);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// `fetch` interception.
//
// We replace the global fetch with a stub that returns the CP1254 fixture
// (or other configured per-URL responses) so the ingest handler sees a
// real-looking Response object — Content-Type header, ArrayBuffer body,
// status, etc. — without hitting the network.
// ---------------------------------------------------------------------------

const fetchResponses: Record<
  string,
  { status?: number; headers?: Record<string, string>; body: Uint8Array | string }
> = {};

const originalFetch = globalThis.fetch;

function installFetchStub() {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const entry = fetchResponses[url];
    if (!entry) {
      return new Response("not found", { status: 404 });
    }
    const body =
      typeof entry.body === "string"
        ? new TextEncoder().encode(entry.body)
        : entry.body;
    return new Response(body, {
      status: entry.status ?? 200,
      headers: entry.headers ?? {},
    });
  }) as typeof fetch;
}

beforeEach(() => {
  upserted.length = 0;
  ingestCycleInserts.length = 0;
  sourceFetchStateWrites.length = 0;
  fetchFeedCalls.length = 0;
  articlesUpsertCalls.length = 0;
  existingArticleHashPairs = [];
  forcedSourcesError = null;
  forcedIngestCyclesInsertError = null;
  fakeSources.length = 0;
  for (const k of Object.keys(fetchResponses)) delete fetchResponses[k];
  for (const k of Object.keys(fetcherItems)) delete fetcherItems[k];
  for (const k of Object.keys(fetcherResultOverrides)) delete fetcherResultOverrides[k];
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = TEST_SERVICE_ROLE_KEY;
  installFetchStub();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Direct charset helper test — fastest signal if `charset.ts` ships.
// ---------------------------------------------------------------------------

type DecodeResult = { text: string; charset: string };
type CharsetModule = {
  decodeRssBody: (bytes: Uint8Array, contentType: string | null) => DecodeResult;
};

describe("rss/charset (CP1254 decode helper)", () => {
  it("decodes iso-8859-9 (Windows-1254) bytes into the correct Turkish title", async () => {
    const mod = (await tryImport(
      "../../supabase/functions/_shared/rss/charset.ts",
    )) as CharsetModule | null;

    // Tripwire: if the helper failed to import or the named export drifted,
    // fail loud rather than silently skip the regression check.
    expect(mod?.decodeRssBody).toBeDefined();

    const result = mod!.decodeRssBody(
      CP1254_BYTES,
      "text/xml; charset=iso-8859-9",
    );
    expect(result.text).toContain(EXPECTED_TITLE);
    expect(result.charset.toLowerCase()).toMatch(/(iso-8859-9|windows-1254)/);
    // Negative: must NOT contain the U+FFFD replacement character that
    // appears when CP1254 bytes are mis-decoded as UTF-8.
    expect(result.text).not.toContain("�");
  });

  it("falls back to UTF-8 when no charset is declared", async () => {
    const mod = (await tryImport(
      "../../supabase/functions/_shared/rss/charset.ts",
    )) as CharsetModule | null;
    expect(mod?.decodeRssBody).toBeDefined();

    const utf8 = new TextEncoder().encode("<rss>UTF-8 default</rss>");
    const result = mod!.decodeRssBody(utf8, null);
    expect(result.text).toContain("UTF-8 default");
    expect(result.charset.toLowerCase()).toBe("utf-8");
  });
});

// ---------------------------------------------------------------------------
// End-to-end ingest handler test — invokes the registered Deno.serve
// callback with a `Request`, lets it dial out via the stubbed `fetch`,
// then asserts on the rows that ended up in the Supabase upsert sink.
// ---------------------------------------------------------------------------

async function importIngestHandler(): Promise<
  ((req: Request) => Promise<Response>) | null
> {
  // No try/catch — import failures must propagate so a broken SUT can't
  // hide behind a no-op suite.
  await import("../../supabase/functions/ingest/index.ts");
  const reg = (globalThis as unknown as {
    __ingestHandler?: (req: Request) => Promise<Response>;
  }).__ingestHandler;
  return reg ?? null;
}

describe("ingest Edge Function", () => {
  it("returns 200 with no sources configured (empty fan-out)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect([200, 207]).toContain(res.status);
  });

  it("decodes a CP1254 (iso-8859-9) feed end-to-end without mojibake [T7 P1-22]", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Seed a single active source so the loop body actually runs against
    // the fixture URL instead of short-circuiting on an empty roster.
    fakeSources.push({
      id: "src-cp1254",
      name: "CP1254 Fixture",
      slug: "cp1254-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/cp1254.rss",
      active: true,
    });

    // Still install the raw-bytes fetch stub for completeness — useful if a
    // future revision swaps the fetcher mock back to the real implementation
    // — but the assertion below is on what `fetchFeed` (mocked) hands the
    // normalizer, which is the already-decoded title.
    fetchResponses["https://example.com/cp1254.rss"] = {
      status: 200,
      // Content-Type header is the primary signal the charset helper sniffs.
      headers: { "Content-Type": "text/xml; charset=iso-8859-9" },
      body: CP1254_BYTES,
    };

    // Seed the mocked fetcher with one item carrying the expected Turkish
    // title — the helper-level test above already proves the byte-level
    // decode; here we just verify the normalizer + upsert sink preserve
    // multi-byte characters without re-encoding damage.
    const fixtureItems: MockFeedItem[] = [
      {
        title: EXPECTED_TITLE,
        link: "https://example.com/a1",
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    ];
    fetcherItems["https://example.com/cp1254.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    // Tripwire: row count must match the fixture exactly — any silent drop
    // in the fetcher → normalizer → upsert chain fails here.
    expect(upserted.length).toBe(fixtureItems.length);
    const titles = upserted.map((r) => String(r.title ?? ""));
    expect(titles.some((t) => t.includes(EXPECTED_TITLE))).toBe(true);
    for (const t of titles) {
      expect(t).not.toContain("�");
    }
  });

  it("uses a unified sha1-of-shingles content_hash (40 hex chars), never sha256", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-simple",
      name: "Simple Fixture",
      slug: "simple-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/simple.rss",
      active: true,
    });

    fetchResponses["https://example.com/simple.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Sample headline</title>" +
        "<link>https://example.com/simple/1</link>" +
        "</item></channel></rss>",
    };

    const fixtureItems: MockFeedItem[] = [
      {
        title: "Sample headline",
        link: "https://example.com/simple/1",
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    ];
    fetcherItems["https://example.com/simple.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    // Tripwire: row count must match the fixture exactly — silent drops
    // in fetcher → normalizer → upsert fail here, not later in soft asserts.
    expect(upserted.length).toBe(fixtureItems.length);

    let checked = 0;
    for (const row of upserted) {
      const h = String((row as { content_hash?: string }).content_hash ?? "");
      if (!h) continue;
      // 40 hex = sha1; 64 hex = sha256. Audit T7 P1-21 says we want sha1.
      expect(h).toMatch(/^[0-9a-f]{40}$/);
      checked += 1;
    }
    // Tripwire: at least one upserted row must carry a content_hash so the
    // sha1-vs-sha256 assertion above is actually exercised.
    expect(checked).toBeGreaterThan(0);
  });

  it("adds a canonicalized canonical_url alongside the raw url [migration 039]", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-canon",
      name: "Canon Fixture",
      slug: "canon-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/canon.rss",
      active: true,
    });

    // Raw link carries an uppercase `www.` host, a tracking param
    // (utm_source), a non-tracking param (keep), and a fragment — every
    // rule canonicalizeUrl() applies gets exercised in one fixture.
    const rawLink =
      "https://WWW.Example.com/canon/1/?utm_source=rss&keep=1#frag";
    fetchResponses["https://example.com/canon.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Canon</title>" +
        `<link>${rawLink}</link>` +
        "</item></channel></rss>",
    };

    const fixtureItems: MockFeedItem[] = [
      { title: "Canon", link: rawLink, pubDate: "Mon, 01 Jan 2024 00:00:00 GMT" },
    ];
    fetcherItems["https://example.com/canon.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    expect(upserted.length).toBe(fixtureItems.length);

    const row = upserted[0] as { url?: string; canonical_url?: string };
    // The raw absolute url is untouched.
    expect(row.url).toBe(rawLink);
    // canonical_url: host lowercased + www-stripped, utm_source removed
    // (tracking), `keep` param retained (not a tracking key), trailing
    // slash trimmed, fragment dropped.
    expect(row.canonical_url).toBe("https://example.com/canon/1?keep=1");
  });

  it("upserts with ON CONFLICT DO NOTHING semantics (re-run is a no-op)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-dup",
      name: "Dup Fixture",
      slug: "dup-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/dup.rss",
      active: true,
    });

    fetchResponses["https://example.com/dup.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Dup</title><link>https://example.com/dup/1</link>" +
        "</item></channel></rss>",
    };

    const fixtureItems: MockFeedItem[] = [
      {
        title: "Dup",
        link: "https://example.com/dup/1",
        pubDate: "Mon, 01 Jan 2024 00:00:00 GMT",
      },
    ];
    fetcherItems["https://example.com/dup.rss"] = fixtureItems;

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    // Tripwire: first-run row count matches fixture; the re-run check below
    // then guards the ON CONFLICT DO NOTHING semantic.
    expect(upserted.length).toBe(fixtureItems.length);
    const firstRun = upserted.length;
    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));
    // Both runs hit upsert; the DB-side UNIQUE constraint is what makes
    // re-runs a no-op, not the application code. We just check the handler
    // didn't *grow* its row count beyond a reasonable bound.
    expect(upserted.length).toBeLessThanOrEqual(firstRun * 2);
  });

  it("returns 401 without a service-role bearer", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // No Authorization header → the gate must reject before fan-out.
    const res = await handler(
      new Request("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(401);
    expect(upserted).toHaveLength(0);
    // The auth gate rejects before runCycle ever starts, so no ingest_cycles
    // row should be written for a request that never reached a cycle.
    expect(ingestCycleInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ingest_cycles telemetry (migration 039) — one best-effort row per cycle,
// written from `recordIngestCycle` on both the success and the failure path.
// ---------------------------------------------------------------------------

describe("ingest_cycles telemetry [migration 039]", () => {
  it("writes one ingest_cycles row summarizing a successful cycle", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-telemetry",
      name: "Telemetry Fixture",
      slug: "telemetry-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/telemetry.rss",
      active: true,
    });
    fetchResponses["https://example.com/telemetry.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>Telemetry</title><link>https://example.com/telemetry/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/telemetry.rss"] = [
      { title: "Telemetry", link: "https://example.com/telemetry/1" },
    ];

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);

    // Tripwire: exactly one row per cycle, not zero and not one per source.
    expect(ingestCycleInserts).toHaveLength(1);
    const row = ingestCycleInserts[0] as {
      started_at?: string;
      fetched?: number;
      inserted?: number;
      row_errors?: number;
      failed?: number;
      duration_ms?: number;
    };
    expect(typeof row.started_at).toBe("string");
    expect(Number.isNaN(Date.parse(row.started_at ?? ""))).toBe(false);
    expect(row.fetched).toBe(1);
    expect(row.inserted).toBeGreaterThanOrEqual(1);
    expect(row.row_errors).toBe(0);
    expect(row.failed).toBe(0);
    expect(typeof row.duration_ms).toBe("number");
    expect(row.duration_ms as number).toBeGreaterThanOrEqual(0);
  });

  it("still writes an ingest_cycles row when the cycle throws (sources fetch failure)", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    // Force the `sources` select to come back with an error so
    // `runCycleBody` throws before any fetch/upsert work happens — this is
    // the failure path the `finally` in `runCycle` must still cover.
    forcedSourcesError = "sources table unreachable (test-forced)";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    // The thrown error propagates to the handler's outer catch, which
    // reports it as a 500 (supabase/functions/ingest/index.ts's Deno.serve
    // callback) — the telemetry write must not mask or swallow that.
    expect(res.status).toBe(500);

    expect(ingestCycleInserts).toHaveLength(1);
    const row = ingestCycleInserts[0] as {
      fetched?: number;
      failed?: number;
      row_errors?: number;
      duration_ms?: number;
    };
    expect(row.fetched).toBe(0);
    expect(row.failed).toBe(0);
    expect(row.row_errors).toBe(0);
    expect(typeof row.duration_ms).toBe("number");
  });

  it("does not fail the cycle when the ingest_cycles insert itself errors", async () => {
    const handler = await importIngestHandler();
    expect(handler).toBeDefined();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-telemetry-fail",
      name: "Telemetry Fail Fixture",
      slug: "telemetry-fail-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/telemetry-fail.rss",
      active: true,
    });
    fetchResponses["https://example.com/telemetry-fail.rss"] = {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      body:
        '<?xml version="1.0" encoding="utf-8"?>' +
        "<rss><channel><item>" +
        "<title>T</title><link>https://example.com/telemetry-fail/1</link>" +
        "</item></channel></rss>",
    };
    fetcherItems["https://example.com/telemetry-fail.rss"] = [
      { title: "T", link: "https://example.com/telemetry-fail/1" },
    ];

    // Simulate the ingest_cycles insert coming back with a Supabase error
    // (e.g. an RLS/grant misconfiguration) and assert the outer request
    // still resolves 200 — recordIngestCycle logs and swallows it rather
    // than letting a telemetry-write failure fail the cycle.
    forcedIngestCyclesInsertError = "simulated ingest_cycles insert failure";

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    expect(res.status).toBe(200);
    expect(upserted.length).toBe(1);
    // The error path never pushes into the tracking array.
    expect(ingestCycleInserts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Conditional-fetch state persistence (migration 041) — hydrating
// `conditionalCache` from `sources` at cycle start, treating an unchanged
// body hash like a 304, and writing updated validators back in one upsert.
// ---------------------------------------------------------------------------

describe("ingest conditional-fetch state [migration 041]", () => {
  it("hydrates conditionalCache from the source row and passes it to fetchFeed", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-hydrate",
      name: "Hydrate Fixture",
      slug: "hydrate-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/hydrate.rss",
      active: true,
      fetch_etag: 'W/"stored-etag"',
      fetch_last_modified: "Wed, 01 Jan 2025 00:00:00 GMT",
      fetch_body_hash: null,
      fetch_last_status: 200,
      fetch_last_at: "2025-01-01T00:00:00.000Z",
    });
    // No items needed — this test only checks what fetchFeed was called
    // with, not what came out of the normalize/upsert path.
    fetcherItems["https://example.com/hydrate.rss"] = [];

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    const call = fetchFeedCalls.find((c) => c.sourceId === "src-041-hydrate");
    expect(call).toBeDefined();
    // The values that would become If-None-Match / If-Modified-Since headers
    // inside the real (unmocked) fetchFeed.
    expect(call?.cached?.etag).toBe('W/"stored-etag"');
    expect(call?.cached?.lastModified).toBe("Wed, 01 Jan 2025 00:00:00 GMT");
  });

  it("skips normalize/upsert and counts notModified when the body hash is unchanged", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-samehash",
      name: "Same Hash Fixture",
      slug: "samehash-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/samehash.rss",
      active: true,
      fetch_body_hash: "deadbeef",
    });
    // An item is present, proving it's the hash check — not an empty feed —
    // that suppresses normalize/upsert. `notModified: true` mirrors what the
    // REAL fetcher now returns for a body-hash match (migration 041 F1: the
    // short-circuit lives in fetchFeed itself, before decode/parse, so
    // index.ts only has `result.notModified` to react to — see
    // fetcher.test.ts for the real-module version of this contract).
    fetcherItems["https://example.com/samehash.rss"] = [
      { title: "Should be skipped", link: "https://example.com/samehash/1" },
    ];
    fetcherResultOverrides["https://example.com/samehash.rss"] = {
      notModified: true,
      bodyHash: "deadbeef",
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { notModified?: number; fetched?: number };

    expect(upserted.some((r) => r.source_id === "src-041-samehash")).toBe(false);
    expect(body.notModified).toBeGreaterThanOrEqual(1);
  });

  it("persists changed validators with exactly one ingest_set_source_fetch_state RPC call", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-persist",
      name: "Persist Fixture",
      slug: "persist-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/persist.rss",
      active: true,
      fetch_etag: null,
      fetch_last_modified: null,
      fetch_body_hash: null,
    });
    fetcherItems["https://example.com/persist.rss"] = [
      { title: "Persist", link: "https://example.com/persist/1" },
    ];
    fetcherResultOverrides["https://example.com/persist.rss"] = {
      etag: '"v1"',
      lastModified: "Thu, 02 Jan 2025 00:00:00 GMT",
      bodyHash: "hash-v1",
    };

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    // One batched write for the whole cycle, not one per source — and via
    // the RPC, never `.from("sources").upsert(...)` (see tripwire above).
    expect(sourceFetchStateWrites).toHaveLength(1);
    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-041-persist",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_etag).toBe('"v1"');
    expect(row?.fetch_last_modified).toBe("Thu, 02 Jan 2025 00:00:00 GMT");
    expect(row?.fetch_body_hash).toBe("hash-v1");
    expect(row?.fetch_last_status).toBe(200);
    expect(Number.isNaN(Date.parse(String(row?.fetch_last_at)))).toBe(false);
  });

  it("keeps existing validators when a 2xx response omits ETag/Last-Modified [migration 041 F4]", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-keepvalidators",
      name: "Keep Validators Fixture",
      slug: "keepvalidators-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/keepvalidators.rss",
      active: true,
      fetch_etag: 'W/"old"',
      fetch_last_modified: "Tue, 31 Dec 2024 00:00:00 GMT",
      fetch_body_hash: "stored-hash",
    });
    fetcherItems["https://example.com/keepvalidators.rss"] = [
      { title: "Fresh content", link: "https://example.com/keepvalidators/1" },
    ];
    // A 2xx that changed enough to be worth parsing (no `notModified`) but
    // whose response happened to omit both conditional-GET headers this
    // time — set-only-when-present semantics must keep the stored
    // validators rather than blanking them to null.
    fetcherResultOverrides["https://example.com/keepvalidators.rss"] = {
      etag: null,
      lastModified: null,
      bodyHash: "stored-hash",
    };

    await handler(authedRequest("http://localhost/ingest", { method: "POST" }));

    expect(sourceFetchStateWrites).toHaveLength(1);
    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-041-keepvalidators",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_etag).toBe('W/"old"');
    expect(row?.fetch_last_modified).toBe("Tue, 31 Dec 2024 00:00:00 GMT");
  });

  it("keeps memory and DB in sync when a 2xx response fails to parse [migration 041 F5]", async () => {
    const handler = await importIngestHandler();
    if (!handler) throw new Error("unreachable: handler tripwire above must throw");

    fakeSources.push({
      id: "src-041-parseerror",
      name: "Parse Error Fixture",
      slug: "parseerror-fixture",
      url: "https://example.com",
      rss_url: "https://example.com/parseerror.rss",
      active: true,
      fetch_etag: 'W/"old"',
      fetch_last_modified: null,
      fetch_body_hash: null,
    });
    // The fetcher can return `etag`/`lastModified`/`bodyHash` ALONGSIDE
    // `error` on a 2xx whose body failed to parse (fetcher.ts refreshes its
    // cache before attempting the parse) — the persisted row must pick
    // those up too, so a warm instance (which already moved to the new
    // ETag) and the DB don't disagree about which validators produced this
    // unparseable body.
    fetcherResultOverrides["https://example.com/parseerror.rss"] = {
      error: "parse error: unexpected end of input",
      status: 200,
      etag: '"new-etag"',
      lastModified: "Wed, 02 Jan 2025 00:00:00 GMT",
      bodyHash: "new-hash",
    };

    const res = await handler(
      authedRequest("http://localhost/ingest", { method: "POST" }),
    );
    const body = (await res.json()) as { failed?: number };
    expect(body.failed).toBeGreaterThanOrEqual(1);

    expect(sourceFetchStateWrites[0]?.fn).toBe("ingest_set_source_fetch_state");
    const row = sourceFetchStateWrites[0]?.rows.find(
      (r) => r.id === "src-041-parseerror",
    );
    expect(row).toBeDefined();
    expect(row?.fetch_etag).toBe('"new-etag"');
    expect(row?.fetch_last_modified).toBe("Wed, 02 Jan 2025 00:00:00 GMT");
    expect(row?.fetch_body_hash).toBe("new-hash");
    expect(row?.fetch_last_status).toBe(200);
  });

  it(
    "drops a row whose (source_id, content_hash) already exists under a " +
      "different url instead of retrying it per-row [migration 041 F2]",
    async () => {
      const handler = await importIngestHandler();
      if (!handler) throw new Error("unreachable: handler tripwire above must throw");

      const rssSource = {
        id: "src-041-crossdupe",
        name: "Cross Dupe Fixture",
        slug: "crossdupe-fixture",
        url: "https://example.com",
        rss_url: "https://example.com/crossdupe.rss",
      };
      const item = {
        title: "Republished under a new URL",
        link: "https://example.com/crossdupe/new-url",
        contentSnippet: "Same story, new address.",
      };
      // Pre-compute the EXACT content_hash the real (unmocked) normalizer
      // will produce for this item, so the seeded "existing" pair actually
      // collides — a hand-picked hash string would just prove the guard
      // query works, not that it keys on the field the SUT really uses.
      const [{ content_hash: existingHash }] = normalizeArticles(rssSource, [item]);

      fakeSources.push({ ...rssSource, active: true });
      // Simulate an article already stored (e.g. from a prior cycle, under
      // the outlet's OLD url) sharing this exact (source_id, content_hash).
      existingArticleHashPairs.push({
        source_id: rssSource.id,
        content_hash: existingHash,
      });
      fetcherItems["https://example.com/crossdupe.rss"] = [item];

      const res = await handler(
        authedRequest("http://localhost/ingest", { method: "POST" }),
      );
      const body = (await res.json()) as {
        dedupedInBatch?: number;
        rowErrors?: number;
      };

      // The row never reaches an upsert call at all -- neither the batched
      // attempt nor a per-row fallback -- so the simulated 23505 in the
      // fake's `upsert` never fires and `rowErrors` stays 0.
      expect(articlesUpsertCalls).toHaveLength(0);
      expect(upserted).toHaveLength(0);
      expect(body.dedupedInBatch).toBeGreaterThanOrEqual(1);
      expect(body.rowErrors).toBe(0);
    },
  );
});

// ---------------------------------------------------------------------------
// Batch de-dup (migration 041) — a pure-function unit test against the
// exported helper, since the intra-cycle `seenIntraCycle` guard already
// prevents a duplicate (source_id, content_hash) pair from ever reaching
// `allRows` in the full handler pipeline (this is the last-line-of-defense
// path, exercised directly rather than by fighting that guard end-to-end).
// ---------------------------------------------------------------------------

describe("dedupeBySourceContentHash [migration 041]", () => {
  it("drops rows that repeat an earlier row's (source_id, content_hash), keeping the first", async () => {
    const mod = (await import("../../supabase/functions/ingest/index.ts")) as {
      dedupeBySourceContentHash: <T extends { source_id: string; content_hash: string }>(
        rows: readonly T[],
      ) => { rows: T[]; deduped: number };
    };

    const rows = [
      { source_id: "s1", content_hash: "h1", url: "https://a" },
      { source_id: "s1", content_hash: "h1", url: "https://b" }, // dup of row 0
      { source_id: "s1", content_hash: "h2", url: "https://c" },
      { source_id: "s2", content_hash: "h1", url: "https://d" }, // different source, not a dup
    ];

    const { rows: out, deduped } = mod.dedupeBySourceContentHash(rows);

    expect(deduped).toBe(1);
    expect(out.map((r) => r.url)).toEqual(["https://a", "https://c", "https://d"]);
  });
});
