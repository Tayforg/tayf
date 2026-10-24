import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Migration 120 ("twin-cluster-pairs"): public.admin_twin_cluster_pairs(), the
// read-only list behind /admin/birlestir "Olası ikiz kümeler". A twin is two
// article rows of one source with the same source_article_key (migration 113)
// that clustering put in two different clusters; the function returns the
// cluster pairs, newest first. It reads, it never merges: the merge stays an
// admin click on the existing cluster_merge_atomic flow.
//
// Static block: the SQL contract (comments stripped first, so prose can never
// satisfy a guard). Live block (opt-in, TAYF_PSQL): the function against
// rolled-back fixtures on a throwaway Postgres with 113 applied or its column
// added by hand.
// ---------------------------------------------------------------------------

const MIGRATIONS_DIR = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS_DIR, "120_twin_cluster_pairs.sql");
const TRIGGER_MIGRATION = resolve(MIGRATIONS_DIR, "025_worker_triggers.sql");

const SIG = "public.admin_twin_cluster_pairs(integer, integer)";

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The text between the $fn$ markers of the one function in the file. */
function functionBody(code: string): string {
  const m = code.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body found");
  return m[1];
}

/** Sorted category list out of `... category in ('a', 'b') ...` / `any (array[...])`. */
function categoryList(sql: string): string[] {
  const m = sql.match(/category\s+in\s*\(([^)]*)\)/i);
  if (!m || m[1] === undefined) throw new Error("no category list found");
  return [...m[1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1] as string).sort();
}

