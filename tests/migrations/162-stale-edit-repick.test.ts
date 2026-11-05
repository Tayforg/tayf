import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 162 ("neutral-title-stale-edit-repick").
//
// h42-titles-1 (2026-11-05): apply_article_title_edits (074) rewrites articles.title when an
// outlet edits a headline and "NEVER sets title_tr_neutral". A cluster whose stored extractive
// title is the text an outlet has since edited away keeps showing it: 31fde7d7 said the driver of
// a refuse truck was detained while both members reported the cleaner's death; 24 of 597 clusters
// with a member published in 48 h carried such a title. neutral_title_repick_candidates (155) offers
// a stamped cluster only after a model change, a NULL stamp or growth, so these were never offered
// again. 162 adds one branch: a cluster whose stored title is contained in an old_title recorded by
// article_title_versions in the last 7 days and in no current member title is offered. The same
// signature, security definer, search_path, grants and the three 155 predicates, byte for byte.
// Nothing is written.
//
// Review fix (sec-db-1 / correctness-1): the containment is judged on a KEY, regexp_replace(
// tayf_search_fold(x), '[^a-z0-9]+', '', 'g') (the alphabet of 129's literal tier), on the old title, the
// stored title and the member titles, and the anti-join also accepts the legacy 'Başkan Erdoğan' wording.
// The plain fold compared quotes and apostrophes as typed, so five live clusters (38721672, a6874bad,
// cc01f26a, 502e3032, c2e4a77c) were offered and stamped on every tick without ever leaving the set.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const GUIDE = resolve(__dirname, "..", "..", "docs", "migration-guide.md");
const FILE_155 = "155_neutral_title_repick_growth.sql";
const FILE_162 = "162_neutral_title_stale_edit_repick.sql";

const FN = "public.neutral_title_repick_candidates";
const FN_SIG = `${FN}(text, integer)`;

/** md5 of 155's function body (between the $fn$ markers): production's prosrc on 2026-11-05. */
const PROD_MD5 = "e0d9b88645ff3d4952fb44d02b38ee98";

/** The stale set read-only on production, 2026-11-05, with the key (VERIFY step 4): 59 clusters, 61 rows before the IN. */
const STALE_CLUSTERS_ON_PROD = 59;
/** The cost line: warm runs of the body with the key, and the cold run it is compared with (the first version's). */
const COST_WARM = "163-166 ms warm";
const COST_COLD = "the first version's cold run, which read 2,174 pages and took 1.54 s";

// 155's three offer predicates, verbatim.
const MODEL_BRANCH = "where w.title_neutral_model is distinct from p_model";
const STAMP_BRANCH = "or w.title_neutral_member_count is null";
const GROWTH_BRANCH =
  "or w.article_count >= w.title_neutral_member_count + greatest(3, ceil(w.title_neutral_member_count * 0.5))";
const STALE_BRANCH = "or w.id in (select cluster_id from stale)";

// The key of the stale set, as the SQL spells it (the review fix): the house fold, then every character outside
// [a-z0-9] removed.
const KEY_OF = (x: string): string =>
  `pg_catalog.regexp_replace(public.tayf_search_fold(${x}), '[^a-z0-9]+', '', 'g')`;
const LEGACY_REPLACE = "pg_catalog.replace(a2.title, 'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan')";

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

/** A comment block read as prose: the `--` markers at the start of a line dropped, whitespace collapsed. */
function flat(text: string): string {
  return text.replace(/\n--\s*/g, " ").replace(/\s+/g, " ");
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

describe("migration 162: the file", () => {
  it("exists, with the exact name, and no other file claims the number 162", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, FILE_162))).toBe(true);
    const claimed = readdirSync(MIGRATIONS_DIR).filter((f) => f.startsWith("162_"));
    expect(claimed).toEqual([FILE_162]);
  });

  it("sits right after 161 and leaves 155 alone (155 is the rollback target)", () => {
    expect(existsSync(resolve(MIGRATIONS_DIR, "161_image_coverage_by_source.sql"))).toBe(true);
    const body155 = collapse(functionBody(read(FILE_155)));
    expect(body155).toContain(GROWTH_BRANCH);
    expect(body155).not.toContain("article_title_versions");
  });

  it("runs in one transaction with a bounded lock wait and statement time", () => {
    const stmts = statements(read(FILE_162));
    expect(stmts[0]).toBe("begin");
    expect(stmts[stmts.length - 1]).toBe("commit");
    expect(stmts).toContain("set local lock_timeout = '5s'");
    expect(stmts).toContain("set local statement_timeout = '60s'");
  });

  it("records the production fingerprint it was built on, and that fingerprint is 155's body", () => {
    const header = read(FILE_162).split("\nbegin;")[0]!;
    expect(header).toContain(PROD_MD5);
    expect(header).toMatch(/prosecdef\s+t/);
    expect(header).toContain('proconfig {search_path=""}');
    expect(header).toContain("proacl {postgres=X/postgres,service_role=X/postgres}");
    // The recorded md5 is the md5 of the text between 155's $fn$ markers (comments are not part of prosrc).
    const m = read(FILE_155).match(/\$fn\$([\s\S]*?)\$fn\$/);
    expect(m).not.toBeNull();
    expect(createHash("md5").update(m![1]!).digest("hex")).toBe(PROD_MD5);
  });

  it("the header names the evidence, the 074 / 5651 rationale and the rollback to 155", () => {
    const header = read(FILE_162).split("\nbegin;")[0]!;
    expect(header).toContain("31fde7d7");
    expect(header).toContain("24 of 597");
    expect(header).toContain(`${STALE_CLUSTERS_ON_PROD} clusters`);
    expect(header).toContain("074");
    expect(header).toContain("5651");
    expect(header).toMatch(/ROLLBACK/);
    expect(header).toContain("155_neutral_title_repick_growth.sql");
    expect(header).toContain("version = '162'");
  });
});

