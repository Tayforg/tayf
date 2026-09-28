import { createServerClient } from "@/lib/supabase/server";

// Pack JEV (migration 061) — the /admin "Jev gölge" section's reader.
// Mirrors src/lib/admin/archive-status.ts's rationale in spirit: /admin is
// cookie-gated and dynamic, so this is a plain async fetcher, NOT
// "use cache". Never throws: a missing migration, a Supabase hiccup, or a
// bad RPC shape all render as a status sentence on the page, never a 500.
// `null` means "could not read"; the section renders a different sentence
// for that than for "read fine, nothing to show yet".

export interface JevAgreementRow {
  task: string;
  total: number;
  agreed: number;
  undecided: number;
  rate: number | null;
}

export interface JevRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  calls: number;
  input_tokens: number;
  errors: number;
  status: string;
  note: string | null;
}

export interface JevQueueRow {
  id: number;
  task: string;
  subject_type: string;
  subject_id: string;
  state_preview: string;
  baseline_answer: string;
  jev_prob: number | null;
  jev_choice: string | null;
  created_at: string;
}

/** 088: one row of jev_budget_daily's per-stage today/yesterday spend. */
export interface JevBudgetRow {
  stage: string;
  today: number | null;
  yesterday: number | null;
  allowance: number | null;
}

export interface JevShadowStatus {
  agreement24h: JevAgreementRow[];
  agreement7d: JevAgreementRow[];
  month: {
    runs: number;
    calls: number;
    inputTokens: number;
    usd: number;
    cap: number;
    pct: number;
    exceeded: boolean;
  };
  lastRun: JevRunRow | null;
  queue: JevQueueRow[];
  /** 088: null when jev_budget_daily is unavailable (migration not yet
   * applied, or a PostgREST error) -- the rest of the status still renders. */
  budget: JevBudgetRow[] | null;
}

/** 088: Turkish display name for every jev-shadow ledger stage key, plus the
 * SQL-only 'live_pair_marginal' and the pre-088 fallback 'unattributed'. An
 * unknown key renders as-is (see toBudgetRows callers). Exported so
 * jev-signals-section.tsx / jev-shadow-section.tsx import the same map. */
export const JEV_STAGE_LABELS_TR: Record<string, string> = {
  articles: "Haberler",
  clusters: "Kümeler",
  blindspot_recall: "Kör nokta geri çağırma",
  pairs: "Eşleşmeler",
  kap: "KAP",
  title_versions: "Başlık değişiklikleri",
  tickers: "Hisse eşleşmeleri",
  "audit:pairs": "Gece denetimi: eşleşmeler",
  "audit:audit_pairs": "Gece denetimi: küme içi",
  "regression:regression_articles": "Regresyon: haberler",
  "regression:regression_pairs": "Regresyon: eşleşmeler",
  live_pair_marginal: "Canlı sınır doğrulama",
  unattributed: "Atanmamış (eski kayıt)",
};

export const JEV_QUEUE_LIMIT = 30;

// Duplicated from JEV_USD_PER_TOKEN in supabase/functions/_shared/jev.ts.
// That module is imported by the Deno Edge Function and must never be
// pulled into the Next.js bundle, so the constant is re-declared here
// rather than imported. Keep the two literals in sync by hand.
const JEV_USD_PER_TOKEN = 42 / 1_000_000_000;

interface RawAgreementRow {
  task: string;
  total: number | string;
  agreed: number | string;
  undecided: number | string;
}

interface RawQueueRow {
  id: number | string;
  task: string;
  subject_type: string;
  subject_id: string;
  state_preview: unknown;
  baseline_answer: unknown;
  jev_prob: number | string | null;
  jev_choice: string | null;
  created_at: string;
}

interface RawMonthUsageRow {
  runs?: number | string;
  calls?: number | string;
  input_tokens?: number | string;
  cap?: number | string;
  exceeded?: boolean;
}

function toAgreementRows(data: unknown): JevAgreementRow[] {
  const rows = Array.isArray(data) ? (data as RawAgreementRow[]) : [];
  return rows.map((row) => {
    const total = Number(row.total);
    const agreed = Number(row.agreed);
    const undecided = Number(row.undecided);
    return {
      task: row.task,
      total,
      agreed,
      undecided,
      rate: total > 0 ? agreed / total : null,
    };
  });
}

// The render-time call site (jev-shadow-section.tsx: row.jev_prob.toFixed(2))
// is guarded only by `!= null`, so a non-number arriving here would throw
// OUTSIDE this module's try/catch and 500 the whole cookie-gated /admin
// page -- explicit coercion, same discipline as toAgreementRows above,
// keeps this module's "never throws" docblock promise true.
function toQueueRows(data: unknown): JevQueueRow[] {
  const rows = Array.isArray(data) ? (data as RawQueueRow[]) : [];
  return rows.map((row) => {
    const p = Number(row.jev_prob);
    return {
      id: Number(row.id),
      task: String(row.task ?? ""),
      subject_type: String(row.subject_type ?? ""),
      subject_id: String(row.subject_id ?? ""),
      state_preview: String(row.state_preview ?? ""),
      baseline_answer: String(row.baseline_answer ?? ""),
      jev_prob: Number.isFinite(p) ? p : null,
      jev_choice: row.jev_choice === null || row.jev_choice === undefined ? null : String(row.jev_choice),
      created_at: String(row.created_at ?? ""),
    };
  });
}

interface RawBudgetRow {
  day?: string | null;
  stage?: string | null;
  tokens?: number | string | null;
  allowance?: number | string | null;
}

