import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { connection } from "next/server";

import { requireAdminSession } from "@/lib/admin/session";
import { buildYelpazeReport } from "@/lib/reports/yelpaze";
import { YelpazeReportView } from "@/components/admin/yelpaze-report";

// Admin-only, client-specific report (R-01 pilot tool — pack D). Never
// indexed, never followed, never in sitemap.ts. Belt-and-suspenders with
// pack A's robots.ts, which already carries a blanket `Disallow: /admin`
// rule for every user-agent group — this page also opts out at the page
// level so a misconfigured robots.txt can never be the only thing keeping
// it out of a search index.
export const metadata: Metadata = {
  title: "Yelpaze Raporu",
  robots: { index: false, follow: false },
};

interface PageProps {
  // Next.js 16: dynamic-route `params` is a Promise and must be awaited.
  params: Promise<{ clusterId: string }>;
}

const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export default async function YelpazeRaporPage({ params }: PageProps) {
  // FIRST LINE of the component body: opts this route out of PPR's static
  // shell. Without this, `cacheComponents` (next.config.ts) lets Next
  // flush a 200 static shell before the dynamic segment (and therefore
  // requireAdminSession()'s redirect) ever runs — an unauthenticated
  // request would get a 200 with the redirect only executed client-side
  // via a serialized RSC error, not a real server 307. `connection()`
  // forces this whole route dynamic so the redirect below is a genuine
  // server-side 307 before a single byte is flushed.
  await connection();

  // requireAdminSession() calls next/navigation's redirect() on failure,
  // which throws before any JSX below is constructed — an unauthenticated
  // request never gets far enough to await params, let alone fetch the
  // report.
  await requireAdminSession();

  const { clusterId } = await params;
  if (!UUID_RE.test(clusterId)) notFound();

  const report = await buildYelpazeReport(clusterId);
  if (!report) notFound();

  return <YelpazeReportView report={report} />;
}
