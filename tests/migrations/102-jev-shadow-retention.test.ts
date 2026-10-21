import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 102 ("jev-shadow-retention").
//
// public.jev_shadow_predictions grew to 2.2 GB / 1.96 M rows (about 78 MB per
// day) and nothing ever deletes from it. 102 adds public.jev_shadow_prune():
// a bounded, exemption-safe, IRREVERSIBLE nightly delete of rows older than
// the keep window (default 45 days, hard floor 21 days).
//
// The delete is irreversible, so this file pins the safety contract rather
// than the happy path:
//   * the floor and the clamps cannot be bypassed by an argument;
//   * the advisory lock and the "rollup is behind" guard come BEFORE the delete;
//   * every exemption (reviews, politics admissions, gold set, regression
//     items, reader/spend tasks, live clusters, un-rolled-up days) is part of
//     the delete's own predicate, and the header's dry-run count query carries
//     the SAME predicates (a drift between the two would make the dry run lie);
//   * nothing is granted beyond execute-to-service_role, and the migration
//     contains exactly one DELETE and no DROP / TRUNCATE / reloptions.
//
// Behaviour (what is actually deleted and what survives) is proved on a
// throwaway PG15 and summarised in the migration header; this file is the
// static half of that proof.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_102 = resolve(MIGRATIONS_DIR, "102_jev_shadow_retention.sql");
const MIGRATION_081 = resolve(MIGRATIONS_DIR, "081_ops_retention.sql");

const ROLLUP_TABLES = [
  "jev_shadow_daily",
  "source_clickbait_daily",
  "jev_topic7_yardstick_daily",
  "source_drift_daily",
] as const;

/** Low-volume, reader- or spend-facing tasks that are never pruned. */
const EXEMPT_TASKS = [
  "pair_marginal",
  "blindspot_recall",
  "ticker_relevance",
  "kap_class",
  "kap_materiality",
  "pair_positive",
] as const;

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed, lower-case form for pattern checks. */
function flat(sql: string): string {
  return stripSqlComments(sql).replace(/\s+/g, " ").trim().toLowerCase();
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

/** `(` ... matching `)` starting at `open` (index of the opening paren). */
function balancedGroup(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  throw new Error("unbalanced parentheses");
}

/**
 * Every exemption/guard fragment of a predicate: `not exists (...)`,
 * `exists (...)` and `p.task not in (...)`, normalised so the delete's text and
 * the header's dry-run text can be compared (the dry run names the cutoff
 * `k.cutoff`, the function names it `cutoff`).
 */
function exemptionFragments(sql: string): string[] {
  const text = flat(sql).replace(/\bk\.cutoff\b/g, "cutoff");
  const out: string[] = [];
  const re = /(not exists|(?<!not )exists|p\.task not in)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const open = m.index + m[0].length - 1;
    const group = balancedGroup(text, open);
    out.push(`${m[1]}${group}`.replace(/\s*([(),])\s*/g, "$1"));
    re.lastIndex = open + group.length;
  }
  return out.sort();
}

/** The header's dry-run block, with its `-- ` comment prefixes removed. */
function dryRunSql(sql: string): string {
  const m = sql.match(/--\s*DRY-RUN BEGIN[^\n]*\n([\s\S]*?)\n--\s*DRY-RUN END/);
  if (!m || m[1] === undefined) throw new Error("dry-run block not found");
  return m[1]
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
}

let sql = "";
let code = "";
let head = "";
let fnBlock = "";
let fnHeader = "";
let fnBody = "";
let deleteStmt = "";
let windowStmt = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_102, "utf8");
  code = stripSqlComments(sql);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  fnBlock = functionBlock(code, "jev_shadow_prune");
  fnHeader = header(fnBlock);
  fnBody = body(fnBlock);
  const del = fnBody.match(/delete\s+from\s+public\.jev_shadow_predictions[\s\S]*?;/i);
  deleteStmt = del ? del[0] : "";
  const win = fnBody.match(/select\s+pg_catalog\.max\(w\.id\)[\s\S]*?;/i);
  windowStmt = win ? win[0] : "";
});

