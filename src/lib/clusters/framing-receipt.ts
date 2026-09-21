import { cacheLife, cacheTag } from "next/cache";

import { createServerClient } from "@/lib/supabase/server";

// T11 (migration 068) — the Çerçeveleme makbuzu (framing receipt): a
// counts-only summary of how a cluster's member headlines scored on the
// existing `framing` Jev shadow task (migration 061).
//
// Three things worth stating plainly, since this is the FIRST reader-facing
// use of jev_shadow_* data:
//
//   (a) jev_shadow_* is service_role-only shadow data — migration 061
//       documented it as reader-invisible, and the only sanctioned read
//       surface before this pack was the cookie-gated /admin. This module
//       is the first sanctioned reader-facing use, and it stays narrow on
//       purpose: gated by FRAMING_RECEIPT_PUBLIC, floored at
//       FRAMING_RECEIPT_PUBLIC_MIN_SCORED scored headlines, and it
//       publishes COUNTS ONLY — never a per-headline call, never an outlet
//       name.
//   (b) A framing prediction with no usable probability (e.g. a production
//       row whose `jev_answer` never stored per-choice `probabilities`)
//       counts as UNSCORED, not as a data point. That is fail-closed by
//       design: no confidence stored means no claim published, and a
//       cluster with zero usable predictions simply reports scored = 0.
//   (c) `question_set` on the RPC row may span more than one
//       JEV_QUESTION_SET_VERSION — the receipt aggregates across whatever
//       versions actually produced predictions for this cluster, which
//       means a receipt spanning a question-set bump mixes wordings and
//       must be read as approximate, not as a single, stable rubric.

export interface FramingReceipt {
  members: number;
  scored: number;
  proGovernment: number;
  proOpposition: number;
  neutral: number;
  questionSet: string | null;
}

export const FRAMING_RECEIPT_THRESHOLD = 0.75;
export const FRAMING_RECEIPT_PUBLIC_MIN_SCORED = 3;
export const FRAMING_RECEIPT_CAVEAT =
  "Bu bir yargı değil, kelime seçimi sinyalidir.";

/**
 * Reads the public-exposure flag. MUST be called outside any "use cache"
 * function — a cached function that read `process.env` directly would
 * capture whatever value was live at build/first-render time and could
 * serve a stale flag from cache forever.
 */
export function isFramingReceiptPublic(): boolean {
  return process.env.FRAMING_RECEIPT_PUBLIC === "1";
}

/**
 * Fail-closed gate for the public cluster page: the flag must be on AND the
 * receipt must exist AND it must clear the minimum scored-headline floor.
 * A thin cluster (scored < 3) never publishes, flag or not.
 *
 * K-ANONYMITY: when EVERY member headline is scored AND they all landed in
 * one bucket, the counts map 1:1 onto the outlet names the cluster page
 * lists directly above this card -- that is a per-outlet framing call,
 * which this receipt must never publish. Block only that precise case
 * (members === scored AND the top bucket equals scored), not every cluster
 * whose counts happen to lean one way.
 */
export function shouldShowPublicFramingReceipt(
  receipt: FramingReceipt | null,
): boolean {
  if (!isFramingReceiptPublic()) return false;
  if (receipt === null) return false;
  if (receipt.scored < FRAMING_RECEIPT_PUBLIC_MIN_SCORED) return false;

  const topBucket = Math.max(
    receipt.proGovernment,
    receipt.proOpposition,
    receipt.neutral,
  );
  if (receipt.members === receipt.scored && topBucket === receipt.scored) {
    return false;
  }

  return true;
}

interface RawFramingReceiptRow {
  members?: number | string | null;
  scored?: number | string | null;
  pro_government?: number | string | null;
  pro_opposition?: number | string | null;
  neutral?: number | string | null;
  question_set?: string | null;
}

