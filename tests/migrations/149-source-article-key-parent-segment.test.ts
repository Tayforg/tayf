import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import {
  KEY_DATE_PREFIX_RE,
  KEY_FILE_EXT_RE,
  KEY_ROUND_RE,
  PARENT_SEGMENT_KEY_RES,
  URL_PATH_RE,
  sourceArticleKey,
} from "../../supabase/functions/_shared/rss/article-key";
import { SOURCE_ARTICLE_KEY_CASES } from "../fixtures/source-article-key-cases";
import { assertLiveReady } from "../_helpers/live-db";

// Static SQL-contract test for migration 149: public.source_article_key(text)
// re-created with the two host-anchored parent-segment rules of
// supabase/functions/_shared/rss/article-key.ts (PARENT_SEGMENT_KEY_RES:
// evrensel /haber/<id>/ and indyturk /node/<id>/). The migration changes no
// table and updates no row: ingest computes the key in TypeScript, so 149 only
// keeps the SQL twin (used by the operator backfill) in step with it.
//
// Comments are stripped before every code assertion so prose can never
// satisfy a guard. The last block (opt-in, TAYF_PSQL) runs the shared truth
// table through a real Postgres that has 149 applied. The behaviour of the file
// itself is exercised by tests/migrations/sql/149-source-article-key-parent-segment-dryrun.sql.

const MIGRATIONS = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS, "149_source_article_key_parent_segment.sql");
const MIGRATION_113 = resolve(MIGRATIONS, "113_source_article_key.sql");
const DRYRUN = resolve(__dirname, "sql", "149-source-article-key-parent-segment-dryrun.sql");

// md5(prosrc) of public.source_article_key(text) on production before 149
// (read-only, 2026-11-02): the text between `as $fn$` and `$fn$` of 113.
const PROD_MD5_BEFORE = "dbbba7e0e939036ef5c4298b593b7474";
const PROD_LENGTH_BEFORE = 1397;

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
// A JS regex `.source` escapes `/`; the SQL literal does not.
const unescapeSlash = (s: string) => s.replaceAll("\\/", "/");
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

/** Index of every occurrence of `needle` in `hay` (plain string scan). */
function occurrences(hay: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const at = hay.indexOf(needle, from);
    if (at === -1) return out;
    out.push(at);
    from = at + needle.length;
  }
}

/**
 * The exact text between `as $fn$` and the closing `$fn$` of
 * `public.source_article_key` (what Postgres stores in prosrc), taken from the
 * raw file.
 */
function sourceArticleKeyBodyRaw(raw: string): string {
  const create = raw.search(/create\s+or\s+replace\s+function\s+public\.source_article_key\s*\(/i);
  expect(create, "create or replace function public.source_article_key").toBeGreaterThanOrEqual(0);
  const open = raw.indexOf("as $fn$", create);
  expect(open).toBeGreaterThan(create);
  const start = open + "as $fn$".length;
  const end = raw.indexOf("$fn$", start);
  expect(end).toBeGreaterThan(start);
  return raw.slice(start, end);
}

/** Text literals of the `array[...]` that starts at `from` (character scan: the
 * literals themselves contain `[` and `]`). */
function textArrayLiterals(src: string, from: number): string[] {
  const out: string[] = [];
  let i = from;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "]") return out;
    if (c !== "'") {
      i++;
      continue;
    }
    let lit = "";
    i++;
    for (;;) {
      if (i >= src.length) throw new Error("unterminated text literal");
      const d = src.charAt(i);
      if (d === "'") {
        if (src.charAt(i + 1) === "'") {
          lit += "'";
          i += 2;
          continue;
        }
        i++;
        break;
      }
      lit += d;
      i++;
    }
    out.push(lit);
  }
  throw new Error("unterminated array");
}

const FOREACH_OPEN = "foreach v_re in array array[";

/** The collapsed parent-segment block: from `foreach` to its `end loop;`. */
function parentBlock(body: string): { start: number; end: number; text: string } {
  const start = body.indexOf(FOREACH_OPEN);
  expect(start, "foreach v_re block").toBeGreaterThanOrEqual(0);
  const endLoop = body.indexOf("end loop;", start);
  expect(endLoop).toBeGreaterThan(start);
  const end = endLoop + "end loop;".length;
  return { start, end, text: body.slice(start, end) };
}

