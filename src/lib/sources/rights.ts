// BL-13 rights gate helpers, shared image/excerpt reuse checks.
//
// `image_allowed` / `excerpt_allowed` are optional booleans on `sources`
// (`Source` in @/types). The column is `NOT NULL DEFAULT true` in Postgres,
// but callers that select a narrower row shape (or a fixture in a test)
// may see `undefined` or `null` — both must read as "allowed", same as a
// literal `true`. Only an explicit `false` withdraws the right. This
// mirrors the `!== false` checks already used at
// src/lib/clusters/cluster-detail-query.ts:135,
// src/lib/clusters/summary-attribution.ts:69 and
// src/lib/clusters/politics-query.ts:585.

/**
 * Whether an article's cover image may be shown, given its source's
 * `image_allowed` flag. `undefined`/`null` (not withdrawn) and `true` are
 * eligible; only an explicit `false` is not. A null/missing `image_url`
 * is never eligible regardless of the flag — there's nothing to show.
 */
export function articleImageEligible<A extends { image_url: string | null }>(
  article: A,
  source: { image_allowed?: boolean | null },
): article is A & { image_url: string } {
  return Boolean(article.image_url) && source.image_allowed !== false;
}

/**
 * Whether an article's description/excerpt may be shown, given its
 * source's `excerpt_allowed` flag. `undefined`/`null` and `true` are
 * eligible; only an explicit `false` is not. A null/missing `description`
 * is never eligible regardless of the flag — there's nothing to show.
 */
export function articleExcerptEligible<A extends { description: string | null }>(
  article: A,
  source: { excerpt_allowed?: boolean | null },
): article is A & { description: string } {
  return Boolean(article.description) && source.excerpt_allowed !== false;
}
