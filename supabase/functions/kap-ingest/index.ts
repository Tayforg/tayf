// supabase/functions/kap-ingest/index.ts
//
// Pulls KAP disclosures into `kap_disclosures` and (on demand) the BIST
// company list into `bist_companies` + `bist_aliases`. Poked by pg_cron
// `kap-drain` every 10 min (migration 049) with an empty body, which means
// "yesterday and today, Istanbul time". Backfill by POSTing explicit dates:
//
//   POST {}                                      -> last two Istanbul days
//   POST {"from":"2024-01-01","to":"2024-01-31"} -> that range, one day per
//                                                   KAP query (2000-row cap)
//   POST {"companies":true}                      -> refresh company/ticker map
//
// scripts/kap-backfill.mjs walks a long range a few days per call so each
// invocation stays inside the 50 s budget.

import {
  type BistCompanyRow,
  fetchWithRetry,
  KAP_BASE,
  KAP_CLASSES,
  KAP_COMPANIES_PATH,
  KAP_LIST_PATH,
  KAP_PAGE_CAP,
  type KapDisclosureRow,
  type KapListItem,
  autoAlias,
  dayRange,
  istanbulDate,
  kapQueryBody,
  mapDisclosure,
  parseCompanies,
  TAYF_BOT_UA,
} from "../_shared/kap.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";

await initSentry("kap-ingest");

const CYCLE_DEADLINE_MS = 50_000;
const FETCH_TIMEOUT_MS = 30_000;
const UPSERT_BATCH = 500;
const HEADERS = {
  "User-Agent": TAYF_BOT_UA,
  "Accept-Language": "tr",
};

interface Stats {
  days: number;
  fetched: number;
  upserted: number;
  skipped: number;
  capped: string[];
  companies: number;
  aliases: number;
  errors: string[];
  durationMs: number;
  /** false when every attempted day errored — TSF-01, so a total drain
   *  outage doesn't look like a healthy 200 in the cron logs. */
  ok: boolean;
}

async function fetchDay(day: string, disclosureClass = ""): Promise<KapListItem[]> {
  const res = await fetchWithRetry(
    KAP_BASE + KAP_LIST_PATH,
    {
      method: "POST",
      headers: { ...HEADERS, "Content-Type": "application/json" },
      body: JSON.stringify(kapQueryBody(day, day, disclosureClass)),
    },
    // SEC-07: a fresh per-attempt timeout signal, built by fetchWithRetry
    // itself, instead of a single AbortSignal.timeout() constructed here
    // that starts counting before the retry loop's backoff sleeps even run.
    { timeoutMs: FETCH_TIMEOUT_MS },
  );
  if (!res.ok) throw new Error(`[kap-ingest] KAP ${res.status} for ${day}/${disclosureClass || "*"}`);
  return (await res.json()) as KapListItem[];
}

// One day is normally 200-900 rows; earnings-season days can exceed the
// 2000 cap, in which case we re-query per disclosureClass and merge.
// ponytail: if a single class on a single day ever tops 2000 we log it and
// lose the tail; split by hour if that happens.
async function fetchDayComplete(day: string, stats: Stats): Promise<KapListItem[]> {
  const all = await fetchDay(day);
  if (all.length < KAP_PAGE_CAP) return all;
  // TS-05: seed the merge with what the unfiltered query already returned
  // — a row whose disclosureClass is null or outside KAP_CLASSES (exchange
  // notices, mostly) never comes back from ANY per-class query below, so
  // starting from an empty map silently dropped it on every capped day.
  const merged = new Map<number, KapListItem>(all.map((r) => [r.disclosureIndex, r]));
  for (const cls of KAP_CLASSES) {
    const part = await fetchDay(day, cls);
    if (part.length >= KAP_PAGE_CAP) stats.capped.push(`${day}/${cls}`);
    for (const r of part) merged.set(r.disclosureIndex, r);
  }
  return [...merged.values()];
}

