import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { JEV_ADMISSION_POLICY } from "../../supabase/functions/_shared/cluster/politics-admission";
import {
  JEV_ADMISSION_VERDICTS,
  JEV_ADMISSION_OUTCOMES,
} from "../../src/lib/admin/jev-admission";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 089 ("ADMIT": Jev politics
// admission for the clusterer). Copied from the lead's validated
// 084_jev_politics_admission.sql with every "084" -> "089" and the
// JEV-A/083 dependency note bumped to 088 (083-087 belong to the
// audit-fix wave and must never appear literally in this file).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "089_jev_politics_admission.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 089_jev_politics_admission.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("is wrapped in a single transaction with a 5s lock_timeout", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'/i);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("carries the '089' ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'089'\s*,\s*'089_jev_politics_admission'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("never mentions the audit-fix wave migrations 083-087", () => {
    expect(code).not.toMatch(/\b08[3-7]\b/);
  });

  it("adds politics_admitted_at to public.articles with no DEFAULT", () => {
    const m = code.match(
      /alter\s+table\s+public\.articles\s+add\s+column\s+if\s+not\s+exists\s+politics_admitted_at\s+timestamptz\s*;/i,
    );
    expect(m, "politics_admitted_at column add must have no DEFAULT clause").not.toBeNull();
  });

  it("locks down jev_politics_admissions to service_role only, with RLS on", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.jev_politics_admissions\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.jev_politics_admissions\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
    expect(code).toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s+on\s+public\.jev_politics_admissions\s+to\s+service_role/i,
    );
  });

  it("the verdict and outcome CHECK lists equal the app-side constant arrays", () => {
    const verdictCheck = code.match(/review_verdict\s+text\s+check\s*\(\s*review_verdict\s+in\s*\(([^)]+)\)\)/i);
    expect(verdictCheck).not.toBeNull();
    const verdicts = (verdictCheck?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(verdicts).toEqual([...JEV_ADMISSION_VERDICTS]);

    const outcomeCheck = code.match(/outcome\s+text\s+check\s*\(\s*outcome\s+in\s*\(([^)]+)\)\)/i);
    expect(outcomeCheck).not.toBeNull();
    const outcomes = (outcomeCheck?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(outcomes).toEqual([...JEV_ADMISSION_OUTCOMES]);
  });

  it("all four functions are SECURITY DEFINER with search_path = ''", () => {
    for (const name of [
      "jev_politics_admission_claim",
      "jev_politics_admission_record",
      "jev_politics_admission_stats",
      "jev_politics_admission_rollback",
    ]) {
      const re = new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]{0,2000}?security\\s+definer\\s+set\\s+search_path\\s*=\\s*''`,
        "i",
      );
      expect(code, `${name} must be SECURITY DEFINER with search_path=''`).toMatch(re);
    }
  });

  it("revokes from anon/authenticated/public and grants execute to service_role for every function", () => {
    for (const sig of [
      "jev_politics_admission_claim(text, jsonb, jsonb, numeric, text, text[], interval, interval, integer)",
      "jev_politics_admission_record(uuid, text, uuid, real, integer, boolean, boolean, boolean, boolean)",
      "jev_politics_admission_stats(integer)",
      "jev_politics_admission_rollback(timestamptz, boolean)",
    ]) {
      const escaped = sig.replace(/[[\](){}.+*?^$|\\]/g, "\\$&").replace(/\s+/g, "\\s*");
      expect(code).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${escaped}\\s+from\\s+anon\\s*,\\s*authenticated\\s*,\\s*public`, "i"));
      expect(code).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${escaped}\\s+to\\s+service_role`, "i"));
    }
  });

  it("pins the claim function's owner to postgres", () => {
    expect(code).toMatch(
      /alter\s+function\s+public\.jev_politics_admission_claim\([\s\S]{0,400}?\)\s+owner\s+to\s+postgres/i,
    );
  });

  it("the claim function's defaults match JEV_ADMISSION_POLICY", () => {
    expect(code).toMatch(/p_min_politics\s+numeric\s+default\s+0\.9/i);
    expect(code).toMatch(/p_topic7\s+text\s+default\s+'politika'/i);
    expect(code).toMatch(
      /p_excluded_categories\s+text\[\]\s+default\s+array\['politika'\s*,\s*'son_dakika'\s*,\s*'dunya'\]/i,
    );
    expect(code).toMatch(/p_max_age\s+interval\s+default\s+interval\s+'6 hours'/i);
    expect(code).toMatch(/p_lookback\s+interval\s+default\s+interval\s+'90 minutes'/i);
    expect(code).toMatch(/p_limit\s+integer\s+default\s+20/i);

    expect(JEV_ADMISSION_POLICY.minPoliticsProb).toBe(0.9);
    expect(JEV_ADMISSION_POLICY.topic7Choice).toBe("politika");
    expect(JEV_ADMISSION_POLICY.excludedCategories).toEqual(["politika", "son_dakika", "dunya"]);
    expect(JEV_ADMISSION_POLICY.maxAgeHours).toBe(6);
    expect(JEV_ADMISSION_POLICY.lookbackMinutes).toBe(90);
    expect(JEV_ADMISSION_POLICY.maxClaimsPerDrain).toBe(20);
  });

  it("joins politics/topic7 predictions on the same call_id and uses least(published_at, created_at) freshness", () => {
    expect(code).toMatch(/\(t\.jev_answer\s*->>\s*'call_id'\)\s*=\s*\(p\.jev_answer\s*->>\s*'call_id'\)/i);
    expect(code).toMatch(/least\s*\(\s*a\.published_at\s*,\s*a\.created_at\s*\)/i);
  });

  it("never re-claims a rolled-back article and sends to cluster_work", () => {
    expect(code).toMatch(/rolled_back_at\s+is\s+not\s+null/i);
    expect(code).toMatch(/pgmq\.send\s*\(\s*'cluster_work'/i);
  });

  it("the rollback function calls cluster_unlink_article and defaults to a dry run", () => {
    expect(code).toMatch(/public\.cluster_unlink_article\s*\(/i);
    expect(code).toMatch(/p_dry_run\s+boolean\s+default\s+true/i);
  });

  it("carries no bias-to-zone CASE (iktidar/muhalefet stay out of the SQL layer)", () => {
    expect(code).not.toMatch(/'iktidar'/i);
    expect(code).not.toMatch(/'muhalefet'/i);
  });

  it("contains no DROP statement", () => {
    expect(code).not.toMatch(/\bdrop\s+/i);
  });

  it("is idempotent to read twice (add column if not exists / create or replace / on conflict do nothing)", () => {
    expect(sql).toMatch(/add\s+column\s+if\s+not\s+exists/i);
    expect(sql).toMatch(/create\s+table\s+if\s+not\s+exists/i);
    expect(sql).toMatch(/create\s+or\s+replace\s+function/i);
  });
});
