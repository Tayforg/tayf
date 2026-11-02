import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, BLINDSPOT } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import { POLITICS_CATEGORIES } from "../../supabase/functions/_shared/cluster/politics-admission";
import { SIBLING_VETO, siblingTitlesMatch } from "../../src/lib/clusters/sibling-veto";

// Migration 148 gives the sibling veto of 126 a second candidate arm: voting-
// source (outlet/wire) articles that sit in NO cluster because their category is
// not politika/son_dakika (the clusterer admits only those two). 126's `scand`
// joined cluster_articles, so such an article could never count as a sibling:
// production cluster bdbf9948 kept a public "kor nokta (Muhalefet)" badge while
// cumhuriyet, yenicag and evrensel ran the same story under dunya/genel/yasam.
//
// 148 repeats 126's function body verbatim except for that arm. This file pins
// (1) the md5 of the body production runs before 148 against 126's text,
// (2) body parity: delete the new arm and the rest must equal 126's body, so the
//     window, minShared, Jaccard, wmem, freeze, reason, zmap and UPDATE cannot
//     drift, (3) the arm itself, (4) the safety properties of the definer function
//     and the shape of the file, and (5) the real bdbf9948 headlines against the
//     TypeScript twin of the title rule. The behaviour is exercised by
//     tests/migrations/sql/148-blindspot-unclustered-siblings-dryrun.sql on PG15.

const MIGRATIONS = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS, "148_blindspot_unclustered_siblings.sql");
const MIGRATION_126 = resolve(MIGRATIONS, "126_blindspot_sibling_veto.sql");

// md5(prosrc) of public.blindspot_recall_veto_refresh on production before 148
// (read-only, 2026-11-02; 9162 characters, identity arguments "p_since interval,
// p_min_prob numeric"). 144 changed only the cron, so it equals 126's body text.
const PROD_MD5_BEFORE = "2904bdbadff34838259ffb901807cc33";
const PROD_LENGTH_BEFORE = 9162;

// Arm 2 never reaches further back than the sibling scope plus this margin (the bound is
// pg_catalog.now() - v_scope - 48 hours, 96 hours for the default scope).
const ARM2_AGE_MARGIN_HOURS = 48;

/** Escapes every RegExp metacharacter so a literal string can be embedded in a pattern. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Removes `--` line comments by scanning characters, so a `--` inside a quoted literal survives. */
function stripSqlComments(sql: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql.charAt(i);
    if (inQuote) {
      out += ch;
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      out += ch;
      continue;
    }
    if (ch === "-" && sql.charAt(i + 1) === "-") {
      while (i < sql.length && sql.charAt(i) !== "\n") i += 1;
      out += "\n";
      continue;
    }
    out += ch;
  }
  return out;
}

/** Blanks the content of single-quoted literals (a doubled quote toggles twice and stays inside). */
function stripSqlStrings(sql: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql.charAt(i);
    if (ch === "'") {
      inQuote = !inQuote;
      out += ch;
    } else if (!inQuote) {
      out += ch;
    }
  }
  return out;
}

function collapse(text: string): string {
  return text.split(/\s+/).filter((w) => w.length > 0).join(" ");
}

/** The text between the first two `$fn$` markers (what pg_proc.prosrc holds). */
function fnBody(sql: string): string {
  const open = sql.indexOf("$fn$");
  if (open < 0) return "";
  const close = sql.indexOf("$fn$", open + 4);
  if (close < 0) return "";
  return sql.slice(open + 4, close);
}

