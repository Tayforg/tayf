import { describe, it, expect, vi } from "vitest";
import {
  ARCHIVE_GAP_EDGE_DAYS,
  ARCHIVE_GAP_FAIL_COUNT,
  STATUSES,
  buildRpcRequest,
  normalizeRows,
  evaluate,
  formatTable,
  formatMarkdown,
  runHeartbeat,
} from "./ops-heartbeat.mjs";

const SECRET_KEY = "sb_secret_do_not_leak_1234567890";
const HEALTHY_ROWS = [
  { check_name: "cron_failed_runs_30m", status: "pass", observed: 0, threshold: 1, detail: null },
  { check_name: "edge_http_errors_30m", status: "warn", observed: 3, threshold: 5, detail: "3 / 70 yanıt" },
  { check_name: "jev_shadow_last_run_min", status: "skip", observed: null, threshold: 30, detail: "pasif" },
];

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(status, body) {
  return new Response(body, { status });
}

/** The RPC name of every fetch call, in call order. */
function rpcNames(fetchImpl) {
  return fetchImpl.mock.calls.map(([url]) => String(url).split("/rpc/")[1]);
}

describe("STATUSES", () => {
  it("is the fixed 5-value vocabulary", () => {
    expect(STATUSES).toEqual(["pass", "warn", "fail", "unknown", "skip"]);
  });
});

describe("buildRpcRequest", () => {
  it("builds a POST to <base>/rest/v1/rpc/ops_health_report with apikey/Bearer/JSON headers and body '{}'", () => {
    const { url, init } = buildRpcRequest("https://proj.supabase.co", SECRET_KEY);
    expect(url).toBe("https://proj.supabase.co/rest/v1/rpc/ops_health_report");
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe(SECRET_KEY);
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(init.headers.Accept).toBe("application/json");
    expect(init.body).toBe("{}");
  });

  it("strips a trailing slash from the base URL", () => {
    const { url } = buildRpcRequest("https://proj.supabase.co/", SECRET_KEY);
    expect(url).toBe("https://proj.supabase.co/rest/v1/rpc/ops_health_report");
  });

  it("throws when the URL is not https", () => {
    expect(() => buildRpcRequest("http://proj.supabase.co", SECRET_KEY)).toThrow();
  });
});

describe("normalizeRows", () => {
  it("passes through valid rows unchanged", () => {
    expect(normalizeRows(HEALTHY_ROWS)).toEqual(HEALTHY_ROWS);
  });

  it("coerces an unrecognized status string to 'unknown'", () => {
    const [row] = normalizeRows([{ check_name: "x", status: "weird" }]);
    expect(row.status).toBe("unknown");
  });

  it("throws on a non-array payload", () => {
    expect(() => normalizeRows({ not: "an array" })).toThrow();
  });

  it("throws on a row missing check_name", () => {
    expect(() => normalizeRows([{ status: "pass" }])).toThrow();
  });
});

describe("evaluate", () => {
  it("exits 0 when only pass/warn/skip rows are present", () => {
    const { exitCode } = evaluate(HEALTHY_ROWS);
    expect(exitCode).toBe(0);
  });

  it("exits 1 when at least one row is 'fail'", () => {
    const rows = [...HEALTHY_ROWS, { check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30 }];
    const { exitCode, failing } = evaluate(rows);
    expect(exitCode).toBe(1);
    expect(failing).toHaveLength(1);
  });

  it("exits 1 on an empty report", () => {
    const { exitCode } = evaluate([]);
    expect(exitCode).toBe(1);
  });

  it("exits 1 when at least half the rows are 'unknown'", () => {
    const rows = [
      { check_name: "a", status: "unknown" },
      { check_name: "b", status: "unknown" },
      { check_name: "c", status: "pass" },
    ];
    const { exitCode, unknown } = evaluate(rows);
    expect(unknown).toHaveLength(2);
    expect(exitCode).toBe(1);
  });

  it("exits 0 when fewer than half the rows are 'unknown'", () => {
    const rows = [
      { check_name: "a", status: "unknown" },
      { check_name: "b", status: "pass" },
      { check_name: "c", status: "pass" },
    ];
    expect(evaluate(rows).exitCode).toBe(0);
  });
});

