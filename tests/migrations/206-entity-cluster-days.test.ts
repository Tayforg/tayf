import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ENTITY_HUB_WINDOW_DAYS, entityByKey, entityHubPatterns, entityHubQueries } from "../../src/lib/entities/entity-hub";
import { HUB_TREND_DAYS } from "../../src/lib/entities/hub-trend";

// ---------------------------------------------------------------------------
// Contract test for migration 206 ("entity_cluster_days"), h154-hub-trend.
//
// /gundem/<key> shows "Son 14 günde N küme" and nothing about how those N clusters spread over the 14 days. 206 CREATES one
// read-only function, public.entity_cluster_days(p_queries, p_patterns, p_since, p_headline_only): the hub's own match (199's
// entity_cluster_ids_v4 WHERE clause, character for character) counted per Istanbul day of first_published: 15 rows, 14 dated days
// ending today oldest first (zero included) and one row with day null for clusters first published earlier. v3 and v4 are not
// touched; no table, column, index, trigger or data change.
//
// This file pins, without a database: the file, ledger and transaction, the function's signature and attributes, that its WHERE
// clause is 199's v4 clause (and that 199's body is the production body recorded in STEP 0), the bucketing, no limit / offset /
// order by first_published, schema-qualified names, the grants, additive-only SQL, the header record, and the docs section.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_199 = "199_entity_cluster_ids_v4_offset.sql";
const FILE_206 = "206_entity_cluster_days.sql";
const MIGRATION_199 = resolve(MIGRATIONS_DIR, FILE_199);
const MIGRATION_206 = resolve(MIGRATIONS_DIR, FILE_206);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");

/** Production, read-only, 2026-11-12: md5(prosrc), length(prosrc) and the attributes of the v4 function 206 copies its WHERE from. */
const PROD_V4_MD5 = "364c7c7d99da7c27b42dc9673319ac14";
const PROD_V4_LENGTH = 1174;
const PROD_V3_MD5 = "bc1ea39f547ca8d6810833f12c7bd983";
const PROD_V3_LENGTH = 1117;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.entity_cluster_days";
const FN_SIG = `${FN}(text[], text[], timestamptz, boolean)`;

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('206', '206_entity_cluster_days') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

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

const isWordChar = (ch: string): boolean => (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_" || ch === ".";

/** True when `word` occurs in `text` as a whole word (neither neighbour is a letter, digit, underscore or dot). */
function hasWord(text: string, word: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(word, from);
    if (at < 0) return false;
    const before = at === 0 ? " " : text.charAt(at - 1);
    const after = at + word.length >= text.length ? " " : text.charAt(at + word.length);
    if (!isWordChar(before) && !isWordChar(after)) return true;
    from = at + 1;
  }
}

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

/** The v4 / 206 WHERE clause: from `where c.search_tsv @@` through the `c.updated_at >= greatest(...)` line; comments stripped, whitespace collapsed. */
function whereClause(body: string): string {
  const from = body.indexOf("where c.search_tsv @@");
  expect(from, "where c.search_tsv @@").toBeGreaterThanOrEqual(0);
  const tail = "pg_catalog.now() - interval '30 days')";
  const at = body.indexOf(tail, from);
  expect(at, "the 30-day clamp").toBeGreaterThan(from);
  return collapse(stripComments(body.slice(from, at + tail.length)));
}

const sql199 = readFileSync(MIGRATION_199, "utf8");
const body199 = functionBody(sql199);
const sql206 = existsSync(MIGRATION_206) ? readFileSync(MIGRATION_206, "utf8") : "";
const header206 = (): string => {
  expect(existsSync(MIGRATION_206), `${FILE_206} must exist`).toBe(true);
  return sql206.split("\nbegin;")[0] as string;
};
const body206 = (): string => {
  expect(existsSync(MIGRATION_206), `${FILE_206} must exist`).toBe(true);
  return functionBody(sql206);
};

describe("206 entity_cluster_days: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 206", () => {
    expect(existsSync(MIGRATION_206)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("206_"))).toEqual([FILE_206]);
    // the chain: 205 exists, 206 sorts after it, and no other migration defines the function
    expect(FILE_206 > "205_jev_signals_timeout.sql").toBe(true);
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).includes("function public.entity_cluster_days("));
    expect(definers).toEqual([FILE_206]);
  });

  it("runs in one transaction with a bounded lock wait and records version 206 in the ledger as the last statement before commit", () => {
    const stmts = statements(sql206);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql206, "\nbegin;")).toBe(1);
    expect(countOf(sql206, "\ncommit;")).toBe(1);

    const code = collapse(stripComments(sql206));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
    expect(stmts[stmts.length - 2]).toBe(LEDGER_STMT.slice(0, -1));
  });
});

