import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG 1.4.10 Reflow, h39-a11y-1). `.sr-only` is
// `position: absolute`. A horizontal scroller (overflow-x-auto, or the
// tayf-scroll-x market strip) clips only the descendants whose containing
// block is the scroller or sits inside it. With no positioned element between
// an sr-only span and the nearest positioned ancestor outside the scroller,
// the span is not clipped: a span deep in the scrolled content (the TERA chip
// of the /ekonomi strip, at x ~ 1766 on a 375 px phone) lands far to the right
// of the page and widens the document, so /ekonomi scrolled sideways on every
// viewport. The one-word fix is `relative` on the scroller; /kaynaklar/durum
// already carried it for its sr-only column labels.
//
// So every className string literal in src (non-test) that holds a horizontal
// scroller class must also hold an un-prefixed position class (relative,
// absolute, fixed or sticky), unless its file is in ALLOWED_UNPOSITIONED with
// an exact count and a reason. The count is exact so that a new scroller in an
// allowlisted file still forces a decision, and a stale entry fails.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");

/** Horizontal scroller classes. `tayf-scroll-x` is the globals.css strip (overflow-x: auto inside). */
const SCROLLER = /(?<![\w-])(?:overflow-x-auto|overflow-x-scroll|overflow-auto|overflow-scroll|tayf-scroll-x)(?![\w-])/g;

/** Classes that make an element the containing block of absolutely positioned descendants. */
const POSITION_CLASSES = ["relative", "absolute", "fixed", "sticky"];

/**
 * Files whose scroller literals are deliberately not positioned, with the exact
 * number of such literals and why that is safe. Safe means: nothing inside the
 * scroller is absolutely positioned (no sr-only text, no badge), or the scroller
 * is already inside a positioned wrapper.
 */
const ALLOWED_UNPOSITIONED: Record<string, { count: number; reason: string }> = {
  "src/app/metodoloji/page.tsx": {
    count: 2,
    reason: "a text-only zone table and a <pre> prompt block; no sr-only or absolute child inside either scroller",
  },
  "src/app/gelistirici/page.tsx": {
    count: 4,
    reason: "code samples (<pre>) and plain data tables, one shared class constant; no sr-only or absolute child inside",
  },
  "src/app/kalite/page.tsx": {
    count: 1,
    reason: "the nightly snapshot table (th/td text only); its sr-only heading is outside the scroller",
  },
  "src/app/trends/page.tsx": {
    count: 1,
    reason: "an svg chart inside ScrollToEnd, which wraps it in a relative div; the sr-only hint is a sibling, not a child",
  },
  "src/app/admin/(protected)/tik-tuzagi/page.tsx": {
    count: 1,
    reason: "an admin text table behind auth; no sr-only or absolute child",
  },
  "src/components/admin/admin-ui.tsx": {
    count: 2,
    reason: "DataTable (admin text tables) and the AdminNav list, which sits in a sticky (positioned) nav; add relative to DataTable the day a cell needs sr-only text",
  },
};

// --- scanning --------------------------------------------------------------

const isSpace = (c: string | undefined): boolean => c === " " || c === "\n" || c === "\t" || c === "\r";
const isQuote = (c: string | undefined): boolean => c === '"' || c === "'" || c === "`";

/** Index just past the closing quote of the string that opens at `i`. */
function skipQuoted(src: string, i: number): number {
  const quote = src[i]!;
  let j = i + 1;
  while (j < src.length) {
    const c = src[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === quote) return j + 1;
    // A ' or " string never spans lines; stopping here keeps one stray
    // apostrophe in JSX text (Turkish suffixes: Cumhur İttifakı'nın) from
    // swallowing the rest of the file.
    if (c === "\n" && quote !== "`") return j;
    if (quote === "`" && c === "$" && src[j + 1] === "{") {
      j = skipBraces(src, j + 1);
      continue;
    }
    j += 1;
  }
  return src.length;
}

/** Index just past the `}` that closes the `{` at `i`. */
function skipBraces(src: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < src.length) {
    const c = src[j]!;
    if (isQuote(c)) {
      j = skipQuoted(src, j);
      continue;
    }
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth === 0) return j + 1;
    }
    j += 1;
  }
  return src.length;
}

