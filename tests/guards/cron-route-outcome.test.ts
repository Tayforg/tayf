import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (h12-ops-1, ops heartbeat): every /api/cron/<name> route
// must record its outcome through withCronOutcome("<name>", ...). On
// 2026-10-31/11-01 the headline cron answered 500 for 18+ hours (189 statement
// timeouts) and nothing alerted, because ops_health_report() only read the
// database. ops_health_report() row 15 (cron_route_failures_30m, migration 136)
// reads public.ops_cron_route_runs, which only the wrapper fills; a new cron
// route added without it would be invisible to the heartbeat again.
//
// Per route: `export const GET = withCronOutcome("<its folder name>",` and an
// import from "@/lib/ops/cron-route-outcome". The literal must equal the folder
// name (the table check is route ~ '^[a-z0-9-]{1,40}$', and the doc/alert text
// names the route by it). No HTTP method may be exported any other way.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const CRON_DIR = resolve(here, "../../src/app/api/cron");
const WRAPPER_MODULE = "@/lib/ops/cron-route-outcome";
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const;

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Every `<folder>/route.ts` directly under src/app/api/cron. */
function cronRoutes(): Array<{ folder: string; file: string }> {
  return readdirSync(CRON_DIR)
    .filter((name) => statSync(join(CRON_DIR, name)).isDirectory())
    .map((folder) => ({ folder, file: join(CRON_DIR, folder, "route.ts") }))
    .filter((r) => existsSync(r.file));
}

/** Violations of the contract for one route source; empty means compliant. */
function violations(folder: string, source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];

  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\bwithCronOutcome\\b[^}]*\\}\\s*from\\s*["']${WRAPPER_MODULE.replace(/[/@]/g, "\\$&")}["']`,
  );
  if (!importRe.test(code)) out.push(`does not import withCronOutcome from ${WRAPPER_MODULE}`);

  const wrapRe = new RegExp(`export\\s+const\\s+GET\\s*=\\s*withCronOutcome\\(\\s*["']${folder}["']\\s*,`);
  if (!wrapRe.test(code)) out.push(`GET is not \`export const GET = withCronOutcome("${folder}", ...)\``);

  for (const method of METHODS) {
    if (method === "GET") {
      if (new RegExp(`export\\s+(?:async\\s+)?function\\s+GET\\b`).test(code)) {
        out.push("GET is exported as a function declaration, bypassing the wrapper");
      }
      continue;
    }
    if (new RegExp(`export\\s+(?:async\\s+)?function\\s+${method}\\b`).test(code)) {
      out.push(`${method} is exported without the wrapper`);
    }
    const constRe = new RegExp(`export\\s+const\\s+${method}\\s*=\\s*(?!withCronOutcome\\()`);
    if (constRe.test(code)) out.push(`${method} is exported without the wrapper`);
  }
  return out;
}

describe("every /api/cron route records its outcome (h12-ops-1)", () => {
  const routes = cronRoutes();

  it("is not vacuous: the five known cron routes are all found", () => {
    expect(routes.map((r) => r.folder).sort()).toEqual(
      expect.arrayContaining(["alerts-webhooks", "digest", "fact-checks", "headline", "social"]),
    );
    expect(routes.length).toBeGreaterThanOrEqual(5);
  });

  it("the wrapper module exists and exports withCronOutcome and the timeout constant", () => {
    const file = resolve(here, "../../src/lib/ops/cron-route-outcome.ts");
    expect(existsSync(file)).toBe(true);
    const code = blankComments(readFileSync(file, "utf8"));
    expect(code).toMatch(/export\s+function\s+withCronOutcome\b/);
    expect(code).toMatch(/export\s+const\s+CRON_OUTCOME_TIMEOUT_MS\s*=\s*2000\b/);
  });

  for (const { folder, file } of routes) {
    it(`${folder}: export const GET = withCronOutcome("${folder}", ...) and the import`, () => {
      expect(violations(folder, readFileSync(file, "utf8")), `src/app/api/cron/${folder}/route.ts`).toEqual([]);
    });
  }

  it("the wrapper is the OUTER layer: it wraps withApiErrors, not the other way round", () => {
    // withApiErrors turns a throw into a 500 response. Outermost, withCronOutcome sees that 500 as a
    // status; innermost, a thrown error would reach the wrapper only for framework control-flow signals.
    for (const { folder, file } of routes) {
      const code = blankComments(readFileSync(file, "utf8"));
      const wrapRe = new RegExp(`export\\s+const\\s+GET\\s*=\\s*withCronOutcome\\(\\s*["']${folder}["']\\s*,\\s*withApiErrors\\(`);
      expect(wrapRe.test(code), folder).toBe(true);
    }
  });

  describe("the finder itself (mutation checks on synthetic sources)", () => {
    const good = `import { withCronOutcome } from "@/lib/ops/cron-route-outcome";
import { withApiErrors } from "@/lib/api/errors";
export const GET = withCronOutcome("headline", withApiErrors(async (request: Request) => new Response("ok")));
`;

    it("accepts a compliant route", () => {
      expect(violations("headline", good)).toEqual([]);
    });

    it("flags a bare withApiErrors GET", () => {
      const bad = good.replace(
        'withCronOutcome("headline", withApiErrors(async (request: Request) => new Response("ok")))',
        'withApiErrors(async (request: Request) => new Response("ok"))',
      );
      expect(violations("headline", bad)).toEqual(
        expect.arrayContaining([expect.stringContaining("GET is not")]),
      );
    });

    it("flags a missing import", () => {
      expect(violations("headline", good.split("\n").slice(1).join("\n"))).toEqual(
        expect.arrayContaining([expect.stringContaining("does not import")]),
      );
    });

    it("flags a literal that differs from the folder name", () => {
      expect(violations("digest", good)).toEqual(expect.arrayContaining([expect.stringContaining("GET is not")]));
    });

    it("flags a wrapper that only appears in a comment", () => {
      const bad = `// export const GET = withCronOutcome("headline", x);
// import { withCronOutcome } from "@/lib/ops/cron-route-outcome";
export const GET = async () => new Response("ok");
`;
      expect(violations("headline", bad).length).toBeGreaterThanOrEqual(2);
    });

    it("flags an unwrapped POST and a function-declaration GET", () => {
      expect(violations("headline", `${good}export const POST = withApiErrors(async () => new Response("x"));\n`)).toEqual(
        expect.arrayContaining(["POST is exported without the wrapper"]),
      );
      expect(violations("headline", `${good}export async function PUT() { return new Response("x"); }\n`)).toEqual(
        expect.arrayContaining(["PUT is exported without the wrapper"]),
      );
      expect(violations("headline", `${good}export async function GET() { return new Response("x"); }\n`)).toEqual(
        expect.arrayContaining([expect.stringContaining("function declaration")]),
      );
    });
  });
});