describe("migration 162: the header states what the branch does and does not guarantee (review fix)", () => {
  const header = flat(read(FILE_162).split("\nbegin;")[0]!);
  const guide = readFileSync(GUIDE, "utf8");
  const section162 = flat(guide.slice(guide.indexOf("## 162 ")));

  it("no longer claims the branch cannot offer the same row twice, or that the set empties within 2 hours", () => {
    for (const text of [header, section162]) {
      expect(text).not.toContain("cannot offer the same row twice");
      expect(text).not.toContain("about 0 within 2 hours");
      expect(text).not.toContain("stops the branch offering it twice");
    }
  });

  it("states the residue: members with no usable title, or a stored title that passes the gate when no member does", () => {
    for (const text of [header, section162]) {
      expect(text).toMatch(/residue/i);
      expect(text).toMatch(/no usable (member )?title/);
      expect(text).toMatch(/passes the gate when no member does/);
      expect(text).toContain("7 days");
    }
  });

  it("explains the key: quotes, apostrophes and the legacy 'Başkan Erdoğan' wording are why the plain fold was not enough", () => {
    for (const text of [header, section162]) {
      expect(text).toContain("[^a-z0-9]");
      expect(text).toContain("Başkan Erdoğan");
      expect(text).toContain("38721672");
      expect(text).toContain("a6874bad");
      expect(text).toContain("cc01f26a");
    }
  });

  it("VERIFY step 1 carries the md5 and the length of THIS file's function body", () => {
    const m = read(FILE_162).match(/\$fn\$([\s\S]*?)\$fn\$/);
    expect(m).not.toBeNull();
    const md5 = createHash("md5").update(m![1]!).digest("hex");
    const length = [...m![1]!].length; // pg length(prosrc) counts characters
    expect(header).toContain(`${md5}, ${length} (was ${PROD_MD5}, 839)`);
    expect(section162).toContain(`\`${md5}\`, length ${length}`);
    expect(section162).toContain(`${md5}, ${length}, t, s`);
  });

  it("VERIFY step 4 and the guide's query use the same key as the function", () => {
    for (const text of [header, section162]) {
      expect(text).toContain("regexp_replace(public.tayf_search_fold(");
      expect(text).toContain("'[^a-z0-9]+', '', 'g'");
      expect(text).toContain("'Başkan Erdoğan', 'Cumhurbaşkanı Erdoğan'");
    }
  });

  it("restates the cost line with the measured EXPLAIN (cold and warm)", () => {
    expect(header).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\)/);
    expect(header).toContain(COST_COLD);
    expect(header).toContain(COST_WARM);
    expect(section162).toContain(COST_COLD);
    expect(section162).toContain(COST_WARM);
  });
});

