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

/** The foreign ministries whose 'Milli Eğitim' / 'Milli Savunma' is not Turkey's (folded; h96-entityhubs-1, the spec restated). */
const MEB_EXCLUDES = ["kktc milli egitim", "fransa milli egitim", "suriye milli egitim"] as const;
const MSB_EXCLUDES = ["polonya milli savunma"] as const;

/** The Adana district and the Tuğberk İmamoğlu ship, which are not the politician (folded; h96-entityhubs-1, the spec restated). */
const IMAMOGLU_EXCLUDES = ["imamoglu ilce", "tugberk imamoglu"] as const;
const IMAMOGLU_NOT_AFTER = ["adana", "tugberk"] as const;

/**
 * The guard in front of a non-trusted base: a negative lookahead over the
 * excludes, a second one over the hub-only excludes, then a positive lookahead
 * over the requires (each only when its list is non-empty), then `[\s\S]*`. A
 * requires phrase follows the same open/closed rule as an exclude. The hub-only
 * excludes get a lookahead of their own so the first one stays word for word the
 * list migration 163 mirrors.
 */
function guardPrefix(
  excludes: readonly string[],
  requires?: readonly string[],
  hubExcludes?: readonly string[],
): string {
  const neg = (list: readonly string[]) =>
    list.length > 0 ? `(?![\\s\\S]*(?:${list.map(excludeAlt).join("|")}))` : "";
  const pos =
    requires !== undefined && requires.length > 0
      ? `(?=[\\s\\S]*(?:${requires.map(excludeAlt).join("|")}))`
      : "";
  return `^${neg(excludes)}${neg(hubExcludes ?? [])}${pos}[\\s\\S]*`;
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
    // The ministers are searched by their titles too (h96-entityhubs-1). No guard: 'Bakan Şimşek' and 'Bakanı Fidan'
    // are as unambiguous as the full name.
    simsek: ["\\mmehmet\\s+simsek", "\\mbakan\\s+simsek", "\\mbakani\\s+simsek"],
    fidan: ["\\mhakan\\s+fidan", "\\mbakan\\s+fidan", "\\mbakani\\s+fidan"],
    // MEB and MSB are trusted (bare); the two long forms carry the foreign-ministry veto.
    meb: [
      "\\mmeb\\M",
      `${guardPrefix(MEB_EXCLUDES)}\\mmilli\\s+egitim\\s+bakanligi`,
      `${guardPrefix(MEB_EXCLUDES)}\\mmilli\\s+egitim\\s+bakani`,
    ],
    msb: [
      "\\mmsb\\M",
      `${guardPrefix(MSB_EXCLUDES)}\\mmilli\\s+savunma\\s+bakanligi`,
      `${guardPrefix(MSB_EXCLUDES)}\\mmilli\\s+savunma\\s+bakani`,
    ],
    // The bare name is vetoed by the district and the ship and skips an occurrence right behind 'Adana' or
    // 'Tuğberk'; 'Ekrem İmamoğlu' is trusted (bare) and carries only the notAfter lookbehinds.
    imamoglu: [
      `${guardPrefix(IMAMOGLU_EXCLUDES)}\\m${notAfterLookbehinds(IMAMOGLU_NOT_AFTER)}imamoglu\\M`,
      `\\m${notAfterLookbehinds(IMAMOGLU_NOT_AFTER)}ekrem\\s+imamoglu`,
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
    // The bare 'Merkez Bankası' is vetoed by a foreign bank anywhere in the text and needs one monetary-policy
    // cue (h61-emptystates-2); 'TCMB' is trusted and stays bare.
    tcmb: [
      "^(?![\\s\\S]*(?:\\mavrupa\\s+merkez|\\mecb\\M|\\mfed\\M|\\mabd\\s+merkez|\\mamerikan\\s+merkez|\\misrail\\s+merkez|\\mingiltere\\s+merkez|\\mjaponya\\s+merkez|\\mrusya\\s+merkez|\\mcin\\s+merkez))(?=[\\s\\S]*(?:\\mtcmb|\\mkarahan|\\mppk\\M|\\mpara\\s+politika|\\mfaiz|\\menflasyon|\\mrezerv|\\mturk\\s+lira|\\mdoviz|\\mkur\\s+korumal|\\mturkiye\\s+cumhuriyet\\s+merkez|\\mpiyasa\\s+katilimci|\\mtbmm|\\mrepo))[\\s\\S]*\\mmerkez\\s+bankasi",
      "\\mtcmb\\M",
    ],
    meclis: [
      "^(?![\\s\\S]*(?:\\mtemsilciler\\s+meclisi|\\mknesset|\\misrail|\\miran|\\mlibya|\\mbelediye\\s+meclis|\\mil\\s+genel\\s+meclis|\\milce\\s+meclis|\\mmahalle\\s+meclis|\\mulusal\\s+meclis|\\mrum\\s+meclis|\\mgkry|\\mticaret\\s+odas|\\msanayi\\s+odas|\\mito\\M|\\mmto\\M|\\matso|\\mbelediyesi\\s+meclis|\\mbuyuksehir\\s+meclis|\\mmeclis\\s+uyes|\\marnavutluk))(?![\\s\\S]*(?:\\mparti\\s+meclisi|\\mkktc|\\mcumhuriyet\\s+meclisi|\\mhirvatistan|\\mfederal\\s+meclis|\\mbundestag|\\mibb\\s+meclis|\\mdanisma\\s+meclis|\\mkadin\\s+meclis|\\mbaris\\s+anneleri|\\misig\\s+meclis))(?=[\\s\\S]*(?:\\mtbmm|\\mgenel\\s+kurul|\\mmilletvekil|\\mkanun\\s+teklif|\\myasa\\s+teklif|\\mgrup\\s+toplanti|\\mkurtulmus|\\mkomisyon|\\mbutce\\s+gorusme|\\mchp\\M|\\makp\\M|\\mak\\s+parti|\\mmhp\\M|\\mdem\\s+parti|\\miyi\\s+parti|\\myeniden\\s+refah))[\\s\\S]*\\mmeclis",
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
    // 'fed' is a whole word, so 'Federasyon' does not veto; the monetary cue ('faiz') is still needed.
    expect(hubMatches("tcmb", "Federasyon başkanı Merkez Bankası'nda faiz görüşmesi yaptı")).toBe(true);
  });

  // h61-emptystates-2. /gundem/tcmb listed one card, Paraguay's Ueno Bank crisis (c377938c): the bare
  // "Merkez Bankası" is any country's, and only a few named foreign banks were in the excludes. The
  // non-trusted form now also needs a Turkish monetary-policy cue anywhere in the title, neutral title
  // or summary lead; the trusted "TCMB" stays bare.
  describe("tcmb: the bare 'Merkez Bankası' needs a monetary-policy cue (h61-emptystates-2)", () => {
    const PARAGUAY =
      "Paraguay'da ülkenin en büyük bankalarından biri battı, Devlet Başkanı Pena istifa etti " +
      "Ueno Bank'ın batmasının ardından Paraguay Devlet Başkanı Santiago Pena görevi bıraktı " +
      "Paraguay'da yaklaşık 2,9 milyon müşterisi olan Ueno Bank'ın sermaye yeterlilik oranının zorunlu asgari " +
      "seviyenin yüzde 50'sinin altına düştüğü tespit edildi. Merkez Bankası bankaya el koyup tasfiyeyi " +
      "başlattı; kriz ortamında Devlet Başkanı Santiago Pena istifa etti.";

    it("another country's central bank with no monetary cue is out (the Paraguay card)", () => {
      expect(hubMatches("tcmb", PARAGUAY)).toBe(false);
    });

    it("a bare 'Merkez Bankası' alone is out; the same words with a cue are in", () => {
      expect(hubMatches("tcmb", "Merkez Bankası")).toBe(false);
      expect(hubMatches("tcmb", "Merkez Bankası bankaya el koydu")).toBe(false);
      expect(hubMatches("tcmb", "Merkez Bankası faizi sabit tuttu")).toBe(true);
    });

    it("keeps the real Turkish central-bank stories", () => {
      for (const sample of [
        "Merkez Bankası faizi sabit tuttu",
        "Merkez Bankası rezervleri 5 milyar dolar arttı",
        "Merkez Bankası Başkanı Karahan sunum yaptı",
        "9 ay sonra bir ilk: Merkez Bankası faizi indirdi Merkez Bankası faiz kararını açıkladı",
        "Merkez Bankası enflasyon raporunu açıkladı",
        "Merkez Bankası Para Politikası Kurulu toplandı",
        "Merkez Bankası PPK kararını duyurdu",
        "Merkez Bankası Piyasa Katılımcıları Anketi yayımlandı",
        "Merkez Bankası'ndan Türk lirası hamlesi",
        "Merkez Bankası'ndan döviz hamlesi",
        "Merkez Bankası kur korumalı mevduat kararını açıkladı",
        "Türkiye Cumhuriyet Merkez Bankası açıklama yaptı",
        "TBMM'de bu hafta Kızılay kanun teklifi ve Merkez Bankası'nın sunumu ele alınacak",
        "Merkez Bankası haftalık repo fonlamasını artırdı",
      ]) {
        expect(hubMatches("tcmb", sample), sample).toBe(true);
      }
    });

    it("other countries' banks and a former title in a side story are out when no cue is in the text", () => {
      for (const sample of [
        "Güney Kore Merkez Bankası dijital para projesini durdurdu",
        "Özbekistan'da Apple Pay kullanıma açıldı Merkez Bankası fintech reformlarını duyurdu",
        "G20 maliye bakanları ve merkez bankası başkanları toplandı, ortak bildiri çıkmadı",
        // The bank is only a person's former title: the story is the fund investigation.
        "Fon soruşturmasında 15 tutuklama daha: eski Merkez Bankası Başkan Yardımcısı Taha Çakmak cezaevine gönderildi",
      ]) {
        expect(hubMatches("tcmb", sample), sample).toBe(false);
      }
    });

    it("the trusted 'TCMB' stays bare: no cue needed", () => {
      expect(hubMatches("tcmb", "TCMB açıkladı")).toBe(true);
      expect(hubMatches("tcmb", "TCMB")).toBe(true);
    });

    it("the foreign cases stay out even with a monetary cue (the excludes are untouched)", () => {
      for (const sample of [
        "Avrupa Merkez Bankası faiz kararını açıkladı",
        "ABD Merkez Bankası enflasyon verisini bekliyor",
        "FED faizi sabit tuttu: Merkez Bankası Başkanı Powell konuştu",
        "ECB faiz kararı, Merkez Bankası",
        "Rusya Merkez Bankası politika faizini düşürdü",
      ]) {
        expect(hubMatches("tcmb", sample), sample).toBe(false);
      }
    });

    it("a trusted TCMB mention wins over the missing cue, but not over a foreign cue", () => {
      expect(hubMatches("tcmb", "TCMB ve Merkez Bankası")).toBe(true);
      expect(hubMatches("tcmb", "TCMB ve FED faiz kararı")).toBe(true);
    });
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

// ---------------------------------------------------------------------------
// h96-entityhubs-1 (hunt 96, 2026-11-09). Person and ministry hubs that searched one spelling:
// /gundem/simsek missed every "Bakan Şimşek" headline (19 and 17 articles among them), /gundem/meb
// every "Milli Eğitim Bakanı Tekin" story, msb and fidan the "Bakanı" headlines, and /gundem/imamoglu
// listed Adana's İmamoğlu district and the Tuğberk İmamoğlu ship. The stories below are verbatim
// production text, read-only through sbq.py: title_tr, title_tr_neutral and the first line of
// summary_tr, which entity_cluster_ids_v3 joins with single spaces into the text the regex sees.
// ---------------------------------------------------------------------------
const H96_STORIES: Readonly<Record<string, readonly [title: string, neutral: string, lead: string]>> = {
  "4e006e95": ["Bakan Şimşek: Körfez'deki savaşın bölgeyi temelden değiştireceğini düşünüyorum", "Bakan Şimşek: Körfez'deki savaşın bölgeyi temelden değiştireceğini düşünüyorum", "Bakanı Şimşek, Körfez'deki savaşın bölgeyi temelden değiştireceğini, bölgesel aktörler arasında rekabetin azalacağı ve işbirliğinin artacağını belirterek, \"Türkiye'nin de bütün bu gelişmelerden önemli ölçüde fayda sağlaması oldukça muhtemel.\" dedi."],
  "3b041b3c": ["Bakan Şimşek: Tasfiyedeki fonlarda 614 bin 874 hesaba 130,2 milyar lira ödeme yapıldı", "Bakan Şimşek: Tasfiyedeki fonlarda 614 bin 874 hesaba 130,2 milyar lira ödeme yapıldı", "Hazine ve Maliye Bakanı Şimşek: \"Tasfiyedeki fonlarda 614 bin 874 hesaba 130,2 milyar lira ödeme yapıldı, 179 bin 449 kişi net yatırım tutarının tamamını aldı\""],
  "71110c3b": ["Bakan Şimşek çalışmayı duyurdu... Emeklilere destek programı masada", "Emekli maaşı düzenlemesinin detayları belli oldu: Bakan Şimşek duyurdu", "Bakan Şimşek: 2027 yılında emeklilerimizin desteklenmesi amacıyla yürüttüğümüz teknik bir çalışma var, çalışma henüz tamamlanmadı. Düzenleme tüm emeklilerimizi kapsayacaktır. Herkese aynı değil, yaşa ve prime göre farklılık gösterecek bir çalışma yürütülüyor."],
  "758e72ad": ["Memur ve emeklilerin beklediği talepler Bakan Şimşek'e iletildi: 3600 ek gösterge masada", "Memur-Sen, Bakan Şimşek’e taleplerini iletti: Talepler dört başlıkta toplandı", "Memur-Sen, Bakan Şimşek'e 3600 ek gösterge, emeklilere seyyanen ödeme, personel sistemi reformu ve koruyucu giyim yardımı taleplerini iletti."],
  "1edc2e33": ["Bakan Şimşek'ten enflasyon açıklaması", "Bakan Şimşek'ten enflasyon açıklaması: 'Yıllık oran bir yılda 3,1 puan geriledi'", "Hazine ve Maliye Bakanı Şimşek, Önümüzdeki dönemde ekonomik aktivitenin dengeli seyri, enerji ve emtia fiyatlarında öngörülen gerileme, beklentilerde iyileşme ve hizmet enflasyonunda ataletin azalması enflasyondaki düşüşü destekleyecektir."],
  "c05ed0eb": ["Dışişleri Bakanı Fidan: Politik anlaşmazlıklar global ekonomileri sürdüren sistemleri paralize etmemeli", "Bakan Fidan: Türkiye, bölgesel sahipliği korumaya çalışıyor", "Bakan Fidan, \"Rotalar korunmalı, çatışmalar kısıtlanmalıdır. Politik anlaşmazlıklar global ekonomileri sürdüren sistemleri paralize etmemelidir. Türkiye sürdürülebilir diplomasi sağlamaya, bölgesel sahipliği korumaya çalışıyor.\" dedi."],
  "e3262ca6": ["Dışişleri Bakanı Fidan'dan G20 sonrası önemli mesajlar: Beş yıllık savaş artık taşınamaz", "Bakan Fidan: Rusya ve Ukrayna anlaşmaya varmak zorunda", "- \"(Rusya-Ukrayna Savaşı) Yaklaşık 5 yıl olmuş bu savaş başlayalı. Artık bu savaş taşınamaz. Dolayısıyla Rusya ve Ukrayna, büyük bir fedakarlıkta bulunarak bir anlaşmaya varmak zorundalar\""],
  "b8a84cf2": ["Milli Eğitim Bakanı Tekin, Karabağ Zaferi'nin 6. yılını kutladı", "Bakan Tekin’den Karabağ Zaferi’nin 6. yılına kutlama mesajı", "Milli Eğitim Bakanı Yusuf Tekin, Azerbaycan'ın Karabağ Zaferi dolayısıyla kutlanan 8 Kasım Zafer Günü'nü tebrik etti."],
  "457bf390": ["Milli Eğitim Bakanı Yusuf Tekin: 28 Şubat Türkiye'de mesleki eğitimi olumsuz etkiledi", "Milli Eğitim Bakanı Yusuf Tekin: 28 Şubat Türkiye'de mesleki eğitimi olumsuz etkiledi", "Milli Eğitim Bakanı Yusuf Tekin, 28 Şubat sürecinde alınan kararların mesleki eğitime büyük zarar verdiğini ifade etti."],
  "57ef49ea": ["Milli Eğitim Bakanı Tekin, Yahya Kemal Beyatlı'yı 68. yıl dönümünde andı", "Milli Eğitim Bakanı Tekin, vefatının 68. yılında Yahya Kemal Beyatlı'yı andı", "Milli Eğitim Bakanı Yusuf Tekin, vefatının 68. yılında Yahya Kemal Beyatlı'yı NSosyal hesabından paylaştığı mesajla andı. Tekin, mesajında Beyatlı'nın mısralarında Türkçemizin zarafetini, tarihimizin sesini ve medeniyetimizin inceliklerini bulduğumuzu belirtti."],
  "14d78e3c": ["Milli Savunma Bakanı Güler, Ukraynalı mevkidaşı Khmara ile güvenlik konusunu görüştü", "Milli Savunma Bakanı Güler, Ukraynalı mevkidaşıyla görüştü", "Milli Savunma Bakanı Yaşar Güler, Ukrayna Savunma Bakanı Yevgeni Khmara ile telefon görüşmesi yaptı. Görüşmede ikili ve bölgesel savunma ile güvenlik konularında görüş alışverişinde bulunuldu."],
  "14c5e96f": ["'İmamoğlu çıkar amaçlı suç örgütü' davasında 104. duruşma sona erdi: Tanık Selman Narman'dan çarpıcı ihale iddiaları", "'İmamoğlu çıkar amaçlı suç örgütü' davasında 104. duruşma sona erdi. Tanık Selman Narman'dan çarpıcı ihale iddiaları", "İstanbul 33. Ağır Ceza Mahkemesince Marmara Kapalı Ceza İnfaz Kurumu karşısındaki salonda yapılan duruşmada dinlenen tanık Furkan Yalçınkaya, organizasyon şirketi sahibi tutuksuz sanık Ahmet Çiçek'le 3-4 sene önce tanıştığını söyledi."],
  "81c805d1": ["Ekrem İmamoğlu: \"Cesur nesillere, gençlere kaybedeceksiniz\"", "Ekrem İmamoğlu: \"Cesur nesillere, gençlere kaybedeceksiniz\"", "Tutuklu cumhurbaşkanı adayı ve İBB Başkanı Ekrem İmamoğlu, Bakan Yusuf Tekin'in Kadıköy Lisesi ziyareti öncesinde 'Yusuf Tekin istifa' pankartı açan TİP üyesi iki öğrencinin gözaltına alınmasına tepki gösterdi. İmamoğlu, 'Korkma' diyenlere ve gençlere 'kaybedeceksiniz' dedi."],
  "c828192c": ["Adana İmamoğlu'nda iki evi kurşunlayan 5 şüpheliden 3'ü tutuklandı", "İmamoğlu'nda iki evi kurşunlayan zanlılar kamerayla tespit edilip yakalandı", "Adana'nın İmamoğlu ilçesinde 24 Ekim-6 Kasım tarihleri arasında Hürriyet Mahallesi'nde iki ayrı evin kurşunlanmasıyla ilgili gözaltına alınan 5 şüpheliden 3'ü tutuklandı. Polis ekipleri, onlarca saatlik kamera kaydını inceleyerek şüphelileri yakalamıştı."],
  "848f51b2": ["Silivri'de batan gemideki denizcilerin ailelerinden yeni çağrı: İki gemi birlikte çalışsın", "Silivri'de batan gemideki denizcilerin ailelerinden çağrı: Bütün imkanlar birleştirilsin", "Silivri açıklarında 2 Eylül'de batan Tuğberk İmamoğlu gemisinde görevli personeli arama çalışmaları sürüyor. Aileler biraraya gelerek arama çalışmalarının hızlandırılmasını istedi. Açıklamayı Tuğberk İmamoğlu gemisinde aşçı olarak görev yapan Abdülbaki Mirzaoğlu'nun kardeşi Nusret Mirzaoğlu yaptı."],
  "1662ce5a": ["Berhan Şimşek, CHP MYK'dan istifa etti", "CHP'li Berhan Şimşek istifa etti", "Berhan Şimşek, CHP MYK'dan istifa etti 04.09.2026 DikenŞiddet görüntüleriyle gündemde olan Berhan Şimşek, hakkındaki davalar sonuçlanana kadar CHP MYK üyeliğinden istifa etti."],
  "6f99a6aa": ["‘Şapkalılar Suç Örgütü’ soruşturması… Bakırköy Belediye Meclis üyesi Hülya Şimşek tutuklandı", "CHP'li Sultangazi Belediye Meclis üyesi tutuklandı", "Bakırköy Cumhuriyet Başsavcılığı, sosyal medya ve farklı numaralar üzerinden “Şapkalılar Suç Örgütü” tarafından tehdit edilerek para talep edildiği belirtilen olayın azmettiricisi olduğu değerlendirilen Bakırköy Belediye Meclis üyesi ve avukat Hülya Şimşek’in tutuklandığını açıkladı."],
  "61bc5710": ["Bakan Bak, KKTC'li mevkidaşıyla Lefkoşa ve Girne'de öğrenci yurdu protokolü imzaladı", "", "Lefkoşa ve Girne'de öğrenci yurtları yapılması için Türkiye ile KKTC arasında iş birliği protokolü imzalandı. Gençlik ve Spor Bakanı Osman Aşkın Bak, KKTC Milli Eğitim Bakanı Nazım Çavuşoğlu ile imzalanan protokolün gençlerin geleceği için hayırlı olmasını diledi."],
  "0ad80814": ["Fransa'da liseliler kazandı", "", "Fransa Milli Eğitim Bakanı Edouard Geffray, sosyal medya hesabından yaptığı açıklamada, liselilerin talepleri doğrultusunda sendikalarla ve öğrenci temsilcileriyle yürüttükleri görüşmelerin ardından bazı kararlar aldıklarını duyurdu."],
  "13d5948d": ["Suriye'nin yeni müfredatında Osmanlı anlatısı değişti", "Suriye'nin yeni müfredatında Osmanlı anlatısı değişti", "Suriye Milli Eğitim Bakanlığının yenilediği ders kitaplarında Osmanlı Devleti, Arap İsyanı ve milli kimliğe ilişkin anlatımlar değiştirildi. Eski müfredattaki “Osmanlı işgali” ve “Türklerin zulmü” ifadeleri kaldırılırken, Arap milliyetçiliği vurgusunun yerini İslam medeniyeti ve ümmet kavramları aldı. Suriye haritasından İskenderun çıkarılırken, ders kitaplarına İslam tarihinden yeni isimler ve Filistin mücadelesine ilişkin içerikler eklendi."],
  "1f9ebac9": ["15 tatil ne zaman başlayacak, bitecek? Ara tatil ne zaman?", "9 günlük ara tatil ne zaman? 2026 Kasım ara tatili ne zaman, ne zaman başlıyor?", "2026-2027 eğitim-öğretim yılında öğrencilerin ara tatil ve yarıyıl tatili tarihleri merak ediliyor. Millî Eğitim Bakanlığının çalışma takvimine göre ilk ara tatil kasım ayında, sömestr tatili ise ocak ayında başlayacak. Peki, 15 tatil ne zaman başlayacak, bitecek? Ara tatil ne zaman? İşte detaylar…"],
  // h96-entityhubs-2 (the meclis hub, same read, same day): party, foreign and municipal councils, and the TBMM rows around them.
  "01cbab9a": ["Özgür Özel, kurultayda Parti Meclisi'ni 150 kişiye çıkaracaklarını açıkladı", "Özgür Özel, kurultayda Parti Meclisi'ni 150 kişiye çıkaracaklarını açıkladı", "YENİ Parti Genel Başkanı Özgür Özel, önümüzdeki hafta yapılacak 1'inci Olağan Kurultay'da seçilecek Parti Meclisi'ni 150 kişiye çıkaracaklarını açıkladı. Meclisin 80'i milletvekili, 40'ı il-ilçe örgütlerinden, 30'u akademisyen ve siyasetçilerden olacak."],
  "430bacd3": ["DEM Parti Lideri Bakırhan’dan İktidara ‘Süreç’ Çağrısı", "DEM Parti Lideri Bakırhan’dan İktidara ‘Süreç’ Çağrısı", "Halkların Eşitlik ve Demokrasi Partisi (DEM Parti) Eş Genel Başkanı Tuncer Bakırhan, partisinin Genel Merkezinde toplanan Parti Meclisi (PM) açılışında Türkiye'nin iç barış arayışları ve \"Terörsüz Türkiye\" tartışmalarına ilişkin kapsamlı değerlendirmelerde bulundu."],
  "e04f9346": ["Tuncer Bakırhan: ‘Kürt meselesi bir güvenlik dosyası değil’", "Tuncer Bakırhan: ‘Kürt meselesi bir güvenlik dosyası değil’", "DEM Parti Eş Genel Başkanı Tuncer Bakırhan, Parti Meclisi toplantısının açılışında yaptığı konuşmada çözüm sürecinin Türkiye için bir çıkış yolu olduğunu belirterek iktidara adım atma çağrısında bulundu. Tedavi gördüğü hastanede yaşamını yitiren hasta tutuklu Tuncer Sağlam’ı da anan Bakırhan, “Hasta tutuklular neden hâlâ içeride?” diye sordu."],
  "53c4123b": ["DEM Parti eski PM üyesi Nesrin Aslan hayatını kaybetti", "DEM Parti eski PM üyesi Nesrin Aslan hayatını kaybetti", "Eski DEM Parti Parti Meclisi üyesi Nesrin Aslan yaşamını yitirdi. DEM Parti Eş Genel Başkanı Tuncer Bakırhan, “Nesrin Aslan’ı emeği ve yoldaşlığıyla her zaman hatırlayacak, anısına bağlı kalacağız” dedi."],
  "b9601948": ["Genelkurmay Başkanı Bayraktaroğlu, KKTC Meclis Başkanı Öztürkler ile görüştü", "Lefkoşa'da askeri ve parlamenter temas: Selçuk Bayraktaroğlu, Ziya Öztürkler ile görüştü", "Genelkurmay Başkanı Orgeneral Selçuk Bayraktaroğlu, KKTC temasları kapsamında Lefkoşa'da Cumhuriyet Meclisi Başkanı Ziya Öztürkler ile bir araya geldi. Görüşmede Bayraktaroğlu'na Kıbrıs Türk Barış Kuvvetleri ve Güvenlik Kuvvetleri komutanları eşlik etti."],
  "d448df20": ["KKTC'de 6 Aralık'ta 50 milletvekili ve 18 belediye başkanı seçilecek", "KKTC, 6 Aralık'ta sandığa gidiyor: Meclis ve yerel yönetimler belirlenecek", "KKTC'de seçmenler 6 Aralık'ta 50 milletvekili, 18 belediye başkanı ve yerel yönetimleri belirlemek için sandığa gidecek. Yaklaşık 225 bin seçmenin bulunduğu ülkede 8 partinin 400 geçici adayı ve 8 bağımsız aday yarışacak."],
  "31342903": ["Dışişleri Bakanı Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü", "Bakan Fidan, Hırvatistan Meclis Başkanı Jandrokovic ile görüştü", "Dışişleri Bakanı Hakan Fidan, Ankara'da Hırvatistan Meclis Başkanı Gordan Jandrokovic ile bir araya geldi."],
  "2a7e585a": ["Üç Deniz Girişimi'ni hatırlattı: Hırvatistan'dan Ankara'ya stratejik mesaj", "Üç Deniz Girişimi'ni hatırlattı: Hırvatistan'dan Ankara'ya stratejik mesaj", "Hırvatistan Meclis Başkanı Gordan Jandrokovic, ülkesinin Türkiye ile ilişkilerinin çok iyi seviyede olduğunu bir kez daha teyit ettiklerini söyledi."],
  "048a9b43": ["Almanya'da milletvekillerinin telefonlarına casus yazılım saldırı girişimi doğrulandı", "Almanya'da milletvekillerinin telefonlarına casus yazılım saldırı girişimi doğrulandı", "Almanya Dijital Bakanı Wildberger, Federal Meclis üyeleri ve hükümet üyelerinin telefonlarına yönelik siber saldırı girişimini doğruladı. BSI'nın 30 Ekim'deki bilgilendirmesiyle olası etkilenenlere güvenlik önlemleri bildirildi; saldırının boyutu soruşturmayla netleşecek."],
  "095d29d1": ["Almanya'da siber casusluk alarmı: Milletvekilleri ve hükümet yetkililerinin telefonları hedef alındı", "Almanya'da siber casusluk alarmı: Milletvekilleri ve hükümet yetkililerinin telefonları hedef alındı", "Almanya'da Federal Meclis (Bundestag) üyeleri ve hükümet yetkililerinin cep telefonlarının gelişmiş casus yazılımlarla hedef alındığı ortaya çıktı. Apple'ın iPhone kullanıcılarına gönderdiği güvenlik uyarılarının ardından Alman makamları harekete geçti. Yetkililer, saldırıların başarılı olup olmadığının henüz belirlenemediğini açıkladı."],
  "4b46258c": ["\"İBB'deki dengelerin değişmesini istemiyoruz\"", "DEM Parti Grup Başkanvekili Temelli: İBB Meclisi’ndeki dengelerin değişmesini istemiyoruz", "DEM Parti Grup Başkanvekili Sezai Temelli, \"kent uzlaşısı\" kararı hakkında, \"İstanbul halkının tercihiyle oluşmuş olan dengeler ancak yine İstanbul halkının tercihiyle değişebilir. Transferlerle, müdahalelerle olacak dengeleri kabul etmiyoruz\" diye konuştu"],
  "4cc69420": ["İBB Meclisi'nde dengeler değişiyor: YENİ Parti'ye geçen üye sayısı 84'e ulaştı", "İBB Meclisi'nde dengeler değişiyor: Yeni Parti'ye geçen üye sayısı 84'e ulaştı", "İBB Meclisi'nde CHP'den ayrılarak Yeni Parti'ye katıldığını açıklayan üyelerin sayısı 84'e ulaştı. Mecliste siyasi dengeler değişirken, 23 üyenin oy kullanamayacağı hesaplandı. Parti değişikliklerinin resmi kayıtlara yansımasıyla yeni sandalye dağılımı netleşecek."],
  "0f16f0f5": ["Bakan Bayraktar: Milli Enerji 2040, yaklaşık 250 bin kişiye dolaylı iş sağlayacak", "Bakan Bayraktar: Milli Enerji 2040, yaklaşık 250 bin kişiye dolaylı iş sağlayacak", "Bakan Bayraktar, çeşitli temaslarda bulunmak üzere Mersin’e bir ziyaret gerçekleştirdi. Mersin Valiliğini ziyaret eden Bakan Bayraktar, daha sonra AK Parti İl Danışma Meclisi Toplantısına iştirak etti."],
  "f5b282b7": ["Hüseyin Yayman'dan fon açıklaması: \"Partimiz bu kişilerle yolunu ayıracaktır\"", "Hüseyin Yayman'dan fon açıklaması: \"Partimiz bu kişilerle yolunu ayıracaktır\"", "AKP Genel Başkan Yardımcısı Hüseyin Yayman, Aksaray İl Danışma Meclisi Toplantısı'nda yaptığı konuşmada fon meselesine değinerek, beytülmala ve milletin hukukuna dokunan kim olursa olsun gerekli cezaları alacağını ve partinin bu kişilerle yolunu ayıracağını söyledi."],
  "278eb682": ["DEM Partili Türkoğlu: AİHM kararları uygulanmıyor", "DEM Partili Türkoğlu: AİHM kararları uygulanmıyor", "DEM Parti Kadın Meclisi Sözcüsü Halide Türkoğlu, 4 Kasım 2016'da aralarında eski HDP Eş Genel Başkanları Selahattin Demirtaş ve Figen Yüksekdağ'ın da bulunduğu HDP milletvekillerinin tutuklanmasının 10'uncu yıl dönümü nedeniyle Sincan Cezaevi önünde açıklama yaptı."],
  "892a7e64": ["Ankara’ya ulaşan Barış Anneleri’nin nöbet tuttuğu çadırı su bastı", "Barış Anneleri’nin Ankara’daki çadırını su bastı", "24 farklı kentten Ankara’ya gelen 300’ü aşkın Barış Anneleri Meclisi üyesinin Kurtuluş Parkı’nda kurduğu çadırları sağanak yağış nedeniyle su bastı. Nöbeti önce parka bulunan salona, ardından DEM Parti Genel Merkezi’ne taşıyan annelerin Meclis’te siyasi parti temsilcileriyle görüşmesi bekleniyor."],
  "7b66c93b": ["İSİG: ‘Çocuk işçiliği sermayenin ihtiyaçları doğrultusunda devlet eliyle yaygınlaştırılıyor’", "İSİG Meclisi: 13 yılda en az 862 çocuk işçi yaşamını yitirdi", "İSİG Meclisi İstanbul Sözcüsü Serpil Ünal, AK Parti iktidarı döneminde uygulanan politikaların “çocukları işçileştirdiğini” vurguladı. Ünal “13 yılda en az 862 çocuk çalışırken yaşamını yitirdi. Çocuk işçiliği sermayenin ihtiyaçları doğrultusunda devlet eliyle yaygınlaştırılıyor” dedi."],
  "2c54476c": ["GTB başkanlarından Cumhuriyetin 103. yılı kutlama mesajı", "GTB başkanlarından cumhuriyetin 103. yılına birlik ve üretim vurgusu", "Gaziantep Ticaret Borsası (GTB) Meclis Başkanı Ahmet Tiryakioğlu ve Yönetim Kurulu Başkanı Mehmet Akıncı, 29 Ekim Cumhuriyet Bayramı dolayısıyla kutlama mesajı yayımladı."],
  "0b2e6dc8": ["Kriz bitmiyor! Yeni Parti'ye geçen belediyede CHP'ye tuvalet yanında oda", "Rozeti çıkardı, ilk icraatı oldu. YP'li Başkandan CHP'ye tuvalet yanında oda", "CHP'den ayrılarak Yeni Parti'ye geçen Kadıköy Belediye Başkanı Mesut Kösedağı'nın talimatıyla CHP Meclis Grubu'na tuvaletlerin bitişiğinde, penceresi ve havalandırması bulunmayan bir oda ayrıldığı ortaya çıktı."],
  "fd7720a1": ["Mecliste bu hafta: Bütçe mesaisi... Erken seçim tartışmasında kritik takvim", "Mecliste kritik hafta: 2027 bütçesi ve erken seçim takvimi mercek altında", "Mecliste bu hafta dört bakanlığın 2027 bütçesi görüşülecek. Odatv yazarı Hürrem Elmasçı'nın erken seçim tartışmalarında bütçeyi işaret etmesinin ardından gözler komisyonda. Adalet Bakanlığının bütçesiyle başlayacak haftada Kızılay ve Booking düzenlemeleri de gündemde."],
  "f4642327": ["DEM Parti Sözcüsü Ayşegül Doğan: Meclis İzleme Komisyonu'na dair kuruluş çalışmaları artık tamamlanmalı", "Ayşegül Doğan: Meclis İzleme Komisyonu'na dair kuruluş çalışmaları artık tamamlanmalı", "DEM Parti Sözcüsü Ayşegül Doğan, \"Çerçeve yasanın öngördüğü Meclis İzleme Komisyonu'na dair kuruluş çalışmalarını hem toplum hem de siyasi partiler bekliyor. Bu çalışmalar artık tamamlanmalı. Beklentimiz, önümüzdeki hafta Meclis Başkanı Sayın Kurtulmuş'un siyasi partilerle yapılması gereken görüşmeleri tamamlaması ve ardından kuruluş çalışmalarına ilişkin takvimin hızlandırılmasıdır. Meclis Komisyonu'nun ortak raporunda yer alan demokratikleşme önerileri somut yasa tekliflerine dönüştürülmeli..."],
  "cd9d067d": ["DEM Parti’den Adalet Bakanlığı önünde 4 Kasım açıklaması: Siyasi tutukluluklara son verilsin", "DEM Parti, Adalet Bakanlığı önünde: 'Siyasi tutukluluklara son verilsin'", "DEM Parti Meclis Grubu, eski HDP Eş Genel Başkanları Selahattin Demirtaş ve Figen Yüksekdağ'ın da aralarında bulunduğu siyasetçilerin tutuklanmasının 10'uncu yılında Adalet Bakanlığı önünde açıklama yaptı."],
  "41d9139c": ["Ertuğrul Kaya istifa etti, Meclis'te Yeni Yol grubu düştü", "Ertuğrul Kaya istifa etti, Meclis'te Yeni Yol grubu düştü", "Gaziantep Milletvekili Ertuğrul Kaya'nın DEVA Partisi'nden istifasıyla Meclis'te Yeni Yol grubu düştü."],
  "d94a58d4": ["Meclis Başkanlığının 2027 yılı bütçesi kabul edildi", "Meclis Başkanlığının 2027 yılı bütçesi kabul edildi", "TBMM Plan ve Bütçe Komisyonu, AK Parti Samsun Milletvekili Mehmet Muş başkanlığında toplandı. TBMM Başkanı Numan Kurtulmuş, komisyonda, Meclis Başkanlığının 2027 yılı bütçesine ilişkin sunum yaptı. Komisyonda, milletvekilleri söz alarak bütçeye ilişkin değerlendirmelerde bulundu. Değerlendirmelerin ardından Kurtulmuş milletvekillerinin 2027 yılı bütçe teklifinin geneline ilişkin sorularını yanıtladı. Milletvekilleri danışmanları ve Meclis personellerinin hakları hakkındaki sorulara ilişkin Ku..."],
  "5ca6f9a3": ["Hangi parti ne oy verdi? | Mekke Anlaşması Meclis’te kabul edildi", "Mekke Anlaşması Meclis'te kabul edildi: Hangi parti ne oy verdi", "Türkiye, Pakistan ve Suudi Arabistan arasında imzalanan Mekke Ortak Savunma Anlaşması’nın onaylanmasına ilişkin kanun teklifi Meclis'te kabul edildi. Oylamada partilerin verdikleri oylar belli oldu."],
  "0cf5badd": ["Kurtulmuş'tan Balkanlar mesajı: \"Her gelişmeyi yakından takip ediyoruz\"", "Kurtulmuş'tan Balkanlar mesajı: \"Her gelişmeyi yakından takip ediyoruz\"", "TBMM Başkanı Numan Kurtulmuş, Hırvatistan Meclis Başkanı Gordan Jandrokovi ile gerçekleştirdiği görüşmenin ardından yaptığı açıklamada, Balkanlar'da istikrar, güven ve refahın önemine dikkat çekti....Devamı için tıklayınız"],
};

/** hubMatches on one stored story: its title, neutral title and summary lead, joined like the RPC's guard text. */
function storyMatches(key: string, id: string): boolean {
  const story = H96_STORIES[id];
  if (story === undefined) throw new Error(`no stored story ${id}`);
  return hubMatches(key, story.join(" "));
}

describe("person and ministry hubs (h96-entityhubs-1)", () => {
  it("simsek: 'Bakan Şimşek' and 'Bakanı Şimşek' name the minister, whatever the summary calls him", () => {
    // 4e006e95 (5 articles), 3b041b3c (19), 71110c3b (17), 758e72ad (2) and 1edc2e33 (9): all live, none listed before.
    for (const id of ["4e006e95", "3b041b3c", "71110c3b", "758e72ad", "1edc2e33"]) {
      expect(storyMatches("simsek", id), id).toBe(true);
    }
    expect(hubMatches("simsek", "Mehmet Şimşek açıkladı")).toBe(true);
    expect(hubMatches("simsek", "Hazine ve Maliye Bakanı Şimşek'ten açıklama")).toBe(true);
    expect(hubMatches("simsek", "Bakanı Şimşek'te toplantı")).toBe(true);
  });

  it("simsek: other Şimşeks and the lightning stay out", () => {
    // Real: the CHP's Berhan Şimşek (1662ce5a) and a municipal council member Hülya Şimşek (6f99a6aa).
    expect(storyMatches("simsek", "1662ce5a")).toBe(false);
    expect(storyMatches("simsek", "6f99a6aa")).toBe(false);
    // Hand-written (no live cluster carries these shapes in the 200 days read on 2026-11-09).
    expect(hubMatches("simsek", "Vali Yılmaz Şimşek yangın bölgesinde incelemelerde bulundu")).toBe(false);
    expect(hubMatches("simsek", "Şimşekspor sezonu galibiyetle açtı")).toBe(false);
    expect(hubMatches("simsek", "Düzce'de şimşeklerin ardından sağanak başladı")).toBe(false);
    expect(hubMatches("simsek", "Başbakan Şimşek")).toBe(false);
  });

  it("fidan: 'Bakan Fidan' and 'Dışişleri Bakanı Fidan' headlines are the minister's", () => {
    // c05ed0eb (8 articles) and e3262ca6 (9): 'Dışişleri Bakanı Fidan ...' with 'Bakan Fidan' in the neutral title.
    for (const id of ["c05ed0eb", "e3262ca6"]) expect(storyMatches("fidan", id), id).toBe(true);
    expect(hubMatches("fidan", "Hakan Fidan Moskova'da")).toBe(true);
    expect(hubMatches("fidan", "Bakanı Fidan'dan açıklama")).toBe(true);
    // The ministers of other portfolios and a tree-planting minister stay out.
    expect(hubMatches("fidan", "Bakan Yumaklı fidan dikim törenine katıldı")).toBe(false);
    expect(hubMatches("fidan", "Fidan Doğan'ın duruşması ertelendi")).toBe(false);
  });

  it("meb: 'Milli Eğitim Bakanı Tekin' and 'Milli Eğitim Bakanlığı' stories are the ministry's", () => {
    // b8a84cf2, 457bf390 and 57ef49ea: 'Milli Eğitim Bakanı (Yusuf) Tekin ...', none says MEB.
    for (const id of ["b8a84cf2", "457bf390", "57ef49ea"]) expect(storyMatches("meb", id), id).toBe(true);
    expect(hubMatches("meb", "MEB'den yeni müfredat açıklaması")).toBe(true);
    expect(hubMatches("meb", "Milli Eğitim Bakanlığı karnelerin tarihini duyurdu")).toBe(true);
  });

  it("meb: the KKTC, French and Syrian ministries are out, and MEB itself needs no help", () => {
    // 61bc5710 (archived, real): a Turkish minister and 'KKTC Milli Eğitim Bakanlığı' sign a dormitory protocol.
    expect(storyMatches("meb", "61bc5710")).toBe(false);
    // 0ad80814 (real): 'Fransa Milli Eğitim Bakanı Edouard Geffray'; 13d5948d (real, 2 articles): 'Suriye Milli Eğitim Bakanlığı'.
    expect(storyMatches("meb", "0ad80814")).toBe(false);
    expect(storyMatches("meb", "13d5948d")).toBe(false);
    expect(hubMatches("meb", "KKTC Milli Eğitim Bakanı Çavuşoğlu açıklama yaptı")).toBe(false);
    // The trusted spelling stands alone: the Turkish ministry's own protocol with the KKTC one.
    expect(hubMatches("meb", "MEB, KKTC Milli Eğitim Bakanlığı ile protokol imzaladı")).toBe(true);
  });

  it("meb and msb: the official 'Millî' spelling counts, and the stemmed prefilter reaches it", () => {
    // 1f9ebac9 (real): the school calendar, 'Millî Eğitim Bakanlığının çalışma takvimine göre'. The folded regex reads
    // 'î' as 'i', but the Turkish stemmer keeps 'millî' and 'milli' apart, so the prefilter needs both spellings.
    expect(storyMatches("meb", "1f9ebac9")).toBe(true);
    expect(hubMatches("meb", "Millî Eğitim Bakanı Tekin açıkladı")).toBe(true);
    expect(hubMatches("msb", "Millî Savunma Bakanlığı duyurdu")).toBe(true);
    for (const key of ["meb", "msb"]) {
      const queries = entityHubQueries(entityByKey(key)!);
      expect(queries.length, key).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      const ministry = key === "meb" ? "eğitim" : "savunma";
      for (const form of ["bakanlığı", "bakanı"]) {
        expect(queries, `${key}: milli ${ministry} ${form}`).toContain(`milli ${ministry} ${form}`);
        expect(queries, `${key}: millî ${ministry} ${form}`).toContain(`millî ${ministry} ${form}`);
      }
    }
  });

  it("msb: 'Milli Savunma Bakanı Güler' is the ministry; Poland's 'Milli Savunma' is not", () => {
    expect(storyMatches("msb", "14d78e3c")).toBe(true);
    expect(hubMatches("msb", "Milli Savunma Bakanlığı haftalık basın toplantısı")).toBe(true);
    expect(hubMatches("msb", "MSB: Bir haftada 6 terörist teslim oldu")).toBe(true);
    // Hand-written: the live Polish rows are single-article clusters, below the hub's floor.
    expect(hubMatches("msb", "Polonya Milli Savunma Bakanı Kosiniak-Kamysz Ankara'da")).toBe(false);
    expect(hubMatches("msb", "Polonya Milli Savunma Bakanlığı açıklaması")).toBe(false);
    // 'Milli Savunma Komisyonu' is the TBMM committee, not the ministry.
    expect(hubMatches("msb", "TBMM Milli Savunma Komisyonu toplandı")).toBe(false);
  });

  it("imamoglu: the politician stays, Adana's district and the Tuğberk İmamoğlu ship go", () => {
    // 14c5e96f and 81c805d1 (real): the İBB trial's 104th hearing, and an 'Ekrem İmamoğlu' headline.
    expect(storyMatches("imamoglu", "14c5e96f")).toBe(true);
    expect(storyMatches("imamoglu", "81c805d1")).toBe(true);
    // c828192c: the Adana shooting. The title says 'Adana İmamoğlu'nda', the lead 'Adana'nın İmamoğlu ilçesinde'.
    const adana = H96_STORIES["c828192c"]!;
    expect(storyMatches("imamoglu", "c828192c")).toBe(false);
    expect(hubMatches("imamoglu", adana[0])).toBe(false);
    expect(hubMatches("imamoglu", adana[2])).toBe(false);
    // 848f51b2: only the lead names 'Tuğberk İmamoğlu gemisinde'.
    const ship = H96_STORIES["848f51b2"]!;
    expect(hubMatches("imamoglu", ship[2])).toBe(false);
    expect(storyMatches("imamoglu", "848f51b2")).toBe(false);
  });

  it("imamoglu: the locative is not the district, and 'Ekrem İmamoğlu' beats a district cue elsewhere", () => {
    // hunt-59's own samples: "Söz İmamoğlu'nda" and "Adana'da İmamoğlu protestoları" are the politician.
    expect(hubMatches("imamoglu", "İBB davası 98. gün: Söz İmamoğlu'nda")).toBe(true);
    expect(hubMatches("imamoglu", "Adana'da İmamoğlu protestoları nedeniyle 3 kişiye dava açıldı")).toBe(true);
    expect(hubMatches("imamoglu", "İmamoğlu ilçesinde kurşunlama; Ekrem İmamoğlu'ndan tepki")).toBe(true);
    expect(hubMatches("imamoglu", "Tuğberk İmamoğlu gemisi arama çalışmaları, Ekrem İmamoğlu mesaj gönderdi")).toBe(true);
    expect(hubMatches("imamoglu", "Tuğberk İmamoğlu gemisinde arama sürüyor")).toBe(false);
  });
});

describe("meclis hub: party, foreign and municipal councils are not the TBMM (h96-entityhubs-2)", () => {
  // Page 1 of /gundem/meclis listed four of these and the whole 14-day hub about nineteen: the requires cue was
  // satisfied by the matched phrase itself ('KKTC Meclis Başkanı', 'Parti Meclisi' under a party name).
  const NOT_TBMM: ReadonlyArray<readonly [id: string, what: string]> = [
    ["01cbab9a", "YENİ Parti's Parti Meclisi at its kurultay"],
    ["430bacd3", "DEM Parti Parti Meclisi (PM) meeting"],
    ["e04f9346", "DEM Parti Parti Meclisi (PM) meeting"],
    ["53c4123b", "obituary of a former DEM Parti Parti Meclisi member"],
    ["b9601948", "KKTC Meclis Başkanı (Cumhuriyet Meclisi)"],
    ["d448df20", "the KKTC election"],
    ["31342903", "Hırvatistan Meclis Başkanı"],
    ["2a7e585a", "Hırvatistan Meclis Başkanı"],
    ["048a9b43", "Almanya's Federal Meclis"],
    ["095d29d1", "Almanya's Federal Meclis (Bundestag)"],
    ["4b46258c", "İBB Meclisi"],
    ["4cc69420", "İBB Meclisi"],
    ["0f16f0f5", "AK Parti İl Danışma Meclisi"],
    ["f5b282b7", "AK Parti İl Danışma Meclisi"],
    ["278eb682", "DEM Parti Kadın Meclisi"],
    ["892a7e64", "Barış Anneleri Meclisi"],
    ["7b66c93b", "İSİG Meclisi"],
    ["2c54476c", "Gaziantep Ticaret Borsası Meclis Başkanı"],
  ];

  it("the party, foreign, municipal and NGO councils drop out", () => {
    for (const [id, what] of NOT_TBMM) expect(storyMatches("meclis", id), `${id} ${what}`).toBe(false);
  });

  it("the Turkish parliament stays: the bare week-in-Meclis, committees, a TBMM group, the Yeni Yol group, the Meclis budget, the Mekke vote", () => {
    for (const id of ["fd7720a1", "f4642327", "cd9d067d", "41d9139c", "d94a58d4", "5ca6f9a3"]) {
      expect(storyMatches("meclis", id), id).toBe(true);
    }
  });

  it("'TBMM' keeps a story that also names a foreign speaker (the trusted form skips every guard)", () => {
    // 0cf5badd (real): 'TBMM Başkanı Numan Kurtulmuş, Hırvatistan Meclis Başkanı Gordan Jandrokovi ile ...'.
    expect(storyMatches("meclis", "0cf5badd")).toBe(true);
    expect(hubMatches("meclis", "TBMM Başkanı Kurtulmuş, KKTC Meclis Başkanı Öztürkler'i kabul etti")).toBe(true);
    expect(hubMatches("meclis", "Türkiye Büyük Millet Meclisi'nde İBB Meclisi tartışması")).toBe(true);
  });

  it("'parti meclisi' is the veto, not 'parti meclis': a TBMM party group still counts", () => {
    expect(hubMatches("meclis", "DEM Parti Meclis Grubu toplandı")).toBe(true);
    expect(hubMatches("meclis", "CHP Parti Meclisi toplandı, Meclis'e çağrı")).toBe(false);
    expect(RISING_HUB_SPECS.meclis?.hubExcludes).toContain("parti meclisi");
    expect(RISING_HUB_SPECS.meclis?.hubExcludes).not.toContain("parti meclis");
  });

  it("no bare 'almanya' veto: a TBMM delegation story that mentions Berlin stays", () => {
    expect(RISING_HUB_SPECS.meclis?.hubExcludes).not.toContain("almanya");
    expect(hubMatches("meclis", "Meclis heyeti Almanya'da: milletvekilleri Berlin'de temaslarda bulundu")).toBe(true);
  });

  it("'meclis baskan' is no longer a cue: the matched phrase cannot satisfy its own requirement", () => {
    expect(RISING_HUB_SPECS.meclis?.requires).not.toContain("meclis baskan");
    expect(hubMatches("meclis", "Meclis Başkanı açıklama yaptı")).toBe(false);
    expect(hubMatches("meclis", "Gaziantep Ticaret Borsası Meclis Başkanı mesaj yayımladı")).toBe(false);
    // 'kurtulmus' still carries the Speaker, and 'komisyon' the committee.
    expect(hubMatches("meclis", "Meclis Başkanı Kurtulmuş yeni yasama yılını açtı")).toBe(true);
    expect(hubMatches("meclis", "Meclis Başkanlığı Divanı komisyon üyelerini belirledi")).toBe(true);
  });

  it("the new vetoes are hub-only: excludes stays the list migration 163 mirrors, and the rollup tokens do not move", () => {
    const spec = RISING_HUB_SPECS.meclis!;
    expect(spec.hubExcludes).toEqual([
      "parti meclisi",
      "kktc",
      "cumhuriyet meclisi",
      "hirvatistan",
      "federal meclis",
      "bundestag",
      "ibb meclis",
      "danisma meclis",
      "kadin meclis",
      "baris anneleri",
      "isig meclis",
    ]);
    for (const ex of spec.hubExcludes!) expect(spec.excludes, ex).not.toContain(ex);
    // The hub-only list sits in a lookahead of its own, right behind the shared excludes and before the cues.
    const [guarded] = entityHubPatterns(entityByKey("meclis")!);
    expect(guarded!.startsWith(guardPrefix(spec.excludes!, spec.requires, spec.hubExcludes))).toBe(true);
    expect(guarded!.startsWith(guardPrefix(spec.excludes!, spec.requires))).toBe(false);
    expect(entityByKey("meclis")!.tokens).toEqual(["meclis", "tbmm"]);
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
  const GUARD = `${esc("^")}(?:${EXCL}(?:${EXCL})?(?:${REQ})?|${REQ})${esc("[\\s\\S]*")}`;
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
      ["meclis with a cue, hub-only exclude at the end", fit("komisyon meclis ").slice(0, N - 14) + " parti meclisi"],
      ["hub-only excludes repeated, meclis at the end", fit("kktc ibb meclis ").slice(0, N - 7) + " meclis"],
      ["dolar behind amounts", fit("100 dolar milyar dolar ")],
      ["digits", "1".repeat(N)],
      ["erdogan blocked on every line", fit("fatih erdogan ")],
      ["erdogan repeated, family name at the end", fit("erdogan ").slice(0, N - 14) + " emine erdogan"],
      ["family name repeated, trusted form at the end", fit("emine erdogan ").slice(0, N - 22) + " cumhurbaskani erdogan"],
      ["imamoglu blocked on every line", fit("adana imamoglu ")],
      ["imamoglu repeated, district at the end", fit("imamoglu ").slice(0, N - 14) + " imamoglu ilce"],
      ["milli egitim repeated, foreign ministry at the end", fit("milli egitim bakani ").slice(0, N - 18) + " kktc milli egitim"],
      ["milli savunma repeated, no foreign cue", fit("milli savunma bakanligi ")],
    ];
    const keys = ["disisleri", "borsa", "meclis", "aym", "tcmb", "dolar", "erdogan", "imamoglu", "meb", "msb"];

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
      "meb",
      "msb",
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
    ).toEqual([
      "akp",
      "aym",
      "borsa",
      "erdogan",
      "fidan",
      "imamoglu",
      "meb",
      "meclis",
      "msb",
      "simsek",
      "tcmb",
      "yrp",
      "zelenski",
    ]);
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

  it("every hub-only exclude is a folded ASCII phrase, so no metacharacter reaches the RPC", () => {
    for (const [key, spec] of specs) {
      for (const ex of spec.hubExcludes ?? []) {
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
      if (spec.excludes === undefined && spec.requires === undefined && spec.hubExcludes === undefined) continue;
      const e = entityByKey(key)!;
      const guarded = entityHubPatterns(e).filter((p) => p.startsWith("^(?"));
      expect(guarded.length, key).toBeGreaterThan(0);
      for (const p of guarded) {
        expect(p.startsWith(guardPrefix(spec.excludes ?? [], spec.requires, spec.hubExcludes)), key).toBe(true);
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

  it("excludes is curated on exactly aym, borsa, erdogan, imamoglu, meb, meclis, msb and tcmb; quantityGuard on dolar only", () => {
    expect(
      specs
        .filter(([, s]) => s.excludes !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["aym", "borsa", "erdogan", "imamoglu", "meb", "meclis", "msb", "tcmb"]);
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

  it("notAfter is curated on exactly disisleri, erdogan and imamoglu, as folded single ASCII words", () => {
    expect(
      specs
        .filter(([, s]) => s.notAfter !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["disisleri", "erdogan", "imamoglu"]);
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
    // h96-entityhubs-1 curates the hub aliases of these five; the rollup tokens (migration 112's emap) stay.
    expect(tokens("simsek")).toEqual(["mehmet simsek"]);
    expect(tokens("fidan")).toEqual(["hakan fidan"]);
    expect(tokens("meb")).toEqual(["meb"]);
    expect(tokens("msb")).toEqual(["msb"]);
    expect(tokens("imamoglu")).toEqual(["imamoglu"]);
  });

  it("hubExcludes (vetoes that /trends does not mirror) is curated on exactly meclis", () => {
    expect(
      specs
        .filter(([, s]) => s.hubExcludes !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["meclis"]);
  });

  it("requires is curated on exactly meclis and tcmb", () => {
    expect(
      specs
        .filter(([, s]) => s.requires !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["meclis", "tcmb"]);
  });

  // h61-emptystates-2. The cues are folded ASCII (the generic requires test checks that); the list is the
  // Turkish monetary-policy vocabulary: the bank's name, its governor, the policy committee and rate,
  // inflation, reserves, the lira, FX, the old FX-protected deposit, the market survey, the parliament
  // week and the repo rate. 'repo' is last: the generic form-versus-cue test appends the last cue.
  it("the tcmb cues: the bank's own vocabulary, none of them a bare foreign-country word", () => {
    expect(RISING_HUB_SPECS.tcmb?.requires).toEqual([
      "tcmb",
      "karahan",
      "ppk",
      "para politika",
      "faiz",
      "enflasyon",
      "rezerv",
      "turk lira",
      "doviz",
      "kur korumal",
      "turkiye cumhuriyet merkez",
      "piyasa katilimci",
      "tbmm",
      "repo",
    ]);
  });

  it("tcmb keeps what /trends mirrors (migration 163): the ten foreign excludes, the trusted TCMB, the aliases and the rollup tokens", () => {
    expect(RISING_HUB_SPECS.tcmb?.excludes).toEqual([
      "avrupa merkez",
      "ecb",
      "fed",
      "abd merkez",
      "amerikan merkez",
      "israil merkez",
      "ingiltere merkez",
      "japonya merkez",
      "rusya merkez",
      "cin merkez",
    ]);
    expect(RISING_HUB_SPECS.tcmb?.trusted).toEqual(["TCMB"]);
    expect(RISING_HUB_SPECS.tcmb?.aliases).toEqual(["Merkez Bankası", "TCMB"]);
    expect(entityByKey("tcmb")!.tokens).toEqual(["tcmb", "merkez bankasi"]);
    // Two patterns: the guarded bare form, then the bare trusted one. No cue is ever a trusted spelling.
    const patterns = entityHubPatterns(entityByKey("tcmb")!);
    expect(patterns).toHaveLength(2);
    expect(patterns[0]!.startsWith("^(?![\\s\\S]*(?:\\mavrupa\\s+merkez")).toBe(true);
    expect(patterns[0]!).toContain("))(?=[\\s\\S]*(?:\\mtcmb|");
    expect(patterns[1]).toBe("\\mtcmb\\M");
  });

  it("the meclis cues: TBMM vocabulary, the parliamentary work, and the party names", () => {
    expect(RISING_HUB_SPECS.meclis?.requires).toEqual([
      "tbmm",
      "genel kurul",
      "milletvekil",
      "kanun teklif",
      "yasa teklif",
      "grup toplanti",
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
