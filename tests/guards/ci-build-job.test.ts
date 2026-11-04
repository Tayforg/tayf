import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// h31-deps-1: CI never ran `next build`. Two production builds of merged main
// commits failed (dpl_8ZSJ62dS7uQFjD8HfXT1fGoGqDED on 5ca5d00 and
// dpl_DWEeSk7D3VmUoGyawse3WCwM6yFG on cb41a4a): prerender / Cache Components
// errors that `tsc` and vitest cannot see, found only after the merge, where
// they block the deploy pipeline. PRs get no Vercel preview build either.
//
// ci.yml therefore carries a `build` job that installs and runs `npx next
// build` on pull_request and push to main. The job is the most exposed one in
// the repo (it executes the PR's own next.config.ts and every dependency's
// code), so this guard pins what keeps it harmless:
//
//   * `permissions: contents: read` and a timeout of 20 minutes or less;
//   * checkout drops its credentials; both actions stay pinned to the commit
//     SHAs the other jobs use;
//   * no `secrets.`, no `github.token` and no `supabase.co` anywhere in the
//     job: the build gets only the three PUBLISHABLE repository variables
//     (NEXT_PUBLIC_*), and a service-role key only as a literal placeholder;
//   * `npm ci` (no audit, no fund) runs before `npx next build`;
//   * the workflow still triggers on pull_request and push to main and never
//     on pull_request_target (which would run fork code with secrets).
//
// Like ci-dep-audit.test.ts this reads the YAML as plain text (line scans, no
// YAML parser dependency, no backtracking patterns). The helpers are copied
// from that file because a test file cannot be imported without registering
// its tests.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const CI = resolve(ROOT, ".github", "workflows", "ci.yml");

const CHECKOUT_PIN = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";
const SETUP_NODE_PIN = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0";
const MAX_TIMEOUT_MINUTES = 20;
const ALLOWED_VARS = ["NEXT_PUBLIC_SITE_URL", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"];
const BANNED_IN_JOB = ["secrets.", "github.token", "supabase.co"];

// --- plain-text helpers (character/line scans, no backtracking patterns) ----

/** Number of leading spaces of a line. */
function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

/** True for a blank line or a whole-line YAML comment. */
function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

/** The non-blank, non-comment lines of a YAML text. */
function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !isBlankOrComment(l));
}

/**
 * The lines nested under `key:` at exactly `indent` spaces (the key line itself
 * excluded). Empty when the key is absent.
 */
function blockOf(lines: string[], key: string, indent: number): string[] {
  const at = lines.findIndex((l) => indentOf(l) === indent && l.trim().startsWith(`${key}:`));
  if (at === -1) return [];
  const out: string[] = [];
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (isBlankOrComment(line)) continue;
    if (indentOf(line) <= indent) break;
    out.push(line);
  }
  return out;
}

/** The shell text of every `run:` step (single-line values only). */
function runCommands(lines: string[]): string[] {
  const out: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    const body = t.startsWith("- ") ? t.slice(2).trim() : t;
    if (body.startsWith("run:")) out.push(body.slice("run:".length).trim());
  }
  return out;
}

/** The step blocks of the job text that use `action` (the `uses:` line included). */
function stepsUsing(lines: string[], action: string): string[][] {
  const steps: string[][] = [];
  for (let i = 0; i < lines.length; i++) {
    const t = (lines[i] as string).trim();
    const body = t.startsWith("- ") ? t.slice(2).trim() : t;
    if (!body.startsWith("uses:") || !body.includes(`${action}@`)) continue;
    // Walk back to the step's own "- " line, forward to the next one.
    let start = i;
    while (start > 0 && !(lines[start] as string).trim().startsWith("- ")) start--;
    const stepIndent = indentOf(lines[start] as string);
    let end = i + 1;
    while (end < lines.length && indentOf(lines[end] as string) > stepIndent) end++;
    steps.push(lines.slice(start, end));
  }
  return steps;
}

/** The code lines of job `id` under `jobs:` (the `id:` line excluded); empty when absent. */
function jobLines(lines: string[], id: string): string[] {
  return blockOf(blockOf(lines, "jobs", 0), id, 2);
}

