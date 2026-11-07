import { NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import {
  ALLOW_POST_ONLY,
  apiBadRequest,
  apiMethodNotAllowed,
  apiOptionsAllow,
  apiTooManyRequests,
  apiServerError,
  withApiErrors,
} from "@/lib/api/errors";
import { checkDbThrottle, THROTTLE_POLICY } from "@/lib/api/db-throttle";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { validateCorrection } from "@/lib/corrections/validate";

// Corrections/objections: 5-token bucket refilling at 1 token / 12min (5/hour).
// Mirrors the newsletter-post limiter shape so mutating routes share one
// rate-limit pattern. First filter only: it is process-local, so on Vercel it
// bounds one instance, not the fleet. The fleet-wide cap is the DB throttle
// (migration 118) checked just before the insert below.
const correctionsPostLimit = createRateLimiter("corrections-post", {
  capacity: 5,
  refillPerSecond: 5 / 3600,
});

export const POST = withApiErrors(async (request: Request) => {
  const key = clientKey(request);
  const rl = correctionsPostLimit(key);
  if (!rl.allowed) {
    return apiTooManyRequests(rl.retryAfterMs);
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

  // The same rules the correction form runs before it sends (the shared pure
  // validator). They stay authoritative here; `details.field` is additive so
  // the form can show its Turkish message next to the right input, and the
  // English `error` strings are exactly what they always were.
  const checked = validateCorrection({
    url: b.url,
    message: b.message,
    email: b.email,
    clusterId: b.clusterId,
  });
  if (!checked.ok) {
    return apiBadRequest(checked.reason, { field: checked.field });
  }
  const { url, message, email, clusterId } = checked.value;

  // Fleet-wide DB throttle (migration 118): 5 accepted submissions/hour per
  // client across every instance. It runs only after the honeypot and all
  // validation, so a bot or a malformed body never spends a DB round-trip,
  // and it fails OPEN (a throttle outage never blocks a reader's correction).
  // Same 429 shape as the in-memory limiter above.
  const throttle = await checkDbThrottle({
    ...THROTTLE_POLICY.corrections,
    clientKey: key,
  });
  if (!throttle.allowed) {
    return apiTooManyRequests(throttle.retryAfterSeconds * 1000);
  }

  const supabase = createServerClient();
  const insertRow = (clusterId: string | null) =>
    supabase.from("corrections").insert({
      url,
      message,
      email,
      cluster_id: clusterId,
    });

  let { error } = await insertRow(clusterId);

  // A well-formed but unknown `?cluster=` id (a cluster deleted or merged
  // away, or one that never existed) violates corrections.cluster_id's
  // foreign key (SQLSTATE 23503). The reader's report is still worth keeping,
  // so retry exactly once without the cluster link instead of turning every
  // such submission into a 500. The log line is fixed text: nothing from the
  // submission (message, email, url, id) goes into it. The throttle above
  // already ran once; the retry does not spend a second token.
  if (error?.code === "23503" && clusterId !== null) {
    console.warn("[corrections] unknown clusterId; stored without a cluster link");
    ({ error } = await insertRow(null));
  }

  if (error) {
    return apiServerError(error);
  }

  return NextResponse.json({ ok: true }, { status: 201 });
});

// Every method this route does not serve gets the JSON 405 with `Allow` (RFC 9110
// 15.5.6) instead of Next's bodyless default, and OPTIONS is explicit: without it
// Next's automatic OPTIONS would advertise the refused methods too. HEAD derives
// from GET. The refusals read no request state and open no connection, so the
// POST keeps its own (dynamic) rendering.
const refuse = async () => apiMethodNotAllowed(ALLOW_POST_ONLY);
export const GET = refuse; // HEAD derives from GET
export const PUT = refuse;
export const PATCH = refuse;
export const DELETE = refuse;

export function OPTIONS(): Response {
  return apiOptionsAllow(ALLOW_POST_ONLY);
}
