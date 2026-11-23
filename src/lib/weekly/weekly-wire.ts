import { wireSignalOf } from "@/lib/clusters/wire";
import type { WeeklyRowWire, WeeklySummary } from "@/lib/weekly/weekly-query";

// h208-roadmap-1: the /hafta week pages count a wire redistribution in distinct
// texts, like the cluster page, the embeds, every feed and the digest. The
// weekly loaders read `clusters` rows only, which carry no wire signal, so the
// page reads the members of the rows it DISPLAYS (weekly-wire-query.ts, one
// bounded read) and attaches the verdict here.
//
// Three pure steps, so they are testable without a Supabase round trip:
//   - `weeklyWireIds`: which clusters the page reads members for;
//   - `wireSignalsFromMembers`: members -> the wire clusters' text counts, by
//     the rule the cluster page and /blindspots use (one article per source,
//     the earliest, then `wireSignalOf`);
//   - `attachWeeklyWire`: the verdict onto the displayed rows.
//
// Pure on purpose (no next/cache, no client): the page tests keep this module
// real and mock only the read.

/**
 * Most clusters a page reads members for: the two lists it shows, each
 * WEEKLY_LIST_SIZE (5) rows. weekly-wire.test.ts pins the equality; it is a
 * literal here because this module must not import weekly-query's values (the
 * page tests replace that module).
 */
export const WEEKLY_WIRE_MAX_IDS = 10;

/** What a wire row carries: the cluster page's "N kaynak" and its member count. */
export interface WeeklyWireEntry {
  effectiveArticleCount: number;
  memberCount: number;
}

/** Wire clusters only, by cluster id. A cluster that is not wire has no key. */
export type WeeklyWireSignals = Record<string, WeeklyWireEntry>;

/** The article fields `wireSignalOf` and the one-per-source rule need. */
export interface WeeklyWireArticle {
  id: string;
  source_id: string | null;
  published_at: string | null;
  content_hash: string | null;
  description: string | null;
}

/**
 * One `cluster_articles` row with its embedded article. PostgREST returns a
 * to-one embed as an object, and the weekly readers handle a one-element array
 * too (weekly-query.ts `embeddedSourceOf`), so both are accepted.
 */
export interface WeeklyWireMemberRow {
  cluster_id: string;
  articles: WeeklyWireArticle | WeeklyWireArticle[] | null;
}

/**
 * The ids a read is made for: non-empty strings, de-duplicated, sorted (the
 * order is the cache key, so the same set always hits the same entry), at most
 * WEEKLY_WIRE_MAX_IDS.
 */
export function normalizeWireIds(ids: readonly unknown[]): string[] {
  const unique = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && id.trim() !== "") unique.add(id);
  }
  return [...unique].sort().slice(0, WEEKLY_WIRE_MAX_IDS);
}

/** The clusters a page displays: every top-cluster and blindspot row, once. */
export function weeklyWireIds(
  summary: Pick<WeeklySummary, "topClusters" | "blindspots">,
): string[] {
  return normalizeWireIds([
    ...summary.topClusters.map((c) => c.id),
    ...summary.blindspots.map((b) => b.id),
  ]);
}

function publishedMs(article: WeeklyWireArticle): number {
  const ms = article.published_at ? Date.parse(article.published_at) : Number.NaN;
  // An unreadable date sorts last: it never displaces a dated member.
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Earliest article per source, as `dedupeBySource` (blindspot-feed.ts) and the
 * cluster page do, so one prolific outlet is one member. A null source id is
 * its own source (a legacy row is never folded into another). Ties break on the
 * article id, so the answer does not depend on the read's row order.
 */
function earliestPerSource(articles: readonly WeeklyWireArticle[]): WeeklyWireArticle[] {
  const sorted = [...articles].sort(
    (a, b) => publishedMs(a) - publishedMs(b) || a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const kept: WeeklyWireArticle[] = [];
  for (const article of sorted) {
    const key = article.source_id ?? `__null__:${article.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(article);
  }
  return kept;
}

/**
 * The wire verdict of every cluster in `rows`, answered for the wire clusters
 * only. Members are de-duplicated per source, then judged by `wireSignalOf`
 * (the same shared-hash-or-agency-lead rule as every other surface; the member
 * title is not an input of the verdict, so it is not read). `null`, a non-list
 * and an empty list answer `{}`. A row without an embedded article is skipped.
 */
export function wireSignalsFromMembers(
  rows: readonly WeeklyWireMemberRow[] | null | undefined,
): WeeklyWireSignals {
  if (!Array.isArray(rows)) return {};

  const byCluster = new Map<string, WeeklyWireArticle[]>();
  for (const row of rows) {
    const article = Array.isArray(row.articles) ? row.articles[0] : row.articles;
    if (!article) continue;
    const group = byCluster.get(row.cluster_id);
    if (group) group.push(article);
    else byCluster.set(row.cluster_id, [article]);
  }

  const entries: Array<[string, WeeklyWireEntry]> = [];
  for (const [clusterId, articles] of byCluster) {
    const wire = wireSignalOf(
      earliestPerSource(articles).map((a) => ({
        id: a.id,
        content_hash: a.content_hash,
        description: a.description,
      })),
    );
    if (wire.isWireRedistribution && wire.effectiveArticleCount > 0) {
      entries.push([
        clusterId,
        {
          effectiveArticleCount: wire.effectiveArticleCount,
          memberCount: wire.memberCount,
        },
      ]);
    }
  }
  // fromEntries defines own properties, so no id can reach the prototype.
  return Object.fromEntries(entries);
}

function usableEntry(entry: WeeklyWireEntry | undefined): entry is WeeklyWireEntry {
  return (
    entry !== undefined &&
    Number.isFinite(entry.effectiveArticleCount) &&
    entry.effectiveArticleCount > 0 &&
    Number.isFinite(entry.memberCount) &&
    entry.memberCount > 0
  );
}

/**
 * Puts the wire verdict on the displayed rows. A wire row gains `isWire`,
 * `effectiveArticleCount` and `memberCount` (WeeklyRowWire); every other row is
 * returned as the very same object. `null` signals (the member read failed) or
 * no wire cluster among the rows return the summary itself, so the page renders
 * exactly as it did before. Pure and non-mutating; no figure of the summary
 * (article counts, zone counts, tallies) is rewritten.
 */
export function attachWeeklyWire(
  summary: WeeklySummary,
  signals: WeeklyWireSignals | null | undefined,
): WeeklySummary {
  if (!signals) return summary;

  let touched = false;
  const withWire = <T extends { id: string }>(row: T): T | (T & WeeklyRowWire) => {
    const entry = Object.prototype.hasOwnProperty.call(signals, row.id)
      ? signals[row.id]
      : undefined;
    if (!usableEntry(entry)) return row;
    touched = true;
    return {
      ...row,
      isWire: true,
      effectiveArticleCount: entry.effectiveArticleCount,
      memberCount: entry.memberCount,
    };
  };

  const topClusters = summary.topClusters.map(withWire);
  const blindspots = summary.blindspots.map(withWire);
  return touched ? { ...summary, topClusters, blindspots } : summary;
}
