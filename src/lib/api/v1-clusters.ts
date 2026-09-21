import type { SupabaseClient } from "@supabase/supabase-js";

import { zoneOf } from "@/lib/bias/config";
import { siteUrl } from "@/lib/site-url";
import type { BiasCategory, MediaDnaZone } from "@/types";

/**
 * Pack E / B11 — read helpers for the keyed public API's cluster
 * endpoints (`/api/v1/clusters`, `/api/v1/clusters/[id]`).
 *
 * V1_CLUSTER_SELECT / V1_POLITICS_CATEGORIES / V1_POLITICS_THRESHOLD are a
 * DELIBERATE hand-duplication of the shapes `src/lib/clusters/politics-query.ts`
 * (CLUSTER_EMBED_SELECT / POLITICS_CATEGORIES / POLITICS_THRESHOLD) and
 * `supabase/functions/_shared/jev.ts` (JEV_POLITICS_CATEGORIES) already use.
 * That module feeds the home feed's hot path — pinning a new public-API
 * column onto its select string, or importing its unexported constants,
 * would couple an external contract (this pack) to an internal
 * performance-tuned query never meant to be a stable API surface. Same
 * "hand-duplicated constant, keep the two in sync by hand" precedent as
 * JEV_POLITICS_CATEGORIES.
 */

export const V1_CLUSTER_SELECT = `id, title_tr, title_tr_neutral, bias_distribution, is_blindspot, blindspot_side, article_count, first_published, updated_at,
         cluster_articles (
           articles (
             category,
             sources ( slug, bias )
           )
         )`;

export const V1_POLITICS_CATEGORIES = ["politika", "son_dakika"] as const;
export const V1_POLITICS_THRESHOLD = 0.6;

export const V1_DEFAULT_LIMIT = 50;
export const V1_MAX_LIMIT = 100;
export const V1_MAX_SINCE_DAYS = 7;

export interface V1ClusterRecord {
  id: string;
  title: string;
  url: string;
  first_published: string;
  updated_at: string;
  article_count: number;
  bias_distribution: Record<string, number>;
  is_blindspot: boolean;
  blindspot_side: string | null;
  topic7: string | null;
  sources: Array<{ slug: string; zone: MediaDnaZone }>;
}

// Row shapes matching V1_CLUSTER_SELECT's embedded PostgREST join. Named
// `V1Embedded*` (not reusing politics-query.ts's `Embedded*` types) since
// this is a narrower, independently-owned projection: only `category` and
// `sources.{slug,bias}` are ever read off a member article — see
// `toV1ClusterRecord` below for why that narrowness is load-bearing, not
// incidental.
export interface V1EmbeddedSource {
  slug: string;
  bias: BiasCategory;
}

export interface V1EmbeddedArticle {
  category: string;
  sources: V1EmbeddedSource | null;
}

export interface V1EmbeddedClusterArticle {
  articles: V1EmbeddedArticle | null;
}

export interface V1ClusterRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  bias_distribution: unknown;
  is_blindspot: boolean;
  blindspot_side: string | null;
  article_count: number;
  first_published: string;
  updated_at: string;
  cluster_articles: V1EmbeddedClusterArticle[] | null;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export function parseSince(
  raw: string | null,
  now: Date = new Date(),
): { since: string } | { error: string } {
  const floor = new Date(now.getTime() - V1_MAX_SINCE_DAYS * DAY_MS);

  if (raw === null || raw.trim() === "") {
    const d = new Date(now.getTime() - DAY_MS);
    return { since: d.toISOString() };
  }

  if (!ISO_RE.test(raw)) {
    return { error: "Invalid since: must be an ISO 8601 timestamp" };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { error: "Invalid since: must be an ISO 8601 timestamp" };
  }

  const clamped = parsed.getTime() < floor.getTime() ? floor : parsed;
  return { since: clamped.toISOString() };
}

