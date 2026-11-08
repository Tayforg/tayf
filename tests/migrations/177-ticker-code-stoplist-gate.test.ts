import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr } from "../../supabase/functions/_shared/kap.ts";
import { expectCpuUnder } from "../_helpers/linear-time";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 177 ("ticker_code_stoplist_gate"), h72-kap-2 (hunt 72).
//
// 085 stoplisted four company codes that are also ordinary words (DEVA, BEYAZ, ATLAS, KONYA): a bare mention in the text does not
// attach them, only "(DEVA)" does. 085 (and 171 after it) then let the stoplist be voided for every article filed under
// category 'ekonomi': code_hits' WHERE read `... or r.category = 'ekonomi' or strpos(raw, '(CODE)') > 0`. The fon-krizi
// coverage of Ali Babacan (leader of the DEVA PARTİSİ) is filed under ekonomi, so exactly the stories the stoplist was meant to
// stop attached DEVA: over 45 days 43 article_tickers rows ticker = 'DEVA' (all matched_on 'code', all category 'ekonomi'), 40 of
// them Babacan / DEVA Partisi items, none naming "(DEVA)" or "Deva Holding"; 17 of them scored 0.20 to 0.46 by Jev, which is
// shown in the Haberler list and the /ekonomi feed (only below 0.2 is hidden).
//
// 177 re-creates public.resolve_article_tickers_for with 171's body VERBATIM except for code_hits' WHERE: the bare category
// branch is dropped and a stoplisted code needs "(CODE)" or a company cue right after it ("deva holding", "deva hisseleri",
// "deva bilancosu", ...). A non-stoplisted ticker passes the first disjunct, unchanged.
//
// This file pins: the file, the ledger row and the transaction; that 171's body is what production runs (md5 recorded
// 2026-11-08) and that nothing between 171 and 177 redefines the resolver; derive-and-compare (substituting 171's WHERE back
// into 177's body gives 171's body byte for byte); the rest of the body untouched (alias_matches / alias_hits and the
// stoplist function); a JS mirror of the WHERE over the spec's table; that the migration writes nothing; the header; and, with
// TAYF_PSQL, the real function against fixtures.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_171 = "171_ticker_alias_siblings.sql";
const FILE_177 = "177_ticker_code_stoplist_gate.sql";
const MIGRATION_171 = resolve(MIGRATIONS_DIR, FILE_171);
const MIGRATION_177 = resolve(MIGRATIONS_DIR, FILE_177);
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "177-ticker-code-stoplist-gate-dryrun.sql");

/** md5(prosrc) and length(prosrc) of public.resolve_article_tickers_for on production, read-only, 2026-11-08: 171's body. */
const PROD_MD5 = "999a286fb58e46bf1958b78dfedcad98";
const PROD_LENGTH = 3401;

const FN = "public.resolve_article_tickers_for";
const FN_SIG = `${FN}(uuid[])`;

/** 171's code_hits WHERE, byte for byte (the three disjuncts, the middle one being the bare category branch). */
const OLD_WHERE = [
  "    where c.ticker <> all (public.ticker_code_stoplist())",
  "       or r.category = 'ekonomi'",
  "       or pg_catalog.strpos(r.raw, '(' || c.ticker || ')') > 0",
].join("\n");

/** 177's code_hits WHERE: the category branch is gone and a company cue after the folded code joins the explicit "(CODE)". */
const NEW_WHERE = [
  "    where c.ticker <> all (public.ticker_code_stoplist())",
  "       or pg_catalog.strpos(r.raw, '(' || c.ticker || ')') > 0",
  "       or r.folded ~ (' ' || pg_catalog.lower(c.ticker) || ' (holding|hisse|hissesi|hisseleri|pay|paylari|bilanco)')",
].join("\n");

const CUE_ALTERNATION = "(holding|hisse|hissesi|hisseleri|pay|paylari|bilanco)";

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

