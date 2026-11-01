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
// oEmbed consumers: they fetch a page and look for the discovery <link> in
// <head>, so they must get blocking metadata too.
const WORDPRESS = "WordPress/6.6.2; https://example.org";
const IFRAMELY = "Iframely/1.3.1 (+https://iframely.com/docs/about)";
const EMBEDLY = "Mozilla/5.0 (compatible; Embedly/0.2; +http://support.embed.ly/)";
// Link unfurlers that only read <head>. Before they were listed they got og:*,
// twitter:* and description streamed about 46 KB into <body>, so their cards
// came out empty.
const BLUESKY = "Mozilla/5.0 (compatible; Bluesky Cardyb/1.1; +mailto:support@bsky.app)";
const MASTODON = "Mastodon/4.2.0 (http.rb/5.1.1; +https://mastodon.social/)";
const SIGNAL = "Signal-Desktop/7.0";
const VIBER = "Viber/23.0";
const PINTEREST = "Pinterestbot/1.0";
const LINE_APP = "Line/13.0";
const KAKAOTALK = "kakaotalk-scrap/1.0";
// Telegram identifies as Twitterbot, so Next's default already covers it; the
// case documents that dependency.
const TELEGRAM = "TelegramBot (like TwitterBot)";
// 'Offline/' contains 'line/' but is not LINE: the \bLine/ word boundary must
// keep it out of the bot list.
const OFFLINE_AGENT = "Offline/1.0";

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
    ["WordPress (oEmbed consumer)", WORDPRESS],
    ["Iframely (oEmbed consumer)", IFRAMELY],
    ["Embedly (oEmbed consumer)", EMBEDLY],
    ["Bluesky Cardyb (link unfurler)", BLUESKY],
    ["Mastodon (link unfurler)", MASTODON],
    ["Signal (link unfurler)", SIGNAL],
    ["Viber (link unfurler)", VIBER],
    ["Pinterestbot (link unfurler)", PINTEREST],
    ["Line (link unfurler)", LINE_APP],
    ["kakaotalk-scrap (link unfurler)", KAKAOTALK],
    ["TelegramBot (via Twitterbot)", TELEGRAM],
  ])("matches %s", (_name, ua) => {
    expect(re.test(ua)).toBe(true);
  });

  it.each([
    ["desktop Chrome (Mac)", CHROME_MAC],
    ["Android Chrome Mobile", CHROME_ANDROID],
    ["iPhone Safari", SAFARI_IPHONE],
    ["Windows Firefox", FIREFOX_WINDOWS],
    ["'Offline/' (no LINE false positive)", OFFLINE_AGENT],
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

  it("serves blocking metadata to the oEmbed consumers", () => {
    for (const ua of [WORDPRESS, IFRAMELY, EMBEDLY]) {
      expect(shouldServeStreamingMetadata(ua, HTML_LIMITED_BOTS.source)).toBe(false);
    }
  });

  it("serves blocking metadata to the link unfurlers (Bluesky and friends)", () => {
    expect(shouldServeStreamingMetadata(BLUESKY, HTML_LIMITED_BOTS.source)).toBe(false);
    for (const ua of [MASTODON, SIGNAL, VIBER, PINTEREST, LINE_APP, KAKAOTALK, TELEGRAM]) {
      expect(shouldServeStreamingMetadata(ua, HTML_LIMITED_BOTS.source)).toBe(false);
    }
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
