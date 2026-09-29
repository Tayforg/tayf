import { createServerClient } from "@/lib/supabase/server";

// Shared contract for the cluster merge engine (migration 099). Server-only:
// it goes through the service-role client. Never throws; every failure is a
// { ok: false, reason } the caller maps to an HTTP status or an admin toast.

export type MergeOrigin = "manual" | "thread" | "recall";

/** Every code public.cluster_merge_atomic raises. Parity-tested against the
 *  migration in tests/migrations/099-cluster-merge.test.ts. */
export const MERGE_ERROR_CODES = [
  "cluster_merge_self",
  "cluster_merge_not_found",
  "cluster_merge_target_archived",
  "cluster_merge_target_merged",
  "cluster_merge_source_merged",
  "cluster_merge_bad_actor",
  "cluster_merge_bad_origin",
] as const;

export type MergeFailureReason = "invalid" | "not-found" | "conflict" | "error";

export interface MergeOutcome {
  logId: number | null;
  resweep: boolean;
  moved: number;
  duplicates: number;
  sourceCountBefore: number;
  targetCountBefore: number;
  targetCountAfter: number;
  targetBlindspotBefore: boolean;
  targetBlindspotAfter: boolean;
}

export type MergeResult =
  | { ok: true; outcome: MergeOutcome }
  | { ok: false; reason: MergeFailureReason };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REASON_BY_CODE: Record<(typeof MERGE_ERROR_CODES)[number], MergeFailureReason> = {
  cluster_merge_self: "invalid",
  cluster_merge_bad_actor: "invalid",
  cluster_merge_bad_origin: "invalid",
  cluster_merge_not_found: "not-found",
  cluster_merge_target_archived: "conflict",
  cluster_merge_target_merged: "conflict",
  cluster_merge_source_merged: "conflict",
};

function reasonFor(message: string): MergeFailureReason {
  for (const code of MERGE_ERROR_CODES) {
    if (message.includes(code)) return REASON_BY_CODE[code];
  }
  return "error";
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export async function mergeClusters(i: {
  source: string;
  target: string;
  actor: string;
  origin: MergeOrigin;
}): Promise<MergeResult> {
  if (typeof i.source !== "string" || typeof i.target !== "string") {
    return { ok: false, reason: "invalid" };
  }
  const source = i.source.toLowerCase();
  const target = i.target.toLowerCase();
  if (!UUID_RE.test(source) || !UUID_RE.test(target) || source === target) {
    return { ok: false, reason: "invalid" };
  }

  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("cluster_merge_atomic", {
      p_source: source,
      p_target: target,
      p_actor: i.actor,
      p_origin: i.origin,
    });
    if (error) return { ok: false, reason: reasonFor(String(error.message ?? "")) };
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, reason: "error" };
    }
    const d = data as Record<string, unknown>;
    return {
      ok: true,
      outcome: {
        logId: typeof d.log_id === "number" ? d.log_id : null,
        resweep: d.resweep === true,
        moved: num(d.moved),
        duplicates: num(d.duplicates),
        sourceCountBefore: num(d.source_count_before),
        targetCountBefore: num(d.target_count_before),
        targetCountAfter: num(d.target_count_after),
        targetBlindspotBefore: d.target_blindspot_before === true,
        targetBlindspotAfter: d.target_blindspot_after === true,
      },
    };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Cache tags a merge invalidates (call revalidateTag on each after ok). */
export function mergeRevalidationTags(source: string, target: string): string[] {
  return [
    "clusters",
    "clusters-politics",
    "clusters-search",
    "story-threads",
    `cluster-detail:${source}`,
    `cluster-detail:${target}`,
    `fact-checks:${source}`,
    `fact-checks:${target}`,
  ];
}
