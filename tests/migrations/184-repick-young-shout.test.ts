import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isAcceptableNeutral, pickNeutralTitle } from "../../src/lib/clusters/neutral-title";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 184 ("neutral_title_repick_young_and_shout"), h94-neutraltitles-1.
//
// The headline cron re-picks an extractive title through public.neutral_title_repick_candidates. Since 169 the function
// offers a stamped cluster after a model change, a NULL stamp, growth by half (at least +3), an outlet edit of the stored
// title or growth by one member while the stored title fails the length / '?' gate. Two gaps are left:
//
//   YOUNG. A title stamped at 2 members is not offered again until 5 (2 + greatest(3, ceil(2 / 2))). 209 extractive-v6
//   clusters of the last 14 days sit in that window (stamp <= 2, now 3 or 4 members), and one re-offer would change 23 of
//   their titles, among them 'İşgalci İsrail'in koalisyon kabusu: ...' (f771e177), '... Vali'ye zehir zemberek açıklama'
//   (15b4041e) and 'Cumhurbaşkanı Erdoğan'dan Azerbaycan'da önemli açıklamalar' (459a7b61).
//
//   SHOUT. An all-capitals floor title never heals. The re-pick runs without { floor }, so pickNeutralTitle returns null when
//   no member passes the gate (shouting is a gate defect) and the cron keeps the stored title: 09f152ec 'NEV'İN MİRASI
//   GÜNDEM OLDU' (neutral-title.ts cites 'Nev'in mirası gündem oldu' as the fixed form) and fe2c6725 'PENDİK VERGİ DAİRESİ
//   MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ', both stamped 2 with 2 members, v6, live as index,follow.
//
// 184 re-creates the function with 169's text and TWO extra branches at the end of the outer WHERE. The cron passes
// { floor } when the stored title fails the gate, so a shouted title comes back sentence-cased and leaves the shout branch.
//
// This file pins, without a database: the ledger row and the single transaction, additive-only SQL, 169's body is
// production's (md5 pinned, recomputed from the file), that 184's body is 169's byte for byte with exactly the two added
// branches, that the character classes are explicit Turkish ones, the grants, the cron call, the docs section, the dry-run
// script and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs the function against fixtures.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_169 = "169_neutral_title_repick_gate_fail.sql";
const FILE_183 = "183_intraday_targets_session_window.sql";
const FILE_184 = "184_neutral_title_repick_young_and_shout.sql";
const MIGRATION_169 = resolve(MIGRATIONS_DIR, FILE_169);
const MIGRATION_184 = resolve(MIGRATIONS_DIR, FILE_184);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "184-repick-young-shout-dryrun.sql");
const NEUTRAL_TITLE_TS = resolve(ROOT, "src", "lib", "clusters", "neutral-title.ts");
const HEADLINE_ROUTE = resolve(ROOT, "src", "app", "api", "cron", "headline", "route.ts");

/** Production, read-only, 2026-11-09 ~04:20Z: md5(prosrc), length(prosrc) and the attributes of the function 184 starts from. */
const PROD_MD5 = "c5a3b354ff0f51ef77fae5b3fbf11b0a";
const PROD_LENGTH = 2745;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;

/** 169's last branch ends with this line; 184's two branches are appended after it. */
const GATE_BRANCH_END = "pg_catalog.strpos(w.title_tr_neutral, '?') > 0))\n";
const ORDER_LINE = "   order by w.updated_at desc\n";
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('184', '184_neutral_title_repick_young_and_shout') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** The two Turkish character classes of the shout branch (explicit letters, never [[:lower:]] / [[:upper:]]). */
const UPPER_CLASS = "[A-ZÇĞİÖŞÜ]";
const LOWER_CLASS = "[a-zçğıöşüâîû]";

/** The branches, whitespace collapsed (the file lays each out over several lines). */
const YOUNG_BRANCH =
  "or (w.title_neutral_member_count is not null and w.title_neutral_member_count <= 2 and w.article_count >= 3 and " +
  "w.article_count > w.title_neutral_member_count)";
const SHOUT_BRANCH = `or (w.title_tr_neutral ~ '${UPPER_CLASS}' and w.title_tr_neutral !~ '${LOWER_CLASS}')`;
const NEW_BRANCHES = `${YOUNG_BRANCH} ${SHOUT_BRANCH}`;

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
  const at = sql.indexOf("create or replace function");
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

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

