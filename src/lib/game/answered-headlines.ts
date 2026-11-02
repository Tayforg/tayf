/**
 * src/lib/game/answered-headlines.ts — which /oyun headlines this browser tab
 * has already answered, so a headline is only ever played "blind" once.
 *
 * Why it exists: both Bölge and Günün Tayf'ı reveal the outlet and Tayf's zone
 * right after a guess. A second pass over the same headline is therefore an
 * informed guess, and POSTing it to /api/oyun would feed memorised answers
 * into the published reader-agreement numbers. So a guess is POSTed only the
 * first time `markAnswered` says so, and Bölge's "Yeniden Oyna" draws its next
 * round from headlines that are not in this set.
 *
 * Storage: a module-level Set (lives for the page lifetime) plus
 * `sessionStorage` (survives a reload or "Yeni manşetlerle oyna" in the same
 * tab, gone when the tab closes). It holds opaque article ids only: nothing
 * identifying, never sent anywhere, no cookie. Every storage access is wrapped
 * in try/catch because blocked storage throws; memory alone still dedupes for
 * the page lifetime then.
 *
 * Plain TypeScript, no React: callers read it from event handlers, never
 * during render or in an effect body.
 */

export const ANSWERED_STORAGE_KEY = "tayf-oyun-answered-v1";
/** Most ids kept (the newest win): a tab session is nowhere near this many. */
export const ANSWERED_CAP = 500;

// Answered in this page lifetime. Also bounded by ANSWERED_CAP.
const memory = new Set<string>();

/**
 * Tolerant parse of the stored value: bad JSON, a non-array and non-string or
 * empty items all degrade to "nothing remembered" instead of throwing. Keeps
 * the last ANSWERED_CAP ids.
 */
export function parseAnsweredIds(raw: string | null): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const item of parsed) {
    if (typeof item === "string" && item.length > 0) ids.push(item);
  }
  return ids.length > ANSWERED_CAP ? ids.slice(ids.length - ANSWERED_CAP) : ids;
}

function readStoredIds(): string[] {
  try {
    return parseAnsweredIds(window.sessionStorage.getItem(ANSWERED_STORAGE_KEY));
  } catch {
    // No window (server render), or private/blocked storage.
    return [];
  }
}

function writeStoredIds(ids: readonly string[]): void {
  try {
    window.sessionStorage.setItem(ANSWERED_STORAGE_KEY, JSON.stringify(ids));
  } catch {
    // Blocked or full storage: the in-memory Set still dedupes this page.
  }
}

/** Every id answered in this tab session: memory ∪ sessionStorage. A copy. */
export function readAnsweredIds(): Set<string> {
  return new Set<string>([...readStoredIds(), ...memory]);
}

/**
 * Records `articleId` as answered. Returns true only the FIRST time the id is
 * answered in this tab session (the caller then POSTs the guess), false when
 * it was already answered, in this page load or an earlier one.
 *
 * The id goes into memory before sessionStorage, so storage that throws still
 * dedupes for the rest of the page lifetime.
 */
export function markAnswered(articleId: string): boolean {
  if (memory.has(articleId)) return false;
  const stored = readStoredIds();
  const alreadyStored = stored.includes(articleId);

  memory.add(articleId);
  if (memory.size > ANSWERED_CAP) {
    const oldest = memory.values().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }

  if (alreadyStored) return false;
  const next = [...stored, articleId];
  writeStoredIds(next.length > ANSWERED_CAP ? next.slice(next.length - ANSWERED_CAP) : next);
  return true;
}

/**
 * PURE. The next round: the pool's headlines in pool order, minus the ones
 * already answered, capped at `size`. Empty when nothing unanswered is left.
 */
export function nextRound<T extends { articleId: string }>(
  pool: readonly T[],
  answered: ReadonlySet<string>,
  size: number,
): T[] {
  const round: T[] = [];
  if (size <= 0) return round;
  for (const headline of pool) {
    if (answered.has(headline.articleId)) continue;
    round.push(headline);
    if (round.length >= size) break;
  }
  return round;
}
