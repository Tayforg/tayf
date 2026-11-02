import { describe, expect, it } from "vitest";
import {
  clampForScan,
  stripTagsLinear,
} from "../../../supabase/functions/_shared/rss/strip-tags.ts";

// ---------------------------------------------------------------------------
// h26-security-2: `stripTagsLinear` replaces the fixpoint `/<[^>]*>/g` loop in
// normalize.ts (and the one-pass regex in fact-checks/normalize.ts) with a
// linear indexOf scanner, and `clampForScan` bounds what the scanner and the
// entity decoder ever see.
//
// The oracle below is a naive character-level walk of the one-pass semantics
// (drop `<` through the first `>` after it, repeat; a `<` with no `>` after it
// is literal text and so is everything behind it). It deliberately is NOT the
// regex: tests never spell the tag regex out (CodeQL), and the differential
// against the old regex over 100k strings is a one-off script, not a test.
//
// Why one pass equals the old fixpoint: after one pass every remaining `<` has
// no `>` after it, so a second pass finds nothing and the loop stopped after
// the first. See the doc comment in strip-tags.ts.
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function oracle(text: string, replacement: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text.charAt(i);
    if (ch !== "<") {
      out += ch;
      i++;
      continue;
    }
    let j = i + 1;
    while (j < text.length && text.charAt(j) !== ">") j++;
    if (j >= text.length) {
      // No '>' anywhere after this '<': it and the rest are plain text.
      out += text.slice(i);
      return out;
    }
    out += replacement;
    i = j + 1;
  }
  return out;
}

const ALPHABET = ["<", ">", "a", " ", "/", "!", "-", "&", "ş"] as const;

function randomString(rand: () => number): string {
  const length = Math.floor(rand() * 301); // 0..300
  let s = "";
  for (let i = 0; i < length; i++) {
    s += ALPHABET[Math.floor(rand() * ALPHABET.length)] as string;
  }
  return s;
}

// Wall-clock budget for the 1 MB hostile inputs. They cost 0.2-5 ms on a laptop
// (~25 ms on a GitHub runner at the worst); the quadratic fixpoint they replace
// needed seconds at 80 KB and minutes at 1 MB, so 150 ms keeps 5x+ CI headroom
// and is still orders of magnitude below the regression.
const BUDGET_MS = 150;

function timed(fn: () => unknown): number {
  const start = performance.now();
  fn();
  return performance.now() - start;
}

