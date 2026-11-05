import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard (h14-cluster-1): the cluster consumer's same-source
// duplicate SKIP needs strong evidence.
//
// #152 skipped any article that matched, at MATCH_THRESHOLD or better, a cluster
// that already held the article's source, whatever lane produced the score. A
// templated MinHash false match (cumhuriyet's film-plot description template, 0.85
// against a different film) dropped two articles that never reached any cluster.
// The skip is now recorded only when noteDupBlock is given evidence (an equal
// strict fingerprint, an equal folded headline, or the headline lane against a
// member of the same source), and every live skip is written to
// public.cluster_skip_log (migration 140) behind `!dryRun`.
//
// The behaviour is pinned by tests/functions/cluster-consumer.test.ts; this sweep
// pins the shape that must not come back: a score-only noteDupBlock call, a
// skip-log write that can run in a dry run, a skip-log failure that can fail the
// message.
//
// h45-clusters-1 adds a 4th kind, 'same-source-update' (a source's follow-up on its
// own story). The rule stays: noteDupBlock is never called with score-only
// evidence, and the new kind may come only from the pure, in-memory title
// predicate (isSameSourceUpdate, reached through sameSourceDupEvidence). Whether it
// skips or only logs is a code constant (SAME_SOURCE_UPDATE_ENFORCE), pinned below.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const CONSUMER = resolve(here, "../../supabase/functions/cluster-consumer/index.ts");

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Text between the opening bracket at `open` and its matching close (strings are skipped). */
function enclosed(src: string, open: number): string {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  let quote: string | null = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i] as string;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      quote = c;
      continue;
    }
    if (c in pairs) stack.push(pairs[c] as string);
    else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return src.slice(open + 1, i);
    }
  }
  throw new Error("unbalanced brackets");
}

