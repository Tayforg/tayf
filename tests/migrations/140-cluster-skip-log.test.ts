import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 140 ("cluster_skip_log"), h14-cluster-1.
//
// #152 made the cluster consumer skip an article that matched a cluster already
// holding its source. A skip was persisted nowhere (no cluster_articles row, the
// article row untouched, the enqueue trigger fires on INSERT only), and two of the
// first three skips were wrong (two cumhuriyet film articles matched a different
// film's cluster through a description template). 140 adds the audit trail the
// consumer writes best-effort for every live skip: public.cluster_skip_log.
//
// This file pins: the ledger row, one transaction with a lock_timeout, the exact
// column list, the foreign key on article_id (on delete cascade) and the absence
// of one on cluster_id, RLS on with no policy, the three privilege statements
// (revoke from anon/authenticated/public, revoke from service_role, grant select +
// insert to service_role and nothing else), 131's PG17-guarded MAINTAIN revoke,
// the created_at index and the schema reload. The last block (opt-in, TAYF_PSQL)
// repeats the privilege checks of the dry run on a throwaway Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_140 = resolve(MIGRATIONS_DIR, "140_cluster_skip_log.sql");
const MIGRATION_136 = resolve(MIGRATIONS_DIR, "136_ops_heartbeat_app_side.sql");

const TABLE = "public.cluster_skip_log";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

const sql = readFileSync(MIGRATION_140, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);

describe("140 cluster_skip_log: ledger and transaction", () => {
  it("records version 140 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('140', '140_cluster_skip_log') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const body = n.slice(n.indexOf("begin;"));
    expect(body.endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("sets a local lock_timeout right after begin (the foreign key takes a brief lock on articles)", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s'; create table if not exists");
  });

  it("reloads the PostgREST schema cache", () => {
    expect(n).toContain("notify pgrst, 'reload schema';");
  });
});

describe("140 cluster_skip_log: table shape", () => {
  it("creates the table with exactly the specified columns, in order", () => {
    expect(n).toContain(
      "create table if not exists public.cluster_skip_log ( " +
        "article_id uuid primary key references public.articles(id) on delete cascade, " +
        "cluster_id uuid not null, " +
        "score real, " +
        "reason text not null, " +
        "created_at timestamptz not null default now() " +
        ");",
    );
  });

  it("has a foreign key on article_id (on delete cascade) and none on cluster_id (a merged-away cluster must not drop the audit row)", () => {
    const create = /create table if not exists public\.cluster_skip_log \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? "";
    expect(create).not.toBe("");
    const refs = [...create.matchAll(/\breferences\b/gi)];
    expect(refs).toHaveLength(1);
    expect(create).toMatch(/article_id uuid primary key references public\.articles\(id\) on delete cascade/);
    expect(create).toMatch(/cluster_id uuid not null,/);
    expect(create).not.toMatch(/cluster_id[^,\n]*references/i);
    // and no later ALTER adds one
    expect(code).not.toMatch(/\balter\s+table\b[^;]*\badd\s+(constraint|foreign)/i);
  });

  it("indexes created_at with a plain create index (a new tiny table: no PRE-BUILD step)", () => {
    expect(n).toContain("create index if not exists cluster_skip_log_created_at_idx on public.cluster_skip_log (created_at);");
    expect(code).not.toMatch(/\bconcurrently\b/i);
  });

  it("documents the table", () => {
    expect(n).toMatch(/comment on table public\.cluster_skip_log is '/);
    expect(n).toContain("migration 140");
  });
});

describe("140 cluster_skip_log: row level security and privileges", () => {
  it("enables row level security and has no policy", () => {
    expect(n).toContain("alter table public.cluster_skip_log enable row level security;");
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    expect(code).not.toMatch(/\bforce\s+row\s+level\b/i);
  });

  it("revokes every privilege from anon, authenticated and public, and the default grants from service_role", () => {
    expect(n).toContain("revoke all on public.cluster_skip_log from anon, authenticated, public;");
    expect(n).toContain("revoke all on public.cluster_skip_log from service_role;");
  });

  it("grants select and insert to service_role, and that is the only grant in the file", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant select, insert on public.cluster_skip_log to service_role;"]);
  });

  it("never mentions a write privilege for anon, authenticated or public, and adds no default privileges", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      // the grantee list is what follows `to` (the table name itself is in schema public)
      const grantees = /\bto\s+([^;]*);/i.exec(m[0])?.[1] ?? "";
      expect(grantees.trim()).toBe("service_role");
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    // the sequence grants of earlier migrations have no counterpart: the key is a uuid, there is no sequence
    expect(code).not.toMatch(/\bsequence\b/i);
  });

  it("carries the PG17-guarded MAINTAIN revoke, equal to 136's block modulo the table name", () => {
    expect(n).toMatch(/do \$maint\$ begin if current_setting\('server_version_num'\)::int >= 170000 then/);
    expect(n).toContain("execute 'revoke maintain on public.cluster_skip_log from anon, authenticated';");
    const b136 = norm(readFileSync(MIGRATION_136, "utf8"));
    const blockOf = (s: string) => /do \$maint\$[\s\S]*?\$maint\$;/.exec(s)?.[0] ?? "";
    expect(blockOf(n).replace("cluster_skip_log", "ops_cron_route_runs")).toBe(blockOf(b136));
  });
});

