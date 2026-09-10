import { getPoliticsClusters } from "@/lib/clusters/politics-query";
import { getRssSummaryMembers } from "@/lib/clusters/rss-summary-attribution";
import {
  describeForMeta,
  resolveSummaryAttribution,
} from "@/lib/clusters/summary-attribution";
import { getNeutralizedStatus } from "@/lib/headline/status";

// Visible cap for the composed <description> (prefix + wire note + outlet
// name + summary), word-boundary-truncated with an ellipsis by
// describeForMeta. Replaces the old hard 240-char slice of the summary
// alone, which ignored the prefix/outlet-name length entirely.
const RSS_DESCRIPTION_MAX = 400;

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export async function GET(): Promise<Response> {
  const { bundles } = await getPoliticsClusters();
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const now = new Date().toUTCString();

  // Honesty gate (Pack B): only claim AI-neutralization once at least one
  // cluster has actually been rewritten in production. A number/claim we
  // cannot stand behind is worse than making none — see
  // src/components/layout/footer.tsx's ActiveSourceCount for the same rule
  // applied to the source count. getNeutralizedStatus() never throws; a
  // null (unknown) status is treated the same as "no evidence yet".
  const neutralStatus = await getNeutralizedStatus();
  const neutralSentence =
    neutralStatus && neutralStatus.neutralized > 0
      ? " Başlıklar yapay zekâ ile tarafsızlaştırılmıştır (tayfhaber.com/metodoloji)."
      : "";

  const feed = bundles.slice(0, 30);

  // clusters.summary_tr is the seed article's raw copy, not Tayf's — it
  // must be attributed to the outlet that wrote it, or hidden. Only look
  // up members for clusters that actually have a summary to attribute.
  const attributable = feed
    .filter((b) => (b.cluster.summary_tr ?? "").trim().length > 0)
    .map((b) => b.cluster.id);
  const { members: membersByCluster, lookupFailed: memberLookupFailed } =
    await getRssSummaryMembers(attributable);

  const items = feed
    .map((b) => {
      const link = `${baseUrl}/cluster/${b.cluster.id}`;
      const title = escapeXml(b.cluster.title_tr ?? "Başlıksız");
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
      const description = escapeXml(
        describeForMeta(
          { count: honestCount, attribution, base: `${honestCount} kaynaktan haberler.${wireNote}` },
          RSS_DESCRIPTION_MAX,
        ),
      );
      const pubDate = new Date(b.cluster.first_published).toUTCString();
      return `    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${description}</description>
    </item>`;
    })
    .join("\n");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Tayf — Türkiye Haber Analizi</title>
    <link>${baseUrl}/</link>
    <atom:link href="${baseUrl}/rss.xml" rel="self" type="application/rss+xml" />
    <description>Aynı haber, farklı dünyalar. Türkiye haber kaynaklarından otomatik kümelenmiş haberler.${neutralSentence}</description>
    <language>tr-TR</language>
    <lastBuildDate>${now}</lastBuildDate>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
    },
  });
}