describe("migration 120_twin_cluster_pairs.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let body = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "120_twin_cluster_pairs.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    body = collapse(functionBody(code));
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0, code does not)", () => {
    expect(raw).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
  });

  it("documents WHY, STEP 0 evidence, two dry runs and the rollback in the header", () => {
    expect(raw).toMatch(/WHY/);
    expect(raw).toMatch(/STEP 0/);
    expect(raw).toMatch(/schema_migrations/);
    expect(raw).toMatch(/EXPLAIN \(ANALYZE, BUFFERS\)/);
    expect(raw).toMatch(/source_article_key/);
    expect(raw).toMatch(/DRY RUN/);
    expect(raw).toMatch(/ROLLBACK/);
    expect(raw).toMatch(/drop function public\.admin_twin_cluster_pairs\(integer, integer\);/);
    expect(raw).toMatch(/delete from supabase_migrations\.schema_migrations where version = '120';/);
  });

  it("never writes the word the zone-parity guard hunts for", () => {
    expect(raw).not.toMatch(/iktidar/i);
  });

  it("is one transaction and records version 120 in the ledger", () => {
    expect(code.match(/^\s*begin\s*;/gim) ?? []).toHaveLength(1);
    expect(code.match(/\bcommit\s*;/gi) ?? []).toHaveLength(1);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'120'\s*,\s*'120_twin_cluster_pairs'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is additive and re-appliable: create or replace, no drop/alter/create table or index", () => {
    expect(code).toMatch(/create\s+or\s+replace\s+function\s+public\.admin_twin_cluster_pairs/i);
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view|sequence|trigger)\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|view|trigger|policy|sequence|extension)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
  });

  it("has exactly the documented signature and result columns", () => {
    expect(collapse(code)).toMatch(
      /create or replace function public\.admin_twin_cluster_pairs\(p_days integer default 14, p_limit integer default 50\) returns table \(cluster_a uuid, cluster_b uuid, twin_count integer, source_slugs text\[\], newest_at timestamptz\)/i,
    );
  });

  it("is SQL, STABLE, SECURITY DEFINER with an empty search_path", () => {
    const header = collapse(code).match(/returns table \([^)]*\) ([\s\S]*?) as \$fn\$/i)?.[1] ?? "";
    expect(header).toMatch(/\blanguage sql\b/i);
    expect(header).toMatch(/\bstable\b/i);
    expect(header).not.toMatch(/\b(immutable|volatile)\b/i);
    expect(header).toMatch(/\bsecurity definer\b/i);
    expect(header).toMatch(/set search_path = ''/i);
  });

  it("clamps p_days to 1..14 and p_limit to 1..50, NULL-safe", () => {
    expect(body).toContain("least(greatest(coalesce(p_days, 14), 1), 14)");
    expect(body).toContain("least(greatest(coalesce(p_limit, 50), 1), 50)");
    expect(body).toMatch(/limit \(select lim from p\)/i);
  });

  it("orders newest first, then by the cluster ids (deterministic)", () => {
    expect(body).toMatch(/order by pg_catalog\.max\(x\.at\) desc, x\.ca, x\.cb/i);
  });

  it("returns only live clusters: not archived and not merged on both sides", () => {
    for (const k of ["k1", "k2"]) {
      expect(body).toContain(`not coalesce(${k}.is_archived, false) and ${k}.merged_into is null`);
    }
  });

  it("reads only: no write verb, no call into the merge or any other rpc", () => {
    expect(body).not.toMatch(/\b(insert|update|delete|truncate|merge)\b/i);
    expect(body).not.toMatch(/cluster_merge_atomic/i);
    expect(body).not.toMatch(/\bperform\b|\bexecute\b/i);
  });

  it("schema-qualifies every relation it reads (empty search_path)", () => {
    const ctes = new Set(["p", "dup", "pairs"]);
    const refs = [...body.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(5);
    for (const r of refs) {
      expect(r.startsWith("public.") || ctes.has(r), `unqualified relation ${r}`).toBe(true);
    }
    expect(body).not.toMatch(/(?<![.\w])(now|count|max|array_agg)\s*\(/i);
  });

  it("limits the scan to the categories the cluster trigger enqueues (parity with 025)", () => {
    const trigger = stripComments(readFileSync(TRIGGER_MIGRATION, "utf8")).match(
      /create trigger articles_cluster_enqueue[\s\S]*?when\s*\(([^;]*?)\)\s*execute/i,
    )?.[1];
    expect(trigger, "trigger WHEN clause found in 025").toBeTruthy();
    expect(categoryList(body)).toEqual(categoryList(trigger as string));
    expect(categoryList(body)).toEqual(["politika", "son_dakika"]);
  });

  it("revokes from public/anon/authenticated and grants execute to service_role only", () => {
    const flat = collapse(code);
    expect(flat).toMatch(
      /revoke all on function public\.admin_twin_cluster_pairs\(integer, integer\) from public, anon, authenticated;/i,
    );
    const grants = flat.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(
      /^grant execute on function public\.admin_twin_cluster_pairs\(integer, integer\) to service_role;$/i,
    );
    expect(flat).not.toMatch(/\bto\s+(public|anon|authenticated)\b/i);
    expect(flat).not.toMatch(/grant\s+[^;]*\bon\s+(table|sequence|all)\b/i);
    expect(flat).not.toMatch(/alter\s+default\s+privileges/i);
  });

  it("comments on the function", () => {
    expect(collapse(code)).toMatch(/comment on function public\.admin_twin_cluster_pairs\(integer, integer\) is /i);
  });

  it("bakes no secret into the file", () => {
    expect(raw).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{20,}/);
  });
});