function isIdentChar(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  return (ch >= "a" && ch <= "z") || (ch >= "A" && ch <= "Z") || (ch >= "0" && ch <= "9") || ch === "_";
}

/** The `X` of every `vars.X` reference in a text (a longer word ending in `vars` does not count). */
function varsReferenced(text: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf("vars.", from);
    if (at === -1) break;
    from = at + "vars.".length;
    if (isIdentChar(text[at - 1])) continue;
    let end = from;
    while (isIdentChar(text[end])) end++;
    out.push(text.slice(from, end));
    from = end;
  }
  return out;
}

// --- the rules: each returns the list of problems it finds ------------------

function permissionsProblems(job: string[]): string[] {
  const perms = blockOf(job, "permissions", 4).map((l) => l.trim());
  return perms.length === 1 && perms[0] === "contents: read"
    ? []
    : [`permissions must be exactly "contents: read" (found: ${perms.join(" | ") || "none"})`];
}

function timeoutProblems(job: string[]): string[] {
  const line = job.find((l) => indentOf(l) === 4 && l.trim().startsWith("timeout-minutes:"));
  if (line === undefined) return ["no timeout-minutes"];
  const raw = line.trim().slice("timeout-minutes:".length).trim();
  const minutes = Number(raw);
  if (!Number.isInteger(minutes) || minutes <= 0) return [`timeout-minutes is not a positive integer: ${raw}`];
  return minutes <= MAX_TIMEOUT_MINUTES ? [] : [`timeout-minutes ${minutes} exceeds ${MAX_TIMEOUT_MINUTES}`];
}

function checkoutProblems(job: string[]): string[] {
  const steps = stepsUsing(job, "actions/checkout");
  if (steps.length !== 1) return [`expected exactly one actions/checkout step (found ${steps.length})`];
  const step = steps[0] as string[];
  const out: string[] = [];
  if (!step.some((l) => l.trim() === `- uses: ${CHECKOUT_PIN}`)) out.push(`checkout is not pinned to ${CHECKOUT_PIN}`);
  if (!step.some((l) => l.trim() === "persist-credentials: false")) out.push("checkout keeps its git credentials");
  return out;
}

function setupNodeProblems(job: string[]): string[] {
  const steps = stepsUsing(job, "actions/setup-node");
  if (steps.length !== 1) return [`expected exactly one actions/setup-node step (found ${steps.length})`];
  const step = steps[0] as string[];
  const out: string[] = [];
  if (!step.some((l) => l.trim() === `- uses: ${SETUP_NODE_PIN}`)) out.push(`setup-node is not pinned to ${SETUP_NODE_PIN}`);
  if (!step.some((l) => l.trim() === "node-version: 24")) out.push("setup-node does not pin node-version: 24");
  return out;
}

function installProblems(job: string[]): string[] {
  const runs = runCommands(job);
  const install = runs.findIndex((r) => r.startsWith("npm ci"));
  const build = runs.findIndex((r) => r === "npx next build");
  const out: string[] = [];
  if (install === -1) out.push("no `npm ci` run line");
  else {
    const cmd = runs[install] as string;
    for (const flag of ["--no-audit", "--no-fund", "--ignore-scripts"]) {
      if (!cmd.split(" ").includes(flag)) out.push(`npm ci lacks ${flag}`);
    }
  }
  if (build === -1) out.push("no run line that is exactly `npx next build`");
  if (install !== -1 && build !== -1 && install > build) out.push("`npm ci` must run before `npx next build`");
  return out;
}

function bannedTextProblems(job: string[]): string[] {
  const text = job.join("\n");
  return BANNED_IN_JOB.filter((needle) => text.includes(needle)).map((needle) => `the build job contains "${needle}"`);
}

function varsProblems(job: string[]): string[] {
  const used = varsReferenced(job.join("\n"));
  return [...new Set(used)].filter((v) => !ALLOWED_VARS.includes(v)).map((v) => `vars.${v} is not an allowed variable`);
}

