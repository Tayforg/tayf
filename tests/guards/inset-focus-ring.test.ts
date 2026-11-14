import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 2.4.7 / 2.4.11 (focus visible), second sweep of the h148-keyboard-1 defect
// class: a focus indicator drawn OUTSIDE an element that sits flush with the
// padding box of an overflow scroller is clipped by that scroller (h178-keyboard-1).
//
//  1. /kaynaklar/durum: the 118 outlet links of the sticky first column sit at
//     x = 0 of the `overflow-x-auto` region (the th has no left padding), so the
//     default outside ring lost its left side on every row.
//  2. /ekonomi in forced colors: the market-strip chips already use an inset ring
//     (`focus-visible:ring-inset`), but forced colors drops box-shadow and the
//     unlayered globals.css `:focus-visible { outline: 2px solid Highlight;
//     outline-offset: 2px }` restores an OUTSIDE outline instead, whose top band
//     (and the outer side of the end chips) is clipped by the strip.
//
// The fix: the durum link gets the ticker-chip pattern (inset ring on its own box),
// and globals.css gives every `focus-visible:ring-inset` element an inset outline in
// forced colors. These assertions keep a refactor from quietly dropping either half.
//
// globals.css is scanned with a brace-matching character scan (comments and strings
// skipped); JSX is sliced with the character scan of ekonomi-outlet-focus-ring.test.ts.
// No regex ever runs over markup or CSS.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const SRC_DIR = join(ROOT, "src");
const GLOBALS_CSS = readFileSync(join(SRC_DIR, "app/globals.css"), "utf8");
const DURUM_PAGE = readFileSync(join(SRC_DIR, "app/kaynaklar/durum/page.tsx"), "utf8");

const INSET_SELECTOR = ".focus-visible\\:ring-inset:focus-visible";
const FORCED_COLORS_PRELUDE = "(forced-colors: active)";

// --------------------------------------------------------------------------
// CSS scanner (character scan)
// --------------------------------------------------------------------------

/** Index just past the block comment that opens at `i`, or the end of `css` when it never closes. */
function skipCssComment(css: string, i: number): number {
  const end = css.indexOf("*/", i + 2);
  return end === -1 ? css.length : end + 2;
}

/** Index just past the CSS string that opens at `i` (src[i] is ' or "), honouring `\` escapes. */
function skipCssString(css: string, i: number): number {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== quote) {
    if (css[j] === "\\") j++;
    j++;
  }
  return j + 1;
}

