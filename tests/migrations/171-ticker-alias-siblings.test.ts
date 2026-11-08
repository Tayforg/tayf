import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 171 ("ticker_alias_siblings"), h57-ekonomi-2 (hunt 57).
//
// 085's resolve_article_tickers_for joins every enabled bist_aliases row whose alias is found in the folded text. When one
// alias is shared by several tickers, every sibling attaches: 'tskb' gives TSKB (manual) and also TSGYO and TSKYO, 'turkcell'
// gives TCELL (manual) and FNCLL (TURKCELL FINANSMAN, not traded), 'oyak' gives four. The feed then shows TSGYO +%1,71 under a
// TSKB story and FNCLL under Turkcell news.
//
// 171 re-creates the function with 085's body VERBATIM (production's, md5 pinned below), the alias_hits join moved unchanged into
// a post-match MATERIALIZED CTE (alias_matches) and two predicates on the bist_aliases row applied to the rows that already matched
// the text, in alias_hits' WHERE:
//   (A) an auto row loses to an enabled manual sibling of the same alias;
//   (B) an untraded auto row never attaches through a shared alias when a manual or traded sibling exists (a deliberate narrowing
//       of the spec's B: an alias whose siblings are ALL untraded auto rows keeps 085's behaviour).
// Why post-match: both predicates read the alias row only, so inside the join they run for every enabled auto alias row on every
// call (62 ms an article against 1 ms under 085); the 058 trigger calls the resolver once per inserted row under the ingest
// upsert's 8 s statement_timeout. code_hits is not touched. No table is written but article_tickers (by the function, as before),
// and 171 itself updates and deletes nothing.
//
// This file pins, without a database: the file, ledger and transaction, that 085's body is production's (md5 pinned), that
// substituting 085's alias_hits for the alias_matches + alias_hits pair in 171's body gives 085's body (derive-and-compare), that
// code_hits and every other segment are untouched, the header (the same attributes and grants), additive-only SQL, the docs
// section, the dry-run script and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs the function against fixtures.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_085 = "085_ticker_code_gate.sql";
const FILE_171 = "171_ticker_alias_siblings.sql";
const MIGRATION_085 = resolve(MIGRATIONS_DIR, FILE_085);
const MIGRATION_171 = resolve(MIGRATIONS_DIR, FILE_171);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "171-ticker-alias-siblings-dryrun.sql");

/** Production, read-only, 2026-11-07: md5(prosrc), length(prosrc) and the attributes of the function 171 starts from. */
const PROD_MD5 = "2667cc7fad0d66879f77ec6ad31e52ab";
const PROD_LENGTH = 1760;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.resolve_article_tickers_for";
const FN_SIG = `${FN}(uuid[])`;
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('171', '171_ticker_alias_siblings') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/**
 * The two predicate cores, whitespace-collapsed. In 171 they sit in alias_hits' WHERE (never in a join ON clause).
 * A is the spec's text. B is the spec's text with the sibling test narrowed (deliberate deviation): an untraded auto row drops
 * only next to a sibling that is manual or traded; c2 uses `@>` so bist_companies_tickers_idx (GIN) can serve it.
 */
const CORE_A =
  "not (al.origin = 'auto' and exists (select 1 from public.bist_aliases m where m.alias = al.alias and m.enabled and m.origin = 'manual' and m.ticker <> al.ticker))";
const CORE_B =
  "not (al.origin = 'auto' and not exists (select 1 from public.bist_companies c where c.shares_traded and al.ticker = any (c.tickers)) and exists (select 1 from public.bist_aliases o where o.alias = al.alias and o.enabled and o.ticker <> al.ticker and (o.origin = 'manual' or exists (select 1 from public.bist_companies c2 where c2.shares_traded and c2.tickers @> array[o.ticker]))))";

/** 085's alias_hits join, collapsed: the text 171's alias_matches must carry verbatim. */
const MATCH_JOIN =
  "from ctx r join public.bist_aliases al on al.enabled and (al.origin = 'manual' or r.fin_ctx) and pg_catalog.strpos(r.folded, ' ' || al.alias || ' ') > 0";
const MATCH_OPEN = ", alias_matches as materialized (";
const HITS_OPEN = ", alias_hits as (";
const CODE_OPEN = ", code_hits as (";

// -- plain-text helpers (no regular expression runs over quoted SQL) ----------------------------

/** Removes `--` comments to the end of the line (no `--` appears inside a string literal of these files). */
function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

/** Comment block read as prose: `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\n--\s*/g, " ").replace(/\s+/g, " ");
}

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two `$$` markers at or after `from`: Postgres' prosrc. */
function dollarBody(sql: string, from: number): string {
  const open = sql.indexOf("$$", from);
  const close = sql.indexOf("$$", open + 2);
  expect(open, "an opening dollar quote").toBeGreaterThanOrEqual(0);
  expect(close, "a closing dollar quote").toBeGreaterThan(open);
  return sql.slice(open + 2, close);
}

/** The code of a migration file: from the transaction onward, so header prose never counts as code. */
function codeOf(sql: string): string {
  const at = sql.indexOf("\nbegin;");
  expect(at, "a begin; statement").toBeGreaterThanOrEqual(0);
  return sql.slice(at);
}

/** The body of public.resolve_article_tickers_for in a migration file. */
function resolverBody(sql: string): string {
  const code = codeOf(sql);
  const at = code.indexOf(`create or replace function ${FN}(p_ids uuid[])`);
  expect(at, `${FN} in the file`).toBeGreaterThanOrEqual(0);
  return dollarBody(code, at);
}

/** `create or replace function ... as ` up to and including the opening dollar quote. */
function resolverHeader(sql: string): string {
  const code = codeOf(sql);
  const at = code.indexOf(`create or replace function ${FN}(p_ids uuid[])`);
  const open = code.indexOf("$$", at);
  return code.slice(at, open + 2);
}

