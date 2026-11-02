import { describe, it, expect } from "vitest";
import {
  buildWeeklyDistinctiveWords,
  WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE,
  type WeeklyWordsArticleRow,
  type WeeklyWordsSourceRow,
} from "./distinctive-words";

// /hafta "Aynı hafta, farklı kelimeler": the example link under a term is built
// from articles.url. It is cleaned for the href (h24-feeds-3): a stored
// Diken url carries a literal '&#038;' between its utm params. The stored url
// itself is never rewritten. (The rest of buildWeeklyDistinctiveWords is
// covered in distinctive-words.test.ts.)

const MIN = WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE;

const SOURCES: WeeklyWordsSourceRow[] = [
  { id: "src-gov-1", name: "Gov Outlet 1", bias: "pro_government", kind: "outlet", active: true },
  { id: "src-gov-2", name: "Gov Outlet 2", bias: "pro_government", kind: "outlet", active: true },
  { id: "src-gov-3", name: "Gov Outlet 3", bias: "pro_government", kind: "outlet", active: true },
  { id: "src-ind-1", name: "Center Outlet 1", bias: "center", kind: "outlet", active: true },
  { id: "src-ind-2", name: "Center Outlet 2", bias: "center", kind: "outlet", active: true },
  { id: "src-ind-3", name: "Center Outlet 3", bias: "center", kind: "outlet", active: true },
  { id: "src-opp-1", name: "Opp Outlet 1", bias: "opposition", kind: "outlet", active: true },
  { id: "src-opp-2", name: "Opp Outlet 2", bias: "opposition", kind: "outlet", active: true },
  { id: "src-opp-3", name: "Opp Outlet 3", bias: "opposition", kind: "outlet", active: true },
];

const GOV_IDS = ["src-gov-1", "src-gov-2", "src-gov-3"];

function fillerRows(n: number, sourceIds: string[], idPrefix: string): WeeklyWordsArticleRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-${String(i).padStart(4, "0")}`,
    title: `Ekonomi haberi ${idPrefix} ${i}`,
    url: `https://example.com/${idPrefix}-${i}`,
    source_id: sourceIds[i % sourceIds.length]!,
    created_at: "2026-09-20T10:00:00.000Z",
  }));
}

/** 40 distinctive "Skandal haberi N" rows in the government zone, with `urlOf(i)`. */
function scenario(urlOf: (i: number) => string | null): WeeklyWordsArticleRow[] {
  return [
    ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
    ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
    ...fillerRows(MIN - 40, GOV_IDS, "gov"),
    ...Array.from({ length: 40 }, (_, i) => ({
      id: `sk-${String(i).padStart(3, "0")}`,
      title: `Skandal haberi ${i}`,
      url: urlOf(i),
      source_id: GOV_IDS[i % GOV_IDS.length]!,
      created_at: "x",
    })),
  ];
}

function skandalExample(rows: WeeklyWordsArticleRow[]) {
  const result = buildWeeklyDistinctiveWords(rows, SOURCES);
  expect(result.status).toBe("ok");
  if (result.status !== "ok") throw new Error("not ok");
  const term = result.zones.iktidar.find((t) => t.term === "skandal");
  expect(term?.example).not.toBeNull();
  return term!.example!;
}

describe("buildWeeklyDistinctiveWords: outbound example url (h24-feeds-3)", () => {
  it("cleans a stored Diken url ('&#038;' between utm params) down to the article url", () => {
    const example = skandalExample(
      scenario(
        (i) =>
          `https://www.diken.com.tr/skandal-${i}/?utm_source=rss&#038;utm_medium=rss&#038;utm_campaign=skandal-${i}`,
      ),
    );
    const n = example.title.slice("Skandal haberi ".length);
    expect(example.url).toBe(`https://www.diken.com.tr/skandal-${n}/`);
  });

  it("drops the Evrensel utm query and keeps a real param", () => {
    const example = skandalExample(
      scenario((i) =>
        i % 2 === 0
          ? `https://www.evrensel.net/haber/60076${String(i).padStart(2, "0")}/skandal?utm_source=rss_feed&utm_medium=rss&utm_campaign=rss_syndication`
          : `https://example.com/skandal-${i}?id=5&utm_source=rss`,
      ),
    );
    const n = Number(example.title.slice("Skandal haberi ".length));
    expect(example.url).toBe(
      n % 2 === 0
        ? `https://www.evrensel.net/haber/60076${String(n).padStart(2, "0")}/skandal`
        : `https://example.com/skandal-${n}?id=5`,
    );
  });

  it("leaves a clean url alone, and still turns a non-http(s) or missing url into null", () => {
    const clean = skandalExample(scenario((i) => `https://example.com/skandal-${i}`));
    const cleanN = clean.title.slice("Skandal haberi ".length);
    expect(clean.url).toBe(`https://example.com/skandal-${cleanN}`);

    expect(skandalExample(scenario(() => "javascript:alert(1)")).url).toBeNull();
    expect(skandalExample(scenario(() => "ftp://example.com/x?utm_source=1")).url).toBeNull();
    expect(skandalExample(scenario(() => null)).url).toBeNull();
    expect(skandalExample(scenario(() => "")).url).toBeNull();
  });
});
