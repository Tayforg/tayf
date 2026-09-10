import { describe, it, expect } from "vitest";
import { clientKey, createRateLimiter } from "./rate-limit";

function req(headers: Record<string, string>): Request {
  return new Request("http://example.com/x", { headers });
}

describe("clientKey", () => {
  it("prefers x-real-ip over x-forwarded-for", () => {
    const r = req({
      "x-real-ip": "203.0.113.5",
      "x-forwarded-for": "1.2.3.4, 203.0.113.5",
    });
    expect(clientKey(r)).toBe("203.0.113.5");
  });

  it("prefers the first x-vercel-forwarded-for entry over x-forwarded-for when x-real-ip is absent", () => {
    const r = req({
      "x-vercel-forwarded-for": "198.51.100.7, 10.0.0.1",
      "x-forwarded-for": "1.2.3.4",
    });
    expect(clientKey(r)).toBe("198.51.100.7");
  });

  it("falls back to the LAST x-forwarded-for hop", () => {
    const r = req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8, 203.0.113.9" });
    expect(clientKey(r)).toBe("203.0.113.9");
  });

  it("a rotating leftmost XFF cannot mint a new bucket", () => {
    const r1 = req({ "x-forwarded-for": "9.9.9.9, 203.0.113.9" });
    const r2 = req({ "x-forwarded-for": "7.7.7.7, 203.0.113.9" });
    expect(clientKey(r1)).toBe(clientKey(r2));
  });

  it('returns "anon" when no relevant header is present', () => {
    const r = req({});
    expect(clientKey(r)).toBe("anon");
  });

  it("skips an empty / whitespace-only x-real-ip and falls through to x-forwarded-for", () => {
    const r = req({ "x-real-ip": "   ", "x-forwarded-for": "203.0.113.9" });
    expect(clientKey(r)).toBe("203.0.113.9");
  });

  it("skips a non-IP-shaped x-real-ip and falls through to x-forwarded-for", () => {
    const r = req({ "x-real-ip": "not an ip", "x-forwarded-for": "203.0.113.9" });
    expect(clientKey(r)).toBe("203.0.113.9");
  });

  it("truncates / bounds an absurd header value so the bucket map stays memory-bounded", () => {
    const r1 = req({ "x-real-ip": "9".repeat(500) });
    expect(clientKey(r1)).toBe("anon");

    const r2 = req({ "x-real-ip": "a".repeat(70) + ":" + "b".repeat(70) });
    expect(clientKey(r2).length).toBeLessThanOrEqual(100);
  });
});

describe("createRateLimiter", () => {
  it("allows up to capacity then blocks, and tracks independent keys", () => {
    const check = createRateLimiter("test-rate-limit-w3", {
      capacity: 2,
      refillPerSecond: 0,
    });

    expect(check("alice")).toEqual({ allowed: true, retryAfterMs: 0 });
    expect(check("alice")).toEqual({ allowed: true, retryAfterMs: 0 });

    const third = check("alice");
    expect(third.allowed).toBe(false);
    expect(third.retryAfterMs).toBeGreaterThan(0);

    // Independent bucket for a different key.
    expect(check("bob")).toEqual({ allowed: true, retryAfterMs: 0 });
  });
});
