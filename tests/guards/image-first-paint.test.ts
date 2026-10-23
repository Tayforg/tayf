import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (perf-1): no <Image> / <img> may be server-rendered
// invisible.
//
// ClusterCardImage used to render its photo `opacity-0` and only flip it to
// `opacity-100` from a client `onLoad` handler. The SSR HTML therefore shipped
// an invisible hero: Chrome does not count an `opacity: 0` image as the
// Largest Contentful Paint candidate, so the real LCP waited for hydration
// plus the fade (and the preload `<link>` fetched a picture nobody could
// see yet). An image gated like that cannot be the LCP element no matter how
// early its bytes arrive.
//
//     className={`... ${loaded ? "opacity-100" : "opacity-0"}`}   // forbidden
//
// A loading backdrop belongs on the WRAPPER (a gradient behind the photo), and
// the photo itself paints as soon as it decodes.
//
// Scope: every non-test .tsx under src/ (components and app routes alike), the
// same walk as input-purpose.test.ts, so a new image cannot regress it. Each
// `<Image ...>` / `<img ...>` opening tag is sliced up to its closing `/>` and
// must not carry a zero-opacity class. Decorative non-image elements (the
// bot honeypot input, a hover-only icon) are out of scope: only image tags are
// inspected.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC_DIR = join(ROOT, "src");

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
 * Blanks block comments and whole-line `//` comments, keeping every offset and
 * newline, so prose that merely mentions `<img>` or `opacity-0` can neither
 * start a tag slice nor trip the zero-opacity check, and reported line numbers
 * still match the file. One pass, so a `//` line holding a `/*` is a line
 * comment and a block comment holding a `//` is a block comment.
 */
function blankComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|^[ \t]*\/\/[^\n]*/gm, (m) =>
    m.replace(/[^\n]/g, " "),
  );
}

interface ImageTag {
  /** The opening tag, from `<Image` / `<img` through the closing `/>`. */
  tag: string;
  /** 1-based line of the tag's `<` in its file. */
  line: number;
}

/**
 * Every `<Image ... />` and `<img ... />` opening tag in `src`, sliced from the
 * tag name to the next `/>`. JSX forbids an unclosed void element, so `/>` is
 * always the real end of the tag, and it survives `=>` arrows inside handler
 * attributes, which a plain `>` search would not. Attributes may span any
 * number of lines.
 *
 * The name must end the identifier (`<ImageResponse` is a different component)
 * and the `<` must not follow an identifier character (so the generic
 * `Array<Image>` is not a tag).
 */
function imageTags(src: string): ImageTag[] {
  const code = blankComments(src);
  const out: ImageTag[] = [];
  for (const match of code.matchAll(/(?<![\w$])<(?:Image|img)(?=[\s/>])/g)) {
    const start = match.index ?? 0;
    const end = code.indexOf("/>", start);
    if (end === -1) continue;
    out.push({
      tag: code.slice(start, end + 2),
      line: code.slice(0, start).split("\n").length,
    });
  }
  return out;
}

/**
 * A class (or inline style) that makes the image invisible at first paint:
 * `opacity-0`, `opacity-[0]`, or `opacity: 0`. Matches inside a template
 * literal conditional too, which is the JS-gated form this guard exists for.
 */
const HIDDEN_FIRST_PAINT = /\bopacity-0\b|\bopacity-\[0\]|\bopacity:\s*0(?![.\d])/;

const hidesFirstPaint = (tag: string): boolean => HIDDEN_FIRST_PAINT.test(tag);

const files = walk(SRC_DIR).sort();
const allTags = files.flatMap((file) =>
  imageTags(readFileSync(file, "utf8")).map((t) => ({ file, ...t })),
);

