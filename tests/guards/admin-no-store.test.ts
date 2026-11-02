import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (W3): every exported method of every /api/admin/**/route.ts
// answers with `Cache-Control: private, no-store`. The admin JSON (API keys, webhook
// secrets, share links, source tables) must not sit in a shared cache or a browser
// history entry, and most of the 20 admin routes set no Cache-Control at all. The
// wrapper (src/lib/api/admin-no-store.ts) sets it on whatever the handler returns;
// a route that exports a method any other way, or wraps it inside withApiErrors
// (so the 500 of a thrown error would miss the header), would quietly drop it.
//
// Per exported method: `export const POST = withAdminNoStore(withApiErrors(...))`
// and an import of withAdminNoStore from "@/lib/api/admin-no-store". No method may
// be exported as a function declaration or through an `export { ... }` list.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_API_DIR = resolve(here, "../../src/app/api/admin");
const WRAPPER_MODULE = "@/lib/api/admin-no-store";
const WRAPPER_FILE = resolve(here, "../../src/lib/api/admin-no-store.ts");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Escapes every RegExp metacharacter so a literal string can be embedded in a pattern. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every `route.ts` under `dir`, at any depth (a `[id]` folder is just a folder). */
function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFiles(full));
    else if (entry.isFile() && entry.name === "route.ts") out.push(full);
  }
  return out.sort();
}

const isIdentifierChar = (ch: string | undefined): boolean => ch !== undefined && /[A-Za-z0-9_$]/.test(ch);

/** The identifier tokens of a piece of text (a character scan, no quantified pattern). */
function identifiers(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of text) {
    if (isIdentifierChar(ch)) current += ch;
    else if (current !== "") {
      out.push(current);
      current = "";
    }
  }
  if (current !== "") out.push(current);
  return out;
}

/** Every identifier named inside an `export { ... }` list (also `export { a as GET }` and re-exports). */
function exportListNames(code: string): string[] {
  const names: string[] = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf("export", from);
    if (at === -1) return names;
    from = at + "export".length;
    if (isIdentifierChar(code[at - 1])) continue; // part of a longer word
    let i = from;
    while (i < code.length && /\s/.test(code[i]!)) i++;
    if (code[i] !== "{") continue;
    const close = code.indexOf("}", i);
    if (close === -1) continue;
    names.push(...identifiers(code.slice(i + 1, close)));
  }
}

/** Number of non-overlapping matches of a global pattern. */
const countMatches = (code: string, re: RegExp): number => (code.match(re) ?? []).length;

/** Which HTTP methods the source exports as `export const <METHOD> ...`. */
function exportedConstMethods(code: string): string[] {
  return METHODS.filter((method) => new RegExp(`export\\s+const\\s+${escapeRegExp(method)}\\b`).test(code));
}

