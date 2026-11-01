import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { applyRecallVeto } from "@/lib/clusters/recall-veto";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 138 ("saved-clusters-veto").
//
// saved_clusters_v2 (124) returned c.is_blindspot, so /saved kept the amber
// "Kor nokta" pill for a story whose blindspot claim every other surface had
// withdrawn through clusters.blindspot_recall_veto (071 Jev recall + 126
// sibling headline: one column covers both). 138 is a create-or-replace of
// that one function with the SAME signature, return columns and grants; the
// only change is the is_blindspot expression, which becomes the rule
// src/lib/clusters/recall-veto.ts (applyRecallVeto) applies on the cluster
// page:   is_blindspot AND NOT coalesce(blindspot_recall_veto, false).
//
// Properties pinned here:
//   - header (signature, 7 return columns, language sql, stable, security
//     definer, set search_path = '') identical to 124's;
//   - select list = 124's with ONLY the is_blindspot expression changed;
//   - from / where / order / limit identical (p_ids[1:200], updated_at desc,
//     limit 200);
//   - exactly one revoke and one grant (anon + service_role, never
//     authenticated), no drop, no table grant, notify pgrst, ledger '138';
//   - the SQL predicate agrees with applyRecallVeto on the full truth table.
// The last block (opt-in, TAYF_PSQL) runs the real function on a throwaway
// Postgres and compares every row with applyRecallVeto.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "138_saved_clusters_veto.sql";
const MIGRATION_124 = "124_saved_clusters_v2.sql";
const DRYRUN = resolve(__dirname, "sql", "138-saved-clusters-veto-dryrun.sql");

