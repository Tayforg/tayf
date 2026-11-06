import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ENGLISH_SOURCE_SLUGS } from "@/lib/sources/source-language";
import { POLITICS_CATEGORIES } from "../../supabase/functions/_shared/cluster/politics-admission";

// ---------------------------------------------------------------------------
// Contract test for migration 165 ("framing_pool_politics_gate"), h48-stories-1 PART A.
//
// /oyun's Çerçeve mode draws from public.framing_candidate_pool, which 105 fills with every article that has a
// politics shadow prediction >= 0.7, is <= 48 h old and comes from an active non-wire source. The route doc promises
// "one political headline at a time" and the daily set (src/lib/game/daily-set.ts) gates exactly that with
// isPoliticsMember, kind === 'outlet' and ENGLISH_SOURCE_SLUGS, but the pool never did: on 2026-11-06 3,220 of its
// 5,809 rows were non-political (politics_admitted_at null and category outside politika / son_dakika), from an
// aggregator or niche source, or English.
//
// 165 replaces framing_candidate_pool_refresh() with the production body (130's, which is 105's plus the upsert
// guard) plus three gates in the `fresh` WHERE. This file pins: one transaction and nothing but the function, its
// comment, its grants and the ledger row (095 pattern); that 130's body is production's (md5); that 165's body equals 130's body once the three
// gates are taken out again (and that 130's equals 105's plus its guard, so the chain 105 -> 130 -> 165 is whole);
// that the category literal is POLITICS_CATEGORIES and the slug literal is ENGLISH_SOURCE_SLUGS, as sets; that the
// `or` is parenthesised; and that the existing `gone` delete, the advisory lock, SECURITY DEFINER, search_path = ''
// and the service_role-only grants are all still there. The behaviour (rows of every kind in, the gated rows out
// after the next refresh) is in tests/migrations/sql/165-framing-pool-politics-gate-dryrun.sql.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_165 = "165_framing_pool_politics_gate.sql";
const MIGRATION_165 = resolve(MIGRATIONS_DIR, FILE_165);
const MIGRATION_130 = resolve(MIGRATIONS_DIR, "130_db_hot_paths.sql");
const MIGRATION_105 = resolve(MIGRATIONS_DIR, "105_framing_candidate_pool.sql");
const DRYRUN_165 = resolve(ROOT, "tests", "migrations", "sql", "165-framing-pool-politics-gate-dryrun.sql");

/** Production, read-only, 2026-11-06: md5(prosrc), length(prosrc) and proacl of public.framing_candidate_pool_refresh(). */
const PROD_PROSRC_MD5 = "9d57360d0dc610c8c2d3c1d97ca6fc75";
const PROD_PROSRC_LEN = 2093;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

/** 130's added clause, verbatim (its own test pins it against 105). */
const UPSERT_GUARD =
  "where (framing_candidate_pool.title, framing_candidate_pool.published_at) is distinct from (excluded.title, excluded.published_at)";

const FN_RE = /create or replace function public\.framing_candidate_pool_refresh\(\)/i;

const stripSqlComments = (sql: string): string => sql.replace(/--[^\n]*/g, "");
const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

/** Blank out every single-quoted string literal, then every dollar-quoted block: the top-level statements only. */
function topLevel(sql: string): string {
  return stripSqlComments(sql)
    .replace(/\$(\w*)\$[\s\S]*?\$\1\$/g, "$$$$")
    .replace(/'(?:[^']|'')*'/g, "''");
}

/** The raw dollar-quoted body (Postgres' prosrc) of the refresh function, from the statement at the start of a line. */
function refreshBody(sql: string): string {
  const from = sql.search(new RegExp(`^${FN_RE.source}`, "im"));
  expect(from, "a line starting with `create or replace function public.framing_candidate_pool_refresh()`").toBeGreaterThanOrEqual(0);
  const m = /\$fn\$([\s\S]*?)\$fn\$/.exec(sql.slice(from));
  expect(m, "a $fn$ body").not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

/** The function header: everything from `create or replace` up to `as $fn$`. */
function refreshHeader(sql: string): string {
  const from = sql.search(new RegExp(`^${FN_RE.source}`, "im"));
  const open = sql.indexOf("as $fn$", from);
  return sql.slice(from, open + "as $fn$".length);
}

/** Comment-free, whitespace-collapsed body. */
const flat = (body: string): string => collapse(stripSqlComments(body));

const sql165 = readFileSync(MIGRATION_165, "utf8");
const code165 = stripSqlComments(sql165);
const top165 = topLevel(sql165);
const sql130 = readFileSync(MIGRATION_130, "utf8");
const sql105 = readFileSync(MIGRATION_105, "utf8");
const body165 = refreshBody(sql165);
const flat165 = flat(body165);

// The three changes, in the form the test derives and reverts them.
const POLITICS_GATE_RE = / and \(a\.category in \(([^)]*)\) or a\.politics_admitted_at is not null\)/;
const SLUG_GATE_RE = / and s\.slug not in \(([^)]*)\)/;
const KIND_NEW = " and coalesce(s.kind, 'outlet') = 'outlet'";
const KIND_OLD = " and coalesce(s.kind, 'outlet') <> 'wire'";

