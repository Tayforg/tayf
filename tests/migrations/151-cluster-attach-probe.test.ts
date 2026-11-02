import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 151 ("cluster_attach_probe"), hunt-25 W3
// (h25-clusters-3).
//
// One story split because the politics gate is decided per article: nine
// identical or near-identical FETO-operation headlines sat in genel next to the
// clustered politika rows, and enqueue_cluster_work (025) only ever enqueues
// politika/son_dakika. 151 adds the DATABASE half of a deterministic, attach-only
// admission that ships in SHADOW mode:
//   * a NEW pgmq queue cluster_attach (not cluster_work: volume, FIFO lag checks
//     of 150, and the poison counter all argue for a separate queue);
//   * a SEPARATE trigger function + trigger that enqueue {article_id, admit:
//     'attach'} for the five non-gate categories of outlet/wire sources -- 025's
//     function and trigger are NOT touched, so the politika path stays
//     byte-identical;
//   * public.cluster_attach_shadow, the service-role-only record of what the
//     consumer would attach (or did attach, once live).
//
// This file pins: the ledger row, one transaction with a lock_timeout, the queue
// creation and the ACLs of its two tables, the exact table shape (a foreign key
// on article_id only), RLS on with no policy, the privileges (140's model), the
// definer function (search_path '', every identifier qualified, revoked from the
// client roles, owner postgres, the exception swallow), the trigger (WHEN clause
// = the five categories), that 025's function is never re-created, and the
// dry-run script. The last block (opt-in, TAYF_PSQL) repeats the dry-run checks on
// a throwaway Postgres where 151 is applied.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION_151 = resolve(MIGRATIONS_DIR, "151_cluster_attach_probe.sql");
const MIGRATION_140 = resolve(MIGRATIONS_DIR, "140_cluster_skip_log.sql");
const DRYRUN = resolve(ROOT, "tests", "migrations", "sql", "151-cluster-attach-probe-dryrun.sql");

const TABLE = "public.cluster_attach_shadow";
const FN = "public.enqueue_cluster_attach_probe";
const CATEGORIES = "'genel', 'ekonomi', 'dunya', 'yasam', 'teknoloji'";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

const sql = readFileSync(MIGRATION_151, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);

/** The body between the outer $$ ... $$ of the trigger function. */
function functionBody(): string {
  const open = code.indexOf("as $$");
  const close = code.indexOf("$$;", open + 5);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return code.slice(open + 5, close);
}

describe("151 cluster_attach_probe: ledger, transaction, header", () => {
  it("records version 151 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('151', '151_cluster_attach_probe') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row last", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const body = n.slice(n.indexOf("begin;"));
    expect(body.endsWith("on conflict do nothing; commit;")).toBe(true);
  });

  it("sets a local lock_timeout right after begin (the foreign key and the trigger take locks on articles)", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s';");
  });

  it("reloads the PostgREST schema cache before the ledger row", () => {
    expect(n).toContain("notify pgrst, 'reload schema'; insert into supabase_migrations.schema_migrations");
  });

  it("the header states the design decision and the sections of a 140-style header", () => {
    const header = sql.slice(0, sql.indexOf("\nbegin;"));
    for (const section of ["WHY", "WHAT", "STEP 0", "DRY RUNS", "DEPLOY", "VERIFY", "ROLLBACK"]) {
      expect(header, `header section ${section}`).toContain(section);
    }
    // The design decision: 151 does not re-create enqueue_cluster_work, and why a new queue.
    expect(header).toContain("does NOT re-create enqueue_cluster_work");
    expect(header).toContain("cluster_attach");
    // The md5 gate on 025's function: production's body, comment-only difference to the file.
    expect(header).toContain("858efd334d1586fdf340af3835c2ca9f");
    // Retention: positive decisions only, no job, the operator truncates after the live decision.
    expect(header).toMatch(/truncates the table/);
  });
});

