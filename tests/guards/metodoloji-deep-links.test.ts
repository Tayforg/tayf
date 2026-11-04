import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve, sep } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (crawl-index-hygiene, h31-bots-1): every link to a
// per-entity correction deep link `/metodoloji?cluster=<id>#duzeltme` or
// `/metodoloji?source=<slug>#duzeltme` must be a nofollow link, and a
// next/link must not prefetch it.
//
// Why: the correction form reads those params client-side, so each variant is
// the same static /metodoloji page. Every cluster and source page links its
// own variant, which is ~31.7k duplicate URLs for a crawler to discover, and
// bots matched by htmlLimitedBots get an uncached function render of each.
// robots.txt disallows the variants (tests/api/robots.test.ts); this guard
// stops the links themselves from being followed, and from being prefetched by
// the browser's router, in the first place.
//
// How: every `/metodoloji?` in src/**/*.{ts,tsx} (tests excluded, comments
// blanked first) is located inside its enclosing JSX opening tag: the last `<`
// before it, then forward to the first `>` at brace depth 0 outside string
// literals. The tag's top-level attributes must hold rel="…nofollow…" and,
// for `<Link`, prefetch={false}. The scan is character based, with no pattern
// built from source text.
//
// Non-vacuous: the real scan must find exactly the four known links, and the
// mutation tests below feed the checker synthetic snippets that must fail.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = join(ROOT, "src");
const NEEDLE = "/metodoloji?";

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

// --- JSX tag scanning --------------------------------------------------------

/** Index just past the string literal that opens at `open` (' " or `). */
function skipString(src: string, open: number): number {
  const quote = src[open];
  let i = open + 1;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    if (quote === "`" && ch === "$" && src[i + 1] === "{") {
      i = skipBraces(src, i + 1);
      continue;
    }
    i += 1;
  }
  return src.length;
}

/** Index just past the `{ … }` group that opens at `open`. */
function skipBraces(src: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return src.length;
}

const isNameChar = (ch: string | undefined): boolean =>
  ch !== undefined &&
  ((ch >= "a" && ch <= "z") ||
    (ch >= "A" && ch <= "Z") ||
    (ch >= "0" && ch <= "9") ||
    ch === "_" ||
    ch === "-" ||
    ch === "." ||
    ch === ":");

interface OpeningTag {
  name: string;
  /** Top-level attributes: a quoted value without its quotes, or the raw `{…}` group. */
  attrs: Map<string, string>;
}

/** Parses the JSX opening tag that starts at `lt` (the `<`), or null if it never closes. */
function parseOpeningTag(src: string, lt: number): OpeningTag | null {
  let i = lt + 1;
  let name = "";
  while (isNameChar(src[i])) {
    name += src[i];
    i += 1;
  }
  if (name === "") return null;
  const attrs = new Map<string, string>();
  while (i < src.length) {
    const ch = src[i];
    if (ch === ">") return { name, attrs };
    if (ch === "{") {
      // A spread such as {...props}: not a named attribute.
      i = skipBraces(src, i);
      continue;
    }
    if (isNameChar(ch)) {
      let attr = "";
      while (isNameChar(src[i])) {
        attr += src[i];
        i += 1;
      }
      if (src[i] !== "=") {
        attrs.set(attr, "");
        continue;
      }
      i += 1;
      const first = src[i];
      if (first === '"' || first === "'") {
        const end = skipString(src, i);
        attrs.set(attr, src.slice(i + 1, end - 1));
        i = end;
      } else if (first === "{") {
        const end = skipBraces(src, i);
        attrs.set(attr, src.slice(i, end));
        i = end;
      }
      continue;
    }
    i += 1;
  }
  return null;
}

/** Result of checking one source text. */
interface Scan {
  occurrences: number;
  violations: string[];
}

function braceInner(raw: string | undefined): string | null {
  if (raw === undefined || !raw.startsWith("{") || !raw.endsWith("}")) return null;
  return raw.slice(1, -1).trim();
}

