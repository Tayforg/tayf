"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Bookmark, Users, X } from "lucide-react";

import { useBookmarks } from "@/components/bookmark/use-bookmarks";
import { SavedMixCard } from "@/components/bookmark/saved-mix-card";
import { toSavedRowView } from "@/components/bookmark/saved-row";
import {
  changeBadgeLabels,
  pruneSnapshots,
  readSnapshots,
  reconcileSnapshots,
  writeSnapshots,
  type SavedChange,
} from "@/components/bookmark/bookmark-snapshots";
import { BiasSpectrum } from "@/components/story/bias-spectrum";
import { formatTurkishTimeAgo } from "@/lib/time";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// saved_clusters_v2 (migration 124; v1 from 116 has the same caps) truncates its
// input to 200 ids and returns at most 200 rows, so send the newest 200
// bookmarks.
const SAVED_RPC_MAX_IDS = 200;

interface SavedRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  article_count: number;
  bias_distribution: unknown;
  updated_at: string;
  /** Absent on rows from the v1 fallback (migration 124 not applied yet). */
  is_blindspot?: boolean;
}

export function SavedList() {
  const { ids, count, toggle } = useBookmarks();
  const idList = useMemo(() => Array.from(ids), [ids]);

  // null = still loading (or first paint before the effect runs).
  const [rows, setRows] = useState<SavedRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [changes, setChanges] = useState<Record<string, SavedChange>>({});

  useEffect(() => {
    // Nothing to fetch when empty — the count === 0 branch below renders
    // the empty state without ever consulting `rows`.
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
        let res = await client.rpc("saved_clusters_v2", { p_ids: ids });
        // PGRST202 = the function is not in PostgREST's schema cache, i.e.
        // migration 124 is not applied yet. Only then fall back to v1 (no
        // is_blindspot, so no pill); any other error keeps the fail-open path.
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
        const loaded = (data ?? []) as SavedRow[];
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

  if (count === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border/60 bg-card/40 p-8 text-center space-y-4 animate-fade-up">
        {/* Mini spectrum bar — mirrors the header logo mark */}
        <div className="flex items-center justify-center gap-1">
          <div className="h-4 w-1.5 rounded-full bg-red-500/70" />
          <div className="h-4 w-1.5 rounded-full bg-brand/80" />
          <div className="h-4 w-1.5 rounded-full bg-emerald-500/70" />
        </div>
        <h2 className="font-serif text-lg font-semibold tracking-tight">
          Henüz kaydettiğiniz bir hikâye yok
        </h2>
        <p className="text-sm text-muted-foreground max-w-md mx-auto">
          Hikâye kartlarındaki
          <Bookmark className="mx-1 inline h-3.5 w-3.5 align-[-2px]" />
          yer imi simgesine dokunarak
          <span className="text-brand font-medium"> favorilerinizi kaydedin</span>.
        </p>
      </div>
    );
  }

  if (rows === null) {
    // Loading skeleton — one bar per saved id keeps the height stable.
    return (
      <ul className="space-y-2" aria-busy="true">
        {idList.map((id) => (
          <li
            key={id}
            className="h-16 animate-pulse rounded-lg bg-card/60 ring-1 ring-border/60"
          />
        ))}
      </ul>
    );
  }

  if (failed) {
    return (
      <p className="text-sm text-muted-foreground">
        Kaydedilenler yüklenemedi. Lütfen sayfayı yenileyin.
      </p>
    );
  }

  // Bookmarked ids whose cluster no longer exists (pruned upstream) are
  // simply not rendered; the stored id stays harmless.
  const changedCount = rows.filter((r) => changes[r.id]).length;

  return (
    <>
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
        return (
        <li
          key={row.id}
          className={`relative animate-fade-up stagger-${Math.min(i + 1, 8)}`}
        >
          <Link
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
              <span>{formatTurkishTimeAgo(row.updated_at)}</span>
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
            onClick={() => toggle(row.id)}
            aria-label="Kaydedilenlerden çıkar"
            title="Kaydedilenlerden çıkar"
            className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="h-4 w-4" />
          </button>
        </li>
        );
      })}
    </ul>
    </>
  );
}
