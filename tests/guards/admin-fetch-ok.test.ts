import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve, dirname, join, relative } from "node:path";

// ---------------------------------------------------------------------------
// Permanent CI guard: every fetch in an admin client component must look at
// the response status. `await fetch(...); const data = await res.json()` is the
// shape that crashed /admin on an HTML 502 (res.json() rejects) and silently
// rendered zeros on a 401 (the error body was stored as if it were data).
//
// Per file, with comments stripped, every raw `fetch(` (and `fetchImpl(`, the
// injectable fetch inside loadAdminJson) must be BOUND to a response variable
// (`const res = await fetch(`, `res = await fetch(`, or `fetch(...).then(res =>`)
// and that same variable's `.ok` must be read between this fetch and the next
// fetch bound to the same name (or the end of the file).
//
// Deliberately NOT a global count of `.ok`: a file that also calls
// `loadAdminJson` reads `result.ok` on its outcome, and a global tally let that
// read pay for an unchecked raw fetch. `loadAdminJson`
// (src/components/admin/load-admin-json.ts) checks its own response with
// `res.ok`; that file is scanned like any other, and a delegating call site has
// no raw `fetch(` left to check. Limit: the read is textual (an `if (!res.ok)`
// whose branch does nothing still passes); behaviour is covered by the
// component tests.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_DIR = resolve(here, "../../src/components/admin");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Drop block comments and `//` comments (a `//` right after `:` is a URL). */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\"'`])\/\/.*$/gm, "$1");
}