describe("image first paint (perf-1)", () => {
  it("never server-renders an <Image> / <img> at opacity-0", () => {
    const offenders = allTags
      .filter(({ tag }) => hidesFirstPaint(tag))
      .map(({ file, line }) => `${relative(ROOT, file).split(sep).join("/")}:${line}`);
    expect(
      offenders,
      `These images are hidden in the SSR HTML (opacity-0), so they cannot be the LCP and wait for hydration. Paint the image at once and put any loading backdrop on its wrapper:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: finds the site's image tags, including ClusterCardImage's", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
    expect(allTags.length).toBeGreaterThanOrEqual(3);

    const inCard = allTags.filter(
      ({ file }) =>
        relative(ROOT, file).split(sep).join("/") ===
        "src/components/story/cluster-card-image.tsx",
    );
    // The tier-1 next/image photo and the tier-2 logo <img>.
    expect(inCard.some(({ tag }) => tag.startsWith("<Image"))).toBe(true);
    expect(inCard.some(({ tag }) => tag.startsWith("<img"))).toBe(true);
  });

  describe("the guard itself works", () => {
    const passing = `
      <div className="relative bg-gradient-to-br from-muted">
        <Image
          src={currentSrc}
          alt={alt}
          className="absolute inset-0 h-full w-full object-cover transition-transform duration-500"
          onLoad={(e) => measure(e.currentTarget)}
        />
        <img src={logo} alt="" className="max-h-[50%] opacity-60" />
      </div>
    `;
    const failingStatic = `
      <Image
        src={currentSrc}
        alt={alt}
        className="absolute inset-0 opacity-0 transition-opacity"
      />
    `;
    const failingGated = `
      <Image
        src={currentSrc}
        alt={alt}
        className={\`absolute inset-0 transition-all \${loaded ? "opacity-100" : "opacity-0"}\`}
        onLoad={() => setLoaded(true)}
      />
    `;

    it("slices each multi-line opening tag up to its own closing />", () => {
      const tags = imageTags(passing);
      expect(tags).toHaveLength(2);
      // The `=>` inside onLoad must not end the tag early.
      expect(tags[0]!.tag.startsWith("<Image")).toBe(true);
      expect(tags[0]!.tag).toContain("onLoad");
      expect(tags[0]!.tag.endsWith("/>")).toBe(true);
      // ...and the first tag must not swallow its neighbour.
      expect(tags[0]!.tag).not.toContain("logo");
      expect(tags[1]!.tag.startsWith("<img")).toBe(true);
    });

    it("reports the 1-based line of the tag", () => {
      expect(imageTags(passing).map((t) => t.line)).toEqual([3, 9]);
    });

    it("accepts an image that paints at once, and a logo with a non-zero opacity", () => {
      for (const { tag } of imageTags(passing)) expect(hidesFirstPaint(tag)).toBe(false);
    });

    it("rejects a statically opacity-0 image", () => {
      const [only] = imageTags(failingStatic);
      expect(only).toBeDefined();
      expect(hidesFirstPaint(only!.tag)).toBe(true);
    });

    it("rejects the JS-gated opacity-100 / opacity-0 toggle", () => {
      const [only] = imageTags(failingGated);
      expect(only).toBeDefined();
      expect(hidesFirstPaint(only!.tag)).toBe(true);
    });

    it("also rejects the arbitrary-value and inline-style spellings", () => {
      expect(hidesFirstPaint('<img className="opacity-[0]" />')).toBe(true);
      expect(hidesFirstPaint("<img style={{ opacity: 0 }} />")).toBe(true);
      expect(hidesFirstPaint("<img style={{ opacity: 0.5 }} />")).toBe(false);
      expect(hidesFirstPaint('<img className="opacity-50 opacity-100" />')).toBe(false);
    });

    it("does not mistake <ImageResponse> (or another longer name) for an image tag", () => {
      expect(imageTags('<ImageResponse className="opacity-0" />')).toEqual([]);
      expect(imageTags('<ImageGallery className="opacity-0" />')).toEqual([]);
    });

    it("does not treat a TypeScript generic as a tag", () => {
      expect(imageTags("const a: Array<Image> = []; const b = useRef<img | null>(null);")).toEqual(
        [],
      );
    });

    it("ignores prose in comments that mentions an image tag or opacity-0", () => {
      const commented = `
        // The <Image> used to stay opacity-0 until onLoad fired.
        {/* Plain <img> (not next/image) with opacity-0 history. */}
        /* <img className="opacity-0" /> */
        <Image src={a} alt="" className="h-full w-full" />
      `;
      const tags = imageTags(commented);
      expect(tags).toHaveLength(1);
      expect(hidesFirstPaint(tags[0]!.tag)).toBe(false);
      // Blanking keeps offsets, so the line number still points at the real tag.
      expect(tags[0]!.line).toBe(5);
    });

    it("leaves non-image zero-opacity elements (honeypot input) out of scope", () => {
      const honeypot = '<input className="absolute left-[-9999px] h-0 w-0 opacity-0" />';
      expect(imageTags(honeypot)).toEqual([]);
    });
  });
});
