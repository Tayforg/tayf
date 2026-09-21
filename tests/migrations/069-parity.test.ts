import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  HEADLINE_ELIGIBILITY_CLICKBAIT_MAX_SHARE,
  HEADLINE_ELIGIBILITY_CLICKBAIT_MIN_PROB,
  HEADLINE_ELIGIBILITY_POLITICS_MIN_PROB,
  HEADLINE_ELIGIBILITY_POLITICS_SOLO_MIN_PROB,
} from "@/lib/headline/eligibility";

// ---------------------------------------------------------------------------
// Static parity test for migration 069 ("Is altyapisi" — Pack E: B7 headline
// LLM budget gate, B9 tokened report share links, B11 keyed /api/v1 access).
// 069 is additive-only and copied verbatim from the planner's SQL (see
// pack.md's "Migration" section and W1.md's instructions), so this file
// pins the migration's SQL surface (RLS/grants/SECURITY DEFINER shell,
// thresholds, CHECK vocabularies) against the TypeScript constants that
// must agree with it, the same discipline as
// tests/migrations/jev-shadow-parity.test.ts pins 061/063/064.
//
// Cross-worker guards: the api_keys tier CHECK <-> API_TIERS (src/lib/api/
// keys.ts, W3) and the report_share_links token CHECK <-> SHARE_TOKEN_RE
// (src/lib/reports/share.ts, W2) guards below are EXPECTED RED until those
// workers land their files in this same worktree — do not weaken them, do
// not stub the files they read. This mirrors
// tests/migrations/jev-shadow-parity.test.ts's JEV-A17/JEV-A19 pattern.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const REPO_ROOT = resolve(__dirname, "..", "..");

function read(name: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, name), "utf8");
}

