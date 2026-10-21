import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JEV_REGRESSION_ITEM_LIMIT } from "../../supabase/functions/_shared/jev";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 104 ("jev-regression-freeze-660").
//
// 088 shipped the code side of the "runbook freeze" (JEV_REGRESSION_ITEM_LIMIT
// 700 per kind, JEV_REGRESSION_CONCURRENCY 32) and seeded the
// regression:regression_articles budget for 660 frozen articles, but the freeze
// itself was never run: prod still replays 180 items (120 articles + 60 pairs,
// the manual jev_regression_freeze(120, 60)). 104 freezes every jev_gold_set
// article, reusing 066's own statements so a later /admin "Seti dondur" press
// sees exactly the state a manual freeze would have produced.
//
// The contract pinned here:
//   - the freeze body is 066 section 5a (insert) + the 066 upgrade path
//     (update), copied, not re-invented;
//   - it takes 066's advisory lock key so it serializes with the button;
//   - the 700 guard literal is the code's JEV_REGRESSION_ITEM_LIMIT;
//   - it is additive: no pair insert, no delete/drop/truncate, no grant.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION_104 = resolve(MIGRATIONS_DIR, "104_jev_regression_freeze_660.sql");
const MIGRATION_066 = resolve(MIGRATIONS_DIR, "066_jev_regression.sql");
const DOC = resolve(REPO_ROOT, "docs", "jev-pack-slim.md");

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Comment-free, whitespace-collapsed, lower-cased form for equality checks. */
function norm(sql: string): string {
  return stripComments(sql).replace(/\s+/g, " ").trim().toLowerCase();
}

/** The header prose with the `-- ` markers removed and line breaks collapsed. */
function proseOf(sql: string): string {
  return sql
    .split("\n")
    .filter((l) => l.startsWith("--"))
    .map((l) => l.replace(/^--\s?/, ""))
    .join(" ")
    .replace(/\s+/g, " ");
}

/** Text of the balanced `( ... )` starting at the `(` at `openIdx`, parens included. */
function balanced(sql: string, openIdx: number): string {
  if (sql[openIdx] !== "(") throw new Error("balanced(): no '(' at index");
  let depth = 0;
  let inStr = false;
  for (let i = openIdx; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") {
      inStr = !inStr;
      continue;
    }
    if (inStr) continue;
    if (ch === "(") depth++;
    else if (ch === ")") {
      depth--;
      if (depth === 0) return sql.slice(openIdx, i + 1);
    }
  }
  throw new Error("balanced(): unterminated paren group");
}

interface ArticleInsert {
  /** The `jsonb_build_object( ... )` state expression, alias prefixes removed. */
  state: string;
  /** The token that follows the state expression (the in_gold literal). */
  inGold: string;
  /** The text of the whole statement up to its terminating `;` (or `)` of a CTE). */
  tail: string;
}

/**
 * The first `insert into public.jev_regression_items` in `code` (comment-free
 * SQL): in 066 that is section 5a (gold articles), in 104 the freeze insert.
 * The select-list differs only by table alias (066 reads the CTE alias `k`,
 * 104 reads `a`), so `k.`/`a.` column prefixes are dropped before comparison.
 */
