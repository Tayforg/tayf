import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BLINDSPOT } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 121 ("cluster-link-recompute").
//
// 027's cluster_link_atomic locks the cluster, inserts the member, recounts
// article_count and then writes the four aggregates (bias_distribution,
// is_blindspot, blindspot_side, first_published) exactly as the cluster-consumer
// computed them from a member snapshot it read BEFORE the lock. Two consumers
// linking into one cluster at the same time therefore both write a snapshot
// that lacks the other's article: the later writer wins and the other vote is
// lost (production clusters e0c1324a... and 52823177... carry exactly that).
// 121 keeps the signature and the first two steps and then recomputes the
// aggregates itself, under the lock, by delegating to 064's
// cluster_unlink_article(cluster, null). The caller's four aggregate arguments
// stay in the signature (the Edge Function keeps sending them) and are no longer
// read.
//
// This file pins:
//   * the migration is additive, one transaction, no drop function (a drop
//     strips the grants and breaks in-flight consumer calls), exactly one grant
//     (execute to service_role) and the 095 ledger row;
//   * the header of the function is 027's with `create or replace`, volatile;
//   * the body is 027's lock and insert, plus `for update` on the cluster row
//     and the recompute call, and never reads the four aggregate arguments;
//   * the facts it relies on in 064 (same lock key, voting kinds, one vote per
//     article) and the lock order of 099;
//   * the TypeScript contracts those SQL numbers mirror.
// The last block (opt-in, TAYF_PSQL) runs the function against fixtures in
// rolled-back transactions on a throwaway Postgres with 027, 064 and 121.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_121 = resolve(MIGRATIONS_DIR, "121_cluster_link_recompute.sql");
const MIGRATION_027 = resolve(MIGRATIONS_DIR, "027_cluster_link_atomic.sql");
const MIGRATION_064 = resolve(MIGRATIONS_DIR, "064_jev_cluster_live.sql");
const MIGRATION_099 = resolve(MIGRATIONS_DIR, "099_cluster_merge.sql");

const SIG = "public.cluster_link_atomic(uuid, uuid, jsonb, boolean, text, timestamptz)";

const AGGREGATE_PARAMS = ["p_bias_distribution", "p_is_blindspot", "p_blindspot_side", "p_first_published"];

