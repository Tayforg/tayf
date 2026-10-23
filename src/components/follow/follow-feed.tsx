"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { followsStore, useFollows } from "@/components/follow/use-follows";
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
  MAX_FOLLOWS,
  parseFollowItems,
  parseFollowKey,
  runWithConcurrency,
  type Follow,
  type FollowItem,
} from "@/lib/follows/follows";

// Client half of /takip. For every followed keyword / topic it asks
// GET /api/takip (max 3 requests in flight) and lists what matches. A topic
// follow lists the newest stories of the last 7 days; a keyword follow lists
// the most-corroborated matches the search returned, newest first (the search
// has no date window, so the copy never promises "the latest"). "yeni" counts
// come from a snapshot of each follow's seenAt taken BEFORE the visit marks
// them seen, so the badges stay on screen for this visit and are gone on the
// next one. For a keyword follow "yeni" is a lower bound: a fresh story the
// search did not return cannot be counted.
//
// Accessibility: ONE polite live region (FeedFrame) is mounted in every state
// -- placeholder, empty and list -- so it never remounts and a removal can be
// announced. Unfollowing moves focus to the neighbouring follow's heading (or
// the empty state's) instead of dropping it on <body>. A failed follow offers
// a retry that re-fetches only that follow, and the same region then announces
// how the retry ended (loaded with N stories, nothing matched, or failed).

const FETCH_CONCURRENCY = 3;
const ROWS_PER_FOLLOW = 5;

type FeedState =
  | { status: "ok"; items: FollowItem[] }
  | { status: "error"; reason: "rate" | "down" };

// What the polite region says once a RETRY's fetch has landed (WCAG 4.1.3).
// The count is the rows actually shown, which is why it is capped at
// ROWS_PER_FOLLOW. The empty case mirrors the visible followEmptyText: an empty
// list means "nothing matched", not "no new news".
export function retryResultAnnouncement(label: string, state: FeedState): string {
  if (state.status === "ok") {
    return state.items.length === 0
      ? `${label} yüklendi · eşleşen hikâye yok`
      : `${label} yüklendi · ${Math.min(state.items.length, ROWS_PER_FOLLOW)} hikâye`;
  }
  return state.reason === "rate"
    ? `${label}: çok sık yenilendi, biraz sonra tekrar deneyin`
    : `${label} şu an yüklenemedi`;
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

const subscribeNever = () => () => {};
// false while server-rendering and during hydration, true afterwards. Lets the
// first paint be a neutral placeholder instead of flashing the empty state at
// every reader who does have follows (the server snapshot is always empty).
function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
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
  const [seenSnapshot, setSeenSnapshot] = useState<Record<string, string | null>>({});
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
  // key -> label of a follow whose retry result must be announced. Only
  // "Tekrar dene" puts a key here, so initial loads stay silent. An aborted
  // run leaves the entry in place; the re-run fetches the key again and
  // announces then.
  const retryPending = useRef<Map<string, string>>(new Map());

  // Focus handoff after an unfollow. `pendingFocus` is written by the click
  // handler (undefined = nothing pending, null = the list is now empty) and
  // consumed by the effect below once the new list has committed.
  const headingRefs = useRef<Map<string, HTMLHeadingElement>>(new Map());
  const emptyHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);

  // The effect is keyed on the SET of follows, not on the objects: markSeen
  // rewrites seenAt on every entry, which must not trigger a refetch.
  const keysSignature = follows.map(followKey).join("\n");

  // Snapshot of each follow's seenAt, taken the first render a follow is seen
  // in this visit (always before the fetches below can mark it seen). A
  // follow keeps its first snapshot for the whole visit; one that was removed
  // and re-added gets a fresh one. Adjusted during render (React's "derive
  // state from props/state" pattern) rather than in an effect, so there is no
  // extra commit and the badge data is in place before the first fetch lands.
  const snapshotInSync =
    Object.keys(seenSnapshot).length === follows.length &&
    follows.every((f) => followKey(f) in seenSnapshot);
  if (!snapshotInSync) {
    const next: Record<string, string | null> = {};
    for (const f of follows) {
      const key = followKey(f);
      next[key] = key in seenSnapshot ? (seenSnapshot[key] ?? null) : f.seenAt;
    }
    setSeenSnapshot(next);
  }

  useEffect(() => {
    // Rebuilt from the signature (not from the render's `follows`) so the
    // effect's only inputs are the string it is keyed on and the retry nonce.
    const list = keysSignature === "" ? [] : keysSignature.split("\n");
    const wanted = list.flatMap((key) => {
      const parsed = parseFollowKey(key);
      return parsed === null ? [] : [{ key, ...parsed }];
    });
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

    // Everything that is neither loaded nor failed: new follows, plus any
    // fetch an earlier run of this effect aborted while it was in flight.
    const todo = wanted.filter(
      (w) => !loadedKeys.current.has(w.key) && !erroredKeys.current.has(w.key),
    );
    if (todo.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      await runWithConcurrency(todo, FETCH_CONCURRENCY, async (item) => {
        const outcome = await fetchFollowState(item, controller.signal);
        if (controller.signal.aborted) return;
        if (outcome.status === "ok") {
          loadedKeys.current.add(item.key);
          erroredKeys.current.delete(item.key);
        } else {
          erroredKeys.current.add(item.key);
        }
        setResults((prev) => ({ ...prev, [item.key]: outcome }));
        const label = retryPending.current.get(item.key);
        if (label !== undefined) {
          retryPending.current.delete(item.key);
          setAnnouncement(retryResultAnnouncement(label, outcome));
        }
      });
      if (controller.signal.aborted) return;
      const seen = new Set(
        wanted.map((w) => w.key).filter((key) => loadedKeys.current.has(key)),
      );
      followsStore.markSeen(seen, new Date().toISOString());
    })();

    return () => controller.abort();
  }, [keysSignature, retryNonce]);

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
          return (
            <FollowSection
              key={key}
              follow={follow}
              state={results[key]}
              seenAt={seenSnapshot[key] ?? null}
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
        Bir konu sayfasında ya da aramada “Takip et”e dokunun.
      </p>
      <p className="text-sm">
        <Link
          href="/konu"
          className="underline decoration-dotted underline-offset-2 hover:text-primary"
        >
          Konulara göz at
        </Link>
        {" · "}
        <Link
          href="/"
          className="underline decoration-dotted underline-offset-2 hover:text-primary"
        >
          Ana sayfada ara
        </Link>
      </p>
    </div>
  );
}

