import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { entityByKey, entityHubPatterns, entityHubQueries, foldEntityText } from "../../src/lib/entities/entity-hub";
import { RISING_FOLD_FROM, RISING_FOLD_TO } from "../../src/lib/trends/rising-entities";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 170 ("entity_cluster_ids_headline_only"), h56-entities-2 (hunt 56).
//
// 125's entity_cluster_ids_v2 (body replaced by 156) runs the hub regex over title_tr, title_tr_neutral and the FIRST LINE
// of summary_tr. For /gundem/akp that lead is where an epithet sits: "eski AK Parti milletvekili Ertan Aydın", "AK Parti
// Samsun Milletvekili Mehmet Muş başkanlığında", a minister at an "AK Parti il danışma meclisi". Read-only replay on
// 2026-11-06: 303 clusters match, 174 name the party in a headline and 129 only in the lead, and most of those are not about
// the party. The other hubs keep the lead (the hunter measured their lead-only rows as mostly legitimate).
//
// 170 CREATES entity_cluster_ids_v3(p_queries, p_patterns, p_since, p_limit, p_headline_only boolean default false). Its
// body is 156's v2 body (production's, md5 pinned below) with ONE changed expression: the haystack is a CASE on the flag,
// the title and the neutral title alone when it is true, 156's exact expression otherwise. v2 is not touched, dropped or
// replaced: it is the app's fallback while 170 is unapplied.
//
// This file pins, without a database: the file, ledger and transaction, additive-only SQL, 156's body is production's (md5
// pinned, recomputed from the file), 170's body is 156's with that single substitution, the headline fold is the full fold
// minus exactly the summary term, the schema-qualified body, the grants, the docs section, the dry-run script and the
// live-manifest entry, and the JS twin of the predicate on the akp patterns. The opt-in live block (TAYF_PSQL) runs the
// function against fixtures.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_125 = "125_entity_cluster_ids_v2.sql";
const FILE_156 = "156_entity_cluster_ids_v3.sql";
const FILE_170 = "170_entity_cluster_ids_headline_only.sql";
const MIGRATION_156 = resolve(MIGRATIONS_DIR, FILE_156);
const MIGRATION_170 = resolve(MIGRATIONS_DIR, FILE_170);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "170-entity-cluster-ids-headline-only-dryrun.sql");

/** Production, read-only, 2026-11-06 ~21:10Z: md5(prosrc), length(prosrc) and the attributes of the v2 function 170 starts from. */
const PROD_MD5 = "81be59e839f81c6e738e32a658c2a8eb";
const PROD_LENGTH = 884;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.entity_cluster_ids_v3";
const FN_SIG = `${FN}(text[], text[], timestamptz, integer, boolean)`;
const V2_SIG = "public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('170', '170_entity_cluster_ids_headline_only') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

const FOLD_ARGS = `'${RISING_FOLD_FROM}', '${RISING_FOLD_TO}'`;
/** 156's summary term, the one term the headline fold leaves out. */
const SUMMARY_TERM = "pg_catalog.split_part(coalesce(c.summary_tr, ''), E'\\n', 1)";
const CASE_OPEN = "(case when p_headline_only then ";
const CASE_ELSE = " else ";
const CASE_CLOSE = " end)";

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

/** 156's file past its header: the transaction onward, so the header prose never counts as code. */
function codeOf156(sql: string): string {
  return sql.slice(sql.indexOf("\nbegin;"));
}

const sql156 = readFileSync(MIGRATION_156, "utf8");
const body156 = functionBody(codeOf156(sql156));
const sql170 = existsSync(MIGRATION_170) ? readFileSync(MIGRATION_170, "utf8") : "";
const header170 = (): string => {
  expect(existsSync(MIGRATION_170), `${FILE_170} must exist`).toBe(true);
  return sql170.split("\nbegin;")[0] as string;
};
const body170 = (): string => {
  expect(existsSync(MIGRATION_170), `${FILE_170} must exist`).toBe(true);
  return functionBody(sql170);
};

/** 156's haystack, as the normalised body holds it: from `pg_catalog.lower(` to the end of the fold call. */
function haystack156(): string {
  const body = collapse(body156);
  const start = body.indexOf("and pg_catalog.lower(pg_catalog.translate(");
  const end = body.indexOf(" ~ any (", start);
  expect(start, "156's haystack predicate").toBeGreaterThan(0);
  expect(end, "156's regex match").toBeGreaterThan(start);
  return body.slice(start + "and ".length, end);
}

