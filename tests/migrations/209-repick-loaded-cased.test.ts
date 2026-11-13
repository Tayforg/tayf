import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { expectLinear, rep } from "../_helpers/linear-time";
import {
  cleanHeadline,
  EXTRACTIVE_MODEL_ID,
  isAcceptableNeutral,
  loadedPenalty,
  pickNeutralTitle,
} from "../../src/lib/clusters/neutral-title";
import { LOWERCASE_PRONE_SOURCE_SLUGS } from "../../src/lib/sources/source-language";

// ---------------------------------------------------------------------------
// Contract test for migration 209 ("neutral_title_repick_loaded_cased"), h168-titles-1 and h168-titles-2 (hunt 168).
//
// Two stored titles are served as the H1 and nothing re-offers them. (1) A loaded incumbent: 49facb31 (Star's "Trump,
// katillere desteğiyle övündü: ...") and 8ab79860 (Akşam's "... ihale rantı tepkisi"): the picker now charges the epithets
// ('katil' as the label of a party, 'ihale rantı', 'rant kapısı') and replaces them with a member's own wording, but the rows
// sit at or near their stamp, so only growth offered them. (2) A machine-cased İşçi Haber title stored before #290 ('çöp31',
// 'libya ve venezuela', 'Bakan kurum'): the same.
//
// 209 re-creates public.neutral_title_repick_candidates(text, integer) with 208's body (production's: its md5 is pinned) and TWO
// added branches at the end of the outer WHERE, with no stamp condition (as 184's and 208's): (A) the stored title, cut at a
// speaker's opening quote, matches a raw-text SQL subset of the three loaded rules; (B) the stored title is the wording of an
// İşçi Haber member and one of its lower-case words is a word another member writes with a capital (not first, not behind a
// sentence end, an ordinal excepted), with six guards that keep it inside what the picker does (h169 review, db-209-B: Title Case,
// the two-title support counted per fold key, a quotation mark, no lower-case letter or a shouted run, a fold twin of an excluded
// title or of the stored one, and the veto of a lower-case word of another outlet; 8f09d48c was offered at 5, 6 and 7 members and
// kept by the re-pick on every tick). This file pins, without a database: the ledger row and the single transaction, additive-only
// SQL, 208's body is production's, that 209's body is 208's byte for byte with exactly the two added branches, the grants and the
// comment, the header's numbers, and, by running the SQL regular expressions in JavaScript on the text of the file, that the SQL
// branches never offer what the TypeScript picker keeps (the fixtures of h168-loaded.json and h168-casing.json).
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL js/redos); the
// regular expressions the port builds are the SQL literals of the file, bounded and anchored on a literal word or a lookbehind of
// one to three spaces. No test strips markup with a regular expression and none passes a string pattern to replace.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_208 = "208_neutral_title_repick_generic.sql";
const FILE_209 = "209_neutral_title_repick_loaded_cased.sql";
const MIGRATION_208 = resolve(MIGRATIONS_DIR, FILE_208);
const MIGRATION_209 = resolve(MIGRATIONS_DIR, FILE_209);
const FIXTURES = resolve(ROOT, "src", "lib", "clusters", "__fixtures__");

/** Production, read-only, 2026-11-12 ~23:00Z: md5(prosrc), length(prosrc) and the attributes of the function 209 starts from. */
const PROD_MD5 = "5105bed7a553b41a8c7b30855af4aecc";
const PROD_LENGTH = 6937;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";
/** What 209's body hashes to (computed from the file; pinned here so a stray edit shows). */
const NEW_MD5 = "cf7458daa1b7b96e750c5583693e2608";
const NEW_LENGTH = 11078;

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('209', '209_neutral_title_repick_loaded_cased') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** 208's last branch ends the OR chain; 209's two branches are appended after it, before the final order by. */
const ORDER_LINE = "   order by w.updated_at desc\n";

const sqlLiteral = (s: string): string => `'${s.split("'").join("''")}'`;

// ---------------------------------------------------------------------------
// The regular expressions of the two branches, as the SQL spells them (the literals of the file, '' unescaped).
// ---------------------------------------------------------------------------

/** The characters a Turkish word holds beyond ASCII: named in the classes so the left edge never depends on the database locale. */
const TR_LOWER = "çğıöşüâîû";
const TR_UPPER = "ÇĞİÖŞÜÂÎÛ";
/** A letter or a digit: POSIX [:alnum:] and the Turkish letters spelled out. */
const ALNUM = `[:alnum:]${TR_LOWER}${TR_UPPER}`;

// (A) the stored title cut at a speaker's opening quote ("<speaker>: '", what follows is the speaker's own wording), then a raw
//     text subset of the three loaded rules of neutral-title.ts, tested on the text as written (never on the fold: it turns 'ı' into
//     'i' and would read 'katılanlara' as 'katilanlara'). The left edge is a non-letter, non-digit as in TypeScript's L.
const QUOTE_CUT_SQL = ":\\s*[\"“'‘«].*$";
const LOADED_SQL =
  `(?:^|[^${ALNUM}])(?:` +
  "[Kk]atil(?:ler)?(?:e|i|in|ini|ine|lere|leri|lerin|lerine)?[[:space:]]+[Dd]este[kğ]" +
  "|[Kk]atil[[:space:]]+(?:rejim|devlet|ordu|hükümet|siyonist)" +
  "|[İi]hale[[:space:]]+rant" +
  "|rant[[:space:]]+kap[ıi]s)";

// (B) a lower-case word of the stored title (at least two characters, lower-case letters and digits only, not behind an apostrophe)
const LOWER_WORD_SQL = `(?:^|[^${ALNUM}'’])([a-z${TR_LOWER}][a-z${TR_LOWER}0-9]+)(?![${ALNUM}])`;
//     and a word another member writes with a capital: it follows a token that does not end a sentence ('.', ':', '!', '?' and '…'
//     end one; an ordinal of one to three digits and a dot does not) and one to three spaces, so it is never the title's first word.
const CAPITAL_WORD_SQL =
  "(?<=(?:[^[:space:].:!?…]|(?:^|[[:space:]])[0-9]{1,3}\\.)[[:space:]]{1,3})" +
  `([A-Z${TR_UPPER}][${ALNUM}]+)`;
//     A title that is Title Case adds no capital evidence (TypeScript: at least TITLE_CASE_MIN_WORDS = 4 words of three letters or more,
//     of which TITLE_CASE_SHARE = 80% start with a capital: "Siyasilerden 10 Kasım Atatürk'ü Anma Günü Mesajları"). A letters-only token
//     of three or more letters is a long word; a digit in a token takes it out, as in TypeScript.
const LONG_WORD_SQL = `(?:^|[^${ALNUM}'’])([[:alpha:]${TR_LOWER}${TR_UPPER}]{3,})(?![${ALNUM}])`;
const CAPITALISED_SQL = `^[A-Z${TR_UPPER}]`;
//     A sibling title adds no capital evidence at all when (h169 review, db-209-B) it holds a quotation mark (a span in quotes is no
//     evidence in TypeScript, and the copy a fold twin keeps may be the quoted one), when it holds no lower-case letter, or when it holds
//     a run of three shouted words (SHOUT_RUN = 3 words of SHOUT_MIN_LETTERS = 3 letters or more: its case is lost). A shouted word here is
//     a whitespace-delimited token of three or more characters with no lower-case letter before an apostrophe: a superset of TypeScript's
//     (a bare number counts), which only makes the SQL narrower.
const QUOTE_SQL = "[\"“”«»]|(?:^|[[:space:]])['‘]";
const LOWER_LETTER_SQL = `[a-z${TR_LOWER}]`;
const SHOUT_WORD_SQL = `[^[:space:]a-z${TR_LOWER}'’ʼ‘]{3,}(?:['’ʼ‘][^[:space:]]*)?`;
const SHOUT_RUN_SQL = `(?<![^[:space:]])${SHOUT_WORD_SQL}(?:[[:space:]]+${SHOUT_WORD_SQL}){2}(?![^[:space:]])`;
//     The fold key of a title: the house fold with every run of characters that are not a-z or 0-9 as one space, trimmed. Two titles with
//     one key are the same title to usableItems (it keeps one copy, newest first); the support of a word counts keys, not titles.
const KEY_SQL = "[^a-z0-9]+";
//     The veto (TypeScript: a case-trusted sibling that writes the word in lower case): a lower-case word of any member that is not
//     İşçi Haber's, not the first token of its title (a character, then one to three spaces or a hyphen, a dash or a slash).
const VETO_WORD_SQL = `(?<=[^[:space:]](?:[[:space:]]{1,3}|[-–—/]))([a-z${TR_LOWER}][a-z${TR_LOWER}0-9]+)(?![${ALNUM}])`;
/** A cluster of this many members or more asks two other titles for a word (TypeScript: LENIENT_CORROBORATION_OTHERS + 1, LENIENT_MIN_TITLES). */
const CORROBORATION_MEMBERS = 5;
const MIN_TITLES = 2;
/** The İşçi Haber check reads the outlet's articles of this many days (one hashed scan of about five thousand rows, not a probe per cluster). */
const ISCI_WINDOW_DAYS = 15;
const SLUG = "isci-haber";

