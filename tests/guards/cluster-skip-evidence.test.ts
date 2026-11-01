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
