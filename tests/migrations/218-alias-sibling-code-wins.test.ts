import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// ---------------------------------------------------------------------------
// Contract test for migration 218 ("alias_sibling_code_wins"), h207-ekonomi-1 (hunt 207).
//
// 085's alias join attaches every enabled auto alias row of a shared alias. When two companies share an auto alias ('baticim' ->
// BSOKE and BTCIM, bucket C of migration 171: no manual row, both traded), rules A and B never fire and 217's rule C has no block row,
// so a story that writes BTCIM by its CODE ("SPK'dan BTCIM hisselerine islem yasagi") also attaches BSOKE through alias:baticim, and
// BSOKE climbs the /ekonomi tape ("tavan", "ilgi 8,8x") on another company's ban.
//
// 218 adds rule D, "a sibling named by its code wins": an AUTO alias row for ticker Y does not attach when the same article's code_hits
// hold another ticker Z that shares the alias (an enabled bist_aliases row with the same alias and ticker Z). Y still attaches when the
// text writes Y's own code (through code_hits, as today) and a manual row is never dropped. The function is re-created with 217's
// body VERBATIM plus exactly two edits: (1) the code_hits CTE, text unchanged, moves between ctx and alias_matches (a CTE can only
// read an earlier one), and (2) alias_hits' WHERE gains the one predicate after rule C. No table, no data change, no backfill.
//
// This file pins, without a database: the file, ledger and transaction; that 217's body is the pinned production text; derive-and-compare
// ("undoing edit 2 and moving code_hits back gives 217's body, byte for byte"); that rules A, B and C and everything else are untouched;
// grants; that nothing existing is written; the header, the docs sections and the PG15 dry-run script (the live behaviour is that script's:
// tests/migrations/sql/218-alias-sibling-code-wins-dryrun.sql, picked up by run-live.sh Phase A, so this file needs no live block and no
// live-manifest entry).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_217 = "217_alias_blockers.sql";
const FILE_218 = "218_alias_sibling_code_wins.sql";
const MIGRATION_217 = resolve(MIGRATIONS_DIR, FILE_217);
const MIGRATION_218 = resolve(MIGRATIONS_DIR, FILE_218);
const DOC_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_ARCH = resolve(ROOT, "docs", "architecture.md");
const DRYRUN = resolve(__dirname, "sql", "218-alias-sibling-code-wins-dryrun.sql");

/** Production, read-only, 2026-11-22 ~12:39Z: the resolver that runs is 217's body. */
const BODY_217_MD5 = "fd6429df30125e201fe28278c606c53e";
const BODY_217_LENGTH = 3693;

const FN = "public.resolve_article_tickers_for";
const FN_SIG = `${FN}(uuid[])`;
const RESOLVER_MARKER = `create or replace function ${FN}(p_ids uuid[])`;

/** Edit (2): rule D, the last predicate of alias_hits' WHERE (after rule C), on its own line. */
const EDIT_D =
  "\n      and not (al.origin = 'auto' and exists (select 1 from code_hits ch join public.bist_aliases s on s.alias = al.alias and s.enabled and s.ticker = ch.ticker where ch.article_id = al.article_id and ch.ticker <> al.ticker))";
/** Rule C (217), the line rule D follows. */
const RULE_C_LINE =
  "\n      and not exists (select 1 from public.bist_alias_blocks b where b.alias = al.alias and pg_catalog.strpos(al.folded, ' ' || b.phrase || ' ') > 0)";
const CTE_END = "\n  ),\n";

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

/** Header comment block read as prose: `--` markers dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\n--\s*/g, " ").replace(/\s+/g, " ");
}

function codeOf(sql: string): string {
  const at = sql.indexOf("\nbegin;");
  expect(at, "a begin; statement").toBeGreaterThanOrEqual(0);
  return sql.slice(at);
}

