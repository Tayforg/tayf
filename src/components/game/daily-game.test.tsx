import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DailyGame, resolveDailyPhase, resolveFinalMarks, type Phase } from "./daily-game";
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

describe("resolveDailyPhase — a stored result wins until this session plays", () => {
  const PHASES: readonly Phase[] = ["idle", "playing", "revealed", "finished"];

  it.each(PHASES)(
    "stored result, not played this session -> finished whatever localPhase is (%s)",
    (localPhase) => {
      expect(resolveDailyPhase({ hasStoredResult: true, playedThisSession: false, localPhase })).toBe(
        "finished",
      );
    },
  );

  it.each(PHASES)("stored result, played this session -> localPhase (%s)", (localPhase) => {
    expect(resolveDailyPhase({ hasStoredResult: true, playedThisSession: true, localPhase })).toBe(
      localPhase,
    );
  });

  it.each(PHASES)("nothing stored -> localPhase (%s)", (localPhase) => {
    expect(resolveDailyPhase({ hasStoredResult: false, playedThisSession: false, localPhase })).toBe(
      localPhase,
    );
    expect(resolveDailyPhase({ hasStoredResult: false, playedThisSession: true, localPhase })).toBe(
      localPhase,
    );
  });
});

describe("resolveFinalMarks — the marks the result screen and Paylaş use", () => {
  const STORED = [true, false, true, false, true];

  it("a stored result opened without playing wins over partial local marks (the other-tab finish)", () => {
    // Tab B answered 2 headlines, tab A finished the round: the storage event
    // makes the phase "finished" with openedAlreadyPlayed true. B's two marks
    // are an abandoned round, never the score to show or to share.
    expect(
      resolveFinalMarks({ storedMarks: STORED, openedAlreadyPlayed: true, localMarks: [true, true] }),
    ).toEqual(STORED);
    expect(
      resolveFinalMarks({ storedMarks: STORED, openedAlreadyPlayed: true, localMarks: [false] }),
    ).toEqual(STORED);
  });

  it("a stored result opened without playing and no local marks -> the stored marks", () => {
    expect(
      resolveFinalMarks({ storedMarks: STORED, openedAlreadyPlayed: true, localMarks: [] }),
    ).toEqual(STORED);
  });

  it("this session finished the round -> the local marks, even though a result is now stored", () => {
    const local = [false, false, true, true, false];
    expect(
      resolveFinalMarks({ storedMarks: STORED, openedAlreadyPlayed: false, localMarks: local }),
    ).toEqual(local);
  });

  it("nothing stored -> the local marks (a round in progress)", () => {
    expect(
      resolveFinalMarks({ storedMarks: undefined, openedAlreadyPlayed: false, localMarks: [true] }),
    ).toEqual([true]);
    expect(
      resolveFinalMarks({ storedMarks: undefined, openedAlreadyPlayed: false, localMarks: [] }),
    ).toEqual([]);
  });

  it("never reads the stored marks unless the result was opened already played", () => {
    // Defensive: openedAlreadyPlayed true with nothing stored cannot happen
    // (it is derived from the stored result), but must not throw.
    expect(
      resolveFinalMarks({ storedMarks: undefined, openedAlreadyPlayed: true, localMarks: [true, false] }),
    ).toEqual([true, false]);
  });
});

describe("DailyGame — source guard: the shown marks follow the same predicate as the phase", () => {
  it("derives finalMarks through resolveFinalMarks with openedAlreadyPlayed, not with marks.length", () => {
    expect(source).toMatch(/const finalMarks = resolveFinalMarks\(/);
    expect(source).toMatch(/resolveFinalMarks\(\{[^}]*openedAlreadyPlayed,/);
    expect(source).not.toMatch(/marks\.length === 0/);
  });
});

describe("DailyGame — source guard: derive the phase, never seed it from the hydration snapshot", () => {
  // The server snapshot is null, so the first client render has no stored
  // result; React keeps useState's initializer from that first render, so
  // seeding `phase` / `openedAlreadyPlayed` from `existingResult` froze them
  // at "idle" / false for a visitor who had already played (Başla showed and
  // a replay POSTed 5 guesses). The values must be derived on every render.
  it("no useState call has an initializer that mentions existingResult", () => {
    expect(source).not.toMatch(/useState[^;]*existingResult/);
  });

  it("the matcher catches both seeded forms it was written for", () => {
    const seededBool = "const [openedAlreadyPlayed] = useState(() => Boolean(existingResult));";
    const seededPhase = 'const [phase, setPhase] = useState<Phase>(existingResult ? "finished" : "idle");';
    expect(seededBool).toMatch(/useState[^;]*existingResult/);
    expect(seededPhase).toMatch(/useState[^;]*existingResult/);
    expect("const [index, setIndex] = useState(0);").not.toMatch(/useState[^;]*existingResult/);
  });

  it("derives phase through resolveDailyPhase and keeps getServerSnapshot null", () => {
    expect(source).toMatch(/const phase = resolveDailyPhase\(/);
    expect(source).toMatch(/function getServerSnapshot\(\): string \| null \{\s*return null;\s*\}/);
  });

  it("only the local phase is state: setPhase is gone, finishRound marks the session as played", () => {
    expect(source).not.toMatch(/\bsetPhase\(/);
    expect(source).toMatch(/\bsetLocalPhase\(/);
    expect(source).toMatch(/\bsetPlayedThisSession\(true\)/);
  });

  it("guesses are only accepted while the derived phase is \"playing\"", () => {
    expect(source).toMatch(/if \(!current \|\| phase !== "playing"\) return;/);
  });
});
