import { cacheLife, cacheTag } from "next/cache";

import { createReaderClient } from "@/lib/supabase/server";
import {
  WEEKLY_WIRE_MAX_IDS,
  normalizeWireIds,
  wireSignalsFromMembers,
  type WeeklyWireMemberRow,
  type WeeklyWireSignals,
} from "@/lib/weekly/weekly-wire";

// h208-roadmap-1: the one bounded member read behind the /hafta wire count.
//
// `getWeeklyClusters` and the archive read select `clusters` rows only, which
// carry no wire signal, so a wire redistribution on /hafta printed its raw member
// count as "N kaynak" while every other surface counts distinct texts. The page
// calls this with the ids of the rows it DISPLAYS (at most WEEKLY_WIRE_MAX_IDS:
// the 5 widest clusters and the 5 blindspots) and attaches the answer with
// `attachWeeklyWire` (weekly-wire.ts). Same shape as the cluster page's and
// /blindspots' member read: `cluster_articles` joined to `articles`, on the capped
// reader client, but only the five article columns the verdict needs (no title,
// url, image or source join).
//
// Bounded twice: the id list, and the rows (WEEKLY_WIRE_MAX_MEMBER_ROWS). The
// largest cluster of a week held 51 members on 2026-11-22, so ten of them fit with
// room to spare; a read that nevertheless FILLS the limit may have cut a cluster
// short, and a wrong text count would be worse than none, so it answers "unknown".
//
// FAILS OPEN: never throws, and `null` (an error, a timeout, a full read) leaves
// every row printing the plain "N kaynak" it always did. Nothing sensitive is
// logged: the message of the error, never an id.

/** The member columns `wireSignalOf` and the one-per-source rule read. */
const MEMBER_SELECT =
  "cluster_id, articles ( id, source_id, published_at, content_hash, description )";

/**
 * Hard ceiling on the member rows one read returns. PostgREST cuts any response
 * at 1,000 rows (tests/guards/postgrest-row-cap.test.ts), so this is the most a
 * read could ever return anyway; stating it keeps the bound explicit.
 */
export const WEEKLY_WIRE_MAX_MEMBER_ROWS = 1000;

export { WEEKLY_WIRE_MAX_IDS };

/**
 * `ids` must already be normalised (`normalizeWireIds`). `null` = could not be
 * read (an error, a throw, or a read that filled WEEKLY_WIRE_MAX_MEMBER_ROWS);
 * `{}` = read fine, no wire cluster among them.
 */
async function fetchWeeklyWire(ids: string[]): Promise<WeeklyWireSignals | null> {
  try {
    const supabase = createReaderClient();
    const { data, error } = await supabase
      .from("cluster_articles")
      .select(MEMBER_SELECT)
      .in("cluster_id", ids)
      .limit(WEEKLY_WIRE_MAX_MEMBER_ROWS)
      .returns<WeeklyWireMemberRow[]>();

    if (error) {
      console.error(`[weekly-wire] members unavailable: ${error.message}`);
      return null;
    }

    const rows = data ?? [];
    if (rows.length >= WEEKLY_WIRE_MAX_MEMBER_ROWS) {
      console.warn("[weekly-wire] member read filled its row limit; wire counts skipped");
      return null;
    }
    return wireSignalsFromMembers(rows);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[weekly-wire] members unavailable: ${message}`);
    return null;
  }
}

// Keyed by the sorted ids (the argument), so each set of displayed rows has its
// own entry. Cache lifetime follows the outcome, with exactly one `cacheLife`
// call after the read (`cacheTag` first): a read keeps the `cluster-feed`
// window, a failed read is memoised for `minutes` only, so a blip cannot pin
// "no wire cue" for the whole window. The fetcher never throws, so no
// `attemptCached` is needed: its `null` is the failure signal. No live retry
// either: the answer only adds a cue, and its absence is today's page.
async function getWeeklyWireCached(ids: string[]) {
  "use cache";
  cacheTag("clusters-politics");

  const data = await fetchWeeklyWire(ids);
  // One literal per call: Next 16.4 types cacheLife as single-literal overloads.
  if (data === null) cacheLife("minutes");
  else cacheLife("cluster-feed");
  return data === null
    ? ({ ok: false, error: "weekly wire unavailable" } as const)
    : ({ ok: true, data } as const);
}

/**
 * The wire verdict of the clusters a /hafta page displays: the wire clusters'
 * distinct-text and member counts, keyed by cluster id (`{}` when none is wire,
 * or when there is nothing to ask about, which makes no request). `null` = the
 * members could not be read; callers pass it to `attachWeeklyWire` unchanged and
 * the rows print as they always did. Never throws.
 */
export async function getWeeklyWireSignals(
  ids: readonly string[],
): Promise<WeeklyWireSignals | null> {
  const key = normalizeWireIds(ids);
  if (key.length === 0) return {};
  const result = await getWeeklyWireCached(key);
  return result.ok ? result.data : null;
}
