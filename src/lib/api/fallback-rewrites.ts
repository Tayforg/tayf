// Fallback rewrites applied by next.config.ts `rewrites()`. ZERO imports on
// purpose: next.config.ts loads this file by relative path and the config
// loader cannot resolve the '@/' alias or transpile app code.
//
// Why a rewrite and not an `src/app/api/[...slug]` catch-all: Next runs the
// `fallback` phase only after every filesystem route AND every dynamic route
// has failed to match, so this rule can never shadow a real endpoint (nor
// /api/v1/[...path], which owns its own unknown paths). A new catch-all
// directory would instead be walked by tests/guards/middleware-bad-encoding.test.ts
// and force an '/api/:path*' wildcard into the middleware matcher.
//
// '/api/:path*' also matches the bare '/api'. An unknown /api path used to get
// the site's 44 KB HTML not-found page; it now gets the canonical JSON 404 from
// src/app/api/unmatched/route.ts (code not_found).
interface FallbackRewrite {
  source: string;
  destination: string;
}

export const API_FALLBACK_REWRITES: {
  beforeFiles: FallbackRewrite[];
  afterFiles: FallbackRewrite[];
  fallback: FallbackRewrite[];
} = {
  beforeFiles: [],
  afterFiles: [],
  fallback: [{ source: "/api/:path*", destination: "/api/unmatched" }],
};
