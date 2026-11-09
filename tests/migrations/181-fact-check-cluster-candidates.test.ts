import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 181 ("fact-check-cluster-candidates"), h87-factchecks-1.
//
// /api/cron/fact-checks used to keep the 25 LARGEST clusters that match the fact-check title's OR query
// (order by article_count desc limit 25), so a small cluster about the very same event was never scored: the
// Teyit "Peru'da Hitler Mussolini adlı bir aday belediye başkanı seçildi" piece (cluster 506da2d9, 4 articles, #139
// of 315 matches) and the Resmi Gazete age-limit piece (cluster 903f9541) were both missed. 181 adds ONE new function,
// public.fact_check_cluster_candidates(p_query, p_gte, p_lte, p_limit), that returns the same clusters ranked by
// ts_rank_cd first and article_count second. The cron calls it and falls back to the old query while it is missing.
//
// This file pins: the statements (one transaction, nothing but the function, its comment, its revoke and grant, the schema
// cache notice and the ledger row), the function's contract (SECURITY DEFINER, empty search_path, every reference
// schema-qualified, the same filters as the old query, relevance before size, a capped limit), that nothing
// existing is touched, the parity with the route's call, the header and the docs paragraph.
//
// SQL is scanned by character, never with a regular expression over SQL text (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_FILE = "181_fact_check_cluster_candidates.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_FILE);
const ROUTE = resolve(ROOT, "src", "app", "api", "cron", "fact-checks", "route.ts");
const DOC = resolve(ROOT, "docs", "fact-checks.md");

const FN = "public.fact_check_cluster_candidates";
const FN_ARGS = "text, timestamptz, timestamptz, integer";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('181', '181_fact_check_cluster_candidates') on conflict do nothing";
const REVOKE_STMT = `revoke all on function ${FN}(${FN_ARGS}) from public, anon, authenticated`;
const GRANT_STMT = `grant execute on function ${FN}(${FN_ARGS}) to service_role`;

// -- character-scan helpers (no regular expression runs over SQL text) ----------

function isTagChar(ch: string): boolean {
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
}

/** The dollar-quote tag that opens at `i` ("$$" or "$fn$"), or null when none does. */
function dollarTag(sql: string, i: number): string | null {
  if (sql.charAt(i) !== "$") return null;
  let j = i + 1;
  while (j < sql.length && isTagChar(sql.charAt(j))) j += 1;
  return sql.charAt(j) === "$" ? sql.slice(i, j + 1) : null;
}

/** Index just past the quoted string or dollar-quoted body that opens at `i`; `i` itself when none opens there. */
function skipQuoted(sql: string, i: number): number {
  const ch = sql.charAt(i);
  if (ch === "'") {
    let j = i + 1;
    while (j < sql.length) {
      if (sql.charAt(j) === "'") {
        if (sql.charAt(j + 1) === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j += 1;
    }
    return j + 1;
  }
  const tag = dollarTag(sql, i);
  if (tag !== null) {
    const end = sql.indexOf(tag, i + tag.length);
    return end < 0 ? sql.length : end + tag.length;
  }
  return i;
}

/** Removes `--` comments (to the end of the line, newline kept); quoted strings and dollar bodies are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const stop = skipQuoted(sql, i);
    if (stop > i) {
      out += sql.slice(i, stop);
      i = stop;
    } else if (sql.charAt(i) === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += sql.charAt(i);
      i += 1;
    }
  }
  return out;
}

/** Splits comment-free SQL on `;`, not inside a quoted string or a dollar body. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const stop = skipQuoted(sql, i);
    if (stop > i) {
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql.charAt(i) === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
    } else {
      cur += sql.charAt(i);
    }
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

function isSpace(ch: string): boolean {
  return ch === " " || ch === "\n" || ch === "\t" || ch === "\r";
}

/** Whitespace runs collapsed to one space (text inside quotes is touched too: fine for these pins), lower-cased. */
function collapse(sql: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of sql) {
    if (isSpace(ch)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += ch;
  }
  return out.toLowerCase();
}

/** Every whitespace character removed, lower-cased: for pins that must not depend on line breaks or indentation. */
function squash(sql: string): string {
  let out = "";
  for (const ch of sql) if (!isSpace(ch)) out += ch;
  return out.toLowerCase();
}

function countOf(haystack: string, needle: string): number {
  let n = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) return n;
    n += 1;
    from = at + needle.length;
  }
}