/** 170's CASE expression, whole, with its two branches. */
function caseOf170(): { whole: string; head: string; full: string } {
  const body = collapse(body170());
  const open = body.indexOf(CASE_OPEN);
  expect(open, "the CASE on p_headline_only").toBeGreaterThan(0);
  const elseAt = body.indexOf(CASE_ELSE, open);
  const close = body.indexOf(CASE_CLOSE, elseAt);
  expect(elseAt, "the else branch").toBeGreaterThan(open);
  expect(close, "the end of the CASE").toBeGreaterThan(elseAt);
  return {
    whole: body.slice(open, close + CASE_CLOSE.length),
    head: body.slice(open + CASE_OPEN.length, elseAt),
    full: body.slice(elseAt + CASE_ELSE.length, close),
  };
}

describe("170 entity_cluster_ids_headline_only: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 170", () => {
    expect(existsSync(MIGRATION_170)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("170_"))).toEqual([FILE_170]);
  });

  it("sits after 156 and 125, and no later migration re-creates entity_cluster_ids_v3", () => {
    expect(FILE_170 > FILE_156 && FILE_156 > FILE_125).toBe(true);
    // 171 and later files sort after 170 by design; what must not happen is a second definition of the function 170 creates.
    const later = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && f > FILE_170);
    const redefiners = later.filter((f) =>
      collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).includes("create or replace function public.entity_cluster_ids_v3("),
    );
    expect(redefiners).toEqual([]);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(sql170);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql170, "\nbegin;")).toBe(1);
    expect(countOf(sql170, "\ncommit;")).toBe(1);
  });

  it("records version 170 in the schema_migrations ledger, idempotently (the 140-169 convention), as the last statement before commit", () => {
    const code = collapse(stripComments(sql170));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });
});

describe("170 entity_cluster_ids_headline_only: the production fingerprint it was built from", () => {
  it("156's function body is production's v2 body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body156)).toBe(PROD_MD5);
    expect([...body156].length).toBe(PROD_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 156's body", () => {
    const header = header170();
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5);
    expect(header).toContain(String(PROD_LENGTH));
    expect(header).toMatch(/prosecdef\s+t/);
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("equals the md5 of 156's body");
  });

  it("the header names the evidence, the akp numbers, the other hubs and the rollback", () => {
    const header = flat(header170());
    for (const word of [
      "h56-entities-2",
      "akp",
      "p_headline_only",
      "title_tr_neutral",
      "0f16f0f5",
      "cef0db8b",
      "fffc451b",
      "Ertan Aydın",
      "303",
      "174",
      "129",
      "chp",
      "mhp",
      "PGRST202",
      "ROLLBACK",
    ]) {
      expect(header, word).toContain(word);
    }
    expect(header).toContain("156_entity_cluster_ids_v3.sql");
    expect(header).toContain("drop function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)");
    expect(header).toContain("version = '170'");
    expect(header).toMatch(/^-- 170_entity_cluster_ids_headline_only\.sql/);
  });

  it("states that 156 is named v3 but defines v2, so the name entity_cluster_ids_v3 was free", () => {
    const header = flat(header170());
    expect(header).toMatch(/156_entity_cluster_ids_v3\.sql[^.]*(is named|named) v3 but (re-creates|defines) entity_cluster_ids_v2/);
    expect(header).toContain("no object named entity_cluster_ids_v3");
  });

  it("VERIFY carries the md5 and the length of THIS file's function body", () => {
    const body = body170();
    expect(header170()).toContain(`${md5(body)}, ${[...body].length}`);
    expect(md5(body)).not.toBe(PROD_MD5);
  });

  // Review fix mig170-verify-count-clamped: the function ends in `limit greatest(1, least(coalesce(p_limit, 20), 50))`,
  // so `select count(*) from ...(..., 50, true)` prints at most 50 whatever the true match count is, and cannot tell the
  // two modes apart. The full count is the `total` column (count(*) over () before the LIMIT).
  it("VERIFY reads the match count as max(total), not count(*), and passes the app's exact arrays for akp", () => {
    const header = header170();
    const at = header.indexOf("-- VERIFY");
    const end = header.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(header.slice(at, end));
    expect(verify).toContain("select max(total) from public.entity_cluster_ids_v3(");
    expect(verify).not.toContain("select count(*) from public.entity_cluster_ids_v3");
    expect(verify).toContain("count(*) would print 50, the limit clamp");
    expect(verify).toContain("about 174");
    expect(verify).toContain("about 303");
    const akp = entityByKey("akp")!;
    for (const q of entityHubQueries(akp)) expect(verify, `p_queries ${q}`).toContain(`'${q}'`);
    for (const pattern of entityHubPatterns(akp)) expect(verify, `p_patterns ${pattern}`).toContain(`'${pattern}'`);
  });

  // Review fix mig170-never-add-wording: the subset claim holds for akp's plain word-boundary regexes only.
  it("THE RULE limits 'headline matches are a subset of the lead matches' to akp's plain patterns and says the page fills with older rows", () => {
    const header = flat(header170());
    expect(header).not.toContain("never add one");
    expect(header).not.toContain("can only REMOVE rows the lead mode returns");
    expect(header).toContain("plain word-boundary regexes, no whole-text lookahead");
    expect(header).toContain("`total` can only fall");
    expect(header).toContain("older headline matches that were below the lead mode's page");
    expect(header).toContain("(erdogan, meclis, aym, tcmb)");
    expect(header).toContain("could GAIN a match in headline mode");
    expect(header).toContain("another reason the flag is set for akp alone");
  });
});