/** Index just past the `}` that closes the `{` at `i`; throws when it never closes. */
function skipCssBlock(css: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < css.length) {
    const c = css[j];
    if (c === "/" && css[j + 1] === "*") {
      j = skipCssComment(css, j);
      continue;
    }
    if (c === '"' || c === "'") {
      j = skipCssString(css, j);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  throw new Error(`unbalanced '{' at ${i}`);
}

/** Collapses every whitespace run to one space and trims, with no regex. */
function squash(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

type CssBlock = {
  /** Text between the previous statement and the `{`, comments removed, whitespace squashed. */
  prelude: string;
  /** Raw text between the braces, comments kept. */
  body: string;
  /** Index of the `{` in the scanned text. */
  at: number;
};

/**
 * The blocks that open at brace depth 0 of `css` (statements ending in `;` such as
 * `@import` carry no block and are skipped). A block nested in another block, for
 * example an `@media` inside `@layer base { }`, is not returned.
 */
function topLevelBlocks(css: string): CssBlock[] {
  const out: CssBlock[] = [];
  let stmtStart = 0;
  let j = 0;
  let prelude = "";
  while (j < css.length) {
    const c = css[j];
    if (c === "/" && css[j + 1] === "*") {
      prelude += css.slice(stmtStart, j);
      j = skipCssComment(css, j);
      stmtStart = j;
      continue;
    }
    if (c === '"' || c === "'") {
      j = skipCssString(css, j);
      continue;
    }
    if (c === ";") {
      prelude = "";
      j++;
      stmtStart = j;
      continue;
    }
    if (c === "{") {
      const end = skipCssBlock(css, j);
      out.push({ prelude: squash(prelude + css.slice(stmtStart, j)), body: css.slice(j + 1, end - 1), at: j });
      prelude = "";
      j = end;
      stmtStart = j;
      continue;
    }
    j++;
  }
  return out;
}

type CssRule = { selector: string; decls: Record<string, string>; at: number };

/** The style rules of a block body (nested at-rules are not expected inside forced-colors and are skipped). */
function rulesOf(body: string): CssRule[] {
  return topLevelBlocks(body)
    .filter((b) => !b.prelude.startsWith("@"))
    .map((b) => {
      const decls: Record<string, string> = {};
      let from = 0;
      let text = "";
      // Drop comments inside the declaration list, then split on `;`.
      while (from < b.body.length) {
        const open = b.body.indexOf("/*", from);
        if (open === -1) {
          text += b.body.slice(from);
          break;
        }
        text += b.body.slice(from, open);
        from = skipCssComment(b.body, open);
      }
      for (const decl of text.split(";")) {
        const colon = decl.indexOf(":");
        if (colon === -1) continue;
        decls[squash(decl.slice(0, colon))] = squash(decl.slice(colon + 1));
      }
      return { selector: b.prelude, decls, at: b.at };
    });
}

/** `"-2px"` -> -2, `"2px"` -> 2, anything that is not a plain px length -> NaN. */
function px(value: string | undefined): number {
  if (value === undefined || !value.endsWith("px")) return Number.NaN;
  return Number(value.slice(0, -2));
}

// --------------------------------------------------------------------------
// Source scanner: className literals holding a token
// --------------------------------------------------------------------------

/** True when the line that holds index `at` of `src` is a comment line (`//`, `/*`, `*` or `{/*`), so prose never counts as a class list. */
function onCommentLine(src: string, at: number): boolean {
  const lineStart = src.lastIndexOf("\n", at) + 1;
  const head = src.slice(lineStart, at).trimStart();
  return head.startsWith("//") || head.startsWith("/*") || head.startsWith("*") || head.startsWith("{/*");
}

/**
 * The quoted literal ("...", '...' or `...`) around each occurrence of `token` in
 * `src`: from the nearest quote character before it to the next one of the same kind.
 * A class list never holds a quote character, so this reads the whole class string.
 * Occurrences on comment lines are skipped.
 */
function literalsContaining(src: string, token: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = src.indexOf(token, from);
    if (at === -1) break;
    from = at + token.length;
    if (onCommentLine(src, at)) continue;
    let start = at - 1;
    while (start >= 0 && src[start] !== '"' && src[start] !== "'" && src[start] !== "`") start--;
    if (start < 0) continue;
    const end = src.indexOf(src[start]!, at);
    if (end === -1) continue;
    out.push(src.slice(start + 1, end));
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      sourceFiles(full, out);
    } else if ((name.endsWith(".tsx") || name.endsWith(".ts")) && !name.includes(".test.")) {
      out.push(full);
    }
  }
  return out;
}

// --------------------------------------------------------------------------
// JSX opening-tag slicer (character scan), as in tests/guards/ekonomi-outlet-focus-ring.test.ts
// --------------------------------------------------------------------------

/** Index just past the string literal that opens at `i` (src[i] is ' or "). */
function skipQuoted(src: string, i: number): number {
  const quote = src[i];
  let j = i + 1;
  while (j < src.length && src[j] !== quote) {
    if (src[j] === "\\") j++;
    j++;
  }
  return j + 1;
}

/** Index just past the template literal that opens at `i` (src[i] is a backtick), `${ }` aware. */
function skipTemplate(src: string, i: number): number {
  let j = i + 1;
  while (j < src.length && src[j] !== "`") {
    if (src[j] === "\\") {
      j += 2;
      continue;
    }
    if (src[j] === "$" && src[j + 1] === "{") {
      j = skipBraces(src, j + 1);
      continue;
    }
    j++;
  }
  return j + 1;
}