describe("151 cluster_attach_probe: the queue", () => {
  it("creates the cluster_attach queue, guarded on pgmq.list_queues() as 024 does", () => {
    expect(n).toContain(
      "if not exists ( select 1 from pgmq.list_queues() q where q.queue_name = 'cluster_attach' ) then perform pgmq.create('cluster_attach'); end if;",
    );
    expect([...code.matchAll(/pgmq\.create\(/g)]).toHaveLength(1);
  });

  it("revokes every privilege on the queue's two tables from public, anon and authenticated", () => {
    expect(n).toContain("revoke all on pgmq.q_cluster_attach from public, anon, authenticated;");
    expect(n).toContain("revoke all on pgmq.a_cluster_attach from public, anon, authenticated;");
  });

  it("revokes the queue's sequence too when it exists", () => {
    expect(n).toContain("pgmq.q_cluster_attach_msg_id_seq");
    expect(n).toMatch(/revoke all on sequence pgmq\.q_cluster_attach_msg_id_seq from public, anon, authenticated/);
  });

  it("grants nothing on the pgmq schema (024 and 029 already give service_role its access)", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      expect(norm(m[0])).not.toMatch(/pgmq/i);
    }
  });
});

describe("151 cluster_attach_probe: table shape", () => {
  it("creates the table with exactly the specified columns, in order", () => {
    expect(n).toContain(
      "create table if not exists public.cluster_attach_shadow ( " +
        "article_id uuid primary key references public.articles(id) on delete cascade, " +
        "cluster_id uuid not null, " +
        "score real not null, " +
        "lane text not null check (lane in ('exact-title', 'fingerprint', 'headline')), " +
        "mode text not null check (mode in ('shadow', 'live')), " +
        "created_at timestamptz not null default now() " +
        ");",
    );
  });

  it("has a foreign key on article_id (on delete cascade) and none on cluster_id (merges, as in 140)", () => {
    const create = /create table if not exists public\.cluster_attach_shadow \(([\s\S]*?)\n\);/.exec(code)?.[1] ?? "";
    expect(create).not.toBe("");
    expect([...create.matchAll(/\breferences\b/gi)]).toHaveLength(1);
    expect(create).toMatch(/article_id uuid primary key references public\.articles\(id\) on delete cascade/);
    expect(create).toMatch(/cluster_id uuid not null,/);
    expect(create).not.toMatch(/cluster_id[^,\n]*references/i);
    expect(code).not.toMatch(/\balter\s+table\b[^;]*\badd\s+(constraint|foreign)/i);
  });

  it("indexes created_at with a plain create index (a new tiny table: no PRE-BUILD step)", () => {
    expect(n).toContain(
      "create index if not exists cluster_attach_shadow_created_at_idx on public.cluster_attach_shadow (created_at);",
    );
    expect(code).not.toMatch(/\bconcurrently\b/i);
  });

  it("documents the table", () => {
    expect(n).toMatch(/comment on table public\.cluster_attach_shadow is '/);
    expect(n).toContain("migration 151");
  });
});

describe("151 cluster_attach_probe: row level security and privileges (140's model)", () => {
  it("enables row level security and has no policy", () => {
    expect(n).toContain("alter table public.cluster_attach_shadow enable row level security;");
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    expect(code).not.toMatch(/\bforce\s+row\s+level\b/i);
  });

  it("revokes every privilege from anon, authenticated and public, and the default grants from service_role", () => {
    expect(n).toContain("revoke all on public.cluster_attach_shadow from anon, authenticated, public;");
    expect(n).toContain("revoke all on public.cluster_attach_shadow from service_role;");
  });

  it("grants select and insert to service_role, and that is the only grant in the file", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual(["grant select, insert on public.cluster_attach_shadow to service_role;"]);
  });

  it("never grants anything to anon, authenticated or public, and adds no default privileges or sequence grants", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      const grantees = /\bto\s+([^;]*);/i.exec(m[0])?.[1] ?? "";
      expect(grantees.trim()).toBe("service_role");
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    expect(code).not.toMatch(/\bgrant\b[^;]*\bsequence\b/i);
  });

  it("carries the PG17-guarded MAINTAIN revoke, character-identical to 140's block modulo the table name", () => {
    expect(n).toMatch(/do \$maint\$ begin if current_setting\('server_version_num'\)::int >= 170000 then/);
    expect(n).toContain("execute 'revoke maintain on public.cluster_attach_shadow from anon, authenticated';");
    const b140 = norm(readFileSync(MIGRATION_140, "utf8"));
    const blockOf = (s: string) => /do \$maint\$[\s\S]*?\$maint\$;/.exec(s)?.[0] ?? "";
    expect(blockOf(n)).not.toBe("");
    expect(blockOf(n).split("cluster_attach_shadow").join("cluster_skip_log")).toBe(blockOf(b140));
  });
});