describe("140 cluster_skip_log: additive shape", () => {
  it("creates one table and one index, and no function, cron job, trigger or view", () => {
    expect([...code.matchAll(/\bcreate\s+table\b/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcreate\s+(unique\s+)?index\b/gi)]).toHaveLength(1);
    expect(code).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(function|trigger|view|materialized|extension)\b/i);
    expect(code).not.toMatch(/\bcron\./i);
  });

  it("changes no existing object and rewrites no data", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|index|function|column|constraint|policy|trigger)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/^\s*update\b/im);
    // the only ALTER is the RLS switch of the new table
    const alters = [...code.matchAll(/\balter\s+\w+[^;]*;/gi)].map((m) => norm(m[0]));
    expect(alters).toEqual(["alter table public.cluster_skip_log enable row level security;"]);
    // the only insert is the ledger row
    const inserts = [...code.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at a THROWAWAY database with the shared stub schema
// (jevtest/qa/stub.sql: the three roles, public.articles, supabase_migrations),
// service_role created with BYPASSRLS as Supabase has it, and 140 applied. Every
// check runs inside a transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("140 against a live Postgres (140 applied)", () => {
  const A1 = "aaaaaaaa-0000-0000-0000-00000000a001";
  const A2 = "aaaaaaaa-0000-0000-0000-00000000a002";
  const CLUSTER = "cccccccc-0000-0000-0000-00000000c001";
  const NO_CLUSTER = "cccccccc-0000-0000-0000-00000000c0ff";

  function psqlArgs(): string[] {
    return ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"];
  }
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, psqlArgs(), {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  /** The stderr of a script that must fail. */
  function runPsqlError(input: string): string {
    try {
      execFileSync(process.env.TAYF_PSQL as string, psqlArgs(), {
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
  const withArticles = (body: string) => `
begin;
insert into public.articles (id, title) values ('${A1}', 'skip log one'), ('${A2}', 'skip log two');
${body}
rollback;
`;

  it("the ledger row, the table and its foreign key are there", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '140';").trim()).toBe("1");
    expect(runPsql(`select to_regclass('${TABLE}') is not null;`).trim()).toBe("t");
    // one foreign key (article_id -> articles, on delete cascade), nothing on cluster_id
    expect(
      runPsql(`select a.attname, c.confrelid::regclass::text, c.confdeltype
                 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                where c.conrelid = '${TABLE}'::regclass and c.contype = 'f' order by 1;`).trim(),
    ).toBe("article_id|articles|c");
  });

  it("has exactly the specified columns", () => {
    expect(
      runPsql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
                 from information_schema.columns where table_schema = 'public' and table_name = 'cluster_skip_log';`).trim(),
    ).toBe(
      "article_id:uuid:NO,cluster_id:uuid:NO,score:real:YES,reason:text:NO,created_at:timestamp with time zone:NO",
    );
  });

  it("RLS is on, there is no policy, and the table privileges are service_role select + insert only", () => {
    expect(runPsql(`select relrowsecurity from pg_class where oid = '${TABLE}'::regclass;`).trim()).toBe("t");
    expect(runPsql("select count(*) from pg_policies where tablename = 'cluster_skip_log';").trim()).toBe("0");
    const privs = (role: string) =>
      runPsql(`select string_agg(p, ',' order by p) from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                where has_table_privilege('${role}', '${TABLE}', p);`).trim();
    expect(privs("anon")).toBe("");
    expect(privs("authenticated")).toBe("");
    expect(privs("service_role")).toBe("insert,select");
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} can neither read nor write the table`, () => {
      expect(runPsqlError(`begin; set local role ${role}; select count(*) from ${TABLE}; rollback;`)).toMatch(/permission denied for table cluster_skip_log/);
      expect(
        runPsqlError(
          withArticles(`set local role ${role}; insert into ${TABLE} (article_id, cluster_id, reason) values ('${A1}', '${CLUSTER}', 'x');`),
        ),
      ).toMatch(/permission denied for table cluster_skip_log/);
      expect(
        runPsqlError(
          withArticles(
            `set local role ${role}; insert into ${TABLE} (article_id, cluster_id, reason) values ('${A1}', '${CLUSTER}', 'x') on conflict (article_id) do nothing;`,
          ),
        ),
      ).toMatch(/permission denied for table cluster_skip_log/);
    });
  }

  it("service_role inserts with on conflict do nothing; the first record of an article stays", () => {
    const out = runPsql(
      withArticles(`
set local role service_role;
insert into ${TABLE} (article_id, cluster_id, score, reason) values ('${A1}', '${CLUSTER}', 0.87, 'same-source-duplicate/exact-title') on conflict (article_id) do nothing;
insert into ${TABLE} (article_id, cluster_id, score, reason) values ('${A1}', '${CLUSTER}', 0.5, 'same-source-duplicate/fingerprint') on conflict (article_id) do nothing;
select 'row', count(*), min(reason), round(min(score)::numeric, 2), bool_and(created_at is not null) from ${TABLE} where article_id = '${A1}';
`),
    );
    expect(out.split("\n").filter((l) => l.startsWith("row|"))).toEqual(["row|1|same-source-duplicate/exact-title|0.87|t"]);
  });

  it("a cluster id that matches no cluster is accepted (no foreign key), a missing one is refused", () => {
    expect(
      runPsql(
        withArticles(`
set local role service_role;
insert into ${TABLE} (article_id, cluster_id, reason) values ('${A2}', '${NO_CLUSTER}', 'same-source-duplicate/headline-lane');
select 'ok', count(*) from ${TABLE} where article_id in ('${A1}', '${A2}');
`),
      ),
    ).toContain("ok|1");
    expect(
      runPsqlError(withArticles(`set local role service_role; insert into ${TABLE} (article_id, reason) values ('${A2}', 'x');`)),
    ).toMatch(/null value in column "cluster_id"|violates not-null constraint/);
  });

  for (const stmt of [`update ${TABLE} set score = 0`, `delete from ${TABLE}`, `truncate ${TABLE}`]) {
    it(`service_role cannot ${stmt.split(" ")[0]}`, () => {
      expect(
        runPsqlError(
          withArticles(`
insert into ${TABLE} (article_id, cluster_id, reason) values ('${A1}', '${CLUSTER}', 'x');
set local role service_role;
${stmt};
`),
        ),
      ).toMatch(/permission denied for table cluster_skip_log/);
    });
  }

  it("deleting the article removes its row (on delete cascade); another article's row stays", () => {
    const out = runPsql(
      withArticles(`
insert into ${TABLE} (article_id, cluster_id, reason) values ('${A1}', '${CLUSTER}', 'x'), ('${A2}', '${CLUSTER}', 'y');
delete from public.articles where id = '${A1}';
select 'left', article_id from ${TABLE} where article_id in ('${A1}', '${A2}');
`),
    );
    expect(out.split("\n").filter((l) => l.startsWith("left|"))).toEqual([`left|${A2}`]);
  });
});