describe("102 ledger and structure", () => {
  it("is wrapped in begin/commit with a 5 s lock_timeout", () => {
    expect(code).toMatch(/\bbegin\s*;/i);
    expect(code).toMatch(/\bset\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    expect(code).toMatch(/\bcommit\s*;/i);
    expect(code.search(/\bbegin\s*;/i)).toBeLessThan(code.search(/\bset\s+local\s+lock_timeout/i));
    expect(code.search(/\bset\s+local\s+lock_timeout/i)).toBeLessThan(code.search(/\bcommit\s*;/i));
  });

  it("records itself as version '102'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'102'\s*,\s*'102_jev_shadow_retention'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("the ledger insert is the last statement before commit", () => {
    const f = flat(sql);
    expect(f).toMatch(/on conflict do nothing; commit;\s*$/);
  });

  it("owns migration number 102 alone", () => {
    const same = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("102_"));
    expect(same).toEqual(["102_jev_shadow_retention.sql"]);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(fnBody.length).toBeGreaterThan(500);
    expect(deleteStmt.length).toBeGreaterThan(200);
    expect(windowStmt.length).toBeGreaterThan(50);
  });

  it("is additive: one index, one function, one cron job, the ledger, and no destructive DDL", () => {
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bvacuum\b/i);
    expect(code).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(code).not.toMatch(/\bupdate\s+public\./i);
    const fns = [...code.matchAll(/create\s+or\s+replace\s+function\s+(public\.[a-z_]+)/gi)].map((m) => m[1]);
    expect(fns).toEqual(["public.jev_shadow_prune"]);
    const idx = [...code.matchAll(/create\s+index\s+if\s+not\s+exists\s+([a-z_]+)/gi)].map((m) => m[1]);
    expect(idx).toEqual(["jev_politics_admissions_prediction_idx"]);
  });

  it("does not set autovacuum reloptions (migration 101 owns them)", () => {
    expect(code).not.toMatch(/autovacuum/i);
    expect(code).not.toMatch(/\bset\s*\(\s*[a-z_]+\s*=/i);
    expect(head).toMatch(/autovacuum/i);
    expect(head).toMatch(/101/);
  });

  it("contains exactly one DELETE, and it targets public.jev_shadow_predictions", () => {
    const deletes = [...code.matchAll(/\bdelete\s+from\s+([a-z_.]+)/gi)].map((m) => m[1]);
    expect(deletes).toEqual(["public.jev_shadow_predictions"]);
  });
});

describe("102 header documents the irreversible delete", () => {
  it("states that deletion is irreversible", () => {
    expect(head).toMatch(/irreversible/i);
  });

  it("states the 45-day default, the 21-day hard floor and the first-eligible date", () => {
    expect(head).toMatch(/45 days/);
    expect(head).toMatch(/21 days/);
    expect(head).toMatch(/2026-11-04/);
    expect(head).toMatch(/2026-09-20/);
    expect(head).toMatch(/hard floor|floor is hard/i);
    expect(head).toMatch(/resched/i);
  });

  it("names all four rollups that keep the aggregates, with their migrations", () => {
    for (const t of ROLLUP_TABLES) expect(head).toContain(t);
    for (const n of ["081", "078", "090", "065"]) expect(head).toContain(n);
  });

  it("warns never to re-apply 081 (its 400-day backfill would overwrite history) and the real hazard exists", () => {
    expect(head).toMatch(/NEVER re-apply 081/);
    expect(head).toMatch(/jev_shadow_daily_refresh\(400\)/);
    const sql081 = stripSqlComments(readFileSync(MIGRATION_081, "utf8"));
    expect(sql081).toMatch(/select\s+public\.jev_shadow_daily_refresh\(400\)\s*;/i);
  });

  it("gives the maximum safe window of every rollup refresh", () => {
    expect(head).toMatch(/MAX SAFE WINDOW/);
    for (const fn of [
      "jev_shadow_daily_refresh",
      "source_clickbait_rollup",
      "jev_topic7_yardstick_refresh",
      "jev_source_drift_compute",
    ]) {
      expect(head).toContain(fn);
    }
    expect(head).toMatch(/keep_days - 1/);
  });

  it("explains why partitioning was rejected (incident doc finding 4)", () => {
    expect(head).toMatch(/partition/i);
    expect(head).toMatch(/finding 4/i);
    expect(head).toMatch(/ON CONFLICT \(task, subject_id\)/);
    expect(head).toMatch(/jev_shadow_reviews/);
  });

  it("records the read-only production checks R1 to R6", () => {
    for (const r of ["R1", "R2", "R3", "R4", "R5", "R6"]) expect(head).toMatch(new RegExp(`\\b${r}\\b`));
    expect(head).toContain("1,962,216");
    expect(head).toContain("611,085");
    expect(head).toMatch(/jev_shadow_reviews_prediction_id_fkey/);
    expect(head).toMatch(/jev_politics_admissions_politics_prediction_id_fkey/);
  });

  it("lists every long-window reader and how each is covered", () => {
    for (const reader of [
      "source_drift",
      "jev_gold_seed",
      "jev_regression_freeze",
      "jev_shadow_month_usage",
      "jev_budget_daily",
      "jev_alerts_auto_resolve",
      "blindspot_recall_veto_refresh",
      "ticker-relevance",
      "kap-pickup",
      "framing_next_headline",
      "daily-query",
      "jev-shadow-status",
      "merge-queue",
      "jev-cluster",
      "source_karne_refresh",
      "story",
      "archive-export",
      "cluster_topics_refresh",
    ]) {
      expect(head).toContain(reader);
    }
  });

  it("explains the kill switch and the scheduled-job behaviour", () => {
    expect(head).toMatch(/update cron\.job set active = false where jobname = 'jev-shadow-prune'/);
    expect(head).toMatch(/one transaction|single transaction/i);
  });

  it("carries a local-proof summary", () => {
    expect(head).toMatch(/LOCAL PROOF/);
    expect(head).toMatch(/PG15|PostgreSQL 15/);
  });
});