describe("170 entity_cluster_ids_headline_only: the function", () => {
  it("creates entity_cluster_ids_v3 with create or replace, 156's arguments plus p_headline_only boolean default false", () => {
    const header = collapse(functionHeader(stripComments(sql170))).toLowerCase();
    expect(
      header.startsWith(
        "create or replace function public.entity_cluster_ids_v3(p_queries text[], p_patterns text[], p_since timestamptz default null, p_limit integer default 20, p_headline_only boolean default false)",
      ),
    ).toBe(true);
    expect(header).toContain("returns table (id uuid, total bigint)");
  });

  it("is language sql, stable, security definer with an empty search_path (the attributes of v2)", () => {
    const header = functionHeader(stripComments(sql170));
    const h = collapse(header).toLowerCase();
    expect(h).toContain("language sql stable security definer set search_path = ''");
    expect(h).not.toContain("volatile");
    expect(h).not.toContain("security invoker");
    // v2's header, with the new argument cut out, is the same header
    const v2Header = collapse(functionHeader(stripComments(codeOf156(sql156)))).toLowerCase();
    expect(h.replace(", p_headline_only boolean default false", "").replace("entity_cluster_ids_v3", "entity_cluster_ids_v2")).toBe(v2Header);
  });

  it("the haystack is a CASE on the flag: the headline fold when true, 156's exact expression otherwise", () => {
    const { head, full } = caseOf170();
    expect(full).toBe(haystack156());
    expect(head.startsWith("pg_catalog.lower(pg_catalog.translate(")).toBe(true);
    expect(head.endsWith("))")).toBe(true);
    // the else branch is 156's, the one with the summary's first line
    expect(full).toContain(SUMMARY_TERM);
    expect(countOf(collapse(body170()), "case when")).toBe(1);
  });

  it("the headline branch folds title_tr and title_tr_neutral alone: 156's fold minus exactly the summary term", () => {
    const { head, full } = caseOf170();
    expect(head).toBe(
      "pg_catalog.lower(pg_catalog.translate(coalesce(c.title_tr, '') || ' ' || coalesce(c.title_tr_neutral, ''), " +
        `${FOLD_ARGS}))`,
    );
    expect(head).not.toContain("summary_tr");
    expect(head).not.toContain("split_part");
    expect(full.replace(` || ' ' || ${SUMMARY_TERM}`, "")).toBe(head);
    // the fold literals are migration 112's, from the same constants the app imports
    expect(countOf(collapse(body170()), FOLD_ARGS)).toBe(2);
  });

  it("the body is v2's body with that single substitution, nothing else", () => {
    const { whole, full } = caseOf170();
    expect(collapse(body170()).replace(whole, () => full)).toBe(collapse(body156));
    // the CASE appears once, and only the one expression moved
    expect(countOf(collapse(body170()), whole)).toBe(1);
    expect(collapse(body170())).not.toBe(collapse(body156));
  });

  it("the flag is read only by the CASE, and a null flag takes the else branch (the lead stays)", () => {
    const body = collapse(body170());
    expect(countOf(body, "p_headline_only")).toBe(1);
    expect(body).toContain("(case when p_headline_only then ");
    // no `coalesce(p_headline_only` is needed: `case when null` is the else branch, which is v2's behaviour
    expect(body).not.toContain("is true");
  });

  it("still ANDs the regex guard with the prefilter; every predicate is ANDed", () => {
    const body = collapse(body170());
    expect(body).toContain(
      "c.search_tsv @@ pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, pg_catalog.array_to_string(p_queries[1:12], ' or '))",
    );
    expect(body).toContain("~ any (pg_catalog.array_remove(p_patterns[1:12], ''))");
    expect(body.indexOf("c.search_tsv @@")).toBeLessThan(body.indexOf(CASE_OPEN));
    expect(body.indexOf(" end) ~ any (")).toBeGreaterThan(body.indexOf(CASE_OPEN));
    // With string literals blanked there is no OR left: every predicate is ANDed.
    expect(sansStrings(stripComments(body170()))).not.toMatch(/\bor\b/i);
  });

  it("keeps the 083 live predicate, the 14/30 day window, the 1..50 clamp, the total and the order", () => {
    const body = collapse(body170());
    expect(body).toContain("and not c.is_archived");
    expect(body).toContain("and c.article_count >= 2");
    expect(body).toContain("and c.merged_into is null");
    expect(sql170).toContain("and not c.is_archived      -- literal copy of the 083 partial-index predicate");
    expect(body).toContain(
      "c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '14 days'), pg_catalog.now() - interval '30 days')",
    );
    expect(body).toContain("limit greatest(1, least(coalesce(p_limit, 20), 50))");
    expect(body).toContain("(pg_catalog.count(*) over ())::bigint");
    expect(body).toContain("order by c.first_published desc, c.id");
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/);
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty)", () => {
    const code = sansStrings(stripComments(body170()));
    for (const rel of [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string)) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\./);
    }
    const calls = [...code.matchAll(/(?<![\w.])([a-z_][a-z0-9_]*)\s*\(/gi)]
      .map((m) => (m[1] as string).toLowerCase())
      .filter((n) => !["greatest", "least", "coalesce", "select", "in", "over", "interval", "any", "case", "and"].includes(n));
    expect(calls).toEqual([]);
  });

  it("the function comment names 170, the flag, akp and ends 'service_role only.'", () => {
    const comment = statementStartingWith(sql170, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment.endsWith("service_role only.'")).toBe(true);
    for (const word of ["170", "h56-entities-2", "p_headline_only", "akp", "title_tr_neutral", "entity_cluster_ids_v2"]) {
      expect(comment, word).toContain(word);
    }
  });
});

