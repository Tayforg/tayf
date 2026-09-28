import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 085 ("ticker code gate": audit fix
// A / db-platform). See the migration's own header for the Step-0 evidence
// (S9/S10 per-ticker and per-alias tables) this file's assertions encode.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "085_ticker_code_gate.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create or replace function public.<name>(...) ... $$ ... $$;` block. */
function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

function header(block: string): string {
  const idx = block.search(/\bas\s+\$\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$\$([\s\S]*?)\$\$/);
  if (!m || m[1] === undefined) throw new Error("no $$ body");
  return m[1];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("migration 085_ticker_code_gate.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn085 = "";
  let fn062 = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn085 = functionBlock(code, "resolve_article_tickers_for");
    fn062 = functionBlock(
      stripComments(read(resolve(MIGRATIONS_DIR, "062_coverage_semantics_and_context.sql"))),
      "resolve_article_tickers_for",
    );
  });

  it("contains the ledger insert for '085' and is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'085'\s*,\s*'085_ticker_code_gate'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("the resolver header equals 062's after whitespace normalisation", () => {
    expect(norm(header(fn085))).toBe(norm(header(fn062)));
  });

  it("removing the three-line gate from 085's body leaves 062's body exactly (normalised, comments stripped)", () => {
    const gate =
      /\s*where\s+c\.ticker\s*<>\s*all\s*\(\s*public\.ticker_code_stoplist\(\)\s*\)\s*or\s+r\.category\s*=\s*'ekonomi'\s*or\s+pg_catalog\.strpos\(\s*r\.raw\s*,\s*'\('\s*\|\|\s*c\.ticker\s*\|\|\s*'\)'\s*\)\s*>\s*0\s*/i;
    const stripped = body(fn085).replace(gate, "\n  ");
    expect(norm(stripped)).toBe(norm(body(fn062)));
  });

  it("the stoplist gate is present in code_hits and scoped to c.ticker (the code-match join)", () => {
    const b = body(fn085);
    expect(b).toMatch(
      /where\s+c\.ticker\s*<>\s*all\s*\(\s*public\.ticker_code_stoplist\(\)\s*\)\s*or\s+r\.category\s*=\s*'ekonomi'\s*or\s+pg_catalog\.strpos\(\s*r\.raw\s*,\s*'\('\s*\|\|\s*c\.ticker\s*\|\|\s*'\)'\s*\)\s*>\s*0/i,
    );
  });

  it("the stoplist function is immutable, returns text[], and contains DEVA, BEYAZ, ATLAS and KONYA -- every entry matches /^[A-Z]{4,6}$/", () => {
    const block = functionBlock(code, "ticker_code_stoplist");
    const h = header(block);
    expect(h).toMatch(/\bimmutable\b/i);
    expect(h).toMatch(/returns\s+text\[\]/i);
    const b = body(block);
    const arrayMatch = b.match(/array\[([^\]]+)\]/i);
    expect(arrayMatch).not.toBeNull();
    const entries = arrayMatch![1]
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(entries).toEqual(expect.arrayContaining(["DEVA", "BEYAZ", "ATLAS", "KONYA"]));
    for (const e of entries) {
      expect(e).toMatch(/^[A-Z]{4,6}$/);
    }
  });

  it("the revoke and grant on ticker_code_stoplist are present", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ticker_code_stoplist\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.ticker_code_stoplist\(\)\s+to\s+service_role\s*;/i,
    );
  });

  it("every 'delete from' targets public.article_tickers only", () => {
    const deleteTargets = [...code.matchAll(/delete\s+from\s+([a-z_][\w.]*)/gi)].map((m) =>
      m[1].toLowerCase(),
    );
    expect(deleteTargets.length).toBe(2);
    for (const t of deleteTargets) {
      expect(t).toBe("public.article_tickers");
    }
  });

  it("the code delete is scoped to matched_on = 'code' and the stoplist", () => {
    const m = code.match(/delete\s+from\s+public\.article_tickers\s+t\s+using\s+public\.articles[\s\S]*?;/i);
    expect(m).not.toBeNull();
    const stmt = m![0];
    expect(stmt).toMatch(/t\.matched_on\s*=\s*'code'/i);
    expect(stmt).toMatch(/t\.ticker\s*=\s*any\s*\(\s*public\.ticker_code_stoplist\(\)\s*\)/i);
  });

  it("the alias delete is scoped to the listed aliases", () => {
    const m = code.match(/delete\s+from\s+public\.article_tickers\s+t\s+using\s+public\.bist_aliases[\s\S]*?;/i);
    expect(m).not.toBeNull();
    const stmt = m![0];
    expect(stmt).toMatch(/t\.matched_on\s*=\s*'alias:'\s*\|\|\s*al\.alias/i);
    expect(stmt).toMatch(/not\s+al\.enabled/i);
    expect(stmt).toMatch(/al\.alias\s+in\s*\(\s*'dinamik'\s*,\s*'goldman'\s*\)/i);
  });

  it("the only update is enabled = false on bist_aliases, disabling dinamik and goldman", () => {
    const updates = [...code.matchAll(/update\s+([a-z_][\w.]*)/gi)].map((m) => m[1].toLowerCase());
    expect(updates.length).toBe(1);
    expect(updates[0]).toBe("public.bist_aliases");
    expect(code).toMatch(
      /update\s+public\.bist_aliases\s+set\s+enabled\s*=\s*false\s+where\s+enabled\s+and\s+alias\s+in\s*\(\s*'dinamik'\s*,\s*'goldman'\s*\)/i,
    );
  });

  it("no drop, truncate or alter table", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
  });
});
