import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ARCHIVE_MAX_PAGE, ARCHIVE_PAGE_SIZE } from "../../src/lib/seo/home-canonical";
import { assertLiveReady } from "../_helpers/live-db";

// ---------------------------------------------------------------------------
// Contract test for migration 215 ("search_cluster_ids_new"), h191 (hunt 191, h190's search lens).
//
// The archive search ranks (search_cluster_ids, 204's body is the live one): a blend of literal-title tier, relevance, recency and
// corroboration over the 1000 newest candidates. For the hottest entity queries same-day stories fall off page 1 or beyond the 96 reachable,
// and there is no date sort. 215 CREATES search_cluster_ids_new(p_variants, p_folded, p_limit default 24, p_offset default 0): the newest
// clusters whose DISPLAY TITLE literally holds the query, newest first, one page of at most 24 per call. Its body is 204's candidate chain
// (the three arms, the 166 guard, 172's words, 194's literal tier lw / lit_d) with FIVE edits: `kept` is NOT MATERIALIZED, `top` keeps the
// newest 150 survivors instead of 1000, two comment lines that named the 1000, `hits` is MATERIALIZED (a fence: the final ORDER BY must not
// be served from idx_clusters_updated_at), and the final select (the literal filter, the date order, the limit and offset clamps) instead of 194's score. search_cluster_ids and search_cluster_ids_v2 are not touched.
//
// This file pins, without a database: the file, ledger and transaction, additive-only SQL, 204's body is production's (md5 and length
// pinned), 215's body is 204's with exactly those edits, the clamps equal the app's page constants, the attributes and grants, the
// comment, the header (evidence, cost, deploy order, rollback), the docs section, the dry-run and the manifest entry. The live block
// (TAYF_PSQL) seeds clusters inside rolled-back transactions and checks the contract on a real Postgres.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_204 = "204_search_single_letter_compounds.sql";
const FILE_211 = "211_search_cluster_ids_v2_offset.sql";
const FILE_214 = "214_neutral_title_repick_fast.sql";
const FILE_215 = "215_search_cluster_ids_new.sql";
const MIGRATION_204 = resolve(MIGRATIONS_DIR, FILE_204);
const MIGRATION_211 = resolve(MIGRATIONS_DIR, FILE_211);
const MIGRATION_215 = resolve(MIGRATIONS_DIR, FILE_215);
const DRYRUN_215 = resolve(ROOT, "tests", "migrations", "sql", "215-search-cluster-ids-new-dryrun.sql");
const MANIFEST = resolve(ROOT, "tests", "migrations", "sql", "live-manifest.txt");
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const SEARCH_QUERY_SOURCE = resolve(ROOT, "src", "lib", "clusters", "search-query.ts");

/** Production, read-only, 2026-11-15: md5(prosrc) and length(prosrc) of the live search_cluster_ids(text[], text, integer) = 204's body. */
const LIVE_MD5 = "32b42ca06d6b0c2a3ba8bf1264d353f7";
const LIVE_LENGTH = 22892;
/** Production, read-only, 2026-11-15: search_cluster_ids_v2 (migration 211), which 215 leaves alone. */
const V2_MD5 = "c91d45d81b53a71b007aa6de2d1a5ed7";
const V2_LENGTH = 22945;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.search_cluster_ids_new";
const FN_SIG = `${FN}(text[], text, integer, integer)`;

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('215', '215_search_cluster_ids_new') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

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

/** Whitespace runs to one space, parentheses hugged, ends trimmed (character scan, no regular expression). */
function collapse(s: string): string {
  let out = "";
  let pendingSpace = false;
  for (const ch of s) {
    if (ch === " " || ch === "\n" || ch === "\t" || ch === "\r") {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) {
      if (ch !== ")") out += " ";
      pendingSpace = false;
    }
    out += ch;
    if (ch === "(") pendingSpace = false;
  }
  return out;
}

/** A comment block read as prose: `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return collapse(text.split("\n").map((l) => (l.startsWith("--") ? l.slice(2) : l)).join("\n"));
}

const md5 = (text: string): string => createHash("md5").update(text).digest("hex");

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/** The text between the first two dollar-quote markers: Postgres' prosrc. Comments in the file header are not part of it. */
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

/** Statements with the dollar-quoted body replaced by a marker and whitespace collapsed. */
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

/** The `## <num>` section of the migration guide, through the next `## ` heading. */
function sectionOf(md: string, num: string): string {
  const at = md.indexOf(`\n## ${num} `);
  expect(at, `the ## ${num} section`).toBeGreaterThan(0);
  const next = md.indexOf("\n## ", at + 1);
  return md.slice(at, next < 0 ? md.length : next);
}

/** `text` with its one occurrence of `from` replaced; throws when `from` is not found exactly once. */
function replaceOnce(text: string, from: string, to: string): string {
  const n = countOf(text, from);
  if (n !== 1) throw new Error(`expected exactly one occurrence, found ${n}: ${from.slice(0, 60)}`);
  return text.replace(from, () => to);
}

const sql204 = readFileSync(MIGRATION_204, "utf8");
const body204 = functionBody(sql204);
const sql211 = readFileSync(MIGRATION_211, "utf8");
const body211 = functionBody(sql211);
const sql215 = existsSync(MIGRATION_215) ? readFileSync(MIGRATION_215, "utf8") : "";
const header215 = (): string => {
  expect(existsSync(MIGRATION_215), `${FILE_215} must exist`).toBe(true);
  return sql215.split("\nbegin;")[0] as string;
};
const body215 = (): string => {
  expect(existsSync(MIGRATION_215), `${FILE_215} must exist`).toBe(true);
  return functionBody(sql215);
};

/** Where 204's final select starts (215 replaces it), and the 204 lines the five edits change. */
const V1_TAIL_START = "  select h.id\n  from hits h cross join q\n";
const V1_TOP = "    select k.id from kept k order by k.updated_at desc, k.id limit 1000\n";
const V1_TOP_COMMENT = "    -- Candidate cap: only the 1000 most recently updated hits are scored.\n";
const V1_KEPT_COMMENT = "    -- `top` stops after 1000 survivors. r is the primary-key read of the cluster, fenced with\n";
const V1_KEPT_OPEN = "  ), kept as (\n    -- 166 guard, step 3:";
const V1_HITS_OPEN = "  ), hits as (\n    -- 172 tier.";

/** 215's text for the same places. */
const V215_TOP = "    select k.id from kept k order by k.updated_at desc, k.id limit 150\n";
const V215_TOP_COMMENT =
  "    -- 215: the newest-candidate cap: only the 150 most recently updated survivors are kept (204 and 211 keep 1000 and score them).\n";
