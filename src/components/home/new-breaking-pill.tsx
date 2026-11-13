"use client";

import { useEffect, useRef, useState, useTransition, type RefObject } from "react";
import { useRouter } from "next/navigation";

import { countNewBreaking, fetchHomeHead, newBreakingLabel } from "@/lib/clusters/home-head";
import {
  PILL_STATUS_MS,
  TIMELINE_REFRESH_RETRY_MS,
  pageSignature,
  refreshOutcome,
  remainingMs,
  startHeadPolling,
} from "@/lib/clusters/timeline-head";

// Realtime-lite for the home page's Son Dakika strip, no Supabase Realtime
// (h170-roadmap-2). While page 1 of the plain feed is open and visible, this
// polls the CDN-cached head endpoint (/api/home/head, backed by the SAME "use
// cache" entry that feeds the strip) every ~2 min, and when the strip holds a
// story the page does not list it shows "N yeni son dakika haberi · Yenile".
// Clicking it calls router.refresh(), which re-renders the server page in place.
// It is the twin of the /timeline pill (src/components/timeline/new-clusters-pill.tsx):
// the poller, the refresh verdict and the page fingerprint are the very functions
// of src/lib/clusters/timeline-head, so the two pills cannot drift in cadence or
// in what they say about a refresh. See that file for the reasoning behind each
// piece (h76-timeline-1: the refresh is verified, not assumed; react-L1: a hidden
// <Activity> boundary); only what differs is explained here.
//
// What counts as new: a head id that `knownIds` lacks. The page hands over the ids
// of every story it listed (strip and ranked rows), at most 36, with no age filter,
// so a story that merely moved from the ranked list into the strip is not news
// (countNewBreaking, knownBreakingIds). There is deliberately no render-clock filter:
// the strip's 2 h window is applied when the shared cache entry is filled, so the
// entry (and the head read from it) can hold a story that is over 2 h old by the
// render clock, and it must stay known. Ids only: the props stay small and no title
// crosses the wire.
//
// Placement, out of flow (CLS 0): the region is `fixed` at the bottom of the
// viewport, so no state of it (the pill, "Yenileniyor…", either outcome text) can
// move a card. The wrapper ignores the pointer (pointer-events-none) and only the
// button takes it back, so the empty strip of the screen never blocks a tap on the
// content beneath. Every className is ONE static literal, no child carries a
// margin, and each state is one text-xs line.
//
// Accessibility: the region is a polite status live region that is ALWAYS mounted,
// empty on the server, on the first client render and until something is new: a
// live region injected together with its text is not reliably announced (WCAG
// 4.1.3, as NewSinceLastVisit explains). The button carries no aria-label: its
// visible text IS its name (2.5.3); it is 44 px high on a phone (min-h-11) and 32 px
// from sm up. It is never `disabled` while the refresh runs (a disabled element
// drops keyboard focus): it is aria-disabled and ignores the click instead. When
// the refresh settles the button unmounts, so the status region (tabIndex -1) takes
// focus back, but only if focus was actually lost, and says the outcome for a few
// seconds.
//
// The page fingerprint is the known ids alone (pageSignature(null, knownIds)): a
// refresh that brings a new story into the listing changes the list, one that serves
// the same stale copy does not (refreshOutcome: "retry" once, then "unchanged"). That
// holds only because knownIds has no clock in it.

interface NewBreakingPillProps {
  /**
   * Ids of every story the server rendered, the strip and the whole ranked set
   * (knownBreakingIds): no age filter, so the list changes only when the cached
   * entry does, never because the render clock moved.
   */
  knownIds: string[];
}

// The count is tied to the page it was computed against, by the page's signature.
// After a refresh that really changed the page the signature changes, `hit.sig` no
// longer matches, and the shown count falls back to 0 on its own. A click does NOT
// clear the count: an unchanged page keeps it.
type Hit = { sig: string; count: number };