describe("migration 149_source_article_key_parent_segment.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let body = ""; // collapsed, comment-stripped function body of 149
  let body113 = ""; // collapsed, comment-stripped function body of 113
  let raw113Body = "";
  let rawBody = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "149_source_article_key_parent_segment.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    rawBody = sourceArticleKeyBodyRaw(raw);
    body = collapse(stripComments(rawBody));
    const raw113 = readFileSync(MIGRATION_113, "utf8");
    raw113Body = sourceArticleKeyBodyRaw(raw113);
    body113 = collapse(stripComments(raw113Body));
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0, code does not)", () => {
    expect(raw).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
  });

  // ---- header ---------------------------------------------------------------

  it("the header opens with the file name, and the first $fn$ in the file is the function's", () => {
    expect(raw.startsWith("-- 149_source_article_key_parent_segment.sql")).toBe(true);
    // sourceArticleKeyBodyRaw relies on this: no `$fn$` in a comment.
    expect(raw.indexOf("$fn$")).toBe(raw.indexOf("as $fn$") + 3);
  });

  it("documents STEP 0, the replay, the dry runs, the rollback and that there is no backfill", () => {
    expect(raw).toMatch(/STEP 0/);
    expect(raw).toMatch(/REPLAY/);
    expect(raw).toMatch(/DRY RUN/);
    expect(raw).toMatch(/ROLLBACK/);
    expect(raw).toMatch(/no backfill/i);
    expect(raw).toMatch(/schema_migrations/);
    expect(raw).toMatch(/\/haber\/<id>\//);
    expect(raw).toMatch(/\/node\/<id>\//);
    expect(raw).toMatch(/6007631/);
    expect(raw).toMatch(/784651/);
    expect(raw).toMatch(/APPLY 149 \+ REDEPLOY ingest/);
    expect(raw).toMatch(/safe to re-apply/i);
  });

  it("the header records the md5 of the function body before (prod = 113) and after (this file)", () => {
    // The 'before' value is the production prosrc md5, and it must be 113's body.
    expect(md5(raw113Body)).toBe(PROD_MD5_BEFORE);
    expect(Buffer.byteLength(raw113Body, "utf8")).toBe(PROD_LENGTH_BEFORE);
    expect(raw).toContain(PROD_MD5_BEFORE);
    expect(raw).toContain(String(PROD_LENGTH_BEFORE));
    // The 'after' value is what Postgres will store for this file's body.
    expect(raw).toContain(md5(rawBody));
    expect(raw).toContain(String(Buffer.byteLength(rawBody, "utf8")));
  });

  it("the rollback re-runs only 113's source_article_key section and deletes the ledger row", () => {
    expect(raw).toMatch(/delete from supabase_migrations\.schema_migrations where version = '149';/);
    expect(raw).toMatch(/113/);
  });

  it("never mentions the forbidden zone word (zone-parity guard)", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  // ---- transaction shape --------------------------------------------------------

  it("is wrapped in exactly one begin and one commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("sets lock_timeout 5s and statement_timeout 60s locally, before the create", () => {
    const lock = code.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const stmt = code.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i);
    const create = code.search(/create\s+or\s+replace\s+function/i);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(stmt).toBeGreaterThanOrEqual(0);
    expect(code.search(/^\s*begin\s*;/im)).toBeLessThan(lock);
    expect(lock).toBeLessThan(create);
    expect(stmt).toBeLessThan(create);
  });

  it("writes the ledger row as the last statement before commit", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'149'\s*,\s*'149_source_article_key_parent_segment'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.lastIndexOf("$fn$"));
    expect([...code.matchAll(/insert\s+into/gi)]).toHaveLength(1);
  });

  // ---- the function -----------------------------------------------------------------

  it("re-creates exactly one function: source_article_key(p_url text), immutable, SECURITY DEFINER, empty search_path", () => {
    const flat = collapse(code).toLowerCase();
    const header =
      "create or replace function public.source_article_key(p_url text) returns text language plpgsql immutable security definer set search_path = ''";
    expect(occurrences(flat, header)).toHaveLength(1);
    expect(occurrences(flat, "create or replace function")).toHaveLength(1);
    expect(occurrences(flat, "security definer")).toHaveLength(1);
    expect(occurrences(flat, "$fn$")).toHaveLength(2);
  });

  it("revokes from public/anon/authenticated and grants EXECUTE to service_role only (as 113)", () => {
    const flat = collapse(code);
    const revoke = "revoke all on function public.source_article_key(text) from public, anon, authenticated;";
    const grant = "grant execute on function public.source_article_key(text) to service_role;";
    expect(flat).toContain(revoke);
    expect(flat).toContain(grant);
    // Identical to the statements 113 ran for the same function.
    const flat113 = collapse(stripComments(readFileSync(MIGRATION_113, "utf8")));
    expect(flat113).toContain(revoke);
    expect(flat113).toContain(grant);

    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(grants).toEqual([grant]);
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(revokes).toEqual([revoke]);
    expect(code).not.toMatch(/grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    expect(code).not.toMatch(/\bgrant\s+(select|insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
  });

  it("keeps the function comment, naming both migrations (113, 149)", () => {
    const m = code.match(/comment\s+on\s+function\s+public\.source_article_key\s*\(\s*text\s*\)\s+is\s+'/i);
    expect(m, "comment on function").not.toBeNull();
    expect(collapse(code)).toMatch(/migrations 113, 149/);
  });

  // ---- additive: nothing runs against data -----------------------------------------------

  it("updates no row and calls no backfill (no update public.articles, no backfill call)", () => {
    expect(code).not.toMatch(/\bupdate\b/i);
    expect(code).not.toMatch(/update\s+public\.articles/i);
    expect(code).not.toMatch(/articles_source_key_backfill/i);
    expect(code).not.toMatch(/\bpublic\.articles\b/i);
    expect(code).not.toMatch(/\bperform\b/i);
  });

  it("is additive: no create index / table / policy, alter table, drop, delete, truncate or maintain", () => {
    expect(code).not.toMatch(/create\s+(unique\s+)?index/i);
    expect(code).not.toMatch(/create\s+(unlogged\s+)?table/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bmaintain\b/i);
    expect([...code.matchAll(/\binsert\s+into\s+\w+\.\w+/gi)].map((m) => collapse(m[0]).toLowerCase())).toEqual([
      "insert into supabase_migrations.schema_migrations",
    ]);
  });

  it("runs nothing at the top level except set local, the function, comment, revoke, grant and the ledger row", () => {
    const topLevel = code.replace(/\$fn\$[\s\S]*?\$fn\$/g, "");
    expect(topLevel).not.toMatch(/\bselect\s+public\./i);
    expect(topLevel).not.toMatch(/\bselect\b/i);
    expect(topLevel).not.toMatch(/\bupdate\b/i);
    expect(topLevel).not.toMatch(/\bdo\s+\$/i);
  });

  it("re-applies cleanly: create or replace, idempotent grants, on conflict do nothing", () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function/i);
    expect(code).toMatch(/on\s+conflict\s+do\s+nothing/i);
  });

  // ---- the SQL twin: rule parity with the TS module ------------------------------------------

  describe("public.source_article_key body: parity with supabase/functions/_shared/rss/article-key.ts", () => {
    it("carries every exported regex .source verbatim (incl. both parent regexes)", () => {
      for (const re of [URL_PATH_RE, KEY_FILE_EXT_RE, KEY_DATE_PREFIX_RE, KEY_ROUND_RE, ...PARENT_SEGMENT_KEY_RES]) {
        const literal = unescapeSlash(re.source);
        expect(literal).not.toContain("'");
        expect(code, literal).toContain(literal);
      }
    });

    it("lists the parent regexes in a foreach whose literals equal PARENT_SEGMENT_KEY_RES, in order", () => {
      const { start } = parentBlock(body);
      const literals = textArrayLiterals(body, start + FOREACH_OPEN.length);
      expect(literals).toEqual(PARENT_SEGMENT_KEY_RES.map((re) => unescapeSlash(re.source)));
      expect(literals).toHaveLength(2);
      for (const re of PARENT_SEGMENT_KEY_RES) expect(re.flags).toBe("i");
    });

    it("declares v_re as text, once", () => {
      expect(occurrences(body, "v_re text;")).toHaveLength(1);
      expect(body.indexOf("v_re text;")).toBeLessThan(body.indexOf("begin"));
    });

    it("applies each parent regex with regexp_match(p_url, v_re, 'i') on the whole url, before v_path is set", () => {
      const block = parentBlock(body);
      expect(block.text).toContain("v_run := (pg_catalog.regexp_match(p_url, v_re, 'i'))[1];");
      expect(block.start).toBeLessThan(body.indexOf("v_path :="));
      expect(occurrences(body, "pg_catalog.regexp_match(p_url, v_re, 'i')")).toHaveLength(1);
    });

    it("sits right after the null-url return and applies the date-shape and round guards to the capture", () => {
      const nullGuard = "if p_url is null then return null; end if;";
      const afterNull = body.indexOf(nullGuard) + nullGuard.length;
      expect(body.indexOf(nullGuard)).toBeGreaterThan(-1);
      expect(body.slice(afterNull).trimStart().startsWith(FOREACH_OPEN)).toBe(true);

      const text = parentBlock(body).text;
      expect(text).toContain(
        `if v_run is not null and not (pg_catalog.length(v_run) in (8, 10, 12, 14) and v_run ~ '${KEY_DATE_PREFIX_RE.source}') and not (v_run ~ '${KEY_ROUND_RE.source}') then return v_run; end if;`,
      );
      expect(text).toMatch(/ then return v_run; end if; end loop;$/);
      // The guards come before the return, the return only inside the if.
      expect(text.indexOf(KEY_DATE_PREFIX_RE.source)).toBeLessThan(text.indexOf("return v_run;"));
      expect(text.indexOf(KEY_ROUND_RE.source)).toBeLessThan(text.indexOf("return v_run;"));
      expect(occurrences(text, "return v_run;")).toHaveLength(1);
    });

    it("leaves the last-segment logic unchanged: the body without the parent block equals 113's body", () => {
      const { start, end } = parentBlock(body);
      const without = collapse(body.slice(0, start) + " " + body.slice(end))
        .split("v_re text;")
        .join("");
      expect(collapse(without)).toBe(body113);
    });

    it("pg_catalog-qualifies every function call (empty search_path) and reads no table", () => {
      for (const fn of ["regexp_match", "regexp_replace", "regexp_matches", "length", "rtrim"]) {
        const all = [...body.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))];
        const qualified = [...body.matchAll(new RegExp(`pg_catalog\\.${fn}\\s*\\(`, "g"))];
        expect(all.length, `${fn} is used`).toBeGreaterThan(0);
        expect(qualified, `${fn} must be pg_catalog-qualified`).toHaveLength(all.length);
      }
      expect(body).not.toMatch(/\bpublic\./);
      expect(body).not.toMatch(/\b(from|join|update|insert)\s+public\b/);
    });

    it("stays NULL-safe: null url and unmatched path return null", () => {
      expect(body).toMatch(/if p_url is null then return null; end if;/);
      expect(body).toMatch(/if v_path is null then return null; end if;/);
    });
  });

  // ---- 149 is the newest definition --------------------------------------------------------------

  it("the newest migration that re-creates public.source_article_key is 149", () => {
    const versions: Array<{ n: number; file: string }> = [];
    for (const file of readdirSync(MIGRATIONS)) {
      if (!file.endsWith(".sql")) continue;
      const n = Number.parseInt(file.slice(0, file.indexOf("_")), 10);
      if (Number.isNaN(n)) continue;
      const sql = stripComments(readFileSync(resolve(MIGRATIONS, file), "utf8"));
      if (/create\s+(or\s+replace\s+)?function\s+public\.source_article_key\s*\(/i.test(sql)) {
        versions.push({ n, file });
      }
    }
    versions.sort((a, b) => a.n - b.n);
    expect(versions.map((v) => v.n)).toEqual([113, 149]);
    expect(versions[versions.length - 1]!.file).toBe("149_source_article_key_parent_segment.sql");
  });

  // ---- the dry-run script -----------------------------------------------------------------------------

  it("ships the local PG15 dry-run: 113, then 149 twice, ending in DRYRUN 149 OK", () => {
    expect(existsSync(DRYRUN), "dry-run sql").toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    expect(sql).toMatch(/113_source_article_key\.sql/);
    expect(occurrences(sql, "149_source_article_key_parent_segment.sql").length).toBeGreaterThanOrEqual(2);
    expect(sql).toMatch(/has_function_privilege\('anon'/);
    expect(sql).toContain("DRYRUN 149 OK");
    expect(sql).toContain(md5(rawBody));
  });
});

