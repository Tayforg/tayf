import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 155 ("neutral-title-repick-growth").
//
// h34-reader-1 (2026-11-05): migration 141 re-offers a stamped extractive title only
// once the cluster has DOUBLED (greatest(2 * n, n + 3)). b6fe7960 (home top 6, 19
// sources, stamped at 12) needed 24 members before the cron looked at it again; its
// stored title blamed Israel while about 12 of 19 members said the war. 155 re-offers
// at n + greatest(3, ceil(n * 0.5)) instead (12 -> 18, 8 -> 12, 2 -> 5) and changes
// nothing else: the same signature, security definer, search_path, grants, comment and
// body, byte for byte, as 141 (and as production, md5 af93a90c036bd1d59056b254ce1b3524,
// read with pg_get_functiondef on 2026-11-05). No data is written.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const FILE_141 = "141_neutral_title_repick.sql";
const FILE_155 = "155_neutral_title_repick_growth.sql";

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;

const OLD_GROWTH =
  "or w.article_count >= greatest(w.title_neutral_member_count * 2, w.title_neutral_member_count + 3)";
const NEW_GROWTH =
  "or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))";

function read(file: string): string {
  return readFileSync(resolve(MIGRATIONS_DIR, file), "utf8");
}

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''");
}

/** Whitespace collapsed, and no padding just inside parentheses. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();
}

/** The text between the $fn$ markers of the one function in the file (comments stripped first). */
function functionBody(code: string): string {
  const m = stripSqlComments(code).match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body found");
  return m[1];
}

/** `create or replace function ... as ` up to the opening $fn$ marker. */
function functionHeader(code: string): string {
  const m = stripSqlComments(code).match(/create or replace function[\s\S]*?as \$fn\$/);
  if (!m) throw new Error("no function header found");
  return m[0];
}

/**
 * Top-level statements of a migration: split on ';' outside single-quoted strings,
 * `--` comments and $fn$ bodies, comments dropped. A character scan, no regular
 * expression over the SQL text.
 */
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

/** The same predicate in JS, for the numbers in the header and the comments below. */
const oldOffersAt = (n: number): number => Math.max(n * 2, n + 3);
const newOffersAt = (n: number): number => n + Math.max(3, Math.ceil(n * 0.5));

describe("migration 155: the file", () => {
  it("exists, with the exact name, and no other file claims the number 155", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, FILE_155))).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("155_"));
    expect(claimed).toEqual([FILE_155]);
  });

  it("sits right after 154 and does not edit 141 (141 still carries the doubling rule)", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, "154_image_requeue_stagger.sql"))).toBe(true);
    expect(read(FILE_141)).toContain(OLD_GROWTH);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(read(FILE_155));
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
  });
});

