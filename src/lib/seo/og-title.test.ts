import { describe, expect, it } from "vitest";

import {
  OG_TITLE_LINE_HEIGHT,
  OG_TITLE_MAX_CHARS,
  OG_TITLE_MAX_LINES,
  clampOgTitle,
} from "./og-title";

// Hunt 20, h20-contracts-1. The cluster OG card (1200x630) cut a long headline
// with `slice(0, max - 3) + "…"` (mid-word: "...Töreni'ne kat…") and allowed
// 110 plain characters at 64 px, which wraps to 4 lines and pushes the legend
// row off the canvas. clampOgTitle() picks the text and the font size.
//
// Both fixtures are the real stored titles as they were when the card was
// measured (2026-11-02); both clusters have been re-titled since, so the strings
// are pinned here instead of being read back from the database.

/** Cluster 7bc7a2c3-eed1-466b-a2ae-d0b439e9278e, 110 characters, no ribbon. */
const TITLE_110 =
  "Eşinin 'köy yerinde kimse gelmez' sözüne rağmen pes etmeyen kadın, mor renkli eviyle kendi işinin patronu oldu";

/** Cluster 594667c9-5ed8-49a1-af1a-b1b5530ed304 (a blindspot), 96 characters. */
const TITLE_96_RIBBON =
  "İlim Yayma Vakfı Mütevelli Heyeti Başkanı Bilal Erdoğan, HKÜ'de 'Akademik Ödül Töreni'ne katıldı";

const cp = (s: string): number => Array.from(s).length;

/** A title of exactly `n` code points made of 5-letter words and single spaces. */
function wordsOfLength(n: number): string {
  let out = "";
  while (out.length < n) out += "kelime ";
  return out.slice(0, n).trimEnd().padEnd(n, "x");
}

/** True when `s` holds a lone UTF-16 surrogate. */
function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("clampOgTitle constants", () => {
  it("exports the caps and the title box metrics the card uses", () => {
    expect(OG_TITLE_MAX_CHARS).toEqual({ plain: 130, ribbon: 95 });
    expect(OG_TITLE_LINE_HEIGHT).toBe(1.1);
    expect(OG_TITLE_MAX_LINES).toBe(3);
  });
});

describe("clampOgTitle fixtures", () => {
  it("the fixtures have the lengths the hunt measured", () => {
    expect(cp(TITLE_110)).toBe(110);
    expect(cp(TITLE_96_RIBBON)).toBe(96);
  });

  it("a short title is unchanged at 64 px (56 px under the ribbon)", () => {
    const title = "Test kümesi başlığı";
    expect(clampOgTitle(title, { ribbon: false })).toEqual({ text: title, fontSize: 64 });
    expect(clampOgTitle(title, { ribbon: true })).toEqual({ text: title, fontSize: 56 });
  });

  it("an 80-character title is still in the first tier, 81 is in the second", () => {
    const t80 = wordsOfLength(80);
    const t81 = wordsOfLength(81);
    expect(cp(t80)).toBe(80);
    expect(cp(t81)).toBe(81);
    expect(clampOgTitle(t80, { ribbon: false })).toEqual({ text: t80, fontSize: 64 });
    expect(clampOgTitle(t80, { ribbon: true })).toEqual({ text: t80, fontSize: 56 });
    expect(clampOgTitle(t81, { ribbon: false })).toEqual({ text: t81, fontSize: 52 });
    expect(clampOgTitle(t81, { ribbon: true })).toEqual({ text: t81, fontSize: 52 });
  });

  it("an 81-100 character plain title is unchanged at 52 px", () => {
    for (const n of [81, 90, 100]) {
      const t = wordsOfLength(n);
      expect(clampOgTitle(t, { ribbon: false }), `${n} chars`).toEqual({ text: t, fontSize: 52 });
    }
  });

  it("an 81-95 character ribbon title is unchanged at 52 px", () => {
    for (const n of [81, 90, 95]) {
      const t = wordsOfLength(n);
      expect(clampOgTitle(t, { ribbon: true }), `${n} chars`).toEqual({ text: t, fontSize: 52 });
    }
  });

  it("the 110-character 7bc7a2c3 title is unchanged at 44 px", () => {
    expect(clampOgTitle(TITLE_110, { ribbon: false })).toEqual({ text: TITLE_110, fontSize: 44 });
  });

  it("a 101-130 character plain title is unchanged at 44 px", () => {
    for (const n of [101, 120, 130]) {
      const t = wordsOfLength(n);
      expect(clampOgTitle(t, { ribbon: false }), `${n} chars`).toEqual({ text: t, fontSize: 44 });
    }
  });

  it("the 96-character 594667c9 ribbon title is cut at a word, never as 'kat…'", () => {
    const { text, fontSize } = clampOgTitle(TITLE_96_RIBBON, { ribbon: true });
    expect(text.length).toBeLessThanOrEqual(95);
    expect(text.endsWith("…")).toBe(true);
    expect(text.endsWith("kat…")).toBe(false);
    expect(text).not.toContain("kat…");
    const body = text.slice(0, -1);
    // The kept text is a whole-word prefix: the original goes on with a blank.
    expect(TITLE_96_RIBBON.startsWith(body)).toBe(true);
    expect(TITLE_96_RIBBON.charAt(body.length)).toBe(" ");
    expect(body).toBe("İlim Yayma Vakfı Mütevelli Heyeti Başkanı Bilal Erdoğan, HKÜ'de 'Akademik Ödül Töreni'ne");
    // 89 characters: the second tier.
    expect(cp(text)).toBe(89);
    expect(fontSize).toBe(52);
  });

  it("the same 96-character title without a ribbon is unchanged (the plain cap is 130)", () => {
    expect(clampOgTitle(TITLE_96_RIBBON, { ribbon: false })).toEqual({
      text: TITLE_96_RIBBON,
      fontSize: 52,
    });
  });
});

