// The thin-source rule, shared by /sitemaps/sources.xml (src/lib/seo/sitemaps.ts)
// and the /source/[slug] page metadata (src/app/source/[slug]/page.tsx), the
// same way hub-sitemap.ts shares the thin-hub rule with the /gundem/<key> page:
// a sitemap must never submit a URL the page itself asks crawlers to skip.
//
// A source that delivered no article in the last THIN_SOURCE_WINDOW_DAYS days
// renders "son 7 günde 0 haber" and nothing a searcher wants, so its page is
// `noindex, follow` and it is left out of sources.xml. (2026-11-02: 30 of 118
// active sources were in that state.) The page keeps its link to /sources, and
// the first fresh article flips it back to indexable within the profile
// cache's lifetime, no deploy.
//
// ZERO IMPORTS and a pure function of its argument: no clock, no I/O. The
// callers own the 7-day count (a head/exact count on the page, a one-row
// existence probe in the sitemap).

/** Articles needed inside the window for a source page to be indexable. */
export const THIN_SOURCE_MIN = 1;

/** The look-back window, in days, both callers count articles over. */
export const THIN_SOURCE_WINDOW_DAYS = 7;

/** True when the source has too few recent articles to deserve an index slot.
 *  Fails closed: NaN, Infinity and negative counts are thin, so a malformed
 *  count can never put an empty page into the sitemap. */
export function isThinSource(articleCount7d: number): boolean {
  return !(Number.isFinite(articleCount7d) && articleCount7d >= THIN_SOURCE_MIN);
}
