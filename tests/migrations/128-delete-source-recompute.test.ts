import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 128 ("delete-source-recompute").
//
// POST /api/admin {action: "delete_source"} used to be a bare
// `.from("sources").delete().eq("id", id)`. The cascade (articles ->
// cluster_articles) removed the source's members from every cluster they sat
// in, but nothing recomputed those clusters: article_count, bias_distribution,
// is_blindspot, blindspot_side and first_published kept describing members that
// no longer exist (hunt 8, finding h8-admin-1). 128 turns the delete into a
// SECURITY DEFINER RPC that deletes the source and then recomputes every
// affected cluster by calling 064's cluster_unlink_article(cluster, null), the
// canonical recompute 121 and 099 already use.
//
// This file pins:
//   * the migration is additive, one transaction, create or replace only (no
//     drop function: a drop strips the grants), a single grant (execute to
//     service_role), a comment, and the 095 ledger row as the last statement;
//   * the header of the function and the order of its body: row lock on the
//     source, collect the affected clusters, cap, advisory locks in uuid order,
//     the one delete, the recompute loop, the return;
//   * the body never archives or deletes a cluster and has exactly one delete;
//   * the facts it relies on in 064 (the deployed body is the file's, byte for
//     byte, by md5);
//   * the documentation the operator needs (Step 0, dry runs, deploy, verify,
//     rollback).
// The last block (opt-in, TAYF_PSQL) runs the function against fixtures in
// rolled-back transactions on a throwaway Postgres with 064 and 128 applied.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_128 = resolve(MIGRATIONS_DIR, "128_delete_source_recompute.sql");
const MIGRATION_064 = resolve(MIGRATIONS_DIR, "064_jev_cluster_live.sql");

const SIG = "public.delete_source(uuid)";

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

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Comment-free, whitespace-collapsed form, for order and preservation checks. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** `( x )` -> `(x)`: layout-insensitive comparison of a signature. */
function tight(s: string): string {
  return s.replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
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

/** Everything before `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

/** Only the SQL between the $fn$ quotes. */
function fnBody(block: string): string {
  const m = block.match(/\bas\s+\$fn\$([\s\S]*?)\$fn\$/i);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

let sql = "";
let code = "";
let head = "";
let block = "";
let blockCode = "";
let bodyNorm = "";
let bodyBlank = "";
let execSql = "";
let sql064 = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_128), "128_delete_source_recompute.sql must exist").toBe(true);
  sql = readFileSync(MIGRATION_128, "utf8");
  code = stripSqlComments(sql);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  // the header comments quote `create or replace function ...` in the rollback notes, so
  // the raw block is looked up after the transaction starts
  block = fnBlock(sql.slice(sql.search(/^\s*begin\s*;/im)), "delete_source");
  blockCode = fnBlock(code, "delete_source");
  bodyNorm = tight(norm(fnBody(blockCode)));
  bodyBlank = sansStrings(bodyNorm);
  // executable SQL: no comments, no string literals, and the `for update` row lock removed
  execSql = sansStrings(code).replace(/\bfor\s+update\b/gi, "");
  sql064 = readFileSync(MIGRATION_064, "utf8");
});