describe("formatTable", () => {
  it("renders a fail row with an upper-cased FAIL status", () => {
    const rows = [{ check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30, detail: "40/96" }];
    const table = formatTable(rows);
    expect(table).toContain("FAIL");
    expect(table).toContain("dead_feeds");
  });

  it("aligns columns for a healthy report", () => {
    const table = formatTable(HEALTHY_ROWS);
    const lines = table.split("\n");
    expect(lines).toHaveLength(HEALTHY_ROWS.length + 1);
    expect(lines[0]).toMatch(/CHECK/);
    expect(lines[0]).toMatch(/STATUS/);
  });
});

describe("formatMarkdown", () => {
  it("includes the verdict and a markdown table", () => {
    const md = formatMarkdown(HEALTHY_ROWS, "OK");
    expect(md).toContain("OK");
    expect(md).toContain("| check | status | observed | threshold | detail |");
    expect(md).toContain("cron_failed_runs_30m");
  });
});

describe("runHeartbeat", () => {
  const goodEnv = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY };

  function harness() {
    const logged = [];
    const summaries = [];
    return {
      log: (line) => logged.push(String(line)),
      appendSummary: (md) => summaries.push(String(md)),
      logged,
      summaries,
    };
  }

  it("exits 2 when SUPABASE_URL is missing", async () => {
    const { log } = harness();
    const code = await runHeartbeat({
      env: { SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY },
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
      log,
      appendSummary: vi.fn(),
    });
    expect(code).toBe(2);
  });

  it("exits 2 when SUPABASE_SERVICE_ROLE_KEY is missing", async () => {
    const code = await runHeartbeat({
      env: { SUPABASE_URL: "https://proj.supabase.co" },
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
      log: vi.fn(),
      appendSummary: vi.fn(),
    });
    expect(code).toBe(2);
  });

  it("exits 2 when the URL is http, not https", async () => {
    const code = await runHeartbeat({
      env: { SUPABASE_URL: "http://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY },
      fetchImpl: vi.fn(),
      sleep: vi.fn(),
      log: vi.fn(),
      appendSummary: vi.fn(),
    });
    expect(code).toBe(2);
  });

  it("calls fetch with an AbortSignal", async () => {
    const fetchImpl = vi.fn().mockImplementation(async () => jsonResponse(200, HEALTHY_ROWS));
    await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log: vi.fn(), appendSummary: vi.fn() });
    expect(rpcNames(fetchImpl).filter((n) => n === "ops_health_report")).toHaveLength(1);
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("retries once (after sleeping) on a 500 then succeeds on a 200", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, "internal error"))
      .mockResolvedValueOnce(jsonResponse(200, HEALTHY_ROWS));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { log } = harness();
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep, log, appendSummary: vi.fn() });
    expect(rpcNames(fetchImpl).filter((n) => n === "ops_health_report")).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(code).toBe(0);
  });

  it("retries once on a network error then succeeds", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(jsonResponse(200, HEALTHY_ROWS));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep, log: vi.fn(), appendSummary: vi.fn() });
    expect(rpcNames(fetchImpl).filter((n) => n === "ops_health_report")).toHaveLength(2);
    expect(code).toBe(0);
  });

  it("exits 2 without retrying on a 401", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(401, "unauthorized"));
    const sleep = vi.fn();
    const { log } = harness();
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep, log, appendSummary: vi.fn() });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(code).toBe(2);
  });

  it("exits 2 on a second consecutive 5xx failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(503, "unavailable"))
      .mockResolvedValueOnce(textResponse(503, "still unavailable"));
    const code = await runHeartbeat({
      env: goodEnv,
      fetchImpl,
      sleep: vi.fn().mockResolvedValue(undefined),
      log: vi.fn(),
      appendSummary: vi.fn(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(code).toBe(2);
  });

  it("returns 1 and logs a FAIL table when a row is 'fail'", async () => {
    const rows = [{ check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30, detail: "40/96" }];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, rows));
    const { log, logged } = harness();
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log, appendSummary: vi.fn() });
    expect(code).toBe(1);
    expect(logged.join("\n")).toContain("FAIL");
  });

  it("returns 0 for an all-healthy report", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, HEALTHY_ROWS));
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log: vi.fn(), appendSummary: vi.fn() });
    expect(code).toBe(0);
  });

  it("returns 1 when at least half the rows are 'unknown'", async () => {
    const rows = [
      { check_name: "a", status: "unknown" },
      { check_name: "b", status: "unknown" },
      { check_name: "c", status: "pass" },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, rows));
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log: vi.fn(), appendSummary: vi.fn() });
    expect(code).toBe(1);
  });

  it("returns 1 for an empty report ([])", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, []));
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log: vi.fn(), appendSummary: vi.fn() });
    expect(code).toBe(1);
  });

  it("never logs the service-role key, in any logged line or the summary", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, `leaked ${SECRET_KEY} in body`))
      .mockResolvedValueOnce(jsonResponse(200, HEALTHY_ROWS));
    const { log, appendSummary, logged, summaries } = harness();
    await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn().mockResolvedValue(undefined), log, appendSummary });
    for (const line of logged) {
      expect(line).not.toContain(SECRET_KEY);
    }
    for (const md of summaries) {
      expect(md).not.toContain(SECRET_KEY);
    }
  });

  it("logs only the status code and the first 200 characters of the body on a terminal failure", async () => {
    const longBody = "x".repeat(500);
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(401, longBody));
    const { log, logged } = harness();
    await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log, appendSummary: vi.fn() });
    const combined = logged.join("\n");
    expect(combined).toContain("401");
    expect(combined).not.toContain("x".repeat(300));
  });

  it("redacts the key from a terminal error body that echoes it back", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(textResponse(401, `bad credentials ${SECRET_KEY}`));
    const { log, logged } = harness();
    await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log, appendSummary: vi.fn() });
    expect(logged.join("\n")).toContain("401");
    for (const line of logged) expect(line).not.toContain(SECRET_KEY);
  });
});

