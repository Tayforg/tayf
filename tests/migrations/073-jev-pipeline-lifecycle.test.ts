import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { JEV_ALERT_RESOLVED_REASONS } from "../../src/lib/admin/jev-signals";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 073 ("jev-pipeline"): the /konu
// window widening, the jev_alerts lifecycle (resolved_at/resolved_reason +
// jev_alerts_auto_resolve), and jev_source_drift_compute's sensational-term
// removal + 2-consecutive-day gate. Modelled on
// tests/migrations/072-framing-draw-fast.test.ts's stripComments /
// functionBlock / header / body helpers.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "073_jev_pipeline_lifecycle.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` block. */
function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
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

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("migration 073_jev_pipeline_lifecycle.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let fn073Drift = "";
  let fn065Drift = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    fn073Drift = functionBlock(code, "jev_source_drift_compute");
    fn065Drift = functionBlock(
      stripComments(read(resolve(MIGRATIONS_DIR, "065_jev_signals.sql"))),
      "jev_source_drift_compute",
    );
  });

  it("contains the ledger insert for '073'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'073'\s*,\s*'073_jev_pipeline_lifecycle'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive-only: no DROP, TRUNCATE, DELETE, and the only ALTER TABLE is on jev_alerts", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    const alters = code.match(/\balter\s+table\s+public\.(\w+)/gi) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const a of alters) {
      expect(a.toLowerCase()).toContain("jev_alerts");
    }
  });

  it("never writes the word 'iktidar', anywhere, including comments", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });

  it("reschedules cluster-topics-refresh at 36 hours on the 067 cadence, without recreating the function", () => {
    expect(code).toMatch(/cluster_topics_refresh\s*\(\s*interval\s*'36 hours'\s*\)/i);
    expect(code).toMatch(/'3-59\/10 \* \* \* \*'/);
    expect(code).not.toMatch(/create\s+or\s+replace\s+function\s+public\.cluster_topics_refresh/i);
  });

  it("includes the one-off 7-day cluster_topics_refresh backfill", () => {
    expect(code).toMatch(/select\s+public\.cluster_topics_refresh\s*\(\s*interval\s*'7 days'\s*\)\s*;/i);
  });

  it("jev_source_drift_compute's header is identical to 065's (normalised)", () => {
    expect(norm(header(fn073Drift))).toBe(norm(header(fn065Drift)));
  });

  it("drift_score's greatest(...) no longer contains a sensational term", () => {
    const b = body(fn073Drift);
    const m = b.match(/as\s+drift_score/i);
    expect(m).not.toBeNull();
    const greatestBlock = b.slice(0, b.search(/as\s+drift_score/i));
    const start = greatestBlock.lastIndexOf("greatest(");
    const scoreExpr = b.slice(start, b.search(/as\s+drift_score/i));
    expect(scoreExpr).not.toMatch(/sensational/i);
  });

  it("sensational_mean is still computed and stored (not deleted from the row/baseline)", () => {
    const b = body(fn073Drift);
    expect(b).toMatch(/sensational_mean/i);
    expect(b).toMatch(/x\.sensational_mean/i);
  });

  it("the alerted CTE requires the source flagged on p_day - 1 too", () => {
    const b = body(fn073Drift);
    expect(b).toMatch(
      /join\s+public\.source_drift_daily\s+prev\s+on\s+prev\.source_id\s*=\s*x\.source_id\s+and\s+prev\.day\s*=\s*p_day\s*-\s*1\s+and\s+prev\.flagged/i,
    );
    expect(b).toMatch(/where\s+x\.flagged/i);
  });

  it("the alerted payload drops the sensational keys and adds previous_day_drift_score / consecutive_days", () => {
    const b = body(fn073Drift);
    const alertedIdx = b.search(/alerted\s+as\s*\(/i);
    expect(alertedIdx).toBeGreaterThan(-1);
    const alertedBlock = b.slice(alertedIdx);
    expect(alertedBlock).not.toMatch(/'sensational_mean'/);
    expect(alertedBlock).not.toMatch(/'baseline_sensational_mean'/);
    expect(alertedBlock).toMatch(/'previous_day_drift_score'\s*,\s*prev\.drift_score/i);
    expect(alertedBlock).toMatch(/'consecutive_days'\s*,\s*2/i);
  });

  it("jev_alerts_auto_resolve is a SECURITY DEFINER function with empty search_path, has revoke/grant, and the documented arithmetic", () => {
    const fn = functionBlock(code, "jev_alerts_auto_resolve");
    const h = header(fn);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);

    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.jev_alerts_auto_resolve\s*\(\s*date\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.jev_alerts_auto_resolve\s*\(\s*date\s*\)\s+to\s+service_role\s*;/i,
    );

    const b = body(fn);
    expect(b).toMatch(/2\.5/);
    expect(b).toMatch(/a\.day\s*\+\s*2/);
    expect(b).toMatch(/kap_n\s*>=\s*10/);
    expect(b).not.toMatch(/acknowledged_at\s*=/i);
  });

  it("drift_quiet requires a source_drift_daily row to exist at day+1 too, not just day+2 (a gap on day+1 must not vacuously resolve as quiet)", () => {
    const fn = functionBlock(code, "jev_alerts_auto_resolve");
    const b = body(fn);
    // Section (c), drift_quiet: must prove data exists for BOTH
    // intervening days before trusting the NOT EXISTS "clean" check --
    // otherwise a skipped/failed nightly run on day+1 is indistinguishable
    // from a genuinely quiet day+1.
    const drift = b.slice(b.indexOf("drift_quiet"));
    expect(drift).toMatch(/d1\.day\s*=\s*a\.day\s*\+\s*1/i);
    expect(drift).toMatch(/d2\.day\s*=\s*a\.day\s*\+\s*2/i);
  });

  it("compares source_id to subject as text, never casting subject to uuid", () => {
    const fn = functionBlock(code, "jev_alerts_auto_resolve");
    const b = body(fn);
    expect(b).toMatch(/d\.source_id::text\s*=\s*a\.subject/i);
    expect(b).not.toMatch(/a\.subject::uuid/i);
  });

  it("the CHECK reason list matches JEV_ALERT_RESOLVED_REASONS", () => {
    expect(JEV_ALERT_RESOLVED_REASONS).toEqual(["question_set_changed", "agreement_recovered", "drift_quiet"]);
    const m = code.match(/resolved_reason\s+in\s*\(([^)]+)\)/i);
    expect(m).not.toBeNull();
    const reasons = (m?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(reasons).toEqual([...JEV_ALERT_RESOLVED_REASONS]);
  });

  it("adds resolved_at/resolved_reason columns additively and a partial open-alerts index", () => {
    expect(code).toMatch(/alter\s+table\s+public\.jev_alerts\s+add\s+column\s+if\s+not\s+exists\s+resolved_at\s+timestamptz/i);
    expect(code).toMatch(/add\s+column\s+if\s+not\s+exists\s+resolved_reason\s+text/i);
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+jev_alerts_open_idx\s+on\s+public\.jev_alerts\s*\(\s*created_at\s+desc\s*\)\s*where\s+acknowledged_at\s+is\s+null\s+and\s+resolved_at\s+is\s+null/i,
    );
  });

  it("reschedules jev-signals-nightly at the same time, holding all 3 selects in order", () => {
    const m = code.match(/cron\.schedule\('jev-signals-nightly',\s*'05 4 \* \* \*',\s*\$sql\$([\s\S]*?)\$sql\$/i);
    expect(m).not.toBeNull();
    const jobBody = m?.[1] ?? "";
    const idxDrift = jobBody.search(/jev_source_drift_compute\s*\(\s*\)/i);
    const idxKap = jobBody.search(/jev_kap_canary_compute\s*\(\s*\)/i);
    const idxResolve = jobBody.search(/jev_alerts_auto_resolve\s*\(\s*\)/i);
    expect(idxDrift).toBeGreaterThan(-1);
    expect(idxKap).toBeGreaterThan(idxDrift);
    expect(idxResolve).toBeGreaterThan(idxKap);
  });

  it("includes the one-off do-block resolving stale alerts with today as p_day", () => {
    expect(code).toMatch(/jev_alerts_auto_resolve\s*\(\s*\(\s*pg_catalog\.now\(\)\s+at\s+time\s+zone\s+'utc'\s*\)::date\s*\)/i);
  });
});
