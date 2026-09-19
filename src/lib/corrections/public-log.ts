import { cacheLife, cacheTag } from "next/cache";

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
// so a Supabase hiccup degrades to null (the page renders an honest
// "unavailable" state) rather than taking the route down.

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

/**
 * Reviewed corrections, newest decision first. `null` means "could not read"
 * (the page says so); `[]` means "nothing reviewed yet" (the page says that
 * instead — an empty log is an honest state, not an error).
 */
export async function getPublicCorrections(
  limit = PUBLIC_LOG_LIMIT
): Promise<PublicCorrection[] | null> {
  "use cache";
  cacheLife("source-directory");
  cacheTag("corrections");

  try {
    const supabase = createServerClient();

    const { data, error } = await supabase
      .from("corrections")
      .select(PUBLIC_LOG_SELECT)
      .eq("status", "reviewed")
      .order("reviewed_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      // Never throw — see the file header.
      console.error(`[corrections] public log unavailable: ${error.message}`);
      return null;
    }

    return shapePublicCorrections((data ?? []) as RawCorrectionRow[]);
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    console.error(`[corrections] public log unavailable: ${message}`);
    return null;
  }
}
