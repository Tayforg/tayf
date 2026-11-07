"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import Link from "next/link";

import { cleanOutboundUrl } from "@/lib/articles/outbound-url";
import { ZONE_META } from "@/lib/bias/config";
import { markAnswered } from "@/lib/game/answered-headlines";
import {
  STREAK_STORAGE_KEY,
  applyDailyResult,
  buildShareText,
  isShareAbort,
  liveStreak,
  parseDailyStore,
  type DailyStore,
} from "@/lib/game/daily-share";
import {
  dailyIntroText,
  puzzleFallbackNotice,
  type DailyHeadline,
  type DailyPuzzle,
  type PuzzleDateFallback,
} from "@/lib/game/daily-set";
import { headlineAnnouncement } from "@/lib/game/headline-announcement";
import { track } from "@/lib/track";
import { NewTabHint } from "@/components/ui/new-tab-hint";
import type { MediaDnaZone } from "@/types";

interface DailyGameProps {
  puzzle: DailyPuzzle | null;
  todayKey: string;
  /** Why `?gun=` did not give the puzzle it named (see oyun/page.tsx); a
   * one-line notice is shown for "expired" and "future". */
  fellBack?: PuzzleDateFallback | null;
}

export type Phase = "idle" | "playing" | "revealed" | "finished";

/**
 * The phase to render. A result already in localStorage beats whatever this
 * component instance holds locally until THIS session plays the round (then
 * the local phase is the truth again).
 *
 * It is a pure function of the current render's inputs, never state seeded
 * from the first render: the server snapshot of the store is null, so the
 * first client render has no stored result, and a `useState` initializer
 * would keep that "nothing stored" answer forever (the visitor who already
 * played would see "Başla" and replaying would POST five more guesses).
 */
export function resolveDailyPhase({
  hasStoredResult,
  playedThisSession,
  localPhase,
}: {
  hasStoredResult: boolean;
  playedThisSession: boolean;
  localPhase: Phase;
}): Phase {
  return hasStoredResult && !playedThisSession ? "finished" : localPhase;
}

/**
 * The marks the result screen and Paylaş show. It follows the SAME predicate
 * as the phase (`openedAlreadyPlayed`, i.e. a stored result and this session
 * did not play the round): when a result lands from outside this session (a
 * stored one after hydration, or another tab finishing the round), any local
 * marks are an abandoned partial round and must not be scored or shared next
 * to the "already played" banner. When this session finished the round the
 * local marks are the truth (they equal what was just stored).
 */
export function resolveFinalMarks({
  storedMarks,
  openedAlreadyPlayed,
  localMarks,
}: {
  storedMarks: readonly boolean[] | undefined;
  openedAlreadyPlayed: boolean;
  localMarks: boolean[];
}): boolean[] {
  return openedAlreadyPlayed && storedMarks ? [...storedMarks] : localMarks;
}

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
 * component shows the finished/result screen and sends NO guesses — this
 * covers both a same-day reload after finishing and a `?gun=` replay of an
 * already-played past puzzle. The phase is derived from the store on every
 * render (`resolveDailyPhase`), because the first client render still sees
 * the null server snapshot.
 */