export function parseLimit(raw: string | null): number | { error: string } {
  if (raw === null || raw.trim() === "") return V1_DEFAULT_LIMIT;
  if (!/^\d+$/.test(raw.trim())) {
    return { error: `Invalid limit: must be an integer 1..${V1_MAX_LIMIT}` };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > V1_MAX_LIMIT) {
    return { error: `Invalid limit: must be an integer 1..${V1_MAX_LIMIT}` };
  }
  return n;
}

export function isPoliticsMajority(row: V1ClusterRow): boolean {
  const members = (row.cluster_articles ?? [])
    .map((ca) => ca.articles)
    .filter((a): a is V1EmbeddedArticle => a !== null);
  if (members.length === 0) return false;
  const hits = members.filter((m) =>
    (V1_POLITICS_CATEGORIES as readonly string[]).includes(m.category),
  ).length;
  return hits / members.length >= V1_POLITICS_THRESHOLD;
}

function normalizeBiasDistribution(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

const ZONE_SORT_ORDER: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

/**
 * Row -> public wire record. Reads ONLY `category` (for the caller's
 * majority filter, not stored on the output) and `sources.{slug,bias}`
 * off each member — mirroring `src/lib/reports/yelpaze.ts`'s
 * `toFramingRef()`, which names each field it copies instead of
 * spreading a member/article object. That discipline is what makes this
 * function physically incapable of leaking an article title, url,
 * image_url or description: those fields are never read here, so there
 * is nothing to accidentally forward even if `V1_CLUSTER_SELECT` grew a
 * new embedded column in the future — a reviewer would have to add a new
 * *read* here too, not just widen the select string.
 *
 * `topic7` is intentionally a separate parameter (default `null`) rather
 * than a field read off `row`: `clusters.topic7` may not exist yet (see
 * `fetchTopic7` below), so the main select never requests it and this
 * function never assumes it is present on the row.
 */
export function toV1ClusterRecord(
  row: V1ClusterRow,
  topic7: string | null = null,
): V1ClusterRecord {
  const title =
    row.title_tr_neutral && row.title_tr_neutral.trim().length > 0
      ? row.title_tr_neutral
      : row.title_tr;

  const sourceMap = new Map<string, BiasCategory>();
  for (const ca of row.cluster_articles ?? []) {
    const src = ca.articles?.sources;
    if (!src) continue;
    if (!sourceMap.has(src.slug)) sourceMap.set(src.slug, src.bias);
  }
  const sources = Array.from(sourceMap.entries())
    .map(([slug, bias]) => ({ slug, zone: zoneOf(bias) }))
    .sort((a, b) => {
      const za = ZONE_SORT_ORDER.indexOf(a.zone);
      const zb = ZONE_SORT_ORDER.indexOf(b.zone);
      if (za !== zb) return za - zb;
      return a.slug.localeCompare(b.slug);
    });

  return {
    id: row.id,
    title,
    url: `${siteUrl()}/cluster/${row.id}`,
    first_published: row.first_published,
    updated_at: row.updated_at,
    article_count: row.article_count,
    bias_distribution: normalizeBiasDistribution(row.bias_distribution),
    is_blindspot: row.is_blindspot,
    blindspot_side: row.blindspot_side,
    topic7: topic7 ?? null,
    sources,
  };
}

// One-shot process-local probe flag. `clusters.topic7` is specified as
// "if present" and is not a documented column on this branch — rather
// than embed it in V1_CLUSTER_SELECT (which would 500 the whole query on
// every request until the column ships), we probe it ONCE and remember
// the answer, so a consumer can never distinguish "no topic" from
// "column not shipped yet" — both render as `topic7: null` forever until
// the next process/deploy.
let topic7Available = true;

export async function fetchTopic7(
  supabase: SupabaseClient,
  ids: string[],
): Promise<Map<string, string>> {
  if (!topic7Available || ids.length === 0) return new Map();

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await supabase
      .from("clusters")
      .select("id, topic7")
      .in("id", ids));
  } catch {
    topic7Available = false;
    return new Map();
  }

  if (error) {
    topic7Available = false;
    return new Map();
  }

  const map = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ id: string; topic7: string | null }>) {
    if (row.topic7) map.set(row.id, row.topic7);
  }
  return map;
}
