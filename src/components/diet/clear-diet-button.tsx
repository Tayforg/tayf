"use client";

import { useEffect, useId, useRef, useState, type Ref } from "react";

import { clearDiet } from "@/lib/diet/diet-store";
import { useReadingDiet } from "./use-reading-diet";

export type ClearDietStep = "idle" | "confirm" | "done" | "failed";

/** The element that takes focus when the step changes. */
export type ClearDietFocusTarget = "trigger" | "cancel" | "status" | "alert";

/**
 * Where focus goes when the flow moves from `prev` to `next` (WCAG 2.4.3).
 * Every step swaps the element the reader just activated for another one, so
 * without a hand-off focus falls back to the document body:
 *   idle -> confirm    the safe choice, 'Vazgeç'
 *   confirm -> idle    the 'Verilerimi sil' trigger the reader started from
 *   confirm -> done    the status message (so it is read out)
 *   confirm -> failed  the alert message
 * An unchanged step (the initial mount) and every other pair move nothing.
 */
export function focusTargetFor(
  prev: ClearDietStep,
  next: ClearDietStep,
): ClearDietFocusTarget | null {
  if (prev === "idle" && next === "confirm") return "cancel";
  if (prev === "confirm") {
    if (next === "idle") return "trigger";
    if (next === "done") return "status";
    if (next === "failed") return "alert";
  }
  return null;
}

// Presentational half: one element tree per step, no state and no storage, so
// the markup of every step can be rendered on its own.
export function ClearDietView({
  step,
  promptId,
  onAsk,
  onConfirm,
  onCancel,
  triggerRef,
  cancelRef,
  messageRef,
}: {
  step: ClearDietStep;
  /** id of the question text; the confirm group is labelled by it. */
  promptId: string;
  onAsk: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  cancelRef?: Ref<HTMLButtonElement>;
  /** Attached to the status or alert paragraph, whichever the step renders. */
  messageRef?: Ref<HTMLParagraphElement>;
}) {
  if (step === "confirm") {
    return (
      <div role="group" aria-labelledby={promptId} className="flex items-center gap-2 text-sm">
        <span id={promptId}>Emin misiniz?</span>
        <button
          type="button"
          className="rounded-md border border-destructive/40 px-2 py-1 text-destructive hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onConfirm}
        >
          Evet, sil
        </button>
        <button
          ref={cancelRef}
          type="button"
          className="rounded-md border border-border/60 px-2 py-1 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onCancel}
        >
          Vazgeç
        </button>
      </div>
    );
  }

  // tabIndex -1 on both messages: script-focusable only, so the outcome is read
  // out even though the paragraph mounts together with its text.
  if (step === "done") {
    return (
      <p
        ref={messageRef}
        role="status"
        tabIndex={-1}
        className="rounded-sm text-sm text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Haber diyeti verileriniz bu cihazdan silindi.
      </p>
    );
  }

  if (step === "failed") {
    return (
      <p
        ref={messageRef}
        role="alert"
        tabIndex={-1}
        className="rounded-sm text-sm text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        Silinemedi: tarayıcı yerel depolamaya erişime izin vermiyor.
      </p>
    );
  }

  return (
    <button
      ref={triggerRef}
      type="button"
      className="rounded-md border border-border/60 px-3 py-1.5 text-sm hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      onClick={onAsk}
    >
      Verilerimi sil
    </button>
  );
}

// Two-step inline confirm, mirroring the destructive-action pattern used
// elsewhere in the app: first click asks, second click acts.
export function ClearDietButton() {
  // Every hook sits above the early return below.
  const { available } = useReadingDiet();
  const [step, setStep] = useState<ClearDietStep>("idle");
  const promptId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const prevStep = useRef<ClearDietStep>("idle");

  useEffect(() => {
    const target = focusTargetFor(prevStep.current, step);
    prevStep.current = step;
    if (target === "trigger") triggerRef.current?.focus();
    else if (target === "cancel") cancelRef.current?.focus();
    else if (target === "status" || target === "alert") messageRef.current?.focus();
  }, [step]);

  if (!available) return null;

  return (
    <ClearDietView
      step={step}
      promptId={promptId}
      onAsk={() => setStep("confirm")}
      onConfirm={() => setStep(clearDiet() ? "done" : "failed")}
      onCancel={() => setStep("idle")}
      triggerRef={triggerRef}
      cancelRef={cancelRef}
      messageRef={messageRef}
    />
  );
}
