import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";
import { ALLOWED_RPCS, ALLOWED_RPC_ARGS, ALLOWED_RPC_IDENTITIES, ALLOWED_RPC_MIGRATION } from "../_helpers/anon-rpc-allowlist";

// ---------------------------------------------------------------------------
// Permanent CI guard (db-1, anon surface): the public anon key reaches data
// ONLY through four bounded SECURITY DEFINER RPCs (migration 116), and
// migration 117 removed every anon/authenticated table + sequence grant. Per-
// migration revokes slipped before (091/095 left SELECT alone and the 6
// sequences born afterwards leaked), so the control is this file:
//
//   (1) migrations >= 116: no grant to anon/authenticated/public except the
//       four allowlisted `grant execute on function` lines; no default-
//       privilege grant; every SECURITY DEFINER function revokes anon;
//   (2) the browser Supabase client is imported by exactly the two /saved
//       files, and they use no `.from(` and no RPC but saved_clusters,
//       saved_clusters_v2 (124, the same lookup plus is_blindspot),
//       saved_clusters_v3 (158, v2 plus first_published) or
//       saved_clusters_v4 (192, v3 plus effective_article_count);
//   (3) the anon key is read by exactly browser.ts and the two edge gates,
//       and the gates only ever call the allowlisted RPCs;
//   (4) non-vacuity: the scan sees 116 + 117 (+ 118 when present), and the
//       violation finders are mutation-tested against synthetic bad SQL.
//
// SQL is scanned with comments removed by a small lexer that respects
// strings and dollar-quoted bodies, so a `--` inside a literal cannot hide a
// grant and prose in a comment cannot trip the guard. Dynamic SQL inside
// DO blocks (execute 'grant ...') is still seen. TS sources use the same
// blankComments helper as rate-limit-429.test.ts (copied: a test file cannot
// be imported without registering its tests).
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(here, "../..");
const SRC = resolve(ROOT, "src");
const MIGRATIONS = resolve(ROOT, "supabase", "migrations");

const FIRST_GUARDED_MIGRATION = 116;

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `name ( argument types )` of one allowlisted RPC: the exact signature, never just the name. */
function allowedSignature(name: (typeof ALLOWED_RPCS)[number]): string {
  return `${name}\\s*\\(\\s*${escapeRegExp(ALLOWED_RPC_ARGS[name])}\\s*\\)`;
}

// The allowlist is by full identity: an overload of an allowlisted name (another argument list)
// is a different function, and PUBLIC still gets EXECUTE on every new function (117).
const ALLOWED_GRANT = new RegExp(
  `^grant\\s+execute\\s+on\\s+function\\s+public\\.(?:${ALLOWED_RPCS.map(allowedSignature).join("|")})\\s+to\\s+anon\\s*,\\s*service_role$`,
  "i",
);

const BROWSER_CLIENT_IMPORTERS = new Set([
  "src/components/bookmark/saved-list.tsx",
  "src/components/bookmark/bookmark-snapshots.ts",
]);
const ANON_KEY_READERS = new Set([
  "src/lib/supabase/browser.ts",
  "src/lib/seo/merged-cluster-gate.ts",
  "src/lib/seo/source-slug-gate.ts",
]);
const GATE_FILES = ["src/lib/seo/merged-cluster-gate.ts", "src/lib/seo/source-slug-gate.ts"] as const;

// -- TS helpers --------------------------------------------------------------

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) =>
      p1 + " ".repeat(m.length - p1.length),
    );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name === "node_modules" || name === "__tests__") continue;
      out.push(...walk(p));
    } else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.(ts|tsx)$/.test(name)) {
      out.push(p);
    }
  }
  return out;
}

function rel(p: string): string {
  return relative(ROOT, p).split(sep).join("/");
}

/** Resolved repo-relative targets of every import/require/dynamic import. */
function importTargets(file: string, code: string): string[] {
  const targets: string[] = [];
  const re = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
  for (const m of code.matchAll(re)) {
    const spec = m[1]!;
    let abs: string | null = null;
    if (spec.startsWith("@/")) abs = resolve(SRC, spec.slice(2));
    else if (spec.startsWith(".")) abs = resolve(dirname(file), spec);
    if (abs) targets.push(rel(abs).replace(/\.(ts|tsx)$/, ""));
  }
  return targets;
}

// -- SQL helpers -------------------------------------------------------------

