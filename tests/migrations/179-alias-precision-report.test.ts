import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { assertLiveReady } from "../_helpers/live-db";
import { ALIAS_PRECISION_REPORT_LOW_BELOW, TICKER_HIDE_BELOW, relevanceKey } from "@/lib/finance/ticker-relevance";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 179 ("alias_precision_report"), h72-kap-4.
//
// prune_generic_aliases (052, 058; nightly cron 'alias-prune') measures VOLUME only: it disables an auto alias that hits more
// than 100 distinct articles in 14 days. A dictionary word, a surname or a district that is rarely written never trips it,
// however often Jev's ticker_relevance task says the match is wrong. On 2026-11-08, 30 days, 33 enabled auto alias rows had
// at least 8 Jev-scored hits of which at least 70% scored under 0.2 (eregli to EREGL 55 of 55 scored rows low, nobel to
// NOBEL 41 of 41, doruk to DFKTR 44 of 44, ...), and about 70 of their rows stayed visible in /ekonomi.
//
// 179 adds two functions and nothing else:
//   public.low_precision_aliases(p_days, p_min_scored, p_low_share)          read-only report (language sql, stable)
//   public.disable_low_precision_aliases(p_apply default false, same three)  p_apply = true sets enabled = false on exactly
//                                                                           the reported auto rows
// Neither is called or scheduled by the migration, prune_generic_aliases is not touched (a second overload would make the
// `select public.prune_generic_aliases()` of the cron and the zero-argument rpc of kap-ingest ambiguous), and no
// article_tickers row is ever removed.
//
// This file pins the statements (one transaction, lock_timeout, the two functions, the grants, the ledger row), both bodies
// (search_path, the reads, the thresholds, the manual-sibling and origin = 'auto' predicates, the apply guard), what the
// migration does NOT do, the header, the dry-run and the manifest entry. The live block at the end runs both functions
// against fixture rows through psql when TAYF_PSQL is set (every case rolled back), including the spec's (nobel, NOBEL).
//
// SQL is scanned by character, never with a nested-quantifier regex (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS_DIR, "179_alias_precision_report.sql");
const MIGRATION_052 = resolve(MIGRATIONS_DIR, "052_alias_hygiene.sql");
const MIGRATION_058 = resolve(MIGRATIONS_DIR, "058_finance_hardening.sql");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "179-alias-precision-report-dryrun.sql");
const KAP_INGEST = resolve(ROOT, "supabase", "functions", "kap-ingest", "index.ts");

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('179', '179_alias_precision_report') on conflict do nothing";
const LOW_SIG = "public.low_precision_aliases(int, int, numeric)";
const DISABLE_SIG = "public.disable_low_precision_aliases(boolean, int, int, numeric)";
const REVOKE_LOW = `revoke all on function ${LOW_SIG} from public, anon, authenticated`;
const GRANT_LOW = `grant execute on function ${LOW_SIG} to service_role`;
const REVOKE_DISABLE = `revoke all on function ${DISABLE_SIG} from public, anon, authenticated`;
const GRANT_DISABLE = `grant execute on function ${DISABLE_SIG} to service_role`;
const RETURNS_TABLE = "returns table (alias text, ticker text, hits int, scored int, low int, visible int)";
const RETURNS_TABLE_DISABLE =
  "returns table (alias text, ticker text, hits int, scored int, low int, visible int, via text)";
const MANUAL_SIBLING =
  "not exists (select 1 from public.bist_aliases m where m.alias = b.alias and m.origin = 'manual' and m.enabled)";
// The candidates: the report's rows tagged 'report'. Read once (materialized), the same in both branches.
const CAND_CTE =
  "cand as materialized (select c.alias, c.ticker, c.hits, c.scored, c.low, c.visible, 'report'::text as via from public.low_precision_aliases(p_days, p_min_scored, p_low_share) c)";
// Rule B's sibling: an untraded auto row that 171/177/178 hid only because a traded or manual sibling was enabled, and whose
// last such sibling is among the candidates. Switching the candidates off would release it (178's rule B), so it goes too.
const SIB_CTE = [
  "sib as (select b.alias, b.ticker, 0, 0, 0, 0, 'rule_b_sibling'::text from public.bist_aliases b",
  "where b.origin = 'auto' and b.enabled",
  "and exists (select 1 from cand c where c.alias = b.alias)",
  "and not exists (select 1 from cand c where c.alias = b.alias and c.ticker = b.ticker)",
  "and not exists (select 1 from public.bist_companies co where co.shares_traded and b.ticker = any (co.tickers))",
  "and exists (select 1 from public.bist_aliases o where o.alias = b.alias and o.enabled and o.ticker <> b.ticker",
  "and (o.origin = 'manual' or exists (select 1 from public.bist_companies c2 where c2.shares_traded and c2.tickers @> array[o.ticker])))",
  "and not exists (select 1 from public.bist_aliases o where o.alias = b.alias and o.enabled and o.ticker <> b.ticker",
  "and not exists (select 1 from cand c where c.alias = o.alias and c.ticker = o.ticker)",
  "and (o.origin = 'manual' or exists (select 1 from public.bist_companies c2 where c2.shares_traded and c2.tickers @> array[o.ticker]))))",
].join(" ");
const ALLROWS_CTE = "allrows as (select * from cand union all select * from sib)";
const ORDER_ALLROWS = "order by c.via = 'report' desc, c.low desc, c.alias, c.ticker";

// -- character-scan helpers (no regular expression runs over SQL text) ----------

function isTagChar(ch: string): boolean {
  return ch === "_" || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9");
}

/** The dollar-quote tag that opens at `i` ("$$", "$fn$"), or "" when none opens there. */
function dollarTagAt(sql: string, i: number): string {
  if (sql.charAt(i) !== "$") return "";
  let j = i + 1;
  while (j < sql.length && isTagChar(sql.charAt(j))) j += 1;
  return sql.charAt(j) === "$" ? sql.slice(i, j + 1) : "";
}

/** Index just past the single-quoted string that opens at `i`. */
function skipSingle(sql: string, i: number): number {
  let j = i + 1;
  while (j < sql.length) {
    if (sql.charAt(j) === "'") {
      if (sql.charAt(j + 1) === "'") {
        j += 2;
        continue;
      }
      break;
    }
    j += 1;
  }
  return j + 1;
}

/** Index just past the quoted string or dollar-quoted body that opens at `i`; `i` itself when none opens there. */
function skipQuoted(sql: string, i: number): number {
  if (sql.charAt(i) === "'") return skipSingle(sql, i);
  const tag = dollarTagAt(sql, i);
  if (tag) {
    const end = sql.indexOf(tag, i + tag.length);
    return end < 0 ? sql.length : end + tag.length;
  }
  return i;
}

