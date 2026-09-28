import { createServerClient } from "@/lib/supabase/server";

// Topic (7) ölçütleri (migration 090, T7a): a nightly rollup of topic7
// disagreement measures (jev_topic7_yardsticks()). Fail-soft, same
// discipline as every other /admin getter in this package: a missing
// migration, a bad RPC shape or a Supabase hiccup all render as the page's
// Turkish empty/error sentence, never a 500. No "use cache" -- /admin is
// cookie-gated and dynamic.

export interface JevTopic7YardstickRow {
  questionKey: string;
  questionSet: string | null;
  n: number;
  feedAgree: number | null;
  sectionN: number;
  sectionAgree: number | null;
  p080Share: number | null;
  genelShare: number | null;
  politikaShare: number | null;
  dunyaShare: number | null;
}

interface RawJevTopic7YardstickRow {
  question_key?: string | null;
  question_set?: string | null;
  n?: number | string;
  feed_agree?: number | string | null;
  section_n?: number | string;
  section_agree?: number | string | null;
  p080_share?: number | string | null;
  genel_share?: number | string | null;
  politika_share?: number | string | null;
  dunya_share?: number | string | null;
}

function toNum(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function toRate(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Coerce PostgREST rows to JevTopic7YardstickRow[], never producing NaN. */
export function toYardstickRows(data: unknown): JevTopic7YardstickRow[] {
  const rows = Array.isArray(data) ? (data as RawJevTopic7YardstickRow[]) : [];
  return rows
    .filter((r) => r !== null && typeof r === "object" && typeof r.question_key === "string")
    .map((r) => ({
      questionKey: String(r.question_key),
      questionSet: r.question_set === null || r.question_set === undefined ? null : String(r.question_set),
      n: toNum(r.n),
      feedAgree: toRate(r.feed_agree),
      sectionN: toNum(r.section_n),
      sectionAgree: toRate(r.section_agree),
      p080Share: toRate(r.p080_share),
      genelShare: toRate(r.genel_share),
      politikaShare: toRate(r.politika_share),
      dunyaShare: toRate(r.dunya_share),
    }));
}

/**
 * Short display form of a question_key: the first 8 hex chars of a
 * question_hash fingerprint, or "{question_set} (eski)" for the legacy
 * "qs:<question_set>" keys used before the fingerprint existed.
 */
export function shortQuestionKey(key: string): string {
  if (key.startsWith("qs:")) {
    const questionSet = key.slice(3);
    return `${questionSet} (eski)`;
  }
  return key.slice(0, 8);
}

export async function getJevTopic7Yardsticks(days = 7): Promise<JevTopic7YardstickRow[] | null> {
  try {
    const supabase = createServerClient();
    const { data, error } = await supabase.rpc("jev_topic7_yardsticks", { p_days: days });

    if (error) {
      console.error(`[admin] jev topic7 yardsticks unavailable: ${error.message}`);
      return null;
    }

    return toYardstickRows(data);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev topic7 yardsticks unavailable: ${message}`);
    return null;
  }
}
