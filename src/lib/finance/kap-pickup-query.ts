import { cacheLife, cacheTag } from "next/cache";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  computePickups,
  dropIrrelevant,
  PICKUP_WINDOW_HOURS,
  PUBLISHED_AT_SKEW_MARGIN_MS,
  relevanceKeys,
  summarizePickups,
  type DisclosurePickup,
  type PickupDisclosure,
  type PickupMention,
  type PickupSource,
  type PickupTotals,
} from "@/lib/finance/kap-pickup";
import { attemptCached } from "@/lib/cache-resilience";
import { readAllPages } from "@/lib/finance/paging";
import { createFinanceServerClient, READER_TIMEOUT_MS } from "@/lib/supabase/server";

/**
 * kap-media-pickup — IO layer. Every query here is per-ticker and
 * time-bounded on `kap_disclosures` / `article_tickers` directly;
 * `disclosure_coverage` is never touched (60s timeouts on an unbounded
 * count — see data-3 evidence in the brief).
 *
 * The mention read pages with `.range()` (ordered by published_at, article_id):
 * PostgREST truncates every response at 1,000 rows, so the former single
 * `.limit(5000)` silently stopped at 1,000 and the "exactly 5000 means
 * truncated" check could never fire. MENTION_MAX_PAGES x MENTION_PAGE_SIZE
 * rows is the bound; reaching it with a full last page sets `truncated`.
 */

const DISCLOSURE_SELECT = "disclosure_index,published_at,subject,disclosure_class";
const MENTION_PAGE_SIZE = 1000;
const MENTION_MAX_PAGES = 5;
const RELEVANCE_CHUNK = 100;
const SOURCE_CHUNK = 200;

export interface TickerPickup {
  ticker: string;
  since: string;
  until: string;
  pickups: DisclosurePickup[];
  totals: PickupTotals;
  relevanceApplied: boolean;
  truncated: boolean;
}

interface DisclosureRow {
  disclosure_index: number;
  published_at: string;
  subject: string | null;
  disclosure_class: string | null;
}

interface MentionRow {
  article_id: string;
  published_at: string;
  created_at: string | null;
  source_id: string | null;
}

interface RelevanceRow {
  subject_id: string;
  jev_prob: number | string;
}