describe("206 entity_cluster_days: the function", () => {
  it("creates entity_cluster_days(text[], text[], timestamptz, boolean) returning table (day date, clusters bigint), language sql, stable, security definer, empty search_path", () => {
    expect(existsSync(MIGRATION_206)).toBe(true);
    const header = collapse(functionHeader(stripComments(sql206))).toLowerCase();
    expect(
      header.startsWith(
        "create or replace function public.entity_cluster_days(p_queries text[], p_patterns text[], p_since timestamptz default null, p_headline_only boolean default false)",
      ),
    ).toBe(true);
    expect(header).toContain("returns table (day date, clusters bigint)");
    expect(header).toContain("language sql stable security definer set search_path = ''");
    expect(header).not.toContain("volatile");
    expect(header).not.toContain("security invoker");
    // the v4 attributes, restated: sql, stable, definer, empty search_path
    const v4Header = collapse(functionHeader(stripComments(sql199))).toLowerCase();
    expect(v4Header).toContain("language sql stable security definer set search_path = ''");
    // one function, one create
    expect(countOf(sansStrings(stripComments(sql206)).toLowerCase(), "create ")).toBe(1);
  });

  it("its WHERE clause is 199's entity_cluster_ids_v4 WHERE clause (comments stripped, whitespace collapsed): prefilter, headline switch, regex guard, live predicate, 14/30-day window", () => {
    const where206 = whereClause(body206());
    const where199 = whereClause(body199);
    expect(where206).toBe(where199);

    // the five parts, by name, so an edit of both bodies at once still has to keep the hub's match
    expect(where206).toContain(
      "c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))",
    );
    expect(where206).toContain("(case when p_headline_only then ");
    expect(where206).toContain("coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, '')");
    expect(where206).toContain("pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\\n', 1)");
    expect(where206).toContain("'İIıŞşĞğÜüÖöÇçÂâÎîÛû', 'iiissgguuooccaaiiuu'");
    expect(where206).toContain("~ any (pg_catalog.array_remove(p_patterns[1:12], ''))");
    expect(where206).toContain("and not c.is_archived");
    expect(where206).toContain("and c.article_count >= 2");
    expect(where206).toContain("and c.merged_into is null");
    expect(where206).toContain(
      `c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '${ENTITY_HUB_WINDOW_DAYS} days'), pg_catalog.now() - interval '30 days')`,
    );
    // the filter is written once, so it runs once (the CTE is read twice)
    expect(countOf(collapse(stripComments(body206())), "c.search_tsv @@")).toBe(1);
    expect(sql206).toContain("and not c.is_archived      -- literal copy of the 083 partial-index predicate");
  });

  it("199's body is the production v4 body recorded in STEP 0 (md5 and length), so the WHERE above is production's", () => {
    expect(md5(body199)).toBe(PROD_V4_MD5);
    expect([...body199].length).toBe(PROD_V4_LENGTH);
  });

  it("buckets by the Europe/Istanbul day of first_published over generate_series(0, 13) (HUB_TREND_DAYS and ENTITY_HUB_WINDOW_DAYS are 14) plus one null-day row for earlier first reports", () => {
    expect(HUB_TREND_DAYS).toBe(14);
    expect(ENTITY_HUB_WINDOW_DAYS).toBe(14);
    const body = collapse(stripComments(body206()));

    // the matched clusters, one date per cluster, in the Istanbul calendar
    expect(body.startsWith("with m as (select (c.first_published at time zone 'Europe/Istanbul')::date as d from public.clusters c where ")).toBe(true);
    // the window: today (Istanbul) back 13 days, 14 dated days
    expect(body).toContain(
      `w as (select (pg_catalog.now() at time zone 'Europe/Istanbul')::date - g as day from pg_catalog.generate_series(0, ${HUB_TREND_DAYS - 1}) as g)`,
    );
    // zero days included: the days are the driving side of a left join
    expect(body).toContain("select w.day, pg_catalog.count(m.d)::bigint from w left join m on m.d = w.day group by w.day");
    // earlier first reports: one row with day null
    expect(body).toContain(
      "union all select null::date, pg_catalog.count(*)::bigint from m where m.d < (select pg_catalog.min(w.day) from w)",
    );
    // oldest first, the null row last
    expect(body.endsWith("order by 1 nulls last;")).toBe(true);
    expect(countOf(body, "order by")).toBe(1); // v4's `order by c.first_published desc, c.id` is not copied
  });

  it("has no limit, no offset and no order by first_published", () => {
    const code = sansStrings(stripComments(body206())).toLowerCase();
    expect(hasWord(code, "limit")).toBe(false);
    expect(hasWord(code, "offset")).toBe(false);
    expect(code.includes("order by c.first_published")).toBe(false);
    expect(code.includes("order by first_published")).toBe(false);
    // the one order by sorts the result by its first column
    expect(countOf(collapse(code), "order by")).toBe(1);
    expect(collapse(code)).toContain("order by 1 nulls last");
    // first_published is read once, as the date; v4's tail is not copied
    expect(countOf(code, "first_published")).toBe(1);
    expect(code.includes("p_limit")).toBe(false);
    expect(code.includes("p_offset")).toBe(false);
    expect(code.includes("count(*) over")).toBe(false);
  });

  it("every relation and function in the body is schema-qualified", () => {
    const code = sansStrings(stripComments(body206()));
    const ctes = new Set(["m", "w"]);
    expect(collapse(code)).toContain("with m as (");
    expect(collapse(code)).toContain("), w as (");
    // relations after from / join: public. or pg_catalog., or one of the two CTEs
    const words = collapse(code).split(" ");
    const relations: string[] = [];
    words.forEach((word, i) => {
      if (word === "from" || word === "join") relations.push(words[i + 1] as string);
    });
    expect(relations.length).toBeGreaterThanOrEqual(5);
    for (const rel of relations) {
      const name = (rel.split("(")[0] as string).split(")")[0] as string;
      const ok = name.startsWith("public.") || name.startsWith("pg_catalog.") || ctes.has(name);
      expect(ok, `unqualified relation ${rel}`).toBe(true);
    }
    // functions: every `name(` is schema-qualified, or SQL syntax that does not resolve through search_path
    const allowed = new Set(["greatest", "coalesce", "select", "in", "over", "interval", "any", "case", "and", "as", "or", "where", "on", "when", "then", "else", "not", "union", "all", "by", "from", "with", "left", "join"]);
    const unqualified: string[] = [];
    for (let i = 0; i < code.length; i++) {
      if (code.charAt(i) !== "(") continue;
      let j = i - 1;
      while (j >= 0 && " \n\t".includes(code.charAt(j))) j--;
      const end = j + 1;
      while (j >= 0 && isWordChar(code.charAt(j))) j--;
      const name = code.slice(j + 1, end).toLowerCase();
      if (name === "" || name.includes(".")) continue; // `x.y(` is schema-qualified; a bare paren has no name
      if (!allowed.has(name)) unqualified.push(name);
    }
    expect(unqualified).toEqual([]);
    // the columns are table-qualified too: m.d and w.day, never a bare d or day
    expect(code).toContain("m.d = w.day");
    expect(code).toContain("min(w.day)");
    expect(collapse(code)).not.toContain("select day");
    expect(collapse(code)).not.toContain("group by day");
  });

  it("the function comment names 206, h154-hub-trend, the 15 rows and the v4 match, and ends 'service_role only.'", () => {
    const comment = statementStartingWith(sql206, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment.endsWith("service_role only.'")).toBe(true);
    for (const word of [
      "206",
      "h154-hub-trend",
      "15 rows: 14 Istanbul days ending today, oldest first, zero included, then one row with day null for clusters first published earlier",
      "entity_cluster_ids_v4",
      "PGRST202",
    ]) {
      expect(comment, word).toContain(word);
    }
    // 170's and 199's tests scan the other migrations for this text
    expect(sql206.includes("function public.entity_cluster_ids_v")).toBe(false);
    expect(collapse(stripComments(sql206)).includes("function public.entity_cluster_ids_v")).toBe(false);
  });
});

