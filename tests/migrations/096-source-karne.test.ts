import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, VOTING_SOURCE_KINDS } from "../../src/lib/bias/config";
import { KARNE_WINDOW_DAYS } from "../../src/lib/sources/karne";

// Static SQL-contract test for migration 096 ("Kapsama karnesi" per-source
// 30-day rollup). Comments are stripped before every assertion so prose can
// never satisfy a code guard (same style as 092's test).

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "096_source_karne.sql",
);

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 096_source_karne.sql (SQL contract)", () => {
  let code = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "096_source_karne.sql must exist").toBe(true);
    code = stripComments(readFileSync(MIGRATION, "utf8"));
  });

  it("zmap pairs equal BIAS_TO_ZONE (8th SQL copy)", () => {
    const m = code.match(
      /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*mine\s+as/i,
    );
    expect(m, "zmap CTE must be present").not.toBeNull();
    const pairs = [
      ...m![1]!.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g),
    ].map((p) => [p[1], p[2]] as const);
    const sqlMap = Object.fromEntries(pairs);
    expect(pairs).toHaveLength(Object.keys(BIAS_TO_ZONE).length);
    expect(sqlMap).toEqual(BIAS_TO_ZONE);
  });

  it("voting kinds equal VOTING_SOURCE_KINDS", () => {
    const m = code.match(/kind\s+in\s*\(([^)]*)\)/i);
    expect(m).not.toBeNull();
    const kinds = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((k) => k[1]);
    expect(kinds).toEqual([...VOTING_SOURCE_KINDS]);
  });

  it("default window equals KARNE_WINDOW_DAYS", () => {
    const m = code.match(
      /source_karne_refresh\s*\(\s*p_days\s+integer\s+default\s+(\d+)\s*\)/i,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(KARNE_WINDOW_DAYS);
  });

  it("is a SECURITY DEFINER function with an empty search_path", () => {
    expect(code).toMatch(/security\s+definer/i);
    expect(code).toMatch(/search_path\s*=\s*''/i);
  });

  it("revokes the function from public/anon/authenticated and grants service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.source_karne_refresh\s*\(\s*integer\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.source_karne_refresh\s*\(\s*integer\s*\)\s+to\s+service_role/i,
    );
  });

  it("enables RLS with no policies", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.source_karne_30d\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("revokes all table privileges from anon/authenticated/public incl. the PG17 maintain guard", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.source_karne_30d\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
    expect(code).toMatch(/server_version_num'\)::int\s*>=\s*170000/i);
    expect(code).toMatch(
      /revoke maintain on public\.source_karne_30d from anon, authenticated/i,
    );
  });

  it("grants only service_role on the table; nothing to anon/authenticated", () => {
    expect(code).toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.source_karne_30d\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+(insert|update|delete|truncate|all|select)[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i,
    );
  });

  it("uses the veto in the public-blindspot expression", () => {
    expect(code).toMatch(
      /\(\s*c\.is_blindspot\s+and\s+not\s+c\.blindspot_recall_veto\s*\)\s+as\s+bs\b/i,
    );
  });

  it("takes the advisory lock, schedules the cron job and writes the ledger row", () => {
    expect(code).toMatch(
      /pg_try_advisory_xact_lock\s*\(\s*pg_catalog\.hashtext\('source_karne_refresh'\)/i,
    );
    expect(code).toMatch(
      /cron\.schedule\s*\(\s*'source-karne-refresh'\s*,\s*'41 0 \* \* \*'/i,
    );
    expect(code).toMatch(/cron\.unschedule\s*\(\s*'source-karne-refresh'\s*\)/i);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'096'\s*,\s*'096_source_karne'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("raises statement_timeout in the cron command itself (a function-level SET cannot re-arm the caller's timer)", () => {
    const m = code.match(/cron\.schedule\s*\([\s\S]*?\$sql\$([\s\S]*?)\$sql\$/i);
    expect(m, "cron command body").not.toBeNull();
    const cmd = m![1];
    const setIdx = cmd.search(/set\s+statement_timeout\s*=\s*'(\d+)min'/i);
    const callIdx = cmd.search(/select\s+public\.source_karne_refresh/i);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(setIdx);
    const mins = Number(/statement_timeout\s*=\s*'(\d+)min'/i.exec(cmd)![1]);
    expect(mins).toBeGreaterThanOrEqual(15);
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive: no table removal, no alter of existing tables", () => {
    expect(code).not.toMatch(/\bdrop\s+table\b/i);
    const alters = [
      ...code.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w.]+)/gi),
    ].map((m) => m[1]);
    expect(alters.every((t) => t === "public.source_karne_30d")).toBe(true);
  });

  it("does not run the (slow) backfill inside the migration", () => {
    // Step 0 measured > 3 s on the heaviest sources; see deploy notes.
    expect(code).not.toMatch(/select\s+public\.source_karne_refresh\s*\(\s*30\s*\)/i);
  });
});
