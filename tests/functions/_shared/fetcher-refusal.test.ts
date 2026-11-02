import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// h27-live-1: what the fetcher does with a body it refuses.
//
// #174 pinned fast-xml-parser 4.5.7, whose nested-tag limit (100) turns a deep
// HTML error page into a parse ERROR instead of the old `not a feed: html`, and
// it refuses `<!ENTITY` with a scan that also read CDATA. Two defects followed:
//
//   1. A 2xx parse error returned the refused body's etag / lastModified /
//      bodyHash, and ingest persisted them. The next poll of the same bytes (a
//      byte-stable page) hit the body-hash short-circuit, and a server that
//      honours the stored ETag answers 304: either counted as a healthy "not
//      modified", reset fetch_fail_streak and cleared the quarantine.
//   2. One item quoting XML (`<![CDATA[<pre><!ENTITY ...></pre>]]>`) silenced
//      the whole feed.
//
// Contract pinned here, with the REAL parser (the esm.sh import is mapped to the
// npm package, as in fetcher-doctype.test.ts):
//   * an HTML body is recognised before the parser reads it (deep or not);
//   * every refusal, NotAFeed or parse error, returns NO validators and puts the
//     conditional cache back to what it was before the request;
//   * `<!ENTITY` only counts where the parser can act on it: not inside a
//     closed CDATA section or comment, and never hidden by markup the parser
//     reads differently (an attribute value, a processing instruction).
// ---------------------------------------------------------------------------

vi.mock("https://esm.sh/fast-xml-parser@4.5.7?deps=strnum@1.1.2", async () => await import("fast-xml-parser"));

const { fetchFeed, parseFeed, hasDeclaredEntity, NotAFeedError, XML_PARSER_OPTIONS } = await import(
  "../../../supabase/functions/_shared/rss/fetcher.ts"
);
type RssSource = Parameters<typeof fetchFeed>[0];
type Cache = NonNullable<NonNullable<Parameters<typeof fetchFeed>[1]>["conditionalCache"]>;

const source: RssSource = {
  id: "src-refusal",
  name: "Refusal",
  slug: "refusal",
  url: "https://example.com",
  rss_url: "https://example.com/feed.xml",
};

// --- Deno.resolveDns + fetch stubs (copied from fetcher-doctype.test.ts) -----

interface DenoStub {
  resolveDns: ReturnType<typeof vi.fn>;
  serve: ReturnType<typeof vi.fn>;
}

function stubResolveDns(aRecords: string[], aaaaRecords: string[] = []): DenoStub {
  const resolveDns = vi.fn(async (_host: string, recordType: string) => {
    if (recordType === "A") {
      if (aRecords.length === 0) throw new Error("NotFound");
      return aRecords;
    }
    if (recordType === "AAAA") {
      if (aaaaRecords.length === 0) throw new Error("NotFound");
      return aaaaRecords;
    }
    throw new Error(`unexpected record type ${recordType}`);
  });
  const stub: DenoStub = { resolveDns, serve: vi.fn() };
  vi.stubGlobal("Deno", stub);
  return stub;
}

const originalFetch = globalThis.fetch;
/** The request headers of every fetch the fetcher made, oldest first. */
let requests: Headers[] = [];