const DOLLAR_OPEN = /^\$([A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/;

/**
 * Removes `--` and (nested) block comments. Strings and quoted identifiers are
 * copied verbatim; dollar-quoted bodies are copied but their inner comments are
 * stripped recursively (a plpgsql comment is still a comment, a string is not).
 */
function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      let end = sql.indexOf("\n", i);
      if (end === -1) end = n;
      out += " ".repeat(end - i);
      i = end;
    } else if (ch === "/" && sql[i + 1] === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (sql.startsWith("/*", j)) {
          depth++;
          j += 2;
        } else if (sql.startsWith("*/", j)) {
          depth--;
          j += 2;
        } else j++;
      }
      out += sql.slice(i, j).replace(/[^\n]/g, " ");
      i = j;
    } else if (ch === "'") {
      const prev = sql[i - 1] ?? "";
      const escapes = /[eE]/.test(prev) && !/[A-Za-z0-9_]/.test(sql[i - 2] ?? "");
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === "\\") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          j++;
          break;
        }
        j++;
      }
      out += sql.slice(i, j);
      i = j;
    } else if (ch === '"') {
      let j = i + 1;
      while (j < n && !(sql[j] === '"' && sql[j + 1] !== '"')) j += sql[j] === '"' ? 2 : 1;
      j = Math.min(j + 1, n);
      out += sql.slice(i, j);
      i = j;
    } else if (ch === "$" && !/[A-Za-z0-9_$]/.test(sql[i - 1] ?? "")) {
      const open = DOLLAR_OPEN.exec(sql.slice(i, i + 80));
      if (!open) {
        out += ch;
        i++;
        continue;
      }
      const tag = open[0];
      const close = sql.indexOf(tag, i + tag.length);
      const innerEnd = close === -1 ? n : close;
      out += tag + stripSqlComments(sql.slice(i + tag.length, innerEnd));
      if (close !== -1) out += tag;
      i = close === -1 ? n : close + tag.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Top-level statements of comment-free SQL (`;` inside strings/bodies is kept). */
function topLevelStatements(code: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i]!;
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (code[j] === ch) {
          if (code[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      i = j + 1;
    } else if (ch === "$" && !/[A-Za-z0-9_$]/.test(code[i - 1] ?? "")) {
      const open = DOLLAR_OPEN.exec(code.slice(i, i + 80));
      if (!open) {
        i++;
        continue;
      }
      const close = code.indexOf(open[0], i + open[0].length);
      i = close === -1 ? n : close + open[0].length;
    } else if (ch === ";") {
      out.push(code.slice(start, i).trim());
      start = i + 1;
      i++;
    } else i++;
  }
  const tail = code.slice(start).trim();
  if (tail) out.push(tail);
  return out.filter(Boolean);
}

const PUBLICLY_REACHABLE = new Set(["anon", "authenticated", "public"]);

/** Grants (static or dynamic) that reach anon/authenticated/public and are not allowlisted. */
function findForbiddenGrants(sqlCode: string): string[] {
  const bad: string[] = [];
  for (const piece of sqlCode.split(";")) {
    const stmt = piece.replace(/\s+/g, " ").trim();
    const m = /\bgrant\b[\s\S]*?\bto\b([\s\S]*)$/i.exec(stmt);
    if (!m) continue;
    const roles = m[1]!.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    if (!roles.some((r) => PUBLICLY_REACHABLE.has(r))) continue;
    if (ALLOWED_GRANT.test(stmt)) continue;
    bad.push(stmt);
  }
  return bad;
}

/** `alter default privileges ... grant ... to anon|authenticated|public`. */
function findDefaultPrivilegeGrants(sqlCode: string): string[] {
  const bad: string[] = [];
  for (const piece of sqlCode.split(";")) {
    const stmt = piece.replace(/\s+/g, " ").trim();
    const m = /\balter\s+default\s+privileges\b[\s\S]*?\bgrant\b[\s\S]*?\bto\b([\s\S]*)$/i.exec(stmt);
    if (!m) continue;
    const roles = m[1]!.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
    if (roles.some((r) => PUBLICLY_REACHABLE.has(r))) bad.push(stmt);
  }
  return bad;
}

// -- SECURITY DEFINER identities ----------------------------------------------
//
// findUnrevokedDefiners used to match a definer to its revoke by NAME, so an
// unrevoked overload beside a revoked sibling (`f(text)` revoked, `f(text, boolean)`
// created without a revoke) passed, although PUBLIC gets EXECUTE on every new
// function (117). It now compares IDENTITIES, `name(type,type)`, with the types
// spelled the way pg's oidvectortypes prints them (the spelling ALLOWED_RPC_ARGS
// uses). The scan is a character scanner that tracks quotes, parens and brackets;
// no regex runs over the SQL text beyond single-character class tests.

/** Aliases (lower-case, modifiers already stripped) -> the spelling oidvectortypes prints. */
const TYPE_ALIASES: Readonly<Record<string, string>> = {
  int: "integer",
  int4: "integer",
  int8: "bigint",
  int2: "smallint",
  bool: "boolean",
  timestamptz: "timestamp with time zone",
  timestamp: "timestamp without time zone",
  timetz: "time with time zone",
  time: "time without time zone",
  varchar: "character varying",
  "char varying": "character varying",
  char: "character",
  bpchar: "character",
  float8: "double precision",
  float: "double precision",
  float4: "real",
  decimal: "numeric",
};

const isWordChar = (ch: string): boolean => /[A-Za-z0-9_$\u0080-￿]/.test(ch);
const isSpace = (ch: string): boolean => /\s/.test(ch);

/** Index of the quote that closes the quoted run opening at `open` (a doubled quote escapes). */
function skipQuoted(s: string, open: number): number {
  const q = s[open];
  let j = open + 1;
  while (j < s.length) {
    if (s[j] === q) {
      if (s[j + 1] === q) {
        j += 2;
        continue;
      }
      return j;
    }
    j++;
  }
  return s.length - 1;
}

/** Index of the `)` closing the `(` at `open`, or -1. Quoted runs are skipped, parens nest. */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') i = skipQuoted(s, i);
    else if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Splits on `sep` where parens and brackets are balanced and no quote is open. */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') i = skipQuoted(s, i);
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (ch === sep && depth === 0) {
      parts.push(s.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(s.slice(start));
  return parts;
}

/** The bare words of `s` at paren depth 0 outside quotes, lower-cased, with their offsets. */
function topLevelWords(s: string): Array<{ word: string; start: number; end: number }> {
  const out: Array<{ word: string; start: number; end: number }> = [];
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === "'" || ch === '"') i = skipQuoted(s, i);
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && isWordChar(ch)) {
      let j = i;
      while (j < s.length && isWordChar(s[j]!)) j++;
      out.push({ word: s.slice(i, j).toLowerCase(), start: i, end: j });
      i = j - 1;
    }
  }
  return out;
}

/** End offset of `word` (a whole word, any case) at or after `pos` past whitespace, or -1. */
function eatWord(s: string, pos: number, word: string): number {
  let i = pos;
  while (i < s.length && isSpace(s[i]!)) i++;
  if (s.slice(i, i + word.length).toLowerCase() !== word) return -1;
  const end = i + word.length;
  return end < s.length && isWordChar(s[end]!) ? -1 : end;
}

/** A function as written in SQL: the name and, when an argument list is given, its raw arguments. */
interface FunctionRef {
  name: string;
  args: string[] | null;
}

/**
 * Reads `[public.]name [( args )]` at `pos`. Null for another schema, a malformed name or
 * unbalanced parens. A bare name is lower-cased, a quoted one is kept verbatim.
 */
