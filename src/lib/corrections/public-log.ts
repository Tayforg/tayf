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
 */
export const PUBLIC_LOG_SELECT =
  "id, cluster_id, created_at, reviewed_at, cluster:clusters ( id, title_tr, title_tr_neutral )";

/** How many reviewed corrections the public page lists by default. */
export const PUBLIC_LOG_LIMIT = 100;

export interface PublicCorrection {
  id: string;
  clusterId: string | null;
  clusterTitle: string | null;
  createdAt: string;
  reviewedAt: string | null;
}

/** Embedded cluster, as PostgREST may return it: object, array, or absent. */
type ClusterEmbed =
  | { id?: unknown; title_tr?: unknown; title_tr_neutral?: unknown }
  | null
  | undefined;

type RawCorrectionRow = {
  id?: unknown;
  cluster_id?: unknown;
  created_at?: unknown;
  reviewed_at?: unknown;
  cluster?: ClusterEmbed | ClusterEmbed[];
};

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A `!inner`-less embed arrives as an object for a to-one relationship, but
 * PostgREST (and its typegen) also hands back a one-element array depending
 * on how the FK is resolved — normalise both, and neither for a deleted
 * cluster (`cluster_id` is ON DELETE SET NULL).
 */
function embedTitle(embed: ClusterEmbed | ClusterEmbed[]): string | null {
  const one = Array.isArray(embed) ? (embed[0] ?? null) : (embed ?? null);
  if (!one || typeof one !== "object") return null;
  return asString(one.title_tr_neutral) ?? asString(one.title_tr);
}

export function shapePublicCorrections(rows: RawCorrectionRow[]): PublicCorrection[] {
  const shaped: PublicCorrection[] = [];

  for (const row of rows) {
    const id = asString(row?.id);
    const createdAt = asString(row?.created_at);
    if (!id || !createdAt) continue;

    shaped.push({
      id,
      clusterId: asString(row.cluster_id),
      clusterTitle: embedTitle(row.cluster),
      createdAt,
      reviewedAt: asString(row.reviewed_at),
    });
  }

  return shaped;
}

// Raw read: THROWS on a Supabase error so a failure can never be mistaken for
// "nothing reviewed yet". Only the error message is carried into the throw,
// never a row (the reader's message and email stay out of logs).
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

  return shapePublicCorrections((data ?? []) as RawCorrectionRow[]);
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
