import { connection, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { siteUrl } from "@/lib/site-url";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

// Tokens are minted via crypto.randomUUID() (see POST /api/newsletter), so a
// canonical UUID shape is a cheap, sufficient validity check before it ever
// reaches a query or gets echoed into the confirm page's HTML.
const TOKEN_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// POST is a mutation (deletes a row on a good token); this bounds retries
// against a guessed/leaked token and absorbs a burst of legitimate
// one-click POSTs from a mail provider. 10-token bucket, refilling one
// token every 6s — same shape as the other mutating-route limiters.
const newsletterUnsubscribeLimit = createRateLimiter("newsletter-unsubscribe", {
  capacity: 10,
  refillPerSecond: 1 / 6,
});

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c] as string);
}

function confirmPageHtml(token: string): string {
  const escapedToken = escapeHtml(token);
  const home = `${siteUrl()}/`;
  return (
    `<!doctype html><html lang="tr"><head>` +
    `<meta charset="utf-8">` +
    `<meta name="robots" content="noindex">` +
    `<title>Bültenden ayrıl — Tayf</title>` +
    `</head><body style="font-family:sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">` +
    `<h1>Tayf bülteninden ayrılmak istiyor musun?</h1>` +
    `<p>Onayladığında haftalık bülteni bu adrese bir daha göndermeyiz.</p>` +
    `<form method="post" action="/api/newsletter/unsubscribe">` +
    `<input type="hidden" name="token" value="${escapedToken}">` +
    `<button type="submit">Evet, bültenden ayrıl</button>` +
    `</form>` +
    `<p><a href="${home}">Vazgeç, Tayf'a dön</a></p>` +
    `</body></html>`
  );
}

/**
 * GET renders a same-origin confirmation page — it MUST NOT touch the
 * database. Mail/link scanners and prefetchers routinely follow GET links
 * automatically; a GET that deleted the row (the previous behavior) let any
 * scanner silently unsubscribe a reader. Actual removal only happens on the
 * POST below, submitted by a human via the rendered form (or a provider's
 * RFC 8058 one-click POST).
 */
export const GET = withApiErrors(async (request: Request) => {
  // Next 16 + cacheComponents prerenders GET handlers at build time; see
  // src/app/api/newsletter/confirm/route.ts for the same pattern.
  await connection();

  const { searchParams } = new URL(request.url);
  const token = searchParams.get("token")?.trim() ?? "";

  if (!TOKEN_RE.test(token)) {
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 302);
  }

  return new NextResponse(confirmPageHtml(token), {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex",
      "Referrer-Policy": "no-referrer",
    },
  });
});

/**
 * Reads the token from either a submitted form body or the URL's query
 * string, and whether the request identifies itself as an RFC 8058
 * one-click POST. `request.formData()` throws on a JSON or empty body, so
 * that's treated the same as "no form fields" rather than a 500.
 */
async function readUnsubscribePost(
  request: Request,
): Promise<{ token: string; oneClick: boolean }> {
  const { searchParams } = new URL(request.url);

  let formToken: string | null = null;
  let oneClick = false;
  try {
    const formData = await request.formData();
    const rawToken = formData.get("token");
    formToken = typeof rawToken === "string" ? rawToken : null;
    oneClick = formData.get("List-Unsubscribe") === "One-Click";
  } catch {
    // Not a form body (e.g. JSON, or empty) — fall back to the query string.
  }

  const token = (formToken ?? searchParams.get("token") ?? "").trim();
  return { token, oneClick };
}

/**
 * POST performs the actual removal. Two shapes hit this handler:
 *
 *   - A browser form submit (this route's own GET page): urlencoded
 *     `token=<value>`, redirected back to the site with a `?bulten=` flag
 *     (303, since this follows a POST — see RFC 7231 §6.4.4).
 *   - An RFC 8058 one-click POST from a mail provider: the token rides the
 *     URL (`?token=`), the body is `List-Unsubscribe=One-Click`, and the
 *     provider expects a plain 200 — no redirect, no HTML.
 *
 * No Origin/CSRF check here on purpose: RFC 8058 posts originate at the
 * provider, not the subscriber's browser, and the 122-bit random token
 * itself is the capability that authorizes the deletion.
 */
export const POST = withApiErrors(async (request: Request) => {
  const rl = newsletterUnsubscribeLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  const { token, oneClick } = await readUnsubscribePost(request);

  if (!TOKEN_RE.test(token)) {
    return oneClick
      ? NextResponse.json({ success: true })
      : NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 303);
  }

  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("newsletter_subscribers")
    .delete()
    .eq("unsubscribe_token", token)
    .select("id")
    .maybeSingle();

  if (error) {
    if (oneClick) {
      // apiServerError logs the error itself (tagged [api] + a request id)
      // — no separate console call here, so the token/error never gets
      // logged twice.
      return apiServerError(error);
    }
    console.error("[newsletter-unsubscribe] delete failed", error);
    return NextResponse.redirect(new URL("/?bulten=gecersiz", siteUrl()), 303);
  }

  if (oneClick) {
    // Idempotent by design: an unknown or already-removed token still
    // reports success to the provider. RFC 8058 clients retry on anything
    // other than 200, and there's nothing actionable a provider can do
    // with a distinction between "already gone" and "never existed".
    return NextResponse.json({ success: true });
  }

  return NextResponse.redirect(
    new URL(data ? "/?bulten=ayrildi" : "/?bulten=gecersiz", siteUrl()),
    303,
  );
});