const V215_KEPT_COMMENT =
  "    -- `top` stops after 150 survivors (215; 204 and 211 stop after 1000). r is the primary-key read of the cluster, fenced with\n";
const V215_KEPT_OPEN =
  "  ), kept as not materialized (\n" +
  "    -- 215: NOT MATERIALIZED, as the h190 measurement ran it: the guard below is applied to the candidates `top` asks for, newest first, and the\n" +
  "    -- scan stops once `top` has its 150 survivors, so only as many candidates as that takes are guarded, not the whole candidate set.\n" +
  "    -- 166 guard, step 3:";
const V215_HITS_OPEN =
  "  ), hits as materialized (\n" +
  "    -- 215: MATERIALIZED, a fence: hits joins public.clusters, so without it the planner (the function is not inlined and is planned with p_limit and p_offset unbound)\n" +
  "    -- can walk idx_clusters_updated_at in recency order for the final ORDER BY and stop only after offset+limit literal rows, which times out on a sparse query or a\n" +
  "    -- later page. hits is at most 150 rows.\n" +
  "    -- 172 tier.";
/** The head of 215's final select; its clauses follow. */
const V215_TAIL_START = "  select h.id\n  from hits h\n";

/** What 215's body starts with: 204's body up to its final select, with exactly the five edits made, each found once. */
function expectedHead(): string {
  const at = body204.lastIndexOf(V1_TAIL_START);
  expect(at, "204's final select").toBeGreaterThan(0);
  let head = body204.slice(0, at);
  head = replaceOnce(head, V1_KEPT_OPEN, V215_KEPT_OPEN);
  head = replaceOnce(head, V1_HITS_OPEN, V215_HITS_OPEN);
  head = replaceOnce(head, V1_KEPT_COMMENT, V215_KEPT_COMMENT);
  head = replaceOnce(head, V1_TOP_COMMENT, V215_TOP_COMMENT);
  head = replaceOnce(head, V1_TOP, V215_TOP);
  return head;
}

describe("215 search_cluster_ids_new: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 215 (197 and 202 are held on other branches and are not used)", () => {
    expect(existsSync(MIGRATION_215)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("215_"))).toEqual([FILE_215]);
    expect(FILE_215 > FILE_214).toBe(true);
    expect(FILE_215.startsWith("197_") || FILE_215.startsWith("202_")).toBe(false);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("197_") || f.startsWith("202_"))).toEqual([]);
  });

  it("no other migration defines search_cluster_ids_new", () => {
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).includes("function public.search_cluster_ids_new("));
    expect(definers).toEqual([FILE_215]);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(sql215);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql215, "\nbegin;")).toBe(1);
    expect(countOf(sql215, "\ncommit;")).toBe(1);
  });

  it("records version 215 in the schema_migrations ledger, idempotently, as the last statement before commit", () => {
    const code = collapse(stripComments(sql215));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("notifies pgrst to reload its schema cache (the app reads PGRST202 until it has)", () => {
    expect(statements(sql215)).toContain("notify pgrst, 'reload schema'");
  });
});

describe("215 search_cluster_ids_new: the production fingerprint it was built from", () => {
  it("204's function body is production's live body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body204)).toBe(LIVE_MD5);
    expect([...body204].length).toBe(LIVE_LENGTH);
  });

  it("211's body is production's search_cluster_ids_v2, which 215 leaves alone", () => {
    expect(md5(body211)).toBe(V2_MD5);
    expect([...body211].length).toBe(V2_LENGTH);
  });

  it("the header records STEP 0: the fingerprints, the attributes and that there is no search_cluster_ids_new yet", () => {
    const header = header215();
    expect(header).toContain("STEP 0");
    expect(header).toContain(LIVE_MD5);
    expect(header).toContain(String(LIVE_LENGTH));
    expect(header).toContain(V2_MD5);
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("There is no search_cluster_ids_new");
    expect(flat(header)).toContain("204_search_single_letter_compounds.sql");
  });

  it("the header names the evidence, the replay and cost numbers, the deploy order, the rollback and the numbering", () => {
    const header = flat(header215());
    for (const word of [
      "h191",
      "h190",
      "REPLAY",
      "COST",
      "NOT MATERIALIZED",
      "150",
      "Erdoğan",
      "seçim",
      "Trump",
      "deprem",
      "newest 24 literal",
      "PGRST202",
      "ROLLBACK",
      "NUMBER",
      "197",
      "202",
      "APPLY 215 FIRST, THEN DEPLOY",
      "lit_d",
    ]) {
      expect(header, word).toContain(word);
    }
    expect(header).toContain("drop function public.search_cluster_ids_new(text[], text, integer, integer)");
    expect(header).toContain("version = '215'");
    expect(header.startsWith("215_search_cluster_ids_new.sql")).toBe(true);
  });

  it("the header, the body and the guide say the list is the literal matches among the newest 150, often shorter than 96 rows, and name the five edits and the deployed-shape cost", () => {
    const header = flat(header215());
    expect(header).toContain("with FIVE edits");
    expect(header).toContain("often shorter than 96 rows for an ordinary term");
    expect(header).toContain("pages 3 and 4 can be short or empty");
    expect(header).toContain("Bu sayfada sonuç yok.");
    expect(header).toContain("The 96 holds for Erdoğan and deprem, not for every term");
    // the cost is measured on the plan the function really runs (generic, limit and offset unbound), not on a constant-limit inline body
    expect(header).toContain("force_generic_plan");
    expect(header).toContain("did not describe the deployed plan");
    expect(header.includes("A very sparse query")).toBe(false);
    const body = flat(
      body215()
        .split("\n")
        .map((l) => l.trim())
        .join("\n"),
    );
    expect(body).toContain("often fewer than 96 rows for an ordinary term");
    expect(body.includes("a very sparse query")).toBe(false);
    const section = sectionOf(readFileSync(DOC_MIGRATION_GUIDE, "utf8"), "215");
    expect(section).toContain("with five edits");
    expect(section).toContain("often shorter than 96 rows for an ordinary term");
    expect(section).toContain("the 96-row result holds for those two, not for every term");
    expect(section).toContain("force_generic_plan");
    expect(section.includes("A very sparse query")).toBe(false);
    expect(readFileSync(resolve(ROOT, "docs", "FEATURE_ROADMAP.md"), "utf8")).toContain("up to 4 pages of 24, the literal matches among the newest 150 candidates");
  });

  it("VERIFY carries the md5 and the length of THIS file's function body", () => {
    const body = body215();
    expect(header215()).toContain(`${md5(body)}, ${[...body].length}`);
    expect(md5(body)).not.toBe(LIVE_MD5);
    expect(md5(body)).not.toBe(V2_MD5);
  });

  it("VERIFY checks the grants (false, false, true) and compares the first 24 ids with the newest 24 literal matches", () => {
    const header = header215();
    const at = header.indexOf("-- VERIFY");
    const end = header.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(header.slice(at, end));
    expect(verify).toContain("public.search_cluster_ids_new(array['deprem'], 'deprem', 24, 0)");
    expect(verify).toContain("has_function_privilege('anon'");
    expect(verify).toContain("has_function_privilege('service_role'");
    expect(verify).toContain("false, false, true");
  });
});

