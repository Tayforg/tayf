"use client";

import { useCallback, useState } from "react";

// browser-5: the /trends chart is a 640px-min SVG inside an overflow-x
// container. At 390px the container opened at scrollLeft 0, so the oldest
// days showed and the newest bar sat off-screen. <ScrollToEnd> scrolls the
// container to the newest day when it mounts and, while older days remain
// off-screen to the left, shows a "← önceki günler" hint plus a left fade.
//
// No effect hook (react-hooks/set-state-in-effect is enforced): a stable
// callback ref runs once when the scroller div attaches and measures it.
// Initial state is "not overflowing", so the server markup and the first
// client render carry no hint (no hydration mismatch); the hint appears one
// commit later, only when the chart genuinely overflows.

type ScrollMetrics = { scrollWidth: number; clientWidth: number; scrollLeft: number };

/**
 * Pixels of horizontal slack before the scroller counts as overflowing, and
 * before a scroll offset counts as "not at the start". /trends at 1280x800
 * measured scrollWidth 944 against clientWidth 942 and scrollLeft 2 (the
 * spectrum glow and sub-pixel rounding), which with a 1px slack showed a
 * "← önceki günler" hint although all 30 days were on screen. A few pixels of
 * overhang is never a hidden day; a real overflow (the 640px-min SVG on a
 * phone, a wider chart) is hundreds of pixels.
 */
export const OVERFLOW_SLACK_PX = 8;

/**
 * Scrolls `el` to its right edge when its content overflows horizontally by
 * more than OVERFLOW_SLACK_PX. Returns whether it overflowed. Within the slack
 * nothing is scrolled, so a chart that fits never reports a phantom scrollbar.
 */
export function scrollToEndIfOverflowing(el: ScrollMetrics): boolean {
  const overflowing = el.scrollWidth > el.clientWidth + OVERFLOW_SLACK_PX;
  if (overflowing) el.scrollLeft = el.scrollWidth;
  return overflowing;
}

/** True when the scroller sits at (or within OVERFLOW_SLACK_PX of) its left edge. */
export function isAtStart(el: { scrollLeft: number }): boolean {
  return el.scrollLeft <= OVERFLOW_SLACK_PX;
}

/**
 * Left-edge fade plus a "previous days" label. Purely decorative for sighted
 * users (pointer-events-none so it never blocks the chart); screen readers
 * skip the arrow and fade and get a short note that the chart scrolls.
 */
export function ScrollHint() {
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-background to-transparent"
      />
      <p className="pointer-events-none absolute left-2 top-1 font-mono text-[10px] text-muted-foreground">
        <span aria-hidden="true">← </span>önceki günler
        <span className="sr-only"> (grafik yatay kaydırılabilir)</span>
      </p>
    </>
  );
}

export function ScrollToEnd({
  children,
  className,
}: {
  children: React.ReactNode;
  className: string;
}) {
  const [overflowing, setOverflowing] = useState(false);
  const [atStart, setAtStart] = useState(false);

  const ref = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    setOverflowing(scrollToEndIfOverflowing(el));
    setAtStart(isAtStart(el));
  }, []);

  return (
    <div className="relative">
      <div
        ref={ref}
        className={className}
        onScroll={(e) => setAtStart(isAtStart(e.currentTarget))}
      >
        {children}
      </div>
      {overflowing && !atStart ? <ScrollHint /> : null}
    </div>
  );
}
