// scripts/lib/recompute-legacy-bias.mjs
//
// Pure ESM, Node built-ins only (plus ./ops-heartbeat.mjs for the PostgREST
// request builder). The operator tool of migration 132 (hunt 10, h10-data-1):
// it walks updated_at windows and, per window, calls the two service_role
// functions
//
//   recompute_bias_distribution_range(p_from, p_to, p_dry_run)  first
//   clear_false_blindspots_range(p_from, p_to, p_dry_run)       second
//
// A DRY RUN is the default: every request carries p_dry_run true and nothing is
// written. --apply sends p_dry_run false. The key (SUPABASE_SERVICE_ROLE_KEY) is
// only ever put into request headers; every log line has it replaced by ***,
// even when a server error body or a network error message echoes it. One
// attempt per call, no retries: a failure stops the run at the first window and
// prints the command that resumes it (every window is idempotent).
//
// Exit codes: 0 done, 1 a window failed (HTTP, network, malformed response),
// 2 the run could not start (bad arguments, missing env, non-https URL).

import { buildRpcRequest } from "./ops-heartbeat.mjs";

export const DEFAULT_DAYS = 7;
export const MIN_DAYS = 1;
export const MAX_DAYS = 31; // the SQL functions clamp a call to 31 days
export const MAX_WINDOWS = 200;

const REQUEST_TIMEOUT_MS = 30_000;
const BODY_LOG_LIMIT = 200;
const DAY_MS = 86_400_000;

const RECOMPUTE_FN = "recompute_bias_distribution_range";
const CLEAR_FN = "clear_false_blindspots_range";
const RECOMPUTE_FIELDS = ["scanned", "would_change", "changed"];
const CLEAR_FIELDS = ["would_clear", "would_newly_flag", "cleared"];

const DRY_RUN_BANNER = "DRY RUN: nothing is written. Re-run with --apply to write.";
const APPLY_BANNER = "APPLY: writing bias_distribution and clearing false flags.";
const USAGE =
  "usage: node scripts/recompute-legacy-bias.mjs --from YYYY-MM-DD --to YYYY-MM-DD [--days 1..31] [--apply]";

const FLAGS = new Set(["--from", "--to", "--days", "--apply"]);

/** UTC midnight (ms) of a real calendar day written YYYY-MM-DD; throws otherwise. */
function parseDay(value, flag) {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (m) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    const ms = Date.UTC(y, mo - 1, d);
    const back = new Date(ms);
    if (back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d) return ms;
  }
  throw new Error(`${flag} must be a real UTC day written YYYY-MM-DD, got ${JSON.stringify(value)}`);
}

function parseDays(value) {
  const n = typeof value === "number" ? value : /^\d{1,2}$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < MIN_DAYS || n > MAX_DAYS) {
    throw new Error(`--days must be an integer from ${MIN_DAYS} to ${MAX_DAYS}, got ${JSON.stringify(value)}`);
  }
  return n;
}

const formatDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Parses the command line: --from YYYY-MM-DD and --to YYYY-MM-DD (both required,
 * UTC days, --to after --from), --days 1..31 (default 7), --apply (a boolean
 * flag). `--flag=value` works too. Anything else, a repeated flag or a missing
 * value throws.
 */
export function parseArgs(argv) {
  const raw = { from: undefined, to: undefined, days: undefined };
  let apply = false;
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const arg = String(argv[i]);
    if (!arg.startsWith("--")) throw new Error(`unexpected argument ${JSON.stringify(arg)}`);
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? undefined : arg.slice(eq + 1);
    if (!FLAGS.has(flag)) throw new Error(`unknown flag ${flag}`);
    if (seen.has(flag)) throw new Error(`${flag} was given more than once`);
    seen.add(flag);
    if (flag === "--apply") {
      if (inline !== undefined) throw new Error("--apply takes no value");
      apply = true;
      continue;
    }
    let value = inline;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next === undefined || String(next).startsWith("--")) throw new Error(`${flag} needs a value`);
      value = String(next);
      i += 1;
    }
    raw[flag.slice(2)] = value;
  }
  if (raw.from === undefined) throw new Error("--from is required (YYYY-MM-DD)");
  if (raw.to === undefined) throw new Error("--to is required (YYYY-MM-DD)");
  const fromMs = parseDay(raw.from, "--from");
  const toMs = parseDay(raw.to, "--to");
  if (toMs <= fromMs) throw new Error(`--to (${raw.to}) must be after --from (${raw.from})`);
  const days = raw.days === undefined ? DEFAULT_DAYS : parseDays(raw.days);
  return { from: raw.from, to: raw.to, days, apply };
}

/**
 * The contiguous half-open windows [from, from + days), [from + days, ...) up to
 * `to`; the last one is the remainder. Returns [{ from, to }] as YYYY-MM-DD.
 * Throws for an empty range, a step outside 1..31 or more than 200 windows.
 */
export function buildWindows(from, to, days = DEFAULT_DAYS) {
  const step = parseDays(days);
  const fromMs = parseDay(from, "from");
  const toMs = parseDay(to, "to");
  if (toMs <= fromMs) throw new Error(`to (${to}) must be after from (${from})`);
  const count = Math.ceil((toMs - fromMs) / (step * DAY_MS));
  if (count > MAX_WINDOWS) {
    throw new Error(
      `${from}..${to} in steps of ${step} days is ${count} windows (at most ${MAX_WINDOWS}); use a shorter range or a larger --days`,
    );
  }
  const windows = [];
  for (let start = fromMs; start < toMs; start += step * DAY_MS) {
    windows.push({ from: formatDay(start), to: formatDay(Math.min(start + step * DAY_MS, toMs)) });
  }
  return windows;
}

