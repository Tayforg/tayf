import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ZoneGuessGame } from "./zone-guess-game";
import type { GameHeadline } from "@/lib/game/headline-pool";

// ---------------------------------------------------------------------------
// MF-08: this file was previously untested, so the acceptance criterion —
// "the game is playable end to end with keyboard only, stores no cookies,
// and survives a 429 or a network failure on a guess without interrupting
// play" — was asserted by nothing. `vitest.config.ts` runs with
// `environment: "node"` and this repo has neither jsdom nor
// @testing-library installed, so no simulated clicks/events: coverage here
// follows the repo's two actual conventions instead —
//
//   (A) static render assertions via `renderToStaticMarkup`
//       (src/components/story/share-button.test.tsx), which only sees the
//       component's initial ("idle") render, and
//   (B) source-level guard assertions via `readFileSync` + regex
//       (tests/migrations/zone-parity.test.ts), which cover behaviour
//       `renderToStaticMarkup` can't reach (later phases, the fetch call's
//       error handling) by reading the component's own source text.
//
// Each `it(...)` below names, in its title or a leading comment, which
// half of the acceptance criterion it defends.
// ---------------------------------------------------------------------------

const SOURCE_PATH = resolve(__dirname, "zone-guess-game.tsx");
const MODES_PATH = resolve(__dirname, "oyun-modes.tsx");

const source = readFileSync(SOURCE_PATH, "utf8");

function makeFixture(count: number): GameHeadline[] {
  return Array.from({ length: count }, (_, i) => ({
    articleId: `article-${i}`,
    clusterId: `cluster-${i}`,
    sourceId: `source-${i}`,
    title: `Başlık ${i}`,
    sourceName: `Kaynak ${i}`,
    sourceSlug: `kaynak-${i}`,
    bias: "center",
    zone: "bagimsiz",
  }));
}

// A page session holds 30 headlines; a round plays 10 of them.
const fixtureHeadlines: GameHeadline[] = makeFixture(30);

describe("ZoneGuessGame — static render (idle phase)", () => {
  const html = renderToStaticMarkup(<ZoneGuessGame headlines={fixtureHeadlines} />);

  it("every interactive control is a real <button type=\"button\">", () => {
    // Keyboard-only playability: every affordance must be a real button
    // (native Tab/Enter/Space support), not a div/span with an onClick.
    const buttonOpenTags = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttonOpenTags.length).toBeGreaterThan(0);
    for (const tag of buttonOpenTags) {
      expect(tag).toMatch(/type="button"/);
    }
    // The idle phase renders exactly one control ("Başla").
    expect(buttonOpenTags).toHaveLength(1);
  });

  it("renders a persistent role=\"status\" live region that starts empty and contains no button", () => {
    const statusMatch = html.match(
      /<div class="sr-only" role="status" aria-live="polite">([^<]*)<\/div>/,
    );
    expect(statusMatch).not.toBeNull();
    expect(statusMatch![1]).toBe("");
    expect(statusMatch![0]).not.toContain("<button");
  });

  it("renders nothing that sets a cookie", () => {
    expect(html.toLowerCase()).not.toContain("cookie");
  });

  it("with a 30-headline session the idle copy promises one round: '10 manşet, 60 saniye'", () => {
    expect(html).toContain("10 manşet, 60 saniye. Hazır mısın?");
    expect(html).not.toContain("30 manşet");
  });

  it("with fewer headlines than a round the idle copy counts the headlines it has", () => {
    const few = renderToStaticMarkup(<ZoneGuessGame headlines={makeFixture(4)} />);
    expect(few).toContain("4 manşet, 60 saniye. Hazır mısın?");
    expect(few).not.toContain("10 manşet");
  });

  it("with exactly a round of headlines the idle copy says 10", () => {
    const ten = renderToStaticMarkup(<ZoneGuessGame headlines={makeFixture(10)} />);
    expect(ten).toContain("10 manşet, 60 saniye. Hazır mısın?");
  });
});

