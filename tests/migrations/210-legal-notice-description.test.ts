import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  LEGAL_NOTICE_DESCRIPTION_PATTERNS,
  LEGAL_NOTICE_MIN_LETTERS,
  LEGAL_NOTICE_MIN_UPPER_RATIO,
  LEGAL_NOTICE_PATTERNS,
} from "../../supabase/functions/_shared/rss/legal-notice";

// Static SQL-contract test for migration 210 (h168-notices-1): a court or tender
// notice (resmi ilan) that the title rules miss is recognised by its DESCRIPTION.
// The migration adds the 3-argument predicate public.is_legal_notice(p_title,
// p_url, p_description), the SQL twin of the description rules in supabase/
// functions/_shared/rss/legal-notice.ts, keeps the 2-argument function of
// migration 107 untouched, and re-creates public.legal_notice_mark() so the
// existing legal-notice-mark cron marks stored rows with the 3-argument form.
// Comments are stripped before every code assertion (a line scan, no regular
// expression) so prose can never satisfy a guard. The rule-parity block compares
// the SQL against the JS module's exported regex sources. The 3-argument SQL was
// also run against a throwaway Postgres 15 on the same fixtures; that run is not
// part of this file (no database in plain `npm test`).

const MIGRATIONS = resolve(__dirname, "..", "..", "supabase", "migrations");
const MIGRATION = resolve(MIGRATIONS, "210_legal_notice_description.sql");
const MIGRATION_107 = resolve(MIGRATIONS, "107_legal_notice_articles.sql");

/** sha256 of the 2-argument is_legal_notice body of migration 107 (the live body is byte-identical, read with pg_get_functiondef on 2026-11-12). */
const BODY_107_IS_LEGAL_NOTICE_SHA256 = "f28c49cb47fbd5529c5834347c52a974621fcffe4ae0d3cdc923a9196f5deefc";
/** sha256 of the legal_notice_mark body of migration 107 (also byte-identical on production). */
const BODY_107_MARK_SHA256 = "4eceacedd54b65f8aaf10c378fda7061ba7711c5034c23398174f2007d9020f1";

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

// Every `create or replace function public.<name>(...) returns <t> language
// plpgsql [immutable] security definer set search_path = '' as $fn$ ... $fn$`.
// A function that deviates from that header shape is simply not found, which
// fails the tests below (so "security definer + empty search_path" is asserted
// structurally, per function).
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
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