describe("clampOgTitle long titles", () => {
  const WORDS_200 = wordsOfLength(200);

  it("a 200-character title is cut to <= 130 plain and <= 95 under the ribbon, at a word boundary", () => {
    expect(cp(WORDS_200)).toBe(200);
    for (const [ribbon, max] of [
      [false, 130],
      [true, 95],
    ] as const) {
      const { text } = clampOgTitle(WORDS_200, { ribbon });
      expect(cp(text), `ribbon=${ribbon}`).toBeLessThanOrEqual(max);
      expect(text.endsWith("…")).toBe(true);
      const body = text.slice(0, -1);
      expect(WORDS_200.startsWith(body)).toBe(true);
      expect(WORDS_200.charAt(body.length)).toBe(" ");
      // Only whole 'kelime' words are kept.
      expect(body.split(" ").every((w) => w === "kelime")).toBe(true);
    }
  });

  it("the cut keeps as many whole words as fit: 'kelime ' x 40 gives 18 words plain, 13 words ribbon", () => {
    // Blanks sit at indexes 6, 13, 20 ... (7k + 6). Plain keeps the first 129
    // code points (indexes 0-128): the last blank in them is 125 -> 18 words.
    // Ribbon keeps 94 (indexes 0-93): the last blank is 90 -> 13 words.
    const long = "kelime ".repeat(40).trimEnd();
    expect(clampOgTitle(long, { ribbon: false }).text).toBe(`${"kelime ".repeat(17)}kelime…`);
    expect(clampOgTitle(long, { ribbon: true }).text).toBe(`${"kelime ".repeat(12)}kelime…`);
  });

  it("when the first code point after the kept run is a blank, the whole last word is kept", () => {
    // Ribbon cap 95: the kept run is 94 code points (indexes 0-93) + '…' = 95.
    // Blank at index 94: the 94 letters before it are a whole word.
    const blankAt94 = `${"a".repeat(94)} ${"b".repeat(20)}`;
    const kept = clampOgTitle(blankAt94, { ribbon: true }).text;
    expect(kept).toBe(`${"a".repeat(94)}…`);
    expect(cp(kept)).toBe(95);
    // Blank at index 93 (inside the kept run): the cut is there.
    const blankAt93 = `${"a".repeat(93)} ${"b".repeat(20)}`;
    expect(clampOgTitle(blankAt93, { ribbon: true }).text).toBe(`${"a".repeat(93)}…`);
    // No blank at 94 or before 57: the word 'bbbbb' straddles the cut and goes.
    const straddle = `${"a".repeat(90)} ${"b".repeat(20)}`;
    expect(clampOgTitle(straddle, { ribbon: true }).text).toBe(`${"a".repeat(90)}…`);
  });

  it("a title of exactly the cap is not touched; one code point more is", () => {
    for (const [ribbon, max] of [
      [false, 130],
      [true, 95],
    ] as const) {
      const exact = wordsOfLength(max);
      expect(clampOgTitle(exact, { ribbon }).text).toBe(exact);
      const over = wordsOfLength(max + 1);
      const out = clampOgTitle(over, { ribbon }).text;
      expect(out).not.toBe(over);
      expect(cp(out)).toBeLessThanOrEqual(max);
      expect(out.endsWith("…")).toBe(true);
    }
  });

  it("a 140-character single word is hard-cut at max-1 characters plus '…'", () => {
    const word = "x".repeat(140);
    const plain = clampOgTitle(word, { ribbon: false }).text;
    const ribbon = clampOgTitle(word, { ribbon: true }).text;
    expect(plain).toBe(`${"x".repeat(129)}…`);
    expect(cp(plain)).toBe(130);
    expect(ribbon).toBe(`${"x".repeat(94)}…`);
    expect(cp(ribbon)).toBe(95);
  });

  it("a blank earlier than 60% of the cap is not used: the cut is a hard cut instead", () => {
    // Blank at index 10 (well under 57), then a 150-character word.
    const title = `${"a".repeat(10)} ${"b".repeat(150)}`;
    expect(clampOgTitle(title, { ribbon: true }).text).toBe(`${title.slice(0, 94)}…`);
    expect(clampOgTitle(title, { ribbon: false }).text).toBe(`${title.slice(0, 129)}…`);
  });

  it("the 60% threshold is inclusive: a blank at index 57 (ribbon) is used, one at 56 is not", () => {
    const at57 = `${"a".repeat(57)} ${"b".repeat(60)}`;
    expect(clampOgTitle(at57, { ribbon: true }).text).toBe(`${"a".repeat(57)}…`);
    const at56 = `${"a".repeat(56)} ${"b".repeat(60)}`;
    expect(clampOgTitle(at56, { ribbon: true }).text).toBe(`${at56.slice(0, 94)}…`);
  });

  it("drops trailing ',', ':', ';', '-', en and em dashes (and blanks) left at the cut", () => {
    for (const mark of [",", ":", ";", "-", "–", "—"]) {
      const title = `${"a".repeat(70)}${mark} ${"b".repeat(60)}`;
      const out = clampOgTitle(title, { ribbon: true }).text;
      expect(out, mark).toBe(`${"a".repeat(70)}…`);
    }
    // Blanks and several marks in a row are all dropped.
    const stacked = `${"a".repeat(70)} , - ; ${"b".repeat(60)}`;
    expect(clampOgTitle(stacked, { ribbon: true }).text).toBe(`${"a".repeat(70)}…`);
  });

  it("keeps a trailing '.', '!' or '?' (only the clause marks are dropped)", () => {
    for (const mark of [".", "!", "?"]) {
      const title = `${"a".repeat(70)}${mark} ${"b".repeat(60)}`;
      expect(clampOgTitle(title, { ribbon: true }).text, mark).toBe(`${"a".repeat(70)}${mark}…`);
    }
  });

  it("keeps the cut text when stripping the marks would leave nothing", () => {
    const dashes = "-".repeat(200);
    const out = clampOgTitle(dashes, { ribbon: true }).text;
    expect(out).toBe(`${"-".repeat(94)}…`);
  });

  it("never splits an emoji: a hard cut counts code points", () => {
    // 128 letters then a 2-code-unit emoji at code point 129: a UTF-16 slice at
    // 129 would cut the surrogate pair in half.
    const title = `${"a".repeat(128)}😀${"b".repeat(30)}`;
    const { text } = clampOgTitle(title, { ribbon: false });
    expect(hasLoneSurrogate(text)).toBe(false);
    expect(text).toBe(`${"a".repeat(128)}😀…`);
    expect(Array.from(text)).toHaveLength(130);
  });

  it("never splits an emoji at a word cut either", () => {
    const body = `${"😀 ".repeat(100)}end`; // 203 code points: emoji words, 2 code units each
    for (const ribbon of [false, true]) {
      const { text } = clampOgTitle(body, { ribbon });
      expect(hasLoneSurrogate(text), `ribbon=${ribbon}`).toBe(false);
      const kept = Array.from(text.slice(0, -1));
      expect(kept.every((c) => c === "😀" || c === " ")).toBe(true);
      expect(kept.length).toBeLessThanOrEqual((ribbon ? 95 : 130) - 1);
    }
  });

  it("counts a title of emoji by code points, not UTF-16 units", () => {
    // 100 emoji = 200 UTF-16 units = 100 code points: second tier, not clamped
    // for the plain card (cap 130), clamped for the ribbon (cap 95).
    const emoji = "😀".repeat(100);
    expect(clampOgTitle(emoji, { ribbon: false })).toEqual({ text: emoji, fontSize: 52 });
    const ribbon = clampOgTitle(emoji, { ribbon: true });
    expect(Array.from(ribbon.text)).toHaveLength(95);
    expect(ribbon.text).toBe(`${"😀".repeat(94)}…`);
  });

  it("a title with a non-breaking space cuts there like at a plain blank", () => {
    const title = `${"a".repeat(70)} ${"b".repeat(60)}`;
    expect(clampOgTitle(title, { ribbon: true }).text).toBe(`${"a".repeat(70)}…`);
  });

  it("a tab or newline inside a long title is a word boundary too", () => {
    for (const ws of ["\t", "\n", "\r\n"]) {
      const title = `${"a".repeat(70)}${ws}${"b".repeat(60)}`;
      expect(clampOgTitle(title, { ribbon: true }).text, JSON.stringify(ws)).toBe(`${"a".repeat(70)}…`);
    }
  });
});

