import { readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { ZONE_META } from "@/lib/bias/config";
import type { MediaDnaZone } from "@/types";

import {
  ZONE_BOLGE_ABLATIVE,
  ZONE_BOLGE_DATIVE,
  ZONE_BOLGE_LOCATIVE_ATTR,
  ZONE_KANAT,
  ZONE_KANAT_GENITIVE,
  ZONE_KAYNAKLAR,
} from "./zone-phrases";

// h138-suffix-1: "Bağımsız" is an adjective, so it is never glued to a
// possessive noun ("Bağımsız bölgesine", "Bağımsız kanadı", "Bağımsız
// kaynakları" are wrong). Each phrase below is one literal string per zone.

const ZONES: readonly MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];

const MAPS = {
  ZONE_BOLGE_DATIVE,
  ZONE_BOLGE_ABLATIVE,
  ZONE_BOLGE_LOCATIVE_ATTR,
  ZONE_KANAT,
  ZONE_KANAT_GENITIVE,
  ZONE_KAYNAKLAR,
} as const;

describe("ZONE_BOLGE_DATIVE", () => {
  it("has the three exact dative phrases", () => {
    expect(ZONE_BOLGE_DATIVE.iktidar).toBe("İktidar bölgesine");
    expect(ZONE_BOLGE_DATIVE.bagimsiz).toBe("Bağımsız bölgeye");
    expect(ZONE_BOLGE_DATIVE.muhalefet).toBe("Muhalefet bölgesine");
  });
});

describe("ZONE_BOLGE_ABLATIVE", () => {
  it("has the three exact ablative phrases", () => {
    expect(ZONE_BOLGE_ABLATIVE.iktidar).toBe("İktidar bölgesinden");
    expect(ZONE_BOLGE_ABLATIVE.bagimsiz).toBe("Bağımsız bölgeden");
    expect(ZONE_BOLGE_ABLATIVE.muhalefet).toBe("Muhalefet bölgesinden");
  });
});

describe("ZONE_BOLGE_LOCATIVE_ATTR", () => {
  it("has the three exact locative-attributive phrases", () => {
    expect(ZONE_BOLGE_LOCATIVE_ATTR.iktidar).toBe("İktidar bölgesindeki");
    expect(ZONE_BOLGE_LOCATIVE_ATTR.bagimsiz).toBe("Bağımsız bölgedeki");
    expect(ZONE_BOLGE_LOCATIVE_ATTR.muhalefet).toBe("Muhalefet bölgesindeki");
  });
});

describe("ZONE_KANAT", () => {
  it("has the three exact wing phrases", () => {
    expect(ZONE_KANAT.iktidar).toBe("İktidar kanadı");
    expect(ZONE_KANAT.bagimsiz).toBe("Bağımsız kanat");
    expect(ZONE_KANAT.muhalefet).toBe("Muhalefet kanadı");
  });
});

describe("ZONE_KANAT_GENITIVE", () => {
  it("has the three exact genitive wing phrases", () => {
    expect(ZONE_KANAT_GENITIVE.iktidar).toBe("İktidar kanadının");
    expect(ZONE_KANAT_GENITIVE.bagimsiz).toBe("Bağımsız kanadın");
    expect(ZONE_KANAT_GENITIVE.muhalefet).toBe("Muhalefet kanadının");
  });
});

describe("ZONE_KAYNAKLAR", () => {
  it("has the three exact plural-sources phrases", () => {
    expect(ZONE_KAYNAKLAR.iktidar).toBe("İktidar kaynakları");
    expect(ZONE_KAYNAKLAR.bagimsiz).toBe("Bağımsız kaynaklar");
    expect(ZONE_KAYNAKLAR.muhalefet).toBe("Muhalefet kaynakları");
  });
});

