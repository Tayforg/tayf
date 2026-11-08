"use client";

import { useEffect, useLayoutEffect, useSyncExternalStore } from "react";

import { countNewSince, readLastVisit, writeLastVisit } from "@/lib/last-visit";

// Stamp as it was when this page load started — read once, then frozen so the
// pill doesn't vanish after the stamp is refreshed in the effect below.
let stampAtLoad: string | null | undefined;
const subscribe = () => () => {};
function getSnapshot(): string | null {
  if (stampAtLoad === undefined) stampAtLoad = readLastVisit();
  return stampAtLoad;
}
const getServerSnapshot = () => null;

interface NewSinceLastVisitProps {
  /** ISO `first_published` of the clusters rendered on the page. */
  timestamps: string[];
  /**
   * Whether this render showed the feed (page.tsx: shouldStampLastVisit). Only
   * then is the last-visit stamp advanced; the outage shell, a search view and
   * ?page=N leave it alone so the next session still counts what was missed.
   * Server-decided and a plain boolean, so it cannot cause a hydration mismatch.
   */
  stamp: boolean;
}

// The tree is CONSTANT: server HTML, first client render and every later
// render all output <div data-new-pill-slot><div role="status" ...>. Only the
// visible pill <p> inside the status region depends on the stamp.
//
// WCAG 4.1.3: the role="status" container is ALWAYS rendered, empty on the
// server and on a first visit. A live region that is injected into the page
// together with its text is not reliably announced; one that is already mounted
// and then gets its text is. The pill appears inside it only when something is
// new.
//
// Layout (h68-lcp-1): the wrapper used to switch from `sr-only` to an in-flow
// block once the client had read the stamp, which pushed the whole feed (the LCP
// card included) down ~48 px after hydration for every returning reader. Now
// the wrapper never changes class. globals.css gives `[data-new-pill-slot]` the
// sr-only geometry (absolute, 1px, clipped: no height, no gap in the page's
// space-y flow), and `html[data-rv] [data-new-pill-slot][data-reserve]` turns it
// into an in-flow 26 px slot. `data-rv` is set on <html> by
// RETURNING_READER_SCRIPT (src/lib/returning-reader-script.ts), an inline script
// that runs before the feed is parsed and reads the same localStorage key as
// this component, so the slot is reserved before first paint. The pill has an
// exact height (h-6.5 = 1.625rem, leading-4 so its box is 16 + 8 padding + 2
// border) and fills the slot without moving anything. It is a block-level
// `flex w-fit`, not an `inline-flex`: an inline box sits in a line box, and the
// inherited 16 px font at 1.5 line-height makes that line box 28 px, 2 px taller
// than the pill (measured in Chrome). A first-time reader has no stamp, no
// `data-rv`, and gets no blank row.
//
// The slot is reserved only when this render shows clusters: `data-reserve` is
// set from `timestamps.length > 0`, a server-decided prop, so server HTML and
// client markup are identical. The outage shell, EmptyClusters and a search with
// no in-feed matches pass timestamps=[], so count is always 0 there and no row
// is reserved (a returning reader would otherwise see those cards start 46 px
// lower: the 26 px slot plus the 20 px space-y-5 gap).
//
// Accepted trade-off, now only when timestamps is non-empty: a returning reader
// with 0 new items sees an empty 26 px slot. Collapsing it after hydration would
// be a new layout shift, and the server cannot know the stamp (the page stays
// cacheable, no cookies).
export function NewSinceLastVisit({ timestamps, stamp }: NewSinceLastVisitProps) {
  const since = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const count = countNewSince(timestamps, since);

  // RETURNING_READER_SCRIPT only runs at document parse, in the root layout that
  // persists across App Router soft navigations. A soft navigation to "/" can
  // therefore mount this component after another tab wrote the stamp: count > 0
  // but no `data-rv`, so the slot would stay sr-only and the pill would be
  // clipped while still announced. This layout effect opens the slot before
  // paint (a soft-navigation mount commits fresh content in the same frame, so
  // nothing visibly shifts). During normal hydration it is a no-op, the script
  // already set the attribute. count > 0 implies timestamps.length > 0, so
  // `data-reserve` is on the wrapper whenever this runs.
  useLayoutEffect(() => {
    if (count > 0) document.documentElement.setAttribute("data-rv", "");
  }, [count]);

  // Re-runs when `stamp` flips: clearing a search on "/" (false -> true) puts the
  // reader back on the feed, which is a visit worth stamping.
  useEffect(() => {
    if (stamp) writeLastVisit(new Date().toISOString());
  }, [stamp]);

  return (
    <div data-new-pill-slot="" data-reserve={timestamps.length > 0 ? "" : undefined}>
      <div role="status" aria-live="polite">
        {count > 0 && (
          <p className="flex h-6.5 w-fit items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-[11px] leading-4 font-medium text-brand">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
            {count} yeni haber
          </p>
        )}
      </div>
    </div>
  );
}
