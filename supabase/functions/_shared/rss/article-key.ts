// supabase/functions/_shared/rss/article-key.ts
//
// The "source article key": the numeric id an outlet's CMS puts in an article
// URL. A headline edit changes the URL slug but keeps that id, so two URLs of
// the SAME source with the SAME key are one article. Ingest stores the key in
// `articles.source_article_key` (migration 113) and drops a re-polled item
// whose key is already stored under a different URL, instead of inserting a
// second row for the same article (the url-keyed upsert and the content-hash
// check both miss it, because the url and the title changed).
//
// Pure, no imports: Deno- and vitest-importable. The SQL twin is
// public.source_article_key(text) in migration 113; every regex below is the
// JS `.source` that migration copies verbatim, and
// tests/migrations/113-source-article-key.test.ts fails the build on drift.
// The shared truth table is tests/fixtures/source-article-key-cases.ts.

/** Skips the scheme and authority and captures the path (query and fragment
 * never reach it). A regex rather than `new URL` so the SQL twin can run the
 * exact same expression. A relative or unparseable url does not match. */
export const URL_PATH_RE = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*([^?#]*)/;

/** A file extension on the last path segment (`...-1234567.html`). */
export const KEY_FILE_EXT_RE = /\.(s?html?|php|aspx?)$/i;

/** A run that starts like a calendar date (1900-2099, valid month and day):
 * `20261023`, `2026102315`, `202610231530`, `20261023153000`. */
export const KEY_DATE_PREFIX_RE =
  /^(19|20)[0-9]{2}(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])/;

/** A round number: one or two significant digits and at least four zeros
 * (`100000`, `250000`, `1000000`). Headlines quote these as quantities
 * ("over 100,000 customers"), and a slug-only outlet's URL carries them as
 * plain digits, so two unrelated stories share a "key". A real CMS id is
 * round about once in ten thousand; ignoring it only costs a missed dedupe
 * (the behaviour before the key existed), while a false match drops a real
 * article. */
export const KEY_ROUND_RE = /^[1-9][0-9]?0{4,}$/;

/** Shorter runs are ordinals and years ("50", "2026"), not ids. */
export const KEY_MIN_DIGITS = 6;
/** Longer runs are phone numbers, hashes and tracking ids. */
export const KEY_MAX_DIGITS = 20;

// Run lengths a date-shaped number can have: yyyymmdd and the same plus
// hh, hhmm, hhmmss.
const DATE_RUN_LENGTHS: ReadonlySet<number> = new Set([8, 10, 12, 14]);

/**
 * Sources whose URLs carry numbers but (almost) no article id (slug-only
 * outlets). For these the digit run is part of the headline ("...-421000-jobs-
 * ..."), and a key would merge two unrelated stories. Evidence (read-only
 * replays over prod on 2026-10-23, see the header of migration 113):
 *   - daily-sabah: the 7-day replay merged two stories on "500000";
 *   - a-news: the 30-day replay found 3 false groups (100000 x3, 250000 x2,
 *     300000 x2; two of the 100000 stories were 4.6 days apart, inside
 *     TWIN_WINDOW_MS). Only 18 of its 2,249 urls in 30 days carry a key at
 *     all: 13 are slug numbers and 5 an epoch-like 10-digit suffix that no
 *     twin ever shared.
 * The round-number guard (KEY_ROUND_RE) covers the common case for outlets not
 * on this list yet. The backfill in migration 113 carries the same list,
 * parity-tested.
 */
export const ARTICLE_KEY_EXCLUDED_SLUGS: readonly string[] = ["a-news", "daily-sabah"];

const EXCLUDED: ReadonlySet<string> = new Set(ARTICLE_KEY_EXCLUDED_SLUGS);

/**
 * Returns the article key of `url`, or null when the url has none.
 *
 *   1. Match URL_PATH_RE; no match (relative url, no scheme, not a string)
 *      returns null.
 *   2. Strip trailing slashes, take the LAST path segment, strip a file
 *      extension (KEY_FILE_EXT_RE).
 *   3. Collect every maximal run of digits in that segment and keep the runs
 *      of KEY_MIN_DIGITS..KEY_MAX_DIGITS digits that are neither date-shaped
 *      (a run of 8, 10, 12 or 14 digits that matches KEY_DATE_PREFIX_RE) nor
 *      round (KEY_ROUND_RE).
 *   4. Return the LAST kept run, as written, or null.
 *
 * Only the last segment counts. An id in a parent segment
 * (/kategori/123456/slug) is a section or category id: keying on it would
 * merge every story of that section into one article.
 */
export function sourceArticleKey(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const m = URL_PATH_RE.exec(url);
  if (!m) return null;
  // Trailing slashes off by hand, not with /\/+$/: on a long run of slashes
  // that regex is quadratic, and the url comes from an untrusted feed.
  const raw = m[1] ?? "";
  let end = raw.length;
  while (end > 0 && raw.charCodeAt(end - 1) === 47) end--;
  const path = raw.slice(0, end);
  const segment = path
    .slice(path.lastIndexOf("/") + 1)
    .replace(KEY_FILE_EXT_RE, "");

  let key: string | null = null;
  for (const run of segment.match(/[0-9]+/g) ?? []) {
    if (run.length < KEY_MIN_DIGITS || run.length > KEY_MAX_DIGITS) continue;
    if (DATE_RUN_LENGTHS.has(run.length) && KEY_DATE_PREFIX_RE.test(run)) continue;
    if (KEY_ROUND_RE.test(run)) continue;
    key = run;
  }
  return key;
}

/**
 * `sourceArticleKey` for a row of a given source: null for the sources in
 * ARTICLE_KEY_EXCLUDED_SLUGS, whose digit runs are not article ids.
 */
export function sourceArticleKeyFor(
  slug: string,
  url: string | null | undefined,
): string | null {
  if (EXCLUDED.has(slug)) return null;
  return sourceArticleKey(url);
}
