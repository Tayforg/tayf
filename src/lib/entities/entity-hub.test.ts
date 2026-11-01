import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_ORDER } from "@/lib/bias/config";
import { turkishQueryVariants } from "@/lib/clusters/turkish-query";
import { RISING_ENTITIES, RISING_HUB_SPECS } from "@/lib/trends/rising-entities";

import {
  ENTITY_HUB_LIMIT,
  ENTITY_HUB_MAX_TERMS,
  ENTITY_HUB_MIN_INDEXABLE,
  ENTITY_HUB_WINDOW_DAYS,
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
    dolar: ["\\mdolar"],
    akp: ["\\mak\\s+parti", "\\makp\\M"],
    zelenski: ["\\mzelenski\\M", "\\mzelenskiy\\M", "\\mzelensky\\M", "\\mzelenskyy\\M"],
    borsa: ["\\mborsa", "\\mbist"],
    erdogan: ["\\merdogan\\M"],
    chp: ["\\mchp\\M"],
    cin: ["\\mcin\\M"],
    "asgari-ucret": ["\\masgari\\s+ucret"],
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
  const SHAPE = /^\\m[a-z0-9]+(?:\\s\+[a-z0-9]+)*(?:\\M)?$/;

  it("covers all 62 entities", () => {
    expect(RISING_ENTITIES).toHaveLength(62);
  });

  it("has 1..12 queries and 1..12 well-shaped patterns", () => {
    for (const e of RISING_ENTITIES) {
      const q = entityHubQueries(e);
      const p = entityHubPatterns(e);
      expect(q.length, `${e.key} queries`).toBeGreaterThanOrEqual(1);
      expect(q.length, `${e.key} queries`).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      expect(p.length, `${e.key} patterns`).toBeGreaterThanOrEqual(1);
      expect(p.length, `${e.key} patterns`).toBeLessThanOrEqual(ENTITY_HUB_MAX_TERMS);
      for (const pat of p) expect(pat, `${e.key} pattern ${pat}`).toMatch(SHAPE);
    }
  });

  it("every form, and the label, matches one of the entity's own patterns", () => {
    for (const e of RISING_ENTITIES) {
      for (const form of [...entityHubForms(e), e.label]) {
        expect(hubMatches(e.key, form), `${e.key}: ${form}`).toBe(true);
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
    for (const e of RISING_ENTITIES) {
      for (const p of entityHubPatterns(e)) {
        if (p.includes("\\s+")) continue;
        expect(p.endsWith("\\M"), `${e.key} ${p}`).toBe(entityHubSpec(e).hubMatch !== "prefix");
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
    expect(withInflections.map((e) => e.key)).toEqual(["borsa"]);
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
