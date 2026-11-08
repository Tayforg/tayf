import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { foldTr } from "../../supabase/functions/_shared/kap.ts";
import { RETAIL_CATALOG_PATTERNS, isRetailCatalog } from "../../supabase/functions/_shared/rss/retail-catalog.ts";
import corpusJson from "../fixtures/ingest-corpus.json";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 178 ("retail_catalog_ticker_gate"), h72-kap-3 (hunt 72).
//
// BİM's weekly "aktüel ürünler kataloğu" and "BİM'E ... GELİYOR!" promos were 179 of BIMAS's 197 article_tickers rows over 30 days
// (91%), from 18 sources, with an average Jev ticker_relevance of 0.91: the 0.2 and 0.5 relevance gates keep and count them, and
// the legal-notice predicate (107) only knows court and BİK notices, so nothing stopped them. They drive BIMAS's /ekonomi rank,
// attention and chart news markers.
//
// 178 adds public.is_retail_catalog(p_title text), a title-only predicate (a retail brand token AND a catalog word, a day range or
// "brand + dative/locative + geliyor|satista"), and re-creates public.resolve_article_tickers_for with 177's body VERBATIM plus
// `and not public.is_retail_catalog(a.title)` in the `recent` CTE. TS twin: supabase/functions/_shared/rss/retail-catalog.ts.
//
// This file pins: the file, the ledger and the transaction; that 177's body (itself 171's plus the stoplist gate) is the one this
// starts from; derive-and-compare (removing the one added predicate gives 177's body byte for byte); the predicate function (the
// five regex literals equal the TS patterns' `.source`, a JS port of the SQL text agrees with the TS predicate over the fixture
// table); that the migration writes nothing; the header; and, with TAYF_PSQL, the real functions against fixtures.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_177 = "177_ticker_code_stoplist_gate.sql";
const FILE_178 = "178_retail_catalog_ticker_gate.sql";
const MIGRATION_177 = resolve(MIGRATIONS_DIR, FILE_177);
const MIGRATION_178 = resolve(MIGRATIONS_DIR, FILE_178);
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "178-retail-catalog-ticker-gate-dryrun.sql");

/** 171's body, which production runs (md5 / length of prosrc read-only, 2026-11-08). */
const PROD_MD5 = "999a286fb58e46bf1958b78dfedcad98";
/** 177's body: 171's plus the stoplist gate, the text 178 starts from. */
const BODY_177_MD5 = "e50fa9276a10825544bebac45493d81e";
const BODY_177_LENGTH = 3485;

const FN = "public.resolve_article_tickers_for";
const FN_SIG = `${FN}(uuid[])`;
const PRED_FN = "public.is_retail_catalog";
const PRED_SIG = `${PRED_FN}(text)`;

/** The one predicate 178 adds to the resolver, with the line it sits on in `recent`'s WHERE. */
const ADDED_LINE = "\n      and not public.is_retail_catalog(a.title)";
const RECENT_LAST_LINE = "      and coalesce(a.category, '') <> 'spor'";

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

const RESOLVER_MARKER = `create or replace function ${FN}(p_ids uuid[])`;
const PRED_MARKER = `create or replace function ${PRED_FN}(p_title text)`;

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

const sql177 = readFileSync(MIGRATION_177, "utf8");
const body177 = bodyAfter(sql177, RESOLVER_MARKER);
const sql178 = existsSync(MIGRATION_178) ? readFileSync(MIGRATION_178, "utf8") : "";
const head178 = (): string => sql178.slice(0, sql178.indexOf("\nbegin;"));
const resolver178 = (): string => bodyAfter(sql178, RESOLVER_MARKER);
const pred178 = (): string => bodyAfter(sql178, PRED_MARKER);

// ---------------------------------------------------------------------------

