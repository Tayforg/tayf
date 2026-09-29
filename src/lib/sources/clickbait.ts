import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";
import { zoneOf } from "@/lib/bias/config";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

// clickbait-karne (migration 078) — per-outlet "tık tuzağı karnesi" (Turkish:
// "clickbait scorecard"), in terciles (Düşük / Orta / Yüksek).
//
// SIGNAL: this is Jev's `clickbait` task ("does this headline withhold the
// key fact to force a click?"), NOT `sensational` (a 0-3 wording-intensity
// score, JEV_SCORE_TASKS in supabase/functions/_shared/jev.ts). The 2026-09-20
// limits test rejected `sensational` at ~20% precision; `clickbait` scored
// Spearman 0.76 / 85% accuracy against Opus gold, but its ECE (0.12-0.15)
// means it is usable only as a RANKING (terciles), never as a headline
// count or percentage.
//
// PUBLIC GATE: nothing here reaches a reader until CLICKBAIT_PRECISION_CHECK
// (below) is non-null and clears CLICKBAIT_PRECISION_MIN on a 200-row blind
// label sample, at CLICKBAIT_FLAG_PROB, under the SAME question set. The
// 200-row blind label pass (SPEC Step 0d — reading raw headlines and hand-
// verdicting each one, single-labeller) is judgement work that belongs to a
// Fable/Opus-tier reviewer, not this module's Sonnet-tier implementation
// pass; CLICKBAIT_PRECISION_CHECK is therefore left at its safe default
// (null = admin-only) until that review lands. See docs/clickbait-karne.md
// and tests/fixtures/clickbait-precision.json (currently a synthetic
// placeholder — see that file's own `status` field) for the pending
// runbook step.

/** Flag threshold: jev_prob >= this counts as a "tık tuzağı" headline. Drives
 * both the per-outlet metric and the Step-0 precision sample — pre-registered
 * together so the gate can never be moved after the fact to fit a result. */
export const CLICKBAIT_FLAG_PROB = 0.7;
/** Rolling window, in days, the karne is computed over. */
export const CLICKBAIT_WINDOW_DAYS = 30;
/** Minimum headlines an outlet must carry in the window to be eligible. */
export const CLICKBAIT_MIN_N = 300;
/** Terciles are only computed with at least this many eligible outlets. */
export const CLICKBAIT_MIN_OUTLETS = 9;
/** Public gate: minimum acceptable precision on the Step-0 sample. */
export const CLICKBAIT_PRECISION_MIN = 0.8;
/** Public gate: minimum sample size for the Step-0 precision check. */
export const CLICKBAIT_PRECISION_SAMPLE = 200;
/** One question-set version — the current JEV_QUESTION_SET_VERSION. A parity
 * test (tests/migrations/078-source-clickbait.test.ts) forces a decision
 * whenever Jev's version bumps: append (questions byte-identical) or
 * replace (questions differ, which resets the window). */
export const CLICKBAIT_QUESTION_SETS = [
  "2026-09-24.1",
  // JEV-B slim pack (JEV_ARTICLE_PACK=slim): clickbait text is byte-identical,
  // so the window continues across the switch.
  "2026-10-04.1",
] as const;
/** sha256 hex of JSON.stringify(buildArticleCall({title:'t',
 * description:'d'}).questions), pinned so a silent wording change in the
 * shared article call trips a parity test rather than silently drifting the
 * "tık tuzağı" number's meaning. Computed once in
 * tests/migrations/078-source-clickbait.test.ts. */
export const CLICKBAIT_ARTICLE_CALL_SHA =
  "b4e613e01cabb4b373605206cf6b055b1c2be43b8e9bf8708f7cd00631778b44";
/** Verbatim copy of JEV_QUESTION_REGISTRY.clickbait.instructions
 * (supabase/functions/_shared/jev.ts) — pinned, not imported, so this
 * module never pulls the Edge Function's shared file into the app bundle.
 * Parity-tested in tests/migrations/078-source-clickbait.test.ts. */
export const CLICKBAIT_QUESTION_EN =
  "Does this headline deliberately withhold the key fact to force a click (curiosity gap, unnamed subject, 'işte o isim', 'ne oldu şaşıracaksınız'), rather than stating what happened?";
/** Turkish translation shown to readers in the method note. */
export const CLICKBAIT_QUESTION_TR =
  "Bu başlık, tıklatmak için asıl bilgiyi bilerek saklıyor mu (merak boşluğu, adı verilmeyen özne, “işte o isim” gibi), yoksa ne olduğunu söylüyor mu?";
