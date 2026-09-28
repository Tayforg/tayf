"use client";

import { useState } from "react";

import { clearDiet } from "@/lib/diet/diet-store";
import { useReadingDiet } from "./use-reading-diet";

type Step = "idle" | "confirm" | "done" | "failed";

// Two-step inline confirm, mirroring the destructive-action pattern used
// elsewhere in the app: first click asks, second click acts.
export function ClearDietButton() {
  const { available } = useReadingDiet();
  const [step, setStep] = useState<Step>("idle");

  if (!available) return null;

  if (step === "confirm") {
    return (
      <div className="flex items-center gap-2 text-sm">
        <span>Emin misin?</span>
        <button
          type="button"
          className="rounded-md border border-destructive/40 px-2 py-1 text-destructive hover:bg-destructive/10"
          onClick={() => {
            setStep(clearDiet() ? "done" : "failed");
          }}
        >
          Evet, sil
        </button>
        <button
          type="button"
          className="rounded-md border border-border/60 px-2 py-1 hover:bg-muted"
          onClick={() => setStep("idle")}
        >
          Vazgeç
        </button>
      </div>
    );
  }

  if (step === "done") {
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Haber diyeti verilerin bu cihazdan silindi.
      </p>
    );
  }

  if (step === "failed") {
    return (
      <p className="text-sm text-destructive">
        Silinemedi: tarayıcı yerel depolamaya erişime izin vermiyor.
      </p>
    );
  }

  return (
    <button
      type="button"
      className="rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-muted"
      onClick={() => setStep("confirm")}
    >
      Verilerimi sil
    </button>
  );
}
