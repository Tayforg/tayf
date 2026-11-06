import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  FRAMING_MIN_TALLY_N,
  FRAMING_VOTE_LABELS_TR,
  formatTallyLine,
  normalizeTally,
  type FramingTally,
  type FramingVote,
} from "@/lib/game/framing";
import { FramingGame } from "./framing-game";

// A scripted `useState` for the reveal tests at the end of this file: while `scripted.values` is set, the component's
// useState calls (in declaration order, named from the source) return those values instead of the initial ones, so the
// real JSX of the "revealed" phase can be rendered with renderToStaticMarkup. Everything else (useRef, useId, ...)
// stays real, and with `scripted.values === null` every call falls through to the real useState (the idle render).
const scripted = vi.hoisted(() => ({
  values: null as Record<string, unknown> | null,
  names: [] as string[],
  calls: 0,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: ((initial: unknown) => {
      if (scripted.values !== null) {
        const name = scripted.names[scripted.calls++];
        if (name !== undefined && name in scripted.values) return [scripted.values[name], () => undefined];
      }
      return (actual.useState as (i: unknown) => unknown)(initial);
    }) as typeof actual.useState,
  };
});

// ---------------------------------------------------------------------------
// PACK D — this file was previously missing, so three defects fixed
// alongside it had nothing pinning them: a late vote POST response could
// overwrite a newer headline's tally, the "X oy" counter under-counted by
// one vote for the entire reveal window, and the "loading" phase rendered a
// blank panel. `vitest.config.ts` runs with `environment: "node"` and this
// repo has neither jsdom nor @testing-library installed, so — mirroring
// zone-guess-game.test.tsx's established convention — coverage here is
// (A) a static render assertion via `renderToStaticMarkup` (idle phase
// only) and (B) source-level guard assertions via `readFileSync` + literal
// substring/regex checks for the async and later-phase behaviour
// `renderToStaticMarkup` can't reach.
// ---------------------------------------------------------------------------

const SOURCE_PATH = resolve(__dirname, "framing-game.tsx");
const source = readFileSync(SOURCE_PATH, "utf8");

describe("FramingGame — static render (idle phase)", () => {
  const html = renderToStaticMarkup(<FramingGame />);

  it("renders exactly one control (\"Başla\") and the persistent status region", () => {
    const buttonOpenTags = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttonOpenTags).toHaveLength(1);
    expect(buttonOpenTags[0]).toMatch(/type="button"/);
    expect(html).toContain('role="status"');
  });
});

describe("FramingGame — source guard: a late vote response cannot overwrite a newer headline's tally [stale tally]", () => {
  it("records the entry unconditionally, then guards setLastTally/setAnnouncement on headlineIdRef", () => {
    const handleVoteStart = source.indexOf("const handleVote = useCallback(");
    const handleVoteEnd = source.indexOf("const handleNext = useCallback(");
    expect(handleVoteStart).toBeGreaterThan(-1);
    expect(handleVoteEnd).toBeGreaterThan(handleVoteStart);
    const body = source.slice(handleVoteStart, handleVoteEnd);

    // Success path: recordEntry commits before, and independently of, the
    // guarded setLastTally/setAnnouncement.
    const recordSuccessIndex = body.indexOf("recordEntry({ vote, tally });");
    const guardSuccessIndex = body.indexOf(
      "if (headlineIdRef.current === articleId) {\n            setLastTally(tally);",
    );
    expect(recordSuccessIndex).toBeGreaterThan(-1);
    expect(guardSuccessIndex).toBeGreaterThan(recordSuccessIndex);

    // Failure path: same shape with the EMPTY_TALLY fallback.
    const recordCatchIndex = body.indexOf("recordEntry({ vote, tally: EMPTY_TALLY });");
    const guardCatchIndex = body.indexOf(
      "if (headlineIdRef.current === articleId) {\n            setLastTally(EMPTY_TALLY);",
    );
    expect(recordCatchIndex).toBeGreaterThan(-1);
    expect(guardCatchIndex).toBeGreaterThan(recordCatchIndex);
  });

  it("keeps headlineIdRef in lockstep with setHeadline (new draw) and finishRound (round end)", () => {
    expect(source).toContain(
      'setHeadline({ articleId: outcome.articleId, title: outcome.title });\n      headlineIdRef.current = outcome.articleId;',
    );
    expect(source).toContain("setHeadline(null);\n    headlineIdRef.current = null;");
  });
});

