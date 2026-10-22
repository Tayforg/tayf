/**
 * User agents that get blocking (in-<head>) metadata instead of streamed
 * metadata. Dependency-free on purpose: next.config.ts imports this file, and
 * the config loader cannot resolve the '@/' alias.
 *
 * See "Metadata for crawlers" in docs/architecture.md.
 */

// Copied from next@16.4.2 dist/shared/lib/router/utils/html-bots.js
// (HTML_LIMITED_BOT_UA_RE.source). Kept whole because setting
// `htmlLimitedBots` REPLACES Next's default rather than extending it.
// src/lib/seo/html-limited-bots.test.ts fails when a Next upgrade changes it.
const NEXT_DEFAULT_HTML_LIMITED_BOTS = String.raw`[\w-]+-Google|Google-[\w-]+|Chrome-Lighthouse|Slurp|DuckDuckBot|baiduspider|yandex|sogou|bitlybot|tumblr|vkShare|quora link preview|redditbot|ia_archiver|Bingbot|BingPreview|applebot|facebookexternalhit|facebookcatalog|Twitterbot|LinkedInBot|Slackbot|Discordbot|WhatsApp|SkypeUriPreview|Yeti|googleweblight`;

// Crawlers Next's default misses (Googlebot / GoogleOther) plus the ones we
// care about for indexing. Real casing is kept for the possibly
// case-sensitive Vercel user-agent bypass matcher that `next build` writes to
// prerender-manifest.json, even though the 'i' flag covers them at runtime.
const TAYF_EXTRA_BOTS = [
  "Googlebot",
  "Google-InspectionTool",
  "GoogleOther",
  "bingbot",
  "YandexBot",
  "Chrome-Lighthouse",
] as const;

export const HTML_LIMITED_BOTS_SOURCE = `${NEXT_DEFAULT_HTML_LIMITED_BOTS}|${TAYF_EXTRA_BOTS.join("|")}`;

export const HTML_LIMITED_BOTS = new RegExp(HTML_LIMITED_BOTS_SOURCE, "i");