/** Index just past the `{ ... }` expression that opens at `i` (src[i] is '{'). */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === "`") {
      j = skipTemplate(src, j);
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return j + 1;
    }
    j++;
  }
  throw new Error(`unbalanced '{' at ${i}`);
}

/**
 * The opening tag starting at `src[start] === "<"`, through its closing `>`.
 * Attribute values in quotes or braces (arrow functions, template literals,
 * `=>`) never end the tag.
 */
function openingTag(src: string, start: number): string {
  let j = start + 1;
  while (j < src.length) {
    const c = src[j];
    if (c === '"' || c === "'") j = skipQuoted(src, j);
    else if (c === "{") j = skipBraces(src, j);
    else if (c === ">") return src.slice(start, j + 1);
    else j++;
  }
  throw new Error(`unterminated tag at ${start}`);
}

function isSpace(c: string | undefined): boolean {
  return c === " " || c === "\n" || c === "\t" || c === "\r";
}

/** True when `c` ends an element name: whitespace, `>` (`<ol>`) or `/` (`<br/>`), not a longer name. */
function isNameEnd(c: string | undefined): boolean {
  return isSpace(c) || c === ">" || c === "/";
}

/** Every opening tag of element `name` (`Link`, `th`) in `src`, in source order. */
function tagsNamed(src: string, name: string): string[] {
  const out: string[] = [];
  const open = `<${name}`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(open, from);
    if (at === -1) break;
    from = at + open.length;
    // `<Link` must end the name there, not be a prefix of `<LinkFoo` / `<Link.`.
    if (!isNameEnd(src[at + open.length])) continue;
    out.push(openingTag(src, at));
  }
  return out;
}

/** Raw value text of attribute `attr` in an opening tag: `"..."` content or `{...}` content. */
function attrValue(tag: string, attr: string): string | null {
  const needle = `${attr}=`;
  let from = 0;
  for (;;) {
    const at = tag.indexOf(needle, from);
    if (at === -1) return null;
    from = at + needle.length;
    // Whole-word attribute name: preceded by whitespace.
    if (!isSpace(tag[at - 1])) continue;
    const v = tag[from];
    if (v === '"' || v === "'") return tag.slice(from + 1, skipQuoted(tag, from) - 1);
    if (v === "{") return tag.slice(from + 1, skipBraces(tag, from) - 1);
    return null;
  }
}

/** Class tokens of a tag's className, for a plain string (`"a b"`) or a `{"a b"}` / {`a b`} literal. */
function classTokens(tag: string): string[] {
  const raw = attrValue(tag, "className");
  if (raw === null) return [];
  let text = raw.trim();
  if (text.length >= 2 && "\"'`".includes(text[0]!) && text[text.length - 1] === text[0]) {
    text = text.slice(1, -1);
  }
  return text.split(/\s+/).filter(Boolean);
}

// --------------------------------------------------------------------------
// The things under test
// --------------------------------------------------------------------------

const forcedColorsBlocks = topLevelBlocks(GLOBALS_CSS).filter(
  (b) => b.prelude === `@media ${FORCED_COLORS_PRELUDE}`,
);
const forcedColorsRules = forcedColorsBlocks.flatMap((b) => rulesOf(b.body));

