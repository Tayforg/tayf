import { Suspense } from "react";
import Link from "next/link";
import { Separator } from "@/components/ui/separator";
import { NavLinks, NavLinksView } from "@/components/layout/nav-links";
import { hasAdminSession } from "@/lib/admin/session";
import { NewsletterStatusBanner } from "@/components/newsletter/newsletter-status-banner";

/**
 * Reads the admin session cookie (cookies() → dynamic) and renders the real
 * nav. Kept out of <Header> so only this leaf suspends, never the whole
 * header. Server-side check so the admin link is invisible to anyone without
 * a valid cookie; runs per-request, negligible cost (HMAC verify of a short
 * string), and keeps /admin out of the HTML entirely.
 */
export async function HeaderNav() {
  const showAdmin = await hasAdminSession();
  return <NavLinks showAdmin={showAdmin} />;
}

/**
 * Same-height placeholder for the root layout's <Suspense> around <Header>.
 * Header no longer suspends, so this is a safety net. 59px = 2px accent line
 * + h-14 (56px) row + 1px border-b (border-box includes the border).
 */
export function HeaderFallback() {
  return (
    <div
      aria-hidden="true"
      className="sticky top-0 z-50 h-[59px] border-b border-border/40 bg-background/90"
    />
  );
}

// Synchronous on purpose: the header (logo, skip link, nav shell) is part of
// the static prerender, so it never arrives late and shifts the page (CLS).
export function Header() {
  return (
    <header className="sticky top-0 z-50 border-b border-border/40 bg-background/90 backdrop-blur-xl">
      {/* Skip link: first focusable element in the document (Header is the
          first element in <body>). Target is <main id="main"> in
          src/app/layout.tsx. `focus:fixed` + `focus:z-[60]` keep the
          revealed link above the sticky (z-50) header without making the
          header `relative`. WCAG 2.4.1 Bypass Blocks. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-md focus:border focus:border-border focus:bg-background focus:px-4 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
      >
        İçeriğe atla
      </a>

      {/* Thin brand accent line at the very top */}
      <div className="h-[2px] bg-gradient-to-r from-red-500/80 via-brand to-emerald-500/80" />

      <div className="container mx-auto flex h-14 items-center justify-between px-4 sm:px-6">
        <Link
          href="/"
          className="group flex items-center gap-3 rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {/* Logo mark — spectrum bars */}
          <div className="flex gap-[2px] h-7 items-end shrink-0">
            <div className="w-[3px] h-3 rounded-full bg-red-500/70 group-hover:h-5 transition-all duration-300" />
            <div className="w-[3px] h-5 rounded-full bg-brand/80 group-hover:h-7 transition-all duration-300" />
            <div className="w-[3px] h-4 rounded-full bg-emerald-500/70 group-hover:h-6 transition-all duration-300" />
          </div>
          <div className="flex items-baseline gap-2 leading-none">
            <span className="font-serif text-xl font-normal tracking-tight">
              Tayf
            </span>
            <Separator
              orientation="vertical"
              className="h-3.5 mx-0 hidden sm:block bg-border/40"
            />
            <span className="text-[11px] font-medium tracking-wide text-muted-foreground hidden sm:inline uppercase">
              Haber Analizi
            </span>
          </div>
        </Link>

        {/* NavLinksView (no usePathname) is the fallback: usePathname
            suspends on fallback-param routes under cacheComponents, so the
            fallback must stay hook-free. It gives the same markup with no
            active link; the real nav replaces it once the cookie read
            resolves. */}
        <Suspense fallback={<NavLinksView pathname={null} showAdmin={false} />}>
          <HeaderNav />
        </Suspense>
      </div>

      {/* Shows the `?bulten=` flag left by the newsletter confirm/unsubscribe
          redirects (src/app/api/newsletter/{confirm,unsubscribe}/route.ts).
          useSearchParams() requires a Suspense boundary; this local boundary
          keeps the rest of the header's static content out of that dynamic
          subtree. */}
      <Suspense fallback={null}>
        <NewsletterStatusBanner />
      </Suspense>
    </header>
  );
}
