import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { SOURCE_SLUG_RE } from "@/lib/seo/source-slug-gate";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 116 ("anon-public-rpcs").
//
// Migration 117 revokes every anon/authenticated table + sequence grant in
// schema public. The browser (/saved) and the edge middleware (/cluster/<id>
// 308, /source/<slug> 404 gate) are the only anon-key consumers; after 117
// they reach data ONLY through the four bounded SECURITY DEFINER RPCs defined
// here. Each is `language sql stable`, `set search_path = ''`, granted to
// anon + service_role (never authenticated) and hard-capped so a public key
// cannot be used to page through the table:
//
//   saved_clusters(p_ids uuid[])   <= 200 rows, over-cap input is TRUNCATED
//                                  (never raised: /saved must not hard-fail)
//   merged_cluster_map()           <= 1000 rows, newest merges first
//   source_slugs()                 <= 2000 rows
//   source_slug_exists(p_slug)     one boolean; regex = SOURCE_SLUG_RE
//
// The RETURNS TABLE types are copied from production information_schema
// (2026-10-24): clusters.id uuid, title_tr text, title_tr_neutral text,
// article_count int4, bias_distribution jsonb, updated_at timestamptz,
// merged_into uuid; sources.slug text.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATION = "116_anon_public_rpcs.sql";

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
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

interface FnSpec {
  name: string;
  /** Argument list exactly as written in the signature. */
  args: string;
  /** Regex source matching the signature in revoke/grant statements. */
  sig: string;
}

const FUNCTIONS: FnSpec[] = [
  { name: "saved_clusters", args: "p_ids uuid[]", sig: "saved_clusters\\s*\\(\\s*uuid\\[\\]\\s*\\)" },
  { name: "merged_cluster_map", args: "", sig: "merged_cluster_map\\s*\\(\\s*\\)" },
  { name: "source_slugs", args: "", sig: "source_slugs\\s*\\(\\s*\\)" },
  { name: "source_slug_exists", args: "p_slug text", sig: "source_slug_exists\\s*\\(\\s*text\\s*\\)" },
];

