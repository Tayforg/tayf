import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, BLINDSPOT } from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import { SIBLING_VETO } from "../../src/lib/clusters/sibling-veto";

// Migration 180 gives the sibling veto of 126/148 a second, rare-stem evidence tier. 148's pair
// rule (3 shared stems, Jaccard >= 0.5) missed the same story run under a different headline:
// production claims 30b3b262 (celik kasa) and f1837ee1 (Milli Enerji 2040) kept a public "Kor
// nokta" badge while the silent zone had run the event (6 shared stems, Jaccard 0.43). The new
// tier accepts Jaccard >= 0.3 when at least two of the shared stems are rare in the MEMBER
// ARTICLE'S OWN pair window (document frequency <= 0.25 percent of the voting-source articles
// published within 24 hours either side of that member). The line is a function of the member
// alone: it does not move with p_since / v_scope or with other clusters' member dates (review
// findings DB-1 and DB-2), and its base is the voting-source pool the /metodoloji sentence names
// (twin-parity-1). This file is the source of truth for what "aranan haberler" means there.
//
// 180 repeats 148's function body verbatim except for two new CTEs (wdf, wlim), two joins in
// `pairs`, one GROUP BY column and the HAVING clause of `pairs`. This file pins (1) the md5 of
// the body production runs before 180 against 148's text, (2) body parity: delete the two CTEs,
// the two joins and the column, neutralise the HAVING, and the rest must equal 148's body, (3)
// the new text itself, with every number pinned to SIBLING_VETO, (4) the safety properties of
// the definer function and the shape of the file (one transaction, function swap and ledger row
// only, no data write, no cron). The behaviour is exercised by
// tests/migrations/sql/180-blindspot-sibling-rare-tier-dryrun.sql on PG15.

const MIGRATIONS = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS, "180_blindspot_sibling_rare_tier.sql");
const MIGRATION_148 = resolve(MIGRATIONS, "148_blindspot_unclustered_siblings.sql");
const DRYRUN = resolve(__dirname, "sql", "180-blindspot-sibling-rare-tier-dryrun.sql");

// md5(prosrc) of public.blindspot_recall_veto_refresh on production before 180 (read-only,
// 2026-11-08; 10855 characters, identity arguments "p_since interval, p_min_prob numeric").
// 148 is applied there, so it equals the md5 of the text between 148's dollar-quote markers.
const PROD_MD5_BEFORE = "088ed2ba0ac5b70682065346955a137e";
const PROD_LENGTH_BEFORE = 10855;

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

type Cte = { start: number; end: number; text: string };

/** The CTE `name as (...)` of a comment-free body: its offsets and its collapsed text, or null. */
function cteOf(body: string, name: string): Cte | null {
  const m = new RegExp(`(^|[\\s,])${escapeRegExp(name)}\\s+as\\s+(?:materialized\\s+)?\\(`).exec(body);
  if (!m) return null;
  const start = m.index + (m[1] as string).length;
  const open = m.index + m[0].length - 1;
  const close = closingParen(body, open);
  if (close < 0) return null;
  return { start, end: close + 1, text: collapse(body.slice(start, close + 1)) };
}

/** `body` without the CTE `name` and the comma that follows it. */
function withoutCte(body: string, name: string): string {
  const c = cteOf(body, name);
  if (!c) return body;
  const tail = body.slice(c.end).replace(/^\s*,/, "");
  return body.slice(0, c.start) + tail;
}

type Pairs = { neutral: string; having: string; inner: string };

