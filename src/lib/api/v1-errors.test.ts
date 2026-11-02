import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { V1_ERROR, V1_ERROR_ROWS } from "@/lib/api/v1-errors";

// ---------------------------------------------------------------------------
// The /gelistirici "Hatalar" table is rendered from V1_ERROR_ROWS. These tests
// keep that catalog honest in both directions against the code that actually
// emits errors on the keyed API:
//   (a) the catalog is well-formed;
//   (b) every error string the v1 code can send is covered by the row for its
//       status (the docs cannot omit a message the API sends);
//   (c) every catalog message is really emitted (the docs cannot promise one
//       the API never sends).
// The v1 route files keep their literals (an error string is read in place);
// this guard is what stops them drifting from the page.
//
// Scanning uses small non-nested regexes to find a call site and a character
// scan to read the literal, never a regex over the string body.
// ---------------------------------------------------------------------------

const ROOT = process.cwd();
const V1_ROUTES_DIR = path.join(ROOT, "src/app/api/v1");
const API_LIB_DIR = path.join(ROOT, "src/lib/api");
const KEYS_FILE = path.join(API_LIB_DIR, "keys.ts");
const ERRORS_FILE = path.join(API_LIB_DIR, "errors.ts");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/** The files whose error strings the catalog must cover. Never tests, never the catalog itself. */
function scannedFiles(): string[] {
  const routes = walk(V1_ROUTES_DIR).filter((f) => path.basename(f) === "route.ts");
  const libs = readdirSync(API_LIB_DIR)
    .filter((n) => /^v1-[a-z-]+\.ts$/.test(n) && !n.endsWith(".test.ts") && n !== "v1-errors.ts")
    .map((n) => path.join(API_LIB_DIR, n));
  return [...routes, ...libs, KEYS_FILE].sort();
}

interface Emitted {
  status: number;
  message: string;
  where: string;
}

const QUOTES = ['"', "'", "`"];

/**
 * Reads the argument that starts at `start` (after the opening parenthesis or
 * the colon of `error:`). A string literal gives its text (a template literal
 * gives its prefix up to the first ':'; one that opens with an interpolation
 * gives ""); `V1_ERROR.<key>` gives the constant's value; anything else
 * (an identifier, a member access) is dynamic and gives null.
 */
function readArgument(code: string, start: number): string | null {
  let i = start;
  while (i < code.length && /\s/.test(code[i]!)) i += 1;
  const open = code[i]!;
  if (QUOTES.includes(open)) {
    let text = "";
    for (let j = i + 1; j < code.length; j += 1) {
      const ch = code[j]!;
      if (ch === "\\") {
        text += code[j + 1] ?? "";
        j += 1;
        continue;
      }
      if (open === "`" && ch === "$" && code[j + 1] === "{") {
        // Interpolation: only the text before it is stable.
        return open === "`" ? text.split(":")[0]! : text;
      }
      if (ch === open) {
        return open === "`" ? text.split(":")[0]! : text;
      }
      text += ch;
    }
    return null;
  }
  const constant = /^V1_ERROR\.([A-Za-z]+)/.exec(code.slice(i, i + 60));
  if (constant) {
    const value = (V1_ERROR as Record<string, string>)[constant[1]!];
    return value ?? null;
  }
  return null;
}

function lineOf(code: string, index: number): number {
  return code.slice(0, index).split("\n").length;
}

