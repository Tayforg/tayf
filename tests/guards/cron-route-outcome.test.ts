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

/** Escapes every RegExp metacharacter so a literal string can be embedded in a pattern. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Violations of the contract for one route source; empty means compliant. */
function violations(folder: string, source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];

  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\bwithCronOutcome\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(WRAPPER_MODULE)}["']`,
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

// ---------------------------------------------------------------------------
// h18-jobs-1: a cron route that swallows a failed database call and answers 200
// must say so, or the heartbeat stays green. On 2026-11-01 23:15-23:55 UTC the
// headline re-pick RPC failed with 42501 on 9 ticks in a row; the route logged
// it and answered 200, withCronOutcome recorded 200, and ops_health_report row
// 15 (status >= 500) saw nothing. The route now sets the internal header
// x-cron-substep-errors, and withCronOutcome records 599 and strips the header.
// The runtime behaviour is pinned in tests/lib/ops/cron-route-outcome.test.ts and
// tests/api/cron-headline-extractive-repick.test.ts; these guards pin the wiring
// that a refactor could drop without a type error.
// ---------------------------------------------------------------------------

const HEADLINE_ROUTE = resolve(CRON_DIR, "headline/route.ts");
const WRAPPER_FILE = resolve(here, "../../src/lib/ops/cron-route-outcome.ts");

/** The `{ ... }` block opening at `openIndex`, braces balanced; unterminated input returns the rest. */
function blockAt(code: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < code.length; i++) {
    const ch = code[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return code.slice(openIndex, i + 1);
    }
  }
  return code.slice(openIndex);
}

/** Every block of `if (<name>) { ... }` in the source, in order. */
function ifBlocks(code: string, name: string): string[] {
  const opener = `if (${name}) {`;
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const at = code.indexOf(opener, from);
    if (at === -1) return out;
    out.push(blockAt(code, at + opener.length - 1));
    from = at + opener.length;
  }
}

const COUNTS_A_SUBSTEP = /\bsubstepErrors(?:\+\+|\s*\+=\s*1\b)/;

/**
 * The swallowed database failures of the headline route: the `if (<name>) {`
 * branches that log, capture and carry on with a 200. `min` is how many such
 * branches the route has (so deleting one cannot leave the guard vacuous).
 * Not listed on purpose: LLM vendor failures, empty or rejected rewrites, pick
 * throws, revalidateTag and the budget helpers.
 */
const SWALLOWED_BRANCHES: Array<{ name: string; min: number }> = [
  { name: "memberErr", min: 2 }, // the IS NULL pass and the re-pick pass
  { name: "writeErr", min: 4 }, // extractive fallback, llm write, IS NULL write, re-pick write
  { name: "rejectErr", min: 1 }, // the rejected-rewrite mark
  { name: "repickErr", min: 1 }, // neutral_title_repick_candidates
];

/** Violations of the sub-step contract for one route source; empty means compliant. */
function substepViolations(source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];

  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\bCRON_SUBSTEP_ERRORS_HEADER\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(WRAPPER_MODULE)}["']`,
  );
  if (!importRe.test(code)) out.push(`does not import CRON_SUBSTEP_ERRORS_HEADER from ${WRAPPER_MODULE}`);

  const declared = code.indexOf("let substepErrors = 0;");
  const closure = code.indexOf("const noCandidates");
  if (declared === -1) out.push("substepErrors is not declared with `let substepErrors = 0;`");
  else if (closure !== -1 && declared > closure) out.push("substepErrors is declared after the noCandidates closure");

  for (const { name, min } of SWALLOWED_BRANCHES) {
    const blocks = ifBlocks(code, name);
    if (blocks.length < min) out.push(`expected at least ${min} \`if (${name}) {\` branches, found ${blocks.length}`);
    blocks.forEach((block, i) => {
      if (!COUNTS_A_SUBSTEP.test(block)) out.push(`\`if (${name}) {\` branch ${i + 1} does not count a substepErrors`);
    });
  }

  // Both bodies that can end a run with swallowed failures carry the header: the no-candidates body and the final body.
  const initCalls = code.split("substepInit()").length - 1;
  if (initCalls !== 2) out.push(`expected substepInit() in exactly 2 responses, found ${initCalls}`);
  return out;
}

