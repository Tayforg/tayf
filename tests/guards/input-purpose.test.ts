import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Permanent CI guard (WCAG 2.2 SC 1.3.5, Identify Input Purpose, level AA):
// a form field that collects information about the user must expose its
// purpose programmatically, so browsers and assistive tech can autofill it
// and render a familiar icon/label. For an e-mail field that means the HTML
// autocomplete token `email`:
//
//     <input type="email" autoComplete="email" ... />
//
// Without it, `type="email"` alone gives the keyboard hint but not the
// autofill purpose that 1.3.5 asks for. Fields that are NOT about the user
// (a reported article URL, a free-text objection, the bot honeypot) should say
// `autoComplete="off"` instead; that part is pinned per component, this guard
// only enforces the e-mail rule that must hold for every form on the site.
//
// Scope: every non-test .tsx under src/ (components and app routes alike), the
// same walk as text-contrast-tokens.test.ts, so a new form cannot regress it.
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

interface InputTag {
  /** The opening tag, from `<input` through the closing `/>`. */
  tag: string;
  /** 1-based line of the `<input` in its file. */
  line: number;
}

/**
 * Every `<input ...  />` (and the `<Input ... />` wrapper style) opening tag in
 * `src`, sliced from the tag name to the next `/>`. JSX forbids an unclosed
 * void element, so `/>` is always the real end of the tag, and it survives
 * `=>` arrows inside handler attributes, which a plain `>` search would not.
 * Attributes may span any number of lines.
 */
function inputTags(src: string): InputTag[] {
  const out: InputTag[] = [];
  for (const match of src.matchAll(/<[Ii]nput(?=[\s/>])/g)) {
    const start = match.index ?? 0;
    const end = src.indexOf("/>", start);
    if (end === -1) continue;
    out.push({
      tag: src.slice(start, end + 2),
      line: src.slice(0, start).split("\n").length,
    });
  }
  return out;
}

const EMAIL_TYPE = /\btype=(?:"email"|'email'|\{\s*["']email["']\s*\})/;
const EMAIL_AUTOCOMPLETE = /\bautoComplete=(?:"email"|'email'|\{\s*["']email["']\s*\})/;

const isEmailInput = (tag: string): boolean => EMAIL_TYPE.test(tag);
const hasEmailPurpose = (tag: string): boolean => EMAIL_AUTOCOMPLETE.test(tag);

const files = walk(SRC_DIR).sort();
const emailInputs = files.flatMap((file) =>
  inputTags(readFileSync(file, "utf8"))
    .filter(({ tag }) => isEmailInput(tag))
    .map((input) => ({ file, ...input })),
);

describe("input purpose (WCAG 1.3.5)", () => {
  it('gives every type="email" input autoComplete="email"', () => {
    const offenders = emailInputs
      .filter(({ tag }) => !hasEmailPurpose(tag))
      .map(({ file, line }) => `${relative(ROOT, file)}:${line}`);
    expect(
      offenders,
      `Add autoComplete="email" to these e-mail inputs (WCAG 1.3.5 Identify Input Purpose):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("is not vacuous: finds the site's e-mail inputs", () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => /\.test\./.test(f))).toBe(false);
    expect(emailInputs.length).toBeGreaterThanOrEqual(2);

    const where = emailInputs.map(({ file }) => relative(ROOT, file));
    expect(where).toContain("src/components/story/correction-form.tsx");
    expect(where).toContain("src/components/newsletter/newsletter-form.tsx");
  });

  describe("the guard itself works", () => {
    const passing = `
      <form>
        <input
          id="a"
          name="email"
          type="email"
          autoComplete="email"
          onChange={(e) => setValue(e.target.value)}
          className="w-full"
        />
        <input type="text" name="website" autoComplete="off" />
      </form>
    `;
    const failing = `
      <form>
        <input type="text" name="website" autoComplete="off" />
        <input
          id="a"
          name="email"
          type="email"
          maxLength={254}
          autoComplete="off"
          onChange={(e) => setValue(e.target.value)}
        />
      </form>
    `;

    it("slices each multi-line opening tag up to its own closing />", () => {
      const tags = inputTags(passing);
      expect(tags).toHaveLength(2);
      // The `=>` inside onChange must not end the tag early.
      expect(tags[0]!.tag).toContain("onChange");
      expect(tags[0]!.tag.endsWith("/>")).toBe(true);
      // ...and the first tag must not swallow its neighbour.
      expect(tags[0]!.tag).not.toContain("website");
      expect(tags[1]!.tag).toContain('name="website"');
    });

    it("reports the 1-based line of the <input", () => {
      const tags = inputTags(failing);
      expect(tags.map((t) => t.line)).toEqual([3, 4]);
    });

    it("accepts a multi-line e-mail input that has autoComplete=\"email\"", () => {
      const email = inputTags(passing).filter(({ tag }) => isEmailInput(tag));
      expect(email).toHaveLength(1);
      expect(hasEmailPurpose(email[0]!.tag)).toBe(true);
    });

    it("rejects an e-mail input without autoComplete=\"email\"", () => {
      const email = inputTags(failing).filter(({ tag }) => isEmailInput(tag));
      expect(email).toHaveLength(1);
      expect(hasEmailPurpose(email[0]!.tag)).toBe(false);
    });

    it("treats non-e-mail inputs as out of scope", () => {
      expect(isEmailInput('<input type="text" name="website" />')).toBe(false);
      expect(isEmailInput('<input type="url" />')).toBe(false);
      expect(isEmailInput('<input name="email" />')).toBe(false);
    });

    it("recognises the quote and brace spellings, and the <Input> wrapper", () => {
      const braced = `<Input type={"email"} autoComplete={'email'} />`;
      const [only] = inputTags(braced);
      expect(only).toBeDefined();
      expect(isEmailInput(only!.tag)).toBe(true);
      expect(hasEmailPurpose(only!.tag)).toBe(true);
      expect(isEmailInput("<input type='email' />")).toBe(true);
    });

    it("does not mistake a longer component name for an <input>", () => {
      expect(inputTags('<InputGroup type="email" />')).toEqual([]);
    });
  });
});
