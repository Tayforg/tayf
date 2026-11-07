import { describe, it, expect } from "vitest";
import { isGameEligibleTitle } from "@/lib/game/pii-filter";
import { SOURCE_RECENT_LIMIT, selectSourceRecentArticles } from "./source-recent-filter";

// ---------------------------------------------------------------------------
// h61-journey-3. /source/<slug> 'Son haberler' lists a source's newest
// articles with no regard for whether they belong to a cluster. Unclustered
// crime and accident items (initials, age, village) therefore surfaced on an
// indexable page, bypassing the site's own private-individual filter
// (src/lib/game/pii-filter.ts). The pure selection pinned here drops an
// UNCLUSTERED article whose title or description matches that filter, keeps
// every clustered one (political, already public on cluster pages), and keeps
// the list newest-first (input order) and capped.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  title: string;
  description: string | null;
}

// Invented text: the title carries no private-individual pattern, only the
// description does ("2 çocuk annesi"). ZZMARKER lets a test prove it was not logged.
const DESC_ONLY_PII: Row = {
  id: "desc-pii",
  title: "Bir ilçede eski eşine ateş açtı",
  description: "Olay bir köyde yaşandı. Zanlı, 2 çocuk annesi eski eşine ateş etti. ZZMARKER",
};

const WORK_ACCIDENT: Row = {
  id: "makarna",
  title: "Makarna fabrikasında iş cinayeti: 21 yaşındaki genç işçi hayatını kaybetti",
  description: "Fabrikadaki kazada genç işçi yaşamını yitirdi.",
};

const POLITICAL: Row = {
  id: "pol",
  title: "Meclis'te bütçe görüşmeleri başladı",
  description: "Genel Kurul'da komisyon raporu okundu.",
};

const NONE: ReadonlySet<string> = new Set();

function row(i: number, flagged: boolean): Row {
  return {
    id: `r${i}`,
    title: flagged ? `Olayda ${i} yaşındaki kişi yaralandı` : `Bütçe görüşmesi ${i}`,
    description: null,
  };
}

describe("selectSourceRecentArticles", () => {
  it("drops an unclustered row whose DESCRIPTION matches", () => {
    // The title alone carries no pattern; only the description does.
    expect(isGameEligibleTitle(DESC_ONLY_PII.title)).toBe(true);
    expect(isGameEligibleTitle(DESC_ONLY_PII.description ?? "")).toBe(false);
    expect(selectSourceRecentArticles([DESC_ONLY_PII], NONE)).toEqual([]);
  });

  it("drops an unclustered row whose TITLE matches (iş cinayeti, yaşındaki, hayatını kaybet)", () => {
    expect(selectSourceRecentArticles([WORK_ACCIDENT], NONE)).toEqual([]);
  });

  it("keeps the same flagged row when its id is in the clustered set", () => {
    const clustered = new Set([WORK_ACCIDENT.id, DESC_ONLY_PII.id]);
    expect(selectSourceRecentArticles([WORK_ACCIDENT, DESC_ONLY_PII], clustered)).toEqual([
      WORK_ACCIDENT,
      DESC_ONLY_PII,
    ]);
  });

  it("keeps a plain political row", () => {
    expect(selectSourceRecentArticles([POLITICAL], NONE)).toEqual([POLITICAL]);
  });

  it("judges a row whose description is null on its title alone", () => {
    const cleanNull: Row = { id: "n1", title: "Merkez Bankası faiz kararını açıkladı", description: null };
    const flaggedNull: Row = { id: "n2", title: "Şüpheli tutuklandı", description: null };

    expect(selectSourceRecentArticles([cleanNull, flaggedNull], NONE)).toEqual([cleanNull]);
  });

  it("uses the full predicate: diacritic-free and all-caps Turkish are caught too", () => {
    const folded: Row = { id: "f1", title: "17 yasindaki genc kazada oldu", description: null };
    const caps: Row = { id: "f2", title: "Haber", description: "MEHMET K. ADLI ŞAHIS YAKALANDI" };

    expect(selectSourceRecentArticles([folded, caps, POLITICAL], NONE)).toEqual([POLITICAL]);
  });

  it("keeps a clustered id even when only a different row of the list is clustered", () => {
    // Membership is per id: clustering one flagged row does not rescue another.
    const other: Row = { ...WORK_ACCIDENT, id: "makarna-2" };
    expect(
      selectSourceRecentArticles([WORK_ACCIDENT, other], new Set([WORK_ACCIDENT.id])),
    ).toEqual([WORK_ACCIDENT]);
  });

  it("returns the 15 clean rows in input order when 25 of 40 are flagged", () => {
    // 7 is coprime with 40, so (i * 7) % 40 visits 25 distinct indices:
    // a deterministic, interleaved 25-of-40 split.
    const flaggedIdx = new Set<number>();
    for (let i = 0; flaggedIdx.size < 25; i += 1) flaggedIdx.add((i * 7) % 40);
    expect(flaggedIdx.size).toBe(25);
    const rows = Array.from({ length: 40 }, (_, i) => row(i, flaggedIdx.has(i)));

    const out = selectSourceRecentArticles(rows, NONE);

    const expected = rows.filter((_, i) => !flaggedIdx.has(i));
    expect(expected).toHaveLength(15);
    expect(out).toEqual(expected);
  });

  it("returns exactly 20 of 40 clean rows (the newest 20, in input order)", () => {
    const rows = Array.from({ length: 40 }, (_, i) => row(i, false));

    const out = selectSourceRecentArticles(rows, NONE);

    expect(out).toHaveLength(20);
    expect(out.map((r) => r.id)).toEqual(rows.slice(0, 20).map((r) => r.id));
    expect(SOURCE_RECENT_LIMIT).toBe(20);
  });

  it("honours an explicit limit and treats a non-positive limit as empty", () => {
    const rows = Array.from({ length: 10 }, (_, i) => row(i, false));

    expect(selectSourceRecentArticles(rows, NONE, 3).map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
    expect(selectSourceRecentArticles(rows, NONE, 0)).toEqual([]);
    expect(selectSourceRecentArticles(rows, NONE, -4)).toEqual([]);
  });

  it("handles an empty list and does not mutate its input", () => {
    expect(selectSourceRecentArticles([], NONE)).toEqual([]);

    const rows = [WORK_ACCIDENT, POLITICAL];
    const snapshot = [...rows];
    selectSourceRecentArticles(rows, NONE);
    expect(rows).toEqual(snapshot);
  });

  it("returns the very same row objects it kept (extra fields such as url ride along)", () => {
    const withExtras = { ...POLITICAL, url: "https://ornek.example/pol", image_url: null };
    const [kept] = selectSourceRecentArticles([withExtras], NONE);
    expect(kept).toBe(withExtras);
  });
});
