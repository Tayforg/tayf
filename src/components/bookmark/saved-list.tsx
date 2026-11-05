"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import Link from "next/link";
import { AlertTriangle, Bookmark, Users, X } from "lucide-react";

import { useBookmarks } from "@/components/bookmark/use-bookmarks";
import { SavedMixCard } from "@/components/bookmark/saved-mix-card";
import { isRpcMissing, savedUpdatedLabel, toPublicSavedRow, toSavedRowView } from "@/components/bookmark/saved-row";
import { savedRemovalAnnouncement, savedRemoveLabel } from "@/components/bookmark/bookmark-label";
import {
  changeBadgeLabels,
  pruneSnapshots,
  readSnapshots,
  reconcileSnapshots,
  writeSnapshots,
  type SavedChange,
} from "@/components/bookmark/bookmark-snapshots";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { focusTargetAfterRemove } from "@/lib/follows/follows";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// saved_clusters_v3 (migration 158; v2 from 124 and v1 from 116 have the same
// caps) truncates its input to 200 ids and returns at most 200 rows, so send the
// newest 200 bookmarks.
const SAVED_RPC_MAX_IDS = 200;

interface SavedRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  article_count: number;
  bias_distribution: unknown;
  updated_at: string;
  /**
   * Absent on rows from the v1 fallback (migration 124 not applied yet). Once the
   * rows have loaded this is the public claim: the flag with the veto (database,
   * migration 138) and the feed-delay wait (toPublicSavedRow) applied.
   */
  is_blindspot?: boolean;
  /**
   * saved_clusters_v3 only (migration 158); absent on rows from the v2 / v1
   * fallback, null when the cluster has none. The wait reads it, nothing renders it.
   */
  first_published?: string | null;
}

// The one live region of the page (WCAG 4.1.3). SavedList returns this frame on
// every path -- empty, loading, failed and list -- so the region is mounted
// before anything is announced and survives every state change (a region
// inserted together with its text is usually not announced).
export function SavedFrame({
  announcement,
  children,
}: {
  announcement: string;
  children: ReactNode;
}) {
  return (
    <div>
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
      {children}
    </div>
  );
}

/** The /saved load failure, announced by the status region and shown on the page. */
export const SAVED_LOAD_FAILED_TEXT = "Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.";

/**
 * The failed state (h30-live-1): the same {@link SavedFrame} as every other
 * state, with the failure copy as its announcement, so a screen reader hears it
 * (WCAG 4.1.3). The visible paragraph is aria-hidden: the sr-only status region
 * above it carries the text for assistive technology, once.
 *
 * SavedList returns this by calling it (`return SavedLoadFailed()`), not as
 * `<SavedLoadFailed />`: the result is then an element of type SavedFrame, the
 * type the loading branch returns, so React updates the mounted region in place
 * and the announcement fires. A `<SavedLoadFailed />` element is a different
 * component type, which would unmount the region and mount a new one with the
 * text already in it, which is usually not announced. No hooks: it is safe to
 * call.
 */
export function SavedLoadFailed() {
  return (
    <SavedFrame announcement={SAVED_LOAD_FAILED_TEXT}>
      <p aria-hidden="true" className="text-sm text-muted-foreground">
        {SAVED_LOAD_FAILED_TEXT}
      </p>
    </SavedFrame>
  );
}

export function SavedEmptyState({
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
      {/* tabIndex -1: focusable by script only, so removing the last story can
          hand focus here instead of dropping it on the document body. */}
      <h2
        ref={headingRef}
        tabIndex={-1}
        className="font-serif text-lg font-semibold tracking-tight outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
      >
        Henüz kaydettiğiniz bir hikâye yok
      </h2>
      <p className="text-sm text-muted-foreground max-w-md mx-auto">
        Hikâye kartlarındaki{" "}
        <Bookmark aria-hidden="true" className="inline h-3.5 w-3.5 align-[-2px]" />{" "}
        yer imi simgesine dokunarak
        <span className="text-brand font-medium"> favorilerinizi kaydedin</span>.
      </p>
    </div>
  );
}

