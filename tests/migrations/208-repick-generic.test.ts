import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { expectLinear, rep } from "../_helpers/linear-time";
import {
  cleanHeadline,
  EXTRACTIVE_MODEL_ID,
  isAblativeStatementTitle,
  isAcceptableNeutral,
  isGenericTitle,
  isQuestionTeaser,
  isQuestionTitle,
} from "../../src/lib/clusters/neutral-title";

// ---------------------------------------------------------------------------
// Contract test for migration 208 ("neutral_title_repick_generic"), h164-titles-1 (hunt 164).
//
// 67695cbd ("MHP Lideri Bahçeli'den açıklamalar", 27 members) and 298bbb75 ("Cumhurbaşkanı Erdoğan'dan açıklamalar", 22) are served
// as the H1 of the day's speech clusters, and fd7428e8 ("Tera'nın patronu Emre Tezmen YENİ Parti ile neden görüşmedi") asks a
// question the members answer. The app now rejects both shapes (isGenericTitle's ABLATIVE_STATEMENT, isQuestionTeaser in the gate),
// but a stored title nobody re-offers is never re-picked: every one of them is stamped at its own count or below the growth bar.
//
// 208 re-creates public.neutral_title_repick_candidates(text, integer) with 200's body and ONE added branch at the end of the outer
// WHERE, with no stamp condition (like 184's SHOUT branch): a stored title without a '?' that the generic rule or the teaser rule
// matches, both run over public.tayf_search_fold. This file pins, without a database: the ledger row and the single transaction,
// additive-only SQL, 200's body is production's (md5 pinned, recomputed from the file), that 208's body is 200's byte for byte with
// exactly the added branch, the grants and the comment, the header's numbers, the dry-run script, and, by running the SQL regular
// expressions in JavaScript on the text of the file over the fold of the SQL, that the SQL branch and the TypeScript rules reach the
// same verdict on the spec's strings, on the live clusters' stored titles and on every member title of the two fixtures.
//
// The h165 review narrowed the first version: the SQL rules are a SUBSET of the TypeScript verdicts (a title SQL offers and the gate
// accepts would be offered on every tick): the generic rule reads three tokens in front of the speaker's line, no ':' and no
// verb-like token (hasFiniteVerb cannot be mirrored), the teaser stops a clause at '!', '?' and '. ', leaves 'neden ol-' and a
// reported answer alone, and a title with the combining dot above (U+0307, which the two folds read differently) is never offered.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL); the two regular
// expressions the port builds are the SQL literals of the file, bounded, anchored at the start or on a literal word.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_200 = "200_neutral_title_stale_quote_aware.sql";
const FILE_207 = "207_admin_login_throttle_device.sql";
const FILE_208 = "208_neutral_title_repick_generic.sql";
const MIGRATION_200 = resolve(MIGRATIONS_DIR, FILE_200);
const MIGRATION_208 = resolve(MIGRATIONS_DIR, FILE_208);
const DRYRUN = resolve(__dirname, "sql", "208-repick-generic-dryrun.sql");
const FIXTURES = resolve(ROOT, "src", "lib", "clusters", "__fixtures__");

/** Production, read-only, 2026-11-12 ~19:05Z: md5(prosrc), length(prosrc) and the attributes of the function 208 starts from. */
const PROD_MD5 = "e007128d452df4902001859882d322b8";
const PROD_LENGTH = 5028;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";
/** What 208's body hashes to (computed from the file below; pinned here so a stray edit shows). */
const NEW_MD5 = "5105bed7a553b41a8c7b30855af4aecc";
const NEW_LENGTH = 6937;

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('208', '208_neutral_title_repick_generic') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** 200's last branch ends with the shout lines; 208's branch is appended after them, before the final order by. */
const ORDER_LINE = "   order by w.updated_at desc\n";

// The regular expressions of the branch, as the SQL spells them (the literals of the file, '' unescaped). The generic rule, its
// prefilter, the verb-like exclusion, the teaser rule, its prefilter and the clause boundaries.
//   generic: at most three name or title tokens before the ablative (TypeScript's reads five and then asks hasFiniteVerb of the
//     text in front; SQL cannot, so it reads fewer and refuses any title with a verb-like token: SQL stays a SUBSET), and no ':'
//     anywhere in the text it reads (TypeScript: a ':' after the last '. ' makes the line a statement under a topic).
const GENERIC_SQL =
  "^[^a-z0-9:]*(?:[a-z0-9]{1,40}[^a-z0-9:]+){0,3}(?:[a-z0-9]{1,40}[^a-z0-9:]+(?:dan|den|tan|ten|ndan|nden)|[a-z0-9]{1,40}(?:dan|den|tan|ten))" +
  "[^a-z0-9:]+(?:(?:onemli|son[^a-z0-9:]+dakika|yeni|kritik)[^a-z0-9:]+)?(?:aciklama(?:lar)?|mesajlar)[^a-z0-9:]*$";