describe("215 search_cluster_ids_new: the function", () => {
  it("creates search_cluster_ids_new with create or replace, v2's arguments with the limit defaulting to the page size 24", () => {
    const header = collapse(functionHeader(stripComments(sql215))).toLowerCase();
    expect(
      header.startsWith(
        "create or replace function public.search_cluster_ids_new(p_variants text[], p_folded text, p_limit integer default 24, p_offset integer default 0)",
      ),
    ).toBe(true);
    expect(header).toContain("returns table (id uuid)");
  });

  it("is language sql, stable, security definer with an empty search_path: the attributes of search_cluster_ids_v2", () => {
    const h = collapse(functionHeader(stripComments(sql215))).toLowerCase();
    expect(h).toContain("language sql stable security definer set search_path = ''");
    expect(h).not.toContain("volatile");
    expect(h).not.toContain("security invoker");
    const v2Header = collapse(functionHeader(stripComments(sql211))).toLowerCase();
    expect(h.replaceAll("search_cluster_ids_new", "x").replace("p_limit integer default 24", "p_limit integer default 12")).toBe(
      v2Header.replaceAll("search_cluster_ids_v2", "x"),
    );
  });

  it("the body is 204's body with exactly the five edits and a new final select: the candidate chain is 204's byte for byte", () => {
    const body = body215();
    const head = expectedHead();
    expect(body.startsWith(head + V215_TAIL_START)).toBe(true);
    // line by line: 204 and 215 differ only in the edited lines, and 215 adds only the lines of the edits and of its final select
    const a = body204.slice(0, body204.lastIndexOf(V1_TAIL_START)).split("\n");
    const b = head.split("\n");
    expect(b.length - a.length).toBe(
      V215_KEPT_OPEN.split("\n").length - V1_KEPT_OPEN.split("\n").length + (V215_HITS_OPEN.split("\n").length - V1_HITS_OPEN.split("\n").length),
    );
    // the arms, the guard and the literal tier are untouched
    for (const piece of [
      "where c.search_tsv @@ (select qv from q)",
      "public.tayf_search_stem_fold(c.search_tsv) @@ (select qs from qs)",
      "(exists (select 1 from lw) and not exists (select 1 from lw where pg_catalog.strpos(dn.n, ' ' || lw.pre) = 0)) as lit_d",
      "where not exists (select 1 from g where not (pg_catalog.strpos(' ' || a.t, ' ' || g.pre) > 0",
    ]) {
      expect(countOf(body, piece), piece).toBe(countOf(body204, piece));
    }
    expect(md5(head.replace(V215_KEPT_OPEN, V1_KEPT_OPEN).replace(V215_HITS_OPEN, V1_HITS_OPEN).replace(V215_KEPT_COMMENT, V1_KEPT_COMMENT).replace(V215_TOP_COMMENT, V1_TOP_COMMENT).replace(V215_TOP, V1_TOP) + V1_TAIL_START + body204.slice(body204.lastIndexOf(V1_TAIL_START) + V1_TAIL_START.length))).toBe(LIVE_MD5);
  });

  it("kept is NOT MATERIALIZED and top keeps the newest 150, never 1000", () => {
    const body = collapse(stripComments(body215()));
    expect(countOf(body, "), kept as not materialized (")).toBe(1);
    expect(countOf(body, "kept as (")).toBe(0);
    expect(body).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 150), lw as (");
    expect(body.includes("limit 1000")).toBe(false);
    expect(countOf(body, "not materialized")).toBe(1);
    // the 166 guard sees the survivors newest first: the sorted subquery with offset 0 is 204's
    expect(body).toContain("from (select s.id, s.updated_at from cand s order by s.updated_at desc, s.id offset 0) k");
  });

  it("hits is MATERIALIZED: a fence, so the final ORDER BY is never served from idx_clusters_updated_at (a plain hits is a timeout on a sparse query or a later page)", () => {
    // The function is SECURITY DEFINER with a set clause, so it is never inlined and is planned with p_limit and p_offset unbound. Without the fence
    // the planner walks idx_clusters_updated_at in recency order and stops after offset+limit LITERAL rows: measured on production (read-only,
    // plan_cache_mode = force_generic_plan) 57014 for Trump at offset 72 and for 'faiz kararı' at offset 0, 25-64 ms with the fence. A tiny local
    // table cannot show the plan, so this pins the text (the live block checks the contract, not the plan).
    const body = collapse(stripComments(body215()));
    expect(countOf(body, "), hits as materialized (")).toBe(1);
    expect(countOf(body, "), hits as (")).toBe(0);
    // the explanation sits in the body, next to the keyword, for the next reader who wonders whether it can go
    expect(body215()).toContain(V215_HITS_OPEN);
  });

  it("the final select keeps only the literal-title rows (lit_d), or every row when the query has no literal tier (lw empty), newest first", () => {
    const body = body215();
    const tail = collapse(stripComments(body.slice(body.lastIndexOf(V215_TAIL_START))));
    expect(tail).toBe(
      "select h.id from hits h where h.lit_d or not exists (select 1 from lw) order by h.updated_at desc, h.id " +
        "limit least(greatest(coalesce(p_limit, 24), 1), 24) offset greatest(0, least(coalesce(p_offset, 0), 72));",
    );
    // the order is a total order (updated_at, then the id): two pages never share a row
    expect(tail).toContain("order by h.updated_at desc, h.id limit");
  });

  it("reads no ranking: 194's score, lit_ok, the relevance rank and the recency weight are gone from the final select, and ts_rank_cd from the body", () => {
    const body = collapse(stripComments(body215()));
    expect(body.includes("ts_rank_cd")).toBe(false);
    expect(body.includes("1209600")).toBe(false);
    expect(body.includes("h.article_count")).toBe(false);
    expect(body.includes("cross join q")).toBe(false);
    expect(body.includes("h.lit_ok")).toBe(false);
  });

  it("p_limit and p_offset are each read once, in the last clause, clamped: limit 1..24 (null reads 24), offset 0..72 (null reads 0)", () => {
    const body = collapse(stripComments(body215()));
    expect(countOf(body, "p_limit")).toBe(1);
    expect(countOf(body, "p_offset")).toBe(1);
    expect(body.endsWith("limit least(greatest(coalesce(p_limit, 24), 1), 24) offset greatest(0, least(coalesce(p_offset, 0), 72));")).toBe(true);
    expect(countOf(body, "p_variants")).toBe(countOf(collapse(stripComments(body204)), "p_variants"));
    expect(countOf(body, "p_folded")).toBe(countOf(collapse(stripComments(body204)), "p_folded"));
  });

  it("the clamps are the app's: 24 rows a page, 4 pages, the last offset is (4 - 1) * 24 = 72", () => {
    const source = readFileSync(SEARCH_QUERY_SOURCE, "utf8");
    expect(source).toContain("export const SEARCH_LIMIT = 24;");
    expect(ARCHIVE_PAGE_SIZE).toBe(24);
    expect(ARCHIVE_MAX_PAGE).toBe(4);
    expect(body215()).toContain(`limit least(greatest(coalesce(p_limit, ${ARCHIVE_PAGE_SIZE}), 1), ${ARCHIVE_PAGE_SIZE}) offset greatest(0, least(coalesce(p_offset, 0), ${(ARCHIVE_MAX_PAGE - 1) * ARCHIVE_PAGE_SIZE}))`);
    // the newest 150 survivors hold the 96 rows the four pages can ask for
    expect(ARCHIVE_MAX_PAGE * ARCHIVE_PAGE_SIZE).toBeLessThanOrEqual(150);
  });

  it("the app calls this function with p_variants, p_folded, p_limit and p_offset (page - 1) * SEARCH_LIMIT", () => {
    const source = readFileSync(SEARCH_QUERY_SOURCE, "utf8");
    const at = source.indexOf('rpc("search_cluster_ids_new"');
    expect(at, "the app's call").toBeGreaterThan(0);
    const call = source.slice(at, source.indexOf("});", at));
    expect(call).toContain("p_variants: typed");
    expect(call).toContain("p_folded: folded");
    expect(call).toContain("p_limit: SEARCH_LIMIT");
    expect(call).toContain("p_offset: (page - 1) * SEARCH_LIMIT");
  });

  it("the function comment names 215, h191, search_cluster_ids_new, the newest-150 bound and PGRST202, and ends 'service_role only.'", () => {
    const comment = statementStartingWith(sql215, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment.endsWith("service_role only.'")).toBe(true);
    for (const word of ["215", "h191", "search_cluster_ids", "150", "0..72", "PGRST202", "literal"]) {
      expect(comment, word).toContain(word);
    }
  });
});

