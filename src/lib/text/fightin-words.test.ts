import { describe, it, expect } from "vitest";
import {
  calibratedZCut,
  fightinWords,
  logOddsZ,
  mulberry32,
  FW_DEFAULTS,
  type FwDoc,
  type FwOptions,
} from "./fightin-words";

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

  it("exposes the documented defaults, including the per-source share cap", () => {
    expect(FW_DEFAULTS).toEqual({
      minCount: 5,
      minSources: 3,
      zMin: 1.96,
      topK: 8,
      minTermsToShow: 2,
      priorScale: 0.1,
      maxSourceShare: 0.5,
      nullPermutations: 20,
      nullQuantile: 0.95,
      nullSeed: 20261106,
    });
  });
});

// ---------------------------------------------------------------------------
// maxSourceShare: one outlet's template wording is not how a zone writes.
// ---------------------------------------------------------------------------

/**
 * A corpus whose only zone-specific vocabulary is in 'bagimsiz'. `termDocs` are
 * the docs under test; two evenly spread companion terms ('skandal', 'kriz',
 * 14 docs per outlet over three outlets each) keep the zone above
 * minTermsToShow, so an empty list can never be mistaken for a pass. The other
 * zones carry plenty of filler, and 'bagimsiz' has enough filler that the
 * share of the term's docs is judged against the term's own docs, not the
 * whole zone (40 of ~230 zone docs is far below 0.5; 40 of 42 is not).
 */
function bagimsizCorpus(termDocs: FwDoc[]): FwDoc[] {
  return [
    ...termDocs,
    ...manyDocs("bagimsiz", 42, ["skandal"], ["c1", "c2", "c3"]),
    ...manyDocs("bagimsiz", 42, ["kriz"], ["c4", "c5", "c6"]),
    ...manyDocs("bagimsiz", 100, ["ekonomi"], ["c7", "c8", "c9", "c10"]),
    ...manyDocs("iktidar", 200, ["ekonomi"], ["i1", "i2", "i3", "i4"]),
    ...manyDocs("muhalefet", 200, ["ekonomi"], ["m1", "m2", "m3", "m4"]),
  ];
}

/** `counts[k]` docs of the k-th source id, all in 'bagimsiz', all carrying `term`. */
function docsBySource(term: string, counts: Record<string, number>): FwDoc[] {
  const docs: FwDoc[] = [];
  for (const [sourceId, n] of Object.entries(counts)) {
    for (let i = 0; i < n; i++) docs.push(doc("bagimsiz", sourceId, [term]));
  }
  return docs;
}

function bagimsizTerms(docs: readonly FwDoc[], opts?: Partial<FwOptions>): string[] {
  return fightinWords(docs, opts).bagimsiz.map((t) => t.term);
}

