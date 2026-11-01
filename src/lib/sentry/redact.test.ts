import { describe, expect, it } from "vitest";

import {
  RAPOR_TOKEN_PATH,
  redactDeep,
  redactRaporToken,
  scrubSentryBreadcrumb,
  scrubSentryEvent,
  scrubSentrySpan,
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
