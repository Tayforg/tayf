import { NextResponse } from "next/server";

import { assertPublicHost, validateWebhookUrlSyntax } from "@/lib/alerts/webhook-url";
import { generateWebhookSecret } from "@/lib/alerts/webhook-sign";
import { hasAdminSession } from "@/lib/admin/session";
import {
  apiBadRequest,
  apiError,
  apiNotFound,
  apiServerError,
  apiUnauthorized,
  withApiErrors,
} from "@/lib/api/errors";
import { clientKey, createRateLimiter } from "@/lib/rate-limit";
import { createServerClient } from "@/lib/supabase/server";

/**
 * POST   /api/admin/api-keys/webhook  { keyId, url }  register or replace
 * DELETE /api/admin/api-keys/webhook  { keyId }       remove
 *
 * hasAdminSession() runs FIRST (before the limiter and before the body is
 * read), as in the sibling api-keys routes. A registration validates the URL
 * (syntax, then DNS: every resolved address must be public), requires a live
 * key, and stores a NEW signing secret. The secret is returned in this 200
 * and nowhere else, ever: no reader selects it, and nothing here logs it or
 * the URL path. Failure bodies are generic and never say which URL rule
 * failed.
 */
const adminApiKeysLimit = createRateLimiter("admin-api-keys", {
  capacity: 20,
  refillPerSecond: 0.2,
});

const NO_STORE = { "Cache-Control": "private, no-store" };

async function readBody(request: Request): Promise<Record<string, unknown> | Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return apiBadRequest("Invalid JSON body");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return apiBadRequest("Invalid request body");
  }
  return body as Record<string, unknown>;
}

function parseKeyId(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;
}

async function gate(request: Request): Promise<Response | null> {
  if (!(await hasAdminSession())) return apiUnauthorized();
  const rl = adminApiKeysLimit(clientKey(request));
  if (!rl.allowed) {
    return apiError(429, "Too many requests", { details: { retryAfterMs: rl.retryAfterMs } });
  }
  return null;
}

export const POST = withApiErrors(async (request: Request) => {
  const refused = await gate(request);
  if (refused) return refused;

  const body = await readBody(request);
  if (body instanceof Response) return body;

  const keyId = parseKeyId(body.keyId);
  if (keyId === null) return apiBadRequest("Invalid keyId");

  const rawUrl = body.url;
  if (typeof rawUrl !== "string") return apiBadRequest("Invalid webhook URL");
  const syntax = validateWebhookUrlSyntax(rawUrl);
  if (!syntax.ok) return apiBadRequest("Invalid webhook URL");
  try {
    await assertPublicHost(syntax.host);
  } catch {
    return apiBadRequest("Invalid webhook URL");
  }

  const supabase = createServerClient();
  const { data: key, error: keyError } = await supabase
    .from("api_keys")
    .select("id")
    .eq("id", keyId)
    .is("revoked_at", null)
    .maybeSingle();
  if (keyError) return apiServerError(keyError);
  if (!key) return apiNotFound("API key not found");

  const secret = generateWebhookSecret();
  const { error } = await supabase.from("api_key_webhooks").upsert(
    {
      key_id: keyId,
      url: syntax.url.toString(),
      secret,
      enabled: true,
      fail_streak: 0,
      disabled_reason: null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "key_id" },
  );
  if (error) return apiServerError(error);

  return NextResponse.json(
    { ok: true, key_id: keyId, host: syntax.host, secret },
    { status: 200, headers: NO_STORE },
  );
});

export const DELETE = withApiErrors(async (request: Request) => {
  const refused = await gate(request);
  if (refused) return refused;

  const body = await readBody(request);
  if (body instanceof Response) return body;

  const keyId = parseKeyId(body.keyId);
  if (keyId === null) return apiBadRequest("Invalid keyId");

  const supabase = createServerClient();
  const { error } = await supabase.from("api_key_webhooks").delete().eq("key_id", keyId);
  if (error) return apiServerError(error);

  // Unsent queue rows must not survive to be delivered to a later, different
  // URL registered for the same key.
  const { error: queueError } = await supabase
    .from("api_key_webhook_deliveries")
    .delete()
    .eq("key_id", keyId)
    .in("status", ["pending", "sending"]);
  if (queueError) return apiServerError(queueError);

  return NextResponse.json({ ok: true, key_id: keyId }, { status: 200, headers: NO_STORE });
});
