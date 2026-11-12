import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { cleanHeadline, EXTRACTIVE_MODEL_ID, incumbentIsMemberTitle } from "../../src/lib/clusters/neutral-title";

// ---------------------------------------------------------------------------
// Contract test for migration 200 ("neutral_title_stale_quote_aware"), h140-seo-1 (hunt 140).
//
// bffb0a3f-a552-45d6-a2fd-a2f69050c73b serves "CHP'nin şaibeli kurultay davası 18 Kasım'a ertelendi", an Akşam headline Akşam edited
// away on 2026-11-11 12:18Z, as its neutral title (h1, <title>, og:title, JSON-LD, /rss.xml). 162's stale branch offers a stored
// title that an outlet's old_title (last 7 days) holds and no current member holds, but its key,
// regexp_replace(tayf_search_fold(x), '[^a-z0-9]+', '', 'g'), removed every quotation mark: Milliyet, Yeni Şafak, Posta and
// haberler-com write 'şaibeli kurultay' in scare quotes and so "carried" the bare title. The TypeScript twin of the check
// (incumbentIsMemberTitle in neutral-title.ts) had the same blind spot.
//
// 200 re-creates the function with 184's text and ONE change: the key becomes quote-aware (a quotation mark outside a word is kept as
// chr(1), the sentinel; the sentinels at the two ends of the key are dropped), on all seven key expressions of the stale CTE. This
// file pins, without a database: the ledger row and the single transaction, additive-only SQL, 184's body is production's (md5
// pinned, recomputed from the file), that 200's body is 184's byte for byte with exactly the seven substitutions, the grants, the
// comment, the header's numbers, and, by running the SQL key's regular expressions in JavaScript on the text of the file, that the
// SQL key and the TypeScript key reach the same verdict on a corpus (the live dry-run, tests/migrations/sql/200-stale-quote-aware-
// dryrun.sql, runs the shipped function in PostgreSQL; it has no live-manifest entry, so there is no TAYF_PSQL block here).
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_184 = "184_neutral_title_repick_young_and_shout.sql";
const FILE_199 = "199_entity_cluster_ids_v4_offset.sql";
const FILE_200 = "200_neutral_title_stale_quote_aware.sql";
const MIGRATION_184 = resolve(MIGRATIONS_DIR, FILE_184);
const MIGRATION_200 = resolve(MIGRATIONS_DIR, FILE_200);
const DRYRUN_184 = resolve(__dirname, "sql", "184-repick-young-shout-dryrun.sql");
const DRYRUN_200 = resolve(__dirname, "sql", "200-stale-quote-aware-dryrun.sql");
const NEUTRAL_TITLE_TS = resolve(ROOT, "src", "lib", "clusters", "neutral-title.ts");
const FIXTURE = resolve(ROOT, "src", "lib", "clusters", "__fixtures__", "h140-saibe.json");

/** Production, read-only, 2026-11-12 ~01:30Z: md5(prosrc), length(prosrc) and the attributes of the function 200 starts from. */
const PROD_MD5 = "f53e452579b59bffc6fbc0f547c852e8";
const PROD_LENGTH = 3040;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('200', '200_neutral_title_stale_quote_aware') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

// The key, as 184 spells it and as 200 spells it. `x` is the folded expression.
const LEGACY_REPLACE = "pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')";
const OLD_KEY = (x: string): string => `pg_catalog.regexp_replace(public.tayf_search_fold(${x}), '[^a-z0-9]+', '', 'g')`;
/** The SQL literal of the mark pattern, doubled single quotes and all. */
const SQL_MARK_LITERAL = `'(?<![a-z0-9])[''‘’"“”«»]|[''‘’"“”«»](?![a-z0-9])'`;
const NEW_KEY = (x: string): string =>
  "pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(pg_catalog.regexp_replace(" +
  `public.tayf_search_fold(${x}), pg_catalog.chr(1), '', 'g'), ` +
  `${SQL_MARK_LITERAL}, pg_catalog.chr(1), 'g'), ` +
  "'[^a-z0-9' || pg_catalog.chr(1) || ']+', '', 'g'), " +
  "'^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$', '', 'g')";