// ---------------------------------------------------------------------------
// Migration 131 backstops (h10-silent-1 / h10-silent-2).
//
// The GitHub '*/30' schedule really runs ~every 4 h, so the 30-minute-window
// rows of ops_health_report() miss most incidents. pg_cron snapshots the
// non-pass rows every 10 minutes (ops_health_snapshots); this script pages on
// every unnotified FAIL snapshot, then marks it notified. It also reads the
// archive hole (ops_archive_gap_days) because the 03:40 export never retried.
// ---------------------------------------------------------------------------

describe("backstop constants", () => {
  it("pins the archive gap thresholds (7 missing days; 40 - 7 = 33 days of reach)", () => {
    expect(ARCHIVE_GAP_FAIL_COUNT).toBe(7);
    expect(ARCHIVE_GAP_EDGE_DAYS).toBe(33);
    expect(ARCHIVE_GAP_EDGE_DAYS).toBe(40 - ARCHIVE_GAP_FAIL_COUNT);
  });
});

describe("buildRpcRequest (other RPCs)", () => {
  it("defaults to ops_health_report with body '{}'", () => {
    const { url, init } = buildRpcRequest("https://proj.supabase.co", SECRET_KEY);
    expect(url).toBe("https://proj.supabase.co/rest/v1/rpc/ops_health_report");
    expect(init.body).toBe("{}");
  });

  it("targets another RPC and serialises its JSON body", () => {
    const { url, init } = buildRpcRequest("https://proj.supabase.co", SECRET_KEY, "ops_health_mark_notified", {
      p_ids: [11, 12],
    });
    expect(url).toBe("https://proj.supabase.co/rest/v1/rpc/ops_health_mark_notified");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ p_ids: [11, 12] });
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("refuses an RPC name that is not a plain identifier (no path tricks)", () => {
    for (const bad of ["", "../auth/v1/admin", "ops health", "ops_health_report?x=1", "Ops-Health", 7, null]) {
      expect(() => buildRpcRequest("https://proj.supabase.co", SECRET_KEY, bad, {})).toThrow();
    }
  });
});