const GENERIC_PREFILTER_SQL = "(?:aciklama(?:lar)?|mesajlar)[^a-z0-9]*$";
/** A superset of finite-verb.ts's endings (no stem length, no voicing): a title with such a token is never offered as a placeholder. */
const VERB_LIKE_SQL =
  "(?<![a-z0-9])(?:[a-z0-9]{0,40}(?:(?:(?<=[cfhkpst])t|(?<![cfhkpst])d)[iu](?:m|k|niz|nuz|lar|ler|r)?" +
  "|m[iu]s(?:t[iu]r?|lar|ler|[iu]m|[iu]z|s[iu]n|s[iu]n[iu]z)?" +
  "|[iu]yor(?:um|sun|uz|sunuz|lar|du|mus)?|[ae]c[ae]k(?:t[iu]r|lar|ler|sin|siniz)?|[ae]c[ae]g(?:im|iz)|m[ae]li(?:d[iu]r|lar|ler)?" +
  "|[ae]bilir(?:ler|lar)?)|var|yok|degil|vardir|yoktur|degildir|idi|imis)(?![a-z0-9])";
//   teaser: run over the title cut at a speaker's opening quote, with '!', '?' and '. ' turned into ':' first (a clause ends at all
//     four), then folded. The 'hangi' clause is read from its own start and refused when it holds a nominalised reported answer.
const TEASER_SQL =
  "(?:^|[^a-z0-9])(?:ne[^a-z0-9]+oldu|neler[^a-z0-9]+(?:oldu|var))(?:[^a-z0-9]|$)" +
  "|(?:^|[^a-z0-9])kimler[^a-z0-9:]+var[^a-z0-9]*(?::|$)" +
  "|(?:^|:)(?![^:]*(?<![a-z0-9])[a-z0-9]{0,40}(?:d[iu]g|t[iu]g|[ae]c[ae]g)[iu]n[iu](?![a-z0-9]))[^:]*(?<![a-z0-9])hangi[^a-z0-9:]+[a-z0-9]{1,40}[^a-z0-9:]+ne(?:[^a-z0-9]|$)" +
  "|(?:^|[^a-z0-9])neden(?![^a-z0-9:]+ol)(?:[^a-z0-9:]+[a-z0-9]{1,40}){0,4}[^a-z0-9:]+[a-z0-9]{0,40}m[ae]d[iu][^a-z0-9]*(?::|$)";
const TEASER_PREFILTER_SQL = "(?:^|[^a-z0-9])(?:ne|neler|kimler|hangi|neden)(?:[^a-z0-9]|$)";
/** The SQL spelling of the speaker-quote cut, of the cut at the last sentence break and of the clause boundaries. */
const QUOTE_CUT_SQL = ":\\s*[\"“'‘«].*$";
const LAST_BREAK_SQL = "^.*\\. ";
const BOUNDARY_SQL = "[!?]|\\.\\s";

const sqlLiteral = (s: string): string => `'${s.split("'").join("''")}'`;

/** The whole branch, whitespace collapsed (the file lays it out over several lines). */
const BRANCH =
  "or (pg_catalog.strpos(w.title_tr_neutral, '?') = 0 " +
  "and pg_catalog.strpos(w.title_tr_neutral, pg_catalog.chr(775)) = 0 and (" +
  `case when public.tayf_search_fold(w.title_tr_neutral) ~ ${sqlLiteral(GENERIC_PREFILTER_SQL)} ` +
  `then public.tayf_search_fold(pg_catalog.regexp_replace(w.title_tr_neutral, ${sqlLiteral(LAST_BREAK_SQL)}, '')) ~ ${sqlLiteral(GENERIC_SQL)} ` +
  `and public.tayf_search_fold(w.title_tr_neutral) !~ ${sqlLiteral(VERB_LIKE_SQL)} ` +
  "else false end " +
  `or case when public.tayf_search_fold(w.title_tr_neutral) ~ ${sqlLiteral(TEASER_PREFILTER_SQL)} ` +
  `then public.tayf_search_fold(pg_catalog.regexp_replace(pg_catalog.regexp_replace(w.title_tr_neutral, ${sqlLiteral(QUOTE_CUT_SQL)}, ''), ${sqlLiteral(BOUNDARY_SQL)}, ':', 'g')) ~ ${sqlLiteral(TEASER_SQL)} ` +
  "else false end))";

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

const sql200 = readFileSync(MIGRATION_200, "utf8");
const body200 = functionBody(sql200);
const sql208 = existsSync(MIGRATION_208) ? readFileSync(MIGRATION_208, "utf8") : "";
const header208 = (): string => {
  expect(existsSync(MIGRATION_208), `${FILE_208} must exist`).toBe(true);
  return sql208.split("\nbegin;")[0] as string;
};
const body208 = (): string => {
  expect(existsSync(MIGRATION_208), `${FILE_208} must exist`).toBe(true);
  return functionBody(sql208);
};

/** 208's body with the added branch cut out: the lines between 200's shout branch and the final order by. */
function bodyWithoutBranch(body: string): { rest: string; added: string } {
  const at = body.lastIndexOf(ORDER_LINE);
  expect(at, "the final order by follows the new branch").toBeGreaterThan(0);
  const shout = body.indexOf("          and w.title_tr_neutral !~ '[a-zçğıöşüâîû]')\n");
  expect(shout, "200's shout branch is kept").toBeGreaterThan(0);
  const from = shout + "          and w.title_tr_neutral !~ '[a-zçğıöşüâîû]')\n".length;
  expect(from, "the new branch sits after the shout branch").toBeLessThanOrEqual(at);
  return { rest: body.slice(0, from) + body.slice(at), added: body.slice(from, at) };
}

