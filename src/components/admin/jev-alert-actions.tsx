"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * Admin acknowledge control for one Jev-signals alert row. Modelled on
 * src/components/admin/jev-shadow-review-actions.tsx: POSTs to
 * /api/admin/jev-alerts/ack (admin-session gated server-side -- this
 * component has no auth logic of its own) and refreshes the server
 * component alert list on success. Errors never surface the server's
 * response text -- just a generic Turkish retry message -- since that body
 * could echo back request details we don't want rendered verbatim.
 */
export function JevAlertActions({ id }: { id: number }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  function handleAck() {
    setError(false);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-alerts/ack", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id }),
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
      <Button
        variant="outline"
        size="sm"
        className="h-9 px-3 text-xs sm:h-7"
        disabled={isPending}
        onClick={handleAck}
      >
        Onayla
      </Button>
      {error && <p className="text-xs text-destructive">İşlem başarısız, tekrar deneyin.</p>}
    </div>
  );
}