// ---------------------------------------------------------------------------
// Live behaviour (opt-in): rolled-back fixtures on a throwaway Postgres.
// TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the
// server; migration 120 must already be applied. Every scenario is its own
// BEGIN ... ROLLBACK script.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))("120 admin_twin_cluster_pairs against fixtures (live Postgres)", () => {
  function runPsql(input: string): string {
    return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
      input,
      encoding: "utf8",
      env: { ...process.env, PGCLIENTENCODING: "UTF8" },
      maxBuffer: 8 * 1024 * 1024,
    });
  }

  const hasColumn = (table: string, column: string) =>
    runPsql(
      `select exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = '${table}' and column_name = '${column}');`,
    ).trim() === "t";

  const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
  const SLUG_A = "fx-tw-a";
  const SLUG_B = "fx-tw-b";

  interface Cl {
    n: number;
    archived?: boolean;
    mergedInto?: number;
  }
  interface Ar {
    n: number;
    src?: "a" | "b";
    key: string | null;
    ago: string; // postgres interval text, e.g. '2 hours'
    cluster?: number; // cluster number (Cl.n) the article is a member of
    category?: string;
  }

  /** Builds a rolled-back script: fixtures, then `query`, then rollback. */
  function script(cl: Cl[], ar: Ar[], query: string, opts: { extraSql?: string } = {}): string {
    const fullClusters = hasColumn("clusters", "summary_tr");
    const withHash = hasColumn("articles", "content_hash");
    const clusterCols = fullClusters
      ? "id, title_tr, title_en, summary_tr, summary_en, first_published, is_archived"
      : "id, title_tr, is_archived";
    const clusterVals = (c: Cl) =>
      fullClusters
        ? `'${U(c.n)}', 'fx k${c.n}', 'fx k${c.n}', 'fx', 'fx', now(), ${c.archived ? "true" : "false"}`
        : `'${U(c.n)}', 'fx k${c.n}', ${c.archived ? "true" : "false"}`;
    const merged = cl
      .filter((c) => c.mergedInto !== undefined)
      .map((c) => `update public.clusters set merged_into = '${U(c.mergedInto as number)}' where id = '${U(c.n)}';`)
      .join("\n");
    const arts = ar
      .map((a) => {
        const url = `https://fx.invalid/twin/${a.n}`;
        const hash = withHash ? `, md5('${url}')` : "";
        return `('${U(1000 + a.n)}', (select id from public.sources where slug = '${a.src === "b" ? SLUG_B : SLUG_A}'), 'fx a${a.n}', '${url}', '${a.category ?? "politika"}', now() - interval '${a.ago}', now() - interval '${a.ago}', ${a.key === null ? "null" : `'${a.key}'`}${hash})`;
      })
      .join(",\n  ");
    const members = ar
      .filter((a) => a.cluster !== undefined)
      .map((a) => `('${U(a.cluster as number)}', '${U(1000 + a.n)}')`)
      .join(", ");
    return `
begin;
insert into public.sources (name, slug, url, rss_url, bias, kind, active) values
  ('fx a', '${SLUG_A}', 'https://fx-a.invalid', 'https://fx-a.invalid/rss', 'center', 'outlet', true),
  ('fx b', '${SLUG_B}', 'https://fx-b.invalid', 'https://fx-b.invalid/rss', 'center', 'outlet', true);
${cl.length > 0 ? `insert into public.clusters (${clusterCols}) values\n  ${cl.map((c) => `(${clusterVals(c)})`).join(",\n  ")};` : ""}
${merged}
${ar.length > 0 ? `insert into public.articles (id, source_id, title, url, category, published_at, created_at, source_article_key${withHash ? ", content_hash" : ""}) values\n  ${arts};` : ""}
${members ? `insert into public.cluster_articles (cluster_id, article_id) values ${members};` : ""}
${opts.extraSql ?? ""}
${query}
rollback;
`;
  }

  const FX_ONLY = `where f.source_slugs && array['${SLUG_A}', '${SLUG_B}']::text[]`;
  const ROWS = (args = "14, 50") =>
    `select f.cluster_a, f.cluster_b, f.twin_count, f.source_slugs from public.admin_twin_cluster_pairs(${args}) f ${FX_ONLY} order by f.newest_at desc, f.cluster_a, f.cluster_b;`;
  const lines = (out: string) => out.split("\n").filter((l) => l.length > 0);

  it("the target database has the function (migration 120 applied)", () => {
    expect(
      runPsql(`select to_regprocedure('${SIG}') is not null;`).trim(),
      "apply 120_twin_cluster_pairs.sql to the throwaway database first",
    ).toBe("t");
  });

  it("a keyed pair split over clusters X and Y gives one row: twin_count 1, source_slugs {slug}", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, key: "4000001", ago: "3 hours", cluster: 1 },
          { n: 2, key: "4000001", ago: "2 hours", cluster: 2 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([`${U(1)}|${U(2)}|1|{${SLUG_A}}`]);
  });

  it("returns the pair as (least, greatest) whichever article is in which cluster", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, key: "4000002", ago: "3 hours", cluster: 2 },
          { n: 2, key: "4000002", ago: "2 hours", cluster: 1 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([`${U(1)}|${U(2)}|1|{${SLUG_A}}`]);
  });

  it("two shared keys give twin_count 2 and the sorted distinct slugs", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, key: "4000011", ago: "5 hours", cluster: 1 },
          { n: 2, key: "4000011", ago: "4 hours", cluster: 2 },
          { n: 3, src: "b", key: "4000012", ago: "3 hours", cluster: 1 },
          { n: 4, src: "b", key: "4000012", ago: "2 hours", cluster: 2 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([`${U(1)}|${U(2)}|2|{${SLUG_A},${SLUG_B}}`]);
  });

  it("two twin rows in the same cluster give no row", () => {
    const out = runPsql(
      script(
        [{ n: 1 }],
        [
          { n: 1, key: "4000021", ago: "3 hours", cluster: 1 },
          { n: 2, key: "4000021", ago: "2 hours", cluster: 1 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("an archived cluster on either side gives no row", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2, archived: true }, { n: 3 }],
        [
          { n: 1, key: "4000031", ago: "3 hours", cluster: 1 },
          { n: 2, key: "4000031", ago: "2 hours", cluster: 2 },
          { n: 3, key: "4000032", ago: "3 hours", cluster: 2 },
          { n: 4, key: "4000032", ago: "2 hours", cluster: 3 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("a merged cluster (merged_into set) on either side gives no row", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2, mergedInto: 1 }],
        [
          { n: 1, key: "4000041", ago: "3 hours", cluster: 1 },
          { n: 2, key: "4000041", ago: "2 hours", cluster: 2 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("twins created 15 days ago give no row, even when the caller asks for 999 days", () => {
    const fixtures: [Cl[], Ar[]] = [
      [{ n: 1 }, { n: 2 }],
      [
        { n: 1, key: "4000051", ago: "15 days", cluster: 1 },
        { n: 2, key: "4000051", ago: "15 days", cluster: 2 },
      ],
    ];
    expect(lines(runPsql(script(...fixtures, ROWS("14, 50"))))).toEqual([]);
    expect(lines(runPsql(script(...fixtures, ROWS("999, 50"))))).toEqual([]);
  });

  it("p_days narrows the window (1 day) and a 13-day-old pair is inside the default one", () => {
    const fixtures: [Cl[], Ar[]] = [
      [{ n: 1 }, { n: 2 }],
      [
        { n: 1, key: "4000061", ago: "13 days", cluster: 1 },
        { n: 2, key: "4000061", ago: "13 days", cluster: 2 },
      ],
    ];
    expect(lines(runPsql(script(...fixtures, ROWS("14, 50"))))).toHaveLength(1);
    expect(lines(runPsql(script(...fixtures, ROWS("1, 50"))))).toEqual([]);
    // 0 and NULL clamp to 1 and to the 14 day default
    expect(lines(runPsql(script(...fixtures, ROWS("0, 50"))))).toEqual([]);
    expect(lines(runPsql(script(...fixtures, ROWS("null, 50"))))).toHaveLength(1);
  });

  it("the same key at two different sources is not a twin", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, src: "a", key: "4000071", ago: "3 hours", cluster: 1 },
          { n: 2, src: "b", key: "4000071", ago: "2 hours", cluster: 2 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("rows without a key, or with different keys, are not twins", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, key: null, ago: "3 hours", cluster: 1 },
          { n: 2, key: null, ago: "2 hours", cluster: 2 },
          { n: 3, key: "4000081", ago: "3 hours", cluster: 1 },
          { n: 4, key: "4000082", ago: "2 hours", cluster: 2 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("ignores categories the cluster trigger never enqueues", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, key: "4000091", ago: "3 hours", cluster: 1, category: "spor" },
          { n: 2, key: "4000091", ago: "2 hours", cluster: 2, category: "spor" },
        ],
        ROWS(),
      ),
    );
    expect(lines(out)).toEqual([]);
  });

  it("orders newest first", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }],
        [
          { n: 1, key: "4000101", ago: "30 hours", cluster: 1 },
          { n: 2, key: "4000101", ago: "29 hours", cluster: 2 },
          { n: 3, key: "4000102", ago: "3 hours", cluster: 3 },
          { n: 4, key: "4000102", ago: "2 hours", cluster: 4 },
          { n: 5, key: "4000103", ago: "10 hours", cluster: 5 },
          { n: 6, key: "4000103", ago: "9 hours", cluster: 6 },
        ],
        ROWS(),
      ),
    );
    expect(lines(out).map((l) => l.split("|").slice(0, 2).join("|"))).toEqual([
      `${U(3)}|${U(4)}`,
      `${U(5)}|${U(6)}`,
      `${U(1)}|${U(2)}`,
    ]);
  });

  it("p_limit 999 is clamped to 50; 0 and 3 clamp and cut as documented", () => {
    const clusters: Cl[] = Array.from({ length: 120 }, (_, i) => ({ n: i + 1 }));
    const articles: Ar[] = Array.from({ length: 60 }, (_, i) => i).flatMap((i) => [
      { n: 2 * i + 1, key: `${5000000 + i}`, ago: `${i + 1} minutes`, cluster: 2 * i + 1 },
      { n: 2 * i + 2, key: `${5000000 + i}`, ago: `${i} minutes`, cluster: 2 * i + 2 },
    ]);
    const count = (args: string) =>
      Number(runPsql(script(clusters, articles, `select count(*) from public.admin_twin_cluster_pairs(${args});`)).trim());
    expect(count("14, 999")).toBe(50);
    expect(count("14, 50")).toBe(50);
    expect(count("14, 3")).toBe(3);
    expect(count("14, 0")).toBe(1);
    expect(count("14, null")).toBe(50);
    // the cut keeps the newest pair
    const first = runPsql(
      script(clusters, articles, `select cluster_a, cluster_b from public.admin_twin_cluster_pairs(14, 1);`),
    ).trim();
    expect(first).toBe(`${U(1)}|${U(2)}`);
  });

  it("is read-only: calling it changes no cluster, membership or article count", () => {
    const out = runPsql(
      script(
        [{ n: 1 }, { n: 2 }],
        [
          { n: 1, key: "4000111", ago: "3 hours", cluster: 1 },
          { n: 2, key: "4000111", ago: "2 hours", cluster: 2 },
        ],
        `select (select count(*) from public.clusters) c0, (select count(*) from public.cluster_articles) m0, (select count(*) from public.articles) a0 \\gset
select count(*) from public.admin_twin_cluster_pairs(14, 50) f ${FX_ONLY};
select (select count(*) from public.clusters) = :c0 and (select count(*) from public.cluster_articles) = :m0 and (select count(*) from public.articles) = :a0;`,
      ),
    );
    expect(lines(out)).toEqual(["1", "t"]);
  });

  it("rolled the fixtures back", () => {
    expect(runPsql(`select count(*) from public.sources where slug in ('${SLUG_A}', '${SLUG_B}');`).trim()).toBe("0");
    expect(runPsql("select count(*) from public.articles where url like 'https://fx.invalid/twin/%';").trim()).toBe("0");
  });

  it("execute is held by service_role only", () => {
    expect(
      runPsql(
        `select has_function_privilege('anon', '${SIG}', 'execute'), has_function_privilege('authenticated', '${SIG}', 'execute'), has_function_privilege('service_role', '${SIG}', 'execute');`,
      ).trim(),
    ).toBe("f|f|t");
    expect(
      runPsql(
        `select count(*) from pg_catalog.pg_proc p, pg_catalog.aclexplode(p.proacl) a where p.oid = '${SIG}'::regprocedure and a.grantee = 0;`,
      ).trim(),
    ).toBe("0");
  });

  it("is SECURITY DEFINER with an empty search_path and STABLE", () => {
    const row = runPsql(
      `select p.prosecdef, p.provolatile, coalesce(p.proconfig::text, '') from pg_catalog.pg_proc p where p.oid = '${SIG}'::regprocedure;`,
    ).trim();
    expect(row).toBe('t|s|{"search_path=\\"\\""}');
  });
});
