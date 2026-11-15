import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { EXTRACTIVE_MODEL_ID } from "../../src/lib/clusters/neutral-title";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 214 ("neutral_title_repick_fast"), h189 (hunt 189).
//
// 209 made public.neutral_title_repick_candidates(text, integer) walk the outlet's last fifteen days through a hashed IN (5,199 titles,
// one cluster_articles probe each), and the headline cron, which calls it every 5 minutes through PostgREST under an 8 s
// statement_timeout, began to log 57014 and record 599 on about 2% of its runs. 214 re-creates the SAME function (signature, return
// type, volatility, SECURITY DEFINER, empty search_path, ACL, every predicate of 208 and 209, the same candidate set in the same order)
// with a body that reads the same data once and folds each title once:
//   - the 14-day window (newest 5000) is one materialized CTE `w` that also carries the house fold of the stored title;
//   - the 7-day title versions and the isci-haber article ids (ids only, from the covering index) are probed into cluster_articles
//     by ONE `= ANY (array)` index scan (`mem`), not one probe per row;
//   - the stale rule and the isci title rule join that small set to `w` in memory (no clusters_pkey probe per candidate, no title
//     fetched for the 5,199 isci articles);
//   - branch A tests three literal substrings before its regular expression, the placeholder and teaser rules read the fold of `w`.
// This file pins, without a database: the ledger row and the single transaction, additive-only SQL, 209's body is production's, that
// no predicate of 208/209 was dropped (every SQL string literal of 209's body is in 214's, and the only new ones are the three branch-A
// prefilters), that every unchanged arm is byte for byte 209's, the grants, the comment and the header. The live block (TAYF_PSQL)
// runs 209's body and the shipped function side by side on fixtures and on a seeded random population and asserts the same ids in the
// same order.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL js/redos).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_209 = "209_neutral_title_repick_loaded_cased.sql";
const FILE_214 = "214_neutral_title_repick_fast.sql";
const MIGRATION_209 = resolve(MIGRATIONS_DIR, FILE_209);
const MIGRATION_214 = resolve(MIGRATIONS_DIR, FILE_214);

/** Production, read-only, 2026-11-15 (h189 STEP 0): md5(prosrc), length(prosrc) and the ACL of the function 214 starts from = 209's. */
const PROD_MD5 = "cf7458daa1b7b96e750c5583693e2608";
const PROD_LENGTH = 11078;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";
/** What 214's body hashes to (computed from the file; pinned here so a stray edit shows). */
const NEW_MD5 = "6ec3157704dee41e96daf0d744c35b7a";
const NEW_LENGTH = 10484;

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('214', '214_neutral_title_repick_fast') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;
const COMMENT_TAIL_209 = "Migrations 141, 155, 162, 169, 184, 200, 208, 209.'";
const COMMENT_TAIL_214 = "Migrations 141, 155, 162, 169, 184, 200, 208, 209, 214.'";

/** 209's outer WHERE opens here and its OR chain ends before the final order by. */
const CHAIN_OPEN = "   where w.title_neutral_model is distinct from p_model";
const ORDER_LINE = "   order by w.updated_at desc\n";

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

/** Whitespace runs to one space, the space inside a parenthesis dropped. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replaceAll("( ", "(").replaceAll(" )", ")").trim();
}

/** Comment block read as prose: `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replaceAll(/\n--\s*/g, " ").replace(/\s+/g, " ");
}

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two $fn$ markers: Postgres' prosrc. Comments in the file header are not part of it. */
function functionBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  expect(open, "an opening $fn$").toBeGreaterThanOrEqual(0);
  expect(close, "a closing $fn$").toBeGreaterThan(open);
  return sql.slice(open + 4, close);
}

/** `create or replace function ... as ` up to and including the opening $fn$ marker. */
function functionHeader(sql: string): string {
  // The statement starts a line (the header comments say "create or replace function" in prose too).
  const at = sql.indexOf("\ncreate or replace function");
  const open = sql.indexOf("$fn$", at);
  expect(at, "create or replace function").toBeGreaterThanOrEqual(0);
  return sql.slice(at + 1, open + 4);
}

/** Top-level statements: split on ';' outside single-quoted strings, `--` comments and $fn$ bodies; comments dropped. */
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

/** Statements with the $fn$ body replaced by a marker and whitespace collapsed. */
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

/** Every single-quoted string literal of `sql`, unescaped (a doubled quote is one quote), in order. */
function sqlLiterals(sql: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < sql.length) {
    if (sql.charAt(i) !== "'") {
      i++;
      continue;
    }
    let j = i + 1;
    let lit = "";
    while (j < sql.length) {
      if (sql.charAt(j) === "'") {
        if (sql.charAt(j + 1) === "'") {
          lit += "'";
          j += 2;
          continue;
        }
        break;
      }
      lit += sql.charAt(j);
      j++;
    }
    out.push(lit);
    i = j + 1;
  }
  return out;
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

const sql209 = readFileSync(MIGRATION_209, "utf8");
const body209 = functionBody(sql209);
const sql214 = existsSync(MIGRATION_214) ? readFileSync(MIGRATION_214, "utf8") : "";
const header214 = (): string => {
  expect(existsSync(MIGRATION_214), `${FILE_214} must exist`).toBe(true);
  return sql214.split("\nbegin;")[0] as string;
};
const body214 = (): string => {
  expect(existsSync(MIGRATION_214), `${FILE_214} must exist`).toBe(true);
  return functionBody(sql214);
};

/** 209's ten OR arms of the outer WHERE, in 209's order (no leading `or`). */
function arms209(): string[] {
  const open = body209.indexOf(CHAIN_OPEN);
  const close = body209.lastIndexOf(ORDER_LINE);
  expect(open).toBeGreaterThan(0);
  expect(close).toBeGreaterThan(open);
  const chain = body209.slice(open + "   where ".length, close).trimEnd();
  const arms = chain.split("\n      or ");
  expect(arms).toHaveLength(10);
  return arms;
}
const ARM = { model: 0, nullCount: 1, growth: 2, stale: 3, gate: 4, young: 5, shout: 6, placeholderTeaser: 7, loaded: 8, casing: 9 } as const;

/** The key 200 and 209 compute of a folded title: quotation marks outside a word kept as chr(1), every other mark dropped. */
const KEY = (folded: string): string =>
  "pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(" +
  `${folded}, pg_catalog.chr(1), '', 'g'), ` +
  "'(?<![a-z0-9])[''‘’\"“”«»]|[''‘’\"“”«»](?![a-z0-9])', pg_catalog.chr(1), 'g'), " +
  "'[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), " +
  "'^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g')";

