import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { ARCHIVE_MAX_PAGE } from "../../src/lib/seo/home-canonical";

// ---------------------------------------------------------------------------
// Contract test for migration 211 ("search_cluster_ids_v2_offset"), h170-roadmap-1.
//
// GET /?q=enflasyon lists the 24 best archive matches and stops: search_cluster_ids (migration 204 is its live body) ends in
// `limit greatest(1, least(coalesce(p_limit, 12), 50))` and takes no offset, so most matches of a common query are unreachable.
// 211 CREATES search_cluster_ids_v2(p_variants, p_folded, p_limit default 12, p_offset integer default 0). Its body is 204's body (the
// live one, md5 pinned below) with ONE changed line: the final clause gains `offset greatest(0, least(coalesce(p_offset, 0), 72))`.
// search_cluster_ids is not touched, dropped or replaced: it is the read of page 1 of every search and the PGRST202 fallback chain.
//
// This file pins, without a database: the file, ledger and transaction, additive-only SQL (nothing redefines search_cluster_ids),
// 204's body is production's (md5 and length pinned, recomputed from the file), 211's body is 204's with that single line changed
// (page 1 of v2 is therefore the live function's by construction), the clamp equals the app's page constants (4 pages of 24, so the
// last offset is 72), the attributes and grants, the comment, the docs section and a JS twin of the paging contract.
//
// SQL is scanned with indexOf and character loops, never with a nested-quantifier regular expression (CodeQL).
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(ROOT, "supabase", "migrations");
const FILE_204 = "204_search_single_letter_compounds.sql";
const FILE_210 = "210_legal_notice_description.sql";
const FILE_211 = "211_search_cluster_ids_v2_offset.sql";
const MIGRATION_204 = resolve(MIGRATIONS_DIR, FILE_204);
const MIGRATION_211 = resolve(MIGRATIONS_DIR, FILE_211);
const DOC_MIGRATION_GUIDE = resolve(ROOT, "docs", "migration-guide.md");
const SEARCH_QUERY_SOURCE = resolve(ROOT, "src", "lib", "clusters", "search-query.ts");

/** Production, read-only, 2026-11-13: md5(prosrc) and length(prosrc) of the live search_cluster_ids(text[], text, integer). */
const LIVE_MD5 = "32b42ca06d6b0c2a3ba8bf1264d353f7";
const LIVE_LENGTH = 22892;
const PROD_PROACL = "{postgres=X/postgres,service_role=X/postgres}";

const FN = "public.search_cluster_ids_v2";
const FN_SIG = `${FN}(text[], text, integer, integer)`;
const V1_SIG = "public.search_cluster_ids(text[], text, integer)";

const LEDGER_STMT =
  "insert into supabase_migrations.schema_migrations (version, name) values ('211', '211_search_cluster_ids_v2_offset') on conflict do nothing;";
const REVOKE_STMT = `revoke all on function ${FN_SIG} from public, anon, authenticated;`;
const GRANT_STMT = `grant execute on function ${FN_SIG} to service_role;`;

/** 204's last line, and the one line v2 ends with instead. */
const V1_TAIL = "  limit greatest(1, least(coalesce(p_limit, 12), 50));\n";
const OFFSET_CLAUSE = "offset greatest(0, least(coalesce(p_offset, 0), 72))";
const V2_TAIL = `  limit greatest(1, least(coalesce(p_limit, 12), 50)) ${OFFSET_CLAUSE};\n`;

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

const sql204 = readFileSync(MIGRATION_204, "utf8");
const body204 = functionBody(sql204);
const sql211 = existsSync(MIGRATION_211) ? readFileSync(MIGRATION_211, "utf8") : "";
const header211 = (): string => {
  expect(existsSync(MIGRATION_211), `${FILE_211} must exist`).toBe(true);
  return sql211.split("\nbegin;")[0] as string;
};
const body211 = (): string => {
  expect(existsSync(MIGRATION_211), `${FILE_211} must exist`).toBe(true);
  return functionBody(sql211);
};