/** The one expression 138 changes, as it must appear in the select list. */
const VETO_EXPR = "(c.is_blindspot and not coalesce(c.blindspot_recall_veto, false)) as is_blindspot";

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function functionBlock(sql: string, name: string): string {
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$[\\s\\S]*?\\$fn\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

/** Everything before `as $fn$`: signature, return shape, attributes. */
function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  if (idx === -1) throw new Error("no `as $fn$` marker");
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const norm = (s: string): string => s.replace(/\s+/g, " ").trim().toLowerCase();

/** `select <list> from ...` -> normalised select list. */
function selectList(b: string): string {
  const m = norm(b).match(/^select (.*?) from /);
  if (!m || m[1] === undefined) throw new Error("no select list");
  return m[1];
}

/** Normalised text after the select list: from / where / order / limit. */
function tail(b: string): string {
  const n = norm(b);
  const idx = n.indexOf(" from ");
  if (idx === -1) throw new Error("no from clause");
  return n.slice(idx + 1);
}

/**
 * JS rendering of the SQL predicate in the select list. SQL three-valued logic
 * only matters for the veto column (nullable boolean): coalesce(veto, false)
 * turns null into false, so the whole expression is two-valued for a NOT NULL
 * is_blindspot.
 */
function sqlIsBlindspot(isBlindspot: boolean, veto: boolean | null): boolean {
  return isBlindspot && !(veto ?? false);
}

describe("migration 138_saved_clusters_veto.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let block = "";
  let code124 = "";
  let block124 = "";

  beforeAll(() => {
    const path = resolve(REPO_ROOT, "supabase", "migrations", MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
    block = functionBlock(code, "saved_clusters_v2");
    code124 = stripComments(readFileSync(resolve(REPO_ROOT, "supabase", "migrations", MIGRATION_124), "utf8"));
    block124 = functionBlock(code124, "saved_clusters_v2");
  });

  it("sanity: comment stripping is non-vacuous (header says DEPLOY ORDER, code does not)", () => {
    expect(sql).toMatch(/DEPLOY ORDER/);
    expect(code).not.toMatch(/DEPLOY ORDER/);
  });

  it("contains the ledger insert for '138'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'138'\s*,\s*'138_saved_clusters_veto'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is a single transaction with a bounded lock wait", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
    expect(code).toMatch(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const beginAt = code.search(/^\s*begin\s*;/im);
    const commitAt = code.search(/\bcommit\s*;\s*$/i);
    const ledgerAt = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledgerAt).toBeGreaterThan(beginAt);
    expect(ledgerAt).toBeLessThan(commitAt);
  });

  it("asks PostgREST to reload its schema cache", () => {
    expect(code).toMatch(/notify\s+pgrst\s*,\s*'reload schema'\s*;/i);
  });

  it("is additive: no drop, alter, truncate, create table/policy/view/index/trigger, table or sequence grants, default privileges", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\balter\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|policy|view|index|trigger)\b/i);
    expect(code).not.toMatch(/\bon\s+(table|sequence|all\s+tables|all\s+sequences|schema)\b/i);
    expect(code).not.toMatch(/\bgrant\s+(select|insert|update|delete|truncate|maintain|usage|all)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
    // No data rewrite: the only DML is the ledger row.
    expect(code).not.toMatch(/\b(update|delete)\b/i);
    expect(code.match(/\binsert\s+into\b/gi)).toHaveLength(1);
  });

  it("creates exactly one function (saved_clusters_v2 only) and never redefines v1", () => {
    expect(code.match(/\bcreate\s+(?:or\s+replace\s+)?function\b/gi)).toHaveLength(1);
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.saved_clusters_v2\s*\(/i);
    expect(code).not.toMatch(/function\s+public\.saved_clusters\s*\(/i);
  });

  it("has exactly one revoke and one grant, the grant to anon, service_role and never authenticated", () => {
    const revokes = code.match(/\brevoke\b[^;]*;/gi) ?? [];
    const grants = code.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(revokes).toEqual(["revoke all on function public.saved_clusters_v2(uuid[]) from public, anon, authenticated;"]);
    expect(grants).toEqual(["grant execute on function public.saved_clusters_v2(uuid[]) to anon, service_role;"]);
    expect(grants[0]).not.toMatch(/authenticated/i);
  });

  it("restates the comment on the function and mentions the veto", () => {
    const m = code.match(/comment\s+on\s+function\s+public\.saved_clusters_v2\s*\(\s*uuid\[\]\s*\)\s+is\s+'[^']*'\s*;/i);
    expect(m, "comment on function").not.toBeNull();
    expect(m?.[0]).toMatch(/veto/i);
    expect(m?.[0]).toMatch(/bookmark-snapshots\.ts/);
  });

  it("keeps the 124 header: signature, return shape, language sql, stable, security definer, empty search_path", () => {
    expect(norm(header(block))).toBe(norm(header(block124)));
    const h = header(block);
    expect(h).toMatch(/function\s+public\.saved_clusters_v2\s*\(\s*p_ids\s+uuid\[\]\s*\)/i);
    expect(h).toMatch(/\blanguage\s+sql\b/i);
    expect(h).toMatch(/\bstable\b/i);
    expect(h).not.toMatch(/\b(volatile|immutable)\b/i);
    expect(h).toMatch(/\bsecurity\s+definer\b/i);
    expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
  });

  it("returns exactly the 7 columns of 124, in order", () => {
    const cols = header(block).match(/returns\s+table\s*\(([\s\S]*?)\)\s*language/i)?.[1] ?? "";
    expect(cols.split(",").map((c) => c.trim().split(/\s+/)[0])).toEqual([
      "id",
      "title_tr",
      "title_tr_neutral",
      "article_count",
      "bias_distribution",
      "updated_at",
      "is_blindspot",
    ]);
    expect(norm(header(block))).toMatch(
      /returns table \( id uuid, title_tr text, title_tr_neutral text, article_count integer, bias_distribution jsonb, updated_at timestamptz, is_blindspot boolean \)/,
    );
  });

  it("selects 124's list with ONLY the is_blindspot expression replaced by the veto rule", () => {
    const old = selectList(body(block124));
    const next = selectList(body(block));
    expect(old.endsWith(", c.is_blindspot")).toBe(true);
    expect(next).toBe(`${old.slice(0, -"c.is_blindspot".length)}${VETO_EXPR}`);
    // The other six output expressions are untouched.
    expect(next.split(", ").slice(0, 6)).toEqual(old.split(", ").slice(0, 6));
    // Sanity: the helpers are not vacuous.
    expect(old).toContain("c.bias_distribution");
    expect(next).toContain("coalesce(c.blindspot_recall_veto, false)");
  });

  it("keeps the identical from/where/order/limit (200-id truncation, newest first, 200 rows, no archived filter)", () => {
    const v1 = body(block124);
    const v2 = body(block);
    expect(tail(v2)).toBe(tail(v1));
    expect(tail(v2)).toContain("limit 200");
    expect(v2).toMatch(/coalesce\s*\(\s*p_ids\[1:200\]\s*,\s*'\{\}'::uuid\[\]\s*\)/i);
    expect(v2).toMatch(/order\s+by\s+c\.updated_at\s+desc/i);
    expect(v2).toMatch(/from\s+public\.clusters\s+c\b/i);
    expect(v2).not.toMatch(/is_archived/i);
    expect(block).not.toMatch(/\braise\b/i);
  });

  it("reads only schema-qualified relations (search_path is empty)", () => {
    const rels = Array.from(body(block).matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi), (m) => m[1]);
    expect(rels.length).toBeGreaterThan(0);
    for (const r of rels) expect(r, "unqualified relation").toMatch(/^public\./i);
  });

  it("does NOT add a feed-health gate or any other column (veto rule only)", () => {
    const b = body(block);
    expect(b).not.toMatch(/blindspot_side/i);
    expect(b).not.toMatch(/blindspot_veto_reason/i);
    expect(b).not.toMatch(/merged_into/i);
    expect(b).not.toMatch(/summary_tr/i);
    expect(b.match(/blindspot_recall_veto/gi)).toHaveLength(1);
  });

  it("header documents why, the evidence, the Step 0 facts, the dry-run, deploy order and rollback", () => {
    expect(sql).toMatch(/^-- 138_saved_clusters_veto\.sql/);
    expect(sql).toMatch(/126/);
    expect(sql).toMatch(/NOT changed here/);
    expect(sql).toMatch(/a006ab26/);
    expect(sql).toMatch(/112a68bd/);
    expect(sql).toMatch(/jev_recall/);
    expect(sql).toMatch(/sibling_headline/);
    expect(sql).toMatch(/DEPLOY ORDER: none/);
    expect(sql).toMatch(/STEP 0/);
    expect(sql).toMatch(/pg_get_functiondef/);
    expect(sql).toMatch(/proacl/);
    expect(sql).toMatch(/recall-veto\.ts/);
    expect(sql).toMatch(/applyRecallVeto/);
    expect(sql).toMatch(/Dry-run/i);
    expect(sql).toMatch(/DRYRUN 138 OK/);
    expect(sql).toMatch(/ROLLBACK/);
    expect(sql).toMatch(/124_saved_clusters_v2\.sql/);
    expect(sql).toMatch(/delete from supabase_migrations\.schema_migrations where version = '138'/);
  });

  it("ships a local PG15 dry-run script that asserts the privileges and the three-way outcome", () => {
    expect(existsSync(DRYRUN), "dry-run sql must exist").toBe(true);
    const dry = readFileSync(DRYRUN, "utf8");
    expect(dry).toMatch(/124_saved_clusters_v2\.sql/);
    expect(dry).toMatch(/138_saved_clusters_veto\.sql/);
    expect(dry.match(/138_saved_clusters_veto\.sql/g)!.length).toBeGreaterThanOrEqual(2);
    expect(dry).toMatch(/has_function_privilege/);
    expect(dry).toMatch(/set role anon/i);
    expect(dry).toMatch(/DRYRUN 138 OK/);
  });
});