export const CLICKBAIT_TIER_LABELS = {
  low: "Düşük",
  mid: "Orta",
  high: "Yüksek",
} as const;

export type ClickbaitTier = keyof typeof CLICKBAIT_TIER_LABELS;

export interface ClickbaitPrecisionCheck {
  checkedOn: string;
  sample: number;
  clickbait: number;
  precision: number;
  threshold: number;
  questionSets: string[];
  labeler: string;
}

/** Public gate. Default null = admin-only. See the module docblock: the
 * 200-row blind label pass this would come from has not been run by this
 * implementation pass. NEVER set this from anything but a real, reviewed
 * Step-0 sample — the copy this drives (ClickbaitKarneSection) claims a
 * checked-and-verified precision number. */
export const CLICKBAIT_PRECISION_CHECK: ClickbaitPrecisionCheck | null = null;

/**
 * True only when `check` is a real, non-null precision record that clears
 * every gate condition: sample size, precision floor, the exact flag
 * threshold, and the exact (ordered) question-set list this deployment
 * actually measures against.
 */
export function isClickbaitPublic(
  check: ClickbaitPrecisionCheck | null = CLICKBAIT_PRECISION_CHECK,
): boolean {
  if (!check) return false;
  if (check.sample < CLICKBAIT_PRECISION_SAMPLE) return false;
  if (check.precision < CLICKBAIT_PRECISION_MIN) return false;
  if (check.threshold !== CLICKBAIT_FLAG_PROB) return false;
  if (check.questionSets.length !== CLICKBAIT_QUESTION_SETS.length) return false;
  for (let i = 0; i < check.questionSets.length; i++) {
    if (check.questionSets[i] !== CLICKBAIT_QUESTION_SETS[i]) return false;
  }
  return true;
}

/** One eligible outlet row, shaped from `source_clickbait_30d`'s return. */
export interface ClickbaitOutletRow {
  sourceId: string;
  slug: string;
  name: string;
  bias: BiasCategory;
  kind: SourceKind;
  nTotal: number;
  nFlagged: number;
  meanProb: number;
  firstDay: string;
  lastDay: string;
}

export interface ClickbaitOutletKarne {
  slug: string;
  name: string;
  bias: BiasCategory;
  zone: MediaDnaZone;
  n: number;
  nFlagged: number;
  share: number;
  meanProb: number;
  tier: ClickbaitTier;
}

