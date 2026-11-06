import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 168 ("framing_draw_one_per_event"), h52-game-1.
//
// GET /api/oyun/cerceve/next draws through public.framing_next_headline(text). Since 105 the draw reads the
// precomputed pool, keeps the newest 300 rows the session has not voted on, and picks one at random. It excludes only
// the exact article already voted on. The newest 300 rows are 167 events (cluster 85ef184c alone supplies 25 of them,
// 48e267ee 13, ab528fee 10) and 287 distinct titles, so a 60-second round meets the same story again and again: a
// Monte Carlo over that exact draw set gives P(an event repeats) = 0.42 / 0.70 / 0.87 / 0.99 after 10 / 15 / 20 / 30
// headlines, and P(byte-identical text) = 0.015 / 0.039 / 0.064 / 0.142. The footer promises the cookie exists to avoid
// showing the same headline again; Bolge and the daily set already dedupe per cluster.
//
// 168 re-creates the draw with 105's text (the production body, pinned here by md5) plus: the clusters and the
// normalised titles the session has voted on are excluded, and the newest 300 are cut to ONE row per event before the
// unchanged <5-votes-first random pick. This file pins, without a database: the ledger row and the single
// transaction, additive-only SQL, 105's body is production's, that 168's body is 105's with exactly the added CTEs (a
// derivation, not a restatement), every detail of the exclusions and the partition, the grants, the docs section, the
// dry-run script and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs the draw against fixtures.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_168 = "168_framing_draw_one_per_event.sql";
const MIGRATION_168 = resolve(MIGRATIONS_DIR, FILE_168);
const MIGRATION_105 = resolve(MIGRATIONS_DIR, "105_framing_candidate_pool.sql");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "168-framing-draw-one-per-event-dryrun.sql");

/** Production, read-only, 2026-11-06: md5(prosrc), length(prosrc) and proacl of public.framing_next_headline(text). */
const PROD_MD5 = "21a64cbeecb880d83d988fb0e9bbe42b";
const PROD_LENGTH = 1137;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

/** The exact normaliser, once for the voted headline (read from articles) and once for the candidate. */
const NORM_VOTED = "lower(regexp_replace(a.title, '\\s+', ' ', 'g'))";
const NORM_CANDIDATE = "lower(regexp_replace(n.candidate_title, '\\s+', ' ', 'g'))";

/**
 * The one predicate 168 adds to 105's `eligible` WHERE (the CTE is named `newest` in 168). NOT IN, not NOT EXISTS: the draw
 * is a non-inlined SQL function, so `session_hash = $1` is estimated from the average votes per session and a heavy
 * player's voted set is under-estimated; the NOT EXISTS form then planned as a Nested Loop Anti Join with a Join Filter
 * (600 voted events: 1.45M rows removed, about 215 ms) where NOT IN plans as a hashed subplan filter (about 31 ms).
 * NULL-safe because cluster_articles.article_id and .cluster_id and framing_candidate_pool.article_id are NOT NULL.
 */
const ADDED_CLUSTER_ANTIJOIN =
  "and p.article_id not in (select ca.article_id from public.cluster_articles ca where ca.cluster_id in (select vc.cluster_id from voted_clusters vc))";
/** The form 168 must NOT use for the cluster exclusion (the nested-loop plan above). */
const NOT_EXISTS_CLUSTER_PREFIX = "not exists (select 1 from public.cluster_articles";
/** 105's per-article anti-join, which stays. */
const ARTICLE_ANTIJOIN =
  "and not exists (select 1 from public.framing_votes v where v.article_id = p.article_id and v.session_hash = p_session_hash)";
const TITLE_ANTIJOIN = "where not exists (select 1 from voted_keys k where k.title_key = e.title_key)";
const PARTITION =
  "row_number() over (partition by coalesce(e.event_cluster::text, e.title_key) order by random()) as rn";
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('168', '168_framing_draw_one_per_event') on conflict do nothing;";
const REVOKE_STMT = "revoke all on function public.framing_next_headline(text) from anon, authenticated, public;";
const GRANT_STMT = "grant execute on function public.framing_next_headline(text) to service_role;";
/** The one index 168 adds: `voted` needs every vote of the session, and no existing index leads with session_hash. */
const INDEX_NAME = "framing_votes_session_hash_article_idx";
const INDEX_STMT = `create index if not exists ${INDEX_NAME} on public.framing_votes (session_hash, article_id);`;

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
  return s.replace(/\s+/g, " ").trim();
}

/** Comment-free, whitespace-collapsed. */
const flat = (s: string): string => collapse(stripComments(s));

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The `create or replace function public.framing_next_headline(...) ... $fn$ ... $fn$;` statement, at the start of a line. */
function drawBlock(sql: string): string {
  const at = ("\n" + sql).indexOf("\ncreate or replace function public.framing_next_headline(");
  expect(at, "a line starting with create or replace function public.framing_next_headline(").toBeGreaterThanOrEqual(0);
  const start = at;
  const open = sql.indexOf("$fn$", start);
  const close = sql.indexOf("$fn$", open + 4);
  expect(open, "an opening $fn$").toBeGreaterThan(start);
  expect(close, "a closing $fn$").toBeGreaterThan(open);
  return sql.slice(start, sql.indexOf(";", close) + 1);
}

/** Everything before `as $fn$`: signature, return shape, attributes. */
const drawHeader = (block: string): string => block.slice(0, block.indexOf("as $fn$"));

