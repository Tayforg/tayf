import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { VOTING_SOURCE_KINDS, isVotingKind } from "../../src/lib/bias/config";

// ---------------------------------------------------------------------------
// Contract test for migration 219 ("week_silent_voting_sources"), h207-weekly-1 (hunt 207).
//
// /hafta/<week> prints zone shares (Iktidar %45 -> %52 from one week to the next) with no note that the feed set changed: five
// voting outlets have been dark since 15-25 Oct and /trends already says so (h90-trends-2). 219 CREATES one read-only function,
// public.week_silent_voting_sources(p_from, p_to, p_min default 100): the active voting sources (kind outlet or wire, the same two
// kinds as isVotingKind) that published nothing in [p_from, p_to) although they published at least p_min articles in the 28 days
// around it. The closed week's archive page names them. No table, no column, no index, no data change.
//
// This file pins, without a database: the file, ledger and transaction; the signature and attributes; the body, character for
// character up to whitespace; the voting-kind parity with src/lib/sources/kind.ts (isVotingKind); the 28-day window, its now()
// bound and the p_min default; the grants; additive-only SQL; the number; the header record (replay lists, timestamp, cost); the
// app caller (RPC name and arguments); and the docs sections.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_219 = "219_week_silent_voting_sources.sql";
const MIGRATION_219 = resolve(MIGRATIONS_DIR, FILE_219);
const DOC_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const DOC_ARCH = resolve(ROOT, "docs", "architecture.md");
const WEEK_ARCHIVE_TS = resolve(ROOT, "src", "lib", "weekly", "week-archive.ts");

const FN = "public.week_silent_voting_sources";
const FN_SIG = `${FN}(timestamptz, timestamptz, integer)`;

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('219', '219_week_silent_voting_sources') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** The function header up to the dollar quote, with whitespace collapsed. */
const EXPECTED_HEADER =
  "create or replace function public.week_silent_voting_sources( p_from timestamptz, p_to timestamptz, p_min integer default 100 ) " +
  "returns table(slug text, name text, bias text) language sql stable security invoker set search_path = '' as $fn$";

/** The body (prosrc) with whitespace collapsed and the list written without spaces after commas. */
const EXPECTED_BODY =
  "select s.slug, s.name, s.bias from public.sources s where s.active and s.kind in ('outlet','wire') " +
  "and not exists (select 1 from public.articles a where a.source_id = s.id and a.published_at >= p_from and a.published_at < p_to) " +
  "and (select count(*) from (select 1 from public.articles a where a.source_id = s.id " +
  "and a.published_at >= p_from - interval '28 days' and a.published_at < least(p_to + interval '28 days', now()) limit p_min) x) >= p_min " +
  "order by s.slug;";

/** md5(prosrc) and length(prosrc) of the body as stored (the text between the dollar quotes), recorded in the header and the docs. */
const BODY_MD5 = "6d3b91f8b8ea8e978656efc8ff20a288";
const BODY_LENGTH = 569;

/** Read-only replay recorded in the header (production, 2026-11-22 about 12:47 UTC). */
const REPLAY: Record<string, string[]> = {
  W39: ["dikgazete", "milli-gazete", "milliyet", "muhalif", "ntv", "posta", "sputnik-turkce", "yeni-akit", "yeni-mesaj"],
  W41: ["gercek-gundem", "internet-haber"],
  W42: ["gercek-gundem", "internet-haber"],
  W43: ["en-son-haber", "gazete-pencere", "gercek-gundem", "halk-tv", "internet-haber"],
  W46: ["arti-gercek", "benguturk", "en-son-haber", "gazete-pencere", "halk-tv", "medya-gazete"],
};

// -- plain-text helpers (no regular expression runs over quoted SQL) ----------------------------

/** Removes `--` comments to the end of the line (no `--` appears inside a string literal of this file). */
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

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two dollar-quote markers: Postgres' prosrc. */
function functionBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  const close = sql.indexOf("$fn$", open + 4);
  expect(open, "an opening dollar quote").toBeGreaterThanOrEqual(0);
  expect(close, "a closing dollar quote").toBeGreaterThan(open);
  return sql.slice(open + 4, close);
}

/** `create or replace function ... as ` up to and including the opening dollar quote. */
function functionHeader(sql: string): string {
  const at = sql.indexOf("create or replace function");
  const open = sql.indexOf("$fn$", at);
  expect(at, "create or replace function").toBeGreaterThanOrEqual(0);
  return sql.slice(at, open + 4);
}

/** Top-level statements: split on ';' outside single-quoted strings, `--` comments and dollar-quoted bodies; comments dropped. */
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
      out.push(collapse(cur));
      cur = "";
      i++;
    } else {
      cur += ch;
      i++;
    }
  }
  if (collapse(cur) !== "") out.push(collapse(cur));
  return out.filter((s) => s !== "");
}