describe("evaluate with extras", () => {
  // today (UTC) = 2026-11-01; the fail edge is today - 33 = 2026-09-29.
  const NOW = new Date("2026-11-01T12:00:00Z");
  const MISSED = [
    { id: 11, taken_at: "2026-10-31T14:24:03.5+00:00", check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30, detail: "40/96" },
  ];

  it("without extras the old behaviour is unchanged (and no archive row appears)", () => {
    expect(evaluate(HEALTHY_ROWS).exitCode).toBe(0);
    expect(evaluate(HEALTHY_ROWS, {}).exitCode).toBe(0);
    expect(evaluate(HEALTHY_ROWS, { missed: [], archive: null, now: NOW }).exitCode).toBe(0);
    expect(evaluate(HEALTHY_ROWS, {}).archiveRow).toBeNull();
    expect(evaluate([], {}).exitCode).toBe(1);
  });

  it("any missed row gives exitCode 1, even when the live report is clean", () => {
    const r = evaluate(HEALTHY_ROWS, { missed: MISSED, now: NOW });
    expect(r.exitCode).toBe(1);
    expect(r.missed).toHaveLength(1);
  });

  describe("archive row", () => {
    const archive = (missing_days, oldest_missing) => evaluate(HEALTHY_ROWS, { archive: { missing_days, oldest_missing }, now: NOW });

    it("is pass (and exit 0) when nothing is missing", () => {
      const r = archive(0, null);
      expect(r.archiveRow).toMatchObject({ check_name: "archive_gap_days", status: "pass", observed: 0, threshold: 7 });
      expect(r.exitCode).toBe(0);
    });

    it("is warn (exit 0) for 1..6 missing days whose oldest is within 33 days", () => {
      const r = archive(6, "2026-10-12");
      expect(r.archiveRow).toMatchObject({ status: "warn", observed: 6, detail: "en eski eksik gün: 2026-10-12" });
      expect(r.exitCode).toBe(0);
      expect(r.warnings.map((w) => w.check_name)).toContain("archive_gap_days");
      expect(archive(1, "2026-10-31").archiveRow.status).toBe("warn");
    });

    it("sits exactly on the edge: today-33 warns, today-34 fails", () => {
      expect(archive(1, "2026-09-29").archiveRow.status).toBe("warn");
      const r = archive(1, "2026-09-28");
      expect(r.archiveRow.status).toBe("fail");
      expect(r.exitCode).toBe(1);
      expect(r.failing.map((f) => f.check_name)).toContain("archive_gap_days");
    });

    it("fails (exit 1) from 7 missing days on, however recent", () => {
      expect(archive(6, "2026-10-30").archiveRow.status).toBe("warn");
      const r = archive(7, "2026-10-30");
      expect(r.archiveRow.status).toBe("fail");
      expect(r.exitCode).toBe(1);
    });

    it("uses the UTC calendar day of `now` for the edge", () => {
      // 23:59 UTC on 10-31 -> today = 10-31 -> edge 09-28: 09-28 warns here, fails a minute later.
      const before = evaluate(HEALTHY_ROWS, { archive: { missing_days: 1, oldest_missing: "2026-09-28" }, now: new Date("2026-10-31T23:59:00Z") });
      const after = evaluate(HEALTHY_ROWS, { archive: { missing_days: 1, oldest_missing: "2026-09-28" }, now: new Date("2026-11-01T00:00:00Z") });
      expect(before.archiveRow.status).toBe("warn");
      expect(after.archiveRow.status).toBe("fail");
    });

    it("a missing oldest_missing with a gap still warns (and never throws)", () => {
      const r = archive(2, null);
      expect(r.archiveRow.status).toBe("warn");
      expect(r.archiveRow.detail).toBeNull();
    });
  });

  it("synthetic rows never count toward the half-unknown rule or the empty rule", () => {
    const live = [
      { check_name: "a", status: "pass" },
      { check_name: "b", status: "pass" },
      { check_name: "c", status: "unknown" },
    ];
    const synthetic = [
      { check_name: "snapshot_backstop", status: "unknown", synthetic: true },
      { check_name: "archive_gap_days", status: "unknown", synthetic: true },
    ];
    // 3 of 5 would be >= half if the synthetic rows counted.
    const r = evaluate([...live, ...synthetic], { now: NOW });
    expect(r.exitCode).toBe(0);
    expect(r.unknown.map((u) => u.check_name)).toEqual(["c"]);
    // Only synthetic rows is still an empty (blind) report.
    expect(evaluate(synthetic, { now: NOW }).exitCode).toBe(1);
  });
});

