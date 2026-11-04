import { afterEach, describe, expect, it, vi } from "vitest";
import { dropAutomatedTraffic, isAutomatedBrowser } from "./automation";

// h31-bots-2: Web Analytics was mounted bare, so headless browsers were
// counted as readers (CN 35%, SG 21%, HK 18%, 98% desktop). A client-side
// filter can only see what the browser admits to: navigator.webdriver (stock
// Puppeteer/Playwright/Selenium set it) and a self-identifying user agent.
// It must fail OPEN: a detection error never costs a real reader's pageview.

const DESKTOP_CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const DESKTOP_CHROME_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const IOS_SAFARI_18 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  vi.doUnmock("@vercel/analytics/next");
});

describe("isAutomatedBrowser — automation", () => {
  it("is true for navigator.webdriver === true even with a desktop Chrome user agent", () => {
    expect(isAutomatedBrowser({ webdriver: true, userAgent: DESKTOP_CHROME_WIN })).toBe(true);
  });

  it("is true for webdriver === true with no user agent at all", () => {
    expect(isAutomatedBrowser({ webdriver: true })).toBe(true);
  });

  it.each([
    ["HeadlessChrome", "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/130.0.0.0 Safari/537.36"],
    ["PhantomJS", "Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/538.1 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/538.1"],
    ["Playwright", "Mozilla/5.0 (X11; Linux x86_64) Playwright/1.48"],
    ["Puppeteer", "Mozilla/5.0 (X11; Linux x86_64) Puppeteer/23.0"],
    ["Selenium", "Mozilla/5.0 (X11; Linux x86_64) Selenium/4.25"],
    ["Chrome-Lighthouse", "Mozilla/5.0 (Linux; Android 11; moto g power (2022)) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/109.0.0.0 Mobile Safari/537.36 Chrome-Lighthouse"],
    ["a '<name>bot/1.0' agent", "Examplebot/1.0"],
    ["Googlebot", "Googlebot/2.1"],
    ["a compatible bot with a URL", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
  ])("is true for a %s user agent", (_label, userAgent) => {
    expect(isAutomatedBrowser({ webdriver: false, userAgent })).toBe(true);
    expect(isAutomatedBrowser({ userAgent })).toBe(true);
  });

  it("matches markers case-insensitively", () => {
    expect(isAutomatedBrowser({ userAgent: "HEADLESSCHROME/130" })).toBe(true);
    expect(isAutomatedBrowser({ userAgent: "mozilla/5.0 PUPPETEER" })).toBe(true);
    expect(isAutomatedBrowser({ userAgent: "SomeBOT/1.0" })).toBe(true);
  });
});

describe("isAutomatedBrowser — real readers", () => {
  it.each([
    ["desktop Chrome on macOS", DESKTOP_CHROME_MAC],
    ["desktop Chrome on Windows", DESKTOP_CHROME_WIN],
    ["iOS Safari 18", IOS_SAFARI_18],
    ["Android Chrome", ANDROID_CHROME],
    ["'Robotics/Abbott 1.0' (contains 'bot' but not 'bot/')", "Robotics/Abbott 1.0"],
    ["an empty user agent", ""],
  ])("is false for %s", (_label, userAgent) => {
    expect(isAutomatedBrowser({ webdriver: false, userAgent })).toBe(false);
    expect(isAutomatedBrowser({ userAgent })).toBe(false);
  });

  it("is false when webdriver is false or undefined", () => {
    expect(isAutomatedBrowser({ webdriver: false, userAgent: DESKTOP_CHROME_MAC })).toBe(false);
    expect(isAutomatedBrowser({ webdriver: undefined, userAgent: DESKTOP_CHROME_MAC })).toBe(false);
    expect(isAutomatedBrowser({ userAgent: DESKTOP_CHROME_MAC })).toBe(false);
  });

  it("only a boolean true counts as webdriver (a truthy string or number does not)", () => {
    expect(isAutomatedBrowser({ webdriver: "true", userAgent: DESKTOP_CHROME_MAC })).toBe(false);
    expect(isAutomatedBrowser({ webdriver: 1, userAgent: DESKTOP_CHROME_MAC })).toBe(false);
  });

  it("is false when the user agent is not a string", () => {
    expect(isAutomatedBrowser({ userAgent: 42 })).toBe(false);
    expect(isAutomatedBrowser({ userAgent: null })).toBe(false);
    expect(isAutomatedBrowser({ userAgent: { toString: () => "HeadlessChrome" } })).toBe(false);
  });
});

describe("isAutomatedBrowser — fail open", () => {
  it("is false for a null, undefined or missing navigator", () => {
    expect(isAutomatedBrowser(null)).toBe(false);
    expect(isAutomatedBrowser(undefined)).toBe(false);
    expect(isAutomatedBrowser()).toBe(false);
  });

  it("is false for an empty navigator", () => {
    expect(isAutomatedBrowser({})).toBe(false);
  });

  it("is false when the webdriver getter throws", () => {
    const nav = {
      get webdriver(): boolean {
        throw new Error("blocked");
      },
      userAgent: "HeadlessChrome/130",
    };
    expect(isAutomatedBrowser(nav)).toBe(false);
  });

  it("is false when the userAgent getter throws", () => {
    const nav = {
      webdriver: false,
      get userAgent(): string {
        throw new Error("blocked");
      },
    };
    expect(isAutomatedBrowser(nav)).toBe(false);
  });

  it("is false when both getters throw", () => {
    const nav = new Proxy(
      {},
      {
        get() {
          throw new Error("no access");
        },
      },
    );
    expect(isAutomatedBrowser(nav)).toBe(false);
  });
});

describe("dropAutomatedTraffic", () => {
  const pageview = { type: "pageview", url: "https://www.tayfhaber.com/cluster/c1" } as const;

  it("returns null for automation", () => {
    expect(dropAutomatedTraffic(pageview, { webdriver: true, userAgent: DESKTOP_CHROME_MAC })).toBeNull();
    expect(dropAutomatedTraffic(pageview, { userAgent: "Googlebot/2.1" })).toBeNull();
  });

  it("returns the SAME event object for a real reader (identity, not a copy)", () => {
    const out = dropAutomatedTraffic(pageview, { webdriver: false, userAgent: DESKTOP_CHROME_MAC });
    expect(out).toBe(pageview);
  });

  it("returns the same event when there is no navigator to inspect", () => {
    expect(dropAutomatedTraffic(pageview, null)).toBe(pageview);
    expect(dropAutomatedTraffic(pageview, {})).toBe(pageview);
  });

  it("returns the same event when detection throws (fail open)", () => {
    const nav = {
      get webdriver(): boolean {
        throw new Error("blocked");
      },
      get userAgent(): string {
        throw new Error("blocked");
      },
    };
    expect(dropAutomatedTraffic(pageview, nav)).toBe(pageview);
  });

  it("keeps a custom event and does not mutate the event it drops", () => {
    const custom = Object.freeze({ type: "event", name: "share", data: { kind: "x" } });
    expect(dropAutomatedTraffic(custom, { userAgent: IOS_SAFARI_18 })).toBe(custom);
    expect(dropAutomatedTraffic(custom, { webdriver: true })).toBeNull();
    expect(custom).toEqual({ type: "event", name: "share", data: { kind: "x" } });
  });

  it("reads globalThis.navigator when no navigator is passed", () => {
    vi.stubGlobal("navigator", { webdriver: true, userAgent: DESKTOP_CHROME_MAC });
    expect(dropAutomatedTraffic(pageview)).toBeNull();

    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME_MAC });
    expect(dropAutomatedTraffic(pageview)).toBe(pageview);
  });

  it("fails open when globalThis.navigator is missing or its getters throw", () => {
    vi.stubGlobal("navigator", undefined);
    expect(dropAutomatedTraffic(pageview)).toBe(pageview);

    vi.stubGlobal("navigator", {
      get webdriver(): boolean {
        throw new Error("blocked");
      },
    });
    expect(dropAutomatedTraffic(pageview)).toBe(pageview);
  });
});