async function ingestRange(
  supabase: ReturnType<typeof createServiceClient>,
  from: string,
  to: string,
  deadline: number,
  stats: Stats,
  isBackfill: boolean,
): Promise<void> {
  for (const day of dayRange(from, to)) {
    if (Date.now() > deadline) {
      stats.errors.push(`deadline before ${day}`);
      break;
    }
    // TS-04: one poison day (a fetch throw, or a KAP 5xx surfaced as a
    // throw by fetchDay) must not block every day after it — the default
    // window always processes yesterday first, so without this a single
    // bad day blocks today for ~24h behind it.
    try {
      const items = await fetchDayComplete(day, stats);
      stats.days++;
      stats.fetched += items.length;
      const rows: KapDisclosureRow[] = [];
      for (const item of items) {
        try {
          rows.push(mapDisclosure(item));
        } catch (err) {
          stats.skipped++;
          const message = err instanceof Error ? err.message : String(err);
          stats.errors.push(`${day} row ${item.disclosureIndex}: ${message}`);
        }
      }
      for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
        const chunk = rows.slice(i, i + UPSERT_BATCH);
        // DB-08: the poll path (no explicit `from`) skips rows KAP already
        // gave us (ON CONFLICT DO NOTHING) instead of rewriting all ~500
        // rows of a two-day window every 2 minutes; an explicit backfill
        // keeps DO UPDATE so corrections replay over the stored row.
        const { data, error } = await supabase
          .from("kap_disclosures")
          .upsert(chunk, { onConflict: "disclosure_index", ignoreDuplicates: !isBackfill })
          .select("disclosure_index");
        if (error) {
          stats.errors.push(`${day} upsert: ${error.message}`);
          continue;
        }
        // Rows actually written, not rows submitted: under
        // ignoreDuplicates (the poll path), a conflicting row is skipped
        // and not returned by `.select()`, so `chunk.length` would report
        // ~500/cycle while the table gains ~0 rows.
        stats.upserted += data?.length ?? 0;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stats.errors.push(`${day}: ${message}`);
    }
  }
}

