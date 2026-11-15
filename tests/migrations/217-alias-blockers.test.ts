import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { foldTr } from "../../supabase/functions/_shared/kap.ts";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 217 ("alias_blockers"), h198-ekonomi-1 (hunt 198).
//
// 085's alias join matches a brand word as a whole-word substring, so a LONGER name that begins with the same brand word attaches
// the brand's ticker to a different company: "Kardemir Çelik" (KARCL, a separate listed company) was filed under KRDMD
// ('kardemir' is KRDMD's manual alias), "Sümer Holding" (the state holding) under SMRVA ('sumer' is the auto alias of SÜMER VARLIK
// YÖNETİM) and "Türkiye Sigorta Birliği" (the insurers' association) under TURSG ('turkiye sigorta'). The Jev relevance gate cannot
// catch it: it scores the wrong ticker 0.94.
//
// 217 adds public.bist_alias_blocks (alias, phrase) with three seed rows, two manual aliases (KARCL, EDATA), and re-creates
// public.resolve_article_tickers_for with 178's body VERBATIM plus exactly two edits: alias_matches' select list gains `r.folded`, and
// alias_hits' WHERE gains rule C, `and not exists (select 1 from public.bist_alias_blocks b where b.alias = al.alias and
// pg_catalog.strpos(al.folded, ' ' || b.phrase || ' ') > 0)`. The predicate runs only on the rows that already matched the text
// (alias_matches stays MATERIALIZED), so the per-article cost stays about 1 ms.
//
// This file pins, without a database: the file, ledger and transaction; the table and its privileges; the three seeds and the two
// aliases; that 178's body is the pinned production text; derive-and-compare (removing the two edits gives 178's body byte for byte);
// that nothing existing is written; the header, the docs sections, the live manifest and the dry-run script. With TAYF_PSQL the opt-in
// live block runs the real function against fixtures.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_178 = "178_retail_catalog_ticker_gate.sql";
const FILE_217 = "217_alias_blockers.sql";
const MIGRATION_178 = resolve(MIGRATIONS_DIR, FILE_178);
const MIGRATION_217 = resolve(MIGRATIONS_DIR, FILE_217);
const DOC_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_ARCH = resolve(ROOT, "docs", "architecture.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "217-alias-blockers-dryrun.sql");

/** Production, read-only, 2026-11-15: the resolver that runs is 178's body. */
const BODY_178_MD5 = "70eaada3de06f8ccf4f54be6b81b3d20";
const BODY_178_LENGTH = 3533;

const FN = "public.resolve_article_tickers_for";
const FN_SIG = `${FN}(uuid[])`;
const TABLE = "public.bist_alias_blocks";
const RESOLVER_MARKER = `create or replace function ${FN}(p_ids uuid[])`;
/** The fold_tr form (049: lowercase a-z, 0-9, single spaces, trimmed), as a non-capturing group so collapse() leaves the text alone. */
const FOLDED_CHECK_RE = "'^[a-z0-9]+(?: [a-z0-9]+)*$'";
const TABLE_DDL = `create table if not exists public.bist_alias_blocks (alias text not null, phrase text not null, primary key (alias, phrase), constraint bist_alias_blocks_folded check (alias ~ ${FOLDED_CHECK_RE} and phrase ~ ${FOLDED_CHECK_RE}))`;

/** The three seed rows: a brand alias and the longer folded phrase of ANOTHER entity that starts with it. */
const SEED_BLOCKS: ReadonlyArray<readonly [string, string]> = [
  ["kardemir", "kardemir celik"],
  ["sumer", "sumer holding"],
  ["turkiye sigorta", "turkiye sigorta birligi"],
];
/** The two manual aliases that give the longer names their own ticker. */
const NEW_ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["kardemir celik", "KARCL"],
  ["e data teknoloji", "EDATA"],
];

/** Edit (a): alias_matches carries the folded text out to alias_hits. */
const EDIT_A_OLD = "           r.published_at, r.source_id\n    from ctx r\n    join public.bist_aliases al";
const EDIT_A_NEW = "           r.published_at, r.source_id, r.folded\n    from ctx r\n    join public.bist_aliases al";
/** Edit (b): rule C, the last predicate of alias_hits' WHERE, on its own line. */
const EDIT_B =
  "\n      and not exists (select 1 from public.bist_alias_blocks b where b.alias = al.alias and pg_catalog.strpos(al.folded, ' ' || b.phrase || ' ') > 0)";
const RULE_B_LAST_LINE = "where c2.shares_traded and c2.tickers @> array[o.ticker]))))";

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

/** Every `('a', 'b')` pair of a values list, read with indexOf (no regular expression over SQL text). */
function pairsOf(stmt: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  let from = stmt.indexOf("values");
  expect(from, "a values list").toBeGreaterThanOrEqual(0);
  for (;;) {
    const open = stmt.indexOf("('", from);
    if (open < 0) return out;
    const close = stmt.indexOf(")", open);
    const parts = stmt
      .slice(open + 1, close)
      .split(",")
      .map((p) => p.trim().replace(/^'/, "").replace(/'$/, ""));
    out.push([parts[0] as string, parts[1] as string]);
    from = close + 1;
  }
}

const sql178 = readFileSync(MIGRATION_178, "utf8");
const body178 = bodyAfter(sql178, RESOLVER_MARKER);
const sql217 = existsSync(MIGRATION_217) ? readFileSync(MIGRATION_217, "utf8") : "";
const head217 = (): string => {
  expect(existsSync(MIGRATION_217), `${FILE_217} must exist`).toBe(true);
  return sql217.slice(0, sql217.indexOf("\nbegin;"));
};
const resolver217 = (): string => {
  expect(existsSync(MIGRATION_217), `${FILE_217} must exist`).toBe(true);
  return bodyAfter(sql217, RESOLVER_MARKER);
};
const stmts217 = (): string[] => {
  expect(existsSync(MIGRATION_217), `${FILE_217} must exist`).toBe(true);
  return statementsOf(sql217);
};

// ---------------------------------------------------------------------------

