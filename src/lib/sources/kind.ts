import type { Source, SourceKind } from "@/types";

export type { SourceKind } from "@/types";
export {
  SOURCE_KINDS,
  VOTING_SOURCE_KINDS,
  isVotingKind,
  normalizeSourceKind,
} from "@/lib/bias/config";

import { isVotingKind, normalizeSourceKind } from "@/lib/bias/config";

/**
 * Turkish label + description per source kind. Only "outlet" and "wire"
 * vote in bias_distribution, blindspot/surprise detection and trends — the
 * description text says so explicitly so the /sources page and the
 * cluster-page "Toplayıcı / niş kaynaklar" row can surface it verbatim.
 */
export const SOURCE_KIND_META: Record<SourceKind, { label: string; description: string }> = {
  outlet: {
    label: "Haber kuruluşu",
    description: "Genel haber yayıncısı; yanlılık dağılımına sayılır.",
  },
  wire: {
    label: "Ajans",
    description: "Haber ajansı; yanlılık dağılımına sayılır.",
  },
  aggregator: {
    label: "Toplayıcı",
    description: "Başka kaynakların haberlerini derler; yanlılık dağılımına sayılmaz.",
  },
  niche: {
    label: "Niş",
    description: "Spor, finans, bölgesel veya kurumsal yayın; yanlılık dağılımına sayılmaz.",
  },
};

/**
 * What a source that does not vote is excluded from, in the words the cluster
 * pages already use (the story-timeline legend, the kart, /karsilastir). Kept
 * in one place so the /source label card and the cluster pages say the same
 * thing about an aggregator or niche source.
 */
export const NON_VOTING_CLAUSE = "spektruma ve ilk sıraya sayılmaz";

/** The cluster-page legend wording for the two non-voting kinds together. */
export const NON_VOTING_KIND_NOTE = `toplayıcı / niş kaynak; ${NON_VOTING_CLAUSE}`;

/**
 * One-line "does not vote" note for a source of this kind: the kind's own
 * label plus the shared clause ("Toplayıcı kaynak; spektruma ve ilk sıraya
 * sayılmaz."). null for the voting kinds and for a missing or unknown kind
 * (those normalise to "outlet", which votes) so a caller can render it
 * conditionally.
 */
export function nonVotingNote(kind: SourceKind | null | undefined): string | null {
  if (isVotingKind(kind)) return null;
  return `${SOURCE_KIND_META[normalizeSourceKind(kind)].label} kaynak; ${NON_VOTING_CLAUSE}.`;
}

/** Normalized `SourceKind` of a source (undefined → "outlet", which votes). */
export function sourceKindOf(source: Pick<Source, "kind">): SourceKind {
  return normalizeSourceKind(source.kind);
}

/** Whether a source's kind counts toward bias_distribution / blindspot / trends. */
export function isVotingSource(source: Pick<Source, "kind">): boolean {
  return isVotingKind(source.kind);
}

/**
 * Splits a list of `{ source: { kind } }` members into voting and
 * non-voting groups, preserving the input order within each group. Works on
 * `ClusterDetailMember[]` and on anything shaped like `{ source: { kind } }`.
 */
export function partitionByVote<T extends { source: { kind?: SourceKind | null } }>(
  members: readonly T[],
): { voting: T[]; nonVoting: T[] } {
  const voting: T[] = [];
  const nonVoting: T[] = [];
  for (const m of members) {
    if (isVotingKind(m.source.kind)) {
      voting.push(m);
    } else {
      nonVoting.push(m);
    }
  }
  return { voting, nonVoting };
}
