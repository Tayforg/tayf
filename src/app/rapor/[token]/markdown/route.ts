/**
 * GET /rapor/[token]/markdown — public Markdown download of a shared
 * Yelpaze Raporu (migration 069, B9). No auth: the 32-hex token in the URL
 * IS the credential. Rate limited on its own bucket (separate from the
 * page render's) and gated by the exact same token checks as
 * src/app/rapor/[token]/page.tsx, in the same order: regex shape -> RPC
 * resolution -> report assembly. A download counts as a view — it calls
 * report_share_view() (via resolveShareToken) too, same as the page.
 *
 * Every miss (malformed token, unknown/expired/revoked token, or a report
 * that failed to assemble) is a 404 via apiNotFound — indistinguishable
 * from the outside, per the share-link contract.
 */
import { apiError, apiNotFound, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";
import { resolveShareToken, SHARE_TOKEN_RE } from "@/lib/reports/share";
import { buildYelpazeReport } from "@/lib/reports/yelpaze";
import { reportToMarkdown } from "@/lib/reports/markdown";

const reportShareMarkdownLimit = createRateLimiter("report-share-markdown", {
  capacity: 10,
  refillPerSecond: 0.2,
});

interface RouteContext {
  params: Promise<{ token: string }>;
}

export const GET = withApiErrors(async (request: Request, ctx: RouteContext) => {
  const rl = reportShareMarkdownLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  const { token } = await ctx.params;
  if (!SHARE_TOKEN_RE.test(token)) {
    return apiNotFound();
  }

  const supabase = createServerClient();
  const clusterId = await resolveShareToken(supabase, token);
  if (!clusterId) {
    return apiNotFound();
  }

  const report = await buildYelpazeReport(clusterId);
  if (!report) {
    return apiNotFound();
  }

  const markdown = reportToMarkdown(report, "");
  return new Response(markdown, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="tayf-yelpaze-${token.slice(0, 8)}.md"`,
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex, nofollow",
    },
  });
});
