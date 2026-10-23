import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  ARTICLE_KEY_EXCLUDED_SLUGS,
  KEY_DATE_PREFIX_RE,
  KEY_FILE_EXT_RE,
  KEY_MAX_DIGITS,
  KEY_MIN_DIGITS,
  KEY_ROUND_RE,
  URL_PATH_RE,
  sourceArticleKey,
} from "../../supabase/functions/_shared/rss/article-key";
import { SOURCE_ARTICLE_KEY_CASES } from "../fixtures/source-article-key-cases";

// Static SQL-contract test for migration 113 (articles.source_article_key): a
// nullable text column, a partial index on (source_id, source_article_key),
// the SQL twin of supabase/functions/_shared/rss/article-key.ts
// (public.source_article_key) and a bounded operator backfill function.
// Comments are stripped before every code assertion so prose can never
// satisfy a guard (same style as 107's test). The last block (opt-in,
// TAYF_PSQL) runs the shared truth table and the backfill through a real
// Postgres.

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "113_source_article_key.sql",
);

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

interface FnBlock {
  args: string;
  returns: string;
  immutable: boolean;
  body: string;
}

// Parses every `create or replace function public.<name>(...) returns <t>
// language plpgsql [immutable] security definer set search_path = '' as $fn$
// ... $fn$`. A function that deviates from that header shape is simply not
// found, which fails the tests below.
function parseFunctions(code: string): Record<string, FnBlock> {
  const out: Record<string, FnBlock> = {};
  const re =
    /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\s+(\w+)\s+language\s+plpgsql\s+(immutable\s+)?security\s+definer\s+set\s+search_path\s*=\s*''\s+as\s+\$fn\$([\s\S]*?)\$fn\$/gi;
  for (const m of code.matchAll(re)) {
    out[m[1]!] = {
      args: m[2]!,
      returns: m[3]!,
      immutable: Boolean(m[4]),
      body: m[5]!,
    };
  }
  return out;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
// A JS regex `.source` escapes `/`; the SQL literal does not.
const unescapeSlash = (s: string) => s.replace(/\\\//g, "/");

describe("migration 113_source_article_key.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Record<string, FnBlock> = {};

  beforeAll(() => {
    expect(existsSync(MIGRATION), "113_source_article_key.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0, code does not)", () => {
    expect(raw).toMatch(/STEP 0/);
    expect(code).not.toMatch(/STEP 0/);
  });

  // ---- header ---------------------------------------------------------------

  it("records the evidence and the Step 0 numbers in the header", () => {
    expect(raw).toMatch(/1fe98b20/);
    expect(raw).toMatch(/8f291028/);
    expect(raw).toMatch(/23 of 104/);
    expect(raw).toMatch(/STEP 0/);
    expect(raw).toMatch(/schema_migrations/);
    expect(raw).toMatch(/not tgisinternal/);
    expect(raw).toMatch(/articles_cluster_enqueue/);
    expect(raw).toMatch(/percentile_disc/);
    expect(raw).toMatch(/ARTICLE_KEY_EXCLUDED_SLUGS/);
    expect(raw).toMatch(/daily-sabah/);
    expect(raw).toMatch(/a-news/);
    expect(raw).toMatch(/30-day replay/);
  });

  it("states that the fallback index build locks reads as well as writes (ACCESS EXCLUSIVE)", () => {
    expect(raw).toMatch(/ACCESS EXCLUSIVE/);
    expect(raw).toMatch(/blocks reads/i);
    // The old, wrong description of the fallback must be gone.
    expect(raw).not.toMatch(/takes a SHARE lock that blocks writes/);
    expect(raw).not.toMatch(/blocking inserts, and nothing is recorded/);
  });

  it("documents the orchestrator pre-build, the invalid-index check and the apply order", () => {
    expect(raw).toMatch(/ORCHESTRATOR PRE-BUILD/);
    expect(raw).toMatch(/set lock_timeout = '5s'; alter table public\.articles add column if not exists source_article_key text;/);
    expect(raw).toMatch(
      /create index concurrently if not exists articles_source_article_key_idx on public\.articles \(source_id, source_article_key\) where source_article_key is not null;/,
    );
    expect(raw).toMatch(/indisvalid/);
    expect(raw).toMatch(/outside (a|any) transaction/i);
  });

  it("documents the operator backfill loop (14 12 10 8 6 4 2) and a verify SELECT", () => {
    expect(raw).toMatch(/BACKFILL/);
    expect(raw).toMatch(/for i in 14 12 10 8 6 4 2/);
    expect(raw).toMatch(/set statement_timeout = '2min'/);
    // One fixed anchor for the whole loop: windows that start at now() on each
    // call would leave a few seconds between two slices unfilled.
    expect(raw).toMatch(/T0=\$\(psql "\$DATABASE_URL" -Atc "select now\(\)"\)/);
    expect(raw).toMatch(
      /select public\.articles_source_key_backfill\('\$T0'::timestamptz - interval '\$i days', '\$T0'::timestamptz - interval '\$i days' \+ interval '2 days'\)/,
    );
    expect(raw).toMatch(/NOT inside the migration/);
    expect(raw).toMatch(/count\(source_article_key\)/);
  });

  it("documents the dry-run results and the rollback", () => {
    expect(raw).toMatch(/DRY RUN/);
    expect(raw).toMatch(/ROLLBACK/);
    expect(raw).toMatch(/drop function public\.articles_source_key_backfill\(timestamptz, timestamptz\);/);
    expect(raw).toMatch(/drop function public\.source_article_key\(text\);/);
    expect(raw).toMatch(/drop index (concurrently )?if exists articles_source_article_key_idx;/);
    expect(raw).toMatch(/redeploy/i);
    expect(raw).toMatch(/safe to re-apply/i);
  });

  it("never mentions the forbidden zone word (zone-parity guard)", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  // ---- transaction shape --------------------------------------------------------

  it("is wrapped in exactly one begin and one commit", () => {
    expect([...code.matchAll(/^\s*begin\s*;/gim)]).toHaveLength(1);
    expect([...code.matchAll(/^\s*commit\s*;/gim)]).toHaveLength(1);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("writes the ledger row as the last statement before commit", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'113'\s*,\s*'113_source_article_key'\s*\)\s*on\s+conflict\s+do\s+nothing\s*;\s*commit\s*;\s*$/i,
    );
    const ledger = code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i);
    expect(ledger).toBeGreaterThan(code.lastIndexOf("$fn$"));
    expect(ledger).toBeGreaterThan(code.search(/create\s+index\s+if\s+not\s+exists/i));
  });

  it("sets lock_timeout 5s and statement_timeout 60s locally, before any DDL", () => {
    const lock = code.search(/set\s+local\s+lock_timeout\s*=\s*'5s'\s*;/i);
    const stmt = code.search(/set\s+local\s+statement_timeout\s*=\s*'60s'\s*;/i);
    const firstDdl = code.search(/\balter\s+table\b/i);
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(stmt).toBeGreaterThanOrEqual(0);
    expect(code.search(/^\s*begin\s*;/im)).toBeLessThan(lock);
    expect(lock).toBeLessThan(firstDdl);
    expect(stmt).toBeLessThan(firstDdl);
  });

  // ---- invalid-index guard -------------------------------------------------------

  it("aborts before any DDL when a cancelled CREATE INDEX CONCURRENTLY left an invalid index", () => {
    const m = code.match(/do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i);
    expect(m, "guard block").not.toBeNull();
    const body = collapse(m![1]!);
    expect(body).toMatch(/pg_catalog\.pg_index/);
    expect(body).toMatch(/c\.relname = 'articles_source_article_key_idx'/);
    expect(body).toMatch(/i\.indisvalid = false/);
    expect(body).toMatch(/raise exception/);
    expect(body).toMatch(/drop index concurrently/);
    expect(code.search(/do\s+\$guard\$/i)).toBeLessThan(code.search(/\balter\s+table\b/i));
  });

  it("fails closed before any DDL: no index on a big articles table means the pre-build was skipped", () => {
    // `alter table ... add column if not exists` takes ACCESS EXCLUSIVE on
    // articles before it looks at the column and keeps it to commit, so the
    // non-concurrent index build that follows would block every read of
    // articles. The guard refuses that path above a size threshold.
    const m = code.match(/do\s+\$guard\$([\s\S]*?)\$guard\$\s*;/i);
    expect(m, "guard block").not.toBeNull();
    const body = collapse(m![1]!);
    expect(body).toMatch(/pg_catalog\.to_regclass\('public\.articles_source_article_key_idx'\) is null/);
    expect(body).toMatch(/pg_catalog\.pg_relation_size\('public\.articles'::regclass\)/);
    expect(body).toMatch(/> 67108864/);
    expect(body).toMatch(/PRE-BUILD/);
    expect([...body.matchAll(/raise exception/g)].length).toBeGreaterThanOrEqual(2);
    // The size check reads only the catalog: it must come before the ALTER.
    expect(code.search(/pg_relation_size/i)).toBeLessThan(code.search(/\balter\s+table\b/i));
  });

  // ---- column and index -----------------------------------------------------------

  it("adds the column nullable, text, with no default, and no other ALTER TABLE", () => {
    const alters = [...code.matchAll(/\balter\s+table\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(alters).toEqual([
      "alter table public.articles add column if not exists source_article_key text;",
    ]);
    expect(code).not.toMatch(/source_article_key\s+text\s+(not\s+null|default)/i);
    expect(code).toMatch(/comment\s+on\s+column\s+public\.articles\.source_article_key\s+is\s+'/i);
  });

  it("creates a partial, non-unique, non-concurrent index on exactly (source_id, source_article_key)", () => {
    // The guard's error message names `CREATE INDEX CONCURRENTLY`; that text is
    // a string literal, not a statement.
    const idx = [
      ...code
        .replace(/\$guard\$[\s\S]*?\$guard\$/g, "")
        .matchAll(/create\s+(unique\s+)?index\s+(concurrently\s+)?[^;]*;/gi),
    ];
    expect(idx).toHaveLength(1);
    expect(idx[0]![1], "must not be unique").toBeUndefined();
    expect(idx[0]![2], "CONCURRENTLY is illegal inside a transaction").toBeUndefined();
    expect(collapse(idx[0]![0])).toBe(
      "create index if not exists articles_source_article_key_idx on public.articles (source_id, source_article_key) where source_article_key is not null;",
    );
  });

  // ---- functions -----------------------------------------------------------------------

  it("defines exactly two functions, both SECURITY DEFINER with an empty search_path", () => {
    expect(Object.keys(fns).sort()).toEqual(["articles_source_key_backfill", "source_article_key"]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(2);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(2);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(2);
  });

  it("source_article_key(p_url text) returns text and is immutable", () => {
    const f = fns.source_article_key!;
    expect(collapse(f.args)).toBe("p_url text");
    expect(f.returns).toBe("text");
    expect(f.immutable).toBe(true);
  });

  it("articles_source_key_backfill(p_from timestamptz, p_to timestamptz) returns integer and is not immutable", () => {
    const f = fns.articles_source_key_backfill!;
    expect(collapse(f.args)).toBe("p_from timestamptz, p_to timestamptz");
    expect(f.returns).toBe("integer");
    expect(f.immutable).toBe(false);
  });

  it.each([
    ["source_article_key", "text"],
    ["articles_source_key_backfill", "timestamptz\\s*,\\s*timestamptz"],
  ])("revokes %s from public/anon/authenticated and grants service_role only", (name, sig) => {
    expect(code).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${sig}\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(
        `grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${sig}\\s*\\)\\s+to\\s+service_role\\s*;`,
        "i",
      ),
    );
  });

  it("grants only EXECUTE to service_role, never anything to anon/authenticated/public, never a write-class grant", () => {
    const grants = [...code.matchAll(/\bgrant\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(grants).toHaveLength(2);
    for (const g of grants) expect(g).toMatch(/^grant execute on function public\.\w+\([\w, ]+\) to service_role;$/);
    expect(code).not.toMatch(/grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    expect(code).not.toMatch(/grant\s+(insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
    expect(code).not.toMatch(/\bgrant\s+select\b/i);
  });

  it("creates no table and no policy, and is additive (no drop, delete or truncate)", () => {
    expect(code).not.toMatch(/create\s+(unlogged\s+)?table/i);
    expect(code).not.toMatch(/create\s+policy/i);
    // The guard's error message names the `drop index concurrently` the
    // operator must run; that text is a string literal, not a statement.
    expect(code.replace(/\$guard\$[\s\S]*?\$guard\$/g, "")).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bmaintain\b/i);
  });

  // ---- the SQL twin: rule parity with the TS module ------------------------------------------

  describe("public.source_article_key body: parity with supabase/functions/_shared/rss/article-key.ts", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.source_article_key?.body ?? "");
    });

    it("carries every exported regex .source verbatim", () => {
      for (const re of [URL_PATH_RE, KEY_FILE_EXT_RE, KEY_DATE_PREFIX_RE, KEY_ROUND_RE]) {
        const literal = unescapeSlash(re.source);
        expect(literal).not.toContain("'");
        expect(code, literal).toContain(literal);
      }
    });

    it("applies each regex with the right function or operator", () => {
      expect(body).toContain(
        `v_path := (pg_catalog.regexp_match(p_url, '${unescapeSlash(URL_PATH_RE.source)}'))[1]`,
      );
      expect(body).toContain(
        `pg_catalog.regexp_replace(v_seg, '${KEY_FILE_EXT_RE.source}', '', 'i')`,
      );
      expect(KEY_FILE_EXT_RE.flags).toBe("i");
      expect(body).toContain(`v_run ~ '${KEY_DATE_PREFIX_RE.source}'`);
      expect(KEY_ROUND_RE.flags).toBe("");
      expect(body).toContain(`v_run ~ '${KEY_ROUND_RE.source}'`);
    });

    it("skips a round run (a quantity in a headline) before it can become the key", () => {
      const round = body.indexOf(`v_run ~ '${KEY_ROUND_RE.source}'`);
      const assign = body.indexOf("v_key := v_run");
      expect(round).toBeGreaterThan(-1);
      expect(round).toBeLessThan(assign);
      expect(body).toMatch(/and not \(v_run ~ '\^\[1-9\]\[0-9\]\?0\{4,\}\$'\)/);
    });

    it("strips trailing slashes and takes the last path segment", () => {
      // rtrim, not a '/+$' regex: linear on a long run of slashes.
      expect(body).toMatch(/v_path := pg_catalog\.rtrim\(v_path, '\/'\)/);
      expect(body).toMatch(/pg_catalog\.regexp_replace\(v_path, '\^\.\*\/', ''\)/);
    });

    it("walks every digit run of the segment and keeps the last qualifying one", () => {
      expect(body).toMatch(/pg_catalog\.regexp_matches\(v_seg, '\[0-9\]\+', 'g'\)/);
      expect(body).toMatch(/v_key := v_run/);
      expect(body).toMatch(/return v_key;\s*end$/);
    });

    it("uses the same digit bounds and date-shaped lengths as the TS module", () => {
      expect(KEY_MIN_DIGITS).toBe(6);
      expect(KEY_MAX_DIGITS).toBe(20);
      expect(body).toMatch(/pg_catalog\.length\(v_run\) between 6 and 20/);
      expect(body).toMatch(/pg_catalog\.length\(v_run\) in \(8, 10, 12, 14\)/);
    });

    it("pg_catalog-qualifies every function call (empty search_path) and reads no table", () => {
      for (const fn of ["regexp_match", "regexp_replace", "regexp_matches", "length", "rtrim"]) {
        const all = [...body.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))];
        const qualified = [...body.matchAll(new RegExp(`pg_catalog\\.${fn}\\s*\\(`, "g"))];
        expect(all.length, `${fn} is used`).toBeGreaterThan(0);
        expect(qualified, `${fn} must be pg_catalog-qualified`).toHaveLength(all.length);
      }
      expect(body).not.toMatch(/\bpublic\./);
      expect(body).not.toMatch(/\b(from|join|update|insert)\s+public\b/);
    });

    it("is NULL-safe: returns null for a null url and for an unmatched path", () => {
      expect(body).toMatch(/if p_url is null then return null; end if;/);
      expect(body).toMatch(/if v_path is null then return null; end if;/);
    });
  });

  // ---- the bounded backfill ---------------------------------------------------------------------

  describe("articles_source_key_backfill body", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.articles_source_key_backfill?.body ?? "");
    });

    it("raises unless both bounds are given, ordered, and at most 2 days apart (before the update)", () => {
      expect(body).toMatch(/p_from is null or p_to is null/);
      expect(body).toMatch(/p_to <= p_from/);
      expect(body).toMatch(/p_to - p_from > interval '2 days'/);
      expect(body).toMatch(/raise exception/);
      expect(body.indexOf("raise exception")).toBeLessThan(body.indexOf("update public.articles"));
    });

    it("fills only NULL keys of the half-open created_at window and returns the row count", () => {
      expect(body).toContain(
        "update public.articles a set source_article_key = k.key from ( select x.id, public.source_article_key(x.url) as key from public.articles x join public.sources s on s.id = x.source_id where x.created_at >= p_from and x.created_at < p_to and x.source_article_key is null and s.slug <> all (array[",
      );
      expect(body).toMatch(/\) k where a\.id = k\.id and k\.key is not null;/);
      expect(body).toMatch(/get diagnostics v_n = row_count;/);
      expect(body).toMatch(/return v_n;\s*end$/);
    });

    it("never deletes or truncates, and updates only source_article_key", () => {
      expect(body).not.toMatch(/\bdelete\b|\btruncate\b|\binsert\b/i);
      expect([...body.matchAll(/\bupdate\b/gi)]).toHaveLength(1);
      expect([...body.matchAll(/\bset\b/gi)]).toHaveLength(1);
    });

    it("skips exactly the slugs in ARTICLE_KEY_EXCLUDED_SLUGS (TS/SQL parity)", () => {
      const m = body.match(/s\.slug <> all \(array\[([^\]]*)\](?:::text\[\])?\)/);
      expect(m, "exclusion list in the backfill WHERE clause").not.toBeNull();
      const sqlSlugs = [...m![1]!.matchAll(/'([^']*)'/g)].map((x) => x[1]);
      expect(sqlSlugs.sort()).toEqual([...ARTICLE_KEY_EXCLUDED_SLUGS].sort());
    });
  });

  // ---- nothing runs at apply time ---------------------------------------------------------------

  it("does not run any backfill or UPDATE at the top level of the migration", () => {
    const topLevel = code
      .replace(/\$fn\$[\s\S]*?\$fn\$/g, "")
      .replace(/\$guard\$[\s\S]*?\$guard\$/g, "");
    expect(topLevel).not.toMatch(/\bselect\s+public\./i);
    expect(topLevel).not.toMatch(/\bupdate\s+public\./i);
    expect(topLevel).not.toMatch(/\bupdate\b/i);
    expect(topLevel).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(topLevel).not.toMatch(/\bperform\b/i);
    expect(topLevel).not.toMatch(/articles_source_key_backfill\s*\(\s*now/i);
  });

  it("re-applies cleanly: every statement is idempotent", () => {
    expect(code).toMatch(/add\s+column\s+if\s+not\s+exists\s+source_article_key/i);
    expect(code).toMatch(/create\s+index\s+if\s+not\s+exists\s+articles_source_article_key_idx/i);
    for (const m of code.matchAll(/create\s+(?:or\s+replace\s+)?function/gi)) {
      expect(m[0]).toMatch(/or\s+replace/i);
    }
    expect(code).toMatch(/on\s+conflict\s+do\s+nothing/i);
  });
});

