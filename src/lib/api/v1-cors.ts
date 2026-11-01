// The /api/v1 CORS + cache contract for responses built where the caller's tier
// is unknown AND src/lib/api/keys.ts cannot be imported: the Edge middleware
// (keys.ts reaches the Supabase client and node:crypto, neither of which belong
// in the Edge bundle). ZERO IMPORTS, on purpose.
//
// This is apiV1Headers(tier) from keys.ts minus `X-Tayf-Tier` (a malformed URL
// never reached key resolution, so no tier exists to report). It is a copy:
// tests/app/middleware-bad-encoding.test.ts pins
//   { ...API_V1_ERROR_HEADERS, "X-Tayf-Tier": "free" } toEqual apiV1Headers("free")
// so an edit to one without the other fails the build.
export const API_V1_ERROR_HEADERS: Readonly<Record<string, string>> = {
  "Cache-Control": "private, no-store",
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  "Access-Control-Expose-Headers": "X-Tayf-Tier, Retry-After",
  "Vary": "Origin, Authorization",
};
