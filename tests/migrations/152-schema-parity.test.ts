import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { WRITABLE_SOURCE_BIAS } from "@/lib/validation/source-input";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 152 ("schema_parity"), hunt-26 W1.
//
// Production carries objects no migration declares: sources.tradition and
// sources.source_type (with their CHECKs and indexes) and a five-value
// sources_alignment_check on sources.bias, while the 001-151 chain leaves
// sources_bias_check (001's inline check, re-declared by 005 with ten keys) and
// no tradition columns. 152 re-declares prod's objects ADDITIVELY: every step
// is guarded on the object's absence, so on production it changes nothing but
// the ledger.
//
// DEFERRED (Step 0 (g) found one non-hex content_hash row, a historical
// raw-URL fallback): 026's articles_content_hash_length_chk and the 026 ledger
// row are NOT part of 152. This file pins that deferral, and pins the header's
// follow-up expression to 026's so it cannot drift.
//
// This file follows the CodeQL rules of the repo: SQL is scanned by CHARACTER
// scanners (quote-aware comment stripping, balanced parentheses), never by a
// regex over string literals; no tag-stripping regex; no partial escaping.
// The last block is opt-in (TAYF_PSQL), same convention as 151.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_152 = resolve(MIGRATIONS_DIR, "152_schema_parity.sql");
const MIGRATION_026 = resolve(MIGRATIONS_DIR, "026_unify_content_hash_v2.sql");
const DRYRUN_PROD = resolve(ROOT, "tests", "migrations", "sql", "152-schema-parity-prod-shape-dryrun.sql");
const DRYRUN_CHAIN = resolve(ROOT, "tests", "migrations", "sql", "152-schema-parity-chain-shape-dryrun.sql");

// Constants copied from Step 0 (production, read-only, 2026-11-02).
const PROD_TRADITION = ["mainstream", "islamist", "nationalist", "secular", "left", "kurdish", "state", "international"];
const PROD_SOURCE_TYPE = ["general", "sports", "finance", "niche"];
const PROD_TRADITION_DEFAULT = "'mainstream'";
const PROD_SOURCE_TYPE_DEFAULT = "'general'";
const LEGACY_BIAS = ["state_media", "islamist_conservative", "international", "pro_kurdish", "nationalist"];
const VIOLATING_ROW_ID = "6f038461-536a-4a7b-9547-0f0a3a8e7f32";

// ---------------------------------------------------------------------------
// Character scanners
// ---------------------------------------------------------------------------

/**
 * Strips `--` line comments and (nested) block comments, quote-aware: a `--`
 * inside a single-quoted literal or a double-quoted identifier stays. With
 * blankStrings the CONTENT of every single-quoted literal is dropped (the
 * quotes stay), so word scans cannot trip over message text. Dollar-quote
 * delimiters are plain characters: a DO body is code and is scanned as code.
 */
function scanSql(sql: string, blankStrings: boolean): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const c = sql[i] as string;
    const next = sql[i + 1];
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      let depth = 1;
      i += 2;
      while (i < n && depth > 0) {
        if (sql[i] === "/" && sql[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (sql[i] === "*" && sql[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += " ";
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let body = "";
      while (j < n) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            body += "''";
            j += 2;
            continue;
          }
          break;
        }
        body += sql[j];
        j += 1;
      }
      out += blankStrings ? "''" : `'${body}'`;
      i = j + 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < n && sql[j] !== '"') j += 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const stripComments = (sql: string): string => scanSql(sql, false);
const wordsOnly = (sql: string): string => scanSql(sql, true);

/** Whitespace collapsed to single spaces. */
function squash(text: string): string {
  return text.split(/\s+/).filter((part) => part.length > 0).join(" ");
}

/** The text between the parenthesis at `open` and its match, quote-aware. */
function balanced(text: string, open: number): string {
  expect(text[open]).toBe("(");
  let depth = 0;
  let i = open;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'") {
          if (text[i + 1] === "'") {
            i += 2;
            continue;
          }
          break;
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
    i += 1;
  }
  throw new Error("unbalanced parentheses");
}