function readFunctionRef(s: string, pos: number): FunctionRef | null {
  let i = pos;
  const readIdent = (): string | null => {
    while (i < s.length && isSpace(s[i]!)) i++;
    if (s[i] === '"') {
      const close = skipQuoted(s, i);
      const text = s.slice(i + 1, close).split('""').join('"');
      i = close + 1;
      return text;
    }
    let j = i;
    while (j < s.length && isWordChar(s[j]!)) j++;
    if (j === i) return null;
    const text = s.slice(i, j).toLowerCase();
    i = j;
    return text;
  };
  let name = readIdent();
  if (name === null) return null;
  while (i < s.length && isSpace(s[i]!)) i++;
  if (s[i] === ".") {
    i++;
    if (name !== "public") return null;
    name = readIdent();
    if (name === null) return null;
  }
  while (i < s.length && isSpace(s[i]!)) i++;
  if (s[i] !== "(") return { name, args: null };
  const close = matchParen(s, i);
  if (close === -1) return null;
  const inner = s.slice(i + 1, close);
  return { name, args: inner.trim() === "" ? [] : splitTop(inner, ",") };
}

/** Cuts an argument at its top-level `default` keyword or `=`. */
function stripArgDefault(arg: string): string {
  let depth = 0;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i]!;
    if (ch === "'" || ch === '"') i = skipQuoted(arg, i);
    else if (ch === "(" || ch === "[") depth++;
    else if (ch === ")" || ch === "]") depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === "=") return arg.slice(0, i);
    else if (
      depth === 0 &&
      (ch === "d" || ch === "D") &&
      arg.slice(i, i + 7).toLowerCase() === "default" &&
      (i === 0 || !isWordChar(arg[i - 1]!)) &&
      !isWordChar(arg[i + 7] ?? " ")
    ) {
      return arg.slice(0, i);
    }
  }
  return arg;
}

/** Words of an argument: type modifiers `(10,2)` dropped, `[ ]` dimensions glued to their word as `[]`. */
function argWords(arg: string): string[] {
  const words: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur) words.push(cur);
    cur = "";
  };
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i]!;
    if (ch === '"') {
      const close = skipQuoted(arg, i);
      cur += arg.slice(i + 1, close).split('""').join('"');
      i = close;
    } else if (ch === "(") {
      const close = matchParen(arg, i);
      i = close === -1 ? arg.length : close;
    } else if (ch === "[") {
      const close = arg.indexOf("]", i);
      i = close === -1 ? arg.length : close;
      if (cur) cur += "[]";
      else if (words.length > 0) words[words.length - 1] += "[]";
    } else if (isSpace(ch)) flush();
    else cur += ch.toLowerCase();
  }
  flush();
  return words;
}

/** True when the words begin with a type spelled in several words (so no argument name precedes it). */
function startsWithMultiWordType(words: readonly string[]): boolean {
  const [a, b, c] = words;
  if (a === "double" && b === "precision") return true;
  if ((a === "character" || a === "char" || a === "bit") && b === "varying") return true;
  return (a === "timestamp" || a === "time") && (b === "with" || b === "without") && c === "time";
}

/**
 * The identity type of one argument, or null for an OUT argument (it is not part of the
 * identity). Drops the mode, the argument name, the default and the type modifiers,
 * removes the pg_catalog. / public. qualifier and maps aliases to oidvectortypes' spelling.
 */
function argIdentityType(rawArg: string): string | null {
  const words = argWords(stripArgDefault(rawArg));
  const last = words[words.length - 1];
  if (words.length > 1 && (last === "array" || last === "array[]")) {
    words.pop();
    words[words.length - 1] += "[]";
  }
  if (words.length > 1 && ["in", "out", "inout", "variadic"].includes(words[0]!)) {
    if (words.shift() === "out") return null;
  }
  if (words.length > 1 && !startsWithMultiWordType(words)) words.shift(); // the argument name
  if (words.length === 0) return null;
  let type = words.join(" ");
  for (const qualifier of ["pg_catalog.", "public."]) {
    if (type.startsWith(qualifier)) type = type.slice(qualifier.length);
  }
  const dims = type.indexOf("[");
  const base = dims === -1 ? type : type.slice(0, dims);
  return (TYPE_ALIASES[base] ?? base) + (dims === -1 ? "" : type.slice(dims));
}

/** `name(type,type)` of a function reference that carries an argument list. */
function identityOf(ref: FunctionRef): string | null {
  if (ref.args === null) return null;
  const types: string[] = [];
  for (const arg of ref.args) {
    const type = argIdentityType(arg);
    if (type !== null) types.push(type);
  }
  return `${ref.name}(${types.join(",")})`;
}

interface DefinerFunction {
  name: string;
  identity: string;
  /** Index (in topLevelStatements order) of the last statement that creates it. */
  at: number;
}

/**
 * Every SECURITY DEFINER function in public that the (comment-free) SQL creates, as identity + name,
 * in order of first creation. `at` is the LAST creating statement: a redefinition (or a drop + create)
 * can reset the ACL, so only a revoke after it counts.
 */
function definerFunctions(sqlCode: string): DefinerFunction[] {
  const out = new Map<string, DefinerFunction>();
  for (const [at, raw] of topLevelStatements(sqlCode).entries()) {
    const s = raw.replace(/\s+/g, " ");
    if (!/\bsecurity definer\b/i.test(s)) continue;
    let pos = eatWord(s, 0, "create");
    if (pos === -1) continue;
    const orReplace = eatWord(s, pos, "or");
    if (orReplace !== -1) {
      pos = eatWord(s, orReplace, "replace");
      if (pos === -1) continue;
    }
    pos = eatWord(s, pos, "function");
    if (pos === -1) continue;
    const ref = readFunctionRef(s, pos);
    const identity = ref ? identityOf(ref) : null;
    if (ref && identity !== null) out.set(identity, { name: ref.name, identity, at });
  }
  return [...out.values()];
}

/** The identities (`name(type,type)`) of the SECURITY DEFINER functions in public that the SQL creates. */
function definerIdentities(sqlCode: string): string[] {
  return definerFunctions(sqlCode).map((f) => f.identity);
}