/** Top-level statements: split on ';' outside single-quoted strings, `--` comments and dollar-quoted bodies; comments dropped. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < code.length) {
    const ch = code.charAt(i);
    if (code.startsWith("--", i)) {
      const newline = code.indexOf("\n", i);
      i = newline === -1 ? code.length : newline;
    } else if (code.startsWith("$$", i)) {
      const close = code.indexOf("$$", i + 2);
      const stop = close === -1 ? code.length : close + 2;
      cur += code.slice(i, stop);
      i = stop;
    } else if (ch === "'") {
      let j = i + 1;
      while (j < code.length) {
        if (code.charAt(j) === "'") {
          if (code.charAt(j + 1) === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      cur += code.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";") {
      out.push(cur.trim());
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  out.push(cur.trim());
  return out.filter((stmt) => stmt !== "");
}

/** Statements with the dollar-quoted body replaced by a marker and whitespace collapsed. */
function statements(code: string): string[] {
  return splitStatements(code).map((stmt) => {
    const open = stmt.indexOf("$$");
    const close = open === -1 ? -1 : stmt.indexOf("$$", open + 2);
    const shown = open !== -1 && close !== -1 ? `${stmt.slice(0, open)}$$ body $$${stmt.slice(close + 2)}` : stmt;
    return collapse(shown);
  });
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.charAt(i) !== "'") {
      out += sql.charAt(i);
      i++;
      continue;
    }
    let j = i + 1;
    while (j < sql.length) {
      if (sql.charAt(j) === "'") {
        if (sql.charAt(j + 1) === "'") {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    out += "''";
    i = j + 1;
  }
  return out;
}

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

/** The (b) follow-up of a header or guide section read as prose: from "(b) The 595" through "rule A then resolves them". */
function followUpB(prose: string): string {
  const at = prose.indexOf("(b) The 595 all-auto traded siblings");
  expect(at, "the (b) follow-up").toBeGreaterThanOrEqual(0);
  const mark = "rule A then resolves them";
  const end = prose.indexOf(mark, at);
  expect(end, "the end of the (b) sentence").toBeGreaterThan(at);
  return prose.slice(at, end + mark.length);
}

/** The text between two markers of a prose (the first `to` after `from`), the markers included. */
function between(prose: string, from: string, to: string): string {
  const at = prose.indexOf(from);
  expect(at, `marker ${from}`).toBeGreaterThanOrEqual(0);
  const end = prose.indexOf(to, at);
  expect(end, `marker ${to} after ${from}`).toBeGreaterThan(at);
  return prose.slice(at, end + to.length);
}

/**
 * The collapsed, comment-free body split into its CTE segments: recent, ctx, [alias_matches: 171 only, "" in 085], alias_hits,
 * code_hits, hits+insert.
 */
function segments(body: string): {
  recent: string;
  ctx: string;
  aliasMatches: string;
  aliasHits: string;
  codeHits: string;
  tail: string;
} {
  const c = collapse(stripComments(body));
  const at = (marker: string, from = 0): number => {
    const i = c.indexOf(marker, from);
    expect(i, `marker ${marker}`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const iCtx = at(", ctx as (");
  const iMatches = c.indexOf(MATCH_OPEN, iCtx);
  const iAlias = at(HITS_OPEN, iCtx);
  const iCode = at(CODE_OPEN, iAlias);
  const iHits = at(", hits as (", iCode);
  return {
    recent: c.slice(0, iCtx),
    ctx: c.slice(iCtx, iMatches < 0 ? iAlias : iMatches),
    aliasMatches: iMatches < 0 ? "" : c.slice(iMatches, iAlias),
    aliasHits: c.slice(iAlias, iCode),
    codeHits: c.slice(iCode, iHits),
    tail: c.slice(iHits),
  };
}

/** A segment's join: from `from ctx r join` to the end of the CTE (the closing parenthesis and comma dropped). */
function joinOf(segment: string): string {
  const at = segment.indexOf("from ctx r join ");
  expect(at, `a join in ${segment.slice(0, 40)}`).toBeGreaterThanOrEqual(0);
  let out = segment.slice(at);
  if (out.endsWith(",")) out = out.slice(0, -1);
  if (out.endsWith(")")) out = out.slice(0, -1);
  return out;
}

/** Every join of a collapsed body up to the end of its ON clause (the next WHERE or the next CTE). */
function onClauses(c: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = c.indexOf(" join ", from);
    if (at < 0) return out;
    const stops = [" where ", CODE_OPEN, ", hits as (", HITS_OPEN].map((m) => c.indexOf(m, at + 1)).filter((i) => i >= 0);
    out.push(c.slice(at, Math.min(c.length, ...stops)));
    from = at + 1;
  }
}

const sql085 = readFileSync(MIGRATION_085, "utf8");
const body085 = resolverBody(sql085);
const sql171 = existsSync(MIGRATION_171) ? readFileSync(MIGRATION_171, "utf8") : "";
const header171 = (): string => {
  expect(existsSync(MIGRATION_171), `${FILE_171} must exist`).toBe(true);
  return sql171.split("\nbegin;")[0] as string;
};
const body171 = (): string => {
  expect(existsSync(MIGRATION_171), `${FILE_171} must exist`).toBe(true);
  return resolverBody(sql171);
};

describe("171 ticker_alias_siblings: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 171", () => {
    expect(existsSync(MIGRATION_171)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("171_"))).toEqual([FILE_171]);
  });

  it("sits after 085, the migration whose body it starts from", () => {
    expect(FILE_171 > FILE_085).toBe(true);
    const redefiners = readdirSync(MIGRATIONS_DIR)
      .filter((n) => n.endsWith(".sql") && n > FILE_085 && n <= FILE_171)
      .filter((n) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"))).includes(`create or replace function ${FN}(`));
    expect(redefiners, "no migration between 085 and 171 re-creates the resolver (085's body is still production's)").toEqual([FILE_171]);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(sql171);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql171, "\nbegin;")).toBe(1);
    expect(countOf(sql171, "\ncommit;")).toBe(1);
  });

  it("records version 171 in the schema_migrations ledger, idempotently (the 140-170 convention), as the last statement before commit", () => {
    const code = collapse(stripComments(sql171));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });
});

