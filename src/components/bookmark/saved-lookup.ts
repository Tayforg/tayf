// Chunked lookup for /saved (h135, h134-reader-2). Pure and client-safe: no browser client, no storage, no clock.
//
// saved_clusters_v4 (migration 192; v3 from 158, v2 from 124 and v1 from 116 have the same caps) reads at most
// the first 200 ids of its input and returns at most 200 rows. /saved used to send only the newest 200 bookmarks,
// so a reader with more lost the older ones from the page with no notice: no link, no remove button, while the
// story page still showed them as saved. The ids now go out in chunks of at most 200, newest chunk first, and
// the answers are merged back into the page's order. The server's cap is unchanged (no migration, no RPC change);
// the client simply asks more than once, at most SAVED_MAX_CALLS = 5 times, so it looks at most 1000 bookmarks deep.
//
// Chunk 0 is exactly the set the page always sent (the newest 200 valid ids), so a reader with 200 bookmarks or
// fewer makes the one call it always made, with the same arguments. Chunks 1..4 are asked one after another, never
// in parallel: the anon key is shared and anyone can have a slow phone on a bad link, so a reader with 1000
// bookmarks costs the database five single requests in a row, not five at once, and at most one is ever in flight.
import { createElement, type ReactElement } from "react";

import { formatCountTr } from "@/lib/format/number-tr";

/** The one well-formed-id test of /saved. A malformed id (hand-edited storage) cannot match a cluster and would turn the whole uuid[] argument into a 400. */
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ids per RPC call: the cap of saved_clusters_v4 (migration 192), v3, v2 and v1. */
export const SAVED_RPC_MAX_IDS = 200;

/** How many bookmarks /saved looks up at most: the newest 1000, five calls. */
export const SAVED_MAX_IDS = 1000;

/** RPC calls per /saved load, at most. */
export const SAVED_MAX_CALLS = SAVED_MAX_IDS / SAVED_RPC_MAX_IDS;

export interface SavedLookupPlan {
  /** Newest chunk first; inside a chunk the stored order (oldest first) is kept. At most 200 ids each, at most 5 chunks, disjoint. */
  chunks: string[][];
  /** Every well-formed bookmark id. */
  total: number;
  /** How many of them the chunks ask for: the newest min(total, 1000). */
  requested: number;
}

/**
 * The ids to ask the RPC for. `idList` is the bookmark list as stored: Set.add appends, so its tail is the newest
 * bookmarks. Entries that are not well-formed UUID strings are skipped and not counted. The ids are unique (a Set
 * upstream); a repeated id would only cost a repeated row, which mergeSavedRows drops.
 */
export function savedLookupPlan(idList: readonly unknown[]): SavedLookupPlan {
  const valid = idList.filter((id): id is string => typeof id === "string" && UUID_RE.test(id));
  const window = valid.slice(-SAVED_MAX_IDS);
  const chunks: string[][] = [];
  for (let end = window.length; end > 0; end -= SAVED_RPC_MAX_IDS) {
    chunks.push(window.slice(Math.max(0, end - SAVED_RPC_MAX_IDS), end));
  }
  return { chunks, total: valid.length, requested: window.length };
}

export interface SavedRowLike {
  id: string;
  updated_at: string;
}

function stampOf(row: SavedRowLike): string {
  return typeof row.updated_at === "string" ? row.updated_at : "";
}

/**
 * The rows of every chunk as one list in the page's order, newest update first. A row is kept once (the first one
 * seen wins). The ISO strings the RPC returns share one shape (UTC, a fraction without trailing zeros), so
 * comparing them as strings is comparing them in time; equal stamps keep their order (earlier chunk, then earlier
 * index), because Array.prototype.sort is stable.
 */