/** Splits call arguments at the commas of depth 0 (a trailing comma adds no argument). */
function splitArgs(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < args.length; i++) {
    const c = args[i] as string;
    if (quote) {
      cur += c;
      if (c === "\\") cur += args[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    if (c === "(" || c === "[" || c === "{") depth++;
    if (c === ")" || c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim() !== "") out.push(cur.trim());
  return out;
}

/** Body (without the braces) of `function <name>(...) ... { ... }`. */
function functionBody(src: string, name: string): string {
  const start = src.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
  if (start === -1) throw new Error(`function ${name} not found`);
  const paramsOpen = src.indexOf("(", start);
  const paramsEnd = paramsOpen + enclosed(src, paramsOpen).length + 1;
  const bodyOpen = src.indexOf("{", paramsEnd + 1);
  return enclosed(src, bodyOpen);
}

const raw = readFileSync(CONSUMER, "utf8");
const src = blankComments(raw);

const callSites = (): Array<{ args: string[]; text: string }> => {
  const re = /\bnoteDupBlock\s*\(/g;
  const out: Array<{ args: string[]; text: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const open = m.index + m[0].length - 1;
    const text = enclosed(src, open);
    out.push({ args: splitArgs(text), text });
  }
  return out;
};

describe("cluster-consumer: the same-source skip needs strong evidence (h14-cluster-1)", () => {
  it("finds the five noteDupBlock call sites (the sweep is not vacuous)", () => {
    // fp fast path (dry run + live), Jev pendingJoin, fallback loop (dry run + live)
    expect(callSites()).toHaveLength(5);
  });

  it("every noteDupBlock( call passes three arguments", () => {
    for (const c of callSites()) {
      expect(c.args, c.text).toHaveLength(3);
    }
  });

  it("the third argument is `fingerprint` (the strict-fingerprint fast path) or a sameSourceDupEvidence(...) call, never a bare score or null", () => {
    for (const c of callSites()) {
      const third = c.args[2] ?? "";
      expect(third.startsWith("sameSourceDupEvidence(") || third === '"fingerprint"', c.text).toBe(true);
    }
    const fast = callSites().filter((c) => c.args[2] === '"fingerprint"');
    expect(fast).toHaveLength(2);
    for (const c of fast) expect(c.args[1]).toBe("1");
  });

  it("every sameSourceDupEvidence call passes the five arguments, probeHit last", () => {
    const re = /\bsameSourceDupEvidence\s*\(/g;
    let m: RegExpExecArray | null;
    let seen = 0;
    while ((m = re.exec(src)) !== null) {
      // the definition is `function sameSourceDupEvidence(`
      if (/function\s+$/.test(src.slice(0, m.index))) continue;
      const args = splitArgs(enclosed(src, m.index + m[0].length - 1));
      expect(args, args.join(", ")).toHaveLength(5);
      expect(args[4]).toMatch(/^probeSet\.has\(/);
      seen++;
    }
    expect(seen).toBe(3);
  });

  it("noteDupBlock returns early on null evidence, before it records anything, and keeps the MATCH_THRESHOLD rule", () => {
    const def = src.search(/const\s+noteDupBlock\s*=\s*\(/);
    expect(def).toBeGreaterThan(-1);
    const paramsOpen = src.indexOf("(", def);
    const params = splitArgs(enclosed(src, paramsOpen));
    expect(params).toHaveLength(3);
    expect(params[2]).toMatch(/^evidence\s*:\s*DupEvidence\s*\|\s*null$/);
    const body = enclosed(src, src.indexOf("{", paramsOpen + enclosed(src, paramsOpen).length));
    const guard = body.search(/if\s*\(\s*evidence\s*===\s*null\s*\)\s*return\s*;/);
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(body.search(/dupBlock\.clusterId\s*=/));
    expect(body).toMatch(/matchScore\s*>=\s*MATCH_THRESHOLD/);
    expect(body).toMatch(/dupBlock\.clusterId\s*===\s*null/);
  });

  it("the skip branch needs the recorded evidence", () => {
    expect(src).toMatch(/if\s*\(\s*dupBlock\.clusterId\s*!==\s*null\s*&&\s*dupBlock\.evidence\s*!==\s*null\s*\)/);
  });

  it("sameSourceDupEvidence is pure and in-memory: no client, no await, no I/O", () => {
    const body = functionBody(src, "sameSourceDupEvidence");
    expect(body).not.toMatch(/\bsupabase\b|\bawait\b|\bfetch\s*\(|\bDeno\./);
    // the same-source and token-count preconditions
    expect(body).toMatch(/if\s*\(\s*!article\.source_id\s*\)\s*return\s+null\s*;/);
    expect(body).toMatch(/TITLE_PROBE_MIN_TOKENS/);
    expect(body).toMatch(/headlineLane\(/);
  });
});

describe("cluster-consumer: cluster_skip_log is written only behind !dryRun, best-effort (migration 140)", () => {
  it("the table is touched in exactly one place, recordSkip", () => {
    const hits = [...src.matchAll(/cluster_skip_log/g)];
    // the one `.from("cluster_skip_log")` plus the warning text of warnSkipLogOnce
    const fromCalls = [...src.matchAll(/\.from\(\s*["']cluster_skip_log["']\s*\)/g)];
    expect(fromCalls).toHaveLength(1);
    const body = functionBody(src, "recordSkip");
    expect(body).toMatch(/\.from\(\s*["']cluster_skip_log["']\s*\)/);
    expect(hits.length).toBeGreaterThanOrEqual(2);
  });

  it("every recordSkip( call sits behind `if (!dryRun)` on the same statement", () => {
    const calls = [...src.matchAll(/\brecordSkip\s*\(/g)].filter(
      (m) => !/function\s+$/.test(src.slice(0, m.index)),
    );
    expect(calls).toHaveLength(1);
    for (const m of calls) {
      const lineStart = src.lastIndexOf("\n", m.index) + 1;
      const before = src.slice(lineStart, m.index);
      expect(before, "recordSkip must be guarded by !dryRun").toMatch(/if\s*\(\s*!dryRun\s*\)\s*await\s+$/);
    }
  });

  it("recordSkip upserts on article_id ignoring duplicates, with the reason `same-source-duplicate/<evidence>`", () => {
    const body = functionBody(src, "recordSkip");
    expect(body).toMatch(/\.upsert\(/);
    expect(body).toMatch(/onConflict\s*:\s*["']article_id["']/);
    expect(body).toMatch(/ignoreDuplicates\s*:\s*true/);
    expect(body).toMatch(/reason\s*:\s*`same-source-duplicate\/\$\{block\.evidence\}`/);
    for (const col of ["article_id", "cluster_id", "score", "reason"]) {
      expect(body, col).toMatch(new RegExp(`\\b${col}\\s*:`));
    }
  });

  it("a failed write is caught (error envelope and throw) and never rethrown", () => {
    const body = functionBody(src, "recordSkip");
    expect(body).toMatch(/\btry\s*\{/);
    expect(body).toMatch(/\bcatch\s*\(/);
    expect(body).toMatch(/if\s*\(\s*res\.error\s*\)\s*warnSkipLogOnce\(/);
    expect(body).not.toMatch(/\bthrow\b/);
  });

  it("the warning is once per isolate", () => {
    const body = functionBody(src, "warnSkipLogOnce");
    expect(body).toMatch(/if\s*\(\s*skipLogWarned\s*\)\s*return\s*;/);
    expect(body).toMatch(/skipLogWarned\s*=\s*true/);
    expect(body).toMatch(/console\.warn\(/);
  });
});

describe("cluster-consumer: the same-source-update kind comes only from the pure title predicate (h45-clusters-1)", () => {
  const PURE = /\bsupabase\b|\bawait\b|\bfetch\s*\(|\bDeno\.|\bconsole\./;

  it("DupEvidence lists exactly the four kinds, the new one last (the weakest)", () => {
    const m = src.match(/type\s+DupEvidence\s*=\s*([^;]+);/);
    expect(m).not.toBeNull();
    const kinds = [...(m?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((x) => x[1]);
    expect(kinds).toEqual(["fingerprint", "exact-title", "headline-lane", "same-source-update"]);
  });

  it('the literal "same-source-update" is returned in exactly one place: sameSourceDupEvidence', () => {
    const returns = [...src.matchAll(/return\s+"same-source-update"/g)];
    expect(returns).toHaveLength(1);
    expect(functionBody(src, "sameSourceDupEvidence")).toMatch(/return\s+"same-source-update"/);
    // and it is returned only when no other kind was found
    expect(functionBody(src, "sameSourceDupEvidence")).toMatch(/evidence\s*===\s*null\s*&&\s*sameSourceUpdateMember\(/);
  });

  it("no noteDupBlock call site passes the new kind (or any literal but `fingerprint`) itself", () => {
    for (const c of callSites()) {
      expect(c.args[2] ?? "", c.text).not.toMatch(/same-source-update/);
    }
  });

  it("the predicate and everything it calls are pure and in-memory: no client, no await, no fetch, no Deno, no logging", () => {
    for (const name of ["isSameSourceUpdate", "namedSubjectTokens", "sameSourceMembers", "sameSourceUpdateMember"]) {
      expect(functionBody(src, name), name).not.toMatch(PURE);
    }
  });

  it("isSameSourceUpdate keeps all its conditions: window, shared stems, named subject, both vetoes", () => {
    const body = functionBody(src, "isSameSourceUpdate");
    expect(body).toMatch(/Number\.isFinite\(a\.ms\)\s*\|\|\s*!Number\.isFinite\(b\.ms\)/);
    expect(body).toMatch(/SAME_SOURCE_UPDATE_MAX_HOURS/);
    expect(body).toMatch(/SAME_SOURCE_UPDATE_MIN_SHARED/);
    expect(body).toMatch(/\.numbers\.has\(/); // a shared numeral is no stem
    expect(body).toMatch(/namedSubjectTokens\(/);
    expect(body).toMatch(/subjectVetoFires\(/);
    expect(body).toMatch(/incidentVetoFires\(/);
  });

  it("noteDupBlock: without enforcement the new kind never reaches dupBlock (it only fills the shadow holder), with it the kind is the weakest", () => {
    const def = src.search(/const\s+noteDupBlock\s*=\s*\(/);
    const paramsOpen = src.indexOf("(", def);
    const body = enclosed(src, src.indexOf("{", paramsOpen + enclosed(src, paramsOpen).length));
    const shadow = body.search(/evidence\s*===\s*"same-source-update"\s*&&\s*!SAME_SOURCE_UPDATE_ENFORCE/);
    expect(shadow).toBeGreaterThan(-1);
    // the shadow branch returns before the first dupBlock write
    const ret = body.indexOf("return;", shadow);
    expect(ret).toBeGreaterThan(shadow);
    expect(ret).toBeLessThan(body.search(/dupBlock\.clusterId\s*=\s*clusterId/));
    // the weakest kind: any other kind replaces a held 'same-source-update'
    expect(body).toMatch(/dupBlock\.evidence\s*===\s*"same-source-update"\s*&&\s*evidence\s*!==\s*"same-source-update"/);
  });

  it("the shadow hit is logged and counted once, in takeSameSourceSkip, live drains only", () => {
    const def = src.search(/const\s+takeSameSourceSkip\s*=/);
    const paramsOpen = src.indexOf("(", def);
    const body = enclosed(src, src.indexOf("{", src.indexOf("=>", paramsOpen)));
    expect(body).toMatch(/updateShadow\.clusterId\s*!==\s*null\s*&&\s*!updateShadow\.reported/);
    expect(body).toMatch(/updateShadow\.reported\s*=\s*true/);
    expect(body).toMatch(/\[cluster-consumer\] same-source-update shadow article=\$\{article\.id\} cluster=\$\{updateShadow\.clusterId\} member=/);
    expect(body).toMatch(/if\s*\(\s*!dryRun\s*\)\s*sameSourceUpdateShadow\s*\+=\s*1/);
    // the counter is per drain: reset in drainQueue, copied into the summary
    expect(functionBody(src, "drainQueue")).toMatch(/sameSourceUpdateShadow\s*=\s*0\s*;/);
    expect(src).toMatch(/summary\.sameSourceUpdateShadow\s*=\s*sameSourceUpdateShadow\s*;/);
  });

  it("SAME_SOURCE_UPDATE_ENFORCE is a code constant from constants.ts, never an env var (turning it on is a PR)", () => {
    expect(raw).toMatch(/SAME_SOURCE_UPDATE_ENFORCE,\s*\n/); // in the constants import list
    expect(src).not.toMatch(/Deno\.env\.get\([^)]*SAME_SOURCE/);
    expect(src).not.toMatch(/SAME_SOURCE_UPDATE_ENFORCE\s*=[^=]/);
  });
});

describe("cluster constants: the same-source-update tunables are mirrored and pinned (h45-clusters-1)", () => {
  it("SAME_SOURCE_UPDATE_MAX_HOURS = 6, SAME_SOURCE_UPDATE_MIN_SHARED = 2, identical in constants.ts and constants.mjs", async () => {
    const ts = await import("../../supabase/functions/_shared/cluster/constants.ts");
    const mjs = await import("../../scripts/lib/cluster/constants.mjs");
    expect(mjs.SAME_SOURCE_UPDATE_MAX_HOURS).toBe(ts.SAME_SOURCE_UPDATE_MAX_HOURS);
    expect(mjs.SAME_SOURCE_UPDATE_MIN_SHARED).toBe(ts.SAME_SOURCE_UPDATE_MIN_SHARED);
    expect(mjs.SAME_SOURCE_UPDATE_ENFORCE).toBe(ts.SAME_SOURCE_UPDATE_ENFORCE);
    // pinned, so "both undefined" can never pass as parity
    expect(ts.SAME_SOURCE_UPDATE_MAX_HOURS).toBe(6);
    expect(ts.SAME_SOURCE_UPDATE_MIN_SHARED).toBe(2);
    // the window is the headline lane's
    expect(ts.SAME_SOURCE_UPDATE_MAX_HOURS).toBe(ts.HEADLINE_LANE_MAX_HOURS);
    expect(typeof ts.SAME_SOURCE_UPDATE_ENFORCE).toBe("boolean");
  });

  it("SAME_SOURCE_UPDATE_ENFORCE ships OFF (shadow): the 48 h replay's hand-checked precision was 28.7% (29 of 101 hits), see the h45 PR; flip it in a PR once shadow data reaches 90%", async () => {
    const ts = await import("../../supabase/functions/_shared/cluster/constants.ts");
    expect(ts.SAME_SOURCE_UPDATE_ENFORCE).toBe(false);
    const decl = readFileSync(resolve(here, "../../supabase/functions/_shared/cluster/constants.ts"), "utf8");
    expect(decl).toMatch(/export const SAME_SOURCE_UPDATE_ENFORCE:\s*boolean\s*=\s*(true|false)\s*;/);
    const mirror = readFileSync(resolve(here, "../../scripts/lib/cluster/constants.mjs"), "utf8");
    expect(mirror).toMatch(/export const SAME_SOURCE_UPDATE_ENFORCE\s*=\s*(true|false)\s*;/);
  });
});
