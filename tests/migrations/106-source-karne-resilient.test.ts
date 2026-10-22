import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

import { BIAS_TO_ZONE, VOTING_SOURCE_KINDS } from "../../src/lib/bias/config";
import { KARNE_WINDOW_DAYS } from "../../src/lib/sources/karne";

// Static SQL-contract test for migration 106 ("Kapsama karnesi" refresh made
// resilient on a cold, small-memory database): two covering indexes, a
// per-source refresh function, a bounded batch function, the legacy
// full-pass function re-created with per-source error isolation, and the
// cron job re-pointed at the batch. Comments are stripped before every
// assertion so prose can never satisfy a code guard (same style as 096's test).

const MIGRATION = resolve(
  __dirname,
  "..",
  "..",
  "supabase",
  "migrations",
  "106_source_karne_resilient.sql",
);

function stripComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

interface FnBlock {
  args: string;
  returns: string;
  body: string;
}

// Parses every `create or replace function public.<name>(...) returns <t>
// language plpgsql security definer set search_path = '' as $fn$ ... $fn$`.
// A function that deviates from that exact header shape is simply not found,
// which fails the tests below (so "security definer + empty search_path" is
// asserted structurally, per function).
function parseFunctions(code: string): Record<string, FnBlock> {
  const out: Record<string, FnBlock> = {};
  const re =
    /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(([\s\S]*?)\)\s*returns\s+(\w+)\s+language\s+plpgsql\s+security\s+definer\s+set\s+search_path\s*=\s*''\s+as\s+\$fn\$([\s\S]*?)\$fn\$/gi;
  for (const m of code.matchAll(re)) {
    out[m[1]!] = { args: m[2]!, returns: m[3]!, body: m[4]! };
  }
  return out;
}

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

