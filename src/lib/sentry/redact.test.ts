import { describe, expect, it } from "vitest";

import {
  RAPOR_TOKEN_PATH,
  redactDeep,
  redactRaporToken,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
  stripUrlQuery,
} from "./redact";

const TOKEN = "0123456789abcdef0123456789abcdef";
const PATH = `/rapor/${TOKEN}`;
const URL_WITH_TOKEN = `https://tayf.org${PATH}`;
const REDACTED = "/rapor/[token]";

describe("redactRaporToken", () => {
  it("replaces a share-link path with the placeholder", () => {
    expect(redactRaporToken(URL_WITH_TOKEN)).toBe("https://tayf.org/rapor/[token]");
  });

  it("replaces every occurrence, including uppercase hex", () => {
    const input = `a ${PATH} b /rapor/${TOKEN.toUpperCase()} c ${PATH}/markdown`;
    expect(redactRaporToken(input)).toBe(
      `a ${REDACTED} b ${REDACTED} c ${REDACTED}/markdown`,
    );
  });

  it("gives the same answer on repeated calls (the shared /g regex holds no state)", () => {
    expect(redactRaporToken(PATH)).toBe(REDACTED);
    expect(redactRaporToken(PATH)).toBe(REDACTED);
    expect(redactRaporToken(PATH)).toBe(REDACTED);
  });

  it.each([
    ["a short slug", "/rapor/abc"],
    ["31 hex characters", `/rapor/${TOKEN.slice(0, 31)}`],
    ["a different route that shares the prefix", "/raporlar/x"],
    ["no path at all", "https://tayf.org/"],
    ["the empty string", ""],
  ])("leaves %s unchanged", (_label, input) => {
    expect(redactRaporToken(input)).toBe(input);
  });

  it("exposes the exact regex the configs used to inline", () => {
    expect(RAPOR_TOKEN_PATH.source).toBe("\\/rapor\\/[0-9a-f]{32}");
    expect(RAPOR_TOKEN_PATH.flags).toContain("g");
    expect(RAPOR_TOKEN_PATH.flags).toContain("i");
  });
});

describe("redactDeep", () => {
  it("mutates nested objects and arrays in place and returns the same reference", () => {
    const input = {
      url: URL_WITH_TOKEN,
      nested: { list: [PATH, { deeper: `x ${PATH}/markdown` }, 7] },
      untouched: "https://tayf.org/gundem",
    };
    const nestedRef = input.nested;
    const listRef = input.nested.list;

    const out = redactDeep(input);

    expect(out).toBe(input);
    expect(input.nested).toBe(nestedRef);
    expect(input.nested.list).toBe(listRef);
    expect(input).toEqual({
      url: "https://tayf.org/rapor/[token]",
      nested: { list: [REDACTED, { deeper: `x ${REDACTED}/markdown` }, 7] },
      untouched: "https://tayf.org/gundem",
    });
    expect(JSON.stringify(input)).not.toContain(TOKEN);
  });

  it("redacts a top-level array in place", () => {
    const input = [PATH, [PATH]];
    expect(redactDeep(input)).toBe(input);
    expect(input).toEqual([REDACTED, [REDACTED]]);
  });

  it("returns the redacted string for a top-level string", () => {
    expect(redactDeep(URL_WITH_TOKEN)).toBe("https://tayf.org/rapor/[token]");
  });

  it("leaves numbers, booleans, null and undefined alone", () => {
    const input = { n: 1.5, zero: 0, t: true, f: false, nil: null, undef: undefined };
    expect(redactDeep(input)).toBe(input);
    expect(input).toEqual({ n: 1.5, zero: 0, t: true, f: false, nil: null, undef: undefined });
    expect(redactDeep(42)).toBe(42);
    expect(redactDeep(true)).toBe(true);
    expect(redactDeep(null)).toBeNull();
    expect(redactDeep(undefined)).toBeUndefined();
  });

  it("survives a cycle through an object and through an array", () => {
    const a: Record<string, unknown> = { url: PATH };
    a.self = a;
    const list: unknown[] = [PATH];
    list.push(list);
    a.list = list;

    expect(() => redactDeep(a)).not.toThrow();
    expect(a.url).toBe(REDACTED);
    expect(list[0]).toBe(REDACTED);
    expect(a.self).toBe(a);
  });

  it("survives a chain far deeper than the depth cap, and still redacts near the top", () => {
    const root: Record<string, unknown> = { shallow: PATH };
    let cursor = root;
    for (let i = 0; i < 60; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.next = next;
      cursor = next;
    }
    cursor.leaf = PATH;

    expect(() => redactDeep(root)).not.toThrow();
    expect(root.shallow).toBe(REDACTED);
  });

  it("walks the same shared object only once (no blow-up on a DAG)", () => {
    const shared = { url: PATH };
    const input = { a: shared, b: shared, c: [shared, shared] };
    expect(() => redactDeep(input)).not.toThrow();
    expect(shared.url).toBe(REDACTED);
  });

  it("does not walk into non-plain objects such as Date", () => {
    const when = new Date(0);
    const input = { when, url: PATH };
    redactDeep(input);
    expect(input.when).toBe(when);
    expect(when.getTime()).toBe(0);
    expect(input.url).toBe(REDACTED);
  });

  it("handles null-prototype objects", () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.url = PATH;
    redactDeep(bare);
    expect(bare.url).toBe(REDACTED);
  });
});