/** The text between the first two `$$` markers at or after `from`: Postgres' prosrc. */
function dollarBody(sql: string, from: number): string {
  const open = sql.indexOf("$$", from);
  const close = sql.indexOf("$$", open + 2);
  expect(open, "an opening dollar quote").toBeGreaterThanOrEqual(0);
  expect(close, "a closing dollar quote").toBeGreaterThan(open);
  return sql.slice(open + 2, close);
}

/** The executable part of a migration: from the `begin;` line on, so header prose never counts as code. */
function codeOf(sql: string): string {
  const at = sql.indexOf("\nbegin;");
  expect(at, "a begin; statement").toBeGreaterThanOrEqual(0);
  return sql.slice(at);
}

function resolverBody(sql: string): string {
  const code = codeOf(sql);
  const at = code.indexOf(`create or replace function ${FN}(p_ids uuid[])`);
  expect(at, `${FN} in the file`).toBeGreaterThanOrEqual(0);
  return dollarBody(code, at);
}

function resolverHeader(sql: string): string {
  const code = codeOf(sql);
  const at = code.indexOf(`create or replace function ${FN}(p_ids uuid[])`);
  const open = code.indexOf("$$", at);
  return code.slice(at, open + 2);
}

/** The top-level statements of the executable part, comments gone, the function body replaced by BODY. */
function statementsOf(sql: string): string[] {
  const code = codeOf(sql);
  const at = code.indexOf(`create or replace function ${FN}(p_ids uuid[])`);
  const open = code.indexOf("$$", at);
  const close = code.indexOf("$$", open + 2);
  const shell = code.slice(0, open + 2) + "BODY" + code.slice(close);
  return stripComments(shell)
    .split(";")
    .map((s) => collapse(s))
    .filter((s) => s.length > 0);
}

const sql171 = readFileSync(MIGRATION_171, "utf8");
const body171 = resolverBody(sql171);
const sql177 = existsSync(MIGRATION_177) ? readFileSync(MIGRATION_177, "utf8") : "";
const head177 = (): string => sql177.slice(0, sql177.indexOf("\nbegin;"));
const body177 = (): string => resolverBody(sql177);

// ---------------------------------------------------------------------------

describe("177 ticker_code_stoplist_gate: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 177", () => {
    expect(existsSync(MIGRATION_177), FILE_177).toBe(true);
    const claims = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("177_"));
    expect(claims).toEqual([FILE_177]);
  });

  it("holds only the transaction frame, the timeout, one function, its privileges and the ledger row, in that order", () => {
    const st = statementsOf(sql177);
    expect(st).toHaveLength(7);
    expect(st[0]).toBe("begin");
    expect(st[1]).toBe("set local lock_timeout = '5s'");
    expect(st[2]).toMatch(
      /^create or replace function public\.resolve_article_tickers_for\(p_ids uuid\[\]\) returns integer language plpgsql set search_path = '' as \$\$BODY\$\$$/,
    );
    expect(st[3]).toBe(`revoke all on function ${FN_SIG} from public, anon, authenticated`);
    expect(st[4]).toBe(`grant execute on function ${FN_SIG} to service_role`);
    expect(st[5]).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('177', '177_ticker_code_stoplist_gate') on conflict do nothing",
    );
    expect(st[6]).toBe("commit");
  });

  it("runs in exactly one begin/commit and the ledger insert is the last statement before commit", () => {
    const code = stripComments(codeOf(sql177));
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.search(/grant\s+execute\s+on\s+function/i));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
  });

  it("sits after 176 and no migration between 171 and 177 redefines the resolver, so 171's body is the live one", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, "176_public_status_cluster_queue.sql"))).toBe(true);
    const between = readdirSync(MIGRATIONS_DIR)
      .filter((n) => /^\d{3}_/.test(n))
      .filter((n) => Number(n.slice(0, 3)) > 171 && Number(n.slice(0, 3)) < 177);
    expect(between.length).toBeGreaterThanOrEqual(5);
    const redefiners = between.filter((n) =>
      /create\s+(or\s+replace\s+)?function\s+public\.resolve_article_tickers_for/i.test(
        readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"),
      ),
    );
    expect(redefiners).toEqual([]);
  });
});

