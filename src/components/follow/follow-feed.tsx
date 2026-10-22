"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { X } from "lucide-react";

import { followsStore, useFollows } from "@/components/follow/use-follows";
import {
  countNew,
  FOLLOW_ITEMS_MAX,
  followApiPath,
  followEmptyText,
  followHref,
  followKey,
  followLabel,
  followListCaption,
  MAX_FOLLOWS,
  parseFollowItems,
  parseFollowKey,
  runWithConcurrency,
  type Follow,
  type FollowItem,
} from "@/lib/follows/follows";
import { formatTurkishTimeAgo } from "@/lib/time";

// Client half of /takip. For every followed keyword / topic it asks
// GET /api/takip (max 3 requests in flight) and lists what matches. A topic
// follow lists the newest stories of the last 7 days; a keyword follow lists
// the most-corroborated matches the search returned, newest first (the search
// has no date window, so the copy never promises "the latest"). "yeni" counts
// come from a snapshot of each follow's seenAt taken BEFORE the visit marks
// them seen, so the badges stay on screen for this visit and are gone on the
// next one. For a keyword follow "yeni" is a lower bound: a fresh story the
// search did not return cannot be counted.

const FETCH_CONCURRENCY = 3;
const ROWS_PER_FOLLOW = 5;

type FeedState =
  | { status: "ok"; items: FollowItem[] }
  | { status: "error"; reason: "rate" | "down" };

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

export function FollowFeed() {
  const { follows, remove, count } = useFollows();
  const hydrated = useHydrated();

  const [results, setResults] = useState<Record<string, FeedState>>({});
  const [seenSnapshot, setSeenSnapshot] = useState<Record<string, string | null>>({});
  // Keys whose latest fetch succeeded in this visit; lets a re-run (a follow
  // added or removed while the page is open) skip what is already loaded.
  const loadedKeys = useRef<Set<string>>(new Set());

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
    // effect's only input is the string it is keyed on.
    const list = keysSignature === "" ? [] : keysSignature.split("\n");
    const wanted = list.flatMap((key) => {
      const parsed = parseFollowKey(key);
      return parsed === null ? [] : [{ key, ...parsed }];
    });
    const live = new Set(wanted.map((w) => w.key));
    for (const key of [...loadedKeys.current]) {
      if (!live.has(key)) loadedKeys.current.delete(key);
    }

    const todo = wanted.filter((w) => !loadedKeys.current.has(w.key));
    if (todo.length === 0) return;

    const controller = new AbortController();
    void (async () => {
      await runWithConcurrency(todo, FETCH_CONCURRENCY, async (item) => {
        const outcome = await fetchFollowState(item, controller.signal);
        if (controller.signal.aborted) return;
        if (outcome.status === "ok") loadedKeys.current.add(item.key);
        setResults((prev) => ({ ...prev, [item.key]: outcome }));
      });
      if (controller.signal.aborted) return;
      const seen = new Set(
        wanted.map((w) => w.key).filter((key) => loadedKeys.current.has(key)),
      );
      followsStore.markSeen(seen, new Date().toISOString());
    })();

    return () => controller.abort();
  }, [keysSignature]);

  if (!hydrated) {
    return (
      <div
        aria-busy="true"
        className="h-24 animate-pulse rounded-xl bg-card/60 ring-1 ring-border/60"
      />
    );
  }

  if (count === 0) return <EmptyState />;

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{`${count}/${MAX_FOLLOWS} takip`}</p>
      {follows.map((follow) => {
        const key = followKey(follow);
        return (
          <FollowSection
            key={key}
            follow={follow}
            state={results[key]}
            seenAt={seenSnapshot[key] ?? null}
            onRemove={() => remove(key)}
          />
        );
      })}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-8 text-center space-y-4 animate-fade-up">
      {/* Mini spectrum bar — mirrors the header logo mark */}
      <div className="flex items-center justify-center gap-1">
        <div className="h-4 w-1.5 rounded-full bg-red-500/70" />
        <div className="h-4 w-1.5 rounded-full bg-brand/80" />
        <div className="h-4 w-1.5 rounded-full bg-emerald-500/70" />
      </div>
      <h2 className="font-serif text-lg font-semibold tracking-tight">
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

function FollowSection({
  follow,
  state,
  seenAt,
  onRemove,
}: {
  follow: Follow;
  state: FeedState | undefined;
  seenAt: string | null;
  onRemove: () => void;
}) {
  const badge = newBadgeLabel(state, seenAt);

  return (
    <section className="rounded-xl border border-border/60 bg-card/40 p-4">
      <div className="flex items-center gap-2">
        <h2 className="min-w-0 break-words font-serif text-base font-semibold tracking-tight">
          {followLabel(follow)}
        </h2>
        {badge !== null && (
          <span className="shrink-0 rounded-full bg-brand/15 border border-brand/30 px-2 py-0.5 text-[10px] font-semibold text-brand">
            {badge}
          </span>
        )}
        <Link
          href={followHref(follow)}
          className="ml-auto shrink-0 text-[11px] text-muted-foreground underline decoration-dotted underline-offset-2 hover:text-foreground"
        >
          Tümü
        </Link>
        <button
          type="button"
          onClick={onRemove}
          aria-label="Takibi bırak"
          className="shrink-0 rounded-full p-1 text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </button>
      </div>

      <div className="mt-2">
        <SectionBody kind={follow.kind} state={state} />
      </div>
    </section>
  );
}

function SectionBody({
  kind,
  state,
}: {
  kind: Follow["kind"];
  state: FeedState | undefined;
}) {
  if (state === undefined) {
    return (
      <div aria-busy="true" className="space-y-2">
        <div className="h-10 animate-pulse rounded-lg bg-card/60" />
        <div className="h-10 animate-pulse rounded-lg bg-card/60" />
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <p className="text-sm text-muted-foreground">
        {state.reason === "rate"
          ? "Çok sık yenilendi, biraz sonra tekrar deneyin."
          : "Şu an yüklenemedi."}
      </p>
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
                <span>{`${item.sourceCount} kaynak · ${formatTurkishTimeAgo(item.updatedAt)} · ${item.zoneLine}`}</span>
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
