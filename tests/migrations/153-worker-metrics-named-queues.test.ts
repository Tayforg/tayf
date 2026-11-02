import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 153 ("worker_metrics_named_queues"),
// hunt-28 (h28-live-1).
//
// public.worker_metrics (024) read FROM pgmq.metrics_all() WHERE queue_name IN
// ('cluster_work', 'image_backfill'). metrics_all() is SECURITY INVOKER and loops
// over every row of pgmq.meta BEFORE the WHERE runs, so since 151 created the
// cluster_attach queue (deliberately ungranted to service_role) the view raised
// 42501 "permission denied for sequence q_cluster_attach_msg_id_seq" for the only
// role that reads it. /api/health caught that as checks.queues.ok = false and the
// whole verdict was "degraded" permanently: the queue depth / age probe was blind.
//
// 153 re-creates the view over pgmq.metrics('cluster_work') UNION ALL
// pgmq.metrics('image_backfill'): metrics(text) touches only the named queue, so a
// queue nobody granted can never break it. It grants NOTHING on pgmq (151's
// invariant "nothing granted on cluster_attach" holds) and keeps the view's ACL
// statements verbatim.
//
// This file pins: the ledger row, one transaction with a lock_timeout, the exact
// view text (no metrics_all, two metrics calls, six columns in order per branch, no
// WITH options), the comment, the revoke/grant text, that no GRANT mentions pgmq,
// the header sections, a cross-migration guard (every pgmq queue is either named in
// the view or explicitly excluded with a reason, and no later migration goes back to
// metrics_all) and, opt-in with TAYF_PSQL, the behaviour on a throwaway Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE = "153_worker_metrics_named_queues.sql";
const MIGRATION_153 = resolve(MIGRATIONS_DIR, FILE);
const DRYRUN = resolve(ROOT, "tests", "migrations", "sql", "153-worker-metrics-named-queues-dryrun.sql");

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/**
 * Contents of the adjacent string literals (Postgres concatenates them) that follow
 * `start`, up to the next `;` outside a literal. A character scan, not a regex, so a
 * long run of '' escapes cannot backtrack.
 */
function literalsAfter(sql: string, start: string): string {
  const at = sql.indexOf(start);
  if (at < 0) return "";
  let out = "";
  let inString = false;
  for (let i = at + start.length; i < sql.length; i++) {
    const ch = sql[i];
    if (inString) {
      if (ch !== "'") out += ch;
      else if (sql[i + 1] === "'") {
        out += "''";
        i++;
      } else inString = false;
    } else if (ch === "'") inString = true;
    else if (ch === ";") break;
  }
  return out;
}

const sql = readFileSync(MIGRATION_153, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);
/** Everything before the transaction: the header comment block. */
const header = sql.slice(0, sql.search(/^begin;/m));

/** True when a header line starts with `-- <label>` followed by a non-word character (a character scan, no dynamic RegExp). */
function hasSection(label: string): boolean {
  const prefix = `-- ${label}`;
  return header.split("\n").some((line) => line.startsWith(prefix) && !/\w/.test(line.charAt(prefix.length)));
}

const COLUMNS = "queue_name, queue_length, newest_msg_age_sec, oldest_msg_age_sec, total_messages, scrape_time";
const VIEW_STATEMENT =
  "create or replace view public.worker_metrics as " +
  `select ${COLUMNS} from pgmq.metrics('cluster_work') ` +
  "union all " +
  `select ${COLUMNS} from pgmq.metrics('image_backfill');`;

/** The create view statement, comment-free and whitespace-collapsed. */
function viewStatement(): string {
  const at = n.indexOf("create or replace view public.worker_metrics as");
  expect(at).toBeGreaterThan(-1);
  const end = n.indexOf(";", at);
  expect(end).toBeGreaterThan(at);
  return n.slice(at, end + 1);
}