describe("177 ticker_code_stoplist_gate: the production fingerprint it was built from", () => {
  it("171's function body is production's: md5 and length of the recorded prosrc (STEP 0, read-only, 2026-11-08)", () => {
    expect(md5(body171)).toBe(PROD_MD5);
    expect([...body171].length).toBe(PROD_LENGTH);
  });

  it("the header records that fingerprint and that it equals 171's body", () => {
    const h = flat(head177());
    expect(h).toContain(`md5 ${PROD_MD5}`);
    expect(h).toContain(`length ${PROD_LENGTH}`);
    expect(h).toMatch(/equals the md5 of 171's body/);
    expect(h).toContain("pg_get_functiondef");
    expect(h).toContain("{postgres=X/postgres,service_role=X/postgres}");
  });
});

describe("177 ticker_code_stoplist_gate: derive-and-compare against 171", () => {
  it("171's code_hits WHERE is the text this test starts from, and it occurs once in 171's body", () => {
    expect(countOf(body171, OLD_WHERE)).toBe(1);
    expect(body171).toContain("or r.category = 'ekonomi'");
    expect(countOf(body171, "r.category = 'ekonomi'")).toBe(2); // ctx's fin_ctx and code_hits' WHERE
  });

  it("the new WHERE occurs exactly once in 177's body and the bare category branch is gone from code_hits", () => {
    expect(countOf(body177(), NEW_WHERE)).toBe(1);
    expect(countOf(body177(), OLD_WHERE)).toBe(0);
    // the one remaining "category = 'ekonomi'" is ctx's finance-context test, untouched
    expect(countOf(body177(), "r.category = 'ekonomi'")).toBe(1);
    expect(body177()).toContain("(r.category = 'ekonomi' or r.folded ~ public.finance_context_regex()) as fin_ctx");
  });

  it("substituting 171's WHERE back for the new one gives 171's body, byte for byte", () => {
    expect(body177().replace(NEW_WHERE, OLD_WHERE)).toBe(body171);
  });

  it("the substitution notices a change anywhere else: an edit outside the WHERE breaks the equality", () => {
    const tampered = body177().replace("on conflict do nothing", "on conflict do nothing /* x */");
    expect(tampered).not.toBe(body177());
    expect(tampered.replace(NEW_WHERE, OLD_WHERE)).not.toBe(body171);
    const widened = body177().replace(" (holding|hisse", " (holding|bank|hisse");
    expect(widened.replace(NEW_WHERE, OLD_WHERE)).not.toBe(body171);
  });

  it("alias_matches and alias_hits are 171's, unchanged: the alias path is not touched", () => {
    const seg = (b: string): string => {
      const from = b.indexOf("alias_matches as materialized (");
      const to = b.indexOf("code_hits as (");
      expect(from).toBeGreaterThan(0);
      expect(to).toBeGreaterThan(from);
      return b.slice(from, to);
    };
    expect(seg(body177())).toBe(seg(body171));
    expect(seg(body177())).toContain("(A) manual sibling wins");
    expect(seg(body177())).toContain("(B) an untraded affiliate never attaches");
  });

  it("recent, ctx and the hits/insert tail are 171's: the fin_ctx gate and the insert are not touched", () => {
    const head = (b: string): string => b.slice(0, b.indexOf("alias_matches as materialized ("));
    const tail = (b: string): string => b.slice(b.indexOf("  hits as ("));
    expect(head(body177())).toBe(head(body171));
    expect(tail(body177())).toBe(tail(body171));
  });

  it("the new WHERE keeps the code path's own text: the join, the 4-6 letter regex and the traded-company filter", () => {
    const b = body177();
    expect(b).toContain("pg_catalog.regexp_matches(r.raw, '\\m([A-Z]{4,6})\\M', 'g')");
    expect(b).toContain("select pg_catalog.unnest(tickers) as ticker from public.bist_companies where shares_traded");
    expect(b).toContain("select distinct r.id as article_id, c.ticker, 'code' as matched_on");
  });

  it("the cue regex is applied to r.folded, which 171 builds with fold_tr: lower case, ASCII, one space around words", () => {
    expect(body177()).toContain(
      "' ' || public.fold_tr(a.title || ' ' || coalesce(a.description, '')) || ' ' as folded",
    );
    // fold_tr of 049 (translate to ASCII, lower, runs of non a-z0-9 to one space): every cue word is already in that form
    for (const w of CUE_ALTERNATION.slice(1, -1).split("|")) expect(w).toMatch(/^[a-z]+$/);
  });
});

describe("177 ticker_code_stoplist_gate: the function keeps 171's signature, security mode, search_path and grants", () => {
  it("is security invoker as in 171, volatile, with an empty search_path", () => {
    const hdr = collapse(resolverHeader(sql177));
    expect(hdr).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as $$",
    );
    expect(hdr).not.toMatch(/security\s+definer/i);
    expect(hdr).not.toMatch(/\b(immutable|stable)\b/i);
    expect(collapse(resolverHeader(sql177))).toBe(collapse(resolverHeader(sql171)));
  });

  it("re-issues the revoke and grant: revoke from public, anon and authenticated, execute to service_role only", () => {
    const code = stripComments(codeOf(sql177));
    expect(countOf(code, `revoke all on function ${FN_SIG} from public, anon, authenticated;`)).toBe(1);
    expect(countOf(code, `grant execute on function ${FN_SIG} to service_role;`)).toBe(1);
    expect(code).not.toMatch(/grant[^;]*\sto\s+[^;]*\b(anon|authenticated|public)\b/i);
  });

  it("every relation and function in the new WHERE is schema-qualified (search_path is empty)", () => {
    expect(NEW_WHERE).toContain("public.ticker_code_stoplist()");
    expect(NEW_WHERE).toContain("pg_catalog.strpos(");
    expect(NEW_WHERE).toContain("pg_catalog.lower(");
    expect(NEW_WHERE).not.toMatch(/(^|[^.\w])(strpos|lower|upper)\(/);
  });
});

describe("177 ticker_code_stoplist_gate: additive, nothing is written by the migration", () => {
  it("has no delete, update, truncate, alter, drop, copy, create table or index, and no backfill", () => {
    const code = stripComments(codeOf(sql177));
    for (const re of [
      /\bdelete\s+from\b/i,
      /\bupdate\s+public\./i,
      /\btruncate\b/i,
      /\balter\s+(table|function|index)\b/i,
      /\bdrop\s+/i,
      /\bcopy\b/i,
      /\bcreate\s+(table|index|trigger|extension)\b/i,
      /cron\.schedule/i,
    ]) {
      expect(code, String(re)).not.toMatch(re);
    }
  });

  it("the only write besides the ledger is the function's own insert into article_tickers, as in 171", () => {
    const code = stripComments(codeOf(sql177));
    expect(countOf(code, "insert into public.article_tickers")).toBe(1);
    expect(countOf(code, "insert into supabase_migrations.schema_migrations")).toBe(1);
    expect([...code.matchAll(/\binsert\s+into\b/gi)]).toHaveLength(2);
  });

  it("does not redefine the stoplist or touch the bist tables", () => {
    const code = stripComments(codeOf(sql177));
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.ticker_code_stoplist/i);
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.bist_/i);
    expect(code).not.toMatch(/disable|enabled\s*=/i);
  });
});

