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
 * From DAILY_TWIN_GATE_FROM on, each article chunk also gets ONE paged read of
 * `cluster_articles` for the distinct clusters of its candidates: every member
 * of those clusters that is an outlet or a wire and was published before the
 * window closed is evidence for the twin-text rule (title-twin.ts), and a
 * candidate whose text another zone's outlet or wire also ran is flagged
 * `crossZoneTwin` (daily-set.ts then leaves it out). The read is per chunk,
 * not once at the end, so the early stop above still holds and the cluster id
 * list stays as short as the article id list (URL length). Keys before the
 * gate make no such read: their puzzles recompute byte-identically.
 *
 * The twin key itself has a version per puzzle key (`dailyTwinKeyVersion`):
 * version 1 below DAILY_TWIN_KEY_V2_FROM (the keys already served, so they
 * recompute byte-identically), version 2 from it (a "Son dakika..." lead-in no
 * longer hides a copy). One version is used for the whole build of a key.
 *
 * From DAILY_TITLE_ASOF_FROM on, the title versions are read AS OF THE WINDOW
 * CLOSE (`resolveTitleAsOf`) for two internal decisions only. An article is left
 * out as "edited" only when a title version was recorded before the close, so a
 * post-close edit neither drops a candidate nor reshuffles the hash order. And the
 * twin comparison uses the text the article carried at the close (the `old_title`
 * of its earliest post-close version), so a later edit cannot flip `crossZoneTwin`;
 * twin evidence reads its members' titles the same way (one more
 * `article_title_versions` read per batch of member ids). The SERVED headline is
 * always `articles.title` as it stands: `old_title` is compared, never rendered
 * (migrations 056/074: the ledger holds text the outlet removed, possibly under a
 * 5651 order, and any public read path of it is a counsel question first).
 * Remaining caveat: a post-close write-back of `articles.title` is still read
 * live, so on a cold rebuild it can change a headline's eligibility (length,
 * outlet name, the other title checks of daily-set.ts). Keys before that date keep
 * today's rule (any version excludes) and make no extra request, so they
 * recompute byte-identically.
 *
 * DRIFT NOTE: a source deactivated mid-day (`sources.active` flips to
 * false) can change the picked set on a cache miss that lands after the
 * deactivation but was itself cached before it — this is rare and
 * accepted, not worked around. The same holds for what is still read live:
 * cluster membership (`cluster_articles`), the article's category and politics
 * admission, and the source's bias (daily-set.ts names these caveats).
 */

import { cacheLife, cacheTag } from "next/cache";

import { attemptCached, type CacheAttempt } from "@/lib/cache-resilience";
import { zoneOf } from "@/lib/bias/config";
import { readAllPages } from "@/lib/db/paging";
import { sourceKindOf } from "@/lib/sources/kind";
import { createReaderClient } from "@/lib/supabase/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";
import {
  DAILY_POLITICS_MIN_PROB,
  DAILY_TITLE_ASOF_FROM,
  DAILY_TWIN_GATE_FROM,
  dailyHash,
  dailyTwinKeyVersion,
  pickDailySet,
  puzzleNumber,
  puzzleWindow,
  windowLabelTr,
  type DailyCandidate,
  type DailyPuzzle,
} from "./daily-set";
import { crossZoneTwinKeys, twinKey } from "./title-twin";

const PREDICTIONS_PAGE_SIZE = 1000;
const MAX_PREDICTION_PAGES = 8;
const ARTICLE_CHUNK_SIZE = 80;
const MAX_ARTICLE_CHUNKS = 6;
// A cluster's members for one article chunk (<= ARTICLE_CHUNK_SIZE clusters):
// 3 pages of 1,000 rows is far above what 80 clusters hold, and reaching the cap
// is an error, never a quiet truncation.
const MAX_SIBLING_PAGES = 3;
// Member ids per `article_title_versions` read of the twin evidence (as-of keys
// only). One URL carries the id list, so it stays in the order of
// ARTICLE_CHUNK_SIZE; 100 uuids is about 4 KB.
const TWIN_VERSION_BATCH = 100;
// A batch's version rows: 3 pages of 1,000 rows is far above what 100 articles
// hold, and reaching the cap is an error, never a quiet truncation.
const MAX_VERSION_PAGES = 3;

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
  category: string | null;
  politics_admitted_at: string | null;
  sources: EmbeddedSourceRow | null;
  cluster_articles: Array<{ cluster_id: string }> | null;
}

