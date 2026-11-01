import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HTML_LIMITED_BOT_UA_RE } from "next/dist/shared/lib/router/utils/html-bots";
import { shouldServeStreamingMetadata } from "next/dist/server/lib/streaming-metadata";
import { GET as robotsTxt } from "@/app/robots.txt/route";
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
// AI and answer-engine fetchers (real UA strings). robots.txt allows them, but
// before they were listed they got <title>, canonical and robots only inside
// <body> (byte ~36871, after </head> at ~1511), which a head-only parser never
// sees.
const GPTBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot";
const OAI_SEARCHBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot";
const CHATGPT_USER =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const CLAUDEBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
const CLAUDE_USER =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)";
const CLAUDE_SEARCHBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-SearchBot/1.0; +Claude-SearchBot@anthropic.com)";
const PERPLEXITYBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)";
const PERPLEXITY_USER =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)";
const AMAZONBOT =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot) Chrome/119.0.6045.214 Safari/537.36";
const META_EXTERNALAGENT =
  "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)";
const DUCKASSISTBOT = "DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)";

const AI_FETCHERS: ReadonlyArray<readonly [string, string]> = [
  ["GPTBot", GPTBOT],
  ["OAI-SearchBot", OAI_SEARCHBOT],
  ["ChatGPT-User", CHATGPT_USER],
  ["ClaudeBot", CLAUDEBOT],
  ["Claude-User", CLAUDE_USER],
  ["Claude-SearchBot", CLAUDE_SEARCHBOT],
  ["PerplexityBot", PERPLEXITYBOT],
  ["Perplexity-User", PERPLEXITY_USER],
  ["Amazonbot", AMAZONBOT],
  ["meta-externalagent", META_EXTERNALAGENT],
  ["DuckAssistBot", DUCKASSISTBOT],
];

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
    ...AI_FETCHERS.map(([name, ua]) => [`${name} (AI / answer-engine fetcher)`, ua] as const),
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

  it.each(AI_FETCHERS)(
    "serves blocking metadata to %s (AI / answer-engine fetcher)",
    (_name, ua) => {
      expect(shouldServeStreamingMetadata(ua, HTML_LIMITED_BOTS.source)).toBe(false);
    },
  );

  it("keeps streaming metadata for desktop Chrome", () => {
    expect(
      shouldServeStreamingMetadata(CHROME_MAC, HTML_LIMITED_BOTS.source),
    ).toBe(true);
  });

  it("keeps streaming metadata for every human UA", () => {
    for (const ua of [CHROME_MAC, CHROME_ANDROID, SAFARI_IPHONE, FIREFOX_WINDOWS, OFFLINE_AGENT]) {
      expect(shouldServeStreamingMetadata(ua, HTML_LIMITED_BOTS.source)).toBe(true);
    }
  });

  it("documents the gap: Next's built-in default alone does not cover Googlebot", () => {
    expect(
      shouldServeStreamingMetadata(GOOGLEBOT_DESKTOP, HTML_LIMITED_BOT_UA_RE.source),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Drift guard: robots.txt names AI / answer-engine bots and promises them the
// site. A bot that is allowed there but missing from HTML_LIMITED_BOTS gets
// <title>/canonical/robots after </head>, so every user-agent token in the AI
// section of robots.txt must either match the list or sit in EXEMPT below with
// a reason. Adding a bot to robots.txt without doing one of the two fails here.
// ---------------------------------------------------------------------------

const EXEMPT: Record<string, string> = {
  // robots.txt-only product tokens: they control use of already-fetched content
  // and never request a page, so there is no User-Agent header to match.
  "anthropic-ai": "robots-only product token, never fetches pages",
  "cohere-ai": "robots-only product token, never fetches pages",
  // Bulk trainers: each crawl is a full dynamic render (a matching UA bypasses
  // the PPR static shell), and they crawl the whole site for training, not for
  // a citation. Not worth the render cost.
  CCBot: "bulk trainer, each crawl would cost a full dynamic render",
  Bytespider: "bulk trainer, each crawl would cost a full dynamic render",
  Diffbot: "bulk trainer, each crawl would cost a full dynamic render",
  Timpibot: "bulk trainer, each crawl would cost a full dynamic render",
};

// Search and user-triggered fetchers: a person is waiting on an answer that
// cites the page, so they must never be exempted.
const SEARCH_AND_USER_FETCHERS = [
  "OAI-SearchBot",
  "ChatGPT-User",
  "Claude-SearchBot",
  "Claude-User",
  "PerplexityBot",
  "Perplexity-User",
] as const;

async function aiRobotsTokens(): Promise<string[]> {
  const text = await robotsTxt().text();
  const start = text.indexOf("# --- AI / answer-engine bots");
  const end = text.indexOf("User-agent: Googlebot");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...text.slice(start, end).matchAll(/^User-agent:[ \t]*(\S+)[ \t]*$/gm)].map(
    (m) => m[1]!,
  );
}

describe("robots.txt AI section stays in step with HTML_LIMITED_BOTS (drift guard)", () => {
  it("finds the AI user-agent tokens (the scan is not vacuous)", async () => {
    const tokens = await aiRobotsTokens();
    expect(tokens.length).toBeGreaterThanOrEqual(15);
    expect(new Set(tokens).size).toBe(tokens.length);
    for (const name of ["GPTBot", "ClaudeBot", "PerplexityBot", "CCBot", "anthropic-ai"]) {
      expect(tokens).toContain(name);
    }
    expect(tokens).not.toContain("*");
    expect(tokens).not.toContain("Googlebot");
  });

  it("every AI token either matches HTML_LIMITED_BOTS or is exempt with a reason", async () => {
    const unmatched = (await aiRobotsTokens()).filter(
      (t) => !HTML_LIMITED_BOTS.test(t) && !(t in EXEMPT),
    );
    expect(unmatched).toEqual([]);
  });

  it("EXEMPT lists exactly the tokens that do not match (no stale exemption)", async () => {
    const notMatching = (await aiRobotsTokens()).filter((t) => !HTML_LIMITED_BOTS.test(t));
    expect(Object.keys(EXEMPT).sort()).toEqual([...notMatching].sort());
    for (const reason of Object.values(EXEMPT)) expect(reason.length).toBeGreaterThan(10);
  });

  it("never exempts the six search and user-triggered fetchers", async () => {
    const tokens = await aiRobotsTokens();
    for (const name of SEARCH_AND_USER_FETCHERS) {
      expect(tokens).toContain(name);
      expect(EXEMPT).not.toHaveProperty(name);
      expect(HTML_LIMITED_BOTS.test(name)).toBe(true);
    }
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