/** The text between the first two `$$` markers at or after the first occurrence of `marker` in the code part. */
function bodyAfter(sql: string, marker: string): string {
  const code = codeOf(sql);
  const at = code.indexOf(marker);
  expect(at, `${marker} in the file`).toBeGreaterThanOrEqual(0);
  const open = code.indexOf("$$", at);
  const close = code.indexOf("$$", open + 2);
  expect(open).toBeGreaterThan(at);
  expect(close).toBeGreaterThan(open);
  return code.slice(open + 2, close);
}

/** The top-level statements of the executable part, comments gone, every dollar body replaced by BODY. */
function statementsOf(sql: string): string[] {
  let code = codeOf(sql);
  for (;;) {
    const open = code.indexOf("$$");
    if (open < 0) break;
    const close = code.indexOf("$$", open + 2);
    expect(close, "a closing dollar quote").toBeGreaterThan(open);
    code = code.slice(0, open) + "@@BODY@@" + code.slice(close + 2);
  }
  return stripComments(code)
    .split(";")
    .map((s) => collapse(s))
    .filter((s) => s.length > 0);
}

/** The `## <num>` section of a markdown file, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

/** The text between two markers of a prose (the first `to` after `from`), the markers included. */
function between(prose: string, from: string, to: string): string {
  const at = prose.indexOf(from);
  expect(at, `marker ${from}`).toBeGreaterThanOrEqual(0);
  const end = prose.indexOf(to, at);
  expect(end, `marker ${to} after ${from}`).toBeGreaterThan(at);
  return prose.slice(at, end + to.length);
}

/** One CTE of the body, from its two-space-indented name through its closing `  ),` line (newline included). */
function cteBlock(body: string, name: string): string {
  const at = body.indexOf(`  ${name} as (`);
  expect(at, `${name} CTE`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf(CTE_END, at);
  expect(end, `end of ${name} CTE`).toBeGreaterThan(at);
  return body.slice(at, end + CTE_END.length);
}

/** Part of a body from the first `from` up to (not including) the first `to` after it. */
function seg(body: string, from: string, to: string): string {
  const at = body.indexOf(from);
  expect(at, `marker ${from}`).toBeGreaterThanOrEqual(0);
  const end = body.indexOf(to, at);
  expect(end, `marker ${to} after ${from}`).toBeGreaterThan(at);
  return body.slice(at, end);
}

function pos(text: string, needle: string): number {
  const i = text.indexOf(needle);
  expect(i, needle).toBeGreaterThanOrEqual(0);
  return i;
}

const sql217 = readFileSync(MIGRATION_217, "utf8");
const body217 = bodyAfter(sql217, RESOLVER_MARKER);
const sql218 = existsSync(MIGRATION_218) ? readFileSync(MIGRATION_218, "utf8") : "";
const need218 = (): void => {
  expect(existsSync(MIGRATION_218), `${FILE_218} must exist`).toBe(true);
};
const head218 = (): string => {
  need218();
  return sql218.slice(0, sql218.indexOf("\nbegin;"));
};
const resolver218 = (): string => {
  need218();
  return bodyAfter(sql218, RESOLVER_MARKER);
};
const stmts218 = (): string[] => {
  need218();
  return statementsOf(sql218);
};

/** Edit (1) and (2) undone: rule D removed, code_hits moved back to sit between alias_hits and hits. */
const derive = (b: string): string => {
  const block = cteBlock(b, "code_hits");
  return b
    .replace(EDIT_D, () => "")
    .replace(block, () => "")
    .replace("  hits as (", () => `${block}  hits as (`);
};

// ---------------------------------------------------------------------------

describe("218 alias_sibling_code_wins: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 218", () => {
    expect(existsSync(MIGRATION_218), FILE_218).toBe(true);
    const claims = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("218_"));
    expect(claims).toEqual([FILE_218]);
  });

  it("never reuses a held number: 197 and 202 stay free", () => {
    const names = readdirSync(MIGRATIONS_DIR);
    expect(names.filter((n) => n.startsWith("197_") || n.startsWith("202_"))).toEqual([]);
  });

  it("holds only the transaction frame, the timeout, the resolver with its privileges and the ledger row, in that order", () => {
    const st = stmts218();
    expect(st).toHaveLength(7);
    expect(st[0]).toBe("begin");
    expect(st[1]).toBe("set local lock_timeout = '5s'");
    expect(st[2]).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as @@BODY@@",
    );
    expect(st[3]).toBe(`revoke all on function ${FN_SIG} from public, anon, authenticated`);
    expect(st[4]).toBe(`grant execute on function ${FN_SIG} to service_role`);
    expect(st[5]).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('218', '218_alias_sibling_code_wins') on conflict do nothing",
    );
    expect(st[6]).toBe("commit");
  });

  it("runs in exactly one begin/commit and the ledger insert is the last statement before commit", () => {
    need218();
    const code = stripComments(sql218.slice(sql218.indexOf("\nbegin;")));
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.lastIndexOf("grant execute on function"));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
  });

  it("sits after 217, the migration whose body it starts from, and nothing between 217 and 218 redefines the resolver", () => {
    expect(FILE_217 < FILE_218).toBe(true);
    const redefiners = readdirSync(MIGRATIONS_DIR)
      .filter((n) => /^\d{3}_/.test(n) && n.endsWith(".sql") && n > FILE_217 && n <= FILE_218)
      .filter((n) =>
        collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"))).includes(`create or replace function ${FN}(`),
      );
    expect(redefiners, "217's body is still production's").toEqual([FILE_218]);
  });
});