/** Violations of the contract for one admin route source; empty means compliant. */
function violations(source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];

  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\bwithAdminNoStore\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(WRAPPER_MODULE)}["']`,
  );
  if (!importRe.test(code)) out.push(`does not import withAdminNoStore from ${WRAPPER_MODULE}`);

  const listed = exportListNames(code);
  for (const method of METHODS) {
    const declared = countMatches(code, new RegExp(`export\\s+const\\s+${escapeRegExp(method)}\\b`, "g"));
    const wrapped = countMatches(
      code,
      new RegExp(`export\\s+const\\s+${escapeRegExp(method)}\\s*=\\s*withAdminNoStore\\(`, "g"),
    );
    if (declared !== wrapped) out.push(`${method} is exported without withAdminNoStore`);

    const inner = countMatches(
      code,
      new RegExp(`export\\s+const\\s+${escapeRegExp(method)}\\s*=\\s*withAdminNoStore\\(\\s*withApiErrors\\(`, "g"),
    );
    if (wrapped !== inner) out.push(`${method}: withApiErrors is not directly inside withAdminNoStore`);

    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${escapeRegExp(method)}\\b`).test(code)) {
      out.push(`${method} is exported as a function declaration, bypassing the wrapper`);
    }
    if (listed.includes(method)) out.push(`${method} is exported through an export list, bypassing the wrapper`);
  }
  if (/export\s*\*\s*from/.test(code)) out.push("re-exports everything from another module, bypassing the wrapper");
  if (exportedConstMethods(code).length === 0 && !METHODS.some((m) => listed.includes(m))) {
    out.push("exports no HTTP method as `export const <METHOD> = withAdminNoStore(...)`");
  }
  return out;
}

describe("every /api/admin route answers with Cache-Control: private, no-store (W3)", () => {
  const files = routeFiles(ADMIN_API_DIR);

  it("is not vacuous: at least 20 admin route files are found, including the nested and [id] ones", () => {
    expect(files.length).toBeGreaterThanOrEqual(20);
    const relative = files.map((f) => f.slice(ADMIN_API_DIR.length + 1));
    expect(relative).toEqual(
      expect.arrayContaining([
        "route.ts",
        join("api-keys", "route.ts"),
        join("api-keys", "webhook", "route.ts"),
        join("corrections", "[id]", "route.ts"),
        join("jev-unlink", "bulk", "route.ts"),
        join("story-threads", "thread", "route.ts"),
      ]),
    );
  });

  it("is not vacuous: the routes export at least 23 wrapped methods (GET+POST, PATCH+DELETE and POST+DELETE counted)", () => {
    let wrapped = 0;
    for (const file of files) {
      const code = blankComments(readFileSync(file, "utf8"));
      wrapped += countMatches(code, /export\s+const\s+[A-Z]+\s*=\s*withAdminNoStore\(/g);
    }
    expect(wrapped).toBeGreaterThanOrEqual(23);
  });

  it("the wrapper module exists and exports withAdminNoStore and the header value", () => {
    expect(existsSync(WRAPPER_FILE)).toBe(true);
    const code = blankComments(readFileSync(WRAPPER_FILE, "utf8"));
    expect(code).toMatch(/export\s+function\s+withAdminNoStore\b/);
    expect(code).toMatch(/export\s+const\s+ADMIN_CACHE_CONTROL\s*=\s*["']private, no-store["']/);
  });

  for (const file of files) {
    const label = file.slice(ADMIN_API_DIR.length + 1);
    it(`${label}: every exported method is withAdminNoStore(withApiErrors(...)) and the import is there`, () => {
      expect(violations(readFileSync(file, "utf8")), `src/app/api/admin/${label}`).toEqual([]);
    });
  }

  describe("the finder itself (mutation checks on synthetic sources)", () => {
    // Built from lines, so each mutation swaps a whole line (no string-pattern replace).
    const importLine = 'import { withAdminNoStore } from "@/lib/api/admin-no-store";';
    const errorsLine = 'import { withApiErrors } from "@/lib/api/errors";';
    const getLine = 'export const GET = withAdminNoStore(withApiErrors(async () => new Response("ok")));';
    const postLine = 'export const POST = withAdminNoStore(withApiErrors(async (request: Request) => new Response("ok")));';
    const goodLines = [importLine, errorsLine, getLine, postLine];
    const build = (lines: string[]): string => `${lines.join("\n")}\n`;
    const swap = (from: string, to: string[]): string[] => goodLines.flatMap((l) => (l === from ? to : [l]));

    it("accepts a compliant source", () => {
      expect(violations(build(goodLines))).toEqual([]);
    });

    it("accepts a multi-line wrapper like the [id] routes use", () => {
      const lines = swap(postLine, [
        "export const PATCH = withAdminNoStore(",
        "  withApiErrors(",
        "    async (request: Request, ctx: Ctx) => new Response('ok'),",
        "  ),",
        ");",
      ]);
      expect(violations(build(lines))).toEqual([]);
    });

    it("flags a missing import", () => {
      expect(violations(build(goodLines.slice(1)))).toEqual([expect.stringContaining("does not import")]);
    });

    it("flags an import of something else from the wrapper module", () => {
      const lines = swap(importLine, ['import { ADMIN_CACHE_CONTROL } from "@/lib/api/admin-no-store";']);
      expect(violations(build(lines))).toEqual([expect.stringContaining("does not import")]);
    });

    it("flags a bare withApiErrors method", () => {
      const lines = swap(postLine, ['export const POST = withApiErrors(async () => new Response("ok"));']);
      expect(violations(build(lines))).toEqual(["POST is exported without withAdminNoStore"]);
    });

    it("flags a method whose wrapper is only in a comment", () => {
      const lines = swap(postLine, [
        '// export const POST = withAdminNoStore(withApiErrors(async () => new Response("ok")));',
        'export const POST = async () => new Response("ok");',
      ]);
      expect(violations(build(lines))).toEqual(["POST is exported without withAdminNoStore"]);
    });

    it("flags a typed const that bypasses the wrapper", () => {
      const lines = swap(postLine, ["export const POST: Handler = async () => new Response('ok');"]);
      expect(violations(build(lines))).toEqual(["POST is exported without withAdminNoStore"]);
    });

    it("flags withApiErrors on the outside (its 500 would miss the header)", () => {
      const lines = swap(postLine, ['export const POST = withApiErrors(withAdminNoStore(async () => new Response("ok")));']);
      expect(violations(build(lines))).toEqual(["POST is exported without withAdminNoStore"]);
    });

    it("flags a wrapper without withApiErrors directly inside", () => {
      const lines = swap(postLine, ['export const POST = withAdminNoStore(async () => new Response("ok"));']);
      expect(violations(build(lines))).toEqual(["POST: withApiErrors is not directly inside withAdminNoStore"]);
    });

    it("flags an exported async function and a plain function declaration", () => {
      const asyncFn = swap(postLine, ['export async function DELETE() { return new Response("x"); }']);
      expect(violations(build(asyncFn))).toEqual(["DELETE is exported as a function declaration, bypassing the wrapper"]);
      const plainFn = swap(postLine, ['export function PATCH() { return new Response("x"); }']);
      expect(violations(build(plainFn))).toEqual(["PATCH is exported as a function declaration, bypassing the wrapper"]);
    });

    it("flags a method exported through an export list, with or without a rename", () => {
      const renamed = swap(postLine, ["const handler = async () => new Response('x');", "export { handler as PUT };"]);
      expect(violations(build(renamed))).toEqual(["PUT is exported through an export list, bypassing the wrapper"]);
      const plain = swap(postLine, ["const HEAD = async () => new Response('x');", "export { HEAD };"]);
      expect(violations(build(plain))).toEqual(["HEAD is exported through an export list, bypassing the wrapper"]);
      const reexport = swap(postLine, ['export { OPTIONS } from "./elsewhere";']);
      expect(violations(build(reexport))).toEqual(["OPTIONS is exported through an export list, bypassing the wrapper"]);
    });

    it("flags a re-export of everything", () => {
      const lines = swap(postLine, ['export * from "./elsewhere";']);
      expect(violations(build(lines))).toEqual([expect.stringContaining("re-exports everything")]);
    });

    it("flags every method of the list when none is wrapped", () => {
      const lines = swap(getLine, ['export const PUT = async () => new Response("x");']);
      expect(violations(build(lines))).toEqual(["PUT is exported without withAdminNoStore"]);
    });

    it("flags a file that exports no HTTP method at all", () => {
      expect(violations(build([importLine, errorsLine, "export const dynamic = 'force-dynamic';"]))).toEqual([
        expect.stringContaining("exports no HTTP method"),
      ]);
    });

    it("does not mistake a longer name or a non-method export for a method", () => {
      const lines = [...goodLines, "export const GETTER = 1;", "export const dynamic = 'force-dynamic';", "const exported = { GET: 1 };"];
      expect(violations(build(lines))).toEqual([]);
    });
  });
});
