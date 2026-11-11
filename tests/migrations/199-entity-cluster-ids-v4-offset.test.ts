import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ENTITY_HUB_LIMIT,
  ENTITY_HUB_MAX_OFFSET,
  ENTITY_HUB_MAX_PAGE,
  ENTITY_HUB_MAX_ROWS,
  entityByKey,
  entityHubPatterns,
  entityHubQueries,
} from "../../src/lib/entities/entity-hub";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 199 ("entity_cluster_ids_v4_offset"), h136-roadmap-2 (hunt 136).
//
// /gundem/<key> shows the newest 20 of the clusters a hub matches (up to 453 for erdogan) and v3, the RPC behind it, has a limit
// and no offset: GET /gundem/chp?sayfa=2 served page 1 again. 199 CREATES entity_cluster_ids_v4(p_queries, p_patterns, p_since,
// p_limit, p_headline_only, p_offset integer default 0). Its body is 170's v3 body (production's, md5 pinned below) with ONE added
// clause, `offset greatest(0, least(coalesce(p_offset, 0), 1000))` after the limit. v3 is not touched, dropped or replaced: it is the
// read of page 1 of every hub.
//
// This file pins, without a database: the file, ledger and transaction, additive-only SQL, 170's body is production's v3 (md5 pinned,
// recomputed from the file), 199's body is 170's with that single clause (page 1 of v4 is therefore v3's by construction), the
// clamp equals the app's constants, the schema-qualified body, the grants, the docs section, the dry-run script and the
// live-manifest entry, and a JS twin of the paging contract. The opt-in live block (TAYF_PSQL) runs the function against fixtures:
// v4 at offset 0 equals v3, the pages are disjoint, their union is the matched set.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_170 = "170_entity_cluster_ids_headline_only.sql";
const FILE_198 = "198_search_ascii_root_deny_collisions.sql";
const FILE_199 = "199_entity_cluster_ids_v4_offset.sql";
const MIGRATION_170 = resolve(MIGRATIONS_DIR, FILE_170);
const MIGRATION_199 = resolve(MIGRATIONS_DIR, FILE_199);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "199-entity-cluster-ids-v4-offset-dryrun.sql");

/** Production, read-only, 2026-11-11: md5(prosrc), length(prosrc) and the attributes of the v3 function 199 starts from. */
const PROD_V3_MD5 = "bc1ea39f547ca8d6810833f12c7bd983";
const PROD_V3_LENGTH = 1117;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.entity_cluster_ids_v4";
const FN_SIG = `${FN}(text[], text[], timestamptz, integer, boolean, integer)`;
const V3_SIG = "public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('199', '199_entity_cluster_ids_v4_offset') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** v3's last clause, and the two lines v4 ends with instead. */
const V3_TAIL = "  limit greatest(1, least(coalesce(p_limit, 20), 50));\n";
const V4_TAIL =
  "  limit greatest(1, least(coalesce(p_limit, 20), 50))\n  offset greatest(0, least(coalesce(p_offset, 0), 1000));\n";
const OFFSET_CLAUSE = "offset greatest(0, least(coalesce(p_offset, 0), 1000))";

// -- plain-text helpers (no regular expression runs over quoted SQL) ----------------------------

/** Removes `--` comments to the end of the line (no `--` appears inside a string literal of these files). */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

/** Comment block read as prose: `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\n--\s*/g, " ").replace(/\s+/g, " ");
}

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two dollar-quote markers: Postgres' prosrc. Comments in the file header are not part of it. */
function functionBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  expect(open, "an opening dollar quote").toBeGreaterThanOrEqual(0);
  expect(close, "a closing dollar quote").toBeGreaterThan(open);
  return sql.slice(open + 4, close);
}

/** `create or replace function ... as ` up to and including the opening dollar quote. */
function functionHeader(sql: string): string {
  const at = sql.indexOf("create or replace function");
  const open = sql.indexOf("$fn$", at);
  expect(at, "create or replace function").toBeGreaterThanOrEqual(0);
  return sql.slice(at, open + 4);
}

