import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FramingGame } from "./framing-game";

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