describe("FramingGame — source guard: the round clock only starts once a headline lands [round clock]", () => {
  it("handleStart resets the deadline sentinel instead of computing one", () => {
    const handleStartStart = source.indexOf("const handleStart = useCallback(");
    const handleStartEnd = source.indexOf("// Single round-long countdown");
    expect(handleStartStart).toBeGreaterThan(-1);
    const body = source.slice(handleStartStart, handleStartEnd);
    expect(body).toContain("endsAtRef.current = 0;");
    expect(body).not.toContain("Date.now() + FRAMING_ROUND_SECONDS");
  });

  it("drawHeadline classifies the response and starts the clock via startRoundClock", () => {
    const drawStart = source.indexOf("const drawHeadline = useCallback(");
    const drawEnd = source.indexOf("const handleStart = useCallback(");
    expect(drawStart).toBeGreaterThan(-1);
    const body = source.slice(drawStart, drawEnd);
    expect(body).toContain("fetchDrawResponse(");
    expect(body).toContain("classifyDrawResponse(res)");
    expect(body).toContain("startRoundClock(");
  });

  it("renders 'Tekrar dene' only in the error branch", () => {
    const occurrences = source.split("Tekrar dene").length - 1;
    expect(occurrences).toBe(1);
    const errorStart = source.indexOf('phase === "error") {');
    const errorEnd = source.indexOf('phase === "finished") {', errorStart);
    expect(errorStart).toBeGreaterThan(-1);
    expect(errorEnd).toBeGreaterThan(errorStart);
    expect(source.slice(errorStart, errorEnd)).toContain("Tekrar dene");
  });

  it("setPoolEmpty(true) appears only in the pool-empty branch", () => {
    const occurrences = source.split("setPoolEmpty(true)").length - 1;
    expect(occurrences).toBe(1);
    const poolEmptyIndex = source.indexOf('outcome.kind === "pool-empty"');
    const errorCommentIndex = source.indexOf('// outcome.kind === "error"');
    expect(poolEmptyIndex).toBeGreaterThan(-1);
    expect(errorCommentIndex).toBeGreaterThan(poolEmptyIndex);
    const poolEmptyBody = source.slice(poolEmptyIndex, errorCommentIndex);
    expect(poolEmptyBody).toContain("setPoolEmpty(true)");
  });
});

describe("FramingGame — source guard: the 'X oy' counter reflects votes cast, not settled responses [voted counter]", () => {
  it("increments `voted` synchronously in handleVote, before the fetch's .then", () => {
    const handleVoteStart = source.indexOf("const handleVote = useCallback(");
    const handleVoteEnd = source.indexOf("const handleNext = useCallback(");
    const body = source.slice(handleVoteStart, handleVoteEnd);

    const incrementIndex = body.indexOf("setVoted((count) => count + 1);");
    const thenIndex = body.indexOf(".then(");
    expect(incrementIndex).toBeGreaterThan(-1);
    expect(thenIndex).toBeGreaterThan(incrementIndex);
  });

  it("renders the counter from `voted`, never from settled `entries.length`", () => {
    expect(source).toContain('<span aria-label={`${voted} oy`}>{voted} oy</span>');
    expect(source).not.toMatch(/\{entries\.length\}\s*oy/);
  });

  it("resets `voted` to 0 whenever a round starts", () => {
    const handleStartStart = source.indexOf("const handleStart = useCallback(");
    const handleStartEnd = source.indexOf("// Single round-long countdown");
    expect(handleStartStart).toBeGreaterThan(-1);
    const body = source.slice(handleStartStart, handleStartEnd);
    expect(body).toContain("setVoted(0);");
  });
});

