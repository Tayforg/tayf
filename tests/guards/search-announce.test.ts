import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG 4.1.3 status messages / 2.4.2 page titled,
// h10-a11y-2). The home search swaps the feed in place (debounced
// router.replace), and the site had no live region at all, so a screen-reader
// user got no sign that results changed, how many there were, or that there
// were none. One always-mounted sr-only status node now sits at a stable tree
// position, as the FIRST child of both HomeFeed return fragments: because it
// stays mounted through the transition, React updates its text and the
// browser announces the change. A role="status" node that is injected together
// with its text (the old NewSinceLastVisit, which returned null at count 0)
// is not reliably announced, so that component keeps its container mounted
// too. The "/" shortcut lives in one pure predicate so it cannot swallow "/"
// typed into a textarea, a select or a contenteditable.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** Blanks // and block comments, keeping offsets. Good enough for these files (no `//` inside strings). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Source of a top-level `function Name` (optionally `export` / `async`): from
 * the keyword to the first line that is exactly `}` (a top-level function ends
 * at column 0; a destructured parameter list closes with `}: {`, which is not
 * a bare `}` line).
 */
function functionSource(src: string, name: string): string {
  const m = new RegExp(`(?:^|\\n)((?:export )?(?:async )?function ${name}\\b[\\s\\S]*?\\n\\})(?=\\n|$)`).exec(src);
  return m?.[1] ?? "";
}

/** Opening tag from `start` to the first `>` outside braces and quotes. */
function openingTagFrom(src: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  let i = start + 1;
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
  return src.slice(start, i + 1);
}

describe("functionSource (the scanner this guard relies on)", () => {
  it("returns the body of a top-level function and stops at its closing brace", () => {
    const src = `function A() {\n  return 1;\n}\n\nfunction B() {\n  return 2;\n}\n`;
    expect(functionSource(src, "A")).toBe("function A() {\n  return 1;\n}");
    expect(functionSource(src, "B")).toContain("return 2;");
    expect(functionSource(src, "B")).not.toContain("return 1;");
  });

  it("finds exported and async functions and returns '' for a missing one", () => {
    const src = `export async function Feed() {\n  return 1;\n}\n`;
    expect(functionSource(src, "Feed")).toContain("return 1;");
    expect(functionSource(src, "Nope")).toBe("");
  });

  it("does not stop at a destructured parameter list that closes with '}: {'", () => {
    const src = `export async function Feed({\n  a,\n}: {\n  a: string;\n}) {\n  return 1;\n}\n`;
    expect(functionSource(src, "Feed")).toContain("return 1;");
  });

  it("does not match a longer name", () => {
    expect(functionSource(`function SearchStatusX() {\n}\n`, "SearchStatus")).toBe("");
  });
});