describe("215 search_cluster_ids_new: the other search functions stay as they are", () => {
  it("does not create, replace, drop, alter, comment on, revoke or grant search_cluster_ids or search_cluster_ids_v2", () => {
    const stmts = statements(sql215).map((s) => s.toLowerCase());
    for (const stmt of stmts) {
      for (const other of ["function public.search_cluster_ids(", "function public.search_cluster_ids (", "function public.search_cluster_ids_v2("]) {
        expect(stmt.includes(other), `${other} in ${stmt.slice(0, 80)}`).toBe(false);
      }
    }
    // the comment's prose may name the two (it says what the function is the sibling of); no other statement does
    const commentAt = sql215.indexOf("comment on function");
    const commentEnd = sql215.indexOf(";\n", commentAt);
    expect(commentAt).toBeGreaterThan(0);
    const code = collapse(stripComments(sql215.slice(0, commentAt) + sql215.slice(commentEnd + 1)));
    expect(code.includes("search_cluster_ids_v2")).toBe(false);
    expect(code.includes("function public.search_cluster_ids(")).toBe(false);
    expect(code.includes("drop function")).toBe(false);
    expect(code.includes("alter function")).toBe(false);
  });

  it("is additive: no table, column, index, trigger, cron job or data change", () => {
    const stmts = statements(sql215).map((s) => s.toLowerCase());
    const allowed = ["begin", "set local lock_timeout", "create or replace function", "comment on function", "revoke all on function", "grant execute on function", "notify pgrst", "insert into supabase_migrations.schema_migrations", "commit"];
    for (const stmt of stmts) {
      expect(
        allowed.some((a) => stmt.startsWith(a)),
        stmt.slice(0, 80),
      ).toBe(true);
    }
    expect(stmts.filter((s) => s.startsWith("create or replace function"))).toHaveLength(1);
    expect(stmts.filter((s) => s.startsWith("insert into"))).toHaveLength(1);
  });
});

describe("215 search_cluster_ids_new: access", () => {
  it("revokes execute from public, anon and authenticated and grants it to service_role only, for this signature (exactly 211's grants)", () => {
    const stmts = statements(sql215);
    expect(stmts).toContain(REVOKE_STMT.slice(0, -1));
    expect(stmts).toContain(GRANT_STMT.slice(0, -1));
    expect(countOf(collapse(stripComments(sql215)), "grant ")).toBe(1);
    expect(collapse(stripComments(sql215)).includes("to anon")).toBe(false);
    expect(collapse(stripComments(sql215)).includes("to authenticated")).toBe(false);
    // 211's pair, signature aside
    const v211 = statements(sql211);
    expect(v211).toContain(REVOKE_STMT.slice(0, -1).replace("search_cluster_ids_new", "search_cluster_ids_v2"));
    expect(v211).toContain(GRANT_STMT.slice(0, -1).replace("search_cluster_ids_new", "search_cluster_ids_v2"));
  });

  it("is not an anon RPC: the anon surface allowlist is untouched and the function needs no ops_health_report identity", () => {
    expect(collapse(stripComments(sql215)).includes("ops_health_report")).toBe(false);
  });
});

describe("215 search_cluster_ids_new: the paging contract (a JS twin of the SQL clamps)", () => {
  const limitOf = (limit: number | null) => Math.min(Math.max(limit ?? 24, 1), 24);
  const offsetOf = (offset: number | null) => Math.max(0, Math.min(offset ?? 0, 72));
  const offsetOfPage = (page: number) => (page - 1) * 24;

  it("pages 1..4 ask for offsets 0, 24, 48 and 72 of 24 rows, and the clamps never change one of them", () => {
    expect([1, 2, 3, 4].map(offsetOfPage)).toEqual([0, 24, 48, 72]);
    for (let page = 1; page <= ARCHIVE_MAX_PAGE; page++) expect(offsetOf(offsetOfPage(page))).toBe(offsetOfPage(page));
    expect(limitOf(24)).toBe(24);
  });

  it("null, zero, negative and oversized limits and offsets are bounded", () => {
    expect([null, 0, -3, 1, 5, 24, 25, 50, 1_000_000].map(limitOf)).toEqual([24, 1, 1, 1, 5, 24, 24, 24, 24]);
    expect([null, -5, 0, 24, 72, 73, 1_000_000].map(offsetOf)).toEqual([0, 0, 0, 24, 72, 72, 72]);
  });
});