describe("218 alias_sibling_code_wins: the body it was built from", () => {
  it("217's function body is the pinned text: md5 and length, recomputed from 217's file (production's resolver, read-only, 2026-11-22)", () => {
    expect(md5(body217)).toBe(BODY_217_MD5);
    expect([...body217].length).toBe(BODY_217_LENGTH);
  });

  it("the header records production's fingerprint (217's body), the attributes and the ACL", () => {
    const h = flat(head218());
    expect(h).toContain("STEP 0");
    expect(h).toContain(`md5 ${BODY_217_MD5}`);
    expect(h).toContain(`length ${BODY_217_LENGTH}`);
    expect(h).toContain("pg_get_functiondef");
    expect(h).toContain("{postgres=X/postgres,service_role=X/postgres}");
    expect(h).toContain("prosecdef f");
    expect(h).toContain("equals the md5 of 217's body");
  });
});

describe("218 alias_sibling_code_wins: derive-and-compare against 217", () => {
  it("rule D (edit 2) occurs exactly once and is the last predicate of alias_hits' WHERE, after rule C and before code_hits is read by hits", () => {
    const b = resolver218();
    expect(countOf(b, EDIT_D)).toBe(1);
    expect(countOf(body217, "bist_aliases s")).toBe(0);
    expect(countOf(b, "bist_aliases s")).toBe(1);
    const hits = seg(b, "  alias_hits as (", "  hits as (");
    expect(hits).toContain(`${RULE_C_LINE}${EDIT_D}\n  ),\n`);
    // only the auto rows are ever dropped, and only by a code of ANOTHER ticker that shares the alias
    expect(EDIT_D).toContain("and not (al.origin = 'auto' and exists (");
    expect(EDIT_D).toContain("s.alias = al.alias and s.enabled and s.ticker = ch.ticker");
    expect(EDIT_D).toContain("ch.article_id = al.article_id and ch.ticker <> al.ticker");
  });

  it("edit 1: code_hits sits between ctx and alias_matches, its text unchanged, and the alias_matches comment still sits on alias_matches", () => {
    const b = resolver218();
    expect(countOf(b, "  code_hits as (")).toBe(1);
    expect(pos(b, "  ctx as (")).toBeLessThan(pos(b, "  code_hits as ("));
    expect(pos(b, "  code_hits as (")).toBeLessThan(pos(b, "  alias_matches as materialized ("));
    expect(pos(b, "  alias_matches as materialized (")).toBeLessThan(pos(b, "  alias_hits as ("));
    expect(pos(b, "  alias_hits as (")).toBeLessThan(pos(b, "  hits as ("));
    const block = cteBlock(b, "code_hits");
    expect(block).toBe(cteBlock(body217, "code_hits"));
    expect(b).toContain(`    from recent r\n  ),\n${block}  -- 085's alias_hits join, VERBATIM`);
    // a CTE can only read an earlier one: the new predicate reads code_hits, which is defined before alias_hits
    expect(countOf(b, "code_hits")).toBe(countOf(body217, "code_hits") + 1);
  });

  it("undoing edit 2 and moving code_hits back gives 217's body, byte for byte", () => {
    expect(derive(resolver218())).toBe(body217);
  });

  it("the derivation notices a change anywhere else: an edit outside the two breaks the equality", () => {
    const b = resolver218();
    const tampered = b.replace("on conflict do nothing", "on conflict do nothing /* x */");
    expect(tampered).not.toBe(b);
    expect(derive(tampered)).not.toBe(body217);
    expect(derive(b.replace(" (holding|hisse", " (holding|bank|hisse"))).not.toBe(body217);
    expect(derive(b.replace("not public.is_retail_catalog(a.title)", "true"))).not.toBe(body217);
    expect(derive(b.replace("al.origin = 'auto' and exists (select 1 from code_hits", "al.origin = 'manual' and exists (select 1 from code_hits"))).not.toBe(body217);
    // a body that still carries one of the two edits is not 217's
    expect(b.replace(EDIT_D, "")).not.toBe(body217);
    const block = cteBlock(b, "code_hits");
    expect(b.replace(block, "").replace("  hits as (", `${block}  hits as (`)).not.toBe(body217);
  });

  it("rules A, B and C, alias_matches, ctx, recent, code_hits, hits and the insert are 217's, unchanged", () => {
    const b = resolver218();
    const rulesAtoC = (x: string): string => seg(x, "    -- (A) manual sibling wins", "\n  ),\n");
    expect(rulesAtoC(b)).toBe(rulesAtoC(body217) + EDIT_D);
    expect(seg(b, "    -- (A) manual sibling wins", "\n      and not exists (select 1 from public.bist_alias_blocks")).toBe(
      seg(body217, "    -- (A) manual sibling wins", "\n      and not exists (select 1 from public.bist_alias_blocks"),
    );
    expect(b).toContain(RULE_C_LINE);
    expect(countOf(b, "bist_alias_blocks")).toBe(1);
    expect(seg(b, "  -- 085's alias_hits join, VERBATIM", "  alias_hits as (")).toBe(seg(body217, "  -- 085's alias_hits join, VERBATIM", "  alias_hits as ("));
    expect(seg(b, "with recent as (", "  code_hits as (")).toBe(seg(body217, "with recent as (", "  -- 085's alias_hits join, VERBATIM"));
    expect(b.slice(b.indexOf("  hits as ("))).toBe(body217.slice(body217.indexOf("  hits as (")));
    expect(b).toContain("and not public.is_retail_catalog(a.title)");
    expect(b).toContain("where c.ticker <> all (public.ticker_code_stoplist())");
    expect(b).toContain("alias_matches as materialized (");
    expect(countOf(b, "alias_matches as materialized (")).toBe(1);
  });

  it("rule D reads code_hits' own columns (article_id, ticker) and never an alias_matches join, so alias_matches stays the materialized text match", () => {
    const b = resolver218();
    const matches = seg(b, "  alias_matches as materialized (", "  alias_hits as (");
    expect(matches).not.toContain("not exists");
    expect(matches).not.toContain("code_hits");
    expect(matches).not.toContain("bist_alias_blocks");
  });

  it("every relation and function in the body is schema-qualified (search_path is empty), the new subquery included", () => {
    const code = stripComments(resolver218());
    const rels = [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string);
    for (const rel of rels) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^(public\.|pg_catalog\.|recent$|ctx$|alias_matches$|alias_hits$|code_hits$|hits$|lateral$)/);
    }
    expect(countOf(collapse(code), "join public.bist_aliases s on s.alias = al.alias")).toBe(1);
  });
});

