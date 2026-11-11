"use client";

import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { followsStore, useFollows } from "@/components/follow/use-follows";
import { useHydrated } from "@/lib/hooks/use-hydrated";
import {
  countNew,
  focusTargetAfterRemove,
  FOLLOW_ITEMS_MAX,
  followApiPath,
  followEmptyText,
  followHref,
  followKey,
  followLabel,
  followListCaption,
  followRowMeta,
  followRowsToShow,
  MAX_FOLLOWS,
  NO_BASELINE,
  parseFollowItems,
  parseFollowKey,
  rowsShown,
  runWithConcurrency,
  type Follow,
  type FollowItem,
  type FollowKind,
  type SeenBaseline,
  type SeenRows,
} from "@/lib/follows/follows";

// Client half of /takip. For every followed keyword / topic / gündem hub it
// asks GET /api/takip (max 3 requests in flight) and lists what matches. A
// topic follow lists the newest stories of the last 7 days and a hub follow the
// newest of the hub page's own list (the same matcher as /gundem/<key>); a
// keyword follow lists the most-corroborated matches the search returned,
// newest first (the search has no date window, so the copy never promises
// "the latest"). "yeni" counts come from a snapshot of each follow's baseline
// (seenAt, plus the ids and oldest first_published of the rows its last visit
// rendered) taken BEFORE the visit marks them seen, so the badges stay on screen
// for this visit and are gone on the next one. A story is "yeni" when the last
// visit did not show it and it is newer than the oldest story that visit showed
// (isNewItem): that also counts a story that became listed after the visit
// although it was first published before it. For a keyword follow "yeni" is a
// lower bound: a fresh story the search did not return cannot be counted.
//
// A list shows ROWS_PER_FOLLOW rows by default but grows to the last "yeni"
// story (followRowsToShow), so the badge counts only rows on screen and the
// markSeen at the end of the visit consumes only stories the reader was shown:
// it stores exactly the rows rendered (rowsShown).
//
// Accessibility: ONE polite live region (FeedFrame) is mounted in every state
// -- placeholder, empty and list -- so it never remounts and a removal can be
// announced. Unfollowing moves focus to the neighbouring follow's heading (or
// the empty state's) instead of dropping it on <body>. A failed follow offers
// a retry that re-fetches only that follow, and the same region then announces
// how the retry ended (loaded with N stories, nothing matched, or failed). An
// initial load that fails is announced once a batch settles; a successful
// initial load stays silent. The failures wait in a ledger (a ref, so it outlives
// a batch): a batch that is aborted after a failure (an unfollow, another tab
// changing the store, a retry of a different follow) leaves the failure in the
// ledger, because the failed key is skipped by every later run and would never be
// reported again. The next batch that settles speaks it, together with the retry
// outcome it carries, and a run with nothing left to fetch drains it from a
// deferred callback.

const FETCH_CONCURRENCY = 3;
const ROWS_PER_FOLLOW = 5;

type FeedState =
  | { status: "ok"; items: FollowItem[] }
  | { status: "error"; reason: "rate" | "down" };

// What the polite region says once a RETRY's fetch has landed (WCAG 4.1.3).
// The count is the rows actually shown: ROWS_PER_FOLLOW, or more when the list
// grew to cover every "yeni" story (followRowsToShow with the follow's baseline
// snapshot; a bare seenAt string or null is the legacy seenAt-only baseline).
// The empty case mirrors the visible followEmptyText: an empty list means
// "nothing matched", not "no new news".
export function retryResultAnnouncement(
  label: string,
  state: FeedState,
  baseline: SeenBaseline | string | null,
): string {
  if (state.status === "ok") {
    return state.items.length === 0
      ? `${label} yüklendi · eşleşen hikâye yok`
      : `${label} yüklendi · ${followRowsToShow(state.items, baseline, ROWS_PER_FOLLOW)} hikâye`;
  }
  return state.reason === "rate"
    ? `${label}: çok sık yenilendi, biraz sonra tekrar deneyin`
    : `${label} şu an yüklenemedi`;
}

