import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 078 ("tık tuzağı karnesi" rollup),
// mirroring 072-framing-draw-fast.test.ts's comment-stripping approach, plus
// a parity check against supabase/functions/_shared/jev.ts the same way
// jev-shadow-parity.test.ts does (JEV-A20).
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "078_source_clickbait.sql";

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

function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

describe("migration 078_source_clickbait.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let rollupFn = "";
  let readFn = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    rollupFn = functionBlock(code, "source_clickbait_rollup");
    readFn = functionBlock(code, "source_clickbait_30d");
  });

  it("contains the ledger insert for '078'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'078'\s*,\s*'078_source_clickbait'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is a single begin/commit transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    const beginCount = (code.match(/\bbegin\s*;/gi) ?? []).length;
    const commitCount = (code.match(/\bcommit\s*;/gi) ?? []).length;
    expect(beginCount).toBe(1);
    expect(commitCount).toBe(1);
  });

  it("is additive only: no drop/truncate/delete/update public., and the only alter table is enable row level security", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);

    const alters = code.match(/\balter\s+table\b[^;]*;/gi) ?? [];
    expect(alters.length).toBeGreaterThan(0);
    for (const stmt of alters) {
      expect(stmt).toMatch(/enable\s+row\s+level\s+security/i);
    }
  });

  it("creates source_clickbait_daily additively (create table if not exists)", () => {
    expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.source_clickbait_daily/i);
  });

  it("both functions are SECURITY DEFINER with an empty search_path", () => {
    for (const h of [header(rollupFn), header(readFn)]) {
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    }
  });

  it("source_clickbait_rollup is volatile plpgsql; source_clickbait_30d is stable sql", () => {
    const rollupHeader = header(rollupFn);
    expect(rollupHeader).toMatch(/\blanguage\s+plpgsql\b/i);
    expect(rollupHeader).toMatch(/\bvolatile\b/i);

    const readHeader = header(readFn);
    expect(readHeader).toMatch(/\blanguage\s+sql\b/i);
    expect(readHeader).toMatch(/\bstable\b/i);
  });

  it("revoke/grant pairs exist for both functions, and nothing is granted to anon/authenticated/public", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.source_clickbait_rollup\s*\(\s*date\s*,\s*date\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.source_clickbait_rollup\s*\(\s*date\s*,\s*date\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.source_clickbait_30d\s*\([^)]*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.source_clickbait_30d\s*\([^)]*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(
      /grant\s+[\w\s,]*on\s+function\s+public\.source_clickbait[\s\S]*?to\s+[\w\s,]*\b(anon|authenticated|public)\b/i,
    );

    expect(code).toMatch(/revoke\s+all\s+on\s+public\.source_clickbait_daily\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i);
    expect(code).toMatch(/grant\s+select\s+on\s+public\.source_clickbait_daily\s+to\s+service_role\s*;/i);
  });

  it("rolls up task = 'clickbait' at the pinned flag threshold 0.7 (CLICKBAIT_FLAG_PROB)", () => {
    const b = body(rollupFn);
    expect(b).toMatch(/task\s*=\s*'clickbait'/i);
    expect(b).toMatch(/jev_prob\s*>=\s*0\.7\b/);
  });

  it("uses the voting kinds (outlet, wire) in source_clickbait_30d's eligibility filter", () => {
    const kindPath = resolve(REPO_ROOT, "src", "lib", "bias", "config.ts");
    const kindSrc = read(kindPath);
    expect(kindSrc).toMatch(/VOTING_SOURCE_KINDS/);
    const b = body(readFn);
    expect(b).toMatch(/coalesce\s*\(\s*s\.kind\s*,\s*'outlet'\s*\)\s+in\s*\(\s*'outlet'\s*,\s*'wire'\s*\)/i);
  });

  it("has an `is distinct from` guard on the upsert and a 40-day clamp on the backfill span", () => {
    const b = body(rollupFn);
    expect(b).toMatch(/is\s+distinct\s+from/i);
    expect(b).toMatch(/v_to\s*-\s*v_from\s*>\s*40/i);
  });

  it("uses distinct on (article_id, question_set) so one duplicate row per article/version is counted once", () => {
    const b = body(rollupFn);
    expect(b).toMatch(/distinct\s+on\s*\(\s*p\.article_id\s*,\s*p\.jev_answer\s*->>\s*'question_set'\s*\)/i);
  });

  it("guards the cron schedule behind a pg_extension check and schedules minute :19", () => {
    const cronBlock = code.match(/do\s*\$\$[\s\S]*?end\s*\$\$\s*;/i)?.[0] ?? "";
    expect(cronBlock).toMatch(/pg_extension/i);
    expect(cronBlock).toMatch(/extname\s*=\s*'pg_cron'/i);
    expect(cronBlock).toMatch(/'source-clickbait-rollup'/);
    expect(cronBlock).toMatch(/'19 \* \* \* \*'/);
  });

  it("does not collide with an existing cron minute :19", () => {
    // Every other :19-adjacent job documented in the header runs on a
    // different minute expression; this migration doesn't touch cron.job
    // rows for any other jobname.
    expect(code).not.toMatch(/cron\.unschedule\(\s*'(jev-shadow|cluster-topics-refresh|blindspot-recall-veto|articles-vacuum)'\s*\)/);
  });

  it("ends with a one-off backfill call to source_clickbait_rollup", () => {
    expect(code).toMatch(/select\s+public\.source_clickbait_rollup\s*\(/i);
  });

  it("gates the one-off backfill so a re-apply of this migration skips the ~15s cold rollup", () => {
    // The backfill must only run when source_clickbait_daily is still
    // empty; a re-apply (operator re-running the file, or a migration
    // runner retry) must not re-pay the full cost inside the DDL
    // transaction. See 078's header measurement (15.1s cold).
    const guardedBackfill = code.match(
      /do\s*\$\$[\s\S]*?not\s+exists\s*\(\s*select\s+1\s+from\s+public\.source_clickbait_daily[\s\S]*?perform\s+public\.source_clickbait_rollup\s*\([\s\S]*?end\s*\$\$\s*;/i,
    );
    expect(guardedBackfill, "backfill must be wrapped in `if not exists (select 1 from source_clickbait_daily ...)`").toBeTruthy();
  });

  // -------------------------------------------------------------------
  // Parity with supabase/functions/_shared/jev.ts
  // -------------------------------------------------------------------

  it("CLICKBAIT_QUESTION_EN matches JEV_QUESTION_REGISTRY.clickbait.instructions verbatim", async () => {
    const { JEV_QUESTION_REGISTRY } = await import("../../supabase/functions/_shared/jev.ts");
    const { CLICKBAIT_QUESTION_EN } = await import("../../src/lib/sources/clickbait");
    expect(CLICKBAIT_QUESTION_EN).toBe(JEV_QUESTION_REGISTRY.clickbait.instructions);
  });

  it("CLICKBAIT_QUESTION_SETS includes JEV_QUESTION_SET_VERSION", async () => {
    const { JEV_QUESTION_SET_VERSION } = await import("../../supabase/functions/_shared/jev.ts");
    const { CLICKBAIT_QUESTION_SETS } = await import("../../src/lib/sources/clickbait");
    expect(CLICKBAIT_QUESTION_SETS).toContain(JEV_QUESTION_SET_VERSION);
  });

  it("CLICKBAIT_ARTICLE_CALL_SHA equals sha256(JSON.stringify(buildArticleCall(...).questions))", async () => {
    const { buildArticleCall } = await import("../../supabase/functions/_shared/jev.ts");
    const { CLICKBAIT_ARTICLE_CALL_SHA } = await import("../../src/lib/sources/clickbait");
    const questions = buildArticleCall({ title: "t", description: "d" } as never).questions;
    const hash = createHash("sha256").update(JSON.stringify(questions)).digest("hex");
    expect(CLICKBAIT_ARTICLE_CALL_SHA).toBe(hash);
  });
});