function serviceKeyProblems(job: string[]): string[] {
  const out: string[] = [];
  for (const line of job) {
    const t = line.trim();
    if (!t.startsWith("SUPABASE_SERVICE_ROLE_KEY:")) continue;
    const value = t.slice("SUPABASE_SERVICE_ROLE_KEY:".length).trim();
    if (value.includes("${{")) out.push("SUPABASE_SERVICE_ROLE_KEY is an expression, not a literal placeholder");
    else if (!value.includes("placeholder")) out.push("SUPABASE_SERVICE_ROLE_KEY literal does not contain `placeholder`");
  }
  return out;
}

function sentryProblems(job: string[]): string[] {
  return job.some((l) => l.includes("SENTRY_")) ? ["the build job sets or references a SENTRY_* variable"] : [];
}

function triggerProblems(fileLines: string[]): string[] {
  const on = blockOf(fileLines, "on", 0);
  const out: string[] = [];
  for (const event of ["pull_request", "push"]) {
    const trigger = blockOf(on, event, 2);
    if (!on.some((l) => indentOf(l) === 2 && l.trim().startsWith(`${event}:`))) out.push(`no ${event} trigger`);
    else if (!trigger.some((l) => l.trim().startsWith("branches:") && l.includes("main"))) {
      out.push(`${event} is not limited to branches [main]`);
    }
  }
  if (fileLines.some((l) => l.includes("pull_request_target"))) out.push("pull_request_target is used");
  return out;
}

/** Every problem with a ci.yml text; empty when the build job and triggers are sound. */
function problemsOf(text: string): string[] {
  const lines = codeLines(text);
  const job = jobLines(lines, "build");
  if (job.length === 0) return ["no build job"];
  return [
    ...triggerProblems(lines),
    ...permissionsProblems(job),
    ...timeoutProblems(job),
    ...checkoutProblems(job),
    ...setupNodeProblems(job),
    ...installProblems(job),
    ...bannedTextProblems(job),
    ...varsProblems(job),
    ...serviceKeyProblems(job),
    ...sentryProblems(job),
  ];
}

const ci = readFileSync(CI, "utf8");
const ciLines = codeLines(ci);
const build = jobLines(ciLines, "build");

describe("ci.yml build job (h31-deps-1)", () => {
  it("has a `build` job under jobs", () => {
    expect(ci.split(/\r?\n/)).toContain("  build:");
    expect(build.length).toBeGreaterThan(0);
  });

  it("is read-only: permissions is exactly `contents: read`", () => {
    expect(permissionsProblems(build)).toEqual([]);
  });

  it("has a timeout of 20 minutes or less", () => {
    expect(timeoutProblems(build)).toEqual([]);
  });

  it("checks out the pinned action without persisting credentials", () => {
    expect(checkoutProblems(build)).toEqual([]);
  });

  it("sets up the pinned Node 24", () => {
    expect(setupNodeProblems(build)).toEqual([]);
  });

  it("installs with `npm ci --no-audit --no-fund --ignore-scripts` before `npx next build`", () => {
    expect(installProblems(build)).toEqual([]);
  });

  it("contains no secrets., no github.token and no supabase.co", () => {
    expect(bannedTextProblems(build)).toEqual([]);
  });

  it("reads only the three publishable NEXT_PUBLIC_* repository variables", () => {
    expect(varsProblems(build)).toEqual([]);
  });

  it("never takes SUPABASE_SERVICE_ROLE_KEY from vars or secrets (absent or a placeholder literal)", () => {
    expect(serviceKeyProblems(build)).toEqual([]);
  });

  it("sets no SENTRY_* variable, so no source-map upload or auth token is involved", () => {
    expect(sentryProblems(build)).toEqual([]);
  });

  it("still triggers on pull_request and push to main, never on pull_request_target", () => {
    expect(triggerProblems(ciLines)).toEqual([]);
  });

  it("leaves the job set intact (check, deno, live-db remain)", () => {
    const jobs = blockOf(ciLines, "jobs", 0).filter((l) => indentOf(l) === 2);
    expect(jobs.map((l) => l.trim())).toEqual(expect.arrayContaining(["check:", "deno:", "build:", "live-db:"]));
  });

  it("the whole real file has no problem", () => {
    expect(problemsOf(ci)).toEqual([]);
  });
});

