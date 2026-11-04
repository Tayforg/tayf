import { repairEntityResidue } from "../../../supabase/functions/_shared/rss/entities";
import { backOffOpenQuote, tidySummaryText, trimDanglingEnd } from "@/lib/articles/summary-tidy";
import type { WireSignal } from "./wire";
import type { BiasCategory } from "@/types";

// clusters.summary_tr is the seed article's raw RSS description — one
// outlet's words, not Tayf's. It must be attributed to that outlet or
// hidden entirely (blank, or a wire dispatch every member just copied).
// The seed is found by matching the stored text against member
// descriptions; first_published is min(published_at) over all members and
// moves when an older article joins late, so it is not used for attribution.
//
// Read-time repair for double-encoded feed residue: some stored descriptions
// (and so summary_tr, which copies them) carry a literal "&quot;", "&#39;" or
// "&amp;" that the single-pass ingest decoder left behind. Every function here
// runs the summary through `repairEntityResidue`, and seed detection repairs
// the member description the same way, so the comparison still holds whether
// the stored text is raw, already clean, or one of each. The repair is
// idempotent and can never create '<' or '>'.
//
// Read-time tidy for feed residue (glued sentences, "Devamı için tıklayınız"
// tails, widget heading lines, raw newlines): `tidySummaryText` is applied
// ONLY to the `text` placed in the returned SummaryAttribution. Matching
// (`matchingCandidates`, `findSeedMember`), the BL-13 rights gate and the wire
// majority check all compare the repaired but UNTIDIED text, because that is
// what a member's stored description looks like; comparing tidied text would
// let a rights-blocked or wire-copied description slip past those checks.
// Tidied text that comes out empty (the summary was only a CTA or a widget
// heading) hides the summary, like a blank one.

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
 * Members whose article description equals the summary text after both have
 * been through `repairEntityResidue` (`text` is expected to be repaired
 * already), sorted earliest-first (ties broken by publish time). Internal helper —
 * both `findSeedMember` (rights-eligible pick) and `summaryAttribution`
 * (rights-blocked-entirely detection) need the full matching set.
 */
function matchingCandidates(
  members: SummaryMember[],
  text: string,
): SummaryMember[] {
  return members
    .filter(
      (m) => repairEntityResidue(m.article.description ?? "").trim() === text,
    )
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
  const text = repairEntityResidue(summary).trim();
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
  const text = repairEntityResidue(summary).trim();
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

  const shown = tidySummaryText(text);
  if (shown.length === 0) return null;
  return { text: shown, source: seedMember ? seedMember.source : null };
}

const ELLIPSIS = "…";

/**
 * A quote back-off must keep at least this many characters of the attribution
 * text (after the "N kaynak. Outlet: " prefix), or the description is the one
 * without an attribution (h30-live-1). "Yılmaz, "<200-character quote>" dedi."
 * backed off to "4 kaynak. Anadolu Ajansı: Yılmaz…": a speaker's name is not a
 * description, and the title sentence is.
 */
const MIN_KEPT_AFTER_BACK_OFF = 60;

/**
 * Word-boundary truncation shared by every `describeForMeta` branch.
 *
 * A cut that would end inside an open quotation (`Yılmaz, "İsrail'in … baskısına…`,
 * h29-regress-1) is backed off by {@link backOffOpenQuote}: to the last sentence
 * end or to the word in front of the opener, never to a cut that ends at or
 * before `floor` (the length of the leading sentence and the attribution label,
 * which are not the text). Null when no such cut exists; the caller then falls
 * back to the description without the text. h30-live-1: a back-off that keeps
 * fewer than `minKeptAfterBackOff` characters of text after `floor` is null too;
 * what is left is a stub.
 *
 * A balanced cut is cut as it always was, except that it no longer ends in
 * ", ; : – — -" in front of the ellipsis ("Demokratlar Partisi,…", h30-live-1)
 * and is null when that leaves nothing after `floor`. The minimum applies to a
 * back-off only: a plain word cut keeps what the limit allows.
 */
function truncateWords(
  full: string,
  max: number,
  floor = 0,
  minKeptAfterBackOff = 0,
): string | null {
  if (full.length <= max) return full;
  const truncated = full.slice(0, Math.max(0, max - 1));
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  const kept = backOffOpenQuote(cut, { floor });
  if (kept === null) return null;
  if (kept === cut) {
    // No quotation left open: a plain word cut. A double space at the boundary
    // would leave one blank in front of the ellipsis ("geçirilecek. …"), and a
    // dangling mark would read ",…".
    const end = trimDanglingEnd(cut, cut.length);
    return end <= floor ? null : cut.slice(0, end) + ELLIPSIS;
  }
  const text = kept.endsWith(ELLIPSIS) ? kept.slice(0, -ELLIPSIS.length) : kept;
  if (text.length - floor < minKeptAfterBackOff) return null;
  if (kept.endsWith(ELLIPSIS)) return kept;
  return kept.slice(0, trimDanglingEnd(kept, kept.length)) + ELLIPSIS;
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
 *
 * h29-regress-1: the word cut never ends inside an open quotation (see
 * `truncateWords`). An attribution text that opens with the quotation has no
 * cut that does not, so the description is the one without an attribution (the
 * title sentence, else `head`).
 *
 * h30-live-1: the same description replaces an attribution whose quote back-off
 * keeps fewer than 60 characters of text (a speaker's name in front of a long
 * quotation, "Yılmaz…"; the title fallback itself is not held to that), a cut
 * never ends in ", ; : – — -" in front of the "…", and a cut that would end
 * inside the label ("N kaynak. Outlet:") has no text to show and falls back too.
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
  // The description without an attribution: the title sentence, else the head.
  // An attribution whose text cannot be cut without ending inside a quotation
  // (it opens with the quotation) falls back to it.
  const withoutAttribution = (): string => {
    if (base === undefined && title && title.trim().length > 0) {
      const lead = `${count} kaynak, tek haber: `;
      return truncateWords(lead + title.trim(), max, lead.length) ?? head;
    }
    return head;
  };
  if (!attribution) return withoutAttribution();

  const prefix = attribution.source
    ? `${head} ${attribution.source.name}: `
    : `${head} Kaynak açıklaması: `;
  return (
    truncateWords(prefix + attribution.text, max, prefix.length, MIN_KEPT_AFTER_BACK_OFF) ??
    withoutAttribution()
  );
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
  const text = repairEntityResidue(summary).trim();
  if (text.length === 0) return null;
  if (wire.isWireRedistribution) return null;
  const shown = tidySummaryText(text);
  if (shown.length === 0) return null;
  return { text: shown, source: null };
}