describe("migration 210_legal_notice_description.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Array<FnBlock & { name: string }> = [];
  let predicate: FnBlock | undefined;
  let marker: FnBlock | undefined;

  beforeAll(() => {
    expect(existsSync(MIGRATION), "210_legal_notice_description.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
    predicate = fns.find((f) => f.name === "is_legal_notice");
    marker = fns.find((f) => f.name === "legal_notice_mark");
  });

  it("sanity: comment stripping is non-vacuous (header says STEP 0 FINDINGS, code does not)", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(code).not.toMatch(/STEP 0 FINDINGS/);
  });

  it("records the Step 0 findings, the design, the replay, the deploy order and the rollback in the header", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(raw).toMatch(/pg_get_functiondef/);
    expect(raw).toMatch(/byte for byte/i);
    expect(raw).toMatch(/legal-notice-mark/);
    expect(raw).toMatch(/30 hours/);
    expect(raw).toMatch(/DESIGN/);
    expect(raw).toMatch(/REPLAY/);
    expect(raw).toMatch(/BACKFILL/i);
    expect(raw).toMatch(/ROLLBACK/i);
    expect(raw).toMatch(/4734/);
    expect(raw).toMatch(/İlan-/);
  });

  it("documents that the description rules are not a bare tender-law test (real news carries the law number)", () => {
    expect(raw).toMatch(/Kızılay/);
    expect(raw).toMatch(/mixed-case/i);
  });

  it("never mentions the forbidden zone word (zone-parity guard)", () => {
    expect(raw.toLowerCase()).not.toContain("iktidar");
  });

  // ---- the 2-argument function stays exactly as migration 107 left it ----------

  describe("the 2-argument is_legal_notice and the 107 marker are the references", () => {
    it("migration 107's function bodies still hash to the production-verified values (nothing edited them)", () => {
      const bodies = bodiesOf(readFileSync(MIGRATION_107, "utf8"));
      expect(bodies).toHaveLength(2);
      expect(sha256(bodies[0]!)).toBe(BODY_107_IS_LEGAL_NOTICE_SHA256);
      expect(sha256(bodies[1]!)).toBe(BODY_107_MARK_SHA256);
    });

    it("210 never creates, replaces, drops or alters the 2-argument form", () => {
      expect(code).not.toMatch(/\bdrop\s+function\b/i);
      expect(code).not.toMatch(/p_url\s+text\s+default\s+null/i);
      expect(code).not.toMatch(/\balter\s+function\b/i);
      // The only is_legal_notice definition is the 3-argument one.
      const defs = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.is_legal_notice\s*\(([\s\S]*?)\)\s*returns/gi)];
      expect(defs).toHaveLength(1);
      expect(collapse(defs[0]![1]!)).toBe("p_title text, p_url text, p_description text");
    });

    it("the 3-argument form has no default on p_description (a 2-argument call can only reach the 2-argument function)", () => {
      expect(collapse(predicate?.args ?? "")).toBe("p_title text, p_url text, p_description text");
      expect(predicate?.args ?? "").not.toMatch(/\bdefault\b/i);
    });
  });

  // ---- functions -------------------------------------------------------------

  it("defines exactly two functions, both SECURITY DEFINER with an empty search_path", () => {
    expect(fns.map((f) => f.name).sort()).toEqual(["is_legal_notice", "legal_notice_mark"]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(2);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(2);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(2);
  });

  it("is_legal_notice(p_title text, p_url text, p_description text) returns boolean and is immutable", () => {
    expect(predicate).toBeDefined();
    expect(predicate!.returns).toBe("boolean");
    expect(predicate!.immutable).toBe(true);
  });

  it("legal_notice_mark(p_from timestamptz, p_to timestamptz) keeps its signature, returns integer and is not immutable", () => {
    expect(marker).toBeDefined();
    expect(collapse(marker!.args)).toBe("p_from timestamptz, p_to timestamptz");
    expect(marker!.returns).toBe("integer");
    expect(marker!.immutable).toBe(false);
  });

  it.each([
    ["is_legal_notice", "text\\s*,\\s*text\\s*,\\s*text"],
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

  it.each([
    ["is_legal_notice", "text, text, text"],
    ["legal_notice_mark", "timestamptz, timestamptz"],
  ])("comments on %s(%s)", (name, sig) => {
    expect(code).toMatch(
      new RegExp(`comment\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${sig.split(", ").join("\\s*,\\s*")}\\s*\\)\\s+is\\s+'`, "i"),
    );
  });

  it("never grants anything to anon/authenticated/public, and no write-class grant exists at all", () => {
    expect(code).not.toMatch(/grant\s+[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    expect(code).not.toMatch(/grant\s+(select|insert|update|delete|truncate|maintain|references|trigger|all)\b/i);
  });

  // ---- predicate: shape --------------------------------------------------------

  describe("3-argument is_legal_notice body", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(predicate?.body ?? "");
    });

    it("starts from the 2-argument verdict, so the title and url rules cannot change", () => {
      const first = body.indexOf("public.is_legal_notice(p_title, p_url)");
      expect(first).toBeGreaterThanOrEqual(0);
      expect(body).toMatch(/if public\.is_legal_notice\(p_title, p_url\) then return true; end if;/);
      // ... and nothing before it can return.
      expect(body.slice(0, first)).not.toMatch(/\breturn\b/);
    });

    it("returns false for a NULL or empty description right after the 2-argument verdict", () => {
      expect(body).toMatch(/if p_description is null or p_description = '' then return false; end if;/);
      expect(body.indexOf("p_description is null")).toBeGreaterThan(body.indexOf("public.is_legal_notice(p_title, p_url)"));
    });

    it("NFC-normalises the description and the title (decomposed İ) before any pattern test", () => {
      expect(body).toMatch(/pg_catalog\.normalize\(p_description, 'NFC'\)/);
      expect(body).toMatch(/pg_catalog\.normalize\(p_title, 'NFC'\)/);
      expect(body.indexOf("pg_catalog.normalize(p_description, 'NFC')")).toBeLessThan(body.indexOf("v_d ~"));
    });

    it("counts upper and lower Turkish/ASCII letters with the same sets as migration 107", () => {
      expect(body).toMatch(/'\[\^A-ZÇĞİÖŞÜÂÎÛ\]'/);
      expect(body).toMatch(/'\[\^a-zçğıöşüâîû\]'/);
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

    it("falls through to false when nothing matched", () => {
      expect(body).toMatch(/return false; end$/);
    });
  });

  // ---- predicate: rule parity with the JS module ---------------------------------

  describe("rule parity with supabase/functions/_shared/rss/legal-notice.ts", () => {
    const P = LEGAL_NOTICE_DESCRIPTION_PATTERNS;

    it.each(Object.entries(P))("carries LEGAL_NOTICE_DESCRIPTION_PATTERNS.%s verbatim", (_name, re) => {
      expect(re.source).not.toContain("'");
      expect(code).toContain(re.source);
    });

    it("applies each pattern to the NFC description with the case-sensitive operator", () => {
      expect(code).toContain(`v_d ~ '${P.DESCRIPTION_ILAN_DASH.source}'`);
      expect(code).toContain(`v_d ~ '${P.DESCRIPTION_TENDER_LAW.source}'`);
      expect(code).toContain(`v_d ~ '${P.DESCRIPTION_TENDER_REGISTRY.source}'`);
      expect(code).toContain(`v_d ~ '${P.DESCRIPTION_STARTS_WITH_ILAN.source}'`);
      expect(code).not.toMatch(/v_d\s*~\*/);
      expect(code).not.toMatch(/\bilike\b/i);
    });

    it("D1 is decided on the description alone; D2 needs a title that is mostly upper case", () => {
      const body = collapse(predicate?.body ?? "");
      const d1 = body.indexOf(`v_d ~ '${P.DESCRIPTION_ILAN_DASH.source}'`);
      const law = body.indexOf(`v_d ~ '${P.DESCRIPTION_TENDER_LAW.source}'`);
      const registry = body.indexOf(`v_d ~ '${P.DESCRIPTION_TENDER_REGISTRY.source}'`);
      const caps = body.indexOf(`v_d ~ '${P.DESCRIPTION_STARTS_WITH_ILAN.source}'`);
      const gate = body.indexOf("v_up + v_lo >= 8");
      expect(d1).toBeGreaterThan(0);
      // D1 returns on its own, before any title letter is counted.
      expect(body.slice(d1, law)).toMatch(/then return true; end if;/);
      expect(body.slice(d1, law)).not.toContain("v_up");
      // The three D2 markers come before the (more expensive) letter count and the gate.
      expect(law).toBeGreaterThan(d1);
      expect(registry).toBeGreaterThan(law);
      expect(caps).toBeGreaterThan(registry);
      expect(body.indexOf("pg_catalog.regexp_replace(v_t")).toBeGreaterThan(caps);
      expect(gate).toBeGreaterThan(caps);
    });

    it("uses the same letter gates as the JS module (8 letters, 0.85 uppercase ratio), once, and no 3-letter floor", () => {
      expect(LEGAL_NOTICE_MIN_LETTERS).toBe(8);
      expect(LEGAL_NOTICE_MIN_UPPER_RATIO).toBe(0.85);
      const body = collapse(predicate?.body ?? "");
      expect([...body.matchAll(/v_up \+ v_lo >= 8\b/g)]).toHaveLength(1);
      expect([...body.matchAll(/v_up >= 0\.85 \* \(v_up \+ v_lo\)/g)]).toHaveLength(1);
      expect(body).not.toMatch(/v_up \+ v_lo >= 3\b/);
      expect(body).not.toMatch(/\b0\.(?!85\b)\d+/);
    });

    it("every description source is a valid Postgres ARE unchanged (no lookaround, no \\- escape, no \\p class)", () => {
      for (const [name, re] of Object.entries(P)) {
        expect(re.source, name).not.toContain("(?");
        expect(re.source, name).not.toContain("\\-");
        expect(re.source, name).not.toContain("\\p{");
      }
    });

    it("the five migration-107 sources are not repeated here (210 only adds the description rules)", () => {
      for (const re of Object.values(LEGAL_NOTICE_PATTERNS)) {
        expect(code).not.toContain(re.source);
      }
    });
  });

  // ---- marker --------------------------------------------------------------------

  describe("legal_notice_mark body", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(marker?.body ?? "");
    });

    it("keeps the window guard of migration 107 (both bounds, ordered, at most 2 days) before the insert", () => {
      expect(body).toMatch(/p_from is null or p_to is null/);
      expect(body).toMatch(/p_to <= p_from/);
      expect(body).toMatch(/p_to - p_from > interval '2 days'/);
      expect(body).toMatch(/raise exception/);
      expect(body.indexOf("raise exception")).toBeLessThan(body.indexOf("insert into"));
    });

    it("selects the description and calls the 3-argument form over the half-open window, idempotently, and returns the row count", () => {
      expect(body).toMatch(
        /insert into public\.legal_notice_articles \(article_id, published_at\) select a\.id, a\.published_at from public\.articles a where a\.published_at >= p_from and a\.published_at < p_to and public\.is_legal_notice\(a\.title, a\.url, a\.description\) on conflict \(article_id\) do nothing;/,
      );
      expect(body).toMatch(/get diagnostics \w+ = row_count;/);
      expect(body).toMatch(/return \w+;\s*end$/);
    });

    it("no longer calls the 2-argument form", () => {
      expect(body).not.toMatch(/is_legal_notice\(a\.title, a\.url\)/);
    });

    it("differs from migration 107's marker only in the predicate call (same guard, same insert shape)", () => {
      const old = collapse(bodiesOf(readFileSync(MIGRATION_107, "utf8"))[1]!);
      const rewritten = body.split("is_legal_notice(a.title, a.url, a.description)").join("is_legal_notice(a.title, a.url)");
      expect(rewritten).toBe(old);
    });

    it("never deletes or updates (marks only grow)", () => {
      expect(body).not.toMatch(/\bdelete\b|\bupdate\b|\btruncate\b/i);
    });
  });

  // ---- cron and data -----------------------------------------------------------------

  it("leaves the cron alone: the existing legal-notice-mark job already calls legal_notice_mark()", () => {
    expect(code).not.toMatch(/\bcron\./i);
    expect(code).not.toMatch(/\bperform\b/i);
  });

  it("is additive: no drop, no truncate, no policy, no delete, no alter table, no new table or index", () => {
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/create\s+policy/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\s+(table|index|unique|extension|schema)\b/i);
  });

  it("does not run any backfill or rewrite inside the migration (outside function bodies)", () => {
    const topLevel = code.split("$fn$").filter((_, i) => i % 2 === 0).join("");
    expect(topLevel).not.toMatch(/\bselect\s+public\.legal_notice_mark/i);
    expect(topLevel).not.toMatch(/\binsert\s+into\s+public\.legal_notice_articles\b/i);
    expect(topLevel).not.toMatch(/\bupdate\s+public\./i);
    expect(topLevel).not.toMatch(/\bdelete\b/i);
    expect(topLevel).not.toMatch(/\bperform\b/i);
  });

  it("writes the ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'210'\s*,\s*'210_legal_notice_description'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });
});
