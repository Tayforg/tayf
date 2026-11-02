import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { foldTr } from "../../src/lib/clusters/turkish-query";
import { headlineTokens } from "../../supabase/functions/_shared/cluster/fingerprint.ts";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 146 ("cluster-stem-probe"), hunt 19
// finding h19-recall-2.
//
// The cluster consumer scores an incoming article against the newest ~200 live
// clusters only. Older clusters are reachable through the exact-title probe of
// migration 135, whose key is md5(tayf_search_fold(title_tr)); the fold keeps
// punctuation, so 'İsrail’de Arap partilerinden Netanyahu karşıtı bloğa destek
// mesajı' and the same title with a trailing '!' (two live singletons, 8947d162
// and bb7517ca) never meet, nor do 'Mutlu bir yuva önceliğimdi' and the quoted
// form (f3f6c1c4 / 69df216b). 146 adds
//   * public.cluster_stem_probe(p_stems text[], p_since timestamptz, p_limit int)
//        the live clusters of the last 24 h whose folded seed title shares at
//        least least(4, n) of the n caller-supplied headline stems; SECURITY
//        DEFINER, service_role only, no index (about 1,000 live rows in 24 h).
//
// TOKEN CONTRACT. The consumer sends p_stems = [...headlineTokens(title).tokens]
// (stemmed, folded, stop words and generic prefixes removed). The SQL splits
// tayf_search_fold(title_tr) on '[^a-z0-9]+' into surface words. A stem counts
// as shared when some word w has w = s, or when length(s) >= 4, s is not all
// digits and starts_with(w, s) (stemHeadlineToken only strips suffixes, so a
// stem is a prefix of the folded surface word). Overlap = distinct shared stems.
// `stemOverlap` below is the TypeScript model of that rule, with foldTr (the
// twin of tayf_search_fold) followed by split(/[^a-z0-9]+/).
//
// The last block (opt-in, TAYF_PSQL) applies 146 twice to a throwaway Postgres
// and runs the function against fixtures. TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server; the target needs the stub
// schema (public.clusters with merged_into) and migration 129's tayf_search_fold.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION_FILE = "146_cluster_stem_probe.sql";
const MIGRATION = resolve(MIGRATIONS_DIR, MIGRATION_FILE);
const MIGRATION_135 = resolve(MIGRATIONS_DIR, "135_cluster_title_key_idx.sql");

// The identity is written exactly like this everywhere (tests/guards/anon-surface
// compares identities, not names).
const FN_SIG = "public.cluster_stem_probe(text[], timestamptz, integer)";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** Blank out every single-quoted string literal (so prose in messages never satisfies a code guard). */
function sansStrings(sql: string): string {
  // Character scan (no regex over the literals): a doubled quote inside a literal stays inside it.
  let out = "";
  let inStr = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql.charAt(i);
    if (!inStr) {
      if (ch === "'") {
        inStr = true;
        out += "''";
      } else {
        out += ch;
      }
    } else if (ch === "'") {
      if (sql.charAt(i + 1) === "'") i++;
      else inStr = false;
    }
  }
  return out;
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Spaces around parentheses, brackets and commas are layout, not content. */
function tight(s: string): string {
  return collapse(s).replace(/\s*([(),])\s*/g, "$1");
}

let sql = "";
let code = "";
let codeNoStr = "";
let head = "";
let headText = "";

beforeAll(() => {
  sql = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(sql);
  codeNoStr = sansStrings(code);
  head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
  headText = head
    .split("\n")
    .map((l) => l.replace(/^\s*--\s?/, ""))
    .join("\n");
});

/** The text between `$fn$` markers of the function. */
function fnBody(): string {
  const m = /create\s+or\s+replace\s+function\s+public\.cluster_stem_probe[\s\S]*?\$fn\$([\s\S]*?)\$fn\$/i.exec(code);
  if (!m) throw new Error("cluster_stem_probe body ($fn$ ... $fn$) not found");
  return m[1] as string;
}

/** The function statement up to (and including) the closing $fn$ marker. */
function fnStatement(): string {
  const m = /create\s+or\s+replace\s+function\s+public\.cluster_stem_probe[\s\S]*?\$fn\$[\s\S]*?\$fn\$/i.exec(code);
  if (!m) throw new Error("cluster_stem_probe statement not found");
  return m[0];
}

/** `returns table (...)` clause of a function statement, layout-free. */
function returnsTable(statement: string): string {
  const m = /returns\s+table\s*\(([^)]*)\)/i.exec(statement);
  if (!m) throw new Error("returns table (...) not found");
  return tight(m[1] as string);
}

