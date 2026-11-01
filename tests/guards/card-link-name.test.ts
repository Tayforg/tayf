import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG 4.1.2 name / 2.4.4 link purpose / 2.5.3 label in
// name, h10-a11y-1). Chrome never builds a link's accessible name from the
// content of an <article> or <section> descendant: those roles are excluded
// from name-from-content. So `<a><article><h2>Başlık</h2></article></a>`
// produced `role=link name=""` for every story card on /, /blindspots and
// /konu/*, and axe-core's link-name rule passes it, so nothing else would
// notice. Wrap the link in the <article> (and name it with aria-labelledby),
// never the other way round.
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
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/** Blanks // and block comments, keeping offsets. Good enough for these files (no `//` inside strings). */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

interface LinkElement {
  /** "Link" or "a" */
  name: "Link" | "a";
  /** 1-based line of the opening tag */
  line: number;
  /** Source from the opening `<` to the first matching close tag */
  text: string;
}

/**
 * Every `<Link ...>...</Link>` and `<a ...>...</a>` element of a (comment
 * blanked) source string, with the text up to its FIRST closing tag. Anchors
 * cannot nest, so the first close tag is the matching one. A self-closing
 * `<Link ... />` has no content and is skipped. The opening tag is scanned to
 * the first `>` outside braces and string/template literals, so an arrow
 * function or a `>` inside a prop value does not end it early.
 */
function linkElements(src: string): LinkElement[] {
  const found: LinkElement[] = [];
  const re = /<(Link|a)(?=[\s>])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const name = m[1] as "Link" | "a";
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
    if (src[i - 1] === "/") continue; // self-closing: no content
    const close = src.indexOf(`</${name}>`, i);
    const end = close === -1 ? src.length : close;
    found.push({
      name,
      line: src.slice(0, m.index).split("\n").length,
      text: src.slice(m.index, end),
    });
  }
  return found;
}

/** Elements whose content holds a role Chrome skips for the link's name. */
function nameBlockers(src: string): LinkElement[] {
  return linkElements(blankComments(src)).filter((el) =>
    /<(article|section)(?![\w-])/.test(el.text),
  );
}

describe("nameBlockers (the scanner this guard relies on)", () => {
  it("flags an <article> inside a <Link>", () => {
    const bad = `<Link href="/cluster/1" className="block"><article><h2>Başlık</h2></article></Link>`;
    expect(nameBlockers(bad)).toHaveLength(1);
  });

  it("flags a <section> inside a plain <a>, however deep", () => {
    const bad = `<a href="/x">\n  <div>\n    <section>x</section>\n  </div>\n</a>`;
    const hits = nameBlockers(bad);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("a");
    expect(hits[0]!.line).toBe(1);
  });

  it("flags an <article> that carries attributes", () => {
    expect(nameBlockers(`<Link href="/x"><article className="p-2">t</article></Link>`)).toHaveLength(1);
  });

  it("passes the fixed shape: the <article> is the OUTER wrapper, the link holds <div>s", () => {
    const good = `<article className="relative"><Link href="/x" aria-labelledby="h"><div><h2 id="h">t</h2></div></Link></article>`;
    expect(nameBlockers(good)).toEqual([]);
  });

  it("does not flag a sibling <article> that comes after the closing tag", () => {
    expect(nameBlockers(`<Link href="/x">t</Link><article>other</article>`)).toEqual([]);
  });

  it("does not read <article> mentioned in a comment", () => {
    expect(nameBlockers(`<Link href="/x">{/* was <article> */}t</Link>`)).toEqual([]);
    expect(nameBlockers(`<Link href="/x">\n// <section>\nt</Link>`)).toEqual([]);
  });

  it("does not confuse longer tag names (<Linkify>, <abbr>, <articleX>)", () => {
    expect(nameBlockers(`<Linkify><article>x</article></Linkify>`)).toEqual([]);
    expect(nameBlockers(`<abbr title="t"><article>x</article></abbr>`)).toEqual([]);
    expect(nameBlockers(`<Link href="/x"><articleX /></Link>`)).toEqual([]);
  });

  it("does not end the opening tag at an arrow function or a '>' inside a string", () => {
    const bad = `<Link href="/x" onClick={() => go(a > b)} className="a>b"><article>t</article></Link>`;
    expect(nameBlockers(bad)).toHaveLength(1);
  });

  it("skips a self-closing <Link />", () => {
    expect(nameBlockers(`<Link href="/x" /><article>t</article>`)).toEqual([]);
  });

  it("checks every link in a file, not just the first", () => {
    const src = `<Link href="/a">a</Link>\n<a href="/b"><article>b</article></a>`;
    const hits = nameBlockers(src);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.line).toBe(2);
  });
});

describe("links never wrap an <article> or <section> (h10-a11y-1)", () => {
  const files = walk(SRC);
  const sources = files.map((f) => ({ file: relative(ROOT, f), code: readFileSync(f, "utf8") }));

  it("scans a real number of links (the scanner is not vacuous)", () => {
    const total = sources.reduce((n, s) => n + linkElements(blankComments(s.code)).length, 0);
    expect(total).toBeGreaterThanOrEqual(30);
  });

  it("finds the story card's <Link> in cluster-card.tsx", () => {
    const card = sources.find((s) => s.file.endsWith("components/story/cluster-card.tsx"));
    expect(card).toBeDefined();
    const links = linkElements(blankComments(card!.code)).filter((el) => el.name === "Link");
    expect(links).toHaveLength(1);
    // It is the card link: it points at /cluster/{id} and holds the headline.
    expect(links[0]!.text).toContain("/cluster/${cluster.id}");
    expect(links[0]!.text).toContain("<h2");
  });

  it("has no src .tsx file where a <Link> or <a> contains an <article> or <section>", () => {
    const offenders = sources.flatMap((s) =>
      nameBlockers(s.code).map((el) => `${s.file}:${el.line} <${el.name}> wraps an <article>/<section>`),
    );
    expect(offenders).toEqual([]);
  });
});
