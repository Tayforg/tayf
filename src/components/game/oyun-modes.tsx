"use client";

import { useState } from "react";

import { ZoneGuessGame } from "@/components/game/zone-guess-game";
import { FramingGame } from "@/components/game/framing-game";
import { DailyGame } from "@/components/game/daily-game";
import type { GameHeadline } from "@/lib/game/headline-pool";
import type { DailyPuzzle } from "@/lib/game/daily-set";

type OyunMode = "bolge" | "cerceve" | "gunluk";

interface OyunModesProps {
  headlines: readonly GameHeadline[];
  daily: DailyPuzzle | null;
  todayKey: string;
  /** Which tab is active on first render — "bolge" unless the URL carries
   * `?mod=gunluk` or `?gun=` (see oyun/page.tsx). */
  initialMode?: OyunMode;
}

const ACTIVE_TAB_CLASS =
  "min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors bg-primary text-primary-foreground border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";
const INACTIVE_TAB_CLASS =
  "min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors border-border/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50";

/**
 * "use client" mode switch between /oyun's three games: Bölge (zone-guess,
 * existing), Çerçeve (framing-vote, R10) and Günün Tayf'ı (daily 5-headline
 * zone-guess, gunun-tayfi). Holds only the UI mode toggle state — each game
 * (ZoneGuessGame, FramingGame, DailyGame) owns its own play state
 * independently. Tab order and the default tab are fixed here: Bölge,
 * Çerçeve, Günün Tayf'ı — Bölge stays the default unless `initialMode`
 * says otherwise (driven by the URL, one level up in oyun/page.tsx).
 */
export function OyunModes({ headlines, daily, todayKey, initialMode = "bolge" }: OyunModesProps) {
  const [mode, setMode] = useState<OyunMode>(initialMode);

  return (
    <div className="space-y-6">
      <div role="group" aria-label="Oyun modu" className="grid grid-cols-3 gap-2">
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
        <button
          type="button"
          aria-pressed={mode === "gunluk"}
          onClick={() => setMode("gunluk")}
          className={mode === "gunluk" ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS}
        >
          Günün Tayf&rsquo;ı
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
      ) : mode === "cerceve" ? (
        <FramingGame />
      ) : (
        <DailyGame puzzle={daily} todayKey={todayKey} />
      )}
    </div>
  );
}
