import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { JEV_UNLINK_SKIP_REASONS } from "../../src/lib/admin/jev-unlink-triage";

// Migration 075 ("Küme dışı adaylar" triage). Static test, modelled on
// 071/072: strip `--` comments, then assert the SQL literals/shape without
// ever running the file. tests/migrations/zone-parity.test.ts is NOT
// extended here — this migration carries no bias-zone/blindspot copy.

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "075_jev_unlink_triage.sql",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

let sql = "";
let code = "";
beforeAll(() => {
  sql = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(sql);
});

describe("075 shape and safety", () => {
  it("ledgers version '075' and wraps in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/i);
    expect(code.trim().endsWith("commit;")).toBe(true);
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'075'\s*,\s*'075_jev_unlink_triage'\s*\)/i,
    );
  });

  it("is additive only: no DROP, TRUNCATE or DELETE anywhere", () => {
    expect(code).not.toMatch(/\bdrop\s+/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
  });

  it("the only ALTER TABLE statements touch jev_unlink_candidates (the add-column block) or the brand-new jev_unlink_dryrun table (enabling RLS on its own creation, not an existing table)", () => {
    const alters = [...code.matchAll(/\balter\s+table\s+(\S+)/gi)].map((m) => m[1]);
    const allowed = new Set(["public.jev_unlink_candidates", "public.jev_unlink_dryrun"]);
    for (const target of alters) {
      expect(allowed.has(target as string)).toBe(true);
    }
    expect(alters.length).toBeGreaterThan(0);
    // The jev_unlink_dryrun ALTER must be an RLS enable, not a schema change.
    expect(code).toMatch(/alter\s+table\s+public\.jev_unlink_dryrun\s+enable\s+row\s+level\s+security/i);
  });

  it("never contains the word 'iktidar', anywhere including comments", () => {
    expect(sql.toLowerCase()).not.toContain("iktidar");
  });
});

