import { createServerClient } from "@/lib/supabase/server";
import { headlineLlmDailyCapUsd, utcDay } from "@/lib/headline/budget";

// Migration 069 (B7) — the /admin "Başlık LLM bütçesi" section's reader.
// Modeled on src/lib/admin/jev-shadow-status.ts: /admin is cookie-gated and
// dynamic, so this is a plain async fetcher, NOT "use cache". Never throws:
// a missing migration or a Supabase hiccup renders as
// "Başlık LLM bütçesi okunamadı." on the page, never a 500. `null` means
// "could not read" — distinct from a legitimate day with zero LLM calls
// yet, which renders its own "Bugün başlık LLM çağrısı yok." sentence, so
// this module reads llm_budget_daily directly (rather than reusing
// src/lib/headline/budget.ts's readHeadlineBudget, which collapses "no row
// yet" and "read error" into the same null) to keep those two states
// distinguishable.

export interface LlmBudgetStatus {
  day: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  usd: number;
  cap: number;
  pct: number;
  exceeded: boolean;
  eligibleN: number;
  ineligibleN: number;
  eligibleShare: number | null;
}

interface RawBudgetRow {
  day: string;
  calls: number | string;
  input_tokens: number | string;
  output_tokens: number | string;
  usd: number | string;
  eligible_n: number | string;
  ineligible_n: number | string;
}

export async function getLlmBudgetStatus(): Promise<LlmBudgetStatus | null> {
  try {
    const supabase = createServerClient();
    const day = utcDay();
    const cap = headlineLlmDailyCapUsd();

    const { data, error } = await supabase
      .from("llm_budget_daily")
      .select("day, calls, input_tokens, output_tokens, usd, eligible_n, ineligible_n")
      .eq("day", day)
      .maybeSingle();

    if (error) {
      console.error(`[admin] llm budget status unavailable: ${error.message}`);
      return null;
    }

    if (!data) {
      // No row for today yet — a legitimate "nothing has spent" state,
      // not an error.
      return {
        day,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        usd: 0,
        cap,
        pct: 0,
        exceeded: false,
        eligibleN: 0,
        ineligibleN: 0,
        eligibleShare: null,
      };
    }

    const row = data as RawBudgetRow;
    const calls = Number(row.calls);
    const inputTokens = Number(row.input_tokens);
    const outputTokens = Number(row.output_tokens);
    const usd = Number(row.usd);
    const eligibleN = Number(row.eligible_n);
    const ineligibleN = Number(row.ineligible_n);
    const pct = cap > 0 ? Math.round((usd / cap) * 100) : 0;
    const exceeded = usd >= cap;
    const denominator = eligibleN + ineligibleN;
    const eligibleShare = denominator > 0 ? eligibleN / denominator : null;

    return {
      day: String(row.day),
      calls,
      inputTokens,
      outputTokens,
      usd,
      cap,
      pct,
      exceeded,
      eligibleN,
      ineligibleN,
      eligibleShare,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] llm budget status unavailable: ${message}`);
    return null;
  }
}
