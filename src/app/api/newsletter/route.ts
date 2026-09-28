import { after, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { isMailConfigured, sendEmail } from "@/lib/email/resend";
import { siteUrl } from "@/lib/site-url";
import {
  apiBadRequest,
  apiError,
  apiServerError,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

// Newsletter signups: 5-token bucket refilling at 1 token / 30s. A real human
// fills the form once; this absorbs accidental double-clicks but cuts off any
// scripted abuse from a single IP. Mirrors the admin-post limiter shape so we
// have a single rate-limit pattern across mutating routes.
//
// This is process-local, same limitation as every other limiter in
// src/lib/rate-limit.ts: a durable cross-instance cooldown needs a shared
// store (Redis) or a DB column, not in scope here.
const newsletterPostLimit = createRateLimiter("newsletter-post", {
  capacity: 5,
  refillPerSecond: 1 / 30,
});

// Per-address cap: at most one confirmation mail per address per 10
// minutes per instance, independent of the IP limiter above (a script that
// rotates IPs but keeps re-submitting the same unconfirmed address would
// otherwise get a fresh confirm mail on every request). `rate-limit.ts`
// evicts idle buckets after DEFAULT_TTL_MS (10 minutes), so a longer window
// would be illusory — the bucket would just reset before it mattered.
const newsletterAddressLimit = createRateLimiter("newsletter-address", {
  capacity: 1,
  refillPerSecond: 1 / 600,
});

// Keys the address limiter by a SHA-256 hex digest rather than the raw
// email, so a rate-limit bucket never holds a subscriber's address in the
// clear (even transiently, in process memory).
async function addressRateLimitKey(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(email),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Pragmatic email regex — matches "local@domain.tld" with at least one dot in
// the domain. Not RFC-5322 perfect, but good enough to catch typos client-side
// and to keep obviously-broken rows out of the table. The unique index on
// `email` is the real source of truth for dedupe.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function confirmEmailHtml(confirmUrl: string): string {
  return (
    `<!doctype html><html><body style="font-family:sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">` +
    `<p>Tayf haftalık bültenine kaydolduğun için teşekkürler.</p>` +
    `<p><a href="${confirmUrl}" style="color:#0a58ca">Kaydını onaylamak için buraya tıkla</a></p>` +
    `<p style="color:#666;font-size:13px">Bu isteği sen yapmadıysan bu e-postayı görmezden gelebilirsin.</p>` +
    `</body></html>`
  );
}

interface ExistingSubscriberRow {
  confirm_token: string;
  confirmed_at: string | null;
}

// GET /api/newsletter/confirm and GET /api/newsletter/unsubscribe are
// deliberately NOT gated on isMailConfigured(): an already-mailed token must
// keep working even if the key is later removed.
export const POST = withApiErrors(async (request: Request) => {
  // Gate BEFORE the rate limiter's side effects and before any Supabase
  // call: a probe against a misconfigured deployment must not burn rate
  // limit tokens or promise a signup we cannot fulfill.
  if (!isMailConfigured()) {
    return apiError(503, "Newsletter is not configured");
  }

  const rl = newsletterPostLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", {
      details: { retryAfterMs: rl.retryAfterMs },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }

  if (typeof body !== "object" || body === null) {
    return apiBadRequest("Invalid request body");
  }
  const b = body as Record<string, unknown>;

  // Honeypot: bots that fill every field get a 200 with no insert, so they
  // don't learn the field is a trap. Mirrors /api/corrections.
  const website = typeof b.website === "string" ? b.website.trim() : "";
  if (website.length > 0) {
    return NextResponse.json({ success: true });
  }

  const email =
    typeof b.email === "string" ? b.email.trim().toLowerCase() : "";

  if (!email) {
    return apiBadRequest("Email is required");
  }
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    return apiBadRequest("Invalid email address");
  }

  const supabase = createServerClient();

  const { data: existingData, error: selectError } = await supabase
    .from("newsletter_subscribers")
    .select("confirm_token, confirmed_at")
    .eq("email", email)
    .maybeSingle();

  if (selectError) {
    return apiServerError(selectError);
  }

  const existing = existingData as ExistingSubscriberRow | null;

  // From here on the response is the same neutral `{ success: true }` no
  // matter which branch runs — never leak whether the address was already
  // on the list.
  if (existing) {
    if (existing.confirmed_at) {
      return NextResponse.json({ success: true });
    }

    const addressKey = await addressRateLimitKey(email);
    if (newsletterAddressLimit(addressKey).allowed) {
      const confirmUrl = `${siteUrl()}/api/newsletter/confirm?token=${encodeURIComponent(existing.confirm_token)}`;
      after(async () => {
        const r = await sendEmail({
          to: email,
          subject: "Tayf bültenine kaydını onayla",
          html: confirmEmailHtml(confirmUrl),
        });
        if ("ok" in r && !r.ok) console.error("[newsletter] confirm mail failed", r.error);
      });
    }
    // Neutral response either way — a re-POST that lands inside the
    // per-address cooldown must look identical to one that sent, so a
    // script probing the endpoint learns nothing about timing.
    return NextResponse.json({ success: true });
  }

  const confirmToken = crypto.randomUUID();
  const unsubscribeToken = crypto.randomUUID();

  const { error: insertError } = await supabase
    .from("newsletter_subscribers")
    .insert({
      email,
      confirm_token: confirmToken,
      unsubscribe_token: unsubscribeToken,
    });

  if (insertError) {
    // 23505 = unique_violation. A concurrent request won the race between
    // our select and this insert — treat it the same as "already exists":
    // neutral success, no email (the winning request already sent one).
    if (insertError.code === "23505") {
      return NextResponse.json({ success: true });
    }
    return apiServerError(insertError);
  }

  const addressKey = await addressRateLimitKey(email);
  if (newsletterAddressLimit(addressKey).allowed) {
    const confirmUrl = `${siteUrl()}/api/newsletter/confirm?token=${encodeURIComponent(confirmToken)}`;
    after(async () => {
      const r = await sendEmail({
        to: email,
        subject: "Tayf bültenine kaydını onayla",
        html: confirmEmailHtml(confirmUrl),
      });
      if ("ok" in r && !r.ok) console.error("[newsletter] confirm mail failed", r.error);
    });
  }

  return NextResponse.json({ success: true });
});