/** Every `/metodoloji?` in the (comment-blanked) source needs rel nofollow, and prefetch={false} on a Link. */
function scanSource(source: string, file: string): Scan {
  const src = blankComments(source);
  const violations: string[] = [];
  let occurrences = 0;
  let from = 0;
  for (;;) {
    const at = src.indexOf(NEEDLE, from);
    if (at === -1) break;
    from = at + NEEDLE.length;
    occurrences += 1;
    const line = src.slice(0, at).split("\n").length;
    const where = `${file}:${line}`;

    const lt = src.lastIndexOf("<", at);
    const tag = lt === -1 ? null : parseOpeningTag(src, lt);
    if (tag === null) {
      violations.push(`${where}: ${NEEDLE} is not inside a JSX opening tag (put the href on the element itself)`);
      continue;
    }
    const rel = tag.attrs.get("rel");
    const relTokens = (rel ?? "").split(" ").filter((t) => t !== "");
    if (!relTokens.includes("nofollow")) {
      violations.push(`${where}: <${tag.name}> links ${NEEDLE} without rel="nofollow"`);
    }
    if (tag.name === "Link" && braceInner(tag.attrs.get("prefetch")) !== "false") {
      violations.push(`${where}: <Link> links ${NEEDLE} without prefetch={false}`);
    }
  }
  return { occurrences, violations };
}

// --- sweeping src ------------------------------------------------------------

function isTestFile(path: string): boolean {
  return (
    path.endsWith(".test.ts") ||
    path.endsWith(".test.tsx") ||
    path.endsWith(".spec.ts") ||
    path.endsWith(".spec.tsx") ||
    path.split(sep).includes("__tests__")
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if ((name.endsWith(".ts") || name.endsWith(".tsx")) && !isTestFile(p)) out.push(p);
  }
  return out;
}

const KNOWN_LINKS = [
  join("src", "app", "cluster", "[id]", "page.tsx"),
  join("src", "components", "source", "label-card.tsx"),
  join("src", "components", "source", "source-karne.tsx"),
  join("src", "components", "source", "source-reliability.tsx"),
];

describe("/metodoloji? deep links are nofollow and not prefetched (src sweep)", () => {
  const perFile = new Map<string, Scan>();
  for (const path of walk(SRC)) {
    const scan = scanSource(readFileSync(path, "utf8"), relative(ROOT, path));
    if (scan.occurrences > 0) perFile.set(relative(ROOT, path), scan);
  }

  it("finds exactly the four known deep links (non-vacuous; update KNOWN_LINKS deliberately for a new one)", () => {
    expect([...perFile.keys()].sort()).toEqual([...KNOWN_LINKS].sort());
    for (const [file, scan] of perFile) {
      expect(scan.occurrences, file).toBe(1);
    }
  });

  it("every link carries rel=\"nofollow\" (and prefetch={false} on a next/link Link)", () => {
    const violations = [...perFile.values()].flatMap((scan) => scan.violations);
    expect(violations).toEqual([]);
  });

  it("ignores test files and comment mentions (correction-form.tsx only mentions the URLs in comments)", () => {
    expect([...perFile.keys()].some((f) => f.endsWith("correction-form.tsx"))).toBe(false);
    expect([...perFile.keys()].some((f) => f.includes(".test."))).toBe(false);
  });
});

// --- the checker itself: mutations must be caught ---------------------------------

