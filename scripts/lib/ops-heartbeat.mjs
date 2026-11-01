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
//
// Migration 131 adds two backstops, read after the report:
//   * ops_health_unnotified(): GitHub's '*/30' schedule really runs about
//     every 4 h, so pg_cron snapshots the non-pass rows every 10 minutes; any
//     unnotified FAIL snapshot is paged once ("kaçırılan: ...") and then
//     marked notified (ops_health_mark_notified), after the summary is written.
//   * ops_archive_gap_days(): the nightly archive export never retried, so a
//     missed night is counted here (warn 1..6 days, fail from 7 days or when
//     the oldest hole is too old for the nightly catch-up to close in time).
// A backstop that cannot be read (131 not applied, a 5xx, a network error)
// becomes a synthetic 'unknown' row: visible, but it never changes the exit
// code and never counts toward the half-unknown rule.

export const STATUSES = ["pass", "warn", "fail", "unknown", "skip"];

/** Missing archive days at which the archive row fails outright. */
export const ARCHIVE_GAP_FAIL_COUNT = 7;
/**
 * The catch-up window is 40 days (supabase/functions/_shared/archive-window.ts)
 * and closes one day per night, so a hole whose oldest day is more than
 * 40 - 7 = 33 days old can no longer be closed before it leaves the window:
 * that fails too. tests/migrations/131-*.test.ts pins 33 === 40 - 7.
 */
export const ARCHIVE_GAP_EDGE_DAYS = 33;

const ARCHIVE_ROW = "archive_gap_days";
const SNAPSHOT_ROW = "snapshot_backstop";
const MARK_IDS_MAX = 1000; // ops_health_mark_notified raises above this

const RETRYABLE_NO_RETRY_STATUSES = new Set([401, 403, 404]);
const REQUEST_TIMEOUT_MS = 20_000;
const RETRY_DELAY_MS = 10_000;
const BODY_LOG_LIMIT = 200;

/**
 * Builds the { url, init } PostgREST RPC request for `fn` (default
 * ops_health_report) with a JSON `body` (default {}).
 * Throws when baseUrl is not an https URL (a scheme mistake is a
 * configuration error, not a runtime condition to recover from) or when `fn`
 * is not a plain lower-case identifier (it is spliced into the URL path).
 */
