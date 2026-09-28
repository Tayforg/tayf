import { describe, it, expect, vi } from "vitest";
import {
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
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, HEALTHY_ROWS));
    await runHeartbeat({ env: goodEnv, fetchImpl, sleep: vi.fn(), log: vi.fn(), appendSummary: vi.fn() });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("retries once (after sleeping) on a 500 then succeeds on a 200", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(textResponse(500, "internal error"))
      .mockResolvedValueOnce(jsonResponse(200, HEALTHY_ROWS));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const { log } = harness();
    const code = await runHeartbeat({ env: goodEnv, fetchImpl, sleep, log, appendSummary: vi.fn() });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
    expect(fetchImpl).toHaveBeenCalledTimes(2);
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
});
