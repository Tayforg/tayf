import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  LEGAL_NOTICE_DESCRIPTION_PATTERNS,
  LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS,
  LEGAL_NOTICE_MIN_LETTERS,
  LEGAL_NOTICE_MIN_UPPER_RATIO,
  LEGAL_NOTICE_PATTERNS,
  LEGAL_NOTICE_TITLE_V2_PATTERNS,
  MIXED_COURT_NOTICE,
  isLegalNotice,
} from "../../supabase/functions/_shared/rss/legal-notice";
import { LEGAL_NOTICE_CASES } from "../fixtures/legal-notice-cases";
import { LEGAL_NOTICE_V2_CASES } from "../fixtures/legal-notice-v2-cases";
import { assertLiveReady } from "../_helpers/live-db";

// Static SQL-contract test for migration 213 (h181-sourcepages-1): tax-office, enforcement-office and mixed-case court
// notices. The migration re-creates the 3-argument predicate public.is_legal_notice(p_title, p_url, p_description) as the
// LIVE body (migration 210's, read from production on 2026-11-14: md5(prosrc) 058d43141f193fbfafac5ed3dc135c86, length 1322)
// plus exactly two new blocks: a title rule (ENDS_WITH_OFFICE under the uppercase gate) and two description rules
// (E2: 'İLANEN TEBLİĞ' and 'GAZETE VEYA İNTERNET HABER SİTESİ İLANI', each under the uppercase gate). The TS-only mixed-case
// court rule (MIXED_COURT_NOTICE) has no SQL twin on purpose. The 2-argument function of migration 107 and
// public.legal_notice_mark are not touched.
// Comments are stripped before every code assertion (a line scan, no regular expression over the SQL) so prose can never
// satisfy a guard. The parity block compares the SQL against the JS module's exported regex sources; the last block
// (opt-in, TAYF_PSQL) runs the shared truth table through a real Postgres.

const MIGRATIONS = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS, "213_legal_notice_tax_court.sql");
const MIGRATION_107 = resolve(MIGRATIONS, "107_legal_notice_articles.sql");
const MIGRATION_210 = resolve(MIGRATIONS, "210_legal_notice_description.sql");

/** sha256 of the 2-argument is_legal_notice body of migration 107 (the live body is byte-identical, read on 2026-11-12). */
const BODY_107_IS_LEGAL_NOTICE_SHA256 = "f28c49cb47fbd5529c5834347c52a974621fcffe4ae0d3cdc923a9196f5deefc";
/** sha256 of the legal_notice_mark body of migration 107 (also byte-identical on production). */
const BODY_107_MARK_SHA256 = "4eceacedd54b65f8aaf10c378fda7061ba7711c5034c23398174f2007d9020f1";
/** md5 of migration 210's 3-argument body = md5(prosrc) of the live function (production, read-only, 2026-11-14), length 1322. */
const BODY_210_IS_LEGAL_NOTICE_MD5 = "058d43141f193fbfafac5ed3dc135c86";
const BODY_210_IS_LEGAL_NOTICE_LENGTH = 1322;
const BODY_210_IS_LEGAL_NOTICE_SHA256 = "c68a9679a31562d791ace555e19514e99a7036379d8742a9fd1a96e044e7089d";
/** sha256 of migration 210's legal_notice_mark body (213 leaves that function alone). */
const BODY_210_MARK_SHA256 = "a16db5b16b0c8be7404a90aabb5a4e67f69ba675f37c0c290f59dc5b505a19fa";

function stripComments(sql: string): string {
  return sql
    .split("\n")
    .map((line) => {
      const at = line.indexOf("--");
      return at < 0 ? line : line.slice(0, at);
    })
    .join("\n");
}

interface FnBlock {
  args: string;
  returns: string;
  immutable: boolean;
  body: string;
}

// Every `create or replace function public.<name>(...) returns <t> language plpgsql [immutable] security definer set
// search_path = '' as $fn$ ... $fn$`. A function that deviates from that header shape is simply not found, which fails the
// tests below (so "security definer + empty search_path" is asserted structurally, per function).
function parseFunctions(code: string): Array<FnBlock & { name: string }> {
  const out: Array<FnBlock & { name: string }> = [];
  const re =
    /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\s+(\w+)\s+language\s+plpgsql\s+(immutable\s+)?security\s+definer\s+set\s+search_path\s*=\s*''\s+as\s+\$fn\$([\s\S]*?)\$fn\$/gi;
  for (const m of code.matchAll(re)) {
    out.push({
      name: m[1]!,
      args: m[2]!,
      returns: m[3]!,
      immutable: Boolean(m[4]),
      body: m[5]!,
    });
  }
  return out;
}

