import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Permanent CI guard (ops heartbeat): public.ops_health_report() is re-created,
// whole, by every migration that changes one check (077, 100, 103, 108, 114,
// 115, 119, 122, 136).
// Each re-creation is a copy-paste of the previous body, so the easy mistake is
// a check that silently drops out of the copy: the report still returns rows,
// the heartbeat still runs, and nobody learns that, say, jev_shadow_cron_
// failures_30m stopped being evaluated. This sweep reads every migration that
// re-creates the function, in number order, and fails when a version loses a
// literal `check_name` of the version before it. The newest version must also
// carry the newest check (sources_newly_dark, 114), keep its 24 h silence window
// (115 widened it from 114's noisy 12 h: 61% of the 12 h flags resumed within a
// day, 21% at 24 h), keep the three reason labels 119 added to its detail
// (erişim yok, akış donmuş, sessiz, read from sources.fetch_*), and grant
// execute to service_role only. 122 appended row 14 (`ingest_gaps`, gaps in
// ingest_cycles.started_at over the last 6 hours): it must never let it fail
// (warn only: a lost tick is a signal to look at, not an outage by itself).
// 136 (h12-ops-1) appended rows 15 (`cron_route_failures_30m`, the app-side
// outcomes of the Vercel cron routes in public.ops_cron_route_runs) and 16
// (`db_size_mb`, pg_database_size against public.ops_db_size_limits()): the
// newest version carries them in that order, after ingest_gaps, as the LAST rows.
//
// Only literal names are compared (`check_name := 'name';`). The three
// per-zone freshness rows are built in a loop (`'ingest_fresh_' || v_zone ||
// '_min'`); their presence is pinned separately below.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = resolve(here, "..", "..", "supabase", "migrations");

const NEWEST_CHECK = "sources_newly_dark";
const GAPS_CHECK = "ingest_gaps";
const ROUTE_CHECK = "cron_route_failures_30m";
const LAST_CHECK = "db_size_mb";

function stripSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*/g, "");
}

type Version = {
  file: string;
  num: number;
  code: string;
  body: string;
  names: string[];
};

/** The SQL body between the dollar quotes of the ops_health_report() definition, or null. */
function functionBody(code: string): string | null {
  const m = /create\s+or\s+replace\s+function\s+public\.ops_health_report\s*\([\s\S]*?\bas\s+(\$[a-z_]*\$)([\s\S]*?)\1/i.exec(
    code,
  );
  return m ? (m[2] as string) : null;
}

function literalCheckNames(body: string): string[] {
  return [...body.matchAll(/check_name\s*:=\s*'([a-z0-9_]+)'\s*;/gi)].map((m) => m[1] as string);
}

let versions: Version[] = [];

beforeAll(() => {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}_.+\.sql$/.test(f))
    .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  versions = [];
  for (const file of files) {
    const code = stripSqlComments(readFileSync(resolve(MIGRATIONS_DIR, file), "utf8"));
    const body = functionBody(code);
    if (body === null) continue;
    versions.push({ file, num: parseInt(file, 10), code, body, names: literalCheckNames(body) });
  }
});