/** Branch A of the file, whitespace collapsed. */
const BRANCH_A =
  `or pg_catalog.regexp_replace(w.title_tr_neutral, ${sqlLiteral(QUOTE_CUT_SQL)}, '') ~ ${sqlLiteral(LOADED_SQL)}`;
/** The fold key of a title, as the file spells it (the member's title cut at a thousand characters, `t`). */
const KEY_EXPR = (t: string): string =>
  `pg_catalog.btrim(pg_catalog.regexp_replace(public.tayf_search_fold(${t}), ${sqlLiteral(KEY_SQL)}, ' ', 'g'))`;
/**
 * Branch B of the file, whitespace collapsed. The İşçi Haber check (one hashed set of the outlet's last fifteen days: cluster and
 * title) comes first and the word scan only runs on its rows. The folded words of the stored title are joined to the folded capital
 * words of the other members' titles, counted per word over the distinct fold keys of the titles that write them: a title with a
 * quotation mark, with no lower-case letter or with a shouted run is no evidence, and neither is a title whose key is that of one
 * of those or of the stored title. A word that a member of another outlet writes in lower case is vetoed.
 */
const BRANCH_B =
  "or ((w.id, pg_catalog.btrim(w.title_tr_neutral)) in (select ci.cluster_id, pg_catalog.btrim(ai.title) " +
  "from public.sources si join public.articles ai on ai.source_id = si.id " +
  "join public.cluster_articles ci on ci.article_id = ai.id " +
  `where si.slug = ${sqlLiteral(SLUG)} and ai.published_at > pg_catalog.now() - interval '${ISCI_WINDOW_DAYS} days') ` +
  "and exists (select 1 from (select public.tayf_search_fold((lm.m)[1]) as f from " +
  `pg_catalog.regexp_matches(pg_catalog.left(w.title_tr_neutral, 1000), ${sqlLiteral(LOWER_WORD_SQL)}, 'g') lm(m)) lw ` +
  "join (select cx.f, pg_catalog.count(distinct cx.k) as n from (select kx.k, public.tayf_search_fold((cm.m)[1]) as f " +
  "from (select ky.t, ky.k, pg_catalog.bool_or(ky.x) over (partition by ky.k) as xk " +
  `from (select lt.t, ${KEY_EXPR("lt.t")} as k, ` +
  `(lt.t ~ ${sqlLiteral(QUOTE_SQL)} or lt.t !~ ${sqlLiteral(LOWER_LETTER_SQL)} or lt.t ~ ${sqlLiteral(SHOUT_RUN_SQL)}) as x ` +
  "from public.cluster_articles cj join public.articles aj on aj.id = cj.article_id " +
  "cross join lateral (select pg_catalog.left(aj.title, 1000) as t) lt where cj.cluster_id = w.id) ky) kx " +
  "cross join lateral (select pg_catalog.count(*) as longs, " +
  `pg_catalog.count(*) filter (where (lg.m)[1] ~ ${sqlLiteral(CAPITALISED_SQL)}) as caps from ` +
  `pg_catalog.regexp_matches(kx.t, ${sqlLiteral(LONG_WORD_SQL)}, 'g') lg(m)) tc ` +
  `cross join lateral pg_catalog.regexp_matches(kx.t, ${sqlLiteral(CAPITAL_WORD_SQL)}, 'g') cm(m) ` +
  `where not kx.xk and kx.k <> ${KEY_EXPR("pg_catalog.left(w.title_tr_neutral, 1000)")} ` +
  "and not (tc.longs >= 4 and tc.caps * 5 >= tc.longs * 4)) cx group by cx.f) cw on cw.f = lw.f " +
  `where cw.n >= case when (select pg_catalog.count(*) from public.cluster_articles ck where ck.cluster_id = w.id) >= ${CORROBORATION_MEMBERS} ` +
  `then ${MIN_TITLES} else 1 end ` +
  "and not exists (select 1 from public.cluster_articles cv join public.articles av on av.id = cv.article_id " +
  "join public.sources sv on sv.id = av.source_id cross join lateral " +
  `pg_catalog.regexp_matches(pg_catalog.left(av.title, 1000), ${sqlLiteral(VETO_WORD_SQL)}, 'g') vm(m) ` +
  `where cv.cluster_id = w.id and sv.slug <> ${sqlLiteral(SLUG)} and public.tayf_search_fold((vm.m)[1]) = lw.f)))`;

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

/** Whitespace runs to one space, the space inside a parenthesis dropped. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replaceAll("( ", "(").replaceAll(" )", ")").trim();
}

/** Comment block read as prose: `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replaceAll(/\n--\s*/g, " ").replace(/\s+/g, " ");
}

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two $fn$ markers: Postgres' prosrc. Comments in the file header are not part of it. */
function functionBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  expect(open, "an opening $fn$").toBeGreaterThanOrEqual(0);
  expect(close, "a closing $fn$").toBeGreaterThan(open);
  return sql.slice(open + 4, close);
}

/** `create or replace function ... as ` up to and including the opening $fn$ marker. */
function functionHeader(sql: string): string {
  // The statement starts a line (the header comments say "create or replace function" in prose too).
  const at = sql.indexOf("\ncreate or replace function");
  const open = sql.indexOf("$fn$", at);
  expect(at, "create or replace function").toBeGreaterThanOrEqual(0);
  return sql.slice(at + 1, open + 4);
}

/** Top-level statements: split on ';' outside single-quoted strings, `--` comments and $fn$ bodies; comments dropped. */
function splitStatements(code: string): string[] {
  const out: string[] = [];
  let cur = "";
  let i = 0;
  while (i < code.length) {
    const ch = code.charAt(i);
    if (code.startsWith("--", i)) {
      const newline = code.indexOf("\n", i);
      i = newline === -1 ? code.length : newline;
    } else if (code.startsWith("$fn$", i)) {
      const close = code.indexOf("$fn$", i + 4);
      const stop = close === -1 ? code.length : close + 4;
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

/** Statements with the $fn$ body replaced by a marker and whitespace collapsed. */
function statements(code: string): string[] {
  return splitStatements(code).map((stmt) => {
    const open = stmt.indexOf("$fn$");
    const close = open === -1 ? -1 : stmt.indexOf("$fn$", open + 4);
    const shown = open !== -1 && close !== -1 ? `${stmt.slice(0, open)}$fn$ body $fn$${stmt.slice(close + 4)}` : stmt;
    return collapse(shown);
  });
}

function statementStartingWith(code: string, prefix: string): string {
  const found = statements(code).find((stmt) => stmt.toLowerCase().startsWith(prefix));
  if (found === undefined) throw new Error(`no statement starting with "${prefix}"`);
  return found;
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

const sql208 = readFileSync(MIGRATION_208, "utf8");
const body208 = functionBody(sql208);
const sql209 = existsSync(MIGRATION_209) ? readFileSync(MIGRATION_209, "utf8") : "";
const header209 = (): string => {
  expect(existsSync(MIGRATION_209), `${FILE_209} must exist`).toBe(true);
  return sql209.split("\nbegin;")[0] as string;
};
const body209 = (): string => {
  expect(existsSync(MIGRATION_209), `${FILE_209} must exist`).toBe(true);
  return functionBody(sql209);
};

/** 209's body with the added branches cut out: the lines between 208's last branch and the final order by. */
function bodyWithoutBranches(body: string): { rest: string; added: string } {
  const from = body208.lastIndexOf(ORDER_LINE);
  expect(from, "208's final order by").toBeGreaterThan(0);
  const at = body.lastIndexOf(ORDER_LINE);
  expect(at, "the final order by follows the new branches").toBeGreaterThanOrEqual(from);
  return { rest: body.slice(0, from) + body.slice(at), added: body.slice(from, at) };
}

describe("209 neutral_title_repick_loaded_cased: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 209", () => {
    expect(existsSync(MIGRATION_209)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("209_"))).toEqual([FILE_209]);
  });

  it("sits after 208 and leaves it alone (208 is the rollback target)", () => {
    expect(existsSync(MIGRATION_208)).toBe(true);
    expect(body208).toContain("tayf_search_fold(w.title_tr_neutral)");
    expect(body208).not.toContain("isci-haber");
    expect(body208).not.toContain("katil");
  });

  it("runs in one transaction with the lock and statement timeouts, and records its ledger row", () => {
    const code = stripComments(sql209);
    const stmts = statements(code);
    expect(stmts[0]).toBe("begin");
    expect(stmts.at(-1)).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
    expect(stmts).toContain(LEDGER_STMT.slice(0, -1));
    expect(countOf(code, "begin;")).toBe(1);
    expect(countOf(code, "commit;")).toBe(1);
    expect(countOf(code, "schema_migrations")).toBe(1);
  });

  it("is additive only: one function re-created, a comment, the grants and the ledger insert; nothing else is written", () => {
    const stmts = statements(stripComments(sql209));
    expect(stmts).toHaveLength(10);
    const heads = stmts.map((s) => s.split(" ").slice(0, 3).join(" ").toLowerCase());
    expect(heads).toEqual([
      "begin",
      "set local lock_timeout",
      "set local statement_timeout",
      "create or replace",
      "comment on function",
      "revoke all on",
      "grant execute on",
      "notify pgrst, 'reload",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ]);
    const code = sansStrings(stripComments(sql209).split("$fn$").filter((_, i) => i % 2 === 0).join(" "));
    for (const forbidden of [
      "alter table",
      "create table",
      "drop ",
      "create index",
      "create trigger",
      "update ",
      "delete ",
      "truncate",
      "grant select",
      "grant all",
    ]) {
      expect(code.toLowerCase(), forbidden).not.toContain(forbidden);
    }
    // The function body only reads.
    const fnBody = sansStrings(body209()).toLowerCase();
    for (const write of ["insert ", "update ", "delete ", "truncate", "alter ", "create ", "drop "]) {
      expect(fnBody, write).not.toContain(write);
    }
  });

  it("does not bump the model and does not touch the cron", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
    expect(sql209).not.toContain("extractive-v7");
    expect(sql209).not.toContain("cron.schedule");
  });
});

