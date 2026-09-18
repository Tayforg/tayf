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

import { type DailyBar, type IntradayBar, parseDailyBars, parseIntradayBars, yahooChartUrl } from "../_shared/bars.ts";
import { fetchWithRetry, TAYF_BOT_UA } from "../_shared/kap.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";

await initSentry("quotes-ingest");

const CYCLE_DEADLINE_MS = 50_000;
const FETCH_TIMEOUT_MS = 8_000;
const CONCURRENCY = 6;
const DAILY_LIMIT = 80;
const INTRADAY_LIMIT = 120;
const UPSERT_BATCH = 1000;
const HEADERS = { "User-Agent": TAYF_BOT_UA };

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
  /** false when every target ticker failed — SEC-05, so a total feed
   *  outage doesn't look like a healthy 200 in the cron logs. */
  ok: boolean;
}

// SEC-07: maxBackoffMs is bounded well below the default 30s — a worker
// asleep in backoff only checks CYCLE_DEADLINE_MS at task entry (`pool`
// below), so an unbounded sleep here can overshoot the 50s cycle deadline
// and the pg_net cron's 60s timeout. 5s keeps a full retry+backoff sequence
// inside the 8s per-fetch timeout with room for CONCURRENCY=6 workers to
// still finish inside the cycle.
const RETRY_MAX_BACKOFF_MS = 5_000;

