import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: no API route or Edge Function may pass a subscriber
// e-mail address (or anything named `email` / `to`) to console.*. This is
// what sent digest.ts:209 to prod (row.email in a console.error) — see
// tests/api/cron/digest.test.ts for the route-level regression test. This
// file is the repo-wide sweep so the same mistake can't land anywhere else
// under src/app/api or supabase/functions.
// ---------------------------------------------------------------------------

interface Violation {
  file: string;
  line: number;
  snippet: string;
}

/**
 * Strips comments and string-literal contents from `src`, returning a
 * SAME-LENGTH string (newlines preserved at their original offsets) so that
 * callers can keep computing line numbers against the original source.
 *
 * - `//` line comments and `/* *\/` block comments are blanked.
 * - Single/double-quoted string contents are blanked.
 * - Template literals keep ONLY the contents of `${...}` interpolations;
 *   the literal text around them (and the backticks/`${`/`}` markers) is
 *   blanked. Interpolations are scanned as code, so nested strings,
 *   comments, and template literals inside an interpolation are handled
 *   recursively by the same state machine.
 */
function stripNonCode(src: string): string {
  const out = src.split("");
  const n = src.length;

  function blank(idx: number): void {
    if (out[idx] !== "\n") out[idx] = " ";
  }

  type Frame = { type: "code"; templateExpr: boolean; depth: number } | { type: "template" };
  const stack: Frame[] = [{ type: "code", templateExpr: false, depth: 0 }];

  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1]!;
    const c = src[i]!;

    if (top.type === "code") {
      if (c === "/" && src[i + 1] === "/") {
        let j = i;
        while (j < n && src[j] !== "\n") {
          blank(j);
          j++;
        }
        i = j;
        continue;
      }
      if (c === "/" && src[i + 1] === "*") {
        let j = i;
        blank(j);
        blank(j + 1);
        j += 2;
        while (j < n && !(src[j] === "*" && src[j + 1] === "/")) {
          blank(j);
          j++;
        }
        if (j < n) {
          blank(j);
          blank(j + 1);
          j += 2;
        }
        i = j;
        continue;
      }
      if (c === "'" || c === '"') {
        const quote = c;
        let j = i;
        blank(j);
        j++;
        while (j < n && src[j] !== quote) {
          if (src[j] === "\\") {
            blank(j);
            j++;
            if (j < n) {
              blank(j);
              j++;
            }
            continue;
          }
          blank(j);
          j++;
        }
        if (j < n) {
          blank(j);
          j++;
        }
        i = j;
        continue;
      }
      if (c === "`") {
        blank(i);
        i++;
        stack.push({ type: "template" });
        continue;
      }
      if (c === "{" && top.templateExpr) {
        top.depth++;
        i++;
        continue;
      }
      if (c === "}" && top.templateExpr) {
        if (top.depth > 0) {
          top.depth--;
          i++;
          continue;
        }
        blank(i);
        stack.pop();
        i++;
        continue;
      }
      i++;
      continue;
    }

    // top.type === "template": literal text between backticks.
    if (c === "\\") {
      blank(i);
      i++;
      if (i < n) {
        blank(i);
        i++;
      }
      continue;
    }
    if (c === "`") {
      blank(i);
      i++;
      stack.pop();
      continue;
    }
    if (c === "$" && src[i + 1] === "{") {
      blank(i);
      blank(i + 1);
      i += 2;
      stack.push({ type: "code", templateExpr: true, depth: 0 });
      continue;
    }
    blank(i);
    i++;
  }

  return out.join("");
}

const VIOLATION_RE_1 = /(^|[^A-Za-z0-9_$.])(email|to)\b/;
const VIOLATION_RE_2 = /\.\s*(email|to)\b/;

function countLine(stripped: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) {
    if (stripped[i] === "\n") line++;
  }
  return line;
}

/**
 * Scans `src` (the source of `file`) for `console.<method>(...)` calls whose
 * argument text references an identifier named `email` or `to` (bare, as a
 * property key, or via dotted access like `row.email`) and returns one
 * violation per offending call.
 */
