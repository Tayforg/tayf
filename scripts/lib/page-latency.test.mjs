import { describe, it, expect, vi } from "vitest";
import {
  ROUTES,
  PASS_MS,
  FAIL_MS,
  FETCH_TIMEOUT_MS,
  DEFAULT_SAMPLES,
  MAX_SAMPLES,
  parseBaseUrl,
  parseSamples,
  classifySample,
  median,
  summarizeRoute,
  evaluate,
  formatTable,
  formatMarkdown,
  runProbe,
} from "./page-latency.mjs";

const ORIGIN = "https://www.example.test";
const SENTINEL_HOST = "sentinel-host-q9";

function makeClock() {
  let t = 0;
  return {
    now: () => t,
    advance: (ms) => {
      t += ms;
    },
  };
}

/**
 * Fetch stub on a fake clock. `respond(url, index)` returns
 * `{ ms, status, cache, throw, response }`; the stub advances the clock by
 * `ms` (default 500) and then throws or resolves, like a real network call.
 */
function makeFetch(clock, respond = () => ({})) {
  const calls = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImpl = vi.fn(async (url, init) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const index = calls.length;
    calls.push({ url, init });
    try {
      await Promise.resolve();
      const r = respond(url, index) ?? {};
      clock.advance(r.ms ?? 500);
      if (r.throw) throw r.throw;
      if (r.response) return r.response;
      const headers = r.cache === null ? {} : { "x-vercel-cache": r.cache ?? "HIT" };
      return new Response("ok", { status: r.status ?? 200, headers });
    } finally {
      inFlight -= 1;
    }
  });
  return {
    fetchImpl,
    calls,
    maxInFlight: () => maxInFlight,
  };
}

async function probe({ env, respond } = {}) {
  const clock = makeClock();
  const f = makeFetch(clock, respond);
  const logs = [];
  const summaries = [];
  const code = await runProbe({
    env: env ?? { PROBE_BASE_URL: ORIGIN, PROBE_SAMPLES: "2" },
    fetchImpl: f.fetchImpl,
    now: clock.now,
    log: (line) => logs.push(line),
    appendSummary: (md) => summaries.push(md),
  });
  return { code, logs, summaries, ...f };
}

function tableOf(logs) {
  const table = logs.find((l) => l.startsWith("ROUTE"));
  expect(table).toBeDefined();
  return table;
}

function rowCells(logs, route) {
  const row = tableOf(logs)
    .split("\n")
    .find((l) => l.startsWith(`${route} `));
  expect(row).toBeDefined();
  return row.split(/ {2,}/);
}

describe("constants", () => {
  it("exposes the thresholds, the per-request timeout and the sample bounds", () => {
    expect(PASS_MS).toBe(4000);
    expect(FAIL_MS).toBe(8000);
    expect(FETCH_TIMEOUT_MS).toBe(25_000);
    expect(DEFAULT_SAMPLES).toBe(3);
    expect(MAX_SAMPLES).toBe(5);
  });
});

describe("ROUTES", () => {
  it("lists the nine public routes in order and is frozen", () => {
    expect(ROUTES).toEqual([
      "/",
      "/blindspots",
      "/sources",
      "/trends",
      "/ekonomi",
      "/hafta",
      "/kalite",
      "/rss.xml",
      "/sitemap.xml",
    ]);
    expect(Object.isFrozen(ROUTES)).toBe(true);
  });
});

