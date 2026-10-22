import { connection } from "next/server";

import {
  getTopicClusters,
  TOPIC_LABELS_TR,
  TOPIC_SLUGS,
  type TopicSlug,
} from "@/lib/clusters/topic-query";
import type { ClusterBundle } from "@/lib/clusters/politics-query";
import { blindspotsFeedResponse } from "@/lib/feeds/blindspots-feed";
import { buildRssXml, withUtm, type RssItemInput } from "@/lib/feeds/rss-builder";
import { formatZoneLine, zoneCountsFromSources } from "@/lib/feeds/zone-line";
import { siteUrl } from "@/lib/site-url";

// GET /rss/[topic].xml — one RSS 2.0 feed per topic hub (TOPIC_SLUGS) plus
// /rss/kor-noktalar.xml for /blindspots. Not prerendered
// (no generateStaticParams): the underlying reads can transiently return
// null/throw, and baking a 503 into the build would be worse than paying a
// per-request round trip for a low-traffic feed endpoint.
//
// Do NOT modify src/app/rss.xml/route.ts — this is a separate, additive
// surface (see the pack's "do not touch" list).

const SLUG_PATTERN = /^([a-z-]+)\.xml$/;
const MAX_ITEMS = 30;

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

function unavailableResponse(): Response {
  return new Response("Service unavailable", {
    status: 503,
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "300",
      "Cache-Control": "no-store",
    },
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

function topicItem(base: string, slug: TopicSlug, bundle: ClusterBundle): RssItemInput {
  const link = withUtm(`${base}/cluster/${bundle.cluster.id}`, {
    source: "rss",
    medium: "feed",
    campaign: `konu_${slug}`,
  });
  const zoneLine = formatZoneLine(zoneCountsFromSources(bundle.sources));
  const n = bundle.sources.length;

  return {
    title: bundle.cluster.title_tr,
    link,
    guid: `${base}/cluster/${bundle.cluster.id}`,
    pubDate: bundle.cluster.first_published,
    description: `${n} kaynak · ${zoneLine}`,
  };
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
  if (!ALLOWED_SLUGS.has(slug)) return notFoundResponse();

  if (slug === KOR_NOKTALAR_SLUG) {
    // Shared with /blindspots/rss.xml so the two URLs cannot drift.
    return blindspotsFeedResponse(`/rss/${KOR_NOKTALAR_SLUG}.xml`);
  }

  const base = siteUrl();
  const topicSlug = slug as TopicSlug;
  const result = await getTopicClusters(topicSlug, 1);
  if (result === null) return unavailableResponse();

  const label = TOPIC_LABELS_TR[topicSlug];
  const items = result.bundles
    .slice(0, MAX_ITEMS)
    .map((b) => topicItem(base, topicSlug, b));

  const xml = buildRssXml({
    title: `Tayf — ${label} haberleri`,
    link: `${base}/konu/${topicSlug}`,
    selfUrl: `${base}/rss/${topicSlug}.xml`,
    description: `Son 7 günde ${label} konusunda kümelenen haberler.`,
    items,
  });
  return rssResponse(xml);
}