function toCount(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function mapRow(row: RawFramingReceiptRow): FramingReceipt {
  return {
    members: toCount(row.members),
    scored: toCount(row.scored),
    proGovernment: toCount(row.pro_government),
    proOpposition: toCount(row.pro_opposition),
    neutral: toCount(row.neutral),
    questionSet: row.question_set ?? null,
  };
}

/**
 * Plain, uncached fetcher — used by the admin report (/admin/rapor/[id]),
 * which must never use "use cache". Never throws: a missing migration or a
 * Supabase hiccup renders as `null` (the caller's "could not read" state)
 * rather than taking the admin page down.
 */
export async function getClusterFramingReceipt(
  clusterId: string,
): Promise<FramingReceipt | null> {
  try {
    const supabase = createServerClient();

    const { data, error } = await supabase.rpc("cluster_framing_receipt", {
      p_cluster_id: clusterId,
    });

    if (error) {
      console.error(
        `[framing-receipt] cluster framing receipt unavailable: ${error.message}`,
      );
      return null;
    }

    const row = Array.isArray(data) ? data[0] : data;
    if (!row) return null;

    return mapRow(row as RawFramingReceiptRow);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[framing-receipt] cluster framing receipt unavailable: ${message}`,
    );
    return null;
  }
}

/**
 * Cached wrapper used by the public cluster page ONLY. Delegates entirely
 * to getClusterFramingReceipt — this function itself must never read
 * process.env (see isFramingReceiptPublic's doc comment above); the caller
 * checks the flag first and skips awaiting this altogether when it's off,
 * so a flag-off deploy adds zero queries to the hottest public page.
 */
export async function getCachedClusterFramingReceipt(
  clusterId: string,
): Promise<FramingReceipt | null> {
  "use cache";
  cacheLife("cluster-feed");
  cacheTag(`cluster-detail:${clusterId}`, "clusters");
  return getClusterFramingReceipt(clusterId);
}

// Turkish possessive suffix keyed by the number's last significant
// "spoken word" — see the shared contract's section 5 table. Ordinary
// digits (1-9) key off the last digit; round tens (10, 20, ..., 90) key
// off the tens digit; exact multiples of 100 and 1000 use the fixed "yüz"/
// "bin" suffix regardless of the leading digits (200 is "ikiyüzü", not
// "iki" + a digit-2 suffix).
const LAST_DIGIT_SUFFIX: Record<number, string> = {
  1: "i",
  2: "si",
  3: "ü",
  4: "ü",
  5: "i",
  6: "sı",
  7: "si",
  8: "i",
  9: "u",
};

const TENS_DIGIT_SUFFIX: Record<number, string> = {
  1: "u", // 10
  2: "si", // 20
  3: "u", // 30
  4: "ı", // 40
  5: "si", // 50
  6: "ı", // 60
  7: "i", // 70
  8: "i", // 80
  9: "ı", // 90
};

export function numberPossessive(n: number): string {
  const abs = Math.abs(n);
  if (abs === 0) return "0'ı";

  let suffix: string;
  if (abs % 1000 === 0) {
    suffix = "i";
  } else if (abs % 100 === 0) {
    suffix = "ü";
  } else if (abs % 10 === 0) {
    suffix = TENS_DIGIT_SUFFIX[(abs / 10) % 10] ?? "u";
  } else {
    suffix = LAST_DIGIT_SUFFIX[abs % 10] ?? "i";
  }

  return `${abs}'${suffix}`;
}

export function framingReceiptSentence(receipt: FramingReceipt): string {
  const { members, scored, proGovernment, proOpposition, neutral } = receipt;

  if (scored === 0) {
    return `Çerçeveleme makbuzu — bu kümedeki ${members} başlıkta eşiği (0,75) geçen otomatik çerçeve okuması yok.`;
  }

  return `Çerçeveleme makbuzu — bu kümedeki ${members} başlığın ${scored} tanesi eşiği (0,75) geçti; ${numberPossessive(proGovernment)} iktidar lehine, ${numberPossessive(proOpposition)} muhalefet lehine, ${numberPossessive(neutral)} tarafsız ifade taşıyor (otomatik, eşik 0,75)`;
}