describe("217 alias_blockers: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 217", () => {
    expect(existsSync(MIGRATION_217), FILE_217).toBe(true);
    const claims = readdirSync(MIGRATIONS_DIR).filter((n) => n.startsWith("217_"));
    expect(claims).toEqual([FILE_217]);
  });

  it("never reuses a held number: 197 and 202 stay free", () => {
    const names = readdirSync(MIGRATIONS_DIR);
    expect(names.filter((n) => n.startsWith("197_") || n.startsWith("202_"))).toEqual([]);
  });

  it("holds only the transaction frame, the timeout, the table with its RLS and grants, the seeds, the aliases, the resolver with its privileges and the ledger row, in that order", () => {
    const st = stmts217();
    expect(st).toHaveLength(13);
    expect(st[0]).toBe("begin");
    expect(st[1]).toBe("set local lock_timeout = '5s'");
    expect(st[2]).toBe(TABLE_DDL);
    expect(st[3]).toBe("alter table public.bist_alias_blocks enable row level security");
    expect(st[4]).toBe("revoke all on table public.bist_alias_blocks from public, anon, authenticated");
    expect(st[5]).toBe("grant select on table public.bist_alias_blocks to service_role");
    expect(st[6]).toBe(
      "insert into public.bist_alias_blocks (alias, phrase) values ('kardemir', 'kardemir celik'), ('sumer', 'sumer holding'), ('turkiye sigorta', 'turkiye sigorta birligi') on conflict do nothing",
    );
    expect(st[7]).toBe(
      "insert into public.bist_aliases (alias, ticker, origin) values ('kardemir celik', 'KARCL', 'manual'), ('e data teknoloji', 'EDATA', 'manual') on conflict do nothing",
    );
    expect(st[8]).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as @@BODY@@",
    );
    expect(st[9]).toBe(`revoke all on function ${FN_SIG} from public, anon, authenticated`);
    expect(st[10]).toBe(`grant execute on function ${FN_SIG} to service_role`);
    expect(st[11]).toBe(
      "insert into supabase_migrations.schema_migrations (version, name) values ('217', '217_alias_blockers') on conflict do nothing",
    );
    expect(st[12]).toBe("commit");
  });

  it("runs in exactly one begin/commit and the ledger insert is the last statement before commit", () => {
    const code = stripComments(sql217.slice(sql217.indexOf("\nbegin;")));
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.lastIndexOf("grant execute on function"));
    const afterLedger = code.slice(ledger).replace(/^[\s\S]*?on\s+conflict\s+do\s+nothing\s*;/i, "");
    expect(afterLedger.trim()).toBe("commit;");
  });

  it("sits after 178, the migration whose body it starts from, and nothing between 178 and 217 redefines the resolver", () => {
    expect(FILE_178 < FILE_217).toBe(true);
    const redefiners = readdirSync(MIGRATIONS_DIR)
      .filter((n) => /^\d{3}_/.test(n) && n.endsWith(".sql") && n > FILE_178 && n <= FILE_217)
      .filter((n) =>
        collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, n), "utf8"))).includes(`create or replace function ${FN}(`),
      );
    expect(redefiners, "178's body is still production's").toEqual([FILE_217]);
  });
});

describe("217 alias_blockers: the table", () => {
  it("is public.bist_alias_blocks (alias text not null, phrase text not null, primary key (alias, phrase), constraint bist_alias_blocks_folded check ...), created with if not exists", () => {
    expect(stmts217()[2]).toBe(TABLE_DDL);
    expect(countOf(collapse(stripComments(sql217)), "create table")).toBe(1);
  });

  it("refuses a row that is not in fold_tr form: a named CHECK on alias and phrase, the pattern written once for each column, and it accepts the seeds only", () => {
    const ddl = stmts217()[2] as string;
    expect(countOf(ddl, FOLDED_CHECK_RE), "the check pattern appears exactly twice (alias, phrase)").toBe(2);
    expect(countOf(ddl, "constraint bist_alias_blocks_folded check (alias ~ ")).toBe(1);
    expect(countOf(ddl, " and phrase ~ ")).toBe(1);
    // the constraint sits inside the one create table statement, after the primary key
    expect(ddl.indexOf("primary key (alias, phrase)")).toBeLessThan(ddl.indexOf("constraint bist_alias_blocks_folded"));
    // the same pattern, read as a JavaScript regular expression, as the CHECK reads it in Postgres
    const folded = new RegExp(FOLDED_CHECK_RE.slice(1, -1));
    for (const [alias, phrase] of SEED_BLOCKS) {
      expect(folded.test(alias), `seed alias ${alias}`).toBe(true);
      expect(folded.test(phrase), `seed phrase ${phrase}`).toBe(true);
    }
    for (const [alias, phrase] of pairsOf(stmts217()[6] as string)) {
      expect(folded.test(alias), `file alias ${alias}`).toBe(true);
      expect(folded.test(phrase), `file phrase ${phrase}`).toBe(true);
    }
    // the unfolded forms the check refuses: diacritics and capitals, a doubled space, a leading or trailing space, an empty string, punctuation
    for (const bad of ["Türkiye Sigorta Birliğinden", "turkiye  sigorta", " kardemir", "kardemir ", "", "kardemir-celik", "Kardemir"]) {
      expect(folded.test(bad), JSON.stringify(bad)).toBe(false);
    }
    // everything fold_tr itself returns is accepted (the check is the fold_tr form, no narrower)
    for (const text of ["Türkiye Sigorta Birliği", "Sümer Holding'e", "E-Data Teknoloji", "KARDEMİR  ÇELİK"]) {
      expect(folded.test(foldTr(text)), text).toBe(true);
    }
  });

  it("has RLS enabled and NO policy, no privilege for public, anon or authenticated, and select for service_role only", () => {
    const code = collapse(stripComments(codeOfText()));
    expect(code).toContain("alter table public.bist_alias_blocks enable row level security;");
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).toContain("revoke all on table public.bist_alias_blocks from public, anon, authenticated;");
    expect(code).toContain("grant select on table public.bist_alias_blocks to service_role;");
    expect(countOf(code, "grant select on table")).toBe(1);
    expect(code).not.toMatch(/grant[^;]*\sto\s+[^;]*\b(anon|authenticated|public)\b/i);
    expect(code).not.toMatch(/alter\s+default\s+privileges/i);
    // the revoke comes before the grant, both after the table exists
    expect(code.indexOf("create table")).toBeLessThan(code.indexOf("revoke all on table"));
    expect(code.indexOf("revoke all on table")).toBeLessThan(code.indexOf("grant select on table"));
  });

  it("seeds exactly three rows with on conflict do nothing: the brand alias and the longer phrase of another entity", () => {
    const seed = stmts217()[6] as string;
    expect(seed.startsWith("insert into public.bist_alias_blocks (alias, phrase) values ")).toBe(true);
    expect(seed.endsWith(" on conflict do nothing")).toBe(true);
    expect(pairsOf(seed)).toEqual(SEED_BLOCKS.map(([a, p]) => [a, p]));
  });

  it("every seeded phrase is already in fold_tr form (a-z, 0-9, single spaces) and starts with its alias as a whole word", () => {
    for (const [alias, phrase] of SEED_BLOCKS) {
      expect(foldTr(phrase), phrase).toBe(phrase);
      expect(foldTr(alias), alias).toBe(alias);
      const tokens = phrase.split(" ");
      expect(tokens.length, phrase).toBeGreaterThanOrEqual(2);
      for (const t of tokens) expect(t.length > 0 && [...t].every((c) => (c >= "a" && c <= "z") || (c >= "0" && c <= "9")), `${phrase}: ${t}`).toBe(true);
      expect(phrase.startsWith(`${alias} `), `${phrase} starts with ${alias}`).toBe(true);
    }
    // the file's own seed row text is the pinned list (no second spelling)
    const seed = pairsOf(stmts217()[6] as string);
    for (const [alias, phrase] of seed) {
      expect(foldTr(phrase), phrase).toBe(phrase);
      expect(phrase.startsWith(`${alias} `)).toBe(true);
    }
  });

  it("every seeded alias is an enabled bist_aliases row of the production fixture the live block and the dry-run use", () => {
    for (const [alias] of SEED_BLOCKS) {
      expect(PROD_ALIASES.some((a) => a.alias === alias && a.enabled !== false), alias).toBe(true);
    }
  });
});

