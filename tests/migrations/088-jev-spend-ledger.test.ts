import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  JEV_LEDGER_STAGE_KEYS,
  JEV_MONTHLY_TOKEN_CAP_DEFAULT,
} from "../../supabase/functions/_shared/jev.ts";
import { JEV_ALERT_KINDS, JEV_ALERT_RESOLVED_REASONS } from "../../src/lib/admin/jev-signals";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 088 ("Jev spend ledger, KAP
// sampling, per-task question fingerprints"): a copy of the lead's validated
// 083_jev_spend_ledger.sql, renumbered to 088, with the 073 day+1 drift_quiet
// guard restored and a lock_timeout added (see jev-specs.md §4). In the
// 072-framing-draw-fast.test.ts style: parse the file as text, never execute
// it -- the PG dry-run in the report covers execution.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "088_jev_spend_ledger.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("migration 088_jev_spend_ledger.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("contains the ledger insert for '088'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'088'\s*,\s*'088_jev_spend_ledger'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is a single begin/commit transaction", () => {
    const begins = code.match(/^\s*begin\s*;/gim) ?? [];
    const commits = code.match(/\bcommit\s*;/gi) ?? [];
    expect(begins.length).toBe(1);
    expect(commits.length).toBe(1);
    expect(code).toMatch(/^\s*begin\s*;/i);
    expect(code.trim()).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("sets lock_timeout before the ALTER TABLEs", () => {
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'/i);
  });

  it("guards on 073 being applied first (resolved_at column + jev_alerts_auto_resolve function)", () => {
    expect(code).toMatch(/information_schema\.columns/i);
    expect(code).toMatch(/resolved_at/i);
    expect(code).toMatch(/pg_proc/i);
    expect(code).toMatch(/jev_alerts_auto_resolve/i);
    expect(code).toMatch(/raise\s+exception/i);
  });

  it("never mentions 083, 084, 085, 086 or 087 anywhere, comments included", () => {
    expect(sql).not.toMatch(/\b08[3-7]\b/);
  });

  it("has no DROP TABLE/COLUMN/FUNCTION/INDEX other than the two re-added kind/reason CHECK constraints", () => {
    expect(code).not.toMatch(/\bdrop\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+column\b/i);
    expect(code).not.toMatch(/\bdrop\s+function\b/i);
    expect(code).not.toMatch(/\bdrop\s+index\b/i);
    const dropConstraints = code.match(/drop\s+constraint\s+if\s+exists\s+(\w+)/gi) ?? [];
    const names = dropConstraints.map((m) => m.replace(/.*if\s+exists\s+/i, "").trim());
    expect(names.sort()).toEqual(["jev_alerts_kind_check", "jev_alerts_resolved_reason_check"].sort());
    // Each dropped constraint is re-added.
    expect(code).toMatch(/add\s+constraint\s+jev_alerts_kind_check/i);
    expect(code).toMatch(/add\s+constraint\s+jev_alerts_resolved_reason_check/i);
  });

  it("the only ALTER TABLEs touch jev_shadow_runs (stage_tokens) and jev_alerts (the two constraints)", () => {
    const alters = code.match(/alter\s+table\s+public\.(\w+)/gi) ?? [];
    const tables = new Set(alters.map((m) => m.replace(/alter\s+table\s+public\./i, "").trim().toLowerCase()));
    for (const t of tables) {
      expect(["jev_shadow_runs", "jev_alerts", "jev_stage_budgets"]).toContain(t);
    }
    expect(code).toMatch(/alter\s+table\s+public\.jev_shadow_runs\s+add\s+column\s+if\s+not\s+exists\s+stage_tokens/i);
  });

  it("every create or replace function is security definer with set search_path = ''", () => {
    const fnBlocks = code.match(/create\s+or\s+replace\s+function[\s\S]*?\$fn\$[\s\S]*?\$fn\$\s*;/gi) ?? [];
    expect(fnBlocks.length).toBeGreaterThan(0);
    for (const block of fnBlocks) {
      expect(norm(block)).toContain("security definer");
      expect(norm(block)).toContain("set search_path = ''");
    }
  });

  it("revokes from public/anon/authenticated and grants to service_role for the four 088 functions", () => {
    for (const sig of [
      "jev_shadow_month_usage(bigint)",
      "jev_budget_daily(integer)",
      "jev_stage_budget_compute(date)",
      "jev_alerts_auto_resolve(date)",
    ]) {
      const escaped = sig.replace(/[()]/g, (c) => `\\${c}`);
      expect(code).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${escaped}`, "i"));
      expect(code).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${escaped}\\s+to\\s+service_role`, "i"));
    }
  });

  it("the kind CHECK equals JEV_ALERT_KINDS", () => {
    const m = code.match(/jev_alerts_kind_check\s*\n?\s*check\s*\(\s*kind\s+in\s*\(([^)]+)\)/i);
    expect(m).not.toBeNull();
    const values = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(values).toEqual([...JEV_ALERT_KINDS]);
  });

  it("the resolved_reason CHECK list equals JEV_ALERT_RESOLVED_REASONS", () => {
    const m = code.match(/resolved_reason\s+in\s*\(([^)]+)\)/i);
    expect(m).not.toBeNull();
    const values = (m?.[1] ?? "").split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(values).toEqual([...JEV_ALERT_RESOLVED_REASONS]);
  });

  it("the seed stage set covers every JEV_LEDGER_STAGE_KEYS entry plus live_pair_marginal", () => {
    const insertMatch = code.match(/insert\s+into\s+public\.jev_stage_budgets[\s\S]*?on\s+conflict\s*\(stage\)\s*do\s+nothing/i);
    expect(insertMatch).not.toBeNull();
    const block = insertMatch![0];
    for (const key of [...JEV_LEDGER_STAGE_KEYS, "live_pair_marginal"]) {
      expect(block).toContain(`'${key}'`);
    }
  });

  it("the live pair_marginal term matches in both month_usage and budget_daily", () => {
    const monthUsage = functionBlock(code, "jev_shadow_month_usage");
    const budgetDaily = functionBlock(code, "jev_budget_daily");
    const re = /task\s*=\s*'pair_marginal'\s+and\s+p\.run_id\s+is\s+null/i;
    expect(monthUsage).toMatch(re);
    expect(budgetDaily).toMatch(re);
  });

  it("month_usage's default cap equals JEV_MONTHLY_TOKEN_CAP_DEFAULT", () => {
    expect(code).toContain(`p_cap bigint default ${JEV_MONTHLY_TOKEN_CAP_DEFAULT}`);
  });

  it("schedules jev-budget-nightly at 04:15 UTC behind the pg_cron guard", () => {
    expect(code).toMatch(/pg_cron/i);
    expect(code).toMatch(/jev-budget-nightly/);
    expect(code).toMatch(/'15\s+4\s+\*\s+\*\s+\*'/);
  });

  it("resolver step (a) reads question_hash and never reads ->> 'question_set'", () => {
    const fn = functionBlock(code, "jev_alerts_auto_resolve");
    const b = body(fn);
    expect(b).toMatch(/->>\s*'question_hash'/);
    expect(b).not.toMatch(/->>\s*'question_set'/);
  });

  it("resolver steps (b)+(c) are byte-identical (whitespace-normalised) to 073's", () => {
    const fn088 = functionBlock(code, "jev_alerts_auto_resolve");
    const b088 = body(fn088);

    const code073 = stripComments(read(resolve(MIGRATIONS_DIR, "073_jev_pipeline_lifecycle.sql")));
    const fn073 = functionBlock(code073, "jev_alerts_auto_resolve");
    const b073 = body(fn073);

    const extractBC = (b: string): string => {
      const start = b.indexOf("with recent as (");
      expect(start, "could not find 'with recent as (' in function body").toBeGreaterThanOrEqual(0);
      // Last occurrence of the v_total accumulation line, which closes step (c).
      const marker = "v_total := v_total + v_rows;";
      const lastIdx = b.lastIndexOf(marker);
      expect(lastIdx, "could not find the last v_total accumulation line").toBeGreaterThanOrEqual(0);
      const end = lastIdx + marker.length;
      return b.slice(start, end);
    };

    expect(norm(extractBC(b088))).toBe(norm(extractBC(b073)));
  });

  it("the day+1 existence guard (d1) is present in step (c) -- the lead's regression this migration fixes", () => {
    const fn = functionBlock(code, "jev_alerts_auto_resolve");
    const b = body(fn);
    expect(b).toMatch(/d1\.source_id::text\s*=\s*a\.subject/i);
    expect(b).toMatch(/d1\.day\s*=\s*a\.day\s*\+\s*1/i);
  });
});
