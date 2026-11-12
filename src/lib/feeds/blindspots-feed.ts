import { dominantZonePercent } from "@/lib/bias/zone-summary";
import { ZONE_KAYNAKLAR } from "@/lib/bias/zone-phrases";
import {
  getBlindspots,
  type BlindspotBundle,
  type BlindspotMoreRow,
} from "@/lib/clusters/blindspots-query";
import {
  buildRssXml,
  rssUnavailableResponse,
  withUtm,
  type RssItemInput,
} from "@/lib/feeds/rss-builder";
import { formatZoneLine, sourceCountHead } from "@/lib/feeds/zone-line";
import { siteUrl } from "@/lib/site-url";
import type { MediaDnaZone } from "@/types";

// The blindspots RSS feed, served from two URLs that MUST stay identical:
// /blindspots/rss.xml (roadmap URL) and /rss/kor-noktalar.xml (the original
// URL existing subscribers and the /blindspots alternate link point at).
// Both route handlers call blindspotsFeedResponse(selfPath), so the only
// thing that differs between them is the atom:link self reference.
//
// Reads through getBlindspots()'s default reader profile (4 s cap); it throws
// on failure and that is surfaced as a 503, never a cached/partial feed.
// No 'use cache' here and no clock reads — see rss-builder.ts.
//
// h53-consistency-1: the items are the page's list in the page's order: the
// full-card bundles first, then the compact `more` rows, so every public claim
// of the trailing 7 days is reachable from the feed (it used to carry only the
// 30 cards). 30 cards + up to 30 compact rows is the cap.

export const BLINDSPOTS_FEED_MAX_ITEMS = 60;

/** What an item needs, whether it comes from a full bundle or a compact row. */
interface FeedClaim {
  id: string;
  title: string;
  pubDate: string;
  /** Every member, as the card's "N kaynak". */
  sourceCount: number;
  dominantZone: MediaDnaZone;
  votingZoneCounts: Record<MediaDnaZone, number>;
}

function claimRssItem(base: string, claim: FeedClaim): RssItemInput {
  const link = withUtm(`${base}/cluster/${claim.id}`, {
    source: "rss",
    medium: "feed",
    campaign: "kor_nokta",
  });
  // The exact voting tally dominantZone/dominantPct are derived from. Both the
  // zone line and the "%N" in the prefix come from it, and N is the same
  // largest-remainder percent the card's bar and chip print (11/1/1 is 84,
  // not Math.round's 85). The head is the full member count, as on the card,
  // with the voting count in parentheses when aggregator or niche members make
  // it differ, so the zones add up to what is printed. dominantPct is only the
  // sort key, never copy.
  const zoneLine = formatZoneLine(claim.votingZoneCounts);
  const head = sourceCountHead(claim.sourceCount, claim.votingZoneCounts);
  const pct = dominantZonePercent(claim.votingZoneCounts, claim.dominantZone);
  const prefix = `Kör nokta: ağırlıkla ${ZONE_KAYNAKLAR[claim.dominantZone]} (%${pct}). `;

  return {
    title: claim.title,
    link,
    guid: `${base}/cluster/${claim.id}`,
    pubDate: claim.pubDate,
    description: `${prefix}${head} · ${zoneLine}`,
  };
}

export function blindspotRssItem(
  base: string,
  bundle: BlindspotBundle,
): RssItemInput {
  return claimRssItem(base, {
    id: bundle.cluster.id,
    title: bundle.cluster.title_tr,
    pubDate: bundle.cluster.first_published,
    sourceCount: bundle.sources.length,
    dominantZone: bundle.dominantZone,
    votingZoneCounts: bundle.votingZoneCounts,
  });
}

/**
 * An item for a claim that has no full card. Described exactly like a card
 * item (same prefix, percent and zone line) and dated like one, by the claim's
 * first publication: its last update moves with every new member and would sort
 * a compact row above every card. The guid is the cluster URL either way, which
 * is what readers key on.
 */
export function blindspotMoreRssItem(
  base: string,
  row: BlindspotMoreRow,
): RssItemInput {
  return claimRssItem(base, {
    id: row.id,
    title: row.title,
    pubDate: row.firstPublished,
    sourceCount: row.sourceCount,
    dominantZone: row.dominantZone,
    votingZoneCounts: row.votingZoneCounts,
  });
}

export function buildBlindspotsRssXml(
  base: string,
  bundles: readonly BlindspotBundle[],
  selfPath: string,
  more: readonly BlindspotMoreRow[] = [],
): string {
  const seen = new Set<string>();
  const items: RssItemInput[] = [];
  const candidates: Array<{ id: string; item: () => RssItemInput }> = [
    ...bundles.map((b) => ({
      id: b.cluster.id,
      item: () => blindspotRssItem(base, b),
    })),
    ...more.map((m) => ({
      id: m.id,
      item: () => blindspotMoreRssItem(base, m),
    })),
  ];
  for (const candidate of candidates) {
    if (items.length >= BLINDSPOTS_FEED_MAX_ITEMS) break;
    // One <link> per claim: a claim listed twice keeps its first (card) item.
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    items.push(candidate.item());
  }
  return buildRssXml({
    title: "Tayf — Kör noktalar",
    link: `${base}/blindspots`,
    selfUrl: `${base}${selfPath}`,
    description:
      "Bir tarafın haberi verdiği, diğer taraflardan az ya da hiç haber çıkmayan hikâyeler.",
    items,
  });
}

export async function blindspotsFeedResponse(
  selfPath: string,
): Promise<Response> {
  const base = siteUrl();

  let bundles: BlindspotBundle[];
  let more: BlindspotMoreRow[];
  try {
    const data = await getBlindspots();
    bundles = data.bundles;
    // Every real result carries `more`; a result shaped like the old
    // `{ bundles }` one is served as just its cards rather than failing.
    more = data.more ?? [];
  } catch {
    return rssUnavailableResponse();
  }

  return new Response(buildBlindspotsRssXml(base, bundles, selfPath, more), {
    status: 200,
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
