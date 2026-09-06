import type { ClusterDetailMember } from "./cluster-detail-query";
import type { WireSignal } from "./wire";
import type { Source } from "@/types";

// clusters.summary_tr is the seed article's raw RSS description — one
// outlet's words, not Tayf's. It must be attributed to that outlet or
// hidden entirely (blank, or a wire dispatch every member just copied).
// The seed is found by matching the stored text against member
// descriptions; first_published is min(published_at) over all members and
// moves when an older article joins late, so it is not used for attribution.

/** Member whose article description equals the summary text; earliest wins ties. */
export function findSeedMember(
  members: ClusterDetailMember[],
  summary: string,
): ClusterDetailMember | null {
  const text = summary.trim();
  if (text.length === 0) return null;
  const candidates = members
    .filter((m) => (m.article.description ?? "").trim() === text)
    .sort(
      (a, b) =>
        new Date(a.article.published_at).getTime() -
        new Date(b.article.published_at).getTime(),
    );
  return candidates[0] ?? null;
}

/** Non-null content_hash counts among members — for finding the wire dispatch's hash. */
function contentHashCounts(members: ClusterDetailMember[]): Map<string, number> {
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
  source: Source | null;
}

/** Null hides the summary: blank text, or a wire copy the seed source didn't write. */
export function summaryAttribution({
  summary,
  members,
  wire,
}: {
  summary: string;
  members: ClusterDetailMember[];
  wire: Pick<WireSignal, "isWireRedistribution">;
}): SummaryAttribution | null {
  const text = summary.trim();
  if (text.length === 0) return null;

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

/** Meta/JSON-LD description: source count, plus attribution when present, word-truncated to `max`. */
export function describeForMeta(
  {
    count,
    attribution,
  }: { count: number; attribution: SummaryAttribution | null },
  max = 160,
): string {
  const base = `${count} kaynak.`;
  if (!attribution) return base;

  const prefix = attribution.source
    ? `${base} ${attribution.source.name}: `
    : `${base} Kaynak açıklaması: `;
  const full = prefix + attribution.text;
  if (full.length <= max) return full;

  const truncated = full.slice(0, Math.max(0, max - 1));
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 0 ? truncated.slice(0, lastSpace) : truncated;
  return cut + ELLIPSIS;
}