/** Removes `--` comments everywhere (function bodies included; newline kept); single-quoted strings are copied verbatim. */
function stripComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      const stop = skipSingle(sql, i);
      out += sql.slice(i, stop);
      i = stop;
    } else if (ch === "-" && sql.charAt(i + 1) === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** Splits comment-free SQL on `;`, not inside a quoted string or a dollar-quoted body. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < sql.length) {
    const stop = skipQuoted(sql, i);
    if (stop > i) {
      cur += sql.slice(i, stop);
      i = stop;
      continue;
    }
    if (sql.charAt(i) === ";") {
      if (cur.trim() !== "") out.push(cur.trim());
      cur = "";
    } else {
      cur += sql.charAt(i);
    }
    i += 1;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** One space between tokens, and no space just inside parentheses. */
const squash = (s: string): string => s.split(/\s+/).filter(Boolean).join(" ").split("( ").join("(").split(" )").join(")");

/** Identifier-like words of the text, lower case. */
function wordsOf(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || ch === "_" || (ch >= "0" && ch <= "9")) {
      cur += ch;
    } else if (cur) {
      out.push(cur);
      cur = "";
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** How many times `needle` occurs in `text` (non-overlapping). */
function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/** The text between the first and the last `$fn$` of a create-function statement. */
function bodyOf(stmt: string): string {
  const open = stmt.indexOf("$fn$");
  const close = stmt.lastIndexOf("$fn$");
  return open >= 0 && close > open ? stmt.slice(open + "$fn$".length, close).trim() : "";
}

const raw = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
const code = stripComments(raw);
const statements = splitStatements(code).map(squash);
const lowStmt = statements.find((s) => s.startsWith("create or replace function public.low_precision_aliases(")) ?? "";
const disableStmt = statements.find((s) => s.startsWith("create or replace function public.disable_low_precision_aliases(")) ?? "";
const lowBody = bodyOf(lowStmt);
const disableBody = bodyOf(disableStmt);

/** Everything the migration runs outside the two function bodies. */
const outsideBodies = statements.filter((s) => s !== lowStmt && s !== disableStmt);

describe("179 file and statements", () => {
  it("exists as supabase/migrations/179_alias_precision_report.sql", () => {
    expect(existsSync(MIGRATION)).toBe(true);
    expect(raw.startsWith("-- 179_alias_precision_report.sql")).toBe(true);
  });

  it("is one transaction: begin, lock_timeout, the two functions, their comments, revoke and grant per function, the ledger row, commit", () => {
    const heads = statements.map((s) => s.slice(0, 70));
    expect(statements, heads.join("\n")).toHaveLength(12);
    expect(statements[0]).toBe("begin");
    expect(statements[1]).toBe("set local lock_timeout = '5s'");
    expect(statements[2]).toBe(lowStmt);
    expect(statements[3]).toBe(disableStmt);
    expect(statements[4]?.startsWith(`comment on function ${LOW_SIG} is '`), heads[4]).toBe(true);
    expect(statements[5]?.startsWith(`comment on function ${DISABLE_SIG} is '`), heads[5]).toBe(true);
    expect(statements[6]).toBe(REVOKE_LOW);
    expect(statements[7]).toBe(GRANT_LOW);
    expect(statements[8]).toBe(REVOKE_DISABLE);
    expect(statements[9]).toBe(GRANT_DISABLE);
    expect(statements[10]).toBe(LEDGER_STMT);
    expect(statements[11]).toBe("commit");
    expect(countOf(code, "begin;")).toBe(1);
    expect(countOf(code, "commit;")).toBe(1);
  });

  it("records itself in the ledger exactly once, as the last statement before commit", () => {
    expect(countOf(raw, "insert into supabase_migrations.schema_migrations")).toBe(1);
    expect(countOf(raw, "'179_alias_precision_report'")).toBe(1);
    expect(statements[statements.length - 2]).toBe(LEDGER_STMT);
  });

  it("takes lock_timeout before anything that creates or replaces an object", () => {
    expect(code.indexOf("set local lock_timeout = '5s'")).toBeGreaterThan(code.indexOf("begin;"));
    expect(code.indexOf("set local lock_timeout = '5s'")).toBeLessThan(code.indexOf("create or replace function"));
  });

  it("creates exactly the two functions and no table, index, trigger, column, view or cron job", () => {
    expect(statements.filter((s) => s.startsWith("create "))).toEqual([lowStmt, disableStmt]);
    for (const w of ["alter", "drop", "truncate", "trigger", "index", "view", "table_privileges"]) {
      expect(wordsOf(code), w).not.toContain(w);
    }
    // `create table` is how the two RETURNS TABLE clauses read; there is no create-table statement
    expect(statements.filter((s) => s.startsWith("create table"))).toEqual([]);
  });

  it("the only statement outside the function bodies that writes a row is the ledger insert, and there is no top-level select", () => {
    expect(outsideBodies.filter((s) => s.startsWith("insert "))).toEqual([LEDGER_STMT]);
    for (const s of outsideBodies) {
      expect(s.startsWith("select "), s.slice(0, 60)).toBe(false);
      expect(s.startsWith("update "), s.slice(0, 60)).toBe(false);
      expect(s.startsWith("delete "), s.slice(0, 60)).toBe(false);
      expect(s.startsWith("perform "), s.slice(0, 60)).toBe(false);
    }
  });

  it("neither calls nor schedules the functions: no top-level select of either, no cron.schedule, no pg_cron name", () => {
    for (const s of outsideBodies) {
      const mentionsDisable = s.includes("disable_low_precision_aliases(");
      if (mentionsDisable) {
        expect(s.startsWith("comment on function ") || s.startsWith("revoke ") || s.startsWith("grant "), s.slice(0, 60)).toBe(true);
      }
    }
    expect(code).not.toContain("select public.disable_low_precision_aliases");
    expect(code).not.toContain("select * from public.disable_low_precision_aliases");
    expect(code).not.toContain("cron.schedule");
    expect(code).not.toContain("cron.unschedule");
    expect(code).not.toContain("cron.job");
    expect(wordsOf(code)).not.toContain("cron");
  });

  it("never deletes article_tickers (or anything else): no delete, truncate or insert word in either function", () => {
    expect(code).not.toContain("delete from public.article_tickers");
    for (const body of [lowBody, disableBody]) {
      for (const w of ["delete", "truncate", "insert", "drop", "alter", "copy"]) {
        expect(wordsOf(body), w).not.toContain(w);
      }
    }
    expect(wordsOf(code)).not.toContain("delete");
    expect(wordsOf(code)).not.toContain("truncate");
  });

  it("leaves prune_generic_aliases untouched: not redefined, not replaced, not overloaded, not even named in the code", () => {
    expect(wordsOf(code)).not.toContain("prune_generic_aliases");
    expect(code).not.toContain("function public.prune_generic_aliases");
    expect(wordsOf(code)).not.toContain("alias_prune");
    // the ambiguity the spec warns about is real: the cron body and kap-ingest both call it with no arguments
    const m052 = readFileSync(MIGRATION_052, "utf8");
    expect(m052).toContain("cron.schedule('alias-prune', '20 4 * * *', $sql$ select public.prune_generic_aliases(); $sql$)");
    expect(readFileSync(KAP_INGEST, "utf8")).toContain('supabase.rpc("prune_generic_aliases")');
    expect(readFileSync(MIGRATION_058, "utf8")).toContain(
      "create or replace function public.prune_generic_aliases(p_days int default 14, p_max_hits int default 100)",
    );
  });
});

describe("179 privileges", () => {
  it("revokes both functions from public, anon and authenticated, then grants service_role (Supabase hands EXECUTE to anon and authenticated at creation)", () => {
    for (const stmt of [REVOKE_LOW, GRANT_LOW, REVOKE_DISABLE, GRANT_DISABLE]) expect(statements).toContain(stmt);
    expect(statements.indexOf(REVOKE_LOW)).toBeGreaterThan(statements.indexOf(lowStmt));
    expect(statements.indexOf(REVOKE_DISABLE)).toBeGreaterThan(statements.indexOf(disableStmt));
    expect(statements.indexOf(GRANT_LOW)).toBeGreaterThan(statements.indexOf(REVOKE_LOW));
    expect(statements.indexOf(GRANT_DISABLE)).toBeGreaterThan(statements.indexOf(REVOKE_DISABLE));
  });

  it("grants only EXECUTE and only to service_role; nothing goes to public, anon or authenticated", () => {
    const grants = statements.filter((s) => s.startsWith("grant "));
    expect(grants).toEqual([GRANT_LOW, GRANT_DISABLE]);
    expect(code).not.toContain("to public");
    expect(code).not.toContain("to anon");
    expect(code).not.toContain("to authenticated");
    expect(code).not.toContain("grant all");
  });

  it("neither function is SECURITY DEFINER: the caller's own table privileges apply", () => {
    expect(wordsOf(lowStmt)).not.toContain("security");
    expect(wordsOf(disableStmt)).not.toContain("security");
    expect(wordsOf(code)).not.toContain("definer");
  });

  it("both functions have an empty search_path, and every function they call is schema-qualified", () => {
    expect(countOf(lowStmt, "set search_path = ''")).toBe(1);
    expect(countOf(disableStmt, "set search_path = ''")).toBe(1);
    for (const body of [lowBody, disableBody]) {
      for (const fn of ["count(", "now(", "make_interval("]) {
        expect(countOf(body, fn), fn).toBe(countOf(body, `pg_catalog.${fn}`));
      }
      // every relation is public.<name>
      expect(countOf(body, " from ") + countOf(body, " join ") + countOf(body, " update ")).toBeGreaterThan(0);
      expect(wordsOf(body)).not.toContain("now_utc");
    }
  });
});

describe("179 low_precision_aliases (the report)", () => {
  it("has the spec's signature: p_days 30, p_min_scored 8, p_low_share 0.7 and the six-column table", () => {
    expect(lowStmt.startsWith("create or replace function public.low_precision_aliases(p_days int default 30, p_min_scored int default 8, p_low_share numeric default 0.7) ")).toBe(true);
    expect(lowStmt).toContain(RETURNS_TABLE);
  });

  it("is language sql and stable", () => {
    expect(lowStmt).toContain("language sql stable set search_path = '' as $fn$");
    expect(wordsOf(lowStmt)).not.toContain("volatile");
    expect(wordsOf(lowStmt)).not.toContain("plpgsql");
  });

  it("reads article_tickers (matched_on = 'alias:' || alias, published_at inside the window), auto and enabled bist_aliases, and Jev's ticker_relevance rows", () => {
    expect(lowBody).toContain("from public.bist_aliases b join public.article_tickers t on t.ticker = b.ticker");
    expect(lowBody).toContain("t.matched_on = 'alias:' || b.alias");
    expect(lowBody).toContain("t.published_at >= pg_catalog.now() - pg_catalog.make_interval(days => p_days)");
    expect(lowBody).toContain("left join public.jev_shadow_predictions p on p.task = 'ticker_relevance'");
    expect(lowBody).toContain("p.subject_id = t.article_id::text || ':' || t.ticker");
  });

  it("builds Jev's subject key exactly as the relevance gate does (article_id:ticker)", () => {
    expect(relevanceKey("ARTICLE", "TICKER")).toBe("ARTICLE:TICKER");
    expect(lowBody).toContain("t.article_id::text || ':' || t.ticker");
  });

  it("counts a row as low below the line baked into 179's SQL (ALIAS_PRECISION_REPORT_LOW_BELOW, 0.2) and scored as a non-null jev_prob", () => {
    // h176-ekonomi-1: the reader gate moved to 0.35; 179 is applied and keeps its 0.2, so the report has its own constant.
    expect(ALIAS_PRECISION_REPORT_LOW_BELOW).toBe(0.2);
    expect(TICKER_HIDE_BELOW).toBeGreaterThanOrEqual(ALIAS_PRECISION_REPORT_LOW_BELOW);
    expect(lowBody).toContain(`filter (where p.jev_prob < ${ALIAS_PRECISION_REPORT_LOW_BELOW})`);
    expect(lowBody).toContain("pg_catalog.count(p.jev_prob)::int as scored");
    expect(lowBody).toContain("pg_catalog.count(*)::int as hits");
  });

  it("computes visible as hits minus low (rows that are unscored or at least 0.2, i.e. what the feed still shows)", () => {
    expect(lowBody).toContain("a.hits - a.low as visible");
  });

  it("keeps only origin = 'auto' and enabled rows", () => {
    expect(lowBody).toContain("where b.origin = 'auto' and b.enabled");
    expect(lowBody).not.toContain("origin = 'manual' then");
  });

  it("excludes any alias text that has an enabled manual row on ANY ticker (the manual-sibling exclusion)", () => {
    expect(lowBody).toContain(MANUAL_SIBLING);
    // the exclusion looks at the alias text only: no ticker comparison in it
    const at = lowBody.indexOf(MANUAL_SIBLING);
    expect(lowBody.slice(at, at + MANUAL_SIBLING.length)).not.toContain("ticker");
  });

  it("applies the thresholds: scored >= p_min_scored, a non-zero scored count, low >= p_low_share * scored (numeric arithmetic)", () => {
    expect(lowBody).toContain("where a.scored >= p_min_scored and a.scored > 0 and a.low >= p_low_share * a.scored");
  });

  it("returns a deterministic order: most low rows first, then alias and ticker", () => {
    expect(lowBody).toContain("order by a.low desc, a.alias, a.ticker");
  });

  it("groups by (alias, ticker), the key of bist_aliases, so a shared alias reports each ticker on its own", () => {
    expect(lowBody).toContain("group by b.alias, b.ticker");
  });
});

describe("179 disable_low_precision_aliases (the apply switch)", () => {
  it("has p_apply boolean default false first, then the same three thresholds with the same defaults", () => {
    expect(
      disableStmt.startsWith(
        "create or replace function public.disable_low_precision_aliases(p_apply boolean default false, p_days int default 30, p_min_scored int default 8, p_low_share numeric default 0.7) ",
      ),
    ).toBe(true);
    expect(wordsOf(disableStmt.slice(0, disableStmt.indexOf(" returns ")))).toContain("p_apply");
    expect(disableStmt).not.toContain("p_apply boolean default true");
    expect(disableStmt).not.toContain("p_apply boolean, ");
    expect(disableStmt).not.toContain("p_apply boolean)");
  });

  it("returns the report's six columns plus a trailing via text column ('report' or 'rule_b_sibling')", () => {
    expect(disableStmt).toContain(RETURNS_TABLE_DISABLE);
    expect(disableStmt).not.toContain(RETURNS_TABLE);
    expect(lowStmt).not.toContain(", via text");
    expect(disableStmt).toContain("language plpgsql set search_path = '' as $fn$");
    expect(wordsOf(disableStmt)).not.toContain("stable");
  });

  it("takes its candidates from low_precision_aliases() with the caller's thresholds in both branches, tagged via = 'report'", () => {
    expect(countOf(disableBody, "from public.low_precision_aliases(p_days, p_min_scored, p_low_share) c")).toBe(2);
    expect(countOf(disableBody, CAND_CTE)).toBe(2);
  });

  it("adds the rule-B siblings in both branches from one CTE chain: cand, sib, allrows (never a CTE called rows)", () => {
    expect(countOf(disableBody, SIB_CTE)).toBe(2);
    expect(countOf(disableBody, ALLROWS_CTE)).toBe(2);
    // the update reads allrows, and so does the select of each branch
    expect(countOf(disableBody, "from allrows c")).toBe(3);
    expect(wordsOf(disableBody)).not.toContain("rows");
    // the order of the CTEs: candidates first, then the siblings that depend on them, then their union
    for (const at of [disableBody.indexOf(CAND_CTE), disableBody.lastIndexOf(CAND_CTE)]) {
      const sibAt = disableBody.indexOf(SIB_CTE, at);
      expect(sibAt, "sib after cand").toBeGreaterThan(at);
      expect(disableBody.indexOf(ALLROWS_CTE, sibAt), "allrows after sib").toBeGreaterThan(sibAt);
    }
  });

  it("a sibling is an untraded auto row that rule B (171/177/178) hides only while a traded or manual sibling is enabled, and whose last such sibling is a candidate", () => {
    const at = disableBody.indexOf(SIB_CTE);
    expect(at).toBeGreaterThan(-1);
    const sib = disableBody.slice(at, at + SIB_CTE.length);
    // untraded: no traded company holds the ticker (rule B's own test on the attaching row)
    expect(sib).toContain("not exists (select 1 from public.bist_companies co where co.shares_traded and b.ticker = any (co.tickers))");
    // rule B blocks it today: another enabled sibling is manual or traded
    expect(sib).toContain("exists (select 1 from public.bist_aliases o where o.alias = b.alias and o.enabled and o.ticker <> b.ticker and (o.origin = 'manual' or exists (select 1 from public.bist_companies c2 where c2.shares_traded and c2.tickers @> array[o.ticker])))");
    // and no manual or traded sibling outside the candidates keeps blocking it after the switch
    expect(sib).toContain("not exists (select 1 from cand c where c.alias = o.alias and c.ticker = o.ticker)");
    // it is not a candidate itself, and its alias has one
    expect(sib).toContain("exists (select 1 from cand c where c.alias = b.alias) and not exists (select 1 from cand c where c.alias = b.alias and c.ticker = b.ticker)");
    // auto and enabled only: a manual row is never switched off
    expect(sib).toContain("where b.origin = 'auto' and b.enabled");
    // the predicates are rule B's: the same two shapes as 178's resolver
    const resolver178 = readFileSync(resolve(MIGRATIONS_DIR, "178_retail_catalog_ticker_gate.sql"), "utf8");
    const flat178 = squash(stripComments(resolver178));
    expect(flat178).toContain("not exists (select 1 from public.bist_companies c where c.shares_traded and al.ticker = any (c.tickers))");
    expect(flat178).toContain("(o.origin = 'manual' or exists (select 1 from public.bist_companies c2 where c2.shares_traded and c2.tickers @> array[o.ticker]))");
  });

  it("orders both branches by report rows first, then low desc, alias, ticker", () => {
    expect(countOf(disableBody, ORDER_ALLROWS)).toBe(2);
    expect(disableBody).not.toContain("order by c.low desc, c.alias, c.ticker");
    expect(countOf(disableBody, "c.visible, c.via from allrows c")).toBe(2);
  });

  it("writes only under `if p_apply is true` (a null or false flag only reports)", () => {
    expect(disableBody.startsWith("begin if p_apply is true then")).toBe(true);
    expect(countOf(disableBody, "update public.bist_aliases")).toBe(1);
    const ifAt = disableBody.indexOf("if p_apply is true then");
    const elseAt = disableBody.indexOf(" else ");
    const updateAt = disableBody.indexOf("update public.bist_aliases");
    expect(ifAt).toBeGreaterThanOrEqual(0);
    expect(updateAt).toBeGreaterThan(ifAt);
    expect(elseAt).toBeGreaterThan(updateAt);
    // the else branch (the dry run) holds no write
    const elseBranch = disableBody.slice(elseAt);
    expect(wordsOf(elseBranch)).not.toContain("update");
    expect(wordsOf(elseBranch)).not.toContain("set");
  });

  it("sets enabled = false and nothing else, only on origin = 'auto' rows that are still enabled", () => {
    expect(disableBody).toContain("update public.bist_aliases b set enabled = false from allrows c");
    expect(disableBody).toContain("where b.alias = c.alias and b.ticker = c.ticker and b.origin = 'auto' and b.enabled");
    expect(countOf(disableBody, "set enabled = false")).toBe(1);
    expect(countOf(disableBody, " set ")).toBe(1);
    expect(disableBody).not.toContain("enabled = true");
  });

  it("evaluates the candidates once (a materialized CTE) and returns the rows it disabled, so a second call finds nothing", () => {
    expect(disableBody).toContain("with cand as materialized (");
    expect(disableBody).toContain("returning b.alias, b.ticker");
    expect(disableBody).toContain("join done d on d.alias = c.alias and d.ticker = c.ticker");
  });

  it("refuses to apply with null, non-positive or out-of-range thresholds (a zero min_scored or share would match every alias)", () => {
    expect(disableBody).toContain(
      "if p_days is null or p_days < 1 or p_min_scored is null or p_min_scored < 1 or p_low_share is null or p_low_share <= 0 or p_low_share > 1 then raise exception",
    );
    expect(disableBody).toContain("using errcode = '22023'");
    // the guard sits inside the apply branch, before the update
    expect(disableBody.indexOf("raise exception")).toBeGreaterThan(disableBody.indexOf("if p_apply is true then"));
    expect(disableBody.indexOf("raise exception")).toBeLessThan(disableBody.indexOf("update public.bist_aliases"));
  });

  it("qualifies every column that shares a name with an output column (alias, ticker, hits, scored, low, visible, via): plpgsql would raise 42702", () => {
    for (const col of ["alias", "ticker", "hits", "scored", "low", "visible", "via"]) {
      let from = 0;
      for (;;) {
        const at = disableBody.indexOf(col, from);
        if (at < 0) break;
        from = at + col.length;
        // part of a longer identifier (low_precision_aliases, p_low_share, min_scored, ...): not a column reference
        if (isTagChar(disableBody.charAt(at - 1)) || isTagChar(disableBody.charAt(at + col.length))) continue;
        // `... as via` names a CTE column, it does not read one
        if (disableBody.slice(at - 3, at) === "as ") continue;
        expect(disableBody.charAt(at - 1), `${col}: ${disableBody.slice(Math.max(0, at - 24), at + 24)}`).toBe(".");
      }
    }
  });
});

describe("179 header, dry-run and manifest", () => {
  it("documents the problem, the replay, the founder-only follow-up, the order, the checks and the rollback", () => {
    for (const word of [
      "h72-kap-4",
      "prune_generic_aliases",
      "ambiguous",
      "FOUNDER-ONLY",
      "VERIFY",
      "ROLLBACK",
      "REPLAY",
      "ORDER",
      "STEP 0",
      "albayrak",
      "ihlas",
      "golden",
      "efes",
      "koza",
      "akis",
      "alarko",
      "ALGYO",
      "nobel",
      "NOBEL",
    ]) {
      expect(raw, word).toContain(word);
    }
  });

  it("states the replay count of the SELECT as run: 33 rows with the exclusion, 34 without", () => {
    expect(raw).toContain("33 rows");
    expect(raw).toContain("34 rows");
  });

  it("tells the founder the one statement that applies it, and that this file does not", () => {
    expect(raw).toContain("select * from public.disable_low_precision_aliases(true)");
    expect(raw).toContain("this file neither calls nor schedules");
  });

  it("documents the rule-B sibling switch-off (via = 'rule_b_sibling') in WHAT (2), FOUNDER-ONLY step 2, VERIFY, ROLLBACK and the function comment", () => {
    const section = (from: string, to: string): string => {
      const a = raw.indexOf(from);
      const b = raw.indexOf(to, a + from.length);
      expect(a, from).toBeGreaterThan(-1);
      expect(b, to).toBeGreaterThan(a);
      return raw.slice(a, b).split("\n--").join(" ").split(/\s+/).filter(Boolean).join(" ");
    };
    const what = section("\n-- WHAT\n", "\n-- STEP 0");
    const founder = section("\n-- FOUNDER-ONLY", "\n-- ORDER:");
    const verify = section("\n-- VERIFY", "\n-- ROLLBACK:");
    const rollback = section("\n-- ROLLBACK:", "\nbegin;");
    for (const [name, text] of [
      ["WHAT", what],
      ["FOUNDER-ONLY", founder],
      ["VERIFY", verify],
      ["ROLLBACK", rollback],
    ] as const) {
      expect(text, name).toContain("rule_b_sibling");
      expect(text, name).toContain("rule B");
    }
    expect(what).toContain("untraded auto sibling");
    expect(what).toContain("171/177/178");
    expect(what).toContain("seven columns");
    expect(founder).toContain("2. Apply:");
    expect(founder.slice(founder.indexOf("2. Apply:"))).toContain("via = 'rule_b_sibling'");
    expect(verify).toContain("via text");
    expect(rollback).toContain("enabled = true");
    // the function comment (a single-quoted string in the file) says the same, with the quotes doubled
    const disableComment = statements.find((s) => s.startsWith(`comment on function ${DISABLE_SIG} is '`)) ?? "";
    expect(disableComment).toContain("rule B");
    expect(disableComment).toContain("via = ''rule_b_sibling''");
    expect(disableComment).toContain("untraded auto sibling");
  });

  it("has a dry-run that loads the stub, applies 179 twice and ends in its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = existsSync(DRYRUN) ? readFileSync(DRYRUN, "utf8") : "";
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/179_alias_precision_report.sql",
      "../../../supabase/migrations/179_alias_precision_report.sql",
    ]);
    expect(sql.trimEnd().endsWith("select 'DRYRUN 179 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("create table public.bist_aliases");
    expect(sql).toContain("create table public.jev_shadow_predictions");
    // bist_companies (read by the sibling rule) is not created here: the stub the dry-run loads first carries it, with the
    // two columns the rule reads, and the dry-run inserts its fixtures into it
    const stub = readFileSync(resolve(__dirname, "sql", "stub.sql"), "utf8");
    expect(stub).toContain("create table if not exists public.bist_companies(");
    expect(stub).toContain("tickers text[] not null");
    expect(stub).toContain("shares_traded boolean");
    expect(sql).not.toContain("create table public.bist_companies");
    expect(sql).toContain("insert into public.bist_companies (tickers, shares_traded) values");
    expect(sql).toContain("'rule_b_sibling'");
    expect(sql).toContain("xalias");
    // it applies the switch only on fixture rows, inside one begin ... rollback, never on what the database holds
    const firstApply = sql.indexOf("disable_low_precision_aliases(true");
    const lastApply = sql.lastIndexOf("disable_low_precision_aliases(true");
    expect(firstApply).toBeGreaterThan(-1);
    const begin = sql.lastIndexOf("\nbegin;", firstApply);
    const rollback = sql.indexOf("\nrollback;", lastApply);
    expect(begin).toBeGreaterThan(-1);
    expect(rollback).toBeGreaterThan(lastApply);
    expect(sql.slice(begin, rollback)).not.toContain("\ncommit;");
    expect(sql.slice(0, begin)).not.toContain("disable_low_precision_aliases(true");
    expect(sql.slice(rollback)).not.toContain("disable_low_precision_aliases(true");
  });

  it("is listed once in the live manifest, with the dry-run as its setup", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 179-alias-precision-report.test.ts |"));
    expect(lines).toEqual([
      "run | 179-alias-precision-report.test.ts | tests/migrations/sql/179-alias-precision-report-dryrun.sql | - | 0",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): both functions against fixture rows, on a throwaway Postgres with 179 applied
// (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server. Every case ends in a rollback.
// ---------------------------------------------------------------------------

const SRC = "00000000-0000-4000-8000-000000000179";

/**
 * One source, plus pg_temp.fx(alias, ticker, low, high, unscored, age, matched_on): inserts low + high + unscored
 * articles, each with an article_tickers row (matched_on = 'alias:<alias>' unless given) and, for the first `low`, a
 * ticker_relevance score of 0.05, for the next `high` one of 0.9; the rest stay unscored.
 */
const FIXTURE = `insert into public.sources (id, slug, name, bias, url, rss_url) values ('${SRC}', 'live-179', 'S179', 'center', 'https://s179.example', 'https://s179.example/rss');
create function pg_temp.fx(p_alias text, p_ticker text, p_low int, p_high int, p_unscored int, p_age interval default interval '1 day', p_matched text default null)
returns void language plpgsql as $f$
declare i int; a uuid;
begin
  for i in 1 .. p_low + p_high + p_unscored loop
    a := gen_random_uuid();
    insert into public.articles (id, source_id, title, published_at) values (a, '${SRC}', p_alias || ' ' || i, now() - p_age);
    insert into public.article_tickers (article_id, ticker, matched_on, published_at, source_id)
      values (a, p_ticker, coalesce(p_matched, 'alias:' || p_alias), now() - p_age, '${SRC}');
    if i <= p_low then
      insert into public.jev_shadow_predictions (task, subject_type, subject_id, jev_prob) values ('ticker_relevance', 'article', a::text || ':' || p_ticker, 0.050);
    elsif i <= p_low + p_high then
      insert into public.jev_shadow_predictions (task, subject_type, subject_id, jev_prob) values ('ticker_relevance', 'article', a::text || ':' || p_ticker, 0.900);
    end if;
  end loop;
end $f$;
`;

/** One bist_aliases row. */
const alias = (name: string, ticker: string, origin: "auto" | "manual" = "auto", enabled = true): string =>
  `insert into public.bist_aliases (alias, ticker, origin, enabled) values ('${name}', '${ticker}', '${origin}', ${enabled});\n`;

/** alias + the fixture articles in one go. */
const fx = (name: string, ticker: string, low: number, high: number, unscored: number, extra = ""): string =>
  alias(name, ticker) + `select pg_temp.fx('${name}', '${ticker}', ${low}, ${high}, ${unscored}${extra});\n`;

const ROW = "alias || '|' || ticker || '|' || hits || '|' || scored || '|' || low || '|' || visible";
/** The switch's rows, with its trailing via column. */
const ROW_VIA = `${ROW} || '|' || via`;

/** One bist_companies row: a company holding `ticker`, traded or not (the rule-B test of 171/177/178 reads it). */
const company = (ticker: string, traded: boolean): string =>
  `insert into public.bist_companies (tickers, shares_traded) values (array['${ticker}'], ${traded});\n`;

describe.runIf(Boolean(process.env.TAYF_PSQL))("179 alias precision report against fixture rows (live Postgres, every case rolled back)", () => {
  assertLiveReady("179", {
    ledger: ["179"],
    relations: ["public.bist_aliases", "public.article_tickers", "public.jev_shadow_predictions"],
    functions: [
      "public.low_precision_aliases(integer,integer,numeric)",
      "public.disable_low_precision_aliases(boolean,integer,integer,numeric)",
    ],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  /** Runs `setup` on top of the fixture helpers, then the SELECT, and returns its lines. Rolled back. */
  function lines(setup: string, select: string): string[] {
    return runPsql(`begin;\n${FIXTURE}${setup}${select}\nrollback;\n`)
      .split("\n")
      .filter(Boolean);
  }

  /** The report's rows as `alias|ticker|hits|scored|low|visible`. */
  const report = (setup: string, args = ""): string[] =>
    lines(setup, `select ${ROW} from public.low_precision_aliases(${args});`);

  it("the spec's pair (nobel, NOBEL): an auto alias whose scored hits are all low is in the report with its counts", () => {
    expect(report(fx("nobel", "NOBEL", 10, 0, 2))).toEqual(["nobel|NOBEL|12|10|10|2"]);
  });

  it("the share line is inclusive: 7 of 10 low qualifies at 0.7, 6 of 10 does not", () => {
    expect(report(fx("edge70", "EDGEA", 7, 3, 0) + fx("edge60", "EDGEB", 6, 4, 0))).toEqual(["edge70|EDGEA|10|10|7|3"]);
  });

  it("the scored count line is inclusive: 8 scored qualifies at 8, 7 does not (and p_min_scored is a parameter)", () => {
    const setup = fx("eight", "EIGHT", 8, 0, 0) + fx("seven", "SEVEN", 7, 0, 0);
    expect(report(setup)).toEqual(["eight|EIGHT|8|8|8|0"]);
    expect(report(setup, "30, 7").sort()).toEqual(["eight|EIGHT|8|8|8|0", "seven|SEVEN|7|7|7|0"]);
  });

  it("unscored rows are not low: an alias with no scores never qualifies, even when the min is 0 (low >= 0.7 * 0 would be true)", () => {
    const setup = fx("nojev", "NOJEV", 0, 0, 20);
    expect(report(setup)).toEqual([]);
    expect(report(setup, "30, 0")).toEqual([]);
  });

  it("an unscored tail still counts as visible: 8 low + 12 unscored is hits 20, scored 8, low 8, visible 12", () => {
    expect(report(fx("tail", "TAIL", 8, 0, 12))).toEqual(["tail|TAIL|20|8|8|12"]);
  });

  it("a score of 0.2 or more is not low: 2 at 0.05 and 8 at 0.9 is 20% low", () => {
    expect(report(fx("fine", "FINE", 2, 8, 0))).toEqual([]);
  });

  it("an alias text with an enabled manual row on ANY ticker is excluded (manual sibling), until that manual row is disabled", () => {
    const base = fx("alarko", "ALGYO", 10, 0, 0) + alias("alarko", "ALARK", "manual");
    expect(report(base)).toEqual([]);
    expect(report(base + "update public.bist_aliases set enabled = false where origin = 'manual';\n")).toEqual([
      "alarko|ALGYO|10|10|10|0",
    ]);
  });

  it("a manual row is never a candidate, and a disabled auto row is not either", () => {
    const setup =
      alias("manualone", "MANAA", "manual") +
      "select pg_temp.fx('manualone', 'MANAA', 10, 0, 0);\n" +
      alias("offone", "OFFAA", "auto", false) +
      "select pg_temp.fx('offone', 'OFFAA', 10, 0, 0);\n";
    expect(report(setup)).toEqual([]);
  });

  it("only rows inside the window count: 40-day-old rows are out at 30 days and in at 60", () => {
    const setup = alias("oldone", "OLDAA") + "select pg_temp.fx('oldone', 'OLDAA', 10, 0, 0, interval '40 days');\n";
    expect(report(setup)).toEqual([]);
    expect(report(setup, "60")).toEqual(["oldone|OLDAA|10|10|10|0"]);
  });

  it("only article_tickers rows matched on this alias count: a code match or another alias for the ticker is not a hit", () => {
    const setup =
      alias("viacode", "CODEA") +
      "select pg_temp.fx('viacode', 'CODEA', 10, 0, 0, interval '1 day', 'code');\n" +
      alias("viaother", "OTHRA") +
      "select pg_temp.fx('viaother', 'OTHRA', 10, 0, 0, interval '1 day', 'alias:somethingelse');\n";
    expect(report(setup)).toEqual([]);
  });

  it("a shared auto alias reports each ticker on its own, most low rows first (eregli to EREGL and ERGLI)", () => {
    const setup = fx("eregli", "EREGL", 10, 0, 1) + fx("eregli", "ERGLI", 9, 1, 0) + fx("nobel", "NOBEL", 8, 0, 0);
    expect(report(setup)).toEqual(["eregli|EREGL|11|10|10|1", "eregli|ERGLI|10|10|9|1", "nobel|NOBEL|8|8|8|0"]);
  });

  it("scores of another task or another ticker on the same article do not leak in", () => {
    const setup =
      alias("leak", "LEAKA") +
      "select pg_temp.fx('leak', 'LEAKA', 0, 10, 0);\n" +
      "insert into public.jev_shadow_predictions (task, subject_type, subject_id, jev_prob) select 'framing', 'article', t.article_id::text || ':' || t.ticker, 0.010 from public.article_tickers t where t.ticker = 'LEAKA';\n" +
      "insert into public.jev_shadow_predictions (task, subject_type, subject_id, jev_prob) select 'ticker_relevance', 'article', t.article_id::text || ':OTHER', 0.010 from public.article_tickers t where t.ticker = 'LEAKA';\n";
    expect(report(setup)).toEqual([]);
  });

  it("the dry run (default and false) reports and writes nothing; a null flag does not write either", () => {
    const out = lines(
      fx("nobel", "NOBEL", 10, 0, 0),
      `select 'dry=' || count(*) from public.disable_low_precision_aliases();
select 'false=' || count(*) from public.disable_low_precision_aliases(false);
select 'null=' || count(*) from public.disable_low_precision_aliases(null);
select 'enabled=' || count(*) from public.bist_aliases where enabled;`,
    );
    expect(out).toEqual(["dry=1", "false=1", "null=1", "enabled=1"]);
  });

  it("p_apply = true disables exactly the reported auto rows, returns them, keeps every article_tickers row, and a second call finds nothing", () => {
    const setup =
      fx("nobel", "NOBEL", 10, 0, 2) +
      fx("eregli", "EREGL", 9, 0, 0) +
      fx("fine", "FINE", 2, 8, 0) +
      fx("few", "FEWAA", 5, 0, 0) +
      fx("alarko", "ALGYO", 10, 0, 0) +
      alias("alarko", "ALARK", "manual") +
      alias("manualone", "MANAA", "manual") +
      alias("offone", "OFFAA", "auto", false);
    const out = lines(
      setup,
      `select 'before=' || (select count(*) from public.article_tickers) || '/' || (select count(*) from public.articles);
select 'report=' || string_agg(alias || ':' || ticker, ',' order by alias, ticker) from public.low_precision_aliases();
select 'applied=' || string_agg(${ROW}, ',' order by alias, ticker) from public.disable_low_precision_aliases(true);
select 'disabled=' || string_agg(alias || ':' || ticker || ':' || origin, ',' order by alias, ticker) from public.bist_aliases where not enabled;
select 'enabled=' || string_agg(alias || ':' || ticker || ':' || origin, ',' order by alias, ticker) from public.bist_aliases where enabled;
select 'after=' || (select count(*) from public.article_tickers) || '/' || (select count(*) from public.articles);
select 'again=' || count(*) from public.disable_low_precision_aliases(true);
select 'report_after=' || count(*) from public.low_precision_aliases();`,
    );
    expect(out).toEqual([
      "before=46/46",
      "report=eregli:EREGL,nobel:NOBEL",
      "applied=eregli|EREGL|9|9|9|0,nobel|NOBEL|12|10|10|2",
      "disabled=eregli:EREGL:auto,nobel:NOBEL:auto,offone:OFFAA:auto",
      "enabled=alarko:ALARK:manual,alarko:ALGYO:auto,few:FEWAA:auto,fine:FINE:auto,manualone:MANAA:manual",
      "after=46/46",
      "again=0",
      "report_after=0",
    ]);
  });

  // -- rule B siblings (via = 'rule_b_sibling') ---------------------------------------------------------------------
  // 171/177/178's rule B stops an untraded auto row from attaching while an enabled sibling of the same alias is manual or
  // traded. Switching the traded candidate off releases the untraded sibling, which has no rows in the window (rule B kept it
  // from collecting any) and so never qualifies itself. The switch takes it along, tagged 'rule_b_sibling'.

  /** xalias: TTT traded and a candidate; UUU untraded auto with rows only 40 days old (outside the 30-day window). */
  const SIBLING_SETUP =
    company("TTT", true) +
    company("UUU", false) +
    fx("xalias", "TTT", 10, 0, 0) +
    fx("xalias", "UUU", 3, 0, 0, ", interval '40 days'");

  it("the dry run lists the candidate (via report) and its untraded rule-B sibling (via rule_b_sibling), and writes nothing", () => {
    const out = lines(
      SIBLING_SETUP,
      `select ${ROW_VIA} from public.disable_low_precision_aliases() order by via, ticker;
select 'report=' || count(*) from public.low_precision_aliases();
select 'enabled=' || count(*) from public.bist_aliases where enabled;`,
    );
    expect(out).toEqual(["xalias|TTT|10|10|10|0|report", "xalias|UUU|0|0|0|0|rule_b_sibling", "report=1", "enabled=2"]);
  });

  it("the dry run returns the candidates first, then their siblings", () => {
    const out = lines(
      SIBLING_SETUP + fx("nobel", "NOBEL", 12, 0, 0),
      `select alias || ':' || ticker || ':' || via from public.disable_low_precision_aliases();`,
    );
    expect(out).toEqual(["nobel:NOBEL:report", "xalias:TTT:report", "xalias:UUU:rule_b_sibling"]);
  });

  it("p_apply = true switches off the candidate and its sibling, returns both, and a second call finds nothing", () => {
    const out = lines(
      SIBLING_SETUP,
      `select 'applied=' || string_agg(${ROW_VIA}, ',' order by via, ticker) from public.disable_low_precision_aliases(true);
select 'enabled=' || count(*) from public.bist_aliases where enabled;
select 'disabled=' || string_agg(alias || ':' || ticker, ',' order by ticker) from public.bist_aliases where not enabled;
select 'again=' || count(*) from public.disable_low_precision_aliases(true);
select 'report_after=' || count(*) from public.low_precision_aliases();`,
    );
    expect(out).toEqual([
      "applied=xalias|TTT|10|10|10|0|report,xalias|UUU|0|0|0|0|rule_b_sibling",
      "enabled=0",
      "disabled=xalias:TTT,xalias:UUU",
      "again=0",
      "report_after=0",
    ]);
  });

  it("p_apply = true returns the applied rows in order: report rows first, then siblings", () => {
    const out = lines(
      SIBLING_SETUP + fx("nobel", "NOBEL", 12, 0, 0),
      `select alias || ':' || ticker || ':' || via from public.disable_low_precision_aliases(true);`,
    );
    expect(out).toEqual(["nobel:NOBEL:report", "xalias:TTT:report", "xalias:UUU:rule_b_sibling"]);
  });

  it("a sibling only pulled in by the switch never touches article_tickers or a manual row", () => {
    const out = lines(
      SIBLING_SETUP + alias("manualone", "MANAA", "manual"),
      `select 'before=' || count(*) from public.article_tickers;
select count(*) from public.disable_low_precision_aliases(true);
select 'after=' || count(*) from public.article_tickers;
select 'manual=' || enabled from public.bist_aliases where origin = 'manual';`,
    );
    expect(out).toEqual(["before=13", "2", "after=13", "manual=true"]);
  });

  it("no sibling when the alias holds only untraded auto rows: rule B never hid them", () => {
    const setup =
      company("VVV", false) + company("WWW", false) + fx("yalias", "VVV", 10, 0, 0) + alias("yalias", "WWW");
    const out = lines(
      setup,
      `select ${ROW_VIA} from public.disable_low_precision_aliases();
select ${ROW_VIA} from public.disable_low_precision_aliases(true);
select 'enabled=' || string_agg(ticker, ',' order by ticker) from public.bist_aliases where enabled;`,
    );
    expect(out).toEqual(["yalias|VVV|10|10|10|0|report", "yalias|VVV|10|10|10|0|report", "enabled=WWW"]);
  });

  it("no sibling when another traded auto row of the alias is not flagged: it still hides the untraded row", () => {
    const setup =
      company("ZZ1", true) +
      company("ZZ2", true) +
      company("ZZ3", false) +
      fx("zalias", "ZZ1", 10, 0, 0) +
      fx("zalias", "ZZ2", 0, 10, 0) +
      alias("zalias", "ZZ3");
    const out = lines(
      setup,
      `select ${ROW_VIA} from public.disable_low_precision_aliases();
select ${ROW_VIA} from public.disable_low_precision_aliases(true);
select 'enabled=' || string_agg(ticker, ',' order by ticker) from public.bist_aliases where enabled;`,
    );
    expect(out).toEqual(["zalias|ZZ1|10|10|10|0|report", "zalias|ZZ1|10|10|10|0|report", "enabled=ZZ2,ZZ3"]);
  });

  it("no sibling when a traded sibling that stays enabled is not a candidate, even one with no article rows", () => {
    const setup =
      company("QQ1", true) + company("QQ2", true) + company("QQ3", false) + fx("qalias", "QQ1", 10, 0, 0) + alias("qalias", "QQ2") + alias("qalias", "QQ3");
    const out = lines(setup, `select ${ROW_VIA} from public.disable_low_precision_aliases();`);
    expect(out).toEqual(["qalias|QQ1|10|10|10|0|report"]);
  });

  it("both traded rows flagged: the untraded sibling goes with them, once", () => {
    const setup =
      company("RR1", true) +
      company("RR2", true) +
      company("RR3", false) +
      fx("ralias", "RR1", 10, 0, 0) +
      fx("ralias", "RR2", 9, 0, 0) +
      alias("ralias", "RR3");
    const out = lines(setup, `select alias || ':' || ticker || ':' || via from public.disable_low_precision_aliases();`);
    expect(out).toEqual(["ralias:RR1:report", "ralias:RR2:report", "ralias:RR3:rule_b_sibling"]);
  });

  it("an untraded sibling of a traded candidate is not pulled in when it is already disabled or a manual row", () => {
    const setup =
      company("SS1", true) +
      company("SS2", false) +
      company("SS3", false) +
      fx("salias", "SS1", 10, 0, 0) +
      alias("salias", "SS2", "auto", false) +
      alias("salias", "SS3", "manual");
    // an enabled manual row on the alias text also excludes it from the report, so there is no candidate at all
    expect(lines(setup, `select count(*) from public.disable_low_precision_aliases();`)).toEqual(["0"]);
    const off =
      company("TT1", true) + company("TT2", false) + fx("talias", "TT1", 10, 0, 0) + alias("talias", "TT2", "auto", false);
    expect(lines(off, `select ${ROW_VIA} from public.disable_low_precision_aliases();`)).toEqual(["talias|TT1|10|10|10|0|report"]);
  });

  it("a ticker with no bist_companies row counts as untraded (rule B's own reading)", () => {
    const setup = company("UU1", true) + fx("ualias", "UU1", 10, 0, 0) + alias("ualias", "UU2");
    const out = lines(setup, `select alias || ':' || ticker || ':' || via from public.disable_low_precision_aliases();`);
    expect(out).toEqual(["ualias:UU1:report", "ualias:UU2:rule_b_sibling"]);
  });

  it.each([
    ["p_days = 0", "true, 0, 8, 0.7"],
    ["p_days null", "true, null, 8, 0.7"],
    ["p_min_scored = 0", "true, 30, 0, 0.7"],
    ["p_min_scored null", "true, 30, null, 0.7"],
    ["p_low_share = 0", "true, 30, 8, 0"],
    ["p_low_share null", "true, 30, 8, null"],
    ["p_low_share above 1", "true, 30, 8, 1.5"],
  ])("refuses to apply with %s, and the refusal changes nothing", (_label, args) => {
    expect(() => runPsql(`begin;\n${FIXTURE}${fx("nobel", "NOBEL", 10, 0, 0)}select * from public.disable_low_precision_aliases(${args});\nrollback;\n`)).toThrow(
      /refusing to apply/,
    );
  });

  it("a report with those same thresholds is still allowed (only the write is guarded)", () => {
    expect(report(fx("nobel", "NOBEL", 10, 0, 0), "30, 0, 0.5")).toEqual(["nobel|NOBEL|10|10|10|0"]);
  });

  it("p_apply = true with the boundary thresholds (min 1, share 1) works", () => {
    const out = lines(
      fx("nobel", "NOBEL", 10, 0, 0) + fx("mixed", "MIXAA", 9, 1, 0),
      "select count(*) from public.disable_low_precision_aliases(true, 30, 1, 1);",
    );
    expect(out).toEqual(["1"]);
  });

  it("is exposed to service_role only, has an empty search_path and one overload of each name; the report is stable", () => {
    const out = lines(
      "",
      `select 'low_acl=' || has_function_privilege('anon', 'public.low_precision_aliases(integer,integer,numeric)', 'execute') || ',' || has_function_privilege('authenticated', 'public.low_precision_aliases(integer,integer,numeric)', 'execute') || ',' || has_function_privilege('service_role', 'public.low_precision_aliases(integer,integer,numeric)', 'execute');
select 'disable_acl=' || has_function_privilege('anon', 'public.disable_low_precision_aliases(boolean,integer,integer,numeric)', 'execute') || ',' || has_function_privilege('authenticated', 'public.disable_low_precision_aliases(boolean,integer,integer,numeric)', 'execute') || ',' || has_function_privilege('service_role', 'public.disable_low_precision_aliases(boolean,integer,integer,numeric)', 'execute');
select 'attrs=' || p.proname || ':' || p.provolatile::text || ':' || p.prosecdef::text || ':' || array_to_string(p.proconfig, ',') from pg_proc p where p.proname in ('low_precision_aliases', 'disable_low_precision_aliases') order by p.proname;
select 'overloads=' || count(*) from pg_proc p where p.proname in ('low_precision_aliases', 'disable_low_precision_aliases');`,
    );
    expect(out).toEqual([
      "low_acl=false,false,true",
      "disable_acl=false,false,true",
      'attrs=disable_low_precision_aliases:v:false:search_path=""',
      'attrs=low_precision_aliases:s:false:search_path=""',
      "overloads=2",
    ]);
  });
});
