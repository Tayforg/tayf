// Pure RSS 2.0 builder shared by every /rss/[topic].xml feed
// (src/app/rss/[topic]/route.ts). Never reads the clock: `lastBuildDate`
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

/** Escapes the five XML predefined entities: & < > " '. */
export function escapeXml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
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
