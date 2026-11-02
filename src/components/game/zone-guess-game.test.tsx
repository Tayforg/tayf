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

const fixtureHeadlines: GameHeadline[] = Array.from({ length: 10 }, (_, i) => ({
  articleId: `article-${i}`,
  sourceId: `source-${i}`,
  title: `Başlık ${i}`,
  sourceName: `Kaynak ${i}`,
  sourceSlug: `kaynak-${i}`,
  bias: "center",
  zone: "bagimsiz",
}));

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

describe("ZoneGuessGame — source guard: every new headline is announced to screen readers", () => {
  const handlerBody = (name: string, nextMarker: string): string => {
    const start = source.indexOf(`const ${name} = useCallback(`);
    const end = source.indexOf(nextMarker, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };

  it("handleStart announces headline 1 of the round instead of clearing the region", () => {
    const body = handlerBody("handleStart", "const handleGuess = useCallback(");
    expect(body).toContain("headlineAnnouncement(1, headlines.length, headlines[0]?.title)");
    expect(body).toContain("setAnnouncement(headlineAnnouncement(");
    expect(body).not.toContain('setAnnouncement("")');
  });

  it("handleNext announces the next headline right after moving the index", () => {
    const body = handlerBody("handleNext", "// Always mounted regardless of phase");
    const setIndexAt = body.indexOf("setIndex(nextIndex);");
    const announceAt = body.indexOf(
      "headlineAnnouncement(nextIndex + 1, headlines.length, headlines[nextIndex]?.title)",
    );
    expect(setIndexAt).toBeGreaterThan(-1);
    expect(announceAt).toBeGreaterThan(setIndexAt);
    expect(body.slice(setIndexAt, announceAt)).toContain("setAnnouncement(");
  });

  it("the handlers depend on `headlines` itself (they read its items), not just its length", () => {
    for (const [name, marker] of [
      ["handleStart", "const handleGuess = useCallback("],
      ["handleNext", "// Always mounted regardless of phase"],
    ] as const) {
      const body = handlerBody(name, marker);
      const deps = body.slice(body.lastIndexOf("}, ["));
      expect(deps, name).toContain("headlines");
      expect(deps, name).not.toContain("headlines.length");
    }
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
