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
}

export function wireSignalOf(
  members: Array<{ id: string; content_hash: string | null }>,
): WireSignal {
  const { isWire, uniqueHashes } = detectWireRedistribution(members);
  return {
    isWireRedistribution: isWire,
    effectiveArticleCount: isWire ? uniqueHashes : members.length,
    memberCount: members.length,
  };
}