describe("170 entity_cluster_ids_headline_only: v2 stays as it is", () => {
  it("does not create, replace, drop, alter or comment on v2, and 156 still defines it with the summary's first line", () => {
    const code = collapse(sansStrings(stripComments(sql170)));
    expect(code).not.toContain("entity_cluster_ids_v2");
    expect(code).not.toMatch(/\bdrop\b/);
    expect(collapse(stripComments(codeOf156(sql156)))).toContain("create or replace function public.entity_cluster_ids_v2(");
    expect(body156).toContain(SUMMARY_TERM);
  });

  it("no earlier migration defines or mentions an object named entity_cluster_ids_v3 as code (156 is only NAMED v3)", () => {
    const owners: string[] = [];
    for (const f of readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith(".sql") && n !== FILE_170)) {
      const code = sansStrings(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).toLowerCase();
      if (code.includes("entity_cluster_ids_v3")) owners.push(f);
    }
    expect(owners).toEqual([]);
    // and 156's ledger row is the only place its own name carries v3 (a string literal)
    expect(readFileSync(MIGRATION_156, "utf8")).toContain("'156_entity_cluster_ids_v3'");
  });

  it("is the only migration that re-creates entity_cluster_ids_v2 after 125 and 156's (170 adds, it does not re-create)", () => {
    const redefiners = readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql") && n > FILE_125)
      .filter((n) =>
        collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"))).includes(
          "create or replace function public.entity_cluster_ids_v2(",
        ),
      );
    expect(redefiners).toEqual([FILE_156]);
  });
});