describe("migration 162: the function", () => {
  const m155 = read(FILE_155);
  const m162 = read(FILE_162);
  const body = collapse(functionBody(m162));

  it("re-creates the function with create or replace and 155's signature, return columns, language, volatility and search_path", () => {
    expect(collapse(functionHeader(m162))).toBe(collapse(functionHeader(m155)));
    const header = collapse(functionHeader(m162)).toLowerCase();
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

  it("keeps 155's three predicates verbatim: model change, never stamped, growth by half", () => {
    expect(body).toContain(MODEL_BRANCH);
    expect(body).toContain(STAMP_BRANCH);
    expect(body).toContain(GROWTH_BRANCH);
    // The three in 155's order, then the new branch last.
    const at = [MODEL_BRANCH, STAMP_BRANCH, GROWTH_BRANCH, STALE_BRANCH].map((p) => body.indexOf(p));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("keeps 155's window and bounds: active, no LLM title, 14 days, newest 5000, ordered, 1..50", () => {
    expect(body).toContain("c.updated_at > pg_catalog.now() - interval '14 days'");
    expect(body).toContain("order by c.updated_at desc limit 5000");
    expect(body).toContain("order by w.updated_at desc limit least(greatest(coalesce(p_limit, 20), 1), 50)");
    expect(body).toContain("c.title_neutral_at is null");
    expect(body).toContain("c.is_archived = false");
    expect(body).toContain("c.article_count >= 2");
    expect(body).toContain("c.title_tr_neutral is not null");
  });

  it("the part outside the new CTE and branch is 155's body, character for character", () => {
    const old = collapse(functionBody(m155));
    const without = body.replace(STALE_BRANCH, "").replace(/^with stale as \(.*?\) (?=select w\.id)/, "");
    expect(collapse(without)).toBe(old);
  });

  it("adds one stale-edit branch whose set is computed once, in a CTE", () => {
    expect(body.split(STALE_BRANCH).length - 1).toBe(1);
    expect(body.startsWith("with stale as (")).toBe(true);
    // 'stale' is defined once and read once.
    expect(body.match(/\bwith stale as\b/g)).toHaveLength(1);
    expect(body.match(/\bfrom stale\b/g)).toHaveLength(1);
  });

  it("the stale set reads article_title_versions of the last 7 days, joins cluster_articles and folds with tayf_search_fold", () => {
    expect(body).toContain("from public.article_title_versions v");
    expect(body).toContain("join public.cluster_articles ca on ca.article_id = v.article_id");
    expect(body).toContain("v.seen_at > pg_catalog.now() - interval '7 days'");
    expect(body).toContain("public.tayf_search_fold(v.old_title)");
    expect(body).toContain("public.tayf_search_fold(c.title_tr_neutral)");
    expect(body).toContain("public.tayf_search_fold(a2.title)");
  });

  it("the stale set compares on the alphanumeric key: old_title, title_tr_neutral and a2.title all pass through regexp_replace '[^a-z0-9]+' (review, sec-db-1)", () => {
    // old_title, inside the distinct subquery
    expect(body).toContain(`select distinct ca.cluster_id, ${KEY_OF("v.old_title")} as fo`);
    // the stored title, in both strpos calls and in the non-empty guard
    expect(body).toContain(`${KEY_OF("c.title_tr_neutral")} <> ''`);
    expect(body).toContain(`pg_catalog.strpos(e.fo, ${KEY_OF("c.title_tr_neutral")}) > 0`);
    // the member titles, plain and in the legacy wording
    expect(body).toContain(`pg_catalog.strpos(${KEY_OF("a2.title")}, ${KEY_OF("c.title_tr_neutral")}) > 0`);
    expect(body).toContain(
      `or pg_catalog.strpos(${KEY_OF(LEGACY_REPLACE)}, ${KEY_OF("c.title_tr_neutral")}) > 0`,
    );
    // The key is applied to the three columns only, and always with the same pattern.
    const patterns = [...body.matchAll(/regexp_replace\(/g)];
    expect(patterns).toHaveLength(7);
    for (const m of body.matchAll(/pg_catalog\.regexp_replace\(([^,]+(?:\([^)]*\))?[^,]*), ('[^']*'), ('[^']*'), ('[^']*')\)/g)) {
      expect(m[2]).toBe("'[^a-z0-9]+'");
      expect(m[3]).toBe("''");
      expect(m[4]).toBe("'g'");
    }
  });

  it("holds the legacy 'Başkan Erdoğan' replace: v1 to v5 stored 'Cumhurbaşkanı Erdoğan' for a member's 'Başkan Erdoğan' (cc01f26a)", () => {
    expect(body).toContain(LEGACY_REPLACE);
    expect(body.split(LEGACY_REPLACE)).toHaveLength(2);
    // inside the anti-join only, as an alternative to the plain comparison
    const antiJoin = body.slice(body.indexOf("and not exists ("), body.indexOf("select w.id"));
    expect(antiJoin).toContain(LEGACY_REPLACE);
    expect(antiJoin).toMatch(/\) > 0 or pg_catalog\.strpos\(/);
  });

  it("an empty key is never stale: the guard sits in the stale set's where, before the containment test", () => {
    const at = (needle: string) => body.indexOf(needle);
    expect(at(`${KEY_OF("c.title_tr_neutral")} <> ''`)).toBeGreaterThan(0);
    expect(at(`${KEY_OF("c.title_tr_neutral")} <> ''`)).toBeLessThan(at(`pg_catalog.strpos(e.fo, ${KEY_OF("c.title_tr_neutral")}) > 0`));
  });

  it("the stale set is: active, no LLM title, a stored title, contained in an old title, in no current member title", () => {
    expect(body).toContain("join public.clusters c on c.id = e.cluster_id");
    expect(body).toContain("where not c.is_archived and c.title_neutral_at is null and c.title_tr_neutral is not null");
    expect(body).toMatch(
      /and not exists \(select 1 from public\.cluster_articles ca2 join public\.articles a2 on a2\.id = ca2\.article_id where ca2\.cluster_id = c\.id and /,
    );
    expect(body).toContain("select distinct ca.cluster_id, pg_catalog.regexp_replace(public.tayf_search_fold(v.old_title)");
  });

  it("every relation and function inside the body is schema-qualified (search_path is empty)", () => {
    // "is distinct from p_model" is a comparison, not a relation.
    const code = sansStrings(stripSqlComments(functionBody(m162))).replace(/\bis distinct from\b/gi, "is distinct to");
    const relations = [...code.matchAll(/\b(?:from|join)\s+([a-z_][\w.]*)/gi)].map((m) => m[1]!);
    expect(relations.length).toBeGreaterThan(4);
    for (const rel of relations) {
      if (rel === "stale") continue; // the CTE
      expect(rel, `unqualified relation ${rel}`).toMatch(/^public\./);
    }
    expect(code).toContain("pg_catalog.now()");
    expect(code).not.toMatch(/(?<![\w.])now\(\)/);
    expect(code).not.toMatch(/(?<![\w.])strpos\(/);
    expect(code).not.toMatch(/(?<![\w.])(?:lower|translate|regexp_replace|replace)\(/);
  });

  it("the function comment states the stale-edit branch and lists migrations 141, 155, 162", () => {
    const comment = statementStartingWith(m162, "comment on function");
    expect(comment.startsWith(`comment on function ${FN_SIG} is '`)).toBe(true);
    expect(comment).toContain("grown by half (at least +3)");
    expect(comment).toContain("title an outlet has since edited away");
    expect(comment).toContain("Migrations 141, 155, 162.");
    expect(comment).not.toContain("Migrations 141, 155.");
  });
});

describe("migration 162: privileges", () => {
  const code = statements(read(FILE_162)).join(";\n") + ";";

  it("re-states the grants: revoke from public/anon/authenticated, grant execute to service_role", () => {
    expect(code).toContain(`revoke all on function ${FN_SIG} from public, anon, authenticated;`);
    expect(code).toContain(`grant execute on function ${FN_SIG} to service_role;`);
  });

  it("never grants anything to anon or authenticated, on this function or on a table", () => {
    const grants = statements(read(FILE_162)).filter((stmt) => /^grant\b/i.test(stmt));
    expect(grants).toEqual([`grant execute on function ${FN_SIG} to service_role`]);
  });

  it("reloads the PostgREST schema cache", () => {
    expect(code).toContain("notify pgrst, 'reload schema';");
  });
});

describe("migration 162: no data is written", () => {
  const stmts = statements(read(FILE_162));

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

  it("has no update, delete, truncate, alter, drop, create table or create index statement, and the function body writes nothing", () => {
    const sans = sansStrings(stmts.join(";\n")).toLowerCase();
    expect(sans).not.toMatch(/(^|\s)update\s+public\./);
    expect(sans).not.toMatch(/(^|\s)delete\s+from\b/);
    expect(sans).not.toMatch(/\btruncate\b/);
    expect(sans).not.toMatch(/\balter\s+(table|function|role|default)/);
    expect(sans).not.toMatch(/\bdrop\s+/);
    expect(sans).not.toMatch(/\bcreate\s+(table|index|unique|trigger|extension)/);
    const body = sansStrings(stripSqlComments(functionBody(read(FILE_162)))).toLowerCase();
    expect(body).not.toMatch(/\b(?:insert|update|delete|truncate)\b/);
  });

  it("the one insert is the ledger row, written the way migration 155 does", () => {
    const inserts = stmts.filter((s) => /^insert\b/i.test(s));
    expect(inserts).toEqual([
      "insert into supabase_migrations.schema_migrations (version, name) values ('162', '162_neutral_title_stale_edit_repick') on conflict do nothing",
    ]);
  });
});