/** Top-level statements: split on ';' outside single-quoted strings, `--` comments and dollar-quoted bodies; comments dropped. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < code.length) {
    const ch = code.charAt(i);
    if (code.startsWith("--", i)) {
      const newline = code.indexOf("\n", i);
      i = newline === -1 ? code.length : newline;
    } else if (code.startsWith("$fn$", i)) {
      const close = code.indexOf("$fn$", i + 4);
      const stop = close === -1 ? code.length : close + 4;
      cur += code.slice(i, stop);
      i = stop;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code.charAt(j) === "'") {
          if (code.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += code.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";") {
      out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  out.push(cur.trim());
  return out.filter((stmt) => stmt !== "");
}

/** Statements with the dollar-quoted body replaced by a marker and whitespace collapsed. */
function statements(code: string): string[] {
  return splitStatements(code).map((stmt) => {
    const open = stmt.indexOf("$fn$");
    const close = open === -1 ? -1 : stmt.indexOf("$fn$", open + 4);
    const shown = open !== -1 && close !== -1 ? `${stmt.slice(0, open)}$fn$ body $fn$${stmt.slice(close + 4)}` : stmt;
    return collapse(shown);
  });
}

function statementStartingWith(code: string, prefix: string): string {
  const found = statements(code).find((stmt) => stmt.toLowerCase().startsWith(prefix));
  if (found === undefined) throw new Error(`no statement starting with "${prefix}"`);
  return found;
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.charAt(i) !== "'") {
      out += sql.charAt(i);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < sql.length) {
      if (sql.charAt(j) === "'") {
        if (sql.charAt(j + 1) === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    out += "''";
    i = j + 1;
  }
  return out;
}

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

/** 170's file past its header: the transaction onward, so the header prose never counts as code. */
function codeOf170(sql: string): string {
  return sql.slice(sql.indexOf("\nbegin;"));
}

const sql170 = readFileSync(MIGRATION_170, "utf8");
const body170 = functionBody(codeOf170(sql170));
const sql199 = existsSync(MIGRATION_199) ? readFileSync(MIGRATION_199, "utf8") : "";
const header199 = (): string => {
  expect(existsSync(MIGRATION_199), `${FILE_199} must exist`).toBe(true);
  return sql199.split("\nbegin;")[0] as string;
};
const body199 = (): string => {
  expect(existsSync(MIGRATION_199), `${FILE_199} must exist`).toBe(true);
  return functionBody(sql199);
};

describe("199 entity_cluster_ids_v4_offset: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 199", () => {
    expect(existsSync(MIGRATION_199)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("199_"))).toEqual([FILE_199]);
  });

  it("sits after 198 and 170, and no other migration defines entity_cluster_ids_v4", () => {
    expect(FILE_199 > FILE_198 && FILE_198 > FILE_170).toBe(true);
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).includes("function public.entity_cluster_ids_v4("));
    expect(definers).toEqual([FILE_199]);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(sql199);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql199, "\nbegin;")).toBe(1);
    expect(countOf(sql199, "\ncommit;")).toBe(1);
  });

  it("records version 199 in the schema_migrations ledger, idempotently (the 140-198 convention), as the last statement before commit", () => {
    const code = collapse(stripComments(sql199));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });
});

describe("199 entity_cluster_ids_v4_offset: the production fingerprint it was built from", () => {
  it("170's function body is production's v3 body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body170)).toBe(PROD_V3_MD5);
    expect([...body170].length).toBe(PROD_V3_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 170's body", () => {
    const header = header199();
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_V3_MD5);
    expect(header).toContain(String(PROD_V3_LENGTH));
    expect(header).toMatch(/prosecdef t/);
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("equals the md5 of production's v3 body");
    expect(flat(header)).toContain("There is no entity_cluster_ids_v4");
  });

  it("the header names the evidence, the replay on chp, akp and erdogan, the deploy order and the rollback", () => {
    const header = flat(header199());
    for (const word of [
      "h136-roadmap-2",
      "p_offset",
      "28 of them have more than 20 clusters",
      "2,468",
      "erdogan 452",
      "chp",
      "akp",
      "erdogan",
      "REPLAY",
      "pages disjoint",
      "union = the matched set",
      "PGRST202",
      "ROLLBACK",
      "NUMBER",
      "197 is held by a migration of another branch",
    ]) {
      expect(header, word).toContain(word);
    }
    expect(header).toContain("170_entity_cluster_ids_headline_only.sql");
    expect(header).toContain("drop function public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)");
    expect(header).toContain("version = '199'");
    expect(header).toMatch(/^-- 199_entity_cluster_ids_v4_offset\.sql/);
  });

  it("VERIFY carries the md5 and the length of THIS file's function body", () => {
    const body = body199();
    expect(header199()).toContain(`${md5(body)}, ${[...body].length}`);
    expect(md5(body)).not.toBe(PROD_V3_MD5);
  });

  it("VERIFY reads one page with count(*) and max(total) on the chp arrays, and checks the grants", () => {
    const header = header199();
    const at = header.indexOf("-- VERIFY");
    const end = header.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(header.slice(at, end));
    const chp = entityByKey("chp")!;
    const [pattern] = entityHubPatterns(chp);
    expect(verify).toContain(
      `select count(*), max(total) from public.entity_cluster_ids_v4(array['${entityHubQueries(chp)[0]}'], array['${pattern}'], null, 20, false, 20);`,
    );
    expect(verify).toContain("20 rows");
    expect(verify).toContain("has_function_privilege('anon'");
    expect(verify).toContain("has_function_privilege('service_role'");
    expect(verify).toContain("false, false, true");
  });
});

