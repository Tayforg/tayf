import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  headlineTokens,
  titleTokens,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import {
  HEADLINE_GENERIC_PREFIXES,
  HEADLINE_TOKEN_MIN_LEN,
} from "../../../supabase/functions/_shared/cluster/constants.ts";

// These cover the cluster module's own titleTokens / headlineTokens, not the
// ingest-side helper of the same name (tests/functions/_shared/title-jaccard.test.ts
// tests _shared/rss/title-jaccard.ts).

describe("titleTokens: digit tokens are excluded from candidate generation", () => {
  it("drops all-digit tokens such as years and counts", () => {
    // Regression: the guard used to be /^d+$/ (the letter d), so '2026' and
    // '1500' were indexed as candidate tokens and glued unrelated stories
    // sharing a year.
    const tokens = titleTokens("2026 bütçesi 1500 kişi", 4);
    for (const t of tokens) expect(t).not.toMatch(/^\d+$/);
    expect(tokens.has("butcesi")).toBe(true);
    expect(tokens.has("kisi")).toBe(true);
    expect(tokens.size).toBe(2);
  });

  it("keeps alphanumeric tokens that merely contain digits", () => {
    expect([...titleTokens("A400M uçakları 2026", 4)]).toContain("a400m");
  });

  it("returns an empty set for null / empty titles", () => {
    expect(titleTokens(null).size).toBe(0);
    expect(titleTokens(undefined).size).toBe(0);
    expect(titleTokens("").size).toBe(0);
  });
});

describe("headlineTokens", () => {
  it("collects the numerals of the Bakirkoy headline as {'39'}", () => {
    const h = headlineTokens("Bakırköy Belediyesi soruşturmasında 39 kişi tutuklandı!");
    expect(h.numbers).toEqual(new Set(["39"]));
    // Numerals live in tokens too, so they count towards shared / union.
    expect(h.tokens.has("39")).toBe(true);
  });

  it("stems tokens with the Turkish stemmer and keeps 3-letter tokens", () => {
    const h = headlineTokens("Mustafa Sarıgül Yeni Parti'den istifa etti");
    expect(HEADLINE_TOKEN_MIN_LEN).toBe(3);
    expect([...h.tokens].sort()).toEqual(
      ["den", "etti", "istifa", "mustafa", "parti", "sarigul", "yeni"].sort(),
    );
    expect(h.numbers.size).toBe(0);
    // Inflected form folds to the same stem as the bare form.
    expect(headlineTokens("soruşturmasında").tokens).toEqual(
      headlineTokens("soruşturması").tokens,
    );
  });

  it("treats an all-digit token of any length as a numeral and a token", () => {
    const h = headlineTokens("3 gol 2026 yılında 1500 kişi");
    expect(h.numbers).toEqual(new Set(["3", "2026", "1500"]));
    for (const n of h.numbers) expect(h.tokens.has(n)).toBe(true);
  });

  it("drops stop words and tokens shorter than 3 characters", () => {
    const h = headlineTokens("Son dakika: Ali ve Veli bu da ne");
    expect([...h.tokens].sort()).toEqual(["ali", "veli"]);
  });

  it("drops generic headline prefixes", () => {
    const h = headlineTokens(
      "CANLI | Cumhurbaşkanı Erdoğan konuşuyor: Bakan Tekin açıklaması Türkiye'de",
    );
    for (const t of h.tokens) {
      for (const p of HEADLINE_GENERIC_PREFIXES) expect(t.startsWith(p)).toBe(false);
      expect(t.startsWith("erdogan")).toBe(false);
      expect(t.startsWith("cumhurbaskan")).toBe(false);
    }
    // 'tekin' is a surname, not generic.
    expect([...h.tokens]).toEqual(["tekin"]);
  });

  it("drops inflected generic tokens whose stem no longer carries the prefix", () => {
    // 'erdoganin' stems to 'erdoga'; the prefix check must run on the surface form.
    expect(headlineTokens("Erdoğanın kararı").tokens.has("erdoga")).toBe(false);
  });

  it("returns empty sets for null / empty titles", () => {
    for (const t of [null, undefined, ""]) {
      const h = headlineTokens(t);
      expect(h.tokens.size).toBe(0);
      expect(h.numbers.size).toBe(0);
    }
  });
});

describe("digit-token guard stays a digit class in both implementations", () => {
  // The bug was a regex written /^d+$/ (the letter d) instead of /^\d+$/. The
  // behavioural tests above catch it; this pins the two source files so the
  // typo cannot come back through a copy/paste between the .ts and .mjs twins.
  const files = [
    "supabase/functions/_shared/cluster/fingerprint.ts",
    "scripts/lib/cluster/fingerprint.mjs",
  ];
  for (const rel of files) {
    it(`${rel} has no /^d+$/ regex`, () => {
      const code = readFileSync(resolve(__dirname, "../../..", rel), "utf8")
        .split("\n")
        .map((line) => line.replace(/\/\/.*$/, ""))
        .join("\n");
      expect(code).not.toMatch(/\/\^d\+\$\//);
      expect(code).toMatch(/\/\^\\d\+\$\//);
    });
  }
});