describe("208 neutral_title_repick_generic: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 208", () => {
    expect(existsSync(MIGRATION_208)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("208_"))).toEqual([FILE_208]);
  });

  it("sits after 207 and leaves 200 alone (200 is the rollback target)", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, FILE_207))).toBe(true);
    expect(body200).toContain("pg_catalog.chr(1)");
    expect(body200).not.toContain("tayf_search_fold(w.title_tr_neutral)");
    expect(body200).not.toContain("kimler");
  });

  it("runs in one transaction with the lock and statement timeouts, and records its ledger row", () => {
    const code = stripComments(sql208);
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
    const stmts = statements(stripComments(sql208));
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
    const code = sansStrings(stripComments(sql208).split("$fn$").filter((_, i) => i % 2 === 0).join(" "));
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
    const fnBody = sansStrings(body208()).toLowerCase();
    for (const write of ["insert ", "update ", "delete ", "truncate", "alter ", "create ", "drop "]) {
      expect(fnBody, write).not.toContain(write);
    }
  });

  it("does not bump the model and does not touch the cron", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
    expect(sql208).not.toContain("extractive-v7");
    expect(sql208).not.toContain("cron.schedule");
  });
});

describe("208 neutral_title_repick_generic: the body", () => {
  it("200's body is production's: its md5 and length are the ones read on production", () => {
    expect(md5(body200)).toBe(PROD_MD5);
    expect(body200.length).toBe(PROD_LENGTH);
  });

  it("is 200's body byte for byte with exactly the added branch, after the shout branch and before the order by", () => {
    const { rest, added } = bodyWithoutBranch(body208());
    expect(rest).toBe(body200);
    expect(collapse(added)).toBe(BRANCH);
    // The branch is one parenthesised alternative of the OR chain, opened by 'or', with no stamp condition.
    expect(added.trimStart().startsWith("or (")).toBe(true);
    expect(added).not.toContain("title_neutral_member_count");
    expect(added).not.toContain("article_count");
  });

  it("has the pinned fingerprint", () => {
    expect(md5(body208())).toBe(NEW_MD5);
    expect(body208().length).toBe(NEW_LENGTH);
  });

  it("keeps the signature, volatility, security definer and search_path of 200", () => {
    expect(functionHeader(sql208)).toBe(functionHeader(sql200));
    expect(collapse(functionHeader(sql208))).toBe(
      "create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20) " +
        "returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint) " +
        "language sql stable security definer set search_path = '' as $fn$",
    );
  });

  it("qualifies every function it calls (search_path is empty) and names the house fold of 129", () => {
    const added = bodyWithoutBranch(body208()).added;
    expect(countOf(added, "public.tayf_search_fold(")).toBe(5);
    expect(countOf(added, "pg_catalog.regexp_replace(")).toBe(3);
    expect(countOf(added, "pg_catalog.strpos(")).toBe(2);
    expect(countOf(added, "pg_catalog.chr(")).toBe(1);
    // No call is left bare: every strpos / regexp_replace / tayf_search_fold / chr is the qualified one, and nothing else is called.
    expect(countOf(added, "tayf_search_fold(")).toBe(countOf(added, "public.tayf_search_fold("));
    for (const fn of ["strpos(", "regexp_replace(", "chr("]) expect(countOf(added, fn), fn).toBe(countOf(added, `pg_catalog.${fn}`));
    for (const fn of ["lower(", "translate(", "btrim(", "char_length(", "substr("]) {
      expect(countOf(sansStrings(added), fn), fn).toBe(0);
    }
    // A title with the combining dot above (U+0307) is never this branch's: the SQL fold deletes it, the TypeScript fold turns it
    // into a word break, so the two rules would read different words (h165 review, db-1).
    expect(added).toContain("and pg_catalog.strpos(w.title_tr_neutral, pg_catalog.chr(775)) = 0");
  });

  it("uses ASCII-only regular expressions on the folded text: no Turkish letter, no case-insensitive operator", () => {
    const added = bodyWithoutBranch(body208()).added;
    expect(added).not.toContain("~*");
    expect(added).not.toContain("[[:");
    for (const ch of "çğıöşüâîûÇĞİÖŞÜÂÎÛ") expect(added.includes(ch), ch).toBe(false);
    // The speaker-quote cut is the one place that reads quotation marks of the raw title.
    expect(added).toContain(QUOTE_CUT_SQL.split("'").join("''"));
    for (const re of [GENERIC_SQL, TEASER_SQL, GENERIC_PREFILTER_SQL, TEASER_PREFILTER_SQL, VERB_LIKE_SQL, BOUNDARY_SQL]) {
      for (const ch of re) expect(ch.charCodeAt(0), re).toBeLessThan(128);
    }
  });

  it("every repeat is bounded or runs over disjoint classes (no nested open-ended quantifier in the generic rule)", () => {
    // The generic rule: tokens are {1,40}, at most four of them (SQL reads three before the ablative: a subset of TypeScript's five);
    // the only open-ended repeats are separator runs, which a token separates.
    expect(GENERIC_SQL).toContain("{1,40}");
    expect(GENERIC_SQL).toContain("{0,3}");
    expect(TEASER_SQL).toContain("{0,4}");
    expect(GENERIC_SQL).not.toContain(".*");
    expect(GENERIC_SQL).not.toContain("+)+");
    expect(GENERIC_SQL).not.toContain("*)*");
    expect(TEASER_SQL).not.toContain(".*");
    expect(VERB_LIKE_SQL).not.toContain(".*");
    // The teaser's open-ended runs stop at a clause boundary ([^:]*) and every word is {0,40} or {1,40}.
    expect(TEASER_SQL).not.toContain("+)+");
    expect(VERB_LIKE_SQL).not.toContain("+)+");
  });
});

