/**
 * In-memory token-bucket rate limiter.
 *
 * Each named limiter owns a slice of the shared `buckets` map keyed by
 * `${name}:${clientKey}`. Tokens refill linearly between calls based on the
 * elapsed wall-clock time, and idle buckets are evicted by a periodic sweep
 * so a long-running process doesn't accumulate stale entries.
 *
 * NOTE: This implementation is intentionally process-local. It is fine for
 * single-instance dev / a single Node container, but a production deployment
 * with multiple instances (e.g. Vercel serverless, horizontal autoscaling)
 * would need a shared store such as Redis (`@upstash/ratelimit`) so the
 * buckets stay consistent across replicas. Swap `buckets` for a Redis-backed
 * implementation when that day comes — the `check` return shape can stay the
 * same.
 */

interface Bucket {
  tokens: number;
  lastRefill: number;
}

interface RateLimiterOptions {
  capacity: number; // max tokens per bucket
  refillPerSecond: number; // tokens added per second
  ttlMs?: number; // how long to keep an idle bucket
}

const buckets = new Map<string, Bucket>();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

export function createRateLimiter(name: string, opts: RateLimiterOptions) {
  const { capacity, refillPerSecond } = opts;

  return function check(key: string): { allowed: boolean; retryAfterMs: number } {
    const bucketKey = `${name}:${key}`;
    const now = Date.now();
    let bucket = buckets.get(bucketKey);

    if (!bucket) {
      bucket = { tokens: capacity, lastRefill: now };
      buckets.set(bucketKey, bucket);
    } else {
      // Refill based on elapsed time
      const elapsedSec = (now - bucket.lastRefill) / 1000;
      bucket.tokens = Math.min(
        capacity,
        bucket.tokens + elapsedSec * refillPerSecond
      );
      bucket.lastRefill = now;
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0 };
    }

    const tokensNeeded = 1 - bucket.tokens;
    const retryAfterMs = Math.ceil((tokensNeeded / refillPerSecond) * 1000);
    return { allowed: false, retryAfterMs };
  };
}

// Periodic cleanup of idle buckets. `unref()` keeps the timer from holding
// the Node process alive on its own (important during test runs).
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.lastRefill > DEFAULT_TTL_MS) {
      buckets.delete(key);
    }
  }
}, 60 * 1000);
if (typeof cleanupTimer.unref === "function") {
  cleanupTimer.unref();
}

const MAX_KEY_LENGTH = 100;

// Cheap shape check: IPv4, IPv6 (incl. brackets/zone id) and nothing else.
// This keeps a garbage header value from poisoning the bucket key space
// (e.g. an attacker sending a multi-KB string as x-real-ip).
function isIpish(value: string): boolean {
  return /^[0-9a-fA-F.:%[\]]{1,64}$/.test(value);
}

function normalizeIp(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!isIpish(trimmed)) return null;
  return trimmed.toLowerCase().slice(0, MAX_KEY_LENGTH);
}

/**
 * Extract a client identifier from a Request. Falls back to "anon".
 *
 * Resolution order (first non-null wins):
 *   1. `x-real-ip` — set by the Vercel edge, not client-controllable.
 *   2. `x-vercel-forwarded-for`, first entry — also platform-set.
 *   3. `x-forwarded-for`, LAST entry — the hop nearest our own edge. The
 *      leftmost entry on a generic XFF chain is whatever the client sent,
 *      so an attacker can rotate it to mint a fresh bucket per request for
 *      every limiter (admin-post, corrections-post, newsletter-post,
 *      cron-digest, cron-headline, revalidate-post, health-anon). We keep
 *      this fallback (rather than dropping XFF) because if the
 *      platform-set headers above turn out to be absent in production,
 *      removing it would collapse every client into a single "anon"
 *      bucket and 429 everyone on the two public forms.
 *   4. "anon"
 *
 * OPEN VERIFICATION ITEM: which of `x-real-ip` / `x-vercel-forwarded-for`
 * Vercel actually sets on this project has not yet been confirmed on a
 * preview deploy. Until that's checked, treat step 3 as the effective,
 * safety-net behavior — do not claim spoof-resistance in production based
 * on steps 1-2 alone.
 *
 * NOTE: this limiter is still process-local (see module docstring above);
 * durable limiting across replicas needs Upstash/Redis and is out of scope
 * here.
 */
export function clientKey(req: { headers: Pick<Headers, "get"> }): string {
  const realIp = normalizeIp(req.headers.get("x-real-ip"));
  if (realIp) return realIp;

  const vercelForwarded = req.headers.get("x-vercel-forwarded-for");
  if (vercelForwarded) {
    const first = normalizeIp(vercelForwarded.split(",")[0] ?? null);
    if (first) return first;
  }

  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",");
    const lastPart = parts.length > 0 ? parts[parts.length - 1] : undefined;
    const last = normalizeIp(lastPart ?? null);
    if (last) return last;
  }

  return "anon";
}