const DURUM_LINK_HREF = "`/source/${row.slug}`";
const durumLinks = tagsNamed(DURUM_PAGE, "Link").filter((t) => attrValue(t, "href") === DURUM_LINK_HREF);
const kaynakHeaders = tagsNamed(DURUM_PAGE, "th").filter((t) => attrValue(t, "scope") === "col");

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("scan helpers self-check", () => {
  const css = [
    '@import "tailwindcss";',
    "@layer base {",
    "  @media (forced-colors: active) { .x:focus-visible { outline-offset: -9px; } }",
    "}",
    "/* @media (forced-colors: active) { y { } } and a stray } brace */",
    "@media   (forced-colors:   active)  {",
    "  /* comment with { braces } */",
    "  :focus-visible { outline: 2px solid Highlight; outline-offset: 2px }",
    "  .a\\:b:focus-visible { content: '}'; outline-offset: -2px; }",
    "}",
    "@media (prefers-reduced-motion: reduce) { * { animation: none; } }",
  ].join("\n");

  it("finds only the depth-0 blocks, with comments and strings out of the way", () => {
    const blocks = topLevelBlocks(css);
    expect(blocks.map((b) => b.prelude)).toEqual([
      "@layer base",
      "@media (forced-colors: active)",
      "@media (prefers-reduced-motion: reduce)",
    ]);
  });

  it("reads rules and declarations of a block, normalising whitespace", () => {
    const block = topLevelBlocks(css)[1]!;
    expect(rulesOf(block.body)).toEqual([
      { selector: ":focus-visible", decls: { outline: "2px solid Highlight", "outline-offset": "2px" }, at: expect.any(Number) },
      { selector: ".a\\:b:focus-visible", decls: { content: "'}'", "outline-offset": "-2px" }, at: expect.any(Number) },
    ]);
  });

  it("parses a plain px length and rejects anything else", () => {
    expect(px("-2px")).toBe(-2);
    expect(px("2px")).toBe(2);
    expect(Number.isNaN(px("0"))).toBe(true);
    expect(Number.isNaN(px("-0.125rem"))).toBe(true);
    expect(Number.isNaN(px(undefined))).toBe(true);
  });

  it("reads the whole quoted class list around a token, and nothing else", () => {
    const src = [
      'const a = "x focus-visible:ring-inset y";',
      "const b = `p focus-visible:outline-none focus-visible:ring-inset q`;",
      "const c = 'focus-visible:ring-inset';",
    ].join("\n");
    expect(literalsContaining(src, "focus-visible:ring-inset")).toEqual([
      "x focus-visible:ring-inset y",
      "p focus-visible:outline-none focus-visible:ring-inset q",
      "focus-visible:ring-inset",
    ]);
    expect(literalsContaining("nothing here", "focus-visible:ring-inset")).toEqual([]);
  });

  it("does not read prose on a comment line as a class list", () => {
    const src = [
      "// the `focus-visible:ring-inset` pattern",
      " * a `focus-visible:ring-inset` chip",
      '  {/* "focus-visible:ring-inset" */}',
      'const a = "focus-visible:outline-none focus-visible:ring-inset";',
    ].join("\n");
    expect(literalsContaining(src, "focus-visible:ring-inset")).toEqual([
      "focus-visible:outline-none focus-visible:ring-inset",
    ]);
  });

  it("slices a Link tag whose attributes hold => and >, reads href and class tokens, and stops at a longer tag name", () => {
    const sample = '<Link href={`/s/${x.slug}`} onClick={() => go(1)} className="p > q">n</Link><LinkOther href="/z" />';
    const links = tagsNamed(sample, "Link");
    expect(links).toHaveLength(1);
    expect(attrValue(links[0]!, "href")).toBe("`/s/${x.slug}`");
    expect(classTokens(links[0]!)).toEqual(["p", ">", "q"]);
    expect(classTokens('<Link href="/x">')).toEqual([]);
    expect(() => tagsNamed("<Link href={`/x`", "Link")).toThrow();
  });
});