describe("209 neutral_title_repick_loaded_cased: the body", () => {
  it("208's body is production's: its md5 and length are the ones read on production", () => {
    expect(md5(body208)).toBe(PROD_MD5);
    expect(body208.length).toBe(PROD_LENGTH);
  });

  it("is 208's body byte for byte with exactly the two added branches, after 208's last branch and before the order by", () => {
    const { rest, added } = bodyWithoutBranches(body209());
    expect(rest).toBe(body208);
    expect(collapse(added)).toBe(`${BRANCH_A} ${BRANCH_B}`);
    // Each branch is one alternative of the OR chain, opened by 'or', with no stamp condition.
    expect(added.trimStart().startsWith("or ")).toBe(true);
    expect(countOf(`\n${added}`, "\n      or ")).toBe(2);
    expect(added).not.toContain("title_neutral_member_count");
    expect(added).not.toContain("article_count");
    expect(added).not.toContain("title_neutral_model");
  });

  it("has the pinned fingerprint", () => {
    expect(md5(body209())).toBe(NEW_MD5);
    expect(body209().length).toBe(NEW_LENGTH);
  });

  it("keeps the signature, volatility, security definer and search_path of 208", () => {
    expect(functionHeader(sql209)).toBe(functionHeader(sql208));
    expect(collapse(functionHeader(sql209))).toBe(
      "create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20) " +
        "returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint) " +
        "language sql stable security definer set search_path = '' as $fn$",
    );
  });

  it("qualifies every function it calls (search_path is empty) and names the house fold of 129", () => {
    const added = bodyWithoutBranches(body209()).added;
    // tayf_search_fold: the stored title's words, the capital words, the two fold keys (a member's, the stored title's) and the veto.
    expect(countOf(added, "public.tayf_search_fold(")).toBe(5);
    expect(countOf(added, "pg_catalog.regexp_replace(")).toBe(3);
    expect(countOf(added, "pg_catalog.regexp_matches(")).toBe(4);
    expect(countOf(added, "pg_catalog.left(")).toBe(4);
    expect(countOf(added, "pg_catalog.btrim(")).toBe(4);
    expect(countOf(added, "pg_catalog.count(")).toBe(4);
    expect(countOf(added, "pg_catalog.now()")).toBe(1);
    expect(countOf(added, "pg_catalog.bool_or(")).toBe(1);
    // No call is left bare: every one of them is the qualified one, and nothing else is called.
    expect(countOf(added, "tayf_search_fold(")).toBe(countOf(added, "public.tayf_search_fold("));
    for (const fn of ["regexp_replace(", "regexp_matches(", "btrim(", "left(", "count(", "now(", "bool_or("]) {
      expect(countOf(added, fn), fn).toBe(countOf(added, `pg_catalog.${fn}`));
    }
    for (const fn of ["lower(", "translate(", "char_length(", "substr(", "strpos(", "chr(", "length(", "coalesce(", "string_agg("]) {
      expect(countOf(sansStrings(added), fn), fn).toBe(0);
    }
    expect(added).not.toContain("~*");
  });

  it("reads the title as written for the loaded branch (never the fold) and the fold for the casing branch", () => {
    const { added } = bodyWithoutBranches(body209());
    const loaded = added.slice(0, added.indexOf("or ((w.id"));
    expect(loaded).not.toContain("tayf_search_fold");
    // The speaker-quote cut is the one place that reads quotation marks of the raw title.
    expect(loaded).toContain(sqlLiteral(QUOTE_CUT_SQL));
    // 'ı' and 'ğ' are in the regular expression: the dotless ı of every 'katıl-' word is a different letter.
    expect(LOADED_SQL).toContain("kap[ıi]s");
    expect(LOADED_SQL).toContain("[Dd]este[kğ]");
    expect(LOADED_SQL).not.toContain("[Kk]atıl");
  });

  it("the slug literal of the casing branch is the one LOWERCASE_PRONE_SOURCE_SLUGS holds", () => {
    expect([...LOWERCASE_PRONE_SOURCE_SLUGS]).toEqual([SLUG]);
    const added = bodyWithoutBranches(body209()).added;
    const at = added.indexOf("si.slug = '");
    expect(at).toBeGreaterThan(0);
    const start = at + "si.slug = '".length;
    expect(added.slice(start, added.indexOf("'", start))).toBe([...LOWERCASE_PRONE_SOURCE_SLUGS][0]);
    expect(countOf(added, "si.slug")).toBe(1);
    // The veto reads the other outlets' titles: every member whose slug is not that one.
    expect(countOf(added, "sv.slug <> 'isci-haber'")).toBe(1);
    expect(countOf(added, "sv.slug")).toBe(1);
  });

  it("every repeat is bounded or runs over disjoint classes", () => {
    // Loaded rule: bounded alternations and one run of spaces between two literals.
    expect(LOADED_SQL).not.toContain(".*");
    expect(LOADED_SQL).not.toContain("+)+");
    expect(LOADED_SQL).not.toContain("*)*");
    // Casing rule: words are one class under + (the class stops at the next non-letter), the lookbehind holds one to three spaces.
    expect(CAPITAL_WORD_SQL).toContain("{1,3}");
    for (const re of [CAPITAL_WORD_SQL, LOWER_WORD_SQL, LONG_WORD_SQL]) {
      expect(re).not.toContain(".*");
      expect(re).not.toContain("+)+");
      expect(re).not.toContain("*)*");
    }
    // The new rules: the quote, the shout and the veto regular expressions have no unbounded group repeat either. The shouted word is one
    // class under {3,} and an optional tail; a run is three of them; every token starts at a space edge (lookbehind), so the scan is linear.
    for (const re of [QUOTE_SQL, SHOUT_RUN_SQL, VETO_WORD_SQL, KEY_SQL]) {
      expect(re).not.toContain(".*");
      expect(re).not.toContain("+)+");
      expect(re).not.toContain("*)*");
    }
    expect(VETO_WORD_SQL).toContain("{1,3}");
    // The title is read to its first thousand characters (TypeScript's EVIDENCE_MAX_CHARS) on both sides, in the Title Case count, the
    // fold key, the veto and the quote, shout and lower-case checks (all of them read the cut title `t`).
    expect(countOf(bodyWithoutBranches(body209()).added, ", 1000)")).toBe(4);
  });
});

describe("209 neutral_title_repick_loaded_cased: grants, comment and header", () => {
  it("restates the revoke and the grant, so the ACL stays service_role only", () => {
    const stmts = statements(stripComments(sql209));
    expect(stmts).toContain(REVOKE_STMT.slice(0, -1));
    expect(stmts).toContain(GRANT_STMT.slice(0, -1));
    const code = stripComments(sql209);
    expect(code).not.toContain("to anon");
    expect(code).not.toContain("to authenticated");
    expect(code).not.toContain("to public");
    expect(PROD_PROACL).toBe("{postgres=X/postgres,service_role=X/postgres}");
  });

  it("comments the function with the migration list and both new rules", () => {
    const comment = statementStartingWith(stripComments(sql209), "comment on function");
    expect(comment).toContain(`comment on function ${FN_SIG} is`);
    expect(comment.endsWith("Migrations 141, 155, 162, 169, 184, 200, 208, 209.'")).toBe(true);
    expect(comment).toContain("at any stamp");
    expect(comment).toContain("katil");
    expect(comment).toContain("ihale");
    expect(comment).toContain("İşçi Haber");
    expect(comment).toContain("capital");
  });
});