// What the polite region says once a batch of INITIAL fetches has settled and
// some follows ended in error (WCAG 4.1.3: the error UI appears on screen, so
// it must also reach a screen reader). Nothing failed = nothing to say, so a
// successful load stays silent. One failure names the follow; several only
// count them, because a page can hold up to MAX_FOLLOWS and reading every
// label out would bury the message.
export function initialFailureAnnouncement(labels: string[]): string {
  if (labels.length === 0) return "";
  if (labels.length === 1) return `${labels[0]} yüklenemedi`;
  return `${labels.length} takip yüklenemedi`;
}

// The initial failures nobody has heard yet, key -> label in failure order. A
// pure bookkeeping object so the cases that matter (an aborted batch, an
// unfollow, a retry) can be tested without a browser; the component keeps one in
// a ref.
export interface FailureLedger {
  /** Remembers a failure. A later failure of the same key replaces the label and keeps its place. */
  record(key: string, label: string): void;
  /** Forgets every key that is not in `liveKeys` (its follow was removed). */
  prune(liveKeys: ReadonlySet<string>): void;
  /** Forgets one key (its retry outcome is announced instead). */
  forget(key: string): void;
  /** How many failures are waiting. */
  size(): number;
  /** The waiting labels, in failure order; the ledger is empty afterwards. */
  drain(): string[];
}

export function createFailureLedger(): FailureLedger {
  const waiting = new Map<string, string>();
  return {
    record(key, label) {
      waiting.set(key, label);
    },
    prune(liveKeys) {
      for (const key of [...waiting.keys()]) {
        if (!liveKeys.has(key)) waiting.delete(key);
      }
    },
    forget(key) {
      waiting.delete(key);
    },
    size() {
      return waiting.size;
    },
    drain() {
      const labels = [...waiting.values()];
      waiting.clear();
      return labels;
    },
  };
}

// What the fetch effect is keyed on: one line per follow, "<key>\t<value>". The
// key alone cannot rebuild the request: a keyword's key is its identity ('q:imf'
// for 'IMF', 'q:secim' for 'seçim'), and the search must run with the display
// value the reader sees. Tab and newline cannot occur in a value (whitespace is
// collapsed when a keyword is stored). seenAt, seenIds and seenFloor are left
// out on purpose: markSeen rewrites them on every visit and must not refetch.
export function followsSignature(follows: ReadonlyArray<Pick<Follow, "kind" | "value">>): string {
  return follows.map((f) => `${followKey(f)}\t${f.value}`).join("\n");
}

/** Inverse of followsSignature; a line that is not a valid follow key is dropped. */
export function followsFromSignature(
  signature: string,
): Array<{ key: string; kind: FollowKind; value: string }> {
  if (signature === "") return [];
  return signature.split("\n").flatMap((line) => {
    const tab = line.indexOf("\t");
    const key = tab < 0 ? "" : line.slice(0, tab);
    const parsed = tab < 0 ? null : parseFollowKey(key);
    return parsed === null ? [] : [{ key, kind: parsed.kind, value: line.slice(tab + 1) }];
  });
}

async function fetchFollowState(
  follow: Pick<Follow, "kind" | "value">,
  signal: AbortSignal,
): Promise<FeedState> {
  try {
    const res = await fetch(followApiPath(follow), {
      signal,
      headers: { Accept: "application/json" },
    });
    if (res.status === 429) return { status: "error", reason: "rate" };
    if (!res.ok) return { status: "error", reason: "down" };
    const items = parseFollowItems(await res.json());
    return items === null
      ? { status: "error", reason: "down" }
      : { status: "ok", items };
  } catch {
    // Network failure, bad JSON or an abort (the caller discards aborted runs).
    return { status: "error", reason: "down" };
  }
}

// The one live region of the page. FollowFeed always returns this frame, so
// the region is mounted before anything is announced and survives every state
// change (a region inserted together with its text is usually not announced).
export function FeedFrame({
  announcement,
  children,
}: {
  announcement: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-4">
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {children}
    </div>
  );
}

