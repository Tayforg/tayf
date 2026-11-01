import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

import { tickerDisclosureOr } from "@/lib/finance/disclosure-filter";

// ---------------------------------------------------------------------------
// Permanent guard (h11-finance-1): KAP tags a notice for a ticker in one of two
// columns, `stock_codes` (the issuer) and `related_stocks` (a share the notice
// names without being filed by it: trading halts, SPK bans, insider trades).
// 556 of 8,098 disclosures in 30 days carried ONLY related_stocks, and every
// per-ticker reader filtered `.contains("stock_codes", [ticker])`, so
// /ekonomi/TRHOL showed a stale price and not a word about the halt behind it.
//
// Two rules keep that from coming back:
//   1. No source file filters kap_disclosures with `.contains("stock_codes", ...)`.
//      Per-ticker readers call tickerDisclosureOr() (src/lib/finance/disclosure-filter.ts)
//      and pass its string to ONE `.or()`.
//   2. A kap_disclosures query chain has at most one `.or(`. The combined filter
//      is already `and(or(..),or(..))`; a second chained `.or()` would not AND
//      with the first the way a reader expects.
// ---------------------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(here, "../../src");
const SRC_EXT = /\.(ts|tsx)$/;
const TEST_FILE = /\.test\.(ts|tsx)$/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (SRC_EXT.test(entry) && !TEST_FILE.test(entry)) out.push(full);
  }
  return out;
}

/** Blanks // and block comments, keeping offsets (and newlines) intact. */
function blankComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/(^|[^:])\/\/[^\n]*/gm, (m, p1: string) => p1 + " ".repeat(m.length - p1.length));
}

/** Index just past the `)` that closes the `(` at `open`; skips quoted strings. Null when unbalanced. */
function closeParen(code: string, open: number): number | null {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      for (i++; i < code.length && code[i] !== ch; i++) if (code[i] === "\\") i++;
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")" && --depth === 0) return i + 1;
  }
  return null;
}

/**
 * The method chain that follows each `.from("kap_disclosures")`: every
 * `.name(...)` call directly after it, until the statement stops chaining.
 */
function kapChains(code: string): Array<{ offset: number; calls: string[] }> {
  const out: Array<{ offset: number; calls: string[] }> = [];
  for (const m of code.matchAll(/\.from\(\s*["'`]kap_disclosures["'`]\s*\)/g)) {
    const calls: string[] = [];
    let i = m.index! + m[0].length;
    for (;;) {
      const next = /^\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code.slice(i));
      if (!next) break;
      const open = i + next[0].length - 1;
      const end = closeParen(code, open);
      if (end === null) break;
      calls.push(next[1]!);
      i = end;
    }
    out.push({ offset: m.index!, calls });
  }
  return out;
}

const lineOf = (code: string, offset: number) => code.slice(0, offset).split("\n").length;

describe("kap_disclosures per-ticker filters (h11-finance-1)", () => {
  const files = walk(SRC);

  it("scans the source tree (sanity)", () => {
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(join("lib", "finance", "queries.ts")))).toBe(true);
  });

  it('no non-test file under src/ calls .contains("stock_codes", ...)', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const code = blankComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/\.contains\(\s*["'`]stock_codes["'`]/g)) {
        offenders.push(`${relative(SRC, file)}:${lineOf(code, m.index!)}`);
      }
    }
    expect(
      offenders,
      'stock_codes alone misses the notices KAP tags only in related_stocks; use tickerDisclosureOr() in ONE .or()',
    ).toEqual([]);
  });

  it('no non-test file filters stock_codes with a raw cs./cd. string outside disclosure-filter.ts', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(join("lib", "finance", "disclosure-filter.ts"))) continue;
      const code = blankComments(readFileSync(file, "utf8"));
      for (const m of code.matchAll(/stock_codes\.(?:cs|cd|ov)\./g)) {
        offenders.push(`${relative(SRC, file)}:${lineOf(code, m.index!)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every .from(\"kap_disclosures\") chain in src has at most one .or(", () => {
    const offenders: string[] = [];
    let chains = 0;
    for (const file of files) {
      const code = blankComments(readFileSync(file, "utf8"));
      for (const chain of kapChains(code)) {
        chains++;
        const ors = chain.calls.filter((c) => c === "or").length;
        if (ors > 1) offenders.push(`${relative(SRC, file)}:${lineOf(code, chain.offset)} has ${ors} .or( calls`);
      }
    }
    // The finance readers (queries.ts, kap-pickup-query.ts) and the admin signals reader.
    expect(chains).toBeGreaterThanOrEqual(6);
    expect(offenders).toEqual([]);
  });

  it("the finance readers build their per-ticker filter with tickerDisclosureOr", () => {
    for (const rel of [join("lib", "finance", "queries.ts"), join("lib", "finance", "kap-pickup-query.ts")]) {
      const code = blankComments(readFileSync(join(SRC, rel), "utf8"));
      expect(code, `${rel} must filter by ticker through tickerDisclosureOr`).toMatch(/\btickerDisclosureOr\(/);
    }
  });

  it("the ekonomi/[ticker] existence probe uses the same filter, not stock_codes alone", () => {
    const page = blankComments(readFileSync(join(SRC, "app", "ekonomi", "[ticker]", "page.tsx"), "utf8"));
    expect(page).toContain("tickerDisclosureOr(");
    expect(page).not.toMatch(/\.contains\(\s*["'`]stock_codes/);
  });

  describe("tickerDisclosureOr", () => {
    it("names both columns", () => {
      const f = tickerDisclosureOr("TRHOL");
      expect(f).toContain("stock_codes.cs.{TRHOL}");
      expect(f).toContain("related_stocks.cs.{TRHOL}");
    });

    it("is a single logic tree that also keeps the circuit-breaker exclusion", () => {
      const f = tickerDisclosureOr("THYAO");
      expect(f.startsWith("and(or(")).toBe(true);
      expect(f).toContain("subject.not.ilike.*Devre Kesici*");
      expect(f).toContain("subject.is.null");
    });
  });

  describe("the chain scanner itself (non-vacuous)", () => {
    it("counts the or() calls of a chain, across lines, and ignores strings holding '.or('", () => {
      const bad = `
        const r = await supabase
          .from("kap_disclosures")
          .select("a,b")
          .or("x.is.null")
          .contains("tags", ["a.or(b)"])
          .or(filter)
          .limit(3);
        const other = await supabase.from("articles").select("id").or("p").or("q");
      `;
      const chains = kapChains(blankComments(bad));
      expect(chains).toHaveLength(1);
      expect(chains[0]!.calls).toEqual(["select", "or", "contains", "or", "limit"]);
      expect(chains[0]!.calls.filter((c) => c === "or")).toHaveLength(2);
    });

    it("stops at the end of the statement", () => {
      const code = `const a = supabase.from("kap_disclosures").select("x").or("p");\nconst b = other.or("q");`;
      expect(kapChains(code)[0]!.calls).toEqual(["select", "or"]);
    });

    it("a comment that merely quotes the old filter is not a violation", () => {
      const code = blankComments('// was .contains("stock_codes", [t])\nconst ok = 1;');
      expect(code).not.toMatch(/\.contains\(\s*["'`]stock_codes/);
    });
  });
});