// ---------------------------------------------------------------------------
// Live parity (opt-in): the SQL twin must agree with the TS module on the
// shared truth table. Needs a throwaway Postgres with 113 and 149 applied and
// the stub schema; TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE select the server. Nothing here writes.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))(
  "migration 149: public.source_article_key() (live Postgres)",
  () => {
    assertLiveReady("149", { ledger: ["113", "149"], functions: ["public.source_article_key(text)"] });

    function lit(tag: string, value: string): string {
      // Unique dollar-quote tag per literal; never occurs inside the value.
      expect(value).not.toContain(`$${tag}$`);
      return `$${tag}$${value}$${tag}$::text`;
    }

    function runPsql(sql: string): string {
      return execFileSync(
        process.env.TAYF_PSQL as string,
        ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        {
          input: sql,
          encoding: "utf8",
          env: { ...process.env, PGCLIENTENCODING: "UTF8" },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    }

    it("returns the TS result (and the fixture key) for every fixture url", () => {
      const rows = SOURCE_ARTICLE_KEY_CASES.map((c, i) => `(${i}, ${lit(`u${i}`, c.url)})`);
      const sql =
        "select 'ROW|' || i || '|' || coalesce(public.source_article_key(u), '<null>') from (values\n" +
        rows.join(",\n") +
        "\n) v(i, u) order by i;";
      const out = runPsql(sql)
        .split("\n")
        .filter((l) => l.startsWith("ROW|"));
      expect(out).toHaveLength(SOURCE_ARTICLE_KEY_CASES.length);
      SOURCE_ARTICLE_KEY_CASES.forEach((c, idx) => {
        const [, i, v] = out[idx]!.split("|");
        expect(Number(i), `row order for ${c.url}`).toBe(idx);
        const expected = sourceArticleKey(c.url) ?? "<null>";
        expect(v, `public.source_article_key(${JSON.stringify(c.url)})`).toBe(expected);
        expect(expected, `fixture key for ${c.url}`).toBe(c.key ?? "<null>");
      });
    });

    it("is NULL-safe", () => {
      const out = runPsql(
        "select 'ROW|' || coalesce(public.source_article_key(null), '<null>') || '|' || coalesce(public.source_article_key(''), '<null>');",
      )
        .split("\n")
        .find((l) => l.startsWith("ROW|"));
      expect(out).toBe("ROW|<null>|<null>");
    });

    it("stores the body this file ships (md5 of prosrc) and keeps the 113 security shape", () => {
      const rawBody = sourceArticleKeyBodyRaw(readFileSync(MIGRATION, "utf8"));
      const out = runPsql(
        `select 'ROW|' || md5(prosrc) || '|' || provolatile::text || '|' || prosecdef::text || '|' || coalesce(proconfig[1], '') || '/' || coalesce(array_length(proconfig, 1)::text, '0') || '|' || has_function_privilege('anon', oid, 'execute')::text || '|' || has_function_privilege('authenticated', oid, 'execute')::text || '|' || has_function_privilege('service_role', oid, 'execute')::text from pg_proc where oid = 'public.source_article_key(text)'::regprocedure;`,
      )
        .split("\n")
        .find((l) => l.startsWith("ROW|"));
      // immutable | security definer | exactly one setting: search_path = '' | anon, authenticated, service_role
      expect(out).toBe(`ROW|${md5(rawBody)}|i|true|search_path=""/1|false|false|true`);
    });
  },
);
