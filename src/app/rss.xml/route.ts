import { connection } from "next/server";

import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import { getRssSummaryMembers } from "@/lib/clusters/rss-summary-attribution";
import {
  describeForMeta,
  resolveSummaryAttribution,
} from "@/lib/clusters/summary-attribution";
import {
  buildRssXml,
  rssUnavailableResponse,
  type RssItemInput,
} from "@/lib/feeds/rss-builder";
import { getNeutralizedStatus } from "@/lib/headline/status";
import { siteUrl } from "@/lib/site-url";

// GET /rss.xml -- the main politics feed. Built with the shared RSS builder
// (src/lib/feeds/rss-builder.ts), which owns XML escaping (including the
// characters XML 1.0 forbids), the atom self link, and a `lastBuildDate`
// derived from the newest item rather than the clock.
//
// Failure contract: every read is inside one try/catch and a failure is a
// 503 + Retry-After + no-store (rssUnavailableResponse), never a 200 with an
// empty or partial feed that readers and CDNs would keep. `connection()` is
// awaited first so this handler is never prerendered at `next build`, which
// would otherwise bake a build-time outage into the static output.

// Visible cap for the composed <description> (prefix + wire note + outlet
// name + summary), word-boundary-truncated with an ellipsis by
// describeForMeta. Replaces the old hard 240-char slice of the summary
// alone, which ignored the prefix/outlet-name length entirely.
const RSS_DESCRIPTION_MAX = 400;

const MAX_ITEMS = 30;

type PoliticsBundles = Awaited<ReturnType<typeof getPoliticsClusters>>["bundles"];
type SummaryMembers = Awaited<ReturnType<typeof getRssSummaryMembers>>;

interface FeedData {
  feed: PoliticsBundles;
  neutralSentence: string;
  membersByCluster: SummaryMembers["members"];
  memberLookupFailed: SummaryMembers["lookupFailed"];
}

/** Every database read the feed needs. Rejects on any failure. */
async function readFeedData(): Promise<FeedData> {
  // Honesty gate (Pack B): only claim AI-neutralization once at least one
  // cluster has actually been rewritten in production. A number/claim we
  // cannot stand behind is worse than making none — see
  // src/components/layout/footer.tsx's ActiveSourceCount for the same rule
  // applied to the source count. getNeutralizedStatus() never throws; a
  // null (unknown) status is treated the same as "no evidence yet".
  //
  // reader-queries F2: the two fetches are independent — run them in
  // parallel rather than two serial awaits.
  const [{ bundles }, neutralStatus] = await Promise.all([
    getPoliticsClusters(),
    getNeutralizedStatus(),
  ]);
  const neutralSentence =
    neutralStatus && neutralStatus.neutralized > 0
      ? " Başlıklar yapay zekâ ile tarafsızlaştırılmıştır (tayfhaber.com/metodoloji)."
      : "";

  const feed = bundles.slice(0, MAX_ITEMS);

  // clusters.summary_tr is the seed article's raw copy, not Tayf's — it
  // must be attributed to the outlet that wrote it, or hidden. Only look
  // up members for clusters that actually have a summary to attribute.
  const attributable = feed
    .filter((b) => (b.cluster.summary_tr ?? "").trim().length > 0)
    .map((b) => b.cluster.id);
  const { members: membersByCluster, lookupFailed: memberLookupFailed } =
    await getRssSummaryMembers(attributable);

  return { feed, neutralSentence, membersByCluster, memberLookupFailed };
}

export async function GET(): Promise<Response> {
  await connection();

  const base = siteUrl();

  let data: FeedData;
  try {
    data = await readFeedData();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[rss.xml] unavailable: " + message);
    return rssUnavailableResponse();
  }
  const { feed, neutralSentence, membersByCluster, memberLookupFailed } = data;

  // Titles and descriptions are handed to the builder RAW: it escapes every
  // field exactly once, so pre-escaping here would double-escape.
  const items: RssItemInput[] = feed.map((b) => {
    const link = `${base}/cluster/${b.cluster.id}`;
    const honestCount = b.effectiveArticleCount ?? b.cluster.article_count;
    const wireNote = b.isWireRedistribution
      ? ` Tek kaynaktan ${b.cluster.article_count} kopya.`
      : "";
    const wire = { isWireRedistribution: b.isWireRedistribution === true };
    const members = membersByCluster[b.cluster.id];
    const summary = b.cluster.summary_tr ?? "";
    // Never fall back to the raw unattributed summary: a missing/failed
    // lookup degrades to the generic label or hides the summary, but
    // must never publish someone else's words as if they were Tayf's.
    // BL-13: when the whole members lookup failed (memberLookupFailed),
    // a missing `members` entry must hide the excerpt rather than
    // degrade to summaryAttributionWithoutMembers, which cannot re-run
    // the excerpt_allowed gate and would otherwise publish a
    // rights-blocked outlet's raw text whenever the lookup errors.
    const attribution = resolveSummaryAttribution({
      summary,
      members,
      lookupFailed: memberLookupFailed,
      wire,
    });
    return {
      title: b.cluster.title_tr ?? "Başlıksız",
      link,
      guid: link,
      pubDate: b.cluster.first_published,
      description: describeForMeta(
        {
          count: honestCount,
          attribution,
          base: `${honestCount} kaynaktan haberler.${wireNote}`,
        },
        RSS_DESCRIPTION_MAX,
      ),
    };
  });

  const xml = buildRssXml({
    title: "Tayf — Türkiye Haber Analizi",
    link: `${base}/`,
    selfUrl: `${base}/rss.xml`,
    description: `Aynı haber, farklı dünyalar. Türkiye haber kaynaklarından otomatik kümelenmiş haberler.${neutralSentence}`,
    items,
  });

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control":
        "public, max-age=300, s-maxage=300, stale-while-revalidate=3600",
    },
  });
}