describe("170 entity_cluster_ids_headline_only: privileges", () => {
  const code = `${statements(sql170).join(";\n")};`;

  it("re-states the grants for the NEW signature: revoke from public/anon/authenticated, grant execute to service_role (156's lines)", () => {
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
    // 156 spells the same two statements for the 4-argument v2
    const code156 = statements(codeOf156(sql156)).join(";\n");
    expect(code156).toContain(REVOKE_STMT.replace(FN_SIG, V2_SIG));
    expect(code156).toContain(GRANT_STMT.replace(FN_SIG, V2_SIG));
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(sql170).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
    const sans = sansStrings(code).toLowerCase();
    expect(sans).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(table|tables|sequence|sequences)\b/);
    expect(sans).not.toMatch(/\balter\s+default\s+privileges\b/);
  });

  it("reloads the PostgREST schema cache, so the new function is callable without a restart", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("170 entity_cluster_ids_headline_only: additive, no data is written", () => {
  const stmts = statements(sql170);

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
    const body = sansStrings(stripComments(body170())).toLowerCase();
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate)\b/);
    expect(countOf(sansStrings(stripComments(sql170)).toLowerCase(), "create ")).toBe(1);
  });

  it("the one insert is the ledger row, written the way 156 and 169 do", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([LEDGER_STMT.slice(0, -1)]);
  });
});

