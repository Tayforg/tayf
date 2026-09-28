/**
 * src/lib/game/daily-query.ts — Supabase fetch layer for "Günün Tayf'ı".
 *
 * Starts from `jev_shadow_predictions` (the (task, created_at) index path
 * migration 072 built), NOT from `articles` — starting from `articles` and
 * joining out to predictions reproduces the ~18s plan 072 fixed. This is
 * a completely separate query shape from headline-pool.ts's `clusters ->
 * cluster_articles -> articles -> sources` walk; nothing here shares a
 * cache tag or a client call with that module.
 *
 * PostgREST caps every response at 1000 rows, so paging (`.range`) is
 * mandatory — a single unpaged `.select()` would silently truncate a
 * high-prediction-volume day. Pages are ordered by `(created_at, id)` (a
 * stable total order) and paging stops as soon as a page comes back
 * shorter than the page size, capped at `MAX_PREDICTION_PAGES` (8) as a
 * hard backstop.
 *
 * Candidate detail (title/url/source/cluster) is then fetched in
 * dailyHash-order CHUNKS (not all at once) — `pickDailySet` is
 * prefix-consistent (see daily-set.ts's doc comment), so the loop below
 * stops issuing chunks the moment 5 headlines are picked, typically after
 * the first chunk or two rather than every eligible article of the day.
 *
 * DRIFT NOTE: a source deactivated mid-day (`sources.active` flips to
 * false) can change the picked set on a cache miss that lands after the
 * deactivation but was itself cached before it — this is rare and
 * accepted, not worked around.
 */

import { cacheLife, cacheTag } from "next/cache";

import { sourceKindOf } from "@/lib/sources/kind";
import { createServerClient } from "@/lib/supabase/server";
import type { BiasCategory, SourceKind } from "@/types";
import {
  DAILY_POLITICS_MIN_PROB,
  dailyHash,
  pickDailySet,
  puzzleNumber,
  puzzleWindow,
  windowLabelTr,
  type DailyCandidate,
  type DailyPuzzle,
} from "./daily-set";

const PREDICTIONS_PAGE_SIZE = 1000;
const MAX_PREDICTION_PAGES = 8;
const ARTICLE_CHUNK_SIZE = 80;
const MAX_ARTICLE_CHUNKS = 6;

interface PredictionRow {
  article_id: string | null;
}

interface EmbeddedSourceRow {
  id: string;
  name: string;
  slug: string;
  bias: BiasCategory;
  kind: SourceKind | null;
  active: boolean;
}

interface ArticleRow {
  id: string;
  title: string;
  url: string;
  published_at: string;
  created_at: string;
  source_id: string;
  sources: EmbeddedSourceRow | null;
  cluster_articles: Array<{ cluster_id: string }> | null;
}

interface TitleVersionRow {
  article_id: string;
}

/**
 * Pages `jev_shadow_predictions` for `task = 'politics'`, `jev_prob >=
 * DAILY_POLITICS_MIN_PROB`, `created_at` in `[startIso, endIso)`, and a
 * non-null `article_id`. Returns the de-duplicated set of article ids —
 * order doesn't matter here, the caller re-sorts by `dailyHash`.
 */
async function fetchEligibleArticleIds(startIso: string, endIso: string): Promise<string[]> {
  const supabase = createServerClient();
  const ids = new Set<string>();

  for (let page = 0; page < MAX_PREDICTION_PAGES; page++) {
    const from = page * PREDICTIONS_PAGE_SIZE;
    const to = from + PREDICTIONS_PAGE_SIZE - 1;

    const { data, error } = await supabase
      .from("jev_shadow_predictions")
      .select("article_id")
      .eq("task", "politics")
      .gte("jev_prob", DAILY_POLITICS_MIN_PROB)
      .gte("created_at", startIso)
      .lt("created_at", endIso)
      .not("article_id", "is", null)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .range(from, to)
      .returns<PredictionRow[]>();

    if (error) {
      throw new Error(`[gunun-tayfi] jev_shadow_predictions query failed: ${error.message}`);
    }

    const rows = data ?? [];
    for (const row of rows) {
      if (row.article_id) ids.add(row.article_id);
    }
    if (rows.length < PREDICTIONS_PAGE_SIZE) break;
  }

  return [...ids];
}

/**
 * Fetches article + embedded source + embedded cluster detail for one
 * chunk of ids, plus the `article_title_versions` rows for the same chunk
 * (used only as an exclusion filter — an edited/stale headline is
 * dropped, and nothing from that table is ever surfaced).
 */
