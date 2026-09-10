import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Direct coverage for supabase/functions/_shared/rss/fetcher.ts (migration
// 041 F6, and SEC-01: routing fetchFeed through the shared SSRF guard).
// ingest.test.ts only exercises `fetchFeed` through a `vi.mock` of this
// whole module, so the real If-None-Match / If-Modified-Since header
// construction, the body-hash short-circuit (F1), and the SSRF guard itself
// were never actually driven end-to-end.
//
// `fetcher.ts` imports its XML parser from a bare `https://esm.sh/...`
// specifier (a Deno-only remote import; there is no local `fast-xml-parser`
// npm package in this repo's node_modules and installing one is out of
// scope here). Node's ESM loader can't resolve that URL at all, so this
// file mocks ONLY that one import — everything else (header construction,
// the 304 branch, the F1 body-hash short-circuit, decode, and now the
// SEC-01 SSRF guard) runs as the REAL `fetchFeed` against a stubbed global
// `fetch`, and the mock parser lets us assert directly on whether
// `.parse()` was ever invoked, rather than inferring it indirectly from
// malformed input.
//
// The moment fetcher.ts imports safe-fetch.ts (SEC-01), `Deno.resolveDns`
// is called on every fetchFeed invocation — `Deno` doesn't exist in the
// vitest Node env, so every test in this file (not just the new SSRF
// cases) now needs a stub. `beforeEach` installs a default that resolves
// to a public IP so the five pre-existing tests keep passing unmodified;
// individual SSRF tests override it per-case.
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

// ---------------------------------------------------------------------------
// Deno.resolveDns stub — copied from safe-fetch.test.ts's `stubResolveDns`
// so this file can drive the SEC-01 guard's DNS-dependent branches without
// a real Deno runtime.
// ---------------------------------------------------------------------------

interface DenoStub {
  resolveDns: ReturnType<typeof vi.fn>;
  serve: ReturnType<typeof vi.fn>;
}

function stubResolveDns(
  aRecords: string[],
  aaaaRecords: string[] = [],
): DenoStub {
  const resolveDns = vi.fn(async (_host: string, recordType: string) => {
    if (recordType === "A") {
      if (aRecords.length === 0) {
        throw new Error("NotFound");
      }
      return aRecords;
    }
    if (recordType === "AAAA") {
      if (aaaaRecords.length === 0) {
        throw new Error("NotFound");
      }
      return aaaaRecords;
    }
    throw new Error(`unexpected record type ${recordType}`);
  });
  const stub: DenoStub = { resolveDns, serve: vi.fn() };
  vi.stubGlobal("Deno", stub);
  return stub;
}

/** Concatenate ASCII string chunks and raw byte arrays into one Uint8Array —
 * lets a test spell out a non-ASCII fixture (windows-1254 byte values) next
 * to plain XML scaffolding without hand-encoding the whole buffer. */
function bytesFrom(...parts: Array<string | number[]>): Uint8Array {
  const chunks: number[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      for (let i = 0; i < part.length; i++) chunks.push(part.charCodeAt(i));
    } else {
      chunks.push(...part);
    }
  }
  return new Uint8Array(chunks);
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
  // Default: resolves to a public IPv4 so the SEC-01 guard's allow-check
  // passes and every pre-existing test keeps exercising the same
  // request/response path it did before the guard was added.
  stubResolveDns(["93.184.215.14"]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  capturedInit = undefined;
  vi.unstubAllGlobals();
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

// ---------------------------------------------------------------------------
// SEC-01: fetchFeed now routes through safeResponse — the same SSRF guard
// (DNS/redirect pinning, private-range blocking) the og-image path uses,
// instead of a bare `fetch({ redirect: "follow" })`. These cases drive the
// guard's DNS-dependent, redirect-dependent, and body-cap branches directly
// through the public `fetchFeed` contract.
// ---------------------------------------------------------------------------

describe("fetchFeed SSRF guard [SEC-01]", () => {
  it("rejects an rss_url whose DNS resolves into RFC1918 space without opening a socket", async () => {
    stubResolveDns(["10.0.0.5"]);
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new Error("fetch must never be called for a blocked host");
    }) as typeof fetch;

    const result = await fetchFeed(source);

    expect(result.status).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/rejected|blocked range/i);
    expect(fetchCallCount).toBe(0);
    expect(xmlParseCalls).toHaveLength(0);
  });

  it("rejects a literal link-local rss_url before any DNS lookup", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new Error("fetch must never be called for a link-local literal");
    }) as typeof fetch;

    const result = await fetchFeed({
      ...source,
      rss_url: "http://169.254.169.254/latest/meta-data",
    });

    expect(result.status).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/link-local/i);
    expect(fetchCallCount).toBe(0);
  });

  it("rejects a non-http(s) rss_url", async () => {
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      throw new Error("fetch must never be called for a non-http(s) scheme");
    }) as typeof fetch;

    const result = await fetchFeed({ ...source, rss_url: "file:///etc/passwd" });

    expect(result.status).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/protocol/i);
    expect(fetchCallCount).toBe(0);
  });

  it("re-validates the Location header and refuses a redirect into the metadata IP", async () => {
    stubResolveDns(["93.184.215.14"]);
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://169.254.169.254/latest/meta-data" },
        });
      }
      throw new Error("fetch must never reach the redirect target");
    }) as typeof fetch;

    const result = await fetchFeed(source);

    expect(result.status).toBe(0);
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/rejected/i);
    expect(fetchCallCount).toBe(1);
    expect(xmlParseCalls).toHaveLength(0);
  });

  it("follows a public→public redirect and parses the final body", async () => {
    stubResolveDns(["93.184.215.14"]);
    let fetchCallCount = 0;
    globalThis.fetch = (async () => {
      fetchCallCount++;
      if (fetchCallCount === 1) {
        return new Response(null, {
          status: 302,
          headers: { Location: "https://cdn.example.com/feed.xml" },
        });
      }
      return new Response(FEED_XML, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      });
    }) as typeof fetch;

    const result = await fetchFeed(source);

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.title).toBe("Hello");
    expect(result.status).toBe(200);
    expect(fetchCallCount).toBe(2);
  });

  it("carries the conditional and identity headers through the guard onto the wire", async () => {
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

    // Proves safeResponse forwards the caller's headers onto the dialed
    // request rather than dropping them in the redirect/pin loop.
    const headers = new Headers(capturedInit?.headers);
    expect(headers.get("If-None-Match")).toBe('W/"x"');
    expect(headers.get("Accept")).toContain("application/rss+xml");
    expect(headers.get("User-Agent")).toContain("Tayf/1.0");
  });

  it("reports an oversize body without decoding or parsing", async () => {
    stubFetch(
      () =>
        new Response("a".repeat(100), {
          status: 200,
          headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
        }),
    );

    const result = await fetchFeed(source, { maxBytes: 64 });

    expect(result.error).toMatch(/exceed/i);
    expect(result.items).toEqual([]);
    expect(xmlParseCalls).toHaveLength(0);
  });

  it("still decodes a windows-1254 body through the guard", async () => {
    // "şık" (chic) — ş=0xFE and ı=0xFD are the Turkish-specific
    // remappings that differ between ISO-8859-9/windows-1254 and plain
    // Latin-1/UTF-8, so a correct decode here is a real regression guard
    // that the refactor did not route the body through safeFetch's
    // UTF-8-only decoder.
    const bytes = bytesFrom(
      '<?xml version="1.0" encoding="iso-8859-9"?>',
      "<rss><channel><item><title>",
      [0xfe, 0xfd, 0x6b],
      "</title><link>https://example.com/a</link></item></channel></rss>",
    );
    stubFetch(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "Content-Type": "application/rss+xml; charset=iso-8859-9" },
        }),
    );

    const result = await fetchFeed(source);

    expect(result.charset).toMatch(/8859-9|1254/i);
    expect(xmlParseCalls).toHaveLength(1);
    expect(xmlParseCalls[0]).toContain("şık");
    expect(xmlParseCalls[0]).not.toContain("�");
  });
});
