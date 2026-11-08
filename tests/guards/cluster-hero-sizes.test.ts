import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  CLUSTER_HERO_QUALITY,
  CLUSTER_HERO_SIZES,
} from "@/components/story/cluster-card";

// ---------------------------------------------------------------------------
// Permanent CI guard (h21-perf-3): the cluster page's LCP hero must be
// requested at the width its box really has, at a capped quality.
//
// The hero used `sizes="(min-width: 640px) 384px, 100vw"` with no quality, so a
// 390 px phone at DPR3 asked for 100vw = 1170 px and got the 1200w candidate at
// q=75 (about 61 KB), although the box is `calc(100vw - 2rem)` = 358 px wide
// and needs 1074 px (the 1080w candidate). The home hero already carries this
// fix (MOBILE_BANNER_SIZES, q=50). The cluster hero now has the same shape:
// CLUSTER_HERO_SIZES + CLUSTER_HERO_QUALITY, exported from the SERVER module
// cluster-card.tsx (a non-component export of a 'use client' module would only
// be a client reference on the server), and the page must use them rather than
// a literal.
//
// h73-breakpoints-1: the hero used to go side by side from sm (640 px) next to
// a fixed 384 px photo column, which left the headline a 174-234 px column at
// 640-767 px. It now stays stacked (full-width banner, text below) below md,
// sits in a 288 px column (md:w-72) from md (768 px) and in the 384 px column
// (lg:w-96) from lg (1024 px). `sizes` must follow those columns, and the
// loading skeleton must use the same switch so nothing shifts when it swaps.
//
// Source scans below use character scans, not regexes over JSX.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE_PATH = resolve(ROOT, "src/app/cluster/[id]/page.tsx");
const CARD_PATH = resolve(ROOT, "src/components/story/cluster-card.tsx");
const CARD_IMAGE_PATH = resolve(ROOT, "src/components/story/cluster-card-image.tsx");
const LOADING_PATH = resolve(ROOT, "src/app/cluster/[id]/loading.tsx");
const NEXT_CONFIG_PATH = resolve(ROOT, "next.config.ts");

/** Reads the numeric array assigned to `key:` after the `images: {` block starts. */
function readImagesNumberList(configSrc: string, key: string): number[] {
  const imagesAt = configSrc.indexOf("images: {");
  expect(imagesAt, "next.config.ts has an images block").toBeGreaterThan(-1);
  const keyAt = configSrc.indexOf(`${key}:`, imagesAt);
  expect(keyAt, `images.${key} is configured`).toBeGreaterThan(-1);
  const open = configSrc.indexOf("[", keyAt);
  const close = configSrc.indexOf("]", open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return configSrc
    .slice(open + 1, close)
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => Number(part));
}

/**
 * Blanks block comments and whole-line `//` comments, keeping every offset and
 * newline, with a single left-to-right character scan.
 */
function blankComments(src: string): string {
  const out = src.split("");
  let i = 0;
  let atLineStart = true;
  while (i < src.length) {
    const ch = src[i]!;
    const next = src[i + 1];
    if (ch === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (let j = i; j < stop; j++) if (out[j] !== "\n") out[j] = " ";
      i = stop;
      continue;
    }
    if (ch === "/" && next === "/" && atLineStart) {
      let j = i;
      while (j < src.length && src[j] !== "\n") {
        out[j] = " ";
        j++;
      }
      i = j;
      continue;
    }
    if (ch === "\n") atLineStart = true;
    else if (ch !== " " && ch !== "\t") atLineStart = false;
    i++;
  }
  return out.join("");
}

function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_$:-]/.test(ch);
}

interface JsxElement {
  /** Source from `<Tag` through the closing `/>`. */
  text: string;
  /** Names of the attributes written at the element's top level. */
  props: string[];
}

/**
 * Every self-closing `<tagName ... />` element in `src`, found by a character
 * scan: braces are counted and quoted strings skipped, so a `/>` or `>` inside
 * a prop expression cannot end the element early.
 */
function sliceElements(src: string, tagName: string): JsxElement[] {
  const needle = `<${tagName}`;
  const found: JsxElement[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) break;
    const after = src[start + needle.length];
    from = start + needle.length;
    if (after !== " " && after !== "\n" && after !== "\t" && after !== "\r") continue;

    const props: string[] = [];
    let depth = 0;
    let i = start + needle.length;
    let end = -1;
    while (i < src.length) {
      const ch = src[i]!;
      if (ch === '"' || ch === "'" || ch === "`") {
        // Skip a quoted string (attribute value or string inside an expression).
        let j = i + 1;
        while (j < src.length && src[j] !== ch) {
          if (src[j] === "\\") j++;
          j++;
        }
        i = j + 1;
        continue;
      }
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (depth === 0 && ch === "/" && src[i + 1] === ">") {
        end = i + 2;
        break;
      } else if (depth === 0 && isNameChar(ch) && !isNameChar(src[i - 1])) {
        let j = i;
        while (isNameChar(src[j])) j++;
        props.push(src.slice(i, j));
        i = j;
        continue;
      }
      i++;
    }
    expect(end, `unterminated <${tagName}> at offset ${start}`).toBeGreaterThan(-1);
    found.push({ text: src.slice(start, end), props });
    from = end;
  }
  return found;
}