describe("214 neutral_title_repick_fast: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 214", () => {
    expect(existsSync(MIGRATION_214)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("214_"))).toEqual([FILE_214]);
  });

  it("sits after 213 and leaves 209 alone (209 is the rollback target)", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("213_")).length).toBe(1);
    expect(md5(body209)).toBe(PROD_MD5);
    expect(body209.length).toBe(PROD_LENGTH);
  });

  it("runs in one transaction with the lock and statement timeouts, and records its ledger row", () => {
    const code = stripComments(sql214);
    const stmts = statements(code);
    expect(stmts[0]).toBe("begin");
    expect(stmts.at(-1)).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
    expect(stmts).toContain(LEDGER_STMT.slice(0, -1));
    expect(countOf(code, "begin;")).toBe(1);
    expect(countOf(code, "commit;")).toBe(1);
    expect(countOf(code, "schema_migrations")).toBe(1);
  });

  it("is additive only: one function re-created, a comment, the grants and the ledger insert; no index, no table, no GUC", () => {
    const stmts = statements(stripComments(sql214));
    expect(stmts).toHaveLength(10);
    const heads = stmts.map((s) => s.split(" ").slice(0, 3).join(" ").toLowerCase());
    expect(heads).toEqual([
      "begin",
      "set local lock_timeout",
      "set local statement_timeout",
      "create or replace",
      "comment on function",
      "revoke all on",
      "grant execute on",
      "notify pgrst, 'reload",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ]);
    const code = sansStrings(stripComments(sql214).split("$fn$").filter((_, i) => i % 2 === 0).join(" "));
    for (const forbidden of [
      "alter table",
      "create table",
      "drop ",
      "create index",
      "create trigger",
      "update ",
      "delete ",
      "truncate",
      "grant select",
      "grant all",
      "alter system",
      "alter database",
      "alter role",
      "set_config",
    ]) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // The function body only reads.
    const fnBody = sansStrings(body214()).toLowerCase();
    for (const write of ["insert ", "update ", "delete ", "truncate", "alter ", "create ", "drop ", "set_config", "nextval"]) {
      expect(fnBody, write).not.toContain(write);
    }
  });

  it("does not bump the model and does not touch the cron", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
    expect(sql214).not.toContain("extractive-v7");
    expect(sql214).not.toContain("cron.schedule");
    expect(sql214).not.toContain("cron.alter_job");
  });
});

