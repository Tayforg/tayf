import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, ZONE_KEYS } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 143 ("weekly_words_sample"), h14-perf-1.
//
// The /hafta "Ayrisan Kelimeler" fill read 21 (zone x day) samples, each
// `order by id limit 300`, through a pool of 4; a cold fill could pass the 4 s
// reader cap. A single-statement sampling RPC was measured and rejected (4.7 s to
// more than 8 s cold). 143 precomputes the sample hourly into a tiny table,
// public.weekly_words_sample, with public.weekly_words_sample_refresh(p_days) and a
// pg_cron job at minute 38; src/lib/weekly/distinctive-words-query.ts reads the
// table and falls back to the pooled article reads for days the table lacks.
//
// This file pins: the single 143_ file, one transaction with a lock_timeout, the
// exact column list / primary key / zone check and the absence of any foreign key,
// RLS on with no policy, the privilege statements (service_role select only,
// nothing for anon, authenticated or public) and 140's PG17-guarded MAINTAIN
// revoke, the function (signature, security definer, empty search_path, clamp
// 1..14, advisory try-lock, delete-then-insert per day, the zone map equal to
// BIAS_TO_ZONE, the kind list equal to VOTING_SOURCE_KINDS, the row limit equal to
// WEEKLY_WORDS_PER_ZONE_PER_DAY, Istanbul day bounds, retention), the additive
// shape (no index, no DML outside the new table), the idempotent cron block, the
// schema reload and ledger row, the orphan sweep (no FK, so the rows of a deleted
// article are swept for the days the page reads), the header sections and the
// operator runbook in docs/migration-guide.md. The last block (opt-in, TAYF_PSQL)
// repeats the dry-run checks on a throwaway Postgres.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE = "143_weekly_words_sample.sql";
const MIGRATION_143 = resolve(MIGRATIONS_DIR, FILE);
const MIGRATION_140 = resolve(MIGRATIONS_DIR, "140_cluster_skip_log.sql");
const READER = resolve(ROOT, "src", "lib", "weekly", "distinctive-words-query.ts");

const TABLE = "public.weekly_words_sample";
const FN = "public.weekly_words_sample_refresh";
const FN_SIG = `${FN}(integer)`;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Code with single-quoted string literals blanked out (comments already stripped). */
function stripStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Comment-free, whitespace-collapsed form. */
function norm(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim();
}

/** norm() with the padding inside parentheses removed, so a wrapped call compares equal to a one-line one. */
function tight(sql: string): string {
  return norm(sql).replace(/\(\s+/g, "(").replace(/\s+\)/g, ")");
}

/**
 * Contents of the adjacent string literals (Postgres concatenates them) that follow
 * `start`, up to the next `;` outside a literal.
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

const sql = readFileSync(MIGRATION_143, "utf8");
const code = stripSqlComments(sql);
const n = norm(sql);
/** Everything before the transaction: the header comment block. */
const header = sql.slice(0, sql.search(/^begin;/m));

const tableMatch = /create table if not exists public\.weekly_words_sample \(([\s\S]*?)\n\);/i.exec(code);
const tableBody = tight(tableMatch?.[1] ?? "");

const fnMatch = /create or replace function public\.weekly_words_sample_refresh\(([\s\S]*?)\)\s*returns\s+([\s\S]*?)\s+as \$fn\$([\s\S]*?)\$fn\$;/i.exec(code);
const fnArgs = norm(fnMatch?.[1] ?? "");
const fnAttrs = norm(fnMatch?.[2] ?? "");
const body = tight(fnMatch?.[3] ?? "");

const cronBlock = /do \$cron\$([\s\S]*?)\$cron\$;/i.exec(code)?.[1] ?? "";
const cron = norm(cronBlock);

const reader = readFileSync(READER, "utf8");
const GUIDE = resolve(ROOT, "docs", "migration-guide.md");
/** Days the /hafta page reads (today plus the days before it): WEEKLY_WORDS_DAYS in the reader. */
const READER_DAYS = Number(/export const WEEKLY_WORDS_DAYS = (\d+);/.exec(reader)?.[1]);

describe("143 weekly_words_sample: file, ledger and transaction", () => {
  it("is the only 143_ migration and has the agreed name", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("143_"));
    expect(files).toEqual([FILE]);
  });

  it("records version 143 in the schema_migrations ledger, idempotently (095 pattern)", () => {
    expect(n).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('143', '143_weekly_words_sample') on conflict do nothing;",
    );
  });

  it("is one transaction: a single begin, a single commit, the ledger row the last statement", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const tail = n.slice(n.indexOf("begin;"));
    expect(
      tail.endsWith(
        "insert into supabase_migrations.schema_migrations (version, name) values ('143', '143_weekly_words_sample') on conflict do nothing; commit;",
      ),
    ).toBe(true);
  });

  it("sets a local lock_timeout of 5s right after begin", () => {
    expect(n).toContain("begin; set local lock_timeout = '5s'; create table if not exists");
  });

  it("reloads the PostgREST schema cache before the ledger row (the reader reads the table through PostgREST)", () => {
    expect(n).toContain("notify pgrst, 'reload schema';");
    expect(n.indexOf("notify pgrst, 'reload schema';")).toBeLessThan(
      n.indexOf("insert into supabase_migrations.schema_migrations"),
    );
  });
});

