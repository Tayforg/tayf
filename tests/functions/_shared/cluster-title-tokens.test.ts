import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  headlineTokens,
  stemHeadlineToken,
  stemTurkish,
  titleTokens,
} from "../../../supabase/functions/_shared/cluster/fingerprint.ts";
import {
  HEADLINE_GENERIC_PREFIXES,
  HEADLINE_TITLE_MAX_CHARS,
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

describe("headlineTokens: headline-only stemmer (h12-cluster-3)", () => {
  // The headline lane has its own stemmer so a locative strip does not eat the
  // end of a name: stemTurkish (TF-IDF, candidate index) turned gazete into
  // 'gaze' and Atlanta into 'atlan'. stemTurkish itself is deliberately NOT
  // touched: it feeds the persisted TF-IDF and the candidate token index.
  const stems = (title: string): string[] => [...headlineTokens(title).tokens].sort();

  it("keeps 'gazete' and 'atlanta' whole", () => {
    const t = headlineTokens("Karar Resmi Gazete'de atandı Atlanta").tokens;
    expect(t.has("gazete")).toBe(true);
    expect(t.has("atlanta")).toBe(true);
    expect(t.has("gaze")).toBe(false);
    expect(t.has("atlan")).toBe(false);
  });

  it("pins the untouched TF-IDF stemmer: stemTurkish('gazete') === 'gaze'", () => {
    expect(stemTurkish("gazete")).toBe("gaze");
    expect(stemTurkish("atlanta")).toBe("atlan");
    // ...and titleTokens (candidate generation) keeps using it.
    expect(titleTokens("Karar Resmi Gazete'de atandı Atlanta", 4).has("gaze")).toBe(true);
  });

  const SAME_STEM: Array<[string, string[]]> = [
    ["locative after a voiceless consonant", ["mecliste", "meclis"]],
    ["locative after a voiceless consonant (t)", ["devlette", "devlet"]],
    ["soruşturma family", ["soruşturmada", "soruşturma", "soruşturmasında", "soruşturması"]],
    ["belediye family", ["belediyesi", "Belediyesine", "belediye"]],
    ["mevkidaş family", ["mevkidaşıyla", "mevkidaşı"]],
  ];
  for (const [label, words] of SAME_STEM) {
    it(`${label}: ${words.join(" / ")} share one stem`, () => {
      const sets = words.map((w) => stems(w));
      for (const s of sets) expect(s).toHaveLength(1);
      expect(new Set(sets.map((s) => s[0])).size).toBe(1);
    });
  }

  it("does not merge words that merely look alike", () => {
    expect(stems("gazete")).not.toEqual(stems("gaze"));
    expect(stems("mecliste")).not.toEqual(stems("mevkidaşı"));
  });

  it("Zelensky, Zelenskiy and Zelenskyy all give 'zelenski' (alias before stemming)", () => {
    for (const w of ["Zelensky", "Zelenskiy", "Zelenskyy", "Zelenski", "ZELENSKİY", "Zelenskiy'i", "Zelenski'yi"]) {
      expect(stems(w), w).toEqual(["zelenski"]);
    }
    expect(headlineTokens("Zelenskiy").tokens).toEqual(headlineTokens("Zelensky").tokens);
  });

  it("the alias does not leak onto other names", () => {
    expect(stems("Lavrov")).toEqual(["lavrov"]);
    expect(stems("Zelenskiyev")).not.toEqual(["zelenski"]);
    // The alias table is looked up by own key: Object.prototype names are words.
    expect(stems("constructor valueOf __proto__ toString")).toEqual(
      ["constructor", "proto", "tostring", "valueof"],
    );
  });

  it("Sarıgül headline keeps its 'den' fragment (the lane still counts it)", () => {
    expect(stems("Mustafa Sarıgül Yeni Parti'den istifa etti")).toContain("den");
  });

  it("stemHeadlineToken leaves digits, short tokens and unaffixed words alone", () => {
    expect(stemHeadlineToken("2026")).toBe("2026");
    expect(stemHeadlineToken("etti")).toBe("etti");
    expect(stemHeadlineToken("ali")).toBe("ali");
    expect(stemHeadlineToken("")).toBe("");
    expect(stemHeadlineToken("gazete")).toBe("gazete");
    expect(stemHeadlineToken("atlanta")).toBe("atlanta");
    expect(stemHeadlineToken("sarigul")).toBe("sarigul");
  });

  it("terminates and never returns an empty or shorter-than-3 stem for long tokens", () => {
    for (const w of ["lerdenlerdenlerden", "yasiyasiyasi", "nesinenesine", "x".repeat(400), "dididididi"]) {
      const s = stemHeadlineToken(w);
      expect(s.length).toBeGreaterThanOrEqual(3);
      expect(w.startsWith(s)).toBe(true);
    }
  });
});

describe("headlineTokens: liveKey for headlines that reduce to no tokens (h12-cluster-3)", () => {
  it("a zero-token title carries its normalised title as liveKey", () => {
    const h = headlineTokens("CANLI | Cumhurbaşkanı Erdoğan konuşuyor");
    expect(h.tokens.size).toBe(0);
    expect(h.numbers.size).toBe(0);
    expect(h.liveKey).toBe("canli cumhurbaskani erdogan konusuyor");
  });

  it("outlet formatting does not change the key", () => {
    expect(headlineTokens("Canlı: Cumhurbaşkanı Erdoğan konuşuyor!").liveKey).toBe(
      headlineTokens("CANLI | Cumhurbaşkanı Erdoğan konuşuyor").liveKey,
    );
    expect(headlineTokens("CANLI | Erdoğan konuşuyor").liveKey).not.toBe(
      headlineTokens("CANLI | Cumhurbaşkanı Erdoğan konuşuyor").liveKey,
    );
  });

  it("any title that keeps a token has no liveKey", () => {
    expect(headlineTokens("Mustafa Sarıgül Yeni Parti'den istifa etti").liveKey).toBeNull();
    expect(headlineTokens("CANLI | Bakan Tekin açıklama yapıyor").liveKey).toBeNull();
    // A numeral is a token too.
    expect(headlineTokens("CANLI | Erdoğan 2026").tokens.size).toBeGreaterThan(0);
    expect(headlineTokens("CANLI | Erdoğan 2026").liveKey).toBeNull();
  });

  it("empty, null and stop-word-only titles have no liveKey", () => {
    for (const t of [null, undefined, "", "   ", "son dakika", "Son dakika..."]) {
      const h = headlineTokens(t);
      expect(h.tokens.size).toBe(0);
      expect(h.liveKey, String(t)).toBeNull();
    }
  });

  it("the key is read from the clipped title", () => {
    const filler = "canli ".repeat(100);
    const h = headlineTokens(`${filler}${"z".repeat(500)}`);
    // Only the first HEADLINE_TITLE_MAX_CHARS characters are read, so the
    // 500 trailing letters never become a token and the key stays bounded.
    expect(h.tokens.size).toBe(0);
    expect(h.liveKey).not.toBeNull();
    expect(h.liveKey!.length).toBeLessThanOrEqual(HEADLINE_TITLE_MAX_CHARS);
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