export function mergeSavedRows<R extends SavedRowLike>(perChunk: readonly (readonly R[])[]): R[] {
  const seen = new Set<string>();
  const merged: R[] = [];
  for (const rows of perChunk) {
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged.sort((a, b) => {
    const x = stampOf(a);
    const y = stampOf(b);
    return x < y ? 1 : x > y ? -1 : 0;
  });
}

/**
 * The rows the change badges (device-local snapshots) look at: those of chunk 0, the newest 200 valid ids, in the
 * input order. This is exactly the set the page reconciled before h135, and it must stay that set. The merged list
 * can hold 1000 rows; reconciling all of them stamps a 'first-view' snapshot on every row that has none, and
 * writeSnapshots keeps only the newest SNAPSHOT_MAX_ENTRIES = 500 by `at`, so the freshly stamped entries evict the
 * older 'save' baselines (the newest 200 included) and the eviction rotates on every visit. 200 is 2.5 times
 * under that cap, so chunk 0 can never evict itself. Rows of the older chunks get no badge, as before h135, when
 * they had no row at all. A reader with 200 bookmarks or fewer has one chunk, so every row is kept.
 */
export function rowsForSnapshots<R extends { id: string }>(rows: readonly R[], plan: SavedLookupPlan): R[] {
  const newest = new Set(plan.chunks[0] ?? []);
  return rows.filter((row) => newest.has(row.id));
}

/**
 * Shown above the list when the reader has more bookmarks than /saved looks up. Nothing when everything is shown.
 * Short and factual; whole numbers with the Turkish dot ("1.000"). Built with createElement: this is a .ts module.
 */
export function SavedTruncationNote({ shown, total }: { shown: number; total: number }): ReactElement | null {
  if (!(total > shown)) return null;
  return createElement(
    "p",
    { className: "mb-3 text-xs text-muted-foreground" },
    `En yeni ${formatCountTr(shown)} kayıt gösteriliyor; toplam ${formatCountTr(total)} kayıt var.`,
  );
}

/**
 * The note for a lookup in which some chunks failed and some did not: the rows that arrived stay on the page.
 * The same register and closing sentence as SAVED_LOAD_FAILED_TEXT of saved-list.tsx (whole-page failure).
 */
export const SAVED_PARTIAL_TEXT = "Kaydedilenlerin bir kısmı yüklenemedi. Lütfen sayfayı yenileyin.";

/**
 * The text of the page's live region after a lookup has finished. A partial lookup announces SAVED_PARTIAL_TEXT;
 * when the previous text already is that, the same string comes back, so React bails out of the state update and
 * nothing is announced twice. A complete lookup removes the partial copy (the visible note is gone, so the region
 * must not keep saying it: the lookup re-runs when the bookmark list changes, e.g. from another tab) and leaves
 * every other text, such as a removal sentence, as it was.
 */
export function nextSavedAnnouncement(prev: string, partial: boolean): string {
  if (partial) return SAVED_PARTIAL_TEXT;
  return prev === SAVED_PARTIAL_TEXT ? "" : prev;
}

export type SavedLookupStatus = "ok" | "partial" | "failed";

/**
 * "ok" when no chunk failed. "failed" when every chunk did, or when some did and the others brought no row at all:
 * there is nothing to show, and the empty state ("no saved stories") would be false. Otherwise "partial": rows
 * arrived, so they stay on the page next to a note. `rows` is how many rows the chunks that answered returned.
 */
export function savedLookupStatus(attempted: number, failed: number, rows: number): SavedLookupStatus {
  if (failed <= 0) return "ok";
  return failed >= attempted || rows <= 0 ? "failed" : "partial";
}

/**
 * The RPCs /saved may name: the four allowlisted ones, newest first. Nothing else can be passed (the type), and the
 * browser client refuses every other name at run time (src/lib/supabase/browser.ts).
 */
export type SavedRpcName = "saved_clusters_v4" | "saved_clusters_v3" | "saved_clusters_v2" | "saved_clusters";

/** The one method of the browser client that /saved uses (structural: this module never imports the client). */
export interface SavedRpcClient {
  rpc<T = unknown>(
    name: SavedRpcName,
    args: { p_ids: string[] },
  ): Promise<{ data: T | null; error: { message: string; code?: string } | null }>;
}

/**
 * Asks the older chunks (chunks 1..4 of the plan) one after another, each with the RPC that answered chunk 0, and
 * returns the row lists of the chunks that answered plus the number of chunks that did not. A failed chunk is
 * logged (same prefix as the page's own lookup error) and skipped: it never discards the chunks that succeeded,
 * and it does not stop the chunks behind it. At most SAVED_MAX_CALLS - 1 calls are made, whatever it is given.
 * Returns null when `isCancelled()` turns true (the reader left the page): checked after every await, and no
 * further call is made after that.
 */
export async function fetchOlderSavedChunks<R>(
  client: SavedRpcClient,
  name: SavedRpcName,
  chunks: readonly string[][],
  isCancelled: () => boolean,
): Promise<{ results: R[][]; failed: number } | null> {
  const results: R[][] = [];
  let failed = 0;
  for (const chunk of chunks.slice(0, SAVED_MAX_CALLS - 1)) {
    let message: string | null = null;
    try {
      const res = await client.rpc<R[]>(name, { p_ids: chunk });
      if (isCancelled()) return null;
      if (res.error) message = res.error.message;
      else results.push(res.data ?? []);
    } catch (err) {
      if (isCancelled()) return null;
      message = err instanceof Error ? err.message : String(err);
    }
    if (message !== null) {
      console.warn("[saved] title lookup error:", message);
      failed += 1;
    }
  }
  return isCancelled() ? null : { results, failed };
}