function firstArticleInsert(code: string): ArticleInsert {
  const at = code.search(/insert\s+into\s+public\.jev_regression_items/i);
  if (at < 0) throw new Error("no insert into public.jev_regression_items");
  const fromInsert = code.slice(at);
  const jb = fromInsert.search(/jsonb_build_object\s*\(/i);
  if (jb < 0) throw new Error("no jsonb_build_object in insert");
  const open = fromInsert.indexOf("(", jb);
  const expr = balanced(fromInsert, open);
  const after = fromInsert.slice(open + expr.length);
  const inGold = /^\s*,\s*(true|false)\b/i.exec(after);
  if (!inGold) throw new Error("no in_gold literal after the state expression");
  return {
    state: expr
      .replace(/\b[ka]\.(title|description)\b/gi, "$1")
      .replace(/\s+/g, " ")
      .replace(/\(\s+/g, "(")
      .replace(/\s+\)/g, ")")
      .toLowerCase(),
    inGold: (inGold[1] as string).toLowerCase(),
    tail: after,
  };
}

/** The 066 upgrade statement (false -> true flag fix), whitespace-normalized. */
function upgradeUpdate(code: string): string {
  const m = /update\s+public\.jev_regression_items\s+i\b[\s\S]*?;/i.exec(code);
  if (!m) throw new Error("no 'update public.jev_regression_items i' statement");
  return m[0].replace(/\s+/g, " ").trim().toLowerCase();
}

/** The key inside `pg_advisory_xact_lock( [pg_catalog.]hashtext('<key>') )`. */
function advisoryKey(code: string): string | undefined {
  return /pg_advisory_xact_lock\s*\(\s*(?:pg_catalog\.)?hashtext\s*\(\s*'([^']+)'\s*\)\s*\)/i.exec(
    code,
  )?.[1];
}

let sql = "";
let code = "";
let sql066 = "";
let code066 = "";
let doc = "";
let prose = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION_104, "utf8");
  code = stripComments(sql);
  prose = proseOf(sql);
  sql066 = readFileSync(MIGRATION_066, "utf8");
  code066 = stripComments(sql066);
  doc = readFileSync(DOC, "utf8");
});

