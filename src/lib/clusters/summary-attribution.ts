import type { WireSignal } from "./wire";
import type { BiasCategory } from "@/types";

// clusters.summary_tr is the seed article's raw RSS description — one
// outlet's words, not Tayf's. It must be attributed to that outlet or
// hidden entirely (blank, or a wire dispatch every member just copied).
// The seed is found by matching the stored text against member
// descriptions; first_published is min(published_at) over all members and
// moves when an older article joins late, so it is not used for attribution.

// Structural subset of ClusterDetailMember (cluster-detail-query.ts): the
// cluster page's members satisfy this shape as-is, and lighter callers
// (e.g. an RSS-only member projection) can satisfy it without fetching or
// typing the full Source/article shape the detail page needs.
export interface SummaryMember {
  source: {
    name: string;
    bias: BiasCategory;
    /**
     * BL-13 per-source rights flag (migration 047): `false` when this
     * outlet has asked Tayf not to reuse its article text. `undefined`
     * (a fixture/caller predating the column) is treated as `true`
     * (allowed) — see `matchingCandidates` below.
     */
    excerpt_allowed?: boolean;
  };
  article: {
    published_at: string;
    content_hash: string | null;
    description?: string | null;
  };
}

/**
 * Members whose article description exactly equals the summary text,
 * sorted earliest-first (ties broken by publish time). Internal helper —
 * both `findSeedMember` (rights-eligible pick) and `summaryAttribution`
 * (rights-blocked-entirely detection) need the full matching set.
 */
function matchingCandidates(
  members: SummaryMember[],
  text: string,
): SummaryMember[] {
  return members
    .filter((m) => (m.article.description ?? "").trim() === text)
    .sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime(),
    );
}

/**
 * Member whose article description equals the summary, earliest on ties;
 * null otherwise.
 *
 * BL-13 rights gate: a member whose source has `excerpt_allowed === false`
 * is skipped in favor of the next matching member — that outlet's text
 * must never be attributed or rendered as its own. `undefined` (older
 * fakes / legacy rows without the column) is treated as allowed.
 */
export function findSeedMember(
  members: SummaryMember[],
  summary: string,
): SummaryMember | null {
  const text = summary.trim();
  if (text.length === 0) return null;
  const candidates = matchingCandidates(members, text);
  return candidates.find((m) => m.source.excerpt_allowed !== false) ?? null;
}

/** Non-null content_hash counts among members — for finding the wire dispatch's hash. */
function contentHashCounts(members: SummaryMember[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of members) {
    const hash = m.article.content_hash;
    if (hash === null) continue;
    counts.set(hash, (counts.get(hash) ?? 0) + 1);
  }
  return counts;
}

export interface SummaryAttribution {
  text: string;
  source: SummaryMember["source"] | null;
}

/** Null hides the summary: blank text, or a wire copy the seed source didn't write. */
export function summaryAttribution({
  summary,
  members,
  wire,
}: {
  summary: string;
  members: SummaryMember[];
  wire: Pick<WireSignal, "isWireRedistribution">;
}): SummaryAttribution | null {
  const text = summary.trim();
  if (text.length === 0) return null;

  // BL-13 rights gate: every member whose description literally matches
  // this excerpt has a source that has asked Tayf not to reuse its text —
  // the excerpt IS that outlet's copy verbatim, so merely hiding
  // attribution (falling through to the generic "Kaynak açıklaması"
  // label below) would still publish it. Hide the excerpt entirely
  // instead. When there's no literal match at all (the common case —
  // `summary` wasn't copied verbatim from any current member), this does
  // not apply; that's the pre-existing "attribute to no one" path below.
  const literalMatches = matchingCandidates(members, text);
  if (
    literalMatches.length > 0 &&
    literalMatches.every((m) => m.source.excerpt_allowed === false)
  ) {
    return null;
  }

  const seedMember = findSeedMember(members, text);

  if (wire.isWireRedistribution && seedMember) {
    const hash = seedMember.article.content_hash;
    if (hash !== null) {
      const counts = contentHashCounts(members);
      const bestCount = Math.max(0, ...counts.values());
      // Tie-safe: hide when the seed's hash is (one of) the majority.
      if ((counts.get(hash) ?? 0) === bestCount) return null;
    }
  }

  return { text, source: seedMember ? seedMember.source : null };
}

