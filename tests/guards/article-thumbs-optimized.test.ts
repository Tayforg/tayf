import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (perf-2): article thumbnails never ship a raw publisher
// URL.
//
// /source/[slug] used to render `<img src={normalizeImageUrl(article.image_url)}>`
// for 20 rows: every visitor downloaded the publisher's full-size original
// (often 1200 px or more, for an 80 px slot). The thumbnail now goes through
// `/_next/image` at the slot size:
//
//     const thumb = optimizedThumbSrcSet(article.image_url);
//     <img src={thumb.src} srcSet={thumb.srcSet} sizes="..." width={80} ... />
//
// Two rules:
//   (a) the /source page builds its thumb with optimizedThumbSrcSet, never
//       normalizeImageUrl, and every <img> there declares srcSet, sizes,
//       width, height and loading="lazy";
//   (b) in any non-test .tsx under src/, no <img> takes its src straight from
//       an `image_url` column or from normalizeImageUrl(...). Logos are the
//       sanctioned exception, and they go through firstPartyLogoUrl.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");
const SOURCE_PAGE = join(SRC_DIR, "app", "source", "[slug]", "page.tsx");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/**
 * Blanks block and line comments (keeping newlines, so line numbers hold) so a
 * comment that mentions `<img>` is never mistaken for a tag. A `//` only
 * starts a comment at the start of a line or after whitespace, so `https://`
 * inside a string survives.
 */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|\s)\/\/[^\n]*/g, (_m, lead: string) => lead);
}

interface Tag {
  /** The opening tag, from `<img` through its closing `>` or `/>`. */
  tag: string;
  /** 1-based line of the tag in its file. */
  line: number;
}

/**
 * Slices the opening tag that starts at `start` (the `<`). A plain `>` search
 * would stop at the `=>` of an arrow function inside an attribute, so this
 * tracks `{}` depth and skips quoted strings while at depth 0. The tag ends at
 * the first `>` at depth 0, which is the `>` of `/>`.
 */
function sliceOpeningTag(src: string, start: number): string | null {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i]!;
    if (depth === 0 && (ch === '"' || ch === "'")) {
      const close = src.indexOf(ch, i + 1);
      if (close === -1) return null;
      i = close;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth = Math.max(0, depth - 1);
    } else if (ch === ">" && depth === 0) {
      return src.slice(start, i + 1);
    }
  }
  return null;
}

function imgTags(rawSrc: string): Tag[] {
  const src = stripComments(rawSrc);
  const out: Tag[] = [];
  for (const match of src.matchAll(/<img(?=[\s/>])/g)) {
    const start = match.index ?? 0;
    const tag = sliceOpeningTag(src, start);
    if (tag === null) continue;
    out.push({ tag, line: src.slice(0, start).split("\n").length });
  }
  return out;
}

/**
 * The source text of the tag's `src` attribute value: `"..."`, `'...'` or the
 * balanced `{...}` expression. `srcSet=` and `data-src=` are not `src=`.
 */
function srcExpressionOf(tag: string): string | null {
  const m = /(?<![\w-])src=/.exec(tag);
  if (!m) return null;
  const i = m.index + m[0].length;
  const open = tag[i];
  if (open === '"' || open === "'") {
    const close = tag.indexOf(open, i + 1);
    return close === -1 ? null : tag.slice(i + 1, close);
  }
  if (open !== "{") return null;
  let depth = 0;
  for (let j = i; j < tag.length; j++) {
    if (tag[j] === "{") depth++;
    else if (tag[j] === "}" && --depth === 0) return tag.slice(i + 1, j);
  }
  return null;
}

