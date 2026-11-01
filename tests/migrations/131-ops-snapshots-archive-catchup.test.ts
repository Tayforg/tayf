import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ARCHIVE_CATCHUP_MAX_WINDOW_DAYS,
  ARCHIVE_CATCHUP_WINDOW_DAYS,
  catchupWindow,
} from "../../supabase/functions/_shared/archive-window.ts";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 131 ("ops-snapshots-archive-catchup").
//
// Two silent failures of 2026-10/11 (hunt 10):
//   h10-silent-1  the GitHub '*/30' heartbeat ran on ~12% of its schedule
//                 (100 runs in 17 days, median gap 4.1 h), so every
//                 30-minute-window check of ops_health_report() missed any
//                 incident that fell between two runs. Detection must not depend
//                 on GitHub's scheduler: pg_cron snapshots the non-pass rows
//                 every 10 minutes, and the heartbeat pages once on every
//                 unnotified FAIL snapshot it finds.
//   h10-silent-2  the nightly archive export only ever exports "yesterday";
//                 2026-10-12..17 were never exported and nothing flagged it. A
//                 second pg_cron job posts {"catchup":true} and the function
//                 re-exports the oldest missing day in a 40 day window.
//
// This file pins: the table (RLS on, no policy, every anon/authenticated/public
// privilege revoked, the PG17-guarded MAINTAIN revoke), the four service_role-
// only SECURITY DEFINER functions, the two pg_cron jobs, the ledger row, and the
// parity between the SQL window and _shared/archive-window.ts / the heartbeat.
// Nothing here needs a database: the behavioural proof is the local PG15 dry
// run described in the migration header.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATION_131 = resolve(ROOT, "supabase", "migrations", "131_ops_snapshots_archive_catchup.sql");
const MIGRATION_060 = resolve(ROOT, "supabase", "migrations", "060_archive_exports.sql");
const HEARTBEAT_LIB = resolve(ROOT, "scripts", "lib", "ops-heartbeat.mjs");

/** Comments removed (131 keeps `--` out of every string literal on purpose). */
function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Whitespace removed entirely: a layout-proof way to compare SQL fragments. */
function sq(sql: string): string {
  return sql.replace(/\s+/g, "");
}

/** Whitespace collapsed to single spaces. */
function collapse(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

function functionBlock(code: string, name: string): string {
  const m = new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\b[\\s\\S]*?\\$fn\\$\\s*;`, "i").exec(code);
  expect(m, `create or replace function public.${name}`).not.toBeNull();
  return (m as RegExpExecArray)[0];
}

function cronCommand(code: string, jobName: string): string {
  const m = new RegExp(`cron\\.schedule\\(\\s*'${jobName}'\\s*,\\s*'([^']+)'\\s*,\\s*\\$sql\\$([\\s\\S]*?)\\$sql\\$\\s*\\)`, "i").exec(code);
  expect(m, `cron.schedule('${jobName}', ...)`).not.toBeNull();
  return collapse((m as RegExpExecArray)[2] as string);
}

function cronSchedule(code: string, jobName: string): string {
  const m = new RegExp(`cron\\.schedule\\(\\s*'${jobName}'\\s*,\\s*'([^']+)'`, "i").exec(code);
  expect(m, `cron.schedule('${jobName}', ...)`).not.toBeNull();
  return (m as RegExpExecArray)[1] as string;
}

let raw = "";
let code = "";

beforeAll(() => {
  expect(existsSync(MIGRATION_131), "supabase/migrations/131_ops_snapshots_archive_catchup.sql").toBe(true);
  raw = readFileSync(MIGRATION_131, "utf8");
  code = stripSqlComments(raw);
});

