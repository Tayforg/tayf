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
  KAP_BASE,
  KAP_CLASSES,
  KAP_COMPANIES_PATH,
  KAP_LIST_PATH,
  KAP_PAGE_CAP,
  type KapListItem,
  autoAlias,
  dayRange,
  istanbulDate,
  kapQueryBody,
  mapDisclosure,
  parseCompanies,
} from "../_shared/kap.ts";
import { requireServiceRoleBearer } from "../_shared/auth.ts";
import { captureException, initSentry, withSentry } from "../_shared/sentry.ts";
import { createServiceClient } from "../_shared/supabase.ts";

await initSentry("kap-ingest");

const CYCLE_DEADLINE_MS = 50_000;
const FETCH_TIMEOUT_MS = 30_000;
const UPSERT_BATCH = 500;
const HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36",
  "Accept-Language": "tr",
};

interface Stats {
  days: number;
  fetched: number;
  upserted: number;
  capped: string[];
  companies: number;
  aliases: number;
  errors: string[];
  durationMs: number;
}

async function fetchDay(day: string, disclosureClass = ""): Promise<KapListItem[]> {
  const res = await fetch(KAP_BASE + KAP_LIST_PATH, {
    method: "POST",
    headers: { ...HEADERS, "Content-Type": "application/json" },
    body: JSON.stringify(kapQueryBody(day, day, disclosureClass)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
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
  const merged = new Map<number, KapListItem>();
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
): Promise<void> {
  for (const day of dayRange(from, to)) {
    if (Date.now() > deadline) {
      stats.errors.push(`deadline before ${day}`);
      break;
    }
    const items = await fetchDayComplete(day, stats);
    stats.days++;
    stats.fetched += items.length;
    const rows = items.map(mapDisclosure);
    for (let i = 0; i < rows.length; i += UPSERT_BATCH) {
      const chunk = rows.slice(i, i + UPSERT_BATCH);
      const { error } = await supabase
        .from("kap_disclosures")
        .upsert(chunk, { onConflict: "disclosure_index" });
      if (error) {
        stats.errors.push(`${day} upsert: ${error.message}`);
        continue;
      }
      stats.upserted += chunk.length;
    }
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
  const stats: Stats = { days: 0, fetched: 0, upserted: 0, capped: [], companies: 0, aliases: 0, errors: [], durationMs: 0 };
  const supabase = createServiceClient();

  if (body.companies) await syncCompanies(supabase, stats);

  const from = body.from ?? istanbulDate(-1);
  const to = body.to ?? istanbulDate(0);
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    throw new Error(`[kap-ingest] bad range ${from}..${to}`);
  }
  // {"companies":true} alone is a map refresh, not a disclosure pull.
  if (!body.companies || body.from) await ingestRange(supabase, from, to, deadline, stats);

  stats.durationMs = Date.now() - startedAt;
  console.log("[kap-ingest] cycle", JSON.stringify(stats));
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
    return new Response(JSON.stringify({ ok: true, ...stats }), {
      status: 200,
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