describe("199 entity_cluster_ids_v4_offset: the function", () => {
  it("creates entity_cluster_ids_v4 with create or replace, v3's arguments plus p_offset integer default 0", () => {
    const header = collapse(functionHeader(stripComments(sql199))).toLowerCase();
    expect(
      header.startsWith(
        "create or replace function public.entity_cluster_ids_v4(p_queries text[], p_patterns text[], p_since timestamptz default null, p_limit integer default 20, p_headline_only boolean default false, p_offset integer default 0)",
      ),
    ).toBe(true);
    expect(header).toContain("returns table (id uuid, total bigint)");
  });

  it("is language sql, stable, security definer with an empty search_path (the attributes of v3)", () => {
    const h = collapse(functionHeader(stripComments(sql199))).toLowerCase();
    expect(h).toContain("language sql stable security definer set search_path = ''");
    expect(h).not.toContain("volatile");
    expect(h).not.toContain("security invoker");
    // v3's header, with the new argument cut out, is the same header
    const v3Header = collapse(functionHeader(stripComments(codeOf170(sql170)))).toLowerCase();
    expect(h.replace(", p_offset integer default 0", "").replace("entity_cluster_ids_v4", "entity_cluster_ids_v3")).toBe(v3Header);
  });

  it("the body is v3's body with that single clause added after the limit, nothing else: page 1 of v4 is v3's by construction", () => {
    const v3 = body170;
    const v4 = body199();
    expect(v3.endsWith(V3_TAIL)).toBe(true);
    // character for character: v4 is v3 with its last line extended by the offset clause
    expect(v4).toBe(v3.slice(0, -V3_TAIL.length) + V4_TAIL);
    expect(countOf(v4, OFFSET_CLAUSE)).toBe(1);
    expect(v4.endsWith(`${OFFSET_CLAUSE};\n`)).toBe(true);
    // removing the clause (and moving the semicolon back) gives v3, md5 and all
    expect(md5(v4.replace(`\n  ${OFFSET_CLAUSE};\n`, ";\n"))).toBe(PROD_V3_MD5);
    expect(v4).not.toBe(v3);
  });

  it("the offset clause is the last clause, after the limit, and p_offset is read nowhere else", () => {
    const body = collapse(body199());
    expect(countOf(body, "p_offset")).toBe(1);
    expect(body.indexOf("order by c.first_published desc, c.id")).toBeLessThan(body.indexOf("limit greatest("));
    expect(body.indexOf("limit greatest(")).toBeLessThan(body.indexOf(OFFSET_CLAUSE));
    expect(body.endsWith(`${OFFSET_CLAUSE};`)).toBe(true);
  });

  it("the offset clamp is the app's: 0..1000, and 1000 is the start of the last of ENTITY_HUB_MAX_PAGE pages", () => {
    expect(OFFSET_CLAUSE).toBe(`offset greatest(0, least(coalesce(p_offset, 0), ${ENTITY_HUB_MAX_OFFSET}))`);
    expect(ENTITY_HUB_MAX_PAGE).toBe(51);
    expect((ENTITY_HUB_MAX_PAGE - 1) * ENTITY_HUB_LIMIT).toBe(ENTITY_HUB_MAX_OFFSET);
    // 51 pages of 20 is the 1020 rows the pager serves (and the header says)
    expect(ENTITY_HUB_MAX_PAGE * ENTITY_HUB_LIMIT).toBe(ENTITY_HUB_MAX_ROWS);
    expect(ENTITY_HUB_LIMIT).toBe(20);
    expect(flat(header199())).toContain("1020 rows (51 pages of 20");
  });

  it("keeps every other clause of v3: the prefilter, the regex guard, the live predicate, the window, the order, the clamp, the total", () => {
    const body = collapse(body199());
    expect(body).toContain(
      "c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))",
    );
    expect(body).toContain("~ any (pg_catalog.array_remove(p_patterns[1:12], ''))");
    expect(body).toContain("(case when p_headline_only then ");
    expect(body).toContain("and not c.is_archived");
    expect(body).toContain("and c.article_count >= 2");
    expect(body).toContain("and c.merged_into is null");
    expect(sql199).toContain("and not c.is_archived      -- literal copy of the 083 partial-index predicate");
    expect(body).toContain(
      "c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')",
    );
    expect(body).toContain("limit greatest(1, least(coalesce(p_limit, 20), 50))");
    expect(body).toContain("(pg_catalog.count(*) over ())::bigint");
    // the order has a total tie-break (the id), so two pages never share a row
    expect(body).toContain("order by c.first_published desc, c.id");
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/);
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty)", () => {
    const code = sansStrings(stripComments(body199()));
    for (const rel of [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string)) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\./);
    }
    const calls = [...code.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((m) => (m[1] as string).toLowerCase())
      .filter((n) => !["greatest", "least", "coalesce", "select", "in", "over", "interval", "any", "case", "and", "offset", "limit"].includes(n));
    expect(calls).toEqual([]);
  });

  it("the function comment names 199, h136-roadmap-2, p_offset, v3 and the 0..1000 clamp, and ends 'service_role only.'", () => {
    const comment = statementStartingWith(sql199, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment.endsWith("service_role only.'")).toBe(true);
    for (const word of ["199", "h136-roadmap-2", "p_offset", "entity_cluster_ids_v3", "0..1000", "PGRST202"]) {
      expect(comment, word).toContain(word);
    }
  });
});