describe("131: header and shape", () => {
  it("documents WHY, the Step 0 numbers, the cost, the deadline, VERIFY and ROLLBACK", () => {
    for (const needle of ["WHY", "STEP 0", "COST", "DEADLINE", "VERIFY", "ROLLBACK", "2026-11-20", "2026-10-12"]) {
      expect(raw, needle).toContain(needle);
    }
  });

  it("is one transaction, additive: no drop, no truncate, no alter of an existing table", () => {
    expect(code).toMatch(/^\s*begin\s*;/i);
    expect(code).toMatch(/commit\s*;\s*$/i);
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\balter\s+table\b(?![^;]*\benable\s+row\s+level\s+security\b)/i);
  });

  it("ends with the schema_migrations ledger row in the 095 pattern, then commit", () => {
    expect(sq(code)).toContain(
      sq(`insert into supabase_migrations.schema_migrations (version, name)
        values ('131', '131_ops_snapshots_archive_catchup')
        on conflict do nothing;`),
    );
    expect(code.indexOf("schema_migrations")).toBeLessThan(code.search(/commit\s*;\s*$/i));
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });

  it("does NOT redefine ops_health_report()", () => {
    expect(code).not.toMatch(/create\s+(?:or\s+replace\s+)?function\s+public\.ops_health_report\b/i);
  });

  it("holds no secret-looking literal (the cron command reads the vault at run time)", () => {
    expect(raw).not.toContain("eyJ");
    expect(raw).not.toContain("Bearer ey");
    expect(raw).not.toContain("sb_secret");
  });
});

