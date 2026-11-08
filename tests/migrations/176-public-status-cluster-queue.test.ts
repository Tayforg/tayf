import { beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { FEED_YIELD_WINDOW_MS } from "@/lib/clusters/feed-health";
import {
  STATUS_CLUSTER_POISON_WINDOW_HOURS,
  STATUS_CLUSTER_QUEUE_DEPTH_WARN,
  STATUS_CLUSTER_QUEUE_FAIL_SEC,
  STATUS_CLUSTER_QUEUE_WARN_SEC,
  STATUS_LOOKBACK_HOURS,
} from "@/lib/status/verdict";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 176 ("public_status_cluster_queue"), h71-transparency-3.
//
// /durum's "Kümeleme" step (and /api/health's clustering check) measured the age of the newest clusters.updated_at.
// createCluster writes updated_at = the first article's published_at and a cluster is only touched when a clusterable
// (politika / son_dakika) article arrives, so a quiet night with nothing to cluster aged the value past 45 minutes and
// turned the whole public verdict amber (twice on 2026-11-08, 6 and 21 minutes). The metric could not tell an idle
// pipeline from a stuck consumer. 176 re-creates public.public_status_snapshot() with 110's body VERBATIM plus three
// numbers in the clustering object: queue_depth and queue_oldest_sec, read from pgmq.q_cluster_work with ops row 18's
// (migration 150) expressions, and queue_poison_recent, the messages archived as poison (read_ct > 3) from
// pgmq.a_cluster_work in the last hour (ops row 18's poison expression of migration 167, 1 h window). The consumer
// archives a message that keeps failing on its 4th read, so a consumer that fails every message leaves the queue short
// and never ages a visible message past 900 s; the poison count is what surfaces that outage. The page rule that uses
// the three numbers is pinned in src/lib/status/verdict.test.ts.
//
// This file pins: the statements (one transaction, lock_timeout, the one function, the privileges, the ledger row), that
// the new body is 110's body plus the queue read and nothing else (and that 110's body is what production runs), the
// queue read itself (guarded by to_regclass, ops 150's expressions, isolated so a failing read cannot flip clustering to
// "Bilinmiyor"), the payload keys, what the migration does NOT do, and the header (replay, dry run, deploy order,
// rollback that re-creates 110's body). Comments are stripped before every code assertion so prose can never satisfy a
// guard, except where the header is the subject.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS_DIR, "176_public_status_cluster_queue.sql");
const MIGRATION_110 = resolve(MIGRATIONS_DIR, "110_public_status.sql");
const MIGRATION_150 = resolve(MIGRATIONS_DIR, "150_ops_queue_and_cron_liveness.sql");
const MIGRATION_167 = resolve(MIGRATIONS_DIR, "167_ops_queue_poison_contract.sql");
const MIGRATION_173 = resolve(MIGRATIONS_DIR, "173_ops_sources_dark_persistent.sql");

/** md5(pg_get_functiondef('public.public_status_snapshot()'::regprocedure)) read from production on 2026-11-08. */
const PRODUCTION_MD5 = "2c8180061e9107f5e8d99c318418877a";

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** Ops row 18's poison expression (migration 167, still the one in 173) with the 1 h window 176 uses. */
const POISON_1H =
  "(select pg_catalog.count(*) from pgmq.a_cluster_work a where a.archived_at >= pg_catalog.now() - interval '1 hour' and a.read_ct > 3)";
const md5 = (s: string) => createHash("md5").update(s).digest("hex");

/** Everything from the first `begin;` line on: the executable part (the header comment may quote $fn$ blocks). */
function executablePart(raw: string): string {
  const at = raw.search(/^begin;/m);
  if (at < 0) throw new Error("begin; not found");
  return raw.slice(at);
}

/** The text between the first two $fn$ tags of `sql`. */
function dollarBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  if (open < 0 || close < 0) throw new Error("$fn$ block not found");
  return sql.slice(open + 4, close);
}

let raw = "";
let exec = "";
let code = "";
let fnHeader = "";
let fnBody = "";
let head = "";
let raw110 = "";
let body110 = "";