describe("206 entity_cluster_days: v3 and v4 stay as they are", () => {
  it("does not create, replace, drop, alter or comment on v3 or v4 (no code names them)", () => {
    const code = collapse(sansStrings(stripComments(sql206)));
    for (const name of ["entity_cluster_ids", "entity_cluster_ids_v2", "entity_cluster_ids_v3", "entity_cluster_ids_v4"]) {
      expect(code.includes(name), name).toBe(false);
    }
    expect(hasWord(code, "drop")).toBe(false);
    // 199 still defines v4, once, and no other migration re-creates it after 199
    const redefiners = readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql") && n > FILE_199)
      .filter((n) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"))).includes("function public.entity_cluster_ids_v4("));
    expect(redefiners).toEqual([]);
  });
});

describe("206 entity_cluster_days: privileges", () => {
  it("revokes from public, anon and authenticated, grants execute to service_role only, and grants nothing to anon or authenticated", () => {
    const code = `${statements(sql206).join(";\n")};`;
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
    // the revoke comes before the grant
    expect(code.indexOf(REVOKE_STMT)).toBeLessThan(code.indexOf(GRANT_STMT));

    const grants = statements(sql206).filter((stmt) => stmt.toLowerCase().startsWith("grant"));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
    const revokes = statements(sql206).filter((stmt) => stmt.toLowerCase().startsWith("revoke"));
    expect(revokes).toEqual([REVOKE_STMT.slice(0, -1)]);

    const sans = sansStrings(code).toLowerCase();
    expect(sans.includes("to anon")).toBe(false);
    expect(sans.includes("to authenticated")).toBe(false);
    expect(sans.includes("to public")).toBe(false);
    expect(sans.includes("on table")).toBe(false);
    expect(sans.includes("on all")).toBe(false);
    expect(sans.includes("on sequence")).toBe(false);
    expect(sans.includes("alter default privileges")).toBe(false);
    // and the reload that makes the function callable without a restart
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("206 entity_cluster_days: additive, no data is written", () => {
  it("is additive: no update, delete, truncate, alter, drop, create table or create index, and neither v3 nor v4 is created, replaced or dropped", () => {
    const stmts = statements(sql206);
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

    const sans = collapse(sansStrings(stmts.join(";\n"))).toLowerCase();
    for (const banned of ["update ", "delete ", "truncate", "alter ", "drop ", "create table", "create index", "create unique", "create trigger", "create extension", "create view", "create policy", "create schema", "copy "]) {
      expect(sans.includes(banned), banned).toBe(false);
    }
    const body = sansStrings(stripComments(body206())).toLowerCase();
    for (const word of ["insert", "update", "delete", "truncate"]) {
      expect(hasWord(body, word), `body: ${word}`).toBe(false);
    }
    // the one insert is the ledger row, written the way 199 does
    expect(stmts.filter((s) => s.toLowerCase().startsWith("insert"))).toEqual([LEDGER_STMT.slice(0, -1)]);
    // 206 writes the ledger row for 206 only
    expect(countOf(sql206, "values ('")).toBe(1);
  });
});

describe("206 entity_cluster_days: the header", () => {
  it("the header records STEP 0 (v4 md5 364c7c7d99da7c27b42dc9673319ac14, 1174), the replay, the deploy order, and VERIFY carries the md5 and length of this file's own body", () => {
    const raw = header206();
    const header = flat(raw);
    expect(raw).toMatch(/^-- 206_entity_cluster_days\.sql/);

    // WHY, the three evidence points with figures
    for (const word of [
      "h154-hub-trend",
      "WHY",
      "trends_daily_entity_counts_ist_rollup",
      "erdogan",
      "294",
      "51 clusters",
      "2,516",
      "457",
      "93, 20, 124, 157, 178, 100",
      "6, 8, 11, 16, 9, 21, 15, 4, 4, 4",
      "191",
      "Bakan Şimşek",
      "tcmb",
    ]) {
      expect(header, word).toContain(word);
    }

    // STEP 0: the v4 fingerprint and the attributes, v3 untouched
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_V4_MD5);
    expect(header).toContain(String(PROD_V4_LENGTH));
    expect(header).toContain("prosecdef t");
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(header).toContain(`${PROD_V3_MD5}/${PROD_V3_LENGTH}`);
    expect(header).toContain("untouched");
    expect(header).toContain("2026-11-12");
    expect(raw.includes("pg_get_functiondef")).toBe(true);

    // REPLAY: the six series
    expect(header).toContain("REPLAY");
    for (const series of [
      "34 26 11 29 30 19 19 27 19 32 49 58 51 12",
      "13 10 8 16 30 9 10 8 15 13 10 15 20 3",
      "6 4 5 7 11 9 9 8 12 7 5 2 4 3",
      "6 8 11 16 9 21 15 4 4 4 13 13 11 5",
      "0 0 0 0 5 1 11 3 4 0 0 3 2 4",
    ]) {
      expect(header, series).toContain(series);
    }
    for (const sum of ["416 + 41 earlier = 457", "180 + 2 = 182", "92 + 5 = 97", "140 + 8 = 148", "33 + 0"]) {
      expect(header, sum).toContain(sum);
    }
    for (const key of ["erdogan", "akp", "ozgur-ozel", "iran", "simsek", "tcmb"]) {
      expect(header, key).toContain(key);
    }
    expect(header).toContain("15 rows each time");

    // COST
    expect(header).toContain("COST");
    for (const ms of ["51 ms", "21 ms", "14 ms", "13 ms", "4.7 ms"]) {
      expect(header, ms).toContain(ms);
    }
    // the inline figures are the custom-plan numbers; the function call is planned generically and reads every lifetime match
    expect(header).toContain("generic plan");
    expect(header).toContain("4,925 buffers");

    // DEPLOY: apply first, then deploy; the reverse is safe on PGRST202
    expect(header).toContain("DEPLOY");
    expect(header).toContain("Apply 206 first, then deploy");
    expect(header).toContain("PGRST202");

    // ROLLBACK and NUMBER
    expect(header).toContain("ROLLBACK");
    expect(header).toContain("drop function public.entity_cluster_days(text[], text[], timestamptz, boolean)");
    expect(header).toContain("version = '206'");
    expect(header).toContain("NUMBER");
    expect(header).toContain("197 and 202 are reserved");

    // VERIFY carries the md5 and the length of THIS file's body, and the privilege and sample checks
    const at = raw.indexOf("-- VERIFY");
    const end = raw.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(raw.slice(at, end));
    const body = body206();
    expect(verify).toContain(`${md5(body)}, ${[...body].length}`);
    expect(md5(body)).not.toBe(PROD_V4_MD5);
    expect(verify).toContain("has_function_privilege('anon'");
    expect(verify).toContain("has_function_privilege('authenticated'");
    expect(verify).toContain("has_function_privilege('service_role'");
    expect(verify).toContain("false, false, true");
    expect(verify).toContain("15 rows");
    expect(verify).toContain("max(total)");
    expect(verify).toContain("entity_cluster_ids_v3");
    expect(verify).toContain("ozgur-ozel");
  });

  it("VERIFY's sample call uses the app's arrays for ozgur-ozel (not headline-only) and the same arrays for v3", () => {
    const raw = header206();
    const at = raw.indexOf("-- VERIFY");
    const end = raw.indexOf("-- ROLLBACK", at);
    const verify = flat(raw.slice(at, end));
    const entity = entityByKey("ozgur-ozel")!;
    const queries = entityHubQueries(entity);
    const patterns = entityHubPatterns(entity);
    expect(queries.length).toBeGreaterThan(0);
    // the first query and the first pattern as the app builds them: the call is not hand-typed
    const q = `array[${queries.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ")}]`;
    const p = `array[${patterns.map((x) => `'${x.replaceAll("'", "''")}'`).join(", ")}]`;
    expect(verify).toContain(`public.entity_cluster_days(${q}, ${p}, null, false)`);
    expect(verify).toContain(`public.entity_cluster_ids_v3(${q}, ${p}, null, 50, false)`);
  });
});

describe("206 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const has206 = guide.includes("\n## 206 ");
  const section = has206 ? sectionOf(guide, "206") : "";

  it("docs/migration-guide.md has a 206 section after 205 with Why, What, Order, Verify and Rollback and no fenced sql block", () => {
    expect(has206).toBe(true);
    expect(guide.indexOf("\n## 206 ")).toBeGreaterThan(guide.indexOf("\n## 205 "));
    expect(guide.includes("\n## 205 ")).toBe(true);
    expect(countOf(guide, "\n## 206 ")).toBe(1);

    for (const word of ["**Why:**", "**What 206 does**", "| md5(prosrc) | length |", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    // the md5 table: v4 untouched, the new body
    const body = body206();
    expect(section).toContain(PROD_V4_MD5);
    expect(section).toContain(String(PROD_V4_LENGTH));
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));

    // the heading
    expect(section.startsWith("\n## 206 — `/gundem/<key>` draws its clusters per day")).toBe(true);
    expect(section.split("\n")[1]).toContain(
      "(new `entity_cluster_days`: v4's match, counted by the Istanbul day of `first_published`): APPLY 206 FIRST, THEN DEPLOY the app",
    );

    // evidence, deploy order, verification and rollback
    for (const word of ["h154-hub-trend", "erdogan", "457", "PGRST202", "entity_cluster_ids_v4", "197", "202", "has_function_privilege", "schema_migrations", "version = '206'", "/gundem/ozgur-ozel", "Günlere göre küme sayısı"]) {
      expect(section, word).toContain(word);
    }
    expect(section).toContain("APPLY 206");
    expect(section).toContain("generic plan");
    expect(section).not.toContain("either order");
    const rollback = section.slice(section.indexOf("**Rollback:**"));
    expect(rollback).toContain("drop function public.entity_cluster_days(text[], text[], timestamptz, boolean)");
    expect(rollback).toContain("version = '206'");
    expect(rollback).not.toContain("drop function public.entity_cluster_ids_v");

    // no fenced block: tests/guards/docs-sql-snippets.test.ts scans those
    expect(section.includes("```")).toBe(false);
  });
});