describe("131: public.ops_health_snapshots", () => {
  it("has the pinned columns and constraints", () => {
    const s = sq(code);
    expect(s).toContain("createtableifnotexistspublic.ops_health_snapshots(");
    for (const col of [
      "idbigintgeneratedalwaysasidentityprimarykey",
      "taken_attimestamptznotnulldefaultnow()",
      "check_nametextnotnull",
      "statustextnotnullcheck(statusin('warn','fail','unknown'))",
      "observednumeric",
      "thresholdnumeric",
      "detailtext",
      "notified_attimestamptz",
    ]) {
      expect(s, col).toContain(col);
    }
  });

  it("does not let notified_at, observed, threshold or detail be NOT NULL", () => {
    const s = sq(code);
    for (const col of ["notified_attimestamptznotnull", "observednumericnotnull", "thresholdnumericnotnull", "detailtextnotnull"]) {
      expect(s, col).not.toContain(col);
    }
  });

  it("indexes taken_at", () => {
    expect(sq(code)).toMatch(/createindexifnotexists\w+onpublic\.ops_health_snapshots(?:usingbtree)?\(taken_at\)/);
  });

  it("enables RLS and creates no policy", () => {
    expect(sq(code)).toContain("altertablepublic.ops_health_snapshotsenablerowlevelsecurity;");
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("revokes every privilege from anon, authenticated and public", () => {
    expect(collapse(code)).toContain("revoke all on public.ops_health_snapshots from anon, authenticated, public;");
  });

  it("revokes the identity sequence from them too", () => {
    expect(collapse(code)).toContain("revoke all on sequence public.ops_health_snapshots_id_seq from anon, authenticated, public;");
  });

  it("carries the PG17-guarded MAINTAIN revoke (105 pattern)", () => {
    const m = /do\s+\$maint\$([\s\S]*?)\$maint\$\s*;/i.exec(code);
    expect(m, "do $maint$ block").not.toBeNull();
    const body = collapse((m as RegExpExecArray)[1] as string);
    expect(body).toContain("current_setting('server_version_num')::int >= 170000");
    expect(body).toContain("execute 'revoke maintain on public.ops_health_snapshots from anon, authenticated'");
  });

  it("grants nothing to anon, authenticated or public anywhere (static or dynamic)", () => {
    const offenders: string[] = [];
    for (const piece of code.split(";")) {
      const stmt = piece.replace(/\s+/g, " ").trim();
      const m = /\bgrant\b[\s\S]*?\bto\b([\s\S]*)$/i.exec(stmt);
      if (!m) continue;
      const roles = (m[1] as string).toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
      if (roles.some((r) => ["anon", "authenticated", "public"].includes(r))) offenders.push(stmt);
    }
    expect(offenders).toEqual([]);
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
  });

  it("grants no table privilege to anyone (only the SECURITY DEFINER functions touch the table)", () => {
    expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(?:table\s+)?public\.ops_health_snapshots\b/i);
  });
});

describe("131: functions", () => {
  const FUNCS = [
    { name: "ops_health_snapshot", args: "" },
    { name: "ops_health_unnotified", args: "interval" },
    { name: "ops_health_mark_notified", args: "bigint[]" },
    { name: "ops_archive_gap_days", args: "integer" },
  ] as const;

  // Full RegExp escape (backslash included) for the literal argument list.
  const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (const f of FUNCS) {
    describe(f.name, () => {
      it("is SECURITY DEFINER with an empty search_path", () => {
        const block = functionBlock(code, f.name);
        expect(block).toMatch(/\bsecurity\s+definer\b/i);
        expect(block).toMatch(/\bset\s+search_path\s*=\s*''/i);
      });

      it("is revoked from public, anon and authenticated and granted to service_role only", () => {
        const sig = `public\\.${f.name}\\s*\\(\\s*${escapeRegExp(f.args)}\\s*\\)`;
        expect(code).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${sig}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`, "i"));
        expect(code).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${sig}\\s+to\\s+service_role\\s*;`, "i"));
      });

      it("references no unqualified relation or function of its own schema (empty search_path)", () => {
        const block = functionBlock(code, f.name);
        expect(block).not.toMatch(/\b(?:from|join|into|update)\s+ops_health_snapshots\b/i);
        expect(block).not.toMatch(/\b(?:from|join)\s+archive_exports\b/i);
      });
    });
  }

  describe("ops_health_snapshot() returns integer", () => {
    it("takes an advisory transaction lock, inserts the non-pass rows of the report and prunes at 3 days", () => {
      const block = functionBlock(code, "ops_health_snapshot");
      const s = sq(block);
      expect(s).toContain("returnsinteger");
      expect(block).toMatch(/pg_(?:try_)?advisory_xact_lock\s*\(/i);
      expect(s).toContain("insertintopublic.ops_health_snapshots(check_name,status,observed,threshold,detail)");
      expect(s).toContain("frompublic.ops_health_report()");
      expect(s).toContain("status in('warn','fail','unknown')".replace(/\s+/g, ""));
      expect(s).toContain("deletefrompublic.ops_health_snapshots");
      expect(block).toMatch(/taken_at\s*<\s*(?:pg_catalog\.)?now\(\)\s*-\s*interval\s*'3 days'/i);
    });

    it("never stores a pass or skip row", () => {
      const block = functionBlock(code, "ops_health_snapshot");
      expect(block).not.toMatch(/'pass'/i);
      expect(block).not.toMatch(/'skip'/i);
    });
  });

  describe("ops_health_unnotified(p_since interval default interval '24 hours')", () => {
    it("returns the pinned columns", () => {
      const block = functionBlock(code, "ops_health_unnotified");
      const s = sq(block);
      expect(s).toContain("ops_health_unnotified(p_sinceintervaldefaultinterval'24hours')".replace(/\s+/g, ""));
      expect(s).toContain(
        "returnstable(idbigint,taken_attimestamptz,check_nametext,statustext,observednumeric,thresholdnumeric,detailtext)",
      );
    });

    it("returns only unnotified FAIL rows inside min(p_since, 3 days), oldest first, at most 200", () => {
      const block = functionBlock(code, "ops_health_unnotified");
      expect(block).toMatch(/\.status\s*=\s*'fail'/i);
      expect(block).toMatch(/\.notified_at\s+is\s+null/i);
      expect(block).toMatch(/\.taken_at\s*>=\s*(?:pg_catalog\.)?now\(\)\s*-\s*least\(\s*p_since\s*,\s*interval\s*'3 days'\s*\)/i);
      expect(block).toMatch(/order\s+by\s+\w+\.taken_at/i);
      expect(block).toMatch(/limit\s+200\b/i);
    });

    it("never selects warn or unknown rows for paging", () => {
      const block = functionBlock(code, "ops_health_unnotified");
      expect(block).not.toMatch(/'warn'/i);
      expect(block).not.toMatch(/'unknown'/i);
    });
  });

  describe("ops_health_mark_notified(p_ids bigint[]) returns integer", () => {
    it("raises above 1000 ids and updates only rows that are not yet notified", () => {
      const block = functionBlock(code, "ops_health_mark_notified");
      const s = sq(block);
      expect(s).toContain("returnsinteger");
      expect(block).toMatch(/cardinality\s*\(\s*p_ids\s*\)\s*>\s*1000/i);
      expect(block).toMatch(/raise\s+exception/i);
      expect(block).toMatch(/update\s+public\.ops_health_snapshots/i);
      expect(block).toMatch(/set\s+notified_at\s*=\s*(?:pg_catalog\.)?now\(\)/i);
      expect(block).toMatch(/\bnotified_at\s+is\s+null\b/i);
      expect(block).toMatch(/\bid\s*=\s*any\s*\(\s*p_ids\s*\)/i);
    });
  });

  describe("ops_archive_gap_days(p_days integer default 40)", () => {
    it("is stable and returns (missing_days integer, oldest_missing date)", () => {
      const block = functionBlock(code, "ops_archive_gap_days");
      const s = sq(block);
      expect(s).toContain("ops_archive_gap_days(p_daysintegerdefault40)");
      expect(s).toContain("returnstable(missing_daysinteger,oldest_missingdate)");
      expect(block).toMatch(/\bstable\b/i);
    });

    it("uses the UTC calendar day, the window [today - p_days, today - 2] and the first ledger day as its clamp", () => {
      const block = functionBlock(code, "ops_archive_gap_days");
      expect(block).toMatch(/at\s+time\s+zone\s+'utc'/i);
      expect(block).toMatch(/\btoday\s*-\s*2\b/i);
      expect(block).toMatch(/\btoday\s*-\s*\w+\.n\b/i);
      expect(block).toMatch(/min\s*\(\s*\w+\.day\s*\)/i);
      expect(block).toMatch(/public\.archive_exports/i);
      expect(block).toMatch(/\bgreatest\b/i);
    });
  });
});