async function fetchArticleChunk(
  ids: readonly string[],
): Promise<{ rows: Map<string, ArticleRow>; edited: Set<string> }> {
  const supabase = createServerClient();

  const [articlesResult, versionsResult] = await Promise.all([
    supabase
      .from("articles")
      .select(
        `id, title, url, published_at, created_at, source_id,
         sources ( id, name, slug, bias, kind, active ),
         cluster_articles ( cluster_id )`,
      )
      .in("id", ids)
      .returns<ArticleRow[]>(),
    supabase
      .from("article_title_versions")
      .select("article_id")
      .in("article_id", ids)
      .returns<TitleVersionRow[]>(),
  ]);

  if (articlesResult.error) {
    throw new Error(`[gunun-tayfi] articles query failed: ${articlesResult.error.message}`);
  }
  if (versionsResult.error) {
    throw new Error(
      `[gunun-tayfi] article_title_versions query failed: ${versionsResult.error.message}`,
    );
  }

  const rows = new Map<string, ArticleRow>();
  for (const row of articlesResult.data ?? []) rows.set(row.id, row);

  const edited = new Set<string>();
  for (const row of versionsResult.data ?? []) edited.add(row.article_id);

  return { rows, edited };
}

function toCandidate(row: ArticleRow): DailyCandidate | null {
  const source = row.sources;
  if (!source) return null;

  return {
    articleId: row.id,
    title: row.title,
    url: row.url,
    publishedAt: row.published_at,
    createdAt: row.created_at,
    clusterId: row.cluster_articles?.[0]?.cluster_id ?? null,
    source: {
      id: source.id,
      name: source.name,
      slug: source.slug,
      bias: source.bias,
      // Normalizes null/legacy kind the same way every other reader does
      // (sourceKindOf falls back to "outlet") before daily-set.ts's
      // isDailyEligible re-normalizes it again — cheap and idempotent.
      kind: sourceKindOf({ kind: source.kind ?? undefined }),
      active: source.active,
    },
  };
}

/**
 * Builds the puzzle for `dateKey`, throwing on any Supabase error or on an
 * incomplete set (fewer than `DAILY_GAME_SIZE` eligible candidates found
 * after exhausting the id list / chunk budget) — an empty/partial result
 * must never be cached.
 */
async function buildDailyPuzzle(dateKey: string): Promise<DailyPuzzle> {
  const { startIso, endIso } = puzzleWindow(dateKey);
  const ids = await fetchEligibleArticleIds(startIso, endIso);

  const sortedIds = [...ids].sort(
    (a, b) => dailyHash(dateKey, a) - dailyHash(dateKey, b),
  );

  const collected: DailyCandidate[] = [];
  const maxIds = Math.min(sortedIds.length, MAX_ARTICLE_CHUNKS * ARTICLE_CHUNK_SIZE);

  for (let start = 0; start < maxIds; start += ARTICLE_CHUNK_SIZE) {
    const chunk = sortedIds.slice(start, start + ARTICLE_CHUNK_SIZE);
    const { rows, edited } = await fetchArticleChunk(chunk);

    for (const id of chunk) {
      if (edited.has(id)) continue; // stale/edited headline — exclusion only
      const row = rows.get(id);
      if (!row) continue;
      const candidate = toCandidate(row);
      if (candidate) collected.push(candidate);
    }

    const picked = pickDailySet(dateKey, collected);
    if (picked) {
      return {
        dateKey,
        number: puzzleNumber(dateKey),
        windowLabel: windowLabelTr(dateKey),
        headlines: picked,
      };
    }
  }

  throw new Error(
    `[gunun-tayfi] incomplete daily set for ${dateKey}: only ${collected.length} eligible candidate(s)`,
  );
}

/**
 * Cached entry point. Keyed ONLY by `dateKey` (the cache key derives from
 * the function's arguments) — no clock is read anywhere in this call
 * graph, so the result is safe to cache for days at a time. Throws on
 * error/incompleteness so `"use cache"` never memoizes an empty puzzle;
 * `getDailyPuzzle` below is the fail-open wrapper every caller should use.
 */
export async function fetchDailyPuzzle(dateKey: string): Promise<DailyPuzzle> {
  "use cache";
  cacheLife("days");
  cacheTag("daily-game");
  return buildDailyPuzzle(dateKey);
}

/**
 * Uncached fail-open wrapper: swallows any error from `fetchDailyPuzzle`
 * (a Jev pause, a Supabase outage, an incomplete day) and returns `null`
 * instead, so a bad day degrades to the empty-state copy and is retried on
 * the very next request rather than being memoized as a permanent outage.
 */
export async function getDailyPuzzle(dateKey: string): Promise<DailyPuzzle | null> {
  try {
    return await fetchDailyPuzzle(dateKey);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[gunun-tayfi] puzzle unavailable for ${dateKey}: ${message}`);
    return null;
  }
}