describe("FramingGame — source guard: the loading phase never renders a blank panel [loading state]", () => {
  it("does not set content to null while phase is \"loading\"", () => {
    expect(source).not.toContain('phase === "loading") {\n    content = null;');
  });

  it("renders a visible Turkish loading line inside a fixed-min-height panel", () => {
    const loadingStart = source.indexOf('phase === "loading") {');
    const loadingEnd = source.indexOf('phase === "finished") {', loadingStart);
    expect(loadingStart).toBeGreaterThan(-1);
    expect(loadingEnd).toBeGreaterThan(loadingStart);
    const body = source.slice(loadingStart, loadingEnd);
    expect(body).toContain("Başlık yükleniyor...");
    expect(body).toMatch(/min-h-\[\d+px\]/);
  });

  it("times out the headline draw fetch so a stall falls through to finishRound, not a hang", () => {
    expect(source).toContain(
      'fetch("/api/oyun/cerceve/next", {\n        method: "GET",\n        signal: AbortSignal.timeout(8000),\n      }),',
    );
  });

  it("leaves the empty-pool copy untouched", () => {
    expect(source).toContain("Şu an oylanacak başlık yok. Birazdan tekrar dene.");
  });
});

/**
 * Every `useEffect(...)` call in `src`, as its full source text, found by
 * scanning for the closing parenthesis (a character scan, not a regex).
 */
