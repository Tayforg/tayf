import { describe, expect, it } from "vitest";

import { findInlineImgSrc } from "../../../supabase/functions/_shared/rss/inline-image.ts";
import { expectCpuUnder, expectLinear, rep } from "../../_helpers/linear-time";
import type { Gen } from "../../_helpers/linear-time";

// ---------------------------------------------------------------------------
// h26-security-2 (review round 2): findInlineImgSrc replaces
//
//     body.slice(0, CAP).match(/<img[^>]{1,1000}src=["']([^"']+)["']/i)
//
// in normalize.ts extractImage. The bounded regex was still ~1000x
// super-linear (every '<img' start scans and backtracks over up to 1,000
// units), so 160 items of '<img'.repeat(12_500) cost 1.9-2.9 s of CPU against
// the 2 s isolate limit. The scanner must (a) pick exactly what the regex
// picked and (b) cost O(n).
//
// The reference regex below is only ever run on tiny inputs (<= ~60 units);
// the hostile inputs go through the scanner alone.
// ---------------------------------------------------------------------------

function reference(html: string, cap: number, run: number): string | null {
  const re = new RegExp(`<img[^>]{1,${run}}src=["']([^"']+)["']`, "i");
  return html.slice(0, cap).match(re)?.[1] ?? null;
}

describe("findInlineImgSrc: picks what the bounded regex picked", () => {
  const CAP = 50_000;

  it.each([
    ['<img src="https://cdn.test/a.jpg">', "https://cdn.test/a.jpg"],
    ["<img src='https://cdn.test/a.jpg'>", "https://cdn.test/a.jpg"],
    ['<IMG SRC="https://cdn.test/a.jpg">', "https://cdn.test/a.jpg"],
    ['<p><img class="x" alt="y" src="https://cdn.test/a.jpg" /></p>', "https://cdn.test/a.jpg"],
    // the LAST src= inside the tag wins (data-src first, real src second)
    [
      '<img data-src="https://cdn.test/lazy.jpg" src="https://cdn.test/real.jpg">',
      "https://cdn.test/real.jpg",
    ],
    // ... which includes a data-src that comes last (legacy quirk, kept)
    [
      '<img src="https://cdn.test/real.jpg" data-src="https://cdn.test/lazy.jpg">',
      "https://cdn.test/lazy.jpg",
    ],
    // mixed quote kinds: the closing quote is any quote character
    ["<img src=\"https://cdn.test/a.jpg'>", "https://cdn.test/a.jpg"],
    // the value may contain '>' (the regex only fences the attribute RUN)
    ['<img src="https://cdn.test/a.jpg?x=1>2">', "https://cdn.test/a.jpg?x=1>2"],
    // the first <img with a usable src wins, later ones are not consulted
    [
      '<img alt="no src"><img src="https://cdn.test/second.jpg"><img src="https://cdn.test/third.jpg">',
      "https://cdn.test/second.jpg",
    ],
  ])("%j", (html, expected) => {
    expect(findInlineImgSrc(html, CAP)).toBe(expected);
    expect(reference(html, CAP, 1000)).toBe(expected);
  });

  it.each([
    "",
    "plain text",
    "<img>",
    '<img src="">', // empty value
    '<imgsrc="https://cdn.test/a.jpg">', // needs one char between '<img' and 'src='
    '<img src="https://cdn.test/a.jpg', // no closing quote
    "<img src=https://cdn.test/a.jpg>", // unquoted
    '<img alt="x"> src="https://cdn.test/a.jpg"', // src after the '>' of the tag
    '<im src="x">', // not an <img tag
    '<i mg src="https://cdn.test/a.jpg">',
  ])("no match: %j", (html) => {
    expect(findInlineImgSrc(html, CAP)).toBeNull();
    expect(reference(html, CAP, 1000)).toBeNull();
  });

  it("<img followed directly by a name char still counts (no word boundary, as before)", () => {
    const html = '<imgx src="https://cdn.test/a.jpg">';
    expect(findInlineImgSrc(html, CAP)).toBe("https://cdn.test/a.jpg");
    expect(reference(html, CAP, 1000)).toBe("https://cdn.test/a.jpg");
  });

  it("a src= inside a LATER tag does not belong to an earlier unterminated <img", () => {
    // '<img alt="x"' has no '>' before the next '<img', but the first '>' is the
    // end of the second tag, so the regex lets the first start own that src.
    const html = '<img alt="x" <img src="https://cdn.test/a.jpg">';
    expect(findInlineImgSrc(html, CAP)).toBe(reference(html, CAP, 1000));
  });

  describe("the 1,000-unit attribute run bound", () => {
    const URL = "https://cdn.test/far.jpg";

    it("src= whose run from '<img' is exactly 1,000 units still matches", () => {
      // '<img' + 1 char filler... run = filler length + the space; make the run
      // (units between '<img' and 'src=') exactly 1000.
      const html = "<img" + " ".repeat(1000) + `src="${URL}">`;
      expect(findInlineImgSrc(html, CAP)).toBe(URL);
      expect(reference(html, CAP, 1000)).toBe(URL);
    });

    it("src= whose run is 1,001 units does not match", () => {
      const html = "<img" + " ".repeat(1001) + `src="${URL}">`;
      expect(findInlineImgSrc(html, CAP)).toBeNull();
      expect(reference(html, CAP, 1000)).toBeNull();
    });

    it("a later <img start can still match when the first one is too far", () => {
      const html =
        "<img" + " ".repeat(1001) + `src="https://cdn.test/skipped.jpg"><img src="${URL}">`;
      expect(findInlineImgSrc(html, CAP)).toBe(URL);
      expect(reference(html, CAP, 1000)).toBe(URL);
    });
  });

  describe("the scan cap", () => {
    it("ignores an <img> that starts past the cap", () => {
      const html = "x".repeat(CAP) + '<img src="https://cdn.test/late.jpg">';
      expect(findInlineImgSrc(html, CAP)).toBeNull();
    });

    it("ignores a value whose closing quote is past the cap", () => {
      const html = '<img src="' + "a".repeat(CAP) + '">';
      expect(findInlineImgSrc(html, CAP)).toBeNull();
    });

    it("finds an <img> that ends exactly at the cap", () => {
      const tag = '<img src="https://cdn.test/edge.jpg"';
      const html = "x".repeat(CAP - tag.length - 1) + tag + '">';
      expect(html.length).toBeGreaterThan(CAP - 1);
      expect(findInlineImgSrc(html, CAP)).toBe(reference(html, CAP, 1000));
    });
  });

  describe("differential fuzz against the regex on small inputs", () => {
    const TOKENS = [
      "<img", "<IMG", "<Img ", "<", ">", " ", "src=", "SRC=", "Src=", "data-src=",
      '"', "'", "a", "bb", "=", "/", "x.jpg", "<im", "img", "\n", "ſrc=", "İ",
    ];

    // Small deterministic LCG so a failure reproduces.
    function rng(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
        return s / 0x100000000;
      };
    }

    function randomHtml(next: () => number): string {
      const n = 1 + Math.floor(next() * 28);
      let out = "";
      for (let i = 0; i < n; i++) {
        out += TOKENS[Math.floor(next() * TOKENS.length)];
      }
      return out;
    }

    it("matches the regex on 6,000 random token strings (default bounds)", () => {
      const next = rng(0x5eed);
      for (let i = 0; i < 6000; i++) {
        const html = randomHtml(next);
        expect({ html, got: findInlineImgSrc(html, CAP) }).toEqual({
          html,
          got: reference(html, CAP, 1000),
        });
      }
    });

    it("matches the regex with a tiny run bound and a tiny cap (bounds are exercised)", () => {
      const next = rng(0xbadc0de);
      for (let i = 0; i < 6000; i++) {
        const html = randomHtml(next);
        const run = 1 + Math.floor(next() * 12);
        const cap = 4 + Math.floor(next() * 50);
        expect({ html, run, cap, got: findInlineImgSrc(html, cap, run) }).toEqual({
          html,
          run,
          cap,
          got: reference(html, cap, run),
        });
      }
    });
  });
});

