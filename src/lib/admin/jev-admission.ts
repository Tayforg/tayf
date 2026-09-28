import { createServerClient } from "@/lib/supabase/server";
import { BIAS_TO_ZONE, zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone } from "@/types";

// Migration 089 ("ADMIT") — the /admin "Jev siyaset kabulü" section's
// reader + pure helpers. Mirrors src/lib/admin/jev-shadow-status.ts's
// rationale: /admin is cookie-gated and dynamic, so this is a plain async
// module, NEVER "use cache". getJevAdmissionStatus() never throws -- a
// missing migration, a Supabase hiccup, or a bad RPC shape all render as a
// status sentence on the page, never a 500. `null` means "could not read";
// the section renders a different sentence for that than for "read fine,
// nothing to show yet".

// Single-line literals -- tests/api/admin-jev-admission.test.ts and
// jev-admission.test.ts parse these by source text, not just by value.
export const JEV_ADMISSION_VERDICTS = ["domestic", "policy_adjacent", "foreign", "not_politics", "unsure"] as const;
export const JEV_ADMISSION_OUTCOMES = ["matched", "created", "would_match", "would_create", "disabled", "rejected", "not_found"] as const;

export type JevAdmissionVerdict = (typeof JEV_ADMISSION_VERDICTS)[number];
export type JevAdmissionOutcome = (typeof JEV_ADMISSION_OUTCOMES)[number];

export const JEV_ADMISSION_VERDICT_LABELS: Record<JevAdmissionVerdict, string> = {
  domestic: "Yurt içi siyaset",
  policy_adjacent: "Siyasete komşu / yerel yönetim",
  foreign: "Dış siyaset",
  not_politics: "Siyaset değil",
  unsure: "Emin değilim",
};

export const JEV_ADMISSION_OUTCOME_LABELS: Record<JevAdmissionOutcome, string> = {
  matched: "Mevcut kümeye katıldı",
  created: "Yeni küme açtı",
  would_match: "Katılırdı (gölge)",
  would_create: "Yeni küme açardı (gölge)",
  disabled: "Kapalıyken geldi",
  rejected: "Reddedildi",
  not_found: "Haber bulunamadı",
};

export const JEV_ADMISSION_UNDECIDED_LABEL = "Karar bekliyor";

export const JEV_ADMISSION_REVIEW_TARGET = 80;

// ---------------------------------------------------------------------------
// Stats shape (mirrors public.jev_politics_admission_stats()'s jsonb output)
// ---------------------------------------------------------------------------

export interface JevAdmissionStats {
  hours: number;
  claims: number;
  claimsShadow: number;
  claimsLive: number;
  claimsPerDay: number;
  byCategory: Record<string, number>;
  byPin: Record<string, number>;
  outcomes: Record<string, number>;
  decided: number;
  stuck: number;
  joinExisting: number;
  joinAdmissionSeeded: number;
  joinedMultiSource: number;
  zoneAddedExisting: number;
  blindspotWithdrawn: number;
  blindspotCreated: number;
  clustersTouched: number;
  reviews: Record<string, number>;
  claimLagP50Min: number | null;
  freshIngested: number;
  freshScored60mShare: number | null;
  seededClusters: number;
  seededPolitikaMembers: number;
  seededUnlinkCandidates: number;
  admittedInUnlink: number;
  admittedBias: Record<string, number>;
  baselineBias: Record<string, number>;
}

function toNumberRecord(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = Number(v);
    if (Number.isFinite(n)) out[k] = n;
  }
  return out;
}

function toNumberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerces every number field of a raw jsonb stats row -- PostgREST/JSON
 * numerics can arrive as strings, and a raw `NaN`/non-numeric value must
 * never propagate into the rendered card. */
