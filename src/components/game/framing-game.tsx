"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";

import {
  FRAMING_ROUND_SECONDS,
  FRAMING_VOTES,
  FRAMING_VOTE_LABELS_TR,
  formatTallyLine,
  normalizeTally,
  summariseFramingRound,
  type FramingRoundEntry,
  type FramingTally,
  type FramingVote,
} from "@/lib/game/framing";

type Phase = "idle" | "loading" | "playing" | "revealed" | "finished";

interface CerceveHeadline {
  articleId: string;
  title: string;
}

interface NextPayload {
  article_id: string | null;
  title: string | null;
}

interface VotePayload {
  ok: boolean;
  totals: unknown;
}

// Coarse time warnings pushed into the persistent live region — mirrors
// zone-guess-game.tsx's ANNOUNCE_THRESHOLDS; never announce every second.
const ANNOUNCE_THRESHOLDS: readonly number[] = [30, 10];

const EMPTY_TALLY: FramingTally = { n: 0, iktidar: 0, muhalefet: 0, none: 0 };

/**
 * "use client" state machine for the Çerçeve ("Framing") mode: idle ->
 * loading -> playing -> revealed -> finished, modelled closely on
 * zone-guess-game.tsx (deadline-based 60s timer via `endsAtRef`, a single
 * permanently-mounted `role="status"` live region, focus management per
 * phase transition, `min-h-[44px]` tap targets, literal Tailwind classes).
 *
 * UNLIKE the Bölge mode (fire-and-forget POST), a Çerçeve vote's response
 * IS read here — the crowd tally is the entire payoff of playing. A
 * failed vote POST still advances the round, recorded locally with an
 * `n: 0` tally rather than interrupting play; a failed or empty headline
 * draw ends the round gracefully (never a thrown error visible to the
 * player) — showing the empty-pool message when nothing was ever drawn,
 * or the round summary when at least one headline was played.
 */
