// scripts/lib/ops-heartbeat.mjs
//
// Pure ESM, Node built-ins only (no imports beyond them) — the
// ops-heartbeat.yml workflow skips `npm ci`, so this file (and everything it
// imports) must run under plain `node`, unmodified, straight from checkout.
//
// Wraps public.ops_health_report() (migration 077) over PostgREST: builds
// the RPC request, normalizes/validates the response rows, decides pass/fail
// for the process exit code, and formats the table + $GITHUB_STEP_SUMMARY
// markdown. runHeartbeat() does the actual fetch (with one retry) and is the
// only place that ever sees SUPABASE_SERVICE_ROLE_KEY — it is never logged,
// not even indirectly via a header dump or an error object serialized whole.

export const STATUSES = ["pass", "warn", "fail", "unknown", "skip"];

const RETRYABLE_NO_RETRY_STATUSES = new Set([401, 403, 404]);
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 10_000;
const BODY_LOG_LIMIT = 200;

/**
 * Builds the { url, init } PostgREST RPC request for ops_health_report().
 * Throws when baseUrl is not an https URL (a scheme mistake is a
 * configuration error, not a runtime condition to recover from).
 */
export function buildRpcRequest(baseUrl, key) {
  if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl)) {
    throw new Error("buildRpcRequest: SUPABASE_URL must be an https:// URL");
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/rest/v1/rpc/ops_health_report`,
    init: {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: "{}",
    },
  };
}

/**
 * Validates the RPC response shape: an array of rows each with a
 * check_name string. An unrecognized/missing status string becomes
 * 'unknown' rather than throwing — a report that can't be fully trusted
 * still reports, it just reports honestly.
 */
export function normalizeRows(json) {
  if (!Array.isArray(json)) {
    throw new Error("normalizeRows: expected the RPC response to be an array of rows");
  }
  return json.map((row, i) => {
    if (row === null || typeof row !== "object" || typeof row.check_name !== "string") {
      throw new Error(`normalizeRows: row ${i} is missing a string check_name`);
    }
    const status = STATUSES.includes(row.status) ? row.status : "unknown";
    return { ...row, status };
  });
}

/**
 * Decides the process exit code from normalized rows:
 *   - 1 if any row is 'fail'
 *   - 1 if the report is empty
 *   - 1 if at least half the rows are 'unknown' (a blind heartbeat pages —
 *     it can't tell you anything, which is itself an outage)
 *   - 0 otherwise
 */
export function evaluate(rows) {
  const failing = rows.filter((r) => r.status === "fail");
  const warnings = rows.filter((r) => r.status === "warn");
  const unknown = rows.filter((r) => r.status === "unknown");

  let exitCode = 0;
  if (rows.length === 0) {
    exitCode = 1;
  } else if (failing.length > 0) {
    exitCode = 1;
  } else if (unknown.length * 2 >= rows.length) {
    exitCode = 1;
  }

  return { exitCode, failing, warnings, unknown };
}

function cell(value) {
  return value === null || value === undefined ? "-" : String(value);
}

/** Plain-text, aligned-column table. Status is upper-cased for scan-ability. */
export function formatTable(rows) {
  const headers = ["CHECK", "STATUS", "OBSERVED", "THRESHOLD", "DETAIL"];
  const data = rows.map((r) => [
    cell(r.check_name),
    cell(r.status).toUpperCase(),
    cell(r.observed),
    cell(r.threshold),
    cell(r.detail),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((d) => d[i].length)));
  const line = (cols) => cols.map((c, i) => (c ?? "").padEnd(widths[i])).join("  ").trimEnd();
  return [line(headers), ...data.map(line)].join("\n");
}

/** Markdown for $GITHUB_STEP_SUMMARY: a verdict heading plus a table. */
export function formatMarkdown(rows, verdict) {
  const header = "| check | status | observed | threshold | detail |";
  const sep = "| --- | --- | --- | --- | --- |";
  // Escape backslashes first, then pipes, so a cell can neither break out of
  // its column nor smuggle an escape sequence into the table.
  const md = (v) => cell(v).replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
  const body = rows
    .map(
      (r) =>
        `| ${md(r.check_name)} | ${md(r.status)} | ${md(r.observed)} | ${md(r.threshold)} | ${md(r.detail)} |`,
    )
    .join("\n");
  return `## Ops heartbeat: ${verdict}\n\n${header}\n${sep}\n${body}\n`;
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function isNoRetryStatus(status) {
  return RETRYABLE_NO_RETRY_STATUSES.has(status);
}

function isRetryableFailure(res, err) {
  if (err) return true;
  if (res && res.status >= 500) return true;
  return false;
}

/**
 * Fetches ops_health_report() over PostgREST, retries once on a network
 * error or a 5xx (after a 10 s delay), and returns a process exit code.
 * Never logs the key, the request headers, or the env object — only a
 * status code and the first 200 characters of an error body.
 */
export async function runHeartbeat({ env, fetchImpl, sleep, log, appendSummary }) {
  const url = env?.SUPABASE_URL;
  const key = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    log("ops-heartbeat: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required");
    return 2;
  }

  let request;
  try {
    request = buildRpcRequest(url, key);
  } catch (err) {
    log(`ops-heartbeat: ${err.message}`);
    return 2;
  }

  const doFetch = () =>
    fetchImpl(request.url, { ...request.init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });

  const attempt = async () => {
    try {
      return { res: await doFetch(), err: null };
    } catch (err) {
      return { res: null, err };
    }
  };

  let { res, err } = await attempt();

  if (res && isNoRetryStatus(res.status)) {
    const body = await safeText(res);
    log(`ops-heartbeat: HTTP ${res.status}: ${body.slice(0, BODY_LOG_LIMIT)}`);
    return 2;
  }

  if (isRetryableFailure(res, err)) {
    if (typeof sleep === "function") {
      await sleep(RETRY_DELAY_MS);
    }
    ({ res, err } = await attempt());

    if (res && isNoRetryStatus(res.status)) {
      const body = await safeText(res);
      log(`ops-heartbeat: HTTP ${res.status}: ${body.slice(0, BODY_LOG_LIMIT)}`);
      return 2;
    }
    if (isRetryableFailure(res, err)) {
      if (res) {
        const body = await safeText(res);
        log(`ops-heartbeat: HTTP ${res.status}: ${body.slice(0, BODY_LOG_LIMIT)}`);
      } else {
        log(`ops-heartbeat: network error: ${err?.message ?? "unknown error"}`);
      }
      return 2;
    }
  }

  if (!res || !res.ok) {
    const status = res ? res.status : "no response";
    const body = res ? await safeText(res) : "";
    log(`ops-heartbeat: HTTP ${status}: ${body.slice(0, BODY_LOG_LIMIT)}`);
    return 2;
  }

  let json;
  try {
    json = await res.json();
  } catch {
    log("ops-heartbeat: could not parse the response as JSON");
    return 2;
  }

  let rows;
  try {
    rows = normalizeRows(json);
  } catch (err) {
    log(`ops-heartbeat: ${err.message}`);
    return 2;
  }

  const { exitCode } = evaluate(rows);
  const verdict = exitCode === 0 ? "OK" : "ALERT";
  log(formatTable(rows));
  if (typeof appendSummary === "function") {
    appendSummary(formatMarkdown(rows, verdict));
  }
  return exitCode;
}
