import type { SupabaseClient } from "@supabase/supabase-js";

import { isLegalNotice } from "../../../supabase/functions/_shared/rss/legal-notice";

// ingest-hygiene: BİK court / official notices are dropped at ingest, but rows
// already stored (and any that slip through) are filtered here at read time.
// Re-exported so finance queries share the one Deno/Next implementation.
export { isLegalNotice };

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
// The relevance gate has NO migration behind it: it reads an existing table
// (jev_shadow_predictions) at query time. The only DB write is jev.ts's
// existing shadow-run insert, untouched here.
//
// The legal-notice gate DOES: migration 107 adds `legal_notice_articles`, a
// service-role-only table of BİK court / official notice article ids kept
// current by ingest-time rules mirrored in SQL (`is_legal_notice`) plus a cron
// backstop. The attention totals are summed in JS over article_tickers rows
// (no title on them), so the readers fetch that one small id set per window and
// drop matching rows before aggregating. Joining articles.title or ILIKE-ing
// articles instead would add reads that cannot fit the 4 s reader cap on a
// cold Micro database. `fetchLegalNoticeIdsSince` is FAIL-OPEN like the rest.

export const TICKER_HIDE_BELOW = 0.2;
export const TICKER_ATTENTION_MIN = 0.5;
export const RELEVANCE_CHUNK = 100;
/**
 * Total row cap of the legal-notice id lookup. Measured volume (migration 107
 * Step 0): about 27 notices a day, so ~820 rows over the longest window (30
 * days) and ~220 over fetchTopTickers' 8 days.
 */
export const LEGAL_NOTICE_LOOKUP_LIMIT = 5000;
/**
 * PostgREST truncates every response at its `max_rows` (1,000 on Supabase)
 * whatever `.limit()` asks for. A response of exactly this many rows therefore
 * means "cut off", and `fetchLegalNoticeIdsSince` continues with `.range()`.
 */
const POSTGREST_MAX_ROWS = 1000;

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

/**
 * Ids of the BİK court / official notices published since `sinceIso`, from
 * `legal_notice_articles` (migration 107; written only by `legal_notice_mark`
 * and served by the table's own published_at index). Callers pass the result
 * to `aggregateAttention` so a notice that string-matched a ticker
 * ("... GARANTİ BANKASI ... İCRA DAİRESİ") stops counting as attention.
 *
 * The first request asks for LEGAL_NOTICE_LOOKUP_LIMIT rows. PostgREST cuts a
 * response at 1,000 rows, so when exactly that many come back the lookup
 * continues with `.range()` pages (stable order: newest first, then id) up to
 * the same total cap. The 30-day set is ~820 rows today, so this is normally
 * one request.
 *
 * FAIL-OPEN: an error, or a throw (the table does not exist before the
 * migration is applied; the request aborts at the reader timeout), warns and
 * returns what was read so far -- an empty Set on the first request, i.e.
 * "nothing is known to be a notice, count every row", the behaviour before
 * 107. Never throws.
 */
export async function fetchLegalNoticeIdsSince(
  supabase: RelevanceSupabase,
  sinceIso: string,
): Promise<Set<string>> {
  const ids = new Set<string>();
  try {
    let read = 0;
    while (read < LEGAL_NOTICE_LOOKUP_LIMIT) {
      const base = supabase
        .from("legal_notice_articles")
        .select("article_id")
        .gte("published_at", sinceIso)
        .order("published_at", { ascending: false })
        .order("article_id");
      const { data, error } =
        read === 0
          ? await base.limit(LEGAL_NOTICE_LOOKUP_LIMIT)
          : await base.range(read, Math.min(read + POSTGREST_MAX_ROWS, LEGAL_NOTICE_LOOKUP_LIMIT) - 1);
      if (error) {
        console.warn(`[finance] legal-notice lookup unavailable: ${error.message}`);
        return ids;
      }
      const rows = (data ?? []) as Array<{ article_id?: unknown }>;
      for (const row of rows) {
        if (typeof row.article_id === "string") ids.add(row.article_id);
      }
      read += rows.length;
      // A short page is the end; a full 1,000-row page may have been cut off.
      if (rows.length < POSTGREST_MAX_ROWS) break;
    }
  } catch (err) {
    console.warn(
      `[finance] legal-notice lookup unavailable: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return ids;
}

interface FeedTickerItem {
  id: string;
  tickers: string[];
  title?: unknown;
  url?: unknown;
  [key: string]: unknown;
}

/**
 * First drop legal/official notices (`isLegalNotice` on title + url), then
 * drop hidden ticker matches (score < 0.2) from each item's ticker list, then
 * drop any item left with zero tickers. Used for /ekonomi's feed —
 * over-fetching upstream (fetchEconFeed requests 1.25x the display limit)
 * absorbs the items this drops. The notice check is fail-open: an item
 * without a string title is never dropped by it.
 */
export function filterFeedTickers<T extends FeedTickerItem>(
  items: readonly T[],
  scores: Map<string, number>,
): T[] {
  const out: T[] = [];
  for (const item of items) {
    if (
      typeof item.title === "string" &&
      isLegalNotice(item.title, typeof item.url === "string" ? item.url : null)
    ) {
      continue;
    }
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
 * excluded for < 0.5). Rows whose article is in `excludeArticleIds` (the
 * legal-notice set, see `fetchLegalNoticeIdsSince`) are skipped for every
 * ticker. Empty (ticker, day) groups are omitted entirely rather than emitted
 * as a zero row.
 */
export function aggregateAttention(
  rows: readonly AttentionRawRow[],
  scores: Map<string, number>,
  excludeArticleIds?: ReadonlySet<string>,
): AttentionRow[] {
  const groups = new Map<string, { ticker: string; day: string; articles: number; sourceIds: Set<string> }>();
  for (const row of rows) {
    if (excludeArticleIds?.has(row.article_id)) continue;
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
