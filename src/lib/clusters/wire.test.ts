import { describe, it, expect } from "vitest";

import { expectLinear, rep } from "../../../tests/_helpers/linear-time";
import type { Gen } from "../../../tests/_helpers/linear-time";

import {
  countIndependentHeadlines,
  descriptionKey,
  detectWireRedistribution,
  headlineKey,
  textComponentsOf,
  wireBadgeLabel,
  wireBadgeShort,
  wireBadgeTitle,
  wireSignalOf,
  SAME_DESCRIPTION_MIN_CHARS,
  SAME_HEADLINE_MIN_CHARS,
  SAME_HEADLINE_MIN_TOKENS,
  WIRE_MIN_MEMBERS,
  WIRE_UNIQUE_HASH_RATIO,
} from "./wire";

function members(hashes: Array<string | null>) {
  return hashes.map((content_hash, i) => ({ id: `a${i}`, content_hash }));
}

describe("detectWireRedistribution", () => {
  it("never flags fewer than 3 members, even with identical hashes", () => {
    const result = detectWireRedistribution(members(["h", "h"]));
    expect(result.isWire).toBe(false);
    expect(result.uniqueHashes).toBe(2);
  });

  it("never flags a single member", () => {
    const result = detectWireRedistribution(members(["h"]));
    expect(result.isWire).toBe(false);
    expect(result.uniqueHashes).toBe(1);
  });

  it("flags wire at the exact 0.5 ratio boundary (2 unique / 4 members)", () => {
    expect(WIRE_UNIQUE_HASH_RATIO).toBe(0.5);
    const result = detectWireRedistribution(members(["h1", "h1", "h2", "h2"]));
    expect(result.uniqueHashes).toBe(2);
    expect(result.isWire).toBe(true);
  });

  it("does not flag just above the 0.5 ratio (3 unique / 5 members = 0.6)", () => {
    const result = detectWireRedistribution(
      members(["h1", "h1", "h2", "h3", "h3"])
    );
    expect(result.uniqueHashes).toBe(3);
    expect(result.isWire).toBe(false);
  });

  it("flags wire when 5 members collapse to 2 unique hashes (0.4 ratio)", () => {
    const result = detectWireRedistribution(
      members(["h1", "h1", "h1", "h2", "h2"])
    );
    expect(result.uniqueHashes).toBe(2);
    expect(result.isWire).toBe(true);
  });

  it("treats null content_hash as unique per-article, never collapsing", () => {
    const result = detectWireRedistribution(members([null, null, null, null]));
    expect(result.uniqueHashes).toBe(4);
    expect(result.isWire).toBe(false);
  });

  it("treats a mix of null and shared hashes correctly", () => {
    // 3 nulls (each unique) + 2 shared "h" => 4 unique / 5 total = 0.8, not wire
    const result = detectWireRedistribution(members([null, null, null, "h", "h"]));
    expect(result.uniqueHashes).toBe(4);
    expect(result.isWire).toBe(false);
  });
});

// h176-methodtruth-1: /metodoloji's "Tek kaynaktan dağıtım" card says "En az
// ${WIRE_MIN_MEMBERS} haberi olan kümelerde ... daha küçük kümeler işaretlenmez". The
// number is the exported constant, and these pin that the code agrees with the card.
describe("WIRE_MIN_MEMBERS: the smallest cluster that can be a wire redistribution", () => {
  it("is 3, the number /metodoloji prints", () => {
    expect(WIRE_MIN_MEMBERS).toBe(3);
  });

  it("WIRE_MIN_MEMBERS - 1 members with the same hash are not a wire (and read as that many texts)", () => {
    const below = members(Array<string>(WIRE_MIN_MEMBERS - 1).fill("h"));
    expect(below).toHaveLength(WIRE_MIN_MEMBERS - 1);
    expect(detectWireRedistribution(below)).toEqual({
      isWire: false,
      uniqueHashes: WIRE_MIN_MEMBERS - 1,
    });
    // The source count is not lowered either: the effective count is the member count.
    expect(wireSignalOf(below)).toMatchObject({
      isWireRedistribution: false,
      effectiveArticleCount: WIRE_MIN_MEMBERS - 1,
    });
  });

  it("exactly WIRE_MIN_MEMBERS members with the same hash are a wire (the floor is inclusive)", () => {
    const at = members(Array<string>(WIRE_MIN_MEMBERS).fill("h"));
    expect(detectWireRedistribution(at)).toEqual({ isWire: true, uniqueHashes: 1 });
  });

  it("the floor is read from the member count, not from the number of distinct hashes", () => {
    // 2 members, 1 distinct hash: ratio 0.5 would be wire if the floor did not stop it.
    expect(1 / (WIRE_MIN_MEMBERS - 1)).toBeLessThanOrEqual(WIRE_UNIQUE_HASH_RATIO);
    expect(detectWireRedistribution(members(["h", "h"])).isWire).toBe(false);
  });
});

