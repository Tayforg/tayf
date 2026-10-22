import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 105 ("Çerçeve candidate pool").
//
// 072 made framing_next_headline index-driven, but it still reads
// jev_shadow_predictions and the articles heap on every draw. With
// Supabase Micro compute (256 MB shared_buffers vs a 5.2 GB database) a cold
// run costs ~2 s (072 measured 2,077 ms fully cold) and a worse one blows
// PostgREST's 8 s statement_timeout: api-1 saw 14 of 27 draws return 500 at
// ~8.1 s.
//
// 105 moves the expensive part out of the request path. A pg_cron job
// (framing_candidate_pool_refresh, every 5 min) materialises 072's
// eligibility set into public.framing_candidate_pool, and the draw reads only
// that small table plus framing_votes. Per-session exclusion and the
// newest-300 cut stay in the draw, so they remain exact.
//
// Static only (no database here): the SQL is also dry-run on a throwaway
// local Postgres, see the deploy notes.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "105_framing_candidate_pool.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

/** Strip `--` line comments so prose can never satisfy a code guard. */
function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

/** The `create or replace function public.<name>(...) ... $fn$ ... $fn$;` block. */
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

/** Only the SQL body between the $fn$ quotes. */
function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

describe("migration 105_framing_candidate_pool.sql (SQL contract)", () => {
  let sql = "";
  let code = "";
  let draw105 = "";
  let draw072 = "";
  let refresh = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    sql = read(path);
    code = stripComments(sql);
    draw105 = functionBlock(code, "framing_next_headline");
    refresh = functionBlock(code, "framing_candidate_pool_refresh");
    draw072 = functionBlock(
      stripComments(read(resolve(MIGRATIONS_DIR, "072_framing_draw_fast.sql"))),
      "framing_next_headline",
    );
  });

  describe("shape", () => {
    it("is wrapped in a single transaction", () => {
      expect(code).toMatch(/^\s*begin\s*;/im);
      expect(code).toMatch(/\bcommit\s*;\s*$/i);
      expect(code.match(/^\s*begin\s*;/gim)).toHaveLength(1);
      expect(code.match(/\bcommit\s*;/gi)).toHaveLength(1);
    });

    it("contains the ledger insert for '105'", () => {
      expect(code).toMatch(
        /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'105'\s*,\s*'105_framing_candidate_pool'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
      );
    });

    it("is additive: no DROP, no ALTER of an existing table's columns, no TRUNCATE", () => {
      expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
      expect(code).not.toMatch(/\balter\s+table\s+(?!public\.framing_candidate_pool\s+enable\s+row\s+level\s+security)/i);
      expect(code).not.toMatch(/\btruncate\b/i);
    });

    it("names no government-zone label anywhere, comments included (zone-parity scans the raw file)", () => {
      expect(sql).not.toContain("iktidar");
    });
  });

  describe("table public.framing_candidate_pool", () => {
    it("is created idempotently with the article FK (cascade) and the three data columns", () => {
      expect(code).toMatch(/create\s+table\s+if\s+not\s+exists\s+public\.framing_candidate_pool\s*\(/i);
      expect(code).toMatch(
        /article_id\s+uuid\s+primary\s+key\s+references\s+public\.articles\s*\(\s*id\s*\)\s+on\s+delete\s+cascade/i,
      );
      expect(code).toMatch(/\btitle\s+text\b/i);
      expect(code).toMatch(/\bpublished_at\s+timestamptz\s+not\s+null\b/i);
      expect(code).toMatch(/\brefreshed_at\s+timestamptz\s+not\s+null\s+default\s+now\(\)/i);
    });

    it("has a published_at desc index for the newest-300 cut", () => {
      expect(code).toMatch(
        /create\s+index\s+if\s+not\s+exists\s+framing_candidate_pool_published_idx\s+on\s+public\.framing_candidate_pool\s*\(\s*published_at\s+desc\s*\)/i,
      );
    });

    it("enables RLS and defines no policy", () => {
      expect(code).toMatch(
        /alter\s+table\s+public\.framing_candidate_pool\s+enable\s+row\s+level\s+security\s*;/i,
      );
      expect(code).not.toMatch(/\bcreate\s+policy\b/i);
    });

    it("strips every Supabase default grant, including the PG17 MAINTAIN privilege", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+public\.framing_candidate_pool\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      // 096's guarded block: MAINTAIN does not exist before PG17.
      expect(code).toMatch(/current_setting\(\s*'server_version_num'\s*\)::int\s*>=\s*170000/i);
      expect(code).toMatch(
        /execute\s+'revoke\s+maintain\s+on\s+public\.framing_candidate_pool\s+from\s+anon\s*,\s*authenticated'/i,
      );
    });

    it("grants nothing on the table to anyone (only the owner-run SECURITY DEFINER functions touch it)", () => {
      expect(code).not.toMatch(/\bgrant\b[^;]*\bon\s+(table\s+)?public\.framing_candidate_pool\b/i);
    });

    it("never grants anything to anon or authenticated anywhere in the file", () => {
      expect(code).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    });
  });

  describe("framing_candidate_pool_refresh()", () => {
    it("is a SECURITY DEFINER plpgsql function returning integer with an empty search_path", () => {
      const h = header(refresh);
      expect(h).toMatch(/\bfunction\s+public\.framing_candidate_pool_refresh\s*\(\s*\)/i);
      expect(h).toMatch(/\breturns\s+integer\b/i);
      expect(h).toMatch(/\blanguage\s+plpgsql\b/i);
      expect(h).toMatch(/\bsecurity\s+definer\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
    });

    it("takes a transaction advisory lock and returns 0 when another run holds it", () => {
      const b = body(refresh);
      expect(b).toMatch(
        /pg_catalog\.pg_try_advisory_xact_lock\(\s*pg_catalog\.hashtext\(\s*'framing_candidate_pool_refresh'\s*\)::bigint\s*\)/i,
      );
      expect(b).toMatch(/return\s+0\s*;/i);
    });

    it("uses one statement-stable clock (v_now), never a bare now()", () => {
      const b = body(refresh);
      expect(b).toMatch(/v_now\s*:=\s*pg_catalog\.now\(\)/i);
      expect(b).not.toMatch(/(?<![\w.])now\(\)/i);
    });

    it("copies 072's eligibility exactly (54 h prediction window, 0.7, 48 h article window, active non-wire outlet)", () => {
      const b = body(refresh);
      expect(b).toMatch(/\bas\s+materialized\s*\(/i);
      expect(b).toMatch(/from\s+public\.jev_shadow_predictions\s+p\b/i);
      expect(b).toMatch(/\.task\s*=\s*'politics'/i);
      expect(b).toMatch(/\.created_at\s*>=\s*v_now\s*-\s*interval\s*'54 hours'/i);
      expect(b).toMatch(/\.jev_prob\s*>=\s*0\.7\b/i);
      expect(b).toMatch(/\.article_id\s+is\s+not\s+null/i);
      expect(b).toMatch(/select\s+distinct\s+p\.article_id/i);
      expect(b).toMatch(/join\s+public\.articles\s+a\s+on\s+a\.id\s*=/i);
      expect(b).toMatch(/join\s+public\.sources\s+s\s+on\s+s\.id\s*=\s*a\.source_id/i);
      expect(b).toMatch(/\.published_at\s*>=\s*v_now\s*-\s*interval\s*'48 hours'/i);
      expect(b).toMatch(/\bs\.active\b/i);
      expect(b).toMatch(/coalesce\s*\(\s*s\.kind\s*,\s*'outlet'\s*\)\s*<>\s*'wire'/i);
    });

    it("stores the FULL eligible set: no session anti-join and no newest-300 cut", () => {
      const b = body(refresh);
      expect(b).not.toMatch(/limit\s+300/i);
      expect(b).not.toMatch(/session_hash/i);
      expect(b).not.toMatch(/framing_votes/i);
      expect(b).not.toMatch(/\blimit\b/i);
    });

    it("deletes pool rows that are no longer eligible, in a data-modifying CTE, then upserts the fresh set", () => {
      const b = body(refresh);
      expect(b).toMatch(
        /\bgone\s+as\s*\(\s*delete\s+from\s+public\.framing_candidate_pool\b[\s\S]*?not\s+(exists|in)\b[\s\S]*?\bfresh\b/i,
      );
      expect(b).toMatch(/insert\s+into\s+public\.framing_candidate_pool\b/i);
      expect(b).toMatch(
        /on\s+conflict\s*\(\s*article_id\s*\)\s*do\s+update\s+set[\s\S]*?title\s*=\s*excluded\.title[\s\S]*?published_at\s*=\s*excluded\.published_at[\s\S]*?refreshed_at\s*=\s*excluded\.refreshed_at/i,
      );
    });

    it("returns the pool size", () => {
      expect(body(refresh)).toMatch(
        /return\s*\(\s*select\s+count\(\*\)::int\s+from\s+public\.framing_candidate_pool\s*\)\s*;/i,
      );
    });

    it("is revoked from anon/authenticated/public and executable by service_role only, with a comment", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.framing_candidate_pool_refresh\s*\(\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.framing_candidate_pool_refresh\s*\(\s*\)\s+to\s+service_role\s*;/i,
      );
      expect(code).toMatch(
        /comment\s+on\s+function\s+public\.framing_candidate_pool_refresh\s*\(\s*\)\s+is/i,
      );
    });
  });

  describe("framing_next_headline(text)", () => {
    it("keeps 072's signature, return shape and attributes (the route is untouched)", () => {
      expect(norm(header(draw105))).toBe(norm(header(draw072)));
      expect(header(draw105)).toMatch(
        /create\s+or\s+replace\s+function\s+public\.framing_next_headline\s*\(\s*p_session_hash\s+text\s*\)/i,
      );
      expect(header(draw105)).toMatch(
        /returns\s+table\s*\(\s*article_id\s+uuid\s*,\s*title\s+text\s*\)/i,
      );
      expect(header(draw105)).toMatch(/\blanguage\s+sql\b/i);
      expect(header(draw105)).toMatch(/\bstable\b/i);
      expect(header(draw105)).toMatch(/\bsecurity\s+definer\b/i);
      expect(header(draw105)).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(header(draw105)).not.toMatch(/\bvolatile\b/i);
    });

    it("reads the pool and nothing else cold: no predictions table, no articles heap, no sources", () => {
      const b = body(draw105);
      expect(b).toMatch(/\bpublic\.framing_candidate_pool\b/i);
      expect(b).not.toMatch(/jev_shadow_predictions/i);
      expect(b).not.toMatch(/public\.articles\b/i);
      expect(b).not.toMatch(/public\.sources\b/i);
      const firstFrom = b.match(/\bfrom\s+public\.(\w+)/i);
      expect(firstFrom?.[1]).toBe("framing_candidate_pool");
    });

    it("re-checks the 48 h window at draw time (the pool is up to 5 min stale)", () => {
      expect(body(draw105)).toMatch(/\.published_at\s*>=\s*now\(\)\s*-\s*interval\s*'48 hours'/i);
    });

    it("keeps the not-voted-by-this-session anti-join and the newest-300 cut at draw time", () => {
      const b = body(draw105);
      expect(b).toMatch(
        /not\s+exists\s*\(\s*select\s+1\s+from\s+public\.framing_votes\s+v\s+where\s+v\.article_id\s*=\s*p\.article_id\s+and\s+v\.session_hash\s*=\s*p_session_hash\s*\)/i,
      );
      expect(b).toMatch(/order\s+by\s+p\.published_at\s+desc\s+limit\s+300/i);
    });

    it("keeps the <5-votes-first random draw of one row", () => {
      const b = body(draw105);
      expect(b).toMatch(/left\s+join\s+public\.framing_votes\s+v\s+on\s+v\.article_id\s*=/i);
      expect(b).toMatch(
        /order\s+by\s*\(\s*t\.vote_count\s*>=\s*5\s*\)\s*asc\s*,\s*random\(\)\s+limit\s+1\s*;?\s*$/i,
      );
    });

    it("leaves tallied and the final select exactly as 072 wrote them", () => {
      const tail = (b: string) => norm(b.slice(b.search(/\btallied\s+as\s*\(/i)));
      expect(tail(body(draw105))).toBe(tail(body(draw072)));
      expect(tail(body(draw105)).length).toBeGreaterThan(100);
    });

    it("selects the same two columns the route reads (candidate_id, candidate_title)", () => {
      const b = body(draw105);
      expect(b).toMatch(/p\.article_id\s+as\s+candidate_id/i);
      expect(b).toMatch(/p\.title\s+as\s+candidate_title/i);
    });

    it("re-asserts 072's grants and refreshes the comment", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.framing_next_headline\s*\(\s*text\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.framing_next_headline\s*\(\s*text\s*\)\s+to\s+service_role\s*;/i,
      );
      expect(code).toMatch(
        /comment\s+on\s+function\s+public\.framing_next_headline\s*\(\s*text\s*\)\s+is/i,
      );
    });

    it("the route still calls the same RPC with the same argument name", () => {
      const route = read(
        resolve(REPO_ROOT, "src", "app", "api", "oyun", "cerceve", "next", "route.ts"),
      );
      expect(route).toMatch(/\.rpc\(\s*"framing_next_headline"\s*,\s*\{\s*p_session_hash:/);
    });
  });

  describe("pg_cron schedule", () => {
    it("skips cleanly when pg_cron is absent", () => {
      expect(code).toMatch(/extname\s*=\s*'pg_cron'/i);
      expect(code).toMatch(/raise\s+notice\s+'pg_cron not installed/i);
    });

    it("unschedules any existing job, then schedules every 5 minutes", () => {
      expect(code).toMatch(
        /jobname\s*=\s*'framing-candidate-pool-refresh'[\s\S]*?cron\.unschedule\(\s*'framing-candidate-pool-refresh'\s*\)/i,
      );
      expect(code).toMatch(
        /cron\.schedule\(\s*'framing-candidate-pool-refresh'\s*,\s*'\*\/5 \* \* \* \*'/i,
      );
      expect(code.search(/cron\.unschedule\(/i)).toBeLessThan(code.search(/cron\.schedule\(/i));
    });

    it("raises statement_timeout before the refresh select in the job command", () => {
      const m = code.match(/\$sql\$([\s\S]*?)\$sql\$/);
      expect(m).not.toBeNull();
      const cmd = (m as RegExpMatchArray)[1] as string;
      expect(cmd).toMatch(/set\s+statement_timeout\s*=\s*'2min'/i);
      expect(cmd).toMatch(/select\s+public\.framing_candidate_pool_refresh\(\)\s*;/i);
      expect(cmd.search(/statement_timeout/i)).toBeLessThan(
        cmd.search(/select\s+public\.framing_candidate_pool_refresh/i),
      );
    });
  });

  describe("initial population", () => {
    it("populates the pool once, under a raised local statement_timeout", () => {
      const setIdx = code.search(/set\s+local\s+statement_timeout\s*=\s*'120s'\s*;/i);
      expect(setIdx).toBeGreaterThan(-1);
      const calls = [...code.matchAll(/^\s*select\s+public\.framing_candidate_pool_refresh\(\)\s*;/gim)];
      expect(calls).toHaveLength(1);
      expect((calls[0] as RegExpMatchArray).index).toBeGreaterThan(setIdx);
    });

    it("populates only after both functions and the table exist, and before the ledger insert", () => {
      const calls = [...code.matchAll(/^\s*select\s+public\.framing_candidate_pool_refresh\(\)\s*;/gim)];
      const at = (calls[0] as RegExpMatchArray).index as number;
      expect(at).toBeGreaterThan(code.search(/create\s+table\s+if\s+not\s+exists\s+public\.framing_candidate_pool/i));
      expect(at).toBeGreaterThan(
        code.search(/create\s+or\s+replace\s+function\s+public\.framing_candidate_pool_refresh/i),
      );
      expect(at).toBeLessThan(code.search(/insert\s+into\s+supabase_migrations\.schema_migrations/i));
    });
  });

  it("documents the evidence, the semantic deltas and the rollback in the header", () => {
    const head = sql.slice(0, sql.search(/^\s*begin\s*;/im));
    expect(head).toMatch(/14 of 27/);
    expect(head).toMatch(/8\.1 s/);
    expect(head).toMatch(/2,077 ms/);
    expect(head).toMatch(/5 min/i);
    expect(head).toMatch(/48 h/);
    expect(head).toMatch(/rollback/i);
    expect(head).toMatch(/unschedule/i);
  });
});