// --- mutation tests: the rules must have teeth ------------------------------

interface SampleOptions {
  /** Extra lines under `env:` of the build job (already indented). */
  env?: string[];
  timeout?: string;
  permissions?: string[];
  checkoutPin?: string;
  persist?: boolean;
  install?: string;
  buildRun?: string;
  /** Run lines placed before the install (for the ordering mutation). */
  beforeInstall?: string[];
  trigger?: string[];
  omitBuildJob?: boolean;
}

/** A sound ci.yml (a minimal build job); each option breaks one rule. */
function sample(o: SampleOptions = {}): string {
  const lines: string[] = [
    "name: CI",
    "on:",
    ...(o.trigger ?? ["  pull_request:", "    branches: [main]", "  push:", "    branches: [main]"]),
    "permissions:",
    "  contents: read",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    timeout-minutes: 10",
    "    steps:",
    "      - run: npm test",
  ];
  if (!o.omitBuildJob) {
    lines.push(
      "  build:",
      "    runs-on: ubuntu-latest",
      `    timeout-minutes: ${o.timeout ?? "20"}`,
      ...(o.permissions ?? ["    permissions:", "      contents: read"]),
      "    env:",
      '      NEXT_TELEMETRY_DISABLED: "1"',
      "      NEXT_PUBLIC_SITE_URL: ${{ vars.NEXT_PUBLIC_SITE_URL }}",
      ...(o.env ?? []),
      "    steps:",
      `      - uses: ${o.checkoutPin ?? CHECKOUT_PIN}`,
      ...(o.persist === false ? [] : ["        with:", "          persist-credentials: false"]),
      `      - uses: ${SETUP_NODE_PIN}`,
      "        with:",
      "          node-version: 24",
      "          cache: npm",
      ...(o.beforeInstall ?? []).map((r) => `      - run: ${r}`),
      `      - run: ${o.install ?? "npm ci --ignore-scripts --no-audit --no-fund --prefer-offline"}`,
      `      - run: ${o.buildRun ?? "npx next build"}`,
    );
  }
  lines.push("  live-db:", "    runs-on: ubuntu-latest", "    steps:", "      - run: echo done");
  return `${lines.join("\n")}\n`;
}

