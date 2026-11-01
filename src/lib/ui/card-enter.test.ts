import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { cardEnterClass } from "./card-enter";

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(join(here, "..", "..", "..", rel), "utf8");

describe("cardEnterClass", () => {
  it("gives card 0 no entrance animation in either mode (it is the LCP card)", () => {
    expect(cardEnterClass(0)).toBe("");
    expect(cardEnterClass(0, "wrap8")).toBe("");
    expect(cardEnterClass(0, "cap6")).toBe("");
  });

  describe("wrap8 (home feed: (idx % 8) + 1)", () => {
    it.each([
      [1, "animate-fade-up stagger-2"],
      [2, "animate-fade-up stagger-3"],
      [7, "animate-fade-up stagger-8"],
      [8, "animate-fade-up stagger-1"],
      [9, "animate-fade-up stagger-2"],
      [15, "animate-fade-up stagger-8"],
      [16, "animate-fade-up stagger-1"],
      [1000, "animate-fade-up stagger-1"],
    ])("idx %i -> %j", (idx, expected) => {
      expect(cardEnterClass(idx)).toBe(expected);
      expect(cardEnterClass(idx, "wrap8")).toBe(expected);
    });
  });

  describe("cap6 (/blindspots: i < 6 ? i + 1 : 6)", () => {
    it.each([
      [1, "animate-fade-up stagger-2"],
      [4, "animate-fade-up stagger-5"],
      [5, "animate-fade-up stagger-6"],
      [6, "animate-fade-up stagger-6"],
      [9, "animate-fade-up stagger-6"],
      [500, "animate-fade-up stagger-6"],
    ])("idx %i -> %j", (idx, expected) => {
      expect(cardEnterClass(idx, "cap6")).toBe(expected);
    });
  });

  it.each([-1, -100, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "returns '' for the invalid index %s in both modes",
    (idx) => {
      expect(cardEnterClass(idx)).toBe("");
      expect(cardEnterClass(idx, "cap6")).toBe("");
    },
  );

  it("floors a fractional index instead of leaking a bad class name", () => {
    expect(cardEnterClass(1.9)).toBe("animate-fade-up stagger-2");
    expect(cardEnterClass(0.5)).toBe("");
  });

  it("only ever returns classes that globals.css defines (stagger-1 .. stagger-8)", () => {
    const css = read("src/app/globals.css");
    for (const mode of ["wrap8", "cap6"] as const) {
      for (let i = 0; i < 40; i++) {
        const cls = cardEnterClass(i, mode);
        if (cls === "") continue;
        const [anim, stagger] = cls.split(" ");
        expect(anim).toBe("animate-fade-up");
        expect(css).toContain(`.${stagger} {`);
      }
    }
  });
});

describe("page call sites", () => {
  it.each(["src/app/page.tsx", "src/app/blindspots/page.tsx"])(
    "%s uses cardEnterClass and no stagger template literal",
    (rel) => {
      const src = read(rel);
      expect(src).toContain("cardEnterClass(");
      expect(src).not.toContain("stagger-${");
    },
  );

  it("home renders the wrapper className as `cardEnterClass(idx) || undefined`", () => {
    expect(read("src/app/page.tsx")).toContain("className={cardEnterClass(idx) || undefined}");
  });

  it("/blindspots renders the wrapper className as `cardEnterClass(i, 'cap6') || undefined`", () => {
    expect(read("src/app/blindspots/page.tsx")).toMatch(
      /className=\{cardEnterClass\(i, ["']cap6["']\) \|\| undefined\}/,
    );
  });
});
