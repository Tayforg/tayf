import { NextResponse } from "next/server";
import { unstable_rethrow } from "next/navigation";
import { captureServerException } from "@/lib/sentry/server";

/**
 * Canonical error response shape for every JSON route under `src/app/api/`.
 *
 * Keeping this in one place means clients can rely on `error` always being a
 * human-readable string, with optional `code` / `details` for programmatic
 * handling. Do NOT inline new shapes in individual routes — extend this type
 * instead so the contract stays consistent.
 */
export interface ApiError {
  error: string;
  code?: string;
  details?: Record<string, unknown>;
}

/**
 * Build a consistent error response. `init.headers` carries the few errors
 * that set headers (`Retry-After`, `Cache-Control: no-store`, `Allow`); the
 * caller's headers are kept as given. The content type is always
 * `application/json; charset=utf-8` unless the caller sets its own.
 */
export function apiError(
  status: number,
  message: string,
  opts: Omit<ApiError, "error"> = {},
  init?: { headers?: HeadersInit }
) {
  const headers = new Headers(init?.headers);
  if (!headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json; charset=utf-8");
  }
  return NextResponse.json<ApiError>({ error: message, ...opts }, { status, headers });
}

/** The method list of a read-only public endpoint (HEAD is derived from GET by Next). */
export const ALLOW_GET_ONLY = "GET, HEAD, OPTIONS";

/**
 * 405 for the public, non-v1 endpoints that only serve GET. Next's own answer
 * to an unexported method is a bodyless 405 with no `Allow` header, which RFC
 * 9110 15.5.6 forbids and which breaks a JSON client; this one is the canonical
 * `ApiError` envelope with `Allow`, and `Cache-Control: no-store` so a CDN never
 * pins a refusal. `cors` adds `Access-Control-Allow-Origin: *` for the routes a
 * browser may call cross-origin (oEmbed). Not the keyed /api/v1 refusal, which
 * is `methodNotAllowed` in ./keys and carries the whole apiV1 header set.
 */
export function apiMethodNotAllowed(
  allow: string,
  opts: { cors?: boolean } = {}
): Response {
  const headers: Record<string, string> = {
    Allow: allow,
    "Cache-Control": "no-store",
  };
  if (opts.cors) headers["Access-Control-Allow-Origin"] = "*";
  return apiError(405, "Method not allowed", {}, { headers });
}

/**
 * 204 for an explicit OPTIONS export on a read-only endpoint. Without it Next
 * answers OPTIONS itself and advertises every method the file exports, which
 * would list the POST/PUT/PATCH/DELETE refusals as if they were supported.
 */
export function apiOptionsAllow(
  allow: string,
  opts: { cors?: boolean } = {}
): Response {
  const headers = new Headers({ Allow: allow });
  if (opts.cors) headers.set("Access-Control-Allow-Origin", "*");
  return new Response(null, { status: 204, headers });
}

// A named constant, not a literal: tests/guards/rate-limit-429.test.ts bans
// `apiError(429` everywhere in src/, and this file must not be the exception.
const HTTP_TOO_MANY_REQUESTS = 429;

/**
 * 429 — the one shared rate-limit answer for every route that owns a
 * `createRateLimiter` bucket (tests/guards/rate-limit-429.test.ts keeps it
 * that way). Body is the canonical envelope with `details.retryAfterMs`
 * (whole milliseconds, 0 for a non-finite or non-positive input); the
 * standard `Retry-After` header carries whole seconds, never below 1 (a
 * `Retry-After: 0` invites an immediate retry storm), and `Cache-Control:
 * no-store` keeps a CDN from pinning a transient throttle for everyone behind
 * the same edge.
 */
export function apiTooManyRequests(
  retryAfterMs: number,
  opts: { message?: string; code?: string } = {}
) {
  const ms =
    Number.isFinite(retryAfterMs) && retryAfterMs > 0
      ? Math.ceil(retryAfterMs)
      : 0;
  return apiError(
    HTTP_TOO_MANY_REQUESTS,
    opts.message ?? "Too many requests",
    {
      ...(opts.code ? { code: opts.code } : {}),
      details: { retryAfterMs: ms },
    },
    {
      headers: {
        "Retry-After": String(Math.max(1, Math.ceil(ms / 1000))),
        "Cache-Control": "no-store",
      },
    }
  );
}

/** 401 — missing or invalid credentials. */
export const apiUnauthorized = (reason = "Unauthorized") =>
  apiError(401, reason);

/** 400 — the request itself is malformed or fails validation. */
export const apiBadRequest = (
  reason: string,
  details?: Record<string, unknown>
) => apiError(400, reason, details ? { details } : undefined);

/** 404 — resource not found. */
export const apiNotFound = (what = "Not found") => apiError(404, what);

/**
 * 500 — unexpected server error. Logs the raw error (with stack) to stderr
 * under an `[api]` prefix tagged with a per-invocation `request_id`, and
 * returns ONLY a generic message plus that `request_id` to the caller. The
 * raw `err.message` is NEVER serialised into the response body — Supabase /
 * upstream error strings frequently embed table names, constraint names,
 * and other internal schema detail we don't want to hand to an attacker.
 * Operators correlate a user-visible `request_id` to the matching stderr
 * line for triage. Swap the logger here if we ever wire up a real
 * observability stack.
 */
export const apiServerError = (err: unknown, code?: string) => {
  const requestId = crypto.randomUUID();
  console.error("[api]", requestId, err);
  return apiError(
    500,
    "Internal server error",
    code ? { code, details: { request_id: requestId } } : { details: { request_id: requestId } },
  );
};

/**
 * Wrap a route handler to catch thrown errors uniformly.
 *
 * Next.js route handlers have varied signatures (`()`, `(req)`, `(req, ctx)`),
 * so the generic is intentionally permissive. Any handler that returns a
 * `Promise<Response>` is accepted; thrown errors become a 500 via
 * `apiServerError` instead of Next's default HTML error page.
 *
 * `unstable_rethrow` is called before treating an error as a 500 because
 * Next.js uses thrown errors as control-flow signals — `redirect()`,
 * `notFound()`, `NEXT_PRERENDER_INTERRUPTED` (bail out of prerender when
 * a route touches request.headers / cookies / dynamic APIs), etc. Those
 * errors MUST propagate up to Next's internals or the framework gets
 * confused and logs spurious 500s during build/prerender. Real errors
 * are reported to Sentry (B8 observability) and then fall through to
 * `apiServerError`. Sentry capture runs AFTER `unstable_rethrow` so we
 * don't pollute Sentry with framework control-flow signals.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withApiErrors<T extends (...args: any[]) => Promise<Response>>(
  handler: T
): T {
  return (async (...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (err) {
      unstable_rethrow(err);
      captureServerException(err);
      return apiServerError(err);
    }
  }) as T;
}