describe("128 ledger, structure and header", () => {
  it("is one transaction: begin, set local lock_timeout = '5s', ..., ledger insert, commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(code).toMatch(/begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("records itself as version '128' in the 095 pattern, as the last statement before commit", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'128'\s*,\s*'128_delete_source_recompute'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function\s+public\.delete_source/i));
    // nothing but the ledger insert sits between it and commit
    const after = code.slice(ledger);
    expect([...after.matchAll(/;/g)]).toHaveLength(2);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(sql).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
    expect(sansStrings(code).length).toBeLessThan(code.length);
  });

  it("runs in the order function, comment, revoke, grant, ledger", () => {
    const fn = code.search(/create\s+or\s+replace\s+function\s+public\.delete_source/i);
    const comment = code.search(/comment\s+on\s+function\s+public\.delete_source/i);
    const revoke = code.search(/revoke\s+all\s+on\s+function\s+public\.delete_source/i);
    const grant = code.search(/grant\s+execute\s+on\s+function\s+public\.delete_source/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(fn).toBeGreaterThan(0);
    expect(comment).toBeGreaterThan(fn);
    expect(revoke).toBeGreaterThan(comment);
    expect(grant).toBeGreaterThan(revoke);
    expect(ledger).toBeGreaterThan(grant);
  });

  it("the header documents WHY, WHAT CHANGES, STEP 0, DRY RUNS, DEPLOY, VERIFY and ROLLBACK", () => {
    for (const section of ["WHY", "h8-admin-1", "WHAT CHANGES", "STEP 0", "DRY RUNS", "DEPLOY", "VERIFY", "ROLLBACK"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    expect(head).toMatch(/INSERT 0 0/);
  });

  it("Step 0 records the foreign keys, the per-source cluster counts, the 064 md5 and the free version", () => {
    expect(head).toContain("confdeltype");
    expect(head).toMatch(/23503/);
    expect(head).toMatch(/count\(distinct ca\.cluster_id\)/);
    expect(head).toContain("7068567690bc483ee0941c47a503428f"); // cluster_unlink_article == 064
    expect(head).toMatch(/Version 128 is free/i);
  });

  it("the header explains the lock order, the 2000 cap and the statement_timeout", () => {
    expect(head).toMatch(/lock order/i);
    expect(head).toMatch(/link_atomic/);
    expect(head).toMatch(/merge/i);
    expect(head).toMatch(/2000/);
    expect(head).toMatch(/lock table|max_locks_per_transaction/i);
    expect(head).toMatch(/statement_timeout/);
    expect(head).toMatch(/uuid order/i);
  });

  it("the header documents the return contract: NULL no such source, {} deleted with no clusters affected", () => {
    expect(head).toMatch(/NULL/);
    expect(head).toContain("'{}'");
    expect(head).toMatch(/article_count 0|article_count = 0/);
  });

  it("documents that updated_at is restored (099 step 10), not stamped, and why the home feed needs it", () => {
    expect(head).toMatch(/RESTORES? updated_at|restores? updated_at/);
    expect(head).toContain("099");
    expect(head).toMatch(/home feed/);
    expect(head).not.toMatch(/updated_at stamped/);
    expect(head).not.toMatch(/stamps updated_at = now\(\)\.\s*$/m);
    const comment = /comment\s+on\s+function\s+public\.delete_source\s*\(\s*uuid\s*\)\s+is\s+([\s\S]*?);\s*\n/i.exec(code);
    expect((comment as RegExpExecArray)[1]).toMatch(/restor/i);
  });

  it("the header verifies the privileges with has_function_privilege (anon f, authenticated f, service_role t)", () => {
    expect(head).toMatch(/has_function_privilege/);
    expect(head).toMatch(/f, f, t|f,\s*f,\s*t/);
  });

  it("rolls back with `drop function if exists public.delete_source(uuid)`, in comments only", () => {
    expect(head).toContain("drop function if exists public.delete_source(uuid)");
    expect(head).toMatch(/schema_migrations where version = '128'/);
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  it("never mentions the word 'iktidar' (zone-parity.test.ts counts every copy of the zone map)", () => {
    expect(sql).not.toMatch(/iktidar/i);
  });

  it("the VERIFY md5 and length are those of the function text between the fn quotes", () => {
    const raw = fnBody(block);
    expect(head).toContain(md5(raw));
    expect(head).toContain(String(raw.length));
    expect(head).toContain(`${md5(raw)}, ${raw.length}, t, v,`);
  });

  it("the Step 0 md5 is the md5 of 064's cluster_unlink_article body, byte for byte", () => {
    const body064 = fnBody(fnBlock(stripSqlComments(sql064), "cluster_unlink_article"));
    // 064 carries comments inside the body; the deployed text is the raw text between the quotes
    const raw = fnBody(fnBlock(sql064, "cluster_unlink_article"));
    expect(body064.length).toBeLessThan(raw.length);
    expect(md5(raw)).toBe("7068567690bc483ee0941c47a503428f");
    expect(raw.length).toBe(5899);
  });
});

describe("128 additive shape", () => {
  it("never drops anything (a drop strips the grants and breaks in-flight callers)", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
  });

  it("creates no table or index, alters nothing, schedules nothing", () => {
    expect(code).not.toMatch(/\bcreate\s+(unique\s+)?(table|index|trigger|view|extension|schema)\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\bcron\./i);
    expect(code).not.toMatch(/\b(vacuum|analyze)\b/i);
  });

  it("re-creates exactly one function, with create or replace", () => {
    const creates = [...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\s+([a-z_.]+)/gi)];
    expect(creates).toHaveLength(1);
    expect(creates[0]?.[1]).toBeTruthy();
    expect(creates[0]?.[2]).toBe("public.delete_source");
  });

  it("revokes all from public, anon and authenticated, and grants execute to service_role exactly once", () => {
    const revokes = [...code.matchAll(/\brevoke\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(revokes).toEqual([`revoke all on function ${SIG} from public, anon, authenticated;`]);
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual([`grant execute on function ${SIG} to service_role;`]);
    expect(code).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("comments the function", () => {
    const m = /comment\s+on\s+function\s+public\.delete_source\s*\(\s*uuid\s*\)\s+is\s+([\s\S]*?);\s*\n/i.exec(code);
    expect(m, "comment on function").not.toBeNull();
    const text = (m as RegExpExecArray)[1] as string;
    expect(text).toContain("128");
    expect(text).toContain("cluster_unlink_article");
    expect(text).toMatch(/service_role/);
    expect(text).toMatch(/null/i);
  });
});

describe("128 function header", () => {
  it("is `create or replace function public.delete_source(p_source_id uuid) returns uuid[] language plpgsql security definer set search_path = ''`", () => {
    expect(tight(norm(header(blockCode)))).toBe(
      "create or replace function public.delete_source(p_source_id uuid) returns uuid[] language plpgsql security definer set search_path = ''",
    );
  });

  it("is volatile (no stable / immutable): it deletes", () => {
    expect(norm(header(blockCode))).not.toMatch(/\b(stable|immutable)\b/i);
  });
});

describe("128 function body", () => {
  /** Index of the first match of `re` in the normalised body, or -1. */
  const at = (re: RegExp) => bodyNorm.search(re);

  it("declares exactly v_ids, v_cid and the updated_at snapshot (v_snap_ids, v_snap_at)", () => {
    const m = /^\s*declare\s+([\s\S]*?)\bbegin\b/i.exec(stripSqlComments(fnBody(blockCode)));
    expect(m).not.toBeNull();
    expect(norm((m as RegExpExecArray)[1] as string)).toBe(
      "v_ids uuid[]; v_cid uuid; v_snap_ids uuid[]; v_snap_at timestamptz[];",
    );
  });

  it("runs the ten steps in order", () => {
    const steps: [string, RegExp][] = [
      ["1 row lock on the source", /perform 1 from public\.sources s where s\.id = p_source_id for update;/],
      ["2 not found returns null", /if not found then return null; end if;/],
      [
        "3 collect the affected clusters, ordered",
        /select coalesce\(\s*pg_catalog\.array_agg\(\s*x\.cluster_id order by x\.cluster_id\s*\), '\{\}'::uuid\[\]\) into v_ids from \(\s*select distinct ca\.cluster_id from public\.cluster_articles ca join public\.articles a on a\.id = ca\.article_id where a\.source_id = p_source_id\s*\) x;/,
      ],
      ["4 cardinality guard", /if pg_catalog\.cardinality\(v_ids\) > 2000 then raise exception using errcode = '54000'/],
      [
        "5 advisory locks in array (uuid) order",
        /foreach v_cid in array v_ids loop perform pg_catalog\.pg_advisory_xact_lock\(\s*pg_catalog\.hashtext\(v_cid::text\)\s*\); end loop;/,
      ],
      [
        "6 snapshot updated_at of the affected clusters, under the locks",
        /select pg_catalog\.array_agg\(c\.id order by c\.id\), pg_catalog\.array_agg\(c\.updated_at order by c\.id\) into v_snap_ids, v_snap_at from public\.clusters c where c\.id = any \(v_ids\);/,
      ],
      ["7 the one delete", /delete from public\.sources s where s\.id = p_source_id;/],
      [
        "8 recompute every affected cluster",
        /foreach v_cid in array v_ids loop perform public\.cluster_unlink_article\(v_cid, null\); end loop;/,
      ],
      [
        "9 restore updated_at (a source delete is not news)",
        /update public\.clusters c set updated_at = v_snap_at\[s\.n::int\] from pg_catalog\.unnest\(v_snap_ids\) with ordinality as s\(cid, n\) where c\.id = s\.cid;/,
      ],
      ["10 return the ids", /return v_ids;/],
    ];
    let prev = -1;
    for (const [label, re] of steps) {
      const idx = at(re);
      expect(idx, `${label} is present`).toBeGreaterThanOrEqual(0);
      expect(idx, `${label} comes after the previous step`).toBeGreaterThan(prev);
      prev = idx;
    }
    expect(bodyNorm.endsWith("return v_ids; end;")).toBe(true);
  });

  it("returns exactly twice: null for no such source, the ids at the end", () => {
    expect([...bodyBlank.matchAll(/\breturn\b[^;]*;/gi)].map((m) => m[0])).toEqual(["return null;", "return v_ids;"]);
  });

  it("the cap raises SQLSTATE 54000 (program_limit_exceeded) and names the way out", () => {
    const m = /if pg_catalog\.cardinality\(v_ids\) > 2000 then ([\s\S]*?) end if;/.exec(bodyNorm);
    expect(m).not.toBeNull();
    const guard = (m as RegExpExecArray)[1] as string;
    expect(guard).toMatch(/^raise exception using errcode = '54000', message = /);
    expect(guard).toContain("128 delete_source: ");
    expect(guard).toContain("pg_catalog.cardinality(v_ids)::text");
    expect(guard).toContain("deactivate the source instead");
    // 2000 appears once as the threshold and once in the message
    expect([...bodyNorm.matchAll(/\b2000\b/g)]).toHaveLength(2);
  });

  it("locks the source row first, then the advisory locks, then deletes (the lock order of the header)", () => {
    const rowLock = at(/for update/);
    const advisory = at(/pg_advisory_xact_lock/);
    const del = at(/delete from public\.sources/);
    expect(rowLock).toBeGreaterThan(0);
    expect(advisory).toBeGreaterThan(rowLock);
    expect(del).toBeGreaterThan(advisory);
    expect([...bodyNorm.matchAll(/\bfor update\b/g)]).toHaveLength(1);
    expect([...bodyNorm.matchAll(/pg_advisory_xact_lock/g)]).toHaveLength(1);
    // the hashtext key is the one 027, 064 and 121 take
    expect(bodyNorm).toContain("pg_catalog.hashtext(v_cid::text)");
  });

  it("recomputes through cluster_unlink_article(v_cid, null) and only there", () => {
    expect([...bodyNorm.matchAll(/cluster_unlink_article/g)]).toHaveLength(1);
    expect([...bodyNorm.matchAll(/\bforeach\b/g)]).toHaveLength(2);
  });

  it("has exactly one delete, on public.sources, and no write besides the updated_at restore", () => {
    const deletes = [...execSql.matchAll(/\bdelete\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(deletes).toEqual(["delete from public.sources s where s.id = p_source_id;"]);
    // the one update is the updated_at restore: it sets nothing else
    const updates = [...execSql.matchAll(/\bupdate\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(updates).toEqual([
      "update public.clusters c set updated_at = v_snap_at[s.n::int] from pg_catalog.unnest(v_snap_ids) with ordinality as s(cid, n) where c.id = s.cid;",
    ]);
    expect(execSql).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(execSql).not.toMatch(/\btruncate\b/i);
    expect(execSql).not.toMatch(/\bdrop\b/i);
    // the only insert in the whole file is the ledger row
    expect([...execSql.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1])).toEqual([
      "supabase_migrations.schema_migrations",
    ]);
  });

  it("never archives or deletes a cluster: public.clusters appears only in the updated_at snapshot and restore", () => {
    const refs = [...execSql.matchAll(/public\.clusters\b/gi)];
    expect(refs).toHaveLength(2);
    expect(execSql).not.toMatch(/\bis_archived\b|\bmerged_into\b|\barchiv/i);
    expect(execSql).not.toMatch(/\bdelete\s+from\s+public\.(clusters|cluster_articles|articles)\b/i);
  });

  it("qualifies every catalog call with pg_catalog", () => {
    const bare = [
      ...bodyBlank.matchAll(
        /(?<![\w.])(array_agg|cardinality|pg_advisory_xact_lock|hashtext|count|min|max|now|array_length|unnest)\s*\(/gi,
      ),
    ].map((m) => m[1]);
    expect(bare).toEqual([]);
    for (const fn of ["array_agg", "cardinality", "pg_advisory_xact_lock", "hashtext", "unnest"]) {
      expect(bodyBlank, fn).toContain(`pg_catalog.${fn}(`);
    }
  });

  it("every other schema-qualified object is in public, and nothing is left unqualified", () => {
    const rels = [...bodyBlank.matchAll(/\b(?:from|join)\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(rels.length).toBeGreaterThan(0);
    // pg_catalog.unnest is the set-returning function of the updated_at restore
    for (const r of rels) expect(r, `from/join ${r}`).toMatch(/^(public\.[a-z_]+|pg_catalog\.unnest)$/);
  });

  it("explains in comments why the source row is locked first and why the ids are sorted", () => {
    const bodyRaw = fnBody(block);
    expect(bodyRaw).toMatch(/key.?share|FOR UPDATE/);
    expect(bodyRaw).toMatch(/uuid order|sorted|order by/i);
  });
});

describe("128 relies on 064 as it is", () => {
  it("cluster_unlink_article keeps a cluster with no members and its first_published", () => {
    const unlink = norm(fnBlock(stripSqlComments(sql064), "cluster_unlink_article"));
    expect(unlink).toContain("first_published = coalesce(v_first_published, c.first_published)");
    expect(unlink).toContain("delete from public.cluster_articles ca where ca.cluster_id = p_cluster_id and ca.article_id = p_article_id;");
    // a null article id deletes nothing: the call is a pure recompute (099 and 121 use it the same way)
    expect(unlink).toContain("u.cluster_id = p_cluster_id and u.article_id = p_article_id and u.status = 'pending'");
    expect(unlink).toContain("perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtext(p_cluster_id::text));");
  });

  it("recomputes ten bias keys from the voting kinds", () => {
    const unlink = norm(fnBlock(stripSqlComments(sql064), "cluster_unlink_article"));
    expect(unlink).toContain("s.kind in ('outlet', 'wire')");
    for (const key of BIAS_KEYS) expect(unlink, key).toContain(`'${key}', pg_catalog.count(v.bias_key)`);
  });

  it("is granted to service_role only, so the SECURITY DEFINER body (owner postgres) is what calls it", () => {
    const grants = [...stripSqlComments(sql064).matchAll(/grant execute on function public\.cluster_unlink_article[^;]*;/gi)].map((m) =>
      norm(m[0]),
    );
    expect(grants).toEqual(["grant execute on function public.cluster_unlink_article(uuid, uuid) to service_role;"]);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway
// Postgres with 064 and then 128 applied and the articles / cluster_articles
// foreign keys set to ON DELETE CASCADE as in production. TAYF_PSQL is the psql
// binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Every fixture
// sits inside a transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("128 delete_source against fixtures (live Postgres)", () => {
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
  const uid = (ns: number, n: number) => `00000000-0000-4000-8128-${String(ns).padStart(2, "0")}${String(n).padStart(10, "0")}`;

  let fullSchema = false;
  let withHash = false;

  beforeAll(() => {
    fullSchema = columnExists("clusters", "summary_tr");
    withHash = columnExists("articles", "content_hash");
  });

  interface Src {
    n: number; // 0-based source index in the namespace
    bias: string;
    kind?: string;
  }
  interface Art {
    n: number; // 0-based article index in the namespace
    src: number; // source index
    at: string; // published_at
  }

  const srcId = (ns: number, n: number) => uid(ns, 100 + n);
  const artId = (ns: number, n: number) => uid(ns, 200 + n);
  const cluId = (ns: number, n: number) => uid(ns, n);

  function sourcesSql(ns: number, srcs: readonly Src[]): string {
    const vals = srcs.map(
      (s) =>
        `('${srcId(ns, s.n)}', 'fx128 ${ns}-${s.n}', 'fx128-${ns}-${s.n}', 'https://fx128-${ns}-${s.n}.invalid', 'https://fx128-${ns}-${s.n}.invalid/rss', '${s.bias}', '${s.kind ?? "outlet"}', true)`,
    );
    return `insert into public.sources (id, name, slug, url, rss_url, bias, kind, active) values\n  ${vals.join(",\n  ")};`;
  }

  function articlesSql(ns: number, arts: readonly Art[]): string {
    const vals = arts.map((a) => {
      const url = `'https://fx128.invalid/${ns}/${a.n}'`;
      return `('${artId(ns, a.n)}', '${srcId(ns, a.src)}', 'fx128 ${ns} ${a.n}', ${url}, '${a.at}'${withHash ? `, md5(${url})` : ""})`;
    });
    return `insert into public.articles (id, source_id, title, url, published_at${withHash ? ", content_hash" : ""}) values\n  ${vals.join(",\n  ")};`;
  }

  /** One cluster with a deliberately stale aggregate; `first` is its first_published. */
  function clusterSql(
    ns: number,
    n: number,
    first: string,
    dist = '{"center":7}',
    count = 9,
    updatedAt = "2000-01-01T00:00:00Z",
  ): string {
    const cols = fullSchema
      ? "id, title_tr, title_en, summary_tr, summary_en, first_published, updated_at, bias_distribution, article_count"
      : "id, title_tr, first_published, updated_at, bias_distribution, article_count";
    const vals = fullSchema
      ? `'${cluId(ns, n)}', 'fx128', 'fx128', 'fx128', 'fx128', '${first}', '${updatedAt}', '${dist}'::jsonb, ${count}`
      : `'${cluId(ns, n)}', 'fx128', '${first}', '${updatedAt}', '${dist}'::jsonb, ${count}`;
    return `insert into public.clusters (${cols}) values (${vals});`;
  }

  const linkSql = (ns: number, cluster: number, articles: readonly number[]) =>
    `insert into public.cluster_articles (cluster_id, article_id) values ${articles
      .map((a) => `('${cluId(ns, cluster)}', '${artId(ns, a)}')`)
      .join(", ")};`;

  const KEYS_SORTED = [...BIAS_KEYS].sort();
  const keyList = KEYS_SORTED.map((k) => `'${k}'`).join(", ");

  /** One tagged row with the aggregates of a cluster. */
  const probe = (tag: string, cluster: string) =>
    `select '${tag}', article_count, is_blindspot, coalesce(blindspot_side, 'null'), to_char(first_published at time zone 'UTC', 'YYYY-MM-DD HH24:MI'), (select string_agg(k || '=' || coalesce(bias_distribution ->> k, 'missing'), ',' order by k) from unnest(array[${keyList}]) as k), (select count(*) from jsonb_object_keys(bias_distribution)), to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS') from public.clusters where id = '${cluster}';`;

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

  it("the target database runs 128: the ledger row is there and the function is the recomputing one", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '128';").trim()).toBe("1");
    const src = runPsql(`select prosrc from pg_proc where oid = '${SIG}'::regprocedure;`);
    expect(src).toContain("cluster_unlink_article");
    expect(src).toContain("for update");
  });

  describe("(a) deleting S1 recomputes C1 and C2, leaves C3 alone", () => {
    // S1 pro_government (S1a, S1b, S1c), S2 opposition (S2a, S2b)
    // C1 = S1a, S1b, S2a   C2 = S1c   C3 = S2b
    const ns = 1;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      out = rows(
        runPsql(`
begin;
${sourcesSql(ns, [
  { n: 0, bias: "pro_government" },
  { n: 1, bias: "opposition" },
])}
${articlesSql(ns, [
  { n: 0, src: 0, at: "2026-10-01T08:00:00Z" },
  { n: 1, src: 0, at: "2026-10-01T09:00:00Z" },
  { n: 2, src: 1, at: "2026-10-01T10:00:00Z" },
  { n: 3, src: 0, at: "2026-10-02T08:00:00Z" },
  { n: 4, src: 1, at: "2026-10-03T08:00:00Z" },
])}
${clusterSql(ns, 0, "2026-10-01T08:00:00Z", '{"pro_government":2,"opposition":1}', 3)}
${clusterSql(ns, 1, "2026-09-15T00:00:00Z", '{"pro_government":1}', 1, "2001-02-03T04:05:06Z")}
${clusterSql(ns, 2, "2026-08-15T00:00:00Z", '{"opposition":1}', 1)}
${linkSql(ns, 0, [0, 1, 2])}
${linkSql(ns, 1, [3])}
${linkSql(ns, 2, [4])}
select 'del', public.delete_source('${srcId(ns, 0)}');
${probe("c1", cluId(ns, 0))}
${probe("c2", cluId(ns, 1))}
${probe("c3", cluId(ns, 2))}
select 'gone', (select count(*) from public.articles where source_id = '${srcId(ns, 0)}'), (select count(*) from public.sources where id = '${srcId(ns, 0)}'), (select count(*) from public.sources where id = '${srcId(ns, 1)}');
select 'rand', public.delete_source('00000000-0000-4000-8128-ffffffffffff') is null;
rollback;
`),
      );
    });

    it("returns the affected clusters in uuid order", () => {
      expect(out.get("del")).toEqual([`{${cluId(ns, 0)},${cluId(ns, 1)}}`]);
    });

    it("C1 keeps the other source's vote: count 1, opposition 1, ten keys, not a blindspot, first_published of S2a", () => {
      const c1 = out.get("c1") as string[];
      expect(c1[0]).toBe("1");
      expect(c1[1]).toBe("f");
      expect(c1[2]).toBe("null");
      expect(c1[3]).toBe("2026-10-01 10:00");
      expect(c1[4]).toBe(distOf({ opposition: 1 }));
      expect(c1[5]).toBe("10");
      // a source delete is not news: updated_at (which feeds the home feed order) is NOT re-stamped
      expect(c1[6]).toBe("2000-01-01 00:00:00");
    });

    it("C2 loses its only member: article_count 0, the row is kept, first_published unchanged, all zero", () => {
      const c2 = out.get("c2") as string[];
      expect(c2[0]).toBe("0");
      expect(c2[1]).toBe("f");
      expect(c2[3]).toBe("2026-09-15 00:00");
      expect(c2[4]).toBe(distOf({}));
      // each cluster gets its own old updated_at back (the snapshot arrays line up)
      expect(c2[6]).toBe("2001-02-03 04:05:06");
    });

    it("C3 is untouched: stale-looking aggregate, updated_at as before", () => {
      const c3 = out.get("c3") as string[];
      expect(c3[0]).toBe("1");
      expect(c3[3]).toBe("2026-08-15 00:00");
      expect(c3[6]).toBe("2000-01-01 00:00:00");
    });

    it("the source's articles and the source are gone, the other source stays", () => {
      expect(out.get("gone")).toEqual(["0", "0", "1"]);
    });

    it("an unknown source id returns NULL", () => {
      expect(out.get("rand")).toEqual(["t"]);
    });
  });

  describe("(b) a source in no cluster returns the empty array and is deleted", () => {
    const ns = 2;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      out = rows(
        runPsql(`
begin;
${sourcesSql(ns, [{ n: 0, bias: "center" }])}
${articlesSql(ns, [{ n: 0, src: 0, at: "2026-10-01T08:00:00Z" }])}
select 'del', public.delete_source('${srcId(ns, 0)}'), public.delete_source('${srcId(ns, 0)}') is null;
select 'left', (select count(*) from public.sources where id = '${srcId(ns, 0)}'), (select count(*) from public.articles where source_id = '${srcId(ns, 0)}');
rollback;
`),
      );
    });

    it("returns {} the first time and NULL the second", () => {
      expect(out.get("del")).toEqual(["{}", "t"]);
    });

    it("removed the source and its article", () => {
      expect(out.get("left")).toEqual(["0", "0"]);
    });
  });

  describe("(c) a blindspot that loses its fifth voting source stops being a blindspot", () => {
    const ns = 3;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      out = rows(
        runPsql(`
begin;
${sourcesSql(ns, [
  { n: 0, bias: "pro_government" },
  { n: 1, bias: "pro_government" },
  { n: 2, bias: "gov_leaning" },
  { n: 3, bias: "gov_leaning" },
  { n: 4, bias: "pro_government" },
])}
${articlesSql(
  ns,
  [0, 1, 2, 3, 4].map((i) => ({ n: i, src: i, at: `2026-10-0${i + 1}T08:00:00Z` })),
)}
${clusterSql(ns, 0, "2026-10-01T08:00:00Z")}
${linkSql(ns, 0, [0, 1, 2, 3, 4])}
select 'seed', public.cluster_unlink_article('${cluId(ns, 0)}', null);
${probe("before", cluId(ns, 0))}
select 'del', public.delete_source('${srcId(ns, 4)}');
${probe("after", cluId(ns, 0))}
rollback;
`),
      );
    });

    it("is a blindspot with five voting sources, pro_government side", () => {
      const before = out.get("before") as string[];
      expect(before[0]).toBe("5");
      expect(before[1]).toBe("t");
      expect(before[2]).toBe("pro_government");
    });

    it("drops to four voting sources: not a blindspot, no side, distribution recomputed", () => {
      expect(out.get("del")).toEqual([`{${cluId(ns, 0)}}`]);
      const after = out.get("after") as string[];
      expect(after[0]).toBe("4");
      expect(after[1]).toBe("f");
      expect(after[2]).toBe("null");
      expect(after[4]).toBe(distOf({ pro_government: 2, gov_leaning: 2 }));
    });
  });

  describe("(d) the 2000-cluster cap refuses the delete and changes nothing", () => {
    const ns = 4;
    let out: Map<string, string[]> = new Map();
    beforeAll(() => {
      const cols = fullSchema
        ? "id, title_tr, title_en, summary_tr, summary_en, first_published, updated_at, bias_distribution, article_count"
        : "id, title_tr, first_published, updated_at, bias_distribution, article_count";
      const sel = fullSchema
        ? "gen_random_uuid(), 'fx128cap', 'fx128cap', 'fx128cap', 'fx128cap', now(), now(), '{}'::jsonb, 1"
        : "gen_random_uuid(), 'fx128cap', now(), now(), '{}'::jsonb, 1";
      out = rows(
        runPsql(`
begin;
${sourcesSql(ns, [{ n: 0, bias: "center" }])}
insert into public.articles (id, source_id, title, url, published_at${withHash ? ", content_hash" : ""})
  select gen_random_uuid(), '${srcId(ns, 0)}', 'fx128cap ' || g, 'https://fx128.invalid/cap/' || g, now()${withHash ? ", md5('https://fx128.invalid/cap/' || g)" : ""}
    from generate_series(1, 2001) g;
insert into public.clusters (${cols}) select ${sel} from generate_series(1, 2001) g;
insert into public.cluster_articles (cluster_id, article_id)
  select c.id, a.id
    from (select id, row_number() over (order by id) rn from public.clusters where title_tr = 'fx128cap') c
    join (select id, row_number() over (order by id) rn from public.articles where title like 'fx128cap %') a using (rn);
do $cap$
begin
  begin
    perform public.delete_source('${srcId(ns, 0)}');
  exception when others then
    perform set_config('tayf.cap_state', sqlstate, true);
  end;
end
$cap$;
select 'cap', current_setting('tayf.cap_state', true), (select count(*) from public.sources where id = '${srcId(ns, 0)}'), (select count(*) from public.articles where source_id = '${srcId(ns, 0)}');
rollback;
`),
      );
    });

    it("raises 54000, deletes nothing", () => {
      expect(out.get("cap")).toEqual(["54000", "1", "2001"]);
    });
  });

  it("rolled the fixtures back", () => {
    expect(runPsql("select count(*) from public.sources where slug like 'fx128-%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.articles where url like 'https://fx128.invalid/%';").trim()).toBe("0");
    expect(runPsql("select count(*) from public.clusters where title_tr like 'fx128%';").trim()).toBe("0");
  });

  it("service_role only may execute; security definer; volatile; search_path is empty", () => {
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
