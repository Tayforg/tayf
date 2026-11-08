"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  PILL_STATUS_MS,
  TIMELINE_REFRESH_RETRY_MS,
  countNewClusters,
  newClustersLabel,
  pageSignature,
  readHeadResponse,
  refreshOutcome,
  remainingMs,
  startHeadPolling,
} from "@/lib/clusters/timeline-head";

// Realtime-lite for /timeline, no Supabase Realtime. Polls the CDN-cached head
// endpoint (/api/timeline/head, backed by the SAME "use cache" entry that feeds
// this page) every ~2 min while the tab is visible, and when it finds clusters
// the page does not have, shows "N yeni küme · Yenile". Clicking it calls
// router.refresh(), which re-renders the server page in place.
//
// The refresh is verified, not assumed (h76-timeline-1). The head and the page's
// ISR copy have independent lifecycles: the head re-reads the 300 s "cluster-feed"
// entry (and every open tab's poll keeps it fresh), while the page copy is only
// rebuilt when someone requests /timeline after its window, and that request is
// itself served the OLD copy. So after a quiet spell the first click can come back
// with the very page it started from. The click therefore takes a fingerprint of
// the page (pageSignature) and the refresh is judged when it settles
// (refreshOutcome): "changed" clears the count and confirms; "retry" keeps the
// button up as "Yenileniyor…" and refreshes once more after
// TIMELINE_REFRESH_RETRY_MS (the first request already started the rebuild);
// "unchanged" says "Liste henüz güncellenmedi, tekrar deneyin" and then gives the
// pill back with its count, for a manual retry. An unchanged page never hides the
// pill and is never confirmed.
//
// Accessibility: the wrapper is a polite status live region, so the count is
// announced without moving focus (WCAG 4.1.3). The button carries no aria-label:
// its visible text IS its name (2.5.3). min-h-8 keeps the target >= 24 px (2.5.8).
//
// Layout (CLS 0): the region is always mounted and sits ABSOLUTELY in the
// parent's 32 px space-y-8 gap, directly below the hero (top-full, inset-x-0,
// h-8). It is out of flow, so no state (the pill, "Yenileniyor…", either status
// text) can move the list under it; each is one text-xs line that fits 360 px.
// The parent must be `relative` (the /timeline hero wrapper is). Its className
// is ONE static literal and no child carries a margin, so no state changes the
// box.
//
// Focus: the button is never `disabled` while the refresh runs (a disabled
// element drops keyboard focus); it is aria-disabled and ignores the click
// instead, also while the automatic retry waits. When the refresh settles as
// changed or unchanged the button unmounts, so the always-mounted status region
// (tabIndex -1) takes focus back, but only if focus was actually lost, and says
// the outcome for a few seconds so a screen-reader user hears it.
//
// Hidden <Activity> (react-L1): with cacheComponents Next keeps /timeline mounted
// while a cluster is open and React runs every effect cleanup on hide and every
// effect again on reveal, but keeps state. The two timers (the retry and the
// status text) would be cleared on hide while `settled` and `cycle` survive, so a
// plain re-arm would bring back a stale "Yenileniyor…" and an unrequested
// refresh, or move focus again and repeat an old message. Each outcome therefore
// has an identity (`seq`) and the deadline pinned for it in a ref: the first run
// for a seq sets the deadline (and is the only run that may move focus), every
// later run waits only for what is left (remainingMs), and a retry whose time
// passed while hidden is dropped without refreshing.
//
// Hydration: the server and the first client render both emit the empty region
// (the count is 0 until the poller has run in an effect), so nothing can
// mismatch. The poll schedule, the "what is new" diff and the refresh verdict
// live in @/lib/clusters/timeline-head, where they are unit-tested.

interface NewClustersPillProps {
  /** Newest first_published the server rendered; null when the page was empty. */
  newestPublished: string | null;
  /** Ids of the first <= 50 rows the server rendered (the head's own window). */
  knownIds: string[];
}

// The count is tied to the page it was computed against. After a refresh that
// really changed the page the props change, `hit.newest` no longer matches, and
// the shown count falls back to 0 on its own; the settle step also clears it
// explicitly. A click does NOT clear it: an unchanged page keeps its count.
type Hit = { newest: string | null; count: number };

// One click's refresh: the page signature taken at the click, and how many
// refreshes of it have already come back unchanged (0 = the click, 1 = the one
// automatic retry).
type Cycle = { before: string; attempt: number };

// What the region says once a refresh has settled. "retrying" is the wait before
// the single automatic retry: the button stays up as "Yenileniyor…".
type Settled = "none" | "retrying" | "updated" | "unchanged";

// A settle outcome with an identity: every transition into "retrying", "updated"
// or "unchanged" takes the previous seq + 1, so an effect that re-runs for the
// same outcome (an <Activity> reveal, a StrictMode re-run) can tell it from a new
// one.
type SettledState = { kind: Settled; seq: number };

// The one place the wall clock is read. Only the effects and the poller call it,
// never a render.
const readClock = () => Date.now();

export function NewClustersPill({
  newestPublished,
  knownIds,
}: NewClustersPillProps) {
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

  // "A refresh just finished": pending went true -> false. Derived during
  // render from the previous value (the documented alternative to setState in
  // an effect); the guard makes it settle after one extra render. The props of
  // this very render are the refreshed page, so the verdict compares them with
  // the fingerprint taken at the click.
  const [pendingSeen, setPendingSeen] = useState(false);
  if (pending !== pendingSeen) {
    setPendingSeen(pending);
    if (pendingSeen && !pending && cycle !== null) {
      const outcome = refreshOutcome(
        cycle.before,
        pageSignature(newestPublished, knownIds),
        cycle.attempt,
      );
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
      now: readClock,
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (handle) => window.clearTimeout(handle as number),
    });
  }, []);

  // The one automatic retry. It only arms a timer; its setState calls run in the
  // timer callbacks, not in the effect body. The wait is a deadline pinned for
  // this outcome (seq), so an <Activity> reveal re-arms only the time that is
  // left; if it already passed while hidden the retry is dropped (the cycle is
  // cleared, nothing refreshes). Cleared on unmount and when the status leaves
  // "retrying", so it can never fire into a gone component.
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

  // After the refresh settles the button is gone; give focus back to the region
  // if it fell to <body>, then retire the status text. Never steals focus from a
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

  const count = hit !== null && hit.newest === newestPublished ? hit.count : 0;
  const showButton = busy || (count > 0 && settled.kind !== "unchanged");

  return (
    <div
      ref={regionRef}
      role="status"
      aria-live="polite"
      tabIndex={-1}
      className="absolute inset-x-0 top-full flex h-8 items-center justify-center focus-visible:outline-none"
    >
      {showButton ? (
        <button
          type="button"
          aria-disabled={busy}
          onClick={() => {
            if (busy) return;
            deadline.current = null;
            setCycle({ before: pageSignature(newestPublished, knownIds), attempt: 0 });
            setSettled((s) => ({ kind: "none", seq: s.seq }));
            startTransition(() => {
              router.refresh();
            });
          }}
          className="inline-flex min-h-8 items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-60"
        >
          {busy ? "Yenileniyor…" : `${newClustersLabel(count)} · Yenile`}
        </button>
      ) : settled.kind === "unchanged" ? (
        <p className="text-xs text-muted-foreground">Liste henüz güncellenmedi, tekrar deneyin</p>
      ) : settled.kind === "updated" ? (
        <p className="text-xs text-muted-foreground">Liste güncellendi</p>
      ) : null}
    </div>
  );
}