/** Index of the next `<tagName ...` opening tag at or after `from`, or -1. */
function nextTagStart(src: string, tagName: string, from: number): number {
  const needle = `<${tagName}`;
  let at = src.indexOf(needle, from);
  while (at !== -1) {
    const after = src[at + needle.length];
    if (after === " " || after === "\n" || after === "\t" || after === "\r") return at;
    at = src.indexOf(needle, at + needle.length);
  }
  return -1;
}

/**
 * The opening tag that starts at `start`, through the `>` that closes it:
 * quoted strings are skipped and braces counted, so an arrow `=>` inside a prop
 * expression cannot end the tag early.
 */
function openingTag(src: string, start: number): string {
  let depth = 0;
  let i = start;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < src.length && src[j] !== ch) {
        if (src[j] === "\\") j++;
        j++;
      }
      i = j + 1;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") depth--;
    else if (ch === ">" && depth === 0) return src.slice(start, i + 1);
    i++;
  }
  expect.unreachable(`unterminated opening tag at offset ${start}`);
}

/** The class tokens of a literal `className="..."` in `tag`, or null when it has none. */
function classTokens(tag: string): string[] | null {
  const open = 'className="';
  const at = tag.indexOf(open);
  if (at === -1) return null;
  const from = at + open.length;
  const to = tag.indexOf('"', from);
  if (to === -1) return null;
  return tag
    .slice(from, to)
    .split(" ")
    .filter((token) => token.length > 0);
}

/** Class tokens of every `<div ...>` in `src`, in source order (no literal className -> []). */
function divClassLists(src: string): string[][] {
  const lists: string[][] = [];
  let from = 0;
  for (;;) {
    const at = nextTagStart(src, "div", from);
    if (at === -1) break;
    lists.push(classTokens(openingTag(src, at)) ?? []);
    from = at + 1;
  }
  return lists;
}

interface HeroLayout {
  row: string[];
  photoColumn: string[];
  image: string[];
}

/**
 * The cluster page's hero layout, read from source with comments blanked: the
 * priority ClusterCardImage, the photo column div that wraps it, and the row
 * div that holds the photo column and the text column.
 */
function readPageHeroLayout(pageSrc: string): HeroLayout {
  const heroes = sliceElements(pageSrc, "ClusterCardImage").filter((el) =>
    el.props.includes("priority"),
  );
  expect(heroes, "exactly one priority ClusterCardImage on the page").toHaveLength(1);
  const hero = heroes[0]!;
  const imageAt = pageSrc.indexOf(hero.text);
  const sectionAt = pageSrc.lastIndexOf("<section", imageAt);
  expect(sectionAt, "the hero image sits inside a <section>").toBeGreaterThan(-1);
  const rowAt = nextTagStart(pageSrc, "div", sectionAt);
  const columnAt = nextTagStart(pageSrc, "div", rowAt + 1);
  expect(rowAt, "the hero section opens with a row div").toBeGreaterThan(sectionAt);
  expect(columnAt, "the photo column div sits between the row and the image").toBeLessThan(imageAt);
  const row = classTokens(openingTag(pageSrc, rowAt));
  const photoColumn = classTokens(openingTag(pageSrc, columnAt));
  const image = classTokens(hero.text);
  expect(row, "the hero row div has a literal className").not.toBeNull();
  expect(photoColumn, "the photo column div has a literal className").not.toBeNull();
  expect(image, "the hero ClusterCardImage has a literal className").not.toBeNull();
  return { row: row!, photoColumn: photoColumn!, image: image! };
}

/** Tailwind width token (`w-72`) to px (4 px per step; only integer steps are used here). */
function widthTokenPx(token: string): number {
  const step = Number(token.slice(token.indexOf("w-") + 2));
  expect(Number.isInteger(step), `width token "${token}"`).toBe(true);
  return step * 4;
}

/** Tailwind height token (`md:h-54`) to px (4 px per step; only integer steps are used here). */
function heightTokenPx(token: string): number {
  const step = Number(token.slice(token.indexOf("h-") + 2));
  expect(Number.isInteger(step), `height token "${token}"`).toBe(true);
  return step * 4;
}

