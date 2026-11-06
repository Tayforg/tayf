import { describe, expect, it } from "vitest";
import { ANALYTICS_QUERY_ALLOWLIST, redactAnalyticsEvent, redactAnalyticsUrl } from "./redact-url";

// h53-privacy-1: the Web Analytics beacon url is the full location.href, so a
// reader's search text (?q=Ahmet%20Yilmaz) and the follow keywords on /takip
// went to Vercel with every pageview and custom event. Only a short allowlist
// of attribution params may survive, the fragment never does, and a URL that
// cannot be parsed loses its query instead of passing it through.

const ORIGIN = "https://www.tayfhaber.com";

describe("redactAnalyticsUrl", () => {
  it("drops a search query", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?q=Ahmet%20Y%C4%B1lmaz`)).toBe(`${ORIGIN}/`);
  });

  it("drops every parameter of a multi-parameter query", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?q=erdo%C4%9Fan&page=2`)).toBe(`${ORIGIN}/`);
  });

  it("keeps only the allowlisted attribution params and drops the rest", () => {
    expect(
      redactAnalyticsUrl(
        `${ORIGIN}/cluster/0b9c9a3e-1111-4222-8333-444455556666?utm_source=embed&utm_medium=iframe&q=x`,
      ),
    ).toBe(`${ORIGIN}/cluster/0b9c9a3e-1111-4222-8333-444455556666?utm_source=embed&utm_medium=iframe`);
  });

  it("keeps all five utm_* params, in their original order", () => {
    const url = `${ORIGIN}/?utm_source=a&utm_medium=b&utm_campaign=c&utm_term=d&utm_content=e`;
    expect(redactAnalyticsUrl(url)).toBe(url);
  });

  it("exposes the allowlist: exactly the five utm_* names", () => {
    expect([...ANALYTICS_QUERY_ALLOWLIST].sort()).toEqual([
      "utm_campaign",
      "utm_content",
      "utm_medium",
      "utm_source",
      "utm_term",
    ]);
  });

  it("removes the query of an absolute /takip url with a comma-separated keyword list", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/takip?q=a,b`)).toBe(`${ORIGIN}/takip`);
  });

  it("removes the hash fragment", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/metodoloji#duzeltme`)).toBe(`${ORIGIN}/metodoloji`);
  });

  it("removes a query and a hash together", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?q=Ahmet#sonuclar`)).toBe(`${ORIGIN}/`);
  });

  it("removes a query that hides inside a hash-router fragment", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/#/ara?q=Ahmet`)).toBe(`${ORIGIN}/`);
  });

  it("removes a bare question mark and an empty value", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?`)).toBe(`${ORIGIN}/`);
    expect(redactAnalyticsUrl(`${ORIGIN}/?q=`)).toBe(`${ORIGIN}/`);
    expect(redactAnalyticsUrl(`${ORIGIN}/?#`)).toBe(`${ORIGIN}/`);
  });

  it("drops a key that is percent-encoded to look different from q", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?%71=Ahmet`)).toBe(`${ORIGIN}/`);
  });

  it("drops a whole encoded pair that was escaped into one key", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?q%3DAhmet`)).toBe(`${ORIGIN}/`);
  });

  it("drops emoji, plus-encoded and quote-bearing values", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?q=%F0%9F%98%80`)).toBe(`${ORIGIN}/`);
    expect(redactAnalyticsUrl(`${ORIGIN}/?q=Ahmet+Y%C4%B1lmaz`)).toBe(`${ORIGIN}/`);
    expect(redactAnalyticsUrl(`${ORIGIN}/?q='%20OR%201=1--`)).toBe(`${ORIGIN}/`);
  });

  it("matches parameter names exactly (an upper-case UTM_SOURCE is not allowlisted)", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?UTM_SOURCE=x&utm_source=y`)).toBe(`${ORIGIN}/?utm_source=y`);
  });

  it("keeps repeated allowlisted params", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/?utm_source=a&q=b&utm_source=c`)).toBe(
      `${ORIGIN}/?utm_source=a&utm_source=c`,
    );
  });

  it("leaves a url with no query or hash alone", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/`)).toBe(`${ORIGIN}/`);
    expect(redactAnalyticsUrl(`${ORIGIN}/cluster/abc`)).toBe(`${ORIGIN}/cluster/abc`);
  });

  describe("relative urls (cannot be parsed standalone)", () => {
    it.each([
      ["/?q=Ahmet", "/"],
      ["/takip?q=a,b", "/takip"],
      ["/takip?q=a,b#x", "/takip"],
      ["/#/ara?q=Ahmet", "/"],
      ["?q=Ahmet", ""],
      ["#only-a-hash", ""],
      ["//www.tayfhaber.com/?q=Ahmet", "//www.tayfhaber.com/"],
    ])("%s -> %s", (input, expected) => {
      expect(redactAnalyticsUrl(input)).toBe(expected);
    });
  });

  describe("malformed urls (fail closed on the query, keep the rest)", () => {
    it.each([
      ["nonsense?q=x#y", "nonsense"],
      ["nonsense#y?q=x", "nonsense"],
      ["nonsense?q=x?q=y", "nonsense"],
      ["http://[bad?q=Ahmet", "http://[bad"],
      ["https://exa mple.com/?q=Ahmet", "https://exa mple.com/"],
      ["https://:80/?q=Ahmet", "https://:80/"],
      ["", ""],
      ["no query at all", "no query at all"],
    ])("%s -> %s", (input, expected) => {
      expect(redactAnalyticsUrl(input)).toBe(expected);
    });

    it("never lets the search text through, whatever the shape", () => {
      const shapes = [
        "http://[bad?q=Ahmet",
        "https://exa mple.com/?q=Ahmet",
        "nonsense?q=Ahmet#y",
        "nonsense#y?q=Ahmet",
        "/?q=Ahmet",
        "?q=Ahmet",
        `${ORIGIN}/?q=Ahmet`,
        `${ORIGIN}/#/ara?q=Ahmet`,
        `${ORIGIN}/?%71=Ahmet`,
        `${ORIGIN}/?utm_source=a&q=Ahmet#Ahmet`,
        `HTTPS://WWW.TAYFHABER.COM/?q=Ahmet`,
        "javascript:void(0)?q=Ahmet",
      ];
      for (const input of shapes) {
        expect(redactAnalyticsUrl(input), input).not.toContain("Ahmet");
      }
    });
  });

  it("is idempotent", () => {
    const once = redactAnalyticsUrl(`${ORIGIN}/c?utm_source=a&q=b#c`);
    expect(redactAnalyticsUrl(once)).toBe(once);
  });

  it("holds no state between calls", () => {
    for (let i = 0; i < 3; i += 1) {
      expect(redactAnalyticsUrl(`${ORIGIN}/?q=Ahmet`)).toBe(`${ORIGIN}/`);
    }
  });

  it("handles a very large query without keeping any of it", () => {
    const pairs = Array.from({ length: 10_000 }, (_, i) => `k${i}=v${i}`).join("&");
    const out = redactAnalyticsUrl(`${ORIGIN}/?utm_source=keep&${pairs}`);
    expect(out).toBe(`${ORIGIN}/?utm_source=keep`);
  });
});

