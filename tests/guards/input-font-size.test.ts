import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG 1.4.4 Resize Text, in practice on iOS Safari): a
// focused text field whose computed font-size is below 16 px makes iOS Safari
// zoom the whole page in and leave it zoomed. Tayf's public fields used
// `text-sm` (14 px), so tapping the search bar, the newsletter box or the
// correction form shifted the layout on every iPhone visit.
//
// The floor is 16 px: an editable public <input> / <textarea> must carry an
// UNPREFIXED `text-base` (or larger) in its className, usually written
// `text-base sm:text-sm` so desktops keep the compact 14 px:
//
//     className="... text-base sm:text-sm ..."
//
// A `sm:text-base` alone does not count (phones would still get the base
// size of the field, which is the zoom trigger), and neither does `text-sm`.
//
// Scope: every non-test .tsx under src/ except the admin area (internal
// operator tools, desktop only, see the /admin/ exclusion), the same walk as
// input-purpose.test.ts. Fields that never take a keyboard are exempt:
// hidden / checkbox / radio / submit / button / range / color / file / reset /
// image types, readOnly fields, and the bot honeypots (tabIndex={-1} and
// aria-hidden="true", off-screen and never focused by a person).
//
// There is no public native <select> today (the zoom rule applies to it
// too). The last test fails the moment one appears, so the guard is extended
// instead of silently missing it.
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

/** Repo-relative, forward-slash path of a scanned file. */
function repoPath(file: string): string {
  return relative(ROOT, file).split(sep).join("/");
}

interface FieldTag {
  kind: "input" | "textarea";
  /** The opening tag, from `<input` / `<textarea` up to its end. */
  tag: string;
  /** 1-based line of the opening `<` in its file. */
  line: number;
}

/**
 * Every `<input` / `<textarea` opening tag in `src`, sliced up to the next
 * `/>` (JSX forbids an unclosed void element, and `/>` survives `=>` arrows
 * inside handler attributes, which a plain `>` search would not). A
 * `<textarea ...>` that is closed by `</textarea>` instead is cut there, so
 * it can never swallow its neighbour. An unterminated tag runs to the end of
 * the file: it is checked, never skipped.
 */
function fieldTags(src: string): FieldTag[] {
  const out: FieldTag[] = [];
  for (const match of src.matchAll(/<(input|textarea)(?=[\s/>])/g)) {
    const kind = match[1] as FieldTag["kind"];
    const start = match.index ?? 0;
    const selfClose = src.indexOf("/>", start);
    const closeTag = src.indexOf(`</${kind}`, start);
    let end = selfClose === -1 ? src.length : selfClose + 2;
    if (closeTag !== -1 && closeTag < end) end = closeTag;
    out.push({ kind, tag: src.slice(start, end), line: src.slice(0, start).split("\n").length });
  }
  return out;
}

const QUOTED = (words: string): string =>
  `(?:"(?:${words})"|'(?:${words})'|\\{\\s*["'](?:${words})["']\\s*\\})`;

const NON_TEXT_TYPES = "hidden|checkbox|radio|submit|button|range|color|file|reset|image";
const NON_TEXT_TYPE = new RegExp(`\\btype=${QUOTED(NON_TEXT_TYPES)}`);
const READ_ONLY = /\breadOnly\b(?!=\{\s*false\s*\})/;
const TAB_OUT = /\btabIndex=\{\s*-1\s*\}/;
const ARIA_HIDDEN = /\baria-hidden=(?:"true"|'true'|\{\s*true\s*\})/;

/** Why a tag is exempt from the font-size floor, or null when it is checked. */
function exemption(tag: string): string | null {
  if (NON_TEXT_TYPE.test(tag)) return "non-text input type";
  if (READ_ONLY.test(tag)) return "readOnly";
  if (TAB_OUT.test(tag)) return "tabIndex={-1}";
  if (ARIA_HIDDEN.test(tag)) return 'aria-hidden="true"';
  return null;
}

/**
 * The className string literal of a tag (double or single quoted, or inside
 * `{"..."}` / `{`...`}`), or null when there is none or it is not a literal.
 */
