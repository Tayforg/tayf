"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

export type RetryPhase = "idle" | "pending" | "failed";

// Text for the polite live region. Empty while idle so nothing is announced
// until the reader actually presses the button.
export function retryStatusText(phase: RetryPhase): string {
  switch (phase) {
    case "pending":
      return "Yeniden yükleniyor…";
    case "failed":
      return "Hâlâ yüklenemedi. Biraz sonra yeniden deneyin.";
    case "idle":
      return "";
  }
}

// pending -> not pending while this button is still mounted means the refresh
// finished and the failure block is still here, i.e. it did not recover. On a
// successful refresh the parent re-renders without the failure block, this
// component unmounts, and "failed" is never shown.
export function nextRetryPhase(
  phase: RetryPhase,
  isPending: boolean,
): RetryPhase {
  if (isPending) return "pending";
  return phase === "pending" ? "failed" : phase;
}

const DEFAULT_CLASS_NAME =
  "mt-1 inline-flex min-h-[44px] touch-manipulation items-center rounded-full border border-border/60 bg-background px-4 text-[12px] font-medium text-foreground transition-colors hover:bg-muted aria-disabled:opacity-60";

// Generic "Tekrar dene" affordance for every data-fetch-failed empty state
// this pack introduces (home feed, archive search, /blindspots,
// /sources) and for the route error boundaries. `router.refresh()` re-runs
// the server components on the current route without a full client-side
// navigation — a fresh render gets a fresh shot at whatever transiently failed
// (Supabase blip, a `use cache: remote` miss, etc.) without losing scroll
// position or client state elsewhere on the page.
//
// `onRetry` replaces `router.refresh()` for callers that already own a retry
// action: the route error boundaries pass Next's `retry` (refresh + reset in
// its own transition). It runs inside this button's transition, so `isPending`
// stays true until that nested transition commits, and the same pending
// state, ignored double click and live region apply. `className` replaces the
// default look (the boundaries keep their solid primary button); keep
// `aria-disabled:opacity-60` in it.
//
// Accessibility: the button is `aria-disabled` while pending, never
// `disabled` — a disabled button drops keyboard focus, so a keyboard user
// would be thrown back to the top of the page mid-retry. Clicks are ignored
// while pending instead. The status span is always mounted (a live region
// has to exist before its text changes to be announced) and is visually
// hidden; focus is never moved programmatically.
//
// Order matters: the status span comes BEFORE the button so the button stays
// the last child. In Tailwind 4 `space-y-*` puts `margin-block-end` on every
// child that is `:not(:last-child)`; if the span came last, a `space-y-*`
// parent would add that margin under the (inline-flex) button and enlarge its
// line box. The span is position:absolute (sr-only), so its own margin is
// irrelevant and it is not part of the layout.
export function RetryButton({
  label = "Tekrar dene",
  onRetry,
  className,
}: {
  label?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [phase, setPhase] = useState<RetryPhase>("idle");

  // Derived from the previous render (React's "adjust state while rendering"
  // pattern): no effect, so no frame where the new pending/failed state is
  // not yet reflected in the live region.
  const nextPhase = nextRetryPhase(phase, isPending);
  if (nextPhase !== phase) setPhase(nextPhase);

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">
        {retryStatusText(nextPhase)}
      </span>
      <button
        type="button"
        aria-disabled={isPending}
        onClick={() => {
          if (isPending) return;
          startTransition(() => {
            if (onRetry) onRetry();
            else router.refresh();
          });
        }}
        className={className ?? DEFAULT_CLASS_NAME}
      >
        {isPending ? "Yükleniyor…" : label}
      </button>
    </>
  );
}