/** Every single-quoted literal of `text`, in order ('' is an escaped quote). */
function literalsOf(text: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "'") {
      i += 1;
      continue;
    }
    let value = "";
    i += 1;
    while (i < text.length) {
      if (text[i] === "'") {
        if (text[i + 1] === "'") {
          value += "'";
          i += 2;
          continue;
        }
        break;
      }
      value += text[i];
      i += 1;
    }
    out.push(value);
    i += 1;
  }
  return out;
}

/** Start index of every occurrence of `needle` in `haystack` (both used as given). */
function indexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/** The CHECK expression of `add constraint <name> check ( ... )`, whitespace-squashed. */
function checkExpression(text: string, name: string): string {
  const lower = text.toLowerCase();
  const at = lower.indexOf(`add constraint ${name}`);
  expect(at, `add constraint ${name}`).toBeGreaterThan(-1);
  const checkAt = lower.indexOf("check", at);
  expect(checkAt).toBeGreaterThan(-1);
  const open = lower.indexOf("(", checkAt);
  return squash(balanced(text, open));
}

const raw = readFileSync(MIGRATION_152, "utf8");
const lines = raw.split("\n");
const beginLine = lines.findIndex((line) => line.trim() === "begin;");
const header = lines.slice(0, Math.max(beginLine, 0)).join("\n");
/** Header comment text with the leading `--` of every line removed. */
const headerText = header
  .split("\n")
  .map((line) => (line.startsWith("--") ? line.slice(2) : line))
  .join("\n");
const code = stripComments(raw);
const words = wordsOnly(raw).toLowerCase();
const codeLower = code.toLowerCase();
const n = squash(code);

// ---------------------------------------------------------------------------
// Scanner self-checks (so the assertions below cannot pass vacuously)
// ---------------------------------------------------------------------------

describe("152 test scanners", () => {
  it("stripComments drops comments but keeps a `--` inside a literal", () => {
    expect(stripComments("select 1; -- gone\nselect '-- kept', 2; /* gone */ select 3;")).toBe(
      "select 1; \nselect '-- kept', 2;   select 3;",
    );
  });

  it("wordsOnly blanks literal content and keeps the quotes", () => {
    expect(wordsOnly("raise notice 'update drop'; select 'it''s';")).toBe("raise notice ''; select '';");
  });

  it("balanced / literalsOf read a nested, quoted group", () => {
    const text = "x check (a in ('p)', 'q''r') and (b)) tail";
    const inner = balanced(text, text.indexOf("("));
    expect(inner).toBe("a in ('p)', 'q''r') and (b)");
    expect(literalsOf(inner)).toEqual(["p)", "q'r"]);
  });

  it("the migration is non-vacuous: it has a header, code and DO blocks", () => {
    expect(beginLine).toBeGreaterThan(10);
    expect(header.length).toBeGreaterThan(2000);
    expect(indexesOf(codeLower, "do $$").length).toBeGreaterThanOrEqual(4);
  });
});

// ---------------------------------------------------------------------------

describe("152 schema_parity: transaction, ledger, header", () => {
  it("is wrapped in one begin; ... commit;", () => {
    const trimmed = n.trim();
    expect(trimmed.startsWith("begin;")).toBe(true);
    expect(trimmed.endsWith("commit;")).toBe(true);
    expect(indexesOf(codeLower, "begin;")).toHaveLength(1);
    expect(indexesOf(codeLower, "commit;")).toHaveLength(1);
  });

  it("sets a local lock_timeout of 5s and a local statement_timeout right after begin", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s'; set local statement_timeout = ");
  });

  it("records ('152', '152_schema_parity') with on conflict do nothing, last before commit", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('152', '152_schema_parity') on conflict do nothing;",
    );
    expect(n.endsWith("on conflict do nothing; commit;")).toBe(true);
    expect(n).toContain("notify pgrst, 'reload schema'; insert into supabase_migrations.schema_migrations");
  });

  it("the header carries the sections and the Step 0 transcript heading", () => {
    for (const section of ["WHY", "WHAT", "STEP 0", "DEFERRED", "FOUNDER", "DRY RUNS", "OPERATOR", "VERIFY", "ROLLBACK", "PRE-BUILD"]) {
      expect(header, `header section ${section}`).toContain(section);
    }
    expect(header).toContain("STEP 0 (production, read-only, 2026-11-02)");
    // The transcript: the four queries' evidence, verbatim keys and values.
    expect(header).toContain("sources_alignment_check");
    expect(header).toContain("idx_sources_tradition");
    expect(header).toContain("'mainstream'::text");
    expect(header).toContain("'general'::text");
    expect(header).toContain("1391507");
  });

  it("the header states the founder decision about widening the bias CHECK", () => {
    expect(squash(headerText).toLowerCase()).toContain(
      "widening the bias check to the 10 keys the app knows stays a founder decision; it would move zones",
    );
  });

  it("the header says why there is no PRE-BUILD (about 150 sources rows, no articles index)", () => {
    const section = squash(headerText);
    expect(section).toMatch(/no PRE-BUILD/i);
    expect(section).toContain("~150");
  });
});

