import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import {
  STORY_THREAD_CRON,
  STORY_THREAD_DF_CAP_SHARE,
  STORY_THREAD_MAX_HOURS_APART,
  STORY_THREAD_MIN_ARTICLES,
  STORY_THREAD_MIN_CONFIDENCE,
  STORY_THREAD_MIN_SHARED_TERMS,
  STORY_THREAD_MIN_TERM_LEN,
  STORY_THREAD_RUN_CAP,
  STORY_THREAD_TITLE_MAX,
  STORY_THREAD_TITLE_MIN,
  STORY_THREAD_TOP_TERMS,
  STORY_THREAD_WINDOW_DAYS,
} from "../../src/lib/story-threads/config";

// Static SQL-contract test for migration 098 (story threads). Comments are
// stripped first so prose can never satisfy a code guard (same as 096).

const MIGRATION = resolve(__dirname, "..", "..", "supabase", "migrations", "098_story_threads.sql");

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

describe("migration 098_story_threads.sql (SQL contract)", () => {
  let code = "";

  beforeAll(() => {
    expect(existsSync(MIGRATION), "098_story_threads.sql must exist").toBe(true);
    code = stripComments(readFileSync(MIGRATION, "utf8"));
  });

  const FUNCS = [
    ["story_thread_candidates_refresh", "integer"],
    ["story_thread_approve_candidate", "bigint"],
  ] as const;

  it.each(FUNCS)("%s is security definer with an empty search_path", (name) => {
    const m = code.match(
      new RegExp(`create or replace function public\\.${name}\\s*\\([\\s\\S]*?\\$fn\\$`, "i"),
    );
    expect(m, `${name} definition`).not.toBeNull();
    expect(m![0]).toMatch(/security\s+definer/i);
    expect(m![0]).toMatch(/set\s+search_path\s*=\s*''/i);
  });

  it.each(FUNCS)("%s revokes from public/anon/authenticated and grants service_role", (name, arg) => {
    expect(code).toMatch(
      new RegExp(
        `revoke\\s+all\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${arg}\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated`,
        "i",
      ),
    );
    expect(code).toMatch(
      new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${name}\\s*\\(\\s*${arg}\\s*\\)\\s+to\\s+service_role`, "i"),
    );
  });

  it("never grants write privileges (or all) to anon/authenticated", () => {
    expect(code).not.toMatch(
      /grant\s+[^;]*\b(insert|update|delete|truncate|all|maintain)\b[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i,
    );
  });

  it("grants select on threads and members to anon/authenticated, never on candidates", () => {
    const grants = [...code.matchAll(/grant\s+select\s+on\s+([^;]*?)\s+to\s+anon\s*,\s*authenticated\s*;/gi)];
    expect(grants).toHaveLength(1);
    expect(grants[0]![1]).toMatch(/story_threads/);
    expect(grants[0]![1]).toMatch(/story_thread_members/);
    expect(grants[0]![1]).not.toMatch(/story_thread_candidates/);
    expect(code).not.toMatch(/grant[^;]*story_thread_candidates[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i);
  });

  it("enables RLS on all three tables and revokes defaults incl. PG17 maintain", () => {
    for (const t of ["story_threads", "story_thread_members", "story_thread_candidates"]) {
      expect(code).toMatch(new RegExp(`alter\\s+table\\s+public\\.${t}\\s+enable\\s+row\\s+level\\s+security`, "i"));
    }
    expect(code).toMatch(
      /revoke\s+all\s+on\s+public\.story_threads\s*,\s*public\.story_thread_members\s*,\s*public\.story_thread_candidates\s+from\s+anon\s*,\s*authenticated\s*,\s*public/i,
    );
    expect(code).toMatch(/server_version_num'\)::int\s*>=\s*170000/i);
    expect(code).toMatch(/revoke maintain on/i);
    expect(code).toMatch(
      /grant\s+select\s*,\s*insert\s*,\s*update\s*,\s*delete\s+on\s+public\.story_threads\s*,\s*public\.story_thread_members\s*,\s*public\.story_thread_candidates\s+to\s+service_role/i,
    );
  });

  it("has exactly two read policies, both limited to published threads, none on candidates", () => {
    const policies = [...code.matchAll(/create\s+policy\s+"([^"]+)"\s+on\s+public\.(\w+)([\s\S]*?);/gi)];
    expect(policies.map((p) => p[2]).sort()).toEqual(["story_thread_members", "story_threads"]);
    for (const p of policies) {
      expect(p[3]).toMatch(/for\s+select\s+to\s+anon\s*,\s*authenticated/i);
      expect(p[3]).toMatch(/status\s*=\s*'published'/);
    }
    expect(code).not.toMatch(/policy[^;]*story_thread_candidates/i);
  });

  it("cron literal equals STORY_THREAD_CRON and stays out of the 03:50-04:20 UTC busy band", () => {
    const m = code.match(/cron\.schedule\s*\(\s*'story-thread-candidates'\s*,\s*'([^']+)'/i);
    expect(m).not.toBeNull();
    expect(m![1]).toBe(STORY_THREAD_CRON);
    const [minute, hour] = m![1]!.split(" ").map(Number) as [number, number];
    const t = hour * 60 + minute;
    expect(t < 3 * 60 + 50 || t > 4 * 60 + 20).toBe(true);
    expect(code).toMatch(/cron\.unschedule\s*\(\s*'story-thread-candidates'\s*\)/i);
    expect(code).toMatch(/select\s+public\.story_thread_candidates_refresh\s*\(\s*\)/i);
  });

  it("SQL literals match config.ts", () => {
    expect(code).toContain(`default ${STORY_THREAD_WINDOW_DAYS}`);
    expect(code).toContain(`article_count >= ${STORY_THREAD_MIN_ARTICLES}`);
    expect(code).toContain(`hours <= ${STORY_THREAD_MAX_HOURS_APART}`);
    expect(code).toContain(`hours / ${STORY_THREAD_MAX_HOURS_APART}.0`);
    expect(code).toContain(`rk <= ${STORY_THREAD_TOP_TERMS}`);
    expect(code).toContain(`having count(*) >= ${STORY_THREAD_MIN_SHARED_TERMS}`);
    expect(code).toContain(`char_length(t.lex) >= ${STORY_THREAD_MIN_TERM_LEN}`);
    expect(code).toContain(`* ${STORY_THREAD_DF_CAP_SHARE}`);
    expect(code).toContain(`>= ${STORY_THREAD_MIN_CONFIDENCE.toFixed(2)}`);
    expect(code).toContain(`limit ${STORY_THREAD_RUN_CAP}`);
    expect(code).toContain(`between ${STORY_THREAD_TITLE_MIN} and ${STORY_THREAD_TITLE_MAX}`);
  });

  it("takes the advisory locks and never reopens rejected/approved pairs", () => {
    expect(code).toMatch(/pg_try_advisory_xact_lock\s*\(\s*pg_catalog\.hashtext\('story_thread_candidates_refresh'\)/i);
    expect(code).toMatch(/pg_advisory_xact_lock\s*\(\s*pg_catalog\.hashtext\('story_threads_write'\)/i);
    expect(code).toMatch(/where\s+s\.status\s*=\s*'pending'/i);
    expect(code).toMatch(/story_thread_conflict/);
    expect(code).toMatch(/story_thread_candidate_not_pending/);
  });

  it("never publishes: no function writes threads.status", () => {
    expect(code).not.toMatch(/update\s+public\.story_threads\s+set[^;]*status/i);
    expect(code).not.toMatch(/insert\s+into\s+public\.story_threads[^;]*published/i);
  });

  it("writes the schema_migrations row and is wrapped in begin/commit", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'098'\s*,\s*'098_story_threads'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });

  it("is additive and does not embed a BIAS_TO_ZONE copy", () => {
    expect(code).not.toMatch(/\bdrop\s+table\b/i);
    expect(code).not.toMatch(/pro_government|opposition_leaning/);
    const alters = [...code.matchAll(/\balter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?([\w.]+)/gi)].map((m) => m[1]);
    expect(alters.every((t) => /^public\.story_thread/.test(t!))).toBe(true);
  });
});