function useEffectCalls(src: string): string[] {
  const calls: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf("useEffect(", from);
    if (at === -1) return calls;
    const open = at + "useEffect".length;
    let depth = 0;
    let close = -1;
    for (let i = open; i < src.length; i++) {
      const ch = src[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    if (close === -1) return calls;
    calls.push(src.slice(at, close + 1));
    from = close + 1;
  }
}

describe("FramingGame — source guard: every drawn headline is announced to screen readers", () => {
  const drawStart = source.indexOf("const drawHeadline = useCallback(");
  const drawEnd = source.indexOf("const handleStart = useCallback(");
  const drawBody = source.slice(drawStart, drawEnd);

  it("drawHeadline announces 'n. title' right after the headline lands (the title is not known before)", () => {
    expect(drawStart).toBeGreaterThan(-1);
    expect(drawEnd).toBeGreaterThan(drawStart);
    const pinned =
      "setHeadline({ articleId: outcome.articleId, title: outcome.title });\n      headlineIdRef.current = outcome.articleId;";
    const pinnedAt = drawBody.indexOf(pinned);
    expect(pinnedAt).toBeGreaterThan(-1);
    const countAt = drawBody.indexOf("drawnCountRef.current += 1;");
    const announceAt = drawBody.indexOf(
      "setAnnouncement(headlineAnnouncement(drawnCountRef.current, null, outcome.title));",
    );
    expect(countAt).toBeGreaterThan(pinnedAt);
    expect(announceAt).toBeGreaterThan(countAt);
  });

  it("announces only in the headline branch, never on pool-empty or error", () => {
    expect(drawBody.split("headlineAnnouncement(")).toHaveLength(2);
    const poolEmptyAt = drawBody.indexOf('outcome.kind === "pool-empty"');
    expect(drawBody.indexOf("headlineAnnouncement(")).toBeLessThan(poolEmptyAt);
  });

  it("counts draws in a ref that handleStart resets, and keeps the empty announcement there", () => {
    expect(source).toContain("const drawnCountRef = useRef(0);");
    const startAt = source.indexOf("const handleStart = useCallback(");
    const endAt = source.indexOf("// Single round-long countdown");
    const body = source.slice(startAt, endAt);
    expect(body).toContain("drawnCountRef.current = 0;");
    expect(body).toContain('setAnnouncement("");');
    expect(body).not.toContain("headlineAnnouncement(");
  });

  it("handleNext only redraws, so the announcement comes from drawHeadline", () => {
    const start = source.indexOf("const handleNext = useCallback(");
    const end = source.indexOf("// Always mounted regardless of phase", start);
    const body = source.slice(start, end);
    expect(body).toContain("void drawHeadline();");
    expect(body).not.toContain("setAnnouncement(");
  });

  it("no useEffect body announces a headline (set-state-in-effect is a lint error here)", () => {
    const effects = useEffectCalls(source);
    expect(effects.length).toBeGreaterThanOrEqual(2);
    for (const call of effects) {
      expect(call).not.toContain("setAnnouncement(headlineAnnouncement");
    }
  });

  it("describes the vote group by the headline", () => {
    expect(source.split("aria-describedby={headlineId}")).toHaveLength(2);
    expect(source.split("id={headlineId}")).toHaveLength(2);
    expect(source).toContain("const headlineId = useId();");
    expect(source).toContain('aria-label="Çerçeve oylaması"');
  });

  it("keeps the live region permanently mounted", () => {
    expect(source).toContain('<div className="sr-only" role="status" aria-live="polite">');
    expect(source).toMatch(/\{announcementRegion\}/);
  });

  it("useEffectCalls finds every effect and only effects", () => {
    const sample = "a(); useEffect(() => { if (x) { y(`${z}`); } }, [x]); b(); useEffect(() => {}, []);";
    expect(useEffectCalls(sample)).toEqual([
      "useEffect(() => { if (x) { y(`${z}`); } }, [x])",
      "useEffect(() => {}, [])",
    ]);
  });
});

// ---------------------------------------------------------------------------
// h52-game-2: the reveal must not print the player's own vote back as a "crowd"
// percentage below the n >= FRAMING_MIN_TALLY_N floor the round summary uses.
// POST /api/oyun/cerceve upserts the caller's vote BEFORE it reads framing_vote_totals,
// so the returned tally already includes the caller: with n = 1 the old reveal read
// "1 oy · İktidar %100 · Muhalefet %0 · Tarafsız %0", and the summary then said there
// was not enough data to compare.
// ---------------------------------------------------------------------------

/** The useState names of the component, in declaration order (read from the source, so a new state cannot shift the script). */
const stateNames = [...source.matchAll(/const \[(\w+), set\w+\] = useState/g)].map((m) => m[1] as string);

/** What the vote handler does with the body POST /api/oyun/cerceve answers with ({ ok, totals }). */
function tallyOfVoteResponse(payload: { ok: boolean; totals: unknown }): FramingTally {
  return normalizeTally(payload.totals);
}

/** Renders the revealed phase of the real component for a vote and the tally its POST returned. */
function renderRevealed(vote: FramingVote, tally: FramingTally | null, announcement = ""): string {
  scripted.values = {
    phase: "revealed",
    headline: { articleId: "00000000-0000-0000-0000-000000000001", title: "Bir başlık" },
    lastVote: vote,
    lastTally: tally,
    secondsLeft: 42,
    announcement,
    voted: 1,
  };
  scripted.names = stateNames;
  scripted.calls = 0;
  try {
    return renderToStaticMarkup(<FramingGame />);
  } finally {
    scripted.values = null;
  }
}

/** The text of the paragraph that holds the crowd line in the revealed phase. */
function revealLine(html: string): string {
  const m = html.match(/<p class="text-sm">([^<]*)<\/p>/);
  expect(m, 'the reveal <p class="text-sm">').not.toBeNull();
  return (m as RegExpMatchArray)[1] as string;
}

describe("FramingGame — reveal below the n >= 3 floor [h52-game-2]", () => {
  it("the scripted render reaches the revealed phase (the harness itself is not vacuous)", () => {
    expect(stateNames).toEqual([
      "phase",
      "headline",
      "entries",
      "lastVote",
      "lastTally",
      "poolEmpty",
      "secondsLeft",
      "announcement",
      "voted",
    ]);
    const html = renderRevealed("iktidar", null);
    expect(html).toContain("Bir başlık");
    expect(html).toContain("Oy kaydediliyor...");
    expect(html).toContain("Sonraki");
    expect(html).not.toContain("Çerçeve oylaması"); // the vote buttons belong to the playing phase
  });

  it("a mocked POST that answers totals n = 1 (the player's own vote): the revealed text has no '%100' and says there are not enough votes", () => {
    const tally = tallyOfVoteResponse({ ok: true, totals: { n: 1, iktidar: 1, muhalefet: 0, none: 0 } });
    const html = renderRevealed("iktidar", tally);
    expect(html).not.toContain("%100");
    expect(html).toContain("yeterli oy yok");
    expect(revealLine(html)).toBe(`Bu başlık için henüz yeterli oy yok (1/${FRAMING_MIN_TALLY_N}).`);
    expect(revealLine(html)).not.toContain("%");
    expect(html).not.toContain("İktidar %");
  });

  it("the same for the route's SQL column name (neutral_n) and for n = 2: still no percentage", () => {
    const sqlShape = tallyOfVoteResponse({ ok: true, totals: { n: 2, iktidar: 1, muhalefet: 0, neutral_n: 1 } });
    const html = renderRevealed("none", sqlShape);
    expect(revealLine(html)).toBe("Bu başlık için henüz yeterli oy yok (2/3).");
    expect(html).not.toMatch(/%\d/);
  });

  it("from n = 3 on the reveal still prints the percentage line, unchanged", () => {
    const tally = tallyOfVoteResponse({ ok: true, totals: { n: 3, iktidar: 2, muhalefet: 1, none: 0 } });
    const html = renderRevealed("iktidar", tally);
    expect(revealLine(html)).toBe("3 oy · İktidar %67 · Muhalefet %33 · Tarafsız %0");
    expect(html).not.toContain("yeterli oy yok");
  });

  it("an empty tally (a failed vote POST records n = 0) keeps 'Henüz oy yok', and no tally yet keeps 'Oy kaydediliyor...'", () => {
    expect(revealLine(renderRevealed("none", { n: 0, iktidar: 0, muhalefet: 0, none: 0 }))).toBe("Henüz oy yok");
    expect(revealLine(renderRevealed("none", null))).toBe("Oy kaydediliyor...");
  });

  it("the live-region announcement is built from the same line: label, then formatTallyLine(tally), so it has no '%' below the floor either", () => {
    // the announcement is set inside the vote handler, which a DOM-less test cannot run: pin its composition in the
    // source, then evaluate that composition on the mocked response
    expect(source).toContain("setAnnouncement(`${FRAMING_VOTE_LABELS_TR[vote]}. ${formatTallyLine(tally)}`);");
    const vote: FramingVote = "iktidar";
    const tally = tallyOfVoteResponse({ ok: true, totals: { n: 1, iktidar: 1, muhalefet: 0, none: 0 } });
    const announcement = `${FRAMING_VOTE_LABELS_TR[vote]}. ${formatTallyLine(tally)}`;
    expect(announcement).toBe(`İktidar lehine. Bu başlık için henüz yeterli oy yok (1/${FRAMING_MIN_TALLY_N}).`);
    expect(announcement).not.toContain("%");
    // and the live region renders what the handler stored
    expect(renderRevealed(vote, tally, announcement)).toContain(
      `<div class="sr-only" role="status" aria-live="polite">${announcement}</div>`,
    );
  });

  it("source guard: the reveal and the announcement go through formatTallyLine; the component formats no percentage of its own", () => {
    expect(source).toContain('{lastTally ? formatTallyLine(lastTally) : "Oy kaydediliyor..."}');
    expect(source.split("formatTallyLine(").length - 1).toBe(2);
    expect(source).not.toContain("roundPercents");
    expect(source).not.toContain("Math.round(");
    expect(source).not.toContain("İktidar %");
    // the tally the handler stores is the normalised POST body, nothing else
    expect(source).toContain("const tally = normalizeTally(payload.totals);");
    // the floor lives in framing.ts only
    expect(source).not.toContain("FRAMING_MIN_TALLY_N");
  });
});