export function FollowFeed() {
  const { follows, remove, count } = useFollows();
  const hydrated = useHydrated();

  const [results, setResults] = useState<Record<string, FeedState>>({});
  const [seenSnapshot, setSeenSnapshot] = useState<Record<string, SeenBaseline>>({});
  // Mirrors seenSnapshot (updated in an effect after every commit) for the fetch
  // effect below, which must read the current per-key baseline when a fetch
  // lands but must NOT list seenSnapshot as a dependency: it is keyed on the
  // set of follows and the retry nonce only, or every snapshot change would
  // refetch.
  const seenSnapshotRef = useRef<Record<string, SeenBaseline>>({});
  const [announcement, setAnnouncement] = useState("");
  // Bumped by a retry so the fetch effect re-runs without the follow set changing.
  const [retryNonce, setRetryNonce] = useState(0);
  // Keys whose latest fetch succeeded in this visit; lets a re-run (a follow
  // added or removed while the page is open) skip what is already loaded.
  const loadedKeys = useRef<Set<string>>(new Set());
  // Keys whose latest fetch FAILED. A re-run does not fetch them again (that
  // would hammer a failing endpoint every time any follow changes); only the
  // reader's explicit "Tekrar dene" takes a key out of here.
  const erroredKeys = useRef<Set<string>>(new Set());
  // key -> the rows this visit rendered for a loaded follow (their ids and the
  // oldest first_published). What markSeen stores, so the next visit judges
  // "yeni" against what the reader was shown, not against the whole response.
  const shownRows = useRef<Map<string, SeenRows>>(new Map());
  // key -> label of a follow whose retry result must be announced. Only
  // "Tekrar dene" puts a key here; an initial load that FAILS goes into the
  // ledger below instead, and a successful initial load stays silent. An aborted
  // run leaves the entry in place; the re-run fetches the key again and
  // announces then.
  const retryPending = useRef<Map<string, string>>(new Map());
  // Initial failures not yet announced. They live here, not in the batch, so a
  // batch that is aborted after a failure does not lose it: the failed key is
  // already in erroredKeys, so the re-run skips it. Settled batches (and a re-run
  // with nothing to fetch) drain it; an unfollow prunes it and a retry forgets
  // that follow's entry.
  const unannouncedFailures = useRef(createFailureLedger());

  // Focus handoff after an unfollow. `pendingFocus` is written by the click
  // handler (undefined = nothing pending, null = the list is now empty) and
  // consumed by the effect below once the new list has committed.
  const headingRefs = useRef<Map<string, HTMLHeadingElement>>(new Map());
  const emptyHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);

  // The effect is keyed on the SET of follows, not on the objects: markSeen
  // rewrites seenAt (and the seen ids) on every entry, which must not trigger a
  // refetch.
  const keysSignature = followsSignature(follows);

  // Snapshot of each follow's baseline, taken the first render a follow is seen
  // in this visit (always before the fetches below can mark it seen). A
  // follow keeps its first snapshot for the whole visit; one that was removed
  // and re-added gets a fresh one. Adjusted during render (React's "derive
  // state from props/state" pattern) rather than in an effect, so there is no
  // extra commit and the badge data is in place before the first fetch lands.
  const snapshotInSync =
    Object.keys(seenSnapshot).length === follows.length &&
    follows.every((f) => followKey(f) in seenSnapshot);
  if (!snapshotInSync) {
    const next: Record<string, SeenBaseline> = {};
    for (const f of follows) {
      const key = followKey(f);
      next[key] = seenSnapshot[key] ?? {
        seenAt: f.seenAt,
        seenIds: f.seenIds,
        seenFloor: f.seenFloor,
      };
    }
    setSeenSnapshot(next);
  }

  useEffect(() => {
    // Rebuilt from the signature (not from the render's `follows`) so the
    // effect's only inputs are the string it is keyed on and the retry nonce.
    const wanted = followsFromSignature(keysSignature);
    const live = new Set(wanted.map((w) => w.key));
    for (const key of [...loadedKeys.current]) {
      if (!live.has(key)) loadedKeys.current.delete(key);
    }
    for (const key of [...erroredKeys.current]) {
      if (!live.has(key)) erroredKeys.current.delete(key);
    }
    for (const key of [...retryPending.current.keys()]) {
      if (!live.has(key)) retryPending.current.delete(key);
    }
    for (const key of [...shownRows.current.keys()]) {
      if (!live.has(key)) shownRows.current.delete(key);
    }
    unannouncedFailures.current.prune(live);

    // Everything that is neither loaded nor failed: new follows, plus any
    // fetch an earlier run of this effect aborted while it was in flight.
    const todo = wanted.filter(
      (w) => !loadedKeys.current.has(w.key) && !erroredKeys.current.has(w.key),
    );
    // Speaks the failures waiting in the ledger, after `lead` (the retry outcome
    // of this batch, if any) as ONE string: two setAnnouncement calls in a tick
    // collapse to the last, so a second call would swallow the first. Only ever
    // called from a callback, never synchronously in the effect body.
    const announceUnannounced = (lead: string) => {
      const failureText = initialFailureAnnouncement(unannouncedFailures.current.drain());
      if (failureText === "") return;
      setAnnouncement(lead === "" ? failureText : `${lead} ${failureText}`);
    };

    if (todo.length === 0) {
      // Nothing to fetch, but an earlier batch may have been aborted after a
      // failure that nobody has heard. Deferred, a synchronous setState in an
      // effect body is a react-hooks/set-state-in-effect error.
      if (unannouncedFailures.current.size() > 0) {
        const timer = setTimeout(() => announceUnannounced(""), 0);
        return () => clearTimeout(timer);
      }
      return;
    }

    const controller = new AbortController();
    // The retry outcome announced in this batch; the summary below appends the
    // initial failures to it.
    let retryText = "";
    void (async () => {
      await runWithConcurrency(todo, FETCH_CONCURRENCY, async (item) => {
        const outcome = await fetchFollowState(item, controller.signal);
        if (controller.signal.aborted) return;
        // This visit's baseline for the follow, the one its section renders with.
        const baseline = seenSnapshotRef.current[item.key] ?? NO_BASELINE;
        if (outcome.status === "ok") {
          loadedKeys.current.add(item.key);
          erroredKeys.current.delete(item.key);
          shownRows.current.set(item.key, rowsShown(outcome.items, baseline, ROWS_PER_FOLLOW));
        } else {
          erroredKeys.current.add(item.key);
        }
        setResults((prev) => ({ ...prev, [item.key]: outcome }));
        const label = retryPending.current.get(item.key);
        if (label !== undefined) {
          retryPending.current.delete(item.key);
          retryText = retryResultAnnouncement(label, outcome, baseline);
          setAnnouncement(retryText);
        } else if (outcome.status === "error") {
          unannouncedFailures.current.record(item.key, followLabel(item));
        }
      });
      if (controller.signal.aborted) return;
      // One announcement per settled batch, through the same region: every
      // failure still waiting (also those of a batch that was aborted), after the
      // retry outcome the reader just asked for.
      announceUnannounced(retryText);
      // Every loaded follow is marked seen with the rows rendered for it.
      const shown = new Map<string, SeenRows>();
      for (const w of wanted) {
        const rows = shownRows.current.get(w.key);
        if (loadedKeys.current.has(w.key) && rows !== undefined) shown.set(w.key, rows);
      }
      followsStore.markSeen(shown, new Date().toISOString());
    })();

    return () => controller.abort();
  }, [keysSignature, retryNonce]);

  // Declared after the fetch effect on purpose: the fetches settle in later
  // tasks, long after this commit's effects have all run, so the ref is current
  // whenever a retry result reads it.
  useEffect(() => {
    seenSnapshotRef.current = seenSnapshot;
  });

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === undefined) return;
    pendingFocus.current = undefined;
    const heading =
      target === null ? emptyHeadingRef.current : headingRefs.current.get(target);
    heading?.focus();
  }, [keysSignature]);

  function handleRemove(follow: Follow) {
    const key = followKey(follow);
    pendingFocus.current = focusTargetAfterRemove(follows.map(followKey), key);
    setAnnouncement(`${followLabel(follow)} takibi bırakıldı`);
    remove(key);
  }

  function handleRetry(follow: Follow) {
    const key = followKey(follow);
    erroredKeys.current.delete(key);
    // This follow's retry outcome is announced instead of its earlier failure.
    unannouncedFailures.current.forget(key);
    // Registered before the nonce bump, so the re-run's fetch finds it.
    retryPending.current.set(key, followLabel(follow));
    // Back to the skeleton until the new answer lands.
    setResults((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setAnnouncement(`${followLabel(follow)} yeniden yükleniyor`);
    // The retry button is about to unmount; keep the reader's place.
    headingRefs.current.get(key)?.focus();
    setRetryNonce((n) => n + 1);
  }

  let body: ReactNode;
  if (!hydrated) {
    body = (
      <div
        aria-busy="true"
        className="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60"
      />
    );
  } else if (count === 0) {
    body = <EmptyState headingRef={emptyHeadingRef} />;
  } else {
    body = (
      <>
        <p className="text-xs text-muted-foreground">{`${count}/${MAX_FOLLOWS} takip`}</p>
        {follows.map((follow) => {
          const key = followKey(follow);
          const baseline = seenSnapshot[key] ?? NO_BASELINE;
          return (
            <FollowSection
              key={key}
              follow={follow}
              state={results[key]}
              seenAt={baseline.seenAt}
              seenIds={baseline.seenIds}
              seenFloor={baseline.seenFloor}
              onRemove={() => handleRemove(follow)}
              onRetry={() => handleRetry(follow)}
              headingRef={(el) => {
                if (el) headingRefs.current.set(key, el);
                else headingRefs.current.delete(key);
              }}
            />
          );
        })}
      </>
    );
  }

  return <FeedFrame announcement={announcement}>{body}</FeedFrame>;
}

export function EmptyState({
  headingRef,
}: {
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-8 text-center space-y-4 animate-fade-up">
      {/* Mini spectrum bar — mirrors the header logo mark */}
      <div className="flex items-center justify-center gap-1">
        <div className="h-4 w-1.5 rounded-full bg-red-500/70" />
        <div className="h-4 w-1.5 rounded-full bg-brand/80" />
        <div className="h-4 w-1.5 rounded-full bg-emerald-500/70" />
      </div>
      {/* tabIndex -1: focusable by script only, so unfollowing the last item
          can hand focus here instead of dropping it on <body>. */}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="rounded-sm font-serif text-lg font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Henüz bir şey takip etmiyorsunuz
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Bir konu ya da gündem sayfasında veya aramada “Takip et”e dokunun.
      </p>
      <p className="text-sm">
        <Link
          href="/konu"
          className="inline-flex max-sm:min-h-11 items-center touch-manipulation underline decoration-dotted underline-offset-2 hover:text-primary"
        >
          Konulara göz at
        </Link>
        {" · "}
        <Link
          href="/"
          className="inline-flex max-sm:min-h-11 items-center touch-manipulation underline decoration-dotted underline-offset-2 hover:text-primary"
        >
          Ana sayfada ara
        </Link>
      </p>
    </div>
  );
}

function newBadgeLabel(state: FeedState | undefined, baseline: SeenBaseline): string | null {
  if (state?.status !== "ok") return null;
  // Counts every "yeni" item of the response, and that is exactly the rows on
  // screen: SectionBody renders followRowsToShow() rows, which always reach the
  // last new item. Keep the two on the same countNew rule.
  const n = countNew(state.items, baseline);
  if (n === 0) return null;
  // The API caps a follow at FOLLOW_ITEMS_MAX items, so "all of them are new"
  // at the cap means "at least that many".
  return n === state.items.length && state.items.length === FOLLOW_ITEMS_MAX
    ? `${FOLLOW_ITEMS_MAX}+ yeni`
    : `${n} yeni`;
}

export function FollowSection({
  follow,
  state,
  seenAt,
  seenIds = null,
  seenFloor = null,
  onRemove,
  onRetry,
  headingRef,
}: {
  follow: Follow;
  state: FeedState | undefined;
  /** The follow's baseline for this visit: when it was last seen... */
  seenAt: string | null;
  /** ...which stories that visit rendered, and the oldest of them (null = legacy: seenAt rule). */
  seenIds?: readonly string[] | null;
  seenFloor?: string | null;
  onRemove: () => void;
  onRetry?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const badge = newBadgeLabel(state, { seenAt, seenIds, seenFloor });
  // Every control names the follow it acts on: a page of 20 follows would
  // otherwise be 20 identical "Tümü" links and 20 identical remove buttons.
  const label = followLabel(follow);

  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <h2
          ref={headingRef}
          tabIndex={-1}
          className="min-w-0 break-words rounded-sm font-serif text-base font-semibold tracking-tight focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {label}
        </h2>
        {badge !== null && (
          <span className="shrink-0 rounded-full bg-brand/15 border border-brand/30 px-2 py-0.5 text-[10px] font-semibold text-brand">
            {badge}
          </span>
        )}
        <Link
          href={followHref(follow)}
          aria-label={`Tümü: ${label}`}
          className="ml-auto inline-flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center px-1 touch-manipulation text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Tümü
        </Link>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`${label} takibini bırak`}
          className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full touch-manipulation text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2">
        <SectionBody
          kind={follow.kind}
          state={state}
          seenAt={seenAt}
          seenIds={seenIds}
          seenFloor={seenFloor}
          label={label}
          onRetry={onRetry}
        />
      </div>
    </section>
  );
}

