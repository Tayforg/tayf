import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_ORDER } from "@/lib/bias/config";
import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import {
  RISING_ENTITIES,
  RISING_HUB_SPECS,
  type RisingHubSpec,
} from "@/lib/trends/rising-entities";

import {
  ENTITY_HUB_LIMIT,
  ENTITY_HUB_MAX_TERMS,
  ENTITY_HUB_MIN_INDEXABLE,
  ENTITY_HUB_WINDOW_DAYS,
  QUANTITY_GUARD,
  entityByKey,
  entityHubForms,
  entityHubHeadlineOnly,
  entityHubNote,
  entityHubPatterns,
  entityHubQueries,
  entityHubRobots,
  entityHubSpec,
  foldEntityText,
  isEntityKey,
  sumDistributions,
} from "./entity-hub";

describe("constants", () => {
  it("pins the window, page size and indexable floor", () => {
    expect(ENTITY_HUB_WINDOW_DAYS).toBe(14);
    expect(ENTITY_HUB_LIMIT).toBe(20);
    expect(ENTITY_HUB_MIN_INDEXABLE).toBe(3);
  });

  it("mirrors the [1:12] slices of migration 125", () => {
    expect(ENTITY_HUB_MAX_TERMS).toBe(12);
  });
});

describe("entityByKey / isEntityKey", () => {
  it("resolves every curated key to its entity", () => {
    expect(RISING_ENTITIES.length).toBeGreaterThan(0);
    for (const e of RISING_ENTITIES) {
      expect(entityByKey(e.key)).toBe(e);
      expect(isEntityKey(e.key)).toBe(true);
    }
  });

  it("returns the label for a known key", () => {
    expect(entityByKey("erdogan")?.label).toBe("Erdoğan");
    expect(entityByKey("iyi-parti")?.label).toBe("İYİ Parti");
  });

  it("returns null / false for unknown keys", () => {
    for (const k of ["", "bilinmeyen", "ERDOGAN", "Erdoğan", " erdogan", "erdogan/", "chp "]) {
      expect(entityByKey(k)).toBeNull();
      expect(isEntityKey(k)).toBe(false);
    }
  });

  it("is not fooled by Object.prototype names", () => {
    for (const k of ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf"]) {
      expect(entityByKey(k)).toBeNull();
      expect(isEntityKey(k)).toBe(false);
    }
  });

  it("rejects non-string input without throwing", () => {
    for (const k of [undefined, null, 5, {}, [], ["erdogan"]]) {
      expect(isEntityKey(k as unknown as string)).toBe(false);
      expect(entityByKey(k as unknown as string)).toBeNull();
    }
  });
});

describe("sumDistributions", () => {
  const zero = Object.fromEntries(BIAS_ORDER.map((k) => [k, 0]));

  it("returns every BIAS_ORDER key at 0 for an empty list", () => {
    const out = sumDistributions([]);
    expect(out).toEqual(zero);
    expect(Object.keys(out).sort()).toEqual([...BIAS_ORDER].sort());
  });

  it("adds the per-cluster distributions key by key", () => {
    const out = sumDistributions([
      { cluster: { bias_distribution: { pro_government: 2, opposition: 1 } } },
      { cluster: { bias_distribution: { pro_government: 3, center: 4 } } },
    ]);
    expect(out).toEqual({ ...zero, pro_government: 5, opposition: 1, center: 4 });
  });

  it("ignores null, undefined, arrays, strings and numbers as a distribution", () => {
    const out = sumDistributions([
      { cluster: { bias_distribution: null } },
      { cluster: { bias_distribution: undefined } },
      { cluster: { bias_distribution: [1, 2, 3] } },
      { cluster: { bias_distribution: "pro_government" } },
      { cluster: { bias_distribution: 7 } },
      { cluster: { bias_distribution: { center: 1 } } },
    ]);
    expect(out).toEqual({ ...zero, center: 1 });
  });

  it("adds only finite numbers >= 0", () => {
    const out = sumDistributions([
      {
        cluster: {
          bias_distribution: {
            center: 2,
            opposition: -3,
            pro_government: Number.NaN,
            nationalist: Number.POSITIVE_INFINITY,
            international: Number.NEGATIVE_INFINITY,
            state_media: "4",
            gov_leaning: null,
            pro_kurdish: {},
            opposition_leaning: 0,
          },
        },
      },
    ]);
    expect(out).toEqual({ ...zero, center: 2 });
  });

  it("ignores keys outside BIAS_ORDER and inherited properties", () => {
    const inherited = Object.create({ center: 99 }) as Record<string, unknown>;
    inherited.opposition = 1;
    const out = sumDistributions([
      { cluster: { bias_distribution: { bogus: 5, __proto__x: 2, center: 1 } } },
      { cluster: { bias_distribution: inherited } },
    ]);
    expect(out).toEqual({ ...zero, center: 1, opposition: 1 });
    expect(Object.keys(out)).toHaveLength(BIAS_ORDER.length);
  });

  it("tolerates malformed bundle entries", () => {
    const bad = [null, undefined, 5, "x", {}, { cluster: null }, { cluster: 3 }] as unknown as Array<{
      cluster: { bias_distribution: unknown };
    }>;
    expect(sumDistributions(bad)).toEqual(zero);
  });

  it("does not mutate its input", () => {
    const d = { center: 2 };
    sumDistributions([{ cluster: { bias_distribution: d } }]);
    expect(d).toEqual({ center: 2 });
  });
});

describe("entityHubRobots", () => {
  const mk = (n: number) => ({ bundles: Array.from({ length: n }, () => ({})) });

  it("noindexes (but follows) when the read failed", () => {
    expect(entityHubRobots(null)).toEqual({ index: false, follow: true });
  });

  it("noindexes a thin hub: 0, 1 and 2 bundles", () => {
    for (const n of [0, 1, 2]) {
      expect(entityHubRobots(mk(n))).toEqual({ index: false, follow: true });
    }
  });

  it("leaves a hub with 3 or more bundles indexable (undefined)", () => {
    for (const n of [3, 4, 20]) {
      expect(entityHubRobots(mk(n))).toBeUndefined();
    }
  });
});

describe("entityHubNote", () => {
  it("states the total when everything is listed", () => {
    expect(entityHubNote(5, 5)).toBe("Son 14 günde 5 küme");
    expect(entityHubNote(0, 0)).toBe("Son 14 günde 0 küme");
  });

  it("does not claim a truncation when shown exceeds total", () => {
    expect(entityHubNote(3, 20)).toBe("Son 14 günde 3 küme");
  });

  it("adds the truncation clause when total > shown", () => {
    expect(entityHubNote(422, 20)).toBe(
      "Son 14 günde 422 küme · en yeni 20 tanesi listeleniyor",
    );
    expect(entityHubNote(21, 20)).toBe(
      "Son 14 günde 21 küme · en yeni 20 tanesi listeleniyor",
    );
  });
});

