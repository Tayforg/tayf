"use client";

import { useEffect, useSyncExternalStore } from "react";

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
}

// The role="status" container is ALWAYS rendered, empty on the server and on a
// first visit. A live region that is injected into the page together with its
// text is not reliably announced; one that is already mounted and then gets
// its text is (WCAG 4.1.3). While there is nothing to say it is `sr-only`
// (absolutely positioned, 1px, clipped), so the empty region adds no gap to the
// page's space-y flow. The visible pill appears inside it only when something
// is new.
export function NewSinceLastVisit({ timestamps }: NewSinceLastVisitProps) {
  const stamp = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const count = countNewSince(timestamps, stamp);

  useEffect(() => {
    writeLastVisit(new Date().toISOString());
  }, []);

  return (
    <div role="status" aria-live="polite" className={count > 0 ? "" : "sr-only"}>
      {count > 0 && (
        <p className="inline-flex items-center gap-1.5 rounded-full border border-brand/30 bg-brand/10 px-3 py-1 text-[11px] font-medium text-brand">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-brand" aria-hidden="true" />
          {count} yeni haber
        </p>
      )}
    </div>
  );
}
