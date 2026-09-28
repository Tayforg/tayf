/**
 * src/lib/game/daily-set.ts — pure, deterministic core of "Günün Tayf'ı"
 * (the daily 5-headline zone-guessing mode under /oyun's third tab).
 *
 * WHY "yesterday's headlines" is a deliberate reading of "from today":
 * the puzzle set must be byte-identical for every visitor of Istanbul day
 * D, with no server-side storage (no migration is reserved for this
 * feature) — it is recomputed per serverless instance and per cache miss.
 * A still-open window of TODAY's news would keep changing as articles and
 * Jev predictions arrive, so different visitors (or the same visitor on a
 * cache miss an hour later) would see different sets. The puzzle for
 * Istanbul date D is therefore built from a CLOSED window: articles seen
 * during Istanbul day D-1, i.e. [D-1 00:00, D 00:00) at +03. Nothing
 * written after the window closes can change the set (barring a rare
 * source deactivation — see daily-query.ts's module doc comment).
 *
 * This module NEVER calls `Date.now()` / `new Date()` with an implicit
 * "now" — every date it touches is derived from an explicit `dateKey`
 * (or `ms`) argument, so it is safe to call from inside a `"use cache"`
 * scope (daily-query.ts) without poisoning the cached result with the
 * render-time clock.
 */

import { zoneOf } from "@/lib/bias/config";
import { sourceKindOf } from "@/lib/sources/kind";
import { isGameEligibleTitle } from "./pii-filter";
import type { BiasCategory, MediaDnaZone, SourceKind } from "@/types";

// ===========================================================================
// Constants
// ===========================================================================

export const DAILY_GAME_SIZE = 5;
// Puzzle #1. Any dateKey before this epoch is treated as invalid by
// resolvePuzzleDate (there is no puzzle before the game existed).
export const DAILY_GAME_EPOCH = "2026-09-28";
export const DAILY_REPLAY_DAYS = 7;
// Mirrors migration 072's framing_next_headline threshold.
export const DAILY_POLITICS_MIN_PROB = 0.7;
export const DAILY_MAX_PER_ZONE = 2;
export const DAILY_TITLE_MIN = 25;
export const DAILY_TITLE_MAX = 180;
// Türkiye has observed a single, fixed UTC+03:00 offset (no DST) since
// 2016 — verified against Intl below, in daily-set.test.ts.
export const ISTANBUL_OFFSET_MS = 3 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ZONE_ORDER: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

// ===========================================================================
// Types
// ===========================================================================

export interface DailyCandidateSource {
  id: string;
  name: string;
  slug: string;
  bias: BiasCategory;
  kind: SourceKind | null | undefined;
  active: boolean;
}

export interface DailyCandidate {
  articleId: string;
  title: string;
  url: string;
  publishedAt: string;
  createdAt: string;
  clusterId: string | null;
  source: DailyCandidateSource;
}

export interface DailyHeadline {
  articleId: string;
  sourceId: string;
  title: string;
  url: string;
  sourceName: string;
  sourceSlug: string;
  zone: MediaDnaZone;
  clusterId: string | null;
}

export interface DailyPuzzle {
  dateKey: string;
  number: number;
  windowLabel: string;
  headlines: DailyHeadline[];
}

export interface PuzzleWindow {
  startIso: string;
  endIso: string;
}

// ===========================================================================
// Date-key helpers (all pure — no implicit "now")
// ===========================================================================

/** True for a syntactically and calendrically valid `YYYY-MM-DD` string. */
export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_RE.test(value)) return false;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(ms)) return false;
  // Rejects e.g. "2026-02-30" (Date.parse rolls it into March), by
  // re-deriving the key from the parsed timestamp and comparing.
  return new Date(ms).toISOString().slice(0, 10) === value;
}

/** The Istanbul (UTC+3) calendar date of the instant `ms`, as `YYYY-MM-DD`. */
export function istanbulDateKey(ms: number): string {
  return new Date(ms + ISTANBUL_OFFSET_MS).toISOString().slice(0, 10);
}