describe("sub-step failures are reported by the cron routes (h18-jobs-1)", () => {
  it("the wrapper module exports the 599 status, the header name and substepErrorCount", () => {
    const code = blankComments(readFileSync(WRAPPER_FILE, "utf8"));
    expect(code).toMatch(/export\s+const\s+CRON_SUBSTEP_FAILURE_STATUS\s*=\s*599\b/);
    expect(code).toMatch(/export\s+const\s+CRON_SUBSTEP_ERRORS_HEADER\s*=\s*["']x-cron-substep-errors["']/);
    expect(code).toMatch(/export\s+function\s+substepErrorCount\b/);
  });

  it("the headline route imports CRON_SUBSTEP_ERRORS_HEADER from the wrapper module", () => {
    const code = blankComments(readFileSync(HEADLINE_ROUTE, "utf8"));
    const importRe = new RegExp(
      `import\\s*\\{[^}]*\\bCRON_SUBSTEP_ERRORS_HEADER\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(WRAPPER_MODULE)}["']`,
    );
    expect(importRe.test(code)).toBe(true);
  });

  it("the `if (repickErr) {` block counts a sub-step failure", () => {
    const code = blankComments(readFileSync(HEADLINE_ROUTE, "utf8"));
    const start = code.indexOf("if (repickErr) {");
    expect(start).toBeGreaterThan(-1);
    const end = code.indexOf("} else {", start);
    expect(end).toBeGreaterThan(start);
    expect(code.slice(start, end)).toContain("substepErrors");
  });

  it("every swallowed database failure of the headline route is counted, and both bodies carry the header", () => {
    expect(substepViolations(readFileSync(HEADLINE_ROUTE, "utf8"))).toEqual([]);
  });

  describe("the finder itself (mutation checks on synthetic sources)", () => {
    // Built from lines, so each mutation swaps a whole line (no string-pattern replace).
    const goodLines = [
      'import { CRON_SUBSTEP_ERRORS_HEADER, withCronOutcome } from "@/lib/ops/cron-route-outcome";',
      "let substepErrors = 0;",
      "const substepInit = () => undefined;",
      "const noCandidates = () => NextResponse.json({}, substepInit());",
      "if (memberErr) { log(1); substepErrors++; }",
      "if (memberErr) { log(2); substepErrors++; }",
      "if (writeErr) { log(3); substepErrors++; }",
      "if (writeErr) { log(4); substepErrors++; }",
      "if (writeErr) { log(5); substepErrors++; }",
      "if (writeErr) { log(6); substepErrors++; }",
      "if (rejectErr) { log(7); substepErrors++; }",
      "if (repickErr) { log(8); substepErrors++; } else { work(); }",
      "return NextResponse.json({}, substepInit());",
    ];
    const build = (lines: string[]): string => `${lines.join("\n")}\n`;
    const good = build(goodLines);

    it("accepts a compliant source", () => {
      expect(substepViolations(good)).toEqual([]);
    });

    it("flags a branch that does not count", () => {
      const bad = build(goodLines.map((l) => (l.startsWith("if (repickErr)") ? "if (repickErr) { log(8); } else { work(); }" : l)));
      expect(substepViolations(bad)).toEqual([expect.stringContaining("repickErr")]);
    });

    it("flags a missing branch (fewer than the route has)", () => {
      const bad = build(goodLines.filter((l) => !l.startsWith("if (rejectErr)")));
      expect(substepViolations(bad)).toEqual([expect.stringContaining("rejectErr")]);
    });

    it("flags a counter that only appears in a comment", () => {
      const bad = build(goodLines.map((l) => (l === "if (memberErr) { log(1); substepErrors++; }" ? "if (memberErr) { log(1); /* substepErrors++ */ }" : l)));
      expect(substepViolations(bad)).toEqual([expect.stringContaining("memberErr")]);
    });

    it("flags a missing import", () => {
      expect(substepViolations(build(goodLines.slice(1)))).toEqual(
        expect.arrayContaining([expect.stringContaining("does not import")]),
      );
    });

    it("flags a declaration after the noCandidates closure", () => {
      const late = build(
        goodLines
          .filter((l) => l !== "let substepErrors = 0;")
          .flatMap((l) => (l.startsWith("const noCandidates") ? [l, "let substepErrors = 0;"] : [l])),
      );
      expect(substepViolations(late)).toEqual(["substepErrors is declared after the noCandidates closure"]);
    });

    it("flags a body without the header", () => {
      const bare = build(goodLines.map((l) => (l.startsWith("return NextResponse.json") ? "return NextResponse.json({});" : l)));
      expect(substepViolations(bare)).toEqual([expect.stringContaining("exactly 2")]);
    });
  });
});

// ---------------------------------------------------------------------------
// W3 (hunt-23/24 follow-ups): the other four cron routes report swallowed
// database failures too. fact-checks, alerts-webhooks, social and digest used to
// log a failed read or write and answer 200 with a success flag, so a run that
// lost its writes looked healthy to Vercel and to ops_health_report row 15. They
// now count each swallowed DATABASE or RPC failure in `substepErrors`, answer
// 200 with `substepErrors: <n>` and a success flag of `substepErrors === 0` in the
// body, and build the response init with substepErrorsInit() so the wrapper
// records 599 (docs of the header: src/lib/ops/cron-route-outcome.ts).
//
// Counted: Supabase reads and writes and RPCs. Not counted, on purpose: vendor and
// external failures (fact-check feed fetches, Telegram and Bluesky posts, Resend
// sends, webhook POSTs), like the headline rule above.
//
// Each counted branch is written exactly `if (<name>) { ... substepErrors++ ... }`
// with braces, because this finder (ifBlocks) matches that shape; a one-line
// `if (x) console.warn(...)` or a merged `if (a || b)` would escape it.
// ---------------------------------------------------------------------------

interface RouteSubstepSpec {
  folder: string;
  /** `if (<name>) {` branches: each must count a substepErrors, and there must be at least this many. */
  branches: Record<string, number>;
  /** The exact number of `substepErrorsInit(substepErrors` calls (one per response that can end a degraded run). */
  initCalls: number;
  /** Source text that must occur exactly `count` times (code only, comments blanked). */
  literals?: Array<{ text: string; count: number }>;
}

const ROUTE_SUBSTEP_SPECS: RouteSubstepSpec[] = [
  {
    folder: "fact-checks",
    // cluster search, member titles, existing-links read, promote update, new-links upsert
    branches: { clusterErr: 1, memberErr: 1, existingErr: 1, promoteErr: 1, insertErr: 1 },
    initCalls: 1,
  },
  {
    folder: "alerts-webhooks",
    // fresh blindspot re-read, enqueue upsert, exhausted-delivery update, unknown-keys read,
    // delivery-outcome update, webhook-health update
    branches: { freshError: 1, upsertError: 1, exhaustedError: 1, extraError: 1, updateError: 1, hookUpdateError: 1 },
    initCalls: 1,
  },
  {
    folder: "social",
    // fresh re-read, ledger read (fail closed), claim rpc, social_post_finish (through one local helper)
    branches: { freshError: 1, ledgerError: 1, claimError: 1, finishError: 1 },
    // the "ledger unavailable" skip, the dry-run body and the final body
    initCalls: 3,
    literals: [{ text: '"social_post_finish"', count: 1 }],
  },
  {
    folder: "digest",
    // last_sent_at write after a send, and the rights-gated summary member lookup
    branches: { updateError: 1, memberLookupFailed: 1 },
    initCalls: 1,
  },
];

const INIT_CALL_MARKER = "substepErrorsInit(substepErrors";

/** Violations of the W3 sub-step contract for one route source; empty means compliant. */
function routeSubstepViolations(spec: RouteSubstepSpec, source: string): string[] {
  const code = blankComments(source);
  const out: string[] = [];

  const importRe = new RegExp(
    `import\\s*\\{[^}]*\\b(?:substepErrorsInit|CRON_SUBSTEP_ERRORS_HEADER)\\b[^}]*\\}\\s*from\\s*["']${escapeRegExp(WRAPPER_MODULE)}["']`,
  );
  if (!importRe.test(code)) out.push(`does not import substepErrorsInit from ${WRAPPER_MODULE}`);

  if (!code.includes("let substepErrors = 0;")) out.push("substepErrors is not declared with `let substepErrors = 0;`");

  for (const [name, min] of Object.entries(spec.branches)) {
    const blocks = ifBlocks(code, name);
    if (blocks.length < min) out.push(`expected at least ${min} \`if (${name}) {\` branches, found ${blocks.length}`);
    blocks.forEach((block, i) => {
      if (!COUNTS_A_SUBSTEP.test(block)) out.push(`\`if (${name}) {\` branch ${i + 1} does not count a substepErrors`);
    });
  }

  const initCalls = code.split(INIT_CALL_MARKER).length - 1;
  if (initCalls !== spec.initCalls) {
    out.push(`expected ${INIT_CALL_MARKER} in exactly ${spec.initCalls} responses, found ${initCalls}`);
  }

  for (const { text, count } of spec.literals ?? []) {
    const found = code.split(text).length - 1;
    if (found !== count) out.push(`expected ${text} exactly ${count} time(s), found ${found}`);
  }
  return out;
}

describe("fact-checks, alerts-webhooks, social and digest report swallowed database failures (W3)", () => {
  it("the wrapper module exports substepErrorsInit", () => {
    const code = blankComments(readFileSync(WRAPPER_FILE, "utf8"));
    expect(code).toMatch(/export\s+function\s+substepErrorsInit\b/);
  });

  it("is not vacuous: the four routes exist", () => {
    for (const { folder } of ROUTE_SUBSTEP_SPECS) {
      expect(existsSync(resolve(CRON_DIR, folder, "route.ts")), folder).toBe(true);
    }
    expect(ROUTE_SUBSTEP_SPECS.map((s) => s.folder).sort()).toEqual(["alerts-webhooks", "digest", "fact-checks", "social"]);
  });

  for (const spec of ROUTE_SUBSTEP_SPECS) {
    it(`${spec.folder}: every swallowed database failure is counted and the response carries the header`, () => {
      const file = resolve(CRON_DIR, spec.folder, "route.ts");
      expect(routeSubstepViolations(spec, readFileSync(file, "utf8")), `src/app/api/cron/${spec.folder}/route.ts`).toEqual([]);
    });
  }

  it("the route table counts the branches the spec names", () => {
    const byFolder = Object.fromEntries(ROUTE_SUBSTEP_SPECS.map((s) => [s.folder, Object.keys(s.branches).sort()]));
    expect(byFolder).toEqual({
      "fact-checks": ["clusterErr", "existingErr", "insertErr", "memberErr", "promoteErr"],
      "alerts-webhooks": ["exhaustedError", "extraError", "freshError", "hookUpdateError", "updateError", "upsertError"],
      social: ["claimError", "freshError", "finishError", "ledgerError"].sort(),
      digest: ["memberLookupFailed", "updateError"],
    });
  });

  describe("the finder itself (mutation checks on synthetic sources)", () => {
    const spec: RouteSubstepSpec = {
      folder: "demo",
      branches: { aErr: 1, bErr: 2 },
      initCalls: 1,
      literals: [{ text: '"only_once"', count: 1 }],
    };
    // Built from lines, so each mutation swaps a whole line (no string-pattern replace).
    const goodLines = [
      'import { substepErrorsInit, withCronOutcome } from "@/lib/ops/cron-route-outcome";',
      "let substepErrors = 0;",
      'run("only_once");',
      "if (aErr) { log(1); substepErrors++; }",
      "if (bErr) { log(2); substepErrors += 1; }",
      "if (bErr) { log(3); substepErrors++; }",
      "return NextResponse.json({ ok: substepErrors === 0, substepErrors }, substepErrorsInit(substepErrors));",
    ];
    const build = (lines: string[]): string => `${lines.join("\n")}\n`;
    const swap = (from: string, to: string[]): string[] => goodLines.flatMap((l) => (l === from ? to : [l]));
    const good = build(goodLines);

    it("accepts a compliant source", () => {
      expect(routeSubstepViolations(spec, good)).toEqual([]);
    });

    it("accepts the header constant as the import", () => {
      const lines = swap(goodLines[0]!, ['import { CRON_SUBSTEP_ERRORS_HEADER } from "@/lib/ops/cron-route-outcome";']);
      expect(routeSubstepViolations(spec, build(lines))).toEqual([]);
    });

    it("flags a branch that does not count", () => {
      const bad = build(swap("if (aErr) { log(1); substepErrors++; }", ["if (aErr) { log(1); }"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("aErr")]);
    });

    it("flags the second of two branches of the same name when only it does not count", () => {
      const bad = build(swap("if (bErr) { log(3); substepErrors++; }", ["if (bErr) { log(3); }"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("branch 2")]);
    });

    it("flags a missing branch (fewer than the route has)", () => {
      const bad = build(swap("if (bErr) { log(3); substepErrors++; }", []));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("bErr")]);
    });

    it("flags a one-line branch without braces", () => {
      const bad = build(swap("if (aErr) { log(1); substepErrors++; }", ["if (aErr) log(1);", "substepErrors++;"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("expected at least 1 `if (aErr) {`")]);
    });

    it("flags a merged condition (the finder matches `if (<name>) {` only)", () => {
      const bad = build(swap("if (aErr) { log(1); substepErrors++; }", ["if (aErr || other) { log(1); substepErrors++; }"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("aErr")]);
    });

    it("flags a counter that sits outside the branch (in the else)", () => {
      const bad = build(swap("if (aErr) { log(1); substepErrors++; }", ["if (aErr) { log(1); } else { substepErrors++; }"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("aErr")]);
    });

    it("flags a counter that only appears in a comment", () => {
      const bad = build(swap("if (aErr) { log(1); substepErrors++; }", ["if (aErr) { log(1); /* substepErrors++ */ }"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("aErr")]);
    });

    it("flags a missing import", () => {
      expect(routeSubstepViolations(spec, build(goodLines.slice(1)))).toEqual([expect.stringContaining("does not import")]);
    });

    it("flags an import of something else from the wrapper module", () => {
      const lines = swap(goodLines[0]!, ['import { withCronOutcome } from "@/lib/ops/cron-route-outcome";']);
      expect(routeSubstepViolations(spec, build(lines))).toEqual([expect.stringContaining("does not import")]);
    });

    it("flags a missing declaration", () => {
      const bad = build(swap("let substepErrors = 0;", []));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("is not declared")]);
    });

    it("flags a body without the init", () => {
      const bad = build(swap(goodLines[goodLines.length - 1]!, ["return NextResponse.json({ ok: substepErrors === 0, substepErrors });"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("exactly 1")]);
    });

    it("flags a second init call when the route should have one", () => {
      const bad = build([...goodLines, "return NextResponse.json({}, substepErrorsInit(substepErrors));"]);
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("exactly 1")]);
    });

    it("flags an init call that only appears in a comment", () => {
      const bad = build(swap(goodLines[goodLines.length - 1]!, ["// return NextResponse.json({}, substepErrorsInit(substepErrors));", "return NextResponse.json({});"]));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("exactly 1")]);
    });

    it("flags a literal that occurs more often than allowed", () => {
      const bad = build(swap('run("only_once");', ['run("only_once");', 'run("only_once");']));
      expect(routeSubstepViolations(spec, bad)).toEqual([expect.stringContaining("exactly 1 time(s), found 2")]);
    });
  });
});