describe("ops_health_report(): versions across migrations", () => {
  it("finds every re-creation (077, 100, 103, 108, 114, 115, 119, 122, 136) in number order", () => {
    expect(versions.length).toBeGreaterThanOrEqual(9);
    expect(versions[0]?.num).toBe(77);
    expect(versions.map((v) => v.num)).toEqual(expect.arrayContaining([77, 100, 103, 108, 114, 115, 119, 122, 136]));
    const nums = versions.map((v) => v.num);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it("every version evaluates a plausible number of literal checks (the parser is not vacuous)", () => {
    for (const v of versions) {
      expect(v.names.length, `${v.file}: literal check names`).toBeGreaterThanOrEqual(7);
    }
  });

  it("no version lists a literal check name twice", () => {
    for (const v of versions) {
      expect(new Set(v.names).size, `${v.file}: duplicate check_name`).toBe(v.names.length);
    }
  });

  it("every version keeps the three per-zone freshness rows (the check_name built in the loop)", () => {
    for (const v of versions) {
      expect(v.body, v.file).toMatch(/check_name\s*:=\s*'ingest_fresh_'\s*\|\|\s*v_zone\s*\|\|\s*'_min'/i);
      expect(v.body, v.file).toMatch(/foreach\s+v_zone\s+in\s+array\s+array\s*\[\s*'iktidar'\s*,\s*'bagimsiz'\s*,\s*'muhalefet'\s*\]/i);
    }
  });

  it("each version keeps every literal check_name of the version before it", () => {
    expect(versions.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < versions.length; i++) {
      const prev = versions[i - 1] as Version;
      const cur = versions[i] as Version;
      const missing = prev.names.filter((n) => !cur.names.includes(n));
      expect(missing, `${cur.file} dropped checks that ${prev.file} had`).toEqual([]);
    }
  });
});

describe("ops_health_report(): the newest version", () => {
  let newest: Version;
  beforeAll(() => {
    newest = versions[versions.length - 1] as Version;
  });

  it(`contains ${NEWEST_CHECK}`, () => {
    expect(newest.names).toContain(NEWEST_CHECK);
  });

  it("sources_newly_dark keeps migration 115's 24 h window; a copy-paste of 114's 12 h window must not come back", () => {
    const m = /check_name\s*:=\s*'sources_newly_dark'/i.exec(newest.body);
    expect(m, "sources_newly_dark segment").not.toBeNull();
    const after = newest.body.slice((m as RegExpExecArray).index);
    expect(after).toContain("interval '24 hours'");
    expect(after).not.toContain("interval '12 hours'");
    expect(after).not.toContain("14 days 12 hours");
    expect(after).toContain("interval '14 days 24 hours'");
    expect(after).not.toContain("son 12 saatte");
  });

  it("sources_newly_dark: the akış donmuş threshold is longer than the 24 h silence window (every listed source already has no stored article in 24 h, so a 24 h threshold labels all of them frozen)", () => {
    const m = /check_name\s*:=\s*'sources_newly_dark'/i.exec(newest.body);
    expect(m, "sources_newly_dark segment").not.toBeNull();
    const after = newest.body.slice((m as RegExpExecArray).index);
    const frozen = /fetch_newest_item_at\s*<\s*v_now\s*-\s*interval\s*'(\d+)\s+hours'/i.exec(after);
    expect(frozen, "the fetch_newest_item_at threshold").not.toBeNull();
    const hours = Number((frozen as RegExpExecArray)[1]);
    expect(hours).toBeGreaterThan(24);
    // the same 72 h as dead_feeds and the app's silence gate (FEED_YIELD_WINDOW_MS)
    expect(hours).toBe(72);
  });

  it("sources_newly_dark keeps migration 119's reason labels and the freshness columns; a copy-paste of 115's plain `slug (n)` detail must not come back", () => {
    const m = /check_name\s*:=\s*'sources_newly_dark'/i.exec(newest.body);
    expect(m, "sources_newly_dark segment").not.toBeNull();
    const after = newest.body.slice((m as RegExpExecArray).index);
    for (const label of ["akış donmuş", "erişim yok", "sessiz"]) {
      expect(after, label).toContain(`'${label}'`);
    }
    expect(after).toContain("fetch_newest_item_at");
    expect(after).toContain("fetch_items_count");
    expect(after).toMatch(/\|\|\s*v\.reason/);
  });

  it(`contains ${GAPS_CHECK} (migration 122), ${ROUTE_CHECK} and ${LAST_CHECK} (migration 136) in that order, ${LAST_CHECK} LAST`, () => {
    expect(newest.num).toBeGreaterThanOrEqual(136);
    for (const name of [GAPS_CHECK, ROUTE_CHECK, LAST_CHECK]) expect(newest.names).toContain(name);
    expect(newest.names[newest.names.length - 1]).toBe(LAST_CHECK);
    expect(newest.names.indexOf(GAPS_CHECK)).toBeGreaterThan(newest.names.indexOf(NEWEST_CHECK));
    expect(newest.names.indexOf(ROUTE_CHECK)).toBeGreaterThan(newest.names.indexOf(GAPS_CHECK));
    expect(newest.names.indexOf(LAST_CHECK)).toBeGreaterThan(newest.names.indexOf(ROUTE_CHECK));
  });

  /** The text of one check: from its `check_name :=` up to the next one (or the end of the body). */
  function slice(name: string): string {
    const m = new RegExp(`check_name\\s*:=\\s*'${name}'`, "i").exec(newest.body);
    expect(m, `${name} segment`).not.toBeNull();
    const from = (m as RegExpExecArray).index + (m as RegExpExecArray)[0].length;
    const next = newest.body.slice(from).search(/check_name\s*:=/i);
    return newest.body.slice((m as RegExpExecArray).index, next === -1 ? undefined : from + next);
  }

  it("ingest_gaps never assigns 'fail': a lost tick warns, it does not page", () => {
    const after = slice(GAPS_CHECK);
    expect(after).not.toMatch(/status\s*:=\s*'fail'/i);
    expect(after).not.toContain("'fail'");
    expect(after).toMatch(/status\s*:=\s*'warn'/i);
  });

  it("ingest_gaps looks at the last 6 hours of ingest_cycles gaps over 5 minutes (ingest-drain runs every 3), warning at 3 gaps or one over 10 minutes", () => {
    const after = slice(GAPS_CHECK).replace(/\s+/g, " ");
    expect(after).toContain("threshold := 3");
    expect(after).toContain("interval '6 hours'");
    expect(after).toContain("interval '5 minutes'");
    expect(after).toContain("public.ingest_cycles");
    expect(after).toMatch(/lag\(c\.started_at\) over \(order by c\.started_at\)/);
    expect(after).toMatch(/v_n >= 3 or coalesce\(v_zero, 0\) > 10/);
  });

  it("cron_route_failures_30m reads public.ops_cron_route_runs over the last 30 minutes and can fail (an outage must page)", () => {
    const seg = slice(ROUTE_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("public.ops_cron_route_runs");
    expect(seg).toContain("interval '30 minutes'");
    expect(seg).toMatch(/status\s*:=\s*case when v_zero >= 1 or v_active then 'fail'/i);
    expect(seg).toContain("x.status >= 500");
  });

  // A run that Vercel kills at maxDuration never reaches withCronOutcome's finally/after(): it writes no row, so
  // the failure count cannot see it. Row 15 therefore also checks the newest row of the sub-hourly routes
  // against a gap list; the list must keep following vercel.ts (review of h12-ops-1).
  describe("cron_route_failures_30m: the silence list follows the schedule in vercel.ts", () => {
    function silenceList(): Array<{ route: string; warnMin: number; failMin: number }> {
      const seg = slice(ROUTE_CHECK).replace(/\s+/g, " ");
      const list = /with e \(route, warn_min, fail_min\) as \( values (.*?) \)/.exec(seg)?.[1] ?? "";
      return [...list.matchAll(/\('([a-z0-9-]+)'::text, (\d+)::numeric, (\d+)::numeric\)/g)].map((m) => ({
        route: m[1] as string,
        warnMin: Number(m[2]),
        failMin: Number(m[3]),
      }));
    }
    const vercelTs = () => readFileSync(resolve(here, "..", "..", "vercel.ts"), "utf8");

    it("is not vacuous: headline and alerts-webhooks are listed", () => {
      expect(silenceList().map((e) => e.route)).toEqual(["headline", "alerts-webhooks"]);
    });

    it("every listed route has a cron folder and an every-N-minutes schedule in vercel.ts", () => {
      for (const { route } of silenceList()) {
        expect(
          readdirSync(resolve(here, "..", "..", "src", "app", "api", "cron")),
          `src/app/api/cron/${route}`,
        ).toContain(route);
        expect(vercelTs(), `vercel.ts schedule of /api/cron/${route}`).toMatch(
          new RegExp(`path:\\s*"/api/cron/${route}",\\s*schedule:\\s*"\\*/\\d+ \\* \\* \\* \\*"`),
        );
      }
    });

    it("warn_min is at least two ticks and fail_min at least six ticks of the route's own schedule", () => {
      for (const { route, warnMin, failMin } of silenceList()) {
        const m = new RegExp(`path:\\s*"/api/cron/${route}",\\s*schedule:\\s*"\\*/(\\d+) `).exec(vercelTs());
        const tick = Number(m?.[1]);
        expect(tick, `${route}: tick minutes`).toBeGreaterThan(0);
        expect(warnMin, `${route}: warn_min`).toBeGreaterThanOrEqual(2 * tick);
        expect(failMin, `${route}: fail_min`).toBeGreaterThanOrEqual(6 * tick);
        expect(failMin, `${route}: fail_min above warn_min`).toBeGreaterThan(warnMin);
      }
    });

    it("never lists a route that does not run all day (social is 05:00-20:59 UTC) or runs less often than every 10 minutes", () => {
      const v = vercelTs();
      for (const { route } of silenceList()) {
        const m = new RegExp(`path:\\s*"/api/cron/${route}",\\s*schedule:\\s*"([^"]+)"`).exec(v);
        expect(m?.[1], `${route}: schedule`).toMatch(/^\*\/(5|10) \* \* \* \*$/);
      }
    });
  });

  it("db_size_mb reads pg_database_size against public.ops_db_size_limits() and can fail", () => {
    const seg = slice(LAST_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("pg_database_size");
    expect(seg).toContain("public.ops_db_size_limits()");
    expect(seg).toMatch(/then 'fail'/i);
    expect(seg).toMatch(/then 'warn'/i);
  });

  it("revokes from public, anon and authenticated, and grants execute only to service_role", () => {
    expect(newest.code).toMatch(
      /revoke\s+all\s+on\s+function\s+public\.ops_health_report\(\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i,
    );
    const grants = [...newest.code.matchAll(/\bgrant\b[^;]*\bon\s+function\s+public\.ops_health_report\s*\([^)]*\)[^;]*;/gi)].map(
      (m) => m[0],
    );
    expect(grants).toHaveLength(1);
    expect(grants[0]).toMatch(/grant\s+execute\s+on\s+function\s+public\.ops_health_report\(\)\s+to\s+service_role\s*;/i);
    for (const g of grants) {
      expect(g).not.toMatch(/\b(anon|authenticated|public)\b\s*;|\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    }
  });

  it("stays SECURITY DEFINER with an empty search_path", () => {
    const header = /create\s+or\s+replace\s+function\s+public\.ops_health_report\s*\([\s\S]*?\bas\s+\$[a-z_]*\$/i.exec(
      newest.code,
    )?.[0];
    expect(header).toBeDefined();
    expect(header).toMatch(/security\s+definer/i);
    expect(header).toMatch(/set\s+search_path\s*=\s*''/i);
  });
});
