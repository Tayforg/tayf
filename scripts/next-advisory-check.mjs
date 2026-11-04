#!/usr/bin/env node
// scripts/next-advisory-check.mjs
//
// Fails when a published Next.js security advisory covers the Next.js version
// that package-lock.json installs (h31-deps-1). Run by the `next-advisories`
// job of .github/workflows/dep-audit.yml (weekly, and on every change to the
// dependency manifests), and by hand: `node scripts/next-advisory-check.mjs`.
//
// Why it exists: `npm audit` reads GitHub's GLOBAL advisory database, and the
// Next.js 16.4.5 security release (7 advisories, 2026-11-03) was not in it.
// GHSA-mfr8-8qww-v76h is published on vercel/next.js with
// vulnerable_version_range '>= 16.3.0' and an EMPTY patched_versions, while
// GET /advisories/GHSA-mfr8-8qww-v76h is a 404, so dep-audit.yml stayed green on
// 16.4.3 while 16.4.5 was out. This script reads the repository advisories of
// vercel/next.js directly:
//   GET https://api.github.com/repos/vercel/next.js/security-advisories
//       ?state=published&per_page=100
// (public data; GITHUB_TOKEN is sent when set, only for the rate limit).
//
// Rules (see evaluate()):
//   * only state 'published' advisories without withdrawn_at, and only
//     vulnerabilities whose package is ecosystem 'npm', name 'next';
//   * installed version outside vulnerable_version_range: fine;
//   * inside the range with patched_versions: the floor is the lowest patched
//     version on the installed major.minor, else on the installed major, else
//     the lowest overall; installed below it FAILS, otherwise the range was
//     over-broad and the line is only a note;
//   * inside the range with an EMPTY patched_versions (the 16.4.5 shape): FAILS
//     unless the GHSA is in ACKNOWLEDGED below with the version that fixes it
//     (fixedIn) and a reason citing the release note or PR, and the installed
//     version is at or above fixedIn.
//
// FAIL CLOSED: a network error, a non-2xx answer (rate limit 403 included), a
// body that is not a JSON array, an unreadable lockfile, more than 10 pages, or
// a Link header that leaves api.github.com all exit 1. A range text this file
// cannot parse is treated as covering every version. A check that cannot read
// the advisories must not report green.
//
// The vulnerable_version_range text is hand-written by advisory authors and is
// NOT the tidy "a, b" GitHub documents: the live feed has '>= 10.0.0  <= 15.5.27'
// (whitespace AND), '=> 11.1.4 < 12.3.5', '10.0.0 <= 12.0.10', '15.0.0 - 15.4.4',
// '>15.0.4 and <15.2.0', '10.x', '16.3.?', and commas that mean OR
// ('>=13.0.0 <15.5.15, >= 16.0 < 16.2.3'). parseRange() reads all of those:
// a comma list whose pieces each hold ONE comparator is AND (GitHub's own
// format, '>= 16.0.0, < 16.4.5'); a comma list with a multi-comparator piece is
// OR. tests/guards cover the shapes seen on 2026-11-04.
//
// WHEN THIS GOES RED after a Next.js security release:
//   1. read the release notes of the version you are moving to
//      (https://github.com/vercel/next.js/releases) and bump Next.js, together
//      with NEXT_SECURITY_FLOOR in tests/guards/next-security-floor.test.ts;
//   2. for every advisory still listed with an empty patched_versions, add an
//      ACKNOWLEDGED entry: fixedIn = the version whose release notes list it,
//      reason = the release note / PR. Never acknowledge what the notes do not
//      list.
//
// Pure Node built-ins only (the workflow runs no `npm ci`). Node >= 18 (global
// fetch, AbortSignal.timeout).

import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ADVISORIES_URL =
  "https://api.github.com/repos/vercel/next.js/security-advisories?state=published&per_page=100";
const API_ORIGIN = "https://api.github.com";
export const MAX_PAGES = 10;
export const REQUEST_TIMEOUT_MS = 20000;
const RETRY_DELAY_MS = 2000;

/**
 * Advisories whose repository record has an empty patched_versions but which a
 * release is known to fix. Keyed by GHSA id. `fixedIn` is the first version
 * that fixes it; `reason` must cite the release note or PR that says so.
 */
