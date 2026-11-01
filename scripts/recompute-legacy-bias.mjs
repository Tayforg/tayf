#!/usr/bin/env node
// scripts/recompute-legacy-bias.mjs
//
// Operator tool of migration 132 (hunt 10, h10-data-1): repairs the legacy
// clusters (updated_at before 2026-09-05) whose bias_distribution still counts
// aggregator and niche votes, and withdraws the 'Kör nokta' flags that fail the
// current rule (at least 5 voting articles, dominant zone at least 0.8). It
// walks updated_at windows (7 days by default) and per window calls
// recompute_bias_distribution_range, then clear_false_blindspots_range.
//
//   node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-09-05           # dry run (default)
//   node scripts/recompute-legacy-bias.mjs --from 2026-04-01 --to 2026-09-05 --apply   # writes
//
// The default is a DRY RUN: every request carries p_dry_run true and nothing is
// written. Run the dry run first, compare its TOTAL with the 132 header and with
// docs/migration-guide.md, snapshot the affected rows, then --apply in a quiet
// window. A failure stops at the first window and prints the command that
// resumes it.
//
// Pure Node built-ins only (the logic and its tests live in
// scripts/lib/recompute-legacy-bias.mjs).
//
// Env (from .env.local for local runs, or the shell):
//   SUPABASE_URL                the project's https://<ref>.supabase.co URL
//   SUPABASE_SERVICE_ROLE_KEY   bearer both functions require (service_role only)

try {
  process.loadEnvFile(".env.local");
} catch {
  // absent locally is fine when the vars are already exported
}

import { runLegacyBias } from "./lib/recompute-legacy-bias.mjs";

const code = await runLegacyBias({
  argv: process.argv.slice(2),
  env: process.env,
  fetchImpl: fetch,
  log: (line) => console.log(line),
});

process.exit(code);
