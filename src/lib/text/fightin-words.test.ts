import { describe, it, expect } from "vitest";
import { fightinWords, logOddsZ, FW_DEFAULTS, type FwDoc } from "./fightin-words";

describe("logOddsZ", () => {
  it("matches the closed-form recomputation and is about 3.0", () => {
    const yI = 10;
    const nI = 100;
    const yJ = 2;
    const nJ = 200;
    const alphaW = 1.2;
    const alpha0 = 30;

    const { delta, z } = logOddsZ(yI, nI, yJ, nJ, alphaW, alpha0);

    const expectedDelta =
      Math.log((yI + alphaW) / (nI + alpha0 - yI - alphaW)) -
      Math.log((yJ + alphaW) / (nJ + alpha0 - yJ - alphaW));
    const expectedVar = 1 / (yI + alphaW) + 1 / (yJ + alphaW);
    const expectedZ = expectedDelta / Math.sqrt(expectedVar);

    expect(delta).toBeCloseTo(expectedDelta, 10);
    expect(z).toBeCloseTo(expectedZ, 10);
    expect(z).toBeCloseTo(3.0, 1);
  });
});

function doc(zone: FwDoc["zone"], sourceId: string, terms: string[]): FwDoc {
  return { zone, sourceId, terms: new Set(terms) };
}

/** N docs for one zone, cycling through `sources` distinct source ids. */
function manyDocs(
  zone: FwDoc["zone"],
  n: number,
  terms: string[],
  sources: string[],
): FwDoc[] {
  return Array.from({ length: n }, (_, i) =>
    doc(zone, sources[i % sources.length]!, terms),
  );
}