describe("findInlineImgSrc: linear time on hostile bodies", () => {
  const CAP = 50_000;
  // Load-robust (tests/_helpers/linear-time.ts): the guard is how CPU time GROWS over
  // a body-size ladder (6k .. 50 KB), 10 bodies per timed call, not a wall-clock
  // number. The 2000 ms ceiling is 20x the old 100 ms budget; the bounded regex
  // this scanner replaced needed 140-170 ms for the same 10 bodies at the top rung.
  // The whole-feed budget in normalize.test.ts is the hard guard (22 s+ pre-fix).
  const BODIES_PER_CALL = 10;

  const tenBodies = (body: string): void => {
    for (let i = 0; i < BODIES_PER_CALL; i++) findInlineImgSrc(body, CAP);
  };

  // [label, generator, top rung]. The three "49 KB" rows keep their old size: their affix
  // ('<img src="x"' after the run of '<') must stay inside the first CAP characters,
  // otherwise findInlineImgSrc slices the hostile tail off and the top rung measures nothing.
  const HOSTILE: ReadonlyArray<readonly [string, Gen, number]> = [
    ["12,500 x '<img'", rep("<img"), CAP],
    ["10,000 x '<img '", rep("<img "), CAP],
    ["8,000 x '<img a'", rep("<img a"), CAP],
    ["5,000 x '<img src=\"'", rep('<img src="'), CAP],
    ["8,000 x '<img src='", rep("<img src="), CAP],
    ["'<img ' + 12,000 x 'src='", rep("src=", "<img "), CAP],
    ["'<img' + 49 KB of '='", rep("=", "<img"), 49_000],
    ["'<img a' + 49 KB of '<'", rep("<", "<img a"), 49_000],
    ["49 KB of '<' then '<img src=\"x\"' without '>'", rep("<", "", '<img src="x"'), 49_000],
    ["25,000 x 'src=\"'", rep('src="'), CAP],
    ["10,000 x '<img src=\"a\"' no '>'", rep('<img src="a"'), CAP],
  ];

  for (const [label, gen, n] of HOSTILE) {
    it(`${label} scales linearly per 50 KB body`, () => {
      expectLinear(gen, tenBodies, { n, ceilingMs: 2_000 });
    });
  }

  it("the tail row's top input keeps its hostile tail inside the cap", () => {
    const top = rep("<", "", '<img src="x"')(49_000);
    expect(top.length).toBeLessThanOrEqual(CAP);
    expect(top.endsWith('<img src="x"')).toBe(true);
  });

  it("the 160-item feed total stays far below the 2 s isolate limit", () => {
    const body = "<img".repeat(12_500);
    // CPU time, not wall time: the isolate limit is a CPU limit too.
    expectCpuUnder(() => {
      for (let i = 0; i < 160; i++) findInlineImgSrc(body, CAP);
    }, 150);
  });

  it("scales linearly: 8x the input (5 KB to 40 KB, no cap in the way) costs about 8x the CPU time", () => {
    expectLinear(
      rep("<img "),
      (body) => {
        for (let i = 0; i < 20; i++) findInlineImgSrc(body, 1_000_000);
      },
      { n: 40_000, ceilingMs: 2_000 },
    );
  });
});
