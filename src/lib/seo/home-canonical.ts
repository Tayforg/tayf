// Pure helpers shared by the home page render and its generateMetadata so
// the canonical URL can never drift from the page actually rendered.

export const HOME_PAGE_SIZE = 15;

/** `?page=` → positive integer; anything unparseable or < 1 means page 1. */
export function parseHomePage(raw: string | string[] | undefined): number {
  const first = Array.isArray(raw) ? raw[0] : raw;
  return Math.max(1, parseInt(first ?? "1", 10) || 1);
}

export function homeTotalPages(rankedCount: number): number {
  if (!Number.isFinite(rankedCount) || rankedCount < 0) return 1;
  return Math.max(1, Math.ceil(rankedCount / HOME_PAGE_SIZE));
}

interface IdBundle {
  cluster: { id: string };
}

/** Mirrors HomeFeed's `ranked` when there is no search query. */
export function rankedCountOf(feed: {
  bundles: IdBundle[];
  breakingBundles: IdBundle[];
}): number {
  const breaking = new Set(feed.breakingBundles.map((b) => b.cluster.id));
  return feed.bundles.filter((b) => !breaking.has(b.cluster.id)).length;
}

/** null means "inherit the layout's canonical `/`". */
export function homeCanonicalPath(o: {
  q?: string | string[];
  page: number;
  rankedCount: number | null;
}): string | null {
  const q = Array.isArray(o.q) ? o.q[0] : o.q;
  if (q?.trim()) return null;
  if (o.page <= 1 || o.rankedCount === null) return null;
  const clamped = Math.min(o.page, homeTotalPages(o.rankedCount));
  if (clamped <= 1) return null;
  return `/?page=${clamped}`;
}
