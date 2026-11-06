import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { isAcceptableNeutral } from "../../src/lib/clusters/neutral-title";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 169 ("neutral_title_repick_gate_fail"), h54-editorial-2.
//
// The headline cron re-picks an extractive title through public.neutral_title_repick_candidates. Since 162 the
// function offers a stamped cluster after a model change, a NULL stamp, growth by half (at least +3) or an outlet
// edit of the stored title. A title that was picked at 2 members and FAILS THE GATE (more than ACCEPT_MAX_LEN
// characters, fewer than ACCEPT_MIN_LEN, or a '?') is none of those until the cluster has grown by 3 more members, so
// the first-pick floor's gate-failing title stays live: d096acf8 (203 characters, stamped at 2, now 3 members),
// 442e0395 (167, stamped 2, now 4: an unproven bribery stated as fact about the opposition leader, in the first
// person) and e0750c57 (129, stamped 2, now 3). The growth rule asks for 5 members at stamp 2.
//
// 169 re-creates the function with 162's text and ONE extra branch in the outer WHERE: stamped, grown by at least one
// member since the stamp, and the stored title fails the length or '?' gate. The cron stamps title_neutral_member_count
// = article_count after every pick, so a title that still fails comes back only after further growth: no loop.
//
// This file pins, without a database: the ledger row and the single transaction, additive-only SQL, 162's body is
// production's (md5 pinned, recomputed from the file), that 169's body is 162's byte for byte with exactly the added
// branch, that the 110 / 20 / '?' literals are the TypeScript gate's (the picker is imported, not restated), the grants,
// the docs section, the dry-run script and the live-manifest entry. The opt-in live block (TAYF_PSQL) runs the
// function against fixtures.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_162 = "162_neutral_title_stale_edit_repick.sql";
const FILE_168 = "168_framing_draw_one_per_event.sql";
const FILE_169 = "169_neutral_title_repick_gate_fail.sql";
const MIGRATION_162 = resolve(MIGRATIONS_DIR, FILE_162);
const MIGRATION_169 = resolve(MIGRATIONS_DIR, FILE_169);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const LIVE_MANIFEST = resolve(__dirname, "sql", "live-manifest.txt");
const DRYRUN = resolve(__dirname, "sql", "169-repick-gate-fail-dryrun.sql");
const NEUTRAL_TITLE_TS = resolve(ROOT, "src", "lib", "clusters", "neutral-title.ts");
const HEADLINE_ROUTE = resolve(ROOT, "src", "app", "api", "cron", "headline", "route.ts");

/** Production, read-only, 2026-11-06 ~19:00Z: md5(prosrc), length(prosrc) and the attributes of the function 169 starts from. */
const PROD_MD5 = "bb64fbb5bd16d32f659fb9d22889a166";
const PROD_LENGTH = 2418;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;

/** 162's outer-WHERE branches, verbatim; 169's new branch is appended after the last one. */
const STALE_BRANCH_LINE = "      or w.id in (select cluster_id from stale)\n";
const ORDER_LINE = "   order by w.updated_at desc\n";
const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('169', '169_neutral_title_repick_gate_fail') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** The branch, whitespace collapsed (the file lays it out over several lines). */
const NEW_BRANCH =
  "or (w.title_neutral_member_count is not null and w.article_count > w.title_neutral_member_count and " +
  "(pg_catalog.char_length(w.title_tr_neutral) > 110 or " +
  "pg_catalog.char_length(pg_catalog.btrim(w.title_tr_neutral)) < 20 or " +
  "pg_catalog.strpos(w.title_tr_neutral, '?') > 0))";

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

const sql162 = readFileSync(MIGRATION_162, "utf8");
const body162 = functionBody(sql162);
const sql169 = existsSync(MIGRATION_169) ? readFileSync(MIGRATION_169, "utf8") : "";
const header169 = (): string => {
  expect(existsSync(MIGRATION_169), `${FILE_169} must exist`).toBe(true);
  return sql169.split("\nbegin;")[0] as string;
};
const body169 = (): string => {
  expect(existsSync(MIGRATION_169), `${FILE_169} must exist`).toBe(true);
  return functionBody(sql169);
};