/** True when every occurrence of `name` in `text` is directly preceded by `prefix`. */
function everyOccurrencePrefixed(text: string, name: string, prefix: string): boolean {
  let from = 0;
  let seen = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) return seen > 0;
    seen += 1;
    if (text.slice(Math.max(0, at - prefix.length), at) !== prefix) return false;
    from = at + name.length;
  }
}

/** The text between the first two occurrences of the `$fn$` dollar quote. */
function functionBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  return open < 0 || close < 0 ? "" : sql.slice(open + 4, close);
}

// -------------------------------------------------------------------------------

describe("migration 181_fact_check_cluster_candidates.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let statements: string[] = [];
  let body = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), `${MIGRATION_FILE} must exist`).toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    statements = splitStatements(code).map(collapse);
    body = functionBody(code);
  });

  it("is the only migration numbered 181", () => {
    const same = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("181_"));
    expect(same).toEqual([MIGRATION_FILE]);
  });

  describe("statements", () => {
    it("is one transaction: begin first, a lock_timeout, commit last", () => {
      expect(statements[0]).toBe("begin");
      expect(statements[1]).toBe("set local lock_timeout = '5s'");
      expect(statements[statements.length - 1]).toBe("commit");
      expect(countOf(code.toLowerCase(), "begin;")).toBe(1);
      expect(countOf(code.toLowerCase(), "commit;")).toBe(1);
    });

    it("holds exactly the function, its comment, the revoke, the grant, the schema-cache notice and the ledger row, in that order", () => {
      expect(statements.map((s) => s.split(" ").slice(0, 3).join(" "))).toEqual([
        "begin",
        "set local lock_timeout",
        "create or replace",
        "comment on function",
        "revoke all on",
        "grant execute on",
        "notify pgrst, 'reload",
        "insert into supabase_migrations.schema_migrations",
        "commit",
      ]);
    });

    it("records version 181 in the ledger as the last statement before commit, idempotently", () => {
      expect(statements[statements.length - 2]).toBe(LEDGER_STMT);
      expect(countOf(code.toLowerCase(), "insert into")).toBe(1);
    });

    it("tells PostgREST to reload its schema cache so the new rpc is callable at once", () => {
      expect(statements).toContain("notify pgrst, 'reload schema'");
    });
  });

  describe("the function", () => {
    let fnStatement = "";

    beforeAll(() => {
      fnStatement = statements.find((s) => s.startsWith("create or replace function")) ?? "";
    });

    it("has the signature the route calls: (p_query text, p_gte timestamptz, p_lte timestamptz, p_limit integer default 25)", () => {
      expect(squash(fnStatement).startsWith(squash(`create or replace function ${FN}(p_query text, p_gte timestamptz, p_lte timestamptz, p_limit integer default 25)`))).toBe(true);
    });

    it("returns table (id uuid, title_tr text, title_tr_neutral text): the ClusterCandidateRow the route reads", () => {
      expect(squash(fnStatement)).toContain(squash("returns table (id uuid, title_tr text, title_tr_neutral text)"));
    });

    it("is language sql, stable, security definer, with an empty search_path", () => {
      const head = collapse(fnStatement.slice(0, fnStatement.indexOf("$fn$")));
      expect(head).toContain(" language sql");
      expect(head).toContain(" stable");
      expect(head).toContain(" security definer");
      expect(head).toContain(" set search_path = ''");
      expect(head).not.toContain(" volatile");
      expect(head).not.toContain(" security invoker");
    });

    it("has one dollar-quoted body and no other function in the file", () => {
      expect(countOf(code, "$fn$")).toBe(2);
      expect(body.trim()).not.toBe("");
      expect(countOf(code.toLowerCase(), "create or replace function")).toBe(1);
      expect(countOf(code.toLowerCase(), "create function")).toBe(0);
    });

    it("qualifies every relation and function with its schema (the search_path is empty)", () => {
      const b = collapse(body);
      expect(b).toContain("from public.clusters c");
      expect(everyOccurrencePrefixed(b, "websearch_to_tsquery", "pg_catalog.")).toBe(true);
      expect(everyOccurrencePrefixed(b, "ts_rank_cd", "pg_catalog.")).toBe(true);
      expect(b).toContain("'pg_catalog.turkish'::pg_catalog.regconfig");
      // Nothing may resolve through a search_path: no unqualified table, and no other schema.
      expect(countOf(b, " from ")).toBe(1);
      expect(countOf(b, " join ")).toBe(1); // the one lateral join that holds the tsquery
      expect(countOf(b, "cross join lateral")).toBe(1);
    });

    it("keeps the old query's filters: not archived, 2+ articles, updated since p_gte, first published by p_lte, search_tsv match", () => {
      const b = collapse(body);
      expect(b).toContain("c.is_archived = false");
      expect(b).toContain("c.article_count >= 2");
      expect(b).toContain("c.updated_at >= p_gte");
      expect(b).toContain("c.first_published <= p_lte");
      expect(b).toContain("c.search_tsv @@ w.q");
      expect(b).toContain("pg_catalog.websearch_to_tsquery('pg_catalog.turkish'::pg_catalog.regconfig, p_query)");
    });

    it("selects exactly the three columns it returns", () => {
      const b = collapse(body);
      expect(b.trimStart().startsWith("select c.id, c.title_tr, c.title_tr_neutral from public.clusters c")).toBe(true);
    });

    it("orders by relevance first (ts_rank_cd desc), then article_count desc, then id", () => {
      const b = collapse(body);
      const orderAt = b.indexOf("order by ");
      expect(orderAt).toBeGreaterThan(0);
      const order = b.slice(orderAt, b.indexOf(" limit ", orderAt));
      const rankAt = order.indexOf("pg_catalog.ts_rank_cd(c.search_tsv, w.q) desc");
      const sizeAt = order.indexOf("c.article_count desc");
      const idAt = order.indexOf("c.id");
      expect(rankAt).toBeGreaterThan(-1);
      expect(sizeAt).toBeGreaterThan(rankAt);
      expect(idAt).toBeGreaterThan(sizeAt);
      // The size-only order that dropped the Peru and Resmi Gazete clusters must not come back as the lead key.
      expect(order.startsWith("order by c.article_count")).toBe(false);
      expect(order.startsWith("order by pg_catalog.ts_rank_cd")).toBe(true);
    });

    it("builds the tsquery once, in a lateral subselect, and ranks by that same query", () => {
      const b = collapse(body);
      expect(b).toContain("cross join lateral (select pg_catalog.websearch_to_tsquery(");
      expect(countOf(b, "websearch_to_tsquery")).toBe(1);
    });

    it("caps the limit at 50 and floors it at 1, with 25 for a null", () => {
      expect(squash(body)).toContain("limitleast(greatest(coalesce(p_limit,25),1),50)");
      expect(squash(fnStatement)).toContain("p_limitintegerdefault25");
    });

    it("is a plain select: no write, no lock, no dynamic sql", () => {
      const b = collapse(body);
      for (const word of ["insert ", "update ", "delete ", "truncate ", " for update", " for share", "execute ", "perform "]) {
        expect(b, word).not.toContain(word);
      }
    });
  });

  describe("access", () => {
    it("revokes execute from public, anon and authenticated (all three named)", () => {
      expect(statements).toContain(REVOKE_STMT);
    });

    it("grants execute to service_role only", () => {
      expect(statements).toContain(GRANT_STMT);
      const grants = statements.filter((s) => s.startsWith("grant "));
      expect(grants).toEqual([GRANT_STMT]);
    });

    it("never grants to anon, authenticated or public, and grants no table or sequence privilege", () => {
      const all = collapse(code);
      for (const role of [" to anon", " to authenticated", " to public"]) {
        expect(all, role).not.toContain(role);
      }
      expect(all).not.toContain("grant select");
      expect(all).not.toContain("on all tables");
      expect(all).not.toContain("on sequence");
    });

    it("revokes before it grants", () => {
      expect(statements.indexOf(REVOKE_STMT)).toBeGreaterThan(-1);
      expect(statements.indexOf(REVOKE_STMT)).toBeLessThan(statements.indexOf(GRANT_STMT));
    });

    it("documents the function with a comment that names the migration and the caller", () => {
      const c = statements.find((s) => s.startsWith("comment on function")) ?? "";
      expect(c).toContain(`comment on function ${FN}(${FN_ARGS}) is`);
      expect(c).toContain("migration 181");
      expect(c).toContain("/api/cron/fact-checks");
      expect(c).toContain("service_role");
    });
  });

  describe("additive only", () => {
    it("drops, alters, updates, deletes and truncates nothing, and creates no table, index, trigger, view, policy or extension", () => {
      const all = collapse(code);
      for (const word of [
        "drop ",
        "alter ",
        "update public.",
        "delete from",
        "truncate",
        "create table",
        "create index",
        "create trigger",
        "create view",
        "create policy",
        "create extension",
        "create type",
        "create schema",
      ]) {
        expect(all, word).not.toContain(word);
      }
    });

    it("does not redefine any existing function: the only function it names is the new one", () => {
      const all = collapse(code);
      expect(countOf(all, "create or replace function")).toBe(1);
      // create, comment, revoke and grant name it; no other statement does.
      const naming = statements.filter((s) => s.includes(FN)).map((s) => s.split(" ").slice(0, 2).join(" "));
      expect(naming).toEqual(["create or", "comment on", "revoke all", "grant execute"]);
    });

    it("writes no row but its ledger row", () => {
      for (const s of statements) {
        if (s.startsWith("insert into")) expect(s).toBe(LEDGER_STMT);
      }
    });
  });

  describe("parity with the route", () => {
    let route = "";
    beforeAll(() => {
      route = readFileSync(ROUTE, "utf8");
    });

    it("the route calls this function by name with the four parameter names the SQL declares", () => {
      expect(route).toContain('.rpc("fact_check_cluster_candidates"');
      for (const param of ["p_query", "p_gte", "p_lte", "p_limit"]) {
        expect(route, param).toContain(`${param}:`);
        expect(collapse(code), param).toContain(`${param} `);
      }
    });

    it("the route asks for the function's default limit, which is within the function's cap", () => {
      expect(route).toContain("CLUSTER_CANDIDATE_LIMIT = 25;");
      expect(route).toContain("p_limit: CLUSTER_CANDIDATE_LIMIT");
      expect(squash(code)).toContain("p_limitintegerdefault25");
      expect(squash(code)).toContain(",50)");
    });

    it("the route keeps the old size-ordered query in exactly one place (the fallback) and recognises both missing-function codes", () => {
      const rpcAt = route.indexOf('.rpc("fact_check_cluster_candidates"');
      const legacyAt = route.indexOf('.textSearch("search_tsv"');
      expect(rpcAt).toBeGreaterThan(-1);
      expect(legacyAt).toBeGreaterThan(-1);
      expect(countOf(route, '.textSearch("search_tsv"')).toBe(1);
      expect(route).toContain("PGRST202");
      expect(route).toContain("42883");
    });
  });

  describe("header and docs", () => {
    it("opens with the file name and the finding, and explains why in prose", () => {
      expect(raw.startsWith("-- 181_fact_check_cluster_candidates.sql")).toBe(true);
      expect(raw).toContain("h87-factchecks-1");
      expect(raw).toContain("506da2d9");
      expect(raw).toContain("903f9541");
    });

    it("carries the operator sections: ORDER, VERIFY, ROLLBACK and the replay", () => {
      for (const section of ["-- ORDER", "-- VERIFY", "-- ROLLBACK", "-- REPLAY"]) {
        expect(raw, section).toContain(section);
      }
      expect(raw).toContain(`drop function ${FN}(${FN_ARGS})`);
      expect(raw).toContain("schema_migrations where version = '181'");
    });

    it("says it is NOT a backfill: only fact-checks of the last three days are re-matched", () => {
      expect(collapse(raw)).toContain("no backfill");
    });

    // SEC-factcheck-autopublish-fp-1: the floor lives in the route, the migration and the docs only explain it.
    it("the route holds an RPC-sourced pair below 0.7 as a shadow row, and the migration and the docs say so with the review query", () => {
      const route = readFileSync(ROUTE, "utf8");
      expect(route).toContain("const RPC_PUBLISH_MIN_SCORE = 0.7;");
      expect(route).toContain('r.decision === "publish" && (!fromRpc || r.score >= RPC_PUBLISH_MIN_SCORE)');

      const reviewQuery =
        "select cluster_id, fact_check_id, score, matched_terms from cluster_fact_checks where method = 'keyword-v2' and decided_by = 'auto' and not is_published and score >= 0.6 order by created_at desc;";
      const doc = collapse(readFileSync(DOC, "utf8"));
      // collapse() lower-cases, so the identifier is compared in lower case.
      expect(doc).toContain("rpc_publish_min_score = 0.7");
      expect(doc).toContain(reviewQuery);
      // Comment markers removed so the multi-line query of the OPEN POINTS reads as one line.
      const header = collapse(raw.split("\n").map((line) => line.replace(/^--\s?/, "")).join("\n"));
      expect(header).toContain("rpc_publish_min_score");
      expect(header).toContain(reviewQuery);
    });

    it("docs/fact-checks.md records the relevance ranking, the migration and the Peru example", () => {
      const doc = readFileSync(DOC, "utf8");
      expect(doc).toContain("fact_check_cluster_candidates");
      expect(doc).toContain("migration 181");
      expect(doc).toContain("2026-11");
      expect(doc).toContain("ts_rank_cd");
      expect(doc).toContain("#139 of 315");
    });
  });
});
