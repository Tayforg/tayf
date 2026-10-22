import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
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
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");
const CLUSTER_PAGE = join(ROOT, "src/app/cluster/[id]/page.tsx");

// Any numeric opacity suffix except `/100` (which is the full token).
const LOW_CONTRAST_TEXT = /\btext-(?:muted-foreground|brand)\/(?!100\b)\d+\b/;
const LOW_CONTRAST_TEXT_GLOBAL = new RegExp(LOW_CONTRAST_TEXT.source, "g");

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
