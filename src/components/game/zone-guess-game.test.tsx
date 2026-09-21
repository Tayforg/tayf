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