describe("formatters with missed events and the archive row", () => {
  const MISSED = [
    { id: 11, taken_at: "2026-10-31T14:24:03.5+00:00", check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30, detail: "40/96" },
    { id: 12, taken_at: "2026-10-31T17:24:03+03:00", check_name: "ingest_cycles_30m", status: "fail", observed: 2, threshold: 5, detail: null },
  ];
  const ARCHIVE_ROW = { check_name: "archive_gap_days", status: "warn", observed: 6, threshold: 7, detail: "en eski eksik gün: 2026-10-12", synthetic: true };

  it("formatTable lists 'kaçırılan: <check> @ <YYYY-MM-DD HH:MI UTC> · <detail>' lines", () => {
    const table = formatTable(HEALTHY_ROWS, MISSED);
    expect(table).toContain("kaçırılan: dead_feeds @ 2026-10-31 14:24 UTC · 40/96");
    // an offset timestamp is shown in UTC; a null detail drops the separator
    expect(table).toContain("kaçırılan: ingest_cycles_30m @ 2026-10-31 14:24 UTC");
    expect(table).not.toContain("ingest_cycles_30m @ 2026-10-31 14:24 UTC ·");
  });

  it("formatTable without missed events is byte-identical to the old table", () => {
    expect(formatTable(HEALTHY_ROWS, [])).toBe(formatTable(HEALTHY_ROWS));
    expect(formatTable(HEALTHY_ROWS)).not.toContain("kaçırılan");
  });

  it("formatTable renders the archive row with its detail", () => {
    const table = formatTable([...HEALTHY_ROWS, ARCHIVE_ROW]);
    expect(table).toContain("archive_gap_days");
    expect(table).toContain("WARN");
    expect(table).toContain("en eski eksik gün: 2026-10-12");
  });

  it("formatMarkdown lists the missed events and escapes pipes in their detail", () => {
    const md = formatMarkdown(HEALTHY_ROWS, "ALERT", [{ ...MISSED[0], detail: "a | b" }]);
    expect(md).toContain("ALERT");
    expect(md).toContain("kaçırılan: dead_feeds @ 2026-10-31 14:24 UTC · a \\| b");
  });

  it("formatMarkdown without missed events is unchanged", () => {
    expect(formatMarkdown(HEALTHY_ROWS, "OK", [])).toBe(formatMarkdown(HEALTHY_ROWS, "OK"));
    expect(formatMarkdown(HEALTHY_ROWS, "OK")).not.toContain("kaçırılan");
  });

  it("keeps an unparseable timestamp readable instead of printing 'Invalid Date'", () => {
    const table = formatTable(HEALTHY_ROWS, [{ id: 1, taken_at: "garbage", check_name: "x", status: "fail", detail: "d" }]);
    expect(table).toContain("kaçırılan: x @ garbage · d");
    expect(table).not.toContain("Invalid");
  });
});