const sql = existsSync(MIGRATION_219) ? readFileSync(MIGRATION_219, "utf8") : "";
const code = stripComments(sql);

describe("migration 219: file, ledger, transaction", () => {
  it("exists and is the only migration numbered 219", () => {
    expect(existsSync(MIGRATION_219)).toBe(true);
    const numbered = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("219_"));
    expect(numbered).toEqual([FILE_219]);
  });

  it("does not take a reserved number (197, 202 are held by other branches)", () => {
    expect(FILE_219.startsWith("197_")).toBe(false);
    expect(FILE_219.startsWith("202_")).toBe(false);
  });

  it("records itself in the ledger exactly once, idempotently", () => {
    expect(countOf(collapse(code), LEDGER_STMT)).toBe(1);
  });

  it("runs in one transaction with a lock timeout", () => {
    const stmts = splitStatements(code);
    expect(stmts[0]).toBe("begin");
    expect(stmts[1]).toBe("set local lock_timeout = '5s'");
    expect(stmts[stmts.length - 1]).toBe("commit");
  });

  it("asks PostgREST to reload its schema cache (a new RPC the app calls)", () => {
    expect(splitStatements(code)).toContain("notify pgrst, 'reload schema'");
  });
});

describe("migration 219: the function", () => {
  it("has the pinned signature and attributes: sql, stable, security invoker, empty search_path", () => {
    expect(collapse(functionHeader(code))).toBe(collapse(EXPECTED_HEADER));
  });

  it("defaults p_min to 100", () => {
    expect(collapse(functionHeader(code))).toContain("p_min integer default 100");
  });

  it("is SECURITY INVOKER, never definer (it is read-only and service_role only)", () => {
    const lower = code.toLowerCase();
    expect(lower).toContain("security invoker");
    expect(lower).not.toContain("security definer");
  });

  it("has the pinned body, up to whitespace", () => {
    const body = collapse(functionBody(code)).replace(/', '/g, "','");
    expect(body).toBe(EXPECTED_BODY);
  });

  it("stores the body whose md5 and length the header and the docs record", () => {
    const body = functionBody(code);
    expect(createHash("md5").update(body).digest("hex")).toBe(BODY_MD5);
    expect(body.length).toBe(BODY_LENGTH);
    expect(flat(sql.slice(0, sql.indexOf("begin;")))).toContain(`${BODY_MD5}, ${BODY_LENGTH}`);
  });

  it("lists exactly the voting kinds: parity with VOTING_SOURCE_KINDS and isVotingKind", () => {
    const body = functionBody(code);
    const at = body.indexOf("s.kind in (");
    expect(at).toBeGreaterThanOrEqual(0);
    const list = body.slice(at + "s.kind in (".length, body.indexOf(")", at));
    const kinds = list
      .split(",")
      .map((k) => k.trim().replace(/'/g, ""))
      .filter((k) => k !== "");
    expect([...kinds].sort()).toEqual([...VOTING_SOURCE_KINDS].sort());
    for (const kind of kinds) expect(isVotingKind(kind), kind).toBe(true);
    for (const kind of ["aggregator", "niche"]) expect(kinds).not.toContain(kind);
  });

  it("looks 28 days either side of the week and never past now()", () => {
    const body = collapse(functionBody(code));
    expect(countOf(body, "interval '28 days'")).toBe(2);
    expect(body).toContain("a.published_at >= p_from - interval '28 days'");
    expect(body).toContain("a.published_at < least(p_to + interval '28 days', now())");
  });

  it("bounds the materiality probe with limit p_min (an index-only read that stops at p_min rows)", () => {
    const body = collapse(functionBody(code));
    expect(countOf(body, "limit p_min")).toBe(1);
    expect(body).toContain(">= p_min");
    // The "silent" probe is an existence check, not a count.
    expect(body).toContain("not exists (select 1 from public.articles a where a.source_id = s.id");
  });

  it("qualifies every relation and orders by slug", () => {
    const body = functionBody(code);
    expect(countOf(body, "public.sources")).toBe(1);
    expect(countOf(body, "public.articles")).toBe(2);
    expect(collapse(body).endsWith("order by s.slug;")).toBe(true);
  });
});

describe("migration 219: access", () => {
  it("revokes from public, anon and authenticated and grants execute to service_role only", () => {
    const stmts = splitStatements(code);
    expect(stmts.filter((s) => s.startsWith("revoke "))).toEqual([REVOKE_STMT.slice(0, -1)]);
    expect(stmts.filter((s) => s.startsWith("grant "))).toEqual([GRANT_STMT.slice(0, -1)]);
  });

  it("grants nothing to anon or authenticated (the anon surface stays the seven allowlisted RPCs)", () => {
    for (const stmt of splitStatements(code)) {
      if (stmt.startsWith("grant ")) {
        expect(stmt).not.toContain("anon");
        expect(stmt).not.toContain("authenticated");
        expect(stmt).not.toContain("public,");
      }
    }
    expect(code.toLowerCase()).not.toContain("default privileges");
  });
});

describe("migration 219: additive only", () => {
  it("holds only the allowed statements", () => {
    const allowed = [
      "begin",
      "set local lock_timeout = '5s'",
      "create or replace function public.week_silent_voting_sources(",
      "comment on function public.week_silent_voting_sources(",
      "revoke all on function public.week_silent_voting_sources(",
      "grant execute on function public.week_silent_voting_sources(",
      "notify pgrst, 'reload schema'",
      "insert into supabase_migrations.schema_migrations (version, name) values ('219',",
      "commit",
    ];
    const stmts = splitStatements(code);
    expect(stmts).toHaveLength(allowed.length);
    for (const stmt of stmts) {
      expect(
        allowed.some((a) => stmt.startsWith(a)),
        `unexpected statement: ${stmt.slice(0, 80)}`,
      ).toBe(true);
    }
  });

  it("changes no table, column, index, trigger, cron job or data", () => {
    const lower = collapse(code).toLowerCase();
    for (const term of [
      "create table",
      "alter table",
      "drop ",
      "delete from",
      "update public.",
      "truncate",
      "create index",
      "create trigger",
      "cron.",
      "insert into public.",
    ]) {
      expect(lower, term).not.toContain(term);
    }
  });
});

describe("migration 219: header record", () => {
  const header = flat(sql.slice(0, sql.indexOf("begin;")));

  it("records the read-only replay of five weeks with a timestamp", () => {
    expect(header).toContain("2026-11-22");
    for (const [week, slugs] of Object.entries(REPLAY)) {
      expect(header, week).toContain(`${week} (${slugs.length}): ${slugs.join(", ")}`);
    }
  });

  it("records the cost of one week (EXPLAIN ANALYZE, under 500 ms) and the index it reads", () => {
    expect(header).toContain("EXPLAIN ANALYZE");
    expect(header).toContain("Execution Time: 98.7 ms");
    expect(header).toContain("idx_articles_source_published");
  });

  it("says the lists can shift with the now()-bounded edge and names the copy-only effect", () => {
    expect(header).toContain("now()");
    expect(header).toContain("can shift");
    expect(header).toContain("h207-weekly-1");
  });

  it("states the deploy order and the rollback", () => {
    expect(header).toContain("DEPLOY");
    expect(header).toContain("PGRST202");
    expect(header).toContain("ROLLBACK");
    expect(header).toContain(`drop function ${FN_SIG};`);
  });
});

describe("migration 219: the app caller", () => {
  const ts = existsSync(WEEK_ARCHIVE_TS) ? readFileSync(WEEK_ARCHIVE_TS, "utf8") : "";

  it("week-archive.ts calls the RPC by name with the week bounds and leaves p_min to the SQL default", () => {
    expect(ts).toContain('.rpc("week_silent_voting_sources"');
    expect(ts).toContain("p_from: range.startIso");
    expect(ts).toContain("p_to: range.endIso");
    expect(ts).not.toContain("p_min");
  });
});

describe("migration 219: docs", () => {
  it("docs/migration-guide.md has the 219 section with the order and the replay", () => {
    const guide = readFileSync(DOC_GUIDE, "utf8");
    const at = guide.indexOf("\n## 219 ");
    expect(at, "a `## 219 ` heading").toBeGreaterThanOrEqual(0);
    const next = guide.indexOf("\n## ", at + 5);
    const section = guide.slice(at, next === -1 ? guide.length : next);
    expect(section).toContain("week_silent_voting_sources");
    expect(section).toContain("APPLY 219");
    expect(section).toContain("PGRST202");
    expect(section).toContain("Rollback");
    for (const week of Object.keys(REPLAY)) expect(section, week).toContain(week);
    expect(section).toContain(BODY_MD5);
  });

  it("docs/architecture.md names the function and the page that reads it", () => {
    const arch = readFileSync(DOC_ARCH, "utf8");
    const line = arch.split("\n").find((l) => l.includes("week_silent_voting_sources"));
    expect(line, "a line naming week_silent_voting_sources").toBeDefined();
    expect(line).toContain("/hafta/<week>");
    expect(line).toContain("getWeekSilentVotingSources");
  });
});