describe("153 worker_metrics_named_queues: file, ledger and transaction", () => {
  it("is the only 153_ migration and has the agreed name", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("153_"));
    expect(files).toEqual([FILE]);
  });

  it("records version 153 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('153', '153_worker_metrics_named_queues') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row the last statement", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const tail = n.slice(n.indexOf("begin;"));
    expect(
      tail.endsWith(
        "insert into supabase_migrations.schema_migrations (version, name) values ('153', '153_worker_metrics_named_queues') on conflict do nothing; commit;",
      ),
    ).toBe(true);
  });

  it("sets a local lock_timeout of 5s right after begin (create or replace view locks the view)", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s';");
  });

  it("reloads the PostgREST schema cache before the ledger row", () => {
    expect(n).toContain("notify pgrst, 'reload schema'; insert into supabase_migrations.schema_migrations");
  });
});

describe("153 worker_metrics_named_queues: the view", () => {
  it("is exactly: create or replace view over pgmq.metrics('cluster_work') union all pgmq.metrics('image_backfill')", () => {
    expect(viewStatement()).toBe(VIEW_STATEMENT);
  });

  it("never calls pgmq.metrics_all (it touches every queue in pgmq.meta, granted or not)", () => {
    expect(code).not.toMatch(/metrics_all/i);
  });

  it("calls pgmq.metrics exactly twice, once per named queue, joined by one union all", () => {
    const stmt = viewStatement();
    const calls = [...stmt.matchAll(/pgmq\.metrics\('([a-z_]+)'\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["cluster_work", "image_backfill"]);
    expect([...stmt.matchAll(/pgmq\.metrics\(/g)]).toHaveLength(2);
    expect([...stmt.matchAll(/\bunion all\b/g)]).toHaveLength(1);
    expect(stmt).not.toMatch(/\bunion\b(?! all)/);
  });

  it("selects the six columns of 024's view, in 024's order, in each branch", () => {
    const body = viewStatement().slice("create or replace view public.worker_metrics as ".length, -1);
    const branches = body.split(" union all ");
    expect(branches).toHaveLength(2);
    for (const branch of branches) {
      expect(branch.startsWith(`select ${COLUMNS} from pgmq.metrics(`)).toBe(true);
    }
  });

  it("adds no WHERE, no WITH option and no security_invoker (024's view is a plain definer-style view)", () => {
    const stmt = viewStatement();
    expect(stmt).not.toMatch(/\bwhere\b/);
    expect(stmt).not.toMatch(/\bwith\s*\(/);
    expect(code).not.toMatch(/security_invoker|security_barrier|check option/i);
  });

  it("re-creates the view only: no table, function, trigger, index, queue or extension", () => {
    expect(code).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(table|function|trigger|unique|index|extension|policy|sequence|materialized)\b/i);
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?view\b/gi)]).toHaveLength(1);
    expect(code).not.toMatch(/pgmq\.(create|drop_queue|send|read|delete|archive|purge_queue)\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\bcron\./i);
  });

  it("has an updated comment: the two named queues, the reason, service_role only", () => {
    expect(n).toContain("comment on view public.worker_metrics is '");
    const doc = literalsAfter(code, "comment on view public.worker_metrics is");
    expect(doc).toContain("cluster_work");
    expect(doc).toContain("image_backfill");
    expect(doc).toContain("pgmq.metrics");
    expect(doc).toContain("cluster_attach");
    expect(doc).toContain("service_role");
    expect(doc).toContain("153");
    expect(doc).not.toContain("metrics_all()");
  });
});