function classNameLiteral(tag: string): string | null {
  const m = /\bclassName=(?:"([^"]*)"|'([^']*)'|\{\s*"([^"]*)"\s*\}|\{\s*`([^`]*)`\s*\})/.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? m[4] ?? null;
}

/**
 * An unprefixed text size of 16 px or more: text-base / text-lg / text-xl /
 * text-2xl .. text-9xl. The lookbehind rejects any variant prefix
 * (`sm:text-base`, `md:text-lg`, `placeholder:text-base` all end in `:`), an
 * arbitrary-value or compound neighbour (`-`, `/`) and word characters; the
 * lookahead rejects `text-base-foo` and `text-xlarge` style longer tokens.
 */
const FONT_FLOOR = /(?<![\w:\/-])text-(base|lg|xl|[2-9]xl)(?![\w-])/;

const meetsFontFloor = (tag: string): boolean => {
  const cls = classNameLiteral(tag);
  return cls !== null && FONT_FLOOR.test(cls);
};

const files = walk(SRC_DIR)
  .filter((f) => !repoPath(f).includes("/admin/"))
  .sort();
const sources = new Map(files.map((f) => [f, readFileSync(f, "utf8")]));

const allTags = files.flatMap((file) =>
  fieldTags(sources.get(file) ?? "").map((t) => ({ file: repoPath(file), ...t })),
);
const checked = allTags.filter(({ tag }) => exemption(tag) === null);

describe("editable public fields keep a 16 px font on phones (iOS focus zoom)", () => {
  it("gives every editable <input> / <textarea> an unprefixed text-base or larger", () => {
    const offenders = checked
      .filter(({ tag }) => !meetsFontFloor(tag))
      .map(({ file, line, kind }) => `${file}:${line}  <${kind}>`);
    expect(
      offenders,
      `Add "text-base sm:text-sm" to these fields (iOS Safari zooms the page when a focused field is under 16 px):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: scans the public form files and checks at least 5 tags", () => {
    const scanned = files.map(repoPath);
    expect(scanned).toContain("src/components/filters/search-bar.tsx");
    expect(scanned).toContain("src/components/story/correction-form.tsx");
    expect(scanned).toContain("src/components/newsletter/newsletter-form.tsx");
    expect(scanned.some((f) => f.includes("/admin/"))).toBe(false);
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
    expect(files.length).toBeGreaterThan(50);

    const where = checked.map(({ file }) => file);
    expect(where).toContain("src/components/filters/search-bar.tsx");
    expect(where.filter((f) => f === "src/components/story/correction-form.tsx")).toHaveLength(3);
    expect(where).toContain("src/components/newsletter/newsletter-form.tsx");
    expect(checked.length).toBeGreaterThanOrEqual(5);
  });

  it("exempts only the honeypots and the read-only copy box (no field hides behind an exemption)", () => {
    const exempt = allTags
      .filter(({ tag }) => exemption(tag) !== null)
      .map(({ file, kind }) => `${file} <${kind}>`)
      .sort();
    expect(exempt).toEqual([
      "src/components/newsletter/newsletter-form.tsx <input>",
      "src/components/story/correction-form.tsx <input>",
      "src/components/story/share-button.tsx <textarea>",
    ]);
  });

  it("the shared <Input> wrapper keeps the 16 px base for its call sites", () => {
    const wrapper = readFileSync(join(SRC_DIR, "components/ui/input.tsx"), "utf8");
    expect(wrapper).toMatch(FONT_FLOOR);
  });

  it("has no public native <select> (extend this guard if one is added)", () => {
    const selects = files
      .filter((f) => /<select(?=[\s/>])/.test(sources.get(f) ?? ""))
      .map(repoPath);
    expect(
      selects,
      `A native <select> now exists outside /admin/: ${selects.join(", ")}. It zooms on iOS focus below 16 px too; add "select" to fieldTags() in tests/guards/input-font-size.test.ts and give it text-base sm:text-sm.`,
    ).toEqual([]);
  });

  describe("the guard itself works", () => {
    describe("font-size matcher", () => {
      it.each([
        "text-base",
        "text-base sm:text-sm",
        "h-10 w-full text-lg",
        "px-3 text-xl placeholder:text-muted-foreground",
        "text-2xl",
        "text-9xl",
        "text-base/6",
        '"min-h-[44px] text-base sm:text-sm"',
      ])("accepts %s", (cls) => {
        expect(FONT_FLOOR.test(cls)).toBe(true);
      });

      it.each([
        "text-sm",
        "text-xs",
        "text-[11px]",
        "text-[16px]",
        "sm:text-base",
        "md:text-lg",
        "text-sm sm:text-base",
        "placeholder:text-base",
        "dark:text-xl",
        "text-base-foo",
        "text-basement",
        "text-xlarge",
        "text-1xl",
        "text-10xl",
        "text-muted-foreground",
        "font-text-base",
        "",
      ])("rejects %s", (cls) => {
        expect(FONT_FLOOR.test(cls)).toBe(false);
      });
    });

    describe("tag slicing", () => {
      const passing = `
        <form>
          <input
            id="a"
            name="email"
            type="email"
            onChange={(e) => setValue(e.target.value)}
            className="w-full text-base sm:text-sm"
          />
          <textarea name="m" rows={5} className="w-full text-sm" />
          <input type="text" name="website" tabIndex={-1} aria-hidden="true" className="opacity-0" />
        </form>
      `;

      it("slices each multi-line opening tag up to its own closing />", () => {
        const tags = fieldTags(passing);
        expect(tags.map((t) => t.kind)).toEqual(["input", "textarea", "input"]);
        // the => inside onChange must not end the tag early
        expect(tags[0]!.tag).toContain("onChange");
        expect(tags[0]!.tag.endsWith("/>")).toBe(true);
        // and the first tag must not swallow its neighbour
        expect(tags[0]!.tag).not.toContain("textarea");
        expect(tags[1]!.tag).not.toContain("website");
      });

      it("reports the 1-based line of the opening tag", () => {
        expect(fieldTags(passing).map((t) => t.line)).toEqual([3, 10, 11]);
      });

      it("cuts a <textarea> closed by </textarea> at its closing tag", () => {
        const [only, next] = fieldTags(
          '<textarea className="text-sm">hello</textarea><input className="text-base" />',
        );
        expect(only!.tag).toBe('<textarea className="text-sm">hello');
        expect(meetsFontFloor(only!.tag)).toBe(false);
        expect(next!.tag).toBe('<input className="text-base" />');
        expect(meetsFontFloor(next!.tag)).toBe(true);
      });

      it("runs an unterminated tag to the end of the file instead of dropping it", () => {
        const [only] = fieldTags('<input className="text-sm"');
        expect(only).toBeDefined();
        expect(meetsFontFloor(only!.tag)).toBe(false);
      });

      it("does not mistake a longer component name for a field", () => {
        expect(fieldTags('<InputGroup className="text-sm" /><inputs />')).toEqual([]);
        expect(fieldTags('<Input className="text-sm" />')).toEqual([]);
      });
    });

    describe("exemptions", () => {
      it.each([
        ['<input type="hidden" name="a" />', "non-text input type"],
        ['<input type="checkbox" className="text-sm" />', "non-text input type"],
        ["<input type='radio' />", "non-text input type"],
        ['<input type={"submit"} />', "non-text input type"],
        ['<input type="range" />', "non-text input type"],
        ['<input type="file" />', "non-text input type"],
        ["<input readOnly value={v} />", "readOnly"],
        ['<textarea readOnly aria-label="x" className="text-sm" />', "readOnly"],
        ['<input type="text" tabIndex={-1} className="text-sm" />', "tabIndex={-1}"],
        ['<input type="text" aria-hidden="true" className="text-sm" />', 'aria-hidden="true"'],
      ])("exempts %s", (tag, why) => {
        expect(exemption(tag)).toBe(why);
      });

      it.each([
        '<input type="text" className="text-sm" />',
        '<input type="email" className="text-sm" />',
        '<input type="search" className="text-sm" />',
        '<input type="url" className="text-sm" />',
        '<input type="number" className="text-sm" />',
        "<input className=\"text-sm\" />",
        '<textarea className="text-sm" />',
        '<input readOnly={false} className="text-sm" />',
        '<input tabIndex={0} aria-hidden="false" className="text-sm" />',
      ])("checks %s", (tag) => {
        expect(exemption(tag)).toBeNull();
      });
    });

    describe("className extraction", () => {
      it("reads double-quoted, single-quoted, braced and template literals", () => {
        expect(classNameLiteral('<input className="a text-base" />')).toBe("a text-base");
        expect(classNameLiteral("<input className='a text-base' />")).toBe("a text-base");
        expect(classNameLiteral('<input className={"a text-base"} />')).toBe("a text-base");
        expect(classNameLiteral("<input className={`a text-base`} />")).toBe("a text-base");
      });

      it("treats a missing or computed className as unverifiable, so the field fails", () => {
        expect(classNameLiteral("<input />")).toBeNull();
        expect(classNameLiteral("<input className={styles.field} />")).toBeNull();
        expect(classNameLiteral('<input className={cn("text-base", extra)} />')).toBeNull();
        expect(meetsFontFloor("<input />")).toBe(false);
        expect(meetsFontFloor("<input className={styles.field} />")).toBe(false);
      });

      it("only reads the className, not another attribute that mentions text-base", () => {
        expect(meetsFontFloor('<input placeholder="text-base" className="text-sm" />')).toBe(false);
        expect(meetsFontFloor('<input data-x="text-base" className="text-base" />')).toBe(true);
      });
    });

    it("flags the pre-fix fields and accepts the fixed ones", () => {
      const before =
        '<input type="search" className="h-10 w-full rounded-full pl-9 pr-12 text-sm placeholder:text-muted-foreground" />';
      const after =
        '<input type="search" className="h-10 w-full rounded-full pl-9 pr-12 text-base sm:text-sm placeholder:text-muted-foreground" />';
      expect(meetsFontFloor(before)).toBe(false);
      expect(meetsFontFloor(after)).toBe(true);
    });
  });
});