describe("ZoneGuessGame — source guard: every onClick target is a <button> [keyboard-only]", () => {
  it("no div/span carries an onClick handler", () => {
    const tagsWithOnClick = [...source.matchAll(/<(\w+)(?:(?!<|>)[\s\S])*?onClick=/g)].map(
      (m) => m[1],
    );
    expect(tagsWithOnClick.length).toBeGreaterThan(0);
    for (const tag of tagsWithOnClick) {
      expect(tag).toBe("button");
    }
  });
});

describe("ZoneGuessGame — source guard: guess fetch never blocks on a 429 or network failure", () => {
  it("the /api/oyun call is fire-and-forget: not awaited, and its response is never read", () => {
    expect(source).toContain('fetch("/api/oyun"');
    // Not awaited and not chained with `.then(` — a rejected/slow promise
    // must never hold up `handleGuess`, which has already updated local
    // state (score/phase/reveal) before the fetch call runs.
    expect(source).not.toMatch(/await\s+fetch\(/);
    expect(source).not.toMatch(/fetch\("\/api\/oyun"[\s\S]*?\.then\(/);
    // The response is discarded entirely — no status/body inspection of
    // any kind, so a 429 (or a thrown network error, caught below) can
    // never change what the player sees.
    expect(source).not.toMatch(/\.ok\b/);
    expect(source).not.toMatch(/\.json\(\)/);
  });

  it("the /api/oyun call is `.catch`-guarded", () => {
    expect(source).toMatch(/fetch\("\/api\/oyun"[\s\S]*?\}\)\.catch\(\(\) => \{\}\);/);
  });
});

describe("ZoneGuessGame — source guard: no cookies", () => {
  it("never reads or writes document.cookie", () => {
    expect(source).not.toContain("document.cookie");
  });

  it("the only persisted key is the personal-best localStorage key, not a cookie", () => {
    expect(source).toContain("window.localStorage");
    expect(source).not.toMatch(/\bcookie\b/i);
  });
});

describe("OyunModes empty pool branch [source guard]", () => {
  it("renders the 'no headlines' message when the pool is empty", () => {
    const pageSource = readFileSync(MODES_PATH, "utf8");
    expect(pageSource).toMatch(/headlines\.length === 0/);
    expect(pageSource).toContain("Şu an oynanacak başlık yok");
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

/**
 * The tokens of the dependency array that closes a `useCallback` (the last
 * `[...]` in its source), e.g. `}, [index, round, finishRound, score]);` ->
 * ["index", "round", "finishRound", "score"]. Token-exact, so "round" is never
 * confused with "finishRound".
 */
function depsOf(body: string): string[] {
  const open = body.lastIndexOf("[");
  expect(open).toBeGreaterThan(-1);
  const close = body.indexOf("]", open);
  expect(close).toBeGreaterThan(open);
  return body
    .slice(open + 1, close)
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

describe("ZoneGuessGame — source guard: every new headline is announced to screen readers", () => {
  const handlerBody = (name: string, nextMarker: string): string => {
    const start = source.indexOf(`const ${name} = useCallback(`);
    const end = source.indexOf(nextMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("handleStart announces headline 1 of the round it just drew instead of clearing the region", () => {
    const body = handlerBody("handleStart", "const handleGuess = useCallback(");
    expect(body).toContain("headlineAnnouncement(1, next.length, next[0]?.title)");
    expect(body).toContain("setAnnouncement(headlineAnnouncement(");
    expect(body).not.toContain('setAnnouncement("")');
  });

  it("handleNext announces the next headline of the round right after moving the index", () => {
    const body = handlerBody("handleNext", "// Always mounted regardless of phase");
    const setIndexAt = body.indexOf("setIndex(nextIndex);");
    const announceAt = body.indexOf(
      "headlineAnnouncement(nextIndex + 1, round.length, round[nextIndex]?.title)",
    );
    expect(setIndexAt).toBeGreaterThan(-1);
    expect(announceAt).toBeGreaterThan(setIndexAt);
    expect(body.slice(setIndexAt, announceAt)).toContain("setAnnouncement(");
  });

  it("handleStart depends on `headlines` (the pool it draws from), handleNext on `round` (the headlines it reads)", () => {
    const start = depsOf(handlerBody("handleStart", "const handleGuess = useCallback("));
    expect(start).toContain("headlines");
    expect(start).not.toContain("headlines.length");

    const next = depsOf(handlerBody("handleNext", "// Always mounted regardless of phase"));
    expect(next).toContain("round");
    expect(next).not.toContain("round.length");
    expect(next).not.toContain("headlines");
  });

  it("no useEffect body announces a headline (set-state-in-effect is a lint error here)", () => {
    const effects = useEffectCalls(source);
    // The timer effect and the focus effect.
    expect(effects.length).toBeGreaterThanOrEqual(2);
    for (const call of effects) {
      expect(call).not.toContain("setAnnouncement(headlineAnnouncement");
    }
  });

  it("describes the guess group by the headline", () => {
    expect(source.split("aria-describedby={headlineId}")).toHaveLength(2);
    expect(source.split("id={headlineId}")).toHaveLength(2);
    expect(source).toContain("const headlineId = useId();");
    expect(source).toContain('aria-label="Taraf tahmini"');
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

describe("ZoneGuessGame — source guard: a guess is POSTed only the first time a headline is answered", () => {
  const start = source.indexOf("const handleGuess = useCallback(");
  const end = source.indexOf("const handleNext = useCallback(");
  const body = source.slice(start, end);

  it("handleGuess gates the fetch with markAnswered(current.articleId)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const gateAt = body.indexOf("if (markAnswered(current.articleId)) {");
    const fetchAt = body.indexOf('fetch("/api/oyun"');
    expect(gateAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeGreaterThan(gateAt);
    expect(body.slice(fetchAt)).toContain("}).catch(() => {});");
  });

  it("the local score and the reveal do not depend on the gate (they run before it)", () => {
    const gateAt = body.indexOf("if (markAnswered(current.articleId)) {");
    for (const call of ["setGuessedZone(zone)", "setScore(nextScore)", 'setPhase("revealed")']) {
      const at = body.indexOf(call);
      expect(at, call).toBeGreaterThan(-1);
      expect(at, call).toBeLessThan(gateAt);
    }
  });

  it("the only /api/oyun call in the file sits behind the gate", () => {
    expect(source.split('fetch("/api/oyun"')).toHaveLength(2);
  });
});

describe("ZoneGuessGame — source guard: a round is drawn from the headlines not yet answered", () => {
  const start = source.indexOf("const handleStart = useCallback(");
  const end = source.indexOf("const handleGuess = useCallback(");
  const body = source.slice(start, end);

  it("handleStart draws the next round from the unanswered headlines and no longer reads headlines[0]", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).toContain("nextRound(headlines, readAnsweredIds(), GAME_ROUND_SIZE)");
    expect(body).not.toContain("headlines[0]");
    expect(body).toContain("setRound(next)");
  });

  it("handleStart goes to the empty phase (no timer) when nothing unanswered is left", () => {
    const emptyAt = body.indexOf('setPhase("empty")');
    const timerAt = body.indexOf("endsAtRef.current = ");
    expect(emptyAt).toBeGreaterThan(-1);
    expect(timerAt).toBeGreaterThan(emptyAt);
    expect(body).toContain("next.length === 0");
  });

  it("every in-round read moves from `headlines` to `round`", () => {
    expect(source).toContain("const current = round[index] ?? null;");
    expect(source).not.toContain("headlines[index]");
    expect(source).not.toContain("headlines[nextIndex]");
    expect(source).toContain("`${index + 1}. manşet, toplam ${round.length}`");
    expect(source).toContain("{index + 1} / {round.length}");
    expect(source).toContain("{score} / {round.length}");
    expect(source).toContain("`Oyun bitti. ${finalScore} / ${round.length} doğru.`");
    expect(source).toContain("nextIndex >= round.length");
  });

  it("the round size comes from round-size.ts, the same constant the sampler uses", () => {
    expect(source).toContain('import { GAME_ROUND_SIZE } from "@/lib/game/round-size";');
    expect(source).toContain("Math.min(GAME_ROUND_SIZE, headlines.length)");
  });

  it("headline-pool is imported type-only: a value import would pull next/cache and a \"use cache\" function into the client bundle and break `next build`", () => {
    const poolImports = source
      .split("\n")
      .filter((line) => line.startsWith("import ") && line.includes("@/lib/game/headline-pool"));
    expect(poolImports).toEqual(['import type { GameHeadline } from "@/lib/game/headline-pool";']);
  });

  it("answered ids are read from handlers only, never during render or in an effect body", () => {
    for (const call of useEffectCalls(source)) {
      expect(call).not.toContain("readAnsweredIds");
      expect(call).not.toContain("markAnswered");
    }
    const renderStart = source.indexOf("const announcementRegion = (");
    expect(renderStart).toBeGreaterThan(-1);
    expect(source.slice(renderStart)).not.toContain("readAnsweredIds");
    expect(source.slice(renderStart)).not.toContain("nextRound(");
  });
});

describe("ZoneGuessGame — source guard: finished and empty screens", () => {
  const FINISHED_ALL = "Bu sayfadaki manşetlerin hepsini oynadın.";
  const FRESH_BUTTON = "Yeni manşetlerle oyna";
  const EMPTY = "Şimdilik oynamadığın manşet kalmadı. Biraz sonra tekrar dene.";

  it("has the all-played copy, the fresh-sample button and the empty-phase copy", () => {
    expect(source).toContain(FINISHED_ALL);
    expect(source).toContain(FRESH_BUTTON);
    expect(source).toContain(EMPTY);
    expect(source).toContain("Yeniden Oyna");
  });

  it("finishRound works out whether a further unanswered headline exists", () => {
    const start = source.indexOf("const finishRound = useCallback(");
    const end = source.indexOf("// Single 60s countdown");
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, end);
    expect(body).toContain("setHasMore(nextRound(headlines, readAnsweredIds(), 1).length > 0);");
    expect(depsOf(body)).toEqual(["headlines", "round.length"]);
  });

  it("'Yeni manşetlerle oyna' loads a fresh server sample of /oyun", () => {
    expect(source).toContain('window.location.assign("/oyun")');
  });

  it("the empty phase renders no button and starts no timer", () => {
    const emptyBranchAt = source.indexOf('phase === "empty"');
    expect(emptyBranchAt).toBeGreaterThan(-1);
    const nextBranchAt = source.indexOf("} else if", emptyBranchAt);
    const branch = source.slice(emptyBranchAt, nextBranchAt === -1 ? undefined : nextBranchAt);
    expect(branch).toContain("EMPTY_COPY");
    expect(branch).not.toContain("<button");
    const timerEffect = useEffectCalls(source).find((call) => call.includes("setInterval"));
    expect(timerEffect).toContain('phase !== "playing" && phase !== "revealed"');
  });

  it("replayRef sits on whichever finished-screen button is shown (one per branch)", () => {
    expect(source.split("ref={replayRef}")).toHaveLength(3);
  });
});

describe("/oyun page — samples a whole page session, not a single round", () => {
  it("draws GAME_SESSION_SIZE headlines per request and keeps the pinned strings", () => {
    const pageSource = readFileSync(resolve(__dirname, "../../app/oyun/page.tsx"), "utf8");
    expect(pageSource).toContain("sampleHeadlines(pool, GAME_SESSION_SIZE)");
    expect(pageSource).toContain('import { GAME_SESSION_SIZE } from "@/lib/game/round-size";');
    expect(pageSource).toContain("searchParams: Promise<{ mod?: string; gun?: string | string[] }>;");
  });
});
