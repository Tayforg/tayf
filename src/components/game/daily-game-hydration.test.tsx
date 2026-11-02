import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { applyDailyResult, parseDailyStore } from "@/lib/game/daily-share";
import type { DailyHeadline, DailyPuzzle } from "@/lib/game/daily-set";
import { DailyGame } from "./daily-game";

// ---------------------------------------------------------------------------
// Separate file because it mocks `react`. The repo has no jsdom / RTL, so the
// localStorage snapshot is injected by replacing useSyncExternalStore.
//
// Two scenarios, both for a visitor whose browser already holds a result for
// today's puzzle:
//  - "seeded":  the very first render already sees the stored result.
//  - "hydrate": the first pass sees the server snapshot (null), a second pass
//    of the SAME component instance sees the stored result. That is what a
//    real hydration does (getServerSnapshot first, then a re-sync), and it is
//    what froze `phase` at "idle" when it was seeded with useState. Fizz keeps
//    hook state across a render-phase update, so forcing one from inside the
//    mocked hook reproduces the two passes without a DOM.
// ---------------------------------------------------------------------------

const puzzle: DailyPuzzle = {
  dateKey: "2026-09-28",
  number: 7,
  windowLabel: "27 Eylül 2026",
  headlines: Array.from({ length: 5 }, (_, i): DailyHeadline => ({
    articleId: `article-${i}`,
    sourceId: `source-${i}`,
    title: `Başlık ${i} — siyasi bir gelişme yaşandı bugün`,
    url: `https://ornek.com/${i}`,
    sourceName: `Kaynak ${i}`,
    sourceSlug: `kaynak-${i}`,
    zone: (["iktidar", "bagimsiz", "muhalefet"] as const)[i % 3]!,
    clusterId: i % 2 === 0 ? `cluster-${i}` : null,
  })),
};

const SEEDED = JSON.stringify(
  applyDailyResult(parseDailyStore(null), {
    dateKey: puzzle.dateKey,
    todayKey: puzzle.dateKey,
    score: 3,
    marks: [true, false, true, false, true],
  }),
);

const mode = vi.hoisted(() => ({ value: "seeded" as "seeded" | "hydrate" }));

vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  return {
    ...actual,
    useSyncExternalStore: () => {
      if (mode.value === "seeded") return SEEDED;
      // hydrate: pass 1 -> null (the server snapshot), then a render-phase
      // update re-runs the component and pass 2 -> the stored value.
      const [pass, setPass] = actual.useState(0);
      if (pass === 0) {
        setPass(1);
        return null;
      }
      return SEEDED;
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  mode.value = "seeded";
});

function buttons(html: string): string[] {
  return html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
}

describe.each([
  ["a stored result is visible on the first render", "seeded"],
  ["a stored result appears after the null hydration snapshot", "hydrate"],
] as const)("DailyGame with a stored result for today — %s", (_label, scenario) => {
  const render = () => {
    mode.value = scenario;
    return renderToStaticMarkup(<DailyGame puzzle={puzzle} todayKey={puzzle.dateKey} />);
  };

  it("opens on the result screen with the already-played banner and the score", () => {
    const html = render();
    expect(html).toContain("Bugünün oyununu oynadın. Yarın yeni 5 manşet.");
    expect(html).toContain("3/5");
  });

  it("never offers to start again", () => {
    const html = render();
    expect(html).not.toContain("Başla");
    expect(html).not.toContain("Sonraki");
  });

  it("the only button is Paylaş", () => {
    const found = buttons(render());
    expect(found).toHaveLength(1);
    expect(found[0]).toContain("Paylaş");
  });

  it("sends no guess to /api/oyun", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    render();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("DailyGame without a stored result", () => {
  it("still opens on the idle screen (the null snapshot is not mistaken for a result)", () => {
    mode.value = "seeded";
    const html = renderToStaticMarkup(
      <DailyGame puzzle={{ ...puzzle, dateKey: "2026-09-27" }} todayKey="2026-09-28" />,
    );
    expect(html).toContain("Başla");
    expect(html).not.toContain("Bugünün oyununu oynadın");
  });
});

// h24-feeds-3: the stored articles.url is the ingest upsert key and keeps the
// feed's tags (Diken: a literal '&#038;' between utm params; Evrensel: utm_*
// on every link). The result screen's "Habere git" link must hand the reader
// the cleaned url, while the cached puzzle payload stays untouched.
describe("DailyGame result screen: outbound links are cleaned at render", () => {
  const DIKEN_STORED =
    "https://www.diken.com.tr/avro-56-lira-sinirini-gecti/?utm_source=rss&#038;utm_medium=rss&#038;utm_campaign=avro-56-lira-sinirini-gecti";
  const EVRENSEL_STORED =
    "https://www.evrensel.net/haber/6007631/akaryakita-zam?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication";
  const PLAIN = "https://ornek.com/plain-article";

  const taggedPuzzle: DailyPuzzle = {
    ...puzzle,
    headlines: [DIKEN_STORED, EVRENSEL_STORED, PLAIN, PLAIN, PLAIN].map((url, i) => ({
      ...puzzle.headlines[i]!,
      url,
    })),
  };

  function outboundHrefs(html: string): string[] {
    const hrefs: string[] = [];
    for (const tag of html.match(/<a\b[^>]*>/g) ?? []) {
      if (!tag.includes('target="_blank"')) continue;
      const m = /href="([^"]*)"/.exec(tag);
      if (m) hrefs.push(m[1]!);
    }
    return hrefs;
  }

  it("renders the bare article url for a Diken ('&#038;') and an Evrensel (utm_*) headline", () => {
    mode.value = "seeded";
    const html = renderToStaticMarkup(<DailyGame puzzle={taggedPuzzle} todayKey={taggedPuzzle.dateKey} />);
    const hrefs = outboundHrefs(html);
    expect(hrefs).toEqual([
      "https://www.diken.com.tr/avro-56-lira-sinirini-gecti/",
      "https://www.evrensel.net/haber/6007631/akaryakita-zam",
      PLAIN,
      PLAIN,
      PLAIN,
    ]);
    expect(html).not.toContain("utm_");
    expect(html).not.toContain("038");
  });

  it("does not mutate the puzzle payload (the cached daily set keeps the stored url)", () => {
    mode.value = "seeded";
    renderToStaticMarkup(<DailyGame puzzle={taggedPuzzle} todayKey={taggedPuzzle.dateKey} />);
    expect(taggedPuzzle.headlines[0]!.url).toBe(DIKEN_STORED);
    expect(taggedPuzzle.headlines[1]!.url).toBe(EVRENSEL_STORED);
  });
});
