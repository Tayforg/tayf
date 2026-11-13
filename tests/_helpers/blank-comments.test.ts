import { describe, expect, it } from "vitest";

import { blankComments } from "./blank-comments";
import { expectLinear, rep } from "./linear-time";

describe("blankComments", () => {
  it("blanks line and block comments, keeping offsets and newlines", () => {
    const src = "a // x\nb /* y\nz */ c";
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toBe("a     \nb     \n     c");
  });

  it("keeps a // inside a string literal (a URL is not a comment)", () => {
    const src = 'const u = "http://example.com"; // gone';
    expect(blankComments(src)).toBe('const u = "http://example.com";        ');
  });

  it("keeps a comment marker inside a template or a single-quoted string", () => {
    expect(blankComments("x = `a /* b */ c`;")).toBe("x = `a /* b */ c`;");
    expect(blankComments("x = 'a // b';")).toBe("x = 'a // b';");
  });

  it("honours an escaped quote inside a string", () => {
    const src = 'x = "a \\" // still string"; // comment';
    expect(blankComments(src)).toBe('x = "a \\" // still string";           ');
  });

  it("an unterminated block comment blanks to the end; an unterminated string is copied through", () => {
    expect(blankComments("a /* never closed")).toBe("a                ");
    expect(blankComments('a "never closed')).toBe('a "never closed');
  });

  it("is linear on a long run of slashes and of comment openers", () => {
    const options = { n: 200_000, ceilingMs: 4_000 };
    expectLinear(rep("/"), blankComments, options);
    expectLinear(rep("/*"), blankComments, options);
    expectLinear(rep("/* "), blankComments, options);
    expectLinear(rep('"\\'), blankComments, options);
  });
});
