"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Telescope, Eye, Bookmark, Settings, TrendingUp } from "lucide-react";

// Below `sm` the labels are sr-only and each link is a 14 px icon, so the
// `max-sm:` floor lifts the touch target to 44 px (the size used elsewhere on
// the site; WCAG 2.5.8 only requires 24). sm+ is unchanged, and the h-14 header
// row is taller than 44 px, so the header height does not move.
//
// Current-page cue (h41-a11y-1, WCAG 1.4.1 / 1.4.11): the tint alone is
// bg-foreground/10 over the header, 1.21:1 on the dark theme, and below `sm`
// there is no label for font-weight to show on. The active link therefore also
// carries a full-foreground 2 px bottom border (>= 3:1 in both themes, pinned
// by tests/styles/nav-current-contrast.test.ts). It is a border rather than a
// ring or box-shadow, which forced-colors mode drops. `border-b-2` is in the
// shared base so every link reserves the same height (the border sits inside
// min-h-11 under border-box, so the 44 px floor and the h-14 row hold), and the
// colour is chosen per state: `border-transparent` lives in `inactive` only,
// because Tailwind emits .border-transparent after .border-foreground and the
// two together would leave the active bar invisible.
//
// Forced-colors mode: the browser repaints a transparent border in the system
// colour (LinkText), so without more every idle link would show the same 2 px
// bar as the current one. `forced-colors:border-[Canvas]` pins the idle bar to
// the page background there, so only the current link keeps a visible bar. It
// belongs to the idle states only, never to `active`.
const baseLink =
  "flex items-center gap-1.5 rounded-md border-b-2 px-2.5 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center";
const inactive =
  "border-transparent forced-colors:border-[Canvas] text-foreground/80 hover:text-foreground hover:bg-muted/50";
const active = "border-foreground bg-foreground/10 text-foreground font-medium";

interface NavLinksProps {
  /**
   * Whether the current viewer has a valid admin session cookie. When
   * false we hide the /admin link entirely so the gear icon isn't sitting
   * in every visitor's header as a "click me" target. The admin route
   * itself is still protected server-side (see lib/admin/session) —
   * this is just UX cleanup.
   */
  showAdmin?: boolean;
}

/**
 * The dividers are plain aria-hidden <span>s with literal classes, not the
 * shadcn <Separator>: that primitive is a client module (Base UI + cn() ->
 * tailwind-merge, ~32 KB on every public route, h13-weight-2). The primitive's
 * `data-vertical:w-px` never applied (Base UI emits data-orientation, and
 * globals.css has no data-vertical variant), so the live divider has always been
 * 0 px wide; these keep exactly that look. Adding `w-px` would draw a visible
 * line, which is a separate design decision (docs/perf.md).
 *
 * They are decoration, so they are aria-hidden (h67-landmarks-3): a separator
 * role inside one nav made a screen reader announce "separator" between the
 * links. The spans stay rather than being deleted because their `mx-0.5` is
 * the spacing between the links. tests/guards/no-role-separator.test.ts keeps
 * the role out of the layout.
 *
 * Hook-free nav markup. `pathname === null` means "no link is active". This
 * is what the header's static-shell <Suspense> fallback renders: calling
 * usePathname() there would itself suspend on fallback-param routes under
 * cacheComponents, defeating the fallback.
 */
export function NavLinksView({
  pathname,
  showAdmin = false,
}: {
  pathname: string | null;
  showAdmin?: boolean;
}) {
  const isHome = pathname === "/";
  const isBlindspots = pathname?.startsWith("/blindspots") ?? false;
  const isEkonomi = pathname?.startsWith("/ekonomi") ?? false;
  const isSaved = pathname?.startsWith("/saved") ?? false;
  const isAdmin = pathname?.startsWith("/admin") ?? false;

  return (
    <nav aria-label="Ana menü" className="flex items-center gap-1 text-[13px]">
      <Link
        href="/"
        aria-current={isHome ? "page" : undefined}
        className={`${baseLink} ${isHome ? active : inactive}`}
      >
        <Telescope className="h-3.5 w-3.5" />
        <span className="sr-only sm:hidden">Haberler</span>
        <span className="hidden sm:inline whitespace-nowrap">Haberler</span>
      </Link>
      <span aria-hidden="true" className="h-3 mx-0.5 shrink-0 bg-border" />
      <Link
        href="/blindspots"
        aria-current={isBlindspots ? "page" : undefined}
        className={`${baseLink} ${isBlindspots ? active : inactive}`}
      >
        <Eye className="h-3.5 w-3.5" />
        <span className="sr-only sm:hidden">Kör noktalar</span>
        <span className="hidden sm:inline whitespace-nowrap">Kör noktalar</span>
      </Link>
      <span aria-hidden="true" className="h-3 mx-0.5 shrink-0 bg-border" />
      <Link
        href="/ekonomi"
        aria-current={isEkonomi ? "page" : undefined}
        className={`${baseLink} ${isEkonomi ? active : inactive}`}
      >
        <TrendingUp className="h-3.5 w-3.5" />
        <span className="sr-only sm:hidden">Ekonomi</span>
        <span className="hidden sm:inline whitespace-nowrap">Ekonomi</span>
      </Link>
      <span aria-hidden="true" className="h-3 mx-0.5 shrink-0 bg-border" />
      <Link
        href="/saved"
        aria-current={isSaved ? "page" : undefined}
        className={`${baseLink} ${isSaved ? active : inactive}`}
      >
        <Bookmark className="h-3.5 w-3.5" />
        <span className="sr-only sm:hidden">Kaydedilenler</span>
        <span className="hidden sm:inline whitespace-nowrap">Kaydedilenler</span>
      </Link>
      {showAdmin && (
        <>
          <span
            aria-hidden="true"
            className="h-3 mx-0.5 shrink-0 bg-border"
          />
          <Link
            href="/admin"
            aria-current={isAdmin ? "page" : undefined}
            className={`flex items-center gap-1.5 rounded-md border-b-2 px-2 py-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring max-sm:min-h-11 max-sm:min-w-11 max-sm:justify-center ${
              isAdmin
                ? active
                : "border-transparent forced-colors:border-[Canvas] text-muted-foreground hover:text-foreground hover:bg-muted/50"
            }`}
          >
            <Settings className="h-3.5 w-3.5" />
            <span className="sr-only">Admin</span>
          </Link>
        </>
      )}
    </nav>
  );
}

export function NavLinks({ showAdmin = false }: NavLinksProps) {
  const pathname = usePathname();
  // Called as a function (not <NavLinksView />) so the returned element tree
  // is the <nav> itself — the tree-walking a11y tests rely on that.
  return NavLinksView({ pathname, showAdmin });
}
