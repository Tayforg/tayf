import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// h27-supply-1: every GitHub Action in .github/workflows ran on a mutable ref
// (`actions/checkout@v7` is a tag its owner can move; `denoland/setup-deno@v2`
// is a BRANCH). A moved tag runs attacker code in a job that, for
// cluster-audit.yml and ops-heartbeat.yml, holds the service-role key.
//
// Plain-text guard (no YAML parser dependency, same approach as
// ops-heartbeat-workflow.test.ts) over EVERY workflow file:
//   (i)   each `uses:` (except ./local and docker://) is
//         `owner/repo[/path]@<40 lowercase hex>` followed by a trailing
//         `# vN[.N[.N]]` comment, so a human (and Dependabot) can read the pin;
//   (ii)  no workflow triggers on pull_request_target (it runs with secrets on
//         code from a fork);
//   (iii) the GITHUB_TOKEN is scoped: top-level `permissions:` or one in every
//         job;
//   (iv)  a workflow that references `secrets.` never runs `npm ci` without
//         --ignore-scripts (a dependency's install script would run next to
//         the secret) and every actions/checkout in it sets
//         `persist-credentials: false`.
//
// The pins are refreshed by Dependabot's github-actions entry
// (.github/dependabot.yml), which also rewrites the `# vX` comment.
// ---------------------------------------------------------------------------

const ROOT = resolve(__dirname, "..", "..");
const DIR = resolve(ROOT, ".github", "workflows");

// --- plain-text helpers (character/line scans, no backtracking patterns) ----

function indentOf(line: string): number {
  let n = 0;
  while (n < line.length && line[n] === " ") n++;
  return n;
}

function isBlankOrComment(line: string): boolean {
  const t = line.trim();
  return t === "" || t.startsWith("#");
}

function codeLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => !isBlankOrComment(l));
}

/** The value after `key:` on a step line (`- key: v` or `key: v`), or null. */
function stepValue(line: string, key: string): string | null {
  const t = line.trim();
  const body = t.startsWith("- ") ? t.slice(2).trim() : t;
  return body.startsWith(`${key}:`) ? body.slice(key.length + 1).trim() : null;
}

const isLowerHex = (s: string): boolean => {
  for (const ch of s) {
    const ok = (ch >= "0" && ch <= "9") || (ch >= "a" && ch <= "f");
    if (!ok) return false;
  }
  return s.length > 0;
};

const isDigits = (s: string): boolean => {
  if (s === "") return false;
  for (const ch of s) if (ch < "0" || ch > "9") return false;
  return true;
};

/** `v7`, `v7.0`, `v7.0.1` -- and nothing else. */
function isVersionComment(comment: string): boolean {
  if (!comment.startsWith("v")) return false;
  const parts = comment.slice(1).split(".");
  return parts.length >= 1 && parts.length <= 3 && parts.every(isDigits);
}

/** One path segment of an `owner/repo/path` action reference. */
function isNameSegment(s: string): boolean {
  if (s === "") return false;
  for (const ch of s) {
    const ok =
      (ch >= "a" && ch <= "z") ||
      (ch >= "A" && ch <= "Z") ||
      (ch >= "0" && ch <= "9") ||
      ch === "-" ||
      ch === "_" ||
      ch === ".";
    if (!ok) return false;
  }
  return true;
}

/**
 * Why a `uses:` value (the text after `uses:`, comment included) is not an
 * acceptable pin; null when it is. Local actions and docker:// are out of scope.
 */
function usesProblem(value: string): string | null {
  if (value.startsWith("./") || value.startsWith("docker://")) return null;
  const hash = value.indexOf("#");
  const ref = (hash === -1 ? value : value.slice(0, hash)).trim();
  const comment = hash === -1 ? null : value.slice(hash + 1).trim();

  const at = ref.indexOf("@");
  if (at === -1) return `no @ref: ${ref}`;
  const path = ref.slice(0, at);
  const sha = ref.slice(at + 1);
  const segments = path.split("/");
  if (segments.length < 2 || !segments.every(isNameSegment)) return `not owner/repo[/path]: ${path}`;
  if (sha.length !== 40 || !isLowerHex(sha)) return `ref is not a 40-char lowercase commit SHA: @${sha}`;
  if (comment === null) return `no trailing "# vX.Y.Z" comment: ${ref}`;
  if (!isVersionComment(comment)) return `trailing comment is not "# vN[.N[.N]]": # ${comment}`;
  return null;
}

interface Uses {
  line: number;
  value: string;
}

/** Every `uses:` step line of a workflow (whole-line comments are skipped). */
function usesOf(text: string): Uses[] {
  const out: Uses[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (isBlankOrComment(raw)) return;
    const value = stepValue(raw, "uses");
    if (value !== null) out.push({ line: i + 1, value });
  });
  return out;
}

