import { describe, it, expect, beforeAll, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CLUSTERS, LAVROV_FIDAN } from "../lib/admin/content-twin-fixtures";

// The page module imports the server Supabase client; this file only needs its pure exports.
vi.mock("@/lib/supabase/server", () => ({
  createServerClient: () => {
    throw new Error("not used by the migration test");
  },
}));

import { CONTENT_TWIN, CONTENT_TWIN_GENERIC_STEMS, isContentTwinCandidate, stemOverlap } from "@/lib/admin/content-twins";

// ---------------------------------------------------------------------------
// Migration 139 ("content-twin-candidates"): public.admin_content_twin_pairs(),
// the read-only first stage of the content-twin detector behind /admin/birlestir
// "Olası içerik ikizleri". Live clusters opened at most 6 hours apart whose seed
// titles share enough word stems; src/lib/admin/content-twins.ts re-scores them
// with the clustering ensemble. It reads, it never merges.
//
// Static block: the SQL contract (comments stripped first, so prose can never
// satisfy a guard) and the parity of every constant with CONTENT_TWIN and
// CONTENT_TWIN_GENERIC_STEMS. Live block (opt-in, TAYF_PSQL): the function against
// rolled-back fixtures on a throwaway Postgres, including the labelled real pairs.
// ---------------------------------------------------------------------------

const MIGRATION = resolve(__dirname, "..", "..", "supabase", "migrations", "139_content_twin_candidates.sql");
const SIG = "public.admin_content_twin_pairs(integer, integer)";

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

// Whitespace collapsed, and no padding just inside parentheses: `returns table (\n a uuid\n)` -> `returns table (a uuid)`.
const collapse = (s: string) => s.replace(/\s+/g, " ").replace(/\( /g, "(").replace(/ \)/g, ")").trim();

/** The text between the $fn$ markers of the one function in the file. */
function functionBody(code: string): string {
  const m = code.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body found");
  return m[1];
}