describe("143 weekly_words_sample: table", () => {
  it("creates exactly one table, if not exists", () => {
    expect([...code.matchAll(/\bcreate\s+table\b/gi)]).toHaveLength(1);
    expect(tableMatch).not.toBeNull();
  });

  it("has exactly the specified columns and the (day, zone, article_id) primary key", () => {
    expect(tableBody).toBe(
      "day date not null, " +
        "zone text not null check (zone in ('iktidar', 'bagimsiz', 'muhalefet')), " +
        "article_id uuid not null, " +
        "source_id uuid not null, " +
        "title text, " +
        "url text, " +
        "created_at timestamptz not null, " +
        "primary key (day, zone, article_id)",
    );
  });

  it("the zone check lists exactly the three Medya DNA zones", () => {
    const list = /check \(zone in \(([^)]*)\)\)/.exec(tableBody)?.[1] ?? "";
    const zones = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(zones).toEqual([...ZONE_KEYS]);
  });

  it("has no foreign key and no reference (an FK would make every articles DELETE probe this table)", () => {
    const bare = stripStrings(code);
    expect(bare).not.toMatch(/\breferences\b/i);
    expect(bare).not.toMatch(/\bforeign\s+key\b/i);
    expect(bare).not.toMatch(/\bon\s+delete\b/i);
    // The reason is written down where the column is declared.
    expect(sql).toMatch(/article_id uuid not null,\s*-- [^\n]*NO FK/);
  });

  it("documents the table and names the migration", () => {
    expect(n).toMatch(/comment on table public\.weekly_words_sample is '/);
    const doc = literalsAfter(code, "comment on table public.weekly_words_sample is");
    expect(doc).toContain("migration 143");
    expect(doc).toContain("service_role only");
    expect(doc).toContain("weekly_words_sample_refresh");
    // no FK, so the comment says who removes the rows of a deleted article
    expect(doc).toContain("no longer exists");
  });
});

describe("143 weekly_words_sample: row level security and privileges", () => {
  it("enables row level security and has no policy", () => {
    expect(n).toContain("alter table public.weekly_words_sample enable row level security;");
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    expect(code).not.toMatch(/\bforce\s+row\s+level\b/i);
  });

  it("revokes every privilege from anon, authenticated and public, and the default grants from service_role", () => {
    expect(n).toContain("revoke all on public.weekly_words_sample from anon, authenticated, public;");
    expect(n).toContain("revoke all on public.weekly_words_sample from service_role;");
  });

  it("grants select on the table and execute on the function to service_role, and nothing else", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => norm(m[0]));
    expect(grants).toEqual([
      "grant select on public.weekly_words_sample to service_role;",
      `grant execute on function ${FN_SIG} to service_role;`,
    ]);
  });

  it("never grants anything to anon, authenticated or public, and adds no default privileges or sequence", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      const grantees = /\bto\s+([^;]*);/i.exec(m[0])?.[1] ?? "";
      expect(grantees.trim()).toBe("service_role");
    }
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    expect(code).not.toMatch(/\bsequence\b/i);
  });

  it("revokes before it grants, on the table and on the function", () => {
    expect(n.indexOf("revoke all on public.weekly_words_sample from service_role;")).toBeLessThan(
      n.indexOf("grant select on public.weekly_words_sample"),
    );
    expect(n.indexOf(`revoke all on function ${FN_SIG} from public, anon, authenticated;`)).toBeLessThan(
      n.indexOf("grant execute on function"),
    );
  });

  it("carries the PG17-guarded MAINTAIN revoke, equal to 140's block modulo the table name", () => {
    expect(n).toMatch(/do \$maint\$ begin if current_setting\('server_version_num'\)::int >= 170000 then/);
    expect(n).toContain("execute 'revoke maintain on public.weekly_words_sample from anon, authenticated';");
    const b140 = norm(readFileSync(MIGRATION_140, "utf8"));
    const blockOf = (s: string) => /do \$maint\$[\s\S]*?\$maint\$;/.exec(s)?.[0] ?? "";
    expect(blockOf(b140)).not.toBe("");
    expect(blockOf(n).replace("weekly_words_sample", "cluster_skip_log")).toBe(blockOf(b140));
  });

  it("revokes the function from public, anon and authenticated", () => {
    expect(n).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
  });
});