/** The text between the dollar-quote markers: Postgres' prosrc. */
function drawBody(block: string): string {
  const open = block.indexOf("$fn$") + 4;
  return block.slice(open, block.indexOf("$fn$", open));
}

/** The parenthesised body of `<name> as (...)` inside a flat body: from the name through the matching `)`. */
function cte(flatBody: string, name: string): string {
  const head = `${name} as (`;
  const at = flatBody.indexOf(head);
  expect(at, `a CTE named ${name}`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = at + head.length - 1; i < flatBody.length; i++) {
    const ch = flatBody.charAt(i);
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return flatBody.slice(at, i + 1);
    }
  }
  throw new Error(`unbalanced parentheses in CTE ${name}`);
}

/** Every `public.<name>` the text reads or writes, sorted and unique. */
function publicRelations(text: string): string[] {
  const found = new Set<string>();
  let from = 0;
  for (;;) {
    const at = text.indexOf("public.", from);
    if (at < 0) break;
    let end = at + "public.".length;
    while (end < text.length && /[a-z0-9_]/.test(text.charAt(end))) end++;
    found.add(text.slice(at, end));
    from = end;
  }
  return [...found].sort();
}

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

const sql168 = existsSync(MIGRATION_168) ? readFileSync(MIGRATION_168, "utf8") : "";
const code168 = stripComments(sql168);
const sql105 = readFileSync(MIGRATION_105, "utf8");

const block105 = drawBlock(sql105);
const body105 = drawBody(block105);
const flat105 = flat(body105);

// The 168 blocks are read lazily so a missing file fails each test with a clear message, not the whole module.
function block168(): string {
  expect(existsSync(MIGRATION_168), `${FILE_168} must exist`).toBe(true);
  return drawBlock(sql168);
}
const body168 = (): string => drawBody(block168());
const flat168 = (): string => flat(body168());

