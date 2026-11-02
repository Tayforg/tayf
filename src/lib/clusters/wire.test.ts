import { describe, it, expect } from "vitest";

import {
  countIndependentHeadlines,
  detectWireRedistribution,
  headlineKey,
  wireBadgeLabel,
  wireBadgeShort,
  wireBadgeTitle,
  wireSignalOf,
  SAME_HEADLINE_MIN_CHARS,
  SAME_HEADLINE_MIN_TOKENS,
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
      "Bu kümedeki haberlerin en az yarısı başka bir haberin birebir kopyası",
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