describe("every phrase map", () => {
  it.each(Object.entries(MAPS))("%s covers exactly the three zones", (_name, map) => {
    expect(Object.keys(map).sort()).toEqual([...ZONES].sort());
    for (const zone of ZONES) expect(map[zone]).toEqual(expect.any(String));
  });

  it.each(Object.entries(MAPS))("%s starts with the zone's ZONE_META label", (_name, map) => {
    for (const zone of ZONES) {
      expect(map[zone].startsWith(`${ZONE_META[zone].label} `)).toBe(true);
    }
  });

  it("never glues a possessive suffix to the adjective Bağımsız", () => {
    const possessive = new Set([
      "bölgesine",
      "bölgesinden",
      "bölgesindeki",
      "kanadı",
      "kanadının",
      "kaynakları",
    ]);
    for (const map of Object.values(MAPS)) {
      for (const word of map.bagimsiz.split(" ")) expect(possessive.has(word)).toBe(false);
    }
  });

  it("keeps iktidar and muhalefet byte-identical to the old label + suffix strings", () => {
    const legacy = {
      ZONE_BOLGE_DATIVE: "bölgesine",
      ZONE_BOLGE_ABLATIVE: "bölgesinden",
      ZONE_BOLGE_LOCATIVE_ATTR: "bölgesindeki",
      ZONE_KANAT: "kanadı",
      ZONE_KANAT_GENITIVE: "kanadının",
      ZONE_KAYNAKLAR: "kaynakları",
    } as const;
    for (const [name, suffix] of Object.entries(legacy) as Array<[keyof typeof MAPS, string]>) {
      for (const zone of ["iktidar", "muhalefet"] as const) {
        expect(MAPS[name][zone]).toBe(`${ZONE_META[zone].label} ${suffix}`);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Guard: no non-test source glues a zone label (or a zone-name variable) to a
// possessive noun. Reading every src/**/*.ts(x) keeps a new call site from
// bringing "Bağımsız bölgesine" back.
//
// Both patterns are linear: one bounded character class, then a fixed
// alternation of literals, then one run of whitespace and another literal
// alternation. There is no quantifier inside a quantifier.
// ---------------------------------------------------------------------------

const LABEL_GLUE =
  /\$\{[^}]*(?:label|Label|ZONE_LABEL_TR\[[^\]]*\])\}\s+(?:bölgesi|kanad|kaynaklar)/u;
// The alert RSS names the zone in a variable called `zone`, which LABEL_GLUE
// does not see.
const ZONE_VAR_GLUE = /\$\{[^}]*(?:zone|Zone)\}\s+(?:bölgesi|kanad|kaynaklar)/u;

// Pole-only: it is only ever reached with "iktidar" or "muhalefet", both nouns,
// so "${zoneLabel} kaynaklarından" is correct there and "Bağımsız" never takes
// that path.
const ALLOWLIST: ReadonlySet<string> = new Set(["components/story/read-across-spectrum.tsx"]);

const SRC_ROOT = resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__") continue;
      out.push(...sourceFiles(full));
    } else if (/\.tsx?$/u.test(entry.name) && !/\.(?:test|spec)\.tsx?$/u.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("guard: no zone label glued to a possessive noun", () => {
  it("the patterns catch the shapes they were written for", () => {
    expect(LABEL_GLUE.test("`${ZONE_META[current.zone].label} bölgesine koyuyor`")).toBe(true);
    expect(LABEL_GLUE.test("`${silentLabel} kanadı sessiz kaldı`")).toBe(true);
    expect(LABEL_GLUE.test("`${zoneLabel} kaynakları (%${pct})`")).toBe(true);
    expect(LABEL_GLUE.test("`${ZONE_LABEL_TR[zone]} kanadının feed sağlığı`")).toBe(true);
    expect(ZONE_VAR_GLUE.test("` Kaynakların en az %${pct}'i ${zone} bölgesinden.`")).toBe(true);
  });

  it("the patterns leave the whole-phrase maps and plain labels alone", () => {
    expect(LABEL_GLUE.test("`${ZONE_BOLGE_DATIVE[zone]} koyuyor`")).toBe(false);
    expect(LABEL_GLUE.test("`${ZONE_KANAT[z]} haberi verdi`")).toBe(false);
    expect(LABEL_GLUE.test("`${ZONE_META[zone].label} ağırlıklı`")).toBe(false);
    expect(ZONE_VAR_GLUE.test("`${ZONE_BOLGE_ABLATIVE[zone]}.`")).toBe(false);
  });

  it("finds the source files it is meant to read", () => {
    const files = sourceFiles(SRC_ROOT).map((f) => relative(SRC_ROOT, f).split(sep).join("/"));
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("lib/bias/zone-phrases.ts");
    expect(files).toContain("components/story/read-across-spectrum.tsx");
    expect(files.some((f) => /\.test\.tsx?$/u.test(f))).toBe(false);
  });

  it("has zero hits outside the pole-only allowlist", () => {
    const hits: string[] = [];
    for (const file of sourceFiles(SRC_ROOT)) {
      const rel = relative(SRC_ROOT, file).split(sep).join("/");
      if (ALLOWLIST.has(rel)) continue;
      const text = readFileSync(file, "utf8");
      for (const pattern of [LABEL_GLUE, ZONE_VAR_GLUE]) {
        for (const m of text.matchAll(new RegExp(pattern.source, "gu"))) {
          hits.push(`${rel}:${text.slice(0, m.index).split("\n").length}: ${m[0]}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("the allowlisted file still holds the pole-only line the allowlist is for", () => {
    const src = readFileSync(join(SRC_ROOT, "components/story/read-across-spectrum.tsx"), "utf8");
    expect(src).toMatch(/\$\{zoneLabel\} kaynaklarından/u);
  });
});
