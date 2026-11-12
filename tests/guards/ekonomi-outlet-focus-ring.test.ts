import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 2.4.7 / 2.4.11 (focus visible): on /ekonomi 'Haber akışı' every outlet
// name is a link inside a fixed 7.5rem column. The link used to sit directly
// inside a `truncate` span (overflow: hidden, zero padding), and a focus
// outline or ring drawn outside a link that is flush with the span's padding
// box is clipped by that span: left stroke missing, top stroke thinned, on all
// 80 links (h148-keyboard-1). Forced colors draws the same clipped outline
// (globals.css restores `outline: 2px` + `outline-offset: 2px` for every
// `focus-visible:outline-none` + ring pairing).
//
// The fix moves the ellipsis onto the link itself (`block truncate`: an
// element's own box-shadow and outline are not clipped by its own overflow),
// gives it the site's 2px ring, and removes overflow from every ancestor.
// These assertions keep a refactor from quietly putting `truncate` back on
// the wrapper, or dropping the ring.
//
// JSX is sliced with a character scan (string / template / brace aware), never
// with a regex over markup.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const EKONOMI_PAGE = readFileSync(join(ROOT, "src/app/ekonomi/page.tsx"), "utf8");
const PANEL = readFileSync(join(ROOT, "src/components/finance/panel.tsx"), "utf8");

// --------------------------------------------------------------------------
// JSX opening-tag slicer (character scan), as in tests/guards/target-size.test.ts
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

type Tag = { start: number; text: string };

/** Every opening tag of element `name` (`Link`, `span`) in `src`, in source order, with its start index. */
function tagsNamed(src: string, name: string): Tag[] {
  const out: Tag[] = [];
  const open = `<${name}`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(open, from);
    if (at === -1) break;
    from = at + open.length;
    // `<Link` must end the name there, not be a prefix of `<LinkFoo` / `<Link.`.
    if (!isNameEnd(src[at + open.length])) continue;
    out.push({ start: at, text: openingTag(src, at) });
  }
  return out;
}

/**
 * Opening tags of element `name` that are still unclosed at index `at`, outermost
 * first: the elements of that name that enclose position `at`. Self-closing tags
 * (`<name ... />`) never enclose anything.
 */