function newBadgeLabel(state: FeedState | undefined, seenAt: string | null): string | null {
  if (state?.status !== "ok") return null;
  const n = countNew(state.items, seenAt);
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
  onRemove,
  onRetry,
  headingRef,
}: {
  follow: Follow;
  state: FeedState | undefined;
  seenAt: string | null;
  onRemove: () => void;
  onRetry?: () => void;
  headingRef?: Ref<HTMLHeadingElement>;
}) {
  const badge = newBadgeLabel(state, seenAt);
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
        <SectionBody kind={follow.kind} state={state} label={label} onRetry={onRetry} />
      </div>
    </section>
  );
}

export function SectionBody({
  kind,
  state,
  label,
  onRetry,
}: {
  kind: Follow["kind"];
  state: FeedState | undefined;
  /** The follow's label; names the retry button. */
  label?: string;
  onRetry?: () => void;
}) {
  if (state === undefined) {
    // Mirrors the loaded list (caption line + ROWS_PER_FOLLOW rows) so the
    // page does not jump when the answer arrives.
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
        {state.items.slice(0, ROWS_PER_FOLLOW).map((item) => (
          <li key={item.id}>
            <Link
              href={`/cluster/${item.id}`}
              className="block rounded-lg px-2 py-2 transition-colors hover:bg-muted/50"
            >
              <span className="block font-serif text-sm font-semibold leading-snug text-foreground line-clamp-2">
                {item.title}
              </span>
              <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
                <span>{followRowMeta(item)}</span>
                {item.isBlindspot && (
                  <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-amber-700 dark:text-amber-500 font-medium">
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