describe("migration 104_jev_regression_freeze_660.sql (SQL contract)", () => {
  it("is wrapped in begin; ... commit;", () => {
    const trimmed = code.trim();
    expect(trimmed).toMatch(/^begin;/i);
    expect(trimmed).toMatch(/commit;$/i);
  });

  it("sets local lock_timeout 5s and statement_timeout 60s before any statement", () => {
    const lockTo = code.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const stmtTo = code.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i);
    expect(lockTo).toBeGreaterThan(-1);
    expect(stmtTo).toBeGreaterThan(-1);
    const firstWrite = code.search(/\b(insert|update)\b/i);
    const lock = code.search(/pg_advisory_xact_lock/i);
    expect(lockTo).toBeLessThan(lock);
    expect(stmtTo).toBeLessThan(lock);
    expect(lockTo).toBeLessThan(firstWrite);
    expect(stmtTo).toBeLessThan(firstWrite);
  });

  it("records itself in the migration ledger idempotently, as the last statement", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'104'\s*,\s*'104_jev_regression_freeze_660'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
  });

  it("takes the SAME transaction-scoped advisory lock key as 066's jev_regression_freeze()", () => {
    const k066 = advisoryKey(code066);
    const k104 = advisoryKey(code);
    expect(k066).toBe("jev_regression_freeze");
    expect(k104).toBe(k066);
    // xact-scoped (released at commit/rollback), never the session-level variant.
    expect(code).not.toMatch(/pg_advisory_lock\s*\(/i);
    expect(code).toMatch(/\bperform\s+pg_catalog\.pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtext\s*\(/i);
  });

  it("orders its steps: lock -> insert -> upgrade update -> guard -> ledger", () => {
    const lock = code.search(/pg_advisory_xact_lock/i);
    const ins = code.search(/insert\s+into\s+public\.jev_regression_items/i);
    const upd = code.search(/update\s+public\.jev_regression_items/i);
    const guard = code.search(/raise\s+exception/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(lock).toBeGreaterThan(-1);
    expect(ins).toBeGreaterThan(lock);
    expect(upd).toBeGreaterThan(ins);
    expect(guard).toBeGreaterThan(upd);
    expect(ledger).toBeGreaterThan(guard);
  });

  describe("freeze insert (066 section 5a)", () => {
    it("inserts kind='article' gold rows with on conflict (kind, subject_id) do nothing", () => {
      const at = code.search(/insert\s+into\s+public\.jev_regression_items/i);
      expect(at).toBeGreaterThan(-1);
      const stmt = code.slice(at, code.indexOf(";", at));
      expect(norm(stmt)).toMatch(
        /^insert into public\.jev_regression_items \(kind, subject_id, state, in_gold\) select 'article', a\.id::text,/,
      );
      expect(norm(stmt)).toMatch(/on conflict \(kind, subject_id\) do nothing$/);
    });

    it("selects from jev_gold_set joined to articles in gold order (added_at, article_id)", () => {
      const at = code.search(/insert\s+into\s+public\.jev_regression_items/i);
      const stmt = norm(code.slice(at, code.indexOf(";", at)));
      expect(stmt).toContain("from public.jev_gold_set g join public.articles a on a.id = g.article_id");
      expect(stmt).toContain("order by g.added_at, g.article_id");
      // The inner join is the point: a gold row whose article is gone cannot
      // be frozen (state needs the title), and the guard below only counts
      // gold rows that do join.
      expect(stmt).not.toMatch(/left\s+join/);
    });

    it("has NO limit clause (every missing gold article is inserted)", () => {
      const at = code.search(/insert\s+into\s+public\.jev_regression_items/i);
      const stmt = norm(code.slice(at, code.indexOf(";", at)));
      expect(stmt).not.toMatch(/\blimit\b/);
    });

    it("state expression equals 066 section 5a's jsonb_build_object(...) (alias-normalized)", () => {
      const a066 = firstArticleInsert(code066);
      const a104 = firstArticleInsert(code);
      expect(a066.inGold).toBe("true"); // sanity: the extractor picked 5a, not 5b
      expect(a104.inGold).toBe("true");
      expect(a104.state).toBe(a066.state);
      // Sanity: not a vacuous comparison.
      expect(a104.state).toContain("'description', left(coalesce(description, ''), 600)");
    });
  });

  describe("upgrade path (066: in_gold false -> true)", () => {
    it("update statement equals 066's upgrade statement", () => {
      const u066 = upgradeUpdate(code066);
      const u104 = upgradeUpdate(code);
      expect(u066).toContain("set in_gold = true");
      expect(u066).toContain("not i.in_gold");
      expect(u104).toBe(u066);
    });

    it("is the only update, and it only touches public.jev_regression_items", () => {
      const updates = [...code.matchAll(/\bupdate\s+([a-z_.]+)/gi)].map((m) => m[1]);
      expect(updates).toEqual(["public.jev_regression_items"]);
    });
  });

  describe("guard", () => {
    it("raises when article items exceed 700, and 700 is JEV_REGRESSION_ITEM_LIMIT", () => {
      const m = /v_articles\s*>\s*(\d+)/i.exec(code);
      expect(m).not.toBeNull();
      expect(Number((m as RegExpExecArray)[1])).toBe(JEV_REGRESSION_ITEM_LIMIT);
      // The count it compares is the article kind only (fetchRegressionItems
      // limits per kind; pairs have their own 700).
      expect(norm(code)).toMatch(
        /select count\(\*\)(::int)? into v_articles from public\.jev_regression_items [a-z]* ?where [a-z.]*kind = 'article'/,
      );
    });

    it("raises when a gold-set article still lacks an in_gold item", () => {
      const m = /select\s+count\(\*\)(?:::int)?\s+into\s+v_unfrozen[\s\S]*?;/i.exec(code);
      expect(m).not.toBeNull();
      const q = norm((m as RegExpExecArray)[0]);
      expect(q).toContain("from public.jev_gold_set g");
      expect(q).toContain("not exists");
      expect(q).toMatch(/i\.kind = 'article'/);
      expect(q).toMatch(/i\.subject_id = g\.article_id::text/);
      expect(q).toMatch(/i\.in_gold/);
      expect(code).toMatch(/v_unfrozen\s*>\s*0/i);
    });

    it("uses two raise exception statements (cap + completeness), no warnings in their place", () => {
      expect([...code.matchAll(/raise\s+exception/gi)].length).toBe(2);
    });
  });

  describe("additive-only", () => {
    it("never inserts or updates pair items", () => {
      expect(code).not.toMatch(/'pair'/i);
      // The only inserts: the freeze insert and the ledger.
      const targets = [...code.matchAll(/\binsert\s+into\s+([a-z_.]+)/gi)].map((m) => m[1]);
      expect(targets).toEqual(["public.jev_regression_items", "supabase_migrations.schema_migrations"]);
    });

    it("contains no delete, drop or truncate", () => {
      expect(code).not.toMatch(/\bdelete\b/i);
      expect(code).not.toMatch(/\bdrop\b/i);
      expect(code).not.toMatch(/\btruncate\b/i);
    });

    it("contains no grant or revoke and no DDL (no create/alter)", () => {
      expect(code).not.toMatch(/\bgrant\b/i);
      expect(code).not.toMatch(/\brevoke\b/i);
      expect(code).not.toMatch(/\bcreate\b/i);
      expect(code).not.toMatch(/\balter\b/i);
    });

    it("is pure ASCII", () => {
      expect(sql).toMatch(/^[\x00-\x7F]*$/);
    });
  });

  describe("header (operator-facing record)", () => {
    it("records the prod pre-checks F1-F3 and the F3 conclusion", () => {
      expect(prose).toMatch(/\bF1\b/);
      expect(prose).toMatch(/\bF2\b/);
      expect(prose).toMatch(/\bF3\b/);
      expect(prose).toContain("2026-10-18");
      expect(prose).toContain("120"); // 120 frozen articles
      expect(prose).toContain("540"); // gold articles not yet frozen
      expect(prose).toContain("660");
      expect(prose).toMatch(/threw before startRun/i);
    });

    it("documents the cost, the verification queries and the first 660-article replay", () => {
      expect(prose).toMatch(/about 720 calls/i);
      expect(prose).toMatch(/about 0\.8M tokens/i);
      expect(prose).toContain("1.2M");
      expect(prose).toContain("2026-10-25 04:20 UTC");
      expect(prose).toContain("jev-regression-weekly");
      expect(prose).toContain("Seti dondur");
      // The two verification queries, each on a single header line.
      expect(sql).toMatch(
        /^--\s+select kind, count\(\*\) n, count\(\*\) filter \(where in_gold\) gold from public\.jev_regression_items group by kind order by kind;$/m,
      );
      expect(sql).toMatch(
        /^--\s+select count\(\*\) from public\.jev_gold_set g where not exists \(select 1 from public\.jev_regression_items i where i\.kind='article' and i\.subject_id=g\.article_id::text and i\.in_gold\);$/m,
      );
    });
  });
});

describe("docs/jev-pack-slim.md Precondition section", () => {
  let precondition = "";

  beforeAll(() => {
    const m = /## Precondition([\s\S]*?)(?=\n## )/.exec(doc);
    precondition = m ? (m[1] as string) : "";
  });

  it("mentions migration 104 and the 'Seti dondur' button", () => {
    expect(doc).toContain("104");
    expect(doc).toContain("Seti dondur");
    expect(precondition).toContain("104");
    expect(precondition).toContain("Seti dondur");
  });

  it("no longer claims the 2026-10-04 run was a 660-item replay", () => {
    expect(precondition).not.toMatch(/Two same-set 660-item regression replays exist/);
    expect(precondition).not.toMatch(/The first is the Sunday\s+2026-10-04/);
    // States the truth instead: runs 5 and 6 (10-04, 10-11) replayed 180 items.
    expect(precondition).toMatch(/180/);
    expect(precondition).toContain("2026-10-04");
    expect(precondition).toContain("2026-10-11");
  });

  it("starts the count after 104 and names the first candidate run", () => {
    expect(precondition).toContain("2026-10-25 04:20 UTC");
    expect(precondition).toContain("jev_regression_trigger()");
    expect(precondition).toMatch(/660 \+ pairs/);
    expect(precondition).toMatch(/status\s+`?'?ok'?`?/);
  });

  it("warns not to press 'Seti dondur' while the precondition is collected", () => {
    expect(precondition).toMatch(/do not press/i);
    expect(precondition).toMatch(/100/); // tops pairs up to 100
    expect(precondition).toMatch(/resets? the count/i);
  });
});