/** `key` shifted by `n` days (may be negative), staying a valid date key. */
export function addDays(key: string, n: number): string {
  const ms = Date.parse(`${key}T00:00:00.000Z`) + n * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetweenKeys(a: string, b: string): number {
  const aMs = Date.parse(`${a}T00:00:00.000Z`);
  const bMs = Date.parse(`${b}T00:00:00.000Z`);
  return Math.round((bMs - aMs) / DAY_MS);
}

/**
 * The puzzle window for Istanbul date `key`: the CLOSED Istanbul day D-1,
 * expressed as `[startIso, endIso)` UTC instants. `puzzleWindow('2026-09-28')`
 * = `['2026-09-26T21:00:00.000Z', '2026-09-27T21:00:00.000Z')` — Istanbul
 * midnight of 2026-09-27 (start) through Istanbul midnight of 2026-09-28
 * (end, exclusive).
 */
export function puzzleWindow(key: string): PuzzleWindow {
  const keyMidnightUtcMs = Date.parse(`${key}T00:00:00.000Z`);
  // Istanbul midnight of `key` occurs 3h before that same UTC calendar
  // instant, because Istanbul clocks read 3h AHEAD of UTC.
  const endMs = keyMidnightUtcMs - ISTANBUL_OFFSET_MS;
  const startMs = endMs - DAY_MS;
  return {
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
  };
}

/** Puzzle number for `key`: `DAILY_GAME_EPOCH` is puzzle #1. */
export function puzzleNumber(key: string): number {
  return daysBetweenKeys(DAILY_GAME_EPOCH, key) + 1;
}

/**
 * Resolves the `?gun=` query param into a playable date key.
 *
 * Falls back to `todayKey` for: a missing/array-with-no-string value, a
 * syntactically invalid date, a future date, a date before
 * `DAILY_GAME_EPOCH`, or a date more than `DAILY_REPLAY_DAYS` (7) days in
 * the past (i.e. only today and the 6 days before it replay; day 7 back
 * and beyond fall back to today).
 */
export function resolvePuzzleDate(
  raw: string | string[] | undefined,
  todayKey: string,
): string {
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (!isDateKey(candidate)) return todayKey;
  if (candidate > todayKey) return todayKey;
  if (candidate < DAILY_GAME_EPOCH) return todayKey;
  const ageDays = daysBetweenKeys(candidate, todayKey);
  if (ageDays >= DAILY_REPLAY_DAYS) return todayKey;
  return candidate;
}

/**
 * Turkish label for the puzzle's window day (D-1), e.g. "27 Eylül 2026",
 * formatted with `Intl` pinned to `Europe/Istanbul` (see formatTurkishDate
 * in src/lib/time.ts for the same pinning rationale — server/client must
 * agree regardless of the render environment's local zone). Formats off
 * midday UTC of the window day so the +03 shift never crosses a calendar
 * boundary in either direction.
 */
export function windowLabelTr(key: string): string {
  const windowDayKey = addDays(key, -1);
  const middayMs = Date.parse(`${windowDayKey}T12:00:00.000Z`);
  return new Intl.DateTimeFormat("tr-TR", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "Europe/Istanbul",
  }).format(middayMs);
}

// ===========================================================================
// Determinism: FNV-1a 32-bit hash
// ===========================================================================