interface FunctionRevoke {
  roles: string[];
  /** `on all functions in schema public` */
  allInPublic: boolean;
  refs: FunctionRef[];
}

/** A `revoke ... on function a(...), b(...) from roles` or `on all functions in schema ...` statement. */
function readFunctionRevoke(statement: string): FunctionRevoke | null {
  const words = topLevelWords(statement);
  if (words[0]?.word !== "revoke") return null;
  const on = words.findIndex((w) => w.word === "on");
  if (on === -1) return null;
  const from = words.findIndex((w, k) => k > on && w.word === "from");
  if (from === -1) return null;
  const roles = statement.slice(words[from]!.end).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
  const target = words[on + 1];
  if (!target) return null;
  if (target.word === "all") {
    const kind = words[on + 2]?.word;
    if (kind !== "functions" && kind !== "routines") return null;
    const schemas = statement.slice(words[on + 2]!.end, words[from]!.start).toLowerCase().split(/[^a-z0-9_]+/);
    return { roles, allInPublic: schemas.includes("public"), refs: [] };
  }
  if (target.word !== "function" && target.word !== "routine") return null;
  const refs: FunctionRef[] = [];
  for (const part of splitTop(statement.slice(target.end, words[from]!.start), ",")) {
    const ref = readFunctionRef(part, 0);
    if (ref) refs.push(ref);
  }
  return { roles, allInPublic: false, refs };
}

/**
 * Identities (`name(type,type)`) of the SECURITY DEFINER functions in public with no
 * `revoke ... on function public.name(types) ... from public, anon` for that exact signature
 * (or an argument-less `on function public.name`, or `on all functions in schema public`)
 * AFTER the statement that creates the function.
 *
 * Both parts of the rule come from how PostgreSQL grants EXECUTE:
 * - every new function carries EXECUTE for PUBLIC (117 only closed the anon/authenticated
 *   default ACLs), so a revoke from anon alone leaves anon able to call it through PUBLIC;
 * - a revoke only changes the ACL of functions that exist when it runs (`on all functions`
 *   touches the existing ones only), and a drop + create starts from the default ACL again,
 *   so a revoke that precedes the create does not protect it.
 */
function findUnrevokedDefiners(sqlCode: string): string[] {
  const definers = definerFunctions(sqlCode);
  if (definers.length === 0) return [];
  const revokes: Array<{ at: number; allInPublic: boolean; identities: Set<string>; names: Set<string> }> = [];
  for (const [at, raw] of topLevelStatements(sqlCode).entries()) {
    const revoke = readFunctionRevoke(raw.replace(/\s+/g, " "));
    if (!revoke || !revoke.roles.includes("anon") || !revoke.roles.includes("public")) continue;
    const identities = new Set<string>();
    const names = new Set<string>();
    for (const ref of revoke.refs) {
      const identity = identityOf(ref);
      if (identity === null) names.add(ref.name);
      else identities.add(identity);
    }
    revokes.push({ at, allInPublic: revoke.allInPublic, identities, names });
  }
  return definers
    .filter(
      (f) =>
        !revokes.some(
          (r) => r.at > f.at && (r.allInPublic || r.identities.has(f.identity) || r.names.has(f.name)),
        ),
    )
    .map((f) => f.identity);
}

interface GuardedMigration {
  file: string;
  num: number;
  code: string;
}

function guardedMigrations(): GuardedMigration[] {
  return readdirSync(MIGRATIONS)
    .filter((f) => /^\d{3}_.*\.sql$/.test(f))
    .map((f) => ({ file: f, num: Number(f.slice(0, 3)) }))
    .filter((f) => f.num >= FIRST_GUARDED_MIGRATION)
    .map((f) => ({
      ...f,
      code: stripSqlComments(readFileSync(join(MIGRATIONS, f.file), "utf8")),
    }));
}

// -- (1) migrations ---------------------------------------------------------

