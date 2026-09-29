import { createHmac } from "node:crypto";
import { describe, it, expect } from "vitest";

import {
  buildWebhookHeaders,
  generateWebhookSecret,
  signWebhook,
  verifyWebhookSignature,
  WEBHOOK_REPLAY_WINDOW_SEC,
} from "@/lib/alerts/webhook-sign";

const SECRET = "whsec_" + "ab".repeat(32);

describe("generateWebhookSecret", () => {
  it("is whsec_ plus 64 hex chars and differs per call", () => {
    const a = generateWebhookSecret();
    expect(a).toMatch(/^whsec_[0-9a-f]{64}$/);
    expect(generateWebhookSecret()).not.toBe(a);
  });
});

describe("signWebhook", () => {
  it("equals a hand-computed HMAC-SHA256 of 'timestamp.body'", () => {
    const body = '{"event":"tayf.alert"}';
    const expected =
      "sha256=" + createHmac("sha256", SECRET).update("1700000000." + body).digest("hex");
    expect(signWebhook(SECRET, 1700000000, body)).toBe(expected);
  });

  it("changes with the timestamp", () => {
    expect(signWebhook(SECRET, 1, "x")).not.toBe(signWebhook(SECRET, 2, "x"));
  });
});

describe("verifyWebhookSignature", () => {
  const body = '{"a":1}';
  const sig = signWebhook(SECRET, 1700000000, body);

  it("accepts the genuine signature", () => {
    expect(verifyWebhookSignature(SECRET, 1700000000, body, sig, 1700000000)).toBe(true);
  });

  it("enforces a 5 minute replay window on the timestamp (both directions)", () => {
    expect(WEBHOOK_REPLAY_WINDOW_SEC).toBe(300);
    const t = 1700000000;
    expect(verifyWebhookSignature(SECRET, t, body, sig, t + 300)).toBe(true);
    expect(verifyWebhookSignature(SECRET, t, body, sig, t + 301)).toBe(false);
    expect(verifyWebhookSignature(SECRET, t, body, sig, t - 300)).toBe(true);
    expect(verifyWebhookSignature(SECRET, t, body, sig, t - 301)).toBe(false);
  });

  it("uses the current clock by default, so an old genuine signature is refused", () => {
    expect(verifyWebhookSignature(SECRET, 1700000000, body, sig)).toBe(false);
    const now = Math.floor(Date.now() / 1000);
    expect(verifyWebhookSignature(SECRET, now, body, signWebhook(SECRET, now, body))).toBe(true);
  });

  it("refuses a non-finite timestamp", () => {
    expect(verifyWebhookSignature(SECRET, Number.NaN, body, sig, 1700000000)).toBe(false);
  });

  it("rejects a tampered body, timestamp, secret and garbage", () => {
    expect(verifyWebhookSignature(SECRET, 1700000000, '{"a":2}', sig, 1700000000)).toBe(false);
    expect(verifyWebhookSignature(SECRET, 1700000001, body, sig, 1700000000)).toBe(false);
    expect(verifyWebhookSignature("whsec_" + "cd".repeat(32), 1700000000, body, sig, 1700000000)).toBe(false);
    expect(verifyWebhookSignature(SECRET, 1700000000, body, "sha256=00", 1700000000)).toBe(false);
    expect(verifyWebhookSignature(SECRET, 1700000000, body, "", 1700000000)).toBe(false);
  });
});

describe("buildWebhookHeaders", () => {
  it("carries the contract headers and a verifiable signature", () => {
    const h = buildWebhookHeaders({
      secret: SECRET,
      deliveryId: 42,
      timestampSec: 1700000000,
      body: '{"a":1}',
    });
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["User-Agent"]).toMatch(/^TayfWebhook\/1 \(\+https?:\/\/.+\/gelistirici\)$/);
    expect(h["X-Tayf-Event"]).toBe("tayf.alert");
    expect(h["X-Tayf-Delivery"]).toBe("42");
    expect(h["X-Tayf-Timestamp"]).toBe("1700000000");
    expect(verifyWebhookSignature(SECRET, 1700000000, '{"a":1}', h["X-Tayf-Signature"]!, 1700000000)).toBe(true);
    expect(JSON.stringify(h)).not.toContain(SECRET);
  });
});
