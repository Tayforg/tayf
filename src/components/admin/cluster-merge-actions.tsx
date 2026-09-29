"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import type { MergeClusterRef, MergeQueueOrigin } from "@/lib/admin/merge-queue";

/**
 * Controls for one /admin/birlestir row: Birleştir (POST action "merge"),
 * Yönü değiştir (swap which side is the target, client state only) and
 * Farklı hikaye (POST action "dismiss": only hides the pair from this queue,
 * story_thread_candidates is untouched). Modeled on story-threads-actions.tsx:
 * the server's response text is never shown, only the fixed Turkish lines.
 */

const GENERIC_ERROR = "İşlem başarısız, tekrar deneyin.";
const CONFLICT_ERROR = "Kümelerden biri zaten birleştirilmiş veya arşivlenmiş; sayfayı yenileyin.";
const CONFIRM_TEXT = "Bu iki küme birleştirilsin mi? Taşınan küme arşivlenir, bağlantısı hedefe yönlenir.";
const ENDPOINT = "/api/admin/cluster-merge";

const BTN = "h-9 sm:h-7 px-3 text-xs";

function useAdminPost() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function post(body: unknown) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          setError(res.status === 409 ? CONFLICT_ERROR : GENERIC_ERROR);
          return;
        }
        router.refresh();
      } catch {
        setError(GENERIC_ERROR);
      }
    });
  }

  return { isPending, error, post };
}

export function ClusterMergeActions({
  a,
  b,
  defaultTargetId,
  origin,
}: {
  a: MergeClusterRef;
  b: MergeClusterRef;
  defaultTargetId: string;
  origin: MergeQueueOrigin;
}) {
  const { isPending, error, post } = useAdminPost();
  const [targetId, setTargetId] = useState(defaultTargetId);

  const target = targetId === a.id ? a : b;
  const source = target === a ? b : a;

  function merge() {
    if (!window.confirm(CONFIRM_TEXT)) return;
    post({ action: "merge", source: source.id, target: target.id, origin });
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        <span className="block">Hedef: {target.title}</span>
        <span className="block">Taşınacak: {source.title}</span>
      </p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" className={BTN} disabled={isPending} onClick={merge}>
          Birleştir
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className={BTN}
          disabled={isPending}
          onClick={() => setTargetId(source.id)}
        >
          Yönü değiştir
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={`${BTN} text-destructive/60 hover:text-destructive`}
          disabled={isPending}
          onClick={() => post({ action: "dismiss", a: a.id, b: b.id, origin })}
        >
          Farklı hikaye
        </Button>
      </div>
    </div>
  );
}
