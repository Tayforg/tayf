import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  LEGAL_NOTICE_MIN_LETTERS,
  LEGAL_NOTICE_MIN_UPPER_RATIO,
  LEGAL_NOTICE_PATTERNS,
} from "../../supabase/functions/_shared/rss/legal-notice";
import { LEGAL_NOTICE_CASES } from "../fixtures/legal-notice-cases";

// Static SQL-contract test for migration 107 (BİK court / official notices are
// excluded from the ticker attention counts): a service-role-only table of
// notice article ids, the SQL twin of supabase/functions/_shared/rss/
// legal-notice.ts (public.is_legal_notice), a bounded marker function and a
// cron backstop. Comments are stripped before every code assertion so prose
// can never satisfy a guard (same style as 106's test). The rule-parity block
// compares the SQL against the JS module's exported regex sources, and the
// last block (opt-in, TAYF_PSQL) runs the shared truth table through a real
// Postgres.

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "107_legal_notice_articles.sql",
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
// found, which fails the tests below (so "security definer + empty
// search_path" is asserted structurally, per function).
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

describe("migration 107_legal_notice_articles.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Record<string, FnBlock> = {};

  beforeAll(() => {
    expect(existsSync(MIGRATION), "107_legal_notice_articles.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0 FINDINGS, code does not)", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(code).not.toMatch(/STEP 0 FINDINGS/);
  });

  it("records the Step 0 findings, the design, the backfill loop and the rollback in the header", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(raw).toMatch(/170006/);
    expect(raw).toMatch(/idx_articles_published_at/);
    expect(raw).toMatch(/legal-notice-mark/);
    expect(raw).toMatch(/pg_catalog\.normalize/);
    expect(raw).toMatch(/DESIGN/);
    expect(raw).toMatch(/BACKFILL/i);
    expect(raw).toMatch(/legal_notice_mark\(/);
    expect(raw).toMatch(/ROLLBACK/i);
  });

  it("documents the accepted divergences from the JS predicate", () => {
    expect(raw).toMatch(/\\p\{L\}/);
    expect(raw).toMatch(/newline/i);
    expect(raw).toMatch(/fail-open|fail open/i);
  });

  it("never mentions the forbidden zone word (zone-parity guard)", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  // ---- table ---------------------------------------------------------------

  it("creates public.legal_notice_articles with the agreed columns and a published_at index", () => {
    expect(code).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.legal_notice_articles\s*\(\s*article_id\s+uuid\s+primary\s+key\s+references\s+public\.articles\s*\(\s*id\s*\)\s+on\s+delete\s+cascade\s*,\s*published_at\s+timestamptz\s+not\s+null\s*,\s*marked_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)\s*\)\s*;/i,
    );
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+legal_notice_articles_published_idx\s+on\s+public\.legal_notice_articles\s*\(\s*published_at\s+desc\s*\)\s*;/i,
    );
    expect(code).toMatch(/comment\s+on\s+table\s+public\.legal_notice_articles\s+is\s+'/i);
  });

  it("enables RLS and strips every default grant from anon/authenticated/public", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.legal_notice_articles\s+enable\s+row\s+level\s+security\s*;/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.legal_notice_articles\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
    );
  });

  it("revokes MAINTAIN only behind a PG17 version guard", () => {
    const m = code.match(/do\s+\$maint\$([\s\S]*?)\$maint\$\s*;/i);
    expect(m, "guarded maintain block").not.toBeNull();
    const body = collapse(m![1]!);
    expect(body).toMatch(/current_setting\('server_version_num'\)::int >= 170000/);
    expect(body).toMatch(
      /execute 'revoke maintain on public\.legal_notice_articles from anon, authenticated'/,
    );
    // The bare statement must only exist inside the guard.
    const outside = code.replace(/do\s+\$maint\$[\s\S]*?\$maint\$\s*;/i, "");
    expect(outside).not.toMatch(/revoke\s+maintain/i);
  });

  it("grants SELECT on the table to service_role and nothing else to anyone", () => {
    const tableGrants = [...code.matchAll(/grant\s+[^;]*\bon\s+(?:table\s+)?public\.legal_notice_articles\b[^;]*;/gi)].map(
      (m) => collapse(m[0]),
    );
    expect(tableGrants).toEqual(["grant select on public.legal_notice_articles to service_role;"]);
  });

  it("never grants anything to anon/authenticated, and no write-class grant exists at all", () => {
    expect(code).not.toMatch(/grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    expect(code).not.toMatch(/grant\s+(insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
  });

  // ---- functions -----------------------------------------------------------

  it("defines exactly two functions, both SECURITY DEFINER with an empty search_path", () => {
    expect(Object.keys(fns).sort()).toEqual(["is_legal_notice", "legal_notice_mark"]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(2);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(2);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(2);
  });

  it("is_legal_notice(p_title text, p_url text default null) returns boolean and is immutable", () => {
    const f = fns.is_legal_notice!;
    expect(collapse(f.args)).toBe("p_title text, p_url text default null");
    expect(f.returns).toBe("boolean");
    expect(f.immutable).toBe(true);
  });

  it("legal_notice_mark(p_from timestamptz, p_to timestamptz) returns integer and is not immutable", () => {
    const f = fns.legal_notice_mark!;
    expect(collapse(f.args)).toBe("p_from timestamptz, p_to timestamptz");
    expect(f.returns).toBe("integer");
    expect(f.immutable).toBe(false);
  });

  it.each([
    ["is_legal_notice", "text\\s*,\\s*text"],
    ["legal_notice_mark", "timestamptz\\s*,\\s*timestamptz"],
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

  // ---- predicate: shape ----------------------------------------------------

  describe("is_legal_notice body", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.is_legal_notice?.body ?? "");
    });

    it("NFC-normalises and trims (BOM and NBSP included) before any test", () => {
      expect(body).toMatch(/pg_catalog\.normalize\(p_title, 'NFC'\)/);
      expect(body).toMatch(
        /pg_catalog\.regexp_replace\(\s*pg_catalog\.normalize\(p_title, 'NFC'\),\s*'\^\[\\s\\u00a0\\ufeff[^\]]*\]\+\|\[\\s\\u00a0\\ufeff[^\]]*\]\+\$',\s*'',\s*'g'\s*\)/,
      );
    });

    it("counts upper and lower Turkish/ASCII letters with the same sets the ratio gate needs", () => {
      expect(body).toMatch(/'\[\^A-ZÇĞİÖŞÜÂÎÛ\]'/);
      expect(body).toMatch(/'\[\^a-zçğıöşüâîû\]'/);
    });

    it("pg_catalog-qualifies every function call (empty search_path)", () => {
      for (const fn of ["normalize", "regexp_replace", "regexp_match", "length"]) {
        const all = [...body.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))];
        const qualified = [...body.matchAll(new RegExp(`pg_catalog\\.${fn}\\s*\\(`, "g"))];
        expect(all.length, `${fn} is used`).toBeGreaterThan(0);
        expect(qualified, `${fn} must be pg_catalog-qualified`).toHaveLength(all.length);
      }
      expect(body).not.toMatch(/\bpublic\./);
    });

    it("extracts the url path with the scheme/authority regex and tests it case-insensitively", () => {
      expect(body).toMatch(
        /v_path := \(pg_catalog\.regexp_match\(p_url, '\^\[A-Za-z\]\[A-Za-z0-9\+\.-\]\*:\/\/\[\^\/\?#\]\*\(\[\^\?#\]\*\)'\)\)\[1\]/,
      );
      expect(body).toMatch(/v_path ~\* '/);
    });

    it("falls through to false when nothing matched", () => {
      expect(body).toMatch(/return false;\s*end$/);
    });
  });

  // ---- predicate: rule parity with the JS module -----------------------------

  describe("rule parity with supabase/functions/_shared/rss/legal-notice.ts", () => {
    it.each(Object.entries(LEGAL_NOTICE_PATTERNS))(
      "carries LEGAL_NOTICE_PATTERNS.%s verbatim",
      (_name, re) => {
        expect(re.source).not.toContain("'");
        expect(code).toContain(re.source);
      },
    );

    it("applies each pattern with the right operator", () => {
      const p = LEGAL_NOTICE_PATTERNS;
      expect(code).toContain(`v_t ~ '${p.ENDS_WITH_INSTITUTION.source}'`);
      expect(code).toContain(`v_t ~ '${p.CONTAINS_ABLATIVE.source}'`);
      expect(code).toContain(`v_t ~ '${p.TC_COURT.source}'`);
      expect(code).toContain(`v_t ~ '${p.STARTS_WITH_ILAN.source}'`);
      expect(code).toContain(`v_path ~* '${p.ILAN_PATH.source}'`);
    });

    it("uses the same letter gates as the JS module (8 / 3 letters, 0.85 uppercase ratio)", () => {
      expect(LEGAL_NOTICE_MIN_LETTERS).toBe(8);
      expect(LEGAL_NOTICE_MIN_UPPER_RATIO).toBe(0.85);
      const body = collapse(fns.is_legal_notice?.body ?? "");
      expect(body).toMatch(/v_up \+ v_lo >= 8\b/);
      expect(body).toMatch(/v_up \+ v_lo >= 3\b/);
      expect([...body.matchAll(/v_up >= 0\.85 \* \(v_up \+ v_lo\)/g)]).toHaveLength(2);
      // The only numeric thresholds in the body: no stray 0.8 / 0.9 variant.
      expect(body).not.toMatch(/\b0\.(?!85\b)\d+/);
    });

    it("keeps the STARTS_WITH_ILAN gate on its own 3-letter floor, the other rules on the 8-letter floor", () => {
      const body = collapse(fns.is_legal_notice?.body ?? "");
      const ilan = body.indexOf(`v_t ~ '${LEGAL_NOTICE_PATTERNS.STARTS_WITH_ILAN.source}'`);
      const ends = body.indexOf(`v_t ~ '${LEGAL_NOTICE_PATTERNS.ENDS_WITH_INSTITUTION.source}'`);
      const eight = body.indexOf("v_up + v_lo >= 8");
      const three = body.indexOf("v_up + v_lo >= 3");
      expect(eight).toBeGreaterThanOrEqual(0);
      expect(ends).toBeGreaterThan(eight);
      expect(three).toBeGreaterThan(ends);
      expect(ilan).toBeGreaterThan(ends);
    });
  });

  // ---- marker --------------------------------------------------------------

  describe("legal_notice_mark body", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.legal_notice_mark?.body ?? "");
    });

    it("raises unless both bounds are given, ordered, and at most 2 days apart", () => {
      expect(body).toMatch(/p_from is null or p_to is null/);
      expect(body).toMatch(/p_to <= p_from/);
      expect(body).toMatch(/p_to - p_from > interval '2 days'/);
      expect(body).toMatch(/raise exception/);
      // The guard must come before the insert.
      expect(body.indexOf("raise exception")).toBeLessThan(body.indexOf("insert into"));
    });

    it("inserts the matching articles of the half-open window, idempotently, and returns the row count", () => {
      expect(body).toMatch(
        /insert into public\.legal_notice_articles \(article_id, published_at\) select a\.id, a\.published_at from public\.articles a where a\.published_at >= p_from and a\.published_at < p_to and public\.is_legal_notice\(a\.title, a\.url\) on conflict \(article_id\) do nothing;/,
      );
      expect(body).toMatch(/get diagnostics \w+ = row_count;/);
      expect(body).toMatch(/return \w+;\s*end$/);
    });

    it("never deletes or updates (marks only grow)", () => {
      expect(body).not.toMatch(/\bdelete\b|\bupdate\b|\btruncate\b/i);
    });
  });

  // ---- cron ----------------------------------------------------------------

  describe("cron backstop", () => {
    it("is guarded on pg_cron and re-schedules idempotently (unschedule before schedule)", () => {
      expect(code).toMatch(/from\s+pg_catalog\.pg_extension\s+where\s+extname\s*=\s*'pg_cron'/i);
      const unschedule = code.search(/cron\.unschedule\s*\(\s*'legal-notice-mark'\s*\)/i);
      const schedule = code.search(/cron\.schedule\s*\(\s*'legal-notice-mark'/i);
      expect(code).toMatch(/from\s+cron\.job\s+where\s+jobname\s*=\s*'legal-notice-mark'/i);
      expect(unschedule).toBeGreaterThanOrEqual(0);
      expect(schedule).toBeGreaterThan(unschedule);
    });

    it("uses the exact schedule and a 2 min statement_timeout before a 30 h .. +3 h marker call", () => {
      expect(code).toMatch(/cron\.schedule\s*\(\s*'legal-notice-mark'\s*,\s*'23 \*\/6 \* \* \*'/i);
      const m = code.match(/cron\.schedule\s*\([\s\S]*?\$sql\$([\s\S]*?)\$sql\$/i);
      expect(m, "cron command body").not.toBeNull();
      const cmd = collapse(m![1]!);
      expect(cmd).toBe(
        "set statement_timeout = '2min'; select public.legal_notice_mark(now() - interval '30 hours', now() + interval '3 hours');",
      );
    });
  });

  // ---- hygiene -------------------------------------------------------------

  it("is additive: no drop, no truncate, no policy, no delete, only the one RLS alter table", () => {
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    const alters = [...code.matchAll(/\balter\s+table\b[^;]*;/gi)].map((m) => collapse(m[0]));
    expect(alters).toEqual([
      "alter table public.legal_notice_articles enable row level security;",
    ]);
  });

  it("does not run any backfill inside the migration (outside function bodies and the cron command)", () => {
    const topLevel = code
      .replace(/\$fn\$[\s\S]*?\$fn\$/g, "")
      .replace(/\$sql\$[\s\S]*?\$sql\$/g, "")
      .replace(/\$maint\$[\s\S]*?\$maint\$/g, "");
    expect(topLevel).not.toMatch(/\bselect\s+public\.legal_notice_mark/i);
    expect(topLevel).not.toMatch(/\binsert\s+into\s+public\.legal_notice_articles\b/i);
    expect(topLevel).not.toMatch(/\bperform\s+public\./i);
  });

  it("writes the ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'107'\s*,\s*'107_legal_notice_articles'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });
});

// ---------------------------------------------------------------------------
// Live parity (opt-in): the SQL predicate must agree with the JS predicate on
// the shared truth table. Needs a throwaway Postgres (>= 13, UTF8) with 107
// applied; TAYF_PSQL is the psql binary and PGHOST/PGPORT/PGUSER/PGDATABASE
// select the server. Read-only: a single SELECT.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))(
  "migration 107: public.is_legal_notice() agrees with isLegalNotice() on the shared fixtures (live Postgres)",
  () => {
    function lit(tag: string, value: string): string {
      // Unique dollar-quote tag per literal; never occurs inside the value.
      expect(value).not.toContain(`$${tag}$`);
      return `$${tag}$${value}$${tag}$::text`;
    }

    function buildSql(): string {
      const rows = LEGAL_NOTICE_CASES.map((c, i) => {
        const title = lit(`t${i}`, c.title);
        const url = c.url == null ? "null::text" : lit(`u${i}`, c.url);
        return `(${i}, ${title}, ${url})`;
      });
      return (
        "select i, public.is_legal_notice(t, u) from (values\n" +
        rows.join(",\n") +
        "\n) v(i, t, u) order by i;"
      );
    }

    function runPsql(sql: string): string {
      return execFileSync(
        process.env.TAYF_PSQL as string,
        ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql],
        {
          encoding: "utf8",
          env: { ...process.env, PGCLIENTENCODING: "UTF8" },
          maxBuffer: 8 * 1024 * 1024,
        },
      );
    }

    it("returns the expected boolean for every fixture row", () => {
      const out = runPsql(buildSql())
        .split("\n")
        .filter((l) => l.length > 0);
      expect(out).toHaveLength(LEGAL_NOTICE_CASES.length);
      const got = out.map((line) => {
        const [i, v] = line.split("|");
        return { i: Number(i), v };
      });
      LEGAL_NOTICE_CASES.forEach((c, idx) => {
        const row = got[idx]!;
        expect(row.i, `row order for ${JSON.stringify(c)}`).toBe(idx);
        expect(
          row.v,
          `is_legal_notice(${JSON.stringify(c.title)}, ${JSON.stringify(c.url ?? null)})`,
        ).toBe(c.expected ? "t" : "f");
      });
    });

    it("is NULL-safe: null/empty title and null url return false, never null", () => {
      const out = runPsql(
        "select public.is_legal_notice(null, null), public.is_legal_notice('', ''), public.is_legal_notice('GOL');",
      ).trim();
      expect(out).toBe("f|f|f");
    });
  },
);