export const ACKNOWLEDGED = {
  // The seven advisories of the Next.js v16.4.5 release (published 2026-11-03T18:38:39Z). Its release
  // notes ("This release contains security fixes for the following advisories") list all seven; three
  // of them carry a range that still covers 16.4.5 and an empty patched_versions on GitHub.
  "GHSA-mfr8-8qww-v76h": {
    fixedIn: "16.4.5",
    reason:
      "listed in the Next.js v16.4.5 release notes (2026-11-03); applied by PR #184 (next 16.4.3 -> 16.4.5); GitHub records no patched_versions",
  },
  "GHSA-pc58-hwjq-p385": {
    fixedIn: "16.4.5",
    reason:
      "listed in the Next.js v16.4.5 release notes (2026-11-03); applied by PR #184 (next 16.4.3 -> 16.4.5); GitHub records no patched_versions",
  },
  "GHSA-vvgp-ww4w-46vf": {
    fixedIn: "16.4.5",
    reason:
      "listed in the Next.js v16.4.5 release notes (2026-11-03); applied by PR #184 (next 16.4.3 -> 16.4.5); GitHub records no patched_versions",
  },
};

// --- versions ----------------------------------------------------------------

const OP_CHARS = "<>=";
const OPS = new Set(["<", "<=", ">", ">=", "="]);
const WILDCARDS = new Set(["x", "X", "*", "?"]);

function isDigits(s) {
  if (s === "") return false;
  for (const ch of s) if (ch < "0" || ch > "9") return false;
  return true;
}

function isPreIdentifier(s) {
  if (s === "") return false;
  for (const ch of s) {
    const ok = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || ch === "-";
    if (!ok) return false;
  }
  return true;
}

/**
 * Parses a version or (allowWildcard) a version pattern.
 * Returns { nums, wild, partial, pre }: nums are the numeric components that
 * were written (1 to 3), wild marks an x / * / ? component, partial marks a
 * version with fewer than three components and no wildcard ('16', '16.4').
 */
function parseVersionText(input, allowWildcard) {
  if (typeof input !== "string") throw new Error(`not a version: ${String(input)}`);
  let s = input.trim();
  if (s.startsWith("v") || s.startsWith("V")) s = s.slice(1);
  const plus = s.indexOf("+");
  if (plus !== -1) s = s.slice(0, plus);
  const dash = s.indexOf("-");
  const core = dash === -1 ? s : s.slice(0, dash);
  const pre = dash === -1 ? [] : s.slice(dash + 1).split(".");
  if (!pre.every(isPreIdentifier) && pre.length > 0) throw new Error(`not a version: "${input}"`);
  const comps = core.split(".");
  if (comps.length > 3) throw new Error(`not a version: "${input}"`);
  const nums = [];
  let wild = false;
  for (const c of comps) {
    if (isDigits(c) && !wild) nums.push(Number(c));
    else if (allowWildcard && WILDCARDS.has(c)) wild = true;
    else throw new Error(`not a version: "${input}"`);
  }
  return { nums, wild, partial: !wild && nums.length < 3, pre };
}

/** nums padded with zeros to three components. */
function filled(parsed) {
  const nums = parsed.nums.slice();
  while (nums.length < 3) nums.push(0);
  return { nums, pre: parsed.pre };
}

function comparePre(a, b) {
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1; // a release sorts after its prereleases
  if (b.length === 0) return -1;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i >= a.length) return -1;
    if (i >= b.length) return 1;
    const x = a[i];
    const y = b[i];
    const xNum = isDigits(x);
    const yNum = isDigits(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return d < 0 ? -1 : 1;
    } else if (xNum) {
      return -1; // numeric identifiers sort before alphanumeric ones
    } else if (yNum) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