describe("211 search_cluster_ids_v2_offset: the file, ledger and transaction", () => {
  it("exists, with the exact name, and no other file claims the number 211 (197 and 202 are held on other branches and are not used)", () => {
    expect(existsSync(MIGRATION_211)).toBe(true);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("211_"))).toEqual([FILE_211]);
    expect(FILE_211 > FILE_210).toBe(true);
    // 197 and 202 are held on hunt-129-db197 and hunt-141-db202: this file must not take either number
    expect(FILE_211.startsWith("197_") || FILE_211.startsWith("202_")).toBe(false);
    expect(readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("197_") || f.startsWith("202_"))).toEqual([]);
  });

  it("no other migration defines search_cluster_ids_v2", () => {
    const definers = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .filter((f) => collapse(stripComments(readFileSync(resolve(MIGRATIONS_DIR, f), "utf8"))).includes("function public.search_cluster_ids_v2("));
    expect(definers).toEqual([FILE_211]);
  });

  it("runs in one transaction with a bounded lock wait", () => {
    const stmts = statements(sql211);
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(countOf(sql211, "\nbegin;")).toBe(1);
    expect(countOf(sql211, "\ncommit;")).toBe(1);
  });

  it("records version 211 in the schema_migrations ledger, idempotently, as the last statement before commit", () => {
    const code = collapse(stripComments(sql211));
    expect(code).toContain(LEDGER_STMT);
    expect(countOf(code, "schema_migrations")).toBe(1);
    expect(code.slice(code.indexOf("begin;")).endsWith(`${LEDGER_STMT} commit;`)).toBe(true);
  });

  it("notifies pgrst to reload its schema cache, like 204 (the app reads PGRST202 until it has)", () => {
    expect(statements(sql211)).toContain("notify pgrst, 'reload schema'");
  });
});

describe("211 search_cluster_ids_v2_offset: the production fingerprint it was built from", () => {
  it("204's function body is production's live body: its md5 and length are the recorded prosrc (STEP 0, read-only)", () => {
    expect(md5(body204)).toBe(LIVE_MD5);
    expect([...body204].length).toBe(LIVE_LENGTH);
  });

  it("the header records the fingerprint, the attributes and that it equals 204's body", () => {
    const header = header211();
    expect(header).toContain("STEP 0");
    expect(header).toContain(LIVE_MD5);
    expect(header).toContain(String(LIVE_LENGTH));
    expect(header).toContain(`proacl ${PROD_PROACL}`);
    expect(flat(header)).toContain("There is no search_cluster_ids_v2");
    expect(flat(header)).toContain("204_search_single_letter_compounds.sql");
  });

  it("the header names the evidence, the replay, the deploy order and the rollback", () => {
    const header = flat(header211());
    for (const word of [
      "h170-roadmap-1",
      "p_offset",
      "enflasyon",
      "REPLAY",
      "pages disjoint",
      "PGRST202",
      "ROLLBACK",
      "NUMBER",
      "197",
      "202",
      "APPLY 211 FIRST, THEN DEPLOY",
    ]) {
      expect(header, word).toContain(word);
    }
    expect(header).toContain("drop function public.search_cluster_ids_v2(text[], text, integer, integer)");
    expect(header).toContain("version = '211'");
    expect(header.startsWith("211_search_cluster_ids_v2_offset.sql")).toBe(true);
  });

  it("VERIFY carries the md5 and the length of THIS file's function body", () => {
    const body = body211();
    expect(header211()).toContain(`${md5(body)}, ${[...body].length}`);
    expect(md5(body)).not.toBe(LIVE_MD5);
    expect([...body].length).toBe(LIVE_LENGTH + OFFSET_CLAUSE.length + 1);
  });

  it("VERIFY compares v2 at offsets 0 and 24 with rows 1-24 and 25-48 of the live function in one statement, and checks the grants", () => {
    const header = header211();
    const at = header.indexOf("-- VERIFY");
    const end = header.indexOf("-- ROLLBACK", at);
    expect(at, "the VERIFY block").toBeGreaterThanOrEqual(0);
    expect(end, "the ROLLBACK block after it").toBeGreaterThan(at);
    const verify = flat(header.slice(at, end));
    expect(verify).toContain("public.search_cluster_ids_v2(array['enflasyon'], 'enflasyon', 24, 0)");
    expect(verify).toContain("public.search_cluster_ids_v2(array['enflasyon'], 'enflasyon', 24, 24)");
    expect(verify).toContain("public.search_cluster_ids(array['enflasyon'], 'enflasyon', 50)");
    expect(verify).toContain("same ids, same order");
    expect(verify).toContain("has_function_privilege('anon'");
    expect(verify).toContain("has_function_privilege('service_role'");
    expect(verify).toContain("false, false, true");
  });
});

