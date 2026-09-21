// supabase/functions/_shared/jev-client.ts
//
// Raw-fetch gateway client for the Jev LIVE marginal-verification path
// (migration 064, cluster-consumer P3). No `npm:ai` import -- the
// `@vercel/oidc --allow-sys` cold-start trap jev-shadow/index.ts's
// fetchOnce already avoids, which this module mirrors on the header block
// (only the User-Agent differs: "tayf-jev-live/1" vs. "tayf-jev-shadow/1").
//
// SECURITY, NON-NEGOTIABLE: this module never calls any `console` method
// (no log/warn/error/etc. calls at all), and never puts the API key, the
// `Authorization` header, or the raw gateway response text/JSON into a
// thrown Error, a return value, or anywhere else observable. The
// gateway's error body (a 401 embeds an API-key-creation
// URL; a 400 echoes request paths) is read ONLY to pattern-match a
// rate-limit response -- its text is never returned, thrown, or stored.
// Every error this module manufactures itself is one of exactly two
// static strings: "gateway-error" (new Error) and "gateway rate limited"
// (JevRateLimitError). The one exception is a network-level failure
// (AbortSignal.timeout firing, DNS/connect failure): that error is
// re-thrown UNCHANGED so the caller can tell a timeout apart from other
// failures by `err.name` ("TimeoutError" / "AbortError") -- the runtime's
// own abort exception never contains the key or a response body, so
// propagating it verbatim does not violate the rule above.
import {
  JEV_ENDPOINT,
  JEV_MODEL,
  JEV_PROTOCOL_VERSION,
  JEV_SPEC_VERSION,
  JevRateLimitError,
  isRateLimitStatus,
  parseJevResponse,
  retryDelayMs,
  type JevRequest,
  type JevResponse,
} from "./jev.ts";

export interface JevClientOptions {
  timeoutMs: number;
  maxRetries?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 429, or a response body that pattern-matches a rate-limit message -- same rule as jev-shadow/index.ts's looksRateLimited. */
function looksRateLimited(status: number, text: string): boolean {
  return isRateLimitStatus(status) || /rate.?limit|too many/i.test(text);
}

/**
 * POSTs one Jev evaluation request to the gateway.
 *
 * - `opts.timeoutMs` bounds each individual attempt via
 *   `AbortSignal.timeout`.
 * - `opts.maxRetries` (default 0) bounds retries of a transient network
 *   failure or a 5xx; the live cluster-consumer path always passes 0, so
 *   in production this is a single best-effort attempt.
 * - 200 -> `{ response: parseJevResponse(json), latencyMs }`.
 * - 429, or a body that looks rate-limited -> throws
 *   `JevRateLimitError("gateway rate limited")`.
 * - any other non-200 status -> throws `new Error("gateway-error")`.
 * - a fetch-level failure (network error, or the timeout firing) is
 *   re-thrown as-is once retries are exhausted, so the caller can inspect
 *   `err.name`.
 */
export async function evaluateJev(
  apiKey: string,
  request: JevRequest,
  opts: JevClientOptions,
): Promise<{ response: JevResponse; latencyMs: number }> {
  const maxRetries = opts.maxRetries ?? 0;
  let attempt = 0;

  for (;;) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(JEV_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
          "ai-gateway-protocol-version": JEV_PROTOCOL_VERSION,
          "ai-gateway-auth-method": "api-key",
          "ai-evaluation-model-specification-version": JEV_SPEC_VERSION,
          "ai-model-id": JEV_MODEL,
          "User-Agent": "tayf-jev-live/1",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (err) {
      if (attempt >= maxRetries) {
        throw err;
      }
      await sleep(retryDelayMs(attempt));
      attempt++;
      continue;
    }

    const latencyMs = Date.now() - started;
    const text = await res.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (res.status === 200) {
      return { response: parseJevResponse(json), latencyMs };
    }
    if (looksRateLimited(res.status, text)) {
      throw new JevRateLimitError("gateway rate limited");
    }
    if (res.status >= 500 && attempt < maxRetries) {
      await sleep(retryDelayMs(attempt));
      attempt++;
      continue;
    }
    throw new Error("gateway-error");
  }
}
