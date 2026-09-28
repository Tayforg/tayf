import { describe, it, expect } from "vitest";
import {
  buildWeeklyDistinctiveWords,
  WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE,
  type WeeklyWordsArticleRow,
  type WeeklyWordsSourceRow,
} from "./distinctive-words";

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
  // Sources that must be dropped:
  { id: "src-inactive", name: "Inactive", bias: "opposition", kind: "outlet", active: false },
  { id: "src-nonvoting", name: "Niche", bias: "opposition", kind: "niche", active: true },
  { id: "src-nobias", name: "No Bias", bias: null, kind: "outlet", active: true },
];

/** Generates `n` filler rows for `zoneSourceIds`, each with a unique title so headlineKey dedupe doesn't collapse them. */
function fillerRows(
  n: number,
  zoneSourceIds: string[],
  idPrefix: string,
): WeeklyWordsArticleRow[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${idPrefix}-${String(i).padStart(4, "0")}`,
    title: `Ekonomi haberi ${idPrefix} ${i}`,
    url: `https://example.com/${idPrefix}-${i}`,
    source_id: zoneSourceIds[i % zoneSourceIds.length]!,
    created_at: "2026-09-20T10:00:00.000Z",
  }));
}

const MIN = WEEKLY_WORDS_MIN_HEADLINES_PER_ZONE;

function baselineRows(): WeeklyWordsArticleRow[] {
  return [
    ...fillerRows(MIN, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
    ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
    ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
  ];
}

describe("buildWeeklyDistinctiveWords", () => {
  it("drops rows from non-voting, inactive or unknown-bias sources", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      { id: "z-1", title: "Bir haber", url: null, source_id: "src-inactive", created_at: "x" },
      { id: "z-2", title: "Bir haber 2", url: null, source_id: "src-nonvoting", created_at: "x" },
      { id: "z-3", title: "Bir haber 3", url: null, source_id: "src-nobias", created_at: "x" },
      { id: "z-4", title: "Bir haber 4", url: null, source_id: "unknown-source", created_at: "x" },
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.sample.iktidar).toBe(MIN);
      expect(result.sample.bagimsiz).toBe(MIN);
      expect(result.sample.muhalefet).toBe(MIN);
    }
  });

  it("a zone below the minimum returns insufficient with the sample counts", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(50, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("insufficient");
    if (result.status === "insufficient") {
      expect(result.sample).toEqual({ iktidar: MIN, bagimsiz: MIN, muhalefet: 50 });
    }
  });

  it("a duplicate headline counts once within a zone, but counts in every zone it appears in", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...baselineRows(),
      // The same headline, twice, in muhalefet: should dedupe to 1 kept doc.
      { id: "dup-a", title: "AYNI BAŞLIK", url: null, source_id: "src-opp-1", created_at: "x" },
      { id: "dup-b", title: "aynı başlık", url: null, source_id: "src-opp-2", created_at: "x" },
      // The same headline text also appears once in iktidar — a different
      // zone, so it counts there too.
      { id: "dup-c", title: "AYNI BAŞLIK", url: null, source_id: "src-gov-1", created_at: "x" },
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      // muhalefet gained 1 kept doc (deduped from 2), iktidar gained 1.
      expect(result.sample.muhalefet).toBe(MIN + 1);
      expect(result.sample.iktidar).toBe(MIN + 1);
    }
  });

  it("the display form prefers Gözaltı/gözaltı over GÖZALTI but keeps CHP", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
      ...fillerRows(MIN - 40, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
      // muhalefet: "gözaltı" as a strongly distinctive term, mostly
      // all-caps but with one lowercase occurrence and CHP alongside.
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `gz-${String(i).padStart(3, "0")}`,
        title:
          i === 0
            ? "CHP'li isimler hakkında gözaltı kararı"
            : `GÖZALTI kararı CHP ${i}`,
        url: null,
        source_id: ["src-gov-1", "src-gov-2", "src-gov-3"][i % 3]!,
        created_at: "x",
      })),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const gozalti = result.zones.iktidar.find((t) => t.term === "gözaltı");
      expect(gozalti?.display).toBe("gözaltı");
      const chp = result.zones.iktidar.find((t) => t.term === "chp");
      expect(chp?.display).toBe("CHP");
    }
  });

  it("an example url of 'javascript:alert(1)' becomes null", () => {
    const rows: WeeklyWordsArticleRow[] = [
      ...fillerRows(MIN, ["src-ind-1", "src-ind-2", "src-ind-3"], "ind"),
      ...fillerRows(MIN, ["src-opp-1", "src-opp-2", "src-opp-3"], "opp"),
      ...fillerRows(MIN - 40, ["src-gov-1", "src-gov-2", "src-gov-3"], "gov"),
      ...Array.from({ length: 40 }, (_, i) => ({
        id: `xz-${String(i).padStart(3, "0")}`,
        title: `Skandal haberi ${i}`,
        url: "javascript:alert(1)",
        source_id: ["src-gov-1", "src-gov-2", "src-gov-3"][i % 3]!,
        created_at: "x",
      })),
    ];
    const result = buildWeeklyDistinctiveWords(rows, SOURCES);
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const skandal = result.zones.iktidar.find((t) => t.term === "skandal");
      expect(skandal?.example?.url).toBeNull();
    }
  });
});