/** The `pairs` CTE split at its HAVING: the body with the HAVING text replaced by a marker. */
function pairsOf(body: string): Pairs | null {
  const at = body.indexOf("pairs as (");
  if (at < 0) return null;
  const open = at + "pairs as (".length - 1;
  const close = closingParen(body, open);
  if (close < 0) return null;
  const inner = body.slice(open + 1, close);
  const h = inner.search(/\bhaving\b/i);
  if (h < 0) return null;
  return {
    neutral: body.slice(0, open + 1 + h) + "<HAVING>" + body.slice(close),
    having: collapse(inner.slice(h)),
    inner: collapse(inner),
  };
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
let sql148 = "";
let code148 = "";
let body180 = "";
let body148 = "";
beforeAll(() => {
  // A missing migration fails each assertion below instead of the whole file.
  sql = existsSync(MIGRATION) ? readFileSync(MIGRATION, "utf8") : "";
  code = stripSqlComments(sql);
  sql148 = readFileSync(MIGRATION_148, "utf8");
  code148 = stripSqlComments(sql148);
  body180 = stripSqlComments(fnBody(sql));
  body148 = stripSqlComments(fnBody(sql148));
});

const header = (): string => sql.slice(0, sql.search(/^begin;/m));

describe("180 header and bookkeeping", () => {
  it("the header md5 is the md5 of 148's function body, which production runs", () => {
    expect(fnBody(sql148).length).toBe(PROD_LENGTH_BEFORE);
    expect(createHash("md5").update(fnBody(sql148)).digest("hex")).toBe(PROD_MD5_BEFORE);
    expect(header()).toMatch(/\b[0-9a-f]{32}\b/);
    expect(header()).toContain(PROD_MD5_BEFORE);
    expect(header()).toContain(String(PROD_LENGTH_BEFORE));
  });

  it("the header names the production evidence and the adjudicated cases", () => {
    for (const id of ["30b3b262", "f1837ee1", "9baf5dae", "df635766", "87bcc51b", "bb8f5ea3", "23132be4"]) {
      expect(header()).toContain(id);
    }
    for (const part of ["WHY", "THE TIER", "PERF", "IMPACT", "DRY-RUN", "DEPLOY ORDER", "FOUNDER STEP", "ROLLBACK"]) {
      expect(header()).toContain(part);
    }
  });

  it("the header records the known limit: generic wording is out of reach (23132be4, Fransa genel grev)", () => {
    const text = collapse(header().split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    expect(text).toMatch(/Known limit/);
    expect(text).toContain("23132be4");
    expect(text).toContain("Fransa genel grev");
    expect(text).toMatch(/out of reach/i);
    // the error direction stays "badge hidden", never "badge invented"
    expect(text).toMatch(/badge hidden/);
  });

  it("the header describes the per-member line (wdf, wlim) and no longer admits a looser 16 day call", () => {
    const text = collapse(header().split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    expect(text).toContain("wdf");
    expect(text).toContain("wlim");
    // the first draft's scope-wide CTEs are not described as the current rule
    expect(text).not.toMatch(/\bsdf\b/);
    expect(text).not.toMatch(/\bslim\b/);
    expect(text).toMatch(/Window sensitivity/);
    expect(text).toMatch(/same verdict/i);
    expect(text).not.toMatch(/looser than the cron/i);
    // the flips and the two that stay public are recorded
    for (const id of ["30b3b262", "f1837ee1", "bb8f5ea3", "23132be4"]) expect(text).toContain(id);
  });

  it("docs/migration-guide.md carries the same founder step and no longer calls a 16 day call looser", () => {
    const guide = readFileSync(resolve(__dirname, "..", "..", "docs", "migration-guide.md"), "utf8");
    const at = guide.indexOf("## 180 ");
    expect(at).toBeGreaterThan(0);
    const section = collapse(guide.slice(at));
    expect(section).toContain("blindspot_recall_veto_refresh(interval '16 days')");
    expect(section).not.toMatch(/looser than the cron/i);
    expect(section).not.toMatch(/the search window/i);
    expect(section).toMatch(/same verdict/i);
  });

  it("the header records the EXPLAIN cold and warm numbers", () => {
    expect(header()).toMatch(/EXPLAIN/);
    const lines = header().split("\n");
    for (const run of ["cold", "warm"]) {
      const word = new RegExp(`\\b${escapeRegExp(run)}\\b`, "i");
      expect(lines.some((l) => word.test(l) && /\d(\.\d+)? ?(s|ms)\b/.test(l))).toBe(true);
    }
  });

  it("the header records the dry-run twice on PG15", () => {
    expect(header()).toMatch(/DRYRUN 180 OK/);
    expect(header()).toMatch(/PostgreSQL 15|PG15/);
    expect(header()).toMatch(/twice/i);
  });

  it("the header states the deploy order (none) and the founder's one-off re-score, with its timeout", () => {
    expect(header()).toMatch(/DEPLOY ORDER:\s*none/);
    const text = collapse(header().split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join(" "));
    expect(text).toContain("blindspot_recall_veto_refresh(interval '16 days')");
    expect(text).toContain("set local statement_timeout = '120s'");
    // this migration never re-scores anything itself
    expect(text).toMatch(/does NOT (backfill|re-score)/i);
  });

  it("the header's rollback re-applies 148's function block and removes the ledger row", () => {
    const rollback = collapse(
      header()
        .slice(header().indexOf("ROLLBACK"))
        .split("\n")
        .map((l) => (l.startsWith("--") ? l.slice(2) : l))
        .join(" "),
    );
    expect(rollback).toMatch(/148/);
    expect(rollback).toMatch(/function, comment, revoke,? (and )?grant/);
    expect(rollback).toContain("where version = '180'");
  });

  it("is additive and writes no data: no drop, delete, truncate, alter table, DO block or function call", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|column|function|index|constraint|trigger|policy)\b/i);
    expect(code).not.toMatch(/\b(delete\s+from|truncate)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bdo\s+\$/i);
    const bare = stripSqlStrings(code);
    expect(bare).not.toMatch(/\b(select|perform)\s+(public\.)?blindspot_recall_veto_refresh\b/i);
    expect(bare).not.toMatch(/:=\s*public\.blindspot_recall_veto_refresh\b/i);
    // no backfill: the file never calls the function it replaces
    expect(bare).not.toMatch(/\bblindspot_recall_veto_refresh\s*\(\s*interval\s+'/i);
  });

  it("never touches pg_cron: the 148 command with statement_timeout 120s stays", () => {
    const bare = stripSqlStrings(code);
    expect(bare).not.toMatch(/\bcron\b/i);
    expect(bare).not.toMatch(/\balter_job\b/i);
    expect(code).not.toMatch(/\bstatement_timeout\b/i);
    // the 148 file is where the command is set, and it stays set there
    expect(code148).toContain("'set local statement_timeout = ''120s''; select public.blindspot_recall_veto_refresh();'");
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

  it("records itself as version '180' with the 148 insert pattern", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'180'\s*,\s*'180_blindspot_sibling_rare_tier'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;/i,
    );
    expect([...code.matchAll(/insert\s+into\s+supabase_migrations\.schema_migrations/gi)]).toHaveLength(1);
  });

  it("never touches indexes, tables, views, triggers or policies", () => {
    expect(code).not.toMatch(
      /\bcreate\s+(or\s+replace\s+)?(unique\s+)?(materialized\s+)?(trigger|policy|view|table|extension|index|sequence|type)\b/i,
    );
  });

  it("sanity: comment stripping is non-vacuous and the file has exactly one $fn$ pair", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect([...sql.matchAll(/\$fn\$/g)]).toHaveLength(2);
    expect(body180.length).toBeGreaterThan(1000);
  });

  it("the dry-run script exists, applies 180 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN)).toBe(true);
    const dry = existsSync(DRYRUN) ? readFileSync(DRYRUN, "utf8") : "";
    expect([...dry.matchAll(/^\\ir [^\n]*180_blindspot_sibling_rare_tier\.sql$/gm)]).toHaveLength(2);
    expect(dry.trimEnd().split("\n").pop()).toBe("select 'DRYRUN 180 OK';");
  });
});

