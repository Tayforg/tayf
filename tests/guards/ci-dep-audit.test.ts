import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// h27-supply-1: nothing in CI ran `npm audit`. ci.yml and cluster-audit.yml
// both said "Dependabot + `npm audit` cover it", but Dependabot alerts are off
// on the repo and no workflow audited anything, so a published advisory on a
// production dependency (Next.js announces a security release for
// 2026-11-03) would have gone unnoticed.
//
// The advisory gate is a SEPARATE workflow (.github/workflows/dep-audit.yml)
// on purpose: `npm ci`'s built-in audit request stalled PR runs for npm's full
// 300 s fetch timeout on 2026-10-22, which is why the install steps run
// `--no-audit`. A stalled registry can hold this workflow's check, never the
// CI check.
//
// Like ops-heartbeat-workflow.test.ts this reads the YAML as plain text (no
// YAML parser dependency) and pins the properties that keep the gate cheap,
// read-only and unable to run a dependency's install script:
//   * `permissions: contents: read`, no `secrets.` reference at all;
//   * a job timeout of 10 minutes or less;
//   * runs weekly, on demand, and on any change to package.json /
//     package-lock.json (pull_request and push);
//   * `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` BEFORE
//     `npm audit --omit=dev --audit-level=high`;
//   * the checkout drops its credentials.
//
// h31-deps-1 widened the workflow with two more jobs, both pinned below:
//   * `next-advisories` runs scripts/next-advisory-check.mjs. `npm audit` reads
//     GitHub's global advisory database, which did not hold the Next.js 16.4.5
//     advisories (GHSA-mfr8-8qww-v76h is published on vercel/next.js with an
//     empty patched_versions, yet /advisories/GHSA-mfr8-8qww-v76h is a 404), so
//     the audit job stayed green on 16.4.3. The script reads the repository
//     advisories directly; it needs no install and gets only the workflow's own
//     read-only token, for the rate limit.
//   * `edge-audit` audits scripts/edge-audit/package.json, the exact npm pins
//     of the Edge Functions (tests/guards/edge-npm-audited.test.ts keeps it
//     equal to the code). That directory has no committed lockfile, so the job
//     generates one (`npm install --package-lock-only --ignore-scripts`) and
//     its setup-node step has no `cache:`.
// Every job keeps the 10 minute cap, drops the checkout credentials and the
// workflow keeps `permissions: contents: read` and references no repository
// secret.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const WORKFLOWS = resolve(ROOT, ".github", "workflows");
const AUDIT = resolve(WORKFLOWS, "dep-audit.yml");

const INSTALL = "npm ci --omit=dev --ignore-scripts --no-audit --no-fund";
const AUDIT_CMD = "npm audit --omit=dev --audit-level=high";
const STALE_CLAIM = "Dependabot + `npm audit` cover it";

const JOBS = ["audit", "next-advisories", "edge-audit"];
const EDGE_INSTALL = "npm install --package-lock-only --ignore-scripts --no-audit --no-fund";
const EDGE_AUDIT_CMD = "npm audit --audit-level=high";
const EDGE_DIR = "scripts/edge-audit";
const NEXT_CHECK_CMD = "node scripts/next-advisory-check.mjs";
const SETUP_NODE_PIN = "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0";
const CHECKOUT_PIN = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1";

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

