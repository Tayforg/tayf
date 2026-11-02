import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// WCAG 2.5.8 (target size, minimum): a pointer target needs 24x24 CSS px, or
// 24 px of clear spacing around it. Three standalone targets rendered at their
// 10-17 px text line height with a 22 px pitch (h21-a11y-2):
//   - the /ekonomi stock-code links (devre kesici strip, KAP rows);
//   - the 'Tüm N kaynağı göster' toggle of Medya DNA.
// (The 'Kaynak künyesi' links are pinned in source-profile-link.test.tsx.)
// A text-line box is not a 24 px target, so each carries `inline-flex
// items-center min-h-6`. The class strings are asserted here so a refactor
// cannot quietly drop them.
//
// JSX is sliced with a character scan (string / template / brace aware), never
// with a regex over markup.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const EKONOMI_PAGE = readFileSync(join(ROOT, "src/app/ekonomi/page.tsx"), "utf8");
// The devre kesici strip moved out of the page into its own component
// (h28-journey-3); its chips and its '+N daha' summary are scanned here.
const BREAKER_STRIP = readFileSync(join(ROOT, "src/components/finance/breaker-strip.tsx"), "utf8");
const MEDIA_DNA = readFileSync(join(ROOT, "src/components/story/media-dna.tsx"), "utf8");

// --------------------------------------------------------------------------
// JSX opening-tag slicer (character scan)
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

/** Every opening tag of element `name` (`Link`, `button`) in `src`, in source order. */
function tagsNamed(src: string, name: string): string[] {
  const out: string[] = [];
  const open = `<${name}`;
  let from = 0;
  for (;;) {
    const at = src.indexOf(open, from);
    if (at === -1) break;
    const after = src[at + open.length];
    from = at + open.length;
    // `<Link` must be followed by whitespace, not `<LinkFoo` / `<Link.`.
    if (after !== " " && after !== "\n" && after !== "\t" && after !== "\r") continue;
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
    const before = tag[at - 1];
    if (before !== " " && before !== "\n" && before !== "\t") continue;
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
  if (text.length >= 2 && '"\'`'.includes(text[0]!) && text[text.length - 1] === text[0]) {
    text = text.slice(1, -1);
  }
  return text.split(/\s+/).filter(Boolean);
}

const TARGET_TOKENS = ["inline-flex", "items-center", "min-h-6"];

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("JSX tag slicer self-check", () => {
  const sample = [
    "<div>",
    "  <Link key={c} href={`/ekonomi/${c}`} className=\"a b > c\">x</Link>",
    "  <button onClick={() => setShowAll((v) => !v)} className=\"p q\">y</button>",
    "  <LinkOther href=\"/z\" className=\"n\" />",
    "  <Link href={'/source/' + s} className={\"u v\"}>w</Link>",
    "</div>",
  ].join("\n");

  it("slices only whole-name tags and survives => and > inside attribute values", () => {
    const links = tagsNamed(sample, "Link");
    expect(links).toHaveLength(2);
    expect(links[0]).toBe('<Link key={c} href={`/ekonomi/${c}`} className="a b > c">');
    expect(tagsNamed(sample, "button")).toEqual(['<button onClick={() => setShowAll((v) => !v)} className="p q">']);
  });

  it("reads href and className values", () => {
    const [first, second] = tagsNamed(sample, "Link");
    expect(attrValue(first!, "href")).toBe("`/ekonomi/${c}`");
    expect(classTokens(first!)).toEqual(["a", "b", ">", "c"]);
    expect(classTokens(second!)).toEqual(["u", "v"]);
    expect(attrValue(first!, "nope")).toBeNull();
    expect(classTokens("<Link href=\"/x\">")).toEqual([]);
  });

  it("throws on an unterminated tag instead of returning garbage", () => {
    expect(() => tagsNamed("<Link href={`/x`", "Link")).toThrow();
  });
});

describe("WCAG 2.5.8 target size: /ekonomi stock-code links", () => {
  const ekonomiLinks = [...tagsNamed(EKONOMI_PAGE, "Link"), ...tagsNamed(BREAKER_STRIP, "Link")].filter((tag) => {
    const href = attrValue(tag, "href");
    return href !== null && href.startsWith("`/ekonomi/");
  });

  it("finds the devre-kesici and KAP stock-code links (not a vacuous scan)", () => {
    expect(tagsNamed(EKONOMI_PAGE, "Link").filter((tag) => (attrValue(tag, "href") ?? "").startsWith("`/ekonomi/"))).toHaveLength(1);
    expect(tagsNamed(BREAKER_STRIP, "Link").filter((tag) => (attrValue(tag, "href") ?? "").startsWith("`/ekonomi/"))).toHaveLength(1);
    expect(ekonomiLinks.length).toBeGreaterThanOrEqual(2);
  });

  it("gives the strip's '+N daha' summary min-h-6 too", () => {
    const summaries = tagsNamed(BREAKER_STRIP, "summary");
    expect(summaries).toHaveLength(1);
    expect(classTokens(summaries[0]!)).toEqual(expect.arrayContaining(["inline-flex", "items-center", "min-h-6"]));
  });

  it("gives each one inline-flex items-center min-h-6", () => {
    const missing = ekonomiLinks.map((tag) => {
      const tokens = classTokens(tag);
      return { tag, missing: TARGET_TOKENS.filter((t) => !tokens.includes(t)) };
    });
    expect(missing.filter((m) => m.missing.length > 0)).toEqual([]);
  });
});

describe("WCAG 2.5.8 target size: Medya DNA 'Tüm N kaynağı göster' toggle", () => {
  const toggles = tagsNamed(MEDIA_DNA, "button").filter((tag) => (attrValue(tag, "onClick") ?? "").includes("setShowAll"));

  it("finds exactly one showAll toggle button", () => {
    expect(toggles).toHaveLength(1);
  });

  it("gives it inline-flex items-center min-h-6, and the 44 px size on narrow screens", () => {
    const tokens = classTokens(toggles[0]!);
    for (const t of [...TARGET_TOKENS, "max-sm:min-h-11"]) expect(tokens).toContain(t);
  });
});
