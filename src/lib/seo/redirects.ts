// Site-wide permanent redirects, applied by next.config.ts `redirects()`.
// ZERO imports on purpose: next.config.ts loads this file by relative path and
// the config loader cannot resolve the '@/' alias or transpile app code.
// /status was the English name of the public pipeline-status page; the page
// lives at /durum (src/app/durum).
// /kaynaklar has no page of its own (it was a 404): the source directory lives
// at /sources, whose title is literally "Kaynaklar" and which the footer and
// llms.txt point at. Only the exact path redirects; /kaynaklar/durum is the
// separate feed-health page and stays a 200 (src/app/kaynaklar/durum), which
// is why entries use plain literals, never a ':path*' pattern.
// Keep sources out of the middleware matcher: config redirects run before
// middleware (src/lib/seo/redirects.test.ts).
export const SITE_REDIRECTS = [
  { source: "/status", destination: "/durum", permanent: true },
  { source: "/kaynaklar", destination: "/sources", permanent: true },
] as const;
