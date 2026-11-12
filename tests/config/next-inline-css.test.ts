import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// h159-perf-1: experimental.inlineCss. On every page FCP was "render-blocking
// stylesheet ends + ~65 ms" (20 KB br, ends late because it fair-shares a slow
// link with fonts, async JS and the LCP image). With the sheet in the document
// head, first paint needs only the first ~25 KB br of the HTML. The flag is read
// from the config SOURCE (the config itself is not imported: it pulls in the
// whole Next toolchain), like the other tests/config files.
//
// Only code lines are scanned: a comment that quotes the flag (this very change
// documents it) must not satisfy, or break, the assertions. The one regex is
// linear (a single negated-class run), and the line filter uses startsWith.

const root = join(__dirname, "..", "..");
const src = readFileSync(join(root, "next.config.ts"), "utf8");

/** The lines of a TypeScript source that are not whole-line comments (//, /* ... or a * continuation). */
function codeLinesOf(text: string): string[] {
  return text.split("\n").filter((line) => {
    const t = line.trim();
    return t !== "" && !t.startsWith("//") && !t.startsWith("/*") && !t.startsWith("*");
  });
}

const codeLines = codeLinesOf(src);
const code = codeLines.join("\n");

// One negated-class run between the braces: linear in the length of the text.
const INLINE_CSS_ON = /\bexperimental\s*:\s*\{[^}]*\binlineCss\s*:\s*true\b/;

describe("next.config.ts experimental.inlineCss (h159-perf-1)", () => {
  it("turns inlineCss on under experimental", () => {
    expect(code).toMatch(INLINE_CSS_ON);
  });

  it("sits directly after `cacheComponents: true,` (no other config key moved)", () => {
    const at = codeLines.findIndex((l) => l.trim() === "cacheComponents: true,");
    expect(at).toBeGreaterThan(-1);
    expect((codeLines[at + 1] ?? "").trim()).toBe("experimental: { inlineCss: true },");
  });

  it("keeps `cacheComponents: true`", () => {
    expect(codeLines.some((l) => l.trim() === "cacheComponents: true,")).toBe(true);
  });

  it("keeps the four custom cacheLife profiles", () => {
    for (const name of ["cluster-feed", "source-directory", "status", "weekly-words"]) {
      const quoted = codeLines.some((l) => l.includes(`'${name}'`) || l.includes(`"${name}"`));
      expect(quoted, `cacheLife profile '${name}' must stay in next.config.ts`).toBe(true);
    }
  });

  it("keeps the image qualities [50, 75, 90]", () => {
    expect(code).toContain("qualities: [50, 75, 90]");
  });
});

describe("the inlineCss matcher has teeth", () => {
  it("accepts the flag in several layouts", () => {
    expect(INLINE_CSS_ON.test("experimental: { inlineCss: true },")).toBe(true);
    expect(INLINE_CSS_ON.test("experimental : {\n  inlineCss : true,\n}")).toBe(true);
    expect(INLINE_CSS_ON.test("experimental: { other: 1, inlineCss: true }")).toBe(true);
  });

  it("rejects a disabled flag, a missing flag and another key", () => {
    expect(INLINE_CSS_ON.test("experimental: { inlineCss: false },")).toBe(false);
    expect(INLINE_CSS_ON.test("experimental: { other: true },")).toBe(false);
    expect(INLINE_CSS_ON.test("inlineCss: true,")).toBe(false);
    expect(INLINE_CSS_ON.test("experimental: {}, inlineCss: true")).toBe(false);
    expect(INLINE_CSS_ON.test("experimental: { notinlineCss: true }")).toBe(false);
  });

  it("is not fooled by a comment that quotes the flag", () => {
    const commented = ["// experimental: { inlineCss: true },", " * experimental: { inlineCss: true }", "/* experimental: { inlineCss: true } */"];
    expect(codeLinesOf(commented.join("\n"))).toEqual([]);
    expect(codeLinesOf(`${commented.join("\n")}\n  experimental: { inlineCss: true },`)).toEqual([
      "  experimental: { inlineCss: true },",
    ]);
  });
});