describe("migration 139_content_twin_candidates.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let body = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "139_content_twin_candidates.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    body = collapse(functionBody(code));
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0, code does not)", () => {
    expect(raw).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
  });

  it("documents WHY, STEP 0 prod facts, EXPLAIN numbers, two dry runs, the rollback and the no-new-index note", () => {
    expect(raw).toMatch(/WHY/);
    expect(raw).toMatch(/STEP 0/);
    expect(raw).toMatch(/schema_migrations/);
    expect(raw).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\)/);
    expect(raw).toMatch(/DRY RUNS? x2/i);
    expect(raw).toMatch(/DRYRUN 139 OK/);
    expect(raw).toMatch(/ROLLBACK/);
    expect(raw).toMatch(/drop function public\.admin_content_twin_pairs\(integer, integer\);/);
    expect(raw).toMatch(/delete from supabase_migrations\.schema_migrations where version = '139';/);
    expect(raw).toMatch(/NO NEW INDEX/);
    expect(raw).toMatch(/101\/127/);
    expect(raw).toMatch(/idx_clusters_first_published/);
  });

  it("records the threshold decision: the 4/0.6 first choice failed, 126's 3/0.5 is used", () => {
    expect(raw).toMatch(/4 \/ 0\.6/);
    expect(raw).toMatch(/126/);
    expect(raw).toMatch(/KNOWN_MISSES/);
  });

  it("never writes the word the zone-parity guard hunts for", () => {
    expect(raw).not.toMatch(/iktidar/i);
  });

  it("is one transaction and records version 139 in the ledger", () => {
    expect(code.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(code.match(/\bcommit\s*;/gi) ?? []).toHaveLength(1);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'139'\s*,\s*'139_content_twin_candidates'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is additive and re-appliable: create or replace, no table, index, column or drop DDL", () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.admin_content_twin_pairs/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view|sequence|trigger)\b/i);
    expect(code).not.toMatch(/\balter\s+(table|function|default)\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|view|trigger|policy|sequence|extension)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it("has exactly the documented signature and result columns", () => {
    expect(collapse(code)).toMatch(
      /create or replace function public\.admin_content_twin_pairs\(p_hours integer default 48, p_limit integer default 50\) returns table \(cluster_a uuid, cluster_b uuid, title_a text, title_b text, summary_a text, summary_b text, published_a timestamptz, published_b timestamptz, article_count_a integer, article_count_b integer, shared_stems integer, jaccard numeric\)/i,
    );
  });

  it("is SQL, STABLE, SECURITY DEFINER with an empty search_path", () => {
    const header = collapse(code).match(/jaccard numeric\) ([\s\S]*?) as \$fn\$/i)?.[1] ?? "";
    expect(header).toMatch(/\blanguage sql\b/i);
    expect(header).toMatch(/\bstable\b/i);
    expect(header).not.toMatch(/\b(immutable|volatile)\b/i);
    expect(header).toMatch(/\bsecurity definer\b/i);
    expect(header).toMatch(/set search_path = ''/i);
  });

  it("clamps p_hours to 1..168 and p_limit to 1..100, NULL-safe", () => {
    expect(body).toContain("least(greatest(coalesce(p_hours, 48), 1), 168)");
    expect(body).toContain("least(greatest(coalesce(p_limit, 50), 1), 100)");
    expect(body).toMatch(/limit \(select lim from p\)/i);
  });

  it("materialises the live clusters: window on first_published, not archived, not merged, 2+ articles", () => {
    expect(body).toMatch(/live as materialized \(/i);
    expect(body).toContain("c.first_published >= p.t_start");
    expect(body).toContain("c.first_published <= p.t_end");
    expect(body).toContain("not coalesce(c.is_archived, false)");
    expect(body).toContain("c.merged_into is null");
    expect(body).toContain("c.article_count >= 2");
    expect(body).not.toMatch(/created_at/);
  });

  it("orders by Jaccard desc, then the newer first_published, then the ids (deterministic)", () => {
    expect(body).toMatch(
      /order by pa\.shared::numeric \/ \(na\.n \+ nb\.n - pa\.shared\) desc, greatest\(la\.first_published, lb\.first_published\) desc, pa\.a, pa\.b/i,
    );
  });

  it("joins stems with id_b > id_a and the 6 hour window INSIDE the join, before the aggregation", () => {
    const join = body.match(/join stems sb on ([\s\S]*?) group by/i)?.[1] ?? "";
    expect(join).toContain("sb.stem = sa.stem");
    expect(join).toContain("sb.id > sa.id");
    expect(join).toMatch(/sb\.first_published between sa\.first_published - interval '6 hours' and sa\.first_published \+ interval '6 hours'/);
  });

  it("reads only: no write verb, no call into the merge or any other rpc, no dynamic SQL", () => {
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|merge)\b/i);
    expect(body).not.toMatch(/cluster_merge_atomic/i);
    expect(body).not.toMatch(/\bperform\b|\bexecute\b/i);
  });

  it("schema-qualifies every relation and function it uses (empty search_path)", () => {
    const ctes = new Set(["p", "live", "stems", "nstem", "pairs"]);
    const refs = [...body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(8);
    for (const r of refs) {
      expect(
        r.startsWith("public.") || r.startsWith("pg_catalog.") || ctes.has(r) || r === "lateral",
        `unqualified relation ${r}`,
      ).toBe(true);
    }
    expect(body).not.toMatch(/(?<![.\w])(now|count|round|left|length|regexp_split_to_table|tayf_search_fold)\s*\(/i);
    expect(body).toMatch(/public\.tayf_search_fold\(/);
  });

  it("revokes from public/anon/authenticated and grants execute to service_role only", () => {
    const flat = collapse(code);
    expect(flat).toMatch(
      /revoke all on function public\.admin_content_twin_pairs\(integer, integer\) from public, anon, authenticated;/i,
    );
    const grants = flat.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(
      /^grant execute on function public\.admin_content_twin_pairs\(integer, integer\) to service_role;$/i,
    );
    expect(flat).not.toMatch(/\bto\s+(public|anon|authenticated)\b/i);
    expect(flat).not.toMatch(/grant\s+[^;]*\bon\s+(table|sequence|all)\b/i);
    expect(flat).not.toMatch(/alter\s+default\s+privileges/i);
  });

  it("comments on the function", () => {
    expect(collapse(code)).toMatch(/comment on function public\.admin_content_twin_pairs\(integer, integer\) is /i);
  });

  it("bakes no secret into the file", () => {
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });

  describe("parity with src/lib/admin/content-twins.ts", () => {
    it("the SQL constants equal CONTENT_TWIN", () => {
      const sig = collapse(code);
      const num = (re: RegExp, from: string = body) => Number(from.match(re)?.[1]);
      const windows = new Set([...body.matchAll(/interval '(\d+) hours'/g)].map((m) => Number(m[1])));
      expect([...windows]).toEqual([CONTENT_TWIN.windowHours]);
      expect(num(/pg_catalog\.left\(w\.word, (\d+)\)/)).toBe(CONTENT_TWIN.stemLen);
      expect(num(/pg_catalog\.length\(w\.word\) >= (\d+)/)).toBe(CONTENT_TWIN.tokenMinLen);
      expect(num(/having pg_catalog\.count\(\*\) >= (\d+)/i)).toBe(CONTENT_TWIN.minSharedStems);
      expect(num(/- pa\.shared\) >= ([0-9.]+)/)).toBe(CONTENT_TWIN.minJaccard);
      expect(num(/p_hours integer default (\d+)/, sig)).toBe(CONTENT_TWIN.defaultHours);
      expect(num(/p_limit integer default (\d+)/, sig)).toBe(CONTENT_TWIN.defaultLimit);
      expect(num(/coalesce\(p_hours, (\d+)\)/)).toBe(CONTENT_TWIN.defaultHours);
      expect(num(/coalesce\(p_limit, (\d+)\)/)).toBe(CONTENT_TWIN.defaultLimit);
      expect(num(/coalesce\(p_hours, \d+\), 1\), (\d+)\)/)).toBe(CONTENT_TWIN.maxHours);
      expect(num(/coalesce\(p_limit, \d+\), 1\), (\d+)\)/)).toBe(CONTENT_TWIN.maxLimit);
      expect(num(/pg_catalog\.left\(c\.summary_tr, (\d+)\)/)).toBe(600);
    });

    it("the generic-stem array equals CONTENT_TWIN_GENERIC_STEMS, in order", () => {
      const arr = body.match(/array\[([^\]]*)\]::text\[\]/)?.[1] ?? "";
      const items = [...arr.matchAll(/'([a-z0-9]+)'/g)].map((m) => m[1]);
      expect(items.length).toBeGreaterThan(0);
      expect(items.length).toBeLessThanOrEqual(25);
      expect(items).toEqual([...CONTENT_TWIN_GENERIC_STEMS]);
    });

    it("the lengths of the generic stems fit the stem rule (4..5 characters, ASCII)", () => {
      for (const s of CONTENT_TWIN_GENERIC_STEMS) {
        expect(s).toMatch(new RegExp(`^[a-z0-9]{${CONTENT_TWIN.tokenMinLen},${CONTENT_TWIN.stemLen}}$`));
      }
    });
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): rolled-back fixtures on a throwaway Postgres.
// TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server; migration 139 (and tayf_search_fold, 129) must already be applied.
// Every scenario is its own BEGIN ... ROLLBACK script.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("139 admin_content_twin_pairs against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const lines = (out: string) => out.split("\n").filter((l) => l.length > 0);

  interface Cl {
    n: number;
    title: string;
    summary?: string;
    /** seconds before now() the cluster was first published (can be negative: the future) */
    ago: number;
    count?: number;
    archived?: boolean;
    mergedInto?: number;
  }

  /** A rolled-back script: the fixtures, then `query`, then rollback. */
  function script(cl: Cl[], query: string): string {
    const values = cl
      .map(
        (c) =>
          `('${U(c.n)}', ${lit(c.title)}, ${lit(c.summary ?? "")}, now() - interval '${c.ago} seconds', ${c.count ?? 3}, ${c.archived ? "true" : "false"})`,
      )
      .join(",\n  ");
    const merged = cl
      .filter((c) => c.mergedInto !== undefined)
      .map((c) => `update public.clusters set merged_into = '${U(c.mergedInto as number)}' where id = '${U(c.n)}';`)
      .join("\n");
    return `
begin;
insert into public.clusters (id, title_tr, summary_tr, first_published, article_count, is_archived) values
  ${values};
${merged}
${query}
rollback;
`;
  }

  const FX = `cluster_a::text like '00000000-0000-4000-8000-%'`;
  const PAIRS = (args = "168, 100") =>
    `select cluster_a, cluster_b, shared_stems from public.admin_content_twin_pairs(${args}) where ${FX} order by jaccard desc, greatest(published_a, published_b) desc, cluster_a, cluster_b;`;

  // The function's OWN order (no outer ORDER BY, which would mask it).
  const RAW = (args = "168, 100") =>
    `select cluster_a, cluster_b, shared_stems from public.admin_content_twin_pairs(${args}) where ${FX};`;

  const T = "Zelenski İstanbul'a geldi, Erdoğan ile görüşecek";

  it("the target database has the function (migration 139 applied)", () => {
    expect(
      runPsql(`select to_regprocedure('${SIG}') is not null;`).trim(),
      "apply 139_content_twin_candidates.sql to the throwaway database first",
    ).toBe("t");
  });

  it("anon and authenticated cannot execute it, service_role can", () => {
    const out = runPsql(`
select has_function_privilege('anon', '${SIG}', 'execute'),
       has_function_privilege('authenticated', '${SIG}', 'execute'),
       has_function_privilege('service_role', '${SIG}', 'execute');`);
    expect(lines(out)).toEqual(["f|f|t"]);
  });

  it("two clusters with the same title, 1 hour apart: one row (a < b), shared stems counted", () => {
    const out = runPsql(
      script(
        [
          { n: 2, title: T, ago: 7200 },
          { n: 1, title: T, ago: 3600 },
        ],
        PAIRS(),
      ),
    );
    expect(lines(out)).toEqual([`${U(1)}|${U(2)}|${stemOverlap(T, T).shared}`]);
  });

  it("the window is 6 hours, inclusive: exactly 6 h is a pair, 6 h and 1 s is not", () => {
    const at = (secs: number) =>
      lines(
        runPsql(
          script(
            [
              { n: 1, title: T, ago: 3600 },
              { n: 2, title: T, ago: 3600 + secs },
            ],
            PAIRS(),
          ),
        ),
      );
    expect(at(6 * 3600)).toHaveLength(1);
    expect(at(6 * 3600 + 1)).toEqual([]);
    expect(at(7 * 3600)).toEqual([]);
  });

  it("the window is symmetric: the lower id may be the older or the newer cluster", () => {
    const at = (secs: number) =>
      lines(
        runPsql(
          script(
            [
              { n: 1, title: T, ago: 3600 + secs }, // the LOWER id is the older one
              { n: 2, title: T, ago: 3600 },
            ],
            PAIRS(),
          ),
        ),
      );
    expect(at(6 * 3600)).toHaveLength(1);
    expect(at(6 * 3600 + 1)).toEqual([]);
  });

  it("needs at least the minimum shared stems, whatever the Jaccard", () => {
    const min = CONTENT_TWIN.minSharedStems;
    const words = (n: number) => Array.from({ length: n }, (_, i) => `sh${String.fromCharCode(97 + i)}ar`).join(" ");
    const one = (n: number) =>
      lines(
        runPsql(
          script(
            [
              { n: 1, title: words(n), ago: 3600 },
              { n: 2, title: words(n), ago: 3500 },
            ],
            PAIRS(),
          ),
        ),
      ).length;
    expect(one(min - 1), `${min - 1} shared stems, Jaccard 1`).toBe(0);
    expect(one(min)).toBe(1);
    expect(one(min + 1)).toBe(1);
  });

  it("needs the minimum Jaccard: exactly on it is a pair, one stem under it is not", () => {
    const min = CONTENT_TWIN.minSharedStems;
    const unionOk = Math.floor(min / CONTENT_TWIN.minJaccard); // largest union that still passes
    const shared = Array.from({ length: min }, (_, i) => `sh${String.fromCharCode(97 + i)}ar`);
    const extra = (n: number) => Array.from({ length: n }, (_, i) => `ex${String.fromCharCode(97 + i)}tr`);
    const pair = (union: number) =>
      lines(
        runPsql(
          script(
            [
              { n: 1, title: [...shared, ...extra(union - min)].join(" "), ago: 3600 },
              { n: 2, title: shared.join(" "), ago: 3500 },
            ],
            PAIRS(),
          ),
        ),
      ).length;
    expect(pair(unionOk)).toBe(1);
    expect(pair(unionOk + 1)).toBe(0);
  });

  it("every generic stem is excluded: a pair that would reach the minimum only through one is not a pair", () => {
    const min = CONTENT_TWIN.minSharedStems;
    const cl: Cl[] = CONTENT_TWIN_GENERIC_STEMS.flatMap((g, i) => {
      const own = Array.from({ length: min - 1 }, (_, k) => `u${String(i).padStart(2, "0")}${String.fromCharCode(97 + k)}x`);
      return [
        { n: 100 + i * 2, title: [g, ...own].join(" "), ago: 3600 },
        { n: 101 + i * 2, title: [g, ...own].join(" "), ago: 3500 },
      ];
    });
    expect(lines(runPsql(script(cl, PAIRS("48, 100"))))).toEqual([]);
  });

  it("breaks a full tie by the ids, ascending", () => {
    const out = runPsql(
      script(
        [
          { n: 3, title: "alpha bravo charlie delta", ago: 3600 },
          { n: 4, title: "alpha bravo charlie delta", ago: 3600 },
          { n: 1, title: "kilo lima mike november", ago: 3600 },
          { n: 2, title: "kilo lima mike november", ago: 3600 },
        ],
        RAW(),
      ),
    );
    expect(lines(out)).toEqual([`${U(1)}|${U(2)}|4`, `${U(3)}|${U(4)}|4`]);
  });

  it("archived, merged_into, single-article and future clusters are excluded", () => {
    const base: Cl = { n: 1, title: T, ago: 3600 };
    const withOther = (over: Partial<Cl>) => lines(runPsql(script([base, { n: 2, title: T, ago: 3000, ...over }], PAIRS())));
    expect(withOther({})).toHaveLength(1);
    expect(withOther({ archived: true })).toEqual([]);
    expect(withOther({ mergedInto: 1 })).toEqual([]);
    expect(withOther({ count: 1 })).toEqual([]);
    expect(withOther({ ago: -60 })).toEqual([]);
  });

  it("p_hours narrows and widens the window; 0 and NULL clamp to 1 and 48; 999 clamps to 168", () => {
    const hours = (h: number) => [
      { n: 1, title: T, ago: h * 3600 },
      { n: 2, title: T, ago: h * 3600 + 60 },
    ];
    const n = (h: number, arg: string) => lines(runPsql(script(hours(h), PAIRS(`${arg}, 100`)))).length;
    expect(n(30, "48")).toBe(1);
    expect(n(30, "1")).toBe(0);
    expect(n(30, "0")).toBe(0);
    expect(n(30, "-5")).toBe(0);
    expect(n(30, "null")).toBe(1);
    expect(n(60, "null")).toBe(0);
    expect(n(60, "168")).toBe(1);
    expect(n(167, "999")).toBe(1);
    expect(n(169, "999")).toBe(0);
  });

  it("p_limit is clamped to 1..100 and NULL means 50", () => {
    const many: Cl[] = Array.from({ length: 15 }, (_, i) => ({ n: 10 + i, title: T, ago: 3600 + i }));
    const n = (arg: string) => lines(runPsql(script(many, PAIRS(`48, ${arg}`)))).length;
    expect(n("1000")).toBe(100); // 15 identical clusters = 105 pairs
    expect(n("100")).toBe(100);
    expect(n("0")).toBe(1);
    expect(n("-3")).toBe(1);
    expect(n("7")).toBe(7);
    expect(n("null")).toBe(50);
  });

  it("the limit keeps the best pairs: highest Jaccard first, then the newest", () => {
    const cl: Cl[] = [
      { n: 1, title: "oscar papa quebec romeo", ago: 100 }, // 3 of 5 = 0.6, the newest
      { n: 2, title: "oscar papa quebec sierra", ago: 200 },
      { n: 3, title: "alpha bravo charlie delta", ago: 20000 }, // identical, older
      { n: 4, title: "alpha bravo charlie delta", ago: 20100 },
    ];
    expect(lines(runPsql(script(cl, RAW("48, 1"))))).toEqual([`${U(3)}|${U(4)}|4`]);
    expect(lines(runPsql(script(cl, RAW("48, 2"))))).toEqual([`${U(3)}|${U(4)}|4`, `${U(1)}|${U(2)}|3`]);
  });

  it("orders by Jaccard desc, then the newer pair, then the ids", () => {
    const out = runPsql(
      script(
        [
          // (1,2): identical, Jaccard 1, older
          { n: 1, title: "alpha bravo charlie delta", ago: 20000 },
          { n: 2, title: "alpha bravo charlie delta", ago: 20100 },
          // (3,4): identical, Jaccard 1, newer
          { n: 3, title: "kilo lima mike november", ago: 1000 },
          { n: 4, title: "kilo lima mike november", ago: 1100 },
          // (5,6): 3 shared of 5 -> Jaccard 0.6, newest of all
          { n: 5, title: "oscar papa quebec romeo", ago: 100 },
          { n: 6, title: "oscar papa quebec sierra", ago: 200 },
        ],
        RAW(),
      ),
    );
    expect(lines(out)).toEqual([`${U(3)}|${U(4)}|4`, `${U(1)}|${U(2)}|4`, `${U(5)}|${U(6)}|3`]);
  });

  it("title stems fold Turkish letters and case (İ, ı, ş) like tayf_search_fold", () => {
    const out = runPsql(
      script(
        [
          { n: 1, title: "İSTANBUL BELEDİYESİ ŞİŞLİ SORUŞTURMASI", ago: 3600 },
          { n: 2, title: "istanbul belediyesi sisli sorusturmasi", ago: 3500 },
        ],
        PAIRS(),
      ),
    );
    expect(lines(out)).toEqual([`${U(1)}|${U(2)}|4`]);
  });

  it("generic stems never count: a pair whose shared words are all generic is not a pair", () => {
    const g = CONTENT_TWIN_GENERIC_STEMS.slice(0, 8).join(" ");
    const out = runPsql(
      script(
        [
          { n: 1, title: g, ago: 3600 },
          { n: 2, title: g, ago: 3500 },
        ],
        PAIRS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("returns the summaries cut to 600 characters, the titles, the counts and the Jaccard", () => {
    const out = runPsql(
      script(
        [
          { n: 1, title: T, summary: "x".repeat(1000), ago: 3600, count: 4 },
          { n: 2, title: T, summary: "kısa", ago: 3000, count: 9 },
        ],
        `select length(summary_a), summary_b, article_count_a, article_count_b, jaccard from public.admin_content_twin_pairs(48, 10) where ${FX};`,
      ),
    );
    expect(lines(out)).toEqual(["600|kısa|4|9|1.0000"]);
  });

  it("an empty clusters window returns no rows and does not error", () => {
    expect(lines(runPsql(`select count(*) from public.admin_content_twin_pairs(48, 10) where ${FX};`))).toEqual(["0"]);
  });

  it("the labelled production pairs: the SQL candidates are exactly what isContentTwinCandidate says", () => {
    const items = [
      ...Object.values(CLUSTERS).map((c) => ({ title: c.title, summary: c.summary, at: Date.parse(c.firstPublished), count: c.articleCount })),
      { title: LAVROV_FIDAN.lavrov.title, summary: LAVROV_FIDAN.lavrov.summary, at: Date.parse(LAVROV_FIDAN.lavrov.publishedAt), count: 3 },
      { title: LAVROV_FIDAN.fidan.title, summary: LAVROV_FIDAN.fidan.summary, at: Date.parse(LAVROV_FIDAN.fidan.publishedAt), count: 3 },
      {
        title: "Bakırköy Belediyesi soruşturmasında 40 tutuklama talebi",
        summary: "",
        at: Date.parse("2026-10-30T17:02:50Z"),
        count: 3,
      },
      {
        title: "Bakırköy Belediyesi soruşturması: 39 kişi tutuklandı",
        summary: "",
        at: Date.parse("2026-10-30T18:02:50Z"),
        count: 3,
      },
    ];
    // Keep the real gaps between the clusters, shifted so the newest one opened an hour ago and
    // the oldest ~ 2 days ago at most (the fixtures span Oct 30 17:00 to Nov 1 09:47 = 41 hours).
    const newest = Math.max(...items.map((i) => i.at));
    const cl: Cl[] = items.map((i, idx) => ({
      n: 500 + idx,
      title: i.title,
      summary: i.summary,
      ago: Math.round((newest - i.at) / 1000) + 3600,
      count: i.count,
    }));
    const out = lines(runPsql(script(cl, PAIRS("168, 100"))));

    const expected: string[] = [];
    for (let i = 0; i < cl.length; i++) {
      for (let j = i + 1; j < cl.length; j++) {
        const x = cl[i] as Cl;
        const y = cl[j] as Cl;
        const [a, b] = U(x.n) < U(y.n) ? [x, y] : [y, x];
        const hours = Math.abs(x.ago - y.ago) / 3600;
        if (isContentTwinCandidate(a.title, b.title, hours)) {
          expected.push(`${U(a.n)}|${U(b.n)}|${stemOverlap(a.title, b.title).shared}`);
        }
      }
    }
    expect(expected.length, "the fixtures must contain at least one candidate pair").toBeGreaterThan(0);
    expect([...out].sort()).toEqual([...expected].sort());
  });
});
