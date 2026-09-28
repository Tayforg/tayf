import { describe, it, expect, beforeAll } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Reads .github/workflows/ops-heartbeat.yml as plain text (no YAML parser
// dependency) and pins the properties that keep the */30 pager cheap and
// safe: no npm ci (nothing beyond Node built-ins is needed), no
// pull_request_target (this workflow only ever runs on schedule /
// workflow_dispatch, but a stray trigger here would be a secrets-exfil
// vector), no `echo ${{ secrets` (the classic way a workflow leaks a secret
// into its own log), and exactly the two secrets this item's docs name.

const WORKFLOW = resolve(__dirname, "..", "..", ".github", "workflows", "ops-heartbeat.yml");

let yaml = "";
beforeAll(() => {
  yaml = readFileSync(WORKFLOW, "utf8");
});

describe("ops-heartbeat.yml", () => {
  it("runs on a */30 schedule and workflow_dispatch", () => {
    expect(yaml).toMatch(/cron:\s*"\*\/30 \* \* \* \*"/);
    expect(yaml).toMatch(/workflow_dispatch:\s*\{\}/);
  });

  it("has read-only contents permissions", () => {
    expect(yaml).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("references exactly SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY as secrets", () => {
    const refs = [...yaml.matchAll(/secrets\.([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(new Set(refs)).toEqual(new Set(["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]));
  });

  it("runs node scripts/ops-heartbeat.mjs", () => {
    expect(yaml).toMatch(/run:\s*node\s+scripts\/ops-heartbeat\.mjs/);
  });

  it("has a job timeout of 10 minutes or less", () => {
    const m = /timeout-minutes:\s*(\d+)/.exec(yaml);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpExecArray)[1])).toBeLessThanOrEqual(10);
  });

  it("never runs npm ci", () => {
    expect(yaml).not.toMatch(/npm ci/);
  });

  it("never triggers on pull_request_target", () => {
    expect(yaml).not.toMatch(/pull_request_target/);
  });

  it("never echoes a secret into the log", () => {
    expect(yaml).not.toMatch(/echo\s+\$\{\{\s*secrets/);
  });
});
