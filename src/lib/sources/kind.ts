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