/** Lines of the job blocks under `jobs:` keyed by job id. */
function jobsOf(text: string): Map<string, string[]> {
  const lines = codeLines(text);
  const at = lines.findIndex((l) => l === "jobs:");
  const jobs = new Map<string, string[]>();
  if (at === -1) return jobs;
  let current: string | null = null;
  for (let i = at + 1; i < lines.length; i++) {
    const line = lines[i] as string;
    if (indentOf(line) === 0) break;
    if (indentOf(line) === 2 && line.trim().endsWith(":")) {
      current = line.trim().slice(0, -1);
      jobs.set(current, []);
    } else if (current !== null) {
      (jobs.get(current) as string[]).push(line);
    }
  }
  return jobs;
}

/** True when the GITHUB_TOKEN is scoped at the top level or in every job. */
function permissionsScoped(text: string): boolean {
  const lines = codeLines(text);
  if (lines.some((l) => indentOf(l) === 0 && l.startsWith("permissions:"))) return true;
  const jobs = jobsOf(text);
  if (jobs.size === 0) return false;
  for (const body of jobs.values()) {
    if (!body.some((l) => indentOf(l) === 4 && l.trim().startsWith("permissions:"))) return false;
  }
  return true;
}

/** `run:` commands that install with npm ci / npm install and lack --ignore-scripts. */
function scriptRunningInstalls(text: string): string[] {
  const out: string[] = [];
  for (const raw of codeLines(text)) {
    const cmd = stepValue(raw, "run");
    if (cmd === null) continue;
    const installs = cmd.includes("npm ci") || cmd.includes("npm install") || cmd.includes("npm i ");
    if (installs && !cmd.includes("--ignore-scripts")) out.push(cmd);
  }
  return out;
}

/** Checkout steps (by 1-based `uses:` line) that do not set persist-credentials: false. */
function credentialPersistingCheckouts(text: string): number[] {
  const lines = text.split(/\r?\n/);
  const bad: number[] = [];
  lines.forEach((raw, i) => {
    if (isBlankOrComment(raw)) return;
    const value = stepValue(raw, "uses");
    if (value === null || !value.startsWith("actions/checkout@")) return;
    let start = i;
    while (start > 0 && !(lines[start] as string).trim().startsWith("- ")) start--;
    const stepIndent = indentOf(lines[start] as string);
    let end = i + 1;
    while (end < lines.length && (isBlankOrComment(lines[end] as string) || indentOf(lines[end] as string) > stepIndent)) {
      end++;
    }
    const step = lines.slice(start, end);
    if (!step.some((l) => l.trim() === "persist-credentials: false")) bad.push(i + 1);
  });
  return bad;
}

const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
  .sort();
const WORKFLOWS = FILES.map((name) => ({ name, text: readFileSync(resolve(DIR, name), "utf8") }));

describe("the sweep is not blind", () => {
  it("reads every workflow file", () => {
    expect(FILES).toEqual(
      expect.arrayContaining([
        "ci.yml",
        "cluster-audit.yml",
        "codeql.yml",
        "dep-audit.yml",
        "ops-heartbeat.yml",
        "page-latency.yml",
      ]),
    );
  });

  it("finds many `uses:` lines", () => {
    const total = WORKFLOWS.reduce((n, w) => n + usesOf(w.text).length, 0);
    expect(total).toBeGreaterThanOrEqual(12);
  });
});

