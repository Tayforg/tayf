import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { siteUrl } from "@/lib/site-url";

/**
 * Webhook signing for `/api/cron/alerts-webhooks`.
 *
 * The signature is `sha256=` plus the hex HMAC-SHA256, keyed with the
 * webhook secret, of the timestamp (decimal seconds), a full stop, and the
 * exact request body bytes. Receivers recompute it over the raw body and
 * compare in constant time; the timestamp lets them reject replays.
 */

export const WEBHOOK_SECRET_RE = /^whsec_[0-9a-f]{64}$/;
/** Receivers must refuse signatures whose timestamp is further than this from their clock. */
export const WEBHOOK_REPLAY_WINDOW_SEC = 300;
export const WEBHOOK_EVENT = "tayf.alert";

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(32).toString("hex")}`;
}

export function signWebhook(secret: string, timestampSec: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestampSec}.${body}`).digest("hex");
  return `sha256=${mac}`;
}

export function verifyWebhookSignature(
  secret: string,
  timestampSec: number,
  body: string,
  signature: string,
  nowSec: number = Math.floor(Date.now() / 1000),
): boolean {
  if (!Number.isFinite(timestampSec) || Math.abs(nowSec - timestampSec) > WEBHOOK_REPLAY_WINDOW_SEC) {
    return false;
  }
  if (typeof signature !== "string" || signature.length === 0) return false;
  const expected = Buffer.from(signWebhook(secret, timestampSec, body), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

export function buildWebhookHeaders(input: {
  secret: string;
  deliveryId: number | string;
  timestampSec: number;
  body: string;
  event?: string;
}): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": `TayfWebhook/1 (+${siteUrl()}/gelistirici)`,
    "X-Tayf-Event": input.event ?? WEBHOOK_EVENT,
    "X-Tayf-Delivery": String(input.deliveryId),
    "X-Tayf-Timestamp": String(input.timestampSec),
    "X-Tayf-Signature": signWebhook(input.secret, input.timestampSec, input.body),
  };
}
