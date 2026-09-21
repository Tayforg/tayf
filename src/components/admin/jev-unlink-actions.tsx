"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * Admin controls for one "Küme dışı aday" row (migration 064, pack A).
 * Modelled on src/components/admin/jev-shadow-review-actions.tsx: POSTs to
 * /api/admin/jev-unlink (admin-session gated server-side — this component
 * has no auth logic of its own) and refreshes the server component list on
 * success. Errors never surface the server's response text — just a
 * generic Turkish retry message — since that body could echo back request
 * details we don't want rendered verbatim.
 */
export function JevUnlinkActions({ id }: { id: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function handleDecision(decision: "unlink" | "keep") {
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-unlink", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id, decision }),
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
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={isPending}
          onClick={() => handleDecision("unlink")}
        >
          Ayır
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-[11px]"
          disabled={isPending}
          onClick={() => handleDecision("keep")}
        >
          Kalsın
        </Button>
      </div>
      {error && (
        <p className="text-[11px] text-destructive">
          İşlem başarısız, tekrar deneyin.
        </p>
      )}
    </div>
  );
}