/** The seven key expressions of 184's stale CTE: the argument folded, and how often 184 uses it. */
const KEY_USES: ReadonlyArray<readonly [string, number]> = [
  ["v.old_title", 1],
  ["c.title_tr_neutral", 4],
  ["a2.title", 1],
  [LEGACY_REPLACE, 1],
];

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

/** `create or replace function ... as ` up to and including the opening $fn$ marker (the code, not the comment header). */
function functionHeader(sql: string): string {
  const code = sql.indexOf("\nbegin;");
  const at = sql.indexOf("create or replace function", code);
  const open = sql.indexOf("$fn$", at);
  expect(at, "create or replace function").toBeGreaterThanOrEqual(0);
  return sql.slice(at, open + 4);
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

const sql184 = readFileSync(MIGRATION_184, "utf8");
const body184 = functionBody(sql184);
const sql200 = existsSync(MIGRATION_200) ? readFileSync(MIGRATION_200, "utf8") : "";
const header200 = (): string => {
  expect(existsSync(MIGRATION_200), `${FILE_200} must exist`).toBe(true);
  return sql200.split("\nbegin;")[0] as string;
};
const body200 = (): string => {
  expect(existsSync(MIGRATION_200), `${FILE_200} must exist`).toBe(true);
  return functionBody(sql200);
};

/** 184's body with the seven key expressions replaced by 200's. */
function body184Rekeyed(): string {
  let t = body184;
  for (const [x] of KEY_USES) t = t.split(OLD_KEY(x)).join(NEW_KEY(x));
  return t;
}

describe("200 neutral_title_stale_quote_aware: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 200", () => {
    expect(existsSync(MIGRATION_200)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("200_"))).toEqual([FILE_200]);
  });

  it("sits after 199 and leaves 184 alone (184 is the rollback target)", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, FILE_199))).toBe(true);
    expect(body184).toContain("pg_catalog.regexp_replace(public.tayf_search_fold(v.old_title), '[^a-z0-9]+', '', 'g') as fo");
    expect(body184).not.toContain("chr(1)");
  });

  it("runs in one transaction with a bounded lock wait and statement time", () => {
    const stmts = statements(sql200);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
    expect(countOf(sql200, "\nbegin;")).toBe(1);
    expect(countOf(sql200, "\ncommit;")).toBe(1);
  });

  it("records version 200 in the schema_migrations ledger, idempotently (the 140-199 convention), as the last statement before commit", () => {
    const code = collapse(stripComments(sql200));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });
});

