// Pure model of the session-scoped compare tray (max two cluster ids). The
// browser plumbing (sessionStorage + useSyncExternalStore) lives in
// src/components/compare/use-compare-tray.ts; everything here is data in,
// data out so it can be tested without a DOM.

import { compareHref, normalizeCompareId } from "@/lib/compare/compare-params";

export const COMPARE_TRAY_KEY = "tayf:compare";
export const COMPARE_TRAY_EVENT = "tayf:compare-change";
export const COMPARE_TRAY_MAX = 2;

/**
 * Parses the stored JSON. Anything malformed degrades to [] (or to the valid
 * subset): bad JSON, a non-array, non-string or non-UUID entries. Entries are
 * lowercased, deduped (first occurrence wins) and capped to the LAST two.
 */
export function parseTray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const entry of parsed) {
    const id = normalizeCompareId(entry);
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(-COMPARE_TRAY_MAX);
}

/**
 * Appends `id`; a no-op when it is already present or not a UUID. When the
 * tray would exceed two entries the oldest is evicted (FIFO).
 */
export function addToTray(tray: readonly string[], id: string): string[] {
  const normalized = normalizeCompareId(id);
  if (!normalized || tray.includes(normalized)) return [...tray];
  return [...tray, normalized].slice(-COMPARE_TRAY_MAX);
}

export function removeFromTray(tray: readonly string[], id: string): string[] {
  const normalized = normalizeCompareId(id) ?? id;
  return tray.filter((entry) => entry !== normalized);
}

/** The compare-view link, available only once two stories are in the tray. */
export function trayHref(tray: readonly string[]): string | null {
  if (tray.length !== COMPARE_TRAY_MAX) return null;
  return compareHref(tray[0], tray[1]);
}

export const COMPARE_HINT_ONE =
  "Karşılaştırmaya eklendi · ikinci haberi açıp “Karşılaştır”a dokunun";
export const COMPARE_HINT_TWO = "İki haber seçildi · karşılaştırmaya hazır";

/**
 * What the compare chip's live region says. `srOnly` = for screen readers
 * only (the visible UI already shows it, or there is nothing to show).
 * Precedence:
 *  1. this story is in a full tray  -> "ready" (the link says it on screen)
 *  2. this story is in the tray     -> how to pick the second story
 *  3. the tray holds two others     -> adding this one evicts the oldest pick
 *  4. the tray holds one other      -> adding this one makes the pair
 *  5. otherwise                     -> `notice`, the outcome of the reader's
 *     last "Vazgeç" / "Temizle" (the tray emptied, so nothing visible changed).
 * The `notice` never overrides a tray state: it is stale once the tray is
 * non-empty again.
 */
export function compareHint({
  tray,
  id,
  notice = "",
}: {
  tray: readonly string[];
  id: string;
  notice?: string;
}): { text: string; srOnly: boolean } {
  const inTray = tray.includes(id);
  if (inTray && tray.length >= COMPARE_TRAY_MAX) {
    return { text: COMPARE_HINT_TWO, srOnly: true };
  }
  if (inTray) return { text: COMPARE_HINT_ONE, srOnly: false };
  if (tray.length >= COMPARE_TRAY_MAX) {
    return {
      text: `${tray.length} haber seçili · eklerseniz ilk seçim çıkar`,
      srOnly: false,
    };
  }
  if (tray.length === 1) {
    return { text: "1 haber seçili · bunu ikinci olarak ekleyin", srOnly: false };
  }
  return { text: notice, srOnly: true };
}
