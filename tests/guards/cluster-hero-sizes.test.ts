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
// Source scans below use character scans, not regexes over JSX.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE_PATH = resolve(ROOT, "src/app/cluster/[id]/page.tsx");
const CARD_PATH = resolve(ROOT, "src/components/story/cluster-card.tsx");
const CARD_IMAGE_PATH = resolve(ROOT, "src/components/story/cluster-card-image.tsx");
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
    // Desktop keeps the fixed 384 px column the image sits in (sm:w-96).
    expect(CLUSTER_HERO_SIZES).toContain("(min-width: 640px) 384px");
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