describe("parseBaseUrl", () => {
  it("returns the origin only", () => {
    expect(parseBaseUrl("https://www.tayfhaber.com/")).toBe("https://www.tayfhaber.com");
    expect(parseBaseUrl("https://x.test/p?token=a")).toBe("https://x.test");
    expect(parseBaseUrl("https://x.test:8443/a#frag")).toBe("https://x.test:8443");
  });

  it("accepts http only for localhost, 127.0.0.1 and [::1]", () => {
    expect(parseBaseUrl("http://localhost:3000")).toBe("http://localhost:3000");
    expect(parseBaseUrl("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(parseBaseUrl("http://[::1]:3000")).toBe("http://[::1]:3000");
  });

  it.each([
    ["plain http on a public host", "http://www.tayfhaber.com"],
    ["another scheme", "ftp://x"],
    ["not a url", "not a url"],
    ["empty string", ""],
    ["embedded credentials", "https://u:p@x.test"],
    ["a localhost look-alike", "http://localhost.evil.test"],
    ["a loopback look-alike", "http://127.0.0.1.evil.test"],
  ])("throws on %s", (_label, input) => {
    expect(() => parseBaseUrl(input)).toThrow();
  });

  it("throws on non-string input", () => {
    expect(() => parseBaseUrl(undefined)).toThrow();
    expect(() => parseBaseUrl(null)).toThrow();
    expect(() => parseBaseUrl(42)).toThrow();
  });

  it("never puts the raw input in the thrown message", () => {
    const inputs = [
      `http://${SENTINEL_HOST}.example`,
      `ftp://${SENTINEL_HOST}`,
      `not a url ${SENTINEL_HOST}`,
      `https://u:p@${SENTINEL_HOST}.example`,
    ];
    for (const input of inputs) {
      let message = "";
      try {
        parseBaseUrl(input);
      } catch (err) {
        message = String(err.message);
      }
      expect(message).not.toBe("");
      expect(message).not.toContain(SENTINEL_HOST);
      expect(message).not.toContain("u:p");
    }
  });
});

describe("parseSamples", () => {
  it("defaults to 3 for undefined and the empty string", () => {
    expect(parseSamples(undefined)).toBe(3);
    expect(parseSamples("")).toBe(3);
  });

  it("parses an integer from 1 to 5", () => {
    expect(parseSamples("2")).toBe(2);
    expect(parseSamples("1")).toBe(1);
    expect(parseSamples("5")).toBe(5);
  });

  it.each(["0", "6", "2.5", "abc", "-1", "1e1"])("throws on %j", (input) => {
    expect(() => parseSamples(input)).toThrow();
  });
});

describe("classifySample", () => {
  it("passes a fast 200", () => {
    expect(classifySample({ status: 200, ms: 3999 })).toBe("pass");
  });

  it("warns from 4000 ms up to and including 8000 ms, fails above", () => {
    expect(classifySample({ status: 200, ms: 4000 })).toBe("warn");
    expect(classifySample({ status: 200, ms: 8000 })).toBe("warn");
    expect(classifySample({ status: 200, ms: 8001 })).toBe("fail");
  });

  it("fails on any 5xx, however fast", () => {
    expect(classifySample({ status: 500, ms: 10 })).toBe("fail");
    expect(classifySample({ status: 503, ms: 10 })).toBe("fail");
  });

  it("fails on a thrown error", () => {
    expect(classifySample({ error: "timeout", ms: 25000 })).toBe("fail");
    expect(classifySample({ error: "abort" })).toBe("fail");
    expect(classifySample({ error: "error", ms: 1 })).toBe("fail");
  });

  it("warns on a 4xx, even a fast one", () => {
    expect(classifySample({ status: 404, ms: 100 })).toBe("warn");
    expect(classifySample({ status: 429, ms: 100 })).toBe("warn");
  });

  it("fails a 4xx that is also slower than the fail limit", () => {
    expect(classifySample({ status: 404, ms: 9000 })).toBe("fail");
  });
});

describe("median", () => {
  it("returns the middle value of an odd count", () => {
    expect(median([1, 3, 2])).toBe(2);
  });

  it("averages the two middle values of an even count", () => {
    expect(median([100, 300])).toBe(200);
  });

  it("rounds the average", () => {
    expect(median([1, 2])).toBe(2);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("summarizeRoute", () => {
  it("takes the worst sample as the verdict and reports median and max", () => {
    const s = summarizeRoute("/x", [
      { status: 200, ms: 100, cache: "HIT" },
      { status: 200, ms: 5000, cache: "MISS" },
      { status: 200, ms: 300, cache: "HIT" },
    ]);
    expect(s.route).toBe("/x");
    expect(s.verdict).toBe("warn");
    expect(s.medianMs).toBe(300);
    expect(s.maxMs).toBe(5000);
  });

  it("lists one cache value per sample in order, with - for a missing header", () => {
    const s = summarizeRoute("/x", [
      { status: 200, ms: 100, cache: "MISS" },
      { status: 200, ms: 100, cache: "HIT" },
      { status: 200, ms: 100 },
    ]);
    expect(s.cache).toEqual(["MISS", "HIT", "-"]);
  });

  it("lists the status or error label per sample", () => {
    const s = summarizeRoute("/x", [
      { status: 200, ms: 100, cache: "HIT" },
      { error: "timeout", ms: 25000, cache: "-" },
    ]);
    expect(s.verdict).toBe("fail");
    expect(s.status).toEqual(["200", "timeout"]);
  });

  it("flags a route when any sample was redirected", () => {
    expect(summarizeRoute("/x", [{ status: 200, ms: 1, redirected: true }]).redirected).toBe(true);
    expect(summarizeRoute("/x", [{ status: 200, ms: 1 }]).redirected).toBe(false);
  });
});

describe("evaluate", () => {
  const route = (verdict) => ({ route: "/", verdict });

  it("exits 1 only on an overall fail", () => {
    expect(evaluate([route("pass"), route("fail"), route("warn")])).toMatchObject({
      exitCode: 1,
      verdict: "FAIL",
    });
  });

  it("reports a warning without a non-zero exit code", () => {
    expect(evaluate([route("pass"), route("warn")])).toMatchObject({
      exitCode: 0,
      verdict: "WARN",
    });
  });

  it("reports OK when every route passes", () => {
    expect(evaluate([route("pass"), route("pass")])).toMatchObject({
      exitCode: 0,
      verdict: "OK",
    });
  });
});

describe("formatTable", () => {
  it("renders aligned columns with joined per-sample cells", () => {
    const table = formatTable([
      summarizeRoute("/", [
        { status: 200, ms: 120, cache: "MISS" },
        { status: 200, ms: 80, cache: "HIT" },
      ]),
    ]);
    const [head, row] = table.split("\n");
    expect(head.split(/ {2,}/)).toEqual([
      "ROUTE",
      "VERDICT",
      "MEDIAN_MS",
      "MAX_MS",
      "STATUS",
      "CACHE",
    ]);
    expect(row.split(/ {2,}/)).toEqual(["/", "PASS", "100", "120", "200, 200", "MISS, HIT"]);
  });
});

describe("formatMarkdown", () => {
  const meta = { origin: ORIGIN, samples: 2 };

  it("starts with the verdict heading and the target line", () => {
    const md = formatMarkdown(
      [summarizeRoute("/", [{ status: 200, ms: 100, cache: "HIT" }])],
      "OK",
      meta,
    );
    const lines = md.split("\n");
    expect(lines[0]).toBe("## Page latency: OK");
    expect(md).toContain(
      `Target: ${ORIGIN} · 2 samples per route · pass < 4000 ms, warn 4000-8000 ms (or 4xx), fail > 8000 ms or 5xx/timeout`,
    );
    expect(md).toContain("| route | verdict | median ms | max ms | status | x-vercel-cache |");
    expect(md).toContain(
      "Measures what a visitor gets (CDN and data cache included). No cache-busting query string, so a HIT can hide a cold database.",
    );
  });

  it("escapes backslashes first, then pipes, in every cell", () => {
    const md = formatMarkdown(
      [summarizeRoute("/a|b\\c", [{ status: 200, ms: 1, cache: "x|y" }])],
      "OK",
      meta,
    );
    expect(md).toContain("/a\\|b\\\\c");
    expect(md).toContain("x\\|y");
  });

  it("names redirected routes in a note and omits the note otherwise", () => {
    const redirected = summarizeRoute("/hafta", [{ status: 200, ms: 1, redirected: true }]);
    const plain = summarizeRoute("/", [{ status: 200, ms: 1 }]);
    const withNote = formatMarkdown([plain, redirected], "OK", meta);
    const noteLine = withNote.split("\n").find((l) => /redirect/i.test(l));
    expect(noteLine).toBeDefined();
    expect(noteLine).toContain("`/hafta`");
    expect(noteLine).not.toContain("`/`");
    expect(formatMarkdown([plain], "OK", meta)).not.toMatch(/redirect/i);
  });
});

describe("runProbe: happy path", () => {
  it("returns 0 and fetches every route N times, strictly sequentially", async () => {
    const r = await probe({ respond: () => ({ status: 200, cache: "HIT", ms: 500 }) });
    expect(r.code).toBe(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(ROUTES.length * 2);
    expect(r.maxInFlight()).toBe(1);
    expect(r.calls.map((c) => c.url)).toEqual(ROUTES.flatMap((route) => [ORIGIN + route, ORIGIN + route]));
  });

  it("requests the exact origin + route with no query string", async () => {
    const r = await probe();
    for (const { url } of r.calls) {
      expect(url).not.toContain("?");
      expect(url.startsWith(ORIGIN)).toBe(true);
    }
  });

  it("uses GET with an AbortSignal and sends no credentials", async () => {
    const r = await probe();
    for (const { init } of r.calls) {
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("follow");
      expect(init.signal).toBeInstanceOf(AbortSignal);
      const keys = Object.keys(init.headers).map((k) => k.toLowerCase());
      expect(keys).not.toContain("authorization");
      expect(keys).not.toContain("cookie");
      expect(keys).not.toContain("apikey");
    }
  });

  it("logs one line per sample as <route> #<i> <status> <cache> <ms> ms", async () => {
    const r = await probe({
      respond: (url, i) => (i === 0 ? { status: 200, cache: "MISS", ms: 1234 } : { ms: 500 }),
    });
    expect(r.logs).toContain("/ #1 200 MISS 1234 ms");
    expect(r.logs).toContain("/ #2 200 HIT 500 ms");
    expect(r.logs.filter((l) => /^\/\S* #\d+ /.test(l))).toHaveLength(ROUTES.length * 2);
  });

  it("consumes the body so the time covers the full download", async () => {
    const clock = makeClock();
    let consumed = false;
    const response = {
      status: 200,
      redirected: false,
      headers: new Headers({ "x-vercel-cache": "HIT" }),
      arrayBuffer: async () => {
        consumed = true;
        clock.advance(700);
        return new ArrayBuffer(0);
      },
    };
    const logs = [];
    await runProbe({
      env: { PROBE_BASE_URL: ORIGIN, PROBE_SAMPLES: "1" },
      fetchImpl: async () => {
        clock.advance(100);
        return response;
      },
      now: clock.now,
      log: (l) => logs.push(l),
      appendSummary: () => {},
    });
    expect(consumed).toBe(true);
    expect(logs).toContain("/ #1 200 HIT 800 ms");
  });
});

describe("runProbe: grading", () => {
  it("returns 1 and a FAIL heading when one sample is above 8000 ms", async () => {
    const r = await probe({
      respond: (url, i) => (i === 3 ? { ms: 8001 } : { ms: 500 }),
    });
    expect(r.code).toBe(1);
    expect(r.summaries).toHaveLength(1);
    expect(r.summaries[0].split("\n")[0]).toContain("FAIL");
  });

  it("returns 0 and a WARN heading when the worst sample is exactly 4000 ms", async () => {
    const r = await probe({
      respond: (url, i) => (i === 5 ? { ms: 4000 } : { ms: 500 }),
    });
    expect(r.code).toBe(0);
    expect(r.summaries[0].split("\n")[0]).toContain("WARN");
  });

  it("returns 0 and an OK heading when every sample is fast", async () => {
    const r = await probe();
    expect(r.code).toBe(0);
    expect(r.summaries[0].split("\n")[0]).toContain("OK");
  });

  it("returns 1 on a 503 from /trends", async () => {
    const r = await probe({
      respond: (url) => (url.endsWith("/trends") ? { status: 503 } : {}),
    });
    expect(r.code).toBe(1);
    expect(rowCells(r.logs, "/trends")[1]).toBe("FAIL");
    expect(rowCells(r.logs, "/trends")[4]).toBe("503, 503");
  });

  it("returns 0 on a 404, reported as a warning", async () => {
    const r = await probe({
      respond: (url) => (url.endsWith("/kalite") ? { status: 404 } : {}),
    });
    expect(r.code).toBe(0);
    expect(rowCells(r.logs, "/kalite")[1]).toBe("WARN");
  });

  it.each([
    ["TimeoutError", new DOMException("t", "TimeoutError"), "timeout"],
    ["AbortError", new DOMException("t", "AbortError"), "abort"],
    ["any other error", new Error("boom"), "error"],
  ])("returns 1 and labels a %s as %s", async (_name, thrown, label) => {
    const r = await probe({
      respond: (url) => (url === `${ORIGIN}/` ? { throw: thrown, ms: 25000 } : {}),
    });
    expect(r.code).toBe(1);
    expect(r.logs).toContain(`/ #1 ${label} - 25000 ms`);
    const cells = rowCells(r.logs, "/");
    expect(cells[1]).toBe("FAIL");
    expect(cells[4]).toBe(`${label}, ${label}`);
    expect(cells[5]).toBe("-, -");
  });

  it("keeps probing the remaining routes after a failure", async () => {
    const r = await probe({
      respond: (url) => (url === `${ORIGIN}/` ? { throw: new Error("boom") } : {}),
    });
    expect(r.fetchImpl).toHaveBeenCalledTimes(ROUTES.length * 2);
  });

  it("notes a redirected route in the step summary", async () => {
    const clock = makeClock();
    const summaries = [];
    await runProbe({
      env: { PROBE_BASE_URL: ORIGIN, PROBE_SAMPLES: "1" },
      fetchImpl: async (url) => {
        clock.advance(100);
        return {
          status: 200,
          redirected: url.endsWith("/hafta"),
          headers: new Headers(),
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      },
      now: clock.now,
      log: () => {},
      appendSummary: (md) => summaries.push(md),
    });
    expect(summaries[0]).toMatch(/redirect[^\n]*\/hafta/i);
  });
});

describe("runProbe: report", () => {
  it("shows MISS, HIT in both the stdout table and the markdown row", async () => {
    const r = await probe({
      respond: (url, i) => (i === 0 ? { cache: "MISS" } : { cache: "HIT" }),
    });
    expect(rowCells(r.logs, "/")[5]).toBe("MISS, HIT");
    const mdRow = r.summaries[0].split("\n").find((l) => l.startsWith("| / |"));
    expect(mdRow).toBeDefined();
    expect(mdRow).toContain("MISS, HIT");
  });

  it("shows - for a response without an x-vercel-cache header", async () => {
    const r = await probe({ respond: () => ({ cache: null }) });
    expect(rowCells(r.logs, "/")[5]).toBe("-, -");
  });

  it("names the probed origin in the step summary", async () => {
    const r = await probe();
    expect(r.summaries[0]).toContain(`Target: ${ORIGIN} · 2 samples per route`);
  });
});

describe("runProbe: base URL and samples errors", () => {
  const BASE_URL_MESSAGE =
    "page-latency: set PROBE_BASE_URL (or NEXT_PUBLIC_SITE_URL) to an https:// origin or http://localhost";
  const SAMPLES_MESSAGE = "page-latency: PROBE_SAMPLES must be an integer from 1 to 5";

  it("returns 1 and never calls fetch when no base URL is set", async () => {
    const r = await probe({ env: {} });
    expect(r.code).toBe(1);
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(r.logs).toEqual([BASE_URL_MESSAGE]);
    expect(r.summaries).toEqual([]);
  });

  it("returns 1 without echoing a non-https public host", async () => {
    const r = await probe({ env: { PROBE_BASE_URL: `http://${SENTINEL_HOST}.example` } });
    expect(r.code).toBe(1);
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(r.logs).toEqual([BASE_URL_MESSAGE]);
    for (const line of r.logs) expect(line).not.toContain(SENTINEL_HOST);
  });

  it("lets PROBE_BASE_URL win over NEXT_PUBLIC_SITE_URL", async () => {
    const r = await probe({
      env: {
        PROBE_BASE_URL: "https://a.example",
        NEXT_PUBLIC_SITE_URL: "https://b.example",
        PROBE_SAMPLES: "1",
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls.every((c) => c.url.startsWith("https://a.example/"))).toBe(true);
  });

  it("falls back to NEXT_PUBLIC_SITE_URL when only that is set", async () => {
    const r = await probe({
      env: { NEXT_PUBLIC_SITE_URL: "https://b.example", PROBE_SAMPLES: "1" },
    });
    expect(r.calls.every((c) => c.url.startsWith("https://b.example/"))).toBe(true);
  });

  it("trims PROBE_BASE_URL and falls back when it is blank", async () => {
    const trimmed = await probe({
      env: { PROBE_BASE_URL: "  https://a.example  ", PROBE_SAMPLES: "1" },
    });
    expect(trimmed.calls[0].url).toBe("https://a.example/");
    const blank = await probe({
      env: { PROBE_BASE_URL: "   ", NEXT_PUBLIC_SITE_URL: "https://b.example", PROBE_SAMPLES: "1" },
    });
    expect(blank.calls[0].url).toBe("https://b.example/");
  });

  it("defaults to three samples per route", async () => {
    const r = await probe({ env: { PROBE_BASE_URL: ORIGIN } });
    expect(r.fetchImpl).toHaveBeenCalledTimes(ROUTES.length * DEFAULT_SAMPLES);
  });

  it("returns 1 and never calls fetch when PROBE_SAMPLES is out of range", async () => {
    const r = await probe({ env: { PROBE_BASE_URL: ORIGIN, PROBE_SAMPLES: "9" } });
    expect(r.code).toBe(1);
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(r.logs).toEqual([SAMPLES_MESSAGE]);
  });
});

describe("runProbe: no env value is printed", () => {
  it("never logs the query token or an unrelated secret", async () => {
    const r = await probe({
      env: {
        PROBE_BASE_URL: "https://www.example.test/p?token=tok_sentinel",
        PROBE_SAMPLES: "1",
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_sentinel",
      },
    });
    expect(r.code).toBe(0);
    expect(r.calls[0].url).toBe("https://www.example.test/");
    const everything = [...r.logs, ...r.summaries].join("\n");
    expect(everything).not.toContain("tok_sentinel");
    expect(everything).not.toContain("sb_secret_sentinel");
    expect(everything).toContain("https://www.example.test");
  });

  it("does not leak the base URL secrets in the error paths either", async () => {
    const r = await probe({
      env: {
        PROBE_BASE_URL: "http://www.example.test/p?token=tok_sentinel",
        SUPABASE_SERVICE_ROLE_KEY: "sb_secret_sentinel",
      },
    });
    expect(r.code).toBe(1);
    const everything = [...r.logs, ...r.summaries].join("\n");
    expect(everything).not.toContain("tok_sentinel");
    expect(everything).not.toContain("sb_secret_sentinel");
  });
});
