import { describe, it, expect, beforeAll } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Permanent CI guard (ops heartbeat): public.ops_health_report() is re-created,
// whole, by every migration that changes one check (077, 100, 103, 108, 114,
// 115, 119, 122, 136, 145, 150, 157, 158, 159, 161).
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
// newest version carries them in that order, after ingest_gaps.
// 145 (h19-security-1) appended row 17 (`anon_surface`, a runtime check of what anon and
// authenticated can do, read from the catalogue; tests/guards/anon-surface.test.ts only reads
// migration text): the newest version carries it after db_size_mb.
// 150 (h24-ops-1) appended rows 18 (`queue_lag`, the age and depth of the pgmq queues cluster_work and
// image_backfill plus poison messages) and 19 (`cron_jobs_stalled`, the jobs listed in
// public.ops_cron_expected against cron.job and cron.job_run_details): the newest version carries them in that
// order and keeps rows 1-17 byte for byte as 145 wrote them.
// 157 (h36-pipeline-1) appended row 20 (`feed_poll_stale`, active sources without a quarantine marker whose
// fetch_last_at is older than 30 minutes): the newest version carries it LAST, after cron_jobs_stalled, and
// keeps rows 1-19 as 150 wrote them (tests/migrations/157-ingest-poll-stale.test.ts pins that byte identity).
// 158 (h38-saved-1) adds the sixth anon RPC, saved_clusters_v3, to row 17's allowlist: it re-creates the function
// with 157's text verbatim except three row-17 spots (the identity array, "five" -> "six" in a comment, and
// "(5 izinli RPC hariç)" -> "(6 ..."), so the "rows 1-17 as 145 wrote them" check below allows exactly those
// spots in the newest version (tests/migrations/158-saved-clusters-v3.test.ts pins the full diff against 157).
// 159 (h39-pipeline2-1) changes only row 20: `feed_poll_stale` is a fail at one counted feed over 60 minutes as well as at
// three over 30 (tests/migrations/159-ingest-stale-admission.test.ts pins the byte identity of everything else against 158).
// 161 (h40-edgefns-1) appended row 21 (`image_coverage`, per outlet/wire source the share of the last 24 hours' articles stored
// without an image against the source's own 14 days before; warn only): the newest version carries it LAST, after feed_poll_stale,
// and keeps rows 1-20 as 159 wrote them (tests/migrations/161-image-coverage-by-source.test.ts pins that byte identity).
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
const SIZE_CHECK = "db_size_mb";
const ANON_CHECK = "anon_surface";
const QUEUE_CHECK = "queue_lag";
const CRON_CHECK = "cron_jobs_stalled";
const LAST_CHECK = "image_coverage";
const STALE_CHECK = "feed_poll_stale";
const MIGRATION_145 = resolve(MIGRATIONS_DIR, "145_ops_anon_surface_check.sql");
const CREATE_LINE = "create or replace function public.ops_health_report()";
/** What follows the last row's `return next;` in every version. */
const FN_END = "\n\n  return;\nend\n$fn$;";

/**
 * 145's rows 1-17 as migration 158 re-creates them: the same text with the three spots where row 17 names the
 * allowlisted anon RPCs moved from five to six (saved_clusters_v3 appended to the identity array).
 */