describe("migration 116_anon_public_rpcs.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(REPO_ROOT, "supabase", "migrations", MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = readFileSync(path, "utf8");
    code = stripComments(sql);
  });

  it("contains the ledger insert for '116'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'116'\s*,\s*'116_anon_public_rpcs'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
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

  it("is additive: no drop, no alter table, no table or sequence grants, no policy", () => {
    expect(code).not.toMatch(/\bdrop\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|policy|view|index|trigger)\b/i);
    expect(code).not.toMatch(/\bon\s+(table|sequence|all\s+tables|all\s+sequences|schema)\b/i);
    expect(code).not.toMatch(/\bgrant\s+(select|insert|update|delete|truncate|maintain|usage|all)\b/i);
    expect(code).not.toMatch(/\balter\s+default\s+privileges\b/i);
  });

  it("only ever grants execute on the four functions, to anon and service_role, never authenticated", () => {
    const grants = code.match(/\bgrant\b[^;]*;/gi) ?? [];
    expect(grants).toHaveLength(FUNCTIONS.length);
    for (const g of grants) {
      expect(g).toMatch(/^grant\s+execute\s+on\s+function\s+public\./i);
      expect(g).toMatch(/\bto\s+anon\s*,\s*service_role\s*;$/i);
      expect(g).not.toMatch(/authenticated/i);
    }
    // Revokes are function-level too (a table revoke belongs in 117).
    for (const r of code.match(/\brevoke\b[^;]*;/gi) ?? []) {
      expect(r).toMatch(/^revoke\s+all\s+on\s+function\s+public\./i);
    }
  });

  for (const fn of FUNCTIONS) {
    describe(`public.${fn.name}`, () => {
      let block = "";

      beforeAll(() => {
        block = functionBlock(code, fn.name);
      });

      it("exists with the documented argument list", () => {
        const argRe = fn.args
          ? new RegExp(`function\\s+public\\.${fn.name}\\s*\\(\\s*${fn.args.replace(/\s+/g, "\\s+").replace(/\[\]/g, "\\[\\]")}\\s*\\)`, "i")
          : new RegExp(`function\\s+public\\.${fn.name}\\s*\\(\\s*\\)`, "i");
        expect(header(block)).toMatch(argRe);
      });

      it("is language sql, stable, SECURITY DEFINER with an empty search_path", () => {
        const h = header(block);
        expect(h).toMatch(/\blanguage\s+sql\b/i);
        expect(h).toMatch(/\bstable\b/i);
        expect(h).not.toMatch(/\b(volatile|immutable)\b/i);
        expect(h).toMatch(/\bsecurity\s+definer\b/i);
        expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      });

      it("revokes from public, anon, authenticated and grants execute to anon, service_role only", () => {
        expect(code).toMatch(
          new RegExp(
            `revoke\\s+all\\s+on\\s+function\\s+public\\.${fn.sig}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`,
            "i",
          ),
        );
        expect(code).toMatch(
          new RegExp(
            `grant\\s+execute\\s+on\\s+function\\s+public\\.${fn.sig}\\s+to\\s+anon\\s*,\\s*service_role\\s*;`,
            "i",
          ),
        );
      });

      it("reads only schema-qualified relations (search_path is empty)", () => {
        const b = body(block);
        for (const m of b.matchAll(/\b(?:from|join)\s+([a-z_][a-z0-9_.]*)/gi)) {
          expect(m[1], `unqualified relation in ${fn.name}`).toMatch(/^public\./i);
        }
      });
    });
  }

  it("saved_clusters returns exactly the /saved row shape, truncates over-cap input and caps the result", () => {
    const block = functionBlock(code, "saved_clusters");
    expect(header(block)).toMatch(
      /returns\s+table\s*\(\s*id\s+uuid\s*,\s*title_tr\s+text\s*,\s*title_tr_neutral\s+text\s*,\s*article_count\s+integer\s*,\s*bias_distribution\s+jsonb\s*,\s*updated_at\s+timestamptz\s*\)/i,
    );
    const b = body(block);
    expect(b).toContain("p_ids[1:200]");
    expect(b).toMatch(/coalesce\s*\(\s*p_ids\[1:200\]\s*,\s*'\{\}'::uuid\[\]\s*\)/i);
    expect(b).toMatch(/order\s+by\s+c\.updated_at\s+desc/i);
    expect(b).toMatch(/\blimit\s+200\b/i);
    expect(b).toMatch(/from\s+public\.clusters\s+c\b/i);
    // Over-cap input is truncated, never raised: /saved must not hard-fail.
    expect(block).not.toMatch(/\braise\b/i);
    // No archived filter: parity with the query it replaces.
    expect(b).not.toMatch(/is_archived/i);
  });

  it("merged_cluster_map returns (id, merged_into) for merged clusters, newest 1000", () => {
    const block = functionBlock(code, "merged_cluster_map");
    expect(header(block)).toMatch(/returns\s+table\s*\(\s*id\s+uuid\s*,\s*merged_into\s+uuid\s*\)/i);
    const b = body(block);
    expect(b).toMatch(/c\.merged_into\s+is\s+not\s+null/i);
    expect(b).toMatch(/order\s+by\s+c\.updated_at\s+desc/i);
    expect(b).toMatch(/\blimit\s+1000\b/i);
    expect(b).toMatch(/from\s+public\.clusters\s+c\b/i);
  });

  it("source_slugs returns (slug) with a 2000-row cap", () => {
    const block = functionBlock(code, "source_slugs");
    expect(header(block)).toMatch(/returns\s+table\s*\(\s*slug\s+text\s*\)/i);
    const b = body(block);
    expect(b).toMatch(/from\s+public\.sources\s+s\b/i);
    expect(b).toMatch(/\blimit\s+2000\b/i);
  });

  it("source_slug_exists returns boolean and uses exactly SOURCE_SLUG_RE as its guard", () => {
    const block = functionBlock(code, "source_slug_exists");
    expect(header(block)).toMatch(/returns\s+boolean\b/i);
    const b = body(block);
    // Parity with src/lib/seo/source-slug-gate.ts (and isValidSourceSlug):
    // the {0,63} form, not a looser {1,80}.
    expect(SOURCE_SLUG_RE.source).toBe("^[a-z0-9][a-z0-9-]{0,63}$");
    expect(b).toContain(`'${SOURCE_SLUG_RE.source}'`);
    expect(b).toMatch(/p_slug\s+is\s+not\s+null/i);
    expect(b).toMatch(/exists\s*\(\s*select\s+1\s+from\s+public\.sources\s+s\s+where\s+s\.slug\s*=\s*p_slug\s*\)/i);
    expect(b).toMatch(/else\s+false\b/i);
  });
});