describe("src/app/page.tsx: the search result live region", () => {
  const page = blankComments(read("src/app/page.tsx"));
  const searchStatus = functionSource(page, "SearchStatus");
  const homeFeed = functionSource(page, "HomeFeed");

  it("declares exactly one role=\"status\", and it is inside a local function SearchStatus", () => {
    expect(count(page, 'role="status"')).toBe(1);
    expect(searchStatus).not.toBe("");
    expect(count(searchStatus, 'role="status"')).toBe(1);
  });

  it("puts it on a <p> that is polite, atomic and screen-reader-only", () => {
    const at = searchStatus.indexOf('role="status"');
    const pAt = searchStatus.lastIndexOf("<p", at);
    expect(pAt).toBeGreaterThan(-1);
    const tag = openingTagFrom(searchStatus, pAt);
    expect(tag).toContain('role="status"');
    expect(tag).toContain('aria-live="polite"');
    expect(tag).toContain('aria-atomic="true"');
    expect(tag).toContain('className="sr-only"');
    // The text is a plain React child, never HTML.
    expect(searchStatus).toContain("{text}");
  });

  it("renders <SearchStatus exactly twice: the first child of both HomeFeed return fragments", () => {
    expect(count(page, "<SearchStatus")).toBe(2);
    expect(homeFeed).not.toBe("");
    expect(count(homeFeed, "<SearchStatus")).toBe(2);
    // A `{/* comment */}` before it blanks to an empty expression container.
    const firstChild =
      homeFeed.match(/return \(\s*<>\s*(?:\{\s*\}\s*)?<SearchStatus\b/g) ?? [];
    expect(firstChild).toHaveLength(2);
    // ...and each fragment returned the live region before anything else:
    // the feed-null return and the normal return are the only two returns.
    expect(count(homeFeed, "return (")).toBe(2);
  });

  it("announces the unavailable state on the feed-null path and the result count on the normal path", () => {
    const nullPath = homeFeed.slice(homeFeed.indexOf("if (feed === null)"), homeFeed.indexOf("const { bundles"));
    expect(nullPath).toContain("<SearchStatus");
    expect(nullPath).toMatch(/searchStatusText\(\{[^}]*unavailable: true[^}]*\}\)/);
    // The total is page-independent: archive rows come from the page-free
    // archiveTotal, never from view.archive (empty on page 2+).
    expect(homeFeed).toContain("const resultCount = inFeedIds.size + view.archiveTotal;");
    expect(homeFeed).not.toContain("inFeedIds.size + view.archive.length");
    expect(homeFeed).toMatch(/searchStatusText\(\{[^}]*count: resultCount[^}]*capped: view\.archiveCappedTotal[^}]*unavailable: view\.archiveUnavailable[^}]*\}\)/);
  });

  it("shows the same count on the visible results line", () => {
    expect(homeFeed).toContain("için {formatCountTr(resultCount)} sonuç");
    expect(homeFeed).not.toContain("için sonuçlar");
  });

  it("keeps role= off the empty and error cards (the single live region speaks for them)", () => {
    const empty = functionSource(page, "EmptySearch");
    const unavailable = functionSource(page, "SearchUnavailable");
    expect(empty).not.toBe("");
    expect(unavailable).not.toBe("");
    expect(empty).not.toContain("role=");
    expect(unavailable).not.toContain("role=");
    // Only the SearchStatus node announces: one role=, one aria-live=.
    expect(count(page, "role=")).toBe(1);
    expect(count(page, "aria-live=")).toBe(1);
    expect(count(searchStatus, "aria-live=")).toBe(1);
  });

  it("never injects HTML", () => {
    expect(page).not.toContain("dangerouslySetInnerHTML");
  });

  it("gives /?q= its own title from searchTitle and keeps the noindex,follow robots", () => {
    expect(page).toMatch(/if \(q\) return \{ title: searchTitle\(q\), robots: \{ index: false, follow: true \} \};/);
  });
});

describe("src/components/home/new-since-last-visit.tsx: the status container stays mounted", () => {
  const code = blankComments(read("src/components/home/new-since-last-visit.tsx"));

  it("never returns null (an injected role=status is not reliably announced)", () => {
    expect(code).not.toContain("return null");
  });

  it("has exactly one role=\"status\", polite, on the always-rendered container", () => {
    expect(count(code, 'role="status"')).toBe(1);
    const at = code.indexOf('role="status"');
    const divAt = code.lastIndexOf("<div", at);
    expect(divAt).toBeGreaterThan(-1);
    const tag = openingTagFrom(code, divAt);
    expect(tag).toContain('aria-live="polite"');
    expect(tag).toMatch(/count > 0 \? "" : "sr-only"/);
  });

  it("renders the pill only when there is something new", () => {
    expect(code).toMatch(/count > 0 && \(\s*<p\b/);
  });
});

describe("src/components/filters/search-bar.tsx: the '/' shortcut", () => {
  const code = blankComments(read("src/components/filters/search-bar.tsx"));

  it("imports isSearchShortcut and calls it in the keydown handler", () => {
    expect(code).toMatch(/import \{ isSearchShortcut \} from "\.\/search-shortcut";/);
    expect(code).toMatch(/if \(!isSearchShortcut\(e\)\) return;/);
  });

  it("no longer hand-rolls the activeElement INPUT check", () => {
    expect(code).not.toContain('tagName !== "INPUT"');
    expect(code).not.toContain("activeElement");
  });
});