function withSixthAnonRpc(rows145: string): string {
  const swaps: ReadonlyArray<readonly [string, string]> = [
    ["outside the five allowlisted RPCs", "outside the six allowlisted RPCs"],
    ["'saved_clusters_v2(uuid[])'])", "'saved_clusters_v2(uuid[])', 'saved_clusters_v3(uuid[])'])"],
    ["' (5 izinli RPC hariç)'", "' (6 izinli RPC hariç)'"],
  ];
  let out = rows145;
  for (const [from, to] of swaps) {
    expect(out.split(from).length - 1, `145 row 17 has ${from} once`).toBe(1);
    out = out.replace(from, to);
  }
  return out;
}

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
  it("finds every re-creation (077, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161) in number order", () => {
    expect(versions.length).toBeGreaterThanOrEqual(15);
    expect(versions[0]?.num).toBe(77);
    expect(versions.map((v) => v.num)).toEqual(expect.arrayContaining([77, 100, 103, 108, 114, 115, 119, 122, 136, 145, 150, 157, 158, 159, 161]));
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

  it(`contains ${GAPS_CHECK} (migration 122), ${ROUTE_CHECK} and ${SIZE_CHECK} (migration 136), ${ANON_CHECK} (migration 145), ${QUEUE_CHECK} and ${CRON_CHECK} (migration 150), ${STALE_CHECK} (migration 157), ${LAST_CHECK} (migration 161) in that order, ${LAST_CHECK} LAST`, () => {
    expect(newest.num).toBeGreaterThanOrEqual(161);
    for (const name of [GAPS_CHECK, ROUTE_CHECK, SIZE_CHECK, ANON_CHECK, QUEUE_CHECK, CRON_CHECK, STALE_CHECK, LAST_CHECK]) expect(newest.names).toContain(name);
    expect(newest.names[newest.names.length - 1]).toBe(LAST_CHECK);
    expect(newest.names.indexOf(GAPS_CHECK)).toBeGreaterThan(newest.names.indexOf(NEWEST_CHECK));
    expect(newest.names.indexOf(ROUTE_CHECK)).toBeGreaterThan(newest.names.indexOf(GAPS_CHECK));
    expect(newest.names.indexOf(SIZE_CHECK)).toBeGreaterThan(newest.names.indexOf(ROUTE_CHECK));
    expect(newest.names.indexOf(ANON_CHECK)).toBeGreaterThan(newest.names.indexOf(SIZE_CHECK));
    expect(newest.names.indexOf(QUEUE_CHECK)).toBeGreaterThan(newest.names.indexOf(ANON_CHECK));
    expect(newest.names.indexOf(CRON_CHECK)).toBeGreaterThan(newest.names.indexOf(QUEUE_CHECK));
    expect(newest.names.indexOf(STALE_CHECK)).toBeGreaterThan(newest.names.indexOf(CRON_CHECK));
    expect(newest.names.indexOf(LAST_CHECK)).toBeGreaterThan(newest.names.indexOf(STALE_CHECK));
  });

  it("keeps rows 1-17 byte for byte as 145 wrote them (raw text, comments included) and appends the queue_lag marker right after row 17", () => {
    const raw145 = readFileSync(MIGRATION_145, "utf8");
    // the last occurrence: a header may quote the create line in a comment (145's rollback paragraph does)
    const from145 = raw145.lastIndexOf(CREATE_LINE);
    const end145 = raw145.indexOf(FN_END, from145);
    expect(from145, "145 create line").toBeGreaterThan(0);
    expect(end145, "145 function end").toBeGreaterThan(from145);
    const rows145 = raw145.slice(from145, end145);
    expect(rows145.endsWith("  return next;")).toBe(true);
    expect(rows145.length).toBeGreaterThan(30000);

    const rawNewest = readFileSync(resolve(MIGRATIONS_DIR, newest.file), "utf8");
    const at = rawNewest.lastIndexOf(CREATE_LINE);
    expect(at, `${newest.file} create line`).toBeGreaterThanOrEqual(0);
    // the executable create line is in the file once (comments are stripped before counting)
    expect(newest.code.indexOf(CREATE_LINE)).toBeGreaterThanOrEqual(0);
    expect(newest.code.indexOf(CREATE_LINE, newest.code.indexOf(CREATE_LINE) + 1), "the create line is executable once").toBe(-1);
    // 158 changed row 17 in exactly three spots (the sixth anon RPC), 159 only row 20, 161 appended row 21; everything else is 145's text
    const expected = newest.num >= 158 ? withSixthAnonRpc(rows145) : rows145;
    expect(rawNewest.slice(at, at + expected.length)).toBe(expected);
    // the next non-blank line is the row-18 marker comment
    const rest = rawNewest.slice(at + expected.length);
    const nextLine = rest.split("\n").find((l) => l.trim() !== "");
    expect(nextLine?.trimStart().startsWith("-- 18. queue_lag (migration 150).")).toBe(true);
    expect(rest.startsWith("\n\n  -- 18. queue_lag (migration 150).")).toBe(true);
    // and the function ends after the last row's `return next;`
    expect(rawNewest.indexOf(FN_END, at)).toBeGreaterThan(at + expected.length);
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
    const seg = slice(SIZE_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("pg_database_size");
    expect(seg).toContain("public.ops_db_size_limits()");
    expect(seg).toMatch(/then 'fail'/i);
    expect(seg).toMatch(/then 'warn'/i);
  });

  it("anon_surface reads the catalogue for anon/authenticated privileges and can fail (a dashboard grant must page), warn and skip", () => {
    const seg = slice(ANON_CHECK).replace(/\s+/g, " ");
    for (const fn of ["has_table_privilege", "has_sequence_privilege", "has_function_privilege", "aclexplode"]) {
      expect(seg, fn).toContain(fn);
    }
    expect(seg).toContain("to_regrole('anon')");
    expect(seg).toContain("to_regrole('authenticated')");
    expect(seg).toMatch(/status\s*:=\s*case when v_n \+ v_total >= 1 then 'fail'/i);
    expect(seg).toMatch(/then 'warn'/i);
    expect(seg).toMatch(/status\s*:=\s*'skip'/i);
    // it only reads: no write keyword outside the privilege-name literals
    const outsideLiterals = seg
      .split("'")
      .filter((_, i) => i % 2 === 0)
      .join(" ");
    expect(outsideLiterals).not.toMatch(/\b(insert|update|delete|truncate)\b/i);
  });

  /** Empties every single-quoted literal (a character scan, no regular expression over SQL text). */
  function blankLiterals(sql: string): string {
    let out = "";
    let i = 0;
    while (i < sql.length) {
      if (sql.charAt(i) === "'") {
        let j = i + 1;
        while (j < sql.length) {
          if (sql.charAt(j) === "'") {
            if (sql.charAt(j + 1) === "'") {
              j += 2;
              continue;
            }
            break;
          }
          j += 1;
        }
        out += "''";
        i = j + 1;
      } else {
        out += sql.charAt(i);
        i += 1;
      }
    }
    return out;
  }

  /** Identifier-like words of the text, lower case, in order. */
  function wordsOf(text: string): string[] {
    const out: string[] = [];
    let cur = "";
    for (const ch of text.toLowerCase()) {
      if ((ch >= "a" && ch <= "z") || ch === "_" || (ch >= "0" && ch <= "9")) {
        cur += ch;
      } else if (cur) {
        out.push(cur);
        cur = "";
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  it("queue_lag reads the two pgmq queues and their archives, the 24 h poison window, and can fail, warn and answer unknown", () => {
    const seg = slice(QUEUE_CHECK).replace(/\s+/g, " ");
    for (const rel of ["pgmq.q_cluster_work", "pgmq.q_image_backfill", "pgmq.a_cluster_work", "pgmq.a_image_backfill"]) {
      expect(seg, rel).toContain(rel);
    }
    expect(seg).toContain("read_ct >= 3");
    expect(seg).toContain("interval '24 hours'");
    for (const limit of ["300", "900", "1800", "3600"]) expect(seg, limit).toContain(limit);
    expect(seg).toContain("threshold := 900");
    expect(seg).toContain("qc_depth > 300");
    expect(seg).toMatch(/then 'fail'/i);
    expect(seg).toMatch(/then 'warn'/i);
    expect(seg).toMatch(/status\s*:=\s*'unknown'/i);
    expect(seg).toContain("pgmq kuyruğu yok");
  });

  it("queue_lag only reads: no write keyword outside the string literals", () => {
    const outside = wordsOf(blankLiterals(slice(QUEUE_CHECK)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform"]) {
      expect(outside, w).not.toContain(w);
    }
    expect(outside).toContain("pgmq");
  });

  it("cron_jobs_stalled joins public.ops_cron_expected to cron.job and cron.job_run_details and can fail, warn and answer unknown", () => {
    const seg = slice(CRON_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("public.ops_cron_expected");
    expect(seg).toContain("cron.job ");
    expect(seg).toContain("cron.job_run_details");
    expect(seg).toMatch(/then 'fail'/i);
    expect(seg).toMatch(/then 'warn'/i);
    expect(seg).toMatch(/status\s*:=\s*'unknown'/i);
    expect(seg).toContain("threshold := 1");
  });

  it("cron_jobs_stalled never mentions the secret-bearing pg_cron columns `command` and `return_message` outside string literals", () => {
    const outside = wordsOf(blankLiterals(slice(CRON_CHECK)));
    expect(outside).not.toContain("command");
    expect(outside).not.toContain("return_message");
    // the scan is not vacuous: it sees the words that are there, and skips the ones inside literals
    expect(outside).toContain("jobname");
    expect(outside).toContain("start_time");
    expect(wordsOf(blankLiterals("select command from t where x = 'return_message'"))).toEqual(["select", "command", "from", "t", "where", "x"]);
  });

  it("feed_poll_stale reads active sources without a quarantine marker, counts the ones not polled for 30 minutes, and can fail, warn and answer unknown", () => {
    const seg = slice(STALE_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("from public.sources x where x.active and x.fetch_quarantined_until is null");
    expect(seg).toContain("x.fetch_last_at < pg_catalog.now() - interval '30 minutes'");
    expect(seg).toContain("threshold := 3");
    expect(seg).toMatch(/when f_stale >= 3 or f_old >= 1 then 'fail'/);
    expect(seg).toMatch(/when f_stale >= 1 then 'warn'/);
    expect(seg).toMatch(/status\s*:=\s*'unknown'/i);
  });

  it("feed_poll_stale also fails at one counted feed last polled more than 60 minutes ago (159): f_old counts it, and a copy-paste of 157's fail-at-3-only status must not come back", () => {
    const seg = slice(STALE_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("pg_catalog.count(*) filter (where x.fetch_last_at < pg_catalog.now() - interval '60 minutes')::numeric");
    expect(seg).toContain("into f_total, f_stale, f_old, f_never, f_list");
    expect(seg).not.toMatch(/status := case when f_stale >= 3 then 'fail'/);
    // the 30-minute count and the quarantine exclusion are still what observed and the population are
    expect(seg).toContain("observed := f_stale;");
    expect(seg).toContain("from public.sources x where x.active and x.fetch_quarantined_until is null");
  });

  it("feed_poll_stale only reads, and reads no url, validator or header column", () => {
    const outside = wordsOf(blankLiterals(slice(STALE_CHECK)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(outside, w).not.toContain(w);
    }
    for (const w of ["rss_url", "url", "fetch_etag", "fetch_body_hash", "fetch_last_modified"]) {
      expect(outside, w).not.toContain(w);
    }
    expect(outside).toContain("fetch_last_at");
  });

  it("image_coverage (161) compares each outlet/wire source's 24 hour image-less share (newest hour skipped) with its own 14 days before, and can warn and answer unknown but never fail", () => {
    const seg = slice(LAST_CHECK).replace(/\s+/g, " ");
    expect(seg).toContain("threshold := 1");
    expect(seg).toContain("s.kind in ('outlet', 'wire')");
    expect(seg).toContain("a.created_at >= v_now - interval '25 hours' and a.created_at < v_now - interval '1 hour'");
    expect(seg).toContain("a.created_at >= v_now - interval '15 days' and a.created_at < v_now - interval '25 hours'");
    expect(seg).toContain("pg_catalog.count(*) filter (where a.image_url is null)::numeric");
    expect(seg).toContain("rs.nul / rs.n >= 0.5 and rs.nul / rs.n - b.nul / b.n >= 0.4");
    expect(seg).toContain("status := case when i_hit >= 1 then 'warn' else 'pass' end;");
    expect(seg).not.toMatch(/'fail'/i);
    expect(seg).toMatch(/status\s*:=\s*'unknown'/i);
  });

  it("image_coverage only reads, bounds every scan of public.articles on created_at, and reads no url, title or body column", () => {
    const outside = wordsOf(blankLiterals(slice(LAST_CHECK)));
    for (const w of ["insert", "update", "delete", "truncate", "drop", "alter", "create", "perform", "execute"]) {
      expect(outside, w).not.toContain(w);
    }
    for (const w of ["url", "rss_url", "title", "summary", "description", "content", "content_hash"]) {
      expect(outside, w).not.toContain(w);
    }
    expect(outside).toContain("image_url");
    const seg = slice(LAST_CHECK).replace(/\s+/g, " ");
    expect(seg.split("from public.articles a").length - 1).toBe(2);
    expect(seg.split("a.created_at >= v_now - interval").length - 1).toBe(2);
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
