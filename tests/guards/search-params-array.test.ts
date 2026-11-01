import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

// Next hands a page `string[]` for a repeated query parameter
// (/?q=seçim&q=erdoğan), not just `string`. A page that types a searchParams
// property as plain `string` compiles fine, then calls string methods on an
// array at request time: /?q=a&q=b used to throw `qRaw?.trim is not a
// function` inside the cached home page and served a blank page with an RSC
// error digest. TypeScript only catches that when the declared type includes
// `string[]`, so every searchParams property a page declares must.
//
// Scans src/app/**/page.tsx for `searchParams: Promise<{ ... }>` (an inline
// object type, a same-file type alias / interface, or Record<K, V>).

const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "src", "app");

/**
 * Properties that may stay a plain `string`, keyed by page path relative to
 * src/app (posix separators).
 *
 * TRACKED FOLLOW-UP, not a blessing: oyun/page.tsx declares
 * `{ mod?: string; gun?: string | string[] }`. It only ever compares
 * `sp.mod === "gunluk"` (no string method), so a repeated ?mod= does not
 * crash; it silently falls back to the Bölge mode. Widen the type to
 * `string | string[]` and delete this entry; the staleness test below fails
 * if the entry outlives the problem.
 */
const ALLOWED_PLAIN_STRING: Readonly<Record<string, readonly string[]>> = {
  "oyun/page.tsx": ["mod"],
};

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pageFiles(full));
    else if (name === "page.tsx") out.push(full);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

interface Prop {
  name: string;
  type: string;
}

/** Index of the delimiter closing the one opened at `open`, or -1. */
function matching(code: string, open: number): number {
  const pairs: Record<string, string> = { "{": "}", "<": ">", "(": ")", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < code.length; i++) {
    const ch = code[i] as string;
    if (ch === "=" && code[i + 1] === ">") {
      i++; // arrow, not a closing angle bracket
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch] as string);
    else if (stack.length && ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/** Splits an object-type body on top-level `;` / `,` / newline-free members. */
function splitMembers(body: string): string[] {
  const members: string[] = [];
  const opens = "{<([";
  const closes = "}>)]";
  let depth = 0;
  let cur = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i] as string;
    if (ch === "=" && body[i + 1] === ">") {
      cur += "=>";
      i++;
      continue;
    }
    if (opens.includes(ch)) depth++;
    else if (closes.includes(ch)) depth--;
    if ((ch === ";" || ch === ",") && depth === 0) {
      members.push(cur);
      cur = "";
    } else cur += ch;
  }
  members.push(cur);
  return members.map((m) => m.trim()).filter(Boolean);
}