export function buildRpcRequest(baseUrl, key, fn = "ops_health_report", body = {}) {
  if (typeof baseUrl !== "string" || !/^https:\/\//i.test(baseUrl)) {
    throw new Error("buildRpcRequest: SUPABASE_URL must be an https:// URL");
  }
  if (typeof fn !== "string" || !/^[a-z][a-z0-9_]*$/.test(fn)) {
    throw new Error("buildRpcRequest: the RPC name must be a plain identifier");
  }
  const base = baseUrl.replace(/\/+$/, "");
  return {
    url: `${base}/rest/v1/rpc/${fn}`,
    init: {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
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
 * Validates ops_health_unnotified()'s response: an array of snapshot rows,
 * each with a string check_name and an integer id (without an id a row could
 * never be marked notified and would page forever). Duplicate ids collapse.
 * Throws on anything else; the caller turns that into an 'unknown' row.
 */
export function normalizeMissed(json) {
  if (!Array.isArray(json)) {
    throw new Error("normalizeMissed: expected the RPC response to be an array of rows");
  }
  const seen = new Set();
  const out = [];
  json.forEach((row, i) => {
    if (
      row === null ||
      typeof row !== "object" ||
      typeof row.check_name !== "string" ||
      !Number.isSafeInteger(row.id)
    ) {
      throw new Error(`normalizeMissed: row ${i} needs an integer id and a string check_name`);
    }
    if (seen.has(row.id)) return;
    seen.add(row.id);
    out.push({ ...row });
  });
  return out;
}

const DAY_MS = 86_400_000;

function utcDay(date) {
  return date.toISOString().slice(0, 10);
}

/** The archive_gap_days row for an ops_archive_gap_days() result (see evaluate). */
function archiveGapRow(archive, nowValue) {
  const missing = archive?.missing_days;
  if (!Number.isInteger(missing) || missing < 0) {
    return {
      check_name: ARCHIVE_ROW,
      status: "unknown",
      observed: null,
      threshold: ARCHIVE_GAP_FAIL_COUNT,
      detail: "arşiv boşluğu okunamadı (beklenmeyen yanıt)",
      synthetic: true,
    };
  }
  const oldest =
    typeof archive.oldest_missing === "string" && /^\d{4}-\d{2}-\d{2}/.test(archive.oldest_missing)
      ? archive.oldest_missing.slice(0, 10)
      : null;

  const now = new Date(nowValue ?? Date.now());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const edge = utcDay(new Date(today - ARCHIVE_GAP_EDGE_DAYS * DAY_MS));

  let status = "pass";
  if (missing > 0) {
    status = missing >= ARCHIVE_GAP_FAIL_COUNT || (oldest !== null && oldest < edge) ? "fail" : "warn";
  }
  return {
    check_name: ARCHIVE_ROW,
    status,
    observed: missing,
    threshold: ARCHIVE_GAP_FAIL_COUNT,
    detail: missing === 0 ? "eksik gün yok" : oldest ? `en eski eksik gün: ${oldest}` : null,
    synthetic: true,
  };
}

/**
 * Decides the process exit code from normalized rows:
 *   - 1 if any row is 'fail'
 *   - 1 if any `missed` snapshot (an unnotified FAIL the schedule skipped over)
 *   - 1 if the archive gap row fails (see archiveGapRow)
 *   - 1 if the report is empty
 *   - 1 if at least half the rows are 'unknown' (a blind heartbeat pages —
 *     it can't tell you anything, which is itself an outage)
 *   - 0 otherwise
 *
 * `rows` may carry `synthetic: true` rows (a backstop that could not be read);
 * they are shown but never counted as real checks, so a missing migration 131
 * cannot tip the half-unknown rule. `archive` is one ops_archive_gap_days()
 * row ({ missing_days, oldest_missing }); `now` (Date or ms) fixes the UTC day.
 * Returns the synthetic archive row as `archiveRow` (null without `archive`).
 */
export function evaluate(rows, { missed = [], archive = null, now } = {}) {
  const real = rows.filter((r) => !r.synthetic);
  const archiveRow = archive ? archiveGapRow(archive, now) : null;

  const failing = [...rows.filter((r) => r.status === "fail")];
  const warnings = [...rows.filter((r) => r.status === "warn")];
  if (archiveRow?.status === "fail") failing.push(archiveRow);
  if (archiveRow?.status === "warn") warnings.push(archiveRow);
  const unknown = real.filter((r) => r.status === "unknown");

  let exitCode = 0;
  if (real.length === 0) {
    exitCode = 1;
  } else if (failing.length > 0 || missed.length > 0) {
    exitCode = 1;
  } else if (unknown.length * 2 >= real.length) {
    exitCode = 1;
  }

  return { exitCode, failing, warnings, unknown, missed, archiveRow };
}

function cell(value) {
  return value === null || value === undefined ? "-" : String(value);
}

/** `YYYY-MM-DD HH:MI UTC` for a snapshot timestamp; the raw text if unparseable. */
function fmtUtc(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const iso = d.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

/** One line per snapshot the schedule skipped over. */
function missedLine(m) {
  const detail = m.detail === null || m.detail === undefined ? "" : String(m.detail).replace(/\s+/g, " ").trim();
  return `kaçırılan: ${m.check_name} @ ${fmtUtc(m.taken_at)}${detail ? ` · ${detail}` : ""}`;
}

/**
 * Plain-text, aligned-column table. Status is upper-cased for scan-ability.
 * `missed` (unnotified FAIL snapshots) are listed below the table.
 */
export function formatTable(rows, missed = []) {
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
  const out = [line(headers), ...data.map(line)];
  if (missed.length > 0) out.push("", ...missed.map(missedLine));
  return out.join("\n");
}

/** Markdown for $GITHUB_STEP_SUMMARY: a verdict heading plus a table. */
export function formatMarkdown(rows, verdict, missed = []) {
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
  const base = `## Ops heartbeat: ${verdict}\n\n${header}\n${sep}\n${body}\n`;
  if (missed.length === 0) return base;
  return `${base}\n### Kaçırılan olaylar\n\n${missed.map((m) => `- ${md(missedLine(m))}`).join("\n")}\n`;
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
 *
 * After a readable report it also reads the two migration-131 backstops
 * (ops_health_unnotified, ops_archive_gap_days; one attempt each, no retry),
 * writes the table and the summary, and only THEN marks the paged snapshots
 * notified (ops_health_mark_notified, once, only when there were any): a crash
 * between the page and the mark re-pages, it never loses a page. `now` is a
 * clock function (default: the real clock) used for the archive row's UTC day.
 */
export async function runHeartbeat({ env, fetchImpl, sleep, log: rawLog, appendSummary, now }) {
  const url = env?.SUPABASE_URL;
  const key = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    rawLog("ops-heartbeat: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required");
    return 2;
  }

  // The key must not survive into a log line even if a server echoes it back.
  const redact = (text) => String(text).split(key).join("***");
  const log = (line) => rawLog(redact(line));

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

  // --- migration 131 backstops ------------------------------------------------

  /** One attempt at a secondary RPC; never throws, never retries. */
  const callRpc = async (fn, body) => {
    try {
      const req = buildRpcRequest(url, key, fn, body);
      const r = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!r) {
        log(`ops-heartbeat: ${fn} no response`);
        return { ok: false, why: "yanıt yok" };
      }
      if (!r.ok) {
        const text = redact(await safeText(r));
        log(`ops-heartbeat: ${fn} HTTP ${r.status}: ${text.slice(0, BODY_LOG_LIMIT)}`);
        const missing = r.status === 404 || text.includes("PGRST202");
        return { ok: false, missing, why: `HTTP ${r.status}` };
      }
      try {
        return { ok: true, json: await r.json() };
      } catch {
        log(`ops-heartbeat: ${fn} could not parse the response as JSON`);
        return { ok: false, why: "yanıt çözümlenemedi" };
      }
    } catch (e) {
      const message = redact(e?.message ?? "unknown error");
      log(`ops-heartbeat: ${fn} network error: ${message}`);
      return { ok: false, why: "ağ hatası" };
    }
  };

  /** A backstop that could not be read: shown as 'unknown', never decisive. */
  const unreadable = (check_name, what, outcome) => ({
    check_name,
    status: "unknown",
    observed: null,
    threshold: null,
    detail: `${what} okunamadı (${outcome.missing ? "131 uygulanmadı mı?" : outcome.why})`,
    synthetic: true,
  });

  const extra = [];

  let missed = [];
  const unnotified = await callRpc("ops_health_unnotified", {});
  if (unnotified.ok) {
    try {
      missed = normalizeMissed(unnotified.json);
    } catch (e) {
      log(`ops-heartbeat: ${e.message}`);
      extra.push(unreadable(SNAPSHOT_ROW, "kaçırılan olay kaydı", { why: "beklenmeyen yanıt" }));
    }
  } else {
    extra.push(unreadable(SNAPSHOT_ROW, "kaçırılan olay kaydı", unnotified));
  }

  let archive = null;
  const gap = await callRpc("ops_archive_gap_days", {});
  if (gap.ok) {
    // Always one row; anything else is handed on as {} so evaluate reports 'unknown'.
    archive = Array.isArray(gap.json) && gap.json[0] ? gap.json[0] : {};
  } else {
    extra.push(unreadable(ARCHIVE_ROW, "arşiv boşluğu", gap));
  }

  const clock = typeof now === "function" ? now : () => new Date();
  const { exitCode, archiveRow } = evaluate([...rows, ...extra], { missed, archive, now: clock() });
  const verdict = exitCode === 0 ? "OK" : "ALERT";
  const shown = archiveRow ? [...rows, ...extra, archiveRow] : [...rows, ...extra];
  log(formatTable(shown, missed));
  if (typeof appendSummary === "function") {
    appendSummary(formatMarkdown(shown, verdict, missed));
  }

  // Page first, mark second: a failed mark only means a repeat page next run.
  if (missed.length > 0) {
    const ids = [...new Set(missed.map((m) => m.id))].slice(0, MARK_IDS_MAX);
    await callRpc("ops_health_mark_notified", { p_ids: ids });
  }

  return exitCode;
}