describe("168 framing_draw_one_per_event: ledger and transaction", () => {
  it("exists and is the only migration numbered 168", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("168_"))).toEqual([FILE_168]);
  });

  it("records version 168 in the schema_migrations ledger, idempotently (095 pattern), as the last statement before commit", () => {
    expect(collapse(code168)).toContain(LEDGER_STMT);
    const tail = collapse(code168);
    expect(tail.slice(tail.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("creates the session_hash index once, plain (no CONCURRENTLY), inside the transaction and before the function is replaced", () => {
    const c = collapse(code168);
    expect(countOf(c, INDEX_STMT)).toBe(1);
    expect(c.indexOf(INDEX_STMT)).toBeGreaterThan(c.indexOf("begin;"));
    expect(c.indexOf(INDEX_STMT)).toBeLessThan(c.indexOf("create or replace function"));
    expect(c.toLowerCase().includes("concurrently")).toBe(false);
    expect(countOf(c.toLowerCase(), "create index")).toBe(1);
  });

  it("is one transaction: a single begin and a single commit", () => {
    expect(countOf(code168.toLowerCase(), "\nbegin;")).toBe(1);
    expect(countOf(code168.toLowerCase(), "\ncommit;")).toBe(1);
    expect(collapse(code168).indexOf("begin;")).toBeLessThan(collapse(code168).indexOf("create or replace function"));
  });
});

describe("168 framing_draw_one_per_event: the production fingerprint it was built from", () => {
  it("105's draw body is production's body: its md5 and length are the recorded prosrc", () => {
    expect(md5(body105)).toBe(PROD_MD5);
    expect(body105.length).toBe(PROD_LENGTH);
  });

  it("105 is the newest earlier migration that defines the draw (068 -> 072 -> 105)", () => {
    const defs = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql") && f < FILE_168)
      .sort()
      .filter((f) => stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8")).includes("create or replace function public.framing_next_headline("));
    expect(defs).toEqual(["068_framing_votes.sql", "072_framing_draw_fast.sql", "105_framing_candidate_pool.sql"]);
  });

  it("the header records the production md5, length and proacl, and the md5 and length of the new body", () => {
    expect(sql168).toContain(PROD_MD5);
    expect(sql168).toContain(`length ${PROD_LENGTH}`);
    expect(sql168).toContain(PROD_PROACL);
    const m = sql168.match(/new md5\(prosrc\): ([0-9a-f]{32}) \(length ([0-9]+)\)/);
    expect(m, "header line `new md5(prosrc): <32 hex> (length <n>)`").not.toBeNull();
    const body = body168();
    expect(m?.[1]).toBe(md5(body));
    expect(Number(m?.[2])).toBe(body.length);
    expect(m?.[1]).not.toBe(PROD_MD5);
  });

  it("the header carries the evidence, the replay numbers, the deploy order and the rollback", () => {
    const head = sql168.slice(0, sql168.indexOf("\nbegin;"));
    for (const word of ["85ef184c", "167 events", "0.42", "0.99", "0.142", "min(uuid)", "161", "EXPLAIN ANALYZE", "APPLY 168"]) {
      expect(head, word).toContain(word);
    }
    expect(head).toMatch(/rollback/i);
  });

  it("the header names the session_hash index everywhere it matters: summary, what changes, known cost, not touched, rollback", () => {
    const head = sql168.slice(0, sql168.indexOf("\nbegin;"));
    // the line-9 summary no longer claims "no index"
    expect(head).not.toContain("No table, column, index");
    expect(head).not.toContain("in a new migration (this one replaces a function and nothing else");
    expect(head).not.toContain("belongs in a later migration");
    // each slice runs from its own label to the next section's label, so a mention elsewhere cannot satisfy it
    const cost = head.slice(head.indexOf("KNOWN COST"), head.indexOf("PRODUCTION FINGERPRINT"));
    expect(cost.length, "a KNOWN COST section before PRODUCTION FINGERPRINT").toBeGreaterThan(20);
    expect(cost).toContain(INDEX_NAME);
    expect(cost).toMatch(/range scan/);
    const what = head.slice(head.indexOf("WHAT CHANGES"), head.indexOf("WHY NOT min(cluster_id)"));
    expect(what).toContain(INDEX_NAME);
    expect(what).toContain("(session_hash, article_id)");
    const untouched = head.slice(head.indexOf("NOT TOUCHED"), head.indexOf("DEPLOY"));
    expect(untouched).toContain("framing_votes");
    expect(untouched).toContain("existing");
    const rollback = head.slice(head.indexOf("Rollback (nothing depends on 168"));
    expect(rollback).toContain(`drop index if exists public.${INDEX_NAME};`);
    expect(rollback).toContain("105");
  });

  it("the header records the measured plan facts behind NOT IN (EXPLAIN ANALYZE, production, read-only) and not the old hash anti-join claim", () => {
    const head = sql168.slice(0, sql168.indexOf("\nbegin;"));
    expect(head).not.toContain("as a hash anti-join against the pool");
    expect(head).not.toContain("it does not probe cluster_articles once per pool row");
    for (const word of ["NOT IN", "hashed subplan", "Nested Loop Anti Join", "Join Filter", "1.45M", "215", "31 ms", "NULL-safe", "NOT NULL"]) {
      expect(head, word).toContain(word);
    }
  });

  it("names no government-zone label anywhere, comments included (zone-parity scans the raw file)", () => {
    expect(sql168).not.toContain("iktidar");
  });
});

describe("168 framing_draw_one_per_event: the replaced function", () => {
  it("replaces exactly one function, with 105's signature and attributes (stable, security definer, search_path = '')", () => {
    block168();
    expect(countOf(code168.toLowerCase(), "create or replace function")).toBe(1);
    expect(code168.toLowerCase()).not.toMatch(/\bcreate\s+function\b/);
    const header = collapse(stripComments(drawHeader(block168())));
    expect(header).toBe(
      "create or replace function public.framing_next_headline(p_session_hash text) returns table ( article_id uuid, title text ) language sql stable security definer set search_path = ''",
    );
    expect(header).toBe(collapse(stripComments(drawHeader(block105))));
    expect(header).not.toMatch(/\bvolatile\b/i);
  });

  it("DERIVE: the newest-300 CTE is 105's `eligible` CTE with exactly one anti-join added (48 h window, per-article anti-join, limit 300 kept)", () => {
    const newest = cte(flat168(), "newest");
    const eligible105 = cte(flat105, "eligible");
    expect(countOf(newest, ADDED_CLUSTER_ANTIJOIN)).toBe(1);
    const reverted = collapse(newest.replace(ADDED_CLUSTER_ANTIJOIN, "")).replace("newest as (", "eligible as (");
    expect(reverted).toBe(eligible105);
    expect(newest).toContain("p.published_at >= now() - interval '48 hours'");
    expect(newest).toContain(ARTICLE_ANTIJOIN);
    expect(newest).toContain("order by p.published_at desc limit 300");
    expect(countOf(flat168(), "limit 300")).toBe(1);
    expect(countOf(flat168(), "interval '48 hours'")).toBe(1);
  });

  it("the cluster exclusion is NOT IN over cluster_articles, never a join against voted_clusters or a NOT EXISTS (plan-stable under a low estimate of the voted set)", () => {
    const newest = cte(flat168(), "newest");
    expect(newest).toContain(ADDED_CLUSTER_ANTIJOIN);
    // a join against voted_clusters is the nested-loop form (Join Filter over a Materialize of the voted clusters)
    expect(newest.includes("join voted_clusters")).toBe(false);
    // the article-level anti-join of 105 stays NOT EXISTS; the cluster-level one must not be
    expect(newest.includes(NOT_EXISTS_CLUSTER_PREFIX)).toBe(false);
    expect(countOf(newest, "not exists")).toBe(1);
    expect(countOf(newest, "not in")).toBe(1);
    // the predicate text is what is pinned here, not the plan; EXPLAIN output never appears in the function body
    expect(newest.includes("(hashed")).toBe(false);
    expect(flat168().includes("(hashed")).toBe(false);
  });

  it("the cluster exclusion sits BEFORE the newest-300 cut, so the window slides past voted events like the per-article anti-join does", () => {
    const newest = cte(flat168(), "newest");
    expect(newest.indexOf(ADDED_CLUSTER_ANTIJOIN)).toBeGreaterThan(0);
    expect(newest.indexOf(ADDED_CLUSTER_ANTIJOIN)).toBeLessThan(newest.indexOf("limit 300"));
  });

  it("voted: the session's own votes; voted_clusters joins cluster_articles; voted_keys reads articles (so aged-out pool rows still count)", () => {
    const f = flat168();
    expect(cte(f, "voted")).toBe("voted as ( select v.article_id from public.framing_votes v where v.session_hash = p_session_hash )");
    const clusters = cte(f, "voted_clusters");
    expect(clusters).toBe(
      "voted_clusters as ( select distinct ca.cluster_id from voted join public.cluster_articles ca on ca.article_id = voted.article_id )",
    );
    const keys = cte(f, "voted_keys");
    expect(keys).toBe(
      `voted_keys as ( select distinct ${NORM_VOTED} as title_key from voted join public.articles a on a.id = voted.article_id )`,
    );
    expect(f.indexOf("voted as (")).toBeLessThan(f.indexOf("voted_clusters as ("));
    expect(f.indexOf("voted_keys as (")).toBeLessThan(f.indexOf("newest as ("));
  });

  it("eligible adds the event key and the title key to the newest rows (exactly the normaliser, once per side)", () => {
    const f = flat168();
    const eligible = cte(f, "eligible");
    expect(eligible).toBe(
      `eligible as ( select n.candidate_id, n.candidate_title, (select ca.cluster_id from public.cluster_articles ca where ca.article_id = n.candidate_id order by ca.cluster_id limit 1) as event_cluster, ${NORM_CANDIDATE} as title_key from newest n )`,
    );
    // the key and the probe run on the 300 rows only: neither is computed in the pool scan
    expect(cte(f, "newest")).not.toContain("regexp_replace");
    expect(cte(f, "newest")).not.toContain("event_cluster");
    // exactly two normaliser calls in the whole body, and both end with the same arguments
    expect(countOf(f, "lower(regexp_replace(")).toBe(2);
    expect(countOf(f, ", '\\s+', ' ', 'g'))")).toBe(2);
    expect(f).toContain(NORM_VOTED);
    expect(f).toContain(NORM_CANDIDATE);
  });

  it("the event key is the smallest cluster id by ordering, never min(uuid) (no such aggregate exists on production's PostgreSQL 17)", () => {
    const f = flat168();
    expect(f).not.toMatch(/\bmin\s*\(/i);
    expect(f).not.toMatch(/\bmax\s*\(/i);
    expect(f).toContain("order by ca.cluster_id limit 1");
  });

  it("one_per_event keeps one random row per event (cluster, else normalised title) and drops voted titles after the cut", () => {
    const f = flat168();
    const one = cte(f, "one_per_event");
    expect(one).toBe(
      `one_per_event as ( select r.candidate_id, r.candidate_title from ( select e.candidate_id, e.candidate_title, ${PARTITION} from eligible e ${TITLE_ANTIJOIN} ) r where r.rn = 1 )`,
    );
    expect(f.indexOf("eligible as (")).toBeGreaterThan(f.indexOf("newest as ("));
    expect(f.indexOf("one_per_event as (")).toBeGreaterThan(f.indexOf("eligible as ("));
    expect(f.indexOf("tallied as (")).toBeGreaterThan(f.indexOf("one_per_event as ("));
  });

  it("DERIVE: tallied and the final select are 105's, byte for byte after whitespace, except that tallied reads one_per_event", () => {
    const f = flat168();
    const tail168 = f.slice(f.indexOf("tallied as ("));
    const tail105 = flat105.slice(flat105.indexOf("tallied as ("));
    expect(tail105.length).toBeGreaterThan(200);
    expect(countOf(tail168, "from one_per_event e")).toBe(1);
    expect(tail168.replace("from one_per_event e", "from eligible e")).toBe(tail105);
    expect(tail168.endsWith("order by (t.vote_count >= 5) asc, random() limit 1;")).toBe(true);
    expect(flat105.endsWith("order by (t.vote_count >= 5) asc, random() limit 1;")).toBe(true);
  });

  it("DERIVE: the whole body is the CTE chain voted, voted_clusters, voted_keys, newest, eligible, one_per_event, tallied, then the select", () => {
    const f = flat168();
    const order = ["voted as (", "voted_clusters as (", "voted_keys as (", "newest as (", "eligible as (", "one_per_event as (", "tallied as ("];
    const at = order.map((name) => f.indexOf(name));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(f.startsWith("with voted as (")).toBe(true);
  });

  it("reads only the pool, the votes, cluster_articles and articles: no predictions table, no sources, no outlet column", () => {
    expect(publicRelations(flat168())).toEqual([
      "public.articles",
      "public.cluster_articles",
      "public.framing_candidate_pool",
      "public.framing_votes",
    ]);
    expect(flat168()).not.toContain("jev_shadow_predictions");
    expect(flat168()).not.toContain("source_id");
    expect(flat168()).not.toContain("public.sources");
  });

  it("selects the same two columns the route reads (candidate_id, candidate_title) and still takes the session hash only", () => {
    const f = flat168();
    expect(f).toContain("p.article_id as candidate_id");
    expect(f).toContain("p.title as candidate_title");
    expect(f.endsWith("select t.candidate_id, t.candidate_title from tallied t order by (t.vote_count >= 5) asc, random() limit 1;")).toBe(true);
    expect(countOf(f, "p_session_hash")).toBe(2);
  });

  it("documents the function in a comment that names 168, the one-row-per-event rule and the PII filter", () => {
    const head = "comment on function public.framing_next_headline(text) is";
    const start = code168.indexOf(head);
    expect(start, "a comment on function ... is '...'").toBeGreaterThanOrEqual(0);
    const end = code168.indexOf("';", start + head.length);
    expect(end).toBeGreaterThan(start);
    const text = code168.slice(start + head.length, end + 1);
    expect(text).toContain("168");
    expect(text).toMatch(/one (row|headline) per event/i);
    expect(text).toContain("isGameEligibleTitle");
    expect(text).toContain("105");
  });
});

describe("168 framing_draw_one_per_event: grants", () => {
  it("re-asserts 072's and 105's revoke and grant verbatim, the grants after the function", () => {
    const in105 = collapse(stripComments(sql105));
    expect(in105).toContain(REVOKE_STMT);
    expect(in105).toContain(GRANT_STMT);
    const c = collapse(code168);
    expect(countOf(c, REVOKE_STMT)).toBe(1);
    expect(countOf(c, GRANT_STMT)).toBe(1);
    expect(c.indexOf(REVOKE_STMT)).toBeGreaterThan(c.indexOf("create or replace function"));
    expect(c.indexOf(GRANT_STMT)).toBeGreaterThan(c.indexOf(REVOKE_STMT));
  });

  it("grants only `execute` to service_role: nothing to anon, authenticated or public, no default-privilege change", () => {
    const c = collapse(code168);
    const grants = c.split(";").filter((s) => /\bgrant\b/i.test(s)).map((s) => `${s.trim()};`);
    expect(grants).toEqual([GRANT_STMT]);
    expect(c).not.toMatch(/alter default privileges/i);
  });
});

describe("168 framing_draw_one_per_event: additive, no data change by the migration itself", () => {
  it("has no drop, update, delete, truncate, alter, create table / view / trigger / policy, no other index than the session_hash one, and no insert but the one ledger row", () => {
    // the function body is blanked first: it is a single select, and the words below must not occur there either
    const outside = code168.replace(stripComments(body168()), "");
    expect(outside.length, "the function body was cut out").toBeLessThan(code168.length - 500);
    const collapsed = collapse(outside).toLowerCase();
    // exactly the one index statement is allowed; it is removed before the "nothing else" scans below
    expect(countOf(collapsed, INDEX_STMT)).toBe(1);
    const lower = collapsed.replace(INDEX_STMT, "");
    expect(lower.replace(LEDGER_STMT, "")).not.toMatch(/\binsert\b/);
    for (const word of ["drop", "update", "delete", "truncate", "alter"]) expect(lower, word).not.toMatch(new RegExp(`\\b${word}\\b`));
    expect(lower).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|view|trigger|materialized|extension|policy)\b/);
    const inBody = flat168().toLowerCase();
    for (const word of ["insert", "update", "delete", "truncate", "drop", "alter", "create"]) expect(inBody, word).not.toMatch(new RegExp(`\\b${word}\\b`));
  });

  it("touches no cron job, no refresh, no other function and no pgrst reload: the pool and the route are unchanged", () => {
    expect(code168).not.toMatch(/\bcron\./i);
    expect(code168).not.toMatch(/framing_candidate_pool_refresh/i);
    expect(code168).not.toMatch(/notify\s+pgrst/i);
    expect(code168).not.toMatch(/\bperform\b|\bselect\s+public\./i);
  });
});

describe("168 framing_draw_one_per_event: the route still calls the same RPC", () => {
  it("GET /api/oyun/cerceve/next calls framing_next_headline with p_session_hash and reads article_id and title", () => {
    const route = readFileSync(resolve(ROOT, "src", "app", "api", "oyun", "cerceve", "next", "route.ts"), "utf8");
    expect(route).toContain('.rpc("framing_next_headline", { p_session_hash: sessionHash })');
    expect(route).toContain("row.article_id");
    expect(route).toContain("row.title");
  });
});

describe("168 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 168 ") ? sectionOf(guide, "168") : "";

  it("sits directly after section 167 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 168 ")).toBeGreaterThan(guide.indexOf("\n## 167 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 167 ") + 1)).toBe(guide.indexOf("\n## 168 "));
  });

  it("has Why, What, an md5 table, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 168 does**", "| md5(prosrc) | length |", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    expect(section).toContain(PROD_MD5);
    expect(section).toContain(String(PROD_LENGTH));
    const m = sql168.match(/new md5\(prosrc\): ([0-9a-f]{32}) \(length ([0-9]+)\)/);
    expect(section).toContain(m?.[1] ?? "no-md5");
    expect(section).toContain(String(m?.[2] ?? "no-length"));
  });

  it("states the evidence and the rule", () => {
    for (const word of ["85ef184c", "167", "0.42", "one row per event", "min(uuid)", "105"]) {
      expect(section, word).toContain(word);
    }
  });

  it("says apply only: no Next.js change", () => {
    expect(section).toContain("APPLY 168");
    expect(section).toMatch(/no (app|Next\.js) (change|deploy)/i);
  });

  it("verifies the fingerprint, the privileges, the ledger and a draw", () => {
    for (const word of ["md5(prosrc)", "has_function_privilege", "schema_migrations", "version = '168'", "framing_next_headline"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs only 105's draw statement, drops the 168 index and deletes only the 168 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("105_framing_candidate_pool.sql");
    expect(rb).toContain("version = '168'");
    expect(rb).toContain(PROD_MD5);
    expect(rb).toContain(`drop index if exists public.${INDEX_NAME};`);
  });

  it("documents the session_hash index in What, Verify, Cost and Rollback, and states the NOT IN measurement", () => {
    const para = (label: string): string => section.split("\n\n").find((p) => p.startsWith(label)) ?? "";
    const what = para("**What 168 does**");
    const cost = para("**Cost**");
    const verify = para("**Verify**");
    const rollback = para("**Rollback:**");
    for (const [name, text] of [["What", what], ["Cost", cost], ["Verify", verify], ["Rollback", rollback]] as const) {
      expect(text.length, `a ${name} paragraph`).toBeGreaterThan(0);
      expect(text, name).toContain(INDEX_NAME);
    }
    expect(what).toContain("(session_hash, article_id)");
    expect(verify).toContain("pg_indexes");
    expect(cost).toContain("NOT IN");
    expect(cost).toContain("31 ms");
    expect(cost).toContain("215");
    expect(cost).toContain("1.45M");
    // the index is part of 168 now: no "belongs in a later migration", no "No table, column, index"
    expect(section.includes("belongs in a later migration")).toBe(false);
    expect(section.includes("No table, column, index")).toBe(false);
    expect(section).toContain("APPLY 168 only");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("168 live manifest and dry-run", () => {
  it("builds 168's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 168-framing-draw-one-per-event.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/168-framing-draw-one-per-event-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 105's state (gated on the production md5), shows the defect, applies 168 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/168_framing_draw_one_per_event.sql",
      "../../../supabase/migrations/168_framing_draw_one_per_event.sql",
    ]);
    expect(sql).toContain(PROD_MD5);
    const m = sql168.match(/new md5\(prosrc\): ([0-9a-f]{32}) \(length ([0-9]+)\)/);
    expect(sql).toContain(m?.[1] ?? "no-md5");
    // the index 168 creates: absent in the prelude, present exactly once (with the right columns) after two applies
    expect(sql).toContain(`from pg_indexes where schemaname = 'public' and indexname = '${INDEX_NAME}'`);
    expect(sql).toContain("indexdef like '%(session_hash, article_id)%'");
    expect(sql).toContain("baseline: the session_hash index must not exist before 168");
    expect(sql).toContain("168: the session_hash index is not exactly one index on (session_hash, article_id)");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 168 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the draw against fixtures, on a throwaway Postgres with 168 applied by its dry-run script
// (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server. Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("168 framing_next_headline against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("168", {
    ledger: ["168"],
    relations: ["public.framing_votes", "public.framing_candidate_pool", "public.cluster_articles"],
    functions: ["public.framing_next_headline(text)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  /** A session hash: the 068 CHECK wants 32..128 characters. */
  const session = (tag: string): string => `${tag}${"0".repeat(40)}`;
  const articleUuid = (n: number): string => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const clusterUuid = (n: number): string => `c0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);

  interface Art {
    n: number;
    title: string;
    /** cluster number, or null for an unclustered article */
    cluster: number | null;
    /** hours before now() */
    ageHours?: number;
    /** false: the article exists (and may be voted on) but is not in the pool, like one that aged out */
    inPool?: boolean;
    /** the title stored in the pool row, when it differs from articles.title (null: a null pool title) */
    poolTitle?: string | null;
  }

  /** The SQL that builds the fixture rows. */
  function fixture(arts: Art[]): string {
    const clusters = [...new Set(arts.filter((a) => a.cluster !== null).map((a) => a.cluster as number))];
    const out: string[] = [
      "insert into public.sources (id, slug, name, active, kind) values ('00000000-0000-0000-0000-00000000f001', 'fx-outlet', 'fx', true, 'outlet');",
    ];
    if (clusters.length > 0) out.push(`insert into public.clusters (id) values ${clusters.map((c) => `('${clusterUuid(c)}')`).join(", ")};`);
    out.push(
      `insert into public.articles (id, source_id, title, published_at) values ${arts
        .map((a) => `('${articleUuid(a.n)}', '00000000-0000-0000-0000-00000000f001', ${lit(a.title)}, now() - interval '${a.ageHours ?? 1} hours')`)
        .join(", ")};`,
    );
    const links = arts.filter((a) => a.cluster !== null);
    if (links.length > 0) {
      out.push(`insert into public.cluster_articles (cluster_id, article_id) values ${links.map((a) => `('${clusterUuid(a.cluster as number)}', '${articleUuid(a.n)}')`).join(", ")};`);
    }
    const pool = arts.filter((a) => a.inPool !== false);
    out.push(
      `insert into public.framing_candidate_pool (article_id, title, published_at) values ${pool
        .map((a) => `('${articleUuid(a.n)}', ${lit(a.poolTitle === undefined ? a.title : a.poolTitle)}, now() - interval '${a.ageHours ?? 1} hours')`)
        .join(", ")};`,
    );
    return `${out.join("\n")}\n`;
  }

  const vote = (hash: string, n: number): string =>
    `insert into public.framing_votes (article_id, vote, session_hash) values ('${articleUuid(n)}', 'none', '${hash}');\n`;

  /**
   * `n` draws for ONE session (its votes do not change between them), as article numbers; "-" is a draw with no row.
   * The session argument depends on g, so the subquery is evaluated once per row, not once for the statement.
   */
  const drawSql = (hash: string, n: number): string =>
    `select coalesce((select right(f.article_id::text, 12)::int::text from public.framing_next_headline('${hash}' || substr('0', 1, g * 0)) f), '-') from generate_series(1, ${n}) g;\n`;

  /** Runs the fixture, then the given statements, in begin ... rollback; returns the output lines. */
  function inTx(arts: Art[], statements: string): string[] {
    return runPsql(`begin;\n${fixture(arts)}${statements}rollback;\n`)
      .split("\n")
      .filter((l) => l.trim() !== "");
  }

  /** `n` draws, each from its own fresh session (no votes). */
  const freshDrawSql = (n: number): string =>
    `select coalesce((select right(f.article_id::text, 12)::int::text from public.framing_next_headline('fresh-' || g) f), '-') from generate_series(1, ${n}) g;\n`;

  const share = (xs: string[], pick: (x: string) => boolean): number => xs.filter(pick).length / xs.length;

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers; stable, security definer, empty search_path, service_role only", () => {
    const out = runPsql(
      "select md5(prosrc) || '|' || length(prosrc) || '|' || provolatile::text || '|' || prosecdef || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = 'public.framing_next_headline(text)'::regprocedure;",
    ).trim();
    const body = body168();
    expect(out).toBe(`${md5(body)}|${body.length}|s|true|{"search_path=\\"\\""}|TABLE(article_id uuid, title text)|p_session_hash text`);
    const acl = runPsql(
      "select has_function_privilege('anon', 'public.framing_next_headline(text)', 'execute') || '|' || has_function_privilege('authenticated', 'public.framing_next_headline(text)', 'execute') || '|' || has_function_privilege('service_role', 'public.framing_next_headline(text)', 'execute');",
    ).trim();
    expect(acl).toBe("false|false|true");
  });

  it("framing_votes has the (session_hash, article_id) index 168 creates, once", () => {
    const out = runPsql(
      `select count(*) from pg_indexes where schemaname = 'public' and tablename = 'framing_votes' and indexname = '${INDEX_NAME}' and indexdef like '%(session_hash, article_id)%';`,
    ).trim();
    expect(out).toBe("1");
  });

  it("is idempotent: one 168 ledger row, and the stored comment names 168", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '168';").trim()).toBe("1");
    expect(runPsql("select obj_description('public.framing_next_headline(text)'::regprocedure, 'pg_proc');")).toContain("168");
  });

  it("an empty pool draws no row", () => {
    const out = runPsql("select count(*) from public.framing_next_headline('nobody" + "0".repeat(40) + "');").trim();
    expect(out).toBe("0");
  });

  it("every event has an equal chance whatever its copy count: 5 copies of one story against 1 of another is about 50/50 (105 gave 83/17)", { timeout: 120_000 }, () => {
    const arts: Art[] = [
      ...[1, 2, 3, 4, 5].map((n) => ({ n, title: `Story A copy ${n}`, cluster: 1 })),
      { n: 6, title: "Story B", cluster: 2 },
    ];
    const draws = inTx(arts, freshDrawSql(800));
    expect(draws).toHaveLength(800);
    const a = share(draws, (x) => Number(x) >= 1 && Number(x) <= 5);
    expect(a).toBeGreaterThan(0.4);
    expect(a).toBeLessThan(0.6);
  });

  it("a story without a cluster counts as one event too, keyed by its normalised title (copies in different case and spacing are one event)", { timeout: 120_000 }, () => {
    const arts: Art[] = [
      { n: 1, title: "Same  Headline", cluster: null },
      { n: 2, title: "same headline", cluster: null },
      { n: 3, title: "SAME\theadline", cluster: null },
      { n: 4, title: "Another story", cluster: null },
    ];
    const draws = inTx(arts, freshDrawSql(800));
    const same = share(draws, (x) => Number(x) >= 1 && Number(x) <= 3);
    expect(same).toBeGreaterThan(0.4);
    expect(same).toBeLessThan(0.6);
  });

  it("once a session votes on an article, no other article of its cluster is drawn for it again; a different session still gets the cluster", () => {
    const hash = session("voter-a");
    const arts: Art[] = [
      ...[1, 2, 3, 4, 5].map((n) => ({ n, title: `Story A copy ${n}`, cluster: 1 })),
      { n: 6, title: "Story B", cluster: 2 },
    ];
    const lines = inTx(arts, `${vote(hash, 1)}${drawSql(hash, 300)}${freshDrawSql(300)}`);
    const voter = lines.slice(0, 300);
    const other = lines.slice(300);
    expect(new Set(voter)).toEqual(new Set(["6"]));
    expect(other.some((x) => Number(x) >= 1 && Number(x) <= 5)).toBe(true);
  });

  it("when every event has been voted on, the draw returns no row (the game's empty-pool state)", () => {
    const hash = session("voter-b");
    const arts: Art[] = [
      { n: 1, title: "Story A copy 1", cluster: 1 },
      { n: 2, title: "Story A copy 2", cluster: 1 },
      { n: 3, title: "Story B", cluster: 2 },
    ];
    const lines = inTx(arts, `${vote(hash, 1)}${vote(hash, 3)}${drawSql(hash, 50)}`);
    expect(new Set(lines)).toEqual(new Set(["-"]));
  });

  it("byte-identical text in another cluster (or in none) is excluded after a vote, whatever its case and whitespace", () => {
    const hash = session("voter-c");
    const arts: Art[] = [
      { n: 1, title: "Same  Headline", cluster: 1 },
      { n: 2, title: "same headline", cluster: 2 },
      { n: 3, title: "SAME\theadline", cluster: null },
      { n: 4, title: "Something else", cluster: 3 },
    ];
    const lines = inTx(arts, `${vote(hash, 1)}${drawSql(hash, 200)}`);
    expect(new Set(lines)).toEqual(new Set(["4"]));
  });

  it("a voted article that has aged out of the pool still excludes its cluster and its text (voted_clusters and voted_keys read articles)", () => {
    const hash = session("voter-d");
    const arts: Art[] = [
      { n: 1, title: "Aged out story", cluster: 1, inPool: false, ageHours: 60 },
      { n: 2, title: "A sibling in the same cluster", cluster: 1 },
      { n: 3, title: "aged   OUT story", cluster: 2 },
      { n: 4, title: "Unrelated", cluster: 3 },
    ];
    const lines = inTx(arts, `${vote(hash, 1)}${drawSql(hash, 200)}`);
    expect(new Set(lines)).toEqual(new Set(["4"]));
  });

  it("another session's votes exclude nothing for this session", () => {
    const arts: Art[] = [
      { n: 1, title: "Story A", cluster: 1 },
      { n: 2, title: "Story B", cluster: 2 },
    ];
    const lines = inTx(arts, `${vote(session("voter-e"), 1)}${freshDrawSql(300)}`);
    expect(new Set(lines)).toEqual(new Set(["1", "2"]));
  });

  it("a null pool title is not swallowed by the voted-title exclusion (NOT EXISTS, not NOT IN)", () => {
    const hash = session("voter-f");
    const arts: Art[] = [
      { n: 1, title: "Voted story", cluster: 1 },
      { n: 2, title: "Pool row without a title", cluster: null, poolTitle: null },
    ];
    const lines = inTx(arts, `${vote(hash, 1)}${drawSql(hash, 100)}`);
    expect(new Set(lines)).toEqual(new Set(["2"]));
  });

  it("keeps the newest-300 window and the 48 h window: of 305 events only the newest 300 are drawn, and a 49 h old row never", { timeout: 120_000 }, () => {
    const arts: Art[] = Array.from({ length: 306 }, (_, i) => ({
      n: i + 1,
      title: `Event ${i + 1}`,
      cluster: i + 1,
      // 1 is the newest; article 306 is 49 h old and outside the window whatever its rank
      ageHours: i + 1 === 306 ? 49 : (i + 1) * 0.05,
    }));
    const draws = inTx(arts, freshDrawSql(1500));
    const ids = draws.map(Number);
    expect(Math.max(...ids)).toBeLessThanOrEqual(300);
    expect(new Set(ids).size).toBeGreaterThan(250);
  });

  it("the window slides past voted events: after voting on the newest 5 of 305 events, the 5 oldest become drawable and the voted 5 never return", { timeout: 120_000 }, () => {
    const hash = session("voter-g");
    const arts: Art[] = Array.from({ length: 305 }, (_, i) => ({ n: i + 1, title: `Event ${i + 1}`, cluster: i + 1, ageHours: (i + 1) * 0.05 }));
    const votes = [1, 2, 3, 4, 5].map((n) => vote(hash, n)).join("");
    const ids = inTx(arts, `${votes}${drawSql(hash, 4000)}`).map(Number);
    const seen = new Set(ids);
    for (const n of [1, 2, 3, 4, 5]) expect(seen.has(n), `voted event ${n} must not return`).toBe(false);
    for (const n of [301, 302, 303, 304, 305]) expect(seen.has(n), `event ${n} slid into the window`).toBe(true);
  });

  it("keeps the fewer-than-5-votes-first rule: an event whose only article has 5 votes is never drawn while others have fewer", () => {
    const arts: Art[] = [
      { n: 1, title: "No votes yet", cluster: 1 },
      { n: 2, title: "Five votes", cluster: 2 },
      { n: 3, title: "Four votes", cluster: 3 },
    ];
    let votes = "";
    for (let i = 0; i < 5; i++) votes += vote(session(`crowd-${i}`), 2);
    for (let i = 0; i < 4; i++) votes += vote(session(`crowd-${i}`), 3);
    const draws = inTx(arts, `${votes}${freshDrawSql(400)}`);
    expect(new Set(draws)).toEqual(new Set(["1", "3"]));
    const three = share(draws, (x) => x === "3");
    expect(three).toBeGreaterThan(0.35);
    expect(three).toBeLessThan(0.65);
  });

  it("a session never gets two headlines of one event over a whole simulated run of votes", { timeout: 120_000 }, () => {
    const hash = session("voter-h");
    // 40 events with 1 to 6 copies each
    const arts: Art[] = [];
    let n = 0;
    for (let c = 1; c <= 40; c++) {
      const copies = (c % 6) + 1;
      for (let k = 0; k < copies; k++) arts.push({ n: ++n, title: `Event ${c} copy ${k}`, cluster: c, ageHours: 1 + c * 0.1 });
    }
    // draw, vote on the draw, repeat: a plpgsql loop inside the transaction
    const lines = inTx(
      arts,
      `do $loop$
declare a uuid; c uuid; seen uuid[] := '{}'; dup int := 0; i int;
begin
  for i in 1..45 loop
    select f.article_id into a from public.framing_next_headline('${hash}') f;
    exit when a is null;
    select ca.cluster_id into c from public.cluster_articles ca where ca.article_id = a;
    if c = any(seen) then dup := dup + 1; end if;
    seen := seen || c;
    insert into public.framing_votes (article_id, vote, session_hash) values (a, 'none', '${hash}');
  end loop;
  create temp table sim_result on commit drop as select dup, coalesce(array_length(seen, 1), 0) as events;
end
$loop$;
select dup || '|' || events from sim_result;
`,
    );
    // 40 events: 40 distinct draws and no repeat, then nothing left (the loop exits on the empty draw)
    expect(lines).toEqual(["0|40"]);
  });
});
