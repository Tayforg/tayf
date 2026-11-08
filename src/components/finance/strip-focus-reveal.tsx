"use client";

import type { ReactNode } from "react";

// h65-keyboard-1 (WCAG 2.4.7, partial focus indicator): the /ekonomi market
// strip scrolls sideways inside overflow-x-auto. When a Tab lands on a chip
// that is only partly inside the strip, Blink does not scroll it into view if
// at least 32 px of it already shows, so the chip stays clipped: its inset
// focus ring and its move/volume text are cut off. Only the next Tab, onto a
// fully hidden chip, scrolls the strip. A CSS-only fix (scroll-padding-inline)
// was tried and does not trigger a scroll.
//
// This wrapper is the whole fix: React's onFocus bubbles (it is focusin), so
// one handler on the strip covers every chip, and TickerTape itself stays a
// server component. It must not import cn / src/lib/utils, tailwind-merge or a
// ui primitive: a "use client" closure that reaches them ships the class-merge
// stack to every public route (tests/guards/public-client-weight.test.ts R2).

type Span = { left: number; right: number };

/**
 * How far to move the strip's scrollLeft to bring a chip fully into view.
 * 0 when the chip is already inside the view; negative when it overflows on
 * the left; positive when it overflows on the right. A chip wider than the
 * view cannot fit, so its left edge is aligned instead.
 */
export function stripScrollDelta(chip: Span, view: Span): number {
  if (chip.left >= view.left && chip.right <= view.right) return 0;
  if (chip.left < view.left || chip.right - chip.left > view.right - view.left) return chip.left - view.left;
  return chip.right - view.right;
}

/** True for anything with the two Element members the reveal reads (also true for the test fakes, since node has no Element). */
function isElementLike(target: EventTarget | null): target is Element {
  if (target === null || typeof target !== "object") return false;
  const t = target as Partial<Element>;
  return typeof t.matches === "function" && typeof t.getBoundingClientRect === "function";
}

/** `:focus-visible` is true for keyboard focus and false for a mouse press; an engine that cannot parse the selector counts as false. */
function isFocusVisible(el: Element): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

/**
 * Scrolls `strip` just enough to show the focused chip in full. Acts only on
 * keyboard focus: a mouse press focuses the link on mousedown, and scrolling
 * then could move the chip out from under the pointer so the click misses.
 * Sets scrollLeft directly rather than calling scrollIntoView, so it never
 * scrolls the page vertically and never animates.
 */
export function revealFocusedChip(target: EventTarget | null, strip: HTMLElement): void {
  if (!isElementLike(target) || target === strip || !strip.contains(target) || !isFocusVisible(target)) return;
  const box = strip.getBoundingClientRect();
  // The visible box is inside the border: clientLeft is the left border width.
  const left = box.left + strip.clientLeft;
  const delta = stripScrollDelta(target.getBoundingClientRect(), { left, right: left + strip.clientWidth });
  if (delta !== 0) strip.scrollLeft += delta;
}

export function StripFocusReveal({ className, children }: { className: string; children: ReactNode }) {
  return (
    <div className={className} onFocus={(e) => revealFocusedChip(e.target, e.currentTarget)}>
      {children}
    </div>
  );
}