// One click's refresh: the page signature taken at the click, and how many
// refreshes of it have already come back unchanged (0 = the click, 1 = the one
// automatic retry).
type Cycle = { before: string; attempt: number };

// What the region says once a refresh has settled. "retrying" is the wait before
// the single automatic retry: the button stays up as "Yenileniyor…".
type Settled = "none" | "retrying" | "updated" | "unchanged";

// A settle outcome with an identity: every transition into "retrying", "updated"
// or "unchanged" takes the previous seq + 1, so an effect that re-runs for the same
// outcome (an <Activity> reveal, a StrictMode re-run) can tell it from a new one.
type SettledState = { kind: Settled; seq: number };

// The one place the wall clock is read. Only the effects and the poller call it,
// never a render.
const readClock = () => Date.now();

const signatureOf = (knownIds: readonly string[]) => pageSignature(null, knownIds);

export function NewBreakingPill({ knownIds }: NewBreakingPillProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [hit, setHit] = useState<Hit | null>(null);
  const [cycle, setCycle] = useState<Cycle | null>(null);
  const [settled, setSettled] = useState<SettledState>({ kind: "none", seq: 0 });
  const regionRef = useRef<HTMLDivElement>(null);
  // The due time of the current outcome's timer (the retry, or the end of the
  // status text), pinned the first time its effect runs for that seq. Written in
  // effects and in the click handler, never read while rendering.
  const deadline = useRef<{ seq: number; at: number } | null>(null);

  // "A refresh just finished": pending went true -> false. Derived during render
  // from the previous value (the documented alternative to setState in an effect);
  // the guard makes it settle after one extra render. The props of this very render
  // are the refreshed page, so the verdict compares them with the fingerprint taken
  // at the click.
  const [pendingSeen, setPendingSeen] = useState(false);
  if (pending !== pendingSeen) {
    setPendingSeen(pending);
    if (pendingSeen && !pending && cycle !== null) {
      const outcome = refreshOutcome(cycle.before, signatureOf(knownIds), cycle.attempt);
      if (outcome === "changed") {
        setHit(null);
        setCycle(null);
        setSettled({ kind: "updated", seq: settled.seq + 1 });
      } else if (outcome === "retry") {
        setSettled({ kind: "retrying", seq: settled.seq + 1 });
      } else {
        setCycle(null);
        setSettled({ kind: "unchanged", seq: settled.seq + 1 });
      }
    }
  }

  // The click is ignored while a refresh runs and while the retry waits.
  const busy = pending || settled.kind === "retrying";

  // The poller starts once; it reads the latest props through this ref so a
  // refresh does not restart it (which would also reset its cadence).
  const latest = useRef({ knownIds });
  useEffect(() => {
    latest.current = { knownIds };
  });

  useEffect(() => {
    return startHeadPolling({
      fetchHead: (signal) => fetchHomeHead(signal),
      onRows: (rows) => {
        const known = latest.current.knownIds;
        const count = countNewBreaking(rows, new Set(known));
        const sig = signatureOf(known);
        setHit((prev) =>
          prev !== null && prev.sig === sig && prev.count === count ? prev : { sig, count },
        );
      },
      isVisible: () => document.visibilityState === "visible",
      subscribeVisibility: (cb) => {
        document.addEventListener("visibilitychange", cb);
        return () => document.removeEventListener("visibilitychange", cb);
      },
      now: readClock,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
    });
  }, []);

  // The one automatic retry. It only arms a timer; its setState calls run in the
  // timer callbacks, not in the effect body. The wait is a deadline pinned for this
  // outcome (seq), so an <Activity> reveal re-arms only the time that is left; if it
  // already passed while hidden the retry is dropped (the cycle is cleared, nothing
  // refreshes). Cleared on unmount and when the status leaves "retrying".
  useEffect(() => {
    if (settled.kind !== "retrying") return;
    const seq = settled.seq;
    if (deadline.current?.seq !== seq) {
      deadline.current = { seq, at: readClock() + TIMELINE_REFRESH_RETRY_MS };
    }
    const left = remainingMs(deadline.current.at, readClock());
    if (left === null) {
      const dropped = window.setTimeout(() => {
        setCycle(null);
        setSettled({ kind: "none", seq });
      }, 0);
      return () => window.clearTimeout(dropped);
    }
    const timer = window.setTimeout(() => {
      setCycle((c) => (c === null ? c : { ...c, attempt: 1 }));
      setSettled({ kind: "none", seq });
      startTransition(() => {
        router.refresh();
      });
    }, left);
    return () => window.clearTimeout(timer);
  }, [settled.kind, settled.seq, router, startTransition]);

  // After the refresh settles the button is gone; give focus back to the region if
  // it fell to <body>, then retire the status text. Never steals focus from a
  // control the user moved to meanwhile. Focus moves on the FIRST run for an
  // outcome only; a re-run for the same seq (an <Activity> reveal, a StrictMode
  // re-run) just re-arms the timer for the time left, 0 if it already ran out.
  useEffect(() => {
    if (settled.kind !== "updated" && settled.kind !== "unchanged") return;
    const seq = settled.seq;
    if (deadline.current?.seq !== seq) {
      deadline.current = { seq, at: readClock() + PILL_STATUS_MS };
      const active = document.activeElement;
      if (active === null || active === document.body) {
        regionRef.current?.focus({ preventScroll: true });
      }
    }
    const left = remainingMs(deadline.current.at, readClock()) ?? 0;
    const timer = window.setTimeout(() => setSettled({ kind: "none", seq }), left);
    return () => window.clearTimeout(timer);
  }, [settled.kind, settled.seq]);

  const count = hit !== null && hit.sig === signatureOf(knownIds) ? hit.count : 0;

  return (
    <BreakingPillRegion
      regionRef={regionRef}
      count={count}
      busy={busy}
      outcome={settled.kind === "updated" || settled.kind === "unchanged" ? settled.kind : "none"}
      onClick={() => {
        if (busy) return;
        deadline.current = null;
        setCycle({ before: signatureOf(knownIds), attempt: 0 });
        setSettled((s) => ({ kind: "none", seq: s.seq }));
        startTransition(() => {
          router.refresh();
        });
      }}
    />
  );
}