describe("208 neutral_title_repick_generic: grants, comment and header", () => {
  it("restates the revoke and the grant, so the ACL stays service_role only", () => {
    const stmts = statements(stripComments(sql208));
    expect(stmts).toContain(REVOKE_STMT.slice(0, -1));
    expect(stmts).toContain(GRANT_STMT.slice(0, -1));
    const code = stripComments(sql208);
    expect(code).not.toContain("to anon");
    expect(code).not.toContain("to authenticated");
    expect(code).not.toContain("to public");
    expect(PROD_PROACL).toBe("{postgres=X/postgres,service_role=X/postgres}");
  });

  it("comments the function with the migration list and the new rule", () => {
    const comment = statementStartingWith(stripComments(sql208), "comment on function");
    expect(comment).toContain(`comment on function ${FN_SIG} is`);
    expect(comment.endsWith("Migrations 141, 155, 162, 169, 184, 200, 208.'")).toBe(true);
    expect(comment).toContain("question mark");
    expect(comment).toContain("teaser");
    expect(comment).toContain("at any stamp");
  });

  it("documents WHY, THE RULE, STEP 0, THE RESIDUE, THE COST, THE DRAIN, RELEASE ORDER, VERIFY and ROLLBACK", () => {
    const head = flat(header208());
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
    expect(head).toContain(NEW_MD5);
    expect(head).toContain("DEPLOY the app FIRST");
    expect(head).toContain("The migration is not applied by the PR");
    expect(head).toContain("Safe to re-apply");
    for (const id of ["67695cbd-c276-4bc1-9cbe-37e9ee78ed33", "298bbb75-6af2-48db-b6c5-8b29f25f2438", "fd7428e8-aa57-4fad-ac21-1d222cbf8e51"]) {
      expect(head, id).toContain(id);
    }
  });

  it("states the residue it measured and why it carries no stamp condition", () => {
    const head = flat(header208());
    expect(head).toContain("coalesce(w.title_neutral_member_count, 0)");
    expect(head).toContain("1c7c34ba");
    expect(head).toContain("3a6fde82");
    expect(head).toContain("stamped 27 of 27");
  });
});

// ---------------------------------------------------------------------------
// The SQL branch run in JavaScript: the house fold, the cuts and the two regular expressions of the file, over the fold.
// ---------------------------------------------------------------------------

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

const RE_GENERIC = new RegExp(GENERIC_SQL, "");
const RE_GENERIC_PREFILTER = new RegExp(GENERIC_PREFILTER_SQL, "");
const RE_VERB_LIKE = new RegExp(VERB_LIKE_SQL, "");
const RE_TEASER = new RegExp(TEASER_SQL, "");
const RE_TEASER_PREFILTER = new RegExp(TEASER_PREFILTER_SQL, "");
// Postgres' '.' matches a newline; the quote cut and the last-break cut are anchored at one end.
const RE_QUOTE_CUT = new RegExp(QUOTE_CUT_SQL, "s");
const RE_LAST_BREAK = new RegExp(LAST_BREAK_SQL, "s");
const RE_BOUNDARY = new RegExp(BOUNDARY_SQL, "g");

/** The generic rule on the text after the last '. ' (the whole title when it has none) and no verb-like token anywhere in the title. */
function sqlGeneric(title: string, prefilter = true): boolean {
  const folded = sqlFold(title);
  if (prefilter && !RE_GENERIC_PREFILTER.test(folded)) return false;
  return RE_GENERIC.test(sqlFold(title.replace(RE_LAST_BREAK, ""))) && !RE_VERB_LIKE.test(folded);
}

function sqlTeaser(title: string, prefilter = true): boolean {
  if (prefilter && !RE_TEASER_PREFILTER.test(sqlFold(title))) return false;
  return RE_TEASER.test(sqlFold(title.replace(RE_QUOTE_CUT, "").replace(RE_BOUNDARY, ":")));
}

/** The whole branch on a stored title, as the SQL evaluates it ('?' and the combining dot above (U+0307) are never the branch's). */
function sqlBranch(title: string, prefilter = true): boolean {
  return !title.includes("?") && !title.includes("\u0307") && (sqlGeneric(title, prefilter) || sqlTeaser(title, prefilter));
}