describe("171 ticker_alias_siblings: the production fingerprint it was built from", () => {
  it("085's function body is production's: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body085)).toBe(PROD_MD5);
    expect([...body085].length).toBe(PROD_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 085's body", () => {
    const header = header171();
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5);
    expect(header).toContain(String(PROD_LENGTH));
    expect(header).toMatch(/prosecdef\s+f/);
    expect(header).toMatch(/provolatile\s+v/);
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("equals the md5 of 085's body");
    expect(header).toMatch(/^-- 171_ticker_alias_siblings\.sql/);
  });

  it("the header names the evidence, the two predicates and the expected effect per alias", () => {
    const header = flat(header171());
    for (const word of [
      "h57-ekonomi-2",
      "resolve_article_tickers_for",
      "alias_hits",
      "alias_matches",
      "MATERIALIZED",
      "code_hits",
      "TSGYO",
      "TSKYO",
      "FNCLL",
      "OYAYO",
      "1,319",
      "263",
      "461",
      "595",
    ]) {
      expect(header, word).toContain(word);
    }
    // expected effect: one ticker per named alias, the siblings that drop
    for (const effect of [
      "turkcell gives TCELL only",
      "tskb gives TSKB only",
      "alarko gives ALARK only",
      "migros gives MGROS only",
      "enerjisa gives ENJSA only",
      "kardemir gives KRDMD only",
    ]) {
      expect(header, effect).toContain(effect);
    }
    expect(header).toContain("KRDMA, KRDMB and KARCL drop; this is expected");
  });

  it("the header records the read-only dry run: the counts, the dropped pairs and the zero-outside-shared-aliases check", () => {
    const header = flat(header171());
    for (const word of [
      "DRY RUN",
      "last 24 hours",
      "7,978 non-sports rows",
      "alias hits: 227 without, 206 with = 21 dropped, 0 added",
      "articles with an alias hit 163 before, 163 after",
      "The 21 dropped hits are 7 (alias, ticker) pairs",
      "turkcell FNCLL 7",
      "vestel VESBE 5",
      "tskb TSGYO 3",
      "tskb TSKYO 3",
      "alarko ALCAR 1",
      "alarko ALGYO 1",
      "akfen AKFEN 1",
      "No article loses every attachment",
    ]) {
      expect(header, word).toContain(word);
    }
    // the shipped (un-narrowed) B dropped trive and meksa too: 41 hits; recorded as the reason for the narrowing
    for (const kept of ["41 dropped", "trive TRMEN 9", "trive TVM 9", "meksa MEKMD 1", "meksa MSA 1"]) {
      expect(header, kept).toContain(kept);
    }
    // the run before the narrowing is not the pinned run any more
    for (const stale of ["233 without", "190 with", "43 dropped", "11 (alias, ticker) pairs"]) {
      expect(header, stale).not.toContain(stale);
    }
    expect(header).toContain("zero drops outside shared aliases");
    // the Alarko Carrier side effect is measured, not hidden
    expect(header).toContain("Alarko Carrier");
    expect(header).toContain("ALCAR");
  });

  it("the header carries the two FOUNDER-ONLY follow-ups, neither of which this file does", () => {
    const header = flat(header171());
    expect(header).toContain("FOUNDER-ONLY");
    expect(header).toContain("(a) Optional cleanup of the existing 30-day rows");
    expect(header).toContain("724 rows");
    expect(header).toContain("data rewrite");
    expect(header).toContain("(b) The 595 all-auto traded siblings");
    expect(header).toContain("manual parent alias");
    expect(header).toContain("rule A then resolves them");
  });

  it("follow-up (b) lists only all-auto traded groups: oyak, akfen, ihlas and lydia stay; vestel, alnus, eregli and ronesans are gone", () => {
    const b = followUpB(flat(header171()));
    for (const keep of ["oyak OYAKC/OYAYO", "akfen", "ihlas", "lydia"]) expect(b, keep).toContain(keep);
    // vestel: VESTL is a manual row, rule A resolves it; alnus: both rows untraded; eregli and ronesans: rule B already leaves one row
    for (const gone of ["vestel", "alnus", "eregli", "ronesans"]) expect(b.toLowerCase(), gone).not.toContain(gone);
  });

  it("THE RULE records rule B's narrowing as a deliberate deviation from the spec, with the reason and the measured footprint", () => {
    const header = flat(header171());
    const rule = between(header, "THE RULE", "EXPECTED EFFECT");
    expect(rule).toContain("deliberate deviation");
    expect(rule).toContain("manual or traded sibling");
    for (const fact of ["23 shared aliases", "denizbank", "alternatifbank", "anadolubank", "fibabanka", "burgan", "alnus", "trive", "231 rows", "114 articles", "74"]) {
      expect(rule, fact).toContain(fact);
    }
    expect(rule).toContain("only untraded auto rows");
  });

  it("the header says what the dry-run script runs and how the join is split, not 'exactly two predicates in the alias_hits join'", () => {
    const header = flat(header171());
    expect(header).not.toContain("exactly two predicates");
    expect(header).not.toContain("in the alias_hits join");
    expect(header).not.toContain("removing the two predicates");
    expect(header).toContain("alias_matches as materialized");
    expect(header).toContain("alias_hits' WHERE");
  });

  it("COST: one article is about 1 ms again, and why it matters (058 per-row trigger, authenticator's 8 s statement_timeout, 57014)", () => {
    const header = flat(header171());
    const cost = between(header, "COST", "FOUNDER-ONLY");
    for (const fact of [
      "0.89 ms",
      "62 ms",
      "0.92 ms",
      "058",
      "per-row",
      "PostgREST upsert",
      "authenticator",
      "statement_timeout",
      "8 s",
      "57014",
      "223 non-spor rows",
      "2026-11-06 13:03:10",
    ]) {
      expect(cost, fact).toContain(fact);
    }
    expect(cost).toContain("MATERIALIZED");
    // the shipped-before-fix claim (+60 ms an article, 'roughly ten minutes of one core') is gone
    expect(cost).not.toContain("about 60 ms of insert latency per article");
  });

  it("VERIFY carries the md5 and the length of THIS file's function body, and the post-deploy query of the spec", () => {
    const body = body171();
    expect(header171()).toContain(`${md5(body)}, ${[...body].length}`);
    expect(md5(body)).not.toBe(PROD_MD5);
    const header = header171();
    const at = header.indexOf("-- VERIFY");
    const end = header.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(header.slice(at, end));
    expect(verify).toContain("select matched_on, ticker, count(*) from public.article_tickers");
    expect(verify).toContain("matched_on in ('alias:turkcell', 'alias:tskb', 'alias:alarko', 'alias:migros', 'alias:enerjisa', 'alias:kardemir')");
    for (const t of ["FNCLL", "TSGYO", "TSKYO", "ALCAR", "ALGYO", "MIGRS", "EEDAS", "KRDMA", "KRDMB", "KARCL"]) {
      expect(verify, t).toContain(t);
    }
    expect(verify).toContain("GET /ekonomi");
  });

  it("the header's ROLLBACK restores 085's function and removes only the 171 ledger row (the file itself never spells out a delete)", () => {
    const header = header171();
    const rb = flat(header.slice(header.indexOf("-- ROLLBACK")));
    expect(rb).toContain("085_ticker_code_gate.sql");
    expect(rb).toContain(PROD_MD5);
    expect(rb).toContain("version = '171'");
    expect(rb).toContain("supabase_migrations.schema_migrations");
    expect(rb).toContain("grants do not change");
  });
});