describe("fightinWords", () => {
  it("returns three empty lists for empty input", () => {
    expect(fightinWords([])).toEqual({
      iktidar: [],
      bagimsiz: [],
      muhalefet: [],
    });
  });

  it("identical zone corpora produce no distinctive terms anywhere", () => {
    const docs: FwDoc[] = [
      ...manyDocs("iktidar", 20, ["ekonomi"], ["s1", "s2", "s3", "s4"]),
      ...manyDocs("bagimsiz", 20, ["ekonomi"], ["s5", "s6", "s7", "s8"]),
      ...manyDocs("muhalefet", 20, ["ekonomi"], ["s9", "s10", "s11", "s12"]),
    ];
    const result = fightinWords(docs);
    expect(result.iktidar).toEqual([]);
    expect(result.bagimsiz).toEqual([]);
    expect(result.muhalefet).toEqual([]);
  });

  it("a term in 6 headlines from 3 sources, only in muhalefet, appears only there", () => {
    const docs: FwDoc[] = [
      ...manyDocs("muhalefet", 6, ["yolsuzluk"], ["s1", "s2", "s3"]),
      // A second distinctive term so muhalefet clears minTermsToShow (2).
      ...manyDocs("muhalefet", 20, ["skandal"], ["s1", "s2", "s3"]),
      ...manyDocs("iktidar", 30, ["ekonomi"], ["s4", "s5", "s6"]),
      ...manyDocs("bagimsiz", 30, ["ekonomi"], ["s7", "s8", "s9"]),
    ];
    const result = fightinWords(docs);
    expect(result.muhalefet.some((t) => t.term === "yolsuzluk")).toBe(true);
    expect(result.iktidar.some((t) => t.term === "yolsuzluk")).toBe(false);
    expect(result.bagimsiz.some((t) => t.term === "yolsuzluk")).toBe(false);
  });

  it("excludes a term appearing in only 4 headlines (minCount)", () => {
    const docs: FwDoc[] = [
      ...manyDocs("muhalefet", 4, ["skandal"], ["s1", "s2", "s3"]),
      ...manyDocs("iktidar", 30, ["ekonomi"], ["s4", "s5", "s6"]),
      ...manyDocs("bagimsiz", 30, ["ekonomi"], ["s7", "s8", "s9"]),
    ];
    const result = fightinWords(docs);
    expect(result.muhalefet.some((t) => t.term === "skandal")).toBe(false);
  });

  it("excludes 10 headlines from a single source (minSources)", () => {
    const docs: FwDoc[] = [
      ...manyDocs("muhalefet", 10, ["kampanya"], ["s1"]),
      ...manyDocs("iktidar", 30, ["ekonomi"], ["s4", "s5", "s6"]),
      ...manyDocs("bagimsiz", 30, ["ekonomi"], ["s7", "s8", "s9"]),
    ];
    const result = fightinWords(docs);
    expect(result.muhalefet.some((t) => t.term === "kampanya")).toBe(false);
  });

  it("returns [] when only 1 term passes (minTermsToShow)", () => {
    const docs: FwDoc[] = [
      ...manyDocs("muhalefet", 20, ["yolsuzluk"], ["s1", "s2", "s3"]),
      ...manyDocs("iktidar", 30, ["ekonomi"], ["s4", "s5", "s6"]),
      ...manyDocs("bagimsiz", 30, ["ekonomi"], ["s7", "s8", "s9"]),
    ];
    const result = fightinWords(docs, { minTermsToShow: 2 });
    expect(result.muhalefet).toEqual([]);
  });

  it("suppresses the unigrams making up a picked bigram", () => {
    const docs: FwDoc[] = [
      ...manyDocs(
        "muhalefet",
        20,
        ["terör", "örgütü", "terör örgütü"],
        ["s1", "s2", "s3", "s4"],
      ),
      ...manyDocs(
        "muhalefet",
        20,
        ["baska", "kelime"],
        ["s5", "s6", "s7", "s8"],
      ),
      ...manyDocs("iktidar", 40, ["ekonomi"], ["s9", "s10", "s11"]),
      ...manyDocs("bagimsiz", 40, ["ekonomi"], ["s12", "s13", "s14"]),
    ];
    const result = fightinWords(docs);
    const terms = result.muhalefet.map((t) => t.term);
    if (terms.includes("terör örgütü")) {
      expect(terms).not.toContain("terör");
      expect(terms).not.toContain("örgütü");
    }
  });

  it("caps the picked list at topK (8)", () => {
    const words = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const docs: FwDoc[] = [];
    for (const w of words) {
      docs.push(...manyDocs("muhalefet", 20, [w], ["s1", "s2", "s3", "s4"]));
    }
    docs.push(...manyDocs("iktidar", 200, ["ekonomi"], ["s9", "s10", "s11"]));
    docs.push(...manyDocs("bagimsiz", 200, ["ekonomi"], ["s12", "s13", "s14"]));
    const result = fightinWords(docs);
    expect(result.muhalefet.length).toBeLessThanOrEqual(FW_DEFAULTS.topK);
  });

  it("gives identical output for shuffled input", () => {
    const docs: FwDoc[] = [
      ...manyDocs("muhalefet", 20, ["yolsuzluk"], ["s1", "s2", "s3", "s4"]),
      ...manyDocs("muhalefet", 20, ["skandal"], ["s5", "s6", "s7", "s8"]),
      ...manyDocs("iktidar", 40, ["ekonomi"], ["s9", "s10", "s11"]),
      ...manyDocs("bagimsiz", 40, ["ekonomi"], ["s12", "s13", "s14"]),
    ];
    const shuffled = [...docs].reverse();
    expect(fightinWords(shuffled)).toEqual(fightinWords(docs));
  });

  it("a larger priorScale gives a smaller z for the same term", () => {
    const docs: FwDoc[] = [
      ...manyDocs("muhalefet", 20, ["yolsuzluk"], ["s1", "s2", "s3", "s4"]),
      ...manyDocs("muhalefet", 20, ["skandal"], ["s1", "s2", "s3", "s4"]),
      // "yolsuzluk" also shows up lightly elsewhere so the prior comparison
      // isn't dominated by a yJ = 0 edge case.
      ...manyDocs("iktidar", 2, ["yolsuzluk"], ["s9", "s10"]),
      ...manyDocs("iktidar", 38, ["ekonomi"], ["s9", "s10", "s11"]),
      ...manyDocs("bagimsiz", 40, ["ekonomi"], ["s12", "s13", "s14"]),
    ];
    const small = fightinWords(docs, { priorScale: 0.1 });
    const large = fightinWords(docs, { priorScale: 0.5 });
    const smallZ = small.muhalefet.find((t) => t.term === "yolsuzluk")?.z;
    const largeZ = large.muhalefet.find((t) => t.term === "yolsuzluk")?.z;
    expect(smallZ).toBeDefined();
    expect(largeZ).toBeDefined();
    expect(largeZ!).toBeLessThan(smallZ!);
  });
});