/** Index of the `)` that closes the `(` at `openIdx`, skipping quoted literals. */
function closingParen(text: string, openIdx: number): number {
  let depth = 0;
  let inQuote = false;
  for (let i = openIdx; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuote) {
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Offsets of `union all` at paren depth 0 of `text`, skipping quoted literals. */
function topLevelUnionAll(text: string): number[] {
  const found: number[] = [];
  let depth = 0;
  let inQuote = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inQuote) {
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") inQuote = true;
    else if (ch === "(") depth += 1;
    else if (ch === ")") depth -= 1;
    else if (depth === 0 && text.slice(i, i + 9).toLowerCase() === "union all") {
      const before = i === 0 ? " " : text.charAt(i - 1);
      const after = text.charAt(i + 9);
      if (/\s/.test(before) && /\s/.test(after)) found.push(i);
    }
  }
  return found;
}

const SCAND_OPEN = "scand as materialized (";

type Scand = { open: number; close: number; inner: string; unions: number[] };

function scandOf(code: string): Scand | null {
  const at = code.indexOf(SCAND_OPEN);
  if (at < 0) return null;
  const open = at + SCAND_OPEN.length - 1;
  const close = closingParen(code, open);
  if (close < 0) return null;
  const inner = code.slice(open + 1, close);
  return { open, close, inner, unions: topLevelUnionAll(inner) };
}

type Span = { begin: number; commit: number };

// Explicit `begin;` ... `commit;` blocks (line-anchored, so the plpgsql `begin`
// keywords inside the $fn$ body never match).
function transactionSpans(sql: string): Span[] {
  const marks = [...sql.matchAll(/^\s*(begin|commit)\s*;/gim)].map((m) => ({
    kind: (m[1] as string).toLowerCase(),
    at: m.index as number,
  }));
  const spans: Span[] = [];
  let open: number | null = null;
  for (const m of marks) {
    if (m.kind === "begin") {
      expect(open).toBeNull();
      open = m.at;
    } else {
      expect(open).not.toBeNull();
      spans.push({ begin: open as number, commit: m.at });
      open = null;
    }
  }
  expect(open).toBeNull();
  return spans;
}

function quotedList(list: string): string[] {
  return [...list.matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string);
}

let sql = "";
let code = "";
let sql126 = "";
let code126 = "";
let body148 = "";
let body126 = "";
let arm2 = "";
beforeAll(() => {
  // A missing migration fails each assertion below instead of the whole file.
  sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
  code = stripSqlComments(sql);
  sql126 = readFileSync(MIGRATION_126, "utf8");
  code126 = stripSqlComments(sql126);
  body148 = stripSqlComments(fnBody(sql));
  body126 = stripSqlComments(fnBody(sql126));
  const scand = scandOf(body148);
  arm2 = scand && scand.unions.length === 1 ? collapse(scand.inner.slice((scand.unions[0] as number) + 9)) : "";
});

describe("148 header and bookkeeping", () => {
  it("the header md5 is the md5 of 126's function body, which production runs", () => {
    expect(fnBody(sql126).length).toBe(PROD_LENGTH_BEFORE);
    expect(createHash("md5").update(fnBody(sql126)).digest("hex")).toBe(PROD_MD5_BEFORE);
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toMatch(/\b[0-9a-f]{32}\b/);
    expect(header).toContain(PROD_MD5_BEFORE);
    expect(header).toContain(String(PROD_LENGTH_BEFORE));
  });

  it("the header names the production evidence", () => {
    const header = sql.slice(0, sql.search(/^begin;/m));
    for (const id of ["bdbf9948", "ca13efe9", "d4121d30", "16b6ec7f", "5599ab56"]) {
      expect(header).toContain(id);
    }
    for (const part of ["WHY", "THE ARM", "PERF", "IMPACT", "DRY-RUN", "DEPLOY ORDER", "ROLLBACK"]) {
      expect(header).toContain(part);
    }
  });

  it("the header documents the clock bound and the cron timeout, with the production evidence", () => {
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toContain("BOUNDS");
    for (const id of ["7462b5b8", "35ddca6c", "2022-01-13"]) expect(header).toContain(id);
    expect(header).toContain("now() - v_scope - 48 hours");
    expect(header).toContain("statement_timeout = '120s'");
    // the rollback puts the cron command back
    const rollback = collapse(header.slice(header.indexOf("ROLLBACK")).split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    expect(rollback).toMatch(/cron\.alter_job/);
    expect(rollback).toContain("command := 'select public.blindspot_recall_veto_refresh();'");
  });

  it("the header records the EXPLAIN cold and warm numbers", () => {
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toMatch(/EXPLAIN/);
    // Line-based: a header line that names the run and carries a duration.
    const lines = header.split("\n");
    for (const run of ["cold", "warm"]) {
      const word = new RegExp(`\\b${escapeRegExp(run)}\\b`, "i");
      expect(lines.some((l) => word.test(l) && /\d(\.\d+)? ?(s|ms)\b/.test(l))).toBe(true);
    }
  });

  it("the header records the dry-run twice on PG15", () => {
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toMatch(/DRYRUN 148 OK/);
    expect(header).toMatch(/PostgreSQL 15|PG15/);
    expect(header).toMatch(/twice/i);
  });

  it("the header states the deploy order (none) and a rollback that re-applies 126 piece (c)", () => {
    const header = sql.slice(0, sql.search(/^begin;/m));
    expect(header).toMatch(/DEPLOY ORDER:\s*none/);
    // The header wraps lines: drop the comment prefixes and collapse whitespace first.
    const rollback = collapse(
      header
        .slice(header.indexOf("ROLLBACK"))
        .split("\n")
        .map((l) => (l.startsWith("--") ? l.slice(2) : l))
        .join(" "),
    );
    expect(rollback).toMatch(/126/);
    expect(rollback).toMatch(/piece \(c\)/);
    expect(rollback).toMatch(/function, comment, revoke,? (and )?grant/);
  });

  it("is additive and writes no data: no drop, delete, truncate, backfill or function call", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|function|index|constraint|trigger|policy)\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|truncate)\b/i);
    // The one DO block only retargets the cron job's command (see the cron test below).
    expect([...code.matchAll(/\bdo\s+\$(\w*)\$/gi)].map((m) => m[1])).toEqual(["veto_timeout"]);
    // No call of the refresh outside quoted literals (the cron command is a literal).
    const bare = stripSqlStrings(code);
    expect(bare).not.toMatch(/\b(select|perform)\s+(public\.)?blindspot_recall_veto_refresh\b/i);
    expect(bare).not.toMatch(/:=\s*public\.blindspot_recall_veto_refresh\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
  });

  it("is ONE transaction that holds the function swap and the ledger row", () => {
    const txs = transactionSpans(code);
    expect(txs).toHaveLength(1);
    const tx = txs[0] as Span;
    expect(code.trimStart().startsWith("begin;")).toBe(true);
    expect(code.trimEnd().endsWith("commit;")).toBe(true);
    const create = code.search(/create\s+or\s+replace\s+function\b/i);
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(create).toBeGreaterThan(tx.begin);
    expect(ledger).toBeGreaterThan(create);
    expect(ledger).toBeLessThan(tx.commit);
  });

  it("records itself as version '148' with the 095 insert pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'148'\s*,\s*'148_blindspot_unclustered_siblings'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/i,
    );
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("touches pg_cron only to give the blindspot-recall-veto job a statement timeout: guarded, by job name, command only", () => {
    expect(code).not.toMatch(/cron\.(un)?schedule\b/i);
    expect([...code.matchAll(/cron\.alter_job\s*\(/gi)]).toHaveLength(1);
    // guarded like 144: no pg_cron, no job -> a notice and a skip
    expect(code).toMatch(/to_regclass\('cron\.job'\)\s+is\s+null/i);
    // found by name, and by that name only: no other job is read or written
    const names = [...code.matchAll(/jobname\s*=\s*'([^']*)'/gi)].map((m) => m[1]);
    expect(names).toEqual(["blindspot-recall-veto"]);
    // the alter_job call changes the command and nothing else (no schedule, active, database, username)
    // (found by a character scan: the command literal itself contains a semicolon)
    const callAt = code.search(/cron\.alter_job\s*\(/i);
    expect(callAt).toBeGreaterThanOrEqual(0);
    const open = code.indexOf("(", callAt);
    const close = closingParen(code, open);
    expect(close).toBeGreaterThan(open);
    const args = collapse(code.slice(open + 1, close));
    expect(args).toMatch(/^job_id\s*:=\s*v_job\s*,\s*command\s*:=\s*'/);
    for (const other of ["schedule", "active", "database", "username"]) {
      expect(args).not.toMatch(new RegExp(`\\b${escapeRegExp(other)}\\s*:=`, "i"));
    }
    // the command: a per-statement timeout, then the unchanged call (71's command text)
    expect(args).toContain(
      "'set local statement_timeout = ''120s''; select public.blindspot_recall_veto_refresh();'",
    );
  });

  it("never touches indexes, tables, views, triggers or policies", () => {
    expect(code).not.toMatch(
      /\bcreate\s+(or\s+replace\s+)?(unique\s+)?(materialized\s+)?(trigger|policy|view|table|extension|index|sequence|type)\b/i,
    );
  });

  it("sanity: comment stripping is non-vacuous and the file has exactly one $fn$ pair", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect([...sql.matchAll(/\$fn\$/g)]).toHaveLength(2);
    expect(body148.length).toBeGreaterThan(1000);
  });
});

describe("148 body parity with 126", () => {
  it("deleting the new arm from scand leaves 126's function body, comments and whitespace aside", () => {
    const scand = scandOf(body148);
    expect(scand).not.toBeNull();
    const s = scand as Scand;
    expect(s.unions).toHaveLength(1);
    // From `union all` to the end of the CTE (the `)` that closes scand).
    const cut =
      body148.slice(0, s.open + 1 + (s.unions[0] as number)).trimEnd() + body148.slice(s.close);
    expect(collapse(cut)).toBe(collapse(body126));
  });

  it("the 126 body it is compared with is the one the 126 test pins (sanity: the parity is not vacuous)", () => {
    expect(collapse(body126)).toContain("scand as materialized (");
    expect(collapse(body126)).toContain("c2.merged_into is null)");
    expect(collapse(body148)).not.toBe(collapse(body126));
  });

  it("keeps the thresholds, the freeze and the reason values of 126 (spelled out)", () => {
    expect(code).toMatch(new RegExp(`count\\(\\*\\)\\s*>=\\s*${SIBLING_VETO.minShared}\\b`));
    expect(code).toMatch(
      new RegExp(
        `count\\(\\*\\)::numeric\\s*/\\s*\\(\\s*\\w+\\.ntok\\s*\\+\\s*\\w+\\.ntok\\s*-\\s*(?:pg_catalog\\.)?count\\(\\*\\)\\s*\\)\\s*>=\\s*${escapeRegExp(String(SIBLING_VETO.minJaccard))}\\b`,
      ),
    );
    expect(code).toMatch(
      new RegExp(
        `v_scope\\s+interval\\s*:=\\s*greatest\\(\\s*interval\\s+'${SIBLING_VETO.scopeHours} hours'\\s*,\\s*v_since\\s*\\)`,
      ),
    );
    expect(code).toMatch(/blindspot_veto_reason\s*=\s*'sibling_headline'/);
    expect(code).toMatch(
      /case\s+when\s+\w+\.veto_jev\s+then\s+'jev_recall'\s+when\s+\w+\.veto_sib\s+then\s+'sibling_headline'\s+end/i,
    );
    expect(code).toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+wmem\b/i);
  });

  it("the zmap VALUES pairs still deep-equal BIAS_TO_ZONE", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*\n?\s*win\s+as/i.exec(
      code,
    );
    expect(span).not.toBeNull();
    const parsed: Record<string, string> = {};
    for (const m of ((span as RegExpExecArray)[1] as string).matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g)) {
      parsed[m[1] as string] = m[2] as string;
    }
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
  });

  it("the translate() literals still equal the shared fold strings (checked against 126's)", () => {
    const re = /translate\(\s*coalesce\(\s*a\.title\s*,\s*''\s*\)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    const mine = [...code.matchAll(re)].map((m) => [m[1], m[2]]);
    const theirs = [...code126.matchAll(re)].map((m) => [m[1], m[2]]);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine).toEqual(theirs);
  });
});