describe("scrubSentryEvent", () => {
  const fixture = () => ({
    event_id: "abc",
    request: {
      url: URL_WITH_TOKEN,
      headers: {
        referer: URL_WITH_TOKEN,
        "user-agent": "vitest",
        authorization: "Bearer s3cret",
        cookie: "a=b",
      },
    },
    transaction: `GET ${PATH}`,
    breadcrumbs: [
      { category: "navigation", data: { from: PATH, to: `${PATH}/markdown` } },
      { category: "fetch", data: { url: `${URL_WITH_TOKEN}/markdown`, method: "GET" } },
      { category: "console", message: "plain" },
    ],
  });

  it("deletes authorization and cookie headers", () => {
    const out = scrubSentryEvent(fixture());
    expect(out.request.headers).not.toHaveProperty("authorization");
    expect(out.request.headers).not.toHaveProperty("cookie");
    expect(out.request.headers["user-agent"]).toBe("vitest");
  });

  it.each(["Authorization", "AUTHORIZATION", "Cookie", "COOKIE", "cOoKiE"])(
    "deletes the %s header whatever its case",
    (name) => {
      const event = { request: { headers: { [name]: "secret", Accept: "text/html" } } };
      const out = scrubSentryEvent(event);
      expect(out.request.headers).toEqual({ Accept: "text/html" });
    },
  );

  it("redacts referer, request.url, transaction and breadcrumb urls", () => {
    const out = scrubSentryEvent(fixture());
    expect(out.request.headers.referer).toBe("https://tayf.org/rapor/[token]");
    expect(out.request.url).toBe("https://tayf.org/rapor/[token]");
    expect(out.transaction).toBe("GET /rapor/[token]");
    expect(out.breadcrumbs[0]!.data).toEqual({ from: REDACTED, to: `${REDACTED}/markdown` });
    expect(out.breadcrumbs[1]!.data).toEqual({
      url: "https://tayf.org/rapor/[token]/markdown",
      method: "GET",
    });
    expect(out.breadcrumbs[2]!.message).toBe("plain");
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("redacts a token anywhere else in the event too (contexts, tags, extra)", () => {
    const event = {
      contexts: { trace: { data: { "url.full": URL_WITH_TOKEN } } },
      tags: { path: PATH },
      extra: { list: [{ href: PATH }] },
    };
    scrubSentryEvent(event);
    expect(JSON.stringify(event)).not.toContain(TOKEN);
  });

  it("returns the same event object (never null)", () => {
    const event = fixture();
    expect(scrubSentryEvent(event)).toBe(event);
  });

  it("tolerates events without a request, without headers, or with non-object headers", () => {
    expect(scrubSentryEvent({})).toEqual({});
    expect(scrubSentryEvent({ request: {} })).toEqual({ request: {} });
    expect(scrubSentryEvent({ request: { headers: null } })).toEqual({ request: { headers: null } });
    expect(scrubSentryEvent({ request: { headers: "nope" } })).toEqual({ request: { headers: "nope" } });
  });

  it("passes null and undefined through instead of throwing", () => {
    expect(scrubSentryEvent(null)).toBeNull();
    expect(scrubSentryEvent(undefined)).toBeUndefined();
  });
});

describe("scrubSentrySpan", () => {
  const fixture = () => ({
    trace_id: "t",
    span_id: "s",
    name: `GET ${PATH}`,
    start_timestamp: 1,
    status: "ok" as const,
    is_segment: true,
    attributes: {
      "url.full": { value: URL_WITH_TOKEN, type: "string" },
      "http.target": PATH,
      "url.path": PATH,
      "http.status_code": 200,
    },
    links: [
      { trace_id: "t2", span_id: "s2", attributes: { "url.full": { value: URL_WITH_TOKEN, type: "string" } } },
    ],
  });

  it("returns the SAME object, never null", () => {
    const span = fixture();
    const out = scrubSentrySpan(span);
    expect(out).not.toBeNull();
    expect(out).toBe(span);
  });

  it("redacts the name, the url attributes and the link attributes", () => {
    const out = scrubSentrySpan(fixture());
    expect(out.name).toBe("GET /rapor/[token]");
    expect(out.attributes["url.full"]).toEqual({ value: "https://tayf.org/rapor/[token]", type: "string" });
    expect(out.attributes["http.target"]).toBe(REDACTED);
    expect(out.attributes["url.path"]).toBe(REDACTED);
    expect(out.attributes["http.status_code"]).toBe(200);
    expect(out.links[0]!.attributes["url.full"]).toEqual({
      value: "https://tayf.org/rapor/[token]",
      type: "string",
    });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("copes with a span that has no links", () => {
    const span: Partial<ReturnType<typeof fixture>> = fixture();
    delete span.links;
    expect(() => scrubSentrySpan(span)).not.toThrow();
    expect(span.name).toBe("GET /rapor/[token]");
  });
});

describe("scrubSentryBreadcrumb", () => {
  it("redacts navigation and fetch breadcrumb data and the message, in place", () => {
    const crumb = {
      category: "navigation",
      message: `went to ${PATH}`,
      data: { from: "/", to: PATH, url: URL_WITH_TOKEN },
    };
    const out = scrubSentryBreadcrumb(crumb);
    expect(out).toBe(crumb);
    expect(out.message).toBe(`went to ${REDACTED}`);
    expect(out.data).toEqual({ from: "/", to: REDACTED, url: "https://tayf.org/rapor/[token]" });
  });

  it("leaves a breadcrumb without data alone", () => {
    expect(scrubSentryBreadcrumb({ category: "ui.click" })).toEqual({ category: "ui.click" });
  });
});

// ---------------------------------------------------------------------------
// h53-privacy-1: URL query strings. The reader's search text (?q=Ahmet) and the
// /takip follow keywords travel in the query, so a request.url, a Referer, a
// navigation breadcrumb or a span attribute can all carry them. dataCollection
// urlQueryParams: false covers what the SDK adds itself; these scrubbers cover
// what it copies verbatim (location.href, breadcrumbs, transaction and span
// names) and the Referer header.
// ---------------------------------------------------------------------------

const SEARCH_URL = "https://www.tayfhaber.com/?q=Ahmet";

describe("stripUrlQuery", () => {
  it.each([
    [SEARCH_URL, "https://www.tayfhaber.com/"],
    ["/api/takip?q=Ahmet", "/api/takip"],
    ["/api/takip?q=a,b&page=2", "/api/takip"],
    ["/?q=a?b", "/"],
    ["https://www.tayfhaber.com/cluster/abc?q=Ahmet#frag", "https://www.tayfhaber.com/cluster/abc"],
    ["https://www.tayfhaber.com/#/ara?q=Ahmet", "https://www.tayfhaber.com/#/ara"],
    ["?q=Ahmet", ""],
    ["nonsense?q=x", "nonsense"],
  ])("cuts %s at the first ?", (input, expected) => {
    expect(stripUrlQuery(input)).toBe(expected);
  });

  it.each([["https://www.tayfhaber.com/cluster/abc"], ["/takip"], ["#frag"], [""]])(
    "leaves %j alone when there is no query",
    (input) => {
      expect(stripUrlQuery(input)).toBe(input);
    },
  );
});

describe("scrubSentryEvent drops URL query strings", () => {
  const fixture = () => ({
    request: {
      url: SEARCH_URL,
      query_string: "q=Ahmet",
      headers: { referer: "https://www.tayfhaber.com/?q=Ahmet", "user-agent": "vitest" },
    },
    transaction: "GET /?q=Ahmet",
    breadcrumbs: [
      { category: "fetch", data: { url: "/api/takip?q=Ahmet", method: "GET" } },
      { category: "navigation", data: { from: "/?q=Ahmet", to: "/takip?q=Ahmet#x" } },
      { category: "xhr", data: { url: "https://www.tayfhaber.com/api/x?q=Ahmet" } },
    ],
  });

  it("leaves no trace of the search text anywhere in the spec fixture", () => {
    const out = scrubSentryEvent({
      request: { url: SEARCH_URL, query_string: "q=Ahmet" },
      transaction: "GET /?q=Ahmet",
      breadcrumbs: [{ data: { url: "/api/takip?q=Ahmet" } }],
    });
    expect(JSON.stringify(out)).not.toContain("Ahmet");
    expect(out.request.url).toBe("https://www.tayfhaber.com/");
    expect(out.transaction).toBe("GET /");
    expect(out.breadcrumbs[0]!.data.url).toBe("/api/takip");
  });

  it("strips request.url, deletes request.query_string, and keeps the other request fields", () => {
    const out = scrubSentryEvent(fixture());
    expect(out.request.url).toBe("https://www.tayfhaber.com/");
    expect(out.request).not.toHaveProperty("query_string");
    expect(out.request.headers["user-agent"]).toBe("vitest");
  });

  it("strips the query from the Referer header (a same-origin click sends the full url)", () => {
    const out = scrubSentryEvent(fixture());
    expect(out.request.headers.referer).toBe("https://www.tayfhaber.com/");
  });

  it.each(["Referer", "REFERER", "referrer"])("strips the query from a %s header whatever its case", (name) => {
    const event = { request: { headers: { [name]: SEARCH_URL } } };
    const out = scrubSentryEvent(event);
    expect(out.request.headers[name as keyof typeof out.request.headers]).toBe("https://www.tayfhaber.com/");
  });

  it("strips the query from the transaction name", () => {
    expect(scrubSentryEvent(fixture()).transaction).toBe("GET /");
    expect(scrubSentryEvent({ transaction: "/takip?q=a,b" }).transaction).toBe("/takip");
  });

  it("leaves a transaction name that is not an http route alone", () => {
    expect(scrubSentryEvent({ transaction: "cron: where id = ?" }).transaction).toBe("cron: where id = ?");
  });

  it("strips the query from breadcrumb data.url, data.from and data.to", () => {
    const out = scrubSentryEvent(fixture());
    expect(out.breadcrumbs[0]!.data).toEqual({ url: "/api/takip", method: "GET" });
    expect(out.breadcrumbs[1]!.data).toEqual({ from: "/", to: "/takip" });
    expect(out.breadcrumbs[2]!.data).toEqual({ url: "https://www.tayfhaber.com/api/x" });
  });

  it("scrubs trace-context data and static transaction spans", () => {
    const event = {
      contexts: {
        trace: {
          data: {
            "url.full": SEARCH_URL,
            "http.url": SEARCH_URL,
            "http.target": "/?q=Ahmet",
            "url.query": "?q=Ahmet",
            "http.query": "?q=Ahmet",
            "url.path": "/",
          },
        },
      },
      spans: [
        {
          description: "GET https://www.tayfhaber.com/api/takip?q=Ahmet",
          data: { url: "https://www.tayfhaber.com/api/takip?q=Ahmet", "http.query": "?q=Ahmet", "http.method": "GET" },
        },
        { description: "SELECT * FROM t WHERE id = ?", data: {} },
      ],
    };
    const out = scrubSentryEvent(event);
    expect(JSON.stringify(out)).not.toContain("Ahmet");
    expect(out.contexts.trace.data).toEqual({
      "url.full": "https://www.tayfhaber.com/",
      "http.url": "https://www.tayfhaber.com/",
      "http.target": "/",
      "url.path": "/",
    });
    expect(out.spans[0]!.description).toBe("GET https://www.tayfhaber.com/api/takip");
    expect(out.spans[0]!.data).toEqual({ url: "https://www.tayfhaber.com/api/takip", "http.method": "GET" });
    expect(out.spans[1]!.description).toBe("SELECT * FROM t WHERE id = ?");
  });

  it("still redacts the /rapor/<token> path when the url also has a query", () => {
    const out = scrubSentryEvent({ request: { url: `https://tayf.org${PATH}?q=Ahmet` } });
    expect(out.request.url).toBe("https://tayf.org/rapor/[token]");
  });

  it("tolerates odd shapes without throwing", () => {
    expect(() =>
      scrubSentryEvent({
        request: { url: 42, query_string: null, headers: { referer: 7 } },
        transaction: 5,
        breadcrumbs: [null, "x", { data: null }, { data: { url: 1 } }, { data: "s" }],
        contexts: { trace: { data: "nope" } },
        spans: [null, { data: [1], description: {} }],
      }),
    ).not.toThrow();
    expect(() => scrubSentryEvent({ breadcrumbs: "nope", spans: 1, contexts: null })).not.toThrow();
  });
});

describe("scrubSentrySpan drops URL query strings", () => {
  const fixture = () => ({
    name: "GET /api/takip?q=Ahmet",
    attributes: {
      "url.full": { value: "https://www.tayfhaber.com/api/takip?q=Ahmet", type: "string" },
      "http.url": { value: "https://www.tayfhaber.com/api/takip?q=Ahmet", type: "string" },
      "http.target": "/api/takip?q=Ahmet",
      "url.query": { value: "?q=Ahmet", type: "string" },
      "url.path": { value: "/api/takip", type: "string" },
      "http.status_code": 200,
    },
    links: [
      {
        trace_id: "t2",
        span_id: "s2",
        attributes: {
          "url.full": { value: "https://www.tayfhaber.com/?q=Ahmet", type: "string" },
          "url.query": "q=Ahmet",
        },
      },
    ],
  });

  it("strips url.full, http.url and http.target, in the wrapped and the plain attribute shape", () => {
    const out = scrubSentrySpan(fixture());
    expect(out.attributes["url.full"]).toEqual({ value: "https://www.tayfhaber.com/api/takip", type: "string" });
    expect(out.attributes["http.url"]).toEqual({ value: "https://www.tayfhaber.com/api/takip", type: "string" });
    expect(out.attributes["http.target"]).toBe("/api/takip");
  });

  it("drops url.query and keeps the unrelated attributes", () => {
    const out = scrubSentrySpan(fixture());
    expect(out.attributes).not.toHaveProperty("url.query");
    expect(out.attributes["url.path"]).toEqual({ value: "/api/takip", type: "string" });
    expect(out.attributes["http.status_code"]).toBe(200);
  });

  it("strips the span name", () => {
    expect(scrubSentrySpan(fixture()).name).toBe("GET /api/takip");
  });

  it("leaves a db-style span name alone", () => {
    expect(scrubSentrySpan({ name: "SELECT * FROM t WHERE id = ?", attributes: {} }).name).toBe(
      "SELECT * FROM t WHERE id = ?",
    );
  });

  it("scrubs the link attributes too", () => {
    const out = scrubSentrySpan(fixture());
    expect(out.links[0]!.attributes).toEqual({
      "url.full": { value: "https://www.tayfhaber.com/", type: "string" },
    });
  });

  it("returns the SAME object, never null, with no trace of the search text", () => {
    const span = fixture();
    const out = scrubSentrySpan(span);
    expect(out).toBe(span);
    expect(JSON.stringify(out)).not.toContain("Ahmet");
  });

  it("copes with a span with no attributes, links or name", () => {
    expect(scrubSentrySpan({})).toEqual({});
    expect(() => scrubSentrySpan({ attributes: null, links: "x", name: 3 })).not.toThrow();
  });
});

describe("scrubSentryBreadcrumb drops URL query strings", () => {
  it("strips data.url, data.from and data.to, in place", () => {
    const crumb = {
      category: "navigation",
      data: { from: "/?q=Ahmet", to: "/takip?q=a,b", url: "https://www.tayfhaber.com/api/x?q=Ahmet", method: "GET" },
    };
    const out = scrubSentryBreadcrumb(crumb);
    expect(out).toBe(crumb);
    expect(out.data).toEqual({
      from: "/",
      to: "/takip",
      url: "https://www.tayfhaber.com/api/x",
      method: "GET",
    });
  });

  it("drops a query-bearing key some SDK versions add to fetch breadcrumbs", () => {
    const crumb = { category: "fetch", data: { url: "/api/x", "http.query": "?q=Ahmet" } };
    expect(scrubSentryBreadcrumb(crumb).data).toEqual({ url: "/api/x" });
  });

  it("tolerates a breadcrumb with no data or non-object data", () => {
    expect(scrubSentryBreadcrumb({ category: "ui.click" })).toEqual({ category: "ui.click" });
    expect(() => scrubSentryBreadcrumb({ data: "x" })).not.toThrow();
    expect(() => scrubSentryBreadcrumb(null)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The Referer header copied onto a span (privacy-sentry-referer-span-attr).
// @sentry/nextjs 11 puts every non-denied request header on the root span as
// `http.request.header.<name>`, with a string[] value. A same-origin Referer
// (Referrer-Policy strict-origin-when-cross-origin) carries the FULL url, so the
// reader's /?q= search text rides in it. The primary control is the `referer`
// deny entry in SENTRY_DATA_COLLECTION; these tests pin the scrubber behind it.
// ---------------------------------------------------------------------------

describe("the Referer header span attribute drops the URL query string", () => {
  const REFERER = "https://www.tayfhaber.com/?q=Ahmet%20Y%C4%B1lmaz";
  const KEY = "http.request.header.referer";

  it("strips a streamed-span attribute of the SDK shape { value: string[], type: 'string[]' }", () => {
    const out = scrubSentrySpan({ attributes: { [KEY]: { value: [REFERER], type: "string[]" } } });
    expect(out.attributes[KEY]).toEqual({ value: ["https://www.tayfhaber.com/"], type: "string[]" });
    const json = JSON.stringify(out);
    expect(json).not.toContain("Ahmet");
    expect(json).not.toContain("?q=");
  });

  it("strips the plain-array form", () => {
    const out = scrubSentrySpan({ attributes: { [KEY]: [REFERER] } });
    expect(out.attributes[KEY]).toEqual(["https://www.tayfhaber.com/"]);
    expect(JSON.stringify(out)).not.toContain("Ahmet");
  });

  it("strips the plain-string and the { value: string } forms", () => {
    const out = scrubSentrySpan({
      attributes: { [KEY]: REFERER, "http.request.header.referrer": { value: REFERER, type: "string" } },
    });
    expect(out.attributes[KEY]).toBe("https://www.tayfhaber.com/");
    expect(out.attributes["http.request.header.referrer"]).toEqual({
      value: "https://www.tayfhaber.com/",
      type: "string",
    });
  });

  it("matches the key whatever its case, and the 'referrer' spelling", () => {
    const out = scrubSentrySpan({
      attributes: {
        "HTTP.Request.Header.Referer": [REFERER],
        "http.request.header.REFERRER": { value: [REFERER], type: "string[]" },
      },
    });
    expect(JSON.stringify(out)).not.toContain("Ahmet");
  });

  it("keeps the path (only the query is cut) and strips every element of the array", () => {
    const out = scrubSentrySpan({
      attributes: {
        [KEY]: {
          value: ["https://www.tayfhaber.com/cluster/abc?q=Ahmet", "https://www.tayfhaber.com/takip?q=a,b#x"],
          type: "string[]",
        },
      },
    });
    expect(out.attributes[KEY].value).toEqual(["https://www.tayfhaber.com/cluster/abc", "https://www.tayfhaber.com/takip"]);
  });

  it("leaves an already-filtered value and other header attributes alone", () => {
    const out = scrubSentrySpan({
      attributes: {
        [KEY]: { value: ["[Filtered]"], type: "string[]" },
        "http.request.header.user-agent": { value: ["vitest ? 1"], type: "string[]" },
      },
    });
    expect(out.attributes[KEY]).toEqual({ value: ["[Filtered]"], type: "string[]" });
    expect(out.attributes["http.request.header.user-agent"]).toEqual({ value: ["vitest ? 1"], type: "string[]" });
  });

  it("tolerates odd values (numbers, nulls, mixed arrays) without throwing", () => {
    expect(() =>
      scrubSentrySpan({
        attributes: { [KEY]: [1, null, REFERER], "http.request.header.referrer": { value: 7 } },
      }),
    ).not.toThrow();
    const out = scrubSentrySpan({ attributes: { [KEY]: [1, null, REFERER] } });
    expect(out.attributes[KEY]).toEqual([1, null, "https://www.tayfhaber.com/"]);
  });

  it("scrubs the error event's trace-context data (contexts.trace.data)", () => {
    const out = scrubSentryEvent({
      contexts: { trace: { data: { [KEY]: ["https://www.tayfhaber.com/?q=Ahmet"] } } },
    });
    expect(out.contexts.trace.data[KEY]).toEqual(["https://www.tayfhaber.com/"]);
    expect(JSON.stringify(out)).not.toContain("Ahmet");
  });

  it("scrubs static transaction spans and span links too", () => {
    const out = scrubSentryEvent({
      spans: [{ description: "GET /", data: { [KEY]: ["https://www.tayfhaber.com/?q=Ahmet"] } }],
    });
    expect(out.spans[0]!.data[KEY]).toEqual(["https://www.tayfhaber.com/"]);

    const span = scrubSentrySpan({
      links: [{ attributes: { [KEY]: { value: ["https://www.tayfhaber.com/?q=Ahmet"], type: "string[]" } } }],
    });
    expect(JSON.stringify(span)).not.toContain("Ahmet");
  });

  it("scrubs breadcrumb data", () => {
    const out = scrubSentryBreadcrumb({ data: { [KEY]: ["https://www.tayfhaber.com/?q=Ahmet"] } });
    expect(JSON.stringify(out)).not.toContain("Ahmet");
  });

  it("still redacts the /rapor/<token> path inside a Referer attribute", () => {
    const out = scrubSentrySpan({ attributes: { [KEY]: [`https://tayf.org${PATH}?q=Ahmet`] } });
    expect(out.attributes[KEY]).toEqual(["https://tayf.org/rapor/[token]"]);
  });
});