describe("211 search_cluster_ids_v2_offset: the function", () => {
  it("creates search_cluster_ids_v2 with create or replace, 204's arguments plus p_offset integer default 0", () => {
    const header = collapse(functionHeader(stripComments(sql211))).toLowerCase();
    expect(
      header.startsWith(
        "create or replace function public.search_cluster_ids_v2(p_variants text[], p_folded text, p_limit integer default 12, p_offset integer default 0)",
      ),
    ).toBe(true);
    expect(header).toContain("returns table (id uuid)");
  });

  it("is language sql, stable, security definer with an empty search_path (the attributes of the live function)", () => {
    const h = collapse(functionHeader(stripComments(sql211))).toLowerCase();
    expect(h).toContain("language sql stable security definer set search_path = ''");
    expect(h).not.toContain("volatile");
    expect(h).not.toContain("security invoker");
    // 204's header, with the new argument cut out, is the same header
    const v1Header = collapse(functionHeader(stripComments(sql204))).toLowerCase();
    expect(h.replaceAll(", p_offset integer default 0", "").replaceAll("search_cluster_ids_v2", "search_cluster_ids")).toBe(v1Header);
  });

  it("the body is 204's body with its last line changed and nothing else: page 1 of v2 is the live function's by construction", () => {
    const v1 = body204;
    const v2 = body211();
    expect(v1.endsWith(V1_TAIL)).toBe(true);
    // character for character: v2 is v1 with its last line extended by the offset clause
    expect(v2).toBe(v1.slice(0, -V1_TAIL.length) + V2_TAIL);
    // line by line: every line but the last is equal, and the line count is the same
    const a = v1.split("\n");
    const b = v2.split("\n");
    expect(b.length).toBe(a.length);
    const differing = a.map((line, i) => (line === b[i] ? -1 : i)).filter((i) => i >= 0);
    expect(differing).toEqual([a.length - 2]);
    expect(countOf(v2, OFFSET_CLAUSE)).toBe(1);
    expect(v2.endsWith(`${OFFSET_CLAUSE};\n`)).toBe(true);
    // removing the clause gives 204's body, md5 and all
    expect(md5(v2.replaceAll(` ${OFFSET_CLAUSE};\n`, ";\n"))).toBe(LIVE_MD5);
    expect(v2).not.toBe(v1);
  });

  it("the offset clause is the last clause, after the limit, and p_offset is read nowhere else", () => {
    const body = collapse(body211());
    expect(countOf(body, "p_offset")).toBe(1);
    expect(body.indexOf("limit greatest(")).toBeLessThan(body.indexOf(OFFSET_CLAUSE));
    expect(body.endsWith(`${OFFSET_CLAUSE};`)).toBe(true);
    // 194's order, ending in a total order (the id), so two pages never share a row
    expect(body).toContain("h.article_count desc, h.updated_at desc, h.id limit greatest(1, least(coalesce(p_limit, 12), 50))");
  });

  it("the offset clamp is the app's: 0..72, and 72 is the start of the last of ARCHIVE_MAX_PAGE pages of 24", () => {
    const source = readFileSync(SEARCH_QUERY_SOURCE, "utf8");
    expect(source).toContain("export const SEARCH_LIMIT = 24;");
    expect(ARCHIVE_MAX_PAGE).toBe(4);
    expect(OFFSET_CLAUSE).toBe(`offset greatest(0, least(coalesce(p_offset, 0), ${(ARCHIVE_MAX_PAGE - 1) * 24}))`);
    expect(flat(header211())).toContain("4 pages of 24");
    expect(flat(header211())).toContain("96");
  });

  it("keeps every clause of the live function: the three arms, the 166 guard, 172's tier, the 1000-row cap, 194's order", () => {
    const body = collapse(body211());
    expect(body).toContain("where c.search_tsv @@ (select qv from q)");
    expect(body).toContain("public.tayf_search_stem_fold(c.search_tsv) @@ (select qs from qs)");
    expect(body).toContain("select k.id from kept k order by k.updated_at desc, k.id limit 1000");
    expect(body).toContain("(case when h.lit_ok then 0 else 1 end)");
    expect(body).toContain("limit greatest(1, least(coalesce(p_limit, 12), 50))");
    expect(countOf(body, "p_variants")).toBe(countOf(collapse(body204), "p_variants"));
    expect(countOf(body, "p_folded")).toBe(countOf(collapse(body204), "p_folded"));
  });

  it("the function comment names 211, h170-roadmap-1, p_offset, search_cluster_ids and the 0..72 clamp, and ends 'service_role only.'", () => {
    const comment = statementStartingWith(sql211, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment.endsWith("service_role only.'")).toBe(true);
    for (const word of ["211", "h170-roadmap-1", "p_offset", "search_cluster_ids", "0..72", "PGRST202"]) {
      expect(comment, word).toContain(word);
    }
  });
});