/** FNV-1a 32-bit hash of `${key}|${articleId}`, as an unsigned integer. */
export function dailyHash(key: string, articleId: string): number {
  const input = `${key}|${articleId}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ===========================================================================
// Outlet-leak / eligibility
// ===========================================================================

// Same six-letter Turkish diacritic fold pii-filter.ts uses, duplicated
// here rather than imported: pii-filter.ts exports no fold helper (only
// isGameEligibleTitle, imported read-only below) and this module owns no
// edits to that file.
const DIACRITIC_FOLD_MAP: Record<string, string> = {
  ç: "c",
  ğ: "g",
  ı: "i",
  ö: "o",
  ş: "s",
  ü: "u",
};

function foldTr(input: string): string {
  return input
    .toLocaleLowerCase("tr-TR")
    .replace(/[çğıöşü]/g, (ch) => DIACRITIC_FOLD_MAP[ch] ?? ch);
}

/**
 * True when `title` leaks the source's identity: the folded title contains
 * the folded source name, or any slug token of 4+ characters. Comparison
 * is tr-folded (Turkish-locale-lowercased, then diacritic-stripped) on
 * both sides so e.g. "SÖZCÜ'nün..." matches the "sozcu" slug.
 */
export function titleLeaksOutlet(
  title: string,
  source: Pick<DailyCandidateSource, "name" | "slug">,
): boolean {
  const foldedTitle = foldTr(title);

  const foldedName = foldTr(source.name);
  if (foldedName.length > 0 && foldedTitle.includes(foldedName)) return true;

  const tokens = source.slug.split(/[^a-zA-Z0-9]+/).filter((t) => t.length >= 4);
  for (const token of tokens) {
    if (foldedTitle.includes(foldTr(token))) return true;
  }
  return false;
}

function isWithinWindow(candidate: DailyCandidate, window: PuzzleWindow): boolean {
  const publishedMs = Date.parse(candidate.publishedAt);
  const createdMs = Date.parse(candidate.createdAt);
  if (Number.isNaN(publishedMs) || Number.isNaN(createdMs)) return false;
  // least(published_at, created_at) — covers CNN Türk's future pubDates.
  const earliestMs = Math.min(publishedMs, createdMs);
  const startMs = Date.parse(window.startIso);
  const endMs = Date.parse(window.endIso);
  return earliestMs >= startMs && earliestMs < endMs;
}

/**
 * PURE eligibility gate for one candidate, given the puzzle's window.
 * Combines the Çerçeve /oyun rules (source active, not wire, title passes
 * `isGameEligibleTitle`) with game-specific stricter guards: source kind
 * must normalize to exactly "outlet" (excludes aggregator/niche too, not
 * just wire — a republisher's zone isn't a guessable fact), the window
 * check, the title-length band, and the outlet-leak filter.
 *
 * Does NOT check the article_title_versions ("edited headline") exclusion
 * or the jev_prob threshold — both are applied earlier, at the query
 * layer (daily-query.ts), before a row ever becomes a `DailyCandidate`.
 */
export function isDailyEligible(candidate: DailyCandidate, window: PuzzleWindow): boolean {
  const { source } = candidate;
  if (!source.active) return false;
  if (sourceKindOf({ kind: source.kind ?? undefined }) !== "outlet") return false;
  if (!isGameEligibleTitle(candidate.title)) return false;
  const len = candidate.title.length;
  if (len < DAILY_TITLE_MIN || len > DAILY_TITLE_MAX) return false;
  if (titleLeaksOutlet(candidate.title, source)) return false;
  if (!isWithinWindow(candidate, window)) return false;
  return true;
}

// ===========================================================================
// pickDailySet
// ===========================================================================

function zoneOfCandidate(candidate: DailyCandidate): MediaDnaZone {
  return zoneOf(candidate.source.bias);
}

/**
 * PURE, deterministic 5-headline picker.
 *
 * 1. Filters `candidates` to the eligible subset (`isDailyEligible`) for
 *    `key`'s window.
 * 2. Sorts that subset ascending by `dailyHash(key, articleId)` (ties
 *    broken by articleId so the sort is a strict total order).
 * 3. Phase 1: for each zone in the fixed order iktidar, bagimsiz,
 *    muhalefet, takes the first eligible-and-still-pickable candidate of
 *    that zone in hash order. Returns `null` if any zone has none.
 * 4. Phase 2: continuing in the SAME hash order, fills the remaining
 *    `DAILY_GAME_SIZE - 3` slots with the next pickable candidates,
 *    respecting `DAILY_MAX_PER_ZONE`, one-per-source and one-per-cluster.
 * 5. Returns `null` if fewer than `DAILY_GAME_SIZE` could be picked.
 * 6. Sorts the final 5 by `dailyHash(`${key}|order`, articleId)` for
 *    display — a different hash than the selection order, so the reveal
 *    order never trivially starts with iktidar.
 *
 * Both phases are single linear scans over the SAME sorted array with
 * state (used sources/clusters/zone counts) built only from candidates
 * already visited — so the result is "prefix-consistent": once the scan
 * has produced 5 picks, appending more candidates after that point in
 * hash order can never change the answer. This lets the caller
 * (daily-query.ts) fetch candidate details in chunks and stop as soon as
 * `pickDailySet` returns non-null.
 */
export function pickDailySet(
  key: string,
  candidates: readonly DailyCandidate[],
): DailyHeadline[] | null {
  const window = puzzleWindow(key);
  const eligible = candidates.filter((c) => isDailyEligible(c, window));

  const sorted = [...eligible].sort((a, b) => {
    const ha = dailyHash(key, a.articleId);
    const hb = dailyHash(key, b.articleId);
    if (ha !== hb) return ha - hb;
    return a.articleId < b.articleId ? -1 : a.articleId > b.articleId ? 1 : 0;
  });

  const picked: DailyCandidate[] = [];
  const usedSources = new Set<string>();
  const usedClusters = new Set<string>();
  const zoneCounts: Record<MediaDnaZone, number> = { iktidar: 0, bagimsiz: 0, muhalefet: 0 };

  const canPick = (c: DailyCandidate): boolean => {
    if (usedSources.has(c.source.id)) return false;
    if (c.clusterId && usedClusters.has(c.clusterId)) return false;
    return zoneCounts[zoneOfCandidate(c)] < DAILY_MAX_PER_ZONE;
  };
  const commit = (c: DailyCandidate): void => {
    usedSources.add(c.source.id);
    if (c.clusterId) usedClusters.add(c.clusterId);
    zoneCounts[zoneOfCandidate(c)] += 1;
    picked.push(c);
  };

  for (const zone of ZONE_ORDER) {
    const found = sorted.find((c) => zoneOfCandidate(c) === zone && canPick(c));
    if (!found) return null;
    commit(found);
  }

  for (const c of sorted) {
    if (picked.length >= DAILY_GAME_SIZE) break;
    if (picked.includes(c)) continue;
    if (canPick(c)) commit(c);
  }

  if (picked.length < DAILY_GAME_SIZE) return null;

  const displayOrder = [...picked].sort(
    (a, b) => dailyHash(`${key}|order`, a.articleId) - dailyHash(`${key}|order`, b.articleId),
  );

  return displayOrder.map((c) => ({
    articleId: c.articleId,
    sourceId: c.source.id,
    title: c.title,
    url: c.url,
    sourceName: c.source.name,
    sourceSlug: c.source.slug,
    zone: zoneOfCandidate(c),
    clusterId: c.clusterId,
  }));
}
