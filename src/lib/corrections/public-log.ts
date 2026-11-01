import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { createServerClient } from "@/lib/supabase/server";

// Fetcher for /duzeltmeler (S-18) — the public, honest log of corrections a
// reader reported and an editor actually reviewed.
//
// Privacy contract (the reason this module exists instead of an inline
// query): the `corrections` table (migrations 033 + 042) also stores the
// reader's free-text `message` and optional `email`. Neither is ever
// published, so neither is ever SELECTed — PUBLIC_LOG_SELECT is the single
// place that decides what leaves the database, `shapePublicCorrections`
// re-projects onto a closed set of keys, and both are pinned by tests. If a
// column is added to the table, it stays out of the page unless it is added
// here deliberately.
//
// The one exception is `url`, the page address the reader submitted the form
// from. It is SELECTed for server-side derivation ONLY: `deriveSubject` reads
// it to work out what the correction was about (a cluster, a source label, or
// nothing specific) and the shaped object keeps just that derived subject.
// The url string itself — and any query or fragment on it — never leaves this
// module; the "privacy pin" tests assert both the closed key set and that no
// submitted url survives into the serialised result. Only tayfhaber.com /
// www.tayfhaber.com addresses with a strictly validated /source/<slug> or
// /cluster/<uuid> path are ever interpreted; anything else is "general".
//
// Only rows with status = 'reviewed' are listed: 'open' means nobody has
// looked yet, and 'dismissed' would publish an accusation the editor did not
// uphold. `reviewed_at` is stamped by the admin PATCH route whenever status
// leaves 'open', so ordering on it puts the most recent decision first.
//
// `nullsFirst: false` is load-bearing: migration 033 already allowed
// status = 'reviewed' and 042 added `reviewed_at` without backfilling it, so
// a pre-042 row carries a null stamp. Postgres sorts DESC NULLS FIRST by
// default, which would float those undated rows to the top of the page and
// crowd out recent decisions; `created_at` breaks the remaining ties.
//
// Never throws: a throw inside "use cache" during prerender fails the build,
// so the read is a raw `fetchPublicCorrections` that throws, wrapped by
// `attemptCached` inside `getPublicCorrectionsCached`, and a Supabase hiccup
// degrades to null (the page renders an honest "unavailable" state) rather
// than taking the route down. The cache lifetime is chosen AFTER the attempt
// (2026-10-24 /sources '—' incident): a log keeps the 1 h `source-directory`
// window, a failed read is cached for `minutes` only. (`cacheLife` used to run
// before the query, so one timeout showed "unavailable" for the whole hour.)
// No live retry; same shape as src/lib/clusters/timeline-query.ts, guarded by
// tests/guards/cache-life-after-attempt.test.ts.

/**
 * The only columns that may leave the database for the public log.
 * MUST NOT contain `email` or `message` — pinned in public-log.test.ts.
 *
 * `url` is selected for server-side subject derivation only (see
 * `deriveSubject`) and never leaves this module: the shaped rows carry the
 * derived subject, not the address.
 */
export const PUBLIC_LOG_SELECT =
  "id, cluster_id, url, created_at, reviewed_at, cluster:clusters ( id, title_tr, title_tr_neutral )";

/** How many reviewed corrections the public page lists by default. */
export const PUBLIC_LOG_LIMIT = 100;

/** Shown when a cluster exists but has neither a neutral nor a raw title. */
const UNTITLED_CLUSTER = "Başlıksız küme";

/**
 * What a published correction was about. `cluster_gone` means the cluster the
 * report pointed at really no longer exists; `general` means the report was
 * not about a specific cluster or source (or its address could not be
 * trusted), so the page says so instead of guessing.
 */
export type PublicSubject =
  | { kind: "cluster"; clusterId: string; title: string }
  | { kind: "source"; slug: string; name: string }
  | { kind: "cluster_gone" }
  | { kind: "general" };

export interface PublicCorrection {
  id: string;
  subject: PublicSubject;
  createdAt: string;
  reviewedAt: string | null;
}

/**
 * Names resolved from the url-derived keys of rows that have no `cluster_id`:
 * source slug -> display name, cluster id (lower-case) -> title (null when the
 * cluster exists but is untitled). Absence from a map means "does not exist".
 */