describe("200 neutral_title_stale_quote_aware: the production fingerprint it was built from", () => {
  it("184's function body is production's body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body184)).toBe(PROD_MD5);
    expect([...body184].length).toBe(PROD_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 184's body", () => {
    const header = flat(header200());
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5);
    expect(header).toContain(`length ${PROD_LENGTH}`);
    expect(header).toContain("prosecdef t, provolatile s");
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain(PROD_PROACL);
    expect(header).toContain("equals the md5 of 184's body");
    expect(header).toContain("recomputes the md5 of 184's body");
  });

  it("the header names the evidence: bffb0a3f, Akşam's edit, the scare-quoting outlets, and why 162's key missed it", () => {
    const header = flat(header200());
    expect(header).toContain("bffb0a3f-a552-45d6-a2fd-a2f69050c73b");
    expect(header).toContain("CHP'nin şaibeli kurultay davası 18 Kasım'a ertelendi");
    expect(header).toContain("823303");
    expect(header).toContain("823721");
    for (const outlet of ["Milliyet", "Yeni Şafak", "Posta", "haberler-com"]) expect(header, outlet).toContain(outlet);
    expect(header).toContain("removes every quotation mark");
    expect(header).toContain("incumbentIsMemberTitle");
    expect(header).toContain("memberKey");
    expect(header).toContain("This is not the v6 heal");
  });

  it("the header states the rule: the sentinel is chr(1) and not a pipe, the marks, the trim, and all seven expressions", () => {
    const header = flat(header200());
    expect(header).toContain("chr(1), not '|'");
    expect(header).toContain("9df76d26");
    expect(header).toContain("SEVEN key expressions of 184 (the finding counts six)");
    expect(header).toContain("v.old_title, c.title_tr_neutral four times");
    expect(header).toContain("a2.title twice");
    expect(header).toContain("'(?<![a-z0-9])[''‘’\"“”«»]|[''‘’\"“”«»](?![a-z0-9])'");
    expect(header).toContain("(d) the chr(1) at the two ends of the key are removed");
    expect(header).toContain("a stored first-person title that carries quotes");
    expect(header).toContain("THERE IS NO NEW LOOP");
  });

  it("the header carries the replay, the cost, the release order and the deadline", () => {
    const header = flat(header200());
    expect(header).toContain("REPLAY (production, read-only, 2026-11-12");
    expect(header).toContain("1,356 clusters");
    expect(header).toContain("ONE stops carrying it under the new key, bffb0a3f");
    expect(header).toContain("184's body offers 0 rows, 200's body offers 1");
    expect(header).toContain("THE COST");
    expect(header).toContain("RELEASE ORDER. DEPLOY the app FIRST");
    expect(header).toContain("THEN APPLY 200");
    expect(header).toContain("DEADLINE");
    expect(header).toContain("2026-11-18 12:18Z");
    expect(header).toContain("The migration is not applied by the PR");
  });

  it("VERIFY step 1 carries the md5 and the length of THIS file's function body", () => {
    const body = body200();
    const header = flat(header200());
    expect(header).toContain(`-> ${md5(body)}, ${[...body].length} (was ${PROD_MD5}, ${PROD_LENGTH})`);
    expect(header).toContain("prosrc contains pg_catalog.chr(1)");
    expect(header).toContain("select id from public.neutral_title_repick_candidates('extractive-v6', 50)");
  });

  it("the rollback re-runs 184's function, comment, revoke and grant and removes only the 200 ledger row", () => {
    const header = flat(header200());
    expect(header).toContain("ROLLBACK (the previous rule is 184's");
    expect(header).toContain("re-run section 1 of 184_neutral_title_repick_young_and_shout.sql");
    expect(header).toContain("where version = '200'");
    expect(header).toContain(`That restores md5 ${PROD_MD5}`);
  });
});