interface TitleVersionRow {
  article_id: string;
  old_title: string;
  seen_at: string;
}

/** The two columns of an `article_title_versions` row that the as-of reading needs. */
export interface TitleVersion {
  old_title: string;
  seen_at: string;
}

interface SiblingRow {
  cluster_id: string;
  article_id: string;
  articles: {
    title: string;
    published_at: string;
    sources: { bias: BiasCategory; kind: SourceKind | null } | null;
  } | null;
}

/** One cluster member as the twin rule sees it. */
interface TwinMember {
  title: string;
  zone: MediaDnaZone;
}

/**
 * The headline of an article as of the window close, from its title versions
 * (`article_title_versions`: one row per detected edit, `old_title` being the
 * title stored just before that edit, `seen_at` when the edit was recorded).
 *
 * - `excluded`: a version was recorded BEFORE `endIso` (`seen_at < endIso`), so the
 *   headline was already edited inside the window: the daily set leaves such an
 *   article out. A `seen_at` that cannot be read counts as before the close (the
 *   article stays out, as it does without the as-of reading).
 * - `title`: the title at the close. With a version recorded at or after `endIso`
 *   it is the `old_title` of the EARLIEST such version (the title the article
 *   carried when the window closed; `currentTitle` may be an edit written back
 *   afterwards and is ignored). Without one it is `currentTitle`, which no later
 *   edit can have touched. It is used ONLY for the internal twin comparison
 *   (`crossZoneTwinKeys` / `twinKey`) and is never served: a version's text is
 *   ledger text (migrations 056/074), not a headline.
 *
 * Pure and independent of the order the rows come back in (ties on `seen_at`
 * break on `old_title`), so two builds of one key agree whatever PostgREST does.
 * Throws on an unreadable `endIso`: reading every version as "after the close"
 * would be a silent fail-open.
 */
export function resolveTitleAsOf(
  currentTitle: string,
  versions: readonly TitleVersion[],
  endIso: string,
): { excluded: boolean; title: string } {
  const endMs = Date.parse(endIso);
  if (!Number.isFinite(endMs)) {
    throw new RangeError(`[gunun-tayfi] resolveTitleAsOf: unreadable window end "${endIso}"`);
  }
  let excluded = false;
  let earliest: { ms: number; oldTitle: string } | null = null;
  for (const version of versions) {
    const seenMs = Date.parse(version.seen_at);
    if (!Number.isFinite(seenMs) || seenMs < endMs) {
      excluded = true;
      continue;
    }
    if (
      earliest === null ||
      seenMs < earliest.ms ||
      (seenMs === earliest.ms && version.old_title < earliest.oldTitle)
    ) {
      earliest = { ms: seenMs, oldTitle: version.old_title };
    }
  }
  return { excluded, title: earliest ? earliest.oldTitle : currentTitle };
}

/** `rows` grouped by article id, each article's versions in the order read. */
function groupVersions(rows: readonly TitleVersionRow[]): Map<string, TitleVersionRow[]> {
  const byArticle = new Map<string, TitleVersionRow[]>();
  for (const row of rows) {
    const list = byArticle.get(row.article_id);
    if (list) list.push(row);
    else byArticle.set(row.article_id, [row]);
  }
  return byArticle;
}

/**
 * Every `article_title_versions` row of `ids`, as one PAGED read (PostgREST caps
 * a response at 1,000 rows; a cut-off read would hide an earlier version and so
 * change a headline). Ordered by the unique `(article_id, id)`. A read error and
 * a truncated read both come back as `{ data: null, error }`: the caller throws,
 * so no puzzle is ever built on part of the versions.
 */
async function readVersionRows(
  supabase: SupabaseClient,
  ids: readonly string[],
): Promise<{ data: TitleVersionRow[] | null; error: { message: string } | null }> {
  try {
    const { rows, truncated } = await readAllPages<TitleVersionRow>(
      (from, to) =>
        supabase
          .from("article_title_versions")
          .select("article_id, old_title, seen_at")
          .in("article_id", ids)
          .order("article_id", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to)
          .returns<TitleVersionRow[]>(),
      { label: "gunun-tayfi article_title_versions", maxPages: MAX_VERSION_PAGES },
    );
    if (truncated) return { data: null, error: { message: "truncated: versions incomplete" } };
    return { data: rows, error: null };
  } catch (err) {
    return { data: null, error: { message: err instanceof Error ? err.message : String(err) } };
  }
}

