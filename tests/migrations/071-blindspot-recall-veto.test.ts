import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  BIAS_TO_ZONE,
  BLINDSPOT,
} from "../../supabase/functions/_shared/cluster/blindspot";
import { VOTING_SOURCE_KINDS } from "../../supabase/functions/_shared/cluster/source-kind";
import { RECALL_VETO_MIN_PROB } from "../../src/lib/clusters/recall-veto";

// Migration 071 (blindspot recall veto) carries a hand-written SQL copy of
// the bias-zone contract: the BIAS_TO_ZONE map (as a VALUES list, not a
// CASE), the BLINDSPOT thresholds, and the voting source kinds. This file
// fails the build the moment any of those copies drifts from the contract
// modules, and pins the safety properties of the definer function:
// hardened search_path, service_role-only execute, idempotent UPDATE that
// never writes the DB blindspot flags or updated_at.

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "071_blindspot_recall_veto.sql",
);

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

let sql = "";
let code = "";
beforeAll(() => {
  sql = readFileSync(MIGRATION, "utf8");
  code = stripSqlComments(sql);
});

describe("071 parity with the bias-zone contract", () => {
  it("the zmap VALUES pairs deep-equal BIAS_TO_ZONE", () => {
    const span = /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*\n?\s*win\s+as/i.exec(
      code,
    );
    expect(span).not.toBeNull();
    const body = (span as RegExpExecArray)[1] as string;
    const parsed: Record<string, string> = {};
    const pairRe = /\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = pairRe.exec(body)) !== null) {
      parsed[m[1] as string] = m[2] as string;
      count += 1;
    }
    // No duplicated key hiding behind the record collapse.
    expect(count).toBe(Object.keys(BIAS_TO_ZONE).length);
    expect(parsed).toEqual({ ...BIAS_TO_ZONE });
  });

  it("the live-tally contract uses BLINDSPOT.minSources and BLINDSPOT.dominantShare", () => {
    const share = escapeRe(String(BLINDSPOT.dominantShare));
    expect(code).toMatch(new RegExp(`l\\.tot\\s*>=\\s*${BLINDSPOT.minSources}\\b`));
    expect(code).toMatch(
      new RegExp(`l\\.dom_n::numeric\\s*/\\s*nullif\\(l\\.tot,\\s*0\\)\\s*>=\\s*${share}\\b`),
    );
  });

  it("the veto fires when the adjusted dominant share drops below BLINDSPOT.dominantShare", () => {
    const share = escapeRe(String(BLINDSPOT.dominantShare));
    expect(code).toMatch(
      new RegExp(`a\\.dom_n::numeric\\s*/\\s*nullif\\(a\\.tot,\\s*0\\)\\s*<\\s*${share}\\b`),
    );
  });

  it("only voting source kinds are added: the kind list equals VOTING_SOURCE_KINDS", () => {
    const m = /s\.kind\s+in\s*\(([^)]+)\)/i.exec(code);
    expect(m).not.toBeNull();
    const kinds = [...((m as RegExpExecArray)[1] as string).matchAll(/'([a-z_]+)'/g)].map(
      (x) => x[1],
    );
    expect(new Set(kinds)).toEqual(new Set(VOTING_SOURCE_KINDS));
  });

  it("reads only blindspot_recall predictions at the RECALL_VETO_MIN_PROB default, and never goes below 0.5", () => {
    expect(code).toMatch(/p\.task\s*=\s*'blindspot_recall'/);
    const p = escapeRe(String(RECALL_VETO_MIN_PROB));
    expect(code).toMatch(new RegExp(`p_min_prob\\s+numeric\\s+default\\s+${p}\\b`, "i"));
    expect(code).toMatch(
      new RegExp(`greatest\\(\\s*coalesce\\(\\s*p_min_prob\\s*,\\s*${p}\\s*\\)\\s*,\\s*0\\.5\\s*\\)`, "i"),
    );
  });

  it("never double-counts: matched sources that are already cluster members are excluded", () => {
    expect(code).toMatch(/not\s+exists\s*\(\s*select\s+1\s+from\s+public\.cluster_articles/i);
  });
});

describe("071 function safety", () => {
  it("is SECURITY DEFINER with an empty search_path", () => {
    expect(code).toMatch(
      /create\s+or\s+replace\s+function\s+public\.blindspot_recall_veto_refresh\s*\([\s\S]*?\)\s*returns\s+integer\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''/i,
    );
  });

  it("revokes execute from public/anon/authenticated and grants it only to service_role", () => {
    expect(code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+from\s+public,\s*anon,\s*authenticated/i,
    );
    expect(code).toMatch(
      /grant\s+execute\s+on\s+function\s+public\.blindspot_recall_veto_refresh\(interval,\s*numeric\)\s+to\s+service_role\s*;/i,
    );
    const grants = [...code.matchAll(/grant\s+execute\s+on\s+function\s+public\.blindspot_recall_veto_refresh[^;]*;/gi)];
    expect(grants).toHaveLength(1);
  });

  it("serialises concurrent runs with a transaction advisory lock", () => {
    expect(code).toMatch(/pg_catalog\.pg_try_advisory_xact_lock\(/);
  });

  it("the single UPDATE is idempotent (is distinct from guard)", () => {
    const updates = [...code.matchAll(/\bupdate\s+public\.\w+/gi)];
    expect(updates).toHaveLength(1);
    expect(code).toMatch(/c\.blindspot_recall_veto\s+is\s+distinct\s+from\s+v\.veto/i);
  });

  it("the UPDATE's set list never writes is_blindspot, blindspot_side or updated_at", () => {
    const m = /update\s+public\.clusters\s+c\s+set([\s\S]*?)\bfrom\s+verdict\b/i.exec(code);
    expect(m).not.toBeNull();
    const setList = (m as RegExpExecArray)[1] as string;
    // Sanity: the parser really captured the set list.
    expect(setList).toMatch(/blindspot_recall_veto\s*=/);
    expect(setList).toMatch(/blindspot_recall_veto_at\s*=/);
    // Strip the two columns this migration owns, then nothing else may be assigned.
    const assigned = [...setList.matchAll(/(\w+)\s*=(?!=)/g)].map((x) => x[1]);
    expect(assigned).toEqual(["blindspot_recall_veto", "blindspot_recall_veto_at"]);
    for (const forbidden of ["is_blindspot", "blindspot_side", "updated_at"]) {
      expect(setList).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
    }
  });
});

describe("071 schedule, backfill and bookkeeping", () => {
  it("schedules the 'blindspot-recall-veto' cron job once, guarded by pg_cron presence", () => {
    expect(code).toMatch(/extname\s*=\s*'pg_cron'/);
    const schedules = [...code.matchAll(/cron\.schedule\(\s*'blindspot-recall-veto'/g)];
    expect(schedules).toHaveLength(1);
    expect(code).toMatch(/cron\.unschedule\(\s*'blindspot-recall-veto'\s*\)/);
  });

  it("backfills exactly once with a 30-day window", () => {
    const calls = [
      ...code.matchAll(/select\s+public\.blindspot_recall_veto_refresh\(\s*interval\s+'30 days'\s*\)\s*;/gi),
    ];
    expect(calls).toHaveLength(1);
  });

  it("records itself as version '071'", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(version,\s*name\)\s*values\s*\(\s*'071'\s*,\s*'071_blindspot_recall_veto'\s*\)/i,
    );
  });

  it("sanity: comment stripping is non-vacuous", () => {
    expect(sql.length).toBeGreaterThan(code.length);
  });
});
