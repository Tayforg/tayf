import type { SupabaseClient } from "@supabase/supabase-js";

// Migration 069, B7 — the daily USD spend ledger for /api/cron/headline's
// LLM branch. Mirrors migration 061's jev_shadow_runs +
// jev_shadow_month_usage() spend pattern in spirit (one durable row the
// route upserts into and reads back before spending more), but the cap
// lives in the runtime env (HEADLINE_LLM_DAILY_USD_CAP, default 2.00 USD
// per UTC day) rather than a SQL default, because this ledger is read and
// enforced entirely inside the Next.js route, not inside a Postgres
// function.
//
// COST ESTIMATE, NOT AN INVOICE: HEADLINE_LLM_USD_PER_INPUT_TOKEN /
// HEADLINE_LLM_USD_PER_OUTPUT_TOKEN are hand-duplicated claude-haiku-4-5
// list prices. They must be re-checked by hand whenever LLM_MODEL changes
// — nothing here reads the vendor's real invoice, so a stale rate silently
// guards the wrong number. See docs/migration-guide.md's 069 section.

export const HEADLINE_LLM_DAILY_USD_CAP_DEFAULT = 2.0;

// claude-haiku-4-5 list price, hand-duplicated — keep in sync by hand.
export const HEADLINE_LLM_USD_PER_INPUT_TOKEN = 1 / 1_000_000;
export const HEADLINE_LLM_USD_PER_OUTPUT_TOKEN = 5 / 1_000_000;

let loggedCapFallback = false;

/**
 * Reads HEADLINE_LLM_DAILY_USD_CAP from the runtime env. A NaN, <= 0, or
 * non-finite value (including "unset") falls back to
 * HEADLINE_LLM_DAILY_USD_CAP_DEFAULT and logs the fallback once per module
 * lifetime (not once per call) so a mis-configured deploy is obvious in
 * the boot/build log without spamming it every cron tick.
 */
export function headlineLlmDailyCapUsd(): number {
  const raw = process.env.HEADLINE_LLM_DAILY_USD_CAP;
  const n = Number(raw);
  if (raw === undefined || raw === "" || !Number.isFinite(n) || n <= 0) {
    if (!loggedCapFallback) {
      console.warn(
        "[headline-cron] HEADLINE_LLM_DAILY_USD_CAP unset or invalid; falling back to",
        HEADLINE_LLM_DAILY_USD_CAP_DEFAULT,
      );
      loggedCapFallback = true;
    }
    return HEADLINE_LLM_DAILY_USD_CAP_DEFAULT;
  }
  return n;
}

/** "YYYY-MM-DD" for `now` (default: the current time) in UTC. */
export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Estimated USD cost of one LLM call from its input/output token counts. */
export function estimateCallUsd(inputTokens: number, outputTokens: number): number {
  return (
    inputTokens * HEADLINE_LLM_USD_PER_INPUT_TOKEN +
    outputTokens * HEADLINE_LLM_USD_PER_OUTPUT_TOKEN
  );
}

export interface HeadlineBudgetRow {
  day: string;
  calls: number;
  input_tokens: number;
  output_tokens: number;
  usd: number;
  eligible_n: number;
  ineligible_n: number;
}

interface RawHeadlineBudgetRow {
  day: string;
  calls: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  usd: number | string;
  eligible_n: number | string;
  ineligible_n: number | string;
}

/**
 * Reads today's (or `day`'s) llm_budget_daily row via an explicit column
 * list — never `select("*")`. Returns null on ANY error or when no row
 * exists yet for that day (a fresh day with zero LLM calls is not an
 * error).
 */
export async function readHeadlineBudget(
  supabase: SupabaseClient,
  day: string,
): Promise<HeadlineBudgetRow | null> {
  try {
    const { data, error } = await supabase
      .from("llm_budget_daily")
      .select("day, calls, input_tokens, output_tokens, usd, eligible_n, ineligible_n")
      .eq("day", day)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as RawHeadlineBudgetRow;
    return {
      day: String(row.day),
      calls: Number(row.calls),
      input_tokens: Number(row.input_tokens),
      output_tokens: Number(row.output_tokens),
      usd: Number(row.usd),
      eligible_n: Number(row.eligible_n),
      ineligible_n: Number(row.ineligible_n),
    };
  } catch (err) {
    console.error("[headline-cron] readHeadlineBudget failed", err);
    return null;
  }
}

/**
 * Upserts one LLM call's cost via `rpc("llm_budget_add", ...)` and returns
 * the day's NEW cumulative USD (the value the database returned — the
 * caller's next cap check must use this, never a locally-accumulated
 * total). Returns null on any error.
 */
export async function addHeadlineBudget(
  supabase: SupabaseClient,
  a: { day: string; calls: number; inputTokens: number; outputTokens: number; usd: number },
): Promise<number | null> {
  try {
    const { data, error } = await supabase.rpc("llm_budget_add", {
      p_day: a.day,
      p_calls: a.calls,
      p_in: a.inputTokens,
      p_out: a.outputTokens,
      p_usd: a.usd,
    });
    if (error) {
      console.error("[headline-cron] llm_budget_add failed", error);
      return null;
    }
    const n = Number(data);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    console.error("[headline-cron] llm_budget_add failed", err);
    return null;
  }
}

/**
 * Best-effort `rpc("llm_budget_gate", ...)` — records this cron cycle's
 * eligible/ineligible outcome counts. Swallows any error after logging it:
 * a gate-count write failure must never turn a cron cycle into a 500.
 */
export async function addHeadlineGateCounts(
  supabase: SupabaseClient,
  a: { day: string; eligible: number; ineligible: number },
): Promise<void> {
  try {
    const { error } = await supabase.rpc("llm_budget_gate", {
      p_day: a.day,
      p_eligible: a.eligible,
      p_ineligible: a.ineligible,
    });
    if (error) {
      console.error("[headline-cron] llm_budget_gate failed", error);
    }
  } catch (err) {
    console.error("[headline-cron] llm_budget_gate failed", err);
  }
}
