import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BIAS_COLORS, ZONE_META } from "@/lib/bias/config";

// ---------------------------------------------------------------------------
// Permanent CI guard (a11y-2): text must use the full `text-muted-foreground`
// / `text-brand` tokens. Any opacity-modified form (`/10` .. `/90`) composites
// below the WCAG 1.4.3 floor of 4.5:1 for text. Measured for
// `text-muted-foreground` in both themes on the page background and the card
// (alpha-composited in gamma space):
//   /40 1.8   /60 2.5-2.6   /70 3.1-3.2   /80 3.7-3.8   /90 4.3-4.8
// so even /80 fails (3.68 on the dark card) and /90 fails on the dark card
// (4.33). Only the full token clears 4.5:1 everywhere (5.1-6.0). Visual
// hierarchy comes from the existing size and weight differences (10-11 px,
// semibold vs regular), never from opacity.
//
// The same ban covers state-modifier forms: `placeholder:text-muted-foreground/70`
// and `hover:text-brand/80` are text colours too. A hover affordance that
// needs to read as "active" uses `hover:decoration-solid` (or a full-token
// swap such as `hover:text-foreground`), not a faded brand colour.
//
// Scope: every non-test .tsx under src/ (components and app routes alike).
// This was originally limited to src/components/story/ plus the cluster page;
// the sweep widened it so a new page cannot reintroduce the pattern.
//
// Second guard (qa-wave-i, story-chips): the same arithmetic applies to the
// element-level `opacity-NN` utility, which fades the text AND its background
// tint together. The Medya DNA chips used opacity-50 / opacity-30 and the kind
// label opacity-70, which measured 2.0-3.25:1. Under src/components/story/
// no class may carry a bare `opacity-5`..`opacity-99` or `opacity-[x]`.
// `opacity-0` / `opacity-100` (show / hide toggles) and variant forms such as
// `hover:`, `disabled:`, `group-hover/x:` and `data-*:` (state affordances
// that do not rest on screen) are not matched. The one exception is the
// logo-tier <img> source badge, allow-listed below; it is not text.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");
const STORY_DIR = join(ROOT, "src/components/story");
const CLUSTER_PAGE = join(ROOT, "src/app/cluster/[id]/page.tsx");

// Any numeric opacity suffix except `/100` (which is the full token).
const LOW_CONTRAST_TEXT = /\btext-(?:muted-foreground|brand)\/(?!100\b)\d+\b/;
const LOW_CONTRAST_TEXT_GLOBAL = new RegExp(LOW_CONTRAST_TEXT.source, "g");

// A bare element-opacity utility: opacity-5 .. opacity-99, or an arbitrary
// opacity-[x]. The lookbehind rejects any variant prefix (`hover:`,
// `disabled:`, `group-hover/entry:`, `data-[open]:` all end in `:`) and
// compounds such as `transition-opacity`; the lookahead rejects opacity-0 /
// opacity-100 / opacity-25-style longer tokens being cut short.
const BARE_OPACITY = /(?<![\w:\/-])opacity-(?:[1-9]\d?|\[[^\]\s]+\])(?![\w-])/;
const BARE_OPACITY_GLOBAL = new RegExp(BARE_OPACITY.source, "g");

/**
 * Non-text decorative icons, exempt from 1.4.3 (it governs text; icons fall
 * under 1.4.11 only when they carry meaning, and these are aria-hidden
 * decorations or hover-only affordances). Each entry is the exact class string
 * as written in `file` (repo-relative). Two tests keep the list honest:
 *  - staleness: the string must still exist in THAT file, so an entry cannot
 *    silently outlive the code it excuses or be satisfied by another file;
 *  - aria-hidden: the JSX element carrying the string must be
 *    `aria-hidden="true"`, i.e. genuinely non-text and invisible to
 *    assistive tech, so a text node can never hide behind this list.
 */
const ALLOWED_ICON_CLASSES: ReadonlyArray<{ file: string; classes: string; why: string }> = [
  {
    // <Newspaper aria-hidden="true" /> placeholder glyph on the tier-3 gray
    // gradient; purely decorative, no text.
    file: "src/components/story/cluster-card-image.tsx",
    classes: "h-5 w-5 text-muted-foreground/30",
    why: "cluster-card-image Newspaper placeholder icon",
  },
  {
    // <ExternalLink aria-hidden="true" /> glyph that only fades in on hover
    // (opacity-0 -> opacity-100); decorative, the link text is separate.
    file: "src/components/story/framing-comparison.tsx",
    classes: "h-2.5 w-2.5 text-muted-foreground/50",
    why: "framing-comparison ExternalLink hover icon",
  },
];

/**
 * Element-opacity class strings that stay under src/components/story/ because
 * the element is not text. Each entry is the exact class string as written in
 * `file` (repo-relative); the list is stripped per file, so one file's entry
 * can never excuse another file. Two tests keep it honest:
 *  - staleness: the string must still exist in THAT file;
 *  - element kind: every occurrence must sit on an <img> (a raster logo with
 *    its own alt text, governed by 1.4.11 / 1.1.1 rather than 1.4.3).
 */