/** 169's body with the added branch cut out: the lines between the stale branch and the final order by. */
function bodyWithoutNewBranch(body: string): { rest: string; added: string } {
  const at = body.indexOf(STALE_BRANCH_LINE);
  expect(at, "162's stale branch line is kept").toBeGreaterThan(0);
  const from = at + STALE_BRANCH_LINE.length;
  const to = body.indexOf(ORDER_LINE, from);
  expect(to, "the final order by follows the new branch").toBeGreaterThanOrEqual(from);
  return { rest: body.slice(0, from) + body.slice(to), added: body.slice(from, to) };
}

describe("169 neutral_title_repick_gate_fail: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 169", () => {
    expect(existsSync(MIGRATION_169)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("169_"))).toEqual([FILE_169]);
  });

  it("sits right after 168 and leaves 162 alone (162 is the rollback target)", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, FILE_168))).toBe(true);
    expect(body162).toContain("or w.id in (select cluster_id from stale)");
    expect(body162).not.toContain("char_length");
  });

  it("runs in one transaction with a bounded lock wait and statement time", () => {
    const stmts = statements(sql169);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
    expect(countOf(sql169, "\nbegin;")).toBe(1);
    expect(countOf(sql169, "\ncommit;")).toBe(1);
  });

  it("records version 169 in the schema_migrations ledger, idempotently (the 140-168 convention), as the last statement before commit", () => {
    const code = collapse(stripComments(sql169));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });
});

describe("169 neutral_title_repick_gate_fail: the production fingerprint it was built from", () => {
  it("162's function body is production's body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body162)).toBe(PROD_MD5);
    expect([...body162].length).toBe(PROD_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 162's body", () => {
    const header = header169();
    expect(header).toContain("STEP 0");
    expect(header).toContain(PROD_MD5);
    expect(header).toContain(String(PROD_LENGTH));
    expect(header).toMatch(/prosecdef\s+t/);
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("equals the md5 of 162's body");
  });

  it("the header names the evidence, the three live clusters and the rollback to 162", () => {
    const header = flat(header169());
    for (const word of ["d096acf8", "442e0395", "e0750c57", "203", "167", "129", "34 v6 titles", "ACCEPT_MAX_LEN", "ACCEPT_MIN_LEN", "ROLLBACK"]) {
      expect(header, word).toContain(word);
    }
    expect(header).toContain("162_neutral_title_stale_edit_repick.sql");
    expect(header).toContain("version = '169'");
  });

  it("states there is no loop: the cron stamps article_count after every pick", () => {
    const header = flat(header169());
    expect(header).toMatch(/stamps title_neutral_member_count = article_count/);
    expect(header).toMatch(/no loop/i);
    expect(header).toMatch(/further growth/);
  });

  it("VERIFY step 1 carries the md5 and the length of THIS file's function body", () => {
    const body = body169();
    expect(header169()).toContain(`${md5(body)}, ${[...body].length} (was ${PROD_MD5}, ${PROD_LENGTH})`);
    expect(md5(body)).not.toBe(PROD_MD5);
  });
});