export function DailyGame({ puzzle, todayKey, fellBack }: DailyGameProps) {
  const rawStore = useSyncExternalStore(subscribeStore, readRawStore, getServerSnapshot);
  const store = useMemo(() => parseDailyStore(rawStore), [rawStore]);

  const existingResult = puzzle ? store.results[puzzle.dateKey] : undefined;

  // `localPhase` is only what THIS session did; the phase actually shown is
  // derived below, so a stored result that shows up after hydration (or from
  // another tab) takes over on the next render without any effect.
  const [localPhase, setLocalPhase] = useState<Phase>("idle");
  const [playedThisSession, setPlayedThisSession] = useState(false);
  const [index, setIndex] = useState(0);
  const [marks, setMarks] = useState<boolean[]>([]);
  const [guessedZone, setGuessedZone] = useState<MediaDnaZone | null>(null);
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");

  const phase = resolveDailyPhase({
    hasStoredResult: Boolean(existingResult),
    playedThisSession,
    localPhase,
  });
  // Whether this puzzle was already in the store before this session
  // finished it (vs. just finished now): decides only the "already played
  // today" banner. The no-second-POST guarantee comes from `phase` being
  // "finished", which makes handleGuess's `phase !== "playing"` bail out.
  const openedAlreadyPlayed = Boolean(existingResult) && !playedThisSession;

  // Ties the headline <p> to the guess group (aria-describedby), so a screen
  // reader reads the headline together with the choices.
  const headlineId = useId();

  const startRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const firstZoneRef = useRef<HTMLButtonElement | null>(null);
  const shareRef = useRef<HTMLButtonElement | null>(null);

  // Keyboard-only play: move focus to the control that matters for the
  // phase just entered, since each phase swaps in a different button
  // group and the browser would otherwise reset focus to <body> — same
  // pattern as zone-guess-game.tsx. The result screen only takes focus when
  // THIS session just finished the round (the final Sonraki unmounts the
  // focused button); a visitor who opens the page with a stored result keeps
  // the focus where it was.
  useEffect(() => {
    if (phase === "revealed") {
      nextRef.current?.focus();
    } else if (phase === "playing") {
      firstZoneRef.current?.focus();
    } else if (phase === "finished" && playedThisSession) {
      shareRef.current?.focus();
    }
  }, [phase, index, playedThisSession]);

  const headlines = useMemo<DailyHeadline[]>(() => puzzle?.headlines ?? [], [puzzle]);
  const current = headlines[index] ?? null;
  const finalMarks = resolveFinalMarks({
    storedMarks: existingResult?.marks,
    openedAlreadyPlayed,
    localMarks: marks,
  });
  const score = finalMarks.filter(Boolean).length;

  const handleStart = useCallback(() => {
    setIndex(0);
    setMarks([]);
    setGuessedZone(null);
    // The headline <p> sits outside the live region, so say it here: a screen
    // reader user would otherwise only hear the zone buttons.
    setAnnouncement(headlineAnnouncement(1, headlines.length, headlines[0]?.title));
    setLocalPhase("playing");
  }, [headlines]);

  const handleGuess = useCallback(
    (zone: MediaDnaZone) => {
      if (!current || phase !== "playing") return;
      const isMatch = zone === current.zone;
      setGuessedZone(zone);
      setMarks((prev) => [...prev, isMatch]);
      setLocalPhase("revealed");
      setAnnouncement(
        isMatch
          ? `${current.sourceName} · ${ZONE_META[current.zone].label} — Tayf'ın etiketiyle aynı`
          : `${current.sourceName} — Tayf bu kaynağı ${ZONE_META[current.zone].label} bölgesine koyuyor`,
      );

      // Fire-and-forget, exactly like zone-guess-game.tsx's handleGuess:
      // not awaited, no `.then`, response never read (correct is
      // recomputed and stored server-side; a 429 or network failure must
      // never interrupt play). Only the first time this headline is answered
      // blind in the tab session: the same headline may also be in Bölge's
      // list, and a restarted puzzle shows answers it already revealed.
      if (markAnswered(current.articleId)) {
        fetch("/api/oyun", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            articleId: current.articleId,
            sourceId: current.sourceId,
            guessedZone: zone,
          }),
        }).catch(() => {});
      }
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
      // State first, then the store write: the write notifies the store
      // subscriber, and both land in one batch, so no render ever sees the
      // fresh result while `playedThisSession` is still false (that would
      // flash the "already played" banner right after a normal finish).
      setPlayedThisSession(true);
      setLocalPhase("finished");
      writeRawStore(nextStore);
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
    setAnnouncement(
      headlineAnnouncement(nextIndex + 1, headlines.length, headlines[nextIndex]?.title),
    );
    setLocalPhase("playing");
  }, [index, headlines, finishRound, marks]);

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
        .catch((err) => {
          // Dismissing the share sheet is a decision, not a failure: leave
          // the clipboard alone. Anything else (unsupported, blocked) still
          // falls back to copying.
          if (isShareAbort(err)) return;
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
          {dailyIntroText({
            dateKey: puzzle.dateKey,
            todayKey,
            number: puzzle.number,
            windowLabel: puzzle.windowLabel,
          })}
        </p>
        <button
          ref={startRef}
          type="button"
          onClick={handleStart}
          className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
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
            Seri: {liveStreak(store, todayKey)} gün · En iyi: {store.best}
          </p>
          <button
            ref={shareRef}
            type="button"
            onClick={handleShare}
            className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
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
                  href={cleanOutboundUrl(h.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Habere git ↗
                  <NewTabHint />
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

        <p id={headlineId} className="font-serif text-lg sm:text-xl leading-snug">
          {current.title}
        </p>

        {phase === "playing" && (
          <div
            role="group"
            aria-label="Taraf tahmini"
            aria-describedby={headlineId}
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
                  className={`min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${meta.chipBg} ${meta.chipHover} ${meta.chipText} ${meta.chipBorder} focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring`}
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
              className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring"
            >
              Sonraki
            </button>
          </div>
        )}
      </div>
    );
  }

  const fallbackNotice = puzzleFallbackNotice(fellBack);

  return (
    <>
      {announcementRegion}
      {fallbackNotice && (
        <p className="text-[11px] text-muted-foreground text-center">{fallbackNotice}</p>
      )}
      {content}
    </>
  );
}