describe("214 neutral_title_repick_fast: the body", () => {
  it("has the pinned fingerprint", () => {
    expect(md5(body214())).toBe(NEW_MD5);
    expect(body214().length).toBe(NEW_LENGTH);
    expect(body214()).not.toBe(body209);
  });

  it("keeps the signature, volatility, security definer and search_path of 209", () => {
    expect(functionHeader(sql214)).toBe(functionHeader(sql209));
    expect(collapse(functionHeader(sql214))).toBe(
      "create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20) " +
        "returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint) " +
        "language sql stable security definer set search_path = '' as $fn$",
    );
  });

  it("drops no predicate: every SQL string literal of 209's body is in 214's, and the only new ones are the three branch-A prefilters", () => {
    const old = new Set(sqlLiterals(body209));
    const neu = new Set(sqlLiterals(body214()));
    expect([...old].filter((lit) => !neu.has(lit))).toEqual([]);
    expect([...neu].filter((lit) => !old.has(lit)).sort()).toEqual(["atil", "hale", "rant"]);
    // The regular-expression literals are the same count in the places they are used: each 209 regular expression is still used.
    for (const lit of old) {
      if (lit.length >= 12) expect(body214(), lit).toContain(`'${lit.split("'").join("''")}'`);
    }
  });

  it("keeps every unchanged arm of the OR chain byte for byte (model, null stamp, growth, gate, young, shout)", () => {
    const arms = arms209();
    const body = body214();
    for (const key of ["model", "nullCount", "growth", "gate", "young", "shout"] as const) {
      expect(body, key).toContain(arms[ARM[key]] as string);
    }
    // ... in 209's order, and each one an alternative of the chain.
    const at = (key: keyof typeof ARM): number => body.indexOf(arms[ARM[key]] as string);
    expect(at("model")).toBeLessThan(at("nullCount"));
    expect(at("nullCount")).toBeLessThan(at("growth"));
    expect(at("growth")).toBeLessThan(at("gate"));
    expect(at("gate")).toBeLessThan(at("young"));
    expect(at("young")).toBeLessThan(at("shout"));
    expect(body).toContain("   where w.title_neutral_model is distinct from p_model\n      or w.title_neutral_member_count is null\n");
  });

  it("the placeholder and teaser rule is 209's with the stored title's fold read once (w.f), not recomputed", () => {
    const arm = arms209()[ARM.placeholderTeaser] as string;
    const fold = "public.tayf_search_fold(w.title_tr_neutral)";
    expect(countOf(arm, fold)).toBe(3);
    const expected = arm.replaceAll(fold, "w.f");
    expect(body214()).toContain(expected);
    expect(body214()).not.toContain(fold);
    // The fold of the stored title is computed once per window row, in the window CTE.
    expect(countOf(body214(), "public.tayf_search_fold(c.title_tr_neutral)")).toBe(1);
    expect(countOf(body214(), "w.f")).toBeGreaterThanOrEqual(4);
  });

  it("branch A (loaded epithet) is 209's expression behind three literal substrings every alternative of it contains", () => {
    const loaded = arms209()[ARM.loaded] as string;
    const body = body214();
    expect(body).toContain(`and ${loaded}`);
    const prefilter =
      "((pg_catalog.strpos(w.title_tr_neutral, 'atil') > 0\n" +
      "           or pg_catalog.strpos(w.title_tr_neutral, 'hale') > 0\n" +
      "           or pg_catalog.strpos(w.title_tr_neutral, 'rant') > 0)\n" +
      "          and ";
    expect(body).toContain(`or ${prefilter}${loaded})`);
    // Each alternative of the loaded rule holds one of the three literals (the substrings are the lower-case tails of [Kk]atil, [İi]hale and rant).
    for (const alt of ["[Kk]atil(?:ler)?", "[Kk]atil[[:space:]]+", "[İi]hale[[:space:]]+rant", "rant[[:space:]]+kap"]) {
      expect(loaded, alt).toContain(alt);
    }
    // It is a necessary condition: a title that holds none of them cannot match any alternative, so it is never tested.
    for (const lit of ["atil", "hale", "rant"]) expect(sqlLiterals(body)).toContain(lit);
  });

  it("branch B's word scan is 209's byte for byte; only the cluster test in front of it changed (a set of clusters, not a hashed IN of titles)", () => {
    const casing = (arms209()[ARM.casing] as string).trimEnd();
    const scanAt = casing.indexOf("\n          and exists (");
    expect(scanAt).toBeGreaterThan(0);
    const scan = casing.slice(scanAt);
    expect(body214()).toContain(`(w.id in (select b.cluster_id from bcand b)${scan}`);
    // 209 hashed the outlet's whole last fifteen days (cluster and title) and probed cluster_articles once per article: gone.
    expect(body209).toContain("(w.id, pg_catalog.btrim(w.title_tr_neutral)) in (");
    expect(body214()).not.toContain("(w.id, pg_catalog.btrim(w.title_tr_neutral)) in (");
    expect(body214()).not.toContain("btrim(ai.title)");
  });

  it("the stale rule keeps 209's three conditions and key, joined to the window in memory instead of probing clusters per pair", () => {
    const body = body214();
    // 209's key of the stored title and of the old title and of a member's title (and the Başkan -> Cumhurbaşkanı spelling) are the same text.
    expect(body209).toContain(KEY("public.tayf_search_fold(c.title_tr_neutral)"));
    expect(body).toContain(KEY("w.f"));
    expect(body).toContain(KEY("public.tayf_search_fold(p.old_title)"));
    expect(body).toContain(KEY("public.tayf_search_fold(a2.title)"));
    expect(body).toContain(
      KEY("public.tayf_search_fold(pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan'))"),
    );
    // 7-day window of versions; non-empty key; the key of the stored title is in the old title's; no current member carries it.
    expect(body).toContain("where v.seen_at > pg_catalog.now() - interval '7 days'");
    expect(body).toContain("where k.sk <> ''");
    expect(body).toContain("pg_catalog.strpos(k.fo, k.sk) > 0");
    expect(body).toContain("and not exists (");
    expect(body).toContain("or w.id in (select s.cluster_id from stale s)");
    // The two keys are computed once per pair (an `offset 0` lateral stops the planner from inlining them into every use).
    expect(body).toContain("offset 0");
    // clusters is read once (the window): the stale rule no longer probes clusters_pkey per pair.
    expect(countOf(body, "public.clusters")).toBe(1);
    expect(countOf(body209, "public.clusters")).toBe(2);
  });

  it("reads the window once and bounds every set: 14-day window, newest 5000, 7-day versions, 15-day isci ids, limit clamp 1..50", () => {
    const body = body214();
    expect(body).toContain("with w as materialized (");
    expect(body).toContain("and c.updated_at > pg_catalog.now() - interval '14 days'");
    expect(body).toContain("order by c.updated_at desc\n     limit 5000");
    expect(body).toContain("and ai.published_at > pg_catalog.now() - interval '15 days'");
    expect(body).toContain("limit least(greatest(coalesce(p_limit, 20), 1), 50);");
    expect(body).toContain("order by w.updated_at desc, w.id\n");
    // 209's window conditions, each one still on the window select.
    for (const cond of [
      "where c.is_archived = false",
      "and c.title_neutral_at is null",
      "and c.title_tr_neutral is not null",
      "and c.article_count >= 2",
    ]) {
      expect(body, cond).toContain(cond);
    }
  });

  it("probes cluster_articles for the versions and the isci ids with ONE index scan on an array, and fetches no isci title for the rest", () => {
    const body = body214();
    expect(body).toContain("where ca.article_id = any (array(select x.article_id from ver x union select y.id from isci y))");
    expect(countOf(body, "any (array(")).toBe(1);
    // The isci CTE selects ids only (no title, so the 5,199 heap fetches of 209 are gone) from the outlet's last fifteen days.
    const at = body.indexOf("  isci as materialized (");
    const stop = body.indexOf("  ),", at);
    const isci = collapse(body.slice(at, stop + 4));
    expect(isci).toBe(
      "isci as materialized (select ai.id from public.sources si join public.articles ai on ai.source_id = si.id " +
        "where si.slug = 'isci-haber' and ai.published_at > pg_catalog.now() - interval '15 days'),",
    );
    // The isci member's title is read only for the isci members of window clusters, to compare it with the stored title.
    expect(body).toContain("where pg_catalog.btrim(ab.title) = pg_catalog.btrim(w.title_tr_neutral)");
    // cluster_articles: the one array scan, the stale rule's member check, and the word scan's three reads (cj, ck, cv).
    expect(countOf(body, "public.cluster_articles")).toBe(5);
    expect(countOf(body209, "public.cluster_articles")).toBe(6);
  });

  it("qualifies every function it calls (search_path is empty) and names the house fold of 129", () => {
    const code = sansStrings(body214());
    expect(countOf(code, "tayf_search_fold(")).toBe(countOf(code, "public.tayf_search_fold("));
    for (const fn of [
      "regexp_replace(",
      "regexp_matches(",
      "btrim(",
      "left(",
      "count(",
      "now()",
      "bool_or(",
      "strpos(",
      "char_length(",
      "chr(",
    ]) {
      expect(countOf(code, fn), fn).toBe(countOf(code, `pg_catalog.${fn}`));
    }
    // replace( is also the tail of regexp_replace(: count it apart.
    expect(countOf(code, "replace(") - countOf(code, "regexp_replace(")).toBe(countOf(code, "pg_catalog.replace("));
    expect(countOf(code, "pg_catalog.replace(")).toBeGreaterThanOrEqual(1);
    for (const fn of ["lower(", "translate(", "substr(", "string_agg(", "array_agg(", "md5("]) {
      expect(countOf(code, fn), fn).toBe(0);
    }
    // length( is also the tail of char_length(: no bare call.
    expect(countOf(code, "length(") - countOf(code, "char_length(")).toBe(0);
    // Every table is schema-qualified.
    for (const rel of ["clusters", "cluster_articles", "article_title_versions", "sources", "articles"]) {
      for (const kw of ["from", "join"]) {
        expect(countOf(code, `${kw} ${rel} `), `${kw} ${rel}`).toBe(0);
      }
    }
    expect(code).not.toContain("~*");
  });

  it("no CTE is left to inlining where its shape matters: the five sets are materialized", () => {
    const body = body214();
    for (const cte of ["w", "ver", "isci", "mem", "stale", "bcand"]) {
      expect(body, cte).toContain(`${cte} as materialized (`);
    }
    expect(countOf(body, " as materialized (")).toBe(6);
  });
});

describe("214 neutral_title_repick_fast: grants, comment and header", () => {
  it("restates the revoke and the grant, so the ACL stays service_role only", () => {
    const stmts = statements(stripComments(sql214));
    expect(stmts).toContain(REVOKE_STMT.slice(0, -1));
    expect(stmts).toContain(GRANT_STMT.slice(0, -1));
    const code = stripComments(sql214);
    expect(code).not.toContain("to anon");
    expect(code).not.toContain("to authenticated");
    expect(code).not.toContain("to public");
    expect(PROD_PROACL).toBe("{postgres=X/postgres,service_role=X/postgres}");
  });

  it("comments the function with 209's rule text unchanged and 214 added to the migration list", () => {
    const c209 = statementStartingWith(stripComments(sql209), "comment on function");
    const c214 = statementStartingWith(stripComments(sql214), "comment on function");
    expect(c214).toContain(`comment on function ${FN_SIG} is`);
    expect(c209.endsWith(COMMENT_TAIL_209)).toBe(true);
    expect(c214.endsWith(COMMENT_TAIL_214)).toBe(true);
    expect(c214.slice(0, c214.length - COMMENT_TAIL_214.length)).toBe(c209.slice(0, c209.length - COMMENT_TAIL_209.length));
  });
});

