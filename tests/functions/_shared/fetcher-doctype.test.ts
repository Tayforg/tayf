import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// h26-security-1: a hostile feed must never be able to take the ingest down.
//
// The ingest used to parse feeds with fast-xml-parser@4.5.0, which expands
// DOCTYPE entities without any limit: a 210 KB feed that declares one 200 KB
// entity and references it 2,000 times produced a 400+ MB <title> and killed
// the Edge isolate on every cycle for as long as the feed served it.
//
// Two layers, both asserted here:
//   1. fetcher.ts refuses any `<!ENTITY` declaration before the parser sees the
//      body (a plain linear scan). The throw is the existing per-feed
//      `parse error`, so ONE feed is skipped and the cycle survives.
//   2. the parser is pinned to a release whose own limits are active with our
//      options (checked against the real npm package, bypassing layer 1).
//
// Like fetcher.test.ts this runs the REAL fetchFeed/parseFeed; unlike it, the
// esm.sh parser import is mapped to the REAL package (the pin guard in
// tests/guards/edge-deps-pinned.test.ts keeps both versions in step).
// ---------------------------------------------------------------------------

vi.mock("https://esm.sh/fast-xml-parser@4.5.7", async () => await import("fast-xml-parser"));

const { fetchFeed, parseFeed, XML_PARSER_OPTIONS } = await import(
  "../../../supabase/functions/_shared/rss/fetcher.ts"
);
type RssSource = Parameters<typeof fetchFeed>[0];

const source: RssSource = {
  id: "src-hostile",
  name: "Hostile",
  slug: "hostile",
  url: "https://example.com",
  rss_url: "https://example.com/feed.xml",
};

// --- Deno.resolveDns + fetch stubs (copied from fetcher.test.ts) ------------

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

const originalFetch = globalThis.fetch;

function stubFetch(respond: () => Response) {
  globalThis.fetch = (async (
    _input: RequestInfo | URL,
    _init?: RequestInit,
  ): Promise<Response> => respond()) as typeof fetch;
}

beforeEach(() => {
  stubResolveDns(["93.184.215.14"]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

// --- payload builders -------------------------------------------------------

/** One RSS item wrapped in a feed, with an optional DOCTYPE in the prolog. */
function rss(title: string, doctype = ""): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    doctype +
    "<rss><channel><item>" +
    `<title>${title}</title><link>https://example.com/a</link>` +
    "</item></channel></rss>"
  );
}

/** The documented attack: one 200 KB entity referenced 2,000 times (~210 KB). */
function bombFeed(): string {
  return rss(
    "&e;".repeat(2000),
    `<!DOCTYPE rss [<!ENTITY e "${"A".repeat(204_800)}">]>`,
  );
}

/** Ten nested levels of ten references each: the classic billion laughs. */
function billionLaughsFeed(): string {
  let decls = '<!ENTITY l0 "lol">';
  for (let level = 1; level < 10; level++) {
    decls += `<!ENTITY l${level} "${`&l${level - 1};`.repeat(10)}">`;
  }
  return rss("&l9;", `<!DOCTYPE rss [${decls}]>`);
}

/** 9,000 chars is under the library's per-entity cap, but 900 uses are 8 MB. */
function manyUsesFeed(): string {
  return rss(
    "&e;".repeat(900),
    `<!DOCTYPE rss [<!ENTITY e "${"B".repeat(9000)}">]>`,
  );
}

function timed<T>(fn: () => T): { ms: number; value?: T; error?: unknown } {
  const start = performance.now();
  try {
    const value = fn();
    return { ms: performance.now() - start, value };
  } catch (error) {
    return { ms: performance.now() - start, error };
  }
}

function serve(xml: string) {
  stubFetch(
    () =>
      new Response(xml, {
        status: 200,
        headers: { "Content-Type": "application/rss+xml; charset=utf-8" },
      }),
  );
}

// ---------------------------------------------------------------------------

describe("parseFeed refuses DOCTYPE entity declarations before parsing", () => {
  it.each([
    ["the 210 KB entity bomb", bombFeed],
    ["a ten-level billion laughs", billionLaughsFeed],
    ["a 9,000-char entity used 900 times", manyUsesFeed],
  ])("%s throws fast", (_name, build) => {
    const xml = build();
    const { ms, error } = timed(() => parseFeed(xml));
    expect(error).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(200);
  });

  it("the 9,000 x 900 case is refused in under 50 ms", () => {
    const xml = manyUsesFeed();
    const { ms, error } = timed(() => parseFeed(xml));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/entity/i);
    expect(ms).toBeLessThan(50);
  });

  it("the bomb is about 210 KB, as documented", () => {
    expect(bombFeed().length).toBeGreaterThan(200_000);
    expect(bombFeed().length).toBeLessThan(220_000);
  });

  it("refuses an internal-subset entity even when it is tiny and used once", () => {
    const xml = rss("&x;", '<!DOCTYPE rss [<!ENTITY x "y">]>');
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });

  it("refuses an external (SYSTEM) entity declaration too", () => {
    const xml = rss(
      "&x;",
      '<!DOCTYPE rss [<!ENTITY x SYSTEM "file:///etc/passwd">]>',
    );
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });
});

