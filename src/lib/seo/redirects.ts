// Site-wide permanent redirects, applied by next.config.ts `redirects()`.
// ZERO imports on purpose: next.config.ts loads this file by relative path and
// the config loader cannot resolve the '@/' alias or transpile app code.
// /status was the English name of the public pipeline-status page; the page
// lives at /durum (src/app/durum). Keep sources out of the middleware matcher:
// config redirects run before middleware (src/lib/seo/redirects.test.ts).
export const SITE_REDIRECTS = [
  { source: "/status", destination: "/durum", permanent: true },
] as const;
