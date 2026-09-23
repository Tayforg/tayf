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

const FREEZE_HINT = "Karşılaştırma setini güncel haberlerle yeniden oluşturur.";
const RUN_HINT = "Haftalık çalışmayı beklemeden şimdi başlatır.";

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
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-3 text-xs sm:h-7"
          disabled={isPending}
          onClick={handleFreeze}
          title={FREEZE_HINT}
        >
          Seti dondur
        </Button>
        <span className="text-xs text-muted-foreground">{FREEZE_HINT}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-3 text-xs sm:h-7"
          disabled={isPending}
          onClick={handleRun}
          title={RUN_HINT}
        >
          Regresyonu çalıştır
        </Button>
        <span className="text-xs text-muted-foreground">{RUN_HINT}</span>
      </div>
      {message && <p className="text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