/** Pure, exported (088): groups jev_budget_daily's per-day rows by stage,
 * coerces numbers (PostgREST may send strings), maps day === todayUtc to
 * `today` and the day before to `yesterday`, and sorts by yesterday desc. */
export function toBudgetRows(data: unknown, todayUtc: string): JevBudgetRow[] {
  const rows = Array.isArray(data) ? (data as RawBudgetRow[]) : [];
  const yesterdayUtc = new Date(Date.parse(`${todayUtc}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);

  const byStage = new Map<string, JevBudgetRow>();
  for (const row of rows) {
    const stage = String(row.stage ?? "");
    if (!stage) continue;
    const day = String(row.day ?? "");
    const tokens = row.tokens === null || row.tokens === undefined ? null : Number(row.tokens);
    const allowance = row.allowance === null || row.allowance === undefined ? null : Number(row.allowance);
    const existing = byStage.get(stage) ?? { stage, today: null, yesterday: null, allowance: null };
    if (allowance !== null && Number.isFinite(allowance)) existing.allowance = allowance;
    if (day === todayUtc) {
      existing.today = tokens !== null && Number.isFinite(tokens) ? tokens : null;
    } else if (day === yesterdayUtc) {
      existing.yesterday = tokens !== null && Number.isFinite(tokens) ? tokens : null;
    }
    byStage.set(stage, existing);
  }

  return [...byStage.values()].sort((a, b) => (b.yesterday ?? -Infinity) - (a.yesterday ?? -Infinity));
}

/** 088: fetched OUTSIDE the load-bearing error loop -- a failure or throw
 * here logs once and returns null, but never nulls the rest of the status. */
async function fetchBudgetRows(
  supabase: ReturnType<typeof createServerClient>,
): Promise<JevBudgetRow[] | null> {
  try {
    const todayUtc = new Date(Date.now()).toISOString().slice(0, 10);
    const { data, error } = await supabase.rpc("jev_budget_daily", { p_days: 2 });
    if (error) {
      console.error(`[admin] jev_budget_daily unavailable: ${error.message}`);
      return null;
    }
    return toBudgetRows(data, todayUtc);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev_budget_daily unavailable: ${message}`);
    return null;
  }
}

export async function getJevShadowStatus(): Promise<JevShadowStatus | null> {
  try {
    const supabase = createServerClient();

    const [agreement24hRes, agreement7dRes, monthRes, queueRes, lastRunRes] =
      await Promise.all([
        supabase.rpc("jev_shadow_agreement", { p_hours: 24 }),
        // Migration 081: the 7-day window now reads jev_shadow_agreement_rollup
        // (complete UTC days from jev_shadow_daily + today's raw tail), not a
        // rolling 168h scan of jev_shadow_predictions — that table grows
        // ~50 MB/day and is never pruned, so the raw scan only gets slower
        // over time. "7 days" here means 6 complete UTC days plus today, not
        // a rolling 168 hours. Falls back to the original raw
        // jev_shadow_agreement({p_hours:168}) call only if the rollup RPC
        // errors (e.g. migration 081 not yet applied) — same output shape
        // (task, total, agreed, undecided), so toAgreementRows and
        // JevShadowStatus are unchanged either way.
        (async () => {
          const r = await supabase.rpc("jev_shadow_agreement_rollup", { p_days: 7 });
          if (!r.error) return r;
          console.warn(
            `[admin] jev_shadow_agreement_rollup unavailable, using raw 168h: ${r.error.message}`,
          );
          return supabase.rpc("jev_shadow_agreement", { p_hours: 168 });
        })(),
        // No p_cap argument — the SQL default is the single source of
        // truth for the monthly cap (see migration 061's comment on
        // jev_shadow_month_usage()).
        supabase.rpc("jev_shadow_month_usage"),
        supabase.rpc("jev_shadow_queue", { p_limit: JEV_QUEUE_LIMIT }),
        supabase
          .from("jev_shadow_runs")
          .select(
            "id, started_at, finished_at, calls, input_tokens, errors, status, note",
          )
          .order("id", { ascending: false })
          .limit(1)
          .maybeSingle(),
      ]);

    for (const res of [agreement24hRes, agreement7dRes, monthRes, queueRes, lastRunRes]) {
      if (res.error) {
        console.error(`[admin] jev shadow status unavailable: ${res.error.message}`);
        return null;
      }
    }

    const monthRows = Array.isArray(monthRes.data)
      ? (monthRes.data as RawMonthUsageRow[])
      : monthRes.data
        ? [monthRes.data as RawMonthUsageRow]
        : [];
    const monthRow = monthRows[0];

    const runs = Number(monthRow?.runs ?? 0);
    const calls = Number(monthRow?.calls ?? 0);
    const inputTokens = Number(monthRow?.input_tokens ?? 0);
    const cap = Number(monthRow?.cap ?? 0);
    const exceeded = Boolean(monthRow?.exceeded ?? false);
    const usd = inputTokens * JEV_USD_PER_TOKEN;
    const pct = cap > 0 ? Math.round((inputTokens / cap) * 100) : 0;

    // 088: fetched after the load-bearing Promise.all above resolves, so a
    // jev_budget_daily failure (088 not yet applied, or a PostgREST hiccup)
    // never nulls agreement/month/lastRun/queue -- only budget goes null.
    const budget = await fetchBudgetRows(supabase);

    return {
      agreement24h: toAgreementRows(agreement24hRes.data),
      agreement7d: toAgreementRows(agreement7dRes.data),
      month: { runs, calls, inputTokens, usd, cap, pct, exceeded },
      lastRun: (lastRunRes.data ?? null) as JevRunRow | null,
      queue: toQueueRows(queueRes.data),
      budget,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev shadow status unavailable: ${message}`);
    return null;
  }
}
