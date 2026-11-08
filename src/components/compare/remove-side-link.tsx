"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { useCompareTray } from "./use-compare-tray";

/**
 * /karsilastir's "Bu tarafı kaldır": a plain link to the other side that also
 * takes the removed story out of the session compare tray, so the next
 * "Karşılaştır" pick pairs with the story the reader kept instead of
 * resurrecting the one they dropped and evicting the kept one.
 *
 * The tray changes only when Link performs the in-app navigation: the removal
 * hangs off `onNavigate`, which Link calls right before it navigates and never
 * for a modified click (Cmd/Ctrl/Shift/Alt), a new-tab target or a download. A
 * plain `onClick` would run for those too, dropping the story from this tab's
 * tray while the tab keeps showing it. It never prevents the default (that
 * would cancel Link's navigation), and with no JavaScript the element is still
 * just the link. `remove` is a no-op for an id the tray does not hold, so a
 * reader who arrived by a shared link keeps the tray they had. Kept free of
 * `cn` / tailwind-merge: the caller passes the literal class string
 * (tests/guards/public-client-weight.test.ts).
 */
export function RemoveSideLink({
  href,
  removeId,
  className,
  "aria-label": ariaLabel,
  children,
}: {
  href: string;
  removeId: string;
  className: string;
  "aria-label": string;
  children: ReactNode;
}) {
  const { remove } = useCompareTray();
  return (
    <Link
      href={href}
      className={className}
      aria-label={ariaLabel}
      onNavigate={() => remove(removeId)}
    >
      {children}
    </Link>
  );
}
