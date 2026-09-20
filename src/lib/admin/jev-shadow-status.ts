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
}

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

export async function getJevShadowStatus(): Promise<JevShadowStatus | null> {
  try {
    const supabase = createServerClient();

    const [agreement24hRes, agreement7dRes, monthRes, queueRes, lastRunRes] =
      await Promise.all([
        supabase.rpc("jev_shadow_agreement", { p_hours: 24 }),
        supabase.rpc("jev_shadow_agreement", { p_hours: 168 }),
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

    return {
      agreement24h: toAgreementRows(agreement24hRes.data),
      agreement7d: toAgreementRows(agreement7dRes.data),
      month: { runs, calls, inputTokens, usd, cap, pct, exceeded },
      lastRun: (lastRunRes.data ?? null) as JevRunRow | null,
      queue: toQueueRows(queueRes.data),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev shadow status unavailable: ${message}`);
    return null;
  }
}
