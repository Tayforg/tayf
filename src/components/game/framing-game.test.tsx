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
      'setHeadline({ articleId: body.article_id, title: body.title });\n      headlineIdRef.current = body.article_id;',
    );
    expect(source).toContain("setHeadline(null);\n    headlineIdRef.current = null;");
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
      'fetch("/api/oyun/cerceve/next", {\n        method: "GET",\n        signal: AbortSignal.timeout(8000),\n      });',
    );
  });

  it("leaves the empty-pool copy untouched", () => {
    expect(source).toContain("Şu an oylanacak başlık yok. Birazdan tekrar dene.");
  });
});
