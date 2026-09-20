"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * The "Etiketleyici: 1 | 2" switch for /admin/jev-altin. Extracted out of
 * jev-gold-labeler.tsx (063, JEV-N2) so it renders on every page render,
 * independent of whether the current labeler has an article left in their
 * queue or the gold set is still empty -- previously it lived inside the
 * `next.article !== null` branch, so once labeler 1 finished their queue
 * (or before the set was first seeded) the switch disappeared and labeler 2
 * could never reach it to start. Double-labeling is the entire purpose of
 * this surface (jev_gold_labels' unique (article_id, labeler), the
 * scorecard's double_labeled block).
 *
 * A real POST to /api/admin/jev-gold/labeler (which sets the httpOnly
 * jev_labeler cookie server-side), never a client-side cookie write — see
 * the shared contract's cookie section: this switch is a UI convenience,
 * not an authorization signal.
 */
export function JevGoldLabelerSwitch({ labeler }: { labeler: 1 | 2 }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleLabelerSwitch(next: 1 | 2) {
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-gold/labeler", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ labeler: next }),
        });
        if (!res.ok) {
          setError("Kaydedilemedi.");
          return;
        }
        router.refresh();
      } catch {
        setError("Kaydedilemedi.");
      }
    });
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1.5 font-mono text-[12px]">
        <span className="text-muted-foreground">Etiketleyici:</span>
        {([1, 2] as const).map((n) => (
          <Button
            key={n}
            variant={labeler === n ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={isPending}
            onClick={() => handleLabelerSwitch(n)}
          >
            {n}
          </Button>
        ))}
      </div>
      {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