describe("180 body parity with 148", () => {
  // The text 180 adds to `pairs` outside its HAVING: two joins and one GROUP BY column.
  const JOIN_WDF = " join wdf on wdf.article_id = w.article_id and wdf.tok = w.tok";
  const JOIN_WLIM = " join wlim on wlim.article_id = w.article_id";
  const GROUP_COL = ", wlim.lim";

  it("without the two new CTEs, the two joins and the group column, and with the HAVING neutralised, the body is 148's", () => {
    const stripped = withoutCte(withoutCte(body180, "wdf"), "wlim");
    const mine = pairsOf(stripped);
    const theirs = pairsOf(body148);
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    const raw = collapse((mine as Pairs).neutral);
    // each removal must actually remove something, or the parity below proves nothing
    for (const piece of [JOIN_WDF, JOIN_WLIM, GROUP_COL]) expect(raw).toContain(piece);
    const mineText = raw.replace(JOIN_WDF, "").replace(JOIN_WLIM, "").replace(GROUP_COL, "");
    expect(mineText).toBe(collapse((theirs as Pairs).neutral));
  });

  it("the parity is not vacuous: the two bodies differ and 148's HAVING is the strict tier alone", () => {
    expect(collapse(body180)).not.toBe(collapse(body148));
    const theirs = pairsOf(body148) as Pairs;
    expect(theirs.having).toBe(
      "having pg_catalog.count(*) >= 3 and pg_catalog.count(*)::numeric / (w.ntok + st.ntok - pg_catalog.count(*)) >= 0.5",
    );
    expect(cteOf(body148, "wdf")).toBeNull();
    expect(cteOf(body148, "wlim")).toBeNull();
    // the scope-wide CTEs of the first 180 draft are gone for good: the line is per member
    expect(cteOf(body180, "sdf")).toBeNull();
    expect(cteOf(body180, "slim")).toBeNull();
  });

  it("keeps the freeze, the scope, the reason values and the wmem exclusion of 126/148 (spelled out)", () => {
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

  it("the translate() literals still equal the shared fold strings (checked against 148's)", () => {
    const re = /translate\(\s*coalesce\(\s*a\.title\s*,\s*''\s*\)\s*,\s*'([^']*)'\s*,\s*'([^']*)'\s*\)/g;
    const mine = [...code.matchAll(re)].map((m) => [m[1], m[2]]);
    const theirs = [...code148.matchAll(re)].map((m) => [m[1], m[2]]);
    expect(mine.length).toBeGreaterThanOrEqual(2);
    expect(mine).toEqual(theirs);
  });
});

describe("180 the rare tier", () => {
  const WINDOW = `${SIBLING_VETO.windowHours} hours`;
  const VOTING_IN = `s.kind in (${VOTING_SOURCE_KINDS.map((k) => `'${k}'`).join(",")})`;

  it("adds wdf and wlim after stok and before pairs, and nothing else as a CTE", () => {
    const order = ["stok as (", "wdf as materialized (", "wlim as materialized (", "pairs as ("].map((s) => body180.indexOf(s));
    for (const at of order) expect(at).toBeGreaterThan(0);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    const ctes148 = [...body148.matchAll(/(?:^|[\s,])(\w+)\s+as\s+(?:materialized\s+)?\(\s*(?:select|values)\b/gi)].map((m) => m[1]);
    const ctes180 = [...body180.matchAll(/(?:^|[\s,])(\w+)\s+as\s+(?:materialized\s+)?\(\s*(?:select|values)\b/gi)].map((m) => m[1]);
    expect(ctes180.filter((n) => !ctes148.includes(n))).toEqual(["wdf", "wlim"]);
    expect(ctes148.filter((n) => !ctes180.includes(n))).toEqual([]);
  });

  it("wdf is the document frequency in the MEMBER's window: distinct voting candidates within 24 h, per member stem", () => {
    // one row per (member article, stem); the window is st.published_at within +-windowHours of
    // w.published_at, so neither p_since / v_scope nor another cluster's member dates move it.
    expect((cteOf(body180, "wdf") as Cte).text).toBe(
      "wdf as materialized (select w.article_id, w.tok, pg_catalog.count(distinct st.article_id) as df " +
        "from wtok w join stok st on st.tok = w.tok " +
        `and st.published_at between w.published_at - interval '${WINDOW}' and w.published_at + interval '${WINDOW}' ` +
        "join public.sources s on s.id = st.source_id " +
        `where ${VOTING_IN} ` +
        "group by w.article_id, w.tok)",
    );
  });

  it("wlim is rareMaxDocShare of the voting candidates within 24 h of each member (a window over scand, no members x scand join)", () => {
    const share = String(SIBLING_VETO.rareMaxDocShare);
    expect(share).toBe("0.0025");
    expect((cteOf(body180, "wlim") as Cte).text).toBe(
      `wlim as materialized (select article_id, ${share} * n as lim from ` +
        "(select article_id, is_member, pg_catalog.count(*) filter (where not is_member) " +
        `over (order by published_at range between interval '${WINDOW}' preceding and interval '${WINDOW}' following) as n ` +
        "from (select distinct c.article_id, c.published_at, false as is_member from scand c " +
        "join public.sources s on s.id = c.source_id " +
        `where ${VOTING_IN} ` +
        "union all select distinct article_id, published_at, true from wart) u) t where is_member)",
    );
  });

  it("the base of the rare line is the voting-source pool in both CTEs, and it is the 24 h pool /metodoloji names", () => {
    // Source of truth for "aranan haberler" in src/app/metodoloji/page.tsx (twin-parity-1): the
    // voting kinds, +-windowHours around the member, nothing wider.
    for (const name of ["wdf", "wlim"]) {
      const text = (cteOf(body180, name) as Cte).text;
      const kinds = [...text.matchAll(/\bkind\s+in\s*\(([^)]+)\)/gi)];
      expect(kinds).toHaveLength(1);
      expect(new Set(quotedList((kinds[0] as RegExpMatchArray)[1] as string))).toEqual(new Set(VOTING_SOURCE_KINDS));
      expect(text).toContain(`interval '${WINDOW}'`);
    }
    expect(SIBLING_VETO.windowHours).toBe(24);
    // no scope-wide count of the whole of scand survives anywhere in the new text
    const fresh = [(cteOf(body180, "wdf") as Cte).text, (cteOf(body180, "wlim") as Cte).text].join(" ");
    expect(fresh).not.toMatch(/count\(distinct article_id\)\s+as\s+lim/i);
    expect(fresh).not.toMatch(/\bselect\s+lim\s+from\b/i);
  });

  it("pairs joins wdf on (member article, stem) and wlim on the member article", () => {
    const pairs = pairsOf(body180) as Pairs;
    expect(pairs).not.toBeNull();
    expect(pairs.inner).toContain(
      "from wtok w join stok st on st.tok = w.tok " +
        "join wdf on wdf.article_id = w.article_id and wdf.tok = w.tok " +
        "join wlim on wlim.article_id = w.article_id where",
    );
    // the member's line is a grouped column of the pair, like the member's own ntok
    expect(pairs.inner).toContain("group by w.cluster_id, w.article_id, w.ntok, st.cluster_id, st.article_id, st.source_id, st.ntok, wlim.lim having");
  });

  it("the pairs HAVING is the strict tier OR the rare tier, every literal pinned to SIBLING_VETO", () => {
    const jac = "pg_catalog.count(*)::numeric / (w.ntok + st.ntok - pg_catalog.count(*))";
    const expected =
      `having pg_catalog.count(*) >= ${SIBLING_VETO.minShared} ` +
      `and (${jac} >= ${SIBLING_VETO.minJaccard} ` +
      `or (${jac} >= ${SIBLING_VETO.looseMinJaccard} ` +
      `and pg_catalog.count(*) filter (where wdf.df <= wlim.lim) >= ${SIBLING_VETO.rareMinShared}))`;
    expect((pairsOf(body180) as Pairs).having).toBe(expected);
  });

  it("the SQL carries one shared-stem gate for both tiers, so the two TypeScript floors must be equal", () => {
    expect(SIBLING_VETO.looseMinShared).toBe(SIBLING_VETO.minShared);
    expect(SIBLING_VETO.looseMinJaccard).toBeLessThan(SIBLING_VETO.minJaccard);
  });

  it("the rare-stem count is a count of shared stems: a filter on the grouped pair, never another join", () => {
    const pairs = pairsOf(body180) as Pairs;
    expect([...pairs.inner.matchAll(/\bjoin\b/gi)]).toHaveLength(3);
    expect([...pairs.inner.matchAll(/\bfilter\s*\(\s*where\b/gi)]).toHaveLength(1);
  });

  it("the reason value stays sibling_headline: no new reason, no UI contract change", () => {
    const stored = new Set([...code.matchAll(/blindspot_veto_reason\s*=\s*'([a-z_]+)'/g)].map((m) => m[1]));
    expect([...stored]).toEqual(["sibling_headline"]);
    expect(code).not.toMatch(/'[a-z_]*rare[a-z_]*'\s*(then|end|,)/i);
  });

  it("the function comment names the rare tier and records the known limit", () => {
    const m = /comment\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+is([\s\S]*?);\s*\n/i.exec(
      code,
    );
    expect(m).not.toBeNull();
    const text = collapse(((m as RegExpExecArray)[1] as string).replace(/'\s*'/g, ""));
    expect(text).toMatch(/\brare\b/i);
    expect(text).toMatch(/out of reach/i);
    expect(text).toMatch(/unclustered/i);
    expect(text).toMatch(/migrations 071, 126, 148 and 180/);
  });
});

describe("180 parity with the voting-kind and zone contracts", () => {
  it("every kind-in list (Jev path, sibling path, arm 2) equals VOTING_SOURCE_KINDS", () => {
    const lists = [...code.matchAll(/\bkind\s+in\s*\(([^)]+)\)/gi)];
    // Jev path, sibling path, arm 2, and (180) wdf and wlim
    expect(lists.length).toBeGreaterThanOrEqual(5);
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

describe("180 function safety", () => {
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

  it("qualifies every function call and aggregate in the new text (search_path is empty)", () => {
    // wdf, wlim and the HAVING: the only new SQL. count() is always pg_catalog-qualified.
    const fresh = [(cteOf(body180, "wdf") as Cte).text, (cteOf(body180, "wlim") as Cte).text, (pairsOf(body180) as Pairs).having];
    for (const text of fresh) {
      expect(text).not.toMatch(/(?<![.\w])count\s*\(/i);
    }
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