describe("153 worker_metrics_named_queues: privileges", () => {
  it("re-asserts 024's revoke and grant on the view, in that order", () => {
    expect(n).toContain("revoke all on public.worker_metrics from public, anon, authenticated;");
    expect(n).toContain("grant select on public.worker_metrics to service_role;");
    expect(n.indexOf("revoke all on public.worker_metrics")).toBeLessThan(n.indexOf("grant select on public.worker_metrics"));
  });

  it("has exactly one GRANT, and it is select on the view to service_role", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant select on public.worker_metrics to service_role;"]);
  });

  it("grants nothing on any pgmq object (cluster_attach stays locked to service_role on purpose)", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      expect(m[0]).not.toMatch(/pgmq/i);
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    // The only revoke is the view's; nothing is revoked or granted on a pgmq schema object either.
    for (const m of code.matchAll(/\brevoke\b[^;]*;/gi)) {
      expect(m[0]).not.toMatch(/pgmq/i);
    }
  });

  it("the view is the only object whose privileges are touched", () => {
    for (const m of code.matchAll(/\b(?:grant|revoke)\b[^;]*;/gi)) {
      expect(m[0]).toContain("public.worker_metrics");
    }
  });
});

describe("153 worker_metrics_named_queues: header", () => {
  it.each([["WHY"], ["WHAT"], ["STEP 0"], ["DRY RUNS"], ["DEPLOY"], ["VERIFY"], ["ROLLBACK"]])("has a %s section", (label) => {
    expect(hasSection(label), `header section ${label}`).toBe(true);
  });

  it("states that cluster_attach stays ungranted on purpose, and why metrics_all failed", () => {
    expect(header).toContain("cluster_attach");
    expect(header).toMatch(/stays? (ungranted|locked)/i);
    expect(header).toContain("on purpose");
    expect(header).toContain("metrics_all");
    expect(header).toContain("42501");
    expect(header).toContain("q_cluster_attach_msg_id_seq");
  });

  it("records the production read (STEP 0): the viewdef md5, the pgmq version, the privileges, the ACL", () => {
    expect(header).toContain("0355d6fcc93744296eb7982e7889a184");
    expect(header).toContain("1.5.1");
    expect(header).toContain("pgmq.metrics(text)");
    expect(header).toContain("pgmq.format_table_name(text,text)");
    expect(header).toContain("arwdDxtm");
  });

  it("records both local dry runs, the regression before 153 and the 2 rows after", () => {
    expect(header).toContain("pg-bh-w3-a");
    expect(header).toContain("pg-bh-w3-b");
    expect(header).toContain("INSERT 0 1");
    expect(header).toContain("INSERT 0 0");
    expect(header).toContain("DRYRUN 153 OK");
  });

  it("gives the exact rollback and names its price (it brings /api/health back to degraded)", () => {
    expect(header).toContain("delete from supabase_migrations.schema_migrations where version = '153';");
    expect(header).toContain("from pgmq.metrics_all()");
    expect(header).toMatch(/degraded/);
  });

  it("is additive and says so", () => {
    expect(header).toMatch(/Additive/);
    expect(header).toMatch(/Safe to re-apply/);
  });
});