export function toAdmissionStats(raw: unknown): JevAdmissionStats {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    hours: Number(r.hours) || 0,
    claims: Number(r.claims) || 0,
    claimsShadow: Number(r.claims_shadow) || 0,
    claimsLive: Number(r.claims_live) || 0,
    claimsPerDay: Number(r.claims_per_day) || 0,
    byCategory: toNumberRecord(r.by_category),
    byPin: toNumberRecord(r.by_pin),
    outcomes: toNumberRecord(r.outcomes),
    decided: Number(r.decided) || 0,
    stuck: Number(r.stuck) || 0,
    joinExisting: Number(r.join_existing) || 0,
    joinAdmissionSeeded: Number(r.join_admission_seeded) || 0,
    joinedMultiSource: Number(r.joined_multi_source) || 0,
    zoneAddedExisting: Number(r.zone_added_existing) || 0,
    blindspotWithdrawn: Number(r.blindspot_withdrawn) || 0,
    blindspotCreated: Number(r.blindspot_created) || 0,
    clustersTouched: Number(r.clusters_touched) || 0,
    reviews: toNumberRecord(r.reviews),
    claimLagP50Min: toNumberOrNull(r.claim_lag_p50_min),
    freshIngested: Number(r.fresh_ingested) || 0,
    freshScored60mShare: toNumberOrNull(r.fresh_scored_60m_share),
    seededClusters: Number(r.seeded_clusters) || 0,
    seededPolitikaMembers: Number(r.seeded_politika_members) || 0,
    seededUnlinkCandidates: Number(r.seeded_unlink_candidates) || 0,
    admittedInUnlink: Number(r.admitted_in_unlink) || 0,
    admittedBias: toNumberRecord(r.admitted_bias),
    baselineBias: toNumberRecord(r.baseline_bias),
  };
}

/** Proportional share per Medya DNA zone from a bias -> count map. Unknown
 * bias keys (not in BIAS_TO_ZONE) are ignored, never thrown on. */
