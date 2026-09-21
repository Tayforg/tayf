import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { headers } from "next/headers";

import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";
import { REGISTRY_LICENCE } from "@/lib/sources/registry";
import { buildYelpazeReport } from "@/lib/reports/yelpaze";
import { resolveShareToken, SHARE_TOKEN_RE } from "@/lib/reports/share";
import { formatTurkishDate } from "@/lib/time";
import { YelpazeReportView } from "@/components/admin/yelpaze-report";

/**
 * GET /rapor/[token] — the public, tokened self-serve Yelpaze Raporu
 * surface (migration 069, B9). A 32-hex token in the URL is the only
 * credential; there is no session, no cookie, no admin chrome. Never
 * indexed (see `metadata.robots` below), belt-and-suspenders with an
 * unlisted-capability-URL posture (no link to this page exists anywhere
 * else in the app, and it is intentionally absent from sitemap.ts).
 */
export const metadata: Metadata = {
  title: "Tayf Yelpaze Raporu",
  robots: { index: false, follow: false },
};

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise and must be awaited.
  params: Promise<{ token: string }>;
}

const reportShareViewLimit = createRateLimiter("report-share-view", {
  capacity: 30,
  refillPerSecond: 0.5,
});

export default async function RaporTokenPage({ params }: PageProps) {
  // FIRST LINE of the component body: opts this route out of PPR's static
  // shell (cacheComponents, next.config.ts) — without it Next can flush a
  // 200 shell before the token checks below ever run, which would leak
  // report content for a request that should have 404'd or been rate
  // limited. See src/app/admin/(protected)/rapor/[clusterId]/page.tsx's
  // own comment for the same rationale on the admin twin of this page.
  await connection();

  const key = clientKey({ headers: await headers() });
  if (!reportShareViewLimit(key).allowed) {
    return <p>Çok fazla istek. Lütfen biraz sonra tekrar deneyin.</p>;
  }

  const { token } = await params;
  if (!SHARE_TOKEN_RE.test(token)) notFound();

  const supabase = createServerClient();
  // resolveShareToken (report_share_view RPC) is the SAME check used for
  // an unknown, malformed, expired or revoked token — all four notFound()
  // identically, so the outside world can never distinguish them.
  const clusterId = await resolveShareToken(supabase, token);
  if (!clusterId) notFound();

  const report = await buildYelpazeReport(clusterId);
  if (!report) notFound();

  // The report is serialized into the client-component's RSC flight
  // payload verbatim (`YelpazeReportView` is `"use client"`), so a field
  // that is only rendered behind the admin-gated variant still ships to
  // the browser on this public route. `header.clusterId` is referenced
  // only inside that admin-gated block — blank it here so the public
  // variant never carries a cluster id on the wire (E-SEC-03).
  const publicReport = { ...report, header: { ...report.header, clusterId: "" } };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-4 px-4 py-6 font-mono text-[12px]">
      <div className="space-y-1">
        <h1 className="text-[13px] font-semibold">
          Tayf Yelpaze <span className="text-brand">Raporu</span>
        </h1>
        <p className="text-muted-foreground">{report.header.title}</p>
        <p className="text-[10px] text-muted-foreground/80">
          Oluşturma: {formatTurkishDate(report.generatedAt)}
        </p>
        <p className="text-[10px] text-muted-foreground/80">{REGISTRY_LICENCE}</p>
        <a
          href={`/rapor/${token}/markdown`}
          className="inline-block text-[11px] underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Markdown indir
        </a>
      </div>
      <YelpazeReportView report={publicReport} variant="public" />
    </div>
  );
}
