import type { SupabaseClient } from "@supabase/supabase-js";

// Jev ticker-relevance gate (§4(b), reader-data, no migration).
//
// Jev's "ticker_relevance" shadow task (supabase/functions/_shared/jev.ts)
// scores every article_tickers row for whether the matched ticker is
// actually what the article is about, vs. a false string match (a party
// named after a company, a district sharing a ticker's name, etc — see the
// evidence block in the task spec: DEVA/EREGL/AEFES/AKSGY/TURSG false
// positives at p<0.2). Predictions land in `jev_shadow_predictions` keyed
// by `subject_id = "${article_id}:${ticker}"` — that format is OWNED by
// jev.ts; the static guard test in ticker-relevance.test.ts catches drift.
//
// Every lookup here is FAIL-OPEN: a Supabase error (or simply "no score
// yet") must never hide a ticker or drop it from an attention count — it
// must behave exactly as if Jev hadn't scored it. `isHiddenMatch` and
// `countsTowardAttention` both treat `undefined` as "show it" / "count it".
// Nothing in this file may throw.
//
// This module has NO migration behind it: it reads an existing table
// (jev_shadow_predictions) at query time. The only DB write is jev.ts's
// existing shadow-run insert, untouched here.

export const TICKER_HIDE_BELOW = 0.2;
export const TICKER_ATTENTION_MIN = 0.5;
export const RELEVANCE_CHUNK = 100;

export function relevanceKey(articleId: string, ticker: string): string {
  return `${articleId}:${ticker}`;
}

/** A ticker match Jev is confident enough is wrong to hide from the feed. */
export function isHiddenMatch(score: number | undefined): boolean {
  return score !== undefined && score < TICKER_HIDE_BELOW;
}

/**
 * Whether a row counts toward attention aggregates: either unscored
 * (fail-open — Jev hasn't reached it yet, or the lookup itself failed) or
 * scored at/above the attention floor. Note this is a *higher* bar than
 * `!isHiddenMatch` — the 0.2–0.5 band is shown in the feed (not hidden)
 * but does not count toward "attention".
 */