describe("migration 069_api_keys_reports_llm_budget.sql (static parity)", () => {
  let sql = "";
  let code = "";
  beforeAll(() => {
    sql = read("069_api_keys_reports_llm_budget.sql");
    expect(sql.length).toBeGreaterThan(0);
    // Comments stripped, for guards that must not be fooled by prose that
    // happens to contain a matching substring (same technique as 064's
    // parity block above).
    code = sql.replace(/--[^\n]*/g, "");
  });

  it("contains the ledger insert for '069'", () => {
    expect(sql).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations[\s\S]*?values\s*\(\s*'069'\s*,\s*'069_api_keys_reports_llm_budget'\s*\)/i,
    );
  });

  it("is additive-only: no DROP TABLE/COLUMN and no ALTER TABLE on articles/clusters/jev_shadow_predictions", () => {
    expect(sql).not.toMatch(/\bdrop\s+table\b/i);
    expect(sql).not.toMatch(/\bdrop\s+column\b/i);
    expect(sql).not.toMatch(/\balter\s+table\s+public\.(articles|clusters|jev_shadow_predictions)\b/i);
  });

  it("all four new tables are service_role-only: RLS on, anon/authenticated/public revoked", () => {
    for (const table of [
      "llm_budget_daily",
      "report_share_links",
      "api_keys",
      "api_key_usage_daily",
    ]) {
      expect(sql).toMatch(
        new RegExp(`alter\\s+table\\s+public\\.${table}\\s+enable\\s+row\\s+level\\s+security`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+public\\.${table}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
    }
  });

  it("api_keys_id_seq is revoked from anon/authenticated/public and granted to service_role", () => {
    expect(sql).toMatch(
      /revoke\s+all\s+on\s+sequence\s+public\.api_keys_id_seq\s+from\s+anon,\s*authenticated,\s*public/i,
    );
    expect(sql).toMatch(
      /grant\s+usage,\s*select\s+on\s+sequence\s+public\.api_keys_id_seq\s+to\s+service_role/i,
    );
  });

  it("all five functions are SECURITY DEFINER with search_path = '' and revoked from anon/authenticated/public", () => {
    const functions: Array<{ name: string; sig: string }> = [
      { name: "llm_budget_add", sig: "llm_budget_add\\(date,\\s*integer,\\s*bigint,\\s*bigint,\\s*numeric\\)" },
      { name: "llm_budget_gate", sig: "llm_budget_gate\\(date,\\s*integer,\\s*integer\\)" },
      { name: "headline_llm_eligible", sig: "headline_llm_eligible\\(uuid\\[\\]\\)" },
      { name: "report_share_view", sig: "report_share_view\\(text\\)" },
      { name: "api_key_touch", sig: "api_key_touch\\(text\\)" },
    ];
    for (const fn of functions) {
      const fnMatch = sql.match(
        new RegExp(`create\\s+or\\s+replace\\s+function\\s+public\\.${fn.name}\\([^)]*\\)[\\s\\S]*?\\$fn\\$;`, "i"),
      );
      expect(fnMatch, `could not find function public.${fn.name}`).not.toBeNull();
      const body = fnMatch![0];
      expect(body).toMatch(/security\s+definer/i);
      expect(body).toMatch(/set\s+search_path\s*=\s*''/i);
      expect(sql).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${fn.sig}\\s+from\\s+anon,\\s*authenticated,\\s*public`, "i"),
      );
      expect(sql).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${fn.sig}\\s+to\\s+service_role`, "i"),
      );
    }
  });

  it("contains no cron.schedule / net.http_post / vault reference (schedules no pg_cron job and reads no vault secret)", () => {
    // Checked against `code` (comments stripped): the file's own header
    // comment DISCUSSES a hypothetical future do-block that would read
    // vault.decrypted_secrets / call cron.schedule (see the "If a later
    // pack adds a pruning job..." note) -- that is documentation, not a
    // live reference, so the guard must not fire on prose.
    expect(code).not.toMatch(/cron\.schedule/i);
    expect(code).not.toMatch(/net\.http_post/i);
    expect(code).not.toMatch(/vault\./i);
    expect(code).not.toMatch(/vault\.decrypted_secrets/i);
  });

  it("contains no reserved word (position, both, order, user, value, name, type, key) as a column, CTE or output name", () => {
    // Anchored to a column/CTE/output-name DEFINITION position: after '(' or
    // ',' with leading whitespace (DDL column lists / RETURNS TABLE lists),
    // or the start of a CTE name in a WITH clause, or an `as <name>` output
    // alias — not an arbitrary substring match, which would false-positive
    // on prose like "the key itself" or "user-facing".
    const reserved = ["position", "both", "order", "user", "value", "name", "type", "key"];
    for (const word of reserved) {
      // `<word> <type>` as a bare column/OUT-parameter declaration line.
      const columnDeclRe = new RegExp(`(^|[(,]\\s*)${word}\\s+(uuid|text|integer|bigint|numeric|boolean|timestamptz|date)\\b`, "im");
      // `as <word>` output alias.
      const aliasRe = new RegExp(`\\bas\\s+${word}\\b`, "i");
      expect(code, `reserved word "${word}" used as a column/output name`).not.toMatch(columnDeclRe);
      expect(code, `reserved word "${word}" used as an output alias`).not.toMatch(aliasRe);
    }
  });

  it("the eligibility thresholds in the SQL equal the constants in src/lib/headline/eligibility.ts", () => {
    expect(sql).toContain(`p.task = 'politics' and p.jev_prob >= ${HEADLINE_ELIGIBILITY_POLITICS_MIN_PROB}`);
    expect(sql).toContain(`p.task = 'politics' and p.jev_prob >= ${HEADLINE_ELIGIBILITY_POLITICS_SOLO_MIN_PROB}`);
    expect(sql).toContain("coalesce(s.politics_hits, 0) >= 2");
    expect(sql).toContain(
      `(s.clickbait_hits::numeric / s.clickbait_n::numeric) < ${HEADLINE_ELIGIBILITY_CLICKBAIT_MAX_SHARE}`,
    );
    expect(sql).toContain(`p.task = 'clickbait' and p.jev_prob >= ${HEADLINE_ELIGIBILITY_CLICKBAIT_MIN_PROB}`);
  });

  // EXPECTED RED until W3 lands src/lib/api/keys.ts in this worktree — do
  // not weaken, do not stub W3's file.
  it("the api_keys tier CHECK list equals API_TIERS in src/lib/api/keys.ts (EXPECTED RED until W3 lands)", () => {
    const keysPath = resolve(REPO_ROOT, "src", "lib", "api", "keys.ts");
    expect(existsSync(keysPath), "src/lib/api/keys.ts does not exist yet (W3 has not landed)").toBe(true);
    const keysSrc = readFileSync(keysPath, "utf8");
    const match = keysSrc.match(/API_TIERS\s*=\s*\[([^\]]*)\]/);
    expect(match, "could not find API_TIERS literal in src/lib/api/keys.ts").not.toBeNull();
    const values = (match?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

    const sqlMatch = sql.match(/tier\s+text\s+not\s+null\s+check\s*\(\s*tier\s+in\s*\(([^)]+)\)\s*\)/i);
    expect(sqlMatch, "could not find the api_keys.tier CHECK list").not.toBeNull();
    const sqlValues = (sqlMatch?.[1] ?? "")
      .split(",")
      .map((s) => s.trim().replace(/^'|'$/g, ""))
      .filter(Boolean);

    expect(values.sort()).toEqual(sqlValues.sort());
  });

  // EXPECTED RED until W2 lands src/lib/reports/share.ts in this worktree —
  // do not weaken, do not stub W2's file.
  it("the report_share_links token CHECK regex equals SHARE_TOKEN_RE in src/lib/reports/share.ts (EXPECTED RED until W2 lands)", () => {
    const sharePath = resolve(REPO_ROOT, "src", "lib", "reports", "share.ts");
    expect(existsSync(sharePath), "src/lib/reports/share.ts does not exist yet (W2 has not landed)").toBe(true);
    const shareSrc = readFileSync(sharePath, "utf8");
    const match = shareSrc.match(/SHARE_TOKEN_RE\s*=\s*(\/[^/]+\/)/);
    expect(match, "could not find SHARE_TOKEN_RE literal in src/lib/reports/share.ts").not.toBeNull();
    const shareRegexSource = match![1];

    expect(sql).toContain(`token text primary key check (token ~ '^[0-9a-f]{32}$')`);
    // Normalize both to the same bare pattern text for comparison.
    const sqlPattern = "^[0-9a-f]{32}$";
    const tsPattern = shareRegexSource!.slice(1, -1);
    expect(tsPattern).toBe(sqlPattern);
  });
});
