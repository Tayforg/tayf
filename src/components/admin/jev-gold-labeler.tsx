"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import { JEV_GOLD_NOTE_MAX_LENGTH, JEV_GOLD_TOPICS, JEV_GOLD_TOPIC_LABELS_TR } from "@/lib/admin/jev-gold";

/**
 * The /admin/jev-altin labeling form for one article. Modelled on
 * jev-shadow-review-actions.tsx and corrections-actions.tsx: POSTs to
 * admin-session-gated routes (this component has no auth logic of its own)
 * and refreshes the server component on success. On failure we never
 * surface the server's response text — just a generic Turkish retry
 * message — since that body can echo back request details we don't want
 * rendered verbatim.
 *
 * The "Etiketleyici: 1 | 2" switch lives in jev-gold-labeler-switch.tsx,
 * not here (063, JEV-N2) — it must render even when this component isn't
 * mounted (no article left in the queue, or the gold set is still empty).
 */
export function JevGoldLabeler({ articleId, labeler }: { articleId: string; labeler: 1 | 2 }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isPolitics, setIsPolitics] = useState<boolean | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  function handleSave() {
    if (isPolitics === null || topic === null) return;
    setError(null);
    startTransition(async () => {
      try {
        const res = await fetch("/api/admin/jev-gold/label", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            article_id: articleId,
            labeler,
            is_politics: isPolitics,
            topic,
            note: note.length > 0 ? note : undefined,
          }),
        });
        if (!res.ok) {
          setError("Kaydedilemedi.");
          return;
        }
        setIsPolitics(null);
        setTopic(null);
        setNote("");
        router.refresh();
      } catch {
        setError("Kaydedilemedi.");
      }
    });
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5 font-mono text-[12px]">
        <p className="text-muted-foreground">Siyaset mi?</p>
        <div className="flex gap-1.5">
          <Button
            variant={isPolitics === true ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={isPending}
            onClick={() => setIsPolitics(true)}
          >
            Evet
          </Button>
          <Button
            variant={isPolitics === false ? "secondary" : "ghost"}
            size="sm"
            className="h-7 px-2 text-[11px]"
            disabled={isPending}
            onClick={() => setIsPolitics(false)}
          >
            Hayır
          </Button>
        </div>
      </div>

      <div className="space-y-1.5 font-mono text-[12px]">
        <p className="text-muted-foreground">Konu</p>
        <div className="flex flex-wrap gap-1.5">
          {JEV_GOLD_TOPICS.map((t) => (
            <Button
              key={t}
              variant={topic === t ? "secondary" : "ghost"}
              size="sm"
              className="h-7 px-2 text-[11px]"
              disabled={isPending}
              onClick={() => setTopic(t)}
            >
              {JEV_GOLD_TOPIC_LABELS_TR[t]}
            </Button>
          ))}
        </div>
      </div>

      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Not (isteğe bağlı)"
        maxLength={JEV_GOLD_NOTE_MAX_LENGTH}
        disabled={isPending}
        rows={2}
        className="w-full rounded-lg border border-border/60 bg-background p-2 font-mono text-[12px] disabled:opacity-50"
      />

      <Button
        size="sm"
        className="h-7 px-3 text-[11px]"
        disabled={isPending || isPolitics === null || topic === null}
        onClick={handleSave}
      >
        Kaydet
      </Button>
      {error && <p className="font-mono text-[11px] text-destructive">{error}</p>}
    </div>
  );
}