describe("cluster hero sizes (h21-perf-3)", () => {
  const configSrc = readFileSync(NEXT_CONFIG_PATH, "utf8");

  it("has no bare 100vw term, and is the gutter-aware calc(100vw - 2rem)", () => {
    const terms = CLUSTER_HERO_SIZES.split(",").map((term) => term.trim());
    expect(terms.length).toBeGreaterThan(1);
    for (const term of terms) {
      expect(term, `bare 100vw term in ${CLUSTER_HERO_SIZES}`).not.toBe("100vw");
      expect(term.endsWith(" 100vw"), `bare 100vw slot in "${term}"`).toBe(false);
    }
    expect(CLUSTER_HERO_SIZES).toContain("calc(100vw - 2rem)");
    // Stacked full-width banner below md (the gutter-aware calc), a 288 px photo
    // column from md (768 px, md:w-72) and the 384 px one from lg (1024 px,
    // lg:w-96) -- h73-breakpoints-1. Slots run widest breakpoint first.
    expect(CLUSTER_HERO_SIZES).toBe(
      "(min-width: 1024px) 384px, (min-width: 768px) 288px, calc(100vw - 2rem)",
    );
  });

  it("uses a quality next.config.ts allows, capped at 60", () => {
    const qualities = readImagesNumberList(configSrc, "qualities");
    expect(qualities.length).toBeGreaterThan(0);
    expect(qualities).toContain(CLUSTER_HERO_QUALITY);
    expect(CLUSTER_HERO_QUALITY).toBeLessThanOrEqual(60);
  });

  it("picks the 1080w candidate for a 390 px phone at DPR3", () => {
    const deviceSizes = readImagesNumberList(configSrc, "deviceSizes");
    const imageSizes = readImagesNumberList(configSrc, "imageSizes");
    // 390 px viewport minus the 2rem (32 px) gutters, times DPR3.
    const neededPx = (390 - 32) * 3;
    expect(neededPx).toBe(1074);
    // Without a `vw` percentage term next/image offers imageSizes + deviceSizes
    // as srcset candidates; the browser takes the smallest one that covers the slot.
    const candidates = [...imageSizes, ...deviceSizes].sort((a, b) => a - b);
    const picked = candidates.find((w) => w >= neededPx);
    expect(picked).toBe(1080);
    expect(deviceSizes).toContain(1080);
    // The old `100vw` slot (390 * 3 = 1170) would have taken the next one up.
    expect(candidates.find((w) => w >= 390 * 3)).toBe(1200);
  });

  it("exports the constants from the server module, not from the 'use client' image component", () => {
    const cardSrc = readFileSync(CARD_PATH, "utf8");
    const imageSrc = readFileSync(CARD_IMAGE_PATH, "utf8");
    expect(cardSrc).toContain("export const CLUSTER_HERO_SIZES");
    expect(cardSrc).toContain("export const CLUSTER_HERO_QUALITY");
    expect(cardSrc.trimStart().startsWith('"use client"')).toBe(false);
    expect(imageSrc).not.toContain("CLUSTER_HERO_SIZES");
    expect(imageSrc).not.toContain("CLUSTER_HERO_QUALITY");
  });

  it("passes the constants to the priority ClusterCardImage on the cluster page, with no literal sizes", () => {
    const pageSrc = blankComments(readFileSync(PAGE_PATH, "utf8"));
    const images = sliceElements(pageSrc, "ClusterCardImage");
    expect(images.length).toBeGreaterThan(0);

    const heroes = images.filter((el) => el.props.includes("priority"));
    expect(heroes, "exactly one priority ClusterCardImage on the page").toHaveLength(1);
    const hero = heroes[0]!;
    expect(hero.text).toContain("sizes={CLUSTER_HERO_SIZES}");
    expect(hero.text).toContain("quality={CLUSTER_HERO_QUALITY}");
    expect(hero.text).not.toContain('sizes="');
    expect(hero.text).not.toContain("100vw");

    expect(pageSrc).toContain('from "@/components/story/cluster-card"');
    const importAt = pageSrc.indexOf('from "@/components/story/cluster-card"');
    const importStart = pageSrc.lastIndexOf("import", importAt);
    const importClause = pageSrc.slice(importStart, importAt);
    expect(importClause).toContain("CLUSTER_HERO_SIZES");
    expect(importClause).toContain("CLUSTER_HERO_QUALITY");
  });

  it("the page hero stays stacked below md and goes side by side from md (h73-breakpoints-1)", () => {
    const { row, photoColumn, image } = readPageHeroLayout(
      blankComments(readFileSync(PAGE_PATH, "utf8")),
    );
    // Row: stacked (flex-col) by default, side by side from md, never from sm.
    expect(row).toContain("flex");
    expect(row).toContain("flex-col");
    expect(row).toContain("md:flex-row");
    expect(row).not.toContain("sm:flex-row");
    // Photo column: full width when stacked, 288 px from md, 384 px from lg.
    expect(photoColumn).toContain("w-full");
    expect(photoColumn).toContain("md:w-72");
    expect(photoColumn).toContain("lg:w-96");
    expect(photoColumn).not.toContain("sm:w-96");
    expect(photoColumn).not.toContain("sm:shrink-0");
    // Image height follows the column, keeping the box 4:3: h-44, sm:h-60,
    // md:h-54 (288x216), lg:h-72 (384x288).
    expect(image).toContain("md:h-54");
    expect(image).toContain("lg:h-72");
    expect(image).not.toContain("md:h-72");
    expect(image).not.toContain("sm:h-72");
  });

  it("the hero photo box is 4:3 at md and lg, so a 4:3 photo is painted at the sizes slot width", () => {
    const { photoColumn, image } = readPageHeroLayout(
      blankComments(readFileSync(PAGE_PATH, "utf8")),
    );
    // ClusterCardImage paints `absolute inset-0 h-full w-full object-cover`: in a
    // square box a 4:3 photo is limited by height and painted wider than the
    // column, so `sizes` (the column width) would under-request it. A 4:3 box
    // (the width=768/height=576 props) paints it at exactly the column width.
    for (const bp of ["md", "lg"]) {
      const w = photoColumn.find((t) => t.startsWith(`${bp}:w-`));
      const h = image.find((t) => t.startsWith(`${bp}:h-`));
      expect(w, `photo column has a ${bp}:w-* token`).toBeDefined();
      expect(h, `hero image has a ${bp}:h-* token`).toBeDefined();
      expect(
        widthTokenPx(w!) * 3,
        `${bp}: ${w} x ${h} is not 4:3`,
      ).toBe(heightTokenPx(h!) * 4);
    }
  });

  it("the loading skeleton uses the page's hero breakpoints, so nothing shifts when it swaps (h73-breakpoints-1)", () => {
    const lists = divClassLists(blankComments(readFileSync(LOADING_PATH, "utf8")));
    const rowAt = lists.findIndex((tokens) => tokens.includes("flex-col"));
    expect(rowAt, "the hero skeleton has a flex-col row div").toBeGreaterThan(-1);
    const row = lists[rowAt]!;
    const photo = lists[rowAt + 1]!;
    expect(photo, "the photo block follows the row").toContain("animate-shimmer");
    expect(row).toContain("md:flex-row");
    expect(row).not.toContain("sm:flex-row");
    expect(photo).toContain("w-full");
    expect(photo).toContain("md:w-72");
    expect(photo).toContain("lg:w-96");
    expect(photo).not.toContain("sm:w-80");
    expect(photo).not.toContain("sm:w-96");
  });

  it("CLUSTER_HERO_SIZES slots equal the photo column widths at md and lg", () => {
    const { photoColumn } = readPageHeroLayout(blankComments(readFileSync(PAGE_PATH, "utf8")));
    const breakpointPx: Record<string, number> = { md: 768, lg: 1024 };
    const slots: string[] = [];
    for (const bp of ["lg", "md"]) {
      const token = photoColumn.find((t) => t.startsWith(`${bp}:w-`));
      expect(token, `photo column has a ${bp}:w-* token`).toBeDefined();
      slots.push(`(min-width: ${breakpointPx[bp]}px) ${widthTokenPx(token!)}px`);
    }
    expect(CLUSTER_HERO_SIZES).toBe(`${slots.join(", ")}, calc(100vw - 2rem)`);
  });

  it("sliceElements ignores a '/>' inside a prop expression and a tag name inside a comment", () => {
    const sample = [
      "// <ClusterCardImage priority />",
      "const a = (",
      "  <ClusterCardImage",
      "    alt={cond ? 'a/>b' : \"c\"}",
      "    sizes=\"x, 100vw\"",
      "    priority",
      "  />",
      ");",
      "const b = <ClusterCardImage alt=\"b\" />;",
    ].join("\n");
    const els = sliceElements(blankComments(sample), "ClusterCardImage");
    expect(els).toHaveLength(2);
    expect(els[0]!.props).toEqual(["alt", "sizes", "priority"]);
    expect(els[0]!.text).toContain('sizes="x, 100vw"');
    expect(els[1]!.props).toEqual(["alt"]);
  });
});