describe("218 alias_sibling_code_wins: the resolver keeps 217's signature, security mode, search_path and grants", () => {
  const hdr = (sql: string): string => {
    const code = codeOf(sql);
    const at = code.indexOf(RESOLVER_MARKER);
    return collapse(code.slice(at, code.indexOf("$$", at) + 2));
  };

  it("is security invoker, volatile, an empty search_path, the same header as 217", () => {
    need218();
    expect(hdr(sql218)).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as $$",
    );
    expect(hdr(sql218)).toBe(hdr(sql217));
    expect(hdr(sql218)).not.toMatch(/security\s+definer/i);
  });

  it("revokes from public, anon and authenticated and grants execute to service_role only, once each", () => {
    need218();
    const code = stripComments(codeOf(sql218));
    expect(countOf(code, `revoke all on function ${FN_SIG} from public, anon, authenticated;`)).toBe(1);
    expect(countOf(code, `grant execute on function ${FN_SIG} to service_role;`)).toBe(1);
    expect(code).not.toMatch(/grant[^;]*function[^;]*\sto\s+[^;]*\b(anon|authenticated|public)\b/i);
  });
});

describe("218 alias_sibling_code_wins: additive, nothing existing is written", () => {
  it("has no delete, update, truncate, drop, copy, alter, no table, index, trigger, view or cron, no backfill call", () => {
    need218();
    const code = stripComments(codeOf(sql218));
    for (const re of [
      /\bdelete\s+from\b/i,
      /\bupdate\s+(public\.|set\b)/i,
      /\btruncate\b/i,
      /\bdrop\s+/i,
      /\bcopy\b/i,
      /\balter\s+/i,
      /\bcreate\s+(table|index|unique|trigger|extension|view|policy|schema)\b/i,
      /cron\.schedule/i,
    ]) {
      expect(code, String(re)).not.toMatch(re);
    }
    expect(countOf(collapse(code), "create or replace function")).toBe(1);
    // no top-level re-resolve: the resolver is only defined, never called, outside its own definition
    const st = stmts218();
    expect(st.filter((s) => /^select\b/i.test(s))).toEqual([]);
    expect(st.filter((s) => s.toLowerCase().includes("public.article_tickers"))).toEqual([]);
  });

  it("the only writes are the resolver's own insert into article_tickers and the ledger row (no seed row, no alias row, no block row)", () => {
    need218();
    const code = stripComments(codeOf(sql218));
    const inserts = [...code.matchAll(/insert\s+into\s+([a-z_][\w.]*)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["public.article_tickers", "supabase_migrations.schema_migrations"]);
    for (const s of stmts218().filter((x) => /^insert\b/i.test(x))) expect(s.endsWith("on conflict do nothing"), s).toBe(true);
  });

  it("does not touch bist_companies, bist_aliases, bist_alias_blocks, the stoplist, the finance regex or any helper function", () => {
    need218();
    const code = collapse(stripComments(codeOf(sql218)));
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.(bist_companies|bist_aliases|bist_alias_blocks)/i);
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.(ticker_code_stoplist|finance_context_regex|fold_tr|is_retail_catalog)/i);
    expect(code).not.toContain("enabled = false");
  });
});