export interface PublicLogLookups {
  sources: ReadonlyMap<string, string>;
  clusters: ReadonlyMap<string, string | null>;
}

/** Embedded cluster, as PostgREST may return it: object, array, or absent. */
type ClusterEmbed =
  | { id?: unknown; title_tr?: unknown; title_tr_neutral?: unknown }
  | null
  | undefined;

export type RawCorrectionRow = {
  id?: unknown;
  cluster_id?: unknown;
  url?: unknown;
  created_at?: unknown;
  reviewed_at?: unknown;
  cluster?: ClusterEmbed | ClusterEmbed[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Neutral title first, raw title second; null when neither is usable. */
function titleOf(row: { title_tr?: unknown; title_tr_neutral?: unknown }): string | null {
  return asString(row.title_tr_neutral) ?? asString(row.title_tr);
}

/**
 * A `!inner`-less embed arrives as an object for a to-one relationship, but
 * PostgREST (and its typegen) also hands back a one-element array depending
 * on how the FK is resolved — normalise both, and null for a missing cluster.
 */
function embedOf(embed: ClusterEmbed | ClusterEmbed[]): NonNullable<ClusterEmbed> | null {
  const one = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  return one && typeof one === "object" ? one : null;
}

// --- url parsing (pure; the url is never returned, only what it points at) --

const SITE_HOSTS: ReadonlySet<string> = new Set(["tayfhaber.com", "www.tayfhaber.com"]);
const SOURCE_PATH_RE = /^\/source\/([a-z0-9][a-z0-9-]{0,63})\/?$/;
const CLUSTER_PATH_RE =
  /^\/cluster\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;

/** Pathname of an http(s) url on our own host (no port); null for anything else. */
function ownPathname(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    return SITE_HOSTS.has(parsed.host) ? parsed.pathname : null;
  } catch {
    return null;
  }
}

/** `/source/<slug>` on tayfhaber.com -> slug. Query and hash are ignored. */
export function sourceSlugFromUrl(url: string | null | undefined): string | null {
  const path = ownPathname(url);
  return path === null ? null : (SOURCE_PATH_RE.exec(path)?.[1] ?? null);
}

/** `/cluster/<uuid>` on tayfhaber.com -> lower-cased uuid. Query and hash are ignored. */
export function clusterIdFromUrl(url: string | null | undefined): string | null {
  const path = ownPathname(url);
  const id = path === null ? null : (CLUSTER_PATH_RE.exec(path)?.[1] ?? null);
  return id === null ? null : id.toLowerCase();
}

// --- subject derivation + shaping -------------------------------------------

/**
 * What one reviewed correction was about. Pure.
 *
 * 1. `cluster_id` set: the FK embed decides — a title means "cluster", no
 *    embed means the cluster is gone.
 * 2. Otherwise (the FK is null: the form was opened on a source page, or the
 *    cluster was deleted): the submitted url is parsed. A /source/<slug> that
 *    exists is "source" (an unknown slug is "general"); a /cluster/<uuid> that
 *    is found is "cluster" and one that is not found is "cluster_gone".
 * 3. Anything else — a third-party host, an unrelated page — is "general".
 */
export function deriveSubject(row: RawCorrectionRow, lookups: PublicLogLookups): PublicSubject {
  const clusterId = asString(row.cluster_id);
  if (clusterId) {
    const embed = embedOf(row.cluster);
    return embed
      ? { kind: "cluster", clusterId, title: titleOf(embed) ?? UNTITLED_CLUSTER }
      : { kind: "cluster_gone" };
  }

  const url = asString(row.url);

  const slug = sourceSlugFromUrl(url);
  if (slug) {
    const name = lookups.sources.get(slug);
    return name === undefined ? { kind: "general" } : { kind: "source", slug, name };
  }

  const urlClusterId = clusterIdFromUrl(url);
  if (urlClusterId) {
    return lookups.clusters.has(urlClusterId)
      ? {
          kind: "cluster",
          clusterId: urlClusterId,
          title: lookups.clusters.get(urlClusterId) ?? UNTITLED_CLUSTER,
        }
      : { kind: "cluster_gone" };
  }

  return { kind: "general" };
}

export function shapePublicCorrections(
  rows: RawCorrectionRow[],
  lookups: PublicLogLookups,
): PublicCorrection[] {
  const shaped: PublicCorrection[] = [];

  for (const row of rows) {
    const id = asString(row?.id);
    const createdAt = asString(row?.created_at);
    if (!id || !createdAt) continue;

    shaped.push({
      id,
      subject: deriveSubject(row, lookups),
      createdAt,
      reviewedAt: asString(row.reviewed_at),
    });
  }

  return shaped;
}

/** Slugs and cluster ids the rows' urls point at, for rows with no `cluster_id`. */
function lookupKeys(rows: RawCorrectionRow[]): { slugs: string[]; clusterIds: string[] } {
  const slugs = new Set<string>();
  const clusterIds = new Set<string>();

  for (const row of rows) {
    if (!asString(row?.id) || !asString(row?.created_at)) continue; // dropped by shaping
    if (asString(row.cluster_id)) continue; // the FK embed already answers
    const url = asString(row.url);
    const slug = sourceSlugFromUrl(url);
    if (slug) {
      slugs.add(slug);
      continue;
    }
    const clusterId = clusterIdFromUrl(url);
    if (clusterId) clusterIds.add(clusterId);
  }

  return { slugs: [...slugs], clusterIds: [...clusterIds] };
}

// Raw read: THROWS on a Supabase error so a failure can never be mistaken for
// "nothing reviewed yet". Only the error message is carried into the throw,
// never a row (the reader's message, email and url stay out of logs).
//
// A lookup failure throws too, deliberately: if it degraded to "general" the
// `attemptCached` wrapper would see success and pin the degraded labels for
// the full hour. Thrown, the whole read is memoised as a failure for minutes.
async function fetchPublicCorrections(limit: number): Promise<PublicCorrection[]> {
  const supabase = createServerClient();

  const { data, error } = await supabase
    .from("corrections")
    .select(PUBLIC_LOG_SELECT)
    .eq("status", "reviewed")
    .order("reviewed_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(limit);

  if (error) {
    throw new Error(`public corrections query failed: ${error.message}`);
  }

  const rows = (data ?? []) as RawCorrectionRow[];
  const { slugs, clusterIds } = lookupKeys(rows);

  // At most two extra queries, and none when no row needs them.
  const [sourcesRes, clustersRes] = await Promise.all([
    slugs.length > 0 ? supabase.from("sources").select("slug, name").in("slug", slugs) : null,
    clusterIds.length > 0
      ? supabase.from("clusters").select("id, title_tr, title_tr_neutral").in("id", clusterIds)
      : null,
  ]);

  if (sourcesRes?.error) {
    throw new Error(`public corrections source lookup failed: ${sourcesRes.error.message}`);
  }
  if (clustersRes?.error) {
    throw new Error(`public corrections cluster lookup failed: ${clustersRes.error.message}`);
  }

  const sources = new Map<string, string>();
  for (const r of (sourcesRes?.data ?? []) as Array<{ slug?: unknown; name?: unknown }>) {
    const slug = asString(r?.slug);
    if (slug) sources.set(slug, asString(r.name) ?? slug);
  }

  const clusters = new Map<string, string | null>();
  for (const r of (clustersRes?.data ?? []) as Array<{
    id?: unknown;
    title_tr?: unknown;
    title_tr_neutral?: unknown;
  }>) {
    const id = asString(r?.id);
    if (id) clusters.set(id.toLowerCase(), titleOf(r));
  }

  return shapePublicCorrections(rows, { sources, clusters });
}

// `attemptCached` keeps the throw from crossing the `"use cache"` boundary.
// Lifetime follows the outcome: a log keeps `source-directory`, a failed
// attempt is memoised for `minutes` only. `limit` is part of the cache key.
// Exactly one `cacheLife` call per invocation, after the attempt; `cacheTag`
// first.
async function getPublicCorrectionsCached(limit: number) {
  "use cache";
  cacheTag("corrections");
  const r = await attemptCached("corrections-log", () => fetchPublicCorrections(limit));
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Reviewed corrections, newest decision first. `null` means "could not read"
 * (the page says so); `[]` means "nothing reviewed yet" (the page says that
 * instead — an empty log is an honest state, not an error). Never throws.
 */
export async function getPublicCorrections(
  limit = PUBLIC_LOG_LIMIT
): Promise<PublicCorrection[] | null> {
  const r = await getPublicCorrectionsCached(limit);
  return r.ok ? r.data : null;
}