describe("209 neutral_title_repick_loaded_cased: the header documents the rule, the measurements and the release", () => {
  it("documents WHY, THE RULE, STEP 0, REPLAY, THE RESIDUE, THE COST, THE DRAIN, RELEASE ORDER, VERIFY and ROLLBACK", () => {
    const head = flat(header209());
    for (const marker of [
      "WHY",
      "THE RULE",
      "STEP 0",
      "REPLAY",
      "THE RESIDUE",
      "THE COST",
      "THE DRAIN",
      "RELEASE ORDER",
      "VERIFY",
      "ROLLBACK",
    ]) {
      expect(head, marker).toContain(marker);
    }
    expect(head).toContain(PROD_MD5);
    expect(head).toContain(String(PROD_LENGTH));
    expect(head).toContain(NEW_MD5);
    expect(head).toContain(String(NEW_LENGTH));
    expect(head).toContain("DEPLOY the app FIRST");
    expect(head).toContain("The migration is not applied by the PR");
    expect(head).toContain("Safe to re-apply");
    for (const id of [
      "49facb31-1ba4-4816-a679-e6bff7a03c4f",
      "8ab79860-9f6e-414d-acdf-082dc7ff4194",
      "3039d877-3c4a-4132-8ff9-766faf030cc3",
      "0834c3ba-8291-4bac-8d8e-9a81cbbcf364",
    ]) {
      expect(head, id).toContain(id);
    }
  });

  it("says what the two branches read and what keeps SQL inside the picker", () => {
    const head = flat(header209());
    for (const phrase of [
      "[kğ]",
      "'desteğiyle'",
      "SUBSET of the loadedPenalty verdict",
      "never on public.tayf_search_fold",
      "LOWERCASE_PRONE_SOURCE_SLUGS",
      "last fifteen days",
      "an ordinal of one to three digits and a dot is no end",
      "Title Case",
      "LENIENT_MIN_TITLES",
      "EVIDENCE_MAX_CHARS",
      "ONE migration carries both branches",
      // h169 review (db-209-B): the six guards and what they mirror
      "Six guards keep SQL inside what the picker does",
      "distinct FOLD KEYS",
      "holds a quotation mark",
      "SHOUT_RUN = 3",
      "SHOUT_MIN_LETTERS = 3",
      "is the stored title to usableItems",
      "the veto",
      "8f09d48c",
    ]) {
      expect(head, phrase).toContain(phrase);
    }
  });

  it("states the measurements it made: the replay, the residue against its limit, the cost", () => {
    const head = flat(header209());
    // The first form of B, measured 2026-11-12 on the 1,408 clusters, and the body after the h169 review, measured 2026-11-13.
    expect(head).toContain("1,408 clusters");
    expect(head).toContain("offered 15 rows that 208's body does not (A 2, B 13)");
    expect(head).toContain("234 titles");
    expect(head).toContain("0 disagreements");
    expect(head).toContain("the first form of 209 offered 19 (the 17 new: A 2 and B 15); the body of this file offers 18: the 16 new are A 2 and B 14");
    expect(head).toContain("changes all 16 and keeps none (the residue, limit 3: 0)");
    expect(head).toContain("0 of 16 (limit 3)");
    expect(head).toContain("25 substitutions, 19 offered by the SQL, 0 kept by the picker (limit 3)");
    expect(head).toContain("255.1, 252.7 and 259.8 ms (shared hit 23,864)");
    expect(head).toContain("350.3, 351.1 and 359.5 ms (shared hit 46,968)");
    expect(head).toContain("403.5, 388.6 and 399.1 ms (shared hit 47,909)");
    expect(head).toContain("251.0, 286.0 and 286.0 ms");
    expect(head).toContain("branch A alone add about 25 ms");
    expect(head).toContain("branch B alone about 75 ms");
    // Every row of the replay is listed with its old and its new title (8541cbe6 is no longer offered: see 'Not offered').
    for (const cid of ["49facb31", "8ab79860", "3039d877", "0834c3ba", "609f9e22", "4797e4f6", "ecbc23a0", "3175d6f7", "588c58ce", "2040cdf1", "37915ace", "441ea6a3", "2490109a", "23b4563e", "ad976c62", "cdc9adfb"]) {
      expect(head, cid).toContain(`${cid} "`);
    }
    // (the WHY names it among the rows of the finding; the replay lists only what the branches offer now)
    const from = head.indexOf("REPLAY (production");
    const replay = head.slice(from, head.indexOf("THE RESIDUE", from));
    expect(from).toBeGreaterThan(0);
    expect(replay).toContain("49facb31");
    expect(replay).not.toContain("8541cbe6 \"");
    expect(head).toContain("8541cbe6");
    expect(head).toContain("the price of guard 3");
    expect(head).toContain("None is worse");
  });

  it("explains the deviations from the specs: the single migration, the [kğ] class and the guards the fallback asked for", () => {
    const head = flat(header209());
    expect(head).toContain("Both specs re-create this one function");
    expect(head).toContain("0792bdea and 829ef5cc would be offered without the Title Case and the two-title guards");
    expect(head).toContain("Not mirrored, because the replay shows no row that needs it: the picker's trusted-twin rule");
  });
});

// ---------------------------------------------------------------------------
// The SQL branches run in JavaScript: the house fold, the cuts and the regular expressions of the file.
// ---------------------------------------------------------------------------

/** The POSIX classes of the SQL spelling, in JavaScript's: letters and digits of any script, whitespace. */
const posixToJs = (re: string): string =>
  re.replaceAll("[:alnum:]", "\\p{L}\\p{N}").replaceAll("[:alpha:]", "\\p{L}").replaceAll("[:space:]", "\\s");

/** public.tayf_search_fold: translate('İIıŞşĞğÜüÖöÇçÂâÎîÛû' + chr(775) -> 'iiissgguuooccaaiiuu', the dot above dropped), then lower() in the C collation (ASCII only). */
const FOLD_FROM = "İIıŞşĞğÜüÖöÇçÂâÎîÛû̇";
const FOLD_TO = "iiissgguuooccaaiiuu";

function sqlFold(text: string): string {
  let out = "";
  for (const ch of text) {
    const at = FOLD_FROM.indexOf(ch);
    if (at >= 0) out += at < FOLD_TO.length ? FOLD_TO.charAt(at) : "";
    else out += ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
  }
  return out;
}

/** btrim(x): the spaces (U+0020) at both ends, nothing else. */
function btrim(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s.charAt(a) === " ") a++;
  while (b > a && s.charAt(b - 1) === " ") b--;
  return s.slice(a, b);
}

/** left(x, 1000): the first thousand characters (code points). */
const left1000 = (s: string): string => (s.length <= 1000 ? s : [...s].slice(0, 1000).join(""));

// Postgres' '.' matches a newline; the quote cut is anchored at the end.
const RE_QUOTE_CUT = new RegExp(QUOTE_CUT_SQL, "us");
const RE_LOADED = new RegExp(posixToJs(LOADED_SQL), "u");
const RE_LOWER_WORD = new RegExp(posixToJs(LOWER_WORD_SQL), "gu");
const RE_CAPITAL_WORD = new RegExp(posixToJs(CAPITAL_WORD_SQL), "gu");
const RE_LONG_WORD = new RegExp(posixToJs(LONG_WORD_SQL), "gu");
const RE_CAPITALISED = new RegExp(CAPITALISED_SQL, "u");
const RE_QUOTE = new RegExp(posixToJs(QUOTE_SQL), "u");
const RE_LOWER_LETTER = new RegExp(LOWER_LETTER_SQL, "u");
const RE_SHOUT_RUN = new RegExp(posixToJs(SHOUT_RUN_SQL), "u");
const RE_VETO_WORD = new RegExp(posixToJs(VETO_WORD_SQL), "gu");
const RE_KEY = new RegExp(KEY_SQL, "gu");

/** Branch A on a stored title, as the SQL evaluates it: cut at a speaker's opening quote, then the raw-text regular expression. */
function sqlLoaded(title: string): boolean {
  return RE_LOADED.test(title.replace(RE_QUOTE_CUT, ""));
}

interface Member {
  slug: string | null;
  title: string;
  /** How long ago the article was published, in days (the fixtures carry no date: recent). */
  daysAgo?: number;
}

/** The folded words of `text` the regular expression's first group captures. */
function foldedWords(re: RegExp, text: string): string[] {
  return [...left1000(text).matchAll(re)].map((m) => sqlFold(m[1] as string));
}

/** The title is Title Case to the SQL: at least four long words, at least 80% of them with a capital. */
function sqlTitleCase(title: string): boolean {
  const longs = [...left1000(title).matchAll(RE_LONG_WORD)].map((m) => m[1] as string);
  const caps = longs.filter((w) => RE_CAPITALISED.test(w)).length;
  return longs.length >= 4 && caps * 5 >= longs.length * 4;
}

/** The fold key of a title as the SQL computes it: the house fold of its first thousand characters, runs of other characters as one space, trimmed. */
const foldKey = (title: string): string => btrim(sqlFold(left1000(title)).replace(RE_KEY, " "));

/** A title that is no capital evidence by itself: a quotation mark, no lower-case letter, or a run of three shouted words. */
function sqlExcluded(title: string): boolean {
  const t = left1000(title);
  return RE_QUOTE.test(t) || !RE_LOWER_LETTER.test(t) || RE_SHOUT_RUN.test(t);
}

