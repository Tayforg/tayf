import { getPoliticsClusters } from "@/lib/clusters/politics-query";

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

  const items = bundles
    .slice(0, 30)
    .map((b) => {
      const link = `${baseUrl}/cluster/${b.cluster.id}`;
      const title = escapeXml(b.cluster.title_tr ?? "Başlıksız");
      const honestCount = b.effectiveArticleCount ?? b.cluster.article_count;
      const wireNote = b.isWireRedistribution
        ? ` Tek kaynaktan ${b.cluster.article_count} kopya.`
        : "";
      const description = escapeXml(
        `${honestCount} kaynaktan haberler.${wireNote} ${(b.cluster.summary_tr ?? "").slice(0, 240)}`
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
    <description>Aynı haber, farklı dünyalar. 144 Türk kaynağından otomatik kümelenmiş haberler. Başlıklar yapay zekâ ile tarafsızlaştırılmıştır (tayfhaber.com/metodoloji).</description>
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