describe("148 new arm of scand", () => {
  it("scand has exactly two arms, joined by union all", () => {
    const scand = scandOf(body148);
    expect(scand).not.toBeNull();
    expect((scand as Scand).unions).toHaveLength(1);
    expect(arm2.length).toBeGreaterThan(0);
  });

  it("arm 2 reads articles joined to sources and never mentions clusters", () => {
    expect(arm2).toMatch(/from public\.articles a join public\.sources s on s\.id = a\.source_id\b/);
    expect(arm2).not.toMatch(/\bcluster_articles\b/i);
    expect(arm2).not.toMatch(/\bclusters\b/i);
    expect(arm2).not.toMatch(/\bnot exists\b|\bleft join\b/i);
  });

  it("arm 2 uses the article id as the pseudo cluster id and selects the same five columns as arm 1", () => {
    const m = /^select (.*?) from public\.articles a join\b/.exec(arm2);
    expect(m).not.toBeNull();
    expect((m as RegExpExecArray)[1]).toBe(
      "a.id as cluster_id, a.id as article_id, a.source_id, a.published_at, a.title",
    );
    const scand = scandOf(body148) as Scand;
    const arm1 = collapse(scand.inner.slice(0, scand.unions[0]));
    expect(arm1).toMatch(
      /^select c2\.id as cluster_id, a\.id as article_id, a\.source_id, a\.published_at, a\.title from /,
    );
  });

  it("arm 1 keeps 126's min/max(wart.published_at) +/- windowHours bounds; arm 2 clamps them to the calendar", () => {
    const w = SIBLING_VETO.windowHours;
    const lowerBound = `(select pg_catalog.min(published_at) from wart) - interval '${w} hours'`;
    const upperBound = `(select pg_catalog.max(published_at) from wart) + interval '${w} hours'`;
    const scand = scandOf(body148) as Scand;
    const arm1 = collapse(scand.inner.slice(0, scand.unions[0]));
    expect(arm1).toContain(`a.published_at >= ${lowerBound}`);
    expect(arm1).toContain(`a.published_at <= ${upperBound}`);
    // A member date is data: ingest clamps only FUTURE dates, so a feed can carry a 2022 pubDate
    // into a blindspot (production: clusters 7462b5b8 and 35ddca6c, members dated 2022-01-13/14).
    // Arm 2 reads every voting-source article of the window, so the window may not follow the
    // member dates alone: it is cut by the clock on both sides.
    expect(arm2).toContain(
      `a.published_at >= greatest(${lowerBound}, pg_catalog.now() - v_scope - interval '${ARM2_AGE_MARGIN_HOURS} hours')`,
    );
    expect(arm2).toContain(`a.published_at <= least(${upperBound}, pg_catalog.now())`);
  });

  it("arm 2 admits only voting-kind sources: s.kind in (...) equals VOTING_SOURCE_KINDS", () => {
    const m = /\bs\.kind\s+in\s*\(([^)]*)\)/i.exec(arm2);
    expect(m).not.toBeNull();
    const kinds = quotedList((m as RegExpExecArray)[1] as string);
    expect(kinds).toHaveLength(VOTING_SOURCE_KINDS.length);
    expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
  });

  it("arm 2 admits only articles outside the gate categories: not in (...) equals POLITICS_CATEGORIES", () => {
    const m = /\bcoalesce\(\s*a\.category\s*,\s*''\s*\)\s+not\s+in\s*\(([^)]*)\)/i.exec(arm2);
    expect(m).not.toBeNull();
    const cats = quotedList((m as RegExpExecArray)[1] as string);
    expect(cats).toHaveLength(POLITICS_CATEGORIES.length);
    expect(new Set(cats)).toEqual(new Set(POLITICS_CATEGORIES));
  });

  it("arm 2 is exactly the specified statement (four predicates, the window clamped by the clock, no anti-join)", () => {
    const w = SIBLING_VETO.windowHours;
    const kinds = VOTING_SOURCE_KINDS.map((k) => `'${k}'`).join(",");
    const cats = POLITICS_CATEGORIES.map((c) => `'${c}'`).join(",");
    expect(arm2).toBe(
      "select a.id as cluster_id, a.id as article_id, a.source_id, a.published_at, a.title " +
        "from public.articles a join public.sources s on s.id = a.source_id " +
        `where a.published_at >= greatest((select pg_catalog.min(published_at) from wart) - interval '${w} hours', ` +
        `pg_catalog.now() - v_scope - interval '${ARM2_AGE_MARGIN_HOURS} hours') ` +
        `and a.published_at <= least((select pg_catalog.max(published_at) from wart) + interval '${w} hours', ` +
        `pg_catalog.now()) ` +
        `and s.kind in (${kinds}) ` +
        `and coalesce(a.category, '') not in (${cats})`,
    );
  });

  it("the function comment mentions unclustered candidates", () => {
    expect(code).toMatch(
      /comment\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+is[\s\S]*?unclustered/i,
    );
  });
});