const RAW_SOURCE = /image_url|normalizeImageUrl\(/;

/** Rule (b): the tag's src expression reads a raw image column. */
const readsRawImage = (tag: string): boolean =>
  RAW_SOURCE.test(srcExpressionOf(tag) ?? "");

/** Rule (a): the attributes an optimised thumbnail must declare. */
const REQUIRED_THUMB_ATTRS: ReadonlyArray<readonly [string, RegExp]> = [
  ["srcSet", /(?<![\w-])srcSet=/],
  ["sizes", /(?<![\w-])sizes=/],
  ["width", /(?<![\w-])width=/],
  ["height", /(?<![\w-])height=/],
  ["loading", /(?<![\w-])loading=(?:"lazy"|\{\s*"lazy"\s*\})/],
];
const missingThumbAttrs = (tag: string): string[] =>
  REQUIRED_THUMB_ATTRS.filter(([, re]) => !re.test(tag)).map(([name]) => name);

const IMPORTS_THUMB_HELPER =
  /import\s*\{[^}]*\boptimizedThumbSrcSet\b[^}]*\}\s*from\s*["']@\/lib\/images\/image-url["']/;

const pageSrc = readFileSync(SOURCE_PAGE, "utf8");
const pageTags = imgTags(pageSrc);

const files = walk(SRC_DIR).sort();
const sources = files.map((file) => ({ file, src: readFileSync(file, "utf8") }));
const allTags = sources.flatMap(({ file, src }) =>
  imgTags(src).map((t) => ({ ...t, file: relative(ROOT, file) })),
);

describe("article thumbnails are optimised (perf-2)", () => {
  describe("(a) /source/[slug]", () => {
    it("does not use normalizeImageUrl (that is a raw publisher URL)", () => {
      expect(pageSrc).not.toContain("normalizeImageUrl");
    });

    it("builds its thumbnail with optimizedThumbSrcSet", () => {
      expect(pageSrc).toMatch(IMPORTS_THUMB_HELPER);
      expect(pageSrc).toMatch(/optimizedThumbSrcSet\(\s*article\.image_url\s*\)/);
    });

    it("declares srcSet, sizes, width, height and loading=lazy on every <img>", () => {
      const bad = pageTags
        .map((t) => ({ line: t.line, missing: missingThumbAttrs(t.tag) }))
        .filter((t) => t.missing.length > 0)
        .map((t) => `page.tsx:${t.line} is missing ${t.missing.join(", ")}`);
      expect(bad, bad.join("\n")).toEqual([]);
    });

    it("reads the src from the thumb helper, not from the article row", () => {
      for (const { tag } of pageTags) {
        expect(srcExpressionOf(tag)).toBe("thumb.src");
        expect(readsRawImage(tag)).toBe(false);
      }
    });

    it("is not vacuous: the page has an <img>", () => {
      expect(pageTags.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("(b) all of src/", () => {
    it("never feeds an <img> src from image_url or normalizeImageUrl(...)", () => {
      const offenders = allTags
        .filter(({ tag }) => readsRawImage(tag))
        .map(({ file, line }) => `${file}:${line}`);
      expect(
        offenders,
        `An <img> src must not be a raw publisher URL. Use optimizedThumbSrcSet / optimizedThumbUrl (article photos) or firstPartyLogoUrl (logos):\n${offenders.join("\n")}`,
      ).toEqual([]);
    });

    it("is not vacuous: scans the site's <img> tags and their src expressions", () => {
      expect(files.length).toBeGreaterThan(50);
      expect(files.some((f) => /\.test\./.test(f))).toBe(false);
      expect(allTags.length).toBeGreaterThanOrEqual(3);

      const where = allTags.map(({ file }) => file);
      expect(where).toContain("src/components/source/source-logo.tsx");
      expect(where).toContain("src/components/story/cluster-card-image.tsx");
      expect(where).toContain("src/app/source/[slug]/page.tsx");

      const expressions = allTags.map(({ tag }) => srcExpressionOf(tag));
      expect(expressions.every((e) => e !== null && e.length > 0)).toBe(true);
    });
  });

  describe("the guard itself works", () => {
    const GOOD = `<img src={thumb.src} srcSet={thumb.srcSet} sizes="80px" width={80} height={80} alt="" loading="lazy" decoding="async" className="h-16" />`;

    it("finds a tag and its src expression", () => {
      const [only] = imgTags(`<div>${GOOD}</div>`);
      expect(only).toBeDefined();
      expect(only!.tag).toBe(GOOD);
      expect(srcExpressionOf(only!.tag)).toBe("thumb.src");
    });

    it("passes a fully declared optimised thumbnail", () => {
      expect(missingThumbAttrs(GOOD)).toEqual([]);
      expect(readsRawImage(GOOD)).toBe(false);
    });

    it("fails each missing required attribute", () => {
      expect(missingThumbAttrs(GOOD.replace(" srcSet={thumb.srcSet}", ""))).toEqual(["srcSet"]);
      expect(missingThumbAttrs(GOOD.replace(' sizes="80px"', ""))).toEqual(["sizes"]);
      expect(missingThumbAttrs(GOOD.replace(" width={80}", ""))).toEqual(["width"]);
      expect(missingThumbAttrs(GOOD.replace(" height={80}", ""))).toEqual(["height"]);
      expect(missingThumbAttrs(GOOD.replace(' loading="lazy"', ""))).toEqual(["loading"]);
      expect(missingThumbAttrs(GOOD.replace('"lazy"', '"eager"'))).toEqual(["loading"]);
    });

    it("does not let srcSet or data-src stand in for the plain attribute", () => {
      expect(srcExpressionOf('<img srcSet={a} data-src={b} alt="" />')).toBeNull();
      expect(missingThumbAttrs('<img data-sizes="x" data-width="1" />')).toContain("sizes");
    });

    it("fails a src read from an image_url column", () => {
      expect(readsRawImage('<img src={article.image_url} alt="" />')).toBe(true);
      expect(readsRawImage('<img src={a.image_url ?? ""} alt="" />')).toBe(true);
      expect(readsRawImage("<img src={`${m.image_url}?w=1`} alt='' />")).toBe(true);
    });

    it("fails a src built by normalizeImageUrl(...)", () => {
      expect(readsRawImage('<img src={normalizeImageUrl(x)} alt="" />')).toBe(true);
      expect(readsRawImage('<img alt="" src={normalizeImageUrl(x) ?? ""} />')).toBe(true);
    });

    it("passes the sanctioned logo and thumb spellings", () => {
      expect(readsRawImage("<img src={firstPartyLogoUrl(logoUrl, width) ?? logoUrl} />")).toBe(false);
      expect(readsRawImage("<img src={thumb.src} />")).toBe(false);
      expect(readsRawImage('<img src="/static/logo.png" />')).toBe(false);
    });

    it("reads a multi-line tag, an arrow function and a nested object in an attribute", () => {
      const src = `
        <img
          onError={() => setFailed({ ok: false })}
          src={normalizeImageUrl(row.image_url)}
          alt=""
        />
      `;
      const [only] = imgTags(src);
      expect(only).toBeDefined();
      expect(only!.line).toBe(2);
      expect(only!.tag.endsWith("/>")).toBe(true);
      expect(readsRawImage(only!.tag)).toBe(true);
    });

    it("ignores <img> mentioned in comments, but not a real tag after one", () => {
      const src = [
        "// placeholder block instead of a broken <img> .",
        "/* a plain <img src={x.image_url} /> would be bad */",
        "{/* <img src={x.image_url} /> */}",
        '<a href="https://example.test/x">link</a>',
        "<img src={x.image_url} alt='' />",
      ].join("\n");
      const tags = imgTags(src);
      expect(tags).toHaveLength(1);
      expect(tags[0]!.line).toBe(5);
    });

    it("does not mistake a longer name for <img>", () => {
      expect(imgTags("<imgFoo src={x.image_url} />")).toEqual([]);
      expect(imgTags('<Image src={x.image_url} alt="" />')).toEqual([]);
    });
  });
});