describe("151 cluster_attach_probe: the trigger function", () => {
  it("is a plpgsql SECURITY DEFINER trigger function with an empty search_path, in schema public", () => {
    expect(n).toContain(
      "create or replace function public.enqueue_cluster_attach_probe() returns trigger language plpgsql security definer set search_path = '' as $$",
    );
  });

  it("qualifies every identifier it uses", () => {
    const body = functionBody();
    // Tables and functions are reached through a schema qualifier; the only bare words are plpgsql's own (NEW, sqlerrm).
    expect(body).toContain("from public.sources s");
    expect(body).toContain("perform pgmq.send(");
    expect(body).toContain("pg_catalog.jsonb_build_object(");
    expect(body).not.toMatch(/\bfrom\s+(?!public\.)\w/i);
    for (const m of body.matchAll(/jsonb_build_object/g)) {
      expect(body.slice(Math.max(0, (m.index ?? 0) - 11), m.index)).toBe("pg_catalog.");
    }
    // No call of a function that is not schema-qualified (now(), coalesce(...) would resolve only through the path).
    expect(body).not.toMatch(/(?<![\w.])(now|coalesce|nullif|format|to_char|concat)\s*\(/i);
  });

  it("returns NEW untouched unless the category is one of the five and the source is an outlet or a wire", () => {
    const body = norm(functionBody());
    expect(body).toContain(`if NEW.category is null or NEW.category not in (${CATEGORIES}) then return NEW; end if;`);
    expect(body).toContain(
      "if not exists ( select 1 from public.sources s where s.id = NEW.source_id and s.kind in ('outlet', 'wire') ) then return NEW; end if;",
    );
  });

  it("sends exactly {article_id, admit: 'attach'} to cluster_attach", () => {
    const body = norm(functionBody());
    expect(body).toContain(
      "perform pgmq.send( 'cluster_attach', pg_catalog.jsonb_build_object('article_id', NEW.id, 'admit', 'attach') );",
    );
    expect([...body.matchAll(/pgmq\.send\(/g)]).toHaveLength(1);
    expect(body).not.toContain("'cluster_work'");
  });

  it("swallows every error: a probe never fails an ingest insert", () => {
    const body = norm(functionBody());
    // The send sits inside a nested block whose handler only warns; scanned by position, not by a pattern over the text.
    const at = (needle: string, from = 0) => body.indexOf(needle, from);
    const blockAt = at("begin ");
    const sendAt = at("perform pgmq.send(", blockAt);
    const handlerAt = at("exception when others then raise warning '", sendAt);
    const endAt = at("end; return NEW;", handlerAt);
    expect(blockAt).toBeGreaterThan(-1);
    expect(sendAt).toBeGreaterThan(blockAt);
    expect(handlerAt).toBeGreaterThan(sendAt);
    expect(endAt).toBeGreaterThan(handlerAt);
    // A swallow, not a re-raise.
    expect(body).not.toMatch(/raise exception/i);
    expect(body).not.toMatch(/\bthen raise\s*;/i);
  });

  it("pins the owner to postgres (guarded), then revokes execute from the client roles AFTER the pin", () => {
    expect(n).toContain("if exists (select 1 from pg_roles where rolname = 'postgres') then alter function public.enqueue_cluster_attach_probe() owner to postgres; end if;");
    const ownerAt = n.indexOf("alter function public.enqueue_cluster_attach_probe() owner to postgres");
    const revokeAt = n.indexOf("revoke execute on function public.enqueue_cluster_attach_probe() from anon, authenticated, public;");
    expect(ownerAt).toBeGreaterThan(-1);
    expect(revokeAt).toBeGreaterThan(ownerAt);
  });

  it("documents the function", () => {
    expect(n).toMatch(/comment on function public\.enqueue_cluster_attach_probe\(\) is '/);
  });
});

describe("151 cluster_attach_probe: the trigger", () => {
  it("drops and creates articles_cluster_attach_probe: after insert, per row, WHEN = exactly the five categories", () => {
    expect(n).toContain("drop trigger if exists articles_cluster_attach_probe on public.articles; create trigger articles_cluster_attach_probe after insert on public.articles for each row when (");
    expect(n).toContain(
      `create trigger articles_cluster_attach_probe after insert on public.articles for each row when (NEW.category in (${CATEGORIES})) execute function public.enqueue_cluster_attach_probe();`,
    );
  });

  it("is the last object change: the table and the function exist before the trigger (the ACCESS EXCLUSIVE lock of the drop is held for the least time)", () => {
    const tableAt = n.indexOf("create table if not exists public.cluster_attach_shadow");
    const fnAt = n.indexOf("create or replace function public.enqueue_cluster_attach_probe()");
    const dropAt = n.indexOf("drop trigger if exists articles_cluster_attach_probe");
    const notifyAt = n.indexOf("notify pgrst");
    expect(tableAt).toBeGreaterThan(-1);
    expect(fnAt).toBeGreaterThan(tableAt);
    expect(dropAt).toBeGreaterThan(fnAt);
    expect(notifyAt).toBeGreaterThan(dropAt);
  });

  it("documents the trigger", () => {
    expect(n).toMatch(/comment on trigger articles_cluster_attach_probe on public\.articles is '/);
  });
});

describe("151 cluster_attach_probe: additive, and 025 is untouched", () => {
  it("never re-creates, drops or alters enqueue_cluster_work or its trigger; the name appears in comments only", () => {
    expect(code).not.toMatch(/enqueue_cluster_work/);
    expect(code).not.toMatch(/articles_cluster_enqueue/);
    expect(sql).toMatch(/--[^\n]*enqueue_cluster_work/);
    expect(code).not.toMatch(/'cluster_work'/);
  });

  it("creates one table, one index, one function and one trigger, no view or cron job", () => {
    expect([...code.matchAll(/\bcreate\s+table\b/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcreate\s+(unique\s+)?index\b/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcreate\s+trigger\b/gi)]).toHaveLength(1);
    expect(code).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(view|materialized|extension)\b/i);
    expect(code).not.toMatch(/\bcron\./i);
  });

  it("changes no other existing object and rewrites no data", () => {
    // The only drop is the trigger this file owns (re-created right after).
    const drops = [...code.matchAll(/\bdrop\s[^;]*;/gi)].map((m) => norm(m[0]));
    expect(drops).toEqual(["drop trigger if exists articles_cluster_attach_probe on public.articles;"]);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/^\s*update\b/im);
    const alters = [...code.matchAll(/\balter\s[^;]*;/gi)].map((m) => norm(m[0]));
    expect(alters).toEqual([
      "alter table public.cluster_attach_shadow enable row level security;",
      "alter function public.enqueue_cluster_attach_probe() owner to postgres;",
    ]);
    const inserts = [...code.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
  });

  it("mentions anon and authenticated only in revoke statements", () => {
    for (const stmt of code.split(";")) {
      if (!/\b(anon|authenticated)\b/i.test(stmt)) continue;
      expect(norm(stmt), norm(stmt)).toMatch(/\brevoke\b/i);
    }
  });
});

describe("151 cluster_attach_probe: the dry-run script", () => {
  const dry = existsSync(DRYRUN) ? readFileSync(DRYRUN, "utf8") : "";

  it("exists and ends with its pass marker", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    expect(dry).toContain("DRYRUN 151 OK");
  });

  it("gates on production's enqueue_cluster_work body (md5 858efd33...) before applying 151, and re-checks it after", () => {
    const gate = "858efd334d1586fdf340af3835c2ca9f";
    expect([...dry.matchAll(new RegExp(gate, "g"))].length).toBeGreaterThanOrEqual(2);
  });

  it("applies 151 twice and asserts the scenarios the spec lists", () => {
    expect([...dry.matchAll(/151_cluster_attach_probe\.sql/g)].length).toBeGreaterThanOrEqual(2);
    for (const scenario of [
      "politika",
      "cluster_attach",
      "aggregator",
      "spor",
      "null category",
      "stub_fail",
      "permission denied",
    ]) {
      expect(dry, `dry-run scenario ${scenario}`).toContain(scenario);
    }
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at the THROWAWAY database the dry-run script leaves behind
// (jevtest/qa/stub.sql, the pgmq stub of the dry-run script, 025's function and
// trigger as in production, 151 applied). Every check that writes runs inside a
// transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("151 against a live Postgres (151 applied)", () => {
  const A1 = "aaaaaaaa-0000-0000-0000-00000000b001";
  const A2 = "aaaaaaaa-0000-0000-0000-00000000b002";
  const CLUSTER = "cccccccc-0000-0000-0000-00000000c001";
  const NO_CLUSTER = "cccccccc-0000-0000-0000-00000000c0ff";
  const S_OUTLET = "55555555-0000-0000-0000-000000000001";
  const S_WIRE = "55555555-0000-0000-0000-000000000002";
  const S_AGG = "55555555-0000-0000-0000-000000000003";

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
  const seedSources = `
insert into public.sources (id, slug, name, kind) values
  ('${S_OUTLET}', 'probe-outlet', 'Probe outlet', 'outlet'),
  ('${S_WIRE}', 'probe-wire', 'Probe wire', 'wire'),
  ('${S_AGG}', 'probe-agg', 'Probe aggregator', 'aggregator');
`;
  const inTx = (body: string) => `begin;\n${seedSources}\n${body}\nrollback;\n`;
  const sent = (queue: string) => `select count(*) from pgmq.stub_sent where queue_name = '${queue}'`;

  it("the ledger row, the table and its foreign key are there", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '151';").trim()).toBe("1");
    expect(runPsql(`select to_regclass('${TABLE}') is not null;`).trim()).toBe("t");
    expect(
      runPsql(`select a.attname, c.confrelid::regclass::text, c.confdeltype
                 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                where c.conrelid = '${TABLE}'::regclass and c.contype = 'f' order by 1;`).trim(),
    ).toBe("article_id|articles|c");
  });

  it("has exactly the specified columns and both check constraints", () => {
    expect(
      runPsql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
                 from information_schema.columns where table_schema = 'public' and table_name = 'cluster_attach_shadow';`).trim(),
    ).toBe(
      "article_id:uuid:NO,cluster_id:uuid:NO,score:real:NO,lane:text:NO,mode:text:NO,created_at:timestamp with time zone:NO",
    );
    expect(
      runPsql(`select count(*) from pg_constraint where conrelid = '${TABLE}'::regclass and contype = 'c';`).trim(),
    ).toBe("2");
  });

  it("RLS is on, there is no policy, and the table privileges are service_role select + insert only", () => {
    expect(runPsql(`select relrowsecurity from pg_class where oid = '${TABLE}'::regclass;`).trim()).toBe("t");
    expect(runPsql("select count(*) from pg_policies where tablename = 'cluster_attach_shadow';").trim()).toBe("0");
    const privs = (role: string) =>
      runPsql(`select coalesce(string_agg(p, ',' order by p), '') from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                where has_table_privilege('${role}', '${TABLE}', p);`).trim();
    expect(privs("anon")).toBe("");
    expect(privs("authenticated")).toBe("");
    expect(privs("service_role")).toBe("insert,select");
  });

  it("the queue exists and its tables carry no privilege for anon, authenticated or public", () => {
    expect(runPsql("select count(*) from pgmq.list_queues() q where q.queue_name = 'cluster_attach';").trim()).toBe("1");
    for (const rel of ["pgmq.q_cluster_attach", "pgmq.a_cluster_attach"]) {
      for (const role of ["anon", "authenticated"]) {
        expect(
          runPsql(`select count(*) from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                    where has_table_privilege('${role}', '${rel}', p);`).trim(),
        ).toBe("0");
      }
      // No PUBLIC entry in the ACL (grantee 0 prints as an empty role name before the '=').
      expect(runPsql(`select count(*) from pg_class c, aclexplode(c.relacl) a where c.oid = '${rel}'::regclass and a.grantee = 0;`).trim()).toBe("0");
    }
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} can neither read nor write the table, nor execute the function`, () => {
      expect(runPsqlError(`begin; set local role ${role}; select count(*) from ${TABLE}; rollback;`)).toMatch(/permission denied for table cluster_attach_shadow/);
      expect(
        runPsqlError(
          `begin; insert into public.articles (id, title) values ('${A1}', 'x'); set local role ${role};
           insert into ${TABLE} (article_id, cluster_id, score, lane, mode) values ('${A1}', '${CLUSTER}', 1, 'exact-title', 'shadow'); rollback;`,
        ),
      ).toMatch(/permission denied for table cluster_attach_shadow/);
      expect(runPsqlError(`begin; set local role ${role}; select ${FN}(); rollback;`)).toMatch(/permission denied for function enqueue_cluster_attach_probe/);
    });
  }

  it("a politika insert enqueues one cluster_work message and nothing on cluster_attach", () => {
    const out = runPsql(
      inTx(`
insert into public.articles (id, source_id, title, category) values ('${A1}', '${S_OUTLET}', 'politika row', 'politika');
select 'work', count(*), min(message->>'article_id') from pgmq.stub_sent where queue_name = 'cluster_work';
select 'attach', count(*) from pgmq.stub_sent where queue_name = 'cluster_attach';
`),
    );
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("work|"))).toEqual([`work|1|${A1}`]);
    expect(lines.filter((l) => l.startsWith("attach|"))).toEqual(["attach|0"]);
  });

  it("a genel row of an outlet enqueues {article_id, admit: 'attach'} on cluster_attach and nothing on cluster_work", () => {
    const out = runPsql(
      inTx(`
insert into public.articles (id, source_id, title, category) values ('${A1}', '${S_OUTLET}', 'genel row', 'genel');
select 'attach', count(*), min(message::text) from pgmq.stub_sent where queue_name = 'cluster_attach';
select 'work', count(*) from pgmq.stub_sent where queue_name = 'cluster_work';
`),
    );
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("attach|"))).toEqual([`attach|1|{"admit": "attach", "article_id": "${A1}"}`]);
    expect(lines.filter((l) => l.startsWith("work|"))).toEqual(["work|0"]);
  });

  it("wire sources and the other four categories enqueue too", () => {
    const out = runPsql(
      inTx(`
insert into public.articles (id, source_id, title, category) values
  (gen_random_uuid(), '${S_WIRE}', 'wire genel', 'genel'),
  (gen_random_uuid(), '${S_OUTLET}', 'o ekonomi', 'ekonomi'),
  (gen_random_uuid(), '${S_OUTLET}', 'o dunya', 'dunya'),
  (gen_random_uuid(), '${S_OUTLET}', 'o yasam', 'yasam'),
  (gen_random_uuid(), '${S_OUTLET}', 'o teknoloji', 'teknoloji');
select 'attach', count(*) from pgmq.stub_sent where queue_name = 'cluster_attach';
`),
    );
    expect(out.split("\n").filter((l) => l.startsWith("attach|"))).toEqual(["attach|5"]);
  });

  it("an aggregator, spor, a null category and a null source enqueue nothing at all", () => {
    const out = runPsql(
      inTx(`
insert into public.articles (id, source_id, title, category) values
  (gen_random_uuid(), '${S_AGG}', 'agg genel', 'genel'),
  (gen_random_uuid(), '${S_OUTLET}', 'o spor', 'spor'),
  (gen_random_uuid(), '${S_OUTLET}', 'null category', null),
  (gen_random_uuid(), null, 'null source', 'genel');
select 'total', count(*) from pgmq.stub_sent;
`),
    );
    expect(out.split("\n").filter((l) => l.startsWith("total|"))).toEqual(["total|0"]);
  });

  it("when the queue send raises, the insert still commits and only a warning is emitted", () => {
    const out = runPsql(
      inTx(`
set local pgmq.stub_fail = 'on';
insert into public.articles (id, source_id, title, category) values ('${A2}', '${S_OUTLET}', 'send fails', 'genel');
select 'row', count(*) from public.articles where id = '${A2}';
select 'sent', count(*) from pgmq.stub_sent;
`),
    );
    const lines = out.split("\n");
    expect(lines.filter((l) => l.startsWith("row|"))).toEqual(["row|1"]);
    expect(lines.filter((l) => l.startsWith("sent|"))).toEqual(["sent|0"]);
  });

  it("025's function and trigger are exactly production's: the md5 of the body is unchanged", () => {
    expect(
      runPsql("select md5(prosrc) from pg_proc where oid = 'public.enqueue_cluster_work()'::regprocedure;").trim(),
    ).toBe("858efd334d1586fdf340af3835c2ca9f");
    expect(
      runPsql("select pg_get_triggerdef(oid) from pg_trigger where tgname = 'articles_cluster_enqueue' and not tgisinternal;").trim(),
    ).toBe(
      "CREATE TRIGGER articles_cluster_enqueue AFTER INSERT ON public.articles FOR EACH ROW WHEN ((new.category = ANY (ARRAY['politika'::text, 'son_dakika'::text]))) EXECUTE FUNCTION enqueue_cluster_work()",
    );
  });

  it("service_role inserts with on conflict do nothing; the first record stays; cluster_id has no foreign key", () => {
    const out = runPsql(
      inTx(`
insert into public.articles (id, source_id, title, category) values ('${A1}', '${S_OUTLET}', 'one', 'genel');
set local role service_role;
insert into ${TABLE} (article_id, cluster_id, score, lane, mode) values ('${A1}', '${NO_CLUSTER}', 0.92, 'headline', 'shadow') on conflict (article_id) do nothing;
insert into ${TABLE} (article_id, cluster_id, score, lane, mode) values ('${A1}', '${CLUSTER}', 1, 'exact-title', 'live') on conflict (article_id) do nothing;
select 'row', count(*), min(lane), min(mode), round(min(score)::numeric, 2) from ${TABLE} where article_id = '${A1}';
`),
    );
    expect(out.split("\n").filter((l) => l.startsWith("row|"))).toEqual(["row|1|headline|shadow|0.92"]);
  });

  it("the lane and mode checks and the not-null columns hold", () => {
    const insert = (cols: string) =>
      inTx(`
insert into public.articles (id, source_id, title, category) values ('${A1}', '${S_OUTLET}', 'one', 'genel');
set local role service_role;
insert into ${TABLE} (article_id, cluster_id, score, lane, mode) values (${cols});`);
    expect(runPsqlError(insert(`'${A1}', '${CLUSTER}', 1, 'tfidf', 'shadow'`))).toMatch(/violates check constraint/);
    expect(runPsqlError(insert(`'${A1}', '${CLUSTER}', 1, 'headline', 'dry'`))).toMatch(/violates check constraint/);
    expect(runPsqlError(insert(`'${A1}', null, 1, 'headline', 'shadow'`))).toMatch(/null value in column "cluster_id"|not-null/);
    expect(runPsqlError(insert(`'${A1}', '${CLUSTER}', null, 'headline', 'shadow'`))).toMatch(/null value in column "score"|not-null/);
  });

  for (const stmt of [`update ${TABLE} set score = 0`, `delete from ${TABLE}`, `truncate ${TABLE}`]) {
    it(`service_role cannot ${stmt.split(" ")[0]}`, () => {
      expect(
        runPsqlError(
          inTx(`
insert into public.articles (id, source_id, title, category) values ('${A1}', '${S_OUTLET}', 'one', 'genel');
insert into ${TABLE} (article_id, cluster_id, score, lane, mode) values ('${A1}', '${CLUSTER}', 1, 'headline', 'shadow');
set local role service_role;
${stmt};`),
        ),
      ).toMatch(/permission denied for table cluster_attach_shadow/);
    });
  }

  it("deleting the article removes its row (on delete cascade); another article's row stays", () => {
    const out = runPsql(
      inTx(`
insert into public.articles (id, source_id, title, category) values ('${A1}', '${S_OUTLET}', 'one', 'genel'), ('${A2}', '${S_OUTLET}', 'two', 'genel');
insert into ${TABLE} (article_id, cluster_id, score, lane, mode) values ('${A1}', '${CLUSTER}', 1, 'headline', 'shadow'), ('${A2}', '${CLUSTER}', 1, 'headline', 'shadow');
delete from public.articles where id = '${A1}';
select 'left', article_id from ${TABLE} where article_id in ('${A1}', '${A2}');
`),
    );
    expect(out.split("\n").filter((l) => l.startsWith("left|"))).toEqual([`left|${A2}`]);
  });

  it("counts: no queue message is left behind by the rolled-back scenarios", () => {
    expect(runPsql(`${sent("cluster_attach")};`).trim()).toBe("0");
  });
});