describe("scanSource (mutation tests on synthetic snippets)", () => {
  /** A <Link> to a source deep link; pass null to leave an attribute out. */
  function link(
    parts: { rel?: string | null; prefetch?: string | null } = {},
  ): string {
    const rel = parts.rel === undefined ? 'rel="nofollow"' : parts.rel;
    const prefetch = parts.prefetch === undefined ? "prefetch={false}" : parts.prefetch;
    return [
      "<Link",
      "  href={`/metodoloji?source=${encodeURIComponent(slug)}#duzeltme`}",
      ...(rel === null ? [] : [`  ${rel}`]),
      ...(prefetch === null ? [] : [`  ${prefetch}`]),
      '  className="x"',
      ">",
      "  itiraz",
      "</Link>",
    ].join("\n");
  }

  it("accepts a Link with rel=\"nofollow\" and prefetch={false}", () => {
    expect(scanSource(link(), "good.tsx")).toEqual({ occurrences: 1, violations: [] });
  });

  it("accepts rel with several tokens as long as nofollow is one", () => {
    expect(scanSource(link({ rel: 'rel="noopener nofollow"' }), "tokens.tsx").violations).toEqual([]);
  });

  it("accepts a plain <a> with rel=\"nofollow\" and no prefetch (prefetch only exists on next/link)", () => {
    const src = '<a href="/metodoloji?cluster=1#duzeltme" rel="nofollow">x</a>';
    expect(scanSource(src, "anchor.tsx")).toEqual({ occurrences: 1, violations: [] });
  });

  it("fails when rel is missing", () => {
    const { violations } = scanSource(link({ rel: null }), "no-rel.tsx");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('without rel="nofollow"');
  });

  it("fails when rel names something other than nofollow", () => {
    expect(scanSource(link({ rel: 'rel="noopener"' }), "other-rel.tsx").violations).toHaveLength(1);
  });

  it("fails when rel only appears inside another attribute's value", () => {
    expect(scanSource(link({ rel: 'data-note="rel=nofollow"' }), "fake-rel.tsx").violations).toHaveLength(1);
  });

  it("fails a Link without prefetch", () => {
    const { violations } = scanSource(link({ prefetch: null }), "no-prefetch.tsx");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("without prefetch={false}");
  });

  it("fails a Link with prefetch={true} or a bare prefetch", () => {
    expect(scanSource(link({ prefetch: "prefetch={true}" }), "t.tsx").violations).toHaveLength(1);
    expect(scanSource(link({ prefetch: "prefetch" }), "b.tsx").violations).toHaveLength(1);
  });

  it("reports both problems on a bare <Link>", () => {
    const src = "<Link href={`/metodoloji?cluster=${id}#duzeltme`}>x</Link>";
    expect(scanSource(src, "bare.tsx").violations).toHaveLength(2);
  });

  it("finds the enclosing tag even when a '>' appears inside the href expression or a string", () => {
    const src = [
      "<Link",
      "  href={cond ? `/metodoloji?cluster=${a > b ? 1 : 2}#duzeltme` : '/x'}",
      '  className="a > b"',
      "  rel=\"nofollow\"",
      "  prefetch={false}",
      ">x</Link>",
    ].join("\n");
    expect(scanSource(src, "gt.tsx")).toEqual({ occurrences: 1, violations: [] });
  });

  it("attributes rel to the right element when several tags are in the file", () => {
    const src = [
      '<a href="/other" rel="nofollow">ok</a>',
      "<Link href={`/metodoloji?source=${s}#duzeltme`} prefetch={false}>bad</Link>",
    ].join("\n");
    const { violations } = scanSource(src, "two.tsx");
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("two.tsx:2");
  });

  it("fails an occurrence that is not inside a JSX tag", () => {
    const src = "const href = `/metodoloji?cluster=${id}#duzeltme`;";
    const { occurrences, violations } = scanSource(src, "const.ts");
    expect(occurrences).toBe(1);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain("not inside a JSX opening tag");
  });

  it("ignores a URL that only appears in comments", () => {
    const src = [
      "// links here as `/metodoloji?cluster=<id>#duzeltme`",
      "/* and `/metodoloji?source=<slug>#duzeltme` */",
      '<a href="/metodoloji#duzeltme">x</a>',
    ].join("\n");
    expect(scanSource(src, "comment.tsx")).toEqual({ occurrences: 0, violations: [] });
  });

  it("still counts a URL that follows a comment on the same file", () => {
    const src = ["// note", '<a href="/metodoloji?cluster=1#d">x</a>'].join("\n");
    expect(scanSource(src, "after-comment.tsx")).toEqual({
      occurrences: 1,
      violations: ['after-comment.tsx:2: <a> links /metodoloji? without rel="nofollow"'],
    });
  });

  it("checks every occurrence, not just the first", () => {
    const src = [
      '<a href="/metodoloji?cluster=1#d" rel="nofollow">ok</a>',
      '<a href="/metodoloji?source=2#d">bad</a>',
    ].join("\n");
    const { occurrences, violations } = scanSource(src, "many.tsx");
    expect(occurrences).toBe(2);
    expect(violations).toHaveLength(1);
  });
});