describe("211 search_cluster_ids_v2_offset: search_cluster_ids stays as it is", () => {
  it("does not create, replace, drop, alter, comment on, revoke or grant search_cluster_ids (no statement names it, outside comments and the v2 name)", () => {
    const stmts = statements(sql211).map((s) => s.toLowerCase());
    for (const stmt of stmts) {
      expect(stmt.includes("function public.search_cluster_ids("), stmt.slice(0, 80)).toBe(false);
      expect(stmt.includes("function public.search_cluster_ids ("), stmt.slice(0, 80)).toBe(false);
    }
    const code = collapse(stripComments(sql211));
    expect(code.includes(V1_SIG)).toBe(false);
    expect(code.includes("drop function")).toBe(false);
    expect(code.includes("alter function")).toBe(false);
  });

  it("204 still defines search_cluster_ids (page 1's function), with the limit and no offset", () => {
    const code = collapse(stripComments(sql204));
    expect(code).toContain("create or replace function public.search_cluster_ids(p_variants text[], p_folded text, p_limit integer default 12)");
    expect(code.includes("p_offset")).toBe(false);
  });

  it("is additive: no table, column, index, trigger, cron job or data change", () => {
    const stmts = statements(sql211).map((s) => s.toLowerCase());
    const allowed = ["begin", "set local lock_timeout", "create or replace function", "comment on function", "revoke all on function", "grant execute on function", "notify pgrst", "insert into supabase_migrations.schema_migrations", "commit"];
    for (const stmt of stmts) {
      expect(
        allowed.some((a) => stmt.startsWith(a)),
        stmt.slice(0, 80),
      ).toBe(true);
    }
    expect(stmts.filter((s) => s.startsWith("create or replace function"))).toHaveLength(1);
  });
});

describe("211 search_cluster_ids_v2_offset: access", () => {
  it("revokes execute from public, anon and authenticated and grants it to service_role only, for the v2 signature", () => {
    const stmts = statements(sql211);
    expect(stmts).toContain(REVOKE_STMT.slice(0, -1));
    expect(stmts).toContain(GRANT_STMT.slice(0, -1));
    expect(countOf(collapse(stripComments(sql211)), "grant ")).toBe(1);
    expect(collapse(stripComments(sql211)).includes("to anon")).toBe(false);
    expect(collapse(stripComments(sql211)).includes("to authenticated")).toBe(false);
  });

  it("is not an anon RPC: the anon surface allowlist is untouched and the function needs no ops_health_report identity", () => {
    expect(collapse(stripComments(sql211)).includes("ops_health_report")).toBe(false);
  });
});

describe("211 search_cluster_ids_v2_offset: the paging contract (a JS twin of the SQL clamp)", () => {
  const clamp = (offset: number | null) => Math.max(0, Math.min(offset ?? 0, 72));
  const offsetOf = (page: number) => (page - 1) * 24;

  it("pages 1..4 ask for offsets 0, 24, 48 and 72, and the clamp never changes one of them", () => {
    expect([1, 2, 3, 4].map(offsetOf)).toEqual([0, 24, 48, 72]);
    for (let page = 1; page <= ARCHIVE_MAX_PAGE; page++) expect(clamp(offsetOf(page))).toBe(offsetOf(page));
  });

  it("null, negative and oversized offsets are bounded to 0..72", () => {
    expect(clamp(null)).toBe(0);
    expect(clamp(-5)).toBe(0);
    expect(clamp(73)).toBe(72);
    expect(clamp(1_000_000)).toBe(72);
  });

  it("4 pages of 24 are the 96 best matches, and 96 is within the 1000 scored candidates", () => {
    expect(ARCHIVE_MAX_PAGE * 24).toBe(96);
    expect(clamp(72) + 24).toBeLessThanOrEqual(96);
  });
});

describe("211 search_cluster_ids_v2_offset: the migration guide", () => {
  const guide = readFileSync(DOC_MIGRATION_GUIDE, "utf8");

  it("has a ## 211 section whose title carries the apply-first order and v2", () => {
    const at = guide.indexOf("\n## 211 ");
    expect(at).toBeGreaterThan(0);
    const title = guide.slice(at + 1, guide.indexOf("\n", at + 1));
    expect(title).toContain("search_cluster_ids_v2");
    expect(title).toContain("APPLY 211 FIRST, THEN DEPLOY");
  });

  it("the section says what the reverse order does: only later pages degrade, to the unavailable copy", () => {
    const section = sectionOf(guide, "211");
    expect(section).toContain("PGRST202");
    expect(section).toContain("Bu sayfa şu an gösterilemiyor");
    expect(section).toContain("only later pages degrade");
    expect(section).toContain(LIVE_MD5);
    expect(section).toContain(String(LIVE_LENGTH));
    expect(section).toContain("**Rollback:**");
    expect(section).toContain("drop function public.search_cluster_ids_v2(text[], text, integer, integer);");
  });

  it("the section sits after 210 and the guide keeps its numbering order", () => {
    expect(guide.indexOf("\n## 211 ")).toBeGreaterThan(guide.indexOf("\n## 207 "));
  });

  it("carries the md5 and the length of the v2 body in its table", () => {
    const section = sectionOf(guide, "211");
    const body = body211();
    expect(section).toContain(md5(body));
    expect(section).toContain(String([...body].length));
  });
});
