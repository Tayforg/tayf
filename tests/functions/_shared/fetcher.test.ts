import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Direct coverage for supabase/functions/_shared/rss/fetcher.ts (migration
// 041 F6). ingest.test.ts only exercises `fetchFeed` through a `vi.mock` of
// this whole module, so the real If-None-Match / If-Modified-Since header
// construction — and the body-hash short-circuit added for F1 — were never
// actually driven end-to-end.
//
// `fetcher.ts` imports its XML parser from a bare `https://esm.sh/...`
// specifier (a Deno-only remote import; there is no local `fast-xml-parser`
// npm package in this repo's node_modules and installing one is out of
// scope here). Node's ESM loader can't resolve that URL at all, so this
// file mocks ONLY that one import — everything else (header construction,
// the 304 branch, the F1 body-hash short-circuit, decode) runs as the REAL
// `fetchFeed` against a stubbed global `fetch`, and the mock parser lets us
// assert directly on whether `.parse()` was ever invoked, rather than
// inferring it indirectly from malformed input.
// ---------------------------------------------------------------------------

const { xmlParseCalls } = vi.hoisted(() => ({ xmlParseCalls: [] as string[] }));

vi.mock("https://esm.sh/fast-xml-parser@4.5.0", () => ({
  XMLParser: class {
    parse(xml: string) {
      xmlParseCalls.push(xml);
      return {
        rss: {
          channel: {
            item: [{ title: "Hello", link: "https://example.com/a" }],
          },
        },
      };
    }
  },
}));

const { fetchFeed } = await import(
  "../../../supabase/functions/_shared/rss/fetcher.ts"
);
type RssSource = Parameters<typeof fetchFeed>[0];

const source: RssSource = {
  id: "src-1",
  name: "Fixture",
  slug: "fixture",
  url: "https://example.com",
  rss_url: "https://example.com/feed.xml",
};

const FEED_XML =
  '<?xml version="1.0" encoding="utf-8"?>' +
  "<rss><channel><item>" +
  "<title>Hello</title><link>https://example.com/a</link>" +
  "</item></channel></rss>";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

let capturedInit: RequestInit | undefined;
const originalFetch = globalThis.fetch;

function stubFetch(respond: () => Response) {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    capturedInit = init;
    return respond();
  }) as typeof fetch;
}

beforeEach(() => {
  xmlParseCalls.length = 0;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedInit = undefined;
});

describe("fetchFeed request headers [migration 041 F6]", () => {
  it("sends If-None-Match and If-Modified-Since from the conditional cache", async () => {
    stubFetch(
      () =>
        new Response(FEED_XML, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
        }),
    );
    const conditionalCache = new Map([
      [source.id, { etag: 'W/"x"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" }],
    ]);

    await fetchFeed(source, { conditionalCache });

    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("If-None-Match")).toBe('W/"x"');
    expect(headers.get("If-Modified-Since")).toBe(
      "Wed, 01 Jan 2025 00:00:00 GMT",
    );
  });

  it("omits the conditional headers when the cache has no entry for this source", async () => {
    stubFetch(
      () =>
        new Response(FEED_XML, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
        }),
    );

    await fetchFeed(source, { conditionalCache: new Map() });

    const headers = new Headers(capturedInit?.headers);
    expect(headers.has("If-None-Match")).toBe(false);
    expect(headers.has("If-Modified-Since")).toBe(false);
  });

  it("returns notModified on a 304 and leaves the cache entry untouched, without parsing", async () => {
    stubFetch(() => new Response(null, { status: 304 }));
    const conditionalCache = new Map([
      [source.id, { etag: 'W/"x"', lastModified: "Wed, 01 Jan 2025 00:00:00 GMT" }],
    ]);

    const result = await fetchFeed(source, { conditionalCache });

    expect(result.notModified).toBe(true);
    expect(result.items).toEqual([]);
    expect(conditionalCache.get(source.id)).toEqual({
      etag: 'W/"x"',
      lastModified: "Wed, 01 Jan 2025 00:00:00 GMT",
    });
    expect(xmlParseCalls).toHaveLength(0);
  });

  it(
    "short-circuits on a matching knownBodyHash BEFORE parsing " +
      "[migration 041 F1]",
    async () => {
      const knownBodyHash = await sha256Hex(FEED_XML);
      stubFetch(
        () =>
          new Response(FEED_XML, {
            status: 200,
            headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
          }),
      );

      const result = await fetchFeed(source, { knownBodyHash });

      expect(result.notModified).toBe(true);
      expect(result.items).toEqual([]);
      expect(result.bodyHash).toBe(knownBodyHash);
      expect(result.error).toBeUndefined();
      // The definitive proof the short-circuit runs BEFORE decode/parse:
      // the mock parser (which would otherwise happily return the "Hello"
      // item) is never invoked at all.
      expect(xmlParseCalls).toHaveLength(0);
    },
  );

  it("parses normally (and does not short-circuit) when knownBodyHash does not match", async () => {
    stubFetch(
      () =>
        new Response(FEED_XML, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
        }),
    );

    const result = await fetchFeed(source, { knownBodyHash: "not-the-real-hash" });

    expect(result.notModified).toBeUndefined();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Hello");
    expect(xmlParseCalls).toHaveLength(1);
  });
});