describe("purity", () => {
  it("imports only rising-entities, the Turkish query helper and the shared sum-distributions", () => {
    const src = readFileSync(resolve(__dirname, "entity-hub.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/[^\n]*/gm, "$1");
    const specs = [...src.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.sort()).toEqual(
      [
        "@/lib/bias/sum-distributions",
        "@/lib/clusters/turkish-query",
        "@/lib/trends/rising-entities",
      ].sort(),
    );
    expect(src).not.toMatch(/\bDate\.now\s*\(|\bnew Date\b|next\/cache|supabase/);
  });
});

// ---------------------------------------------------------------------------
// Precision (migration 125). The patterns below are the runtime string values
// the RPC receives; in TS source a backslash is doubled.
// ---------------------------------------------------------------------------

/**
 * Test-only twin of the Postgres regex guard: PG's word anchors \m and \M both
 * become JS \b. Matching runs on foldEntityText(sample), like the SQL.
 */
function pgPatternToJs(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\\[mM]/g, "\\b"));
}

function hubMatches(key: string, sample: string): boolean {
  const folded = foldEntityText(sample);
  return entityHubPatterns(entityByKey(key)!).some((p) => pgPatternToJs(p).test(folded));
}

function dedupe(items: readonly string[]): string[] {
  return [...new Set(items)];
}

/**
 * Test-side restatement of the exclude rule, deliberately not imported: an
 * alternative is `\m` + the words joined by `\s+`, closed with `\M` only for a
 * single word of 3 letters or fewer ('ecb', 'fed'), so `\mfed\M` never hits
 * "federasyon" while 'polonya' still catches "polonyada".
 */
function excludeAlt(exclude: string): string {
  const words = exclude.split(" ");
  const closed = words.length === 1 && (words[0] as string).length <= 3;
  return `\\m${words.join("\\s+")}${closed ? "\\M" : ""}`;
}

/**
 * Test-side restatement of the `notAfter` rule, deliberately not imported: one
 * fixed-length negative lookbehind per word, `(?<!abd\s)(?<!iran\s)`, sitting
 * right after `\m` and before the base word.
 */
function notAfterLookbehinds(words: readonly string[]): string {
  return words.map((w) => `(?<!${w}\\s)`).join("");
}

/** The foreign-country words in front of which "Dışişleri" is not the Turkish ministry (the spec, restated). */
const DISISLERI_NOT_AFTER = [
  "abd",
  "amerika",
  "almanya",
  "alman",
  "fransa",
  "fransiz",
  "iran",
  "israil",
  "cin",
  "yunanistan",
  "yunan",
  "ukrayna",
  "rusya",
  "rus",
  "kktc",
  "ingiltere",
  "ingiliz",
  "katar",
  "misir",
  "suriye",
  "lubnan",
  "pakistan",
  "hindistan",
  "azerbaycan",
  "ermenistan",
  "japonya",
  "kore",
  "venezuela",
  "polonya",
  "ispanya",
  "italya",
  "macaristan",
  "avrupa",
] as const;

/** The family members whose name vetoes the bare "Erdoğan" (folded; h56-entities-1, the spec restated). */
const ERDOGAN_EXCLUDES = ["emine erdogan", "bilal erdogan", "sumeyye erdogan", "esra erdogan"] as const;

/** The given names that make a following "Erdoğan" someone else (folded; h56-entities-1, the spec restated). */
const ERDOGAN_NOT_AFTER = ["fatih", "yilmaz", "asuman", "canan", "meryem", "nehir", "filiz"] as const;

/**
 * The guard in front of a non-trusted base: a negative lookahead over the
 * excludes, then a positive lookahead over the requires (each only when its
 * list is non-empty), then `[\s\S]*`. A requires phrase follows the same
 * open/closed rule as an exclude.
 */
function guardPrefix(excludes: readonly string[], requires?: readonly string[]): string {
  const neg =
    excludes.length > 0 ? `(?![\\s\\S]*(?:${excludes.map(excludeAlt).join("|")}))` : "";
  const pos =
    requires !== undefined && requires.length > 0
      ? `(?=[\\s\\S]*(?:${requires.map(excludeAlt).join("|")}))`
      : "";
  return `^${neg}${pos}[\\s\\S]*`;
}

/**
 * A pattern without its leading guard. The guard ends at the first "))[\s\S]*":
 * no alternative holds a "))", and between the negative and the positive
 * lookahead the text is "))(?=", never "))[\s\S]*".
 */
function stripGuard(pattern: string): string {
  if (!pattern.startsWith("^(?")) return pattern;
  const end = "))[\\s\\S]*";
  return pattern.slice(pattern.indexOf(end) + end.length);
}

const bare = { key: "x", label: "Xyz", tokens: [] as string[] };

describe("foldEntityText", () => {
  it("folds Turkish letters to ASCII, then lowercases (translate before lower, as in SQL)", () => {
    expect(foldEntityText("İYİ Parti'nin ZELENSKİY Çin")).toBe("iyi parti'nin zelenskiy cin");
  });

  it("folds every letter of the 112 fold table and leaves plain text alone", () => {
    expect(foldEntityText("İIıŞşĞğÜüÖöÇçÂâÎîÛû")).toBe("iiissgguuooccaaiiuu");
    expect(foldEntityText("BIST 100 / 2026")).toBe("bist 100 / 2026");
    expect(foldEntityText("")).toBe("");
  });
});

describe("entityHubForms", () => {
  it("uses the curated aliases when there are any", () => {
    expect(entityHubForms(entityByKey("akp")!)).toEqual(["AK Parti", "AKP"]);
  });

  it("falls back to the label when there are no aliases", () => {
    expect(entityHubForms(entityByKey("chp")!)).toEqual(["CHP"]);
    expect(entityHubForms(entityByKey("ysk")!)).toEqual(["YSK"]);
  });

  it("erdogan: the bare name first, then the two presidential forms (h56-entities-1)", () => {
    expect(entityHubForms(entityByKey("erdogan")!)).toEqual([
      "Erdoğan",
      "Cumhurbaşkanı Erdoğan",
      "Recep Tayyip Erdoğan",
    ]);
  });
});

describe("entityHubPatterns (exact runtime values)", () => {
  const expected: Record<string, string[]> = {
    deva: ["\\mdeva\\M"],
    "iyi-parti": ["\\miyi\\s+parti"],
    dolar: [
      "\\m(?<![0-9]\\s)(?<![0-9])(?<!bin\\s)(?<!milyon\\s)(?<!milyar\\s)(?<!trilyon\\s)(?<!milyonlarca\\s)(?<!milyarlarca\\s)dolar",
    ],
    akp: ["\\mak\\s+parti", "\\makp\\M"],
    zelenski: ["\\mzelenski\\M", "\\mzelenskiy\\M", "\\mzelensky\\M", "\\mzelenskyy\\M"],
    // 'Borsa İstanbul' and 'BIST' are trusted (bare); the bare 'Borsa' carries the exclude guard.
    borsa: [
      "\\mborsa\\s+istanbul",
      "^(?![\\s\\S]*(?:\\mnew\\s+york|\\mwall\\s+street|\\mnasdaq|\\mdow\\s+jones|\\mnikkei|\\masya\\s+borsa|\\mavrupa\\s+borsa|\\mlondra\\s+borsa|\\mfrankfurt|\\mbinance|\\mkripto|\\mticaret\\s+borsa))[\\s\\S]*\\mborsa",
      "\\mbist",
    ],
    // One fixed-length negative lookbehind per foreign-country word, right before the base word.
    disisleri: [`\\m${notAfterLookbehinds(DISISLERI_NOT_AFTER)}disisleri\\M`],
    // The bare 'Erdoğan' is vetoed by a family member named in the story and skips an occurrence that
    // stands right behind a given name; the two presidential forms are trusted (bare) and carry only
    // the notAfter lookbehinds (h56-entities-1).
    erdogan: [
      `${guardPrefix(ERDOGAN_EXCLUDES)}\\m${notAfterLookbehinds(ERDOGAN_NOT_AFTER)}erdogan\\M`,
      `\\m${notAfterLookbehinds(ERDOGAN_NOT_AFTER)}cumhurbaskani\\s+erdogan`,
      `\\m${notAfterLookbehinds(ERDOGAN_NOT_AFTER)}recep\\s+tayyip\\s+erdogan`,
    ],
    chp: ["\\mchp\\M"],
    cin: ["\\mcin\\M"],
    "asgari-ucret": ["\\masgari\\s+ucret"],
    dem: ["\\mdem\\s+parti"],
    pkk: ["\\mpkk\\M"],
    aym: [
      "^(?![\\s\\S]*(?:\\mpolonya|\\mfederal\\s+anayasa|\\mkktc\\s+anayasa))[\\s\\S]*\\manayasa\\s+mahkemesi",
      "\\maym\\M",
    ],
    tcmb: [
      "^(?![\\s\\S]*(?:\\mavrupa\\s+merkez|\\mecb\\M|\\mfed\\M|\\mabd\\s+merkez|\\mamerikan\\s+merkez|\\misrail\\s+merkez|\\mingiltere\\s+merkez|\\mjaponya\\s+merkez|\\mrusya\\s+merkez|\\mcin\\s+merkez))[\\s\\S]*\\mmerkez\\s+bankasi",
      "\\mtcmb\\M",
    ],
    meclis: [
      "^(?![\\s\\S]*(?:\\mtemsilciler\\s+meclisi|\\mknesset|\\misrail|\\miran|\\mlibya|\\mbelediye\\s+meclis|\\mil\\s+genel\\s+meclis|\\milce\\s+meclis|\\mmahalle\\s+meclis|\\mulusal\\s+meclis|\\mrum\\s+meclis|\\mgkry|\\mticaret\\s+odas|\\msanayi\\s+odas|\\mito\\M|\\mmto\\M|\\matso|\\mbelediyesi\\s+meclis|\\mbuyuksehir\\s+meclis|\\mmeclis\\s+uyes|\\marnavutluk))(?=[\\s\\S]*(?:\\mtbmm|\\mgenel\\s+kurul|\\mmilletvekil|\\mkanun\\s+teklif|\\myasa\\s+teklif|\\mgrup\\s+toplanti|\\mmeclis\\s+baskan|\\mkurtulmus|\\mkomisyon|\\mbutce\\s+gorusme|\\mchp\\M|\\makp\\M|\\mak\\s+parti|\\mmhp\\M|\\mdem\\s+parti|\\miyi\\s+parti|\\myeniden\\s+refah))[\\s\\S]*\\mmeclis",
      "\\mtbmm",
      "\\mbuyuk\\s+millet\\s+meclisi",
    ],
  };

  for (const [key, patterns] of Object.entries(expected)) {
    it(`${key} -> ${patterns.join("  ")}`, () => {
      expect(entityHubPatterns(entityByKey(key)!)).toEqual(patterns);
    });
  }

  it("takes a trailing word boundary only on single-word, non-prefix forms", () => {
    // A multi-word form leaves its last word open ('AK Partili', 'Merkez
    // Bankasının', 'asgari ücrete'); adjacency already keeps it precise.
    for (const p of entityHubPatterns(entityByKey("iyi-parti")!)) expect(p.endsWith("\\M")).toBe(false);
    for (const p of entityHubPatterns(entityByKey("tcmb")!).filter((x) => x.includes("\\s+"))) {
      expect(p.endsWith("\\M")).toBe(false);
    }
  });

  it("is deterministic and never mutates the shared entity", () => {
    const e = entityByKey("akp")!;
    const before = JSON.stringify(e);
    expect(entityHubPatterns(e)).toEqual(entityHubPatterns(e));
    expect(JSON.stringify(e)).toBe(before);
  });

  it("drops forms that fold to nothing and duplicate patterns", () => {
    const base = { key: "x", tokens: [] as string[] };
    expect(
      entityHubPatterns(
        { ...base, label: "!!!" },
        { aliases: ["---", "Deva", "DEVA", "deva"] },
      ),
    ).toEqual(["\\mdeva\\M"]);
    expect(entityHubPatterns({ ...base, label: "***" })).toEqual([]);
  });

  it("caps the list at ENTITY_HUB_MAX_TERMS", () => {
    const many = Array.from({ length: 20 }, (_, i) => `ad${String.fromCharCode(97 + i)}`);
    const e = { key: "x", label: "x", tokens: [] as string[] };
    expect(entityHubPatterns(e, { aliases: many })).toHaveLength(ENTITY_HUB_MAX_TERMS);
    expect(entityHubQueries(e, { aliases: many })).toHaveLength(ENTITY_HUB_MAX_TERMS);
  });

  it("exports the amount lookbehind block that guards a quantityGuard word", () => {
    expect(QUANTITY_GUARD).toBe(
      "(?<![0-9]\\s)(?<![0-9])(?<!bin\\s)(?<!milyon\\s)(?<!milyar\\s)(?<!trilyon\\s)(?<!milyonlarca\\s)(?<!milyarlarca\\s)",
    );
  });

  describe("excludes", () => {
    it("wraps a non-trusted form in a lookahead over the whole folded text", () => {
      const spec: RisingHubSpec = { aliases: ["Xyz"], excludes: ["polonya", "federal anayasa"] };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "^(?![\\s\\S]*(?:\\mpolonya|\\mfederal\\s+anayasa))[\\s\\S]*\\mxyz\\M",
      ]);
    });

    it("closes an alternative with \\M only for a single word of 3 letters or fewer", () => {
      const spec: RisingHubSpec = {
        aliases: ["Xyz"],
        excludes: ["ecb", "fed", "ab", "abcd", "israil", "belediye meclis", "a b"],
      };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "^(?![\\s\\S]*(?:\\mecb\\M|\\mfed\\M|\\mab\\M|\\mabcd|\\misrail|\\mbelediye\\s+meclis|\\ma\\s+b))[\\s\\S]*\\mxyz\\M",
      ]);
    });

    it("'fed' does not exclude 'federasyon', 'polonya' does exclude 'polonyada'", () => {
      const spec: RisingHubSpec = { aliases: ["Merkez Bankası"], excludes: ["fed", "polonya"] };
      const pat = new RegExp(entityHubPatterns(bare, spec)[0]!.replace(/\\[mM]/g, "\\b"));
      expect(pat.test("federasyon merkez bankasi")).toBe(true);
      expect(pat.test("fed merkez bankasi")).toBe(false);
      expect(pat.test("polonyada merkez bankasi")).toBe(false);
      expect(pat.test("merkez bankasi polonyada")).toBe(false);
    });

    it("every non-trusted form of a spec carries the guard, every trusted one stays bare", () => {
      const spec: RisingHubSpec = {
        aliases: ["Büyük Millet Meclisi", "Meclis", "TBMM"],
        trusted: ["TBMM", "Büyük Millet Meclisi"],
        excludes: ["israil"],
        hubMatch: "prefix",
      };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "\\mbuyuk\\s+millet\\s+meclisi",
        `${guardPrefix(["israil"])}\\mmeclis`,
        "\\mtbmm",
      ]);
    });

    it("carries both lookaheads on a non-trusted form and none on a trusted one", () => {
      const spec: RisingHubSpec = {
        aliases: ["Büyük Millet Meclisi", "Meclis", "TBMM"],
        trusted: ["TBMM", "Büyük Millet Meclisi"],
        excludes: ["israil"],
        requires: ["genel kurul"],
        hubMatch: "prefix",
      };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "\\mbuyuk\\s+millet\\s+meclisi",
        `${guardPrefix(["israil"], ["genel kurul"])}\\mmeclis`,
        "\\mtbmm",
      ]);
    });

    it("keeps a trusted alias bare even when it is not the first form", () => {
      const spec: RisingHubSpec = { aliases: ["TBMM", "Meclis"], trusted: ["TBMM"], excludes: ["israil"] };
      expect(entityHubPatterns(bare, spec)[0]).toBe("\\mtbmm\\M");
    });

    it("never emits a guard for an empty list, or for entries that fold to nothing", () => {
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], excludes: [] })).toEqual(["\\mxyz\\M"]);
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], excludes: ["", "***"] })).toEqual([
        "\\mxyz\\M",
      ]);
    });

    it("never lets a metacharacter in an exclude reach the pattern", () => {
      const out = entityHubPatterns(bare, { aliases: ["Xyz"], excludes: ["a|b", "c.*", "d(e)"] });
      expect(out).toEqual([
        "^(?![\\s\\S]*(?:\\ma\\s+b|\\mc\\M|\\md\\s+e))[\\s\\S]*\\mxyz\\M",
      ]);
    });
  });

  describe("requires", () => {
    it("wraps a non-trusted form in a positive lookahead over the whole folded text", () => {
      const spec: RisingHubSpec = { aliases: ["Xyz"], requires: ["tbmm", "genel kurul"] };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "^(?=[\\s\\S]*(?:\\mtbmm|\\mgenel\\s+kurul))[\\s\\S]*\\mxyz\\M",
      ]);
    });

    it("puts the negative lookahead (excludes) before the positive one (requires)", () => {
      const spec: RisingHubSpec = {
        aliases: ["Xyz"],
        excludes: ["israil", "ito"],
        requires: ["tbmm"],
      };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "^(?![\\s\\S]*(?:\\misrail|\\mito\\M))(?=[\\s\\S]*(?:\\mtbmm))[\\s\\S]*\\mxyz\\M",
      ]);
      expect(entityHubPatterns(bare, spec)[0]).toBe(`${guardPrefix(["israil", "ito"], ["tbmm"])}\\mxyz\\M`);
    });

    it("closes an alternative with \\M only for a single word of 3 letters or fewer", () => {
      const spec: RisingHubSpec = {
        aliases: ["Xyz"],
        requires: ["chp", "akp", "ak parti", "komisyon", "mhp"],
      };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "^(?=[\\s\\S]*(?:\\mchp\\M|\\makp\\M|\\mak\\s+parti|\\mkomisyon|\\mmhp\\M))[\\s\\S]*\\mxyz\\M",
      ]);
    });

    it("keeps a trusted alias bare: it needs no cue", () => {
      const spec: RisingHubSpec = {
        aliases: ["TBMM", "Meclis"],
        trusted: ["TBMM"],
        requires: ["genel kurul"],
      };
      expect(entityHubPatterns(bare, spec)).toEqual([
        "\\mtbmm\\M",
        "^(?=[\\s\\S]*(?:\\mgenel\\s+kurul))[\\s\\S]*\\mmeclis\\M",
      ]);
    });

    it("never emits a guard for an empty list, or for entries that fold to nothing", () => {
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], requires: [] })).toEqual(["\\mxyz\\M"]);
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], requires: ["", "***"] })).toEqual([
        "\\mxyz\\M",
      ]);
      // An unusable requires list falls back to the excludes guard alone.
      expect(
        entityHubPatterns(bare, { aliases: ["Xyz"], excludes: ["israil"], requires: ["***"] }),
      ).toEqual([`${guardPrefix(["israil"])}\\mxyz\\M`]);
    });

    it("never lets a metacharacter in a requires entry reach the pattern", () => {
      const out = entityHubPatterns(bare, { aliases: ["Xyz"], requires: ["a|b", "c.*", "d(e)"] });
      expect(out).toEqual(["^(?=[\\s\\S]*(?:\\ma\\s+b|\\mc\\M|\\md\\s+e))[\\s\\S]*\\mxyz\\M"]);
    });

    it("matches only when a cue sits anywhere in the text, before or after the word", () => {
      const spec: RisingHubSpec = { aliases: ["Xyz"], requires: ["tbmm", "chp"] };
      const pat = new RegExp(entityHubPatterns(bare, spec)[0]!.replace(/\\[mM]/g, "\\b"));
      expect(pat.test("xyz")).toBe(false);
      expect(pat.test("xyz toplandi")).toBe(false);
      expect(pat.test("tbmm xyz")).toBe(true);
      expect(pat.test("xyz chp")).toBe(true);
      expect(pat.test("chp'li xyz yarin")).toBe(true);
      // 'chp' is a word of 3 letters: closed, so a longer word is not the cue.
      expect(pat.test("xyz chpx")).toBe(false);
    });

    it("an exclude still vetoes a story that carries a cue", () => {
      const spec: RisingHubSpec = { aliases: ["Xyz"], excludes: ["israil"], requires: ["tbmm"] };
      const pat = new RegExp(entityHubPatterns(bare, spec)[0]!.replace(/\\[mM]/g, "\\b"));
      expect(pat.test("tbmm xyz")).toBe(true);
      expect(pat.test("tbmm xyz israil")).toBe(false);
    });
  });

  describe("quantityGuard", () => {
    it("guards a single word and closes it with \\M unless the entity is a prefix hub", () => {
      expect(entityHubPatterns(bare, { aliases: ["Dolar"], quantityGuard: true })).toEqual([
        `\\m${QUANTITY_GUARD}dolar\\M`,
      ]);
      expect(
        entityHubPatterns(bare, { aliases: ["Dolar"], hubMatch: "prefix", quantityGuard: true }),
      ).toEqual([`\\m${QUANTITY_GUARD}dolar`]);
    });

    it("leaves a multi-word form alone", () => {
      expect(entityHubPatterns(bare, { aliases: ["Abd Doları"], quantityGuard: true })).toEqual([
        "\\mabd\\s+dolari",
      ]);
    });

    it("composes with excludes: the guard wraps the amount-guarded base", () => {
      expect(
        entityHubPatterns(bare, { aliases: ["Dolar"], quantityGuard: true, excludes: ["kanada"] }),
      ).toEqual([`${guardPrefix(["kanada"])}\\m${QUANTITY_GUARD}dolar\\M`]);
    });
  });

  describe("notAfter", () => {
    it("emits one fixed-length negative lookbehind per word, right before the base word", () => {
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], notAfter: ["abd", "iran"] })).toEqual([
        "\\m(?<!abd\\s)(?<!iran\\s)xyz\\M",
      ]);
    });

    it("guards the first word of a multi-word form and leaves its tail open", () => {
      expect(entityHubPatterns(bare, { aliases: ["Xyz Abc"], notAfter: ["abd"] })).toEqual([
        "\\m(?<!abd\\s)xyz\\s+abc",
      ]);
    });

    it("keeps the prefix-match open end", () => {
      expect(
        entityHubPatterns(bare, { aliases: ["Xyz"], hubMatch: "prefix", notAfter: ["abd"] }),
      ).toEqual(["\\m(?<!abd\\s)xyz"]);
    });

    it("folds Turkish letters and case, and dedupes", () => {
      expect(
        entityHubPatterns(bare, { aliases: ["Xyz"], notAfter: ["ABD", "İran", "Çin", "abd"] }),
      ).toEqual(["\\m(?<!abd\\s)(?<!iran\\s)(?<!cin\\s)xyz\\M"]);
    });

    it("emits nothing for undefined, an empty list, or entries that fold to nothing", () => {
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], notAfter: [] })).toEqual(["\\mxyz\\M"]);
      expect(entityHubPatterns(bare, { aliases: ["Xyz"], notAfter: ["", "***", "  "] })).toEqual([
        "\\mxyz\\M",
      ]);
      expect(entityHubPatterns(bare, { aliases: ["Xyz"] })).toEqual(["\\mxyz\\M"]);
    });

    it("keeps only single words, so every lookbehind stays one fixed-length alternative", () => {
      // 'a|b' and 'd(e)' fold to two words and 'two words' is a phrase: all dropped.
      // 'c.*' folds to the single word 'c'; no metacharacter reaches the pattern.
      const out = entityHubPatterns(bare, {
        aliases: ["Xyz"],
        notAfter: ["a|b", "c.*", "d(e)", "two words"],
      });
      expect(out).toEqual(["\\m(?<!c\\s)xyz\\M"]);
    });

    it("sits after the amount guard on a quantityGuard entity", () => {
      expect(
        entityHubPatterns(bare, { aliases: ["Dolar"], quantityGuard: true, notAfter: ["abd"] }),
      ).toEqual([`\\m${QUANTITY_GUARD}(?<!abd\\s)dolar\\M`]);
    });

    it("composes with excludes: the guard wraps the lookbehind-guarded base", () => {
      expect(
        entityHubPatterns(bare, { aliases: ["Xyz"], excludes: ["kanada"], notAfter: ["abd"] }),
      ).toEqual([`${guardPrefix(["kanada"])}\\m(?<!abd\\s)xyz\\M`]);
    });

    it("is a property of the word, not of the story: a trusted form carries it too", () => {
      expect(
        entityHubPatterns(bare, {
          aliases: ["TBMM", "Xyz"],
          trusted: ["TBMM"],
          excludes: ["israil"],
          notAfter: ["abd"],
        }),
      ).toEqual(["\\m(?<!abd\\s)tbmm\\M", `${guardPrefix(["israil"])}\\m(?<!abd\\s)xyz\\M`]);
    });

    it("blocks the word only right after a listed word, with one whitespace character between", () => {
      const pat = pgPatternToJs(
        entityHubPatterns(bare, { aliases: ["Xyz"], notAfter: ["abd", "iran"] })[0] as string,
      );
      expect(pat.test("xyz")).toBe(true);
      expect(pat.test("abd xyz")).toBe(false);
      expect(pat.test("iran xyz bakani")).toBe(false);
      expect(pat.test("abd\nxyz")).toBe(false);
      expect(pat.test("abd ve xyz")).toBe(true);
      expect(pat.test("abd, xyz")).toBe(true);
      expect(pat.test("abd xyz ve turkiye xyz")).toBe(true);
    });
  });
});