const GENERIC_TRUE = [
  "MHP Lideri Bahçeli'den açıklamalar",
  "Cumhurbaşkanı Erdoğan'dan açıklamalar",
  "Cumhurbaşkanı Erdoğan’dan önemli açıklamalar",
  "Cumhurbaşkanı'ndan önemli mesajlar",
  "Cumhurbaşkanı Erdoğan'dan son dakika açıklamalar",
  "Cumhurbaşkanı Yardımcısı Cevdet Yılmaz'dan açıklamalar",
  "COP31 Zirvesi. Bakan Kurum'dan açıklamalar",
  "111. Dönem Kaymakamlar Kurası Töreni. Cumhurbaşkanı Erdoğan'dan önemli açıklamalar",
  "Bakanlıktan açıklama",
];
const GENERIC_FALSE = [
  "Bahçeli'den 10 Kasım mesajı: Atatürk'ü anlamanın en sağlıklı yolu...",
  "Bakan Bayraktar'dan Libya ve Venezuela ile enerji işbirliği mesajı",
  "Dışişleri'nden Kıbrıs'taki üçlü görüşmeye ilişkin açıklama",
  "Erdoğan'dan fon soruşturmasıyla ilgili açıklama: Haksız kazanç sağlayanlar hesap verecek",
  "MHP lideri Bahçeli: Türkiye'ye parmak sallamak Avrupa'nın harcı değil",
];
/** The h165 review's production titles: the speaker's line behind a sentence or a topic is no placeholder (stored form: the outlet's '!' is '. '). */
const SENTENCE_FALSE = [
  "Rusya'nın ABD Büyükelçisi Aleksandr Darçiyev hayatını kaybetti. Moskova'dan açıklama",
  "Putin, Trump'ın temsilcileriyle görüşecek: Kremlin'den açıklama",
  "Azil süreci başladı. Trump'tan açıklama",
  "Hürmüz Boğazı'nda tanker olayı: UKMTO'dan açıklama",
  "KYK burs ve kredilerine 2027'de zam yapılacak. Bakan Bak'tan yeni açıklama",
];
const QUESTION_TRUE = [
  "Tera'nın patronu Emre Tezmen YENİ Parti ile neden görüşmedi",
  "Son seçim anketinde partilerin oy oranı ne oldu: Birinci sıra dikkat çekti",
  "10 meslek grubuna yeşil pasaport umudu: Listede kimler var",
  "Mekke Anlaşması Meclis'te kabul edildi: Hangi parti ne oy verdi",
];
const QUESTION_FALSE = [
  "Saadet lideri Mahmut Arıkan'dan fon tepkisi: O listede kimler var açıkladı",
  "Bakan, saldırının neden yapıldığını anlattı",
  "Sinirlioğlu'nun neden böldüğünü sordu",
  "Neden istifa ettiğini açıkladı",
  "X: 'Neden susmadı'",
];
/** The h165 review's causative and reported-answer titles: 'neden ol-' and 'hangi ... ne yapılacağını' are statements. */
const CAUSATIVE_FALSE = [
  '"Dur" ihtarını dinlemedi, kazaya neden oldu! Firari sürücü cezadan kaçamadı',
  "Ölümüne neden olan sürücü tutuklanmadı",
  "Kazaya neden olan kamyon şoförü hâlâ bulunamadı",
  "Selin neden olduğu hasar hâlâ giderilmedi",
  "Yangına neden olan şüpheli yakalanmadı",
  "Bakan Tekin hangi ilde ne yapılacağını açıkladı",
];
/** Titles with the combining dot above (U+0307): the SQL fold deletes it, the TypeScript fold breaks the word (h165 review, db-1). */
const COMBINING_DOT = [
  "Bakan neden Meclis toplantısına bu hafta gi\u0307tmedi",
  "Parti Genel Başkan Yardımcısı Efkan Ki\u0307li\u0307nç'ten açıklama",
];

interface Fixture {
  clusters: Array<{ cid: string; stored: string; members: Array<{ source: string; title: string }> }>;
}
const readFixture = (name: string): Fixture =>
  JSON.parse(readFileSync(resolve(FIXTURES, name), "utf8")) as Fixture;
const GENERIC_FIXTURE = readFixture("h164-generic.json");
const CASING_FIXTURE = readFixture("h164-casing.json");
const FIXTURE_TITLES = [...GENERIC_FIXTURE.clusters, ...CASING_FIXTURE.clusters].flatMap((c) => [
  c.stored,
  ...c.members.map((m) => cleanHeadline(m.title)),
]);