describe("152 schema_parity: the content_hash CHECK is deferred", () => {
  it("adds no articles constraint and does not touch content_hash", () => {
    expect(words).not.toContain("articles_content_hash_length_chk");
    expect(words).not.toContain("content_hash");
    expect(words).not.toMatch(/alter\s+table\s+(public\.)?articles/);
  });

  it("does not record the 026 ledger row", () => {
    expect(code).not.toContain("'026'");
    expect(code).not.toContain("026_unify_content_hash_v2");
  });

  it("the header explains the deferral with the violating row and the writer fix", () => {
    const text = squash(headerText);
    expect(text).toContain(VIOLATING_ROW_ID);
    expect(text).toContain("46ce637");
    expect(text).toMatch(/NOT VALID check still (runs|fires) on every UPDATE/);
  });

  it("the header's follow-up CHECK expression equals 026's (so the deferral cannot drift)", () => {
    const m026 = checkExpression(stripComments(readFileSync(MIGRATION_026, "utf8")), "articles_content_hash_length_chk");
    expect(m026).toContain("content_hash ~ '^[0-9a-f]{40}$'");
    expect(m026).toContain("content_hash ~ '^[0-9a-f]{64}$'");
    expect(checkExpression(headerText, "articles_content_hash_length_chk")).toBe(m026);
  });

  it("the header's follow-up keeps the check NOT VALID", () => {
    const lower = squash(headerText).toLowerCase();
    const at = lower.indexOf("add constraint articles_content_hash_length_chk");
    expect(at).toBeGreaterThan(-1);
    expect(lower.slice(at, at + 400)).toContain("not valid");
  });
});

describe("152 schema_parity: sources.tradition / sources.source_type", () => {
  it("adds each column only when information_schema says it is missing, with prod's type, nullability and default", () => {
    expect(n).toContain("from information_schema.columns");
    expect(n).toContain("column_name = 'tradition'");
    expect(n).toContain("column_name = 'source_type'");
    expect(n).toContain(`alter table public.sources add column tradition text not null default ${PROD_TRADITION_DEFAULT}`);
    expect(n).toContain(`alter table public.sources add column source_type text not null default ${PROD_SOURCE_TYPE_DEFAULT}`);
    // Each ADD COLUMN sits inside an `if not exists (...) then` of its own.
    for (const column of ["tradition", "source_type"]) {
      const at = n.indexOf(`add column ${column} `);
      expect(at).toBeGreaterThan(-1);
      expect(n.slice(Math.max(0, at - 330), at)).toContain("if not exists");
      expect(n.slice(Math.max(0, at - 330), at)).toContain(`column_name = '${column}'`);
    }
  });

  it("the CHECK lists equal prod's (Step 0 (a)) and each ADD is guarded on pg_constraint", () => {
    expect(literalsOf(checkExpression(code, "sources_tradition_check"))).toEqual(PROD_TRADITION);
    expect(literalsOf(checkExpression(code, "sources_source_type_check"))).toEqual(PROD_SOURCE_TYPE);
    for (const name of ["sources_tradition_check", "sources_source_type_check"]) {
      const at = n.indexOf(`add constraint ${name}`);
      expect(at).toBeGreaterThan(-1);
      const before = n.slice(Math.max(0, at - 330), at);
      expect(before).toContain("from pg_constraint");
      expect(before).toContain(`conname = '${name}'`);
      expect(before).toContain("if not exists");
    }
  });

  it("mirrors prod's convalidated = true for both: the ADD is not NOT VALID", () => {
    for (const name of ["sources_tradition_check", "sources_source_type_check"]) {
      const at = n.indexOf(`add constraint ${name}`);
      const stmtEnd = n.indexOf(";", at);
      expect(n.slice(at, stmtEnd).toLowerCase()).not.toContain("not valid");
    }
  });

  it("creates prod's two indexes, each only when pg_indexes lacks the name", () => {
    for (const [index, column] of [
      ["idx_sources_tradition", "tradition"],
      ["idx_sources_source_type", "source_type"],
    ] as const) {
      expect(n).toContain(`create index if not exists ${index} on public.sources (${column});`);
      const at = n.indexOf(`create index if not exists ${index}`);
      const before = n.slice(Math.max(0, at - 260), at);
      expect(before).toContain("from pg_indexes");
      expect(before).toContain(`indexname = '${index}'`);
    }
    expect(indexesOf(codeLower, "create index")).toHaveLength(2);
    expect(codeLower).not.toContain("concurrently");
  });
});

