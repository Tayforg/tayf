#!/usr/bin/env node
// scripts/ops-heartbeat.mjs
//
// CLI entrypoint for the ops heartbeat: calls public.ops_health_report()
// (migration 077) over PostgREST via scripts/lib/ops-heartbeat.mjs and exits
// non-zero on any 'fail' row, an empty report, or a mostly-'unknown' report,
// so .github/workflows/ops-heartbeat.yml's job goes red and GitHub emails.
//
// Pure Node built-ins only, same as scripts/lib/ops-heartbeat.mjs — the
// workflow does not run `npm ci`.
//
// Env (from .env.local for local runs, or the shell / GitHub Actions secrets):
//   SUPABASE_URL                the project's https://<ref>.supabase.co URL
//   SUPABASE_SERVICE_ROLE_KEY   bearer the RPC requires (service_role only)

try {
  process.loadEnvFile(".env.local");
} catch {
  // absent locally / in CI is fine when the vars are already exported
}

import { appendFileSync } from "node:fs";
import { runHeartbeat } from "./lib/ops-heartbeat.mjs";

const code = await runHeartbeat({
  env: process.env,
  fetchImpl: fetch,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  log: (line) => console.log(line),
  appendSummary: (markdown) => {
    const summaryPath = process.env.GITHUB_STEP_SUMMARY;
    if (!summaryPath) return;
    try {
      appendFileSync(summaryPath, markdown);
    } catch {
      // best-effort: a missing/unwritable summary file must never fail the run
    }
  },
});

process.exit(code);