/** The words a member of another outlet writes in lower case (not as the first token of its title): the veto. */
const vetoWords = (title: string): string[] => foldedWords(RE_VETO_WORD, title);

/** Branch B on a stored title and the cluster's member titles, as the SQL evaluates it. */
function sqlCasing(stored: string, members: readonly Member[]): boolean {
  if (!members.some((m) => m.slug === SLUG && btrim(m.title) === btrim(stored) && (m.daysAgo ?? 0) < ISCI_WINDOW_DAYS)) return false;
  const storedKey = foldKey(stored);
  const rows = members.map((m) => ({ title: m.title, key: foldKey(m.title), excluded: sqlExcluded(m.title) }));
  // A fold key that any of its titles excludes is excluded for all of them (the window's bool_or over the key).
  const excludedKeys = new Set(rows.filter((r) => r.excluded).map((r) => r.key));
  // Per folded word: the distinct fold keys of the other titles (that are not Title Case) that write it with a capital.
  const keysOf = new Map<string, Set<string>>();
  for (const r of rows) {
    if (excludedKeys.has(r.key) || r.key === storedKey || sqlTitleCase(r.title)) continue;
    for (const f of foldedWords(RE_CAPITAL_WORD, r.title)) {
      const set = keysOf.get(f) ?? new Set<string>();
      set.add(r.key);
      keysOf.set(f, set);
    }
  }
  const need = members.length >= CORROBORATION_MEMBERS ? MIN_TITLES : 1;
  const vetoed = new Set(members.filter((m) => m.slug !== SLUG).flatMap((m) => vetoWords(m.title)));
  return foldedWords(RE_LOWER_WORD, stored).some((f) => (keysOf.get(f)?.size ?? 0) >= need && !vetoed.has(f));
}

interface FixtureCluster {
  cid: string;
  stored: string;
  members: Array<{ source: string; title: string; opinion: boolean }>;
}
interface Fixture {
  clusters: FixtureCluster[];
}
const readFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Fixture;
const LOADED_FIXTURE = readFixture("h168-loaded.json");
const CASING_FIXTURE = readFixture("h168-casing.json");
const H164_CASING_FIXTURE = readFixture("h164-casing.json");
const H164_GENERIC_FIXTURE = readFixture("h164-generic.json");

const asMembers = (c: FixtureCluster): Member[] => c.members.map((m) => ({ slug: m.source, title: m.title }));
const casingCluster = (cid: string): FixtureCluster => {
  const found = CASING_FIXTURE.clusters.find((c) => c.cid === cid);
  if (found === undefined) throw new Error(`h168-casing.json has no cluster ${cid}`);
  return found;
};
/** The members as the headline cron hands them to the picker: İşçi Haber's flagged `caseUnreliable`. */
const cronItems = (c: FixtureCluster) =>
  c.members.map((m) => ({
    title: m.title,
    source: m.source,
    opinion: m.opinion,
    ...(LOWERCASE_PRONE_SOURCE_SLUGS.has(m.source) ? { caseUnreliable: true } : {}),
  }));
/** The cron's re-pick call on a stored title ({ incumbent, floor: the stored title fails the gate }). */
const cronRepick = (c: FixtureCluster): string | null =>
  pickNeutralTitle(cronItems(c), {
    incumbent: c.stored,
    floor: !isAcceptableNeutral(c.stored, c.members.map((m) => m.title)),
  });

describe("209 neutral_title_repick_loaded_cased: the house fold and the helpers", () => {
  it("the house fold folds the Turkish capitals and diacritics, drops the combining dot and lowers ASCII only", () => {
    expect(sqlFold("Açıklamalar İŞÇİ Çöp31 ÂÎÛ")).toBe("aciklamalar isci cop31 aiu");
    expect(sqlFold("çöp31")).toBe(sqlFold("COP31"));
    expect(sqlFold("ÉA")).toBe("Éa");
  });

  it("btrim trims spaces only, left(x, 1000) cuts at a thousand characters", () => {
    expect(btrim("  a b  ")).toBe("a b");
    expect(btrim("\ta\t")).toBe("\ta\t");
    expect(left1000("a".repeat(1500))).toHaveLength(1000);
    expect(left1000("kısa")).toBe("kısa");
  });
});

// ---------------------------------------------------------------------------
// Branch A: the loaded incumbent
// ---------------------------------------------------------------------------

const LOADED_TRUE = [
  "Trump, katillere desteğiyle övündü: Bu iş bittiğinde İsrail'e gidip başbakan olabilirim",
  "Şerbetli tatlıya tuzlu fatura. İBB yönetimine ihale rantı tepkisi",
  "Katillere destek veren hükümet",
  "katil rejimin saldırısı",
  "Katile destek veren ülkeler",
  "Hükümet katillerine destek verdi",
  "Katil devlet yine saldırdı",
  "Katil siyonist yönetim açıklama yaptı",
  "İhale rantına tepki büyüyor",
  "ihale rantı iddiası",
  "Kentte rant kapısına dönüştü",
  "İBB'de 'ihale rantı' iddiası",
];
const LOADED_FALSE = [
  "Afyonkarahisar'daki katliamda yeni gelişme: 8 kişinin katilinin ilk ifadesi ortaya çıktı",
  "Katil zanlısı yakalandı",
  "Seri katil belgeseli yayında",
  "Katil zanlısına destek veren kişi gözaltına alındı",
  // every 'katıl-' word: the dotless ı is its own letter.
  "COP31'e katılan liderlere destek",
  "Katılım bankalarına destek paketi",
  "Katılımcılara destek verildi",
  "Katıldı destek veren kuruluşlar",
  "Etkinliğe katılanlara destek sözü",
  "Katılımcı rejim değişikliği istedi",
  // a speaker's own words, behind the label's opening quote.
  "Bahçeli: Avrupa göçmen karşıtlığından siyasi rant devşiriyor",
  "Erdoğan: 'Katillere destek verenler hesap verecek'",
  "Özel: “İBB'de ihale rantı var”",
  "Bahçeli: \"Rant kapısı kapatıldı\"",
  "Kamu İhale Kanunu değişikliği Meclis'te",
  "Rantabilite oranları yükseldi",
  // the left edge: a letter or a digit in front of the word is not an edge.
  "2katil destek",
  "çkatil rejim",
  "Xihale rantı",
  "Birrant kapısı",
];

describe("209 neutral_title_repick_loaded_cased: branch A, the SQL run in JavaScript agrees with loadedPenalty", () => {
  it("is true for the loaded titles of the spec and false for its negatives", () => {
    for (const t of LOADED_TRUE) expect(sqlLoaded(t), t).toBe(true);
    for (const t of LOADED_FALSE) expect(sqlLoaded(t), t).toBe(false);
  });

  it("never offers what TypeScript does not charge: every title the branch matches costs loadedPenalty at least one unit", () => {
    const corpus = [
      ...LOADED_TRUE,
      ...LOADED_FALSE,
      ...LOADED_FIXTURE.clusters.flatMap((c) => [c.stored, ...c.members.map((m) => m.title), ...c.members.map((m) => cleanHeadline(m.title))]),
      ...CASING_FIXTURE.clusters.flatMap((c) => [c.stored, ...c.members.map((m) => cleanHeadline(m.title))]),
      ...H164_CASING_FIXTURE.clusters.flatMap((c) => [c.stored, ...c.members.map((m) => cleanHeadline(m.title))]),
      ...H164_GENERIC_FIXTURE.clusters.flatMap((c) => [c.stored, ...c.members.map((m) => cleanHeadline(m.title))]),
    ];
    expect(corpus.length).toBeGreaterThan(300);
    let offered = 0;
    for (const t of corpus) {
      if (!sqlLoaded(t)) continue;
      offered++;
      expect(loadedPenalty(t), t).toBeGreaterThanOrEqual(1);
    }
    expect(offered).toBeGreaterThan(8);
  });

  it("is a subset on every combination of a left edge, a phrase, a case and a tail", () => {
    const lefts = ["", "Bu ", "2", "çk", "'", "“", "- ", "x"];
    const phrases = [
      "katillere destek", "katile desteği", "katilin destek", "katilleri destekçisi", "katil rejim", "katil ordu", "katil hükümet",
      "ihale rantı", "ihale rantına", "rant kapısı", "rant kapısına", "katılıma destek", "kapı rant", "ihale  rant",
    ];
    const casings: Array<(s: string) => string> = [
      (s) => s,
      (s) => s.charAt(0).toLocaleUpperCase("tr") + s.slice(1),
      (s) => s.toLocaleUpperCase("tr"),
    ];
    const tails = ["", " x", ": 'söz'"];
    let sql = 0;
    for (const l of lefts) {
      for (const p of phrases) {
        for (const c of casings) {
          for (const tail of tails) {
            const t = `${l}${c(p)}${tail}`;
            if (sqlLoaded(t)) {
              sql++;
              expect(loadedPenalty(t), t).toBeGreaterThanOrEqual(1);
            }
          }
        }
      }
    }
    expect(sql).toBeGreaterThan(40);
  });

  it("offers the two live clusters' stored titles, and no sibling title that carries no epithet", () => {
    for (const c of LOADED_FIXTURE.clusters) {
      expect(sqlLoaded(c.stored), c.cid).toBe(true);
      expect(loadedPenalty(c.stored), c.cid).toBeGreaterThanOrEqual(1);
    }
    for (const t of ["Trump: Bu iş bittiğinde İsrail'e gidip başbakan olabilirim", "İBB Meclisi'nde Sayıştay'ın ihalelerdeki tespitlerine ilişkin soru önergesi"]) {
      expect(sqlLoaded(t), t).toBe(false);
    }
    // The cron's re-pick replaces both with a member's own wording that no rule charges.
    for (const c of LOADED_FIXTURE.clusters) {
      const picked = cronRepick(c);
      expect(picked, c.cid).not.toBeNull();
      expect(picked, c.cid).not.toBe(c.stored);
      expect(loadedPenalty(picked as string), c.cid).toBe(0);
    }
  });

  it("the cut at a speaker's opening quote: the words behind the label's quote are free, the scare quote is not", () => {
    expect(sqlLoaded("Erdoğan: 'Katillere destek verenler hesap verecek'")).toBe(false);
    expect(sqlLoaded("Erdoğan:'Katillere destek verenler hesap verecek'")).toBe(false);
    expect(sqlLoaded("Erdoğan: “İhale rantı var” dedi")).toBe(false);
    expect(sqlLoaded("Erdoğan: Katillere destek verenler hesap verecek")).toBe(true);
    expect(sqlLoaded("Erdoğan'ın 'katil rejim' sözü")).toBe(true);
    // The words before the colon are still read.
    expect(sqlLoaded("Katillere destek veren hükümet kuruldu: 'tarihi gün'")).toBe(true);
  });

  it("the port is linear on hostile input: a long title is a few scans, not a blow-up", () => {
    const opts = { n: 250_000, ceilingMs: 8_000 };
    expectLinear(rep("katil "), (shape) => sqlLoaded(`${shape}destek`), opts);
    expectLinear(rep("katillerine "), (shape) => sqlLoaded(`${shape}x`), opts);
    expectLinear(rep("ihale "), (shape) => sqlLoaded(`${shape}rant`), opts);
    expectLinear(rep(" "), (shape) => sqlLoaded(`katil${shape}x`), opts);
    expectLinear(rep(": "), (shape) => sqlLoaded(`${shape}'katil rejim`), opts);
    expectLinear(rep("a: '"), (shape) => sqlLoaded(shape), opts);
  });
});

