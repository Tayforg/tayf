import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (h67-landmarks-2): the cluster page hero photo is
// decorative for assistive tech.
//
// The hero's alt used to be `const heroAlt = headline`, exactly the text of the
// <h1> printed beside it, so a screen reader announced the headline twice (the
// photo, then the heading). ClusterCard's thumbnails already pass alt="" for the
// same reason. ClusterCardImage treats alt="" as decorative: <img alt=""> on the
// photo tier, and no role="img" on the logo and placeholder tiers. The photo is
// still identified by its visible credit line ("Görsel: <outlet> sayfasından").
// `lang={headlineLang}` stays on the hero so it gets the right language if it is
// ever named again; while alt is empty it is inert for assistive tech (it only
// tags the aria-hidden logo caption).
//
// Source scans use character scans, not regexes over JSX.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const PAGE_PATH = resolve(ROOT, "src/app/cluster/[id]/page.tsx");

/** Blanks block comments and whole-line `//` comments, keeping every offset. */
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

/**
 * Every self-closing `<tagName ... />` element in `src`: braces are counted and
 * quoted strings skipped, so a `/>` inside a prop expression cannot end the
 * element early.
 */
function sliceElements(src: string, tagName: string): string[] {
  const needle = `<${tagName}`;
  const found: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(needle, from);
    if (start === -1) break;
    from = start + needle.length;
    const after = src[from];
    if (after !== " " && after !== "\n" && after !== "\t" && after !== "\r") continue;

    let depth = 0;
    let i = from;
    let end = -1;
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
      else if (depth === 0 && ch === "/" && src[i + 1] === ">") {
        end = i + 2;
        break;
      }
      i++;
    }
    if (end !== -1) found.push(src.slice(start, end));
  }
  return found;
}

/** The source of the attribute `name`'s value (`"..."` or `{...}`), or null. */
function attrValue(element: string, name: string): string | null {
  const needle = `${name}=`;
  let from = 0;
  for (;;) {
    const at = element.indexOf(needle, from);
    if (at === -1) return null;
    from = at + needle.length;
    const before = element[at - 1];
    // `logoAlt=` must not be mistaken for `alt=`.
    if (before !== " " && before !== "\n" && before !== "\t" && before !== "\r") continue;
    const open = element[from];
    if (open === '"') {
      const close = element.indexOf('"', from + 1);
      return element.slice(from, close + 1);
    }
    if (open === "{") {
      let depth = 0;
      for (let i = from; i < element.length; i++) {
        if (element[i] === "{") depth++;
        else if (element[i] === "}") {
          depth--;
          if (depth === 0) return element.slice(from, i + 1);
        }
      }
    }
    return null;
  }
}

const pageSource = readFileSync(PAGE_PATH, "utf8");
const code = blankComments(pageSource);

describe("cluster page hero image is decorative (h67-landmarks-2)", () => {
  const heroes = sliceElements(code, "ClusterCardImage");

  it("renders exactly one ClusterCardImage, the hero", () => {
    expect(heroes).toHaveLength(1);
  });

  it('passes an empty alt (alt="" or alt={""}), so the headline is not read twice', () => {
    const alt = attrValue(heroes[0] ?? "", "alt");
    expect(alt, "the hero ClusterCardImage still passes an alt prop").not.toBeNull();
    expect(['""', '{""}']).toContain(alt);
  });

  it("no longer derives the alt from the headline", () => {
    expect(code).not.toContain("const heroAlt = headline");
    expect(heroes[0] ?? "").not.toContain("alt={headline}");
    expect(heroes[0] ?? "").not.toContain("alt={heroAlt}");
  });

  it("keeps lang={headlineLang} on the hero (inert while alt is empty; kept for when the hero is named again)", () => {
    expect(attrValue(heroes[0] ?? "", "lang")).toBe("{headlineLang}");
  });

  it("keeps the photo credit line, which still identifies the photo for everyone", () => {
    expect(attrValue(heroes[0] ?? "", "credits")).toBe("{heroCredits}");
  });

  it("keeps the logo caption named by the outlet, not by the headline", () => {
    const logoAlt = attrValue(heroes[0] ?? "", "logoAlt") ?? "";
    expect(logoAlt).toContain("source.name");
    expect(logoAlt).not.toContain("headline");
  });

  it("explains in a comment that the adjacent h1 is the text alternative", () => {
    expect(pageSource).toMatch(/decorative/i);
  });
});