const ELLIPSIS = "…";

/** Word-boundary truncation shared by every `describeForMeta` branch. */
function truncateWords(full: string, max: number): string {
  if (full.length <= max) return full;
  const truncated = full.slice(0, Math.max(0, max - 1));
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return cut + ELLIPSIS;
}

/**
 * Meta/JSON-LD description: source count, plus attribution when present,
 * word-truncated to `max`. `base`, when supplied, replaces the default
 * "{count} kaynak." leading sentence — used by callers (e.g. the RSS feed)
 * that already compose their own honest count/wire-note prefix. `count` is
 * still required so `base`-less callers keep the original default; it is
 * ignored once `base` is present. `base` only overrides the leading
 * sentence, never the attribution prefix or the truncation behaviour.
 *
 * seo-2: when there's no attribution AND no `base` override, every such
 * cluster used to share the identical generic "{count} kaynak." meta
 * description — bad for unique-per-page SEO. `title`, when supplied, is
 * used instead to build a per-cluster fallback sentence. `base`-supplying
 * callers (rss.xml) are unaffected: the fallback only fires when `base` is
 * absent, so their own composed prefix always wins.
 */
export function describeForMeta(
  {
    count,
    attribution,
    base,
    title,
  }: {
    count: number;
    attribution: SummaryAttribution | null;
    base?: string;
    title?: string;
  },
  max = 160,
): string {
  const head = base ?? `${count} kaynak.`;
  if (!attribution) {
    if (base === undefined && title && title.trim().length > 0) {
      return truncateWords(`${count} kaynak, tek haber: ${title.trim()}`, max);
    }
    return head;
  }

  const prefix = attribution.source
    ? `${head} ${attribution.source.name}: `
    : `${head} Kaynak açıklaması: `;
  return truncateWords(prefix + attribution.text, max);
}

/**
 * Tri-state summary resolution shared by every caller with a batched,
 * possibly-failing members lookup (rss.xml, the digest cron).
 *
 * `lookupFailed` is the BL-13 fail-closed distinction this function exists
 * to centralize: `members` being absent for a cluster is ambiguous on its
 * own — it means either "the lookup ran and this cluster genuinely has no
 * attributable members" (safe to degrade via summaryAttributionWithoutMembers,
 * which can still show the generic label) or "the whole lookup failed"
 * (summaryAttributionWithoutMembers would then render clusters.summary_tr
 * verbatim with no excerpt_allowed check at all, since that gate only runs
 * inside summaryAttribution against real member rows). A source with
 * excerpt_allowed: false must never have its text rendered just because its
 * cluster's member lookup happened to error — so a failed lookup hides the
 * excerpt entirely instead of falling through to the degraded path.
 */
export function resolveSummaryAttribution({
  summary,
  members,
  lookupFailed,
  wire,
}: {
  summary: string;
  members: SummaryMember[] | undefined;
  lookupFailed: boolean;
  wire: Pick<WireSignal, "isWireRedistribution">;
}): SummaryAttribution | null {
  if (members) return summaryAttribution({ summary, members, wire });
  if (lookupFailed) return null;
  return summaryAttributionWithoutMembers({ summary, wire });
}

/**
 * DEGRADED fallback for callers with no member rows (feed surfaces, or a
 * lookup failure). Strictly more conservative than summaryAttribution: it
 * can never name an outlet (no members to run findSeedMember against), and
 * it hides the summary wholesale on any wire redistribution because the
 * per-seed content_hash majority check cannot run without members — so it
 * may hide a summary the member-aware path would show. That divergence is
 * intentional, not a bug to reconcile: the caller has strictly less
 * information, so it must be strictly less willing to publish someone
 * else's words as attributed or unattributed fact.
 */
export function summaryAttributionWithoutMembers({
  summary,
  wire,
}: {
  summary: string;
  members?: never;
  wire: Pick<WireSignal, "isWireRedistribution">;
}): SummaryAttribution | null {
  const text = summary.trim();
  if (text.length === 0) return null;
  if (wire.isWireRedistribution) return null;
  return { text, source: null };
}
