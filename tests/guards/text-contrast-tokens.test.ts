import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (a11y-2): story-card and cluster-page *text* must use the
// full `text-muted-foreground` / `text-brand` tokens. Any opacity-modified
// form (`/10` .. `/90`) composites below the WCAG 1.4.3 floor of 4.5:1 for
// text. Measured for `text-muted-foreground` in both themes on the page
// background and the card (alpha-composited in gamma space):
//   /40 1.8   /60 2.5-2.6   /70 3.1-3.2   /80 3.7-3.8   /90 4.3-4.8
// so even /80 fails (3.68 on the dark card) and /90 fails on the dark card
// (4.33). Only the full token clears 4.5:1 everywhere (5.1-6.0). Visual
// hierarchy comes from the existing size differences (10-11 px), never from
// opacity.
//
// Scope: every non-test .tsx in src/components/story/ plus the cluster page.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const STORY_DIR = join(ROOT, "src/components/story");
const CLUSTER_PAGE = join(ROOT, "src/app/cluster/[id]/page.tsx");

// Any numeric opacity suffix except `/100` (which is the full token).
const LOW_CONTRAST_TEXT = /\btext-(?:muted-foreground|brand)\/(?!100\b)\d+\b/;
const LOW_CONTRAST_TEXT_GLOBAL = new RegExp(LOW_CONTRAST_TEXT.source, "g");

/**
 * Non-text decorative icons, exempt from 1.4.3 (it governs text; icons fall
 * under 1.4.11 only when they carry meaning, and these are aria-hidden or
 * hover-only affordances). Each entry is the exact class string as written in
 * source. The staleness test below fails if an entry stops matching anything,
 * so this list cannot silently outlive the code it excuses.
 */
const ALLOWED_ICON_CLASSES: ReadonlyArray<{ classes: string; why: string }> = [
  {
    // cluster-card-image.tsx: <Newspaper aria-hidden="true" /> placeholder
    // glyph on the tier-3 gray gradient; purely decorative, no text.
    classes: "h-5 w-5 text-muted-foreground/30",
    why: "cluster-card-image Newspaper placeholder icon",
  },
  {
    // framing-comparison.tsx: <ExternalLink /> glyph that only fades in on
    // hover (opacity-0 -> opacity-100); decorative, the link text is separate.
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

const files = [...walk(STORY_DIR), CLUSTER_PAGE].sort();
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

/** Source with every allow-listed icon class string removed. */
function withoutAllowedIcons(src: string): string {
  let out = src;
  for (const { classes } of ALLOWED_ICON_CLASSES) out = out.split(classes).join("");
  return out;
}

describe("text-contrast tokens (a11y-2)", () => {
  it("scans the story components and the cluster page", () => {
    expect(files).toContain(CLUSTER_PAGE);
    expect(files.some((f) => f.endsWith("cluster-card.tsx"))).toBe(true);
    expect(files.some((f) => f.endsWith("bias-spectrum.tsx"))).toBe(true);
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
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
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground/100")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("text-muted-foreground")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("text-brand")).toBe(false);
    expect(LOW_CONTRAST_TEXT.test("border-muted-foreground/50")).toBe(false);
  });

  describe("ALLOWED_ICON_CLASSES", () => {
    it.each(ALLOWED_ICON_CLASSES.map((e) => [e.why, e.classes] as const))(
      "still exists in source: %s",
      (_why, classes) => {
        const found = [...sources.values()].some((src) => src.includes(classes));
        expect(
          found,
          `Allow-listed class string "${classes}" no longer appears in any scanned file; remove it from ALLOWED_ICON_CLASSES.`,
        ).toBe(true);
      },
    );

    it("only excuses text-muted-foreground opacity on h-* w-* icon sizes", () => {
      for (const { classes } of ALLOWED_ICON_CLASSES) {
        expect(classes).toMatch(/^h-[\d.]+ w-[\d.]+ text-muted-foreground\/\d+$/);
      }
    });
  });
});
