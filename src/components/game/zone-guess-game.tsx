"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import { ZONE_META } from "@/lib/bias/config";
import { markAnswered, nextRound, readAnsweredIds } from "@/lib/game/answered-headlines";
import { headlineAnnouncement } from "@/lib/game/headline-announcement";
// Type-only: headline-pool.ts is server code (next/cache, "use cache") and must
// stay out of the client bundle. The value import below comes from round-size.
import type { GameHeadline } from "@/lib/game/headline-pool";
import { GAME_ROUND_SIZE } from "@/lib/game/round-size";
import type { MediaDnaZone } from "@/types";

interface ZoneGuessGameProps {
  headlines: readonly GameHeadline[];
}

type Phase = "idle" | "playing" | "revealed" | "finished" | "empty";

const GAME_SECONDS = 60;
const BEST_SCORE_KEY = "tayf-oyun-best";
// Dispatched after a write so this tab's own `useSyncExternalStore`
// subscriber re-reads immediately — the native `storage` event only fires
// in *other* tabs/windows, never the one that made the write.
const BEST_SCORE_CHANGE_EVENT = "tayf-oyun-best-change";
const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
// Coarse time warnings pushed into the persistent live region — never
// announce every second, just these two thresholds.
const ANNOUNCE_THRESHOLDS: readonly number[] = [30, 10];
// Shown (and announced) when "Başla" finds no headline left that this tab
// session has not answered yet.
const EMPTY_COPY = "Şimdilik oynamadığın manşet kalmadı. Biraz sonra tekrar dene.";