export function zoneShares(biasCounts: Record<string, number>): Record<MediaDnaZone, number> {
  const totals: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  let total = 0;
  for (const [bias, count] of Object.entries(biasCounts)) {
    if (!(bias in BIAS_TO_ZONE)) continue;
    const zone = zoneOf(bias as BiasCategory);
    totals[zone] += count;
    total += count;
  }
  if (total === 0) return { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
  return {
    iktidar: totals.iktidar / total,
    bagimsiz: totals.bagimsiz / total,
    muhalefet: totals.muhalefet / total,
  };
}

/** "Canlı" if any live claim exists, "Gölge" if any claim exists at all
 * (shadow only), else "Kapalı ya da aday yok" (the Edge secret's flag
 * value is invisible to Vercel, so this is inferred from claim rows, not
 * read from an env var). */
export function inferMode(stats: JevAdmissionStats): "Canlı" | "Gölge" | "Kapalı ya da aday yok" {
  if (stats.claimsLive > 0) return "Canlı";
  if (stats.claims > 0) return "Gölge";
  return "Kapalı ya da aday yok";
}

/** 95% Wilson score interval for k successes out of n trials. Returns
 * {lower: 0, upper: 0} for n <= 0 (never divides by zero). */
export function wilson(k: number, n: number): { lower: number; upper: number } {
  if (n <= 0) return { lower: 0, upper: 0 };
  const z = 1.96;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return {
    lower: Math.max(0, (center - margin) / denom),
    upper: Math.min(1, (center + margin) / denom),
  };
}

// ---------------------------------------------------------------------------
// Review batch
// ---------------------------------------------------------------------------

export interface JevAdmissionReviewRow {
  articleId: string;
  mode: string;
  category: string;
  politicsP: number | null;
  claimedAt: string;
  outcome: string | null;
  title: string | null;
  description: string | null;
}

/** Round-robin across categories (least-reviewed category first), newest
 * claim first within a category, capped at `limit`. Pure and deterministic
 * -- no I/O, no Date.now(). */
export function pickReviewBatch(
  rows: JevAdmissionReviewRow[],
  reviewedByCategory: Record<string, number>,
  limit = 10,
): JevAdmissionReviewRow[] {
  const byCategory = new Map<string, JevAdmissionReviewRow[]>();
  for (const row of rows) {
    const list = byCategory.get(row.category) ?? [];
    list.push(row);
    byCategory.set(row.category, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => (a.claimedAt < b.claimedAt ? 1 : a.claimedAt > b.claimedAt ? -1 : 0));
  }
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ra = reviewedByCategory[a] ?? 0;
    const rb = reviewedByCategory[b] ?? 0;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });

  const out: JevAdmissionReviewRow[] = [];
  const cursors = new Map<string, number>();
  let progressed = true;
  while (out.length < limit && progressed) {
    progressed = false;
    for (const cat of categories) {
      if (out.length >= limit) break;
      const idx = cursors.get(cat) ?? 0;
      const list = byCategory.get(cat) ?? [];
      const next = list[idx];
      if (idx >= list.length || next === undefined) continue;
      out.push(next);
      cursors.set(cat, idx + 1);
      progressed = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// getJevAdmissionStatus
// ---------------------------------------------------------------------------

export interface JevAdmissionStatus {
  stats48: JevAdmissionStats;
  stats168: JevAdmissionStats;
  mode: "Canlı" | "Gölge" | "Kapalı ya da aday yok";
  unreviewed: JevAdmissionReviewRow[];
  reviewedByCategory: Record<string, number>;
  reviewedByZone: Record<MediaDnaZone, number>;
  reviewBatch: JevAdmissionReviewRow[];
  reviewedCount: number;
}

interface RawUnreviewedRow {
  article_id: string;
  mode: string;
  category: string | null;
  politics_p: number | string | null;
  claimed_at: string;
  outcome: string | null;
  article?: { title?: string | null; description?: string | null } | Array<{ title?: string | null; description?: string | null }> | null;
}

function embedOne<T>(v: T | T[] | null | undefined): T | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export async function getJevAdmissionStatus(): Promise<JevAdmissionStatus | null> {
  try {
    const supabase = createServerClient();

    const [stats48Res, stats168Res, unreviewedRes, reviewedRes, sourcesRes] = await Promise.all([
      supabase.rpc("jev_politics_admission_stats", { p_hours: 48 }),
      supabase.rpc("jev_politics_admission_stats", { p_hours: 168 }),
      supabase
        .from("jev_politics_admissions")
        .select(
          "article_id, mode, category, politics_p, claimed_at, outcome, article:articles(title, description)",
        )
        .is("review_verdict", null)
        .is("rolled_back_at", null)
        .order("claimed_at", { ascending: false })
        .limit(60),
      supabase
        .from("jev_politics_admissions")
        .select("category, source_id, review_verdict")
        .not("review_verdict", "is", null)
        .limit(1000),
      // Per-zone review counts (outlet/wire only) for the review-progress line.
      supabase.from("sources").select("id, bias, kind"),
    ]);

    for (const res of [stats48Res, stats168Res, unreviewedRes, reviewedRes, sourcesRes]) {
      if (res.error) {
        console.error(`[admin] jev admission status unavailable: ${res.error.message}`);
        return null;
      }
    }

    const stats48 = toAdmissionStats(stats48Res.data);
    const stats168 = toAdmissionStats(stats168Res.data);

    const unreviewedRows = (unreviewedRes.data ?? []) as RawUnreviewedRow[];
    const unreviewed: JevAdmissionReviewRow[] = unreviewedRows.map((row) => {
      const article = embedOne(row.article);
      return {
        articleId: String(row.article_id),
        mode: String(row.mode ?? ""),
        category: String(row.category ?? ""),
        politicsP: toNumberOrNull(row.politics_p),
        claimedAt: String(row.claimed_at ?? ""),
        outcome: row.outcome ?? null,
        title: article?.title ?? null,
        description: article?.description ?? null,
      };
    });

    const reviewedRows = (reviewedRes.data ?? []) as Array<{
      category: string | null;
      source_id: string | null;
      review_verdict: string | null;
    }>;
    const reviewedByCategory: Record<string, number> = {};
    for (const row of reviewedRows) {
      const cat = row.category ?? "";
      reviewedByCategory[cat] = (reviewedByCategory[cat] ?? 0) + 1;
    }

    // Per-zone review counts, outlet/wire sources only (a3.5's "per-zone
    // counts" for the review-progress line). A source_id not found in the
    // sources fixture (or a non-voting kind) contributes nothing.
    const sourceRows = (sourcesRes.data ?? []) as Array<{
      id: string;
      bias: string | null;
      kind: string | null;
    }>;
    const sourceLookup = new Map(sourceRows.map((s) => [s.id, s]));
    const reviewedByZone: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };
    for (const row of reviewedRows) {
      const src = row.source_id ? sourceLookup.get(row.source_id) : undefined;
      if (!src || (src.kind !== "outlet" && src.kind !== "wire")) continue;
      if (!src.bias || !(src.bias in BIAS_TO_ZONE)) continue;
      reviewedByZone[zoneOf(src.bias as BiasCategory)] += 1;
    }

    return {
      stats48,
      stats168,
      mode: inferMode(stats48),
      unreviewed,
      reviewedByCategory,
      reviewedByZone,
      reviewBatch: pickReviewBatch(unreviewed, reviewedByCategory, 10),
      reviewedCount: reviewedRows.length,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev admission status unavailable: ${message}`);
    return null;
  }
}