// ---------------------------------------------------------------------------
// Branch B: the machine-cased İşçi Haber title
// ---------------------------------------------------------------------------

/** What the SQL branch offers among the fixture clusters (pinned: every one is changed by the cron's re-pick). */
const OFFERED_BY_B = ["2490109a", "3039d877", "0834c3ba", "609f9e22", "4797e4f6", "ecbc23a0", "3175d6f7", "588c58ce", "2040cdf1", "37915ace"];
/** The five İşçi Haber-owned rows the picker keeps, and 9df76d26 whose stored title is a re-pick's own recasing. */
const KEPT = ["8e179d37", "0792bdea", "688af268", "f53a766f", "829ef5cc"];

describe("209 neutral_title_repick_loaded_cased: branch B, the SQL run in JavaScript on the live clusters", () => {
  it("offers the 3039d877-, 0834c3ba-, 609f9e22- and 4797e4f6-shaped clusters, and the rest of the casing family", () => {
    for (const cid of ["3039d877", "0834c3ba", "609f9e22", "4797e4f6"]) {
      const c = casingCluster(cid);
      expect(sqlCasing(c.stored, asMembers(c)), cid).toBe(true);
    }
    expect(CASING_FIXTURE.clusters.filter((c) => sqlCasing(c.stored, asMembers(c))).map((c) => c.cid).sort()).toEqual([...OFFERED_BY_B].sort());
  });

  it("8541cbe6 is the price of the quote rule: its one sibling quotes a span, the picker would recase 'batı' and the SQL does not offer it", () => {
    // h169 review (db-209-B): a sibling title with a quotation mark is no evidence for the SQL (it cannot tell which words the quote
    // covers, and the copy a fold twin keeps may be the quoted one). 8541cbe6 (two members) is recased when the cluster grows.
    const c = casingCluster("8541cbe6");
    expect(c.members.filter((m) => m.source !== SLUG).every((m) => RE_QUOTE.test(m.title))).toBe(true);
    expect(sqlCasing(c.stored, asMembers(c))).toBe(false);
    expect(cronRepick(c)).not.toBe(c.stored);
  });

  it("does not offer the five İşçi Haber rows the picker keeps", () => {
    for (const cid of KEPT) {
      const c = casingCluster(cid);
      expect(sqlCasing(c.stored, asMembers(c)), cid).toBe(false);
      // ... and the cron's re-pick keeps them: no loop, no wasted slot.
      expect(cronRepick(c), cid).toBe(c.stored);
    }
  });

  it("never offers a row whose stored title is not some İşçi Haber member's title (9df76d26's is a re-pick's own recasing)", () => {
    const nine = casingCluster("9df76d26");
    expect(nine.members.some((m) => m.source === SLUG && btrim(m.title) === btrim(nine.stored))).toBe(false);
    expect(sqlCasing(nine.stored, asMembers(nine))).toBe(false);
    for (const c of CASING_FIXTURE.clusters) {
      const isOwn = c.members.some((m) => m.source === SLUG && btrim(m.title) === btrim(c.stored));
      if (!isOwn) expect(sqlCasing(c.stored, asMembers(c)), c.cid).toBe(false);
    }
    // The stored title written by an outlet that is not İşçi Haber is never this branch's, whatever its casing.
    const c = casingCluster("3039d877");
    const relabelled = c.members.map((m) => (m.source === SLUG ? { ...m, source: "haber7" } : m));
    expect(sqlCasing(c.stored, relabelled.map((m) => ({ slug: m.source, title: m.title })))).toBe(false);
  });

  it("every cluster the branch offers is one the TypeScript re-pick changes: no residue on the fixtures", () => {
    for (const c of CASING_FIXTURE.clusters) {
      if (!sqlCasing(c.stored, asMembers(c))) continue;
      const picked = cronRepick(c);
      expect(picked, c.cid).not.toBeNull();
      expect(picked, c.cid).not.toBe(c.stored);
    }
  });

  it("the cluster leaves the set once the cron has written its pick: the new title is no İşçi Haber member's, so it is not offered again", () => {
    for (const cid of OFFERED_BY_B) {
      const c = casingCluster(cid);
      const next = cronRepick(c) as string;
      expect(sqlCasing(next, asMembers(c)), `${cid}: ${next}`).toBe(false);
    }
  });

  it("the rule on small shapes: a lower-case word that a sibling writes with a capital, and the cases it leaves alone", () => {
    const isci = (title: string): Member => ({ slug: SLUG, title });
    const other = (title: string): Member => ({ slug: "haber7", title });
    const stored = "Bakan Bayraktar'dan libya ve venezuela mesajı";
    // A capital behind a non-ending token, any other member.
    expect(sqlCasing(stored, [isci(stored), other("Bakan Bayraktar'dan Libya ve Venezuela ile enerji mesajı")])).toBe(true);
    // Fold-equal, not byte-equal: 'çöp31' and 'COP31'.
    expect(sqlCasing("Bakan Fidan çöp31 zirvesini değerlendirdi", [isci("Bakan Fidan çöp31 zirvesini değerlendirdi"), other("Bakan Fidan'dan COP31 mesajı")])).toBe(true);
    // The title's own first word is never evidence (the later words of the same title still are).
    expect(sqlCasing("Bakan Bayraktar'dan libya mesajı", [isci("Bakan Bayraktar'dan libya mesajı"), other("Libya ile enerji mesajı")])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other("Libya ve Venezuela ile enerji mesajı")])).toBe(true);
    // Neither is a word behind '.', ':', '!', '?' or '…' ...
    const libya = "Bakan Bayraktar'dan libya mesajı";
    for (const end of [".", ":", "!", "?", "…"]) {
      expect(sqlCasing(libya, [isci(libya), other(`Bakan Bayraktar açıkladı${end} Libya ile enerji mesajı`)]), end).toBe(false);
    }
    expect(sqlCasing(libya, [isci(libya), other("Bakan Bayraktar açıkladı, Libya ile enerji mesajı")])).toBe(true);
    // ... unless the token is an ordinal of one to three digits.
    const ord = "Cumhurbaşkanı Erdoğan 111. dönem kaymakamlar töreninde";
    expect(sqlCasing(ord, [isci(ord), other("Başkan Erdoğan'dan 111. Dönem töreni")])).toBe(true);
    expect(sqlCasing(ord, [isci(ord), other("Başkan Erdoğan'dan 1111. Dönem töreni")])).toBe(false);
    expect(sqlCasing(ord, [isci(ord), other("Başkan Erdoğan'dan x111. Dönem töreni")])).toBe(false);
    // An opening quote starts the token: no capital word there.
    expect(sqlCasing(libya, [isci(libya), other("Bakan Bayraktar'dan 'Libya' mesajı")])).toBe(false);
    // A word that is one letter, or has a capital inside it, or sits behind an apostrophe, is not a lower-case word of the stored title.
    expect(sqlCasing("Bakan x iPhone açıkladı", [isci("Bakan x iPhone açıkladı"), other("Bakan X IPhone açıkladı")])).toBe(false);
    expect(sqlCasing("Bakan Libya'dan açıkladı", [isci("Bakan Libya'dan açıkladı"), other("Bakan Fidan Dan açıkladı")])).toBe(false);
    // The title itself, byte for byte or with spaces around it, is no other member.
    expect(sqlCasing(stored, [isci(stored), other(`  ${stored}  `)])).toBe(false);
    // The İşçi Haber member is one of the outlet's last fifteen days (the SQL reads that window once, not a probe per cluster).
    expect(sqlCasing(stored, [{ ...isci(stored), daysAgo: 14 }, other("Bakan Bayraktar'dan Libya ve Venezuela ile enerji işbirliği mesajı")])).toBe(true);
    expect(sqlCasing(stored, [{ ...isci(stored), daysAgo: 15 }, other("Bakan Bayraktar'dan Libya ve Venezuela ile enerji işbirliği mesajı")])).toBe(false);
    // No İşçi Haber member carries the stored title: not this branch's.
    expect(sqlCasing(stored, [isci("Başka bir başlık"), other("Bakan Bayraktar'dan Libya ve Venezuela mesajı")])).toBe(false);
  });

  it("a Title Case title adds no capital evidence, and a cluster of five members or more asks two other titles for a word", () => {
    const isci = (title: string): Member => ({ slug: SLUG, title });
    const other = (title: string): Member => ({ slug: "haber7", title });
    const stored = "Bakan Bayraktar'dan libya mesajı";
    const titleCase = "Bakan Bayraktar'dan Libya Enerji İşbirliği Mesajı";
    const sentence = "Bakan Bayraktar'dan Libya ile enerji işbirliği mesajı";
    const sentence2 = "Bakan Libya ile yeni anlaşma imzaladı";
    expect(sqlTitleCase(titleCase)).toBe(true);
    expect(sqlTitleCase(sentence)).toBe(false);
    // Four long words is the least a title needs to be Title Case; eighty percent of them with a capital.
    expect(sqlTitleCase("Siyasilerden 10 Kasım Atatürk'ü Anma Günü Mesajları")).toBe(true);
    expect(sqlTitleCase("Bakan Libya Enerji Mesajı")).toBe(true);
    expect(sqlTitleCase("Bakan Libya Enerji")).toBe(false);
    expect(sqlTitleCase("Bakan Libya enerji mesajı verdi")).toBe(false);
    expect(sqlTitleCase("Bakan Libya Enerji Mesajı verdi")).toBe(true); // 4 of 5: exactly eighty percent
    expect(sqlTitleCase("Bakan Libya Enerji Mesajı verdi iklim")).toBe(false); // 4 of 6
    expect(sqlTitleCase("Bakan Libya Enerji Mesajı Verdi Açıkladı iklim")).toBe(true);
    // A digit takes a token out of the count, as in TypeScript.
    expect(sqlTitleCase("Bakan COP31 Libya Enerji Mesajı")).toBe(true);
    expect(sqlCasing(stored, [isci(stored), other(titleCase)])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(sentence)])).toBe(true);
    // Five members: one other title is not enough, two are.
    const fillers = [other("Hükümetten enerji açıklaması geldi"), other("Enerji bakanı iklim mesajı verdi"), other("Bakanlık enerji toplantısı yaptı")];
    expect(sqlCasing(stored, [isci(stored), other(sentence), ...fillers.slice(0, 2)])).toBe(true);
    expect(sqlCasing(stored, [isci(stored), other(sentence), ...fillers])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(sentence), other(sentence2), ...fillers.slice(0, 2)])).toBe(true);
    // The same title from two outlets is one title.
    expect(sqlCasing(stored, [isci(stored), other(sentence), { slug: "posta", title: ` ${sentence} ` }, ...fillers.slice(0, 2)])).toBe(false);
    // A Title Case title does not count towards the two.
    expect(sqlCasing(stored, [isci(stored), other(sentence), other(titleCase), ...fillers.slice(0, 2)])).toBe(false);
  });

  // h169 review (db-209-B): the SQL read more evidence than the picker. 8f09d48c's members, in publish order (production, read
  // 2026-11-13): İşçi Haber's "Cumhurbaşkanı Erdoğan: Gazze barış anlaşması uygulanmıyor" is the stored title once the cluster has five
  // members, and the cron's re-pick keeps it (it is the only title the picker finds with no quote and no Title Case: AA's copy is folded
  // into ajans-haber's quoted twin, which is newer). The old SQL counted the quoted spans and the twin as capitals of 'barış' and
  // 'anlaşması' and offered the row on every tick: offered, kept, stamped, offered again.
  const GAZZE_MEMBERS = [
    { source: "anadolu-ajansi", title: "Cumhurbaşkanı Erdoğan: Gazze Barış Anlaşması ne yazık ki uygulanmıyor" },
    { source: "ajans-haber", title: "Cumhurbaşkanı Erdoğan: “Gazze Barış Anlaşması ne yazık ki uygulanmıyor”" },
    {
      source: "haberler-com",
      title:
        "Cumhurbaşkanı Erdoğan: \"Bizim de imzalanmasına katkı verdiğimiz Gazze Barış Anlaşması ne yazık ki uygulanmıyor. Uluslararası ilişkilerin temeli olan 'ahde vefa' ilkesi hayata geçirilemiyor. Bu şekilde hiçbir sorunun çözülemeyeceğini herkes anlamalıdır.\"",
    },
    { source: "isci-haber", title: "Cumhurbaşkanı Erdoğan: Gazze barış anlaşması uygulanmıyor" },
    { source: "yeni-mesaj", title: "Erdoğan: \"Gazze Barış Anlaşması uygulanmıyor\"" },
    { source: "milat", title: "Erdoğan: Gazze Barış Anlaşması ne yazık ki uygulanmıyor" },
    { source: "yeni-safak", title: "İsrail’e iltimas geçiliyor" },
  ];
  const gazzeCluster = (n: number): FixtureCluster => ({
    cid: "8f09d48c",
    stored: GAZZE_MEMBERS[3]!.title,
    // The cron hands the members newest first.
    members: GAZZE_MEMBERS.slice(0, n).reverse().map((m) => ({ ...m, opinion: false })),
  });

  it.each([5, 6, 7])("8f09d48c at %i members: the stored İşçi Haber title is never offered and kept (no loop)", (n) => {
    const c = gazzeCluster(n);
    expect(c.members).toHaveLength(n);
    expect(c.members.some((m) => m.source === SLUG && m.title === c.stored)).toBe(true);
    const offered = sqlCasing(c.stored, asMembers(c));
    const kept = cronRepick(c) === c.stored;
    expect(!(offered && kept), `offered ${offered}, kept ${kept}`).toBe(true);
  });

  it("8f09d48c: a quoted span, the twin of a quoted title and the title's own twin are no capital evidence", () => {
    const stored = GAZZE_MEMBERS[3]!.title;
    const isci: Member = { slug: SLUG, title: stored };
    const aa: Member = { slug: "anadolu-ajansi", title: GAZZE_MEMBERS[0]!.title };
    const quoted: Member = { slug: "ajans-haber", title: GAZZE_MEMBERS[1]!.title };
    const milat: Member = { slug: "milat", title: GAZZE_MEMBERS[5]!.title };
    // Alone, the unquoted title is evidence for 'barış' and 'anlaşması' ...
    expect(sqlCasing(stored, [isci, aa])).toBe(true);
    // ... but not once a quoted copy of it is a member (usableItems keeps one copy of a fold twin, newest first, and TypeScript may have
    // kept the quoted one), and a quoted title is none by itself.
    expect(sqlCasing(stored, [isci, aa, quoted])).toBe(false);
    expect(sqlCasing(stored, [isci, quoted])).toBe(false);
    // A title that is not a twin of the quoted one still is.
    expect(sqlCasing(stored, [isci, milat])).toBe(true);
    expect(sqlCasing(stored, [isci, aa, milat])).toBe(true);
    // At five members two distinct titles are asked for: the twin pair (one key) is one title, not two.
    const fillers: Member[] = [{ slug: "x", title: "İsrail’e iltimas geçiliyor" }, { slug: "y", title: "Gazze için yeni açıklama" }];
    expect(sqlCasing(stored, [isci, aa, milat, ...fillers])).toBe(true);
    expect(sqlCasing(stored, [isci, aa, { slug: "z", title: ` ${aa.title.toUpperCase().slice(0, 0)}${aa.title} ` }, ...fillers])).toBe(false);
    expect(sqlCasing(stored, [isci, aa, quoted, milat, ...fillers.slice(0, 1)])).toBe(false);
  });

  it("every İşçi Haber title of every fixture cluster, stored in turn: the rows offered and kept number at most the limit of 3", () => {
    // THE RESIDUE of the header: the branch offers a row only when the picker's re-pick changes it; a row it offers and the picker
    // keeps would be offered again on every tick. The fixtures of h168-casing, h164-casing and h164-generic, with each İşçi Haber
    // member's title substituted as the stored title.
    const residue: string[] = [];
    let tried = 0;
    let offered = 0;
    for (const fixture of [CASING_FIXTURE, H164_CASING_FIXTURE, H164_GENERIC_FIXTURE]) {
      for (const c of fixture.clusters) {
        const titles = [...new Set(c.members.filter((m) => m.source === SLUG).map((m) => m.title))];
        for (const stored of titles) {
          tried++;
          const as = { ...c, stored };
          if (!sqlCasing(stored, asMembers(as))) continue;
          offered++;
          if (cronRepick(as) === stored) residue.push(`${c.cid}: ${stored}`);
        }
      }
    }
    // Measured 2026-11-13 (the numbers of THE RESIDUE): 25 substitutions, 19 offered, 0 kept.
    expect(tried).toBe(25);
    expect(offered).toBe(19);
    expect(residue.length).toBeLessThanOrEqual(3);
    expect(residue).toEqual([]);
  });

  it("the new evidence rules on small shapes: a quote, all caps, a shouted run, a fold twin, the stored title's twin and the veto", () => {
    const isci = (title: string): Member => ({ slug: SLUG, title });
    const other = (title: string, slug = "haber7"): Member => ({ slug, title });
    const stored = "Bakan Bayraktar'dan libya ve venezuela mesajı";
    const evidence = "Bakan Bayraktar'dan Libya ve Venezuela ile enerji mesajı";
    expect(sqlCasing(stored, [isci(stored), other(evidence)])).toBe(true);
    // (i) a quotation mark anywhere in a sibling takes it out: straight, curly, guillemets, an opening single quote; an apostrophe inside a word stays.
    for (const q of ['Bakan Bayraktar\'dan "Libya ve Venezuela" mesajı', "Bakan Bayraktar'dan “Libya ve Venezuela” mesajı", "Bakan Bayraktar'dan «Libya ve Venezuela» mesajı", "Bakan Bayraktar'dan 'Libya ve Venezuela' mesajı", "Bakan Bayraktar'dan ‘Libya ve Venezuela’ mesajı"]) {
      expect(sqlCasing(stored, [isci(stored), other(q)]), q).toBe(false);
    }
    expect(sqlCasing(stored, [isci(stored), other("Bakan Bayraktar’dan Libya ve Venezuela ile enerji mesajı")])).toBe(true);
    expect(sqlCasing(stored, [isci(stored), other("Bakan Bayraktar'dan Libya ve Venezuela'nın enerji mesajı")])).toBe(true);
    // (ii) no lower-case letter, or three shouted words in a row (three letters or more each): no evidence. Two shouted words are fine.
    const lead = (l: string): string => `${l} Bakan Bayraktar'dan Libya ve Venezuela için enerji ve iklim mesajı`;
    expect(sqlCasing(stored, [isci(stored), other(lead("SON DAKİKA:"))])).toBe(true);
    expect(sqlCasing(stored, [isci(stored), other(lead("SON DAKİKA ENERJİ:"))])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(lead("SON DAKİKA ENERJİ"))])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(lead("TBMM'DE CHP AKP"))])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(lead("CHP ve AK Parti"))])).toBe(true);
    expect(sqlCasing(stored, [isci(stored), other(lead("CHP AK SON DAKİKA"))])).toBe(true);
    // No lower-case letter at all (and under three shouted words in a row: 'AB' and 'VE' are two letters): excluded; one lower-case letter keeps it.
    expect(sqlCasing(stored, [isci(stored), other("AB LİBYA VE VENEZUELA")])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other("AB LİBYA ve VENEZUELA")])).toBe(true);
    // (iii) the support of a word counts distinct fold keys: two spellings of one title are one title.
    const five = [other("Hükümetten enerji açıklaması geldi"), other("Enerji bakanı iklim mesajı verdi")];
    expect(sqlCasing(stored, [isci(stored), other(evidence), other(`${evidence}.`), ...five])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(evidence), other(evidence.replace("mesajı", "mesajı verdi")), ...five])).toBe(true);
    // (iv) a title whose key is that of an excluded title is dropped with it, and so is one whose key is the stored title's.
    expect(sqlCasing(stored, [isci(stored), other(evidence), other(`"${evidence}"`)])).toBe(false);
    expect(sqlCasing(stored, [isci(stored), other(evidence), other(evidence.toUpperCase())])).toBe(false);
    const short = "Bakan Bayraktar'dan libya mesajı";
    // The stored title's own twin (the same words, other capitals or other marks) is the stored title to usableItems, not a sibling.
    expect(sqlCasing(short, [isci(short), other("Bakan Bayraktar'dan Libya mesajı")])).toBe(false);
    expect(sqlCasing(short, [isci(short), other("Bakan Bayraktar’dan Libya mesajı!", "posta")])).toBe(false);
    expect(sqlCasing(short, [isci(short), other(short, "posta")])).toBe(false);
    // ... and a title that is not its twin still is evidence, next to one that is.
    expect(sqlCasing(short, [isci(short), other("Bakan Bayraktar'dan Libya mesajı", "posta"), other("Bakan Fidan Libya ile görüştü")])).toBe(true);
    // (v) the veto: a word a member of another outlet writes in lower case (not as the first token) is not restored ...
    const libyaEvidence = other("Bakan Bayraktar'dan Libya ile enerji mesajı");
    expect(sqlCasing(short, [isci(short), libyaEvidence])).toBe(true);
    expect(sqlCasing(short, [isci(short), libyaEvidence, other("Bakan Bayraktar libya ile görüştü")])).toBe(false);
    expect(sqlCasing(short, [isci(short), libyaEvidence, other("Bakan Bayraktar libya'da görüştü")])).toBe(false);
    expect(sqlCasing(short, [isci(short), libyaEvidence, other("Bakan Bayraktar Türkiye-libya hattını açtı")])).toBe(false);
    // (a word right behind an opening quote starts its token: TypeScript skips it as evidence too)
    expect(sqlCasing(short, [isci(short), libyaEvidence, other('Bakan Bayraktar "libya" dedi')])).toBe(true);
    // ... one word is vetoed, not the whole title: 'venezuela' still has its evidence.
    expect(sqlCasing(stored, [isci(stored), other(evidence), other("Bakan Bayraktar libya ile görüştü")])).toBe(true);
    expect(sqlCasing("Bakan Bayraktar'dan libya mesajı", [isci("Bakan Bayraktar'dan libya mesajı"), other(evidence), other("Bakan Bayraktar libya ile görüştü")])).toBe(false);
    // ... the first token of a title is no veto, İşçi Haber's own lower case is none, and a capital is none.
    expect(sqlCasing(short, [isci(short), libyaEvidence, other("libya ile görüşme sürüyor")])).toBe(true);
    expect(sqlCasing(short, [isci(short), libyaEvidence, isci("Bakan Bayraktar libya ile görüştü")])).toBe(true);
    expect(sqlCasing(short, [isci(short), libyaEvidence, other("Bakan Bayraktar Libya ile görüştü")])).toBe(true);
    // The veto counts a title that is no evidence itself (a quoted copy writes the word in lower case too).
    expect(sqlCasing(short, [isci(short), libyaEvidence, other("BAKAN Bayraktar libya ile görüştü")])).toBe(false);
  });

  it("the port is linear on hostile input: a long title among members is a few scans, not a blow-up", () => {
    const opts = { n: 250_000, ceilingMs: 8_000 };
    const stored = (shape: string): string => `Bakan Kurum ${shape}`;
    expectLinear(rep("abc "), (shape) => sqlCasing(stored(shape), [{ slug: SLUG, title: stored(shape) }, { slug: "x", title: "Bakan Kurum Abc" }]), opts);
    expectLinear(rep("Abc "), (shape) => sqlCasing("Bakan kurum abc", [{ slug: SLUG, title: "Bakan kurum abc" }, { slug: "x", title: `Bakan ${shape}` }]), opts);
    expectLinear(rep(" "), (shape) => sqlCasing("Bakan kurum abc", [{ slug: SLUG, title: "Bakan kurum abc" }, { slug: "x", title: `Bakan${shape}Kurum` }]), opts);
    expectLinear(rep("1. "), (shape) => sqlCasing("Bakan kurum abc", [{ slug: SLUG, title: "Bakan kurum abc" }, { slug: "x", title: `Bakan ${shape}Kurum` }]), opts);
    expectLinear(rep("ABC31"), (shape) => sqlCasing("Bakan kurum abc31", [{ slug: SLUG, title: "Bakan kurum abc31" }, { slug: "x", title: `Bakan ${shape}` }]), opts);
  });
});