// ---------------------------------------------------------------------------
// The TypeScript model of the SQL rule (see the TOKEN CONTRACT above).
// ---------------------------------------------------------------------------

const STEM_RE = /^[a-z0-9]{2,40}$/; // s.stem ~ '^[a-z0-9]{2,40}$'
const DIGITS_RE = /^[0-9]+$/; //        s.stem !~ '^[0-9]+$'
const WORD_SPLIT_RE = /[^a-z0-9]+/; //  regexp_split_to_array(fold, '[^a-z0-9]+')

/** The stems the function works with: first 32 of the array, shape-checked, distinct. */
function probeStems(stems: readonly string[]): string[] {
  return [...new Set(stems.slice(0, 32).filter((s) => STEM_RE.test(s)))];
}

/** need.n = least(4, count(*)) over the usable stems. */
function stemBar(stems: readonly string[]): number {
  return Math.min(4, probeStems(stems).length);
}

/** Number of distinct usable stems shared with the title, by the TOKEN CONTRACT. */
function stemOverlap(stems: readonly string[], title: string): number {
  const words = foldTr(title).split(WORD_SPLIT_RE);
  let shared = 0;
  for (const s of probeStems(stems)) {
    const prefixable = s.length >= 4 && !DIGITS_RE.test(s);
    if (words.some((w) => w === s || (prefixable && w.startsWith(s)))) shared++;
  }
  return shared;
}

/** Would the function return a cluster with this title for these stems? */
function wouldReturn(stems: readonly string[], title: string): boolean {
  const n = probeStems(stems).length;
  return n >= 3 && stemOverlap(stems, title) >= stemBar(stems);
}

const stemsOf = (title: string): string[] => [...headlineTokens(title).tokens];

const ISRAIL = "İsrail’de Arap partilerinden Netanyahu karşıtı bloğa destek mesajı";
const MUTLU = "Mutlu bir yuva önceliğimdi";

describe("146 ledger and structure", () => {
  it("is wrapped in begin/commit and sets lock_timeout 5s first", () => {
    expect([...code.matchAll(/\bbegin\s*;/gi)]).toHaveLength(1);
    expect([...code.matchAll(/\bcommit\s*;/gi)]).toHaveLength(1);
    expect(code.trimStart()).toMatch(/^begin\s*;\s*set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
  });

  it("records itself as version '146' under the name of its own file", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'146'\s*,\s*'146_cluster_stem_probe'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(MIGRATION_FILE).toBe("146_cluster_stem_probe.sql");
  });

  it("the ledger insert is the last statement before commit", () => {
    expect(code.trimEnd()).toMatch(
      /values\s*\(\s*'146'\s*,\s*'146_cluster_stem_probe'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;$/i,
    );
  });

  it("sanity: comment stripping and string blanking are non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
    expect(code.length).toBeGreaterThan(codeNoStr.length);
    expect(sansStrings("select 'a''b', 'c' from t")).toBe("select '', '' from t");
  });

  it("never mentions the zone word (zone-parity would count this file as another zone-map copy)", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });

  it("146 is the only file with that number and the earlier migrations are all still there", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    expect(files.filter((f) => f.startsWith("146_"))).toEqual([MIGRATION_FILE]);
    expect(files).toContain("129_search_fold_rank.sql");
    expect(files).toContain("135_cluster_title_key_idx.sql");
    expect(files).toContain("145_ops_anon_surface_check.sql");
  });
});

describe("146 executable SQL is additive", () => {
  it("has no concurrently, drop, truncate, vacuum, analyze, alter, index or table DDL in executable SQL", () => {
    expect(codeNoStr).not.toMatch(/\bconcurrently\b/i);
    expect(codeNoStr).not.toMatch(/\bdrop\b/i);
    expect(codeNoStr).not.toMatch(/\btruncate\b/i);
    expect(codeNoStr).not.toMatch(/\bvacuum\b/i);
    expect(codeNoStr).not.toMatch(/\banalyze\b/i);
    expect(codeNoStr).not.toMatch(/\balter\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(unique\s+)?index\b/i);
    expect(codeNoStr).not.toMatch(/\bcreate\s+(or\s+replace\s+)?(unlogged\s+|temp\s+|temporary\s+)?(table|view|trigger|policy|extension)\b/i);
  });

  it("writes no public table; the only insert is the ledger row", () => {
    expect(codeNoStr).not.toMatch(/\b(insert\s+into|update|delete\s+from)\s+public\./i);
    const inserts = [...codeNoStr.matchAll(/\binsert\s+into\s+([\w.]+)/gi)].map((m) => m[1]);
    expect(inserts).toEqual(["supabase_migrations.schema_migrations"]);
    expect([...codeNoStr.matchAll(/\bupdate\b|\bdelete\b/gi)]).toHaveLength(0);
  });

  it("creates exactly one function", () => {
    const fns = [...code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+([\w.]+)\s*\(/gi)].map((m) => m[1]);
    expect(fns).toEqual(["public.cluster_stem_probe"]);
  });

  it("does not redefine the exact-title probe or the fold (135 and 129 stay untouched)", () => {
    expect(codeNoStr).not.toMatch(/function\s+public\.cluster_title_probe/i);
    expect(codeNoStr).not.toMatch(/function\s+public\.tayf_search_fold/i);
  });
});

