// scripts/lib/page-latency.mjs
//
// Pure ESM, Node built-ins only (no imports beyond them) — the
// page-latency.yml workflow skips `npm ci`, so this file must run under plain
// `node`, unmodified, straight from checkout.
//
// An on-demand probe of public page latency, measured the way a visitor sees
// it (CDN and Next data cache included). The ops heartbeat only watches the
// database, so the 2026-10-21 pattern (pages taking 8-22 s while every cron
// row was green, cold reads stuck at the statement timeout) was invisible.
// This sends a few sequential GETs per public route, grades the worst sample
// per route, and returns a process exit code: 1 only when the overall verdict
// is FAIL (a 5xx, a thrown error or timeout, or a sample above 8000 ms).
//
// It needs no secrets and sends no credentials. runProbe() never logs the env
// object, request headers or a raw env string: the only value from the
// environment that can reach the output is the parsed origin, so the operator
// can see which deployment was probed. Ops output stays in English like the
// heartbeat; there is no UI copy here.

export const ROUTES = Object.freeze([
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

/** A sample at or above this is slow enough to warn about. */
export const PASS_MS = 4000;
/** A sample above this fails. */
export const FAIL_MS = 8000;
/** Per-request abort. 5 samples x 9 routes x 25 s stays under the 20 min job cap. */
export const FETCH_TIMEOUT_MS = 25_000;
export const DEFAULT_SAMPLES = 3;
export const MAX_SAMPLES = 5;

const BASE_URL_ERROR =
  "page-latency: set PROBE_BASE_URL (or NEXT_PUBLIC_SITE_URL) to an https:// origin or http://localhost";
const SAMPLES_ERROR = "page-latency: PROBE_SAMPLES must be an integer from 1 to 5";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const SEVERITY = { pass: 0, warn: 1, fail: 2 };
const VERDICT_LABEL = { pass: "OK", warn: "WARN", fail: "FAIL" };

/**
 * Validates a base URL and returns its origin only (scheme, host, port): any
 * path, query, fragment is dropped, so a token pasted into the URL can never
 * be sent or printed. https is required except for localhost, 127.0.0.1 and
 * [::1]. URLs with embedded credentials are refused. The thrown message is
 * fixed text; it never contains the input.
 */
export function parseBaseUrl(raw) {
  if (typeof raw !== "string") throw new Error(BASE_URL_ERROR);
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(BASE_URL_ERROR);
  }
  if (url.username !== "" || url.password !== "") throw new Error(BASE_URL_ERROR);
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && LOCAL_HOSTNAMES.has(url.hostname);
  if (!secure && !local) throw new Error(BASE_URL_ERROR);
  return url.origin;
}

/** Parses PROBE_SAMPLES: unset or blank gives the default, otherwise an integer 1..MAX_SAMPLES. */
export function parseSamples(raw) {
  const text = raw === undefined || raw === null ? "" : String(raw).trim();
  if (text === "") return DEFAULT_SAMPLES;
  if (!/^\d+$/.test(text)) throw new Error(SAMPLES_ERROR);
  const n = Number(text);
  if (n < 1 || n > MAX_SAMPLES) throw new Error(SAMPLES_ERROR);
  return n;
}

/**
 * Grades one sample as 'pass' | 'warn' | 'fail', in this order:
 *   1. a thrown error fails
 *   2. status 500 or above fails
 *   3. ms above FAIL_MS fails
 *   4. status 400-499 warns (reported, but does not page)
 *   5. ms at or above PASS_MS warns
 *   6. anything else passes
 */
export function classifySample(sample) {
  if (sample.error) return "fail";
  const status = typeof sample.status === "number" ? sample.status : 0;
  const ms = typeof sample.ms === "number" ? sample.ms : 0;
  if (status >= 500) return "fail";
  if (ms > FAIL_MS) return "fail";
  if (status >= 400) return "warn";
  if (ms >= PASS_MS) return "warn";
  return "pass";
}

/** Median of a list of numbers; the two middle values are averaged and rounded. Null when empty. */
export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Collapses a route's samples into one row: the verdict is the worst sample,
 * `status` and `cache` hold one value per sample in order (an error label for
 * a thrown sample, '-' for a missing x-vercel-cache header).
 */
export function summarizeRoute(route, samples) {
  let worst = "pass";
  for (const sample of samples) {
    const verdict = classifySample(sample);
    if (SEVERITY[verdict] > SEVERITY[worst]) worst = verdict;
  }
  const times = samples.map((s) => s.ms).filter((ms) => Number.isFinite(ms));
  return {
    route,
    verdict: worst,
    medianMs: median(times),
    maxMs: times.length > 0 ? Math.max(...times) : null,
    status: samples.map((s) => (s.error ? String(s.error) : String(s.status))),
    cache: samples.map((s) => s.cache ?? "-"),
    redirected: samples.some((s) => s.redirected === true),
  };
}

/**
 * The overall verdict is the worst route. exitCode is 1 only on a fail; a
 * warning shows in the report but does not page.
 */
export function evaluate(summaries) {
  let worst = "pass";
  for (const s of summaries) {
    if (SEVERITY[s.verdict] > SEVERITY[worst]) worst = s.verdict;
  }
  return {
    exitCode: worst === "fail" ? 1 : 0,
    verdict: VERDICT_LABEL[worst],
    failing: summaries.filter((s) => s.verdict === "fail"),
    warnings: summaries.filter((s) => s.verdict === "warn"),
  };
}

function cell(value) {
  return value === null || value === undefined ? "-" : String(value);
}

/** Plain-text, aligned-column table. STATUS and CACHE join the per-sample values with ', '. */
export function formatTable(summaries) {
  const headers = ["ROUTE", "VERDICT", "MEDIAN_MS", "MAX_MS", "STATUS", "CACHE"];
  const data = summaries.map((s) => [
    cell(s.route),
    cell(s.verdict).toUpperCase(),
    cell(s.medianMs),
    cell(s.maxMs),
    s.status.join(", "),
    s.cache.join(", "),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...data.map(line)].join("\n");
}

/** Markdown for $GITHUB_STEP_SUMMARY: a verdict heading, the target, a table and a caveat. */
export function formatMarkdown(summaries, verdict, { origin, samples }) {
  const header = "| route | verdict | median ms | max ms | status | x-vercel-cache |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  // Escape backslashes first, then pipes, so a cell can neither break out of
  // its column nor smuggle an escape sequence into the table.
  const md = (v) => cell(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const body = summaries
    .map(
      (s) =>
        `| ${md(s.route)} | ${md(s.verdict)} | ${md(s.medianMs)} | ${md(s.maxMs)} | ${md(s.status.join(", "))} | ${md(s.cache.join(", "))} |`,
    )
    .join("\n");
  const target = `Target: ${origin} · ${samples} samples per route · pass < ${PASS_MS} ms, warn ${PASS_MS}-${FAIL_MS} ms (or 4xx), fail > ${FAIL_MS} ms or 5xx/timeout`;
  const footer =
    "Measures what a visitor gets (CDN and data cache included). No cache-busting query string, so a HIT can hide a cold database.";
  const redirected = summaries.filter((s) => s.redirected).map((s) => `\`${s.route}\``);
  const note =
    redirected.length > 0
      ? `\n\nRedirects were followed on ${redirected.join(", ")}; those timings include the redirect.`
      : "";
  return `## Page latency: ${verdict}\n\n${target}\n\n${header}\n${sep}\n${body}\n\n${footer}${note}\n`;
}

function errorLabel(err) {
  const name = err?.name;
  if (name === "TimeoutError") return "timeout";
  if (name === "AbortError") return "abort";
  return "error";
}

/** One timed GET. Reads the whole body so ms is the total time, never throws. */
async function takeSample(url, fetchImpl, now, timeoutMs) {
  const t0 = now();
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      redirect: "follow",
      headers: { "User-Agent": "tayf-page-latency-probe/1", Accept: "*/*" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.arrayBuffer();
    return {
      status: res.status,
      cache: res.headers.get("x-vercel-cache") ?? "-",
      redirected: res.redirected === true,
      ms: Math.round(now() - t0),
    };
  } catch (err) {
    return { error: errorLabel(err), cache: "-", redirected: false, ms: Math.round(now() - t0) };
  }
}

/**
 * Probes every route in ROUTES, N sequential samples each, and returns a
 * process exit code (0 for OK or WARN, 1 for FAIL or a configuration error).
 * Reads PROBE_BASE_URL (falling back to NEXT_PUBLIC_SITE_URL) and
 * PROBE_SAMPLES. Never logs the env object, headers or a raw env string.
 */
export async function runProbe({
  env,
  fetchImpl,
  now = () => performance.now(),
  log,
  appendSummary,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  const rawBase = [env?.PROBE_BASE_URL, env?.NEXT_PUBLIC_SITE_URL]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .find((v) => v !== "");

  let origin;
  try {
    origin = parseBaseUrl(rawBase);
  } catch (err) {
    log(err.message);
    return 1;
  }

  let samples;
  try {
    samples = parseSamples(env?.PROBE_SAMPLES);
  } catch (err) {
    log(err.message);
    return 1;
  }

  const summaries = [];
  for (const route of ROUTES) {
    const taken = [];
    for (let i = 1; i <= samples; i += 1) {
      const sample = await takeSample(origin + route, fetchImpl, now, timeoutMs);
      taken.push(sample);
      log(`${route} #${i} ${sample.error ?? sample.status} ${sample.cache} ${sample.ms} ms`);
    }
    summaries.push(summarizeRoute(route, taken));
  }

  const { exitCode, verdict } = evaluate(summaries);
  log(formatTable(summaries));
  if (typeof appendSummary === "function") {
    appendSummary(formatMarkdown(summaries, verdict, { origin, samples }));
  }
  return exitCode;
}