function enclosing(src: string, at: number, name: string): Tag[] {
  const close = `</${name}>`;
  const events: Array<{ pos: number; open: Tag | null }> = [];
  for (const tag of tagsNamed(src, name)) {
    if (tag.start < at && !tag.text.endsWith("/>")) events.push({ pos: tag.start, open: tag });
  }
  let from = 0;
  for (;;) {
    const c = src.indexOf(close, from);
    if (c === -1 || c >= at) break;
    events.push({ pos: c, open: null });
    from = c + close.length;
  }
  events.sort((a, b) => a.pos - b.pos);
  const stack: Tag[] = [];
  for (const e of events) {
    if (e.open) stack.push(e.open);
    else stack.pop();
  }
  return stack;
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

/** True for a class that clips its element's overflow, whatever variant prefix it carries. */
function clips(token: string): boolean {
  const base = token.split(":").pop() ?? token;
  return base === "truncate" || base.startsWith("overflow-");
}

// --------------------------------------------------------------------------
// The element under test
// --------------------------------------------------------------------------

const OUTLET_HREF = "`/source/${item.source.slug}`";
const outletLinks = tagsNamed(EKONOMI_PAGE, "Link").filter((t) => attrValue(t.text, "href") === OUTLET_HREF);
const outletLink = outletLinks[0]!;
const outletSpan = outletLink ? enclosing(EKONOMI_PAGE, outletLink.start, "span").at(-1) : undefined;

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("JSX scan helpers self-check", () => {
  const sample = [
    "<ol>",
    '  <li className="row">',
    '    <span className="a" lang={l(x)}>',
    "      <span>plain</span>",
    "      {x ? (",
    "        <Link href={`/s/${x.slug}`} onClick={() => go(1)} className=\"p > q\">n</Link>",
    "      ) : null}",
    "    </span>",
    '    <span className="b" />',
    '    <span className="c">z</span>',
    "  </li>",
    "</ol>",
  ].join("\n");

  it("finds a tag whose attributes hold => and > and reads its href and class tokens", () => {
    const links = tagsNamed(sample, "Link");
    expect(links).toHaveLength(1);
    expect(attrValue(links[0]!.text, "href")).toBe("`/s/${x.slug}`");
    expect(classTokens(links[0]!.text)).toEqual(["p", ">", "q"]);
    expect(classTokens('<Link href="/x">')).toEqual([]);
    expect(attrValue('<Link href="/x">', "className")).toBeNull();
  });

  it("returns the elements that are open at a position, not closed or self-closing ones", () => {
    const at = tagsNamed(sample, "Link")[0]!.start;
    const spans = enclosing(sample, at, "span");
    expect(spans).toHaveLength(1);
    expect(spans[0]!.text).toBe('<span className="a" lang={l(x)}>');
    expect(enclosing(sample, at, "li")).toHaveLength(1);
    expect(enclosing(sample, at, "ol")).toHaveLength(1);
    // After </span> of "a" and a self-closing <span />, a third span is the only open one.
    const z = sample.indexOf(">z<") + 1;
    expect(enclosing(sample, z, "span").map((t) => t.text)).toEqual(['<span className="c">']);
  });

  it("does not match a longer tag name, and throws on an unterminated tag", () => {
    expect(tagsNamed('<LinkOther href="/z" />', "Link")).toEqual([]);
    expect(() => tagsNamed("<Link href={`/x`", "Link")).toThrow();
  });

  it("flags truncate and overflow-* (with or without a variant) as clipping", () => {
    for (const t of ["truncate", "sm:truncate", "overflow-hidden", "md:overflow-x-auto", "overflow-clip"]) {
      expect(clips(t)).toBe(true);
    }
    for (const t of ["block", "min-w-0", "text-ellipsis", "focus-visible:ring-2", "hidden"]) {
      expect(clips(t)).toBe(false);
    }
  });
});

describe("/ekonomi 'Haber akışı' outlet-name link focus ring (h148-keyboard-1)", () => {
  it("finds exactly one outlet link and its wrapping span (not a vacuous scan)", () => {
    expect(outletLinks).toHaveLength(1);
    expect(outletSpan).toBeDefined();
    expect(outletSpan!.start).toBeLessThan(outletLink.start);
  });

  it("puts the ellipsis and the site's 2px ring on the link itself", () => {
    const tokens = classTokens(outletLink.text);
    for (const t of ["block", "truncate", "focus-visible:outline-none", "focus-visible:ring-2", "focus-visible:ring-ring"]) {
      expect(tokens).toContain(t);
    }
  });

  it("keeps hover:text-foreground on the link", () => {
    expect(classTokens(outletLink.text)).toContain("hover:text-foreground");
  });

  it("does not let the wrapping span clip: no truncate, no overflow-*", () => {
    const tokens = classTokens(outletSpan!.text);
    expect(tokens.filter(clips)).toEqual([]);
  });

  it("keeps the span hidden below sm, shrinkable in its column, and language-tagged", () => {
    const tokens = classTokens(outletSpan!.text);
    for (const t of ["hidden", "sm:block", "min-w-0"]) expect(tokens).toContain(t);
    expect(attrValue(outletSpan!.text, "lang")).toBe("sourceLang(item.source)");
  });

  it("clips nothing between the link and the page: no ancestor carries truncate or overflow-*", () => {
    const ancestors = ["span", "li", "ol", "div", "section", "Panel"].flatMap((name) =>
      enclosing(EKONOMI_PAGE, outletLink.start, name).map((t) => ({ name, text: t.text })),
    );
    // The span, the li, the ol and at least the page wrappers are really being checked.
    expect(ancestors.filter((a) => a.name === "span")).toHaveLength(1);
    expect(ancestors.filter((a) => a.name === "li")).toHaveLength(1);
    expect(ancestors.filter((a) => a.name === "ol")).toHaveLength(1);
    expect(ancestors.filter((a) => a.name === "Panel")).toHaveLength(1);
    expect(ancestors.filter((a) => a.name === "div").length).toBeGreaterThanOrEqual(2);
    const clipped = ancestors.filter((a) => classTokens(a.text).some(clips));
    expect(clipped).toEqual([]);
    // Panel (a component) draws the section and the content div around the rows.
    expect(tagsNamed(PANEL, "section").concat(tagsNamed(PANEL, "div")).filter((t) => classTokens(t.text).some(clips))).toEqual([]);
    expect(PANEL).not.toContain("overflow-");
  });

  it("keeps the fixed 7.5rem outlet column (sm and up), so the ellipsis still has a bounded box", () => {
    const li = enclosing(EKONOMI_PAGE, outletLink.start, "li")[0]!;
    expect(classTokens(li.text)).toContain("sm:grid-cols-[3.25rem_7.5rem_minmax(0,1fr)]");
  });
});