describe("200 neutral_title_stale_quote_aware: the function", () => {
  it("re-creates the function with create or replace and 184's signature, return columns, language, volatility and search_path", () => {
    const header = functionHeader(sql200);
    expect(header).toBe(functionHeader(sql184));
    expect(header.startsWith(`create or replace function ${FN}(p_model text, p_limit integer default 20)`)).toBe(true);
    expect(header).toContain("returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)");
    expect(header).toContain("language sql\nstable\nsecurity definer\nset search_path = ''\n");
  });

  it("the body is 184's body byte for byte with exactly the seven key expressions rekeyed", () => {
    let seven = 0;
    for (const [x, uses] of KEY_USES) {
      expect(countOf(body184, OLD_KEY(x)), `184 uses the key of ${x}`).toBe(uses);
      seven += uses;
    }
    expect(seven).toBe(7);
    expect(body200()).toBe(body184Rekeyed());
    expect(body200()).not.toBe(body184);
  });

  it("the old quote-blind key is gone and the new one is used seven times", () => {
    const body = body200();
    expect(countOf(body, "'[^a-z0-9]+'")).toBe(0);
    expect(countOf(body, "'[^a-z0-9' || pg_catalog.chr(1) || ']+'")).toBe(7);
    expect(countOf(body, SQL_MARK_LITERAL)).toBe(7);
    expect(countOf(body, "'^' || pg_catalog.chr(1) || '+|' || pg_catalog.chr(1) || '+$'")).toBe(7);
    expect(countOf(body, "public.tayf_search_fold(")).toBe(7);
    expect(countOf(body, "pg_catalog.regexp_replace(")).toBe(7 * 4);
  });

  it("changes nothing outside the stale CTE's key: the lines that are not a key line are 184's, in order", () => {
    const keyLine = (line: string): boolean => line.includes("tayf_search_fold(");
    const a = body184.split("\n").filter((l) => !keyLine(l));
    const b = body200().split("\n").filter((l) => !keyLine(l));
    expect(b).toEqual(a);
    // the key lines are the same lines, in the same places
    const lines184 = body184.split("\n");
    const lines200 = body200().split("\n");
    expect(lines200).toHaveLength(lines184.length);
    lines184.forEach((line, i) => {
      expect(keyLine(lines200[i] as string), `line ${i + 1}`).toBe(keyLine(line));
    });
  });

  it("keeps 184's branches, windows and limit verbatim", () => {
    const body = body200();
    for (const piece of [
      "where v.seen_at > pg_catalog.now() - interval '7 days'",
      "c.updated_at > pg_catalog.now() - interval '14 days'",
      "limit 5000",
      "where w.title_neutral_model is distinct from p_model",
      "or w.title_neutral_member_count is null",
      "or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))",
      "or w.id in (select cluster_id from stale)",
      "w.title_neutral_member_count <= 2",
      "(w.title_tr_neutral ~ '[A-ZÇĞİÖŞÜ]'",
      "w.title_tr_neutral !~ '[a-zçğıöşüâîû]')",
      "limit least(greatest(coalesce(p_limit, 20), 1), 50);",
    ]) {
      expect(body, piece).toContain(piece);
    }
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty)", () => {
    const code = sansStrings(stripComments(body200())).replace(/\bis distinct from\b/gi, "is distinct to");
    for (const rel of [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string)) {
      if (rel === "stale") continue; // the CTE
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\./);
    }
    expect(code).not.toMatch(/(?<![\w.])now\(\)/);
    expect(code).not.toMatch(/(?<![\w.])strpos\(/);
    expect(code).not.toMatch(
      /(?<![\w.])(?:lower|upper|translate|regexp_replace|replace|char_length|btrim|length|chr|concat|array_to_string)\(/,
    );
  });

  it("the sentinel is chr(1), never a pipe, and no regex marker is built from '|' outside the trim", () => {
    const body = body200();
    expect(body).toContain("pg_catalog.chr(1)");
    expect(countOf(body, "'|'")).toBe(0);
    expect(countOf(body, "||")).toBe(7 * 6); // per key: two concatenations in the filter's class, four in the trim's pattern
  });

  it("the function comment states the quote rule and lists migrations 141, 155, 162, 169, 184, 200", () => {
    // the comment is written as adjacent string literals; read it as one
    const comment = statementStartingWith(sql200, "comment on function").split("' '").join("");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment).toContain("grown by half (at least +3)");
    expect(comment).toContain("title an outlet has since edited away");
    expect(comment).toContain("a key that keeps a quotation mark outside a word");
    expect(comment).toContain("a member that writes a span in quotes does not carry it bare");
    expect(comment).toContain("fails the acceptance gate on length or a question mark");
    expect(comment).toContain("stamped at 2 or fewer members that has grown to 3 or more");
    expect(comment).toContain("holds letters and no lower case");
    expect(comment).toContain("Migrations 141, 155, 162, 169, 184, 200.");
    expect(comment).not.toContain("Migrations 141, 155, 162, 169, 184.");
  });
});

