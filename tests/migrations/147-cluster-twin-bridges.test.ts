import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 147 ("cluster_twin_bridges"), the
// shadow-mode evidence log of h19-recall-3.
//
// Twin clusters are never repaired (cluster_merge_log has 0 rows ever) and the
// consumer discards the evidence that two clusters hold one story. 147 adds the
// table the consumer logs it in: one row per (article, cluster pair) where the
// article scores >= 0.55 against the other cluster. twinMergeDecision()
// (supabase/functions/_shared/cluster/twin-merge.ts) turns the rows into a
// would-merge verdict; nothing merges automatically.
//
// This file pins: the ledger row, one transaction with a lock_timeout, the exact
// columns, the composite primary key, the ordered-pair check, the absence of any
// foreign key, RLS on with no policy, the privilege statements (revoke from anon,
// authenticated and public, revoke from service_role, grant select + insert to
// service_role and nothing else), the PG17-guarded MAINTAIN revoke (equal to
// 140's), the seen_at index, the schema reload, the header sections, and that no
// existing object is touched. The last block (opt-in, TAYF_PSQL) repeats the
// privilege checks of the dry run on a throwaway Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_147 = resolve(MIGRATIONS_DIR, "147_cluster_twin_bridges.sql");
const MIGRATION_140 = resolve(MIGRATIONS_DIR, "140_cluster_skip_log.sql");

const TABLE = "public.cluster_twin_bridges";

/** Drops every `-- ...` comment, line by line (no regex over the SQL). */
function stripSqlComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i === -1 ? line : line.slice(0, i);
    })
    .join("\n");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).split(/\s+/).filter(Boolean).join(" ");
}

/** The `do $maint$ ... $maint$;` block of a normalised migration. */
function maintBlock(normalised: string): string {
  const start = normalised.indexOf("do $maint$");
  if (start === -1) return "";
  const endMarker = "$maint$;";
  const end = normalised.indexOf(endMarker, start + "do $maint$".length);
  return end === -1 ? "" : normalised.slice(start, end + endMarker.length);
}

const sql = readFileSync(MIGRATION_147, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);
/** Whitespace-collapsed statements of the comment-free SQL, split on `;` (the DO block splits too, which no check below minds). */
const statements = code
  .split(";")
  .map((statement) => norm(statement))
  .filter(Boolean);
const startsWithWord = (statement: string, word: string): boolean =>
  statement === word || statement.startsWith(word + " ");
/** The leading comment block as running text: comment markers dropped, whitespace collapsed. */
const header = sql
  .slice(0, sql.indexOf("\nbegin;"))
  .split("\n")
  .map((line) => (line.startsWith("--") ? line.slice(2) : line))
  .join(" ")
  .split(/\s+/)
  .filter(Boolean)
  .join(" ");

