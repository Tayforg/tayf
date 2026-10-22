import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";
import { shouldServeStreamingMetadata } from "next/dist/server/lib/streaming-metadata";
import { HTML_LIMITED_BOTS, HTML_LIMITED_BOTS_SOURCE } from "./html-limited-bots";

// Next only streams <title>/<meta>/<link rel=canonical>/robots into <body>
// for UAs that do NOT match `htmlLimitedBots`. The built-in default list
// omits Googlebot and GoogleOther, so without this override Google may see the
// canonical and the noindex-on-error hardening only after </head>.

const GOOGLEBOT_DESKTOP =
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GOOGLEBOT_SMARTPHONE =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.126 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const GOOGLE_INSPECTION = "Mozilla/5.0 (compatible; Google-InspectionTool/1.0;)";
const GOOGLE_OTHER = "GoogleOther";
const BINGBOT =
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
const YANDEX = "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)";
const LIGHTHOUSE =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Chrome-Lighthouse";
const FACEBOOK =
  "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)";
const TWITTERBOT = "Twitterbot/1.0";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const CHROME_ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const FIREFOX_WINDOWS =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

describe("HTML_LIMITED_BOTS parity with the Next default", () => {
  it("starts with the full Next default source so a Next upgrade is caught", () => {
    expect(
      HTML_LIMITED_BOTS_SOURCE.startsWith(HTML_LIMITED_BOT_UA_RE.source + "|"),
    ).toBe(true);
  });

  it("exposes a case-insensitive RegExp built from the same source", () => {
    expect(HTML_LIMITED_BOTS.source).toBe(HTML_LIMITED_BOTS_SOURCE);
    expect(HTML_LIMITED_BOTS.flags).toContain("i");
  });
});

describe("HTML_LIMITED_BOTS crawler matching", () => {
  const re = new RegExp(HTML_LIMITED_BOTS_SOURCE, "i");

  it.each([
    ["Googlebot desktop", GOOGLEBOT_DESKTOP],
    ["Googlebot smartphone", GOOGLEBOT_SMARTPHONE],
    ["Google-InspectionTool", GOOGLE_INSPECTION],
    ["GoogleOther", GOOGLE_OTHER],
    ["bingbot", BINGBOT],
    ["YandexBot", YANDEX],
    ["Chrome-Lighthouse", LIGHTHOUSE],
    ["facebookexternalhit", FACEBOOK],
    ["Twitterbot", TWITTERBOT],
  ])("matches %s", (_name, ua) => {
    expect(re.test(ua)).toBe(true);
  });

  it.each([
    ["desktop Chrome (Mac)", CHROME_MAC],
    ["Android Chrome Mobile", CHROME_ANDROID],
    ["iPhone Safari", SAFARI_IPHONE],
    ["Windows Firefox", FIREFOX_WINDOWS],
  ])("does not match %s", (_name, ua) => {
    expect(re.test(ua)).toBe(false);
  });

  it("is never a catch-all (humans must keep streaming metadata)", () => {
    expect(re.test("")).toBe(false);
    expect(HTML_LIMITED_BOTS_SOURCE).not.toBe(".*");
    expect(HTML_LIMITED_BOTS_SOURCE).not.toMatch(/(^|\|)\.\*?(\||$)/);
  });
});

describe("Next runtime mirror (shouldServeStreamingMetadata)", () => {
  it("serves blocking metadata to Googlebot and bingbot", () => {
    expect(
      shouldServeStreamingMetadata(GOOGLEBOT_DESKTOP, HTML_LIMITED_BOTS.source),
    ).toBe(false);
    expect(
      shouldServeStreamingMetadata(GOOGLEBOT_SMARTPHONE, HTML_LIMITED_BOTS.source),
    ).toBe(false);
    expect(shouldServeStreamingMetadata(BINGBOT, HTML_LIMITED_BOTS.source)).toBe(
      false,
    );
  });

  it("keeps streaming metadata for desktop Chrome", () => {
    expect(
      shouldServeStreamingMetadata(CHROME_MAC, HTML_LIMITED_BOTS.source),
    ).toBe(true);
  });

  it("documents the gap: Next's built-in default alone does not cover Googlebot", () => {
    expect(
      shouldServeStreamingMetadata(GOOGLEBOT_DESKTOP, HTML_LIMITED_BOT_UA_RE.source),
    ).toBe(true);
  });
});

describe("next.config.ts wiring", () => {
  const configSrc = readFileSync(resolve(__dirname, "../../../next.config.ts"), "utf-8");

  it("imports the regex from the dependency-free seo module", () => {
    expect(configSrc).toMatch(
      /import\s*{\s*HTML_LIMITED_BOTS\s*}\s*from\s*["']\.\/src\/lib\/seo\/html-limited-bots["']/,
    );
  });

  it("passes it as the top-level htmlLimitedBots option", () => {
    expect(configSrc).toContain("htmlLimitedBots: HTML_LIMITED_BOTS");
  });
});

describe("html-limited-bots.ts stays loadable from next.config.ts", () => {
  it("has no '@/' alias imports (next.config cannot resolve them)", () => {
    const src = readFileSync(resolve(__dirname, "./html-limited-bots.ts"), "utf-8");
    expect(src).not.toMatch(/from\s*["']@\//);
  });
});
