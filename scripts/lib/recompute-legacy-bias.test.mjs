import { describe, it, expect, vi, afterEach } from "vitest";
import { parseArgs, buildWindows, runLegacyBias } from "./recompute-legacy-bias.mjs";

// Pure tests: a fake fetch, no network, no database. The operator tool walks
// updated_at windows and calls the two service_role functions of migration 132
// (recompute_bias_distribution_range, then clear_false_blindspots_range), a dry
// run unless --apply is given.

const SECRET_KEY = "sb_secret_do_not_leak_1234567890";
const URL_OK = "https://abcdefgh.supabase.co";
const ENV = { SUPABASE_URL: URL_OK, SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY };

const DRY_BANNER = "DRY RUN: nothing is written. Re-run with --apply to write.";
const APPLY_BANNER = "APPLY: writing bias_distribution and clearing false flags.";

const RECOMPUTE = "recompute_bias_distribution_range";
const CLEAR = "clear_false_blindspots_range";

afterEach(() => {
  vi.restoreAllMocks();
});

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function textResponse(status, body) {
  return new Response(body, { status });
}

/** The RPC name of a fetch call. */
const rpcName = (call) => String(call[0]).split("/rpc/")[1];
const bodyOf = (call) => JSON.parse(call[1].body);

/**
 * A fake fetch that answers every recompute with `rec(i)` and every clear with
 * `clr(i)` (i = window index), as one-row arrays. `override(name, i)` may return
 * a Response (or throw) instead.
 */
function fakeFetch({ rec, clr, override } = {}) {
  const seen = { [RECOMPUTE]: 0, [CLEAR]: 0 };
  return vi.fn(async (url) => {
    const name = String(url).split("/rpc/")[1];
    const i = seen[name]++;
    if (override) {
      const r = override(name, i);
      if (r) return r;
    }
    if (name === RECOMPUTE) {
      return jsonResponse(200, [rec ? rec(i) : { scanned: 10, would_change: 3, changed: 0 }]);
    }
    if (name === CLEAR) {
      return jsonResponse(200, [clr ? clr(i) : { would_clear: 2, would_newly_flag: 1, cleared: 0 }]);
    }
    return textResponse(404, "unknown rpc");
  });
}

async function run(argv, { env = ENV, fetchImpl = fakeFetch() } = {}) {
  const lines = [];
  const code = await runLegacyBias({ argv, env, fetchImpl, log: (l) => lines.push(l) });
  return { code, lines, fetchImpl };
}

describe("parseArgs", () => {
  it("requires --from and --to", () => {
    expect(() => parseArgs([])).toThrow(/--from/);
    expect(() => parseArgs(["--from", "2026-04-01"])).toThrow(/--to/);
    expect(() => parseArgs(["--to", "2026-09-05"])).toThrow(/--from/);
  });

  it("returns the days as given, days 7 and apply false by default", () => {
    expect(parseArgs(["--from", "2026-04-01", "--to", "2026-09-05"])).toEqual({
      from: "2026-04-01",
      to: "2026-09-05",
      days: 7,
      apply: false,
    });
  });

  it("accepts --flag=value and any flag order", () => {
    expect(parseArgs(["--apply", "--to=2026-09-05", "--days=3", "--from=2026-04-01"])).toEqual({
      from: "2026-04-01",
      to: "2026-09-05",
      days: 3,
      apply: true,
    });
  });

  it("--apply is a boolean flag: it takes no value", () => {
    expect(parseArgs(["--from", "2026-04-01", "--to", "2026-09-05", "--apply"]).apply).toBe(true);
    expect(() => parseArgs(["--from", "2026-04-01", "--to", "2026-09-05", "--apply=true"])).toThrow(/--apply/);
    expect(() => parseArgs(["--from", "2026-04-01", "--to", "2026-09-05", "--apply", "false"])).toThrow();
  });

  it.each(["2026-4-01", "2026-04-01T00:00:00Z", "01.04.2026", "20260401", "", "2026-02-30", "2026-13-01", "tomorrow"])(
    "rejects the date %j (YYYY-MM-DD, a real UTC day)",
    (bad) => {
      expect(() => parseArgs(["--from", bad, "--to", "2026-09-05"])).toThrow(/YYYY-MM-DD/);
      expect(() => parseArgs(["--from", "2026-04-01", "--to", bad])).toThrow(/YYYY-MM-DD/);
    },
  );

  it.each([["0"], ["32"], ["-1"], ["1.5"], ["abc"], [""], ["7days"]])("rejects --days %j (an integer 1..31)", (bad) => {
    expect(() => parseArgs(["--from", "2026-04-01", "--to", "2026-09-05", "--days", bad])).toThrow(/--days/);
  });

  it.each([["1"], ["7"], ["31"]])("accepts --days %s", (ok) => {
    expect(parseArgs(["--from", "2026-04-01", "--to", "2026-09-05", "--days", ok]).days).toBe(Number(ok));
  });

  it("rejects --to on or before --from", () => {
    expect(() => parseArgs(["--from", "2026-09-05", "--to", "2026-09-05"])).toThrow(/after/);
    expect(() => parseArgs(["--from", "2026-09-05", "--to", "2026-04-01"])).toThrow(/after/);
  });

  it("rejects unknown flags, positional arguments, missing values and repeated flags", () => {
    const base = ["--from", "2026-04-01", "--to", "2026-09-05"];
    expect(() => parseArgs([...base, "--dry-run"])).toThrow(/unknown/i);
    expect(() => parseArgs([...base, "--force"])).toThrow(/unknown/i);
    expect(() => parseArgs([...base, "extra"])).toThrow(/unexpected/i);
    expect(() => parseArgs(["--from"])).toThrow(/--from/);
    expect(() => parseArgs(["--from", "--to", "2026-09-05"])).toThrow(/--from/);
    expect(() => parseArgs([...base, "--from", "2026-05-01"])).toThrow(/twice|more than once|repeated/i);
  });
});