// TS-08 (caller half): best-effort Next.js cache revalidation so the
// /ekonomi feed drops its stale finance-feed cache entry without waiting on
// the fetcher's own TTL. Mirrors cluster-consumer's triggerRevalidation
// (REVALIDATE_URL + CRON_SECRET bearer, 2s timeout, every failure logged
// and swallowed — a stale page is far cheaper than a failed drain).
async function triggerRevalidation(tags: string[]): Promise<void> {
  const revalidateUrl = Deno.env.get("REVALIDATE_URL");
  const cronSecret = Deno.env.get("CRON_SECRET");
  if (!revalidateUrl || !cronSecret) {
    console.warn("[kap-ingest] REVALIDATE_URL/CRON_SECRET unset; skipping revalidation");
    return;
  }
  try {
    const res = await fetch(revalidateUrl, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cronSecret}` },
      body: JSON.stringify({ tags }),
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) console.warn(`[kap-ingest] revalidation POST returned ${res.status}`);
  } catch (err) {
    console.warn(`[kap-ingest] revalidation POST failed: ${err instanceof Error ? err.message : err}`);
  }
}

async function syncCompanies(
  supabase: ReturnType<typeof createServiceClient>,
  stats: Stats,
): Promise<void> {
  const res = await fetch(KAP_BASE + KAP_COMPANIES_PATH, {
    headers: HEADERS,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`[kap-ingest] KAP ${res.status} for company list`);
  const companies: BistCompanyRow[] = parseCompanies(await res.text());
  if (companies.length < 500) {
    // The payload shape changed or we got a stub page; refuse to overwrite.
    throw new Error(`[kap-ingest] company list parsed only ${companies.length} rows, expected >500`);
  }
  const { error } = await supabase
    .from("bist_companies")
    .upsert(companies.map((c) => ({ ...c, updated_at: new Date().toISOString() })), {
      onConflict: "kap_member_oid",
    });
  if (error) throw new Error(`[kap-ingest] bist_companies upsert: ${error.message}`);
  stats.companies = companies.length;

  const aliases: { alias: string; ticker: string; origin: string }[] = [];
  for (const c of companies) {
    const alias = autoAlias(c.title);
    if (!alias) continue;
    for (const ticker of c.tickers) aliases.push({ alias, ticker, origin: "auto" });
  }
  const { error: aErr } = await supabase
    .from("bist_aliases")
    .upsert(aliases, { onConflict: "alias,ticker", ignoreDuplicates: true });
  if (aErr) throw new Error(`[kap-ingest] bist_aliases upsert: ${aErr.message}`);
  stats.aliases = aliases.length;

  // New auto aliases that behave like common words get switched off by the
  // empirical rule in migration 052; run it right away rather than waiting
  // for the nightly job.
  const { error: pErr } = await supabase.rpc("prune_generic_aliases");
  if (pErr) console.warn(`[kap-ingest] prune_generic_aliases: ${pErr.message}`);
}

interface Body {
  from?: string;
  to?: string;
  companies?: boolean;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export async function runCycle(body: Body): Promise<Stats> {
  const startedAt = Date.now();
  const deadline = startedAt + CYCLE_DEADLINE_MS;
  const stats: Stats = {
    days: 0,
    fetched: 0,
    upserted: 0,
    skipped: 0,
    capped: [],
    companies: 0,
    aliases: 0,
    errors: [],
    durationMs: 0,
    ok: true,
  };
  const supabase = createServiceClient();

  if (body.companies) await syncCompanies(supabase, stats);

  const from = body.from ?? istanbulDate(-1);
  const to = body.to ?? istanbulDate(0);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw new Error(`[kap-ingest] bad range ${from}..${to}`);
  }
  // {"companies":true} alone is a map refresh, not a disclosure pull.
  // DB-08: only an explicit `from` is a deliberate backfill; the default
  // (no `from`) poll path is the one that switches to ON CONFLICT DO NOTHING.
  if (!body.companies || body.from) {
    await ingestRange(supabase, from, to, deadline, stats, Boolean(body.from));

    // TSF-01: every day-level throw inside ingestRange is caught and
    // swallowed into stats.errors (so one poison day doesn't block the
    // rest), which otherwise means a KAP outage or a WAF block on every
    // attempted day still reports HTTP 200 — a silent, 720x/day drain
    // failure. Mirrors quotes-ingest's SEC-05 total-outage guard.
    const attemptedDays = dayRange(from, to).length;
    if (attemptedDays > 0 && stats.days === 0) {
      stats.ok = false;
      captureException(
        "kap-ingest",
        new Error(`all ${attemptedDays} day(s) failed: ${stats.errors.slice(0, 5).join(",")}`),
      );
    }
  }

  stats.durationMs = Date.now() - startedAt;
  console.log("[kap-ingest] cycle", JSON.stringify(stats));
  // TS-08: only evict the finance-feed cache tag when this cycle actually
  // wrote new disclosure rows — kap-drain runs every 2 minutes, and an
  // unconditional revalidation was hard-expiring /ekonomi's cache on every
  // {"companies":true} map-refresh and on every all-days-failed cycle too.
  if (stats.days > 0 && stats.upserted > 0) await triggerRevalidation(["finance-feed"]);
  return stats;
}

Deno.serve(withSentry("kap-ingest", async (req: Request) => {
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
    // TSF-01: a total-drain-failure cycle reports ok:false with a non-2xx
    // status so the cron run shows red instead of a green 200 — `stats`
    // already carries `ok`, so no separate wrapper field is needed here.
    return new Response(JSON.stringify(stats), {
      status: stats.ok ? 200 : 502,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const request_id = crypto.randomUUID();
    captureException("kap-ingest", err);
    console.error(`[kap-ingest] ${request_id}`, err);
    return new Response(JSON.stringify({ ok: false, error: "internal-error", request_id }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
}));