export interface ClickbaitKarne {
  outlets: ClickbaitOutletKarne[];
  firstDay: string;
  lastDay: string;
  outletCount: number;
  questionSets: readonly string[];
  minN: number;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

function tierForRank(rank: number, count: number): ClickbaitTier {
  const idx = Math.floor((rank * 3) / count);
  if (idx <= 0) return "low";
  if (idx === 1) return "mid";
  return "high";
}

/**
 * Pure. Filters to rows carrying at least CLICKBAIT_MIN_N headlines in the
 * window, sorts ascending by (share, meanProb, slug), splits into three
 * tiers by rank, and glues any exact tie on (share, meanProb to 4dp) to the
 * tier of the first member of that tie group. Returns null unless at least
 * CLICKBAIT_MIN_OUTLETS rows qualify (nothing is public below that count).
 */
export function buildClickbaitKarne(rows: readonly ClickbaitOutletRow[]): ClickbaitKarne | null {
  const eligible = rows.filter((r) => r.nTotal >= CLICKBAIT_MIN_N);
  if (eligible.length < CLICKBAIT_MIN_OUTLETS) return null;

  const withShare = eligible.map((r) => ({
    ...r,
    share: r.nTotal > 0 ? r.nFlagged / r.nTotal : 0,
  }));

  withShare.sort((a, b) => {
    if (a.share !== b.share) return a.share - b.share;
    if (a.meanProb !== b.meanProb) return a.meanProb - b.meanProb;
    return a.slug.localeCompare(b.slug);
  });

  const count = withShare.length;
  const outlets: ClickbaitOutletKarne[] = withShare.map((r, i) => ({
    slug: r.slug,
    name: r.name,
    bias: r.bias,
    zone: zoneOf(r.bias),
    n: r.nTotal,
    nFlagged: r.nFlagged,
    share: r.share,
    meanProb: r.meanProb,
    tier: tierForRank(i, count),
  }));

  // Exact ties on (share, meanProb to 4dp) all take the tier of the first
  // member of the tie group, even across a tercile boundary.
  let i = 0;
  while (i < outlets.length) {
    let j = i + 1;
    while (
      j < outlets.length &&
      outlets[j]!.share === outlets[i]!.share &&
      round4(outlets[j]!.meanProb) === round4(outlets[i]!.meanProb)
    ) {
      j++;
    }
    const tier = outlets[i]!.tier;
    for (let k = i; k < j; k++) outlets[k]!.tier = tier;
    i = j;
  }

  const firstDay = eligible.reduce((min, r) => (r.firstDay < min ? r.firstDay : min), eligible[0]!.firstDay);
  const lastDay = eligible.reduce((max, r) => (r.lastDay > max ? r.lastDay : max), eligible[0]!.lastDay);

  return {
    outlets,
    firstDay,
    lastDay,
    outletCount: outlets.length,
    questionSets: CLICKBAIT_QUESTION_SETS,
    minN: CLICKBAIT_MIN_N,
  };
}

export function karneForSlug(
  karne: ClickbaitKarne | null | undefined,
  slug: string,
): ClickbaitOutletKarne | undefined {
  return karne?.outlets.find((o) => o.slug === slug);
}

interface RawClickbaitRpcRow {
  source_id: string;
  source_slug: string;
  source_name: string;
  source_bias: string;
  source_kind: string;
  n_total: number;
  n_flagged: number;
  mean_prob: number;
  first_day: string;
  last_day: string;
}

function mapRawRow(raw: RawClickbaitRpcRow): ClickbaitOutletRow {
  return {
    sourceId: raw.source_id,
    slug: raw.source_slug,
    name: raw.source_name,
    bias: raw.source_bias as BiasCategory,
    kind: raw.source_kind as SourceKind,
    nTotal: raw.n_total,
    nFlagged: raw.n_flagged,
    meanProb: raw.mean_prob,
    firstDay: raw.first_day,
    lastDay: raw.last_day,
  };
}

/**
 * Cached fetch of the 30-day rollup via `source_clickbait_30d`. THROWS on an
 * rpc error (never resolves to an empty/partial result silently) so a
 * transient DB error can never get cached as "no eligible outlets" for the
 * whole cacheLife("hours") window — the uncached wrapper (getClickbaitKarne)
 * is the one that fails open.
 */
export async function fetchClickbaitRows(minN: number): Promise<ClickbaitOutletRow[]> {
  "use cache";
  cacheLife("hours");
  cacheTag("sources");

  const supabase = createServerClient();
  const { data, error } = await supabase.rpc("source_clickbait_30d", {
    p_question_sets: [...CLICKBAIT_QUESTION_SETS],
    p_days: CLICKBAIT_WINDOW_DAYS,
    p_min_n: minN,
  });

  if (error) {
    throw new Error(`source_clickbait_30d rpc failed: ${error.message}`);
  }

  return ((data ?? []) as RawClickbaitRpcRow[]).map(mapRawRow);
}

/**
 * Uncached, fail-open wrapper. Every public caller (/sources, /source/[slug])
 * runs at request time already (connection() / dynamic params), so there is
 * no build-time cost to calling this uncached — it exists purely so a
 * missing migration 078 or an rpc error can never take a public page down;
 * it just hides the section.
 */
export async function getClickbaitKarne(): Promise<ClickbaitKarne | null> {
  try {
    const rows = await fetchClickbaitRows(CLICKBAIT_MIN_N);
    return buildClickbaitKarne(rows);
  } catch {
    return null;
  }
}

/**
 * Admin-only, uncached, unfiltered (p_min_n: 1) rows for /admin/tik-tuzagi —
 * every source with at least one clickbait row in the window, not just the
 * ones that clear the public CLICKBAIT_MIN_N floor. Never throws: an admin
 * page renders "no data" rather than 500ing on a transient DB error.
 */
export async function getClickbaitAdminRows(): Promise<ClickbaitOutletRow[]> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("source_clickbait_30d", {
      p_question_sets: [...CLICKBAIT_QUESTION_SETS],
      p_days: CLICKBAIT_WINDOW_DAYS,
      p_min_n: 1,
    });
    if (error) return [];
    return ((data ?? []) as RawClickbaitRpcRow[]).map(mapRawRow);
  } catch {
    return [];
  }
}