describe("199 entity_cluster_ids_v4_offset: v3 stays as it is", () => {
  it("does not create, replace, drop, alter or comment on v3 (no code names it), and 170 still defines it with the headline switch", () => {
    const code = collapse(sansStrings(stripComments(sql199)));
    expect(code).not.toContain("entity_cluster_ids_v3");
    expect(code).not.toContain("entity_cluster_ids_v2");
    expect(code).not.toMatch(/\bdrop\b/);
    expect(collapse(stripComments(codeOf170(sql170)))).toContain("create or replace function public.entity_cluster_ids_v3(");
    expect(body170).toContain("p_headline_only");
  });

  it("no other migration re-creates entity_cluster_ids_v3 after 170 (199 adds, it does not re-create)", () => {
    const redefiners = readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql") && n > FILE_170)
      .filter((n) =>
        collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"))).includes("create or replace function public.entity_cluster_ids_v3("),
      );
    expect(redefiners).toEqual([]);
  });
});

describe("199 entity_cluster_ids_v4_offset: privileges", () => {
  const code = `${statements(sql199).join(";\n")};`;

  it("re-states the grants for the NEW signature: revoke from public/anon/authenticated, grant execute to service_role (170's lines)", () => {
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
    // 170 spells the same two statements for the 5-argument v3
    const code170 = statements(codeOf170(sql170)).join(";\n");
    expect(code170).toContain(REVOKE_STMT.replace(FN_SIG, V3_SIG));
    expect(code170).toContain(GRANT_STMT.replace(FN_SIG, V3_SIG));
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(sql199).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
    const sans = sansStrings(code).toLowerCase();
    expect(sans).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(table|tables|sequence|sequences)\b/);
    expect(sans).not.toMatch(/\balter\s+default\s+privileges\b/);
  });

  it("reloads the PostgREST schema cache, so the new function is callable without a restart", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("199 entity_cluster_ids_v4_offset: additive, no data is written", () => {
  const stmts = statements(sql199);

  it("holds only the transaction frame, the timeout, one function, its comment, its privileges, the notify and the ledger row", () => {
    const expected = [
      "begin",
      "set local lock_timeout",
      "create or replace function",
      "comment on function",
      "revoke all on function",
      "grant execute on function",
      "notify pgrst",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ];
    expect(stmts).toHaveLength(expected.length);
    expected.forEach((prefix, i) => {
      expect((stmts[i] as string).toLowerCase().startsWith(prefix), `${i}: ${stmts[i]}`).toBe(true);
    });
  });

  it("has no update, delete, truncate, alter, drop, create table or create index statement, and the function body writes nothing", () => {
    const sans = sansStrings(stmts.join(";\n")).toLowerCase();
    expect(sans).not.toMatch(/(^|\s)update\s+public\./);
    expect(sans).not.toMatch(/(^|\s)delete\s+from\b/);
    expect(sans).not.toMatch(/\btruncate\b/);
    expect(sans).not.toMatch(/\balter\s+(table|function|role|default)/);
    expect(sans).not.toMatch(/\bdrop\s+/);
    expect(sans).not.toMatch(/\bcreate\s+(table|index|unique|trigger|extension|view|policy|schema)/);
    expect(sans).not.toMatch(/\bcopy\b/);
    const body = sansStrings(stripComments(body199())).toLowerCase();
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate)\b/);
    expect(countOf(sansStrings(stripComments(sql199)).toLowerCase(), "create ")).toBe(1);
  });

  it("the one insert is the ledger row, written the way 170 does", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([LEDGER_STMT.slice(0, -1)]);
  });
});

