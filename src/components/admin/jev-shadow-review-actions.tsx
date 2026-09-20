"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * Admin review controls for one Jev-shadow disagreement row. Modelled on
 * corrections-actions.tsx: POSTs to /api/admin/jev-shadow/review
 * (admin-session gated server-side — this component has no auth logic of
 * its own) and refreshes the server component queue on success. Errors
 * never surface the server's response text — just a generic Turkish retry
 * message — since that body could echo back request details we don't want
 * rendered verbatim.
 */

const JEV_VERDICT_BUTTONS = [
  { verdict: "jev", label: "Jev haklı" },
  { verdict: "baseline", label: "Sistem haklı" },
  { verdict: "both", label: "İkisi de" },
  { verdict: "neither", label: "Hiçbiri" },
  { verdict: "unsure", label: "Emin değilim" },
] as const;

export function JevReviewActions({ id }: { id: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function handleVerdict(verdict: string) {
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-shadow/review", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prediction_id: id, verdict }),
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
    <div className="mt-1 flex flex-col gap-1">
      <div className="flex flex-wrap gap-1.5">
        {JEV_VERDICT_BUTTONS.map(({ verdict, label }) => (
          <Button
            key={verdict}
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={isPending}
            onClick={() => handleVerdict(verdict)}
          >
            {label}
          </Button>
        ))}
      </div>
      {error && (
        <p className="text-[11px] text-destructive">
          İşlem başarısız, tekrar deneyin.
        </p>
      )}
    </div>
  );
}