describe("131: pg_cron jobs", () => {
  it("schedules and unschedules exactly the two jobs this migration owns", () => {
    const names = [...code.matchAll(/cron\.(?:un)?schedule\(\s*'([^']+)'/gi)].map((m) => m[1]);
    expect([...new Set(names)].sort()).toEqual(["archive-export-catchup", "ops-health-snapshot"]);
    // schedule + unschedule per job, nothing else (no alter_job, no unschedule by id)
    expect(names).toHaveLength(4);
    expect(code).not.toMatch(/cron\.alter_job/i);
    expect(code).not.toMatch(/cron\.unschedule\(\s*(?!')/i);
  });

  it("unschedules each job first when it exists (idempotent reschedule)", () => {
    for (const job of ["ops-health-snapshot", "archive-export-catchup"]) {
      const re = new RegExp(
        `if\\s+exists\\s*\\(\\s*select\\s+1\\s+from\\s+cron\\.job\\s+where\\s+jobname\\s*=\\s*'${job}'\\s*\\)\\s+then\\s+perform\\s+cron\\.unschedule\\('${job}'\\)\\s*;\\s*end\\s+if`,
        "i",
      );
      expect(code, job).toMatch(re);
      expect(code.search(re), `${job} unschedule before schedule`).toBeLessThan(
        code.search(new RegExp(`cron\\.schedule\\(\\s*'${job}'`, "i")),
      );
    }
  });

  it("ops-health-snapshot: every 10 minutes at :x4, statement_timeout 60s, then the snapshot function", () => {
    expect(cronSchedule(code, "ops-health-snapshot")).toBe("4-59/10 * * * *");
    expect(cronCommand(code, "ops-health-snapshot")).toBe("set statement_timeout = '60s'; select public.ops_health_snapshot();");
  });

  it("ops-health-snapshot is skipped with a notice when pg_cron is absent", () => {
    expect(code).toMatch(/extname\s*=\s*'pg_cron'/i);
    expect(raw).toMatch(/raise\s+notice\s+'131: pg_cron missing/i);
  });

  it("archive-export-catchup: 05:12 UTC daily (off jev-shadow's :x0 minutes)", () => {
    expect(cronSchedule(code, "archive-export-catchup")).toBe("12 5 * * *");
  });

  it("archive-export-catchup posts 060's archive-export command with only the body changed", () => {
    const m060 = /cron\.schedule\(\s*'archive-export'\s*,\s*'[^']+'\s*,\s*\$sql\$([\s\S]*?)\$sql\$\s*\)/i.exec(
      stripSqlComments(readFileSync(MIGRATION_060, "utf8")),
    );
    expect(m060, "060's archive-export command").not.toBeNull();
    const original = collapse((m060 as RegExpExecArray)[1] as string);
    expect(original).toContain("body := '{}'::jsonb");
    const expected = original.replace("body := '{}'::jsonb", `body := '{"catchup":true}'::jsonb`);
    expect(cronCommand(code, "archive-export-catchup")).toBe(expected);
  });

  it("archive-export-catchup is guarded on pg_cron, pg_net and both vault secrets (060 pattern)", () => {
    expect(code).toMatch(/extname\s*=\s*'pg_net'/i);
    expect(code).toMatch(/vault\.decrypted_secrets\s+where\s+name\s*=\s*'service_role_key'/i);
    expect(code).toMatch(/vault\.decrypted_secrets\s+where\s+name\s*=\s*'functions_base_url'/i);
    expect(raw).toMatch(/raise\s+notice\s+'131: pg_cron\/pg_net missing/i);
    expect(raw).toMatch(/raise\s+notice\s+'131: Vault secrets missing/i);
  });
});

describe("131: parity with the callers", () => {
  it("SQL default p_days equals ARCHIVE_CATCHUP_WINDOW_DAYS", () => {
    const m = /ops_archive_gap_days\s*\(\s*p_days\s+integer\s+default\s+(\d+)\s*\)/i.exec(code);
    expect(m, "default p_days").not.toBeNull();
    expect(Number((m as RegExpExecArray)[1])).toBe(ARCHIVE_CATCHUP_WINDOW_DAYS);
  });

  it("SQL clamp equals ARCHIVE_CATCHUP_MAX_WINDOW_DAYS (and the lower bound 2, and the NULL fallback 40)", () => {
    const block = functionBlock(code, "ops_archive_gap_days");
    const upper = /,\s*(\d+)\s*\)\s*as\s+n\b/i.exec(block);
    expect(upper, "least(..., <max>) as n").not.toBeNull();
    expect(Number((upper as RegExpExecArray)[1])).toBe(ARCHIVE_CATCHUP_MAX_WINDOW_DAYS);
    const lower = /greatest\s*\(\s*coalesce\s*\(\s*p_days\s*,\s*(\d+)\s*\)\s*,\s*(\d+)\s*\)/i.exec(block);
    expect(lower, "greatest(coalesce(p_days, <default>), <min>)").not.toBeNull();
    expect(Number((lower as RegExpExecArray)[1])).toBe(ARCHIVE_CATCHUP_WINDOW_DAYS);
    expect(Number((lower as RegExpExecArray)[2])).toBe(2);
    // The TS side refuses exactly the values the SQL clamps.
    expect(() => catchupWindow(new Date("2026-11-05T05:12:00Z"), 1)).toThrow(RangeError);
    expect(() => catchupWindow(new Date("2026-11-05T05:12:00Z"), ARCHIVE_CATCHUP_MAX_WINDOW_DAYS + 1)).toThrow(RangeError);
  });

  it("SQL window end ('today - 2') equals catchupWindow's `to`", () => {
    const now = new Date("2026-11-05T05:12:00Z");
    expect(catchupWindow(now, ARCHIVE_CATCHUP_WINDOW_DAYS).to).toBe("2026-11-03"); // today(11-05) - 2
    const block = functionBlock(code, "ops_archive_gap_days");
    expect(block).toMatch(/\btoday\s*-\s*2\b/i);
  });

  it("scripts/lib/ops-heartbeat.mjs: ARCHIVE_GAP_EDGE_DAYS === 40 - 7 (the nightly catch-up needs at least 7 nights)", () => {
    const text = readFileSync(HEARTBEAT_LIB, "utf8");
    const edge = /export\s+const\s+ARCHIVE_GAP_EDGE_DAYS\s*=\s*(\d+)\s*;/.exec(text);
    const fail = /export\s+const\s+ARCHIVE_GAP_FAIL_COUNT\s*=\s*(\d+)\s*;/.exec(text);
    expect(edge, "ARCHIVE_GAP_EDGE_DAYS").not.toBeNull();
    expect(fail, "ARCHIVE_GAP_FAIL_COUNT").not.toBeNull();
    expect(Number((fail as RegExpExecArray)[1])).toBe(7);
    expect(Number((edge as RegExpExecArray)[1])).toBe(ARCHIVE_CATCHUP_WINDOW_DAYS - Number((fail as RegExpExecArray)[1]));
    expect(Number((edge as RegExpExecArray)[1])).toBe(33);
  });
});