describe("199 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 199 ") ? sectionOf(guide, "199") : "";

  it("sits after section 198 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 199 ")).toBeGreaterThan(guide.indexOf("\n## 198 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 198 ") + 1)).toBe(guide.indexOf("\n## 199 "));
  });

  it("has Why, What, an md5 table, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 199 does**", "| md5(prosrc) | length |", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    const body = body199();
    expect(section).toContain(PROD_V3_MD5);
    expect(section).toContain(String(PROD_V3_LENGTH));
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });

  it("states the evidence and the rule", () => {
    for (const word of ["h136-roadmap-2", "p_offset", "erdogan", "chp", "akp", "2,468", "453", "151", "183", "disjoint", "1020", "51 pages"]) {
      expect(section, word).toContain(word);
    }
  });

  it("states the deploy order: apply 199 first, then deploy; page 1 stays on v3, a later page is unavailable on PGRST202 until 199 is applied", () => {
    expect(section).toContain("APPLY 199");
    expect(section).toContain("PGRST202");
    expect(section).toContain("entity_cluster_ids_v3");
    expect(section).toContain("entity_cluster_ids_v4");
    expect(section).toContain("Bu sayfa şu an gösterilemiyor");
    expect(section).toMatch(/APPLY 199 FIRST, THEN DEPLOY/);
    expect(section).not.toMatch(/either order/i);
    expect(section).toContain("Sonraki");
    expect(section).toContain("197");
  });

  it("verifies the fingerprint, the privileges, the ledger and the hub", () => {
    for (const word of ["md5(prosrc)", "has_function_privilege", "schema_migrations", "version = '199'", "entity_cluster_ids_v4", "/gundem/chp?sayfa=2"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that drops only the new function and deletes only the 199 ledger row; v3 is untouched", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("drop function public.entity_cluster_ids_v4(text[], text[], timestamptz, integer, boolean, integer)");
    expect(rb).toContain("version = '199'");
    expect(rb).not.toContain("drop function public.entity_cluster_ids_v3");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("199 live manifest and dry-run", () => {
  it("builds 199's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 199-entity-cluster-ids-v4-offset.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/199-entity-cluster-ids-v4-offset-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 170's state (gated on the production md5), applies 199 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/156_entity_cluster_ids_v3.sql",
      "../../../supabase/migrations/170_entity_cluster_ids_headline_only.sql",
      "../../../supabase/migrations/199_entity_cluster_ids_v4_offset.sql",
      "../../../supabase/migrations/199_entity_cluster_ids_v4_offset.sql",
    ]);
    expect(sql).toContain(PROD_V3_MD5);
    expect(sql).toContain(md5(body199()));
    expect(sql).toContain(String([...body199()].length));
    expect(sql).toContain("baseline: an object named entity_cluster_ids_v4 already exists");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 199 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// The paging contract through a test-only twin: the function is `order by first_published desc, id`, then limit, then offset, with
// the total taken before both. The app's pages are (page - 1) * 20 offsets of limit 20. Fixtures are plain rows.
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  firstPublished: number;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(n, hi));
}

/** The twin of v4's tail: order, limit (1..50, NULL = 20), offset (0..1000, NULL = 0), total before both. */
function v4Twin(matched: readonly Row[], limit: number | null, offset: number | null): { ids: string[]; total: number } {
  const ordered = [...matched].sort((a, b) => b.firstPublished - a.firstPublished || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lim = clamp(limit ?? 20, 1, 50);
  const off = clamp(offset ?? 0, 0, 1000);
  return { ids: ordered.slice(off, off + lim).map((r) => r.id), total: ordered.length };
}

/** v3's tail: the same without the offset. */
function v3Twin(matched: readonly Row[], limit: number | null): { ids: string[]; total: number } {
  return v4Twin(matched, limit, 0);
}

const rows = (n: number, sameInstant = false): Row[] =>
  Array.from({ length: n }, (_, i) => ({ id: `c${String(i).padStart(5, "0")}`, firstPublished: sameInstant ? 1_000 : 1_000_000 - i }));

describe("the paging contract (twin of the SQL tail)", () => {
  it("page 1 (offset 0, NULL or negative) is v3's page, ids, order and total", () => {
    const matched = rows(152);
    for (const off of [0, null, -1, -999]) {
      expect(v4Twin(matched, 20, off)).toEqual(v3Twin(matched, 20));
    }
  });

  it("the pages of one hub are disjoint and their union is the matched set, in order, with the same total", () => {
    for (const n of [0, 1, 19, 20, 21, 152, 453]) {
      const matched = rows(n);
      const last = Math.max(1, Math.ceil(n / ENTITY_HUB_LIMIT));
      const seen: string[] = [];
      for (let page = 1; page <= last; page++) {
        const got = v4Twin(matched, ENTITY_HUB_LIMIT, (page - 1) * ENTITY_HUB_LIMIT);
        if (n > 0) expect(got.total).toBe(n);
        seen.push(...got.ids);
      }
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toEqual(matched.map((r) => r.id));
      // one more page is past the end
      expect(v4Twin(matched, ENTITY_HUB_LIMIT, last * ENTITY_HUB_LIMIT).ids).toEqual([]);
    }
  });

  it("rows first published at the same instant keep their id order across pages (the tie-break)", () => {
    const matched = rows(45, true);
    const pages = [0, 20, 40].map((off) => v4Twin(matched, 20, off).ids);
    expect(pages.flat()).toEqual(matched.map((r) => r.id).sort());
  });

  it("the offset is clamped to 1000: pages 51 and beyond would all answer the same window, which is why the app stops at 51", () => {
    const matched = rows(1030);
    const atClamp = v4Twin(matched, 20, 1000).ids;
    expect(atClamp).toHaveLength(20);
    expect(v4Twin(matched, 20, 5000).ids).toEqual(atClamp);
    expect(v4Twin(matched, 20, (ENTITY_HUB_MAX_PAGE - 1) * ENTITY_HUB_LIMIT).ids).toEqual(atClamp);
    // page 52 asked of the SQL would be page 51's rows: the pager must not ask
    expect(v4Twin(matched, 20, ENTITY_HUB_MAX_PAGE * ENTITY_HUB_LIMIT).ids).toEqual(atClamp);
  });

  it("the limit clamp is v3's (1..50, NULL is 20) with an offset", () => {
    const matched = rows(200);
    expect(v4Twin(matched, 1000, 10).ids).toHaveLength(50);
    expect(v4Twin(matched, 0, 10).ids).toHaveLength(1);
    expect(v4Twin(matched, null, 10).ids).toHaveLength(20);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway Postgres with 156, 170 then 199 applied by the dry-run
// script (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server. Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("199 entity_cluster_ids_v4 against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("199", {
    ledger: ["156", "170", "199"],
    relations: ["public.clusters"],
    functions: [
      "public.entity_cluster_ids_v3(text[],text[],timestamptz,integer,boolean)",
      "public.entity_cluster_ids_v4(text[],text[],timestamptz,integer,boolean,integer)",
    ],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  const clusterUuid = (n: number): string => `c0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
  const arr = (items: readonly string[]): string => `array[${items.map(lit).join(", ")}]::text[]`;

  const AKP_QUERIES = entityHubQueries(entityByKey("akp")!);
  const AKP_PATTERNS = entityHubPatterns(entityByKey("akp")!);

  /** n live clusters naming the party in the headline: cluster i was first published i minutes ago, so a lower i is newer. */
  function fixture(n: number): string {
    const values = Array.from(
      { length: n },
      (_, i) =>
        `(${lit(clusterUuid(i + 1))}, ${lit(`AK Parti'den açıklama ${i + 1}`)}, 3, now() - interval '1 day', now() - interval '${i + 1} minutes')`,
    ).join(",\n  ");
    return `insert into public.clusters (id, title_tr, article_count, updated_at, first_published) values\n  ${values};\n`;
  }

  /** The fixture numbers a call returns, in the function's order, joined by commas ("-" for none), then the total. */
  const shown = (fnCall: string): string =>
    `select coalesce(string_agg(right(id::text, 12)::int::text, ',' order by ord), '-') || '/' || coalesce(max(total), 0) from (select id, total, row_number() over () as ord from ${fnCall}) s;\n`;

  const v3 = (limit: number): string =>
    `public.entity_cluster_ids_v3(${arr(AKP_QUERIES)}, ${arr(AKP_PATTERNS)}, null, ${limit}, true)`;
  const v4 = (limit: number, offset: string): string =>
    `public.entity_cluster_ids_v4(${arr(AKP_QUERIES)}, ${arr(AKP_PATTERNS)}, null, ${limit}, true, ${offset})`;

  function run(n: number, statementsAfter: string): string[] {
    return runPsql(`begin;\n${fixture(n)}${statementsAfter}rollback;\n`)
      .split("\n")
      .filter((l) => l.trim() !== "");
  }

  it("the function that runs is the file's: md5 and length of prosrc, the six arguments, stable, security definer, empty search_path, service_role only", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || provolatile::text || '|' || prosecdef || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = '${FN_SIG}'::regprocedure;`,
    ).trim();
    const body = body199();
    expect(out).toBe(
      `${md5(body)}|${[...body].length}|s|true|{"search_path=\\"\\""}|TABLE(id uuid, total bigint)|p_queries text[], p_patterns text[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 20, p_headline_only boolean DEFAULT false, p_offset integer DEFAULT 0`,
    );
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
  });

  it("v3 is untouched: its prosrc is production's, and there is exactly one v3 and one v4", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) from pg_proc where oid = '${V3_SIG}'::regprocedure;
       select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'entity_cluster_ids_v3';
       select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'entity_cluster_ids_v4';`,
    )
      .trim()
      .split("\n");
    expect(out).toEqual([`${PROD_V3_MD5}|${PROD_V3_LENGTH}`, "1", "1"]);
  });

  it("page 1: v4 at offset 0 (also omitted, NULL, negative) returns v3's ids, order and total", () => {
    const [v3Out, ...v4Outs] = run(
      55,
      shown(v3(20)) +
        shown(v4(20, "0")) +
        shown(v4(20, "null")) +
        shown(v4(20, "-5")) +
        shown(`public.entity_cluster_ids_v4(${arr(AKP_QUERIES)}, ${arr(AKP_PATTERNS)}, null, 20, true)`),
    );
    expect(v3Out).toBe(`${Array.from({ length: 20 }, (_, i) => i + 1).join(",")}/55`);
    for (const out of v4Outs) expect(out).toBe(v3Out);
  });

  it("the pages are disjoint, their union is the matched set, and total is 55 on every page", () => {
    const [p1, p2, p3, p4] = run(55, shown(v4(20, "0")) + shown(v4(20, "20")) + shown(v4(20, "40")) + shown(v4(20, "60")));
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i).join(",");
    expect(p1).toBe(`${range(1, 20)}/55`);
    expect(p2).toBe(`${range(21, 40)}/55`);
    expect(p3).toBe(`${range(41, 55)}/55`);
    expect(p4).toBe("-/0");
  });

  it("the offset is clamped to 1000 and the limit to 1..50", () => {
    const [atClamp, beyond, big, floor] = run(1030, shown(v4(20, "1000")) + shown(v4(20, "5000")) + shown(v4(100, "10")) + shown(v4(0, "10")));
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i).join(",");
    expect(atClamp).toBe(`${range(1001, 1020)}/1030`);
    expect(beyond).toBe(atClamp);
    expect(big).toBe(`${range(11, 60)}/1030`);
    expect(floor).toBe("11/1030");
  });
});