describe("170 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 170 ") ? sectionOf(guide, "170") : "";

  it("sits directly after section 169 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 170 ")).toBeGreaterThan(guide.indexOf("\n## 169 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 169 ") + 1)).toBe(guide.indexOf("\n## 170 "));
  });

  it("has Why, What, an md5 table, Cost, Order, Verify and Rollback", () => {
    for (const word of [
      "**Why:**",
      "**What 170 does**",
      "| md5(prosrc) | length |",
      "**Cost**",
      "**Order:**",
      "**Verify**",
      "**Rollback:**",
    ]) {
      expect(section, word).toContain(word);
    }
    const body = body170();
    expect(section).toContain(PROD_MD5);
    expect(section).toContain(String(PROD_LENGTH));
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });

  it("states the evidence and the rule", () => {
    for (const word of [
      "h56-entities-2",
      "akp",
      "p_headline_only",
      "0f16f0f5",
      "cef0db8b",
      "fffc451b",
      "Ertan Aydın",
      "303",
      "174",
      "129",
      "chp",
      "mhp",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("states the deploy order: migration first, then the app, and the app degrades to v2 on PGRST202", () => {
    expect(section).toContain("APPLY 170");
    expect(section).toMatch(/migration first/i);
    expect(section).toContain("PGRST202");
    expect(section).toContain("entity_cluster_ids_v2");
    expect(section).toContain("entity_cluster_ids_v3");
  });

  it("verifies the fingerprint, the privileges, the ledger and the hub", () => {
    for (const word of [
      "md5(prosrc)",
      "has_function_privilege",
      "schema_migrations",
      "version = '170'",
      "entity_cluster_ids_v3",
      "/gundem/akp",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that drops only the new function and deletes only the 170 ledger row; v2 is untouched", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("drop function public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)");
    expect(rb).toContain("version = '170'");
    expect(rb).not.toContain("drop function public.entity_cluster_ids_v2");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("170 live manifest and dry-run", () => {
  it("builds 170's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 170-entity-cluster-ids-headline-only.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/170-entity-cluster-ids-headline-only-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 156's state (gated on the production md5), shows the defect, applies 170 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/156_entity_cluster_ids_v3.sql",
      "../../../supabase/migrations/170_entity_cluster_ids_headline_only.sql",
      "../../../supabase/migrations/170_entity_cluster_ids_headline_only.sql",
    ]);
    expect(sql).toContain(PROD_MD5);
    expect(sql).toContain(md5(body170()));
    expect(sql).toContain("baseline: v2 (156) lists a cluster that names the party only in the summary lead");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 170 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// The predicate itself, through a test-only twin: Postgres' `\m` / `\M` word anchors both become JS `\b` (as in
// src/lib/entities/entity-hub.test.ts) and `split_part(x, E'\n', 1)` is `x.split("\n")[0]`. Fixtures are stored rows
// of the 2026-11-06 replay.
// ---------------------------------------------------------------------------

function pgPatternToJs(pattern: string): RegExp {
  return new RegExp(pattern.replace(/\\[mM]/g, "\\b"));
}

interface Row {
  title: string;
  neutral: string;
  summary: string;
}

/** What 156's v2 matches on: the title, the neutral title and the first line of the summary. */
function textLead(c: Row): string {
  return `${c.title} ${c.neutral} ${c.summary.split("\n")[0] ?? ""}`;
}

/** What 170 matches on with p_headline_only = true: the title and the neutral title. */
function textHeadline(c: Row): string {
  return `${c.title} ${c.neutral}`;
}

/** The twin of the CASE: the flag picks the text, then the hub's own patterns run on the folded text. */
function hubHit(key: string, c: Row, headlineOnly: boolean): boolean {
  const folded = foldEntityText(headlineOnly ? textHeadline(c) : textLead(c));
  return entityHubPatterns(entityByKey(key)!).some((p) => pgPatternToJs(p).test(folded));
}

const BUDGET: Row = {
  title: "Kültür ve Turizm Bakanlığının 2027 yılı bütçesi TBMM Plan ve Bütçe Komisyonunda",
  neutral: "Kültür ve Turizm Bakanlığının 2027 yılı bütçesi TBMM Plan ve Bütçe Komisyonunda",
  summary: "TBMM Plan ve Bütçe Komisyonunda, AK Parti Samsun Milletvekili Mehmet Muş başkanlığında toplandı.",
};
const POLL: Row = {
  title: "Bu kez araştırma partiden geldi. AK Parti'nin kalesinde tam 15 puanlık erime",
  neutral: "",
  summary: "Bir anket şirketi sonuçları paylaştı.",
};
const AKPLI: Row = {
  title: "Fatma Betül'ün tutuklanmasının ardından AKP'li isimden olay sözler",
  neutral: "",
  summary: "Büyük sürprizlere hazır olun.",
};
const EX_MP: Row = {
  title: "Fon soruşturması: Adli kontrolle serbest bırakılan Ertan Aydın itiraz üzerine tutuklandı",
  neutral: "",
  summary: "İstanbul Cumhuriyet Başsavcılığının fon soruşturmasında AK Parti eski milletvekili Ertan Aydın ile Türkiye Sigorta yöneticisi tutuklandı.",
};

describe("the 170 predicate on the akp patterns (twin of the SQL)", () => {
  it("a budget-committee story that names the party only in the summary lead is out with headlineOnly, and in without", () => {
    expect(hubHit("akp", BUDGET, false)).toBe(true);
    expect(hubHit("akp", BUDGET, true)).toBe(false);
  });

  it("a headline that names the party stays, in both modes", () => {
    for (const row of [POLL, AKPLI]) {
      expect(hubHit("akp", row, true), row.title).toBe(true);
      expect(hubHit("akp", row, false), row.title).toBe(true);
    }
  });

  it("an ex-MP epithet in the lead drops, the neutral title counts as a headline", () => {
    expect(hubHit("akp", EX_MP, false)).toBe(true);
    expect(hubHit("akp", EX_MP, true)).toBe(false);
    const neutralNames: Row = { ...EX_MP, neutral: "AK Parti eski milletvekili Ertan Aydın tutuklandı" };
    expect(hubHit("akp", neutralNames, true)).toBe(true);
  });

  it("for akp, whose patterns are plain word-boundary regexes, the headline matches are a subset of the lead matches", () => {
    const rows = [BUDGET, POLL, AKPLI, EX_MP, { title: "", neutral: "", summary: "AKP" }, { title: "AKP", neutral: "", summary: "" }];
    for (const row of rows) {
      if (hubHit("akp", row, true)) expect(hubHit("akp", row, false), `akp: ${row.title}`).toBe(true);
    }
  });

  it("a hub whose patterns carry an excludes lookahead can GAIN a match in headline mode: why the flag stays off for it", () => {
    // erdogan's bare-name pattern opens with a negative lookahead over the whole folded text (Emine Erdoğan ...). The cue
    // is in the lead only, so the lead text is vetoed and the headline text is not.
    const row: Row = { title: "Erdoğan Seul'de konuştu", neutral: "", summary: "Emine Erdoğan da törene katıldı" };
    expect(hubHit("erdogan", row, true)).toBe(true);
    expect(hubHit("erdogan", row, false)).toBe(false);
  });

  it("only the first summary line counts in the lead mode (156), and none counts in the headline mode", () => {
    const second: Row = { title: "Gündem", neutral: "", summary: "İlk satır.\nAKP açıklaması geldi." };
    expect(hubHit("akp", second, false)).toBe(false);
    expect(hubHit("akp", second, true)).toBe(false);
    const first: Row = { title: "Gündem", neutral: "", summary: "AKP açıklaması geldi.\nİkinci satır." };
    expect(hubHit("akp", first, false)).toBe(true);
    expect(hubHit("akp", first, true)).toBe(false);
  });

  it("the other hubs are unaffected: the app sends the flag only for akp, and their lead still matches", () => {
    const lead: Row = { title: "Komisyon toplandı", neutral: "", summary: "CHP Genel Başkanı Özel açıklama yaptı." };
    expect(hubHit("chp", lead, false)).toBe(true);
  });

  it("folds like migration 112: a dotted capital İ in a headline still matches", () => {
    const row: Row = { title: "AK PARTİ'den açıklama", neutral: "", summary: "" };
    expect(hubHit("akp", row, true)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway Postgres with 156 then 170 applied by the dry-run
// script (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select
// the server. Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("170 entity_cluster_ids_v3 against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("170", {
    ledger: ["156", "170"],
    relations: ["public.clusters"],
    functions: [
      "public.entity_cluster_ids_v2(text[],text[],timestamptz,integer)",
      "public.entity_cluster_ids_v3(text[],text[],timestamptz,integer,boolean)",
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
  const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);
  const arr = (items: readonly string[]): string => `array[${items.map(lit).join(", ")}]::text[]`;

  const AKP_QUERIES = ["ak parti", "akp", "ak partili", "ak partimize"];
  const AKP_PATTERNS = entityHubPatterns(entityByKey("akp")!);

  interface Cl {
    n: number;
    title: string | null;
    neutral?: string | null;
    summary?: string | null;
    count?: number;
    archived?: boolean;
    merged?: boolean;
    /** days since updated_at */
    ageDays?: number;
    /** minutes since first_published, for ordering */
    publishedMinutes?: number;
  }

  function fixture(rows: Cl[]): string {
    const values = rows
      .map(
        (c) =>
          `(${lit(clusterUuid(c.n))}, ${lit(c.title)}, ${lit(c.neutral ?? null)}, ${lit(c.summary ?? null)}, ${c.count ?? 3}, ${c.archived ? "true" : "false"}, ${c.merged ? lit(clusterUuid(900)) : "null"}, now() - interval '${c.ageDays ?? 1} days', now() - interval '${c.publishedMinutes ?? c.n} minutes')`,
      )
      .join(",\n  ");
    return `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, merged_into, updated_at, first_published) values\n  ${values};\n`;
  }

  /** Runs the fixture, then the given statements, in begin ... rollback; returns the output lines. */
  function inTx(rows: Cl[], statementsAfter: string): string[] {
    return runPsql(`begin;\n${fixture(rows)}${statementsAfter}rollback;\n`)
      .split("\n")
      .filter((l) => l.trim() !== "");
  }

  const call = (fn: "v2" | "v3", flag: string | null, opts: { queries?: readonly string[]; limit?: number } = {}): string => {
    const q = arr(opts.queries ?? AKP_QUERIES);
    const p = arr(AKP_PATTERNS);
    const limit = opts.limit ?? 50;
    if (fn === "v2") return `public.entity_cluster_ids_v2(${q}, ${p}, null, ${limit})`;
    return flag === "omitted"
      ? `public.entity_cluster_ids_v3(${q}, ${p}, null, ${limit})`
      : `public.entity_cluster_ids_v3(${q}, ${p}, null, ${limit}, ${flag ?? "null"})`;
  };

  /** The fixture numbers a call returns, in the function's order, joined by commas ("-" for none), then the total. */
  const ids = (fnCall: string): string =>
    `select coalesce(string_agg(right(id::text, 12)::int::text, ',' order by ord), '-') || '/' || coalesce(max(total), 0) from (select id, total, row_number() over () as ord from ${fnCall}) s;\n`;

  function run(rows: Cl[], fnCall: string): string {
    return inTx(rows, ids(fnCall))[0] as string;
  }

  const BUDGET_ROW: Cl = { n: 1, title: BUDGET.title, neutral: BUDGET.neutral, summary: BUDGET.summary };
  const POLL_ROW: Cl = { n: 2, title: POLL.title, neutral: POLL.neutral, summary: POLL.summary };
  const AKPLI_ROW: Cl = { n: 3, title: AKPLI.title, neutral: AKPLI.neutral, summary: AKPLI.summary };

  it("the function that runs is the file's: md5 and length of prosrc, the five arguments, stable, security definer, empty search_path, service_role only", () => {
    const out = runPsql(
      "select md5(prosrc) || '|' || length(prosrc) || '|' || provolatile::text || '|' || prosecdef || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = 'public.entity_cluster_ids_v3(text[], text[], timestamptz, integer, boolean)'::regprocedure;",
    ).trim();
    const body = body170();
    expect(out).toBe(
      `${md5(body)}|${[...body].length}|s|true|{"search_path=\\"\\""}|TABLE(id uuid, total bigint)|p_queries text[], p_patterns text[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 20, p_headline_only boolean DEFAULT false`,
    );
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
  });

  it("v2 is untouched: its prosrc is production's, its signature has four arguments, and there is exactly one v3 and one v2", () => {
    const out = runPsql(
      "select md5(prosrc) || '|' || length(prosrc) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = 'public.entity_cluster_ids_v2(text[], text[], timestamptz, integer)'::regprocedure;",
    ).trim();
    expect(out).toBe(
      `${PROD_MD5}|${PROD_LENGTH}|p_queries text[], p_patterns text[], p_since timestamp with time zone DEFAULT NULL::timestamp with time zone, p_limit integer DEFAULT 20`,
    );
    expect(runPsql("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'entity_cluster_ids_v%';").trim()).toBe("2");
  });

  it("is idempotent: one 170 ledger row, and the stored comment names 170", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '170';").trim()).toBe("1");
    expect(runPsql(`select obj_description('${FN_SIG}'::regprocedure, 'pg_proc');`)).toContain("170");
  });

  it("flag false is v2: the same ids, the same order, the same total", () => {
    const rows: Cl[] = [BUDGET_ROW, POLL_ROW, AKPLI_ROW, { n: 4, title: "Hava durumu", summary: "AKP'li belediye başkanı konuştu" }];
    expect(run(rows, call("v3", "false"))).toBe(run(rows, call("v2", null)));
    expect(run(rows, call("v3", "false"))).toBe("1,2,3,4/4");
  });

  it("flag true drops the cluster that names the party only in the summary lead, and keeps the headline ones", () => {
    expect(run([BUDGET_ROW, POLL_ROW, AKPLI_ROW], call("v3", "true"))).toBe("2,3/2");
  });

  it("the neutral title counts as a headline", () => {
    expect(run([{ n: 1, title: "Komisyon toplandı", neutral: "AK Parti'den açıklama", summary: "x" }], call("v3", "true"))).toBe("1/1");
  });

  it("an omitted flag and a null flag are the lead mode (v2's behaviour), not an error", () => {
    const rows: Cl[] = [BUDGET_ROW, POLL_ROW];
    expect(run(rows, call("v3", "omitted"))).toBe("1,2/2");
    expect(run(rows, call("v3", "null"))).toBe("1,2/2");
  });

  it("the summary counts only through its first line, in the lead mode (156), and not at all in the headline mode", () => {
    const rows: Cl[] = [
      { n: 1, title: "Gündem", summary: "İlk satır.\nAKP açıklaması geldi." },
      { n: 2, title: "Gündem", summary: "AKP açıklaması geldi.\nİkinci satır." },
    ];
    expect(run(rows, call("v3", "false"))).toBe("2/1");
    expect(run(rows, call("v3", "true"))).toBe("-/0");
  });

  it("the prefilter is still ANDed: a headline that matches the regex but not the queries is not returned", () => {
    expect(run([POLL_ROW], call("v3", "true", { queries: ["zelenski"] }))).toBe("-/0");
    expect(run([POLL_ROW], call("v3", "false", { queries: ["zelenski"] }))).toBe("-/0");
  });

  it("the live predicate is v2's: archived, merged, single-article and 31-day-old clusters are never returned", () => {
    const rows: Cl[] = [
      { ...POLL_ROW, n: 1 },
      { ...POLL_ROW, n: 2, archived: true },
      { ...POLL_ROW, n: 3, merged: true },
      { ...POLL_ROW, n: 4, count: 1 },
      { ...POLL_ROW, n: 5, ageDays: 31 },
      { ...POLL_ROW, n: 6, ageDays: 13 },
    ];
    expect(run(rows, call("v3", "true"))).toBe("1,6/2");
    expect(run(rows, call("v3", "false"))).toBe(run(rows, call("v2", null)));
  });

  it("keeps the order (first_published desc, then id), the total before the limit and the 1..50 clamp", () => {
    const rows: Cl[] = Array.from({ length: 55 }, (_, i) => ({ ...POLL_ROW, n: i + 1, publishedMinutes: i + 1 }));
    const first = (limit: number): string[] => (run(rows, call("v3", "true", { limit })).split("/")[0] as string).split(",");
    expect(first(3)).toEqual(["1", "2", "3"]);
    expect(first(1000)).toHaveLength(50);
    expect(first(0)).toEqual(["1"]);
    expect(run(rows, call("v3", "true", { limit: 3 })).endsWith("/55")).toBe(true);
  });
});