function serve(body: string, headers: Record<string, string> = {}) {
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    requests.push(new Headers(init?.headers));
    return new Response(body, {
      status: 200,
      headers: { "Content-Type": "application/rss+xml; charset=utf-8", ...headers },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  requests = [];
  stubResolveDns(["93.184.215.14"]);
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllGlobals();
});

const BAD_VALIDATORS = { ETag: '"bad-body-etag"', "Last-Modified": "Tue, 03 Nov 2026 00:00:00 GMT" };
const PRIOR = { etag: '"good-etag"', lastModified: "Mon, 02 Nov 2026 00:00:00 GMT" };

/** A cache holding the previous (good) validators of `source`. */
function primedCache(): Cache {
  return new Map([[source.id, { ...PRIOR }]]);
}

// --- payload builders -------------------------------------------------------

/** An HTML page nested `depth` levels deep under `root` (the limit is 100). */
function deepHtml(depth: number, prefix = "<!DOCTYPE html>", root: [string, string] = ["<html>", "</html>"]): string {
  return prefix + root[0] + "<div>".repeat(depth) + "Sayfa" + "</div>".repeat(depth) + root[1];
}

function item(n: number, description = ""): string {
  const body = description === "" ? "" : `<description>${description}</description>`;
  return `<item><title>Haber ${n}</title><link>https://example.com/${n}</link>${body}</item>`;
}

/** A 3-item RSS feed; `middle` replaces the second item's description. */
function threeItems(middle = "", prolog = ""): string {
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    prolog +
    `<rss><channel>${item(1)}${item(2, middle)}${item(3)}</channel></rss>`
  );
}

const XXE = '<!DOCTYPE foo [ <!ENTITY xxe SYSTEM "file:///etc/passwd"> ]>';

/** Fetches `body`, with the validators a real outlet would send. */
async function fetchBody(body: string, cache?: Cache, knownBodyHash?: string) {
  serve(body, BAD_VALIDATORS);
  return await fetchFeed(source, { conditionalCache: cache, knownBodyHash });
}

function expectNoValidators(result: Awaited<ReturnType<typeof fetchFeed>>) {
  expect(result.etag).toBeUndefined();
  expect(result.lastModified).toBeUndefined();
  expect(result.bodyHash).toBeUndefined();
}

// ---------------------------------------------------------------------------

describe("an HTML page nested deeper than the parser's limit", () => {
  it("premise: the real parser throws on it (and not on a shallow page)", () => {
    const parser = new XMLParser(XML_PARSER_OPTIONS);
    expect(() => parser.parse(deepHtml(150))).toThrow(/Maximum nested tags exceeded/);
    expect(() => parser.parse(deepHtml(90))).not.toThrow();
  });

  it("is `not a feed: html`, with no validators", async () => {
    const result = await fetchBody(deepHtml(150));
    expect(result.status).toBe(200);
    expect(result.notAFeed).toBe(true);
    expect(result.error).toMatch(/^not a feed: html/);
    expect(result.items).toEqual([]);
    expectNoValidators(result);
  });

  it("puts the previous validators back in the conditional cache", async () => {
    const cache = primedCache();
    await fetchBody(deepHtml(150), cache);
    expect(cache.get(source.id)).toEqual(PRIOR);
    // ...and the next request is conditional on THOSE, not on the page's.
    await fetchBody(deepHtml(150), cache);
    expect(requests[1]?.get("if-none-match")).toBe(PRIOR.etag);
    expect(requests[1]?.get("if-modified-since")).toBe(PRIOR.lastModified);
  });

  it("deletes the cache entry when there was none", async () => {
    const cache: Cache = new Map();
    await fetchBody(deepHtml(150), cache);
    expect(cache.has(source.id)).toBe(false);
    await fetchBody(deepHtml(150), cache);
    expect(requests[1]?.get("if-none-match")).toBeNull();
    expect(requests[1]?.get("if-modified-since")).toBeNull();
  });

  it("is refused again on replay, never answered as not modified", async () => {
    const first = await fetchBody(deepHtml(150));
    const second = await fetchBody(deepHtml(150), undefined, first.bodyHash);
    expect(second.notModified).toBeUndefined();
    expect(second.notAFeed).toBe(true);
    expect(second.error).toMatch(/^not a feed: html/);
  });

  it.each([
    ["a BOM, whitespace and <!DOCTYPE html>", deepHtml(150, "﻿ \r\n\t<!DOCTYPE html>")],
    ["an XML declaration and a bare <html>", deepHtml(150, '<?xml version="1.0"?>\n')],
    ["an XML declaration and a doctype", deepHtml(150, '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Strict//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-strict.dtd">\n', ['<html xmlns="http://www.w3.org/1999/xhtml">', "</html>"])],
    ["an upper-case <HTML lang>", deepHtml(150, "", ['<HTML lang="tr">', "</HTML>"])],
    ["a lower-case doctype", deepHtml(150, "<!doctype html>")],
    ["a legacy HTML 4 doctype", deepHtml(150, '<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">')],
    ["a comment before the doctype", deepHtml(150, "<!-- cache: miss -->\n<!DOCTYPE html>")],
    ["an XML declaration and two comments", deepHtml(150, '<?xml version="1.0"?><!-- a --> <!-- b -->\n')],
  ])("is recognised behind %s", async (_name, body) => {
    const cache = primedCache();
    const result = await fetchBody(body, cache);
    expect(result.error).toMatch(/^not a feed: html/);
    expect(result.notAFeed).toBe(true);
    expectNoValidators(result);
    expect(cache.get(source.id)).toEqual(PRIOR);
  });

  it("is recognised by parseFeed alone, as a NotAFeedError", () => {
    expect(() => parseFeed(deepHtml(150))).toThrow(NotAFeedError);
    expect(() => parseFeed(deepHtml(150))).toThrow("html");
  });

  it("a shallow page is still `not a feed` (root key), even past the sniffed window", () => {
    const body = " ".repeat(3000) + "<html><body>x</body></html>";
    expect(() => parseFeed(body)).toThrow(NotAFeedError);
  });

  it("only the first 1,024 characters are sniffed: a deep page behind more whitespace is a parse error", () => {
    // Documents the window: past it the parser decides, and 4.5.7 refuses the depth.
    expect(() => parseFeed(" ".repeat(1100) + deepHtml(150))).toThrow(/Maximum nested tags exceeded/);
    expect(() => parseFeed(" ".repeat(900) + deepHtml(150))).toThrow(NotAFeedError);
  });
});

