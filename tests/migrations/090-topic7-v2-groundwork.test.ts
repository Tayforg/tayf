import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { JEV_TOPIC7_CHOICES } from "../../supabase/functions/_shared/jev.ts";

// ---------------------------------------------------------------------------
// Static SQL-contract test for migration 090 (topic7 v2 groundwork, T7a).
//
// This is the deputy's amended version of the lead's 085: it is renumbered
// (083 -> 088, 085 -> 090), and it does NOT drop 067's single-arg
// cluster_topics_refresh(interval) overload -- migrations must stay
// additive. The topic7-fingerprint pin is deferred to T7b as a new function.
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, "..", "..");
const MIGRATIONS_DIR = resolve(REPO_ROOT, "supabase", "migrations");
const MIGRATION = "090_topic7_v2_groundwork.sql";

function read(path: string): string {
  return readFileSync(path, "utf8");
}

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

function header(block: string): string {
  const idx = block.search(/\bas\s+\$fn\$/i);
  return block.slice(0, idx);
}

function body(block: string): string {
  const m = block.match(/\$fn\$([\s\S]*?)\$fn\$/);
  if (!m || m[1] === undefined) throw new Error("no $fn$ body");
  return m[1];
}

describe("migration 090_topic7_v2_groundwork.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fnSection = "";
  let fnYardstickRefresh = "";
  let fnYardsticks = "";
  let fnQueue = "";
  let fnNext = "";
  let fnScorecard = "";

  beforeAll(() => {
    const path = resolve(MIGRATIONS_DIR, MIGRATION);
    expect(existsSync(path), `${MIGRATION} must exist`).toBe(true);
    raw = read(path);
    code = stripComments(raw);
    fnSection = functionBlock(code, "jev_url_section_topic");
    fnYardstickRefresh = functionBlock(code, "jev_topic7_yardstick_refresh");
    fnYardsticks = functionBlock(code, "jev_topic7_yardsticks");
    fnQueue = functionBlock(code, "jev_shadow_queue");
    fnNext = functionBlock(code, "jev_gold_next_prioritized");
    fnScorecard = functionBlock(code, "jev_gold_topic7_scorecard");
  });

  it("contains the ledger row for '090'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'090'\s*,\s*'090_topic7_v2_groundwork'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in a single transaction", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("has no leftover 083-087 references", () => {
    expect(raw).not.toMatch(/\b08[3-7]\b/);
  });

  it("has NO DROP of any kind and never mentions cluster_topics_refresh", () => {
    expect(code).not.toMatch(/\bdrop\s+(table|function|index|column|policy|view)\b/i);
    expect(code.toLowerCase()).not.toContain("cluster_topics_refresh");
  });

  it("is additive only: no TRUNCATE, DELETE or UPDATE of an existing table", () => {
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\.(?!clusters\b)/i);
  });

  describe("public.jev_url_section_topic(text) -- immutable helper", () => {
    it("is immutable with an empty search_path and NOT security definer", () => {
      const h = header(fnSection);
      expect(h).toMatch(/\bimmutable\b/i);
      expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      expect(h).not.toMatch(/\bsecurity\s+definer\b/i);
    });

    it("the section-map labels are a subset of JEV_TOPIC7_CHOICES", () => {
      const b = body(fnSection);
      const matches = [...b.matchAll(/then\s+'([a-z]+)'/gi)].map((m) => m[1]);
      expect(matches.length).toBeGreaterThan(0);
      for (const label of matches) {
        expect([...JEV_TOPIC7_CHOICES]).toContain(label);
      }
    });

    it("revokes from anon/authenticated/public and grants execute to service_role", () => {
      expect(code).toMatch(
        /revoke\s+all\s+on\s+function\s+public\.jev_url_section_topic\s*\(\s*text\s*\)\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
      expect(code).toMatch(
        /grant\s+execute\s+on\s+function\s+public\.jev_url_section_topic\s*\(\s*text\s*\)\s+to\s+service_role\s*;/i,
      );
    });
  });

  describe("public.jev_topic7_yardstick_daily table", () => {
    it("has RLS enabled and is revoked from anon/authenticated/public", () => {
      expect(code).toMatch(
        /alter\s+table\s+public\.jev_topic7_yardstick_daily\s+enable\s+row\s+level\s+security\s*;/i,
      );
      expect(code).toMatch(
        /revoke\s+all\s+on\s+public\.jev_topic7_yardstick_daily\s+from\s+anon\s*,\s*authenticated\s*,\s*public\s*;/i,
      );
    });
  });

  describe("SECURITY DEFINER functions", () => {
    for (const [label, block] of [
      ["jev_topic7_yardstick_refresh(integer)", () => fnYardstickRefresh],
      ["jev_topic7_yardsticks(integer)", () => fnYardsticks],
      ["jev_shadow_queue(integer)", () => fnQueue],
      ["jev_gold_next_prioritized(smallint)", () => fnNext],
      ["jev_gold_topic7_scorecard()", () => fnScorecard],
    ] as const) {
      it(`${label} is SECURITY DEFINER with an empty search_path`, () => {
        const h = header(block());
        expect(h).toMatch(/\bsecurity\s+definer\b/i);
        expect(h).toMatch(/\bset\s+search_path\s*=\s*''/i);
      });
    }

    it("each function has a matching revoke + grant to service_role", () => {
      const sigs = [
        "jev_topic7_yardstick_refresh\\s*\\(\\s*integer\\s*\\)",
        "jev_topic7_yardsticks\\s*\\(\\s*integer\\s*\\)",
        "jev_shadow_queue\\s*\\(\\s*integer\\s*\\)",
        "jev_gold_next_prioritized\\s*\\(\\s*smallint\\s*\\)",
        "jev_gold_topic7_scorecard\\s*\\(\\s*\\)",
      ];
      for (const sig of sigs) {
        expect(code).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${sig}\\s+from\\s+anon\\s*,\\s*authenticated\\s*,\\s*public\\s*;`, "i"));
        expect(code).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${sig}\\s+to\\s+service_role\\s*;`, "i"));
      }
    });
  });

  it("the queue header (signature plus returns table) equals 061's shape", () => {
    const h = header(fnQueue).replace(/\s+/g, " ").trim();
    expect(h).toMatch(
      /create\s+or\s+replace\s+function\s+public\.jev_shadow_queue\s*\(\s*p_limit\s+integer\s+default\s+30\s*\)\s*returns\s+table\s*\(\s*id\s+bigint\s*,\s*task\s+text\s*,\s*subject_type\s+text\s*,\s*subject_id\s+text\s*,\s*state_preview\s+text\s*,\s*baseline_answer\s+text\s*,\s*jev_prob\s+numeric\s*,\s*jev_choice\s+text\s*,\s*created_at\s+timestamptz\s*\)/i,
    );
  });

  it("the queue body stratifies topic7: task <> 'topic7' or section disagreement or the 20-sample hash", () => {
    const b = body(fnQueue);
    expect(b).toMatch(/p\.task\s*<>\s*'topic7'/i);
    expect(b).toMatch(/%\s*20\s*=\s*0/);
  });

  it("the next_prioritized header equals 076's", () => {
    const h = header(fnNext).replace(/\s+/g, " ").trim();
    expect(h).toMatch(/gold_position\s+int\b/i);
    expect(h).toMatch(/priority\s+text\s*,\s*disagree_total\s+bigint\s*,\s*disagree_done\s+bigint/i);
  });

  it("jev_gold_next_prioritized also ranks a topic7 disagreement first", () => {
    expect(body(fnNext)).toMatch(/jev_topic7\s*<>\s*pv\.topic/i);
  });

  it("the scorecard splits dev/held-out on stratum = 'opus_seed'", () => {
    expect(body(fnScorecard)).toMatch(/stratum\s*=\s*'opus_seed'/i);
  });

  it("cron jev-topic7-yardsticks is scheduled '25 0 * * *' behind the pg_cron guard", () => {
    expect(code).toMatch(/pg_extension\s+where\s+extname\s*=\s*'pg_cron'/i);
    expect(code).toMatch(/cron\.schedule\s*\(\s*'jev-topic7-yardsticks'\s*,\s*'25 0 \* \* \*'/i);
  });
});
