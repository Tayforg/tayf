import { createServerClient } from "@/lib/supabase/server";

// Pack B2 "Metodoloji regresyonu" (migration 066) — the /admin reader for
// the frozen regression set that jev-shadow (mode: "regression") replays
// weekly against the current question set. Mirrors
// src/lib/admin/jev-shadow-status.ts's rationale: /admin is cookie-gated
// and dynamic (cacheComponents: true), so this is a plain async fetcher —
// it must never opt into the RSC cache directive. Every export here must
// never throw — a throw here would 500 the whole cookie-gated /admin
// page, so a missing table, a bad RPC/query shape, a malformed `deltas`
// jsonb blob, or a Supabase hiccup all degrade to `null` (or null fields
// inside a row) instead.

export const JEV_REGRESSION_RUN_LIMIT = 5;

export interface JevRegressionItemCounts {
  articles: number;
  pairs: number;
  inGold: number;
}

export interface JevRegressionRunView {
  id: number;
  questionSet: string;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  items: number;
  calls: number;
  flipRate: number | null;
  firstRun: boolean;
  flips: { politics: number | null; topic: number | null; pair: number | null };
  /** correct_070 / n, or null when n === 0 (or the field is missing/malformed). */
  goldPolitics070: number | null;
}

export interface JevRegressionStatus {
  counts: JevRegressionItemCounts;
  runs: JevRegressionRunView[];
}

interface RawRunRow {
  id?: unknown;
  question_set?: unknown;
  started_at?: unknown;
  finished_at?: unknown;
  status?: unknown;
  items?: unknown;
  calls?: unknown;
  deltas?: unknown;
}

interface DeltaTaskShape {
  flips?: unknown;
}

interface DeltaGoldPoliticsShape {
  n?: unknown;
  correct_070?: unknown;
}

interface DeltaShape {
  first_run?: unknown;
  tasks?: {
    politics?: DeltaTaskShape;
    topic?: DeltaTaskShape;
    pair_negative?: DeltaTaskShape;
  };
  overall?: { flip_rate?: unknown };
  gold?: { politics?: DeltaGoldPoliticsShape };
}

/**
 * Coerces an unknown value (a raw jsonb field, a PostgREST count, a
 * string-shaped number, whatever) to a finite number, or `null`. The
 * single chokepoint every numeric field in this module passes through —
 * see the module docblock's "never throws / never NaN" promise.
 */
function num(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asObject<T>(value: unknown): T | undefined {
  return value && typeof value === "object" ? (value as T) : undefined;
}

/**
 * Pure, exported for tests. Reads the contract-C `deltas` jsonb shape
 * defensively — the shared contract says every key is "possibly
 * absent/malformed", so this must survive a null `row`, a `deltas` that
 * is a string, `{}`, `{ first_run: true }`, and a `gold.politics.n` of 0
 * (which must render as null, not NaN, for goldPolitics070) without ever
 * throwing.
 */
export function toRegressionRunView(row: unknown): JevRegressionRunView {
  const r = asObject<RawRunRow>(row) ?? {};
  const deltas = asObject<DeltaShape>(r.deltas) ?? {};
  const tasks = asObject<NonNullable<DeltaShape["tasks"]>>(deltas.tasks);
  const overall = asObject<NonNullable<DeltaShape["overall"]>>(deltas.overall);
  const gold = asObject<NonNullable<DeltaShape["gold"]>>(deltas.gold);
  const goldPolitics = asObject<DeltaGoldPoliticsShape>(gold?.politics);

  const goldN = num(goldPolitics?.n);
  const goldCorrect070 = num(goldPolitics?.correct_070);
  const goldPolitics070 =
    goldN !== null && goldN > 0 && goldCorrect070 !== null ? goldCorrect070 / goldN : null;

  return {
    id: num(r.id) ?? 0,
    questionSet: str(r.question_set),
    startedAt: str(r.started_at),
    finishedAt: r.finished_at === null || r.finished_at === undefined ? null : str(r.finished_at),
    status: str(r.status),
    items: num(r.items) ?? 0,
    calls: num(r.calls) ?? 0,
    flipRate: num(overall?.flip_rate),
    firstRun: deltas.first_run === true,
    flips: {
      politics: num(tasks?.politics?.flips),
      topic: num(tasks?.topic?.flips),
      pair: num(tasks?.pair_negative?.flips),
    },
    goldPolitics070,
  };
}

/**
 * Item counts (frozen set size) + the last JEV_REGRESSION_RUN_LIMIT runs,
 * fired as four queries in one Promise.all. Never throws — see module
 * docblock. `null` means "could not read"; the section renders a
 * different sentence for that than for "read fine, nothing to show yet".
 */
export async function getJevRegressionStatus(): Promise<JevRegressionStatus | null> {
  try {
    const supabase = createServerClient();

    const [articlesRes, pairsRes, goldRes, runsRes] = await Promise.all([
      supabase
        .from("jev_regression_items")
        .select("id", { count: "exact", head: true })
        .eq("kind", "article"),
      supabase
        .from("jev_regression_items")
        .select("id", { count: "exact", head: true })
        .eq("kind", "pair"),
      supabase
        .from("jev_regression_items")
        .select("id", { count: "exact", head: true })
        .eq("in_gold", true),
      supabase
        .from("jev_regression_runs")
        .select("id, question_set, started_at, finished_at, status, items, calls, deltas")
        .order("id", { ascending: false })
        .limit(JEV_REGRESSION_RUN_LIMIT),
    ]);

    for (const res of [articlesRes, pairsRes, goldRes, runsRes]) {
      if (res.error) {
        console.error(`[admin] jev regression status unavailable: ${res.error.message}`);
        return null;
      }
    }

    const runRows = Array.isArray(runsRes.data) ? runsRes.data : [];

    return {
      counts: {
        articles: num(articlesRes.count) ?? 0,
        pairs: num(pairsRes.count) ?? 0,
        inGold: num(goldRes.count) ?? 0,
      },
      runs: runRows.map(toRegressionRunView),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] jev regression status unavailable: ${message}`);
    return null;
  }
}