function compareParsed(a, b) {
  for (let i = 0; i < 3; i++) {
    const d = (a.nums[i] ?? 0) - (b.nums[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return comparePre(a.pre, b.pre);
}

/** -1, 0 or 1; a prerelease sorts before its release. Throws on a non-version. */
export function compareVersions(a, b) {
  return compareParsed(filled(parseVersionText(a, false)), filled(parseVersionText(b, false)));
}

function formatVersion(parsed) {
  const f = filled(parsed);
  return `${f.nums.join(".")}${f.pre.length > 0 ? `-${f.pre.join(".")}` : ""}`;
}

// --- ranges ------------------------------------------------------------------

function words(text) {
  const out = [];
  let cur = "";
  for (const ch of text) {
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      if (cur !== "") out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/** Unicode and swapped operators the advisory authors typed. */
function normaliseRangeText(text) {
  return String(text).replaceAll("≥", ">=").replaceAll("≤", "<=").replaceAll("=>", ">=").replaceAll("=<", "<=");
}

function splitOperator(token) {
  let i = 0;
  while (i < token.length && OP_CHARS.includes(token[i])) i++;
  return [token.slice(0, i), token.slice(i)];
}

/** The comparators ANDed inside one comma piece: [{ op, nums, wild, partial, pre }]. */
function comparatorsOfPiece(piece) {
  const fail = () => new Error(`cannot read the version range "${piece.trim()}"`);
  const raw = [];
  let pending = null;
  let hyphen = false;
  for (const token of words(piece)) {
    if (token.toLowerCase() === "and") continue;
    if (token === "-") {
      if (pending !== null || raw.length === 0 || raw[raw.length - 1].op !== "") throw fail();
      hyphen = true;
      continue;
    }
    const [op, rest] = splitOperator(token);
    if (op !== "" && !OPS.has(op)) throw fail();
    if (rest === "") {
      if (op === "" || pending !== null) throw fail();
      pending = op;
      continue;
    }
    if (pending !== null) {
      if (op !== "") throw fail();
      raw.push({ op: pending, text: rest });
      pending = null;
    } else if (hyphen) {
      if (op !== "") throw fail();
      raw[raw.length - 1].op = ">=";
      raw.push({ op: "<=", text: rest });
      hyphen = false;
    } else {
      raw.push({ op, text: rest });
    }
  }
  if (pending !== null || hyphen) throw fail();
  const bounded = raw.some((c) => c.op === "<" || c.op === "<=");
  return raw.map((c) => ({
    op: c.op !== "" ? c.op : raw.length > 1 && bounded ? ">=" : "=",
    ...parseVersionText(c.text, true),
  }));
}

/** [[comparator, ...], ...]: alternatives (OR) of comparators (AND). */
function parseRange(range) {
  const alternatives = [];
  for (const group of normaliseRangeText(range).split("||")) {
    const pieces = group
      .split(",")
      .map((p) => comparatorsOfPiece(p))
      .filter((c) => c.length > 0);
    if (pieces.length === 0) throw new Error(`empty alternative in the version range "${String(range).trim()}"`);
    if (pieces.every((c) => c.length === 1)) alternatives.push(pieces.flat());
    else for (const c of pieces) alternatives.push(c);
  }
  return alternatives;
}

function comparePrefix(nums, prefix) {
  for (let i = 0; i < prefix.length; i++) {
    const d = (nums[i] ?? 0) - prefix[i];
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function matchesComparator(installed, c) {
  // A wildcard ('16.3.?', '10.x') compares only the components that were written, and an equal
  // prefix counts as a match for < <= > >= (conservative: we cannot know which patch it means).
  const usePrefix = c.wild || (c.partial && (c.op === "=" || c.op === "<=" || c.op === ">"));
  if (usePrefix) {
    const cmp = comparePrefix(installed.nums, c.nums);
    if (c.op === "=") return cmp === 0;
    if (c.op === "<" || c.op === "<=") return cmp <= 0;
    return cmp >= 0;
  }
  const cmp = compareParsed(installed, filled(c));
  if (c.op === "=") return cmp === 0;
  if (c.op === "<") return cmp < 0;
  if (c.op === "<=") return cmp <= 0;
  if (c.op === ">") return cmp > 0;
  return cmp >= 0;
}

/**
 * True when `version` is inside a GitHub vulnerable_version_range. An empty or
 * missing range means 'every version'. Throws on text it cannot read.
 */
export function satisfiesRange(version, range) {
  const installed = filled(parseVersionText(version, false));
  if (range === null || range === undefined || String(range).trim() === "") return true;
  return parseRange(range).some((alt) => alt.every((c) => matchesComparator(installed, c)));
}

/**
 * The fixed versions a patched_versions text names, as 'x.y.z[-pre]' strings.
 * Only lower bounds count ('16.4.5', '>= 15.2.2', 'v16.0.7'); '<= 15.0.4' is the
 * vulnerable side. A placeholder patch ('16.3.?') stands for its lowest version.
 */
export function parsePatchedVersions(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const out = [];
  for (const piece of normaliseRangeText(text).split(",")) {
    for (const c of comparatorsOfPiece(piece)) {
      if (c.op === "=" || c.op === ">=" || c.op === ">") out.push(formatVersion(c));
    }
  }
  return out;
}

// --- the verdict -------------------------------------------------------------

function lowest(versions) {
  return versions.reduce((a, b) => (compareVersions(b, a) < 0 ? b : a));
}

/** Lowest patched version on the installed major.minor, else major, else overall. */
function floorOf(patched, installed) {
  const [major, minor] = filled(parseVersionText(installed, false)).nums;
  const key = (v) => v.split("-")[0].split(".").map(Number);
  const sameMinor = patched.filter((v) => key(v)[0] === major && key(v)[1] === minor);
  if (sameMinor.length > 0) return lowest(sameMinor);
  const sameMajor = patched.filter((v) => key(v)[0] === major);
  if (sameMajor.length > 0) return lowest(sameMajor);
  return lowest(patched);
}

/**
 * Judges every published npm 'next' vulnerability against the installed version.
 * Returns { failures, notes }: a failure makes the check exit 1; a note is an
 * in-range advisory that is fixed, acknowledged or over-broad.
 */
export function evaluate(advisories, installed, acknowledged = ACKNOWLEDGED) {
  const failures = [];
  const notes = [];
  compareVersions(installed, "0.0.0"); // throws when the installed version is not a version
  for (const adv of Array.isArray(advisories) ? advisories : []) {
    if (adv === null || typeof adv !== "object") continue;
    if (adv.state !== "published" || adv.withdrawn_at) continue;
    const vulnerabilities = Array.isArray(adv.vulnerabilities) ? adv.vulnerabilities : [];
    for (const vuln of vulnerabilities) {
      if (vuln?.package?.ecosystem !== "npm" || vuln?.package?.name !== "next") continue;

      const id = adv.ghsa_id ?? "(advisory without id)";
      const rangeText = vuln.vulnerable_version_range ?? "";
      const patchedText = typeof vuln.patched_versions === "string" ? vuln.patched_versions.trim() : "";

      let inRange = true;
      let rangeNote = "";
      try {
        inRange = satisfiesRange(installed, rangeText);
      } catch {
        rangeNote = " [range not understood, assumed to cover every version]";
      }
      if (!inRange) continue;

      const label =
        `${id} (${adv.severity ?? "severity unknown"}) range "${String(rangeText).trim()}" ` +
        `patched "${patchedText === "" ? "none recorded" : patchedText}"${rangeNote}`;

      let patched = [];
      let patchedProblem = "";
      try {
        patched = parsePatchedVersions(patchedText);
        if (patchedText !== "" && patched.length === 0) patchedProblem = "patched_versions names no fixed version";
      } catch {
        patchedProblem = "patched_versions not understood";
      }

      if (patchedText !== "" && patchedProblem === "") {
        const floor = floorOf(patched, installed);
        if (compareVersions(installed, floor) < 0) {
          failures.push(`${label}: installed next ${installed} is below the fixed version ${floor}`);
        } else {
          notes.push(`${label}: installed next ${installed} >= ${floor} (range over-broad)`);
        }
        continue;
      }

      // No usable fixed version on record: only an acknowledged advisory passes.
      const ack = acknowledged?.[id];
      const reason = typeof ack?.reason === "string" ? ack.reason.trim() : "";
      const fixedIn = typeof ack?.fixedIn === "string" ? ack.fixedIn.trim() : "";
      if (reason === "" || fixedIn === "") {
        failures.push(
          `${label}: ${patchedProblem === "" ? "no fixed version recorded" : patchedProblem} and not in ACKNOWLEDGED ` +
            `(read the release notes, bump Next.js, then acknowledge with the release note or PR as the reason)`,
        );
      } else if (compareVersions(installed, fixedIn) < 0) {
        failures.push(`${label}: acknowledged as fixed in ${fixedIn}, but next ${installed} is installed (${reason})`);
      } else {
        notes.push(`${label}: acknowledged, fixed in ${fixedIn} (${reason})`);
      }
    }
  }
  return { failures, notes };
}

// --- reading the advisories ----------------------------------------------------

/** The URL of a `rel="next"` entry of a Link header, or null. */
function nextLinkOf(header) {
  if (typeof header !== "string") return null;
  let from = 0;
  while (from < header.length) {
    const open = header.indexOf("<", from);
    if (open === -1) return null;
    const close = header.indexOf(">", open + 1);
    if (close === -1) return null;
    const following = header.indexOf("<", close + 1);
    const params = header.slice(close + 1, following === -1 ? header.length : following);
    for (const param of params.split(";")) {
      const [name, ...value] = param.trim().split("=");
      if (name.trim() !== "rel") continue;
      const rels = value.join("=").replaceAll('"', " ").replaceAll("'", " ").replaceAll(",", " ");
      if (words(rels).includes("next")) return header.slice(open + 1, close);
    }
    from = close + 1;
  }
  return null;
}

/** The next-page URL, refusing anything that is not https://api.github.com (the token goes with it). */
function checkedNextUrl(header) {
  const next = nextLinkOf(header);
  if (next === null) return null;
  let url;
  try {
    url = new URL(next);
  } catch {
    throw new Error(`the Link header holds a URL that cannot be read: ${next}`);
  }
  if (url.origin !== API_ORIGIN) {
    throw new Error(`the Link header points outside ${API_ORIGIN} (${url.origin}); not following it`);
  }
  return url.href;
}

function describeError(err) {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
  return `${err.message}${cause}`;
}

/** One page: a timeout per attempt, one retry. Throws after the second failure. */
async function fetchPage(url, { fetchImpl, headers, sleep }) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAY_MS);
    try {
      const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
      const body = await res.json();
      if (!Array.isArray(body)) throw new Error(`the answer from ${url} is not a JSON array`);
      return { body, link: res.headers.get("link") };
    } catch (err) {
      last = err;
    }
  }
  throw last;
}

async function fetchAdvisories({ fetchImpl, env, sleep }) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  const token = env.GITHUB_TOKEN;
  if (typeof token === "string" && token !== "") headers.Authorization = `Bearer ${token}`;

  const all = [];
  let url = ADVISORIES_URL;
  let pages = 0;
  while (url !== null) {
    if (pages >= MAX_PAGES) {
      throw new Error(`the advisory listing is longer than ${MAX_PAGES} pages; refusing to guess what is on the rest`);
    }
    const { body, link } = await fetchPage(url, { fetchImpl, headers, sleep });
    pages++;
    all.push(...body);
    url = checkedNextUrl(link);
  }
  return { advisories: all, pages };
}

function readInstalledNext(lockPath) {
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  const version = lock?.packages?.["node_modules/next"]?.version;
  if (typeof version !== "string" || version === "") {
    throw new Error(`${lockPath} has no packages["node_modules/next"].version, so the installed version is unknown`);
  }
  return version;
}

const DEFAULT_LOCK_PATH = fileURLToPath(new URL("../package-lock.json", import.meta.url));

/**
 * Reads the installed Next.js version from the lockfile and the published
 * advisories from GitHub, prints one line per in-range advisory and returns the
 * process exit code (0 ok, 1 failure). Never throws.
 */
export async function run({
  fetchImpl = globalThis.fetch,
  lockPath = DEFAULT_LOCK_PATH,
  env = process.env,
  log = console.log,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  try {
    const installed = readInstalledNext(lockPath);
    log(`next-advisory-check: installed next ${installed} (from package-lock.json)`);
    const { advisories, pages } = await fetchAdvisories({ fetchImpl, env, sleep });
    log(`next-advisory-check: read ${advisories.length} published advisories from ${pages} page(s)`);
    const { failures, notes } = evaluate(advisories, installed, ACKNOWLEDGED);
    for (const note of notes) log(`ok   ${note}`);
    for (const failure of failures) log(`FAIL ${failure}`);
    if (failures.length > 0) {
      log(`next-advisory-check: FAIL, ${failures.length} advisory/ies cover next ${installed} with no recorded fix`);
      return 1;
    }
    log(`next-advisory-check: ok, ${notes.length} in-range advisory/ies, all fixed or acknowledged`);
    return 0;
  } catch (err) {
    log(`FAIL cannot confirm that next is free of published advisories: ${describeError(err)} (failing closed)`);
    return 1;
  }
}

/** True when this module is the file node was started with (not when it is imported). */
export function isEntryPoint(metaUrl, argv1) {
  if (typeof argv1 !== "string" || argv1 === "") return false;
  return metaUrl === pathToFileURL(argv1).href;
}

if (isEntryPoint(import.meta.url, process.argv[1])) {
  process.exitCode = await run();
}
