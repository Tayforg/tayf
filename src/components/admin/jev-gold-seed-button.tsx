"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";

/**
 * "Altın kümeyi oluştur" — POSTs to /api/admin/jev-gold/seed
 * (admin-session gated server-side). Idempotent on the server: re-pressing
 * this just tops each category quota back up. Modelled on
 * jev-shadow-review-actions.tsx: never surfaces the server's response
 * text, just a generic Turkish result message.
 */
export function JevGoldSeedButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);

  function handleSeed() {
    setMessage(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-gold/seed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!res.ok) {
          setMessage("Oluşturulamadı.");
          return;
        }
        setMessage("Altın küme güncellendi.");
        router.refresh();
      } catch {
        setMessage("Oluşturulamadı.");
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
        onClick={handleSeed}
      >
        Altın kümeyi oluştur
      </Button>
      {message && <p className="font-mono text-[11px] text-muted-foreground">{message}</p>}
    </div>
  );
}
