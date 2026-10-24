import { createServerClient } from "@/lib/supabase/server";
import {
  loadClusterRefs,
  pickDefaultTarget,
  toMergeClusterRef,
  type MergeClusterRef,
} from "@/lib/admin/merge-queue";

// Reader for the "Olası ikiz kümeler" list on /admin/birlestir (migration 120).
// A twin is two article rows of one source with the same source_article_key
// (migration 113) that clustering put in two different clusters, because the
// outlet republished the story under a new URL slug before #128 stopped that at
// ingest. The SQL function admin_twin_cluster_pairs() finds the cluster pairs;
// this file hydrates them for display and nothing else.
//
// READ-ONLY, ON PURPOSE. No write call, no other rpc, never cluster_merge_atomic:
// a pair is merged only when an admin presses Birleştir, which POSTs the existing
// /api/admin/cluster-merge flow (tests/guards/admin-twin-review.test.ts pins it).
// Plain async, no cache, never throws: null means "could not read" (e.g. 120 not
// applied) and the page renders a sentence.

export const TWIN_WINDOW_DAYS = 14;
export const TWIN_PAIR_CAP = 50;

export interface TwinPairRow {
  /** `${min}:${max}` of the two cluster ids, the same shape as MergeQueueRow.key. */
  key: string;
  a: MergeClusterRef;
  b: MergeClusterRef;
  twinCount: number;
  sourceSlugs: string[];
  /** created_at of the newest twin article of the pair, as the database returned it. */
  newestAt: string | null;
  detail: string;
  defaultTargetId: string;
}

interface RpcPair {
  a: string;
  b: string;
  twinCount: number;
  sourceSlugs: string[];
  newestAt: string | null;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parsePairs(data: unknown): RpcPair[] {
  if (!Array.isArray(data)) return [];
  const out: RpcPair[] = [];
  for (const raw of data) {
    if (typeof raw !== "object" || raw === null) continue;
    const r = raw as Record<string, unknown>;
    const x = str(r.cluster_a);
    const y = str(r.cluster_b);
    if (!x || !y || x === y) continue;
    const [a, b] = x < y ? [x, y] : [y, x];
    const count = Number(r.twin_count);
    out.push({
      a,
      b,
      twinCount: Number.isFinite(count) && count > 0 ? Math.floor(count) : 0,
      sourceSlugs: Array.isArray(r.source_slugs)
        ? r.source_slugs.filter((s): s is string => typeof s === "string" && s.length > 0)
        : [],
      newestAt: str(r.newest_at) || null,
    });
  }
  return out;
}

export async function getTwinClusterPairs(): Promise<TwinPairRow[] | null> {
  try {
    const supabase = createServerClient();
    const res = await supabase.rpc("admin_twin_cluster_pairs", {
      p_days: TWIN_WINDOW_DAYS,
      p_limit: TWIN_PAIR_CAP,
    });
    if (res.error) throw new Error(`twin pairs: ${res.error.message}`);

    const pairs = parsePairs(res.data);
    if (pairs.length === 0) return [];

    const refs = await loadClusterRefs(supabase, [...new Set(pairs.flatMap((p) => [p.a, p.b]))]);

    // The SQL order (newest twin first) is the display order: no re-sorting here.
    const out: TwinPairRow[] = [];
    for (const p of pairs) {
      const ca = refs.get(p.a);
      const cb = refs.get(p.b);
      if (!ca || !cb || ca.archived || cb.archived) continue;
      const a = toMergeClusterRef(ca);
      const b = toMergeClusterRef(cb);
      out.push({
        key: `${p.a}:${p.b}`,
        a,
        b,
        twinCount: p.twinCount,
        sourceSlugs: p.sourceSlugs,
        newestAt: p.newestAt,
        detail: [p.sourceSlugs.join(", "), `${p.twinCount} ikiz haber`].filter(Boolean).join(" · "),
        defaultTargetId: pickDefaultTarget(a, b),
      });
    }
    return out;
  } catch (err) {
    console.error(`[admin] twin clusters unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