describe("171 ticker_alias_siblings: derive-and-compare against 085", () => {
  const norm = (sql: string): string => collapse(stripComments(sql));

  it("alias_matches is MATERIALIZED, sits between ctx and alias_hits, and alias_hits is its only reader", () => {
    const c = norm(body171());
    // without the keyword the planner inlines the CTE and pushes the alias-only predicates back into the scan of bist_aliases
    expect(c).toContain(MATCH_OPEN);
    expect(countOf(c, "alias_matches as")).toBe(1);
    expect(c.indexOf(MATCH_OPEN)).toBeGreaterThan(c.indexOf(", ctx as ("));
    expect(c.indexOf(MATCH_OPEN)).toBeLessThan(c.indexOf(HITS_OPEN));
    expect(countOf(c, "alias_matches")).toBe(2);
    expect(segments(body171()).aliasHits).toContain("from alias_matches al where ");
    // 085 has none of it
    expect(norm(body085)).not.toContain("alias_matches");
  });

  it("alias_matches' join text equals 085's alias_hits join conditions, verbatim", () => {
    const a = segments(body085);
    const b = segments(body171());
    expect(joinOf(a.aliasHits)).toBe(MATCH_JOIN);
    expect(joinOf(b.aliasMatches)).toBe(MATCH_JOIN);
    expect(joinOf(b.aliasMatches)).toBe(joinOf(a.aliasHits));
    // the select list carries what alias_hits needs (alias for matched_on, origin for the predicates) and no predicate
    expect(b.aliasMatches.startsWith(`${MATCH_OPEN}select r.id as article_id, al.alias, al.ticker, al.origin, r.published_at, r.source_id from ctx r join `)).toBe(true);
  });

  it("each predicate core appears exactly once, inside alias_hits' WHERE, and never in alias_matches or a join ON clause", () => {
    const c = norm(body171());
    const { aliasMatches, aliasHits } = segments(body171());
    for (const core of [CORE_A, CORE_B]) {
      expect(countOf(c, core), core).toBe(1);
      expect(countOf(aliasHits, core), core).toBe(1);
      expect(aliasMatches, core).not.toContain(core);
    }
    // alias_hits is exactly: select over alias_matches `al`, where A and B (the correlation name `al` keeps the predicate text)
    expect(aliasHits).toBe(
      `${HITS_OPEN}select al.article_id, al.ticker, 'alias:' || al.alias as matched_on, al.published_at, al.source_id from alias_matches al where ${CORE_A} and ${CORE_B})`,
    );
    // no ON clause of any join, in any CTE, carries a predicate or an origin test beyond 085's `(al.origin = 'manual' or r.fin_ctx)`
    const ons = onClauses(c);
    expect(ons).toHaveLength(3); // alias_matches' join, code_hits' lateral join, code_hits' ticker join
    for (const on of ons) {
      expect(on).not.toContain("al.origin = 'auto'");
      expect(on).not.toContain("not exists");
      expect(on).not.toContain("m.origin");
      expect(on).not.toContain("o.alias");
      expect(on).not.toContain("c2.");
    }
  });

  it("substituting 085's alias_hits for the alias_matches + alias_hits pair gives 085's body (whitespace and comments normalised)", () => {
    const c = norm(body171());
    const base = norm(body085);
    const from = c.indexOf(MATCH_OPEN);
    const to = c.indexOf(CODE_OPEN);
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    const h085 = base.slice(base.indexOf(HITS_OPEN), base.indexOf(CODE_OPEN));
    expect(h085.startsWith(`${HITS_OPEN}select r.id as article_id, al.ticker, 'alias:' || al.alias as matched_on, r.published_at, r.source_id ${MATCH_JOIN}`)).toBe(true);
    expect(`${c.slice(0, from)}${h085}${c.slice(to)}`).toBe(base);
  });

  it("the substitution notices a change outside the pair: 171's body is not 085's, and an edit to recent or code_hits breaks the equality", () => {
    const c = norm(body171());
    const base = norm(body085);
    expect(c).not.toBe(base);
    const from = c.indexOf(MATCH_OPEN);
    const to = c.indexOf(CODE_OPEN);
    const h085 = base.slice(base.indexOf(HITS_OPEN), base.indexOf(CODE_OPEN));
    expect(from, "the alias_matches CTE").toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    for (const edit of [["<> 'spor'", "<> 'x'"], ["c.ticker <> all", "c.ticker = all"]] as const) {
      const mutated = c.replace(edit[0], edit[1]);
      expect(mutated, edit[0]).not.toBe(c);
      expect(`${mutated.slice(0, from)}${h085}${mutated.slice(to)}`, edit[0]).not.toBe(base);
    }
  });

  it("every other segment is 085's, unchanged: recent, ctx, code_hits and the hits/insert tail", () => {
    const a = segments(body085);
    const b = segments(body171());
    expect(b.recent).toBe(a.recent);
    expect(b.ctx).toBe(a.ctx);
    expect(b.codeHits).toBe(a.codeHits);
    expect(b.tail).toBe(a.tail);
    expect(b.aliasHits).not.toBe(a.aliasHits);
    expect(a.aliasMatches).toBe("");
  });

  it("code_hits and the fin_ctx gate are not touched: no bist_aliases, no alias row and no predicate inside them", () => {
    const { codeHits, ctx } = segments(body171());
    expect(codeHits).not.toContain("bist_aliases");
    expect(codeHits).not.toContain("al.");
    expect(codeHits).toContain("c.ticker <> all (public.ticker_code_stoplist())");
    expect(ctx).toContain("(r.category = 'ekonomi' or r.folded ~ public.finance_context_regex()) as fin_ctx");
    // the join in alias_matches, the manual-sibling lookup m (A) and the sharing lookup o (B)
    expect(countOf(collapse(body171()), "public.bist_aliases")).toBe(3);
  });

  it("each predicate is gated on origin = 'auto': a manual row is never dropped", () => {
    expect(CORE_A.startsWith("not (al.origin = 'auto' and ")).toBe(true);
    expect(CORE_B.startsWith("not (al.origin = 'auto' and ")).toBe(true);
    const c = norm(body171());
    expect(countOf(c, "not (al.origin = 'auto' and ")).toBe(2);
  });

  it("rule B is narrowed: an untraded auto row drops only next to a sibling that is manual or traded, not next to an untraded auto one", () => {
    const c = norm(body171());
    expect(c).toContain(
      "and exists (select 1 from public.bist_aliases o where o.alias = al.alias and o.enabled and o.ticker <> al.ticker and (o.origin = 'manual' or exists (select 1 from public.bist_companies c2 where c2.shares_traded and c2.tickers @> array[o.ticker])))",
    );
    // the spec's bare sibling test (any other enabled row of the alias) is gone
    expect(c).not.toContain("o.enabled and o.ticker <> al.ticker))");
  });
});

