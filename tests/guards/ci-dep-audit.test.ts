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
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const WORKFLOWS = resolve(ROOT, ".github", "workflows");
const AUDIT = resolve(WORKFLOWS, "dep-audit.yml");

const INSTALL = "npm ci --omit=dev --ignore-scripts --no-audit --no-fund";
const AUDIT_CMD = "npm audit --omit=dev --audit-level=high";
const STALE_CLAIM = "Dependabot + `npm audit` cover it";

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

  it("has a job with a timeout of 10 minutes or less", () => {
    const m = /timeout-minutes:\s*(\d+)/.exec(audit);
    expect(m).not.toBeNull();
    expect(Number((m as RegExpExecArray)[1])).toBeLessThanOrEqual(10);
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

  it.each(["pull_request", "push"])("%s is limited to package.json and package-lock.json changes", (event) => {
    const trigger = blockOf(lines, event, 2);
    expect(trigger.length).toBeGreaterThan(0);
    const paths = pathsOf(trigger);
    expect(paths).toContain("package.json");
    expect(paths).toContain("package-lock.json");
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
