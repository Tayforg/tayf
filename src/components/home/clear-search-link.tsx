"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { isEditableTarget } from "./focus-feed-on-page-change";

// "Aramayı temizle" in the empty and unavailable search cards (h90-livearia-1).
//
// It used to be a plain <Link href="/">. The card that holds it unmounts when
// the navigation commits, so the focused element disappeared and focus fell to
// <body>: a keyboard or screen-reader user restarted from the top of the
// document (WCAG 2.4.3). FocusFeedOnPageChange cannot help, it refuses to move
// focus when the query changes (that is the search box talking).
//
// Here the link remembers it was activated, and once the query is gone it hands
// focus to the feed container (`targetId`, tabIndex -1, see page.tsx). Two paths
// do that, because the card normally leaves in the SAME commit that empties the
// query, and then this instance never renders with q === '':
//   - the query effect, when the link outlives the navigation commit;
//   - the unmount cleanup, which runs after the new DOM is in place, so the
//     target exists by then.
// Whichever runs first spends the flag.
//
// The flag hangs off `onNavigate`, not `onClick`: Link calls it right before an
// in-app navigation and never for a modified click (Cmd/Ctrl/Shift/Alt) or a
// new-tab target, so those do not arm it (same reasoning as RemoveSideLink in
// compare/remove-side-link.tsx). It never prevents the default, and without
// JavaScript the element is still just the link.
//
// preventScroll: the link sits at the top of the feed the container wraps and
// scroll={false} keeps the reader where they are; focus still lands for the
// next Tab and the screen reader. An editable active element is left alone
// (typing in the search box must not lose its caret to the feed).
//
// Kept free of `cn` / tailwind-merge: the class string is a literal
// (tests/guards/public-client-weight.test.ts).

const CLASS_NAME =
  "mt-1 inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted";

function focusTarget(targetId: string): void {
  if (isEditableTarget(document.activeElement)) return;
  document.getElementById(targetId)?.focus({ preventScroll: true });
}

export function ClearSearchLink({ targetId }: { targetId: string }) {
  const query = useSearchParams().get("q") ?? "";
  const pending = useRef(false);

  // The link is still mounted when the query empties.
  useEffect(() => {
    if (query !== "" || !pending.current) return;
    pending.current = false;
    focusTarget(targetId);
  }, [query, targetId]);

  // The card is removed together with the query.
  useEffect(
    () => () => {
      if (!pending.current) return;
      pending.current = false;
      focusTarget(targetId);
    },
    [targetId],
  );

  return (
    <Link
      href="/"
      scroll={false}
      className={CLASS_NAME}
      onNavigate={() => {
        pending.current = true;
      }}
    >
      Aramayı temizle
    </Link>
  );
}