function bodiesOf(sql: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const open = sql.indexOf("$fn$", from);
    if (open < 0) return out;
    const close = sql.indexOf("$fn$", open + 4);
    if (close < 0) return out;
    out.push(sql.slice(open + 4, close));
    from = close + 4;
  }
}

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
// md5 is only the Postgres md5(prosrc) comparison value used by the operator's verify query; it guards nothing.
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

/** The code lines of a function body: comments dropped, each line trimmed, blank lines dropped. */
function codeLines(body: string): string[] {
  return stripComments(body)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

describe("migration 213_legal_notice_tax_court.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Array<FnBlock & { name: string }> = [];
  let predicate: FnBlock | undefined;

  beforeAll(() => {
    expect(existsSync(MIGRATION), "213_legal_notice_tax_court.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
    predicate = fns.find((f) => f.name === "is_legal_notice");
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0 FINDINGS, code does not)", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(code).not.toMatch(/STEP 0 FINDINGS/);
  });

  it("records the Step 0 findings, the design, the replay, the divergences, the deploy order, the backfill and the rollback in the header", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(raw).toMatch(/pg_get_functiondef/);
    expect(raw).toContain(BODY_210_IS_LEGAL_NOTICE_MD5);
    expect(raw).toContain(String(BODY_210_IS_LEGAL_NOTICE_LENGTH));
    expect(raw).toMatch(/byte for byte/i);
    expect(raw).toMatch(/DESIGN/);
    expect(raw).toMatch(/REPLAY/);
    expect(raw).toMatch(/ACCEPTED DIVERGENCES/);
    expect(raw).toMatch(/DEPLOY ORDER/);
    expect(raw).toMatch(/BACKFILL/i);
    expect(raw).toMatch(/ROLLBACK/i);
    expect(raw).toMatch(/VERGİ DAİRESİ MÜDÜRLÜĞÜ/);
    expect(raw).toMatch(/İLANEN TEBLİĞ/);
    expect(raw).toMatch(/GAZETE VEYA İNTERNET HABER SİTESİ İLANI/);
  });

  it("documents that the mixed-case court rule has no SQL twin on purpose (case folding of İ and ı is not reliable in a POSIX ARE)", () => {
    expect(raw).toMatch(/MIXED_COURT_NOTICE/);
    expect(raw).toMatch(/no SQL twin/i);
    expect(raw).toMatch(/case folding/i);
    expect(raw).toMatch(/\/ekonomi/);
  });

  it("never mentions the forbidden zone word (zone-parity guard)", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  // ---- the functions it must not touch stay exactly as they were -------------------------

  describe("the 2-argument is_legal_notice (107) and legal_notice_mark are not touched", () => {
    it("migration 107's function bodies still hash to the production-verified values (nothing edited them)", () => {
      const bodies = bodiesOf(readFileSync(MIGRATION_107, "utf8"));
      expect(bodies).toHaveLength(2);
      expect(sha256(bodies[0]!)).toBe(BODY_107_IS_LEGAL_NOTICE_SHA256);
      expect(sha256(bodies[1]!)).toBe(BODY_107_MARK_SHA256);
    });

    it("migration 210's bodies still hash to the live values (213 carries the live body, so 210 must stay the reference)", () => {
      const bodies = bodiesOf(readFileSync(MIGRATION_210, "utf8"));
      expect(bodies).toHaveLength(2);
      expect(md5(bodies[0]!)).toBe(BODY_210_IS_LEGAL_NOTICE_MD5);
      expect(bodies[0]!.length).toBe(BODY_210_IS_LEGAL_NOTICE_LENGTH);
      expect(sha256(bodies[0]!)).toBe(BODY_210_IS_LEGAL_NOTICE_SHA256);
      expect(sha256(bodies[1]!)).toBe(BODY_210_MARK_SHA256);
    });

    it("the patterns of 107 and 210 are unchanged in the TS module (their sources are what those migrations embed)", () => {
      expect(Object.keys(LEGAL_NOTICE_PATTERNS)).toHaveLength(5);
      expect(Object.keys(LEGAL_NOTICE_DESCRIPTION_PATTERNS)).toHaveLength(4);
      const v107 = bodiesOf(readFileSync(MIGRATION_107, "utf8"))[0]!;
      for (const re of Object.values(LEGAL_NOTICE_PATTERNS)) expect(v107).toContain(re.source);
      const v210 = bodiesOf(readFileSync(MIGRATION_210, "utf8"))[0]!;
      for (const re of Object.values(LEGAL_NOTICE_DESCRIPTION_PATTERNS)) expect(v210).toContain(re.source);
    });

    it("213 creates, replaces, drops and alters nothing but the 3-argument is_legal_notice", () => {
      expect(code).not.toMatch(/\bdrop\s+function\b/i);
      expect(code).not.toMatch(/p_url\s+text\s+default\s+null/i);
      expect(code).not.toMatch(/\balter\s+function\b/i);
      expect(code).not.toMatch(/legal_notice_mark/i);
      const defs = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns/gi)];
      expect(defs).toHaveLength(1);
      expect(defs[0]![1]).toBe("is_legal_notice");
      expect(collapse(defs[0]![2]!)).toBe("p_title text, p_url text, p_description text");
    });

    it("the 3-argument form has no default on p_description (a 2-argument call can only reach the 2-argument function)", () => {
      expect(collapse(predicate?.args ?? "")).toBe("p_title text, p_url text, p_description text");
      expect(predicate?.args ?? "").not.toMatch(/\bdefault\b/i);
    });
  });

  // ---- function header, grants -------------------------------------------------------------

  it("defines exactly one function: SECURITY DEFINER with an empty search_path, returns boolean, IMMUTABLE (like 210)", () => {
    expect(fns.map((f) => f.name)).toEqual(["is_legal_notice"]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(1);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(1);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(1);
    expect(predicate).toBeDefined();
    expect(predicate!.returns).toBe("boolean");
    expect(predicate!.immutable).toBe(true);
  });

  it("revokes from public/anon/authenticated and grants service_role only", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.is_legal_notice\s*\(\s*text\s*,\s*text\s*,\s*text\s*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.is_legal_notice\s*\(\s*text\s*,\s*text\s*,\s*text\s*\)\s+to\s+service_role\s*;/i,
    );
    expect(code).not.toMatch(/grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    expect(code).not.toMatch(/grant\s+(select|insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
  });

  it("comments on the function and names the new rules", () => {
    expect(code).toMatch(/comment\s+on\s+function\s+public\.is_legal_notice\s*\(\s*text\s*,\s*text\s*,\s*text\s*\)\s+is\s+'/i);
    const at = code.indexOf("comment on function");
    const comment = code.slice(at, code.indexOf(";", at));
    expect(comment).toContain("213");
    expect(comment).toContain("İLANEN TEBLİĞ");
  });

  // ---- body: the live body plus only the new rules ------------------------------------------

  describe("3-argument is_legal_notice body", () => {
    let body = "";
    let lines213: string[] = [];
    let lines210: string[] = [];
    let inserted: string[] = [];

    beforeAll(() => {
      body = collapse(predicate?.body ?? "");
      lines213 = codeLines(predicate?.body ?? "");
      lines210 = codeLines(bodiesOf(readFileSync(MIGRATION_210, "utf8"))[0]!);
      // Ordered subsequence: every code line of 210's body appears in 213's, in the same order. What is left over is
      // what 213 inserted.
      let i = 0;
      inserted = [];
      for (const line of lines213) {
        if (i < lines210.length && line === lines210[i]) i++;
        else inserted.push(line);
      }
      expect(i, `210's body line ${i + 1} (${lines210[i] ?? "end"}) is missing from 213`).toBe(lines210.length);
    });

    it("is migration 210's live body plus insertions only: every code line of 210's body is in 213's, in order", () => {
      expect(lines210.length).toBeGreaterThan(20);
      expect(lines213.length).toBeGreaterThan(lines210.length);
      // The insertions are two blocks of at most about 40 code lines in all.
      expect(inserted.length).toBeGreaterThan(0);
      expect(inserted.length).toBeLessThanOrEqual(45);
    });

    it("the insertions carry the three new patterns exactly once each and none of the earlier ones", () => {
      const text = inserted.join("\n");
      expect(text).toContain(LEGAL_NOTICE_TITLE_V2_PATTERNS.ENDS_WITH_OFFICE.source);
      for (const re of Object.values(LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS)) {
        expect(text.split(re.source).length - 1, re.source).toBe(1);
      }
      expect(text.split(LEGAL_NOTICE_TITLE_V2_PATTERNS.ENDS_WITH_OFFICE.source).length - 1).toBe(1);
      for (const re of [...Object.values(LEGAL_NOTICE_PATTERNS), ...Object.values(LEGAL_NOTICE_DESCRIPTION_PATTERNS)]) {
        expect(text, re.source).not.toContain(re.source);
      }
    });

    it("still starts from the 2-argument verdict, so the title and url rules of 107 cannot change", () => {
      const first = body.indexOf("public.is_legal_notice(p_title, p_url)");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(body).toMatch(/if public\.is_legal_notice\(p_title, p_url\) then return true; end if;/);
      expect(body.slice(0, first)).not.toMatch(/\breturn\b/);
    });

    it("the title rule runs after the 2-argument verdict and BEFORE the null-description return (it needs no description)", () => {
      const office = body.indexOf(`v_t ~ '${LEGAL_NOTICE_TITLE_V2_PATTERNS.ENDS_WITH_OFFICE.source}'`);
      const nullDesc = body.indexOf("if p_description is null or p_description = '' then return false; end if;");
      const verdict = body.indexOf("if public.is_legal_notice(p_title, p_url) then");
      expect(verdict).toBeGreaterThanOrEqual(0);
      expect(office).toBeGreaterThan(verdict);
      expect(nullDesc).toBeGreaterThan(office);
    });

    it("the description rules run after D2 and before the final return false", () => {
      const caps = body.indexOf(`v_d ~ '${LEGAL_NOTICE_DESCRIPTION_PATTERNS.DESCRIPTION_STARTS_WITH_ILAN.source}'`);
      expect(caps).toBeGreaterThan(0);
      for (const re of Object.values(LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS)) {
        const at = body.indexOf(`v_d ~ '${re.source}'`);
        expect(at, re.source).toBeGreaterThan(caps);
        expect(at, re.source).toBeLessThan(body.lastIndexOf("return false;"));
      }
      expect(body).toMatch(/return false; end$/);
    });

    it("NFC-normalises the description and the title (decomposed İ) before any pattern test", () => {
      expect(body).toMatch(/pg_catalog\.normalize\(p_description, 'NFC'\)/);
      expect(body).toMatch(/pg_catalog\.normalize\(p_title, 'NFC'\)/);
      expect(body.indexOf("pg_catalog.normalize(p_description, 'NFC')")).toBeLessThan(body.indexOf("v_d ~"));
      // The title is normalised before the first title-pattern test of the new rule.
      const office = body.indexOf(`v_t ~ '${LEGAL_NOTICE_TITLE_V2_PATTERNS.ENDS_WITH_OFFICE.source}'`);
      expect(body.indexOf("pg_catalog.normalize(p_title, 'NFC')")).toBeLessThan(office);
    });

    it("counts upper and lower Turkish/ASCII letters with the same sets as migrations 107 and 210", () => {
      expect(body).toMatch(/'\[\^A-ZÇĞİÖŞÜÂÎÛ\]'/);
      expect(body).toMatch(/'\[\^a-zçğıöşüâîû\]'/);
    });

    it("gates all three new rules on the 8-letter floor and the 0.85 ratio, the same as 210's D2 (three gates in all, no other numbers)", () => {
      expect(LEGAL_NOTICE_MIN_LETTERS).toBe(8);
      expect(LEGAL_NOTICE_MIN_UPPER_RATIO).toBe(0.85);
      expect([...body.matchAll(/v_up \+ v_lo >= 8\b/g)]).toHaveLength(3);
      expect([...body.matchAll(/v_up >= 0\.85 \* \(v_up \+ v_lo\)/g)]).toHaveLength(3);
      expect(body).not.toMatch(/v_up \+ v_lo >= 3\b/);
      expect(body).not.toMatch(/\b0\.(?!85\b)\d+/);
    });

    it("pg_catalog-qualifies every function call except the one public.is_legal_notice call (empty search_path)", () => {
      for (const fn of ["normalize", "regexp_replace", "length"]) {
        const all = [...body.matchAll(new RegExp(`\\b${fn}\\s*\\(`, "g"))];
        const qualified = [...body.matchAll(new RegExp(`pg_catalog\\.${fn}\\s*\\(`, "g"))];
        expect(all.length, `${fn} is used`).toBeGreaterThan(0);
        expect(qualified, `${fn} must be pg_catalog-qualified`).toHaveLength(all.length);
      }
      const publicRefs = [...body.matchAll(/\bpublic\.\w+/g)].map((m) => m[0]);
      expect(publicRefs).toEqual(["public.is_legal_notice"]);
    });
  });

  // ---- rule parity with the JS module --------------------------------------------------------

  describe("rule parity with supabase/functions/_shared/rss/legal-notice.ts", () => {
    const T = LEGAL_NOTICE_TITLE_V2_PATTERNS;
    const D = LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS;

    it("carries LEGAL_NOTICE_TITLE_V2_PATTERNS.ENDS_WITH_OFFICE verbatim, applied to the NFC title with the case-sensitive operator", () => {
      expect(T.ENDS_WITH_OFFICE.source).not.toContain("'");
      expect(code).toContain(T.ENDS_WITH_OFFICE.source);
      expect(code).toContain(`v_t ~ '${T.ENDS_WITH_OFFICE.source}'`);
    });

    it.each(Object.entries(D))("carries LEGAL_NOTICE_DESCRIPTION_V2_PATTERNS.%s verbatim, applied to the NFC description", (_name, re) => {
      expect(re.source).not.toContain("'");
      expect(code).toContain(`v_d ~ '${re.source}'`);
    });

    it("uses the case-sensitive operator only (no ~*, no ilike, no lower())", () => {
      expect(code).not.toMatch(/~\*/);
      expect(code).not.toMatch(/\bilike\b/i);
      expect(code).not.toMatch(/\blower\s*\(/i);
      expect(code).not.toMatch(/\bupper\s*\(/i);
    });

    it("every new source is a valid Postgres ARE unchanged (no lookaround, no \\- escape, no \\p class)", () => {
      for (const [name, re] of [...Object.entries(T), ...Object.entries(D)]) {
        expect(re.source, name).not.toContain("(?");
        expect(re.source, name).not.toContain("\\-");
        expect(re.source, name).not.toContain("\\p{");
      }
    });

    it("ENDS_WITH_OFFICE is written with the hyphen last in its class (an ARE bracket expression)", () => {
      expect(T.ENDS_WITH_OFFICE.source.endsWith("[\\s.:;,!-]*$")).toBe(true);
    });

    it("the TS-only MIXED_COURT_NOTICE rule has no SQL twin: none of its sources is in the migration", () => {
      for (const re of Object.values(MIXED_COURT_NOTICE)) expect(code, re.source).not.toContain(re.source);
      // ... nor is its vocabulary (the court-level words are only in the TS rule).
      for (const word of ["asliye|sulh", "mahkemesi'nden", "ilanen tebligat"]) expect(code, word).not.toContain(word);
    });

    it("the five migration-107 sources are not repeated in the new blocks (213 only adds the new rules)", () => {
      for (const re of Object.values(LEGAL_NOTICE_PATTERNS)) {
        expect(code).not.toContain(re.source);
      }
    });
  });

  // ---- cron and data --------------------------------------------------------------------------

  it("leaves the cron and the marker alone: legal_notice_mark() already calls the 3-argument form by name", () => {
    expect(code).not.toMatch(/\bcron\./i);
    expect(code).not.toMatch(/\bperform\b/i);
    expect(code).not.toMatch(/legal_notice_articles/i);
  });

  it("is additive: no drop, no truncate, no policy, no delete, no update, no alter, no new table or index", () => {
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/\bdelete\b/i);
    expect(code).not.toMatch(/\bupdate\b/i);
    expect(code).not.toMatch(/\balter\s+\w+/i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|unique|extension|schema)\b/i);
  });

  it("does not run any backfill or rewrite inside the migration (outside function bodies)", () => {
    const topLevel = code.split("$fn$").filter((_, i) => i % 2 === 0).join("");
    expect(topLevel).not.toMatch(/\bselect\s+public\.legal_notice_mark/i);
    expect(topLevel).not.toMatch(/\binsert\s+into\s+public\./i);
    expect(topLevel).not.toMatch(/\bupdate\s+public\./i);
    expect(topLevel).not.toMatch(/\bdelete\b/i);
    expect(topLevel).not.toMatch(/\bperform\b/i);
  });

  it("writes the ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'213'\s*,\s*'213_legal_notice_tax_court'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });
});

// ---------------------------------------------------------------------------
// Live parity (opt-in): the SQL predicate must agree with the JS predicate on the shared truth tables. Needs a throwaway
// Postgres (>= 13, UTF8) with 107, 210 and 213 applied (tests/migrations/sql/run-live.sh builds it); TAYF_PSQL is the psql
// binary and PGHOST/PGPORT/PGUSER/PGDATABASE select the server. Read-only: SELECTs only.
// ---------------------------------------------------------------------------

describe.runIf(Boolean(process.env.TAYF_PSQL))(
  "migration 213: public.is_legal_notice(text, text, text) agrees with isLegalNotice() on the shared fixtures (live Postgres)",
  () => {
    assertLiveReady("213", { ledger: ["107", "210", "213"], functions: ["public.is_legal_notice(text,text,text)"] });

    function lit(tag: string, value: string | null): string {
      if (value === null) return "null::text";
      // Unique dollar-quote tag per literal; never occurs inside the value.
      expect(value).not.toContain(`$${tag}$`);
      return `$${tag}$${value}$${tag}$::text`;
    }

    function runPsql(sql: string): string {
      return execFileSync(process.env.TAYF_PSQL as string, ["-X", "-At", "-v", "ON_ERROR_STOP=1", "-c", sql], {
        encoding: "utf8",
        env: { ...process.env, PGCLIENTENCODING: "UTF8" },
        maxBuffer: 8 * 1024 * 1024,
      });
    }

    function verdicts(rows: ReadonlyArray<{ title: string; url: string | null; description: string | null }>): string[] {
      const values = rows.map((c, i) => `(${i}, ${lit(`t${i}`, c.title)}, ${lit(`u${i}`, c.url)}, ${lit(`d${i}`, c.description)})`);
      const sql = `select i, public.is_legal_notice(t, u, d) from (values\n${values.join(",\n")}\n) v(i, t, u, d) order by i;`;
      const out = runPsql(sql)
        .split("\n")
        .filter((l) => l.length > 0);
      expect(out).toHaveLength(rows.length);
      return out.map((line, idx) => {
        const [i, v] = line.split("|");
        expect(Number(i), `row order at ${idx}`).toBe(idx);
        return v as string;
      });
    }

    it("returns the SQL verdict of the table for every row (the TS-only mixed-case rows are false in SQL, true in JS)", () => {
      const got = verdicts(LEGAL_NOTICE_V2_CASES);
      LEGAL_NOTICE_V2_CASES.forEach((c, idx) => {
        expect(got[idx], `${c.label}: is_legal_notice(${JSON.stringify(c.title)})`).toBe(c.sqlExpected ? "t" : "f");
        // Every row that has a SQL twin agrees with the JS verdict too.
        if (c.expected === c.sqlExpected) expect(isLegalNotice(c.title, c.url, c.description), c.label).toBe(c.expected);
      });
    });

    it("the title and url rules of 107 are unchanged: the shared 107 table gives the same verdicts through the 3-argument form", () => {
      const got = verdicts(LEGAL_NOTICE_CASES.map((c) => ({ title: c.title, url: c.url ?? null, description: null })));
      LEGAL_NOTICE_CASES.forEach((c, idx) => {
        expect(got[idx], JSON.stringify(c)).toBe(c.expected ? "t" : "f");
      });
    });

    it("the 2-argument function is untouched: the office title is still false there and true in the 3-argument form", () => {
      const out = runPsql(
        "select public.is_legal_notice('KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ', null), public.is_legal_notice('KOZYATAĞI VERGİ DAİRESİ MÜDÜRLÜĞÜ', null, null);",
      ).trim();
      expect(out).toBe("f|t");
    });

    it("the 2-argument body is byte for byte migration 107's", () => {
      const body107 = bodiesOf(readFileSync(MIGRATION_107, "utf8"))[0]!;
      const out = runPsql("select md5(prosrc) from pg_proc where oid = 'public.is_legal_notice(text,text)'::regprocedure;").trim();
      expect(out).toBe(md5(body107));
    });

    it("is NULL-safe: null or empty arguments return false, never null", () => {
      const out = runPsql(
        "select public.is_legal_notice(null, null, null), public.is_legal_notice('', '', ''), public.is_legal_notice('GOL', null, null), public.is_legal_notice(null, null, 'İLANEN TEBLİĞ');",
      ).trim();
      expect(out).toBe("f|f|f|f");
    });

    it("is immutable and security definer, executable by service_role only", () => {
      const out = runPsql(
        "select provolatile, prosecdef, has_function_privilege('anon', oid, 'execute'), has_function_privilege('authenticated', oid, 'execute'), has_function_privilege('service_role', oid, 'execute') from pg_proc where oid = 'public.is_legal_notice(text,text,text)'::regprocedure;",
      ).trim();
      expect(out).toBe("i|t|f|f|t");
    });
  },
);