describe("215 search_cluster_ids_new: the migration guide", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");

  it("has a ## 215 section whose title carries the apply-first order and the function name", () => {
    const at = guide.indexOf("\n## 215 ");
    expect(at).toBeGreaterThan(0);
    const title = guide.slice(at + 1, guide.indexOf("\n", at + 1));
    expect(title).toContain("search_cluster_ids_new");
    expect(title).toContain("sirala=yeni");
    expect(title).toContain("APPLY 215 FIRST, THEN DEPLOY");
  });

  it("the section says what the reverse order does (fallback to the ranked order), carries the fingerprints and the rollback", () => {
    const section = sectionOf(guide, "215");
    expect(section).toContain("PGRST202");
    expect(section).toContain("ranked order");
    expect(section).toContain(LIVE_MD5);
    expect(section).toContain(String(LIVE_LENGTH));
    expect(section).toContain("**Rollback:**");
    expect(section).toContain("drop function public.search_cluster_ids_new(text[], text, integer, integer);");
    const body = body215();
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });

  it("the section sits after 212 and the guide keeps its numbering order", () => {
    expect(guide.indexOf("\n## 215 ")).toBeGreaterThan(guide.indexOf("\n## 212 "));
  });
});

describe("215 dry-run and live manifest", () => {
  const dry = existsSync(DRYRUN_215) ? readFileSync(DRYRUN_215, "utf8") : "";

  it("builds 215's database with its own dry-run script: one run entry, that script as the only setup file", () => {
    const lines = readFileSync(MANIFEST, "utf8")
      .split("\n")
      .filter((l) => l.startsWith("run | 215-search-cluster-ids-new.test.ts"));
    expect(lines).toEqual(["run | 215-search-cluster-ids-new.test.ts | tests/migrations/sql/215-search-cluster-ids-new-dryrun.sql | - | 0"]);
  });

  it("the dry-run builds production's state (the 129 setup, 166, 172, 185, 186, 194, 196, 198, 204 and 211, gated on their md5), applies 215 twice and ends with its OK line", () => {
    expect(existsSync(DRYRUN_215)).toBe(true);
    const ir = dry
      .split("\n")
      .filter((l) => l.startsWith("\\ir "))
      .map((l) => l.slice(4).trim());
    expect(ir).toEqual([
      "166-search-overstem-guard-setup.sql",
      "../../../supabase/migrations/166_search_overstem_guard.sql",
      "../../../supabase/migrations/172_search_exempt_word_tier.sql",
      "../../../supabase/migrations/185_search_sibling_variants.sql",
      "../../../supabase/migrations/186_search_stem_fold_arm.sql",
      "../../../supabase/migrations/194_search_rank_display_title.sql",
      "../../../supabase/migrations/196_search_ascii_inflection_roots.sql",
      "../../../supabase/migrations/198_search_ascii_root_deny_collisions.sql",
      "../../../supabase/migrations/204_search_single_letter_compounds.sql",
      "../../../supabase/migrations/211_search_cluster_ids_v2_offset.sql",
      "../../../supabase/migrations/215_search_cluster_ids_new.sql",
      "../../../supabase/migrations/215_search_cluster_ids_new.sql",
    ]);
    for (const word of [LIVE_MD5, String(LIVE_LENGTH), V2_MD5, String(V2_LENGTH), md5(body215()), String([...body215()].length)]) expect(dry, word).toContain(word);
    expect(dry.trimEnd().endsWith("\\echo DRYRUN 215 OK")).toBe(true);
    expect(dry).toContain("-f tests/migrations/sql/stub.sql");
    expect(dry).toContain("D=$(mktemp -d)");
    expect(dry).toContain("-- or: bash tests/migrations/sql/run-live.sh");
  });

  it("the dry-run checks the contract: date order, the summary-only row left out, the 150 bound, the clamps, the guard, an alias query, the grants and the two untouched functions", () => {
    for (const w of [
      "newest first",
      "summary-only",
      "150",
      "offset 72",
      "p_limit",
      "burdur",
      "akp or ak parti",
      "has_function_privilege",
      "insufficient_privilege",
      "search_cluster_ids_v2",
      "rollback;",
    ]) {
      expect(dry, w).toContain(w);
    }
  });
});

// ---------------------------------------------------------------------------
// Live block (opt-in). TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE point at a THROWAWAY database that the dry-run
// script left behind with 129, 166, 172, 185, 186, 194, 196, 198, 204, 211 and 215 applied (tests/migrations/sql/live-manifest.txt).
// Every scenario runs inside begin ... rollback: it seeds clusters, calls the installed search_cluster_ids_new the way the app does
// (typed variants, folded text, p_limit 24, p_offset (page - 1) * 24) and checks:
//   (1) the newest literal-title matches come first, newest first, and a NEWER summary-only match is left out;
//   (2) a neutral title is the display title, an archived cluster and a one-article cluster are never listed;
//   (3) the first 24 ids equal an independently computed newest 24 (order by updated_at desc, id over the same predicate), and pages are
//       consecutive and disjoint (offsets 0, 24, 48, 72 of 103 literal matches);
//   (4) the limit clamps 1..24 (null reads 24), the offset clamps 0..72 (null reads 0);
//   (5) the newest-150 bound: 150 newer summary-only rows hide every literal row, 149 leave exactly the newest one;
//   (6) a query with no literal tier (an alias `or`, a negated phrase) lists its newest rows instead of none;
//   (7) the 166 guard is kept (burdur lists no Bursa row).
// ---------------------------------------------------------------------------

const seedId = (n: number): string => `00000000-0000-4000-8000-${String(215000 + n).padStart(12, "0")}`;
const lit = (s: string | null): string => (s === null ? "null" : `'${s.replaceAll("'", "''")}'`);
const arr = (variants: string[]): string => `array[${variants.map(lit).join(", ")}]::text[]`;