describe("152 schema_parity: sources_alignment_check", () => {
  it("both bias lists (the guard count and the CHECK) equal WRITABLE_SOURCE_BIAS", () => {
    const occurrences = indexesOf(codeLower, "bias in (");
    expect(occurrences).toHaveLength(2);
    for (const at of occurrences) {
      const list = literalsOf(balanced(code, codeLower.indexOf("(", at)));
      expect(list).toEqual([...WRITABLE_SOURCE_BIAS]);
    }
    const checkList = literalsOf(checkExpression(code, "sources_alignment_check"));
    expect(checkList).toEqual([...WRITABLE_SOURCE_BIAS]);
  });

  it("no legacy bias key appears in the alignment block (tradition legitimately has 'nationalist' and 'international')", () => {
    const at = n.indexOf("add constraint sources_alignment_check");
    const block = n.slice(n.lastIndexOf("do $$", at), n.indexOf("end $$;", at));
    expect(block.length).toBeGreaterThan(200);
    for (const key of LEGACY_BIAS) expect(block).not.toContain(`'${key}'`);
  });

  it("is added NOT VALID, only when the name is missing AND no existing row violates it, else RAISE NOTICE", () => {
    const at = n.indexOf("add constraint sources_alignment_check");
    expect(at).toBeGreaterThan(-1);
    const stmtEnd = n.indexOf(";", at);
    expect(n.slice(at, stmtEnd).toLowerCase()).toMatch(/\bnot valid$/);
    // The block: name guard, then the violator count, then the add, then the notice branch.
    const blockStart = n.lastIndexOf("do $$", at);
    const block = n.slice(blockStart, n.indexOf("end $$;", at));
    expect(block).toContain("conname = 'sources_alignment_check'");
    expect(block).toContain("select count(*)");
    expect(block).toContain("not (bias in (");
    expect(block).toMatch(/if v_violators = 0 then/);
    expect(block).toContain("raise notice");
    expect(block.indexOf("select count(*)")).toBeLessThan(block.indexOf("add constraint sources_alignment_check"));
    expect(block.indexOf("add constraint sources_alignment_check")).toBeLessThan(block.indexOf("raise notice"));
  });

  it("never drops or names sources_bias_check (the chain keeps its ten-key check; widening is a founder decision)", () => {
    expect(words).not.toContain("sources_bias_check");
    expect(words).not.toMatch(/\bdrop\b/);
  });
});

describe("152 schema_parity: additive only", () => {
  it.each([
    ["drop", /\bdrop\b/],
    ["update", /\bupdate\b/],
    ["delete", /\bdelete\b/],
    ["truncate", /\btruncate\b/],
    ["alter column", /alter\s+column/],
    ["create or replace function", /create\s+or\s+replace\s+function/],
    ["create function", /create\s+function/],
    ["create trigger", /create\s+trigger/],
    ["create table", /create\s+table/],
    ["cron.", /\bcron\./],
    ["grant", /\bgrant\b/],
    ["revoke", /\brevoke\b/],
    ["validate", /\bvalidate\b/],
    ["rename", /\brename\b/],
  ])("the code contains no %s", (_label, pattern) => {
    expect(words).not.toMatch(pattern);
  });

  it("the whole file never carries a VALIDATE CONSTRAINT statement", () => {
    expect(squash(raw).toLowerCase()).not.toContain("validate constraint");
  });

  it("grants nothing to anon, authenticated or public", () => {
    expect(words).not.toMatch(/\banon\b/);
    expect(words).not.toMatch(/\bauthenticated\b/);
    expect(words).not.toMatch(/\bto\s+public\b/);
  });

  it("every alter table touches only public.sources", () => {
    const statements = indexesOf(words, "alter table");
    expect(statements.length).toBeGreaterThanOrEqual(5);
    for (const at of statements) {
      expect(words.slice(at, at + 40)).toMatch(/^alter table public\.sources add /);
    }
  });

  it("touches 001-151 never: the migration is the only 152 file", () => {
    expect(existsSync(MIGRATION_152)).toBe(true);
  });
});

