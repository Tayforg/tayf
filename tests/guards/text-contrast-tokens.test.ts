import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

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
// Third guard (hunt2 wave U, tinted status pills): a pill tinted with
// `bg-<hue>-500/15` is a 15 % wash over the card, so its 11 px label needs the
// darker shades to reach 4.5:1 in both themes: 800 (or 900) in light mode and
// 200 / 300 / 400 in dark mode. `text-rose-700 dark:text-rose-500` (the old
// "karantinada" pill) measures below AA in both. The AA-safe pairs live in
// SILENCE_BADGE_CLASS (src/app/kaynaklar/durum/page.tsx).
//
// Scoped, not global: other files still carry the 700 / 500 pairs (cluster
// card, follow feed, status view) and moving them is a design change of its
// own. The list grows file by file: add a path to TINTED_PILL_FILES in the
// same change that fixes that file's pills, and the guard keeps them fixed.
// ---------------------------------------------------------------------------

const TINTED_PILL_FILES = ["src/app/kaynaklar/durum/page.tsx"];

const TINTED_BG = /\bbg-([a-z]+)-500\/15(?![\w-])/;

/**
 * Double-quoted and template-literal strings of one source file, per line for
 * double quotes (a stray `"` in a comment cannot swallow the next line).
 * Block comments and whole-line `//` comments are blanked first, so an odd
 * number of backticks in prose cannot shift the template-literal pairing.
 * Single quotes are skipped on purpose: Turkish apostrophes in comments would
 * mis-pair, and class strings in this codebase are never single-quoted.
 */
function classStringLiterals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
  const out: string[] = [];
  for (const match of code.matchAll(/"([^"\n]*)"|`([^`]*)`/g)) out.push(match[1] ?? match[2] ?? "");
  return out;
}

/** Why a tinted-pill class string fails AA, or null when it passes (or is not a tinted pill). */
function tintedPillProblem(classes: string): string | null {
  const tint = TINTED_BG.exec(classes);
  if (!tint) return null;
  const hue = tint[1]!;
  const light = new RegExp(`(?<![\\w:/-])text-${hue}-(?:800|900)(?![\\w-])`);
  const dark = new RegExp(`(?<![\\w])dark:text-${hue}-(?:200|300|400)(?![\\w-])`);
  const problems: string[] = [];
  if (!light.test(classes)) problems.push(`needs text-${hue}-800 or -900 in light mode`);
  if (!dark.test(classes)) problems.push(`needs dark:text-${hue}-200, -300 or -400 in dark mode`);
  return problems.length > 0 ? problems.join("; ") : null;
}

describe("tinted status pills keep AA text shades (WCAG 1.4.3)", () => {
  const pillLiterals = TINTED_PILL_FILES.flatMap((file) =>
    classStringLiterals(readFileSync(join(ROOT, file), "utf8"))
      .filter((literal) => TINTED_BG.test(literal))
      .map((literal) => ({ file, literal })),
  );

  it("scans the listed files and finds their tinted pills (not vacuous)", () => {
    for (const file of TINTED_PILL_FILES) {
      expect(files, `${file} is not a scanned src/**/*.tsx file`).toContain(join(ROOT, file));
      expect(
        pillLiterals.filter((p) => p.file === file).length,
        `${file} no longer has a bg-<hue>-500/15 pill; remove it from TINTED_PILL_FILES`,
      ).toBeGreaterThanOrEqual(1);
    }
    // three silence reasons + the karantinada pill
    expect(pillLiterals.filter((p) => p.file === "src/app/kaynaklar/durum/page.tsx").length).toBeGreaterThanOrEqual(4);
  });

  it("every bg-<hue>-500/15 string uses a 800/900 light shade and a 200/300/400 dark shade of its hue", () => {
    const offenders = pillLiterals.flatMap(({ file, literal }) => {
      const problem = tintedPillProblem(literal);
      return problem ? [`${file}  "${literal}"  ${problem}`] : [];
    });
    expect(
      offenders,
      `Tinted pills need AA text shades (WCAG 1.4.3), e.g. text-rose-800 dark:text-rose-300:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("flags the old pair and accepts the AA-safe ones (the guard itself works)", () => {
    // the old karantinada pill
    expect(
      tintedPillProblem(
        "inline-flex items-center gap-1 rounded-full bg-rose-500/15 border border-rose-500/30 px-2 py-0.5 text-[11px] text-rose-700 dark:text-rose-500 font-medium",
      ),
    ).not.toBeNull();
    expect(tintedPillProblem("bg-rose-500/15 text-rose-700 dark:text-rose-500")).toContain("light mode");
    expect(tintedPillProblem("bg-rose-500/15 text-rose-700 dark:text-rose-500")).toContain("dark mode");
    // the erisim_yok string, and its siblings
    expect(tintedPillProblem("bg-rose-500/15 border-rose-500/30 text-rose-800 dark:text-rose-300")).toBeNull();
    expect(tintedPillProblem("bg-sky-500/15 border-sky-500/30 text-sky-800 dark:text-sky-300")).toBeNull();
    expect(tintedPillProblem("bg-amber-500/15 border-amber-500/30 text-amber-800 dark:text-amber-400")).toBeNull();
    expect(tintedPillProblem("bg-emerald-500/15 text-emerald-900 dark:text-emerald-200")).toBeNull();
  });

  it("does not let a prefixed or foreign-hue shade stand in for the real one", () => {
    // a dark-only shade is not a light-mode shade
    expect(tintedPillProblem("bg-rose-500/15 dark:text-rose-800 dark:text-rose-300")).toContain("light mode");
    // another hue's text shade does not count
    expect(tintedPillProblem("bg-rose-500/15 text-sky-800 dark:text-sky-300")).not.toBeNull();
    // a light-only fix leaves dark mode below AA
    expect(tintedPillProblem("bg-rose-500/15 text-rose-800")).toContain("dark mode");
    // 600 is still below AA on the 15 % wash; 500 in dark too
    expect(tintedPillProblem("bg-rose-500/15 text-rose-600 dark:text-rose-300")).toContain("light mode");
    expect(tintedPillProblem("bg-rose-500/15 text-rose-800 dark:text-rose-500")).toContain("dark mode");
  });

  it("ignores strings that are not tinted pills", () => {
    expect(tintedPillProblem("bg-rose-500/10 text-rose-700")).toBeNull();
    expect(tintedPillProblem("bg-rose-500 text-white")).toBeNull();
    expect(tintedPillProblem("text-rose-700")).toBeNull();
  });

  it("extracts double-quoted and template literals, one line at a time", () => {
    const src = [
      "// Tayf'ın comment with a lone apostrophe, a \"quote and one `backtick",
      "/* block comment with `one backtick too */",
      'const a = "bg-sky-500/15 text-sky-800 dark:text-sky-300";',
      "const b = `bg-rose-500/15 ${x ? \"y\" : \"z\"}`;",
    ].join("\n");
    const literals = classStringLiterals(src);
    expect(literals).toContain("bg-sky-500/15 text-sky-800 dark:text-sky-300");
    expect(literals.some((l) => l.startsWith("bg-rose-500/15"))).toBe(true);
    expect(literals.some((l) => l.includes("backtick"))).toBe(false);
  });
});