describe("171 ticker_alias_siblings: the function keeps 085's signature, security mode, search_path and grants", () => {
  it("creates the function with create or replace, 085's header after normalisation", () => {
    const h171 = collapse(stripComments(resolverHeader(sql171))).toLowerCase();
    const h085 = collapse(stripComments(resolverHeader(sql085))).toLowerCase();
    expect(h171).toBe(h085);
    expect(h171).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as $$",
    );
  });

  it("is security invoker as in 085 (no security definer, no volatility keyword, an empty search_path)", () => {
    const code = collapse(sansStrings(stripComments(sql171))).toLowerCase();
    expect(code).not.toContain("security definer");
    expect(code).not.toContain("security invoker");
    expect(code).not.toContain("immutable");
    expect(code).not.toContain(" stable");
    expect(code).toContain("set search_path = ''");
  });

  it("re-issues the revoke and grant lines: revoke from public, anon and authenticated, execute to service_role only", () => {
    const code = `${statements(sql171).join(";\n")};`;
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
    const grants = statements(sql171).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
    const sans = sansStrings(code).toLowerCase();
    expect(sans).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(table|tables|sequence|sequences)\b/);
    expect(sans).not.toMatch(/\balter\s+default\s+privileges\b/);
    expect(sans).not.toContain(" to anon");
    expect(sans).not.toContain(" to authenticated");
    expect(sans).not.toContain(" to public");
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty), the new subqueries included", () => {
    const code = sansStrings(stripComments(body171()));
    const rels = [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string);
    expect(rels.length).toBeGreaterThan(0);
    for (const rel of rels) {
      // `from public.x`, or a CTE of this statement (recent, ctx, alias_matches, alias_hits, code_hits, hits), or the `join lateral` keyword
      expect(rel, `unqualified relation ${rel}`).toMatch(
        /^(public\.|pg_catalog\.|recent$|ctx$|alias_matches$|alias_hits$|code_hits$|hits$|lateral$)/,
      );
    }
    // bist_aliases: the manual-sibling lookup m and the sharing lookup o; bist_companies: code_hits, c and c2
    expect(countOf(collapse(code), "from public.bist_aliases")).toBe(2);
    expect(countOf(collapse(code), "from public.bist_companies")).toBe(3);
  });
});

describe("171 ticker_alias_siblings: additive, no data is written by the migration", () => {
  const stmts = statements(sql171);

  it("holds only the transaction frame, the timeout, one function, its privileges and the ledger row", () => {
    const expected = [
      "begin",
      "set local lock_timeout",
      "create or replace function",
      "revoke all on function",
      "grant execute on function",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ];
    expect(stmts).toHaveLength(expected.length);
    expected.forEach((prefix, i) => {
      expect((stmts[i] as string).toLowerCase().startsWith(prefix), `${i}: ${stmts[i]}`).toBe(true);
    });
  });

  it("the file contains no `delete from` and no `update public.`, truncate, alter, drop, copy or create table/index", () => {
    // the strictest reading first: not even a comment spells either statement out
    expect(sql171.toLowerCase()).not.toContain("delete from");
    expect(sql171.toLowerCase()).not.toContain("update public.");
    const sans = sansStrings(stripComments(sql171)).toLowerCase();
    expect(sans).not.toContain("delete from");
    expect(sans).not.toContain("update public.");
    expect(sans).not.toMatch(/(^|\s)update\s/);
    expect(sans).not.toMatch(/\btruncate\b/);
    expect(sans).not.toMatch(/\balter\s+(table|function|role|default)/);
    expect(sans).not.toMatch(/\bdrop\s+/);
    expect(sans).not.toMatch(/\bcreate\s+(table|index|unique|trigger|extension|view|policy|schema)/);
    expect(sans).not.toMatch(/\bcopy\b/);
    expect(countOf(sans, "create "), "one create statement: the function").toBe(1);
  });

  it("the only write in the whole file besides the ledger is the function's own insert into article_tickers, as in 085", () => {
    const code = sansStrings(stripComments(sql171)).toLowerCase();
    const inserts = [...code.matchAll(/insert\s+into\s+([a-z_][\w.]*)/g)].map((m) => m[1]);
    expect(inserts).toEqual(["public.article_tickers", "supabase_migrations.schema_migrations"]);
    const body = sansStrings(stripComments(body171())).toLowerCase();
    expect(body).not.toMatch(/\b(?:update|delete|truncate)\b/);
    expect(body).not.toContain("bist_aliases set");
  });

  it("the one top-level insert is the ledger row, written the way 156 and 170 do", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([LEDGER_STMT.slice(0, -1)]);
  });

  it("does not touch the stoplist function or the 085 data fixes (no ticker_code_stoplist definition, no alias disable)", () => {
    const code = collapse(sansStrings(stripComments(sql171))).toLowerCase();
    expect(code).not.toContain("create or replace function public.ticker_code_stoplist");
    expect(code).not.toContain("enabled = false");
  });
});