describe("the build-job guard's own mutation tests", () => {
  it("accepts the sound sample (the positive control behind every failure below)", () => {
    expect(problemsOf(sample())).toEqual([]);
  });

  it("fails a build job that references secrets.X", () => {
    const problems = problemsOf(sample({ env: ["      FOO: ${{ secrets.X }}"] }));
    expect(problems).toContain('the build job contains "secrets."');
  });

  it("fails a workflow with no build job", () => {
    expect(problemsOf(sample({ omitBuildJob: true }))).toEqual(["no build job"]);
  });

  it("fails github.token and a supabase.co literal", () => {
    expect(problemsOf(sample({ env: ["      T: ${{ github.token }}"] }))).toContain('the build job contains "github.token"');
    expect(problemsOf(sample({ env: ["      U: https://abc.supabase.co"] }))).toContain('the build job contains "supabase.co"');
  });

  it("fails a vars.X outside the three publishable variables, accepts all three", () => {
    expect(problemsOf(sample({ env: ["      X: ${{ vars.SOMETHING_ELSE }}"] }))).toEqual([
      "vars.SOMETHING_ELSE is not an allowed variable",
    ]);
    expect(
      problemsOf(
        sample({
          env: [
            "      NEXT_PUBLIC_SUPABASE_URL: ${{ vars.NEXT_PUBLIC_SUPABASE_URL }}",
            "      NEXT_PUBLIC_SUPABASE_ANON_KEY: ${{ vars.NEXT_PUBLIC_SUPABASE_ANON_KEY }}",
          ],
        }),
      ),
    ).toEqual([]);
  });

  it("does not mistake a longer word ending in `vars.` for a variable reference", () => {
    expect(varsReferenced("envvars.X and ${{ vars.A }} and ${{vars.B_1}}")).toEqual(["A", "B_1"]);
  });

  it("takes SUPABASE_SERVICE_ROLE_KEY only as a literal placeholder", () => {
    expect(problemsOf(sample({ env: ["      SUPABASE_SERVICE_ROLE_KEY: ci-build-placeholder"] }))).toEqual([]);
    expect(problemsOf(sample({ env: ["      SUPABASE_SERVICE_ROLE_KEY: real-looking-key"] }))).toEqual([
      "SUPABASE_SERVICE_ROLE_KEY literal does not contain `placeholder`",
    ]);
    const fromVars = problemsOf(sample({ env: ["      SUPABASE_SERVICE_ROLE_KEY: ${{ vars.SUPABASE_SERVICE_ROLE_KEY }}"] }));
    expect(fromVars).toContain("SUPABASE_SERVICE_ROLE_KEY is an expression, not a literal placeholder");
    expect(fromVars).toContain("vars.SUPABASE_SERVICE_ROLE_KEY is not an allowed variable");
  });

  it("fails any SENTRY_* variable", () => {
    expect(problemsOf(sample({ env: ["      SENTRY_AUTH_TOKEN: x"] }))).toEqual([
      "the build job sets or references a SENTRY_* variable",
    ]);
  });

  it("fails a timeout above 20, a missing one, and a non-number", () => {
    expect(problemsOf(sample({ timeout: "21" }))).toEqual(["timeout-minutes 21 exceeds 20"]);
    expect(problemsOf(sample({ timeout: "20" }))).toEqual([]);
    expect(problemsOf(sample({ timeout: "${{ vars.T }}" }))).toContain(
      "timeout-minutes is not a positive integer: ${{ vars.T }}",
    );
  });

  it("fails permissions other than exactly `contents: read`", () => {
    expect(problemsOf(sample({ permissions: ["    permissions:", "      contents: write"] }))).toHaveLength(1);
    expect(
      problemsOf(sample({ permissions: ["    permissions:", "      contents: read", "      id-token: write"] })),
    ).toHaveLength(1);
    expect(problemsOf(sample({ permissions: [] }))).toHaveLength(1);
  });

  it("fails an unpinned checkout and a checkout that keeps its credentials", () => {
    expect(problemsOf(sample({ checkoutPin: "actions/checkout@v7" }))).toHaveLength(1);
    expect(problemsOf(sample({ persist: false }))).toEqual(["checkout keeps its git credentials"]);
  });

  it("fails an npm ci without the required flags and a build that runs before the install", () => {
    expect(problemsOf(sample({ install: "npm ci --ignore-scripts --no-fund" }))).toEqual(["npm ci lacks --no-audit"]);
    expect(problemsOf(sample({ install: "npm ci --no-audit --no-fund" }))).toEqual(["npm ci lacks --ignore-scripts"]);
    expect(problemsOf(sample({ buildRun: "npx next build --debug" }))).toEqual([
      "no run line that is exactly `npx next build`",
    ]);
    expect(problemsOf(sample({ beforeInstall: ["npx next build"] }))).toEqual([
      "`npm ci` must run before `npx next build`",
    ]);
  });

  it("fails a workflow that loses a trigger or gains pull_request_target", () => {
    expect(problemsOf(sample({ trigger: ["  push:", "    branches: [main]"] }))).toEqual(["no pull_request trigger"]);
    expect(problemsOf(sample({ trigger: ["  pull_request:", "    branches: [main]", "  push:", "    branches: [dev]"] }))).toEqual([
      "push is not limited to branches [main]",
    ]);
    expect(
      problemsOf(
        sample({ trigger: ["  pull_request:", "    branches: [main]", "  push:", "    branches: [main]", "  pull_request_target: {}"] }),
      ),
    ).toEqual(["pull_request_target is used"]);
  });

  it("ignores prose in comments: a comment may say `no secrets.` without failing the job", () => {
    const text = `${sample()}\n    # this job holds no secrets. and no github.token\n`;
    expect(problemsOf(text)).toEqual([]);
  });
});