describe("hub matching behaviour (the SQL guard, in JS)", () => {
  it("deva: a stemmer collision ('devam') is out, the party is in", () => {
    expect(hubMatches("deva", "Görüşmeler devam ediyor")).toBe(false);
    expect(hubMatches("deva", "DEVA'nın kurultayı")).toBe(true);
    expect(hubMatches("deva", "DEVA Partisi")).toBe(true);
  });

  it("dolar: 'domuz' is out; case, suffix and slash forms are in", () => {
    expect(hubMatches("dolar", "Domuz eti ithalatı")).toBe(false);
    expect(hubMatches("dolar", "Dolara talep arttı")).toBe(true);
    expect(hubMatches("dolar", "Dolar/TL rekor")).toBe(true);
    expect(hubMatches("dolar", "Dolar 49,57 liradan")).toBe(true);
  });

  it("dolar: an amount ('2,1 milyar dolarlık', '12 milyon doları', '100 dolar') is out", () => {
    expect(hubMatches("dolar", "2,1 milyar dolarlık Patriot")).toBe(false);
    expect(hubMatches("dolar", "12 milyon doları")).toBe(false);
    expect(hubMatches("dolar", "Milyarlarca doları buldu")).toBe(false);
    expect(hubMatches("dolar", "100 dolar")).toBe(false);
    expect(hubMatches("dolar", "3 bin dolar")).toBe(false);
    expect(hubMatches("dolar", "5 trilyon dolar")).toBe(false);
    expect(hubMatches("dolar", "250 bin doları")).toBe(false);
  });

  it("aym: Poland's court is out, the Turkish court and 'AYM' are in", () => {
    expect(hubMatches("aym", "Polonya'da polis Anayasa Mahkemesi'ni bastı")).toBe(false);
    expect(hubMatches("aym", "Anayasa Mahkemesi iptal kararı verdi")).toBe(true);
    expect(hubMatches("aym", "AYM başvuruyu reddetti")).toBe(true);
  });

  it("aym: federal and KKTC courts are out wherever the cue sits in the text", () => {
    expect(hubMatches("aym", "Federal Anayasa Mahkemesi kararı")).toBe(false);
    expect(hubMatches("aym", "Anayasa Mahkemesi kararı, KKTC Anayasa Mahkemesi")).toBe(false);
  });

  it("tcmb: foreign central banks are out, the Turkish one and its abbreviation are in", () => {
    expect(hubMatches("tcmb", "Avrupa Merkez Bankası Başkanı Lagarde istifa etti")).toBe(false);
    expect(hubMatches("tcmb", "FED faiz kararını açıkladı, ABD Merkez Bankası")).toBe(false);
    expect(hubMatches("tcmb", "ECB faizi sabit tuttu, Merkez Bankası")).toBe(false);
    expect(hubMatches("tcmb", "Merkez Bankası faizi sabit tuttu")).toBe(true);
    expect(hubMatches("tcmb", "TCMB rezervleri")).toBe(true);
    expect(hubMatches("tcmb", "Federasyon başkanı Merkez Bankası'nı ziyaret etti")).toBe(true);
  });

  it("tcmb: 'TCMB' is trusted, so a foreign cue in the same story does not drop it", () => {
    expect(hubMatches("tcmb", "TCMB ve FED faiz kararı")).toBe(true);
  });

  it("meclis: foreign and municipal assemblies are out, the Turkish parliament is in", () => {
    expect(hubMatches("meclis", "İsrail meclisi Knesset'te güven oylaması")).toBe(false);
    expect(hubMatches("meclis", "Belediye meclisi toplandı")).toBe(false);
    expect(hubMatches("meclis", "Temsilciler Meclisi'nde oylama")).toBe(false);
    expect(hubMatches("meclis", "Meclis'te bütçe görüşmeleri")).toBe(true);
    expect(hubMatches("meclis", "TBMM Genel Kurulu'nda İsrail'e kınama")).toBe(true);
    expect(
      hubMatches("meclis", "Büyük Millet Meclisi Başkanı İran Meclis Başkanı ile görüştü"),
    ).toBe(true);
  });

  it("meclis: a chamber of commerce, municipal or foreign assembly is out, even with the bare word", () => {
    for (const sample of [
      "İTO Ekim ayı meclis toplantısı yapıldı",
      "ATSO meclis toplantısında ekonomi değerlendirildi",
      "MTO Meclis Başkanı açıklama yaptı",
      "İstanbul Ticaret Odası Meclisi toplandı",
      "Bakırköy Belediye Meclisi'nde gerginlik",
      "CHP'li Milas Belediyesi meclis toplantısında tartışma",
      "İzmir Büyükşehir Belediye Meclisi bütçeyi onayladı",
      "Arnavutluk Meclisi yeni hükümeti onayladı",
      "Meclis üyesi istifa etti",
    ]) {
      expect(hubMatches("meclis", sample), sample).toBe(false);
    }
  });

  it("meclis: the bare word counts when the same text carries a TBMM or politics cue", () => {
    for (const sample of [
      "TBMM Genel Kurulu'nda kanun teklifi kabul edildi",
      "Meclis Genel Kurulu'nda vergi düzenlemesi kabul edildi",
      "Kanun teklifi Meclis'e sunuldu",
      "AK Parti milletvekili Meclis kürsüsünde konuştu",
      "Meclis Başkanı Kurtulmuş yeni yasama yılını açtı",
      "Meclis'te bütçe görüşmeleri",
      "CHP grup toplantısında Meclis'e çağrı",
    ]) {
      expect(hubMatches("meclis", sample), sample).toBe(true);
    }
  });

  it("meclis: no cue, no hit; the cue may sit before or after the word", () => {
    expect(hubMatches("meclis", "Meclis toplandı")).toBe(false);
    expect(hubMatches("meclis", "Meclis'e çağrı yaptı, DEM Parti")).toBe(true);
    expect(hubMatches("meclis", "Yeniden Refah Partisi Meclis'i terk etti")).toBe(true);
  });

  it("meclis: an excluded cue beats a politics cue; TBMM and Büyük Millet Meclisi need neither", () => {
    expect(hubMatches("meclis", "CHP'li belediye meclis üyesi")).toBe(false);
    expect(hubMatches("meclis", "MHP'li Meclis Başkanı İTO'yu ziyaret etti")).toBe(false);
    expect(hubMatches("meclis", "TBMM")).toBe(true);
    expect(hubMatches("meclis", "İTO toplantısı, TBMM Başkanı")).toBe(true);
    expect(hubMatches("meclis", "Türkiye Büyük Millet Meclisi")).toBe(true);
  });

  it("iyi-parti: 'iyi ... parti' apart is out, 'İYİ Parti' and 'İYİ Partili' are in", () => {
    expect(hubMatches("iyi-parti", "Bu iyi bir parti oldu")).toBe(false);
    expect(hubMatches("iyi-parti", "İYİ Parti'nin adayı")).toBe(true);
    expect(hubMatches("iyi-parti", "İYİ Partili vekil")).toBe(true);
  });

  it("akp: 'Akpınar' is out, AKP'li and 'AK Partili' are in", () => {
    expect(hubMatches("akp", "Akpınar'da yangın")).toBe(false);
    expect(hubMatches("akp", "AKP'li vekil")).toBe(true);
    expect(hubMatches("akp", "AK Partili başkan")).toBe(true);
  });

  it("zelenski: every spelling in the news is in", () => {
    expect(hubMatches("zelenski", "Zelenskiy İstanbul'da")).toBe(true);
    expect(hubMatches("zelenski", "Zelenskyy")).toBe(true);
    expect(hubMatches("zelenski", "Zelensky ile görüştü")).toBe(true);
    expect(hubMatches("zelenski", "Zelenski'den açıklama")).toBe(true);
  });

  it("borsa: 'Borsa İstanbul', BIST and the suffixed 'borsada' are in", () => {
    expect(hubMatches("borsa", "Borsa İstanbul'da düşüş")).toBe(true);
    expect(hubMatches("borsa", "BIST 100")).toBe(true);
    expect(hubMatches("borsa", "borsada")).toBe(true);
  });

  it("borsa: New York, Asia and Binance stories are not Borsa İstanbul", () => {
    for (const sample of [
      "New York borsası Demokratların zaferinin ardından yükselişle kapandı",
      "New York borsasında seçim günü: Nasdaq rekor kırdı",
      "ABD ara seçimleri sonrası Asya borsaları karışık, Nikkei geriledi",
      "FBI, kripto para borsası Binance'teki siber soygundan Kuzey Kore'yi sorumlu tuttu",
      "Wall Street güne düşüşle başladı, borsalarda satış var",
      "Dow Jones ve S&P 500 borsa endeksleri geriledi",
      "Avrupa borsaları ekside, Frankfurt DAX zayıf",
      "Londra borsası rekor seviyede",
      "Gaziantep Ticaret Borsası meclis başkanı seçildi",
      "Kripto borsası hacmi düştü",
    ]) {
      expect(hubMatches("borsa", sample), sample).toBe(false);
    }
  });

  it("borsa: Borsa İstanbul, BIST and the bare Turkish 'borsa' stay in", () => {
    for (const sample of [
      "Borsa İstanbul Genel Müdür Vekilliğine Atila Türeli getirildi",
      "YENİ Parti'nin fon ve borsa manipülasyonu önergesi reddedildi",
      "Borsadaki 173 milyar dolarlık erimeyi bütçeyle karşılaştırdı",
      "BIST 100 endeksi günü yükselişle tamamladı",
      "Borsa güne yükselişle başladı",
      "Borsası'nda işlem hacmi arttı, Borsa İstanbul'da rekor",
    ]) {
      expect(hubMatches("borsa", sample), sample).toBe(true);
    }
  });

  it("borsa: Borsa İstanbul and BIST are trusted, so a foreign cue in the same story does not drop them", () => {
    expect(hubMatches("borsa", "Borsa İstanbul güne Wall Street'in izinden başladı")).toBe(true);
    expect(hubMatches("borsa", "BIST 100, New York borsasına paralel düştü")).toBe(true);
    expect(hubMatches("borsa", "Nasdaq düştü, borsa güne düşüşle başladı")).toBe(false);
  });

  it("disisleri: a foreign ministry is not the Turkish one", () => {
    for (const sample of [
      "ABD Dışişleri Bakanı Rubio, başkanlık yarışı için istifa edecek iddiası",
      "Yunanistan Dışişleri Bakanlığı çalışanlarından 2 günlük grev",
      "İran Dışişleri Sözcüsü, nükleer saldırıya ellerimiz bağlı değil yanıtını verdi",
      "KKTC Dışişleri Bakanlığından Avrupa Komisyonu raporuna tepki",
      "Almanya Dışişleri Bakanı Wadephul duyurdu",
      "Çin Dışişleri Bakanlığı Sözcüsü açıklama yaptı",
      "Rus Dışişleri Bakanı Lavrov: görüşme sürüyor",
      "Rusya Dışişleri Bakanlığı'ndan tepki",
      "Fransa Dışişleri Bakanı Paris'te konuştu",
      "İsrail Dışişleri Bakanı Saar açıklama yaptı",
      "Azerbaycan Dışişleri Bakanlığı notasını iletti",
      "Kuzey Kore Dışişleri Bakanlığı füze denemesini savundu",
      "Avrupa Dışişleri Bakanları toplandı",
      "ABD Dışişleri Bakanı Rubio ve ABD Dışişleri Bakanlığı sözcüsü konuştu",
      // any whitespace between the country and the ministry counts, a newline included
      "ABD\nDışişleri Bakanlığı sözcüsü konuştu",
    ]) {
      expect(hubMatches("disisleri", sample), sample).toBe(false);
    }
  });

  it("disisleri: the Turkish ministry stays in, including a story that also names a foreign one", () => {
    for (const sample of [
      "Dışişleri Bakanı Fidan, KKTC'yi ziyaret edecek",
      "Dışişleri'nden AB'nin 2026 raporuna sert tepki",
      "Dışişleri’nden AB’nin 2026 raporuna sert tepki",
      "Dışişleri Bakanlığı Büyükelçi Metin Ergin'in hayatını kaybettiğini duyurdu",
      "Dışişleri Bakanı Hakan Fidan, İran Dışişleri Bakanı Arakçi ile görüştü",
      "İran Dışişleri Bakanı Arakçi, Dışişleri Bakanı Hakan Fidan ile görüştü",
      "Türkiye Dışişleri Bakanlığı açıklama yaptı",
      "Dışişleri",
      "TÜRKİYE: DIŞİŞLERİ BAKANLIĞI",
      "ABD ve Dışişleri Bakanlığı görüşmesi",
    ]) {
      expect(hubMatches("disisleri", sample), sample).toBe(true);
    }
  });

  it("disisleri: only a listed word directly before the ministry blocks it", () => {
    expect(hubMatches("disisleri", "Abdullah Dışişleri Bakanlığı'na atandı")).toBe(true);
    expect(hubMatches("disisleri", "ABD, Dışişleri Bakanlığı")).toBe(true);
    expect(hubMatches("disisleri", "Ankara Dışişleri Bakanlığı")).toBe(true);
  });

  it("cin: 'Cinayet' is out, \"Çin'in\" is in", () => {
    expect(hubMatches("cin", "Cinayet davası")).toBe(false);
    expect(hubMatches("cin", "Çin'in")).toBe(true);
  });

  it("erdogan: the apostrophe suffix still matches the closing boundary", () => {
    expect(hubMatches("erdogan", "Erdoğan'ın")).toBe(true);
    expect(hubMatches("erdogan", "Cumhurbaşkanı ERDOĞAN açıkladı")).toBe(true);
    expect(hubMatches("erdogan", "Erdoğanlar köyü")).toBe(false);
  });

  // h56-entities-1 (hunt 56): /gundem/erdogan listed 42 of 410 clusters about other Erdoğans.
  it("erdogan: a family member or a namesake is not the President (the headlines of the 14-day replay)", () => {
    for (const sample of [
      "Emine Erdoğan'dan anlamlı mesaj: Kadınlar sanatın ve zanaatın atan kalbidir",
      "Bilal Erdoğan 16 yaş öncesi sosyal medya kullanımında dünyada ortak prensibi savundu",
      "İlim Yayma Vakfı Mütevelli Heyeti Başkanı Necmeddin Bilal Erdoğan: Güçlü bir gelecek için",
      "Yılmaz Erdoğan kam davulu sahnesi için özür diledi",
      "Müzisyen Filiz Erdoğan, mesanesinin delindiği iddiasıyla suç duyurusunda bulundu",
      "Yüsra Geyik takside bekledi, Nehir Erdoğan arka kapıdan çıktı",
      "Pasifik Holding yöneticileri Fatih Erdoğan ve Asuman Erdoğan'ın mal varlığına tedbir",
      "Çocuklarını kurtaran Canan Erdoğan minibüsün altında kaldı",
      "Meryem Erdoğan hayatını kaybetti",
      "Sümeyye Erdoğan Bayraktar bir sergiyi gezdi",
      "Esra Erdoğan'dan yeni açıklama",
      "Erdoğanlar köyü",
    ]) {
      expect(hubMatches("erdogan", sample), sample).toBe(false);
    }
  });

  it("erdogan: the President stays, by name alone, by title, or after a given name that a comma or a colon separates", () => {
    for (const sample of [
      "Cumhurbaşkanı Erdoğan, Malezya Başbakan Yardımcısı Hamidi'yi kabul etti",
      "Erdoğan'dan Gazze tepkisi: İnsanlık trajedisini tribünden seyrediyorlar",
      "Cumhurbaşkanı ERDOĞAN açıkladı",
      "Özel'den Erdoğan'a fon krizi çıkışı",
      "Cevdet Yılmaz, Cumhurbaşkanı Erdoğan'ın güçlü desteğiyle konuştu",
      // notAfter skips one occurrence only: a comma between the given name and the surname breaks the pair.
      "Cevdet Yılmaz, Erdoğan'ın talimatını açıkladı",
      "Fatih Altaylı: Erdoğan'ın açıklaması",
      "Erdoğan ile Putin telefonda görüştü",
    ]) {
      expect(hubMatches("erdogan", sample), sample).toBe(true);
    }
  });

  it("erdogan: a trusted presidential form rescues a story that also names a family member", () => {
    expect(hubMatches("erdogan", "Emine Erdoğan ile Cumhurbaşkanı Erdoğan Seul'de karşılandı")).toBe(true);
    expect(hubMatches("erdogan", "Recep Tayyip Erdoğan, Bilal Erdoğan ile Japonya'da")).toBe(true);
    expect(hubMatches("erdogan", "Bilal Erdoğan, Cumhurbaşkanı Erdoğan'ın yanında")).toBe(true);
    // Without a trusted form the same pairs are out (the veto is the whole story's, wherever the name stands).
    expect(hubMatches("erdogan", "Emine Erdoğan ve Erdoğan Seul'de karşılandı")).toBe(false);
    expect(hubMatches("erdogan", "Erdoğan, eşi Emine Erdoğan ile karşılandı")).toBe(false);
  });

  it("erdogan: the lookbehind is the word's own neighbour, so a given name elsewhere in the story does not veto", () => {
    // 'Fatih' in front of a different word, 'Yılmaz' as a surname before the President's full title.
    expect(hubMatches("erdogan", "Fatih Belediyesi açıkladı, Erdoğan görüştü")).toBe(true);
    expect(hubMatches("erdogan", "Nehir kenarında Erdoğan konuştu")).toBe(true);
    // Both occurrences behind a given name: out.
    expect(hubMatches("erdogan", "Nehir Erdoğan ve Canan Erdoğan")).toBe(false);
    // Only the first occurrence is behind a given name: the second one is the President's.
    expect(hubMatches("erdogan", "Filiz Erdoğan'ın avukatı ile Erdoğan'ın avukatı")).toBe(true);
  });

  it("erdogan: the glued 'Cumhurbaşkanı Erdoğanın' still matches the trusted form (open at the end, like every multi-word form)", () => {
    expect(hubMatches("erdogan", "Cumhurbaşkanı Erdoğanın Malezya ziyareti")).toBe(true);
    expect(hubMatches("erdogan", "Emine Erdoğan Cumhurbaşkanı Erdoğanın eşi olarak katıldı")).toBe(true);
  });
});