// ---------------------------------------------------------------------------
// Live parity (opt-in): the SQL twin must agree with the TS module on the
// shared truth table, and the backfill must key twins and skip excluded
// sources. Needs a throwaway Postgres with 113 applied and the stub schema
// (public.sources / public.articles with created_at); TAYF_PSQL is the psql
// binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Everything
// the backfill block writes is rolled back.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))(
  "migration 113: public.source_article_key() / articles_source_key_backfill() (live Postgres)",
  () => {
    function lit(tag: string, value: string): string {
      // Unique dollar-quote tag per literal; never occurs inside the value.
      expect(value).not.toContain(`$${tag}$`);
      return `$${tag}$${value}$${tag}$::text`;
    }

    function runPsql(sql: string): string {
      return execFileSync(
        process.env.TAYF_PSQL as string,
        ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-f", "-"],
        {
          input: sql,
          encoding: "utf8",
          env: { ...process.env, PGCLIENTENCODING: "UTF8" },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    }

    it("returns the TS result (and the fixture key) for every fixture url", () => {
      const rows = SOURCE_ARTICLE_KEY_CASES.map((c, i) => `(${i}, ${lit(`u${i}`, c.url)})`);
      const sql =
        "select 'ROW|' || i || '|' || coalesce(public.source_article_key(u), '<null>') from (values\n" +
        rows.join(",\n") +
        "\n) v(i, u) order by i;";
      const out = runPsql(sql)
        .split("\n")
        .filter((l) => l.startsWith("ROW|"));
      expect(out).toHaveLength(SOURCE_ARTICLE_KEY_CASES.length);
      SOURCE_ARTICLE_KEY_CASES.forEach((c, idx) => {
        const [, i, v] = out[idx]!.split("|");
        expect(Number(i), `row order for ${c.url}`).toBe(idx);
        const expected = sourceArticleKey(c.url) ?? "<null>";
        expect(v, `public.source_article_key(${JSON.stringify(c.url)})`).toBe(expected);
        expect(expected, `fixture key for ${c.url}`).toBe(c.key ?? "<null>");
      });
    });

    it("is NULL-safe", () => {
      const out = runPsql(
        "select 'ROW|' || coalesce(public.source_article_key(null), '<null>') || '|' || coalesce(public.source_article_key(''), '<null>');",
      )
        .split("\n")
        .find((l) => l.startsWith("ROW|"));
      expect(out).toBe("ROW|<null>|<null>");
    });

    it("backfill keys the two aksam twins, leaves the slug-only article null, skips the excluded sources, and is idempotent", () => {
      const sql = `
begin;
insert into public.sources (id, slug, name, bias, url, rss_url) values
  ('00000000-0000-4000-8000-0000000b1130', 'aksam', 'Akşam (fixture)', 'center', 'https://www.aksam.com.tr', 'https://www.aksam.com.tr/rss'),
  ('00000000-0000-4000-8000-0000000b1131', 'daily-sabah', 'Daily Sabah (fixture)', 'center', 'https://www.dailysabah.com', 'https://www.dailysabah.com/rss'),
  ('00000000-0000-4000-8000-0000000b1132', 'a-news', 'A News (fixture)', 'center', 'https://www.anews.com.tr', 'https://www.anews.com.tr/rss');
insert into public.articles (source_id, title, url, published_at) values
  ('00000000-0000-4000-8000-0000000b1130', 'twin a', 'https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu/haber-1708664', now()),
  ('00000000-0000-4000-8000-0000000b1130', 'twin b', 'https://www.aksam.com.tr/guncel/bakan-gulerden-mekke-ittifaki-vurgusu-husilerle-catismaya-girilmeyecek/haber-1708664', now()),
  ('00000000-0000-4000-8000-0000000b1130', 'slug only', 'https://www.aksam.com.tr/guncel/sadece-slug', now()),
  ('00000000-0000-4000-8000-0000000b1130', 'round', 'https://www.aksam.com.tr/guncel/yuz-bin-kisi/haber-100000', now()),
  ('00000000-0000-4000-8000-0000000b1131', 'excluded', 'https://www.dailysabah.com/business/economy/german-industry-lost-nearly-421000-jobs-since-2019-ifo', now()),
  ('00000000-0000-4000-8000-0000000b1132', 'excluded a-news', 'https://www.anews.com.tr/world/2026/10/21/macron-arrives-in-saudi-arabia-on-gulf-tour-elysee-1792588576', now());
select 'RES|first|' || public.articles_source_key_backfill(now() - interval '1 day', now() + interval '1 hour');
select 'RES|again|' || public.articles_source_key_backfill(now() - interval '1 day', now() + interval '1 hour');
select 'RES|key|' || title || '|' || coalesce(source_article_key, '<null>') from public.articles
  where source_id in ('00000000-0000-4000-8000-0000000b1130', '00000000-0000-4000-8000-0000000b1131', '00000000-0000-4000-8000-0000000b1132') order by title;
rollback;
`;
      const res = runPsql(sql)
        .split("\n")
        .filter((l) => l.startsWith("RES|"));
      expect(res).toContain("RES|first|2");
      expect(res).toContain("RES|again|0");
      expect(res).toContain("RES|key|twin a|1708664");
      expect(res).toContain("RES|key|twin b|1708664");
      expect(res).toContain("RES|key|slug only|<null>");
      expect(res).toContain("RES|key|round|<null>");
      expect(res).toContain("RES|key|excluded|<null>");
      expect(res).toContain("RES|key|excluded a-news|<null>");
    });

    // The fail-closed guard of 113, run as a bare DO block inside a transaction
    // that is rolled back (the whole migration file cannot be: it commits).
    // The 64 MB threshold is a literal in the guard, so the "big table" case
    // swaps it for 0 rather than writing 64 MB of rows.
    function guardBlock(): string {
      const m = readFileSync(MIGRATION, "utf8").match(/do\s+\$guard\$[\s\S]*?\$guard\$\s*;/i);
      expect(m, "guard block").not.toBeNull();
      return m![0];
    }

    it("guard: passes on a small table without the index, so a fresh dev or CI database still migrates", () => {
      const out = runPsql(`
begin;
drop index if exists public.articles_source_article_key_idx;
${guardBlock()}
select 'RES|guard-ok';
rollback;
`);
      expect(out).toContain("RES|guard-ok");
    });

    it("guard: refuses to build the index in the transaction when the table is over the threshold and the index is missing", () => {
      const sql = `
begin;
drop index if exists public.articles_source_article_key_idx;
${guardBlock().replace("67108864", "0")}
select 'RES|guard-should-not-pass';
rollback;
`;
      let message = "";
      try {
        runPsql(sql);
      } catch (e) {
        message = String((e as { stderr?: unknown }).stderr ?? e);
      }
      expect(message).toMatch(/PRE-BUILD/);
      expect(message).not.toMatch(/guard-should-not-pass/);
    });

    it("guard: passes on a big table when the pre-built index exists and is valid", () => {
      const out = runPsql(`
begin;
create index if not exists articles_source_article_key_idx on public.articles (source_id, source_article_key) where source_article_key is not null;
${guardBlock().replace("67108864", "0")}
select 'RES|guard-ok-prebuilt';
rollback;
`);
      expect(out).toContain("RES|guard-ok-prebuilt");
    });

    it("backfill rejects a null bound, an inverted window and a window over 2 days", () => {
      for (const args of [
        "null, now()",
        "now(), null",
        "now(), now() - interval '1 hour'",
        "now() - interval '3 days', now()",
      ]) {
        expect(() =>
          execFileSync(
            process.env.TAYF_PSQL as string,
            ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", `select public.articles_source_key_backfill(${args});`],
            { encoding: "utf8", env: process.env, stdio: ["ignore", "pipe", "pipe"] },
          ),
        ).toThrow(/articles_source_key_backfill/);
      }
    });
  },
);
