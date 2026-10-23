import { cacheLife, cacheTag } from "next/cache";

import { attemptCached } from "@/lib/cache-resilience";
import { getSourceAgreement, type ReaderAgreement } from "@/lib/game/agreement";
import type { RegistrySourceRow } from "@/lib/sources/registry";
import { createReaderClient } from "@/lib/supabase/server";

// Data layer behind the public registry JSON: GET /api/sources and
// GET /api/sources/[slug].
//
// Why this exists: both routes are anonymous and were uncached, so every hit
// (including `?cb=<random>` cache-busters, which a CDN treats as a new URL)
// cost a Supabase round trip, and the detail route paid for five queries. The
// reads now sit behind cached, 4 s-capped readers whose KEY IGNORES THE QUERY
// STRING by construction:
//
//   - the list takes no argument, so there is exactly one entry;
//   - the detail takes the source ROW ID. The route resolves the URL slug
//     against the cached rows first and only then asks for the detail, so the
//     key space is bounded by the number of real sources, never by what an
//     anonymous caller can put in a URL.
//
// Shape (same as getBlindspots in src/lib/clusters/blindspots-query.ts):
// `attemptCached` inside the `"use cache"` body so nothing ever throws across
// the cache boundary (a throw there fails `next build`'s prerender even when
// the caller catches; see src/lib/cache-resilience.ts), then ONE live retry in
// the uncached public getter, then a THROW. The registry is a contract, not
// decoration: a sustained outage must surface as the route's 500, never as a
// 200 with an empty `sources` array that a consumer would take at face value
// (and that the CDN would then hold for an hour).
//
// Exactly ONE `cacheLife` per cached invocation, chosen after the attempt: a
// failed attempt (typically the 4 s reader abort on a cold database) is
// memoised for `minutes` only; a success keeps `source-directory`.

/** A `sources` row as the registry reads it: the public columns plus the id. */
export interface RegistryRow extends RegistrySourceRow {
  id: string;
}

/** One `source_zone_history` row exactly as the public wire carries it. */
export interface ZoneHistoryRow {
  old_bias: string | null;
  new_bias: string;
  reason: string | null;
  rater: string | null;
  changed_at: string;
}

export interface RegistryDetail {
  zone_history: ZoneHistoryRow[];
  reader_agreement: ReaderAgreement | null;
}

// The explicit allowlist: never `*`, never `rss_url`. `id` is selected so the
// detail route can key the cached detail by it; `toRegistryRecord` picks its
// fields by name, so the id never reaches the public record.
const REGISTRY_COLUMNS =
  "id, slug, name, url, bias, kind, active, zone_rationale, zone_rationale_at, trustee_since, trustee_note";

/**
 * Newest-first, capped at 50: a citable "recent changes" window rather than
 * an unbounded export. `.order(..., { ascending: false })` is load-bearing
 * - do not drop it, the history is meaningless (and the cap picks the wrong
 * 50 rows) without it.
 */
const ZONE_HISTORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

// Uncached implementation. THROWS on a read error.
async function fetchRegistryRows(): Promise<RegistryRow[]> {
  const supabase = createReaderClient();
  const { data, error } = await supabase
    .from("sources")
    .select(REGISTRY_COLUMNS)
    .eq("active", true)
    .order("name");

  if (error) {
    throw new Error(`[registry] sources read failed: ${error.message}`);
  }
  return (data ?? []) as unknown as RegistryRow[];
}

async function getRegistryRowsCached() {
  "use cache: remote";
  cacheTag("sources");
  const r = await attemptCached("registry-rows", () => fetchRegistryRows());
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Every active source, ordered by name. Takes NO argument on purpose (see the
 * file header). Retries the read live once when the cached attempt failed
 * (the live result is not memoised; the cached `{ ok: false }` sentinel is),
 * then THROWS.
 */
export async function getRegistryRows(): Promise<RegistryRow[]> {
  const attempt = await getRegistryRowsCached();
  if (attempt.ok) return attempt.data;
  return fetchRegistryRows();
}

// ---------------------------------------------------------------------------
// One source's detail
// ---------------------------------------------------------------------------

// Uncached implementation. THROWS on a history read error. The reader
// agreement is the bonus field: `getSourceAgreement` never throws and returns
// `null` when it cannot answer (too few guesses, or the read failed), so it
// degrades to `null` rather than taking the endpoint down.
async function fetchRegistryDetail(sourceId: string): Promise<RegistryDetail> {
  const supabase = createReaderClient();

  const [history, readerAgreement] = await Promise.all([
    supabase
      .from("source_zone_history")
      .select("old_bias, new_bias, reason, rater, changed_at")
      .eq("source_id", sourceId)
      .order("changed_at", { ascending: false })
      .limit(ZONE_HISTORY_LIMIT),
    getSourceAgreement(sourceId),
  ]);

  if (history.error) {
    throw new Error(
      `[registry] zone history read failed: ${history.error.message}`,
    );
  }

  return {
    zone_history: (history.data ?? []) as unknown as ZoneHistoryRow[],
    reader_agreement: readerAgreement,
  };
}

async function getRegistryDetailCached(sourceId: string) {
  "use cache: remote";
  cacheTag("sources");
  const r = await attemptCached("registry-detail", () =>
    fetchRegistryDetail(sourceId),
  );
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (r.ok) cacheLife("source-directory");
  else cacheLife("minutes");
  return r;
}

/**
 * Zone history (newest first, capped at 50) and the aggregate reader
 * agreement for one source. `sourceId` MUST be a row id taken from
 * `getRegistryRows()`, never a value read from the URL: it is the cache key.
 * Same contract as `getRegistryRows`: one live retry, then THROWS.
 */
export async function getRegistryDetail(
  sourceId: string,
): Promise<RegistryDetail> {
  const attempt = await getRegistryDetailCached(sourceId);
  if (attempt.ok) return attempt.data;
  return fetchRegistryDetail(sourceId);
}