describe("entityHubQueries", () => {
  it("akp searches both curated spellings", () => {
    const q = entityHubQueries(entityByKey("akp")!);
    expect(q).toContain("ak parti");
    expect(q).toContain("akp");
  });

  it("zelenski searches all four spellings", () => {
    const q = entityHubQueries(entityByKey("zelenski")!);
    for (const s of ["zelenski", "zelenskiy", "zelensky", "zelenskyy"]) expect(q).toContain(s);
  });

  it("borsa searches 'borsa istanbul', 'borsa' and 'bist' but never the generic word 'istanbul' alone", () => {
    const q = entityHubQueries(entityByKey("borsa")!);
    expect(q).toContain("borsa istanbul");
    expect(q).toContain("borsa");
    expect(q).toContain("bist");
    // 'istanbul' only ever travels with 'borsa': a bare query would list every Istanbul story.
    for (const s of q) {
      if (/stanbul/i.test(s)) expect(s, s).toMatch(/^borsa\s/i);
    }
    expect(q.length).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
  });

  it("borsa also searches the inflected spellings whose stems differ from the bare word", () => {
    // The Turkish stemmer gives 'borsa' -> bor, 'borsada' -> borsa and
    // 'borsası' -> borsas, so the bare word alone found 15 of 34 real stories.
    const q = entityHubQueries(entityByKey("borsa")!);
    expect(q).toEqual(expect.arrayContaining(["borsada", "borsası"]));
    // The forms come first: a cap can only ever drop an inflection.
    expect(q.indexOf("bist")).toBeLessThan(q.indexOf("borsada"));
  });

  it("a suffixed party or labour form widens the prefilter and leaves the patterns alone", () => {
    const cases: Array<[string, string[]]> = [
      ["akp", ["AK Partili", "AK Partimize"]],
      ["dem", ["DEM Partili"]],
      ["iyi-parti", ["İYİ Partili"]],
      ["asgari-ucret", ["asgari ücretli", "asgari ücretlilerin"]],
      ["pkk", ["PKK/KCK"]],
    ];
    for (const [key, inflections] of cases) {
      const e = entityByKey(key)!;
      const spec = entityHubSpec(e);
      expect(spec.inflections, key).toEqual(inflections);
      const queries = entityHubQueries(e);
      expect(queries.length, key).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      for (const infl of inflections) {
        for (const v of turkishQueryVariants(infl)) expect(queries, `${key}: ${v}`).toContain(v);
      }
      const withoutInflections: RisingHubSpec = { ...spec };
      delete withoutInflections.inflections;
      expect(entityHubPatterns(e), key).toEqual(entityHubPatterns(e, withoutInflections));
    }
  });

  it("equals the deduped Turkish variants of every form plus its inflections, for every entity", () => {
    for (const e of RISING_ENTITIES) {
      expect(entityHubQueries(e), e.key).toEqual(
        dedupe(
          [...entityHubForms(e), ...(entityHubSpec(e).inflections ?? [])].flatMap((f) =>
            turkishQueryVariants(f),
          ),
        ),
      );
    }
  });

  it("inflections feed the stemmed prefilter only, never the regex patterns", () => {
    const e = { key: "x", label: "Xyz", tokens: [] as string[] };
    const spec = { inflections: ["Xyzda"] };
    expect(entityHubQueries(e, spec)).toEqual(["xyz", "xyzda"]);
    expect(entityHubPatterns(e, spec)).toEqual(["\\mxyz\\M"]);
  });
});