describe("178 retail_catalog_ticker_gate: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 178", () => {
    expect(existsSync(MIGRATION_178), FILE_178).toBe(true);
    const claims = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("178_"));
    expect(claims).toEqual([FILE_178]);
  });

  it("holds only the transaction frame, the timeout, the predicate with its privileges, the resolver with its privileges and the ledger row, in that order", () => {
    const st = statementsOf(sql178);
    expect(st).toHaveLength(10);
    expect(st[0]).toBe("begin");
    expect(st[1]).toBe("set local lock_timeout = '5s'");
    expect(st[2]).toBe(
      "create or replace function public.is_retail_catalog(p_title text) returns boolean language sql immutable set search_path = '' as @@BODY@@",
    );
    expect(st[3]).toBe(`revoke all on function ${PRED_SIG} from public, anon, authenticated`);
    expect(st[4]).toBe(`grant execute on function ${PRED_SIG} to service_role`);
    expect(st[5]).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as @@BODY@@",
    );
    expect(st[6]).toBe(`revoke all on function ${FN_SIG} from public, anon, authenticated`);
    expect(st[7]).toBe(`grant execute on function ${FN_SIG} to service_role`);
    expect(st[8]).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('178', '178_retail_catalog_ticker_gate') on conflict do nothing",
    );
    expect(st[9]).toBe("commit");
  });

  it("runs in exactly one begin/commit and the ledger insert is the last statement before commit", () => {
    const code = stripComments(codeOf(sql178));
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.lastIndexOf("grant execute on function"));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
  });

  it("sits after 177, and nothing between 177 and 178 redefines the resolver", () => {
    expect(existsSync(MIGRATION_177)).toBe(true);
    const between = readdirSync(MIGRATIONS_DIR)
      .filter((n) => /^\d{3}_/.test(n))
      .filter((n) => Number(n.slice(0, 3)) > 177 && Number(n.slice(0, 3)) < 178);
    expect(between).toEqual([]);
    expect(FILE_177 < FILE_178).toBe(true);
  });
});

describe("178 retail_catalog_ticker_gate: the body it was built from", () => {
  it("177's function body is the pinned text: md5 and length (177 = 171 plus the stoplist gate)", () => {
    expect(md5(body177)).toBe(BODY_177_MD5);
    expect([...body177].length).toBe(BODY_177_LENGTH);
  });

  it("the header records production's fingerprint (171's body), 177's, and that 178 replaces 177's body", () => {
    const h = flat(head178());
    expect(h).toContain(`md5 ${PROD_MD5}`);
    expect(h).toContain("length 3401");
    expect(h).toContain(`md5 ${BODY_177_MD5}`);
    expect(h).toContain(`length ${BODY_177_LENGTH}`);
    expect(h).toContain("pg_get_functiondef");
    expect(h).toContain("{postgres=X/postgres,service_role=X/postgres}");
  });
});

