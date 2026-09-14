// supabase/functions/quotes-ingest/index.ts
//
// Fills bist_bars_daily and bist_bars_5m from Yahoo's chart endpoint
// (<CODE>.IS). Two modes, both poked by pg_cron (migration 051):
//
//   POST {"mode":"daily"}     the 80 stalest traded tickers (never-fetched
//                             first): 1y of daily bars when empty, else 1mo.
//                             Runs every 3 min after the close until every
//                             ticker has the session's bar.
//   POST {"mode":"intraday"}  every ticker named in the news in the last
//                             7 days: today's 5-minute bars (5d when the
//                             ticker has none yet). Every 5 min in session.
//
// Optional {"tickers":["THYAO"],"range":"1y"} overrides the target list.

import { parseDailyBars, parseIntradayBars, yahooChartUrl } from "../_shared/bars.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";

await initSentry("quotes-ingest");

const CYCLE_DEADLINE_MS = 50_000;
const FETCH_TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;
const DAILY_LIMIT = 80;
const UPSERT_BATCH = 1000;
const HEADERS = { "User-Agent": "Mozilla/5.0 (tayf.news quotes-ingest)" };

interface Body {
  mode?: "daily" | "intraday";
  tickers?: string[];
  range?: string;
}

interface Stats {
  mode: string;
  tickers: number;
  fetched: number;
  bars: number;
  failed: string[];
  durationMs: number;
}

async function fetchChart(ticker: string, range: string, interval: string): Promise<unknown> {
  const res = await fetch(yahooChartUrl(ticker, range, interval), {
    headers: HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  return res.json();
}

async function pool<T>(items: T[], worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const run = async () => {
    for (let it = queue.shift(); it !== undefined; it = queue.shift()) await worker(it);
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, run));
}

async function upsertBars(
  supabase: ReturnType<typeof createServiceClient>,
  table: "bist_bars_daily" | "bist_bars_5m",
  rows: unknown[],
  onConflict: string,
): Promise<void> {
  for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + UPSERT_BATCH), { onConflict });
    if (error) throw new Error(`[quotes-ingest] ${table} upsert: ${error.message}`);
  }
}

export async function runCycle(body: Body): Promise<Stats> {
  const startedAt = Date.now();
  const deadline = startedAt + CYCLE_DEADLINE_MS;
  const mode = body.mode === "intraday" ? "intraday" : "daily";
  const stats: Stats = { mode, tickers: 0, fetched: 0, bars: 0, failed: [], durationMs: 0 };
  const supabase = createServiceClient();

  // Target list: explicit override, else the SQL helpers from 051.
  let targets: Array<{ ticker: string; last_day?: string | null }>;
  if (body.tickers?.length) {
    targets = body.tickers.map((t) => ({ ticker: t.toUpperCase() }));
  } else if (mode === "daily") {
    const { data, error } = await supabase.rpc("bist_daily_targets", { p_limit: DAILY_LIMIT });
    if (error) throw new Error(`[quotes-ingest] bist_daily_targets: ${error.message}`);
    targets = (data ?? []) as Array<{ ticker: string; last_day: string | null }>;
  } else {
    const { data, error } = await supabase.rpc("bist_intraday_targets");
    if (error) throw new Error(`[quotes-ingest] bist_intraday_targets: ${error.message}`);
    targets = (data ?? []) as Array<{ ticker: string }>;
  }
  stats.tickers = targets.length;

  // For intraday, tickers with no 5m bars yet get 5 days so the chart has
  // something to show immediately.
  let has5m = new Set<string>();
  if (mode === "intraday" && targets.length > 0) {
    const { data } = await supabase
      .from("bist_bars_5m")
      .select("ticker")
      .in("ticker", targets.map((t) => t.ticker))
      .gte("ts", new Date(Date.now() - 2 * 86400 * 1000).toISOString())
      .limit(5000);
    has5m = new Set(((data ?? []) as Array<{ ticker: string }>).map((r) => r.ticker));
  }

  const daily: unknown[] = [];
  const intraday: unknown[] = [];
  await pool(targets, async (t) => {
    if (Date.now() > deadline) {
      stats.failed.push(`${t.ticker}:deadline`);
      return;
    }
    try {
      if (mode === "daily") {
        const range = body.range ?? (t.last_day ? "1mo" : "1y");
        const rows = parseDailyBars(t.ticker, await fetchChart(t.ticker, range, "1d"));
        daily.push(...rows);
        stats.bars += rows.length;
      } else {
        const range = body.range ?? (has5m.has(t.ticker) ? "1d" : "5d");
        const rows = parseIntradayBars(t.ticker, await fetchChart(t.ticker, range, "5m"));
        intraday.push(...rows);
        stats.bars += rows.length;
      }
      stats.fetched++;
    } catch (err) {
      stats.failed.push(`${t.ticker}:${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (daily.length) await upsertBars(supabase, "bist_bars_daily", daily, "ticker,day");
  if (intraday.length) await upsertBars(supabase, "bist_bars_5m", intraday, "ticker,ts");

  stats.durationMs = Date.now() - startedAt;
  console.log("[quotes-ingest] cycle", JSON.stringify(stats));
  return stats;
}

Deno.serve(withSentry("quotes-ingest", async (req: Request) => {
  const denied = requireServiceRoleBearer(req);
  if (denied) return denied;
  if (req.method === "GET") {
    return new Response(JSON.stringify({ ok: true, ready: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  let body: Body = {};
  try {
    const text = await req.text();
    if (text.trim()) body = JSON.parse(text) as Body;
  } catch {
    return new Response(JSON.stringify({ ok: false, error: "bad-json" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  try {
    const stats = await runCycle(body);
    return new Response(JSON.stringify({ ok: true, ...stats }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const request_id = crypto.randomUUID();
    captureException("quotes-ingest", err);
    console.error(`[quotes-ingest] ${request_id}`, err);
    return new Response(JSON.stringify({ ok: false, error: "internal-error", request_id }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}));