describe("169 neutral_title_repick_gate_fail: the function", () => {
  it("re-creates the function with create or replace and 162's signature, return columns, language, volatility and search_path", () => {
    expect(collapse(functionHeader(stripComments(sql169)))).toBe(collapse(functionHeader(stripComments(sql162))));
    const header = collapse(functionHeader(stripComments(sql169))).toLowerCase();
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

  it("the body is 162's body byte for byte, with exactly one added branch after the stale branch", () => {
    const { rest, added } = bodyWithoutNewBranch(body169());
    expect(rest).toBe(body162);
    expect(collapse(added)).toBe(NEW_BRANCH);
    // inserted once
    expect(countOf(collapse(body169()), NEW_BRANCH)).toBe(1);
  });

  it("keeps 162's four predicates verbatim and in order, then the new branch last", () => {
    const body = collapse(body169());
    const order = [
      "where w.title_neutral_model is distinct from p_model",
      "or w.title_neutral_member_count is null",
      "or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))",
      "or w.id in (select cluster_id from stale)",
      NEW_BRANCH,
      "order by w.updated_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)",
    ].map((p) => body.indexOf(p));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("adds no new CTE and leaves the stale set and the window untouched", () => {
    const body = collapse(body169());
    expect(body.startsWith("with stale as (")).toBe(true);
    expect(countOf(body, "with stale as")).toBe(1);
    expect(countOf(body, "from stale")).toBe(1);
    expect(body).toContain("c.updated_at > pg_catalog.now() - interval '14 days'");
    expect(body).toContain("order by c.updated_at desc limit 5000");
    expect(body).toContain("c.title_neutral_at is null");
    expect(body).toContain("c.is_archived = false");
    expect(body).toContain("c.article_count >= 2");
  });

  it("the branch needs a stamp and growth: stamped, article_count past the stamp, and one failed gate", () => {
    const branch = collapse(bodyWithoutNewBranch(body169()).added);
    expect(branch.startsWith("or (w.title_neutral_member_count is not null and w.article_count > w.title_neutral_member_count and (")).toBe(true);
    // the three gate predicates are alternatives inside one parenthesis
    expect(countOf(branch, " or ")).toBe(2);
    expect(branch.endsWith("> 0))")).toBe(true);
    // strictly greater, never >=: a cluster that has not grown since the stamp is not offered again
    expect(branch).not.toContain("w.article_count >= w.title_neutral_member_count");
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty)", () => {
    const code = sansStrings(stripComments(body169())).replace(/\bis distinct from\b/gi, "is distinct to");
    for (const rel of [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1] as string)) {
      if (rel === "stale") continue; // the CTE
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\./);
    }
    expect(code).not.toMatch(/(?<![\w.])now\(\)/);
    expect(code).not.toMatch(/(?<![\w.])strpos\(/);
    expect(code).not.toMatch(/(?<![\w.])(?:lower|translate|regexp_replace|replace|char_length|btrim|length)\(/);
    // the three gate functions are pg_catalog's
    const branch = bodyWithoutNewBranch(body169()).added;
    expect(countOf(branch, "pg_catalog.char_length(")).toBe(2);
    expect(countOf(branch, "pg_catalog.btrim(")).toBe(1);
    expect(countOf(branch, "pg_catalog.strpos(")).toBe(1);
  });

  it("the function comment states the gate-fail branch and lists migrations 141, 155, 162, 169", () => {
    const comment = statementStartingWith(sql169, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment).toContain("grown by half (at least +3)");
    expect(comment).toContain("title an outlet has since edited away");
    expect(comment).toContain("fails the acceptance gate on length or a question mark");
    expect(comment).toContain("Migrations 141, 155, 162, 169.");
    expect(comment).not.toContain("Migrations 141, 155, 162.");
  });
});

describe("169 neutral_title_repick_gate_fail: the literals are the TypeScript gate's", () => {
  const ts = readFileSync(NEUTRAL_TITLE_TS, "utf8");

  function tsConstant(name: string): number {
    const m = new RegExp(`^const ${name} = (\\d+);$`, "m").exec(ts);
    expect(m, `const ${name} in neutral-title.ts`).not.toBeNull();
    return Number((m as RegExpExecArray)[1]);
  }

  /** The number after `<needle> <op> ` in the added branch. */
  function branchLiteral(needle: string, op: string): number {
    const branch = collapse(bodyWithoutNewBranch(body169()).added);
    const at = branch.indexOf(`${needle} ${op} `);
    expect(at, `${needle} ${op} <n>`).toBeGreaterThanOrEqual(0);
    return Number.parseInt(branch.slice(at + needle.length + op.length + 2), 10);
  }

  it("110 is ACCEPT_MAX_LEN and 20 is ACCEPT_MIN_LEN (read from neutral-title.ts)", () => {
    expect(branchLiteral("pg_catalog.char_length(w.title_tr_neutral)", ">")).toBe(tsConstant("ACCEPT_MAX_LEN"));
    expect(branchLiteral("pg_catalog.char_length(pg_catalog.btrim(w.title_tr_neutral))", "<")).toBe(tsConstant("ACCEPT_MIN_LEN"));
    expect(tsConstant("ACCEPT_MAX_LEN")).toBe(110);
    expect(tsConstant("ACCEPT_MIN_LEN")).toBe(20);
  });

  /** A plain Turkish headline of exactly n characters (no '?', no other defect). */
  function plainTitle(n: number): string {
    const words = ["Ankara'da", "yeni", "köprü", "trafiğe", "açıldı", "ve", "vatandaşlar", "çok", "memnun", "kaldı"];
    let t = "";
    for (let i = 0; t.length < n; i++) t += `${words[i % words.length]} `;
    t = t.slice(0, n);
    return t.endsWith(" ") ? `${t.slice(0, -1)}a` : t;
  }

  it("the picker's own gate agrees at both edges: MAX passes and MAX + 1 fails, MIN passes and MIN - 1 fails, a '?' fails", () => {
    const max = branchLiteral("pg_catalog.char_length(w.title_tr_neutral)", ">");
    const min = branchLiteral("pg_catalog.char_length(pg_catalog.btrim(w.title_tr_neutral))", "<");
    expect(isAcceptableNeutral(plainTitle(max), [])).toBe(true);
    expect(isAcceptableNeutral(plainTitle(max + 1), [])).toBe(false);
    expect(isAcceptableNeutral(plainTitle(min), [])).toBe(true);
    expect(isAcceptableNeutral(plainTitle(min - 1), [])).toBe(false);
    expect(isAcceptableNeutral(`${plainTitle(40)}?`, [])).toBe(false);
  });

  it("the gate still rejects a '?' by includes (the SQL's strpos(...) > 0) and trims before measuring (the SQL's btrim)", () => {
    expect(ts).toContain('if (t.includes("?")) return false;');
    expect(ts).toContain('const t = (title ?? "").trim();');
    expect(ts).toContain("if (t.length < ACCEPT_MIN_LEN || t.length > ACCEPT_MAX_LEN) return false;");
  });
});

describe("169 neutral_title_repick_gate_fail: privileges", () => {
  const code = `${statements(sql169).join(";\n")};`;

  it("re-states the grants: revoke from public/anon/authenticated, grant execute to service_role", () => {
    expect(code).toContain(REVOKE_STMT);
    expect(code).toContain(GRANT_STMT);
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(sql169).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([GRANT_STMT.slice(0, -1)]);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("169 neutral_title_repick_gate_fail: additive, no data is written", () => {
  const stmts = statements(sql169);

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
    const body = sansStrings(stripComments(body169())).toLowerCase();
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate)\b/);
  });

  it("the one insert is the ledger row, written the way 155 and 162 do", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([LEDGER_STMT.slice(0, -1)]);
  });

  it("does not bump EXTRACTIVE_MODEL_ID (the v6 heal is running) and the cron is unchanged apart from comments", () => {
    const ts = readFileSync(NEUTRAL_TITLE_TS, "utf8");
    expect(ts).toContain('export const EXTRACTIVE_MODEL_ID = "extractive-v6";');
    const route = readFileSync(HEADLINE_ROUTE, "utf8");
    // the call and the incumbent are the ones 141/155/162 rely on
    expect(route).toContain('"neutral_title_repick_candidates"');
    expect(route).toContain("pickNeutralTitle(items, { incumbent: r.title_tr_neutral })");
    expect(route).toContain("title_neutral_member_count: memberCountStamp(r.article_count)");
  });

  it("the cron route's RE-PICK comment names the gate-fail branch of 169", () => {
    const route = readFileSync(HEADLINE_ROUTE, "utf8").replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
    expect(route).toContain("migration 169");
    expect(route).toContain("fails the length or '?' gate");
  });
});

describe("169 docs/migration-guide.md", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");
  const section = guide.includes("\n## 169 ") ? sectionOf(guide, "169") : "";

  it("sits directly after section 168 (a later section may follow)", () => {
    expect(guide.indexOf("\n## 169 ")).toBeGreaterThan(guide.indexOf("\n## 168 "));
    expect(guide.indexOf("\n## ", guide.indexOf("\n## 168 ") + 1)).toBe(guide.indexOf("\n## 169 "));
  });

  it("has Why, What, an md5 table, Order, Verify and Rollback", () => {
    for (const word of ["**Why:**", "**What 169 does**", "| md5(prosrc) | length |", "**Order:**", "**Verify**", "**Rollback:**"]) {
      expect(section, word).toContain(word);
    }
    const body = body169();
    expect(section).toContain(PROD_MD5);
    expect(section).toContain(String(PROD_LENGTH));
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });

  it("states the evidence and the rule", () => {
    for (const word of ["d096acf8", "442e0395", "e0750c57", "203", "167", "129", "110", "20", "'?'", "no loop"]) {
      expect(section, word).toContain(word);
    }
    expect(section).toMatch(/stamps? `?title_neutral_member_count`? = `?article_count`?/);
  });

  it("says apply only: no Next.js change, no model bump", () => {
    expect(section).toContain("APPLY 169");
    expect(section).toMatch(/no (app|Next\.js) (change|deploy)/i);
    expect(section).toMatch(/no `?EXTRACTIVE_MODEL_ID`? bump/);
  });

  it("verifies the fingerprint, the privileges, the ledger and the offered rows", () => {
    for (const word of ["md5(prosrc)", "has_function_privilege", "schema_migrations", "version = '169'", "neutral_title_repick_candidates"]) {
      expect(section, word).toContain(word);
    }
  });

  it("has a rollback that re-runs only 162's function, comment, revoke and grant and deletes only the 169 ledger row", () => {
    const rb = section.slice(section.indexOf("**Rollback:**"));
    expect(rb).toContain("162_neutral_title_stale_edit_repick.sql");
    expect(rb).toContain("version = '169'");
    expect(rb).toContain(PROD_MD5);
  });

  it("uses no fenced sql block (tests/guards/docs-sql-snippets.test.ts scans those)", () => {
    expect(section).not.toContain("```");
  });
});

describe("169 live manifest and dry-run", () => {
  it("builds 169's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(LIVE_MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 169-repick-gate-fail.test.ts"));
    expect(lines).toHaveLength(1);
    const fields = (lines[0] as string).split(" | ").map((s) => s.trim());
    expect(fields[2]?.split(" ")).toEqual(["tests/migrations/sql/169-repick-gate-fail-dryrun.sql"]);
    expect(fields[3]).toBe("-");
    expect(fields[4]).toBe("0");
  });

  it("the dry-run builds 162's state (gated on the production md5), shows the defect, applies 169 twice, and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const sql = readFileSync(DRYRUN, "utf8");
    const ir = sql
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "../../../supabase/migrations/162_neutral_title_stale_edit_repick.sql",
      "../../../supabase/migrations/169_neutral_title_repick_gate_fail.sql",
      "../../../supabase/migrations/169_neutral_title_repick_gate_fail.sql",
    ]);
    expect(sql).toContain(PROD_MD5);
    expect(sql).toContain(md5(body169()));
    expect(sql).toContain("baseline: 162 does not offer a stamped cluster whose title fails the gate");
    expect(sql.trimEnd().endsWith("select 'DRYRUN 169 OK';")).toBe(true);
    expect(sql).toContain("-f tests/migrations/sql/stub.sql");
    expect(sql).toContain("D=$(mktemp -d)");
    expect(sql).toContain("-- or: bash tests/migrations/sql/run-live.sh");
    expect(sql).toContain("rollback;");
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): the function against fixtures, on a throwaway Postgres with 162 then 169 applied by the
// dry-run script (tests/migrations/sql/live-manifest.txt). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/
// PGDATABASE select the server. Every case runs inside begin ... rollback.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("169 neutral_title_repick_candidates against fixtures (live Postgres, every case rolled back)", () => {
  assertLiveReady("169", {
    ledger: ["162", "169"],
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

  it("the function that runs is the file's: md5 and length of prosrc equal the text between the $fn$ markers; stable, security definer, empty search_path, service_role only", () => {
    const out = runPsql(
      "select md5(prosrc) || '|' || length(prosrc) || '|' || provolatile::text || '|' || prosecdef || '|' || coalesce(proconfig::text, '') || '|' || pg_get_function_result(oid) || '|' || pg_get_function_arguments(oid) from pg_proc where oid = 'public.neutral_title_repick_candidates(text, integer)'::regprocedure;",
    ).trim();
    const body = body169();
    expect(out).toBe(
      `${md5(body)}|${[...body].length}|s|true|{"search_path=\\"\\""}|TABLE(id uuid, title_tr_neutral text, article_count integer, title_neutral_member_count smallint)|p_model text, p_limit integer DEFAULT 20`,
    );
    const acl = runPsql(
      `select has_function_privilege('anon', '${FN_SIG}', 'execute') || '|' || has_function_privilege('authenticated', '${FN_SIG}', 'execute') || '|' || has_function_privilege('service_role', '${FN_SIG}', 'execute');`,
    ).trim();
    expect(acl).toBe("false|false|true");
  });

  it("is idempotent: one 169 ledger row, and the stored comment names 169", () => {
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '169';").trim()).toBe("1");
    expect(runPsql(`select obj_description('${FN_SIG}'::regprocedure, 'pg_proc');`)).toContain("169");
  });

  it("stamped 2 / 203 characters / now 3 members is offered (d096acf8)", () => {
    expect(offered([{ n: 1, title: chars(203), stamped: 2, count: 3 }])).toEqual([1]);
  });

  it("stamped 2 / 203 characters / still 2 members is not offered (nothing changed since the stamp)", () => {
    expect(offered([{ n: 1, title: chars(203), stamped: 2, count: 2 }])).toEqual([]);
  });

  it("stamped 2 / 60 characters / now 3 members is not offered (a clean title waits for the growth rule)", () => {
    expect(offered([{ n: 1, title: chars(60), stamped: 2, count: 3 }])).toEqual([]);
  });

  it("a '?' title stamped 2 with 4 members is offered, and a title with a '?' that never grew is not", () => {
    expect(
      offered([
        { n: 1, title: "Dolar rekor kırdı mı?", stamped: 2, count: 4 },
        { n: 2, title: "Dolar rekor kırdı mı?", stamped: 2, count: 2 },
      ]),
    ).toEqual([1]);
  });

  it("an archived cluster is not offered, and neither is one with an LLM title or one older than 14 days", () => {
    expect(
      offered([
        { n: 1, title: chars(203), stamped: 2, count: 3, archived: true },
        { n: 2, title: chars(203), stamped: 2, count: 3, llm: true },
        { n: 3, title: chars(203), stamped: 2, count: 3, ageDays: 15 },
        { n: 4, title: chars(203), stamped: 2, count: 3, ageDays: 13 },
      ]),
    ).toEqual([4]);
  });

  it("another model is still offered by the old branch, whatever its title", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: 2, count: 2, model: "extractive-v5" },
        { n: 2, title: FINE, stamped: 2, count: 2 },
      ]),
    ).toEqual([1]);
  });

  it("a never-stamped cluster is still offered by the old branch, and so is growth by half (at least +3) with a clean title", () => {
    expect(
      offered([
        { n: 1, title: FINE, stamped: null, count: 2 },
        { n: 2, title: FINE, stamped: 2, count: 4 },
        { n: 3, title: FINE, stamped: 2, count: 5 },
      ]),
    ).toEqual([1, 3]);
  });

  it("the length is counted in characters: 110 multi-byte characters pass, 111 are offered", () => {
    expect(
      offered([
        { n: 1, title: chars(110), stamped: 2, count: 3 },
        { n: 2, title: chars(111), stamped: 2, count: 3 },
      ]),
    ).toEqual([2]);
  });

  it("the short edge is measured on the trimmed title: 19 characters are offered, 20 are not, and padding does not rescue a short one", () => {
    expect(
      offered([
        { n: 1, title: chars(19), stamped: 2, count: 3 },
        { n: 2, title: chars(20), stamped: 2, count: 3 },
        { n: 3, title: `   ${chars(17)}   `, stamped: 2, count: 3 },
      ]),
    ).toEqual([1, 3]);
  });

  it("a cluster that shrank below its stamp (a merge) is not offered", () => {
    expect(offered([{ n: 1, title: chars(203), stamped: 5, count: 4 }])).toEqual([]);
  });

  it("there is no loop: once the cron stamps article_count the cluster leaves, and it comes back only after further growth", () => {
    const rows: Cl[] = [{ n: 1, title: chars(203), stamped: 2, count: 3 }];
    const out = inTx(
      rows,
      [
        "select 'before:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        `update public.clusters set title_neutral_member_count = article_count where id = '${clusterUuid(1)}';`,
        "select 'stamped:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        `update public.clusters set article_count = 4 where id = '${clusterUuid(1)}';`,
        "select 'grown:' || count(*) from public.neutral_title_repick_candidates('extractive-v6', 50);",
        "",
      ].join("\n"),
    );
    expect(out).toEqual(["before:1", "stamped:0", "grown:1"]);
  });

  it("keeps 162's bounds: newest first and the limit clamped to 1..50", () => {
    const rows: Cl[] = Array.from({ length: 55 }, (_, i) => ({ n: i + 1, title: chars(150), stamped: 2, count: 3, ageMinutes: i + 1 }));
    const all = offered(rows, 1000, true);
    expect(all).toHaveLength(50);
    expect(all).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(offered(rows, 0, true)).toEqual([1]);
    expect(offered(rows, 7, true)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});