// localStorage is a personal-best nicety only — never a session id, never
// sent anywhere. Wrapped in try/catch: it throws in private/incognito
// windows and other blocked-storage contexts.
//
// Read via `useSyncExternalStore` (below), not a `useEffect` + `setState`
// on mount: this repo's react-hooks/set-state-in-effect rule flags a
// direct setState call in an effect body, and useSyncExternalStore is the
// house pattern for exactly this "read an external, browser-only store
// without a hydration mismatch" case — see use-bookmarks.ts's readSet.
function readBestScore(): number | null {
  try {
    const raw = window.localStorage.getItem(BEST_SCORE_KEY);
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function writeBestScore(score: number, previousBest: number | null): void {
  try {
    if (previousBest === null || score > previousBest) {
      window.localStorage.setItem(BEST_SCORE_KEY, String(score));
      window.dispatchEvent(new Event(BEST_SCORE_CHANGE_EVENT));
    }
  } catch {
    // Private window / blocked storage — a personal best is a nicety, not
    // a requirement. Silently skip.
  }
}

function subscribeBestScore(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(BEST_SCORE_CHANGE_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(BEST_SCORE_CHANGE_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

// SSR has no localStorage — matches use-bookmarks.ts's getServerSnapshot,
// so the server-rendered markup and the pre-hydration client read agree
// (no hydration mismatch), and React re-syncs to the real value right
// after hydration commits.
function getServerBestScore(): number | null {
  return null;
}

// 'use client' state machine: idle → playing (60s countdown, one headline
// at a time) → revealed (outlet + Tayf's zone + match/no-match) → next →
// finished (score + replay). Score lives in component state only.
//
// `headlines` is the page session's list (30, one per story). Each round
// plays the first GAME_ROUND_SIZE of them this tab session has not answered
// yet (`round`), so "Yeniden Oyna" never shows a headline whose outlet and
// zone were already revealed; when none is left the finished screen offers a
// fresh server sample instead, and a "Başla" that finds none shows the
// "empty" phase.
//
// Every guess POSTs { articleId, sourceId, guessedZone } to /api/oyun — but
// only the first time that headline is answered in this tab session
// (markAnswered), so a replay or a revisit can never feed an informed guess
// into the published agreement numbers. The response is deliberately never
// read — a 429 or a network failure
// must not interrupt play. The local `correct` shown at reveal is computed
// from the zone/bias the server already sent down with each headline
// (see oyun/page.tsx); it is NOT authoritative. /api/oyun recomputes
// `correct` server-side from `sources.bias`, so a tampered client only
// ever corrupts its own local score — never "optimise" this by trusting
// a client-supplied `correct`.
export function ZoneGuessGame({ headlines }: ZoneGuessGameProps) {
  const [phase, setPhase] = useState<Phase>("idle");
  // The headlines of the round being played, drawn in `handleStart`.
  const [round, setRound] = useState<readonly GameHeadline[]>([]);
  // Whether a further round with unanswered headlines exists; worked out in
  // `finishRound` (a handler/timer callback, never during render).
  const [hasMore, setHasMore] = useState(true);
  const [index, setIndex] = useState(0);
  const [score, setScore] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(GAME_SECONDS);
  const [guessedZone, setGuessedZone] = useState<MediaDnaZone | null>(null);
  // Returning player: shows their stored personal best on the idle screen
  // too, not just after finishing a round. Updates automatically after
  // `writeBestScore` dispatches its change event, so `finishRound` never
  // needs its own `setBestScore` call.
  const bestScore = useSyncExternalStore(subscribeBestScore, readBestScore, getServerBestScore);
  // Drives the single persistent `role="status"` live region below —
  // reveal sentence, then coarse time warnings, then the final score.
  const [announcement, setAnnouncement] = useState("");

  // "Latest score" escape hatch for the timer callback below, which runs
  // on a `setInterval` tick and would otherwise close over a stale
  // `score`. Updated directly at the point `score` changes (in
  // `handleGuess`), never via a separate synchronizing effect — so there
  // is no effect here at all, just a ref a plain event handler writes to.
  const scoreRef = useRef(0);

  // The wall-clock the current round ends at (not "seconds remaining"),
  // so the countdown is drift-proof across effect re-runs, tab
  // backgrounding, etc. Set once per round in `handleStart`.
  const endsAtRef = useRef(0);
  // Which of ANNOUNCE_THRESHOLDS have already been pushed into the live
  // region this round — reset in `handleStart` so they can fire again next
  // round.
  const announcedThresholdsRef = useRef<Set<number>>(new Set());

  // Ties the headline <p> to the guess group (aria-describedby), so a screen
  // reader reads the headline together with the choices.
  const headlineId = useId();

  const firstZoneRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const replayRef = useRef<HTMLButtonElement | null>(null);

  // Ends the round: reads/writes the personal-best (try/catch-wrapped
  // localStorage nicety), works out whether another round is left and flips
  // to "finished". Takes the final score as
  // an argument — every caller already has it (either the fresh `score`
  // closure in an event handler, or `scoreRef.current` in the timer
  // callback) — rather than reading it back out of a ref itself, so this
  // stays a plain function with no hidden read of mutable state.
  const finishRound = useCallback(
    (finalScore: number) => {
      setPhase("finished");
      writeBestScore(finalScore, readBestScore());
      setHasMore(nextRound(headlines, readAnsweredIds(), 1).length > 0);
      setAnnouncement(`Oyun bitti. ${finalScore} / ${round.length} doğru.`);
    },
    [headlines, round.length],
  );

  // Single 60s countdown for the whole round (not per headline), driven
  // from a fixed deadline rather than a tick-decrement so ending the round
  // is a plain value assignment in the timer callback body — a legal
  // side-effect site — never inside a state updater. Stays running through
  // the "revealed" step too (not just "playing"), matching the "60
  // saniyede 10 manşet" copy: the round has a real wall-clock bound end to
  // end. Clears on unmount and whenever the round is no longer active.
  useEffect(() => {
    if (phase !== "playing" && phase !== "revealed") return;
    const id = window.setInterval(() => {
      const left = Math.max(0, Math.ceil((endsAtRef.current - Date.now()) / 1000));
      setSecondsLeft(left);
      if (ANNOUNCE_THRESHOLDS.includes(left) && !announcedThresholdsRef.current.has(left)) {
        announcedThresholdsRef.current.add(left);
        setAnnouncement(`${left} saniye kaldı`);
      }
      if (left === 0) {
        window.clearInterval(id);
        finishRound(scoreRef.current);
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, finishRound]);

  // Keyboard-only play: move focus to the control that matters for the
  // phase just entered, since each phase swaps in a different button
  // group and the browser would otherwise reset focus to <body>.
  useEffect(() => {
    if (phase === "revealed") {
      nextRef.current?.focus();
    } else if (phase === "playing") {
      firstZoneRef.current?.focus();
    } else if (phase === "finished") {
      replayRef.current?.focus();
    }
  }, [phase, index]);

  const current = round[index] ?? null;

  // "Yeni manşetlerle oyna": every headline of this page was answered, so load
  // /oyun again for a fresh server sample (sessionStorage keeps the answered
  // ids out of it). A full document load on purpose: a client-side
  // router.push to the same route would keep this component's state (the
  // finished round) and never re-sample.
  const handleFreshSample = useCallback(() => {
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.assign("/oyun");
  }, []);

  const handleStart = useCallback(() => {
    // The next round is the first GAME_ROUND_SIZE headlines of the page's list
    // this tab session has not answered (their outlet and zone were already
    // shown, so replaying them would be an informed guess).
    const next = nextRound(headlines, readAnsweredIds(), GAME_ROUND_SIZE);
    if (next.length === 0) {
      setAnnouncement(EMPTY_COPY);
      setPhase("empty");
      return;
    }
    setRound(next);
    setIndex(0);
    setScore(0);
    scoreRef.current = 0;
    endsAtRef.current = Date.now() + GAME_SECONDS * 1000;
    announcedThresholdsRef.current = new Set();
    setSecondsLeft(GAME_SECONDS);
    setGuessedZone(null);
    // The headline <p> sits outside the live region, so say it here: a screen
    // reader user would otherwise only hear the zone buttons.
    setAnnouncement(headlineAnnouncement(1, next.length, next[0]?.title));
    setPhase("playing");
  }, [headlines]);

  const handleGuess = useCallback(
    (zone: MediaDnaZone) => {
      if (!current || phase !== "playing") return;

      const isMatch = zone === current.zone;
      const nextScore = isMatch ? score + 1 : score;
      scoreRef.current = nextScore;
      setGuessedZone(zone);
      setScore(nextScore);
      setPhase("revealed");
      setAnnouncement(
        `${current.sourceName} · ${ZONE_META[current.zone].label}. ${
          isMatch ? "Doğru tahmin!" : "Bu sefer olmadı."
        }`,
      );

      // Fire-and-forget, and only the first time this headline is answered
      // blind in the tab session. See component doc comment: response
      // intentionally never read, and a rejected fetch must not surface to
      // the player.
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
    [current, phase, score],
  );

  const handleNext = useCallback(() => {
    const nextIndex = index + 1;
    setGuessedZone(null);
    if (nextIndex >= round.length) {
      finishRound(score);
      return;
    }
    setIndex(nextIndex);
    setAnnouncement(
      headlineAnnouncement(nextIndex + 1, round.length, round[nextIndex]?.title),
    );
    setPhase("playing");
  }, [index, round, finishRound, score]);

  // Always mounted regardless of phase, matching share-button.tsx's
  // permanently-mounted live region: an empty string renders nothing
  // audible, and every subsequent change (reveal sentence, time warning,
  // final score) is reliably announced because the node was already
  // present before the content changed.
  const announcementRegion = (
    <div className="sr-only" role="status" aria-live="polite">
      {announcement}
    </div>
  );

  // A round is at most GAME_ROUND_SIZE headlines (fewer when the page holds
  // fewer): the number the idle copy and the best-score line count.
  const roundSize = Math.min(GAME_ROUND_SIZE, headlines.length);

  let content: ReactNode;

  if (phase === "idle") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4">
        <p className="text-sm text-muted-foreground">
          {`${roundSize} manşet, 60 saniye. Hazır mısın?`}
        </p>
        {bestScore !== null && (
          <p className="text-[11px] text-muted-foreground">
            En iyi skorun: {bestScore} / {roundSize}
          </p>
        )}
        <button
          type="button"
          onClick={handleStart}
          className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Başla
        </button>
      </div>
    );
  } else if (phase === "empty") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4">
        <p className="text-sm text-muted-foreground">{EMPTY_COPY}</p>
      </div>
    );
  } else if (phase === "finished") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4">
        <p className="font-serif text-2xl">
          {score} / {round.length}
        </p>
        {bestScore !== null && (
          <p className="text-[11px] text-muted-foreground">
            En iyi skorun: {bestScore} / {roundSize}
          </p>
        )}
        {hasMore ? (
          <button
            ref={replayRef}
            type="button"
            onClick={handleStart}
            className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            Yeniden Oyna
          </button>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              Bu sayfadaki manşetlerin hepsini oynadın.
            </p>
            <button
              ref={replayRef}
              type="button"
              onClick={handleFreshSample}
              className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Yeni manşetlerle oyna
            </button>
          </>
        )}
      </div>
    );
  } else if (!current) {
    // Defensive — the round is non-empty whenever "playing" is reached
    // (handleStart only starts one with at least one headline and resets
    // index to 0), but guards against a drifted index.
    content = null;
  } else {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-5 space-y-5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span aria-label={`${index + 1}. manşet, toplam ${round.length}`}>
            {index + 1} / {round.length}
          </span>
          <span className="font-mono" aria-label={`${secondsLeft} saniye kaldı`}>
            {secondsLeft}s
          </span>
          <span aria-label={`${score} doğru tahmin`}>{score} doğru</span>
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
              {guessedZone === current.zone ? "Doğru tahmin!" : "Bu sefer olmadı."}
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
