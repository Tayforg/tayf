import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  RISING_ENTITIES,
  RISING_FOLD_FROM,
  RISING_FOLD_TO,
} from "../../src/lib/trends/rising-entities";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 112 ("per-entity daily rollup" behind
// "Yükselen Konular" on /trends). 112 tokenizes article TITLES against the
// curated vocabulary in src/lib/trends/rising-entities.ts, one Istanbul day
// per statement, inside the existing hourly 'trends-rollup-refresh' cron.
// Style mirrors tests/migrations/092-trends-rollup.test.ts: comments are
// stripped before every code assertion so prose can never satisfy a guard.
// The vocabulary and the fold strings are parity-tested against the TS module
// in both directions.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "112_trends_entity_rollup.sql";
const TABLE = "public.trends_daily_entity_counts_ist_rollup";
const FN = "public.trends_daily_entity_counts_ist_refresh";

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

describe("migration 112_trends_entity_rollup.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(REPO_ROOT, "supabase", "migrations", MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
  });

  // -- hygiene ---------------------------------------------------------------

  it("contains the ledger insert for '112'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'112'\s*,\s*'112_trends_entity_rollup'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code.trim()).toMatch(/^begin\s*;/i);
    expect(code.trim()).toMatch(/\bcommit\s*;$/i);
    expect((code.match(/^\s*begin\s*;/gim) ?? []).length).toBe(1);
    expect((code.match(/^\s*commit\s*;/gim) ?? []).length).toBe(1);
  });

  it("is additive-only: no DROP TABLE/VIEW, TRUNCATE TABLE or DELETE FROM", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|view)\b/i);
    expect(code).not.toMatch(/\btruncate\s+table\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\balter\s+table\s+public\.articles\b/i);
  });

  it("does not mention the zone name, so zone-parity.test.ts needs no registration", () => {
    // tests/migrations/zone-parity.test.ts fails on any unregistered migration
    // whose text contains it (comments included); this migration needs no zones.
    expect(sql).not.toContain("iktidar");
  });

  it("documents why, the Step 0 numbers, deploy order, rollback and that delete is not used", () => {
    const header = sql.slice(0, sql.search(/^begin\s*;/im));
    expect(header).toMatch(/\bWHY\b/);
    expect(header).toMatch(/STEP 0 FINDINGS/);
    expect(header).toMatch(/7,253/);
    expect(header).toMatch(/DEPLOY ORDER/);
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toMatch(/NO DELETE/);
  });

  // -- table -------------------------------------------------------------------

  it("creates the rollup table with the specified columns and a (day, entity) primary key", () => {
    expect(code).toMatch(
      new RegExp(`create\\s+table\\s+if\\s+not\\s+exists\\s+${esc(TABLE)}\\s*\\(`, "i"),
    );
    expect(code).toMatch(/\bday\s+date\s+not\s+null\b/i);
    expect(code).toMatch(
      /\bentity\s+text\s+not\s+null\s+check\s*\(\s*entity\s*~\s*'\^\[a-z0-9-\]\+\$'\s*\)/i,
    );
    expect(code).toMatch(
      /\bcount\s+integer\s+not\s+null\s+default\s+0\s+check\s*\(\s*count\s*>=\s*0\s*\)/i,
    );
    expect(code).toMatch(/\bupdated_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
    expect(code).toMatch(/primary\s+key\s*\(\s*day\s*,\s*entity\s*\)/i);
  });

  it("indexes the table on (day desc)", () => {
    expect(code).toMatch(
      new RegExp(
        `create\\s+index\\s+if\\s+not\\s+exists\\s+\\w+\\s+on\\s+${esc(TABLE)}\\s*\\(\\s*day\\s+desc\\s*\\)`,
        "i",
      ),
    );
  });

  it("enables RLS and defines NO policy (service-role only)", () => {
    expect(code).toMatch(
      new RegExp(`alter\\s+table\\s+${esc(TABLE)}\\s+enable\\s+row\\s+level\\s+security`, "i"),
    );
    expect(code).not.toMatch(/\bcreate\s+policy\b/i);
  });

  it("revokes every default grant from anon, authenticated and public", () => {
    expect(code).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+${esc(TABLE)}\\s+from\\s+anon\\s*,\\s*authenticated\\s*,\\s*public\\s*;`,
        "i",
      ),
    );
  });

  it("guards a MAINTAIN revoke behind server_version_num >= 170000", () => {
    expect(code).toMatch(/server_version_num[\s\S]{0,40}>=\s*170000/i);
    expect(code).toMatch(
      new RegExp(
        `execute\\s+'revoke\\s+maintain\\s+on\\s+${esc(TABLE)}\\s+from\\s+anon\\s*,\\s*authenticated'`,
        "i",
      ),
    );
  });

  it("grants SELECT on the table to service_role ONLY", () => {
    expect(code).toMatch(
      new RegExp(`grant\\s+select\\s+on\\s+${esc(TABLE)}\\s+to\\s+service_role\\s*;`, "i"),
    );
    // No grant statement of any kind may name anon or authenticated.
    for (const stmt of code.split(";")) {
      if (/^\s*grant\b/i.test(stmt)) {
        // Grantee list only: the schema name "public." is not a grantee.
        const grantees = stmt.split(/\sto\s/i)[1] ?? "";
        expect(grantees.trim(), stmt).toBe("service_role");
      }
    }
    expect(code).not.toMatch(/\bto\s+anon\b/i);
    expect(code).not.toMatch(/\bto\s+authenticated\b/i);
    // No write grant to anyone.
    expect(code).not.toMatch(/\bgrant\s+(insert|update|delete|truncate|maintain|all)\b/i);
  });

  // -- refresh function ----------------------------------------------------------

  it("defines the refresh function as SECURITY DEFINER with search_path = '' and p_days default 2", () => {
    expect(code).toMatch(
      new RegExp(
        `create\\s+or\\s+replace\\s+function\\s+${esc(FN)}\\s*\\(\\s*p_days\\s+integer\\s+default\\s+2\\s*\\)\\s*returns\\s+integer`,
        "i",
      ),
    );
    expect(code).toMatch(/language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i);
  });

  it("clamps p_days to 1..10", () => {
    expect(code).toMatch(
      /v_days\s+integer\s*:=\s*least\s*\(\s*greatest\s*\(\s*coalesce\s*\(\s*p_days\s*,\s*2\s*\)\s*,\s*1\s*\)\s*,\s*10\s*\)/i,
    );
  });

  it("takes the advisory lock and returns 0 when it is not obtained", () => {
    expect(code).toMatch(
      /if\s+not\s+pg_catalog\.pg_try_advisory_xact_lock\s*\(\s*pg_catalog\.hashtext\s*\(\s*'trends_daily_entity_counts_ist_refresh'\s*\)(::bigint)?\s*\)\s*then\s+return\s+0\s*;\s*end\s+if/i,
    );
  });

  it("computes v_today in Europe/Istanbul and caps the day set to v_today-10..v_today", () => {
    expect(code).toMatch(
      /v_today\s*:=\s*\(\s*pg_catalog\.now\(\)\s+at\s+time\s+zone\s+'Europe\/Istanbul'\s*\)::date/i,
    );
    expect(code).toMatch(/d\s*<=\s*v_today\s+and\s+d\s*>=\s*v_today\s*-\s*10\b/i);
  });

  it("recomputes the rolling window UNION the days hit by recently-ingested rows (092's rule)", () => {
    expect(code).toMatch(/generate_series\s*\(\s*0\s*,\s*v_days\s*-\s*1\s*\)/i);
    expect(code).toMatch(/a\.created_at\s*>=\s*pg_catalog\.now\(\)\s*-\s*interval\s*'2 days'/i);
    expect(code).toMatch(/least\s*\(\s*a\.published_at\s*,\s*a\.created_at\s*\)/i);
  });

  it("runs one statement per day inside a loop", () => {
    expect(code).toMatch(/\bfor\s+v_day\s+in\b[\s\S]*?\bloop\b[\s\S]*?\bend\s+loop\s*;/i);
    expect(code).toMatch(/get\s+diagnostics\s+v_rows\s*=\s*row_count/i);
  });

  it("filters to voting kinds only: s.kind in ('outlet', 'wire')", () => {
    expect(code).toMatch(/s\.kind\s+in\s*\(\s*'outlet'\s*,\s*'wire'\s*\)/i);
  });

  it("excludes legal notices (107) and null titles", () => {
    expect(code).toMatch(
      /not\s+exists\s*\(\s*select\s+1\s+from\s+public\.legal_notice_articles\s+l\s+where\s+l\.article_id\s*=\s*a\.id\s*\)/i,
    );
    expect(code).toMatch(/a\.title\s+is\s+not\s+null/i);
  });

  it("buckets by the Istanbul day of least(published_at, created_at) with a created_at lower bound and NO upper bound (late rows)", () => {
    expect(code).toMatch(
      /\(\s*least\s*\(\s*a\.published_at\s*,\s*a\.created_at\s*\)\s+at\s+time\s+zone\s+'Europe\/Istanbul'\s*\)::date\s*=\s*v_day/i,
    );
    expect(code).toMatch(
      /a\.created_at\s*>=\s*\(\s*v_day::timestamp\s+at\s+time\s+zone\s+'Europe\/Istanbul'\s*\)/i,
    );
    expect(code).not.toMatch(/a\.created_at\s*<\s*\(?\s*v_day/i);
    // The bounds always go through an explicit Istanbul-zoned cast.
    expect(code).not.toMatch(/v_day\s*::\s*timestamptz/i);
    expect(code).not.toMatch(/\(\s*v_day\s*\+\s*\d+\s*\)\s*::\s*timestamptz/i);
  });

  it("narrows the day with two DISJOINT index range scans (UNION ALL), covering every row once", () => {
    const m =
      /x\.published_at\s*>=\s*v_from\s+and\s+x\.published_at\s*<\s*v_to\s+and\s+x\.created_at\s*>=\s*v_from\s+union\s+all\s+select[\s\S]*?y\.created_at\s*>=\s*v_from\s+and\s+y\.created_at\s*<\s*v_to\s+and\s+y\.published_at\s*>=\s*v_to/i.exec(
        code,
      );
    expect(m).not.toBeNull();
    // Both bounds are Europe/Istanbul-zoned.
    expect(code).toMatch(
      /v_from\s*:=\s*\(\s*v_day::timestamp\s+at\s+time\s+zone\s+'Europe\/Istanbul'\s*\)/i,
    );
    expect(code).toMatch(
      /v_to\s*:=\s*\(\s*\(\s*v_day\s*\+\s*1\s*\)::timestamp\s+at\s+time\s+zone\s+'Europe\/Istanbul'\s*\)/i,
    );
  });

  it("pins custom plans so the parameterised day bounds can never plan as a full scan", () => {
    expect(code).toMatch(/set\s+plan_cache_mode\s*=\s*force_custom_plan/i);
  });

  it("the translate() literals equal RISING_FOLD_FROM / RISING_FOLD_TO", () => {
    const m =
      /translate\s*\(\s*a\.title\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/i.exec(code);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(RISING_FOLD_FROM);
    expect(m![2]).toBe(RISING_FOLD_TO);
    expect([...m![1]!].length).toBe([...m![2]!].length);
    // translate runs before lower, as foldTitleGrams does.
    expect(code).toMatch(/lower\s*\(\s*(?:pg_catalog\.)?translate\s*\(/i);
  });

  it("the emap VALUES pairs deep-equal the flattened RISING_ENTITIES (token, key)", () => {
    const span =
      /emap\s*\(\s*token\s*,\s*entity\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*day_articles\s+as/i.exec(
        code,
      );
    expect(span).not.toBeNull();
    const body = span![1]!;
    const pairs: Array<[string, string]> = [];
    const pairRe = /\(\s*'([a-z0-9 ]+)'\s*,\s*'([a-z0-9-]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = pairRe.exec(body)) !== null) {
      pairs.push([m[1]!, m[2]!]);
    }
    const expected = RISING_ENTITIES.flatMap((e) =>
      e.tokens.map((t): [string, string] => [t, e.key]),
    );
    expect(pairs).toEqual(expected);
    // Nothing else hides in the VALUES body besides those pairs.
    const residue = body.replace(pairRe, "").replace(/[\s,]/g, "");
    expect(residue).toBe("");
    // No duplicate token (each token maps to exactly one entity).
    expect(new Set(pairs.map((p) => p[0])).size).toBe(pairs.length);
  });

  it("tokenizes on [^a-z0-9]+ into unigrams and adjacent bigrams", () => {
    expect(code).toMatch(
      /regexp_split_to_table\s*\(\s*d\.t\s*,\s*'\[\^a-z0-9\]\+'\s*\)\s+with\s+ordinality\s+as\s+x\s*\(\s*tok\s*,\s*ord\s*\)/i,
    );
    expect(code).toMatch(/where\s+t\.tok\s*<>\s*''/i); // unigrams
    expect(code).toMatch(/p\.tok\s*\|\|\s*' '\s*\|\|\s*q\.tok/i); // bigrams
    expect(code).toMatch(/q\.id\s*=\s*p\.id\s+and\s+q\.ord\s*=\s*p\.ord\s*\+\s*1/i);
    expect(code).toMatch(/\bunion\s+all\b/i);
  });

  it("counts ARTICLES, not mentions: select distinct id, entity", () => {
    expect(code).toMatch(/select\s+distinct\s+g\.id\s*,\s*m\.entity/i);
    expect(code).toMatch(/count\s*\(\s*\*\s*\)\s*::\s*int\s+as\s+cnt/i);
  });

  it("writes a row for EVERY vocabulary entity (zero included), upserting only changed counts", () => {
    expect(code).toMatch(/from\s*\(\s*select\s+distinct\s+entity\s+from\s+emap\s*\)\s+e/i);
    expect(code).toMatch(/left\s+join\s+agg\s+g\s+on\s+g\.entity\s*=\s*e\.entity/i);
    expect(code).toMatch(/coalesce\s*\(\s*g\.cnt\s*,\s*0\s*\)/i);
    expect(code).toMatch(
      new RegExp(
        `on\\s+conflict\\s*\\(\\s*day\\s*,\\s*entity\\s*\\)\\s+do\\s+update\\s+set\\s+count\\s*=\\s*excluded\\.count\\s*,\\s*updated_at\\s*=\\s*excluded\\.updated_at\\s+where\\s+${esc(TABLE)}\\.count\\s+is\\s+distinct\\s+from\\s+excluded\\.count`,
        "i",
      ),
    );
  });

  it("never aborts the shared cron transaction: failures (and timeouts) warn and return -1", () => {
    expect(code).toMatch(
      /exception\s+when\s+others(\s+or\s+query_canceled)?\s+then\s+raise\s+warning\s+'112 entity refresh failed: %'\s*,\s*sqlerrm\s*;\s*return\s+-1\s*;\s*end\s*;/i,
    );
    // The handler wraps the day loop: begin <loop> exception ... end.
    expect(code).toMatch(/\bbegin\s+for\s+v_day\s+in\b/i);
    expect(code.search(/exception\s+when\s+others/i)).toBeGreaterThan(
      code.search(/\bend\s+loop\s*;/i),
    );
  });

  it("revokes execute from public/anon/authenticated and grants only service_role", () => {
    expect(code).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+${esc(FN)}\\s*\\(\\s*integer\\s*\\)\\s+to\\s+service_role\\s*;`,
        "i",
      ),
    );
  });

  // -- cron fold + backfill ----------------------------------------------------------

  it("folds the function into the existing cron command and leaves the schedule alone", () => {
    expect(code).toMatch(/to_regclass\s*\(\s*'cron\.job'\s*\)\s+is\s+null/i);
    expect(code).toMatch(/jobname\s*=\s*'trends-rollup-refresh'/i);
    expect(code).toMatch(
      /perform\s+cron\.alter_job\s*\(\s*v_job\s*,\s*command\s*:=\s*'select public\.trends_daily_zone_counts_ist_refresh\(\); select public\.trends_daily_entity_counts_ist_refresh\(\);'\s*\)/i,
    );
    // Both skip paths raise a notice instead of failing.
    expect((code.match(/raise\s+notice\s+'112:/gi) ?? []).length).toBe(2);
    expect(code).not.toMatch(/cron\.schedule\b/i);
    expect(code).not.toMatch(/cron\.unschedule\b/i);
    expect(code).not.toMatch(/\bschedule\s*:=/i);
  });

  /** The backfill DO block, comments already stripped. */
  function backfillBlock(): string {
    const m = /do\s+\$backfill\$[\s\S]*?\$backfill\$\s*;/i.exec(code);
    expect(m, "the backfill must live in a $backfill$ DO block").not.toBeNull();
    return m![0];
  }

  it("runs exactly one backfill: refresh(9)", () => {
    const calls = code.match(
      /public\.trends_daily_entity_counts_ist_refresh\s*\(\s*9\s*\)\s*;/gi,
    );
    expect(calls).toHaveLength(1);
    // And no other literal-argument call hides in the file.
    expect(
      (code.match(/trends_daily_entity_counts_ist_refresh\s*\(\s*\d+\s*\)/gi) ?? []).length,
    ).toBe(1);
    // The one call sits inside the DO block, so its result is never discarded.
    expect(backfillBlock()).toMatch(
      /v_result\s*:=\s*public\.trends_daily_entity_counts_ist_refresh\s*\(\s*9\s*\)\s*;/i,
    );
  });

  it("fails the migration when the backfill reports -1 (refresh swallows errors and only warns)", () => {
    // refresh() catches every failure, including a statement timeout, and
    // returns -1, so a bare `select refresh(9)` would commit an empty rollup
    // together with the '112' ledger row (a silent partial deploy). The DO
    // block turns a negative result into an exception: the whole transaction
    // rolls back and no ledger row is written.
    expect(backfillBlock()).toMatch(
      /if\s+v_result\s*<\s*0\s+then\s+raise\s+exception\s+'112:[^']*'\s*;\s*end\s+if\s*;/i,
    );
    expect(code).not.toMatch(/^\s*select\s+public\.trends_daily_entity_counts_ist_refresh/im);
  });

  it("also fails when fewer than 9 days were written (an overlapping refresh returns 0 without working)", () => {
    const block = backfillBlock();
    expect(block).toMatch(
      /select\s+count\s*\(\s*distinct\s+r\.day\s*\)\s+into\s+v_days\s+from\s+public\.trends_daily_entity_counts_ist_rollup\s+r\s+where\s+r\.day\s+between\s+v_today\s*-\s*8\s+and\s+v_today\s*;/i,
    );
    expect(block).toMatch(
      /if\s+v_days\s*<\s*9\s+then\s+raise\s+exception\s+'112:[^']*'\s*,\s*v_days\s*;\s*end\s+if\s*;/i,
    );
    // v_today is the same Istanbul day the refresh computes (now() is the
    // transaction start time in both).
    expect(block).toMatch(
      /v_today\s+date\s*:=\s*\(\s*pg_catalog\.now\(\)\s+at\s+time\s+zone\s+'Europe\/Istanbul'\s*\)::date/i,
    );
  });

  it("runs the backfill checks BEFORE the ledger insert, so a failure leaves no '112' row", () => {
    const backfillAt = code.search(/do\s+\$backfill\$/i);
    const ledgerAt = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(backfillAt).toBeGreaterThan(-1);
    expect(ledgerAt).toBeGreaterThan(backfillAt);
  });

  it("does not touch the zone rollup (092) or the 087 view", () => {
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?(table|view)\s+(if\s+not\s+exists\s+)?public\.trends_daily_zone_counts/i);
    expect(code).not.toMatch(/insert\s+into\s+public\.trends_daily_zone_counts/i);
  });
});

describe("112 test matchers have teeth", () => {
  it("the grant guard catches a grant to anon", () => {
    const bad = stripComments("grant select on public.t to anon, service_role;");
    const hit = bad
      .split(";")
      .some((s) => /^\s*grant\b/i.test(s) && /\banon\b/i.test(s.split(/\sto\s/i)[1] ?? ""));
    expect(hit).toBe(true);
  });

  it("stripComments removes prose so it cannot satisfy a guard", () => {
    expect(stripComments("-- delete from x;\nselect 1;")).not.toMatch(/delete\s+from/i);
  });
});