function parseObjectBody(body: string): Prop[] | null {
  const props: Prop[] = [];
  for (const member of splitMembers(body)) {
    const m = /^(?:readonly\s+)?(['"]?)([\w$-]+)\1\s*\??\s*:\s*([\s\S]+)$/.exec(member);
    if (!m) return null;
    props.push({ name: m[2] as string, type: (m[3] as string).trim() });
  }
  return props;
}

type Resolved = { props: Prop[] } | { error: string };

/** Resolves the type argument of `Promise<...>` to a property list. */
function resolveArg(arg: string, code: string): Resolved {
  const a = arg.trim();
  if (a.startsWith("{")) {
    const props = parseObjectBody(a.slice(1, -1));
    return props ? { props } : { error: `cannot parse members of ${a}` };
  }
  const rec = /^Record\s*<([\s\S]*)>$/.exec(a);
  if (rec) {
    const parts = splitMembers((rec[1] as string).replace(/,/g, ";"));
    return parts.length === 2
      ? { props: [{ name: "*", type: parts[1] as string }] }
      : { error: `cannot parse ${a}` };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(a)) {
    const alias = new RegExp(
      `(?:type\\s+${a}\\s*=\\s*|interface\\s+${a}\\s*)\\{`,
    ).exec(code);
    if (!alias) return { error: `cannot resolve type ${a} in the same file` };
    const open = alias.index + alias[0].length - 1;
    const close = matching(code, open);
    if (close < 0) return { error: `unbalanced braces in ${a}` };
    return resolveArg(code.slice(open, close + 1), code);
  }
  return { error: `unsupported searchParams type ${a}` };
}

interface Decl {
  props: Prop[];
  error?: string;
}

/** Every `searchParams: Promise<...>` declaration in a source file. */
function findDecls(src: string): Decl[] {
  const code = stripComments(src);
  const decls: Decl[] = [];
  for (const m of code.matchAll(/\bsearchParams\s*:\s*Promise\s*</g)) {
    const open = (m.index ?? 0) + m[0].length - 1;
    const close = matching(code, open);
    if (close < 0) {
      decls.push({ props: [], error: "unbalanced Promise<...>" });
      continue;
    }
    const resolved = resolveArg(code.slice(open + 1, close), code);
    decls.push("error" in resolved ? { props: [], error: resolved.error } : resolved);
  }
  return decls;
}

const ARRAY_TYPE = /\bstring\s*\[\s*\]|\b(?:Readonly)?Array\s*<\s*string\s*>/;

/** Human-readable problems of one source file (allowlist applied by the caller). */
function violationsOf(src: string): { prop: string; problem: string }[] {
  const out: { prop: string; problem: string }[] = [];
  for (const d of findDecls(src)) {
    if (d.error) out.push({ prop: "?", problem: d.error });
    for (const p of d.props) {
      if (!ARRAY_TYPE.test(p.type)) {
        out.push({ prop: p.name, problem: `${p.name}: ${p.type}` });
      }
    }
  }
  return out;
}

const pages = pageFiles(APP).map((file) => ({
  rel: relative(APP, file).split(sep).join("/"),
  src: readFileSync(file, "utf8"),
}));

function remaining(rel: string, src: string) {
  const allowed = ALLOWED_PLAIN_STRING[rel] ?? [];
  return violationsOf(src)
    .filter((v) => !allowed.includes(v.prop))
    .map((v) => `${rel}: ${v.problem}`);
}

describe("searchParams accept repeated parameters (string[])", () => {
  it("every searchParams property in src/app/**/page.tsx includes string[]", () => {
    const problems = pages.flatMap((p) => remaining(p.rel, p.src));
    expect(problems).toEqual([]);
  });

  it("is not vacuous: finds the declarations that exist today", () => {
    const decls = pages.flatMap((p) => findDecls(p.src));
    expect(decls.length).toBeGreaterThanOrEqual(4);
    expect(decls.filter((d) => d.error)).toEqual([]);
    // The home page is the one that crashed; it must be among them.
    const home = pages.find((p) => p.rel === "page.tsx");
    expect(home).toBeDefined();
    const names = findDecls(home?.src ?? "").flatMap((d) =>
      d.props.map((p) => p.name),
    );
    expect(names).toEqual(expect.arrayContaining(["q", "page"]));
  });

  it("allowlist has no stale entries: each names a property still typed as plain string", () => {
    for (const [rel, names] of Object.entries(ALLOWED_PLAIN_STRING)) {
      const page = pages.find((p) => p.rel === rel);
      expect(page, `${rel} no longer exists, drop it from the allowlist`).toBeDefined();
      const flagged = violationsOf(page?.src ?? "").map((v) => v.prop);
      for (const name of names) {
        expect(
          flagged,
          `${rel}: ${name} now accepts string[], drop it from the allowlist`,
        ).toContain(name);
      }
    }
  });

  it("allowlist is exactly the tracked oyun follow-up", () => {
    expect(ALLOWED_PLAIN_STRING).toEqual({ "oyun/page.tsx": ["mod"] });
  });
});

describe("search-params checker (self-test)", () => {
  it("fails on a plain-string property", () => {
    const src = `export default function P({ searchParams }: { searchParams: Promise<{ q?: string }> }) {}`;
    expect(violationsOf(src)).toEqual([{ prop: "q", problem: "q: string" }]);
  });

  it("fails only the offending property of a mixed declaration", () => {
    const src = `searchParams: Promise<{ mod?: string; gun?: string | string[] }>;`;
    expect(violationsOf(src).map((v) => v.prop)).toEqual(["mod"]);
  });

  it("passes string | string[] and Array<string>", () => {
    expect(
      violationsOf(
        `searchParams: Promise<{ q?: string | string[]; page?: Array<string> | string }>`,
      ),
    ).toEqual([]);
  });

  it("reads multi-line declarations", () => {
    const src = `
      searchParams: Promise<{
        a?: string;
        b?: string | string[];
      }>;`;
    expect(violationsOf(src).map((v) => v.prop)).toEqual(["a"]);
  });

  it("resolves a same-file type alias and interface", () => {
    expect(
      violationsOf(
        `type SP = { a?: string | string[]; b?: string };\nsearchParams: Promise<SP>`,
      ).map((v) => v.prop),
    ).toEqual(["b"]);
    expect(
      violationsOf(
        `interface SP { a?: string }\nsearchParams: Promise<SP>`,
      ).map((v) => v.prop),
    ).toEqual(["a"]);
  });

  it("checks the value type of Record<string, ...>", () => {
    expect(
      violationsOf(`searchParams: Promise<Record<string, string | undefined>>`),
    ).toHaveLength(1);
    expect(
      violationsOf(
        `searchParams: Promise<Record<string, string | string[] | undefined>>`,
      ),
    ).toEqual([]);
  });

  it("reports an unresolvable type instead of passing silently", () => {
    expect(violationsOf(`searchParams: Promise<ImportedParams>`)).toHaveLength(1);
  });

  it("ignores commented-out declarations", () => {
    expect(violationsOf(`// searchParams: Promise<{ q?: string }>`)).toEqual([]);
  });

  it("finds nothing in a file without searchParams", () => {
    expect(findDecls(`export default function P() { return null; }`)).toEqual([]);
  });
});