describe("buildWindows", () => {
  it("2026-04-01 .. 2026-09-05 in 7-day steps is 23 contiguous half-open windows", () => {
    const w = buildWindows("2026-04-01", "2026-09-05", 7);
    expect(w).toHaveLength(23);
    expect(w[0]).toEqual({ from: "2026-04-01", to: "2026-04-08" });
    expect(w[0].from).toBe("2026-04-01");
    expect(w[w.length - 1].to).toBe("2026-09-05");
    // the last window is the short remainder (157 days = 22 * 7 + 3)
    expect(w[w.length - 1]).toEqual({ from: "2026-09-02", to: "2026-09-05" });
    for (let i = 1; i < w.length; i++) expect(w[i].from).toBe(w[i - 1].to);
  });

  it("every window is at most `days` long and starts before it ends", () => {
    const day = 86_400_000;
    for (const days of [1, 7, 31]) {
      for (const win of buildWindows("2026-04-01", "2026-06-15", days)) {
        const len = (Date.parse(`${win.to}T00:00:00Z`) - Date.parse(`${win.from}T00:00:00Z`)) / day;
        expect(len).toBeGreaterThan(0);
        expect(len).toBeLessThanOrEqual(days);
      }
    }
  });

  it("covers the range exactly: no gap, no overlap, first.from = from, last.to = to", () => {
    const w = buildWindows("2026-01-31", "2026-03-02", 10);
    expect(w[0].from).toBe("2026-01-31");
    expect(w[w.length - 1].to).toBe("2026-03-02");
    for (let i = 1; i < w.length; i++) expect(w[i].from).toBe(w[i - 1].to);
    // a month end is crossed without skipping a day: 31 Jan + 10 days is 10 Feb
    expect(w[0].to).toBe("2026-02-10");
  });

  it("a range shorter than one step is a single window; an exact multiple has no extra window", () => {
    expect(buildWindows("2026-04-01", "2026-04-04", 7)).toEqual([{ from: "2026-04-01", to: "2026-04-04" }]);
    expect(buildWindows("2026-04-01", "2026-04-15", 7)).toHaveLength(2);
  });

  it("allows exactly 200 windows and throws above that", () => {
    // 200 windows of 7 days = 1400 days = 2020-01-01 .. 2023-11-01; one more day needs a 201st window
    expect(buildWindows("2020-01-01", "2023-11-01", 7)).toHaveLength(200);
    expect(() => buildWindows("2020-01-01", "2023-11-02", 7)).toThrow(/200/);
    expect(() => buildWindows("2009-01-08", "2026-09-05", 7)).toThrow(/windows/);
  });

  it("rejects an empty or inverted range and a bad step", () => {
    expect(() => buildWindows("2026-04-01", "2026-04-01", 7)).toThrow();
    expect(() => buildWindows("2026-04-02", "2026-04-01", 7)).toThrow();
    expect(() => buildWindows("2026-04-01", "2026-05-01", 0)).toThrow();
    expect(() => buildWindows("2026-04-01", "2026-05-01", 32)).toThrow();
    expect(() => buildWindows("2026-04-01", "2026-05-01", 1.5)).toThrow();
  });
});