describe("148 parity with the voting-kind and zone contracts", () => {
  it("every kind-in list (Jev path, sibling path, new arm) equals VOTING_SOURCE_KINDS", () => {
    const lists = [...code.matchAll(/\bkind\s+in\s*\(([^)]+)\)/gi)];
    expect(lists.length).toBeGreaterThanOrEqual(3);
    for (const m of lists) {
      expect(new Set(quotedList(m[1] as string))).toEqual(new Set(VOTING_SOURCE_KINDS));
    }
  });

  it("the live contract still uses BLINDSPOT.minSources and BLINDSPOT.dominantShare", () => {
    const share = escapeRegExp(String(BLINDSPOT.dominantShare));
    expect(code).toMatch(new RegExp(`l\\.tot\\s*>=\\s*${BLINDSPOT.minSources}\\b`));
    expect(code).toMatch(
      new RegExp(`l\\.dom_n::numeric\\s*/\\s*nullif\\(l\\.tot,\\s*0\\)\\s*>=\\s*${share}\\b`),
    );
  });
});

describe("148 function safety", () => {
  it("replaces blindspot_recall_veto_refresh with the 071 signature and defaults", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.blindspot_recall_veto_refresh\s*\(\s*p_since\s+interval\s+default\s+interval\s+'26 hours'\s*,\s*p_min_prob\s+numeric\s+default\s+0\.85\s*\)\s*returns\s+integer/i,
    );
    expect([...code.matchAll(/\bcreate\s+(or\s+replace\s+)?function\b/gi)]).toHaveLength(1);
  });

  it("is SECURITY DEFINER with an empty search_path", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.blindspot_recall_veto_refresh\s*\([\s\S]*?\)\s*returns\s+integer\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("revokes execute from public/anon/authenticated and grants it only to service_role, with no other GRANT", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+to\s+service_role\s*;/i,
    );
    expect([...code.matchAll(/\bgrant\b/gi)]).toHaveLength(1);
    expect(code).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
  });

  it("serialises concurrent runs with the 071 transaction advisory lock", () => {
    expect(code).toMatch(
      /pg_catalog\.pg_try_advisory_xact_lock\(\s*pg_catalog\.hashtext\('blindspot_recall_veto_refresh'\)::bigint\s*\)/,
    );
  });

  it("has one idempotent UPDATE whose set list is exactly the three veto columns", () => {
    expect([...code.matchAll(/\bupdate\s+public\.\w+/gi)]).toHaveLength(1);
    expect(code).toMatch(/c\.blindspot_recall_veto\s+is\s+distinct\s+from\s+v\.veto/i);
    expect(code).toMatch(/c\.blindspot_veto_reason\s+is\s+distinct\s+from\s+v\.reason/i);
    const m = /update\s+public\.clusters\s+c\s+set([\s\S]*?)\bfrom\s+verdict\b/i.exec(code);
    expect(m).not.toBeNull();
    const setList = (m as RegExpExecArray)[1] as string;
    expect([...setList.matchAll(/(\w+)\s*=(?!=)/g)].map((x) => x[1])).toEqual([
      "blindspot_recall_veto",
      "blindspot_recall_veto_at",
      "blindspot_veto_reason",
    ]);
    for (const forbidden of ["is_blindspot", "blindspot_side", "updated_at"]) {
      expect(setList).not.toMatch(new RegExp(`\\b${escapeRegExp(forbidden)}\\b`));
    }
  });
});