const sql169 = readFileSync(MIGRATION_169, "utf8");
const body169 = functionBody(sql169);
const sql184 = existsSync(MIGRATION_184) ? readFileSync(MIGRATION_184, "utf8") : "";
const header184 = (): string => {
  expect(existsSync(MIGRATION_184), `${FILE_184} must exist`).toBe(true);
  return sql184.split("\nbegin;")[0] as string;
};
const body184 = (): string => {
  expect(existsSync(MIGRATION_184), `${FILE_184} must exist`).toBe(true);
  return functionBody(sql184);
};

/** 184's body with the added branches cut out: the lines between 169's gate-fail branch and the final order by. */
function bodyWithoutNewBranches(body: string): { rest: string; added: string } {
  const at = body.indexOf(GATE_BRANCH_END);
  expect(at, "169's gate-fail branch is kept").toBeGreaterThan(0);
  const from = at + GATE_BRANCH_END.length;
  const to = body.indexOf(ORDER_LINE, from);
  expect(to, "the final order by follows the new branches").toBeGreaterThanOrEqual(from);
  return { rest: body.slice(0, from) + body.slice(to), added: body.slice(from, to) };
}

describe("184 neutral_title_repick_young_and_shout: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 184", () => {
    expect(existsSync(MIGRATION_184)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("184_"))).toEqual([FILE_184]);
  });

  it("sits right after 183 and leaves 169 alone (169 is the rollback target)", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, FILE_183))).toBe(true);
    expect(body169).toContain("pg_catalog.strpos(w.title_tr_neutral, '?') > 0");
    expect(body169).not.toContain("[A-Z");
    expect(body169).not.toContain("<= 2");
  });

  it("runs in one transaction with a bounded lock wait and statement time", () => {
    const stmts = statements(sql184);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
    expect(countOf(sql184, "\nbegin;")).toBe(1);
    expect(countOf(sql184, "\ncommit;")).toBe(1);
  });

  it("records version 184 in the schema_migrations ledger, idempotently (the 140-183 convention), as the last statement before commit", () => {
    const code = collapse(stripComments(sql184));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });
});

describe("184 neutral_title_repick_young_and_shout: the production fingerprint it was built from", () => {
  it("169's function body is production's body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body169)).toBe(PROD_MD5);
    expect([...body169].length).toBe(PROD_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 169's body", () => {
    const header = header184();
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5);
    expect(header).toContain(String(PROD_LENGTH));
    expect(header).toMatch(/prosecdef\s+t/);
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("equals the md5 of 169's body");
  });

  it("the header names the evidence (young and shouted clusters), the numbers and the rollback to 169", () => {
    const header = flat(header184());
    for (const word of [
      "09f152ec",
      "fe2c6725",
      "f771e177",
      "15b4041e",
      "459a7b61",
      "209",
      "23 ",
      "Nev'in mirası gündem oldu",
      "ROLLBACK",
    ]) {
      expect(header, word).toContain(word);
    }
    expect(header).toContain("169_neutral_title_repick_gate_fail.sql");
    expect(header).toContain("version = '184'");
  });

  it("states there is no loop for either branch, and the one residue", () => {
    const header = flat(header184());
    expect(header).toMatch(/stamps title_neutral_member_count = article_count/);
    expect(header).toMatch(/no loop/i);
    expect(header).toMatch(/sentence-cased/);
    expect(header).toMatch(/residue/i);
  });

  it("VERIFY step 1 carries the md5 and the length of THIS file's function body", () => {
    const body = body184();
    expect(header184()).toContain(`${md5(body)}, ${[...body].length} (was ${PROD_MD5}, ${PROD_LENGTH})`);
    expect(md5(body)).not.toBe(PROD_MD5);
  });
});