beforeAll(() => {
  expect(existsSync(MIGRATION), "176_public_status_cluster_queue.sql must exist").toBe(true);
  raw = readFileSync(MIGRATION, "utf8");
  exec = executablePart(raw);
  head = raw.slice(0, raw.search(/^begin;/m));
  code = stripComments(exec);
  const m = code.match(
    /create\s+or\s+replace\s+function\s+public\.public_status_snapshot\s*\(\s*\)[\s\S]*?\$fn\$[\s\S]*?\$fn\$\s*;/i,
  );
  if (!m) throw new Error("public_status_snapshot() block not found");
  fnHeader = m[0].slice(0, m[0].search(/\bas\s+\$fn\$/i));
  // the body is taken from the raw executable text, comments included, so it can be compared byte for byte
  fnBody = dollarBody(exec);
  raw110 = readFileSync(MIGRATION_110, "utf8");
  body110 = dollarBody(executablePart(raw110));
});

describe("176 structure", () => {
  it("is wrapped in exactly one begin/commit with lock_timeout first and the ledger insert last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const statements = code
      .split(";")
      .map((s) => collapse(s))
      .filter((s) => s.length > 0);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toBe("set local lock_timeout = '5s'");
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    expect(ledger).toBeLessThan(code.search(/^\s*commit\s*;/im));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
  });

  it("records itself as version '176' in the 095 pattern, once", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'176'\s*,\s*'176_public_status_cluster_queue'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(raw.length).toBeGreaterThan(code.length);
  });

  it("creates exactly one function and nothing else: no table, no alter, no drop, no cron, no schema-cache notice", () => {
    const creates = [...code.matchAll(/create\s+(?:or\s+replace\s+)?(\w+)\s+(?:function\s+)?(public\.\w+)/gi)].map(
      (m) => `${m[1]!.toLowerCase()} ${m[2]}`,
    );
    expect(creates).toEqual(["function public.public_status_snapshot"]);
    expect(code).not.toMatch(/\bcreate\s+(table|view|index|trigger|extension|schema)\b/i);
    expect(code).not.toMatch(/\balter\s+/i);
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\bcron\.(schedule|unschedule)\s*\(/i);
    // the RPC signature and its return type are unchanged, so PostgREST has nothing to reload
    expect(code).not.toMatch(/\bnotify\s+pgrst\b/i);
  });
});

describe("176 function header", () => {
  it("is 110's signature and attributes: returns jsonb, plpgsql, stable, security definer, search_path = ''", () => {
    expect(collapse(fnHeader)).toMatch(
      /^create or replace function public\.public_status_snapshot\(\) returns jsonb language plpgsql stable security definer set search_path = ''$/i,
    );
    const header110 = collapse(
      stripComments(executablePart(raw110)).match(
        /create\s+or\s+replace\s+function\s+public\.public_status_snapshot\s*\(\s*\)[\s\S]*?(?=\bas\s+\$fn\$)/i,
      )![0],
    );
    expect(collapse(fnHeader)).toBe(header110);
  });

  it("matches production's attributes read on 2026-11-08 (security definer, stable, empty search_path)", () => {
    expect(head).toMatch(/prosecdef = true/);
    expect(head).toMatch(/provolatile = 's'/);
    expect(head).toMatch(/search_path=""/);
  });
});