describe("fetchFeed turns a hostile DOCTYPE into one skipped feed", () => {
  it.each([
    ["the 210 KB entity bomb", bombFeed],
    ["a ten-level billion laughs", billionLaughsFeed],
    ["a 9,000-char entity used 900 times", manyUsesFeed],
  ])("%s: no items, a `parse error`, quickly", async (_name, build) => {
    serve(build());
    const start = performance.now();
    const result = await fetchFeed(source);
    const ms = performance.now() - start;
    expect(result.items).toEqual([]);
    expect(result.error).toMatch(/^parse error/);
    expect(result.notAFeed).toBeUndefined();
    expect(ms).toBeLessThan(500);
    for (const item of result.items) {
      expect((item.title ?? "").length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("library pin: the real parser's own limits are active with our options", () => {
  it("throws on the bomb within 200 ms without our pre-check", () => {
    const xml = bombFeed();
    const { ms, error } = timed(() =>
      new XMLParser(XML_PARSER_OPTIONS).parse(xml),
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/size|exceed|limit/i);
    expect(ms).toBeLessThan(200);
  });

  it("throws on 900 uses of a 9,000-char entity without our pre-check", () => {
    const xml = manyUsesFeed();
    const { ms, error } = timed(() =>
      new XMLParser(XML_PARSER_OPTIONS).parse(xml),
    );
    expect(error).toBeInstanceOf(Error);
    expect(ms).toBeLessThan(200);
  });
});

describe("legitimate feeds still parse", () => {
  const TITLE = "Gündem: Merkez Bankası faizi sabit tuttu";

  function firstTitle(xml: string): string | undefined {
    const items = parseFeed(xml);
    expect(items.length).toBeGreaterThanOrEqual(1);
    return items[0]?.title;
  }

  it("a bare <!DOCTYPE rss>", () => {
    expect(firstTitle(rss(TITLE, "<!DOCTYPE rss>"))).toBe(TITLE);
  });

  it("the Netscape RSS 0.91 DOCTYPE with public and system identifiers", () => {
    const doctype =
      '<!DOCTYPE rss PUBLIC "-//Netscape Communications//DTD RSS 0.91//EN" ' +
      '"http://my.netscape.com/publish/formats/rss-0.91.dtd">';
    expect(firstTitle(rss(TITLE, doctype))).toBe(TITLE);
  });

  it("5,000 &amp; and 5,000 &#305; (the built-in and numeric references are not limited)", () => {
    // &amp; decodes in the parser; &#305; is left literal on purpose
    // (htmlEntities is off) and decoded later by normalize.ts's own decoder.
    const title = firstTitle(rss("&amp;".repeat(5000) + "&#305;".repeat(5000)));
    expect(title).toBe("&".repeat(5000) + "&#305;".repeat(5000));
  });

  it("CDATA HTML that contains <!DOCTYPE html>", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><rss><channel><item>' +
      `<title>${TITLE}</title><link>https://example.com/a</link>` +
      "<description><![CDATA[<!DOCTYPE html><html><body><p>metin</p></body></html>]]></description>" +
      "</item></channel></rss>";
    const items = parseFeed(xml);
    expect(items).toHaveLength(1);
    expect(items[0]?.title).toBe(TITLE);
    expect(items[0]?.content).toContain("<!DOCTYPE html>");
  });

  it("entity-escaped HTML in many descriptions is not capped by an expansion counter", () => {
    // 150 items x 24 references = 3,600 &lt;/&gt;/&quot;: far above the
    // library's default per-document expansion budget of 1,000, which counts
    // these built-in references. Real outlets ship entity-escaped HTML bodies,
    // so a budget that low would turn them into `parse error` feeds.
    const body = "&lt;p class=&quot;x&quot;&gt;metin&lt;/p&gt;".repeat(3);
    let items = "";
    for (let i = 0; i < 150; i++) {
      items +=
        `<item><title>Haber ${i}</title><link>https://example.com/${i}</link>` +
        `<description>${body}</description></item>`;
    }
    const parsed = parseFeed(`<rss><channel>${items}</channel></rss>`);
    expect(parsed).toHaveLength(150);
    expect(parsed[0]?.content).toBe(
      '<p class="x">metin</p>'.repeat(3),
    );
  });

  it("a double-encoded &amp;lt; decodes exactly once (to the literal &lt;)", () => {
    expect(firstTitle(rss("a &amp;lt;b&amp;gt; c"))).toBe("a &lt;b&gt; c");
  });
});

describe("every captured real feed still parses with the real parser", () => {
  const dir = fileURLToPath(new URL("../../fixtures/feeds/", import.meta.url));
  const files = readdirSync(dir).filter((f) => f.endsWith(".xml"));

  it("the fixture sweep is not blind", () => {
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it.each(files)("%s", (file) => {
    const xml = readFileSync(`${dir}${file}`, "utf8");
    let items: ReturnType<typeof parseFeed> = [];
    expect(() => {
      items = parseFeed(xml);
    }).not.toThrow();
    expect(items.length).toBeGreaterThan(0);
  });
});