function scanSource(file: string, src: string): Violation[] {
  const stripped = stripNonCode(src);
  const violations: Violation[] = [];
  const consoleRe = /console\s*\.\s*[A-Za-z_$][A-Za-z0-9_$]*\s*\(/g;

  let match: RegExpExecArray | null;
  while ((match = consoleRe.exec(stripped))) {
    const openParenIdx = match.index + match[0].length - 1;

    // Balanced-paren scan for the call's argument text. Spans newlines —
    // multi-line console calls (e.g. console.error("x", JSON.stringify({
    // ... }))) are common in this codebase (see
    // supabase/functions/image-consumer/index.ts).
    let depth = 1;
    let j = openParenIdx + 1;
    while (j < stripped.length && depth > 0) {
      const c = stripped[j];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    const argsEnd = depth === 0 ? j - 1 : stripped.length;
    const argText = stripped.slice(openParenIdx + 1, argsEnd);

    if (VIOLATION_RE_1.test(argText) || VIOLATION_RE_2.test(argText)) {
      const line = countLine(stripped, match.index);
      const lineText = src.split("\n")[line - 1] ?? "";
      violations.push({ file, line, snippet: lineText.trim() });
    }
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Scanner unit tests — these are what prove the guard can actually fail.
// ---------------------------------------------------------------------------

describe("scanSource", () => {
  const F = "fixture.ts";

  it('flags console.error("send failed", row.email, e)', () => {
    expect(scanSource(F, `console.error("send failed", row.email, e);`)).toHaveLength(1);
  });

  it("flags a template-literal interpolation referencing .email", () => {
    expect(scanSource(F, "console.log(`sent to ${sub.email}`);")).toHaveLength(1);
  });

  it('flags console.error("[digest]", { to: row.email })', () => {
    expect(scanSource(F, `console.error("[digest]", { to: row.email });`)).toHaveLength(1);
  });

  it("flags a bare `email` identifier argument", () => {
    expect(scanSource(F, `console.warn("failed", email);`)).toHaveLength(1);
  });

  it('does not flag console.error("send failed", row.id, e)', () => {
    expect(scanSource(F, `console.error("send failed", row.id, e);`)).toEqual([]);
  });

  it('does not flag the word "to" inside a plain string', () => {
    expect(scanSource(F, `console.log("mail sent to reader");`)).toEqual([]);
  });

  it("does not flag .toISOString()/.toString() method calls", () => {
    expect(scanSource(F, `console.log(d.toISOString(), x.toString());`)).toEqual([]);
  });

  it("does not flag a commented-out violation", () => {
    expect(scanSource(F, `// console.error("x", row.email)`)).toEqual([]);
  });

  it("does not flag emailCount (word-boundary, not a prefix match)", () => {
    expect(scanSource(F, `console.log("emails:", emailCount);`)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Repo-wide sweep.
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const SCAN_DIRS = ["src/app/api", "supabase/functions"];

function listSourceFiles(): string[] {
  const files: string[] = [];
  for (const rel of SCAN_DIRS) {
    const dir = join(REPO_ROOT, rel);
    const entries = readdirSync(dir, { recursive: true }) as string[];
    for (const entry of entries) {
      if (!/\.(ts|tsx)$/.test(entry)) continue;
      if (entry.includes(".test.")) continue;
      files.push(join(dir, entry));
    }
  }
  return files;
}

describe("no-pii-logging guard", () => {
  it("scans a non-trivial number of files (a silently-empty glob must fail, not pass)", () => {
    const files = listSourceFiles();
    expect(files.length).toBeGreaterThan(20);
  });

  it("finds no console.* call that logs an email/to identifier under src/app/api or supabase/functions", () => {
    const files = listSourceFiles();
    const violations = files.flatMap((file) => {
      const src = readFileSync(file, "utf8");
      return scanSource(file, src);
    });

    const message = violations
      .map((v) => `${v.file}:${v.line} — ${v.snippet}`)
      .join("\n");

    expect(violations, message ? `PII-logging violations found:\n${message}` : undefined).toEqual(
      [],
    );
  });
});