describe("143 weekly_words_sample: function signature", () => {
  it("creates or replaces exactly one function: weekly_words_sample_refresh(p_days integer default 2)", () => {
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
    expect(fnMatch).not.toBeNull();
    expect(fnArgs).toBe("p_days integer default 2");
  });

  it("returns integer, plpgsql, volatile, security definer, with an empty search_path and a lock_timeout", () => {
    expect(fnAttrs).toBe(
      "integer language plpgsql volatile security definer set search_path = '' set lock_timeout = '5s'",
    );
  });

  it("documents the function and names the migration", () => {
    expect(n).toMatch(/comment on function public\.weekly_words_sample_refresh\(integer\) is '/);
    const doc = literalsAfter(code, "comment on function public.weekly_words_sample_refresh(integer) is");
    expect(doc).toContain("migration 143");
    expect(doc).toContain("service_role only");
    expect(doc).toContain("p_days");
    expect(doc).toContain("1..14");
    expect(doc).toContain("no longer exists");
  });
});

describe("143 weekly_words_sample: function body", () => {
  it("clamps the day count to 1..14 with a null falling back to 2", () => {
    expect(body).toContain("v_days integer := least(greatest(coalesce(p_days, 2), 1), 14);");
  });

  it("anchors today on the Istanbul calendar, qualified with pg_catalog", () => {
    expect(body).toContain("v_today date := (pg_catalog.now() at time zone 'Europe/Istanbul')::date;");
  });

  it("takes a transaction-level advisory try-lock and skips with a notice when busy", () => {
    expect(body).toContain(
      "if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtext('weekly_words_sample_refresh')) then raise notice 'weekly_words_sample_refresh: busy, skipping'; return 0; end if;",
    );
    // before any write
    expect(body.indexOf("pg_try_advisory_xact_lock")).toBeLessThan(body.indexOf("delete from"));
  });

  it("walks v_days days back from today, newest first", () => {
    expect(body).toContain("for i in 0 .. v_days - 1 loop v_day := v_today - i;");
  });

  it("deletes the day, then inserts it again, inside the loop (delete-then-insert per day)", () => {
    const iLoop = body.indexOf("for i in 0 .. v_days - 1 loop");
    const iDelete = body.indexOf("delete from public.weekly_words_sample where day = v_day;");
    const iInsert = body.indexOf("insert into public.weekly_words_sample (day, zone, article_id, source_id, title, url, created_at)");
    const iEnd = body.indexOf("end loop;");
    expect(iLoop).toBeGreaterThanOrEqual(0);
    expect(iDelete).toBeGreaterThan(iLoop);
    expect(iInsert).toBeGreaterThan(iDelete);
    expect(iEnd).toBeGreaterThan(iInsert);
    expect([...body.matchAll(/insert into public\.weekly_words_sample\b/g)]).toHaveLength(1);
  });

  it("selects the sample columns the reader needs: day, zone, article id, source id, title, url, created_at", () => {
    expect(body).toContain(
      "select v_day, x.zone, x.id, x.source_id, x.title, x.url, x.created_at from (",
    );
    expect(body).toContain("select a.id, a.source_id, a.title, a.url, a.created_at, z.zone,");
  });

  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE (mirrors 071/092's parity check)", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*insert\s+into/i.exec(code);
    expect(span).not.toBeNull();
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = pairRe.exec((span as RegExpExecArray)[1] as string)) !== null) {
      parsed[m[1] as string] = m[2] as string;
      count += 1;
    }
    // No duplicated key hiding behind the record collapse.
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual(BIAS_TO_ZONE);
  });

  it("joins the zone map on sources.bias, and only active voting sources: s.kind in the VOTING_SOURCE_KINDS list", () => {
    expect(body).toContain(
      "from public.articles a join public.sources s on s.id = a.source_id join zmap z on z.bias_key = s.bias",
    );
    expect(body).toMatch(/\band s\.active\b/);
    const list = /\bs\.kind in \(([^)]*)\)/.exec(body)?.[1] ?? "";
    const kinds = [...list.matchAll(/'([a-z]+)'/g)].map((m) => m[1]);
    expect(kinds).toEqual([...VOTING_SOURCE_KINDS]);
  });

  it("keeps the WEEKLY_WORDS_PER_ZONE_PER_DAY smallest ids: 'rn <= N' equals the reader's constant, order by a.id", () => {
    const perZone = Number(/export const WEEKLY_WORDS_PER_ZONE_PER_DAY = (\d+);/.exec(reader)?.[1]);
    expect(perZone).toBe(300);
    const limit = Number(/\bx\.rn <= (\d+)\b/.exec(body)?.[1]);
    expect(limit).toBe(perZone);
    expect(body).toContain(
      "pg_catalog.row_number() over (partition by z.zone order by a.id) as rn",
    );
    // one window, partitioned by zone only: the day is fixed by the where clause
    expect([...body.matchAll(/\brow_number\s*\(/g)]).toHaveLength(1);
    expect(body).not.toMatch(/\border by (?!a\.id\b)[a-z_.]*random/);
    expect(body).not.toMatch(/\brandom\s*\(|\bhashtext\s*\(\s*a\./);
  });

  it("bounds the day by the Istanbul calendar day: [v_day 00:00, v_day+1 00:00) Europe/Istanbul", () => {
    expect(body).toContain(
      "where a.created_at >= (v_day::timestamp at time zone 'Europe/Istanbul') and a.created_at < ((v_day + 1)::timestamp at time zone 'Europe/Istanbul')",
    );
    // never the session's TimeZone
    expect(code).not.toMatch(/v_day\s*::\s*timestamptz/i);
    expect(code).not.toMatch(/\(\s*v_day\s*\+\s*\d+\s*\)\s*::\s*timestamptz/i);
  });

  it("keeps English-outlet, empty-title and horoscope rows in the sample (the builder drops them later)", () => {
    expect(body).not.toMatch(/\bslug\b/);
    expect(body).not.toMatch(/\btitle\s+(is\s+(not\s+)?null|<>|!=|=)/);
    expect(body).not.toMatch(/\bnot\s+like\b|\bilike\b|\blike\b|~/);
  });

  it("counts the rows it writes and returns the total", () => {
    expect(body).toContain("get diagnostics v_n = row_count; v_total := v_total + v_n; end loop;");
    expect(body).toMatch(/v_total integer := 0;/);
    expect(body).toMatch(/return v_total; end;?$/);
  });

  it("retains today and the 35 days before it, then drops older rows", () => {
    expect(body).toContain("delete from public.weekly_words_sample where day < v_today - 35;");
    // after the loop
    expect(body.indexOf("where day < v_today - 35")).toBeGreaterThan(body.indexOf("end loop;"));
  });

  it("sweeps the rows of the page window whose article is gone, after the loop: no FK, so a deleted article would otherwise stay on /hafta for days", () => {
    const sweep =
      "delete from public.weekly_words_sample w where w.day >= v_today - 6 and not exists (select 1 from public.articles a where a.id = w.article_id);";
    expect(body).toContain(sweep);
    expect([...body.matchAll(/\bnot exists\b/g)]).toHaveLength(1);
    // After the per-day loop (today and yesterday were just rebuilt from articles, days T-2..T-6 never are) ...
    expect(body.indexOf(sweep)).toBeGreaterThan(body.indexOf("end loop;"));
    // ... and before the function returns.
    expect(body.indexOf(sweep)).toBeLessThan(body.indexOf("return v_total;"));
  });

  it("the orphan sweep covers every day the page reads (WEEKLY_WORDS_DAYS - 1 days back) with primary-key lookups on articles.id", () => {
    expect(READER_DAYS).toBe(7);
    const back = Number(/where w\.day >= v_today - (\d+) and not exists/.exec(body)?.[1]);
    expect(back).toBe(READER_DAYS - 1);
    // an equality probe on articles.id (its primary key), not a scan or a new index
    expect(body).toContain("where a.id = w.article_id");
  });

  it("the orphan sweep does not count as rows written", () => {
    const sweepAt = body.indexOf("not exists");
    const diagnostics = [...body.matchAll(/get diagnostics/g)];
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.index).toBeLessThan(sweepAt);
  });

  it("qualifies every function and table name (empty search_path)", () => {
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bnow\s*\(/);
    expect(body).not.toMatch(/(?<!pg_catalog\.)\brow_number\s*\(/);
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bhashtext\s*\(/);
    expect(body).not.toMatch(/(?<!pg_catalog\.)\bpg_try_advisory_xact_lock\s*\(/);
    const tables = [...body.matchAll(/\b(?:from|join|into)\s+([a-z_][\w.]*)/gi)].map((m) => m[1]);
    for (const t of tables) {
      // zmap is the CTE; the rest are schema-qualified. `(` starts the derived table.
      expect(t === "zmap" || t.startsWith("public.")).toBe(true);
    }
  });

  it("the function reads only articles and sources and writes only weekly_words_sample", () => {
    const reads = [...body.matchAll(/\b(?:from|join)\s+(public\.[a-z_]+)/gi)].map((m) => m[1]);
    expect([...new Set(reads)].sort()).toEqual(["public.articles", "public.sources", "public.weekly_words_sample"]);
    const writes = [...body.matchAll(/\b(?:insert into|delete from|update)\s+([a-z_][\w.]*)/gi)].map((m) => m[1]);
    for (const w of writes) expect(w).toBe(TABLE);
    expect(body).not.toMatch(/\bupdate\b|\btruncate\b/);
  });
});

describe("143 weekly_words_sample: additive shape", () => {
  const bare = stripStrings(code);

  it("adds no index (the primary key serves the reader; no index on any large table)", () => {
    expect(bare).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(bare).not.toMatch(/\bconcurrently\b/i);
  });

  it("writes only weekly_words_sample (and the ledger): no other DML, no truncate, no update", () => {
    const inserts = [...bare.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["public.weekly_words_sample", "supabase_migrations.schema_migrations"]);
    const deletes = [...bare.matchAll(/\bdelete\s+from\s+([\w.]+)/gi)].map((m) => m[1]);
    // per-day rewrite, the orphan sweep, the 35-day retention
    expect(deletes).toEqual(["public.weekly_words_sample", "public.weekly_words_sample", "public.weekly_words_sample"]);
    expect(bare).not.toMatch(/\btruncate\b/i);
    expect(bare).not.toMatch(/^\s*update\b/im);
    expect(bare).not.toMatch(/\bupdate\s+(public|cron)\./i);
  });

  it("changes no existing object: no drop, and the only ALTER is the RLS switch of the new table", () => {
    expect(bare).not.toMatch(/\bdrop\s+(table|index|function|column|constraint|policy|trigger|view)\b/i);
    const alters = [...code.matchAll(/\balter\s+\w+[^;]*;/gi)].map((m) => norm(m[0]));
    expect(alters).toEqual(["alter table public.weekly_words_sample enable row level security;"]);
  });

  it("creates no trigger, view, extension or policy", () => {
    expect(bare).not.toMatch(/\bcreate\s+(trigger|view|materialized|extension|policy|sequence|type|schema)\b/i);
  });

  it("does not touch public.articles, public.sources or any cluster table other than by reading", () => {
    expect(bare).not.toMatch(/\b(insert\s+into|delete\s+from|update)\s+public\.(articles|sources|clusters|cluster_articles)\b/i);
    expect(bare).not.toMatch(/\balter\s+table\s+public\.(articles|sources|clusters)\b/i);
  });

  it("runs no backfill inside the migration (the operator does it, with a raised statement_timeout)", () => {
    expect(code).not.toMatch(/^\s*select\s+public\.weekly_words_sample_refresh/im);
    expect(code).not.toMatch(/^\s*perform\s+public\.weekly_words_sample_refresh/im);
  });
});

describe("143 weekly_words_sample: pg_cron job", () => {
  it("is one DO block that skips with a notice when pg_cron is not installed", () => {
    expect([...code.matchAll(/\bdo\s+\$cron\$/gi)]).toHaveLength(1);
    expect(cron).toContain("if not exists (select 1 from pg_catalog.pg_extension where extname = 'pg_cron') then");
    expect(cron).toContain(
      "raise notice '143: pg_cron missing, skipping the weekly-words-sample schedule.'; return; end if;",
    );
  });

  it("unschedules an existing job of the same name, then schedules it hourly at minute 38", () => {
    expect(cron).toContain(
      "if exists (select 1 from cron.job where jobname = 'weekly-words-sample') then perform cron.unschedule('weekly-words-sample'); end if;",
    );
    expect(cron).toContain("perform cron.schedule('weekly-words-sample', '38 * * * *',");
    expect(cron).toContain(
      "$sql$ set statement_timeout = '120s'; select public.weekly_words_sample_refresh(2); $sql$);",
    );
    const iSkip = cron.indexOf("pg_cron missing");
    const iUnsched = cron.indexOf("cron.unschedule");
    const iSched = cron.indexOf("cron.schedule");
    expect(iSkip).toBeGreaterThan(-1);
    expect(iUnsched).toBeGreaterThan(iSkip);
    expect(iSched).toBeGreaterThan(iUnsched);
  });

  it("names only weekly-words-sample in every cron call and lookup (no other job is touched)", () => {
    const calls = [...code.matchAll(/\bcron\.(schedule|unschedule|alter_job|schedule_in_database)\s*\(\s*'([^']+)'/gi)];
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c[2]).toBe("weekly-words-sample");
    const names = [...code.matchAll(/\bjobname\s*(?:=|in)\s*\(?\s*'([^']+)'/gi)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const nm of names) expect(nm).toBe("weekly-words-sample");
    expect(code).not.toMatch(/\bupdate\s+cron\./i);
    expect(code).not.toMatch(/\bdelete\s+from\s+cron\./i);
    expect(code).not.toMatch(/\bcron\.job_run_details\b/i);
  });

  it("refreshes today and yesterday, inside the function's 1..14 clamp", () => {
    const days = Number(/select public\.weekly_words_sample_refresh\((\d+)\);/.exec(cron)?.[1]);
    expect(days).toBe(2);
  });

  it("minute 38 collides with no other schedule in the migrations (35 is taken by cron-log-compact and clusters-vacuum)", () => {
    /** Minutes an hourly-or-finer schedule fires on, from the first cron field. */
    const minutes = (field: string): Set<number> => {
      const out = new Set<number>();
      for (const part of field.split(",")) {
        const m = /^(\*|\d+|\d+-\d+)(?:\/(\d+))?$/.exec(part);
        if (!m) continue;
        const step = m[2] ? Number(m[2]) : 1;
        let lo = 0;
        let hi = 59;
        if (m[1] !== "*") {
          const [a, b] = m[1]!.split("-");
          lo = Number(a);
          hi = b === undefined ? (m[2] ? 59 : lo) : Number(b);
        }
        for (let v = lo; v <= hi; v += step) out.add(v);
      }
      return out;
    };
    const clashes: string[] = [];
    for (const f of readdirSync(MIGRATIONS_DIR).filter((x) => x.endsWith(".sql") && x !== FILE)) {
      const text = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"));
      for (const m of text.matchAll(/cron\.schedule\(\s*'([^']+)'\s*,\s*'([^']+)'/g)) {
        const fields = m[2]!.split(/\s+/);
        // Only jobs pinned to fixed minutes of the hour; the every-N-minutes drains (*/2, */3, */5) share every slot.
        if ((fields[0] ?? "").startsWith("*")) continue;
        // ... and only those that run in more than one hour of the day.
        if (fields[1] !== "*" && !/^\*\/|^\d+-\d+\/|,/.test(fields[1] ?? "")) continue;
        if (minutes(fields[0] ?? "").has(38)) clashes.push(`${f}: ${m[1]} ${m[2]}`);
      }
    }
    expect(clashes).toEqual([]);
    expect(header).toMatch(/cron-log-compact/);
    expect(header).toMatch(/clusters-vacuum/);
  });
});

describe("143 weekly_words_sample: header documents the evidence and the way back", () => {
  it.each([
    ["WHY"],
    ["WHAT CHANGES"],
    ["EXPECTED SIZE"],
    ["STEP 0"],
    ["DRY RUNS \\(x2\\)"],
    ["DEPLOY"],
    ["VERIFY"],
    ["ROLLBACK"],
  ])("has a %s section", (label) => {
    expect(header).toMatch(new RegExp(`^-- ${label}`, "m"));
  });

  it("states the three documented differences from the old rolling slices", () => {
    expect(header).toMatch(/Istanbul calendar days/);
    expect(header).toMatch(/today \(partial\) plus the 6 previous days/);
    expect(header).toMatch(/Son 7 g/);
    expect(header).toMatch(/evaluated at refresh time/);
    expect(header).toMatch(/lag up to 1 h/);
  });

  it("states the expected size and that no index is added to a large table", () => {
    expect(header).toContain("32,400");
    expect(header).toMatch(/12 MB/);
    expect(header).toMatch(/1,800 rows/);
    expect(header).toMatch(/No index on any large table/);
  });

  it("explains why the sampling RPC was rejected and why there is no foreign key", () => {
    expect(header).toMatch(/4\.7 s/);
    expect(header).toMatch(/foreign key/i);
  });

  it("records the production STEP 0 findings: ledger, absence, cron slots, and the EXPLAIN of the inner select", () => {
    expect(header).toMatch(/to_regclass\('public\.weekly_words_sample'\)/);
    expect(header).toMatch(/to_regprocedure\('public\.weekly_words_sample_refresh\(integer\)'\)/);
    expect(header).toMatch(/cron\.job/);
    expect(header).toMatch(/Index Scan using idx_articles_created_at/);
    expect(header).toMatch(/Buffers: shared hit=\d+/);
    expect(header).toMatch(/Execution Time: [\d.]+ ms/);
    expect(header).toMatch(/iktidar/);
  });

  it("records both local dry runs, the second one skipping what exists and writing no ledger row", () => {
    expect(header).toMatch(/run 1/);
    expect(header).toMatch(/run 2/);
    expect(header).toContain("already exists, skipping");
    expect(header).toContain("INSERT 0 1");
    expect(header).toContain("INSERT 0 0");
    expect(header).toMatch(/Index Scan using weekly_words_sample_pkey/);
  });

  it("gives the exact rollback statements", () => {
    expect(header).toContain("select cron.unschedule('weekly-words-sample');");
    expect(header).toContain("drop function public.weekly_words_sample_refresh(integer);");
    expect(header).toContain("drop table public.weekly_words_sample;");
    expect(header).toContain("delete from supabase_migrations.schema_migrations where version = '143';");
  });

  it("documents the orphan sweep and why it exists next to the no-FK rationale", () => {
    expect(header).toMatch(/orphan sweep/i);
    expect(header).toMatch(/no longer exists/);
    expect(header).toMatch(/v_today - 6/);
  });

  it("has a TAKEDOWN section with the operator statement for an immediate removal and the cache tag", () => {
    expect(header).toMatch(/^-- TAKEDOWN/m);
    expect(header).toContain("delete from public.weekly_words_sample where article_id = '<id>';");
    expect(header).toContain("revalidateTag('weekly-words')");
  });

  it("gives the operator backfill statement and the deploy order", () => {
    expect(header).toContain("set statement_timeout = '120s'; select public.weekly_words_sample_refresh(8);");
    expect(header).toMatch(/PGRST205/);
  });
});

describe("143 weekly_words_sample: operator runbook in docs/migration-guide.md", () => {
  const guide = readFileSync(GUIDE, "utf8");
  const at = guide.search(/^## 143 /m);
  const rest = at < 0 ? "" : guide.slice(at + 4);
  const next = rest.search(/^## /m);
  /** The 143 section: from its heading to the next `## ` heading (or the end of the file). */
  const section = at < 0 ? "" : guide.slice(at, next < 0 ? undefined : at + 4 + next);

  it("has a 143 section", () => {
    expect(at).toBeGreaterThanOrEqual(0);
  });

  it("gives the takedown statements: delete the sample row by article id, then the weekly-words cache tag", () => {
    expect(section).toContain("delete from public.weekly_words_sample where article_id = '<id>';");
    expect(section).toContain('{"tags":["weekly-words"]}');
    expect(section).toContain("POST /api/revalidate");
  });

  it("states the apply, backfill and rollback statements of the migration", () => {
    expect(section).toContain("set statement_timeout = '120s'; select public.weekly_words_sample_refresh(8);");
    expect(section).toContain("select cron.unschedule('weekly-words-sample');");
    expect(section).toMatch(/orphan sweep/i);
  });
});

describe("143 weekly_words_sample: parity with src/lib/weekly/distinctive-words-query.ts", () => {
  const tableName = /export const WEEKLY_WORDS_SAMPLE_TABLE = "([^"]+)";/.exec(reader)?.[1];
  const selected = /\.select\(\s*"([^"]+)"\s*\)\s*\.gte\(\s*"day"/.exec(reader)?.[1];
  const days = Number(/export const WEEKLY_WORDS_DAYS = (\d+);/.exec(reader)?.[1]);

  it("reads the table this migration creates", () => {
    expect(tableName).toBe("weekly_words_sample");
    expect(TABLE).toBe(`public.${tableName}`);
  });

  it("selects only columns the table has, and every column the builder needs", () => {
    expect(selected).toBeDefined();
    const columns = selected!.split(",").map((c) => c.trim());
    const tableColumns = [...tableBody.matchAll(/(?:^|, )([a-z_]+) (?:date|text|uuid|timestamptz)\b/g)].map((m) => m[1]);
    for (const c of columns) expect(tableColumns, c).toContain(c);
    // id (as article_id), title, url, source_id, created_at: the WeeklyWordsArticleRow fields
    for (const c of ["article_id", "title", "url", "source_id", "created_at", "day"]) expect(columns).toContain(c);
  });

  it("filters and orders the reader by the primary key columns", () => {
    expect(reader).toMatch(/\.gte\("day"/);
    expect(reader).toMatch(/\.lte\("day"/);
    expect(reader).toMatch(/\.order\("day"\)\s*\.order\("zone"\)\s*\.order\("article_id"\)/);
    expect(tableBody).toContain("primary key (day, zone, article_id)");
  });

  it("retains more days than the page reads (WEEKLY_WORDS_DAYS), and the cron covers today and yesterday", () => {
    expect(days).toBe(7);
    const retained = 1 + Number(/where day < v_today - (\d+);/.exec(body)?.[1]);
    expect(retained).toBeGreaterThan(days);
  });

  it("the reader's module comment states the same three differences", () => {
    expect(reader).toMatch(/Istanbul calendar days?/);
    expect(reader).toMatch(/refresh time/);
    expect(reader).toMatch(/1 h/);
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE point at a THROWAWAY database with the shared stub schema
// (jevtest/qa/stub.sql: the three roles, public.sources, public.articles with
// title, url and created_at, supabase_migrations), service_role created with
// BYPASSRLS as Supabase has it, and 143 applied. Every check runs inside a
// transaction that is rolled back.
// ---------------------------------------------------------------------------
describe.runIf(Boolean(process.env.TAYF_PSQL))("143 against a live Postgres (143 applied)", () => {
  function psqlArgs(): string[] {
    return ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"];
  }
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, psqlArgs(), {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 16 * 1024 * 1024,
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

  /**
   * Seed: one source per zone (active, outlet), a wire source, a niche one and an inactive one;
   * for the Istanbul days today-2 .. today: 350 articles per zone on today-1 (the 300-row cut),
   * a few per zone elsewhere, rows exactly on both day boundaries, plus niche/inactive rows.
   */
  const SEED = `
insert into public.sources (id, slug, name, bias, active, kind) values
  ('00000000-0000-0000-0000-0000000000a1', 'gov', 'Gov', 'pro_government', true, 'outlet'),
  ('00000000-0000-0000-0000-0000000000a2', 'ind', 'Ind', 'center', true, 'wire'),
  ('00000000-0000-0000-0000-0000000000a3', 'opp', 'Opp', 'opposition', true, 'outlet'),
  ('00000000-0000-0000-0000-0000000000a4', 'niche', 'Niche', 'center', true, 'niche'),
  ('00000000-0000-0000-0000-0000000000a5', 'off', 'Off', 'opposition', false, 'outlet'),
  ('00000000-0000-0000-0000-0000000000a6', 'nobias', 'NoBias', null, true, 'outlet');
create temp table _today on commit drop as select (now() at time zone 'Europe/Istanbul')::date as d;
-- 350 rows per zone on yesterday, ids from md5 so they are not in insertion order
insert into public.articles (id, source_id, title, url, created_at)
select md5('y' || z.sid || g)::uuid, z.sid::uuid, 't ' || g, 'https://e.com/' || g,
       ((select d - 1 from _today)::timestamp at time zone 'Europe/Istanbul') + (g || ' minutes')::interval
  from (values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
               ('00000000-0000-0000-0000-0000000000a3')) z(sid), generate_series(1, 350) g;
-- today and the day before yesterday: 5 rows per zone
insert into public.articles (id, source_id, title, url, created_at)
select md5('d' || dd || z.sid || g)::uuid, z.sid::uuid, 't', null,
       ((select d - dd from _today)::timestamp at time zone 'Europe/Istanbul') + (g || ' minutes')::interval
  from (values ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'),
               ('00000000-0000-0000-0000-0000000000a3')) z(sid), (values (0), (2)) v(dd), generate_series(1, 5) g;
-- boundary rows with the smallest possible ids (so the 300-row cut keeps them): the opening instant of
-- yesterday (in yesterday), of today (in today), and one millisecond before today (still in yesterday)
insert into public.articles (id, source_id, title, created_at) values
  ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000000a1', 'open-yesterday', ((select d - 1 from _today)::timestamp at time zone 'Europe/Istanbul')),
  ('00000000-0000-0000-0000-00000000b002', '00000000-0000-0000-0000-0000000000a1', 'open-today', ((select d from _today)::timestamp at time zone 'Europe/Istanbul')),
  ('00000000-0000-0000-0000-00000000b003', '00000000-0000-0000-0000-0000000000a1', 'last-ms-yesterday', ((select d from _today)::timestamp at time zone 'Europe/Istanbul') - interval '1 millisecond');
-- never sampled: niche, inactive, no bias
insert into public.articles (id, source_id, title, created_at)
select md5('n' || s.sid || g)::uuid, s.sid::uuid, 'x', ((select d - 1 from _today)::timestamp at time zone 'Europe/Istanbul') + (g || ' minutes')::interval
  from (values ('00000000-0000-0000-0000-0000000000a4'), ('00000000-0000-0000-0000-0000000000a5'),
               ('00000000-0000-0000-0000-0000000000a6')) s(sid), generate_series(1, 20) g;
`;

  it("the ledger row, the table, its primary key and the function are there; no foreign key", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '143';").trim()).toBe("1");
    expect(runPsql(`select to_regclass('${TABLE}') is not null and to_regprocedure('${FN_SIG}') is not null;`).trim()).toBe("t");
    expect(
      runPsql(`select string_agg(column_name || ':' || data_type || ':' || is_nullable, ',' order by ordinal_position)
                 from information_schema.columns where table_schema = 'public' and table_name = 'weekly_words_sample';`).trim(),
    ).toBe(
      "day:date:NO,zone:text:NO,article_id:uuid:NO,source_id:uuid:NO,title:text:YES,url:text:YES,created_at:timestamp with time zone:NO",
    );
    expect(
      runPsql(`select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
                 from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
                where c.conrelid = '${TABLE}'::regclass and c.contype = 'p';`).trim(),
    ).toBe("day,zone,article_id");
    expect(runPsql(`select count(*) from pg_constraint where conrelid = '${TABLE}'::regclass and contype = 'f';`).trim()).toBe("0");
    expect(runPsql(`select count(*) from pg_indexes where schemaname = 'public' and tablename = 'weekly_words_sample';`).trim()).toBe("1");
  });

  it("rejects a zone outside the three Medya DNA zones", () => {
    expect(
      runPsqlError(
        `begin; insert into ${TABLE} (day, zone, article_id, source_id, created_at) values (current_date, 'merkez', gen_random_uuid(), gen_random_uuid(), now()); rollback;`,
      ),
    ).toMatch(/violates check constraint/);
  });

  it("RLS is on with no policy; anon and authenticated hold no privilege; service_role has select only; execute only for service_role", () => {
    expect(runPsql(`select relrowsecurity from pg_class where oid = '${TABLE}'::regclass;`).trim()).toBe("t");
    expect(runPsql("select count(*) from pg_policies where tablename = 'weekly_words_sample';").trim()).toBe("0");
    const privs = (role: string) =>
      runPsql(`select coalesce(string_agg(p, ',' order by p), '') from unnest(array['select','insert','update','delete','truncate','references','trigger']) p
                where has_table_privilege('${role}', '${TABLE}', p);`).trim();
    expect(privs("anon")).toBe("");
    expect(privs("authenticated")).toBe("");
    expect(privs("service_role")).toBe("select");
    expect(
      runPsql(`select has_function_privilege('anon', '${FN_SIG}', 'execute'), has_function_privilege('authenticated', '${FN_SIG}', 'execute'),
                      has_function_privilege('service_role', '${FN_SIG}', 'execute');`).trim(),
    ).toBe("f|f|t");
    expect(
      runPsql(`select prosecdef, provolatile, coalesce(array_to_string(proconfig, ';'), '') from pg_proc where oid = '${FN_SIG}'::regprocedure;`).trim(),
    ).toBe('t|v|search_path="";lock_timeout=5s');
  });

  for (const role of ["anon", "authenticated"]) {
    it(`${role} can neither read the table nor run the refresh`, () => {
      expect(runPsqlError(`begin; set local role ${role}; select count(*) from ${TABLE}; rollback;`)).toMatch(/permission denied for table weekly_words_sample/);
      expect(runPsqlError(`begin; set local role ${role}; select ${FN}(2); rollback;`)).toMatch(/permission denied for function weekly_words_sample_refresh/);
    });
  }

  it("service_role can read but not write the table, and can run the refresh", () => {
    expect(runPsql(`begin; set local role service_role; select count(*) from ${TABLE}; rollback;`).trim()).toMatch(/^\d+$/);
    for (const stmt of [
      `insert into ${TABLE} (day, zone, article_id, source_id, created_at) values (current_date, 'iktidar', gen_random_uuid(), gen_random_uuid(), now())`,
      `update ${TABLE} set title = 'x'`,
      `delete from ${TABLE}`,
      `truncate ${TABLE}`,
    ]) {
      expect(runPsqlError(`begin; set local role service_role; ${stmt}; rollback;`), stmt).toMatch(/permission denied for table weekly_words_sample/);
    }
    expect(runPsql(`begin; set local role service_role; select ${FN}(1) >= 0; rollback;`).trim()).toBe("t");
  });

  it("keeps the 300 smallest ids per zone and day, drops niche, inactive and bias-less sources, and is idempotent", () => {
    const out = runPsql(`
begin;
${SEED}
select 'ret', ${FN}(3);
create temp table _first on commit drop as select * from ${TABLE};
select 'first', count(*), md5(string_agg(day || zone || article_id::text, ',' order by day, zone, article_id)) from _first;
select ${FN}(3) is not null;
select 'same', (select count(*) from ${TABLE}) = (select count(*) from _first)
   and not exists (select * from ${TABLE} except select * from _first)
   and not exists (select * from _first except select * from ${TABLE});
-- yesterday: exactly 300 per zone, and they are the 300 smallest ids of that zone-day
select 'cell', zone, count(*) from ${TABLE} where day = (select d - 1 from _today) group by zone order by zone;
select 'smallest', bool_and(ok) from (
  select z.zone, (select array_agg(article_id order by article_id) from ${TABLE} t where t.day = (select d - 1 from _today) and t.zone = z.zone)
       = (select array_agg(id order by id) from (
            select a.id from public.articles a join public.sources s on s.id = a.source_id
             where s.bias = z.bias and s.active and s.kind in ('outlet', 'wire')
               and a.created_at >= ((select d - 1 from _today)::timestamp at time zone 'Europe/Istanbul')
               and a.created_at <  ((select d from _today)::timestamp at time zone 'Europe/Istanbul')
             order by a.id limit 300) q) as ok
    from (values ('iktidar', 'pro_government'), ('bagimsiz', 'center'), ('muhalefet', 'opposition')) z(zone, bias)) w;
select 'absent', count(*) from ${TABLE} where source_id in ('00000000-0000-0000-0000-0000000000a4', '00000000-0000-0000-0000-0000000000a5', '00000000-0000-0000-0000-0000000000a6');
-- the day boundaries: the opening instant belongs to its own day, one millisecond earlier to the day before
select 'open-yesterday', day = (select d - 1 from _today) from ${TABLE} where article_id = '00000000-0000-0000-0000-00000000b001';
select 'open-today', day = (select d from _today) from ${TABLE} where article_id = '00000000-0000-0000-0000-00000000b002';
select 'last-ms', day = (select d - 1 from _today) from ${TABLE} where article_id = '00000000-0000-0000-0000-00000000b003';
-- days with rows: today, yesterday, the day before yesterday
select 'days', string_agg(x::text, ',' order by x) from (select distinct day - (select d from _today) as x from ${TABLE}) q;
rollback;
`);
    const lines = out.split("\n");
    // yesterday 3 x 300, today 3 x 5 + the opening-instant row, two days ago 3 x 5: 931, whatever the clock says.
    expect(lines).toContain("ret|931");
    expect(lines.filter((l) => l.startsWith("first|")).map((l) => l.split("|")[1])).toEqual(["931"]);
    expect(lines).toContain("same|t");
    expect(lines.filter((l) => l.startsWith("cell|"))).toEqual(["cell|bagimsiz|300", "cell|iktidar|300", "cell|muhalefet|300"]);
    expect(lines).toContain("smallest|t");
    expect(lines).toContain("absent|0");
    expect(lines).toContain("open-yesterday|t");
    expect(lines).toContain("open-today|t");
    expect(lines).toContain("last-ms|t");
    expect(lines).toContain("days|-2,-1,0");
  });

  it("clamps p_days to 1..14 (null means 2) and deletes rows older than today minus 35", () => {
    const out = runPsql(`
begin;
insert into public.sources (id, slug, name, bias, active, kind) values ('00000000-0000-0000-0000-0000000000b1', 'g', 'G', 'pro_government', true, 'outlet');
create temp table _today on commit drop as select (now() at time zone 'Europe/Istanbul')::date as d;
insert into public.articles (id, source_id, title, created_at)
select md5('c' || g)::uuid, '00000000-0000-0000-0000-0000000000b1', 't', ((select d - g from _today)::timestamp at time zone 'Europe/Istanbul') + interval '12 hours'
  from generate_series(0, 20) g;
delete from ${TABLE};
select ${FN}(0); select 'zero', count(distinct day) from ${TABLE};
delete from ${TABLE}; select ${FN}(null); select 'null', count(distinct day) from ${TABLE};
delete from ${TABLE}; select ${FN}(1); select 'one', count(distinct day) from ${TABLE};
delete from ${TABLE}; select ${FN}(100); select 'cap', count(distinct day) from ${TABLE};
-- retention: a row 36 days back disappears, one 35 days back stays, on the next refresh
insert into ${TABLE} (day, zone, article_id, source_id, created_at) values
  ((select d - 36 from _today), 'iktidar', '00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000b1', now()),
  ((select d - 35 from _today), 'iktidar', '00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000b1', now());
select ${FN}(1);
select 'old', count(*) filter (where article_id = '00000000-0000-0000-0000-0000000000f6'), count(*) filter (where article_id = '00000000-0000-0000-0000-0000000000f5') from ${TABLE};
rollback;
`);
    const lines = out.split("\n");
    expect(lines).toContain("zero|1");
    expect(lines).toContain("null|2");
    expect(lines).toContain("one|1");
    expect(lines).toContain("cap|14");
    expect(lines).toContain("old|0|1");
  });

  it("sweeps the sample rows of a deleted article inside the page window (today and the 6 days before it), and only there", () => {
    const out = runPsql(`
begin;
insert into public.sources (id, slug, name, bias, active, kind) values ('00000000-0000-0000-0000-0000000000c1', 'g', 'G', 'pro_government', true, 'outlet');
create temp table _today on commit drop as select (now() at time zone 'Europe/Istanbul')::date as d;
-- one article on each of today .. today-10, plus a second one today that stays
insert into public.articles (id, source_id, title, created_at)
select md5('s' || g)::uuid, '00000000-0000-0000-0000-0000000000c1', 't', ((select d - g from _today)::timestamp at time zone 'Europe/Istanbul') + interval '12 hours'
  from generate_series(0, 10) g;
insert into public.articles (id, source_id, title, created_at)
values (md5('keep')::uuid, '00000000-0000-0000-0000-0000000000c1', 't', ((select d from _today)::timestamp at time zone 'Europe/Istanbul') + interval '13 hours');
delete from ${TABLE};
select 'fill', ${FN}(11);
-- takedown: today, yesterday, 4 and 6 days back (inside the page window), 7 and 9 days back (outside it)
delete from public.articles where id in (select md5('s' || g)::uuid from unnest(array[0, 1, 4, 6, 7, 9]) g);
-- refresh(1) rewrites today only: days 1..6 are reached by the sweep alone
select 'refresh', ${FN}(1);
select 'left', string_agg(((select d from _today) - day)::text, ',' order by day desc) from (select distinct day from ${TABLE}) q;
select 'gone', count(*) from ${TABLE} where article_id in (select md5('s' || g)::uuid from unnest(array[0, 1, 4, 6]) g);
select 'kept-today', count(*) from ${TABLE} where article_id = md5('keep')::uuid;
rollback;
`);
    const lines = out.split("\n");
    // today is rewritten from articles: the deleted one is gone, the second article stays (1 row written)
    expect(lines).toContain("refresh|1");
    // offsets 0 (the kept article), 2, 3 and 5 are untouched; 1, 4 and 6 are swept; 7 and 9 are outside
    // the window and are left to the 35-day retention.
    expect(lines).toContain("left|0,2,3,5,7,8,9,10");
    expect(lines).toContain("gone|0");
    expect(lines).toContain("kept-today|1");
  });

  it("the reader's query plan is an Index Scan on the primary key", () => {
    const plan = runPsql(`
begin;
insert into ${TABLE} (day, zone, article_id, source_id, created_at)
select current_date - (g % 36), (array['iktidar','bagimsiz','muhalefet'])[1 + g % 3], gen_random_uuid(), gen_random_uuid(), now()
  from generate_series(1, 32000) g;
analyze ${TABLE};
explain select day, article_id, source_id, title, url, created_at from ${TABLE}
 where day >= current_date - 6 and day <= current_date order by day, zone, article_id limit 1000;
rollback;
`);
    expect(plan).toMatch(/Index Scan using weekly_words_sample_pkey/);
  });
});
