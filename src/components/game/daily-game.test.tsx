import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DailyGame } from "./daily-game";
import type { DailyHeadline, DailyPuzzle } from "@/lib/game/daily-set";

// ---------------------------------------------------------------------------
// Same two-pronged convention zone-guess-game.test.tsx uses: (A) static
// render assertions via `renderToStaticMarkup` (only sees the idle phase,
// since useSyncExternalStore's server snapshot is null — no localStorage
// during a static render) and (B) source-level guard assertions via
// `readFileSync` + regex for behaviour the static render can't reach.
// ---------------------------------------------------------------------------

const SOURCE_PATH = resolve(__dirname, "daily-game.tsx");
const source = readFileSync(SOURCE_PATH, "utf8");

const fixtureHeadlines: DailyHeadline[] = Array.from({ length: 5 }, (_, i) => ({
  articleId: `article-${i}`,
  sourceId: `source-${i}`,
  title: `Başlık ${i} — siyasi bir gelişme yaşandı bugün`,
  url: `https://ornek.com/${i}`,
  sourceName: `Kaynak ${i}`,
  sourceSlug: `kaynak-${i}`,
  zone: (["iktidar", "bagimsiz", "muhalefet"] as const)[i % 3]!,
  clusterId: i % 2 === 0 ? `cluster-${i}` : null,
}));

const fixturePuzzle: DailyPuzzle = {
  dateKey: "2026-09-28",
  number: 1,
  windowLabel: "27 Eylül 2026",
  headlines: fixtureHeadlines,
};

describe("DailyGame — static render (idle phase)", () => {
  const html = renderToStaticMarkup(<DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" />);

  it("shows the puzzle number and the window label", () => {
    expect(html).toContain("Günün Tayf");
    expect(html).toContain("#1");
    expect(html).toContain("27 Eylül 2026");
  });

  it("renders exactly one button, and every button is type=\"button\"", () => {
    const buttonOpenTags = html.match(/<button\b[^>]*>/g) ?? [];
    expect(buttonOpenTags).toHaveLength(1);
    for (const tag of buttonOpenTags) {
      expect(tag).toMatch(/type="button"/);
    }
  });

  it("renders a persistent role=\"status\" live region", () => {
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });
});

describe("DailyGame — static render (null puzzle)", () => {
  it("shows the empty-state copy", () => {
    const html = renderToStaticMarkup(<DailyGame puzzle={null} todayKey="2026-09-28" />);
    expect(html).toContain("Bugünün 5 manşeti hazırlanamadı");
    // No interactive controls when there's nothing to play.
    expect(html.match(/<button\b[^>]*>/g) ?? []).toHaveLength(0);
  });
});

describe("DailyGame — source guard: guess fetch is fire-and-forget", () => {
  it("the /api/oyun call is `.catch`-guarded and its response is never read", () => {
    expect(source).toContain('fetch("/api/oyun"');
    expect(source).not.toMatch(/await\s+fetch\(/);
    expect(source).not.toMatch(/\.ok\b/);
    expect(source).not.toMatch(/\.json\(\)/);
    expect(source).toMatch(/\}\)\.catch\(\(\) => \{\}\);/);
  });
});

describe("DailyGame — source guard: localStorage", () => {
  it("every localStorage call is wrapped in try/catch", () => {
    expect(source).toContain("window.localStorage");
    const localStorageLines = source
      .split("\n")
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => line.includes("window.localStorage"));
    expect(localStorageLines.length).toBeGreaterThan(0);
    for (const { i } of localStorageLines) {
      // A `try {` must appear within a few lines above each localStorage call.
      const context = source.split("\n").slice(Math.max(0, i - 5), i + 1).join("\n");
      expect(context).toContain("try {");
    }
  });
});

describe("DailyGame — source guard: useSyncExternalStore", () => {
  it("reads the local store via useSyncExternalStore", () => {
    expect(source).toContain("useSyncExternalStore");
  });
});

describe("DailyGame — source guard: share fallback", () => {
  it("uses navigator.share with a clipboard fallback", () => {
    expect(source).toContain("navigator.share");
    expect(source).toContain("navigator.clipboard");
    expect(source).toContain(".writeText(");
  });

  it("tracks the share event with the fixed vocabulary", () => {
    expect(source).toMatch(/track\("share",\s*\{\s*kind:\s*"gunun_tayfi"\s*\}\)/);
  });
});

describe("DailyGame — source guard: never a correctness verdict", () => {
  it("never says 'doğru cevap'", () => {
    expect(source.toLocaleLowerCase("tr-TR")).not.toContain("doğru cevap");
  });
});

describe("DailyGame — source guard: outbound links", () => {
  it("outbound article links open in a new tab with rel guards", () => {
    expect(source).toMatch(/target="_blank"/);
    expect(source).toMatch(/rel="noopener noreferrer"/);
  });
});

describe("DailyGame — source guard: focus management on phase transition", () => {
  // Mirrors zone-guess-game.tsx's pattern: each phase swaps in a different
  // button group, and the browser resets focus to <body> when the
  // previously-focused button unmounts, so keyboard/screen-reader users
  // must be moved onto the new phase's control programmatically.
  it("moves focus to firstZoneRef when entering \"playing\" and nextRef when entering \"revealed\"", () => {
    const effectMatch = source.match(/useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?\},\s*\[phase(?:,\s*index)?\]\s*\)/);
    expect(effectMatch, "expected a useEffect keyed on [phase] that moves focus").toBeTruthy();
    const effectBody = effectMatch![0];
    expect(effectBody).toMatch(/phase === "playing"/);
    expect(effectBody).toMatch(/firstZoneRef\.current\?\.focus\(\)/);
    expect(effectBody).toMatch(/phase === "revealed"/);
    expect(effectBody).toMatch(/nextRef\.current\?\.focus\(\)/);
  });
});
