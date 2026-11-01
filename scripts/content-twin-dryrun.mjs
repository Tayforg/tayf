#!/usr/bin/env node
// scripts/content-twin-dryrun.mjs
//
// READ-ONLY dry-run of the content-twin detector (migration 139): prints what
// /admin/birlestir "Olası içerik ikizleri" would list right now. It never merges,
// never writes, never dismisses; merging stays an admin click on the existing
// Birleştir flow (tests/guards/admin-content-twins-readonly.test.ts pins this).
//
//   node scripts/content-twin-dryrun.mjs --input rows.json
//       Re-scores rows shaped like the admin_content_twin_pairs() output (a JSON
//       array, or an object with a `rows` array). No network, no environment.
//       Use it to dry-run before 139 is applied: produce the JSON with a
//       read-only SELECT of the function body (see the migration header).
//
//   node --env-file=.env.local scripts/content-twin-dryrun.mjs --rpc [--hours 48] [--limit 50]
//       Calls admin_content_twin_pairs() with the service-role key from the
//       environment (SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL, and
//       SUPABASE_SERVICE_ROLE_KEY). The environment is never printed.
//
//   --all     also list the candidates the rescorer rejected
//   --json    print one JSON object instead of the table
//
// Output: candidates (rows the SQL pre-filter returned), passing the rescorer
// (score >= MATCH_THRESHOLD), then a table of the passing pairs: ids, titles,
// score, lane, hours apart.

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { MATCH_THRESHOLD, rescoreContentPairs } from "./lib/content-twin-rescore.mjs";

const USAGE =
  "usage: node scripts/content-twin-dryrun.mjs (--input <rows.json> | --rpc [--hours N] [--limit N]) [--all] [--json]";

/** @param {string[]} argv */
export function parseArgs(argv) {
  const args = { input: null, rpc: false, all: false, json: false, hours: 48, limit: 50 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--input") args.input = argv[++i] ?? null;
    else if (a === "--rpc") args.rpc = true;
    else if (a === "--all") args.all = true;
    else if (a === "--json") args.json = true;
    else if (a === "--hours") args.hours = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  if (!args.input && !args.rpc) throw new Error(USAGE);
  if (args.input && args.rpc) throw new Error(`--input and --rpc are exclusive\n${USAGE}`);
  return args;
}

/** @param {unknown} parsed */
export function rowsOf(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.rows)) return parsed.rows;
  throw new Error("input must be a JSON array of rows (or an object with a `rows` array)");
}

/** @param {string} s @param {number} n */
function clip(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/**
 * Re-scores the rows and pairs each with its result.
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 */
export function evaluate(rows) {
  const scores = rescoreContentPairs(rows);
  const items = rows.map((row, i) => ({ row, result: scores[i] }));
  const passing = items.filter((m) => m.result?.isMatch);
  return { candidates: rows.length, passing, items };
}

/** @param {ReturnType<typeof evaluate>["items"]} items */
export function renderTable(items) {
  const lines = ["score  lane                  hours  cluster_a  cluster_b  title_a | title_b"];
  const sorted = [...items].sort((x, y) => (y.result?.score ?? 0) - (x.result?.score ?? 0));
  for (const { row, result } of sorted) {
    lines.push(
      [
        (result?.score ?? 0).toFixed(3).padEnd(5),
        String(result?.lane ?? "-").padEnd(21),
        (result?.hoursApart ?? NaN).toFixed(2).padStart(5),
        String(row.cluster_a ?? "").slice(0, 8).padEnd(9),
        String(row.cluster_b ?? "").slice(0, 8).padEnd(9),
        `${clip(row.title_a, 60)} | ${clip(row.title_b, 60)}`,
      ].join("  "),
    );
  }
  return lines.join("\n");
}

async function fetchRows(args) {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("--rpc needs SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY in the environment");
  }
  const { createClient } = await import("@supabase/supabase-js");
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const res = await supabase.rpc("admin_content_twin_pairs", { p_hours: args.hours, p_limit: args.limit });
  if (res.error) throw new Error(`admin_content_twin_pairs: ${res.error.message}`);
  return rowsOf(res.data ?? []);
}

export async function main(argv) {
  const args = parseArgs(argv);
  const rows = args.input ? rowsOf(JSON.parse(readFileSync(args.input, "utf8"))) : await fetchRows(args);
  const { candidates, passing, items } = evaluate(rows);

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          matchThreshold: MATCH_THRESHOLD,
          candidates,
          passing: passing.length,
          pairs: (args.all ? items : passing).map(({ row, result }) => ({
            cluster_a: row.cluster_a,
            cluster_b: row.cluster_b,
            title_a: row.title_a,
            title_b: row.title_b,
            score: result?.score ?? 0,
            lane: result?.lane,
            hoursApart: result?.hoursApart,
            isMatch: result?.isMatch === true,
          })),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`candidates: ${candidates}`);
  console.log(`passing the rescorer: ${passing.length} (score >= ${MATCH_THRESHOLD})`);
  const shown = args.all ? items : passing;
  if (shown.length > 0) {
    console.log("");
    console.log(renderTable(shown));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
