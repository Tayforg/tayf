import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative, sep } from "node:path";

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
//       files, and they use no `.from(` and no RPC but saved_clusters;
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

const ALLOWED_RPCS = ["saved_clusters", "merged_cluster_map", "source_slugs", "source_slug_exists"] as const;
const ALLOWED_GRANT = new RegExp(
  `^grant\\s+execute\\s+on\\s+function\\s+public\\.(${ALLOWED_RPCS.join("|")})\\s*\\([^)]*\\)\\s+to\\s+anon\\s*,\\s*service_role$`,
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

/** SECURITY DEFINER functions in public with no `revoke ... on function public.X ... from ... anon`. */
function findUnrevokedDefiners(sqlCode: string): string[] {
  const statements = topLevelStatements(sqlCode).map((s) => s.replace(/\s+/g, " "));
  const definers: string[] = [];
  for (const s of statements) {
    const m = /^create (?:or replace )?function (?:public\.)?"?([a-z0-9_]+)"? ?\(/i.exec(s);
    if (m && /\bsecurity definer\b/i.test(s)) definers.push(m[1]!.toLowerCase());
  }
  const missing: string[] = [];
  for (const name of definers) {
    const revoke = new RegExp(
      `^revoke\\b[\\s\\S]*?\\bon function (?:public\\.)?"?${name}"? ?\\([^)]*\\)[\\s\\S]*?\\bfrom\\b[\\s\\S]*\\banon\\b`,
      "i",
    );
    if (!statements.some((s) => revoke.test(s))) missing.push(name);
  }
  return missing;
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

  it("116 grants execute on each allowlisted RPC to anon (the allowlist is real, not dead code)", () => {
    const m116 = migrations.find((m) => m.num === 116)!;
    for (const name of ALLOWED_RPCS) {
      expect(m116.code).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\([^)]*\\)\\s+to\\s+anon\\s*,\\s*service_role\\s*;`, "i"),
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
    it(`${f} uses no .from( and no RPC but saved_clusters`, () => {
      const code = blankComments(readFileSync(resolve(ROOT, f), "utf8"));
      // Array.from(...) is not a PostgREST table call.
      expect(code.match(/(?<!Array)\.from\s*\(/g) ?? []).toEqual([]);
      const rpcs = Array.from(code.matchAll(/\.rpc\s*\(\s*([^,)\s]*)/g), (m) => m[1]);
      expect(rpcs.length).toBeGreaterThan(0);
      for (const arg of rpcs) expect(arg).toMatch(/^["']saved_clusters["']$/);
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
    expect(f(fn("security definer set search_path = ''"))).toEqual(["leak"]);
    expect(f(fn("stable"))).toEqual([]);
    expect(
      f(fn("security definer") + "\nrevoke all on function public.leak() from public, anon, authenticated;"),
    ).toEqual([]);
    // Attributes after the body are still seen.
    expect(
      f("create function public.late() returns int as $b$ select 1; select 2; $b$ language sql security definer;"),
    ).toEqual(["late"]);
  });
});
