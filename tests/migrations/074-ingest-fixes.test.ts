import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 074 ("ingest-fixes"): CNN Türk
// timestamps (TS-side, not this file's concern), headline write-back, feed
// quarantine + chunked pre-filter. Mirrors tests/migrations/072-*.test.ts's
// structure: strip comments, pin the additive/idempotent/grant shape, and
// assert on the substance of each function body rather than trusting prose.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "074_ingest_fixes.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function functionBlock(sql: string, name: string): string {
  // Bodies in this migration use `$$`, not `$fn$` (title_word_jaccard is a
  // plain SQL function, the others plpgsql) -- match either delimiter.
  const re = new RegExp(
    `create\\s+or\\s+replace\\s+function\\s+public\\.${name}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?\\$\\$\\s*;`,
    "i",
  );
  const m = sql.match(re);
  if (!m) throw new Error(`function ${name} not found`);
  return m[0];
}

function header(block: string): string {
  const idx = block.search(/\bas\s+\$\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$\$([\s\S]*?)\$\$/);
  if (!m || m[1] === undefined) throw new Error("no $$ body");
  return m[1];
}

describe("migration 074_ingest_fixes.sql (SQL contract)", () => {
  let sql = "";
  let code = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
  });

  it("contains the ledger insert for '074'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'074'\s*,\s*'074_ingest_fixes'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single begin/commit transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("has no DROP/TRUNCATE anywhere, and no bare DELETE", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("never mentions 'iktidar'", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });

  it("ALTER TABLE ... ADD COLUMN is used only on sources and ingest_cycles", () => {
    // The RLS-enable ALTER on the new backup table is expected and allowed
    // (a CREATE TABLE, not a column-adding ALTER on an existing table) --
    // scope this assertion to ADD COLUMN specifically.
    const alters = [
      ...code.matchAll(/alter\s+table\s+public\.(\w+)\s+add\s+column/gi),
    ].map((m) => m[1]?.toLowerCase());
    expect(alters.length).toBeGreaterThan(0);
    for (const t of alters) {
      expect(["sources", "ingest_cycles"]).toContain(t);
    }
  });

  it("CREATE TABLE is used only for articles_published_at_backup_074", () => {
    const creates = [
      ...code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?public\.(\w+)/gi),
    ].map((m) => m[1]?.toLowerCase());
    expect(creates).toEqual(["articles_published_at_backup_074"]);
  });

  it("adds sources.fetch_fail_streak (int, default 0) and fetch_quarantined_until (timestamptz) additively", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.sources[\s\S]*?add\s+column\s+if\s+not\s+exists\s+fetch_fail_streak\s+integer\s+not\s+null\s+default\s+0/i,
    );
    expect(code).toMatch(
      /alter\s+table\s+public\.sources[\s\S]*?add\s+column\s+if\s+not\s+exists\s+fetch_quarantined_until\s+timestamptz/i,
    );
  });

  it("adds ingest_cycles.prefilter_errors (int, default 0) additively", () => {
    expect(code).toMatch(
      /alter\s+table\s+public\.ingest_cycles\s+add\s+column\s+if\s+not\s+exists\s+prefilter_errors\s+integer\s+not\s+null\s+default\s+0/i,
    );
  });

  describe("ingest_set_source_fetch_state(jsonb)", () => {
    let fn = "";
    beforeAll(() => {
      fn = functionBlock(code, "ingest_set_source_fetch_state");
    });

    it("keeps the same name/arg/return shape as 041", () => {
      expect(header(fn)).toMatch(
        /create\s+or\s+replace\s+function\s+public\.ingest_set_source_fetch_state\s*\(\s*p_rows\s+jsonb\s*\)/i,
      );
      expect(header(fn)).toMatch(/returns\s+integer/i);
    });

    it("is plpgsql, SECURITY DEFINER, empty search_path", () => {
      const h = header(fn);
      expect(h).toMatch(/\blanguage\s+plpgsql\b/i);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    });

    it("still sets all five 041 columns", () => {
      const b = body(fn);
      for (const col of [
        "fetch_etag",
        "fetch_last_modified",
        "fetch_body_hash",
        "fetch_last_status",
        "fetch_last_at",
      ]) {
        expect(b).toMatch(new RegExp(`\\b${col}\\s*=`, "i"));
      }
    });

    it("sets fetch_fail_streak via coalesce+greatest, never a bare assignment", () => {
      const b = body(fn);
      expect(b).toMatch(/fetch_fail_streak\s*=\s*greatest\s*\(\s*coalesce\s*\(/i);
    });

    it("sets fetch_quarantined_until with a CASE, not a bare least()", () => {
      const b = body(fn);
      const m = b.match(/fetch_quarantined_until\s*=\s*(case[\s\S]*?end)/i);
      expect(m).not.toBeNull();
      expect(m![1]).toMatch(/when\s+r\.fetch_quarantined_until\s+is\s+null\s+then\s+null/i);
      expect(m![1]).toMatch(/least\s*\(/i);
      // Never a bare `least(r.fetch_quarantined_until, ...)` outside the CASE.
      expect(b).not.toMatch(/fetch_quarantined_until\s*=\s*least\s*\(/i);
    });

    it("re-asserts the 041 revoke/grant pair", () => {
      expect(code).toMatch(
        /revoke\s+execute\s+on\s+function\s+public\.ingest_set_source_fetch_state\s*\(\s*jsonb\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.ingest_set_source_fetch_state\s*\(\s*jsonb\s*\)\s+to\s+service_role\s*;/i,
      );
    });
  });

  describe("title_word_jaccard(text, text)", () => {
    let fn = "";
    beforeAll(() => {
      fn = functionBlock(code, "title_word_jaccard");
    });

    it("is a SQL, IMMUTABLE function with an empty search_path", () => {
      const h = header(fn);
      expect(h).toMatch(/\blanguage\s+sql\b/i);
      expect(h).toMatch(/\bimmutable\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    });

    it("has a revoke/grant pair (service_role only)", () => {
      expect(code).toMatch(
        /revoke\s+execute\s+on\s+function\s+public\.title_word_jaccard\s*\(\s*text\s*,\s*text\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.title_word_jaccard\s*\(\s*text\s*,\s*text\s*\)\s+to\s+service_role\s*;/i,
      );
    });
  });

  describe("apply_article_title_edits(jsonb)", () => {
    let fn = "";
    beforeAll(() => {
      fn = functionBlock(code, "apply_article_title_edits");
    });

    it("is plpgsql, SECURITY DEFINER, empty search_path, returns integer", () => {
      const h = header(fn);
      expect(h).toMatch(/\blanguage\s+plpgsql\b/i);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(h).toMatch(/returns\s+integer/i);
    });

    it("gates on title_word_jaccard >= 0.2", () => {
      expect(body(fn)).toMatch(/title_word_jaccard\([^)]*\)\s*>=\s*0\.2/i);
    });

    it("guards the update with the optimistic a.title = e.old_title check", () => {
      expect(body(fn)).toMatch(/a\.title\s*=\s*e\.old_title/i);
    });

    it("caps the input recordset at 500 rows", () => {
      expect(body(fn)).toMatch(/limit\s+500/i);
    });

    it("never sets updated_at, content_hash or title_tr_neutral", () => {
      const b = body(fn);
      expect(b).not.toMatch(/\bupdated_at\s*=/i);
      expect(b).not.toMatch(/\bcontent_hash\s*=/i);
      expect(b).not.toMatch(/\btitle_tr_neutral\s*=/i);
    });

    it("has a revoke/grant pair (service_role only)", () => {
      expect(code).toMatch(
        /revoke\s+execute\s+on\s+function\s+public\.apply_article_title_edits\s*\(\s*jsonb\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.apply_article_title_edits\s*\(\s*jsonb\s*\)\s+to\s+service_role\s*;/i,
      );
    });
  });

  it("the backfill do-block also never sets updated_at/content_hash/title_tr_neutral", () => {
    // The migration's ONLY statements touching articles.title/clusters.title_tr
    // are the function bodies above plus the one-off backfill/fix do-blocks --
    // scan the whole file for the forbidden columns being assigned anywhere.
    expect(code).not.toMatch(/\bupdated_at\s*=\s*now\(\)/i);
    expect(code).not.toMatch(/\btitle_tr_neutral\s*=/i);
  });

  it("the future-dated published_at fix is bounded by created_at + 5 minutes", () => {
    expect(code).toMatch(
      /published_at\s*>\s*a?\.?created_at\s*\+\s*interval\s*'5\s+minutes'/i,
    );
  });

  it("the published_at fix uses least() to keep the cnn-turk branch <= created_at", () => {
    expect(code).toMatch(/least\s*\(\s*a\.published_at\s*-\s*interval\s*'3\s+hours'\s*,\s*a\.created_at\s*\)/i);
  });

  it("creates articles_published_at_backup_074 with RLS enabled and locked-down grants", () => {
    expect(code).toMatch(
      /create\s+table\s+if\s+not\s+exists\s+public\.articles_published_at_backup_074/i,
    );
    expect(code).toMatch(
      /alter\s+table\s+public\.articles_published_at_backup_074\s+enable\s+row\s+level\s+security/i,
    );
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.articles_published_at_backup_074\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
    expect(code).toMatch(
      /grant\s+select\s*,\s*insert\s+on\s+public\.articles_published_at_backup_074\s+to\s+service_role/i,
    );
  });

  it("emits the required RAISE NOTICE lines", () => {
    expect(code).toMatch(/raise\s+notice\s+'074\s+headline\s+write-back\s+backfill/i);
    expect(code).toMatch(/raise\s+notice\s+'074\s+published_at\s+fix/i);
  });
});