describe("147 cluster_twin_bridges: ledger and transaction", () => {
  it("records version 147 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('147', '147_cluster_twin_bridges') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const body = n.slice(n.indexOf("begin;"));
    expect(body.endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("sets a local lock_timeout right after begin", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s'; create table if not exists");
  });

  it("reloads the PostgREST schema cache", () => {
    expect(n).toContain("notify pgrst, 'reload schema';");
  });
});

describe("147 cluster_twin_bridges: table shape", () => {
  it("creates the table with exactly the specified columns, primary key and ordered-pair check, in order", () => {
    expect(n).toContain(
      "create table if not exists public.cluster_twin_bridges ( " +
        "article_id uuid not null, " +
        "cluster_a uuid not null, " +
        "cluster_b uuid not null, " +
        "score real not null, " +
        "seen_at timestamptz not null default now(), " +
        "primary key (article_id, cluster_a, cluster_b), " +
        "constraint cluster_twin_bridges_ordered check (cluster_a < cluster_b) " +
        ");",
    );
  });

  it("has no foreign key and no reference to another table (rows survive merges, article deletes are not slowed)", () => {
    const start = code.indexOf("create table if not exists public.cluster_twin_bridges");
    const end = code.indexOf(");", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const create = code.slice(start, end);
    expect(create).not.toMatch(/\breferences\b/i);
    expect(create).not.toMatch(/\bforeign\s+key\b/i);
    expect(code).not.toMatch(/\balter\s+table\b[^;]*\badd\s+(constraint|foreign)/i);
    // the header says why
    expect(header).toMatch(/no foreign key/i);
  });

  it("indexes seen_at with a plain create index (a new, empty table: no PRE-BUILD step)", () => {
    expect(n).toContain("create index if not exists cluster_twin_bridges_seen_at_idx on public.cluster_twin_bridges (seen_at);");
    expect(code).not.toMatch(/\bconcurrently\b/i);
  });

  it("documents the table, including that it is shadow evidence and migration 147", () => {
    expect(n).toMatch(/comment on table public\.cluster_twin_bridges is '/);
    expect(n).toContain("migration 147");
    expect(n).toMatch(/shadow/i);
  });
});

describe("147 cluster_twin_bridges: row level security and privileges", () => {
  it("enables row level security and has no policy", () => {
    expect(n).toContain("alter table public.cluster_twin_bridges enable row level security;");
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    expect(code).not.toMatch(/\bforce\s+row\s+level\b/i);
  });

  it("revokes every privilege from anon, authenticated and public, and the default grants from service_role", () => {
    expect(n).toContain("revoke all on public.cluster_twin_bridges from anon, authenticated, public;");
    expect(n).toContain("revoke all on public.cluster_twin_bridges from service_role;");
  });

  it("grants select and insert to service_role, and that is the only grant in the file", () => {
    const grants = statements.filter((statement) => startsWithWord(statement, "grant"));
    expect(grants).toEqual(["grant select, insert on public.cluster_twin_bridges to service_role"]);
  });

  it("grants nothing to anon, authenticated or public, never update/delete/truncate, and adds no default privileges", () => {
    const grants = statements.filter((statement) => startsWithWord(statement, "grant"));
    expect(grants).toHaveLength(1);
    for (const grant of grants) {
      // the grantee list is what follows the last ` to `
      const grantees = grant.slice(grant.lastIndexOf(" to ") + 4);
      expect(grantees.trim()).toBe("service_role");
      // the privilege list is what sits between `grant` and ` on `
      const privileges = grant.slice("grant ".length, grant.indexOf(" on "));
      expect(privileges.split(",").map((p) => p.trim())).toEqual(["select", "insert"]);
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    expect(code).not.toMatch(/\bsequence\b/i);
  });

  it("carries the PG17-guarded MAINTAIN revoke, equal to 140's block modulo the table name", () => {
    const mine = maintBlock(n);
    const theirs = maintBlock(norm(readFileSync(MIGRATION_140, "utf8")));
    expect(mine).not.toBe("");
    expect(theirs).not.toBe("");
    expect(mine).toContain("current_setting('server_version_num')::int >= 170000");
    expect(mine).toContain("execute 'revoke maintain on public.cluster_twin_bridges from anon, authenticated';");
    // every occurrence of the table name is swapped, so nothing else may differ
    expect(mine.split("cluster_twin_bridges").join("cluster_skip_log")).toBe(theirs);
  });
});

describe("147 cluster_twin_bridges: additive shape", () => {
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
    const alters = statements.filter((statement) => startsWithWord(statement, "alter"));
    expect(alters).toEqual(["alter table public.cluster_twin_bridges enable row level security"]);
    // the only insert is the ledger row
    const inserts = statements.filter((statement) => startsWithWord(statement, "insert")).map((statement) => statement.split(" ")[2]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("touches only the new table (no other public object is named in a statement)", () => {
    const touched = new Set([...code.matchAll(/\bpublic\.([a-z_]+)/gi)].map((m) => (m[1] ?? "").toLowerCase()));
    expect([...touched]).toEqual(["cluster_twin_bridges"]);
  });
});

describe("147 cluster_twin_bridges: operator header", () => {
  it("carries the WHY, STEP 0, DRY RUNS, VERIFY, DEPLOY, ROLLBACK and RETENTION sections", () => {
    for (const section of ["WHY", "STEP 0", "DRY RUNS", "VERIFY", "DEPLOY", "ROLLBACK", "RETENTION"]) {
      expect(header, section).toContain(section);
    }
  });

  it("states the retention estimate and that a prune job is a founder decision needing grant delete", () => {
    expect(header).toMatch(/rows\/day|rows a day/i);
    expect(header).toMatch(/at most 3 pairs per article|cap of (at most )?3 pairs/i);
    expect(header).toMatch(/founder decision/i);
    expect(header).toMatch(/grant delete/i);
  });

  it("records that 147 is free, the table does not exist and cluster_merge_log has no rows (STEP 0)", () => {
    expect(header).toContain("to_regclass");
    expect(header).toContain("cluster_merge_log");
  });

  it("documents the rollback and the manual-merge boundary", () => {
    expect(header).toContain("drop table public.cluster_twin_bridges");
    expect(header).toContain("/admin/birlestir");
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at a THROWAWAY database with the shared stub schema
// (jevtest/qa/stub.sql: the three roles, public.articles, supabase_migrations),
// default privileges that mimic Supabase's, service_role created with BYPASSRLS as
// Supabase has it, and 147 applied. Every check runs inside a transaction that is
// rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("147 against a live Postgres (147 applied)", () => {
  const ART = "aaaaaaaa-0000-4000-8000-00000000a001";
  const CA = "2c9941bd-b6b4-417d-a225-ba45f77e2158";
  const CB = "8ab93bbd-0433-49df-b333-4b358c03897c";

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
  const insertRow = `insert into ${TABLE} (article_id, cluster_a, cluster_b, score) values ('${ART}', '${CA}', '${CB}', 0.83)`;

  it("the ledger row and the table are there", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '147';").trim()).toBe("1");
    expect(runPsql(`select to_regclass('${TABLE}') is not null;`).trim()).toBe("t");
    // no foreign key of any kind
    expect(runPsql(`select count(*) from pg_constraint where conrelid = '${TABLE}'::regclass and contype = 'f';`).trim()).toBe("0");
  });

  it("has exactly the specified columns", () => {
    expect(
      runPsql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
                 from information_schema.columns where table_schema = 'public' and table_name = 'cluster_twin_bridges';`).trim(),
    ).toBe(
      "article_id:uuid:NO,cluster_a:uuid:NO,cluster_b:uuid:NO,score:real:NO,seen_at:timestamp with time zone:NO",
    );
  });

  it("RLS is on, there is no policy, and the table privileges are service_role select + insert only", () => {
    expect(runPsql(`select relrowsecurity from pg_class where oid = '${TABLE}'::regclass;`).trim()).toBe("t");
    expect(runPsql("select count(*) from pg_policies where tablename = 'cluster_twin_bridges';").trim()).toBe("0");
    const privs = (role: string) =>
      runPsql(`select string_agg(p, ',' order by p) from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                where has_table_privilege('${role}', '${TABLE}', p);`).trim();
    expect(privs("anon")).toBe("");
    expect(privs("authenticated")).toBe("");
    expect(privs("service_role")).toBe("insert,select");
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} can neither read nor write the table`, () => {
      expect(runPsqlError(`begin; set local role ${role}; select count(*) from ${TABLE}; rollback;`)).toMatch(
        /permission denied for table cluster_twin_bridges/,
      );
      expect(runPsqlError(`begin; set local role ${role}; ${insertRow}; rollback;`)).toMatch(
        /permission denied for table cluster_twin_bridges/,
      );
    });
  }

  it("service_role inserts; the same (article, pair) again with on conflict do nothing is INSERT 0 0 and keeps the first score", () => {
    const out = runPsql(`
begin;
set local role service_role;
${insertRow} on conflict do nothing;
insert into ${TABLE} (article_id, cluster_a, cluster_b, score) values ('${ART}', '${CA}', '${CB}', 0.5) on conflict do nothing;
select 'row', count(*), round(min(score)::numeric, 2), bool_and(seen_at is not null) from ${TABLE} where article_id = '${ART}';
rollback;
`);
    expect(out.split("\n").filter((l) => l.startsWith("row|"))).toEqual(["row|1|0.83|t"]);
  });

  it("refuses an unordered pair (cluster_a > cluster_b) and a pair of equal ids", () => {
    expect(
      runPsqlError(
        `begin; set local role service_role; insert into ${TABLE} (article_id, cluster_a, cluster_b, score) values ('${ART}', '${CB}', '${CA}', 0.7); rollback;`,
      ),
    ).toMatch(/cluster_twin_bridges_ordered/);
    expect(
      runPsqlError(
        `begin; set local role service_role; insert into ${TABLE} (article_id, cluster_a, cluster_b, score) values ('${ART}', '${CA}', '${CA}', 0.7); rollback;`,
      ),
    ).toMatch(/cluster_twin_bridges_ordered/);
  });

  it("accepts ids that match no article or cluster (no foreign keys), refuses a null score", () => {
    expect(runPsql(`begin; set local role service_role; ${insertRow}; select 'ok', count(*) from ${TABLE}; rollback;`)).toContain("ok|1");
    expect(
      runPsqlError(
        `begin; set local role service_role; insert into ${TABLE} (article_id, cluster_a, cluster_b) values ('${ART}', '${CA}', '${CB}'); rollback;`,
      ),
    ).toMatch(/null value in column "score"|violates not-null constraint/);
  });

  it("the uuid ordering of the check agrees with the string ordering the consumer will use", () => {
    expect(
      runPsql(
        `select ('${CA}'::uuid < '${CB}'::uuid) = ('${CA}' < '${CB}'), ('${CB}'::uuid < '${CA}'::uuid) = ('${CB}' < '${CA}');`,
      ).trim(),
    ).toBe("t|t");
  });

  for (const stmt of [`update ${TABLE} set score = 0`, `delete from ${TABLE}`, `truncate ${TABLE}`]) {
    it(`service_role cannot ${stmt.split(" ")[0]}`, () => {
      expect(
        runPsqlError(`begin; ${insertRow}; set local role service_role; ${stmt}; rollback;`),
      ).toMatch(/permission denied for table cluster_twin_bridges/);
    });
  }
});