describe("stripTagsLinear", () => {
  it("matches the one-pass oracle on 5,000 seeded random strings (replacement '' and ' ')", () => {
    const rand = mulberry32(0x5eed26);
    for (let n = 0; n < 5000; n++) {
      const s = randomString(rand);
      expect(stripTagsLinear(s)).toBe(oracle(s, ""));
      expect(stripTagsLinear(s, " ")).toBe(oracle(s, " "));
    }
  });

  it("is deterministic across a re-run of the same seed", () => {
    const run = () => {
      const rand = mulberry32(42);
      const outs: string[] = [];
      for (let n = 0; n < 50; n++) outs.push(stripTagsLinear(randomString(rand)));
      return outs;
    };
    expect(run()).toEqual(run());
  });

  it("leaves no '<' that still has a '>' after it (the old fixpoint's guarantee)", () => {
    const rand = mulberry32(7);
    for (let n = 0; n < 2000; n++) {
      const out = stripTagsLinear(randomString(rand));
      const lt = out.indexOf("<");
      if (lt !== -1) expect(out.indexOf(">", lt + 1)).toBe(-1);
    }
  });

  it("strips nested and reintroduced markup the way the fixpoint did", () => {
    expect(stripTagsLinear("<<script>script>alert(1)")).toBe("script>alert(1)");
    expect(stripTagsLinear("<a<b>c")).toBe("c");
    expect(stripTagsLinear("x<b>kalın</b>y")).toBe("xkalıny");
  });

  it("keeps a lone '<' that has no '>' after it", () => {
    expect(stripTagsLinear("a < b")).toBe("a < b");
    expect(stripTagsLinear("1 < 2 and 3 < 4")).toBe("1 < 2 and 3 < 4");
    expect(stripTagsLinear("<b>kalın</b> ve a < b")).toBe("kalın ve a < b");
  });

  it("keeps a stray '>' and text before the first '<'", () => {
    expect(stripTagsLinear("a > b <i>x</i>")).toBe("a > b x");
    expect(stripTagsLinear(">>>")).toBe(">>>");
  });

  it("uses the replacement once per removed tag", () => {
    expect(stripTagsLinear("a<b>c<i>d", " ")).toBe("a c d");
    expect(stripTagsLinear("<b><i>", " ")).toBe("  ");
    expect(stripTagsLinear("a<b>c", "")).toBe("ac");
  });

  it("handles empty input and input without markup untouched", () => {
    expect(stripTagsLinear("")).toBe("");
    expect(stripTagsLinear("düz metin ş")).toBe("düz metin ş");
  });

  it("handles a tag that spans a newline", () => {
    expect(stripTagsLinear('a<img\nsrc="x">b')).toBe("ab");
  });

  it(`strips 1 MB of '<' in under ${BUDGET_MS} ms (no quadratic scan)`, () => {
    const hostile = "<".repeat(1_000_000);
    const ms = timed(() => stripTagsLinear(hostile));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(stripTagsLinear(hostile)).toBe(hostile);
  });

  it(`strips 1 MB of '<a ' and of '<a<a' in under ${BUDGET_MS} ms`, () => {
    for (const unit of ["<a ", "<a<a", "<<<a"]) {
      const hostile = unit.repeat(Math.ceil(1_000_000 / unit.length));
      expect(timed(() => stripTagsLinear(hostile))).toBeLessThan(BUDGET_MS);
    }
  });

  it(`strips 1 MB of well-formed tags in under ${BUDGET_MS} ms`, () => {
    const text = "<p>kelime</p>".repeat(80_000);
    const ms = timed(() => stripTagsLinear(text, " "));
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});

describe("clampForScan", () => {
  it("returns input at or under the cap as-is", () => {
    const s = "kısa metin";
    expect(clampForScan(s, 100)).toBe(s);
    expect(clampForScan(s, s.length)).toBe(s);
    expect(clampForScan("", 5)).toBe("");
  });

  it("returns an under-cap input even when it ends in an unclosed '<'", () => {
    expect(clampForScan("a < b <", 100)).toBe("a < b <");
  });

  it("cuts at the cap", () => {
    expect(clampForScan("abcdefghij", 4)).toBe("abcd");
  });

  it("does not leave half of a surrogate pair at the cut", () => {
    // Index 9 is the HIGH surrogate of U+1F600; a cut at 10 would keep it
    // without its low half, which is XML-illegal and mangles the title.
    const s = "a".repeat(9) + "\u{1F600}" + "b".repeat(5);
    const out = clampForScan(s, 10);
    expect(out).toBe("a".repeat(9));
    const last = out.charCodeAt(out.length - 1);
    expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
  });

  it("keeps a whole surrogate pair when the cut falls right after it", () => {
    const s = "a".repeat(8) + "\u{1F600}" + "b".repeat(5);
    expect(clampForScan(s, 10)).toBe("a".repeat(8) + "\u{1F600}");
  });

  it("drops a tag the cut splits, instead of leaving its opening fragment as text", () => {
    const s = 'metin <a href="https://x.test/y">bağlantı</a> devam';
    // The cut at 15 lands inside the opening tag: 'metin <a href="'.
    expect(clampForScan(s, 15)).toBe("metin ");
  });

  it("keeps a '<' that a later '>' closes inside the kept part", () => {
    const s = "<b>kalın</b> ve sonrası uzun uzun devam eder";
    expect(clampForScan(s, 12)).toBe("<b>kalın</b>");
  });

  it("cuts only the LAST unclosed '<'", () => {
    const s = "a <b> c <i";
    // cap 9: 'a <b> c <' -> the last '<' (index 8) has no '>' after it.
    expect(clampForScan(s, 9)).toBe("a <b> c ");
  });

  it("bounds a hostile input to the cap", () => {
    const out = clampForScan("<".repeat(1_000_000), 2000);
    expect(out.length).toBeLessThanOrEqual(2000);
  });

  it("always returns a prefix, at most the cap long, with no dangling high surrogate or open tag", () => {
    const rand = mulberry32(99);
    const alphabet = ["<", ">", "a", " ", "ş", "\u{1F600}"] as const;
    for (let n = 0; n < 2000; n++) {
      const length = Math.floor(rand() * 60);
      let s = "";
      for (let i = 0; i < length; i++) {
        s += alphabet[Math.floor(rand() * alphabet.length)] as string;
      }
      const cap = Math.floor(rand() * 40);
      const out = clampForScan(s, cap);
      expect(s.startsWith(out)).toBe(true);
      if (s.length > cap) {
        expect(out.length).toBeLessThanOrEqual(cap);
        if (out.length > 0) {
          const last = out.charCodeAt(out.length - 1);
          expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        }
        // Whatever was taken off the end of the cut text is exactly an
        // unclosed '<' and what follows it (the split tag), or at most the one
        // high surrogate that has no low half.
        const dropped = s.slice(out.length, cap);
        const lt = dropped.indexOf("<");
        if (lt !== -1) {
          expect(dropped.indexOf("<", lt + 1)).toBe(-1);
          expect(dropped.indexOf(">", lt + 1)).toBe(-1);
        }
      } else {
        expect(out).toBe(s);
      }
    }
  });
});