describe("217 alias_blockers: the two manual aliases", () => {
  it("inserts ('kardemir celik','KARCL','manual') and ('e data teknoloji','EDATA','manual') with on conflict do nothing (053's precedent)", () => {
    const ins = stmts217()[7] as string;
    expect(ins.startsWith("insert into public.bist_aliases (alias, ticker, origin) values ")).toBe(true);
    expect(ins.endsWith(" on conflict do nothing")).toBe(true);
    const rows = [...ins.matchAll(/\('([^']*)', '([^']*)', '([^']*)'\)/g)].map((m) => [m[1], m[2], m[3]]);
    expect(rows).toEqual(NEW_ALIASES.map(([a, t]) => [a, t, "manual"]));
  });

  it("each new alias is in fold_tr form and is a single-row alias, so rules A and B never touch it", () => {
    for (const [alias, ticker] of NEW_ALIASES) {
      expect(foldTr(alias), alias).toBe(alias);
      expect(PROD_ALIASES.filter((a) => a.alias === alias), `${alias} is new: production has no row`).toEqual([]);
      expect(ticker).toMatch(/^[A-Z]{4,6}$/);
    }
    // 'kardemir celik' is the block phrase of 'kardemir': the long name has its own manual alias, the brand alias loses the match
    expect(SEED_BLOCKS.some(([, phrase]) => phrase === NEW_ALIASES[0]?.[0])).toBe(true);
  });
});

describe("217 alias_blockers: the body it was built from", () => {
  it("178's function body is the pinned text: md5 and length (production's resolver, read-only, 2026-11-15)", () => {
    expect(md5(body178)).toBe(BODY_178_MD5);
    expect([...body178].length).toBe(BODY_178_LENGTH);
  });

  it("the header records production's fingerprint (178's body), the attributes and the ACL", () => {
    const h = flat(head217());
    expect(h).toContain("STEP 0");
    expect(h).toContain(`md5 ${BODY_178_MD5}`);
    expect(h).toContain(`length ${BODY_178_LENGTH}`);
    expect(h).toContain("pg_get_functiondef");
    expect(h).toContain("{postgres=X/postgres,service_role=X/postgres}");
    expect(h).toContain("prosecdef f");
    expect(h).toContain("equals the md5 of 178's body");
  });
});

describe("217 alias_blockers: derive-and-compare against 178", () => {
  const derive = (b: string): string => b.replace(EDIT_A_NEW, EDIT_A_OLD).replace(EDIT_B, "");

  it("edit (a) occurs exactly once: alias_matches' select list gains r.folded, and nothing else carries it", () => {
    const b = resolver217();
    expect(countOf(b, EDIT_A_NEW)).toBe(1);
    expect(countOf(b, "r.folded")).toBe(countOf(body178, "r.folded") + 1);
    const seg = b.slice(b.indexOf("alias_matches as materialized ("), b.indexOf("alias_hits as ("));
    expect(seg).toContain("select r.id as article_id, al.alias, al.ticker, al.origin,\n           r.published_at, r.source_id, r.folded\n    from ctx r");
    expect(countOf(body178, EDIT_A_NEW)).toBe(0);
  });

  it("edit (b) occurs exactly once: rule C is the last predicate of alias_hits' WHERE, after rule B, before code_hits", () => {
    const b = resolver217();
    expect(countOf(b, EDIT_B)).toBe(1);
    expect(countOf(b, "bist_alias_blocks")).toBe(1);
    expect(countOf(body178, "bist_alias_blocks")).toBe(0);
    const hits = b.slice(b.indexOf("alias_hits as ("), b.indexOf("code_hits as ("));
    expect(hits).toContain(`${RULE_B_LAST_LINE}${EDIT_B}\n  ),`);
    const matches = b.slice(b.indexOf("alias_matches as materialized ("), b.indexOf("alias_hits as ("));
    expect(matches).not.toContain("bist_alias_blocks");
    expect(b.indexOf(EDIT_B)).toBeLessThan(b.indexOf("code_hits as ("));
  });

  it("removing the two edits gives 178's body, byte for byte", () => {
    expect(derive(resolver217())).toBe(body178);
  });

  it("the derivation notices a change anywhere else: an edit outside the two breaks the equality", () => {
    const tampered = resolver217().replace("on conflict do nothing", "on conflict do nothing /* x */");
    expect(tampered).not.toBe(resolver217());
    expect(derive(tampered)).not.toBe(body178);
    const widened = resolver217().replace(" (holding|hisse", " (holding|bank|hisse");
    expect(derive(widened)).not.toBe(body178);
    const loosened = resolver217().replace("not public.is_retail_catalog(a.title)", "true");
    expect(derive(loosened)).not.toBe(body178);
    // and a body that still carries one of the two edits is not 178's
    expect(resolver217().replace(EDIT_B, "")).not.toBe(body178);
    expect(resolver217().replace(EDIT_A_NEW, EDIT_A_OLD)).not.toBe(body178);
  });

  it("alias_matches stays MATERIALIZED, so rule C runs only on the rows that already matched the text (171's cost rule)", () => {
    const b = resolver217();
    expect(countOf(b, "alias_matches as materialized (")).toBe(1);
    expect(b.indexOf("alias_matches as materialized (")).toBeLessThan(b.indexOf("alias_hits as ("));
    // rule C reads alias_matches' own columns (al.alias, al.folded), never a join ON clause
    expect(b.slice(b.indexOf("alias_matches as materialized ("), b.indexOf("alias_hits as ("))).not.toContain("not exists");
  });

  it("rules A and B, code_hits, the stoplist gate, the retail-catalog gate and the insert are 178's, unchanged", () => {
    const b = resolver217();
    const seg = (x: string, from: string, to: string): string => x.slice(x.indexOf(from), x.indexOf(to));
    expect(seg(b, "code_hits as (", "  hits as (")).toBe(seg(body178, "code_hits as (", "  hits as ("));
    expect(b.slice(b.indexOf("  hits as ("))).toBe(body178.slice(body178.indexOf("  hits as (")));
    expect(seg(b, "with recent as (", "  alias_matches as materialized (")).toBe(seg(body178, "with recent as (", "  alias_matches as materialized ("));
    expect(b).toContain("and not public.is_retail_catalog(a.title)");
    expect(b).toContain("where c.ticker <> all (public.ticker_code_stoplist())");
  });

  it("every relation and function in the body is schema-qualified (search_path is empty), the new subquery included", () => {
    const code = stripComments(resolver217());
    const rels = [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string);
    for (const rel of rels) {
      expect(rel, `unqualified relation ${rel}`).toMatch(/^(public\.|pg_catalog\.|recent$|ctx$|alias_matches$|alias_hits$|code_hits$|hits$|lateral$)/);
    }
    expect(countOf(collapse(code), "from public.bist_alias_blocks")).toBe(1);
  });
});

describe("217 alias_blockers: the resolver keeps 178's signature, security mode, search_path and grants", () => {
  const hdr = (sql: string): string => {
    const code = codeOfText(sql);
    const at = code.indexOf(RESOLVER_MARKER);
    return collapse(code.slice(at, code.indexOf("$$", at) + 2));
  };

  it("is security invoker, volatile, an empty search_path, the same header as 178", () => {
    expect(hdr(sql217)).toBe(
      "create or replace function public.resolve_article_tickers_for(p_ids uuid[]) returns integer language plpgsql set search_path = '' as $$",
    );
    expect(hdr(sql217)).toBe(hdr(sql178));
    expect(hdr(sql217)).not.toMatch(/security\s+definer/i);
  });

  it("revokes from public, anon and authenticated and grants execute to service_role only, once each", () => {
    const code = stripComments(codeOfText());
    expect(countOf(code, `revoke all on function ${FN_SIG} from public, anon, authenticated;`)).toBe(1);
    expect(countOf(code, `grant execute on function ${FN_SIG} to service_role;`)).toBe(1);
    expect(code).not.toMatch(/grant[^;]*function[^;]*\sto\s+[^;]*\b(anon|authenticated|public)\b/i);
  });
});

describe("217 alias_blockers: additive, nothing existing is written", () => {
  it("has no delete, update, truncate, drop, copy, alter function or index, no other create, no cron, no backfill call", () => {
    const code = stripComments(codeOfText());
    for (const re of [
      /\bdelete\s+from\b/i,
      /\bupdate\s+(public\.|set\b)/i,
      /\btruncate\b/i,
      /\bdrop\s+/i,
      /\bcopy\b/i,
      /\balter\s+(function|index|role|default)/i,
      /\bcreate\s+(index|unique|trigger|extension|view|policy|schema)\b/i,
      /cron\.schedule/i,
    ]) {
      expect(code, String(re)).not.toMatch(re);
    }
    expect(countOf(collapse(code), "create table")).toBe(1);
    expect(countOf(collapse(code), "create or replace function")).toBe(1);
    // no top-level re-resolve: the resolver is only defined, never called, outside its own definition
    const st = stmts217();
    expect(st.filter((s) => /^select\b/i.test(s))).toEqual([]);
    expect(st.filter((s) => s.toLowerCase().includes("public.article_tickers"))).toEqual([]);
  });

  it("the only writes are the three seed rows, the two alias rows, the resolver's own insert into article_tickers and the ledger", () => {
    const code = stripComments(codeOfText());
    const inserts = [...code.matchAll(/insert\s+into\s+([a-z_][\w.]*)/gi)].map((m) => m[1]);
    expect(inserts).toEqual([
      "public.bist_alias_blocks",
      "public.bist_aliases",
      "public.article_tickers",
      "supabase_migrations.schema_migrations",
    ]);
    // every top-level insert tolerates a re-apply
    for (const s of stmts217().filter((x) => /^insert\b/i.test(x))) expect(s.endsWith("on conflict do nothing"), s).toBe(true);
  });

  it("does not touch bist_companies, the stoplist, the finance regex or any other alias row", () => {
    const code = collapse(stripComments(codeOfText()));
    expect(code).not.toMatch(/(insert\s+into|update|delete\s+from)\s+public\.bist_companies/i);
    expect(code).not.toMatch(/create\s+(or\s+replace\s+)?function\s+public\.(ticker_code_stoplist|finance_context_regex|fold_tr|is_retail_catalog)/i);
    expect(code).not.toContain("enabled = false");
    expect(countOf(code, "insert into public.bist_aliases")).toBe(1);
  });
});

describe("217 alias_blockers: the header", () => {
  it("names the evidence: the three collisions, the Habertürk article, the Jev blind spot", () => {
    const h = flat(head217());
    expect(head217().startsWith("-- 217_alias_blockers.sql")).toBe(true);
    for (const word of [
      "h198-ekonomi-1",
      "KRDMD",
      "KARCL",
      "EDATA",
      "SMRVA",
      "TURSG",
      "GRTHO",
      "kardemir celik",
      "Sümer Holding",
      "Türkiye Sigorta Birliği",
      "775f4b48",
      "0.94",
      "alias_matches",
      "alias_hits",
      "bist_alias_blocks",
      "MATERIALIZED",
      "171",
      "178",
    ]) {
      expect(h, word).toContain(word);
    }
    expect(h).toContain("kardemir gives KRDMD only (KRDMA, KRDMB and KARCL drop; this is expected)");
  });

  it("states rule C, the two edits and that 178's body minus them is byte for byte", () => {
    const h = flat(head217());
    expect(h).toContain("THE RULE");
    expect(h).toContain("(C)");
    expect(h).toContain("exactly two edits");
    expect(h).toContain("`r.folded`");
    expect(h).toContain("and not exists (select 1 from public.bist_alias_blocks b where b.alias = al.alias and pg_catalog.strpos(al.folded, ' ' || b.phrase || ' ') > 0)");
    expect(h).toContain("byte for byte");
  });

  it("records the NUMBER: 217 is free, 197 and 202 are held on branches", () => {
    const h = flat(head217());
    expect(h).toContain("NUMBER");
    expect(h).toContain("197");
    expect(h).toContain("202");
    expect(h).toContain("held");
  });

  it("documents the known limit: an article naming both Kardemir and Kardemir Çelik loses the plain match, KRDMD still attaches by its code", () => {
    const h = flat(head217());
    expect(h).toContain("KNOWN LIMIT");
    expect(h).toContain("names both 'Kardemir' and 'Kardemir Çelik' loses the plain 'kardemir' match");
    expect(h).toContain("KRDMD still attaches if the text writes its code");
  });

  it("records the read-only replay: per ticker, old and new pairs, the removed and added counts, and the three spec rows", () => {
    const h = flat(head217());
    const replay = between(h, "REPLAY", "COST");
    for (const fact of [
      "2026-11-15",
      "last 30 days",
      "3,325",
      "3,284",
      "KRDMD 16 to 10",
      "KARCL 5 to 10",
      "EDATA 5 to 9",
      "SMRVA 9 to 5",
      "TURSG 165 to 125",
      "GRTHO 11 to 11",
      "KRDMD 10 rows (10 counted)",
      "SMRVA 4 (4)",
      "TURSG 60 (7)",
      "34 of 34",
      "no other ticker changes",
    ]) {
      expect(replay, fact).toContain(fact);
    }
  });

  it("records every removed and added title family, with the three sample sets the replay printed", () => {
    const h = flat(head217());
    const replay = between(h, "REPLAY", "COST");
    for (const sample of [
      "SPK'dan üç şirketin işlemleriyle ilgili suç duyurusu",
      "Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek",
      "Sigorta evi etkinliği başarıyla tamamlandı",
      "Kardemir Çelik’e DZ Bank’tan 33,7 milyon Euro’luk kredi",
      "HABAŞ",
      "COP31",
    ]) {
      expect(replay, sample).toContain(sample);
    }
  });

  it("COST: the new shape against 178's on a batch of 200 article ids, generic plan, warm, min of 3, with the numbers and why it holds", () => {
    const h = flat(head217());
    const cost = between(h, "COST", "FOUNDER-ONLY");
    for (const fact of [
      "generic plan",
      "min of 3",
      "TIMING OFF",
      "200",
      "66.668",
      "67.362",
      "1.01",
      "107.254",
      "107.485",
      "1.002",
      "1.323",
      "1.342",
      "058",
      "per-row",
      "8 s",
      "statement_timeout",
      "MATERIALIZED",
      "Nested Loop Anti Join",
    ]) {
      expect(cost, fact).toContain(fact);
    }
  });

  it("carries the FOUNDER-ONLY optional cleanup (a commented dry-run block in the dry-run file, not part of this migration)", () => {
    const h = flat(head217());
    expect(h).toContain("FOUNDER-ONLY");
    expect(h).toContain("optional");
    expect(h).toContain("data rewrite");
    expect(h).toContain("217-alias-blockers-dryrun.sql");
    expect(h).toContain("8-day");
    expect(sql217.slice(sql217.indexOf("\nbegin;")).toLowerCase()).not.toContain("delete from");
  });

  it("follow-up (b) tells the founder to write rows in fold_tr form and that the CHECK refuses any other form; the table comment says the CHECK enforces it", () => {
    const h = flat(head217());
    expect(h).toContain("Rows must be written in fold_tr form, and the CHECK bist_alias_blocks_folded refuses any other form");
    const code = sql217.slice(sql217.indexOf("\nbegin;"));
    const comment = code.slice(code.indexOf("-- public.bist_alias_blocks:"), code.indexOf("create table"));
    expect(flat(comment)).toContain("enforced by the CHECK bist_alias_blocks_folded");
    expect(flat(comment)).toContain("refused at insert instead of silently never matching");
  });

  it("ORDER: apply 217 only, no deploy-order constraint, no Next.js change", () => {
    const h = flat(head217());
    expect(h).toContain("ORDER");
    expect(h).toContain("APPLY 217");
    expect(h).toMatch(/no Next\.js change/);
    expect(h).toContain("178 must already be applied");
  });

  it("VERIFY carries the new md5 and length, the table checks, the privileges, the ledger row and the post-deploy query", () => {
    const h = flat(head217());
    const verify = h.slice(h.indexOf("VERIFY"));
    expect(verify).toContain(md5(resolver217()));
    expect(verify).toContain(`${[...resolver217()].length}`);
    expect(verify).toContain("has_function_privilege");
    expect(verify).toContain("has_table_privilege");
    expect(verify).toContain("relrowsecurity");
    expect(verify).toContain("version = '217'");
    expect(verify).toContain("'alias:kardemir'");
    expect(verify).toContain("GET /ekonomi/KARCL");
  });

  it("ROLLBACK re-creates 178's resolver FIRST, then drops the table, then removes the two alias rows and only the 217 ledger row", () => {
    const h = flat(head217());
    const rb = h.slice(h.indexOf("ROLLBACK"));
    expect(rb).toContain("178_retail_catalog_ticker_gate.sql");
    expect(rb).toContain(BODY_178_MD5);
    const at = (s: string): number => {
      const i = rb.indexOf(s);
      expect(i, s).toBeGreaterThanOrEqual(0);
      return i;
    };
    expect(at("178_retail_catalog_ticker_gate.sql")).toBeLessThan(at("drop table public.bist_alias_blocks"));
    expect(at("drop table public.bist_alias_blocks")).toBeLessThan(at("delete from public.bist_aliases"));
    expect(at("delete from public.bist_aliases")).toBeLessThan(at("delete from supabase_migrations.schema_migrations where version = '217'"));
    expect(rb).toContain("'kardemir celik'");
    expect(rb).toContain("'e data teknoloji'");
    // the file itself never spells out a delete or a drop (the header is prose)
    expect(stripComments(codeOfText())).not.toMatch(/delete\s+from|drop\s+/i);
  });
});

describe("217 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_GUIDE, "utf8");
  const section = guide.includes("\n## 217 ") ? sectionOf(guide, "217") : "";

  it("sits directly after section 216 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 217 ")).toBeGreaterThan(guide.indexOf("\n## 216 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 216 ") + 1)).toBe(guide.indexOf("\n## 217 "));
  });

  it("has Why, What, an md5 table, Replay, Cost, Order, Verify, a founder-only follow-up and Rollback", () => {
    for (const word of [
      "**Why:**",
      "**What 217 does**",
      "| md5(prosrc) | length |",
      "**Replay**",
      "**Cost**",
      "**Order:**",
      "**Verify**",
      "**FOUNDER-ONLY",
      "**Rollback:**",
    ]) {
      expect(section, word).toContain(word);
    }
    expect(section).toContain(BODY_178_MD5);
    expect(section).toContain(String(BODY_178_LENGTH));
    expect(section).toContain(md5(resolver217()));
    expect(section).toContain(String([...resolver217()].length));
  });

  it("describes the DDL with the fold_tr CHECK and the founder's rows-in-fold_tr-form rule", () => {
    expect(section).toContain(
      "`public.bist_alias_blocks (alias text not null, phrase text not null, primary key (alias, phrase), constraint bist_alias_blocks_folded check (alias and phrase in fold_tr form))`",
    );
    const fu = section.slice(section.indexOf("**FOUNDER-ONLY"), section.indexOf("**Rollback:**"));
    expect(fu).toContain("Rows must be written in fold_tr form, and the CHECK `bist_alias_blocks_folded` refuses any other form");
  });

  it("states the evidence, the rule, the table, the two aliases and the replay numbers", () => {
    for (const word of [
      "h198-ekonomi-1",
      "KARCL",
      "KRDMD",
      "EDATA",
      "SMRVA",
      "TURSG",
      "bist_alias_blocks",
      "rule C",
      "alias_matches",
      "alias_hits",
      "kardemir celik",
      "e data teknoloji",
      "'sumer holding'",
      "'turkiye sigorta birligi'",
      "3,325",
      "3,284",
      "KRDMD 10 rows",
      "SMRVA 4",
      "TURSG 60",
      "no other ticker changes",
    ]) {
      expect(section, word).toContain(word);
    }
  });

  it("records the known limit and that the old rows age out by themselves (no data rewrite in the PR)", () => {
    expect(section).toContain("names both 'Kardemir' and 'Kardemir Çelik' loses the plain 'kardemir' match");
    expect(section).toContain("KRDMD still attaches if the text writes its code");
    expect(section).toContain("8-day");
    expect(section).toContain("no update or delete");
  });

  it("Cost: the measured ratios, 1 ms an article, and why it matters (058 per-row trigger, authenticator's 8 s statement_timeout)", () => {
    const cost = between(section, "**Cost**", "**Order:**");
    for (const fact of ["66.668", "67.362", "107.254", "107.485", "1.323", "1.342", "058", "per-row", "8 s", "statement_timeout", "MATERIALIZED"]) {
      expect(cost, fact).toContain(fact);
    }
  });

  it("states the order: APPLY 217 only, no deploy-order constraint", () => {
    expect(section).toContain("APPLY 217");
    expect(section).toMatch(/no (Next\.js change|deploy)/i);
  });

  it("verifies the fingerprint, the table, the privileges, the ledger and the live effect", () => {
    for (const word of ["md5(prosrc)", "has_function_privilege", "has_table_privilege", "schema_migrations", "version = '217'", "resolve_article_tickers_for", "alias:kardemir", "/ekonomi/KARCL"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs 178's function first, then drops the table, the two alias rows and the 217 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("178_retail_catalog_ticker_gate.sql");
    expect(rb).toContain(BODY_178_MD5);
    expect(rb.indexOf("178_retail_catalog_ticker_gate.sql")).toBeLessThan(rb.indexOf("drop table public.bist_alias_blocks"));
    expect(rb).toContain("delete from supabase_migrations.schema_migrations where version = '217'");
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("217 docs/architecture.md", () => {
  const arch = readFileSync(DOC_ARCH, "utf8");
  const row = arch.split("\n").find((l) => l.startsWith("| Ticker resolve |")) ?? "";

  it("the Ticker resolve row lists the resolver's alias rules A, B and C, rule C being the blocked phrase of migration 217", () => {
    expect(row).not.toBe("");
    for (const word of ["rule A", "rule B", "rule C", "manual sibling wins", "bist_alias_blocks", "217", "171"]) {
      expect(row, word).toContain(word);
    }
    // each of the three blocked phrases, with the entity it keeps off the brand's ticker
    for (const [, phrase] of SEED_BLOCKS) expect(row, phrase).toContain(phrase);
    expect(row).toContain("KARCL");
    expect(row).toContain("EDATA");
  });

  it("keeps the row a single table row and the earlier text of the row", () => {
    expect(row.endsWith("|")).toBe(true);
    expect(row).toContain("Postgres trigger `articles_resolve_tickers` (AFTER INSERT)");
    expect(row).toContain("Migration 051 (was a 10-min cron in 049).");
    expect(countOf(arch, "| Ticker resolve |")).toBe(1);
  });
});

describe("217 live manifest and dry-run", () => {
  it("builds 217's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 217-alias-blockers.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/217-alias-blockers-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 178's state, shows the defect on 178's body, applies 217 twice, keeps a time budget and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "178-retail-catalog-ticker-gate-dryrun.sql",
      "../../../supabase/migrations/217_alias_blockers.sql",
      "../../../supabase/migrations/217_alias_blockers.sql",
    ]);
    expect(sql).toContain(BODY_178_MD5);
    expect(sql).toContain(md5(resolver217()));
    expect(sql).toContain("baseline: 178 attaches KRDMD to the SPK story that names Kardemir Çelik");
    expect(sql).toContain("baseline: 178 attaches SMRVA to a Sümer Holding story");
    expect(sql).toContain("baseline: 178 attaches TURSG to a Türkiye Sigorta Birliği story");
    // the CHECK refuses an unfolded phrase at insert (a probe inside a savepoint)
    expect(sql).toContain("insert into public.bist_alias_blocks (alias, phrase) values ('turkiye sigorta', 'Türkiye Sigorta Birliğinden')");
    expect(sql).toContain("when check_violation then");
    expect(sql).toContain("bist_alias_blocks_folded");
    expect(sql).toContain("clock_timestamp()");
    expect(sql).toContain("generate_series(1, 1000)");
    expect(sql).toContain("generate_series(1, 2000)");
    expect(sql).toContain("if v_ms > 50 then");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 217 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });

  it("the dry-run file holds the read-only replay SQL and the founder-only cleanup as commented text only", () => {
    const sql = readFileSync(DRYRUN, "utf8");
    const lines = sql.split("\n");
    // the spec's replay query, verbatim, as comments
    expect(sql).toContain("with b(alias, phrase) as (values ('kardemir','kardemir celik'),('sumer','sumer holding'),('turkiye sigorta','turkiye sigorta birligi'))");
    expect(sql).toContain("jev_shadow_predictions p on p.subject_id = t.article_id::text||':'||t.ticker and p.task = 'ticker_relevance'");
    const cleanup = lines.findIndex((l) => l.includes("FOUNDER-ONLY, NOT RUN BY THIS SCRIPT"));
    expect(cleanup).toBeGreaterThan(0);
    const block = lines.slice(cleanup, cleanup + 30);
    const deleteAt = block.findIndex((l) => l.includes("delete from public.article_tickers"));
    expect(deleteAt, "the commented delete").toBeGreaterThan(0);
    // every line of the block that carries the delete or the resolver call is a comment
    for (const l of block.filter((x) => x.includes("delete from") || x.includes("resolve_article_tickers_for"))) expect(l.startsWith("-- "), l).toBe(true);
    // no executable delete or update anywhere in the script
    const exec = lines.filter((l) => !l.trimStart().startsWith("--")).join("\n").toLowerCase();
    expect(exec).not.toContain("delete from");
    expect(exec).not.toContain("update public.");
  });
});

// ---------------------------------------------------------------------------
// Fixtures: production's rows for the aliases of the report (read-only, 2026-11-15). The two new aliases are NOT here: the migration
// inserts them.
// ---------------------------------------------------------------------------

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

const PROD_ALIASES: Alias[] = [
  { alias: "kardemir", ticker: "KRDMD", origin: "manual" },
  { alias: "kardemir", ticker: "KRDMA", origin: "auto" },
  { alias: "kardemir", ticker: "KRDMB", origin: "auto" },
  { alias: "kardemir", ticker: "KARCL", origin: "auto" },
  { alias: "sumer", ticker: "SMRVA", origin: "auto" },
  { alias: "sumer", ticker: "SMRFA", origin: "auto" },
  { alias: "turkiye sigorta", ticker: "TURSG", origin: "manual" },
  { alias: "grainturk", ticker: "GRTHO", origin: "auto" },
];
const PROD_COMPANIES: Company[] = [
  { tickers: ["KRDMA", "KRDMB", "KRDMD"], traded: true },
  { tickers: ["KARCL"], traded: true },
  { tickers: ["EDATA"], traded: true },
  { tickers: ["SMRVA"], traded: true },
  { tickers: ["SMRFA"], traded: false },
  { tickers: ["TURSG"], traded: true },
  { tickers: ["GRTHO"], traded: true },
];

const SPK_TITLE = "SPK'dan üç şirketin işlemleriyle ilgili suç duyurusu";
const SPK_DESC =
  "Sermaye Piyasası Kurulu (SPK), E-Data Teknoloji, Kardemir Çelik ve Graintürk Holding paylarındaki işlemlere ilişkin incelemeler sonucunda suç duyurusunda bulunulmasına karar verdi.";

/** The headlines of the differential: [title, description, category, 178's tickers, 217's tickers]. 178's column runs on 217's alias rows. */
const DIFFERENTIAL: Array<[string, string, string, string, string]> = [
  [SPK_TITLE, SPK_DESC, "ekonomi", "EDATA,GRTHO,KARCL,KRDMD", "EDATA,GRTHO,KARCL"],
  ["Kardemir Karabük Demir Çelik hisse bilanço beklentisi", "", "ekonomi", "KRDMD", "KRDMD"],
  ["Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek", "", "ekonomi", "SMRVA", "-"],
  ["Sümer Varlık Yönetim A.Ş. net kar açıkladı", "", "ekonomi", "SMRVA", "SMRVA"],
  ["Türkiye Sigorta Birliği (TSB) sel uyarısı yaptı", "", "ekonomi", "TURSG", "-"],
  ["Türkiye Sigorta fondan kazanç sağladı", "", "ekonomi", "TURSG", "TURSG"],
  ["Türkiye Sigorta Birliği açıklaması (TURSG) hisselerine yansıdı", "", "ekonomi", "TURSG", "TURSG"],
  ["Borsa güne yatay başladı", "", "ekonomi", "-", "-"],
  ["Kardemir ve Kardemir Çelik hisseleri yükseldi", "", "ekonomi", "KARCL,KRDMD", "KARCL"],
  ["Türkiye Sigorta Birliği'nden sel uyarısı", "", "genel", "TURSG", "-"],
];

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the real function against fixtures, on a throwaway Postgres with 085, 171, 177, 178 and 217 applied by the
// dry-run script (tests/migrations/sql/live-manifest.txt). Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("217 bist_alias_blocks and resolve_article_tickers_for against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("217", {
    ledger: ["085", "171", "177", "178", "217"],
    relations: ["public.bist_aliases", "public.bist_companies", "public.article_tickers", "public.bist_alias_blocks"],
    functions: [
      "public.resolve_article_tickers_for(uuid[])",
      "public.ticker_code_stoplist()",
      "public.fold_tr(text)",
      "public.finance_context_regex()",
      "public.is_retail_catalog(text)",
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

  const aliasRows = (aliases: Alias[]): string =>
    aliases.map((a) => `(${lit(a.alias)}, ${lit(a.ticker)}, ${lit(a.origin)}, ${a.enabled === false ? "false" : "true"})`).join(", ");
  const companyRows = (companies: Company[]): string =>
    companies.map((c) => `(array[${c.tickers.map(lit).join(", ")}]::text[], ${c.traded ? "true" : "false"})`).join(", ");

  /** The production fixture: aliases and companies of the report. */
  const FIXTURE = [
    `insert into public.bist_aliases (alias, ticker, origin, enabled) values ${aliasRows(PROD_ALIASES)};`,
    `insert into public.bist_companies (tickers, shares_traded) values ${companyRows(PROD_COMPANIES)};`,
  ].join("\n");

  /** One article through the resolver; "ticker:matched_on" pairs sorted by ticker and comma-joined ("-" for none). */
  function resolvePairs(title: string, description = "", category = "ekonomi"): string {
    const sql = [
      "begin;",
      FIXTURE,
      `insert into public.articles (id, title, description, category, published_at) values ('${ART}', ${lit(title)}, ${lit(description)}, ${lit(category)}, now());`,
      `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
      `select coalesce(string_agg(ticker || ':' || matched_on, ',' order by ticker), '-') from public.article_tickers where article_id = '${ART}';`,
      "rollback;",
    ].join("\n");
    const lines = runPsql(sql).trim().split("\n");
    return lines[lines.length - 1] as string;
  }
  const tickersOf = (pairs: string): string =>
    pairs === "-"
      ? "-"
      : pairs
          .split(",")
          .map((p) => p.slice(0, p.indexOf(":")))
          .join(",");

  it("the function that runs is the file's: md5 and length of prosrc, security invoker, volatile, empty search_path, service_role only", () => {
    const out = runPsql(
      `select md5(prosrc) || '|' || length(prosrc) || '|' || prosecdef || '|' || provolatile::text || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = '${FN_SIG}'::regprocedure;`,
    ).trim();
    const body = resolver217();
    expect(out).toBe(`${md5(body)}|${[...body].length}|false|v|{"search_path=\\"\\""}|integer|p_ids uuid[]`);
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
    expect(runPsql("select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'resolve_article_tickers_for';").trim()).toBe("1");
  });

  it("is idempotent: one 217 ledger row, three block rows, the two manual alias rows once each and no other alias row", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '217';").trim()).toBe("1");
    expect(runPsql(`select count(*) from ${TABLE};`).trim()).toBe("3");
    expect(runPsql(`select string_agg(alias || '|' || phrase, ',' order by alias) from ${TABLE};`).trim()).toBe(
      SEED_BLOCKS.map(([a, p]) => `${a}|${p}`).join(","),
    );
    expect(
      runPsql("select string_agg(alias || ':' || ticker || ':' || origin || ':' || enabled, ',' order by alias) from public.bist_aliases;").trim(),
    ).toBe("e data teknoloji:EDATA:manual:true,kardemir celik:KARCL:manual:true");
  });

  it("the table: columns, primary key (alias, phrase), RLS on with no policy, nothing for anon, authenticated or public, select for service_role", () => {
    const cols = runPsql(
      `select string_agg(attname || ':' || format_type(atttypid, atttypmod) || ':' || attnotnull, ',' order by attnum) from pg_attribute where attrelid = '${TABLE}'::regclass and attnum > 0 and not attisdropped;`,
    ).trim();
    expect(cols).toBe("alias:text:true,phrase:text:true");
    const pk = runPsql(
      `select string_agg(a.attname, ',' order by k.ord) from pg_index i cross join lateral unnest(i.indkey) with ordinality k(attnum, ord) join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum where i.indrelid = '${TABLE}'::regclass and i.indisprimary;`,
    ).trim();
    expect(pk).toBe("alias,phrase");
    expect(runPsql(`select relrowsecurity || '|' || relforcerowsecurity from pg_class where oid = '${TABLE}'::regclass;`).trim()).toBe("true|false");
    expect(runPsql(`select count(*) from pg_policy where polrelid = '${TABLE}'::regclass;`).trim()).toBe("0");
    for (const role of ["anon", "authenticated"]) {
      const any = runPsql(
        `select bool_or(has_table_privilege('${role}', '${TABLE}', p)) from unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) p;`,
      ).trim();
      expect(any, role).toBe("f");
    }
    expect(runPsql(`select has_table_privilege('service_role', '${TABLE}', 'select');`).trim()).toBe("t");
    // `public` (the pseudo-role) holds nothing either: no aclitem with an empty grantee
    expect(runPsql(`select count(*) from aclexplode((select relacl from pg_class where oid = '${TABLE}'::regclass)) where grantee = 0;`).trim()).toBe("0");
  });

  it("every seeded phrase is in fold_tr form in the database, and every seeded alias is an enabled alias row of the production fixture", () => {
    expect(runPsql(`select count(*) from ${TABLE} where public.fold_tr(phrase) <> phrase or public.fold_tr(alias) <> alias;`).trim()).toBe("0");
    expect(runPsql(`select count(*) from ${TABLE} where strpos(phrase, alias || ' ') <> 1;`).trim()).toBe("0");
    const out = runPsql(
      [
        "begin;",
        FIXTURE,
        `select count(*) from ${TABLE} b where not exists (select 1 from public.bist_aliases a where a.alias = b.alias and a.enabled);`,
        "rollback;",
      ].join("\n"),
    ).trim();
    expect(out).toBe("0");
  });

  it("(i) the SPK story naming E-Data Teknoloji, Kardemir Çelik and Graintürk Holding gives EDATA, KARCL and GRTHO, never KRDMD, KRDMA or KRDMB", () => {
    const pairs = resolvePairs(SPK_TITLE, SPK_DESC);
    expect(pairs).toBe("EDATA:alias:e data teknoloji,GRTHO:alias:grainturk,KARCL:alias:kardemir celik");
    for (const t of ["KRDMD", "KRDMA", "KRDMB"]) expect(pairs).not.toContain(t);
  });

  it("(ii) a text naming only Kardemir Karabük Demir Çelik still gives KRDMD through alias:kardemir (unchanged)", () => {
    expect(resolvePairs("Kardemir Karabük Demir Çelik hisse bilanço beklentisi")).toBe("KRDMD:alias:kardemir");
    expect(resolvePairs("Kardemir hisse bilanço beklentisi")).toBe("KRDMD:alias:kardemir");
  });

  it("(iii) 'Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek' gives no SMRVA, 'Sümer Varlık Yönetim A.Ş. ...' gives SMRVA", () => {
    expect(resolvePairs("Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek")).toBe("-");
    expect(resolvePairs("Sümer Varlık Yönetim A.Ş. net kar açıkladı")).toBe("SMRVA:alias:sumer");
  });

  it("(iv) 'Türkiye Sigorta Birliği (TSB)' gives no TURSG, 'Türkiye Sigorta fondan kazanç' gives TURSG, and a text that also writes (TURSG) still gives TURSG through code_hits", () => {
    expect(resolvePairs("Türkiye Sigorta Birliği (TSB) sel uyarısı yaptı")).toBe("-");
    expect(resolvePairs("Türkiye Sigorta fondan kazanç sağladı")).toBe("TURSG:alias:turkiye sigorta");
    expect(resolvePairs("Türkiye Sigorta Birliği açıklaması (TURSG) hisselerine yansıdı")).toBe("TURSG:code");
  });

  it("the block reads the text, not the category: a TSB story in 'genel' gives no TURSG and a Sümer Holding story in 'genel' gives none either", () => {
    expect(resolvePairs("Türkiye Sigorta Birliği'nden sel uyarısı", "", "genel")).toBe("-");
    expect(resolvePairs("Sümer Holding'e ait üç ildeki 7 taşınmaz özelleştirilecek", "", "genel")).toBe("-");
    // the manual TURSG alias keeps attaching outside finance when the text is about the insurer
    expect(resolvePairs("Türkiye Sigorta fondan kazanç sağladı", "", "genel")).toBe("TURSG:alias:turkiye sigorta");
  });

  it("known limit: a text naming both Kardemir and Kardemir Çelik loses the plain 'kardemir' match (KARCL only); writing the code (KRDMD) brings KRDMD back", () => {
    expect(tickersOf(resolvePairs("Kardemir ve Kardemir Çelik hisseleri yükseldi"))).toBe("KARCL");
    expect(tickersOf(resolvePairs("Kardemir (KRDMD) ve Kardemir Çelik hisseleri yükseldi"))).toBe("KARCL,KRDMD");
  });

  it("a blocked phrase blocks only its own alias: another alias in the same text still attaches", () => {
    // Graintürk (grainturk) sits in the SPK text next to the blocked 'kardemir celik'; TSKB-style siblings are not involved
    expect(tickersOf(resolvePairs(SPK_TITLE, SPK_DESC))).toBe("EDATA,GRTHO,KARCL");
    expect(tickersOf(resolvePairs("Sümer Holding ve Türkiye Sigorta Birliği ve Graintürk Holding hisse haberi"))).toBe("GRTHO");
  });

  it("differential: 178's body (a session copy built from 178's file) and 217's agree on every headline except the blocked pairs", () => {
    // every headline is inserted twice: ids 1xx go through 178's copy, ids 2xx through 217's function (no row is ever deleted)
    const rowsFor = (base: number): string =>
      DIFFERENTIAL.map(
        ([title, desc, cat], i) =>
          `('a0000000-0000-0000-0000-${String(base + i).padStart(12, "0")}'::uuid, ${lit(title)}, ${lit(desc)}, ${lit(cat)})`,
      ).join(", ");
    const sql = [
      "begin;",
      FIXTURE,
      `create function pg_temp.resolve_178(p_ids uuid[]) returns integer language plpgsql set search_path = '' as $f$${body178}$f$;`,
      `insert into public.articles (id, title, description, category, published_at) select id, t, d, c, now() from (values ${rowsFor(100)}) v(id, t, d, c);`,
      `insert into public.articles (id, title, description, category, published_at) select id, t, d, c, now() from (values ${rowsFor(200)}) v(id, t, d, c);`,
      "do $d$ begin perform pg_temp.resolve_178(array(select id from public.articles where id < 'a0000000-0000-0000-0000-000000000200'::uuid)); end $d$;",
      "do $d$ begin perform public.resolve_article_tickers_for(array(select id from public.articles where id >= 'a0000000-0000-0000-0000-000000000200'::uuid)); end $d$;",
      "select (right(o.id::text, 12)::int - 100) || '|' || coalesce((select string_agg(t.ticker, ',' order by t.ticker) from public.article_tickers t where t.article_id = o.id), '-') || '|' || coalesce((select string_agg(t.ticker, ',' order by t.ticker) from public.article_tickers t where t.article_id = n.id), '-') from public.articles o join public.articles n on right(n.id::text, 12)::int = right(o.id::text, 12)::int + 100 where o.id < 'a0000000-0000-0000-0000-000000000200'::uuid order by o.id;",
      "rollback;",
    ].join("\n");
    const lines = runPsql(sql).trim().split("\n");
    expect(lines).toHaveLength(DIFFERENTIAL.length);
    for (const line of lines) {
      const [i, before, after] = line.split("|");
      const c = DIFFERENTIAL[Number(i)] as [string, string, string, string, string];
      expect(before, `178 on: ${c[0]}`).toBe(c[3]);
      expect(after, `217 on: ${c[0]}`).toBe(c[4]);
    }
  });

  it("writes nothing but article_tickers: the blocks and the alias rows are as they were after the call, and a second call inserts nothing", () => {
    const out = runPsql(
      [
        "begin;",
        FIXTURE,
        `insert into public.articles (id, title, description, category, published_at) values ('${ART}', ${lit(SPK_TITLE)}, ${lit(SPK_DESC)}, 'ekonomi', now());`,
        "create temp table before_c on commit drop as select (select count(*) from public.bist_alias_blocks) b, (select count(*) from public.bist_aliases) a, (select count(*) from public.bist_companies) c;",
        `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
        `select public.resolve_article_tickers_for(array['${ART}'::uuid]);`,
        "select (select count(*) from public.bist_alias_blocks) = b and (select count(*) from public.bist_aliases) = a and (select count(*) from public.bist_companies) = c from before_c;",
        `select count(*) from public.article_tickers where article_id = '${ART}';`,
        "rollback;",
      ].join("\n"),
    )
      .trim()
      .split("\n");
    // first call inserts 3 rows (EDATA, GRTHO, KARCL), the second finds the conflicts and inserts 0
    expect(out).toEqual(["3", "0", "t", "3"]);
  });

  // The time budget needs 2,000 aliases and 2,000 companies of fixtures: one lazy psql run, in beforeAll with a CI-sized timeout.
  let budgetMs = Number.NaN;
  beforeAll(() => {
    const out = runPsql(
      [
        "begin;",
        "insert into public.bist_aliases (alias, ticker, origin, enabled) select 'zzmarka' || lpad(g::text, 4, '0'), 'ZZU' || lpad(g::text, 4, '0') || s, 'auto', true from generate_series(1, 1000) g, unnest(array['A', 'B']) s;",
        "insert into public.bist_companies (tickers, shares_traded) select array['ZZT' || lpad(g::text, 4, '0')], true from generate_series(1, 2000) g;",
        "create function pg_temp.best_ms() returns numeric language plpgsql as $f$",
        "declare v_id uuid; v_t0 timestamptz; v_ms numeric; v_best numeric := 1000000; v_n integer;",
        "begin",
        "  perform public.resolve_article_tickers_for(array[gen_random_uuid()]);",
        "  for i in 1..3 loop",
        "    insert into public.articles (id, title, description, category, published_at) values (gen_random_uuid(), 'Borsa güne yatay başladı ' || i, '', 'ekonomi', now()) returning id into v_id;",
        "    v_t0 := clock_timestamp();",
        "    v_n := public.resolve_article_tickers_for(array[v_id]);",
        "    v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;",
        "    if v_n <> 0 then raise exception 'the time-budget article matches nothing, yet % rows were inserted', v_n; end if;",
        "    v_best := least(v_best, v_ms);",
        "  end loop;",
        "  return v_best;",
        "end $f$;",
        "select round(pg_temp.best_ms(), 3);",
        "rollback;",
      ].join("\n"),
    );
    budgetMs = Number(out.trim().split("\n").pop());
  }, 120_000);

  it("time budget: one article that matches nothing, against 2,000 shared untraded auto aliases and 2,000 companies, takes under 50 ms with bist_alias_blocks present (best of 3)", () => {
    expect(Number.isFinite(budgetMs), "the timing run printed a number").toBe(true);
    expect(budgetMs).toBeLessThan(50);
  });
});

/** The executable part of a migration file (from `begin;`); defaults to 217's. */
function codeOfText(sql: string = sql217): string {
  return codeOf(sql);
}