const ALLOWED_BARE_OPACITY: ReadonlyArray<{ file: string; classes: string; why: string }> = [
  {
    file: "src/components/story/cluster-card-image.tsx",
    classes: "max-h-[50%] max-w-[50%] object-contain opacity-60",
    why: "logo-tier <img> source badge, not text",
  },
];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (/\.tsx$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

const files = walk(SRC_DIR).sort();
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/** Source with every allow-listed icon class string removed. */
function withoutAllowedIcons(src: string): string {
  let out = src;
  for (const { classes } of ALLOWED_ICON_CLASSES) out = out.split(classes).join("");
  return out;
}

/** Repo-relative, forward-slash path of a scanned file. */
function repoPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

/** Source with the allow-listed bare-opacity class strings of THIS file removed. */
function withoutAllowedOpacity(file: string, src: string): string {
  let out = src;
  for (const entry of ALLOWED_BARE_OPACITY) {
    if (entry.file === repoPath(file)) out = out.split(entry.classes).join("");
  }
  return out;
}

/** `file:line  match` for every bare-opacity hit in one source file. */
function bareOpacityOffenders(file: string, src: string): string[] {
  const offenders: string[] = [];
  withoutAllowedOpacity(file, src)
    .split("\n")
    .forEach((line, i) => {
      for (const match of line.matchAll(BARE_OPACITY_GLOBAL)) {
        offenders.push(`${repoPath(file)}:${i + 1}  ${match[0]}`);
      }
    });
  return offenders;
}

/**
 * The opening-tag slice of the JSX element that contains `idx`: from the
 * nearest preceding `<` to the first `>` at or after `idx`. Class strings
 * never contain `<` or `>`, and the attributes we care about sit inside the
 * opening tag, so this is enough without a JSX parser.
 */
function elementSliceAt(src: string, idx: number): string {
  return src.slice(src.lastIndexOf("<", idx), src.indexOf(">", idx) + 1);
}

describe("text-contrast tokens (a11y-2)", () => {
  it("scans every non-test .tsx under src/", () => {
    expect(files).toContain(CLUSTER_PAGE);
    expect(files).toContain(join(ROOT, "src/components/story/cluster-card.tsx"));
    expect(files).toContain(join(ROOT, "src/components/story/bias-spectrum.tsx"));
    expect(files).toContain(join(ROOT, "src/app/metodoloji/page.tsx"));
    expect(files).toContain(join(ROOT, "src/components/filters/search-bar.tsx"));
    expect(files).toContain(join(ROOT, "src/app/source/[slug]/page.tsx"));
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
    expect(files.length).toBeGreaterThan(50);
  });

  it("uses no opacity-modified text-muted-foreground / text-brand token (/10 to /90)", () => {
    const offenders: string[] = [];
    for (const [file, src] of sources) {
      const lines = withoutAllowedIcons(src).split("\n");
      lines.forEach((line, i) => {
        for (const match of line.matchAll(LOW_CONTRAST_TEXT_GLOBAL)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}  ${match[0]}`);
        }
      });
    }
    expect(
      offenders,
      `Use the full token (text-muted-foreground / text-brand); opacity-modified text fails WCAG 1.4.3:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("flags the offending forms (the guard itself works)", () => {
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground/60")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground/70")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("text-brand/60")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("dark:text-muted-foreground/10")).toBe(true);
    // /80 and /90 also fail 4.5:1 (3.68 / 4.33 on the dark card).
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground/80")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground/90")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("text-brand/85")).toBe(true);
    // State-modifier forms are text colours too.
    expect(LOW_CONTRAST_TEXT.test("placeholder:text-muted-foreground/70")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("hover:text-brand/80")).toBe(true);
    expect(LOW_CONTRAST_TEXT.test("placeholder:text-muted-foreground")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("hover:decoration-solid")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground/100")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("text-brand")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("border-muted-foreground/50")).toBe(false);
  });

  describe("ALLOWED_ICON_CLASSES", () => {
    it.each(ALLOWED_ICON_CLASSES.map((e) => [e.why, e.file, e.classes] as const))(
      "still exists in its own file: %s",
      (_why, file, classes) => {
        const abs = join(ROOT, file);
        expect(files, `${file} is not a scanned src/**/*.tsx file`).toContain(abs);
        expect(
          sources.get(abs)?.includes(classes),
          `Allow-listed class string "${classes}" no longer appears in ${file}; remove it from ALLOWED_ICON_CLASSES.`,
        ).toBe(true);
      },
    );

    it.each(ALLOWED_ICON_CLASSES.map((e) => [e.why, e.file, e.classes] as const))(
      "is carried by an aria-hidden element: %s",
      (_why, file, classes) => {
        const src = sources.get(join(ROOT, file)) ?? "";
        const slices: string[] = [];
        for (let idx = src.indexOf(classes); idx !== -1; idx = src.indexOf(classes, idx + 1)) {
          slices.push(elementSliceAt(src, idx));
        }
        expect(slices.length, `"${classes}" not found in ${file}`).toBeGreaterThan(0);
        for (const slice of slices) {
          expect(
            slice,
            `Allow-listed icon in ${file} must be aria-hidden="true" (it is exempt from 1.4.3 only because it is decorative):\n${slice}`,
          ).toContain('aria-hidden="true"');
        }
      },
    );

    it("the aria-hidden check can fail (element slice helper)", () => {
      const hidden = '<Icon aria-hidden="true" className="h-5 w-5 text-muted-foreground/30" />';
      const bare = '<Icon className="h-5 w-5 text-muted-foreground/30" />';
      const split =
        '<Icon\n  aria-hidden="true"\n  className="h-5 w-5 text-muted-foreground/30"\n/>';
      const at = (src: string) => elementSliceAt(src, src.indexOf("h-5 w-5"));
      expect(at(hidden)).toContain('aria-hidden="true"');
      expect(at(split)).toContain('aria-hidden="true"');
      expect(at(bare)).not.toContain('aria-hidden="true"');
      // Must not borrow aria-hidden from a neighbouring element.
      const neighbour = `<A aria-hidden="true" />${bare}`;
      expect(at(neighbour)).not.toContain('aria-hidden="true"');
    });

    it("only excuses text-muted-foreground opacity on h-* w-* icon sizes", () => {
      for (const { classes } of ALLOWED_ICON_CLASSES) {
        expect(classes).toMatch(/^h-[\d.]+ w-[\d.]+ text-muted-foreground\/\d+$/);
      }
    });

    it("keeps every entry repo-relative to src/", () => {
      for (const { file } of ALLOWED_ICON_CLASSES) {
        expect(file).toMatch(/^src\/.+\.tsx$/);
      }
    });
  });
});

describe("no bare element opacity in story components (qa-wave-i, WCAG 1.4.3)", () => {
  const storyFiles = [...sources.keys()].filter((f) => f.startsWith(STORY_DIR + sep));

  it("scans the non-test .tsx files under src/components/story/ (media-dna included)", () => {
    expect(storyFiles).toContain(join(STORY_DIR, "media-dna.tsx"));
    expect(storyFiles).toContain(join(STORY_DIR, "cluster-card-image.tsx"));
    expect(storyFiles.some((f) => /\.test\./.test(f))).toBe(false);
    expect(storyFiles.length).toBeGreaterThan(10);
  });

  it("uses no opacity-5..opacity-99 / opacity-[x] class (fading text fails 1.4.3)", () => {
    const offenders = storyFiles.flatMap((f) => bareOpacityOffenders(f, sources.get(f) ?? ""));
    expect(
      offenders,
      `Do not fade story components with element opacity; use a dashed border, a transparent background or a full-strength token instead:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("lets the show / hide toggles and state-variant forms through with no allow-list entry", () => {
    // framing-comparison: opacity-0 + group-hover/entry:opacity-100.
    // correction-form: opacity-0 (honeypot) + disabled:opacity-50.
    for (const name of ["framing-comparison.tsx", "correction-form.tsx"]) {
      const file = join(STORY_DIR, name);
      expect(sources.has(file), `${name} is not a scanned file`).toBe(true);
      expect(sources.get(file)).toMatch(/\bopacity-0\b/);
      expect(bareOpacityOffenders(file, sources.get(file) ?? "")).toEqual([]);
      expect(ALLOWED_BARE_OPACITY.some((e) => e.file.endsWith(name))).toBe(false);
    }
  });

  it("flags the offending forms (the guard itself works)", () => {
    for (const bad of ["opacity-50", '"opacity-30"', " opacity-70", "opacity-5", "opacity-[0.6]"]) {
      expect(BARE_OPACITY.test(bad), bad).toBe(true);
    }
    for (const ok of [
      "opacity-0",
      "opacity-100",
      "disabled:opacity-50",
      "hover:opacity-80",
      "group-hover/entry:opacity-100",
      "peer-disabled:opacity-50",
      "transition-opacity",
    ]) {
      expect(BARE_OPACITY.test(ok), ok).toBe(false);
    }
  });

  it("reports offenders as file:line with the line of the hit", () => {
    const file = join(STORY_DIR, "fixture.tsx");
    const src = 'const a = "opacity-100";\nconst b = "rounded opacity-50";\n';
    expect(bareOpacityOffenders(file, src)).toEqual([
      "src/components/story/fixture.tsx:2  opacity-50",
    ]);
  });

  describe("ALLOWED_BARE_OPACITY", () => {
    it.each(ALLOWED_BARE_OPACITY.map((e) => [e.why, e.file, e.classes] as const))(
      "still exists in its own file: %s",
      (_why, file, classes) => {
        const abs = join(ROOT, file);
        expect(storyFiles, `${file} is not a scanned story .tsx file`).toContain(abs);
        expect(
          sources.get(abs)?.includes(classes),
          `Allow-listed class string "${classes}" no longer appears in ${file}; remove it from ALLOWED_BARE_OPACITY.`,
        ).toBe(true);
      },
    );

    it.each(ALLOWED_BARE_OPACITY.map((e) => [e.why, e.file, e.classes] as const))(
      "is carried by an <img> element: %s",
      (_why, file, classes) => {
        const src = sources.get(join(ROOT, file)) ?? "";
        const slices: string[] = [];
        for (let idx = src.indexOf(classes); idx !== -1; idx = src.indexOf(classes, idx + 1)) {
          slices.push(elementSliceAt(src, idx));
        }
        expect(slices.length, `"${classes}" not found in ${file}`).toBeGreaterThan(0);
        for (const slice of slices) {
          expect(
            slice.startsWith("<img"),
            `Allow-listed opacity in ${file} is only excused on a logo <img>, never on text:\n${slice}`,
          ).toBe(true);
        }
      },
    );

    it("the <img> check can fail (element slice helper)", () => {
      const img = '<img alt="x" className="object-contain opacity-60" />';
      const span = '<span className="object-contain opacity-60">x</span>';
      const at = (src: string) => elementSliceAt(src, src.indexOf("object-contain"));
      expect(at(img).startsWith("<img")).toBe(true);
      expect(at(span).startsWith("<img")).toBe(false);
    });

    it("strips an entry only from its own file", () => {
      const entry = ALLOWED_BARE_OPACITY[0]!;
      const own = join(ROOT, entry.file);
      const other = join(STORY_DIR, "media-dna.tsx");
      const src = `<img className="${entry.classes}" />`;
      expect(bareOpacityOffenders(own, src)).toEqual([]);
      expect(bareOpacityOffenders(other, src)).toHaveLength(1);
    });

    it("keeps every entry under src/components/story/", () => {
      for (const { file } of ALLOWED_BARE_OPACITY) {
        expect(file).toMatch(/^src\/components\/story\/.+\.tsx$/);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Fourth guard (wave V hygiene, dark-mode hue text): no `dark:text-<hue>-500`,
// `-600` or `-700` anywhere under src/ (.ts and .tsx, comments excluded).
//
// Why this exists, stated honestly: the repo had no contrast tooling, so this
// file now carries a small one (OKLCH -> sRGB -> WCAG relative luminance, with
// washes alpha-composited in gamma-encoded sRGB like the browser does). The
// numbers below were measured with it against tailwindcss 4.3.3 (theme.css)
// and the dark tokens of src/app/globals.css: card oklch(0.19 0.01 60),
// background oklch(0.14 0.008 60).
//
//   shade 500 text on     card   background   own bg-<hue>-500/15 wash
//   red                   4.84   5.21          4.21  (below 4.5)
//   rose                  4.92   5.30          4.30  (below 4.5)
//   blue                  4.92   5.30          4.19  (below 4.5)
//   indigo                4.04   4.35          3.51  (below 4.5 everywhere)
//   violet                4.20   4.52          3.64  (below 4.5 on card, wash)
//   purple                4.49   4.84          3.88  (below 4.5 on card, wash)
//   pink                  5.16   5.56          4.42  (wash below 4.5)
//   orange                6.39   6.89          5.23
//   emerald               7.50   8.08          6.03
//   amber                 8.62   9.28          6.64
//   yellow                9.66  10.41          7.26
//
// So -500 was never uniformly broken: amber, yellow and emerald (most of the
// 14 hits when this guard landed) cleared 4.5:1 with room to spare. What did
// fail was rose-500 on its own 15 % wash (4.30, the status-view "karantina"
// pill), and red/rose sit within 0.4 of the floor even on the plain card, so
// any change to the card tone or a smaller text size removes the margin.
// -600 / -700 are darker than -500 and only get worse on a dark surface. The
// ban is therefore about margin and the washes, applied to every hue so the
// rule is one line instead of a per-hue table. Shade 400 is the replacement:
// its worst case over all 17 hues is indigo at 5.93 (card), 6.38 (background)
// and 5.16 (wash); the test below asserts >= 4.5 for each hue and surface.
//
// Out of scope on purpose: light-theme classes (the light shades are governed
// by the site-wide tinted-text guard below), `dark:bg-*` fills, and 300 / 200 / 950
// (dark text on a solid bright fill, e.g. `dark:text-amber-950`).
// Large-text relief (3:1 for >= 24 px or >= 18.66 px bold) is not wired in:
// no offender needed it. Add an allow-list here only for a genuine case.
// ---------------------------------------------------------------------------

const DARK_LOW_SHADE =
  /(?<![\w-])dark:(?:[a-z0-9-]+:)*text-(red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-(500|600|700)(?:\/\d+)?(?![\w-])/g;

/** Non-test .ts and .tsx files under `dir` (the .tsx-only `walk` above misses .ts). */
function walkSource(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walkSource(full));
    else if (/\.tsx?$/.test(name) && !/\.test\./.test(name)) out.push(full);
  }
  return out;
}

/**
 * `src` with every `//` and block comment replaced by spaces (newlines kept so
 * line numbers survive). Quoted strings are tracked so a `//` inside
 * "https://..." does not blank the rest of the line; ' and " strings end at the
 * line break (a lone Turkish apostrophe in JSX text cannot swallow the file),
 * template literals span lines. Any slip here leaves a comment un-blanked
 * (a visible false positive), never hides real code.
 */
function blankComments(src: string): string {
  let out = "";
  let i = 0;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (quote !== null) {
      out += c;
      if (c === "\\" && next !== undefined) {
        out += next;
        i += 2;
        continue;
      }
      if (c === quote || (c === "\n" && quote !== "`")) quote = null;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      for (; i < src.length && src[i] !== "\n"; i++) out += " ";
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      for (; i < stop; i++) out += src[i] === "\n" ? "\n" : " ";
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    out += c;
    i++;
  }
  return out;
}

/** `file:line  match` for every banned dark hue text shade in one source file. */
function darkLowShadeOffenders(file: string, src: string): string[] {
  const offenders: string[] = [];
  blankComments(src)
    .split("\n")
    .forEach((line, i) => {
      for (const match of line.matchAll(DARK_LOW_SHADE)) {
        offenders.push(`${repoPath(file)}:${i + 1}  ${match[0]}`);
      }
    });
  return offenders;
}

/** True when the class string contains a banned shade (stateless: String.match resets lastIndex). */
const hasDarkLowShade = (classes: string): boolean => (classes.match(DARK_LOW_SHADE) ?? []).length > 0;

// --- contrast helper -------------------------------------------------------

/** Gamma-encoded sRGB, each channel 0..1. */
type Rgb = readonly [number, number, number];

const WHITE: Rgb = [1, 1, 1];
const BLACK: Rgb = [0, 0, 0];

const srgbEncode = (v: number): number => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const srgbDecode = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** `oklch(70.4% 0.191 22.216)` or `oklch(0.19 0.01 60)` -> gamma-encoded sRGB, gamut-clamped. */
function oklchToSrgb(value: string): Rgb {
  const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+|none)\s+([\d.]+|none)\s*\)/.exec(value);
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const L = Number(m[1]) / (m[2] === "%" ? 100 : 1);
  // CSS Color 4 `none` is a missing component, i.e. 0 (Tailwind's neutral is `oklch(55.6% 0 none)`).
  const C = m[3] === "none" ? 0 : Number(m[3]);
  const hue = ((m[4] === "none" ? 0 : Number(m[4])) * Math.PI) / 180;
  const a = C * Math.cos(hue);
  const b = C * Math.sin(hue);
  // OKLab -> LMS' -> LMS (cube) -> linear sRGB (Ottosson's reference matrices).
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * s,
  ].map((v) => srgbEncode(Math.min(1, Math.max(0, v))));
  return [linear[0]!, linear[1]!, linear[2]!];
}

/** WCAG 2.x relative luminance of a gamma-encoded sRGB colour. */
function relativeLuminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(srgbDecode) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio, 1..21, order-independent. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** `fg` at `alpha` over `bg`, composited in gamma-encoded sRGB (how browsers blend). */
function composite(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => alpha * fg[i]! + (1 - alpha) * bg[i]!) as unknown as Rgb;
}

const TAILWIND_THEME = readFileSync(join(ROOT, "node_modules/tailwindcss/theme.css"), "utf8");
const GLOBALS_CSS = readFileSync(join(SRC_DIR, "app/globals.css"), "utf8");

/** `--color-<hue>-<shade>` of the Tailwind default palette. */
function tailwindColor(hue: string, shade: number): Rgb {
  const m = new RegExp(`--color-${hue}-${shade}:\\s*(oklch\\([^)]*\\))`).exec(TAILWIND_THEME);
  if (!m) throw new Error(`--color-${hue}-${shade} not found in tailwindcss/theme.css`);
  return oklchToSrgb(m[1]!);
}

/** A custom property from the `.dark { ... }` block of globals.css. */
function darkToken(name: string): Rgb {
  const block = /^\.dark\s*\{([^}]*)\}/m.exec(GLOBALS_CSS);
  if (!block) throw new Error(".dark block not found in src/app/globals.css");
  const m = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(block[1]!);
  if (!m) throw new Error(`--${name} not found in the .dark block`);
  return oklchToSrgb(m[1]!);
}

/** The hue alternation of DARK_LOW_SHADE, so the contrast test cannot drift from the regex. */
const BANNED_HUES = /text-\(([a-z|]+)\)-\(500/.exec(DARK_LOW_SHADE.source)![1]!.split("|");

describe("dark-mode hue text shades (WCAG 1.4.3, wave V)", () => {
  const sourceFiles = walkSource(SRC_DIR).sort();

  it("scans every non-test .ts and .tsx under src/ (not vacuous)", () => {
    const rel = sourceFiles.map(repoPath);
    expect(rel).toContain("src/app/page.tsx");
    expect(rel).toContain("src/components/status/status-view.tsx");
    expect(rel.some((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))).toBe(true);
    expect(rel).toContain("src/lib/supabase/server.ts");
    expect(rel.some((f) => /\.test\./.test(f))).toBe(false);
    expect(sourceFiles.length).toBeGreaterThan(200);
  });

  it("uses no dark:text-<hue>-500/600/700 (dark mode wants shade 400 or lighter)", () => {
    const offenders = sourceFiles.flatMap((f) => darkLowShadeOffenders(f, readFileSync(f, "utf8")));
    expect(
      offenders,
      `Use dark:text-<hue>-400 (or 300): -500..-700 text loses its margin on the dark card and falls below 4.5:1 on a bg-<hue>-500/15 wash (WCAG 1.4.3):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("flags the offending forms (the guard itself works)", () => {
    for (const bad of [
      "dark:text-red-500",
      "dark:text-yellow-500/70",
      "dark:hover:text-rose-600",
      "dark:group-hover:text-amber-700",
      "text-red-600 dark:text-red-500 font-medium",
      "md:dark:text-sky-600",
      'className="x dark:text-emerald-500"',
    ]) {
      expect(hasDarkLowShade(bad), bad).toBe(true);
    }
  });

  it("passes the AA-safe and out-of-scope forms", () => {
    for (const ok of [
      "dark:text-red-400",
      "dark:text-amber-300",
      "dark:text-yellow-400",
      "dark:hover:text-yellow-300",
      "text-red-500",
      "text-red-600 dark:text-red-400",
      "dark:bg-red-500",
      "dark:bg-red-500/15",
      "dark:border-red-500",
      "dark:text-muted-foreground",
      "dark:text-amber-950",
      "dark:text-red-5000",
      "xdark:text-red-500",
    ]) {
      expect(hasDarkLowShade(ok), ok).toBe(false);
    }
  });

  it("reports offenders as file:line with the line of the hit", () => {
    const file = join(SRC_DIR, "fixture.tsx");
    const src = 'const a = "dark:text-red-400";\nconst b = "x dark:text-rose-600";\n';
    expect(darkLowShadeOffenders(file, src)).toEqual(["src/fixture.tsx:2  dark:text-rose-600"]);
  });

  it("ignores // and block comments but keeps strings that contain //", () => {
    const file = join(SRC_DIR, "fixture.ts");
    const src = [
      "// dark:text-red-500 in a line comment",
      "/* dark:text-red-500",
      "   still the block comment */",
      'const a = "https://x.test dark:text-amber-500";',
      'const b = "dark:text-rose-600"; // dark:text-blue-500',
      "const c = `dark:text-sky-700 ${x}`; /* dark:text-lime-500 */",
      "const d = \"Tayf'ın\"; // dark:text-teal-500",
      "const e = 1; // it's a comment with an apostrophe",
      'const f = "dark:text-pink-500";',
    ].join("\n");
    expect(darkLowShadeOffenders(file, src)).toEqual([
      "src/fixture.ts:4  dark:text-amber-500",
      "src/fixture.ts:5  dark:text-rose-600",
      "src/fixture.ts:6  dark:text-sky-700",
      "src/fixture.ts:9  dark:text-pink-500",
    ]);
  });

  it("keeps line numbers aligned after a multi-line block comment", () => {
    const file = join(SRC_DIR, "fixture.tsx");
    const src = "/*\n a\n b\n*/\nconst a = 'dark:text-red-500';\n";
    expect(darkLowShadeOffenders(file, src)).toEqual(["src/fixture.tsx:5  dark:text-red-500"]);
  });

  describe("measured contrast helper", () => {
    it("white on black is 21 and equal colours are 1", () => {
      expect(contrastRatio(WHITE, BLACK)).toBeCloseTo(21, 6);
      expect(contrastRatio(BLACK, WHITE)).toBeCloseTo(21, 6);
      expect(contrastRatio(WHITE, WHITE)).toBeCloseTo(1, 6);
      const grey: Rgb = [0.4, 0.4, 0.4];
      expect(contrastRatio(grey, grey)).toBeCloseTo(1, 6);
    });

    it("matches published reference ratios (#767676 passes on white, #777777 does not)", () => {
      const hex = (v: number): Rgb => [v / 255, v / 255, v / 255];
      expect(contrastRatio(hex(0x76), WHITE)).toBeCloseTo(4.54, 2);
      expect(contrastRatio(hex(0x77), WHITE)).toBeCloseTo(4.48, 2);
    });

    it("converts OKLCH to sRGB (white, black, and pure red)", () => {
      expect(oklchToSrgb("oklch(100% 0 0)")).toEqual([expect.closeTo(1, 3), expect.closeTo(1, 3), expect.closeTo(1, 3)]);
      expect(oklchToSrgb("oklch(0 0 0)")).toEqual([expect.closeTo(0, 3), expect.closeTo(0, 3), expect.closeTo(0, 3)]);
      // sRGB #ff0000 expressed in OKLCH.
      const red = oklchToSrgb("oklch(62.796% 0.25768 29.234)");
      expect(red[0]).toBeCloseTo(1, 2);
      expect(red[1]).toBeCloseTo(0, 2);
      expect(red[2]).toBeCloseTo(0, 2);
    });

    it("reads both the percent and the fractional lightness forms", () => {
      expect(oklchToSrgb("oklch(50% 0.1 120)")).toEqual(oklchToSrgb("oklch(0.5 0.1 120)"));
      expect(() => oklchToSrgb("#fff")).toThrow();
    });

    it("composites in gamma space and clamps out-of-gamut values", () => {
      expect(composite(WHITE, BLACK, 0.5)).toEqual([0.5, 0.5, 0.5]);
      expect(composite(WHITE, BLACK, 0)).toEqual(BLACK);
      expect(composite(WHITE, BLACK, 1)).toEqual(WHITE);
      for (const channel of oklchToSrgb("oklch(70% 0.4 150)")) {
        expect(channel).toBeGreaterThanOrEqual(0);
        expect(channel).toBeLessThanOrEqual(1);
      }
    });

    it("reads the dark card and background from globals.css", () => {
      // card oklch(0.19 0.01 60) is lighter than background oklch(0.14 0.008 60), both near-black.
      expect(relativeLuminance(darkToken("card"))).toBeGreaterThan(relativeLuminance(darkToken("background")));
      expect(relativeLuminance(darkToken("card"))).toBeLessThan(0.02);
      expect(contrastRatio(darkToken("card"), BLACK)).toBeLessThan(1.5);
      expect(() => darkToken("no-such-token")).toThrow();
      expect(() => tailwindColor("red", 12345)).toThrow();
    });
  });

  describe("shade 400 (the replacement) clears 4.5:1 for every banned hue", () => {
    it("covers the 17 hues of the regex", () => {
      expect(BANNED_HUES).toHaveLength(17);
      expect(BANNED_HUES).toContain("rose");
      expect(BANNED_HUES).toContain("indigo");
    });

    it.each(BANNED_HUES)("%s-400 on the dark card, the dark background and its own 15 %% wash", (hue) => {
      const text = tailwindColor(hue, 400);
      const card = darkToken("card");
      const background = darkToken("background");
      const wash = composite(tailwindColor(hue, 500), card, 0.15);
      const onCard = contrastRatio(text, card);
      const onBackground = contrastRatio(text, background);
      const onWash = contrastRatio(text, wash);
      expect(onCard, `${hue}-400 on card ${onCard.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(onBackground, `${hue}-400 on background ${onBackground.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
      expect(onWash, `${hue}-400 on bg-${hue}-500/15 ${onWash.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    });
  });
});

// ---------------------------------------------------------------------------
// Fifth guard (wave W, Medya DNA empty-zone label): "Hiç kaynak yok" sits on
// the zone card, a `bg-<hue>-<shade>/<pct>` wash (ZONE_META.zoneBg) over the
// page card. It used to be 11 px italic `text-muted-foreground`, which does not
// reach 4.5:1 on the bagimsiz (zinc, /20) tile in dark mode. It is now
// `text-foreground/80`: the opacity ban above covers muted-foreground and
// brand only, because foreground is far brighter, and this block measures
// that claim for every zone, on the card AND on the page background (the
// component is also rendered on the background), in both themes.
// ---------------------------------------------------------------------------

/** A custom property from the light `:root { ... }` block of globals.css. */
function lightToken(name: string): Rgb {
  const block = /^:root\s*\{([^}]*)\}/m.exec(GLOBALS_CSS);
  if (!block) throw new Error(":root block not found in src/app/globals.css");
  const m = new RegExp(`--${name}:\\s*(oklch\\([^)]*\\))`).exec(block[1]!);
  if (!m) throw new Error(`--${name} not found in the :root block`);
  return oklchToSrgb(m[1]!);
}

/** `bg-<hue>-<shade>/<pct>` -> its parts. */
function parseZoneBg(zoneBg: string): { hue: string; shade: number; alpha: number } {
  const m = /^bg-([a-z]+)-(\d+)\/(\d+)$/.exec(zoneBg);
  if (!m) throw new Error(`zoneBg is not bg-<hue>-<shade>/<pct>: ${zoneBg}`);
  return { hue: m[1]!, shade: Number(m[2]), alpha: Number(m[3]) / 100 };
}

describe("Medya DNA empty label (WCAG 1.4.3, wave W)", () => {
  const mediaDnaSource = readFileSync(join(STORY_DIR, "media-dna.tsx"), "utf8");
  const zones = Object.entries(ZONE_META) as Array<[string, (typeof ZONE_META)[keyof typeof ZONE_META]]>;
  const themes = [
    { theme: "dark", token: darkToken },
    { theme: "light", token: lightToken },
  ] as const;

  it("covers all three zones, each with a parseable bg-<hue>-<shade>/<pct> tint", () => {
    expect(zones.map(([zone]) => zone).sort()).toEqual(["bagimsiz", "iktidar", "muhalefet"]);
    for (const [, meta] of zones) {
      const { alpha } = parseZoneBg(meta.zoneBg);
      expect(alpha).toBeGreaterThan(0);
      expect(alpha).toBeLessThan(1);
    }
  });

  it("parses zoneBg and rejects anything else", () => {
    expect(parseZoneBg("bg-zinc-500/20")).toEqual({ hue: "zinc", shade: 500, alpha: 0.2 });
    expect(() => parseZoneBg("bg-zinc-500")).toThrow();
    expect(() => parseZoneBg("bg-[#fff]/20")).toThrow();
    expect(() => lightToken("no-such-token")).toThrow();
  });

  for (const { theme, token } of themes) {
    for (const surface of ["card", "background"] as const) {
      it.each(zones)(
        `text-foreground/80 clears 4.5:1 on the %s zone tile over the ${theme} ${surface}`,
        (_zone, meta) => {
          const { hue, shade, alpha } = parseZoneBg(meta.zoneBg);
          const tile = composite(tailwindColor(hue, shade), token(surface), alpha);
          const text = composite(token("foreground"), tile, 0.8);
          const ratio = contrastRatio(text, tile);
          expect(
            ratio,
            `${meta.zoneBg} tile over ${theme} ${surface}: foreground/80 is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        },
      );
    }
  }

  it("shows why the old pairing was replaced: muted-foreground misses 4.5:1 on a zone tile", () => {
    const failing = zones.filter(([, meta]) => {
      const { hue, shade, alpha } = parseZoneBg(meta.zoneBg);
      return ["card", "background"].some((surface) => {
        const tile = composite(tailwindColor(hue, shade), darkToken(surface), alpha);
        return contrastRatio(darkToken("muted-foreground"), tile) < 4.5;
      });
    });
    expect(failing.length).toBeGreaterThan(0);
  });

  it("media-dna.tsx no longer pairs text-muted-foreground with italic", () => {
    expect(mediaDnaSource).not.toContain("text-muted-foreground italic");
    expect(mediaDnaSource).toContain("text-foreground/80 italic");
  });
});

// ---------------------------------------------------------------------------
// Sixth guard (wave X, site-wide tinted text): any class string that carries a
// bare `bg-<hue>-<shade>/<pct>` tint of 20 % or less AND a palette text colour
// (`text-<hue>-<shade>`, `dark:text-<hue>-<shade>`) must read at 4.5:1 or
// better on the composited wash, in both themes, over the card and the page
// background. It replaces the hand-kept TINTED_PILL_FILES list: every non-test
// .ts and .tsx under src/ is scanned, so a new pill cannot ship with
// `text-amber-700` on `bg-amber-500/15` (4.42:1 on the light card).
//
// Light mode additionally needs shade 800 or darker: the 700 shades sit within
// a hair of the floor on a 15 % wash, so the rule is a one-liner that keeps
// its margin instead of a per-hue table. Dark mode is measured only: the
// effective dark colour is the `dark:text-*` shade when there is one, else the
// bare `text-*` shade (the html element is forced dark in production).
//
// Scope and honest limits:
//  - Only bare classes count. `hover:bg-red-500/20`, `dark:bg-*` and
//    `md:text-*` are variants and are skipped (a state tint is not at rest).
//  - A tint and its text must sit in the SAME class string. Both branches of a
//    ternary inside `${...}` are separate strings, so they are never paired
//    with each other. Runtime-composed tokens (BIAS_COLORS, ZONE_META) are
//    covered by their own test below because the literal scan cannot see them.
//  - Text on a tinted PARENT (a child element with its own class string) is
//    invisible here; those call sites were fixed by hand in wave X.
// ---------------------------------------------------------------------------

/** Tints at or below this opacity count as washes the guard measures against. */
const MAX_TINT_PERCENT = 20;

const TINT = /(?<![\w:/-])bg-([a-z]+)-(\d{2,3})\/(\d{1,3})(?![\w-])/g;
const LIGHT_TEXT = /(?<![\w:/-])text-([a-z]+)-(\d{2,3})(?![\w/-])/g;
const DARK_TEXT = /(?<![\w-])dark:text-([a-z]+)-(\d{2,3})(?![\w/-])/g;

const paletteCache = new Map<string, Rgb | null>();

/** `--color-<hue>-<shade>` of the Tailwind palette, or null when there is no such colour. */
function paletteColor(hue: string, shade: number): Rgb | null {
  const key = `${hue}-${shade}`;
  if (!paletteCache.has(key)) {
    try {
      paletteCache.set(key, tailwindColor(hue, shade));
    } catch (error) {
      // text-2xl, text-muted-foreground etc. are not palette colours; but a colour
      // that exists and cannot be parsed must fail loudly, not vanish from the scan.
      if (!(error instanceof Error) || !error.message.includes("not found in tailwindcss/theme.css")) throw error;
      paletteCache.set(key, null);
    }
  }
  return paletteCache.get(key) ?? null;
}

interface PaletteText {
  hue: string;
  shade: number;
  rgb: Rgb;
}

interface PaletteTint extends PaletteText {
  percent: number;
}

/** Every palette colour matched by `pattern` (group 1 = hue, group 2 = shade). */
function paletteTexts(classes: string, pattern: RegExp): PaletteText[] {
  const out: PaletteText[] = [];
  for (const m of classes.matchAll(pattern)) {
    const shade = Number(m[2]);
    const rgb = paletteColor(m[1]!, shade);
    if (rgb) out.push({ hue: m[1]!, shade, rgb });
  }
  return out;
}

/** The washes of `classes` that the guard measures (bare, palette, <= 20 %). */
function paletteTints(classes: string): PaletteTint[] {
  const out: PaletteTint[] = [];
  for (const m of classes.matchAll(TINT)) {
    const percent = Number(m[3]);
    const shade = Number(m[2]);
    const rgb = paletteColor(m[1]!, shade);
    if (rgb && percent <= MAX_TINT_PERCENT) out.push({ hue: m[1]!, shade, rgb, percent });
  }
  return out;
}

/** True when the class string has a measured wash AND at least one palette text colour. */
function isTintedPaletteText(classes: string): boolean {
  return (
    paletteTints(classes).length > 0 &&
    (paletteTexts(classes, LIGHT_TEXT).length > 0 || paletteTexts(classes, DARK_TEXT).length > 0)
  );
}

const SURFACES = ["card", "background"] as const;

/**
 * Why a class string fails AA on its own tint, or [] when it passes (or has no
 * measured tint / no palette text). One message per failing text colour,
 * wash, theme and surface; each names the hue, theme, surface and ratio.
 */
function tintedTextProblems(classes: string): string[] {
  const tints = paletteTints(classes);
  const lightTexts = paletteTexts(classes, LIGHT_TEXT);
  const darkTexts = paletteTexts(classes, DARK_TEXT);
  if (tints.length === 0 || (lightTexts.length === 0 && darkTexts.length === 0)) return [];

  const effectiveDark = darkTexts.length > 0 ? darkTexts : lightTexts;
  const problems = new Set<string>();

  for (const tint of tints) {
    const wash = `bg-${tint.hue}-${tint.shade}/${tint.percent}`;
    for (const surface of SURFACES) {
      for (const [theme, texts, token] of [
        ["light", lightTexts, lightToken],
        ["dark", effectiveDark, darkToken],
      ] as const) {
        const tile = composite(tint.rgb, token(surface), tint.percent / 100);
        for (const text of texts) {
          const ratio = contrastRatio(text.rgb, tile);
          const tooLight = theme === "light" && text.shade < 800;
          if (!tooLight && ratio >= 4.5) continue;
          const name = `${theme === "dark" && darkTexts.length > 0 ? "dark:" : ""}text-${text.hue}-${text.shade}`;
          problems.add(
            `${name} on ${wash} (${text.hue} text, ${theme} ${surface}) is ${ratio.toFixed(2)}:1` +
              (tooLight ? "; light text on a tint needs shade 800 or darker" : "; needs 4.5:1"),
          );
        }
      }
    }
  }
  return [...problems];
}

/**
 * Class-string candidates of one source file:
 *  (i)  every double-quoted string, including ones nested in a template's
 *       `${...}` (a ternary's two branches stay two separate strings);
 *  (ii) the static text of every template literal with each `${...}` removed
 *       by a brace-depth counter.
 * Comments are blanked first. Single quotes are skipped on purpose: Turkish
 * apostrophes in JSX text would mis-pair, and class strings in this codebase
 * are never single-quoted.
 */
function classStrings(src: string): string[] {
  const code = blankComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/"([^"\n]*)"/g)) out.push(m[1]!);

  /** Index after a ' or " string that opens at `start` (ends at its quote or the line break). */
  const skipQuoted = (start: number): number => {
    const quote = code[start]!;
    let j = start + 1;
    while (j < code.length && code[j] !== quote && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
    return j + 1;
  };

  /** Static text of the template that opens just before `start`; returns the index after its closing backtick. */
  const readTemplate = (start: number): number => {
    let text = "";
    let i = start;
    while (i < code.length) {
      const c = code[i]!;
      if (c === "\\") {
        i += 2;
      } else if (c === "`") {
        out.push(text);
        return i + 1;
      } else if (c === "$" && code[i + 1] === "{") {
        i = skipExpression(i + 2);
      } else {
        text += c;
        i++;
      }
    }
    out.push(text);
    return i;
  };

  /** Index after the `}` that closes a `${` whose body starts at `start`. */
  const skipExpression = (start: number): number => {
    let depth = 1;
    let i = start;
    while (i < code.length) {
      const c = code[i]!;
      if (c === "`") i = readTemplate(i + 1);
      else if (c === '"' || c === "'") i = skipQuoted(i);
      else {
        if (c === "{") depth++;
        else if (c === "}" && --depth === 0) return i + 1;
        i++;
      }
    }
    return i;
  };

  let i = 0;
  while (i < code.length) {
    const c = code[i]!;
    if (c === "`") i = readTemplate(i + 1);
    else if (c === '"' || c === "'") i = skipQuoted(i);
    else i++;
  }
  return out;
}

/**
 * Large-text relief (WCAG 1.4.3 asks 3:1 for >= 24 px, or >= 18.66 px bold) is
 * NOT wired in for ordinary pills: no offender needed it. An entry here is the
 * exact class string as written in `file` (repo-relative, any non-test .ts or
 * .tsx under src/) and may only excuse genuinely large text (see
 * isLargeTextClasses). It is removed for its own file only. Add an entry for a
 * real case, never to silence a small label.
 */
const ALLOWED_LARGE_TINTED_TEXT: ReadonlyArray<{ file: string; classes: string; why: string }> = [];

/** text-2xl .. text-9xl, or text-xl together with a bold-or-heavier weight. */
const isLargeTextClasses = (classes: string): boolean =>
  /\btext-(?:2xl|[3-9]xl)\b/.test(classes) ||
  (/\btext-xl\b/.test(classes) && /\bfont-(?:bold|extrabold|black)\b/.test(classes));

describe("site-wide tinted text keeps AA contrast (WCAG 1.4.3, wave X)", () => {
  const sourceFiles = walkSource(SRC_DIR).sort();
  const tintedStrings = sourceFiles.flatMap((file) =>
    classStrings(readFileSync(file, "utf8"))
      .filter(isTintedPaletteText)
      .map((classes) => ({ file: repoPath(file), classes })),
  );

  it("finds the tinted strings with palette text across src/ (not vacuous)", () => {
    expect(tintedStrings.length).toBeGreaterThanOrEqual(15);
    for (const file of [
      "src/components/story/cluster-card.tsx",
      "src/components/status/status-view.tsx",
      "src/components/follow/follow-feed.tsx",
      "src/app/kaynaklar/durum/page.tsx",
    ]) {
      expect(
        tintedStrings.filter((s) => s.file === file).length,
        `${file} has no tinted string with palette text; the extractor lost it`,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("every tinted string clears 4.5:1 in both themes on the card and the background", () => {
    const allowed = ALLOWED_LARGE_TINTED_TEXT;
    const offenders = tintedStrings.flatMap(({ file, classes }) => {
      if (allowed.some((e) => e.file === file && e.classes === classes)) return [];
      const problems = tintedTextProblems(classes);
      return problems.length > 0 ? [`${file}  "${classes}"  ${problems.join("; ")}`] : [];
    });
    expect(
      offenders,
      `Text on a bg-<hue>-<shade>/<=20 tint needs text-<hue>-800 (or darker) in light mode and 4.5:1 in dark mode (WCAG 1.4.3):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  describe("the guard works", () => {
    it("flags 700 on a 15 % wash in light mode", () => {
      const problems = tintedTextProblems("bg-amber-500/15 text-amber-700 dark:text-amber-400");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.includes("light"))).toBe(true);
      // 4.49:1 on the light card, 4.33:1 on the light background: both below the floor.
      for (const problem of problems) {
        const ratio = Number(/(\d+\.\d\d):1/.exec(problem)![1]);
        expect(ratio, problem).toBeGreaterThan(4);
        expect(ratio, problem).toBeLessThan(4.5);
      }
    });

    it("flags a text shade lighter than 800 even when it measures above 4.5:1", () => {
      const problems = tintedTextProblems("bg-red-500/10 text-red-400");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.includes("light"))).toBe(true);
      expect(problems.join(" ")).toContain("shade 800");
    });

    it("flags a dark shade on a bare tint in dark mode", () => {
      const problems = tintedTextProblems("bg-emerald-500/10 text-emerald-900");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.includes("dark"))).toBe(true);
      expect(problems.join(" ")).toMatch(/\d\.\d\d:1/);
    });

    it("names hue, theme, surface and ratio in every message", () => {
      for (const problem of tintedTextProblems("bg-rose-500/15 text-rose-600 dark:text-rose-600")) {
        expect(problem).toMatch(/rose/);
        expect(problem).toMatch(/light|dark/);
        expect(problem).toMatch(/card|background/);
        expect(problem).toMatch(/\d+\.\d\d:1/);
      }
    });

    it("accepts the AA-safe pair", () => {
      expect(tintedTextProblems("bg-rose-500/15 text-rose-800 dark:text-rose-300")).toEqual([]);
      expect(tintedTextProblems("bg-amber-500/15 border-amber-500/30 text-amber-800 dark:text-amber-400")).toEqual([]);
    });

    it("lets variant tints, heavy washes, solids and plain tokens through", () => {
      for (const ok of [
        "hover:bg-red-500/20 text-red-700",
        "dark:bg-red-500/15 text-red-700",
        "bg-rose-500/25 text-rose-700",
        "bg-rose-500 text-white",
        "text-rose-700",
        "bg-muted text-muted-foreground",
        "bg-primary/10 text-primary text-2xl",
      ]) {
        expect(tintedTextProblems(ok), ok).toEqual([]);
        expect(isTintedPaletteText(ok), ok).toBe(false);
      }
    });

    it("ignores variant text colours when deciding the light shade", () => {
      // hover:/md: text is not the resting colour; only the bare text-* counts.
      expect(tintedTextProblems("bg-amber-500/15 text-amber-800 hover:text-amber-600 dark:text-amber-400")).toEqual([]);
    });

    it("measures the dark colour from the bare text when there is no dark: text", () => {
      // amber-800 on the dark amber wash is far below 4.5:1.
      const problems = tintedTextProblems("bg-amber-500/15 text-amber-800");
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.every((p) => p.includes("dark"))).toBe(true);
    });

    it("measures every tint of a string, not just the first", () => {
      const problems = tintedTextProblems("bg-zinc-500/5 bg-amber-500/15 text-amber-700 dark:text-amber-400");
      expect(problems.some((p) => p.includes("bg-amber-500/15"))).toBe(true);
    });
  });

  describe("shade 800 (the replacement) clears 4.5:1 on its own -500/20 wash", () => {
    const hues = [...BANNED_HUES, "zinc", "slate", "gray", "neutral", "stone"];

    it("covers the 17 banned hues plus the five neutrals", () => {
      expect(hues).toHaveLength(22);
      expect(new Set(hues).size).toBe(22);
    });

    it.each(hues)("%s-800 over the light card and the light background", (hue) => {
      const wash = tailwindColor(hue, 500);
      for (const surface of SURFACES) {
        const tile = composite(wash, lightToken(surface), 0.2);
        const ratio = contrastRatio(tailwindColor(hue, 800), tile);
        expect(ratio, `${hue}-800 on bg-${hue}-500/20 over the light ${surface}: ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
      }
    });
  });

  describe("palette reader", () => {
    it("reads achromatic entries whose hue is `none` (neutral) and rejects non-palette names", () => {
      expect(oklchToSrgb("oklch(55.6% 0 none)")).toEqual(oklchToSrgb("oklch(55.6% 0 0)"));
      expect(paletteColor("neutral", 800)).not.toBeNull();
      expect(paletteColor("muted", 500)).toBeNull();
      expect(paletteColor("red", 12345)).toBeNull();
      expect(isTintedPaletteText("bg-neutral-500/15 text-neutral-700")).toBe(true);
    });
  });

  describe("classStrings (extractor)", () => {
    it("yields a nested string and the static text of a template, ternary branches apart", () => {
      const src = 'const c = `a ${x ? "bg-sky-500/15 text-sky-800" : "y"} b`;';
      const found = classStrings(src);
      expect(found).toContain("bg-sky-500/15 text-sky-800");
      expect(found).toContain("y");
      expect(found).toContain("a  b");
      // the two branches are never merged into one candidate
      const branches = classStrings('const c = `${x ? "bg-sky-500/15" : "text-amber-700"}`;');
      expect(branches).toContain("bg-sky-500/15");
      expect(branches).toContain("text-amber-700");
      expect(branches.some((s) => s.includes("bg-sky-500/15") && s.includes("text-amber-700"))).toBe(false);
    });

    it("handles braces, nested templates and strings inside ${...}", () => {
      const src = "const c = `p ${fn({ a: 1 })} q ${y ? `bg-sky-500/15 ${z}` : \"}\"} r`;";
      const found = classStrings(src);
      expect(found).toContain("p  q  r");
      expect(found).toContain("bg-sky-500/15 ");
    });

    it("ignores line and block comments and skips single-quoted text", () => {
      const src = [
        '// "bg-red-500/10 text-red-700" in a line comment',
        '/* "bg-red-500/10 text-red-700" in a block comment */',
        "const a = 'bg-red-500/10 text-red-700';",
        'const b = "bg-sky-500/15 text-sky-800"; // trailing "comment"',
      ].join("\n");
      expect(classStrings(src)).toEqual(["bg-sky-500/15 text-sky-800"]);
    });

    it("does not pair strings across lines", () => {
      expect(classStrings('const a = "open\nconst b = "bg-sky-500/15 text-sky-800";')).toContain(
        "bg-sky-500/15 text-sky-800",
      );
    });
  });

  describe("runtime-composed tokens (invisible to the literal scan)", () => {
    it("covers all ten BIAS_COLORS", () => {
      expect(Object.keys(BIAS_COLORS)).toHaveLength(10);
    });

    it.each(Object.entries(BIAS_COLORS))("BIAS_COLORS.%s chipBg + chipText", (_category, color) => {
      const classes = `${color.chipBg} ${color.chipText}`;
      expect(isTintedPaletteText(classes), classes).toBe(true);
      expect(tintedTextProblems(classes), classes).toEqual([]);
    });

    it.each(Object.entries(ZONE_META))("ZONE_META.%s chip and zone label", (_zone, meta) => {
      for (const classes of [`${meta.chipBg} ${meta.chipText}`, `${meta.zoneBg} ${meta.zoneLabel}`]) {
        expect(isTintedPaletteText(classes), classes).toBe(true);
        expect(tintedTextProblems(classes), classes).toEqual([]);
      }
    });
  });

  describe("text on a tinted parent (child class strings the literal scan cannot pair)", () => {
    // The tint sits on a parent element and the text on a child, in separate class
    // strings. Pinned by hand: the pair must measure AA and the child's class
    // string must still be in its file.
    const PARENT_TINT_CHILDREN: ReadonlyArray<{ file: string; tint: string; text: string }> = [
      { file: "src/components/story/fact-check-box.tsx", tint: "bg-sky-500/5", text: "text-sky-800 dark:text-sky-400" },
      { file: "src/components/story/cross-spectrum-caption.tsx", tint: "bg-yellow-500/10", text: "text-yellow-800 dark:text-yellow-400" },
      { file: "src/components/source/label-card.tsx", tint: "bg-amber-500/10", text: "text-amber-800 dark:text-amber-400" },
      { file: "src/components/admin/api-keys-actions.tsx", tint: "bg-amber-500/10", text: "text-amber-800 dark:text-amber-400" },
      { file: "src/components/admin/api-webhooks-actions.tsx", tint: "bg-amber-500/10", text: "text-amber-800 dark:text-amber-400" },
    ];

    it.each(PARENT_TINT_CHILDREN.map((e) => [e.file, e] as const))("%s", (_file, { file, tint, text }) => {
      expect(isTintedPaletteText(`${tint} ${text}`)).toBe(true);
      expect(tintedTextProblems(`${tint} ${text}`)).toEqual([]);
      const src = readFileSync(join(ROOT, file), "utf8");
      expect(src, `${file} lost its parent tint ${tint}`).toContain(tint);
      expect(src, `${file} lost the AA child text "${text}"`).toContain(text);
    });
  });

  describe("ALLOWED_LARGE_TINTED_TEXT", () => {
    it("only lists large text that still exists in its own file", () => {
      for (const { file, classes, why } of ALLOWED_LARGE_TINTED_TEXT) {
        expect(isLargeTextClasses(classes), `${why}: "${classes}" is not large text (text-2xl+ or text-xl with bold)`).toBe(true);
        expect(file, `${why}: entry file must be repo-relative under src/`).toMatch(/^src\/.+\.tsx?$/);
        const abs = join(ROOT, file);
        expect(sourceFiles, `${file} is not a scanned src/**/*.ts(x) file`).toContain(abs);
        expect(
          readFileSync(abs, "utf8").includes(classes),
          `Allow-listed string "${classes}" no longer appears in ${file}; remove it from ALLOWED_LARGE_TINTED_TEXT.`,
        ).toBe(true);
      }
    });

    it("recognises large text and refuses ordinary labels", () => {
      for (const large of ["text-2xl", "text-9xl font-medium", "text-xl font-bold", "text-xl font-black"]) {
        expect(isLargeTextClasses(large), large).toBe(true);
      }
      for (const small of ["text-xl", "text-xl font-semibold", "text-lg font-bold", "text-[11px] font-bold", "text-xs"]) {
        expect(isLargeTextClasses(small), small).toBe(false);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Seventh guard (h10-a11y-3, WCAG 1.4.11 form-control boundary): the border of
// a text field, select or outline button is a user-interface component
// boundary and needs 3:1 against the surface it sits on. `--input` was
// oklch(1 0 0 / 12%) in dark mode (about 1.4:1 on the dark card) and
// oklch(0.90 0.008 80) in light mode (about 1.3:1 on the white card): both
// failed, so the correction and newsletter fields were nearly invisible.
//
// TRAP, and why there are two tokens now: `--input` is ALSO the FILL token
// (`dark:bg-input/30`, `dark:hover:bg-input/50`, `dark:disabled:bg-input/80`,
// `disabled:bg-input/50`) and the outline button's `dark:border-input`.
// Raising `--input` alone would lighten every fill and drop the dark
// `placeholder:text-muted-foreground` (oklch(0.62 0.01 70)) below 4.5:1 on the
// field fill (4.7 today). So `--input-subtle` keeps the OLD values and is what
// every fill, plus the outline-button border, uses (pixel-identical to
// before); `--input` is the 3:1 border and nothing else. The tests below pin
// all of that: the border ratio, the frozen subtle values, the Tailwind
// utility, the absence of any `bg-input` fill under src/, and the placeholder
// margin on the unchanged fill.
// ---------------------------------------------------------------------------

type Theme = "light" | "dark";

/**
 * Raw value of `--name` in the `:root` (light) or `.dark` block of `css`.
 * The lookbehind keeps `--input` from matching inside `--input-subtle` (the
 * trailing colon already does) or `--color-input`; the value runs to the `;`.
 */
function rawToken(css: string, theme: Theme, name: string): string {
  const block = (theme === "dark" ? /^\.dark\s*\{([^}]*)\}/m : /^:root\s*\{([^}]*)\}/m).exec(css);
  if (!block) throw new Error(`${theme === "dark" ? ".dark" : ":root"} block not found in src/app/globals.css`);
  const m = new RegExp(`(?<![\\w-])--${name}:\\s*([^;]+);`).exec(block[1]!);
  if (!m) throw new Error(`--${name} not found in the ${theme === "dark" ? ".dark" : ":root"} block`);
  return m[1]!.trim();
}

/**
 * `oklch(L C H)` or `oklch(L C H / A)` (A as a percentage or 0..1) composited
 * over `background`, in gamma-encoded sRGB like the browser. An opaque value
 * comes back exactly as oklchToSrgb returns it. Anything else throws.
 */
function oklchOver(value: string, background: Rgb): Rgb {
  const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+|none)\s+([\d.]+|none)(?:\s*\/\s*([\d.]+)(%?))?\s*\)$/.exec(value.trim());
  if (!m) throw new Error(`not an oklch() colour: ${value}`);
  const alpha = m[5] === undefined ? 1 : Number(m[5]) / (m[6] === "%" ? 100 : 1);
  if (!(alpha >= 0 && alpha <= 1)) throw new Error(`alpha out of range in: ${value}`);
  const colour = oklchToSrgb(`oklch(${m[1]}${m[2]} ${m[3]} ${m[4]})`);
  return alpha === 1 ? colour : composite(colour, background, alpha);
}

/** Custom property `name` of `theme`, alpha-aware, composited over that theme's `surface` token. */
function tokenOver(theme: Theme, name: string, surface: "card" | "background"): Rgb {
  const surfaceColour = theme === "dark" ? darkToken(surface) : lightToken(surface);
  return oklchOver(rawToken(GLOBALS_CSS, theme, name), surfaceColour);
}

describe("form-control boundary contrast (WCAG 1.4.11, h10-a11y-3)", () => {
  const sourceFiles = walkSource(SRC_DIR).sort();
  const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");
  const themes: readonly Theme[] = ["light", "dark"];
  const surfaces = ["card", "background"] as const;

  // Any `bg-input` fill, with or without variants or an opacity suffix.
  // `bg-input-subtle` is the fill token; the lookahead rejects it.
  const BG_INPUT = /(?<![\w-])(?:[a-z0-9-]+:)*bg-input(?:\/\d+)?(?![\w-])/g;

  describe("alpha-aware token reader", () => {
    it("composites oklch(L C H / A%) over a background (12 % white over black is 0.12 grey)", () => {
      const out = oklchOver("oklch(1 0 0 / 12%)", BLACK);
      for (const channel of out) expect(channel).toBeCloseTo(0.12, 3);
    });

    it("reads the alpha as a fraction as well as a percentage", () => {
      expect(oklchOver("oklch(1 0 0 / 0.12)", BLACK)).toEqual(oklchOver("oklch(1 0 0 / 12%)", BLACK));
      expect(oklchOver("oklch(0.5 0.01 60/50%)", WHITE)).toEqual(oklchOver("oklch(0.5 0.01 60 / 0.5)", WHITE));
    });

    it("returns an opaque value exactly as oklchToSrgb does, whatever sits behind it", () => {
      expect(oklchOver("oklch(0.9 0.008 80)", BLACK)).toEqual(oklchToSrgb("oklch(0.9 0.008 80)"));
      expect(oklchOver("oklch(0.9 0.008 80)", WHITE)).toEqual(oklchToSrgb("oklch(0.9 0.008 80)"));
      expect(oklchOver("oklch(0.9 0.008 80 / 100%)", BLACK)).toEqual(oklchToSrgb("oklch(0.9 0.008 80)"));
    });

    it("throws on a malformed or non-oklch value", () => {
      for (const bad of ["#fff", "oklch(1 0)", "oklch(1 0 0 /)", "oklch(1 0 0 / 150%)", "oklch(abc 0 0)", "var(--x)", ""]) {
        expect(() => oklchOver(bad, BLACK), bad).toThrow();
      }
    });

    it("does not let --input match inside --input-subtle (either order) or --color-input", () => {
      const subtleFirst = ".dark {\n  --input-subtle: oklch(1 0 0 / 12%);\n  --input: oklch(0.5 0.01 60);\n}";
      const subtleLast = ".dark {\n  --input: oklch(0.5 0.01 60);\n  --input-subtle: oklch(1 0 0 / 12%);\n}";
      expect(rawToken(subtleFirst, "dark", "input")).toBe("oklch(0.5 0.01 60)");
      expect(rawToken(subtleLast, "dark", "input")).toBe("oklch(0.5 0.01 60)");
      expect(rawToken(subtleFirst, "dark", "input-subtle")).toBe("oklch(1 0 0 / 12%)");
      expect(() => rawToken(".dark {\n  --input-subtle: oklch(1 0 0 / 12%);\n}", "dark", "input")).toThrow();
      expect(() => rawToken(":root {\n  --color-input: oklch(1 0 0);\n}", "light", "input")).toThrow();
    });

    it("reads each theme from its own block", () => {
      const css = ":root {\n  --input: oklch(0.65 0.008 80);\n}\n.dark {\n  --input: oklch(0.5 0.01 60);\n}";
      expect(rawToken(css, "light", "input")).toBe("oklch(0.65 0.008 80)");
      expect(rawToken(css, "dark", "input")).toBe("oklch(0.5 0.01 60)");
      expect(() => rawToken("a { color: red; }", "dark", "input")).toThrow();
      expect(() => rawToken("a { color: red; }", "light", "input")).toThrow();
    });

    it("reads the real tokens over the card and the background", () => {
      expect(tokenOver("dark", "card", "card")).toEqual(darkToken("card"));
      expect(tokenOver("light", "background", "background")).toEqual(lightToken("background"));
      expect(() => tokenOver("dark", "no-such-token", "card")).toThrow();
    });
  });

  describe("--input is a 3:1 boundary (the border token)", () => {
    for (const theme of themes) {
      for (const surface of surfaces) {
        it(`${theme} --input on the ${theme} ${surface} is at least 3:1`, () => {
          const surfaceColour = theme === "dark" ? darkToken(surface) : lightToken(surface);
          const ratio = contrastRatio(tokenOver(theme, "input", surface), surfaceColour);
          expect(
            ratio,
            `${theme} --input over the ${theme} ${surface} is ${ratio.toFixed(2)}:1; form-control borders need 3:1 (WCAG 1.4.11)`,
          ).toBeGreaterThanOrEqual(3);
        });
      }
    }
  });

  describe("--input-subtle keeps the pre-fix values (fills and the outline button border)", () => {
    const globals = GLOBALS_CSS;

    it("pins light to oklch(0.90 0.008 80) and dark to oklch(1 0 0 / 12%)", () => {
      expect(rawToken(globals, "light", "input-subtle")).toBe("oklch(0.90 0.008 80)");
      expect(rawToken(globals, "dark", "input-subtle")).toBe("oklch(1 0 0 / 12%)");
    });

    it("is exposed to Tailwind as --color-input-subtle in the @theme block", () => {
      const theme = /^@theme inline\s*\{([^}]*)\}/m.exec(globals);
      expect(theme, "@theme inline block not found").not.toBeNull();
      expect(theme![1]).toContain("--color-input-subtle: var(--input-subtle);");
      expect(theme![1]).toContain("--color-input: var(--input);");
    });
  });

  describe("no component fills a field with the border token", () => {
    it("scans the ui primitives (not vacuous)", () => {
      const rel = sourceFiles.map(repoPath);
      for (const file of ["src/components/ui/input.tsx", "src/components/ui/select.tsx", "src/components/ui/button.tsx"]) {
        expect(rel).toContain(file);
      }
    });

    it("finds no bg-input fill (any variant, any opacity) in non-test .ts/.tsx under src/", () => {
      const offenders = sourceFiles.flatMap((file) =>
        blankComments(readFileSync(file, "utf8"))
          .split("\n")
          .flatMap((line, i) => [...line.matchAll(BG_INPUT)].map((m) => `${repoPath(file)}:${i + 1}  ${m[0]}`)),
      );
      expect(
        offenders,
        `bg-input is the 3:1 border colour now; fill with bg-input-subtle (same value as before):\n${offenders.join("\n")}`,
      ).toEqual([]);
    });

    it("flags the fill forms and lets the subtle token and border utilities through", () => {
      for (const bad of [
        "bg-input",
        "bg-input/30",
        "dark:bg-input/30",
        "dark:hover:bg-input/50",
        "dark:disabled:bg-input/80",
        "disabled:bg-input/50",
        'className="x bg-input"',
      ]) {
        expect(bad.match(BG_INPUT), bad).not.toBeNull();
      }
      for (const ok of [
        "bg-input-subtle",
        "bg-input-subtle/30",
        "dark:hover:bg-input-subtle/50",
        "border-input",
        "dark:border-input",
        "bg-inputs",
        "xbg-input",
        "text-bg-input",
      ]) {
        expect(ok.match(BG_INPUT), ok).toBeNull();
      }
    });

    it("uses bg-input-subtle/30 for the dark fill of input, select and the outline button", () => {
      for (const file of ["src/components/ui/input.tsx", "src/components/ui/select.tsx", "src/components/ui/button.tsx"]) {
        expect(read(file), file).toContain("dark:bg-input-subtle/30");
      }
    });

    it("keeps the other fill states on the subtle token too", () => {
      expect(read("src/components/ui/input.tsx")).toContain("disabled:bg-input-subtle/50");
      expect(read("src/components/ui/input.tsx")).toContain("dark:disabled:bg-input-subtle/80");
      expect(read("src/components/ui/select.tsx")).toContain("dark:hover:bg-input-subtle/50");
      expect(read("src/components/ui/button.tsx")).toContain("dark:hover:bg-input-subtle/50");
    });

    it("gives the outline button the old (subtle) border, not the new 3:1 one", () => {
      const button = read("src/components/ui/button.tsx");
      expect(button).toContain("dark:border-input-subtle");
      expect(button).not.toMatch(/dark:border-input(?![\w-])/);
    });

    it("keeps the 3:1 border token on the field boxes", () => {
      for (const file of [
        "src/components/ui/input.tsx",
        "src/components/ui/select.tsx",
        "src/components/story/correction-form.tsx",
        "src/components/newsletter/newsletter-form.tsx",
      ]) {
        expect(read(file), file).toMatch(/(?<![\w:-])border-input(?![\w-])/);
      }
    });
  });

  describe("dark placeholder keeps 4.5:1 on the (unchanged) field fill", () => {
    const placeholder = (): Rgb => darkToken("muted-foreground");

    it("muted-foreground clears 4.5:1 on bg-input-subtle/30 over the dark card", () => {
      // 12 % white token at 30 % utility opacity = 3.6 % white over the card.
      const fill = composite(WHITE, darkToken("card"), 0.12 * 0.3);
      const ratio = contrastRatio(placeholder(), fill);
      expect(ratio, `placeholder on the field fill is ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    });

    it("the fill the code really paints is the pinned subtle token (no drift from the formula above)", () => {
      const subtle = oklchOver(rawToken(GLOBALS_CSS, "dark", "input-subtle"), darkToken("card"));
      const expected = composite(WHITE, darkToken("card"), 0.12);
      subtle.forEach((channel, i) => expect(channel).toBeCloseTo(expected[i]!, 2));
    });

    it("shows why the border token cannot be the fill: muted-foreground drops below 4.5:1 on it", () => {
      const fill = composite(tokenOver("dark", "input", "card"), darkToken("card"), 0.3);
      const ratio = contrastRatio(placeholder(), fill);
      expect(ratio, `placeholder on a bg-input/30 fill would be ${ratio.toFixed(2)}:1`).toBeLessThan(4.5);
    });
  });
});