describe("102 FK index", () => {
  it("indexes jev_politics_admissions.politics_prediction_id (partial, non-concurrent, idempotent)", () => {
    expect(flat(code)).toMatch(
      /create index if not exists jev_politics_admissions_prediction_idx on public\.jev_politics_admissions \(politics_prediction_id\) where politics_prediction_id is not null;/,
    );
    expect(code).not.toMatch(/\bconcurrently\b/i);
  });

  it("explains why the index exists (set-null trigger would seq-scan per deleted row)", () => {
    expect(head).toMatch(/set[- ]null/i);
    expect(head).toMatch(/seq(uential)? scan/i);
  });
});

describe("102 jev_shadow_prune: signature, clamps, ordering", () => {
  it("has the exact signature, defaults and return shape", () => {
    expect(flat(fnHeader)).toMatch(
      /^create or replace function public\.jev_shadow_prune\( ?p_keep interval default interval '45 days', p_batch int default 20000, p_max_batches int default 20 ?\) returns table ?\( ?deleted bigint, batches int, cutoff timestamptz, note text ?\) language plpgsql security definer set search_path = ''/,
    );
  });

  it("floors the keep window at 21 days and never reassigns it", () => {
    expect(flat(fnBody)).toMatch(
      /v_keep interval := greatest\(coalesce\(p_keep, interval '45 days'\), interval '21 days'\);/,
    );
    // The declaration is `v_keep interval := ...`; a bare `v_keep :=` would be a reassignment.
    expect((fnBody.match(/\bv_keep\s*:=/g) ?? []).length).toBe(0);
  });

  it("clamps the batch size to 1000..50000 and the batch count to 1..200", () => {
    const f = flat(fnBody);
    expect(f).toMatch(/v_batch int := greatest\(1000, least\(coalesce\(p_batch, 20000\), 50000\)\);/);
    expect(f).toMatch(/v_max int := greatest\(1, least\(coalesce\(p_max_batches, 20\), 200\)\);/);
    expect((fnBody.match(/\bv_batch\s*:=/g) ?? []).length).toBe(0);
    expect((fnBody.match(/\bv_max\s*:=/g) ?? []).length).toBe(0);
  });

  it("takes the advisory lock, then computes the cutoff, then the rollup guard, then the scope, all before the delete", () => {
    const f = flat(fnBody);
    const iLock = f.indexOf("pg_try_advisory_xact_lock(pg_catalog.hashtextextended('jev_shadow_prune', 0))");
    const iCut = f.search(/cutoff := pg_catalog\.now\(\) - v_keep;/);
    const iRoll = f.indexOf("skipped: rollup behind");
    const iHi = f.search(/select p\.id into v_hi/);
    const iDel = f.search(/delete from public\.jev_shadow_predictions/);
    expect(iLock).toBeGreaterThan(-1);
    expect(iCut).toBeGreaterThan(iLock);
    expect(iRoll).toBeGreaterThan(iCut);
    expect(iHi).toBeGreaterThan(iRoll);
    expect(iDel).toBeGreaterThan(iHi);
  });

  it("returns 'skipped: busy' when the lock is held, without touching any table", () => {
    const f = flat(fnBody);
    expect(f).toMatch(
      /if not pg_catalog\.pg_try_advisory_xact_lock\(pg_catalog\.hashtextextended\('jev_shadow_prune', 0\)\) then note := 'skipped: busy'; return next; return; end if;/,
    );
  });

  it("returns 'skipped: rollup behind' when jev_shadow_daily is empty or older than the cutoff day", () => {
    const f = flat(fnBody);
    expect(f).toMatch(/select pg_catalog\.max\(d\.day\) into v_rolled from public\.jev_shadow_daily d;/);
    expect(f).toMatch(
      /if v_rolled is null or v_rolled < \(cutoff at time zone 'utc'\)::date then note := 'skipped: rollup behind'; return next; return; end if;/,
    );
  });

  it("scopes the run to the newest row older than the cutoff via the created_at index (id breaks created_at ties)", () => {
    const f = flat(fnBody);
    expect(f).toMatch(
      /select p\.id into v_hi from public\.jev_shadow_predictions p where p\.created_at < cutoff order by p\.created_at desc, p\.id desc limit 1;/,
    );
    expect(f).toMatch(/if v_hi is null then note := 'ok: nothing older than cutoff'; return next; return; end if;/);
  });

  it("walks an id keyset window and stops at a short window or the batch cap", () => {
    const w = flat(windowStmt);
    expect(w).toMatch(/where p\.id > v_lo and p\.id <= v_hi/);
    expect(w).toMatch(/order by p\.id limit v_batch/);
    const f = flat(fnBody);
    expect(f).toMatch(/v_lo := v_win_max;/);
    expect(f).toMatch(/exit when v_win_n < v_batch;/);
    expect(f).toMatch(/batches >= v_max/);
    expect(f).toMatch(/exit when v_win_n = 0;/);
    expect(f).toMatch(/note := 'ok: batch cap reached'/);
  });

  it("the window locator skips the row-local exemptions so survivors cannot starve the batch budget", () => {
    const w = flat(windowStmt);
    expect(w).toMatch(/p\.created_at < cutoff/);
    expect(w).toMatch(/p\.task not in \(/);
  });

  it("qualifies every relation (empty search_path): no bare table names after FROM/JOIN", () => {
    const bare = [...flat(fnBody).matchAll(/\b(?:from|join)\s+(?!public\.|pg_catalog\.|\()([a-z_]+)/g)].map(
      (m) => m[1],
    );
    expect(bare).toEqual([]);
  });
});

describe("102 jev_shadow_prune: the delete predicate", () => {
  it("is keyed by id inside the located window, and only deletes old rows", () => {
    const d = flat(deleteStmt);
    expect(d).toMatch(/^delete from public\.jev_shadow_predictions p where p\.id > v_lo and p\.id <= v_win_max/);
    expect(d).toMatch(/and p\.created_at < cutoff/);
  });

  it("(a) exempts rows with a human review (the FK cascades, so a naive delete would destroy verdicts)", () => {
    expect(flat(deleteStmt)).toMatch(
      /not exists \(select 1 from public\.jev_shadow_reviews r where r\.prediction_id = p\.id\)/,
    );
  });

  it("(b) exempts rows referenced by a politics admission", () => {
    expect(flat(deleteStmt)).toMatch(
      /not exists \(select 1 from public\.jev_politics_admissions a where a\.politics_prediction_id = p\.id\)/,
    );
  });

  it("(c) exempts gold-set articles, both by article_id and by the text subject_id", () => {
    const d = flat(deleteStmt);
    expect(d).toMatch(/not exists \(select 1 from public\.jev_gold_set g where g\.article_id = p\.article_id\)/);
    expect(d).toMatch(/not exists \(select 1 from public\.jev_gold_set g where g\.article_id::text = p\.subject_id\)/);
  });

  it("(d) exempts frozen regression items by subject_id", () => {
    expect(flat(deleteStmt)).toMatch(
      /not exists \(select 1 from public\.jev_regression_items i where i\.subject_id = p\.subject_id\)/,
    );
  });

  it("(f) exempts the low-volume reader- and spend-facing tasks", () => {
    const d = flat(deleteStmt);
    const m = d.match(/p\.task not in \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const listed = [...(m?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((x) => x[1]);
    expect([...listed].sort()).toEqual([...EXEMPT_TASKS].sort());
  });

  it("(g) exempts rows whose article or cluster belongs to a cluster that is still live", () => {
    const d = flat(deleteStmt);
    expect(d).toMatch(
      /not exists \(select 1 from public\.cluster_articles ca join public\.clusters c on c\.id = ca\.cluster_id where ca\.article_id = p\.article_id and c\.updated_at >= cutoff\)/,
    );
    expect(d).toMatch(
      /not exists \(select 1 from public\.clusters c where c\.id = p\.cluster_id and c\.updated_at >= cutoff\)/,
    );
  });

  it("(h) deletes a row only when its UTC day and task are already in the jev_shadow_daily rollup", () => {
    expect(flat(deleteStmt)).toMatch(
      /and exists \(select 1 from public\.jev_shadow_daily d where d\.day = \(p\.created_at at time zone 'utc'\)::date and d\.task = p\.task\)/,
    );
  });

  it("has exactly nine guard fragments (7 NOT EXISTS, 1 EXISTS, 1 task list), none of them optional", () => {
    const frags = exemptionFragments(deleteStmt);
    expect(frags.filter((f) => f.startsWith("not exists")).length).toBe(7);
    expect(frags.filter((f) => f.startsWith("exists")).length).toBe(1);
    expect(frags.filter((f) => f.startsWith("p.task not in")).length).toBe(1);
    expect(frags.length).toBe(9);
  });

  it("counts the rows the delete removed and advances the keyset", () => {
    const f = flat(fnBody);
    expect(f).toMatch(/get diagnostics v_n = row_count;/);
    expect(f).toMatch(/deleted := deleted \+ v_n;/);
    expect(f).toMatch(/batches := batches \+ 1;/);
  });
});

describe("102 grants", () => {
  it("revokes from public/anon/authenticated and grants execute to service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.jev_shadow_prune\(interval,\s*int(?:eger)?,\s*int(?:eger)?\)\s+from\s+public,\s*anon,\s*authenticated\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+[^;]*;/gi)].map((m) => m[0].replace(/\s+/g, " ").toLowerCase());
    expect(grants).toEqual([
      expect.stringMatching(
        /^grant execute on function public\.jev_shadow_prune\(interval, int(eger)?, int(eger)?\) to service_role;$/,
      ),
    ]);
  });

  it("never grants delete/insert/update/truncate/maintain to anyone", () => {
    for (const m of code.matchAll(/\bgrant\b[^;]*;/gi)) {
      expect(m[0]).not.toMatch(/\b(delete|insert|update|truncate|maintain|all)\b/i);
    }
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });

  it("the function comment says IRREVERSIBLE and names the kill switch", () => {
    // Adjacent string literals (separated by a newline) concatenate in SQL.
    const c = code.match(/comment\s+on\s+function\s+public\.jev_shadow_prune\([^)]*\)\s+is((?:\s*'(?:[^']|'')*')+)\s*;/i);
    expect(c).not.toBeNull();
    const text = [...(c?.[1] ?? "").matchAll(/'((?:[^']|'')*)'/g)].map((m) => m[1]).join("");
    expect(text).toMatch(/IRREVERSIBLE/);
    expect(text).toMatch(/update cron\.job set active = ?false where jobname = ''jev-shadow-prune''/);
    expect(text).toMatch(/21 days/);
    expect(text).toMatch(/service_role/);
  });
});

describe("102 schedule", () => {
  it("schedules jev-shadow-prune daily at 04:50 UTC with a 10-minute statement_timeout", () => {
    expect(flat(code)).toMatch(
      /cron\.schedule\('jev-shadow-prune', '50 4 \* \* \*', \$sql\$ set statement_timeout = '10min'; select \* from public\.jev_shadow_prune\(\); \$sql\$\)/,
    );
  });

  it("is guarded on pg_cron and idempotent (unschedule then schedule)", () => {
    const f = flat(code);
    expect(f).toMatch(/extname = 'pg_cron'/);
    expect(f).toMatch(/if exists \(select 1 from cron\.job where jobname = 'jev-shadow-prune'\) then perform cron\.unschedule\('jev-shadow-prune'\); end if;/);
    expect(f.indexOf("cron.unschedule")).toBeLessThan(f.indexOf("cron.schedule("));
  });

  it("does not collide with the other 04:xx jobs documented in the header", () => {
    expect(head).toMatch(/04:50/);
    expect(code.match(/cron\.schedule\(/g)?.length).toBe(1);
  });
});

describe("102 dry-run query in the header", () => {
  it("is a single read-only SELECT", () => {
    const dry = flat(dryRunSql(sql));
    expect(dry).toMatch(/^with k as \(select pg_catalog\.now\(\) - interval '\d+ days' as cutoff\) select /);
    expect(dry).toMatch(/count\(\*\)/);
    expect(dry).not.toMatch(/\b(delete|insert|update|truncate|drop|alter|create|grant)\b/);
    expect((dry.match(/;/g) ?? []).length).toBe(1);
  });

  it("carries exactly the same guards as the function's delete (no drift between rehearsal and deletion)", () => {
    expect(exemptionFragments(dryRunSql(sql))).toEqual(exemptionFragments(deleteStmt));
  });

  it("also filters on created_at before the cutoff", () => {
    expect(flat(dryRunSql(sql))).toMatch(/p\.created_at < k\.cutoff/);
  });
});
