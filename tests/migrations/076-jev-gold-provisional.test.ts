import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { JEV_GOLD_TOPICS } from "@/lib/admin/jev-gold";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 076 ("gold-seed": provisional
// labeler 0 from the paid Opus labels + "Anlaşmazlıklar önce").
//
// The gold set (063) has 304 rows and 0 human labels; jev_gold_labels.labeler
// stays restricted to (1, 2). 076 adds a NEW table (labeler 0, purely
// additive) plus three SECURITY DEFINER functions so the human queue can be
// re-ordered to surface the ~54 provisional/Jev disagreements first, without
// ever mixing a model label into jev_gold_scorecard() or the 1|2 contract
// that jev_gold_labels, the route, and attention.ts all depend on.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "076_jev_gold_provisional.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create table if not exists public.<name> ( ... );` block. */
function tableBlock(sql: string, name: string): string {
  const re = new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+public\\.${name}\\s*\\([\\s\\S]*?\\)\\s*;`, "i");
  const m = sql.match(re);
  if (!m) throw new Error(`table ${name} not found`);
  return m[0];
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

function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

describe("migration 076_jev_gold_provisional.sql (SQL contract)", () => {
  let raw = "";
  let sql = "";
  let code = "";
  let tableSql = "";
  let fnImport = "";
  let fnNext = "";
  let fnScorecard = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    raw = read(path);
    sql = raw;
    code = stripComments(sql);
    tableSql = tableBlock(code, "jev_gold_provisional_labels");
    fnImport = functionBlock(code, "jev_gold_import_provisional");
    fnNext = functionBlock(code, "jev_gold_next_prioritized");
    fnScorecard = functionBlock(code, "jev_gold_provisional_scorecard");
  });

  it("contains the ledger insert for '076'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'076'\s*,\s*'076_jev_gold_provisional'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive only: no DROP, TRUNCATE, DELETE or UPDATE", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
  });

  it("never ALTER TABLEs jev_gold_labels or jev_gold_set", () => {
    expect(code).not.toMatch(/\balter\s+table\s+public\.jev_gold_labels\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.jev_gold_set\b/i);
    // ALTER TABLE is only legal here to enable RLS on the NEW table.
    const alters = code.match(/\balter\s+table\s+public\.\w+/gi) ?? [];
    for (const a of alters) {
      expect(a.toLowerCase()).toBe("alter table public.jev_gold_provisional_labels");
    }
  });

  it("never inserts into jev_gold_labels", () => {
    expect(code).not.toMatch(/insert\s+into\s+public\.jev_gold_labels\b/i);
  });

  it("does not redefine jev_gold_scorecard in 076", () => {
    expect(code).not.toMatch(/function\s+public\.jev_gold_scorecard\s*\(/i);
  });

  it("the raw file never contains 'iktidar'", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  describe("public.jev_gold_provisional_labels", () => {
    it("has RLS enabled", () => {
      expect(code).toMatch(/alter\s+table\s+public\.jev_gold_provisional_labels\s+enable\s+row\s+level\s+security\s*;/i);
    });

    it("revokes from anon/authenticated/public", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+public\.jev_gold_provisional_labels\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
    });

    it("grants SELECT only to service_role", () => {
      const grantLines = code.match(/grant\s+[^;]*on\s+public\.jev_gold_provisional_labels\s+to\s+[^;]+;/gi) ?? [];
      expect(grantLines).toHaveLength(1);
      expect(grantLines[0]).toMatch(/^grant\s+select\s+on\s+public\.jev_gold_provisional_labels\s+to\s+service_role\s*;$/i);
    });

    it("labeler is CHECK-restricted to 0 (default 0)", () => {
      expect(tableSql).toMatch(/labeler\s+smallint\s+not\s+null\s+default\s+0\s+check\s*\(\s*labeler\s*=\s*0\s*\)/i);
    });

    it("article_id references jev_gold_set with cascade delete", () => {
      expect(tableSql).toMatch(
        /article_id\s+uuid\s+primary\s+key\s+references\s+public\.jev_gold_set\s*\(\s*article_id\s*\)\s+on\s+delete\s+cascade/i,
      );
    });

    it("topic CHECK list deep-equals JEV_GOLD_TOPICS from src/lib/admin/jev-gold.ts", () => {
      const m = tableSql.match(/topic\s+text\s+not\s+null\s*\n?\s*check\s*\(\s*topic\s+in\s*\(([^)]+)\)\s*\)/i);
      expect(m).not.toBeNull();
      const topics = m![1]
        .split(",")
        .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""));
      expect(topics).toEqual([...JEV_GOLD_TOPICS]);
    });
  });

  describe("public.jev_gold_import_provisional", () => {
    it("has the topic CHECK list deep-equal to JEV_GOLD_TOPICS in its validation", () => {
      const b = body(fnImport);
      const m = b.match(/r\.topic\s+not\s+in\s*\(([^)]+)\)/i);
      expect(m).not.toBeNull();
      const topics = m![1]
        .split(",")
        .map((s) => s.trim().replace(/^'/, "").replace(/'$/, ""));
      expect(topics).toEqual([...JEV_GOLD_TOPICS]);
    });

    it("is SECURITY DEFINER with an empty search_path", () => {
      const h = header(fnImport);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    });

    it("takes the same advisory lock key as jev_gold_seed (063)", () => {
      expect(body(fnImport)).toMatch(/pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtext\s*\(\s*'jev_gold_seed'\s*\)\s*\)/i);
    });

    it("has two ON CONFLICT (article_id) DO NOTHING clauses", () => {
      const matches = body(fnImport).match(/on\s+conflict\s*\(\s*article_id\s*\)\s+do\s+nothing/gi) ?? [];
      expect(matches.length).toBe(2);
    });

    it("caps input at 2000 rows", () => {
      expect(body(fnImport)).toMatch(/jsonb_array_length\s*\(\s*p_rows\s*\)\s*>\s*2000/i);
    });

    it("defaults p_stratum to 'opus_seed'", () => {
      expect(header(fnImport)).toMatch(/p_stratum\s+text\s+default\s+'opus_seed'/i);
    });

    it("re-asserts the grants: revoked from anon/authenticated/public, execute to service_role only", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.jev_gold_import_provisional\s*\(\s*jsonb\s*,\s*text\s*,\s*text\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      const grants = code.match(/grant\s+execute\s+on\s+function\s+public\.jev_gold_import_provisional\s*\([^)]*\)\s+to\s+[^;]+;/gi) ?? [];
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatch(/to\s+service_role\s*;/i);
    });
  });

  describe("public.jev_gold_next_prioritized", () => {
    it("returns gold_position, never position, as an output column", () => {
      const h = header(fnNext);
      expect(h).toMatch(/\bgold_position\s+int\b/i);
      expect(h).not.toMatch(/returns\s+table\s*\([^)]*\bposition\s+int\b/i);
    });

    it("is SECURITY DEFINER with an empty search_path", () => {
      const h = header(fnNext);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    });

    it("the 0.5 disagreement threshold matches JEV_PROVISIONAL_THRESHOLD", () => {
      expect(body(fnNext)).toMatch(/jev_p\s*>=\s*0\.5/i);
    });

    it("re-asserts the grants: revoked from anon/authenticated/public, execute to service_role only", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.jev_gold_next_prioritized\s*\(\s*smallint\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      const grants = code.match(/grant\s+execute\s+on\s+function\s+public\.jev_gold_next_prioritized\s*\([^)]*\)\s+to\s+[^;]+;/gi) ?? [];
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatch(/to\s+service_role\s*;/i);
    });
  });

  describe("public.jev_gold_provisional_scorecard", () => {
    it("is SECURITY DEFINER with an empty search_path", () => {
      const h = header(fnScorecard);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    });

    it("re-asserts the grants: revoked from anon/authenticated/public, execute to service_role only", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.jev_gold_provisional_scorecard\s*\(\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      const grants = code.match(/grant\s+execute\s+on\s+function\s+public\.jev_gold_provisional_scorecard\s*\([^)]*\)\s+to\s+[^;]+;/gi) ?? [];
      expect(grants).toHaveLength(1);
      expect(grants[0]).toMatch(/to\s+service_role\s*;/i);
    });

    it("never reads jev_gold_labels directly without going through a 'human' alias (still comparison-only, not a write)", () => {
      // Sanity: the scorecard only ever selects from jev_gold_labels, never writes to it.
      expect(body(fnScorecard)).not.toMatch(/insert\s+into\s+public\.jev_gold_labels/i);
      expect(body(fnScorecard)).not.toMatch(/update\s+public\.jev_gold_labels/i);
    });
  });
});