interface SourceRow {
  id: string;
  slug: string;
  bias: PickupSource["bias"];
  kind: PickupSource["kind"];
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function emptyResult(ticker: string, sinceIso: string, untilIso: string): TickerPickup {
  return {
    ticker,
    since: sinceIso,
    until: untilIso,
    pickups: [],
    totals: summarizePickups([]),
    relevanceApplied: true,
    truncated: false,
  };
}

/**
 * Core fetch. Throws on a disclosure, mention, or source query error — the
 * caller (a route handler, or the "use cache" wrapper below) decides
 * whether that becomes a 500 or a caught, logged null. Fails OPEN on a
 * relevance-lookup error only: keeps every mention, sets
 * `relevanceApplied: false`, and warns — a broken Jev table must never
 * take the whole panel/endpoint down.
 */
export async function fetchTickerPickup(
  supabase: SupabaseClient,
  ticker: string,
  sinceMs: number,
  nowMs: number,
  opts: { limit: number },
): Promise<TickerPickup> {
  const sinceIso = new Date(sinceMs).toISOString();
  const nowIso = new Date(nowMs).toISOString();

  const { data: disclosureData, error: disclosureError } = await supabase
    .from("kap_disclosures")
    .select(DISCLOSURE_SELECT)
    .contains("stock_codes", [ticker])
    .or("subject.is.null,subject.not.ilike.*Devre Kesici*")
    .gte("published_at", sinceIso)
    .lte("published_at", nowIso)
    .order("published_at", { ascending: false })
    .limit(opts.limit);
  if (disclosureError) {
    throw new Error(`[finance] fetchTickerPickup disclosures: ${disclosureError.message}`);
  }

  const disclosures: PickupDisclosure[] = ((disclosureData ?? []) as DisclosureRow[]).map((r) => ({
    disclosureIndex: r.disclosure_index,
    publishedAt: r.published_at,
    subject: r.subject,
    disclosureClass: r.disclosure_class,
  }));

  if (disclosures.length === 0) {
    return emptyResult(ticker, sinceIso, nowIso);
  }

  const disclosureMs = disclosures.map((d) => new Date(d.publishedAt).getTime());
  const minDisclosureMs = Math.min(...disclosureMs);
  const maxDisclosureMs = Math.max(...disclosureMs);
  const mentionGte = new Date(minDisclosureMs - PUBLISHED_AT_SKEW_MARGIN_MS).toISOString();
  const mentionLtMs = Math.min(
    maxDisclosureMs + PICKUP_WINDOW_HOURS * 3_600_000 + PUBLISHED_AT_SKEW_MARGIN_MS,
    nowMs + PUBLISHED_AT_SKEW_MARGIN_MS,
  );
  const mentionLt = new Date(mentionLtMs).toISOString();

  // Throws `[finance] fetchTickerPickup mentions <ticker>: <message>` on a
  // Supabase error, and warns by itself when the page cap truncates the result.
  const { rows: mentionRows, truncated } = await readAllPages<MentionRow>(
    (from, to) =>
      supabase
        .from("article_tickers")
        .select("article_id,published_at,created_at,source_id")
        .eq("ticker", ticker)
        .gte("published_at", mentionGte)
        .lt("published_at", mentionLt)
        .order("published_at")
        .order("article_id")
        .range(from, to),
    { label: `fetchTickerPickup mentions ${ticker}`, maxPages: MENTION_MAX_PAGES, pageSize: MENTION_PAGE_SIZE },
  );

  let mentions: PickupMention[] = mentionRows.map((r) => ({
    articleId: r.article_id,
    publishedAt: r.published_at,
    createdAt: r.created_at,
    sourceId: r.source_id,
  }));

  let relevanceApplied = true;
  if (mentions.length > 0) {
    const keys = relevanceKeys(mentions, ticker);
    const scores = new Map<string, number>();
    let relevanceFailed = false;
    for (const keyChunk of chunk(keys, RELEVANCE_CHUNK)) {
      const { data: relevanceData, error: relevanceError } = await supabase
        .from("jev_shadow_predictions")
        .select("subject_id,jev_prob")
        .eq("task", "ticker_relevance")
        .in("subject_id", keyChunk);
      if (relevanceError) {
        relevanceFailed = true;
        break;
      }
      for (const row of (relevanceData ?? []) as RelevanceRow[]) {
        scores.set(row.subject_id, Number(row.jev_prob));
      }
    }
    if (relevanceFailed) {
      relevanceApplied = false;
      console.warn(`[finance] fetchTickerPickup: relevance lookup failed for ticker ${ticker}, keeping all mentions`);
    } else {
      mentions = dropIrrelevant(mentions, ticker, scores);
    }
  }

  const sourceIds = Array.from(new Set(mentions.map((m) => m.sourceId).filter((id): id is string => id !== null)));
  const sourcesById = new Map<string, PickupSource>();
  for (const idChunk of chunk(sourceIds, SOURCE_CHUNK)) {
    const { data: sourceData, error: sourceError } = await supabase
      .from("sources")
      .select("id,slug,bias,kind")
      .in("id", idChunk);
    if (sourceError) {
      throw new Error(`[finance] fetchTickerPickup sources: ${sourceError.message}`);
    }
    for (const row of (sourceData ?? []) as SourceRow[]) {
      sourcesById.set(row.id, { id: row.id, slug: row.slug, bias: row.bias, kind: row.kind });
    }
  }

  const pickups = computePickups(disclosures, mentions, sourcesById, nowMs);
  const totals = summarizePickups(pickups);

  return {
    ticker,
    since: sinceIso,
    until: nowIso,
    pickups,
    totals,
    relevanceApplied,
    truncated,
  };
}

const PICKUP_LOOKBACK_MS = 30 * 86_400_000;
const PICKUP_LIMIT = 60;

/**
 * Cached attempt. `nowMs` is read INSIDE the cache scope (same precedent as
 * fetchTickerPage, queries.ts:471-470) - never in a component body, or every
 * render of a cached shell would see a stale "now" baked in at
 * build/first-render time.
 *
 * Never throws (`attemptCached`): a throw across the `"use cache"` boundary
 * fails `next build`'s prerender (src/lib/cache-resilience.ts). The read runs
 * under the 4 s reader cap (user-facing panel on /ekonomi/[ticker]), and
 * exactly ONE `cacheLife` is called per invocation, chosen after the attempt:
 * a failure (typically the cap's AbortError on a cold database) is memoised
 * for `minutes` only; a success keeps the normal 5-minute profile.
 */
async function getTickerPickupAttempt(ticker: string) {
  "use cache";
  cacheTag("finance-feed", `finance-ticker:${ticker}`);
  const r = await attemptCached("finance-pickup", async () => {
    const nowMs = Date.now();
    const supabase = await createFinanceServerClient({ timeoutMs: READER_TIMEOUT_MS });
    return fetchTickerPickup(supabase, ticker, nowMs - PICKUP_LOOKBACK_MS, nowMs, { limit: PICKUP_LIMIT });
  });
  // Exactly one call on either branch (the overloads do not accept a union).
  if (r.ok) cacheLife({ stale: 60, revalidate: 300, expire: 3600 });
  else cacheLife("minutes");
  return r;
}

/** Page-facing entry point. Throws when the cached attempt failed; see getTickerPickupSafe. */
export async function getTickerPickup(ticker: string): Promise<TickerPickup> {
  const r = await getTickerPickupAttempt(ticker);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** Never throws — a panel/component-safe wrapper. Logs and returns null on any failure. */
export async function getTickerPickupSafe(ticker: string): Promise<TickerPickup | null> {
  try {
    return await getTickerPickup(ticker);
  } catch (err) {
    console.warn(`[finance] getTickerPickupSafe(${ticker}) failed:`, err);
    return null;
  }
}