export function SavedList() {
  const { ids, count, toggle } = useBookmarks();
  const idList = useMemo(() => Array.from(ids), [ids]);

  // null = still loading (or first paint before the effect runs).
  const [rows, setRows] = useState<SavedRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [changes, setChanges] = useState<Record<string, SavedChange>>({});
  const [announcement, setAnnouncement] = useState("");

  // Focus handoff after a removal. `pendingFocus` is written by the click
  // handler (undefined = nothing pending, null = the list is now empty) and
  // consumed by the effect below once the new list has committed.
  const linkRefs = useRef(new Map<string, HTMLAnchorElement>());
  const emptyHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const pendingFocus = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    // Nothing to fetch when empty — the empty branch below renders the empty
    // state without ever consulting `rows`.
    if (idList.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        // Set.add appends, so the tail of idList is the newest bookmarks.
        // Malformed ids (hand-edited bookmark storage) cannot match a cluster and
        // would turn the whole uuid[] argument into a 400.
        const ids = idList
          .filter((id) => typeof id === "string" && UUID_RE.test(id))
          .slice(-SAVED_RPC_MAX_IDS);
        if (ids.length === 0) {
          setRows([]);
          setFailed(false);
          return;
        }
        const { createBrowserClient } = await import("@/lib/supabase/browser");
        const client = createBrowserClient();
        let res = await client.rpc("saved_clusters_v3", { p_ids: ids });
        // PGRST202 (not in PostgREST's schema cache) or 42883 (undefined
        // function) = migration 158 is not applied yet. Fall back once to v2:
        // same rows without first_published, so the pill follows the veto only
        // (what /saved showed before 158) until the migration lands.
        if (isRpcMissing(res.error)) {
          res = await client.rpc("saved_clusters_v2", { p_ids: ids });
        }
        // PGRST202 again = migration 124 is not applied either. Only then fall
        // back to v1 (no is_blindspot, so no pill); any other error keeps the
        // fail-open path.
        if (res.error?.code === "PGRST202") {
          res = await client.rpc("saved_clusters", { p_ids: ids });
        }
        const { data, error } = res;
        if (cancelled) return;
        if (error) {
          console.warn("[saved] title lookup error:", error.message);
          setFailed(true);
          setRows([]);
          return;
        }
        // The one clock read of the page, after the rows have loaded and inside
        // the effect (never during a render): the blindspot pill waits
        // BLINDSPOT.feedDelayHours after first_published like every other card.
        // The claim therefore settles when the list is opened; a pill that is
        // still waiting appears on the next visit after the delay.
        const nowMs = Date.now();
        const loaded = ((data ?? []) as SavedRow[]).map((row) => toPublicSavedRow(row, nowMs));
        // Device-local change detection; effect-only (never during render).
        const snaps = readSnapshots();
        const { changes: found, toWrite } = reconcileSnapshots(loaded, snaps, new Date().toISOString());
        if (Object.keys(toWrite).length > 0) writeSnapshots({ ...snaps, ...toWrite });
        pruneSnapshots(idList);
        setChanges(found);
        setFailed(false);
        setRows(loaded);
      } catch (err) {
        if (cancelled) return;
        console.warn("[saved] title lookup error:", err instanceof Error ? err.message : String(err));
        setFailed(true);
        setRows([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [idList]);

  // Also the empty state once the last row has been dropped, while the bookmark
  // store has not caught up yet, so focus always has a target.
  const emptyNow = count === 0 || (rows !== null && !failed && rows.length === 0);

  // What is on screen, as a string: the effect below runs when the rendered
  // rows change, not on every render (and not when only the badges change).
  const shownSig = emptyNow ? "" : rows === null ? "\u0000loading" : rows.map((r) => r.id).join("\n");

  useEffect(() => {
    const target = pendingFocus.current;
    if (target === undefined) return;
    pendingFocus.current = undefined;
    const el = target === null ? emptyHeadingRef.current : linkRefs.current.get(target);
    el?.focus();
  }, [shownSig]);

  function handleRemove(row: SavedRow) {
    const shownIds = (rows ?? []).map((r) => r.id);
    pendingFocus.current = focusTargetAfterRemove(shownIds, row.id);
    setAnnouncement(
      savedRemovalAnnouncement(row.title_tr_neutral ?? row.title_tr, shownIds.length - 1),
    );
    // Drop the row at once, so focus moves now instead of after the lookup
    // re-runs for the shorter bookmark list.
    setRows((prev) => prev?.filter((r) => r.id !== row.id) ?? prev);
    toggle(row.id);
  }

  if (emptyNow) {
    return (
      <SavedFrame announcement={announcement}>
        <SavedEmptyState headingRef={emptyHeadingRef} />
      </SavedFrame>
    );
  }

  if (rows === null) {
    // Loading skeleton — one bar per saved id keeps the height stable.
    return (
      <SavedFrame announcement={announcement}>
        <ul className="space-y-2" aria-busy="true">
          {idList.map((id) => (
            <li
              key={id}
              className="h-16 animate-pulse rounded-lg bg-card/60 ring-1 ring-border/60"
            />
          ))}
        </ul>
      </SavedFrame>
    );
  }

  if (failed) {
    // Announces the failure in the region the loading state already mounted.
    return SavedLoadFailed();
  }

  // Bookmarked ids whose cluster no longer exists (pruned upstream) are
  // simply not rendered; the stored id stays harmless.
  const changedCount = rows.filter((r) => changes[r.id]).length;

  return (
    <SavedFrame announcement={announcement}>
    <SavedMixCard rows={rows} />
    {changedCount > 0 && (
      <p className="mb-3 text-xs text-muted-foreground">
        {changedCount} kayıtlı hikâyede, kaydettiğinizden beri yeni gelişme var.
      </p>
    )}
    <ul className="space-y-2">
      {rows.map((row, i) => {
        const change = changes[row.id];
        const view = toSavedRowView(row);
        // "Son güncelleme: …": the RPC returns updated_at, not first_published.
        const updatedLabel = savedUpdatedLabel(row.updated_at);
        return (
        <li
          key={row.id}
          className={`relative animate-fade-up stagger-${Math.min(i + 1, 8)}`}
        >
          <Link
            ref={(el) => {
              if (el) linkRefs.current.set(row.id, el);
              else linkRefs.current.delete(row.id);
            }}
            href={`/cluster/${row.id}`}
            className="block rounded-lg ring-1 ring-border/60 hover:ring-border bg-card/60 hover:bg-card/80 transition-all p-4 pr-12 hover-lift"
          >
            <span className="block font-serif text-sm sm:text-base font-semibold leading-snug text-foreground line-clamp-2">
              {row.title_tr_neutral ?? row.title_tr}
            </span>
            <span className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" />
                {row.article_count} kaynak
              </span>
              {updatedLabel && (
                <time dateTime={row.updated_at}>{updatedLabel}</time>
              )}
              {view.isBlindspot && (
                <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/15 border border-amber-500/30 px-2 py-0.5 text-amber-800 dark:text-amber-400 font-medium">
                  <AlertTriangle className="h-3 w-3" aria-hidden="true" />
                  Kör nokta
                </span>
              )}
            </span>
            {view.distribution && (
              <div className="mt-2">
                <BiasSpectrum distribution={view.distribution} compact />
              </div>
            )}
            {change && (
              <span className="mt-2 flex flex-wrap gap-1.5">
                {changeBadgeLabels(change).map((label) => (
                  <span
                    key={label}
                    title={change.basis === "save" ? "Kaydettiğinizden beri" : "Bu listeyi ilk açtığınızdan beri"}
                    className="inline-flex items-center rounded-full border border-brand/30 bg-brand/10 px-2 py-0.5 text-[10px] font-medium text-brand"
                  >
                    {label}
                  </span>
                ))}
              </span>
            )}
          </Link>
          {/* Sibling of the Link (not nested) — button-in-anchor is invalid. */}
          <button
            type="button"
            onClick={() => handleRemove(row)}
            aria-label={savedRemoveLabel(row.title_tr_neutral ?? row.title_tr)}
            title="Kaydedilenlerden çıkar"
            className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </li>
        );
      })}
    </ul>
    </SavedFrame>
  );
}
