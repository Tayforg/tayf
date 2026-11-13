// Wire-redistribution detection: is this cluster N independent reports, or
// one AA/DHA/İHA dispatch reprinted by N outlets? Shared by the ranked home
// feed (politics-query.ts) and the cluster detail layer so every surface
// that prints a source count can print the honest one.
//
// Two members are "one text" when they share a content_hash OR the same
// agency lead (a folded description of at least SAME_DESCRIPTION_MIN_CHARS
// characters). The hash covers title + body, so an outlet that rewords the
// headline over the same AA lead gets a distinct hash; the description is the
// part it did not rewrite (h138-roadmap2-1). The description is a SERVER-SIDE
// input only: no bundle or prop built from it carries it to the client.


/**
 * Threshold for wire-collapse: when the ratio
 * `distinct_texts / total_members` is at or below this value, the cluster is
 * treated as a wire redistribution. A distinct text is a group of members
 * linked by the same content_hash or the same agency lead (see
 * `detectWireRedistribution`); before h138-roadmap2-1 it was the distinct
 * content_hash count alone. 0.5 means "at least half of the articles repeat
 * another member's text".
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

/**
 * The smallest cluster that can be a wire redistribution. Below this many members
 * `detectWireRedistribution` answers `isWire: false`: 2 articles with the same
 * hash are more likely one outlet's double publish than a wire reprint, and the
 * same-source dedupe pass has already handled that case. The floor is counted
 * after the one-per-source dedupe (politics-query dedupedMembers, timeline-query
 * dedupeEarliestPerSource), so it counts distinct sources, not articles.
 * /metodoloji's "Tek kaynaktan dağıtım" card prints this number
 * (h176-methodtruth-1), so it is exported rather than written as a literal in the
 * function.
 */
export const WIRE_MIN_MEMBERS = 3;

export interface WireDetectionResult {
  isWire: boolean;
  /**
   * Number of distinct texts among the members: connected components of
   * "same content_hash OR same descriptionKey". The name predates the
   * description link; it is kept so every reader stays unchanged.
   */
  uniqueHashes: number;
}

/**
 * A description folds into a same-lead key only at this many characters: a
 * stock line like "Detaylar haberimizde" is expected to repeat across
 * independent outlets and must not link them. Real agency leads run 150 to
 * 250 characters.
 */
export const SAME_DESCRIPTION_MIN_CHARS = 40;

// Apostrophe/quote variants to strip before comparing headlines or leads —
// Turkish possessive suffixes (Erdoğan'ın / Erdoğan’ın) must fold to the same
// key regardless of which apostrophe glyph the source's CMS emitted.
const QUOTE_CHARS = /['’‘`´"“”«»]/g;

// Non-letter/non-digit runs (punctuation, whitespace) collapse to a single
// space. \p{L}/\p{N} with the Unicode flag covers Turkish letters (ığüşöç,
// İ/I) correctly, unlike a plain [a-z0-9] class. One character class under a
// single quantifier: linear time, no nested quantifiers (CodeQL js/redos).
const NON_WORD_RUN = /[^\p{L}\p{N}]+/gu;

/**
 * Fold an RSS description into a same-lead comparison key, or `null` when it
 * is missing or shorter than SAME_DESCRIPTION_MIN_CHARS after folding. The
 * fold is the one headlineKey uses (NFKC normalize → Turkish-locale lowercase,
 * so İ/ı casing does not split a key → strip quotes → collapse punctuation and
 * whitespace runs → trim) without headlineKey's "son dakika" prefix rule,
 * which is a headline convention and not a lead one. Linear in the input.
 */
export function descriptionKey(d: string | null | undefined): string | null {
  if (typeof d !== "string" || d.length === 0) return null;
  let key = d.normalize("NFKC").toLocaleLowerCase("tr");
  key = key.replace(QUOTE_CHARS, "");
  key = key.replace(NON_WORD_RUN, " ").trim();
  return key.length < SAME_DESCRIPTION_MIN_CHARS ? null : key;
}

interface UnionFind {
  find(i: number): number;
  union(a: number, b: number): void;
  /** Number of distinct components over all `n` elements. */
  componentCount(): number;
}

function makeUnionFind(n: number): UnionFind {
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]!]!;
      i = parent[i]!;
    }
    return i;
  }
  return {
    find,
    union(a, b) {
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    },
    componentCount() {
      const roots = new Set<number>();
      for (let i = 0; i < n; i++) roots.add(find(i));
      return roots.size;
    },
  };
}

/**
 * The text each member belongs to: one component root per member (index-
 * aligned with `members`), where two members share a root when they share a
 * non-null `content_hash`, or share a non-null `descriptionKey` (the same
 * agency lead under a reworded headline, which gets a different hash). Links
 * chain: A~B by hash and B~C by description is one text.
 *
 * NULL `content_hash` is treated as a UNIQUE pseudo-hash (each null gets its
 * own bucket via the article id) to avoid mis-flagging legacy clusters whose
 * articles predate the hash field. A missing, null, empty or short (<
 * SAME_DESCRIPTION_MIN_CHARS) description never links anything, so members
 * without one give exactly the hash-only result.
 *
 * The single union rule behind `detectWireRedistribution` (the text count) and
 * the summary's wire majority (summary-attribution.ts: which members hold the
 * copied dispatch), so the two cannot drift. No member-count gate here: the
 * "fewer than 3 members is never wire" rule belongs to the detection alone.
 */