/** The text of a `paths:` entry, flow (`[a, b]`) or block (`- a`) style. */
function pathsOf(triggerBlock: string[]): string[] {
  const at = triggerBlock.findIndex((l) => l.trim().startsWith("paths:"));
  if (at === -1) return [];
  const first = triggerBlock[at] as string;
  const base = indentOf(first);
  let text = first.trim().slice("paths:".length);
  for (let i = at + 1; i < triggerBlock.length; i++) {
    const line = triggerBlock[i] as string;
    if (indentOf(line) <= base) break;
    text += ` ${line.trim()}`;
  }
  const tokens: string[] = [];
  let cur = "";
  for (const ch of text) {
    if (ch === "[" || ch === "]" || ch === "," || ch === '"' || ch === "'" || ch === " ") {
      if (cur !== "") tokens.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur !== "") tokens.push(cur);
  // A block sequence item starts with a lone "-".
  return tokens.filter((t) => t !== "-");
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
function jobLines(all: string[], id: string): string[] {
  return blockOf(blockOf(all, "jobs", 0), id, 2);
}

let audit = "";
let lines: string[] = [];
beforeAll(() => {
  audit = existsSync(AUDIT) ? readFileSync(AUDIT, "utf8") : "";
  lines = codeLines(audit);
});

describe("dep-audit.yml exists and is a separate, read-only workflow", () => {
  it("exists and is named Dependency Audit", () => {
    expect(existsSync(AUDIT)).toBe(true);
    expect(audit).toMatch(/^name: Dependency Audit$/m);
  });

  it("has top-level read-only contents permissions", () => {
    const perms = blockOf(lines, "permissions", 0);
    expect(perms.map((l) => l.trim())).toEqual(["contents: read"]);
  });

  it("references no secrets at all", () => {
    expect(audit).not.toContain("secrets.");
  });

  it("never triggers on pull_request_target", () => {
    expect(audit).not.toContain("pull_request_target");
  });

  it("gives EVERY job a timeout of 10 minutes or less (not just the first)", () => {
    const timeouts = lines.filter((l) => l.trim().startsWith("timeout-minutes:"));
    // audit, next-advisories, edge-audit: one per job.
    expect(timeouts).toHaveLength(JOBS.length);
    for (const line of timeouts) {
      const raw = line.trim().slice("timeout-minutes:".length).trim();
      expect(Number.isInteger(Number(raw)), line).toBe(true);
      expect(Number(raw), line).toBeGreaterThan(0);
      expect(Number(raw), line).toBeLessThanOrEqual(10);
    }
    for (const id of JOBS) {
      expect(jobLines(lines, id).some((l) => indentOf(l) === 4 && l.trim().startsWith("timeout-minutes:")), id).toBe(
        true,
      );
    }
  });

  it("has exactly the audit, next-advisories and edge-audit jobs", () => {
    const ids = blockOf(lines, "jobs", 0)
      .filter((l) => indentOf(l) === 2)
      .map((l) => l.trim());
    expect(ids).toEqual(JOBS.map((id) => `${id}:`));
  });
});

describe("dep-audit.yml triggers", () => {
  it("runs on a weekly cron", () => {
    const schedule = blockOf(lines, "schedule", 2);
    const cron = schedule.find((l) => l.includes("cron:"));
    expect(cron).toBeDefined();
    // minute hour day-of-month month day-of-week: weekly = a fixed weekday.
    const fields = (cron as string)
      .slice((cron as string).indexOf("cron:") + "cron:".length)
      .replaceAll('"', "")
      .replaceAll("'", "")
      .trim()
      .split(" ");
    expect(fields).toHaveLength(5);
    expect(fields[2]).toBe("*");
    expect(fields[3]).toBe("*");
    expect(fields[4]).toMatch(/^[0-6]$/);
  });

  it("runs on demand", () => {
    expect(lines.some((l) => indentOf(l) === 2 && l.trim().startsWith("workflow_dispatch:"))).toBe(true);
  });

  it.each(["pull_request", "push"])("%s is limited to the dependency manifests and their audit inputs", (event) => {
    const trigger = blockOf(lines, event, 2);
    expect(trigger.length).toBeGreaterThan(0);
    const paths = pathsOf(trigger);
    expect(paths).toContain("package.json");
    expect(paths).toContain("package-lock.json");
    expect(paths).toContain("scripts/edge-audit/**");
    expect(paths).toContain("scripts/next-advisory-check.mjs");
    expect(paths).toContain("supabase/functions/**");
    expect(paths).toContain(".github/workflows/dep-audit.yml");
    // Still a path filter, not the whole repository.
    expect(paths.length).toBeLessThanOrEqual(8);
    expect(paths).not.toContain("**");
  });
});

describe("dep-audit.yml steps", () => {
  it("installs production dependencies without scripts, then audits them", () => {
    const runs = runCommands(lines);
    const install = runs.findIndex((r) => r === INSTALL);
    const audited = runs.findIndex((r) => r === AUDIT_CMD);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(audited).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(audited);
  });

  it("never runs an npm install without --ignore-scripts", () => {
    const installs = runCommands(lines).filter((r) => r.startsWith("npm ci") || r.startsWith("npm install"));
    expect(installs.length).toBeGreaterThan(0);
    for (const cmd of installs) expect(cmd).toContain("--ignore-scripts");
  });

  it("checks out without persisting credentials", () => {
    const checkouts = stepsUsing(lines, "actions/checkout");
    expect(checkouts.length).toBeGreaterThan(0);
    for (const step of checkouts) {
      expect(step.some((l) => l.trim() === "persist-credentials: false")).toBe(true);
    }
  });
});

describe("dep-audit.yml jobs: every checkout and setup-node is pinned, credential-free and on Node 24", () => {
  it.each(JOBS)("%s checks out the pinned action without persisting credentials", (id) => {
    const steps = stepsUsing(jobLines(lines, id), "actions/checkout");
    expect(steps).toHaveLength(1);
    const step = steps[0] as string[];
    expect(step.some((l) => l.trim() === `- uses: ${CHECKOUT_PIN}`)).toBe(true);
    expect(step.some((l) => l.trim() === "persist-credentials: false")).toBe(true);
  });

  it.each(JOBS)("%s sets up the pinned Node 24", (id) => {
    const steps = stepsUsing(jobLines(lines, id), "actions/setup-node");
    expect(steps).toHaveLength(1);
    const step = steps[0] as string[];
    expect(step.some((l) => l.trim() === `- uses: ${SETUP_NODE_PIN}`)).toBe(true);
    expect(step.some((l) => l.trim() === "node-version: 24")).toBe(true);
  });

  it("every checkout in the workflow drops its credentials (three of them now)", () => {
    const checkouts = stepsUsing(lines, "actions/checkout");
    expect(checkouts).toHaveLength(JOBS.length);
    for (const step of checkouts) expect(step.some((l) => l.trim() === "persist-credentials: false")).toBe(true);
  });
});

describe("dep-audit.yml next-advisories job (scripts/next-advisory-check.mjs)", () => {
  const job = () => jobLines(lines, "next-advisories");

  it("exists", () => {
    expect(job().length).toBeGreaterThan(0);
  });

  it("runs the advisory check, with the workflow's own read-only token for the API rate limit", () => {
    expect(runCommands(job())).toContain(NEXT_CHECK_CMD);
    expect(job().some((l) => l.trim() === "GITHUB_TOKEN: ${{ github.token }}")).toBe(true);
  });

  it("hands the token to the check step only, not to the whole job", () => {
    const tokenAt = job().findIndex((l) => l.trim() === "GITHUB_TOKEN: ${{ github.token }}");
    const runAt = job().findIndex((l) => l.trim() === `run: ${NEXT_CHECK_CMD}`);
    expect(runAt).toBeGreaterThanOrEqual(0);
    // Step-level env: below the run line of the same step, nested under `env:` of that step (a
    // job-level env would put the token line at indent 6).
    expect(tokenAt).toBeGreaterThan(runAt);
    expect(indentOf(job()[tokenAt] as string)).toBe(10);
    expect(job()[tokenAt - 1]?.trim()).toBe("env:");
  });

  it("has no install step at all (the script uses Node built-ins only)", () => {
    const installs = runCommands(job()).filter(
      (r) => r.startsWith("npm ci") || r.startsWith("npm install") || r.startsWith("npm i "),
    );
    expect(installs).toEqual([]);
  });

  it("has no setup-node cache (nothing is installed)", () => {
    const [step] = stepsUsing(job(), "actions/setup-node");
    expect((step as string[]).some((l) => l.trim().startsWith("cache:"))).toBe(false);
  });

  it("has a timeout of 5 minutes or less", () => {
    const line = job().find((l) => indentOf(l) === 4 && l.trim().startsWith("timeout-minutes:"));
    expect(Number((line as string).trim().slice("timeout-minutes:".length))).toBeLessThanOrEqual(5);
  });
});

describe("dep-audit.yml edge-audit job (scripts/edge-audit)", () => {
  const job = () => jobLines(lines, "edge-audit");

  it("exists", () => {
    expect(job().length).toBeGreaterThan(0);
  });

  it(`runs its commands in ${EDGE_DIR}`, () => {
    expect(job().some((l) => l.trim() === `working-directory: ${EDGE_DIR}`)).toBe(true);
  });

  it("generates the lockfile without scripts, then audits at high severity", () => {
    const runs = runCommands(job());
    const install = runs.findIndex((r) => r === EDGE_INSTALL);
    const audited = runs.findIndex((r) => r === EDGE_AUDIT_CMD);
    expect(install).toBeGreaterThanOrEqual(0);
    expect(audited).toBeGreaterThanOrEqual(0);
    expect(install).toBeLessThan(audited);
  });

  it("has no setup-node cache (that directory has no committed lockfile)", () => {
    const [step] = stepsUsing(job(), "actions/setup-node");
    expect((step as string[]).some((l) => l.trim().startsWith("cache:"))).toBe(false);
  });

  it("never runs a real install (no npm ci, no install without --package-lock-only)", () => {
    for (const cmd of runCommands(job()).filter((r) => r.startsWith("npm ci") || r.startsWith("npm install"))) {
      expect(cmd).toContain("--package-lock-only");
      expect(cmd).toContain("--ignore-scripts");
    }
  });

  it("has a timeout of 10 minutes or less", () => {
    const line = job().find((l) => indentOf(l) === 4 && l.trim().startsWith("timeout-minutes:"));
    expect(Number((line as string).trim().slice("timeout-minutes:".length))).toBeLessThanOrEqual(10);
  });
});

describe("dependabot leaves the edge-pinned ESM-only majors alone", () => {
  const dependabot = codeLines(readFileSync(resolve(ROOT, ".github", "dependabot.yml"), "utf8"));
  const npmEntry = (() => {
    const at = dependabot.findIndex((l) => l.trim() === "- package-ecosystem: npm");
    if (at === -1) return [];
    const out: string[] = [];
    for (let i = at + 1; i < dependabot.length; i++) {
      if ((dependabot[i] as string).trim().startsWith("- package-ecosystem:")) break;
      out.push(dependabot[i] as string);
    }
    return out;
  })();

  it("has the npm entry", () => {
    expect(npmEntry.length).toBeGreaterThan(0);
  });

  it.each(["fast-xml-parser", "strnum"])("ignores semver-major updates of %s (the edge pin guards reject the next major by design)", (name) => {
    const ignore = blockOf(npmEntry, "ignore", 4);
    const at = ignore.findIndex((l) => l.trim() === `- dependency-name: ${name}`);
    expect(at, `${name} must be listed under ignore:`).toBeGreaterThanOrEqual(0);
    const update = ignore.slice(at + 1, at + 2).map((l) => l.trim());
    expect(update).toEqual(['update-types: ["version-update:semver-major"]']);
  });

  it("keeps the minor-and-patch group and ignores nothing else", () => {
    const names = blockOf(npmEntry, "ignore", 4)
      .filter((l) => l.trim().startsWith("- dependency-name:"))
      .map((l) => l.trim().slice("- dependency-name:".length).trim());
    expect(names.sort()).toEqual(["fast-xml-parser", "strnum"]);
    expect(npmEntry.some((l) => l.trim() === "update-types: [minor, patch]")).toBe(true);
  });
});

// The audit runs with --omit=dev, so it only sees what package.json lists under
// `dependencies`. fast-xml-parser (with its strnum dependency) parses untrusted
// feeds inside the ingest edge function, which holds the service-role key; it
// is imported from esm.sh there, so the npm copy exists to be audited and to run
// the unit tests against the same version. It must therefore be a production
// dependency, at the exact versions the edge pin carries.
describe("the audited production tree contains the packages the edge runtime parses untrusted input with", () => {
  const manifest = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const lock = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string; dev?: boolean } | undefined>;
  };

  it.each([
    ["fast-xml-parser", "4.5.7"],
    ["strnum", "1.1.2"],
  ])("%s is a production dependency pinned to exactly %s", (name, version) => {
    expect(manifest.dependencies?.[name]).toBe(version);
    expect(manifest.devDependencies?.[name]).toBeUndefined();
    expect(lock.packages[`node_modules/${name}`]?.version).toBe(version);
    expect(lock.packages[`node_modules/${name}`]?.dev).not.toBe(true);
  });

  it("the workflow comment names the edge runtime packages in its scope statement", () => {
    expect(audit).toContain("fast-xml-parser");
    expect(audit).toContain("edge");
  });
});

