import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 109 ("cron-stagger"): the two heavy
// recurring jobs move off the jev-shadow minutes (:x0) with a schedule-only
// cron.alter_job, so their commands are never re-typed (and can never drift).
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const sql = readFileSync(resolve(MIGRATIONS_DIR, "109_cron_stagger.sql"), "utf8");
const code = sql.replace(/--[^\n]*/g, "");

/** Minutes of the hour a simple 5-field cron minute spec fires on. */
function minutes(spec: string): number[] {
  const out = new Set<number>();
  for (const part of spec.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw ? Number(stepRaw) : 1;
    let lo: number;
    let hi: number;
    if (range === "*") [lo, hi] = [0, 59];
    else if (range.includes("-")) [lo, hi] = range.split("-").map(Number);
    else [lo, hi] = [Number(range), stepRaw ? 59 : Number(range)];
    for (let m = lo; m <= hi; m += step) out.add(m);
  }
  return [...out].sort((a, b) => a - b);
}

describe("109 cron stagger", () => {
  it("is one transaction and records itself in the ledger", () => {
    expect(code).toMatch(/^\s*begin;/m);
    expect(code).toMatch(/commit;\s*$/);
    expect(code).toMatch(/values \('109', '109_cron_stagger'\)\s+on conflict do nothing/);
  });

  it("changes schedules only: alter_job with schedule :=, never schedule/unschedule or a command", () => {
    expect(code).not.toMatch(/cron\.schedule\s*\(/i);
    expect(code).not.toMatch(/cron\.unschedule\s*\(/i);
    expect(code).not.toMatch(/command\s*:=/i);
    expect(code).toMatch(/cron\.alter_job\(v_job, schedule := '25 \* \* \* \*'\)/);
    expect(code).toMatch(/cron\.alter_job\(v_job, schedule := '15,45 \* \* \* \*'\)/);
  });

  it("targets the two jobs by name and skips cleanly without pg_cron or the job", () => {
    expect(code).toMatch(/jobname = 'trends-rollup-refresh'/);
    expect(code).toMatch(/jobname = 'articles-vacuum'/);
    expect(code).toMatch(/to_regclass\('cron\.job'\) is null/);
    expect((code.match(/if v_job is null then/g) ?? []).length).toBe(2);
  });

  it("the new slots never share a minute with jev-shadow (*/10)", () => {
    const jev = new Set(minutes("*/10"));
    for (const spec of ["25", "15,45"]) {
      for (const m of minutes(spec)) expect(jev.has(m)).toBe(false);
    }
    expect(minutes("15,45")).toEqual([15, 45]); // still every 30 min
    expect(minutes("25")).toEqual([25]); // still hourly
  });

  it("grants nothing and writes no table besides the ledger", () => {
    expect(code).not.toMatch(/\bgrant\b/i);
    expect(code).not.toMatch(/\b(update|delete|truncate|drop)\b/i);
  });
});
