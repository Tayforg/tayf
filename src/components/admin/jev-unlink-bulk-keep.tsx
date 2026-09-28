"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { fmtPct } from "@/lib/admin/format";

/**
 * Bulk "Kalsın" for obvious keeps (migration 075). Lists only band 'review'
 * rows — the caller (jev-unlink-section.tsx) is responsible for filtering
 * `rows` to that band; this component has no band logic of its own and
 * trusts nothing about server-side enforcement (the route + keepClusterArticles
 * re-check band 'review' regardless of what this component sends).
 *
 * Modelled on jev-unlink-actions.tsx: POSTs to /api/admin/jev-unlink/bulk,
 * never renders the response body, router.refresh() on success.
 */
export function JevUnlinkBulkKeep({
  rows,
}: {
  rows: Array<{ id: number; articleTitle: string; clusterTitle: string; jevProb: number }>;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  if (rows.length === 0) return null;

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSubmit() {
    setError(false);
    const ids = Array.from(selected);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-unlink/bulk", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, decision: "keep" }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        setSelected(new Set());
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  return (
    <details className="rounded-lg border border-dashed border-border p-3">
      <summary className="cursor-pointer text-sm font-medium text-foreground">
        Toplu karar: bariz kalsınlar ({rows.length})
      </summary>
      <div className="mt-3 space-y-2">
        <p className="text-xs text-muted-foreground">
          Yalnızca &apos;inceleme&apos; bandındaki adaylar toplu olarak tutulabilir; &apos;Muhtemelen
          ayrılmalı&apos; olanlar tek tek karar ister.
        </p>
        <ul className="max-h-64 space-y-1 overflow-y-auto text-sm">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start gap-2">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(row.id)}
                onChange={() => toggle(row.id)}
                disabled={isPending}
              />
              <span className="min-w-0">
                <span className="block truncate font-medium text-foreground">{row.articleTitle}</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {row.clusterTitle} · {fmtPct(row.jevProb)}
                </span>
              </span>
            </li>
          ))}
        </ul>
        <Button
          type="button"
          size="sm"
          className="h-9 sm:h-7"
          disabled={selected.size === 0 || isPending}
          onClick={handleSubmit}
        >
          Seçilenler kalsın ({selected.size})
        </Button>
        {error && <p className="text-xs text-destructive">İşlem başarısız, tekrar deneyin.</p>}
      </div>
    </details>
  );
}