describe("invariants over every curated entity", () => {
  // The grammar is built from escaped literal pieces, so a backslash in a
  // pattern is compared as a backslash and a metacharacter never passes as one.
  const esc = (literal: string) => literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const WORD = "[a-z0-9]+";
  // One alternative of an exclude / require guard: no lookbehind allowed.
  const ALT = `${esc("\\m")}${WORD}(?:${esc("\\s")}\\+${WORD})*(?:${esc("\\M")})?`;
  // The notAfter block: one fixed-length `(?<!word\s)` per word, right after `\m`.
  const NOTAFTER = `(?:${esc("(?<!")}${WORD}${esc("\\s)")})+`;
  const PLAIN = `${esc("\\m")}(?:${NOTAFTER})?${WORD}(?:${esc("\\s")}\\+${WORD})*(?:${esc("\\M")})?`;
  const QUANT = `${esc("\\m")}${esc(QUANTITY_GUARD)}(?:${NOTAFTER})?${WORD}(?:${esc("\\M")})?`;
  const ALTS = `${ALT}(?:${esc("|")}${ALT})*`;
  const EXCL = `${esc("(?![\\s\\S]*(?:")}${ALTS}${esc("))")}`;
  const REQ = `${esc("(?=[\\s\\S]*(?:")}${ALTS}${esc("))")}`;
  // `^`, then the negative lookahead and/or the positive one (in that order), then `[\s\S]*`.
  const GUARD = `${esc("^")}(?:${EXCL}(?:${REQ})?|${REQ})${esc("[\\s\\S]*")}`;
  const GRAMMAR = new RegExp(`^(?:${PLAIN}|${QUANT}|${GUARD}(?:${PLAIN}|${QUANT}))$`);

  it("covers all 62 entities", () => {
    expect(RISING_ENTITIES).toHaveLength(62);
  });

  it("has 1..12 queries and 1..12 patterns, each plain, amount-guarded or lookahead-guarded", () => {
    for (const e of RISING_ENTITIES) {
      const q = entityHubQueries(e);
      const p = entityHubPatterns(e);
      expect(q.length, `${e.key} queries`).toBeGreaterThanOrEqual(1);
      expect(q.length, `${e.key} queries`).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      expect(p.length, `${e.key} patterns`).toBeGreaterThanOrEqual(1);
      expect(p.length, `${e.key} patterns`).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      for (const pat of p) expect(pat, `${e.key} pattern ${pat}`).toMatch(GRAMMAR);
    }
  });

  it("the grammar rejects what must never reach the RPC", () => {
    for (const bad of [
      "",
      "\\mdeva\\M|\\mdevam",
      "\\mdeva.*",
      "\\m(?i)deva",
      "(?i)\\mdeva\\M",
      "\\mdeva\\M\\M",
      "^(?![\\s\\S]*(?:))[\\s\\S]*\\mdeva\\M",
      "^(?![\\s\\S]*(?:\\mfoo.*))[\\s\\S]*\\mdeva\\M",
      "^(?![\\s\\S]*(?:\\mfoo))\\mdeva\\M",
      "^(?=[\\s\\S]*(?:))[\\s\\S]*\\mdeva\\M",
      "^(?=[\\s\\S]*(?:\\mfoo.*))[\\s\\S]*\\mdeva\\M",
      "^(?=[\\s\\S]*(?:\\mfoo))\\mdeva\\M",
      "^(?=[\\s\\S]*(?:\\mfoo))(?![\\s\\S]*(?:\\mbar))[\\s\\S]*\\mdeva\\M",
      "(?=[\\s\\S]*(?:\\mfoo))[\\s\\S]*\\mdeva\\M",
      `\\m${QUANTITY_GUARD}deva\\s+x\\s`,
      // lookbehinds that are not one fixed-length `(?<!word\s)` right after `\m`
      "\\m(?<!abd)deva\\M",
      "\\m(?<!abd\\s|iran\\s)deva\\M",
      "\\m(?<!abd\\s+)deva\\M",
      "\\m(?<!ab.\\s)deva\\M",
      "\\m(?<=abd\\s)deva\\M",
      "\\m(?<abd>x)deva\\M",
      "(?<!abd\\s)\\mdeva\\M",
      "\\mdeva(?<!abd\\s)\\M",
      "^(?![\\s\\S]*(?:\\m(?<!abd\\s)foo))[\\s\\S]*\\mdeva\\M",
    ]) {
      expect(bad, bad).not.toMatch(GRAMMAR);
    }
  });

  it("every emitted lookbehind is a negative, fixed-length, single alternative: valid in JS and in PostgreSQL ARE", () => {
    // Negative only, one alternative (no `|`), no quantifier (no `*`, `+`, `?`, `{`): a
    // literal digit class or word, then at most one `\s`. Nothing JS-only (named groups,
    // `\p{..}`, `\k<..>`, variable-length lookbehind) reaches the RPC.
    const FIXED = /^!(?:\[0-9\]|[a-z0-9]+)(?:\\s)?$/;
    let lookbehinds = 0;
    for (const e of RISING_ENTITIES) {
      for (const p of entityHubPatterns(e)) {
        expect(() => pgPatternToJs(p), `${e.key} ${p}`).not.toThrow();
        const found = [...p.matchAll(/\(\?<([^)]*)\)/g)];
        expect(found.length, `${e.key} ${p}`).toBe(p.split("(?<").length - 1);
        for (const m of found) {
          lookbehinds++;
          expect(m[1], `${e.key}: (?<${m[1]})`).toMatch(FIXED);
        }
        expect(p, `${e.key} ${p}`).not.toMatch(/\\[pPkbBdDwW]|\(\?<=|\(\?<[a-z]/);
      }
    }
    // dolar's eight amount guards plus disisleri's country guards, at least.
    expect(lookbehinds).toBeGreaterThanOrEqual(8 + DISISLERI_NOT_AFTER.length);
  });

  it("disisleri: every country lookbehind sits directly after \\m and before the word", () => {
    const [p] = entityHubPatterns(entityByKey("disisleri")!);
    expect(p).toBe(`\\m${notAfterLookbehinds(DISISLERI_NOT_AFTER)}disisleri\\M`);
    expect(p!.match(/\(\?<!/g)).toHaveLength(DISISLERI_NOT_AFTER.length);
  });

  describe("hostile input stays linear (100k characters)", () => {
    const N = 100_000;
    const fit = (unit: string) => unit.repeat(Math.ceil(N / unit.length)).slice(0, N);
    // Folded text, as the SQL sees it. Each input is built so a backtracking engine has the
    // most room to go quadratic: a guard that scans to the very end, a blocked word on
    // every line, a cue that never appears, a match only at the far end.
    const inputs: Array<[string, string]> = [
      ["a's", "a".repeat(N)],
      ["spaces", " ".repeat(N)],
      ["newlines", "\n".repeat(N)],
      ["abd prefixes", fit("abd ")],
      ["every disisleri blocked", fit("abd disisleri ")],
      ["every disisleri open", fit("disisleri ")],
      ["near misses", fit("disisler borsas meclisi ")],
      ["borsa repeated, exclude at the end", `${fit("borsa ")}`.slice(0, N - 9) + " new york"],
      ["exclude repeated, borsa at the end", fit("new york ").slice(0, N - 6) + " borsa"],
      ["meclis without any cue", fit("meclis ")],
      ["meclis repeated, cue at the end", fit("meclis ").slice(0, N - 5) + " tbmm"],
      ["dolar behind amounts", fit("100 dolar milyar dolar ")],
      ["digits", "1".repeat(N)],
      ["erdogan blocked on every line", fit("fatih erdogan ")],
      ["erdogan repeated, family name at the end", fit("erdogan ").slice(0, N - 14) + " emine erdogan"],
      ["family name repeated, trusted form at the end", fit("emine erdogan ").slice(0, N - 22) + " cumhurbaskani erdogan"],
    ];
    const keys = ["disisleri", "borsa", "meclis", "aym", "tcmb", "dolar", "erdogan"];

    it("builds every input at exactly 100k characters", () => {
      for (const [name, text] of inputs) expect(text.length, name).toBe(N);
    });

    it("every pattern of the guarded hubs finishes each input well inside a second", () => {
      let worst = 0;
      let worstWhat = "";
      for (const key of keys) {
        for (const p of entityHubPatterns(entityByKey(key)!)) {
          const re = pgPatternToJs(p);
          for (const [name, text] of inputs) {
            const t0 = performance.now();
            re.test(text);
            const dt = performance.now() - t0;
            if (dt > worst) {
              worst = dt;
              worstWhat = `${key} ${name}`;
            }
          }
        }
      }
      // Linear work is a few milliseconds per run; a quadratic pattern needs seconds on 100k.
      expect(worst, worstWhat).toBeLessThan(500);
    });

    it("folding 100k characters of Turkish text is linear too", () => {
      const t0 = performance.now();
      const out = foldEntityText("İĞÜŞÖÇı ".repeat(Math.ceil(N / 8)).slice(0, N));
      expect(out.length).toBeGreaterThan(0);
      expect(performance.now() - t0).toBeLessThan(500);
    });
  });

  it("no pattern starts with '(?': Postgres reads that as embedded options", () => {
    for (const e of RISING_ENTITIES) {
      for (const p of entityHubPatterns(e)) expect(p.startsWith("(?"), `${e.key} ${p}`).toBe(false);
    }
  });

  it("every form, and the label, matches one of the entity's own patterns (a requires cue added where the spec asks for one)", () => {
    for (const e of RISING_ENTITIES) {
      const spec = entityHubSpec(e);
      const requires = spec.requires ?? [];
      for (const form of [...entityHubForms(e), e.label]) {
        // A trusted form stands alone; any other form needs one of the spec's cues. The
        // last cue is not a trusted spelling, so the form's own pattern must accept it.
        const needsCue = requires.length > 0 && !(spec.trusted ?? []).includes(form);
        const text = needsCue ? `${form} ${requires[requires.length - 1]}` : form;
        expect(hubMatches(e.key, text), `${e.key}: ${text}`).toBe(true);
        if (needsCue) expect(hubMatches(e.key, form), `${e.key}: ${form} alone`).toBe(false);
      }
    }
  });

  it("the prefix-matching hubs are exactly borsa, dolar, enflasyon, faiz and meclis", () => {
    expect(
      RISING_ENTITIES.filter((e) => entityHubSpec(e).hubMatch === "prefix")
        .map((e) => e.key)
        .sort(),
    ).toEqual(["borsa", "dolar", "enflasyon", "faiz", "meclis"]);
    // A prefix hub has no closing \M on single words; every other single word has one.
    // The base is what is left once the exclude guard is stripped.
    for (const e of RISING_ENTITIES) {
      for (const p of entityHubPatterns(e)) {
        const base = stripGuard(p);
        if (base.includes("\\s+")) continue;
        expect(base.endsWith("\\M"), `${e.key} ${p}`).toBe(entityHubSpec(e).hubMatch !== "prefix");
      }
    }
  });

  it("keeps the /trends entities exactly { key, label, tokens } (hub data is a side table)", () => {
    expect(entityByKey("akp")).toEqual({ key: "akp", label: "AK Parti", tokens: ["akp", "ak parti"] });
    expect(entityByKey("zelenski")!.tokens).toEqual(["zelenski", "zelenskiy"]);
    expect(entityByKey("borsa")!.tokens).toEqual(["borsa", "bist"]);
    for (const e of RISING_ENTITIES) {
      expect(Object.keys(e).sort(), e.key).toEqual(["key", "label", "tokens"]);
    }
  });

  it("only curates hub data for entities that exist, and returns {} for the rest", () => {
    const keys = new Set(RISING_ENTITIES.map((e) => e.key));
    for (const k of Object.keys(RISING_HUB_SPECS)) expect(keys.has(k), k).toBe(true);
    expect(entityHubSpec(entityByKey("chp")!)).toEqual({});
    expect(entityHubSpec({ key: "__proto__", label: "x", tokens: [] })).toEqual({});
    expect(entityHubSpec({ key: "constructor", label: "x", tokens: [] })).toEqual({});
  });

  it("every inflection is a spelling the entity's own patterns accept (the prefilter never promises what the guard rejects)", () => {
    const withInflections = RISING_ENTITIES.filter((e) => entityHubSpec(e).inflections !== undefined);
    expect(withInflections.map((e) => e.key).sort()).toEqual([
      "akp",
      "asgari-ucret",
      "borsa",
      "dem",
      "iyi-parti",
      "pkk",
    ]);
    for (const e of withInflections) {
      for (const f of entityHubSpec(e).inflections!) {
        expect(hubMatches(e.key, f), `${e.key}: ${f}`).toBe(true);
      }
    }
  });

  it("curates aliases only where the label is not what the news prints", () => {
    expect(
      RISING_ENTITIES.filter((e) => entityHubSpec(e).aliases !== undefined)
        .map((e) => e.key)
        .sort(),
    ).toEqual(["akp", "aym", "borsa", "erdogan", "meclis", "tcmb", "yrp", "zelenski"]);
  });
});

describe("hub spec guards (precision, 2026-11-01)", () => {
  const specs = Object.entries(RISING_HUB_SPECS);

  it("every exclude is a folded ASCII phrase, so no metacharacter reaches the RPC", () => {
    for (const [key, spec] of specs) {
      for (const ex of spec.excludes ?? []) {
        expect(ex, `${key}: ${ex}`).toBe(foldEntityText(ex));
        expect(ex, `${key}: ${ex}`).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
      }
    }
  });

  it("every requires entry is a folded ASCII phrase, so no metacharacter reaches the RPC", () => {
    for (const [key, spec] of specs) {
      for (const req of spec.requires ?? []) {
        expect(req, `${key}: ${req}`).toBe(foldEntityText(req));
        expect(req, `${key}: ${req}`).toMatch(/^[a-z0-9]+( [a-z0-9]+)*$/);
      }
    }
  });

  it("every guarded pattern starts with guardPrefix(excludes, requires): the closing rule holds for both lists", () => {
    for (const [key, spec] of specs) {
      if (spec.excludes === undefined && spec.requires === undefined) continue;
      const e = entityByKey(key)!;
      const guarded = entityHubPatterns(e).filter((p) => p.startsWith("^(?"));
      expect(guarded.length, key).toBeGreaterThan(0);
      for (const p of guarded) {
        expect(p.startsWith(guardPrefix(spec.excludes ?? [], spec.requires)), key).toBe(true);
      }
    }
  });

  it("every trusted entry is one of the spec's own aliases, and trusted needs a guard to be trusted from", () => {
    for (const [key, spec] of specs) {
      for (const t of spec.trusted ?? []) {
        expect(spec.aliases ?? [], `${key}: ${t}`).toContain(t);
      }
      if (spec.trusted !== undefined) {
        expect(
          (spec.excludes ?? []).length + (spec.requires ?? []).length,
          `${key} has trusted but no excludes or requires`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("a trusted alias is emitted bare, every other alias carries the guard", () => {
    for (const [key, spec] of specs) {
      if (spec.excludes === undefined && spec.requires === undefined) continue;
      const e = entityByKey(key)!;
      const forms = entityHubForms(e);
      const patterns = entityHubPatterns(e);
      expect(patterns.length, key).toBe(forms.length);
      forms.forEach((form, i) => {
        const guarded = (patterns[i] as string).startsWith("^(?");
        expect(guarded, `${key}: ${form}`).toBe(!(spec.trusted ?? []).includes(form));
      });
    }
  });

  it("keeps the 12-pattern cap with the guards in place", () => {
    for (const [key] of specs) {
      expect(entityHubPatterns(entityByKey(key)!).length, key).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
    }
  });

  it("excludes is curated on exactly aym, borsa, erdogan, meclis and tcmb; quantityGuard on dolar only", () => {
    expect(
      specs
        .filter(([, s]) => s.excludes !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["aym", "borsa", "erdogan", "meclis", "tcmb"]);
    expect(
      specs
        .filter(([, s]) => s.quantityGuard !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["dolar"]);
    expect(RISING_HUB_SPECS.dolar?.quantityGuard).toBe(true);
  });

  it("aym, tcmb, meclis, disisleri and borsa each carry a precision guard: excludes, requires or notAfter", () => {
    for (const key of ["aym", "tcmb", "meclis", "disisleri", "borsa"]) {
      const spec = RISING_HUB_SPECS[key];
      expect(spec, key).toBeDefined();
      const n =
        (spec?.excludes ?? []).length + (spec?.requires ?? []).length + (spec?.notAfter ?? []).length;
      expect(n, `${key} has no excludes, requires or notAfter`).toBeGreaterThan(0);
    }
  });

  it("notAfter is curated on exactly disisleri and erdogan, as folded single ASCII words", () => {
    expect(
      specs
        .filter(([, s]) => s.notAfter !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["disisleri", "erdogan"]);
    for (const [key, spec] of specs) {
      for (const w of spec.notAfter ?? []) {
        expect(w, `${key}: ${w}`).toBe(foldEntityText(w));
        expect(w, `${key}: ${w}`).toMatch(/^[a-z0-9]+$/);
      }
      expect(new Set(spec.notAfter ?? []).size, key).toBe((spec.notAfter ?? []).length);
    }
  });

  it("the disisleri notAfter list: foreign countries only, never Turkey itself", () => {
    expect(RISING_HUB_SPECS.disisleri?.notAfter).toEqual([...DISISLERI_NOT_AFTER]);
    for (const own of ["turkiye", "turk", "tc", "ankara", "fidan"]) {
      expect(RISING_HUB_SPECS.disisleri?.notAfter, own).not.toContain(own);
    }
    // The hub still searches by the label, with no alias, exclude or require.
    expect(RISING_HUB_SPECS.disisleri?.aliases).toBeUndefined();
    expect(RISING_HUB_SPECS.disisleri?.excludes).toBeUndefined();
    expect(RISING_HUB_SPECS.disisleri?.requires).toBeUndefined();
  });

  it("the borsa spec: Borsa İstanbul and BIST are trusted, New York, Asia and Binance are vetoed", () => {
    expect(RISING_HUB_SPECS.borsa).toEqual({
      aliases: ["Borsa İstanbul", "Borsa", "BIST"],
      trusted: ["Borsa İstanbul", "BIST"],
      hubMatch: "prefix",
      inflections: ["Borsada", "Borsası"],
      excludes: [
        "new york",
        "wall street",
        "nasdaq",
        "dow jones",
        "nikkei",
        "asya borsa",
        "avrupa borsa",
        "londra borsa",
        "frankfurt",
        "binance",
        "kripto",
        "ticaret borsa",
      ],
    });
  });

  it("the erdogan spec (h56-entities-1): the President by title is trusted, a family member vetoes the story, a given name skips one occurrence", () => {
    expect(RISING_HUB_SPECS.erdogan).toEqual({
      aliases: ["Erdoğan", "Cumhurbaşkanı Erdoğan", "Recep Tayyip Erdoğan"],
      trusted: ["Cumhurbaşkanı Erdoğan", "Recep Tayyip Erdoğan"],
      excludes: [...ERDOGAN_EXCLUDES],
      notAfter: [...ERDOGAN_NOT_AFTER],
    });
    expect(entityHubSpec(entityByKey("erdogan")!)).toBe(RISING_HUB_SPECS.erdogan);
    // The bare name is the only guarded form: the two trusted ones are emitted bare.
    const patterns = entityHubPatterns(entityByKey("erdogan")!);
    expect(patterns.map((p) => p.startsWith("^(?"))).toEqual([true, false, false]);
    // No other field: no requires, no prefix matching, no quantity guard, no inflections.
    expect(Object.keys(RISING_HUB_SPECS.erdogan!).sort()).toEqual(["aliases", "excludes", "notAfter", "trusted"]);
  });

  it("erdogan: the bare name's query variants sit inside the first ENTITY_HUB_MAX_TERMS queries, so the 12-term cap never drops them", () => {
    const e = entityByKey("erdogan")!;
    const queries = entityHubQueries(e);
    expect(queries.length).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
    const bare = turkishQueryVariants("Erdoğan");
    expect(bare.length).toBeGreaterThan(0);
    expect(queries.slice(0, ENTITY_HUB_MAX_TERMS)).toEqual(expect.arrayContaining(bare));
    // The bare name leads: the presidential forms only ever add to the recall prefilter.
    expect(queries.slice(0, bare.length)).toEqual(bare);
    for (const v of [...turkishQueryVariants("Cumhurbaşkanı Erdoğan"), ...turkishQueryVariants("Recep Tayyip Erdoğan")]) {
      expect(queries, v).toContain(v);
    }
  });

  it("erdogan is not in the /trends rollup guards: its tokens stay [erdogan] (migration 163 guards only tcmb, aym, meclis)", () => {
    expect(entityByKey("erdogan")).toEqual({ key: "erdogan", label: "Erdoğan", tokens: ["erdogan"] });
  });

  // h56-entities-2 (hunt 56): /gundem/akp listed 130 of 304 clusters that name the party only as an epithet in the
  // summary lead ("eski AK Parti milletvekili", "AK Parti Samsun Milletvekili ... başkanlığında"). headlineOnly makes
  // the hub regex run on title_tr + title_tr_neutral and ignore the lead, for akp only.
  describe("headlineOnly (h56-entities-2)", () => {
    it("is curated on exactly akp, and it is the literal true", () => {
      expect(
        Object.entries(RISING_HUB_SPECS)
          .filter(([, s]) => s.headlineOnly !== undefined)
          .map(([k]) => k),
      ).toEqual(["akp"]);
      expect(RISING_HUB_SPECS.akp?.headlineOnly).toBe(true);
    });

    it("keeps the rest of the akp spec as it was: both spellings, the two inflections, the same two patterns", () => {
      expect(RISING_HUB_SPECS.akp).toEqual({
        aliases: ["AK Parti", "AKP"],
        inflections: ["AK Partili", "AK Partimize"],
        headlineOnly: true,
      });
      expect(entityHubPatterns(entityByKey("akp")!)).toEqual(["\\mak\\s+parti", "\\makp\\M"]);
    });

    it("entityHubHeadlineOnly is true for akp and false for every other hub (the summary lead stays for them)", () => {
      expect(entityHubHeadlineOnly(entityByKey("akp")!)).toBe(true);
      for (const key of ["chp", "mhp", "erdogan", "ozgur-ozel", "israil", "abd", "iran", "ukrayna"]) {
        expect(entityHubHeadlineOnly(entityByKey(key)!), key).toBe(false);
      }
      expect(RISING_ENTITIES.filter((e) => entityHubHeadlineOnly(e)).map((e) => e.key)).toEqual(["akp"]);
    });

    it("takes the spec as an argument, like the other helpers, and reads only the literal true", () => {
      const e = { key: "x", label: "Xyz", tokens: [] as string[] };
      expect(entityHubHeadlineOnly(e)).toBe(false);
      expect(entityHubHeadlineOnly(e, {})).toBe(false);
      expect(entityHubHeadlineOnly(e, { headlineOnly: true })).toBe(true);
      expect(entityHubHeadlineOnly(e, { headlineOnly: false as unknown as true })).toBe(false);
      expect(entityHubHeadlineOnly(e, { headlineOnly: 1 as unknown as true })).toBe(false);
    });

    it("does not touch the regex: the patterns of every hub are what they were without the flag", () => {
      for (const e of RISING_ENTITIES) {
        const withoutFlag: RisingHubSpec = { ...entityHubSpec(e) };
        delete withoutFlag.headlineOnly;
        expect(entityHubPatterns(e), e.key).toEqual(entityHubPatterns(e, withoutFlag));
        expect(entityHubQueries(e), e.key).toEqual(entityHubQueries(e, withoutFlag));
        expect(entityHubForms(e), e.key).toEqual(entityHubForms(e, withoutFlag));
      }
    });
  });

  it("the rollup tokens of the guarded hubs did not change (parity with migration 112)", () => {
    const tokens = (key: string) => RISING_ENTITIES.find((e) => e.key === key)?.tokens;
    expect(tokens("disisleri")).toEqual(["disisleri"]);
    expect(tokens("borsa")).toEqual(["borsa", "bist"]);
    expect(tokens("tcmb")).toEqual(["tcmb", "merkez bankasi"]);
    expect(tokens("aym")).toEqual(["aym", "anayasa mahkemesi"]);
    expect(tokens("meclis")).toEqual(["meclis", "tbmm"]);
  });

  it("requires is curated on exactly meclis", () => {
    expect(
      specs
        .filter(([, s]) => s.requires !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["meclis"]);
  });

  it("the meclis cues: TBMM vocabulary, the parliamentary work, and the party names", () => {
    expect(RISING_HUB_SPECS.meclis?.requires).toEqual([
      "tbmm",
      "genel kurul",
      "milletvekil",
      "kanun teklif",
      "yasa teklif",
      "grup toplanti",
      "meclis baskan",
      "kurtulmus",
      "komisyon",
      "butce gorusme",
      "chp",
      "akp",
      "ak parti",
      "mhp",
      "dem parti",
      "iyi parti",
      "yeniden refah",
    ]);
  });

  it("the meclis excludes close the chamber-of-commerce, municipal and foreign residue", () => {
    expect(RISING_HUB_SPECS.meclis?.excludes).toEqual(
      expect.arrayContaining([
        "ticaret odas",
        "sanayi odas",
        "ito",
        "mto",
        "atso",
        "belediyesi meclis",
        "buyuksehir meclis",
        "meclis uyes",
        "arnavutluk",
      ]),
    );
  });

  it("curated trusted sets: AYM, TCMB, the unambiguous parliament names, Borsa İstanbul and BIST", () => {
    expect(RISING_HUB_SPECS.aym?.trusted).toEqual(["AYM"]);
    expect(RISING_HUB_SPECS.tcmb?.trusted).toEqual(["TCMB"]);
    expect(RISING_HUB_SPECS.meclis?.trusted).toEqual(["TBMM", "Büyük Millet Meclisi"]);
    expect(RISING_HUB_SPECS.borsa?.trusted).toEqual(["Borsa İstanbul", "BIST"]);
  });
});
