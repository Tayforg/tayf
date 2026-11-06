import { afterEach, describe, expect, it, vi } from "vitest";

// h53-privacy-1: the composed beforeSend that <WebAnalytics /> hands to Vercel's
// <Analytics>. Order matters: automated traffic is dropped first (null), and
// whatever survives has its url redacted before the beacon is built. The
// pieces have their own tests (src/lib/analytics/automation.test.ts and
// redact-url.test.ts); this file pins the wiring.

const DESKTOP_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

type Event = { type: string; url: string; payload?: unknown };
type Hook = (event: Event) => Event | null;

async function mountedBeforeSend(): Promise<Hook> {
  const Analytics = vi.fn(() => null);
  vi.resetModules();
  vi.doMock("@vercel/analytics/next", () => ({ Analytics }));
  const { WebAnalytics } = await import("./web-analytics");
  const element = WebAnalytics() as { type: unknown; props: { beforeSend?: unknown } };
  expect(element.type).toBe(Analytics);
  expect(typeof element.props.beforeSend).toBe("function");
  return element.props.beforeSend as Hook;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("@vercel/analytics/next");
});

describe("WebAnalytics beforeSend (automation filter, then url redaction)", () => {
  it("drops automated traffic (navigator.webdriver) first, query or not", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: true, userAgent: DESKTOP_CHROME });
    expect(beforeSend({ type: "pageview", url: "https://www.tayfhaber.com/?q=Ahmet" })).toBeNull();
    expect(beforeSend({ type: "pageview", url: "https://www.tayfhaber.com/" })).toBeNull();
  });

  it("strips the reader's search text from a relative url for a normal browser", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME });
    const out = beforeSend({ type: "pageview", url: "/?q=Ahmet" });
    expect(out).not.toBeNull();
    expect(out!.url).not.toContain("q=");
    expect(out!.url).not.toContain("Ahmet");
  });

  it("strips the search text from the absolute location.href the script really sends", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME });
    const out = beforeSend({ type: "pageview", url: "https://www.tayfhaber.com/?q=Ahmet%20Y%C4%B1lmaz" });
    expect(out).toEqual({ type: "pageview", url: "https://www.tayfhaber.com/" });
  });

  it("redacts a custom event too and keeps its payload", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME });
    const payload = { name: "search", data: { zone: "iktidar" } };
    const out = beforeSend({ type: "event", url: "https://www.tayfhaber.com/?q=Ahmet#sonuc", payload });
    expect(out).toEqual({ type: "event", url: "https://www.tayfhaber.com/", payload });
  });

  it("keeps the utm_* attribution params of a share or embed visit", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME });
    const out = beforeSend({
      type: "pageview",
      url: "https://www.tayfhaber.com/cluster/abc?utm_source=embed&utm_medium=iframe&q=x",
    });
    expect(out!.url).toBe("https://www.tayfhaber.com/cluster/abc?utm_source=embed&utm_medium=iframe");
  });

  it("returns the same event object when there is nothing to redact", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME });
    const pageview = { type: "pageview", url: "https://www.tayfhaber.com/" };
    expect(beforeSend(pageview)).toBe(pageview);
  });

  it("still redacts when there is no navigator to inspect (the automation filter fails open)", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", undefined);
    const out = beforeSend({ type: "pageview", url: "https://www.tayfhaber.com/?q=Ahmet" });
    expect(out).toEqual({ type: "pageview", url: "https://www.tayfhaber.com/" });
  });

  it("still redacts when navigator getters throw", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", {
      get webdriver(): boolean {
        throw new Error("blocked");
      },
    });
    const out = beforeSend({ type: "pageview", url: "https://www.tayfhaber.com/?q=Ahmet" });
    expect(out!.url).toBe("https://www.tayfhaber.com/");
  });

  it("fails closed on the query for an unparseable url but keeps the event", async () => {
    const beforeSend = await mountedBeforeSend();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME });
    expect(beforeSend({ type: "pageview", url: "nonsense?q=x#y" })).toEqual({
      type: "pageview",
      url: "nonsense",
    });
  });

  it("hands <Analytics> the same function on every render (a stable module-level reference)", async () => {
    vi.resetModules();
    vi.doMock("@vercel/analytics/next", () => ({ Analytics: () => null }));
    const { WebAnalytics } = await import("./web-analytics");
    const first = WebAnalytics() as { props: { beforeSend?: unknown } };
    const second = WebAnalytics() as { props: { beforeSend?: unknown } };
    expect(first.props.beforeSend).toBe(second.props.beforeSend);
  });
});
