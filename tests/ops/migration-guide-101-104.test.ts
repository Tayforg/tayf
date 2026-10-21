import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Docs contract for docs/migration-guide.md, migrations 101-104.
//
// AGENTS.md names the guide as the operator runbook. 101-104 carry ops-critical
// facts that, until this file existed, lived only in SQL header comments: the
// CONCURRENTLY pre-builds 101 needs (or it aborts with 57014), the IRREVERSIBLE
// nightly delete 102 schedules, the jev-shadow redeploy 103 needs, and the
// "do not press Seti dondur" warning 104 creates. Three older passages (081,
// 088) told the operator the opposite. This test pins that the sections exist,
// that the pre-build SQL in the guide is the SQL in the 101 header, and that
// the stale passages point at 102 / 104.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const GUIDE = readFileSync(resolve(ROOT, "docs", "migration-guide.md"), "utf8");
const MIG_101 = readFileSync(
  resolve(ROOT, "supabase", "migrations", "101_db_hot_paths.sql"),
  "utf8",
);
const MIG_102 = readFileSync(
  resolve(ROOT, "supabase", "migrations", "102_jev_shadow_retention.sql"),
  "utf8",
);

/** Text from the `## <num>` heading up to (not including) the next `## ` heading. */
function section(num: string): string {
  const head = new RegExp(`^## ${num}\\b.*$`, "m").exec(GUIDE);
  if (!head) return "";
  const bodyStart = head.index + head[0].length;
  const next = /^## /m.exec(GUIDE.slice(bodyStart));
  return GUIDE.slice(head.index, next ? bodyStart + next.index : undefined);
}

/** The paragraph (blank-line delimited block) of `text` containing `needle`. */
function paragraphWith(text: string, needle: string): string {
  return text.split(/\n\s*\n/).find((p) => p.includes(needle)) ?? "";
}

describe("migration-guide: sections 101-104 exist, in order", () => {
  it("has a heading for each of 101, 102, 103, 104 after 100", () => {
    const at = (n: string) => GUIDE.search(new RegExp(`^## ${n}\\b`, "m"));
    const [a100, a101, a102, a103, a104] = ["100", "101", "102", "103", "104"].map(at);
    expect(a100).toBeGreaterThan(-1);
    expect(a101).toBeGreaterThan(a100!);
    expect(a102).toBeGreaterThan(a101!);
    expect(a103).toBeGreaterThan(a102!);
    expect(a104).toBeGreaterThan(a103!);
  });
});

describe("migration-guide 101 (db hot paths)", () => {
  const s = section("101");

  it("carries every CONCURRENTLY pre-build statement from the 101 header, verbatim", () => {
    const stmts = [...MIG_101.matchAll(/^--\s+(create index concurrently if not exists .+;)\s*$/gm)].map(
      (m) => m[1]!,
    );
    // Exactly two: a third (clusters (updated_at desc) where is_blindspot)
    // would duplicate clusters_blindspot_recall_idx from 064.
    expect(stmts).toHaveLength(2);
    for (const stmt of stmts) expect(s).toContain(stmt);
  });

  it("warns against the duplicate 064 index and explains the 57014 abort", () => {
    expect(s).toContain("clusters_blindspot_recall_idx");
    expect(s).toContain("57014");
  });

  it("has the invalid-index check and the cron-log-compact kill switch", () => {
    expect(s).toContain("indisvalid");
    expect(s).toContain("update cron.job set active = false where jobname = 'cron-log-compact'");
  });
});

describe("migration-guide 102 (jev_shadow_predictions retention)", () => {
  const s = section("102");

  it("says the delete is irreversible and names the first day it can bite", () => {
    expect(s).toContain("IRREVERSIBLE");
    expect(s).toContain("2026-11-05");
    expect(s).toContain("04:50");
  });

  it("has the kill switch, the dry run and the yardstick back-fill", () => {
    expect(s).toContain("update cron.job set active = false where jobname = 'jev-shadow-prune'");
    expect(s).toContain("would_delete");
    expect(s).toContain("jev_topic7_yardstick_refresh(10)");
  });

  it("carries the dry-run SELECT from the 102 header verbatim", () => {
    const m = /^-- DRY-RUN BEGIN\n([\s\S]*?)^-- DRY-RUN END$/m.exec(MIG_102);
    expect(m).not.toBeNull();
    const sql = m![1]!
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/^-- /, ""))
      .join("\n");
    expect(sql).toContain("would_delete");
    expect(s).toContain(sql);
  });

  it("forbids a rollup refresh wider than the keep window and re-applying 081", () => {
    expect(s).toContain("jev_shadow_daily_refresh");
    expect(s).toMatch(/never[^.\n]*(keep window|re-apply 081)/i);
  });
});

describe("migration-guide 103 (jev-shadow stall check)", () => {
  const s = section("103");

  it("requires redeploying jev-shadow with --no-verify-jwt and names the 12th check", () => {
    expect(s).toContain("supabase functions deploy jev-shadow");
    expect(s).toContain("--no-verify-jwt");
    expect(s).toContain("jev_shadow_cron_failures_30m");
  });
});

describe("migration-guide 104 (regression freeze to 660)", () => {
  const s = section("104");

  it("names the first 660-article run and warns against Seti dondur", () => {
    expect(s).toContain("2026-10-25");
    expect(s).toContain("Seti dondur");
    expect(s).toContain("jev-regression-weekly");
    expect(s).toContain("720");
  });

  it("has the two verification queries", () => {
    expect(s).toContain("from public.jev_regression_items group by kind");
    expect(s).toContain("from public.jev_gold_set g where not exists");
  });
});

describe("migration-guide: older passages that 102 / 104 made wrong now point at them", () => {
  it('081 no longer says jev_shadow_predictions is "deliberately left alone" without 102', () => {
    const p = paragraphWith(section("081"), "deliberately left alone");
    expect(p).not.toBe("");
    expect(p).toContain("102");
  });

  it("081 backfill step warns that jev_shadow_daily_refresh(400) is unsafe once pruning started", () => {
    const step = paragraphWith(section("081"), "If the SQL editor times out");
    expect(step).toContain("102");
    expect(step).toMatch(/never|do not/i);
  });

  it("088 regression freeze runbook says 660 items needs 104 and Seti dondur is not the trigger", () => {
    const p = paragraphWith(section("088"), "Regression freeze runbook");
    expect(p).toContain("104");
    expect(p).toContain("Seti dondur");
  });
});
