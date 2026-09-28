import type { FactCheckPublisher, FactCheckPublisherKey } from "./feeds";

/**
 * SSRF / copyright-scope guard for one parsed feed item's link.
 *
 * `new URL()` must parse, the protocol must be exactly `https:` (blocks
 * `javascript:`, `http:`, `data:`, etc.), the host must belong to the
 * publisher's allow-list, and -- for AA -- the path must contain
 * `/teyithatti/` so a general AA article never rides in on the teyit-hatti
 * publisher key.
 */
export function isAllowedFactCheckUrl(
  url: string,
  p: FactCheckPublisher,
): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (!p.hosts.includes(u.host)) return false;
  if (p.pathIncludes && !u.pathname.includes(p.pathIncludes)) return false;
  return true;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  quot: '"',
  apos: "'",
  lt: "<",
  gt: ">",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#\d+|#x[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      const cp = parseInt(code.slice(2), 16);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    if (code.startsWith("#")) {
      const cp = parseInt(code.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    const named = NAMED_ENTITIES[code];
    return named ?? m;
  });
}

const MAX_TITLE_LENGTH = 300;

/**
 * Clean an RSS/Atom title into display-safe plain text: decode entities,
 * strip any tags, collapse whitespace, and cap at 300 chars on a word
 * boundary with a trailing ellipsis. Returns null for an empty result.
 */
export function cleanTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  let t = decodeEntities(raw);
  t = t.replace(/<[^>]*>/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  if (t.length === 0) return null;
  if (t.length > MAX_TITLE_LENGTH) {
    const slice = t.slice(0, MAX_TITLE_LENGTH);
    const lastSpace = slice.lastIndexOf(" ");
    t = (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim() + "…";
  }
  return t.length > 0 ? t : null;
}

export interface NormalizedFactCheck {
  publisher: FactCheckPublisherKey;
  url: string;
  title: string;
  published_at: string;
}

const MAX_ROWS_PER_FEED = 50;

function parseDate(raw: unknown, nowMs: number): string {
  if (typeof raw === "string") {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) {
      // Clamp a future date to now -- a feed cannot publish from the
      // future, and a clock-skewed upstream must not let items sort ahead
      // of everything else / dodge the cron's recency window forever.
      return new Date(Math.min(t, nowMs)).toISOString();
    }
  }
  return new Date(nowMs).toISOString();
}

/**
 * Normalize a batch of `rss-parser` feed items into the row shape
 * migration 080's `fact_checks` table accepts, plus the in-memory-only
 * `categories` used for keyword matching (never stored).
 *
 * Caps at 50 rows and dedupes by URL (first occurrence wins, matching
 * feed order which is newest-first for every verified publisher).
 */
export function normalizeFeedItems(
  p: FactCheckPublisher,
  items: unknown[],
  nowMs: number,
): Array<{ row: NormalizedFactCheck; categories: string[] }> {
  const out: Array<{ row: NormalizedFactCheck; categories: string[] }> = [];
  const seenUrls = new Set<string>();

  for (const raw of items) {
    if (out.length >= MAX_ROWS_PER_FEED) break;
    if (raw === null || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;

    const link = item.link ?? item.guid;
    if (typeof link !== "string") continue;
    if (!isAllowedFactCheckUrl(link, p)) continue;
    if (seenUrls.has(link)) continue;

    const title = cleanTitle(item.title);
    if (!title) continue;

    const dateRaw = item.isoDate ?? item.pubDate;
    const published_at = parseDate(dateRaw, nowMs);

    const categoriesRaw = item.categories;
    const categories: string[] = Array.isArray(categoriesRaw)
      ? categoriesRaw.filter((c): c is string => typeof c === "string")
      : [];

    seenUrls.add(link);
    out.push({
      row: { publisher: p.key, url: link, title, published_at },
      categories,
    });
  }

  return out;
}