describe.runIf(Boolean(process.env.TAYF_PSQL))("215 search_cluster_ids_new against a live Postgres (129, 166, 172, 185, 186, 194, 196, 198, 204, 211 and 215 applied)", () => {
  assertLiveReady("215", {
    ledger: ["129", "166", "172", "185", "186", "194", "196", "198", "204", "211", "215"],
    relations: ["public.clusters_search_tsv_live_idx", "public.clusters_search_fold_live_idx", "public.clusters_search_stemfold_live_idx"],
    functions: [
      "public.search_cluster_ids(text[],text,integer)",
      "public.search_cluster_ids_v2(text[],text,integer,integer)",
      "public.search_cluster_ids_new(text[],text,integer,integer)",
      "public.tayf_search_fold(text)",
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

  /** One call of the function, the way the app makes it; the output line is `<tag>|<id>,<id>,...`. */
  const call = (tag: string, variants: string[], folded: string, limit: string, offset: string): string =>
    `select ${lit(tag)} || '|' || coalesce((select string_agg(t.id::text, ',' order by t.n) ` +
    `from public.search_cluster_ids_new(${arr(variants)}, ${lit(folded)}, ${limit}, ${offset}) with ordinality as t(id, n)), '');`;

  const ids = (out: Map<string, string[]>, tag: string): string[] => {
    const v = out.get(tag);
    expect(v, `no result for ${tag}`).toBeDefined();
    return v as string[];
  };
  const parse = (text: string): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const bar = line.indexOf("|");
      const tag = line.slice(0, bar);
      const rest = line.slice(bar + 1);
      m.set(tag, rest === "" ? [] : rest.split(","));
    }
    return m;
  };

  // --- the deprem scenario -------------------------------------------------------------------------
  // 100 literal rows 'Deprem haberi N' (N hours old, corroboration 2 + N % 5 so the RANKED order is not the date order), two literal rows with
  // the very same updated_at (the id decides), one literal NEUTRAL title (30 minutes old), five NEWER summary-only rows (10 to 50 minutes
  // old: the word is only in the summary), an archived literal row and a one-article literal row (newest of all).
  const LITERAL = 100;
  const NEUTRAL = seedId(300);
  const TIE_A = seedId(310);
  const TIE_B = seedId(311);
  const SUMMARY_ONLY = [1, 2, 3, 4, 5].map((n) => seedId(200 + n));
  const ARCHIVED = seedId(301);
  const SINGLE = seedId(302);
  const literalId = (n: number): string => seedId(n);

  /** The expected order of the literal matches: updated_at desc, then id. Ages in minutes. */
  const expectedOrder = (): string[] => {
    const rows: Array<{ id: string; age: number }> = [{ id: NEUTRAL, age: 30 }];
    for (let n = 1; n <= LITERAL; n++) rows.push({ id: literalId(n), age: n * 60 });
    rows.push({ id: TIE_A, age: 50 * 60 + 30 }, { id: TIE_B, age: 50 * 60 + 30 });
    return rows.sort((a, b) => a.age - b.age || (a.id < b.id ? -1 : 1)).map((r) => r.id);
  };

  const depremScript = [
    "begin;",
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((215000 + n)::text, 12, '0'))::uuid, 'Deprem haberi ' || n, null, 'Ayrıntılar sürüyor.', 2 + (n % 5), false, now() - make_interval(hours => n)
  from generate_series(1, ${LITERAL}) n;`,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (${lit(NEUTRAL)}, 'Bölgede sarsıntı', 'Deprem bölgesinde çalışmalar sürüyor', 'Ekipler sahada.', 3, false, now() - interval '30 minutes'),
  (${lit(TIE_A)}, 'Deprem tie A', null, 'Aynı saniye.', 2, false, now() - interval '50 hours 30 minutes'),
  (${lit(TIE_B)}, 'Deprem tie B', null, 'Aynı saniye.', 2, false, now() - interval '50 hours 30 minutes'),
  (${lit(ARCHIVED)}, 'Deprem arşiv haberi', null, 'Arşivde.', 3, true, now() - interval '5 minutes'),
  (${lit(SINGLE)}, 'Deprem tek kaynaklı haber', null, 'Tek kaynak.', 1, false, now() - interval '4 minutes');`,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((215200 + n)::text, 12, '0'))::uuid, 'Borsa güne yükselişle başladı ' || n, null, 'Analistler deprem bölgesine yatırımı konuştu.', 9, false, now() - make_interval(mins => n * 10)
  from generate_series(1, 5) n;`,
    "analyze public.clusters;",
    call("p1", ["deprem"], "deprem", "24", "0"),
    call("p2", ["deprem"], "deprem", "24", "24"),
    call("p3", ["deprem"], "deprem", "24", "48"),
    call("p4", ["deprem"], "deprem", "24", "72"),
    call("off1000", ["deprem"], "deprem", "24", "1000"),
    call("offneg", ["deprem"], "deprem", "24", "-5"),
    call("offnull", ["deprem"], "deprem", "24", "null"),
    call("lim50", ["deprem"], "deprem", "50", "0"),
    call("lim0", ["deprem"], "deprem", "0", "0"),
    call("limneg", ["deprem"], "deprem", "-3", "0"),
    call("limnull", ["deprem"], "deprem", "null", "0"),
    call("lim5", ["deprem"], "deprem", "5", "0"),
    call("lim5off3", ["deprem"], "deprem", "5", "3"),
    // a second typed spelling, as the app sends for a Turkish word
    call("tr", ["deprem", "depreM"], "deprem", "24", "0"),
    // the independent computation: the same predicate, no function, newest first
    `select 'indep|' || string_agg(x.id::text, ',' order by x.updated_at desc, x.id) from (
       select c.id, c.updated_at from public.clusters c
        where not c.is_archived and c.article_count >= 2
          and ' ' || regexp_replace(public.tayf_search_fold(coalesce(nullif(btrim(c.title_tr_neutral), ''), c.title_tr)), '[^a-z0-9]+', ' ', 'g') like '% depr%'
        order by c.updated_at desc, c.id limit 24) x;`,
    // the ranked function on the same call, to show the date order is not the ranked one on this fixture
    `select 'ranked|' || coalesce((select string_agg(t.id::text, ',' order by t.n) from public.search_cluster_ids_v2(${arr(["deprem"])}, 'deprem', 24, 0) with ordinality as t(id, n)), '');`,
    "rollback;",
  ].join("\n");

  let deprem: Map<string, string[]> | null = null;
  const depremOut = (): Map<string, string[]> => (deprem ??= parse(runPsql(depremScript)));

  it("lists the newest literal-title rows first, in updated_at desc, id order: the neutral title (30 minutes), then 1 hour, 2 hours ...", () => {
    const want = expectedOrder();
    expect(ids(depremOut(), "p1")).toEqual(want.slice(0, 24));
    expect(ids(depremOut(), "p1")[0]).toBe(NEUTRAL);
    expect(ids(depremOut(), "p1")).toHaveLength(24);
  });

  it("a NEWER summary-only match (the word is only in the summary) is left out, on every page", () => {
    const all = [...ids(depremOut(), "p1"), ...ids(depremOut(), "p2"), ...ids(depremOut(), "p3"), ...ids(depremOut(), "p4")];
    for (const id of SUMMARY_ONLY) expect(all).not.toContain(id);
    expect(all.length).toBe(96);
  });

  it("an archived cluster and a one-article cluster are never listed, though they are the newest literal rows", () => {
    const all = [...ids(depremOut(), "p1"), ...ids(depremOut(), "p2")];
    expect(all).not.toContain(ARCHIVED);
    expect(all).not.toContain(SINGLE);
  });

  it("the first 24 ids equal the independently computed newest 24 literal matches (same predicate, order by updated_at desc, id)", () => {
    expect(ids(depremOut(), "p1")).toEqual(ids(depremOut(), "indep"));
  });

  it("two rows with the same updated_at are listed in id order", () => {
    const all = [...ids(depremOut(), "p1"), ...ids(depremOut(), "p2"), ...ids(depremOut(), "p3")];
    expect(all.indexOf(TIE_A)).toBeGreaterThanOrEqual(0);
    expect(all.indexOf(TIE_A) + 1).toBe(all.indexOf(TIE_B));
  });

  it("pages 1..4 (offsets 0, 24, 48, 72) are consecutive slices of the same order, disjoint, 24 rows each", () => {
    const want = expectedOrder();
    expect(ids(depremOut(), "p2")).toEqual(want.slice(24, 48));
    expect(ids(depremOut(), "p3")).toEqual(want.slice(48, 72));
    expect(ids(depremOut(), "p4")).toEqual(want.slice(72, 96));
    const all = ["p1", "p2", "p3", "p4"].flatMap((t) => ids(depremOut(), t));
    expect(new Set(all).size).toBe(96);
  });

  it("the offset is clamped to 0..72: 1000 reads 72, a negative offset and null read 0", () => {
    expect(ids(depremOut(), "off1000")).toEqual(ids(depremOut(), "p4"));
    expect(ids(depremOut(), "offneg")).toEqual(ids(depremOut(), "p1"));
    expect(ids(depremOut(), "offnull")).toEqual(ids(depremOut(), "p1"));
  });

  it("the limit is clamped to 1..24: 50 reads 24, 0 and a negative limit read 1, null reads 24, 5 gives 5, and the offset applies to the clamped page", () => {
    expect(ids(depremOut(), "lim50")).toEqual(ids(depremOut(), "p1"));
    expect(ids(depremOut(), "lim0")).toEqual(ids(depremOut(), "p1").slice(0, 1));
    expect(ids(depremOut(), "limneg")).toEqual(ids(depremOut(), "p1").slice(0, 1));
    expect(ids(depremOut(), "limnull")).toEqual(ids(depremOut(), "p1"));
    expect(ids(depremOut(), "lim5")).toEqual(ids(depremOut(), "p1").slice(0, 5));
    expect(ids(depremOut(), "lim5off3")).toEqual(ids(depremOut(), "p1").slice(3, 8));
  });

  it("an extra typed spelling finds the same rows in the same order (the arms are 204's)", () => {
    expect(ids(depremOut(), "tr")).toEqual(ids(depremOut(), "p1"));
  });

  it("the fixture is not vacuous: the RANKED function lists the older, better corroborated rows first, so its order is not this one", () => {
    expect(ids(depremOut(), "ranked")).not.toEqual(ids(depremOut(), "p1"));
  });

  // --- the newest-150 bound ----------------------------------------------------------------------
  // 'tsunami': 150 newer summary-only rows (1 to 150 minutes old) and 5 literal rows (1 to 5 days old). The newest 150 candidates are the
  // 150 summary-only rows, so no literal row is listed (a very sparse query lists fewer rows by design). 'heyelan': 149 summary-only rows
  // and the same 5 literal rows: the newest 150 are the 149 plus the newest literal row, which is listed, alone.
  const boundScript = [
    "begin;",
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((216000 + n)::text, 12, '0'))::uuid, 'Piyasa raporu ' || n, null, 'Analistler tsunami riskini değerlendirdi.', 2, false, now() - make_interval(mins => n)
  from generate_series(1, 150) n;`,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((216200 + n)::text, 12, '0'))::uuid, 'Tsunami uyarısı ' || n, null, 'Kıyılar boşaltıldı.', 2, false, now() - make_interval(days => n)
  from generate_series(1, 5) n;`,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((216400 + n)::text, 12, '0'))::uuid, 'Hisse raporu ' || n, null, 'Analistler heyelan riskini değerlendirdi.', 2, false, now() - make_interval(mins => n)
  from generate_series(1, 149) n;`,
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at)
select ('00000000-0000-4000-8000-' || lpad((216600 + n)::text, 12, '0'))::uuid, 'Heyelan uyarısı ' || n, null, 'Yol kapandı.', 2, false, now() - make_interval(days => n)
  from generate_series(1, 5) n;`,
    "analyze public.clusters;",
    call("tsunami", ["tsunami"], "tsunami", "24", "0"),
    call("heyelan", ["heyelan"], "heyelan", "24", "0"),
    "rollback;",
  ].join("\n");

  it("keeps only the newest 150 candidates: 150 newer summary-only rows hide every literal row, 149 leave exactly the newest literal row", () => {
    const out = parse(runPsql(boundScript));
    expect(ids(out, "tsunami")).toEqual([]);
    expect(ids(out, "heyelan")).toEqual([`00000000-0000-4000-8000-${String(216601).padStart(12, "0")}`]);
  });

  // --- queries with no literal tier, and the guard ------------------------------------------------
  const tierScript = [
    "begin;",
    `insert into public.clusters (id, title_tr, title_tr_neutral, summary_tr, article_count, is_archived, updated_at) values
  (${lit(seedId(401))}, 'AK Parti kongresi toplandı', null, 'Delegeler oy kullandı.', 4, false, now() - interval '2 hours'),
  (${lit(seedId(402))}, 'Gündem yoğun', null, 'AKP milletvekilleri toplandı.', 3, false, now() - interval '1 hour'),
  (${lit(seedId(403))}, 'Hava durumu açıklandı', null, 'Yağış bekleniyor.', 5, false, now() - interval '30 minutes'),
  (${lit(seedId(411))}, 'İran açıklama yaptı', null, 'Bakanlık duyurdu.', 2, false, now() - interval '3 hours'),
  (${lit(seedId(412))}, 'İran İsrail saldırısı sürüyor', null, 'Saldırı devam ediyor.', 5, false, now() - interval '1 hour'),
  (${lit(seedId(413))}, 'Gündem özeti', null, 'İran gelişmeleri konuşuldu.', 2, false, now() - interval '2 hours'),
  (${lit(seedId(500))}, 'Orman yangınları sürüyor', null, 'Ekipler müdahale etti.', 3, false, now() - interval '2 hours'),
  (${lit(seedId(501))}, 'Yangın söndürüldü', null, 'Ekipler müdahale etti.', 3, false, now() - interval '1 hour'),
  (${lit(seedId(421))}, 'Burdur''da yurt zehirlenmesi', null, 'Öğrenciler hastaneye kaldırıldı.', 2, false, now() - interval '1 hour'),
  (${lit(seedId(422))}, 'Bursa''da sel uyarısı', null, 'Uzmanlar uyardı.', 2, false, now() - interval '30 minutes');`,
    "analyze public.clusters;",
    call("akp", ['akp or "ak parti"'], "akp or ak parti", "24", "0"),
    call("neg", ['iran -"israil saldırısı"', 'iran -"israil saldirisi"'], 'iran -"israil saldirisi"', "24", "0"),
    // the ranked function's candidates for the same two calls (limit 50 holds every row of the fixture), newest first
    `select 'negranked|' || coalesce((select string_agg(c.id::text, ',' order by c.updated_at desc, c.id)
       from public.search_cluster_ids_v2(${arr(['iran -"israil saldırısı"', 'iran -"israil saldirisi"'])}, 'iran -"israil saldirisi"', 50, 0) t join public.clusters c on c.id = t.id), '');`,
    `select 'akpranked|' || coalesce((select string_agg(c.id::text, ',' order by c.updated_at desc, c.id)
       from public.search_cluster_ids_v2(${arr(['akp or "ak parti"'])}, 'akp or ak parti', 50, 0) t join public.clusters c on c.id = t.id), '');`,
    call("burdur", ["burdur"], "burdur", "24", "0"),
    call("yanginlar", ["yangınlar"], "yanginlar", "24", "0"),
    call("yangin", ["yangın"], "yangin", "24", "0"),
    call("empty", [""], "", "24", "0"),
    call("nullfold", ["okul"], "null", "24", "0"),
    call("hostile", ["'; drop table public.clusters; --"], "'; drop table public.clusters; --", "24", "0"),
    "rollback;",
  ].join("\n");

  it("a query with no literal tier (an alias `or`, a negated phrase) lists its newest rows, newest first, instead of none", () => {
    const out = parse(runPsql(tierScript));
    expect(ids(out, "akp")).toEqual([seedId(402), seedId(401)]);
    expect(ids(out, "akp")).toEqual(ids(out, "akpranked"));
    // a negated phrase: exactly the ranked function's candidates, newest first (204's arms; the folded arm reads the quote as a space, a pre-existing
    // property 215 does not change). The rows that hold the word iran in the title and in the summary are among them.
    expect(ids(out, "neg")).toEqual(ids(out, "negranked"));
    expect(ids(out, "neg")).toEqual(expect.arrayContaining([seedId(413), seedId(411)]));
    expect(ids(out, "neg").length).toBeGreaterThanOrEqual(2);
  });

  it("a typed inflected word is a literal match on its own form only (194's lit_d): 'yangınlar' lists Orman yangınları, not Yangın söndürüldü, and the root lists the singular title (the stemmer's candidates, as v2's)", () => {
    const out = parse(runPsql(tierScript));
    expect(ids(out, "yanginlar")).toEqual([seedId(500)]);
    expect(ids(out, "yangin")).toEqual([seedId(501)]);
  });

  it("keeps the 166 guard: 'burdur' lists the Burdur row and not the newer Bursa row", () => {
    const out = parse(runPsql(tierScript));
    expect(ids(out, "burdur")).toEqual([seedId(421)]);
  });

  it("an empty query, a null folded text and a hostile string answer without raising and list nothing", () => {
    const out = parse(runPsql(tierScript));
    expect(ids(out, "empty")).toEqual([]);
    expect(ids(out, "hostile")).toEqual([]);
    expect(out.has("nullfold")).toBe(true);
  });

  // --- applied once, shape, access, the other functions ------------------------------------------
  it("is applied once: one ledger row, one overload, the body of the file, v2's attributes, service_role only, the two search functions untouched", () => {
    const out = runPsql(`