/**
 * A comment opener sits at the start of the file or after whitespace or one of `;{}(),`.
 * JSX text such as `/api/v1/*` or `https://x.test` has a letter, digit, `:` or `/` in front
 * of its `/*` or `//`, and must not be mistaken for a comment.
 */
function opensComment(src: string, i: number): boolean {
  const prev = src[i - 1];
  return prev === undefined || isSpace(prev) || ";{}(),".includes(prev);
}

/** Replaces every comment character with a space (newlines kept), so offsets and line numbers survive. */
export function blankComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/" && opensComment(src, i)) {
      while (i < src.length && src[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (c === "/" && next === "*" && opensComment(src, i)) {
      const close = src.indexOf("*/", i + 2);
      const stop = close === -1 ? src.length : close + 2;
      for (; i < stop; i += 1) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (isQuote(c)) {
      const stop = skipQuoted(src, i);
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(full);
  }
  return out;
}

export interface ScrollerLiteral {
  /** 1-based line of the first scroller class in the literal */
  line: number;
  /** The text between the quotes, or null when the quotes around the class could not be paired */
  literal: string | null;
  /** True when the literal carries an un-prefixed position class */
  positioned: boolean;
}

/** The un-prefixed (no `sm:`, `md:` ...) class tokens of a class string. */
function plainTokens(literal: string): string[] {
  return literal.split(/\s+/).filter((t) => t !== "" && !t.includes(":"));
}

/**
 * One entry per quoted literal that holds a horizontal scroller class, found by
 * pairing the nearest quote before and after each class in the comment-blanked
 * source. A class whose surrounding quotes differ (a template literal with a
 * `${...}` around it, a class outside any string) is reported with
 * `literal: null` instead of being skipped.
 */
export function scrollerLiterals(rawSource: string): ScrollerLiteral[] {
  const src = blankComments(rawSource);
  const found: ScrollerLiteral[] = [];
  const seen = new Set<number>();
  for (const m of src.matchAll(SCROLLER)) {
    const at = m.index!;
    const line = src.slice(0, at).split("\n").length;
    let open = at - 1;
    while (open >= 0 && !isQuote(src[open])) open -= 1;
    let close = at + m[0].length;
    while (close < src.length && !isQuote(src[close])) close += 1;
    const paired =
      open >= 0 &&
      close < src.length &&
      src[open] === src[close] &&
      (src[open] === "`" || !src.slice(open, close).includes("\n")) &&
      !src.slice(open + 1, close).includes("${");
    if (!paired) {
      found.push({ line, literal: null, positioned: false });
      continue;
    }
    if (seen.has(open)) continue; // a second scroller class in the same literal
    seen.add(open);
    const literal = src.slice(open + 1, close);
    found.push({ line, literal, positioned: plainTokens(literal).some((t) => POSITION_CLASSES.includes(t)) });
  }
  return found;
}

/** Scroller literals that are not positioned, as "line N: <literal>" strings (unclassifiable ones included). */
export function unpositioned(rawSource: string): string[] {
  return scrollerLiterals(rawSource)
    .filter((s) => !s.positioned)
    .map((s) => (s.literal === null ? `line ${s.line}: scroller class outside a plain string literal` : `line ${s.line}: "${s.literal}"`));
}

// --- the real tree ---------------------------------------------------------

describe("every horizontal scroller in src is positioned (h39-a11y-1)", () => {
  const sources = walk(SRC).map((f) => ({ file: relative(ROOT, f), code: readFileSync(f, "utf8") }));
  const perFile = sources
    .map((s) => ({ file: s.file, all: scrollerLiterals(s.code), bad: unpositioned(s.code) }))
    .filter((s) => s.all.length > 0);

  it("scans a real number of scrollers (the scanner is not vacuous)", () => {
    const total = perFile.reduce((n, s) => n + s.all.length, 0);
    expect(total).toBeGreaterThanOrEqual(12);
  });

  it("sees the market strip and the /kaynaklar/durum table as positioned scrollers", () => {
    for (const file of ["src/components/finance/ticker-chip.tsx", "src/app/kaynaklar/durum/page.tsx"]) {
      const entry = perFile.find((s) => s.file === file);
      expect(entry, file).toBeDefined();
      expect(entry!.all.length, file).toBeGreaterThanOrEqual(1);
      expect(entry!.bad, file).toEqual([]);
    }
  });

  it("the TickerTape strip literal holds tayf-scroll-x, overflow-x-auto and relative", () => {
    const strip = perFile
      .find((s) => s.file === "src/components/finance/ticker-chip.tsx")!
      .all.filter((s) => s.literal?.includes("tayf-scroll-x"));
    expect(strip).toHaveLength(1);
    const tokens = plainTokens(strip[0]!.literal!);
    expect(tokens).toContain("tayf-scroll-x");
    expect(tokens).toContain("overflow-x-auto");
    expect(tokens).toContain("relative");
  });

  it("no scroller is unpositioned outside the allowlist, and each allowlisted file has exactly its stated count", () => {
    const offenders: string[] = [];
    for (const { file, bad } of perFile) {
      const allowed = ALLOWED_UNPOSITIONED[file]?.count ?? 0;
      if (bad.length !== allowed) {
        offenders.push(`${file}: ${bad.length} unpositioned scroller(s), ${allowed} allowed${bad.length ? ` -> ${bad.join(" | ")}` : ""}`);
      }
    }
    for (const file of Object.keys(ALLOWED_UNPOSITIONED)) {
      if (!perFile.some((s) => s.file === file)) offenders.push(`${file}: allowlisted but has no scroller (stale entry)`);
    }
    expect(offenders).toEqual([]);
  });

  it("every allowlist entry says why it is safe", () => {
    for (const [file, { count, reason }] of Object.entries(ALLOWED_UNPOSITIONED)) {
      expect(count, file).toBeGreaterThan(0);
      expect(reason.length, file).toBeGreaterThanOrEqual(20);
    }
  });

  it("no scroller class sits outside a plain string literal (it would escape the check)", () => {
    const loose = perFile.flatMap((s) => s.all.filter((x) => x.literal === null).map((x) => `${s.file}:${x.line}`));
    expect(loose).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The scanner is what keeps the guard honest, so it is mutation-tested on
// synthetic sources: each mutant must be reported, each clean shape accepted.
// ---------------------------------------------------------------------------

describe("unpositioned (mutation checks on synthetic sources)", () => {
  it("reports a bare overflow-x-auto scroller, with its line", () => {
    expect(unpositioned(`const a = 1;\nconst b = <div className="flex overflow-x-auto border">x</div>;\n`)).toEqual([
      'line 2: "flex overflow-x-auto border"',
    ]);
  });

  it("reports the market strip as it was before the fix (tayf-scroll-x + overflow-x-auto, no relative)", () => {
    const before = `<div className="tayf-scroll-x flex overflow-x-auto border border-border bg-foreground/[0.03] font-mono text-[11px] leading-none">`;
    expect(unpositioned(before)).toHaveLength(1);
  });

  it("accepts the market strip with relative", () => {
    const after = `<div className="tayf-scroll-x relative flex overflow-x-auto border border-border">`;
    expect(unpositioned(after)).toEqual([]);
  });

  it("accepts absolute, fixed and sticky as positioned too", () => {
    for (const p of ["absolute", "fixed", "sticky"]) {
      expect(unpositioned(`<div className="${p} overflow-x-auto">`)).toEqual([]);
    }
  });

  it("does not accept a position class that only applies at a breakpoint or state", () => {
    expect(unpositioned(`<div className="overflow-x-auto sm:relative">`)).toHaveLength(1);
    expect(unpositioned(`<div className="overflow-x-auto md:sticky hover:relative">`)).toHaveLength(1);
  });

  it("does not take a longer class for the position class (relative-foo, not-relative, leading-relaxed)", () => {
    expect(unpositioned(`<div className="overflow-x-auto leading-relaxed">`)).toHaveLength(1);
    expect(unpositioned(`<div className="overflow-x-auto relative-foo not-relative">`)).toHaveLength(1);
  });

  it("catches a scroller that only applies from a breakpoint, and the other horizontal scroller classes", () => {
    expect(unpositioned(`<div className="sm:overflow-x-auto">`)).toHaveLength(1);
    expect(unpositioned(`<div className="max-sm:overflow-x-auto">`)).toHaveLength(1);
    expect(unpositioned(`<div className="overflow-x-scroll">`)).toHaveLength(1);
    expect(unpositioned(`<div className="overflow-auto">`)).toHaveLength(1);
    expect(unpositioned(`<div className="overflow-scroll">`)).toHaveLength(1);
    expect(unpositioned(`<div className="tayf-scroll-x">`)).toHaveLength(1);
  });

  it("ignores classes that only look like a scroller (overflow-y-auto, overflow-x-hidden, a longer name)", () => {
    expect(unpositioned(`<div className="overflow-y-auto">`)).toEqual([]);
    expect(unpositioned(`<div className="overflow-x-hidden">`)).toEqual([]);
    expect(unpositioned(`<div className="overflow-x-auto-foo no-overflow-x-auto my-tayf-scroll-x">`)).toEqual([]);
  });

  it("counts a literal that holds two scroller classes once", () => {
    expect(unpositioned(`<div className="tayf-scroll-x overflow-x-auto flex">`)).toHaveLength(1);
  });

  it("checks every literal in a file, not just the first", () => {
    const src = `<div className="relative overflow-x-auto">a</div>\n<div className="overflow-x-auto">b</div>\n`;
    expect(unpositioned(src)).toEqual(['line 2: "overflow-x-auto"']);
  });

  it("reads a const class string and a template literal without ${}", () => {
    expect(unpositioned(`const c = "overflow-x-auto rounded px-3";\n`)).toEqual(['line 1: "overflow-x-auto rounded px-3"']);
    expect(unpositioned("const c = `overflow-x-auto relative`;\n")).toEqual([]);
  });

  it("reports a class it cannot pair with a literal instead of skipping it", () => {
    expect(unpositioned("const c = `overflow-x-auto ${x ? 'relative' : ''}`;\n")).toEqual([
      "line 1: scroller class outside a plain string literal",
    ]);
    expect(unpositioned(`const c = open ? "a" : overflow-x-auto;\n`)).toHaveLength(1);
  });

  it("ignores a scroller class that only appears in a comment", () => {
    const src = `// <div className="overflow-x-auto">\n/* <div className="tayf-scroll-x"> */\nconst x = 1;\n{/* <div className="overflow-x-auto"> */}\n`;
    expect(scrollerLiterals(src)).toEqual([]);
  });

  it("does not let the word 'relative' in a comment satisfy the rule", () => {
    expect(unpositioned(`<div className="overflow-x-auto" /* relative */>`)).toHaveLength(1);
  });

  it("is not fooled by a stray apostrophe in JSX text before the scroller", () => {
    const src = `<p>Cumhur İttifakı'nın bir ortağıdır</p>\n<div className="overflow-x-auto">x</div>\n`;
    expect(unpositioned(src)).toEqual(['line 2: "overflow-x-auto"']);
  });

  it("is not fooled by a // inside a string literal before the scroller", () => {
    const src = `const url = "https://example.test/a";\nconst b = <div className="overflow-x-auto">x</div>;\n`;
    expect(unpositioned(src)).toEqual(['line 2: "overflow-x-auto"']);
  });

  it("handles a multi-line template literal class string", () => {
    expect(unpositioned("const c = `flex\n  overflow-x-auto\n  relative`;\n")).toEqual([]);
    expect(unpositioned("const c = `flex\n  overflow-x-auto`;\n")).toHaveLength(1);
  });
});

describe("blankComments", () => {
  it("keeps length, line breaks and string contents, and blanks comments", () => {
    const src = `const a = "x // y"; // tail\n/* block\nspans */ const b = \`t // u\`;\n`;
    const out = blankComments(src);
    expect(out).toHaveLength(src.length);
    expect(out.split("\n")).toHaveLength(src.split("\n").length);
    expect(out).toContain('"x // y"');
    expect(out).toContain("`t // u`");
    expect(out).not.toContain("tail");
    expect(out).not.toContain("block");
    expect(out).not.toContain("spans");
  });

  it("does not treat JSX text like /api/v1/* or https://x.test as a comment", () => {
    const src = '<code>/api/v1/*</code>\n<a>https://x.test/a</a>\n<div className="overflow-x-auto">\n';
    expect(blankComments(src)).toBe(src);
  });
});
