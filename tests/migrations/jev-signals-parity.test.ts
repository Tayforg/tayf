import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JEV_QUESTION_REGISTRY } from "../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Static parity test for migration 065_jev_signals.sql ("Sinyaller" paket:
// per-source drift, KAP class canary, archive labels). Copied verbatim from
// the planner's SQL (see W1.md), so this file does not re-derive or lint the
// SQL -- it only pins the vocabularies and thresholds that live in BOTH the
// migration's comments/CHECK constraints/functions and other files, so they
// can never drift silently.
//
// Cross-worker guards (pack.md "Risks to design against"):
//   SIG-A1 greps W3's src/lib/admin/jev-signals.ts (JEV_ALERT_KINDS).
//   SIG-A2 greps W2's supabase/functions/_shared/archive.ts
//     (ARCHIVE_LABEL_SOURCE / ARCHIVE_LABEL_TASKS).
// Both are EXPECTED RED until those workers land in this same worktree --
// do not weaken them, do not stub the files they read. This mirrors
// JEV-A17/JEV-A19 in tests/migrations/jev-shadow-parity.test.ts (the 063
// pack).
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const REPO_ROOT = resolve(__dirname, "..", "..");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

describe("migration 065_jev_signals.sql (static parity)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("065_jev_signals.sql");
    expect(sql.length).toBeGreaterThan(0);
  });

  it("contains the ledger insert for '065'", () => {
    expect(sql).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations[\s\S]*?values\s*\(\s*'065'\s*,\s*'065_jev_signals'\s*\)/i,
    );
  });

  it("is additive-only: no DROP TABLE/COLUMN and no ALTER TABLE on articles/clusters/sources/jev_shadow_predictions", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(articles|clusters|sources|jev_shadow_predictions)\b/i);
  });

  it("source_drift_daily and jev_alerts are service_role-only: RLS on, anon/authenticated/public revoked, sequence revoked", () => {
    for (const table of ["source_drift_daily", "jev_alerts"]) {
      expect(sql).toMatch(new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
    }
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+sequence\s+public\.jev_alerts_id_seq\s+from\s+anon,\s*authenticated,\s*public/i,
    );
  });

  it("all four new functions are SECURITY DEFINER with search_path = '' and revoked from anon/authenticated/public", () => {
    for (const fn of [
      "jev_source_drift_compute",
      "jev_kap_canary_compute",
      "jev_kap_canary_status",
      "kap_disclosure_signals_for",
    ]) {
      const fnMatch = sql.match(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn}\\([^)]*\\)[\\s\\S]*?\\$fn\\$;`, "i"),
      );
      expect(fnMatch, `could not find function public.${fn}`).not.toBeNull();
      const body = fnMatch![0];
      expect(body).toMatch(/security\s+definer/i);
      expect(body).toMatch(/set\s+search_path\s*=\s*''/i);
    }
    for (const fnSig of [
      "jev_source_drift_compute\\(date\\)",
      "jev_kap_canary_compute\\(date\\)",
      "jev_kap_canary_status\\(date\\)",
      "kap_disclosure_signals_for\\(bigint\\[\\]\\)",
    ]) {
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fnSig}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
    }
  });

  it("the jev_alerts kind CHECK list is exactly ['source_drift','kap_class_canary']", () => {
    const match = sql.match(/kind\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*kind\s+in\s*\(([^)]+)\)/i);
    expect(match, "could not find the jev_alerts.kind CHECK list").not.toBeNull();
    const values = (match![1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);
    expect(values).toEqual(["source_drift", "kap_class_canary"]);
  });

  it("schedules 'jev-signals-nightly' at '05 4 * * *' as a SQL-only job (no pg_net, no Vault, no net.http_post)", () => {
    expect(sql).toMatch(/cron\.schedule\(\s*'jev-signals-nightly'\s*,\s*'05 4 \* \* \*'/);
    expect(sql).toContain("select public.jev_source_drift_compute();");
    expect(sql).toContain("select public.jev_kap_canary_compute();");
    expect(sql).not.toMatch(/net\.http_post/);
    expect(sql).not.toMatch(/vault\.decrypted_secrets/);
    expect(sql).not.toMatch(/extname\s*=\s*'pg_net'/);
  });

  it("the unschedule guard makes the cron block idempotent", () => {
    expect(sql).toMatch(
      /if exists \(select 1 from cron\.job where jobname = 'jev-signals-nightly'\)[\s\S]*?perform cron\.unschedule\('jev-signals-nightly'\)/,
    );
  });

  it("copies no bias→zone map: 065 never mentions BIAS_TO_ZONE, iktidar, bagimsiz or muhalefet", () => {
    expect(sql).not.toContain("BIAS_TO_ZONE");
    expect(sql).not.toContain("iktidar");
    expect(sql).not.toContain("bagimsiz");
    expect(sql).not.toContain("muhalefet");
  });
});

describe("065 score-scale parity with JEV_QUESTION_REGISTRY", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("065_jev_signals.sql");
  });

  it("the sensational divisor 3.0 equals levels - 1 for the 4-level sensational question", () => {
    const levels = (JEV_QUESTION_REGISTRY.sensational.criteria as unknown[]).length;
    expect(levels).toBe(4);
    expect(sql).toContain("/ 3.0");
    expect(sql).toContain("divisor is levels - 1 = 3");
  });

  it("the kap_materiality level cut points match the 4-level score question", () => {
    expect((JEV_QUESTION_REGISTRY.kap_materiality.criteria as unknown[]).length).toBe(4);
    expect(sql).toContain("when m.jev_prob < 1 then 'düşük'");
    expect(sql).toContain("when m.jev_prob < 2 then 'orta'");
    expect(sql).toContain("else 'yüksek'");
  });

  it("the politics-share threshold 0.700 is the stricter of the two thresholds 063 already reports", () => {
    expect(sql).toContain("d.prob >= 0.700");
    expect(sql).toContain("b.prob >= 0.700");
  });
});

describe("065 numeric thresholds (day gate, baseline gate, per-term floors, drift/flag cutoffs, canary)", () => {
  let sql = "";
  beforeAll(() => {
    sql = read("065_jev_signals.sql");
  });

  it("gates the day's politics term at politics_n >= 20", () => {
    expect(sql).toContain("da.politics_n >= 20");
  });

  it("gates the baseline at base_n >= 60", () => {
    expect(sql).toContain("ba.base_n >= 60");
  });

  it("gates the clickbait and sensational drift terms at >= 20 same-task predictions that day", () => {
    expect(sql).toContain("da.clickbait_n >= 20");
    expect(sql).toContain("da.sensational_n >= 20");
  });

  it("flags a source at drift_score >= 3 or an absolute politics-share move >= 0.250", () => {
    expect(sql).toContain("coalesce(c.drift_score, 0) >= 3");
    expect(sql).toContain(">= 0.250");
  });

  it("floors every baseline sd at 0.05", () => {
    const floorCount = (sql.match(/0\.05\)/g) ?? []).length;
    expect(floorCount).toBeGreaterThanOrEqual(3);
  });

  it("the KAP canary requires kap_n >= 10 and a disagreement rate >= 0.10", () => {
    expect(sql).toContain(">= 10");
    expect(sql).toContain(">= 0.10");
  });
});

// ---------------------------------------------------------------------------
// SIG-A1 (CROSS-WORKER GUARD -- EXPECTED RED until W3 lands
// src/lib/admin/jev-signals.ts in this same worktree). Do NOT weaken it, do
// NOT stub src/lib/admin/jev-signals.ts.
// ---------------------------------------------------------------------------

describe("jev_alerts kind vocabulary (SIG-A1)", () => {
  it("src/lib/admin/jev-signals.ts's JEV_ALERT_KINDS equals migration 065's CHECK list", () => {
    const jevSignalsPath = resolve(REPO_ROOT, "src", "lib", "admin", "jev-signals.ts");
    const jevSignalsSrc = readFileSync(jevSignalsPath, "utf8");
    const match = jevSignalsSrc.match(/JEV_ALERT_KINDS\s*=\s*\[([^\]]*)\]/);
    expect(match, "could not find JEV_ALERT_KINDS literal in src/lib/admin/jev-signals.ts").not.toBeNull();
    const values = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(values).toEqual(["source_drift", "kap_class_canary"]);
  });
});

// ---------------------------------------------------------------------------
// SIG-A2 (CROSS-WORKER GUARD -- EXPECTED RED until W2 lands
// supabase/functions/_shared/archive.ts in this same worktree). Do NOT
// weaken, do NOT stub.
// ---------------------------------------------------------------------------

describe("archive label declaration (SIG-A2)", () => {
  it("ARCHIVE_LABEL_SOURCE in supabase/functions/_shared/archive.ts is the declared provenance string", () => {
    const archivePath = resolve(REPO_ROOT, "supabase", "functions", "_shared", "archive.ts");
    const archiveSrc = readFileSync(archivePath, "utf8");
    expect(archiveSrc).toContain('ARCHIVE_LABEL_SOURCE = "typesafe-ai/jev via jev-shadow"');
  });

  it("ARCHIVE_LABEL_TASKS covers exactly the five article-level tasks 065 measures drift over, plus framing", () => {
    const archivePath = resolve(REPO_ROOT, "supabase", "functions", "_shared", "archive.ts");
    const archiveSrc = readFileSync(archivePath, "utf8");
    const match = archiveSrc.match(/ARCHIVE_LABEL_TASKS\s*=\s*\[([^\]]*)\]/);
    expect(match, "could not find ARCHIVE_LABEL_TASKS literal in supabase/functions/_shared/archive.ts").not.toBeNull();
    const values = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    expect(values).toEqual(["politics", "topic", "clickbait", "framing", "sensational"]);
  });
});