describe("migration 155: the function", () => {
  const m141 = read(FILE_141);
  const m155 = read(FILE_155);

  it("re-creates the function with create or replace and the 141 signature, language, volatility and search_path", () => {
    expect(collapse(functionHeader(m155))).toBe(collapse(functionHeader(m141)));
    const header = collapse(functionHeader(m155)).toLowerCase();
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

  it("the growth predicate is n + greatest(3, ceil(n * 0.5)) and the doubling rule is gone", () => {
    const body = collapse(functionBody(m155));
    expect(body).toContain(NEW_GROWTH);
    expect(body).not.toContain("title_neutral_member_count * 2");
    expect(body).not.toContain("title_neutral_member_count + 3)");
  });

  it("the body is 141's byte for byte except for that one predicate (nothing else changes)", () => {
    const old = functionBody(m141);
    // Exactly one occurrence, so split/join cannot hide a second one.
    expect(old.split(OLD_GROWTH).length - 1).toBe(1);
    expect(functionBody(m155)).toBe(old.split(OLD_GROWTH).join(NEW_GROWTH));
  });

  it("keeps the other two offer branches and the bounds: model mismatch, never stamped, 14 days, 5000, 1..50", () => {
    const body = collapse(functionBody(m155));
    expect(body).toContain("where w.title_neutral_model is distinct from p_model or w.title_neutral_member_count is null");
    expect(body).toContain("c.updated_at > pg_catalog.now() - interval '14 days'");
    expect(body).toContain("limit 5000");
    expect(body).toContain("limit least(greatest(coalesce(p_limit, 20), 1), 50)");
    expect(body).toContain("c.title_neutral_at is null");
    expect(body).toContain("c.is_archived = false");
    expect(body).toContain("c.article_count >= 2");
  });

  it("every relation inside the body is schema-qualified (search_path is empty)", () => {
    const body = sansStrings(stripSqlComments(functionBody(m155)));
    expect(body).toContain("from public.clusters c");
    expect(body).toContain("pg_catalog.now()");
    expect(body).not.toMatch(/(?<![\w.])now\(\)/);
  });

  it("the function comment states the new growth rule and is otherwise 141's", () => {
    const comment = statementStartingWith(m155, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment).toContain("grown by half (at least +3)");
    expect(comment).not.toContain("twice (or +3)");
    expect(comment).toContain("Migrations 141, 155.");
    const old = statementStartingWith(m141, "comment on function");
    const expected = old
      .split("grown to twice (or +3) the article_count")
      .join("grown by half (at least +3) over the article_count")
      .split("Migration 141.")
      .join("Migrations 141, 155.");
    expect(comment).toBe(expected);
  });
});

describe("migration 155: privileges", () => {
  const code = statements(read(FILE_155)).join(";\n") + ";";

  it("re-states 141's grants: revoke from public/anon/authenticated, grant execute to service_role", () => {
    expect(code).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
    expect(code).toContain(`grant execute on function ${FN_SIG} to service_role;`);
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(read(FILE_155)).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([`grant execute on function ${FN_SIG} to service_role`]);
    for (const stmt of grants) expect(stmt.slice(stmt.lastIndexOf(" to ") + 4), stmt).toBe("service_role");
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("migration 155: no data is written", () => {
  const stmts = statements(read(FILE_155));

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
      expect(stmts[i]!.toLowerCase().startsWith(prefix), `${i}: ${stmts[i]}`).toBe(true);
    });
  });

  it("has no update, delete, truncate, alter, drop, create table or create index statement", () => {
    const sans = sansStrings(stmts.join(";\n")).toLowerCase();
    expect(sans).not.toMatch(/(^|\s)update\s+public\./);
    expect(sans).not.toMatch(/(^|\s)delete\s+from\b/);
    expect(sans).not.toMatch(/\btruncate\b/);
    expect(sans).not.toMatch(/\balter\s+(table|function|role|default)/);
    expect(sans).not.toMatch(/\bdrop\s+/);
    expect(sans).not.toMatch(/\bcreate\s+(table|index|unique|trigger|extension)/);
  });

  it("the one insert is the ledger row, written the way migration 095 does", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([
      "insert into supabase_migrations.schema_migrations (version, name) values ('155', '155_neutral_title_repick_growth') on conflict do nothing",
    ]);
    // Migration 095's pattern, for the record.
    const m095 = readdirSync(MIGRATIONS_DIR).find((f) => f.startsWith("095_"));
    expect(m095).toBeDefined();
    expect(collapse(read(m095!))).toContain(
      "insert into supabase_migrations.schema_migrations (version, name) values ('095', '095_revoke_anon_maintain') on conflict do nothing;",
    );
  });
});

describe("migration 155: what the new predicate offers", () => {
  it("n + greatest(3, ceil(n / 2)): 2 -> 5 (unchanged), 6 -> 9, 8 -> 12, 12 -> 18, 28 -> 42", () => {
    expect([2, 3, 6, 8, 12, 28].map(newOffersAt)).toEqual([5, 6, 9, 12, 18, 42]);
  });

  it("is never later than the doubling rule, and equal for a cluster stamped at 2 or 3", () => {
    for (let n = 1; n <= 200; n++) expect(newOffersAt(n), `n=${n}`).toBeLessThanOrEqual(oldOffersAt(n));
    expect(newOffersAt(2)).toBe(oldOffersAt(2));
    expect(newOffersAt(3)).toBe(oldOffersAt(3));
    expect(newOffersAt(4)).toBeLessThan(oldOffersAt(4));
  });

  it("b6fe7960 (stamped at 12, 19 members) is offered now and was not under the doubling rule", () => {
    expect(19).toBeGreaterThanOrEqual(newOffersAt(12));
    expect(19).toBeLessThan(oldOffersAt(12));
    expect(oldOffersAt(12)).toBe(24);
  });

  it("the doubling rule's numbers in 141 match the JS mirror", () => {
    // oldOffersAt is the mirror of greatest(n * 2, n + 3): pinned so the table above means something.
    expect(oldOffersAt(12)).toBe(24);
    expect(oldOffersAt(2)).toBe(5);
    expect(read(FILE_141)).toContain("greatest(w.title_neutral_member_count * 2, w.title_neutral_member_count + 3)");
  });
});