async function fetchChart(ticker: string, range: string, interval: string): Promise<unknown> {
  const res = await fetchWithRetry(
    yahooChartUrl(ticker, range, interval),
    { headers: HEADERS },
    // SEC-07: a fresh per-attempt timeout signal, built by fetchWithRetry
    // itself, instead of a single AbortSignal.timeout() constructed here
    // that starts counting before the retry loop's backoff sleeps even run
    // (a Retry-After >= the remaining budget would abort the retried fetch
    // instantly and turn a legible 429 into an opaque AbortError).
    { timeoutMs: FETCH_TIMEOUT_MS, maxBackoffMs: RETRY_MAX_BACKOFF_MS },
  );
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

// TS-08 (caller half): best-effort Next.js cache revalidation, mirroring
// cluster-consumer's triggerRevalidation (REVALIDATE_URL + CRON_SECRET
// bearer, 2s timeout, every failure logged and swallowed).
async function triggerRevalidation(tags: string[]): Promise<void> {
  const revalidateUrl = Deno.env.get("REVALIDATE_URL");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!revalidateUrl || !cronSecret) {
    console.warn("[quotes-ingest] REVALIDATE_URL/CRON_SECRET unset; skipping revalidation");
    return;
  }
  try {
    const res = await fetch(revalidateUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cronSecret}` },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) console.warn(`[quotes-ingest] revalidation POST returned ${res.status}`);
  } catch (err) {
    console.warn(`[quotes-ingest] revalidation POST failed: ${err instanceof Error ? err.message : err}`);
  }
}

export async function runCycle(body: Body): Promise<Stats> {
  const startedAt = Date.now();
  const deadline = startedAt + CYCLE_DEADLINE_MS;
  const mode = body.mode === "intraday" ? "intraday" : "daily";
  const stats: Stats = { mode, tickers: 0, fetched: 0, bars: 0, failed: [], durationMs: 0, ok: true };
  const supabase = createServiceClient();

  // Target list: explicit override, else the SQL helpers from 051/058.
  let targets: Array<{ ticker: string; last_day?: string | null; last_ts?: string | null }>;
  if (body.tickers?.length) {
    targets = body.tickers.map((t) => ({ ticker: t.toUpperCase() }));
  } else if (mode === "daily") {
    const { data, error } = await supabase.rpc("bist_daily_targets", { p_limit: DAILY_LIMIT });
    if (error) throw new Error(`[quotes-ingest] bist_daily_targets: ${error.message}`);
    targets = (data ?? []) as Array<{ ticker: string; last_day: string | null }>;
  } else {
    // TS-02: the alphabetical zero-arg overload is gone in 058 — an
    // unlimited, ordered-by-oldest set replaces the alphabetical scan so
    // the tail of the alphabet (THYAO, TTKOM, VESTL, ...) stops starving.
    // DB-03: bist_intraday_targets(int) now also returns each ticker's own
    // max(ts) (058's `b` subquery), which is the per-ticker watermark below
    // — no separate, LIMIT-capped, ungrouped bist_bars_5m read is needed
    // (that read could return an arbitrary ~25-ticker slice of a
    // multi-thousand-row window and silently truncate the watermark).
    const { data, error } = await supabase.rpc("bist_intraday_targets", { p_limit: INTRADAY_LIMIT });
    if (error) throw new Error(`[quotes-ingest] bist_intraday_targets: ${error.message}`);
    targets = (data ?? []) as Array<{ ticker: string; last_ts: string | null }>;
  }
  stats.tickers = targets.length;

  // DB-03: watermark per ticker (max known bar timestamp / day), not just a
  // boolean "has any". Re-fetching and re-upserting every bar in range on
  // every cycle was 42.4M row updates against 229k live rows (185 rewrites
  // per row) — only the current partial bar plus genuinely new bars need
  // to be written. Seeded directly from `targets` (bist_intraday_targets
  // already computes max(ts) per ticker) rather than a second query.
  const lastIntradayTs = new Map<string, number>();
  if (mode === "intraday") {
    for (const t of targets) {
      if (t.last_ts) lastIntradayTs.set(t.ticker, Date.parse(t.last_ts));
    }
  }

  const daily: DailyBar[] = [];
  const intraday: IntradayBar[] = [];
  await pool(targets, async (t) => {
    if (Date.now() > deadline) {
      stats.failed.push(`${t.ticker}:deadline`);
      return;
    }
    try {
      if (mode === "daily") {
        const range = body.range ?? (t.last_day ? "1mo" : "1y");
        const rows = parseDailyBars(t.ticker, await fetchChart(t.ticker, range, "1d"));
        // Same watermark guard as intraday, keyed on the calendar day
        // instead of a timestamp — a ticker with no last_day (never
        // fetched) keeps the full 1y/1mo warmup, unfiltered.
        const fresh = t.last_day ? rows.filter((r) => r.day >= t.last_day!) : rows;
        daily.push(...fresh);
        stats.bars += fresh.length;
      } else {
        const last = lastIntradayTs.get(t.ticker);
        // No bars yet -> full 5d warmup, unfiltered (DB-03).
        const range = body.range ?? (last !== undefined ? "1d" : "5d");
        const rows = parseIntradayBars(t.ticker, await fetchChart(t.ticker, range, "5m"));
        const fresh = last !== undefined ? rows.filter((r) => Date.parse(r.ts) >= last) : rows;
        intraday.push(...fresh);
        stats.bars += fresh.length;
      }
      stats.fetched++;
    } catch (err) {
      stats.failed.push(`${t.ticker}:${err instanceof Error ? err.message : String(err)}`);
    }
  });

  if (daily.length) await upsertBars(supabase, "bist_bars_daily", daily, "ticker,day");
  if (intraday.length) await upsertBars(supabase, "bist_bars_5m", intraday, "ticker,ts");

  // SEC-05: a total feed outage (every target ticker failed) must not look
  // like a healthy 200 — that was the whole point of the finding.
  if (stats.tickers > 0 && stats.fetched === 0) {
    stats.ok = false;
    captureException(
      "quotes-ingest",
      new Error(`all ${stats.tickers} tickers failed: ${stats.failed.slice(0, 5).join(",")}`),
    );
  }

  stats.durationMs = Date.now() - startedAt;
  console.log("[quotes-ingest] cycle", JSON.stringify(stats));
  if (stats.ok) await triggerRevalidation(["finance-bars"]);
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
    // SEC-05: a total-outage cycle reports ok:false with a non-2xx status
    // so the cron run shows red instead of a green 200. `stats` already
    // carries `ok`, so no separate wrapper field is needed here.
    return new Response(JSON.stringify(stats), {
      status: stats.ok ? 200 : 502,
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
