"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Bookmark, Users, X } from "lucide-react";

import { useBookmarks } from "@/components/bookmark/use-bookmarks";
import { createBrowserClient } from "@/lib/supabase/browser";
import { formatTurkishTimeAgo } from "@/lib/time";

interface SavedRow {
  id: string;
  title_tr: string;
  title_tr_neutral: string | null;
  article_count: number;
  updated_at: string;
}

export function SavedList() {
  const { ids, count, toggle } = useBookmarks();
  const idList = useMemo(() => Array.from(ids), [ids]);

  // null = still loading (or first paint before the effect runs).
  const [rows, setRows] = useState<SavedRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    // Nothing to fetch when empty — the count === 0 branch below renders
    // the empty state without ever consulting `rows`.
    if (idList.length === 0) return;
    let cancelled = false;
    (async () => {
      const { data, error } = await createBrowserClient()
        .from("clusters")
        .select("id, title_tr, title_tr_neutral, article_count, updated_at")
        .in("id", idList)
        .order("updated_at", { ascending: false })
        .returns<SavedRow[]>();
      if (cancelled) return;
      if (error) {
        console.warn("[saved] title lookup error:", error.message);
        setFailed(true);
        setRows([]);
        return;
      }
      setFailed(false);
      setRows(data ?? []);
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
  // simply not rendered; the localStorage entry stays harmless.
  return (
    <ul className="space-y-2">
      {rows.map((row, i) => (
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
            <span className="mt-1.5 flex items-center gap-2 text-[11px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <Users className="h-3 w-3" />
                {row.article_count} kaynak
              </span>
              <span>{formatTurkishTimeAgo(row.updated_at)}</span>
            </span>
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
      ))}
    </ul>
  );
}
