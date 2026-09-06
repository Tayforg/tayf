import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { apiBadRequest, apiError, apiServerError, withApiErrors } from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";

// Corrections/objections: 5-token bucket refilling at 1 token / 12min (5/hour).
// Mirrors the newsletter-post limiter shape so mutating routes share one
// rate-limit pattern.
const correctionsPostLimit = createRateLimiter("corrections-post", {
  capacity: 5,
  refillPerSecond: 5 / 3600,
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isValidUrl(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const POST = withApiErrors(async (request: Request) => {
  const rl = correctionsPostLimit(clientKey(request));
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
  // don't learn the field is a trap.
  const website = typeof b.website === "string" ? b.website.trim() : "";
  if (website.length > 0) {
    return NextResponse.json({ ok: true }, { status: 200 });
  }

  const url = typeof b.url === "string" ? b.url.trim() : "";
  if (!isValidUrl(url)) {
    return apiBadRequest("Invalid url");
  }

  const message = typeof b.message === "string" ? b.message.trim() : "";
  if (message.length < 10 || message.length > 2000) {
    return apiBadRequest("Message must be between 10 and 2000 characters");
  }

  const emailRaw = typeof b.email === "string" ? b.email.trim() : "";
  if (emailRaw.length > 254 || (emailRaw.length > 0 && !EMAIL_RE.test(emailRaw))) {
    return apiBadRequest("Invalid email address");
  }

  const clusterIdRaw = typeof b.clusterId === "string" ? b.clusterId.trim() : "";
  if (clusterIdRaw.length > 0 && !UUID_RE.test(clusterIdRaw)) {
    return apiBadRequest("Invalid clusterId");
  }

  const supabase = createServerClient();
  const { error } = await supabase.from("corrections").insert({
    url,
    message,
    email: emailRaw.length > 0 ? emailRaw : null,
    cluster_id: clusterIdRaw.length > 0 ? clusterIdRaw : null,
  });

  if (error) {
    return apiServerError(error);
  }

  return NextResponse.json({ ok: true }, { status: 201 });
});