describe("177 ticker_code_stoplist_gate: the header", () => {
  it("names the evidence: 43 DEVA rows, 40 Babacan items, none naming (DEVA), the Jev scores, and the voided stoplist", () => {
    const h = flat(head177());
    expect(h).toContain("43 rows");
    expect(h).toContain("40 are Babacan");
    expect(h).toContain("Ali Babacan");
    expect(h).toContain("DEVA Partisi");
    expect(h).toContain("'(DEVA)'");
    expect(h).toContain("category = 'ekonomi'");
    expect(h).toContain("0.2");
    expect(h).toContain("0.46");
    expect(h).toContain("DEVA, BEYAZ, ATLAS, KONYA");
  });

  it("states the rule and the one deviation from the spec's text (none) or records it", () => {
    const h = flat(head177());
    expect(h).toContain("(holding|hisse|hissesi|hisseleri|pay|paylari|bilanco)");
    expect(h).toContain("THE RULE");
    expect(h).toContain("Non-stoplisted tickers are unaffected");
    expect(h).toContain("Turkish suffixes");
    expect(h).toContain("no trailing word boundary");
  });

  it("records the read-only replay: the 45-day DEVA rows (43 to 0), the 30-day counts per stoplisted ticker", () => {
    const h = flat(head177());
    expect(h).toContain("REPLAY");
    expect(h).toContain("DEVA 43 of 43");
    expect(h).toContain("0 survive");
    expect(h).toMatch(/DEVA 33/);
    expect(h).toMatch(/BEYAZ 3/);
    expect(h).toMatch(/ATLAS 2/);
    expect(h).toMatch(/KONYA 2/);
    expect(h).toContain("40 of 364");
  });

  it("carries the optional FOUNDER-ONLY cleanup of the existing DEVA rows and the out-of-scope SMART / KENT / HEDEF", () => {
    const h = flat(head177());
    expect(h).toContain("FOUNDER-ONLY");
    expect(h).toContain("existing DEVA code rows");
    expect(h).toContain("early December");
    expect(h).toContain("SMART");
    expect(h).toContain("KENT");
    expect(h).toContain("HEDEF");
  });

  it("VERIFY carries the md5 and the length of THIS file's function body", () => {
    const h = flat(head177());
    const b = body177();
    expect(h).toContain("VERIFY");
    expect(h).toContain(md5(b));
    expect(h).toContain(`${[...b].length}`);
    expect(h).toContain("has_function_privilege");
    expect(h).toContain("version = '177'");
  });

  it("ROLLBACK re-runs 171's function statement and removes only the 177 ledger row (the file never spells a delete)", () => {
    const h = flat(head177());
    const rb = h.slice(h.indexOf("ROLLBACK"));
    expect(rb).toContain("171_ticker_alias_siblings.sql");
    expect(rb).toContain(PROD_MD5);
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '177'");
    expect(stripComments(codeOf(sql177))).not.toMatch(/delete\s+from/i);
  });

  it("ORDER: apply any time, no Next.js change, no Edge Function deploy, and serialised before 178", () => {
    const h = flat(head177());
    expect(h).toContain("ORDER");
    expect(h).toMatch(/no Next\.js change/);
    expect(h).toContain("178");
    expect(h).toContain("Never apply this file once 178 is applied");
  });
});