/** A one-row array of non-negative integers, or an Error naming what is wrong. */
function validateRow(json, fields) {
  if (!Array.isArray(json) || json.length !== 1) throw new Error("expected an array with exactly one row");
  const row = json[0];
  if (row === null || typeof row !== "object") throw new Error("the row is not an object");
  const out = {};
  for (const field of fields) {
    const v = row[field];
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${field} is not a non-negative integer`);
    out[field] = v;
  }
  return out;
}

/**
 * Runs the walk and returns the process exit code. `argv` is process.argv minus
 * the first two entries, `env` the environment, `fetchImpl` a fetch, `log` a
 * line sink.
 */
export async function runLegacyBias({ argv, env, fetchImpl, log: rawLog }) {
  let opts;
  let windows;
  try {
    opts = parseArgs(argv ?? []);
    windows = buildWindows(opts.from, opts.to, opts.days);
  } catch (err) {
    rawLog(`recompute-legacy-bias: ${err.message}`);
    rawLog(USAGE);
    return 2;
  }

  const url = env?.SUPABASE_URL;
  const key = env?.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    rawLog("recompute-legacy-bias: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are both required");
    return 2;
  }

  // The key must not survive into a log line even if a server echoes it back.
  const redact = (text) => String(text).split(key).join("***");
  const log = (line) => rawLog(redact(line));

  try {
    buildRpcRequest(url, key, RECOMPUTE_FN, {});
  } catch (err) {
    log(`recompute-legacy-bias: ${err.message}`);
    return 2;
  }

  log(opts.apply ? APPLY_BANNER : DRY_RUN_BANNER);

  /** One attempt at one RPC; never throws. */
  const call = async (fn, body) => {
    try {
      const req = buildRpcRequest(url, key, fn, body);
      const res = await fetchImpl(req.url, { ...req.init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res) return { ok: false, detail: "no response", text: "" };
      if (!res.ok) {
        let text = "";
        try {
          text = redact(await res.text());
        } catch {
          // an unreadable body is reported as empty
        }
        return { ok: false, detail: `HTTP ${res.status}: ${text.slice(0, BODY_LOG_LIMIT)}`, text };
      }
      let json;
      try {
        json = await res.json();
      } catch {
        return { ok: false, detail: "malformed response (the body is not JSON)", text: "" };
      }
      return { ok: true, json };
    } catch (err) {
      const message = redact(err?.message ?? "unknown error");
      return { ok: false, detail: `network error: ${message}`, text: message };
    }
  };

  /** Reports the failed window and the command that resumes the run; returns exit code 1. */
  const stop = (w, fn, detail, text) => {
    const timedOut = /57014/.test(text);
    log(`${w.from}..${w.to}  ${fn}: ${detail}`);
    if (timedOut) {
      log("hint: 57014 is the statement timeout (PostgREST allows 8 s per call); rerun with --days 1");
    }
    if (/55P03/.test(text)) {
      log("hint: 55P03 means another 132 tool call or a live write holds the lock; wait a minute and rerun");
    }
    log(`rerun with --from ${w.from} --to ${opts.to} --days ${timedOut ? 1 : opts.days}${opts.apply ? " --apply" : ""}`);
    return 1;
  };

  const totals = { scanned: 0, would_change: 0, changed: 0, would_clear: 0, would_newly_flag: 0, cleared: 0 };

  for (const w of windows) {
    const body = { p_from: `${w.from}T00:00:00Z`, p_to: `${w.to}T00:00:00Z`, p_dry_run: !opts.apply };

    const recomputed = await call(RECOMPUTE_FN, body);
    if (!recomputed.ok) return stop(w, RECOMPUTE_FN, recomputed.detail, recomputed.text);
    let rec;
    try {
      rec = validateRow(recomputed.json, RECOMPUTE_FIELDS);
    } catch (err) {
      return stop(w, RECOMPUTE_FN, `malformed response (${err.message}): ${JSON.stringify(recomputed.json)?.slice(0, BODY_LOG_LIMIT)}`, "");
    }

    const cleared = await call(CLEAR_FN, body);
    if (!cleared.ok) return stop(w, CLEAR_FN, cleared.detail, cleared.text);
    let clr;
    try {
      clr = validateRow(cleared.json, CLEAR_FIELDS);
    } catch (err) {
      return stop(w, CLEAR_FN, `malformed response (${err.message}): ${JSON.stringify(cleared.json)?.slice(0, BODY_LOG_LIMIT)}`, "");
    }

    for (const field of RECOMPUTE_FIELDS) totals[field] += rec[field];
    for (const field of CLEAR_FIELDS) totals[field] += clr[field];
    log(`${w.from}..${w.to}  ${counters(rec, clr)}`);
  }

  log(`TOTAL  ${counters(totals, totals)}`);
  return 0;
}

function counters(rec, clr) {
  return (
    `scanned=${rec.scanned} would_change=${rec.would_change} changed=${rec.changed}` +
    ` | would_clear=${clr.would_clear} would_newly_flag=${clr.would_newly_flag} cleared=${clr.cleared}`
  );
}