export function textComponentsOf(
  members: ReadonlyArray<{ id: string; content_hash: string | null; description?: string | null }>,
): number[] {
  const uf = makeUnionFind(members.length);
  const byHash = new Map<string, number>();
  const byDescription = new Map<string, number>();
  for (let i = 0; i < members.length; i++) {
    const m = members[i]!;
    // Treat NULL as unique-per-article so legacy rows aren't collapsed.
    const hashKey = m.content_hash ?? `__null__:${m.id}`;
    const prevByHash = byHash.get(hashKey);
    if (prevByHash !== undefined) uf.union(prevByHash, i);
    else byHash.set(hashKey, i);

    const descKey = descriptionKey(m.description);
    if (descKey !== null) {
      const prevByDescription = byDescription.get(descKey);
      if (prevByDescription !== undefined) uf.union(prevByDescription, i);
      else byDescription.set(descKey, i);
    }
  }
  return members.map((_, i) => uf.find(i));
}

/**
 * Detect whether a cluster is a wire redistribution rather than a true
 * multi-source story. Returns the distinct-text count alongside the flag
 * so the caller can use it as the cluster's `effectiveArticleCount` for
 * ranking (i.e. an AA wire reprinted by 5 outlets contributes a single
 * effective source to the importance score).
 *
 * Distinct texts are the components of `textComponentsOf` (same content_hash
 * or same agency lead, chained; see there for the null-hash and short-
 * description rules).
 *
 * Clusters with fewer than WIRE_MIN_MEMBERS (3) members are never marked wire:
 * 2 articles with the same hash is more likely a same-source double-publish
 * than a wire redistribution and is already handled by the same-source dedupe
 * pass above.
 */
export function detectWireRedistribution(
  members: Array<{ id: string; content_hash: string | null; description?: string | null }>
): WireDetectionResult {
  if (members.length < WIRE_MIN_MEMBERS) {
    return { isWire: false, uniqueHashes: members.length };
  }
  const uniqueHashes = new Set(textComponentsOf(members)).size;
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
  const uf = makeUnionFind(n);

  const byHash = new Map<string, number>();
  const byHeadline = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const m = members[i]!;
    if (m.content_hash != null) {
      const prev = byHash.get(m.content_hash);
      if (prev !== undefined) uf.union(prev, i);
      else byHash.set(m.content_hash, i);
    }
    const title = m.title;
    if (title != null) {
      const key = headlineKey(title);
      if (key !== null) {
        const prev = byHeadline.get(key);
        if (prev !== undefined) uf.union(prev, i);
        else byHeadline.set(key, i);
      }
    }
  }

  return uf.componentCount();
}

export function wireSignalOf(
  members: Array<{
    id: string;
    content_hash: string | null;
    title?: string | null;
    description?: string | null;
  }>,
): WireSignal {
  const { isWire, uniqueHashes } = detectWireRedistribution(members);
  return {
    isWireRedistribution: isWire,
    effectiveArticleCount: isWire ? uniqueHashes : members.length,
    memberCount: members.length,
    independentHeadlineCount: countIndependentHeadlines(members),
  };
}

// ---------------------------------------------------------------------------
// Wire badge copy (h18-numbers-2)
// ---------------------------------------------------------------------------
//
// A wire cluster is any cluster whose distinct-text ratio is <= 0.5, which
// includes several different dispatches (6 members, 3 texts), not only one
// text reprinted N times. "Tek kaynaktan dağıtıldı" is true only for the
// latter, so every surface that prints the badge takes its words from here.
// `uniqueTexts` is the cluster's `effectiveArticleCount` (equal to the
// distinct text count for a wire cluster); `memberCount` is the
// post-dedupe member count. `uniqueTexts <= 1` (and 0 / NaN, which carry no
// evidence of several texts) keeps the single-source wording.

/** True when more than one distinct text is behind the cluster's members. */
function hasSeveralTexts(uniqueTexts: number): boolean {
  return uniqueTexts > 1;
}

/** The violet badge on the cluster page, card and RSS description. */
export function wireBadgeLabel(memberCount: number, uniqueTexts: number): string {
  return hasSeveralTexts(uniqueTexts)
    ? `Ajans ağırlıklı · ${memberCount} haber, ${uniqueTexts} farklı metin`
    : `Tek kaynaktan dağıtıldı · ${memberCount} kopya`;
}

/** The short form for the OG image pill and the share text. */
export function wireBadgeShort(memberCount: number, uniqueTexts: number): string {
  return hasSeveralTexts(uniqueTexts)
    ? `${memberCount} haber · ${uniqueTexts} farklı metin`
    : `${memberCount} kopya · tek kaynak`;
}

/**
 * The badge's `title` tooltip. The multi-text claim holds by construction: a
 * wire cluster has `uniqueTexts / members <= WIRE_UNIQUE_HASH_RATIO` (0.5), so
 * at least half of the members repeat another member's text, whether that is
 * the same content fingerprint or the same agency lead under a new headline.
 */
export function wireBadgeTitle(uniqueTexts: number): string {
  return hasSeveralTexts(uniqueTexts)
    ? "Bu kümedeki haberlerin en az yarısı, başlığı farklı olsa da başka bir haberle aynı metni paylaşıyor"
    : "Bu kümedeki haberlerin tamamı aynı ajans metninin kopyası";
}
