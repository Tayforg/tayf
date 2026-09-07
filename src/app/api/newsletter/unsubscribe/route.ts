import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { withApiErrors } from "@/lib/api/errors";
import { siteUrl } from "@/lib/site-url";

/**
 * One-click unsubscribe link, carried in the digest email footer. Deletes
 * the subscriber row outright (no soft-delete flag — an unsubscribed reader
 * is not on the list, full stop) and redirects back to the site with a
 * `?bulten=` flag. An unknown/missing token redirects to the same
 * "invalid" flag rather than a 404, matching the confirm route.
 */
export const GET = withApiErrors(async (request: Request) => {
  // See src/app/api/newsletter/confirm/route.ts for why this goes first.
  await connection();

  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token")?.trim();

  if (!token) {
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("newsletter_subscribers")
    .delete()
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("[newsletter-unsubscribe]", error);
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  if (!data) {
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  return NextResponse.redirect(new URL("/?bulten=ayrildi", siteUrl()), 302);
});
