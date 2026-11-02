"use client";

import { useState } from "react";

import { RetryButton } from "@/components/ui/retry-button";
import { ZoneGuessGame } from "@/components/game/zone-guess-game";
import { FramingGame } from "@/components/game/framing-game";
import { DailyGame } from "@/components/game/daily-game";
import type { GameHeadline } from "@/lib/game/headline-pool";
import type { DailyPuzzle, PuzzleDateFallback } from "@/lib/game/daily-set";

type OyunMode = "bolge" | "cerceve" | "gunluk";

interface OyunModesProps {
  /** `null` = the headline fetch FAILED (offer a retry); `[]` = the fetch
   * worked but nothing qualifies right now. */
  headlines: readonly GameHeadline[] | null;
  daily: DailyPuzzle | null;
  todayKey: string;
  /** Why `?gun=` did not give the puzzle it named; forwarded to DailyGame,
   * which shows a one-line notice for an expired or future link. */
  dailyFellBack?: PuzzleDateFallback | null;
  /** Which tab is active on first render — "bolge" unless the URL carries
   * `?mod=gunluk` or `?gun=` (see oyun/page.tsx). */
  initialMode?: OyunMode;
}

const ACTIVE_TAB_CLASS =
  "min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors bg-primary text-primary-foreground border-primary focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring";
const INACTIVE_TAB_CLASS =
  "min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors border-border/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring";

/**
 * "use client" mode switch between /oyun's three games: Bölge (zone-guess,
 * existing), Çerçeve (framing-vote, R10) and Günün Tayf'ı (daily 5-headline
 * zone-guess, gunun-tayfi). Holds only the UI mode toggle state — each game
 * (ZoneGuessGame, FramingGame, DailyGame) owns its own play state
 * independently. Tab order and the default tab are fixed here: Bölge,
 * Çerçeve, Günün Tayf'ı — Bölge stays the default unless `initialMode`
 * says otherwise (driven by the URL, one level up in oyun/page.tsx).
 *
 * A tab is mounted the first time it is opened and then stays mounted, hidden
 * with the `hidden` attribute while another tab is active: switching tabs must
 * not unmount a game mid-round (a restart would replay headlines whose answers
 * were already revealed). The server render holds only the initial tab, so a
 * visitor who never opens Çerçeve never mounts it either (its fetch, on
 * "Başla", is what sets that game's cookie). A Bölge round in a hidden tab
 * keeps its wall-clock timer running.
 */
export function OyunModes({
  headlines,
  daily,
  todayKey,
  dailyFellBack,
  initialMode = "bolge",
}: OyunModesProps) {
  const [mode, setMode] = useState<OyunMode>(initialMode);
  // Tabs opened so far: each is rendered once and kept (see the doc comment).
  const [opened, setOpened] = useState<ReadonlySet<OyunMode>>(() => new Set([initialMode]));

  const selectMode = (m: OyunMode) => {
    setMode(m);
    setOpened((prev) => (prev.has(m) ? prev : new Set([...prev, m])));
  };

  return (
    <div className="space-y-6">
      <div role="group" aria-label="Oyun modu" className="grid grid-cols-3 gap-2">
        <button
          type="button"
          aria-pressed={mode === "bolge"}
          onClick={() => selectMode("bolge")}
          className={mode === "bolge" ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS}
        >
          Bölge
        </button>
        <button
          type="button"
          aria-pressed={mode === "cerceve"}
          onClick={() => selectMode("cerceve")}
          className={mode === "cerceve" ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS}
        >
          Çerçeve
        </button>
        <button
          type="button"
          aria-pressed={mode === "gunluk"}
          onClick={() => selectMode("gunluk")}
          className={mode === "gunluk" ? ACTIVE_TAB_CLASS : INACTIVE_TAB_CLASS}
        >
          Günün Tayf&rsquo;ı
        </button>
      </div>

      {opened.has("bolge") && (
        <div hidden={mode !== "bolge"}>
          {headlines === null ? (
            <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
              <p className="text-sm text-muted-foreground">Başlıklar şu an yüklenemedi.</p>
              <RetryButton />
            </div>
          ) : headlines.length === 0 ? (
            <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
              <p className="text-sm text-muted-foreground">
                Şu an oynanacak başlık yok. Birazdan tekrar dene.
              </p>
            </div>
          ) : (
            <ZoneGuessGame headlines={headlines} />
          )}
        </div>
      )}
      {opened.has("cerceve") && (
        <div hidden={mode !== "cerceve"}>
          <FramingGame />
        </div>
      )}
      {opened.has("gunluk") && (
        <div hidden={mode !== "gunluk"}>
          <DailyGame puzzle={daily} todayKey={todayKey} fellBack={dailyFellBack} />
        </div>
      )}
    </div>
  );
}