describe("146 cluster_stem_probe signature", () => {
  it("is SECURITY DEFINER, STABLE, LANGUAGE sql, with search_path pinned to the empty string", () => {
    const stmt = collapse(fnStatement());
    expect(stmt).toMatch(/\blanguage sql\b/i);
    expect(stmt).toMatch(/\bstable\b/i);
    expect(stmt).toMatch(/\bsecurity definer\b/i);
    expect(stmt).toMatch(/\bset search_path = ''/i);
    expect(stmt).not.toMatch(/\b(volatile|immutable)\b/i);
  });

  it("has the (p_stems text[], p_since timestamptz default null, p_limit integer default 3) signature", () => {
    expect(tight(fnStatement())).toContain(
      "cluster_stem_probe(p_stems text[],p_since timestamptz default null,p_limit integer default 3)",
    );
  });

  it("returns the six columns of cluster_title_probe (135), same types, same order", () => {
    const expected =
      "id uuid,title_tr text,title_tr_neutral text,first_published timestamptz,updated_at timestamptz,article_count integer";
    expect(returnsTable(fnStatement())).toBe(expected);
    const m135 = stripSqlComments(readFileSync(MIGRATION_135, "utf8"));
    const stmt135 = /create\s+or\s+replace\s+function\s+public\.cluster_title_probe[\s\S]*?\$fn\$[\s\S]*?\$fn\$/i.exec(m135);
    expect(stmt135, "135's cluster_title_probe not found").not.toBeNull();
    expect(returnsTable((stmt135 as RegExpExecArray)[0])).toBe(expected);
  });

  it("selects exactly those six columns in that order", () => {
    const body = collapse(fnBody());
    expect(body).toContain(
      "select c.id, c.title_tr, c.title_tr_neutral, c.first_published, c.updated_at, c.article_count from",
    );
  });
});