describe("218 alias_sibling_code_wins: the header", () => {
  it("names the evidence: BSOKE and BTCIM, the shared auto alias, the SPK article, the OYAK and ANEL siblings, the Jev blind spot", () => {
    const h = flat(head218());
    expect(head218().startsWith("-- 218_alias_sibling_code_wins.sql")).toBe(true);
    for (const word of [
      "h207-ekonomi-1",
      "BSOKE",
      "BTCIM",
      "baticim",
      "832feda9",
      "SPK'dan BTCIM hisselerine işlem yasağı",
      "tavan",
      "ilgi 8,8x",
      "OYAKC",
      "OYAYO",
      "OYYAT",
      "ANELE",
      "ANELT",
      "Jev",
      "bucket C",
      "alias_matches",
      "alias_hits",
      "code_hits",
      "171",
      "217",
    ]) {
      expect(h, word).toContain(word);
    }
  });

  it("states rule D, the two edits, the predicate itself and that 217's body minus them is byte for byte", () => {
    const h = flat(head218());
    expect(h).toContain("THE RULE");
    expect(h).toContain("(D)");
    expect(h).toContain("a sibling named by its code wins");
    expect(h).toContain("exactly two edits");
    expect(h).toContain(collapse(EDIT_D.replace(/^\n\s*/, "")));
    expect(h).toContain("byte for byte");
    // the move: a CTE can only read an earlier one
    expect(h).toContain("between `ctx` and `alias_matches`");
    expect(h).toContain("A CTE can only reference earlier ones");
    // a manual row is never dropped, a text that writes Y's own code still attaches Y
    expect(h).toContain("never drops a manual row");
    expect(h).toContain("Y still attaches when the text writes Y's own code");
  });

  it("records the NUMBER: 218 is free, 197 and 202 are held on branches", () => {
    const h = flat(head218());
    expect(h).toContain("NUMBER");
    expect(h).toContain("218");
    expect(h).toContain("197");
    expect(h).toContain("202");
    expect(h).toContain("held");
  });

  it("documents the known limit: a text that says only 'Batıçim', with no code, still attaches both siblings (bucket C, owner follow-up (b))", () => {
    const h = flat(head218());
    expect(h).toContain("KNOWN LIMIT");
    expect(h).toContain("a text that says only 'Batıçim' with no code still attaches both siblings");
    expect(h).toContain("bucket C");
    expect(h).toContain("(b)");
  });

  it("records the read-only replay: the window, the validation against storage, the pair counts, the per-ticker removals and the ANELT deviation", () => {
    const h = flat(head218());
    const replay = between(h, "REPLAY (read-only", "COST (");
    for (const fact of [
      "2026-11-22",
      "last 30 days",
      "2026-10-23 12:45Z",
      "2026-11-22 12:45Z",
      "ten 3-day slices",
      "full-joined on (article_id, ticker)",
      "192 pairs",
      "192 of 192",
      "5,139 under 217",
      "5,121 under 218",
      "18 removed, 0 added",
      "no other ticker changes",
      "BSOKE 15 removed",
      "in the last 3 days 21 to 6",
      "OYA 1, OYAYO 1 and OYYAT 1 removed",
      "ANELT 0",
      "the ANELT row is not reproduced",
      "rule B already drops its alias row",
      "832feda9",
      "Every removed match was read",
    ]) {
      expect(replay, fact).toContain(fact);
    }
  });

  it("COST: the 50 ms budget for both articles, why it matters (058 per-row, authenticator's 8 s statement_timeout) and the production wall clock of the two inlined SELECTs", () => {
    const h = flat(head218());
    const cost = between(h, "COST (", "FOUNDER-ONLY follow-ups");
    for (const fact of ["2,000", "best of 3", "50 ms", "where D fires", "058", "per inserted row", "8 s statement_timeout", "57014", "9.9 s and 8.2 s", "8.2 s and 8.8 s", "469 and 454 pairs"]) {
      expect(cost, fact).toContain(fact);
    }
  });

  it("is additive and founder-applied: no update or delete of article_tickers, the existing BSOKE rows stay, the PR applies nothing", () => {
    const h = flat(head218());
    expect(h).toContain("Additive only");
    expect(h).toContain("no update or delete of article_tickers");
    expect(h).toContain("25 existing BSOKE rows");
    expect(h).toContain("the founder applies 218");
    expect(h).toContain("FOUNDER-ONLY");
    expect(sql218.slice(sql218.indexOf("\nbegin;")).toLowerCase()).not.toContain("delete from");
  });

  it("ORDER: apply 218 only, 217 must already be applied, no deploy-order constraint, no Next.js change", () => {
    const h = flat(head218());
    expect(h).toContain("ORDER");
    expect(h).toContain("APPLY 218 ONLY");
    expect(h).toMatch(/no Next\.js change/);
    expect(h).toContain("217 must already be applied");
  });

  it("VERIFY carries the new md5 and length, the privileges, the ledger row and the post-apply check on the next BTCIM story", () => {
    const h = flat(head218());
    const verify = h.slice(h.indexOf("VERIFY"));
    expect(verify).toContain(md5(resolver218()));
    expect(verify).toContain(`${[...resolver218()].length}`);
    expect(verify).toContain("has_function_privilege");
    expect(verify).toContain("version = '218'");
    expect(verify).toContain("select ticker, matched_on from article_tickers where article_id = <new id>");
  });

  it("ROLLBACK re-creates 217's resolver and removes only the 218 ledger row", () => {
    const h = flat(head218());
    const rb = h.slice(h.indexOf("ROLLBACK"));
    expect(rb).toContain("217_alias_blockers.sql");
    expect(rb).toContain(BODY_217_MD5);
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '218'");
    // the file itself never spells out a delete or a drop (the header is prose)
    expect(stripComments(codeOf(sql218))).not.toMatch(/delete\s+from|drop\s+/i);
  });
});