describe("(i) every action is pinned to a commit SHA with a version comment", () => {
  it("lists no mutable or uncommented `uses:` ref (file:line: problem)", () => {
    const offenders: string[] = [];
    for (const w of WORKFLOWS) {
      for (const u of usesOf(w.text)) {
        const problem = usesProblem(u.value);
        if (problem !== null) offenders.push(`${w.name}:${u.line}: ${problem}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("pins the codeql init and analyze steps to the same commit", () => {
    const codeql = WORKFLOWS.find((w) => w.name === "codeql.yml");
    const shas = new Set(
      usesOf(codeql?.text ?? "")
        .filter((u) => u.value.startsWith("github/codeql-action/"))
        .map((u) => u.value.slice(u.value.indexOf("@") + 1, u.value.indexOf("@") + 41)),
    );
    expect(shas.size).toBe(1);
  });
});

describe("(ii) no workflow runs on pull_request_target", () => {
  it.each(WORKFLOWS.map((w) => [w.name, w.text]))("%s", (_name, text) => {
    expect(codeLines(text as string).filter((l) => l.includes("pull_request_target"))).toEqual([]);
  });
});

describe("(iii) the GITHUB_TOKEN is scoped in every workflow", () => {
  it.each(WORKFLOWS.map((w) => [w.name, w.text]))("%s declares permissions", (_name, text) => {
    expect(permissionsScoped(text as string)).toBe(true);
  });
});

describe("(iv) a workflow that sees secrets runs no dependency scripts and keeps no git credentials", () => {
  // A real reference is `${{ secrets.NAME }}` on a code line; prose in a comment
  // ("this job holds no secrets.") does not make a workflow secret-bearing.
  const withSecrets = WORKFLOWS.filter((w) => codeLines(w.text).some((l) => l.includes("secrets.")));

  it("finds the workflows that reference secrets (the sweep is not blind)", () => {
    expect(withSecrets.map((w) => w.name)).toEqual(expect.arrayContaining(["cluster-audit.yml", "ops-heartbeat.yml"]));
  });

  it.each(withSecrets.map((w) => [w.name, w.text]))("%s installs only with --ignore-scripts", (_name, text) => {
    expect(scriptRunningInstalls(text as string)).toEqual([]);
  });

  it.each(withSecrets.map((w) => [w.name, w.text]))(
    "%s checks out with persist-credentials: false",
    (_name, text) => {
      expect(credentialPersistingCheckouts(text as string)).toEqual([]);
    },
  );
});

describe("the guard's own matchers", () => {
  const SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";

  it.each([
    ["a major tag", "actions/checkout@v7 # v7"],
    ["a bare major tag", "actions/checkout@v7"],
    ["a branch", "actions/checkout@main # main"],
    ["a branch without comment", "denoland/setup-deno@v2"],
    ["a 39-char sha", `actions/checkout@${SHA.slice(0, 39)} # v7.0.1`],
    ["a 41-char sha", `actions/checkout@${SHA}0 # v7.0.1`],
    ["uppercase hex", `actions/checkout@${SHA.toUpperCase()} # v7.0.1`],
    ["a 40-char non-hex ref", `actions/checkout@${"g".repeat(40)} # v7.0.1`],
    ["a sha without any comment", `actions/checkout@${SHA}`],
    ["a sha with a non-version comment", `actions/checkout@${SHA} # latest`],
    ["a sha with a 4-part version", `actions/checkout@${SHA} # v7.0.1.2`],
    ["a sha with a bare number", `actions/checkout@${SHA} # 7.0.1`],
    ["no ref at all", "actions/checkout"],
    ["a one-segment name", `checkout@${SHA} # v7`],
    ["a quoted value", `"actions/checkout@${SHA}" # v7`],
  ])("rejects %s", (_label, value) => {
    expect(usesProblem(value)).not.toBeNull();
  });

  it.each([
    ["checkout", `actions/checkout@${SHA} # v7.0.1`],
    ["a codeql sub-action", `github/codeql-action/init@${SHA} # v4`],
    ["a major.minor comment", `actions/setup-node@${SHA} # v7.1`],
    ["a local action", "./.github/actions/thing"],
    ["a docker action", "docker://alpine:3.20"],
  ])("accepts %s", (_label, value) => {
    expect(usesProblem(value)).toBeNull();
  });

  it("extracts `- uses:` and `uses:` lines and skips commented ones", () => {
    const yaml = [
      "steps:",
      `  - uses: actions/checkout@${SHA} # v7.0.1`,
      "    # - uses: actions/setup-example@v1",
      "  - name: x",
      "    uses: ./local",
    ].join("\n");
    expect(usesOf(yaml).map((u) => u.value)).toEqual([`actions/checkout@${SHA} # v7.0.1`, "./local"]);
  });

  it("recognises top-level, per-job and missing permissions", () => {
    expect(permissionsScoped("permissions:\n  contents: read\njobs:\n  a:\n    steps: []")).toBe(true);
    expect(
      permissionsScoped("jobs:\n  a:\n    permissions:\n      contents: read\n  b:\n    permissions: {}\n"),
    ).toBe(true);
    expect(permissionsScoped("jobs:\n  a:\n    permissions:\n      contents: read\n  b:\n    steps: []\n")).toBe(false);
    expect(permissionsScoped("jobs:\n  a:\n    steps: []\n")).toBe(false);
  });

  it("flags npm installs that would run lifecycle scripts", () => {
    expect(scriptRunningInstalls("      - run: npm ci --no-audit")).toEqual(["npm ci --no-audit"]);
    expect(scriptRunningInstalls("      - run: npm ci --ignore-scripts --no-audit")).toEqual([]);
    expect(scriptRunningInstalls("      - run: node scripts/x.mjs")).toEqual([]);
  });

  it("flags a checkout that keeps the git credentials", () => {
    const keeps = ["steps:", `  - uses: actions/checkout@${SHA} # v7`, "  - run: echo hi"].join("\n");
    const drops = [
      "steps:",
      `  - uses: actions/checkout@${SHA} # v7`,
      "    with:",
      "      persist-credentials: false",
      "  - run: echo hi",
    ].join("\n");
    expect(credentialPersistingCheckouts(keeps)).toEqual([2]);
    expect(credentialPersistingCheckouts(drops)).toEqual([]);
  });
});