interface BreakingPillRegionProps {
  regionRef: RefObject<HTMLDivElement | null>;
  /** New breaking stories the last poll found against this page; 0 shows nothing. */
  count: number;
  /** A refresh is running or waiting for its one automatic retry. */
  busy: boolean;
  /** What the last settled refresh amounts to; "none" while there is nothing to say. */
  outcome: "none" | "updated" | "unchanged";
  onClick: () => void;
}

// The markup of every state, split from the state machine above so it can be
// rendered (and read) on its own. The region is ONE static literal: no state
// changes its box, and it is the same element on the server, on the first client
// render and ever after. An unchanged page hides the button for the length of its
// outcome text and then gives it back with its count, for a manual retry.
export function BreakingPillRegion({
  regionRef,
  count,
  busy,
  outcome,
  onClick,
}: BreakingPillRegionProps) {
  const showButton = busy || (count > 0 && outcome !== "unchanged");
  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      tabIndex={-1}
      className="fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex justify-center pointer-events-none focus-visible:outline-none"
    >
      {showButton ? (
        <button
          type="button"
          aria-disabled={busy}
          onClick={onClick}
          className="pointer-events-auto inline-flex min-h-11 sm:min-h-8 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-60"
        >
          {busy ? "Yenileniyor…" : `${newBreakingLabel(count)} · Yenile`}
        </button>
      ) : outcome === "unchanged" ? (
        <p className="rounded-full bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border">
          Liste henüz güncellenmedi, tekrar deneyin
        </p>
      ) : outcome === "updated" ? (
        <p className="rounded-full bg-background px-3 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border">
          Liste güncellendi
        </p>
      ) : null}
    </div>
  );
}