describe("runLegacyBias: a dry run", () => {
  const ARGV = ["--from", "2026-04-01", "--to", "2026-04-15"];

  it("prints the dry-run banner first", async () => {
    const { lines } = await run(ARGV);
    expect(lines[0]).toBe(DRY_BANNER);
  });

  it("sends p_dry_run true on EVERY call and never false", async () => {
    const { fetchImpl, code } = await run(ARGV);
    expect(code).toBe(0);
    expect(fetchImpl.mock.calls.length).toBe(4); // 2 windows x (recompute, clear)
    for (const call of fetchImpl.mock.calls) {
      const body = bodyOf(call);
      expect(body.p_dry_run).toBe(true);
      expect(JSON.stringify(body)).not.toContain("false");
    }
  });

  it("per window calls recompute first, then clear, in window order, with UTC-midnight bounds", async () => {
    const { fetchImpl } = await run(ARGV);
    const calls = fetchImpl.mock.calls;
    expect(calls.map(rpcName)).toEqual([RECOMPUTE, CLEAR, RECOMPUTE, CLEAR]);
    expect(bodyOf(calls[0])).toEqual({ p_from: "2026-04-01T00:00:00Z", p_to: "2026-04-08T00:00:00Z", p_dry_run: true });
    expect(bodyOf(calls[1])).toEqual(bodyOf(calls[0]));
    expect(bodyOf(calls[2])).toEqual({ p_from: "2026-04-08T00:00:00Z", p_to: "2026-04-15T00:00:00Z", p_dry_run: true });
    expect(String(calls[0][0])).toBe(`${URL_OK}/rest/v1/rpc/${RECOMPUTE}`);
  });

  it("authenticates with the service-role key (apikey and bearer) over POST", async () => {
    const { fetchImpl } = await run(ARGV);
    const init = fetchImpl.mock.calls[0][1];
    expect(init.method).toBe("POST");
    expect(init.headers.apikey).toBe(SECRET_KEY);
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it("gives every request a 30 s timeout signal and never retries", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const { fetchImpl } = await run(ARGV);
    expect(timeout).toHaveBeenCalledWith(30_000);
    expect(timeout).toHaveBeenCalledTimes(fetchImpl.mock.calls.length);
    for (const call of fetchImpl.mock.calls) expect(call[1].signal).toBeInstanceOf(AbortSignal);
  });

  it("prints one line per window and a TOTAL line that sums all six counters", async () => {
    const fetchImpl = fakeFetch({
      rec: (i) => ({ scanned: 100 + i, would_change: 10 + i, changed: i }),
      clr: (i) => ({ would_clear: 5 + i, would_newly_flag: 2 * i, cleared: 3 * i }),
    });
    const { lines } = await run(["--from", "2026-04-01", "--to", "2026-04-22"], { fetchImpl });
    expect(lines[1]).toBe("2026-04-01..2026-04-08  scanned=100 would_change=10 changed=0 | would_clear=5 would_newly_flag=0 cleared=0");
    expect(lines[2]).toBe("2026-04-08..2026-04-15  scanned=101 would_change=11 changed=1 | would_clear=6 would_newly_flag=2 cleared=3");
    expect(lines[3]).toBe("2026-04-15..2026-04-22  scanned=102 would_change=12 changed=2 | would_clear=7 would_newly_flag=4 cleared=6");
    // 100+101+102, 10+11+12, 0+1+2, 5+6+7, 0+2+4, 0+3+6
    expect(lines[lines.length - 1]).toBe("TOTAL  scanned=303 would_change=33 changed=3 | would_clear=18 would_newly_flag=6 cleared=9");
  });

  it("exits 0 and logs nothing else", async () => {
    const { lines, code } = await run(ARGV);
    expect(code).toBe(0);
    expect(lines).toHaveLength(1 + 2 + 1); // banner, two windows, total
  });
});

describe("runLegacyBias: --apply", () => {
  const ARGV = ["--from", "2026-04-01", "--to", "2026-04-15", "--apply"];

  it("prints the apply banner first", async () => {
    const { lines } = await run(ARGV);
    expect(lines[0]).toBe(APPLY_BANNER);
  });

  it("sends p_dry_run false on every call", async () => {
    const { fetchImpl, code } = await run(ARGV);
    expect(code).toBe(0);
    expect(fetchImpl.mock.calls.length).toBe(4);
    for (const call of fetchImpl.mock.calls) expect(bodyOf(call).p_dry_run).toBe(false);
    expect(fetchImpl.mock.calls.map(rpcName)).toEqual([RECOMPUTE, CLEAR, RECOMPUTE, CLEAR]);
  });

  it("honours --days", async () => {
    const { fetchImpl } = await run(["--from", "2026-04-01", "--to", "2026-04-04", "--days", "1"]);
    expect(fetchImpl.mock.calls.length).toBe(6); // 3 windows x 2
    expect(bodyOf(fetchImpl.mock.calls[2])).toEqual({ p_from: "2026-04-02T00:00:00Z", p_to: "2026-04-03T00:00:00Z", p_dry_run: true });
  });
});

describe("runLegacyBias: the key never reaches a log line", () => {
  const ARGV = ["--from", "2026-04-01", "--to", "2026-04-15"];
  const noKey = (lines) => {
    for (const line of lines) expect(String(line)).not.toContain(SECRET_KEY);
  };

  it("not on a normal run", async () => {
    const { lines } = await run(ARGV);
    noKey(lines);
  });

  it("not when the server's error body echoes it", async () => {
    const fetchImpl = fakeFetch({ override: () => textResponse(401, `{"message":"Invalid API key ${SECRET_KEY}","hint":"Bearer ${SECRET_KEY}"}`) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    noKey(lines);
    expect(lines.join("\n")).toContain("***");
  });

  it("not when a network error message contains it", async () => {
    const fetchImpl = fakeFetch({
      override: () => {
        throw new Error(`connect failed for apikey=${SECRET_KEY}`);
      },
    });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    noKey(lines);
  });

  it("not when a malformed row contains it", async () => {
    const fetchImpl = fakeFetch({ override: (name) => (name === RECOMPUTE ? jsonResponse(200, [{ scanned: SECRET_KEY }]) : null) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    noKey(lines);
  });
});

describe("runLegacyBias: failures stop the run", () => {
  const ARGV = ["--from", "2026-04-01", "--to", "2026-06-01"];

  it("the first HTTP error stops the run with exit 1 and names the window and the rerun command", async () => {
    // second window's recompute fails
    const fetchImpl = fakeFetch({ override: (name, i) => (name === RECOMPUTE && i === 1 ? textResponse(500, "boom") : null) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    // window 1 (recompute + clear) then window 2's failed recompute: 3 calls, nothing after
    expect(fetchImpl.mock.calls.length).toBe(3);
    const text = lines.join("\n");
    expect(text).toContain("2026-04-08..2026-04-15");
    expect(text).toContain("HTTP 500");
    expect(text).toContain("rerun with --from 2026-04-08");
    expect(text).not.toMatch(/--days 1/);
    expect(lines.some((l) => l.startsWith("TOTAL"))).toBe(false);
  });

  it("an error in the clear call is reported with its window too", async () => {
    const fetchImpl = fakeFetch({ override: (name, i) => (name === CLEAR && i === 0 ? textResponse(502, "bad gateway") : null) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    expect(fetchImpl.mock.calls.length).toBe(2);
    expect(lines.join("\n")).toContain("rerun with --from 2026-04-01");
    expect(lines.join("\n")).toContain(CLEAR);
  });

  it("the rerun command keeps --to, --days and --apply", async () => {
    const fetchImpl = fakeFetch({ override: () => textResponse(500, "boom") });
    const { lines } = await run([...ARGV, "--days", "3", "--apply"], { fetchImpl });
    expect(lines.join("\n")).toContain("rerun with --from 2026-04-01 --to 2026-06-01 --days 3 --apply");
  });

  it("a statement timeout (57014) adds the --days 1 hint", async () => {
    const body = '{"code":"57014","message":"canceling statement due to statement timeout"}';
    const fetchImpl = fakeFetch({ override: (name, i) => (name === RECOMPUTE && i === 2 ? textResponse(500, body) : null) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("rerun with --from 2026-04-15");
    expect(text).toMatch(/--days 1/);
  });

  it("a lock timeout (55P03) says another run or a live write holds the rows, and to rerun", async () => {
    const body = '{"code":"55P03","message":"canceling statement due to lock timeout"}';
    const fetchImpl = fakeFetch({ override: (name, i) => (name === RECOMPUTE && i === 0 ? textResponse(409, body) : null) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("rerun with --from 2026-04-01");
    expect(lines.join("\n")).toMatch(/wait/i);
  });

  it("a network error stops the run with exit 1 and the same window report, no retry", async () => {
    const fetchImpl = fakeFetch({
      override: (name, i) => {
        if (name === RECOMPUTE && i === 1) throw new Error("fetch failed");
        return null;
      },
    });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    expect(fetchImpl.mock.calls.length).toBe(3);
    expect(lines.join("\n")).toContain("fetch failed");
    expect(lines.join("\n")).toContain("rerun with --from 2026-04-08");
  });

  it.each([
    ["not an array", { scanned: 1, would_change: 0, changed: 0 }],
    ["an empty array", []],
    ["two rows", [{ scanned: 1, would_change: 0, changed: 0 }, { scanned: 1, would_change: 0, changed: 0 }]],
    ["a null row", [null]],
    ["a missing counter", [{ scanned: 1, would_change: 0 }]],
    ["a string counter", [{ scanned: "1", would_change: 0, changed: 0 }]],
    ["a fractional counter", [{ scanned: 1.5, would_change: 0, changed: 0 }]],
    ["a negative counter", [{ scanned: 1, would_change: -1, changed: 0 }]],
    ["a null counter", [{ scanned: 1, would_change: null, changed: 0 }]],
  ])("a malformed recompute row (%s) stops the run with exit 1", async (_label, payload) => {
    const fetchImpl = fakeFetch({ override: (name, i) => (name === RECOMPUTE && i === 0 ? jsonResponse(200, payload) : null) });
    const { lines, code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    expect(fetchImpl.mock.calls.length).toBe(1);
    expect(lines.join("\n")).toMatch(/malformed|unexpected/i);
    expect(lines.join("\n")).toContain("rerun with --from 2026-04-01");
  });

  it("a malformed clear row stops the run with exit 1", async () => {
    const fetchImpl = fakeFetch({ override: (name, i) => (name === CLEAR && i === 0 ? jsonResponse(200, [{ would_clear: 1 }]) : null) });
    const { code } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  it("a body that is not JSON stops the run with exit 1", async () => {
    const fetchImpl = fakeFetch({ override: () => textResponse(200, "<html>nope</html>") });
    const { code, lines } = await run(ARGV, { fetchImpl });
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/malformed|JSON/i);
  });
});

describe("runLegacyBias: configuration errors exit 2 before any request", () => {
  const ARGV = ["--from", "2026-04-01", "--to", "2026-04-15"];

  it("missing SUPABASE_URL", async () => {
    const fetchImpl = fakeFetch();
    const { code, lines } = await run(ARGV, { env: { SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY }, fetchImpl });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("SUPABASE_URL");
  });

  it("missing SUPABASE_SERVICE_ROLE_KEY", async () => {
    const fetchImpl = fakeFetch();
    const { code, lines } = await run(ARGV, { env: { SUPABASE_URL: URL_OK }, fetchImpl });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toContain("SUPABASE_SERVICE_ROLE_KEY");
  });

  it("a non-https URL, with no key in the output", async () => {
    const fetchImpl = fakeFetch();
    const { code, lines } = await run(ARGV, { env: { SUPABASE_URL: "http://abcdefgh.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SECRET_KEY }, fetchImpl });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/https/);
    expect(lines.join("\n")).not.toContain(SECRET_KEY);
  });

  it("bad arguments (usage, no request, no key)", async () => {
    const fetchImpl = fakeFetch();
    const { code, lines } = await run(["--from", "2026-04-01"], { fetchImpl });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/--to/);
    expect(lines.join("\n")).toMatch(/usage/i);
  });

  it("too many windows", async () => {
    const fetchImpl = fakeFetch();
    const { code, lines } = await run(["--from", "2009-01-08", "--to", "2026-09-05"], { fetchImpl });
    expect(code).toBe(2);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/200/);
  });

  it("does not print the dry-run banner when the run cannot start", async () => {
    const { lines } = await run(ARGV, { env: {} });
    expect(lines).not.toContain(DRY_BANNER);
  });
});