describe("171 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 171 ") ? sectionOf(guide, "171") : "";

  it("sits directly after section 170 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 171 ")).toBeGreaterThan(guide.indexOf("\n## 170 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 170 ") + 1)).toBe(guide.indexOf("\n## 171 "));
  });

  it("has Why, What, an md5 table, Cost, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 171 does**", "| md5(prosrc) | length |", "**Cost**", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    const body = body171();
    expect(section).toContain(PROD_MD5);
    expect(section).toContain(String(PROD_LENGTH));
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });

  it("states the evidence, the two rules and the dry-run numbers", () => {
    for (const word of [
      "h57-ekonomi-2",
      "TSGYO",
      "TSKYO",
      "FNCLL",
      "OYAYO",
      "1,319",
      "263",
      "461",
      "595",
      "rule A",
      "rule B",
      "alias_hits",
      "alias_matches",
      "7,978 non-sports rows",
      "227 alias hits without, 206 with: 21 dropped",
      "articles with an alias hit 163 before and 163 after",
      "The 21 are 7 (alias, ticker) pairs",
      "No article loses every attachment",
      "41 dropped",
      "trive TRMEN 9",
      "meksa MEKMD 1",
      "Alarko Carrier",
    ]) {
      expect(section, word).toContain(word);
    }
    for (const stale of ["233 alias hits", "190 with", "43 dropped", "11 (alias, ticker) pairs", "removing the two predicates"]) {
      expect(section, stale).not.toContain(stale);
    }
  });

  it("describes the split join, not 'two predicates added to the alias_hits join'", () => {
    expect(section).not.toContain("exactly two predicates");
    expect(section).not.toContain("added to the `alias_hits` join");
    expect(section).toContain("alias_matches as materialized");
    expect(section).toContain("alias_hits' WHERE");
  });

  it("records rule B's narrowing as a deliberate deviation from the spec, with the reason and the measured footprint", () => {
    const what = between(section, "**What 171 does**", "| md5(prosrc) | length |");
    expect(what).toContain("deliberate deviation");
    expect(what).toContain("manual or traded sibling");
    for (const fact of ["23 shared aliases", "denizbank", "alternatifbank", "anadolubank", "fibabanka", "burgan", "alnus", "trive", "231 rows", "114 articles", "74"]) {
      expect(what, fact).toContain(fact);
    }
    expect(what).toContain("only untraded auto rows");
  });

  it("Cost: one article is about 1 ms again, and why it matters (058 per-row trigger, authenticator's 8 s statement_timeout, 57014)", () => {
    const cost = between(section, "**Cost**", "**Order:**");
    for (const fact of [
      "0.89 ms",
      "62 ms",
      "0.92 ms",
      "058",
      "per-row",
      "PostgREST upsert",
      "authenticator",
      "statement_timeout",
      "8 s",
      "57014",
      "223 non-spor rows",
      "2026-11-06 13:03:10",
      "MATERIALIZED",
    ]) {
      expect(cost, fact).toContain(fact);
    }
    expect(cost).not.toContain("about 60 ms of insert latency per article");
  });

  it("follow-up (b) lists only all-auto traded groups: oyak, akfen, ihlas and lydia stay; vestel, alnus, eregli and ronesans are gone", () => {
    const b = followUpB(section);
    for (const keep of ["oyak OYAKC/OYAYO", "akfen", "ihlas", "lydia"]) expect(b, keep).toContain(keep);
    for (const gone of ["vestel", "alnus", "eregli", "ronesans"]) expect(b.toLowerCase(), gone).not.toContain(gone);
  });

  it("states the order: APPLY 171 only, no deploy-order constraint", () => {
    expect(section).toContain("APPLY 171");
    expect(section).toMatch(/no (Next\.js change|deploy)/i);
  });

  it("verifies the fingerprint, the privileges, the ledger and the aliases, and the /ekonomi feed", () => {
    for (const word of [
      "md5(prosrc)",
      "has_function_privilege",
      "schema_migrations",
      "version = '171'",
      "resolve_article_tickers_for",
      "alias:turkcell",
      "/ekonomi",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs 085's function and deletes only the 171 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("085_ticker_code_gate.sql");
    expect(rb).toContain(PROD_MD5);
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '171'");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("171 live manifest and dry-run", () => {
  it("builds 171's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 171-ticker-alias-siblings.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/171-ticker-alias-siblings-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 085's state (gated on the production md5), shows the defect, applies 171 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/085_ticker_code_gate.sql",
      "../../../supabase/migrations/171_ticker_alias_siblings.sql",
      "../../../supabase/migrations/171_ticker_alias_siblings.sql",
    ]);
    expect(sql).toContain(PROD_MD5);
    expect(sql).toContain(md5(body171()));
    expect(sql).toContain("baseline: 085 attaches the untraded affiliate FNCLL and the auto siblings TSGYO and TSKYO");
    // narrowed B: an all-untraded alias keeps 085's behaviour; an untraded auto row next to an untraded MANUAL sibling still drops
    expect(sql).toContain("an all-untraded auto alias should keep 085''s behaviour");
    expect(sql).toContain("'TRMEN,TVM'");
    expect(sql).toContain("an untraded auto row next to an untraded MANUAL sibling should drop (rule A)");
    // the time budget: ~2,000 shared untraded auto aliases, ~2,000 companies, one non-matching article, 50 ms
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain("generate_series(1, 1000)");
    expect(sql).toContain("generate_series(1, 2000)");
    expect(sql).toContain("resolve_article_tickers_for(array[v_id])");
    expect(sql).toContain("if v_ms > 50 then");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 171 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway Postgres with 085 then 171 applied by the dry-run
// script (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select
// the server. Every case runs inside begin ... rollback; no case deletes anything.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("171 resolve_article_tickers_for against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("171", {
    ledger: ["085", "171"],
    relations: ["public.bist_aliases", "public.bist_companies", "public.article_tickers"],
    functions: [
      "public.resolve_article_tickers_for(uuid[])",
      "public.ticker_code_stoplist()",
      "public.fold_tr(text)",
      "public.finance_context_regex()",
    ],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  const lit = (s: string): string => `'${s.replaceAll("'", "''")}'`;
  const ART = "a0000000-0000-0000-0000-000000000001";

  interface Alias {
    alias: string;
    ticker: string;
    origin: "manual" | "auto";
    enabled?: boolean;
  }
  interface Company {
    tickers: string[];
    traded: boolean;
  }

  /**
   * One article, the alias and company fixtures, one resolver call. Returns the call's row count, then the tickers that
   * attached sorted and joined by commas ("-" for none), as "n|TICKERS". All of it inside begin ... rollback.
   */
  function resolve(aliases: Alias[], companies: Company[], title: string, category = "ekonomi", description = ""): string {
    const aliasRows = aliases.map((a) => `(${lit(a.alias)}, ${lit(a.ticker)}, ${lit(a.origin)}, ${a.enabled === false ? "false" : "true"})`).join(", ");
    const companyRows = companies
      .map((c) => `(array[${c.tickers.map(lit).join(", ")}]::text[], ${c.traded ? "true" : "false"})`)
      .join(", ");
    const sql = [
      "begin;",
      aliases.length > 0 ? `insert into public.bist_aliases (alias, ticker, origin, enabled) values ${aliasRows};` : "",
      companies.length > 0 ? `insert into public.bist_companies (tickers, shares_traded) values ${companyRows};` : "",
      `insert into public.articles (id, title, description, category, published_at) values ('${ART}', ${lit(title)}, ${lit(description)}, ${lit(category)}, now());`,
      // two statements: a subquery of the call's own SELECT would read the snapshot from before the call's inserts
      `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
      `select coalesce(string_agg(ticker, ',' order by ticker), '-') from public.article_tickers where article_id = '${ART}';`,
      "rollback;",
    ]
      .filter((l) => l !== "")
      .join("\n");
    const [inserted, tickers] = runPsql(sql).trim().split("\n");
    return `${inserted}|${tickers}`;
  }

  // Production's rows for the six named aliases (read 2026-11-07): [alias, ticker, origin], and whether the company trades.
  const TURKCELL: Alias[] = [
    { alias: "turkcell", ticker: "TCELL", origin: "manual" },
    { alias: "turkcell", ticker: "FNCLL", origin: "auto" },
  ];
  const TURKCELL_CO: Company[] = [
    { tickers: ["TCELL"], traded: true },
    { tickers: ["FNCLL"], traded: false },
  ];
  const TSKB: Alias[] = [
    { alias: "tskb", ticker: "TSKB", origin: "manual" },
    { alias: "tskb", ticker: "TSGYO", origin: "auto" },
    { alias: "tskb", ticker: "TSKYO", origin: "auto" },
  ];
  const TSKB_CO: Company[] = [
    { tickers: ["TSKB"], traded: true },
    { tickers: ["TSGYO"], traded: true },
    { tickers: ["TSKYO"], traded: false },
  ];

  it("the function that runs is the file's: md5 and length of prosrc, security invoker, volatile, empty search_path, service_role only", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || provolatile::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = '${FN_SIG}'::regprocedure;`,
    ).trim();
    const body = body171();
    expect(out).toBe(`${md5(body)}|${[...body].length}|false|v|{"search_path=\\"\\""}|integer|p_ids uuid[]`);
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
    expect(runPsql(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for';`).trim()).toBe("1");
  });

  it("is idempotent: one 171 ledger row", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '171';").trim()).toBe("1");
  });

  it("turkcell gives TCELL only (the manual sibling wins; FNCLL, an untraded affiliate, drops)", () => {
    expect(resolve(TURKCELL, TURKCELL_CO, "Turkcell COP31’de dijital ve yeşil dönüşüm vizyonunu paylaşacak")).toBe("1|TCELL");
  });

  it("tskb gives TSKB only (TSGYO loses to the manual sibling, TSKYO is untraded)", () => {
    expect(resolve(TSKB, TSKB_CO, "Yeşil dönüşümde kredi değil ortaklık modeli iddiası tskb raporunda")).toBe("1|TSKB");
  });

  it("alarko, migros, enerjisa and kardemir each give the manual parent only", () => {
    const alarko: Alias[] = [
      { alias: "alarko", ticker: "ALARK", origin: "manual" },
      { alias: "alarko", ticker: "ALCAR", origin: "auto" },
      { alias: "alarko", ticker: "ALGYO", origin: "auto" },
    ];
    const alarkoCo: Company[] = [
      { tickers: ["ALARK"], traded: true },
      { tickers: ["ALCAR"], traded: true },
      { tickers: ["ALGYO"], traded: true },
    ];
    expect(resolve(alarko, alarkoCo, "Alarko Holding net kar açıkladı")).toBe("1|ALARK");

    const migros: Alias[] = [
      { alias: "migros", ticker: "MGROS", origin: "manual" },
      { alias: "migros", ticker: "MIGRS", origin: "auto" },
    ];
    const migrosCo: Company[] = [
      { tickers: ["MGROS"], traded: true },
      { tickers: ["MIGRS"], traded: false },
    ];
    expect(resolve(migros, migrosCo, "Migros hisse geri alım programı")).toBe("1|MGROS");

    const enerjisa: Alias[] = [
      { alias: "enerjisa", ticker: "ENJSA", origin: "manual" },
      { alias: "enerjisa", ticker: "EEDAS", origin: "auto" },
    ];
    const enerjisaCo: Company[] = [
      { tickers: ["ENJSA"], traded: true },
      { tickers: ["EEDAS"], traded: false },
    ];
    expect(resolve(enerjisa, enerjisaCo, "Enerjisa bilanço sonuçlarını açıkladı")).toBe("1|ENJSA");

    const kardemir: Alias[] = [
      { alias: "kardemir", ticker: "KRDMD", origin: "manual" },
      { alias: "kardemir", ticker: "KRDMA", origin: "auto" },
      { alias: "kardemir", ticker: "KRDMB", origin: "auto" },
      { alias: "kardemir", ticker: "KARCL", origin: "auto" },
    ];
    const kardemirCo: Company[] = [{ tickers: ["KRDMA", "KRDMB", "KRDMD"], traded: true }, { tickers: ["KARCL"], traded: true }];
    expect(resolve(kardemir, kardemirCo, "Kardemir hisse bilanço beklentisi")).toBe("1|KRDMD");
  });

  it("rule B alone: an untraded auto sibling drops, its traded auto sibling stays (no manual row involved)", () => {
    const eregli: Alias[] = [
      { alias: "eregli", ticker: "EREGL", origin: "auto" },
      { alias: "eregli", ticker: "ERGLI", origin: "auto" },
    ];
    const co: Company[] = [
      { tickers: ["EREGL"], traded: true },
      { tickers: ["ERGLI"], traded: false },
    ];
    expect(resolve(eregli, co, "Eregli hisse bilanço sonrası yükseldi")).toBe("1|EREGL");
  });

  it("an alias whose siblings are ALL untraded auto keeps 085's behaviour: both attach (rule B is narrowed: no manual or traded sibling)", () => {
    const trive: Alias[] = [
      { alias: "trive", ticker: "TRMEN", origin: "auto" },
      { alias: "trive", ticker: "TVM", origin: "auto" },
    ];
    const co: Company[] = [{ tickers: ["TRMEN"], traded: false }, { tickers: ["TVM"], traded: false }];
    expect(resolve(trive, co, "Trive Yatırım’ın faaliyetlerine geçici durdurma kararı SPK")).toBe("2|TRMEN,TVM");
  });

  it("an untraded auto row next to an untraded MANUAL sibling still drops (rule A), and next to an untraded auto sibling it stays", () => {
    const yonet: Alias[] = [
      { alias: "yonet", ticker: "YONET", origin: "manual" },
      { alias: "yonet", ticker: "YONYO", origin: "auto" },
    ];
    const co: Company[] = [{ tickers: ["YONET"], traded: false }, { tickers: ["YONYO"], traded: false }];
    expect(resolve(yonet, co, "Yonet hisse bilanço")).toBe("1|YONET");
    // an untraded auto row whose traded sibling is a different company still drops (the EREGL case, here with two untraded auto rows)
    const mixed: Alias[] = [
      { alias: "karma", ticker: "KARMA", origin: "auto" },
      { alias: "karma", ticker: "KARUN", origin: "auto" },
      { alias: "karma", ticker: "KARTR", origin: "auto" },
    ];
    const mixedCo: Company[] = [{ tickers: ["KARMA"], traded: true }, { tickers: ["KARUN"], traded: false }, { tickers: ["KARTR"], traded: false }];
    expect(resolve(mixed, mixedCo, "Karma hisse bilanço")).toBe("1|KARMA");
  });

  it("all-auto TRADED siblings still all attach: the 595-row bucket is a founder decision (a manual parent alias), not this rule", () => {
    const oyak: Alias[] = ["OYA", "OYAKC", "OYAYO", "OYYAT"].map((ticker) => ({ alias: "oyak", ticker, origin: "auto" as const }));
    const co: Company[] = ["OYA", "OYAKC", "OYAYO", "OYYAT"].map((t) => ({ tickers: [t], traded: true }));
    expect(resolve(oyak, co, "OYAK’tan Libya petrolünde büyük hamle hisse")).toBe("4|OYA,OYAKC,OYAYO,OYYAT");
    // ... and one manual parent alias is all rule A needs to resolve them (the owner's pick: OYAKC here)
    const withParent: Alias[] = [
      { alias: "oyak", ticker: "OYA", origin: "auto" },
      { alias: "oyak", ticker: "OYAYO", origin: "auto" },
      { alias: "oyak", ticker: "OYYAT", origin: "auto" },
      { alias: "oyak", ticker: "OYAKC", origin: "manual" },
    ];
    expect(resolve(withParent, co, "OYAK’tan Libya petrolünde büyük hamle hisse")).toBe("1|OYAKC");
  });

  it("an alias with a single row is untouched, even an untraded auto one (nothing shares it)", () => {
    const solo: Alias[] = [{ alias: "tekil", ticker: "TEKIL", origin: "auto" }];
    expect(resolve(solo, [{ tickers: ["TEKIL"], traded: false }], "Tekil hisse bilanço duyurusu")).toBe("1|TEKIL");
  });

  it("manual rows are never dropped, shared or not, traded or not", () => {
    const two: Alias[] = [
      { alias: "ortak", ticker: "ORTAK", origin: "manual" },
      { alias: "ortak", ticker: "ORTYO", origin: "manual" },
    ];
    const co: Company[] = [{ tickers: ["ORTAK"], traded: true }, { tickers: ["ORTYO"], traded: false }];
    expect(resolve(two, co, "Ortak hisse bilanço")).toBe("2|ORTAK,ORTYO");
  });

  it("a DISABLED manual sibling neither wins (rule A) nor counts as a sharer (rule B)", () => {
    const disabledManual: Alias[] = [
      { alias: "pasif", ticker: "PASIF", origin: "manual", enabled: false },
      { alias: "pasif", ticker: "PASYO", origin: "auto" },
    ];
    const co: Company[] = [{ tickers: ["PASIF"], traded: true }, { tickers: ["PASYO"], traded: true }];
    expect(resolve(disabledManual, co, "Pasif hisse bilanço")).toBe("1|PASYO");
    const disabledOther: Alias[] = [
      { alias: "eski", ticker: "ESKIX", origin: "auto" },
      { alias: "eski", ticker: "ESKIY", origin: "auto", enabled: false },
    ];
    expect(resolve(disabledOther, [{ tickers: ["ESKIX"], traded: false }], "Eski hisse bilanço")).toBe("1|ESKIX");
  });

  it("the finance-context gate is 085's: outside finance an auto alias still needs context, a manual one does not", () => {
    // category 'dunya', no finance word: TCELL (manual) attaches, nothing auto does
    expect(resolve(TURKCELL, TURKCELL_CO, "Turkcell kurucusu Kopenhag'da konuştu", "dunya")).toBe("1|TCELL");
    // an auto-only alias outside finance does not attach at all
    const auto: Alias[] = [{ alias: "tekil", ticker: "TEKIL", origin: "auto" }];
    expect(resolve(auto, [{ tickers: ["TEKIL"], traded: true }], "Tekil festivali açıldı", "yasam")).toBe("0|-");
  });

  it("code_hits is 085's: a dropped sibling still attaches when its own code is written in the text", () => {
    // TSGYO lost its alias row to rule A, but a headline that names the code TSGYO matches the code path
    expect(resolve(TSKB, TSKB_CO, "TSGYO paylarında hareket")).toBe("1|TSGYO");
    // and an untraded ticker's code never matches (the code path reads traded tickers only)
    expect(resolve(TSKB, TSKB_CO, "TSKYO paylarında hareket")).toBe("0|-");
  });

  it("writes nothing but article_tickers: the alias and company tables are as they were", () => {
    const out = runPsql(
      [
        "begin;",
        "insert into public.bist_aliases (alias, ticker, origin, enabled) values ('turkcell', 'TCELL', 'manual', true), ('turkcell', 'FNCLL', 'auto', true);",
        "insert into public.bist_companies (tickers, shares_traded) values (array['TCELL'], true), (array['FNCLL'], false);",
        `insert into public.articles (id, title, description, category, published_at) values ('${ART}', 'Turkcell hisse bilanço', '', 'ekonomi', now());`,
        `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
        `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
        "select (select count(*) from public.bist_aliases) || '|' || (select count(*) filter (where enabled) from public.bist_aliases) || '|' || (select count(*) from public.bist_companies) || '|' || (select count(*) from public.article_tickers);",
        "rollback;",
      ].join("\n"),
    )
      .trim()
      .split("\n");
    // first call inserts 1 row, the second finds the conflict and inserts 0; two aliases, both enabled, two companies, one tag
    expect(out).toEqual(["1", "0", "2|2|2|1"]);
  });
});