// /rapor/<32-hex> is a capability URL (src/app/rapor/[token]/page.tsx): the token
// is the only credential, so it must not reach the analytics dashboard either.
describe("redactAnalyticsUrl: /rapor/<token> capability paths", () => {
  const TOKEN = "0123456789abcdef0123456789abcdef";
  it.each([
    [`${ORIGIN}/rapor/${TOKEN}`, `${ORIGIN}/rapor/[token]`],
    [`${ORIGIN}/rapor/${TOKEN}/`, `${ORIGIN}/rapor/[token]/`],
    [`${ORIGIN}/rapor/${TOKEN}?utm_source=mail&q=x#y`, `${ORIGIN}/rapor/[token]?utm_source=mail`],
    [`${ORIGIN}/rapor/NOT-A-HEX-TOKEN`, `${ORIGIN}/rapor/[token]`],
    [`/rapor/${TOKEN}?q=x`, "/rapor/[token]"],
    [`http://[bad/rapor/${TOKEN}?q=x`, "http://[bad/rapor/[token]"],
  ])("%s -> %s", (input, expected) => {
    expect(redactAnalyticsUrl(input)).toBe(expected);
  });

  it("leaves other paths alone", () => {
    expect(redactAnalyticsUrl(`${ORIGIN}/rapor`)).toBe(`${ORIGIN}/rapor`);
    expect(redactAnalyticsUrl(`${ORIGIN}/raporlar/abc`)).toBe(`${ORIGIN}/raporlar/abc`);
    expect(redactAnalyticsUrl(`${ORIGIN}/cluster/${TOKEN}`)).toBe(`${ORIGIN}/cluster/${TOKEN}`);
  });

  it("never lets the token through, whatever the shape", () => {
    for (const shape of [
      `${ORIGIN}/rapor/${TOKEN}`,
      `/rapor/${TOKEN}#a`,
      `nonsense/rapor/${TOKEN}?q=x`,
      `${ORIGIN}/rapor/${TOKEN.toUpperCase()}`,
    ]) {
      expect(redactAnalyticsUrl(shape).toLowerCase()).not.toContain(TOKEN);
    }
  });
});

describe("redactAnalyticsEvent", () => {
  it("redacts the url of a pageview and keeps its type", () => {
    const out = redactAnalyticsEvent({ type: "pageview" as const, url: `${ORIGIN}/?q=Ahmet` });
    expect(out).toEqual({ type: "pageview", url: `${ORIGIN}/` });
  });

  it("redacts the url of a custom event and preserves every other field", () => {
    const event = {
      type: "event" as const,
      url: `${ORIGIN}/?q=Ahmet`,
      payload: { name: "search", data: { zone: "iktidar" } },
      __cdp: { a: 1 },
    };
    const out = redactAnalyticsEvent(event);
    expect(out).toEqual({
      type: "event",
      url: `${ORIGIN}/`,
      payload: { name: "search", data: { zone: "iktidar" } },
      __cdp: { a: 1 },
    });
    expect(out.payload).toBe(event.payload);
  });

  it("does not mutate the event it was given (a frozen event is fine)", () => {
    const event = Object.freeze({ type: "pageview" as const, url: `${ORIGIN}/?q=Ahmet` });
    expect(() => redactAnalyticsEvent(event)).not.toThrow();
    expect(event.url).toBe(`${ORIGIN}/?q=Ahmet`);
  });

  it("returns the SAME event when the url needs no change", () => {
    const event = { type: "pageview" as const, url: `${ORIGIN}/cluster/abc` };
    expect(redactAnalyticsEvent(event)).toBe(event);
  });

  it.each([
    ["no url", { type: "event", payload: { name: "x" } }],
    ["a numeric url", { type: "pageview", url: 42 }],
    ["an undefined url", { type: "pageview", url: undefined }],
    ["a null url", { type: "pageview", url: null }],
    ["an object url", { type: "pageview", url: { q: "Ahmet" } }],
  ])("returns an event with %s unchanged", (_label, event) => {
    expect(redactAnalyticsEvent(event)).toBe(event);
  });

  it("passes null and undefined through instead of throwing", () => {
    expect(redactAnalyticsEvent(null)).toBeNull();
    expect(redactAnalyticsEvent(undefined)).toBeUndefined();
  });
});