describe("clampOgTitle robustness", () => {
  it("is pure and deterministic: the same input gives equal output, call after call", () => {
    const first = clampOgTitle(TITLE_96_RIBBON, { ribbon: true });
    // Interleave other calls: no state is carried between them.
    clampOgTitle("başka bir başlık", { ribbon: false });
    clampOgTitle("x".repeat(500), { ribbon: true });
    const second = clampOgTitle(TITLE_96_RIBBON, { ribbon: true });
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("does not depend on the options object being reused or frozen", () => {
    const opts = Object.freeze({ ribbon: true });
    expect(clampOgTitle(TITLE_96_RIBBON, opts)).toEqual(clampOgTitle(TITLE_96_RIBBON, { ribbon: true }));
  });

  it("an empty title stays empty at the first tier", () => {
    expect(clampOgTitle("", { ribbon: false })).toEqual({ text: "", fontSize: 64 });
    expect(clampOgTitle("", { ribbon: true })).toEqual({ text: "", fontSize: 56 });
  });

  it("a non-string title (null, undefined, number) gives an empty text and never throws", () => {
    for (const bad of [null, undefined, 42, {}, []]) {
      expect(clampOgTitle(bad as unknown as string, { ribbon: false })).toEqual({ text: "", fontSize: 64 });
    }
  });

  it("keeps Turkish diacritics, quotes and an existing ellipsis intact when nothing is cut", () => {
    const t = "İstanbul'da “ğüşiöç” İĞÜŞÖÇ… 100% 3,5 milyar ₺";
    expect(clampOgTitle(t, { ribbon: false }).text).toBe(t);
  });

  it("a 1 MB title finishes quickly and still yields a capped text", () => {
    const huge = "kelime ".repeat(150_000);
    const start = performance.now();
    const { text } = clampOgTitle(huge, { ribbon: true });
    expect(performance.now() - start).toBeLessThan(50);
    expect(cp(text)).toBeLessThanOrEqual(95);
    expect(text.endsWith("…")).toBe(true);
  });

  it("never exceeds the cap for any length from 0 to 400 and always picks one of the four sizes", () => {
    const allowed = new Set([64, 56, 52, 44]);
    for (let n = 0; n <= 400; n++) {
      const title = wordsOfLength(n);
      for (const ribbon of [false, true]) {
        const max = ribbon ? 95 : 130;
        const out = clampOgTitle(title, { ribbon });
        expect(cp(out.text), `n=${n} ribbon=${ribbon}`).toBeLessThanOrEqual(max);
        expect(allowed.has(out.fontSize), `n=${n} size=${out.fontSize}`).toBe(true);
        if (n <= max) expect(out.text).toBe(title);
        else expect(out.text.endsWith("…")).toBe(true);
      }
    }
  });

  it("the font size follows the FINAL length: a 200-character title lands in the tier of its cut", () => {
    const long = wordsOfLength(200);
    // plain cut is ~120 characters -> 44; ribbon cut is ~90 -> 52.
    const plain = clampOgTitle(long, { ribbon: false });
    const ribbon = clampOgTitle(long, { ribbon: true });
    expect(cp(plain.text)).toBeGreaterThan(100);
    expect(plain.fontSize).toBe(44);
    expect(cp(ribbon.text)).toBeGreaterThan(80);
    expect(ribbon.fontSize).toBe(52);
  });
});
