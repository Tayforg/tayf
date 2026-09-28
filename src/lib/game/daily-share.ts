/**
 * src/lib/game/daily-share.ts — pure helpers for "Günün Tayf'ı"'s streak
 * persistence and share text. Never touches `window`/`localStorage`
 * directly (that's daily-game.tsx's job, try/catch-wrapped) — every
 * function here is a plain (store) -> store / string transform so it's
 * fully unit-testable with plain objects.
 */

import { addDays } from "./daily-set";

export const STREAK_STORAGE_KEY = "tayf-gunun-tayfi-v1";

const MAX_STORED_RESULTS = 14;

export interface DailyResultEntry {
  score: number;
  marks: boolean[];
}

export interface DailyStore {
  v: 1;
  lastPlayed: string | null;
  streak: number;
  best: number;
  results: Record<string, DailyResultEntry>;
}

function emptyStore(): DailyStore {
  return { v: 1, lastPlayed: null, streak: 0, best: 0, results: {} };
}

function isDailyResultEntry(value: unknown): value is DailyResultEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.score === "number" &&
    Number.isFinite(v.score) &&
    Array.isArray(v.marks) &&
    v.marks.every((m) => typeof m === "boolean")
  );
}

/**
 * Parses a raw `localStorage` string into a `DailyStore`. Any parse
 * failure, shape mismatch, or unexpected `v` gives back a fresh empty
 * store — corrupt input never throws and never partially trusts garbage
 * fields.
 */
export function parseDailyStore(raw: string | null | undefined): DailyStore {
  if (!raw) return emptyStore();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }

  if (typeof parsed !== "object" || parsed === null) return emptyStore();
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return emptyStore();

  const lastPlayed = typeof p.lastPlayed === "string" ? p.lastPlayed : null;
  const streak = typeof p.streak === "number" && Number.isFinite(p.streak) ? p.streak : 0;
  const best = typeof p.best === "number" && Number.isFinite(p.best) ? p.best : 0;

  const results: Record<string, DailyResultEntry> = {};
  if (typeof p.results === "object" && p.results !== null) {
    for (const [key, value] of Object.entries(p.results as Record<string, unknown>)) {
      if (isDailyResultEntry(value)) results[key] = value;
    }
  }

  return { v: 1, lastPlayed, streak: Math.max(0, streak), best: Math.max(0, best), results };
}

export interface ApplyDailyResultInput {
  dateKey: string;
  todayKey: string;
  score: number;
  marks: boolean[];
}

/**
 * Records one finished puzzle into `store`, returning a NEW store (never
 * mutates the input).
 *
 * Streak rules (only touched when `dateKey === todayKey` — replaying a
 * past puzzle via `?gun=` never moves the streak):
 *   - `lastPlayed === addDays(todayKey, -1)` (played yesterday): streak + 1.
 *   - `lastPlayed === todayKey` (already played today — a same-day replay,
 *     e.g. two tabs racing): streak unchanged.
 *   - anything else (a gap, or a first-ever play): streak resets to 1.
 *
 * `best` is `max(best, streak-after-this-result)`. `results` caps at the
 * 14 most-recently-added keys (insertion order — the fixture the test
 * suite builds inserts in date order, so this also reads as "newest 14").
 */
export function applyDailyResult(store: DailyStore, input: ApplyDailyResultInput): DailyStore {
  const { dateKey, todayKey, score, marks } = input;

  let { lastPlayed, streak } = store;

  if (dateKey === todayKey) {
    if (lastPlayed === addDays(todayKey, -1)) {
      streak = store.streak + 1;
    } else if (lastPlayed === todayKey) {
      streak = store.streak;
    } else {
      streak = 1;
    }
    lastPlayed = todayKey;
  }

  const best = Math.max(store.best, streak);

  const nextResults: Record<string, DailyResultEntry> = { ...store.results };
  delete nextResults[dateKey]; // re-insert at the end for "newest" ordering
  nextResults[dateKey] = { score, marks: [...marks] };

  const keys = Object.keys(nextResults);
  if (keys.length > MAX_STORED_RESULTS) {
    const toDrop = keys.slice(0, keys.length - MAX_STORED_RESULTS);
    for (const key of toDrop) delete nextResults[key];
  }

  return { v: 1, lastPlayed, streak, best, results: nextResults };
}

export interface BuildShareTextInput {
  number: number;
  dateKey: string;
  score: number;
  marks: boolean[];
  origin: string;
}

/**
 * Exactly three lines, no spoilers: no zone colours/labels, since every
 * visitor plays the same 5 headlines in the same order — a zone-coloured
 * row would give away the answers to anyone who hasn't played yet.
 */
export function buildShareText({ number, dateKey, score, marks, origin }: BuildShareTextInput): string {
  const marksRow = marks.map((m) => (m ? "✅" : "❌")).join("");
  const line1 = `Günün Tayf'ı #${number} · ${score}/5`;
  const line3 = `${origin}/oyun?mod=gunluk&gun=${dateKey}`;
  return `${line1}\n${marksRow}\n${line3}`;
}