/** A raw call to fetch (or to loadAdminJson's injectable `fetchImpl`). */
const FETCH_CALL = /(?<![\w$])(?:fetch|fetchImpl)\s*\(/g;

interface FetchSite {
  /** Index of the call in the comment-stripped source. */
  index: number;
  /** The variable the response is bound to, or null when it is not bound to one. */
  name: string | null;
}

/** Index of the `)` that closes the `(` at `open`, skipping quoted text; -1 if unbalanced. */
function closingParen(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < code.length && code[i] !== ch) {
        if (code[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i;
  }
  return -1;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Every fetch call with the variable its Response lands in:
 *   fetch(...).then((res) => ...)        -> res   (checked first: the chain's callback sees the Response)
 *   const res = await fetch(...)         -> res   (a `: Response` annotation and plain `res = await` count too)
 * anything else (`return fetch(...)`, a bare `await fetch(...)`) has no name.
 */
function findFetches(code: string): FetchSite[] {
  const sites: FetchSite[] = [];
  for (const m of code.matchAll(FETCH_CALL)) {
    const index = m.index as number;
    const open = index + m[0].length - 1;
    const close = closingParen(code, open);
    const after = close === -1 ? "" : code.slice(close + 1, close + 200);
    const thenMatch = /^\s*\.then\s*\(\s*(?:async\s*)?\(?\s*([A-Za-z_$][\w$]*)/.exec(after);
    if (thenMatch?.[1]) {
      sites.push({ index, name: thenMatch[1] });
      continue;
    }
    const before = code.slice(Math.max(0, index - 120), index);
    const bound = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*(?::\s*[\w$.<>[\]| ]+?)?\s*=\s*await\s+$/.exec(before);
    sites.push({ index, name: bound?.[1] ?? null });
  }
  return sites;
}

/** One line per fetch whose Response status is never read; empty when every fetch is checked. */
function unchecked(source: string): string[] {
  const code = stripComments(source);
  const sites = findFetches(code);
  const problems: string[] = [];
  sites.forEach((site, i) => {
    const line = code.slice(0, site.index).split("\n").length;
    if (site.name === null) {
      problems.push(`line ${line}: fetch( whose response is not bound to a variable`);
      return;
    }
    // The read must sit between this fetch and the next fetch bound to the same name.
    const next = sites.slice(i + 1).find((s) => s.name === site.name);
    const segment = code.slice(site.index, next ? next.index : code.length);
    const okRead = new RegExp(`(?<![\\w$.])${escapeRegExp(site.name)}\\s*\\??\\.\\s*ok\\b`);
    if (!okRead.test(segment)) {
      problems.push(`line ${line}: fetch( bound to \`${site.name}\` with no \`${site.name}.ok\` read after it`);
    }
  });
  return problems;
}

const uncheckedFetches = (source: string): boolean => unchecked(source).length > 0;

describe("admin client components check res.ok on every fetch", () => {
  const files = walk(ADMIN_DIR);

  it("scans a non-trivial set of files (the guard is not vacuous)", () => {
    expect(files.length).toBeGreaterThanOrEqual(15);
    const withFetch = files.filter(
      (f) => findFetches(stripComments(readFileSync(f, "utf8"))).length > 0,
    );
    expect(withFetch.length).toBeGreaterThanOrEqual(10);
  });

  it("scans loadAdminJson's own fetch (it is the one place the status check is written)", () => {
    const helper = files.find((f) => f.endsWith("load-admin-json.ts"));
    expect(helper).toBeDefined();
    const sites = findFetches(stripComments(readFileSync(helper as string, "utf8")));
    expect(sites.map((s) => s.name)).toEqual(["res"]);
  });

  it("has no fetch( whose own Response is left unchecked", () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const problem of unchecked(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(ADMIN_DIR, file)}: ${problem}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  describe("self-test", () => {
    it("flags a fetch whose response status is never read", () => {
      const snippet = `
        async function run() {
          const res = await fetch("/api/admin", { method: "POST" });
          const data = await res.json();
          setResult(data);
        }`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });

    it("accepts a fetch followed by a res.ok check", () => {
      const snippet = `
        async function run() {
          const res = await fetch("/api/admin", { method: "POST" });
          if (!res.ok) return;
          setResult(await res.json());
        }`;
      expect(uncheckedFetches(snippet)).toBe(false);
    });

    it("flags two fetches covered by a single .ok check", () => {
      const snippet = `
        const a = await fetch("/a");
        const b = await fetch("/b");
        if (!a.ok) return;`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });

    it("does not count .ok or fetch( that only appear in comments", () => {
      const snippet = `
        // TODO: check res.ok here
        /* res.ok */
        const res = await fetch("/api/admin");
        setResult(await res.json());`;
      expect(uncheckedFetches(snippet)).toBe(true);
      expect(uncheckedFetches(`// fetch("/x") is documented here\nconst a = 1;`)).toBe(false);
    });

    it("keeps a URL's // from swallowing the rest of the line", () => {
      const snippet = `const res = await fetch("https://example.com/x"); if (!res.ok) return;`;
      expect(uncheckedFetches(snippet)).toBe(false);
    });

    it("accepts delegation to loadAdminJson", () => {
      const snippet = `
        const result = await loadAdminJson<Stats>("/api/admin", isStats);
        if (!result.ok) return;`;
      expect(uncheckedFetches(snippet)).toBe(false);
    });

    it("does not let one loadAdminJson call excuse several raw fetches", () => {
      const snippet = `
        await loadAdminJson("/api/admin", isStats);
        await fetch("/a");
        await fetch("/b");`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });

    it("does not let `result.ok` of a loadAdminJson call excuse a raw fetch (the hunt-8 shape)", () => {
      const snippet = `
        const result = await loadAdminJson("/a", isX);
        if (!result.ok) return;
        const r = await fetch("/b");
        setX(await r.json());`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });

    it.each(["worker-stats.tsx", "admin-panel.tsx"])(
      "flags an unchecked fetch appended to the real %s (which also reads result.ok)",
      (name) => {
        const real = readFileSync(join(ADMIN_DIR, name), "utf8");
        expect(uncheckedFetches(real)).toBe(false);
        const leak = `\nasync function leak() { const r = await fetch("/api/admin/x"); return r.json(); }\n`;
        expect(uncheckedFetches(real + leak)).toBe(true);
      },
    );

    it("needs a `.ok` read on the same variable the fetch was bound to", () => {
      const snippet = `
        const a = await fetch("/a");
        const b = await fetch("/b");
        if (!a.ok) return;
        if (!a.ok) return;`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });

    it("needs the `.ok` read after the fetch, not an unrelated earlier read of the same name", () => {
      const snippet = `
        async function one() { const res = await fetch("/a"); if (!res.ok) return; }
        async function two() { const res = await fetch("/b"); return res.json(); }`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });

    it("accepts the same variable name checked after each of two fetches", () => {
      const snippet = `
        async function one() { const res = await fetch("/a"); if (!res.ok) return; }
        async function two() { const res = await fetch("/b"); if (!res.ok) return; }`;
      expect(uncheckedFetches(snippet)).toBe(false);
    });

    it("flags a fetch whose response is not bound to a name", () => {
      expect(uncheckedFetches(`async function f() { return fetch("/a"); }`)).toBe(true);
      expect(uncheckedFetches(`async function f() { await fetch("/a"); }`)).toBe(true);
    });

    it("follows a `.then(res => ...)` callback: flagged without a res.ok read, accepted with one", () => {
      expect(uncheckedFetches(`fetch("/a").then((r) => r.json()).then(setX);`)).toBe(true);
      expect(
        uncheckedFetches(
          `fetch("/a").then((r) => { if (!r.ok) throw new Error("x"); return r.json(); }).then(setX);`,
        ),
      ).toBe(false);
    });

    it("accepts a typed or reassigned binding and optional chaining", () => {
      expect(uncheckedFetches(`const res: Response = await fetch("/a"); if (!res.ok) return;`)).toBe(false);
      expect(uncheckedFetches(`let res: Response; res = await fetch("/a"); if (!res?.ok) return;`)).toBe(false);
    });

    it("still scans the loadAdminJson helper itself (fetchImpl is its fetch)", () => {
      const snippet = `
        export async function loadAdminJson(url) {
          const res = await fetchImpl(url);
          return res.json();
        }`;
      expect(uncheckedFetches(snippet)).toBe(true);
    });
  });
});
