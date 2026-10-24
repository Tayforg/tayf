#!/usr/bin/env node
// scripts/page-latency.mjs
//
// CLI entrypoint for the on-demand page latency probe: sends sequential GETs
// to the public routes via scripts/lib/page-latency.mjs and exits 1 when any
// route fails (a 5xx, a timeout, or a sample above 8000 ms), so
// .github/workflows/page-latency.yml's job goes red.
//
// Pure Node built-ins only, same as scripts/lib/page-latency.mjs — the
// workflow does not run `npm ci`. Unlike the ops heartbeat this deliberately
// does NOT load .env.local: the probe needs no secrets and must not pull any
// key into the process.
//
// Env:
//   PROBE_BASE_URL   origin to probe (https://, or http://localhost);
//                    falls back to NEXT_PUBLIC_SITE_URL
//   PROBE_SAMPLES    sequential GETs per route, 1-5 (default 3)

import { appendFileSync } from "node:fs";
import { runProbe } from "./lib/page-latency.mjs";

const code = await runProbe({
  env: process.env,
  fetchImpl: fetch,
  now: () => performance.now(),
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