/** The single-quoted strings of a SQL list literal, in order. */
const literals = (list: string): string[] => [...list.matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1] as string);

/** 165's body with the three gates taken out again (the kind line back to 105's `<> 'wire'`). */
function revertGates(flatBody: string): string {
  expect(flatBody.split(KIND_NEW).length - 1, "the kind line appears once").toBe(1);
  expect(POLITICS_GATE_RE.test(flatBody), "the politics gate is there").toBe(true);
  expect(SLUG_GATE_RE.test(flatBody), "the slug gate is there").toBe(true);
  return flatBody.replace(POLITICS_GATE_RE, "").replace(SLUG_GATE_RE, "").replace(KIND_NEW, KIND_OLD);
}

describe("165 framing_pool_politics_gate: ledger and transaction", () => {
  it("records version 165 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(collapse(code165)).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('165', '165_framing_pool_politics_gate') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the function, its comment and its grants in between, the ledger row last", () => {
    expect([...code165.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code165.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(collapse(code165).slice(collapse(code165).indexOf("begin;")).endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("is numbered after 164 and named for its file", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("165_"))).toEqual([FILE_165]);
  });
});

describe("165 framing_pool_politics_gate: the production fingerprint it was built from", () => {
  it("130's function body is production's body: its md5 and length are the recorded prosrc", () => {
    const body = refreshBody(sql130);
    expect(md5(body)).toBe(PROD_PROSRC_MD5);
    expect(body.length).toBe(PROD_PROSRC_LEN);
  });

  it("130 is the newest earlier migration that defines the refresh function (105 -> 130)", () => {
    const defs = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE_165)
      .sort()
      .filter((f) => FN_RE.test(stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))));
    expect(defs).toEqual(["105_framing_candidate_pool.sql", "130_db_hot_paths.sql"]);
  });

  it("the header records the production md5(prosrc), length, proacl and the md5 of the new body", () => {
    expect(sql165).toContain(PROD_PROSRC_MD5);
    expect(sql165).toContain(`length ${PROD_PROSRC_LEN}`);
    expect(sql165).toContain(PROD_PROACL);
    const recorded = /new md5\(prosrc\):\s*([0-9a-f]{32})/.exec(sql165)?.[1];
    expect(recorded, "header line `new md5(prosrc): <32 hex>`").toBeDefined();
    expect(recorded).toBe(md5(body165));
    expect(recorded).not.toBe(PROD_PROSRC_MD5);
  });

  it("the header explains the three gates and records the replay counts", () => {
    expect(sql165).toMatch(/isPoliticsMember/);
    expect(sql165).toMatch(/ENGLISH_SOURCE_SLUGS/);
    expect(sql165).toMatch(/POLITICS_CATEGORIES/);
    expect(sql165).toContain("5,809");
    expect(sql165).toContain("3,220");
    expect(sql165).toContain("mfa-turkey");
  });
});