describe("the CI workflows no longer claim an audit that did not exist", () => {
  const readWorkflow = (name: string) => readFileSync(resolve(WORKFLOWS, name), "utf8");

  it.each(["ci.yml", "cluster-audit.yml"])("%s drops the stale claim and points at dep-audit.yml", (name) => {
    const yaml = readWorkflow(name);
    expect(yaml).not.toContain(STALE_CLAIM);
    expect(yaml).toContain("dep-audit.yml");
    expect(yaml).toContain("--no-audit");
  });
});

// h27-supply-2: the deno job type-checked 3 of the 7 edge functions (ingest,
// cluster-consumer, image-consumer), so a type error in archive-export,
// jev-shadow, kap-ingest or quotes-ingest (each holds the service-role key or a
// provider key) only surfaced at deploy. One step loops over every folder.
describe("ci.yml type-checks every edge function", () => {
  const ci = readFileSync(resolve(WORKFLOWS, "ci.yml"), "utf8");
  const functions = readdirSync(resolve(ROOT, "supabase", "functions"), { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(resolve(ROOT, "supabase", "functions", d.name, "index.ts")))
    .map((d) => d.name);

  it("there are the 7 functions the loop must cover (the sweep is not blind)", () => {
    expect(functions).toEqual(
      expect.arrayContaining([
        "archive-export",
        "cluster-consumer",
        "image-consumer",
        "ingest",
        "jev-shadow",
        "kap-ingest",
        "quotes-ingest",
      ]),
    );
  });

  it("loops over supabase/functions/*/index.ts instead of listing functions by hand", () => {
    expect(ci).toContain("supabase/functions/*/index.ts");
    for (const fn of functions) expect(ci, `ci.yml must not hard-code ${fn}`).not.toContain(`supabase/functions/${fn}`);
  });

  it("fails the job on the first error, checks each function from its own folder and without a lockfile", () => {
    const script = ci.slice(ci.indexOf("supabase/functions/*/index.ts"));
    expect(ci).toContain("set -euo pipefail");
    expect(script).toContain("cd ");
    expect(script).toContain("deno check --no-lock index.ts");
  });

  it("names each function it checks in the log", () => {
    expect(ci).toContain('echo "deno check: $name"');
  });
});

describe("the guard's own helpers", () => {
  it("reads flow and block style path lists", () => {
    expect(pathsOf(["    paths: [package.json, package-lock.json]"])).toEqual([
      "package.json",
      "package-lock.json",
    ]);
    expect(
      pathsOf(["    branches: [main]", "    paths:", "      - package.json", '      - "package-lock.json"']),
    ).toEqual(["package.json", "package-lock.json"]);
    expect(pathsOf(["    branches: [main]"])).toEqual([]);
  });

  it("does not mistake package-lock.json for package.json", () => {
    expect(pathsOf(["    paths: [package-lock.json]"])).not.toContain("package.json");
  });

  it("scopes a block to its own indentation", () => {
    const sample = codeLines(
      ["on:", "  push:", "    paths: [a]", "  pull_request:", "    paths: [b]", "jobs:", "  x:"].join("\n"),
    );
    expect(blockOf(sample, "push", 2)).toEqual(["    paths: [a]"]);
    expect(blockOf(sample, "pull_request", 2)).toEqual(["    paths: [b]"]);
    expect(blockOf(sample, "missing", 2)).toEqual([]);
  });

  it("finds the step that holds a checkout and its options", () => {
    const sample = codeLines(
      [
        "    steps:",
        "      - uses: actions/checkout@abc",
        "        with:",
        "          persist-credentials: false",
        "      - run: echo hi",
      ].join("\n"),
    );
    const steps = stepsUsing(sample, "actions/checkout");
    expect(steps).toHaveLength(1);
    expect((steps[0] as string[]).some((l) => l.trim() === "persist-credentials: false")).toBe(true);
    const bare = codeLines(["      - uses: actions/checkout@abc", "      - run: echo hi"].join("\n"));
    expect((stepsUsing(bare, "actions/checkout")[0] as string[]).some((l) => l.includes("persist-credentials"))).toBe(
      false,
    );
  });
});
