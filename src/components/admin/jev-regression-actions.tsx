"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * Two buttons for the "Metodoloji regresyonu" section (migration 066,
 * pack B2): "Seti dondur" (POSTs /api/admin/jev-regression/freeze) and
 * "Regresyonu çalıştır" (POSTs /api/admin/jev-regression/run), both
 * admin-session gated server-side. Modelled on
 * src/components/admin/jev-gold-seed-button.tsx: never surfaces the
 * server's response text, just a generic Turkish result message. The two
 * actions share one `isPending` and one `message` state, same as the
 * single-button original — pressing either while the other's request is
 * in flight is disabled rather than queued.
 */
export function JevRegressionActions() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function handleFreeze() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-regression/freeze", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          setMessage("Dondurulamadı.");
          return;
        }
        setMessage("Set güncellendi.");
        router.refresh();
      } catch {
        setMessage("Dondurulamadı.");
      }
    });
  }

  function handleRun() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-regression/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          setMessage("Tetiklenemedi.");
          return;
        }
        setMessage("Regresyon tetiklendi.");
        router.refresh();
      } catch {
        setMessage("Tetiklenemedi.");
      }
    });
  }

  return (
    <div className="flex items-center gap-2">
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={isPending}
        onClick={handleFreeze}
      >
        Seti dondur
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-[11px]"
        disabled={isPending}
        onClick={handleRun}
      >
        Regresyonu çalıştır
      </Button>
      {message && <p className="font-mono text-[11px] text-muted-foreground">{message}</p>}
    </div>
  );
}
