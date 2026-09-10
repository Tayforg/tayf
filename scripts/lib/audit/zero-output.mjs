// scripts/lib/audit/zero-output.mjs
//
// Pure computation core of the "zero-output" alarm: the pipeline can be
// green (no errors thrown, cron ticking) while silently producing nothing —
// no clusters getting a neutral title, no ingest cycles completing at all.
// Factored out of scripts/audit-clusters.mjs (same reason as report.mjs:
// audit-clusters.mjs calls main() at import time and can't be imported by a
// test) so the alarm rule itself is unit-testable without a Supabase client.
//
// evaluateZeroOutput() takes already-fetched counts and does no I/O of its
// own: no Supabase client, no Date.now(), no randomness. Same input → same
// output, always.

export const ZERO_OUTPUT_WINDOW_HOURS = 24;

/**
 * @param {{
 *   neutralTitles24h: number | null | undefined,
 *   ingestCycles24h: number | null | undefined,
 *   anthropicKeyPresent: boolean,
 * }} params
 * @returns {{ failures: string[], lines: string[] }}
 */
export function evaluateZeroOutput({ neutralTitles24h, ingestCycles24h, anthropicKeyPresent }) {
  const failures = [];
  const lines = [];

  // ---- neutral-title check -------------------------------------------------
  // Only meaningful when ANTHROPIC_API_KEY is set — without it, the
  // neutralizer never runs and zero neutral titles is expected, not an
  // outage. See the workflow-level dormancy note in
  // .github/workflows/cluster-audit.yml.
  if (anthropicKeyPresent) {
    if (neutralTitles24h == null) {
      failures.push(
        "neutral titles in last 24h: could not read count (query failed)",
      );
      lines.push("[zero-output] neutral titles written in last 24h: <unreadable>");
    } else {
      lines.push(`[zero-output] neutral titles written in last 24h: ${neutralTitles24h}`);
      if (neutralTitles24h <= 0) {
        failures.push(
          `neutral titles in last 24h: expected > 0, got ${neutralTitles24h} (ANTHROPIC_API_KEY is set)`,
        );
      }
    }
  } else {
    lines.push("[zero-output] neutral-title check skipped (ANTHROPIC_API_KEY unset)");
  }

  // ---- ingest-cycles check --------------------------------------------------
  // Runs unconditionally: ingest has no feature-flag dependency, so zero
  // rows in 24h always means the pipeline stopped producing anything.
  if (ingestCycles24h == null) {
    failures.push("ingest_cycles rows in last 24h: could not read count (query failed)");
    lines.push("[zero-output] ingest cycles in last 24h: <unreadable>");
  } else {
    lines.push(`[zero-output] ingest cycles in last 24h: ${ingestCycles24h}`);
    if (ingestCycles24h <= 0) {
      failures.push(`ingest_cycles rows in last 24h: expected > 0, got ${ingestCycles24h}`);
    }
  }

  return { failures, lines };
}
