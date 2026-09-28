"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { JEV_ADMISSION_VERDICT_LABELS, type JevAdmissionVerdict } from "@/lib/admin/jev-admission";

/**
 * Admin review controls for one Jev politics-admission claim (migration
 * 089, "ADMIT"). Modelled on jev-shadow-review-actions.tsx: POSTs to
 * /api/admin/jev-admission/review (admin-session gated server-side — this
 * component has no auth logic of its own) and refreshes the server
 * component queue on success. Errors never surface the server's response
 * text — just the generic Turkish retry message "Kaydedilemedi.".
 */

const VERDICT_ORDER: JevAdmissionVerdict[] = [
  "domestic",
  "policy_adjacent",
  "foreign",
  "not_politics",
  "unsure",
];

export function JevAdmissionReviewActions({ articleId }: { articleId: string }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function handleVerdict(verdict: JevAdmissionVerdict) {
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-admission/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ article_id: articleId, verdict }),
        });
        if (!res.ok) {
          setError(true);
          return;
        }
        router.refresh();
      } catch {
        setError(true);
      }
    });
  }

  return (
    <div className="mt-1 flex flex-col gap-1.5">
      <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
        {VERDICT_ORDER.map((verdict) => (
          <Button
            key={verdict}
            variant={verdict === "unsure" ? "ghost" : "outline"}
            size="sm"
            className={
              verdict === "unsure" ? "h-9 col-span-2 px-3 text-xs sm:h-7" : "h-9 px-3 text-xs sm:h-7"
            }
            disabled={isPending}
            onClick={() => handleVerdict(verdict)}
          >
            {JEV_ADMISSION_VERDICT_LABELS[verdict]}
          </Button>
        ))}
      </div>
      {isPending && <p className="text-xs text-muted-foreground">Kaydediliyor…</p>}
      {error && <p className="text-xs text-destructive">Kaydedilemedi.</p>}
    </div>
  );
}