function scanEmitted(file: string, source: string): Emitted[] {
  const code = blankComments(source);
  const where = path.relative(ROOT, file);
  const out: Emitted[] = [];

  const byHelper: Array<[RegExp, number]> = [
    [/\bapiBadRequest\(/g, 400],
    [/\bapiNotFound\(/g, 404],
    [/\bapiUnauthorized\(/g, 401],
    // A validator result `{ error: "..." }` is handed to apiBadRequest.
    [/\berror:/g, 400],
  ];
  for (const [re, status] of byHelper) {
    for (const m of code.matchAll(re)) {
      const message = readArgument(code, m.index + m[0].length);
      if (message !== null) out.push({ status, message, where: `${where}:${lineOf(code, m.index)}` });
    }
  }
  for (const m of code.matchAll(/\bapiError\(\s*(\d{3})\s*,/g)) {
    const message = readArgument(code, m.index + m[0].length);
    if (message !== null) {
      out.push({ status: Number(m[1]), message, where: `${where}:${lineOf(code, m.index)}` });
    }
  }
  return out;
}

const EMITTED: Emitted[] = scannedFiles().flatMap((f) => scanEmitted(f, readFileSync(f, "utf8")));

const covers = (catalogMessage: string, emitted: string): boolean =>
  emitted === catalogMessage || emitted.startsWith(`${catalogMessage}:`);

describe("V1_ERROR_ROWS shape", () => {
  it("lists statuses in strictly ascending order", () => {
    const statuses = V1_ERROR_ROWS.map((r) => r.status);
    expect(statuses.length).toBeGreaterThan(0);
    for (let i = 1; i < statuses.length; i += 1) {
      expect(statuses[i]!, `row ${i}`).toBeGreaterThan(statuses[i - 1]!);
    }
  });

  it("gives every row at least one message and a Turkish meaning", () => {
    for (const row of V1_ERROR_ROWS) {
      expect(row.messages.length, `${row.status} has no message`).toBeGreaterThan(0);
      for (const message of row.messages) expect(message.trim().length).toBeGreaterThan(0);
      expect(row.meaningTr.trim().length, `${row.status} has no meaning`).toBeGreaterThan(0);
      // Turkish copy: the meaning is a sentence, not a copy of the English wire text.
      expect(row.messages).not.toContain(row.meaningTr);
    }
  });

  it("has no duplicate message across rows", () => {
    const all = V1_ERROR_ROWS.flatMap((r) => [...r.messages]);
    expect(new Set(all).size).toBe(all.length);
  });

  it("keeps the wire strings of the shared constants verbatim", () => {
    expect(V1_ERROR).toEqual({
      missingKey: "Missing or invalid API key",
      keyRevoked: "API key revoked",
      tooManyRequests: "Too many requests",
      dailyLimit: "Daily limit exceeded",
      methodNotAllowed: "Method not allowed",
      notFound: "Not found",
      internal: "Internal server error",
    });
  });
});

describe("V1_ERROR_ROWS against the code that emits errors", () => {
  it("scans a plausible set of call sites (not vacuous)", () => {
    const messages = EMITTED.map((e) => `${e.status} ${e.message}`);
    for (const known of [
      "301 Cluster merged",
      "400 Invalid cursor",
      "400 Invalid format",
      "400 Invalid cluster id",
      "400 Invalid slug",
      "400 Invalid ticker",
      "400 Invalid since",
      "400 Invalid limit",
      "401 Missing or invalid API key",
      "403 API key revoked",
      "404 Cluster not found",
      "404 Source not found",
      "404 Not found",
      "405 Method not allowed",
    ]) {
      // A validator message ("Invalid since: must be ...") counts by its prefix.
      expect(
        messages.some((m) => m === known || m.startsWith(`${known}:`)),
        known,
      ).toBe(true);
    }
    expect(EMITTED.length).toBeGreaterThanOrEqual(14);
  });

  it("covers every emitted error string with the row for its status", () => {
    const uncovered: string[] = [];
    for (const e of EMITTED) {
      const row = V1_ERROR_ROWS.find((r) => r.status === e.status);
      const ok = row !== undefined && row.messages.some((m) => covers(m, e.message));
      if (!ok) uncovered.push(`${e.where}: ${e.status} "${e.message}"`);
    }
    expect(uncovered, "add the message to the row for its status in src/lib/api/v1-errors.ts").toEqual([]);
  });

  it("catalogues every V1_ERROR constant keys.ts references", () => {
    const keys = blankComments(readFileSync(KEYS_FILE, "utf8"));
    const referenced = [...keys.matchAll(/\bV1_ERROR\.([A-Za-z]+)/g)].map((m) => m[1]!);
    expect(referenced.length).toBeGreaterThan(0);
    const catalogued = new Set(V1_ERROR_ROWS.flatMap((r) => [...r.messages]));
    for (const name of referenced) {
      const value = (V1_ERROR as Record<string, string>)[name];
      expect(value, `V1_ERROR.${name} does not exist`).toBeDefined();
      expect(catalogued.has(value!), `V1_ERROR.${name} is not in V1_ERROR_ROWS`).toBe(true);
    }
  });

  it("only catalogues messages that are really emitted (the reverse direction)", () => {
    const keys = blankComments(readFileSync(KEYS_FILE, "utf8"));
    const fromKeys = new Set(
      [...keys.matchAll(/\bV1_ERROR\.([A-Za-z]+)/g)].map(
        (m) => (V1_ERROR as Record<string, string>)[m[1]!],
      ),
    );
    // 500 comes from the shared apiServerError helper in errors.ts, which the
    // keyed routes call; scan that one file for the 500 literal too.
    const errorsSrc = readFileSync(ERRORS_FILE, "utf8");
    const fromHelper = scanEmitted(ERRORS_FILE, errorsSrc).filter((e) => e.status === 500);
    expect(fromHelper.map((e) => e.message)).toContain(V1_ERROR.internal);

    const unemitted: string[] = [];
    for (const row of V1_ERROR_ROWS) {
      for (const message of row.messages) {
        const viaConstant = fromKeys.has(message);
        const viaLiteral = EMITTED.some((e) => e.status === row.status && covers(message, e.message));
        const viaHelper = fromHelper.some((e) => e.status === row.status && covers(message, e.message));
        if (!viaConstant && !viaLiteral && !viaHelper) unemitted.push(`${row.status} "${message}"`);
      }
    }
    expect(unemitted, "catalogued but never emitted").toEqual([]);
  });

  it("the scanner reads the shapes it is meant to (mutation check)", () => {
    const sample = [
      'return apiBadRequest("Invalid thing");',
      "return apiNotFound(`Gone: ${id}`);",
      'return apiError(\n  409,\n  "Conflict",\n);',
      'return { error: `Invalid limit: must be 1..${MAX}` };',
      "return apiUnauthorized(V1_ERROR.missingKey);",
      "return apiBadRequest(parsed.error);",
      '// apiBadRequest("in a comment")',
    ].join("\n");
    const found = scanEmitted(path.join(ROOT, "sample.ts"), sample).map(
      (e) => `${e.status} ${e.message}`,
    );
    expect(found.sort()).toEqual(
      ["400 Invalid limit", "400 Invalid thing", "401 Missing or invalid API key", "404 Gone", "409 Conflict"].sort(),
    );
  });
});