export function SectionBody({
  kind,
  state,
  seenAt = null,
  seenIds = null,
  seenFloor = null,
  label,
  onRetry,
}: {
  kind: Follow["kind"];
  state: FeedState | undefined;
  /**
   * The follow's baseline snapshot for this visit (seenAt, plus the ids and
   * oldest first_published of the rows its last visit rendered); decides how
   * many rows to show (followRowsToShow). Omitted = no baseline = the default
   * ROWS_PER_FOLLOW.
   */
  seenAt?: string | null;
  seenIds?: readonly string[] | null;
  seenFloor?: string | null;
  /** The follow's label; names the retry button. */
  label?: string;
  onRetry?: () => void;
}) {
  if (state === undefined) {
    // Reserves the default list (caption line + ROWS_PER_FOLLOW rows), the
    // common case. The loaded list can still be shorter (few or no matches, an
    // error) or longer: followRowsToShow extends it up to FOLLOW_ITEMS_MAX rows
    // so every "yeni" story is on screen. That growth is accepted (spec
    // h55-personal-1) so the badge and markSeen match what the reader saw.
    return (
      <div aria-busy="true">
        {kind === "q" && <div className="h-4 px-2" />}
        <div className="space-y-1">
          {Array.from({ length: ROWS_PER_FOLLOW }, (_, i) => (
            <div key={i} className="h-[54px] animate-pulse rounded-lg bg-card/60" />
          ))}
        </div>
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="flex flex-wrap items-center gap-x-3">
        <p className="text-sm text-muted-foreground">
          {state.reason === "rate"
            ? "Çok sık yenilendi, biraz sonra tekrar deneyin."
            : "Şu an yüklenemedi."}
        </p>
        <button
          type="button"
          onClick={onRetry}
          aria-label={label === undefined ? undefined : `Tekrar dene: ${label}`}
          className="inline-flex min-h-[44px] items-center px-1 text-sm underline decoration-dotted underline-offset-2 hover:text-foreground touch-manipulation"
        >
          Tekrar dene
        </button>
      </div>
    );
  }

  if (state.items.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">{followEmptyText(kind)}</p>
    );
  }

  const caption = followListCaption(kind);

  return (
    <>
      {caption !== null && (
        <p className="px-2 text-[11px] text-muted-foreground">{caption}</p>
      )}
      <ul className="space-y-1">
        {state.items.slice(0, followRowsToShow(state.items, { seenAt, seenIds, seenFloor }, ROWS_PER_FOLLOW)).map((item) => (
          <li key={item.id}>
            <Link
              href={`/cluster/${item.id}`}
              className="block rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
            >
              <span
                lang={item.lang}
                className="block font-serif text-sm font-semibold leading-snug text-foreground line-clamp-2"
              >
                {item.title}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{followRowMeta(item)}</span>
                {item.isBlindspot && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-amber-800 dark:text-amber-400 font-medium">
                    Kör nokta
                  </span>
                )}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}
