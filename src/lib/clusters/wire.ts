// Wire-redistribution detection: is this cluster N independent reports, or
// one AA/DHA/İHA dispatch reprinted by N outlets? Shared by the ranked home
// feed (politics-query.ts) and the cluster detail layer so every surface
// that prints a source count can print the honest one.


/**
 * Threshold for wire-collapse: when the ratio
 * `distinct_content_hashes / total_members` is at or below this value,
 * the cluster is treated as a wire redistribution. 0.5 means "at least
 * half of the articles are byte-identical copies of one wire dispatch".
 *
 * Picked at 0.5 (not 0.8 as the mission brief originally proposed)
 * because the brief's worked example reads: "≥80% of members share the
 * same content_hash" — that condition is equivalent to
 * `distinct_hashes / total ≤ ~0.2` for a single dominant hash, but a
 * straightforward "<50% unique" rule (matching the implementation
 * sketch) catches the more common 3-of-5 / 4-of-7 wire patterns A5
 * found in the blindspot audit (`b9e4047c`, `536cb1d4`, `9f8704b0`).
 */
export const WIRE_UNIQUE_HASH_RATIO = 0.5;

export interface WireDetectionResult {
  isWire: boolean;
  uniqueHashes: number;
}

/**
 * Detect whether a cluster is a wire redistribution rather than a true
 * multi-source story. Returns the unique-hash count alongside the flag
 * so the caller can use it as the cluster's `effectiveArticleCount` for
 * ranking (i.e. an AA wire reprinted by 5 outlets contributes a single
 * effective source to the importance score).
 *
 * NULL `content_hash` is treated as a UNIQUE pseudo-hash (each null gets
 * its own bucket via the article id) to avoid mis-flagging legacy
 * clusters whose articles predate the hash field. Without this guard,
 * any old cluster with several null hashes would collapse to 1 hash and
 * be marked wire — exactly the false positive R2 is supposed to avoid.
 *
 * Clusters with fewer than 3 members are never marked wire: 2 articles
 * with the same hash is more likely a same-source double-publish than a
 * wire redistribution and is already handled by the same-source dedupe
 * pass above.
 */
export function detectWireRedistribution(
  members: Array<{ id: string; content_hash: string | null }>
): WireDetectionResult {
  if (members.length < 3) {
    return { isWire: false, uniqueHashes: members.length };
  }
  const hashes = new Set<string>();
  for (const m of members) {
    // Treat NULL as unique-per-article so legacy rows aren't collapsed.
    hashes.add(m.content_hash ?? `__null__:${m.id}`);
  }
  const uniqueHashes = hashes.size;
  const isWire = uniqueHashes / members.length <= WIRE_UNIQUE_HASH_RATIO;
  return { isWire, uniqueHashes };
}

export interface WireSignal {
  isWireRedistribution: boolean;
  // Distinct dispatches when wire, otherwise the member count — the number
  // an honest "N kaynak" should show.
  effectiveArticleCount: number;
  memberCount: number;
  // Honest source count v2: how many distinct headlines/dispatches this
  // cluster actually contains once same-headline sources are folded
  // together (see countIndependentHeadlines below). OPTIONAL on purpose:
  // several other test suites (kart, summary-attribution, markdown,
  // yelpaze, opengraph tests) build WireSignal literals directly, and a
  // required field would break tsc there. wireSignalOf itself always sets
  // it when members carry a `title`.
  independentHeadlineCount?: number;
}

/**
 * Same-headline detection thresholds (§3(a) "honest source count v2").
 * A folded headline only counts as a real signal once it's long/specific
 * enough that two independent outlets landing on the exact same wording is
 * itself informative — short factual headlines ("Son dakika: deprem") are
 * expected to collide by chance and must not be treated as copies.
 */
export const SAME_HEADLINE_MIN_CHARS = 25;
export const SAME_HEADLINE_MIN_TOKENS = 4;

// Apostrophe/quote variants to strip before comparing headlines — Turkish
// possessive suffixes (Erdoğan'ın / Erdoğan’ın) must fold to the same key
// regardless of which apostrophe glyph the source's CMS emitted.
const QUOTE_CHARS = /['’‘`´"“”«»]/g;

// Non-letter/non-digit runs (punctuation, whitespace) collapse to a single
// space. \p{L}/\p{N} with the Unicode flag covers Turkish letters (ığüşöç,
// İ/I) correctly, unlike a plain [a-z0-9] class.
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;

const LEADING_PREFIX = /^(son dakika|flaş|flas)\s+/;

/**
 * Fold a headline into a comparison key, or `null` when the title is too
 * short/generic to safely treat a match as a copy (see the thresholds
 * above). Order matters: NFKC normalize → locale-aware lowercase (Turkish
 * İ/ı casing — plain `toLowerCase()` turns İ into "i" + a combining dot and
 * would split what should be one key) → strip quotes/apostrophes →
 * collapse punctuation → strip a leading "son dakika:"/"flaş " prefix →
 * length-gate.
 */
export function headlineKey(title: string): string | null {
  let key = title.normalize("NFKC").toLocaleLowerCase("tr");
  key = key.replace(QUOTE_CHARS, "");
  key = key.replace(NON_WORD_RUN, " ").trim();
  key = key.replace(LEADING_PREFIX, "");
  key = key.trim();
  if (key.length === 0) return null;
  const tokenCount = key.split(" ").filter(Boolean).length;
  if (key.length < SAME_HEADLINE_MIN_CHARS && tokenCount < SAME_HEADLINE_MIN_TOKENS) {
    return null;
  }
  return key;
}

/**
 * Count independent headlines/dispatches in a cluster via union-find:
 * members sharing a non-null `content_hash` are unioned (the existing
 * wire signal), and members sharing a non-null `headlineKey(title)` are
 * ALSO unioned (the new same-headline signal this function adds). Null
 * hashes and unqualified/null titles never union anything — each such
 * member stays its own component, mirroring detectWireRedistribution's
 * "null is unique" rule.
 */
export function countIndependentHeadlines(
  members: Array<{ id: string; content_hash: string | null; title?: string | null }>,
): number {
  const n = members.length;
  if (n === 0) return 0;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }

  const byHash = new Map<string, number>();
  const byHeadline = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const m = members[i]!;
    if (m.content_hash != null) {
      const prev = byHash.get(m.content_hash);
      if (prev !== undefined) union(prev, i);
      else byHash.set(m.content_hash, i);
    }
    const title = m.title;
    if (title != null) {
      const key = headlineKey(title);
      if (key !== null) {
        const prev = byHeadline.get(key);
        if (prev !== undefined) union(prev, i);
        else byHeadline.set(key, i);
      }
    }
  }

  const roots = new Set<number>();
  for (let i = 0; i < n; i++) roots.add(find(i));
  return roots.size;
}

export function wireSignalOf(
  members: Array<{ id: string; content_hash: string | null; title?: string | null }>,
): WireSignal {
  const { isWire, uniqueHashes } = detectWireRedistribution(members);
  return {
    isWireRedistribution: isWire,
    effectiveArticleCount: isWire ? uniqueHashes : members.length,
    memberCount: members.length,
    independentHeadlineCount: countIndependentHeadlines(members),
  };
}