describe("184 neutral_title_repick_young_and_shout: the function", () => {
  it("re-creates the function with create or replace and 169's signature, return columns, language, volatility and search_path", () => {
    expect(collapse(functionHeader(stripComments(sql184)))).toBe(collapse(functionHeader(stripComments(sql169))));
    const header = collapse(functionHeader(stripComments(sql184))).toLowerCase();
    expect(header).toContain(
      "create or replace function public.neutral_title_repick_candidates(p_model text, p_limit integer default 20)",
    );
    expect(header).toContain(
      "returns table (id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)",
    );
    expect(header).toContain("language sql");
    expect(header).toContain("stable");
    expect(header).toContain("security definer");
    expect(header).toContain("set search_path = ''");
  });

  it("the body is 169's body byte for byte, with exactly two added branches after the gate-fail branch", () => {
    const { rest, added } = bodyWithoutNewBranches(body184());
    expect(rest).toBe(body169);
    expect(collapse(added)).toBe(NEW_BRANCHES);
    // each inserted once
    expect(countOf(collapse(body184()), YOUNG_BRANCH)).toBe(1);
    expect(countOf(collapse(body184()), SHOUT_BRANCH)).toBe(1);
  });

  it("169's body is contained unchanged: everything before the new branches and everything after them", () => {
    const body = body184();
    const at = body169.indexOf(ORDER_LINE);
    expect(at).toBeGreaterThan(0);
    expect(body.startsWith(body169.slice(0, at))).toBe(true);
    expect(body.endsWith(body169.slice(at))).toBe(true);
  });

  it("keeps 169's five predicates verbatim and in order, then the two new branches last", () => {
    const body = collapse(body184());
    const order = [
      "where w.title_neutral_model is distinct from p_model",
      "or w.title_neutral_member_count is null",
      "or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))",
      "or w.id in (select cluster_id from stale)",
      "pg_catalog.strpos(w.title_tr_neutral, '?') > 0))",
      YOUNG_BRANCH,
      SHOUT_BRANCH,
      "order by w.updated_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)",
    ].map((p) => body.indexOf(p));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("adds no new CTE and leaves the stale set and the window untouched", () => {
    const body = collapse(body184());
    expect(body.startsWith("with stale as (")).toBe(true);
    expect(countOf(body, "with stale as")).toBe(1);
    expect(countOf(body, "from stale")).toBe(1);
    expect(body).toContain("c.updated_at > pg_catalog.now() - interval '14 days'");
    expect(body).toContain("order by c.updated_at desc limit 5000");
    expect(body).toContain("c.title_neutral_at is null");
    expect(body).toContain("c.is_archived = false");
    expect(body).toContain("c.article_count >= 2");
  });

  it("the young branch needs a stamp of at most 2, three or more members and growth past the stamp", () => {
    const { added } = bodyWithoutNewBranches(body184());
    const young = collapse(added).slice(0, collapse(added).indexOf(" or (w.title_tr_neutral"));
    expect(young).toBe(YOUNG_BRANCH);
    expect(young).toContain("w.title_neutral_member_count is not null");
    expect(young).toContain("w.title_neutral_member_count <= 2");
    expect(young).toContain("w.article_count >= 3");
    // strictly greater, never >=: a cluster that has not grown since the stamp is not offered again
    expect(young).toContain("w.article_count > w.title_neutral_member_count");
    expect(young).not.toContain("w.article_count >= w.title_neutral_member_count");
  });

  it("the shout branch is letters and no lower case, with explicit Turkish classes", () => {
    const { added } = bodyWithoutNewBranches(body184());
    const shout = collapse(added).slice(collapse(added).indexOf("or (w.title_tr_neutral"));
    expect(shout).toBe(SHOUT_BRANCH);
    expect(shout).toContain(`~ '${UPPER_CLASS}'`);
    expect(shout).toContain(`!~ '${LOWER_CLASS}'`);
    const code = sansStrings(stripComments(added)).toLowerCase();
    expect(code).not.toContain("[:lower:]");
    expect(code).not.toContain("[:upper:]");
    expect(code).not.toMatch(/\b(?:lower|upper)\(/);
    expect(added).not.toContain("[[:");
  });

  it("the classes agree with the picker: a shouted title matches, its sentence-cased repair and a normal headline do not", () => {
    const upper = new RegExp(UPPER_CLASS);
    const lower = new RegExp(LOWER_CLASS);
    const shouts = (t: string): boolean => upper.test(t) && !lower.test(t);
    for (const t of ["NEV'İN MİRASI GÜNDEM OLDU", "PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ", "ÇOCUK ŞEKERİ ÖĞRENCİ ÜÇ GÜN", "ÇAĞRI 2026"]) {
      expect(shouts(t), t).toBe(true);
      expect(isAcceptableNeutral(t, []), `${t}: shouting fails the gate`).toBe(false);
    }
    for (const t of ["Nev'in mirası gündem oldu", "TBMM'de bütçe görüşmeleri sürüyor", "Merkez Bankası faiz kararını açıkladı", "12345 6789 0123 4567"]) {
      expect(shouts(t), t).toBe(false);
    }
    // a lower-case circumflex letter or a dotless i is lower case
    expect(shouts("HAYATÎ âlem")).toBe(false);
    expect(shouts("KARŞI ÇIKTI ı")).toBe(false);
    // the real repair of 09f152ec leaves the branch (the member titles of the live cluster)
    const members = [
      { title: "NEV'İN MİRASI GÜNDEM OLDU" },
      { title: "Nev’in ağabeyi miras için harekete mi geçti? Avukatından sert yanıt: 'Küslük söz konusu değil'" },
    ];
    expect(pickNeutralTitle(members, { incumbent: "NEV'İN MİRASI GÜNDEM OLDU" })).toBeNull();
    const repaired = pickNeutralTitle(members, { incumbent: "NEV'İN MİRASI GÜNDEM OLDU", floor: true });
    expect(repaired).not.toBeNull();
    expect(shouts(repaired as string)).toBe(false);
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty)", () => {
    const code = sansStrings(stripComments(body184())).replace(/\bis distinct from\b/gi, "is distinct to");
    for (const rel of [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string)) {
      if (rel === "stale") continue; // the CTE
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\./);
    }
    expect(code).not.toMatch(/(?<![\w.])now\(\)/);
    expect(code).not.toMatch(/(?<![\w.])strpos\(/);
    expect(code).not.toMatch(/(?<![\w.])(?:lower|upper|translate|regexp_replace|replace|char_length|btrim|length)\(/);
    // the new branches call no function at all: comparisons and the two regex operators only
    const added = sansStrings(stripComments(bodyWithoutNewBranches(body184()).added));
    expect(added).not.toMatch(/[a-z_]\(/);
  });

  it("the function comment states both branches and lists migrations 141, 155, 162, 169, 184", () => {
    const comment = statementStartingWith(sql184, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment).toContain("grown by half (at least +3)");
    expect(comment).toContain("title an outlet has since edited away");
    expect(comment).toContain("fails the acceptance gate on length or a question mark");
    expect(comment).toContain("stamped at 2 or fewer members that has grown to 3 or more");
    expect(comment).toContain("holds letters and no lower case");
    expect(comment).toContain("Migrations 141, 155, 162, 169, 184.");
    expect(comment).not.toContain("Migrations 141, 155, 162, 169.");
  });
});

describe("184 neutral_title_repick_young_and_shout: privileges", () => {
  const code = `${statements(sql184).join(";\n")};`;

  it("re-states the grants: revoke from public/anon/authenticated, grant execute to service_role", () => {
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(sql184).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("184 neutral_title_repick_young_and_shout: additive, no data is written", () => {
  const stmts = statements(sql184);

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
    const body = sansStrings(stripComments(body184())).toLowerCase();
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate)\b/);
  });

  it("the one insert is the ledger row, written the way 155, 162 and 169 do", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([LEDGER_STMT.slice(0, -1)]);
  });

  it("does not bump EXTRACTIVE_MODEL_ID (no model bump, no LLM)", () => {
    const ts = readFileSync(NEUTRAL_TITLE_TS, "utf8");
    expect(ts).toContain('export const EXTRACTIVE_MODEL_ID = "extractive-v6";');
  });
});

describe("184 the cron route re-picks with the floor when the stored title fails the gate", () => {
  const route = readFileSync(HEADLINE_ROUTE, "utf8");
  const prose = route.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
  const code = route.replace(/\s+/g, " ");

  it("passes { incumbent, floor } where floor is the negated gate on the stored title against the member titles", () => {
    expect(code).toContain('isAcceptableNeutral(r.title_tr_neutral ?? "", items.map((i) => i.title))');
    expect(code).toContain("pickNeutralTitle(items, { incumbent: r.title_tr_neutral, floor: storedFailsGate })");
    expect(code).toContain("const storedFailsGate = !isAcceptableNeutral(");
  });

  it("keeps the call, the incumbent and the stamp the earlier re-pick migrations rely on", () => {
    expect(route).toContain('"neutral_title_repick_candidates"');
    expect(route).toContain("incumbent: r.title_tr_neutral");
    expect(route).toContain("title_neutral_member_count: memberCountStamp(r.article_count)");
  });

  it("the RE-PICK comment names both branches of 184 and keeps 169's", () => {
    expect(prose).toContain("migration 184");
    expect(prose).toContain("migration 169");
    expect(prose).toContain("fails the length or '?' gate");
    expect(prose).toContain("stamped at 2 or fewer members");
    expect(prose).toMatch(/all[- ]capitals/);
  });
});

describe("184 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 184 ") ? sectionOf(guide, "184") : "";

  it("sits directly after section 183 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 184 ")).toBeGreaterThan(guide.indexOf("\n## 183 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 183 ") + 1)).toBe(guide.indexOf("\n## 184 "));
  });

  it("has Why, What, an md5 table, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 184 does**", "| md5(prosrc) | length |", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    const body = body184();
    expect(section).toContain(PROD_MD5);
    expect(section).toContain(String(PROD_LENGTH));
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });

  it("states the evidence and the rules", () => {
    for (const word of [
      "09f152ec",
      "fe2c6725",
      "f771e177",
      "459a7b61",
      "209",
      "23",
      "Nev'in mirası gündem oldu",
      "no loop",
      "[A-ZÇĞİÖŞÜ]",
      "[a-zçğıöşüâîû]",
    ]) {
      expect(section, word).toContain(word);
    }
    expect(section).toMatch(/stamps? `?title_neutral_member_count`? = `?article_count`?/);
  });

  it("says apply and deploy: the cron change ships with the app, the migration is not applied by the PR, no model bump", () => {
    expect(section).toContain("APPLY 184");
    expect(section).toContain("DEPLOY");
    expect(section).toMatch(/no `?EXTRACTIVE_MODEL_ID`? bump/);
    expect(section).toMatch(/not applied by the PR/i);
  });

  it("verifies the fingerprint, the privileges, the ledger and the offered rows", () => {
    for (const word of ["md5(prosrc)", "has_function_privilege", "schema_migrations", "version = '184'", "neutral_title_repick_candidates"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs only 169's function, comment, revoke and grant and deletes only the 184 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("169_neutral_title_repick_gate_fail.sql");
    expect(rb).toContain("version = '184'");
    expect(rb).toContain(PROD_MD5);
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("184 live manifest and dry-run", () => {
  it("builds 184's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 184-repick-young-shout.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/184-repick-young-shout-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 169's state (its own dry-run, gated on the production md5), shows both defects, applies 184 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "169-repick-gate-fail-dryrun.sql",
      "../../../supabase/migrations/184_neutral_title_repick_young_and_shout.sql",
      "../../../supabase/migrations/184_neutral_title_repick_young_and_shout.sql",
    ]);
    expect(sql).toContain(PROD_MD5);
    expect(sql).toContain(md5(body184()));
    expect(sql).toContain("baseline: 169 does not offer a cluster stamped at 2 that has 3 members");
    expect(sql).toContain("baseline: 169 does not offer an all-capitals title");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 184 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway Postgres with 162, 169 then 184 applied by the
// dry-run script (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE select the server. Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("184 neutral_title_repick_candidates against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("184", {
    ledger: ["162", "169", "184"],
    relations: ["public.clusters", "public.cluster_articles", "public.article_title_versions"],
    functions: ["public.neutral_title_repick_candidates(text,integer)", "public.tayf_search_fold(text)"],
  });

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8", PGOPTIONS: "-c client_min_messages=warning" },
      maxBuffer: 16 * 1024 * 1024,
    });
  }

  const MODEL = "extractive-v6";
  const clusterUuid = (n: number): string => `c0000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);
  /** A title of n characters (each one multi-byte, so a byte length would give the wrong answer). */
  const chars = (n: number): string => "ç".repeat(n);

  interface Cl {
    n: number;
    title: string | null;
    /** the stamp, title_neutral_member_count (null: never stamped) */
    stamped: number | null;
    count: number;
    model?: string;
    archived?: boolean;
    /** an LLM title: title_neutral_at is set */
    llm?: boolean;
    /** days since updated_at */
    ageDays?: number;
    /** minutes since updated_at, for ordering cases */
    ageMinutes?: number;
  }

  function fixture(rows: Cl[]): string {
    const values = rows
      .map((c) => {
        const age = c.ageMinutes !== undefined ? `interval '${c.ageMinutes} minutes'` : `interval '${c.ageDays ?? 1} days'`;
        return `('${clusterUuid(c.n)}', ${lit(c.title)}, ${lit(c.model ?? MODEL)}, ${c.stamped === null ? "null" : c.stamped}, ${c.count}, ${c.archived ? "true" : "false"}, ${c.llm ? "now()" : "null"}, now() - ${age})`;
      })
      .join(",\n  ");
    return (
      "insert into public.clusters (id, title_tr_neutral, title_neutral_model, title_neutral_member_count, article_count, is_archived, title_neutral_at, updated_at) values\n  " +
      `${values};\n`
    );
  }

  /** Runs the fixture, then the given statements, in begin ... rollback; returns the output lines. */
  function inTx(rows: Cl[], statementsAfter: string): string[] {
    return runPsql(`begin;\n${fixture(rows)}${statementsAfter}rollback;\n`)
      .split("\n")
      .filter((l) => l.trim() !== "");
  }

  /**
   * The fixture numbers the function offers for p_model extractive-v6. Sorted ascending unless `inOrder`: fixtures
   * that share an updated_at come back in no defined order, so only the ordering case asks for the function's own.
   */
  function offered(rows: Cl[], limit = 50, inOrder = false): number[] {
    const ids = inTx(rows, `select right(id::text, 12)::int from public.neutral_title_repick_candidates('${MODEL}', ${limit});\n`).map(Number);
    return inOrder ? ids : ids.sort((a, b) => a - b);
  }

  const FINE = "Merkez Bankası faiz kararını açıkladı";
  const SHOUT = "NEV'İN MİRASI GÜNDEM OLDU";

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers; stable, security definer, empty search_path, service_role only", () => {
    const out = runPsql(
      "select md5(prosrc) || '|' || length(prosrc) || '|' || provolatile::text || '|' || prosecdef || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;",
    ).trim();
    const body = body184();
    expect(out).toBe(
      `${md5(body)}|${[...body].length}|s|true|{"search_path=\\"\\""}|TABLE(id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)|p_model text, p_limit integer DEFAULT 20`,
    );
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
  });

  it("is idempotent: one 184 ledger row, and the stored comment names 184", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '184';").trim()).toBe("1");
    expect(runPsql(`select obj_description('${FN_SIG}'::regprocedure, 'pg_proc');`)).toContain("184");
  });

  it("stamp 2 / now 3 members is offered; stamp 2 / still 2 members is not", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: 2, count: 3 },
        { n: 2, title: FINE, stamped: 2, count: 2 },
      ]),
    ).toEqual([1]);
  });

  it("stamp 2 / now 4 members is offered (it used to wait for 5), and so is a stamp of 1", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: 2, count: 4 },
        { n: 2, title: FINE, stamped: 1, count: 3 },
      ]),
    ).toEqual([1, 2]);
  });

  it("stamp 3 / now 4 members is not offered (the old rule: a stamp above 2 waits for the growth bar)", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: 3, count: 4 },
        { n: 2, title: FINE, stamped: 3, count: 5 },
        { n: 3, title: FINE, stamped: 3, count: 6 },
      ]),
    ).toEqual([3]);
  });

  it("an all-capitals title at stamp 2 / count 2 is offered; a sentence-case title at the same stamp is not", () => {
    expect(
      offered([
        { n: 1, title: SHOUT, stamped: 2, count: 2 },
        { n: 2, title: "Nev'in mirası gündem oldu", stamped: 2, count: 2 },
        { n: 3, title: "PENDİK VERGİ DAİRESİ MÜDÜRLÜĞÜ PENDİK VERGİ DAİRESİ", stamped: 2, count: 2 },
      ]),
    ).toEqual([1, 3]);
  });

  it("the shout branch needs letters and no lower case: Turkish capitals, digits and punctuation around them are fine, one lower-case letter (dotless ı and circumflex included) is not", () => {
    expect(
      offered([
        { n: 1, title: "ÇOCUK ŞEKERİ ÖĞRENCİ ÜÇ GÜN", stamped: 2, count: 2 },
        { n: 2, title: "ÇAĞRI 2026: 11 KASIM!", stamped: 2, count: 2 },
        { n: 3, title: "TBMM'de BÜTÇE GÖRÜŞMELERİ", stamped: 2, count: 2 },
        { n: 4, title: "KARŞI ÇIKTI ı", stamped: 2, count: 2 },
        { n: 5, title: "HAYATÎ âlem", stamped: 2, count: 2 },
        { n: 6, title: "12345 6789 0123 4567", stamped: 2, count: 2 },
        { n: 7, title: "ÇAĞRI", stamped: 3, count: 3 },
      ]),
    ).toEqual([1, 2, 7]);
  });

  it("an all-capitals title is offered whatever its stamp and count: never stamped, grown past the stamp, or stamp 7 with 7 members", () => {
    expect(
      offered([
        { n: 1, title: SHOUT, stamped: null, count: 2 },
        { n: 2, title: SHOUT, stamped: 6, count: 7 },
        { n: 3, title: SHOUT, stamped: 7, count: 7 },
      ]),
    ).toEqual([1, 2, 3]);
  });

  it("an archived cluster, one with an LLM title and one older than 14 days are not offered, by either new branch", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: 2, count: 3, archived: true },
        { n: 2, title: FINE, stamped: 2, count: 3, llm: true },
        { n: 3, title: FINE, stamped: 2, count: 3, ageDays: 15 },
        { n: 4, title: FINE, stamped: 2, count: 3, ageDays: 13 },
        { n: 5, title: SHOUT, stamped: 2, count: 2, archived: true },
        { n: 6, title: SHOUT, stamped: 2, count: 2, llm: true },
        { n: 7, title: SHOUT, stamped: 2, count: 2, ageDays: 15 },
        { n: 8, title: SHOUT, stamped: 2, count: 2, ageDays: 13 },
      ]),
    ).toEqual([4, 8]);
  });

  it("another model is still offered by the old branch, whatever its title", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: 2, count: 2, model: "extractive-v5" },
        { n: 2, title: FINE, stamped: 2, count: 2 },
      ]),
    ).toEqual([1]);
  });

  it("169's gate-fail branch and 155's growth by half still work: a stamp of 3 with a long title and 4 members, a clean stamp of 5 with 8 members", () => {
    expect(
      offered([
        { n: 1, title: chars(203), stamped: 3, count: 4 },
        { n: 2, title: FINE, stamped: 3, count: 4 },
        { n: 3, title: FINE, stamped: 5, count: 8 },
        { n: 4, title: FINE, stamped: 5, count: 7 },
      ]),
    ).toEqual([1, 3]);
  });

  it("a cluster that shrank below its stamp (a merge) is not offered", () => {
    expect(offered([{ n: 1, title: FINE, stamped: 5, count: 4 }])).toEqual([]);
  });

  it("the young branch has no loop: once the cron stamps article_count the cluster leaves, and comes back by the growth bar only", () => {
    const rows: Cl[] = [{ n: 1, title: FINE, stamped: 2, count: 3 }];
    const out = inTx(
      rows,
      [
        "select 'before:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        `update public.clusters set title_neutral_member_count = article_count where id = '${clusterUuid(1)}';`,
        "select 'stamped:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        `update public.clusters set article_count = 4 where id = '${clusterUuid(1)}';`,
        "select 'grown:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        `update public.clusters set article_count = 6 where id = '${clusterUuid(1)}';`,
        "select 'bar:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        "",
      ].join("\n"),
    );
    expect(out).toEqual(["before:1", "stamped:0", "grown:0", "bar:1"]);
  });

  it("the shout branch has no loop once the title is sentence-cased: the cron writes it, and the cluster leaves", () => {
    const rows: Cl[] = [{ n: 1, title: SHOUT, stamped: 2, count: 2 }];
    const out = inTx(
      rows,
      [
        "select 'before:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        `update public.clusters set title_tr_neutral = 'Nev''in mirası gündem oldu', title_neutral_member_count = article_count where id = '${clusterUuid(1)}';`,
        "select 'repaired:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        "",
      ].join("\n"),
    );
    expect(out).toEqual(["before:1", "repaired:0"]);
  });

  it("keeps 162's bounds: newest first and the limit clamped to 1..50", () => {
    const rows: Cl[] = Array.from({ length: 55 }, (_, i) => ({ n: i + 1, title: FINE, stamped: 2, count: 3, ageMinutes: i + 1 }));
    const all = offered(rows, 1000, true);
    expect(all).toHaveLength(50);
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(offered(rows, 0, true)).toEqual([1]);
    expect(offered(rows, 7, true)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
