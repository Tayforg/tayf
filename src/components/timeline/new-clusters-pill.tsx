"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  countNewClusters,
  newClustersLabel,
  readHeadResponse,
  startHeadPolling,
} from "@/lib/clusters/timeline-head";

// Realtime-lite for /timeline, no Supabase Realtime. Polls the CDN-cached head
// endpoint (/api/timeline/head, backed by the SAME "use cache" entry that
// rendered this page) every ~2 min while the tab is visible, and when it finds
// clusters the page does not have, shows "N yeni küme · Yenile". Clicking it
// calls router.refresh(), which re-renders the server page in place.
//
// Accessibility: the wrapper is a polite status live region, so the count is
// announced without moving focus (WCAG 4.1.3). The button carries no aria-label:
// its visible text IS its name (2.5.3). min-h-8 keeps the target >= 24 px (2.5.8).
//
// Layout (CLS 0): the region is always mounted and sits ABSOLUTELY in the
// parent's 32 px space-y-8 gap, directly below the hero (top-full, inset-x-0,
// h-8). It is out of flow, so neither the pill, the "Yenileniyor…" label nor the
// "Liste güncellendi" confirmation can move the list under it. The parent must
// be `relative` (the /timeline hero wrapper is). Its className is ONE static
// literal and no child carries a margin, so no state changes the box.
//
// Focus: the button is never `disabled` while the refresh runs (a disabled
// element drops keyboard focus); it is aria-disabled and ignores the click
// instead. When the refresh settles the count is 0 and the button unmounts, so
// the always-mounted status region (tabIndex -1) takes focus back, but only if
// focus was actually lost, and says "Liste güncellendi" for a few seconds so a
// screen-reader user hears that the list changed.
//
// Hydration: the server and the first client render both emit the empty region
// (the count is 0 until the poller has run in an effect), so nothing can
// mismatch. The poll schedule and the "what is new" diff live in
// @/lib/clusters/timeline-head, where they are unit-tested.

interface NewClustersPillProps {
  /** Newest first_published the server rendered; null when the page was empty. */
  newestPublished: string | null;
  /** Ids of the first <= 50 rows the server rendered (the head's own window). */
  knownIds: string[];
}

// The count is tied to the page it was computed against. After a refresh the
// props change, `hit.newest` no longer matches, and the shown count falls back
// to 0 on its own -- no setState-in-an-effect needed to clear it.
type Hit = { newest: string | null; count: number };

export function NewClustersPill({
  newestPublished,
  knownIds,
}: NewClustersPillProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hit, setHit] = useState<Hit | null>(null);
  const regionRef = useRef<HTMLDivElement>(null);

  // "A refresh just finished": pending went true -> false. Derived during
  // render from the previous value (the documented alternative to setState in
  // an effect); the guard makes it settle after one extra render.
  const [pendingSeen, setPendingSeen] = useState(false);
  const [updated, setUpdated] = useState(false);
  if (pending !== pendingSeen) {
    setPendingSeen(pending);
    setUpdated(pendingSeen && !pending);
  }

  // The poller starts once; it reads the latest props through this ref so a
  // refresh does not restart it (which would also reset its cadence).
  const latest = useRef({ newestPublished, knownIds });
  useEffect(() => {
    latest.current = { newestPublished, knownIds };
  });

  useEffect(() => {
    return startHeadPolling({
      fetchHead: (signal) =>
        fetch("/api/timeline/head", {
          signal,
          headers: { accept: "application/json" },
        }).then(readHeadResponse),
      onRows: (rows) => {
        const { newestPublished: newest, knownIds: known } = latest.current;
        const count = countNewClusters(rows, {
          newestPublished: newest,
          knownIds: new Set(known),
        });
        setHit((prev) =>
          prev !== null && prev.newest === newest && prev.count === count
            ? prev
            : { newest, count },
        );
      },
      isVisible: () => document.visibilityState === "visible",
      subscribeVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
    });
  }, []);

  // After the refresh the button is gone; give focus back to the region if it
  // fell to <body>, then retire the confirmation. Never steals focus from a
  // control the user moved to meanwhile.
  useEffect(() => {
    if (!updated) return;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      regionRef.current?.focus({ preventScroll: true });
    }
    const timer = window.setTimeout(() => setUpdated(false), 6000);
    return () => window.clearTimeout(timer);
  }, [updated]);

  const count = hit !== null && hit.newest === newestPublished ? hit.count : 0;

  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      tabIndex={-1}
      className="absolute inset-x-0 top-full flex h-8 items-center justify-center focus-visible:outline-none"
    >
      {count > 0 || pending ? (
        <button
          type="button"
          aria-disabled={pending}
          onClick={() => {
            if (pending) return;
            setHit(null);
            startTransition(() => {
              router.refresh();
            });
          }}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-60"
        >
          {pending ? "Yenileniyor…" : `${newClustersLabel(count)} · Yenile`}
        </button>
      ) : updated ? (
        <p className="text-xs text-muted-foreground">Liste güncellendi</p>
      ) : null}
    </div>
  );
}