describe("migration 106_source_karne_resilient.sql (SQL contract)", () => {
  let raw = "";
  let code = "";
  let fns: Record<string, FnBlock> = {};

  beforeAll(() => {
    expect(existsSync(MIGRATION), "106_source_karne_resilient.sql must exist").toBe(true);
    raw = readFileSync(MIGRATION, "utf8");
    code = stripComments(raw);
    fns = parseFunctions(code);
  });

  it("sanity: comment stripping is non-vacuous (header mentions CONCURRENTLY, code does not)", () => {
    expect(raw).toMatch(/concurrently/i);
    expect(code).not.toMatch(/concurrently/i);
  });

  it("records the Step 0 findings in the header", () => {
    expect(raw).toMatch(/STEP 0 FINDINGS/);
    expect(raw).toMatch(/source-karne-refresh/);
    expect(raw).toMatch(/idx_articles_source_published/);
    expect(raw).toMatch(/statement timeout/i);
  });

  // ---- zone map / kinds / defaults ----------------------------------------

  it("zmap pairs equal BIAS_TO_ZONE", () => {
    const m = code.match(
      /zmap\s*\(\s*bias_key\s*,\s*zone\s*\)\s+as\s*\(\s*values([\s\S]*?)\)\s*,\s*mine\s+as/i,
    );
    expect(m, "zmap CTE must be present").not.toBeNull();
    const pairs = [
      ...m![1]!.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g),
    ].map((p) => [p[1], p[2]] as const);
    expect(pairs).toHaveLength(Object.keys(BIAS_TO_ZONE).length);
    expect(Object.fromEntries(pairs)).toEqual(BIAS_TO_ZONE);
  });

  it("the own-zone lookup list equals BIAS_TO_ZONE too", () => {
    const m = code.match(
      /from\s*\(\s*values([\s\S]*?)\)\s*as\s+z\s*\(\s*bias_key\s*,\s*zone\s*\)/i,
    );
    expect(m, "own-zone VALUES list must be present").not.toBeNull();
    const pairs = [
      ...m![1]!.matchAll(/\(\s*'([a-z_]+)'\s*,\s*'([a-z]+)'\s*\)/g),
    ].map((p) => [p[1], p[2]] as const);
    expect(Object.fromEntries(pairs)).toEqual(BIAS_TO_ZONE);
  });

  it("voting kinds equal VOTING_SOURCE_KINDS (every `kind in (...)`)", () => {
    const lists = [...code.matchAll(/kind\s+in\s*\(([^)]*)\)/gi)];
    expect(lists.length).toBeGreaterThanOrEqual(1);
    for (const m of lists) {
      const kinds = [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((k) => k[1]);
      expect(kinds).toEqual([...VOTING_SOURCE_KINDS]);
    }
  });

  it("the legacy function keeps its signature and its default window equals KARNE_WINDOW_DAYS", () => {
    const m = code.match(
      /source_karne_refresh\s*\(\s*p_days\s+integer\s+default\s+(\d+)\s*\)/i,
    );
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(KARNE_WINDOW_DAYS);
    expect(fns.source_karne_refresh?.returns).toBe("integer");
    expect(collapse(fns.source_karne_refresh!.args)).toBe("p_days integer default 30");
  });

  it("the per-source and batch functions default the window to KARNE_WINDOW_DAYS", () => {
    expect(collapse(fns.source_karne_refresh_source!.args)).toBe(
      `p_source_id uuid, p_days integer default ${KARNE_WINDOW_DAYS}`,
    );
    expect(fns.source_karne_refresh_source!.returns).toBe("boolean");
    expect(collapse(fns.source_karne_refresh_batch!.args)).toBe(
      `p_days integer default ${KARNE_WINDOW_DAYS}, p_limit integer default 10, p_budget_ms integer default 120000`,
    );
    expect(fns.source_karne_refresh_batch!.returns).toBe("integer");
  });

  // ---- security ------------------------------------------------------------

  it("all 3 functions are SECURITY DEFINER with an empty search_path (and nothing else is created)", () => {
    expect(Object.keys(fns).sort()).toEqual([
      "source_karne_refresh",
      "source_karne_refresh_batch",
      "source_karne_refresh_source",
    ]);
    expect([...code.matchAll(/create\s+or\s+replace\s+function\b/gi)]).toHaveLength(3);
    expect([...code.matchAll(/security\s+definer/gi)]).toHaveLength(3);
    expect([...code.matchAll(/search_path\s*=\s*''/gi)]).toHaveLength(3);
  });

  it.each([
    ["source_karne_refresh", "integer"],
    ["source_karne_refresh_batch", "integer\\s*,\\s*integer\\s*,\\s*integer"],
    ["source_karne_refresh_source", "uuid\\s*,\\s*integer"],
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

  it("never grants anything to anon/authenticated", () => {
    expect(code).not.toMatch(
      /grant\s+(insert|update|delete|truncate|maintain|all|select|execute)[^;]*\bto\b[^;]*\b(anon|authenticated)\b/i,
    );
  });

  // ---- per-source function -------------------------------------------------

  describe("source_karne_refresh_source", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.source_karne_refresh_source?.body ?? "");
    });

    it("clamps the window to 1..90 and stamps v_end with now()", () => {
      expect(body).toMatch(/least\(greatest\(coalesce\(p_days, 30\), 1\), 90\)/);
      expect(body).toMatch(/v_end timestamptz := pg_catalog\.now\(\)/);
      expect(body).toMatch(
        /v_start := v_end - pg_catalog\.make_interval\(days => v_days\)/,
      );
    });

    it("returns false for a missing or inactive source, true after the upsert", () => {
      expect(body).toMatch(/from public\.sources where id = p_source_id and active/);
      expect(body).toMatch(/if not found then return false; end if;/);
      expect(body).toMatch(/return true;\s*end$/);
    });

    it("takes no lock", () => {
      expect(body).not.toMatch(/advisory/i);
    });

    it("runs the zmap/mine/per/adj upsert keyed on p_source_id", () => {
      expect(body).toMatch(/with zmap\(bias_key, zone\) as \(values/);
      expect(body).toMatch(/mine as \(select distinct ca\.cluster_id from public\.articles a/);
      expect(body).toMatch(/a\.source_id = p_source_id and a\.published_at >= v_start/);
      expect(body).toMatch(/\bper as \(select c\.id,/);
      expect(body).toMatch(/\badj as \(select bs, bs_zone,/);
      expect(body).toMatch(/insert into public\.source_karne_30d \(/);
      expect(body).toMatch(/select p_source_id, v_days, v_start, v_end, count\(\*\)::int/);
      expect(body).toMatch(/on conflict \(source_id\) do update set/);
      expect(body).toMatch(/computed_at = excluded\.computed_at/);
      expect(body).not.toMatch(/v_src\.id/);
    });

    it("uses the veto in the public-blindspot expression", () => {
      expect(body).toMatch(
        /\(c\.is_blindspot and not c\.blindspot_recall_veto\) as bs\b/,
      );
    });
  });

  // ---- batch function ------------------------------------------------------

  describe("source_karne_refresh_batch", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.source_karne_refresh_batch?.body ?? "");
    });

    it("takes the same advisory lock as 096 and returns 0 when it is held", () => {
      expect(body).toMatch(
        /if not pg_catalog\.pg_try_advisory_xact_lock\( pg_catalog\.hashtext\('source_karne_refresh'\)::bigint \) then return 0; end if;/,
      );
    });

    it("clamps the limit to 1..200 and the budget to 1000..600000 ms", () => {
      expect(body).toMatch(/least\(greatest\(coalesce\(p_limit, 10\), 1\), 200\)/);
      expect(body).toMatch(
        /least\(greatest\(coalesce\(p_budget_ms, 120000\), 1000\), 600000\)/,
      );
      expect(body).toMatch(/least\(greatest\(coalesce\(p_days, 30\), 1\), 90\)/);
    });

    it("selects active sources that are missing or older than 20 hours, oldest first", () => {
      expect(body).toMatch(/s\.active/);
      expect(body).toMatch(
        /k\.source_id is null or k\.computed_at < pg_catalog\.now\(\) - interval '20 hours'/,
      );
      expect(body).toMatch(/order by k\.computed_at asc nulls first, s\.id/);
      expect(body).toMatch(
        /left join public\.source_karne_30d k on k\.source_id = s\.id/,
      );
    });

    it("exits on the limit or the wall-clock budget (clock_timestamp)", () => {
      expect(body).toMatch(/clock_timestamp\(\)/);
      expect(body).toMatch(/v_started timestamptz := pg_catalog\.clock_timestamp\(\)/);
      expect(body).toMatch(/exit when v_done >= v_limit or /);
      expect(body).toMatch(/pg_catalog\.clock_timestamp\(\) - v_started/);
    });

    it("isolates each source: failures are logged, skipped and do not count toward the limit", () => {
      expect(body).toMatch(
        /begin perform public\.source_karne_refresh_source\(v_src\.id, v_days\); v_done := v_done \+ 1; exception when others then raise log 'source_karne_refresh_batch: source % failed: % \(%\)', v_src\.id, sqlerrm, sqlstate; end;/,
      );
    });

    it("deletes rows of inactive or removed sources, then returns the processed count", () => {
      expect(body).toMatch(
        /delete from public\.source_karne_30d k where not exists \(select 1 from public\.sources s where s\.id = k\.source_id and s\.active\);/,
      );
      expect(body).toMatch(/return v_done; end$/);
    });
  });

  // ---- legacy full-pass function --------------------------------------------

  describe("source_karne_refresh (legacy, manual)", () => {
    let body = "";
    beforeAll(() => {
      body = collapse(fns.source_karne_refresh?.body ?? "");
    });

    it("keeps the advisory lock, runs a full pass through refresh_source with per-source isolation", () => {
      expect(body).toMatch(
        /pg_try_advisory_xact_lock\( pg_catalog\.hashtext\('source_karne_refresh'\)::bigint \)/,
      );
      expect(body).toMatch(/select s\.id from public\.sources s where s\.active order by s\.id/);
      expect(body).toMatch(
        /begin perform public\.source_karne_refresh_source\(v_src\.id, v_days\); v_processed := v_processed \+ 1; exception when others then raise log /,
      );
      expect(body).toMatch(/delete from public\.source_karne_30d k where not exists/);
      expect(body).toMatch(/return v_processed; end$/);
    });

    it("no longer carries the monolithic per-source insert", () => {
      expect(body).not.toMatch(/insert into public\.source_karne_30d/);
    });
  });

  // ---- indexes -------------------------------------------------------------

  it("creates both covering indexes with plain CREATE INDEX (no CONCURRENTLY inside the migration)", () => {
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+idx_articles_source_published_inc_id\s+on\s+public\.articles\s*\(\s*source_id\s*,\s*published_at\s+desc\s*\)\s+include\s*\(\s*id\s*\)\s*;/i,
    );
    expect(code).toMatch(
      /create\s+index\s+if\s+not\s+exists\s+idx_cluster_articles_article_cluster\s+on\s+public\.cluster_articles\s*\(\s*article_id\s*,\s*cluster_id\s*\)\s*;/i,
    );
    expect(code).not.toMatch(/concurrently/i);
  });

  // ---- cron ----------------------------------------------------------------

  it("re-points the cron job at the bounded batch every 15 minutes", () => {
    const unschedule = code.search(/cron\.unschedule\s*\(\s*'source-karne-refresh'\s*\)/i);
    const schedule = code.search(
      /cron\.schedule\s*\(\s*'source-karne-refresh'\s*,\s*'\*\/15 \* \* \* \*'/i,
    );
    expect(unschedule).toBeGreaterThanOrEqual(0);
    expect(schedule).toBeGreaterThan(unschedule);
  });

  it("raises statement_timeout (<= 5 min) in the cron command, before the batch select", () => {
    const m = code.match(/cron\.schedule\s*\([\s\S]*?\$sql\$([\s\S]*?)\$sql\$/i);
    expect(m, "cron command body").not.toBeNull();
    const cmd = m![1]!;
    const setIdx = cmd.search(/set\s+statement_timeout\s*=\s*'(\d+)min'/i);
    const callIdx = cmd.search(/select\s+public\.source_karne_refresh_batch\s*\(\s*30\s*,\s*10\s*,\s*120000\s*\)/i);
    expect(setIdx).toBeGreaterThanOrEqual(0);
    expect(callIdx).toBeGreaterThan(setIdx);
    const mins = Number(/statement_timeout\s*=\s*'(\d+)min'/i.exec(cmd)![1]);
    expect(mins).toBeGreaterThanOrEqual(1);
    expect(mins).toBeLessThanOrEqual(5);
  });

  it("does not schedule or run the monolithic full pass", () => {
    expect(code).not.toMatch(/select\s+public\.source_karne_refresh\s*\(/i);
    expect(code).not.toMatch(/cron\.schedule\s*\([^;]*source_karne_refresh\s*\(/i);
  });

  // ---- comments ------------------------------------------------------------

  it("comments tell the real cadence: no comment on string mentions 6 h / 6 hours", () => {
    const comments = [
      ...code.matchAll(
        /comment\s+on\s+(?:table|function)\s+[\w.]+(?:\([^)]*\))?\s+is\s+((?:'(?:[^']|'')*'\s*)+);/gi,
      ),
    ].map((m) => m[0]);
    // 3 functions + the source_karne_30d table comment fix.
    expect(comments).toHaveLength(4);
    for (const c of comments) {
      expect(c).not.toContain("6 h");
      expect(c).not.toContain("6 hours");
    }
    const table = comments.find((c) => /comment\s+on\s+table\s+public\.source_karne_30d/i.test(c));
    expect(table, "table comment fix").toBeDefined();
    expect(table).toMatch(/source_karne_refresh_batch/);
    const batch = comments.find((c) =>
      /on\s+function\s+public\.source_karne_refresh_batch\s*\(/i.test(c),
    );
    expect(batch).toMatch(/15 min/);
    const legacy = comments.find((c) => /on\s+function\s+public\.source_karne_refresh\s*\(/i.test(c));
    expect(legacy).toMatch(/manual/i);
    expect(legacy).toMatch(/not scheduled/i);
    expect(legacy).toMatch(/cold/i);
  });

  // ---- hygiene -------------------------------------------------------------

  it("is additive: no drop, no alter table, no new table, no truncate, no policy", () => {
    expect(code).not.toMatch(/\bdrop\s+\w+/i);
    expect(code).not.toMatch(/\balter\s+table\b/i);
    expect(code).not.toMatch(/\bcreate\s+table\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/create\s+policy/i);
  });

  it("does not run any backfill inside the migration (outside function bodies and the cron command)", () => {
    const topLevel = code
      .replace(/\$fn\$[\s\S]*?\$fn\$/g, "")
      .replace(/\$sql\$[\s\S]*?\$sql\$/g, "");
    expect(topLevel).not.toMatch(/\bselect\s+public\.source_karne_refresh/i);
    expect(topLevel).not.toMatch(/\bperform\s+public\.source_karne_refresh/i);
    // Sanity: the cron command itself is the one place the batch is selected.
    expect(code).toMatch(/\$sql\$[^$]*select\s+public\.source_karne_refresh_batch/i);
  });

  it("writes the ledger row", () => {
    expect(code).toMatch(
      /insert\s+into\s+supabase_migrations\.schema_migrations\s*\(\s*version\s*,\s*name\s*\)\s*values\s*\(\s*'106'\s*,\s*'106_source_karne_resilient'\s*\)\s*on\s+conflict\s+do\s+nothing/i,
    );
  });

  it("is wrapped in begin/commit", () => {
    expect(code).toMatch(/^\s*begin\s*;/im);
    expect(code).toMatch(/\bcommit\s*;\s*$/i);
  });
});
