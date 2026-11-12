import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// track() POSTs through @vercel/analytics: every test in this file runs with it
// replaced, so no click in the copy-flow suite below can reach the network.
const trackMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/track", () => ({ track: trackMock }));

// A hook runtime for the copy-flow suite at the bottom of the file. While a
// test has one mounted it replaces the hooks DailyGame uses; with none mounted
// (the static renders above) every hook is React's own.
const rt = vi.hoisted(() => {
  interface Slot {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[];
    cleanup?: unknown;
  }

  class Runtime {
    /** Every committed output, one entry per render pass. */
    readonly outputs: unknown[] = [];
    private readonly slots: Slot[] = [];
    private cursor = 0;
    private pending: Array<() => void> = [];
    private dirty = false;
    private flushing = false;

    constructor(private readonly component: () => unknown) {}

    render(): void {
      this.flushing = true;
      try {
        do {
          this.dirty = false;
          this.cursor = 0;
          this.pending = [];
          const outer = state.current;
          state.current = this;
          try {
            this.outputs.push(this.component());
          } finally {
            state.current = outer;
          }
          for (const effect of this.pending) effect();
        } while (this.dirty);
      } finally {
        this.flushing = false;
      }
    }

    unmount(): void {
      for (const slot of this.slots) {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = undefined;
      }
    }

    private slot(init: () => Slot): Slot {
      const slot = (this.slots[this.cursor] ??= init());
      this.cursor++;
      return slot;
    }

    useState(initial: unknown): [unknown, (next: unknown) => void] {
      const slot = this.slot(() => ({
        value: typeof initial === "function" ? (initial as () => unknown)() : initial,
      }));
      const set = (next: unknown) => {
        const value = typeof next === "function" ? (next as (prev: unknown) => unknown)(slot.value) : next;
        if (Object.is(value, slot.value)) return;
        slot.value = value;
        if (this.flushing) this.dirty = true;
        else this.render();
      };
      return [slot.value, set];
    }

    useRef(initial: unknown): { current: unknown } {
      return this.slot(() => ({ current: initial })) as { current: unknown };
    }

    useEffect(effect: () => unknown, deps?: readonly unknown[]): void {
      const first = this.slots[this.cursor] === undefined;
      const slot = this.slot(() => ({}));
      const changed = first || deps === undefined || !deps.every((d, i) => Object.is(d, slot.deps?.[i]));
      if (!changed) return;
      slot.deps = deps;
      this.pending.push(() => {
        if (typeof slot.cleanup === "function") (slot.cleanup as () => void)();
        slot.cleanup = effect();
      });
    }
  }

  const state: { current: Runtime | null } = { current: null };
  return { state, Runtime };
});

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const live = () => rt.state.current;
  return {
    ...actual,
    default: actual,
    useState: (initial: unknown) => (live() ? live()!.useState(initial) : actual.useState(initial as never)),
    useRef: (initial: unknown) => (live() ? live()!.useRef(initial) : actual.useRef(initial as never)),
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) =>
      live() ? live()!.useEffect(effect, deps) : actual.useEffect(effect as never, deps as never),
    // The runtime re-renders on every state change, so these need no caching.
    useCallback: (fn: unknown, deps: readonly unknown[]) => (live() ? fn : actual.useCallback(fn as never, deps as never)),
    useMemo: (fn: () => unknown, deps: readonly unknown[]) => (live() ? fn() : actual.useMemo(fn, deps as never)),
    useId: () => (live() ? "id" : actual.useId()),
    useSyncExternalStore: (
      subscribe: (cb: () => void) => () => void,
      get: () => unknown,
      getServer?: () => unknown,
    ) => (live() ? get() : actual.useSyncExternalStore(subscribe, get, getServer)),
  };
});

import {
  DailyGame,
  copyOutcomeAnnouncement,
  resolveDailyPhase,
  resolveFinalMarks,
  type Phase,
} from "./daily-game";
import { OyunModes } from "./oyun-modes";
import { ManualCopyBox } from "@/components/story/share-button";
import type { DailyHeadline, DailyPuzzle } from "@/lib/game/daily-set";
import { ZONE_META } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

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