// ---------------------------------------------------------------------------
// Guard: the view never goes back to metrics_all, and a new pgmq queue is a decision.
//
// worker_metrics names its queues, so a queue created later is invisible to
// /api/health unless somebody adds it to the view. Every pgmq.create('<q>') in
// supabase/migrations must therefore be either named in 153's view or listed in
// EXCLUDED with the reason. An unclassified queue fails this test.
// ---------------------------------------------------------------------------
describe("pgmq queue guard (all migrations, static)", () => {
  // queue -> reason it is not in public.worker_metrics
  const EXCLUDED: Record<string, string> = {
    // 151: the attach-only probe queue. Deliberately NOT granted to service_role at the
    // table level (access only through 024/029's definer path), and covered by the
    // cluster-consumer's own accounting. Naming it in the view would need a grant on
    // pgmq.q_cluster_attach (and its sequence), which 151 forbids.
    cluster_attach: "151: ungranted on purpose; the consumer drains it only after cluster_work ran dry",
  };

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  function created(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const f of files) {
      const body = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
      for (const m of body.matchAll(/pgmq\.create\(\s*'([A-Za-z0-9_]+)'\s*\)/g)) {
        const queue = m[1] as string;
        out.set(queue, [...(out.get(queue) ?? []), f]);
      }
    }
    return out;
  }

  const viewQueues = [...viewStatement().matchAll(/pgmq\.metrics\('([a-z_]+)'\)/g)].map((m) => m[1]);

  it("every queue creation in the migrations is a string literal (the guard can see it)", () => {
    let all = 0;
    let literal = 0;
    for (const f of files) {
      const body = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
      all += [...body.matchAll(/pgmq\.create(?:_partitioned|_unlogged)?\s*\(/g)].length;
      literal += [...body.matchAll(/pgmq\.create\(\s*'[A-Za-z0-9_]+'\s*\)/g)].length;
    }
    expect(all).toBeGreaterThan(0);
    expect(literal).toBe(all);
  });

  it("every queue is named in the worker_metrics view or listed in EXCLUDED with a reason", () => {
    const unclassified = [...created().keys()].filter((q) => !viewQueues.includes(q) && !(q in EXCLUDED));
    expect(unclassified).toEqual([]);
  });

  it("the view names only queues that a migration creates (a typo would give an empty branch or an error)", () => {
    const known = [...created().keys()];
    for (const q of viewQueues) expect(known, `queue ${q}`).toContain(q);
  });

  it("EXCLUDED holds only real queues that are really absent from the view, each with a reason", () => {
    const known = [...created().keys()];
    for (const [q, reason] of Object.entries(EXCLUDED)) {
      expect(known, `excluded queue ${q}`).toContain(q);
      expect(viewQueues, `excluded queue ${q}`).not.toContain(q);
      expect(reason.length).toBeGreaterThan(10);
    }
  });

  it("the two queues of 024 are in the view, so /api/health keeps its probe", () => {
    expect(viewQueues).toEqual(["cluster_work", "image_backfill"]);
  });

  it("no migration from 153 on goes back to pgmq.metrics_all (executable text only)", () => {
    const later = files.filter((f) => Number(f.slice(0, 3)) >= 153);
    expect(later).toContain(FILE);
    for (const f of later) {
      const body = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
      expect(body, f).not.toMatch(/pgmq\.metrics_all/i);
    }
  });
});

