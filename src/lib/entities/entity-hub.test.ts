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
    expect(entityHubForms(entityByKey("erdogan")!)).toEqual(["Erdoğan"]);
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
    borsa: ["\\mborsa", "\\mbist"],
    erdogan: ["\\merdogan\\M"],
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

  it("cin: 'Cinayet' is out, \"Çin'in\" is in", () => {
    expect(hubMatches("cin", "Cinayet davası")).toBe(false);
    expect(hubMatches("cin", "Çin'in")).toBe(true);
  });

  it("erdogan: the apostrophe suffix still matches the closing boundary", () => {
    expect(hubMatches("erdogan", "Erdoğan'ın")).toBe(true);
    expect(hubMatches("erdogan", "Cumhurbaşkanı ERDOĞAN açıkladı")).toBe(true);
    expect(hubMatches("erdogan", "Erdoğanlar köyü")).toBe(false);
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

  it("borsa searches 'borsa' and 'bist' but never the generic word 'istanbul'", () => {
    const q = entityHubQueries(entityByKey("borsa")!);
    expect(q).toContain("borsa");
    expect(q).toContain("bist");
    for (const s of q) expect(s).not.toContain("istanbul");
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
  const PLAIN = `${esc("\\m")}${WORD}(?:${esc("\\s")}\\+${WORD})*(?:${esc("\\M")})?`;
  const QUANT = `${esc("\\m")}${esc(QUANTITY_GUARD)}${WORD}(?:${esc("\\M")})?`;
  const ALTS = `${PLAIN}(?:${esc("|")}${PLAIN})*`;
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
    ]) {
      expect(bad, bad).not.toMatch(GRAMMAR);
    }
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
    expect(entityHubSpec(entityByKey("erdogan")!)).toEqual({});
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
    ).toEqual(["akp", "aym", "borsa", "meclis", "tcmb", "yrp", "zelenski"]);
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

  it("excludes is curated on exactly aym, tcmb and meclis; quantityGuard on dolar only", () => {
    expect(
      specs
        .filter(([, s]) => s.excludes !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["aym", "meclis", "tcmb"]);
    expect(
      specs
        .filter(([, s]) => s.quantityGuard !== undefined)
        .map(([k]) => k)
        .sort(),
    ).toEqual(["dolar"]);
    expect(RISING_HUB_SPECS.dolar?.quantityGuard).toBe(true);
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

  it("curated trusted sets: AYM, TCMB, and the two unambiguous parliament names", () => {
    expect(RISING_HUB_SPECS.aym?.trusted).toEqual(["AYM"]);
    expect(RISING_HUB_SPECS.tcmb?.trusted).toEqual(["TCMB"]);
    expect(RISING_HUB_SPECS.meclis?.trusted).toEqual(["TBMM", "Büyük Millet Meclisi"]);
  });
});
