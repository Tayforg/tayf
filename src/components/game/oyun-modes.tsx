"use client";

import { useState } from "react";

import { ZoneGuessGame } from "@/components/game/zone-guess-game";
import { FramingGame } from "@/components/game/framing-game";
import type { GameHeadline } from "@/lib/game/headline-pool";

type OyunMode = "bolge" | "cerceve";

interface OyunModesProps {
  headlines: readonly GameHeadline[];
}

const ACTIVE_TAB_CLASS =
  "min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors bg-primary text-primary-foreground border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const INACTIVE_TAB_CLASS =
  "min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors border-border/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * "use client" mode switch between /oyun's two games: Bölge (zone-guess,
 * existing) and Çerçeve (framing-vote, R10). Holds only the UI mode
 * toggle state — each game (ZoneGuessGame, FramingGame) owns its own play
 * state independently.
 */
export function OyunModes({ headlines }: OyunModesProps) {
  const [mode, setMode] = useState<OyunMode>("bolge");

  return (
    <div className="space-y-6">
      <div role="group" aria-label="Oyun modu" className="grid grid-cols-2 gap-2">
        <button
          type="button"
          aria-pressed={mode === "bolge"}
          onClick={() => setMode("bolge")}
          className={mode === "bolge" ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS}
        >
          Bölge
        </button>
        <button
          type="button"
          aria-pressed={mode === "cerceve"}
          onClick={() => setMode("cerceve")}
          className={mode === "cerceve" ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS}
        >
          Çerçeve
        </button>
      </div>

      {mode === "bolge" ? (
        headlines.length === 0 ? (
          <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
            <p className="text-sm text-muted-foreground">
              Şu an oynanacak başlık yok. Birazdan tekrar dene.
            </p>
          </div>
        ) : (
          <ZoneGuessGame headlines={headlines} />
        )
      ) : (
        <FramingGame />
      )}
    </div>
  );
}