// ---------------------------------------------------------------------------
// A JS mirror of code_hits over the spec's table. The cue regex is READ FROM THE SQL TEXT, so the mirror and the file cannot
// drift apart; foldTr is the TS twin of fold_tr (049).
// ---------------------------------------------------------------------------

const STOPLIST = ["DEVA", "BEYAZ", "ATLAS", "KONYA"];
const TRADED = ["DEVA", "BEYAZ", "ATLAS", "KONYA", "THYAO", "ASELS", "BIMAS"];

function cueRegexFromSql(): RegExp {
  const m = /pg_catalog\.lower\(c\.ticker\) \|\| '([^']*)'\)/.exec(body177());
  expect(m, "the cue literal in the new WHERE").not.toBeNull();
  return new RegExp(`^${(m as RegExpExecArray)[1] ?? ""}`);
}

/** code_hits of 171 (`old`) or 177 (`new`): the tickers attached by code. */
function codeHits(which: "old" | "new", title: string, description: string | null, category: string): string[] {
  const raw = `${title} ${description ?? ""}`;
  const folded = ` ${foldTr(raw)} `;
  const cue = cueRegexFromSql();
  const found = new Set<string>();
  for (const m of raw.matchAll(/\b[A-Z]{4,6}\b/g)) {
    const t = m[0];
    if (!TRADED.includes(t)) continue;
    const stop = STOPLIST.includes(t);
    const paren = raw.includes(`(${t})`);
    const cued = folded.split(` ${t.toLowerCase()}`).slice(1).some((rest) => cue.test(rest));
    const keep =
      which === "old" ? !stop || category === "ekonomi" || paren : !stop || paren || cued;
    if (keep) found.add(t);
  }
  return [...found].sort();
}

