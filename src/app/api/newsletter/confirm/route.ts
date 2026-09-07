import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { withApiErrors } from "@/lib/api/errors";
import { siteUrl } from "@/lib/site-url";

/**
 * Double-opt-in confirm link, sent in the POST /api/newsletter email.
 * Flips `confirmed_at` on the matching row (migration 040's trigger keeps
 * the legacy `confirmed` boolean in sync) and redirects back to the site
 * with a `?bulten=` flag so the homepage can show a plain banner instead
 * of a bare JSON response. An unknown/missing token redirects to the same
 * "invalid" flag rather than a 404 — a stale or tampered link is a UX
 * problem, not a routing one.
 */
export const GET = withApiErrors(async (request: Request) => {
  // Next 16 + cacheComponents prerenders GET handlers at build time; the
  // query string in `request.url` is only real once an actual request
  // lands. Same rationale as src/app/api/cron/headline/route.ts.
  await connection();

  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token")?.trim();

  if (!token) {
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("newsletter_subscribers")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("confirm_token", token)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[newsletter-confirm]", error);
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  if (!data) {
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  return NextResponse.redirect(new URL("/?bulten=onaylandi", siteUrl()), 302);
});