/**
 * Pages `jev_shadow_predictions` for `task = 'politics'`, `jev_prob >=
 * DAILY_POLITICS_MIN_PROB`, `created_at` in `[startIso, endIso)`, and a
 * non-null `article_id`. Returns the de-duplicated set of article ids —
 * order doesn't matter here, the caller re-sorts by `dailyHash`.
 */
async function fetchEligibleArticleIds(
  supabase: SupabaseClient,
  startIso: string,
  endIso: string,
): Promise<string[]> {
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
 * (used as an exclusion filter and, as of the close, to recover the text the
 * article carried then for the twin comparison only — a version's text is never
 * surfaced: the served headline is always `articles.title`).
 *
 * `asOf` false (keys before DAILY_TITLE_ASOF_FROM) is the rule the first puzzles
 * were served under: ANY version means "edited". `asOf` true reads the versions as
 * of `endIso` (`resolveTitleAsOf`): an article is "edited" only with a version seen
 * before the close, and `asOfTitles` carries the title at the close of an article
 * whose versions all came after it. `asOfTitles` feeds `withTwinFlag`'s comparison
 * and nothing else; it never reaches `DailyCandidate.title`.
 */
async function fetchArticleChunk(
  supabase: SupabaseClient,
  ids: readonly string[],
  endIso: string,
  asOf: boolean,
): Promise<{
  rows: Map<string, ArticleRow>;
  edited: Set<string>;
  asOfTitles: Map<string, string>;
}> {
  const [articlesResult, versionsResult] = await Promise.all([
    supabase
      .from("articles")
      .select(
        `id, title, url, published_at, created_at, source_id,
         category, politics_admitted_at,
         sources ( id, name, slug, bias, kind, active ),
         cluster_articles ( cluster_id )`,
      )
      .in("id", ids)
      .returns<ArticleRow[]>(),
    asOf
      ? readVersionRows(supabase, ids)
      : supabase
          .from("article_title_versions")
          .select("article_id, old_title, seen_at")
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
  const asOfTitles = new Map<string, string>();
  const versionRows = versionsResult.data ?? [];
  if (!asOf) {
    for (const row of versionRows) edited.add(row.article_id);
    return { rows, edited, asOfTitles };
  }

  for (const [articleId, versions] of groupVersions(versionRows)) {
    const row = rows.get(articleId);
    if (!row) continue; // no article row: the build skips the id anyway
    const resolved = resolveTitleAsOf(row.title, versions, endIso);
    if (resolved.excluded) edited.add(articleId);
    else asOfTitles.set(articleId, resolved.title);
  }
  return { rows, edited, asOfTitles };
}

/**
 * The twin-rule evidence of each cluster in `clusterIds`: every member that is
 * an outlet or a wire (a null kind is an outlet) and was published before
 * `endIso`. The window is closed and in the past, so nothing a source posts
 * afterwards can change the answer (a copy published later is not evidence).
 * Aggregator and niche members are never evidence.
 *
 * `asOf` (keys from DAILY_TITLE_ASOF_FROM) reads each member's title as of the
 * close too (`resolveTitleAsOf`, the same rule as a candidate's twin comparison,
 * and compared only, never served): a member that
 * edited its headline after the close still carries the text it ran inside the
 * window, so a later edit cannot make or break a twin. That is one more
 * `article_title_versions` read per batch of `TWIN_VERSION_BATCH` evidence member
 * ids (none when there is no evidence); keys before it make no such read.
 *
 * ONE paged read (`readAllPages`: PostgREST caps a response at 1,000 rows),
 * ordered by the primary key (cluster_id, article_id). A read error THROWS and
 * so does a truncated read: defaulting to "no twin" would make a puzzle differ
 * between two reads of the same day.
 */
async function fetchTwinEvidence(
  supabase: SupabaseClient,
  clusterIds: readonly string[],
  endIso: string,
  asOf: boolean,
): Promise<Map<string, TwinMember[]>> {
  const byCluster = new Map<string, TwinMember[]>();
  for (const id of clusterIds) byCluster.set(id, []);
  if (clusterIds.length === 0) return byCluster;

  const endMs = Date.parse(endIso);
  const { rows, truncated } = await readAllPages<SiblingRow>(
    (from, to) =>
      supabase
        .from("cluster_articles")
        .select(
          `cluster_id, article_id,
           articles ( title, published_at, sources ( bias, kind ) )`,
        )
        .in("cluster_id", clusterIds)
        .order("cluster_id", { ascending: true })
        .order("article_id", { ascending: true })
        .range(from, to)
        .returns<SiblingRow[]>(),
    { label: "gunun-tayfi cluster_articles", maxPages: MAX_SIBLING_PAGES },
  );
  if (truncated) {
    throw new Error("[gunun-tayfi] cluster_articles query truncated: twin evidence incomplete");
  }

  const evidence: Array<{ clusterId: string; articleId: string; title: string; zone: MediaDnaZone }> = [];
  for (const row of rows) {
    const article = row.articles;
    const source = article?.sources;
    if (!article || !source) continue;
    const kind = sourceKindOf({ kind: source.kind ?? undefined });
    if (kind !== "outlet" && kind !== "wire") continue;
    const publishedMs = Date.parse(article.published_at);
    if (!Number.isFinite(publishedMs) || publishedMs >= endMs) continue;
    evidence.push({
      clusterId: row.cluster_id,
      articleId: row.article_id,
      title: article.title,
      zone: zoneOf(source.bias),
    });
  }

  const versions = asOf ? await fetchMemberVersions(supabase, evidence.map((m) => m.articleId)) : null;
  for (const member of evidence) {
    const title = versions
      ? resolveTitleAsOf(member.title, versions.get(member.articleId) ?? [], endIso).title
      : member.title;
    byCluster.get(member.clusterId)?.push({ title, zone: member.zone });
  }
  return byCluster;
}

/**
 * The title versions of the evidence members `articleIds`, grouped by article:
 * one paged read per batch of `TWIN_VERSION_BATCH` distinct ids, the batches in
 * parallel. A read error or a truncated read THROWS (a twin decided on the
 * current titles would make a puzzle differ between two reads of the same day).
 */
async function fetchMemberVersions(
  supabase: SupabaseClient,
  articleIds: readonly string[],
): Promise<Map<string, TitleVersionRow[]>> {
  const unique = [...new Set(articleIds)];
  const batches: string[][] = [];
  for (let start = 0; start < unique.length; start += TWIN_VERSION_BATCH) {
    batches.push(unique.slice(start, start + TWIN_VERSION_BATCH));
  }
  const results = await Promise.all(batches.map((batch) => readVersionRows(supabase, batch)));
  const rows: TitleVersionRow[] = [];
  for (const result of results) {
    if (result.error) {
      throw new Error(
        `[gunun-tayfi] article_title_versions query failed (twin evidence): ${result.error.message}`,
      );
    }
    rows.push(...(result.data ?? []));
  }
  return groupVersions(rows);
}

/**
 * `candidate` with `crossZoneTwin` set: true when members of two or more zones
 * carry its text in its cluster. The candidate itself always counts as a member
 * (it is an outlet article of the window, but a future `published_at` would keep
 * it out of `evidence`). "Its text" is the twin key of `dailyTwinKeyVersion(dateKey)`.
 *
 * `comparedTitle` is the text the candidate is compared by: its title at the window
 * close for an as-of key (so a later edit cannot flip the flag), `candidate.title`
 * otherwise. It is used for the comparison only and is never stored on the
 * candidate: comparing against a version's `old_title` is not publishing it
 * (the served `candidate.title` stays `articles.title`).
 */
function withTwinFlag(
  candidate: DailyCandidate,
  evidence: ReadonlyMap<string, TwinMember[]>,
  dateKey: string,
  comparedTitle: string = candidate.title,
): DailyCandidate {
  const members = candidate.clusterId ? evidence.get(candidate.clusterId) : undefined;
  if (!members) return { ...candidate, crossZoneTwin: false };
  // Both calls take the version of the puzzle key: a key compares only with a key
  // of its own version.
  const version = dailyTwinKeyVersion(dateKey);
  const twins = crossZoneTwinKeys(
    [...members, { title: comparedTitle, zone: zoneOf(candidate.source.bias) }],
    version,
  );
  return { ...candidate, crossZoneTwin: twins.has(twinKey(comparedTitle, version)) };
}

/**
 * The candidate always carries `articles.title` as it stands: that is the text the
 * puzzle serves and every title check runs on. Version text (`old_title`) never
 * lands here (migrations 056/074).
 */
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
    category: row.category ?? null,
    politicsAdmittedAt: row.politics_admitted_at ?? null,
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
 * must never be cached as a puzzle (`fetchDailyPuzzleCached` below turns the
 * throw into a short-lived `{ ok: false }`).
 *
 * ONE reader client (4 s cap per request) serves every page and chunk of the
 * build, instead of a fresh client per helper call.
 */
async function buildDailyPuzzle(dateKey: string): Promise<DailyPuzzle> {
  const supabase = createReaderClient();
  const { startIso, endIso } = puzzleWindow(dateKey);
  const ids = await fetchEligibleArticleIds(supabase, startIso, endIso);

  const sortedIds = [...ids].sort(
    (a, b) => dailyHash(dateKey, a) - dailyHash(dateKey, b),
  );

  const collected: DailyCandidate[] = [];
  const maxIds = Math.min(sortedIds.length, MAX_ARTICLE_CHUNKS * ARTICLE_CHUNK_SIZE);
  // Keys before the gate never look at siblings: their sets stay byte-identical
  // and their build makes no new request.
  const twinGate = dateKey >= DAILY_TWIN_GATE_FROM;
  // Same for the as-of reading: keys before it make no member-version request.
  const asOf = dateKey >= DAILY_TITLE_ASOF_FROM;
  const twinEvidence = new Map<string, TwinMember[]>();

  for (let start = 0; start < maxIds; start += ARTICLE_CHUNK_SIZE) {
    const chunk = sortedIds.slice(start, start + ARTICLE_CHUNK_SIZE);
    const { rows, edited, asOfTitles } = await fetchArticleChunk(supabase, chunk, endIso, asOf);

    const fresh: DailyCandidate[] = [];
    for (const id of chunk) {
      if (edited.has(id)) continue; // stale/edited headline — exclusion only
      const row = rows.get(id);
      if (!row) continue;
      const candidate = toCandidate(row);
      if (candidate) fresh.push(candidate);
    }

    if (twinGate) {
      const unread = new Set<string>();
      for (const c of fresh) {
        if (c.clusterId && !twinEvidence.has(c.clusterId)) unread.add(c.clusterId);
      }
      for (const [clusterId, members] of await fetchTwinEvidence(supabase, [...unread], endIso, asOf)) {
        twinEvidence.set(clusterId, members);
      }
      // The twin comparison reads the candidate as of the close (an as-of key whose
      // article was edited after it); the served `c.title` is articles.title.
      for (const c of fresh) {
        collected.push(withTwinFlag(c, twinEvidence, dateKey, asOfTitles.get(c.articleId) ?? c.title));
      }
    } else {
      collected.push(...fresh);
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
 * graph, so a success is safe to cache for days at a time.
 *
 * Never throws (`attemptCached`): a throw across the `"use cache"` boundary
 * fails `next build`'s prerender (src/lib/cache-resilience.ts). Exactly ONE
 * `cacheLife` per invocation, chosen after the attempt: an error or an
 * incomplete set (a Jev pause, a cold-database AbortError) is memoised for
 * `minutes` only and heals on its own, instead of parking a failure for days.
 * Renamed from `fetchDailyPuzzle` because the return shape changed (a stale
 * pre-deploy entry must never be served with the old shape).
 */
export async function fetchDailyPuzzleCached(
  dateKey: string,
): Promise<CacheAttempt<DailyPuzzle>> {
  "use cache";
  cacheTag("daily-game");
  const r = await attemptCached("gunun-tayfi", () => buildDailyPuzzle(dateKey));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("days");
  else cacheLife("minutes");
  return r;
}

/**
 * Uncached fail-open wrapper: a failed attempt (a Jev pause, a Supabase
 * outage or timeout, an incomplete day) becomes `null`, so a bad day degrades
 * to the empty-state copy and is retried once the short `minutes` entry
 * expires.
 *
 * Deliberately NO live retry (unlike politics-query / blindspots-query): a
 * build is up to 14 sequential requests, far too heavy to repeat on every
 * request against a cold database, and the failure heals within ~60 s anyway.
 */
export async function getDailyPuzzle(dateKey: string): Promise<DailyPuzzle | null> {
  const r = await fetchDailyPuzzleCached(dateKey);
  if (r.ok) return r.data;
  console.error(`[gunun-tayfi] puzzle unavailable for ${dateKey}: ${r.error}`);
  return null;
}