describe("200 neutral_title_stale_quote_aware: privileges", () => {
  const code = `${statements(sql200).join(";\n")};`;

  it("re-states the grants: revoke from public/anon/authenticated, grant execute to service_role", () => {
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(sql200).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("200 neutral_title_stale_quote_aware: additive, no data is written", () => {
  const stmts = statements(sql200);

  it("holds only the transaction frame, the timeouts, one function, its comment, its privileges, the notify and the ledger row", () => {
    const expected = [
      "begin",
      "set local lock_timeout",
      "set local statement_timeout",
      "create or replace function",
      "comment on function",
      "revoke all on function",
      "grant execute on function",
      "notify pgrst",
      "insert into supabase_migrations.schema_migrations",
      "commit",
    ];
    expect(stmts).toHaveLength(expected.length);
    expected.forEach((prefix, i) => {
      expect((stmts[i] as string).toLowerCase().startsWith(prefix), `${i}: ${stmts[i]}`).toBe(true);
    });
  });

  it("has no update, delete, truncate, alter, drop, create table or create index statement, and the function body writes nothing", () => {
    const sans = sansStrings(stmts.join(";\n")).toLowerCase();
    expect(sans).not.toMatch(/(^|\s)update\s+public\./);
    expect(sans).not.toMatch(/(^|\s)delete\s+from\b/);
    expect(sans).not.toMatch(/\btruncate\b/);
    expect(sans).not.toMatch(/\balter\s+(table|function|role|default)/);
    expect(sans).not.toMatch(/\bdrop\s+/);
    expect(sans).not.toMatch(/\bcreate\s+(table|index|unique|trigger|extension)/);
    const body = sansStrings(stripComments(body200())).toLowerCase();
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate)\b/);
  });

  it("the one insert is the ledger row, written the way 155, 162, 169 and 184 do", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([LEDGER_STMT.slice(0, -1)]);
  });

  it("does not bump EXTRACTIVE_MODEL_ID (no model bump, no LLM)", () => {
    expect(EXTRACTIVE_MODEL_ID).toBe("extractive-v6");
    expect(readFileSync(NEUTRAL_TITLE_TS, "utf8")).toContain('export const EXTRACTIVE_MODEL_ID = "extractive-v6";');
  });
});

// ---------------------------------------------------------------------------
// The SQL key, run in JavaScript from the text of the file, against the TypeScript key.
// ---------------------------------------------------------------------------

/** tayf_search_fold of migration 129: translate the Turkish letters (and drop U+0307), then lower-case ASCII only (collate "C"). */
const FOLD_FROM = "İIıŞşĞğÜüÖöÇçÂâÎîÛû̇";
const FOLD_TO = "iiissgguuooccaaiiuu";
function sqlFold(s: string): string {
  let out = "";
  for (const ch of s) {
    const at = FOLD_FROM.indexOf(ch);
    if (at >= FOLD_TO.length) continue; // translate drops a character that has no counterpart
    out += at >= 0 ? FOLD_TO.charAt(at) : ch;
  }
  return out.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

/** The JS source of the SQL mark pattern: the SQL literal without its outer quotes and with doubled quotes collapsed. */
const MARK_PATTERN = new RegExp(SQL_MARK_LITERAL.slice(1, -1).split("''").join("'"), "g");

/** NEW_KEY(x), step by step, on the text the file ships (the literals are asserted to be in it above). */
function sqlKey(x: string): string {
  const marked = sqlFold(x).split("\u0001").join("").replace(MARK_PATTERN, "\u0001");
  const kept = marked.replace(/[^a-z0-9\u0001]+/g, "");
  let start = 0;
  let end = kept.length;
  while (start < end && kept.charAt(start) === "\u0001") start++;
  while (end > start && kept.charAt(end - 1) === "\u0001") end--;
  return kept.slice(start, end);
}

/** The anti-join of the stale CTE: is the stored title carried by some member (plain or with the legacy house-style rewrite)? */
function sqlCarried(stored: string, members: readonly string[]): boolean {
  const own = sqlKey(stored);
  if (own === "") return true; // 184's `<> ''` guard keeps such a title out of the stale set
  return members.some(
    (m) =>
      sqlKey(m).includes(own) || sqlKey(m.split("Başkan Erdoğan").join("Cumhurbaşkanı Erdoğan")).includes(own),
  );
}

interface H140Fixture {
  stored: string;
  members: Array<{ source: string; title: string }>;
  aksamOldTitles: Array<{ old_title: string }>;
}
const H140 = JSON.parse(readFileSync(FIXTURE, "utf8")) as H140Fixture;
const H140_TITLES = H140.members.map((m) => m.title);
const SERVED = "CHP'nin şaibeli kurultay davası 18 Kasım'a ertelendi";
const SCARE_QUOTED = "CHP'nin 'şaibeli kurultay' davası 18 Kasım'a ertelendi";

/** [label, stored title, member titles, carried?]: the dry-run's scenarios and the fixture, judged by both keys. */
const CORPUS: ReadonlyArray<readonly [string, string, readonly string[], boolean]> = [
  ["bffb0a3f: the served title against the 36 current members", SERVED, H140_TITLES, false],
  ["bffb0a3f: with Akşam's 11:45 title among the members", SERVED, [...H140_TITLES, H140.aksamOldTitles[1]!.old_title], true],
  ["bffb0a3f: the scare-quoted wording is carried by Milliyet, Yeni Şafak and Posta", SCARE_QUOTED, H140_TITLES, true],
  ["bffb0a3f: the clean wording is carried by haber-global and dokuz8", "CHP'nin kurultay davası 18 Kasım'a ertelendi", H140_TITLES, true],
  ["a straight-quoted span against the bare title", "Bakan zam yok dedi ve açıkladı", ["Bakan 'zam yok' dedi ve açıkladı"], false],
  ["a curly-quoted span", "Bakan zam yok dedi ve açıkladı", ["Bakan ‘zam yok’ dedi ve açıkladı"], false],
  ["a double-quoted span", "Bakan zam yok dedi ve açıkladı", ['Bakan "zam yok" dedi ve açıkladı'], false],
  ["a curly double-quoted span", "Bakan zam yok dedi ve açıkladı", ["Bakan “zam yok” dedi ve açıkladı"], false],
  ["a guillemet-quoted span", "Bakan zam yok dedi ve açıkladı", ["Bakan «zam yok» dedi ve açıkladı"], false],
  ["the reverse: a bare member against a stored quoted span", "Bakan 'zam yok' dedi ve açıkladı", ["Bakan zam yok dedi ve açıkladı"], false],
  ["one quote kind against another", "Bakan 'zam yok' dedi ve açıkladı", ["Bakan «zam yok» dedi ve açıkladı"], true],
  ["a bare member next to a quoting one", "Bakan zam yok dedi ve açıkladı", ["Bakan 'zam yok' dedi ve açıkladı", "Bakan zam yok dedi ve açıkladı"], true],
  ["curly against straight in-word apostrophes", "CHP'nin kurultay davası 18 Kasım'a ertelendi", ["CHP’nin kurultay davası 18 Kasım’a ertelendi"], true],
  ["a stored title wrapped in quotes against the bare member (the pinned h94 test)", '"Diplomatik çözüm için çalışıyoruz"', ["Diplomatik çözüm için çalışıyoruz"], true],
  ["a bare stored title against a wrapped member", "Diplomatik çözüm için çalışıyoruz", ["“Diplomatik çözüm için çalışıyoruz”"], true],
  ["a stray leading quote the cleaning dropped", "Kaşif Kozinoğlu'nun ATK raporu: 'Ölüm nedeni' açıklandı", ["'Kaşif Kozinoğlu'nun ATK raporu: 'Ölüm nedeni' açıklandı"], true],
  ["a quote that closes inside the title", "Ölüm nedeni açıklandı", ["'Ölüm nedeni' açıklandı"], false],
  ["a literal pipe is a separator", "Merkez Bankası faiz kararını açıkladı", ["Merkez Bankası | faiz kararını açıkladı"], true],
  ["a literal U+0001 is not a quote", "Bakan zam yok dedi ve açıkladı", ["Bakan \u0001zam yok\u0001 dedi ve açıkladı"], true],
  ["the legacy house style", "Cumhurbaşkanı Erdoğan sert konuştu", ["Başkan Erdoğan sert konuştu"], true],
  ["the legacy house style, quoted in the member", "Cumhurbaşkanı Erdoğan sert konuştu", ["Başkan Erdoğan 'sert' konuştu"], false],
  ["a lead-in and a different case", "CHP kurultay davası 18 Kasım'a ertelendi", ["SON DAKİKA | CHP KURULTAY DAVASI 18 KASIM'A ERTELENDİ"], true],
  ["recased and re-separated", "Merkez Bankası faiz kararını açıkladı", ["MERKEZ BANKASI: FAİZ KARARINI AÇIKLADI"], true],
  ["a different title", "Merkez Bankası faiz kararını açıkladı", ["Merkez Bankası faiz oranını sabit tuttu"], false],
  ["no members", SERVED, [], false],
];

describe("200 neutral_title_stale_quote_aware: the SQL key, run on the text of the file", () => {
  it("the mark pattern, the sentinel and the trim run in JavaScript are the file's own literals", () => {
    const body = body200();
    expect(body).toContain(SQL_MARK_LITERAL);
    expect(MARK_PATTERN.source).toBe("(?<![a-z0-9])['‘’\"“”«»]|['‘’\"“”«»](?![a-z0-9])");
  });

  it("builds the key step by step: marks outside words become one sentinel, in-word apostrophes and the ends vanish", () => {
    expect(sqlKey("CHP'nin 'şaibeli kurultay' davası")).toBe("chpnin\u0001saibelikurultay\u0001davasi");
    expect(sqlKey("CHP'nin şaibeli kurultay davası")).toBe("chpninsaibelikurultaydavasi");
    expect(sqlKey('"Bu bir test"')).toBe("bubirtest");
    expect(sqlKey("“Bu” ‘bir’ «test»")).toBe("bu\u0001\u0001bir\u0001\u0001test");
    expect(sqlKey("Erdoğan’dan Kasım’a 10'luk")).toBe("erdogandankasima10luk");
    expect(sqlKey("a\u0001b 'c'")).toBe("ab\u0001c");
    expect(sqlKey("''")).toBe("");
    expect(sqlKey("")).toBe("");
  });

  it.each(CORPUS.map((c) => [c[0], c] as const))("%s: the SQL key and the TypeScript key both say what the dry-run says", (_label, c) => {
    const [, stored, members, carried] = c;
    expect(sqlCarried(stored, members)).toBe(carried);
    expect(incumbentIsMemberTitle(stored, members)).toBe(carried);
  });

  it("agrees with incumbentIsMemberTitle on 600 generated title pairs (a member the cleaning leaves alone)", () => {
    // A small alphabet of words and marks, a fixed seed: every pair is stored title x one member title.
    const words = ["ak", "bakan", "çözüm", "şaibe", "dava", "42", "kurultay", "üç", "ö"];
    const marks = ["'", "’", "‘", '"', "“", "”", "«", "»", "|", ":", ","];
    let seed = 20261112;
    const next = (n: number): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const title = (): string => {
      let t = "";
      const n = 1 + next(5);
      for (let i = 0; i < n; i++) {
        if (next(3) === 0) t += marks[next(marks.length)] as string;
        t += words[next(words.length)] as string;
        if (next(4) === 0) t += marks[next(marks.length)] as string;
        if (next(5) === 0) t += "'" + (["nin", "a", "dan"][next(3)] as string);
        t += next(8) === 0 ? "  " : " ";
      }
      return t.trim();
    };
    let compared = 0;
    let carriedCount = 0;
    const disagreements: string[] = [];
    for (let i = 0; i < 6000 && compared < 600; i++) {
      const stored = title();
      // Half the pairs are one title against a variant of itself with different marks, so the carried ones are not rare.
      const member = next(2) === 0 ? title() : stored.split(" ").map((w) => (next(3) === 0 ? `'${w}'` : w)).join(" ");
      if (cleanHeadline(member) !== member.trim()) continue; // branch 2 of incumbentIsMemberTitle is not in the SQL
      if (member.includes("Başkan Erdoğan")) continue;
      compared++;
      const sql = sqlCarried(stored, [member]);
      const ts = incumbentIsMemberTitle(stored, [member]);
      if (sql) carriedCount++;
      if (sql !== ts) disagreements.push(`${JSON.stringify(stored)} | ${JSON.stringify(member)}: sql ${sql}, ts ${ts}`);
    }
    expect(compared).toBe(600);
    expect(carriedCount).toBeGreaterThan(60);
    expect(carriedCount).toBeLessThan(540);
    expect(disagreements).toEqual([]);
  });
});

describe("200 neutral_title_stale_quote_aware: the TypeScript half is in step", () => {
  const ts = readFileSync(NEUTRAL_TITLE_TS, "utf8");

  it("neutral-title.ts keeps a quote mark outside a word as U+0001, which the file writes chr(1)", () => {
    expect(ts).toContain('const KEY_QUOTE_SENTINEL = "\\u0001";');
    expect(ts).toContain("Migration 200");
    expect(ts).toContain("h140-seo-1");
  });

  it("'şaibe' is in the loaded-word list next to 'butlan CHP'si', for h140 and bffb0a3f", () => {
    const at = ts.indexOf("butlan\\\\s+chp");
    expect(at).toBeGreaterThan(0);
    const after = ts.slice(at, at + 900);
    expect(after).toContain("SAIBE_FOLDED");
    expect(after).toContain("h140-seo-1");
    expect(after).toContain("bffb0a3f");
  });
});

describe("200 the dry-run script", () => {
  const dry = existsSync(DRYRUN_200) ? readFileSync(DRYRUN_200, "utf8") : "";

  it("exists, with the stub, the mktemp data dir and the runner line in its header (the live-harness header check)", () => {
    expect(existsSync(DRYRUN_200)).toBe(true);
    const head = dry.split("\n").slice(0, 40).join("\n");
    expect(head).toContain("-f tests/migrations/sql/stub.sql");
    expect(head).toContain("D=$(mktemp -d)");
    expect(head).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("builds 184's state with 184's own dry-run, gates on 184's production md5, shows the defect, applies 200 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN_184)).toBe(true);
    expect(dry).toContain("\\ir 184-repick-young-shout-dryrun.sql");
    expect(dry).toContain(`'${PROD_MD5}'`);
    expect(dry).toContain(String(PROD_LENGTH));
    expect(countOf(dry, "\\ir ../../../supabase/migrations/200_neutral_title_stale_quote_aware.sql")).toBe(2);
    expect(dry).toContain(`'${md5(body200())}'`);
    expect(dry).toContain(String([...body200()].length));
    expect(dry).toContain("184 offers a stored title that its members only carry in quotes");
    expect(dry.trimEnd().endsWith("select 'DRYRUN 200 OK';")).toBe(true);
  });

  it("covers the quote kinds, the bare member, the pinned cases, the window, the loop and the bounds", () => {
    for (const piece of [
      "the bffb0a3f-shaped cluster should be offered",
      "a member that carries the stored title bare must keep the cluster out",
      "every quotation mark should make the member quote the span",
      "a title the old key judged carried must stay carried",
      "chr(1)",
      "'Merkez Bankası | faiz kararını açıkladı'",
      "interval '8 days'",
      "the stale loop is wrong",
      "bounds changed",
      "a rolled-back fixture survived",
    ]) {
      expect(dry, piece).toContain(piece);
    }
  });
});