describe("178 retail_catalog_ticker_gate: derive-and-compare against 177", () => {
  it("the added predicate occurs exactly once in the resolver, inside recent's WHERE, right after the spor test", () => {
    const b = resolver178();
    expect(countOf(b, ADDED_LINE)).toBe(1);
    expect(countOf(b, "is_retail_catalog")).toBe(1);
    expect(countOf(b, `${RECENT_LAST_LINE}${ADDED_LINE}\n  ),`)).toBe(1);
    expect(b.indexOf(ADDED_LINE)).toBeLessThan(b.indexOf("  ctx as ("));
    expect(countOf(body177, "is_retail_catalog")).toBe(0);
  });

  it("removing the one predicate gives 177's body, byte for byte", () => {
    expect(resolver178().replace(ADDED_LINE, "")).toBe(body177);
  });

  it("the substitution notices a change anywhere else: an edit outside recent breaks the equality", () => {
    const tampered = resolver178().replace("on conflict do nothing", "on conflict do nothing /* x */");
    expect(tampered).not.toBe(resolver178());
    expect(tampered.replace(ADDED_LINE, "")).not.toBe(body177);
    const widened = resolver178().replace(" (holding|hisse", " (holding|bank|hisse");
    expect(widened.replace(ADDED_LINE, "")).not.toBe(body177);
  });

  it("code_hits keeps 177's stoplist gate and alias_matches / alias_hits are untouched", () => {
    const b = resolver178();
    expect(b).toContain(
      [
        "    where c.ticker <> all (public.ticker_code_stoplist())",
        "       or pg_catalog.strpos(r.raw, '(' || c.ticker || ')') > 0",
        "       or r.folded ~ (' ' || pg_catalog.lower(c.ticker) || ' (holding|hisse|hissesi|hisseleri|pay|paylari|bilanco)')",
      ].join("\n"),
    );
    const seg = (x: string): string => x.slice(x.indexOf("alias_matches as materialized ("), x.indexOf("code_hits as ("));
    expect(seg(b)).toBe(seg(body177));
    const tail = (x: string): string => x.slice(x.indexOf("  hits as ("));
    expect(tail(b)).toBe(tail(body177));
  });

  it("the gate is title-only and the whole article leaves the resolver: it sits in recent, so neither alias_hits nor code_hits sees the row", () => {
    const b = resolver178();
    const recentEnd = b.indexOf("  ctx as (");
    expect(b.indexOf("is_retail_catalog")).toBeLessThan(recentEnd);
    expect(b).not.toMatch(/is_retail_catalog\(\s*(a\.description|r\.raw|r\.folded|a\.url)/);
    expect(b).toContain("is_retail_catalog(a.title)");
  });
});

describe("178 retail_catalog_ticker_gate: the resolver keeps 177's signature, security mode, search_path and grants", () => {
  it("is security invoker, volatile, an empty search_path, the same header as 177", () => {
    const hdr = (sql: string): string => {
      const code = codeOf(sql);
      const at = code.indexOf(RESOLVER_MARKER);
      return collapse(code.slice(at, code.indexOf("$$", at) + 2));
    };
    expect(hdr(sql178)).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as $$",
    );
    expect(hdr(sql178)).toBe(hdr(sql177));
    expect(hdr(sql178)).not.toMatch(/security\s+definer/i);
  });

  it("revokes from public, anon and authenticated and grants execute to service_role only, for both functions", () => {
    const code = stripComments(codeOf(sql178));
    for (const sig of [PRED_SIG, FN_SIG]) {
      expect(countOf(code, `revoke all on function ${sig} from public, anon, authenticated;`), sig).toBe(1);
      expect(countOf(code, `grant execute on function ${sig} to service_role;`), sig).toBe(1);
    }
    expect(code).not.toMatch(/grant[^;]*\sto\s+[^;]*\b(anon|authenticated|public)\b/i);
  });
});

