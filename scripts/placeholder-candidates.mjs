#!/usr/bin/env node
// scripts/placeholder-candidates.mjs
//
// Weekly runbook helper for PLACEHOLDER_IMAGE_ASSETS
// (supabase/functions/_shared/image-url.ts), h164-heroimg-1. READ-ONLY: it
// prints a SELECT for you to run and filters the rows you pipe back; it never
// connects to a database, fetches an image or writes a file.
//
// Why it exists: Karar and Istiklal attach one 'SON DAKIKA' card to unrelated
// stories and rotate that card's file every 3-5 days, so an exact key goes dead
// within a week and the next card shows as a story's hero until someone lists
// it. The same shape (one image_url on many titles over several days) is how
// every other stand-in in that list was found.
//
// RUNBOOK -- run weekly:
//
//   1. node scripts/placeholder-candidates.mjs --print-sql
//        prints one read-only SELECT: per source_id and image_url over the last
//        7 days, the URLs used by >= 5 distinct titles on >= 3 distinct
//        publication days (one row per source and URL, with the titles / days
//        count and the first and last day seen).
//   2. Run it against production with any read-only runner that prints JSON
//      rows, and pipe the output into this script:
//
//        <runner> -e "$(node scripts/placeholder-candidates.mjs --print-sql)" \
//          | node scripts/placeholder-candidates.mjs
//
//      The statement groups a week of articles; if the runner's statement
//      timeout cuts it off, run it again with a shorter window (edit the
//      interval in the printed text) rather than loosening the thresholds.
//   3. stdout is the JSON array of the rows isPlaceholderImageUrl does NOT
//      already match (the exact assets, the path-prefix families and the
//      basename patterns, on the normalised URL, as the render filter sees it);
//      stderr says how many rows came in and how many were already covered.
//   4. LOOK at every printed image_url. A publisher logo or a 'SON DAKIKA' /
//      'Gunun Ozeti' card becomes a PLACEHOLDER_IMAGE_ASSETS key; a real photo
//      that merely recurred (a topical stock photo, e.g. karar news/1946513, a
//      gold shop used on several gold stories) does not. Never add a key you
//      have not looked at. The key format, the comment each key carries and the
//      guard tests are described above PLACEHOLDER_IMAGE_ASSETS.
//
// The module is imported straight from its .ts source, which needs Node's
// built-in type stripping (on by default from Node 22.18; the repo runs Node 24).
// Node prints a one-time MODULE_TYPELESS_PACKAGE_JSON warning on STDERR because
// package.json has no "type" field; it is harmless and never reaches stdout.
//
// Pure ES module, Node built-ins only.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { isPlaceholderImageUrl } from "../supabase/functions/_shared/image-url.ts";

/** The look-back window of the candidate query, in days. */
export const WINDOW_DAYS = 7;
/** A candidate is used by at least this many distinct titles... */
export const MIN_TITLES = 5;
/** ...on at least this many distinct publication days. */
export const MIN_DAYS = 3;

/**
 * The read-only candidate query: one row per source and image_url that recurs
 * across titles and days. A single statement without a terminator or a comment,
 * so it survives `-e "$(...)"`.
 */
export const CANDIDATE_SQL =
  "select a.source_id, s.slug, a.image_url, " +
  "count(distinct a.title) as titles, " +
  "count(distinct a.published_at::date) as days, " +
  "min(a.published_at::date) as first_seen, " +
  "max(a.published_at::date) as last_seen " +
  "from public.articles a join public.sources s on s.id = a.source_id " +
  `where a.published_at >= now() - interval '${WINDOW_DAYS} days' and a.image_url is not null ` +
  "group by a.source_id, s.slug, a.image_url " +
  `having count(distinct a.title) >= ${MIN_TITLES} and count(distinct a.published_at::date) >= ${MIN_DAYS} ` +
  "order by titles desc, a.image_url";

/**
 * The rows of a runner's JSON output. A leading BOM and surrounding whitespace
 * are ignored; anything that is not a JSON array (empty input, a runner's error
 * line, an object) throws an Error naming the problem.
 */
export function parseRows(text) {
  const body = String(text ?? "")
    .replace(/^\uFEFF/, "")
    .trim();
  if (body === "") throw new Error("no input: pipe the JSON rows of the --print-sql query into this script");
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (err) {
    const head = body.length > 80 ? `${body.slice(0, 80)}...` : body;
    throw new Error(`input is not JSON (${err && err.message ? err.message : String(err)}): ${head}`);
  }
  if (!Array.isArray(parsed)) throw new Error("input is JSON but not an array of rows");
  return parsed;
}

/**
 * Splits `rows` by the shipped placeholder rules.
 *   unmatched  rows whose image_url isPlaceholderImageUrl does not match, in
 *              input order and untouched (these need a human look)
 *   matched    how many rows the rules already cover
 *   unreadable how many entries are not a row with a non-empty string image_url
 * Never throws.
 */
export function unmatchedRows(rows) {
  const unmatched = [];
  let matched = 0;
  let unreadable = 0;
  for (const row of rows) {
    const url = row !== null && typeof row === "object" && !Array.isArray(row) ? row.image_url : undefined;
    if (typeof url !== "string" || url.trim() === "") {
      unreadable++;
    } else if (isPlaceholderImageUrl(url)) {
      matched++;
    } else {
      unmatched.push(row);
    }
  }
  return { unmatched, matched, unreadable };
}

const USAGE =
  "usage: <runner> -e \"$(node scripts/placeholder-candidates.mjs --print-sql)\" | node scripts/placeholder-candidates.mjs\n" +
  "       node scripts/placeholder-candidates.mjs --print-sql";

function defaultReadStdin() {
  if (process.stdin.isTTY) {
    throw new Error("no input on stdin: pipe the JSON rows of the --print-sql query into this script");
  }
  return readFileSync(0, "utf8");
}

/**
 * CLI entry. Returns the process exit code; `io` can override stdout / stderr /
 * readStdin for tests.
 */
export function run(argv, io = {}) {
  const stdout = io.stdout ?? ((s) => process.stdout.write(`${s}\n`));
  const stderr = io.stderr ?? ((s) => process.stderr.write(`${s}\n`));
  const readStdin = io.readStdin ?? defaultReadStdin;

  let printSql = false;
  for (const arg of argv) {
    if (arg === "--print-sql") printSql = true;
    else if (arg === "--help" || arg === "-h") {
      stdout(USAGE);
      return 0;
    } else {
      stderr(`${arg.startsWith("-") ? "unknown option" : "unexpected argument"} ${arg}\n${USAGE}`);
      return 2;
    }
  }
  if (printSql) {
    stdout(CANDIDATE_SQL);
    return 0;
  }

  let rows;
  try {
    rows = parseRows(readStdin());
  } catch (err) {
    stderr(err && err.message ? err.message : String(err));
    return 1;
  }

  const { unmatched, matched, unreadable } = unmatchedRows(rows);
  stdout(JSON.stringify(unmatched, null, 2));
  stderr(
    `${rows.length} rows: ${matched} already matched, ${unreadable} unreadable, ` +
      `${unmatched.length} candidate(s) to check by eye`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = run(process.argv.slice(2));
}