// The root layout mounts <WebAnalytics />, a client wrapper, because a function
// prop cannot cross the server -> client boundary into <Analytics> directly.
describe("WebAnalytics", () => {
  it("renders Vercel's <Analytics> with a beforeSend that drops automated traffic", async () => {
    const Analytics = vi.fn(() => null);
    vi.resetModules();
    vi.doMock("@vercel/analytics/next", () => ({ Analytics }));
    const { WebAnalytics } = await import("@/components/analytics/web-analytics");

    const element = WebAnalytics() as { type: unknown; props: { beforeSend?: unknown } };
    expect(element.type).toBe(Analytics);
    const beforeSend = element.props.beforeSend as (event: unknown) => unknown;
    expect(typeof beforeSend).toBe("function");

    const pageview = { type: "pageview", url: "https://www.tayfhaber.com/" };
    vi.stubGlobal("navigator", { webdriver: true, userAgent: DESKTOP_CHROME_MAC });
    expect(beforeSend(pageview)).toBeNull();
    vi.stubGlobal("navigator", { webdriver: false, userAgent: DESKTOP_CHROME_MAC });
    expect(beforeSend(pageview)).toBe(pageview);
  });

  it("hands <Analytics> the same function on every render (a stable module-level reference)", async () => {
    vi.resetModules();
    vi.doMock("@vercel/analytics/next", () => ({ Analytics: () => null }));
    const { WebAnalytics } = await import("@/components/analytics/web-analytics");

    const first = WebAnalytics() as { props: { beforeSend?: unknown } };
    const second = WebAnalytics() as { props: { beforeSend?: unknown } };
    expect(first.props.beforeSend).toBe(second.props.beforeSend);
  });
});