describe("forced colors: ring-inset elements get an inset outline (h178-keyboard-1)", () => {
  it("finds the top-level forced-colors block in globals.css (not a vacuous scan)", () => {
    expect(forcedColorsBlocks).toHaveLength(1);
    expect(forcedColorsRules.length).toBeGreaterThanOrEqual(1);
  });

  it("still restores the 2px Highlight outline at a 2px offset for every :focus-visible", () => {
    const base = forcedColorsRules.find((r) => r.selector === ":focus-visible");
    expect(base, ":focus-visible rule").toBeDefined();
    expect(base!.decls["outline"]).toBe("2px solid Highlight");
    expect(base!.decls["outline-offset"]).toBe("2px");
  });

  it("adds a .focus-visible\\:ring-inset:focus-visible rule with a negative outline-offset of at most -2px", () => {
    const inset = forcedColorsRules.find((r) => r.selector === INSET_SELECTOR);
    expect(inset, `${INSET_SELECTOR} rule`).toBeDefined();
    const offset = px(inset!.decls["outline-offset"]);
    expect(Number.isNaN(offset), `outline-offset ${inset!.decls["outline-offset"]} is a px length`).toBe(false);
    expect(offset).toBeLessThanOrEqual(-2);
  });

  it("puts the inset rule after the bare :focus-visible rule and cites h178", () => {
    const base = forcedColorsRules.find((r) => r.selector === ":focus-visible");
    const inset = forcedColorsRules.find((r) => r.selector === INSET_SELECTOR);
    expect(base).toBeDefined();
    expect(inset).toBeDefined();
    expect(inset!.at).toBeGreaterThan(base!.at);
    expect(forcedColorsBlocks[0]!.body).toContain("h178");
  });

  it("does not move the inset rule into a @layer (an unlayered rule is what beats `focus-visible:outline-none`)", () => {
    const inLayer = topLevelBlocks(GLOBALS_CSS)
      .filter((b) => b.prelude.startsWith("@layer"))
      .filter((b) => b.body.includes(INSET_SELECTOR));
    expect(inLayer).toEqual([]);
  });

  it("every src className literal that has focus-visible:ring-inset also has focus-visible:outline-none (the rule is for ring-only components)", () => {
    const offenders: string[] = [];
    let seen = 0;
    for (const file of sourceFiles(SRC_DIR)) {
      const src = readFileSync(file, "utf8");
      for (const literal of literalsContaining(src, "focus-visible:ring-inset")) {
        seen++;
        const tokens = literal.split(/\s+/).filter(Boolean);
        if (!tokens.includes("focus-visible:outline-none")) offenders.push(`${relative(ROOT, file)}: ${literal}`);
      }
    }
    // ticker-chip.tsx, the market-strip chip, and the /kaynaklar/durum outlet link.
    expect(seen).toBeGreaterThanOrEqual(2);
    expect(offenders).toEqual([]);
  });
});

describe("/kaynaklar/durum outlet link focus ring (h178-keyboard-1)", () => {
  it("finds exactly one outlet link in the row header (not a vacuous scan)", () => {
    expect(durumLinks).toHaveLength(1);
  });

  it("draws an inset 2px ring on the link's own box, so nothing paints outside the scroller", () => {
    const tokens = classTokens(durumLinks[0]!);
    for (const t of [
      "inline-block",
      "px-1",
      "focus-visible:outline-none",
      "focus-visible:ring-2",
      "focus-visible:ring-inset",
      "focus-visible:ring-ring",
      "hover:underline",
    ]) {
      expect(tokens).toContain(t);
    }
  });

  it("indents the 'Kaynak' column header by the same 4px (pl-1) so the label lines up with the names", () => {
    const header = kaynakHeaders.find((t) => classTokens(t).includes("sticky"));
    expect(header, "sticky Kaynak <th scope=col>").toBeDefined();
    expect(classTokens(header!)).toContain("pl-1");
  });

  it("keeps the sticky opaque first column and the scroller untouched", () => {
    for (const th of tagsNamed(DURUM_PAGE, "th").filter((t) => classTokens(t).includes("sticky"))) {
      for (const t of ["sticky", "left-0", "z-10", "bg-card"]) expect(classTokens(th)).toContain(t);
    }
    expect(DURUM_PAGE).toContain("sticky left-0 z-10 bg-card");
    const region = tagsNamed(DURUM_PAGE, "div").find((t) => attrValue(t, "role") === "region");
    expect(region, "scroll region").toBeDefined();
    for (const t of ["relative", "overflow-x-auto", "focus-visible:outline-none", "focus-visible:ring-2", "focus-visible:ring-ring"]) {
      expect(classTokens(region!)).toContain(t);
    }
  });
});