describe("DailyGame — source guard: a guess is POSTed only the first time a headline is answered", () => {
  const start = source.indexOf("const handleGuess = useCallback(");
  const end = source.indexOf("const finishRound = useCallback(");
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

  it("the mark, the reveal and the announcement still run for an already answered headline", () => {
    const gateAt = body.indexOf("if (markAnswered(current.articleId)) {");
    for (const call of ["setGuessedZone(zone)", "setMarks(", 'setLocalPhase("revealed")', "setAnnouncement("]) {
      const at = body.indexOf(call);
      expect(at, call).toBeGreaterThan(-1);
      expect(at, call).toBeLessThan(gateAt);
    }
  });

  it("the only /api/oyun call in the file sits behind the gate, and markAnswered comes from answered-headlines", () => {
    expect(source.split('fetch("/api/oyun"')).toHaveLength(2);
    expect(source).toContain('from "@/lib/game/answered-headlines"');
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

/**
 * Every `useEffect(...)` call in `src`, as its full source text: found by
 * scanning for the parenthesis that closes the call (a character scan, not a
 * regex), so a body containing braces, template literals or nested calls
 * cannot truncate it.
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

describe("DailyGame — source guard: focus management on phase transition", () => {
  // Mirrors zone-guess-game.tsx's pattern: each phase swaps in a different
  // button group, and the browser resets focus to <body> when the
  // previously-focused button unmounts, so keyboard/screen-reader users
  // must be moved onto the new phase's control programmatically.
  const focusEffect = useEffectCalls(source).find((call) => call.includes("firstZoneRef"));

  it("moves focus to firstZoneRef when entering \"playing\" and nextRef when entering \"revealed\"", () => {
    expect(focusEffect, "expected a useEffect that moves focus").toBeTruthy();
    expect(focusEffect).toMatch(/phase === "playing"/);
    expect(focusEffect).toMatch(/firstZoneRef\.current\?\.focus\(\)/);
    expect(focusEffect).toMatch(/phase === "revealed"/);
    expect(focusEffect).toMatch(/nextRef\.current\?\.focus\(\)/);
  });

  it("is keyed on [phase, index, playedThisSession]", () => {
    expect(focusEffect).toContain("[phase, index, playedThisSession]");
  });

  it("moves focus to Paylaş when THIS session finishes the round (the final Sonraki unmounts the focused button)", () => {
    expect(focusEffect).toContain('phase === "finished" && playedThisSession');
    expect(focusEffect).toContain("shareRef.current?.focus()");
  });

  it("never moves focus on the stored-result path: the only finished-phase focus call sits behind playedThisSession", () => {
    // A visitor who opens the page with a result already in localStorage
    // lands on "finished" without playing; stealing focus there would pull
    // them away from the page they just loaded.
    const body = focusEffect ?? "";
    expect(body.split("shareRef.current?.focus()")).toHaveLength(2);
    const finishedBranchAt = body.indexOf('phase === "finished"');
    expect(finishedBranchAt).toBeGreaterThan(-1);
    // Every `phase === "finished"` test in the effect carries the guard.
    expect(body.split('phase === "finished"')).toHaveLength(2);
    expect(body.slice(finishedBranchAt, finishedBranchAt + 60)).toContain(
      'phase === "finished" && playedThisSession',
    );
    // And no other ref is focused for the finished phase.
    expect(body).not.toContain("finishedRef");
  });

  it("puts shareRef on the Paylaş button", () => {
    const shareButtonAt = source.indexOf("ref={shareRef}");
    expect(shareButtonAt).toBeGreaterThan(-1);
    expect(source.split("ref={shareRef}")).toHaveLength(2);
    const buttonTag = source.slice(source.lastIndexOf("<button", shareButtonAt), shareButtonAt + 200);
    expect(buttonTag).toContain("onClick={handleShare}");
  });

  it("useEffectCalls finds every effect and only effects", () => {
    const sample = "a(); useEffect(() => { if (x) { y(`${z}`); } }, [x]); b(); useEffect(() => {}, []);";
    expect(useEffectCalls(sample)).toEqual([
      "useEffect(() => { if (x) { y(`${z}`); } }, [x])",
      "useEffect(() => {}, [])",
    ]);
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

describe("DailyGame — static render: intro copy says what is counted", () => {
  it("today's puzzle (before the politics gate) says 'Dünün (...) 5 manşeti.' and never 'siyasi'", () => {
    const html = renderToStaticMarkup(<DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" />);
    expect(html).toContain("Dünün (27 Eylül 2026) 5 manşeti.");
    expect(html).toContain("Günün Tayf\u2019ı #1.");
    expect(html).not.toContain("siyasi");
  });

  it("a replayed pre-gate puzzle names its own window instead of claiming it is yesterday's", () => {
    const html = renderToStaticMarkup(<DailyGame puzzle={fixturePuzzle} todayKey="2026-10-02" />);
    expect(html).toContain("Günün Tayf\u2019ı #1 · 27 Eylül 2026 tarihli 5 manşet.");
    expect(html).not.toContain("Dünün");
    expect(html).not.toContain("siyasi");
  });

  it("a puzzle from the politics gate onward says 'siyasi'", () => {
    const html = renderToStaticMarkup(
      <DailyGame
        puzzle={{ ...fixturePuzzle, dateKey: "2026-11-04", number: 38, windowLabel: "3 Kasım 2026" }}
        todayKey="2026-11-04"
      />,
    );
    expect(html).toContain("Dünün (3 Kasım 2026) 5 siyasi manşeti.");
  });

  it("builds the idle copy through dailyIntroText, not inline JSX", () => {
    expect(source).toContain("dailyIntroText(");
    expect(source).not.toContain("5 siyasi manşeti");
  });
});

describe("DailyGame — static render: link fallback notice", () => {
  const NOTICE_EXPIRED = "Bu bağlantıdaki bulmaca artık oynanamıyor; bugünkü bulmaca gösteriliyor.";
  const NOTICE_FUTURE = "Bu bağlantıdaki bulmaca henüz yayımlanmadı; bugünkü bulmaca gösteriliyor.";
  const NOTICE_TAG = '<p class="text-[11px] text-muted-foreground text-center">';

  it("fellBack='expired' renders the expired notice as one small centred line", () => {
    const html = renderToStaticMarkup(
      <DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" fellBack="expired" />,
    );
    expect(html).toContain(`${NOTICE_TAG}${NOTICE_EXPIRED}</p>`);
    expect(html.split(NOTICE_EXPIRED)).toHaveLength(2);
  });

  it("fellBack='future' renders the not-yet-published notice", () => {
    const html = renderToStaticMarkup(
      <DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" fellBack="future" />,
    );
    expect(html).toContain(NOTICE_FUTURE);
  });

  it("fellBack='invalid' renders no notice", () => {
    const html = renderToStaticMarkup(
      <DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" fellBack="invalid" />,
    );
    expect(html).not.toContain("Bu bağlantıdaki");
    expect(html).not.toContain(NOTICE_TAG);
  });

  it("no fellBack prop, or null, renders no notice", () => {
    const withoutProp = renderToStaticMarkup(<DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" />);
    const withNull = renderToStaticMarkup(
      <DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" fellBack={null} />,
    );
    for (const html of [withoutProp, withNull]) {
      expect(html).not.toContain("Bu bağlantıdaki");
      expect(html).not.toContain(NOTICE_TAG);
    }
  });

  it("the notice sits above the content (after the live region, before the card)", () => {
    const html = renderToStaticMarkup(
      <DailyGame puzzle={fixturePuzzle} todayKey="2026-09-28" fellBack="expired" />,
    );
    const noticeAt = html.indexOf(NOTICE_EXPIRED);
    expect(noticeAt).toBeGreaterThan(html.indexOf('role="status"'));
    expect(noticeAt).toBeLessThan(html.indexOf("Başla"));
  });

  it("renders the notice even when there is no puzzle to show", () => {
    const html = renderToStaticMarkup(
      <DailyGame puzzle={null} todayKey="2026-09-28" fellBack="expired" />,
    );
    expect(html).toContain(NOTICE_EXPIRED);
    expect(html).toContain("Bugünün 5 manşeti hazırlanamadı");
  });

  it("renders the notice from the return block, outside the per-phase content switch", () => {
    expect(source.split("puzzleFallbackNotice(fellBack)")).toHaveLength(2);
    const switchAt = source.indexOf("let content: ReactNode;");
    const callAt = source.indexOf("puzzleFallbackNotice(fellBack)");
    const returnAt = source.lastIndexOf("return (");
    expect(callAt).toBeGreaterThan(switchAt);
    // Nothing between the switch start and the notice mentions it, so no phase branch can skip it.
    const declAt = source.lastIndexOf("const fallbackNotice", callAt);
    expect(declAt).toBeGreaterThan(switchAt);
    expect(source.slice(switchAt, declAt)).not.toContain("fallbackNotice");
    const renderAt = source.indexOf("{fallbackNotice && (", returnAt);
    expect(renderAt).toBeGreaterThan(returnAt);
    expect(renderAt).toBeLessThan(source.indexOf("{content}", returnAt));
    expect(source).toContain(
      '<p className="text-[11px] text-muted-foreground text-center">{fallbackNotice}</p>',
    );
  });
});

describe("DailyGame — source guard: the streak shown is the live one", () => {
  it("prints liveStreak(store, todayKey), never the raw stored streak", () => {
    expect(source).toContain("liveStreak(store, todayKey)");
    expect(source).not.toContain("{store.streak}");
    expect(source).toContain("{store.best}");
  });
});

describe("DailyGame — source guard: a dismissed share sheet leaves the clipboard alone", () => {
  const handleShareAt = source.indexOf("const handleShare = useCallback(");
  const handleShareEnd = source.indexOf("const announcementRegion");
  const body = source.slice(handleShareAt, handleShareEnd);

  it("isShareAbort( is checked inside the navigator.share .catch, before the clipboard fallback", () => {
    expect(handleShareAt).toBeGreaterThan(-1);
    expect(handleShareEnd).toBeGreaterThan(handleShareAt);
    const catchAt = body.indexOf(".catch((err)");
    expect(catchAt).toBeGreaterThan(-1);
    const abortAt = body.indexOf("isShareAbort(", catchAt);
    expect(abortAt).toBeGreaterThan(catchAt);
    const fallbackAt = body.indexOf("copyToClipboard(text)", catchAt);
    expect(fallbackAt).toBeGreaterThan(abortAt);
    expect(body.slice(abortAt, fallbackAt)).toContain("return;");
  });

  it("still falls back to the clipboard when navigator.share is missing", () => {
    // One call in the share rejection path, one after the `if (shareFn)` block.
    expect(body.split("copyToClipboard(text)")).toHaveLength(3);
  });
});

describe("DailyGame — source guard: new headlines are announced from handlers", () => {
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
    const body = handlerBody("handleNext", "const copyToClipboard = useCallback(");
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
      ["handleNext", "const copyToClipboard = useCallback("],
    ] as const) {
      const body = handlerBody(name, marker);
      const deps = body.slice(body.lastIndexOf("}, ["));
      expect(deps, name).toContain("headlines");
      expect(deps, name).not.toContain("headlines.length");
    }
  });

  it("no useEffect body announces a headline (set-state-in-effect is a lint error here)", () => {
    for (const call of useEffectCalls(source)) {
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
});

describe("OyunModes and /oyun page — the fallback reason reaches DailyGame", () => {
  const NOTICE_EXPIRED = "Bu bağlantıdaki bulmaca artık oynanamıyor; bugünkü bulmaca gösteriliyor.";

  it("OyunModes forwards dailyFellBack to DailyGame as fellBack", () => {
    const html = renderToStaticMarkup(
      <OyunModes
        headlines={[]}
        daily={fixturePuzzle}
        todayKey="2026-09-28"
        dailyFellBack="expired"
        initialMode="gunluk"
      />,
    );
    expect(html).toContain(NOTICE_EXPIRED);
    expect(html).toContain("Dünün (27 Eylül 2026) 5 manşeti.");
  });

  it("OyunModes without dailyFellBack shows no notice", () => {
    const html = renderToStaticMarkup(
      <OyunModes headlines={[]} daily={fixturePuzzle} todayKey="2026-09-28" initialMode="gunluk" />,
    );
    expect(html).not.toContain("Bu bağlantıdaki");
  });

  it("the page resolves ?gun= with its reason and passes it on, leaving the searchParams type alone", () => {
    const pageSource = readFileSync(resolve(__dirname, "../../app/oyun/page.tsx"), "utf8");
    expect(pageSource).toContain(
      "const { dateKey, fellBack } = resolvePuzzleDateWithReason(sp.gun, todayKey);",
    );
    expect(pageSource).toContain("dailyFellBack={fellBack}");
    // tests/guards/search-params-array.test.ts pins this exact declaration.
    expect(pageSource).toContain("searchParams: Promise<{ mod?: string; gun?: string | string[] }>;");
  });
});

// ---------------------------------------------------------------------------
// h90-livearia-2: when copying fails, the reader is told and offered the text
// ---------------------------------------------------------------------------

const COPY_FAILED = "Kopyalanamadı. Paylaşım metni aşağıdaki kutuda; seçip kopyalayın.";

describe("copyOutcomeAnnouncement", () => {
  it("says 'Kopyalandı' for a successful copy", () => {
    expect(copyOutcomeAnnouncement(true)).toBe("Kopyalandı");
  });

  it("says where the text is, in Turkish, for a failed copy", () => {
    const text = copyOutcomeAnnouncement(false);
    expect(text).toBe(COPY_FAILED);
    expect(text).toContain("aşağıdaki kutuda");
  });
});

describe("DailyGame — source guard: a failed copy is never swallowed", () => {
  const start = source.indexOf("const copyToClipboard = useCallback(");
  const end = source.indexOf("const handleShare = useCallback(");
  const body = source.slice(start, end);

  it("copyToClipboard has no empty catch handlers", () => {
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(body).not.toContain(".catch(() => {})");
    // Each comment line must end in a newline, so the repetition cannot backtrack (CodeQL js/redos).
    expect(body).not.toMatch(/catch\s*(?:\(\w*\))?\s*\{\s*(?:\/\/[^\n]*\n\s*)*\}/);
  });

  it("every failure path (rejection, missing clipboard, throw) offers the text and announces it", () => {
    expect(body).toContain("setManualShare(text)");
    expect(body).toContain("announceCopy(false)");
    expect(body).toContain("announceCopy(true)");
    expect(body).toContain("setManualShare(null)");
  });

  it("imports ManualCopyBox from share-button and renders it for the share text", () => {
    expect(source).toContain('import { ManualCopyBox } from "@/components/story/share-button";');
    expect(source).toContain('<ManualCopyBox label="Paylaşım metni" value={manualShare} />');
  });

  it("the live region is still mounted for every phase and the share handler still tracks only gunun_tayfi", () => {
    expect(source).toMatch(/\{announcementRegion\}/);
    expect(source.split("track(")).toHaveLength(2);
  });
});

// The copy flow itself, through the real component. The stored result puts it in
// the finished phase without playing, so no guess is POSTed (fetch is not called).
describe("DailyGame — copy flow (behaviour)", () => {
  type El = { type?: unknown; props?: Record<string, unknown> };

  const STORE = JSON.stringify({
    v: 1,
    lastPlayed: "2026-09-28",
    streak: 1,
    best: 3,
    results: { "2026-09-28": { score: 3, marks: [true, false, true, false, true] } },
  });
  const SHARE_TEXT = [
    "Günün Tayf'ı #1 · 3/5",
    "✅❌✅❌✅",
    "https://tayf.test/oyun?mod=gunluk&gun=2026-09-28",
  ].join("\n");

  function walk(node: unknown, visit: (el: El) => void): void {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
    } else if (node && typeof node === "object") {
      const el = node as El;
      if (el.type !== undefined) visit(el);
      walk(el.props?.children, visit);
    }
  }

  function find(node: unknown, pred: (el: El) => boolean): El | undefined {
    let hit: El | undefined;
    walk(node, (el) => {
      if (hit === undefined && pred(el)) hit = el;
    });
    return hit;
  }

  const text = (node: unknown): string =>
    Array.isArray(node)
      ? node.map(text).join("")
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : node && typeof node === "object"
          ? text((node as El).props?.children)
          : "";

  function mountFinished() {
    const app = new rt.Runtime(() => DailyGame({ puzzle: fixturePuzzle, todayKey: "2026-09-28" }));
    app.render();
    const tree = () => app.outputs[app.outputs.length - 1];
    const region = () => find(tree(), (el) => el.props?.role === "status");
    return {
      app,
      /** What the live region holds right now. */
      announcement: () => text(region()?.props?.children),
      /** Distinct non-empty texts the region received, plus the '' resets between them. */
      regionHistory: () => app.outputs.map((out) => text(find(out, (el) => el.props?.role === "status")?.props?.children)),
      shareButton: () => find(tree(), (el) => el.type === "button" && /Paylaş|Kopyaland/.test(text(el))),
      label: () => text(find(tree(), (el) => el.type === "button" && /Paylaş|Kopyaland/.test(text(el)))),
      manualBox: () => find(tree(), (el) => el.type === ManualCopyBox),
      clickShare() {
        (this.shareButton()!.props!.onClick as () => void)();
      },
    };
  }

  function stubBrowser(over: { writeText?: unknown; share?: unknown; noClipboard?: boolean } = {}) {
    const navigatorStub: Record<string, unknown> = {};
    if (!over.noClipboard) navigatorStub.clipboard = { writeText: over.writeText ?? vi.fn(async () => {}) };
    if (over.share) navigatorStub.share = over.share;
    vi.stubGlobal("navigator", navigatorStub);
    vi.stubGlobal("window", {
      localStorage: { getItem: () => STORE, setItem: () => {} },
      location: { origin: "https://tayf.test" },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
  }

  const rejecting = () => vi.fn(async (_value: string) => { throw new Error("denied"); });

  beforeEach(() => {
    vi.useFakeTimers();
    trackMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("starts on the result screen with a quiet region, no manual box and the 'Paylaş' label", () => {
    stubBrowser();
    const view = mountFinished();
    expect(view.label()).toBe("Paylaş");
    expect(view.announcement()).toBe("");
    expect(view.manualBox()).toBeUndefined();
  });

  it("a rejected clipboard write announces the failure and offers the share text in a box", async () => {
    stubBrowser({ writeText: rejecting() });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(0);
    // The box is there at once; the sentence follows after the 50 ms reset.
    expect(view.manualBox()?.props).toEqual({ label: "Paylaşım metni", value: SHARE_TEXT });
    expect(view.announcement()).toBe("");
    await vi.advanceTimersByTimeAsync(49);
    expect(view.announcement()).toBe("");
    await vi.advanceTimersByTimeAsync(1);
    expect(view.announcement()).toBe(COPY_FAILED);
    expect(view.label()).toBe("Paylaş");
  });

  it("a missing navigator.clipboard (insecure context) takes the same failure path", async () => {
    stubBrowser({ noClipboard: true });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.announcement()).toBe(COPY_FAILED);
    expect(view.manualBox()?.props?.value).toBe(SHARE_TEXT);
  });

  it("a clipboard that throws synchronously takes the same failure path", async () => {
    stubBrowser({
      writeText: vi.fn(() => {
        throw new Error("sync");
      }),
    });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.announcement()).toBe(COPY_FAILED);
    expect(view.manualBox()?.props?.value).toBe(SHARE_TEXT);
  });

  it("a successful copy announces 'Kopyalandı', swaps the label for 2 s and shows no box", async () => {
    const writeText = vi.fn(async (_value: string) => {});
    stubBrowser({ writeText });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith(SHARE_TEXT);
    expect(view.label()).toBe("Kopyalandı");
    await vi.advanceTimersByTimeAsync(50);
    expect(view.announcement()).toBe("Kopyalandı");
    expect(view.manualBox()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2000);
    expect(view.label()).toBe("Paylaş");
  });

  it("a later successful copy takes the manual box away", async () => {
    const writeText = vi.fn(async (_value: string) => {});
    writeText.mockRejectedValueOnce(new Error("denied"));
    stubBrowser({ writeText });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.manualBox()).toBeDefined();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.manualBox()).toBeUndefined();
    expect(view.announcement()).toBe("Kopyalandı");
  });

  it("an identical repeat message is re-announced: the region empties first, then speaks again", async () => {
    stubBrowser({ writeText: rejecting() });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(view.announcement()).toBe(COPY_FAILED);
    view.clickShare();
    await vi.advanceTimersByTimeAsync(0);
    expect(view.announcement()).toBe("");
    await vi.advanceTimersByTimeAsync(100);
    expect(view.announcement()).toBe(COPY_FAILED);
    const spoken = view.regionHistory().filter((t, i, all) => t !== "" && all[i - 1] !== t);
    expect(spoken).toEqual([COPY_FAILED, COPY_FAILED]);
  });

  it("a native share that fails for another reason than a dismissal falls back and reports the failure", async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error("blocked"), { name: "NotAllowedError" });
    });
    stubBrowser({ writeText: rejecting(), share });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(share).toHaveBeenCalledTimes(1);
    expect(view.announcement()).toBe(COPY_FAILED);
    expect(view.manualBox()?.props?.value).toBe(SHARE_TEXT);
  });

  it("a dismissed share sheet stays silent: no announcement, no box, no clipboard write", async () => {
    const share = vi.fn(async () => {
      throw Object.assign(new Error("dismissed"), { name: "AbortError" });
    });
    const writeText = vi.fn(async (_value: string) => {});
    stubBrowser({ writeText, share });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.announcement()).toBe("");
    expect(view.manualBox()).toBeUndefined();
    expect(writeText).not.toHaveBeenCalled();
  });

  it("fires no new analytics event: one 'share' per click, kind gunun_tayfi, whatever the outcome", async () => {
    stubBrowser({ writeText: rejecting() });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(100);
    expect(trackMock.mock.calls).toEqual([["share", { kind: "gunun_tayfi" }]]);
  });

  it("unmounting before the announcement is due cancels its timer", async () => {
    stubBrowser({ writeText: rejecting() });
    const view = mountFinished();
    view.clickShare();
    await vi.advanceTimersByTimeAsync(10);
    expect(vi.getTimerCount()).toBe(1);
    view.app.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// h138-suffix-1: "Bağımsız" is an adjective, so the reveal after a wrong guess
// must not glue "bölgesine" to it. Played through the real component: Başla,
// then one wrong zone button, then read the visible paragraph and the live region.
describe("DailyGame — reveal copy after a wrong guess (behaviour)", () => {
  type El = { type?: unknown; props?: Record<string, unknown> };

  function walk(node: unknown, visit: (el: El) => void): void {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, visit);
    } else if (node && typeof node === "object") {
      const el = node as El;
      if (el.type !== undefined) visit(el);
      walk(el.props?.children, visit);
    }
  }

  function find(node: unknown, pred: (el: El) => boolean): El | undefined {
    let hit: El | undefined;
    walk(node, (el) => {
      if (hit === undefined && pred(el)) hit = el;
    });
    return hit;
  }

  const text = (node: unknown): string =>
    Array.isArray(node)
      ? node.map(text).join("")
      : typeof node === "string" || typeof node === "number"
        ? String(node)
        : node && typeof node === "object"
          ? text((node as El).props?.children)
          : "";

  // Five headlines of one zone; the first one is the outlet the test reads.
  // Article ids are unique per zone so the module-level answered set never
  // makes one test's guess look like a replay in another.
  function puzzleOf(zone: MediaDnaZone, sourceName: string): DailyPuzzle {
    return {
      dateKey: "2026-09-28",
      number: 1,
      windowLabel: "27 Eylül 2026",
      headlines: Array.from({ length: 5 }, (_, i) => ({
        articleId: `reveal-${zone}-${i}`,
        sourceId: `reveal-source-${zone}-${i}`,
        title: `Başlık ${i} — siyasi bir gelişme yaşandı bugün`,
        url: `https://ornek.com/reveal-${zone}-${i}`,
        sourceName: i === 0 ? sourceName : `Kaynak ${i}`,
        sourceSlug: `kaynak-${zone}-${i}`,
        zone,
        clusterId: null,
      })),
    };
  }

  function stubBrowser() {
    vi.stubGlobal("window", {
      localStorage: { getItem: () => null, setItem: () => {} },
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => true,
      setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, ms),
      clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
    });
    // The guess POST is fire-and-forget; the stub keeps it off the network.
    vi.stubGlobal("fetch", vi.fn(async () => ({})));
  }

  /** Starts the round and answers its first headline with `guess`. */
  function guessFirst(puzzle: DailyPuzzle, guess: MediaDnaZone) {
    const app = new rt.Runtime(() => DailyGame({ puzzle, todayKey: "2026-09-28" }));
    app.render();
    const tree = () => app.outputs[app.outputs.length - 1];
    const press = (label: string) => {
      const button = find(tree(), (el) => el.type === "button" && text(el) === label);
      expect(button, `a "${label}" button`).toBeDefined();
      (button!.props!.onClick as () => void)();
    };
    press("Başla");
    press(ZONE_META[guess].label);
    return {
      /** The reveal sentence in the card. */
      visible: () => text(find(tree(), (el) => el.type === "p" && el.props?.className === "text-sm")),
      /** What the aria-live region holds. */
      announcement: () => text(find(tree(), (el) => el.props?.role === "status")?.props?.children),
    };
  }

  beforeEach(() => stubBrowser());
  afterEach(() => vi.unstubAllGlobals());

  it("a wrong guess on a Bağımsız puzzle says 'Bağımsız bölgeye', never 'bölgesine', in the card and the live region", () => {
    const view = guessFirst(puzzleOf("bagimsiz", "Haberet"), "iktidar");
    const sentence = "Haberet — Tayf bu kaynağı Bağımsız bölgeye koyuyor";
    expect(view.visible()).toBe(sentence);
    expect(view.announcement()).toBe(sentence);
    expect(view.visible()).not.toContain("Bağımsız bölgesine");
    expect(view.announcement()).not.toContain("Bağımsız bölgesine");
  });

  it("a wrong guess on an İktidar puzzle still says 'İktidar bölgesine'", () => {
    const view = guessFirst(puzzleOf("iktidar", "Haberet"), "muhalefet");
    const sentence = "Haberet — Tayf bu kaynağı İktidar bölgesine koyuyor";
    expect(view.visible()).toBe(sentence);
    expect(view.announcement()).toBe(sentence);
  });

  it("a wrong guess on a Muhalefet puzzle still says 'Muhalefet bölgesine'", () => {
    const view = guessFirst(puzzleOf("muhalefet", "Haberet"), "bagimsiz");
    const sentence = "Haberet — Tayf bu kaynağı Muhalefet bölgesine koyuyor";
    expect(view.visible()).toBe(sentence);
    expect(view.announcement()).toBe(sentence);
  });

  it("a matching guess keeps its own sentence, whatever the zone", () => {
    const view = guessFirst(puzzleOf("bagimsiz", "Haberet"), "bagimsiz");
    const sentence = "Haberet · Bağımsız — Tayf'ın etiketiyle aynı";
    expect(view.visible()).toBe(sentence);
    expect(view.announcement()).toBe(sentence);
  });
});