describe("wireSignalOf", () => {
  it("returns effectiveArticleCount = uniqueHashes when wire, memberCount unchanged", () => {
    const signal = wireSignalOf(members(["h1", "h1", "h1", "h2", "h2"]));
    expect(signal.isWireRedistribution).toBe(true);
    expect(signal.effectiveArticleCount).toBe(2);
    expect(signal.memberCount).toBe(5);
  });

  it("returns effectiveArticleCount = memberCount when not wire", () => {
    const signal = wireSignalOf(members(["h1", "h2", "h3", "h4", "h5"]));
    expect(signal.isWireRedistribution).toBe(false);
    expect(signal.effectiveArticleCount).toBe(5);
    expect(signal.memberCount).toBe(5);
  });

  it("never flags wire for exactly 2 members regardless of hash overlap", () => {
    const signal = wireSignalOf(members(["h", "h"]));
    expect(signal.isWireRedistribution).toBe(false);
    expect(signal.effectiveArticleCount).toBe(2);
    expect(signal.memberCount).toBe(2);
  });

  it("a multi-dispatch wire cluster (6 members, hashes A A A A B C) keeps 3 distinct texts, equal to detectWireRedistribution's uniqueHashes", () => {
    const six = members(["A", "A", "A", "A", "B", "C"]);
    const signal = wireSignalOf(six);
    expect(signal.isWireRedistribution).toBe(true);
    expect(signal.memberCount).toBe(6);
    expect(signal.effectiveArticleCount).toBe(3);
    // The badge helpers take effectiveArticleCount as "distinct texts": it
    // must stay the hash count for a wire cluster (h18-numbers-2).
    expect(signal.effectiveArticleCount).toBe(detectWireRedistribution(six).uniqueHashes);
  });

  it("adds independentHeadlineCount without disturbing effectiveArticleCount/isWireRedistribution", () => {
    const wireSignal = wireSignalOf(
      members(["h1", "h1", "h1", "h2", "h2"]).map((m) => ({
        ...m,
        title: `Farklı ve özgün bir başlık metni ${m.id}`,
      })),
    );
    expect(wireSignal.isWireRedistribution).toBe(true);
    expect(wireSignal.effectiveArticleCount).toBe(2);
    // Distinct headlines per member (no title collision) but hashes still
    // union a1..a5 into 2 wire dispatches — independentHeadlineCount tracks
    // headline+hash unions together, so it matches the hash-driven count
    // here since every title is unique.
    expect(wireSignal.independentHeadlineCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// h138-roadmap2-1: the same agency lead (description) under a reworded headline
// ---------------------------------------------------------------------------
//
// Outlets that reword the headline but print the same AA lead get distinct
// content_hash values (the hash covers title + body), so the hash-only rule
// missed about 4% of 5+-source clusters. Members that share a folded
// description of at least SAME_DESCRIPTION_MIN_CHARS characters are now one
// text, just like members that share a hash. Read time only.

/** A deterministic text of exactly `len` characters ending in a full stop. */
function lead(len: number, seed = "Anadolu Ajansı muhabirinin edindiği bilgiye göre"): string {
  let s = "";
  while (s.length < len) s += `${seed} ${s.length} `;
  return `${s.slice(0, len - 1)}.`;
}

type Described = { id: string; content_hash: string | null; description?: string | null };

/** `hashes[i]` and `descriptions[i]` become member `a<i>`. */
function described(
  hashes: Array<string | null>,
  descriptions: Array<string | null | undefined>,
): Described[] {
  return hashes.map((content_hash, i) => ({
    id: `a${i}`,
    content_hash,
    description: descriptions[i],
  }));
}

describe("detectWireRedistribution: same description is one text (h138-roadmap2-1)", () => {
  it("(a) 532ee77c shape: 8 distinct hashes, 5 on one 221-char lead (one copy in other case and spacing), 3 unique -> wire with 4 texts", () => {
    const L = lead(221);
    expect(L).toHaveLength(221);
    // The fifth copy differs only in case and whitespace: it must fold to the same key.
    const recased = `  ${L.toLocaleUpperCase("tr").replace(/ /g, "   ")} `;
    const hashes = Array.from({ length: 8 }, (_, i) => `hash-${i}`);
    const rows = described(hashes, [L, L, L, L, recased, lead(150, "Özgün özet bir"), lead(160, "Özgün özet iki"), lead(170, "Özgün özet üç")]);

    // The bug, in one line: hashes alone see 8 independent texts.
    expect(detectWireRedistribution(rows.map(({ id, content_hash }) => ({ id, content_hash })))).toEqual({
      isWire: false,
      uniqueHashes: 8,
    });

    const result = detectWireRedistribution(rows);
    expect(result).toEqual({ isWire: true, uniqueHashes: 4 });
    expect(wireBadgeLabel(rows.length, result.uniqueHashes)).toBe(
      "Ajans ağırlıklı · 8 haber, 4 farklı metin",
    );
  });

  it("(b) ee04d988 shape: 11 members, 6 on one 199-char lead (2 of them also share a hash), 5 unique -> 6 texts, not wire (6/11 > 0.5)", () => {
    const L = lead(199);
    expect(L).toHaveLength(199);
    const hashes = ["shared", "shared", "h2", "h3", "h4", "h5", "h6", "h7", "h8", "h9", "h10"];
    const descriptions = [
      L, L, L, L, L, L,
      lead(120, "Birinci özgün özet"),
      lead(130, "İkinci özgün özet"),
      lead(140, "Üçüncü özgün özet"),
      lead(150, "Dördüncü özgün özet"),
      lead(160, "Beşinci özgün özet"),
    ];
    const result = detectWireRedistribution(described(hashes, descriptions));
    expect(result.uniqueHashes).toBe(6);
    expect(result.isWire).toBe(false);
  });

  it("(c) five members on an identical description under 40 chars after folding do not union", () => {
    const short = "Detaylar haberimizde";
    expect(short.length).toBeLessThan(SAME_DESCRIPTION_MIN_CHARS);
    const result = detectWireRedistribution(
      described(["h1", "h2", "h3", "h4", "h5"], Array(5).fill(short)),
    );
    expect(result).toEqual({ isWire: false, uniqueHashes: 5 });
  });

  it("the 40-character floor is inclusive: 39 characters never union, 40 do", () => {
    const hashes = ["h1", "h2", "h3", "h4", "h5"];
    const at39 = detectWireRedistribution(described(hashes, Array(5).fill("a".repeat(39))));
    expect(at39).toEqual({ isWire: false, uniqueHashes: 5 });
    const at40 = detectWireRedistribution(described(hashes, Array(5).fill("a".repeat(40))));
    expect(at40).toEqual({ isWire: true, uniqueHashes: 1 });
  });

  it("(d) a missing, null, empty or whitespace-only description gives exactly today's results", () => {
    const patterns: Array<Array<string | null>> = [
      ["h", "h"],
      ["h1", "h1", "h2", "h2"],
      ["h1", "h1", "h2", "h3", "h3"],
      ["h1", "h1", "h1", "h2", "h2"],
      [null, null, null, null],
      [null, null, null, "h", "h"],
      ["A", "A", "A", "A", "B", "C"],
    ];
    for (const hashes of patterns) {
      const today = detectWireRedistribution(members(hashes));
      for (const blank of [undefined, null, "", "   ", "\n\t "]) {
        expect(detectWireRedistribution(described(hashes, Array(hashes.length).fill(blank)))).toEqual(today);
      }
    }
    // A concrete value, so the loop above cannot pass by comparing two wrong answers.
    expect(detectWireRedistribution(members(["h1", "h1", "h1", "h2", "h2"]))).toEqual({
      isWire: true,
      uniqueHashes: 2,
    });
  });

  it("(d) a member without a description field at all is the pre-change shape and still compiles and runs", () => {
    const legacy: Array<{ id: string; content_hash: string | null }> = members(["h1", "h2", "h3"]);
    expect(detectWireRedistribution(legacy)).toEqual({ isWire: false, uniqueHashes: 3 });
  });

  it("(e) transitivity: A~B by hash and B~C by description form one component", () => {
    const L = lead(100);
    // a0 and a1 share a hash; a1 and a2 share the lead; a2 shares nothing else.
    const rows = described(["same", "same", "other"], [lead(90, "Başka bir özet"), L, L]);
    expect(detectWireRedistribution(rows)).toEqual({ isWire: true, uniqueHashes: 1 });

    // And the chain survives a fourth, unrelated member: 2 texts / 4 members = 0.5.
    const four = described(["same", "same", "other", "solo"], [lead(90, "Başka bir özet"), L, L, lead(95, "Dördüncü")]);
    expect(detectWireRedistribution(four)).toEqual({ isWire: true, uniqueHashes: 2 });
  });

  it("a null content_hash stays unique per member, yet its description can still union it", () => {
    const L = lead(80);
    const result = detectWireRedistribution(described([null, null, null, null], [L, L, L, lead(60, "Özgün")]));
    // Three nulls on one lead = 1 text, plus the unique fourth.
    expect(result).toEqual({ isWire: true, uniqueHashes: 2 });
    // Without a shared description the nulls never collapse, as before.
    const unique = detectWireRedistribution(described([null, null, null, null], [lead(80, "a"), lead(80, "b"), lead(80, "c"), lead(80, "d")]));
    expect(unique).toEqual({ isWire: false, uniqueHashes: 4 });
  });

  it("never flags fewer than 3 members, even with an identical description", () => {
    const L = lead(120);
    expect(detectWireRedistribution(described(["h1", "h2"], [L, L]))).toEqual({
      isWire: false,
      uniqueHashes: 2,
    });
  });

  it("stays at the WIRE_UNIQUE_HASH_RATIO of 0.5: 3 texts / 5 members is not wire, 2 / 4 is", () => {
    const L = lead(90);
    const three = detectWireRedistribution(described(["a", "b", "c", "d", "e"], [L, L, lead(80, "x"), lead(80, "y"), lead(80, "z")]));
    expect(three).toEqual({ isWire: false, uniqueHashes: 4 });
    const two = detectWireRedistribution(described(["a", "b", "c", "d"], [L, L, lead(80, "x"), lead(80, "x")]));
    expect(two).toEqual({ isWire: true, uniqueHashes: 2 });
  });

  it("handles 10,000 members in a single pass", () => {
    const L = lead(120);
    const rows = Array.from({ length: 10_000 }, (_, i) => ({
      id: `a${i}`,
      content_hash: `h${i}`,
      description: i % 2 === 0 ? L : lead(60, `özgün ${i}`),
    }));
    const result = detectWireRedistribution(rows);
    // 5,000 on one lead (1 text) + 5,000 unique = 5,001 texts over 10,000 members.
    expect(result).toEqual({ isWire: false, uniqueHashes: 5_001 });
  });
});

describe("descriptionKey (h138-roadmap2-1)", () => {
  it("exports the 40-character floor", () => {
    expect(SAME_DESCRIPTION_MIN_CHARS).toBe(40);
  });

  it("(g) folds NFKC and Turkish casing: İ/ı and I/i land on one key", () => {
    const a = descriptionKey("İSTANBUL'DA IŞIKLAR SÖNDÜ: ILIK RÜZGAR KENTİ SARDI, YETKİLİLER AÇIKLAMA YAPTI");
    const b = descriptionKey("istanbul'da ışıklar söndü: ılık rüzgar kenti sardı, yetkililer açıklama yaptı");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    // Plain toLowerCase would turn İ into "i" + a combining dot and split the key.
    expect(a).not.toContain("\u0307");
  });

  it("(g) NFKC folds compatibility forms (full-width letters, ligatures) to the plain text", () => {
    const plain = descriptionKey("office bilgisine göre yeni düzenleme yarından itibaren geçerli olacak");
    const compat = descriptionKey("ｏｆｆｉｃｅ bilgisine göre yeni düzenleme yarından itibaren geçerli olacak");
    const ligature = descriptionKey("oﬃce bilgisine göre yeni düzenleme yarından itibaren geçerli olacak");
    expect(plain).not.toBeNull();
    expect(compat).toBe(plain);
    expect(ligature).toBe(plain);
  });

  it("(g) strips straight and curly quotes so Erdoğan'ın and Erdoğan’ın are one key", () => {
    const a = descriptionKey("Cumhurbaşkanı Erdoğan'ın açıklamasına göre yeni dönem başlıyor, \"önemli\" adımlar atılacak");
    const b = descriptionKey("Cumhurbaşkanı Erdoğan’ın açıklamasına göre yeni dönem başlıyor, “önemli” adımlar atılacak");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("(g) collapses whitespace and punctuation runs and trims the ends", () => {
    const a = descriptionKey("  Bakan   açıklama yaptı,\n\n  gelişmeler\tyakından takip ediliyor...  ");
    const b = descriptionKey("Bakan açıklama yaptı gelişmeler yakından takip ediliyor");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
    expect(a).toBe("bakan açıklama yaptı gelişmeler yakından takip ediliyor");
  });

  it("(g) returns null under 40 characters after folding", () => {
    expect(descriptionKey("Detaylar haberimizde")).toBeNull();
    // 47 raw characters, 39 once the punctuation run collapses and the ends are trimmed.
    expect(descriptionKey(`  ${"a".repeat(19)} ... ${"b".repeat(19)}  `)).toBeNull();
    // The same shape one character longer is exactly 40 and qualifies.
    expect(descriptionKey(`  ${"a".repeat(19)} ... ${"b".repeat(20)}  `)).toBe(
      `${"a".repeat(19)} ${"b".repeat(20)}`,
    );
    expect(descriptionKey("a".repeat(39))).toBeNull();
    expect(descriptionKey("a".repeat(40))).toBe("a".repeat(40));
  });

  it("returns null for null, undefined, empty, whitespace-only and non-string input", () => {
    expect(descriptionKey(null)).toBeNull();
    expect(descriptionKey(undefined)).toBeNull();
    expect(descriptionKey("")).toBeNull();
    expect(descriptionKey("   \n\t ")).toBeNull();
    expect(descriptionKey(42 as unknown as string)).toBeNull();
    expect(descriptionKey({} as unknown as string)).toBeNull();
  });

  it("does not strip a leading 'son dakika' (that is a headline rule, not a lead rule)", () => {
    const key = descriptionKey("Son dakika haberine göre yeni gelişme yaşandı ve açıklama bekleniyor");
    expect(key?.startsWith("son dakika")).toBe(true);
  });

  it("scales linearly on hostile input (no nested quantifiers, CodeQL js/redos): alternating word and punctuation runs, long whitespace, long quote runs", () => {
    // Load-robust (tests/_helpers/linear-time.ts): CPU time over a 31k .. 250k
    // ladder, the guard is how the cost GROWS, not an absolute wall clock.
    const shapes: Array<[string, Gen]> = [
      ["word, space", rep("a ")],
      ["word, punctuation", rep("a!?")],
      ["whitespace run", rep(" ", "x", "y")],
      ["quote run", rep("'", "x", "y")],
      ["punctuation run", rep("!", "x", "y")],
    ];
    for (const [, gen] of shapes) {
      expectLinear(gen, (input) => descriptionKey(input), { n: 250_000, ceilingMs: 4_000 });
    }
  });

  it("is unicode-safe: emoji-only text folds away to null, CJK text counts as word characters", () => {
    // Emoji are neither letters nor digits: a description of nothing else folds to an empty key.
    expect(descriptionKey("🔥".repeat(60))).toBeNull();
    const cjk = "日本語のニュース記事の要約文がここに入ります。同じ文章がもう一度出てきます。さらに続きの文章もここに入ります。";
    expect(descriptionKey(cjk)).not.toBeNull();
  });
});

describe("wireSignalOf with descriptions (h138-roadmap2-1)", () => {
  const L = lead(120);

  it("(f) effectiveArticleCount is the component count when wire, and memberCount otherwise", () => {
    const wire = wireSignalOf(
      described(["h1", "h2", "h3", "h4", "h5", "h6"], [L, L, L, L, lead(70, "x"), lead(70, "y")]),
    );
    expect(wire.isWireRedistribution).toBe(true);
    expect(wire.memberCount).toBe(6);
    expect(wire.effectiveArticleCount).toBe(3);

    const notWire = wireSignalOf(
      described(["h1", "h2", "h3", "h4", "h5"], [L, lead(70, "x"), lead(70, "y"), lead(70, "z"), lead(70, "w")]),
    );
    expect(notWire.isWireRedistribution).toBe(false);
    expect(notWire.memberCount).toBe(5);
    expect(notWire.effectiveArticleCount).toBe(5);
  });

  it("(f) independentHeadlineCount keeps its headline meaning: a shared description does not fold headlines", () => {
    const rows = described(["h1", "h2", "h3", "h4"], [L, L, L, L]).map((m) => ({
      ...m,
      title: `Her kaynağın kendi yazdığı farklı bir başlık ${m.id}`,
    }));
    const signal = wireSignalOf(rows);
    expect(signal.isWireRedistribution).toBe(true);
    expect(signal.effectiveArticleCount).toBe(1);
    // Four different headlines over one agency lead: still four headlines.
    expect(signal.independentHeadlineCount).toBe(4);
    expect(signal.independentHeadlineCount).toBe(countIndependentHeadlines(rows));
  });

  it("(f) countIndependentHeadlines ignores description entirely", () => {
    const rows = described(["h1", "h2", "h3"], [L, L, L]).map((m) => ({ ...m, title: `Ayrı başlık numarası ${m.id}` }));
    expect(countIndependentHeadlines(rows)).toBe(3);
  });

  it("forwards description to the detection, and still works without it (the existing callers)", () => {
    expect(wireSignalOf(described(["a", "b", "c"], [L, L, L])).effectiveArticleCount).toBe(1);
    expect(wireSignalOf(members(["a", "b", "c"])).effectiveArticleCount).toBe(3);
  });

  it("effectiveArticleCount feeds the badge copy: 8 members on 4 texts reads 'Ajans ağırlıklı · 8 haber, 4 farklı metin'", () => {
    const rows = described(
      Array.from({ length: 8 }, (_, i) => `h${i}`),
      [L, L, L, L, L, lead(70, "x"), lead(70, "y"), lead(70, "z")],
    );
    const signal = wireSignalOf(rows);
    expect(signal.isWireRedistribution).toBe(true);
    expect(wireBadgeLabel(signal.memberCount, signal.effectiveArticleCount)).toBe(
      "Ajans ağırlıklı · 8 haber, 4 farklı metin",
    );
  });
});

// h139 review ts-3: one union rule shared by the wire detection and the
// summary's wire majority, so the two can never drift.
describe("textComponentsOf (h139 ts-3)", () => {
  const L = lead(120);

  it("gives one root per member; members sharing a hash or an agency lead share a root", () => {
    const roots = textComponentsOf(
      described(["h1", "h1", "h2", "h3", "h4"], [null, null, L, L, lead(70, "x")]),
    );
    expect(roots).toHaveLength(5);
    expect(roots[0]).toBe(roots[1]); // same hash
    expect(roots[2]).toBe(roots[3]); // same lead, distinct hashes
    expect(new Set(roots).size).toBe(3);
  });

  it("chains: A~B by hash and B~C by lead is one text; null hashes stay unique", () => {
    const roots = textComponentsOf(described(["h1", "h1", "h2", null, null], [null, L, L, null, null]));
    expect(new Set([roots[0], roots[1], roots[2]]).size).toBe(1);
    expect(new Set(roots).size).toBe(3);
  });

  it("has no member-count gate, and an empty list gives an empty array", () => {
    expect(textComponentsOf([])).toEqual([]);
    const two = textComponentsOf(described(["h", "h"], [null, null]));
    expect(two[0]).toBe(two[1]);
  });

  it("agrees with detectWireRedistribution's text count on every member list", () => {
    const rows = described(["h1", "h2", "h3", "h4", "h5", "h6"], [L, L, L, L, lead(70, "x"), lead(70, "y")]);
    expect(new Set(textComponentsOf(rows)).size).toBe(detectWireRedistribution(rows).uniqueHashes);
  });
});

describe("SAME_HEADLINE thresholds", () => {
  it("matches the documented constants", () => {
    expect(SAME_HEADLINE_MIN_CHARS).toBe(25);
    expect(SAME_HEADLINE_MIN_TOKENS).toBe(4);
  });
});

describe("headlineKey", () => {
  it("folds Turkish İ/ı casing (toLocaleLowerCase('tr'), not plain toLowerCase)", () => {
    const a = headlineKey("Mansur Yavaş CHP'den İstifa Etti Açıklaması");
    const b = headlineKey("mansur yavaş chp'den istifa etti açıklaması");
    expect(a).not.toBeNull();
    expect(a).toBe(b);
  });

  it("treats a straight apostrophe and a curly one the same", () => {
    const a = headlineKey("Erdoğan'ın yeni açıklaması geldi bugün");
    const b = headlineKey("Erdoğan’ın yeni açıklaması geldi bugün");
    expect(a).toBe(b);
  });

  it("strips a leading 'son dakika:' / 'flaş' prefix", () => {
    const withPrefix = headlineKey("Son Dakika: deprem sonrası açıklama geldi şimdi");
    const withoutPrefix = headlineKey("deprem sonrası açıklama geldi şimdi");
    expect(withPrefix).toBe(withoutPrefix);

    const flas = headlineKey("Flaş açıklama geldi az önce şimdi buradan");
    const flas2 = headlineKey("Flas açıklama geldi az önce şimdi buradan");
    expect(flas).not.toBeNull();
    expect(flas).toBe(flas2);
  });

  it("collapses punctuation runs to a single space", () => {
    const a = headlineKey("Mansur Yavaş, CHP'den istifa etti!!!");
    const b = headlineKey("Mansur Yavaş CHP'den istifa etti");
    expect(a).toBe(b);
  });

  it("rejects short headlines below both the char and token floor", () => {
    // "Son dakika: deprem" -> after stripping prefix: "deprem" — 6 chars, 1 token.
    expect(headlineKey("Son dakika: deprem")).toBeNull();
  });

  it("qualifies at >= 4 tokens even under 25 chars", () => {
    const key = headlineKey("Kısa ama dört kelime var");
    // "kısa ama dört kelime var" — well over 4 tokens; use a tighter one:
    const short = headlineKey("Ali gitti eve döndü");
    expect(short).not.toBeNull();
    expect(key).not.toBeNull();
  });

  it("qualifies 'Mansur Yavaş CHP'den istifa etti' (the evidence example)", () => {
    expect(headlineKey("Mansur Yavaş CHP'den istifa etti")).not.toBeNull();
  });

  it("returns null for an empty or whitespace-only title", () => {
    expect(headlineKey("")).toBeNull();
    expect(headlineKey("   ")).toBeNull();
  });
});

describe("countIndependentHeadlines", () => {
  it("returns 0 for empty input", () => {
    expect(countIndependentHeadlines([])).toBe(0);
  });

  it("unions a hash-only group into one component", () => {
    const result = countIndependentHeadlines([
      { id: "a1", content_hash: "h1", title: null },
      { id: "a2", content_hash: "h1", title: null },
      { id: "a3", content_hash: "h1", title: null },
    ]);
    expect(result).toBe(1);
  });

  it("unions a title-only group (same folded headline, different hashes) into one component", () => {
    const result = countIndependentHeadlines([
      { id: "a1", content_hash: "hash-1", title: "Mansur Yavaş CHP'den istifa etti" },
      { id: "a2", content_hash: "hash-2", title: "mansur yavaş chp'den istifa etti" },
      { id: "a3", content_hash: "hash-3", title: "MANSUR YAVAŞ CHP'DEN İSTİFA ETTİ" },
    ]);
    expect(result).toBe(1);
  });

  it("bridges A~B by hash and B~C by title into a single component", () => {
    const result = countIndependentHeadlines([
      { id: "a", content_hash: "shared-hash", title: "Habere göre bir şeyler oldu" },
      { id: "b", content_hash: "shared-hash", title: "Aynı başlık burada tekrar ediyor" },
      { id: "c", content_hash: "other-hash", title: "Aynı başlık burada tekrar ediyor" },
    ]);
    expect(result).toBe(1);
  });

  it("keeps null titles and hashes each as their own unique component", () => {
    const result = countIndependentHeadlines([
      { id: "a", content_hash: null, title: null },
      { id: "b", content_hash: null, title: null },
    ]);
    expect(result).toBe(2);
  });

  it("does not union short/unqualified titles (below the char+token floor)", () => {
    const result = countIndependentHeadlines([
      { id: "a", content_hash: null, title: "deprem" },
      { id: "b", content_hash: null, title: "deprem" },
    ]);
    expect(result).toBe(2);
  });
});

// h18-numbers-2: a wire cluster can hold several distinct dispatches (6
// members, 3 unique hashes). "Tek kaynaktan dağıtıldı" is true only when ONE
// text is behind every member; otherwise the badge states both numbers.
describe("wireBadgeLabel", () => {
  it("one distinct text: says single source and counts copies", () => {
    expect(wireBadgeLabel(7, 1)).toBe("Tek kaynaktan dağıtıldı · 7 kopya");
  });

  it("treats 0 and NaN distinct texts like one (never the multi-text claim)", () => {
    expect(wireBadgeLabel(7, 0)).toBe("Tek kaynaktan dağıtıldı · 7 kopya");
    expect(wireBadgeLabel(7, Number.NaN)).toBe("Tek kaynaktan dağıtıldı · 7 kopya");
  });

  it("several distinct texts: states members and distinct texts, never 'tek kaynak'", () => {
    const label = wireBadgeLabel(6, 3);
    expect(label).toBe("Ajans ağırlıklı · 6 haber, 3 farklı metin");
    expect(label).not.toContain("Tek kaynak");
    expect(label).not.toContain("tek kaynak");
  });
});

describe("wireBadgeShort", () => {
  it("one distinct text: byte-identical to the OG pill shipped before", () => {
    expect(wireBadgeShort(7, 1)).toBe("7 kopya · tek kaynak");
    expect(wireBadgeShort(7, 0)).toBe("7 kopya · tek kaynak");
    expect(wireBadgeShort(7, Number.NaN)).toBe("7 kopya · tek kaynak");
  });

  it("several distinct texts: states members and distinct texts, never 'tek kaynak'", () => {
    const short = wireBadgeShort(6, 3);
    expect(short).toBe("6 haber · 3 farklı metin");
    expect(short).not.toContain("Tek kaynak");
    expect(short).not.toContain("tek kaynak");
  });
});

describe("wireBadgeTitle", () => {
  it("one distinct text: every member is a copy of the same agency text", () => {
    expect(wireBadgeTitle(1)).toBe(
      "Bu kümedeki haberlerin tamamı aynı ajans metninin kopyası",
    );
    expect(wireBadgeTitle(0)).toBe(
      "Bu kümedeki haberlerin tamamı aynı ajans metninin kopyası",
    );
  });

  it("several distinct texts: true by construction of the 0.5 ratio, and never 'tek'", () => {
    const title = wireBadgeTitle(3);
    expect(title).toBe(
      "Bu kümedeki haberlerin en az yarısı, başlığı farklı olsa da başka bir haberle aynı metni paylaşıyor",
    );
    expect(title.toLocaleLowerCase("tr-TR")).not.toContain("tek");
  });

  it("the multi-text claim holds for every wire cluster: copies >= members / 2", () => {
    // unique / members <= WIRE_UNIQUE_HASH_RATIO  <=>  members - unique >= members / 2
    for (let n = 3; n <= 12; n++) {
      for (let unique = 1; unique <= n; unique++) {
        const hashes = Array.from({ length: n }, (_, i) => `h${i < unique ? i : 0}`);
        const r = detectWireRedistribution(members(hashes));
        if (r.isWire && r.uniqueHashes > 1) {
          expect(n - r.uniqueHashes).toBeGreaterThanOrEqual(n / 2);
        }
      }
    }
  });
});