describe("runHeartbeat backstops", () => {
  const goodEnv = { SUPABASE_URL: "https://proj.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY };
  const NOW = () => new Date("2026-11-01T12:00:00Z");
  const FAIL_SNAPSHOTS = [
    { id: 11, taken_at: "2026-10-31T14:24:03+00:00", check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30, detail: "40/96" },
    { id: 12, taken_at: "2026-10-31T14:34:03+00:00", check_name: "dead_feeds", status: "fail", observed: 41, threshold: 30, detail: "41/96" },
  ];
  const NO_GAP = [{ missing_days: 0, oldest_missing: null }];

  /** Routes by RPC name; each handler returns a FRESH Response per call. */
  function setup(handlers = {}) {
    const events = [];
    const logged = [];
    const summaries = [];
    const calls = [];
    const table = {
      ops_health_report: () => jsonResponse(200, HEALTHY_ROWS),
      ops_health_unnotified: () => jsonResponse(200, []),
      ops_archive_gap_days: () => jsonResponse(200, NO_GAP),
      ops_health_mark_notified: () => jsonResponse(200, 0),
      ...handlers,
    };
    const fetchImpl = vi.fn(async (url, init) => {
      const fn = String(url).split("/rpc/")[1];
      calls.push({ fn, body: init.body, headers: init.headers });
      events.push(`fetch:${fn}`);
      const h = table[fn];
      if (!h) throw new Error(`unexpected rpc ${fn}`);
      return h(init);
    });
    return {
      fetchImpl,
      events,
      logged,
      summaries,
      calls,
      run: () =>
        runHeartbeat({
          env: goodEnv,
          fetchImpl,
          sleep: vi.fn().mockResolvedValue(undefined),
          now: NOW,
          log: (line) => {
            events.push("log");
            logged.push(String(line));
          },
          appendSummary: (md) => {
            events.push("summary");
            summaries.push(String(md));
          },
        }),
    };
  }

  const names = (h) => h.calls.map((c) => c.fn);

  it("calls ops_health_report, ops_health_unnotified, ops_archive_gap_days in that order, all with the key", async () => {
    const h = setup();
    const code = await h.run();
    expect(code).toBe(0);
    expect(names(h)).toEqual(["ops_health_report", "ops_health_unnotified", "ops_archive_gap_days"]);
    for (const c of h.calls) {
      expect(c.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
      expect(c.body).toBe("{}");
    }
  });

  it("clean everywhere: does not call ops_health_mark_notified", async () => {
    const h = setup();
    await h.run();
    expect(names(h)).not.toContain("ops_health_mark_notified");
  });

  it("an unnotified FAIL snapshot pages (exit 1), is listed, and is marked notified AFTER the summary, once", async () => {
    const h = setup({ ops_health_unnotified: () => jsonResponse(200, FAIL_SNAPSHOTS) });
    const code = await h.run();

    expect(code).toBe(1);
    const log = h.logged.join("\n");
    expect(log).toContain("kaçırılan: dead_feeds @ 2026-10-31 14:24 UTC · 40/96");
    expect(log).toContain("kaçırılan: dead_feeds @ 2026-10-31 14:34 UTC · 41/96");
    expect(h.summaries.join("\n")).toContain("kaçırılan: dead_feeds @ 2026-10-31 14:24 UTC");
    expect(h.summaries.join("\n")).toContain("ALERT");

    const marks = h.calls.filter((c) => c.fn === "ops_health_mark_notified");
    expect(marks).toHaveLength(1);
    expect(JSON.parse(marks[0].body)).toEqual({ p_ids: [11, 12] });
    expect(h.events.indexOf("fetch:ops_health_mark_notified")).toBeGreaterThan(h.events.indexOf("summary"));
    expect(h.events.indexOf("fetch:ops_health_mark_notified")).toBeGreaterThan(h.events.lastIndexOf("log"));
  });

  it("still marks when the caller gives no summary sink", async () => {
    const h = setup({ ops_health_unnotified: () => jsonResponse(200, FAIL_SNAPSHOTS) });
    const code = await runHeartbeat({ env: goodEnv, fetchImpl: h.fetchImpl, sleep: vi.fn(), now: NOW, log: vi.fn() });
    expect(code).toBe(1);
    expect(names(h)).toContain("ops_health_mark_notified");
  });

  it("a live FAIL with nothing missed still pages and does NOT call mark", async () => {
    const h = setup({
      ops_health_report: () => jsonResponse(200, [{ check_name: "dead_feeds", status: "fail", observed: 40, threshold: 30 }]),
    });
    expect(await h.run()).toBe(1);
    expect(names(h)).not.toContain("ops_health_mark_notified");
  });

  it("ignores duplicate ids when marking", async () => {
    const dup = [FAIL_SNAPSHOTS[0], FAIL_SNAPSHOTS[0], FAIL_SNAPSHOTS[1]];
    const h = setup({ ops_health_unnotified: () => jsonResponse(200, dup) });
    await h.run();
    const mark = h.calls.find((c) => c.fn === "ops_health_mark_notified");
    expect(JSON.parse(mark.body)).toEqual({ p_ids: [11, 12] });
  });

  it("shows the archive hole as a warn row (exit 0) with the oldest missing day", async () => {
    const h = setup({ ops_archive_gap_days: () => jsonResponse(200, [{ missing_days: 6, oldest_missing: "2026-10-12" }]) });
    const code = await h.run();
    expect(code).toBe(0);
    const log = h.logged.join("\n");
    expect(log).toContain("archive_gap_days");
    expect(log).toContain("WARN");
    expect(log).toContain("en eski eksik gün: 2026-10-12");
    expect(h.summaries.join("\n")).toContain("en eski eksik gün: 2026-10-12");
  });

  it("pages when the hole can no longer close in time (oldest older than today-33)", async () => {
    const h = setup({ ops_archive_gap_days: () => jsonResponse(200, [{ missing_days: 2, oldest_missing: "2026-09-20" }]) });
    expect(await h.run()).toBe(1);
    expect(h.logged.join("\n")).toContain("FAIL");
  });

  it("pages at 7 missing days", async () => {
    const h = setup({ ops_archive_gap_days: () => jsonResponse(200, [{ missing_days: 7, oldest_missing: "2026-10-30" }]) });
    expect(await h.run()).toBe(1);
  });

  it("a 404 PGRST202 on ops_health_unnotified adds an 'unknown' snapshot_backstop row and keeps the exit code", async () => {
    const h = setup({
      ops_health_unnotified: () =>
        jsonResponse(404, { code: "PGRST202", message: "Could not find the function public.ops_health_unnotified" }),
    });
    const code = await h.run();
    expect(code).toBe(0);
    const log = h.logged.join("\n");
    expect(log).toContain("snapshot_backstop");
    expect(log).toContain("UNKNOWN");
    expect(log).toContain("okunamadı (131 uygulanmadı mı?)");
    expect(names(h)).not.toContain("ops_health_mark_notified");
    // the archive read still happens
    expect(names(h)).toContain("ops_archive_gap_days");
  });

  it("a 404 on ops_archive_gap_days adds an 'unknown' archive_gap_days row and keeps the exit code", async () => {
    const h = setup({
      ops_archive_gap_days: () => jsonResponse(404, { code: "PGRST202", message: "Could not find the function" }),
    });
    expect(await h.run()).toBe(0);
    const log = h.logged.join("\n");
    expect(log).toContain("archive_gap_days");
    expect(log).toContain("okunamadı (131 uygulanmadı mı?)");
  });

  it("a 5xx or a network error on a backstop is also an 'unknown' row, never a crash and never exit 2", async () => {
    const h = setup({
      ops_health_unnotified: () => textResponse(503, "unavailable"),
      ops_archive_gap_days: () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(await h.run()).toBe(0);
    const log = h.logged.join("\n");
    expect(log).toContain("snapshot_backstop");
    expect(log).toContain("archive_gap_days");
    expect(log).toContain("okunamadı");
  });

  it("an unreadable or malformed backstop response is an 'unknown' row", async () => {
    const h = setup({
      ops_health_unnotified: () => jsonResponse(200, { not: "an array" }),
      ops_archive_gap_days: () => jsonResponse(200, [{ missing_days: "many" }]),
    });
    expect(await h.run()).toBe(0);
    const log = h.logged.join("\n");
    expect(log).toContain("snapshot_backstop");
    expect(log).toContain("archive_gap_days");
  });

  it("synthetic unknown rows do not trip the half-unknown rule", async () => {
    const live = [
      { check_name: "a", status: "pass" },
      { check_name: "b", status: "pass" },
      { check_name: "c", status: "unknown" },
    ];
    const h = setup({
      ops_health_report: () => jsonResponse(200, live),
      ops_health_unnotified: () => jsonResponse(404, { code: "PGRST202" }),
      ops_archive_gap_days: () => jsonResponse(404, { code: "PGRST202" }),
    });
    expect(await h.run()).toBe(0);
  });

  it("a failing mark is logged and does not change the exit code", async () => {
    const h = setup({
      ops_health_unnotified: () => jsonResponse(200, FAIL_SNAPSHOTS),
      ops_health_mark_notified: () => textResponse(500, "boom"),
    });
    const code = await h.run();
    expect(code).toBe(1);
    const marks = h.calls.filter((c) => c.fn === "ops_health_mark_notified");
    expect(marks).toHaveLength(1); // no retry: at-least-once paging is the safe direction
    expect(h.logged.join("\n")).toMatch(/ops_health_mark_notified.*500/);
  });

  it("a mark that throws (network) is logged and does not change the exit code", async () => {
    const h = setup({
      ops_health_unnotified: () => jsonResponse(200, FAIL_SNAPSHOTS),
      ops_health_mark_notified: () => {
        throw new Error("ECONNRESET");
      },
    });
    expect(await h.run()).toBe(1);
    expect(h.logged.join("\n")).toMatch(/ops_health_mark_notified.*ECONNRESET/);
  });

  it("a report failure (exit 2) never reaches the backstops, so nothing is marked", async () => {
    const h = setup({ ops_health_report: () => textResponse(401, "unauthorized") });
    expect(await h.run()).toBe(2);
    expect(names(h)).toEqual(["ops_health_report"]);
  });

  it("never prints the key, even when a backstop error body or exception echoes it", async () => {
    const h = setup({
      ops_health_unnotified: () => textResponse(500, `internal error for ${SECRET_KEY}`),
      ops_archive_gap_days: () => {
        throw new Error(`fetch failed for Bearer ${SECRET_KEY}`);
      },
    });
    await h.run();
    const h2 = setup({
      ops_health_unnotified: () => jsonResponse(200, FAIL_SNAPSHOTS),
      ops_health_mark_notified: () => textResponse(500, `denied ${SECRET_KEY}`),
    });
    await h2.run();
    for (const line of [...h.logged, ...h.summaries, ...h2.logged, ...h2.summaries]) {
      expect(line).not.toContain(SECRET_KEY);
    }
    expect(h.logged.length).toBeGreaterThan(0);
  });

  it("defaults `now` to the real clock when the caller passes none", async () => {
    const h = setup({ ops_archive_gap_days: () => jsonResponse(200, [{ missing_days: 1, oldest_missing: "2026-10-12" }]) });
    // With the real clock (>= 2026-11-01) 2026-10-12 is within 33 days only until 2026-11-14;
    // the point of this test is that omitting `now` does not throw.
    const code = await runHeartbeat({ env: goodEnv, fetchImpl: h.fetchImpl, sleep: vi.fn(), log: vi.fn(), appendSummary: vi.fn() });
    expect([0, 1]).toContain(code);
  });
});