describe("anon surface: migrations >= 116", () => {
  const migrations = guardedMigrations();

  it("scans a non-vacuous set (116, 117 and, when present, 118)", () => {
    const nums = migrations.map((m) => m.num);
    expect(nums).toContain(116);
    expect(nums).toContain(117);
    expect(migrations.length).toBeGreaterThanOrEqual(nums.includes(118) ? 3 : 2);
  });

  for (const m of migrations) {
    describe(m.file, () => {
      it("grants nothing to anon/authenticated/public except the four allowlisted RPC executes", () => {
        expect(findForbiddenGrants(m.code)).toEqual([]);
      });

      it("never grants through default privileges", () => {
        expect(findDefaultPrivilegeGrants(m.code)).toEqual([]);
      });

      it("revokes anon on every SECURITY DEFINER function it defines", () => {
        expect(findUnrevokedDefiners(m.code)).toEqual([]);
      });
    });
  }

  it("each allowlisted RPC is granted execute to anon, service_role by its own migration (the allowlist is real, not dead code)", () => {
    for (const name of ALLOWED_RPCS) {
      const num = ALLOWED_RPC_MIGRATION[name];
      const mig = migrations.find((m) => m.num === num);
      expect(mig, `migration ${num} (for ${name}) must exist`).toBeDefined();
      expect(mig!.code, `${name} in ${mig!.file}`).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${allowedSignature(name)}\\s+to\\s+anon\\s*,\\s*service_role\\s*;`, "i"),
      );
    }
  });
});

// -- (2) browser client importers -------------------------------------------

describe("anon surface: browser Supabase client", () => {
  const files = walk(SRC);

  it("is imported only by the two /saved files", () => {
    const target = "src/lib/supabase/browser";
    const importers = files
      .filter((f) => importTargets(f, blankComments(readFileSync(f, "utf8"))).includes(target))
      .map(rel)
      .sort();
    for (const f of importers) {
      expect(BROWSER_CLIENT_IMPORTERS.has(f), `${f} must not import ${target}`).toBe(true);
    }
    // Non-vacuous: the allowlist is exactly what exists.
    expect(importers).toEqual([...BROWSER_CLIENT_IMPORTERS].sort());
  });

  for (const f of BROWSER_CLIENT_IMPORTERS) {
    it(`${f} uses no .from( and no RPC but saved_clusters / saved_clusters_v2 / saved_clusters_v3 / saved_clusters_v4`, () => {
      const code = blankComments(readFileSync(resolve(ROOT, f), "utf8"));
      // Array.from(...) is not a PostgREST table call.
      expect(code.match(/(?<!Array)\.from\s*\(/g) ?? []).toEqual([]);
      const rpcs = Array.from(code.matchAll(/\.rpc\s*\(\s*([^,)\s]*)/g), (m) => m[1]);
      expect(rpcs.length).toBeGreaterThan(0);
      for (const arg of rpcs) expect(arg).toMatch(/^["']saved_clusters(_v2|_v3|_v4)?["']$/);
      // No other Supabase surface (storage buckets, edge functions, auth) either.
      expect(code).not.toMatch(/\.(?:storage|functions|auth)\s*\./);
    });
  }
});

// -- (3) anon key readers ----------------------------------------------------

describe("anon surface: anon key", () => {
  const files = walk(SRC);
  const KEY = /SUPABASE_(?:ANON|PUBLISHABLE)_KEY/;

  it("is read only by browser.ts and the two edge gates", () => {
    const readers = files
      .filter((f) => KEY.test(blankComments(readFileSync(f, "utf8"))))
      .map(rel)
      .sort();
    for (const f of readers) {
      expect(ANON_KEY_READERS.has(f), `${f} must not read the anon key`).toBe(true);
    }
    expect(readers).toEqual([...ANON_KEY_READERS].sort());
  });

  for (const f of GATE_FILES) {
    it(`${f}: every /rest/v1/ call is an allowlisted rpc`, () => {
      const code = blankComments(readFileSync(resolve(ROOT, f), "utf8"));
      const hits = Array.from(code.matchAll(/\/rest\/v1\//g));
      expect(hits.length).toBeGreaterThan(0);
      for (const h of hits) {
        const after = code.slice(h.index! + h[0].length, h.index! + h[0].length + 64);
        expect(after, `${f}: ${after}`).toMatch(/^rpc\/(?:merged_cluster_map|source_slugs|source_slug_exists)\b/);
      }
    });
  }

  it("browser.ts exists and only builds the shared client (no table or RPC calls of its own)", () => {
    const p = resolve(ROOT, "src/lib/supabase/browser.ts");
    expect(existsSync(p)).toBe(true);
    const code = blankComments(readFileSync(p, "utf8"));
    expect(code).not.toMatch(/(?<!Array)\.from\s*\(/);
    expect(code).not.toMatch(/\.rpc\s*\(/);
  });
});

// -- (4) the finders really catch violations (mutation tests) ----------------

describe("anon surface: the guard fails on a bad migration", () => {
  const bad = (sql: string) => findForbiddenGrants(stripSqlComments(sql));

  it("flags table, sequence, schema-wide and function grants to anon/authenticated/public", () => {
    expect(bad("grant select on public.clusters to anon;")).toHaveLength(1);
    expect(bad("grant select on public.clusters to service_role, authenticated;")).toHaveLength(1);
    expect(bad("grant usage on sequence public.s_seq to anon;")).toHaveLength(1);
    expect(bad("grant select on all tables in schema public to public;")).toHaveLength(1);
    expect(bad('grant execute on function public.foo() to "anon";')).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters(uuid[]) to anon, authenticated, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.other_fn() to anon, service_role;")).toHaveLength(1);
  });

  it("flags a grant on an overload of an allowlisted name: the allowlist is by full signature", () => {
    expect(bad("grant execute on function public.source_slug_exists(text, boolean) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters(text) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters(uuid[], boolean) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters_v2(text[]) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters_v3(text[]) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters_v3(uuid[], boolean) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters_v4(text[]) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.saved_clusters_v4(uuid[], boolean) to anon, service_role;")).toHaveLength(1);
    // a v5 is not allowlisted until someone adds it to tests/_helpers/anon-rpc-allowlist.ts on purpose
    expect(bad("grant execute on function public.saved_clusters_v5(uuid[]) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.merged_cluster_map(integer) to anon, service_role;")).toHaveLength(1);
    expect(bad("grant execute on function public.source_slugs(text) to anon, service_role;")).toHaveLength(1);
    // an argument list that merely starts like the allowlisted one is not it
    expect(bad("grant execute on function public.source_slug_exists(text, text) to anon, service_role;")).toHaveLength(1);
  });

  it("accepts every allowlisted identity exactly (the helper spells the signatures the migrations use)", () => {
    expect(ALLOWED_RPC_IDENTITIES).toEqual([
      "saved_clusters(uuid[])",
      "merged_cluster_map()",
      "source_slugs()",
      "source_slug_exists(text)",
      "saved_clusters_v2(uuid[])",
      "saved_clusters_v3(uuid[])",
      "saved_clusters_v4(uuid[])",
    ]);
    for (const identity of ALLOWED_RPC_IDENTITIES) {
      expect(bad(`grant execute on function public.${identity} to anon, service_role;`), identity).toEqual([]);
    }
    expect(bad("grant execute on function public.saved_clusters ( uuid[] ) to anon , service_role;")).toEqual([]);
  });

  it("flags dynamic SQL and a grant hidden behind a '--' inside a string literal", () => {
    expect(bad("do $$ begin execute 'grant select on public.x to anon'; end $$;")).toHaveLength(1);
    expect(bad("select '--'; grant select on public.x to anon;")).toHaveLength(1);
    expect(bad("do $f$ begin -- grant select on public.x to anon\n null; end $f$;")).toEqual([]);
  });

  it("accepts the allowlisted grants and service_role-only grants", () => {
    expect(bad("grant execute on function public.saved_clusters(uuid[]) to anon, service_role;")).toEqual([]);
    expect(bad("grant execute on function public.source_slug_exists(text) to anon, service_role;")).toEqual([]);
    expect(bad("grant select on public.t to service_role;")).toEqual([]);
    expect(bad("revoke all on public.t from anon, authenticated, public;")).toEqual([]);
    expect(bad("-- grant select on public.t to anon;\nselect 1;")).toEqual([]);
  });

  it("flags default-privilege grants but not default-privilege revokes", () => {
    const f = (s: string) => findDefaultPrivilegeGrants(stripSqlComments(s));
    expect(f("alter default privileges for role postgres in schema public grant select on tables to anon;")).toHaveLength(1);
    expect(f("alter default privileges in schema public grant all on sequences to authenticated, service_role;")).toHaveLength(1);
    expect(f("alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;")).toEqual([]);
  });

  it("flags a SECURITY DEFINER function with no anon revoke, accepts one with it", () => {
    const fn = (attrs: string) =>
      `create or replace function public.leak() returns int language sql ${attrs} as $fn$ select 1; $fn$;`;
    const f = (s: string) => findUnrevokedDefiners(stripSqlComments(s));
    expect(f(fn("security definer set search_path = ''"))).toEqual(["leak()"]);
    expect(f(fn("stable"))).toEqual([]);
    expect(
      f(fn("security definer") + "\nrevoke all on function public.leak() from public, anon, authenticated;"),
    ).toEqual([]);
    // Attributes after the body are still seen.
    expect(
      f("create function public.late() returns int as $b$ select 1; select 2; $b$ language sql security definer;"),
    ).toEqual(["late()"]);
  });
});

// -- (5) definer revokes are matched by identity, not by name -----------------

describe("anon surface: SECURITY DEFINER revokes are identity-exact", () => {
  const strip = stripSqlComments;
  const unrevoked = (sql: string) => findUnrevokedDefiners(strip(sql));
  const defined = (sql: string) => definerIdentities(strip(sql));
  const def = (name: string, args: string, attrs = "security definer set search_path = ''") =>
    `create or replace function ${name}(${args}) returns int language sql ${attrs} as $fn$ select 1; $fn$;\n`;
  const revoke = (list: string, roles = "public, anon, authenticated") =>
    `revoke all on function ${list} from ${roles};\n`;

  it("an unrevoked overload beside a revoked sibling is reported by its identity", () => {
    const sql = def("public.f", "text") + def("public.f", "text, boolean") + revoke("public.f(text)");
    expect(unrevoked(sql)).toEqual(["f(text,boolean)"]);
    // and the other way round
    expect(unrevoked(def("public.f", "text") + def("public.f", "text, boolean") + revoke("public.f(text, boolean)"))).toEqual([
      "f(text)",
    ]);
  });

  it("is empty once every overload is revoked, whatever the spacing and the schema qualifier", () => {
    const sql = def("public.f", "text") + def("f", "text, boolean") + revoke("public.f(text)") + revoke("f ( text ,boolean )");
    expect(unrevoked(sql)).toEqual([]);
  });

  it("a revoke for another name or without anon revokes nothing", () => {
    expect(unrevoked(def("public.f", "text") + revoke("public.g(text)"))).toEqual(["f(text)"]);
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", "public, authenticated"))).toEqual(["f(text)"]);
    expect(unrevoked(def("public.f", "text") + "revoke all on public.f from anon;")).toEqual(["f(text)"]);
    // a quoted role name is still the role
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", '"public", "anon"'))).toEqual([]);
  });

  it("a revoke from anon without PUBLIC leaves the definer executable (PUBLIC EXECUTE is the default on every new function)", () => {
    // revoking from anon alone does not remove the PUBLIC grant anon inherits (117 closed only the anon/authenticated default ACLs)
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", "anon"))).toEqual(["f(text)"]);
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", '"anon"'))).toEqual(["f(text)"]);
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", "anon, authenticated"))).toEqual(["f(text)"]);
    // a same-name function without an argument list is the same gap
    expect(unrevoked(def("public.f", "text") + "revoke all on function public.f from anon;")).toEqual(["f(text)"]);
    // PUBLIC and anon together revoke it, with or without authenticated
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", "public, anon"))).toEqual([]);
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", "anon, public"))).toEqual([]);
    // PUBLIC without anon is not enough either
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)", "public"))).toEqual(["f(text)"]);
  });

  it("canonicalises the type aliases the way pg oidvectortypes prints them", () => {
    const cases: Array<[string, string]> = [
      ["int", "integer"],
      ["int4", "integer"],
      ["int8", "bigint"],
      ["int2", "smallint"],
      ["bool", "boolean"],
      ["timestamptz", "timestamp with time zone"],
      ["timestamp", "timestamp without time zone"],
      ["varchar", "character varying"],
      ["varchar(10)", "character varying"],
      ["float8", "double precision"],
      ["float4", "real"],
      ["decimal(12, 4)", "numeric"],
      ["timetz", "time with time zone"],
      ["time", "time without time zone"],
      ["int[]", "integer[]"],
      ["timestamptz []", "timestamp with time zone[]"],
      ["pg_catalog.int4", "integer"],
      ["public.citext", "citext"],
    ];
    for (const [alias, canonical] of cases) {
      expect(defined(def("public.a", alias)), alias).toEqual([`a(${canonical})`]);
      expect(unrevoked(def("public.a", alias) + revoke(`public.a(${canonical})`)), `${alias} vs ${canonical}`).toEqual([]);
      expect(unrevoked(def("public.a", canonical) + revoke(`public.a(${alias})`)), `${canonical} vs ${alias}`).toEqual([]);
    }
    // the two spellings the task calls out, in one statement each
    expect(unrevoked(def("public.a", "p_n int, p_at timestamptz") + revoke("public.a(integer, timestamp with time zone)"))).toEqual([]);
    expect(unrevoked(def("public.a", "integer, timestamp with time zone") + revoke("public.a(int, timestamptz)"))).toEqual([]);
  });

  it("different types are different identities (integer is not bigint, text[] is not text)", () => {
    expect(unrevoked(def("public.a", "int") + revoke("public.a(bigint)"))).toEqual(["a(integer)"]);
    expect(unrevoked(def("public.a", "text[]") + revoke("public.a(text)"))).toEqual(["a(text[])"]);
    expect(unrevoked(def("public.a", "uuid[]") + revoke("public.a(uuid)"))).toEqual(["a(uuid[])"]);
    expect(unrevoked(def("public.a", "") + revoke("public.a(text)"))).toEqual(["a()"]);
  });

  it("reads multi-word types, with and without an argument name", () => {
    expect(defined(def("public.m", "double precision"))).toEqual(["m(double precision)"]);
    expect(defined(def("public.m", "p_x double precision, p_y character varying(20)"))).toEqual([
      "m(double precision,character varying)",
    ]);
    expect(defined(def("public.m", "timestamp with time zone, timestamp without time zone"))).toEqual([
      "m(timestamp with time zone,timestamp without time zone)",
    ]);
    expect(defined(def("public.m", "p_t time with time zone, p_u time(3) without time zone"))).toEqual([
      "m(time with time zone,time without time zone)",
    ]);
    expect(defined(def("public.m", "p_b bit varying(8), char varying"))).toEqual(["m(bit varying,character varying)"]);
    expect(defined(def("public.m", "p_name character"))).toEqual(["m(character)"]);
  });

  it("a multi-function revoke list covers each function it names, and only those", () => {
    const sql = def("public.a", "") + def("public.b", "text") + def("public.c", "uuid[]");
    expect(unrevoked(sql + revoke("public.a(), public.b(text), public.c(uuid[])"))).toEqual([]);
    expect(unrevoked(sql + revoke("public.a(),\n  public.b(text)"))).toEqual(["c(uuid[])"]);
    expect(unrevoked(sql + revoke("public.a(), public.b(text, text), public.c(uuid[])"))).toEqual(["b(text)"]);
    // two statements work as well as one list
    expect(unrevoked(sql + revoke("public.a()") + revoke("public.b(text), public.c(uuid[])", "public, anon"))).toEqual([]);
  });

  it("copes with nested parens, type modifiers and defaults that hold commas, parens and quotes", () => {
    const args =
      "p_amt numeric(10,2) default 0, p_tags text[] default '{}'::text[], p_cfg jsonb default '{\"a\": (1, 2)}', " +
      "p_note text = 'it''s, (fine)', p_at timestamp(3) with time zone default now()";
    expect(defined(def("public.g", args))).toEqual(["g(numeric,text[],jsonb,text,timestamp with time zone)"]);
    expect(
      unrevoked(def("public.g", args) + revoke("public.g(numeric, text[], jsonb, text, timestamptz)")),
    ).toEqual([]);
    // a default can use an array constructor and a cast with brackets
    expect(defined(def("public.g", "p_ids uuid[] default array[]::uuid[], p_n int default (1 + 2)"))).toEqual([
      "g(uuid[],integer)",
    ]);
  });

  it("ignores OUT arguments, keeps IN / INOUT / VARIADIC ones, and strips argument names", () => {
    const args = "IN p_a text, OUT o_b int, INOUT p_c boolean, VARIADIC p_d text[], out o_e uuid";
    expect(defined(def("public.h", args))).toEqual(["h(text,boolean,text[])"]);
    expect(unrevoked(def("public.h", args) + revoke("public.h(text, boolean, text[])"))).toEqual([]);
    // returns table (...) columns are not arguments
    expect(
      defined(
        "create function public.t(p_a text) returns table (x int, y text) language sql security definer as $f$ select 1, 'a' $f$;",
      ),
    ).toEqual(["t(text)"]);
    // an argument list of OUT parameters only is the empty identity
    expect(defined(def("public.o", "OUT a int, OUT b text"))).toEqual(["o()"]);
  });

  it("handles quoted function and argument names", () => {
    expect(defined(def('public."leak"', '"p arg" text, "Other" int'))).toEqual(["leak(text,integer)"]);
    expect(unrevoked(def('public."leak"', "text") + revoke("public.leak(text)"))).toEqual([]);
    expect(unrevoked(def("public.leak", "text") + revoke('public."leak"(text)'))).toEqual([]);
    expect(unrevoked(def('public."leak"', "text"))).toEqual(["leak(text)"]);
    // a ',' or ')' inside a quoted argument name does not split the list
    expect(defined(def("public.q", '"a,b)" text, c int'))).toEqual(["q(text,integer)"]);
  });

  it("`revoke ... on all functions in schema public` covers the functions created before it, another schema does not", () => {
    const sql = def("public.a", "") + def("public.b", "text, boolean");
    expect(unrevoked(sql + "revoke all on all functions in schema public from public, anon, authenticated;")).toEqual([]);
    expect(unrevoked(sql + "revoke execute on all functions in schema public, extensions from public, anon;")).toEqual([]);
    expect(unrevoked(sql + "revoke all on all functions in schema extensions from public, anon;")).toEqual(["a()", "b(text,boolean)"]);
    expect(unrevoked(sql + "revoke all on all functions in schema public from authenticated;")).toEqual(["a()", "b(text,boolean)"]);
    expect(unrevoked(sql + "grant execute on all functions in schema public to anon;")).toEqual(["a()", "b(text,boolean)"]);
    // the blanket form needs PUBLIC as well as anon, like the per-function form
    expect(unrevoked(sql + "revoke all on all functions in schema public from anon;")).toEqual(["a()", "b(text,boolean)"]);
    expect(unrevoked(sql + "revoke all on all functions in schema public from public;")).toEqual(["a()", "b(text,boolean)"]);
  });

  it("an all-functions revoke does not cover a definer created after it (it only touches functions that exist when it runs)", () => {
    const blanket = "revoke all on all functions in schema public from public, anon, authenticated;\n";
    // the leak: the blanket revoke runs first, the definer is created afterwards and gets the default PUBLIC EXECUTE
    expect(unrevoked(blanket + def("public.leak", ""))).toEqual(["leak()"]);
    const plain =
      "create function public.leak(p_a text) returns int language sql security definer set search_path = '' as $fn$ select 1; $fn$;\n";
    expect(unrevoked(blanket + plain)).toEqual(["leak(text)"]);
    // functions before the revoke are covered, the one after it is not
    expect(unrevoked(def("public.a", "") + blanket + def("public.b", "text"))).toEqual(["b(text)"]);
    // a second blanket revoke after the last create covers everything
    expect(unrevoked(def("public.a", "") + blanket + def("public.b", "text") + blanket)).toEqual([]);
    // the same statement without the earlier blanket revoke is the unrevoked case
    expect(unrevoked(def("public.leak", ""))).toEqual(["leak()"]);
  });

  it("a per-function revoke only covers the definer when it comes after the statement that creates it", () => {
    // a revoke that precedes the create (the function would not exist yet) does not protect the new function
    expect(unrevoked(revoke("public.f(text)") + def("public.f", "text"))).toEqual(["f(text)"]);
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)"))).toEqual([]);
    // drop + create after an earlier revoke resets the ACL: the earlier revoke no longer counts
    const recreated =
      def("public.f", "text") + revoke("public.f(text)") + "drop function public.f(text);\n" + def("public.f", "text");
    expect(unrevoked(recreated)).toEqual(["f(text)"]);
    expect(unrevoked(recreated + revoke("public.f(text)"))).toEqual([]);
    // a redefinition after the revoke needs a fresh revoke; the guard is conservative here
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)") + def("public.f", "text"))).toEqual(["f(text)"]);
    // an argument-less revoke is positional too
    expect(unrevoked("revoke all on function public.f from public, anon;\n" + def("public.f", "text"))).toEqual(["f(text)"]);
    expect(unrevoked(def("public.f", "text") + "revoke all on function public.f from public, anon;\n")).toEqual([]);
    // one overload revoked before and one created after: only the later one is open
    expect(unrevoked(def("public.f", "text") + revoke("public.f(text)") + def("public.f", "text, boolean"))).toEqual([
      "f(text,boolean)",
    ]);
  });

  it("a revoke that names a function without an argument list covers that name (valid SQL only for a unique name)", () => {
    expect(unrevoked(def("public.f", "text") + "revoke all on function public.f from public, anon;")).toEqual([]);
    expect(unrevoked(def("public.f", "text") + "revoke all on function public.g from anon;")).toEqual(["f(text)"]);
  });

  it("only functions in public count; a function in another schema is not a public definer", () => {
    expect(unrevoked(def("app_private.x", "text"))).toEqual([]);
    expect(unrevoked(def("public.x", "text") + revoke("app_private.x(text)"))).toEqual(["x(text)"]);
  });

  it("a revoke buried in a function body is not a revoke of the migration; attributes after the body are still seen", () => {
    // z revokes itself only when it runs (dynamic SQL in its body): the migration never revokes it
    const buried =
      "create function public.z(p_a text default 'x') returns int as $b$ begin\n" +
      "  execute 'revoke all on function public.z(text) from anon'; return 1; end $b$ language plpgsql security definer;\n";
    expect(defined(buried)).toEqual(["z(text)"]);
    expect(unrevoked(buried)).toEqual(["z(text)"]);
    // the words 'security definer' in a comment of the body make nothing a definer (comments are stripped first)
    const commented =
      "create function public.w(p_a text) returns int as $b$ begin -- security definer? no\n return 1; end $b$ language plpgsql stable;\n";
    expect(defined(commented)).toEqual([]);
    // v carries the attribute after the body and is revoked at the top level
    const after =
      "create function public.v(p_a text) returns int as $b$ select 1 $b$ language sql security definer set search_path = '';\n" +
      revoke("public.v(text)");
    expect(defined(after)).toEqual(["v(text)"]);
    expect(unrevoked(after)).toEqual([]);
  });

  it("reports an identity once even when the migration redefines it", () => {
    const sql = def("public.f", "text") + def("public.f", "text");
    expect(defined(sql)).toEqual(["f(text)"]);
    expect(unrevoked(sql)).toEqual(["f(text)"]);
  });

  it("ignores non-function statements and invoker functions", () => {
    expect(unrevoked("create table public.t(a int); create index on public.t(a);")).toEqual([]);
    expect(unrevoked(def("public.inv", "text", "stable"))).toEqual([]);
    expect(unrevoked(def("public.inv", "text", "security invoker"))).toEqual([]);
  });
});

describe("anon surface: the identity parser agrees with the real migrations", () => {
  const migrations = guardedMigrations();
  // 37 identities in migrations 116-145 on 2026-11-02; the history only grows
  const MIN_REAL_DEFINERS = 30;

  it("reads every allowlisted RPC exactly as ALLOWED_RPC_IDENTITIES spells it, in the migration that defines it", () => {
    for (const name of ALLOWED_RPCS) {
      const mig = migrations.find((m) => m.num === ALLOWED_RPC_MIGRATION[name]);
      expect(mig, name).toBeDefined();
      expect(definerIdentities(mig!.code), `${name} in ${mig!.file}`).toContain(`${name}(${ALLOWED_RPC_ARGS[name]})`);
    }
  });

  it("catches an unrevoked overload appended to a real migration, beside the revoked sibling (mutation test)", () => {
    const m116 = migrations.find((m) => m.num === 116);
    expect(m116).toBeDefined();
    expect(findUnrevokedDefiners(m116!.code)).toEqual([]);
    const overload =
      "\ncreate or replace function public.source_slug_exists(p_slug text, p_strict boolean) returns boolean " +
      "language sql security definer set search_path = '' as $f$ select true $f$;\n";
    expect(findUnrevokedDefiners(m116!.code + overload)).toEqual(["source_slug_exists(text,boolean)"]);
    // the same overload with its own revoke is fine
    const revoked = overload + "revoke all on function public.source_slug_exists(text, boolean) from public, anon, authenticated;\n";
    expect(findUnrevokedDefiners(m116!.code + revoked)).toEqual([]);
  });

  it("sees a non-trivial number of SECURITY DEFINER identities in the real history, all revoked (non-vacuity)", () => {
    const all = migrations.flatMap((m) => definerIdentities(m.code));
    expect(all.length).toBeGreaterThanOrEqual(MIN_REAL_DEFINERS);
    expect(all).toContain("ops_health_report()");
    for (const m of migrations) expect(findUnrevokedDefiners(m.code), m.file).toEqual([]);
  });
});