describe("208 neutral_title_repick_generic: the SQL branch run in JavaScript agrees with the TypeScript rules", () => {
  it("the house fold folds the Turkish capitals and diacritics, drops the combining dot and lowers ASCII only", () => {
    expect(sqlFold("Açıklamalar İŞÇİ Çöp31 ÂÎÛ")).toBe("aciklamalar isci cop31 aiu");
    expect(sqlFold("İ̇")).toBe("i");
    // Other letters are left alone (the C collation lowers ASCII only): a Greek or accented capital is a separator for the regexes.
    expect(sqlFold("ÉA")).toBe("Éa");
  });

  it("the generic rule is true for the spec's strings, false for its negatives, and TypeScript says the same", () => {
    for (const t of GENERIC_TRUE) {
      expect(sqlGeneric(t), t).toBe(true);
      expect(isAblativeStatementTitle(t), t).toBe(true);
      expect(isGenericTitle(t), t).toBe(true);
    }
    for (const t of [...GENERIC_FALSE, ...SENTENCE_FALSE]) {
      expect(sqlGeneric(t), t).toBe(false);
      expect(isAblativeStatementTitle(t), t).toBe(false);
      expect(isGenericTitle(t), t).toBe(false);
    }
  });

  it("the h165 review's titles: a sentence or a topic in front of the speaker's line is no placeholder, raw or stored", () => {
    for (const raw of [
      "Rusya'nın ABD Büyükelçisi Aleksandr Darçiyev hayatını kaybetti! Moskova'dan açıklama",
      "Azil süreci başladı! Trump'tan açıklama",
      "KYK burs ve kredilerine 2027'de zam yapılacak! Bakan Bak'tan yeni açıklama",
      ...SENTENCE_FALSE,
    ]) {
      expect(sqlGeneric(raw), raw).toBe(false);
      expect(sqlBranch(raw), raw).toBe(false);
      expect(sqlBranch(cleanHeadline(raw)), raw).toBe(false);
      expect(isAblativeStatementTitle(raw), raw).toBe(false);
    }
  });

  it("the teaser rule is true for the spec's strings, false for its negatives, and TypeScript says the same", () => {
    for (const t of QUESTION_TRUE) {
      expect(sqlTeaser(t), t).toBe(true);
      expect(isQuestionTeaser(t), t).toBe(true);
      expect(isQuestionTitle(t), t).toBe(true);
    }
    for (const t of [...QUESTION_FALSE, ...CAUSATIVE_FALSE]) {
      expect(sqlTeaser(t), t).toBe(false);
      expect(isQuestionTeaser(t), t).toBe(false);
      expect(isQuestionTitle(t), t).toBe(false);
    }
    // The causative and the reported answer are statements the gate takes.
    for (const t of CAUSATIVE_FALSE) expect(isAcceptableNeutral(t, []), t).toBe(true);
  });

  it("the whole branch offers the spec's positives and not its negatives; the gate rejects what it offers", () => {
    for (const t of [...GENERIC_TRUE, ...QUESTION_TRUE]) {
      expect(sqlBranch(t), t).toBe(true);
      expect(isAcceptableNeutral(t, []), t).toBe(false);
    }
    for (const t of [...GENERIC_FALSE, ...SENTENCE_FALSE, ...QUESTION_FALSE, ...CAUSATIVE_FALSE]) expect(sqlBranch(t), t).toBe(false);
  });

  it("a title with the combining dot above (U+0307) is never offered, and TypeScript calls it neither a teaser nor a placeholder", () => {
    for (const t of COMBINING_DOT) {
      expect(sqlBranch(t), t).toBe(false);
      expect(isQuestionTeaser(t), t).toBe(false);
      expect(isAblativeStatementTitle(t), t).toBe(false);
      expect(isAcceptableNeutral(t, []), t).toBe(true);
    }
    // The guard is what keeps them out: the SQL fold deletes the dot, so the rule alone reads a teaser where TypeScript reads none.
    expect(sqlTeaser(COMBINING_DOT[0] as string)).toBe(true);
    // The same for a placeholder: three tokens in SQL, many more in TypeScript.
    const placeholder = "Efkan Ki\u0307li\u0307nç Ma\u0307hmu\u0307t Ba\u0307yra\u0307ktar'dan açıklama";
    expect(sqlGeneric(placeholder)).toBe(true);
    expect(sqlBranch(placeholder)).toBe(false);
    expect(isAblativeStatementTitle(placeholder)).toBe(false);
    // With the dot removed the TypeScript rule reads what the SQL fold read.
    for (const t of [COMBINING_DOT[0] as string, placeholder]) {
      const plain = t.split("\u0307").join("");
      expect(sqlBranch(plain), plain).toBe(true);
      expect(isQuestionTeaser(plain) || isAblativeStatementTitle(plain), plain).toBe(true);
    }
  });

  it("agrees on more shapes: apostrophes, curly marks, capitals, a label before ':' and clause boundaries", () => {
    // [title, SQL verdict, TypeScript verdict when it is wider than SQL's]
    const rows: Array<[string, boolean, boolean?]> = [
      ["CUMHURBAŞKANI ERDOĞAN'DAN AÇIKLAMALAR", true],
      ["Cumhurbaşkanı Erdoğan'dan AÇIKLAMA", true],
      ["Bakan Kurum’dan önemli mesajlar", true],
      ["Bakan Kurum'dan kritik açıklamalar", true],
      ["Bakan Kurum'dan yeni açıklama", true],
      ["Bakan Kurum'a açıklamalar", false],
      ["Bakan Kurum'dan açıklamalar geldi", false],
      ["Bakan Kurum'dan iklim açıklamaları", false],
      ["Bakan Kurum açıklamalar", false],
      // Five tokens in front: TypeScript reads them as a label when none is a verb, SQL reads three at most (a subset).
      ["Cumhurbaşkanlığı Kabinesi Toplantısı'nın ardından Bakan Kurum'dan açıklamalar", false],
      ["Cumhurbaşkanlığı Kabinesi toplantısının ardından Bakan Kurum'dan açıklamalar", false, true],
      // A ':' makes the speaker's line a statement under a topic; a '. ' break is an event label.
      ["Zirve: Bakan Kurum'dan açıklamalar", false],
      ["COP31: Bakan Kurum'dan açıklamalar", false],
      ["Zirve: COP31. Bakan Kurum'dan açıklamalar", true],
      ["COP31. Zirve: Bakan Kurum'dan açıklamalar", false],
      ["Bakan Kurum'dan: açıklamalar", false],
      // A finite verb in front of the line, whatever the break.
      ["COP31 Zirvesi açıldı. Bakan Kurum'dan açıklamalar", false],
      ["Bakan açıkladı Prof. Dr. Ali Kurtulmuş'tan açıklama", false],
      ["Kazada ne oldu: Savcılık açıklama yaptı", true],
      ["Gazze'de neler oldu", true],
      ["Bugün piyasada neler var", true],
      ["Başbakan neden Meclis'e gelmedi", true],
      ["Bakan neden bu kararı almadı", true],
      ["Hangi İl Ne Kadar Oy Aldı", true],
      ["Listede kimler var: İsimler belli oldu", true],
      ["Hangi ilde: kimler var", true],
      ["Müdür nenin ne olduğunu açıkladı", false],
      ["Hangi bakan ilgilendi", false],
      ["Kimler varmış: yeni liste", false],
      ["Kimler var kimler yok, tam liste açıklandı", false],
      ["Bakan neden yaptığını anlattı", false],
      ["Neden bir iki üç dört beş altı etmedi", false],
      ["Bakan toplantıya gelmedi", false],
      ["Bakan neden: toplantıya gelmedi", false],
      ["Hangi: parti ne", false],
      ["Kimler: var", false],
      ["Bakan açıkladı: 'Neden gelmedi bilmiyorum'", false],
      ["Özel: “Listede kimler var”", false],
      ["Bahçeli: \"Ne oldu bu ülkeye\"", false],
      // The clause ends at '!', '?' and '. ' too; a dot with no space after it is no break; 'neden ol-' and a reported answer are no teaser.
      ["Bakan neden gelmedi! Yönetim konuşmadı", true],
      ["Bakan neden gelmedi. Yönetim konuşmadı", true],
      ["Bakan neden istifa etti! Yönetim konuşmadı", false],
      ["Bakan neden Meclis'e. Yönetim konuşmadı", false],
      ["Bakan neden 3.5 puan gelmedi", true],
      ["Bakan neden olmadı", false],
      ["Hangi parti ne oy verdi: Bakan yaptığını açıkladı", true],
      ["Bakan yaptığını söyledi: hangi ilde ne", true],
      ["Bakan hangi ilde ne yaptığını anlattı", false],
      ["Bakan x:yaptığını açıkladı hangi ilde ne", false],
      // A '?' is the gate-fail branch's: this branch leaves it alone.
      ["Genel seçim anketi: Partilerin oy oranı ne oldu?", false],
      ["Cumhurbaşkanı Erdoğan'dan açıklamalar?", false],
    ];
    for (const [title, sql, ts = sql] of rows) {
      expect(sqlBranch(title), title).toBe(sql);
      // TypeScript: the same verdict wherever there is no '?' (and a wider one only where a row says so).
      if (!title.includes("?")) expect(isAblativeStatementTitle(title) || isQuestionTeaser(title), title).toBe(ts);
    }
  });

  it("the prefilters are supersets: with or without them every verdict is the same", () => {
    const corpus = [
      ...GENERIC_TRUE,
      ...GENERIC_FALSE,
      ...SENTENCE_FALSE,
      ...QUESTION_TRUE,
      ...QUESTION_FALSE,
      ...CAUSATIVE_FALSE,
      ...COMBINING_DOT,
      ...FIXTURE_TITLES,
    ];
    expect(corpus.length).toBeGreaterThan(100);
    for (const t of corpus) {
      expect(sqlGeneric(t, true), t).toBe(sqlGeneric(t, false));
      expect(sqlTeaser(t, true), t).toBe(sqlTeaser(t, false));
    }
  });

  it("SQL is a subset of TypeScript: every title the branch offers is a placeholder or a teaser to isGenericTitle / isQuestionTeaser", () => {
    const corpus = [
      ...GENERIC_TRUE,
      ...GENERIC_FALSE,
      ...SENTENCE_FALSE,
      ...QUESTION_TRUE,
      ...QUESTION_FALSE,
      ...CAUSATIVE_FALSE,
      ...FIXTURE_TITLES,
      "Cumhurbaşkanlığı Kabinesi toplantısının ardından Bakan Kurum'dan açıklamalar",
      "Prof. Dr. Ali Kurtulmuş'tan açıklama",
    ];
    // The two rules alone are subsets too, except on the combining dot, which the branch's own guard keeps out (tested above).
    for (const t of corpus) {
      if (sqlGeneric(t)) expect(isAblativeStatementTitle(t), `generic: ${t}`).toBe(true);
      if (sqlTeaser(t)) expect(isQuestionTeaser(t), `teaser: ${t}`).toBe(true);
    }
    let offered = 0;
    for (const t of [...corpus, ...COMBINING_DOT, "Efkan Ki\u0307li\u0307nç Ma\u0307hmu\u0307t Ba\u0307yra\u0307ktar'dan açıklama"]) {
      if (sqlBranch(t)) {
        offered++;
        expect(isAblativeStatementTitle(t) || isQuestionTeaser(t), `branch: ${t}`).toBe(true);
        expect(isAcceptableNeutral(t, []), `gate: ${t}`).toBe(false);
      }
    }
    expect(offered).toBeGreaterThan(10);
  });

  it("the live clusters' stored titles: the branch offers the placeholders and the teasers and none of the casing clusters", () => {
    const offered = GENERIC_FIXTURE.clusters.filter((c) => sqlBranch(c.stored)).map((c) => c.cid);
    expect(offered).toEqual(["67695cbd", "298bbb75", "9df76d26", "ece7ef31", "32a3e53c", "df08098c", "404dda61", "fd7428e8", "9d5ad97a", "1c7c34ba"]);
    expect(CASING_FIXTURE.clusters.filter((c) => sqlBranch(c.stored)).map((c) => c.cid)).toEqual([]);
  });

  it("every member title of the two fixtures, cleaned the way a stored title is: the teaser rules agree, the generic rule is a subset", () => {
    let checked = 0;
    for (const title of FIXTURE_TITLES) {
      if (sqlGeneric(title)) expect(isAblativeStatementTitle(title), title).toBe(true);
      // A '?' is read by TypeScript's teaser rule too; the branch leaves it to 169, so compare the rule itself.
      expect(sqlTeaser(title), title).toBe(isQuestionTeaser(title));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("the port is linear on hostile input: a long title is a few scans, not a blow-up", () => {
    const opts = { n: 250_000, ceilingMs: 8_000 };
    expectLinear(rep("a'dan "), (shape) => sqlBranch(`${shape}açıklamalar`), opts);
    expectLinear(rep("x. "), (shape) => sqlBranch(`${shape}Bakan'dan açıklamalar`), opts);
    expectLinear(rep("neden a "), (shape) => sqlBranch(`${shape}medi`), opts);
    expectLinear(rep("hangi a "), (shape) => sqlBranch(shape), opts);
    expectLinear(rep("hangi a ne "), (shape) => sqlBranch(shape), opts);
    expectLinear(rep("hangi a ne yaptığını "), (shape) => sqlBranch(shape), opts);
    expectLinear(rep("kimler var "), (shape) => sqlBranch(`${shape}x`), opts);
    expectLinear(rep(": "), (shape) => sqlBranch(`${shape}neden medi`), opts);
    expectLinear(rep("! "), (shape) => sqlBranch(`${shape}neden medi`), opts);
    expectLinear(rep("a"), (shape) => sqlBranch(`${shape}dan açıklama`), opts);
    expectLinear(rep("yaptı "), (shape) => sqlBranch(`${shape}Bakan'dan açıklama`), opts);
  });
});

describe("208 neutral_title_repick_generic: the dry-run script and the docs", () => {
  it("has a local dry-run that starts from 200's dry-run, checks production's md5 and applies 208 twice", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toContain("\\ir 200-stale-quote-aware-dryrun.sql");
    expect(dry).toContain(PROD_MD5);
    expect(dry).toContain(String(PROD_LENGTH));
    expect(dry).toContain(NEW_MD5);
    expect(countOf(dry, "\\ir ../../../supabase/migrations/208_neutral_title_repick_generic.sql")).toBe(2);
    expect(dry).toContain("DRYRUN 208 OK");
    expect(dry).toContain("mktemp -d");
    expect(dry).toContain("tests/migrations/sql/stub.sql");
    expect(dry).toContain("run-live.sh");
  });

  it("the header's measurements are the ones of this branch: 12 clusters offered, residue 2 against a limit of 3", () => {
    const head = flat(header208());
    expect(head).toContain("plus 12");
    expect(head).toContain("Measured on the 12: 2, 1c7c34ba");
    expect(head).toContain("against 3 as the limit");
    expect(head).toContain("130.6 and 136.4 ms");
    expect(head).toContain("254.3, 266.4 and 254.0 ms");
    expect(head).toContain("3,516 clusters");
    expect(head).toContain("0 disagreements");
  });

  it("the header says what the h165 review narrowed: the subset, the colon, the verb, the causative, the combining dot", () => {
    const head = flat(header208());
    for (const phrase of [
      "SUBSET of the TypeScript verdict",
      "no ':' in it",
      "finite verb",
      "neden ol",
      "combining dot above (U+0307)",
      "pg_catalog.chr(775)",
      "reported answer",
    ]) {
      expect(head, phrase).toContain(phrase);
    }
    // The old pins are gone from the header.
    expect(head).not.toContain("be4f5425ef62a233f125e593eeb14708");
    expect(head).not.toContain("plus 13");
  });
});