describe("the HTML sniff does not misfire on real feeds", () => {
  it("an RSS whose item CDATA contains <html> still parses", () => {
    const xml = threeItems("<![CDATA[<html><body><p>metin</p></body></html>]]>");
    const items = parseFeed(xml);
    expect(items).toHaveLength(3);
    expect(items[1]?.content).toContain("<html>");
  });

  it("an RSS behind a comment that mentions <html> still parses", () => {
    expect(parseFeed("<!-- served by <html> proxy --><rss><channel>" + item(1) + "</channel></rss>")).toHaveLength(1);
  });

  it("an Atom feed whose title says <!DOCTYPE html> still parses", () => {
    const xml =
      '<?xml version="1.0"?><feed><title>x</title><entry><title><![CDATA[<!DOCTYPE html>]]></title>' +
      '<link href="https://example.com/a"/></entry></feed>';
    expect(parseFeed(xml)).toHaveLength(1);
  });

  it.each([
    ["<htmlx><a>1</a></htmlx>", "htmlx"],
    ["<htmlfeed><a>1</a></htmlfeed>", "htmlfeed"],
    ["<html5><a>1</a></html5>", "html5"],
    ["<!DOCTYPE htmlx><htmlx><a>1</a></htmlx>", "htmlx"],
  ])("%s is reported under its own root, not as html", (xml, root) => {
    let caught: unknown;
    try {
      parseFeed(xml);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NotAFeedError);
    expect((caught as Error).message).toBe(root);
  });

  it("a feed with a UTF-8 BOM and a leading comment parses", () => {
    expect(parseFeed("﻿\n<!-- c -->\n<rss><channel>" + item(1) + "</channel></rss>")).toHaveLength(1);
  });
});