describe("153 worker_metrics_named_queues: dry-run script", () => {
  const dry = readFileSync(DRYRUN, "utf8");

  it("loads 153 twice and shows the 42501 regression first", () => {
    const loads = [...dry.matchAll(/^\\ir [^\n]*153_worker_metrics_named_queues\.sql/gm)];
    expect(loads).toHaveLength(2);
    expect(dry).toContain("permission denied for sequence q_cluster_attach_msg_id_seq");
    expect(dry.indexOf("42501")).toBeLessThan(dry.indexOf("153_worker_metrics_named_queues.sql"));
  });

  it("ends with the pass marker and never touches production (no connection string, no key)", () => {
    expect(dry).toContain("DRYRUN 153 OK");
    expect(dry).not.toMatch(/supabase\.co|postgres:\/\/|eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("models 024/048's grants with nothing on cluster_attach", () => {
    expect(dry).toContain("cluster_attach");
    expect(dry).toMatch(/has_table_privilege\('service_role', 'pgmq\.q_cluster_attach'/);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at the THROWAWAY database the dry-run script leaves behind
// (tests/migrations/sql/stub.sql, the pgmq stub of the dry-run script, 024/048's grants,
// 153 applied). Every check that writes runs inside a transaction that is rolled
// back. Never point this at production.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("153 against a live Postgres (153 applied)", () => {
  assertLiveReady("153", { ledger: ["153"], relations: ["public.worker_metrics"] });

  const psqlArgs = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"];
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, psqlArgs, {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  function runPsqlError(input: string): string {
    try {
      execFileSync(process.env.TAYF_PSQL as string, psqlArgs, {
        input,
        encoding: "utf8",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      return String((e as { stderr?: string }).stderr ?? e);
    }
    throw new Error("expected psql to fail");
  }

  it("the ledger row is there once", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '153';").trim()).toBe("1");
  });

  it("the cluster_attach queue exists and service_role cannot read it (the precondition of the bug)", () => {
    expect(runPsql("select count(*) from pgmq.meta where queue_name = 'cluster_attach';").trim()).toBe("1");
    expect(runPsql("select has_table_privilege('service_role', 'pgmq.q_cluster_attach', 'select');").trim()).toBe("f");
    expect(runPsql("select has_sequence_privilege('service_role', 'pgmq.q_cluster_attach_msg_id_seq', 'select');").trim()).toBe("f");
  });

  it("as service_role, select count(*) from worker_metrics returns 2 and does not raise 42501", () => {
    expect(runPsql("begin; set local role service_role; select count(*) from public.worker_metrics; rollback;").trim()).toBe("2");
  });

  it("as service_role the view lists exactly the two named queues", () => {
    expect(
      runPsql(
        "begin; set local role service_role; select string_agg(queue_name, ',' order by queue_name) from public.worker_metrics; rollback;",
      ).trim(),
    ).toBe("cluster_work,image_backfill");
  });

  it("the old path still fails for service_role: pgmq.metrics_all() touches cluster_attach", () => {
    expect(runPsqlError("begin; set local role service_role; select count(*) from pgmq.metrics_all(); rollback;")).toMatch(
      /permission denied for (sequence|table) (q_cluster_attach|q_cluster_attach_msg_id_seq)/,
    );
  });

  it("service_role still cannot read the cluster_attach queue directly", () => {
    expect(runPsqlError("begin; set local role service_role; select count(*) from pgmq.q_cluster_attach; rollback;")).toMatch(
      /permission denied for table q_cluster_attach/,
    );
  });

  it("the view has the six columns of 024, in order, with 024's types, and no WITH options", () => {
    expect(
      runPsql(`select string_agg(column_name || ':' || data_type, ',' order by ordinal_position)
                 from information_schema.columns where table_schema = 'public' and table_name = 'worker_metrics';`).trim(),
    ).toBe(
      "queue_name:text,queue_length:bigint,newest_msg_age_sec:integer,oldest_msg_age_sec:integer,total_messages:bigint,scrape_time:timestamp with time zone",
    );
    expect(runPsql("select coalesce(reloptions::text, '') from pg_class where oid = 'public.worker_metrics'::regclass;").trim()).toBe("");
  });

  it("the stored definition reads pgmq.metrics(...) and no longer metrics_all", () => {
    const def = runPsql("select pg_get_viewdef('public.worker_metrics'::regclass);");
    expect(def).toContain("metrics('cluster_work'");
    expect(def).toContain("metrics('image_backfill'");
    expect(def).not.toContain("metrics_all");
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} has no privilege on the view and cannot read it`, () => {
      expect(
        runPsql(`select count(*) from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                  where has_table_privilege('${role}', 'public.worker_metrics', p);`).trim(),
      ).toBe("0");
      expect(runPsqlError(`begin; set local role ${role}; select count(*) from public.worker_metrics; rollback;`)).toMatch(
        /permission denied for (view|table) worker_metrics/,
      );
    });
  }

  it("nobody but the owner and service_role holds a privilege on the view, and PUBLIC holds none", () => {
    expect(
      runPsql(`select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = 'public.worker_metrics'::regclass and a.grantee = 0;`).trim(),
    ).toBe("0");
    expect(runPsql("select has_table_privilege('service_role', 'public.worker_metrics', 'select');").trim()).toBe("t");
  });

  it("153 granted nothing on the pgmq queue objects of cluster_attach to any client role", () => {
    for (const role of ["anon", "authenticated"]) {
      expect(
        runPsql(`select has_table_privilege('${role}', 'pgmq.q_cluster_attach', 'select') or has_table_privilege('${role}', 'pgmq.a_cluster_attach', 'select');`).trim(),
      ).toBe("f");
    }
  });
});