// The bdbf9948 shape on the real headlines (production, read-only, 2026-11-02).
// W has five voting members, all iktidar, all category politika. Four voting
// opposition outlets ran the story the same morning and sit in no cluster
// (cluster_articles count 0), filed under dunya/genel/yasam.
const W_MEMBERS = [
  { slug: "aksam", bias: "gov_leaning", title: "Sosyal medyada yeni dönem yarın başlıyor: e-Devlet üzerinden zorunlu olacak" },
  { slug: "star", bias: "pro_government", title: "15 yaşını doldurmamış çocukların sosyal hesabı kapatılıyor! Yeni uygulama yarın başlayacak" },
  { slug: "haber-global", bias: "gov_leaning", title: "15 yaş altına sosyal medya yasağı yarın başlıyor: Yaş doğrulama e-Devlet'ten yapılacak" },
  { slug: "istiklal", bias: "pro_government", title: "Yapmayanın hesabı kapanacak... Sosyal medyada yeni dönem 1 Kasım'da başlıyor" },
  { slug: "yeni-safak", bias: "pro_government", title: "Yapmayanın hesabı kapatılacak: Sosyal medyada yeni dönem yarın başlıyor" },
] as const;

const UNCLUSTERED = [
  { slug: "cumhuriyet", bias: "opposition_leaning", kind: "outlet", category: "dunya", title: "Sosyal medyada yeni dönem yarın başlıyor: Bunları yapmayanın hesabı kapatılacak!" },
  { slug: "birgun", bias: "opposition", kind: "outlet", category: "dunya", title: "Sosyal medya yasağı başlıyor: Hesaplar kapatılacak" },
  { slug: "evrensel", bias: "opposition", kind: "outlet", category: "yasam", title: "Sosyal medyada yaş doğrulama zorunluluğu yarın başlıyor" },
  { slug: "yenicag", bias: "opposition_leaning", kind: "outlet", category: "genel", title: "Sosyal medya yasağı yarın başlıyor: 15 yaş altına hesap açmak yasaklandı" },
] as const;