describe("176 grants", () => {
  it("revokes from public, anon and authenticated, and grants execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.public_status_snapshot\(\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.public_status_snapshot\(\)\s+to\s+service_role\s*;/i,
    );
    const grants = [...code.matchAll(/(^|;)\s*grant\b[^;]*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]![0]).not.toMatch(/\bto\b[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("grants nothing on any table or sequence", () => {
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(table|sequence|schema)\b/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\b(insert|update|delete|truncate|maintain|select|usage)\b/i);
  });

  it("writes nothing: the only insert is the ledger row; no update/delete/truncate anywhere", () => {
    const inserts = [...code.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect(code).not.toMatch(/\bupdate\s+[\w.]+\s+set\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(stripComments(fnBody)).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });

  it("the function comment still says safe aggregates only and now names 176", () => {
    expect(code).toMatch(
      /comment\s+on\s+function\s+public\.public_status_snapshot\(\)\s+is\s+'[^']*safe aggregates only[^']*'/i,
    );
    expect(code).toMatch(/comment\s+on\s+function[^;]*\b176\b[^;]*;/i);
  });
});

describe("176 body is 110's body plus the queue read", () => {
  it("110's body is exactly what production runs (md5 of its pg_get_functiondef, read read-only on 2026-11-08)", () => {
    const def =
      "CREATE OR REPLACE FUNCTION public.public_status_snapshot()\n RETURNS jsonb\n LANGUAGE plpgsql\n STABLE SECURITY DEFINER\n SET search_path TO ''\nAS $function$" +
      body110 +
      "$function$\n";
    expect(md5(def)).toBe(PRODUCTION_MD5);
    expect(head).toContain(PRODUCTION_MD5);
  });

  it("every line of 110's body survives in order and verbatim, except the one clustering line of the return", () => {
    const lines110 = body110.split("\n");
    const lines176 = fnBody.split("\n");
    const changed = lines110.filter((l) => l.includes("'clustering', pg_catalog.jsonb_build_object("));
    expect(changed).toHaveLength(1);
    let at = 0;
    const missing: string[] = [];
    for (const line of lines110) {
      if (line === changed[0]) continue;
      const found = lines176.indexOf(line, at);
      if (found < 0) missing.push(line);
      else at = found + 1;
    }
    expect(missing).toEqual([]);
  });

  it("the changed return line keeps 110's keys in front and adds only the three queue keys", () => {
    const old = body110.split("\n").find((l) => l.includes("'clustering', pg_catalog.jsonb_build_object("))!;
    const prefix = old.slice(0, old.lastIndexOf(")"));
    expect(prefix).toBe("    'clustering', pg_catalog.jsonb_build_object('ok', v_cluster_ok, 'last_at', v_cluster");
    expect(collapse(fnBody)).toContain(
      collapse(
        prefix + ", 'queue_depth', v_qdepth, 'queue_oldest_sec', v_qoldest, 'queue_poison_recent', v_qpoison),",
      ),
    );
  });

  it("adds at most 20 lines to 110's body, all of them about the queue", () => {
    const lines110 = new Set(body110.split("\n"));
    const added = fnBody.split("\n").filter((l) => !lines110.has(l));
    expect(added.length).toBeGreaterThan(0);
    expect(added.length).toBeLessThanOrEqual(20);
    // the declaration, the guarded read, its isolation, and the return line
    expect(added.join("\n")).toMatch(/v_qdepth\s+bigint/);
    expect(added.join("\n")).toMatch(/v_qoldest\s+numeric/);
    expect(added.join("\n")).toMatch(/v_qpoison\s+bigint/);
    expect(added.join("\n")).toMatch(/pgmq\.q_cluster_work/);
    expect(added.join("\n")).toMatch(/pgmq\.a_cluster_work/);
    expect(added.join("\n")).toMatch(/queue_poison_recent/);
    expect(added.join("\n")).toMatch(/queue_depth/);
    expect(added.join("\n")).toMatch(/queue_oldest_sec/);
  });
});

describe("176 the queue read", () => {
  const body = () => stripComments(fnBody);
  const dynamic = () => [...body().matchAll(/execute\s+\$q\$([\s\S]*?)\$q\$/gi)].map((m) => collapse(m[1]!));
  /** The queue read and the cron flag, told apart by content (the clustering block comes before the labelling block). */
  const queueQuery = () => dynamic().find((q) => q.includes("pgmq.q_cluster_work"))!;
  const cronQuery = () => dynamic().find((q) => q.includes("cron.job"))!;

  it("runs only when pgmq.q_cluster_work AND pgmq.a_cluster_work exist, otherwise all three numbers stay null", () => {
    expect(body()).toMatch(
      /if\s+pg_catalog\.to_regclass\('pgmq\.q_cluster_work'\)\s+is\s+not\s+null\s+and\s+pg_catalog\.to_regclass\('pgmq\.a_cluster_work'\)\s+is\s+not\s+null\s+then/i,
    );
    // no assignment of a default value anywhere: the variables are declared without one
    expect(body()).toMatch(/v_qdepth\s+bigint\s*;/i);
    expect(body()).toMatch(/v_qoldest\s+numeric\s*;/i);
    expect(body()).toMatch(/v_qpoison\s+bigint\s*;/i);
    expect(body()).not.toMatch(/v_qdepth\s+bigint\s*:=/i);
    expect(body()).not.toMatch(/v_qoldest\s+numeric\s*:=/i);
    expect(body()).not.toMatch(/v_qpoison\s+bigint\s*:=/i);
  });

  it("the only dynamic SQL is the cron.job flag of 110 and the queue read, into v_qdepth, v_qoldest and v_qpoison", () => {
    expect(dynamic()).toHaveLength(2);
    expect(cronQuery()).toBe(
      "select coalesce(pg_catalog.bool_and(not j.active), false) from cron.job j where j.jobname = 'jev-shadow'",
    );
    expect(queueQuery()).toContain("pgmq.q_cluster_work");
    expect(queueQuery()).not.toContain("cron.job");
    expect(body()).toMatch(/\$q\$\s*into\s+v_qdepth\s*,\s*v_qoldest\s*,\s*v_qpoison\s*;/i);
    expect(body()).toMatch(/\$q\$\s*into\s+v_paused\s*;/i);
  });

  it("uses ops row 18's cluster_work expressions (migration 150): depth = count(*), wait = oldest VISIBLE message", () => {
    const ops = collapse(stripComments(readFileSync(MIGRATION_150, "utf8")));
    const depth = "(select pg_catalog.count(*) from pgmq.q_cluster_work)";
    const oldest =
      "(select coalesce(extract(epoch from pg_catalog.now() - pg_catalog.min(m.enqueued_at)), 0) from pgmq.q_cluster_work m where m.vt <= pg_catalog.now())";
    expect(ops).toContain(depth);
    expect(ops).toContain(oldest);
    const q = queueQuery();
    expect(q).toContain(depth);
    expect(q).toContain(oldest);
    // and nothing else: one row, those two scalars and the poison count of the next test
    expect(q).toBe(`select ${depth}, ${oldest}, ${POISON_1H}`);
  });

  it("the poison count is ops row 18's expression with a 1 h window: pgmq.a_cluster_work, archived_at in the last hour, read_ct > 3 (not >= 3)", () => {
    const q = queueQuery();
    expect(q).toContain(POISON_1H);
    expect(q).toMatch(/from pgmq\.a_cluster_work a where a\.archived_at >= pg_catalog\.now\(\) - interval '1 hour' and a\.read_ct > 3\)/);
    expect(q).not.toMatch(/read_ct\s*>=/);
    expect(q).not.toMatch(/read_ct\s*>\s*[0-24-9]/);
    // it is ops row 18's expression (167 introduced it, 173 is the newest definition) apart from the window: 24 h there
    const poison24 = POISON_1H.replace("interval '1 hour'", "interval '24 hours'");
    for (const file of [MIGRATION_167, MIGRATION_173]) {
      expect(collapse(stripComments(readFileSync(file, "utf8"))), file).toContain(poison24);
    }
    // MAX_READS = 3 in cluster-consumer: a message archived with read_ct > 3 failed its 4th read
    const consumer = readFileSync(
      resolve(__dirname, "..", "..", "supabase", "functions", "cluster-consumer", "index.ts"),
      "utf8",
    );
    expect(consumer).toMatch(/const MAX_READS = 3\b/);
    expect(consumer).toMatch(/msg\.read_ct > MAX_READS\)\s*\{\s*try\s*\{[^}]*archive\(supabase, QUEUE_NAME/);
  });

  it("the window is STATUS_CLUSTER_POISON_WINDOW_HOURS (1) hour", () => {
    expect(STATUS_CLUSTER_POISON_WINDOW_HOURS).toBe(1);
    expect(queueQuery()).toContain(`interval '${STATUS_CLUSTER_POISON_WINDOW_HOURS} hour'`);
  });

  it("is isolated in its own exception block: a failing queue read leaves clustering ok and falls back to nulls", () => {
    const handlers = [...body().matchAll(/exception\s+when\s+others\s+then(?:[^;]*;)+?\s*end\s*;/gi)].map((m) =>
      collapse(m[0]),
    );
    expect(
      handlers.some(
        (h) => h === "exception when others then v_qdepth := null; v_qoldest := null; v_qpoison := null; end;",
      ),
    ).toBe(true);
    // 110's clustering handler is untouched: it still resets only the cluster values
    expect(body()).toContain("exception when others then v_cluster := null; v_cluster_ok := false; end;");
    // four sections of 110 plus the one nested block
    expect([...body().matchAll(/exception\s+when\s+others\s+then/gi)]).toHaveLength(5);
  });

  it("the nested queue block sits inside the clustering block, after the max(updated_at) read", () => {
    const b = collapse(body());
    const clusterRead = b.indexOf("select pg_catalog.max(c.updated_at) into v_cluster");
    const guard = b.indexOf("pg_catalog.to_regclass('pgmq.q_cluster_work')");
    const outer = b.indexOf("exception when others then v_cluster := null; v_cluster_ok := false; end;");
    const labelling = b.indexOf("select pg_catalog.max(r.finished_at) into v_label");
    expect(clusterRead).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(clusterRead);
    expect(outer).toBeGreaterThan(guard);
    expect(labelling).toBeGreaterThan(outer);
  });

  it("selects no message body, id or header: aggregates over enqueued_at and vt, and a count filtered on archived_at and read_ct", () => {
    const q = queueQuery();
    for (const col of ["message", "msg_id", "headers"]) {
      expect(q, col).not.toMatch(new RegExp(`\\b${col}\\b`, "i"));
    }
    expect(q).toMatch(/\bm\.enqueued_at\b/);
    expect(q).toMatch(/\bm\.vt\b/);
    // read_ct appears once, in the poison predicate, and is never selected
    expect([...q.matchAll(/\bread_ct\b/g)]).toHaveLength(1);
    expect(q).toMatch(/\ba\.archived_at\b/);
    // the one archive table read is a_cluster_work; no other queue, archive or pgmq function
    expect(body()).not.toMatch(/pgmq\.(a_(?!cluster_work\b)|q_image|q_cluster_attach|metrics|read|send|archive|delete)/i);
  });
});

describe("176 payload shape", () => {
  const ret = () => {
    const start = fnBody.search(/return\s+pg_catalog\.jsonb_build_object\s*\(/i);
    expect(start).toBeGreaterThan(-1);
    return fnBody.slice(start);
  };
  const keysOf = (sql: string) => new Set([...sql.matchAll(/'([a-z_]+)'\s*,/gi)].map((m) => m[1]));

  it("keeps every key of 110 and adds exactly queue_depth, queue_oldest_sec and queue_poison_recent", () => {
    const start110 = body110.search(/return\s+pg_catalog\.jsonb_build_object\s*\(/i);
    const keys110 = keysOf(body110.slice(start110));
    const keys176 = keysOf(ret());
    for (const k of keys110) expect(keys176.has(k), k).toBe(true);
    expect(new Set([...keys176].filter((k) => !keys110.has(k)))).toEqual(
      new Set(["queue_depth", "queue_oldest_sec", "queue_poison_recent"]),
    );
  });

  it("the clustering object is ok, last_at, queue_depth, queue_oldest_sec, queue_poison_recent", () => {
    const m = /'clustering',\s*pg_catalog\.jsonb_build_object\(([^)]*)\)/i.exec(collapse(ret()));
    expect(m).not.toBeNull();
    const parts = m![1]!.split(",").map((p) => p.trim());
    expect(parts).toEqual([
      "'ok'",
      "v_cluster_ok",
      "'last_at'",
      "v_cluster",
      "'queue_depth'",
      "v_qdepth",
      "'queue_oldest_sec'",
      "v_qoldest",
      "'queue_poison_recent'",
      "v_qpoison",
    ]);
  });

  it("returns no queue name, message id or payload", () => {
    for (const k of ["queue_name", "msg_id", "message", "payload", "headers", "read_ct"]) {
      expect(keysOf(ret()).has(k), k).toBe(false);
    }
  });
});

describe("176 leak guards (110's guards carry over)", () => {
  it("the RAW file (comments included) carries no zone vocabulary", () => {
    expect(raw).not.toMatch(/iktidar|bagimsiz|muhalefet/i);
  });

  it("has no sqlerrm: no error text can reach the payload", () => {
    expect(code).not.toMatch(/sqlerrm/i);
    expect(code).not.toMatch(/sqlstate/i);
    expect(code).not.toMatch(/get\s+stacked\s+diagnostics/i);
  });

  it("jobname appears only as the equality predicate on the jev-shadow job", () => {
    const uses = [...stripComments(fnBody).matchAll(/\bjobname\b/gi)];
    expect(uses).toHaveLength(1);
    expect(fnBody).toMatch(/where\s+j\.jobname\s*=\s*'jev-shadow'/i);
  });

  it("never selects urls, content or error text, and never reads net._http_response or job_run_details", () => {
    for (const col of ["command", "url", "content", "error_msg", "return_message", "database", "username"]) {
      expect(stripComments(fnBody), col).not.toMatch(new RegExp(`\\b${col}\\b`, "i"));
    }
    expect(stripComments(fnBody)).not.toMatch(/\bnet\.|_http_response|job_run_details/i);
  });

  it("every built-in call is schema-qualified (search_path is empty) and every relation is schema-qualified", () => {
    const body = stripComments(fnBody);
    const unqualified = [
      ...body.matchAll(/(?<![\w.])(now|max|min|count|jsonb_build_object|jsonb_object_agg|bool_and|to_regclass)\s*\(/gi),
    ].map((m) => m[1]);
    expect(unqualified).toEqual([]);
    const relations = [...body.matchAll(/\b(?:from|join)\s+([\w.]+)/gi)]
      .map((m) => m[1]!)
      // `extract(epoch from pg_catalog.now() - ...)` is syntax, not a relation
      .filter((r) => !r.startsWith("pg_catalog."));
    expect(relations.length).toBeGreaterThan(0);
    for (const rel of relations) expect(rel, rel).toMatch(/^(public|cron|pgmq)\./);
  });
});

describe("176 parity with the TypeScript constants", () => {
  it("the windows are still the 6 h lookback and the 72 h yield window, and nothing new", () => {
    const hours = [...stripComments(fnBody).matchAll(/interval\s+'(\d+)\s+hours'/gi)].map((m) => Number(m[1]));
    expect([...new Set(hours)].sort((a, b) => a - b)).toEqual([STATUS_LOOKBACK_HOURS, FEED_YIELD_WINDOW_MS / 3.6e6]);
  });

  it("the header states the queue thresholds that verdict.ts uses (ops row 18: 300 s warn, 900 s fail)", () => {
    const warn = /STATUS_CLUSTER_QUEUE_WARN_SEC\s*=\s*(\d+)/.exec(head);
    const fail = /STATUS_CLUSTER_QUEUE_FAIL_SEC\s*=\s*(\d+)/.exec(head);
    expect(Number(warn?.[1])).toBe(STATUS_CLUSTER_QUEUE_WARN_SEC);
    expect(Number(fail?.[1])).toBe(STATUS_CLUSTER_QUEUE_FAIL_SEC);
    // and they are 150's row 18 numbers
    const ops = collapse(stripComments(readFileSync(MIGRATION_150, "utf8")));
    expect(ops).toContain(`qc_oldest > ${STATUS_CLUSTER_QUEUE_FAIL_SEC}`);
    expect(ops).toContain(`qc_oldest > ${STATUS_CLUSTER_QUEUE_WARN_SEC}`);
  });

  it("the header states the depth line and the poison rule that verdict.ts uses (ops row 18: depth > 300, poison >= 1)", () => {
    const depth = /STATUS_CLUSTER_QUEUE_DEPTH_WARN\s*=\s*(\d+)/.exec(head);
    expect(Number(depth?.[1])).toBe(STATUS_CLUSTER_QUEUE_DEPTH_WARN);
    const ops = collapse(stripComments(readFileSync(MIGRATION_173, "utf8")));
    expect(ops).toContain(`qc_depth > ${STATUS_CLUSTER_QUEUE_DEPTH_WARN}`);
    expect(ops).toContain("q_poison >= 1");
    expect(head).toMatch(/queue_poison_recent\s*>=\s*1/);
  });
});

describe("176 header documentation", () => {
  it("documents why, what changes, step 0, replay, dry run, deploy order, verify and rollback", () => {
    for (const section of ["WHY", "WHAT CHANGES", "STEP 0", "REPLAY", "DRY RUN (local PG15", "DEPLOY", "VERIFY", "ROLLBACK"]) {
      expect(head, section).toContain(section);
    }
    expect(head).toMatch(/safe to re-apply/i);
    expect(head).toMatch(/service_role/);
  });

  it("documents the poison count: what it reads, the 4th-read archive that hides a failing consumer, and the corrected KNOWN LIMITS", () => {
    expect(head).toMatch(/queue_poison_recent/);
    expect(head).toMatch(/pgmq\.a_cluster_work/);
    expect(head).toMatch(/archived_at_idx_cluster_work/);
    expect(head).toMatch(/read_ct > 3/);
    expect(head).toMatch(/MAX_READS = 3/);
    expect(head).toMatch(/4th read/);
    const limits = head.slice(head.indexOf("KNOWN LIMITS"), head.indexOf("ROLLBACK"));
    expect(limits).toMatch(/archived on the 4th read/);
    expect(limits).toMatch(/never age past (the )?900 s/);
    expect(limits).toMatch(/queue_poison_recent/);
    // the old claim that a failing consumer re-exposes its messages "and they then age" is gone
    expect(limits).not.toMatch(/and they then age/);
  });

  it("lists the third key in WHAT CHANGES, DRY RUN and VERIFY", () => {
    const section = (from: string, to: string) => head.slice(head.indexOf(from), head.indexOf(to));
    expect(section("WHAT CHANGES", "HOW THE PAGE USES IT")).toMatch(/v_qpoison/);
    expect(section("WHAT CHANGES", "HOW THE PAGE USES IT")).toMatch(/queue_poison_recent/);
    expect(section("DRY RUN (local PG15", "DEPLOY:")).toMatch(/queue_poison_recent/);
    expect(section("VERIFY (read-only", "OUT OF SCOPE")).toMatch(/queue_poison_recent/);
  });

  it("states the deploy order: apply 176 first, then deploy the app (the old app drops the new keys, the new app falls back without them)", () => {
    expect(head).toMatch(/APPLY 176 FIRST, THEN DEPLOY THE APP/);
    expect(head).toMatch(/45\/90/);
  });

  it("records the production reading: the md5, that the body equals 110's, and the pgmq columns used", () => {
    expect(head).toMatch(/2026-11-08/);
    expect(head).toContain(PRODUCTION_MD5);
    expect(head).toMatch(/identical to 110/i);
    expect(head).toMatch(/enqueued_at/);
    expect(head).toMatch(/\bvt\b/);
  });

  it("records the replay evidence: the two gaps of 2026-11-08 and the empty-window finding", () => {
    expect(head).toMatch(/01:27:04/);
    expect(head).toMatch(/02:33:04/);
    expect(head).toMatch(/23:54:04/);
    expect(head).toMatch(/00:45:07/);
    expect(head).toMatch(/politika/);
    expect(head).toMatch(/son_dakika/);
  });

  it("notes createCluster's updated_at = published_at as a separate, untouched observation", () => {
    expect(head).toMatch(/createCluster/);
    expect(head).toMatch(/published_at/);
    expect(head).toMatch(/OUT OF SCOPE/);
  });

  it("the rollback comment re-creates 110's function with its body verbatim, then deletes ledger row 176", () => {
    const at = head.indexOf("ROLLBACK");
    expect(at).toBeGreaterThan(-1);
    const prefix = "--     ";
    const commented = head
      .slice(at)
      .split("\n")
      .filter((l) => l.startsWith(prefix))
      .map((l) => l.slice(prefix.length));
    const sql = commented.join("\n");
    expect(sql).toContain("create or replace function public.public_status_snapshot()");
    expect(sql).toContain("as $fn$" + body110 + "$fn$;");
    expect(sql).toMatch(/delete from supabase_migrations\.schema_migrations where version = '176'/);
    // run as written it must not mention the queue: it restores 110, not 176
    expect(sql).not.toMatch(/queue_depth|queue_oldest_sec|q_cluster_work/);
  });
});