describe("146 cluster_stem_probe body", () => {
  it("bounds the lower end at 24 h: greatest(coalesce(p_since, now()-24h), now()-24h)", () => {
    const body = collapse(fnBody());
    expect(body).toContain(
      "c.updated_at >= greatest(coalesce(p_since, pg_catalog.now() - interval '24 hours'), pg_catalog.now() - interval '24 hours')",
    );
  });

  it("clamps the limit to 1..3", () => {
    expect(collapse(fnBody())).toContain("limit least(greatest(coalesce(p_limit, 3), 1), 3)");
  });

  it("the overlap bar is least(4, number of usable stems) and a headline needs at least 3 stems", () => {
    const body = collapse(fnBody());
    expect(body).toContain("least(4, pg_catalog.count(*))::integer");
    expect(body).toMatch(/need\.n >= 3\b/);
    expect(body).toMatch(/o\.overlap >= need\.n\b/);
  });

  it("returns only live clusters: not is_archived and merged_into is null", () => {
    expect(collapse(fnBody())).toContain("not c.is_archived and c.merged_into is null");
  });

  it("orders by overlap desc, updated_at desc", () => {
    expect(collapse(fnBody())).toContain("order by o.overlap desc, c.updated_at desc");
  });

  it("works on at most 32 caller stems of the shape ^[a-z0-9]{2,40}$, distinct, null-safe", () => {
    const body = collapse(fnBody());
    expect(body).toContain("(coalesce(p_stems, '{}'::text[]))[1:32]");
    expect(body).toContain("s.stem ~ '^[a-z0-9]{2,40}$'");
    expect(body).toMatch(/select distinct s\.stem\b/);
  });

  it("the TOKEN CONTRACT in SQL: equal word, or stem >= 4 characters, not all digits, prefix of the word", () => {
    const body = collapse(fnBody());
    expect(body).toContain("pg_catalog.regexp_split_to_array(public.tayf_search_fold(c.title_tr), '[^a-z0-9]+')");
    expect(body).toContain("pg_catalog.length(s.stem) >= 4");
    expect(body).toContain("s.stem !~ '^[0-9]+$'");
    expect(body).toContain("t.word = q.stem");
    expect(body).toContain("pg_catalog.starts_with(t.word, q.stem)");
  });

  it("the regexes of the model are the regexes of the SQL (character scan of the literals, no regex over them)", () => {
    const literals: string[] = [];
    let cur: string | null = null;
    const body = fnBody();
    for (let i = 0; i < body.length; i++) {
      const ch = body.charAt(i);
      if (cur === null) {
        if (ch === "'") cur = "";
      } else if (ch === "'") {
        if (body.charAt(i + 1) === "'") {
          cur += "'";
          i++;
        } else {
          literals.push(cur);
          cur = null;
        }
      } else {
        cur += ch;
      }
    }
    expect(literals).toContain(STEM_RE.source);
    expect(literals).toContain(DIGITS_RE.source);
    expect(literals).toContain(WORD_SPLIT_RE.source);
  });

  it("qualifies every function call (search_path is empty); only coalesce / least / greatest and SQL syntax are bare", () => {
    const body = sansStrings(fnBody());
    // Names that may precede '(' without a schema: SQL syntax and the table/column aliases of the body.
    const allowed = new Set([
      "coalesce", "least", "greatest",
      // SQL syntax that may be followed by a parenthesis
      "as", "exists", "in", "or", "and", "not", "on", "select", "where", "from", "join", "lateral", "by", "then", "when", "else", "case",
      // aliases with a column list, CTE names
      "s", "t", "q", "need", "w", "o",
    ]);
    const bare: string[] = [];
    for (const m of body.matchAll(/(?<![.\w])([a-z_][a-z0-9_]*)\s*\(/gi)) {
      const name = (m[1] as string).toLowerCase();
      if (!allowed.has(name)) bare.push(name);
    }
    expect(bare).toEqual([]);
    // Table references are schema-qualified too (CTE names and aliases excepted).
    for (const m of body.matchAll(/\b(from|join)\s+([\w.]+)/gi)) {
      const ref = m[2] as string;
      if (["q", "need", "lateral", "pg_catalog.unnest"].includes(ref)) continue;
      expect(ref, `${m[0]} must be schema-qualified`).toMatch(/^public\./);
    }
  });
});

describe("146 privileges", () => {
  it("revokes everything from public, anon and authenticated, with the exact identity", () => {
    expect(collapse(code)).toContain(
      "revoke all on function public.cluster_stem_probe(text[], timestamptz, integer) from public, anon, authenticated;",
    );
  });

  it("executes for service_role only: one grant, exact identity", () => {
    const grants = [...collapse(code).matchAll(/\bgrant\b[^;]*;/gi)].map((m) => m[0]);
    expect(grants).toEqual(["grant execute on function public.cluster_stem_probe(text[], timestamptz, integer) to service_role;"]);
    expect(FN_SIG).toBe("public.cluster_stem_probe(text[], timestamptz, integer)");
  });

  it("revokes before it grants, and both come after the function is created", () => {
    const c = collapse(code);
    const created = c.indexOf("create or replace function public.cluster_stem_probe");
    const revoked = c.indexOf("revoke all on function");
    const granted = c.indexOf("grant execute on function");
    expect(created).toBeGreaterThan(0);
    expect(revoked).toBeGreaterThan(created);
    expect(granted).toBeGreaterThan(revoked);
  });

  it("has a comment on the function and grants nothing on any table, schema or sequence", () => {
    expect(collapse(code)).toMatch(/comment on function public\.cluster_stem_probe\(text\[\], timestamptz, integer\) is /i);
    expect(codeNoStr).not.toMatch(/\bgrant\b[^;]*\bon\s+(all\s+)?(tables?|sequences?|schema)\b/i);
    expect(codeNoStr).not.toMatch(/\bgrant\b[^;]*\b(insert|update|delete|truncate|maintain|select)\b/i);
    expect(codeNoStr).not.toMatch(/\bto\s+(anon|authenticated|public)\b/i);
    expect(codeNoStr).not.toMatch(/alter\s+default\s+privileges/i);
  });

  it("asks PostgREST to reload its schema cache (the consumer calls the function over rpc)", () => {
    expect(collapse(code)).toContain("notify pgrst, 'reload schema';");
    expect(collapse(code).indexOf("notify pgrst")).toBeGreaterThan(collapse(code).indexOf("grant execute on function"));
  });
});

describe("146 header: documentation sections", () => {
  it("has the WHY section with the four clusters of the evidence and the context cap", () => {
    expect(headText).toMatch(/\bWHY\b/);
    for (const id of ["8947d162", "bb7517ca", "f3f6c1c4", "69df216b"]) expect(headText).toContain(id);
    expect(headText).toMatch(/CONTEXT_CLUSTER_CAP/);
    expect(headText).toMatch(/27%/);
  });

  it("has STEP 0 with the read-only measurements (fold ACL, 24 h population, ledger)", () => {
    expect(headText).toMatch(/STEP 0/);
    expect(headText).toMatch(/read-only/i);
    expect(headText).toMatch(/provolatile/);
    expect(headText).toMatch(/proacl/);
    expect(headText).toMatch(/service_role/);
    expect(headText).toMatch(/schema_migrations/);
  });

  it("states the token contract the consumer and the SQL agree on", () => {
    expect(headText).toMatch(/TOKEN CONTRACT/);
    expect(headText).toMatch(/headlineTokens/);
    expect(headText).toMatch(/starts_with/);
  });

  it("has the COST section: explain (analyze, buffers) on production under 150 ms, and the 72 h confirmation", () => {
    expect(headText).toMatch(/\bCOST\b/);
    expect(headText).toMatch(/explain \(analyze, buffers\)/i);
    expect(headText).toMatch(/Execution Time: \d+(\.\d+)? ms/);
    expect(headText).toMatch(/150 ms/);
    expect(headText).toMatch(/72 h/);
    expect(headText).toMatch(/Index Scan using clusters_active_updated_idx/);
  });

  it("has the DRY RUNS section: two applies on a local PG15, the second a no-op, privileges and a real call", () => {
    expect(headText).toMatch(/DRY RUNS/);
    expect(headText).toMatch(/INSERT 0 0/);
    expect(headText).toMatch(/PostgreSQL 15/);
    expect(headText).toMatch(/has_function_privilege/);
  });

  it("has a read-only VERIFY section", () => {
    expect(headText).toMatch(/VERIFY/);
    expect(headText).toMatch(/cluster_stem_probe/);
  });

  it("has a DEPLOY section (apply 146, then deploy the edge function) and notes the safe order", () => {
    expect(headText).toMatch(/DEPLOY/);
    expect(headText).toMatch(/cluster-consumer/);
    expect(headText).toMatch(/--no-verify-jwt/);
  });

  it("has ROLLBACK lines for the function and ledger row 146", () => {
    expect(headText).toMatch(/ROLLBACK/);
    expect(headText).toMatch(/drop function if exists public\.cluster_stem_probe\(text\[\], timestamptz, integer\)/i);
    expect(headText).toMatch(/delete from supabase_migrations\.schema_migrations where version = '146'/i);
  });

  it("states the migration is additive, needs no index, and is safe to re-apply", () => {
    expect(headText).toMatch(/additive/i);
    expect(headText).toMatch(/no index/i);
    expect(headText).toMatch(/re-?apply/i);
  });
});

// ---------------------------------------------------------------------------
// Parity model: what the SQL rule returns for real titles (the evidence of the
// finding) and for the near-misses it must not return.
// ---------------------------------------------------------------------------

describe("146 parity model: the TOKEN CONTRACT on real titles", () => {
  it("the exact-title key of 135 misses both pairs (premise of the finding)", () => {
    expect(foldTr(ISRAIL)).not.toBe(foldTr(`${ISRAIL}!`));
    expect(foldTr(MUTLU)).not.toBe(foldTr(`"${MUTLU}"`));
  });

  it("the headline stems of both pairs are equal (the consumer sends the same p_stems)", () => {
    expect(stemsOf(`${ISRAIL}!`)).toEqual(stemsOf(ISRAIL));
    expect(stemsOf(`"${MUTLU}"`)).toEqual(stemsOf(MUTLU));
    expect(stemsOf(ISRAIL)).toEqual(["israil", "arap", "parti", "netanyahu", "karsi", "bloga", "destek", "mesaji"]);
    expect(stemsOf(MUTLU)).toEqual(["mutlu", "yuva", "onceligim"]);
  });

  it("every stem of these titles passes the SQL shape filter, so none is dropped before counting", () => {
    for (const title of [ISRAIL, `${ISRAIL}!`, MUTLU, `"${MUTLU}"`]) {
      const stems = stemsOf(title);
      expect(probeStems(stems)).toEqual(stems);
    }
  });

  it("(i) Israel: the same title with a trailing '!' shares all n stems, which is >= least(4, n)", () => {
    const stems = stemsOf(`${ISRAIL}!`);
    const n = stems.length;
    expect(n).toBe(8);
    expect(stemOverlap(stems, ISRAIL)).toBe(n);
    expect(stemOverlap(stems, ISRAIL)).toBeGreaterThanOrEqual(Math.min(4, n));
    expect(stemBar(stems)).toBe(4);
    expect(wouldReturn(stems, ISRAIL)).toBe(true);
    // and the other direction
    expect(stemOverlap(stemsOf(ISRAIL), `${ISRAIL}!`)).toBe(n);
  });

  it("(ii) Mutlu bir yuva: quoted against unquoted shares all 3 stems, which is >= least(4, 3) = 3", () => {
    const stems = stemsOf(`"${MUTLU}"`);
    const n = stems.length;
    expect(n).toBe(3);
    expect(stemBar(stems)).toBe(3);
    expect(stemOverlap(stems, MUTLU)).toBe(n);
    expect(stemOverlap(stems, MUTLU)).toBeGreaterThanOrEqual(Math.min(4, n));
    expect(wouldReturn(stems, MUTLU)).toBe(true);
    expect(wouldReturn(stemsOf(MUTLU), `"${MUTLU}"`)).toBe(true);
  });

  it("(iii) real unrelated titles that share at most 3 of the Israel stems stay below the bar of 4", () => {
    const stems = stemsOf(`${ISRAIL}!`);
    const titles: Array<[string, number]> = [
      // production titles of 2026-11-01/02 (public news text)
      ["Eski Kolombiya lideri Petro, İsrail partilerine demokratik mutabakat çağrısı yaptı", 2],
      ["Netanyahu'dan Arap partilerine rest: Sizinle hükümet kurmayacağım", 3],
      ["Eisenkot, Arap partileriyle meclis çoğunluğunu hükümete karşı kullanacak", 3],
      ["İsrail’de düğüm çözülüyor mu… Netanyahu’suz hükümet arayışı başladı", 2],
    ];
    for (const [title, shared] of titles) {
      expect(stemOverlap(stems, title), title).toBe(shared);
      expect(stemOverlap(stems, title), title).toBeLessThan(stemBar(stems));
      expect(wouldReturn(stems, title), title).toBe(false);
    }
  });

  it("control: a real follow-up that shares exactly 4 stems is at the bar and is returned (the scorer decides at 0.40)", () => {
    const stems = stemsOf(`${ISRAIL}!`);
    const title = "Yair Netanyahu, Arap partilerini İsrail'in geleceğine tehdit olarak gösterdi";
    expect(stemOverlap(stems, title)).toBe(4);
    expect(wouldReturn(stems, title)).toBe(true);
  });

  it("a title is its own best match: self-overlap equals the number of stems for real titles", () => {
    const titles = [
      "‘Dış müdahale’ yalanına sığınan Netanyahu’ya kötü haber",
      "Eisenkot, Netanyahu'yu gayrimeşrulaştırma kampanyası yürütmekle suçladı",
      "Kim daha çok Gazzeli öldürürse ona oy veriyorlar! İsrail'in halkı da soykırımcı",
      "Eski Kolombiya lideri Petro, İsrail partilerine demokratik mutabakat çağrısı yaptı",
      "İsrail Seçim Komitesi Başkanı Sohlberg, sonucu soruşturmanın etkilemeyeceğini söyledi",
      "Antalya'dan Alanya'ya ulaşım 36 dakikaya inecek, yıllık tasarruf 23,9 milyar lira",
      "Yüsra Geyik takside beklerken, Nehir Erdoğan arka kapıdan kaçtı",
      "Güney Kore'de dostluk diplomasisi: Başkan Erdoğan Seul'e doğru yola çıktı",
      "ŞİŞLİ BELEDİYESİ'NDE İSTANBUL SORUŞTURMASI: ÇOCUKLAR İÇİN ÖZEL ÖNLEM",
    ];
    for (const title of titles) {
      const stems = stemsOf(title);
      expect(stems.length, title).toBeGreaterThanOrEqual(3);
      expect(stemOverlap(stems, title), title).toBe(probeStems(stems).length);
    }
  });
});

describe("146 parity model: the edges of the rule", () => {
  it("a headline with fewer than 3 usable stems never matches (need.n >= 3)", () => {
    expect(wouldReturn(["israil", "arap"], "İsrail Arap")).toBe(false);
    expect(wouldReturn([], "İsrail")).toBe(false);
    // single characters do not count: only 2 usable stems remain
    expect(probeStems(["a", "israil", "arap", "7"])).toEqual(["israil", "arap"]);
    expect(wouldReturn(["a", "israil", "arap", "7"], "a israil arap 7")).toBe(false);
  });

  it("with exactly 3 usable stems all 3 are needed; with 4 or more, any 4", () => {
    expect(stemBar(["alfa", "beta", "gama"])).toBe(3);
    expect(wouldReturn(["alfa", "beta", "gama"], "alfa beta delta")).toBe(false);
    expect(wouldReturn(["alfa", "beta", "gama"], "alfa beta gama")).toBe(true);
    const six = ["alfa", "beta", "gama", "delta", "epsilon", "zeta"];
    expect(stemBar(six)).toBe(4);
    expect(wouldReturn(six, "alfa beta gama delta")).toBe(true);
    expect(wouldReturn(six, "alfa beta gama")).toBe(false);
  });

  it("a stem of 3 characters or fewer needs the whole word; 4 or more may be a prefix of it", () => {
    expect(stemOverlap(["gaz", "arap", "israil"], "gazze arap israil")).toBe(2);
    expect(stemOverlap(["gazz", "arap", "israil"], "gazze arap israil")).toBe(3);
    expect(stemOverlap(["gaz", "arap", "israil"], "gaz arap israil")).toBe(3);
  });

  it("an all-digit stem matches a whole number only, never a prefix of a longer one", () => {
    expect(stemOverlap(["36", "dakika", "inecek"], "ulaşım 365 dakikaya inecek")).toBe(2);
    expect(stemOverlap(["36", "dakika", "inecek"], "ulaşım 36 dakikaya inecek")).toBe(3);
    expect(stemOverlap(["2026", "butce", "meclis"], "20261 bütçe meclis")).toBe(2);
  });

  it("the match is punctuation- and case-insensitive (the point of the probe)", () => {
    const stems = stemsOf("Mutlu bir yuva önceliğimdi");
    for (const t of ['"MUTLU BİR YUVA ÖNCELİĞİMDİ"', "Mutlu bir yuva önceliğimdi!!!", "«Mutlu, bir yuva… önceliğimdi»"]) {
      expect(wouldReturn(stems, t), t).toBe(true);
    }
  });

  it("only the first 32 stems are looked at, and duplicates count once", () => {
    const many = Array.from({ length: 40 }, (_, i) => `stem${String(i).padStart(2, "0")}`);
    expect(probeStems(many)).toHaveLength(32);
    expect(probeStems(["alfa", "alfa", "beta"])).toEqual(["alfa", "beta"]);
    expect(probeStems(["Alfa", "al-fa", "x".repeat(41)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): 146 applied twice to a throwaway Postgres, then the
// function against fixtures inside a rolled-back transaction.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("146 against a live Postgres", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const arr = (stems: string[]) => `array[${stems.map(lit).join(",")}]::text[]`;

  it("applies twice: the second apply creates nothing and leaves one ledger row and one function", () => {
    runPsql(readFileSync(MIGRATION, "utf8"));
    runPsql(readFileSync(MIGRATION, "utf8"));
    expect(runPsql("select count(*) from supabase_migrations.schema_migrations where version = '146';").trim()).toBe("1");
    expect(
      runPsql(
        "select count(*) from pg_catalog.pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'cluster_stem_probe';",
      ).trim(),
    ).toBe("1");
  });

  it("anon and authenticated cannot execute it; service_role can", () => {
    const out = runPsql(`
select 'anon', pg_catalog.has_function_privilege('anon', '${FN_SIG}', 'execute');
select 'auth', pg_catalog.has_function_privilege('authenticated', '${FN_SIG}', 'execute');
select 'srv', pg_catalog.has_function_privilege('service_role', '${FN_SIG}', 'execute');
`);
    expect(out).toContain("anon|f");
    expect(out).toContain("auth|f");
    expect(out).toContain("srv|t");
  });

  it("returns the punctuation variants, live and recent only, best overlap then newest first, limit clamped to 3", () => {
    const israilStems = stemsOf(`${ISRAIL}!`);
    const mutluStems = stemsOf(MUTLU);
    const out = runPsql(`
begin;
insert into public.clusters (id, title_tr, article_count, first_published, updated_at, is_archived, merged_into)
values
  ('00000000-0000-0000-0000-0000000000b1', ${lit(ISRAIL)}, 1, now() - interval '5 hours', now() - interval '5 hours', false, null),
  ('00000000-0000-0000-0000-0000000000b2', ${lit(`${ISRAIL}!`)}, 1, now() - interval '9 hours', now() - interval '9 hours', false, null),
  ('00000000-0000-0000-0000-0000000000b3', ${lit(ISRAIL)}, 1, now() - interval '2 hours', now() - interval '2 hours', true, null),
  ('00000000-0000-0000-0000-0000000000b4', ${lit(ISRAIL)}, 1, now() - interval '2 hours', now() - interval '2 hours', false, '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000b5', ${lit(ISRAIL)}, 1, now() - interval '30 hours', now() - interval '30 hours', false, null),
  ('00000000-0000-0000-0000-0000000000b6', 'Netanyahu''dan Arap partilerine rest: Sizinle hükümet kurmayacağım', 1, now() - interval '1 hours', now() - interval '1 hours', false, null),
  ('00000000-0000-0000-0000-0000000000b7', 'Eski Kolombiya lideri Petro, İsrail partilerine demokratik mutabakat çağrısı yaptı', 1, now() - interval '1 hours', now() - interval '1 hours', false, null),
  ('00000000-0000-0000-0000-0000000000c1', ${lit(MUTLU)}, 1, now() - interval '20 hours', now() - interval '20 hours', false, null),
  ('00000000-0000-0000-0000-0000000000c2', ${lit(`"${MUTLU}"`)}, 1, now() - interval '3 hours', now() - interval '3 hours', false, null),
  ('00000000-0000-0000-0000-0000000000c3', 'Mutlu bir yuva değil', 1, now() - interval '3 hours', now() - interval '3 hours', false, null);
select 'israil', coalesce(string_agg(id::text, ',' order by updated_at desc), '') from public.cluster_stem_probe(${arr(israilStems)});
select 'mutlu', coalesce(string_agg(id::text, ',' order by updated_at desc), '') from public.cluster_stem_probe(${arr(mutluStems)});
select 'since', coalesce(string_agg(id::text, ',' order by updated_at desc), '') from public.cluster_stem_probe(${arr(israilStems)}, now() - interval '7 hours');
select 'wide', count(*) from public.cluster_stem_probe(${arr(israilStems)}, now() - interval '72 hours');
select 'one', count(*) from public.cluster_stem_probe(${arr(israilStems)}, null, 1);
select 'zero', count(*) from public.cluster_stem_probe(${arr(israilStems)}, null, 0);
select 'big', count(*) from public.cluster_stem_probe(${arr(israilStems)}, null, 99);
select 'two', count(*) from public.cluster_stem_probe(${arr(["israil", "arap"])});
select 'nullarr', count(*) from public.cluster_stem_probe(null);
select 'shape', count(*) from public.cluster_stem_probe(array['Israil','ARAP','netanyahu-x']::text[]);
rollback;
`);
    const lines = out.split("\n").filter((l) => l.length > 0);
    // overlap 8 for both variants, newest (b1, 5 h) first; b6/b7 (shared 3 and 2) and the archived, merged and 30 h rows are absent
    expect(lines).toContain("israil|00000000-0000-0000-0000-0000000000b1,00000000-0000-0000-0000-0000000000b2");
    // all 3 stems needed: c2 (quoted, 3 h) and c1 (20 h); c3 shares only 'mutlu' and 'yuva'
    expect(lines).toContain("mutlu|00000000-0000-0000-0000-0000000000c2,00000000-0000-0000-0000-0000000000c1");
    // a later p_since narrows the window: b2 (9 h) drops out
    expect(lines).toContain("since|00000000-0000-0000-0000-0000000000b1");
    // an earlier p_since cannot widen it past 24 h: the 30 h row stays out
    expect(lines).toContain("wide|2");
    expect(lines).toContain("one|1");
    expect(lines).toContain("zero|1");
    expect(lines).toContain("big|2");
    expect(lines).toContain("two|0");
    expect(lines).toContain("nullarr|0");
    expect(lines).toContain("shape|0");
  });

  it("returns at most 3 rows even when more clusters qualify", () => {
    const stems = stemsOf(ISRAIL);
    const rows = Array.from(
      { length: 5 },
      (_, i) =>
        `('00000000-0000-0000-0000-0000000000d${i}', ${lit(ISRAIL)}, 1, now() - interval '${i + 1} hours', now() - interval '${i + 1} hours', false, null)`,
    ).join(",\n  ");
    const out = runPsql(`
begin;
insert into public.clusters (id, title_tr, article_count, first_published, updated_at, is_archived, merged_into)
values
  ${rows};
select 'cap', count(*) from public.cluster_stem_probe(${arr(stems)}, null, 99);
select 'newest', string_agg(id::text, ',' order by updated_at desc) from public.cluster_stem_probe(${arr(stems)}, null, 99);
rollback;
`);
    const lines = out.split("\n").filter((l) => l.length > 0);
    expect(lines).toContain("cap|3");
    expect(lines).toContain(
      "newest|00000000-0000-0000-0000-0000000000d0,00000000-0000-0000-0000-0000000000d1,00000000-0000-0000-0000-0000000000d2",
    );
  });
});