describe("a 2xx body the parser throws on", () => {
  // 4.5.7 does not validate tag nesting, so a mismatched closing tag parses;
  // an unterminated CDATA section or comment makes it throw.
  const UNCLOSED_CDATA = '<rss><channel><item><title><![CDATA[never closed</title></item></channel></rss>';
  const UNCLOSED_COMMENT = "<rss><channel><!-- never closed <item><title>x</title></item></channel></rss>";
  const PROLOG_ENTITY = '<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY a "x">]><rss><channel>' + item(1) + "</channel></rss>";

  it("premise: the real parser throws on the first two", () => {
    const parser = new XMLParser(XML_PARSER_OPTIONS);
    expect(() => parser.parse(UNCLOSED_CDATA)).toThrow(/CDATA is not closed/);
    expect(() => parser.parse(UNCLOSED_COMMENT)).toThrow(/Comment is not closed/);
  });

  it.each([
    ["an unterminated CDATA section", UNCLOSED_CDATA],
    ["an unterminated comment", UNCLOSED_COMMENT],
    ["a prolog entity declaration", PROLOG_ENTITY],
  ])("%s: a `parse error` with no validators", async (_name, body) => {
    const result = await fetchBody(body);
    expect(result.status).toBe(200);
    expect(result.error).toMatch(/^parse error/);
    expect(result.items).toEqual([]);
    expect(result.notAFeed).toBeUndefined();
    expect(result.charset).toBeDefined();
    expectNoValidators(result);
  });

  it.each([
    ["an unterminated CDATA section", UNCLOSED_CDATA],
    ["a prolog entity declaration", PROLOG_ENTITY],
  ])("%s: the previous validators are put back", async (_name, body) => {
    const cache = primedCache();
    await fetchBody(body, cache);
    expect(cache.get(source.id)).toEqual(PRIOR);
    await fetchBody(body, cache);
    expect(requests[1]?.get("if-none-match")).toBe(PRIOR.etag);
    expect(requests[1]?.get("if-modified-since")).toBe(PRIOR.lastModified);
  });

  it.each([
    ["an unterminated CDATA section", UNCLOSED_CDATA],
    ["a prolog entity declaration", PROLOG_ENTITY],
  ])("%s: no cache entry is left behind when there was none", async (_name, body) => {
    const cache: Cache = new Map();
    await fetchBody(body, cache);
    expect(cache.has(source.id)).toBe(false);
    await fetchBody(body, cache);
    expect(requests[1]?.get("if-none-match")).toBeNull();
    expect(requests[1]?.get("if-modified-since")).toBeNull();
  });

  it.each([
    ["an unterminated CDATA section", UNCLOSED_CDATA],
    ["a prolog entity declaration", PROLOG_ENTITY],
  ])("%s: replaying the same bytes with the previous hash is an error, never not modified", async (_name, body) => {
    const first = await fetchBody(body);
    const second = await fetchBody(body, undefined, first.bodyHash);
    expect(second.notModified).toBeUndefined();
    expect(second.error).toMatch(/^parse error/);
    expectNoValidators(second);
  });

  it("a feed that parses still returns its validators and refreshes the cache", async () => {
    const cache = primedCache();
    const result = await fetchBody(threeItems(), cache);
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(result.etag).toBe(BAD_VALIDATORS.ETag);
    expect(result.lastModified).toBe(BAD_VALIDATORS["Last-Modified"]);
    expect(result.bodyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(cache.get(source.id)).toEqual({
      etag: BAD_VALIDATORS.ETag,
      lastModified: BAD_VALIDATORS["Last-Modified"],
    });
  });
});

describe("<!ENTITY inside CDATA or a comment is not a declaration", () => {
  const CDATA_XXE = `<![CDATA[<pre>${XXE}</pre>]]>`;

  it("three items parse when one item's CDATA quotes an entity declaration", async () => {
    const xml = threeItems(CDATA_XXE);
    expect(parseFeed(xml)).toHaveLength(3);
    const result = await fetchBody(xml);
    expect(result.error).toBeUndefined();
    expect(result.items).toHaveLength(3);
    expect(result.items[1]?.content).toContain("<!ENTITY xxe SYSTEM");
  });

  it("three items parse when the same text sits in an XML comment", () => {
    const xml = threeItems(`ok <!-- ${XXE} --> metin`);
    expect(parseFeed(xml)).toHaveLength(3);
  });

  it("a plain <!DOCTYPE html> inside CDATA still parses", () => {
    expect(parseFeed(threeItems("<![CDATA[<!DOCTYPE html><p>x</p>]]>"))).toHaveLength(3);
  });

  it("a quoted declaration after a closed CDATA in the same item parses", () => {
    expect(parseFeed(threeItems("<![CDATA[a]]> and <![CDATA[<!ENTITY x 'y'>]]>"))).toHaveLength(3);
  });

  it.each([
    ["an internal-subset entity", '<!DOCTYPE rss [<!ENTITY a "x">]>'],
    ["a lower-case declaration", '<!DOCTYPE rss [<!entity a "x">]>'],
    ["a SYSTEM entity", '<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///etc/passwd">]>'],
    ["an entity after a comment in the subset", '<!DOCTYPE rss [<!-- c --><!ENTITY a "x">]>'],
    ["an entity after a commented-out one", '<!DOCTYPE rss [<!-- <!ENTITY a "x"> --><!ENTITY b "y">]>'],
    ["an entity after the degenerate comment <!-->", '<!DOCTYPE rss [<!--> <!ENTITY a "x"> <!-- c -->]>'],
    ["an entity after an element declaration", '<!DOCTYPE rss [<!ELEMENT rss ANY><!ENTITY a "x">]>'],
  ])("a prolog with %s is refused", (_name, doctype) => {
    expect(() => parseFeed(threeItems("", doctype))).toThrow(/DOCTYPE entity declarations/);
  });

  it("an UNTERMINATED CDATA section before an entity declaration is still refused", () => {
    const xml = '<?xml version="1.0"?><!DOCTYPE rss [<![CDATA[ <!ENTITY a "x">]><rss><channel>' + item(1) + "</channel></rss>";
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });

  it("an UNTERMINATED comment before an entity declaration is still refused", () => {
    const xml = '<!DOCTYPE rss [<!-- never closed <!ENTITY a "x">]><rss><channel>' + item(1) + "</channel></rss>";
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });

  it("an entity declared after a closed CDATA section is refused", () => {
    const xml = `<rss><channel>${item(1, "<![CDATA[x]]>")}<!DOCTYPE rss [<!ENTITY a "x">]></channel></rss>`;
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });

  it("the refusal is reported as a parse error, with no validators", async () => {
    const cache = primedCache();
    const result = await fetchBody(threeItems("", '<!DOCTYPE rss [<!ENTITY a "x">]>'), cache);
    expect(result.error).toBe("parse error: DOCTYPE entity declarations are not accepted");
    expectNoValidators(result);
    expect(cache.get(source.id)).toEqual(PRIOR);
  });
});

/** Deterministic LCG, so a failure names a reproducible document. */
function makeRng(seed: number): (n: number) => number {
  let state = seed;
  return (n: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    // The high bits: the low bits of an LCG cycle with a tiny period.
    return Math.floor((state / 0x100000000) * n);
  };
}

describe("markup cannot hide a DOCTYPE entity from the refusal", () => {
  // The parser reads a DOCTYPE wherever it meets one (also in the body), and
  // tags are read quote-aware, so a CDATA / comment opener inside an attribute
  // value or a processing instruction is not a section. These bodies make the
  // REAL parser register and expand the entity; parseFeed must refuse them.
  const MARK = "ZQZQ";
  const DECL = `<!DOCTYPE rss [<!ENTITY e "${MARK}">]>`;
  /** True when a `<t>` element somewhere in the parsed tree holds the entity's value. */
  const holdsMark = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(holdsMark);
    if (typeof node !== "object" || node === null) return false;
    return Object.entries(node).some(([key, value]) => (key === "t" && value === MARK) || holdsMark(value));
  };
  // The literal text "ZQZQ" can also sit in an attribute value; only an
  // expanded `&e;` inside <t> proves the parser registered the entity.
  const expands = (xml: string): boolean => {
    try {
      return holdsMark(new XMLParser(XML_PARSER_OPTIONS).parse(xml));
    } catch {
      return false;
    }
  };

  it.each([
    ["a CDATA opener inside an attribute value", `<rss><channel><x a="<![CDATA["/>${DECL}<t>&e;</t></channel><y a="]]>"/></rss>`],
    ["a comment opener inside an attribute value", `<rss><channel><x a='<!--'/>${DECL}<t>&e;</t></channel><y a="-->"/></rss>`],
    ["a CDATA opener inside a processing instruction", `<?pi <![CDATA[ ?><rss><channel>${DECL}<t>&e;</t></channel><y a="]]>"/></rss>`],
    ["a CDATA opener inside a closing tag", `<rss><channel><item><title>x</title></item x="<![CDATA["> ${DECL}<t>&e;</t></channel><y a="]]>"/></rss>`],
    ["a declaration in the body", `<rss><channel>${DECL}<t>&e;</t></channel></rss>`],
  ])("%s", (_name, xml) => {
    expect(expands(xml)).toBe(true); // premise: the parser really expands it
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });

  it("agrees with the real parser on 30,000 random markup mixes", () => {
    const next = makeRng(0x2f6e2b1);
    const tokens = [
      "<![CDATA[",
      "]]>",
      "<!--",
      "-->",
      "<!-->",
      '<x a="',
      "<x a='",
      '"',
      "'",
      ">",
      "/>",
      "<y>",
      "</y>",
      "<?pi ",
      "?>",
      "<",
      "text ",
      // The declaration, whole and in the pieces a DOCTYPE reader walks through.
      DECL,
      DECL,
      "<t>&e;</t>",
      "<t>&e;</t>",
      "<t>&e;</t>",
      `<!ENTITY e "${MARK}">`,
      "<!DOCTYPE rss [",
      "<!DOCTYPE rss <!-->",
      "<!DOCTYPE rss <!--->",
      "<!DOCTYPE rss PUBLIC \"a",
      "<!--->",
      "<!d a=\"",
      "]>",
      "[",
      "<!NOTATION n PUBLIC \"",
      "<!NOTATION n SYSTEM '",
      '<!ATTLIST a b CDATA "',
      "<!ELEMENT a ANY>",
      '<!X a="',
    ];
    let expanded = 0;
    for (let n = 0; n < 30_000; n++) {
      const parts: string[] = ["<rss>"];
      const count = 3 + next(10);
      for (let k = 0; k < count; k++) parts.push(tokens[next(tokens.length)] as string);
      parts.push("</rss>");
      const xml = parts.join("");
      if (!expands(xml)) continue;
      expanded++;
      expect(hasDeclaredEntity(xml), `document ${n} expands an entity but was not refused: ${xml}`).toBe(true);
      expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
    }
    // The property is not vacuous: plenty of the mixes really expand.
    expect(expanded).toBeGreaterThan(100);
  });
});