describe("the bdbf9948 shape on the real headlines (siblingTitlesMatch)", () => {
  const zoneOf = (bias: string): string => (BIAS_TO_ZONE as Record<string, string>)[bias] as string;
  const memberSlugs = new Set<string>(W_MEMBERS.map((m) => m.slug));

  type Candidate = { slug: string; bias: string; kind: string; category: string; title: string };

  // The pipeline of the SQL: arm-2 candidates are voting-kind articles outside the gate
  // categories; a pair needs a title match with a member; sources already among the
  // members are dropped (wmem); the voters are the distinct remaining sources.
  function voters(pool: readonly Candidate[]): Candidate[] {
    const out = new Map<string, Candidate>();
    for (const u of pool) {
      if (!(VOTING_SOURCE_KINDS as readonly string[]).includes(u.kind)) continue;
      if ((POLITICS_CATEGORIES as readonly string[]).includes(u.category)) continue;
      if (memberSlugs.has(u.slug)) continue;
      if (!W_MEMBERS.some((m) => siblingTitlesMatch(m.title, u.title))) continue;
      out.set(u.slug, u);
    }
    return [...out.values()];
  }

  it("W is a live blindspot: five voting members, all iktidar", () => {
    expect(W_MEMBERS).toHaveLength(5);
    expect(W_MEMBERS.length).toBeGreaterThanOrEqual(BLINDSPOT.minSources);
    for (const m of W_MEMBERS) expect(zoneOf(m.bias)).toBe("iktidar");
  });

  it("all four opposition articles are muhalefet, voting-kind and filed outside politika/son_dakika", () => {
    for (const u of UNCLUSTERED) {
      expect(zoneOf(u.bias)).toBe("muhalefet");
      expect(VOTING_SOURCE_KINDS as readonly string[]).toContain(u.kind);
      expect(POLITICS_CATEGORIES as readonly string[]).not.toContain(u.category);
    }
  });

  it("three of the four match a member title (cumhuriyet, evrensel, yenicag); birgun's shorter headline does not", () => {
    expect(voters(UNCLUSTERED).map((v) => v.slug).sort()).toEqual(["cumhuriyet", "evrensel", "yenicag"]);
    const birgun = UNCLUSTERED.find((u) => u.slug === "birgun") as Candidate;
    // At most 4 shared stems against any member, Jaccard 0.364 at best: below 0.5.
    expect(W_MEMBERS.some((m) => siblingTitlesMatch(m.title, birgun.title))).toBe(false);
  });

  it("counting the matched silent-side sources drops the dominant share below BLINDSPOT.dominantShare", () => {
    const k = new Set(voters(UNCLUSTERED).filter((v) => zoneOf(v.bias) === "muhalefet").map((v) => v.slug)).size;
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBe(3);
    const before = W_MEMBERS.length / W_MEMBERS.length;
    const after = W_MEMBERS.length / (W_MEMBERS.length + k);
    expect(before).toBeGreaterThanOrEqual(BLINDSPOT.dominantShare);
    expect(after).toBeCloseTo(0.625, 10);
    expect(after).toBeLessThan(BLINDSPOT.dominantShare);
  });

  it("the arm's filters hold: a gate category, a non-voting kind or a member's own source adds no voter", () => {
    const base = UNCLUSTERED[0] as Candidate;
    expect(voters([{ ...base, category: "politika" }])).toHaveLength(0);
    expect(voters([{ ...base, category: "son_dakika" }])).toHaveLength(0);
    expect(voters([{ ...base, kind: "aggregator" }])).toHaveLength(0);
    expect(voters([{ ...base, kind: "niche" }])).toHaveLength(0);
    expect(voters([{ ...base, slug: "star" }])).toHaveLength(0);
    expect(voters([base])).toHaveLength(1);
  });
});
