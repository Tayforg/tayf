"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";

import { ZONE_META } from "@/lib/bias/config";
import {
  STREAK_STORAGE_KEY,
  applyDailyResult,
  buildShareText,
  parseDailyStore,
  type DailyStore,
} from "@/lib/game/daily-share";
import type { DailyHeadline, DailyPuzzle } from "@/lib/game/daily-set";
import { track } from "@/lib/track";
import type { MediaDnaZone } from "@/types";

interface DailyGameProps {
  puzzle: DailyPuzzle | null;
  todayKey: string;
}

type Phase = "idle" | "playing" | "revealed" | "finished";

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
// Own event name (not zone-guess-game.tsx's BEST_SCORE_CHANGE_EVENT) so the
// two "use client" games' localStorage writes never cross-trigger each
// other's re-read.
const STORE_CHANGE_EVENT = "tayf-gunun-tayfi-store-change";

// localStorage is wrapped in try/catch throughout (private/incognito
// windows throw on access) — same convention as zone-guess-game.tsx. Read
// via useSyncExternalStore, never a useEffect+setState, per this repo's
// react-hooks/set-state-in-effect rule and the house pattern in
// use-bookmarks.ts.
function readRawStore(): string | null {
  try {
    return window.localStorage.getItem(STREAK_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeRawStore(store: DailyStore): void {
  try {
    window.localStorage.setItem(STREAK_STORAGE_KEY, JSON.stringify(store));
    // Dispatched so THIS tab's own subscriber re-reads immediately — the
    // native `storage` event only fires in other tabs/windows.
    window.dispatchEvent(new Event(STORE_CHANGE_EVENT));
  } catch {
    // Private window / blocked storage — streak persistence is a nicety
    // only; the round has already been scored and shown regardless.
  }
}

function subscribeStore(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(STORE_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(STORE_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// SSR has no localStorage — the server render never reads storage, so this
// always returns null there. Matches zone-guess-game.tsx's
// getServerBestScore: no hydration mismatch, and React re-syncs to the
// real value right after hydration commits.
function getServerSnapshot(): string | null {
  return null;
}

/**
 * "Günün Tayf'ı" — /oyun's third tab. Every visitor of Istanbul day D gets
 * the SAME 5 political headlines (`puzzle`, built server-side by
 * daily-query.ts) and guesses each one's zone. No timer; the game is
 * anonymous. Each guess POSTs fire-and-forget to the existing
 * `POST /api/oyun` (same `zone_guesses` table + rate limiter zone-guess-
 * game.tsx already uses) — this mode stores NOTHING new server-side and
 * sets no cookie. The only new persistence is a client-only localStorage
 * streak/result store (`daily-share.ts`), read/written exactly like
 * zone-guess-game.tsx's personal-best key.
 *
 * If a result for `puzzle.dateKey` already exists in that local store, the
 * component opens straight on the finished/result screen and sends NO
 * guesses — this covers both a same-day reload after finishing and a
 * `?gun=` replay of an already-played past puzzle.
 */
export function DailyGame({ puzzle, todayKey }: DailyGameProps) {
  const rawStore = useSyncExternalStore(subscribeStore, readRawStore, getServerSnapshot);
  const store = useMemo(() => parseDailyStore(rawStore), [rawStore]);

  const existingResult = puzzle ? store.results[puzzle.dateKey] : undefined;
  // Captured once at mount: whether this puzzle was ALREADY played before
  // this component instance ever rendered (vs. just finished during this
  // session) — used only to decide whether to show the "already played
  // today" banner, never to gate the no-second-POST behavior itself (that
  // comes from `phase` starting at "finished" below).
  const [openedAlreadyPlayed] = useState(() => Boolean(existingResult));

  const [phase, setPhase] = useState<Phase>(existingResult ? "finished" : "idle");
  const [index, setIndex] = useState(0);
  const [marks, setMarks] = useState<boolean[]>([]);
  const [guessedZone, setGuessedZone] = useState<MediaDnaZone | null>(null);
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const startRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const firstZoneRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard-only play: move focus to the control that matters for the
  // phase just entered, since each phase swaps in a different button
  // group and the browser would otherwise reset focus to <body> — same
  // pattern as zone-guess-game.tsx.
  useEffect(() => {
    if (phase === "revealed") {
      nextRef.current?.focus();
    } else if (phase === "playing") {
      firstZoneRef.current?.focus();
    }
  }, [phase, index]);

  const headlines: DailyHeadline[] = puzzle?.headlines ?? [];
  const current = headlines[index] ?? null;
  const finalMarks = existingResult && phase === "finished" && marks.length === 0
    ? existingResult.marks
    : marks;
  const score = finalMarks.filter(Boolean).length;

  const handleStart = useCallback(() => {
    setIndex(0);
    setMarks([]);
    setGuessedZone(null);
    setAnnouncement("");
    setPhase("playing");
  }, []);

  const handleGuess = useCallback(
    (zone: MediaDnaZone) => {
      if (!current || phase !== "playing") return;
      const isMatch = zone === current.zone;
      setGuessedZone(zone);
      setMarks((prev) => [...prev, isMatch]);
      setPhase("revealed");
      setAnnouncement(
        isMatch
          ? `${current.sourceName} · ${ZONE_META[current.zone].label} — Tayf'ın etiketiyle aynı`
          : `${current.sourceName} — Tayf bu kaynağı ${ZONE_META[current.zone].label} bölgesine koyuyor`,
      );

      // Fire-and-forget, exactly like zone-guess-game.tsx's handleGuess:
      // not awaited, no `.then`, response never read (correct is
      // recomputed and stored server-side; a 429 or network failure must
      // never interrupt play).
      fetch("/api/oyun", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          articleId: current.articleId,
          sourceId: current.sourceId,
          guessedZone: zone,
        }),
      }).catch(() => {});
    },
    [current, phase],
  );

  const finishRound = useCallback(
    (finishedMarks: boolean[]) => {
      if (!puzzle) return;
      const finalScore = finishedMarks.filter(Boolean).length;
      const nextStore = applyDailyResult(store, {
        dateKey: puzzle.dateKey,
        todayKey,
        score: finalScore,
        marks: finishedMarks,
      });
      writeRawStore(nextStore);
      setPhase("finished");
      setAnnouncement(`Tayf'ın etiketiyle ${finalScore}/5 aynı.`);
    },
    [puzzle, store, todayKey],
  );

  const handleNext = useCallback(() => {
    const nextIndex = index + 1;
    setGuessedZone(null);
    if (nextIndex >= headlines.length) {
      finishRound(marks);
      return;
    }
    setIndex(nextIndex);
    setPhase("playing");
  }, [index, headlines.length, finishRound, marks]);

  const copyToClipboard = useCallback((text: string) => {
    try {
      navigator.clipboard
        .writeText(text)
        .then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        })
        .catch(() => {});
    } catch {
      // Clipboard API unavailable — nothing more to do.
    }
  }, []);

  const handleShare = useCallback(() => {
    if (!puzzle) return;
    // origin is read at click time, never cached in state.
    const origin = window.location.origin;
    const text = buildShareText({
      number: puzzle.number,
      dateKey: puzzle.dateKey,
      score,
      marks: finalMarks,
      origin,
    });

    track("share", { kind: "gunun_tayfi" });

    const shareFn = typeof navigator !== "undefined" ? navigator.share : undefined;
    if (shareFn) {
      shareFn
        .call(navigator, { text })
        .catch(() => {
          // Cancelled or unsupported mid-call — fall back to clipboard.
          copyToClipboard(text);
        });
      return;
    }
    copyToClipboard(text);
  }, [puzzle, score, finalMarks, copyToClipboard]);

  const announcementRegion = (
    <div className="sr-only" role="status" aria-live="polite">
      {announcement}
    </div>
  );

  let content: ReactNode;

  if (!puzzle) {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Bugünün 5 manşeti hazırlanamadı. Biraz sonra tekrar dene.
        </p>
      </div>
    );
  } else if (phase === "idle") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4">
        <p className="text-sm text-muted-foreground">
          Dünün ({puzzle.windowLabel}) 5 siyasi manşeti. Her biri hangi bölgedeki bir kaynaktan?
          Herkes aynı 5 manşeti görür. Günün Tayf&rsquo;ı #{puzzle.number}.
        </p>
        <button
          ref={startRef}
          type="button"
          onClick={handleStart}
          className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Başla
        </button>
      </div>
    );
  } else if (phase === "finished") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 space-y-4">
        {openedAlreadyPlayed && puzzle.dateKey === todayKey && (
          <p className="text-center text-sm text-muted-foreground">
            Bugünün oyununu oynadın. Yarın yeni 5 manşet.
          </p>
        )}
        <div className="text-center space-y-2">
          <p className="font-serif text-2xl">Tayf&rsquo;ın etiketiyle {score}/5 aynı</p>
          <p className="text-[11px] text-muted-foreground">
            Seri: {store.streak} gün · En iyi: {store.best}
          </p>
          <button
            type="button"
            onClick={handleShare}
            className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {copied ? "Kopyalandı" : "Paylaş"}
          </button>
          <div className="flex items-center justify-center gap-1 text-lg" aria-hidden="true">
            {finalMarks.map((m, i) => (
              <span key={i}>{m ? "✅" : "❌"}</span>
            ))}
          </div>
        </div>

        <ul className="space-y-3 text-left">
          {headlines.map((h) => (
            <li key={h.articleId} className="rounded-lg border border-border/60 p-3 space-y-1">
              <p className="text-sm">{h.title}</p>
              <div
                className={`inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-[11px] font-medium ${ZONE_META[h.zone].chipBg} ${ZONE_META[h.zone].chipBorder} ${ZONE_META[h.zone].chipText}`}
              >
                {h.sourceName} · {ZONE_META[h.zone].label}
              </div>
              <div className="flex flex-wrap gap-3 text-[11px] pt-1">
                <a
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Habere git ↗
                </a>
                {h.clusterId && (
                  <Link
                    href={`/cluster/${h.clusterId}`}
                    className="underline underline-offset-2 hover:text-foreground"
                  >
                    Kümeyi gör
                  </Link>
                )}
              </div>
            </li>
          ))}
        </ul>

        <p className="text-[11px] text-muted-foreground leading-relaxed">
          Skor, Tayf&rsquo;ın kaynak etiketleriyle ne kadar örtüştüğünü gösterir; bir doğru/yanlış
          hükmü değildir.
        </p>
      </div>
    );
  } else if (!current) {
    // Defensive — headlines is non-empty whenever "playing"/"revealed" is
    // reached (handleStart resets index to 0), guards a drifted index.
    content = null;
  } else {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-5 space-y-5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span aria-label={`${index + 1}. manşet, toplam ${headlines.length}`}>
            {index + 1} / {headlines.length}
          </span>
          <span aria-label={`${score} kaynakla aynı`}>{score} aynı</span>
        </div>

        <p className="font-serif text-lg sm:text-xl leading-snug">{current.title}</p>

        {phase === "playing" && (
          <div
            role="group"
            aria-label="Taraf tahmini"
            className="grid grid-cols-1 sm:grid-cols-3 gap-2"
          >
            {ZONES.map((zone, zoneIndex) => {
              const meta = ZONE_META[zone];
              return (
                <button
                  key={zone}
                  ref={zoneIndex === 0 ? firstZoneRef : undefined}
                  type="button"
                  onClick={() => handleGuess(zone)}
                  className={`min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${meta.chipBg} ${meta.chipHover} ${meta.chipText} ${meta.chipBorder} focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50`}
                >
                  {meta.label}
                </button>
              );
            })}
          </div>
        )}

        {phase === "revealed" && guessedZone && (
          <div className="space-y-3">
            <div
              className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium ${ZONE_META[current.zone].chipBg} ${ZONE_META[current.zone].chipBorder} ${ZONE_META[current.zone].chipText}`}
            >
              {current.sourceName} · {ZONE_META[current.zone].label}
            </div>
            <p className="text-sm">
              {guessedZone === current.zone
                ? `${current.sourceName} · ${ZONE_META[current.zone].label} — Tayf'ın etiketiyle aynı`
                : `${current.sourceName} — Tayf bu kaynağı ${ZONE_META[current.zone].label} bölgesine koyuyor`}
            </p>
            <button
              ref={nextRef}
              type="button"
              onClick={handleNext}
              className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Sonraki
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      {announcementRegion}
      {content}
    </>
  );
}