describe("a DOCTYPE head cannot steer the scan past the real declaration", () => {
  // The parser's DOCTYPE reader counts `<` and `>` itself and ends a comment at
  // any `>` that follows `--`, so `<!-->` and `<!--->` are complete comments in a
  // DOCTYPE head. A scanner that decided "no internal subset" from the first `>`
  // and then read `<!-->` as an opener for a LATER `-->` skipped the declaration.
  const MARK = "BOOM";
  const TAIL = "<rss><channel><item><title>&e;</title></item></channel></rss>";
  const DECL = `<!ENTITY e "${MARK}">`;
  const expandsMark = (xml: string): boolean => {
    try {
      return JSON.stringify(new XMLParser(XML_PARSER_OPTIONS).parse(xml)).includes(MARK);
    } catch {
      return false;
    }
  };

  it.each([
    ["<!--> hiding the subset opener", `<?xml version="1.0"?><!DOCTYPE rss <!--> [ <!--> ${DECL} <!-- --> ]>${TAIL}`],
    ["<!---> hiding the subset opener", `<?xml version="1.0"?><!DOCTYPE rss <!---> [ <!---> ${DECL} <!-- --> ]>${TAIL}`],
    ["a trailing --> that swallows the closing of the subset", `<?xml version="1.0"?><!DOCTYPE rss <!--> [ <!--> ${DECL} -->${TAIL}`],
    ["a comment with a bare > before the subset", `<!DOCTYPE rss <!-- > [ --> ${DECL} <!-- x --> ]>${TAIL}`],
    ["a degenerate comment after a public identifier", `<!DOCTYPE rss PUBLIC "-//A//B" <!--> [ <!--> ${DECL} <!-- --> ]>${TAIL}`],
    ["a lower-case <!d tag whose quoted > ends it later than the scanner thinks", `<rss><channel><!d x="a>b<!--" >${`<!DOCTYPE r [${DECL}]>`} <!-- --><item><title>&e;</title></item></channel></rss>`],
  ])("%s", (_name, xml) => {
    expect(expandsMark(xml), "premise: the real parser expands the entity").toBe(true);
    expect(hasDeclaredEntity(xml)).toBe(true);
    expect(() => parseFeed(xml)).toThrow(/DOCTYPE entity declarations/);
  });

  it("is reported as a parse error with no validators", async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE rss <!--> [ <!--> ${DECL} <!-- --> ]>${TAIL}`;
    const result = await fetchBody(xml, primedCache());
    expect(result.error).toBe("parse error: DOCTYPE entity declarations are not accepted");
    expectNoValidators(result);
  });

  it.each([
    ["a bare DOCTYPE", "<!DOCTYPE rss>"],
    ["a DOCTYPE with public and system identifiers", '<!DOCTYPE rss PUBLIC "-//Netscape//DTD RSS 0.91//EN" "http://my.netscape.com/publish/formats/rss-0.91.dtd">'],
    ["a DOCTYPE with an empty subset", "<!DOCTYPE rss []>"],
  ])("%s declares nothing and parses", (_name, doctype) => {
    expect(hasDeclaredEntity(`<?xml version="1.0"?>${doctype}${TAIL}`)).toBe(false);
    expect(parseFeed(`<?xml version="1.0"?>${doctype}<rss><channel><item><title>x</title></item></channel></rss>`)).toHaveLength(1);
  });

  it("agrees with the real parser on 100,000 random DOCTYPE shapes", () => {
    const next = makeRng(0x51ed270b);
    const pick = (list: string[]): string => list[next(list.length)] as string;
    // <!DOCTYPE head [ subset ]> where every part is chosen to confuse a scan
    // that reads the head differently from the parser's DOCTYPE reader.
    const openers = ["<!DOCTYPE rss", "<!DOCTYPE rss ", "<!d x=\"", "<!D>"];
    const headParts = ["<!-->", "<!--->", "<!-- ", " -->", " > ", " ", "PUBLIC ", '"a"', "'", '"', "<", "<![CDATA[", "]]>"];
    const subsetParts = [DECL, DECL, DECL, "<!-->", "<!--->", "<!-- ", " -->", " ", "<!ELEMENT a ANY>", "<![CDATA[", "]]>", "]", "'", '"', ">"];
    const closers = ["]>", "]>", "]> ", ">", " ]>", "]", ""];
    const holds = (xml: string): boolean => {
      try {
        return JSON.stringify(new XMLParser(XML_PARSER_OPTIONS).parse(xml)).includes(`"t":"${MARK}"`);
      } catch {
        return false;
      }
    };
    let expanded = 0;
    for (let n = 0; n < 100_000; n++) {
      const parts: string[] = ["<rss>", pick(openers)];
      for (let k = next(4); k > 0; k--) parts.push(pick(headParts));
      if (next(5) > 0) parts.push("[");
      for (let k = next(6); k > 0; k--) parts.push(pick(subsetParts));
      parts.push(pick(closers), "<t>&e;</t></rss>");
      const xml = parts.join("");
      if (!holds(xml)) continue;
      expanded++;
      expect(hasDeclaredEntity(xml), `document ${n} expands an entity but was not refused: ${xml}`).toBe(true);
    }
    // The property is not vacuous: plenty of the shapes really expand.
    expect(expanded).toBeGreaterThan(500);
  });
});

describe("hasDeclaredEntity", () => {
  it.each([
    ["", false],
    ["<rss/>", false],
    ['<!DOCTYPE rss [<!ENTITY a "x">]>', true],
    ['<!DOCTYPE rss [<!entity a "x">]>', true],
    ['<!DOCTYPE rss [<!EnTiTy a "x">]>', true],
    ["<![CDATA[<!ENTITY a 'x'>]]>", false],
    ["<!-- <!ENTITY a 'x'> -->", false],
    ["<![CDATA[<!ENTITY a 'x'>]]><!ENTITY b 'y'>", true],
    ["<!-- c --><!ENTITY b 'y'>", true],
    ["<![CDATA[ <!ENTITY a 'x'>", true],
    ["<!-- <!ENTITY a 'x'>", true],
    ["<?pi <!ENTITY a 'x'> ?>", false],
    ["&lt;!ENTITY a 'x'&gt;", false],
    ["<!ENTIT", false],
    ["<!", false],
    ["<", false],
  ])("%j -> %s", (xml, expected) => {
    expect(hasDeclaredEntity(xml)).toBe(expected);
  });
});

describe("the entity scan stays linear on hostile input", () => {
  it.each([
    ["100k unterminated CDATA openers", "<![CDATA[".repeat(100_000)],
    ["100k unterminated comment openers", "<!--".repeat(100_000)],
    ["100k unterminated tags with a quote", '<a x="'.repeat(100_000)],
    ["100k unterminated processing instructions", "<?p ".repeat(100_000)],
    ["100k bare angle brackets", "<".repeat(100_000)],
    ["4 MB of text with no markup", "metin ".repeat(700_000)],
    ["100k closed empty comments", "<!---->".repeat(100_000)],
  ])("%s", (_name, body) => {
    const start = performance.now();
    hasDeclaredEntity(`<rss><channel>${body}</channel></rss>`);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  // A DOCTYPE head with no `[` anywhere after it used to look for one to the end
  // of the body for EVERY `<!D` (O(n^2): 1 MB took ~2 s, 2 MB ~8 s, against the
  // isolate's 2 s CPU budget). The linear scan does 2 MB in about 15 ms.
  it.each([
    ["2 MB of <!D> tokens", "<!D>".repeat(500_000)],
    ["2 MB of bare <!DOCTYPE rss> declarations", "<!DOCTYPE rss>".repeat(150_000)],
    ["1.6 MB of <!d> tokens", "<!d>".repeat(400_000)],
    ["2 MB of <!D tokens, none closed by a [", "<!D x ".repeat(330_000)],
  ])("%s finishes in well under a second", (_name, body) => {
    const start = performance.now();
    hasDeclaredEntity(`<rss><channel>${body}</channel></rss>`);
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("finds a declaration at the very end of a 4 MB body without a quadratic detour", () => {
    const filler = "<![CDATA[x]]><!-- y --><a b='c'>d</a>".repeat(100_000);
    const start = performance.now();
    expect(hasDeclaredEntity(`<rss>${filler}<!DOCTYPE r [<!ENTITY e "x">]></rss>`)).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