// ---------------------------------------------------------------------------
// Parity truth table: the SQL expression in the select list must give what
// applyRecallVeto gives the cluster page for every is_blindspot x veto pair.
// ---------------------------------------------------------------------------

describe("migration 138: SQL predicate parity with applyRecallVeto", () => {
  let expr = "";

  beforeAll(() => {
    const code = stripComments(readFileSync(resolve(REPO_ROOT, "supabase", "migrations", MIGRATION), "utf8"));
    // Everything after the sixth output column (c.updated_at) is the seventh one.
    expr = selectList(body(functionBlock(code, "saved_clusters_v2"))).replace(/^.*?c\.updated_at, /, "");
  });

  it("the select-list expression is the one rendered by sqlIsBlindspot", () => {
    expect(expr).toBe(VETO_EXPR);
  });

  const flags = [true, false] as const;
  const vetoes = [true, false, null] as const;
  for (const isBlindspot of flags) {
    for (const veto of vetoes) {
      it(`is_blindspot=${isBlindspot}, veto=${String(veto)} matches applyRecallVeto`, () => {
        const viaTs = applyRecallVeto({
          is_blindspot: isBlindspot,
          blindspot_side: "opposition",
          blindspot_recall_veto: veto,
        }).isBlindspot;
        expect(sqlIsBlindspot(isBlindspot, veto)).toBe(viaTs);
      });
    }
  }

  it("withdraws exactly the flagged-and-vetoed case and passes everything else through", () => {
    const out = flags.flatMap((b) => vetoes.map((v) => [b, v, sqlIsBlindspot(b, v)] as const));
    expect(out.filter(([, , r]) => r).map(([b, v]) => [b, v])).toEqual([
      [true, false],
      [true, null],
    ]);
    // An unflagged row never becomes a blindspot, vetoed or not.
    expect(out.filter(([b]) => !b).every(([, , r]) => r === false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live parity (opt-in): needs a throwaway Postgres with 124 + 138 applied and
// clusters.blindspot_recall_veto present; TAYF_PSQL is the psql binary and
// PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Everything runs inside
// one transaction that is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("migration 138: public.saved_clusters_v2() (live Postgres)", () => {
  const FIXTURES: ReadonlyArray<{
    id: string;
    isBlindspot: boolean;
    veto: boolean | null;
  }> = [
    { id: "00000000-0000-4000-8000-000000001381", isBlindspot: true, veto: true },
    { id: "00000000-0000-4000-8000-000000001382", isBlindspot: true, veto: false },
    { id: "00000000-0000-4000-8000-000000001383", isBlindspot: true, veto: null },
    { id: "00000000-0000-4000-8000-000000001384", isBlindspot: false, veto: true },
    { id: "00000000-0000-4000-8000-000000001385", isBlindspot: false, veto: false },
    { id: "00000000-0000-4000-8000-000000001386", isBlindspot: false, veto: null },
  ];

  const lit = (v: boolean | null): string => (v === null ? "null" : v ? "true" : "false");

  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  it("returns, for each of 6 fixture clusters, what applyRecallVeto gives the cluster page", () => {
    const values = FIXTURES.map(
      (f, i) =>
        `('${f.id}', 'fixture ${i + 1}', 'fixture ${i + 1}', 3, '{}'::jsonb, ${lit(f.isBlindspot)}, ${
          f.isBlindspot ? "'opposition'" : "null"
        }, ${lit(f.veto)}, now() - interval '${i} minutes')`,
    ).join(",\n  ");
    const ids = FIXTURES.map((f) => `'${f.id}'`).join(", ");
    const out = runPsql(`
begin;
insert into public.clusters
  (id, title_tr, title_tr_neutral, article_count, bias_distribution, is_blindspot, blindspot_side, blindspot_recall_veto, updated_at)
values
  ${values};
select 'ROW|' || id || '|' || is_blindspot::text
  from public.saved_clusters_v2(array[${ids}]::uuid[])
 order by id;
rollback;
`)
      .split("\n")
      .filter((l) => l.startsWith("ROW|"));

    expect(out).toHaveLength(FIXTURES.length);
    const got = new Map(out.map((l) => [l.split("|")[1]!, l.split("|")[2]!]));
    for (const f of FIXTURES) {
      const expected = applyRecallVeto({
        is_blindspot: f.isBlindspot,
        blindspot_side: f.isBlindspot ? "opposition" : null,
        blindspot_recall_veto: f.veto,
      }).isBlindspot;
      expect(got.get(f.id), `is_blindspot for ${f.id} (flag=${f.isBlindspot}, veto=${String(f.veto)})`).toBe(
        expected ? "true" : "false",
      );
    }
  });

  it("left nothing behind (the fixture transaction was rolled back)", () => {
    const ids = FIXTURES.map((f) => `'${f.id}'`).join(", ");
    const out = runPsql(`select 'LEFT|' || count(*) from public.clusters where id in (${ids});`)
      .split("\n")
      .find((l) => l.startsWith("LEFT|"));
    expect(out).toBe("LEFT|0");
  });
});
