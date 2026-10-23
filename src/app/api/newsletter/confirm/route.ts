import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiTooManyRequests, withApiErrors } from "@/lib/api/errors";
import { INTERSTITIAL_HEADERS, interstitialPage } from "@/lib/newsletter/interstitial";
import { siteUrl } from "@/lib/site-url";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

/**
 * Double-opt-in confirm link, sent in the POST /api/newsletter email.
 *
 *   - GET renders a same-origin "do you want to subscribe?" page and NEVER
 *     touches the database. Mail scanners, link prefetchers and preview bots
 *     follow every GET link in a message; the previous GET flipped
 *     `confirmed_at`, so any of them could subscribe a reader who never
 *     clicked. Same pattern as GET /api/newsletter/unsubscribe.
 *   - POST (the page's form, or `?token=`) does the write: it sets
 *     `confirmed_at` (migration 040's trigger keeps the legacy `confirmed`
 *     boolean in sync) and redirects 303 back to the site with a `?bulten=`
 *     flag so the homepage can show a plain banner instead of bare JSON.
 *
 * An unknown, malformed or missing token redirects to the same "invalid"
 * flag rather than a 404 — a stale or tampered link is a UX problem, not a
 * routing one. The token is never logged: it is the capability that
 * authorizes the write.
 */

// Tokens are minted via crypto.randomUUID() (see POST /api/newsletter), so a
// canonical UUID shape is a cheap, sufficient validity check before it ever
// reaches a query or gets echoed into the interstitial's HTML.
const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST is a mutation; this bounds retries against a guessed or leaked token.
// 10-token bucket refilling one token every 6s — the same shape as the
// unsubscribe limiter, so a human double-click or a mail provider's retry is
// absorbed while a script is cut off.
const newsletterConfirmLimit = createRateLimiter("newsletter-confirm", {
  capacity: 10,
  refillPerSecond: 1 / 6,
});

function redirectTo(flag: "onaylandi" | "gecersiz", status: 302 | 303): NextResponse {
  return NextResponse.redirect(new URL(`/?bulten=${flag}`, siteUrl()), status);
}

function confirmPageHtml(token: string): string {
  return interstitialPage({
    title: "Bülten aboneliğini onayla — Tayf",
    heading: "Tayf bültenine aboneliğini onaylıyor musun?",
    body: "Onayladığında haftalık bülteni bu adrese göndermeye başlayacağız.",
    action: "/api/newsletter/confirm",
    token,
    submitLabel: "Evet, aboneliğimi onayla",
  });
}

export const GET = withApiErrors(async (request: Request) => {
  // Next 16 + cacheComponents prerenders GET handlers at build time; the
  // query string in `request.url` is only real once an actual request
  // lands. Same rationale as src/app/api/cron/headline/route.ts.
  await connection();

  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token")?.trim() ?? "";

  if (!TOKEN_RE.test(token)) {
    return redirectTo("gecersiz", 302);
  }

  return new NextResponse(confirmPageHtml(token), {
    status: 200,
    headers: INTERSTITIAL_HEADERS,
  });
});

/**
 * The token from a submitted form body, else from the URL's query string.
 * `request.formData()` throws on a JSON or empty body, which is treated the
 * same as "no form fields" rather than a 500.
 */
async function readConfirmToken(request: Request): Promise<string> {
  let formToken: string | null = null;
  try {
    const rawToken = (await request.formData()).get("token");
    formToken = typeof rawToken === "string" ? rawToken : null;
  } catch {
    // Not a form body (e.g. JSON, or empty) — fall back to the query string.
  }

  const { searchParams } = new URL(request.url);
  return (formToken ?? searchParams.get("token") ?? "").trim();
}

/**
 * POST performs the confirmation. Redirects are 303 (the follow-up GET of the
 * homepage must not be replayed as a POST).
 *
 * The update only matches a row whose `confirmed_at` is still null, so
 * re-submitting the form (or following the e-mail link twice) never moves an
 * existing confirmation timestamp. When it matches nothing, one plain select
 * tells "already confirmed" (still a success for the reader) from "unknown
 * token".
 *
 * No Origin/CSRF check on purpose: the 122-bit random token is itself the
 * capability that authorizes the write, and the form is served from the same
 * origin that receives it.
 */
export const POST = withApiErrors(async (request: Request) => {
  const rl = newsletterConfirmLimit(clientKey(request));
  if (!rl.allowed) {
    return apiTooManyRequests(rl.retryAfterMs);
  }

  const token = await readConfirmToken(request);
  if (!TOKEN_RE.test(token)) {
    return redirectTo("gecersiz", 303);
  }

  const supabase = createServerClient();
  const { data: updated, error: updateError } = await supabase
    .from("newsletter_subscribers")
    .update({ confirmed_at: new Date().toISOString() })
    .eq("confirm_token", token)
    .is("confirmed_at", null)
    .select("id")
    .maybeSingle();

  if (updateError) {
    // Only the Postgres code: the full error can echo request details, and
    // the token must never reach a log line.
    console.error("[newsletter-confirm] update failed", { code: updateError.code ?? null });
    return redirectTo("gecersiz", 303);
  }

  if (updated) {
    return redirectTo("onaylandi", 303);
  }

  const { data: existing, error: lookupError } = await supabase
    .from("newsletter_subscribers")
    .select("confirmed_at")
    .eq("confirm_token", token)
    .maybeSingle();

  if (lookupError) {
    console.error("[newsletter-confirm] lookup failed", { code: lookupError.code ?? null });
    return redirectTo("gecersiz", 303);
  }

  const alreadyConfirmed =
    (existing as { confirmed_at: string | null } | null)?.confirmed_at != null;
  return redirectTo(alreadyConfirmed ? "onaylandi" : "gecersiz", 303);
});
