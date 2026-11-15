import Link from "next/link";

import { SEARCH_SORT_NEW, searchHref, type SearchSort } from "@/lib/search/search-sort";

// "Sırala: En alakalı · En yeni" (h191): the order of the archive search results, as two plain links above them. A hookless
// server component with no handler, so it ships no client JS: each link is an address (searchHref), and the page that
// answers it reads ?sirala= (only the exact value "yeni" is the newest-first order, migration 215's
// search_cluster_ids_new; everything else is the ranked order the page always had).
//
// `active` is the order the results are SHOWN in ("yeni", or null/absent for the ranked order), not the order the
// address asked for: a newest-first request that was answered in the ranked order (215 not applied yet) marks
// "En alakalı". The links keep the query and drop everything else: `arsiv` is reset (a new order starts at its first
// page), and so is `page`; the query is encoded by URLSearchParams and rendered as a React child, so it cannot add a
// parameter or markup. Nothing renders without a query.
//
// prefetch={false}: each target is a database search, and the two links must not fire two RPCs when the nav scrolls into
// view (the reason SearchIntentRow, the chips of an empty search and the archive pager opt out too).
//
// The chip class is the one of SearchIntentRow and RelaxedSearchLinks (24 px tall, 44 px on a phone, the site's focus
// ring); the current order is a filled pill in the nav's own active colours (border-foreground, bg-foreground/10). It is also
// a 2 px outline against the idle chip's 1 px: forced-colors mode drops the tint and the colour but keeps a border width, so the
// current order is still told apart there (WCAG 1.4.1, 1.4.11), as the current link of nav-links.tsx is (h41-a11y-1).
// The nav wraps and shrinks (flex-wrap, min-w-0, max-w-full), so the label and two chips fit a 280 px viewport on two
// lines. Both class strings are literals (Tailwind 4).
const CHIP_CLASS =
  "inline-flex items-center min-h-6 max-sm:min-h-11 rounded-full border border-border/60 bg-muted/50 px-3 text-xs font-medium text-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const CURRENT_CHIP_CLASS =
  "inline-flex items-center min-h-6 max-sm:min-h-11 rounded-full border-2 border-foreground bg-foreground/10 px-3 text-xs font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function SearchSortToggle({
  q,
  active,
}: {
  /** The query as typed (trimmed): the address of both links. */
  q?: string;
  /** The order the results are shown in; null or absent is the ranked order. */
  active?: SearchSort | null;
}) {
  if (q === undefined || q.trim() === "") return null;
  const newestActive = active === SEARCH_SORT_NEW;

  return (
    <nav
      aria-label="Sıralama"
      className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground"
    >
      <span>Sırala:</span>
      <Link
        href={searchHref(q)}
        prefetch={false}
        aria-current={newestActive ? undefined : "page"}
        className={newestActive ? CHIP_CLASS : CURRENT_CHIP_CLASS}
      >
        En alakalı
      </Link>
      <Link
        href={searchHref(q, { sort: SEARCH_SORT_NEW })}
        prefetch={false}
        aria-current={newestActive ? "page" : undefined}
        className={newestActive ? CURRENT_CHIP_CLASS : CHIP_CLASS}
      >
        En yeni
      </Link>
    </nav>
  );
}
