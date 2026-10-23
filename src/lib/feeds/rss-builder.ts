// Pure RSS 2.0 builder shared by every RSS feed: /rss.xml
// (src/app/rss.xml/route.ts), /rss/[topic].xml (src/app/rss/[topic]/route.ts)
// and the blindspots feed (src/lib/feeds/blindspots-feed.ts). Also the single
// home of the repo's XML escaper (escapeXml) -- tests/guards/
// xml-escaper-single-source.test.ts keeps it that way. Never reads the clock: `lastBuildDate`
// is derived from the newest item's own `pubDate`, not `new Date()` — a
// clock read here would be a Next 16 cacheComponents violation the moment
// this is called from a cached context, and is dishonest anyway (the feed
// wasn't "built" at request time, its content was fetched earlier).

export interface RssItemInput {
  title: string;
  link: string;
  guid: string;
  /** ISO 8601 — converted to RFC 822 for the <pubDate> element. */
  pubDate: string;
  description: string;
}

export interface RssBuildInput {
  title: string;
  link: string;
  selfUrl: string;
  description: string;
  items: RssItemInput[];
}

// XML 1.0 `Char` allows only: U+0009, U+000A, U+000D, U+0020-U+D7FF,
// U+E000-U+FFFD and U+10000-U+10FFFF. Everything else makes a document that
// no conforming parser accepts ("PCDATA invalid Char value 11"), and ONE bad
// character in ONE item breaks the whole feed for every subscriber. Feed-
// sourced titles can carry such characters: ingest's decodeEntities() turns
// numeric references like &#11; into raw control characters. So this strips
//   - C0 controls other than tab / LF / CR,
//   - the BMP non-characters U+FFFE and U+FFFF,
//   - unpaired UTF-16 surrogates (a valid pair, i.e. an astral char such as an
//     emoji, is left alone).
// src/lib/seo/sitemaps.ts re-exports this escaper, so the sitemaps and every
// feed strip exactly the same set.
const INVALID_XML_CHARS_RE =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Removes every character XML 1.0 forbids, leaving legal text untouched. */
export function stripInvalidXmlChars(input: string): string {
  return input.replace(INVALID_XML_CHARS_RE, "");
}

/**
 * Makes `input` safe to embed in XML text or an attribute: drops characters
 * XML 1.0 forbids (see stripInvalidXmlChars), then escapes the five
 * predefined entities: & < > " '.
 */
export function escapeXml(input: string): string {
  return stripInvalidXmlChars(input)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * The 503 every RSS endpoint answers when its data read fails. `no-store` so a
 * CDN never pins the outage, and `Retry-After: 300` (the feeds' own 5-minute
 * freshness window) so readers and crawlers back off instead of hammering a
 * struggling database. A 503 -- never a 200 with an empty feed, which a reader
 * would take as "the publisher deleted everything".
 */
export function rssUnavailableResponse(): Response {
  return new Response("Service unavailable", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "300",
      "Cache-Control": "no-store",
    },
  });
}

function toRfc822(iso: string): string {
  return new Date(iso).toUTCString();
}

/**
 * Appends UTM query parameters via the URL API, preserving any params the
 * URL already carries. Existing `utm_*` params (unlikely, but possible on
 * a hand-built link) are overwritten by the explicit ones passed here.
 */
export function withUtm(
  url: string,
  params: { source: string; medium: string; campaign: string },
): string {
  const u = new URL(url);
  u.searchParams.set("utm_source", params.source);
  u.searchParams.set("utm_medium", params.medium);
  u.searchParams.set("utm_campaign", params.campaign);
  return u.toString();
}

/**
 * Builds an RSS 2.0 document with the atom:link self reference and
 * language tr-TR. `lastBuildDate` is the newest item's `pubDate` (by
 * parsed time, not array order) and is omitted entirely when `items` is
 * empty — there is no honest "last build" to report for a feed with
 * nothing in it.
 */
export function buildRssXml(input: RssBuildInput): string {
  const { title, link, selfUrl, description, items } = input;

  let newestMs: number | null = null;
  for (const item of items) {
    const ms = new Date(item.pubDate).getTime();
    if (Number.isFinite(ms) && (newestMs === null || ms > newestMs)) {
      newestMs = ms;
    }
  }

  const lastBuildDateTag =
    newestMs !== null
      ? `<lastBuildDate>${escapeXml(new Date(newestMs).toUTCString())}</lastBuildDate>\n    `
      : "";

  const itemsXml = items
    .map(
      (item) => `    <item>
      <title>${escapeXml(item.title)}</title>
      <link>${escapeXml(item.link)}</link>
      <guid isPermaLink="true">${escapeXml(item.guid)}</guid>
      <pubDate>${escapeXml(toRfc822(item.pubDate))}</pubDate>
      <description>${escapeXml(item.description)}</description>
    </item>`,
    )
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(title)}</title>
    <link>${escapeXml(link)}</link>
    <atom:link href="${escapeXml(selfUrl)}" rel="self" type="application/rss+xml" />
    <description>${escapeXml(description)}</description>
    <language>tr-TR</language>
    ${lastBuildDateTag}${itemsXml}
  </channel>
</rss>`;
}
