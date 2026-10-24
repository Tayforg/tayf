import { describe, it, expect, beforeAll } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  FETCH_TIMEOUT_MS,
  MAX_SAMPLES,
  ROUTES,
} from "../../scripts/lib/page-latency.mjs";

// Reads .github/workflows/page-latency.yml as plain text (no YAML parser
// dependency, same approach as ops-heartbeat-workflow.test.ts) and pins the
// properties that keep the on-demand latency probe safe and cheap: it runs
// only on a manual dispatch, holds read-only permissions, needs no secrets
// and no `npm ci`, and the two dispatch inputs reach the script only through
// `env:` (never through a `run:` line, where `${{ inputs.* }}` would be shell
// injection).

const ROOT = resolve(__dirname, "..", "..");
const WORKFLOW = resolve(ROOT, ".github", "workflows", "page-latency.yml");
const HEARTBEAT = resolve(ROOT, ".github", "workflows", "ops-heartbeat.yml");
const DOCS = resolve(ROOT, "docs", "ops-heartbeat.md");

let yaml = "";
let heartbeatYaml = "";
let docs = "";
beforeAll(() => {
  yaml = readFileSync(WORKFLOW, "utf8");
  heartbeatYaml = readFileSync(HEARTBEAT, "utf8");
  docs = readFileSync(DOCS, "utf8");
});

function usesRefs(text: string): Set<string> {
  return new Set([...text.matchAll(/^\s*-?\s*uses:\s*(\S+)/gm)].map((m) => m[1] as string));
}

describe("page-latency.yml triggers", () => {
  it("runs on workflow_dispatch only", () => {
    expect(yaml).toMatch(/^\s*workflow_dispatch:/m);
    expect(yaml).not.toMatch(/schedule:/);
    expect(yaml).not.toMatch(/push:/);
    expect(yaml).not.toMatch(/pull_request/);
    expect(yaml).not.toMatch(/pull_request_target/);
  });

  it("is named Page Latency Probe and serializes runs without cancelling", () => {
    expect(yaml).toMatch(/^name: Page Latency Probe$/m);
    expect(yaml).toMatch(/concurrency:\s*\n\s*group:\s*page-latency\s*\n\s*cancel-in-progress:\s*false/);
  });

  it("takes base_url and samples inputs with their defaults", () => {
    expect(yaml).toMatch(/base_url:[\s\S]*?default:\s*"?https:\/\/www\.tayfhaber\.com"?/);
    expect(yaml).toMatch(/Origin to probe \(https:\/\/, or http:\/\/localhost\)/);
    expect(yaml).toMatch(/samples:[\s\S]*?default:\s*"3"/);
    expect(yaml).toMatch(/Sequential GETs per route \(1-5\)/);
  });
});

describe("page-latency.yml permissions and secrets", () => {
  it("has read-only contents permissions", () => {
    expect(yaml).toMatch(/permissions:\s*\n\s*contents:\s*read/);
  });

  it("references no secrets at all", () => {
    expect(yaml).not.toMatch(/secrets\./);
    expect(yaml).not.toMatch(/\bsecrets\b/i);
  });

  it("uses exactly the action refs the ops heartbeat pins", () => {
    const refs = usesRefs(yaml);
    expect(refs.size).toBeGreaterThan(0);
    expect(refs).toEqual(usesRefs(heartbeatYaml));
  });
});

describe("page-latency.yml steps", () => {
  it("runs node scripts/page-latency.mjs and never npm ci", () => {
    expect(yaml).toMatch(/run:\s*node\s+scripts\/page-latency\.mjs\s*$/m);
    expect(yaml).not.toMatch(/npm ci/);
  });

  it("has a single run line and no expression in it", () => {
    const runLines = yaml.split("\n").filter((l) => /^\s*(-\s*)?run:/.test(l));
    expect(runLines).toHaveLength(1);
    for (const line of runLines) expect(line).not.toContain("${{");
  });

  it("passes the inputs to the script only through env", () => {
    const expressions = [...yaml.matchAll(/\$\{\{\s*([^}]*?)\s*\}\}/g)].map((m) => m[1]);
    expect(new Set(expressions)).toEqual(new Set(["inputs.base_url", "inputs.samples"]));
    expect(yaml).toMatch(/env:\s*\n\s*PROBE_BASE_URL:\s*\$\{\{\s*inputs\.base_url\s*\}\}\s*\n\s*PROBE_SAMPLES:\s*\$\{\{\s*inputs\.samples\s*\}\}/);
  });

  it("has a job timeout of 20 minutes or less that covers the worst case", () => {
    const m = /timeout-minutes:\s*(\d+)/.exec(yaml);
    expect(m).not.toBeNull();
    const minutes = Number((m as RegExpExecArray)[1]);
    expect(minutes).toBeLessThanOrEqual(20);
    // every request timing out, on every route, at the maximum sample count
    const worstCaseMinutes = (MAX_SAMPLES * ROUTES.length * FETCH_TIMEOUT_MS) / 60_000;
    expect(worstCaseMinutes).toBeLessThanOrEqual(minutes);
  });
});

describe("route drift guard", () => {
  it.each([...ROUTES])("%s still has a page or route handler", (route: string) => {
    const segment = route === "/" ? "" : route.slice(1);
    const candidates =
      segment === ""
        ? [resolve(ROOT, "src", "app", "page.tsx")]
        : [
            resolve(ROOT, "src", "app", segment, "page.tsx"),
            resolve(ROOT, "src", "app", segment, "route.ts"),
          ];
    expect(candidates.some((p) => existsSync(p))).toBe(true);
  });
});

describe("docs/ops-heartbeat.md page latency section", () => {
  const flat = () => docs.replace(/\s+/g, " ");

  it("has the Page latency probe heading", () => {
    expect(docs).toMatch(/^## Page latency probe$/m);
  });

  it("states that the probe does not force a cold data-cache fill", () => {
    expect(docs).toContain("does not force a cold data-cache fill");
    expect(flat()).toContain(
      "It measures what a visitor gets (CDN and data cache included) and does not force a cold data-cache fill: there is no cache-busting query string, so an x-vercel-cache HIT can hide a cold database. A MISS at 8 s or more is the 2026-10-21 signature.",
    );
  });

  it("names every probed route", () => {
    const section = docs.slice(docs.indexOf("## Page latency probe"));
    for (const route of ROUTES) expect(section).toContain(`\`${route}\``);
  });

  it("gives the manual workflow name and the local command", () => {
    const section = docs.slice(docs.indexOf("## Page latency probe"));
    expect(section).toContain("Page Latency Probe");
    expect(section).toContain(
      "PROBE_BASE_URL=https://www.tayfhaber.com PROBE_SAMPLES=2 node scripts/page-latency.mjs",
    );
  });
});