describe("152 schema_parity: dry-run scripts", () => {
  it("both dry-run scripts exist, apply 152 twice and end with their OK marker", () => {
    expect(existsSync(DRYRUN_PROD)).toBe(true);
    expect(existsSync(DRYRUN_CHAIN)).toBe(true);
    const prod = existsSync(DRYRUN_PROD) ? readFileSync(DRYRUN_PROD, "utf8") : "";
    const chain = existsSync(DRYRUN_CHAIN) ? readFileSync(DRYRUN_CHAIN, "utf8") : "";
    for (const text of [prod, chain]) {
      expect(indexesOf(text, "\\ir ../../../supabase/migrations/152_schema_parity.sql").length).toBeGreaterThanOrEqual(2);
      expect(text).toContain("\\set ON_ERROR_STOP on");
    }
    expect(prod).toContain("DRYRUN 152 prod-shape OK");
    expect(chain).toContain("DRYRUN 152 chain-shape OK");
  });

  it("the prod-shape script pins prod's six sources constraints and four articles constraints", () => {
    const prod = existsSync(DRYRUN_PROD) ? readFileSync(DRYRUN_PROD, "utf8") : "";
    for (const name of [
      "sources_alignment_check",
      "sources_kind_check",
      "sources_pkey",
      "sources_slug_key",
      "sources_source_type_check",
      "sources_tradition_check",
      "articles_pkey",
      "articles_source_content_hash_key",
      "articles_source_id_fkey",
      "articles_url_key",
    ]) {
      expect(prod, name).toContain(name);
    }
  });

  it("the chain-shape script covers the legacy-row variant and the documented rollback", () => {
    const chain = existsSync(DRYRUN_CHAIN) ? readFileSync(DRYRUN_CHAIN, "utf8") : "";
    expect(chain).toContain("nationalist");
    expect(chain).toContain("sources_bias_check");
    expect(squash(chain).toLowerCase()).toContain("rollback");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at the THROWAWAY database a dry-run script leaves behind
// (tests/migrations/sql/stub.sql, then the prod-shape or the chain-shape script).
// TAYF_SHAPE = "prod" (default) | "chain". Every check that writes runs inside
// a transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("152 against a live Postgres (152 applied)", () => {
  assertLiveReady("152", { ledger: ["152"] });

  const SHAPE: "prod" | "chain" = process.env.TAYF_SHAPE === "chain" ? "chain" : "prod";

  const EXPECTED = {
    prod: {
      sources: [
        "sources_alignment_check",
        "sources_kind_check",
        "sources_pkey",
        "sources_slug_key",
        "sources_source_type_check",
        "sources_tradition_check",
      ],
      articles: ["articles_pkey", "articles_source_content_hash_key", "articles_source_id_fkey", "articles_url_key"],
    },
    // sources_bias_check is allowed ONLY on the chain shape: 001's inline check, re-declared by 005.
    chain: {
      sources: [
        "sources_alignment_check",
        "sources_bias_check",
        "sources_kind_check",
        "sources_pkey",
        "sources_slug_key",
        "sources_source_type_check",
        "sources_tradition_check",
      ],
      // 026 ran in the chain: its NOT VALID check is there, and 152 leaves it alone.
      articles: [
        "articles_content_hash_length_chk",
        "articles_pkey",
        "articles_source_content_hash_key",
        "articles_source_id_fkey",
        "articles_url_key",
      ],
    },
  } as const;

  const runPsql = (input: string): string =>
    execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });

  const runPsqlError = (input: string): string => {
    try {
      execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
        input,
        encoding: "utf8",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
    throw new Error("expected psql to fail");
  };

  const constraintNames = (table: string): string[] =>
    runPsql(
      `select coalesce(string_agg(conname, ',' order by conname), '') from pg_constraint where conrelid = 'public.${table}'::regclass;`,
    )
      .trim()
      .split(",");

  const insertSource = (bias: string, overrides: Record<string, string> = {}): string => {
    const cols: Record<string, string> = {
      slug: "w1-live",
      name: "W1 live",
      url: "https://w1.example",
      rss_url: "https://w1.example/rss",
      bias,
      ...overrides,
    };
    const names = Object.keys(cols).join(", ");
    const values = Object.values(cols)
      .map((v) => `'${v}'`)
      .join(", ");
    return `insert into public.sources (${names}) values (${values});`;
  };

  it("the ledger has 152 exactly once and no 026 row (the 026 check is deferred)", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '152';").trim()).toBe("1");
    const has026 = runPsql("select count(*) from supabase_migrations.schema_migrations where version = '026';").trim();
    expect(has026).toBe(SHAPE === "chain" ? "1" : "0");
  });

  it("the constraint names on sources and articles equal the EXPECTED set for the shape", () => {
    expect(constraintNames("sources")).toEqual([...EXPECTED[SHAPE].sources]);
    expect(constraintNames("articles")).toEqual([...EXPECTED[SHAPE].articles]);
  });

  it("articles carries no articles_content_hash_length_chk unless the chain shape's own 026 put it there, and then it is NOT VALID", () => {
    const row = runPsql(
      "select convalidated from pg_constraint where conrelid = 'public.articles'::regclass and conname = 'articles_content_hash_length_chk';",
    ).trim();
    expect(row).toBe(SHAPE === "chain" ? "f" : "");
  });

  it("tradition and source_type exist with prod's type, nullability and default", () => {
    expect(
      runPsql(
        `select string_agg(column_name || ':' || data_type || ':' || is_nullable || ':' || column_default, ',' order by column_name)
           from information_schema.columns where table_schema = 'public' and table_name = 'sources' and column_name in ('tradition', 'source_type');`,
      ).trim(),
    ).toBe("source_type:text:NO:'general'::text,tradition:text:NO:'mainstream'::text");
  });

  it("the two indexes exist", () => {
    expect(
      runPsql(
        "select string_agg(indexname, ',' order by indexname) from pg_indexes where schemaname = 'public' and tablename = 'sources' and indexname in ('idx_sources_tradition', 'idx_sources_source_type');",
      ).trim(),
    ).toBe("idx_sources_source_type,idx_sources_tradition");
  });

  it("the alignment check is the five writable keys; validated on the prod shape, NOT VALID where 152 added it", () => {
    const def = runPsql(
      "select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_alignment_check';",
    );
    expect(literalsOf(def)).toEqual([...WRITABLE_SOURCE_BIAS]);
    expect(
      runPsql(
        "select convalidated from pg_constraint where conrelid = 'public.sources'::regclass and conname = 'sources_alignment_check';",
      ).trim(),
    ).toBe(SHAPE === "chain" ? "f" : "t");
  });

  it("a legacy bias is refused with 23514 naming sources_alignment_check, a writable bias is accepted with the defaults", () => {
    const err = runPsqlError(`begin;\n${insertSource("state_media")}\nrollback;\n`);
    expect(err).toContain("sources_alignment_check");
    expect(err).toMatch(/23514|violates check constraint/);
    expect(
      runPsql(
        `begin;\n${insertSource("center")}\nselect tradition || '/' || source_type from public.sources where slug = 'w1-live';\nrollback;\n`,
      ).trim(),
    ).toBe("mainstream/general");
  });

  it("a bad tradition and a bad source_type are refused by their own checks", () => {
    expect(runPsqlError(`begin;\n${insertSource("center", { tradition: "bogus" })}\nrollback;\n`)).toContain("sources_tradition_check");
    expect(runPsqlError(`begin;\n${insertSource("center", { source_type: "bogus" })}\nrollback;\n`)).toContain("sources_source_type_check");
  });
});
