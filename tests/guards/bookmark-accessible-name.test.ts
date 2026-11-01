import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG 2.5.3 label in name / 4.1.2 name): the bookmark
// buttons used to carry one fixed aria-label per state. On a feed that is a
// column of identical "Hikâyeyi kaydet" buttons, and on the cluster page the
// saved chip said "Kaydedildi" while its name was "Kaydedilenlerden çıkar".
// Every BookmarkButton now receives the story title, and the only aria-label
// left in bookmark-button.tsx is the icon-only overlay's, built from it.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Blanks // and block comments, keeping offsets. Good enough for these files (no `//` inside strings). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/**
 * Every `<BookmarkButton ...>` opening tag of a source string. The scan walks
 * to the first `>` or `/>` outside braces and string literals, so a prop value
 * such as `onClick={() => x}` does not end the tag early.
 */
function openingTags(src: string): string[] {
  const tags: string[] = [];
  const re = /<BookmarkButton(?![\w])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let quote: string | null = null;
    for (; i < src.length; i++) {
      const c = src[i]!;
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || (c === "`" && depth > 0)) quote = c;
      else if (c === "{") depth++;
      else if (c === "}") depth--;
      else if (c === ">" && depth === 0) break;
    }
    tags.push(src.slice(m.index, i + 1));
  }
  return tags;
}

const files = walk(SRC);
const read = (f: string) => readFileSync(f, "utf8");

describe("openingTags (the scanner this guard relies on)", () => {
  it("finds a self-closing tag and ignores a component with a longer name", () => {
    const tags = openingTags(
      `<BookmarkButton clusterId={id} storyTitle={t} /> <BookmarkButtonX a="b" />`,
    );
    expect(tags).toEqual(["<BookmarkButton clusterId={id} storyTitle={t} />"]);
  });

  it("does not end the tag at an arrow function or a '>' inside a string", () => {
    const tags = openingTags(
      `<BookmarkButton onClick={() => go(a > b)} className="a>b" storyTitle={t} />`,
    );
    expect(tags).toHaveLength(1);
    expect(tags[0]).toContain("storyTitle={t}");
  });
});

describe("BookmarkButton usages", () => {
  const usages = files
    .filter((f) => f.endsWith(".tsx"))
    .flatMap((f) => openingTags(blankComments(read(f))).map((tag) => ({ file: relative(ROOT, f), tag })));

  it("exists in at least two places (the card overlay and the cluster page chip)", () => {
    expect(usages.length).toBeGreaterThanOrEqual(2);
  });

  it("passes a storyTitle prop at every usage, so no button is a bare generic label", () => {
    const missing = usages.filter((u) => !/\bstoryTitle=/.test(u.tag)).map((u) => u.file);
    expect(missing).toEqual([]);
  });

  it("feeds the cluster page chip the h1 title, and null (generic label) for a headline-less cluster", () => {
    const page = usages.find((u) => u.file.endsWith("cluster/[id]/page.tsx"));
    expect(page).toBeDefined();
    // Gated on the same `hasHeadline` as the h1 (hunt-10): a stored title with
    // no letter or digit ('&nbsp') must never reach the accessible name or /saved.
    expect(page!.tag).toMatch(/storyTitle=\{\s*hasHeadline \? cluster\.title_tr : null\s*\}/);
  });
});

describe("generic bookmark aria-labels", () => {
  it("no src file hard-codes the generic labels as an aria-label", () => {
    const offenders = files
      .filter((f) => {
        const code = blankComments(read(f));
        return (
          code.includes('aria-label="Hikâyeyi kaydet"') ||
          code.includes('aria-label="Kaydedilenlerden çıkar"')
        );
      })
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("bookmark-button.tsx has exactly one aria-label (the icon-only overlay); the chip is named by its visible text", () => {
    const code = blankComments(read(join(SRC, "components/bookmark/bookmark-button.tsx")));
    expect(code.split("aria-label=").length - 1).toBe(1);
    const overlayAt = code.indexOf('variant === "overlay"');
    const labelAt = code.indexOf("aria-label=");
    const chipAt = code.indexOf("Kaydedildi");
    expect(overlayAt).toBeGreaterThan(-1);
    expect(labelAt).toBeGreaterThan(overlayAt);
    expect(labelAt).toBeLessThan(chipAt);
  });
});
