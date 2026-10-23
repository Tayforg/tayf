import { ZONE_META } from "@/lib/bias/config";
import { getBlindspots, type BlindspotBundle } from "@/lib/clusters/blindspots-query";
import {
  buildRssXml,
  rssUnavailableResponse,
  withUtm,
  type RssItemInput,
} from "@/lib/feeds/rss-builder";
import { formatZoneLine } from "@/lib/feeds/zone-line";
import { siteUrl } from "@/lib/site-url";

// The blindspots RSS feed, served from two URLs that MUST stay identical:
// /blindspots/rss.xml (roadmap URL) and /rss/kor-noktalar.xml (the original
// URL existing subscribers and the /blindspots alternate link point at).
// Both route handlers call blindspotsFeedResponse(selfPath), so the only
// thing that differs between them is the atom:link self reference.
//
// Reads through getBlindspots()'s default reader profile (4 s cap); it throws
// on failure and that is surfaced as a 503, never a cached/partial feed.
// No 'use cache' here and no clock reads — see rss-builder.ts.

export const BLINDSPOTS_FEED_MAX_ITEMS = 30;

export function blindspotRssItem(
  base: string,
  bundle: BlindspotBundle,
): RssItemInput {
  const link = withUtm(`${base}/cluster/${bundle.cluster.id}`, {
    source: "rss",
    medium: "feed",
    campaign: "kor_nokta",
  });
  // The exact voting tally dominantZone/dominantPct are derived from, so the
  // zone line agrees with the "%N" in the prefix; "N kaynak" stays the full
  // source count, as on the card.
  const zoneLine = formatZoneLine(bundle.votingZoneCounts);
  const n = bundle.sources.length;
  const zoneLabel = ZONE_META[bundle.dominantZone].label;
  const pct = Math.round(bundle.dominantPct * 100);
  const prefix = `Kör nokta: ağırlıkla ${zoneLabel} kaynakları (%${pct}). `;

  return {
    title: bundle.cluster.title_tr,
    link,
    guid: `${base}/cluster/${bundle.cluster.id}`,
    pubDate: bundle.cluster.first_published,
    description: `${prefix}${n} kaynak · ${zoneLine}`,
  };
}

export function buildBlindspotsRssXml(
  base: string,
  bundles: readonly BlindspotBundle[],
  selfPath: string,
): string {
  const items = bundles
    .slice(0, BLINDSPOTS_FEED_MAX_ITEMS)
    .map((b) => blindspotRssItem(base, b));
  return buildRssXml({
    title: "Tayf — Kör noktalar",
    link: `${base}/blindspots`,
    selfUrl: `${base}${selfPath}`,
    description:
      "Bir tarafın haberi verdiği, diğerlerinin görmezden geldiği hikâyeler.",
    items,
  });
}

export async function blindspotsFeedResponse(
  selfPath: string,
): Promise<Response> {
  const base = siteUrl();

  let bundles: BlindspotBundle[];
  try {
    bundles = (await getBlindspots()).bundles;
  } catch {
    return rssUnavailableResponse();
  }

  return new Response(buildBlindspotsRssXml(base, bundles, selfPath), {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