describe("178 retail_catalog_ticker_gate: public.is_retail_catalog", () => {
  it("is language sql, immutable, an empty search_path, returns boolean, takes the title alone", () => {
    const code = codeOf(sql178);
    const at = code.indexOf(PRED_MARKER);
    const hdr = collapse(code.slice(at, code.indexOf("$$", at) + 2));
    expect(hdr).toBe(
      "create or replace function public.is_retail_catalog(p_title text) returns boolean language sql immutable set search_path = '' as $$",
    );
    expect(hdr).not.toMatch(/security\s+definer/i);
  });

  it("folds the title with public.fold_tr, pads it with one space each side, and is NULL-safe (coalesce to false)", () => {
    const b = pred178();
    expect(b).toContain("' ' || public.fold_tr(p_title) || ' '");
    expect(b).toMatch(/select\s+coalesce\(/);
    expect(collapse(b)).toMatch(/,\s*false\s*\)\s*from \(select/);
  });

  it("embeds the five TS pattern sources verbatim, once each, in the order BRAND, CATALOG_CUE, DAY_RANGE, BRAND_SUFFIX, ARRIVAL", () => {
    const lits = [...pred178().matchAll(/f ~ '([^']*)'/g)].map((m) => m[1]);
    const P = RETAIL_CATALOG_PATTERNS;
    expect(lits).toEqual([
      P.BRAND.source,
      P.CATALOG_CUE.source,
      P.DAY_RANGE.source,
      P.BRAND_SUFFIX.source,
      P.ARRIVAL.source,
    ]);
    for (const re of Object.values(P)) expect(countOf(pred178(), `'${re.source}'`), re.source).toBe(1);
  });

  it("combines them as BRAND and (CATALOG_CUE or DAY_RANGE or (BRAND_SUFFIX and ARRIVAL))", () => {
    const shape = collapse(pred178())
      .replace(/f ~ '[^']*'/g, (m, off: number, all: string) => {
        const k = [...all.slice(0, off).matchAll(/f ~ '/g)].length;
        return ["BRAND", "CATALOG", "DAYS", "SUFFIX", "ARRIVAL"][k] as string;
      });
    expect(shape).toContain("select coalesce( BRAND and ( CATALOG or DAYS or ( SUFFIX and ARRIVAL ) ), false )".replace(/\( /g, "(").replace(/ \)/g, ")"));
  });

  it("reads no table and writes nothing: no from public., no insert, no update, every call schema-qualified", () => {
    const b = pred178();
    expect(b).not.toMatch(/from\s+public\./i);
    expect(b).not.toMatch(/\b(insert|update|delete)\b/i);
    expect(b).not.toContain("\\");
    expect(countOf(b, "public.fold_tr(")).toBe(1);
    expect(b).not.toMatch(/(^|[^.\w])(fold_tr|lower|upper)\(/);
  });
});

describe("178 retail_catalog_ticker_gate: additive, nothing is written by the migration", () => {
  it("has no delete, update, truncate, alter, drop, copy, create table or index, and no backfill", () => {
    const code = stripComments(codeOf(sql178));
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

  it("the only writes besides the ledger are the resolver's own insert into article_tickers, as in 171", () => {
    const code = stripComments(codeOf(sql178));
    expect([...code.matchAll(/\binsert\s+into\b/gi)]).toHaveLength(2);
    expect(countOf(code, "insert into public.article_tickers")).toBe(1);
    expect(countOf(code, "insert into supabase_migrations.schema_migrations")).toBe(1);
  });

  it("does not redefine the stoplist or touch the bist tables", () => {
    const code = stripComments(codeOf(sql178));
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.ticker_code_stoplist/i);
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.bist_/i);
  });
});

describe("178 retail_catalog_ticker_gate: the header", () => {
  it("names the evidence: 179 of 197 rows, 91%, 18 sources, the 0.91 Jev relevance, the live /ekonomi row", () => {
    const h = flat(head178());
    expect(h).toContain("179 of 197");
    expect(h).toContain("91%");
    expect(h).toContain("18 sources");
    expect(h).toContain("0.91");
    expect(h).toContain("BIMAS");
    expect(h).toContain("0.2");
    expect(h).toContain("0.5");
    expect(h).toContain("107");
    expect(h).toContain("is_legal_notice");
  });

  it("states the predicate: title only, never the URL, the brand tokens and the three cues, and the accepted misses", () => {
    const h = flat(head178());
    expect(h).toContain("THE PREDICATE");
    expect(h).toContain("title only");
    expect(h).toContain("never the URL");
    expect(h).toContain("bim|a101|sok|migros|carrefoursa");
    expect(h).toContain("(a)");
    expect(h).toContain("(b)");
    expect(h).toContain("(c)");
    expect(h).toContain("known false negative");
    expect(h).toContain("MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE!");
    expect(h).toContain("known false positive");
    expect(h).toContain("e-ticarete");
  });

  it("records the deviations from the spec's text: the number, the folded day range, the suffix set, the space delimiters", () => {
    const h = flat(head178());
    expect(h).toContain("NUMBER");
    expect(h).toContain("177_retail_catalog_ticker_gate.sql");
    expect(h).toContain("DEVIATIONS");
    expect(h).toContain("parenthes");
    expect(h).toContain("fold_tr turns");
    expect(h).toContain("(e|a|ye|ya|de|da|te|ta)");
    expect(h).toContain("literal spaces");
  });

  it("records the read-only replay: 178 of 197 BIMAS rows, the 19 kept rows, 193 rows over all tickers and the top affected tickers", () => {
    const h = flat(head178());
    expect(h).toContain("REPLAY");
    expect(h).toContain("178 of 197");
    expect(h).toContain("19 rows");
    expect(h).toContain("5,688");
    expect(h).toContain("193 rows");
    expect(h).toContain("189 articles");
    for (const t of ["BIMAS 178", "MGROS 4", "GOODY 3", "MIGRS 3", "ARZUM 1", "BEYAZ 1", "EKIM 1", "GRUND 1", "SMART 1"]) {
      expect(h, t).toContain(t);
    }
    expect(h).toContain("9 tickers");
  });

  it("COST: a handful of regexes and no table read, per inserted row", () => {
    const h = flat(head178());
    expect(h).toContain("COST");
    expect(h).toContain("8 s");
    expect(h).toContain("statement_timeout");
    expect(h).toContain("no table read");
  });

  it("carries the FOUNDER-ONLY optional deletion of the existing catalog rows (they leave the 30-day windows by early December)", () => {
    const h = flat(head178());
    expect(h).toContain("FOUNDER-ONLY");
    expect(h).toContain("early December");
    expect(h).toContain("optional");
  });

  it("VERIFY carries the md5 and length of both function bodies, the privileges and the ledger row", () => {
    const h = flat(head178());
    expect(h).toContain("VERIFY");
    expect(h).toContain(md5(resolver178()));
    expect(h).toContain(`${[...resolver178()].length}`);
    expect(h).toContain(md5(pred178()));
    expect(h).toContain(`${[...pred178()].length}`);
    expect(h).toContain("has_function_privilege");
    expect(h).toContain("version = '178'");
  });

  it("ROLLBACK re-creates 177's resolver first, then drops the predicate, then removes only the 178 ledger row", () => {
    const h = flat(head178());
    const rb = h.slice(h.indexOf("ROLLBACK"));
    expect(rb).toContain("177_ticker_code_stoplist_gate.sql");
    expect(rb).toContain(BODY_177_MD5);
    expect(rb.indexOf("177_ticker_code_stoplist_gate.sql")).toBeLessThan(rb.indexOf("drop function public.is_retail_catalog(text)"));
    expect(rb.indexOf("drop function public.is_retail_catalog(text)")).toBeLessThan(
      rb.indexOf("delete from supabase_migrations.schema_migrations where version = '178'"),
    );
    expect(stripComments(codeOf(sql178))).not.toMatch(/delete\s+from|drop\s+/i);
  });

  it("ORDER: apply 177 first, then 178, never 177 again after 178 (it would restore the body without the catalog gate)", () => {
    const h = flat(head178());
    expect(h).toContain("ORDER");
    expect(h).toContain("APPLY 177 first");
    expect(h).toContain("never re-run 177 after 178");
    // 177 stays pending in the ledger when 178 is applied alone, and `supabase db push --include-all` would then run it AFTER 178
    expect(h).toContain("--include-all");
    expect(h).toContain("values ('177', '177_ticker_code_stoplist_gate')");
    expect(h).toMatch(/no Next\.js change/);
  });
});

// ---------------------------------------------------------------------------
// The truth table. Each row is run through (1) the TS predicate, (2) a JS port of the SQL text (the five literals are READ
// FROM THE FILE and combined the way the SQL combines them) and, with TAYF_PSQL, (3) public.is_retail_catalog in PostgreSQL.
// ---------------------------------------------------------------------------

interface Case {
  title: string;
  expected: boolean;
}

const CASES: Case[] = [
  // the spec's six TRUE rows
  { title: "BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU", expected: true },
  { title: "BUGÜN SATIŞTA! BİM'E 3 ÇEKMECELİ DERİN DONDURUCU GELİYOR! (BİM 8-14 KASIM)", expected: true },
  { title: "BİM 8 Kasım 2026 Pazar Aktüel Ürünler Kataloğu Yayımda!", expected: true },
  { title: "BİM 11 KASIM ÇARŞAMBA İNDİRİM KATALOĞU YAYINLANDI!", expected: true },
  { title: "Bim aktüel ürünler kataloğu yayınlandı!", expected: true },
  { title: "BİM'E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR!", expected: true },
  // the spec's six FALSE rows
  { title: "BİM, 250 bin lira sermayeli teknoloji şirketi kurdu", expected: false },
  { title: "BİM'den büyük atak. Şube sayısını katladı A101 ile farkı kapattı!", expected: false },
  { title: "BofA'nın haftalık bilançosu: Bankaları aldı, BİM'i sattı", expected: false },
  { title: "29 Ekim zincir marketler açık mı? 29 Ekim Cumhuriyet Bayramı BİM, A101, ŞOK market çalışma saatleri", expected: false },
  { title: "THY, 7 milyar doları aştı", expected: false },
  { title: "33 şirketin temettü takvimi açıklandı", expected: false },
  // the accepted miss, bare and with production's day range
  { title: "MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE!", expected: false },
  { title: "MONSTER OYUN BİLGİSAYARLARI 49.990 TL'DEN BAŞLAYAN FİYATLARLA BİM'DE! (BİM 11-17 KASIM)", expected: true },
  // production rows (BIMAS and the other chains, 30 days)
  { title: "BİM'DE BU ÜRÜNLER RESMEN KAPIŞILACAK! YENİ İNDİRİM LİSTESİ AÇIKLANDI! (BİM 27 EKİM 2 KASIM)", expected: true },
  { title: "ŞOK’A ARZUM OKKA MINIO GO TÜRK KAHVE MAKİNESİ GELİYOR! (ŞOK 4-10 KASIM)", expected: true },
  { title: "A101 15 EKIM AKTÜEL KATALOĞU | ALDIN ALDIN: Halı yıkama makinesinden, düdüklü tenceresine kadar", expected: true },
  { title: "Migros 1 alana 1 bedava kampanyası ne zaman? Migros 10-18 Ekim 2026 indirimli ürünler", expected: true },
  { title: "BİM teknoloji sektörüne giriyor: Yapay zeka ve dijital bankacılık için yeni şirket", expected: false },
  { title: "Tanju Özcan mahkemede: BİM, ŞOK ve A101 iddialarını yanıtladı", expected: false },
  { title: "ASELS, ULKER, BIMAS, MGROS, SOKM… Tam 34 hisse için aracı kurumlar fiyat tahmini açıkladı.", expected: false },
  // brand tokens are whole words; a cue without a brand is not enough
  { title: "Bimbo aktüel ürünler kataloğu", expected: false },
  { title: "Yeni ürün kataloğu yayımlandı: Ofis mobilyaları", expected: false },
  { title: "Migros 13 Kasım 2026 tarihinde genel kurul toplantısı yapacak", expected: false },
  { title: "BİM 5 Kasım'da bilançosunu açıklayacak", expected: false },
  // the folded suffix words, both documented edges
  { title: "ŞOK’A YENİ TV GELİYOR", expected: true },
  { title: "CarrefourSA'YA gofret makinesi GELİYOR", expected: true },
  { title: "BİM e-ticarete geliyor", expected: true },
  // edges
  { title: "", expected: false },
  { title: "   ", expected: false },
  { title: "!!! ??? ...", expected: false },
  { title: "🛒🛒🛒 BİM 🛒🛒🛒", expected: false },
  { title: "'; drop table articles; -- BİM", expected: false },
  { title: "🛒 BİM aktüel ürünler kataloğu 🛒", expected: true },
  { title: "BİM AKTÜEL 9-10-11-13-14-16 EKİM 2026", expected: true },
];

/** The SQL predicate as JS: the five literals of the shipped file, combined like the SQL combines them. */
function sqlPort(title: string): boolean {
  const lits = [...pred178().matchAll(/f ~ '([^']*)'/g)].map((m) => new RegExp(m[1] as string));
  expect(lits).toHaveLength(5);
  const [brand, cue, days, suffix, arrival] = lits as [RegExp, RegExp, RegExp, RegExp, RegExp];
  const f = ` ${foldTr(title)} `;
  return brand.test(f) && (cue.test(f) || days.test(f) || (suffix.test(f) && arrival.test(f)));
}

describe("178 retail_catalog_ticker_gate: parity of the TS predicate and the SQL text over the fixture table", () => {
  it.each(CASES)("title=$title -> $expected", ({ title, expected }) => {
    expect(isRetailCatalog(title)).toBe(expected);
    expect(sqlPort(title)).toBe(expected);
  });

  it("the table has both outcomes and no duplicate title", () => {
    const keys = CASES.map((c) => c.title);
    expect(new Set(keys).size).toBe(keys.length);
    expect(CASES.some((c) => c.expected)).toBe(true);
    expect(CASES.some((c) => !c.expected)).toBe(true);
  });

  it("agrees on every ingest-corpus title, alone and dressed up with a brand and a cue", () => {
    const corpus = corpusJson as unknown as { rows: Array<{ item: { title?: string } }> };
    expect(corpus.rows.length).toBeGreaterThanOrEqual(200);
    const mismatches: string[] = [];
    for (const [i, { item }] of corpus.rows.entries()) {
      const t = item.title ?? "";
      for (const v of [
        t,
        t.toLocaleUpperCase("tr"),
        `BİM ${t}`,
        `${t} (BİM 8-14 KASIM)`,
        `BİM'E ${t} GELİYOR`,
        `Migros ${t} kataloğu`,
      ]) {
        if (isRetailCatalog(v) !== sqlPort(v)) mismatches.push(`#${i} ${JSON.stringify(v)}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("flags none of the corpus titles on their own (real feed headlines carry no retail catalog)", () => {
    const corpus = corpusJson as unknown as { rows: Array<{ item: { title?: string } }> };
    const flagged = corpus.rows.map(({ item }) => item.title ?? "").filter((t) => isRetailCatalog(t));
    expect(flagged.length).toBeLessThanOrEqual(2);
  });
});

describe("178 live manifest and dry-run", () => {
  it("builds 178's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 178-retail-catalog-ticker-gate.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/178-retail-catalog-ticker-gate-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 177's state, shows the defect on 177's body, applies 178 twice, keeps a time budget and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "177-ticker-code-stoplist-gate-dryrun.sql",
      "../../../supabase/migrations/178_retail_catalog_ticker_gate.sql",
      "../../../supabase/migrations/178_retail_catalog_ticker_gate.sql",
    ]);
    expect(sql).toContain(BODY_177_MD5);
    expect(sql).toContain(md5(resolver178()));
    expect(sql).toContain(md5(pred178()));
    expect(sql).toContain("baseline: 177 attaches BIMAS to a BİM catalog story");
    expect(sql).toContain("clock_timestamp()");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 178 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): both functions against fixtures, on a throwaway Postgres with 085, 171, 177 and 178 applied by the
// dry-run script (tests/migrations/sql/live-manifest.txt). Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("178 is_retail_catalog and resolve_article_tickers_for against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("178", {
    ledger: ["085", "171", "177", "178"],
    relations: ["public.bist_aliases", "public.bist_companies", "public.article_tickers"],
    functions: [
      "public.is_retail_catalog(text)",
      "public.resolve_article_tickers_for(uuid[])",
      "public.ticker_code_stoplist()",
      "public.fold_tr(text)",
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
  const COMPANIES = ["BIMAS", "MGROS", "SOKM", "ARZUM", "THYAO", "DEVA", "BEYAZ"]
    .map((t) => `(array[${lit(t)}]::text[], true)`)
    .join(", ");

  /** One article through the resolver with BIMAS, MGROS and SOKM manual aliases: "n|TICKERS" ("-" for none). */
  function resolveOne(title: string, description: string, category = "ekonomi"): string {
    const sql = [
      "begin;",
      `insert into public.bist_companies (tickers, shares_traded) values ${COMPANIES};`,
      "insert into public.bist_aliases (alias, ticker, origin) values ('bim', 'BIMAS', 'manual'), ('migros', 'MGROS', 'manual'), ('sok', 'SOKM', 'manual');",
      `insert into public.articles (id, title, description, category, published_at) values ('${ART}', ${lit(title)}, ${lit(description)}, ${lit(category)}, now());`,
      `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
      `select coalesce(string_agg(ticker, ',' order by ticker), '-') from public.article_tickers where article_id = '${ART}';`,
      "rollback;",
    ].join("\n");
    const [inserted, tickers] = runPsql(sql).trim().split("\n");
    return `${inserted}|${tickers}`;
  }

  it("both functions that run are the file's: md5 and length of prosrc, attributes and ACL", () => {
    const resolver = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || provolatile::text || '|' || coalesce(proconfig::text, '') from pg_proc where oid = '${FN_SIG}'::regprocedure;`,
    ).trim();
    expect(resolver).toBe(`${md5(resolver178())}|${[...resolver178()].length}|false|v|{"search_path=\\"\\""}`);
    const pred = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || provolatile::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = '${PRED_SIG}'::regprocedure;`,
    ).trim();
    expect(pred).toBe(`${md5(pred178())}|${[...pred178()].length}|false|i|{"search_path=\\"\\""}|boolean|p_title text`);
    for (const sig of [FN_SIG, PRED_SIG]) {
      const acl = runPsql(
        `select has_function_privilege('anon', '${sig}', 'execute') || '|' || has_function_privilege('authenticated', '${sig}', 'execute') || '|' || has_function_privilege('service_role', '${sig}', 'execute');`,
      ).trim();
      expect(acl, sig).toBe("false|false|true");
    }
    expect(runPsql("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname in ('resolve_article_tickers_for', 'is_retail_catalog');").trim()).toBe("2");
  });

  it("is idempotent: one 178 ledger row", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '178';").trim()).toBe("1");
  });

  it("returns the expected boolean for every fixture row, as the TS predicate does", () => {
    const values = CASES.map((c, i) => `(${i}, ${lit(c.title)})`).join(", ");
    const out = runPsql(
      `select i || '|' || public.is_retail_catalog(t) from (values ${values}) v(i, t) order by i;`,
    )
      .trim()
      .split("\n");
    expect(out).toHaveLength(CASES.length);
    for (const line of out) {
      const [i, v] = line.split("|");
      const c = CASES[Number(i)] as Case;
      expect(v === "true", c.title).toBe(c.expected);
    }
  });

  it("is NULL-safe: a null title returns false, never null, so `and not` keeps the row", () => {
    expect(runPsql("select public.is_retail_catalog(null) is not distinct from false, public.is_retail_catalog('');").trim()).toBe("t|f");
  });

  it("a BİM catalog story no longer attaches BIMAS, a real BİM story still does", () => {
    expect(resolveOne("BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU", "")).toBe("0|-");
    expect(resolveOne("BİM'E ALTUS HALI VE KOLTUK YIKAMA MAKİNESİ GELİYOR!", "")).toBe("0|-");
    expect(resolveOne("BİM, 250 bin lira sermayeli teknoloji şirketi kurdu", "")).toBe("1|BIMAS");
    expect(resolveOne("BofA'nın haftalık bilançosu: Bankaları aldı, BİM'i sattı", "")).toBe("1|BIMAS");
  });

  it("the gate reads the title only: a catalog word in the description does not exclude a real story", () => {
    expect(resolveOne("BİM yeni şirket kurdu", "BİM aktüel ürünler kataloğu bu hafta yayımlandı")).toBe("1|BIMAS");
  });

  it("the whole article leaves the resolver: the alias path and the code path alike", () => {
    // Migros: alias path
    expect(resolveOne("Migros 1 alana 1 bedava kampanyası ne zaman? Migros 10-18 Ekim 2026 indirimli ürünler", "")).toBe("0|-");
    expect(resolveOne("Migros'un üçüncü çeyrek net karı yüzde 12 arttı", "")).toBe("1|MGROS");
    // ARZUM: code path, in a Şok catalog headline
    expect(resolveOne("ŞOK’A ARZUM OKKA MINIO GO TÜRK KAHVE MAKİNESİ GELİYOR! (ŞOK 4-10 KASIM)", "")).toBe("0|-");
    expect(resolveOne("ARZUM hisseleri yükseldi", "")).toBe("1|ARZUM");
  });

  it("another category is gated the same way (the predicate does not read the category)", () => {
    expect(resolveOne("BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU", "", "genel")).toBe("0|-");
    expect(resolveOne("BİM, 250 bin lira sermayeli teknoloji şirketi kurdu", "", "genel")).toBe("1|BIMAS");
  });

  it("177's stoplist gate is still in force in 178's body", () => {
    expect(resolveOne("Babacan: Kayıp 173 milyar doları geçti", "DEVA Partisi Genel Başkanı Ali Babacan")).toBe("0|-");
    expect(resolveOne("DEVA hisseleri yüzde 5 yükseldi", "")).toBe("1|DEVA");
    expect(resolveOne("BİM KATALOĞU: BEYAZ EŞYA fırsatları", "")).toBe("0|-");
    expect(resolveOne("THYAO hisseleri", "")).toBe("1|THYAO");
  });

  it("writes nothing but article_tickers: the company and alias tables are as they were", () => {
    resolveOne("BİM 13 KASIM AKTÜEL ÜRÜNLER KATALOĞU", "");
    expect(runPsql("select (select count(*) from public.bist_companies) || '|' || (select count(*) from public.bist_aliases) || '|' || (select count(*) from public.article_tickers);").trim()).toBe("0|0|0");
  });
});