/** Deterministic Fisher-Yates (mulberry32), so a failing shuffle is reproducible. */
function shuffled<T>(items: readonly T[], seed: number): T[] {
  const out = [...items];
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("fightinWords: maxSourceShare", () => {
  const dominated = () => docsBySource("coşkusu", { A: 40, B: 1, C: 1 });

  it("drops a term that one outlet supplies 40 of 42 times, although three outlets carry it", () => {
    const terms = bagimsizTerms(bagimsizCorpus(dominated()));
    expect(terms).not.toContain("coşkusu");
    // The cap removes only that term: the evenly spread ones are still listed.
    expect(terms).toEqual(expect.arrayContaining(["skandal", "kriz"]));
  });

  it("control: with maxSourceShare 1 the same corpus lists the dominated term", () => {
    // Proves the cap is what removes it: minSources (3) and z (> 1.96) both pass.
    const result = fightinWords(bagimsizCorpus(dominated()), { maxSourceShare: 1 });
    const hit = result.bagimsiz.find((t) => t.term === "coşkusu");
    expect(hit).toBeDefined();
    expect(hit!.sources).toBe(3);
    expect(hit!.count).toBe(42);
    expect(hit!.z).toBeGreaterThan(FW_DEFAULTS.zMin);
  });

  it("keeps a term spread evenly 14/14/14 over three outlets", () => {
    const terms = bagimsizTerms(
      bagimsizCorpus(docsBySource("coşkusu", { A: 14, B: 14, C: 14 })),
    );
    expect(terms).toContain("coşkusu");
  });

  it("keeps a term whose top outlet holds exactly the cap (10/5/5 = 0.5)", () => {
    const terms = bagimsizTerms(bagimsizCorpus(docsBySource("coşkusu", { A: 10, B: 5, C: 5 })));
    expect(terms).toContain("coşkusu");
  });

  it("drops a term just over the cap (11/5/5 = 11/21)", () => {
    const terms = bagimsizTerms(bagimsizCorpus(docsBySource("coşkusu", { A: 11, B: 5, C: 5 })));
    expect(terms).not.toContain("coşkusu");
    expect(terms).toEqual(expect.arrayContaining(["skandal", "kriz"]));
  });

  it("uses the option, not a constant: a looser cap admits 11/5/5, a tighter one drops 14/14/14", () => {
    const over = bagimsizCorpus(docsBySource("coşkusu", { A: 11, B: 5, C: 5 }));
    expect(bagimsizTerms(over, { maxSourceShare: 0.6 })).toContain("coşkusu");

    const even = bagimsizCorpus(docsBySource("coşkusu", { A: 14, B: 14, C: 14 }));
    expect(bagimsizTerms(even, { maxSourceShare: 0.3 })).not.toContain("coşkusu");
  });

  it("applies per zone: a term dominated in one zone is still listed where it is spread", () => {
    const docs: FwDoc[] = [
      // 'gol': 40/42 from one outlet in iktidar (dropped there) ...
      ...Array.from({ length: 40 }, () => doc("iktidar", "A", ["gol"])),
      doc("iktidar", "B", ["gol"]),
      doc("iktidar", "C", ["gol"]),
      // iktidar's own spread terms keep its list above minTermsToShow, so
      // dropping 'gol' there is the cap's doing and not an empty list.
      ...manyDocs("iktidar", 42, ["bütçe"], ["J", "K", "L"]),
      ...manyDocs("iktidar", 42, ["ihale"], ["M", "N", "O"]),
      // ... but 14/14/14 in muhalefet (kept there).
      ...manyDocs("muhalefet", 42, ["gol"], ["D", "E", "F"]),
      ...manyDocs("muhalefet", 42, ["kriz"], ["G", "H", "I"]),
      ...manyDocs("iktidar", 200, ["ekonomi"], ["i1", "i2", "i3", "i4"]),
      // A large third zone keeps 'gol' strongly over-represented in both of the others.
      ...manyDocs("bagimsiz", 4000, ["ekonomi"], ["b1", "b2", "b3", "b4"]),
    ];
    // Without the cap 'gol' is listed in iktidar too, so the cap is what drops it.
    expect(
      fightinWords(docs, { maxSourceShare: 1 }).iktidar.map((t) => t.term),
    ).toContain("gol");

    const result = fightinWords(docs);
    const iktidar = result.iktidar.map((t) => t.term);
    expect(iktidar).toEqual(expect.arrayContaining(["bütçe", "ihale"]));
    expect(iktidar).not.toContain("gol");
    expect(result.muhalefet.map((t) => t.term)).toContain("gol");
  });

  it("counts a doc once per term, whatever else it carries", () => {
    // 'coşkusu' rides along with other terms on every one of A's docs; the per-source
    // tally is per (doc, term), so A still holds 40 of 42 and the term is dropped.
    const docs = [
      ...Array.from({ length: 40 }, () => doc("bagimsiz", "A", ["coşkusu", "bayram", "meydan"])),
      doc("bagimsiz", "B", ["coşkusu"]),
      doc("bagimsiz", "C", ["coşkusu"]),
    ];
    expect(bagimsizTerms(bagimsizCorpus(docs))).not.toContain("coşkusu");
  });

  it("gives identical output for shuffled input with the cap active", () => {
    const docs = bagimsizCorpus(dominated());
    const expected = fightinWords(docs);
    // The cap is active here (the term is dropped) and the list is not empty.
    expect(expected.bagimsiz.map((t) => t.term)).not.toContain("coşkusu");
    expect(expected.bagimsiz.length).toBeGreaterThanOrEqual(FW_DEFAULTS.minTermsToShow);

    expect(fightinWords([...docs].reverse())).toEqual(expected);
    for (const seed of [1, 2, 3]) {
      expect(fightinWords(shuffled(docs, seed))).toEqual(expected);
    }
  });

  it("keeps the FwTerm shape unchanged", () => {
    const result = fightinWords(bagimsizCorpus(docsBySource("coşkusu", { A: 14, B: 14, C: 14 })));
    const hit = result.bagimsiz.find((t) => t.term === "coşkusu");
    expect(Object.keys(hit!).sort()).toEqual(["count", "sources", "term", "z"]);
  });
});

// ---------------------------------------------------------------------------
// calibratedZCut: a permutation-calibrated z cut (h52-weekly-1).
//
// ~1,000 candidate terms per zone, each tested at z >= 1.96, pass by chance
// alone (about 25 per zone with the zone labels shuffled). The cut is the
// 95th percentile of the best z that shuffled labels produce.
// ---------------------------------------------------------------------------

describe("mulberry32", () => {
  it("is deterministic per seed, in [0, 1), and differs between seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(1);
    const c = mulberry32(2);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(first);
    for (let i = 0; i < 1000; i++) {
      const v = a();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it("pins the stream so a change of generator cannot move every cut silently", () => {
    const rand = mulberry32(1);
    expect([rand(), rand(), rand()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522,
    ]);
  });
});

/** Seeded uniform generator for fixtures, independent of the module under test. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ZONES3: ReadonlyArray<FwDoc["zone"]> = ["iktidar", "bagimsiz", "muhalefet"];

/**
 * Pure noise: 3 zones x `perZone` docs over 30 outlets (10 per zone), each doc
 * 8 draws from a 300-word Zipf vocabulary. The zone has no influence on the
 * words, so no term is truly distinctive for any zone.
 */
function zipfNoise(seed: number, perZone = 200): FwDoc[] {
  const rand = seededRandom(seed);
  const vocabSize = 300;
  const cumulative: number[] = [];
  let total = 0;
  for (let rank = 1; rank <= vocabSize; rank++) {
    total += 1 / rank;
    cumulative.push(total);
  }
  const draw = (): string => {
    const target = rand() * total;
    let lo = 0;
    let hi = vocabSize - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    return `w${String(lo).padStart(3, "0")}`;
  };

  const docs: FwDoc[] = [];
  ZONES3.forEach((zone, zoneIndex) => {
    for (let i = 0; i < perZone; i++) {
      const terms = new Set<string>();
      for (let k = 0; k < 8; k++) terms.add(draw());
      const sourceId = `s${String(zoneIndex * 10 + Math.floor(rand() * 10)).padStart(2, "0")}`;
      docs.push({ zone, sourceId, terms });
    }
  });
  return docs;
}

/** Adds `term` to `inZone` docs of the zone (spread over its outlets) and to `elsewhere` docs of the other zones. */
function plant(
  docs: readonly FwDoc[],
  term: string,
  zone: FwDoc["zone"],
  inZone: number,
  elsewhere: number,
): FwDoc[] {
  const out = docs.map((d) => ({ ...d, terms: new Set(d.terms) }));
  const hosts = out.filter((d) => d.zone === zone);
  // Walk the zone's docs in order, taking at most 7 per outlet so >= 6 outlets carry the term.
  const perSource = new Map<string, number>();
  let planted = 0;
  for (const d of hosts) {
    if (planted >= inZone) break;
    const n = perSource.get(d.sourceId) ?? 0;
    if (n >= 7) continue;
    perSource.set(d.sourceId, n + 1);
    d.terms.add(term);
    planted += 1;
  }
  expect(planted).toBe(inZone);
  expect(perSource.size).toBeGreaterThanOrEqual(6);
  const others = out.filter((d) => d.zone !== zone);
  for (let i = 0; i < elsewhere; i++) others[i * 37]!.terms.add(term);
  return out;
}

const NOISE_SEEDS = [11, 22, 33, 44, 55];

function allEmpty(result: ReturnType<typeof fightinWords>): boolean {
  return ZONES3.every((z) => result[z].length === 0);
}

describe("calibratedZCut", () => {
  it("(a) control: on pure noise the fixed 1.96 cut lists terms in at least one zone", () => {
    // Proves the fixture is the bug's shape: a cut of 1.96 admits chance terms.
    let seedsWithNoise = 0;
    for (const seed of NOISE_SEEDS) {
      if (!allEmpty(fightinWords(zipfNoise(seed)))) seedsWithNoise += 1;
    }
    expect(seedsWithNoise).toBe(NOISE_SEEDS.length);
  });

  it("(a) with the calibrated cut, pure noise lists nothing in any zone", () => {
    for (const seed of NOISE_SEEDS) {
      const docs = zipfNoise(seed);
      const cut = calibratedZCut(docs);
      expect(cut, `seed ${seed}`).toBeGreaterThan(FW_DEFAULTS.zMin);
      expect(allEmpty(fightinWords(docs, { zMin: cut })), `seed ${seed}`).toBe(true);
    }
  });

  it("(b) a term planted in 40 iktidar docs over 6+ outlets and 2 docs elsewhere still surfaces for iktidar", () => {
    const docs = plant(zipfNoise(11), "yolsuzluk", "iktidar", 40, 2);
    const cut = calibratedZCut(docs);
    const result = fightinWords(docs, { zMin: cut, minTermsToShow: 1 });

    const hit = result.iktidar.find((t) => t.term === "yolsuzluk");
    expect(hit).toBeDefined();
    expect(hit!.z).toBeGreaterThan(cut);
    expect(hit!.count).toBe(40);
    // The planted term is the only one: nothing else surfaces anywhere.
    expect(result.iktidar.map((t) => t.term)).toEqual(["yolsuzluk"]);
    expect(result.bagimsiz).toEqual([]);
    expect(result.muhalefet).toEqual([]);
  });

  it("(b) the planted term is not enough on its own: minTermsToShow still applies", () => {
    const docs = plant(zipfNoise(11), "yolsuzluk", "iktidar", 40, 2);
    const result = fightinWords(docs, { zMin: calibratedZCut(docs) });
    expect(result.iktidar).toEqual([]);
  });

  it("(c) is independent of the order of the docs", () => {
    const docs = zipfNoise(22);
    const cut = calibratedZCut(docs);
    expect(calibratedZCut([...docs].reverse())).toBe(cut);
    for (const seed of [1, 2, 3]) {
      expect(calibratedZCut(shuffled(docs, seed))).toBe(cut);
    }
  });

  it("(c) is independent of the iteration order of each doc's terms", () => {
    const docs = zipfNoise(22);
    const reordered = docs.map((d) => ({ ...d, terms: new Set([...d.terms].reverse()) }));
    expect(calibratedZCut(reordered)).toBe(calibratedZCut(docs));
  });

  it("is deterministic: the same docs give the same cut on every call", () => {
    const docs = zipfNoise(33);
    const first = calibratedZCut(docs);
    expect(calibratedZCut(docs)).toBe(first);
    expect(calibratedZCut(zipfNoise(33))).toBe(first);
  });

  it("does not mutate its input", () => {
    const docs = zipfNoise(33);
    const snapshot = docs.map((d) => [d.zone, d.sourceId, [...d.terms].join(" ")]);
    calibratedZCut(docs);
    expect(docs.map((d) => [d.zone, d.sourceId, [...d.terms].join(" ")])).toEqual(snapshot);
  });

  it("(d) is never below FW_DEFAULTS.zMin, and equals it when no shuffled term is a candidate", () => {
    for (const seed of NOISE_SEEDS) {
      expect(calibratedZCut(zipfNoise(seed))).toBeGreaterThanOrEqual(FW_DEFAULTS.zMin);
    }
    // 20 + 20 + 20 identical docs: no term is ever over-represented, whatever the labels.
    const flat: FwDoc[] = [
      ...manyDocs("iktidar", 20, ["ekonomi"], ["s1", "s2", "s3", "s4"]),
      ...manyDocs("bagimsiz", 20, ["ekonomi"], ["s5", "s6", "s7", "s8"]),
      ...manyDocs("muhalefet", 20, ["ekonomi"], ["s9", "s10", "s11", "s12"]),
    ];
    expect(calibratedZCut(flat)).toBe(FW_DEFAULTS.zMin);
  });

  it("(d) a caller's zMin is a floor for the cut, not a ceiling", () => {
    const docs = zipfNoise(44);
    const natural = calibratedZCut(docs);
    expect(calibratedZCut(docs, { zMin: natural + 1 })).toBe(natural + 1);
    expect(calibratedZCut(docs, { zMin: 0.5 })).toBe(natural);
  });

  it("(e) nullPermutations 0 returns zMin exactly (the escape hatch)", () => {
    const docs = zipfNoise(44);
    expect(calibratedZCut(docs, { nullPermutations: 0 })).toBe(FW_DEFAULTS.zMin);
    expect(calibratedZCut(docs, { nullPermutations: 0, zMin: 2.5 })).toBe(2.5);
  });

  it("returns zMin for empty input", () => {
    expect(calibratedZCut([])).toBe(FW_DEFAULTS.zMin);
  });

  it("treats a negative or non-finite permutation count as none", () => {
    const docs = zipfNoise(44);
    expect(calibratedZCut(docs, { nullPermutations: -3 })).toBe(FW_DEFAULTS.zMin);
    expect(calibratedZCut(docs, { nullPermutations: Number.NaN })).toBe(FW_DEFAULTS.zMin);
  });

  it("uses the seed: another nullSeed gives another cut, the same seed the same cut", () => {
    const docs = zipfNoise(55);
    const a = calibratedZCut(docs, { nullSeed: 1 });
    const b = calibratedZCut(docs, { nullSeed: 2 });
    expect(a).not.toBe(b);
    expect(calibratedZCut(docs, { nullSeed: 1 })).toBe(a);
  });

  it("uses the quantile: a higher nullQuantile never gives a lower cut", () => {
    const docs = zipfNoise(55);
    const median = calibratedZCut(docs, { nullQuantile: 0.5 });
    const p95 = calibratedZCut(docs, { nullQuantile: 0.95 });
    const worst = calibratedZCut(docs, { nullQuantile: 1 });
    expect(median).toBeLessThanOrEqual(p95);
    expect(p95).toBeLessThanOrEqual(worst);
    expect(worst).toBeGreaterThan(median);
  });

  it("uses the permutation count: one permutation and twenty give different cuts", () => {
    const docs = zipfNoise(55);
    expect(calibratedZCut(docs, { nullPermutations: 1 })).not.toBe(calibratedZCut(docs));
  });

  it("applies the same candidate filters as the real pass (minSources, minCount, maxSourceShare)", () => {
    const docs = zipfNoise(11);
    expect(calibratedZCut(docs)).toBeGreaterThan(FW_DEFAULTS.zMin);
    // Nothing can be a candidate, so no shuffle can produce a score.
    expect(calibratedZCut(docs, { minSources: 999 })).toBe(FW_DEFAULTS.zMin);
    expect(calibratedZCut(docs, { minCount: 99999 })).toBe(FW_DEFAULTS.zMin);
    expect(calibratedZCut(docs, { maxSourceShare: 0 })).toBe(FW_DEFAULTS.zMin);
  });

  it("uses the same prior as the real pass: a larger priorScale gives a lower cut", () => {
    const docs = zipfNoise(11);
    expect(calibratedZCut(docs, { priorScale: 2 })).toBeLessThan(calibratedZCut(docs, { priorScale: 0.1 }));
  });

  it("keeps the cut below the strength of a genuinely distinctive term (calibration is not a blanket raise)", () => {
    const docs = plant(zipfNoise(33), "yolsuzluk", "muhalefet", 40, 2);
    const planted = fightinWords(docs, { zMin: 0, minTermsToShow: 1 }).muhalefet.find(
      (t) => t.term === "yolsuzluk",
    );
    expect(planted).toBeDefined();
    expect(planted!.z).toBeGreaterThan(calibratedZCut(docs) + 1);
  });

  it("scales: 10,000 docs complete in well under the page's budget", () => {
    const docs = zipfNoise(66, 3400);
    expect(docs.length).toBeGreaterThanOrEqual(10_000);
    const started = performance.now();
    const cut = calibratedZCut(docs);
    const elapsed = performance.now() - started;
    expect(cut).toBeGreaterThanOrEqual(FW_DEFAULTS.zMin);
    expect(elapsed).toBeLessThan(5000);
  });
});