export function FramingGame() {
  const [phase, setPhase] = useState<Phase>("idle");
  const [headline, setHeadline] = useState<CerceveHeadline | null>(null);
  const [entries, setEntries] = useState<readonly FramingRoundEntry[]>([]);
  const [lastVote, setLastVote] = useState<FramingVote | null>(null);
  const [lastTally, setLastTally] = useState<FramingTally | null>(null);
  const [poolEmpty, setPoolEmpty] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(FRAMING_ROUND_SECONDS);
  const [announcement, setAnnouncement] = useState("");
  // Counts votes CAST (incremented synchronously in `handleVote`), not
  // settled POST responses — see `entriesRef` below for the latter.
  const [voted, setVoted] = useState(0);

  const endsAtRef = useRef(0);
  const announcedThresholdsRef = useRef<Set<number>>(new Set());
  // Escape hatch for async callbacks (fetch handlers) that would otherwise
  // close over a stale `entries` — same pattern as zone-guess-game.tsx's
  // `scoreRef`, updated directly at the point entries change.
  const entriesRef = useRef<readonly FramingRoundEntry[]>([]);
  // The articleId of the headline currently on screen, updated in lockstep
  // with `setHeadline`/`finishRound`. A vote POST's `.then`/`.catch` reads
  // this at commit time and only applies `setLastTally`/`setAnnouncement`
  // when it still matches the vote's own headline — otherwise a late
  // response for a since-replaced headline would paint the wrong tally.
  const headlineIdRef = useRef<string | null>(null);

  const firstVoteRef = useRef<HTMLButtonElement | null>(null);
  const nextRef = useRef<HTMLButtonElement | null>(null);
  const replayRef = useRef<HTMLButtonElement | null>(null);

  const recordEntry = useCallback((entry: FramingRoundEntry) => {
    entriesRef.current = [...entriesRef.current, entry];
    setEntries(entriesRef.current);
  }, []);

  const finishRound = useCallback(() => {
    setPhase("finished");
    setHeadline(null);
    headlineIdRef.current = null;
    setAnnouncement(summariseFramingRound(entriesRef.current).line);
  }, []);

  const drawHeadline = useCallback(async () => {
    setPhase("loading");
    try {
      const res = await fetch("/api/oyun/cerceve/next", {
        method: "GET",
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        if (entriesRef.current.length === 0) setPoolEmpty(true);
        finishRound();
        return;
      }
      const body = (await res.json()) as NextPayload;
      if (!body.article_id || !body.title) {
        if (entriesRef.current.length === 0) setPoolEmpty(true);
        finishRound();
        return;
      }
      setHeadline({ articleId: body.article_id, title: body.title });
      headlineIdRef.current = body.article_id;
      setLastVote(null);
      setLastTally(null);
      setPhase("playing");
    } catch {
      if (entriesRef.current.length === 0) setPoolEmpty(true);
      finishRound();
    }
  }, [finishRound]);

  const handleStart = useCallback(() => {
    entriesRef.current = [];
    setEntries([]);
    setPoolEmpty(false);
    setVoted(0);
    endsAtRef.current = Date.now() + FRAMING_ROUND_SECONDS * 1000;
    announcedThresholdsRef.current = new Set();
    setSecondsLeft(FRAMING_ROUND_SECONDS);
    setAnnouncement("");
    void drawHeadline();
  }, [drawHeadline]);

  // Single round-long countdown, active through "playing" and "revealed"
  // (matches zone-guess-game.tsx). Deadline-based so a brief pause during
  // "loading" (fetching the next headline) doesn't drift the true end time.
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
        finishRound();
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [phase, finishRound]);

  useEffect(() => {
    if (phase === "revealed") {
      nextRef.current?.focus();
    } else if (phase === "playing") {
      firstVoteRef.current?.focus();
    } else if (phase === "finished") {
      replayRef.current?.focus();
    }
  }, [phase]);

  const handleVote = useCallback(
    (vote: FramingVote) => {
      if (!headline || phase !== "playing") return;
      const articleId = headline.articleId;
      setLastVote(vote);
      setVoted((count) => count + 1);
      setPhase("revealed");

      fetch("/api/oyun/cerceve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ article_id: articleId, vote }),
      })
        .then(async (res) => {
          if (!res.ok) throw new Error("vote rejected");
          const payload = (await res.json()) as VotePayload;
          const tally = normalizeTally(payload.totals);
          // `recordEntry` stays unconditional — entry A is a legitimate
          // round entry regardless of which headline is now displayed.
          recordEntry({ vote, tally });
          // But only paint the tally/announcement when the on-screen
          // headline is still the one this vote was cast for — a late
          // response for a since-replaced headline must not overwrite it.
          if (headlineIdRef.current === articleId) {
            setLastTally(tally);
            setAnnouncement(`${FRAMING_VOTE_LABELS_TR[vote]}. ${formatTallyLine(tally)}`);
          }
        })
        .catch(() => {
          // A failed vote still advances the round — recorded locally
          // with an n:0 tally (unscored, not "wrong"). Never interrupt
          // play on a network failure, matching /api/oyun's fire-and
          // -forget stance, except here we still need a local entry.
          recordEntry({ vote, tally: EMPTY_TALLY });
          if (headlineIdRef.current === articleId) {
            setLastTally(EMPTY_TALLY);
            setAnnouncement("Oy kaydedilemedi, devam ediyoruz.");
          }
        });
    },
    [headline, phase, recordEntry],
  );

  const handleNext = useCallback(() => {
    void drawHeadline();
  }, [drawHeadline]);

  // Always mounted regardless of phase — see zone-guess-game.tsx's
  // announcementRegion doc comment for why this must never conditionally
  // mount.
  const announcementRegion = (
    <div className="sr-only" role="status" aria-live="polite">
      {announcement}
    </div>
  );

  // "Always visible in Çerçeve mode" per the shared contract — rendered
  // once outside the phase switch below rather than duplicated per phase.
  const honestNote = (
    <p className="text-[11px] text-muted-foreground">
      Oylar anonimdir; yalnızca toplu sayılar kullanılır.{" "}
      <Link href="/metodoloji" className="underline underline-offset-2 hover:text-foreground">
        Yöntem sayfası
      </Link>
      .
    </p>
  );

  let content: ReactNode;

  if (phase === "idle") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4">
        <p className="text-sm text-muted-foreground">Bu başlık kimin lehine yazılmış?</p>
        <button
          type="button"
          onClick={handleStart}
          className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          Başla
        </button>
      </div>
    );
  } else if (phase === "loading") {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4 min-h-[160px] flex flex-col items-center justify-center">
        <p className="text-sm text-muted-foreground">Başlık yükleniyor...</p>
      </div>
    );
  } else if (phase === "finished") {
    content = poolEmpty ? (
      <div className="rounded-xl border border-border/60 bg-card/40 p-8 text-center">
        <p className="text-sm text-muted-foreground">
          Şu an oylanacak başlık yok. Birazdan tekrar dene.
        </p>
      </div>
    ) : (
      (() => {
        const summary = summariseFramingRound(entries);
        return (
          <div className="rounded-xl border border-border/60 bg-card/40 p-6 text-center space-y-4">
            <p className="font-serif text-lg">{summary.line}</p>
            <p className="text-[11px] text-muted-foreground">{summary.detail}</p>
            <button
              ref={replayRef}
              type="button"
              onClick={handleStart}
              className="min-h-[44px] inline-flex items-center justify-center rounded-lg bg-primary px-6 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              Yeniden Oyna
            </button>
          </div>
        );
      })()
    );
  } else if (!headline) {
    // Defensive — "playing"/"revealed" only ever set with a headline
    // present, but guards against a drifted state.
    content = null;
  } else {
    content = (
      <div className="rounded-xl border border-border/60 bg-card/40 p-5 space-y-5">
        <div className="flex items-center justify-between text-[11px] text-muted-foreground">
          <span className="font-mono" aria-label={`${secondsLeft} saniye kaldı`}>
            {secondsLeft}s
          </span>
          <span aria-label={`${voted} oy`}>{voted} oy</span>
        </div>

        <p className="text-sm text-muted-foreground">Bu başlık kimin lehine yazılmış?</p>
        <p className="font-serif text-lg sm:text-xl leading-snug">{headline.title}</p>

        {phase === "playing" && (
          <div
            role="group"
            aria-label="Çerçeve oylaması"
            className="grid grid-cols-1 sm:grid-cols-3 gap-2"
          >
            {FRAMING_VOTES.map((vote, voteIndex) => (
              <button
                key={vote}
                ref={voteIndex === 0 ? firstVoteRef : undefined}
                type="button"
                onClick={() => handleVote(vote)}
                className="min-h-[44px] rounded-lg border px-4 py-2 text-sm font-medium transition-colors border-border/60 hover:bg-accent focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                {FRAMING_VOTE_LABELS_TR[vote]}
              </button>
            ))}
          </div>
        )}

        {phase === "revealed" && lastVote && (
          <div className="space-y-3">
            <p className="text-sm">
              {lastTally ? formatTallyLine(lastTally) : "Oy kaydediliyor..."}
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
      {honestNote}
    </>
  );
}
