import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { crossZoneTwinKeys, twinKey as twinKeyOf, type TwinKeyVersion } from "./title-twin";
import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import type { MediaDnaZone } from "@/types";

const member = (title: string, zone: MediaDnaZone) => ({ title, zone });

const VERSIONS: readonly TwinKeyVersion[] = [1, 2];

// Every vector below must hold for BOTH rules: version 1 is frozen (the sets /oyun
// served before the lead-in fix recompute from it), version 2 only widens what a
// separator after the prefix may be.
describe.each(VERSIONS)("twinKey version %i: the shared vectors", (version) => {
  const twinKey = (title: string) => twinKeyOf(title, version);

  it("gives the same key for a title that differs only in case, apostrophe and final punctuation (Turkish İ/I)", () => {
    // Without the tr-TR lower-casing, "CUMHURBAŞKANI" would fold to
    // "cumhurbaşkani" (dotted i) and never meet the "ı" of the lower-case form.
    expect(twinKey("Cumhurbaşkanı Erdoğan Azerbaycan’a gitti")).toBe(
      twinKey("CUMHURBAŞKANI ERDOĞAN AZERBAYCAN'A GİTTİ."),
    );
  });

  it("keeps the diacritics and drops everything that is not a letter or a number", () => {
    expect(twinKey("Çiğ köfte: 3 kişi 'gözaltına' alındı!")).toBe("çiğköfte3kişigözaltınaalındı");
  });

  it("strips one leading 'SON DAKİKA' prefix, whichever way the I is typed", () => {
    expect(twinKey("SON DAKİKA: Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKIKA: Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("Son Dakika | Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("son dakika - Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKİKA – Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKİKA — Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("SON DAKİKA! Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
  });

  it("strips a leading 'FLAŞ' prefix, with or without the cedilla", () => {
    expect(twinKey("FLAŞ: Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("Flaş! Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
    expect(twinKey("FLAS | Meclis tatile girdi")).toBe(twinKey("Meclis tatile girdi"));
  });

  it("strips only ONE prefix and only at the start", () => {
    expect(twinKey("SON DAKİKA: FLAŞ: X haberi")).toBe("flaşxhaberi");
    expect(twinKey("Meclis'ten SON DAKİKA: kararı")).toBe("meclistensondakikakararı");
  });

  it("does not treat a longer word that starts like the prefix as the prefix", () => {
    expect(twinKey("Son dakikada gelen haber")).toBe("sondakikadagelenhaber");
    expect(twinKey("Flaşlar patladı")).toBe("flaşlarpatladı");
    // No separator at all: not a prefix either.
    expect(twinKey("SONDAKİKA haberi")).toBe("sondakikahaberi");
  });

  it("returns '' for an empty or blank title, a title of only punctuation, and a bare prefix", () => {
    expect(twinKey("")).toBe("");
    expect(twinKey("   ")).toBe("");
    expect(twinKey("!!! … ??? —")).toBe("");
    expect(twinKey("SON DAKİKA:")).toBe("");
    expect(twinKey("FLAŞ! ")).toBe("");
  });

  it("keeps digits and treats emoji as separators", () => {
    expect(twinKey("🔴 Dolar 34,50 oldu 🔴")).toBe("dolar3450oldu");
    expect(twinKey("TBMM'de 2. tur oylaması")).toBe("tbmmde2turoylaması");
  });

  it("is not fooled by SQL-looking or markup-looking text", () => {
    expect(twinKey("'; DROP TABLE articles; --")).toBe("droptablearticles");
    expect(twinKey("<b>Meclis</b> kapandı")).toBe("bmeclisbkapandı");
  });

  it("is linear on a very long title (CPU time over a size ladder, not a wall-clock budget)", () => {
    expect(twinKey(rep("halk ", "", "tv")(250_000)).endsWith("tv")).toBe(true);
    expectLinear(rep("halk ", "", "tv"), (title) => twinKey(title), { n: 250_000, ceilingMs: 2_000 });
    // The prefix strip is anchored: a long run of separators after the prefix is linear too.
    expectLinear(rep(" ", "SON DAKİKA:"), (title) => twinKey(title), { n: 250_000, ceilingMs: 2_000 });
  });
});

// The lead-in the first twin gate (#248) missed: "Son dakika... X", "SON DAKİKA… X".
const X = "Gazeteci İsmail Saymaz'ın ev hapsi kaldırıldı";

describe("twinKey version 2: any run of non-letters after the breaking-news prefix is a separator", () => {
  it.each([
    "Son dakika... " + X,
    "SON DAKİKA… " + X,
    "Son dakika! " + X,
    "Son Dakika - " + X,
    "SON DAKİKA: " + X,
    "Flaş... " + X,
  ])("%j has the key of the plain text", (title) => {
    expect(twinKeyOf(title, 2)).toBe(twinKeyOf(X, 2));
    expect(twinKeyOf(title)).toBe(twinKeyOf(X));
  });

  it.each([
    "SON DAKİKA... ",
    "Son dakika.. ",
    "SON DAKİKA …",
    "Son dakika!!! ",
    "SON DAKİKA | ",
    "Son dakika – ",
    "Son dakika — ",
    "SON DAKİKA ‒ ",
    "Son dakika:: ",
    "Son dakika\" ",
    "Son dakika 🔴 ",
    "FLAŞ… ",
    "FLAŞ!.. ",
  ])("strips the lead-in %j", (leadIn) => {
    expect(twinKeyOf(leadIn + X, 2)).toBe(twinKeyOf(X, 2));
  });

  it("a digit after the separators starts the text, a bare prefix is empty", () => {
    expect(twinKeyOf("Son dakika... 3 yaralı", 2)).toBe("3yaralı");
    expect(twinKeyOf("SON DAKİKA…", 2)).toBe("");
    expect(twinKeyOf("Flaş...", 2)).toBe("");
  });

  it("still needs a separator: a longer word that starts like the prefix keeps its first word", () => {
    expect(twinKeyOf("Son dakikada gol", 2).startsWith("sondakikada")).toBe(true);
    expect(twinKeyOf("Son dakikada gol", 2)).toBe("sondakikadagol");
    expect(twinKeyOf("Flaşlar patladı", 2).startsWith("flaşlar")).toBe(true);
    expect(twinKeyOf("Flaşlar patladı", 2)).toBe("flaşlarpatladı");
    expect(twinKeyOf("Son dakikada ... gol", 2)).toBe("sondakikadagol");
    expect(twinKeyOf("SONDAKİKA... haberi", 2)).toBe("sondakikahaberi");
  });

  it("strips only ONE prefix, and only at the start", () => {
    expect(twinKeyOf("SON DAKİKA... FLAŞ... X haberi", 2)).toBe("flaşxhaberi");
    expect(twinKeyOf("Meclis'ten SON DAKİKA... kararı", 2)).toBe("meclistensondakikakararı");
  });

  it("is the default version", () => {
    expect(twinKeyOf("Son dakika... " + X)).toBe(twinKeyOf(X));
    expect(twinKeyOf("SON DAKİKA… " + X)).toBe(twinKeyOf(X, 2));
  });

  it("is linear on a long run of separators after the prefix (any separator character)", () => {
    for (const unit of [".", "…", " ", "🔴", ".…!:- "]) {
      expectLinear(rep(unit, "Son dakika"), (title) => twinKeyOf(title, 2), { n: 250_000, ceilingMs: 2_000 });
      expectLinear(rep(unit, "SON DAKİKA", "x"), (title) => twinKeyOf(title, 2), { n: 250_000, ceilingMs: 2_000 });
    }
    // A prefix with no separator, followed by a long word, fails the match at once.
    expectLinear(rep("a", "Son dakika"), (title) => twinKeyOf(title, 2), { n: 250_000, ceilingMs: 2_000 });
  });
});

describe("twinKey version 1: the frozen rule behind every set already served", () => {
  it("does not see through 'Son dakika...' or the '…' lead-in (the gap version 2 closes)", () => {
    expect(twinKeyOf("Son dakika... " + X, 1)).not.toBe(twinKeyOf(X, 1));
    expect(twinKeyOf("Son dakika... " + X, 1)).toBe("sondakikagazeteciismailsaymazınevhapsikaldırıldı");
    expect(twinKeyOf("SON DAKİKA… Mustafa Sarıgül", 1)).toBe("sondakikamustafasarıgül");
    expect(twinKeyOf("Flaş... " + X, 1)).not.toBe(twinKeyOf(X, 1));
  });

  it("still strips the six separators it always did", () => {
    for (const leadIn of ["Son dakika! ", "Son Dakika - ", "SON DAKİKA: ", "SON DAKİKA | ", "SON DAKİKA – ", "SON DAKİKA — ", "Flaş: "]) {
      expect(twinKeyOf(leadIn + X, 1), leadIn).toBe(twinKeyOf(X, 1));
    }
  });

  it("keeps the same key as version 2 for a title without a lead-in", () => {
    for (const title of [X, "Çiğ köfte: 3 kişi 'gözaltına' alındı!", "🔴 Dolar 34,50 oldu 🔴", "", "!!!"]) {
      expect(twinKeyOf(title, 1)).toBe(twinKeyOf(title, 2));
    }
  });
});

describe("crossZoneTwinKeys", () => {
  const twinKey = (title: string) => twinKeyOf(title);

  it("returns no key when one zone carries a text twice", () => {
    const keys = crossZoneTwinKeys([
      member("Meclis tatile girdi", "iktidar"),
      member("MECLİS TATİLE GİRDİ.", "iktidar"),
    ]);
    expect(keys.size).toBe(0);
  });

  it("returns the key when two distinct zones carry the same text", () => {
    const keys = crossZoneTwinKeys([
      member("Meclis tatile girdi", "iktidar"),
      member("MECLİS TATİLE GİRDİ.", "muhalefet"),
    ]);
    expect([...keys]).toEqual([twinKey("Meclis tatile girdi")]);
  });

  it("returns one key per twinned text and leaves a text of one zone out", () => {
    const keys = crossZoneTwinKeys([
      member("Birinci haber metni", "iktidar"),
      member("Birinci haber metni", "bagimsiz"),
      member("İkinci haber metni", "bagimsiz"),
      member("İkinci haber metni", "muhalefet"),
      member("Üçüncü haber metni", "muhalefet"),
    ]);
    expect(keys).toEqual(new Set([twinKey("Birinci haber metni"), twinKey("İkinci haber metni")]));
  });

  it("counts three zones as one key", () => {
    const keys = crossZoneTwinKeys([
      member("Aynı metin", "iktidar"),
      member("Aynı metin", "bagimsiz"),
      member("Aynı metin", "muhalefet"),
    ]);
    expect(keys.size).toBe(1);
  });

  it("sees through a breaking-news prefix", () => {
    const keys = crossZoneTwinKeys([
      member("SON DAKİKA: Meclis tatile girdi", "iktidar"),
      member("Meclis tatile girdi", "bagimsiz"),
    ]);
    expect(keys.has(twinKey("Meclis tatile girdi"))).toBe(true);
  });

  it("never adds the empty key, even when two zones both carry an empty-looking title", () => {
    const keys = crossZoneTwinKeys([
      member("", "iktidar"),
      member("   ", "muhalefet"),
      member("SON DAKİKA:", "bagimsiz"),
      member("!!!", "iktidar"),
    ]);
    expect(keys.has("")).toBe(false);
    expect(keys.size).toBe(0);
  });

  it("returns an empty set for no members", () => {
    expect(crossZoneTwinKeys([]).size).toBe(0);
  });

  it("accepts any iterable (a generator, a Set)", () => {
    function* members() {
      yield member("Aynı metin burada", "iktidar");
      yield member("Aynı metin burada", "muhalefet");
    }
    expect(crossZoneTwinKeys(members()).size).toBe(1);
    expect(crossZoneTwinKeys(new Set([member("Tek", "iktidar")])).size).toBe(0);
  });

  it("handles 10,000 members: every twinned text is found, and the cost grows linearly", () => {
    const zones: MediaDnaZone[] = ["iktidar", "bagimsiz", "muhalefet"];
    // i and i + half share a text but sit in zones (i % 3) and ((i + half) % 3);
    // half = 5000 gives 5000 % 3 = 2, so they always differ.
    const members = (n: number) =>
      Array.from({ length: n }, (_, i) =>
        member(`Haber başlığı numara ${i % (n / 2)}`, zones[i % 3] as MediaDnaZone),
      );

    expect(crossZoneTwinKeys(members(10_000)).size).toBe(5_000);
    expectLinear(members, (list) => crossZoneTwinKeys(list), { n: 10_000, ceilingMs: 4_000 });
  });
});

describe("crossZoneTwinKeys versions", () => {
  it("version 2 (the default) flags a text one zone ran behind 'Son dakika...' and another ran plain", () => {
    const members = [
      member("Son dakika... " + X, "muhalefet"),
      member(X, "bagimsiz"),
    ];
    expect([...crossZoneTwinKeys(members, 2)]).toEqual([twinKeyOf(X, 2)]);
    expect([...crossZoneTwinKeys(members)]).toEqual([twinKeyOf(X, 2)]);
  });

  it("version 2 flags the '…' lead-in against a plain copy, whichever zone carries which", () => {
    const keys = crossZoneTwinKeys([
      member("SON DAKİKA… " + X, "iktidar"),
      member(X, "muhalefet"),
    ]);
    expect(keys.size).toBe(1);
  });

  it("version 1 does not flag that pair (the old behaviour is locked)", () => {
    const keys = crossZoneTwinKeys(
      [member("Son dakika... " + X, "muhalefet"), member(X, "bagimsiz")],
      1,
    );
    expect(keys.size).toBe(0);
  });

  it("version 1 still flags the lead-ins it always saw", () => {
    const keys = crossZoneTwinKeys(
      [member("SON DAKİKA: " + X, "muhalefet"), member(X, "bagimsiz")],
      1,
    );
    expect([...keys]).toEqual([twinKeyOf(X, 1)]);
  });

  it("two lead-in forms of one text in two zones are twins under version 2 only", () => {
    const members = [member("Son dakika... " + X, "iktidar"), member("SON DAKİKA! " + X, "muhalefet")];
    expect(crossZoneTwinKeys(members, 2).size).toBe(1);
    expect(crossZoneTwinKeys(members, 1).size).toBe(0);
  });

  it("one zone running both forms is still no twin", () => {
    const keys = crossZoneTwinKeys([member("Son dakika... " + X, "iktidar"), member(X, "iktidar")]);
    expect(keys.size).toBe(0);
  });
});

describe("title-twin source guard", () => {
  const source = readFileSync(resolve(__dirname, "title-twin.ts"), "utf8");

  // Like outlet-leak.ts: nothing in here may pull a server module into a bundle.
  it("imports types only", () => {
    for (const line of source.split("\n")) {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("import ")) {
        expect(trimmed.startsWith("import type "), line).toBe(true);
      }
    }
    expect(source).not.toMatch(/\brequire\(|\bimport\(/);
  });

  // The prefix is one anchored literal followed by ONE character-class run: no
  // nested quantifier, no alternation inside a repeat (CodeQL js/redos).
  it("keeps both prefix regexes anchored with a single, un-nested quantifier", () => {
    const prefixes = [...source.matchAll(/^const BREAKING_PREFIX_V\d = (\/.*\/u?);$/gm)];
    expect(prefixes).toHaveLength(2);
    for (const [, literal] of prefixes) {
      expect(literal).toMatch(/^\/\^\(\?:son dakika\|flas\)\[[^\]]+\]\+\/u?$/);
    }
  });
});