describe("165 framing_pool_politics_gate: the replaced function", () => {
  it("replaces exactly one function, with 130's signature and attributes (security definer, search_path = '')", () => {
    expect([...code165.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    const header = collapse(stripSqlComments(refreshHeader(sql165)));
    expect(header).toBe(
      "create or replace function public.framing_candidate_pool_refresh() returns integer language plpgsql security definer set search_path = '' as $fn$",
    );
    expect(header).toBe(collapse(stripSqlComments(refreshHeader(sql130))));
  });

  it("keeps the advisory lock, the statement-stable clock, the `gone` delete CTE and the upsert", () => {
    expect(flat165).toContain("pg_catalog.pg_try_advisory_xact_lock( pg_catalog.hashtext('framing_candidate_pool_refresh')::bigint ) then return 0;");
    expect(flat165).toContain("v_now := pg_catalog.now();");
    expect(flat165).toMatch(
      /gone as \( delete from public\.framing_candidate_pool c where not exists \(select 1 from fresh f where f\.article_id = c\.article_id\) \)/,
    );
    expect(flat165).toContain("insert into public.framing_candidate_pool (article_id, title, published_at, refreshed_at)");
    expect(flat165).toContain(UPSERT_GUARD);
    expect(flat165).toContain("return (select count(*)::int from public.framing_candidate_pool);");
  });

  it("DERIVE: with the three added or changed conditions put back, the body is 130's body (production's) exactly", () => {
    const reverted = revertGates(flat165);
    expect(reverted).not.toBe(flat165);
    expect(reverted).toBe(flat(refreshBody(sql130)));
  });

  it("DERIVE: 130's body is 105's body plus its upsert guard, so 165 = 105 + guard + the three gates", () => {
    const b105 = flat(refreshBody(sql105));
    const marker = "refreshed_at = excluded.refreshed_at;";
    expect(b105.split(marker).length - 1).toBe(1);
    const expected130 = b105.replace(marker, `refreshed_at = excluded.refreshed_at ${UPSERT_GUARD};`);
    expect(revertGates(flat165)).toBe(expected130);
  });

  it("each gate is in the WHERE of the `fresh` CTE, before `gone`, exactly once", () => {
    const from = flat165.indexOf("fresh as materialized (");
    const to = flat165.indexOf("gone as (");
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const fresh = flat165.slice(from, to);
    const where = fresh.slice(fresh.indexOf(" where "));
    expect(where.split(KIND_NEW).length - 1).toBe(1);
    expect([...where.matchAll(new RegExp(POLITICS_GATE_RE.source, "g"))]).toHaveLength(1);
    expect([...where.matchAll(new RegExp(SLUG_GATE_RE.source, "g"))]).toHaveLength(1);
    // and nowhere else in the body
    expect(flat165.split(KIND_NEW).length - 1).toBe(1);
    expect([...flat165.matchAll(new RegExp(POLITICS_GATE_RE.source, "g"))]).toHaveLength(1);
    expect([...flat165.matchAll(new RegExp(SLUG_GATE_RE.source, "g"))]).toHaveLength(1);
  });

  it("the `or` of the politics gate is parenthesised: with the group removed, the WHERE is a plain conjunction", () => {
    const from = flat165.indexOf("fresh as materialized (");
    const to = flat165.indexOf("gone as (");
    const fresh = flat165.slice(from, to);
    const where = fresh.slice(fresh.indexOf(" where ")).replace(POLITICS_GATE_RE, "");
    expect(where).not.toMatch(/\bor\b/i);
    expect(where).toContain("where a.published_at >= v_now - interval '48 hours' and s.active");
  });

  it("the category literal is POLITICS_CATEGORIES (set equality, no duplicates)", () => {
    const list = literals(POLITICS_GATE_RE.exec(flat165)?.[1] as string);
    expect(list.length).toBe(POLITICS_CATEGORIES.length);
    expect(new Set(list).size).toBe(list.length);
    expect(new Set(list)).toEqual(new Set(POLITICS_CATEGORIES));
    expect([...POLITICS_CATEGORIES].sort()).toEqual(["politika", "son_dakika"]);
  });

  it("the slug literal is ENGLISH_SOURCE_SLUGS (set equality, no duplicates; six slugs including mfa-turkey)", () => {
    const list = literals(SLUG_GATE_RE.exec(flat165)?.[1] as string);
    expect(list.length).toBe(ENGLISH_SOURCE_SLUGS.size);
    expect(new Set(list).size).toBe(list.length);
    expect(new Set(list)).toEqual(new Set(ENGLISH_SOURCE_SLUGS));
    expect(list).toContain("mfa-turkey");
    expect(list.length).toBe(6);
  });

  it("the kind line keeps only outlets: a null kind is an outlet (sourceKindOf), wire, niche and aggregator are out", () => {
    expect(flat165).toContain(KIND_NEW);
    expect(flat165).not.toContain("<> 'wire'");
    expect(flat165).toContain("s.active");
  });

  it("leaves 072's eligibility alone: 0.7, the 54 h prediction window and the 48 h article window", () => {
    expect(flat165).toContain("p.task = 'politics' and p.created_at >= v_now - interval '54 hours' and p.jev_prob >= 0.7");
    expect(flat165).toContain("where a.published_at >= v_now - interval '48 hours'");
  });

  it("documents the function in a comment that names 165", () => {
    const comment = /comment on function public\.framing_candidate_pool_refresh\(\) is\s+((?:'(?:[^']|'')*'\s*)+);/i.exec(code165);
    expect(comment, "a comment on function ... is '...'").not.toBeNull();
    const text = (comment as RegExpExecArray)[1] as string;
    expect(text).toContain("165");
    expect(text).toMatch(/politics/i);
    expect(text).toMatch(/outlet/i);
    expect(text).toMatch(/English/i);
  });
});

describe("165 framing_pool_politics_gate: grants", () => {
  it("re-asserts 105's revoke and grant verbatim (the same two statements 130 re-asserts)", () => {
    const re = /(revoke all on function public\.framing_candidate_pool_refresh\(\) from [^;]+;|grant execute on function public\.framing_candidate_pool_refresh\(\) to [^;]+;)/gi;
    const in105 = [...stripSqlComments(sql105).matchAll(re)].map((m) => collapse(m[0]));
    const in165 = [...code165.matchAll(re)].map((m) => collapse(m[0]));
    expect(in105).toEqual([
      "revoke all on function public.framing_candidate_pool_refresh() from anon, authenticated, public;",
      "grant execute on function public.framing_candidate_pool_refresh() to service_role;",
    ]);
    expect(in165).toEqual(in105);
  });

  it("grants only `execute` to service_role: nothing to anon, authenticated or public, the grants after the function", () => {
    const grants = [...code165.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(grants).toEqual(["grant execute on function public.framing_candidate_pool_refresh() to service_role;"]);
    expect(code165.indexOf("revoke all on function")).toBeGreaterThan(code165.indexOf("create or replace function"));
    expect(code165.indexOf("grant execute")).toBeGreaterThan(code165.indexOf("revoke all on function"));
    expect(code165).not.toMatch(/alter\s+default\s+privileges/i);
  });
});

describe("165 framing_pool_politics_gate: additive, no data change by the migration itself", () => {
  it("has no top-level drop, update, delete, truncate, alter or create table / index / view / trigger, and no insert but the one ledger row", () => {
    // topLevel() blanks string literals, so the ledger statement reads: values ('', '')
    const ledger = /\binsert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*''\s*,\s*''\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/gi;
    expect([...top165.matchAll(ledger)]).toHaveLength(1);
    expect(top165.replace(ledger, "")).not.toMatch(/\binsert\b/i);
    expect(top165).not.toMatch(/\bdrop\b/i);
    expect(top165).not.toMatch(/\bupdate\b/i);
    expect(top165).not.toMatch(/\bdelete\b/i);
    expect(top165).not.toMatch(/\btruncate\b/i);
    expect(top165).not.toMatch(/\balter\b/i);
    expect(code165).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|view|trigger|materialized|extension|policy)\b/i);
  });

  it("the only delete and the only insert are the ones already in production's body (the `gone` CTE and the upsert)", () => {
    expect([...flat165.matchAll(/\bdelete\s+from\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["public.framing_candidate_pool"]);
    expect([...flat165.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1])).toEqual(["public.framing_candidate_pool"]);
    // `on conflict (article_id) do update set` is the upsert's own clause, not an UPDATE statement
    expect(flat165.replace("on conflict (article_id) do update set", "")).not.toMatch(/\b(update|truncate|drop)\b/i);
  });

  it("does not run a refresh, touch the cron schedule or the draw function: the next scheduled refresh removes the rows", () => {
    expect(top165).not.toMatch(/\bselect\s+public\.framing_candidate_pool_refresh\s*\(/i);
    expect(code165).not.toMatch(/\bcron\./i);
    expect(code165).not.toMatch(/create\s+or\s+replace\s+function\s+public\.framing_next_headline/i);
    expect(code165).not.toMatch(/framing_votes/i);
  });
});

describe("165 framing_pool_politics_gate: dry-run script", () => {
  const dry = existsSync(DRYRUN_165) ? readFileSync(DRYRUN_165, "utf8") : "";

  it("ships the local PG15 dry-run: production's function, 165 twice, ending in DRYRUN 165 OK", () => {
    expect(existsSync(DRYRUN_165)).toBe(true);
    expect(dry).toContain(PROD_PROSRC_MD5);
    expect(dry.match(/\\ir \.\.\/\.\.\/\.\.\/supabase\/migrations\/165_framing_pool_politics_gate\.sql/g)).toHaveLength(2);
    expect(dry.trimEnd().endsWith("select 'DRYRUN 165 OK';")).toBe(true);
  });

  it("exercises every gate with its own fixture rows and the refresh's `gone` delete", () => {
    for (const slug of ENGLISH_SOURCE_SLUGS) expect(dry, slug).toContain(`'${slug}'`);
    expect(dry).toContain("politics_admitted_at");
    expect(dry).toContain("aggregator");
    expect(dry).toContain("niche");
    expect(dry).toContain("rollback;");
  });
});
