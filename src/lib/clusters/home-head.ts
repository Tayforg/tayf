// Pure helpers behind the home page's "N yeni son dakika haberi · Yenile" pill
// (h170-roadmap-2): the Son Dakika strip's realtime-lite, without Supabase
// Realtime. A tiny client component (src/components/home/new-breaking-pill.tsx)
// polls a CDN-cached head endpoint (/api/home/head) and, when the strip holds a
// story the rendered page does not list, offers a one-click router.refresh().
//
// The poll schedule, the refresh verdict and the page fingerprint are the ones of
// /timeline's pill, imported from ./timeline-head unchanged (startHeadPolling,
// refreshOutcome, pageSignature); this file only adds what is specific to the
// strip: the wire shape, what counts as new and the label.
//
// No React and no Next in here on purpose, and nothing from politics-query (that
// module reads the database; this one ships to the browser).

import {
  parseTimelineHead,
  readHeadResponse,
  type HeadFetchResult,
  type HeadResponseLike,
} from "./timeline-head";

/** Rows the head holds: the strip's own cap (BREAKING_LIMIT in politics-query.ts). */
export const HOME_HEAD_LIMIT = 6;

/**
 * The one URL the pill requests, with no query string: the CDN keys the response
 * on it, so a `?cb=` must never be sendable from here.
 */
export const HOME_HEAD_URL = "/api/home/head";

/** The only two fields the public head endpoint exposes (the timeline head's row shape). */
export type HomeHeadRow = { id: string; first_published: string };

const MAX_ID_LENGTH = 64;

/**
 * The strip for the wire: at most 6 rows, reduced to id and first_published.
 * Titles and counts must not leak through the public, CDN-cached probe.
 */
export function toHomeHead<T extends HomeHeadRow>(rows: ReadonlyArray<T>): HomeHeadRow[] {
  return rows.slice(0, HOME_HEAD_LIMIT).map((r) => ({ id: r.id, first_published: r.first_published }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates a head response body: `{ breaking: [...] }`, at most 6 rows, each with a
 * non-empty id (<= 64 chars) and a parseable first_published. ONE bad row or a bad
 * shape rejects the lot (null): a half-trusted head could light the pill for a
 * story the page cannot show. The /timeline shape (`{ clusters }`) is rejected too.
 * Unknown keys on a row are dropped. The row rules are parseTimelineHead's.
 */
export function parseHomeHead(json: unknown): HomeHeadRow[] | null {
  if (!isRecord(json)) return null;
  const breaking = json.breaking;
  if (!Array.isArray(breaking) || breaking.length > HOME_HEAD_LIMIT) return null;
  return parseTimelineHead({ clusters: breaking });
}

/**
 * How many head stories the rendered page does not know: unique ids outside
 * `knownIds`. No time floor is needed: the head is the strip, so an id the page
 * has never listed is a story that entered the strip after the render, and an id
 * the page DID list (the page hands over every story it lists, strip and ranked
 * rows, with no age filter: the strip's 2 h window is applied when the cached entry
 * is filled, so the head can carry a story that is already older by the render
 * clock) is one that only moved between the ranked list and the strip, or is still
 * in the entry, which is never news to the reader.
 *
 * An empty or malformed head (not an array, longer than the strip's 6 slots, any
 * row that is not an object with a non-empty string id) counts 0: better no pill
 * than a false one. Pure; does not mutate its inputs.
 */
export function countNewBreaking(
  rows: unknown,
  knownIds: ReadonlySet<string> | ReadonlyArray<string>,
): number {
  if (!Array.isArray(rows) || rows.length > HOME_HEAD_LIMIT) return 0;
  const known: ReadonlySet<string> = Array.isArray(knownIds) ? new Set<string>(knownIds) : (knownIds as ReadonlySet<string>);
  const fresh = new Set<string>();
  for (const row of rows as unknown[]) {
    if (!isRecord(row)) return 0;
    const id = row.id;
    if (typeof id !== "string" || id.length === 0 || id.length > MAX_ID_LENGTH) return 0;
    if (!known.has(id)) fresh.add(id);
  }
  return fresh.size;
}

/** "1 yeni son dakika haberi", "3 yeni son dakika haberi". Never prints NaN or a negative number. */
export function newBreakingLabel(n: number): string {
  const count = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  return `${count} yeni son dakika haberi`;
}

/**
 * A fetch response as a poll result, the home head's twin of readHeadResponse: a
 * 2xx whose body parses (parseHomeHead) is `{ ok: true }`; anything else (non-2xx,
 * bad JSON, bad shape) is `{ ok: false }`, carrying the server's Retry-After
 * (whole seconds -> ms) when it sent a usable one. The Retry-After handling is
 * readHeadResponse's own, so a 503 or a 429 backs the poller off exactly as the
 * /timeline pill's.
 */
export async function readHomeHeadResponse(res: HeadResponseLike): Promise<HeadFetchResult> {
  return readHeadResponse({
    ok: res.ok,
    headers: res.headers,
    json: async () => {
      const rows = parseHomeHead(await res.json());
      return rows === null ? null : { clusters: rows };
    },
  });
}

/**
 * One poll of the head: GET /api/home/head (never a query string) with the
 * poller's abort signal, read into a HeadFetchResult. `fetchImpl` is injectable
 * so the request can be tested without a network; the pill passes nothing.
 */
export function fetchHomeHead(
  signal: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<HeadFetchResult> {
  return fetchImpl(HOME_HEAD_URL, {
    signal,
    headers: { accept: "application/json" },
  }).then(readHomeHeadResponse);
}