export function countsTowardAttention(score: number | undefined): boolean {
  return score === undefined || score >= TICKER_ATTENTION_MIN;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

interface RelevanceRow {
  subject_id: string;
  jev_prob: unknown;
}

// Nominal `SupabaseClient` type (not a structural chain shape): TS's
// PostgREST filter builder types are deeply generic/self-referential, and
// structurally checking a hand-written chain interface against them blows
// the instantiation-depth limit (TS2589) at every real call site. The
// hand-rolled fakes in ticker-relevance.test.ts / queries.test.ts are cast
// with `as unknown as SupabaseClient` instead.
export type RelevanceSupabase = SupabaseClient;

/**
 * Fetch jev_prob scores for a set of `${articleId}:${ticker}` keys, chunked
 * at RELEVANCE_CHUNK per request (PostgREST/URL length safety, mirroring
 * the paging rule already used for article_tickers elsewhere in this
 * package). FAIL-OPEN: a chunk error warns and returns everything
 * accumulated so far rather than throwing — callers must treat a missing
 * key exactly like "not yet scored".
 */
export async function fetchRelevanceScores(
  supabase: RelevanceSupabase,
  keys: readonly string[],
): Promise<Map<string, number>> {
  const scores = new Map<string, number>();
  const unique = [...new Set(keys)];
  if (unique.length === 0) return scores;

  for (const batch of chunk(unique, RELEVANCE_CHUNK)) {
    const { data, error } = await supabase
      .from("jev_shadow_predictions")
      .select("subject_id, jev_prob")
      .eq("task", "ticker_relevance")
      .in("subject_id", batch);
    if (error) {
      console.warn(`[finance] ticker relevance unavailable: ${error.message}`);
      return scores;
    }
    for (const row of (data ?? []) as RelevanceRow[]) {
      if (row.jev_prob == null) continue;
      const n = Number(row.jev_prob);
      if (Number.isFinite(n)) scores.set(row.subject_id, n);
    }
  }
  return scores;
}

/**
 * All ticker_relevance rows scored below the attention floor (< 0.5) since
 * `sinceIso`, up to 5000 rows — served by the `(task, created_at)` index on
 * jev_shadow_predictions. This is enough information for `aggregateAttention`
 * to apply `countsTowardAttention` without needing every scored row: a key
 * ABSENT from this list is either unscored or scored >= 0.5, both of which
 * count (fail-open / already-relevant), which is exactly what
 * `countsTowardAttention(undefined)` already returns.
 *
 * FAIL-OPEN: an error warns and returns `[]` (i.e. "nothing is known to be
 * below the floor" — every row counts), never throws.
 */
export async function fetchLowRelevanceSince(
  supabase: RelevanceSupabase,
  sinceIso: string,
): Promise<RelevanceRow[]> {
  const { data, error } = await supabase
    .from("jev_shadow_predictions")
    .select("subject_id, jev_prob")
    .eq("task", "ticker_relevance")
    .lt("jev_prob", TICKER_ATTENTION_MIN)
    .gte("created_at", sinceIso)
    .limit(5000);
  if (error) {
    console.warn(`[finance] ticker relevance unavailable: ${error.message}`);
    return [];
  }
  return (data ?? []) as RelevanceRow[];
}

interface FeedTickerItem {
  id: string;
  tickers: string[];
  [key: string]: unknown;
}

/**
 * Drop hidden ticker matches (score < 0.2) from each item's ticker list,
 * then drop any item left with zero tickers. Used for /ekonomi's feed —
 * over-fetching upstream (fetchEconFeed requests 1.25x the display limit)
 * absorbs the items this drops.
 */
export function filterFeedTickers<T extends FeedTickerItem>(
  items: readonly T[],
  scores: Map<string, number>,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    const kept = item.tickers.filter((t) => !isHiddenMatch(scores.get(relevanceKey(item.id, t))));
    if (kept.length === 0) continue;
    out.push({ ...item, tickers: kept });
  }
  return out;
}

/** Istanbul (UTC+3) calendar day for an ISO timestamp, e.g. "2026-09-14". */
export function istanbulDay(iso: string): string {
  return new Date(Date.parse(iso) + 3 * 3600e3).toISOString().slice(0, 10);
}

export interface AttentionRawRow {
  ticker: string;
  article_id: string;
  published_at: string;
  source_id: string;
}

export interface AttentionRow {
  ticker: string;
  day: string;
  articles: number;
  sources: number;
}

/**
 * Aggregate raw article_tickers rows into per-(ticker, Istanbul day)
 * attention counts, honoring the relevance gate: a row only counts when
 * `countsTowardAttention` says so (fail-open for unscored/>=0.5 rows,
 * excluded for < 0.5). Empty (ticker, day) groups are omitted entirely
 * rather than emitted as a zero row.
 */
export function aggregateAttention(
  rows: readonly AttentionRawRow[],
  scores: Map<string, number>,
): AttentionRow[] {
  const groups = new Map<string, { ticker: string; day: string; articles: number; sourceIds: Set<string> }>();
  for (const row of rows) {
    const score = scores.get(relevanceKey(row.article_id, row.ticker));
    if (!countsTowardAttention(score)) continue;
    const day = istanbulDay(row.published_at);
    const key = `${row.ticker}\u0000${day}`;
    let g = groups.get(key);
    if (!g) {
      g = { ticker: row.ticker, day, articles: 0, sourceIds: new Set() };
      groups.set(key, g);
    }
    g.articles += 1;
    g.sourceIds.add(row.source_id);
  }
  return [...groups.values()]
    .filter((g) => g.articles > 0)
    .map((g) => ({ ticker: g.ticker, day: g.day, articles: g.articles, sources: g.sourceIds.size }));
}