select (select count(*) from supabase_migrations.schema_migrations where version = '215'),
       (select count(*) from pg_catalog.pg_proc where proname = 'search_cluster_ids_new' and pronamespace = 'public'::regnamespace),
       p.prosecdef, p.provolatile, (p.proconfig = array['search_path=""']), p.proacl::text, md5(p.prosrc), length(p.prosrc),
       has_function_privilege('anon', p.oid, 'execute'), has_function_privilege('authenticated', p.oid, 'execute'),
       has_function_privilege('service_role', p.oid, 'execute'),
       obj_description(p.oid, 'pg_proc') like '%215%', pg_get_function_arguments(p.oid)
  from pg_catalog.pg_proc p
 where p.oid = 'public.search_cluster_ids_new(text[], text, integer, integer)'::regprocedure;
select md5(p.prosrc), length(p.prosrc), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids(text[], text, integer)'::regprocedure;
select md5(p.prosrc), length(p.prosrc), p.proacl::text from pg_catalog.pg_proc p where p.oid = 'public.search_cluster_ids_v2(text[], text, integer, integer)'::regprocedure;
`).trim();
    const [fnLine, v1Line, v2Line] = out.split("\n") as [string, string, string];
    const f = fnLine.split("|");
    const body = body215();
    expect(f[0]).toBe("1");
    expect(f[1]).toBe("1");
    expect(f[2]).toBe("t");
    expect(f[3]).toBe("s");
    expect(f[4]).toBe("t");
    expect(f[5]).toBe("{postgres=X/postgres,service_role=X/postgres}");
    expect(f[6]).toBe(md5(body));
    expect(f[7]).toBe(String([...body].length));
    expect(f.slice(8, 11)).toEqual(["f", "f", "t"]);
    expect(f[11]).toBe("t");
    expect(f[12]).toBe("p_variants text[], p_folded text, p_limit integer DEFAULT 24, p_offset integer DEFAULT 0");
    expect(v1Line.split("|").slice(0, 2)).toEqual([LIVE_MD5, String(LIVE_LENGTH)]);
    expect(v2Line.split("|").slice(0, 2)).toEqual([V2_MD5, String(V2_LENGTH)]);
  });
});