describe("214 neutral_title_repick_fast: the header documents the cause, the rule, the measurements and the release", () => {
  it("documents WHY, STEP 0, THE RULE, THE COST, PARITY, RELEASE ORDER, VERIFY and ROLLBACK", () => {
    const head = flat(header214());
    for (const marker of ["WHY", "STEP 0", "THE RULE", "THE COST", "PARITY", "RELEASE ORDER", "VERIFY", "ROLLBACK"]) {
      expect(head, marker).toContain(marker);
    }
    expect(head).toContain(PROD_MD5);
    expect(head).toContain(String(PROD_LENGTH));
    expect(head).toContain(NEW_MD5);
    expect(head).toContain(String(NEW_LENGTH));
    expect(head).toContain("The migration is not applied by the PR");
    expect(head).toContain("Safe to re-apply");
    expect(head).toContain("no deploy-order constraint");
    expect(head).toContain("57014");
    expect(head).toContain("h189");
  });

  it("says what it changed and what it did not", () => {
    const head = flat(header214());
    for (const phrase of [
      "same candidate set in the same order",
      "No table, column, index, trigger or data change",
      "no cron change",
      "no EXTRACTIVE_MODEL_ID bump",
      "= ANY (array)",
      "ids only",
      "tayf_search_fold",
      "materialized",
      "w.id as the tie-break",
      "covering",
    ]) {
      expect(head, phrase).toContain(phrase);
    }
  });
});

