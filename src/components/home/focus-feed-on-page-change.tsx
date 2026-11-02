"use client";

import { useEffect } from "react";

// Moves focus to the home feed container after a client-side page change of
// the pager (h17-a11y-4). Before this, activating "Sonraki" swapped the list
// and the focused link unmounted, so focus fell to <body> and a keyboard or
// screen-reader user restarted from the top of the document (WCAG 2.4.3).
//
// Why module scope instead of useRef: during the streamed navigation the
// island can remount inside the feed's <Suspense> boundary, which would reset
// a ref and make every page change look like a first render. Module state
// survives that, and a fresh document load starts at null, so the first load
// of any URL (including a direct hit on /?page=2) never moves focus.
//
// Why the query guard: typing in the search box navigates with router.replace
// and search-nav.ts deletes ?page, so a page change that comes with a query
// change is the search box talking, not the pager. Pulling focus out of the
// input would break typing. An editable active element is skipped for the
// same reason.
//
// Accepted side effect: the state is per document, so coming back to "/" from
// another route on a different page than the one last seen here (client-side
// navigation) also moves focus to the feed. That lands the user on the list
// they navigated to, which is a better place than <body>.

interface FeedPosition {
  page: number;
  query: string;
}

let lastSeen: FeedPosition | null = null;

interface EditableLike {
  tagName?: string;
  isContentEditable?: boolean;
}

/** True when typing would go into the element (input, textarea, select, contenteditable). */
export function isEditableTarget(el: EditableLike | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  return (
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable === true
  );
}

/**
 * Focus moves only for a pager-driven change: something was seen before, the
 * page differs, the query does not, and the user is not typing in a field.
 */
export function shouldFocusFeed(
  prev: FeedPosition | null,
  next: FeedPosition,
  activeIsEditable: boolean,
): boolean {
  if (prev === null) return false;
  if (activeIsEditable) return false;
  if (prev.query !== next.query) return false;
  return prev.page !== next.page;
}

export function FocusFeedOnPageChange({
  page,
  query,
  targetId,
}: {
  page: number;
  query: string;
  targetId: string;
}) {
  useEffect(() => {
    const next = { page, query };
    if (shouldFocusFeed(lastSeen, next, isEditableTarget(document.activeElement))) {
      document.getElementById(targetId)?.focus({ preventScroll: false });
    }
    lastSeen = next;
  }, [page, query, targetId]);

  return null;
}