describe("218 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_GUIDE, "utf8");
  const section = guide.includes("\n## 218 ") ? sectionOf(guide, "218") : "";

  it("sits directly after section 217 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 218 ")).toBeGreaterThan(guide.indexOf("\n## 217 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 217 ") + 1)).toBe(guide.indexOf("\n## 218 "));
  });

  it("has Why, What, an md5 table, Replay, Order, Verify, a founder-only follow-up and Rollback", () => {
    for (const word of ["**Why:**", "**What 218 does**", "| md5(prosrc) | length |", "**Replay**", "**Order:**", "**Verify**", "**FOUNDER-ONLY", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    expect(section).toContain(BODY_217_MD5);
    expect(section).toContain(String(BODY_217_LENGTH));
    expect(section).toContain(md5(resolver218()));
    expect(section).toContain(String([...resolver218()].length));
  });

  it("states the evidence, rule D, the two edits and the known limit", () => {
    for (const word of [
      "h207-ekonomi-1",
      "BSOKE",
      "BTCIM",
      "baticim",
      "rule D",
      "code_hits",
      "alias_hits",
      "alias_matches",
      "bucket C",
      "a sibling named by its code wins",
      "byte for byte",
      "a text that says only 'Batıçim' with no code still attaches both siblings",
      "no update or delete",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("says the founder applies 218 and the PR applies nothing; nothing was applied or called on production", () => {
    const order = between(section, "**Order:**", "**Verify**");
    expect(order).toContain("APPLY `218_alias_sibling_code_wins.sql` ONLY");
    expect(order).toContain("the founder applies it");
    expect(order).toContain("the PR applies nothing");
    expect(order).toContain("217 must already be applied");
    expect(order).toMatch(/no Next\.js change/);
  });

  it("verifies the fingerprint, the privileges, the ledger and the live effect on the next BTCIM story", () => {
    for (const word of [
      "md5(prosrc)",
      "has_function_privilege",
      "schema_migrations",
      "version = '218'",
      "resolve_article_tickers_for",
      "select ticker, matched_on from article_tickers where article_id = <new id>",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs 217's function and removes the 218 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("217_alias_blockers.sql");
    expect(rb).toContain(BODY_217_MD5);
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '218'");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("218 docs/architecture.md", () => {
  const arch = readFileSync(DOC_ARCH, "utf8");
  const row = arch.split("\n").find((l) => l.startsWith("| Ticker resolve |")) ?? "";

  it("the Ticker resolve row lists rules A, B, C and D, rule D being the sibling named by its code, migration 218", () => {
    expect(row).not.toBe("");
    for (const word of ["rule A", "rule B", "rule C", "rule D", "manual sibling wins", "bist_alias_blocks", "171", "217", "218", "code_hits", "BSOKE", "BTCIM"]) {
      expect(row, word).toContain(word);
    }
    expect(row).toContain("a sibling named by its code wins");
    expect(row).not.toContain("three rules");
  });

  it("keeps the row a single table row and the earlier text of the row", () => {
    expect(row.endsWith("|")).toBe(true);
    expect(row).toContain("Postgres trigger `articles_resolve_tickers` (AFTER INSERT)");
    expect(row).toContain("Migration 051 (was a 10-min cron in 049).");
    expect(row).toContain("rule C, a blocked phrase (migration 217)");
    expect(countOf(arch, "| Ticker resolve |")).toBe(1);
  });
});

describe("218 dry-run script (the live PG15 behaviour; run-live.sh Phase A picks it up, no live-manifest entry needed)", () => {
  const sql = existsSync(DRYRUN) ? readFileSync(DRYRUN, "utf8") : "";

  it("exists under the *-dryrun.sql name run-live.sh globs", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    expect(DRYRUN.endsWith("-dryrun.sql")).toBe(true);
  });

  it("builds 217's state (085, 171, 177, 178, 217) by running 217's dry-run, then applies 218 TWICE, in that order", () => {
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "217-alias-blockers-dryrun.sql",
      "../../../supabase/migrations/218_alias_sibling_code_wins.sql",
      "../../../supabase/migrations/218_alias_sibling_code_wins.sql",
    ]);
  });

  it("gates the baseline on 217's production md5 and length and shows the defect on 217's body", () => {
    expect(sql).toContain(BODY_217_MD5);
    expect(sql).toContain(String(BODY_217_LENGTH));
    expect(sql).toContain("baseline: 217 attaches BSOKE to a story that writes BTCIM by its code");
    expect(sql).toContain(md5(resolver218()));
  });

  it("runs the six scenarios of the spec, each inside begin ... rollback", () => {
    for (const label of [
      "S1 a story writing BTCIM gives BTCIM only",
      "S2 a text with no code keeps both siblings",
      "S3 both codes written give both",
      "S4 a manual row is never dropped",
      "S5 a sibling code that fails the code gate does not trigger D",
      "S6 OYAKC written next to Oyak gives OYAKC only",
      // beyond the spec's six: the sibling row must be enabled, and only a code that shares the alias triggers D
      "S7 a disabled sibling alias row does not trigger D",
      "S8 a code that does not share the alias does not trigger D",
    ]) {
      expect(sql, label).toContain(label);
    }
    expect(countOf(sql, "\nbegin;\n")).toBeGreaterThanOrEqual(6);
    expect(countOf(sql, "\nrollback;\n")).toBeGreaterThanOrEqual(6);
  });

  it("checks idempotence (one body, one ledger row) and the 171 time budget for a non-matching article and an article where D fires", () => {
    expect(sql).toContain("idempotent");
    expect(sql).toContain("version = '218'");
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain("generate_series(1, 1000)");
    expect(sql).toContain("generate_series(1, 2000)");
    expect(sql).toContain("if v_ms > 50 then");
    expect(sql).toContain("TIME BUDGET");
    expect(sql).toContain("an article where D fires");
  });

  it("ends with its OK line and carries the harness header: tracked stub, a mktemp data dir, the runner line", () => {
    expect(sql.trimEnd().endsWith("select 'DRYRUN 218 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("TAYF_LIVE_ONLY=218");
  });

  it("holds the read-only replay as comments and no executable delete or update", () => {
    const lines = sql.split("\n");
    expect(sql).toContain("READ-ONLY REPLAY");
    expect(sql).toContain("full join");
    const exec = lines.filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
    expect(exec).not.toContain("delete from");
    expect(exec).not.toContain("update public.");
  });
});