describe("075 parity with the TS constants", () => {
  it("the band literals match JEV_UNLINK_LIKELY_JACCARD_MAX / _PROB_MAX", () => {
    expect(code).toMatch(/s\.jac\s+is\s+not\s+null\s+and\s+s\.jac\s*<\s*0\.2\s+and\s+s\.jev_prob\s*<\s*0\.1/i);
  });

  it("jev_prob < 0.1 appears twice: once in the band condition, once bounding the dry-run candidate set", () => {
    const matches = [...code.matchAll(/jev_prob\s*<\s*0\.1/gi)];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(code).toMatch(/u\.jev_prob\s*<\s*0\.1/i);
  });

  it("the guard literals match cluster size >= 4 and pair_positive >= 0.5", () => {
    expect(code).toMatch(/coalesce\(\s*k\.article_count\s*,\s*0\s*\)\s*>=\s*4/i);
    expect(code).toMatch(/p\.jev_prob\s*>=\s*0\.5/i);
  });

  it("the skip_reasons CHECK list and the reason literals equal JEV_UNLINK_SKIP_REASONS", () => {
    const checkMatch = /skip_reasons\s*<@\s*array\[([^\]]+)\]::text\[\]/i.exec(code);
    expect(checkMatch).not.toBeNull();
    const checkList = [...((checkMatch as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map(
      (m) => m[1],
    );
    expect(checkList).toEqual([...JEV_UNLINK_SKIP_REASONS]);

    const reasonMatch = /array_remove\(array\[([\s\S]*?)\]::text\[\],\s*null\)/i.exec(code);
    expect(reasonMatch).not.toBeNull();
    const reasonBody = (reasonMatch as RegExpExecArray)[1] as string;
    const reasonLiterals = [...reasonBody.matchAll(/then\s+'([a-z_]+)'/g)].map((m) => m[1]);
    expect(reasonLiterals).toEqual([...JEV_UNLINK_SKIP_REASONS]);
  });
});

describe("075 refresh function safety", () => {
  it("jev_unlink_triage_refresh is SECURITY DEFINER with an empty search_path", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.jev_unlink_triage_refresh\s*\([\s\S]*?\)\s*returns\s+integer\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("takes a transaction advisory lock", () => {
    expect(code).toMatch(/pg_catalog\.pg_try_advisory_xact_lock\(/);
  });

  it("revoke/grant pairs exist for all three functions, service_role only", () => {
    for (const sig of [
      "jev_title_tokens(text)",
      "jev_title_jaccard(text, text)",
      "jev_unlink_triage_refresh(integer)",
    ]) {
      const escaped = sig.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      expect(code).toMatch(
        new RegExp(`revoke\\s+all\\s+on\\s+function\\s+public\\.${escaped}\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"),
      );
      expect(code).toMatch(
        new RegExp(`grant\\s+execute\\s+on\\s+function\\s+public\\.${escaped}\\s+to\\s+service_role\\s*;`, "i"),
      );
    }
  });
});

describe("075 NEVER changes cluster membership", () => {
  it("does not reference cluster_unlink_article", () => {
    expect(code).not.toMatch(/cluster_unlink_article/i);
  });

  it("has no UPDATE on clusters or cluster_articles, and no INSERT into cluster_articles", () => {
    expect(code).not.toMatch(/update\s+public\.clusters\b/i);
    expect(code).not.toMatch(/update\s+public\.cluster_articles\b/i);
    expect(code).not.toMatch(/insert\s+into\s+public\.cluster_articles\b/i);
  });

  it("the only UPDATE is on jev_unlink_candidates, and its set list is exactly title_jaccard, band, triaged_at", () => {
    const updates = [...code.matchAll(/\bupdate\s+public\.\w+/gi)].map((m) => m[0]);
    for (const u of updates) {
      expect(u.toLowerCase()).toBe("update public.jev_unlink_candidates");
    }
    expect(updates.length).toBeGreaterThan(0);

    const m = /update\s+public\.jev_unlink_candidates\s+u\s+set([\s\S]*?)from\s+scored/i.exec(code);
    expect(m).not.toBeNull();
    const setList = (m as RegExpExecArray)[1] as string;
    const assigned = [...setList.matchAll(/(\w+)\s*=(?!=)/g)].map((x) => x[1]);
    expect(assigned).toEqual(["title_jaccard", "band", "triaged_at"]);
    expect(setList).not.toMatch(/\bstatus\s*=/);
    expect(setList).not.toMatch(/\bdecided_at\s*=/);
  });

  it("the only INSERT into public.* application tables is into jev_unlink_dryrun", () => {
    const inserts = [...code.matchAll(/insert\s+into\s+(public\.\w+|supabase_migrations\.\w+)/gi)].map(
      (m) => m[1] as string,
    );
    const appTableInserts = inserts.filter((t) => t.toLowerCase().startsWith("public."));
    for (const t of appTableInserts) {
      expect(t.toLowerCase()).toBe("public.jev_unlink_dryrun");
    }
    expect(appTableInserts.length).toBeGreaterThan(0);
  });

  it("the dry-run upsert has an is distinct from guard (idempotent)", () => {
    expect(code).toMatch(/on\s+conflict\s*\(\s*candidate_id\s*\)\s+do\s+update/i);
    expect(code).toMatch(/is\s+distinct\s+from/i);
  });
});

describe("075 schedule and backfill", () => {
  it("schedules the 'jev-unlink-triage' cron job once, guarded by pg_cron", () => {
    expect(code).toMatch(/extname\s*=\s*'pg_cron'/);
    const schedules = [...code.matchAll(/cron\.schedule\(\s*'jev-unlink-triage'/g)];
    expect(schedules).toHaveLength(1);
    expect(code).toMatch(/cron\.unschedule\(\s*'jev-unlink-triage'\s*\)/);
  });

  it("backfills exactly once", () => {
    const calls = [...code.matchAll(/select\s+public\.jev_unlink_triage_refresh\(\s*2000\s*\)\s*;/gi)];
    expect(calls).toHaveLength(1);
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });
});