describe("214 neutral_title_repick_fast: the header states the measurements", () => {
  it("names the sub-plans that were the cost, the cost of both bodies warm and cold, and the parity it checked", () => {
    const head = flat(header214());
    for (const phrase of [
      // where the cost was (209's body, production, read-only)
      "429 ms, 46,244 hits and 27 reads",
      "SubPlan 1, 208's stale rule: 136 ms, 19,938 hits",
      "SubPlan 2, 209's hashed IN over isci-haber's last 15 days: 54 ms, 20,018 hits",
      "SubPlan 4, branch B's word scan: 114 clusters at 0.59 ms",
      "Which sub-plan was the cost: branch B's hashed IN",
      "10,282 reads",
      // the cost, old and new
      "364.6, 361.5, 360.0 and 368.1 ms (shared hit 46,272)",
      "249.7, 260.5, 250.7 and 251.7 ms (shared hit 21,972)",
      "7,125, 6,999, 6,572 and 7,106 ms",
      "4,199, 4,385, 4,376 and 4,299 ms",
      "It does not reach 1 s cold",
      // parity
      "at three different times",
      "identical",
      "43 and 43",
      "114 and 114",
      "(17 live tests)",
    ]) {
      expect(head, phrase).toContain(phrase);
    }
  });

  it("the live tests it counts are the live block's", () => {
    const src = readFileSync(__filename, "utf8");
    // (the needle is assembled so this file holds the live gate exactly once: live-harness.test.ts counts the literal)
    const gate = ["describe.runIf(", "Boolean(process.env.TAYF_PSQL))"].join("");
    const live = src.slice(src.lastIndexOf(gate));
    // `it(` and `it.each(...)(`: the case list of the seeded populations is one `it.each` of four seeds.
    const plain = countOf(live, '\n  it("');
    const each = countOf(live, "\n  it.each([");
    expect(plain + 4 * each).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): 209's body and the shipped function side by side on fixtures, on a throwaway Postgres with 209 and 214
// applied by the dry-run script (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE select the server. Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("214 neutral_title_repick_candidates against 209's body (live Postgres, every case rolled back)", () => {
  assertLiveReady("214", {
    ledger: ["209", "214"],
    relations: ["public.clusters", "public.cluster_articles", "public.article_title_versions", "public.articles", "public.sources"],
    functions: ["public.neutral_title_repick_candidates(text,integer)", "public.tayf_search_fold(text)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  const MODEL = "extractive-v6";
  const ISCI = "isci-haber";
  const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);
  const clusterUuid = (n: number): string => `c1400000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const articleUuid = (n: number, k: number): string => `a1400000-0000-0000-${String(n).padStart(4, "0")}-${String(k).padStart(12, "0")}`;
  const sourceUuid = (slug: string): string => `51400000-0000-0000-0000-${md5(slug).slice(0, 12)}`;

  interface Member {
    title: string | null;
    slug: string;
    /** days since the article was published (default 1) */
    daysAgo?: number;
  }
  interface Version {
    /** the k-th member (1-based) whose title was edited */
    member: number;
    old: string;
    /** days since the edit was seen (default 3) */
    daysAgo?: number;
  }
  interface Cl {
    n: number;
    title: string | null;
    /** the stamp, title_neutral_member_count (null: never stamped) */
    stamped: number | null;
    /** the live article_count (default: the number of members) */
    count?: number;
    model?: string;
    archived?: boolean;
    llm?: boolean;
    /** minutes since updated_at: distinct per fixture, so the order is defined */
    ageMinutes: number;
    members: Member[];
    versions?: Version[];
  }

  function fixture(rows: Cl[]): string {
    const slugs = [...new Set(rows.flatMap((c) => c.members.map((m) => m.slug)))].sort();
    const out: string[] = [];
    if (slugs.length > 0) {
      out.push(
        "insert into public.sources (id, slug, name) values\n  " +
          slugs.map((s) => `('${sourceUuid(s)}', ${lit(s)}, ${lit(s)})`).join(",\n  ") +
          ";",
      );
    }
    if (rows.length === 0) return "";
    out.push(
      "insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count, is_archived, title_neutral_at, updated_at) values\n  " +
        rows
          .map(
            (c) =>
              `('${clusterUuid(c.n)}', ${lit(c.title)}, ${lit(c.model ?? MODEL)}, ${c.stamped === null ? "null" : c.stamped}, ${c.count ?? c.members.length}, ${c.archived ? "true" : "false"}, ${c.llm ? "now()" : "null"}, now() - interval '${c.ageMinutes} minutes')`,
          )
          .join(",\n  ") +
        ";",
    );
    const arts = rows.flatMap((c) =>
      c.members.map(
        (m, i) =>
          `('${articleUuid(c.n, i + 1)}', '${sourceUuid(m.slug)}', ${lit(m.title)}, now() - interval '${m.daysAgo ?? 1} days')`,
      ),
    );
    if (arts.length > 0) {
      out.push("insert into public.articles (id, source_id, title, published_at) values\n  " + arts.join(",\n  ") + ";");
      out.push(
        "insert into public.cluster_articles (cluster_id, article_id) values\n  " +
          rows.flatMap((c) => c.members.map((_, i) => `('${clusterUuid(c.n)}', '${articleUuid(c.n, i + 1)}')`)).join(",\n  ") +
          ";",
      );
    }
    const vers = rows.flatMap((c) =>
      (c.versions ?? []).map(
        (v) =>
          `('${articleUuid(c.n, v.member)}', ${lit(v.old)}, 'edited', now() - interval '${v.daysAgo ?? 3} days')`,
      ),
    );
    if (vers.length > 0) {
      out.push("insert into public.article_title_versions (article_id, old_title, new_title, seen_at) values\n  " + vers.join(",\n  ") + ";");
    }
    return out.join("\n") + "\n";
  }

  /** 209's body, or 214's, as a plain SELECT (p_model and p_limit filled in). */
  function plain(body: string, model: string, limit: number): string {
    const withModel = body.replaceAll("p_model", `${lit(model)}::text`);
    const clamp = "least(greatest(coalesce(p_limit, 20), 1), 50)";
    expect(withModel).toContain(clamp);
    return withModel.replace(clamp, String(limit)).trim().replace(/;$/, "");
  }

  /** The fixture numbers (right 12 digits) in the order a query returns them. */
  const ids = (out: string): number[] =>
    out
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(Number);

  interface Both {
    old: number[];
    neu: number[];
    fn: number[];
  }

  /** 209's body, 214's body and the shipped function (limit 50), inside one transaction on the same fixtures, limit 500 for the bodies. */
  function both(rows: Cl[], model = MODEL): Both {
    return bothSql(fixture(rows), model);
  }

  function bothSql(fixtureSql: string, model = MODEL): Both {
    const q = (body: string): string => `select right(id::text, 12)::int from (${plain(body, model, 500)}) q;\n`;
    const out = runPsql(
      `begin;\n${fixtureSql}` +
        `select 'OLD';\n${q(body209)}` +
        `select 'NEW';\n${q(body214())}` +
        `select 'FN';\nselect right(id::text, 12)::int from public.neutral_title_repick_candidates(${lit(model)}, 50);\n` +
        "rollback;\n",
    );
    const [, rest = ""] = out.split("OLD\n");
    const [oldPart = "", afterOld = ""] = rest.split("NEW\n");
    const [newPart = "", fnPart = ""] = afterOld.split("FN\n");
    return { old: ids(oldPart), neu: ids(newPart), fn: ids(fnPart) };
  }

  /** 209's body with the OR chain cut down to ONE arm (an index of ARM): the rows that rule alone offers. */
  function armOnly(arm: number): string {
    const open = body209.indexOf(CHAIN_OPEN);
    const close = body209.lastIndexOf(ORDER_LINE);
    return `${body209.slice(0, open)}   where (${arms209()[arm] as string})\n${body209.slice(close)}`;
  }

  /** How many rows each of the four rules that read titles and members offers on its own (209's body, one arm at a time). */
  function armCounts(rows: Cl[]): Record<"stale" | "placeholderTeaser" | "loaded" | "casing", number> {
    const one = (arm: number): string => `select count(*) from (${plain(armOnly(arm), MODEL, 500)}) q;\n`;
    const out = runPsql(
      `begin;\n${fixture(rows)}${one(ARM.stale)}${one(ARM.placeholderTeaser)}${one(ARM.loaded)}${one(ARM.casing)}rollback;\n`,
    )
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(Number);
    return { stale: out[0] ?? -1, placeholderTeaser: out[1] ?? -1, loaded: out[2] ?? -1, casing: out[3] ?? -1 };
  }

  const FINE = "Merkez Bankası faiz kararını açıkladı";
  const H = (n: number): number => n; // fixture number readability

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers; stable, security definer, empty search_path, service_role only", () => {
    const out = runPsql(
      "select md5(prosrc) || '|' || length(prosrc) || '|' || provolatile::text || '|' || prosecdef || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;",
    ).trim();
    const body = body214();
    expect(out).toBe(
      `${md5(body)}|${[...body].length}|s|true|{"search_path=\\"\\""}|TABLE(id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)|p_model text, p_limit integer DEFAULT 20`,
    );
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
  });

  it("is idempotent: one 214 ledger row, and the stored comment names 214", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '214';").trim()).toBe("1");
    expect(runPsql(`select obj_description('${FN_SIG}'::regprocedure, 'pg_proc');`)).toContain("214");
  });

  it("an empty database offers nothing, on both bodies", () => {
    const r = both([]);
    expect(r).toEqual({ old: [], neu: [], fn: [] });
  });

  // One cluster per rule: the cheap arms of 184/208's chain, then the four rules that read titles and members.
  it("every cheap arm offers what 209 offers: another model, no stamp, growth, a gate-failing title, a young stamp, all capitals", () => {
    const m = (n: number): Member[] => [
      { title: `${FINE} ${n}`, slug: "haber7" },
      { title: `${FINE} ${n} yeni`, slug: "sozcu" },
      { title: `${FINE} ${n} son`, slug: "aa" },
    ];
    const rows: Cl[] = [
      { n: 1, title: FINE, stamped: 3, model: "extractive-v5", ageMinutes: 1, members: m(1) },
      { n: 2, title: FINE, stamped: null, ageMinutes: 2, members: m(2) },
      { n: 3, title: FINE, stamped: 1, count: 5, ageMinutes: 3, members: m(3) },
      { n: 4, title: "x".repeat(120), stamped: 2, count: 3, ageMinutes: 4, members: m(4) },
      { n: 5, title: "Kısa başlık", stamped: 2, count: 3, ageMinutes: 5, members: m(5) },
      { n: 6, title: "Neden böyle oldu?", stamped: 2, count: 3, ageMinutes: 6, members: m(6) },
      { n: 7, title: FINE, stamped: 2, count: 3, ageMinutes: 7, members: m(7) },
      { n: 8, title: "NEV'İN MİRASI GÜNDEM OLDU", stamped: 3, count: 3, ageMinutes: 8, members: m(8) },
      { n: 9, title: FINE, stamped: 3, count: 3, ageMinutes: 9, members: m(9) },
      { n: 10, title: FINE, stamped: 3, count: 3, archived: true, ageMinutes: 10, members: m(10) },
      { n: 11, title: FINE, stamped: 3, count: 3, llm: true, ageMinutes: 11, members: m(11) },
      { n: 12, title: FINE, stamped: 3, count: 1, ageMinutes: 12, members: m(12) },
      { n: 13, title: FINE, stamped: null, count: 3, ageMinutes: 60 * 24 * 15, members: m(13) },
      // the window is 14 days: half a day outside is never read, half a day inside is
      { n: 14, title: FINE, stamped: null, count: 3, ageMinutes: 60 * 24 * 14 + 720, members: m(14) },
      { n: 15, title: FINE, stamped: null, count: 3, ageMinutes: 60 * 24 * 13 + 720, members: m(15) },
    ];
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.fn).toEqual(r.old);
    expect(r.old).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 15].map(H));
  });

  it("the window is the newest 5000: a row beyond it is never offered, the 5000th is", () => {
    const fx = (offeredG: number): string =>
      "insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count, is_archived, title_neutral_at, updated_at)\n" +
      `select ('${clusterUuid(0).slice(0, 24)}' || lpad(g::text, 12, '0'))::uuid, '${FINE}', '${MODEL}', case when g = ${offeredG} then null else 2 end, 2, false, null, now() - interval '1 minute' - g * interval '1 second' from generate_series(1, 5001) g;\n`;
    const beyond = bothSql(fx(5001));
    expect(beyond).toEqual({ old: [], neu: [], fn: [] });
    const last = bothSql(fx(5000));
    expect(last.old).toEqual([5000]);
    expect(last.neu).toEqual([5000]);
    expect(last.fn).toEqual([5000]);
  });

  it("placeholder and teaser titles (no question mark, no combining dot) are offered at any stamp, exactly as 209 offers them", () => {
    const three = (n: number): Member[] => [
      { title: `Ankara'dan ${n}. açıklama`, slug: "haber7" },
      { title: `${FINE} ${n}`, slug: "sozcu" },
      { title: `${FINE} ${n} yeni`, slug: "aa" },
    ];
    const titles = [
      "Bakan Bayraktar'dan açıklama",
      "Cumhurbaşkanı Erdoğan'dan önemli açıklamalar",
      "Dışişleri Bakanlığı'ndan mesajlar",
      "Bakan Kurum'dan son dakika açıklama!",
      "Bakan Bayraktar'dan açıklama geldi",
      "Bakan Bayraktar: Enerjide yeni dönem, açıklama",
      "Meclis'te neler oldu",
      "Kimler var Meclis'te",
      "Hangi bakan ne dedi",
      "Neden istifa edemedi",
      "Neler oluyor Meclis'te",
      "Bakan açıklama yaptı: neler olduğunu anlattı",
      "Bakan açıklama yapıyor?",
      "Hangi bakan ne dedi?",
    ];
    const rows: Cl[] = titles.map((t, i) => ({ n: i + 1, title: t, stamped: 3, count: 3, ageMinutes: i + 1, members: three(i + 1) }));
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.fn).toEqual(r.old);
    expect(r.old.length).toBeGreaterThanOrEqual(5);
    expect(r.old.length).toBeLessThan(titles.length);
  });

  it("branch A: a stored title that carries one outlet's epithet is offered, cut at a speaker's opening quote, and the dotless 'katil-' words are not", () => {
    const three = (n: number): Member[] => [
      { title: `${FINE} ${n}`, slug: "haber7" },
      { title: `${FINE} ${n} yeni`, slug: "sozcu" },
      { title: `${FINE} ${n} son`, slug: "aa" },
    ];
    const titles = [
      "Trump, katillere desteğiyle övündü: Bu iş bittiğinde İsrail'e gidip başbakan olabilirim",
      "Şerbetli tatlıya tuzlu fatura. İBB yönetimine ihale rantı tepkisi",
      "Katil rejimin saldırısı sürüyor",
      "Katil devlet yine saldırdı",
      "Kentte rant kapısına dönüştü bina",
      "Afyonkarahisar'daki katliamda yeni gelişme: 8 kişinin katilinin ilk ifadesi",
      "COP31'e katılan liderlere destek verildi",
      "Erdoğan: 'Katillere destek verenler hesap verecek'",
      "Özel: “İBB'de ihale rantı var” dedi",
      "Kamu İhale Kanunu değişikliği Meclis'te",
      "2katil destek veren",
      "Rantabilite oranları yükseldi bu ay",
    ];
    const rows: Cl[] = titles.map((t, i) => ({ n: i + 1, title: t, stamped: 3, count: 3, ageMinutes: i + 1, members: three(i + 1) }));
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.fn).toEqual(r.old);
    expect(r.old).toEqual([1, 2, 3, 4, 5]);
  });

  it("the stale rule: a title an outlet edited away is offered, one a member still carries or a quote-free twin of is not", () => {
    const stored = "Merkez Bankası faiz kararını açıkladı";
    const rows: Cl[] = [
      // edited away: a member's old title held it, no current member does
      { n: 1, title: stored, stamped: 3, count: 3, ageMinutes: 1, members: [{ title: "Merkez Bankası faiz oranını sabit tuttu", slug: "haber7" }, { title: "TCMB faizi değiştirmedi", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 1, old: stored }] },
      // still carried by another member
      { n: 2, title: stored, stamped: 3, count: 3, ageMinutes: 2, members: [{ title: "Merkez Bankası faiz oranını sabit tuttu", slug: "haber7" }, { title: stored, slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 1, old: stored }] },
      // carried with other capitals and marks
      { n: 3, title: stored, stamped: 3, count: 3, ageMinutes: 3, members: [{ title: "Merkez Bankası faiz oranını sabit tuttu", slug: "haber7" }, { title: "MERKEZ BANKASI FAİZ KARARINI AÇIKLADI!", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 1, old: stored }] },
      // the version is older than seven days
      { n: 4, title: stored, stamped: 3, count: 3, ageMinutes: 4, members: [{ title: "Merkez Bankası faiz oranını sabit tuttu", slug: "haber7" }, { title: "TCMB faizi değiştirmedi", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 1, old: stored, daysAgo: 8 }] },
      // old title carries the stored one inside a longer title
      { n: 5, title: stored, stamped: 3, count: 3, ageMinutes: 5, members: [{ title: "Faiz kararı", slug: "haber7" }, { title: "TCMB faizi değiştirmedi", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 2, old: `SON DAKİKA: ${stored} - detaylar` }] },
      // a member that quotes the span does not carry it bare (200's rule): offered
      { n: 6, title: stored, stamped: 3, count: 3, ageMinutes: 6, members: [{ title: `Başkan: “${stored}”`, slug: "haber7" }, { title: "TCMB faizi değiştirmedi", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 2, old: stored }] },
      // Başkan Erdoğan is the same as Cumhurbaşkanı Erdoğan
      { n: 7, title: "Cumhurbaşkanı Erdoğan Rize'de konuştu", stamped: 3, count: 3, ageMinutes: 7, members: [{ title: "Başkan Erdoğan Rize'de konuştu", slug: "haber7" }, { title: "Erdoğan Karadeniz'de", slug: "aa" }, { title: "Rize mitingi", slug: "sozcu" }], versions: [{ member: 2, old: "Cumhurbaşkanı Erdoğan Rize'de konuştu" }] },
      // a stored title with no letter at all has an empty key: never stale, even when the member that was edited has no title at all
      { n: 8, title: "!!! ???", stamped: 3, count: 3, ageMinutes: 8, members: [{ title: "a", slug: "haber7" }, { title: "b", slug: "aa" }, { title: "c", slug: "sozcu" }], versions: [{ member: 1, old: "!!! ???" }] },
      { n: 9, title: "!!! ???", stamped: 3, count: 3, ageMinutes: 9, members: [{ title: null, slug: "haber7" }, { title: null, slug: "aa" }, { title: null, slug: "sozcu" }], versions: [{ member: 1, old: "!!! ???" }] },
      // the window is seven days: half a day inside is seen, half a day outside is not
      { n: 10, title: stored, stamped: 3, count: 3, ageMinutes: 10, members: [{ title: "Merkez Bankası faiz oranını sabit tuttu", slug: "haber7" }, { title: "TCMB faizi değiştirmedi", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 1, old: stored, daysAgo: 6.5 }] },
      { n: 11, title: stored, stamped: 3, count: 3, ageMinutes: 11, members: [{ title: "Merkez Bankası faiz oranını sabit tuttu", slug: "haber7" }, { title: "TCMB faizi değiştirmedi", slug: "aa" }, { title: "Faiz kararı çıktı", slug: "sozcu" }], versions: [{ member: 1, old: stored, daysAgo: 7.5 }] },
    ];
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.fn).toEqual(r.old);
    expect(r.old).toContain(1);
    expect(r.old).not.toContain(2);
    expect(r.old).not.toContain(4);
    expect(r.old).not.toContain(8);
    expect(r.old).not.toContain(9);
    expect(r.old).toContain(10);
    expect(r.old).not.toContain(11);
  });

  it("the isci-haber rule: a machine-cased stored title with another member's capital word is offered, and the guards keep the rest out", () => {
    const stored = "Bakan Bayraktar'dan libya ve venezuela mesajı";
    const evidence = "Bakan Bayraktar'dan Libya ve Venezuela ile enerji mesajı";
    const fillers = (n: number): Member[] => [
      { title: `Hükümetten enerji açıklaması geldi ${n}`, slug: "haber7" },
      { title: `Enerji bakanı iklim mesajı verdi ${n}`, slug: "sozcu" },
    ];
    const isci = (t: string): Member => ({ title: t, slug: ISCI });
    const other = (t: string, slug = "haber7"): Member => ({ title: t, slug });
    const rows: Cl[] = [
      { n: 1, title: stored, stamped: 2, count: 2, ageMinutes: 1, members: [isci(stored), other(evidence)] },
      // the stored title is no isci member's text
      { n: 2, title: stored, stamped: 2, count: 2, ageMinutes: 2, members: [isci("Başka bir başlık"), other(evidence)] },
      // the isci member is older than fifteen days
      { n: 3, title: stored, stamped: 2, count: 2, ageMinutes: 3, members: [{ ...isci(stored), daysAgo: 15.5 }, other(evidence)] },
      { n: 4, title: stored, stamped: 2, count: 2, ageMinutes: 4, members: [{ ...isci(stored), daysAgo: 14.5 }, other(evidence)] },
      // a quotation mark takes a sibling out
      { n: 5, title: stored, stamped: 2, count: 2, ageMinutes: 5, members: [isci(stored), other("Bakan Bayraktar'dan “Libya ve Venezuela” mesajı")] },
      // Title Case adds no capital
      { n: 6, title: stored, stamped: 2, count: 2, ageMinutes: 6, members: [isci(stored), other("Bakan Bayraktar'dan Libya Venezuela Enerji Mesajı")] },
      // five members ask for two other titles
      { n: 7, title: stored, stamped: 5, count: 5, ageMinutes: 7, members: [isci(stored), other(evidence), ...fillers(7), other("Fidan Libya ile görüştü", "aa")] },
      { n: 8, title: stored, stamped: 5, count: 5, ageMinutes: 8, members: [isci(stored), other(evidence), ...fillers(8), other("Bakan Bayraktar'dan enerji", "aa")] },
      // the veto: another outlet writes the word in lower case
      { n: 9, title: stored, stamped: 2, count: 3, ageMinutes: 9, members: [isci(stored), other(evidence), other("Bakan Bayraktar libya ve venezuela ile görüştü", "aa")] },
      // all capitals and a shouted run are no evidence
      { n: 10, title: stored, stamped: 2, count: 2, ageMinutes: 10, members: [isci(stored), other("AB LİBYA VE VENEZUELA")] },
      { n: 11, title: stored, stamped: 2, count: 3, ageMinutes: 11, members: [isci(stored), other("SON DAKİKA ENERJİ: Bakan Bayraktar'dan Libya ve Venezuela için enerji mesajı"), other("x", "aa")] },
      // the stored title's own twin is no sibling
      { n: 12, title: stored, stamped: 2, count: 2, ageMinutes: 12, members: [isci(stored), other("Bakan Bayraktar'dan Libya ve Venezuela mesajı")] },
      // an ordinal is no sentence end
      { n: 13, title: "Cumhurbaşkanı Erdoğan 111. dönem Kaymakamlar Kurası'nda", stamped: 2, count: 3, ageMinutes: 13, members: [isci("Cumhurbaşkanı Erdoğan 111. dönem Kaymakamlar Kurası'nda"), other("Cumhurbaşkanı Erdoğan 111. Dönem Kaymakamlar Kurası'nda"), other("Erdoğan Kurası'nda", "aa")] },
      // the titles are compared trimmed, on both sides
      { n: 14, title: stored, stamped: 2, count: 2, ageMinutes: 14, members: [isci(`  ${stored} `), other(evidence)] },
      { n: 15, title: ` ${stored}  `, stamped: 2, count: 2, ageMinutes: 15, members: [isci(stored), other(evidence)] },
      // a member of another outlet that carries the stored title word for word and was edited this week is no isci member (the lower-case word is first, so no veto)
      { n: 16, title: "libya'dan enerji mesajı verildi", stamped: 2, count: 2, ageMinutes: 16, members: [other("libya'dan enerji mesajı verildi"), other("Bakan Bayraktar'dan Libya'ya enerji mesajı", "aa")], versions: [{ member: 1, old: "Farklı eski başlık" }] },
    ];
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.fn).toEqual(r.old);
    expect(r.old).toContain(1);
    expect(r.old).not.toContain(2);
    expect(r.old).not.toContain(3);
    expect(r.old).not.toContain(5);
    expect(r.old).not.toContain(6);
    expect(r.old).toContain(14);
    expect(r.old).toContain(15);
    expect(r.old).not.toContain(16);
  });

  it("order and bounds: newest first, the function clamps its limit to 50, the bodies keep every row", () => {
    const rows: Cl[] = Array.from({ length: 55 }, (_, i) => ({
      n: i + 1,
      title: FINE,
      stamped: 2,
      count: 3,
      ageMinutes: i + 1,
      members: [
        { title: `${FINE} ${i}`, slug: "haber7" },
        { title: `${FINE} ${i} yeni`, slug: "sozcu" },
        { title: `${FINE} ${i} son`, slug: "aa" },
      ],
    }));
    const r = both(rows);
    expect(r.old).toHaveLength(55);
    expect(r.neu).toEqual(r.old);
    expect(r.old.slice(0, 3)).toEqual([1, 2, 3]);
    expect(r.fn).toEqual(r.old.slice(0, 50));
    const clamp = runPsql(
      `begin;\n${fixture(rows)}select (select count(*) from public.neutral_title_repick_candidates('${MODEL}', 1000)) || ',' || (select count(*) from public.neutral_title_repick_candidates('${MODEL}', 0)) || ',' || (select count(*) from public.neutral_title_repick_candidates('${MODEL}'));\nrollback;\n`,
    ).trim();
    expect(clamp).toBe("50,1,20");
  });

  it("equal updated_at values come back in a defined order (by id): 209 left it to the plan", () => {
    const rows: Cl[] = [3, 1, 2].map((n) => ({
      n,
      title: FINE,
      stamped: 2,
      count: 3,
      ageMinutes: 5,
      members: [
        { title: `${FINE} ${n}`, slug: "haber7" },
        { title: `${FINE} ${n} yeni`, slug: "sozcu" },
        { title: `${FINE} ${n} son`, slug: "aa" },
      ],
    }));
    const r = both(rows);
    expect([...r.old].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(r.neu).toEqual([1, 2, 3]);
    expect(r.fn).toEqual([1, 2, 3]);
  });

  // -------------------------------------------------------------------------
  // A seeded random population: every rule at once, with the cheap arms switched off for most rows (stamp = count, model v6), so
  // the title, version and member rules decide. 209's body and 214's body must return the same ids in the same order.
  // -------------------------------------------------------------------------

  /** mulberry32: a small deterministic generator. */
  function rng(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const WORDS = [
    "Bakan", "Bayraktar'dan", "Kurum", "Fidan'dan", "libya", "Libya", "venezuela", "Venezuela", "enerji", "Enerji", "iklim", "İklim", "COP31", "çöp31",
    "mesajı", "Mesajı", "zirvesi", "Zirvesi", "yargı", "Yargı", "paketi", "Paketi", "111.", "13.", "dönem", "Dönem", "Meclis'te", "meclis", "faiz", "Faiz",
    "kararı", "açıkladı", "AÇIKLADI", "TCMB", "ve", "ile", "için", "yeni", "son", "dakika", "SON", "DAKİKA", "Cumhurbaşkanı", "Erdoğan", "Başkan", "Rize'de",
  ];
  const TAILS = ["", "", "", " açıklama", " açıklamalar", " mesajlar", " neler oldu", " kimler var", " ihale rantı", " katil rejim", " rant kapısı", "?", "!", " (video)"];
  const SLUGS = [ISCI, ISCI, "haber7", "sozcu", "aa", "hurriyet", "milat"];

  function sentence(r: () => number, min = 3, max = 7): string {
    const n = min + Math.floor(r() * (max - min + 1));
    const words: string[] = [];
    for (let i = 0; i < n; i++) words.push(WORDS[Math.floor(r() * WORDS.length)] as string);
    return words.join(" ") + (TAILS[Math.floor(r() * TAILS.length)] as string);
  }

  /** The same words, with other capitals: what a sibling outlet writes. */
  function variant(r: () => number, s: string): string {
    const k = Math.floor(r() * 7);
    if (k === 0) return s;
    if (k === 1) return s.toLocaleLowerCase("tr-TR");
    if (k === 2) return s.toLocaleUpperCase("tr-TR");
    if (k === 3) return s.split(" ").map((w) => w.charAt(0).toLocaleUpperCase("tr-TR") + w.slice(1)).join(" ");
    if (k === 4) return `“${s}”`;
    if (k === 5) return `${s}.`;
    return s.split(" ").map((w, i) => (i % 2 === 0 ? w.toLocaleLowerCase("tr-TR") : w)).join(" ");
  }

  function population(seed: number, size: number): Cl[] {
    const r = rng(seed);
    const rows: Cl[] = [];
    for (let i = 1; i <= size; i++) {
      const base = sentence(r);
      const stored = r() < 0.15 ? variant(r, base) : base;
      const members: Member[] = [];
      const nMembers = 2 + Math.floor(r() * 5);
      for (let k = 0; k < nMembers; k++) {
        const slug = SLUGS[Math.floor(r() * SLUGS.length)] as string;
        const title = k === 0 && r() < 0.5 ? stored : r() < 0.6 ? variant(r, base) : sentence(r);
        members.push({ title, slug, daysAgo: r() < 0.1 ? 16 : 1 });
      }
      if (r() < 0.4) members.push({ title: stored, slug: ISCI });
      const versions: Version[] = [];
      if (r() < 0.35) versions.push({ member: 1 + Math.floor(r() * members.length), old: r() < 0.7 ? stored : `Son dakika: ${stored}`, daysAgo: r() < 0.15 ? 9 : 2 });
      const count = members.length;
      rows.push({
        n: i,
        title: r() < 0.05 ? null : stored,
        // mostly stamped at the live count and the current model: only the title, version and member rules can offer the row
        stamped: r() < 0.08 ? null : r() < 0.15 ? Math.max(1, count - 1) : count,
        count,
        model: r() < 0.05 ? "extractive-v5" : MODEL,
        ageMinutes: i * 3 + 1,
        members,
        versions,
      });
    }
    return rows;
  }

  it.each([11, 12, 13, 14])("a seeded random population (seed %i, 160 clusters): 214's body, the function and 209's body agree on ids and order", (seed) => {
    const rows = population(seed, 160);
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.fn).toEqual(r.old.slice(0, 50));
    // Not vacuous: a good share of the rows is offered by some rule, and not all of them.
    expect(r.old.length).toBeGreaterThanOrEqual(15);
    expect(r.old.length).toBeLessThan(rows.length);
  });

  it("the random populations are not vacuous: each of the stale, placeholder/teaser, loaded and isci rules offers rows on its own", () => {
    const counts = [11, 12, 13, 14, 21].map((seed) => armCounts(population(seed, seed === 21 ? 220 : 160)));
    const total = (k: keyof (typeof counts)[number]): number => counts.reduce((n, c) => n + c[k], 0);
    expect(total("stale")).toBeGreaterThanOrEqual(5);
    expect(total("placeholderTeaser")).toBeGreaterThanOrEqual(5);
    expect(total("loaded")).toBeGreaterThanOrEqual(5);
    expect(total("casing")).toBeGreaterThanOrEqual(5);
  });

  it("the random populations offer rows through the heavy rules too: with the cheap arms off, 209 still offers some", () => {
    const rows = population(21, 220).map((c) => ({ ...c, title: c.title ?? FINE, stamped: c.members.length, model: MODEL }));
    const r = both(rows);
    expect(r.neu).toEqual(r.old);
    expect(r.old.length).toBeGreaterThanOrEqual(10);
    expect(r.old.length).toBeLessThan(rows.length);
  });
});
