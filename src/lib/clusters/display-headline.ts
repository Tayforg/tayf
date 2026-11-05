import { cleanHeadline, pickNeutralTitle } from "./neutral-title";

// The headline a reader sees for a cluster whose neutral title is not stored yet
// (h42-latency-1).
//
// The first `title_tr_neutral` of a cluster is written by /api/cron/headline, on
// '*/5 * * * *'. Until that tick every list surface and the detail page fell back
// to `clusters.title_tr`, the seed article's raw outlet headline ("... İşte
// detaylar!"), and a new cluster lands in the top slots of the home page.
//
// The cron's first pick is a pure function of the member titles (extractive mode:
// `pickNeutralTitle(items, { floor: true })`), and the readers already hold those
// titles. So a reader computes the same pick itself, inside the `use cache` body
// that builds the bundle, and nothing is written. The cron's later write is the
// same string, so the heading does not change when it lands.
//
// Pure: no I/O, no clock, no database. Never throws.

/**
 * Members a cluster needs before the headline cron titles it
 * (EXTRACTIVE_MIN_ARTICLE_COUNT in src/app/api/cron/headline/route.ts). A cluster
 * with fewer is never written, so showing a computed title for it would be a
 * change of behaviour with nothing to agree with later: it keeps `title_tr`.
 */
export const FIRST_PICK_MIN_MEMBERS = 2;

export interface HeadlineRow {
  title_tr: string;
  title_tr_neutral: string | null;
}

/** What a reader knows about one member article. */
export interface HeadlineMember {
  title?: string | null;
  published_at?: string | null;
}

function storedNeutral(row: HeadlineRow): string | null {
  const neutral: unknown = row.title_tr_neutral;
  return typeof neutral === "string" && neutral.trim().length > 0 ? neutral : null;
}

function epochMs(value: string | null | undefined): number {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * The member titles in the order the headline cron feeds the picker
 * (`fetchMemberItems` in src/app/api/cron/headline/route.ts): articles without a
 * title dropped, newest `published_at` first, a missing date last, equal
 * timestamps ordered by title so the picker's stable tie-break is deterministic.
 * Does not reorder or mutate its input.
 */
export function memberTitlesNewestFirst(members: readonly HeadlineMember[]): string[] {
  if (!Array.isArray(members)) return [];
  const items: Array<{ title: string; ms: number }> = [];
  for (const m of members) {
    const title: unknown = m?.title;
    if (typeof title !== "string" || title.length === 0) continue;
    items.push({ title, ms: epochMs(m.published_at) });
  }
  items.sort((a, b) => {
    if (b.ms !== a.ms) return b.ms - a.ms;
    return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
  });
  return items.map((i) => i.title);
}

/**
 * The cluster's heading.
 *
 * 1. A stored neutral title (non-empty after trim) is returned as it is.
 * 2. Otherwise the cron's own first pick over the member titles (newest first):
 *    `pickNeutralTitle(members, { floor: true })`.
 * 3. A pick that finds nothing (or throws) falls back to `cleanHeadline(title_tr)`,
 *    and that to `title_tr` when cleaning leaves nothing.
 */
export function displayHeadline(
  row: HeadlineRow,
  memberTitlesNewestFirst: readonly string[],
): string {
  const stored = storedNeutral(row);
  if (stored !== null) return stored;

  const original: string = typeof row.title_tr === "string" ? row.title_tr : "";

  try {
    // Only strings reach the picker: one junk entry must not cost the whole pick.
    const titles = Array.isArray(memberTitlesNewestFirst)
      ? memberTitlesNewestFirst.filter((t): t is string => typeof t === "string")
      : [];
    const picked = pickNeutralTitle(
      titles.map((title) => ({ title })),
      { floor: true },
    );
    if (picked !== null && picked.trim().length > 0) return picked;
  } catch (err) {
    // The cron logs and moves on; a render path must not take the whole cached
    // feed down for one cluster.
    console.warn("[display-headline] pick failed", err);
  }

  try {
    const cleaned = cleanHeadline(original);
    if (cleaned.length > 0) return cleaned;
  } catch {
    // fall through to the raw title
  }
  return original;
}

export interface ClusterDisplayTitle {
  title: string;
  /** True when `title` was computed from the member titles, not stored or inherited. */
  picked: boolean;
}

/**
 * `displayHeadline` for a reader that holds the member articles in any order. It
 * orders them as the cron does, and leaves a cluster the cron would not title
 * (fewer than FIRST_PICK_MIN_MEMBERS members with a title) on the coalesce it
 * always had: the stored neutral title when there is one, else `title_tr`.
 */
export function clusterDisplayTitle(
  row: HeadlineRow,
  members: readonly HeadlineMember[],
): ClusterDisplayTitle {
  const stored = storedNeutral(row);
  if (stored !== null) return { title: stored, picked: false };

  const titles = memberTitlesNewestFirst(members);
  if (titles.length < FIRST_PICK_MIN_MEMBERS) return { title: row.title_tr, picked: false };
  return { title: displayHeadline(row, titles), picked: true };
}
