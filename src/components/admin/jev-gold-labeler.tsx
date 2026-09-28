"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { Button } from "@/components/ui/button";
import {
  JEV_GOLD_NOTE_MAX_LENGTH,
  JEV_GOLD_TOPICS,
  JEV_GOLD_TOPIC_LABELS_TR,
  JEV_TOPIC7_GUIDE_TR,
  revealLine,
} from "@/lib/admin/jev-gold";

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
export function JevGoldLabeler({
  articleId,
  labeler,
  reveal = { sourceSlug: null, category: null },
}: {
  articleId: string;
  labeler: 1 | 2;
  reveal?: { sourceSlug: string | null; category: string | null };
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [isPolitics, setIsPolitics] = useState<boolean | null>(null);
  const [topic, setTopic] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<{ sourceSlug: string | null; category: string | null } | null>(null);

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
        setLastSaved(reveal);
        router.refresh();
      } catch {
        setError("Kaydedilemedi.");
      }
    });
  }

  const incomplete = isPolitics === null || topic === null;

  return (
    <div className="space-y-3">
      {lastSaved && (
        <p className="text-xs text-muted-foreground">{revealLine(lastSaved)}</p>
      )}

      <div className="space-y-1.5 text-sm">
        <p className="text-muted-foreground">Siyaset mi? (zorunlu)</p>
        <div className="flex gap-1.5">
          <Button
            variant={isPolitics === true ? "secondary" : "ghost"}
            size="sm"
            className="h-9 sm:h-7 px-2 text-xs"
            disabled={isPending}
            onClick={() => setIsPolitics(true)}
          >
            Evet
          </Button>
          <Button
            variant={isPolitics === false ? "secondary" : "ghost"}
            size="sm"
            className="h-9 sm:h-7 px-2 text-xs"
            disabled={isPending}
            onClick={() => setIsPolitics(false)}
          >
            Hayır
          </Button>
        </div>
      </div>

      <div className="space-y-1.5 rounded-lg border border-border/60 p-3 text-sm">
        <p className="font-medium text-foreground">Konu kuralları (sırayla uygula, ilk uyan kuralda dur)</p>
        <p className="text-xs text-muted-foreground">{JEV_TOPIC7_GUIDE_TR.intro}</p>
        {JEV_TOPIC7_GUIDE_TR.rules.map((rule) => (
          <p key={rule} className="text-xs text-muted-foreground">
            {rule}
          </p>
        ))}
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground">Konu tanımları</summary>
          <div className="space-y-1 pt-1">
            {JEV_TOPIC7_GUIDE_TR.classes.map((c) => (
              <p key={c.topic} className="text-xs text-muted-foreground">
                {c.text}
              </p>
            ))}
          </div>
        </details>
      </div>

      <div className="space-y-1.5 text-sm">
        <p className="text-muted-foreground">Konu (zorunlu)</p>
        <div className="flex flex-wrap gap-1.5">
          {JEV_GOLD_TOPICS.map((t) => (
            <Button
              key={t}
              variant={topic === t ? "secondary" : "ghost"}
              size="sm"
              className="h-9 sm:h-7 px-2 text-xs"
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
        className="w-full rounded-lg border border-border/60 bg-background p-2 text-sm disabled:opacity-50"
      />

      <div className="space-y-1">
        <Button
          size="sm"
          className="h-9 sm:h-7 px-3 text-xs"
          disabled={isPending || incomplete}
          onClick={handleSave}
        >
          Kaydet
        </Button>
        {incomplete && (
          <p className="text-xs text-muted-foreground">
            Kaydetmek için &apos;Siyaset mi?&apos; ve &apos;Konu&apos; seçin.
          </p>
        )}
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
