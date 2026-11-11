import { connection } from "next/server";

import {
  getTopicClusters,
  topicNounTr,
  topicSubtitleTr,
  TOPIC_SLUGS,
  type TopicSlug,
} from "@/lib/clusters/topic-query";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import {
  ENTITY_HUB_LIMIT,
  ENTITY_HUB_WINDOW_DAYS,
  entityByKey,
  hubMatchNote,
  isEntityKey,
} from "@/lib/entities/entity-hub";
import { getEntityHub } from "@/lib/entities/entity-hub-query";
import { blindspotsFeedResponse } from "@/lib/feeds/blindspots-feed";
import {
  buildRssXml,
  rssUnavailableResponse,
  withUtm,
  type RssItemInput,
} from "@/lib/feeds/rss-builder";
import {
  formatZoneLine,
  sourceCountHead,
  votingZoneCounts,
} from "@/lib/feeds/zone-line";
import { siteUrl } from "@/lib/site-url";

// GET /rss/[topic].xml — one RSS 2.0 feed per topic hub (TOPIC_SLUGS) plus
// /rss/kor-noktalar.xml for /blindspots, and (h136-roadmap-3) one feed per
// entity hub at /rss/gundem-<key>.xml (the /gundem/<key> hubs). Not prerendered
// (no generateStaticParams): the underlying reads can transiently return
// null/throw, and baking a 503 into the build would be worse than paying a
// per-request round trip for a low-traffic feed endpoint.
//
// The entity feed is page 1 of getEntityHub(key), the same cached read the hub
// page renders (no query of its own), so its items are the hub's first 20
// clusters in the hub's order (first_published desc) and /rss/gundem-chp.xml
// lists the same /cluster ids as /gundem/chp. A 'gundem-' prefix cannot collide
// with a topic slug (none of TOPIC_SLUGS starts with it), and the middleware
// matcher '/rss/:topic' already covers the path.

const SLUG_PATTERN = /^([a-z-]+)\.xml$/;
const MAX_ITEMS = 30;

const ENTITY_FEED_PREFIX = "gundem-";

const KOR_NOKTALAR_SLUG = "kor-noktalar";
const ALLOWED_SLUGS: ReadonlySet<string> = new Set<string>([
  ...TOPIC_SLUGS,
  KOR_NOKTALAR_SLUG,
]);

interface RouteContext {
  params: Promise<{ topic: string }>;
}

function notFoundResponse(): Response {
  return new Response("Not found", {
    status: 404,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

function rssResponse(xml: string): Response {
  return new Response(xml, {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}

// One item for any cluster feed: `campaign` is the utm_campaign (konu_<slug> for
// a topic, gundem_<key> for an entity hub). The guid is the plain cluster URL.
function clusterItem(base: string, campaign: string, bundle: ClusterBundle): RssItemInput {
  const link = withUtm(`${base}/cluster/${bundle.cluster.id}`, {
    source: "rss",
    medium: "feed",
    campaign,
  });
  // Zones count voting sources only; the head is every member, with the
  // voting count in parentheses when they differ (see sourceCountHead).
  const counts = votingZoneCounts(bundle.sources);
  const zoneLine = formatZoneLine(counts);
  const head = sourceCountHead(bundle.sources.length, counts);

  return {
    title: bundle.cluster.title_tr,
    link,
    guid: `${base}/cluster/${bundle.cluster.id}`,
    pubDate: bundle.cluster.first_published,
    description: `${head} · ${zoneLine}`,
  };
}

// /rss/gundem-<key>.xml. `key` is already a curated entity key (isEntityKey).
async function entityFeedResponse(key: string): Promise<Response> {
  const entity = entityByKey(key);
  if (entity === null) return notFoundResponse();

  const hub = await getEntityHub(key);
  if (hub === null) return rssUnavailableResponse();

  const base = siteUrl();
  const items = hub.bundles
    .slice(0, ENTITY_HUB_LIMIT)
    .map((b) => clusterItem(base, `gundem_${key}`, b));

  const xml = buildRssXml({
    title: `Tayf — Gündem: ${entity.label}`,
    link: `${base}/gundem/${key}`,
    selfUrl: `${base}/rss/${ENTITY_FEED_PREFIX}${key}.xml`,
    // What the hub searches (headline only for akp), then the window and the
    // cap, so a subscriber knows the name match can include same-name stories.
    description: `${hubMatchNote(entity)} (son ${ENTITY_HUB_WINDOW_DAYS} gün, en yeni ${ENTITY_HUB_LIMIT})`,
    items,
  });
  return rssResponse(xml);
}

export async function GET(
  _request: Request,
  { params }: RouteContext,
): Promise<Response> {
  // digest-cron pattern: defer the dynamic-API boundary until after the
  // static shell would have prerendered — no generateStaticParams here, so
  // this mainly keeps this route consistent with the rest of the app.
  await connection();

  const { topic } = await params;
  const match = SLUG_PATTERN.exec(topic);
  if (!match) return notFoundResponse();

  const slug = match[1]!;

  // Entity hubs: 'gundem-<key>' with a curated key. 'gundem-', 'gundem-unknown'
  // and 'gundem-chp-x' are not keys and fall through to the 404 below.
  if (slug.startsWith(ENTITY_FEED_PREFIX)) {
    const key = slug.slice(ENTITY_FEED_PREFIX.length);
    return isEntityKey(key) ? entityFeedResponse(key) : notFoundResponse();
  }

  if (!ALLOWED_SLUGS.has(slug)) return notFoundResponse();

  if (slug === KOR_NOKTALAR_SLUG) {
    // Shared with /blindspots/rss.xml so the two URLs cannot drift.
    return blindspotsFeedResponse(`/rss/${KOR_NOKTALAR_SLUG}.xml`);
  }

  const base = siteUrl();
  const topicSlug = slug as TopicSlug;
  const result = await getTopicClusters(topicSlug, 1);
  if (result === null) return rssUnavailableResponse();

  const items = result.bundles
    .slice(0, MAX_ITEMS)
    .map((b) => clusterItem(base, `konu_${topicSlug}`, b));

  const xml = buildRssXml({
    title: `Tayf — ${topicNounTr(topicSlug)}`,
    link: `${base}/konu/${topicSlug}`,
    selfUrl: `${base}/rss/${topicSlug}.xml`,
    description: topicSubtitleTr(topicSlug),
    items,
  });
  return rssResponse(xml);
}