const BIAS_KEYS = [
  "pro_government",
  "gov_leaning",
  "state_media",
  "center",
  "opposition_leaning",
  "opposition",
  "nationalist",
  "islamist_conservative",
  "pro_kurdish",
  "international",
];

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed form, for byte-for-byte preservation checks. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** The `create [or replace] function public.<name>(...) ... as $$ ... $$;` block. */
function dollarBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\bas\\s+\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** The `create [or replace] function public.<name>(...) ... as $fn$ ... $fn$;` block. */
function fnBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\bas\\s+\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** Everything before `as $$` / `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$[a-z]*\$/i);
  return block.slice(0, idx);
}

/** Only the SQL between the `$$` quotes. */
function dollarBody(block: string): string {
  const m = block.match(/\bas\s+\$\$([\s\S]*?)\$\$/i);
  if (!m || m[1] === undefined) throw new Error("no $$ body");
  return m[1];
}

/** The first statement `perform pg_catalog.pg_advisory_xact_lock( ... );` of a body, normalised. */
function lockStatement(fnBody: string): string {
  const m = /perform\s+pg_catalog\.pg_advisory_xact_lock\s*\([\s\S]*?\)\s*;/i.exec(stripSqlComments(fnBody));
  if (!m) throw new Error("no advisory lock statement");
  return norm(m[0]);
}

let sql = "";
let code = "";
let block = "";
let blockCode = "";
let bodyRaw = "";
let bodyNorm = "";
let codeOutsideFn = "";
let sql027 = "";
let block027 = "";
let body027Norm = "";
let sql064 = "";
let unlinkBlock = "";
let unlinkNorm = "";
let sql099 = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_121), "121_cluster_link_recompute.sql must exist").toBe(true);
  sql = readFileSync(MIGRATION_121, "utf8");
  code = stripSqlComments(sql);
  // the header comments quote `create or replace function ...` in the rollback notes, so
  // the raw block is looked up after the transaction starts
  block = dollarBlock(sql.slice(sql.search(/^\s*begin\s*;/im)), "cluster_link_atomic");
  blockCode = dollarBlock(code, "cluster_link_atomic");
  bodyRaw = dollarBody(block);
  bodyNorm = norm(dollarBody(blockCode));
  codeOutsideFn = code.replace(blockCode, "");
  sql027 = readFileSync(MIGRATION_027, "utf8");
  block027 = dollarBlock(stripSqlComments(sql027), "cluster_link_atomic");
  body027Norm = norm(dollarBody(block027));
  sql064 = readFileSync(MIGRATION_064, "utf8");
  unlinkBlock = fnBlock(stripSqlComments(sql064), "cluster_unlink_article");
  unlinkNorm = norm(unlinkBlock);
  sql099 = readFileSync(MIGRATION_099, "utf8");
});

describe("121 ledger, structure and header", () => {
  it("is one transaction: begin, set local lock_timeout = '5s', ..., ledger insert, commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(code).toMatch(/begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function\s+public\.cluster_link_atomic/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("records itself as version '121' in the 095 pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'121'\s*,\s*'121_cluster_link_recompute'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
  });

  it("runs in the order function, comment, revoke, grant, ledger", () => {
    const fn = code.search(/create\s+or\s+replace\s+function\s+public\.cluster_link_atomic/i);
    const comment = code.search(/comment\s+on\s+function\s+public\.cluster_link_atomic/i);
    const revoke = code.search(/revoke\s+execute\s+on\s+function\s+public\.cluster_link_atomic/i);
    const grant = code.search(/grant\s+execute\s+on\s+function\s+public\.cluster_link_atomic/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(fn).toBeGreaterThan(0);
    expect(comment).toBeGreaterThan(fn);
    expect(revoke).toBeGreaterThan(comment);
    expect(grant).toBeGreaterThan(revoke);
    expect(ledger).toBeGreaterThan(grant);
  });

  it("the header documents WHY, WHAT, Step 0, both dry runs, deploy, rollback, the drift query and the evidence", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    for (const section of ["WHY", "WHAT CHANGES", "STEP 0", "DRY RUNS (×2)", "DEPLOY", "ROLLBACK", "DRIFT QUERY"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    // the two production clusters that lost a vote
    expect(head).toContain("e0c1324a");
    expect(head).toContain("52823177");
    // Step 0: version free, deployed bodies compared by md5
    expect(head).toMatch(/Version 121 is free/i);
    expect(head).toContain("7068567690bc483ee0941c47a503428f"); // cluster_unlink_article == 064
    expect(head).toContain("c99eb293f647eb4706c420e1613020f7"); // ops_health_report == 119
    expect(head).toContain("4e49f91c587689f631e1f1742a56f15d"); // deployed cluster_link_atomic
    expect(head).toContain("55ffcfb19969b99c930571ef6489bffe"); // 027's text between the quotes
    // the concurrent replay and the idempotent second run
    expect(head).toMatch(/concurrent/i);
    expect(head).toMatch(/INSERT 0 0/);
    // rollback re-applies 027 and removes the ledger row
    expect(head).toContain("027_cluster_link_atomic.sql");
    expect(head).toMatch(/ledger row 121/i);
    // the optional operator repair is documented, not run
    expect(head).toMatch(/cluster_unlink_article\(id, null\)/);
  });

  it("the header carries the drift query verbatim (live, 30 days, voting kinds, non-zero keys only)", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    const flat = head.replace(/^--\s?/gm, "").replace(/\s+/g, " ");
    for (const piece of [
      "with live as (select c.id, c.bias_distribution from public.clusters c where not c.is_archived and c.merged_into is null and c.article_count >= 2 and c.updated_at >= now() - interval '30 days')",
      "where s.kind in ('outlet','wire') group by l.id, s.bias)",
      "where (e.value)::int > 0",
      "where sto.d <> rec.d order by 1;",
    ]) {
      expect(flat, piece).toContain(piece);
    }
  });
});

describe("121 additive shape", () => {
  it("never drops the function: a drop strips the grants and breaks in-flight consumer calls", () => {
    expect(code).not.toMatch(/\bdrop\s+function\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  it("creates no table, alters no table, deletes and truncates nothing outside the function", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+(table|sequence|view)\b/i);
    expect(codeOutsideFn).not.toMatch(/\b(delete|truncate|update|vacuum|analyze)\b/i);
    expect(codeOutsideFn).not.toMatch(/\bcron\./i);
    // the only insert outside the function body is the ledger row
    const inserts = [...codeOutsideFn.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("re-creates exactly one function, with create or replace", () => {
    const creates = [...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\s+([a-z_.]+)/gi)];
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toBeTruthy();
    expect(creates[0]?.[2]).toBe("public.cluster_link_atomic");
  });

  it("grants execute to service_role only, exactly once, and revokes from anon, authenticated and public", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual([`grant execute on function ${SIG} to service_role;`]);
    expect(code).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual([`revoke execute on function ${SIG} from anon, authenticated, public;`]);
  });

  it("the function header is 027's with `create or replace`: same signature, security definer, search_path = '', no volatility keyword", () => {
    const h121 = norm(header(blockCode));
    const h027 = norm(header(block027));
    expect(h027).toMatch(/^create function public\.cluster_link_atomic/i);
    expect(h121).toBe(h027.replace(/^create function/i, "create or replace function"));
    expect(h121).toMatch(/\bsecurity definer\b/i);
    expect(h121).toMatch(/\bset search_path = ''/i);
    // volatile by default: every statement must see the insert the previous lock holder committed
    expect(h121).not.toMatch(/\b(stable|immutable)\b/i);
    expect(bodyNorm).not.toMatch(/\b(stable|immutable)\b/i);
    for (const p of AGGREGATE_PARAMS) expect(h121, p).toContain(p);
  });

  it("comments the function for 121 and keeps the liveness note", () => {
    const head = /comment\s+on\s+function\s+public\.cluster_link_atomic\s*\(\s*uuid,\s*uuid,\s*jsonb,\s*boolean,\s*text,\s*timestamptz\s*\)\s+is\s+/i.exec(code);
    expect(head, "comment on function").not.toBeNull();
    // Hand scan to the first `;` outside a quoted literal ('' is an escaped quote,
    // which toggles twice and so needs no special case) -- no nested quantifier.
    const start = (head as RegExpExecArray).index + (head as RegExpExecArray)[0].length;
    let end = start;
    let quoted = false;
    for (; end < code.length; end++) {
      const ch = code[end];
      if (ch === "'") quoted = !quoted;
      else if (ch === ";" && !quoted) break;
    }
    expect(end, "comment terminated").toBeLessThan(code.length);
    const text = code.slice(start, end);
    expect(text).toContain("cluster_unlink_article");
    expect(text).toMatch(/ignored/i);
    expect(text).toContain("121");
    expect(text).toContain("updated_at");
    expect(text).toContain("/api/health");
    expect(text).toContain("pg_advisory_xact_lock");
  });
});

describe("121 function body", () => {
  it("declares only v_inserted_rows (027's v_count is gone with the update)", () => {
    const m = /^\s*declare\s+([\s\S]*?)\bbegin\b/i.exec(stripSqlComments(dollarBody(blockCode)));
    expect(m).not.toBeNull();
    expect(norm((m as RegExpExecArray)[1] as string)).toBe("v_inserted_rows int;");
  });

  it("starts with 027's advisory lock, byte for byte", () => {
    expect(lockStatement(dollarBody(blockCode))).toBe(lockStatement(dollarBody(block027)));
    const afterBegin = bodyNorm.slice(bodyNorm.indexOf(" begin ") + " begin ".length);
    expect(afterBegin.startsWith(lockStatement(dollarBody(blockCode)))).toBe(true);
    expect(lockStatement(dollarBody(blockCode))).toBe(
      "perform pg_catalog.pg_advisory_xact_lock( pg_catalog.hashtext(p_cluster_id::text) );",
    );
  });

  it("locks the cluster row after the advisory lock and before the insert", () => {
    const lock = bodyNorm.indexOf("pg_advisory_xact_lock");
    const rowLock = bodyNorm.indexOf("perform 1 from public.clusters c where c.id = p_cluster_id for update;");
    const insert = bodyNorm.indexOf("insert into public.cluster_articles");
    expect(lock).toBeGreaterThan(0);
    expect(rowLock).toBeGreaterThan(lock);
    expect(insert).toBeGreaterThan(rowLock);
    expect([...bodyNorm.matchAll(/\bfor update\b/g)]).toHaveLength(1);
  });

  it("keeps 027's insert and get diagnostics, byte for byte", () => {
    const m = /insert into public\.cluster_articles[\s\S]*?get diagnostics v_inserted_rows = row_count;/i.exec(body027Norm);
    expect(m, "027 insert + get diagnostics").not.toBeNull();
    expect(bodyNorm).toContain((m as RegExpExecArray)[0]);
    expect((m as RegExpExecArray)[0]).toBe(
      "insert into public.cluster_articles (cluster_id, article_id) values (p_cluster_id, p_article_id) on conflict do nothing; get diagnostics v_inserted_rows = row_count;",
    );
  });

  it("recomputes through cluster_unlink_article(p_cluster_id, null) right after the insert", () => {
    const diag = bodyNorm.indexOf("get diagnostics v_inserted_rows = row_count;");
    const call = bodyNorm.indexOf("perform public.cluster_unlink_article(p_cluster_id, null);");
    expect(diag).toBeGreaterThan(0);
    expect(call).toBeGreaterThan(diag);
    // nothing but the recompute sits between the diagnostics and the call
    const between = bodyNorm.slice(diag + "get diagnostics v_inserted_rows = row_count;".length, call).trim();
    expect(between).toBe("");
    expect([...bodyNorm.matchAll(/cluster_unlink_article/g)]).toHaveLength(1);
  });

  it("never reads the four aggregate arguments and never updates clusters itself", () => {
    for (const p of AGGREGATE_PARAMS) expect(bodyNorm, p).not.toContain(p);
    expect(bodyNorm).not.toMatch(/\bupdate\s+public\.clusters\b/i);
    // the only `update` left in the body is the `for update` row lock
    expect(bodyNorm.replace(/\bfor update\b/g, "")).not.toMatch(/\bupdate\b/i);
    expect(bodyNorm).not.toMatch(/\bdelete\b/i);
    expect(bodyNorm).not.toMatch(/\bcount\s*\(/i);
  });

  it("ends with `return v_inserted_rows > 0;`", () => {
    expect(bodyNorm.endsWith("return v_inserted_rows > 0; end;")).toBe(true);
    const call = bodyNorm.indexOf("perform public.cluster_unlink_article");
    expect(bodyNorm.indexOf("return v_inserted_rows > 0;")).toBeGreaterThan(call);
    expect([...bodyNorm.matchAll(/\breturn\b/g)]).toHaveLength(1);
  });

  it("explains in a comment that the four aggregate arguments are kept for signature compatibility and not read", () => {
    expect(bodyRaw).toMatch(/signature compatibility/i);
    expect(bodyRaw).toMatch(/not read|deliberately/i);
  });
});

describe("121 relies on 064 and 099 as they are", () => {
  it("064's cluster_unlink_article takes the same advisory lock key as 027 and 121", () => {
    // 064 writes the call on one line, 027 over three: the same statement up to layout
    const squash = (stmt: string) => stmt.replace(/\s+/g, "");
    const unlinkLock = squash(lockStatement(unlinkBlock));
    expect(unlinkLock).toBe(squash(lockStatement(dollarBody(block027))));
    expect(unlinkLock).toBe(squash(lockStatement(dollarBody(blockCode))));
    expect(unlinkLock).toBe("performpg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_cluster_id::text));");
  });

  it("064 recomputes the distribution from the voting kinds, one vote per article (no distinct)", () => {
    expect(unlinkNorm).toContain("s.kind in ('outlet', 'wire')");
    expect(unlinkNorm).not.toMatch(/\bdistinct\b/i);
    expect(unlinkNorm).toContain("pg_catalog.count(v.bias_key) filter (where v.bias_key = 'center')");
    for (const key of BIAS_KEYS) {
      expect(unlinkNorm, key).toContain(`'${key}', pg_catalog.count(v.bias_key) filter (where v.bias_key = '${key}')`);
    }
  });

  it("064 re-derives the blindspot verdict under the 5 / 0.8 contract and stamps updated_at = now()", () => {
    expect(unlinkNorm).toContain(">= 5");
    expect(unlinkNorm).toContain(">= 0.8");
    expect(unlinkNorm).toContain("updated_at = pg_catalog.now()");
    expect(unlinkNorm).toContain("pg_catalog.min(a.published_at)");
  });

  it("a null article id deletes nothing and matches no jev_unlink_candidates row", () => {
    expect(unlinkNorm).toContain("delete from public.cluster_articles ca where ca.cluster_id = p_cluster_id and ca.article_id = p_article_id;");
    expect(unlinkNorm).toContain("u.cluster_id = p_cluster_id and u.article_id = p_article_id and u.status = 'pending'");
  });

  it("099 already uses the null-article call as a pure recompute", () => {
    expect(norm(sql099)).toContain("perform public.cluster_unlink_article(p_target, null::uuid);");
  });

  it("lock order: 099 takes its advisory locks before FOR UPDATE on clusters, the order 121 takes", () => {
    const merge = norm(sql099);
    const advisory = merge.indexOf("pg_advisory_xact_lock(pg_catalog.hashtext(least(p_source, p_target)::text))");
    const rowLock = merge.indexOf("from public.clusters where id = p_source for update");
    expect(advisory).toBeGreaterThan(0);
    expect(rowLock).toBeGreaterThan(advisory);
  });
});

describe("121 mirrors the TypeScript contracts", () => {
  it("VOTING_SOURCE_KINDS is ['outlet', 'wire'], the filter 064 applies", () => {
    expect([...VOTING_SOURCE_KINDS]).toEqual(["outlet", "wire"]);
  });

  it("the blindspot contract is 5 sources and a 0.8 dominant share, the numbers 064 applies", () => {
    expect(BLINDSPOT.minSources).toBe(5);
    expect(BLINDSPOT.dominantShare).toBe(0.8);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway
// Postgres with 027, 064 and then 121 applied. TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every fixture sits inside a
// transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("121 cluster_link_atomic against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const columnExists = (table: string, column: string): boolean =>
    runPsql(
      `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${column}');`,
    ).trim() === "t";

  /** Deterministic uuid: namespace 1-9, index n. */
  const uid = (ns: number, n: number) => `00000000-0000-4000-8121-${String(ns).padStart(2, "0")}${String(n).padStart(10, "0")}`;

  interface Member {
    key: string;
    bias: string;
    kind: string;
    publishedAt: string;
  }

  let fullSchema = false;
  let withHash = false;

  beforeAll(() => {
    fullSchema = columnExists("clusters", "summary_tr");
    withHash = columnExists("articles", "content_hash");
  });

  /** Sources, articles and one cluster for the members; the cluster starts with a bogus aggregate. */
  function fixture(tag: number, members: readonly Member[]): { sql: string; cluster: string; article: (i: number) => string } {
    const cluster = uid(tag, 0);
    const srcs = members.map(
      (m, i) =>
        `('${uid(tag, 100 + i)}', 'fx121 ${m.key}', 'fx121-${tag}-${m.key}', 'https://fx121-${tag}-${m.key}.invalid', 'https://fx121-${tag}-${m.key}.invalid/rss', '${m.bias}', '${m.kind}', true)`,
    );
    const arts = members.map((m, i) => {
      const url = `'https://fx121.invalid/${tag}/${m.key}/${i}'`;
      return `('${uid(tag, 200 + i)}', '${uid(tag, 100 + i)}', 'fx121 ${tag} ${i}', ${url}, '${m.publishedAt}'${withHash ? `, md5(${url})` : ""})`;
    });
    const clusterCols = fullSchema
      ? "id, title_tr, title_en, summary_tr, summary_en, first_published, updated_at, bias_distribution, article_count"
      : "id, title_tr, first_published, updated_at, bias_distribution, article_count";
    const clusterVals = fullSchema
      ? `'${cluster}', 'fx121', 'fx121', 'fx121', 'fx121', '1999-01-01T00:00:00Z', '2000-01-01T00:00:00Z', '{"center":7}'::jsonb, 0`
      : `'${cluster}', 'fx121', '1999-01-01T00:00:00Z', '2000-01-01T00:00:00Z', '{"center":7}'::jsonb, 0`;
    return {
      cluster,
      article: (i: number) => uid(tag, 200 + i),
      sql: `
insert into public.sources (id, name, slug, url, rss_url, bias, kind, active) values
  ${srcs.join(",\n  ")};
insert into public.articles (id, source_id, title, url, published_at${withHash ? ", content_hash" : ""}) values
  ${arts.join(",\n  ")};
insert into public.clusters (${clusterCols}) values (${clusterVals});
`,
    };
  }

  const KEYS_SORTED = [...BIAS_KEYS].sort();
  const keyList = KEYS_SORTED.map((k) => `'${k}'`).join(", ");

  /** One tagged row with the aggregates of the cluster. */
  const probe = (tag: string, cluster: string) =>
    `select '${tag}', article_count, is_blindspot, coalesce(blindspot_side, 'null'), to_char(first_published at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), (select string_agg(k || '=' || coalesce(bias_distribution ->> k, 'missing'), ',' order by k) from unnest(array[${keyList}]) as k), (select count(*) from jsonb_object_keys(bias_distribution)), (updated_at > '2000-01-01T00:00:00Z'::timestamptz) from public.clusters where id = '${cluster}';`;

  const link = (tag: string, cluster: string, article: string, dist: string, blind: string, side: string, first: string) =>
    `select '${tag}', public.cluster_link_atomic('${cluster}', '${article}', '${dist}'::jsonb, ${blind}, ${side}, '${first}'::timestamptz);`;

  function distOf(counts: Record<string, number>): string {
    return KEYS_SORTED.map((k) => `${k}=${counts[k] ?? 0}`).join(",");
  }

  function rows(out: string): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const line of out.split("\n").filter((l) => l.includes("|"))) {
      const [tag, ...rest] = line.split("|");
      m.set(tag as string, rest);
    }
    return m;
  }

  it("the target database runs 121: the ledger row is there and the function is the recomputing one", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '121';").trim()).toBe("1");
    const src = runPsql(`select prosrc from pg_proc where oid = '${SIG}'::regprocedure;`);
    expect(src).toContain("cluster_unlink_article");
    expect(src).toContain("for update");
    expect(src).not.toContain("update public.clusters");
  });

  describe("(a) the caller's aggregates are ignored and recomputed from the members under the lock", () => {
    // two voting members, then an aggregator article (not a voting kind) with a bogus caller aggregate
    const members: Member[] = [
      { key: "c", bias: "center", kind: "outlet", publishedAt: "2026-10-01T10:00:00Z" },
      { key: "o", bias: "opposition", kind: "outlet", publishedAt: "2026-10-01T11:00:00Z" },
      { key: "agg", bias: "pro_government", kind: "aggregator", publishedAt: "2026-09-30T08:00:00Z" },
    ];
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      const f = fixture(1, members);
      out = rows(
        runPsql(`
begin;
${f.sql}
${link("l1", f.cluster, f.article(0), '{"center":1}', "false", "null", "2026-10-01T10:00:00Z")}
${link("l2", f.cluster, f.article(1), '{"center":1,"opposition":1}', "false", "null", "2026-10-01T10:00:00Z")}
${probe("two", f.cluster)}
${link("l3", f.cluster, f.article(2), '{"center":99}', "true", "'center'", "2100-01-01T00:00:00Z")}
${probe("three", f.cluster)}
${link("dup", f.cluster, f.article(2), '{"international":5}', "true", "'international'", "2101-01-01T00:00:00Z")}
${probe("dup-after", f.cluster)}
rollback;
`),
      );
    });

    it("returns true for a new link", () => {
      expect(out.get("l1")).toEqual(["t"]);
      expect(out.get("l2")).toEqual(["t"]);
      expect(out.get("l3")).toEqual(["t"]);
    });

    it("heals the stale starting aggregate ({center: 7}) on the first link", () => {
      const two = out.get("two") as string[];
      expect(two[0]).toBe("2");
      expect(two[4]).toBe(distOf({ center: 1, opposition: 1 }));
    });

    it("an aggregator article raises article_count to 3 but casts no vote; the distribution has all ten keys", () => {
      const three = out.get("three") as string[];
      expect(three[0]).toBe("3");
      expect(three[4]).toBe(distOf({ center: 1, opposition: 1 }));
      expect(three[5]).toBe("10");
    });

    it("ignores the caller's is_blindspot, blindspot_side and first_published; first_published is the earliest member", () => {
      const three = out.get("three") as string[];
      expect(three[1]).toBe("f");
      expect(three[2]).toBe("null");
      expect(three[3]).toBe("2026-09-30 08:00");
    });

    it("stamps updated_at", () => {
      expect((out.get("three") as string[])[6]).toBe("t");
    });

    it("(b) the same call again returns false and leaves every aggregate unchanged, whatever the caller passes", () => {
      expect(out.get("dup")).toEqual(["f"]);
      expect(out.get("dup-after")).toEqual(out.get("three"));
    });
  });

  describe("(c) a one-sided cluster of five becomes a blindspot on the recompute, not on the caller's say-so", () => {
    const members: Member[] = [
      { key: "p1", bias: "pro_government", kind: "outlet", publishedAt: "2026-10-02T10:00:00Z" },
      { key: "p2", bias: "pro_government", kind: "outlet", publishedAt: "2026-10-02T10:05:00Z" },
      { key: "p3", bias: "pro_government", kind: "wire", publishedAt: "2026-10-02T10:10:00Z" },
      { key: "g1", bias: "gov_leaning", kind: "outlet", publishedAt: "2026-10-02T10:15:00Z" },
      { key: "g2", bias: "gov_leaning", kind: "outlet", publishedAt: "2026-10-02T10:20:00Z" },
    ];
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      const f = fixture(2, members);
      const links = members.map((_, i) => link(`l${i}`, f.cluster, f.article(i), "{}", "false", "null", "2100-01-01T00:00:00Z"));
      out = rows(
        runPsql(`
begin;
${f.sql}
${links.slice(0, 4).join("\n")}
${probe("four", f.cluster)}
${links[4]}
${probe("five", f.cluster)}
rollback;
`),
      );
    });

    it("four voting sources are not enough (minSources 5)", () => {
      const four = out.get("four") as string[];
      expect(four[0]).toBe("4");
      expect(four[1]).toBe("f");
      expect(four[2]).toBe("null");
    });

    it("the fifth link makes it a blindspot with the dominant category as the side", () => {
      const five = out.get("five") as string[];
      expect(five[0]).toBe("5");
      expect(five[1]).toBe("t");
      expect(five[2]).toBe("pro_government");
      expect(five[4]).toBe(distOf({ pro_government: 3, gov_leaning: 2 }));
      expect(five[3]).toBe("2026-10-02 10:00");
    });
  });

  describe("(d) two articles from one source both count (the article-level definition 027 had)", () => {
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      const f = fixture(3, [{ key: "a", bias: "center", kind: "outlet", publishedAt: "2026-10-03T10:00:00Z" }]);
      // a second article of the same source
      const second = uid(3, 250);
      const url = "'https://fx121.invalid/3/a/second'";
      const extra = `insert into public.articles (id, source_id, title, url, published_at${withHash ? ", content_hash" : ""}) values ('${second}', '${uid(3, 100)}', 'fx121 3 second', ${url}, '2026-10-03T11:00:00Z'${withHash ? `, md5(${url})` : ""});`;
      out = rows(
        runPsql(`
begin;
${f.sql}
${extra}
${link("l1", f.cluster, f.article(0), "{}", "false", "null", "2100-01-01T00:00:00Z")}
${link("l2", f.cluster, second, "{}", "false", "null", "2100-01-01T00:00:00Z")}
${probe("two", f.cluster)}
rollback;
`),
      );
    });

    it("counts both articles of the one source as votes", () => {
      const two = out.get("two") as string[];
      expect(two[0]).toBe("2");
      expect(two[4]).toBe(distOf({ center: 2 }));
    });
  });

  it("rolled the fixtures back", () => {
    expect(runPsql("select count(*) from public.sources where slug like 'fx121-%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.articles where url like 'https://fx121.invalid/%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.clusters where title_tr = 'fx121';").trim()).toBe("0");
  });

  it("service_role only may execute; security definer; search_path is empty", () => {
    expect(
      runPsql(
        `select has_function_privilege('anon', '${SIG}', 'execute'), has_function_privilege('authenticated', '${SIG}', 'execute'), has_function_privilege('service_role', '${SIG}', 'execute');`,
      ).trim(),
    ).toBe("f|f|t");
    expect(runPsql(`select prosecdef, provolatile, proconfig = array['search_path=""']::text[] from pg_proc where oid = '${SIG}'::regprocedure;`).trim()).toBe(
      "t|v|t",
    );
  });
});