interface MirrorCase {
  title: string;
  description?: string | null;
  category?: string;
  expectOld: string[];
  expectNew: string[];
}

const CASES: MirrorCase[] = [
  // the defect: a Babacan story filed under ekonomi
  {
    title: "Babacan: Kayıp 173 milyar doları geçti",
    description: "DEVA Partisi Genel Başkanı Ali Babacan",
    expectOld: ["DEVA"],
    expectNew: [],
  },
  {
    title: "Ali Babacan'dan MSCI uyarısı",
    description: "DEVA Partisi lideri",
    expectOld: ["DEVA"],
    expectNew: [],
  },
  // the company, by every route the gate keeps
  { title: "Deva Holding (DEVA) 3. çeyrek bilançosunu açıkladı", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  { title: "DEVA hisseleri yüzde 5 yükseldi", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  { title: "DEVA Holding'in net karı arttı", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  { title: "DEVA'nın bilançosu açıklandı", expectOld: ["DEVA"], expectNew: [] },
  { title: "DEVA bilançosu beklentiyi aştı", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  { title: "DEVA hissesinde sert düşüş", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  { title: "DEVA payları rekor kırdı", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  // other stoplisted words
  { title: "BİM KATALOĞU: BEYAZ EŞYA fırsatları", expectOld: ["BEYAZ"], expectNew: [] },
  { title: "ATLAS hisseleri borsada işlem görmeye başladı", expectOld: ["ATLAS"], expectNew: ["ATLAS"] },
  { title: "ATLAS Okyanusu'nda fırtına", expectOld: ["ATLAS"], expectNew: [] },
  { title: "KONYA Büyükşehir yeni hat açtı", expectOld: ["KONYA"], expectNew: [] },
  { title: "Fabrika açılışı (KONYA) tamam", expectOld: ["KONYA"], expectNew: ["KONYA"] },
  // not stoplisted: unchanged, whatever the category
  { title: "THYAO hisseleri", expectOld: ["THYAO"], expectNew: ["THYAO"] },
  { title: "ASELS ihracatta rekor", expectOld: ["ASELS"], expectNew: ["ASELS"] },
  { title: "THYAO ve DEVA Partisi birlikte anıldı", expectOld: ["DEVA", "THYAO"], expectNew: ["THYAO"] },
  // another category: stoplisted codes were already gated there
  { title: "DEVA Partisi kongre yaptı", category: "politika", expectOld: [], expectNew: [] },
  { title: "DEVA hisseleri yükseldi", category: "genel", expectOld: [], expectNew: ["DEVA"] },
  { title: "Genel Başkan (DEVA) açıklama yaptı", category: "politika", expectOld: ["DEVA"], expectNew: ["DEVA"] },
  // edges: no uppercase code, null description, unicode and punctuation around the code
  { title: "deva hisseleri yükseldi", expectOld: [], expectNew: [] },
  { title: "DEVA hisseleri", description: null, expectOld: ["DEVA"], expectNew: ["DEVA"] },
  { title: "“DEVA” Partisi açıklaması 🚀", expectOld: ["DEVA"], expectNew: [] },
  { title: "DEVA’nın hisseleri", expectOld: ["DEVA"], expectNew: [] },
  { title: "", description: "", expectOld: [], expectNew: [] },
];

describe("177 ticker_code_stoplist_gate: JS mirror of code_hits over the spec's table (every row category ekonomi unless stated)", () => {
  it("the cue is read from the SQL: it is the spec's alternation, anchored by the code and one space", () => {
    expect(cueRegexFromSql().source).toBe(`^ ${CUE_ALTERNATION}`);
  });

  it.each(CASES)("title=$title description=$description category=$category -> old $expectOld, new $expectNew", (c) => {
    const category = c.category ?? "ekonomi";
    expect(codeHits("old", c.title, c.description ?? "", category)).toEqual(c.expectOld);
    expect(codeHits("new", c.title, c.description ?? "", category)).toEqual(c.expectNew);
  });

  it("the spec's five rows: no DEVA for Babacan, DEVA for the company twice, no BEYAZ for the catalog, THYAO kept", () => {
    const row = (t: string, d = ""): string[] => codeHits("new", t, d, "ekonomi");
    expect(row("Babacan: Kayıp 173 milyar doları geçti", "DEVA Partisi Genel Başkanı Ali Babacan")).toEqual([]);
    expect(row("Deva Holding (DEVA) 3. çeyrek bilançosunu açıkladı")).toEqual(["DEVA"]);
    expect(row("DEVA hisseleri yüzde 5 yükseldi")).toEqual(["DEVA"]);
    expect(row("BİM KATALOĞU: BEYAZ EŞYA fırsatları")).toEqual([]);
    expect(row("THYAO hisseleri")).toEqual(["THYAO"]);
  });

  it("the new gate is never wider than the old one except where it adds a cue in a non-ekonomi story", () => {
    for (const c of CASES) {
      const category = c.category ?? "ekonomi";
      const oldHits = codeHits("old", c.title, c.description ?? "", category);
      const newHits = codeHits("new", c.title, c.description ?? "", category);
      const extra = newHits.filter((t) => !oldHits.includes(t));
      if (category === "ekonomi") expect(extra, c.title).toEqual([]);
    }
  });

  it("scans a 10,000-row table of mixed titles within a generous CPU ceiling", () => {
    let hits = 0;
    expectCpuUnder(() => {
      hits = 0;
      for (let i = 0; i < 10_000; i++) {
        hits += codeHits("new", `Haber ${i} DEVA Partisi THYAO hisseleri ${"x".repeat(i % 50)}`, "", "ekonomi").length;
      }
    }, 20_000);
    expect(hits).toBe(10_000);
  });
});

describe("177 live manifest and dry-run", () => {
  it("builds 177's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 177-ticker-code-stoplist-gate.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/177-ticker-code-stoplist-gate-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 171's state, shows the defect on 171, applies 177 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "171-ticker-alias-siblings-dryrun.sql",
      "../../../supabase/migrations/177_ticker_code_stoplist_gate.sql",
      "../../../supabase/migrations/177_ticker_code_stoplist_gate.sql",
    ]);
    expect(sql).toContain(PROD_MD5);
    expect(sql).toContain(md5(body177()));
    expect(sql).toContain("baseline: 171 attaches DEVA to a Babacan story filed under ekonomi");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 177 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway Postgres with 085, 171 and 177 applied by the
// dry-run script (tests/migrations/sql/live-manifest.txt). Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("177 resolve_article_tickers_for against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("177", {
    ledger: ["085", "171", "177"],
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
  const TRADED_ROWS = TRADED.map((t) => `(array[${lit(t)}]::text[], true)`).join(", ");

  /** One article, the traded companies, one resolver call: "n|TICKERS" ("-" for none). All inside begin ... rollback. */
  function resolveOne(title: string, description: string | null, category: string): string {
    const sql = [
      "begin;",
      `insert into public.bist_companies (tickers, shares_traded) values ${TRADED_ROWS};`,
      `insert into public.articles (id, title, description, category, published_at) values ('${ART}', ${lit(title)}, ${description === null ? "null" : lit(description)}, ${lit(category)}, now());`,
      `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
      `select coalesce(string_agg(ticker, ',' order by ticker), '-') from public.article_tickers where article_id = '${ART}';`,
      "rollback;",
    ].join("\n");
    const [inserted, tickers] = runPsql(sql).trim().split("\n");
    return `${inserted}|${tickers}`;
  }

  it("the function that runs is the file's: md5 and length of prosrc, security invoker, volatile, empty search_path, service_role only", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || provolatile::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = '${FN_SIG}'::regprocedure;`,
    ).trim();
    const body = body177();
    expect(out).toBe(`${md5(body)}|${[...body].length}|false|v|{"search_path=\\"\\""}|integer|p_ids uuid[]`);
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
    expect(runPsql(`select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for';`).trim()).toBe("1");
  });

  it("is idempotent: one 177 ledger row, and the stoplist is still DEVA, BEYAZ, ATLAS, KONYA", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '177';").trim()).toBe("1");
    expect(runPsql("select array_to_string(public.ticker_code_stoplist(), ',');").trim()).toBe("DEVA,BEYAZ,ATLAS,KONYA");
  });

  it("a Babacan / DEVA Partisi story filed under ekonomi no longer attaches DEVA", () => {
    expect(resolveOne("Babacan: Kayıp 173 milyar doları geçti", "DEVA Partisi Genel Başkanı Ali Babacan", "ekonomi")).toBe("0|-");
  });

  it.each([
    ["Deva Holding (DEVA) 3. çeyrek bilançosunu açıkladı", "1|DEVA"],
    ["DEVA hisseleri yüzde 5 yükseldi", "1|DEVA"],
    ["DEVA Holding'in net karı arttı", "1|DEVA"],
    ["DEVA bilançosu beklentiyi aştı", "1|DEVA"],
    ["BİM KATALOĞU: BEYAZ EŞYA fırsatları", "0|-"],
    ["ATLAS Okyanusu'nda fırtına", "0|-"],
    ["KONYA Büyükşehir yeni hat açtı", "0|-"],
    ["Fabrika açılışı (KONYA) tamam", "1|KONYA"],
    ["THYAO hisseleri", "1|THYAO"],
    ["ASELS ihracatta rekor", "1|ASELS"],
    ["THYAO ve DEVA Partisi birlikte anıldı", "1|THYAO"],
  ])("ekonomi: %s -> %s", (title, expected) => {
    expect(resolveOne(title, "", "ekonomi")).toBe(expected);
  });

  it("every row of the JS mirror's table agrees with the function (the mirror reads the cue from the file)", () => {
    for (const c of CASES) {
      const category = c.category ?? "ekonomi";
      if (c.title === "") continue; // an empty title is a degenerate insert, covered by the null-safe case below
      const want = codeHits("new", c.title, c.description ?? "", category);
      const got = resolveOne(c.title, c.description ?? null, category);
      expect(got, c.title).toBe(`${want.length}|${want.length === 0 ? "-" : want.join(",")}`);
    }
  });

  it("another category: DEVA by a bare mention still needs a cue or (DEVA), as in 085", () => {
    expect(resolveOne("DEVA Partisi kongre yaptı", "", "politika")).toBe("0|-");
    expect(resolveOne("Genel Başkan (DEVA) açıklama yaptı", "", "politika")).toBe("1|DEVA");
  });

  it("writes nothing but article_tickers: the company and alias tables are as they were", () => {
    resolveOne("DEVA hisseleri yüzde 5 yükseldi", "", "ekonomi");
    expect(runPsql("select (select count(*) from public.bist_companies) || '|' || (select count(*) from public.bist_aliases) || '|' || (select count(*) from public.article_tickers);").trim()).toBe("0|0|0");
  });
});
